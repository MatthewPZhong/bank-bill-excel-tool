// acquiring-import-recon-perf P0-4 — computeRunStats 单遍 JOIN 等值回归
//
// 目的（spec §9.1.4）：computeRunStats 由「3 条 SQL（total COUNT + matched JOIN + mismatch JOIN）」
//   合并为「total COUNT + 一条 JOIN 的 COUNT(*) + COALESCE(SUM(CASE...),0)」。本测试把**改造前的
//   旧 3-SQL 实现内联**作基线，对同一临时库断言新（runRepo.computeRunStats）旧 4 字段逐字段全等。
//
// ⚠️ 资金红线：computeRunStats 输出（matched/mismatch/unmatched）驱动 run 统计行（写入 runs 表，
//   用户「导出差异」与对账结论依赖）。合并 SQL 必须与旧实现结果完全一致，否则资金口径漂移。
//
// 6 个用例（spec §9.1.4）：
//   ① 空两表（🔴 验证 SUM 空集 COALESCE 陷阱 — 旧实现 mismatch=0 / 新实现必须也 =0 而非 NULL）
//   ② 全 matched 无 mismatch（币种全等）
//   ③ 全 mismatch（币种全不等）
//   ④ NULL 与 '' 币种混合（双侧）—— 验证 COALESCE(...,'') 谓词把 NULL 与 '' 视作相等
//   ⑤ 多月共存只算目标月（WHERE month_key 隔离）
//   ⑥ 存在 unmatched（bill 有 recon_main_id 但 flow 无对应）

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const runRepo = require('../../../../src/backend/acquiring-bill-currency-db/run-repository');
const {
  ensureAcquiringBillCurrencyTablesSupport,
  ensureAcquiringBillCurrencyRunsCleanupPending,
  ensureAcquiringBillCurrencyRunsChunkProgress,
} = require('../../../../src/backend/database/migrations');

const BILL_TABLE = 'acquiring_bill_currency_bill_imports';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureAcquiringBillCurrencyTablesSupport(db);
  ensureAcquiringBillCurrencyRunsCleanupPending(db);
  ensureAcquiringBillCurrencyRunsChunkProgress(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

// ─────────────────────────────────────────────────────────────────
// 改造前的旧 3-SQL 实现（内联基线）—— 与 git HEAD computeRunStats 逐字相同
//   total COUNT + matched JOIN COUNT + mismatch JOIN COUNT；unmatched = total − matched
// ─────────────────────────────────────────────────────────────────
function computeRunStatsLegacy(db, { monthKey }) {
  const totalBillRows = db.prepare(`SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?`).get(monthKey).c;

  const matchedRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
  `).get(monthKey).c;

  const mismatchRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
      AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `).get(monthKey).c;

  const unmatchedRows = totalBillRows - matchedRows;
  return { totalBillRows, matchedRows, mismatchRows, unmatchedRows };
}

// ─────────────────────────────────────────────────────────────────
// fixture helper：逐行插 bill / flow（settle_currency_norm 可显式传 null 或 ''）
//   bill: (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, imported_at, raw_json)
//   flow: (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs, raw_json, imported_at)
// ─────────────────────────────────────────────────────────────────
const NOW = '2026-03-01T00:00:00Z';

function insertBill(db, { monthKey, idx, reconId, currencyNorm }) {
  db.prepare(`
    INSERT INTO ${BILL_TABLE}
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, imported_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(monthKey, 'bill.xlsx', idx, reconId, currencyNorm == null ? '' : String(currencyNorm).toUpperCase(), currencyNorm, NOW, '');
}

function insertFlow(db, { monthKey, idx, reconId, currencyNorm }) {
  db.prepare(`
    INSERT INTO ${FLOW_TABLE}
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(monthKey, 'flow.xlsx', idx, reconId, currencyNorm == null ? '' : String(currencyNorm).toUpperCase(), currencyNorm, '100', '100', '', NOW);
}

// 断言新实现与旧 3-SQL 基线 4 字段逐字段全等，并返回值供二次断言
function assertParityWithLegacy(db, monthKey, label) {
  const legacy = computeRunStatsLegacy(db, { monthKey });
  const merged = runRepo.computeRunStats(db, { monthKey });
  assert.equal(merged.totalBillRows, legacy.totalBillRows, `${label}: totalBillRows 新旧一致`);
  assert.equal(merged.matchedRows, legacy.matchedRows, `${label}: matchedRows 新旧一致`);
  assert.equal(merged.mismatchRows, legacy.mismatchRows, `${label}: mismatchRows 新旧一致`);
  assert.equal(merged.unmatchedRows, legacy.unmatchedRows, `${label}: unmatchedRows 新旧一致`);
  return merged;
}

test.describe('computeRunStats — 单遍 JOIN 与旧 3-SQL 实现等值（P0-4）', () => {

  test('① 空两表 → matched/mismatch/unmatched 全 0（🔴 SUM 空集 COALESCE 陷阱）', () => {
    const monthKey = '2026-03';
    const r = assertParityWithLegacy(db, monthKey, 'Case①空表');
    // 显式断言新实现没有把空集 SUM 的 NULL 透出（必须是数值 0，不是 null）
    assert.equal(r.totalBillRows, 0);
    assert.equal(r.matchedRows, 0);
    assert.strictEqual(r.mismatchRows, 0, '空集 SUM 必须 COALESCE 为 0（非 NULL）');
    assert.equal(r.unmatchedRows, 0);
  });

  test('② 全 matched 无 mismatch（币种全等）', () => {
    const monthKey = '2026-03';
    for (let i = 1; i <= 5; i++) {
      insertBill(db, { monthKey, idx: i, reconId: `R${i}`, currencyNorm: 'cny' });
      insertFlow(db, { monthKey, idx: i, reconId: `R${i}`, currencyNorm: 'cny' });
    }
    const r = assertParityWithLegacy(db, monthKey, 'Case②全matched');
    assert.equal(r.totalBillRows, 5);
    assert.equal(r.matchedRows, 5);
    assert.equal(r.mismatchRows, 0);
    assert.equal(r.unmatchedRows, 0);
  });

  test('③ 全 mismatch（币种全不等）', () => {
    const monthKey = '2026-03';
    for (let i = 1; i <= 4; i++) {
      insertBill(db, { monthKey, idx: i, reconId: `R${i}`, currencyNorm: 'usd' });
      insertFlow(db, { monthKey, idx: i, reconId: `R${i}`, currencyNorm: 'eur' });
    }
    const r = assertParityWithLegacy(db, monthKey, 'Case③全mismatch');
    assert.equal(r.totalBillRows, 4);
    assert.equal(r.matchedRows, 4);
    assert.equal(r.mismatchRows, 4);
    assert.equal(r.unmatchedRows, 0);
  });

  test('④ NULL 与 \'\' 币种混合（双侧）→ COALESCE 把 NULL 与 \'\' 视作相等', () => {
    const monthKey = '2026-03';
    // R1: bill=null,  flow=''   → COALESCE 后 ''='' → 相等（不计 mismatch）
    insertBill(db, { monthKey, idx: 1, reconId: 'R1', currencyNorm: null });
    insertFlow(db, { monthKey, idx: 1, reconId: 'R1', currencyNorm: '' });
    // R2: bill='',    flow=null → 同上相等
    insertBill(db, { monthKey, idx: 2, reconId: 'R2', currencyNorm: '' });
    insertFlow(db, { monthKey, idx: 2, reconId: 'R2', currencyNorm: null });
    // R3: bill=null,  flow='cny'→ '' <> 'cny' → mismatch
    insertBill(db, { monthKey, idx: 3, reconId: 'R3', currencyNorm: null });
    insertFlow(db, { monthKey, idx: 3, reconId: 'R3', currencyNorm: 'cny' });
    // R4: bill='cny', flow=''   → 'cny' <> '' → mismatch
    insertBill(db, { monthKey, idx: 4, reconId: 'R4', currencyNorm: 'cny' });
    insertFlow(db, { monthKey, idx: 4, reconId: 'R4', currencyNorm: '' });
    // R5: bill=null,  flow=null → 相等
    insertBill(db, { monthKey, idx: 5, reconId: 'R5', currencyNorm: null });
    insertFlow(db, { monthKey, idx: 5, reconId: 'R5', currencyNorm: null });
    const r = assertParityWithLegacy(db, monthKey, 'Case④NULL与空混合');
    assert.equal(r.totalBillRows, 5);
    assert.equal(r.matchedRows, 5);
    assert.equal(r.mismatchRows, 2, 'R3 + R4 两行 mismatch（NULL/空 视作相等）');
    assert.equal(r.unmatchedRows, 0);
  });

  test('⑤ 多月共存只算目标月（WHERE month_key 隔离）', () => {
    const target = '2026-03';
    const other = '2026-04';
    // 目标月：3 matched + 2 mismatch
    for (let i = 1; i <= 3; i++) {
      insertBill(db, { monthKey: target, idx: i, reconId: `R${i}`, currencyNorm: 'cny' });
      insertFlow(db, { monthKey: target, idx: i, reconId: `R${i}`, currencyNorm: 'cny' });
    }
    for (let i = 4; i <= 5; i++) {
      insertBill(db, { monthKey: target, idx: i, reconId: `R${i}`, currencyNorm: 'usd' });
      insertFlow(db, { monthKey: target, idx: i, reconId: `R${i}`, currencyNorm: 'eur' });
    }
    // 其它月：大量噪声（10 行全 mismatch，且 recon_main_id 与目标月重叠以验证 month_key 不串）
    for (let i = 1; i <= 10; i++) {
      insertBill(db, { monthKey: other, idx: i, reconId: `R${i}`, currencyNorm: 'jpy' });
      insertFlow(db, { monthKey: other, idx: i, reconId: `R${i}`, currencyNorm: 'gbp' });
    }
    const r = assertParityWithLegacy(db, target, 'Case⑤多月共存');
    assert.equal(r.totalBillRows, 5, '只算目标月 bill');
    assert.equal(r.matchedRows, 5);
    assert.equal(r.mismatchRows, 2);
    assert.equal(r.unmatchedRows, 0);
    // 其它月单独算应得 10/10/10/0（顺带验证隔离另一侧）
    const ro = assertParityWithLegacy(db, other, 'Case⑤其它月');
    assert.equal(ro.totalBillRows, 10);
    assert.equal(ro.mismatchRows, 10);
  });

  test('⑥ 存在 unmatched（bill 有 recon_main_id 但 flow 无对应）', () => {
    const monthKey = '2026-03';
    // 3 行 bill JOIN 上 flow（1 matched 等 / 2 mismatch）
    insertBill(db, { monthKey, idx: 1, reconId: 'R1', currencyNorm: 'cny' });
    insertFlow(db, { monthKey, idx: 1, reconId: 'R1', currencyNorm: 'cny' });
    insertBill(db, { monthKey, idx: 2, reconId: 'R2', currencyNorm: 'usd' });
    insertFlow(db, { monthKey, idx: 2, reconId: 'R2', currencyNorm: 'eur' });
    insertBill(db, { monthKey, idx: 3, reconId: 'R3', currencyNorm: 'usd' });
    insertFlow(db, { monthKey, idx: 3, reconId: 'R3', currencyNorm: 'jpy' });
    // 2 行 bill 没有对应 flow（recon_main_id 在 flow 缺席）→ unmatched
    insertBill(db, { monthKey, idx: 4, reconId: 'R4-noflow', currencyNorm: 'cny' });
    insertBill(db, { monthKey, idx: 5, reconId: 'R5-noflow', currencyNorm: 'cny' });
    const r = assertParityWithLegacy(db, monthKey, 'Case⑥unmatched');
    assert.equal(r.totalBillRows, 5);
    assert.equal(r.matchedRows, 3, 'JOIN 上 3 行');
    assert.equal(r.mismatchRows, 2, 'R2 + R3 mismatch');
    assert.equal(r.unmatchedRows, 2, 'R4/R5 无 flow → unmatched = total − matched');
  });
});
