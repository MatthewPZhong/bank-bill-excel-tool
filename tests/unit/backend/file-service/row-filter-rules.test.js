'use strict';

// v3.2.19 过滤规则通用模块与「原始账单预处理 → 过滤账单」：
//   - 字段运算 等于（字段）/ 不等于（字段）/ 包含（字段）/ 不包含（字段）：与同一行另一字段比较；
//     被比较字段为空时 包含（字段）不命中、不包含（字段）命中，等于 / 不等于（字段）按文本比较；
//   - 预处理：只保留命中规则的源行（原始账单加工表），之后的映射、拆分过滤、合计行识别与统计都基于加工表，
//     行号仍为源文件物理行号。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  collectRowFilterRuleFields,
  compileRowFilterRules,
  matchesRowFilterRules,
  normalizeRowFilterRules,
  validateRowFilterRules
} = require('../../../../src/backend/file-service/row-filter-rules');
const {
  compileBillSplitRowFilter,
  matchesBillSplitRowFilter
} = require('../../../../src/backend/file-service/bill-split-row-filter');
const { buildFeatureFilterToken, buildMappedRows } = require('../../../../src/backend/file-service');

function rule(...conditions) {
  return { conditions: conditions.map(([field, op, value = '']) => ({ field, op, value })) };
}

function matcher(rules, header = ['A', 'B']) {
  const compiled = compileRowFilterRules(rules, new Map(header.map((field, index) => [field, index])));
  return (row) => matchesRowFilterRules(row, compiled);
}

test('字段运算：与同一行另一字段去首尾空白后按文本比较，区分大小写；被比较字段为空时包含不命中、不包含命中', () => {
  const cases = [
    ['等于（字段）', [['abc', ' abc '], true], [['abc', 'ABC'], false], [['', ''], true], [['1', ''], false]],
    ['不等于（字段）', [['abc', 'abc'], false], [['abc', 'abd'], true], [['', ''], false], [['', 'x'], true]],
    ['包含（字段）', [['退款-甲', '甲'], true], [['退款-甲', '乙'], false], [['退款-甲', ''], false], [['', ''], false], [['ab', 'B'], false]],
    ['不包含（字段）', [['退款-甲', '甲'], false], [['退款-甲', '乙'], true], [['退款-甲', ''], true], [['', ''], true]]
  ];
  cases.forEach(([op, ...samples]) => {
    const match = matcher([rule(['A', op, 'B'])]);
    samples.forEach(([row, expected]) => {
      assert.equal(match(row), expected, `${op} ← ${JSON.stringify(row)}`);
    });
  });
  // 不做数值换算
  assert.equal(matcher([rule(['A', '等于（字段）', 'B'])])([100, '100.00']), false);
  // 拆分「根据字段值过滤账单」同样支持字段运算
  const compiled = compileBillSplitRowFilter([rule(['A', '包含（字段）', 'B'])], new Map([['A', 0], ['B', 1]]));
  assert.equal(matchesBillSplitRowFilter(['手续费-甲', '甲'], compiled), true);
});

test('字段运算的校验、规范化与引用收集：比较字段必选、按模板表头校验、计入引用字段', () => {
  assert.throws(() => validateRowFilterRules([rule(['A', '等于（字段）'])], null), /过滤规则 #1 第 1 个条件：请选择比较字段/);
  assert.throws(() => validateRowFilterRules([rule(['A', '包含（字段）', 'C'])], ['A', 'B']), /映射字段不存在：C/);
  assert.deepEqual(validateRowFilterRules([rule([' A ', '不包含（字段）', ' B '])], ['A', 'B']), [
    { seq: 1, conditions: [{ field: 'A', op: '不包含（字段）', value: 'B' }] }
  ]);
  assert.throws(() => validateRowFilterRules([], null, { missingMessage: PREPROCESS_ROW_FILTER_MISSING_MESSAGE }), /已勾选「过滤账单」/);
  assert.deepEqual(normalizeRowFilterRules([rule(['A', '等于（字段）', 'B'], ['B', '等于', 'A'])]), [
    { seq: 1, conditions: [{ field: 'A', op: '等于（字段）', value: 'B' }, { field: 'B', op: '等于', value: 'A' }] }
  ]);
  // 普通运算的值不是字段；字段运算的比较字段计入
  assert.deepEqual(collectRowFilterRuleFields([rule(['A', '等于', 'X'], ['B', '包含（字段）', 'C'])]), ['A', 'B', 'C']);
  // 编译：比较字段不在源文件表头时拒绝生成
  assert.throws(() => matcher([rule(['A', '等于（字段）', 'C'])]), /映射字段不存在：C/);
});

const HEADER = ['日期', '类型', '币种', '收入', '支出', '附言', '对手户名'];
const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name'];
const KEEP_REAL = [rule(['类型', '等于', '交易'])];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocess-row-filter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, rows) {
  const filePath = path.join(dir, 'preprocess.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function mapFile(filePath, { preprocessRowFilterRules = KEEP_REAL, billSplitMerge = null, currencyMappings = [] } = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    currencyMappings,
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '收入',
      'Debit Amount': '支出',
      'Payee Name': '对手户名'
    },
    expectedSourceHeaders: HEADER,
    billSplitMerge,
    preprocessRowFilterRules
  });
}

// [Currency, Credit, Debit, Payee Name]
function outputs(mapped) {
  return mapped.slice(1).map((row) => [row[1], row[2], row[3], row[4]]);
}

const SOURCE_ROWS = [
  ['2026-11-01', '交易', 'USD', '100', '', '', '甲'],
  ['2026-11-01', '冻结', 'USD', '', '50', '', '乙'],
  ['2026-11-02', ' 交易 ', 'USD', '', '30', '', '丙'],
  ['2026-11-02', '解冻', 'USD', '50', '', '', '乙']
];

test('预处理：只保留命中规则的源行，行号仍为源文件物理行号，记录读到与保留的行数', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  const mapped = mapFile(filePath);
  assert.deepEqual(outputs(mapped), [['USD', '100', '', '甲'], ['USD', '', '30', '丙']]);
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 4]);
  // 被过滤掉、账单日期可识别的行记为交易行（多账户分段识别账号时用作上一段的界线）；其中带发生额的另记
  //   droppedAmountRowNumbers（v3.2.21：直接匹配窗口只以这些行为界）
  assert.deepEqual(mapped.preprocessRowFilterStats, { enabled: true, totalRows: 4, keptRows: 2, droppedTransactionRowNumbers: [3, 5], droppedAmountRowNumbers: [3, 5] });

  // 未下发规则：全部行照常输出，不带统计
  const unfiltered = mapFile(filePath, { preprocessRowFilterRules: null });
  assert.equal(unfiltered.length, 5);
  assert.equal(unfiltered.preprocessRowFilterStats, undefined);
});

test('预处理：字段运算过滤；提示中的行号为物理行号；全部被过滤时只剩表头且 keptRows 为 0', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '交易', '某币', '100', '', '甲', '甲'],
    ['2026-11-01', '交易', 'USD', '', '50', '退款', '乙'],
    ['2026-11-02', '交易', '某币', '', '30', '丙', '丙']
  ]);
  const mapped = mapFile(filePath, {
    preprocessRowFilterRules: [rule(['附言', '等于（字段）', '对手户名'])],
    currencyMappings: [{ englishCode: 'USD', aliases: ['美元'] }]
  });
  assert.deepEqual(outputs(mapped).map((row) => row.slice(1)), [['100', '', '甲'], ['', '30', '丙']]);
  assert.deepEqual(
    mapped.issues.filter((issue) => issue.type === 'currency-unmapped').map((issue) => issue.rowNumber),
    [2, 4]
  );
  const none = mapFile(filePath, { preprocessRowFilterRules: [rule(['类型', '等于', '不存在'])] });
  assert.equal(none.length, 1);
  assert.deepEqual(none.preprocessRowFilterStats, { enabled: true, totalRows: 3, keptRows: 0, droppedTransactionRowNumbers: [2, 3, 4], droppedAmountRowNumbers: [2, 3, 4] });
  // 账单日期无法识别的被过滤行（如分段之间的「账号：…」说明行）不算交易行
  const preamble = writeXlsx(createTempDir(t), [
    ['2026-11-01', '交易', 'USD', '100', '', '', '甲'],
    ['账号：6222000000000002', '', '', '', '', '', '']
  ]);
  assert.deepEqual(mapFile(preamble).preprocessRowFilterStats.droppedTransactionRowNumbers, []);
});

test('预处理先于「根据字段值过滤账单」：拆分过滤与统计只看保留的行', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '交易', 'USD', '100', '', '拆', '甲'],
    ['2026-11-01', '冻结', 'USD', '', '50', '拆', '乙'],
    ['2026-11-02', '交易', 'USD', '', '30', '', '丙']
  ]);
  const mapped = mapFile(filePath, {
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [{
        seqNo: 1, rowStatus: 'completed', currencySourceField: '币种', creditSourceField: '', debitSourceField: '收入',
        amountSourceField: '', mergedGroupSeq: null, isFeeBill: false
      }],
      billSplitAmountRules: [],
      rowFilterRules: [rule(['附言', '等于', '拆'])]
    }
  });
  // 第 3 行（冻结）先被预处理丢弃，不再进入拆分；第 2 行命中拆分，第 4 行走主映射
  assert.deepEqual(outputs(mapped), [['USD', '', '100', '甲'], ['USD', '', '30', '丙']]);
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 4]);
  assert.deepEqual(mapped.billSplitMatchStats, { enabled: true, totalRows: 1, outputRows: 1 });
});

test('预处理：保留下来的合计行照常识别并跳过，被过滤掉的合计行不记提示', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '交易', 'USD', '100', '', '', '甲'],
    ['合计', '交易', 'USD', '100', '', '', ''],
    ['总计', '汇总', 'USD', '100', '', '', '']
  ]);
  const mapped = mapFile(filePath);
  assert.deepEqual(outputs(mapped), [['USD', '100', '', '甲']]);
  assert.deepEqual(
    mapped.issues.filter((issue) => issue.type === 'summary-row-skipped').map((issue) => issue.rowNumber),
    [3]
  );
});

test('预处理：规则字段不在源文件表头时拒绝生成', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  assert.throws(() => mapFile(filePath, { preprocessRowFilterRules: [rule(['渠道', '等于', 'x'])] }), /映射字段不存在：渠道/);
  assert.throws(
    () => mapFile(filePath, { preprocessRowFilterRules: [rule(['类型', '包含（字段）', '渠道'])] }),
    /映射字段不存在：渠道/
  );
});

test('预处理：BillDate 取特征值时，被过滤行是否为交易行按该行自己的特征值判定', (t) => {
  // 第 2 行保留；第 3 行（冻结，日期可识别）被过滤；第 4 行「账号说明」被过滤；第 5 行保留但无日期无金额（不输出）
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '交易', 'USD', '100', '', '', '甲'],
    ['2026-11-02', '冻结', 'USD', '', '50', '', '乙'],
    ['账号说明', '说明', '', '', '', '', ''],
    ['', '交易', '', '', '', '', '']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: buildFeatureFilterToken('1'), 'Credit Amount': '收入', 'Debit Amount': '支出' },
    featureFilters: { 1: { id: '1', name: '日期', sourceField: '日期', separator: '', length: 10 } },
    expectedSourceHeaders: HEADER,
    preprocessRowFilterRules: KEEP_REAL
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 5]);
  // 不沿用主循环最后一行（第 5 行，特征值为空）的特征值：第 3 行算交易行，第 4 行不算
  assert.deepEqual(mapped.preprocessRowFilterStats.droppedTransactionRowNumbers, [3]);
});
