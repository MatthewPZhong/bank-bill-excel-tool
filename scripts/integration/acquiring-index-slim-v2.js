// v3.0.3 PR-B（P0-3）集成验证：收单两表索引瘦身 + covering 升级（spec §9.2.2）
//   ① 老 schema 库（手建旧 4 索引）跑 ensureAcquiringBillCurrencyIndexSlimV2 → index_list 符合预期 + 幂等
//   ② 新库（AppDatabase.init 建表段直建 v2）→ index_list 同口径
//   ③ 关键查询 EXPLAIN QUERY PLAN 无全表扫描回归（chunked 子查询仅留档不强断言）
//   ④ 🔴 资金红线：迁移前后同一批数据 computeRunStats + chunked diff INSERT 结果一致
//
// 用法：node scripts/integration/acquiring-index-slim-v2.js（integration-runner.js 自动发现）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../src/backend/database');
const migrations = require('../../src/backend/database/migrations');
const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(cond, label, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, detail: detail === undefined ? String(cond) : detail });
}
function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, detail: `actual=${aJson} expected=${eJson}` });
}

// 老 schema（v3.0.2 及之前）：两表 + 旧 4 索引（照搬升级前建表段 DDL）
function createLegacySchema(db) {
  db.exec(`
    CREATE TABLE acquiring_bill_currency_flow_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_amount TEXT NOT NULL,
      settle_amount_abs TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
    CREATE INDEX idx_acquiring_bill_currency_flow_month ON acquiring_bill_currency_flow_imports(month_key);
    CREATE INDEX idx_acquiring_bill_currency_flow_join ON acquiring_bill_currency_flow_imports(month_key, recon_main_id);
    CREATE TABLE acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
    CREATE INDEX idx_acquiring_bill_currency_bill_month ON acquiring_bill_currency_bill_imports(month_key);
    CREATE INDEX idx_acquiring_bill_currency_bill_join ON acquiring_bill_currency_bill_imports(month_key, recon_main_id);
    CREATE INDEX idx_acquiring_bill_currency_bill_source_file ON acquiring_bill_currency_bill_imports(source_file);
    CREATE TABLE acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL,
      matched_rows INTEGER NOT NULL,
      mismatch_rows INTEGER NOT NULL,
      unmatched_rows INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE acquiring_bill_currency_diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
    );
    CREATE INDEX idx_acquiring_bill_currency_diff_run ON acquiring_bill_currency_diff_rows(run_id);
  `);
}

// 测试数据：300 bill（前 240 与 flow 配对，其中 30 mismatch；60 unmatched）+ 240 flow
function seedData(db) {
  const fStmt = db.prepare(`INSERT INTO acquiring_bill_currency_flow_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '2026-03-01T00:00:00Z')`);
  const bStmt = db.prepare(`INSERT INTO acquiring_bill_currency_bill_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '2026-03-01T00:00:00Z')`);
  db.exec('BEGIN');
  for (let i = 0; i < 240; i++) {
    fStmt.run('2026-03', 'f.xlsx', i + 2, `RM${i}`, '100.50', '100.5', 'USD', 'usd');
  }
  for (let i = 0; i < 300; i++) {
    // 前 240 配对：i%8===0（30 个）币种 EUR → mismatch；其余 usd → matched。后 60 无 flow → unmatched
    const cur = (i % 8 === 0 && i < 240) ? 'EUR' : 'USD';
    bStmt.run('2026-03', 'b.xlsx', i + 2, `RM${i}`, cur, cur.toLowerCase());
  }
  // 干扰月份（验证 month_key 过滤不串月）
  fStmt.run('2026-04', 'f2.xlsx', 2, 'RM0', '1.00', '1', 'JPY', 'jpy');
  bStmt.run('2026-04', 'b2.xlsx', 2, 'RM0', 'CNY', 'cny');
  db.exec('COMMIT');
}

function listIndexNames(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((r) => r.name).sort();
}

function explainDetail(db, sql, params = []) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((r) => r.detail).join(' | ');
}

function runStatsAndDiff(db, runId) {
  const stats = runRepo.computeRunStats(db, { monthKey: '2026-03' });
  const chunked = runRepo.insertDiffRowsByJoinChunked(db, { runId, monthKey: '2026-03', chunkSize: 100 });
  const diffRows = db.prepare(
    `SELECT bill_import_id, flow_currency, flow_amount_abs, diff_type
     FROM acquiring_bill_currency_diff_rows WHERE run_id = ? ORDER BY bill_import_id ASC`
  ).all(runId);
  return { stats, totalInserted: chunked.totalInsertedDiffRows, diffRows };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-slim-v2-'));

  // ── ① 老库迁移路径 ──
  const legacyPath = path.join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(legacyPath);
  db.exec('PRAGMA foreign_keys = ON;');
  createLegacySchema(db);
  seedData(db);

  // 🔴 ④ 资金红线基线：迁移前（旧索引）跑 stats + chunked diff
  db.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES ('2026-03',0,0,0,0,'success')`).run();
  const runBefore = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  const before = runStatsAndDiff(db, runBefore);
  assertEq(before.stats, { totalBillRows: 300, matchedRows: 240, mismatchRows: 30, unmatchedRows: 60 }, '① 迁移前 stats 口径');
  assertEq(before.totalInserted, 30, '① 迁移前 diff INSERT 行数');

  // 跑 migration
  migrations.ensureAcquiringBillCurrencyIndexSlimV2(db);
  const flowIdx = listIndexNames(db, 'acquiring_bill_currency_flow_imports');
  const billIdx = listIndexNames(db, 'acquiring_bill_currency_bill_imports');
  assertTrue(!flowIdx.includes('idx_acquiring_bill_currency_flow_month') && !flowIdx.includes('idx_acquiring_bill_currency_flow_join'),
    '① flow 旧 2 索引已删', flowIdx.join(','));
  assertTrue(flowIdx.includes('idx_acquiring_bill_currency_flow_join_v2'), '① flow v2 covering 已建', flowIdx.join(','));
  assertTrue(flowIdx.some((n) => n.startsWith('sqlite_autoindex_')), '① flow UNIQUE autoindex 保留', flowIdx.join(','));
  assertTrue(!billIdx.includes('idx_acquiring_bill_currency_bill_month') && !billIdx.includes('idx_acquiring_bill_currency_bill_join'),
    '① bill 旧 2 索引已删', billIdx.join(','));
  assertTrue(billIdx.includes('idx_acquiring_bill_currency_bill_join_v2'), '① bill v2 covering 已建', billIdx.join(','));
  assertTrue(billIdx.includes('idx_acquiring_bill_currency_bill_source_file'), '① bill source_file 索引保留', billIdx.join(','));

  // 幂等：再跑一次不抛、索引清单不变
  migrations.ensureAcquiringBillCurrencyIndexSlimV2(db);
  assertEq(listIndexNames(db, 'acquiring_bill_currency_flow_imports'), flowIdx, '① migration 幂等（flow 索引清单不变）');

  // 🔴 ④ 迁移后重跑：stats + diff 与迁移前一致
  db.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES ('2026-03',0,0,0,0,'success')`).run();
  const runAfter = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  const after = runStatsAndDiff(db, runAfter);
  assertEq(after.stats, before.stats, '④ 迁移前后 computeRunStats 一致');
  assertEq(after.totalInserted, before.totalInserted, '④ 迁移前后 diff INSERT 行数一致');
  assertEq(after.diffRows, before.diffRows, '④ 迁移前后 diff 行集合一致（bill_import_id 序）');

  // ── ③ EXPLAIN QUERY PLAN（迁移后；ANALYZE 先行对齐生产 init 末尾行为）──
  db.exec('ANALYZE');
  const M = '2026-03';
  const expectIndexed = [
    ['getMonthReadiness flow COUNT', `SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports WHERE month_key = ?`, [M]],
    ['getMonthReadiness bill COUNT', `SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?`, [M]],
    ['listMonths flow DISTINCT', `SELECT DISTINCT month_key FROM acquiring_bill_currency_flow_imports`, []],
    ['deleteMonthBySide flow', `DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key = ?`, [M]],
    ['cleanup 批删子查询', `SELECT rowid FROM acquiring_bill_currency_flow_imports WHERE month_key = ? LIMIT 50000`, [M]],
    ['listSourceFilesByRun', `SELECT DISTINCT source_file FROM acquiring_bill_currency_bill_imports WHERE month_key = ? ORDER BY source_file ASC`, [M]],
    ['computeRunStats 合并 JOIN', `SELECT COUNT(*) AS matched, COALESCE(SUM(CASE WHEN COALESCE(b.settle_currency_norm,'') <> COALESCE(f.settle_currency_norm,'') THEN 1 ELSE 0 END),0) AS mismatch FROM acquiring_bill_currency_bill_imports b INNER JOIN acquiring_bill_currency_flow_imports f ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id WHERE b.month_key = ?`, [M]],
  ];
  for (const [label, sql, params] of expectIndexed) {
    const detail = explainDetail(db, sql, params);
    assertTrue(/USING (COVERING )?INDEX/.test(detail), `③ ${label} 走索引`, detail);
  }
  // chunked 子查询：仅留档（PK 扫或索引+sort 均可接受，spec §9.2.2）
  const chunkedDetail = explainDetail(db,
    `SELECT id, month_key, recon_main_id, settle_currency_norm FROM acquiring_bill_currency_bill_imports WHERE month_key = ? ORDER BY id ASC LIMIT ? OFFSET ?`, [M, 100, 0]);
  console.log(`[留档] chunked 子查询计划: ${chunkedDetail}`);
  db.close();

  // ── ② 新库路径（AppDatabase.init 建表段直建 v2）──
  const freshDb = new AppDatabase(path.join(dir, 'fresh.sqlite'));
  freshDb.init();
  const freshFlowIdx = listIndexNames(freshDb.db, 'acquiring_bill_currency_flow_imports');
  const freshBillIdx = listIndexNames(freshDb.db, 'acquiring_bill_currency_bill_imports');
  assertTrue(freshFlowIdx.includes('idx_acquiring_bill_currency_flow_join_v2')
    && !freshFlowIdx.includes('idx_acquiring_bill_currency_flow_month')
    && !freshFlowIdx.includes('idx_acquiring_bill_currency_flow_join'), '② 新库 flow 索引一步到位', freshFlowIdx.join(','));
  assertTrue(freshBillIdx.includes('idx_acquiring_bill_currency_bill_join_v2')
    && freshBillIdx.includes('idx_acquiring_bill_currency_bill_source_file')
    && !freshBillIdx.includes('idx_acquiring_bill_currency_bill_month'), '② 新库 bill 索引一步到位', freshBillIdx.join(','));
  // 老/新库最终索引清单同口径（autoindex 名因建表顺序一致也应同名）
  assertEq(freshFlowIdx, flowIdx, '②/① 老库迁移后与新库 flow 索引清单同口径');
  freshDb.db.close();

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* 清理失败不影响结果 */ }

  console.log(`acquiring-index-slim-v2: ${passed}/${passed + failed} PASS`);
  if (failed > 0) {
    for (const f of failures) console.error(`  FAIL ${f.label}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('acquiring-index-slim-v2 crashed:', err);
  process.exitCode = 1;
});
