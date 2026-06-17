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

// ===== buildHitDetail（命中明细拼接，v3.0.7 需求B/C/D 格式 {字段名}:{wrap(旧)}→{wrap(新)}）=====
test('B buildHitDetail 单条字段变更格式精确（字段名前缀 + 半角冒号 + 全角箭头；纯数字→中文双引号）', () => {
  const out = buildHitDetail([
    { scenarioName: '按字段区分发生额', column: 'Credit Amount', oldValue: '100', newValue: '0' }
  ]);
  assert.strictEqual(out, 'Credit Amount:“100”→“0”');
});

test('B buildHitDetail 多字段变更 "; " 单行拼接（无换行，末条无尾分隔）', () => {
  const out = buildHitDetail([
    { scenarioName: 'S', column: 'A', oldValue: '1', newValue: '2' },
    { scenarioName: 'S', column: 'B', oldValue: '3', newValue: '4' }
  ]);
  assert.strictEqual(out, 'A:“1”→“2”; B:“3”→“4”');
  assert.ok(out.includes('; '), '多段用 "; " 分隔');
  assert.ok(!out.includes('\n'), 'C 单行布局：命中明细绝不含换行');
});

test('B buildHitDetail 空 → 空串', () => {
  assert.strictEqual(buildHitDetail([]), '');
  assert.strictEqual(buildHitDetail(null), '');
});

// ===== wrap 含数字/不含数字边界（v3.0.7 需求B/C/D：字段名前缀 + 全角箭头 →）=====
//   wrapHitValue 口径不变：含【任意数字字符】→ 中文双引号（trim 后）；完全不含数字 → 半角尖括号（原始 s）。
//   前缀 = column（裸写），箭头 = 全角 →，D：值不省略。
test('B buildHitDetail wrap 边界：空串/负数小数/千分位/数字英文混合/纯英文（字段名前缀 + 全角箭头）', () => {
  // 空串 → <>（不含数字 → 尖括号空）；column 缺省 → 前缀空串
  assert.strictEqual(buildHitDetail([{ oldValue: '', newValue: '' }]), ':<>→<>');
  // 负数 / 小数（含数字）→ 中文双引号（trim 后判定）
  assert.strictEqual(
    buildHitDetail([{ column: 'Amount', oldValue: '-12.5', newValue: '3.0' }]),
    'Amount:“-12.5”→“3.0”'
  );
  // 千分位含逗号（含数字）→ 中文双引号（按"含数字"归双引号）
  assert.strictEqual(
    buildHitDetail([{ column: 'Amount', oldValue: '1,000', newValue: '2,000' }]),
    'Amount:“1,000”→“2,000”'
  );
  // 字母数字混合（含数字）→ 中文双引号
  assert.strictEqual(
    buildHitDetail([{ column: 'Ref', oldValue: 'abc123', newValue: 'x' }]),
    'Ref:“abc123”→<x>'
  );
  // 数字英文混合（如交易流水号 T54SWIC494447，含数字）→ 中文双引号
  assert.strictEqual(
    buildHitDetail([{ column: 'ReconciliationId', oldValue: 'T54SWIC494447', newValue: '123' }]),
    'ReconciliationId:“T54SWIC494447”→“123”'
  );
  // 纯英文（Fundtransfer-out，不含数字）→ 尖括号（保留原始）
  assert.strictEqual(
    buildHitDetail([{ column: 'FundType', oldValue: 'Fundtransfer-out', newValue: 'Refund' }]),
    'FundType:<Fundtransfer-out>→<Refund>'
  );
  // 前后带空格的纯数字 → trim 后走双引号分支，显示 trim 后值
  assert.strictEqual(
    buildHitDetail([{ column: 'Credit Amount', oldValue: ' 100 ', newValue: '0' }]),
    'Credit Amount:“100”→“0”'
  );
});

// ===== sheet1「未命中场景」：A1 提示 + 表头 + FundType 排序（B-1/B-2/B-Q1/D8）=====
//   v3.0.8 W2：未命中 sheet 表头/数据整体右移一列（从 B 列起，getCell 第 2 参数 = colIdx+2）；
//            A 列除 A1 提醒外留空。命中场景 sheet 不变（见下方 B sheet2 用例）。
test('B sheet1 未命中场景：A1 加粗提示 + 第1行表头(B列,#9上移) + Mark without result 行排前（W2 右移）', async () => {
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
  // B-1：A1 加粗提示（W2 不变）
  assert.strictEqual(s1.getCell('A1').value, SHEET1_A1_NOTICE);
  assert.ok(s1.getCell('A1').font && s1.getCell('A1').font.bold, 'A1 加粗');
  // W2 + #9：A 列除 A1 外留空（表头已上移到第 1 行 B 列起；第 2 行起数据 A 列为空）
  assert.ok(s1.getCell(2, 1).value === null || s1.getCell(2, 1).value === undefined, '#9 数据行 A 列留空');
  assert.ok(s1.getCell(3, 1).value === null || s1.getCell(3, 1).value === undefined, '#9 数据行 A 列留空');
  // B-Q1 + W2 + #9：表头上移到第 1 行（与 A1 提醒同行）、从 B 列（第 2 列）起
  assert.strictEqual(s1.getCell(1, 2).value, 'MerchantId', '#9 第1行表头 MerchantId 从 B 列起');
  assert.strictEqual(s1.getCell(1, 3).value, 'FundType', '#9 第1行表头 FundType（右移1）');
  assert.strictEqual(s1.getCell(1, 4).value, 'Amount', '#9 第1行表头 Amount（右移1）');
  // B-2/D8 + W2 + #9：第 2 行起数据、从 B 列起，FundType='Mark without result' 行排前
  assert.strictEqual(s1.getCell(2, 2).value, 'm2', '#9 Mark without result 行排第一（第2行 B 列）');
  assert.strictEqual(s1.getCell(2, 3).value, MARK_WITHOUT_RESULT, '#9 FundType 数据右移1');
  assert.strictEqual(s1.getCell(3, 2).value, 'm1', '#9 其他未命中行随后（第3行 B 列）');
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
  // B-4：命中明细内容（v3.0.7 需求B/C/D 格式 {字段名}:{wrap(旧)}→{wrap(新)}；old/x 均非数字→尖括号，全角箭头）
  assert.strictEqual(
    s2.getCell(2, 1).value,
    'FundType:<old>→<x>'
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
  const s1 = wb.getWorksheet(SHEET1_UNMATCHED_NAME); // 第1行(A1提醒+表头) + 数据（#9 上移）
  const s2 = wb.getWorksheet(SHEET2_HIT_NAME);       // 表头 + 数据
  const unmatchedDataRows = s1.actualRowCount - 1;   // 减第1行(表头，含 A1 提醒)（#9 上移后表头与数据各占行）
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
