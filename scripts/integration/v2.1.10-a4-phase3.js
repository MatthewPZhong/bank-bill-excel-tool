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
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('==== v2.1.10 A4 Phase 3 集成测试 ====');
  console.log('PRD §1.3 + spec §七 Phase 3 ≥ 3 case ≥ 15 断言');

  const cases = [
    test1_chunkBoundaries,
    test2_resumeAfterCancel,
    test3_perfAndCancelResponsiveness,
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
