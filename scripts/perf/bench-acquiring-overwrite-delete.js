// 一次性基准：实测「覆盖导入单据表」的整月 DELETE 耗时
//
// 目标（回答用户问题：DELETE FROM acquiring_bill_currency_bill_imports WHERE month_key=? 执行多久）
//   - 用真实迁移建库（AppDatabase.init），保证 FK ON DELETE CASCADE + 缺失索引与生产一致
//   - 灌真实规模 bill 行（默认 50 万），分场景实测 import-repository.deleteMonthBySide
//   - 三类场景：
//       A. 该月未 run（diff_rows 为空）—— 仅删 bill 行 + 维护其二级索引
//       B. 该月已 run（diff_rows 有 D 行，引用本月 bill）—— 触发 ON DELETE CASCADE
//          且 diff_rows.bill_import_id 无索引 → 每删一父行全表扫 diff_rows（O(N×D) 陷阱）
//       C. 同 B，但先给 diff_rows(bill_import_id) 建索引 —— 量化「补索引」的修复效果
//
// 用法：
//   node scripts/perf/bench-acquiring-overwrite-delete.js [N] [D1,D2,...]
//   例：node scripts/perf/bench-acquiring-overwrite-delete.js 500000 1000,5000
//
// 注意：纯测量脚本，不改任何生产代码；每个场景用独立临时库，跑完即删。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase } = require('../../src/backend/database');
const importRepo = require('../../src/backend/acquiring-bill-currency-db/import-repository');

const N = Number(process.argv[2]) || 500000;
const DLIST = (process.argv[3] || '1000,5000').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const MONTH = '2026-05';

function ms(t0, t1) {
  return Number(t1 - t0) / 1e6;
}

function buildDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-del-bench-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  return { appDb, db: appDb.db, dir };
}

function teardown({ appDb, dir }) {
  try { appDb.close && appDb.close(); } catch (_e) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

// 灌 N 行单据。raw_json 用 9 模版字段量级（贴近 v2.1.8 N4 瘦身后真实大小）
function populateBill(db, monthKey, n) {
  const CCY = ['USD', 'EUR', 'HKD', 'CNY', 'JPY'];
  const insert = db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importedAt = '2026-05-01T00:00:00.000Z';
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  try {
    for (let i = 0; i < n; i++) {
      const ccy = CCY[i % CCY.length];
      const raw = JSON.stringify({
        '账单日期': '2026-05-10',
        '主对账Id': `R${i}`,
        '对账币种': ccy,
        '对账金额': '123.45',
        '商户号': 'NET001',
        '交易类型': '消费',
        '渠道': 'WX',
        '订单号': `O${i}`,
        '备注': ''
      });
      insert.run(monthKey, 'bench.xlsx', i + 2, `R${i}`, ccy, ccy.toLowerCase(), raw, importedAt);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const t1 = process.hrtime.bigint();
  return ms(t0, t1);
}

// 模拟「已 run」：插 1 条 run + D 条 diff_rows 引用本月前 D 条 bill（bill_import_id）
function populateDiff(db, monthKey, d) {
  if (d <= 0) return 0;
  const runRes = db.prepare(`
    INSERT INTO acquiring_bill_currency_runs
      (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, ?, ?, ?, 'success')
  `).run(monthKey, N, N - d, d, 0);
  const runId = Number(runRes.lastInsertRowid);
  const ids = db.prepare(
    'SELECT id FROM acquiring_bill_currency_bill_imports WHERE month_key = ? ORDER BY id LIMIT ?'
  ).all(monthKey, d);
  const insertDiff = db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows
      (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, ?, ?, 'currency_mismatch')
  `);
  db.exec('BEGIN');
  try {
    for (const r of ids) insertDiff.run(runId, r.id, 'usd', '123.45');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return d;
}

// 实测：BEGIN + deleteMonthBySide(真实生产函数) + COMMIT
function timeDelete(db, monthKey) {
  db.exec('BEGIN');
  const t0 = process.hrtime.bigint();
  const { deletedCount } = importRepo.deleteMonthBySide(db, { kind: 'bill', monthKey });
  const t1 = process.hrtime.bigint();
  db.exec('COMMIT');
  return { deleteMs: ms(t0, t1), deletedCount };
}

function diffRowsLeft(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c;
}

function printSchemaEvidence() {
  const { db, ...rest } = buildDb();
  console.log('=== schema 自证（真实迁移后）===');
  const fks = db.prepare("PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')").all();
  console.log('diff_rows 外键：');
  for (const fk of fks) console.log(`  ${fk.from} -> ${fk.table}(${fk.to})  on_delete=${fk.on_delete}`);
  const idx = db.prepare("PRAGMA index_list('acquiring_bill_currency_diff_rows')").all();
  console.log('diff_rows 索引：');
  for (const ix of idx) {
    const cols = db.prepare(`PRAGMA index_info('${ix.name}')`).all().map((c) => c.name).join(',');
    console.log(`  ${ix.name}  (${cols})  unique=${ix.unique}`);
  }
  const billIdx = db.prepare("PRAGMA index_list('acquiring_bill_currency_bill_imports')").all();
  console.log('bill_imports 索引：');
  for (const ix of billIdx) {
    const cols = db.prepare(`PRAGMA index_info('${ix.name}')`).all().map((c) => c.name).join(',');
    console.log(`  ${ix.name}  (${cols})  unique=${ix.unique}`);
  }
  console.log('');
  teardown({ db, ...rest });
}

function runScenario(label, { d, withIndex }) {
  const ctx = buildDb();
  const { db } = ctx;
  const popMs = populateBill(db, MONTH, N);
  populateDiff(db, MONTH, d);
  if (withIndex) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_bench_diff_bill_import_id ON acquiring_bill_currency_diff_rows(bill_import_id);');
  }
  const before = diffRowsLeft(db);
  const { deleteMs, deletedCount } = timeDelete(db, MONTH);
  const after = diffRowsLeft(db);
  teardown(ctx);
  console.log(
    `${label.padEnd(42)} | 删 bill ${deletedCount} 行 | DELETE ${deleteMs.toFixed(1).padStart(9)} ms ` +
    `| diff_rows 级联 ${before}→${after} | (灌库 ${popMs.toFixed(0)}ms)`
  );
  return { label, d, withIndex, deleteMs, deletedCount, cascadeDeleted: before - after };
}

function main() {
  console.log(`\n收单「覆盖导入单据表」整月 DELETE 实测  (N=${N} bill 行, month=${MONTH})`);
  console.log(`node=${process.version}  平台=${process.platform}\n`);
  printSchemaEvidence();

  console.log('=== 实测结果 ===');
  // A：未 run
  runScenario('A. 未 run (diff_rows 为空)', { d: 0, withIndex: false });
  // B/C：已 run，无索引 vs 补索引
  for (const d of DLIST) {
    runScenario(`B. 已 run, diff=${d}, bill_import_id 无索引(现状)`, { d, withIndex: false });
    runScenario(`C. 已 run, diff=${d}, 补 bill_import_id 索引`, { d, withIndex: true });
  }
  console.log('\n说明：B 行若随 diff 增大而显著变慢 = 印证 O(N×D) 无索引级联陷阱；C 行即补索引后的修复效果。');
}

main();
