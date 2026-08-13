'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { SUPPORTED_CURRENCIES } = require('./definitions');

const RESULT_TEMPLATE_FILE_NAME = 'VCC财务OP校验结果表_模板.xlsx';
const RESULT_TEMPLATE_SHEET_NAME = '财务OP校验结果表';
const RESULT_TEMPLATE_FILE_SHA256 = '48c8161484128e63a6e3e60724336f2433a8f23687695d980720c59a9dec2053';
const RESULT_TEMPLATE_BUSINESS_RANGE = 'A1:N45';
const RESULT_TEMPLATE_PHYSICAL_RANGE = 'A1:N51';
const RESULT_TEMPLATE_PRINT_AREA = 'A1:L45';
const RESULT_TEMPLATE_HEADERS = Object.freeze([
  '主体', '大类', '分类', ...SUPPORTED_CURRENCIES, '调整值', '调整原因'
]);

const ANCHOR_DEFINITIONS = Object.freeze({
  opening: Object.freeze({ label: '上月财务OP', matches: (sheet, row) => (
    cellText(sheet, row, 2).startsWith('上月财务OP') && isMergedPair(sheet, row, 2, 3)
  ) }),
  classified: Object.freeze({ label: '有分类业务行', matches: (sheet, row) => (
    cellText(sheet, row, 2) === 'VCC_discharge'
      && cellText(sheet, row, 3) === 'B2B'
      && !isMergedPair(sheet, row, 2, 3)
  ) }),
  unclassified: Object.freeze({ label: '无分类业务行', matches: (sheet, row) => (
    cellText(sheet, row, 2) === 'VCC_ATMBalance_Inquiry_Fee'
      && isMergedPair(sheet, row, 2, 3)
  ) }),
  channel: Object.freeze({ label: '通道行', matches: (sheet, row) => (
    cellText(sheet, row, 2) === 'DISCOVER-UK'
      && cellText(sheet, row, 3) === 'TRIBE'
      && !isMergedPair(sheet, row, 2, 3)
  ) }),
  pending: Object.freeze({ label: '当月移除pending', matches: (sheet, row) => (
    cellText(sheet, row, 2).startsWith('当月移除pending') && isMergedPair(sheet, row, 2, 3)
  ) }),
  calculated: Object.freeze({ label: '当月计算财务OP', matches: (sheet, row) => (
    cellText(sheet, row, 2).startsWith('当月计算财务OP') && isMergedPair(sheet, row, 2, 3)
  ) }),
  system: Object.freeze({ label: '当月系统财务OP', matches: (sheet, row) => (
    cellText(sheet, row, 2).startsWith('当月系统财务OP') && isMergedPair(sheet, row, 2, 3)
  ) }),
  difference: Object.freeze({ label: '差异', matches: (sheet, row) => (
    cellText(sheet, row, 2) === '差异' && isMergedPair(sheet, row, 2, 3)
  ) })
});

const contractCache = new Map();

class ResultTemplateContractError extends Error {
  constructor(code, message, { templatePath, detailLines = [] } = {}) {
    super(message);
    this.name = 'ResultTemplateContractError';
    this.code = code;
    this.templatePath = templatePath || '';
    this.detailLines = detailLines;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function cellText(sheet, rowNumber, columnNumber) {
  const cell = sheet.getCell(rowNumber, columnNumber);
  if (typeof cell.text === 'string' && cell.text !== '[object Object]') return cell.text.trim();
  const value = cell.value;
  if (value && Array.isArray(value.richText)) {
    return value.richText.map((part) => String(part.text || '')).join('').trim();
  }
  return String(value == null ? '' : value).trim();
}

function isMergedPair(sheet, rowNumber, startColumn, endColumn) {
  const startCell = sheet.getCell(rowNumber, startColumn);
  const endCell = sheet.getCell(rowNumber, endColumn);
  return startCell.isMerged
    && endCell.isMerged
    && startCell.master.address === endCell.master.address;
}

function isNonEmptyObject(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function captureCellStyle(cell) {
  return {
    style: deepClone(cell.style || {}),
    numFmt: cell.numFmt || 'General'
  };
}

function captureRowStyle(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber);
  return {
    height: row.height == null ? null : row.height,
    hidden: Boolean(row.hidden),
    outlineLevel: row.outlineLevel || 0,
    cells: Array.from({ length: RESULT_TEMPLATE_HEADERS.length }, (_, index) => (
      captureCellStyle(sheet.getCell(rowNumber, index + 1))
    )),
    mergeMajorMinor: isMergedPair(sheet, rowNumber, 2, 3)
  };
}

function captureColumnLayout(sheet) {
  return Array.from({ length: RESULT_TEMPLATE_HEADERS.length }, (_, index) => {
    const column = sheet.getColumn(index + 1);
    return {
      width: column.width == null ? null : column.width,
      hidden: Boolean(column.hidden),
      outlineLevel: column.outlineLevel || 0,
      style: deepClone(column.style || {})
    };
  });
}

function contractMismatch(templatePath, detailLines) {
  throw new ResultTemplateContractError(
    'result-template-contract-mismatch',
    '结果模板结构与契约不一致，未生成文件。',
    {
      templatePath,
      detailLines: [
        `请使用 assets/VCC财务OP校验/${RESULT_TEMPLATE_FILE_NAME}`,
        ...detailLines
      ]
    }
  );
}

function locateUniqueAnchor(sheet, definition, templatePath, detailLines) {
  const rows = [];
  for (let rowNumber = 2; rowNumber <= 45; rowNumber++) {
    if (definition.matches(sheet, rowNumber)) rows.push(rowNumber);
  }
  if (rows.length !== 1) {
    detailLines.push(`语义锚点“${definition.label}”应唯一，实际匹配 ${rows.length} 行`);
    return null;
  }
  return rows[0];
}

function inspectResultTemplateWorkbook(workbook, { templatePath = '' } = {}) {
  const matchingSheets = workbook.worksheets.filter((sheet) => sheet.name === RESULT_TEMPLATE_SHEET_NAME);
  if (matchingSheets.length !== 1) {
    contractMismatch(templatePath, [
      `目标 sheet“${RESULT_TEMPLATE_SHEET_NAME}”应唯一，实际为 ${matchingSheets.length} 张`
    ]);
  }
  const sheet = matchingSheets[0];
  const detailLines = [];
  const headers = RESULT_TEMPLATE_HEADERS.map((_, index) => cellText(sheet, 1, index + 1));
  if (stableJson(headers) !== stableJson(RESULT_TEMPLATE_HEADERS)) {
    detailLines.push(`第 1 行必须严格为 14 列：${RESULT_TEMPLATE_HEADERS.join('、')}`);
  }
  if (sheet.actualRowCount !== 45 || sheet.actualColumnCount !== 14) {
    detailLines.push(`业务有效区应为 ${RESULT_TEMPLATE_BUSINESS_RANGE}，实际有效行为 ${sheet.actualRowCount}、有效列为 ${sheet.actualColumnCount}`);
  }
  if (sheet.rowCount !== 51 || sheet.columnCount !== 14) {
    detailLines.push(`工作表物理区域应为 ${RESULT_TEMPLATE_PHYSICAL_RANGE}，实际行为 ${sheet.rowCount}、列为 ${sheet.columnCount}`);
  }
  for (let rowNumber = 46; rowNumber <= 51; rowNumber++) {
    const hasBusinessValue = Array.from({ length: 14 }, (_, index) => (
      sheet.getCell(rowNumber, index + 1).value
    )).some((value) => value != null && value !== '');
    if (hasBusinessValue) {
      detailLines.push(`第 ${rowNumber} 行只能保留空值/样式占位`);
      break;
    }
  }
  if (sheet.pageSetup.printArea !== RESULT_TEMPLATE_PRINT_AREA) {
    detailLines.push(`打印区域应为 ${RESULT_TEMPLATE_PRINT_AREA}，实际为 ${sheet.pageSetup.printArea || '（空）'}`);
  }
  if (!isMergedPair(sheet, 2, 1, 1) || !sheet.getCell('A2').isMerged
      || sheet.getCell('A2').master.address !== sheet.getCell('A45').master.address) {
    detailLines.push('主体列样式基线必须合并 A2:A45');
  }

  const anchorRows = {};
  for (const [key, definition] of Object.entries(ANCHOR_DEFINITIONS)) {
    anchorRows[key] = locateUniqueAnchor(sheet, definition, templatePath, detailLines);
  }

  const normalFill = deepClone(sheet.getCell('D1').fill);
  const abnormalFill = deepClone(sheet.getCell('E1').fill);
  if (!isNonEmptyObject(normalFill)) detailLines.push('正常币种填充锚点 D1 缺失');
  if (!isNonEmptyObject(abnormalFill)) detailLines.push('非正常币种填充锚点 E1 缺失');
  if (stableJson(normalFill) === stableJson(abnormalFill)) {
    detailLines.push('正常币种填充锚点 D1 与非正常锚点 E1 必须不同');
  }
  if (!isNonEmptyObject(sheet.getCell('D45').font) || !sheet.getCell('D45').numFmt) {
    detailLines.push('调整值样式锚点 D45 的字体或数值格式缺失');
  }
  if (!isNonEmptyObject(sheet.getCell('B45').font)) {
    detailLines.push('调整原因字体锚点 B45 缺失');
  }
  if (detailLines.length > 0) contractMismatch(templatePath, detailLines);

  const anchors = Object.fromEntries(Object.entries(anchorRows).map(([key, rowNumber]) => [
    key,
    { rowNumber, ...captureRowStyle(sheet, rowNumber) }
  ]));
  return {
    sheetName: RESULT_TEMPLATE_SHEET_NAME,
    headers: [...RESULT_TEMPLATE_HEADERS],
    businessRange: RESULT_TEMPLATE_BUSINESS_RANGE,
    physicalRange: RESULT_TEMPLATE_PHYSICAL_RANGE,
    printArea: RESULT_TEMPLATE_PRINT_AREA,
    printAreaRightColumn: 'L',
    columns: captureColumnLayout(sheet),
    headerRow: captureRowStyle(sheet, 1),
    anchors,
    normalFill,
    abnormalFill,
    adjustmentValueStyle: captureCellStyle(sheet.getCell('D45')),
    adjustmentReasonFont: deepClone(sheet.getCell('B45').font),
    adjustmentHeaderStyles: {
      value: captureCellStyle(sheet.getCell('M1')),
      reason: captureCellStyle(sheet.getCell('N1'))
    },
    views: deepClone(sheet.views || []),
    pageSetup: deepClone(sheet.pageSetup || {}),
    headerFooter: deepClone(sheet.headerFooter || {}),
    properties: deepClone(sheet.properties || {}),
    state: sheet.state,
    autoFilter: deepClone(sheet.autoFilter)
  };
}

function statIdentity(stat) {
  return [
    stat.dev, stat.ino, stat.size,
    stat.mtimeMs, stat.ctimeMs
  ].join(':');
}

async function readStableTemplate(templatePath) {
  let before;
  try {
    before = await fs.promises.stat(templatePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ResultTemplateContractError(
        'result-template-missing',
        `未找到 ${RESULT_TEMPLATE_FILE_NAME}，已停止导出。`,
        { templatePath, detailLines: [templatePath] }
      );
    }
    throw error;
  }
  if (!before.isFile()) {
    throw new ResultTemplateContractError(
      'result-template-missing',
      `未找到 ${RESULT_TEMPLATE_FILE_NAME}，已停止导出。`,
      { templatePath, detailLines: [templatePath] }
    );
  }
  const buffer = await fs.promises.readFile(templatePath);
  const after = await fs.promises.stat(templatePath);
  if (statIdentity(before) !== statIdentity(after)) {
    contractMismatch(templatePath, ['读取期间模板文件发生变化，请重试']);
  }
  return { buffer, identity: statIdentity(after), hash: sha256(buffer) };
}

async function loadResultTemplateContract({ templatePath } = {}) {
  const resolvedPath = path.resolve(String(templatePath || ''));
  const { buffer, identity, hash } = await readStableTemplate(resolvedPath);
  if (hash !== RESULT_TEMPLATE_FILE_SHA256) {
    contractMismatch(resolvedPath, [
      `模板 SHA-256 不一致：期望 ${RESULT_TEMPLATE_FILE_SHA256}，实际 ${hash}`
    ]);
  }
  const cacheKey = `${resolvedPath}:${identity}:${hash}`;
  const cached = contractCache.get(cacheKey);
  if (cached) return deepClone(cached);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    contractMismatch(resolvedPath, [`模板无法读取：${error.message}`]);
  }
  const contract = inspectResultTemplateWorkbook(workbook, { templatePath: resolvedPath });
  const cachedContract = {
    ...contract,
    templatePath: resolvedPath,
    fileSha256: hash,
    statIdentity: identity
  };
  contractCache.clear();
  contractCache.set(cacheKey, deepClone(cachedContract));
  return deepClone(cachedContract);
}

function clearResultTemplateContractCache() {
  contractCache.clear();
}

module.exports = {
  RESULT_TEMPLATE_FILE_NAME,
  RESULT_TEMPLATE_SHEET_NAME,
  RESULT_TEMPLATE_FILE_SHA256,
  RESULT_TEMPLATE_BUSINESS_RANGE,
  RESULT_TEMPLATE_PHYSICAL_RANGE,
  RESULT_TEMPLATE_PRINT_AREA,
  RESULT_TEMPLATE_HEADERS,
  ResultTemplateContractError,
  sha256,
  inspectResultTemplateWorkbook,
  loadResultTemplateContract,
  clearResultTemplateContractCache
};
