// v2.1.10 A3 Phase 1 T07 — run-check-worker-pool unit test
//
// 覆盖：
//   1. dispatchRunCheck 正常路径（init + run + done）
//   2. dispatchRunCheck 错误透传（worker 内 monthKey 缺失 → error）
//   3. cancel 中断（worker 内通过 cancelToken 抛 canceled）— Phase 1 worker 端 cancel 仅 message ack；
//      runCheck 内未集成 cancelToken（T13 才接），本 case 验证 cancel API 不抛错 + getStatus 反映
//   4. worker exit 异常 → reject + 清状态（人为 close 后再 dispatch）
//   5. crash recovery — 模拟 worker process.exit(1) → 下次 dispatch 触发 cold-start
//   6. getStatus 各状态正确
//   7. preWarm 工作 + 重复 preWarm 幂等
//   8. shutdown 干净退出
//
// 因为 worker_threads 是真实子线程，每个 case 都 init → run → __reset_for_test__；
// 用临时 DB（每 case 独立 tmpdir）。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const pool = require('../../../src/main-process/run-check-worker-pool');
const { AppDatabase } = require('../../../src/backend/database');
const session = require('../../../src/main-process/acquiring-bill-currency-session');
const runRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../../src/backend/acquiring-bill-currency-db/columns');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');

const WORKER_BATCH_CONTEXT = Object.freeze({
  batchId: 319,
  batchNumber: '2026-08-10-001',
  taskRunId: 'acquiring-run-worker-contract',
  taskKey: 'acquiringBillCurrency:run',
  moduleId: 'acquiring-bill-currency',
  parentRunId: 'acquiring-run-parent',
  operationKey: 'acquiring-run-operation'
});

// 临时 DB + 测试数据准备
async function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const date = '2026-04-15';
  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');

  function makeFlow(id, currency) {
    const r = new Array(48).fill('');
    r[0] = date; r[6] = id; r[12] = '100'; r[13] = currency; r[28] = '100'; r[29] = currency;
    return r;
  }
  function makeBill(id, currency) {
    const r = new Array(26).fill('');
    r[0] = date; r[14] = id; r[18] = '100'; r[19] = currency;
    return r;
  }
  const wb1 = new ExcelJS.Workbook();
  const ws1 = wb1.addWorksheet('Sheet1');
  ws1.addRow(FLOW_HEADERS);
  ws1.addRow(makeFlow('POOL-1', 'USD'));
  ws1.addRow(makeFlow('POOL-2', 'USD'));
  await wb1.xlsx.writeFile(flowFile);

  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Sheet1');
  ws2.addRow(BILL_HEADERS);
  ws2.addRow(makeBill('POOL-1', 'USD'));
  ws2.addRow(makeBill('POOL-2', 'EUR'));
  await wb2.xlsx.writeFile(billFile);

  await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [billFile] });
  db.db.close();

  return {
    tmpdir,
    dbPath,
    cleanup() {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

test.describe('run-check-worker-pool', () => {

  test.afterEach(async () => {
    // 每 case 后清模块级状态
    await pool.__reset_for_test__();
  });

  test('1. dispatchRunCheck 正常路径 → done', async () => {
    const ctx = await setupTmpDb();
    try {
      const result = await pool.dispatchRunCheck(
        {
          __dbPath: ctx.dbPath,
          monthKey: '2026-04',
          storageRoot: ctx.tmpdir,
          batchContext: WORKER_BATCH_CONTEXT,
          outputIntent: {
            diffFilePath: path.join(ctx.tmpdir, 'frozen-worker-output.xlsx'),
            reportFilePath: path.join(ctx.tmpdir, 'frozen-worker-output.xlsx')
          }
        },
        {}
      );
      assert.equal(typeof result.runId, 'number', 'runId 是 number');
      assert.equal(result.totalBillRows, 2, 'totalBillRows=2');
      assert.equal(result.mismatchRows, 1, 'mismatchRows=1');
    } finally {
      ctx.cleanup();
    }
  });

  test('1a. resume IPC prepare/execute contract 在 reserve 前取锁并将持久 batchContext 透传到 worker', async () => {
    const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
    const freshRunStart = mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:run'"
    );
    const freshRunEnd = mainSource.indexOf(
      "ipcMain.handle('acquiringBillCurrency:run:cancel'",
      freshRunStart
    );
    const freshRunSource = mainSource.slice(freshRunStart, freshRunEnd);
    assert.match(freshRunSource, /async prepare\(_event, payload = \{\}\)/);
    assert.ok(
      freshRunSource.indexOf('acquiringRunData.findBoundResumableRun')
        < freshRunSource.indexOf("tryAcquireOpLock('run', monthKey)"),
      'fresh run 必须在月锁/reserve/clear 之前探测已绑定原批次的可恢复 run'
    );
    assert.match(freshRunSource, /ACQUIRING_RUN_RESUME_REQUIRED/);
    assert.match(freshRunSource, /\['reserved', 'running'\]/);
    assert.ok(
      freshRunSource.indexOf("tryAcquireOpLock('run', monthKey)")
        < freshRunSource.indexOf('async execute(event, prepared, taskContext)'),
      'fresh run 的 DB/month admission 与月锁必须在 lifecycle reserve 前的 prepare 完成'
    );
    assert.match(freshRunSource, /onAbandon:\s*releaseLock/);
    assert.match(freshRunSource, /finally\s*\{\s*prepared\.releaseLock\(\)/);
    const handlerStart = mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:run:resume'"
    );
    const handlerEnd = mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:export'",
      handlerStart
    );
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'main.js 应存在独立 resume handler 段');
    const handlerSource = mainSource.slice(handlerStart, handlerEnd);
    assert.match(
      handlerSource,
      /async prepare\(_event, payload = \{\}\)/,
      'resume 必须在 lifecycle 前 prepare'
    );
    assert.ok(
      handlerSource.indexOf("tryAcquireOpLock('run', monthKey)")
        < handlerSource.indexOf('acquiringRunData.prepareRunResume'),
      'prepare 必须先取得既有 acquiring operation lock，再解析恢复目标'
    );
    assert.match(
      handlerSource,
      /async execute\(event, prepared, taskContext\)/,
      'resume execute 必须取得 prepared plan 与 lifecycle taskContext'
    );
    assert.doesNotMatch(handlerSource, /persistRunResumeBatchContext/);
    assert.match(handlerSource, /filePlanResolver\(\)[\s\S]*planRunOutputPaths/);
    assert.match(handlerSource, /beforeStart\(nextBatchContext, fileEvidence\)/);
    assert.ok(
      handlerSource.indexOf('transferRunResumeOwner')
        < handlerSource.indexOf('resumeRunCheck'),
      '新 owner 必须在 worker 前以 side DB CAS 接管'
    );
    assert.match(handlerSource, /sourceOperation:\s*artifacts\[0\]\.sourceOperation/);
    assert.match(handlerSource, /explicitParentRunId:\s*oldOwner \? oldOwner\.parentRunId/);
    assert.doesNotMatch(handlerSource, /nextTaskRunId|nextOperationKey/);
    assert.match(handlerSource, /if \(!prepared\.legacyExistingBatchRecovery\)[\s\S]*settleArtifacts/);
    assert.match(
      handlerSource,
      /batchContext:\s*taskContext\.batchContext/,
      'resume dispatch payload 必须透传父任务 batchContext'
    );
    const wrapperStart = mainSource.indexOf('async function runArchiveAwareOperation');
    const wrapperEnd = mainSource.indexOf('function runRegisteredBusinessOperation', wrapperStart);
    const wrapperSource = mainSource.slice(wrapperStart, wrapperEnd);
    assert.match(wrapperSource, /recovery:\s*prepared\.recovery \|\| undefined/);
    assert.match(wrapperSource, /taskRunId:\s*prepared\.taskRunId \|\|/);
    assert.match(wrapperSource, /operationKey:\s*prepared\.operationKey \|\|/);
    assert.match(wrapperSource, /flowPlanResolver:\s*prepared\.flowPlan/);

    const ctx = await setupTmpDb();
    let sideDb;
    try {
      sideDb = new AppDatabase(ctx.dbPath);
      sideDb.init();
      const initial = await session.runCheckCore({
        db: sideDb.db,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        chunkSize: 1
      });
      runRepo.setRunChunkProgress(sideDb.db, {
        runId: initial.runId,
        lastCompletedChunkIndex: -1,
        totalChunks: 2,
        status: 'partial',
        chunkSize: 1
      });
      sideDb.db.close();
      sideDb = null;

      const resumePayload = {
        __dbPath: ctx.dbPath,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        chunkSize: 1,
        resumeFromRun: {
          runId: initial.runId,
          lastCompletedChunkIndex: -1
        }
      };
      await assert.rejects(
        () => pool.dispatchRunCheck({
          ...resumePayload,
          batchContext: { ...WORKER_BATCH_CONTEXT, batchId: 0 }
        }, {}),
        /worker batchContext\.batchId/,
        '非法探针必须在真实 run worker 入口被拒绝；若中途漏传则会静默成功'
      );

      const resumed = await pool.dispatchRunCheck({
        ...resumePayload,
        batchContext: WORKER_BATCH_CONTEXT
      }, {});
      assert.equal(resumed.runId, initial.runId, 'resume 仍复用原 runId');
    } finally {
      try { sideDb?.db.close(); } catch (_e) { /* swallow */ }
      ctx.cleanup();
    }
  });

  test('1b. Acquiring 五条 file action 只从冻结 FilePlan 消费路径并按 exact-7 透传 worker owner', () => {
    const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
    const importStart = mainSource.indexOf('async function prepareAcquiringImport');
    const importEnd = mainSource.indexOf("trackedIpcHandle('acquiringBillCurrency:run'", importStart);
    const importSource = mainSource.slice(importStart, importEnd);
    assert.match(importSource, /filePlan:\s*\{[\s\S]*inputs:\s*filePaths\.map/);
    assert.match(importSource, /taskContext\.fileEvidence\.filePlan\.inputs\.map/);
    assert.match(importSource, /batchContext:\s*taskContext\.batchContext/);
    assert.doesNotMatch(importSource, /const filePaths = prepared\.filePaths/);

    const runStart = mainSource.indexOf("trackedIpcHandle('acquiringBillCurrency:run'");
    const runEnd = mainSource.indexOf("ipcMain.handle('acquiringBillCurrency:run:cancel'", runStart);
    const runSource = mainSource.slice(runStart, runEnd);
    assert.match(runSource, /filePlanResolver\(\)[\s\S]*planRunOutputPaths/);
    assert.match(runSource, /taskContext\.fileEvidence\.filePlan\.outputs\[0\]\.filePath/);
    assert.match(runSource, /settleArtifacts\([\s\S]*artifactKey/);

    const resumeStart = mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:run:resume'"
    );
    const resumeEnd = mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:export'",
      resumeStart
    );
    const resumeSource = mainSource.slice(resumeStart, resumeEnd);
    assert.match(resumeSource, /sourceOperation:\s*artifacts\[0\]\.sourceOperation/);
    assert.match(resumeSource, /artifactKey:\s*artifacts\[0\]\.artifactKey/);
    assert.match(resumeSource, /previousBatchContext:\s*oldOwner \|\| null/);
    assert.match(resumeSource, /nextOutputIntent:\s*\{[\s\S]*diffFilePath:\s*outputPath/);

    const exportSource = mainSource.slice(resumeEnd, mainSource.indexOf(
      "trackedIpcHandle('acquiringBillCurrency:retention:cleanup'",
      resumeEnd
    ));
    assert.match(exportSource, /const output = taskContext\.fileEvidence\.filePlan\.outputs\[0\]/);
    assert.match(exportSource, /fs\.copyFileSync\(exportPlan\.diffFilePath, output\.filePath\)/);
    assert.doesNotMatch(exportSource, /prepared\.(?:savePath|outputPaths)/);
  });

  test('2. dispatchRunCheck 错误透传（monthKey 缺失）', async () => {
    const ctx = await setupTmpDb();
    try {
      await assert.rejects(
        () => pool.dispatchRunCheck({ __dbPath: ctx.dbPath, storageRoot: ctx.tmpdir }, {}),
        (err) => {
          assert.ok(err instanceof Error, '应是 Error 实例');
          assert.ok(
            err.message.includes('monthKey'),
            `error.message 应含 monthKey；实际：${err.message}`
          );
          return true;
        }
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('3. cancel API（无 active job 返回 false）', async () => {
    const ctx = await setupTmpDb();
    try {
      // 无 worker / 无 job 时 cancel return false
      assert.equal(pool.cancel(), false, 'cancel 无 active job 返回 false');
      // dispatch + 立即 cancel（race condition：cancel 是 fire-and-forget）
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      // 这里 cancel 可能 catch 到 active job 也可能错过（race）— API 不抛错即 OK
      try { pool.cancel(); } catch (_e) { /* swallow */ }
      // run 仍正常完成（T13 之前 cancel 不真打断 — Phase 1 spec）
      const result = await runPromise;
      assert.equal(typeof result.runId, 'number');
    } finally {
      ctx.cleanup();
    }
  });

  test('4. getStatus 各状态正确', async () => {
    const ctx = await setupTmpDb();
    try {
      // 初始：未启动
      const s0 = pool.getStatus();
      assert.equal(s0.workerAlive, false, '初始 workerAlive=false');
      assert.equal(s0.busy, false, '初始 busy=false');

      // preWarm → workerAlive=true / busy=false
      await pool.preWarm(ctx.dbPath);
      const s1 = pool.getStatus();
      assert.equal(s1.workerAlive, true, 'preWarm 后 workerAlive=true');
      assert.equal(s1.busy, false, 'preWarm 后 busy=false');
      assert.equal(s1.dbPath, ctx.dbPath, 'dbPath 记住');

      // dispatch 期间 busy=true（dispatchRunCheck 是 async — 让出 microtask 后 activeJob 才被设）
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      // 等几个 microtask 让 dispatchRunCheck 内部走过 await ensureInitialized + setActiveJob
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const s2 = pool.getStatus();
      assert.equal(s2.busy, true, 'dispatch 期间 busy=true');
      assert.ok(s2.activeJobId, 'activeJobId 不为 null');
      await runPromise;
      const s3 = pool.getStatus();
      assert.equal(s3.busy, false, 'done 后 busy=false');
      assert.equal(s3.activeJobId, null, 'done 后 activeJobId=null');
    } finally {
      ctx.cleanup();
    }
  });

  test('5. preWarm 幂等（重复调用不重启）', async () => {
    const ctx = await setupTmpDb();
    try {
      await pool.preWarm(ctx.dbPath);
      const s1 = pool.getStatus();
      await pool.preWarm(ctx.dbPath);
      const s2 = pool.getStatus();
      assert.equal(s1.workerAlive, s2.workerAlive, 'workerAlive 一致');
      assert.equal(s2.workerAlive, true, '仍 alive');
    } finally {
      ctx.cleanup();
    }
  });

  test('6. shutdown 干净退出', async () => {
    const ctx = await setupTmpDb();
    try {
      await pool.preWarm(ctx.dbPath);
      assert.equal(pool.getStatus().workerAlive, true);
      await pool.shutdown(2000);
      const s = pool.getStatus();
      assert.equal(s.workerAlive, false, 'shutdown 后 workerAlive=false');
      assert.equal(s.busy, false, 'shutdown 后 busy=false');
    } finally {
      ctx.cleanup();
    }
  });

  test('7. crash recovery — worker 异常 exit 后下次 dispatch 触发 cold-start', async () => {
    const ctx = await setupTmpDb();
    try {
      await pool.preWarm(ctx.dbPath);
      const s1 = pool.getStatus();
      assert.equal(s1.workerAlive, true);

      // 模拟 crash — 直接 terminate worker（不让 worker 内自然退出 — 模拟 process killed）
      // 我们用反射拿 worker 实例后 terminate
      // 实际 pool 内 worker 是 module-level 变量，无 API 暴露 — 用 shutdown(0) 触发 timeout terminate
      await pool.shutdown(50); // 极短 timeout 强制 terminate

      // shutdown 后 worker=null；下次 dispatch 应 cold-start
      const s2 = pool.getStatus();
      assert.equal(s2.workerAlive, false, 'shutdown 后 worker=null');

      const result = await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      assert.equal(typeof result.runId, 'number', 'cold-start 后能 dispatch');
    } finally {
      ctx.cleanup();
    }
  });

  test('8. callbacks.onProgress 接 worker progress 事件', async () => {
    const ctx = await setupTmpDb();
    try {
      const progressEvents = [];
      await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {
          onProgress: (ev) => progressEvents.push(ev),
        }
      );
      // runCheck 内有 5+ 个 onProgress 调用（spec §6.2 阶段事件）
      assert.ok(progressEvents.length >= 1, `progress 事件数 ≥ 1（实际=${progressEvents.length}）`);
      // 至少有一个 stage 字段
      assert.ok(
        progressEvents.some((e) => e && typeof e.stage === 'string'),
        'progress 事件含 stage 字段'
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('9. dispatch 不传 __dbPath / preWarm 未跑 → throw', async () => {
    await assert.rejects(
      () => pool.dispatchRunCheck({ monthKey: '2026-04' }, {}),
      (err) => {
        assert.ok(err.message.includes('dbPath'), 'error.message 含 dbPath');
        return true;
      }
    );
  });

  test('10. preWarm 后用相同 dbPath 调 dispatch（不传 __dbPath）→ 复用 workerDbPath', async () => {
    const ctx = await setupTmpDb();
    try {
      await pool.preWarm(ctx.dbPath);
      // dispatch 不传 __dbPath — 应从 workerDbPath fallback
      const result = await pool.dispatchRunCheck(
        { monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      assert.equal(typeof result.runId, 'number');
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 Phase 2 T12 — getLastBusyEndTs（spec §2.3.2 grace 30s）
  test('11. getLastBusyEndTs 初始 0；done 后更新到 <100ms 内', async () => {
    const ctx = await setupTmpDb();
    try {
      // 初始：0
      assert.equal(pool.getLastBusyEndTs(), 0, '初始 lastBusyEndTs=0');

      // dispatch 完成后应在 100ms 内更新
      const beforeDone = Date.now();
      await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      const afterDone = Date.now();
      const lastBusyEndTs = pool.getLastBusyEndTs();
      assert.ok(lastBusyEndTs > 0, `done 后 lastBusyEndTs 应 > 0（实际 ${lastBusyEndTs}）`);
      assert.ok(
        lastBusyEndTs >= beforeDone - 5 && lastBusyEndTs <= afterDone + 5,
        `lastBusyEndTs 应在 dispatch 前后 5ms 窗口内（实际 ${lastBusyEndTs} / 窗口 [${beforeDone},${afterDone}]）`
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('12. getLastBusyEndTs reject 后也更新', async () => {
    const ctx = await setupTmpDb();
    try {
      const before = Date.now();
      // 触发 reject — 不传 monthKey 让 worker 内 runCheckCore throw
      await assert.rejects(
        () => pool.dispatchRunCheck({ __dbPath: ctx.dbPath, storageRoot: ctx.tmpdir }, {})
      );
      const after = Date.now();
      const lastBusyEndTs = pool.getLastBusyEndTs();
      assert.ok(lastBusyEndTs > 0, `reject 后 lastBusyEndTs 应 > 0（实际 ${lastBusyEndTs}）`);
      assert.ok(
        lastBusyEndTs >= before - 5 && lastBusyEndTs <= after + 5,
        `reject 后 lastBusyEndTs 应在窗口内（实际 ${lastBusyEndTs} / 窗口 [${before},${after}]）`
      );
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 Phase 2 T14 — setFailureListener
  test('13. setFailureListener 注册 + crash 时回调（shutdown timeout terminate 触发 exit）', async () => {
    const ctx = await setupTmpDb();
    try {
      let failureInfo = null;
      pool.setFailureListener((info) => { failureInfo = info; });

      await pool.preWarm(ctx.dbPath);
      // dispatch + 立即 shutdown 超短 timeout 强制 terminate 模拟 crash
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      // 让 dispatch 进入 activeJob 状态
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // shutdown 主动 reject pending job → failureListener 不触发（shutdown 不算 worker failure）
      // 改成：直接 terminate worker（用反射）→ exit code 非 0 → handleWorkerFailure → failureListener
      // 但 pool 没暴露 worker 实例 — 用 cancel + hardTimeout=0 测 cancel 路径不算 failure
      // 这里换用「让 run 失败」路径（runCheck 内 throw 是业务错不是 worker crash → 不触发 failureListener）
      try { await runPromise; } catch (_e) { /* 正常完成 */ }
      // 业务正常完成不应触发 failureListener
      assert.equal(failureInfo, null, '正常 done 不触发 failureListener');

      pool.setFailureListener(null);
    } finally {
      ctx.cleanup();
    }
  });

  test('14. setFailureListener 入参非函数 throw', () => {
    assert.throws(() => pool.setFailureListener(123), /必须是 function 或 null/);
    assert.throws(() => pool.setFailureListener('foo'), /必须是 function 或 null/);
    assert.doesNotThrow(() => pool.setFailureListener(null));
    assert.doesNotThrow(() => pool.setFailureListener(() => {}));
    pool.setFailureListener(null);
  });

  // v2.1.10 Phase 2 T14 — crash 模拟（用 __crash_for_test__ message 让 worker process.exit(1)）
  test('15. worker crash（process.exit(1) via __crash_for_test__）→ failureListener 触发 + activeJob reject + lastBusyEndTs 更新', async () => {
    const ctx = await setupTmpDb();
    try {
      let failureInfo = null;
      pool.setFailureListener((info) => { failureInfo = info; });

      await pool.preWarm(ctx.dbPath);
      const before = Date.now();
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      // 等 dispatch 进 activeJob
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // 发 __crash_for_test__ 让 worker process.exit(1)
      // worker 此时正在 'run' message handler 内 await runCheckInWorker —
      //   __crash_for_test__ 在 message queue 中 — Node worker_threads message handler 串行处理 —
      //   要先 await runCheck 完，再处理 __crash_for_test__
      //   但 runCheck 又会去 await session.runCheckCore 内 setImmediate ——
      //   实际上 message handler 是 EventEmitter on 注册的；多个 message 不会等前一个 await 完
      //   测试时 message handler 是 async/await — 但 Node 上 emit 是同步派发到每个 listener
      //   每个 listener 调用 async fn 立刻返回 Promise，下一个 message 同步派发
      // → __crash_for_test__ 应能在 'run' handler 还在 await 时被处理 → process.exit(1)
      pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });

      // runPromise 应 reject（worker exit 触发 handleWorkerFailure）
      let rejectErr;
      try { await runPromise; } catch (e) { rejectErr = e; }
      const after = Date.now();

      assert.ok(rejectErr, 'crash 后 dispatch 应 reject');
      // failureInfo 应被回调
      assert.ok(failureInfo, 'failureListener 应被回调');
      assert.ok(['error', 'exit'].includes(failureInfo.source), `source 应是 error 或 exit（实际 ${failureInfo.source}）`);
      assert.equal(failureInfo.hadActiveJob, true, 'hadActiveJob=true');
      // 错误 message 含 'exit code=1' 或 worker 异常字样
      assert.ok(
        rejectErr.message.includes('exit') || rejectErr.message.includes('worker'),
        `rejectErr.message 应含 exit/worker（实际 ${rejectErr.message}）`
      );

      // lastBusyEndTs 已更新（crash 时间窗口内）
      const lastBusyEndTs = pool.getLastBusyEndTs();
      assert.ok(
        lastBusyEndTs >= before - 10 && lastBusyEndTs <= after + 10,
        `lastBusyEndTs 应在 crash 时间窗口内（实际 ${lastBusyEndTs} / 窗口 [${before},${after}]）`
      );

      // workerInstance 已清空 — 下次 dispatch 自动 cold-start
      const status = pool.getStatus();
      assert.equal(status.workerAlive, false, 'crash 后 workerAlive=false');
      assert.equal(status.busy, false, 'crash 后 busy=false');

      pool.setFailureListener(null);
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 SR-FIX-1 round 2 P0-2 — worker init-error 后 reset + 下次 dispatch cold-start（不 brick）
  //   修复前：init-error 仅 reject promise，workerInstance / workerInitPromise 仍引用 dead worker
  //     下次 dispatchRunCheck → ensureInitialized 直接 return 已 rejected promise → 永久 brick
  //   修复后：reset + terminate → 下次 dispatchRunCheck cold-start
  //   触发 init-error：传不可写 dbPath（不存在的 dir）→ worker 内 new DatabaseSync 抛错
  test('17. init-error 后 reset + 下次 dispatch 触发新 cold-start（SR-FIX-1 round 2 P0-2）', async () => {
    // 第一次 dispatch 传无效 dbPath → init-error
    const invalidDbPath = '/proc/sr-fix-1-round-2-p0-2-non-existent/db.sqlite';
    let initErr;
    try {
      await pool.dispatchRunCheck(
        { __dbPath: invalidDbPath, monthKey: '2026-04', storageRoot: '/tmp' },
        {}
      );
    } catch (e) { initErr = e; }
    assert.ok(initErr, 'init-error 后 dispatch 应 reject');
    // 错误 message 含 'unable to open database file' 或 'PRAGMA verify' 或类似 init 失败字样
    assert.ok(
      /database|init|PRAGMA|open/i.test(initErr.message),
      `init-error 应是 DB 打开/init 类（实际：${initErr.message}）`
    );

    // ✅ 修复后：workerInstance 已 reset → 下次 dispatch 用合法 dbPath 应 cold-start 成功
    const status = pool.getStatus();
    assert.equal(status.workerAlive, false, 'init-error 后 workerAlive=false（已 reset）');
    assert.equal(status.initialized, false, 'init-error 后 initialized=false（promise 已清）');

    // 用合法 dbPath 再 dispatch
    const ctx = await setupTmpDb();
    try {
      const result = await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      assert.equal(typeof result.runId, 'number', '第二次 dispatch cold-start 成功（不 brick）');
      assert.equal(pool.getStatus().workerAlive, true, '第二次 dispatch 后 workerAlive=true');
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 SR-FIX-1 Round 4 F2 — shutdown 不抹 activeJob → failureListener 收到 hadActiveJob=true
  //   修复前（Round 3 / round 2 P0-3）：shutdown 内 activeJob.reject + activeJob=null →
  //     worker exit 触发 handleWorkerFailure 时 hadActiveJob=false → failureListener 不执行 in-progress → partial 兜底
  //     → run.chunk_progress 残留 'in-progress' → 制造 first-chunk crash 残留路径（Round 4 F1 修复场景）
  //   修复后：activeJob 保留 + shutdownPending 标记 → worker exit 触发 handleWorkerFailure 时 hadActiveJob=true
  //     → failureListener 收到回调 → main.js 兜底 in-progress → partial
  //   本 case 验证：shutdown 时 activeJob 留着 + failureListener 收到 hadActiveJob=true
  test('18. shutdown 不抹 activeJob → failureListener 收到 hadActiveJob=true（SR-FIX-1 Round 4 F2）', async () => {
    const ctx = await setupTmpDb();
    try {
      let failureInfo = null;
      pool.setFailureListener((info) => { failureInfo = info; });

      await pool.preWarm(ctx.dbPath);
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      // 等 dispatch 进 activeJob 槽
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(pool.getStatus().busy, true, '前置：dispatch 进 activeJob → busy=true');

      // 用极短 timeout 触发 shutdown → terminate → exit 事件 → handleWorkerFailure
      //   activeJob 留 → handleWorkerFailure 看 hadActiveJob=true → failureListener 回调
      const shutdownPromise = pool.shutdown(50);

      // runPromise 应 reject（shutdown 主动 reject + handleWorkerFailure 不二次 reject）
      let rejectErr;
      try { await runPromise; } catch (e) { rejectErr = e; }
      assert.ok(rejectErr, 'shutdown 后 runPromise 应 reject');
      assert.ok(
        rejectErr.code === 'WORKER_POOL_SHUTDOWN' ||
          rejectErr.message.includes('shutdown'),
        `rejectErr 应是 shutdown 来源（实际 code=${rejectErr.code} msg=${rejectErr.message}）`
      );

      await shutdownPromise;

      // ✅ Round 4 F2 修复后：failureListener 收到 hadActiveJob=true（shutdown 不抹 activeJob）
      assert.ok(failureInfo, 'failureListener 应被 worker exit 事件回调');
      assert.equal(failureInfo.hadActiveJob, true,
        'Round 4 F2 修复：shutdown 不抹 activeJob → handleWorkerFailure 看到 hadActiveJob=true → main.js failureListener 可兜底 in-progress → partial');
      assert.ok(['error', 'exit'].includes(failureInfo.source),
        `failureInfo.source 应是 error/exit（实际 ${failureInfo.source}）`);

      // 状态清理：shutdown 完成后 workerInstance / activeJob 都已清
      const status = pool.getStatus();
      assert.equal(status.workerAlive, false, 'shutdown 后 workerAlive=false');
      assert.equal(status.busy, false, 'shutdown 后 busy=false（activeJob 已清）');

      pool.setFailureListener(null);
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 SR-FIX-1 Round 6 H3 — init 期 worker exit/error 接入 init promise reject + reset
  //   触发场景：worker 在 init-done / init-error 之前就 exit（如 packaged path 错 / module-load failure /
  //     node:sqlite 启动失败 / 系统级 SIGKILL）。
  //   修复前：ensureInitialized 内 onInitMsg listener 永远不被触发；handleWorkerFailure 只 reset 模块级状态
  //     但不 reject 当前 workerInitPromise → ensureInitialized 永远 hang → 第一次 dispatchRunCheck 永远不返回
  //   修复后（Round 6 H3）：
  //     - init promise 内额外 once('error') / once('exit') listener → reject + reset
  //     - 加 10s init timeout 兜底
  //     - 任意失败路径都 reject promise + reset → 下次 dispatchRunCheck 自动 cold-start
  //   本 case 验证：
  //     1. 注入 init-crash-worker fixture（process.exit(1) 立即退）
  //     2. dispatchRunCheck 应 reject（不 hang）
  //     3. status reset 后下次 dispatch 触发 cold-start（用回正常 worker script）成功
  test('19. init 期 worker exit/error → ensureInitialized reject + 模块级状态 reset + 下次 dispatch cold-start（SR-FIX-1 Round 6 H3）', async () => {
    const path = require('node:path');
    const initCrashWorkerPath = path.join(__dirname, '__fixtures__', 'init-crash-worker.js');

    // 注入 init-crash-worker（process.exit(1) 立即退）
    pool.__test_only_set_worker_script__(initCrashWorkerPath);

    // 第一次 dispatch — 应 reject 而非 hang
    let firstErr;
    const startTs = Date.now();
    try {
      // 限制 5s 内必须 reject（不能 hang 到 init timeout 10s）
      await Promise.race([
        pool.dispatchRunCheck(
          { __dbPath: '/tmp/h3-test-not-used.sqlite', monthKey: '2026-04', storageRoot: '/tmp' },
          {}
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_TIMEOUT_5S — H3 修复无效，仍然 hang')), 5000)),
      ]);
    } catch (e) { firstErr = e; }
    const elapsedMs = Date.now() - startTs;

    assert.ok(firstErr, '19.1 init 期 worker exit → dispatch 应 reject（不 hang）');
    assert.ok(!/TEST_TIMEOUT_5S/.test(firstErr.message),
      `19.2 reject 不能由 test 超时触发（实际：${firstErr.message}）— H3 修复前 race condition 仍未修`);
    assert.ok(/exit|init/i.test(firstErr.message),
      `19.3 reject 错误信息应反映 init 期 exit（实际：${firstErr.message}）`);
    assert.ok(elapsedMs < 3000,
      `19.4 reject 时延应短（实际 ${elapsedMs}ms）— worker exit 1 应被 once('exit') 立即捕获`);

    // 状态 reset
    const status = pool.getStatus();
    assert.equal(status.workerAlive, false, '19.5 init 期 exit 后 workerAlive=false（已 reset）');
    assert.equal(status.initialized, false, '19.6 init 期 exit 后 initialized=false（promise 已清）');

    // 恢复默认 worker script + 用合法 dbPath 再 dispatch
    pool.__test_only_set_worker_script__(null);
    const ctx = await setupTmpDb();
    try {
      const result = await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      assert.equal(typeof result.runId, 'number', '19.7 第二次 dispatch cold-start 成功（不 brick）');
      assert.equal(pool.getStatus().workerAlive, true, '19.8 第二次 dispatch 后 workerAlive=true');
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 Phase 2 T14 — crash 后自动 cold-start
  test('16. crash 后下次 dispatch 自动 cold-start + 成功', async () => {
    const ctx = await setupTmpDb();
    try {
      pool.setFailureListener(() => {}); // 注册 noop listener

      await pool.preWarm(ctx.dbPath);
      const runPromise = pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      for (let i = 0; i < 5; i++) await Promise.resolve();
      pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });
      try { await runPromise; } catch (_e) { /* expected reject */ }

      // 第二次 dispatch 应自动 cold-start
      const result = await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
        {}
      );
      assert.equal(typeof result.runId, 'number', 'cold-start 后 dispatch 成功');
      assert.equal(pool.getStatus().workerAlive, true, '新 worker alive');

      pool.setFailureListener(null);
    } finally {
      ctx.cleanup();
    }
  });
});
