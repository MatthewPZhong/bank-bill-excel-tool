// v2.1.10 N4-cont-1 T23 (Phase 4)：raw_json idle 自动清理函数 unit test
//
// 资金红线：本函数不可逆 UPDATE raw_json = NULL；NOT IN 子查询是数据保护核心
//   必须 ≥ 6 unit case 覆盖 NOT IN 子查询边界 + fail case 6 验证错清差异行的灾难性结果不会发生
//
// 覆盖（spec §4.2 + T23 require）：
//   1. NOT IN 子查询正常排除差异行（100 行 bill + 50 差异 + retention=0 → 仅 50 非差异行被清；50 差异行 raw_json 保留）
//   2. imported_at 边界（retention=7 天）：8 天前清；6 天前不清
//   3. raw_json 已 NULL 的行不重复 UPDATE（idempotent）
//   4. 空表 → clearedCount=0 + 无错误
//   5. 全是差异行 → clearedCount=0
//   6. 🔴 资金红线 fail case：人为破坏 diff_rows 表（DROP）→ 函数 throw 而非错清差异行
//   7. SQL injection 防护：retentionDays 非法字符串/对象 → 入口校验 throw（参数化绑定本身防 injection）

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const {
  clearStaleSuccessfulRawJson,
} = require('../../../../src/backend/acquiring-bill-currency-db/raw-json-retention');

// === Fixture：建 acquiring_bill_currency_bill_imports + acquiring_bill_currency_diff_rows 两表 ===
//   schema 必须与 src/backend/database/migrations.js:1492 + :1543 一致（关键列 + FK）
//   bill_imports 的 imported_at 列用 ISO 字符串（与 datetime('now', '-? days') 比较）
function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-json-retention-fn-test-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL DEFAULT 0,
      matched_rows INTEGER NOT NULL DEFAULT 0,
      mismatch_rows INTEGER NOT NULL DEFAULT 0,
      unmatched_rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'complete'
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
    );
  `);
  return { db, dir, dbPath };
}

function teardown({ db, dir }) {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

// 用 ISO + 偏移天数构造历史 imported_at 字符串（datetime('now') SQLite UTC）
function nowMinusDays(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // 用 SQLite datetime('now') 的等价格式 'YYYY-MM-DD HH:MM:SS'
  // 注：SQLite 的 datetime('now') 默认 UTC，本测试 fixture 也用 UTC
  const iso = d.toISOString().replace('T', ' ').slice(0, 19);
  return iso;
}

function insertBill(db, { id, monthKey, reconId, raw, importedAt }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (id, month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, 'fix.xlsx', ?, ?, 'USD', 'usd', ?, ?)
  `).run(id, monthKey, id, reconId, raw, importedAt);
}

function insertDiff(db, { runId, billImportId, diffType = 'currency-mismatch' }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows
      (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, 'EUR', '100', ?)
  `).run(runId, billImportId, diffType);
}

function insertRun(db, { id, monthKey = '2026-04' }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_runs (id, month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, 0, 0, 0, 0, 'complete')
  `).run(id, monthKey);
}

describe('clearStaleSuccessfulRawJson — NOT IN 子查询资金红线 6 case', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('Case 1: NOT IN 子查询正常排除差异行（100 行 bill + 50 差异 + retention=1 → 仅 50 非差异行清；差异行 raw_json 保留）', () => {
    // fixture: 100 行 bill 全部 imported_at = 10 天前；50 行进 diff_rows；retention=1 → 全部老于 1 天
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 50; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });  // 1-50 进 diff_rows
    }

    const before = ctx.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json IS NOT NULL').get().c;
    assert.strictEqual(before, 100, '初始 100 行都有 raw_json');

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 50, '应清 50 非差异行');
    assert.ok(result.elapsedMs >= 0, 'elapsedMs 字段存在');

    // 差异行（id 1-50）raw_json 全部保留
    const diffRowsKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id <= 50 AND raw_json IS NOT NULL
    `).get().c;
    assert.strictEqual(diffRowsKept, 50, '🔴 资金红线：差异行 raw_json 必须全部保留');

    // 非差异行（id 51-100）raw_json 全部清空
    const nonDiffCleared = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id > 50 AND raw_json IS NULL
    `).get().c;
    assert.strictEqual(nonDiffCleared, 50, '非差异行 raw_json 全清');
  });

  test('Case 2: imported_at 边界（retention=7 天）— 8 天前清；6 天前不清', () => {
    insertBill(ctx.db, { id: 1, monthKey: '2026-03', reconId: 'A', raw: '{}', importedAt: nowMinusDays(8) });
    insertBill(ctx.db, { id: 2, monthKey: '2026-03', reconId: 'B', raw: '{}', importedAt: nowMinusDays(6) });
    // 不进 diff_rows → 两行都是对账成功

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(result.clearedCount, 1, '仅 8 天前的行被清');

    const rowA = ctx.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=1').get();
    const rowB = ctx.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=2').get();
    assert.strictEqual(rowA.raw_json, null, '8 天前行 raw_json 已清');
    assert.strictEqual(rowB.raw_json, '{}', '6 天前行 raw_json 保留');
  });

  test('Case 3: raw_json 已 NULL 的行不重复 UPDATE（idempotent — 多次 idle 触发安全）', () => {
    insertBill(ctx.db, { id: 1, monthKey: '2026-03', reconId: 'A', raw: '{}', importedAt: nowMinusDays(10) });
    insertBill(ctx.db, { id: 2, monthKey: '2026-03', reconId: 'B', raw: null, importedAt: nowMinusDays(10) });
    insertBill(ctx.db, { id: 3, monthKey: '2026-03', reconId: 'C', raw: null, importedAt: nowMinusDays(10) });

    // 第一次清：仅 id=1（id=2/3 已 NULL）
    const r1 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r1.clearedCount, 1, '第一次仅清 id=1');

    // 第二次清：已无 raw_json IS NOT NULL 的行 → 0
    const r2 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r2.clearedCount, 0, '第二次幂等 — 无 UPDATE');

    // 第三次清：同样 0
    const r3 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r3.clearedCount, 0, '第三次幂等 — 无 UPDATE');
  });

  test('Case 4: 空表 → clearedCount=0 + 无错误', () => {
    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(result.clearedCount, 0);
    assert.ok(result.elapsedMs >= 0);
  });

  test('Case 5: 全是差异行 → clearedCount=0（NOT IN 子查询全排除）', () => {
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 0, '全是差异行 → 0 清');

    // 验证全部 10 行 raw_json 保留
    const kept = ctx.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json IS NOT NULL').get().c;
    assert.strictEqual(kept, 10, '全部差异行 raw_json 保留');
  });

  test('Case 6: 🔴 资金红线 fail case — 人为破坏 diff_rows 表（DROP）→ 函数 throw 而非错清差异行', () => {
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
    }
    // 5 行进 diff_rows
    for (let i = 1; i <= 5; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    // 人为破坏：DROP diff_rows 表
    ctx.db.exec('DROP TABLE acquiring_bill_currency_diff_rows');

    // 函数应抛 SQL error，而不是错清差异行（如 NOT IN 子查询找不到表时 SQL 应抛而非返回 NULL/empty 误清全部）
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 }),
      /no such table.*acquiring_bill_currency_diff_rows/i,
      '🔴 资金红线：diff_rows 表丢失时函数必须 throw，绝不能错清差异行 raw_json'
    );

    // 验证 raw_json 全部保留（没有任何被清）
    const kept = ctx.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json IS NOT NULL').get().c;
    assert.strictEqual(kept, 10, '🔴 资金红线：throw 后 raw_json 必须全部保留（绝无误清）');
  });

  test('Case 7: SQL injection 防护 — retentionDays 入口严校验 + 参数化绑定双重防御', () => {
    // 写一些数据，确保即使发生 injection 也能观察到错误清空（fail-safe）
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
    }

    // 7.1: 非整数字符串 '1 OR 1=1' — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: '1 OR 1=1' }),
      /retentionDays 必须是 ≥ 1 的整数/,
      'SQL injection 字符串入口拦截'
    );

    // 7.2: 浮点数 1.5 — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1.5 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.3: null/undefined/对象 — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: null }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: undefined }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: { evil: true } }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.4: 0 / 负数 — 入口严校验 throw（防御回退 0 误清未来数据）
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 0 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: -1 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.5: 验证 throw 后 raw_json 全保留（没有任何误清）
    const kept = ctx.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json IS NOT NULL').get().c;
    assert.strictEqual(kept, 10, '入口校验 throw 后 raw_json 必须全部保留');
  });

  test('Case 8: db 入参无效 → throw', () => {
    assert.throws(
      () => clearStaleSuccessfulRawJson(null, { retentionDays: 7 }),
      /db 参数无效/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson({}, { retentionDays: 7 }),
      /db 参数无效/
    );
  });
});
