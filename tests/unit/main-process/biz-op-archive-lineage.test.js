'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../src/backend/database');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const { ensureBizOpReconTablesSupport } = require('../../../src/backend/biz-op-recon-db/migrations');
const datasetHeads = require('../../../src/backend/biz-op-recon-db/dataset-head-repository');
const imports = require('../../../src/backend/biz-op-recon-db/imports-repository');
const flow = require('../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runs = require('../../../src/backend/biz-op-recon-db/run-repository');
const session = require('../../../src/main-process/biz-op-recon-session');
const lineage = require('../../../src/main-process/biz-op-archive-lineage');
const runDataStore = require('../../../src/backend/run-data-store');
const runData = require('../../../src/main-process/biz-op-recon-run-data');
const shared = require('../../../scripts/integration/fixtures/biz-op-recon-side-db-parity/_shared');

function identity(datasetId, producerTaskRunId, datasetVersion = 1) {
  return { datasetId, producerTaskRunId, datasetVersion, archiveContractVersion: 1 };
}

function dumpBizOpState(db) {
  return {
    imports: db.prepare('SELECT * FROM biz_op_recon_imports ORDER BY id').all(),
    runs: db.prepare('SELECT * FROM biz_op_recon_runs ORDER BY id').all(),
    diffs: db.prepare('SELECT * FROM biz_op_recon_diff_rows ORDER BY id').all(),
    heads: db.prepare(`
      SELECT * FROM biz_op_recon_dataset_heads
      ORDER BY dataset_kind, data_date, normalized_bu
    `).all()
  };
}

function seedSources(db) {
  imports.insertRows(db, '2026-05-22', [{
    _rowIndex: 1, bu_name: 'BU-A', account_no: 'A-1', end_balance: '110'
  }]);
  imports.insertRows(db, '2026-05-21', [{
    _rowIndex: 1, bu_name: 'BU-A', account_no: 'A-1', end_balance: '100'
  }]);
  flow.insertRows(db, '2026-05-22', [{
    _rowIndex: 1, bu_dept: 'BU-A', account_no: 'A-1', direction: '入', recon_amount: '10'
  }]);
  datasetHeads.writeHead(db, {
    kind: 'op', dataDate: '2026-05-22', buName: 'BU-A', identity: identity('t1-dataset', 'op-task-t1')
  });
  datasetHeads.writeHead(db, {
    kind: 'op', dataDate: '2026-05-21', buName: 'BU-A', identity: identity('t2-dataset', 'op-task-t2')
  });
  datasetHeads.writeHead(db, {
    kind: 'flow', dataDate: '2026-05-22', identity: identity('flow-dataset', 'flow-task')
  });
}

function archiveTaskPayload(taskRunId, status = 'running') {
  return {
    taskRunId,
    moduleId: lineage.BIZ_OP_MODULE_ID,
    taskKey: lineage.BIZ_OP_RUN_TASK_KEY,
    operationKey: `${lineage.BIZ_OP_RUN_TASK_KEY}:${taskRunId}`,
    parentRunId: `parent:${taskRunId}`,
    status
  };
}

function archiveService(repository, { failDirectBind = false } = {}) {
  return {
    repository,
    async bindFlowAnchor(payload) {
      if (failDirectBind) return { ok: false, message: 'injected bind failure' };
      return { ok: true, ...repository.bindFlowAnchor(payload) };
    },
    async persistTaskFlowBindIntent(payload) {
      return { ok: true, ...repository.persistTaskFlowBindIntent(payload) };
    },
    async beginTaskRunRecovery(taskRunId) {
      const result = repository.transitionTaskRun(taskRunId, 'running', { recovery: true });
      return { ok: result.status === 'updated' || result.status === 'unchanged', ...result };
    },
    async finishTaskRun(taskRunId, outcome) {
      const result = repository.transitionTaskRun(taskRunId, outcome.taskStatus, {
        expectedStatuses: ['prepared', 'running'],
        metadata: outcome.metadata
      });
      return { ok: result.status === 'updated' || result.status === 'unchanged', ...result };
    }
  };
}

function seedSideRun(userDataDir, taskRunId) {
  const sideDb = runDataStore.openSideDb(userDataDir, runDataStore.MODULE_BIZ_OP, '2026-05');
  try {
    seedSources(sideDb);
    const plan = lineage.bizOpRunLineagePlan(sideDb, { date: '2026-05-22', buName: 'BU-A' });
    return session.runReconciliation(sideDb, {
      date: '2026-05-22',
      buName: 'BU-A',
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: taskRunId },
      expectedDatasets: plan.expectedDatasets
    });
  } finally {
    sideDb.close();
  }
}

test('Biz run 冻结三源 lineage，并在同一事务写 v1 receipt', () => {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  seedSources(db);
  const plan = lineage.bizOpRunLineagePlan(db, { date: '2026-05-22', buName: 'BU-A' });
  assert.deepEqual(plan.expectedDatasets, {
    t1DatasetId: 't1-dataset',
    t2DatasetId: 't2-dataset',
    flowDatasetId: 'flow-dataset'
  });
  assert.deepEqual(plan.lineageIntents.map((item) => item.producerTaskRunId), [
    'op-task-t1', 'op-task-t2', 'flow-task'
  ]);

  const result = session.runReconciliation(db, {
    date: '2026-05-22',
    buName: 'BU-A',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-run-task' },
    expectedDatasets: plan.expectedDatasets
  });
  const receipt = runs.getRunById(db, result.runId);
  assert.equal(receipt.archive_contract_version, 1);
  assert.equal(receipt.archive_task_run_id, 'biz-run-task');
  assert.equal(receipt.archive_terminal_ack_at, null);
  db.close();
});

test('Biz 同日同规范化 BU rerun 遇未 ACK receipt 时不落第二个 run/diff', () => {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  seedSources(db);
  const plan = lineage.bizOpRunLineagePlan(db, { date: '2026-05-22', buName: 'BU-A' });
  session.runReconciliation(db, {
    date: '2026-05-22',
    buName: 'BU-A',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-first-run' },
    expectedDatasets: plan.expectedDatasets
  });
  const before = dumpBizOpState(db);

  assert.throws(() => session.runReconciliation(db, {
    date: '2026-05-22',
    buName: '  bu-a  ',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-late-run' },
    expectedDatasets: plan.expectedDatasets
  }), /未 ACK/);
  assert.deepEqual(dumpBizOpState(db), before);
  db.close();
});

test('Biz OP 重导遇未 ACK receipt 时 imports/run/diff/head 零变化', async () => {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  seedSources(db);
  const plan = lineage.bizOpRunLineagePlan(db, { date: '2026-05-22', buName: 'BU-A' });
  session.runReconciliation(db, {
    date: '2026-05-22',
    buName: 'BU-A',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-pending-run' },
    expectedDatasets: plan.expectedDatasets
  });
  const before = dumpBizOpState(db);
  const replacement = shared.makeBizOp({
    rowIndex: 2, bu: ' bu-a ', account: 'A-2', begin: 0,
    amtIn: 20, amtOut: 0, end: 20, billDate: '2026-05-22'
  });

  await assert.rejects(session.runBizOpImportAsync(db, {
    date: '2026-05-22',
    filePath: '/tmp/biz-op-reimport.xlsx',
    readBizOpFile: () => ({ rows: [replacement] }),
    writeBizOpErrorReportXlsx: async () => { throw new Error('unexpected report'); },
    errorReportsDir: '/tmp',
    datasetSeed: { datasetId: 'replacement-op', producerTaskRunId: 'replacement-op-task' }
  }), /未 ACK/);
  assert.deepEqual(dumpBizOpState(db), before);
  db.close();
});

test('normal run 边界拒绝 malformed receipt，来源 head 变化时不落 run', () => {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  seedSources(db);
  const plan = lineage.bizOpRunLineagePlan(db, { date: '2026-05-22', buName: 'BU-A' });
  assert.throws(() => session.runReconciliation(db, {
    date: '2026-05-22', buName: 'BU-A', archiveReceipt: { archiveContractVersion: 1 },
    expectedDatasets: plan.expectedDatasets
  }), /exact v1 Archive receipt/);

  datasetHeads.writeHead(db, {
    kind: 'flow', dataDate: '2026-05-22', identity: identity('flow-replaced', 'other-flow-task', 2)
  });
  assert.throws(() => session.runReconciliation(db, {
    date: '2026-05-22', buName: 'BU-A',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-run-task' },
    expectedDatasets: plan.expectedDatasets
  }), /来源 dataset 已变化/);
  assert.equal(runs.listUnacknowledgedArchiveRuns(db).length, 0);
  db.close();
});

test('历史 v0 dataset 只形成 producer=null 的直接 intent', () => {
  const intent = lineage.datasetLineageIntent({
    datasetId: 'legacy-dataset', archiveContractVersion: 0, producerTaskRunId: null
  }, 'T-1 Biz OP');
  assert.equal(intent.sourceContractVersion, 0);
  assert.equal(intent.producerTaskRunId, null);
});

test('Biz owner 在 sweep 前按 exact side receipt 修复 mirror、flow anchor、terminal 并 ack', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-owner-recovery-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  const task = repository.beginTaskRun(archiveTaskPayload('biz-recovery-task')).taskRun;
  repository.transitionTaskRun(task.taskRunId, 'running');
  seedSideRun(directory, task.taskRunId);

  const recovered = await runData.recoverRunReceipts({
    userDataDir: directory,
    mainDb: appDb.db,
    archiveService: archiveService(repository, { failDirectBind: true })
  });
  assert.equal(recovered.recovered, 1);
  const mirror = runs.getRunByArchiveTaskRunId(appDb.db, task.taskRunId);
  assert.ok(mirror);
  assert.ok(mirror.archive_terminal_ack_at);
  assert.equal(repository.getTaskRun(task.taskRunId).status, 'succeeded');
  const intent = repository.listTaskFlowBindIntents({
    moduleId: lineage.BIZ_OP_MODULE_ID,
    identityType: 'business-run-id',
    identityValue: String(mirror.id)
  })[0];
  assert.equal(intent.parentRunId, task.parentRunId);
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(directory, runDataStore.MODULE_BIZ_OP, '2026-05')
  );
  try {
    assert.ok(runs.getRunByArchiveTaskRunId(sideDb, task.taskRunId).archive_terminal_ack_at);
  } finally {
    sideDb.close();
  }
});

test('Biz owner 遇 failed TaskRun 先 fail-closed，不创建主库 mirror', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-owner-conflict-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  repository.beginTaskRun(archiveTaskPayload('biz-failed-task'));
  repository.transitionTaskRun('biz-failed-task', 'running');
  repository.transitionTaskRun('biz-failed-task', 'failed');
  seedSideRun(directory, 'biz-failed-task');

  await assert.rejects(
    runData.recoverRunReceipts({
      userDataDir: directory,
      mainDb: appDb.db,
      archiveService: archiveService(repository)
    }),
    (error) => error.blocksArchiveStartup === true
  );
  assert.equal(runs.getRunByArchiveTaskRunId(appDb.db, 'biz-failed-task'), null);
});

test('Biz main 已 ack 而 side 未 ack 时，不用旧 receipt 回滚后写的新 mirror', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-owner-ack-window-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  const task = repository.beginTaskRun(archiveTaskPayload('biz-old-task')).taskRun;
  repository.transitionTaskRun(task.taskRunId, 'running');
  const sideResult = seedSideRun(directory, task.taskRunId);
  repository.transitionTaskRun(task.taskRunId, 'succeeded');
  const relPath = runDataStore.sideDbRelPath(runDataStore.MODULE_BIZ_OP, '2026-05');
  const oldMirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22', buName: 'BU-A', relPath,
    stats: sideResult.stats,
    status: 'success', archiveTaskRunId: task.taskRunId
  });
  runs.acknowledgeArchiveTerminal(appDb.db, oldMirrorId, task.taskRunId);
  const newerMirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22', buName: 'BU-A', relPath,
    stats: {
      t1OpTotal: 9, t2OpTotal: 8, flowTotal: 7, amountDiffCount: 6,
      multiOpAccountCount: 5, t2AnomalyAccountCount: 4,
      t1NotT2Count: 3, t2NotT1Count: 2
    },
    status: 'success', archiveTaskRunId: 'biz-new-task'
  });

  await runData.recoverRunReceipts({
    userDataDir: directory,
    mainDb: appDb.db,
    archiveService: archiveService(repository)
  });
  assert.equal(runs.getRunById(appDb.db, newerMirrorId).archive_task_run_id, 'biz-new-task');
  assert.equal(runs.getRunByArchiveTaskRunId(appDb.db, task.taskRunId), null);
});

test('Biz 主库 mirror 覆盖遇未 ACK receipt 时保留原镜像', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-mirror-unack-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const relPath = runDataStore.sideDbRelPath(runDataStore.MODULE_BIZ_OP, '2026-05');
  const stats = {
    t1OpTotal: 3, t2OpTotal: 2, flowTotal: 1, amountDiffCount: 1,
    multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
    t1NotT2Count: 0, t2NotT1Count: 0
  };
  const mirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22', buName: 'BU-A', relPath,
    stats, status: 'success', archiveTaskRunId: 'biz-pending-mirror'
  });
  const before = { ...runs.getRunById(appDb.db, mirrorId) };

  assert.throws(() => runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22', buName: '  bu-a ', relPath,
    stats: { ...stats, flowTotal: 99 }, status: 'success', archiveTaskRunId: 'biz-late-mirror'
  }), /未 ACK/);
  assert.deepEqual({ ...runs.getRunById(appDb.db, mirrorId) }, before);
  assert.equal(runs.listRunsByDateBu(appDb.db, '2026-05-22', 'BU-A').length, 1);
});

test('Biz side receipt 后主库 mirror 失败时精确删除本 TaskRun 的 run/diff 再允许 failed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-mirror-compensation-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  repository.beginTaskRun(archiveTaskPayload('biz-mirror-failed-task'));
  repository.transitionTaskRun('biz-mirror-failed-task', 'running');

  const sideDb = runDataStore.openSideDb(
    directory,
    runDataStore.MODULE_BIZ_OP,
    '2026-05'
  );
  try {
    seedSources(sideDb);
  } finally {
    sideDb.close();
  }
  const relPath = runDataStore.sideDbRelPath(runDataStore.MODULE_BIZ_OP, '2026-05');
  const blockingMirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22',
    buName: 'BU-A',
    relPath,
    stats: {
      t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 0,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
      t1NotT2Count: 0, t2NotT1Count: 0
    },
    status: 'success',
    archiveTaskRunId: 'biz-existing-unack-mirror'
  });
  const plan = runData.prepareRunLineage({
    userDataDir: directory,
    date: '2026-05-22',
    buName: 'BU-A'
  });

  assert.throws(() => runData.runViaSideDb({
    userDataDir: directory,
    mainDb: appDb.db,
    date: '2026-05-22',
    buName: 'BU-A',
    taskRunId: 'biz-mirror-failed-task',
    expectedDatasets: plan.expectedDatasets
  }), /未 ACK/);
  repository.transitionTaskRun('biz-mirror-failed-task', 'failed');

  const verifySide = runDataStore.openSideDb(
    directory,
    runDataStore.MODULE_BIZ_OP,
    '2026-05'
  );
  try {
    assert.equal(runs.getRunByArchiveTaskRunId(verifySide, 'biz-mirror-failed-task'), null);
    assert.equal(verifySide.prepare('SELECT COUNT(*) AS count FROM biz_op_recon_diff_rows').get().count, 0);
  } finally {
    verifySide.close();
  }
  assert.equal(repository.getTaskRun('biz-mirror-failed-task').status, 'failed');
  assert.equal(runs.listRunsByDateBu(appDb.db, '2026-05-22', 'BU-A').length, 1);
  assert.equal(runs.getRunById(appDb.db, blockingMirrorId).archive_task_run_id, 'biz-existing-unack-mirror');
});

test('Biz 精确补偿事务失败时保留 interrupted owner，既有启动恢复可收口 receipt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-compensation-recovery-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  repository.beginTaskRun(archiveTaskPayload('biz-compensation-recovery-task'));
  repository.transitionTaskRun('biz-compensation-recovery-task', 'running');
  const sideDb = runDataStore.openSideDb(
    directory,
    runDataStore.MODULE_BIZ_OP,
    '2026-05'
  );
  try {
    seedSources(sideDb);
  } finally {
    sideDb.close();
  }
  const relPath = runDataStore.sideDbRelPath(runDataStore.MODULE_BIZ_OP, '2026-05');
  const blockingMirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22',
    buName: 'BU-A',
    relPath,
    stats: {
      t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 0,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
      t1NotT2Count: 0, t2NotT1Count: 0
    },
    status: 'success',
    archiveTaskRunId: 'biz-compensation-blocker'
  });
  const plan = runData.prepareRunLineage({
    userDataDir: directory,
    date: '2026-05-22',
    buName: 'BU-A'
  });
  const originalDelete = runs.deleteArchiveRunByTaskRunId;
  runs.deleteArchiveRunByTaskRunId = () => {
    throw new Error('forced exact compensation failure');
  };
  t.after(() => { runs.deleteArchiveRunByTaskRunId = originalDelete; });

  assert.throws(() => runData.runViaSideDb({
    userDataDir: directory,
    mainDb: appDb.db,
    date: '2026-05-22',
    buName: 'BU-A',
    taskRunId: 'biz-compensation-recovery-task',
    expectedDatasets: plan.expectedDatasets
  }), (error) => error.code === 'BIZ_OP_MIRROR_COMPENSATION_FAILED'
    && error.preserveArchiveTaskRun === true);
  const service = archiveService(repository);
  const interrupted = await service.finishTaskRun('biz-compensation-recovery-task', {
    taskStatus: 'interrupted',
    code: 'BIZ_OP_MIRROR_COMPENSATION_FAILED',
    message: 'forced exact compensation failure',
    metadata: { bizOpRunReceiptPending: true }
  });
  assert.equal(interrupted.ok, true);
  assert.equal(repository.getTaskRun('biz-compensation-recovery-task').status, 'interrupted');

  runs.deleteArchiveRunByTaskRunId = originalDelete;
  runs.acknowledgeArchiveTerminal(appDb.db, blockingMirrorId, 'biz-compensation-blocker');
  const recovered = await runData.recoverRunReceipts({
    userDataDir: directory,
    mainDb: appDb.db,
    archiveService: service
  });
  assert.equal(recovered.recovered, 1);
  assert.equal(repository.getTaskRun('biz-compensation-recovery-task').status, 'succeeded');
});

test('Biz 显式重跑在新 side receipt 后崩溃时，可替换同日已 ack 旧 mirror', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-rerun-recovery-'));
  const appDb = new AppDatabase(path.join(directory, 'tool-data.sqlite'));
  appDb.init();
  t.after(() => {
    appDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repository = createArchiveRepository(appDb.db);
  repository.ensureSchema();
  for (const taskRunId of ['biz-old-run', 'biz-new-run']) {
    repository.beginTaskRun(archiveTaskPayload(taskRunId));
    repository.transitionTaskRun(taskRunId, 'running');
  }
  const oldSide = seedSideRun(directory, 'biz-old-run');
  const relPath = runDataStore.sideDbRelPath(runDataStore.MODULE_BIZ_OP, '2026-05');
  const oldMirrorId = runData.upsertMainRunMirror(appDb.db, {
    date: '2026-05-22', buName: 'BU-A', relPath,
    stats: oldSide.stats, status: 'success', archiveTaskRunId: 'biz-old-run'
  });
  repository.transitionTaskRun('biz-old-run', 'succeeded');
  runs.acknowledgeArchiveTerminal(appDb.db, oldMirrorId, 'biz-old-run');
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(directory, runDataStore.MODULE_BIZ_OP, '2026-05')
  );
  try {
    runs.acknowledgeArchiveTerminal(sideDb, oldSide.runId, 'biz-old-run');
  } finally {
    sideDb.close();
  }
  seedSideRun(directory, 'biz-new-run');

  await runData.recoverRunReceipts({
    userDataDir: directory,
    mainDb: appDb.db,
    archiveService: archiveService(repository)
  });
  assert.equal(runs.listRunsByDateBu(appDb.db, '2026-05-22', 'BU-A').length, 1);
  assert.equal(
    runs.listRunsByDateBu(appDb.db, '2026-05-22', 'BU-A')[0].archive_task_run_id,
    'biz-new-run'
  );
  assert.equal(repository.getTaskRun('biz-new-run').status, 'succeeded');
});

test('Biz main seam 冻结三源与 export locator，owner 排在通用 sweep 前', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  assert.match(mainSource,
    /prepareRunLineage\(\{[\s\S]*?lineageIntents:\s*plan\.lineageIntents[\s\S]*?expectedDatasets:\s*plan\.expectedDatasets/);
  assert.match(mainSource,
    /runViaSideDb\(\{[\s\S]*?taskRunId:\s*taskContext\.operationContext\.taskRunId[\s\S]*?expectedDatasets:\s*prepared\.expectedDatasets/);
  assert.match(mainSource,
    /freezeRunLocator\(\{[\s\S]*?lineageIntents:\s*\[bizOpRunOutputIntent\(runLocator\)\]/);
  assert.match(mainSource,
    /freezeRangeRunSelection\(\{[\s\S]*?runLocators:\s*selection\.runLocators[\s\S]*?lineageIntents:\s*selection\.lineageIntents/);
  assert.match(mainSource,
    /buildFrozenRangeExportDb\(\{[\s\S]*?runLocators:\s*\[runLocator\]/);
  const ownerStart = mainSource.indexOf('recoverInterruptedTaskOwners: [');
  const ownerEnd = mainSource.indexOf('postOutboxStartupHooks:', ownerStart);
  const owners = mainSource.slice(ownerStart, ownerEnd);
  assert.ok(owners.indexOf("ownerName: 'Pending runs'") < owners.indexOf("ownerName: 'Biz OP runs'"));
  assert.match(mainSource, /return bizOpReconRunData\.finalizeRunTerminalIntent\(/);
  const runHandlerStart = mainSource.indexOf("trackedIpcHandle('bizOpRecon:run'");
  const runHandlerEnd = mainSource.indexOf("ipcMain.handle('bizOpRecon:export:list-success-dates'", runHandlerStart);
  assert.doesNotMatch(mainSource.slice(runHandlerStart, runHandlerEnd), /runLocator\s*}/);
  assert.match(mainSource.slice(runHandlerStart, runHandlerEnd),
    /preserveArchiveTaskRun[\s\S]*?finishTaskRun\([\s\S]*?taskStatus:\s*'interrupted'/);
});

test('Biz failed terminal outbox 无成功 receipt 时 finalizer no-op', () => {
  assert.equal(runData.finalizeRunTerminalIntent({
    route: { route: 'biz-op-run', taskRunId: 'biz-failed-task' },
    record: { payload: {} },
    terminalOutcome: { taskStatus: 'failed' },
    terminalResult: { taskRun: { status: 'failed' } },
    userDataDir: null,
    mainDb: null
  }), null);
});

test('Biz OP import 在同一 transaction 派生 version，并发覆盖使旧 snapshot fail-closed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-import-toctou-'));
  const dbPath = path.join(directory, 'biz.sqlite');
  const db = new DatabaseSync(dbPath);
  const concurrent = new DatabaseSync(dbPath);
  t.after(() => {
    concurrent.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureBizOpReconTablesSupport(db);
  ensureBizOpReconTablesSupport(concurrent);
  db.exec('PRAGMA journal_mode = WAL');
  concurrent.exec('PRAGMA journal_mode = WAL');
  datasetHeads.writeHead(db, {
    kind: 'op', dataDate: '2026-05-22', buName: 'BU-A',
    identity: identity('op-old', 'op-old-task')
  });
  const originalGetHead = datasetHeads.getHead;
  let raced = false;
  datasetHeads.getHead = (...args) => {
    const current = originalGetHead(...args);
    if (!raced && args[0] === db && args[1] === 'op') {
      raced = true;
      concurrent.exec('BEGIN');
      datasetHeads.writeHead(concurrent, {
        kind: 'op', dataDate: '2026-05-22', buName: 'BU-A',
        identity: identity('op-concurrent', 'op-concurrent-task', 2)
      });
      concurrent.exec('COMMIT');
    }
    return current;
  };
  t.after(() => { datasetHeads.getHead = originalGetHead; });
  const row = shared.makeBizOp({
    rowIndex: 2, bu: 'BU-A', account: 'ACC-1', begin: 0,
    amtIn: 100, amtOut: 0, end: 100, billDate: '2026-05-22'
  });
  await assert.rejects(session.runBizOpImportAsync(db, {
    date: '2026-05-22',
    filePath: '/tmp/biz.xlsx',
    readBizOpFile: () => ({ rows: [row] }),
    writeBizOpErrorReportXlsx: async () => { throw new Error('unexpected report'); },
    errorReportsDir: directory,
    datasetSeed: { datasetId: 'op-new', producerTaskRunId: 'op-new-task' }
  }), /locked|busy/i);
  assert.equal(originalGetHead(db, 'op', '2026-05-22', 'BU-A').datasetId, 'op-concurrent');
  assert.equal(imports.getRowsByDateBu(db, '2026-05-22', 'BU-A').length, 0);
});

test('Biz run 从 head 校验到三表读取/receipt 写入共享 snapshot，并发换 head 不落 run', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-run-toctou-'));
  const dbPath = path.join(directory, 'biz.sqlite');
  const db = new DatabaseSync(dbPath);
  const concurrent = new DatabaseSync(dbPath);
  t.after(() => {
    concurrent.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureBizOpReconTablesSupport(db);
  ensureBizOpReconTablesSupport(concurrent);
  db.exec('PRAGMA journal_mode = WAL');
  concurrent.exec('PRAGMA journal_mode = WAL');
  seedSources(db);
  const plan = lineage.bizOpRunLineagePlan(db, { date: '2026-05-22', buName: 'BU-A' });
  const originalRead = imports.getRowsByDateBu;
  let raced = false;
  imports.getRowsByDateBu = (...args) => {
    const rows = originalRead(...args);
    if (!raced && args[0] === db) {
      raced = true;
      concurrent.exec('BEGIN');
      datasetHeads.writeHead(concurrent, {
        kind: 'flow', dataDate: '2026-05-22',
        identity: identity('flow-concurrent', 'flow-concurrent-task', 2)
      });
      concurrent.exec('COMMIT');
    }
    return rows;
  };
  t.after(() => { imports.getRowsByDateBu = originalRead; });
  assert.throws(() => session.runReconciliation(db, {
    date: '2026-05-22',
    buName: 'BU-A',
    archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'biz-run-race' },
    expectedDatasets: plan.expectedDatasets
  }), /locked|busy/i);
  assert.equal(runs.getRunByArchiveTaskRunId(db, 'biz-run-race'), null);
  assert.equal(datasetHeads.getHead(db, 'flow', '2026-05-22').datasetId, 'flow-concurrent');
});
