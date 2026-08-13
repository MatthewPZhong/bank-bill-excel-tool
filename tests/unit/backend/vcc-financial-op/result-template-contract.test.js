'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  RESULT_TEMPLATE_FILE_SHA256,
  RESULT_TEMPLATE_HEADERS,
  RESULT_TEMPLATE_BUSINESS_RANGE,
  RESULT_TEMPLATE_PHYSICAL_RANGE,
  RESULT_TEMPLATE_PRINT_AREA,
  sha256,
  inspectResultTemplateWorkbook,
  loadResultTemplateContract,
  clearResultTemplateContractCache
} = require('../../../../src/backend/vcc-financial-op/result-template-contract');
const {
  encodeAdjustmentLineageName,
  parseAdjustmentLineageName
} = require('../../../../src/backend/vcc-financial-op/adjustment-lineage');

const ASSET_PATH = path.join(
  __dirname,
  '../../../../assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx'
);
const TEST_ROW_KEY = `v1:${'0123456789abcdef'.repeat(4)}`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-template-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function readGoldenWorkbook() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(ASSET_PATH);
  return workbook;
}

test.beforeEach(() => clearResultTemplateContractCache());

test('结果模板金标准锁定 SHA、14 列、有效/物理区域和语义布局', async () => {
  assert.equal(sha256(fs.readFileSync(ASSET_PATH)), RESULT_TEMPLATE_FILE_SHA256);
  const contract = await loadResultTemplateContract({ templatePath: ASSET_PATH });
  assert.deepEqual(contract.headers, RESULT_TEMPLATE_HEADERS);
  assert.equal(contract.businessRange, RESULT_TEMPLATE_BUSINESS_RANGE);
  assert.equal(contract.physicalRange, RESULT_TEMPLATE_PHYSICAL_RANGE);
  assert.equal(contract.printArea, RESULT_TEMPLATE_PRINT_AREA);
  assert.equal(contract.printAreaRightColumn, 'L');
  assert.deepEqual(Object.keys(contract.anchors), [
    'opening', 'classified', 'unclassified', 'channel',
    'pending', 'calculated', 'system', 'difference'
  ]);
  assert.notDeepEqual(contract.normalFill, contract.abnormalFill);
  assert.ok(Object.keys(contract.adjustmentValueStyle.style.font).length > 0);
  assert.ok(Object.keys(contract.adjustmentReasonFont).length > 0);
  assert.ok(contract.adjustmentHeaderStyles.value.style.numFmt);
});

test('sheet、表头、语义锚点和 fill 漂移均失败关闭', async () => {
  const missingSheet = await readGoldenWorkbook();
  missingSheet.getWorksheet('财务OP校验结果表').name = '漂移结果表';
  assert.throws(
    () => inspectResultTemplateWorkbook(missingSheet),
    (error) => error.code === 'result-template-contract-mismatch'
  );

  const headerDrift = await readGoldenWorkbook();
  headerDrift.getWorksheet('财务OP校验结果表').getCell('N1').value = '原因';
  assert.throws(
    () => inspectResultTemplateWorkbook(headerDrift),
    (error) => error.code === 'result-template-contract-mismatch'
      && error.detailLines.some((line) => line.includes('14 列'))
  );

  const missingAnchor = await readGoldenWorkbook();
  missingAnchor.getWorksheet('财务OP校验结果表').getCell('B42').value = '漂移 Pending';
  assert.throws(
    () => inspectResultTemplateWorkbook(missingAnchor),
    (error) => error.code === 'result-template-contract-mismatch'
      && error.detailLines.some((line) => line.includes('当月移除pending'))
  );

  const duplicateAnchor = await readGoldenWorkbook();
  duplicateAnchor.getWorksheet('财务OP校验结果表').getCell('C4').value = 'B2B';
  assert.throws(
    () => inspectResultTemplateWorkbook(duplicateAnchor),
    (error) => error.code === 'result-template-contract-mismatch'
      && error.detailLines.some((line) => line.includes('实际匹配 2 行'))
  );

  const halfStyled = await readGoldenWorkbook();
  halfStyled.getWorksheet('财务OP校验结果表').getCell('D1').fill = {};
  assert.throws(
    () => inspectResultTemplateWorkbook(halfStyled),
    (error) => error.code === 'result-template-contract-mismatch'
      && error.detailLines.some((line) => line.includes('D1'))
  );
});

test('模板缺失、hash 变化和缓存对象污染均不会复用旧契约', async (t) => {
  const dir = tempDir(t);
  const templatePath = path.join(dir, 'VCC财务OP校验结果表_模板.xlsx');
  fs.copyFileSync(ASSET_PATH, templatePath);

  const first = await loadResultTemplateContract({ templatePath });
  first.normalFill = { type: 'pattern', pattern: 'solid' };
  const second = await loadResultTemplateContract({ templatePath });
  assert.notDeepEqual(second.normalFill, first.normalFill);

  fs.appendFileSync(templatePath, Buffer.from('contract-drift'));
  await assert.rejects(
    loadResultTemplateContract({ templatePath }),
    (error) => error.code === 'result-template-contract-mismatch'
      && error.detailLines.some((line) => line.includes('SHA-256'))
  );

  await assert.rejects(
    loadResultTemplateContract({ templatePath: path.join(dir, 'missing.xlsx') }),
    (error) => error.code === 'result-template-missing'
  );
});

test('调整血缘 defined name 经 ExcelJS write→reopen 完整保真', async (t) => {
  const outputPath = path.join(tempDir(t), 'lineage.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('财务OP校验结果表');
  const name = encodeAdjustmentLineageName(TEST_ROW_KEY, 'JPY');
  sheet.getCell('M2').value = 135886024.59;
  sheet.getCell('M2').name = name;
  await workbook.xlsx.writeFile(outputPath);

  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.readFile(outputPath);
  const reopenedCell = reopened.getWorksheet('财务OP校验结果表').getCell('M2');
  assert.deepEqual(reopenedCell.names, [name]);
  assert.deepEqual(parseAdjustmentLineageName(reopenedCell.names[0]), {
    rowKey: TEST_ROW_KEY,
    currency: 'JPY'
  });
  assert.deepEqual(reopened.definedNames.getRanges(name).ranges, [
    "'财务OP校验结果表'!$M$2"
  ]);
});

test('调整血缘只接受完整 v1:64hex 与九币种', () => {
  assert.throws(() => encodeAdjustmentLineageName('v1:abc', 'USD'), /rowKey 非法/);
  assert.match(encodeAdjustmentLineageName(TEST_ROW_KEY, 'CNY'), /_CNY$/);
  assert.throws(() => encodeAdjustmentLineageName(TEST_ROW_KEY, 'CNH'), /币种非法/);
  assert.equal(parseAdjustmentLineageName('VCC_ADJUSTMENT_V1_bad_USD'), null);
});
