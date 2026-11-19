'use strict';

// v3.2.19 映射字段「逻辑取值 → 候补字段取值」（spec §8.4）：
//   - token 带有序候补字段，与真实表头不会重名；候补字段去空白、去空、去重；
//   - 生成：按顺序取第一个去首尾空白后非空的单元格，全部为空输出空，之后按目标字段规范化（日期、金额）；
//   - 候补字段不在源文件表头时拒绝生成（映射字段不存在）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  buildLogicValueToken,
  collectLogicValueFields,
  normalizeLogicValueFields,
  parseLogicValueToken,
  resolveLogicValue
} = require('../../../../src/backend/file-service/logic-value');
const { buildMappedRows } = require('../../../../src/backend/file-service');

test('token：候补字段有序、去空白去空去重；非 token、只是以前缀开头的普通列名返回 null（按源字段处理）', () => {
  assert.deepEqual(normalizeLogicValueFields([' 户名 ', '', '摘要', '户名', null]), ['户名', '摘要']);
  const token = buildLogicValueToken(['户名', ' 摘要']);
  assert.deepEqual(parseLogicValueToken(token), ['户名', '摘要']);
  assert.equal(parseLogicValueToken('户名'), null);
  assert.equal(parseLogicValueToken(['户名']), null);
  ['__LOGIC_VALUE__:{坏', '__LOGIC_VALUE__:fee', '__LOGIC_VALUE__:[]', '__LOGIC_VALUE__:123', '__LOGIC_VALUE__:[1,2]']
    .forEach((value) => assert.equal(parseLogicValueToken(value), null, value));
  assert.deepEqual(collectLogicValueFields({
    'Payee Name': token,
    Remark: [buildLogicValueToken(['摘要', '附言']), '用途'],
    BillDate: '日期'
  }), ['户名', '摘要', '附言']);
});

test('取值：按顺序取第一个去首尾空白后非空的原值；全部为空返回空串', () => {
  const row = { 户名: '  ', 摘要: ' 货款 ', 附言: '备注' };
  assert.equal(resolveLogicValue(['户名', '摘要', '附言'], (field) => row[field]), ' 货款 ');
  assert.equal(resolveLogicValue(['附言', '摘要'], (field) => row[field]), '备注');
  assert.equal(resolveLogicValue(['户名', '不存在'], (field) => row[field]), '');
  assert.equal(resolveLogicValue([], () => 'x'), '');
});

function writeXlsx(t, header, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logic-value-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'logic.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('buildMappedRows：逻辑取值逐行取第一个非空候补，再按目标字段规范化；缺候补字段拒绝生成', (t) => {
  const header = ['记账日', '交易日', '收入', '收入2', '对方户名', '摘要'];
  const filePath = writeXlsx(t, header, [
    ['', '2026-11-01', '1,200.50', '', '', '货款'],
    ['2026-11-02', '2026-11-03', '', '30', '甲公司', '退款'],
    ['2026-11-04', '', '', '', '', '']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Debit Amount', 'Payee Name'],
    mappingByField: {
      BillDate: buildLogicValueToken(['记账日', '交易日']),
      'Credit Amount': buildLogicValueToken(['收入', '收入2']),
      'Payee Name': buildLogicValueToken(['对方户名', '摘要'])
    },
    expectedSourceHeaders: header
  });
  // 金额去千分位（同直接映射），收支都为空的第 4 行照常留在映射结果中（导出明细时按既有规则跳过）
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[1], row[3]]), [
    ['2026-11-01', '1200.50', '货款'],
    ['2026-11-02', '30', '甲公司'],
    ['2026-11-04', '', '']
  ]);
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 3, 4]);

  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '记账日', 'Credit Amount': buildLogicValueToken(['收入', '收入3']) },
    expectedSourceHeaders: header
  }), /映射字段不存在：收入3/);
});

test('token 以 NUL 开头：真实列名（即使形如 __LOGIC_VALUE__:[…]）不会被当作逻辑取值', () => {
  assert.equal(parseLogicValueToken('__LOGIC_VALUE__:["A","B"]'), null);
  assert.ok(buildLogicValueToken(['A', 'B']).startsWith('\u0000'));
});

test('buildMappedRows：同时有候补字段 A、B 与一列名为 __LOGIC_VALUE__:["A","B"] 时，新配置的逻辑取值仍按候补取值', (t) => {
  const tokenLike = '__LOGIC_VALUE__:["A","B"]';
  const header = ['日期', 'A', 'B', tokenLike];
  const filePath = writeXlsx(t, header, [['2026-11-01', '1', '2', '300']]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '日期', 'Credit Amount': buildLogicValueToken(['A', 'B']) },
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[1]), ['1']);
});

test('buildMappedRows：以内部前缀开头的真实列名照常按源字段直接取值（旧模板兼容）', (t) => {
  const header = ['日期', '__LOGIC_VALUE__:fee'];
  const filePath = writeXlsx(t, header, [['2026-11-01', '12.5']]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '日期', 'Credit Amount': '__LOGIC_VALUE__:fee' },
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[1]]), [['2026-11-01', '12.5']]);
});
