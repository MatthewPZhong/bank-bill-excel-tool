// v2.1.16-beta.2 R5 场景3：platform-cleanup-writer 单元测试
//
// 覆盖范围（writePlatformCleanupOutput 契约，详 src/main-process/platform-cleanup-writer.js）：
//   1. sheet 名 = 'Sheet1'（与模板 assets/中台加款单剔除模板.xlsx 一致）
//   2. 第 1 行 = 15 列表头，顺序严格 = CLEANUP_TEMPLATE_HEADERS
//   3. 数据行值按表头投影正确（加款单号 / 附言 / C~O；附言含中文标点）
//   4. 返回 { filePath, fileName } 正确
//   5. 缺列投影为 ''（防御性）
//   6. atomic write：tmp 不留半文件
//
// 读回用 ExcelJS（与 scenario-hit-rows-writer.test.js 范式一致）：cell 索引从 1 起

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  writePlatformCleanupOutput,
  CLEANUP_SHEET_NAME
} = require('../../../src/main-process/platform-cleanup-writer');
const { CLEANUP_TEMPLATE_HEADERS } = require('../../../src/constants/platform-cleanup-template-fields');

// ---------- Fixtures ----------

// 造 2 条 cleanupRows，含 CLEANUP_TEMPLATE_HEADERS 全 15 键；附言用中文标点（，。）
function makeCleanupRow(idx) {
  return {
    '加款单号': `ORDER_${idx}`,
    '附言': `跨境付款，中台加款单已关闭。`,
    'FundType': '跨境付款',
    'BillDate': '2026-06-01',
    'ValueDate': '2026-06-02',
    'Channel': '工商银行',
    '地区': '上海',
    'MerchantId': `M00${idx}`,
    'Currency': 'CNY',
    'Credit Amount': idx * 100,
    'Debit Amount': 0,
    'ReconciliationId': `RECON_${idx}`,
    'Transaction Description': `交易描述_${idx}`,
    'Extra Information': `额外信息_${idx}`,
    'Payment Detail': `支付明细_${idx}`
  };
}

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-cleanup-writer-'));
});

test.afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
});

// ========================================================================
// 1) sheet 名 = 'Sheet1'
// ========================================================================
test('① sheet 名为 Sheet1', async () => {
  const savePath = path.join(tmpDir, '中台加款单剔除模板-2026_06_01_1200.xlsx');
  await writePlatformCleanupOutput([makeCleanupRow(1)], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  assert.strictEqual(CLEANUP_SHEET_NAME, 'Sheet1');
  assert.ok(wb.getWorksheet('Sheet1'), 'workbook 应含名为 Sheet1 的 sheet');
});

// ========================================================================
// 2) 第 1 行 = 15 列表头，顺序严格 = CLEANUP_TEMPLATE_HEADERS
// ========================================================================
test('② 第一行表头 15 列且顺序 = CLEANUP_TEMPLATE_HEADERS', async () => {
  const savePath = path.join(tmpDir, 'h.xlsx');
  await writePlatformCleanupOutput([makeCleanupRow(1), makeCleanupRow(2)], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('Sheet1');
  const headerRow = sheet.getRow(1);

  assert.strictEqual(CLEANUP_TEMPLATE_HEADERS.length, 15, 'CLEANUP_TEMPLATE_HEADERS 应为 15 列');
  const actualHeaders = CLEANUP_TEMPLATE_HEADERS.map((_, i) => headerRow.getCell(i + 1).value);
  assert.deepStrictEqual(actualHeaders, CLEANUP_TEMPLATE_HEADERS.slice());
});

// ========================================================================
// 3) 数据行值按表头投影正确（加款单号 / 附言 / C~O；附言含中文标点）
// ========================================================================
test('③ 数据行值按表头投影正确（含附言中文标点）', async () => {
  const row1 = makeCleanupRow(1);
  const row2 = makeCleanupRow(2);
  const savePath = path.join(tmpDir, 'd.xlsx');
  await writePlatformCleanupOutput([row1, row2], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('Sheet1');

  // 数据行从第 2 行起，逐列按表头投影断言
  [row1, row2].forEach((srcRow, rowIdx) => {
    const dataRow = sheet.getRow(rowIdx + 2);
    CLEANUP_TEMPLATE_HEADERS.forEach((h, colIdx) => {
      assert.strictEqual(
        dataRow.getCell(colIdx + 1).value,
        srcRow[h],
        `第 ${rowIdx + 2} 行 列「${h}」值应为 ${srcRow[h]}`
      );
    });
  });

  // 显式断言「加款单号」「附言」（含中文标点，。）两专属列
  assert.strictEqual(sheet.getRow(2).getCell(1).value, 'ORDER_1');
  assert.strictEqual(sheet.getRow(2).getCell(2).value, '跨境付款，中台加款单已关闭。');
});

// ========================================================================
// 4) 返回 { filePath, fileName } 正确
// ========================================================================
test('④ 返回 { filePath, fileName } 正确', async () => {
  const fileName = '中台加款单剔除模板-2026_06_01_1200.xlsx';
  const savePath = path.join(tmpDir, fileName);
  const result = await writePlatformCleanupOutput([makeCleanupRow(1)], savePath);

  assert.strictEqual(result.filePath, savePath);
  assert.strictEqual(result.fileName, fileName);
});

// ========================================================================
// 5) 缺列投影为 ''（防御性）
// ========================================================================
test('⑤ 缺列投影为空字符串', async () => {
  const partial = { '加款单号': 'ORDER_X' }; // 仅 1 键，其余 14 列缺失
  const savePath = path.join(tmpDir, 'p.xlsx');
  await writePlatformCleanupOutput([partial], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('Sheet1');
  const dataRow = sheet.getRow(2);

  assert.strictEqual(dataRow.getCell(1).value, 'ORDER_X');
  // 第 2 列（附言）及之后均缺失 → '' 投影。ExcelJS 读回空串 cell.value 为 null
  CLEANUP_TEMPLATE_HEADERS.slice(1).forEach((h, i) => {
    const v = dataRow.getCell(i + 2).value;
    assert.ok(v === null || v === '', `列「${h}」缺失应投影为空（实际 ${JSON.stringify(v)}）`);
  });
});

// ========================================================================
// 6) atomic write：tmp 不留半文件
// ========================================================================
test('⑥ atomic write：成功后不留 .tmp 半文件', async () => {
  const savePath = path.join(tmpDir, 'atomic.xlsx');
  await writePlatformCleanupOutput([makeCleanupRow(1)], savePath);

  assert.ok(fs.existsSync(savePath), '最终文件应存在');
  assert.ok(!fs.existsSync(`${savePath}.tmp`), 'tmp 文件应已被 rename 清理');
});
