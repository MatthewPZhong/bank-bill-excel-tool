// v3.0.4 块 F 修订 R2 Q14 单测：Payment线下调拨核对 3 sheet（匹配对照 / 银行行-原始 / 订单行-原始）
//   覆盖：表头列序、行数、内部字段剥离、pairs 空/ null 时不加 sheet（主文件形态零变化）。
//   数据源 = 引擎 matchedPairs 项 { bankRow, orderRow, round, oldReconciliationId, dayDiff }。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { writeBankStatementOutput } = require('../../../src/main-process/exceljs-writer');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE } = require('../../../src/constants/table-signatures');

const MATCH_SHEET = '匹配对照';
const BANK_RAW_SHEET = '银行行-原始';
const ORDER_RAW_SHEET = '订单行-原始';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pob-sheets-'));
  return path.join(dir, name);
}

// 构造一条银行行（44 列子集 + _rowId/_modifiedColumns 内部字段）
function bankRow(o = {}) {
  return {
    _rowId: o._rowId ?? 'row_0',
    _modifiedColumns: new Set(['ReconciliationId']),
    BillDate: o.BillDate ?? '2026-05-26',
    'Credit Amount': o['Credit Amount'] ?? 4500000,
    Currency: o.Currency ?? 'EUR',
    ReconciliationId: o.ReconciliationId ?? 'CH-OFFLINE',
    MerchantId: '202782001',
    FundType: 'FundTransfer-in',
    地区: 'LU'
  };
}

// 构造一条中台订单行（26 列子集）
function orderRow(o = {}) {
  return {
    调拨单号: o.调拨单号 ?? 'FTA202606021000477',
    付款方式: '线下',
    渠道流水号: o.渠道流水号 ?? 'CH-OFFLINE',
    交易时间: o.交易时间 ?? '2026-05-26',
    '收款账户（卡号）': '202782001',
    收款金额: o.收款金额 ?? 4500000,
    收款币种: o.收款币种 ?? 'EUR',
    付款渠道: o.付款渠道 ?? 'BGL',
    收款渠道: o.收款渠道 ?? 'CITI'
  };
}

function makePair(o = {}) {
  return {
    bankRow: bankRow(o.bank),
    orderRow: orderRow(o.order),
    round: o.round ?? 'main',
    oldReconciliationId: o.oldReconciliationId ?? '',
    dayDiff: o.dayDiff ?? 0
  };
}

const HEADERS = ['MerchantId', 'FundType', 'ReconciliationId'];

// ===== pairs 非空：追加 3 sheet =====
test('Q14 pairs 非空 → 主文件追加 3 核对 sheet（命中/未命中 2 sheet + 3 核对 sheet）', async () => {
  const pairs = [makePair({ round: 'main' }), makePair({ bank: { _rowId: 'row_1' }, round: 'date-tolerance', oldReconciliationId: 'OLD' })];
  const out = tmpFile('pob.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(names.includes('未命中场景'), '保留未命中场景 sheet');
  assert.ok(names.includes('命中场景'), '保留命中场景 sheet');
  assert.ok(names.includes(MATCH_SHEET), '追加匹配对照 sheet');
  assert.ok(names.includes(BANK_RAW_SHEET), '追加银行行-原始 sheet');
  assert.ok(names.includes(ORDER_RAW_SHEET), '追加订单行-原始 sheet');
});

// ===== 匹配对照 sheet：表头 + 行数 + 轮次中文 + 原ReconciliationId 取覆盖前值 =====
test('Q14 匹配对照 sheet：16 列表头 + 行数 = pairs + 轮次中文展示 + 原ReconciliationId', async () => {
  // 默认 bankRow BillDate=2026-05-26（weekTag→2622）、orderRow FTA=FTA202606021000477（weekTag→2623）
  //   → 订单周 = 银行周 + 1（2623 = 2622 + 1）两列肉眼可见。
  const pairs = [
    makePair({ round: 'main', oldReconciliationId: 'OLD-A', dayDiff: 0 }),
    // R2 救回的倒挂行：dayDiff 带符号 −1（BillDate 早于交易时间）
    makePair({ bank: { _rowId: 'row_1' }, round: 'date-tolerance', oldReconciliationId: 'OLD-B', dayDiff: -1 }),
    makePair({ bank: { _rowId: 'row_2' }, round: 'relaxed-week', oldReconciliationId: '', dayDiff: 5 })
  ];
  const out = tmpFile('pob-match.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sm = wb.getWorksheet(MATCH_SHEET);
  const headerRow = sm.getRow(1).values.slice(1); // exceljs values[0] 占位
  assert.deepStrictEqual(headerRow, [
    '配对序号', '匹配轮次', 'BillDate', 'Credit Amount', 'Currency', '原ReconciliationId',
    '回填值(渠道流水号)', '调拨单号', '交易时间', '收款金额', '收款币种', '付款渠道', '收款渠道',
    '银行周', '订单周', '天数差'
  ]);
  // 行数 = 表头 + 3 数据行
  assert.strictEqual(sm.rowCount, 4);
  // 第 1 数据行：配对序号 1 / 轮次「主轮」/ 原ReconciliationId=OLD-A
  const r1 = sm.getRow(2).values.slice(1);
  assert.strictEqual(r1[0], 1, '配对序号 1');
  assert.strictEqual(r1[1], '主轮', 'main → 主轮');
  assert.strictEqual(r1[5], 'OLD-A', '原ReconciliationId 取覆盖前值');
  // 银行周 = weekTag(BillDate) 银行行自身周数（idx13），订单周 = weekTag(FTA)（idx14）；订单周 = 银行周 + 1
  //   weekTag 输出 'YYWW' 零填充字符串（展示口径），exceljs 读回保持字符串。
  assert.strictEqual(r1[13], '2622', '银行周 = weekTag(BillDate)，非 join 桶键 +1');
  assert.strictEqual(r1[14], '2623', '订单周 = weekTag(FTA)');
  assert.strictEqual(Number(r1[14]), Number(r1[13]) + 1, '订单周 = 银行周 + 1（两列肉眼可见）');
  // 天数差（idx15）带符号透传：第 1 行 0、第 2 行 −1（倒挂可见方向）
  assert.strictEqual(r1[15], 0, '天数差带符号：同日 0');
  assert.strictEqual(sm.getRow(3).values.slice(1)[15], -1, '天数差带符号：R2 倒挂行 −1');
  // 轮次中文：date-tolerance → 容差轮、relaxed-week → 兜底轮
  assert.strictEqual(sm.getRow(3).values.slice(1)[1], '容差轮');
  assert.strictEqual(sm.getRow(4).values.slice(1)[1], '兜底轮');
});

// ===== 真实链路 raw_json 形态：日期/金额规整（仅匹配对照 sheet）=====
test('Q14 匹配对照：交易时间为字符串 Excel 序列号 46179 → 规整显示 2026-06-06（本地时区）', async () => {
  // 真实 app 链路 mid 行来自链接表 raw_json：「交易时间」存字符串序列号 '46179'。
  const pairs = [makePair({ order: { 交易时间: '46179' } })];
  const out = tmpFile('pob-serial-date.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sm = wb.getWorksheet(MATCH_SHEET);
  const r1 = sm.getRow(2).values.slice(1);
  // 交易时间 = idx8（配对序号0/轮次1/BillDate2/CreditAmount3/Currency4/原ReconId5/回填值6/调拨单号7/交易时间8）
  assert.strictEqual(r1[8], '2026-06-06', '序列号 46179 → 本地年月日 2026-06-06（非 toISOString 的 06-05）');
  // BillDate（idx2）默认 '2026-05-26' 经 fmtDate 仍是 '2026-05-26'（既有案不回归）
  assert.strictEqual(r1[2], '2026-05-26', 'BillDate 标准日期串保持不变');
});

test('Q14 匹配对照：收款金额为字符串 7587133 → 规整为数字 7587133', async () => {
  // 真实 app 链路 mid 行「收款金额」存字符串数字 '7587133'；银行侧 Credit Amount 同步给字符串。
  const pairs = [makePair({ order: { 收款金额: '7587133' }, bank: { 'Credit Amount': '7587133' } })];
  const out = tmpFile('pob-str-amount.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sm = wb.getWorksheet(MATCH_SHEET);
  const r1 = sm.getRow(2).values.slice(1);
  // 收款金额 = idx9、Credit Amount = idx3
  assert.strictEqual(r1[9], 7587133, '收款金额字符串 → number 7587133');
  assert.strictEqual(typeof r1[9], 'number', '写入单元格为数字类型');
  assert.strictEqual(r1[3], 7587133, 'Credit Amount 字符串 → number');
});

// ===== 银行行-原始 sheet：配对序号 + 44 列契约列 + 内部字段剥离 =====
test('Q14 银行行-原始 sheet：配对序号 + 44 契约列、内部 _ 字段剥离', async () => {
  const pairs = [makePair()];
  const out = tmpFile('pob-bankraw.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sb = wb.getWorksheet(BANK_RAW_SHEET);
  const headerRow = sb.getRow(1).values.slice(1);
  assert.deepStrictEqual(headerRow, ['配对序号', ...BANK_STATEMENT_FIELDS]);
  // 内部字段不得出现在表头
  assert.ok(!headerRow.includes('_rowId'), '_rowId 被剥离');
  assert.ok(!headerRow.includes('_modifiedColumns'), '_modifiedColumns 被剥离');
  // 行数 = 表头 + 1
  assert.strictEqual(sb.rowCount, 2);
  assert.strictEqual(sb.getRow(2).getCell(1).value, 1, '配对序号 1');
});

// ===== 订单行-原始 sheet：配对序号 + 中台 26 列签名列序 =====
test('Q14 订单行-原始 sheet：配对序号 + 中台 26 列签名列序', async () => {
  const pairs = [makePair()];
  const out = tmpFile('pob-orderraw.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], pairs);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const so = wb.getWorksheet(ORDER_RAW_SHEET);
  const headerRow = so.getRow(1).values.slice(1);
  assert.deepStrictEqual(headerRow, ['配对序号', ...ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders]);
  assert.strictEqual(so.rowCount, 2);
  // 调拨单号在签名 idx0 → 配对序号后第 1 列
  assert.strictEqual(so.getRow(2).values.slice(1)[1], 'FTA202606021000477');
});

// ===== pairs 空 / null → 不加 sheet（主文件形态零变化）=====
test('Q14 pairs 空数组 → 不追加任何核对 sheet', async () => {
  const out = tmpFile('pob-empty.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], [], []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(!names.includes(MATCH_SHEET));
  assert.ok(!names.includes(BANK_RAW_SHEET));
  assert.ok(!names.includes(ORDER_RAW_SHEET));
});

test('Q14 pairs = null（缺省）→ 不追加任何核对 sheet（向后兼容旧 caller）', async () => {
  const out = tmpFile('pob-null.xlsx');
  await writeBankStatementOutput([], HEADERS, out, [], []); // 不传 paymentOfflinePairs
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const names = wb.worksheets.map((w) => w.name);
  assert.ok(!names.includes(MATCH_SHEET));
  assert.ok(!names.includes(BANK_RAW_SHEET));
  assert.ok(!names.includes(ORDER_RAW_SHEET));
});
