'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const datasetHeads = require('../../../src/backend/biz-op-recon-db/dataset-head-repository');
const flowRepository = require('../../../src/backend/biz-op-recon-db/flow-imports-repository');
const importsRepository = require('../../../src/backend/biz-op-recon-db/imports-repository');
const runRepository = require('../../../src/backend/biz-op-recon-db/run-repository');
const bizOpReconRunData = require('../../../src/main-process/biz-op-recon-run-data');
const {
  writeDateRangeDiffWorkbook,
  writeSingleDateDiffWorkbook
} = require('../../../src/main-process/biz-op-recon-writer');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  BIZ_OP_READ_ONLY_ACTIONS
} = require('../../../src/main-process/read-only-exports/biz-op/policies');
const {
  freezeBizOpSourceSnapshot,
  openBizOpReadDatabase
} = require('../../../src/main-process/read-only-exports/biz-op/query');
const {
  executeBizOpReadOnlyExport
} = require('../../../src/main-process/read-only-exports/biz-op/writer');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');
const shared = require('../../../scripts/integration/fixtures/biz-op-recon-side-db-parity/_shared');

const MODULE = runDataStore.MODULE_BIZ_OP;

function generationPlan(stagingRoot, fileName, outputArtifactKey) {
  return Object.freeze({
    stagingRoot,
    stagingResourceId: fileName,
    generationPath: path.join(stagingRoot, fileName),
    outputArtifactKey
  });
}

function workerInput({ actionKey, evidence, plan, context, fixture }) {
  return {
    actionKey,
    operationKey: `operation:${actionKey}`,
    taskRunId: `task:${actionKey}`,
    stableRunEvidence: evidence,
    dbPathOrManagedSource: {
      kind: 'biz-op-sqlite',
      mainDatabasePath: fixture.dbPath,
      userDataDir: fixture.root
    },
    generationPlan: plan,
    context
  };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-op-e13-a-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  t.after(() => {
    try { appDb.db.close(); } catch (_error) { /* swallow */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath, appDb, mainDb: appDb.db };
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

function seedSide(fixture, monthKey, source) {
  const sideDb = runDataStore.openSideDb(fixture.root, MODULE, monthKey);
  try {
    importsRepository.insertRows(sideDb, source.t2Date, source.t2);
    datasetHeads.writeHead(sideDb, {
      kind: 'op',
      dataDate: source.t2Date,
      buName: source.t2[0].bu_name,
      identity: {
        datasetId: `${monthKey}:t2`,
        producerTaskRunId: `${monthKey}:t2-task`,
        datasetVersion: 1,
        archiveContractVersion: 1
      }
    });
    importsRepository.insertRows(sideDb, source.date, source.t1);
    datasetHeads.writeHead(sideDb, {
      kind: 'op',
      dataDate: source.date,
      buName: source.t1[0].bu_name,
      identity: {
        datasetId: `${monthKey}:t1`,
        producerTaskRunId: `${monthKey}:t1-task`,
        datasetVersion: 1,
        archiveContractVersion: 1
      }
    });
    flowRepository.insertRows(sideDb, source.date, source.flow);
    datasetHeads.writeHead(sideDb, {
      kind: 'flow',
      dataDate: source.date,
      identity: {
        datasetId: `${monthKey}:flow`,
        producerTaskRunId: `${monthKey}:flow-task`,
        datasetVersion: 1,
        archiveContractVersion: 1
      }
    });
  } finally {
    sideDb.close();
  }
}

function runAndAck(fixture, date, buName, taskRunId) {
  const plan = bizOpReconRunData.prepareRunLineage({
    userDataDir: fixture.root,
    date,
    buName
  });
  const result = bizOpReconRunData.runViaSideDb({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    date,
    buName,
    taskRunId,
    expectedDatasets: plan.expectedDatasets
  });
  bizOpReconRunData.acknowledgeRunByTaskRun({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    taskRunId
  });
  return result;
}

async function writeLegacyDay(fixture, runLocator, savePath) {
  const db = bizOpReconRunData.buildFrozenRangeExportDb({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    runLocators: [runLocator]
  });
  try {
    return await writeSingleDateDiffWorkbook({
      db,
      date: runLocator.date,
      buName: runLocator.buName,
      runId: runLocator.sideRunId,
      savePath
    });
  } finally {
    db.close();
  }
}

async function writeLegacyRange(fixture, runLocators, context, savePath) {
  const db = bizOpReconRunData.buildFrozenRangeExportDb({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    runLocators
  });
  try {
    return await writeDateRangeDiffWorkbook({ db, ...context, savePath });
  } finally {
    db.close();
  }
}

test('E13-A BizOP side DB day/range worker 与 legacy workbook 语义 golden 等价', async (t) => {
  const fixture = createFixture(t);
  const source = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  seedSide(fixture, '2026-03', source);
  const result = runAndAck(fixture, source.date, 'BU-A', 'biz-op-e13-a-side-task');
  const locator = bizOpReconRunData.freezeRunLocator({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    runId: result.runId
  });

  const daySelector = { kind: 'biz-op-day', mirrorRunId: result.runId };
  const daySnapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector: daySelector
  });
  const legacyDay = path.join(fixture.root, 'legacy-day.xlsx');
  await writeLegacyDay(fixture, locator, legacyDay);
  const dayRoot = path.join(fixture.root, 'managed-day');
  fs.mkdirSync(dayRoot);
  const dayPlan = generationPlan(dayRoot, 'day.xlsx', 'biz-op-day-output');
  const day = await executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.DAY,
    evidence: daySnapshot.evidence,
    plan: dayPlan,
    context: daySelector,
    fixture
  }));
  assert.ok(day.summary.rowCount > 0);
  assert.equal(
    readWorkbookBusinessEvidence(dayPlan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacyDay).businessDigest
  );

  const rangeContext = {
    kind: 'biz-op-range',
    buName: 'BU-A',
    startDate: '2026-03-01',
    endDate: '2026-03-31'
  };
  const rangeSnapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector: rangeContext
  });
  const legacyRange = path.join(fixture.root, 'legacy-range.xlsx');
  await writeLegacyRange(fixture, rangeSnapshot.runLocators, rangeContext, legacyRange);
  const rangeRoot = path.join(fixture.root, 'managed-range');
  fs.mkdirSync(rangeRoot);
  const rangePlan = generationPlan(rangeRoot, 'range.xlsx', 'biz-op-range-output');
  const range = await executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.RANGE,
    evidence: rangeSnapshot.evidence,
    plan: rangePlan,
    context: rangeContext,
    fixture
  }));
  assert.equal(range.summary.sheetCount, 1);
  assert.equal(
    readWorkbookBusinessEvidence(rangePlan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacyRange).businessDigest
  );
});

test('E13-A BizOP 空区间保留 legacy 占位工作簿语义', async (t) => {
  const fixture = createFixture(t);
  const rangeContext = {
    kind: 'biz-op-range',
    buName: 'BU-EMPTY',
    startDate: '2026-08-01',
    endDate: '2026-08-03'
  };
  const snapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector: rangeContext
  });
  assert.equal(snapshot.evidence.runCount, 0);

  const legacyPath = path.join(fixture.root, 'legacy-empty-range.xlsx');
  await writeLegacyRange(fixture, snapshot.runLocators, rangeContext, legacyPath);
  const stagingRoot = path.join(fixture.root, 'managed-empty-range');
  fs.mkdirSync(stagingRoot);
  const plan = generationPlan(
    stagingRoot,
    'empty-range.xlsx',
    'biz-op-empty-range-output'
  );
  const managed = await executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.RANGE,
    evidence: snapshot.evidence,
    plan,
    context: rangeContext,
    fixture
  }));

  assert.equal(managed.summary.sheetCount, 0);
  assert.equal(managed.summary.rowCount, 0);
  assert.deepEqual(managed.summary.skippedDates, [
    '2026-08-01',
    '2026-08-02',
    '2026-08-03'
  ]);
  assert.equal(
    readWorkbookBusinessEvidence(plan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacyPath).businessDigest
  );
});

test('E13-A BizOP Main 只冻结紧凑 revision 且 dataset head 失效时 fail closed', async (t) => {
  const fixture = createFixture(t);
  const source = shared.buildSingleDayFixture('2026-07-15', '2026-07-14', 'BU-COMPACT');
  seedSide(fixture, '2026-07', source);
  const result = runAndAck(fixture, source.date, 'BU-COMPACT', 'biz-op-e13-a-compact-run');
  const selector = { kind: 'biz-op-day', mirrorRunId: result.runId };
  const queries = [];
  const snapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: instrumentDatabase(fixture.mainDb, queries),
    selector,
    openSourceDb(databasePath) {
      return instrumentDatabase(openBizOpReadDatabase(databasePath), queries);
    }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.evidence), 'utf8') < 512);
  assert.equal(
    queries.some((sql) => /\bFROM\s+biz_op_recon_(?:diff_rows|imports|flow_imports)\b/i.test(sql)),
    false,
    'Main freeze 不得扫描 BizOP 业务明细行'
  );

  const sideDb = runDataStore.openSideDb(fixture.root, MODULE, '2026-07');
  try {
    sideDb.prepare(`
      UPDATE biz_op_recon_imports
      SET extra_info = COALESCE(extra_info, '') || ' drift'
      WHERE data_date = ?
    `).run(source.date);
  } finally {
    sideDb.close();
  }
  const stagingRoot = path.join(fixture.root, 'dataset-drift');
  fs.mkdirSync(stagingRoot);
  const generationPath = path.join(stagingRoot, 'stale.xlsx');
  await assert.rejects(executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.DAY,
    evidence: snapshot.evidence,
    plan: generationPlan(stagingRoot, 'stale.xlsx', 'biz-op-dataset-drift-output'),
    context: selector,
    fixture
  })), { code: 'BIZ_OP_EXPORT_RUN_NOT_STABLE' });
  assert.equal(fs.existsSync(generationPath), false);
});

test('E13-A BizOP legacy-main day worker 保持历史双源兼容', async (t) => {
  const fixture = createFixture(t);
  const date = '2026-04-15';
  const buName = 'BU-LEGACY';
  const row = shared.makeBizOp({
    rowIndex: 2,
    bu: buName,
    account: 'LEGACY-001',
    begin: 100,
    amtIn: 50,
    amtOut: 0,
    end: 150,
    billDate: date
  });
  importsRepository.insertRows(fixture.mainDb, date, [row]);
  const sourceRow = importsRepository.getRowsByDateBu(fixture.mainDb, date, buName)[0];
  const runId = runRepository.insertRun(fixture.mainDb, {
    date,
    buName,
    stats: { t1OpTotal: 1, amountDiffCount: 1 }
  });
  runRepository.insertDiffRows(fixture.mainDb, runId, date, buName, [{
    source_table: 'T1',
    source_row_id: sourceRow.id,
    cmp_t2: '100',
    multi_op_flag: '',
    cmp_amount: '150',
    amount_diff: '0'
  }]);
  const selector = { kind: 'biz-op-day', mirrorRunId: runId };
  const snapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector
  });
  assert.equal(snapshot.runLocators[0].sideDbRelPath, null);
  const legacy = path.join(fixture.root, 'legacy-main.xlsx');
  await writeLegacyDay(fixture, snapshot.runLocators[0], legacy);
  const stagingRoot = path.join(fixture.root, 'managed-legacy-main');
  fs.mkdirSync(stagingRoot);
  const plan = generationPlan(stagingRoot, 'legacy-main.xlsx', 'biz-op-legacy-main-output');
  await executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.DAY,
    evidence: snapshot.evidence,
    plan,
    context: selector,
    fixture
  }));
  assert.equal(
    readWorkbookBusinessEvidence(plan.generationPath).businessDigest,
    readWorkbookBusinessEvidence(legacy).businessDigest
  );
});

test('E13-A BizOP 拒绝未 ACK receipt、来源漂移与预启动取消', async (t) => {
  const fixture = createFixture(t);
  const source = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-B');
  seedSide(fixture, '2026-05', source);
  const plan = bizOpReconRunData.prepareRunLineage({
    userDataDir: fixture.root,
    date: source.date,
    buName: 'BU-B'
  });
  const taskRunId = 'biz-op-e13-a-unacked-task';
  const result = bizOpReconRunData.runViaSideDb({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    date: source.date,
    buName: 'BU-B',
    taskRunId,
    expectedDatasets: plan.expectedDatasets
  });
  const selector = { kind: 'biz-op-day', mirrorRunId: result.runId };
  assert.throws(() => freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector
  }), { code: 'BIZ_OP_EXPORT_RUN_NOT_STABLE' });
  bizOpReconRunData.acknowledgeRunByTaskRun({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    taskRunId
  });
  const snapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector
  });
  runRepository.updateRunExportPath(fixture.mainDb, result.runId, '/changed/after-freeze.xlsx');
  const staleRoot = path.join(fixture.root, 'stale');
  fs.mkdirSync(staleRoot);
  await assert.rejects(executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.DAY,
    evidence: snapshot.evidence,
    plan: generationPlan(staleRoot, 'stale.xlsx', 'biz-op-stale-output'),
    context: selector,
    fixture
  })), { code: 'BIZ_OP_EXPORT_SOURCE_STALE' });

  const current = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector
  });
  const cancelRoot = path.join(fixture.root, 'cancel');
  fs.mkdirSync(cancelRoot);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeBizOpReadOnlyExport(workerInput({
    actionKey: BIZ_OP_READ_ONLY_ACTIONS.DAY,
    evidence: current.evidence,
    plan: generationPlan(cancelRoot, 'cancel.xlsx', 'biz-op-cancel-output'),
    context: selector,
    fixture
  }), controller.signal), { code: 'BIZ_OP_EXPORT_CANCELLED' });
  assert.equal(fs.existsSync(path.join(cancelRoot, 'cancel.xlsx')), false);
});

test('E13-A BizOP 真实 Runtime authority 注入后在线程 Worker 完成', async (t) => {
  const fixture = createFixture(t);
  const source = shared.buildSingleDayFixture('2026-06-15', '2026-06-14', 'BU-RUNTIME');
  seedSide(fixture, '2026-06', source);
  const result = runAndAck(fixture, source.date, 'BU-RUNTIME', 'biz-op-e13-a-runtime-run');
  const selector = { kind: 'biz-op-day', mirrorRunId: result.runId };
  const snapshot = freezeBizOpSourceSnapshot({
    userDataDir: fixture.root,
    mainDb: fixture.mainDb,
    selector
  });
  const stagingRoot = path.join(fixture.root, 'runtime');
  fs.mkdirSync(stagingRoot);
  const actionKey = BIZ_OP_READ_ONLY_ACTIONS.DAY;
  const operationKey = 'operation:biz-op-runtime-e13-a';
  const taskRunId = 'task:biz-op-runtime-e13-a';
  const runtime = createBackgroundExecutionRuntime({
    mainDatabasePath: fixture.dbPath,
    userDataDir: fixture.root,
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
        taskKey: 'bizOpRecon:export:date',
        moduleId: 'biz-op-recon',
        parentRunId: 'parent:biz-op-runtime-e13-a',
        operationKey
      }
    },
    input: {
      actionKey,
      operationKey,
      taskRunId,
      stableRunEvidence: snapshot.evidence,
      generationPlan: generationPlan(stagingRoot, 'runtime.xlsx', 'biz-op-runtime-output'),
      context: selector
    }
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.ok(execution.result.summary.rowCount > 0);
});
