'use strict';

const ExcelJS = require('exceljs');
const fs = require('node:fs');
const path = require('node:path');

const {
  GATEWAY_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY
} = require('../../constants/gateway-bill-recon-fields');
const { sanitizeFileName } = require('../recon-id-fix-io');
const { trimCell } = require('./bank-row');
const {
  UNBALANCED_HEADERS,
  BALANCED_HEADERS,
  CHANNEL_BILL_HEADERS,
  projectOutputRow
} = require('./output-mapper');

const SHEET_NAMES = Object.freeze([
  '不平结果',
  '平账结果',
  '网关账单',
  '渠道账单',
  '订单修复'
]);

const TEMPLATE_SHEETS = Object.freeze([
  Object.freeze({ name: SHEET_NAMES[0], headers: UNBALANCED_HEADERS }),
  Object.freeze({ name: SHEET_NAMES[1], headers: BALANCED_HEADERS }),
  Object.freeze({ name: SHEET_NAMES[2], headers: GATEWAY_BILL_FIELDS }),
  Object.freeze({ name: SHEET_NAMES[3], headers: CHANNEL_BILL_HEADERS }),
  Object.freeze({ name: SHEET_NAMES[4], headers: ORDER_REPAIR_FIELDS_GATEWAY })
]);

const WATERMARK_AUTHOR = 'pzhong';

class PreFundTemplateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PreFundTemplateError';
    this.code = details.code || 'pre-fund-export-template-invalid';
    Object.assign(this, details);
  }
}

function clonePlain(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function headerValues(worksheet, width) {
  const row = worksheet.getRow(1);
  const values = [];
  for (let index = 1; index <= width; index += 1) {
    const value = row.getCell(index).value;
    values.push(value === null || value === undefined ? '' : String(value));
  }
  return values;
}

function templateStructureMessage(actualNames) {
  return `资金对账导出模板结构不兼容：应为5个sheet且顺序固定为「${SHEET_NAMES.join('、')}」，实际为「${actualNames.join('、') || '无sheet'}」。当前旧4-sheet模板不可直接用于3.0.14导出，请更新 assets/资金对账导出不平.xlsx。`;
}

function validateTemplateWorkbook(workbook, templatePath = '') {
  const actualNames = workbook.worksheets.map((worksheet) => worksheet.name);
  if (
    actualNames.length !== SHEET_NAMES.length
    || actualNames.some((name, index) => name !== SHEET_NAMES[index])
  ) {
    throw new PreFundTemplateError(templateStructureMessage(actualNames), {
      code: 'pre-fund-export-template-sheet-structure',
      templatePath,
      expectedSheetNames: SHEET_NAMES.slice(),
      actualSheetNames: actualNames
    });
  }

  for (const contract of TEMPLATE_SHEETS) {
    const worksheet = workbook.getWorksheet(contract.name);
    const actualHeaders = headerValues(worksheet, contract.headers.length);
    const extraHeaderValues = [];
    const physicalWidth = Math.max(worksheet.columnCount, worksheet.getRow(1).cellCount);
    for (let index = contract.headers.length + 1; index <= physicalWidth; index += 1) {
      const value = worksheet.getRow(1).getCell(index).value;
      if (value !== null && value !== undefined && String(value) !== '') {
        extraHeaderValues.push(String(value));
      }
    }
    const mismatchAt = contract.headers.findIndex((header, index) => actualHeaders[index] !== header);
    if (mismatchAt !== -1 || extraHeaderValues.length > 0) {
      const expected = contract.headers;
      const detail = mismatchAt === -1
        ? `存在多余表头：${extraHeaderValues.join('、')}`
        : `第${mismatchAt + 1}列应为「${expected[mismatchAt]}」，实际为「${actualHeaders[mismatchAt]}」`;
      throw new PreFundTemplateError(
        `资金对账导出模板「${contract.name}」表头不兼容：${detail}；要求固定${expected.length}列。`,
        {
          code: 'pre-fund-export-template-header-mismatch',
          templatePath,
          sheetName: contract.name,
          expectedHeaders: expected.slice(),
          actualHeaders
        }
      );
    }
  }
  return workbook;
}

async function loadTemplateWorkbook(templatePath) {
  if (!templatePath || typeof templatePath !== 'string') {
    throw new PreFundTemplateError('前置资金对账导出必须提供5-sheet模板路径', {
      code: 'pre-fund-export-template-path-required'
    });
  }
  if (!fs.existsSync(templatePath)) {
    throw new PreFundTemplateError(`资金对账导出模板不存在：${templatePath}`, {
      code: 'pre-fund-export-template-not-found',
      templatePath
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(templatePath);
  } catch (error) {
    throw new PreFundTemplateError(`无法读取资金对账导出模板「${templatePath}」：${error.message}`, {
      code: 'pre-fund-export-template-read-failed',
      templatePath,
      cause: error
    });
  }
  return validateTemplateWorkbook(workbook, templatePath);
}

function formatLocalExportDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`导出日期无效：${String(value)}`);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}年${month}月${day}日`;
}

function buildChannelFileName(channelName, exportDate = new Date()) {
  const displayChannel = trimCell(channelName) || '空渠道';
  const safeChannel = sanitizeFileName(displayChannel, 100);
  return `资金对账不平_${safeChannel}_${formatLocalExportDate(exportDate)}.xlsx`;
}

function copyWorksheetShell(streamingWorkbook, sourceWorksheet, contract) {
  const worksheet = streamingWorkbook.addWorksheet(contract.name, {
    properties: clonePlain(sourceWorksheet.properties) || {},
    pageSetup: clonePlain(sourceWorksheet.pageSetup) || {},
    views: clonePlain(sourceWorksheet.views) || [],
    headerFooter: clonePlain(sourceWorksheet.headerFooter) || {},
    state: sourceWorksheet.state
  });

  worksheet.columns = contract.headers.map((_header, index) => {
    const sourceColumn = sourceWorksheet.getColumn(index + 1);
    return {
      width: sourceColumn.width,
      hidden: sourceColumn.hidden,
      outlineLevel: sourceColumn.outlineLevel,
      style: clonePlain(sourceColumn.style) || {}
    };
  });

  if (sourceWorksheet.autoFilter) worksheet.autoFilter = clonePlain(sourceWorksheet.autoFilter);

  const sourceHeader = sourceWorksheet.getRow(1);
  const targetHeader = worksheet.addRow(contract.headers.slice());
  targetHeader.height = sourceHeader.height;
  targetHeader.hidden = sourceHeader.hidden;
  targetHeader.outlineLevel = sourceHeader.outlineLevel;
  for (let index = 1; index <= contract.headers.length; index += 1) {
    const sourceCell = sourceHeader.getCell(index);
    const targetCell = targetHeader.getCell(index);
    targetCell.style = clonePlain(sourceCell.style) || {};
    if (sourceCell.note) targetCell.note = clonePlain(sourceCell.note);
  }
  targetHeader.commit();
  return worksheet;
}

function assertRowsIterable(rows, label) {
  if (rows === null || rows === undefined) return [];
  if (
    typeof rows[Symbol.iterator] !== 'function'
    && typeof rows[Symbol.asyncIterator] !== 'function'
  ) {
    throw new TypeError(`${label}必须是同步或异步 iterable`);
  }
  return rows;
}

async function appendRows(worksheet, headers, rows, label) {
  let count = 0;
  try {
    for await (const sourceRow of assertRowsIterable(rows, label)) {
      const values = projectOutputRow(headers, sourceRow);
      worksheet.addRow(values).commit();
      count += 1;
    }
  } catch (error) {
    throw new Error(`${label}写入第${count + 1}条数据时失败：${error.message}`, { cause: error });
  }
  return count;
}

function makeTemporaryPath(finalPath) {
  const directory = path.dirname(finalPath);
  const baseName = path.basename(finalPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(directory, `.${baseName}.${nonce}.tmp.xlsx`);
}

async function writeWithTemplate({
  templateWorkbook,
  finalPath,
  unbalancedRows,
  balancedRows,
  channelBillRows
}) {
  const temporaryPath = makeTemporaryPath(finalPath);
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: temporaryPath,
    useStyles: true,
    useSharedStrings: false
  });
  writer.creator = templateWorkbook.creator || WATERMARK_AUTHOR;
  writer.lastModifiedBy = WATERMARK_AUTHOR;

  try {
    const sheets = new Map();
    for (const contract of TEMPLATE_SHEETS) {
      sheets.set(
        contract.name,
        copyWorksheetShell(writer, templateWorkbook.getWorksheet(contract.name), contract)
      );
    }

    const unbalancedCount = await appendRows(
      sheets.get(SHEET_NAMES[0]),
      UNBALANCED_HEADERS,
      unbalancedRows || [],
      '不平结果'
    );
    const balancedCount = await appendRows(
      sheets.get(SHEET_NAMES[1]),
      BALANCED_HEADERS,
      balancedRows || [],
      '平账结果'
    );
    const channelBillCount = await appendRows(
      sheets.get(SHEET_NAMES[3]),
      CHANNEL_BILL_HEADERS,
      channelBillRows || [],
      '渠道账单'
    );

    if (channelBillCount !== unbalancedCount) {
      throw new Error(`渠道账单${channelBillCount}行与不平结果${unbalancedCount}行不守恒`);
    }

    for (const worksheet of sheets.values()) worksheet.commit();
    await writer.commit();
    fs.renameSync(temporaryPath, finalPath);

    return {
      filePath: finalPath,
      fileName: path.basename(finalPath),
      channel: null,
      rowCounts: {
        unbalanced: unbalancedCount,
        balanced: balancedCount,
        gatewayBill: 0,
        channelBill: channelBillCount,
        orderRepair: 0
      }
    };
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
    }
    throw new Error(`前置资金对账Excel写入失败（${finalPath}）：${error.message}`, { cause: error });
  }
}

async function writeChannelWorkbook(options = {}) {
  const templateWorkbook = options.templateWorkbook
    || await loadTemplateWorkbook(options.templatePath);
  const channel = options.channelName ?? options.channel;
  const fileName = options.outputPath
    ? path.basename(options.outputPath)
    : buildChannelFileName(channel, options.exportDate || new Date());
  const finalPath = options.outputPath
    ? path.resolve(options.outputPath)
    : path.join(path.resolve(options.outputDirectory || ''), fileName);

  if (!options.outputPath && !options.outputDirectory) {
    throw new TypeError('前置资金对账导出必须提供 outputDirectory 或 outputPath');
  }
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  const result = await writeWithTemplate({
    templateWorkbook,
    finalPath,
    unbalancedRows: options.unbalancedRows || [],
    balancedRows: options.balancedRows || [],
    channelBillRows: options.channelBillRows || []
  });
  result.channel = trimCell(channel);
  return result;
}

/**
 * 顺序消费逐渠道 iterable；任一时刻只打开一个输出 workbook。
 * channelExports 可直接接 side DB 的逐渠道游标，不要求全量数组。
 */
async function writeChannelWorkbooks(options = {}) {
  const templateWorkbook = await loadTemplateWorkbook(options.templatePath);
  const outputDirectory = options.outputDirectory;
  if (!outputDirectory || typeof outputDirectory !== 'string') {
    throw new TypeError('前置资金对账批量导出必须提供 outputDirectory');
  }

  const results = [];
  const usedPaths = new Set();
  for await (const channelExport of assertRowsIterable(options.channelExports, 'channelExports')) {
    const channel = channelExport && (channelExport.channelName ?? channelExport.channel);
    const fileName = buildChannelFileName(channel, options.exportDate || new Date());
    const finalPath = path.join(path.resolve(outputDirectory), fileName);
    const normalizedPath = process.platform === 'win32' ? finalPath.toLowerCase() : finalPath;
    if (usedPaths.has(normalizedPath)) {
      throw new Error(`渠道文件名冲突：渠道「${trimCell(channel)}」清洗后重复生成 ${fileName}`);
    }
    usedPaths.add(normalizedPath);

    results.push(await writeChannelWorkbook({
      templateWorkbook,
      outputPath: finalPath,
      channel,
      unbalancedRows: channelExport.unbalancedRows || [],
      balancedRows: channelExport.balancedRows || [],
      channelBillRows: channelExport.channelBillRows || []
    }));
  }
  return results;
}

module.exports = {
  SHEET_NAMES,
  TEMPLATE_SHEETS,
  PreFundTemplateError,
  formatLocalExportDate,
  buildChannelFileName,
  validateTemplateWorkbook,
  loadTemplateWorkbook,
  writeChannelWorkbook,
  writeChannelWorkbooks
};
