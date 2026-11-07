'use strict';

// v3.2.15 网银账单深审修复：余额保号（F01）、无效账单日期整份拒绝（F03）、
// 账单里的余额附加值逐日生效（F05）、直接映射余额保留原精度（F07）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { buildMappedRows, FileValidationError } = require('../../../src/backend/file-service');
const { inferEndingBalance } = require('../../../src/backend/file-service/normalizers');
const { deriveBalanceRecords } = require('../../../src/main-process/statement-generation-business');

const SOURCE_HEADER = ['日期', '账号', '收入', '支出', '余额'];
const MAPPING = {
  BillDate: '日期',
  MerchantId: '账号',
  Currency: '__FIXED__:USD',
  'Credit Amount': '收入',
  'Debit Amount': '支出',
  Balance: '余额'
};
const ORDERED_FIELDS = Object.keys(MAPPING);
const DETAIL_HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
const BALANCE_FIELDS = ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-balance-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, fileName, rows) {
  const filePath = path.join(dir, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SOURCE_HEADER, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function writeCsv(dir, fileName, rows) {
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, [SOURCE_HEADER, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n'));
  return filePath;
}

function mapFile(filePath) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: MAPPING,
    expectedSourceHeaders: SOURCE_HEADER
  });
}

function balanceColumn(rows) {
  const index = rows[0].indexOf('Balance');
  return rows.slice(1).map((row) => row[index]);
}

function derive(rows, { mode = 'statement', balanceAdjustments = [], seeds = [] } = {}) {
  return deriveBalanceRecords({
    detailRows: [DETAIL_HEADER.slice(), ...rows.map((row) => row.slice())],
    templateName: '中行-上海',
    balanceTemplateFields: BALANCE_FIELDS,
    mode,
    balanceAdjustments,
    resolvePreviousBalanceSeed: ({ merchantId, currency, targetBillDate }) => seeds
      .filter((seed) => seed.merchantId === merchantId && seed.currency === currency && seed.billDate < targetBillDate)
      .sort((left, right) => left.billDate.localeCompare(right.billDate))
      .pop() || null
  });
}

function endBalances(result) {
  return result.records.map((row) => [row[4], row[7]]);
}

const adjustment = (effectiveDate, adjustmentValue) => ({ merchantId: 'M1', currency: 'USD', effectiveDate, adjustmentValue });

test('F01 映射余额保留负号：CSV、文本 XLSX、数值 XLSX 均不翻正', (t) => {
  const dir = createTempDir(t);
  const textRows = [['2026-11-01', 'M1', '', '1', '-100.25'], ['2026-11-02', 'M1', '200', '', '99.75'], ['2026-11-03', 'M1', '', '1,200', '-1,100.25']];
  const numericRows = [['2026-11-01', 'M1', '', 1, -100.25], ['2026-11-02', 'M1', 200, '', 99.75], ['2026-11-03', 'M1', '', 1200, -1100.25]];
  const expected = ['-100.25', '99.75', '-1100.25'];

  assert.deepEqual(balanceColumn(mapFile(writeCsv(dir, 'negative.csv', textRows))), expected, 'CSV');
  assert.deepEqual(balanceColumn(mapFile(writeXlsx(dir, 'negative-text.xlsx', textRows))), expected, '文本 XLSX');
  assert.deepEqual(balanceColumn(mapFile(writeXlsx(dir, 'negative-number.xlsx', numericRows))), expected, '数值 XLSX');

  // 收支金额的方向口径不变：仍按绝对值清洗。
  const debitIndex = ORDERED_FIELDS.indexOf('Debit Amount');
  assert.equal(mapFile(writeXlsx(dir, 'negative-number-debit.xlsx', numericRows))[3][debitIndex], '1200');
});

test('F03 有金额的行账单日期有值但不是有效日期时整份拒绝，列出行号与原值', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'invalid-date.xlsx', [
    ['2026-11-01', 'M1', '1', '', '1001'],
    ['2026-11-31', 'M1', '200', '', '1201'],
    ['2026-02-30', 'M1', '', '5', '1196']
  ]);
  assert.throws(() => mapFile(filePath), (error) => {
    assert.ok(error instanceof FileValidationError);
    assert.equal(error.code, 'FILE_READ');
    assert.equal(error.message, '账单日期存在无效值：第 3 行「2026-11-31」等 2 行，请修正后重新导入');
    assert.deepEqual(error.detailLines, ['第 3 行：2026-11-31', '第 4 行：2026-02-30']);
    return true;
  });
});

test('F03 不拦截：无金额的合计行、账单日期为空的行、无效起息日', (t) => {
  const dir = createTempDir(t);
  const footer = mapFile(writeXlsx(dir, 'footer.xlsx', [
    ['2026-11-01', 'M1', '1', '', '1001'],
    ['合计', '', '', '', '']
  ]));
  assert.equal(footer.length, 3);

  const blankDate = mapFile(writeXlsx(dir, 'blank-date.xlsx', [
    ['2026-11-01', 'M1', '1', '', '1001'],
    ['', 'M1', '2', '', '1003']
  ]));
  assert.equal(blankDate[2][ORDERED_FIELDS.indexOf('BillDate')], '');

  const valueDateRows = buildMappedRows({
    inputFilePath: writeXlsx(dir, 'value-date.xlsx', [['2026-11-31', 'M1', '1', '', '1001']]),
    orderedTargetFields: ['BillDate', 'ValueDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '__FIXED__:2026-11-01', ValueDate: '日期', MerchantId: '账号', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: SOURCE_HEADER
  });
  assert.deepEqual(valueDateRows[1].slice(0, 2), ['2026-11-01', '']);
});

test('F05 账单里的余额：附加值从生效日起每天叠加，后续生效日累加', () => {
  const rows = [
    ['2026-09-01', 'M1', 'USD', '1', '', '1000'],
    ['2026-09-02', 'M1', 'USD', '1', '', '1001'],
    ['2026-09-03', 'M1', 'USD', '1', '', '1002']
  ];
  assert.deepEqual(endBalances(derive(rows, { balanceAdjustments: [adjustment('2026-09-01', 10)] })), [
    ['2026-09-01', 1010], ['2026-09-02', 1011], ['2026-09-03', 1012]
  ]);
  assert.deepEqual(endBalances(derive(rows, {
    balanceAdjustments: [adjustment('2026-09-01', 10), adjustment('2026-09-03', -3.5)]
  })), [['2026-09-01', 1010], ['2026-09-02', 1011], ['2026-09-03', 1008.5]]);
});

test('F05 账单里的余额：同日多候选按账单原值推导，不受附加值干扰；一次与分次导入结果一致', () => {
  const adjustments = [adjustment('2026-09-01', 10)];
  const rows = [
    ['2026-09-01', 'M1', 'USD', '1', '', '1000'],
    ['2026-09-02', 'M1', 'USD', '5', '', '1005'],
    ['2026-09-02', 'M1', 'USD', '', '2', '1003']
  ];
  const once = derive(rows, { balanceAdjustments: adjustments });
  assert.deepEqual(endBalances(once), [['2026-09-01', 1010], ['2026-09-02', 1013]]);
  assert.deepEqual(once.seedRecords.map((record) => record.endBalance), [1010, 1013]);

  const firstImport = derive([rows[0]], { balanceAdjustments: adjustments });
  const secondImport = derive([['2026-09-02', 'M1', 'USD', '1', '', '1001']], { balanceAdjustments: adjustments });
  assert.deepEqual([...endBalances(firstImport), ...endBalances(secondImport)], [['2026-09-01', 1010], ['2026-09-02', 1011]]);
});

test('F07 直接映射余额保留原精度；多候选时返回选中候选的原值', () => {
  assert.deepEqual(endBalances(derive([['2026-09-01', 'M1', 'USD', '1', '', '1000.123456']])), [['2026-09-01', 1000.123456]]);
  assert.equal(inferEndingBalance({
    previousEndBalance: 1000.123456,
    dateLabel: '2026-09-02',
    entries: [
      { balanceValue: 1005.123456, creditAmount: 5, debitAmount: 0 },
      { balanceValue: 1003.123456, creditAmount: 0, debitAmount: 2 }
    ]
  }), 1003.123456);
  // 两位小数以内相同的候选仍视为同一余额（比较容差不变）。
  assert.equal(inferEndingBalance({
    previousEndBalance: null,
    dateLabel: '2026-09-01',
    entries: [{ balanceValue: 1000.121, creditAmount: 0, debitAmount: 0 }, { balanceValue: 1000.124, creditAmount: 0, debitAmount: 0 }]
  }), 1000.121);
  assert.deepEqual(endBalances(derive([['2026-09-01', 'M1', 'USD', '1', '', '1000.123456']], {
    balanceAdjustments: [adjustment('2026-09-01', 10)]
  })), [['2026-09-01', 1010.123456]]);
});

test('发生额计算叠加附加值不再截成两位小数', () => {
  const result = derive([
    ['2026-09-01', 'M1', 'USD', '1.0001', '', '']
  ], {
    mode: 'calculated',
    balanceAdjustments: [adjustment('2026-09-01', 10)],
    seeds: [{ merchantId: 'M1', currency: 'USD', billDate: '2026-08-31', endBalance: 1000 }]
  });
  assert.deepEqual(endBalances(result), [['2026-09-01', 1011.0001]]);
});

test('F05 账单里的余额：首日多候选按种子推导时，生成的种子先扣回附加值，人工录入种子按原值', () => {
  const adjustments = [adjustment('2026-09-01', 10)];
  // 09-02 两条候选：1005（+5）与 1003（+5-2）；账单原值链上一日为 1000。
  const rows = [
    ['2026-09-02', 'M1', 'USD', '5', '', '1005'],
    ['2026-09-02', 'M1', 'USD', '', '2', '1003']
  ];
  const seedOf = (generationMethod, endBalance) => [{ merchantId: 'M1', currency: 'USD', billDate: '2026-09-01', endBalance, generationMethod }];

  assert.deepEqual(endBalances(derive(rows, { balanceAdjustments: adjustments, seeds: seedOf('账单里的余额', 1010) })), [['2026-09-02', 1013]]);
  assert.deepEqual(endBalances(derive(rows, { balanceAdjustments: adjustments, seeds: seedOf('通过发生额计算', 1010) })), [['2026-09-02', 1013]]);
  assert.deepEqual(endBalances(derive(rows, { balanceAdjustments: adjustments, seeds: seedOf('人工录入', 1000) })), [['2026-09-02', 1013]]);
});
