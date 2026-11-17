'use strict';

// v3.2.19 拆分/合并账单「根据字段值过滤账单」：
//   - 规则口径：组内条件全部满足、任一组满足即命中；单元格去首尾空白后按文本比较，区分大小写；
//   - 生成：命中的源行走拆分/合并映射，未命中的走主映射，按源行顺序合并输出；统计只计各自路径的行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  compileBillSplitRowFilter,
  matchesBillSplitRowFilter,
  normalizeBillSplitRowFilterRules,
  validateBillSplitRowFilterRules
} = require('../../../../src/backend/file-service/bill-split-row-filter');
const { buildMappedRows } = require('../../../../src/backend/file-service');

const HEADER = ['日期', '类型', '币种', '收入', '支出', '交易金额', '手续费', '附言'];
const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name'];
const SPLIT_BY_TYPE = [{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '拆分' }] }];

function rule(...conditions) {
  return { conditions: conditions.map(([field, op, value = '']) => ({ field, op, value })) };
}

function matcher(rules, header = ['A', 'B']) {
  const compiled = compileBillSplitRowFilter(rules, new Map(header.map((field, index) => [field, index])));
  return (row) => matchesBillSplitRowFilter(row, compiled);
}

test('规范化：忽略字段与值都为空的条件和空规则，值去首尾空白，空值/非空值清掉值，seq 重排', () => {
  assert.deepEqual(normalizeBillSplitRowFilterRules([
    rule(['', '等于', '']),
    rule([' A ', '等于', '  x  '], ['', '包含', ''], ['B', '空值', '残留']),
    null,
    { conditions: 'bad' }
  ]), [
    { seq: 1, conditions: [{ field: 'A', op: '等于', value: 'x' }, { field: 'B', op: '空值', value: '' }] }
  ]);
  assert.deepEqual(normalizeBillSplitRowFilterRules(JSON.stringify([rule(['A', '包含', '1'])])), [
    { seq: 1, conditions: [{ field: 'A', op: '包含', value: '1' }] }
  ]);
  assert.deepEqual(normalizeBillSplitRowFilterRules('not json'), []);
  assert.deepEqual(normalizeBillSplitRowFilterRules(''), []);
});

test('校验：至少一条规则；字段、运算符、需要值的运算符的值都必填；按模板表头校验字段', () => {
  assert.throws(() => validateBillSplitRowFilterRules([], null), /至少设置一条过滤规则/);
  assert.throws(() => validateBillSplitRowFilterRules([rule(['', '等于', 'x'])], null), /过滤规则 #1 第 1 个条件：请选择字段/);
  assert.throws(() => validateBillSplitRowFilterRules([rule(['A', '大于', '1'])], null), /运算符无效/);
  assert.throws(() => validateBillSplitRowFilterRules([rule(['A', '等于'])], null), /请填写值/);
  assert.throws(() => validateBillSplitRowFilterRules([rule(['C', '非空值'])], ['A', 'B']), /映射字段不存在：C/);
  assert.deepEqual(validateBillSplitRowFilterRules([rule(['A', '非空值'])], ['A']), [
    { seq: 1, conditions: [{ field: 'A', op: '非空值', value: '' }] }
  ]);
});

test('运算符：按去首尾空白后的文本比较，区分大小写，不做数值换算', () => {
  const cases = [
    ['等于', 'abc', [' abc ', true], ['ABC', false], ['abcd', false]],
    ['不等于', 'abc', ['abc', false], ['ABC', true], ['', true]],
    ['包含', 'b', ['abc', true], ['ABC', false], ['', false]],
    ['不包含', 'b', ['abc', false], ['xyz', true], ['', true]],
    ['开头为', 'ab', [' abc', true], ['cab', false]],
    ['空值', '', ['', true], ['   ', true], [null, true], ['0', false]],
    ['非空值', '', ['0', true], [' ', false], [undefined, false]]
  ];
  cases.forEach(([op, value, ...samples]) => {
    const match = matcher([rule(['A', op, value])]);
    samples.forEach(([cell, expected]) => {
      assert.equal(match([cell]), expected, `${op} ${value} ← ${JSON.stringify(cell)}`);
    });
  });
  const numeric = matcher([rule(['A', '等于', '100.00'])]);
  assert.equal(numeric([100]), false);
  assert.equal(numeric(['100.00']), true);
});

test('组内条件全部满足、任一组满足即命中', () => {
  const match = matcher([
    rule(['A', '等于', '拆分'], ['B', '非空值']),
    rule(['A', '开头为', '手续费'])
  ]);
  assert.equal(match(['拆分', 'x']), true);
  assert.equal(match(['拆分', '']), false);
  assert.equal(match(['手续费-邮电', '']), true);
  assert.equal(match(['其他', 'x']), false);
});

test('编译：条件字段不在源文件表头时拒绝生成', () => {
  assert.throws(() => matcher([rule(['C', '等于', '1'])]), /映射字段不存在：C/);
});

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-split-row-filter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, rows) {
  const filePath = path.join(dir, 'filter.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function splitRow(seqNo, overrides = {}) {
  return {
    seqNo,
    rowStatus: 'completed',
    currencySourceField: '币种',
    creditSourceField: '',
    debitSourceField: '',
    amountSourceField: '',
    mergedGroupSeq: null,
    isFeeBill: false,
    ...overrides
  };
}

function mapFile(filePath, { mappingByField = {}, billSplit = {}, featureFilters = {}, currencyMappings = [] } = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    currencyMappings,
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '收入',
      'Debit Amount': '支出',
      ...mappingByField
    },
    expectedSourceHeaders: HEADER,
    featureFilters,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [
        splitRow(1, { creditSourceField: '交易金额' }),
        splitRow(2, { debitSourceField: '手续费' })
      ],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: [],
      feeAmountFormula: null,
      rowFilterRules: SPLIT_BY_TYPE,
      ...billSplit
    }
  });
}

// [Currency, Credit, Debit, Payee Name]
function outputs(mapped) {
  return mapped.slice(1).map((row) => [row[1], row[2], row[3], row[4]]);
}

const SOURCE_ROWS = [
  ['2026-11-01', '普通', 'USD', '100', '', '', '', '甲'],
  ['2026-11-02', '拆分', 'USD', '', '', '200', '5', '乙'],
  ['2026-11-03', ' 普通 ', 'HKD', '', '30', '999', '9', '丙']
];

test('命中过滤规则的行走拆分、未命中的走主映射，按源行顺序合并输出', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  const mapped = mapFile(filePath, { mappingByField: { 'Payee Name': '附言' } });
  assert.deepEqual(outputs(mapped), [
    ['USD', '100', '', '甲'],
    ['USD', '200', '', '乙'],
    ['USD', '', '5', '乙'],
    ['HKD', '', '30', '丙']
  ]);
  assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 3, 3, 4]);
  assert.deepEqual(mapped.billSplitMatchStats, { enabled: true, totalRows: 1, outputRows: 2 });
});

test('未下发过滤规则时全部源行走拆分（原行为）', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  const mapped = mapFile(filePath, { billSplit: { rowFilterRules: null } });
  assert.deepEqual(outputs(mapped), [
    ['USD', '200', '', ''],
    ['USD', '', '5', ''],
    ['HKD', '999', '', ''],
    ['HKD', '', '9', '']
  ]);
  assert.deepEqual(mapped.billSplitMatchStats, { enabled: true, totalRows: 3, outputRows: 4 });
});

test('不复用模块映射时命中行用拆分映射、未命中行用主映射', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  const mapped = mapFile(filePath, {
    mappingByField: { 'Payee Name': '附言' },
    billSplit: {
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', 'Payee Name': '类型' }
    }
  });
  assert.deepEqual(outputs(mapped).map((row) => row[3]), ['甲', '拆分', '拆分', '丙']);
});

test('不复用时主映射所选特征值对未命中的行生效', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '普通', 'USD', '100', '', '', '', '12345'],
    ['2026-11-02', '拆分', 'USD', '', '', '200', '', 'abc']
  ]);
  const mapped = mapFile(filePath, {
    mappingByField: { 'Payee Name': '__FEATURE_FILTER__:f1' },
    featureFilters: { f1: { id: 'f1', name: '单号', sourceField: '附言', separator: '', digitsOnly: true } },
    billSplit: {
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', 'Payee Name': '类型' }
    }
  });
  assert.deepEqual(outputs(mapped).map((row) => row[3]), ['12345', '拆分']);
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'feature-value-unmatched'), []);
});

test('命中行的币种只取拆分行配置：单元格为空时不回落到主映射币种，也不记主映射的币种提示', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '普通', 'USD', '100', '', '', '', 'EUR'],
    ['2026-11-02', '拆分', '', '', '', '200', '', '某币']
  ]);
  const mapped = mapFile(filePath, { mappingByField: { Currency: '附言' } });
  assert.deepEqual(outputs(mapped).map((row) => row.slice(0, 3)), [['EUR', '100', ''], ['', '200', '']]);
  assert.deepEqual(mapped.issues.filter((issue) => issue.rowNumber === 3), []);
});

test('开启过滤时命中行的拆分币种按币种映射表规范化，与主映射行同一口径；无法识别时保留原值并记提示', (t) => {
  const currencyMappings = [
    { englishCode: 'CNY', aliases: ['人民币'] },
    { englishCode: 'HKD', aliases: ['港币'] }
  ];
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '普通', '人民币', '100', '', '', '', ''],
    ['2026-11-02', '拆分', '人民币', '', '', '200', '5', ''],
    ['2026-11-03', '拆分', '某币', '', '', '300', '', ''],
    ['2026-11-04', '拆分', 'usd', '', '', '400', '', '']
  ]);
  const mapped = mapFile(filePath, { currencyMappings });
  assert.deepEqual(outputs(mapped).map((row) => row.slice(0, 3)), [
    ['CNY', '100', ''],
    ['CNY', '200', ''],
    ['CNY', '', '5'],
    ['某币', '300', ''],
    ['usd', '400', '']
  ]);
  // 同一源行两份拆分共用币种列，只记一次；未输出的拆分行（第 4、5 行手续费为空）不记
  assert.deepEqual(
    mapped.issues.filter((issue) => issue.type === 'currency-unmapped').map((issue) => [issue.rowNumber, issue.rawValue, issue.sourceField]),
    [[4, '某币', '币种']]
  );

  // 未开启过滤的拆分模板保持取原值（此时界面清空主映射 Currency）
  const unfiltered = mapFile(filePath, { currencyMappings, mappingByField: { Currency: '' }, billSplit: { rowFilterRules: null } });
  assert.deepEqual(outputs(unfiltered).map((row) => row[0]), ['人民币', '人民币', '某币', 'usd']);
  assert.deepEqual(unfiltered.issues.filter((issue) => issue.type === 'currency-unmapped'), []);
});

test('主映射按字段区分发生额的命中统计只计走主映射的行', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: HEADER,
    amountSplitByField: {
      enabled: true,
      rules: [
        { targetField: 'Credit Amount', conditionField: '币种', conditionValue: 'USD', mappedField: '交易金额' },
        { targetField: 'Debit Amount', conditionField: '币种', conditionValue: 'HKD', mappedField: '手续费' }
      ]
    },
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [splitRow(1, { creditSourceField: '交易金额' })],
      billSplitAmountRules: [],
      rowFilterRules: SPLIT_BY_TYPE
    }
  });
  // 第 2 行命中过滤走拆分（主映射规则也会命中 USD，但不计入）；第 1、3 行走主映射，第 1 行交易金额为空不计
  assert.deepEqual(mapped.amountSplitMatchStats, { enabled: true, totalRows: 2, hitCredit: 0, hitDebit: 1 });
  assert.deepEqual(outputs(mapped).map((row) => row.slice(0, 3)), [['USD', '', ''], ['USD', '200', ''], ['HKD', '', '9']]);
});

test('两条路径各自识别合计行：不进明细并记入 issues', (t) => {
  const filePath = writeXlsx(createTempDir(t), [
    ['2026-11-01', '普通', 'USD', '100', '', '', '', ''],
    ['合计', '普通', 'USD', '100', '', '', '', ''],
    ['合计', '拆分', 'USD', '', '', '200', '5', '']
  ]);
  const mapped = mapFile(filePath);
  assert.deepEqual(outputs(mapped), [['USD', '100', '', '']]);
  assert.deepEqual(
    mapped.issues.filter((issue) => issue.type === 'summary-row-skipped').map((issue) => issue.rowNumber),
    [3, 4]
  );
});

test('过滤规则字段不在源文件表头时拒绝生成', (t) => {
  const filePath = writeXlsx(createTempDir(t), SOURCE_ROWS);
  assert.throws(
    () => mapFile(filePath, { billSplit: { rowFilterRules: [rule(['渠道', '等于', 'x'])] } }),
    /映射字段不存在：渠道/
  );
});
