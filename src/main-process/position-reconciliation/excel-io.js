'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const {
  POSITION_BANK_HEADERS,
  AUDIT_HEADERS,
  BANK_SHEET_NAME,
  LINK_HEADERS,
  SOURCE_DEFINITIONS
} = require('./constants');
const {
  PositionReconciliationError,
  text,
  isBlankRow
} = require('./common');
const { normalizeHeaderRow, headersEqual, rowValues } = require('./readers');

const EXCEL_MAX_ROWS = 1048576;
const TEXT_HEADERS = new Set([
  'BizId', 'MerchantId', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef',
  'Payee CardNo', 'Drawee CardNo', 'ReconID', '调拨单号', '付款单号', '业务单号',
  'bizId', '银行账号', '系统账号', '银行卡号', '账户号', '客户编号'
]);
const TEXT_HEADER_PATTERN = /id|no|code|账号|账户|卡号|单号|流水号|对账|批次号|清算号码|swift/i;

function ensureOutputPath(outputPath) {
  if (!outputPath || path.extname(outputPath).toLowerCase() !== '.xlsx') {
    throw new PositionReconciliationError('position-output-path-invalid', '导出路径必须为 .xlsx 文件');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

async function atomicWorkbookWrite(workbook, outputPath) {
  ensureOutputPath(outputPath);
  const token = crypto.randomUUID();
  const temporaryPath = `${outputPath}.${token}.tmp`;
  const backupPath = `${outputPath}.${token}.bak`;
  let backedUp = false;
  try {
    await workbook.xlsx.writeFile(temporaryPath);
    if (fs.existsSync(outputPath)) {
      fs.renameSync(outputPath, backupPath);
      backedUp = true;
    }
    fs.renameSync(temporaryPath, outputPath);
    if (backedUp && fs.existsSync(backupPath)) {
      try {
        fs.unlinkSync(backupPath);
      } catch (_cleanupError) {
        // 新文件已原子发布；旧备份清理失败不能把成功导出误报为失败。
      }
    }
    return outputPath;
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (_cleanupError) {
        // 临时文件清理失败不能阻止下方恢复用户原有文件。
      }
    }
    if (backedUp && fs.existsSync(backupPath) && !fs.existsSync(outputPath)) {
      try {
        fs.renameSync(backupPath, outputPath);
      } catch (restoreError) {
        error.restoreError = restoreError;
        error.detailLines = [
          ...(Array.isArray(error.detailLines) ? error.detailLines : []),
          `旧文件自动恢复失败，备份仍保留在：${backupPath}`,
          restoreError && restoreError.message ? restoreError.message : String(restoreError)
        ];
      }
    }
    throw error;
  }
}

function assertHeaderRow(sheet, headers) {
  const actual = [];
  for (let index = 1; index <= headers.length; index += 1) {
    actual.push(text(sheet.getCell(1, index).value));
  }
  if (!headersEqual(actual, headers)) {
    throw new PositionReconciliationError(
      'position-template-header-invalid',
      `模板表头不符合契约：${sheet.name}`,
      [`期望：${headers.join(' / ')}`, `实际：${actual.join(' / ')}`]
    );
  }
}

function requiresTextFormat(header) {
  return TEXT_HEADERS.has(header) || TEXT_HEADER_PATTERN.test(String(header || ''));
}

function applyTextColumnFormats(sheet, headers) {
  headers.forEach((header, index) => {
    if (requiresTextFormat(header)) sheet.getColumn(index + 1).numFmt = '@';
  });
}

function applyTextFormats(row, headers) {
  headers.forEach((header, index) => {
    if (requiresTextFormat(header)) row.getCell(index + 1).numFmt = '@';
  });
}

async function writeResultWorkbook({
  templatePath,
  outputPath,
  rows,
  highlightChanged = true
}) {
  if (!fs.existsSync(templatePath)) {
    throw new PositionReconciliationError('position-template-missing', `结果模板不存在：${templatePath}`);
  }
  if (rows.length > EXCEL_MAX_ROWS - 1) {
    throw new PositionReconciliationError('position-result-too-large', '结果超过 Excel 单 sheet 行数上限');
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  const sheet = workbook.getWorksheet(BANK_SHEET_NAME);
  if (!sheet) {
    throw new PositionReconciliationError(
      'position-template-sheet-missing',
      `结果模板缺少 sheet「${BANK_SHEET_NAME}」`
    );
  }
  assertHeaderRow(sheet, POSITION_BANK_HEADERS);
  if (sheet.rowCount > 1) sheet.spliceRows(2, sheet.rowCount - 1);
  applyTextColumnFormats(sheet, POSITION_BANK_HEADERS);
  const fundTypeColumn = POSITION_BANK_HEADERS.indexOf('FundType') + 1;
  for (const item of rows) {
    const result = item.resultRow || item;
    const values = POSITION_BANK_HEADERS.map((header) => {
      if (header === '命中明细') return item.hit_summary ?? item.hitSummary ?? result[header] ?? '';
      if (header === '命中类型') return item.hit_type ?? item.hitType ?? result[header] ?? '';
      if (header === '匹配命中详情') return item.match_detail ?? item.matchDetail ?? result[header] ?? '';
      return result[header] ?? '';
    });
    const excelRow = sheet.addRow(values);
    applyTextFormats(excelRow, POSITION_BANK_HEADERS);
    if (highlightChanged && Boolean(item.changed)) {
      excelRow.getCell(fundTypeColumn).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFFF00' }
      };
    }
  }
  return atomicWorkbookWrite(workbook, outputPath);
}

async function writeTableWorkbook({ outputPath, sheetName, headers, rows }) {
  if (rows.length > EXCEL_MAX_ROWS - 1) {
    throw new PositionReconciliationError('position-export-too-large', '导出数据超过 Excel 单 sheet 行数上限');
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = Math.min(36, Math.max(14, String(header).length * 2 + 4));
  });
  applyTextColumnFormats(sheet, headers);
  for (const source of rows) {
    const values = headers.map((header) => source[header] ?? '');
    const row = sheet.addRow(values);
    applyTextFormats(row, headers);
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };
  return atomicWorkbookWrite(workbook, outputPath);
}

async function writeLinkedWorkbook({ outputPath, sourceType, rows }) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  if (!definition) throw new Error('未知链接表类型');
  return writeTableWorkbook({
    outputPath,
    sheetName: definition.linkedName,
    headers: LINK_HEADERS[sourceType],
    rows
  });
}

async function writeRawWorkbook({ outputPath, sourceType, rows }) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  if (!definition) throw new Error('未知原始表类型');
  return writeTableWorkbook({
    outputPath,
    sheetName: definition.sourceName,
    headers: definition.headers,
    rows
  });
}

function readResultWorkbook(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new PositionReconciliationError('position-result-file-missing', '回导结果文件不存在');
  }
  const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true });
  const sheet = workbook.Sheets[BANK_SHEET_NAME];
  if (!sheet) {
    throw new PositionReconciliationError(
      'position-result-sheet-missing',
      `回导文件缺少 sheet「${BANK_SHEET_NAME}」`
    );
  }
  const rows = rowValues(sheet);
  const headers = normalizeHeaderRow(rows[0]);
  if (!headersEqual(headers, POSITION_BANK_HEADERS)) {
    throw new PositionReconciliationError(
      'position-result-headers-invalid',
      '回导结果表头不符合固定 49 列契约',
      [`实际表头：${headers.join(' / ')}`]
    );
  }
  const result = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = {};
    POSITION_BANK_HEADERS.forEach((header, columnIndex) => {
      row[header] = rows[index][columnIndex] ?? '';
    });
    if (isBlankRow(row, POSITION_BANK_HEADERS)) continue;
    result.push({ row, excelRowNumber: index + 1 });
  }
  return {
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    rows: result
  };
}

module.exports = {
  writeResultWorkbook,
  writeTableWorkbook,
  writeLinkedWorkbook,
  writeRawWorkbook,
  readResultWorkbook,
  atomicWorkbookWrite,
  requiresTextFormat
};
