// v3.0.4 F3 单测：error-report 第 3 列「对账ID」三级回退链
//   覆盖 spec §4 F3 验收三态：reconid 非空 / 空回退 rowId / 全空 ''
//   + 5 列表头断言（'行号' → '对账ID'）+ resolveReconIdCell 纯函数三态
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  writeErrorReport,
  resolveReconIdCell
} = require('../../../src/main-process/exceljs-writer');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v304-f3-'));
  return path.join(dir, name);
}

// ===== resolveReconIdCell 纯函数三态（spec §4 F3 回退链）=====
test('F3 resolveReconIdCell：reconciliationId 非空优先', () => {
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: 'AFT123', reconId: 'k1', rowId: 'row_5' }),
    'AFT123'
  );
});

test('F3 resolveReconIdCell：reconciliationId 是 number 也走 String+trim', () => {
  assert.strictEqual(resolveReconIdCell({ reconciliationId: 88888888 }), '88888888');
});

test('F3 resolveReconIdCell：reconciliationId 空 → 回退 reconId（R1 专用）', () => {
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '', reconId: 'GW_KEY', rowId: 'row_3' }),
    'GW_KEY'
  );
  // 空白串也视为未命中继续回退
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '   ', reconId: 'GW_KEY' }),
    'GW_KEY'
  );
});

test('F3 resolveReconIdCell：reconciliationId/reconId 均空 → 回退 rowId', () => {
  assert.strictEqual(resolveReconIdCell({ rowId: 'row_7' }), 'row_7');
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: null, reconId: undefined, rowId: 'row_7' }),
    'row_7'
  );
});

test('F3 resolveReconIdCell：三者全空 → 空串', () => {
  assert.strictEqual(resolveReconIdCell({ rowId: null }), '');
  assert.strictEqual(resolveReconIdCell({}), '');
  assert.strictEqual(
    resolveReconIdCell({ reconciliationId: '', reconId: '', rowId: '' }),
    ''
  );
});

// ===== 端到端写盘三态 + 5 列表头 =====
test('F3 writeErrorReport：5 列表头第 3 列 = 对账ID', async () => {
  const out = tmpFile('hdr.xlsx');
  await writeErrorReport([], out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(1, 1).value, '时间戳', '表头 1');
  assert.strictEqual(sheet.getCell(1, 2).value, '场景名', '表头 2');
  assert.strictEqual(sheet.getCell(1, 3).value, '对账ID', '表头 3 = 对账ID');
  assert.strictEqual(sheet.getCell(1, 4).value, '原因', '表头 4');
  assert.strictEqual(sheet.getCell(1, 5).value, '可能原因', '表头 5');
});

test('F3 writeErrorReport：三态取值（reconid 非空 / 空回退 rowId / 全空 ）', async () => {
  const out = tmpFile('three-state.xlsx');
  const warnings = [
    // ① reconciliationId 非空 → 显示对账ID
    { scenarioId: 1, scenarioName: 'C1', rowId: 'row_0', reconciliationId: 'AFT123456789012', code: 'x', message: 'm1' },
    // ② reconciliationId 缺省 + reconId 缺省 → 回退 rowId（旧 shape 调用方未传 bankRows）
    { scenarioId: 2, scenarioName: 'C2', rowId: 'row_5', code: 'one-to-many', message: 'm2' },
    // ③ 全空（config 类 warning，rowId=null）→ 空串
    { scenarioId: 3, scenarioName: 'R5', rowId: null, code: 'y', message: 'm3' }
  ];
  await writeErrorReport(warnings, out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'AFT123456789012', '① reconid 非空显示对账ID');
  assert.strictEqual(sheet.getCell(3, 3).value, 'row_5', '② 空回退 rowId');
  // 全空：exceljs 空单元格读回为 null
  assert.ok(
    sheet.getCell(4, 3).value === '' || sheet.getCell(4, 3).value === null,
    '③ 全空 → 空串'
  );
});

test('F3 writeErrorReport：reconId（R1 专用字段）在 reconciliationId 空时生效', async () => {
  const out = tmpFile('r1.xlsx');
  const warnings = [
    { scenarioId: 1, scenarioName: 'R1', rowId: null, reconId: 'AFT999', code: 'multi-bank-match-r1', message: 'r1' }
  ];
  await writeErrorReport(warnings, out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.getWorksheet('error-report');
  assert.strictEqual(sheet.getCell(2, 3).value, 'AFT999', 'R1 reconId 兜底显示');
});
