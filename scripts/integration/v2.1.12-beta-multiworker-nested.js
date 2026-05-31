// v2.1.12 β.1-T3 集成测试 —— 多 worker write-splitting 嵌套拓扑 go/no-go（🔴 资金红线）
//
// 验证整条激活链 + 嵌套 worker 拓扑能否在本项目 Node 下跑通：
//   main(测试进程) → pool.dispatchRunCheck → dispatch worker(run-check-worker.js)
//     → runCheckCore 内 workerCount>1 → 再 spawn M 个 nested worker(run-check-multiworker-worker.js)
//     → 各 nested worker 并行 SELECT JOIN 写自己 temp db → dispatch worker 主连接按 chunkIndex 升序 ATTACH 汇总 INSERT
//
// 🔴 byte-for-byte（资金红线）：多 worker（经嵌套链）产出的 diff_rows 必须与单 worker in-process 基线逐行一致。
//   这是 contract GroupB（runCheckCore 在主进程直跑 M worker）覆盖不到的「嵌套」case——唯一能验真 nested 拓扑的路径。
//
// 用 __forceMultiWorkerForTest 跳过 D31 行数闸（小数据也强制多 worker）；显式小 chunkSize 制造 chunk 数 > worker 数。
//
// 跑：node scripts/integration/v2.1.12-beta-multiworker-nested.js
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

function makeFlow(date, id, flowCcy) {
  const r = new Array(48).fill('');
  r[0] = date; r[6] = id; r[12] = '100'; r[13] = flowCcy; r[28] = '100'; r[29] = flowCcy;
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

// 造 rowCount 行：每 3 行一个币种差异（bill=EUR vs flow=USD）→ diff 约 rowCount/3 行
async function setupDbWithData(tag, rowCount, date = '2026-04-15', monthKey = '2026-04') {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `mw-nested-${tag}-`));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');
  const flowRows = [];
  const billRows = [];
  for (let i = 1; i <= rowCount; i++) {
    flowRows.push(makeFlow(date, `INT-${i}`, 'USD'));
    billRows.push(makeBill(date, `INT-${i}`, i % 3 === 0 ? 'EUR' : 'USD')); // 每 3 行 1 差异
  }
  await writeXlsx(flowFile, FLOW_HEADERS, flowRows);
  await writeXlsx(billFile, BILL_HEADERS, billRows);
  await session.importFlowFiles({ db: db.db, monthKey, filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey, filePaths: [billFile] });

  return {
    tmpdir, dbPath, db, monthKey,
    cleanup() {
      try { db.db.close(); } catch (_e) { /* ignore */ }
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    },
  };
}

// 读某 DB 的 diff_rows（按物理插入顺序 id ASC）→ 四列字符串数组（byte-for-byte 比对口径）
function readDiffRows(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(dbPath);
  try {
    const rows = d.prepare(
      'SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type FROM acquiring_bill_currency_diff_rows ORDER BY id ASC'
    ).all();
    return rows.map((r) => `${r.bill_import_id}|${r.flow_currency}|${r.flow_amount_abs}|${r.diff_type}`);
  } finally {
    try { d.close(); } catch (_e) { /* ignore */ }
  }
}

async function main() {
  console.log('=== v2.1.12 β.1-T3 多 worker 嵌套拓扑集成测试 ===\n');

  const ROW_COUNT = 240;          // 240 行 → 80 差异行
  const CHUNK_SIZE = 50;          // 显式小 chunkSize（非 baseline 100000）→ 240/50 = 5 chunks > 4 worker
  const WORKER_COUNT = 4;
  const EXPECTED_DIFF = Math.floor(ROW_COUNT / 3); // 80

  // ── 基线：单 worker in-process（workerCount 默认 1，走 insertDiffRowsByJoinChunked）──
  const baseCtx = await setupDbWithData('base', ROW_COUNT);
  let baseDiff = null;
  try {
    const r = await session.runCheckCore({
      db: baseCtx.db.db,
      monthKey: baseCtx.monthKey,
      storageRoot: baseCtx.tmpdir,
      chunkSize: CHUNK_SIZE,
    });
    assertTrue(!!r && !!r.runId, '基线.单worker run 成功返回 runId');
    assertEq(r.mismatchRows, EXPECTED_DIFF, `基线.单worker diff 行数 = ${EXPECTED_DIFF}`);
    baseCtx.db.db.close(); // 释放连接后读盘
    baseDiff = readDiffRows(baseCtx.dbPath);
    assertEq(baseDiff.length, EXPECTED_DIFF, '基线.diff_rows 落库行数一致');
  } finally {
    baseCtx.cleanup();
  }

  // ── 多 worker：经 dispatchRunCheck → dispatch worker → nested worker ──
  const mwCtx = await setupDbWithData('mw', ROW_COUNT);
  let mwDiff = null;
  let mwResult = null;
  let mwError = null;
  const tempDir = path.join(mwCtx.tmpdir, '.mw-tmp');
  try {
    mwCtx.db.db.close(); // 关测试进程连接，避免与 worker 抢（worker 各自 open）
    mwResult = await pool.dispatchRunCheck(
      {
        __dbPath: mwCtx.dbPath,
        monthKey: mwCtx.monthKey,
        storageRoot: mwCtx.tmpdir,
        chunkSize: CHUNK_SIZE,
        workerCount: WORKER_COUNT,
        tempDir,
        __forceMultiWorkerForTest: true, // 强制走多 worker（跳过 D31 行数闸）
      },
      { onProgress: () => { /* 吞掉进度 */ } }
    );
  } catch (err) {
    mwError = err;
  } finally {
    try { await pool.shutdown(2000); } catch (_e) { /* ignore */ }
    if (typeof pool.__reset_for_test__ === 'function') {
      try { await pool.__reset_for_test__(); } catch (_e) { /* ignore */ }
    }
  }

  // 🔴 嵌套拓扑 go/no-go：整条链不报错即证明 nested worker 能起
  assertTrue(mwError === null, `🔴 嵌套链跑通无错（实际：${mwError ? mwError.message : 'OK'}）`);
  assertTrue(!!mwResult && !!mwResult.runId, '多worker run 成功返回 runId');
  if (mwResult) {
    assertEq(mwResult.mismatchRows, EXPECTED_DIFF, `多worker diff 行数 = ${EXPECTED_DIFF}`);
  }
  mwDiff = readDiffRows(mwCtx.dbPath);
  assertEq(mwDiff.length, EXPECTED_DIFF, '多worker.diff_rows 落库行数一致');
  mwCtx.cleanup();

  // ── 🔴 byte-for-byte：多 worker（嵌套）== 单 worker 基线，逐行一致 ──
  if (baseDiff && mwDiff) {
    let firstDiffAt = -1;
    const n = Math.max(baseDiff.length, mwDiff.length);
    for (let i = 0; i < n; i++) {
      if (baseDiff[i] !== mwDiff[i]) { firstDiffAt = i; break; }
    }
    assertEq(firstDiffAt, -1, '🔴 byte-for-byte：多worker(嵌套) diff_rows 与单worker基线逐行完全一致');
    if (firstDiffAt !== -1) {
      console.log(`  首个差异 @${firstDiffAt}: base="${baseDiff[firstDiffAt]}" mw="${mwDiff[firstDiffAt]}"`);
    }
  }

  // ── 汇总 ──
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) {
    console.log('\n失败明细：');
    for (const f of failures) {
      console.log(`  ✖ ${f.label}\n     actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    }
    process.exit(1);
  }
  console.log('✓ 全部通过 — 嵌套 worker 拓扑跑通 + byte-for-byte 一致');
}

main().catch((err) => {
  console.error('集成测试异常：', err);
  process.exit(1);
});
