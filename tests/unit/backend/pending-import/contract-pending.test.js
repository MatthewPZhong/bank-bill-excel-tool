'use strict';
// 挂账 Pending 引擎契约模块单元测试（v3.0.4 块 B · PR-C）🔴🔴 资金红线
//
// 覆盖：
//   - validateContract 通过（schema 合法 + whitelist=null 旁路第 1 层防护）
//   - expectedHeaders 31 列 / mapRow 33 参（[year_month, row_hash, ...cells31]）
//   - insertSql 与 month-repository.createRowInserter byte-for-byte 同源
//   - deleteForOverwrite 6 条 SQL + 参数 + 顺序逐字平移 month-repository.deleteMonth（🔴 R-1 红线）
//   - finalizeForCommit upsertMonthMeta 字段（rowCount/sourceFiles/archivePath/importedAt）
//   - dedupeKeyOf 与 mapRow rowHash 同源（computeRowHash）+ 共算一次（memo）
//   - formatDuplicateError 文案逐字（发现重复行（hash xxxxxxxx...））
//   - cellsOf 从 33 参 params 逆推 31 列 cells（E5 cells 缺口补丁）
//   - rejectEmptyFiles/formatEmptyFileError/maxCollectedErrors=1000/captureRowValues=true/monthKeyOf=null

const { test } = require('node:test');
const assert = require('node:assert/strict');

const PENDING_COLUMNS = require('../../../../src/backend/pending-db/columns');
const { computeRowHash } = require('../../../../src/backend/pending-import/validator');
const { validateContract } = require('../../../../src/backend/big-table-import/contract');
const contractMod = require('../../../../src/backend/pending-import/contract-pending');

function mkContract(opts = {}) {
  return contractMod.createContract({
    yearMonth: opts.yearMonth || '2026-06',
    archivePath: opts.archivePath !== undefined ? opts.archivePath : null,
    importedAt: opts.importedAt || '2026-06-11T00:00:00.000Z'
  });
}

test('pending 契约通过 validateContract（whitelist=null 旁路第 1 层防护）', () => {
  const c = mkContract();
  const v = validateContract(c);
  assert.equal(v.expectedHeaders.length, 31);
  assert.equal(v.valueColumnWhitelist, null);
  assert.equal(v.rejectEmptyFiles, true);
  assert.equal(v.captureRowValues, true);
  assert.equal(v.maxCollectedErrors, 1000);
  assert.equal(typeof v.cellsOf, 'function');
});

test('expectedHeaders = PENDING_COLUMNS（31 列，顺序一致）', () => {
  const c = mkContract();
  assert.deepEqual(c.expectedHeaders, PENDING_COLUMNS);
});

test('mapRow → 33 参（[year_month, row_hash, ...cells31]，列序对齐 insertSql）', () => {
  const c = mkContract({ yearMonth: '2026-06' });
  const values = new Array(31).fill('').map((_, i) => 'v' + i);
  const m = c.mapRow({ values });
  assert.equal(m.params.length, 33);
  assert.equal(m.params[0], '2026-06');                  // year_month
  assert.equal(m.params[1], computeRowHash(values));     // row_hash 与 computeRowHash 同源
  assert.deepEqual(m.params.slice(2), values);           // 余 31 列原样
});

test('insertSql 与 month-repository.createRowInserter byte-for-byte 同源', () => {
  // 复刻 createRowInserter 的 SQL 构造方式对照（不 require 仓储——平移锁，参 PR-H 范式）。
  const colList = PENDING_COLUMNS.map((cc) => `\`${cc}\``).join(', ');
  const placeholders = PENDING_COLUMNS.map(() => '?').join(', ');
  const expected = `INSERT INTO pending_rows (year_month, row_hash, ${colList}) VALUES (?, ?, ${placeholders})`;
  assert.equal(contractMod.PENDING_INSERT_SQL, expected);
  assert.equal(mkContract().insertSql, expected);
});

test('🔴 deleteForOverwrite = deleteMonth 6 条 SQL+参数+顺序逐字平移（R-1 Codex PR #55 Finding 1 红线）', () => {
  const c = mkContract({ yearMonth: '2026-06' });
  const dels = c.deleteForOverwrite();
  assert.equal(dels.length, 6, '必须恰好 6 条 DELETE');
  // 顺序：pending_removal_matches → diff_rows → diff_runs → removed_pending_rows → pending_rows → pending_months
  assert.match(dels[0].sql, /DELETE FROM pending_removal_matches WHERE run_id IN \(/);
  assert.match(dels[0].sql, /SELECT id FROM diff_runs WHERE upper_month = \? OR lower_month = \?/);
  assert.deepEqual(dels[0].params, ['2026-06', '2026-06']);
  assert.match(dels[1].sql, /DELETE FROM diff_rows WHERE run_id IN \(/);
  assert.match(dels[1].sql, /SELECT id FROM diff_runs WHERE upper_month = \? OR lower_month = \?/);
  assert.deepEqual(dels[1].params, ['2026-06', '2026-06']);
  assert.equal(dels[2].sql, 'DELETE FROM diff_runs WHERE upper_month = ? OR lower_month = ?');
  assert.deepEqual(dels[2].params, ['2026-06', '2026-06']);
  assert.equal(dels[3].sql, 'DELETE FROM removed_pending_rows WHERE year_month = ?');
  assert.deepEqual(dels[3].params, ['2026-06']);
  assert.equal(dels[4].sql, 'DELETE FROM pending_rows WHERE year_month = ?');
  assert.deepEqual(dels[4].params, ['2026-06']);
  assert.equal(dels[5].sql, 'DELETE FROM pending_months WHERE year_month = ?');
  assert.deepEqual(dels[5].params, ['2026-06']);
});

test('finalizeForCommit = upsertMonthMeta（rowCount/sourceFiles/archivePath/importedAt 字段）', () => {
  const c = mkContract({ yearMonth: '2026-06', archivePath: '/a/b.xlsx', importedAt: '2026-06-11T00:00:00.000Z' });
  const fin = c.finalizeForCommit({ totalImported: 42, sourceFiles: ['x.xlsx', 'y.xlsx'] });
  assert.equal(fin.length, 1);
  assert.match(fin[0].sql, /INSERT INTO pending_months \(year_month, imported_at, row_count, source_files, archive_path\)/);
  assert.match(fin[0].sql, /ON CONFLICT\(year_month\) DO UPDATE SET/);
  assert.deepEqual(fin[0].params, [
    '2026-06', '2026-06-11T00:00:00.000Z', 42, JSON.stringify(['x.xlsx', 'y.xlsx']), '/a/b.xlsx'
  ]);
});

test('finalizeForCommit archivePath=null 透传 null', () => {
  const c = mkContract({ archivePath: null });
  const fin = c.finalizeForCommit({ totalImported: 0, sourceFiles: [] });
  assert.equal(fin[0].params[4], null);
  assert.equal(fin[0].params[2], 0);
});

test('dedupeKeyOf 与 mapRow rowHash 同源（computeRowHash）+ 共算一次（memo 复用）', () => {
  const c = mkContract();
  const values = new Array(31).fill('').map((_, i) => 'd' + i);
  const m = c.mapRow({ values });
  const k = c.dedupeKeyOf({ values });
  assert.equal(k, computeRowHash(values));
  assert.equal(k, m.params[1], 'dedupeKey 与 mapRow row_hash 必须同值');
  // 不同行（不同引用 + 内容）→ 不同 hash（memo 不串行污染）
  const values2 = new Array(31).fill('').map((_, i) => 'e' + i);
  assert.notEqual(c.dedupeKeyOf({ values: values2 }), k);
});

test('formatDuplicateError 文案逐字（发现重复行（hash xxxxxxxx...））', () => {
  const c = mkContract();
  const key = 'abcdef0123456789abcdef0123456789abcdef01'; // 40 字符 sha1 hex
  assert.equal(c.formatDuplicateError({ key }), '发现重复行（hash abcdef01...）');
});

test('cellsOf 从 33 参 params 逆推 31 列 cells（E5 cells 缺口补丁）', () => {
  const c = mkContract({ yearMonth: '2026-06' });
  const values = new Array(31).fill('').map((_, i) => 'c' + i);
  const m = c.mapRow({ values });
  const cells = c.cellsOf({ params: m.params });
  assert.equal(cells.length, 31);
  assert.deepEqual(cells, values, 'cellsOf 应还原原始 31 列 cells（去 year_month/row_hash）');
});

test('cellsOf 防御：params 非数组 → 空数组', () => {
  const c = mkContract();
  assert.deepEqual(c.cellsOf({ params: null }), []);
  assert.deepEqual(c.cellsOf({}), []);
});

test('monthKeyOf 恒返回 null（跨月校验旁路）；空文件文案逐字', () => {
  const c = mkContract();
  assert.equal(c.monthKeyOf(), null);
  assert.equal(c.formatEmptyFileError('z.xlsx'), 'z.xlsx：文件为空或只有表头行');
});
