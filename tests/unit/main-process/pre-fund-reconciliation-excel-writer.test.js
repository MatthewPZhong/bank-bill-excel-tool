'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  SHEET_NAMES,
  DUPLICATE_SHEET_NAME,
  TEMPLATE_SHEETS,
  PreFundTemplateError,
  formatLocalExportDate,
  buildChannelFileName,
  loadTemplateWorkbook,
  moveFileNoClobber,
  currentFileMatchesIdentity,
  writeChannelWorkbook,
  writeChannelWorkbooks,
  EXCEL_MAX_DATA_ROWS,
  assertExcelDataRowCapacity
} = require('../../../src/main-process/pre-fund-reconciliation/excel-writer');
const {
  DUPLICATE_GATEWAY_HEADERS
} = require('../../../src/main-process/pre-fund-reconciliation/output-mapper');

function mappedRow(headers, prefix) {
  return Object.fromEntries(headers.map((header, index) => [header, `${prefix}-${index + 1}`]));
}

test('no-clobber 发布身份可识别外部后续修改', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-publication-'));
  const sourcePath = path.join(directory, 'source.xlsx');
  const destinationPath = path.join(directory, 'destination.xlsx');
  try {
    fs.writeFileSync(sourcePath, 'ORIGINAL');
    const identity = moveFileNoClobber(sourcePath, destinationPath);
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(currentFileMatchesIdentity(destinationPath, identity), true);
    fs.writeFileSync(destinationPath, 'EXTERNAL-MODIFICATION');
    assert.equal(currentFileMatchesIdentity(destinationPath, identity), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('目标目录不支持硬链接时降级排他复制且仍不覆盖', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-copy-fallback-'));
  const sourcePath = path.join(directory, 'source.xlsx');
  const destinationPath = path.join(directory, 'destination.xlsx');
  const originalLinkSync = fs.linkSync;
  try {
    fs.writeFileSync(sourcePath, 'COPY-FALLBACK');
    fs.linkSync = () => {
      const error = new Error('hard links unsupported');
      error.code = 'ENOTSUP';
      throw error;
    };
    const identity = moveFileNoClobber(sourcePath, destinationPath);
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'COPY-FALLBACK');
    assert.equal(currentFileMatchesIdentity(destinationPath, identity), true);

    fs.writeFileSync(sourcePath, 'MUST-NOT-CLOBBER');
    assert.throws(
      () => moveFileNoClobber(sourcePath, destinationPath),
      /目标文件已存在，未覆盖/
    );
    assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'COPY-FALLBACK');
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

test('最终模板必须严格为固定5-sheet顺序和21/31/31/16/14表头', async () => {
  const workbook = await loadTemplateWorkbook(templatePath);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
  assert.deepEqual(TEMPLATE_SHEETS.map((item) => item.headers.length), [21, 31, 31, 16, 14]);
});

test('真实 asset 已升级为最终5-sheet契约', async () => {
  const realAsset = path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx');
  const workbook = await loadTemplateWorkbook(realAsset);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
  assert.deepEqual(
    workbook.worksheets.map((worksheet) => worksheet.getRow(1).cellCount),
    [21, 31, 31, 16, 14]
  );
  const unbalancedSheet = workbook.getWorksheet('不平结果');
  assert.equal(unbalancedSheet.getCell('F1').value, 'FundType');
  assert.equal(unbalancedSheet.getColumn('F').width, unbalancedSheet.getColumn('E').width);
  assert.equal(unbalancedSheet.getColumn('F').width, unbalancedSheet.getColumn('G').width);
  assert.deepEqual(unbalancedSheet.getCell('F1').style, unbalancedSheet.getCell('E1').style);
  assert.deepEqual(unbalancedSheet.getCell('F1').style, unbalancedSheet.getCell('G1').style);
  assert.equal(unbalancedSheet.autoFilter, undefined, '原模板没有自动筛选，新增列不得擅自增加');
  assert.equal(
    unbalancedSheet.views.some((view) => view.state === 'frozen'),
    false,
    '原模板没有冻结视图，新增列不得擅自增加'
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
  assert.deepEqual(rowValues(workbook.getWorksheet('不平结果'), 2, 21), projectValues(TEMPLATE_SHEETS[0].headers, unbalanced));
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

test('有重复时末尾动态追加22列第6 sheet，无银行行的重复专属渠道前5 sheet仅表头', async () => {
  const duplicateRows = [
    mappedRow(DUPLICATE_GATEWAY_HEADERS, 'KEEP'),
    mappedRow(DUPLICATE_GATEWAY_HEADERS, 'FOLDED')
  ];
  const result = await writeChannelWorkbook({
    templatePath,
    outputDirectory: path.join(tempDir, 'duplicate-only'),
    channel: 'DUP-ONLY',
    exportDate: new Date(2026, 6, 10),
    unbalancedRows: [],
    balancedRows: [],
    channelBillRows: [],
    hasDuplicateRecords: true,
    duplicateRows: (function* rows() { yield* duplicateRows; }())
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePath);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), [
    ...SHEET_NAMES,
    DUPLICATE_SHEET_NAME
  ]);
  for (const name of SHEET_NAMES) assert.equal(workbook.getWorksheet(name).rowCount, 1, name);
  const duplicateSheet = workbook.getWorksheet(DUPLICATE_SHEET_NAME);
  assert.deepEqual(rowValues(duplicateSheet, 1, 22), DUPLICATE_GATEWAY_HEADERS);
  assert.deepEqual(rowValues(duplicateSheet, 2, 22), projectValues(DUPLICATE_GATEWAY_HEADERS, duplicateRows[0]));
  assert.deepEqual(rowValues(duplicateSheet, 3, 22), projectValues(DUPLICATE_GATEWAY_HEADERS, duplicateRows[1]));
  assert.equal(result.rowCounts.duplicateGateway, 2);
});

test('无重复时即使传入空重复 iterable 仍保持5 sheet', async () => {
  const result = await writeChannelWorkbook({
    templatePath,
    outputDirectory: path.join(tempDir, 'no-duplicate'),
    channel: 'NORMAL',
    unbalancedRows: [],
    balancedRows: [],
    channelBillRows: [],
    hasDuplicateRecords: false,
    duplicateRows: (function* rows() { throw new Error('不应消费'); }())
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(result.filePath);
  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), SHEET_NAMES);
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

test('目标文件在生成期间被外部创建时不覆盖且清理临时文件', async () => {
  const outputDirectory = path.join(tempDir, 'external-conflict');
  const exportDate = new Date(2026, 6, 10);
  const expectedPath = path.join(outputDirectory, buildChannelFileName('RACE', exportDate));
  fs.mkdirSync(outputDirectory, { recursive: true });

  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = (sourcePath, destinationPath) => {
    if (!injected && destinationPath === expectedPath) {
      injected = true;
      fs.writeFileSync(expectedPath, 'EXTERNAL-CONTENT');
    }
    return originalLinkSync(sourcePath, destinationPath);
  };
  try {
    await assert.rejects(
      () => writeChannelWorkbook({
        templatePath,
        outputDirectory,
        channel: 'RACE',
        exportDate,
        unbalancedRows: [],
        balancedRows: [],
        channelBillRows: []
      }),
      /目标文件已存在，未覆盖/
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(fs.readFileSync(expectedPath, 'utf8'), 'EXTERNAL-CONTENT');
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

test('单 sheet 数据行超过 Excel 上限时显式失败', () => {
  assert.equal(EXCEL_MAX_DATA_ROWS, 1048575);
  assert.doesNotThrow(() => assertExcelDataRowCapacity(EXCEL_MAX_DATA_ROWS, '重复网关账单'));
  assert.throws(
    () => assertExcelDataRowCapacity(EXCEL_MAX_DATA_ROWS + 1, '重复网关账单'),
    /重复网关账单数据行超过 Excel 单 sheet 上限 1048575 行/
  );
});
