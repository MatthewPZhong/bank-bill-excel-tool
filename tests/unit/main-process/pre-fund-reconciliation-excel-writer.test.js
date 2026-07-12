'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  SHEET_NAMES,
  TEMPLATE_SHEETS,
  PreFundTemplateError,
  formatLocalExportDate,
  buildChannelFileName,
  loadTemplateWorkbook,
  writeChannelWorkbook,
  writeChannelWorkbooks
} = require('../../../src/main-process/pre-fund-reconciliation/excel-writer');

function mappedRow(headers, prefix) {
  return Object.fromEntries(headers.map((header, index) => [header, `${prefix}-${index + 1}`]));
}

async function createTemplate(filePath, mutate) {
  const workbook = new ExcelJS.Workbook();
  for (const contract of TEMPLATE_SHEETS) {
    const worksheet = workbook.addWorksheet(contract.name, {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    worksheet.addRow(contract.headers.slice());
    worksheet.getRow(1).height = 24;
    for (let index = 1; index <= contract.headers.length; index += 1) {
      worksheet.getColumn(index).width = 12 + index;
      const cell = worksheet.getRow(1).getCell(index);
      cell.font = { bold: true, name: 'Arial', size: 10 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF112233' }
      };
      cell.alignment = { horizontal: 'center' };
    }
  }
  if (mutate) mutate(workbook);
  await workbook.xlsx.writeFile(filePath);
}

function rowValues(worksheet, rowNumber, width) {
  const values = [];
  for (let index = 1; index <= width; index += 1) {
    const value = worksheet.getRow(rowNumber).getCell(index).value;
    values.push(value === null || value === undefined ? '' : value);
  }
  return values;
}

let tempDir;
let templatePath;

test.beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-excel-writer-'));
  templatePath = path.join(tempDir, 'template.xlsx');
  await createTemplate(templatePath);
});

test.afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

test('最终模板必须严格为固定5-sheet顺序和20/31/31/16/14表头', async () => {
  const workbook = await loadTemplateWorkbook(templatePath);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
  assert.deepEqual(TEMPLATE_SHEETS.map((item) => item.headers.length), [20, 31, 31, 16, 14]);
});

test('真实 asset 已升级为最终5-sheet契约', async () => {
  const realAsset = path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx');
  const workbook = await loadTemplateWorkbook(realAsset);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
  assert.deepEqual(
    workbook.worksheets.map((worksheet) => worksheet.getRow(1).cellCount),
    [20, 31, 31, 16, 14]
  );
});

test('模板任一固定表头漂移时中文 fail-fast 并定位sheet/列', async () => {
  const badTemplate = path.join(tempDir, 'bad-template.xlsx');
  await createTemplate(badTemplate, (workbook) => {
    workbook.getWorksheet('平账结果').getRow(1).getCell(5).value = '错误列';
  });
  await assert.rejects(
    () => loadTemplateWorkbook(badTemplate),
    (error) => error instanceof PreFundTemplateError
      && error.sheetName === '平账结果'
      && error.message.includes('第5列')
      && error.message.includes('网关-OrderId')
  );
});

test('按单渠道逐行写5-sheet：数据列固定、网关账单/订单修复仅表头、样式宽度冻结保留', async () => {
  const outputDirectory = path.join(tempDir, 'out');
  const unbalanced = mappedRow(TEMPLATE_SHEETS[0].headers, 'U');
  const balanced = mappedRow(TEMPLATE_SHEETS[1].headers, 'B');
  const channelBill = mappedRow(TEMPLATE_SHEETS[3].headers, 'C');

  const result = await writeChannelWorkbook({
    templatePath,
    outputDirectory,
    channel: 'MPT/IN',
    exportDate: new Date(2026, 6, 10, 12, 0, 0),
    unbalancedRows: (function* rows() { yield unbalanced; }()),
    balancedRows: (async function* rows() { yield balanced; }()),
    channelBillRows: (function* rows() { yield channelBill; }())
  });

  assert.equal(result.fileName, '资金对账不平_MPT_IN_2026年07月10日.xlsx');
  assert.deepEqual(result.rowCounts, {
    unbalanced: 1,
    balanced: 1,
    gatewayBill: 0,
    channelBill: 1,
    orderRepair: 0
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePath);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
  assert.deepEqual(rowValues(workbook.getWorksheet('不平结果'), 2, 20), projectValues(TEMPLATE_SHEETS[0].headers, unbalanced));
  assert.deepEqual(rowValues(workbook.getWorksheet('平账结果'), 2, 31), projectValues(TEMPLATE_SHEETS[1].headers, balanced));
  assert.deepEqual(rowValues(workbook.getWorksheet('渠道账单'), 2, 16), projectValues(TEMPLATE_SHEETS[3].headers, channelBill));
  assert.equal(workbook.getWorksheet('网关账单').rowCount, 1);
  assert.equal(workbook.getWorksheet('订单修复').rowCount, 1);

  const firstSheet = workbook.getWorksheet('不平结果');
  assert.equal(firstSheet.getColumn(1).width, 13);
  assert.equal(firstSheet.getRow(1).height, 24);
  assert.equal(firstSheet.getRow(1).getCell(1).font.bold, true);
  assert.equal(firstSheet.getRow(1).getCell(1).fill.fgColor.argb, 'FF112233');
  assert.equal(firstSheet.views[0].state, 'frozen');
  assert.equal(firstSheet.views[0].ySplit, 1);
});

function projectValues(headers, row) {
  return headers.map((header) => row[header]);
}

test('0不平仍导出：不平结果和渠道账单只有表头，平账结果有数据', async () => {
  const result = await writeChannelWorkbook({
    templatePath,
    outputDirectory: path.join(tempDir, 'zero'),
    channel: 'ZERO',
    exportDate: new Date(2026, 6, 10),
    unbalancedRows: [],
    balancedRows: [mappedRow(TEMPLATE_SHEETS[1].headers, 'B')],
    channelBillRows: []
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePath);
  assert.equal(workbook.getWorksheet('不平结果').rowCount, 1);
  assert.equal(workbook.getWorksheet('平账结果').rowCount, 2);
  assert.equal(workbook.getWorksheet('渠道账单').rowCount, 1);
  assert.equal(result.rowCounts.unbalanced, 0);
  assert.equal(result.rowCounts.balanced, 1);
});

test('批量writer顺序消费逐渠道 async iterable，两个渠道文件内容不串', async () => {
  const outputDirectory = path.join(tempDir, 'batch');
  const consumed = [];
  async function* channelExports() {
    consumed.push('A');
    yield {
      channel: 'A/渠道',
      unbalancedRows: [mappedRow(TEMPLATE_SHEETS[0].headers, 'UA')],
      balancedRows: [],
      channelBillRows: [mappedRow(TEMPLATE_SHEETS[3].headers, 'CA')]
    };
    consumed.push('B');
    yield {
      channel: 'B:渠道',
      unbalancedRows: [mappedRow(TEMPLATE_SHEETS[0].headers, 'UB')],
      balancedRows: [],
      channelBillRows: [mappedRow(TEMPLATE_SHEETS[3].headers, 'CB')]
    };
  }

  const results = await writeChannelWorkbooks({
    templatePath,
    outputDirectory,
    exportDate: new Date(2026, 6, 10),
    channelExports: channelExports()
  });
  assert.deepEqual(consumed, ['A', 'B']);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((item) => item.fileName), [
    '资金对账不平_A_渠道_2026年07月10日.xlsx',
    '资金对账不平_B_渠道_2026年07月10日.xlsx'
  ]);

  const workbookA = new ExcelJS.Workbook();
  const workbookB = new ExcelJS.Workbook();
  await workbookA.xlsx.readFile(results[0].filePath);
  await workbookB.xlsx.readFile(results[1].filePath);
  assert.equal(workbookA.getWorksheet('不平结果').getRow(2).getCell(1).value, 'UA-1');
  assert.equal(workbookB.getWorksheet('不平结果').getRow(2).getCell(1).value, 'UB-1');
});

test('渠道账单行数与不平结果不一致时拒绝伪成功并清理临时文件', async () => {
  const outputDirectory = path.join(tempDir, 'mismatch');
  const expectedPath = path.join(outputDirectory, buildChannelFileName('BAD', new Date(2026, 6, 10)));
  await assert.rejects(
    () => writeChannelWorkbook({
      templatePath,
      outputDirectory,
      channel: 'BAD',
      exportDate: new Date(2026, 6, 10),
      unbalancedRows: [mappedRow(TEMPLATE_SHEETS[0].headers, 'U')],
      balancedRows: [],
      channelBillRows: []
    }),
    /不守恒/
  );
  assert.equal(fs.existsSync(expectedPath), false);
  const leftovers = fs.existsSync(outputDirectory)
    ? fs.readdirSync(outputDirectory).filter((name) => name.includes('.tmp.xlsx'))
    : [];
  assert.deepEqual(leftovers, []);
});

test('数据 iterable 中途抛错时不留下最终文件或临时文件', async () => {
  const outputDirectory = path.join(tempDir, 'broken');
  const expectedPath = path.join(outputDirectory, buildChannelFileName('BROKEN', new Date(2026, 6, 10)));
  function* brokenRows() {
    yield mappedRow(TEMPLATE_SHEETS[0].headers, 'U');
    throw new Error('模拟游标失败');
  }
  await assert.rejects(
    () => writeChannelWorkbook({
      templatePath,
      outputDirectory,
      channel: 'BROKEN',
      exportDate: new Date(2026, 6, 10),
      unbalancedRows: brokenRows(),
      balancedRows: [],
      channelBillRows: [mappedRow(TEMPLATE_SHEETS[3].headers, 'C')]
    }),
    /模拟游标失败/
  );
  assert.equal(fs.existsSync(expectedPath), false);
  assert.deepEqual(fs.readdirSync(outputDirectory).filter((name) => name.includes('.tmp.xlsx')), []);
});

test('文件名使用本机日历日并复用安全文件名规则', () => {
  const date = new Date(2026, 0, 2, 23, 59, 59);
  assert.equal(formatLocalExportDate(date), '2026年01月02日');
  assert.equal(
    buildChannelFileName('A/B:C*D?', date),
    '资金对账不平_A_B_C_D__2026年01月02日.xlsx'
  );
});
