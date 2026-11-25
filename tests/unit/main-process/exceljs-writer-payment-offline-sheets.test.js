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

test('v3.2.22（🔴）核对页银行字段按已解码文本编码：银行原值与 Payment 写入前被回填过的对账ID 都读回原值', async () => {
  const XLSX = require('xlsx');
  // 前序场景回填的对账ID 来自链接表（release/v3.2.22 合入 B113 D4b 后链接表各导入路径都落库已解码文本）：源表字面 `RID_x0041_`。
  const pair = makePair({ bank: { _rowId: 'row_7', MerchantId: 'A_x0000_B' }, oldReconciliationId: 'RID_x0041_' });
  pair.bankRowOriginal.ReconciliationId = 'RID_x0041_';
  pair.modifiedColumnsBeforePayment = ['ReconciliationId'];
  const modifications = [
    { rowId: 'row_7', column: 'ReconciliationId', oldValue: '', newValue: 'RID_x0041_' },
    { rowId: 'row_7', column: 'ReconciliationId', oldValue: 'RID_x0041_', newValue: 'NEW-RECON' }
  ];
  const out = tmpFile('source-aware.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], modifications, [pair]);
  const book = XLSX.readFile(out);
  const matchRows = XLSX.utils.sheet_to_json(book.Sheets[MATCH_SHEET], { header: 1, raw: true });
  assert.equal(matchRows[1][5], 'A_x0000_B', '银行原值 MerchantId 读回原值（不被解码成 A\\0B）');
  assert.equal(matchRows[1][7], 'RID_x0041_', 'Payment 写入前已被前序场景回填的对账ID 读回源表字面值');
  const rawRows = XLSX.utils.sheet_to_json(book.Sheets[BANK_RAW_SHEET], { header: 1, raw: true });
  assert.equal(rawRows[1][1 + BANK_STATEMENT_FIELDS.indexOf('MerchantId')], 'A_x0000_B');
  assert.equal(rawRows[1][1 + BANK_STATEMENT_FIELDS.indexOf('ReconciliationId')], 'RID_x0041_');

  // 只被 Payment 写过（或 Payment 回填值与原值相同、没有改写记录）：快照里的对账ID 是银行原值。
  for (const paymentModifications of [
    [{ rowId: 'row_8', column: 'ReconciliationId', oldValue: 'OLD_x0041_', newValue: 'NEW-RECON' }],
    []
  ]) {
    const plain = makePair({ bank: { _rowId: 'row_8' }, oldReconciliationId: 'OLD_x0041_' });
    plain.bankRowOriginal.ReconciliationId = 'OLD_x0041_';
    plain.modifiedColumnsBeforePayment = [];
    const plainOut = tmpFile(`source-aware-plain-${paymentModifications.length}.xlsx`);
    await writeBankStatementOutput([], HEADERS, plainOut, [], paymentModifications, [plain]);
    const plainBook = XLSX.readFile(plainOut);
    assert.equal(XLSX.utils.sheet_to_json(plainBook.Sheets[MATCH_SHEET], { header: 1, raw: true })[1][7], 'OLD_x0041_');
    assert.equal(XLSX.utils.sheet_to_json(plainBook.Sheets[BANK_RAW_SHEET], { header: 1, raw: true })[1][1 + BANK_STATEMENT_FIELDS.indexOf('ReconciliationId')],
      'OLD_x0041_');
  }
});

test('v3.2.22（🔴）核对页银行字段：C1 / C2 / C3 自定义值与链接表的值写入后都读回字面值', async () => {
  const XLSX = require('xlsx');
  // Payment 之前：C1 把对账ID 提取为 `C1_x0041_`，C3 按网关字段把 MerchantId 写成链接表的字面值 `M_x0041_`。
  const pair = makePair({ bank: { _rowId: 'row_9', MerchantId: 'M_x0041_' }, oldReconciliationId: 'C1_x0041_' });
  pair.bankRowOriginal.ReconciliationId = 'C1_x0041_';
  pair.bankRowOriginal.MerchantId = 'M_x0041_';
  pair.modifiedColumnsBeforePayment = ['ReconciliationId', 'MerchantId'];
  pair.decodedColumnsBeforePayment = ['ReconciliationId'];
  const modifications = [
    { rowId: 'row_9', column: 'ReconciliationId', oldValue: '', newValue: 'C1_x0041_', _valueDecoded: true },
    { rowId: 'row_9', column: 'MerchantId', oldValue: '202782001', newValue: 'M_x0041_' },
    { rowId: 'row_9', column: 'ReconciliationId', oldValue: 'C1_x0041_', newValue: 'NEW-RECON' }
  ];
  const out = tmpFile('source-aware-decoded.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], modifications, [pair]);
  const book = XLSX.readFile(out);
  const matchRows = XLSX.utils.sheet_to_json(book.Sheets[MATCH_SHEET], { header: 1, raw: true });
  assert.equal(matchRows[1][7], 'C1_x0041_', '🔴 C1 写入的已解码对账ID 读回字面值');
  assert.equal(matchRows[1][5], 'M_x0041_', '🔴 链接表的值改写的 MerchantId 读回字面值');
  const rawRows = XLSX.utils.sheet_to_json(book.Sheets[BANK_RAW_SHEET], { header: 1, raw: true });
  assert.equal(rawRows[1][1 + BANK_STATEMENT_FIELDS.indexOf('ReconciliationId')], 'C1_x0041_');
  assert.equal(rawRows[1][1 + BANK_STATEMENT_FIELDS.indexOf('MerchantId')], 'M_x0041_');

  // 同一列多次改写：当前值读回字面值。
  const last = makePair({ bank: { _rowId: 'row_10', MerchantId: 'X_x0041_' }, oldReconciliationId: '' });
  const lastOut = tmpFile('source-aware-last.xlsx');
  await writeBankStatementOutput([], HEADERS, lastOut, [], [
    { rowId: 'row_10', column: 'MerchantId', oldValue: '202782001', newValue: 'GW_x0041_' },
    { rowId: 'row_10', column: 'MerchantId', oldValue: 'GW_x0041_', newValue: 'X_x0041_', _valueDecoded: true }
  ], [last]);
  assert.equal(XLSX.utils.sheet_to_json(XLSX.readFile(lastOut).Sheets[MATCH_SHEET], { header: 1, raw: true })[1][5], 'X_x0041_');
});

test('v3.2.22（🔴）big_account 按已解码文本编码：来自账户映射的账号与配对银行 MerchantId 读回相等，未映射的与原始账号一致', async () => {
  const XLSX = require('xlsx');
  const reconHeaders = Object.values(FT_RECON_FIELD_MAP.recon);
  const bigIdx = 1 + reconHeaders.indexOf('big_account');
  const payeeIdx = 1 + reconHeaders.indexOf('收款账号');
  // 映射命中：收款账号 GW-001 → 用户录入的清结算账号字面 `A_x0041_B`，银行 MerchantId 是同一个字面账号（银行原值）。
  const mapped = makePair({ bank: { _rowId: 'row_m', MerchantId: 'A_x0041_B' }, recon: { big_account: 'A_x0041_B' } });
  mapped.reconRow.收款账号 = 'GW-001';
  // 未命中映射：big_account 就是链接表落库的收款账号（release/v3.2.22 合入 B113 D4b 后链接表各导入路径都落库已解码文本），与收款账号列读回一致。
  const unmapped = makePair({ bank: { _rowId: 'row_u', MerchantId: 'RAW_x0041_' }, recon: { big_account: 'RAW_x0041_' } });
  unmapped.reconRow.收款账号 = 'RAW_x0041_';
  const out = tmpFile('big-account-encoding.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], [mapped, unmapped]);
  const book = XLSX.readFile(out);
  const matchRows = XLSX.utils.sheet_to_json(book.Sheets[MATCH_SHEET], { header: 1, raw: true });
  const reconRows = XLSX.utils.sheet_to_json(book.Sheets[RECON_RAW_SHEET], { header: 1, raw: true });
  assert.equal(matchRows[0][5], 'MerchantId');
  assert.equal(matchRows[0][15], 'big_account');
  assert.equal(matchRows[1][5], 'A_x0041_B');
  assert.equal(matchRows[1][15], matchRows[1][5], '🔴 匹配对照：映射来的 big_account 与配对银行 MerchantId 读回相等');
  assert.equal(reconRows[1][bigIdx], 'A_x0041_B', '🔴 调拨对账单行-原始：映射来的 big_account 读回字面值');
  assert.equal(matchRows[2][15], 'RAW_x0041_');
  assert.equal(matchRows[2][15], matchRows[2][5], '未映射：与银行 MerchantId 读回一致');
  assert.equal(reconRows[2][bigIdx], 'RAW_x0041_', '🔴 调拨对账单行-原始：未映射的 big_account 读回字面值');
  assert.equal(reconRows[2][payeeIdx], 'RAW_x0041_', '🔴 调拨对账单行-原始：收款账号同样读回字面值');
});
