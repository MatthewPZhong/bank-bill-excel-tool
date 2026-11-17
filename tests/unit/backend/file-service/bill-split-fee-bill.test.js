'use strict';

// v3.2.19 拆分/合并账单「费用账单」生成口径（spec §3.5、§3.6）：
//   - 费用账单行 Credit 恒为空；勾选特殊取值时 Debit = 公式结果，优先于副区域规则与行级 Debit 映射；
//   - 其他拆分行不受影响；结果为 0 的拆分行不输出；费用账单行参与合并组净额；
//   - 非 0 ÷ 0 整份报错并列出源行号；公式字段不在源文件表头时报错。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { buildMappedRows } = require('../../../../src/backend/file-service');

const HEADER = ['日期', '币种', '交易金额', '手续费', '邮电费', '方向金额'];
const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name', 'Drawee Name'];
const FEE_FORMULA = [{ field: '手续费', op: '+' }, { field: '邮电费', op: 'end' }];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-split-fee-bill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, rows, header = HEADER) {
  const filePath = path.join(dir, 'split.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Sheet1');
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

function mapFile(filePath, billSplit = {}, { header = HEADER } = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: header,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: [],
      feeAmountFormula: null,
      ...billSplit
    }
  });
}

// [Currency, Credit, Debit]
function amounts(mapped) {
  return mapped.slice(1).map((row) => [row[1], row[2], row[3]]);
}

test('费用账单行 Debit 取公式结果、Credit 为空；交易行照常按行级映射输出', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '100', '1.5', '0.25', ''],
    ['2026-11-02', 'USD', '50', '-2', '-1', '']
  ]);
  const mapped = mapFile(filePath, {
    billSplitRows: [
      splitRow(1, { creditSourceField: '交易金额' }),
      // 费用账单行即使残留了 Credit / Debit 映射也不使用
      splitRow(2, { isFeeBill: true, creditSourceField: '交易金额', debitSourceField: '交易金额' })
    ],
    feeAmountFormula: FEE_FORMULA
  });
  assert.deepEqual(amounts(mapped), [
    ['USD', '100', ''],
    ['USD', '', '1.75'],
    ['USD', '50', ''],
    ['USD', '', '3']
  ]);
});

test('未下发公式（未勾选特殊取值）时费用账单行 Debit 走原逻辑，Credit 仍为空', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '0.25', '']]);
  const mapped = mapFile(filePath, {
    billSplitRows: [
      splitRow(1, { creditSourceField: '交易金额' }),
      splitRow(2, { isFeeBill: true, creditSourceField: '交易金额', debitSourceField: '手续费' })
    ]
  });
  assert.deepEqual(amounts(mapped), [['USD', '100', ''], ['USD', '', '1.5']]);
});

test('副区域「按正负号取发生额」作用于全部行时，费用账单行仍取公式；未勾选特殊取值时其收入被丢弃', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '', '1', '2', '80'],
    ['2026-11-02', 'USD', '', '0', '0', '-30']
  ]);
  const billSplit = {
    billSplitRows: [splitRow(1), splitRow(2, { isFeeBill: true })],
    signedAmountSourceField: '方向金额'
  };
  assert.deepEqual(amounts(mapFile(filePath, { ...billSplit, feeAmountFormula: FEE_FORMULA })), [
    ['USD', '80', ''],
    ['USD', '', '3'],
    ['USD', '', '30']
  ]);
  // 不取公式：费用账单行按正负号得到的收入（80）不输出，支出（30）照常
  assert.deepEqual(amounts(mapFile(filePath, billSplit)), [
    ['USD', '80', ''],
    ['USD', '', '30'],
    ['USD', '', '30']
  ]);
});

test('费用账单行参与合并组：净额 = 收入 − 公式结果', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '0.25', '']]);
  const mapped = mapFile(filePath, {
    billSplitRows: [
      splitRow(1, { creditSourceField: '交易金额', mergedGroupSeq: 1 }),
      splitRow(2, { isFeeBill: true, mergedGroupSeq: 1 })
    ],
    feeAmountFormula: FEE_FORMULA
  });
  assert.deepEqual(amounts(mapped), [['USD', '98.25', '']]);
});

test('非 0 ÷ 0 整份报错并列出源行号；0 ÷ 0 的行按 0 不输出', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '100', '6', '3', ''],
    ['2026-11-02', 'USD', '100', '6', '0', ''],
    ['2026-11-03', 'USD', '100', '0', '', ''],
    ['2026-11-04', 'USD', '100', '9', '', '']
  ]);
  const billSplit = {
    billSplitRows: [splitRow(1, { creditSourceField: '交易金额' }), splitRow(2, { isFeeBill: true })],
    feeAmountFormula: [{ field: '手续费', op: '/' }, { field: '邮电费', op: 'end' }]
  };
  assert.throws(() => mapFile(filePath, billSplit), (error) => {
    assert.equal(error.code, 'BILL_SPLIT_FEE_FORMULA_DIVIDE_BY_ZERO');
    assert.match(error.message, /除数为 0/);
    assert.match(error.message, /第 3、5 行/);
    return true;
  });

  const okPath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '100', '6', '3', ''],
    ['2026-11-03', 'USD', '100', '0', '', '']
  ]);
  assert.deepEqual(amounts(mapFile(okPath, billSplit)), [
    ['USD', '100', ''],
    ['USD', '', '2'],
    ['USD', '100', '']
  ]);
});

test('账单自带的合计行公式除零时按合计行跳过，不计入除零报错', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '', '6', '3', ''],
    ['合计', 'USD', '', '6', '', '']
  ]);
  const mapped = mapFile(filePath, {
    billSplitRows: [splitRow(1, { isFeeBill: true })],
    feeAmountFormula: [{ field: '手续费', op: '/' }, { field: '邮电费', op: 'end' }]
  });
  assert.deepEqual(amounts(mapped), [['USD', '', '2']]);
  assert.deepEqual(
    (mapped.issues || []).filter((issue) => issue.type === 'summary-row-skipped').map((issue) => issue.rowNumber),
    [3]
  );
});

test('费用账单行保留的旧 Credit / 被公式取代的旧 Debit 映射不要求列仍在源文件中', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '手续费', '邮电费'];
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '1', '2']], header);
  const feeRow = splitRow(1, { isFeeBill: true, creditSourceField: '已删除收入列', debitSourceField: '已删除支出列' });
  assert.deepEqual(amounts(mapFile(filePath, { billSplitRows: [feeRow], feeAmountFormula: FEE_FORMULA }, { header })), [['USD', '', '3']]);
  // 未启用公式时费用行仍读 Debit 映射，列缺失照常拒绝
  assert.throws(() => mapFile(filePath, { billSplitRows: [feeRow] }, { header }), /映射字段不存在：已删除支出列/);
});

test('公式字段不在源文件表头时拒绝', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '交易金额', '手续费'];
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1']], header);
  assert.throws(
    () => mapFile(filePath, {
      billSplitRows: [splitRow(1, { isFeeBill: true })],
      feeAmountFormula: FEE_FORMULA
    }, { header }),
    /映射字段不存在：邮电费/
  );
});
