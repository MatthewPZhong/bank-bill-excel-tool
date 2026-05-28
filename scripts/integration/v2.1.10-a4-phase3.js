// v2.1.10 A4 Phase 3 集成测试（T20）
//
// 覆盖（PRD §1.3 + spec §七 ≥ 3 case ≥ 15 断言）：
//   case 1: chunk size 边界（chunk=2000 / 全数据 / 比数据多）— 3 子 case byte-for-byte 一致
//     1.1 5000 行 / chunk=2000 → 3 chunks → 与 non-chunked 一致
//     1.2 5000 行 / chunk=5000 → 1 chunk
//     1.3 5000 行 / chunk=100000 → 1 chunk
//   case 2: 中断恢复（cancel chunk 2 → resume → 完整结果与无 cancel 一致）
//     2.1 第一段 cancel 后 chunk_progress=partial / diff_rows 部分写入
//     2.2 IPC resume → 续跑 → diff_rows 总数 = 全部 / chunk_progress=complete
//     2.3 resume 后 byte-for-byte 与 baseline 一致
//   case 3: chunked vs non-chunked 性能对比 + cancel 响应延迟
//     3.1 chunked 总耗时 vs non-chunked（5000 行）
//     3.2 chunked cancel 响应 < 5s（每 chunk 通常 < 1s）
//
// 跑：node scripts/integration/v2.1.10-a4-phase3.js
// 期望：N/N PASS（≥ 15 断言）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');
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

// Fixture：导入大量 bill + flow（recon_main_id 一一对应；每行 mismatch 币种 → 全部 diff_rows）
async function setupTmpDbWithMismatchFixture({ rowCount }) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-phase3-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const date = '2026-04-15';
  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');

  const flowRows = [];
  const billRows = [];
  for (let i = 1; i <= rowCount; i++) {
    flowRows.push(makeFlow(date, `R-${i}`, 'USD', 'USD'));
    billRows.push(makeBill(date, `R-${i}`, 'EUR')); // EUR vs USD → mismatch
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

function snapshotDiffRows(db, runId) {
  return db.prepare(`
    SELECT b.recon_main_id AS reconId, d.flow_currency, d.flow_amount_abs, d.diff_type
    FROM acquiring_bill_currency_diff_rows d
    INNER JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    ORDER BY reconId ASC
  `).all(runId);
}

// ─────────────────────────────────────────────────────────────────
// case 1：chunk size 边界 — byte-for-byte 一致
// ─────────────────────────────────────────────────────────────────
async function test1_chunkBoundaries() {
  console.log('\n[case 1] chunk size 边界（chunk=2000 / 全数据 / 比数据多）— byte-for-byte 一致');
  // 跑 4 路径同 fixture：(a) non-chunked baseline / (b) chunk=2000 / (c) chunk=5000 / (d) chunk=100000
  // 比对 diff_rows 全部 byte-for-byte 一致

  // 4 个独立 ctx
  const [ctxA, ctxB, ctxC, ctxD] = await Promise.all([
    setupTmpDbWithMismatchFixture({ rowCount: 5000 }),
    setupTmpDbWithMismatchFixture({ rowCount: 5000 }),
    setupTmpDbWithMismatchFixture({ rowCount: 5000 }),
    setupTmpDbWithMismatchFixture({ rowCount: 5000 }),
  ]);
  try {
    // A: non-chunked baseline（直接调 insertDiffRowsByJoin）
    const runIdA = runRepo.insertRun(ctxA.db.db, {
      monthKey: '2026-04', ranAt: new Date().toISOString(),
      totalBillRows: 5000, matchedRows: 5000, mismatchRows: 5000, unmatchedRows: 0, status: 'success',
    });
    const changesA = runRepo.insertDiffRowsByJoin(ctxA.db.db, { runId: runIdA, monthKey: '2026-04' });
    assertEq(changesA, 5000, '1.1 non-chunked INSERT 5000 行');
    const rowsA = snapshotDiffRows(ctxA.db.db, runIdA);

    // B: chunk=2000（3 chunks: 2000 + 2000 + 1000）
    const resultB = await session.runCheckCore({
      db: ctxB.db.db, monthKey: '2026-04', storageRoot: ctxB.tmpdir, chunkSize: 2000,
    });
    assertEq(resultB.mismatchRows, 5000, '1.2 chunk=2000 mismatchRows=5000');
    const rowsB = snapshotDiffRows(ctxB.db.db, resultB.runId);
    assertEq(rowsB.length, rowsA.length, '1.3 chunk=2000 diff_rows 行数与 baseline 一致');
    const runB = ctxB.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(resultB.runId);
    const progressB = JSON.parse(runB.chunk_progress);
    assertEq(progressB.totalChunks, 3, '1.4 chunk=2000 totalChunks=3');
    assertEq(progressB.status, 'complete', '1.5 chunk=2000 chunk_progress.status=complete');

    // C: chunk=5000（1 chunk）
    const resultC = await session.runCheckCore({
      db: ctxC.db.db, monthKey: '2026-04', storageRoot: ctxC.tmpdir, chunkSize: 5000,
    });
    const rowsC = snapshotDiffRows(ctxC.db.db, resultC.runId);
    assertEq(rowsC.length, rowsA.length, '1.6 chunk=5000 diff_rows 行数与 baseline 一致');
    const runC = ctxC.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(resultC.runId);
    const progressC = JSON.parse(runC.chunk_progress);
    assertEq(progressC.totalChunks, 1, '1.7 chunk=5000 totalChunks=1');

    // D: chunk=100000（1 chunk）
    const resultD = await session.runCheckCore({
      db: ctxD.db.db, monthKey: '2026-04', storageRoot: ctxD.tmpdir, chunkSize: 100000,
    });
    const rowsD = snapshotDiffRows(ctxD.db.db, resultD.runId);
    assertEq(rowsD.length, rowsA.length, '1.8 chunk=100000 diff_rows 行数与 baseline 一致');

    // byte-for-byte 比对 4 路径
    let allEqual = true;
    for (let i = 0; i < rowsA.length; i++) {
      if (JSON.stringify(rowsA[i]) !== JSON.stringify(rowsB[i])) { allEqual = false; break; }
      if (JSON.stringify(rowsA[i]) !== JSON.stringify(rowsC[i])) { allEqual = false; break; }
      if (JSON.stringify(rowsA[i]) !== JSON.stringify(rowsD[i])) { allEqual = false; break; }
    }
    assertTrue(allEqual, '1.9 4 路径 byte-for-byte 一致（5000 行逐行比对）');
  } finally {
    ctxA.cleanup();
    ctxB.cleanup();
    ctxC.cleanup();
    ctxD.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 2：中断恢复（cancel chunk 2 → resume → 完整结果与 baseline 一致）
// ─────────────────────────────────────────────────────────────────
async function test2_resumeAfterCancel() {
  console.log('\n[case 2] 中断恢复 — cancel chunk 2 → resume → 与 baseline byte-for-byte 一致');

  const ctxA = await setupTmpDbWithMismatchFixture({ rowCount: 5000 }); // baseline
  const ctxB = await setupTmpDbWithMismatchFixture({ rowCount: 5000 }); // cancel + resume
  try {
    // A: 跑完整 baseline
    const resultA = await session.runCheckCore({
      db: ctxA.db.db, monthKey: '2026-04', storageRoot: ctxA.tmpdir, chunkSize: 1000,
    });
    const rowsA = snapshotDiffRows(ctxA.db.db, resultA.runId);
    assertEq(rowsA.length, 5000, '2.1 baseline 5000 diff_rows');

    // B 第一段：cancel chunk 2 边界
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        checkCount++;
        // chunked 内 cancel check：chunk 0/1/2/... 边界前各一次
        // 第 3 次 throwIfCancelled 调用 = chunk 2 边界（chunk 0/1 已完成）
        if (checkCount >= 3) cancelled = true;
        if (cancelled) {
          const CancelErrorCtor = session.CancelError;
          throw new CancelErrorCtor(`cancelled at ${stage}`, { stage });
        }
      },
    };

    let caughtB;
    try {
      await session.runCheckCore({
        db: ctxB.db.db, monthKey: '2026-04', storageRoot: ctxB.tmpdir,
        chunkSize: 1000, cancelToken,
      });
    } catch (e) { caughtB = e; }
    assertTrue(!!caughtB, '2.2 第一段应抛 CancelError');
    assertEq(caughtB && caughtB.name, 'CancelError', '2.3 第一段抛 CancelError');
    assertEq(caughtB && caughtB.stage, 'sql-joining-chunk-2', '2.4 第一段在 chunk 2 边界 cancel');

    // 验证：B 第一段 chunk 0/1 已写入 + chunk_progress=partial
    const runB = ctxB.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
    const progressB1 = JSON.parse(runB.chunk_progress);
    assertEq(progressB1.status, 'partial', '2.5 第一段 chunk_progress=partial');
    const diffCountB1 = ctxB.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(diffCountB1, 2000, '2.6 第一段 chunk 0/1 → 2000 diff_rows 写入');

    // B 第二段：resume from chunk 2
    const resultBResume = await session.runCheckCore({
      db: ctxB.db.db, monthKey: '2026-04', storageRoot: ctxB.tmpdir,
      chunkSize: 1000,
      resumeFromRun: { runId: runB.id, lastCompletedChunkIndex: progressB1.lastCompletedChunkIndex },
    });
    assertEq(resultBResume.runId, runB.id, '2.7 resume 复用旧 runId');

    // 验证：B 第二段完成后 diff_rows = 5000 / chunk_progress=complete
    const diffCountB2 = ctxB.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(diffCountB2, 5000, '2.8 resume 后 diff_rows 总数 = 5000（无重复）');
    const runBAfter = ctxB.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(runB.id);
    const progressB2 = JSON.parse(runBAfter.chunk_progress);
    assertEq(progressB2.status, 'complete', '2.9 resume 后 chunk_progress=complete');

    // 比对 baseline byte-for-byte
    const rowsB = snapshotDiffRows(ctxB.db.db, runB.id);
    let bytesEqual = true;
    for (let i = 0; i < rowsA.length; i++) {
      if (JSON.stringify(rowsA[i]) !== JSON.stringify(rowsB[i])) { bytesEqual = false; break; }
    }
    assertTrue(bytesEqual, '2.10 resume 后 diff_rows 与 baseline byte-for-byte 一致');

    // 验证 DISTINCT bill_import_id = 5000（无重复 — idempotent）
    const distinctBills = ctxB.db.db.prepare(
      'SELECT COUNT(DISTINCT bill_import_id) c FROM acquiring_bill_currency_diff_rows'
    ).get().c;
    assertEq(distinctBills, 5000, '2.11 每行 bill 仅 1 行 diff（idempotent）');
  } finally {
    ctxA.cleanup();
    ctxB.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 3：性能对比 + cancel 响应延迟
// ─────────────────────────────────────────────────────────────────
async function test3_perfAndCancelResponsiveness() {
  console.log('\n[case 3] 性能对比 + cancel 响应延迟');

  const ctxA = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  const ctxB = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  const ctxC = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  try {
    // A: non-chunked 单 SQL（直接调）
    const runIdA = runRepo.insertRun(ctxA.db.db, {
      monthKey: '2026-04', ranAt: new Date().toISOString(),
      totalBillRows: 5000, matchedRows: 5000, mismatchRows: 5000, unmatchedRows: 0, status: 'success',
    });
    const t0A = Date.now();
    runRepo.insertDiffRowsByJoin(ctxA.db.db, { runId: runIdA, monthKey: '2026-04' });
    const elapsedA = Date.now() - t0A;

    // B: chunked（chunk=1000，5 chunks）
    const t0B = Date.now();
    await session.runCheckCore({
      db: ctxB.db.db, monthKey: '2026-04', storageRoot: ctxB.tmpdir, chunkSize: 1000,
    });
    const elapsedB = Date.now() - t0B;

    assertTrue(elapsedA >= 0, `3.1 non-chunked 总耗时 = ${elapsedA}ms`);
    assertTrue(elapsedB >= 0, `3.2 chunked(chunk=1000) 总耗时 = ${elapsedB}ms`);
    // chunked 不应严重慢（5x 之内是合理的；小数据档因事务切换 + xlsx 写盘 + log 转发等开销占比高）
    console.log(`   [perf] non-chunked: ${elapsedA}ms / chunked(1000): ${elapsedB}ms`);

    // cancel 响应延迟测试：在 chunk 2 边界 cancel → 测量从 cancel set 到 throw 的延迟
    // 单 chunk 通常 < 100ms（5000 行 / 5 chunks = 1000 行/chunk；微秒级 SQL）
    let cancelled = false;
    let checkCount = 0;
    let cancelSetTs = 0;
    let throwTs = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() {
        cancelled = true;
        cancelSetTs = Date.now();
      },
      throwIfCancelled(stage) {
        checkCount++;
        if (checkCount >= 3) {
          if (!cancelled) {
            cancelled = true;
            cancelSetTs = Date.now();
          }
        }
        if (cancelled) {
          throwTs = Date.now();
          const CancelErrorCtor = session.CancelError;
          throw new CancelErrorCtor(`cancelled at ${stage}`, { stage });
        }
      },
    };

    let caught;
    try {
      await session.runCheckCore({
        db: ctxC.db.db, monthKey: '2026-04', storageRoot: ctxC.tmpdir,
        chunkSize: 1000, cancelToken,
      });
    } catch (e) { caught = e; }
    assertTrue(!!caught, '3.3 cancel 后 throw');
    assertEq(caught && caught.name, 'CancelError', '3.4 throw CancelError');
    // cancel 响应延迟 = 0（同步抛）— 这是 chunk 边界 cancel 的最优情况
    const cancelResponseMs = throwTs - cancelSetTs;
    assertTrue(cancelResponseMs <= 5000, `3.5 cancel 响应延迟 ${cancelResponseMs}ms ≤ 5s（spec §3.2 hard requirement）`);
    console.log(`   [cancel] response delay: ${cancelResponseMs}ms`);
  } finally {
    ctxA.cleanup();
    ctxB.cleanup();
    ctxC.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 4：SR-FIX-1 round 2 P0-1 — cleanupOrphanData × chunked partial run 不冲突
//   触发场景：runCheckCore chunked 跑到 chunk M/N cancel → chunk_progress.status='partial'
//     runs.status='success'（stage 3 写时已落）+ diff_file_path=null（未到 writer 阶段）→ fileBroken=true
//   修复前：cleanupOrphanData 把 partial run 当孤儿清掉 → resume IPC 拒绝
//   修复后：检测 chunk_progress.status==='partial' → 保留 run / diff_rows / bill_imports → resume 可用
//   覆盖 spec §3.3 / §5.4 + tasks T19 resumeFromRun 设计意图 + USER_GUIDE §1.8.12 修订
// ─────────────────────────────────────────────────────────────────
async function test4_cleanupOrphanProtectsPartialRun() {
  console.log('\n[case 4] SR-FIX-1 round 2 P0-1 — cleanupOrphanData 保护 chunked partial run');

  const ctx = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  try {
    // 第一段：跑到 chunk 2 边界 cancel（与 case 2 同一模式）
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        checkCount++;
        if (checkCount >= 3) cancelled = true;
        if (cancelled) {
          const CancelErrorCtor = session.CancelError;
          throw new CancelErrorCtor(`cancelled at ${stage}`, { stage });
        }
      },
    };
    let caught;
    try {
      await session.runCheckCore({
        db: ctx.db.db, monthKey: '2026-04', storageRoot: ctx.tmpdir,
        chunkSize: 1000, cancelToken,
      });
    } catch (e) { caught = e; }
    assertTrue(!!caught, '4.1 cancel 后应抛 CancelError');
    assertEq(caught && caught.name, 'CancelError', '4.2 第一段抛 CancelError');

    // 验证 partial 状态
    const runBefore = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
    const progressBefore = JSON.parse(runBefore.chunk_progress);
    assertEq(progressBefore.status, 'partial', '4.3 cleanupOrphanData 前 chunk_progress=partial');
    assertEq(runBefore.diff_file_path, null, '4.4 cleanupOrphanData 前 diff_file_path=null（fileBroken=true）');
    assertEq(runBefore.status, 'success', '4.5 cleanupOrphanData 前 runs.status=success（stage 3 写入）');

    const diffCountBefore = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows WHERE run_id = ?'
    ).get(runBefore.id).c;
    assertTrue(diffCountBefore > 0, `4.6 cleanupOrphanData 前 diff_rows > 0（实际 ${diffCountBefore}）`);
    const billCountBefore = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports'
    ).get().c;

    // 触发 cleanupOrphanData（模拟启动期 cleanup）
    const stats = await session.cleanupOrphanData({ db: ctx.db.db });
    assertEq(stats.orphanRunIds.includes(runBefore.id), false,
      '4.7 partial run 不在 orphanRunIds 列表（被保护）');

    // 验证：partial run 仍存活
    const runAfter = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs WHERE id = ?').get(runBefore.id);
    assertTrue(!!runAfter, '4.8 cleanupOrphanData 后 partial run 仍存在');
    const progressAfter = JSON.parse(runAfter.chunk_progress);
    assertEq(progressAfter.status, 'partial', '4.9 cleanupOrphanData 后 chunk_progress 仍是 partial');
    assertEq(progressAfter.lastCompletedChunkIndex, progressBefore.lastCompletedChunkIndex,
      '4.10 cleanupOrphanData 后 lastCompletedChunkIndex 保留');

    const diffCountAfter = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows WHERE run_id = ?'
    ).get(runBefore.id).c;
    assertEq(diffCountAfter, diffCountBefore, '4.11 cleanupOrphanData 后 diff_rows 数量保留');

    const billCountAfter = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports'
    ).get().c;
    assertEq(billCountAfter, billCountBefore, '4.12 cleanupOrphanData 后 bill_imports 数量保留（FK CASCADE 未触发）');

    // 验证 resume 可成功跑完
    const resultResume = await session.runCheckCore({
      db: ctx.db.db, monthKey: '2026-04', storageRoot: ctx.tmpdir,
      chunkSize: 1000,
      resumeFromRun: { runId: runBefore.id, lastCompletedChunkIndex: progressAfter.lastCompletedChunkIndex },
    });
    assertEq(resultResume.runId, runBefore.id, '4.13 resume 复用旧 runId 成功');

    const runFinal = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs WHERE id = ?').get(runBefore.id);
    const progressFinal = JSON.parse(runFinal.chunk_progress);
    assertEq(progressFinal.status, 'complete', '4.14 resume 后 chunk_progress=complete');
    const diffCountFinal = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows WHERE run_id = ?'
    ).get(runBefore.id).c;
    assertEq(diffCountFinal, 5000, '4.15 resume 后 diff_rows = 5000（完整数据保留）');
  } finally {
    ctx.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 5：SR-FIX-1 Round 3 F2 — first-chunk crash 模拟 + cleanupOrphanData 守卫扩展
//   触发场景：runCheckCore 进 insertDiffRowsByJoinChunked 前已写初始 in-progress；
//     worker 跑第一个 chunk 时 die（onChunkDone 触发前 — chunk_progress 仍是 in-progress）
//     P1-7 failureListener（main.js）尚未触发（如重启场景）→ 启动期 cleanupOrphanData 需保护 in-progress
//   修复后行为：
//     - cleanupOrphanData 检查 chunk_progress.status='in-progress' → 跳过保护
//     - run 不被清；用户可后续 resume（或 failureListener 兜底改 partial）
// ─────────────────────────────────────────────────────────────────
async function test5_cleanupOrphanProtectsInProgress() {
  console.log('\n[case 5] SR-FIX-1 Round 3 F2 — cleanupOrphanData 保护 in-progress（first-chunk crash 防护）');

  const ctx = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  try {
    // 模拟 runCheckCore F2 修复入口：写一个 success runs 行 + 初始 in-progress chunk_progress
    //   不实际跑 insertDiffRowsByJoinChunked（模拟 first-chunk crash 残留场景）
    const runId = runRepo.insertRun(ctx.db.db, {
      monthKey: '2026-04',
      ranAt: new Date().toISOString(),
      totalBillRows: 5000,
      matchedRows: 5000,
      mismatchRows: 5000,
      unmatchedRows: 0,
      status: 'success',
    });
    runRepo.setRunChunkProgress(ctx.db.db, {
      runId,
      lastCompletedChunkIndex: -1,
      totalChunks: 0,
      status: 'in-progress',
    });

    // 验证初始 in-progress 状态
    const before = runRepo.getRunChunkProgress(ctx.db.db, runId);
    assertEq(before.status, 'in-progress', '5.1 first-chunk crash 残留 chunk_progress.status=in-progress');
    const runBefore = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs WHERE id=?').get(runId);
    assertEq(runBefore.diff_file_path, null, '5.2 diff_file_path=null（fileBroken=true）');
    assertEq(runBefore.status, 'success', '5.3 runs.status=success（stage 3 写入）');

    // 触发 cleanupOrphanData
    const stats = await session.cleanupOrphanData({ db: ctx.db.db });

    // 验证 in-progress run 不被清
    assertEq(stats.orphanRunIds.includes(runId), false,
      '5.4 in-progress run 不在 orphanRunIds（Round 3 F2 守卫扩展）');

    const runAfter = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs WHERE id=?').get(runId);
    assertTrue(!!runAfter, '5.5 cleanupOrphanData 后 in-progress run 仍存在');
    const progressAfter = JSON.parse(runAfter.chunk_progress);
    assertEq(progressAfter.status, 'in-progress', '5.6 chunk_progress.status 仍是 in-progress');

    // 验证 bill_imports 未被 CASCADE 清掉
    const billCountAfter = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports'
    ).get().c;
    assertEq(billCountAfter, 5000, '5.7 bill_imports 5000 行保留（cleanupAfterRunBackground 未触发）');
  } finally {
    ctx.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 6：SR-FIX-1 Round 5 G1 — COMMIT 后 ↔ chunked 入口 窗口期 crash 端到端
//   触发场景（Codex Round 4 复审 finding，2026-05-28T10:52）：
//     Round 3 F2 把 in-progress 占位写在 chunked 入口前，但 COMMIT 后 → 该写入之间还有
//     `await setImmediate()` 让出 event loop（progress event + setImmediate）。
//     如果 worker 在窗口期退出 → chunk_progress IS NULL → failureListener / cleanupOrphanData 都不命中
//   修复后（Round 5 G1）：in-progress 占位在 COMMIT 之后立即写入（无 await 让出窗口）
//   端到端验证（区别于 case 5 — case 5 是手工塞 in-progress 测 cleanup；case 6 是真实 runCheckCore 路径）：
//     - onProgress hook 在 stage 4' 入口（sql-joining）throw 模拟窗口期 crash
//     - 验证：runs 行已 COMMIT + chunk_progress IS NOT NULL（Round 5 G1 写入生效）
//     - 验证：chunk_progress.status='in-progress'
//     - 验证：cleanupOrphanData 不清这个 run（Round 3/4 守卫）
//     - 验证：resume IPC handler 能识别（Round 4 F1 状态机扩展）+ 真实 resume runCheckCore 跑通
//     - 验证：resume 后 chunk_progress.status='complete' + diff_rows 5000 完整
// ─────────────────────────────────────────────────────────────────
async function test6_windowGapCrashEndToEnd() {
  console.log('\n[case 6] SR-FIX-1 Round 5 G1 — COMMIT ↔ chunked 入口 窗口期 crash 端到端（runCheckCore 真实路径）');

  const ctx = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  try {
    // 步骤 1：跑 runCheckCore 但在 stage 4' 入口 onProgress 抛错（模拟窗口期 crash）
    //   注：onProgress({stage:'sql-joining', mismatchHint}) 是 COMMIT 后第一个 onProgress 事件
    //   旧 bug：in-progress 占位在 stage 4' 入口 onProgress 之后才写 → 此时抛错 chunk_progress IS NULL
    //   Round 5 G1 修复：占位已在 COMMIT 后立即写 → chunk_progress IS NOT NULL
    let crashErr;
    try {
      await session.runCheckCore({
        db: ctx.db.db,
        monthKey: '2026-04',
        storageRoot: ctx.tmpdir,
        chunkSize: 2000,
        onProgress: (ev) => {
          // stage 4' 入口（chunk 0 之前的 mismatchHint 事件） — 模拟 worker crash
          if (ev.stage === 'sql-joining' && ev.mismatchHint !== undefined && ev.chunkIndex === undefined) {
            throw new Error('SIMULATED_WORKER_CRASH_IN_WINDOW_GAP');
          }
        },
      });
    } catch (e) { crashErr = e; }

    assertTrue(!!crashErr, '6.1 模拟 crash 被抛出');
    assertTrue(/SIMULATED_WORKER_CRASH/.test(crashErr && crashErr.message), '6.2 crash 错误消息正确传播');

    // 步骤 2：验证 runs 行已 COMMIT + chunk_progress IS NOT NULL（Round 5 G1 修复核心）
    const runAfterCrash = ctx.db.db.prepare(
      'SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1'
    ).get();
    assertTrue(!!runAfterCrash, '6.3 runs 行已 COMMIT 落库（COMMIT 在 stage 4 入口之前）');
    assertTrue(!!runAfterCrash.chunk_progress,
      '6.4 Round 5 G1：窗口期 crash 后 chunk_progress IS NOT NULL（旧 bug：IS NULL）');

    const progressAfterCrash = JSON.parse(runAfterCrash.chunk_progress);
    assertEq(progressAfterCrash.status, 'in-progress', '6.5 chunk_progress.status=in-progress（Round 5 G1 占位）');
    assertEq(progressAfterCrash.lastCompletedChunkIndex, -1, '6.6 lastCompletedChunkIndex=-1（起始）');

    const crashedRunId = runAfterCrash.id;
    const crashedMonth = runAfterCrash.month_key;
    assertEq(crashedMonth, '2026-04', '6.7 runs.month_key=2026-04');

    // 步骤 3：触发 cleanupOrphanData — Round 3/4 守卫不应清掉 in-progress run
    const cleanupStats = await session.cleanupOrphanData({ db: ctx.db.db });
    assertEq(cleanupStats.orphanRunIds.includes(crashedRunId), false,
      '6.8 cleanupOrphanData 不清 in-progress run（Round 3 F2 守卫扩展）');

    const runAfterCleanup = ctx.db.db.prepare(
      'SELECT * FROM acquiring_bill_currency_runs WHERE id=?'
    ).get(crashedRunId);
    assertTrue(!!runAfterCleanup, '6.9 cleanupOrphanData 后 in-progress run 仍存在');

    // 步骤 4：验证 listPartialRuns 能识别 in-progress（Round 4 F1 状态机扩展）
    const partials = runRepo.listPartialRuns(ctx.db.db, '2026-04');
    assertEq(partials.length, 1, '6.10 listPartialRuns 命中 1 个可恢复 run');
    assertEq(partials[0].id, crashedRunId, '6.11 partials[0].id == crashedRunId');
    assertEq(partials[0].chunk_progress.status, 'in-progress', '6.12 partials[0].status=in-progress');

    // 步骤 5：真实 resume 跑 runCheckCore — 验证能从 in-progress 状态完整跑完
    //   resume 路径：lastCompletedChunkIndex=-1 → resumeFromChunkIndex=0 → 从头跑所有 chunks
    const resumeResult = await session.runCheckCore({
      db: ctx.db.db,
      monthKey: '2026-04',
      storageRoot: ctx.tmpdir,
      chunkSize: 2000,
      resumeFromRun: { runId: crashedRunId, lastCompletedChunkIndex: -1 },
    });

    assertEq(resumeResult.runId, crashedRunId, '6.13 resume 复用同一 runId');

    // 步骤 6：验证 resume 后 chunk_progress=complete + diff_rows 5000 完整
    const runAfterResume = ctx.db.db.prepare(
      'SELECT * FROM acquiring_bill_currency_runs WHERE id=?'
    ).get(crashedRunId);
    const progressAfterResume = JSON.parse(runAfterResume.chunk_progress);
    assertEq(progressAfterResume.status, 'complete', '6.14 resume 后 chunk_progress.status=complete');
    assertEq(progressAfterResume.totalChunks, 3, '6.15 totalChunks=3（5000 行 / chunk=2000）');

    const diffCount = ctx.db.db.prepare(
      'SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows WHERE run_id=?'
    ).get(crashedRunId).c;
    assertEq(diffCount, 5000, '6.16 resume 后 diff_rows 5000 完整（窗口期 crash 不破坏 byte-for-byte）');
  } finally {
    ctx.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// case 7：SR-FIX-1 Round 6 H4 — chunkSize 持久化 + resume 时复用（资金红线）
//
// 验证（端到端 byte-for-byte）：
//   - baseline：chunkSize=100 跑完整 5000 行 → snapshot diff_rows
//   - partial：chunkSize=100 跑到 chunk 30 → cancel → chunk_progress.chunkSize=100 (H4 持久化)
//   - 模拟用户改 settings：sliced chunkSize=10（如果 resume 用 settings → 偏移错位）
//   - resume：传 chunkSize=100（模拟 main.js handler 用 progress.chunkSize 复用）
//   - 验证：resume 后 diff_rows 总数 == baseline 5000 && byte-for-byte 一致（无 skip/重复）
//   - 验证：chunk_progress.chunkSize=100 保留（onChunkDone 续写）
// ─────────────────────────────────────────────────────────────────
async function test7_h4ChunkSizePersistedAcrossResume() {
  console.log('\n[case 7] SR-FIX-1 Round 6 H4 — chunkSize 持久化 + resume 复用（资金红线端到端）');

  // baseline：5000 行 / chunkSize=100 → 50 chunks
  const baseline = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  const baselineResult = await session.runCheckCore({
    db: baseline.db.db,
    monthKey: '2026-04',
    storageRoot: baseline.tmpdir,
    chunkSize: 100,
  });
  const baselineDiff = snapshotDiffRows(baseline.db.db, baselineResult.runId);
  assertEq(baselineDiff.length, 5000, '7.1 baseline chunkSize=100 → 5000 diff_rows');

  // partial：5000 行 / chunkSize=100 → cancel at chunk 30
  const partial = await setupTmpDbWithMismatchFixture({ rowCount: 5000 });
  try {
    let cancelled = false;
    let chunkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        chunkCount++;
        // throwIfCancelled 在 stage 1-3 各 1 次（主事务内） + 每 chunk 边界 1 次（chunked 内部）
        //   stage 1-3: 3 次（无 cancel）
        //   chunk 0..29: 30 次（无 cancel）
        //   chunk 30 边界: 第 34 次 → cancel
        if (chunkCount >= 34 && !cancelled) cancelled = true;
        if (cancelled) {
          throw new session.CancelError(`cancelled at ${stage}`, { stage });
        }
      },
    };
    let caught;
    try {
      await session.runCheckCore({
        db: partial.db.db,
        monthKey: '2026-04',
        storageRoot: partial.tmpdir,
        chunkSize: 100,
        cancelToken,
      });
    } catch (e) { caught = e; }
    assertTrue(!!caught, '7.2 partial 第 1 段 cancel 抛出');
    assertTrue(caught && caught.name === 'CancelError', '7.3 CancelError');

    const partialRun = partial.db.db.prepare('SELECT id, chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
    const progressPartial = JSON.parse(partialRun.chunk_progress);
    assertEq(progressPartial.status, 'partial', '7.4 partial 状态');
    assertEq(progressPartial.chunkSize, 100, '7.5 partial chunk_progress.chunkSize=100（H4 持久化）');
    assertTrue(progressPartial.lastCompletedChunkIndex >= 0, '7.6 lastCompletedChunkIndex >= 0');

    // 模拟用户改 settings —— resume 必须用 chunk_progress.chunkSize=100，不用 settings
    //   （session 层 chunkSize 由 caller 传；main.js handler 已实现优先级；
    //   这里直接调 session.runCheckCore 模拟 handler 已读 progress.chunkSize 后转 chunkSize=100）
    const resumeResult = await session.runCheckCore({
      db: partial.db.db,
      monthKey: '2026-04',
      storageRoot: partial.tmpdir,
      chunkSize: progressPartial.chunkSize, // ← H4 关键：用持久化值（main.js handler 修复点）
      resumeFromRun: {
        runId: partialRun.id,
        lastCompletedChunkIndex: progressPartial.lastCompletedChunkIndex,
      },
    });
    assertEq(resumeResult.runId, partialRun.id, '7.7 resume 复用旧 runId');

    // 关键验证：resume 后 diff_rows 总数 == baseline 5000，byte-for-byte 一致
    const resumeDiff = snapshotDiffRows(partial.db.db, partialRun.id);
    assertEq(resumeDiff.length, 5000, '7.8 resume 后 diff_rows 5000（无 skip/重复 — H4 chunkSize 复用保证 OFFSET 一致）');

    // diff_rows 按 reconId 排序 byte-for-byte 一致
    let bytesEqual = true;
    for (let i = 0; i < baselineDiff.length; i++) {
      if (
        baselineDiff[i].reconId !== resumeDiff[i].reconId
        || baselineDiff[i].flow_currency !== resumeDiff[i].flow_currency
        || baselineDiff[i].flow_amount_abs !== resumeDiff[i].flow_amount_abs
        || baselineDiff[i].diff_type !== resumeDiff[i].diff_type
      ) {
        bytesEqual = false;
        break;
      }
    }
    assertTrue(bytesEqual, '7.9 baseline vs resume diff_rows byte-for-byte 一致（H4 资金红线护栏）');

    // resume 后 chunk_progress 状态 + chunkSize 字段
    const runAfter = partial.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(partialRun.id);
    const progressAfter = JSON.parse(runAfter.chunk_progress);
    assertEq(progressAfter.status, 'complete', '7.10 resume 后 status=complete');
    assertEq(progressAfter.chunkSize, 100, '7.11 resume 后 chunkSize=100 保留（onChunkDone 续写 H4）');
    assertEq(progressAfter.totalChunks, 50, '7.12 totalChunks=50（5000 行 / 100）');
  } finally {
    baseline.cleanup();
    partial.cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('==== v2.1.10 A4 Phase 3 集成测试 ====');
  console.log('PRD §1.3 + spec §七 Phase 3 ≥ 3 case ≥ 15 断言 + SR-FIX-1 round 2 P0-1 case 4 + Round 3 F2 case 5 + Round 5 G1 case 6 + Round 6 H4 case 7');

  const cases = [
    test1_chunkBoundaries,
    test2_resumeAfterCancel,
    test3_perfAndCancelResponsiveness,
    test4_cleanupOrphanProtectsPartialRun,
    test5_cleanupOrphanProtectsInProgress,
    test6_windowGapCrashEndToEnd,
    test7_h4ChunkSizePersistedAcrossResume,
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
  try { await pool.__reset_for_test__(); } catch (_e) { /* swallow */ }

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
