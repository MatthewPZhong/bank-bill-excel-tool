'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensurePreFundReconciliationRunMetadataSupport
} = require('../../../src/backend/database/migrations');
const mirrorRepository = require(
  '../../../src/backend/database/pre-fund-reconciliation-run-repository'
);
const {
  createPreFundReconciliationRunStore
} = require('../../../src/backend/pre-fund-reconciliation-run-store');
const runDataStore = require('../../../src/backend/run-data-store');
const {
  TEMPLATE_SHEETS,
  writeChannelWorkbook
} = require('../../../src/main-process/pre-fund-reconciliation/excel-writer');
const {
  iterateDuplicateAuditRows
} = require('../../../src/main-process/pre-fund-reconciliation/output-mapper');
const {
  generateValidateAndPublishPreFundExport
} = require('../../../src/main-process/read-only-exports/pre-fund/managed-export');
const {
  PRE_FUND_READ_ONLY_ACTIONS,
  validatePreFundReadOnlyExportResult
} = require('../../../src/main-process/read-only-exports/pre-fund/policies');
const {
  assertPreFundSourceSnapshot,
  freezePreFundSourceSnapshot
} = require('../../../src/main-process/read-only-exports/pre-fund/query');
const {
  executePreFundReadOnlyExport
} = require('../../../src/main-process/read-only-exports/pre-fund/writer');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx');

function mappedRow(headers, prefix) {
  return Object.fromEntries(headers.map((header, index) => [header, `${prefix}-${index + 1}`]));
}

function jsonSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function candidate(channel, sourceOrder, suffix) {
  return {
    sourcePriority: 0,
    sourceOrder,
    source: '临时网关对账单',
    reconciliationId: `RID-${channel}`,
    fingerprint: JSON.stringify([channel, 'same']),
    fields: {
      date: '2026-08-01',
      channel,
      amount: '10.00',
      currency: 'USD',
      tradeType: 'Inbound-VA'
    },
    name: `Name-${suffix}`,
    cardNo: `Card-${suffix}`,
    location: { sourceFileName: `${suffix}.xlsx`, sourceRowNumber: sourceOrder + 2 },
    rawJson: JSON.stringify({ channel, suffix })
  };
}

function createFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-e13-b-'));
  const templatePath = path.join(userDataDir, 'pre-fund-template.xlsx');
  fs.copyFileSync(TEMPLATE_PATH, templatePath);
  const mainDatabasePath = path.join(userDataDir, 'tool-data.sqlite');
  const mainDb = new DatabaseSync(mainDatabasePath);
  ensurePreFundReconciliationRunMetadataSupport(mainDb);
  const store = createPreFundReconciliationRunStore(userDataDir);
  const monthKey = '2026-08';
  const archiveTaskRunId = 'archive-pre-fund-e13-b';
  const snapshot = { bankRevision: 'BANK-R1', gatewayRevision: 'GATEWAY-R1' };
  const bankFiles = ['bank-e13-b.xlsx'];
  const summary = { matchedPairs: 2, unmatchedBankRows: 2 };
  const sideDb = store.open(monthKey);
  const sideRunId = store.createRun(sideDb, {
    scenario: 'missing-gateway',
    snapshot,
    bankFiles,
    archiveReceipt: { archiveTaskRunId }
  });

  store.insertBalancedRow(sideDb, {
    runId: sideRunId,
    channel: 'PLAIN',
    bankOrdinal: 0,
    outputRow: mappedRow(TEMPLATE_SHEETS[1].headers, 'PLAIN-B')
  });
  store.insertUnbalancedRow(sideDb, {
    runId: sideRunId,
    channel: 'PLAIN',
    bankOrdinal: 1,
    outputRow: mappedRow(TEMPLATE_SHEETS[0].headers, 'PLAIN-U'),
    channelOutputRow: mappedRow(TEMPLATE_SHEETS[3].headers, 'PLAIN-C')
  });
  store.insertBalancedRow(sideDb, {
    runId: sideRunId,
    channel: 'AUDIT',
    bankOrdinal: 2,
    outputRow: mappedRow(TEMPLATE_SHEETS[1].headers, 'AUDIT-B')
  });
  store.insertUnbalancedRow(sideDb, {
    runId: sideRunId,
    channel: 'AUDIT',
    bankOrdinal: 3,
    outputRow: mappedRow(TEMPLATE_SHEETS[0].headers, 'AUDIT-U'),
    channelOutputRow: mappedRow(TEMPLATE_SHEETS[3].headers, 'AUDIT-C')
  });
  const kept = candidate('AUDIT', 4, 'kept');
  store.insertGatewayCandidate(sideDb, sideRunId, kept);
  store.insertGatewayCandidate(sideDb, sideRunId, candidate('AUDIT', 5, 'folded'), {
    resolveKeptRawJson: () => kept.rawJson
  });
  store.finishRun(sideDb, sideRunId, summary);
  sideDb.close();
  store.acknowledgeArchiveTerminal(monthKey, sideRunId, archiveTaskRunId);

  const sideDbRelPath = runDataStore.sideDbRelPath(
    runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
    monthKey
  );
  const mirrorRunId = mirrorRepository.createRunMirror(mainDb, {
    monthKey,
    sideRunId,
    scenario: 'missing-gateway',
    snapshotHash: jsonSha256(snapshot),
    bankFiles,
    sideDbRelPath,
    archiveReceipt: { archiveTaskRunId }
  });
  mirrorRepository.finishRunMirror(mainDb, mirrorRunId, summary);
  mirrorRepository.acknowledgeArchiveTerminal(mainDb, mirrorRunId, archiveTaskRunId);

  const locator = Object.freeze({ mirrorRunId, monthKey, sideRunId, archiveTaskRunId });
  const frozen = freezePreFundSourceSnapshot({
    mainDb,
    userDataDir,
    templatePath,
    locator
  });
  return {
    archiveTaskRunId,
    frozen,
    locator,
    mainDatabasePath,
    mainDb,
    sideDatabasePath: frozen.sideDbPath,
    sideRunId,
    store,
    templatePath,
    userDataDir
  };
}

function createGenerationPlan(root, index) {
  const stagingResourceId = `channel-${index + 1}.xlsx`;
  return Object.freeze({
    stagingRoot: root,
    stagingResourceId,
    generationPath: path.join(root, stagingResourceId),
    outputArtifactKey: `artifact-${index + 1}`
  });
}

function unitForChannel(channel, generationPlan) {
  return Object.freeze({
    actionKey: channel.hasDuplicateRecords
      ? PRE_FUND_READ_ONLY_ACTIONS.AUDIT
      : PRE_FUND_READ_ONLY_ACTIONS.CHANNEL,
    context: Object.freeze({
      kind: 'pre-fund-channel',
      channel: channel.channel,
      channelDigest: channel.channelDigest,
      hasDuplicateRecords: channel.hasDuplicateRecords
    }),
    generationPlan
  });
}

function workerInput(fixture, unit, operationKey = 'operation-pre-fund-e13-b') {
  return {
    actionKey: unit.actionKey,
    operationKey,
    taskRunId: fixture.archiveTaskRunId,
    stableRunEvidence: fixture.frozen.evidence,
    dbPathOrManagedSource: {
      kind: 'sqlite',
      mainDatabasePath: fixture.mainDatabasePath,
      sideDatabasePath: fixture.sideDatabasePath,
      templatePath: fixture.templatePath,
      userDataDir: fixture.userDataDir
    },
    generationPlan: unit.generationPlan,
    context: unit.context
  };
}

test('E13-B PreFund channel/audit worker 与 legacy workbook 语义 golden 等价', async (t) => {
  const fixture = createFixture();
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'worker-'));
  const legacyRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'legacy-'));
  t.after(() => {
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });

  const legacyByChannel = new Map();
  let index = 0;
  for (const channelExport of fixture.store.iterateChannelExports(
    fixture.locator.monthKey,
    fixture.sideRunId
  )) {
    const outputPath = path.join(legacyRoot, `legacy-${index + 1}.xlsx`);
    const result = await writeChannelWorkbook({
      templatePath: fixture.templatePath,
      outputPath,
      channel: channelExport.channel,
      balancedRows: channelExport.balancedRows,
      unbalancedRows: channelExport.unbalancedRows,
      channelBillRows: channelExport.channelBillRows,
      duplicateRows: channelExport.hasDuplicateRecords
        ? iterateDuplicateAuditRows(channelExport.duplicateRecords)
        : [],
      hasDuplicateRecords: channelExport.hasDuplicateRecords
    });
    legacyByChannel.set(channelExport.channel, {
      business: readWorkbookBusinessEvidence(outputPath),
      rowCounts: result.rowCounts
    });
    index += 1;
  }

  assert.deepEqual(
    fixture.frozen.channels.map((item) => [item.channel, item.hasDuplicateRecords]),
    [['PLAIN', false], ['AUDIT', true]]
  );
  for (let unitIndex = 0; unitIndex < fixture.frozen.channels.length; unitIndex += 1) {
    const channel = fixture.frozen.channels[unitIndex];
    const unit = unitForChannel(channel, createGenerationPlan(stagingRoot, unitIndex));
    const result = await executePreFundReadOnlyExport(workerInput(fixture, unit), null);
    assert.equal(validatePreFundReadOnlyExportResult(result), true);
    const legacy = legacyByChannel.get(channel.channel);
    assert.deepEqual(
      readWorkbookBusinessEvidence(unit.generationPlan.generationPath),
      legacy.business
    );
    assert.equal(result.summary.balancedCount, legacy.rowCounts.balanced);
    assert.equal(result.summary.unbalancedCount, legacy.rowCounts.unbalanced);
    assert.equal(result.summary.channelBillCount, legacy.rowCounts.channelBill);
    assert.equal(result.summary.duplicateGatewayCount, legacy.rowCounts.duplicateGateway || 0);
    assert.equal(result.artifacts[0].sheetCount, channel.hasDuplicateRecords ? 6 : 5);
  }
});

test('E13-B PreFund Main 只冻结紧凑 revision，未 ACK 与 mirror/side 漂移 fail closed', (t) => {
  const fixture = createFixture();
  t.after(() => {
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  assert.equal(Object.hasOwn(fixture.frozen.evidence, 'channels'), false);
  assert.equal(fixture.frozen.evidence.contractVersion, 1);
  assert.match(fixture.frozen.evidence.templateSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    fixture.frozen.evidence.templateSizeBytes,
    fs.statSync(fixture.templatePath).size
  );
  assert.equal(fixture.frozen.channels.length, 2);

  fixture.mainDb.prepare(`
    UPDATE pre_fund_reconciliation_run_mirrors
    SET archive_terminal_ack_at = NULL
    WHERE id = ?
  `).run(fixture.locator.mirrorRunId);
  assert.throws(
    () => freezePreFundSourceSnapshot({
      mainDb: fixture.mainDb,
      userDataDir: fixture.userDataDir,
      templatePath: fixture.templatePath,
      locator: fixture.locator
    }),
    (error) => error && error.code === 'PRE_FUND_EXPORT_RUN_NOT_STABLE'
  );

  mirrorRepository.acknowledgeArchiveTerminal(
    fixture.mainDb,
    fixture.locator.mirrorRunId,
    fixture.archiveTaskRunId
  );
  fixture.mainDb.prepare(`
    UPDATE pre_fund_reconciliation_run_mirrors
    SET snapshot_hash = 'tampered'
    WHERE id = ?
  `).run(fixture.locator.mirrorRunId);
  assert.throws(
    () => freezePreFundSourceSnapshot({
      mainDb: fixture.mainDb,
      userDataDir: fixture.userDataDir,
      templatePath: fixture.templatePath,
      locator: fixture.locator
    }),
    (error) => error && error.code === 'PRE_FUND_EXPORT_RUN_IDENTITY_MISMATCH'
  );
});

test('E13-B PreFund 模板 revision 纳入来源证据，确认后漂移必须 fail closed', async (t) => {
  const fixture = createFixture();
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'template-stale-'));
  const generationPlan = createGenerationPlan(stagingRoot, 0);
  const unit = unitForChannel(fixture.frozen.channels[0], generationPlan);
  t.after(() => {
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });

  fs.appendFileSync(fixture.templatePath, Buffer.from([0]));
  await assert.rejects(
    () => executePreFundReadOnlyExport(workerInput(fixture, unit), null),
    (error) => error && error.code === 'PRE_FUND_EXPORT_SOURCE_STALE'
  );
  assert.equal(fs.existsSync(generationPlan.generationPath), false);
});

test('E13-B PreFund managed export 逐渠道生成后只做一次整批 Publisher', async (t) => {
  const fixture = createFixture();
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'managed-'));
  t.after(() => {
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const units = fixture.frozen.channels.map((channel, index) => (
    unitForChannel(channel, createGenerationPlan(stagingRoot, index))
  ));
  let publisherCalls = 0;
  let sourceChecks = 0;
  const result = await generateValidateAndPublishPreFundExport({
    runtime: {
      async execute(request) {
        return {
          outcome: 'completed',
          terminalSource: 'job:done',
          result: await executePreFundReadOnlyExport(request.input, null)
        };
      }
    },
    batchContext: {
      taskRunId: fixture.archiveTaskRunId,
      taskKey: 'task-pre-fund-export',
      moduleId: 'pre-fund-reconciliation',
      parentRunId: 'parent-pre-fund-export',
      operationKey: 'operation-pre-fund-export'
    },
    taskRunId: fixture.archiveTaskRunId,
    stableRunEvidence: fixture.frozen.evidence,
    dbPathOrManagedSource: workerInput(fixture, units[0]).dbPathOrManagedSource,
    units,
    production: false,
    assertSourceFresh() {
      sourceChecks += 1;
      return assertPreFundSourceSnapshot(
        freezePreFundSourceSnapshot({
          mainDb: fixture.mainDb,
          userDataDir: fixture.userDataDir,
          templatePath: fixture.templatePath,
          locator: fixture.locator
        }),
        fixture.frozen.evidence
      );
    },
    publisher(artifacts, summaries) {
      publisherCalls += 1;
      assert.equal(artifacts.length, 2);
      assert.equal(summaries.length, 2);
      assert.deepEqual(
        summaries.map((item) => item.channelDigest),
        fixture.frozen.channels.map((item) => item.channelDigest)
      );
      return { taskId: 'publisher-pre-fund-e13-b', files: [] };
    }
  });
  assert.equal(publisherCalls, 1);
  assert.equal(sourceChecks, 4);
  assert.equal(result.artifacts.length, 2);
});

test('E13-B PreFund 渠道 job 缺失或第二个 unit 失败时绝不调用 Publisher', async (t) => {
  const fixture = createFixture();
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'failure-'));
  t.after(() => {
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const units = fixture.frozen.channels.map((channel, index) => (
    unitForChannel(channel, createGenerationPlan(stagingRoot, index))
  ));
  const common = {
    batchContext: {
      taskRunId: fixture.archiveTaskRunId,
      taskKey: 'task-pre-fund-export',
      moduleId: 'pre-fund-reconciliation',
      parentRunId: 'parent-pre-fund-export',
      operationKey: 'operation-pre-fund-export-failure'
    },
    taskRunId: fixture.archiveTaskRunId,
    stableRunEvidence: fixture.frozen.evidence,
    dbPathOrManagedSource: workerInput(fixture, units[0]).dbPathOrManagedSource,
    production: false,
    publisher() { throw new Error('Publisher 不应被调用'); }
  };
  await assert.rejects(
    () => generateValidateAndPublishPreFundExport({
      ...common,
      runtime: { execute: async () => { throw new Error('unreachable'); } },
      units: [units[0]]
    }),
    (error) => error && error.code === 'PRE_FUND_EXPORT_UNIT_SET_MISMATCH'
  );

  let calls = 0;
  await assert.rejects(
    () => generateValidateAndPublishPreFundExport({
      ...common,
      runtime: {
        async execute(request) {
          calls += 1;
          if (calls === 2) {
            return { outcome: 'failed', terminalSource: 'job:error', error: null };
          }
          return {
            outcome: 'completed',
            terminalSource: 'job:done',
            result: await executePreFundReadOnlyExport(request.input, null)
          };
        }
      },
      units
    }),
    (error) => error && error.code === 'PRE_FUND_EXPORT_GENERATION_FAILED'
  );
});

test('E13-B PreFund 预启动取消不产生 artifact，真实 Runtime 在线程 Worker 完成', async (t) => {
  const fixture = createFixture();
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'runtime-'));
  const cancelRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'cancel-'));
  const runtime = createBackgroundExecutionRuntime({
    mainDatabasePath: fixture.mainDatabasePath,
    userDataDir: fixture.userDataDir,
    availableParallelism: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 4 * 1024 ** 3
  });
  t.after(async () => {
    await runtime.shutdown({ timeoutMs: 5000 });
    fixture.mainDb.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });

  const channel = fixture.frozen.channels[0];
  const cancelUnit = unitForChannel(channel, createGenerationPlan(cancelRoot, 0));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => executePreFundReadOnlyExport(workerInput(fixture, cancelUnit), controller.signal),
    (error) => error && error.code === 'PRE_FUND_EXPORT_CANCELLED'
  );
  assert.equal(fs.existsSync(cancelUnit.generationPlan.generationPath), false);

  const unit = unitForChannel(channel, createGenerationPlan(stagingRoot, 0));
  const operationKey = 'operation:pre-fund-runtime-e13-b';
  const taskRunId = fixture.archiveTaskRunId;
  const input = workerInput(fixture, unit, operationKey);
  const execution = await runtime.execute({
    actionKey: unit.actionKey,
    operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId,
        taskKey: 'pre-fund-reconciliation:export',
        moduleId: 'pre-fund-reconciliation',
        parentRunId: 'parent:pre-fund-runtime-e13-b',
        operationKey
      }
    },
    input
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(execution.result.summary.channelDigest, channel.channelDigest);
  assert.equal(execution.result.summary.unbalancedCount, 1);
});
