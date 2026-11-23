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

// v3.2.21：候补可以是特征值（`\u0000__FEATURE_FILTER__:<id>`）——取该行筛出的特征值，未筛出视为空取下一个候补，不记未筛出提示；
//   特征值候补不按源字段校验表头，其筛选源字段由特征值启用时校验。
const { buildFeatureFilterToken } = require('../../../../src/backend/file-service/feature-filter');
const {
  buildLogicValueFeatureCandidate,
  collectLogicValueFeatureFilterIds,
  parseLogicValueFeatureFilterRef
} = require('../../../../src/backend/file-service/logic-value');

test('特征值候补：源字段与特征值候补分开收集，按首次出现去重', () => {
  const lookup = {
    BillDate: buildLogicValueToken([buildLogicValueFeatureCandidate('2'), '记账日']),
    Remark: [buildLogicValueToken(['摘要', buildLogicValueFeatureCandidate('1'), buildLogicValueFeatureCandidate('2')]), '用途'],
    'Payee Name': buildFeatureFilterToken('3')
  };
  assert.deepEqual(collectLogicValueFields(lookup), ['记账日', '摘要']);
  assert.deepEqual(collectLogicValueFeatureFilterIds(lookup), ['2', '1']);
  assert.equal(parseLogicValueFeatureFilterRef(buildLogicValueFeatureCandidate(' 7 ')), '7');
  assert.equal(buildLogicValueFeatureCandidate(' 7 '), '\u0000__FEATURE_FILTER__:7');
  assert.equal(parseLogicValueFeatureFilterRef('摘要'), null);
  // 旧版本（v3.2.19/v3.2.20）的候补都是源列名：形如直选特征值 token 的列名仍是源字段
  assert.equal(parseLogicValueFeatureFilterRef(buildFeatureFilterToken('7')), null);
});

test('buildMappedRows：特征值候补取筛出值，未筛出取下一个候补且不记未筛出提示；只经候补引用的特征值也校验筛选源字段', (t) => {
  const header = ['日期', '附言', '摘要', '收入'];
  const filePath = writeXlsx(t, header, [
    ['2026-11-01', '订单 FT24123456 货款', '备注一', '100'],
    ['2026-11-02', '无订单号', '备注二', '50'],
    ['2026-11-03', '', '', '20']
  ]);
  const featureFilters = { 1: { id: '1', name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true } };
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: {
      BillDate: '日期',
      'Credit Amount': '收入',
      Remark: buildLogicValueToken([buildLogicValueFeatureCandidate('1'), '摘要'])
    },
    featureFilters,
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[2]), ['FT24123456', '备注二', '']);
  assert.deepEqual((mapped.issues || []).filter((issue) => issue.type === 'feature-value-unmatched'), []);

  // 同一特征值另被直接选用时，直接选用的字段照常记未筛出提示（只按直接引用）
  const both = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark', 'Reference'],
    mappingByField: {
      BillDate: '日期',
      'Credit Amount': '收入',
      Remark: buildLogicValueToken([buildLogicValueFeatureCandidate('1'), '摘要']),
      Reference: buildFeatureFilterToken('1')
    },
    featureFilters,
    expectedSourceHeaders: header
  });
  assert.deepEqual(both.slice(1).map((row) => [row[2], row[3]]), [['FT24123456', 'FT24123456'], ['备注二', ''], ['', '']]);
  assert.deepEqual((both.issues || []).filter((issue) => issue.type === 'feature-value-unmatched').map((issue) => issue.rowNumber), [3, 4]);

  // 特征值不存在、筛选源字段不在源文件表头时拒绝生成
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Remark'],
    mappingByField: { BillDate: '日期', Remark: buildLogicValueToken([buildLogicValueFeatureCandidate('9'), '摘要']) },
    featureFilters,
    expectedSourceHeaders: header
  }), /特征值：映射选择的特征值不存在/);
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Remark'],
    mappingByField: { BillDate: '日期', Remark: buildLogicValueToken([buildLogicValueFeatureCandidate('1'), '摘要']) },
    featureFilters: { 1: { ...featureFilters[1], sourceField: '旧附言' } },
    expectedSourceHeaders: header
  }), /映射字段不存在：旧附言/);
});

test('buildMappedRows：BillDate 逻辑取值的特征值候补把合计标签筛成空时，按筛选源单元格识别合计行，不把合计金额当交易导出', (t) => {
  const header = ['交易日期', '记账日期', '收入'];
  const filePath = writeXlsx(t, header, [
    ['20261101 0930', '', '100'],
    ['合计', '2026-11-30', '100']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: {
      BillDate: buildLogicValueToken([buildLogicValueFeatureCandidate('1'), '记账日期']),
      'Credit Amount': '收入'
    },
    featureFilters: { 1: { id: '1', name: '日期', sourceField: '交易日期', separator: 'space', length: 8, letterPrefixCount: null, digitsOnly: true } },
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[1]]), [['20261101', '100']]);
  assert.deepEqual((mapped.issues || []).filter((issue) => issue.type === 'summary-row-skipped').map((issue) => [issue.rowNumber, issue.rawValue]), [[3, '合计']]);
});

test('buildMappedRows：BillDate 逻辑取值只检查实际查看过的特征值候补，已取到值之后的候补源单元格是合计标签时不跳过真实交易', (t) => {
  const header = ['记账日期', '摘要', '收入'];
  const filePath = writeXlsx(t, header, [
    ['2026-11-02', 'Total', '10'],
    ['', 'Total', '10']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: {
      BillDate: buildLogicValueToken(['记账日期', buildLogicValueFeatureCandidate('1')]),
      'Credit Amount': '收入'
    },
    featureFilters: { 1: { id: '1', name: '日期', sourceField: '摘要', separator: 'space', length: 8, letterPrefixCount: null, digitsOnly: true } },
    expectedSourceHeaders: header
  });
  // 第 2 行记账日期已取到值，不看其后的特征值候补；第 3 行记账日期为空、查看特征值候补，源单元格是合计标签 → 合计行
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[1]]), [['2026-11-02', '10']]);
  assert.deepEqual((mapped.issues || []).filter((issue) => issue.type === 'summary-row-skipped').map((issue) => [issue.rowNumber, issue.rawValue]), [[3, 'Total']]);
});

// v3.2.19/v3.2.20 的候补都是源列名，列名恰好形如 `__FEATURE_FILTER__:1` 时升级后仍按源列取值，
//   不被同 id 的特征值替换（资金红线：发生额不能改从另一列取值）。
test('buildMappedRows：旧候补里形如 __FEATURE_FILTER__:1 的源列名仍按源列取值，不读同 id 特征值', (t) => {
  const legacyColumn = buildFeatureFilterToken('1');
  const header = ['日期', legacyColumn, '附言', '收入2'];
  const filePath = writeXlsx(t, header, [['2026-11-01', '100', '订单 FT24123456 货款', '7']]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '日期', 'Credit Amount': buildLogicValueToken([legacyColumn, '收入2']) },
    featureFilters: { 1: { id: '1', name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true } },
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[1]), ['100']);
  assert.deepEqual(collectLogicValueFields({ 'Credit Amount': buildLogicValueToken([legacyColumn, '收入2']) }), [legacyColumn, '收入2']);
  assert.deepEqual(collectLogicValueFeatureFilterIds({ 'Credit Amount': buildLogicValueToken([legacyColumn, '收入2']) }), []);
});

test('buildMappedRows：源文件列名与特征值候补内部写法相同（构造的含 NUL 列名）时拒绝生成，不任选其一', (t) => {
  const collision = buildLogicValueFeatureCandidate('1');
  const header = ['日期', collision, '附言'];
  const filePath = writeXlsx(t, header, [['2026-11-01', '100', '订单 FT24123456 货款']]);
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '日期', 'Credit Amount': buildLogicValueToken([collision, '附言']) },
    featureFilters: { 1: { id: '1', name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true } },
    expectedSourceHeaders: header
  }), /无法区分源列与特征值/);
});

test('buildMappedRows：没有 id 的特征值候补按特征值不存在拒绝生成，不当作未筛出而改取下一个候补', (t) => {
  const header = ['日期', '收入', '收入2'];
  const filePath = writeXlsx(t, header, [['2026-11-01', '', '7']]);
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: '日期', 'Credit Amount': buildLogicValueToken([buildLogicValueFeatureCandidate(''), '收入2']) },
    featureFilters: {},
    expectedSourceHeaders: header
  }), /特征值：映射选择的特征值不存在/);
});

test('buildMappedRows：预处理过滤掉、BillDate 特征值候补源单元格是合计标签但回落日期有效的行仍算上一段的交易行（v3.2.19 口径），保留时照常按合计行跳过', (t) => {
  const header = ['类型', '交易日期', '记账日期', '收入'];
  const rows = [
    ['交易', '20261101 0930', '', '100'],
    ['其他', '20261102 1000', '', '20'],
    ['其他', 'Total', '2026-11-30', '120']
  ];
  const filePath = writeXlsx(t, header, rows);
  const options = (preprocessRowFilterRules) => ({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: {
      BillDate: buildLogicValueToken([buildLogicValueFeatureCandidate('1'), '记账日期']),
      'Credit Amount': '收入'
    },
    featureFilters: { 1: { id: '1', name: '日期', sourceField: '交易日期', separator: 'space', length: 8, letterPrefixCount: null, digitsOnly: true } },
    preprocessRowFilterRules,
    expectedSourceHeaders: header
  });
  // 被过滤：第 4 行仍计入（保持 v3.2.19 口径，作为桥接候选的界线；直接识别不受界线裁剪，见 backlog B122）
  const filtered = buildMappedRows(options([{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '交易' }] }]));
  assert.deepEqual(filtered.preprocessRowFilterStats.droppedTransactionRowNumbers, [3, 4]);
  // 保留：第 4 行按合计行跳过，不进明细
  const kept = buildMappedRows(options(null));
  assert.deepEqual(kept.slice(1).map((row) => row[1]), ['100', '20']);
  assert.deepEqual((kept.issues || []).filter((issue) => issue.type === 'summary-row-skipped').map((issue) => issue.rowNumber), [4]);
});
