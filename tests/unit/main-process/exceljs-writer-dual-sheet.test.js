// v2.1.16-beta.6 需求 B 单测：预加工导出双 sheet「未命中场景 / 命中场景」
//   覆盖 AC B-1~B-6（PRD §三）+ 决策 D5/D8/D9/B-Q1/B-Q2
//   🔴 资金红线：对账主产物格式。断言精确对应新契约（命中明细第1列 + 原列右移1 + sheet 顺序对调）。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  writeBankStatementOutput,
  buildHitDetail,
  SHEET1_UNMATCHED_NAME,
  SHEET2_HIT_NAME,
  SHEET1_A1_NOTICE,
  HIT_DETAIL_HEADER,
  MARK_WITHOUT_RESULT
} = require('../../../src/main-process/exceljs-writer');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta6-b-'));
  return path.join(dir, name);
}

// ===== buildHitDetail（命中明细拼接，D9 + B-Q2）=====
test('B buildHitDetail 单条字段变更格式精确', () => {
  const out = buildHitDetail([
    { scenarioName: '按字段区分发生额', column: 'Credit Amount', oldValue: '100', newValue: '0' }
  ]);
  assert.strictEqual(out, '<命中场景:"按字段区分发生额";"Credit Amount";变更前:"100";变更后:"0">');
});

test('B buildHitDetail 多字段变更换行拼接（B-Q2）', () => {
  const out = buildHitDetail([
    { scenarioName: 'S', column: 'A', oldValue: '1', newValue: '2' },
    { scenarioName: 'S', column: 'B', oldValue: '3', newValue: '4' }
  ]);
  assert.strictEqual(
    out,
    '<命中场景:"S";"A";变更前:"1";变更后:"2">\n<命中场景:"S";"B";变更前:"3";变更后:"4">'
  );
  assert.ok(out.includes('\n'), '多段用换行分隔');
});

test('B buildHitDetail 空 → 空串', () => {
  assert.strictEqual(buildHitDetail([]), '');
  assert.strictEqual(buildHitDetail(null), '');
});

// ===== sheet1「未命中场景」：A1 提示 + 表头 + FundType 排序（B-1/B-2/B-Q1/D8）=====
test('B sheet1 未命中场景：A1 加粗提示 + 第2行表头 + Mark without result 行排前', async () => {
  const headers = ['MerchantId', 'FundType', 'Amount'];
  const unmatchedRows = [
    { MerchantId: 'm1', FundType: 'Ach Return', Amount: '50', _rowId: 'u1', _modifiedColumns: new Set() },
    { MerchantId: 'm2', FundType: MARK_WITHOUT_RESULT, Amount: '100', _rowId: 'u2', _modifiedColumns: new Set() }
  ];
  const out = tmpFile('s1.xlsx');
  await writeBankStatementOutput([], headers, out, unmatchedRows, []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  // sheet 顺序对调：未命中场景(0) → 命中场景(1)
  assert.strictEqual(wb.worksheets[0].name, SHEET1_UNMATCHED_NAME, 'sheet1 = 未命中场景');
  assert.strictEqual(wb.worksheets[1].name, SHEET2_HIT_NAME, 'sheet2 = 命中场景');
  const s1 = wb.worksheets[0];
  // B-1：A1 加粗提示
  assert.strictEqual(s1.getCell('A1').value, SHEET1_A1_NOTICE);
  assert.ok(s1.getCell('A1').font && s1.getCell('A1').font.bold, 'A1 加粗');
  // B-Q1：第2行表头
  assert.strictEqual(s1.getCell(2, 1).value, 'MerchantId', '第2行表头 MerchantId');
  assert.strictEqual(s1.getCell(2, 2).value, 'FundType', '第2行表头 FundType');
  // B-2/D8：第3行起数据，FundType='Mark without result' 行排前
  assert.strictEqual(s1.getCell(3, 1).value, 'm2', 'Mark without result 行排第一');
  assert.strictEqual(s1.getCell(3, 2).value, MARK_WITHOUT_RESULT);
  assert.strictEqual(s1.getCell(4, 1).value, 'm1', '其他未命中行随后');
});

// ===== sheet2「命中场景」：命中明细列 + 原列右移 + 标黄（B-3/B-4/D5/D9）=====
test('B sheet2 命中场景：第1列命中明细 + 原列右移1 + 标黄右移', async () => {
  const headers = ['MerchantId', 'FundType', 'Amount'];
  const modifiedRows = [
    { MerchantId: 'm1', FundType: 'x', Amount: '0', _rowId: 'r1', _modifiedColumns: new Set(['FundType']) }
  ];
  const modifications = [
    { rowId: 'r1', column: 'FundType', oldValue: 'old', newValue: 'x', scenarioName: '场景1' }
  ];
  const out = tmpFile('s2.xlsx');
  await writeBankStatementOutput(modifiedRows, headers, out, [], modifications);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);
  // B-3：第1列表头 = 命中明细
  assert.strictEqual(s2.getCell(1, 1).value, HIT_DETAIL_HEADER, '第1列表头=命中明细');
  assert.strictEqual(s2.getCell(1, 2).value, 'MerchantId', '原表头右移1');
  // B-4：命中明细内容（与 modifications 逐条对应）
  assert.strictEqual(
    s2.getCell(2, 1).value,
    '<命中场景:"场景1";"FundType";变更前:"old";变更后:"x">'
  );
  // 原数据右移1：MerchantId 在第2列
  assert.strictEqual(s2.getCell(2, 2).value, 'm1', '原数据列右移1');
  // D5：FundType 标黄（headers index 1 → 右移列 = 1+1+2 = 第3列）
  const fundCell = s2.getCell(2, 3);
  assert.ok(
    fundCell.fill && fundCell.fill.fgColor && fundCell.fill.fgColor.argb === 'FFFFFF00',
    'FundType 标黄保留（右移1）'
  );
  // 未改字段 MerchantId（第2列）不标黄
  const mCell = s2.getCell(2, 2);
  assert.ok(!mCell.fill || !mCell.fill.fgColor, 'MerchantId 未改不标黄');
});

// ===== B-6 行数守恒 + B-5 空边界 =====
test('B 行数守恒：未命中 + 命中 = 原始总行数', async () => {
  const headers = ['A', 'B'];
  const modifiedRows = [
    { A: 'h1', B: 'x', _rowId: 'r1', _modifiedColumns: new Set() },
    { A: 'h2', B: 'y', _rowId: 'r2', _modifiedColumns: new Set() }
  ];
  const unmatchedRows = [
    { A: 'u1', B: 'z', _rowId: 'u1', _modifiedColumns: new Set() }
  ];
  const out = tmpFile('conserve.xlsx');
  await writeBankStatementOutput(modifiedRows, headers, out, unmatchedRows, []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const s1 = wb.getWorksheet(SHEET1_UNMATCHED_NAME); // A1 + 表头 + 数据
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);       // 表头 + 数据
  const unmatchedDataRows = s1.actualRowCount - 2;   // 减 A1 + 表头
  const hitDataRows = s2.actualRowCount - 1;         // 减表头
  assert.strictEqual(unmatchedDataRows, 1, '未命中数据 1 行');
  assert.strictEqual(hitDataRows, 2, '命中数据 2 行');
  assert.strictEqual(unmatchedDataRows + hitDataRows, 3, '行数守恒 = 原始 3 行');
});

test('B 空边界：空 modifiedRows + 空 unmatchedRows 不报错', async () => {
  const headers = ['A', 'B'];
  const out = tmpFile('empty.xlsx');
  await writeBankStatementOutput([], headers, out, [], []);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  assert.strictEqual(wb.worksheets.length, 2, '空数据仍输出 2 sheet');
  assert.strictEqual(wb.getWorksheet(SHEET1_UNMATCHED_NAME).getCell('A1').value, SHEET1_A1_NOTICE);
  assert.strictEqual(wb.getWorksheet(SHEET2_HIT_NAME).getCell(1, 1).value, HIT_DETAIL_HEADER);
});
