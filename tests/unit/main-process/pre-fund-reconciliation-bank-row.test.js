'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BANK_ROW_CLASSIFICATION,
  BankRowValidationError,
  canonicalizeDecimal,
  buildStableTraceId,
  classifyBankRow,
  deriveBankRow
} = require('../../../src/main-process/pre-fund-reconciliation/bank-row');

test('十进制 canonicalizer 不用浮点即可稳定处理等价值、科学计数法和超安全整数', () => {
  const equivalents = ['1', '1.0', '01.000', '+1.0000', '10e-1', '0.1e1'];
  for (const value of equivalents) assert.equal(canonicalizeDecimal(value), '1');
  assert.equal(canonicalizeDecimal('9007199254740993.000000000000'), '9007199254740993');
  assert.equal(canonicalizeDecimal('-0.000e+999'), '0');
  assert.equal(canonicalizeDecimal('1.230000e+3'), '1230');
  assert.equal(canonicalizeDecimal('1e-6'), '0.000001');
  assert.equal(canonicalizeDecimal('1,234,567.8900'), '1234567.89');
});

test('十进制 canonicalizer 拒绝非法格式且中文错误包含字段名', () => {
  assert.throws(
    () => canonicalizeDecimal('1,23.00', { label: 'Credit Amount' }),
    (error) => error instanceof BankRowValidationError
      && error.code === 'pre-fund-invalid-decimal'
      && error.message.includes('Credit Amount')
      && error.message.includes('千分位')
  );
  assert.throws(() => canonicalizeDecimal('Infinity'), /有效十进制数/);
});

test('Credit 非零派生 CREDIT、Drawee/name/cardNo、金额绝对值和稳定追溯ID', () => {
  const result = deriveBankRow({
    Channel: ' MPT ',
    Currency: ' USD ',
    'Credit Amount': '-123.4500',
    'Debit Amount': '',
    ReconciliationId: ' RID-1 ',
    Drawee: ' Alice ',
    'Drawee Account': ' CARD-1 ',
    OriginBillId: ''
  }, { fileName: '银行A.xlsx', excelRowNumber: 8 });

  assert.equal(result.classification, BANK_ROW_CLASSIFICATION.PARTICIPATING);
  assert.equal(result.transactionType, 'CREDIT');
  assert.equal(result.name, 'Alice');
  assert.equal(result.cardNo, 'CARD-1');
  assert.equal(result.amount, '123.45');
  assert.equal(result.reconciliationId, 'RID-1');
  assert.equal(result.channel, 'MPT');
  assert.equal(result.currency, 'USD');
  assert.equal(result.originBillId, '银行A.xlsx#8');
});

test('Credit 派生兼容标准46列表头 Drawee Name/Drawee CardNo', () => {
  const result = deriveBankRow({
    'Credit Amount': '5',
    'Debit Amount': 0,
    ReconciliationId: 'R',
    'Drawee Name': '标准户名',
    'Drawee CardNo': '标准卡号'
  }, { fileName: 'b.xlsx', excelRowNumber: 2 });
  assert.equal(result.name, '标准户名');
  assert.equal(result.cardNo, '标准卡号');
});

test('Debit 非零派生 DEBIT、Payee/name/cardNo，已有 OriginBillId 原样优先', () => {
  const result = deriveBankRow({
    'Credit Amount': '0',
    'Debit Amount': '88.00',
    ReconciliationId: 'R2',
    Payee: 'Bob',
    'Payee Account': 'P-1',
    OriginBillId: 'ORIGIN-9'
  }, { fileName: 'b.xlsx', excelRowNumber: 9 });
  assert.equal(result.transactionType, 'DEBIT');
  assert.equal(result.name, 'Bob');
  assert.equal(result.cardNo, 'P-1');
  assert.equal(result.amount, '88');
  assert.equal(result.originBillId, 'ORIGIN-9');
});

test('双零/空、空 reconId、双非零四类互斥分类', () => {
  const zero = classifyBankRow({ 'Credit Amount': '', 'Debit Amount': 0 }, {
    fileName: 'x.xlsx', excelRowNumber: 2
  });
  assert.equal(zero.classification, BANK_ROW_CLASSIFICATION.ZERO_AMOUNT);

  const emptyId = classifyBankRow({
    'Credit Amount': 1,
    'Debit Amount': '',
    ReconciliationId: '   '
  }, { fileName: 'x.xlsx', excelRowNumber: 3 });
  assert.equal(emptyId.classification, BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID);

  const invalid = classifyBankRow({
    'Credit Amount': '0.01',
    'Debit Amount': '-0.02',
    ReconciliationId: 'R'
  }, { fileName: 'x.xlsx', excelRowNumber: 4 });
  assert.equal(invalid.classification, BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO);
});

test('双非零整次失败错误包含文件名、Excel行号和两个原始金额', () => {
  assert.throws(
    () => deriveBankRow({
      'Credit Amount': '1.10',
      'Debit Amount': '2.20',
      ReconciliationId: 'R'
    }, { fileName: '定位.xlsx', excelRowNumber: 27 }),
    (error) => error instanceof BankRowValidationError
      && error.code === 'pre-fund-bank-both-amounts-nonzero'
      && error.message.includes('定位.xlsx')
      && error.message.includes('Excel第27行')
      && error.message.includes('Credit Amount=1.10')
      && error.message.includes('Debit Amount=2.20')
  );
});

test('非法单边金额也携带文件和行定位', () => {
  assert.throws(
    () => classifyBankRow({
      'Credit Amount': 'USD 1',
      'Debit Amount': ''
    }, { fileName: '坏金额.xlsx', excelRowNumber: 6 }),
    (error) => error instanceof BankRowValidationError
      && error.message.includes('坏金额.xlsx')
      && error.message.includes('Excel第6行')
  );
});

test('稳定追溯ID在同文件同行确定、跨行唯一', () => {
  assert.equal(buildStableTraceId('a.xlsx', 5), 'a.xlsx#5');
  assert.equal(buildStableTraceId('a.xlsx', 5), 'a.xlsx#5');
  assert.notEqual(buildStableTraceId('a.xlsx', 5), buildStableTraceId('a.xlsx', 6));
});
