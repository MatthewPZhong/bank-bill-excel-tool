'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const PENDING_COLUMNS = require('../../../src/backend/pending-db/columns');
const diffRepository = require('../../../src/backend/pending-db/diff-repository');
const { runMigrations } = require('../../../src/backend/pending-db/migrations');
const monthRepository = require('../../../src/backend/pending-db/month-repository');
const pendingExportWriter = require('../../../src/backend/pending-export/writer');
const {
  writePendingErrorReport
} = require('../../../src/backend/pending-export/error-report-writer');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  writePendingManagedErrorSource
} = require('../../../src/main-process/read-only-exports/pending/managed-export');
const {
  PENDING_READ_ONLY_ACTIONS
} = require('../../../src/main-process/read-only-exports/pending/policies');
const {
  freezePendingRunEvidence
} = require('../../../src/main-process/read-only-exports/pending/query');
const {
  executePendingReadOnlyExport
} = require('../../../src/main-process/read-only-exports/pending/writer');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const {
  createPendingSession
} = require('../../../src/main-process/pending-session');

function generationPlan(stagingRoot, fileName, outputArtifactKey) {
  return Object.freeze({
    stagingRoot,
    stagingResourceId: fileName,
    generationPath: path.join(stagingRoot, fileName),
    outputArtifactKey
  });
}

function taskInput({ actionKey, evidence, plan, context, source }) {
  return {
    actionKey,
    operationKey: `operation:${actionKey}`,
    taskRunId: `task:${actionKey}`,
    stableRunEvidence: evidence,
    dbPathOrManagedSource: source,
    generationPlan: plan,
    context
  };
}

function createPendingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-e13-a-'));
  const dbPath = path.join(root, 'pending.sqlite');
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  db.exec('PRAGMA journal_mode = WAL');
  const cells = new Array(PENDING_COLUMNS.length).fill('');
  cells[PENDING_COLUMNS.indexOf('order_no')] = 'ORDER-E13-A';
  cells[PENDING_COLUMNS.indexOf('金额')] = '123.45';
  const upperId = Number(
    monthRepository.createRowInserter(db)('2026-10', 'pending-source.xlsx', cells).lastInsertRowid
  );
  monthRepository.upsertMonthMetaLegacy(db, {
    yearMonth: '2026-10',
    rowCount: 1,
    sourceFiles: ['pending-source.xlsx'],
    archivePath: null
  });
  monthRepository.upsertMonthMetaLegacy(db, {
    yearMonth: '2026-11',
    rowCount: 0,
    sourceFiles: ['pending-lower-source.xlsx'],
    archivePath: null
  });
  const runId = diffRepository.createLegacyRun(db, {
    upperMonth: '2026-10',
    lowerMonth: '2026-11',
    ruleSnapshot: { matchFields: ['order_no'], compareFields: ['金额'] }
  });
  db.prepare(`
    INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id)
    VALUES (?, 'missing', ?, NULL)
  `).run(runId, upperId);
  diffRepository.updateRunStats(db, runId, { statMissing: 1 });
  t.after(() => {
    try { db.close(); } catch (_error) { /* swallow */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath, db, runId };
}

function instrumentDatabase(db, queries) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          queries.push(String(sql));
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

test('E13-A Pending single/aggregate worker 与 legacy workbook 语义 golden 等价', async (t) => {
  const fixture = createPendingFixture(t);
  const evidence = freezePendingRunEvidence(fixture.db, [fixture.runId]);
  const source = { kind: 'sqlite', databasePath: fixture.dbPath };

  const legacySingle = path.join(fixture.root, 'legacy-single.xlsx');
  pendingExportWriter.exportSingleRun(fixture.db, fixture.runId, legacySingle);
  const singleRoot = path.join(fixture.root, 'managed-single');
  fs.mkdirSync(singleRoot);
  const singlePlan = generationPlan(singleRoot, 'single.xlsx', 'pending-single-output');
  const single = await executePendingReadOnlyExport(taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.DIFF,
    evidence,
    plan: singlePlan,
    source,
    context: { kind: 'pending-diff', runIds: [fixture.runId] }
  }));
  assert.equal(single.summary.rowCount, 1);
  assert.equal(
    readWorkbookBusinessEvidence(singlePlan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacySingle).businessDigest
  );

  const legacyAggregate = path.join(fixture.root, 'legacy-aggregate.xlsx');
  pendingExportWriter.exportAggregateRuns(fixture.db, [fixture.runId], legacyAggregate);
  const aggregateRoot = path.join(fixture.root, 'managed-aggregate');
  fs.mkdirSync(aggregateRoot);
  const aggregatePlan = generationPlan(aggregateRoot, 'aggregate.xlsx', 'pending-aggregate-output');
  const aggregate = await executePendingReadOnlyExport(taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.SUMMARY,
    evidence,
    plan: aggregatePlan,
    source,
    context: { kind: 'pending-summary', runIds: [fixture.runId] }
  }));
  assert.equal(aggregate.summary.runsCount, 1);
  assert.equal(
    readWorkbookBusinessEvidence(aggregatePlan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacyAggregate).businessDigest
  );
});

test('E13-A Pending Main 只冻结紧凑 revision 且 dataset head 漂移时 fail closed', async (t) => {
  const fixture = createPendingFixture(t);
  const queries = [];
  const evidence = freezePendingRunEvidence(
    instrumentDatabase(fixture.db, queries),
    [fixture.runId]
  );
  assert.ok(Buffer.byteLength(JSON.stringify(evidence), 'utf8') < 512);
  assert.equal(
    queries.some((sql) => /\bFROM\s+(?:diff_rows|pending_rows|pending_removal_matches)\b/i.test(sql)),
    false,
    'Main freeze 不得扫描 Pending 业务明细行'
  );

  fixture.db.prepare(`
    UPDATE pending_months
    SET dataset_id = 'pending-e13-a-drift', dataset_version = dataset_version + 1
    WHERE year_month = '2026-10'
  `).run();
  const stagingRoot = path.join(fixture.root, 'dataset-drift');
  fs.mkdirSync(stagingRoot);
  const generationPath = path.join(stagingRoot, 'stale.xlsx');
  await assert.rejects(executePendingReadOnlyExport(taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.DIFF,
    evidence,
    plan: generationPlan(stagingRoot, 'stale.xlsx', 'pending-dataset-drift-output'),
    source: { kind: 'sqlite', databasePath: fixture.dbPath },
    context: { kind: 'pending-diff', runIds: [fixture.runId] }
  })), { code: 'PENDING_EXPORT_SOURCE_STALE' });
  assert.equal(fs.existsSync(generationPath), false);
});

test('E13-A Pending aggregate 在 writer 同一 read transaction 内执行 stable gate', (t) => {
  const fixture = createPendingFixture(t);
  const outputPath = path.join(fixture.root, 'aggregate-transaction-gate.xlsx');
  let gateCount = 0;
  const gateError = Object.assign(new Error('aggregate source changed'), {
    code: 'PENDING_EXPORT_SOURCE_STALE'
  });
  assert.throws(() => pendingExportWriter.exportAggregateRuns(
    fixture.db,
    [fixture.runId],
    outputPath,
    {
      beforeBuild(currentDb) {
        gateCount += 1;
        assert.equal(currentDb, fixture.db);
        assert.throws(() => currentDb.exec('BEGIN'), {
          code: 'ERR_SQLITE_ERROR',
          message: /within a transaction/
        });
        throw gateError;
      }
    }
  ), { code: 'PENDING_EXPORT_SOURCE_STALE' });
  assert.equal(gateCount, 1);
  assert.doesNotThrow(() => {
    fixture.db.exec('BEGIN');
    fixture.db.exec('ROLLBACK');
  });
  assert.equal(fs.existsSync(outputPath), false);
});

test('E13-A 抽取错误报告 writer 不破坏 legacy Pending 留底导出', async (t) => {
  const fixture = createPendingFixture(t);
  const storageRoot = path.join(fixture.root, 'storage');
  fs.mkdirSync(storageRoot);
  const session = createPendingSession({
    getPendingDb: () => fixture.db,
    getStorageRoot: () => storageRoot
  });
  const archivePath = await session.archiveExistingMonth('2026-10', fixture.dbPath, null);
  assert.equal(typeof archivePath, 'string');
  assert.equal(fs.existsSync(archivePath), true);
  const evidence = readWorkbookBusinessEvidence(archivePath);
  assert.equal(evidence.sheetCount, 1);
  assert.equal(evidence.dataRowCount, 1);
});

test('E13-A Pending 错误快照使用版本化 authority，不在 Main 深拷贝大数组', async (t) => {
  const fixture = createPendingFixture(t);
  const storageRoot = path.join(fixture.root, 'snapshot-authority');
  fs.mkdirSync(storageRoot);
  const session = createPendingSession({
    getPendingDb: () => fixture.db,
    getStorageRoot: () => storageRoot
  });
  const failed = await session.runImport({
    yearMonth: '2026-12',
    files: [path.join(fixture.root, 'missing-pending.xlsx')],
    overwriteConfirmed: false,
    dbPath: fixture.dbPath,
    batchContext: null,
    datasetSeed: null
  });
  assert.equal(failed.status, 'error');
  const authority = session.captureErrorReport();
  assert.ok(authority && authority.snapshot && Array.isArray(authority.snapshot.errors));
  assert.equal(session.isErrorReportSnapshotCurrent(authority), true);
  session.clearLastImportErrors();
  assert.equal(session.isErrorReportSnapshotCurrent(authority), false);
});

test('E13-A Pending error managed source 不进 Protocol 大载荷且 workbook golden 等价', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-error-e13-a-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = Object.freeze({
    errors: Object.freeze([Object.freeze({
      file: 'pending.xlsx',
      sheetRow: 9,
      severity: 'invalid_amount',
      code: 'invalid_amount',
      message: '金额非法',
      cells: Object.freeze(new Array(PENDING_COLUMNS.length).fill('示例'))
    })])
  });
  const legacyPath = path.join(root, 'legacy-errors.xlsx');
  writePendingErrorReport(snapshot, legacyPath);
  const managedRoot = path.join(root, 'managed');
  fs.mkdirSync(managedRoot);
  const managed = await writePendingManagedErrorSource({ snapshot, stagingRoot: managedRoot });
  const plan = generationPlan(managedRoot, 'errors.xlsx', 'pending-errors-output');
  const input = taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.ERRORS,
    evidence: managed.evidence,
    plan,
    source: managed.source,
    context: managed.context
  });
  const result = await executePendingReadOnlyExport(input);
  assert.equal(result.summary.errorCount, 1);
  assert.equal(
    readWorkbookBusinessEvidence(plan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacyPath).businessDigest
  );

  const largeRoot = path.join(root, 'large');
  fs.mkdirSync(largeRoot);
  let eventLoopAdvanced = false;
  setImmediate(() => { eventLoopAdvanced = true; });
  const large = await writePendingManagedErrorSource({
    stagingRoot: largeRoot,
    snapshot: { errors: [{ file: 'large.xlsx', cells: ['x'.repeat(300000)] }] }
  });
  const largeInput = taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.ERRORS,
    evidence: large.evidence,
    plan: generationPlan(largeRoot, 'large-errors.xlsx', 'large-error-output'),
    source: large.source,
    context: large.context
  });
  assert.equal(eventLoopAdvanced, true);
  assert.ok(large.source.byteSize > 262144);
  assert.ok(Buffer.byteLength(JSON.stringify(largeInput), 'utf8') < 10000);
});

test('E13-A Pending 拒绝未 ACK v1、stale managed source 与预启动取消', async (t) => {
  const fixture = createPendingFixture(t);
  const unacked = diffRepository.createRun(fixture.db, {
    upperMonth: '2026-11',
    lowerMonth: '2026-12',
    ruleSnapshot: {},
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'pending-unacked-task' }
  });
  assert.throws(
    () => freezePendingRunEvidence(fixture.db, [unacked]),
    { code: 'PENDING_EXPORT_RUN_NOT_STABLE' }
  );

  const errorRoot = path.join(fixture.root, 'tamper');
  fs.mkdirSync(errorRoot);
  const managed = await writePendingManagedErrorSource({
    stagingRoot: errorRoot,
    snapshot: { errors: [{ file: 'before.xlsx', cells: [] }] }
  });
  fs.writeFileSync(managed.source.filePath, JSON.stringify({ errors: [] }));
  await assert.rejects(executePendingReadOnlyExport(taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.ERRORS,
    evidence: managed.evidence,
    plan: generationPlan(errorRoot, 'tampered.xlsx', 'tampered-output'),
    source: managed.source,
    context: managed.context
  })), { code: 'PENDING_EXPORT_INPUT_INVALID' });

  const cancelRoot = path.join(fixture.root, 'cancel');
  fs.mkdirSync(cancelRoot);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executePendingReadOnlyExport(taskInput({
    actionKey: PENDING_READ_ONLY_ACTIONS.DIFF,
    evidence: freezePendingRunEvidence(fixture.db, [fixture.runId]),
    plan: generationPlan(cancelRoot, 'cancelled.xlsx', 'cancelled-output'),
    source: { kind: 'sqlite', databasePath: fixture.dbPath },
    context: { kind: 'pending-diff', runIds: [fixture.runId] }
  }), controller.signal), { code: 'PENDING_EXPORT_CANCELLED' });
  assert.equal(fs.existsSync(path.join(cancelRoot, 'cancelled.xlsx')), false);
});

test('E13-A Pending 真实 Runtime authority 注入后在线程 Worker 完成', async (t) => {
  const fixture = createPendingFixture(t);
  const stagingRoot = path.join(fixture.root, 'runtime');
  fs.mkdirSync(stagingRoot);
  const evidence = freezePendingRunEvidence(fixture.db, [fixture.runId]);
  const actionKey = PENDING_READ_ONLY_ACTIONS.DIFF;
  const operationKey = 'operation:pending-runtime-e13-a';
  const taskRunId = 'task:pending-runtime-e13-a';
  const runtime = createBackgroundExecutionRuntime({
    pendingDatabasePath: fixture.dbPath,
    availableParallelism: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 4 * 1024 ** 3
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 5000 }); });
  const execution = await runtime.execute({
    actionKey,
    operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId,
        taskKey: 'pending:diff:export-single',
        moduleId: 'pending-reconciliation',
        parentRunId: 'parent:pending-runtime-e13-a',
        operationKey
      }
    },
    input: {
      actionKey,
      operationKey,
      taskRunId,
      stableRunEvidence: evidence,
      generationPlan: generationPlan(stagingRoot, 'runtime.xlsx', 'pending-runtime-output'),
      context: { kind: 'pending-diff', runIds: [fixture.runId] }
    }
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(execution.result.summary.rowCount, 1);
});
