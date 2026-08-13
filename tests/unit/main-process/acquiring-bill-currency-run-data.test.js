// v3.0.5 PR-3（Part B Phase 1）— 收单 per-月侧库编排层单测
//   覆盖：孤儿双向兜底（有文件无元数据删文件 / 有元数据无文件标失效）+ retention 文件级二态分流
//   （整文件删 / 仅保留 diff）+ 双源 listMonths/sessionStatus

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const runRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  createBusinessOperationRegistry
} = require('../../../src/main-process/business-operation-registry');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  createBusinessFlowResolver
} = require('../../../src/main-process/archive-center/business-flow-resolver');
const {
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');
const {
  createArchiveOperationTracker
} = require('../../../src/main-process/archive-center/operation-tracker');
const {
  createTaskLifecycle
} = require('../../../src/main-process/archive-center/task-lifecycle');
const {
  createTaskPolicyRegistry
} = require('../../../src/main-process/archive-center/task-policy-registry');
const acquiringRunData = require('../../../src/main-process/acquiring-bill-currency-run-data');
const acquiringSession = require('../../../src/main-process/acquiring-bill-currency-session');

const MODULE = runDataStore.MODULE_ACQUIRING;
const RUNS_TABLE = 'acquiring_bill_currency_runs';

let tmpdir;
let appDb;
let mainDb;
let userDataDir;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-rundata-test-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  userDataDir = tmpdir; // = path.dirname(dbPath)
  appDb = new AppDatabase(dbPath);
  appDb.init();
  mainDb = appDb.db;
});
test.afterEach(() => {
  try { mainDb.close(); } catch (_) { /* swallow */ }
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

test.describe('peekImportTarget prepare 只读边界', () => {
  test('目标侧库不存在时返回 0，且不创建目录或数据库', async () => {
    const originalPeek = acquiringSession.peekImportTarget;
    acquiringSession.peekImportTarget = async () => ({ monthKey: '2026-08', existingCount: 0, kind: 'flow' });
    try {
      const result = await acquiringRunData.peekImportTarget({
        userDataDir,
        kind: 'flow',
        filePaths: ['/virtual/flow.xlsx'],
      });
      assert.deepEqual(result, { monthKey: '2026-08', existingCount: 0, kind: 'flow' });
      assert.equal(
        fs.existsSync(runDataStore.sideDbPath(userDataDir, MODULE, '2026-08')),
        false,
        'prepare 不得创建目标侧库'
      );
      assert.equal(
        fs.existsSync(runDataStore.moduleDir(userDataDir, MODULE)),
        false,
        'prepare 不得创建 run-data 模块目录'
      );
    } finally {
      acquiringSession.peekImportTarget = originalPeek;
    }
  });

  test('目标侧库存在时只读查询，不调用会执行 DDL 的 openSideDb', async () => {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-08');
    sideDb.prepare(`
      INSERT INTO acquiring_bill_currency_flow_imports
        (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, raw_json)
      VALUES ('2026-08', 'flow.xlsx', 2, 'M1', '10', '10', '')
    `).run();
    sideDb.close();

    const sideDbFilePath = runDataStore.sideDbPath(userDataDir, MODULE, '2026-08');
    const mtimeBefore = fs.statSync(sideDbFilePath).mtimeMs;
    const originalPeek = acquiringSession.peekImportTarget;
    const originalOpenSideDb = runDataStore.openSideDb;
    acquiringSession.peekImportTarget = async () => ({ monthKey: '2026-08', existingCount: 0, kind: 'flow' });
    runDataStore.openSideDb = () => {
      throw new Error('prepare 不得调用 openSideDb');
    };
    try {
      const result = await acquiringRunData.peekImportTarget({
        userDataDir,
        kind: 'flow',
        filePaths: ['/virtual/flow.xlsx'],
      });
      assert.deepEqual(result, { monthKey: '2026-08', existingCount: 1, kind: 'flow' });
      assert.equal(fs.statSync(sideDbFilePath).mtimeMs, mtimeBefore, '只读查询不得修改侧库文件');
    } finally {
      runDataStore.openSideDb = originalOpenSideDb;
      acquiringSession.peekImportTarget = originalPeek;
    }
  });
});

// 建一个该月侧库（含 imports + 一个 run + diff 行）+ 主库镜像行。
function seedSideMonth(monthKey, { withMirror = true, withFlow = true, withBill = true } = {}) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  sideDb.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES (?,1,1,1,0,'success')`).run(monthKey);
  const runId = sideDb.prepare('SELECT last_insert_rowid() AS id').get().id;
  // withBill:false + withFlow:false → 空壳（仅 runs 影子行，无 flow/bill imports；模拟崩溃残留）。
  let billId = null;
  if (withBill) {
    sideDb.prepare(`INSERT INTO acquiring_bill_currency_bill_imports (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json) VALUES (?, 'b.xlsx', 2, 'M1', 'EUR', 'eur', '{}')`).run(monthKey);
    billId = sideDb.prepare('SELECT last_insert_rowid() AS id').get().id;
  }
  if (withFlow) {
    sideDb.prepare(`INSERT INTO acquiring_bill_currency_flow_imports (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json) VALUES (?, 'f.xlsx', 2, 'M1', '10', '10', 'usd', 'usd', '')`).run(monthKey);
  }
  if (withBill) {
    sideDb.prepare(`INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,'usd','10','currency_mismatch')`).run(runId, billId);
  }
  sideDb.close();
  if (withMirror) {
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey,
      relPath: runDataStore.sideDbRelPath(MODULE, monthKey),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 1, unmatchedRows: 0 },
      status: 'success',
      diffFilePath: null,
      reportFilePath: null,
      ranAt: new Date().toISOString(),
    });
  }
}

function seedResumableRun({ source, monthKey, progress, batchContext = null }) {
  const db = source === 'side'
    ? runDataStore.openSideDb(userDataDir, MODULE, monthKey)
    : mainDb;
  try {
    const inserted = db.prepare(`
      INSERT INTO acquiring_bill_currency_runs
        (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
      VALUES (?, 11, 9, 2, 0, 'failed')
    `).run(monthKey);
    const runId = Number(inserted.lastInsertRowid);
    runRepo.setRunChunkProgress(db, {
      runId,
      lastCompletedChunkIndex: progress.lastCompletedChunkIndex,
      totalChunks: progress.totalChunks,
      status: progress.status,
      chunkSize: progress.chunkSize,
      batchContext
    });
    return {
      runId,
      dbPath: source === 'side'
        ? runDataStore.sideDbPath(userDataDir, MODULE, monthKey)
        : appDb.dbPath
    };
  } finally {
    if (source === 'side') db.close();
  }
}

function batchContextFrom(batch) {
  return Object.freeze({
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    taskRunId: batch.taskRunId,
    taskKey: batch.taskKey,
    moduleId: batch.moduleId,
    parentRunId: batch.parentRunId,
    operationKey: batch.operationKey
  });
}

test('启动扫尾保护集合只采信侧库可恢复 run 的 exact-seven batchContext', () => {
  const archiveRepository = createArchiveRepository(mainDb, {
    now: () => new Date('2026-08-12T00:00:00.000Z')
  });
  archiveRepository.ensureSchema();
  const reserved = archiveRepository.reserveTaskBatch({
    moduleId: 'acquiring-bill-currency',
    moduleCode: 'ACQUIRING',
    moduleName: '收单单据币种校验',
    taskKey: 'acquiringBillCurrency:run:resume',
    taskRunId: 'recoverable-task-run',
    operationKey: 'recoverable-operation',
    parentRunId: 'recoverable-parent'
  });
  const context = batchContextFrom(reserved.batch);
  seedResumableRun({
    source: 'side',
    monthKey: '2026-12',
    progress: {
      lastCompletedChunkIndex: 0,
      totalChunks: 2,
      status: 'partial',
      chunkSize: 5000
    },
    batchContext: context
  });
  seedResumableRun({
    source: 'side',
    monthKey: '2027-01',
    progress: {
      lastCompletedChunkIndex: 0,
      totalChunks: 2,
      status: 'partial',
      chunkSize: 5000
    }
  });

  assert.deepEqual(
    acquiringRunData.listRecoverableArchiveBatchIds({ userDataDir }),
    [context.batchId]
  );
});

test('fresh run prepare 可读取绑定原批次的可恢复 run，legacy/no-context 不冒充所有权', () => {
  const archiveRepository = createArchiveRepository(mainDb, {
    now: () => new Date('2026-08-12T00:00:00.000Z')
  });
  archiveRepository.ensureSchema();
  const reserved = archiveRepository.reserveTaskBatch({
    moduleId: 'acquiring-bill-currency',
    moduleCode: 'ACQUIRING',
    moduleName: '收单单据币种校验',
    taskKey: 'acquiringBillCurrency:run',
    taskRunId: 'fresh-run-owner',
    operationKey: 'fresh-run-owner-operation',
    parentRunId: 'fresh-run-owner-parent'
  });
  archiveRepository.transitionTaskStatus(reserved.batch.id, 'running', {
    expectedStatuses: ['reserved']
  });
  const context = batchContextFrom(archiveRepository.getBatch(reserved.batch.id));
  const seeded = seedResumableRun({
    source: 'side',
    monthKey: '2026-10',
    progress: {
      lastCompletedChunkIndex: 0,
      totalChunks: 3,
      status: 'partial',
      chunkSize: 5000
    },
    batchContext: context
  });

  assert.deepEqual(
    acquiringRunData.findBoundResumableRun({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      monthKey: '2026-10'
    }),
    {
      source: 'side',
      dbPath: seeded.dbPath,
      monthKey: '2026-10',
      runId: seeded.runId,
      progress: {
        lastCompletedChunkIndex: 0,
        totalChunks: 3,
        status: 'partial',
        chunkSize: 5000,
        batchContextVersion: 1,
        batchContext: context
      },
      batchContext: context
    }
  );

  seedResumableRun({
    source: 'side',
    monthKey: '2026-11',
    progress: {
      lastCompletedChunkIndex: 0,
      totalChunks: 2,
      status: 'partial',
      chunkSize: 5000
    }
  });
  assert.equal(acquiringRunData.findBoundResumableRun({
    userDataDir,
    mainDb,
    mainDbPath: appDb.dbPath,
    monthKey: '2026-11'
  }), null);
});

function reserveResumeBatch(repository, plan, parentRunId) {
  return repository.reserveTaskBatch({
    moduleId: 'acquiring-bill-currency',
    moduleCode: 'ACQUIRING',
    moduleName: '收单单据币种校验',
    taskKey: 'acquiringBillCurrency:run:resume',
    taskRunId: plan.taskRunId,
    operationKey: plan.operationKey,
    parentRunId
  });
}

test.describe('crash/resume archive identity', () => {
  test('side 新格式恢复复用精确身份，worker 保持 dbPath/chunk offset，成功只补 main mirror', async () => {
    const monthKey = '2026-09';
    const seeded = seedResumableRun({
      source: 'side',
      monthKey,
      progress: {
        lastCompletedChunkIndex: 3,
        totalChunks: 8,
        status: 'partial',
        chunkSize: 25000
      }
    });
    const archiveRepository = createArchiveRepository(mainDb, {
      now: () => new Date('2026-08-10T10:00:00.000Z')
    });
    archiveRepository.ensureSchema();
    const legacyPlan = acquiringRunData.prepareRunResume({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      monthKey,
      runId: seeded.runId
    });
    const reserved = reserveResumeBatch(archiveRepository, legacyPlan, 'parent-side-resume');
    const persistedContext = batchContextFrom(reserved.batch);
    acquiringRunData.persistRunResumeBatchContext({
      userDataDir,
      mainDb,
      prepared: legacyPlan,
      batchContext: persistedContext
    });
    archiveRepository.transitionTaskStatus(persistedContext.batchId, 'running', {
      expectedStatuses: ['reserved']
    });
    archiveRepository.transitionTaskStatus(persistedContext.batchId, 'failed', {
      expectedStatuses: ['running'],
      failureCode: 'WORKER_CRASH',
      failureMessage: 'worker exited'
    });

    const prepared = acquiringRunData.prepareRunResume({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      monthKey,
      runId: seeded.runId
    });
    assert.equal(prepared.source, 'side');
    assert.equal(prepared.dbPath, seeded.dbPath);
    assert.deepEqual(prepared.recovery.batchContext, persistedContext);
    assert.equal(prepared.taskRunId, persistedContext.taskRunId);
    assert.equal(prepared.operationKey, persistedContext.operationKey);
    assert.equal(prepared.flowPlan, null, '持久恢复不重新解析 parent flow');

    const latestBefore = archiveRepository.getLatestIssuedBatch();
    const reopened = archiveRepository.beginTaskRecovery(
      prepared.recovery.batchContext,
      { evidence: prepared.recovery.evidence }
    );
    assert.equal(reopened.status, 'reopened');
    assert.equal(archiveRepository.getLatestIssuedBatch().batchNumber, latestBefore.batchNumber);
    assert.equal(archiveRepository.listBatches().length, 1, '恢复不新增序号/批次');

    let workerPayload = null;
    const result = await acquiringRunData.resumeRunCheck({
      prepared,
      storageRoot: tmpdir,
      chunkSize: prepared.progress.chunkSize,
      batchContext: persistedContext,
      mainDb,
      dispatchFn: async (payload) => {
        workerPayload = payload;
        return {
          runId: seeded.runId,
          totalBillRows: 11,
          matchedRows: 9,
          mismatchRows: 2,
          unmatchedRows: 0,
          diffFilePath: path.join(tmpdir, 'diff.xlsx'),
          reportFilePath: null
        };
      },
      dispatchCallbacks: {}
    });
    assert.equal(result.runId, seeded.runId);
    assert.equal(workerPayload.__dbPath, seeded.dbPath);
    assert.deepEqual(workerPayload.batchContext, persistedContext);
    assert.deepEqual(workerPayload.resumeFromRun, {
      runId: seeded.runId,
      lastCompletedChunkIndex: 3
    });
    const mirror = mainDb.prepare(`
      SELECT month_key, side_db_rel_path, mismatch_rows
      FROM acquiring_bill_currency_runs
      WHERE month_key = ?
    `).get(monthKey);
    assert.equal(mirror.side_db_rel_path, runDataStore.sideDbRelPath(MODULE, monthKey));
    assert.equal(mirror.mismatch_rows, 2);
  });

  test('legacy side/main 使用 source+month+runId 稳定预留，reserve→backfill 窗口重试复用', async () => {
    const archiveRepository = createArchiveRepository(mainDb, {
      now: () => new Date('2026-08-10T10:00:00.000Z')
    });
    archiveRepository.ensureSchema();
    for (const fixture of [
      { source: 'side', monthKey: '2026-10' },
      { source: 'main', monthKey: '2026-11' }
    ]) {
      const seeded = seedResumableRun({
        ...fixture,
        progress: {
          lastCompletedChunkIndex: 1,
          totalChunks: 5,
          status: 'partial',
          chunkSize: 10000
        }
      });
      const firstPlan = acquiringRunData.prepareRunResume({
        userDataDir,
        mainDb,
        mainDbPath: appDb.dbPath,
        monthKey: fixture.monthKey,
        runId: seeded.runId
      });
      assert.equal(firstPlan.recovery.legacy, true);
      assert.match(firstPlan.operationKey, new RegExp(`${fixture.source}:${fixture.monthKey}:${seeded.runId}$`));
      assert.equal(
        firstPlan.flowPlan.flowIdentity.value,
        `acquiring-run:${fixture.source}:${fixture.monthKey}:${seeded.runId}`
      );
      const firstReserve = reserveResumeBatch(
        archiveRepository,
        firstPlan,
        `parent-${fixture.source}`
      );
      assert.equal(firstReserve.created, true);
      const latestAfterFirst = archiveRepository.getLatestIssuedBatch();

      // 模拟进程崩在 reserve 与 batchContext 回填之间：原 run 仍是 legacy，稳定 operation 必须复用。
      const retryPlan = acquiringRunData.prepareRunResume({
        userDataDir,
        mainDb,
        mainDbPath: appDb.dbPath,
        monthKey: fixture.monthKey,
        runId: seeded.runId
      });
      assert.equal(retryPlan.taskRunId, firstPlan.taskRunId);
      assert.equal(retryPlan.operationKey, firstPlan.operationKey);
      const reused = reserveResumeBatch(
        archiveRepository,
        retryPlan,
        `parent-${fixture.source}`
      );
      assert.equal(reused.created, false);
      assert.equal(reused.batch.id, firstReserve.batch.id);
      assert.equal(
        archiveRepository.getLatestIssuedBatch().batchNumber,
        latestAfterFirst.batchNumber,
        '稳定 reserve 重放不推进全局序号'
      );

      const context = batchContextFrom(firstReserve.batch);
      acquiringRunData.persistRunResumeBatchContext({
        userDataDir,
        mainDb,
        prepared: retryPlan,
        batchContext: context
      });
      const persistedPlan = acquiringRunData.prepareRunResume({
        userDataDir,
        mainDb,
        mainDbPath: appDb.dbPath,
        monthKey: fixture.monthKey,
        runId: seeded.runId
      });
      assert.deepEqual(persistedPlan.recovery.batchContext, context);
      assert.equal(persistedPlan.source, fixture.source);
      if (fixture.source === 'main') {
        let dispatchedPath = null;
        await acquiringRunData.resumeRunCheck({
          prepared: persistedPlan,
          storageRoot: tmpdir,
          chunkSize: persistedPlan.progress.chunkSize,
          batchContext: context,
          mainDb,
          dispatchFn: async (payload) => {
            dispatchedPath = payload.__dbPath;
            return {
              runId: seeded.runId,
              totalBillRows: 11,
              matchedRows: 9,
              mismatchRows: 2,
              unmatchedRows: 0
            };
          },
          dispatchCallbacks: {}
        });
        assert.equal(dispatchedPath, appDb.dbPath, 'legacy main 必须继续 dispatch 原主库');
        const mainRun = mainDb.prepare(`
          SELECT side_db_rel_path
          FROM acquiring_bill_currency_runs
          WHERE id = ?
        `).get(seeded.runId);
        assert.equal(mainRun.side_db_rel_path, null, 'legacy main 成功不得伪造 side mirror');
        assert.equal(
          fs.existsSync(runDataStore.sideDbPath(userDataDir, MODULE, fixture.monthKey)),
          false,
          'legacy main resume 不创建 side DB'
        );
      }
    }
  });

  test('side complete 崩溃恢复零 worker 替换旧镜像并复用原批次，exact 镜像严格 no-op', async () => {
    const monthKey = '2026-12';
    const diffFilePath = path.join(tmpdir, 'completed-diff.xlsx');
    const reportFilePath = path.join(tmpdir, 'completed-report.xlsx');
    fs.writeFileSync(diffFilePath, 'diff');
    fs.writeFileSync(reportFilePath, 'report');
    const seeded = seedResumableRun({
      source: 'side',
      monthKey,
      progress: {
        lastCompletedChunkIndex: 2,
        totalChunks: 4,
        status: 'partial',
        chunkSize: 5000
      }
    });
    const staleMirror = mainDb.prepare(`
      INSERT INTO acquiring_bill_currency_runs
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows,
         status, diff_file_path, report_file_path, side_db_rel_path)
      VALUES (?, '2026-11-30T12:00:00.000Z', 7, 6, 1, 0, 'success', ?, ?, ?)
    `).run(
      monthKey,
      path.join(tmpdir, 'previous-diff.xlsx'),
      path.join(tmpdir, 'previous-report.xlsx'),
      runDataStore.sideDbRelPath(MODULE, monthKey)
    );
    const staleMirrorId = Number(staleMirror.lastInsertRowid);
    const archiveRepository = createArchiveRepository(mainDb, {
      now: () => new Date('2026-08-10T10:00:00.000Z')
    });
    archiveRepository.ensureSchema();
    const legacyPlan = acquiringRunData.prepareRunResume({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      monthKey,
      runId: seeded.runId
    });
    const reserved = reserveResumeBatch(archiveRepository, legacyPlan, 'parent-completed-run');
    const batchContext = batchContextFrom(reserved.batch);
    acquiringRunData.persistRunResumeBatchContext({
      userDataDir,
      mainDb,
      prepared: legacyPlan,
      batchContext
    });
    archiveRepository.transitionTaskStatus(batchContext.batchId, 'running', {
      expectedStatuses: ['reserved']
    });

    const sideDb = new DatabaseSync(seeded.dbPath);
    const sideRunBefore = runRepo.getRunById(sideDb, seeded.runId);
    runRepo.updateRunStatus(sideDb, { runId: seeded.runId, status: 'success' });
    runRepo.updateRunPaths(sideDb, { runId: seeded.runId, diffFilePath, reportFilePath });
    runRepo.setRunChunkProgress(sideDb, {
      runId: seeded.runId,
      lastCompletedChunkIndex: 3,
      totalChunks: 4,
      status: 'complete',
      chunkSize: 5000
    });
    sideDb.close();

    const prepared = acquiringRunData.prepareRunResume({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      monthKey
    });
    assert.equal(prepared.mode, 'completed');
    assert.deepEqual(prepared.recovery.batchContext, batchContext);
    assert.equal(prepared.runEvidence.ranAt, sideRunBefore.ran_at);
    acquiringRunData.assertRunResumeFresh({
      userDataDir,
      mainDb,
      mainDbPath: appDb.dbPath,
      prepared
    });

    let workerCalls = 0;
    const recover = (context = batchContext) => acquiringRunData.resumeRunCheck({
      prepared,
      storageRoot: tmpdir,
      chunkSize: prepared.progress.chunkSize,
      batchContext: context,
      mainDb,
      dispatchFn: async () => {
        workerCalls += 1;
        throw new Error('completed recovery must not dispatch worker');
      },
      dispatchCallbacks: {}
    });
    const latestBatchNumber = archiveRepository.getLatestIssuedBatch().batchNumber;
    const archiveService = createArchiveService({
      repository: archiveRepository,
      rootDir: path.join(tmpdir, 'archive-center')
    });
    assert.equal((await archiveService.initialize()).available, true);
    const controller = createArchiveCenterController({ database: appDb, service: archiveService });
    const operationTracker = createArchiveOperationTracker({ sink: controller.sink });
    const flowResolver = createBusinessFlowResolver({ archiveService });
    const lifecycle = createTaskLifecycle({
      businessOperationRegistry: createBusinessOperationRegistry(),
      archiveService,
      flowResolver,
      operationTracker
    });
    const policy = createTaskPolicyRegistry().require('acquiringBillCurrency:run:resume');
    const invocation = {
      args: [{ monthKey }],
      prepared: { resumePlan: prepared }
    };
    const first = await lifecycle.run({
      meta: { channel: policy.channel },
      policy,
      args: invocation.args,
      prepared: invocation.prepared,
      recovery: prepared.recovery,
      beforeStart: () => acquiringRunData.assertRunResumeFresh({
        userDataDir,
        mainDb,
        mainDbPath: appDb.dbPath,
        prepared
      }),
      execute: (context) => recover(context),
      resultClassifier: policy.resultClassifier,
      resultMetadataResolver: policy.resultMetadataResolver,
      resultFlowIdentities: (result, context) => (
        policy.resultFlowIdentities(result, context, invocation)
      )
    });
    const firstMirror = mainDb.prepare(`
      SELECT * FROM acquiring_bill_currency_runs WHERE month_key = ?
    `).get(monthKey);
    const second = await recover();
    const secondMirror = mainDb.prepare(`
      SELECT * FROM acquiring_bill_currency_runs WHERE month_key = ?
    `).get(monthKey);

    assert.equal(workerCalls, 0);
    assert.equal(first.runId, seeded.runId);
    assert.deepEqual(second, first);
    assert.equal(first.diffFilePath, diffFilePath);
    assert.equal(first.reportFilePath, reportFilePath);
    const completedBatch = archiveRepository.getBatchDetail(batchContext.batchId);
    assert.equal(completedBatch.taskStatus, 'succeeded');
    assert.deepEqual(
      completedBatch.artifacts.map((artifact) => artifact.originalName).sort(),
      [path.basename(diffFilePath), path.basename(reportFilePath)].sort()
    );
    assert.ok(completedBatch.artifacts.every((artifact) => artifact.status === 'ready'));
    assert.notEqual(firstMirror.id, staleMirrorId, '恢复应沿正常成功路径替换上一轮 stale mirror');
    assert.deepEqual(secondMirror, firstMirror, '镜像存在时不得换 row id/ranAt 或重写字段');
    assert.equal(firstMirror.ran_at, sideRunBefore.ran_at, '替换旧镜像时沿用侧库持久 ran_at');
    assert.equal(
      archiveRepository.getLatestIssuedBatch().batchNumber,
      latestBatchNumber,
      'completed recovery 不预留新批次/不推进序号'
    );
  });
});

test('acquiring export 从主镜像唯一定位 side/main run 并固定稳定 parent identity', () => {
  const sideMonth = '2026-07';
  const sideDiff = path.join(tmpdir, 'side-export.xlsx');
  fs.writeFileSync(sideDiff, 'side-export');
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, sideMonth);
  const sideRunId = runRepo.insertRun(sideDb, {
    monthKey: sideMonth,
    ranAt: '2026-07-31T12:00:00.000Z',
    totalBillRows: 2,
    matchedRows: 1,
    mismatchRows: 1,
    unmatchedRows: 0,
    status: 'success'
  });
  runRepo.updateRunPaths(sideDb, { runId: sideRunId, diffFilePath: sideDiff, reportFilePath: null });
  sideDb.close();
  acquiringRunData.upsertMainRunMirror(mainDb, {
    monthKey: sideMonth,
    relPath: runDataStore.sideDbRelPath(MODULE, sideMonth),
    stats: { totalBillRows: 2, matchedRows: 1, mismatchRows: 1, unmatchedRows: 0 },
    status: 'success',
    diffFilePath: sideDiff,
    reportFilePath: null,
    ranAt: '2026-07-31T12:01:00.000Z'
  });
  const sidePlan = acquiringRunData.prepareRunExport({ userDataDir, mainDb, monthKey: sideMonth });
  assert.equal(sidePlan.source, 'side');
  assert.equal(sidePlan.runId, sideRunId);
  assert.equal(sidePlan.flowIdentity.value, `acquiring-run:side:${sideMonth}:${sideRunId}`);
  acquiringRunData.assertRunExportFresh({ userDataDir, mainDb, prepared: sidePlan });

  const mainMonth = '2025-12';
  const mainDiff = path.join(tmpdir, 'main-export.xlsx');
  fs.writeFileSync(mainDiff, 'main-export');
  const mainRunId = runRepo.insertRun(mainDb, {
    monthKey: mainMonth,
    ranAt: '2025-12-31T12:00:00.000Z',
    totalBillRows: 3,
    matchedRows: 3,
    mismatchRows: 0,
    unmatchedRows: 0,
    status: 'success'
  });
  runRepo.updateRunPaths(mainDb, { runId: mainRunId, diffFilePath: mainDiff, reportFilePath: null });
  const mainPlan = acquiringRunData.prepareRunExport({ userDataDir, mainDb, monthKey: mainMonth });
  assert.equal(mainPlan.source, 'main');
  assert.equal(mainPlan.runId, mainRunId);
  assert.equal(mainPlan.flowIdentity.value, `acquiring-run:main:${mainMonth}:${mainRunId}`);
});

test.describe('孤儿双向兜底（reconcileOrphans，spec §B.6）', () => {
  test('正常配对（文件+镜像）→ 不删不标失效', () => {
    seedSideMonth('2026-03');
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, [], '无孤儿文件');
    assert.deepEqual(stats.invalidatedRuns, [], '无失效 run');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true, '文件保留');
  });

  test('有文件无元数据 + 空壳（无 flow/bill imports）→ 删文件', () => {
    seedSideMonth('2026-03', { withMirror: false, withFlow: false, withBill: false }); // 崩溃残留空壳
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true);
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, ['2026-03'], '空壳孤儿文件被删');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), false, '文件已删');
  });

  test('🔴 codex P1：有文件无元数据 + import-only（有 flow/bill 数据）→ 不删（防丢导入数据）', () => {
    seedSideMonth('2026-03', { withMirror: false }); // 默认有 flow+bill = 已导入未对账的有效中间态
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true);
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, [], 'import-only 不被当孤儿删（修复前会误删）');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true, '文件保留，重启不丢导入数据');
  });

  test('有元数据无文件 → 标记 run 失效（status=side-db-missing，不崩溃）', () => {
    // 主库镜像行存在但侧库文件不存在（模拟用户手删侧库文件）
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey: '2026-05',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-05'),
      stats: { totalBillRows: 2, matchedRows: 2, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success',
      diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-05'), false, '前置：无侧库文件');
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.invalidatedRuns, ['2026-05'], 'run 标记失效');
    const row = mainDb.prepare(`SELECT status FROM ${RUNS_TABLE} WHERE month_key='2026-05'`).get();
    assert.equal(row.status, 'side-db-missing', 'status=side-db-missing（UI 降级「数据已清理」不崩溃）');
  });

  test('再次 reconcile 已失效 run 不重复标记（幂等）', () => {
    acquiringRunData.upsertMainRunMirror(mainDb, {
      monthKey: '2026-05',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-05'),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success', diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    const stats2 = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats2.invalidatedRuns, [], '二次不重复标记（已 side-db-missing）');
  });

  test('双向并存：A 空壳文件无元数据 + B 元数据无文件 → 同时处理', () => {
    seedSideMonth('2026-03', { withMirror: false, withFlow: false, withBill: false }); // 空壳文件无元数据
    acquiringRunData.upsertMainRunMirror(mainDb, {  // 元数据无文件
      monthKey: '2026-06',
      relPath: runDataStore.sideDbRelPath(MODULE, '2026-06'),
      stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 0, unmatchedRows: 0 },
      status: 'success', diffFilePath: null, reportFilePath: null, ranAt: new Date().toISOString(),
    });
    const stats = acquiringRunData.reconcileOrphans({ userDataDir, mainDb });
    assert.deepEqual(stats.deletedOrphanFiles, ['2026-03']);
    assert.deepEqual(stats.invalidatedRuns, ['2026-06']);
  });
});

test.describe('retention 文件级二态分流（B-D4）', () => {
  test('整文件删（deleteMonthSideDb）：删侧库文件 + 主库镜像行', () => {
    seedSideMonth('2026-03');
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), true);
    assert.ok(mainDb.prepare(`SELECT 1 FROM ${RUNS_TABLE} WHERE month_key='2026-03'`).get(), '前置：镜像行存在');
    const r = acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb, monthKey: '2026-03' });
    assert.equal(r.deleted, true);
    assert.equal(runDataStore.sideDbExists(userDataDir, MODULE, '2026-03'), false, '侧库文件删除');
    assert.equal(mainDb.prepare(`SELECT COUNT(*) AS c FROM ${RUNS_TABLE} WHERE month_key='2026-03' AND side_db_rel_path IS NOT NULL`).get().c, 0, '主库镜像行删除');
  });

  test('仅保留 diff（trimMonthSideDbKeepDiff）：删 flow_imports，保留 bill + diff', () => {
    seedSideMonth('2026-03');
    const r = acquiringRunData.trimMonthSideDbKeepDiff({ userDataDir, monthKey: '2026-03' });
    assert.equal(r.flowDeleted, 1, '删 1 行 flow');
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, '2026-03');
    try {
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c, 0, 'flow 清空');
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c, 1, 'bill 保留（diff 源数据）');
      assert.equal(sideDb.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c, 1, 'diff 保留（重导出不丢）');
    } finally {
      sideDb.close();
    }
  });

  test('仅保留 diff：侧库文件不存在 → skip 不报错', () => {
    const r = acquiringRunData.trimMonthSideDbKeepDiff({ userDataDir, monthKey: '2099-12' });
    assert.equal(r.skipped, 'no-side-db');
  });
});

test.describe('双源读路径（B-D2）', () => {
  test('listMonthsDualSource 合并侧库 month + 主库旧表 month', () => {
    // 侧库新 run（2026-03）
    seedSideMonth('2026-03');
    // 主库旧表 imports（历史 run，2026-01）— 直接写主库 bill_imports 模拟历史
    mainDb.prepare(`INSERT INTO acquiring_bill_currency_bill_imports (month_key, source_file, source_row_index, recon_main_id, raw_json) VALUES ('2026-01','old.xlsx',2,'OLD','{}')`).run();
    const months = acquiringRunData.listMonthsDualSource({ userDataDir, mainDb });
    assert.deepEqual(months.slice().sort(), ['2026-01', '2026-03'], '两源 month 合并去重');
  });

  test('getSessionStatusDualSource 侧库存在 → 读侧库 readiness + 主库镜像 run', () => {
    seedSideMonth('2026-03');
    const status = acquiringRunData.getSessionStatusDualSource({ userDataDir, mainDb, monthKey: '2026-03' });
    assert.equal(status.flowReady, true, '侧库 flow 就绪');
    assert.equal(status.billReady, true, '侧库 bill 就绪');
    assert.ok(status.latestRun, '主库镜像 run 透出');
    assert.equal(status.latestRun.mismatch_rows, 1);
  });

  test('getSessionStatusDualSource 侧库不存在 → 读主库旧表（历史 run 零变化）', () => {
    // 主库旧表 imports（历史）
    mainDb.prepare(`INSERT INTO acquiring_bill_currency_flow_imports (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, raw_json) VALUES ('2026-01','old.xlsx',2,'OLD','10','10','')`).run();
    const status = acquiringRunData.getSessionStatusDualSource({ userDataDir, mainDb, monthKey: '2026-01' });
    assert.equal(status.flowReady, true, '主库旧表 flow 就绪');
    assert.equal(status.billReady, false, '主库旧表无 bill');
  });
});
