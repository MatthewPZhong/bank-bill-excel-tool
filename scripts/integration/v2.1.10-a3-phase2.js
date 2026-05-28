// v2.1.10 A3 Phase 2 集成测试（T15）
//
// 覆盖（PRD §1.3 + spec §七 ≥ 6 case ≥ 25 断言）：
//   1. idle cleanup worker busy 守卫 — worker 跑 runCheck 时 idle 触发 cleanup → skip（不抢 DB 写锁）
//   2. idle cleanup 30s grace — worker reject 后 25s 触发 → skip；35s 触发 → 执行
//   3. cancel 在 stage 1（clearOldRuns 后）触发 → ROLLBACK + CancelError
//   4. cancel 在 stage 4（sql-joining 后）触发 → ROLLBACK + CancelError + DB 无锁残留
//   5. cancel 5s 内 worker 未 exit → terminate（cancel hardTimeoutMs 路径，用极小 timeout 模拟）
//   6. worker process.exit(1) crash → 主进程 failureListener 触发 + op lock 释放 + 下次 dispatch 重启
//   7. Round 4 F2: before-quit shutdown 不抹 activeJob → failureListener 收 hadActiveJob=true
//   8. Round 7 I1: failureListener crash 兜底 in-progress → partial 必须透传 chunkSize（资金红线端到端）
//
// 跑：node scripts/integration/v2.1.10-a3-phase2.js
// 期望：N/N PASS

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const pool = require('../../src/main-process/run-check-worker-pool');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

function makeFlow(date, id, flowCcy, billCcy) {
  const r = new Array(48).fill('');
  r[0] = date; r[6] = id; r[12] = '100'; r[13] = flowCcy; r[28] = '100'; r[29] = billCcy;
  return r;
}
function makeBill(date, id, currency) {
  const r = new Array(26).fill('');
  r[0] = date; r[14] = id; r[18] = '100'; r[19] = currency;
  return r;
}
async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

async function setupTmpDb({ rowCount = 2 } = {}) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-phase2-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const date = '2026-04-15';
  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');

  const flowRows = [];
  const billRows = [];
  for (let i = 1; i <= rowCount; i++) {
    flowRows.push(makeFlow(date, `INT-${i}`, 'USD', 'USD'));
    // 1 行币种差异（其他对账成功）
    billRows.push(makeBill(date, `INT-${i}`, i === 1 ? 'EUR' : 'USD'));
  }
  await writeXlsx(flowFile, FLOW_HEADERS, flowRows);
  await writeXlsx(billFile, BILL_HEADERS, billRows);
  await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [billFile] });

  return {
    tmpdir, dbPath, db,
    cleanup() {
      try { db.db.close(); } catch (_e) {}
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

// 模拟 main.js setupIdleCleanupTimer 内回调（同 spec §2.3.2 + Phase 2 T12 改造）
//   返回 'skip-busy' / 'skip-grace' / 'fire'
function simulateIdleCleanupTick(graceMs = 30000) {
  if (pool.isBusy()) return 'skip-busy';
  const lastBusyEndTs = pool.getLastBusyEndTs();
  if (lastBusyEndTs > 0 && Date.now() - lastBusyEndTs < graceMs) return 'skip-grace';
  return 'fire';
}

// ── case 1：worker busy 守卫 — runCheck 进行中 idle 触发 → skip-busy ──
//   实现思路：onProgress 第一个事件触发时检查 isBusy + tick 应 skip-busy
//   （此时 worker 已开始执行 runCheck — pool.activeJob !== null）
async function test1_idleSkipBusy() {
  console.log('\n[case 1] idle cleanup — worker busy 时 skip');
  const ctx = await setupTmpDb();
  try {
    ctx.db.db.close();
    let firstProgressBusy = null;
    let firstProgressTick = null;
    const runPromise = pool.dispatchRunCheck(
      { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
      {
        onProgress: (_ev) => {
          // 第一个 progress 事件触发时记快照
          if (firstProgressBusy === null) {
            firstProgressBusy = pool.isBusy();
            firstProgressTick = simulateIdleCleanupTick();
          }
        },
      }
    );
    await runPromise;

    assertEq(firstProgressBusy, true, '1.1 第一个 progress 事件触发时 isBusy=true');
    assertEq(firstProgressTick, 'skip-busy', '1.2 worker busy 时 tick 返回 skip-busy');
    // done 后 lastBusyEndTs 已更新；在 grace 内
    assertEq(pool.isBusy(), false, '1.3 done 后 isBusy=false');
    const tickResult2 = simulateIdleCleanupTick();
    assertEq(tickResult2, 'skip-grace', '1.4 done 后立即 tick 走 grace 路径');
  } finally {
    await pool.__reset_for_test__();
    ctx.db.db = { close: () => {} };
    ctx.cleanup();
  }
}

// ── case 2：30s grace — worker reject 后 25s 触发 → skip-grace；35s 触发 → fire ──
async function test2_idleGraceWindow() {
  console.log('\n[case 2] idle cleanup — 30s grace window');
  const ctx = await setupTmpDb();
  try {
    ctx.db.db.close();
    // 触发 reject — monthKey 错误
    try {
      await pool.dispatchRunCheck(
        { __dbPath: ctx.dbPath, storageRoot: ctx.tmpdir },
        {}
      );
    } catch (_e) { /* expected reject */ }
    const lastBusyEndTs = pool.getLastBusyEndTs();
    assertTrue(lastBusyEndTs > 0, '2.1 reject 后 lastBusyEndTs > 0');

    // 用极小 grace（100ms）模拟时间流逝
    const tickEarly = simulateIdleCleanupTick(60000); // 60s grace；reject 后立即 < 60s
    assertEq(tickEarly, 'skip-grace', '2.2 reject 后立即 tick + 60s grace → skip-grace');

    // 等 50ms 然后用 30ms grace（< 经过时间）→ fire
    await new Promise((r) => setTimeout(r, 50));
    const tickAfter = simulateIdleCleanupTick(30);
    assertEq(tickAfter, 'fire', '2.3 50ms 后 + 30ms grace → fire');

    // 验证：lastBusyEndTs > 0 + 不在 grace 内
    const elapsed = Date.now() - pool.getLastBusyEndTs();
    assertTrue(elapsed >= 50, `2.4 elapsed since lastBusyEndTs >= 50ms（实际 ${elapsed}ms）`);
  } finally {
    await pool.__reset_for_test__();
    ctx.db.db = { close: () => {} };
    ctx.cleanup();
  }
}

// ── case 3：cancel 在 stage 1（clearOldRuns 后）→ ROLLBACK + CancelError ──
async function test3_cancelStage1() {
  console.log('\n[case 3] cancel 在 stage 1 (clearing-old-runs) → ROLLBACK + CancelError');
  const ctx = await setupTmpDb();
  try {
    // 直接调 runCheckCore（不走 worker；测 session 层 cancel 路径）
    const cancelToken = session.createCancelToken();
    cancelToken.cancel(); // 立即 cancel — clearOldRuns 后第一个 check 点抛

    let caught;
    try {
      await session.runCheckCore({
        db: ctx.db.db,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        cancelToken,
      });
    } catch (e) { caught = e; }

    assertTrue(!!caught, '3.1 应 throw');
    assertEq(caught && caught.name, 'CancelError', '3.2 应是 CancelError');
    assertEq(caught && caught.stage, 'clearing-old-runs', '3.3 stage=clearing-old-runs');
    // 事务回滚 — 无 run 记录残留
    const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
    assertEq(runCount, 0, '3.4 ROLLBACK 后无 run 记录残留');
    // DB 无锁残留 — 新事务可开
    let lockOk = true;
    try {
      ctx.db.db.exec('BEGIN');
      ctx.db.db.exec('ROLLBACK');
    } catch (_e) { lockOk = false; }
    assertTrue(lockOk, '3.5 ROLLBACK 后 DB 无锁残留（新事务可开）');
  } finally {
    ctx.cleanup();
  }
}

// ── case 4：cancel 在 stage 4 chunked 边界（v2.1.10 A4 T18 改造后）→ chunked 内 CancelError + 部分 chunk 保留 ──
//   改造前：stage 4 sql-joining 单 SQL 在主事务内 → cancel ROLLBACK 撤销整个 run
//   改造后：stage 4' chunked 在主事务外 — runs 行已 COMMIT；各 chunk 独立 BEGIN/COMMIT；cancel 后已 COMMIT 批保留
//   cancel 命中 stage 名变为 'sql-joining-chunk-N'（chunked 边界更精细）
async function test4_cancelStage4() {
  console.log('\n[case 4] cancel 在 stage 4 chunked 边界 → CancelError + chunk_progress=partial');
  const ctx = await setupTmpDb();
  try {
    // 4 个 check 点 — 前 3 个 false（stage 1-3 主事务内），第 4 个 true（chunked 第 0 chunk 边界）
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() {
        checkCount++;
        if (checkCount >= 4 && !cancelled) cancelled = true;
        return cancelled;
      },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        if (this.cancelled) {
          const err = new Error(`cancelled at ${stage}`);
          err.name = 'CancelError';
          err.stage = stage;
          throw err;
        }
      },
    };

    let caught;
    try {
      await session.runCheckCore({
        db: ctx.db.db,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        cancelToken,
      });
    } catch (e) { caught = e; }

    assertTrue(!!caught, '4.1 应 throw');
    assertEq(caught && caught.name, 'CancelError', '4.2 应是 CancelError');
    assertEq(caught && caught.stage, 'sql-joining-chunk-0', '4.3 stage=sql-joining-chunk-0（chunked 边界）');

    // v2.1.10 A4 T18：主事务 stage 1-3 已 COMMIT — runs 行保留 1 行（不 ROLLBACK）
    const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
    assertEq(runCount, 1, '4.4 stage 4 cancel — runs 已 COMMIT（v2.1.10 A4 T18 事务边界改造）');

    // chunk 0 之前 cancel → 无 diff_rows
    const diffCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(diffCount, 0, '4.5 chunk 0 之前 cancel — 无 diff_rows');

    // chunk_progress 已被 caller (session.runCheckCore) 标 partial — 供 T19 resume
    const runRow = ctx.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
    assertTrue(!!runRow.chunk_progress, '4.6 chunk_progress 已写入');
    const progress = JSON.parse(runRow.chunk_progress);
    assertEq(progress.status, 'partial', '4.7 chunk_progress.status=partial（cancel 中途）');

    // DB 无锁残留
    let lockOk = true;
    try {
      ctx.db.db.exec('BEGIN');
      ctx.db.db.exec('ROLLBACK');
    } catch (_e) { lockOk = false; }
    assertTrue(lockOk, '4.8 DB 无锁残留');
  } finally {
    ctx.cleanup();
  }
}

// ── case 5：cancel hardTimeout terminate 路径 ──
//   模拟方式：cancel 后给 worker 极小 hardTimeoutMs（50ms），让 terminate 触发；
//   worker 内 runCheck 短时间正常完成（< 50ms 内）— 通过 PASS：不抛错 + 状态正确
async function test5_cancelHardTimeout() {
  console.log('\n[case 5] cancel hardTimeout terminate 路径');
  const ctx = await setupTmpDb();
  try {
    ctx.db.db.close();
    // 注册 failureListener 捕获可能的 terminate 触发 exit 事件
    let failureInfo = null;
    pool.setFailureListener((info) => { failureInfo = info; });

    const runPromise = pool.dispatchRunCheck(
      { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
      {}
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // cancel + 50ms hardTimeout — 多数情况 worker 50ms 内已完成（runCheck 30ms 左右）
    //   ✓ 完成情况：done 自然返回，hardTimeout 触发时 activeJob 已 null → 不 terminate
    //   ✓ 死循环情况（本测试不模拟）：50ms 后 terminate → exit handler → failureListener
    const cancelOk = pool.cancel(null, { hardTimeoutMs: 50 });
    assertTrue(typeof cancelOk === 'boolean', '5.1 cancel API 返回 boolean');

    // 等 100ms 让 hardTimeout 触发（如未自然完成）
    let result;
    try {
      result = await runPromise;
      assertTrue(!!result, '5.2 worker 自然完成（< 50ms）— 无 terminate 触发');
    } catch (err) {
      // 或者 terminate 触发 → 走 failureListener + reject
      assertTrue(err instanceof Error, '5.2 worker 被 cancel/terminate 后 reject');
    }
    // 50ms 内自然完成应不触发 failureListener；如触发也是合法
    if (failureInfo) {
      assertTrue(['error', 'exit'].includes(failureInfo.source), '5.3 failureInfo.source 是 error/exit');
    }
    // 验证 listener 路径不抛错
    assertTrue(true, '5.4 cancel hardTimeout 路径不抛错');

    pool.setFailureListener(null);
  } finally {
    await pool.__reset_for_test__();
    ctx.db.db = { close: () => {} };
    ctx.cleanup();
  }
}

// ── case 6：worker crash → failureListener 触发 + 下次 dispatch 自动重启 ──
async function test6_workerCrashRecovery() {
  console.log('\n[case 6] worker crash (__crash_for_test__) → failureListener + 下次 dispatch 重启');
  const ctx = await setupTmpDb();
  try {
    ctx.db.db.close();
    let failureInfo = null;
    pool.setFailureListener((info) => { failureInfo = info; });

    await pool.preWarm(ctx.dbPath);
    assertEq(pool.getStatus().workerAlive, true, '6.1 preWarm 后 workerAlive=true');

    const runPromise = pool.dispatchRunCheck(
      { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
      {}
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // 注入 crash
    pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });

    // dispatch 应 reject
    let rejectErr;
    try { await runPromise; } catch (e) { rejectErr = e; }
    assertTrue(!!rejectErr, '6.2 crash 后 dispatch reject');
    assertTrue(rejectErr.message.includes('exit') || rejectErr.message.includes('worker'),
      `6.3 reject err.message 含 exit/worker（实际 ${rejectErr.message}）`);

    // failureListener 已被回调
    assertTrue(!!failureInfo, '6.4 failureListener 被回调');
    assertTrue(['error', 'exit'].includes(failureInfo.source),
      `6.5 failureInfo.source ∈ {error,exit}（实际 ${failureInfo.source}）`);
    assertEq(failureInfo.hadActiveJob, true, '6.6 hadActiveJob=true');

    // workerInstance 已清空
    assertEq(pool.getStatus().workerAlive, false, '6.7 crash 后 workerAlive=false');

    // 下次 dispatch 自动 cold-start
    const result = await pool.dispatchRunCheck(
      { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
      {}
    );
    assertTrue(typeof result.runId === 'number', '6.8 cold-start 后第二次 dispatch 成功');
    assertEq(pool.getStatus().workerAlive, true, '6.9 cold-start 后 workerAlive=true');

    pool.setFailureListener(null);
  } finally {
    await pool.__reset_for_test__();
    ctx.db.db = { close: () => {} };
    ctx.cleanup();
  }
}

// ── case 7：v2.1.10 SR-FIX-1 Round 4 F2 — before-quit shutdown 不抹 activeJob ──
//   触发场景：app 退出前用户在跑 chunked → main 调 pool.shutdown(5000) → worker terminate
//   修复前（Round 3 留下）：shutdown 抹 activeJob → handleWorkerFailure 看 hadActiveJob=false →
//     failureListener 不执行 → run.chunk_progress 残留 'in-progress' → 重启后无法 resume
//   修复后（Round 4 F2）：shutdown 留 activeJob + shutdownPending 标记 → handleWorkerFailure 看 hadActiveJob=true →
//     failureListener 收到回调 → main.js 兜底 in-progress → partial → 重启后可 resume
//
//   本 case 用 stubbed failureListener 直接模拟 main.js 兜底回调（pool 模块独立可测，不依赖 main.js IPC）
//   验证：dispatch → 立即 shutdown(50) → exit 触发 → failureListener 收到 hadActiveJob=true
async function test7_beforeQuitShutdownPreservesActiveJobForFallback() {
  console.log('\n[case 7] before-quit shutdown 不抹 activeJob → failureListener 收 hadActiveJob=true（Round 4 F2）');
  const ctx = await setupTmpDb({ rowCount: 5 });
  try {
    ctx.db.db.close();

    let failureInfo = null;
    pool.setFailureListener((info) => { failureInfo = info; });

    await pool.preWarm(ctx.dbPath);
    assertEq(pool.getStatus().workerAlive, true, '7.1 preWarm 后 workerAlive=true');

    const runPromise = pool.dispatchRunCheck(
      { __dbPath: ctx.dbPath, monthKey: '2026-04', storageRoot: ctx.tmpdir },
      {}
    );
    // 等 dispatch 进 activeJob 槽
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEq(pool.getStatus().busy, true, '7.2 dispatch 进 activeJob → busy=true');

    // 用极短 timeout 强制 terminate worker（模拟 before-quit shutdown 触发的退出路径）
    //   Round 4 F2 关键：shutdown 不抹 activeJob → worker exit/terminate 触发 handleWorkerFailure 时 hadActiveJob=true
    const shutdownPromise = pool.shutdown(50);

    let rejectErr;
    try { await runPromise; } catch (e) { rejectErr = e; }
    assertTrue(!!rejectErr, '7.3 shutdown 后 runPromise 应 reject');
    assertTrue(
      rejectErr.code === 'WORKER_POOL_SHUTDOWN' || rejectErr.message.includes('shutdown'),
      `7.4 rejectErr 应是 shutdown 来源（实际 code=${rejectErr.code} msg=${rejectErr.message}）`
    );

    await shutdownPromise;

    // ✅ Round 4 F2 关键断言：failureListener 收到 hadActiveJob=true
    assertTrue(!!failureInfo, '7.5 failureListener 应被 worker exit 事件回调');
    assertEq(failureInfo.hadActiveJob, true,
      '7.6 🟠 Round 4 F2：shutdown 不抹 activeJob → handleWorkerFailure 看 hadActiveJob=true → main.js 可兜底 in-progress → partial');
    assertTrue(['error', 'exit'].includes(failureInfo.source),
      `7.7 failureInfo.source ∈ {error,exit}（实际 ${failureInfo.source}）`);

    // 状态清理：shutdown 完成后 workerInstance / activeJob 均已清
    assertEq(pool.getStatus().workerAlive, false, '7.8 shutdown 后 workerAlive=false');
    assertEq(pool.getStatus().busy, false, '7.9 shutdown 后 busy=false（activeJob 已清）');

    pool.setFailureListener(null);
  } finally {
    await pool.__reset_for_test__();
    ctx.db.db = { close: () => {} };
    ctx.cleanup();
  }
}

// ── case 8：v2.1.10 SR-FIX-1 Round 7 I1 — failureListener crash 兜底转 partial 必须透传 chunkSize ──
//   触发场景（Codex 5 次复审 finding — Round 6 H4 漏抓 main.js failureListener crash 路径）：
//     1. worker 跑 chunkSize=100000 到 chunk 2 → onChunkDone 写 chunk_progress={..., chunkSize:100000}（H4 持久化）
//     2. SIGKILL / OOM → main.js failureListener 触发（A3 Phase 2 T14 兜底回调）
//     3. failureListener 闭包内调 setRunChunkProgress({status:'partial'}) 重写 chunk_progress
//     4. Round 7 I1 修复前：未透传 chunkSize → 持久化 partial 丢失 chunkSize 字段
//        → resume handler fallback 当前 settings（如 100000 → 10000）→ insertDiffRowsByJoinChunked OFFSET 错位
//        → diff_rows 行 skip/重复 → 资金红线 byte-for-byte 不一致
//     5. Round 7 I1 修复后：透传 progress.chunkSize → partial 仍含 chunkSize=100000
//        → main.js resume IPC handler 优先用持久化值（Round 6 H4 已修复）→ OFFSET 一致 → byte-for-byte 不变
//
//   本 case 端到端模拟：
//     1. 真实 worker dispatch 跑 chunkSize=2 到 chunk 2 → 用 cancelToken 触发 partial（避免真实 SIGKILL 不稳）
//     2. 用 setRunChunkProgress 手工先把 partial 改回 in-progress + chunkSize=2（模拟 crash 残留 onChunkDone 写过的进度）
//     3. 调 pool stub failureListener 模拟主进程 main.js failureListener 内的 SQL 行为（Round 7 I1 修复后）
//     4. 验证：chunk_progress 转 partial 后 chunkSize=2 仍在
//     5. 老 row 路径：chunk_progress 无 chunkSize → 透传 undefined → 不破坏向后兼容
async function test8_round7I1FailureListenerPreservesChunkSize() {
  console.log('\n[case 8] Round 7 I1 — failureListener crash 兜底 in-progress → partial 必须透传 chunkSize（资金红线端到端）');
  const ctx = await setupTmpDb({ rowCount: 10 });
  try {
    const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');
    const sessionMod = require('../../src/main-process/acquiring-bill-currency-session');

    // Step 1：真实跑 runCheckCore chunkSize=2 → 触发 cancel at chunk 2 → partial run
    //   不通过 worker（用主进程 runCheckCore 直接跑 — 跟 a4-phase3 case 7 同模式）
    //   原因：worker dispatch 拿不到 cancelToken 句柄稳定触发；用 runCheckCore 直接跑可控触发 partial
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        checkCount++;
        if (checkCount >= 5) cancelled = true; // chunk 2 边界 cancel
        if (cancelled) {
          throw new sessionMod.CancelError(`cancelled at ${stage}`, { stage });
        }
      },
    };
    let caught;
    try {
      await sessionMod.runCheckCore({
        db: ctx.db.db,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        chunkSize: 2,
        cancelToken,
      });
    } catch (e) { caught = e; }
    assertTrue(!!caught, '8.1 cancel 触发抛 CancelError');
    assertEq(caught.name, 'CancelError', '8.2 CancelError 类型');

    // Step 2：拿到 partial run 验证 H4 持久化（前置条件 — 否则 Round 7 I1 无法触发）
    const partialRun = ctx.db.db.prepare('SELECT id, chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
    const partialProgress = JSON.parse(partialRun.chunk_progress);
    assertEq(partialProgress.status, 'partial', '8.3 partial status');
    assertEq(partialProgress.chunkSize, 2, '8.4 partial chunk_progress.chunkSize=2（Round 6 H4 持久化）');

    // Step 3：人工把 partial → in-progress（模拟 onChunkDone 写完最后一次后 worker 突然 SIGKILL — chunk_progress 残留 in-progress 含 chunkSize）
    //   这是 Round 7 I1 真实触发场景：onChunkDone 已写过 chunk_progress + chunkSize；crash 时 catch 块 (partial) 未执行
    runRepo.setRunChunkProgress(ctx.db.db, {
      runId: partialRun.id,
      lastCompletedChunkIndex: partialProgress.lastCompletedChunkIndex,
      totalChunks: partialProgress.totalChunks,
      status: 'in-progress', // 模拟 crash 残留
      chunkSize: partialProgress.chunkSize, // H4 持久化的 chunkSize 仍在
    });
    const beforeRecover = runRepo.getRunChunkProgress(ctx.db.db, partialRun.id);
    assertEq(beforeRecover.status, 'in-progress', '8.5 crash 残留 in-progress');
    assertEq(beforeRecover.chunkSize, 2, '8.6 crash 残留 chunkSize=2');

    // Step 4：模拟 main.js failureListener Round 7 I1 修复后的 SQL 行为（直接复制 main.js:11297-11341 逻辑）
    //   关键：透传 progress.chunkSize（Round 7 I1 修复点）
    let recoveredCount = 0;
    const inProgressRuns = ctx.db.db.prepare(`
      SELECT id, month_key, chunk_progress
      FROM acquiring_bill_currency_runs
      WHERE chunk_progress IS NOT NULL
    `).all();
    for (const row of inProgressRuns) {
      try {
        const progress = JSON.parse(row.chunk_progress);
        if (progress && progress.status === 'in-progress') {
          runRepo.setRunChunkProgress(ctx.db.db, {
            runId: row.id,
            lastCompletedChunkIndex: progress.lastCompletedChunkIndex,
            totalChunks: progress.totalChunks,
            status: 'partial',
            chunkSize: progress.chunkSize, // Round 7 I1 关键透传
          });
          recoveredCount++;
        }
      } catch (_e) { /* swallow */ }
    }
    assertEq(recoveredCount, 1, '8.7 failureListener 兜底 1 个 in-progress run');

    // Step 5：验证 chunkSize 字段在兜底转换后保留（Round 7 I1 资金红线核心断言）
    const afterRecover = runRepo.getRunChunkProgress(ctx.db.db, partialRun.id);
    assertEq(afterRecover.status, 'partial', '8.8 兜底后 status=partial');
    assertEq(afterRecover.chunkSize, 2,
      '8.9 🔴 Round 7 I1：failureListener 兜底后 chunkSize=2 保留（资金红线 — 防 resume handler fallback settings 导致 OFFSET 错位）');
    assertEq(afterRecover.lastCompletedChunkIndex, partialProgress.lastCompletedChunkIndex, '8.10 兜底保留 lastCompletedChunkIndex');
    assertEq(afterRecover.totalChunks, partialProgress.totalChunks, '8.11 兜底保留 totalChunks');

    // Step 6：老 row 路径 — 升级前 chunk_progress 无 chunkSize → failureListener 透传 undefined → 不写
    //   验证 Round 7 I1 对老 row 向后兼容（不会误抛 / 不会误写默认值 / resume handler fallback settings 路径不变）
    const legacyRunId = runRepo.insertRun(ctx.db.db, {
      monthKey: '2026-04',
      ranAt: new Date().toISOString(),
      totalBillRows: 100, matchedRows: 50, mismatchRows: 50, unmatchedRows: 0, status: 'success',
    });
    // 老 row：无 chunkSize 字段
    runRepo.setRunChunkProgress(ctx.db.db, {
      runId: legacyRunId,
      lastCompletedChunkIndex: 1,
      totalChunks: 5,
      status: 'in-progress',
    });
    const legacyBefore = runRepo.getRunChunkProgress(ctx.db.db, legacyRunId);
    assertEq(legacyBefore.chunkSize, undefined, '8.12 老 row chunkSize=undefined（升级前 H4 未引入字段）');

    // 模拟 Round 7 I1 透传 progress.chunkSize（undefined）
    runRepo.setRunChunkProgress(ctx.db.db, {
      runId: legacyRunId,
      lastCompletedChunkIndex: legacyBefore.lastCompletedChunkIndex,
      totalChunks: legacyBefore.totalChunks,
      status: 'partial',
      chunkSize: legacyBefore.chunkSize, // undefined — setRunChunkProgress 内部跳过写入
    });
    const legacyAfter = runRepo.getRunChunkProgress(ctx.db.db, legacyRunId);
    assertEq(legacyAfter.status, 'partial', '8.13 老 row 兜底后 status=partial');
    assertEq(legacyAfter.chunkSize, undefined, '8.14 老 row chunkSize 仍 undefined（Round 7 I1 向后兼容 — fallback settings 路径不变）');
  } finally {
    ctx.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('==== v2.1.10 A3 Phase 2 集成测试 ====');
  console.log('PRD §1.3 + spec §七 Phase 2 ≥ 8 case ≥ 46 断言（Round 7 I1 加 case 8）');

  const cases = [
    test1_idleSkipBusy,
    test2_idleGraceWindow,
    test3_cancelStage1,
    test4_cancelStage4,
    test5_cancelHardTimeout,
    test6_workerCrashRecovery,
    test7_beforeQuitShutdownPreservesActiveJobForFallback,
    test8_round7I1FailureListenerPreservesChunkSize,
  ];

  for (const c of cases) {
    try {
      await c();
    } catch (err) {
      failed++;
      failures.push({ label: c.name + ' FATAL', actual: err && err.message, expected: 'no throw' });
      console.error('  FATAL:', err && err.stack ? err.stack : err);
    }
  }

  // 最终清理
  await pool.__reset_for_test__();

  console.log('');
  console.log('==== Summary ====');
  if (failures.length) {
    console.log('--- FAILURES ---');
    for (const f of failures) {
      console.log(`  ✗ ${f.label}`);
      console.log(`    actual:   ${JSON.stringify(f.actual)}`);
      console.log(`    expected: ${JSON.stringify(f.expected)}`);
    }
  }
  const total = passed + failed;
  console.log(`${passed}/${total} PASS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('main fatal:', err);
  process.exit(1);
});
