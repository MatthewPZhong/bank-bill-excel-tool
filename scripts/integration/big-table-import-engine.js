// 通用大表导入引擎 集成验证（v3.0.3 块 D · PR-G2）🔴🔴 资金红线（并行=串行 byte-for-byte / 覆盖 / cancel / PRAGMA）
//
// 覆盖（spec §6 PR-G2 行验收）：
//   ① 串行（parallel=1）vs 并行（parallel=4）→ 逐行含 rowid 对比两库 byte-for-byte 相等（rowid 序=串行导入）
//   ② overwrite 模式重导 → 行集正确替换
//   ③ cancel：真实 worker 拓扑（engine-worker-entry.js）启动后立即 cancel → 表空（ROLLBACK 生效）+ 5s 内返回
//   ④ PRAGMA verify：引擎连接读回 journal_mode/synchronous/cache_size/mmap_size/temp_store 断言契约值
//
// 用「收单 flow 形态」测试契约（不 require 收单业务模块；契约内联在临时文件，列号语义对齐 flow：
//   列 0=账单日期(monthKey 源) / 列 6=主对账Id / 列 28=通道清算金额 / 列 29=通道清算币种；白名单 {0,6,28,29}）。
//
// 用法：node scripts/integration/big-table-import-engine.js（integration-runner.js 自动发现）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const engine = require('../../src/backend/big-table-import/engine');
const fx = require('../../tests/unit/backend/big-table-import/_fixtures');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(cond, label, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, detail: detail === undefined ? String(cond) : detail });
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, detail: `actual=${a} expected=${e}` });
}

// ── 收单 flow 形态测试契约（48 列表头；列号语义对齐 flow，但不 require 业务模块）──
//   存为临时文件供 worker require（必须可序列化定位：路径）。
const FLOW_HEADER_LEN = 48;
function writeFlowContract(dir) {
  const p = path.join(dir, 'contract-flow-test.js');
  // 表头：列 0/6/28/29 给特征名，其余占位（validateHeaders 只校验这 4 列特征 + 列数）。
  fs.writeFileSync(p, `'use strict';
const LEN = ${FLOW_HEADER_LEN};
const HEADERS = Array.from({ length: LEN }, (_, i) => '列' + i);
HEADERS[0] = '账单日期'; HEADERS[6] = '主对账Id'; HEADERS[28] = '通道清算金额'; HEADERS[29] = '通道清算币种';
module.exports = {
  expectedHeaders: HEADERS,
  valueColumnWhitelist: [0, 6, 28, 29],   // flow 4/48 高收益白名单（spec §三）
  validateHeaders(cells) {
    if (cells.length < LEN) return { ok: false, error: '表头列数不足（期望 ' + LEN + '）', detailLines: ['实际 ' + cells.length + ' 列'] };
    const need = { 0: '账单日期', 6: '主对账Id', 28: '通道清算金额', 29: '通道清算币种' };
    for (const k of Object.keys(need)) {
      if (cells[k] !== need[k]) return { ok: false, error: '表头第 ' + k + ' 列不匹配', detailLines: ['期望 ' + need[k] + ' 实际 ' + cells[k]] };
    }
    return { ok: true };
  },
  mapRow({ values }) {
    const reconId = String(values[6] || '').trim();
    if (!reconId) return { error: { reason: '主对账Id 为空' } };
    const billDate = String(values[0] || '').trim();
    const settleAmount = String(values[28] || '').trim();
    const settleCurrency = String(values[29] || '').trim();
    const settleCurrencyNorm = settleCurrency.trim().toLowerCase();
    // 列序对齐 insertSql：month_key 由 monthKeyOf 提（mapRow 不直接拿 monthKey，engine 注入校验）→
    //   这里 params 不含 month_key（engine 的 insertSql 用 monthKeyOf？）——
    //   ⚠️ 简化：测试契约 insertSql 自带 month_key 列，mapRow 负责从 billDate 提 monthKey 放进 params[0]。
    const m = billDate.match(/^(\\d{4})[-/](\\d{1,2})/);
    const monthKey = m ? m[1] + '-' + String(m[2]).padStart(2, '0') : '';
    return { params: [monthKey, reconId, settleAmount, settleCurrency, settleCurrencyNorm, billDate] };
  },
  insertSql: 'INSERT INTO flow (month_key, recon_main_id, settle_amount, settle_currency, settle_currency_norm, bill_date) VALUES (?, ?, ?, ?, ?, ?)',
  requiredColumns: [0, 6, 28, 29],
  monthKeyOf({ values }) {
    const m = String(values[0] || '').match(/^(\\d{4})[-/](\\d{1,2})/);
    return m ? m[1] + '-' + String(m[2]).padStart(2, '0') : null;
  },
  deleteSqlForOverwrite: 'DELETE FROM flow WHERE month_key = ?',
  deleteParamsFromMonthKey(mk) { return [mk]; }
};
`, 'utf8');
  return p;
}

// 建 flow 表（含 UNIQUE(month_key, recon_main_id) 对齐收单语义）。
function createFlowTable(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT NOT NULL,
    recon_main_id TEXT NOT NULL,
    settle_amount TEXT,
    settle_currency TEXT,
    settle_currency_norm TEXT,
    bill_date TEXT,
    UNIQUE(month_key, recon_main_id)
  );`);
  db.close();
}

// 造一个 flow 形态 xlsx：n 行数据，主键 prefix-i，金额/币种带值，其余列占位。
async function writeFlowXlsx({ prefix, n, monthKey = '2026-03', startDay = 1 }) {
  const rows = [];
  const header = Array.from({ length: FLOW_HEADER_LEN }, (_, i) => '列' + i);
  header[0] = '账单日期'; header[6] = '主对账Id'; header[28] = '通道清算金额'; header[29] = '通道清算币种';
  rows.push(header);
  for (let i = 0; i < n; i++) {
    const r = Array.from({ length: FLOW_HEADER_LEN }, (_, c) => `占位${c}`);
    const day = String(startDay + (i % 27)).padStart(2, '0');
    r[0] = `${monthKey}-${day}`;
    r[6] = `${prefix}-${i}`;
    r[28] = String((i + 1) * 100 + (i % 10) / 10);   // 金额带小数
    r[29] = (i % 3 === 0) ? 'USD' : (i % 3 === 1 ? 'EUR' : 'CNY');
    rows.push(r);
  }
  return fx.writeFixtureExcelJS({ rows });
}

// 逐行含 rowid 读出整库（byte-for-byte 对比基准）。
function dumpFlow(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(
    'SELECT id, month_key, recon_main_id, settle_amount, settle_currency, settle_currency_norm, bill_date FROM flow ORDER BY id ASC'
  ).all();
  db.close();
  return rows;
}

// 用真实 worker 拓扑（engine-worker-entry.js）跑导入；返回 { promise, worker, cancel }。
function runViaWorker({ dbPath, files, contractModulePath, mode = 'append', monthKey, parallel }) {
  const worker = new Worker(path.join(__dirname, '..', '..', 'src', 'backend', 'big-table-import', 'engine-worker-entry.js'));
  const jobId = 'job-' + Date.now();
  const promise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      if (!msg || msg.jobId !== jobId) return;
      if (msg.type === 'done') resolve(msg.result);
      else if (msg.type === 'error') {
        const err = new Error(msg.error && msg.error.message ? msg.error.message : 'worker error');
        if (msg.error && msg.error.name) err.name = msg.error.name;
        if (msg.error && msg.error.detailLines) err.detailLines = msg.error.detailLines;
        reject(err);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error('worker exit code=' + code)); });
  });
  worker.postMessage({ type: 'run', jobId, payload: { dbPath, files, contractModulePath, mode, monthKey, parallel } });
  return {
    promise,
    worker,
    jobId,
    cancel() { try { worker.postMessage({ type: 'cancel', jobId }); } catch (_e) { /* swallow */ } }
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btie-integ-'));
  const contractModulePath = writeFlowContract(dir);

  // ── 造 4 个 flow 文件（不同行数 + 同月）──
  const files = [
    await writeFlowXlsx({ prefix: 'A', n: 30, startDay: 1 }),
    await writeFlowXlsx({ prefix: 'B', n: 100, startDay: 3 }),
    await writeFlowXlsx({ prefix: 'C', n: 50, startDay: 5 }),
    await writeFlowXlsx({ prefix: 'D', n: 80, startDay: 7 })
  ];
  const TOTAL = 30 + 100 + 50 + 80;

  // ── ① 串行（parallel=1）vs 并行（parallel=4）byte-for-byte（含 rowid）──
  const serialPath = path.join(dir, 'serial.sqlite');
  const parallelPath = path.join(dir, 'parallel.sqlite');
  createFlowTable(serialPath);
  createFlowTable(parallelPath);

  const serialRes = await engine.importFiles({ dbPath: serialPath, files, contractModulePath, contractOptions: {}, mode: 'append', monthKey: '2026-03', parallel: 1 });
  const parallelRes = await engine.importFiles({ dbPath: parallelPath, files, contractModulePath, contractOptions: {}, mode: 'append', monthKey: '2026-03', parallel: 4 });

  assertEq(serialRes.totalImported, TOTAL, `① 串行导入行数=${TOTAL}`);
  assertEq(parallelRes.totalImported, TOTAL, `① 并行导入行数=${TOTAL}`);

  const serialDump = dumpFlow(serialPath);
  const parallelDump = dumpFlow(parallelPath);
  // 🔴 逐行含 rowid byte-for-byte（rowid 序 = 文件序 = 串行导入）。
  assertEq(parallelDump, serialDump, '🔴 ① 并行 vs 串行逐行含 rowid byte-for-byte 相等');
  // 额外断言 rowid 顺序确实是文件序（A-* 全在 B-* 前）。
  const firstFileKeys = serialDump.slice(0, 30).map((r) => r.recon_main_id);
  assertTrue(firstFileKeys.every((k) => k.startsWith('A-')), '① rowid 前 30 行全是文件 A（文件序单写）', firstFileKeys.slice(0, 3).join(','));
  assertTrue(serialDump[30].recon_main_id.startsWith('B-'), '① 第 31 行是文件 B（文件 A 全部先于 B）', serialDump[30].recon_main_id);

  // ── ② overwrite 模式重导 → 行集正确替换 ──
  //   在 parallelPath 上 overwrite 重导「仅文件 A（30 行）」→ 应删 260 旧行、留 30 新行。
  const owRes = await engine.importFiles({ dbPath: parallelPath, files: [files[0]], contractModulePath, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03', parallel: 4 });
  assertEq(owRes.deletedCount, TOTAL, `② overwrite 删除旧 ${TOTAL} 行`);
  assertEq(owRes.totalImported, 30, '② overwrite 导入新 30 行');
  const owDump = dumpFlow(parallelPath);
  assertEq(owDump.length, 30, '② overwrite 后仅 30 行');
  assertTrue(owDump.every((r) => r.recon_main_id.startsWith('A-')), '② overwrite 后行集全为文件 A（旧 B/C/D 已删）');

  // ── ③ cancel：真实 worker 拓扑启动后立即 cancel → 表空 + 5s 内返回 ──
  const cancelPath = path.join(dir, 'cancel.sqlite');
  createFlowTable(cancelPath);
  // 造一个大文件（解析需时间，让 cancel 在解析/写入期生效）。
  const bigFile = await writeFlowXlsx({ prefix: 'BIG', n: 20000, startDay: 1 });
  const ctl = runViaWorker({ dbPath: cancelPath, files: [bigFile], contractModulePath, mode: 'append', monthKey: '2026-03', parallel: 4 });
  ctl.cancel();   // 启动后立即取消

  const cancelStart = Date.now();
  let cancelErr = null;
  try {
    await Promise.race([
      ctl.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('cancel 超时未返回（>5s）')), 5000))
    ]);
  } catch (e) { cancelErr = e; }
  const cancelMs = Date.now() - cancelStart;
  try { await ctl.worker.terminate(); } catch (_e) { /* swallow */ }

  assertTrue(cancelErr != null, '③ cancel 应使导入失败返回（非成功）', cancelErr && cancelErr.message);
  assertTrue(cancelErr && cancelErr.name === 'CancelError', '③ 取消错误为 CancelError', cancelErr && (cancelErr.name + ':' + cancelErr.message));
  assertTrue(cancelMs < 5000, `③ cancel 5s 内返回（实际 ${cancelMs}ms）`, `${cancelMs}ms`);
  assertEq(dumpFlow(cancelPath).length, 0, '🔴 ③ cancel 后表空（ROLLBACK 生效，不入任何行）');

  // ── ④ PRAGMA verify：引擎连接读回契约值 ──
  const pragmaPath = path.join(dir, 'pragma.sqlite');
  new DatabaseSync(pragmaPath).close();
  const pdb = engine.openDbWithPragma(pragmaPath);
  const readPragma = (name) => {
    const row = pdb.prepare(`PRAGMA ${name}`).get();
    return row[Object.keys(row)[0]];
  };
  assertEq(String(readPragma('journal_mode')).toLowerCase(), 'wal', '④ PRAGMA journal_mode=wal');
  assertEq(Number(readPragma('synchronous')), 1, '④ PRAGMA synchronous=NORMAL(1)');
  assertEq(Number(readPragma('cache_size')), -65536, '④ PRAGMA cache_size=-65536');
  assertEq(Number(readPragma('mmap_size')), 268435456, '④ PRAGMA mmap_size=268435456');
  assertEq(Number(readPragma('temp_store')), 2, '④ PRAGMA temp_store=MEMORY(2)');
  assertEq(Number(readPragma('busy_timeout')), 30000, '④ PRAGMA busy_timeout=30000');
  pdb.close();

  // 清理
  fx.cleanupTmpDirs();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* 清理失败不影响结果 */ }

  console.log(`big-table-import-engine: ${passed}/${passed + failed} PASS`);
  if (failed > 0) {
    for (const f of failures) console.error(`  FAIL ${f.label}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('big-table-import-engine crashed:', err);
  process.exitCode = 1;
});
