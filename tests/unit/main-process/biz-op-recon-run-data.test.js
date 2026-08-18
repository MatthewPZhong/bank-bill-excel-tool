// v3.0.5 PR-4（Part B Phase 2）— biz-op-recon per-月侧库编排层单测
//   覆盖：runViaSideDb inline + 主库镜像 runId / 月末跨月补清+冗余副本 / 月初 T-2 跨月单库自洽 /
//   双源 status 去重冗余副本 / check-single-day 去重 / list-ready-dates 逐月合并 /
//   导出 openExportContextByRun 侧库 runId 映射 / 区间导出跨月内存合并 db / 孤儿兜底

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../src/backend/database');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const runDataStore = require('../../../src/backend/run-data-store');
const bizOpReconRunData = require('../../../src/main-process/biz-op-recon-run-data');
const session = require('../../../src/main-process/biz-op-recon-session');
const datasetHeads = require('../../../src/backend/biz-op-recon-db/dataset-head-repository');
const monthEndCopyIntents = require('../../../src/backend/biz-op-recon-db/month-end-copy-intent-repository');
const importsRepo = require('../../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../../src/backend/biz-op-recon-db/run-repository');
const shared = require('../../../scripts/integration/fixtures/biz-op-recon-side-db-parity/_shared');

const MODULE = runDataStore.MODULE_BIZ_OP;

let tmpdir;
let appDb;
let mainDb;
let userDataDir;
let taskSequence;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-rundata-test-'));
  userDataDir = tmpdir;
  appDb = new AppDatabase(path.join(tmpdir, 'tool-data.sqlite'));
  appDb.init();
  mainDb = appDb.db;
  taskSequence = 0;
});
test.afterEach(() => {
  try { mainDb.close(); } catch (_) { /* swallow */ }
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

// 直插侧库 imports/flow（建一个可对账的 (date,BU) 三件齐）。
function seedSide(monthKey, { date, t2Date, t1, t2, flow }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    if (t2 && t2.length) {
      importsRepo.insertRows(sideDb, t2Date, t2);
      datasetHeads.writeHead(sideDb, {
        kind: 'op', dataDate: t2Date, buName: t2[0].bu_name,
        identity: {
          datasetId: `${monthKey}:${t2Date}:op`, producerTaskRunId: `${monthKey}:t2-import`,
          datasetVersion: 1, archiveContractVersion: 1
        }
      });
    }
    if (t1 && t1.length) {
      importsRepo.insertRows(sideDb, date, t1);
      datasetHeads.writeHead(sideDb, {
        kind: 'op', dataDate: date, buName: t1[0].bu_name,
        identity: {
          datasetId: `${monthKey}:${date}:op`, producerTaskRunId: `${monthKey}:t1-import`,
          datasetVersion: 1, archiveContractVersion: 1
        }
      });
    }
    if (flow && flow.length) {
      flowRepo.insertRows(sideDb, date, flow);
      datasetHeads.writeHead(sideDb, {
        kind: 'flow', dataDate: date,
        identity: {
          datasetId: `${monthKey}:${date}:flow`, producerTaskRunId: `${monthKey}:flow-import`,
          datasetVersion: 1, archiveContractVersion: 1
        }
      });
    }
  } finally {
    sideDb.close();
  }
}

function runCurrent({ date, buName }) {
  const plan = bizOpReconRunData.prepareRunLineage({ userDataDir, date, buName });
  taskSequence += 1;
  return bizOpReconRunData.runViaSideDb({
    userDataDir,
    mainDb,
    date,
    buName,
    taskRunId: `biz-run-task-${taskSequence}`,
    expectedDatasets: plan.expectedDatasets
  });
}

function dumpSideOverwriteState(db) {
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

async function createRunningBizOpImportFileTask(taskRunId, inputPath) {
  const rootDir = path.join(userDataDir, 'archive-root');
  const service = createArchiveService({ database: mainDb, rootDir });
  await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const taskRun = (await service.beginTaskRun({
    taskRunId,
    moduleId: 'biz-op-recon',
    taskKey: 'bizOpRecon:import:run-biz-op',
    operationKey: `bizOpRecon:import:run-biz-op:${taskRunId}`,
    parentRunId: `biz-op-import:${taskRunId}`
  })).taskRun;
  const manifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: inputPath,
      role: 'input',
      sourceOperation: 'bizOpRecon:import:run-biz-op'
    }],
    outputs: []
  }));
  const reserved = await service.reserveFileTaskBatch({
    taskRun,
    manifest,
    moduleCode: 'BIZOP',
    moduleName: '业务OP数据核对'
  });
  const batchContext = {
    batchId: reserved.batch.id,
    batchNumber: reserved.batch.batchNumber,
    taskRunId: taskRun.taskRunId,
    taskKey: taskRun.taskKey,
    moduleId: taskRun.moduleId,
    parentRunId: taskRun.parentRunId,
    operationKey: taskRun.operationKey
  };
  await service.startFileTask(taskRunId, reserved.batch.id);
  return { batchContext, manifest, reserved, rootDir, service, taskRun };
}

test('monthOf：date → YYYY-MM', () => {
  assert.equal(bizOpReconRunData.monthOf('2026-03-15'), '2026-03');
  assert.equal(bizOpReconRunData.monthOf('2026-12-31'), '2026-12');
});

test('runViaSideDb inline + 主库镜像 runId 唯一（跨月）+ 主库 4 表 0 行', () => {
  const fx3 = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx3);
  seedSide('2026-05', fx5);
  const r3 = runCurrent({ date: '2026-03-15', buName: 'BU-A' });
  const r5 = runCurrent({ date: '2026-05-15', buName: 'BU-A' });
  // 两月侧库各自 run id=1，主库镜像 id 递增 → runId 不同。
  assert.notEqual(r3.runId, r5.runId, '跨月 runId 不同（主库镜像 id）');
  // 主库 4 表 0 行。
  for (const t of ['biz_op_recon_imports', 'biz_op_recon_flow_imports', 'biz_op_recon_diff_rows']) {
    assert.equal(mainDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, `主库 ${t} 0 行`);
  }
  // 主库镜像 side_db_rel_path 指向各月。
  const m3 = runRepo.getRunById(mainDb, r3.runId);
  assert.ok(m3.side_db_rel_path.includes('month-2026-03'), 'r3 镜像指向 3 月侧库');
});

test('导出 openExportContextByRun：主库镜像 runId → 侧库内 run id 映射', () => {
  const fx = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx);
  seedSide('2026-05', fx5);
  runCurrent({ date: '2026-03-15', buName: 'BU-A' });
  const r5 = runCurrent({ date: '2026-05-15', buName: 'BU-A' });
  // r5 主库镜像 id=2，但 5 月侧库内 run id=1 → exportRunId 必须是侧库 id（能查到 diff）。
  const ctx = bizOpReconRunData.openExportContextByRun({ userDataDir, mainDb, runId: r5.runId });
  try {
    assert.equal(ctx.run.data_date, '2026-05-15', '主库镜像 date');
    const diff = runRepo.getDiffRowsByRun(ctx.db, ctx.exportRunId);
    assert.ok(diff.length > 0, 'exportRunId 能查到侧库 diff_rows（runId 映射正确）');
  } finally {
    if (ctx.sideDb) ctx.sideDb.close();
  }
});

test('🔴 codex P2：buildRangeExportDb date-range 跨月导出不抛（SIDE_DB_DDL_BIZ_OP 已导出）+ 4 表建表 + 跨月合并', () => {
  const fx3 = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  const fx5 = shared.buildSingleDayFixture('2026-05-15', '2026-05-14', 'BU-A');
  seedSide('2026-03', fx3);
  seedSide('2026-05', fx5);
  runCurrent({ date: '2026-03-15', buName: 'BU-A' });
  runCurrent({ date: '2026-05-15', buName: 'BU-A' });
  // 修复前：memDb.exec(runDataStore.SIDE_DB_DDL_BIZ_OP) 中常量未导出 = undefined → exec 抛错。
  let memDb;
  assert.doesNotThrow(() => {
    memDb = bizOpReconRunData.buildRangeExportDb({
      userDataDir, mainDb, buName: 'BU-A', startDate: '2026-03-01', endDate: '2026-05-31'
    });
  }, 'date-range 导出不应抛（SIDE_DB_DDL_BIZ_OP undefined 回归）');
  try {
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_runs').all(), 'runs 表建表成功');
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_diff_rows').all(), 'diff_rows 表建表成功');
    assert.doesNotThrow(() => memDb.prepare('SELECT * FROM biz_op_recon_imports').all(), 'imports 表建表成功');
    const runCount = memDb.prepare('SELECT COUNT(*) c FROM biz_op_recon_runs').get().c;
    assert.equal(runCount, 2, '跨月 2 个 run（3月+5月）合并进内存导出库');
  } finally {
    if (memDb) memDb.close();
  }
});

test('frozen single/range locator 缺 exact source row 时 fail-closed，不生成静默少行数据', () => {
  const fx = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  seedSide('2026-03', fx);
  const current = runCurrent({ date: '2026-03-15', buName: 'BU-A' });
  const locator = bizOpReconRunData.freezeRunLocator({
    userDataDir,
    mainDb,
    runId: current.runId
  });
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-03');
  try {
    const diff = runRepo.getDiffRowsByRun(sideDb, locator.sideRunId)[0];
    assert.ok(diff && diff.source_row_id);
    sideDb.prepare('DELETE FROM biz_op_recon_imports WHERE id = ?').run(diff.source_row_id);
  } finally {
    sideDb.close();
  }
  assert.throws(() => bizOpReconRunData.buildFrozenRangeExportDb({
    userDataDir,
    mainDb,
    runLocators: [locator]
  }), /缺少 source row/);
});

test('月末跨月：runBizOpImport（mock worker success）→ 下月侧库写 T-2 冗余副本', async () => {
  const D = '2026-06-30';
  const monthKey = '2026-06';
  const nextMonth = '2026-07';
  // 6 月侧库放 D 的 imports（模拟 worker 已导入到 month(D)）。
  const dRow = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'ACCX', begin: 0, amtIn: 100, amtOut: 0, end: 100, billDate: D });
  const curSide = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try { importsRepo.insertRows(curSide, D, [dRow]); } finally { curSide.close(); }
  // mock worker：返回 success + buName，触发编排层月末跨月补清/冗余。
  const mockWorker = async (db, { datasetSeed, monthEndCopyPlan }) => {
    db.exec('BEGIN');
    try {
      session.assertNoPendingMonthEndCopy(db, D, 'BU-C');
      const identity = datasetHeads.nextDatasetIdentity(
        null,
        datasetSeed.producerTaskRunId,
        () => datasetSeed.datasetId
      );
      session.assertBizOpMonthEndAdmission(monthEndCopyPlan, 'BU-C');
      datasetHeads.writeHead(db, {
        kind: 'op', dataDate: D, buName: 'BU-C', identity
      });
      session.recordMonthEndCopyIntent(db, monthEndCopyPlan, D, 'BU-C', identity);
      db.exec('COMMIT');
      return { status: 'success', buName: 'BU-C', validCount: 1 };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const res = await bizOpReconRunData.runBizOpImport({
    userDataDir, runBizOpImportViaWorker: mockWorker,
    params: { date: D, filePath: 'x.xlsx', batchContext: { taskRunId: 'biz-import-task' } }
  });
  assert.equal(res.status, 'success');
  const sourceAfterCopy = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    const sourceHead = datasetHeads.getHead(sourceAfterCopy, 'op', D, 'BU-C');
    const intent = monthEndCopyIntents.getByTaskRunId(sourceAfterCopy, 'biz-import-task');
    assert.equal(intent.datasetId, sourceHead.datasetId);
    assert.equal(intent.producerTaskRunId, 'biz-import-task');
  } finally {
    sourceAfterCopy.close();
  }
  // 下月侧库含 D 的 T-2 冗余副本。
  const nextSide = runDataStore.openSideDb(userDataDir, MODULE, nextMonth);
  try {
    const copy = importsRepo.getRowsByDateBu(nextSide, D, 'BU-C');
    assert.equal(copy.length, 1, '下月侧库含 D 冗余副本');
    assert.equal(copy[0].account_no, 'ACCX', '副本账户号');
  } finally {
    nextSide.close();
  }
  assert.deepEqual(bizOpReconRunData.acknowledgeMonthEndCopyIntent({
    userDataDir,
    dataDate: D,
    sourceTaskRunId: 'biz-import-task'
  }), { removed: 1 });
  const sourceAfterTerminal = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    assert.equal(monthEndCopyIntents.getByTaskRunId(sourceAfterTerminal, 'biz-import-task'), null);
  } finally {
    sourceAfterTerminal.close();
  }
});

test('月末下月侧库有未 ACK receipt 时补清事务零变化', async () => {
  const D = '2026-06-30';
  const nextDate = '2026-07-01';
  const monthKey = '2026-06';
  const nextMonth = '2026-07';
  const currentRow = shared.makeBizOp({
    rowIndex: 2, bu: 'BU-C', account: 'ACC-NEW', begin: 0,
    amtIn: 100, amtOut: 0, end: 100, billDate: D
  });
  const currentSide = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  let currentBefore;
  try {
    importsRepo.insertRows(currentSide, D, [shared.makeBizOp({
      rowIndex: 2, bu: 'BU-C', account: 'ACC-CURRENT-OLD', begin: 0,
      amtIn: 3, amtOut: 0, end: 3, billDate: D
    })]);
    datasetHeads.writeHead(currentSide, {
      kind: 'op', dataDate: D, buName: 'BU-C',
      identity: {
        datasetId: 'current-side-old', producerTaskRunId: 'current-side-old-task',
        datasetVersion: 1, archiveContractVersion: 1
      }
    });
    const currentRunId = runRepo.insertArchiveRun(currentSide, {
      date: D,
      buName: 'BU-C',
      archiveTaskRunId: 'current-side-acked-run',
      stats: {
        t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 1,
        multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
        t1NotT2Count: 0, t2NotT1Count: 0
      }
    });
    runRepo.insertDiffRows(currentSide, currentRunId, D, 'BU-C', [
      { source_table: 'imports', source_row_id: 1, multi_op_flag: 'N' }
    ]);
    runRepo.acknowledgeArchiveTerminal(currentSide, currentRunId, 'current-side-acked-run');
    currentBefore = dumpSideOverwriteState(currentSide);
  } finally {
    currentSide.close();
  }

  const nextSide = runDataStore.openSideDb(userDataDir, MODULE, nextMonth);
  let before;
  try {
    importsRepo.insertRows(nextSide, D, [shared.makeBizOp({
      rowIndex: 2, bu: 'BU-C', account: 'ACC-OLD', begin: 0,
      amtIn: 1, amtOut: 0, end: 1, billDate: D
    })]);
    importsRepo.insertRows(nextSide, nextDate, [shared.makeBizOp({
      rowIndex: 2, bu: 'BU-C', account: 'ACC-NEXT', begin: 1,
      amtIn: 1, amtOut: 0, end: 2, billDate: nextDate
    })]);
    datasetHeads.writeHead(nextSide, {
      kind: 'op', dataDate: D, buName: 'BU-C',
      identity: {
        datasetId: 'next-side-old', producerTaskRunId: 'next-side-old-task',
        datasetVersion: 1, archiveContractVersion: 1
      }
    });
    datasetHeads.writeHead(nextSide, {
      kind: 'op', dataDate: nextDate, buName: 'BU-C',
      identity: {
        datasetId: 'next-side-next-date', producerTaskRunId: 'next-side-next-task',
        datasetVersion: 1, archiveContractVersion: 1
      }
    });
    const runId = runRepo.insertArchiveRun(nextSide, {
      date: D,
      buName: 'BU-C',
      archiveTaskRunId: 'next-side-pending-run',
      stats: {
        t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 1,
        multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
        t1NotT2Count: 0, t2NotT1Count: 0
      }
    });
    runRepo.insertDiffRows(nextSide, runId, D, 'BU-C', [
      { source_table: 'imports', source_row_id: 1, multi_op_flag: 'N' }
    ]);
    before = dumpSideOverwriteState(nextSide);
  } finally {
    nextSide.close();
  }

  const mockWorker = async (db, { datasetSeed, monthEndCopyPlan }) => {
    db.exec('BEGIN');
    try {
      session.assertNoPendingMonthEndCopy(db, D, 'BU-C');
      runRepo.clearRunsAndDiffsByDateBu(db, D, 'BU-C');
      runRepo.clearRunsAndDiffsByDateBu(db, nextDate, 'BU-C');
      importsRepo.clearByDateBu(db, D, 'BU-C');
      importsRepo.insertRows(db, D, [currentRow]);
      session.assertBizOpMonthEndAdmission(monthEndCopyPlan, 'BU-C');
      const identity = datasetHeads.nextDatasetIdentity(
        datasetHeads.getHead(db, 'op', D, 'BU-C'),
        datasetSeed.producerTaskRunId,
        () => datasetSeed.datasetId
      );
      datasetHeads.writeHead(db, {
        kind: 'op', dataDate: D, buName: 'BU-C',
        identity
      });
      session.recordMonthEndCopyIntent(db, monthEndCopyPlan, D, 'BU-C', identity);
      db.exec('COMMIT');
      return { status: 'success', buName: 'BU-C', validCount: 1 };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  await assert.rejects(bizOpReconRunData.runBizOpImport({
    userDataDir,
    runBizOpImportViaWorker: mockWorker,
    params: { date: D, filePath: 'x.xlsx', batchContext: { taskRunId: 'biz-import-task' } }
  }), /未 ACK/);

  const verifyCurrent = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    assert.deepEqual(dumpSideOverwriteState(verifyCurrent), currentBefore);
  } finally {
    verifyCurrent.close();
  }
  const verifySide = runDataStore.openSideDb(userDataDir, MODULE, nextMonth);
  try {
    assert.deepEqual(dumpSideOverwriteState(verifySide), before);
  } finally {
    verifySide.close();
  }
});

test('月末 source COMMIT 后崩溃由原 File Task/批次号恢复 target copy 并清 intent', async () => {
  const date = '2026-06-30';
  const nextDate = '2026-07-01';
  const taskRunId = 'biz-month-end-crash-task';
  const inputPath = path.join(tmpdir, 'biz-month-end-crash.xlsx');
  fs.writeFileSync(inputPath, 'frozen archive evidence');
  const originalOwner = await createRunningBizOpImportFileTask(taskRunId, inputPath);
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try {
    const imported = await session.runBizOpImportAsync(sourceDb, {
      date,
      filePath: inputPath,
      readBizOpFile: () => ({
        rows: [shared.makeBizOp({
          rowIndex: 2,
          bu: 'BU-R',
          account: 'ACC-RECOVERY',
          begin: 0,
          amtIn: 88,
          amtOut: 0,
          end: 88,
          billDate: date
        })]
      }),
      writeBizOpErrorReportXlsx: async () => { throw new Error('unexpected report'); },
      errorReportsDir: tmpdir,
      datasetSeed: { datasetId: 'biz-month-end-recovery-dataset', producerTaskRunId: taskRunId },
      monthEndCopyPlan: {
        targetDbPath: runDataStore.sideDbPath(userDataDir, MODULE, '2026-07'),
        targetMonth: '2026-07',
        dataDate: date,
        nextDate
      }
    });
    assert.equal(imported.status, 'success');
    assert.equal(monthEndCopyIntents.getByTaskRunId(sourceDb, taskRunId).datasetId,
      'biz-month-end-recovery-dataset');
  } finally {
    sourceDb.close();
  }
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-07'), false);
  const sequenceBefore = mainDb.prepare(`
    SELECT local_date, last_sequence, last_issued_batch_id, last_issued_batch_number
    FROM archive_daily_sequences
  `).all();

  const restarted = createArchiveService({ database: mainDb, rootDir: originalOwner.rootDir });
  await restarted.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  assert.equal(restarted.repository.getTaskRun(taskRunId).status, 'running');
  assert.deepEqual(await bizOpReconRunData.recoverMonthEndCopyIntents({
    userDataDir,
    archiveService: restarted
  }), { recovered: 1 });

  const recoveredTask = restarted.repository.getTaskRun(taskRunId);
  const recoveredBatch = restarted.repository.getBatch(originalOwner.reserved.batch.id);
  assert.equal(recoveredTask.status, 'succeeded');
  assert.equal(recoveredBatch.taskStatus, 'succeeded');
  assert.equal(recoveredBatch.id, originalOwner.reserved.batch.id);
  assert.equal(recoveredBatch.batchNumber, originalOwner.reserved.batch.batchNumber);
  assert.deepEqual(mainDb.prepare(`
    SELECT local_date, last_sequence, last_issued_batch_id, last_issued_batch_number
    FROM archive_daily_sequences
  `).all(), sequenceBefore, '恢复不得发新批次号');
  assert.equal(restarted.repository.listArtifacts(recoveredBatch.id)[0].status, 'ready');

  const targetDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try {
    const copiedRows = importsRepo.getRowsByDateBu(targetDb, date, 'BU-R');
    assert.equal(copiedRows.length, 1);
    assert.equal(copiedRows[0].account_no, 'ACC-RECOVERY');
    assert.equal(datasetHeads.getHead(targetDb, 'op', date, 'BU-R').datasetId,
      'biz-month-end-recovery-dataset');
  } finally {
    targetDb.close();
  }
  const sourceAfterRecovery = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try {
    assert.equal(monthEndCopyIntents.getByTaskRunId(sourceAfterRecovery, taskRunId), null);
  } finally {
    sourceAfterRecovery.close();
  }
  const targetBeforeSucceededReplay = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  let succeededTargetState;
  try {
    succeededTargetState = dumpSideOverwriteState(targetBeforeSucceededReplay);
  } finally {
    targetBeforeSucceededReplay.close();
  }
  const sourceForSucceededReplay = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try {
    const head = datasetHeads.getHead(sourceForSucceededReplay, 'op', date, 'BU-R');
    monthEndCopyIntents.create(sourceForSucceededReplay, {
      sourceTaskRunId: taskRunId,
      dataDate: date,
      normalizedBu: 'bu-r',
      datasetId: head.datasetId,
      datasetVersion: head.datasetVersion,
      producerTaskRunId: head.producerTaskRunId,
      targetMonth: '2026-07'
    });
  } finally {
    sourceForSucceededReplay.close();
  }
  assert.deepEqual(await bizOpReconRunData.recoverMonthEndCopyIntents({
    userDataDir,
    archiveService: restarted
  }), { recovered: 1 }, 'terminal 后删除 intent 前崩溃只核对 target 并清 intent');
  const targetAfterSucceededReplay = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try {
    assert.deepEqual(dumpSideOverwriteState(targetAfterSucceededReplay), succeededTargetState);
  } finally {
    targetAfterSucceededReplay.close();
  }
  assert.deepEqual(mainDb.prepare(`
    SELECT local_date, last_sequence, last_issued_batch_id, last_issued_batch_number
    FROM archive_daily_sequences
  `).all(), sequenceBefore);
  assert.deepEqual(await bizOpReconRunData.recoverMonthEndCopyIntents({
    userDataDir,
    archiveService: restarted
  }), { recovered: 0 });
});

test('月末 worker 已提交 source+intent 但 success 回执丢失时保留 File Task owner', async () => {
  const date = '2026-10-31';
  const taskRunId = 'biz-month-end-worker-receipt-lost';
  const mockWorker = async (db, { datasetSeed, monthEndCopyPlan }) => {
    db.exec('BEGIN');
    try {
      importsRepo.insertRows(db, date, [shared.makeBizOp({
        rowIndex: 2,
        bu: 'BU-WORKER',
        account: 'SOURCE-COMMITTED',
        begin: 0,
        amtIn: 12,
        amtOut: 0,
        end: 12,
        billDate: date
      })]);
      const identity = datasetHeads.nextDatasetIdentity(
        null,
        datasetSeed.producerTaskRunId,
        () => datasetSeed.datasetId
      );
      datasetHeads.writeHead(db, {
        kind: 'op', dataDate: date, buName: 'BU-WORKER', identity
      });
      session.recordMonthEndCopyIntent(
        db,
        monthEndCopyPlan,
        date,
        'BU-WORKER',
        identity
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const error = new Error('worker exited before complete receipt');
    error.code = 'WORKER_EXITED';
    throw error;
  };

  await assert.rejects(bizOpReconRunData.runBizOpImport({
    userDataDir,
    runBizOpImportViaWorker: mockWorker,
    params: {
      date,
      filePath: 'worker-receipt-lost.xlsx',
      batchContext: { taskRunId }
    }
  }), (error) => {
    assert.equal(error.code, 'WORKER_EXITED');
    assert.equal(error.preserveArchiveFileTask, true);
    return true;
  });
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-10');
  try {
    assert.equal(monthEndCopyIntents.getByTaskRunId(sourceDb, taskRunId).targetMonth, '2026-11');
  } finally {
    sourceDb.close();
  }
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-11'), false);
});

test('月末 copy 失败形成 interrupted owner 后仍以原 File Batch 恢复', async () => {
  const date = '2026-12-31';
  const nextDate = '2027-01-01';
  const taskRunId = 'biz-month-end-interrupted-owner';
  const inputPath = path.join(tmpdir, 'biz-month-end-interrupted.xlsx');
  fs.writeFileSync(inputPath, 'interrupted archive evidence');
  const owner = await createRunningBizOpImportFileTask(taskRunId, inputPath);
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-12');
  try {
    await session.runBizOpImportAsync(sourceDb, {
      date,
      filePath: inputPath,
      readBizOpFile: () => ({ rows: [shared.makeBizOp({
        rowIndex: 2,
        bu: 'BU-INTERRUPTED',
        account: 'SOURCE-INTERRUPTED',
        begin: 0,
        amtIn: 31,
        amtOut: 0,
        end: 31,
        billDate: date
      })] }),
      writeBizOpErrorReportXlsx: async () => { throw new Error('unexpected report'); },
      errorReportsDir: tmpdir,
      datasetSeed: { datasetId: 'interrupted-copy-dataset', producerTaskRunId: taskRunId },
      monthEndCopyPlan: {
        targetDbPath: runDataStore.sideDbPath(userDataDir, MODULE, '2027-01'),
        targetMonth: '2027-01',
        dataDate: date,
        nextDate
      }
    });
  } finally {
    sourceDb.close();
  }
  const targetDb = runDataStore.openSideDb(userDataDir, MODULE, '2027-01');
  let targetRunId;
  try {
    targetRunId = runRepo.insertArchiveRun(targetDb, {
      date,
      buName: 'BU-INTERRUPTED',
      archiveTaskRunId: 'target-owner-before-copy',
      stats: {
        t1OpTotal: 1,
        t2OpTotal: 1,
        flowTotal: 1,
        amountDiffCount: 0,
        multiOpAccountCount: 0,
        t2AnomalyAccountCount: 0,
        t1NotT2Count: 0,
        t2NotT1Count: 0
      }
    });
  } finally {
    targetDb.close();
  }
  assert.throws(() => bizOpReconRunData.applyMonthEndCopyIntent({
    userDataDir,
    sourceMonth: '2026-12',
    sourceTaskRunId: taskRunId
  }), /未 ACK/);
  const settled = await owner.service.settleManifestArtifacts({
    batchContext: owner.batchContext,
    files: [{ artifactKey: owner.manifest.inputs[0].artifactKey }]
  });
  assert.equal(settled.durable, true);
  const interrupted = await owner.service.finishFileTask(
    taskRunId,
    owner.reserved.batch.id,
    {
      taskStatus: 'interrupted',
      code: 'ARCHIVE_TASK_INTERRUPTED',
      message: 'target receipt pending'
    }
  );
  assert.equal(interrupted.ok, true);
  assert.equal(interrupted.taskRun.status, 'interrupted');
  const targetForAck = runDataStore.openSideDb(userDataDir, MODULE, '2027-01');
  try {
    runRepo.acknowledgeArchiveTerminal(targetForAck, targetRunId, 'target-owner-before-copy');
  } finally {
    targetForAck.close();
  }
  const sequenceBefore = mainDb.prepare(`
    SELECT local_date, last_sequence, last_issued_batch_id, last_issued_batch_number
    FROM archive_daily_sequences
  `).all();

  const restarted = createArchiveService({ database: mainDb, rootDir: owner.rootDir });
  await restarted.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  assert.deepEqual(await bizOpReconRunData.recoverMonthEndCopyIntents({
    userDataDir,
    archiveService: restarted
  }), { recovered: 1 });
  const recoveredBatch = restarted.repository.getBatch(owner.reserved.batch.id);
  assert.equal(recoveredBatch.batchNumber, owner.reserved.batch.batchNumber);
  assert.equal(recoveredBatch.taskStatus, 'succeeded');
  assert.equal(restarted.repository.getTaskRun(taskRunId).status, 'succeeded');
  assert.deepEqual(mainDb.prepare(`
    SELECT local_date, last_sequence, last_issued_batch_id, last_issued_batch_number
    FROM archive_daily_sequences
  `).all(), sequenceBefore);
});

test('月末 source precheck 后并发出现未 ACK receipt 时保留 intent，阻断覆盖与 D+1 run', async () => {
  const date = '2026-06-30';
  const nextDate = '2026-07-01';
  const taskRunId = 'biz-month-end-race-task';
  const targetMonth = '2026-07';
  const targetDb = runDataStore.openSideDb(userDataDir, MODULE, targetMonth);
  try {
    importsRepo.insertRows(targetDb, date, [shared.makeBizOp({
      rowIndex: 2,
      bu: 'BU-RACE',
      account: 'TARGET-OLD',
      begin: 0,
      amtIn: 5,
      amtOut: 0,
      end: 5,
      billDate: date
    })]);
    datasetHeads.writeHead(targetDb, {
      kind: 'op',
      dataDate: date,
      buName: 'BU-RACE',
      identity: {
        datasetId: 'target-old-dataset',
        datasetVersion: 1,
        producerTaskRunId: 'target-old-task',
        archiveContractVersion: 1
      }
    });
  } finally {
    targetDb.close();
  }

  let targetBeforeCopy;
  const currentRow = shared.makeBizOp({
    rowIndex: 2,
    bu: 'BU-RACE',
    account: 'SOURCE-NEW',
    begin: 0,
    amtIn: 20,
    amtOut: 0,
    end: 20,
    billDate: date
  });
  const mockWorker = async (db, { datasetSeed, monthEndCopyPlan }) => {
    db.exec('BEGIN');
    try {
      session.assertNoPendingMonthEndCopy(db, date, 'BU-RACE');
      importsRepo.clearByDateBu(db, date, 'BU-RACE');
      importsRepo.insertRows(db, date, [currentRow]);
      session.assertBizOpMonthEndAdmission(monthEndCopyPlan, 'BU-RACE');
      const identity = datasetHeads.nextDatasetIdentity(
        datasetHeads.getHead(db, 'op', date, 'BU-RACE'),
        datasetSeed.producerTaskRunId,
        () => datasetSeed.datasetId
      );
      datasetHeads.writeHead(db, {
        kind: 'op', dataDate: date, buName: 'BU-RACE', identity
      });
      session.recordMonthEndCopyIntent(db, monthEndCopyPlan, date, 'BU-RACE', identity);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const concurrentTarget = runDataStore.openSideDb(userDataDir, MODULE, targetMonth);
    try {
      runRepo.insertArchiveRun(concurrentTarget, {
        date,
        buName: 'BU-RACE',
        archiveTaskRunId: 'concurrent-target-run',
        stats: {
          t1OpTotal: 1,
          t2OpTotal: 1,
          flowTotal: 1,
          amountDiffCount: 1,
          multiOpAccountCount: 0,
          t2AnomalyAccountCount: 0,
          t1NotT2Count: 0,
          t2NotT1Count: 0
        }
      });
      targetBeforeCopy = dumpSideOverwriteState(concurrentTarget);
    } finally {
      concurrentTarget.close();
    }
    return { status: 'success', buName: 'BU-RACE', validCount: 1 };
  };

  await assert.rejects(bizOpReconRunData.runBizOpImport({
    userDataDir,
    runBizOpImportViaWorker: mockWorker,
    params: {
      date,
      filePath: 'race.xlsx',
      batchContext: { taskRunId }
    }
  }), (error) => {
    assert.equal(error.preserveArchiveFileTask, true);
    assert.match(error.message, /未 ACK/);
    return true;
  });

  const targetAfterFailure = runDataStore.openSideDb(userDataDir, MODULE, targetMonth);
  try {
    assert.deepEqual(dumpSideOverwriteState(targetAfterFailure), targetBeforeCopy);
  } finally {
    targetAfterFailure.close();
  }

  const sourceAfterFailure = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try {
    const pendingIntent = monthEndCopyIntents.getByTaskRunId(sourceAfterFailure, taskRunId);
    assert.ok(pendingIntent.datasetId);
    assert.equal(pendingIntent.producerTaskRunId, taskRunId);
    const sourceBeforeOverwrite = dumpSideOverwriteState(sourceAfterFailure);
    await assert.rejects(session.runBizOpImportAsync(sourceAfterFailure, {
      date,
      filePath: 'replacement.xlsx',
      readBizOpFile: () => ({ rows: [{ ...currentRow, account_no: 'SOURCE-REPLACEMENT' }] }),
      writeBizOpErrorReportXlsx: async () => { throw new Error('unexpected report'); },
      errorReportsDir: tmpdir,
      datasetSeed: { datasetId: 'replacement-dataset', producerTaskRunId: 'replacement-task' },
      monthEndCopyPlan: {
        targetDbPath: runDataStore.sideDbPath(userDataDir, MODULE, targetMonth),
        targetMonth,
        dataDate: date,
        nextDate
      }
    }), (error) => error.code === 'BIZ_OP_MONTH_END_COPY_PENDING');
    assert.deepEqual(dumpSideOverwriteState(sourceAfterFailure), sourceBeforeOverwrite);
    assert.deepEqual(monthEndCopyIntents.getByTaskRunId(sourceAfterFailure, taskRunId), pendingIntent);
  } finally {
    sourceAfterFailure.close();
  }
  assert.throws(() => bizOpReconRunData.prepareRunLineage({
    userDataDir,
    date: nextDate,
    buName: 'BU-RACE'
  }), (error) => error.code === 'BIZ_OP_MONTH_END_COPY_PENDING');
});

test('月末 target SQLite 写失败时回滚目标库并保留 source copy intent', async (t) => {
  const date = '2026-08-31';
  const nextDate = '2026-09-01';
  const taskRunId = 'biz-month-end-target-failure';
  const targetMonth = '2026-09';
  const targetDb = runDataStore.openSideDb(userDataDir, MODULE, targetMonth);
  let targetBefore;
  try {
    importsRepo.insertRows(targetDb, date, [shared.makeBizOp({
      rowIndex: 2,
      bu: 'BU-EIO',
      account: 'TARGET-UNCHANGED',
      begin: 0,
      amtIn: 7,
      amtOut: 0,
      end: 7,
      billDate: date
    })]);
    datasetHeads.writeHead(targetDb, {
      kind: 'op',
      dataDate: date,
      buName: 'BU-EIO',
      identity: {
        datasetId: 'target-before-eio',
        datasetVersion: 1,
        producerTaskRunId: 'target-before-eio-task',
        archiveContractVersion: 1
      }
    });
    targetBefore = dumpSideOverwriteState(targetDb);
  } finally {
    targetDb.close();
  }

  const originalInsertRows = importsRepo.insertRows;
  t.after(() => { importsRepo.insertRows = originalInsertRows; });
  const mockWorker = async (db, { datasetSeed, monthEndCopyPlan }) => {
    db.exec('BEGIN');
    try {
      const row = shared.makeBizOp({
        rowIndex: 2,
        bu: 'BU-EIO',
        account: 'SOURCE-EIO',
        begin: 0,
        amtIn: 11,
        amtOut: 0,
        end: 11,
        billDate: date
      });
      originalInsertRows(db, date, [row]);
      session.assertBizOpMonthEndAdmission(monthEndCopyPlan, 'BU-EIO');
      const identity = datasetHeads.nextDatasetIdentity(
        null,
        datasetSeed.producerTaskRunId,
        () => datasetSeed.datasetId
      );
      datasetHeads.writeHead(db, {
        kind: 'op', dataDate: date, buName: 'BU-EIO', identity
      });
      session.recordMonthEndCopyIntent(db, monthEndCopyPlan, date, 'BU-EIO', identity);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    importsRepo.insertRows = () => {
      const error = new Error('injected target SQLite write failure');
      error.code = 'SQLITE_IOERR';
      throw error;
    };
    return { status: 'success', buName: 'BU-EIO', validCount: 1 };
  };

  try {
    await assert.rejects(bizOpReconRunData.runBizOpImport({
      userDataDir,
      runBizOpImportViaWorker: mockWorker,
      params: {
        date,
        filePath: 'target-eio.xlsx',
        batchContext: { taskRunId }
      }
    }), (error) => {
      assert.equal(error.code, 'SQLITE_IOERR');
      assert.equal(error.preserveArchiveFileTask, true);
      return true;
    });
  } finally {
    importsRepo.insertRows = originalInsertRows;
  }

  const targetAfter = runDataStore.openSideDb(userDataDir, MODULE, targetMonth);
  try {
    assert.deepEqual(dumpSideOverwriteState(targetAfter), targetBefore);
  } finally {
    targetAfter.close();
  }
  const sourceAfter = runDataStore.openSideDb(userDataDir, MODULE, '2026-08');
  try {
    assert.equal(
      monthEndCopyIntents.getByTaskRunId(sourceAfter, taskRunId).producerTaskRunId,
      taskRunId
    );
  } finally {
    sourceAfter.close();
  }
});

test('月末导入 rejected → 不补清不冗余（未改数据）', async () => {
  const D = '2026-06-30';
  const nextMonth = '2026-07';
  const mockWorker = async () => ({ status: 'rejected', errorReportPath: null, errorRows: [] });
  await bizOpReconRunData.runBizOpImport({
    userDataDir, runBizOpImportViaWorker: mockWorker,
    params: { date: D, filePath: 'x.xlsx', batchContext: { taskRunId: 'biz-import-task' } }
  });
  // 下月侧库不应被建（无冗余写入）。注意 runBizOpImport 会 ensureSideDbExists(month(D))，但不碰下月。
  assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, nextMonth), false, 'rejected 不建下月侧库');
});

test('月初对账单库自洽：T-2 冗余副本在当月侧库 → 对账读到 T-2', () => {
  const monthEnd = '2026-08-31';
  const monthStart = '2026-09-01';
  const sepMonth = '2026-09';
  const t2Row = shared.makeBizOp({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', begin: 0, amtIn: 1000, amtOut: 0, end: 1000, billDate: monthEnd });
  const t1Row = shared.makeBizOp({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', begin: 1000, amtIn: 50, amtOut: 0, end: 1050, billDate: monthStart });
  const flowRow = shared.makeFlow({ rowIndex: 2, bu: 'BU-D', account: 'ACCY', direction: '入', amount: 50 });
  const sep = runDataStore.openSideDb(userDataDir, MODULE, sepMonth);
  try {
    importsRepo.insertRows(sep, monthEnd, [t2Row]);   // 冗余 T-2
    importsRepo.insertRows(sep, monthStart, [t1Row]);
    flowRepo.insertRows(sep, monthStart, [flowRow]);
  } finally { sep.close(); }
  const plan = bizOpReconRunData.prepareRunLineage({ userDataDir, date: monthStart, buName: 'BU-D' });
  const r = bizOpReconRunData.runViaSideDb({
    userDataDir, mainDb, date: monthStart, buName: 'BU-D',
    taskRunId: 'biz-month-start-run', expectedDatasets: plan.expectedDatasets
  });
  assert.equal(r.stats.t2OpTotal, 1, '读到 T-2 冗余副本');
  assert.equal(r.stats.amountDiffCount, 0, 'T-2 副本正确参与计算 → 无差异');
});

test('双源 status：去重月末冗余副本（同 date|bu 不翻倍）', () => {
  // 模拟月末 D 在两个月侧库各一份（month(D) 原件 + month(D+1) 冗余副本）。
  const D = '2026-06-30';
  const r1 = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'A', begin: 0, amtIn: 1, amtOut: 0, end: 1, billDate: D });
  const s6 = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try { importsRepo.insertRows(s6, D, [r1]); } finally { s6.close(); }
  const s7 = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try { importsRepo.insertRows(s7, D, [r1]); } finally { s7.close(); }
  const status = bizOpReconRunData.getStatusDualSource({ userDataDir, mainDb });
  const dPairs = status.importedDateBuPairs.filter((p) => p.date === D);
  assert.equal(dPairs.length, 1, '(D,BU) 去重为单条（冗余副本不翻倍）');
});

test('check-single-day 双源去重：副本不算多日', () => {
  const D = '2026-06-30';
  const r1 = shared.makeBizOp({ rowIndex: 2, bu: 'BU-C', account: 'A', begin: 0, amtIn: 1, amtOut: 0, end: 1, billDate: D });
  const s6 = runDataStore.openSideDb(userDataDir, MODULE, '2026-06');
  try { importsRepo.insertRows(s6, D, [r1]); } finally { s6.close(); }
  const s7 = runDataStore.openSideDb(userDataDir, MODULE, '2026-07');
  try { importsRepo.insertRows(s7, D, [r1]); } finally { s7.close(); }  // 冗余副本同 date
  const r = bizOpReconRunData.checkSingleDayDualSource({ userDataDir, mainDb, buName: 'BU-C' });
  assert.equal(r.onlyOneDay, true, '副本同 date → 仍只 1 日');
  assert.equal(r.count, 1, 'date 去重后 1');
});

test('孤儿兜底①：空壳删 / 有 imports 保留；②有镜像无文件标失效', () => {
  // 空壳。
  runDataStore.openSideDb(userDataDir, MODULE, '2026-01').close();
  // 有 imports + run 镜像。
  const fx = shared.buildSingleDayFixture('2026-03-15', '2026-03-14', 'BU-A');
  seedSide('2026-03', fx);
  const r = runCurrent({ date: '2026-03-15', buName: 'BU-A' });
  // 删 3 月侧库文件（模拟用户删）→ 有镜像无文件。
  runDataStore.deleteSideDb(userDataDir, MODULE, '2026-03');
  const stats = bizOpReconRunData.reconcileOrphans({ userDataDir, mainDb });
  assert.deepEqual(stats.deletedOrphanFiles, ['2026-01'], '空壳删');
  assert.deepEqual(stats.invalidatedRuns, ['2026-03-15'], '有镜像无文件标失效');
  assert.equal(runRepo.getRunById(mainDb, r.runId).status, 'side-db-missing', '镜像 status 失效');
});
