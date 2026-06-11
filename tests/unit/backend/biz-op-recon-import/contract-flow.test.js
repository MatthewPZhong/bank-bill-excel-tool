'use strict';
// 业务OP对账 流水（flow）引擎契约模块单元测试（v3.0.4 块 C · PR-D）🔴 资金红线
//
// 覆盖（仿 contract-pending.test.js）：
//   - validateContract 通过（schema 合法 + whitelist=null 旁路第 1 层防护）
//   - expectedHeaders 28 列 / mapRow 30 参（[data_date, row_index, ...28 DB 列]，列序对齐 insertSql）
//   - insertSql 与 flow-imports-repository.makeRowInserter byte-for-byte 同源
//   - mapRow 三态：合法行 → params；validateFlowRow 不过 → { error:{rowIndex,reason} }（逐字平移 validator）
//   - mapRow 逐格 normalizeCell（trim）→ DB 行（对齐 reader-streamed obj[dbCol]=normalizeCell(cell)）
//   - deleteForOverwrite = clearRunsAndDiffsByDate + flow clearByDate 2 段共 3 条 SQL（顺序敏感，闭包 date）
//   - cellsOf 从 30 参 params 逆推 28 列 cells（E4 cells 缺口补丁）
//   - maxCollectedErrors=1000 / captureRowValues=true / monthKeyOf=null
//   - 不声明 dedupeKeyOf / finalizeForCommit / rejectEmptyFiles（flow 无跨文件去重 / 无月元数据 / 空文件由 session 判）

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FLOW_HEADERS,
  FLOW_DB_COLUMNS
} = require('../../../../src/backend/biz-op-recon-db/columns');
const { validateContract } = require('../../../../src/backend/big-table-import/contract');
const contractMod = require('../../../../src/backend/biz-op-recon-import/contract-flow');

function mkContract(opts = {}) {
  return contractMod.createContract({ date: opts.date || '2026-06-10' });
}

// 合法流水行的 28 列值（表头序）：direction='入' / recon_amount 数值 / account_no 非空，其余任意。
function validFlowValues(overrides = {}) {
  const v = new Array(28).fill('');
  // 按 FLOW_DB_COLUMNS 索引填关键列（与 columns.js FLOW_COLUMN_DEFS 顺序一致）。
  v[FLOW_DB_COLUMNS.indexOf('direction')] = '入';
  v[FLOW_DB_COLUMNS.indexOf('recon_amount')] = '100.50';
  v[FLOW_DB_COLUMNS.indexOf('account_no')] = 'ACC-001';
  for (const k of Object.keys(overrides)) {
    const idx = FLOW_DB_COLUMNS.indexOf(k);
    if (idx >= 0) v[idx] = overrides[k];
  }
  return v;
}

test('flow 契约通过 validateContract（whitelist=null 旁路第 1 层防护）', () => {
  const c = mkContract();
  const v = validateContract(c);
  assert.equal(v.expectedHeaders.length, 28);
  assert.equal(v.valueColumnWhitelist, null);
  assert.equal(v.captureRowValues, true);
  assert.equal(v.maxCollectedErrors, 1000);
  assert.equal(typeof v.cellsOf, 'function');
  // flow 不声明这些扩展（确认未误带）。
  assert.equal(typeof v.dedupeKeyOf, 'undefined');
  assert.equal(typeof v.finalizeForCommit, 'undefined');
  // validateContract 把未声明的 rejectEmptyFiles 归一为 false（空文件 parity 改由 session 按总行数判，见 contract-flow 头注）。
  assert.equal(v.rejectEmptyFiles, false);
});

test('expectedHeaders = FLOW_HEADERS（28 列，顺序一致）', () => {
  const c = mkContract();
  assert.deepEqual(c.expectedHeaders, FLOW_HEADERS);
  assert.equal(c.expectedHeaders.length, 28);
});

test('insertSql 与 flow-imports-repository.makeRowInserter byte-for-byte 同源', () => {
  // 复刻 flow-imports-repository.buildInsertSql 的构造方式对照（不 require 仓储——平移锁，参 PR-H/PR-C 范式）。
  const cols = ['data_date', 'row_index', ...FLOW_DB_COLUMNS].join(', ');
  const placeholders = ['?', '?', ...FLOW_DB_COLUMNS.map(() => '?')].join(', ');
  const expected = `INSERT INTO biz_op_recon_flow_imports (${cols}) VALUES (${placeholders})`;
  assert.equal(contractMod.FLOW_INSERT_SQL, expected);
  assert.equal(mkContract().insertSql, expected);
});

test('mapRow 合法行 → 30 参（[data_date, row_index, ...28 列]，列序对齐 insertSql）', () => {
  const c = mkContract({ date: '2026-06-10' });
  const values = validFlowValues();
  const m = c.mapRow({ rowR: 42, values });
  assert.ok(Array.isArray(m.params), 'mapRow 合法行返回 { params }');
  assert.equal(m.params.length, 30);
  assert.equal(m.params[0], '2026-06-10');   // data_date = 入参 date
  assert.equal(m.params[1], 42);             // row_index = rowR（Excel 真实行号）
  // 余 28 列 = normalizeCell 后的 DB 列值（表头序）。
  assert.equal(m.params.slice(2).length, 28);
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('direction')], '入');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('recon_amount')], '100.50');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('account_no')], 'ACC-001');
});

test('mapRow 逐格 normalizeCell（trim）→ 对齐 reader-streamed obj[dbCol]=normalizeCell(cell)', () => {
  const c = mkContract({ date: '2026-06-10' });
  // 关键列带首尾空白（reader-streamed 在 reader 内 trim；引擎不 trim，故契约必须补 trim 保 byte-for-byte）。
  const values = validFlowValues({ account_no: '  ACC-002  ', direction: '入' });
  // 给某非关键列也带空白验证全列 trim。
  values[FLOW_DB_COLUMNS.indexOf('biz_id')] = '  B123  ';
  const m = c.mapRow({ rowR: 5, values });
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('account_no')], 'ACC-002', 'account_no 已 trim');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('biz_id')], 'B123', '非关键列也 trim');
});

test('mapRow 三态：出入方向非法 → { error }（逐字平移 validateFlowRow）', () => {
  const c = mkContract();
  const values = validFlowValues({ direction: 'X' });
  const m = c.mapRow({ rowR: 7, values });
  assert.ok(m.error, '非法方向返回 { error }');
  assert.equal(m.error.rowIndex, 7);
  assert.equal(m.error.reason, '出入方向非法：实际值 "X"，仅允许 "入" 或 "出"');
});

test('mapRow 三态：对账金额非数值 → { error }', () => {
  const c = mkContract();
  const values = validFlowValues({ recon_amount: 'abc' });
  const m = c.mapRow({ rowR: 8, values });
  assert.ok(m.error);
  assert.equal(m.error.reason, '对账金额非数值：abc');
});

test('mapRow 三态：账户编号为空 → { error }', () => {
  const c = mkContract();
  const values = validFlowValues({ account_no: '   ' });
  const m = c.mapRow({ rowR: 9, values });
  assert.ok(m.error);
  assert.equal(m.error.reason, '账户编号为空');
});

test('🔴 deleteForOverwrite = clearRunsAndDiffsByDate + flow clearByDate（3 条 SQL，顺序敏感，闭包 date）', () => {
  const c = mkContract({ date: '2026-06-10' });
  const dels = c.deleteForOverwrite();
  assert.equal(dels.length, 3, '必须恰好 3 条 DELETE（diff_rows → runs → flow 主表）');
  // 1) 先删该 date 的 diff_rows（run_id IN 该 date runs）
  assert.match(dels[0].sql, /DELETE FROM biz_op_recon_diff_rows/);
  assert.match(dels[0].sql, /SELECT id FROM biz_op_recon_runs/);
  assert.match(dels[0].sql, /WHERE data_date = \?/);
  assert.deepEqual(dels[0].params, ['2026-06-10']);
  // 2) 删该 date 的 runs（跨所有 BU）
  assert.match(dels[1].sql, /DELETE FROM biz_op_recon_runs/);
  assert.match(dels[1].sql, /WHERE data_date = \?/);
  assert.deepEqual(dels[1].params, ['2026-06-10']);
  // 3) 删该 date 的流水主表行
  assert.equal(dels[2].sql, 'DELETE FROM biz_op_recon_flow_imports WHERE data_date = ?');
  assert.deepEqual(dels[2].params, ['2026-06-10']);
});

test('cellsOf 从 30 参 params 逆推 28 列 cells（E4 cells 缺口补丁）', () => {
  const c = mkContract({ date: '2026-06-10' });
  const values = validFlowValues();
  const m = c.mapRow({ rowR: 3, values });
  const cells = c.cellsOf({ params: m.params });
  assert.equal(cells.length, 28);
  // cells = params.slice(2) = 28 DB 列归一值（表头序）。
  assert.deepEqual(cells, m.params.slice(2));
});

test('cellsOf 防御：params 非数组 → 空数组', () => {
  const c = mkContract();
  assert.deepEqual(c.cellsOf({ params: null }), []);
  assert.deepEqual(c.cellsOf({}), []);
});

test('monthKeyOf 恒返回 null（跨月校验旁路）', () => {
  const c = mkContract();
  assert.equal(c.monthKeyOf(), null);
});

test('buildFlowDbRow：values → DB 行对象（snake_case key + _rowIndex）', () => {
  const values = validFlowValues();
  const row = contractMod.buildFlowDbRow(values, 11);
  assert.equal(row.direction, '入');
  assert.equal(row.recon_amount, '100.50');
  assert.equal(row.account_no, 'ACC-001');
  assert.equal(row._rowIndex, 11);
  // 全 28 DB 列均存在。
  for (const col of FLOW_DB_COLUMNS) assert.ok(col in row, `缺列 ${col}`);
});
