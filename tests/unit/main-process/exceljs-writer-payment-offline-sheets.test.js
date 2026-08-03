// v3.1.7 Payment 核对 3 sheet：匹配对照 / 银行行-原始 / 调拨对账单行-原始。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { writeBankStatementOutput } = require('../../../src/main-process/exceljs-writer');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { FT_RECON_FIELD_MAP } = require('../../../src/constants/fund-transfer-recon-fields');

const MATCH_SHEET = '匹配对照';
const BANK_RAW_SHEET = '银行行-原始';
const RECON_RAW_SHEET = '调拨对账单行-原始';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pob-sheets-'));
  return path.join(dir, name);
}

function bankRow(o = {}) {
  return {
    _rowId: o._rowId ?? 'row_0',
    _modifiedColumns: new Set(['ReconciliationId']),
    BillDate: o.BillDate ?? '2026-05-26',
    'Credit Amount': o['Credit Amount'] ?? 4500000,
    Currency: o.Currency ?? 'EUR',
    ReconciliationId: o.ReconciliationId ?? 'NEW-RECON',
    MerchantId: o.MerchantId ?? '202782001',
    FundType: 'FundTransfer-in',
    地区: 'LU',
    'Drawee CardNo': o['Drawee CardNo'] ?? 'LU790030440265731700'
  };
}

function reconRow(o = {}) {
  return {
    调拨单号: o.调拨单号 ?? 'FTA202606021000477',
    BillDate: o.BillDate ?? '2026-05-26',
    ReconID: o.ReconID ?? 'NEW-RECON',
    付款方式: '线下',
    付款账号: o.付款账号 ?? 'LU790030440265731700',
    收款账号: '202782001',
    付款渠道: '',
    收款渠道: 'CITI',
    金额: o.金额 ?? 4500000,
    币种: o.币种 ?? 'EUR',
    fund_type: 'FundTransfer-in',
    big_account: o.big_account ?? '202782001',
    是否被使用: o.是否被使用 ?? '1'
  };
}

function makePair(o = {}) {
  const current = bankRow(o.bank);
  const original = bankRow({ ...o.bank, ReconciliationId: o.oldReconciliationId ?? 'OLD-RECON' });
  return {
    bankRow: current,
    bankRowOriginal: original,
    reconRow: reconRow(o.recon),
    round: o.round ?? 'main',
    oldReconciliationId: o.oldReconciliationId ?? 'OLD-RECON',
    dayDiff: o.dayDiff ?? 0,
    intervalStart: o.intervalStart === undefined ? new Date(2026, 4, 25) : o.intervalStart,
    intervalEndExclusive: o.intervalEndExclusive === undefined ? new Date(2026, 5, 1) : o.intervalEndExclusive
  };
}

const HEADERS = ['MerchantId', 'FundType', 'ReconciliationId'];

async function readOutput(name, pairs) {
  const out = tmpFile(name);
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(out);
  return workbook;
}

test('pairs 非空时追加 3 张 Payment 核对 sheet', async () => {
  const workbook = await readOutput('three-sheets.xlsx', [makePair()]);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.ok(names.includes(MATCH_SHEET));
  assert.ok(names.includes(BANK_RAW_SHEET));
  assert.ok(names.includes(RECON_RAW_SHEET));
  assert.ok(!names.includes('订单行-原始'));
});

test('匹配对照展示 R1/R2/R3、付款账号与 Drawee CardNo、动态周区间', async () => {
  const workbook = await readOutput('match.xlsx', [
    makePair({ round: 'main', oldReconciliationId: 'OLD-A' }),
    makePair({ bank: { _rowId: 'row_1' }, round: 'date-tolerance', dayDiff: -1 }),
    makePair({
      bank: { _rowId: 'row_2' },
      round: 'relaxed-week',
      dayDiff: 5,
      intervalStart: null,
      intervalEndExclusive: null
    })
  ]);
  const sheet = workbook.getWorksheet(MATCH_SHEET);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    '配对序号', '匹配轮次', 'BillDate', 'Credit Amount', 'Currency', 'MerchantId',
    'Drawee CardNo', '原ReconciliationId', '回填值(ReconID)', '调拨单号', '交易时间',
    '金额', '币种', '付款账号', '收款渠道', 'big_account', '银行周', '订单周', '周区间', '天数差'
  ]);
  assert.equal(sheet.rowCount, 4);
  const r1 = sheet.getRow(2).values.slice(1);
  assert.equal(r1[1], 'R1');
  assert.equal(r1[6], r1[13], 'Drawee CardNo 与付款账号并排且相等');
  assert.equal(r1[7], 'OLD-A');
  assert.equal(r1[18], '[2026-05-25, 2026-06-01)');
  assert.equal(sheet.getRow(3).values.slice(1)[1], 'R2');
  assert.equal(sheet.getRow(4).values.slice(1)[1], 'R3');
  assert.equal(sheet.getRow(4).values.slice(1)[18], '');
  assert.equal(sheet.getRow(3).values.slice(1)[19], -1);
});

test('匹配对照规整派生日期序列号与金额字符串', async () => {
  const workbook = await readOutput('normalized.xlsx', [makePair({
    recon: { BillDate: '46179', 金额: '7587133' },
    bank: { 'Credit Amount': '7587133' }
  })]);
  const row = workbook.getWorksheet(MATCH_SHEET).getRow(2).values.slice(1);
  assert.equal(row[10], '2026-06-06');
  assert.equal(row[11], 7587133);
  assert.equal(typeof row[11], 'number');
  assert.equal(row[3], 7587133);
});

test('银行行-原始使用回填前快照，而不是已改写 bankRow', async () => {
  const workbook = await readOutput('bank-snapshot.xlsx', [makePair({ oldReconciliationId: 'SNAPSHOT-OLD' })]);
  const sheet = workbook.getWorksheet(BANK_RAW_SHEET);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['配对序号', ...BANK_STATEMENT_FIELDS]);
  const reconCell = BANK_STATEMENT_FIELDS.indexOf('ReconciliationId') + 2;
  assert.equal(sheet.getRow(2).getCell(reconCell).value, 'SNAPSHOT-OLD');
  assert.ok(!sheet.getRow(1).values.includes('_rowId'));
});

test('调拨对账单行-原始写真实派生字段及是否被使用', async () => {
  const workbook = await readOutput('recon-raw.xlsx', [makePair()]);
  const sheet = workbook.getWorksheet(RECON_RAW_SHEET);
  const reconHeaders = Object.values(FT_RECON_FIELD_MAP.recon);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['配对序号', ...reconHeaders]);
  assert.equal(sheet.getRow(2).getCell(reconHeaders.indexOf('调拨单号') + 2).value, 'FTA202606021000477');
  assert.equal(sheet.getRow(2).getCell(reconHeaders.indexOf('是否被使用') + 2).value, '1');
});

test('pairs 为空或未传时不追加 Payment 核对 sheet', async () => {
  for (const pairs of [[], null]) {
    const workbook = await readOutput(`empty-${String(pairs)}.xlsx`, pairs);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    assert.ok(!names.includes(MATCH_SHEET));
    assert.ok(!names.includes(BANK_RAW_SHEET));
    assert.ok(!names.includes(RECON_RAW_SHEET));
  }
});
