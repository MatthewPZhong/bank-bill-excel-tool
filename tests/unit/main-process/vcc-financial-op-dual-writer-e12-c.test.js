'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  REQUIRED_DATASET_TYPES
} = require('../../../src/backend/vcc-financial-op/calculator');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../src/backend/vcc-financial-op/definitions');
const {
  canonicalSha256
} = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  toProtocolError
} = require('../../../src/main-process/background-execution/error-codec');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  readVccExportSnapshot
} = require('../../../src/main-process/vcc-financial-op-output/authority');
const {
  createGenerationInput,
  generateValidateAndPublishVccExport
} = require('../../../src/main-process/vcc-financial-op-output/dispatch');
const {
  pendingSheetProjection
} = require('../../../src/main-process/vcc-financial-op-output/artifact-evidence');
const {
  VCC_EXPORT_SUBJECTS_ACTION,
  validateVccExportSubjectsResult
} = require('../../../src/main-process/vcc-financial-op-output/policies');
const {
  planVccExportShards
} = require('../../../src/main-process/vcc-financial-op-output/shard-planner');
const {
  createVccExportTopologyPlanner
} = require('../../../src/main-process/vcc-financial-op-output/topology');
const {
  executeVccExportWriter
} = require('../../../src/main-process/vcc-financial-op-output/writer-core');
const {
  executeVccExportWriterGraph,
  mergeVccExportShardResults,
  runVccExportShardWorker
} = require('../../../src/main-process/vcc-financial-op-output/writer-coordinator');

const ASSETS_DIR = path.resolve(__dirname, '../../../assets');

function seedArchivedRun(db, subjects) {
  const targetMonth = '2026-06';
  const archivedAt = '2026-08-01 09:00:00';
  const revisions = Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]));
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, input_fingerprint,
      created_at, updated_at, archived_at
    ) VALUES (?, 'archived', ?, ?, '2026-08-01 08:00:00', ?, ?)
  `).run(targetMonth, JSON.stringify(revisions), 'a'.repeat(64), archivedAt, archivedAt).lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, '0')
  `);
  for (const subject of subjects) {
    insertRow.run(
      runId, subject, 'movement', SOURCE_TYPES.RECHARGE,
      'VCC_discharge', 'B2B', 'USD', '10'
    );
    insertRow.run(
      runId, subject, 'pending', SOURCE_TYPES.PENDING,
      '当月移除pending', '', 'EUR', '3'
    );
    const archivedBalances = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      const periodAmount = currency === 'USD' ? '10' : (currency === 'EUR' ? '3' : '0');
      const calculatedBalance = currency === 'USD' ? '110' : (currency === 'EUR' ? '103' : '100');
      insertBalance.run(
        runId, subject, currency, periodAmount, calculatedBalance, calculatedBalance
      );
      archivedBalances[currency] = calculatedBalance;
    }
    db.prepare(`
      INSERT INTO vcc_fin_op_pending_summary_rows (
        run_id, subject, channel_name, currency_mismatch,
        flow_currency, pending_currency, recon_type, flow_amount, pending_amount
      ) VALUES (?, ?, 'CITI', 1, 'USD', 'EUR', 'VCC_clearing_credit', '10', '3')
    `).run(runId, subject);
    db.prepare(`
      INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
      VALUES (?, ?, 'EUR', '3')
    `).run(runId, subject);
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (
        target_month, subject, balances_json, run_id, archived_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(targetMonth, subject, JSON.stringify(archivedBalances), runId, archivedAt);
  }
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, 1, '2026-08-01 08:00:00', ?)
  `);
  for (const datasetType of REQUIRED_DATASET_TYPES) {
    insertDataset.run(targetMonth, datasetType, runId, archivedAt);
  }
  return { runId, targetMonth };
}

function setup(t, subjects = ['AA', 'BB', 'CC', 'DD']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-c-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const run = seedArchivedRun(db, subjects);
  const snapshot = readVccExportSnapshot(db, run);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath, db, run, snapshot };
}

function filePlan(root, directoryName, count) {
  const outputRoot = path.join(root, directoryName);
  fs.mkdirSync(outputRoot);
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: Array.from({ length: count }, (_unused, index) => ({
      filePath: path.join(outputRoot, `${index}.xlsx`),
      role: 'output',
      sourceOperation: 'vccFinancialOp:export:result'
    }))
  });
}

function generationFixture(harness, suffix) {
  const stagingDirectory = path.join(harness.root, `staging-${suffix}`);
  fs.mkdirSync(stagingDirectory);
  const task = Object.freeze({
    action: 'export-result',
    taskGeneration: 11,
    taskRunId: `vcc-e12-c-task-${suffix}`
  });
  const indexes = harness.snapshot.authority.subjects.map((_subject, index) => index);
  const generation = createGenerationInput({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    authority: harness.snapshot.authority,
    filePlan: filePlan(harness.root, `targets-${suffix}`, indexes.length),
    operationKey: `vcc-e12-c-operation-${suffix}`,
    selectedSubjectIndexes: indexes,
    stagingDirectory,
    taskAuthority: task
  });
  return {
    generation,
    input: Object.freeze({
      contractVersion: generation.contractVersion,
      databasePath: harness.dbPath,
      assetsDir: ASSETS_DIR,
      authority: generation.authority,
      task: generation.task,
      generations: generation.generations,
      stagingIdentity: generation.stagingIdentity
    })
  };
}

function resultSheetProjection(sheet) {
  const rows = [];
  for (let row = 1; row <= sheet.actualRowCount; row += 1) {
    rows.push({
      height: sheet.getRow(row).height == null ? null : sheet.getRow(row).height,
      cells: Array.from({ length: sheet.actualColumnCount }, (_unused, column) => {
        const cell = sheet.getCell(row, column + 1);
        return { value: cell.value == null ? null : cell.value, style: cell.style };
      })
    });
  }
  return {
    rows,
    columns: Array.from({ length: sheet.actualColumnCount }, (_unused, index) => ({
      width: sheet.getColumn(index + 1).width,
      hidden: Boolean(sheet.getColumn(index + 1).hidden)
    })),
    merges: Object.values(sheet._merges).map((merge) => merge.range).sort(),
    views: sheet.views,
    pageSetup: sheet.pageSetup,
    autoFilter: sheet.autoFilter
  };
}

async function workbookSemanticDigest(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return canonicalSha256(JSON.parse(JSON.stringify({
    result: resultSheetProjection(workbook.worksheets[0]),
    pending: pendingSheetProjection(workbook.worksheets[1]),
    definedNames: workbook.definedNames.model
  })));
}

function dummyGenerations(count) {
  return Array.from({ length: count }, (_unused, subjectIndex) => Object.freeze({
    subjectIndex,
    outputArtifactKey: `output-${String(subjectIndex + 1).padStart(64, '0')}`,
    generationPath: `/tmp/vcc-e12-c-${subjectIndex}.xlsx`
  }));
}

function dummyMergeFixture(count = 4) {
  const generations = dummyGenerations(count);
  const subjects = generations.map(({ subjectIndex }) => ({
    subjectIndex,
    subjectDigest: String(subjectIndex + 1).padStart(64, 'a'),
    businessDigest: String(subjectIndex + 1).padStart(64, 'b'),
    resultRowCount: 2,
    pendingRowCount: 2
  }));
  const authority = {
    runId: 1,
    targetMonth: '2026-06',
    resultRevision: 1,
    inputFingerprint: 'c'.repeat(64),
    archiveStateDigest: 'd'.repeat(64),
    authorityDigest: 'e'.repeat(64),
    subjects
  };
  const input = {
    authority,
    task: { action: 'export-result', taskGeneration: 1, taskRunId: 'task' },
    generations
  };
  const shards = planVccExportShards(generations, 2);
  const results = shards.map((shard) => ({
    contractVersion: 1,
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    runId: authority.runId,
    targetMonth: authority.targetMonth,
    resultRevision: authority.resultRevision,
    inputFingerprint: authority.inputFingerprint,
    archiveStateDigest: authority.archiveStateDigest,
    authorityDigest: authority.authorityDigest,
    task: input.task,
    shard: {
      contractVersion: shard.contractVersion,
      shardIndex: shard.shardIndex,
      shardCount: shard.shardCount,
      subjectIndexes: shard.subjectIndexes,
      shardDigest: shard.shardDigest
    },
    artifacts: shard.generations.map((generation) => {
      const subject = subjects[generation.subjectIndex];
      return {
        subjectIndex: generation.subjectIndex,
        subjectDigest: subject.subjectDigest,
        outputArtifactKey: generation.outputArtifactKey,
        byteSize: 10,
        sha256: 'f'.repeat(64),
        businessDigest: subject.businessDigest,
        resultRowCount: subject.resultRowCount,
        pendingRowCount: subject.pendingRowCount
      };
    }),
    summary: {
      subjectCount: shard.generations.length,
      artifactCount: shard.generations.length
    }
  }));
  return { input, shards, results };
}

test('E12-C topology/shard planner 只产生 deterministic 1/2 Writer 且 exact coverage', () => {
  const planner = createVccExportTopologyPlanner();
  for (let count = 1; count <= 64; count += 1) {
    const generations = dummyGenerations(count);
    const planned = planner({
      actionKey: VCC_EXPORT_SUBJECTS_ACTION,
      input: { generations, authority: { subjects: Array(count).fill({}) } }
    });
    assert.deepEqual(planned, { effectiveChildCount: count >= 4 ? 2 : 1 });
    const shards = planVccExportShards(generations, planned.effectiveChildCount);
    assert.equal(shards.length, planned.effectiveChildCount);
    assert.deepEqual(shards.flatMap((shard) => shard.subjectIndexes),
      Array.from({ length: count }, (_unused, index) => index));
    assert.equal(new Set(shards.flatMap((shard) => shard.subjectIndexes)).size, count);
    assert.ok(Math.max(...shards.map((shard) => shard.generations.length)) -
      Math.min(...shards.map((shard) => shard.generations.length)) <= 1);
  }
  assert.throws(() => planVccExportShards(dummyGenerations(4), 3), {
    code: 'VCC_EXPORT_SHARD_COUNT_INVALID'
  });
  assert.throws(() => planner({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    input: { generations: dummyGenerations(2), authority: { subjects: [{}] } }
  }), { code: 'VCC_EXPORT_TOPOLOGY_INPUT_INVALID' });
});

test('E12-C shard reducer completion-order independent，并拒绝重复/遗漏/错 owner', () => {
  const fixture = dummyMergeFixture();
  const merged = mergeVccExportShardResults(fixture.input, fixture.shards, fixture.results);
  assert.equal(validateVccExportSubjectsResult(merged), true);
  assert.deepEqual(merged.artifacts.map((artifact) => artifact.subjectIndex), [0, 1, 2, 3]);

  const duplicate = structuredClone(fixture.results);
  duplicate[1].artifacts[0].subjectIndex = 1;
  assert.throws(() => mergeVccExportShardResults(fixture.input, fixture.shards, duplicate), {
    code: 'VCC_EXPORT_SHARD_RESULT_INVALID'
  });
  const omitted = structuredClone(fixture.results);
  omitted[1].artifacts.pop();
  omitted[1].summary.artifactCount -= 1;
  omitted[1].summary.subjectCount -= 1;
  assert.throws(() => mergeVccExportShardResults(fixture.input, fixture.shards, omitted), {
    code: 'VCC_EXPORT_SHARD_RESULT_INVALID'
  });
  const wrongShard = structuredClone(fixture.results);
  wrongShard[1].shard.shardDigest = '0'.repeat(64);
  assert.throws(() => mergeVccExportShardResults(fixture.input, fixture.shards, wrongShard), {
    code: 'VCC_EXPORT_SHARD_RESULT_INVALID'
  });
});

test('E12-C 真实 two child Writer 与 single Writer 金额/币种/Pending/style/order 等价', async (t) => {
  const harness = setup(t);
  const single = generationFixture(harness, 'single');
  const dual = generationFixture(harness, 'dual');
  const singleResult = await executeVccExportWriter(
    single.input,
    null,
    VCC_EXPORT_SUBJECTS_ACTION
  );
  const dualResult = await executeVccExportWriterGraph(dual.input, null, {
    admittedTopology: {
      topologyKey: 'topology.vcc-financial-op:export-subjects',
      effectiveChildCount: 2
    }
  });
  assert.equal(validateVccExportSubjectsResult(singleResult), true);
  assert.equal(validateVccExportSubjectsResult(dualResult), true);
  assert.deepEqual(
    dualResult.artifacts.map((artifact) => ({
      subjectIndex: artifact.subjectIndex,
      subjectDigest: artifact.subjectDigest,
      businessDigest: artifact.businessDigest,
      resultRowCount: artifact.resultRowCount,
      pendingRowCount: artifact.pendingRowCount,
      outputArtifactKey: artifact.outputArtifactKey
    })),
    singleResult.artifacts.map((artifact) => ({
      subjectIndex: artifact.subjectIndex,
      subjectDigest: artifact.subjectDigest,
      businessDigest: artifact.businessDigest,
      resultRowCount: artifact.resultRowCount,
      pendingRowCount: artifact.pendingRowCount,
      outputArtifactKey: dualResult.artifacts[artifact.subjectIndex].outputArtifactKey
    }))
  );
  const [singleDigests, dualDigests] = await Promise.all([
    Promise.all(single.generation.generations.map((item) => workbookSemanticDigest(item.generationPath))),
    Promise.all(dual.generation.generations.map((item) => workbookSemanticDigest(item.generationPath)))
  ]);
  assert.deepEqual(dualDigests, singleDigests);

  const coreSource = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main-process/vcc-financial-op-output/writer-core.js'),
    'utf8'
  );
  const coordinatorSource = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main-process/vcc-financial-op-output/writer-coordinator.js'),
    'utf8'
  );
  assert.match(coreSource, /subjectQueryPushdown:\s*true/);
  assert.doesNotMatch(coordinatorSource, /loadEffectiveRunData\s*\(/);
});

test('E12-C runtime CompoundLease admits two，Main full A/B/Join 后 Publisher exactly once', async (t) => {
  const harness = setup(t);
  const admitted = [];
  const baseAdapter = createWorkerThreadAdapter();
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    vccFinancialOpDatabasePath: harness.dbPath,
    vccFinancialOpAssetsDir: ASSETS_DIR,
    shutdownTimeoutMs: 10000,
    workerThreadAdapter: {
      kind: baseAdapter.kind,
      start(options) {
        if (options.policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
          admitted.push(options.topology && options.topology.effectiveChildCount);
        }
        return baseAdapter.start(options);
      }
    }
  });
  const stagingDirectory = path.join(harness.root, 'runtime-staging');
  fs.mkdirSync(stagingDirectory);
  const plan = filePlan(harness.root, 'runtime-targets', 4);
  const batch = Object.freeze({
    batchId: 324,
    batchNumber: '2026-08-29-e12-c',
    taskRunId: 'vcc-e12-c-runtime-task',
    taskKey: 'vccFinancialOp:export:result',
    moduleId: 'vcc-financial-op',
    parentRunId: 'vcc-e12-c-parent',
    operationKey: 'vcc-e12-c-runtime-operation'
  });
  const taskAuthority = Object.freeze({
    action: 'export-result',
    taskGeneration: 12,
    taskRunId: batch.taskRunId
  });
  let publisherCalls = 0;
  try {
    const result = await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SUBJECTS_ACTION,
      runtime,
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => readVccExportSnapshot(harness.db, harness.run),
      readCurrentTaskAuthority: async () => taskAuthority,
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async (payload) => {
        publisherCalls += 1;
        assert.equal(payload.artifacts.length, 4);
        return Object.freeze({
          taskId: payload.taskId,
          committed: true,
          files: payload.targets.map((target) => target.targetPath)
        });
      },
      settleManifestArtifacts: async () => {}
    });
    assert.deepEqual(admitted, [2]);
    assert.equal(publisherCalls, 1);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.subjectIndex), [0, 1, 2, 3]);
    assert.deepEqual(result.filePaths, plan.outputs.map((output) => output.filePath));
    assert.equal(runtime.policyRegistry.get(VCC_EXPORT_SUBJECTS_ACTION).production.enabled, false);
    assert.equal(runtime.policyRegistry.get(VCC_EXPORT_SUBJECTS_ACTION).production.effectiveWorkerCount, 0);
    assert.deepEqual(runtime.resourceGovernor.snapshot().activeUsage, {
      cpuSlots: 0,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 0
    });
  } finally {
    const report = await runtime.shutdown({ timeoutMs: 10000 });
    assert.deepEqual(report.leakedTransports, []);
  }
});

test('E12-C 任一 shard crash 时 Main Publisher=0，并清理 exact task-private staging', async (t) => {
  const harness = setup(t);
  const stagingDirectory = path.join(harness.root, 'failure-staging');
  fs.mkdirSync(stagingDirectory);
  const plan = filePlan(harness.root, 'failure-targets', 4);
  const batch = Object.freeze({
    batchId: 325,
    batchNumber: '2026-08-29-e12-c-failure',
    taskRunId: 'vcc-e12-c-failure-task',
    taskKey: 'vccFinancialOp:export:result',
    moduleId: 'vcc-financial-op',
    parentRunId: 'vcc-e12-c-failure-parent',
    operationKey: 'vcc-e12-c-failure-operation'
  });
  const taskAuthority = Object.freeze({
    action: 'export-result',
    taskGeneration: 13,
    taskRunId: batch.taskRunId
  });
  const runtime = {
    async execute(request) {
      try {
        const result = await executeVccExportWriterGraph({
          ...request.input,
          databasePath: harness.dbPath,
          assetsDir: ASSETS_DIR
        }, null, {
          admittedTopology: {
            topologyKey: 'topology.vcc-financial-op:export-subjects',
            effectiveChildCount: 2
          },
          runShard: async (input, signal) => {
            if (input.shard.shardIndex === 1) {
              const error = new Error('injected shard crash');
              error.code = 'VCC_EXPORT_SHARD_TRANSPORT_CRASH';
              throw error;
            }
            await new Promise((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener('abort', resolve, { once: true });
            });
            const error = new Error('cancelled sibling');
            error.code = 'VCC_EXPORT_CANCELLED';
            throw error;
          }
        });
        return { outcome: 'completed', terminalSource: 'job:done', result };
      } catch (error) {
        return { outcome: 'failed', terminalSource: 'job:error', error: toProtocolError(error) };
      }
    }
  };
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => taskAuthority,
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), { code: 'VCC_EXPORT_SHARD_TRANSPORT_CRASH' });
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  assert.deepEqual(plan.outputs.map((output) => fs.existsSync(output.filePath)),
    [false, false, false, false]);
});

test('E12-C child crash/cancel/duplicate late terminal 全部 fail closed 且有界收口', async () => {
  class CrashWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('exit', 9));
    }
    postMessage() {}
    terminate() { return Promise.resolve(1); }
  }
  await assert.rejects(runVccExportShardWorker({}, null, { WorkerClass: CrashWorker }), {
    code: 'VCC_EXPORT_SHARD_TRANSPORT_CRASH'
  });

  class LateDuplicateWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => {
        const message = { contractVersion: 1, ok: true, result: { ignored: true }, error: null };
        this.emit('message', message);
        this.emit('message', message);
        this.emit('exit', 0);
      });
    }
    postMessage() {}
    terminate() { return Promise.resolve(1); }
  }
  await assert.rejects(runVccExportShardWorker({}, null, { WorkerClass: LateDuplicateWorker }), {
    code: 'VCC_EXPORT_SHARD_DUPLICATE_TERMINAL'
  });

  let cancelMessage = null;
  let terminateCalls = 0;
  class HangingWorker extends EventEmitter {
    postMessage(message) { cancelMessage = message; }
    terminate() {
      terminateCalls += 1;
      queueMicrotask(() => this.emit('exit', 1));
      return Promise.resolve(1);
    }
  }
  const controller = new AbortController();
  const cancelled = runVccExportShardWorker({}, controller.signal, {
    WorkerClass: HangingWorker,
    cancelTimeoutMs: 0
  });
  controller.abort();
  await assert.rejects(cancelled, { code: 'VCC_EXPORT_CANCELLED' });
  assert.deepEqual(cancelMessage, { contractVersion: 1, operation: 'cancel' });
  assert.equal(terminateCalls, 1);
});

test('E12-C parent group 首错取消 sibling，等待全部 child terminal 后才拒绝', async (t) => {
  const harness = setup(t);
  const dual = generationFixture(harness, 'group-failure');
  const observations = [];
  await assert.rejects(executeVccExportWriterGraph(dual.input, null, {
    admittedTopology: {
      topologyKey: 'topology.vcc-financial-op:export-subjects',
      effectiveChildCount: 2
    },
    runShard: async (input, signal) => {
      const shardIndex = input.shard.shardIndex;
      observations.push(`start-${shardIndex}`);
      if (shardIndex === 1) {
        const error = new Error('injected shard crash');
        error.code = 'VCC_EXPORT_SHARD_TRANSPORT_CRASH';
        throw error;
      }
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
      });
      observations.push('sibling-cancelled-and-settled');
      const error = new Error('cancelled sibling');
      error.code = 'VCC_EXPORT_CANCELLED';
      throw error;
    }
  }), { code: 'VCC_EXPORT_SHARD_TRANSPORT_CRASH' });
  assert.deepEqual(observations, ['start-0', 'start-1', 'sibling-cancelled-and-settled']);
  assert.equal(dual.generation.generations.some((item) => fs.existsSync(item.generationPath)), false);
});
