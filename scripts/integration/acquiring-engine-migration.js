// 收单导入引擎迁移 全链对比集成验证（v3.0.3 PR-H）🔴🔴 资金红线（迁移前后 byte-for-byte 放行闸）
//
// 覆盖（spec §5 / PR-H 验收）：同一组 fixture（flow+bill / 多文件 / 混币种 / UNIQUE 冲突 / 跨月 / 坏表头）
//   分别跑「旧路径（ACQUIRING_FORCE_LEGACY_IMPORT=1，reader-handrolled 直调）」vs「新路径（默认引擎 worker）」：
//     ① 成功导入：两库逐行（含 rowid 序）byte-for-byte 相等 + runCheck 对账统计（matched/mismatch/unmatched/total）相等
//     ② UNIQUE 冲突 / 跨月 / 坏表头：报错 message / detailLines / name 逐字符相等（整批拒绝 + 表空）
//     ③ overwrite 重导：行集相等
//
// 开关可测性：本脚本用子进程（spawnSync）跑导入——子进程 env 注入 ACQUIRING_FORCE_LEGACY_IMPORT=1 走旧路径，
//   不设则走引擎默认路径。生产代码路径不被污染（env 仅本测试子进程内生效）。导入到两个独立 DB 文件后主进程对比。
//
// 用法：node scripts/integration/acquiring-engine-migration.js（integration-runner.js 自动发现）
//   子进程模式：node scripts/integration/acquiring-engine-migration.js --child <opJsonPath> <dbPath>

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ExcelJS = require('exceljs');

const { FLOW_HEADERS, BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

// ─────────────────────── 子进程模式：执行一组导入操作 + dump 结果 ───────────────────────
//   op JSON：{ tmpdir, monthKey, ops:[{ method, kind, filePaths }], dumpAfter:bool, runCheck:bool }
//     method ∈ importFlow/importBill/importFlowOverwrite/importBillOverwrite
//   输出到 stdout 一行 JSON：{ ok, results:[...], error:{name,message,detailLines}|null, dump, stats }
async function runChild(opJsonPath, dbPath) {
  const op = JSON.parse(fs.readFileSync(opJsonPath, 'utf8'));
  const { AppDatabase } = require('../../src/backend/database');
  const session = require('../../src/main-process/acquiring-bill-currency-session');

  const db = new AppDatabase(dbPath);
  db.init();

  const out = { ok: true, results: [], error: null, dump: null, stats: null };
  try {
    for (const o of op.ops) {
      const fn = {
        importFlow: session.importFlowFiles,
        importBill: session.importBillFiles,
        importFlowOverwrite: session.importFlowFilesWithOverwrite,
        importBillOverwrite: session.importBillFilesWithOverwrite
      }[o.method];
      const r = await fn({ db: db.db, monthKey: op.monthKey, filePaths: o.filePaths });
      // 仅取稳定字段对比（totalImported / fileCount / monthKey / deletedCount）；perFileStats 形状两路不同（已知，不比）。
      out.results.push({
        totalImported: r.totalImported,
        fileCount: r.fileCount,
        monthKey: r.monthKey,
        deletedCount: r.deletedCount === undefined ? null : r.deletedCount
      });
    }
    if (op.runCheck) {
      const rc = await session.runCheck({ db: db.db, monthKey: op.monthKey });
      out.stats = {
        totalBillRows: rc.totalBillRows,
        matchedRows: rc.matchedRows,
        mismatchRows: rc.mismatchRows,
        unmatchedRows: rc.unmatchedRows
      };
    }
  } catch (err) {
    out.ok = false;
    out.error = {
      name: err && err.name ? err.name : 'Error',
      message: err && err.message ? err.message : String(err),
      detailLines: err && Array.isArray(err.detailLines) ? err.detailLines : []
    };
  } finally {
    // dump 在 finally（成功 / 失败均 dump）：失败场景需读表验证 ROLLBACK 表空（byte-for-byte 表空对比）。
    if (op.dumpAfter) {
      try { out.dump = dumpDb(db.db); } catch (_e) { out.dump = { flow: [], bill: [] }; }
    }
    try { db.db.close(); } catch (_e) { /* swallow */ }
  }
  process.stdout.write(JSON.stringify(out));
}

// 逐行含 rowid（id）dump flow + bill 两表（byte-for-byte 对比基准；ORDER BY id ASC = rowid 序）。
function dumpDb(db) {
  const flow = db.prepare(
    'SELECT id, month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json FROM acquiring_bill_currency_flow_imports ORDER BY id ASC'
  ).all();
  const bill = db.prepare(
    'SELECT id, month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json FROM acquiring_bill_currency_bill_imports ORDER BY id ASC'
  ).all();
  return { flow, bill };
}

// ─────────────────────── 主进程模式 ───────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, detail: `actual=${a} expected=${e}` });
}
function assertTrue(cond, label, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, detail: detail === undefined ? String(cond) : detail });
}

// fixture 构造（与 smoke 同形态：flow 48 列 / bill 26 列）。
function makeFlow(id, billDate, settleAmount, settleCurrency) {
  const r = new Array(48).fill('');
  r[0] = billDate; r[6] = id;
  r[12] = String(settleAmount); r[13] = settleCurrency;       // 订单视角列（仅留底）
  r[28] = String(settleAmount); r[29] = settleCurrency;       // 通道清算（对账用）
  return r;
}
function makeBill(id, billDate, amount, currency) {
  const r = new Array(26).fill('');
  r[0] = billDate; r[14] = id; r[18] = String(amount); r[19] = currency;
  return r;
}
async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers.slice());
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

const THIS = path.resolve(__filename);
// 跑一组 ops：legacy(env=1) 与 engine(默认) 各起一个子进程，导入到独立 DB，返回 { legacy, engine }。
function runBothPaths({ tmpdir, monthKey, ops, dumpAfter = false, runCheck = false, tag }) {
  const opJson = path.join(tmpdir, `op-${tag}.json`);
  fs.writeFileSync(opJson, JSON.stringify({ tmpdir, monthKey, ops, dumpAfter, runCheck }), 'utf8');
  const runOne = (forceLegacy) => {
    const dbPath = path.join(tmpdir, `db-${tag}-${forceLegacy ? 'legacy' : 'engine'}.sqlite`);
    const env = { ...process.env };
    if (forceLegacy) env.ACQUIRING_FORCE_LEGACY_IMPORT = '1';
    else delete env.ACQUIRING_FORCE_LEGACY_IMPORT;
    const res = spawnSync('node', [THIS, '--child', opJson, dbPath], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0 && !res.stdout) {
      throw new Error(`child(${forceLegacy ? 'legacy' : 'engine'}) crashed: ${(res.stderr || '').slice(-500)}`);
    }
    // 取 stdout 最后一行 JSON（worker ExperimentalWarning 走 stderr，不污染 stdout；防御性取最后一段 JSON）。
    const text = (res.stdout || '').trim();
    const start = text.lastIndexOf('{', text.length);
    try { return JSON.parse(text.slice(text.indexOf('{'))); }
    catch (_e) { return JSON.parse(text.slice(start)); }
  };
  return { legacy: runOne(true), engine: runOne(false) };
}

async function main() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-engine-mig-'));
  try {
    // ════════════ ① 成功导入（多文件 + 混币种）byte-for-byte + 对账统计 ════════════
    {
      const date1 = '2026-03-01';
      const date2 = '2026-03-15';
      const flowA = path.join(tmpdir, 'flowA.xlsx');
      const flowB = path.join(tmpdir, 'flowB.xlsx');
      const billA = path.join(tmpdir, 'billA.xlsx');
      await writeXlsx(flowA, FLOW_HEADERS, [
        makeFlow('M1', date1, '10.50', 'USD'),
        makeFlow('M2', date1, '-20', 'usd'),     // 负数 + 小写币种
        makeFlow('M3', date2, '30', ' EUR ')     // 带空格币种
      ]);
      await writeXlsx(flowB, FLOW_HEADERS, [
        makeFlow('M4', date1, '', ''),           // 空金额空币种（非清算流水子类型）
        makeFlow('M5', date2, '50.00', 'CNY')
      ]);
      await writeXlsx(billA, BILL_HEADERS, [
        makeBill('M1', date1, '10.50', 'usd'),   // 一致
        makeBill('M2', date1, '20', 'EUR'),      // 币种差异
        makeBill('M3', date2, '30', 'EUR'),      // 一致（归一）
        makeBill('M4', date1, '10', 'CNY'),      // 流水空 vs 单据有 → mismatch
        makeBill('M5', date2, '50', 'CNY')       // 一致
      ]);

      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case1', dumpAfter: true, runCheck: true,
        ops: [
          { method: 'importFlow', filePaths: [flowA, flowB] },
          { method: 'importBill', filePaths: [billA] }
        ]
      });

      assertTrue(r.legacy.ok, '① legacy 导入成功', JSON.stringify(r.legacy.error));
      assertTrue(r.engine.ok, '① engine 导入成功', JSON.stringify(r.engine.error));
      assertEq(r.engine.results, r.legacy.results, '① import 返回值（totalImported/fileCount/monthKey）相等');
      // 🔴 逐行含 rowid byte-for-byte（flow + bill 两表）
      assertEq(r.engine.dump, r.legacy.dump, '🔴 ① flow+bill 两库逐行含 rowid byte-for-byte 相等');
      // 🔴 对账统计相等（资金红线终点）
      assertEq(r.engine.stats, r.legacy.stats, '🔴 ① runCheck 对账统计（matched/mismatch/unmatched/total）相等');
      // 额外断言 rowid 序 = 文件序（flow A 全部先于 flow B）
      const flowIds = r.engine.dump.flow.map((x) => x.recon_main_id);
      assertEq(flowIds, ['M1', 'M2', 'M3', 'M4', 'M5'], '① flow rowid 序 = 文件序（flowA 全部先于 flowB）');
    }

    // ════════════ ② UNIQUE 冲突（同月重复主对账Id）→ 整批拒绝，报错逐字符相等 ════════════
    {
      const date = '2026-03-01';
      const flowDup = path.join(tmpdir, 'flowDup.xlsx');
      await writeXlsx(flowDup, FLOW_HEADERS, [
        makeFlow('D1', date, '10', 'USD'),
        makeFlow('D1', date, '20', 'EUR')   // 重复 → UNIQUE(month_key, recon_main_id) 冲突
      ]);
      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case2', dumpAfter: true,
        ops: [{ method: 'importFlow', filePaths: [flowDup] }]
      });
      assertTrue(!r.legacy.ok, '② legacy UNIQUE 冲突整批拒绝');
      assertTrue(!r.engine.ok, '② engine UNIQUE 冲突整批拒绝');
      assertEq(r.engine.error.name, r.legacy.error.name, '② 错误 name 相等');
      assertEq(r.engine.error.message, r.legacy.error.message, '🔴 ② UNIQUE 错误 message 逐字符相等');
      assertEq(r.engine.error.detailLines, r.legacy.error.detailLines, '🔴 ② UNIQUE 错误 detailLines 逐字符相等');
      assertEq(r.engine.error.name, 'ImportValidationError', '② name = ImportValidationError');
      assertEq(r.engine.dump.flow.length, 0, '🔴 ② engine ROLLBACK 表空');
      assertEq(r.legacy.dump.flow.length, 0, '② legacy ROLLBACK 表空');
    }

    // ════════════ ③ 跨月（用户选月 ≠ 文件月）→ 整批拒绝，报错逐字符相等 ════════════
    {
      const flowCross = path.join(tmpdir, 'flowCross.xlsx');
      // 同文件内首行 2026-03、次行 2026-04 → 跨月混杂（baseMonthKey=用户选 2026-03）
      await writeXlsx(flowCross, FLOW_HEADERS, [
        makeFlow('C1', '2026-03-01', '10', 'USD'),
        makeFlow('C2', '2026-04-01', '20', 'USD')
      ]);
      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case3', dumpAfter: true,
        ops: [{ method: 'importFlow', filePaths: [flowCross] }]
      });
      assertTrue(!r.legacy.ok, '③ legacy 跨月整批拒绝');
      assertTrue(!r.engine.ok, '③ engine 跨月整批拒绝');
      assertEq(r.engine.error.message, r.legacy.error.message, '🔴 ③ 跨月错误 message 逐字符相等');
      assertEq(r.engine.error.detailLines, r.legacy.error.detailLines, '🔴 ③ 跨月错误 detailLines 逐字符相等');
      assertEq(r.engine.dump.flow.length, 0, '🔴 ③ engine 跨月 ROLLBACK 表空');
    }

    // ════════════ ④ 坏表头（少 1 列）→ 整批拒绝，报错逐字符相等 ════════════
    {
      const flowBadHeader = path.join(tmpdir, 'flowBadHeader.xlsx');
      const badHeaders = FLOW_HEADERS.slice(0, 47);
      const row = new Array(47).fill('');
      row[0] = '2026-03-01'; row[6] = 'BH1'; row[28] = '10';
      await writeXlsx(flowBadHeader, badHeaders, [row]);
      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case4', dumpAfter: true,
        ops: [{ method: 'importFlow', filePaths: [flowBadHeader] }]
      });
      assertTrue(!r.legacy.ok, '④ legacy 坏表头整批拒绝');
      assertTrue(!r.engine.ok, '④ engine 坏表头整批拒绝');
      assertEq(r.engine.error.name, r.legacy.error.name, '④ 坏表头错误 name 相等');
      assertEq(r.engine.error.message, r.legacy.error.message, '🔴 ④ 坏表头错误 message 逐字符相等（含 sourceFile 前缀）');
      assertEq(r.engine.error.detailLines, r.legacy.error.detailLines, '🔴 ④ 坏表头错误 detailLines 逐字符相等');
      assertEq(r.engine.error.name, 'ImportValidationError', '④ name = ImportValidationError');
    }

    // ════════════ ⑤ overwrite 重导 → 行集相等 ════════════
    {
      const date = '2026-03-01';
      const flowInit = path.join(tmpdir, 'flowInit.xlsx');
      const flowOver = path.join(tmpdir, 'flowOver.xlsx');
      await writeXlsx(flowInit, FLOW_HEADERS, [
        makeFlow('O1', date, '10', 'USD'), makeFlow('O2', date, '20', 'USD')
      ]);
      await writeXlsx(flowOver, FLOW_HEADERS, [
        makeFlow('O3', date, '30', 'EUR'), makeFlow('O4', date, '40', 'CNY'), makeFlow('O5', date, '50', 'USD')
      ]);
      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case5', dumpAfter: true,
        ops: [
          { method: 'importFlow', filePaths: [flowInit] },             // 先导 2 行
          { method: 'importFlowOverwrite', filePaths: [flowOver] }     // 覆盖为 3 行
        ]
      });
      assertTrue(r.legacy.ok && r.engine.ok, '⑤ overwrite 两路成功', JSON.stringify([r.legacy.error, r.engine.error]));
      assertEq(r.engine.results, r.legacy.results, '⑤ overwrite 返回值（含 deletedCount）相等');
      assertEq(r.engine.dump, r.legacy.dump, '🔴 ⑤ overwrite 后 flow 两库逐行含 rowid byte-for-byte 相等');
      assertEq(r.engine.dump.flow.map((x) => x.recon_main_id), ['O3', 'O4', 'O5'], '⑤ overwrite 后仅新行集（旧 O1/O2 已删）');
      // deletedCount 应 = 旧 2 行
      assertEq(r.engine.results[1].deletedCount, 2, '⑤ engine overwrite deletedCount=2');
      assertEq(r.legacy.results[1].deletedCount, 2, '⑤ legacy overwrite deletedCount=2');
    }

    // ════════════ ⑥ bill 多文件 + raw_json byte-for-byte ════════════
    {
      const date = '2026-03-10';
      const billX = path.join(tmpdir, 'billX.xlsx');
      const billY = path.join(tmpdir, 'billY.xlsx');
      await writeXlsx(billX, BILL_HEADERS, [
        makeBill('BX1', '2026/3/10', '100', 'USD'),  // YYYY/M/D → raw_json 账单日期归一
        makeBill('BX2', date, '200', 'eur')
      ]);
      await writeXlsx(billY, BILL_HEADERS, [makeBill('BY1', date, '300', 'CNY')]);
      const r = runBothPaths({
        tmpdir, monthKey: '2026-03', tag: 'case6', dumpAfter: true,
        ops: [{ method: 'importBill', filePaths: [billX, billY] }]
      });
      assertTrue(r.legacy.ok && r.engine.ok, '⑥ bill 多文件两路成功', JSON.stringify([r.legacy.error, r.engine.error]));
      assertEq(r.engine.dump.bill, r.legacy.dump.bill, '🔴 ⑥ bill 两库逐行含 rowid + raw_json byte-for-byte 相等');
      assertEq(r.engine.dump.bill.map((x) => x.recon_main_id), ['BX1', 'BX2', 'BY1'], '⑥ bill rowid 序 = 文件序');
    }

    console.log(`acquiring-engine-migration: ${passed}/${passed + failed} PASS`);
    if (failed > 0) {
      for (const f of failures) console.error(`  FAIL ${f.label}: ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

// 入口分流：子进程模式 vs 主进程模式。
if (process.argv[2] === '--child') {
  runChild(process.argv[3], process.argv[4]).catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, error: { name: 'Error', message: String(err && err.message || err), detailLines: [] }, dump: null, stats: null, results: [] }));
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error('acquiring-engine-migration crashed:', err);
    process.exitCode = 1;
  });
}
