'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');

const MAIL_SHEET_NAME = '邮件模板';
const MANUAL_SHEET_NAME = '匹配不成功需人工判定';
const MANUAL_REASON_HEADER = '人工判定原因';
const MAIL_HEADERS = Object.freeze([
  'BillDate',
  'Channel',
  'MerchantId',
  'Currency',
  'Debit Amount',
  '加款单号',
  '业务来源',
  '客户号',
  '账户号',
  '备注'
]);
const MAIL_DATA_NUMBER_FORMATS = Object.freeze({
  'Debit Amount': 'General',
  '加款单号': '@',
  '业务来源': '@',
  '客户号': '@',
  '账户号': '@',
  '备注': '@'
});
const EXCEL_MAX_ROWS = 1048576;

class DuplicateInboundExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DuplicateInboundExportError';
    this.code = code;
  }
}

function cloneStyle(value) {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}

function rowValues(worksheet, rowNumber, count) {
  const row = worksheet.getRow(rowNumber);
  return Array.from({ length: count }, (_unused, index) => {
    const value = row.getCell(index + 1).value;
    return value == null ? '' : String(value);
  });
}

function assertTemplateFile(filePath, label) {
  if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-template-missing',
      `${label}不存在：${filePath || '(未配置)'}`
    );
  }
}

function assertHeaders(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-template-header-mismatch',
      `${label}表头不符合约定：期望 ${expected.join(' / ')}，实际 ${actual.join(' / ')}`
    );
  }
}

function buildDefaultFileName(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('重复入金导出日期无效');
  const pad = (number) => String(number).padStart(2, '0');
  const yy = pad(date.getFullYear() % 100);
  return `${yy}${pad(date.getMonth() + 1)}${pad(date.getDate())}_重复入金召回邮件模板.xlsx`;
}

function assertOutputCapacity(mailCount, manualCount) {
  if (mailCount + 1 > EXCEL_MAX_ROWS) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-mail-row-limit',
      `邮件模板数据 ${mailCount} 行，超过 Excel 单 sheet 上限`
    );
  }
  if (manualCount + 1 > EXCEL_MAX_ROWS) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-manual-row-limit',
      `人工判定数据 ${manualCount} 行，超过 Excel 单 sheet 上限`
    );
  }
}

async function buildWorkbook({ mailTemplatePath, bankTemplatePath, mailRows, manualRows }) {
  assertTemplateFile(mailTemplatePath, '重复入金召回邮件模板');
  assertTemplateFile(bankTemplatePath, '银行对账单模板');
  assertOutputCapacity(mailRows.length, manualRows.length);

  const mailTemplateWorkbook = new ExcelJS.Workbook();
  await mailTemplateWorkbook.xlsx.readFile(mailTemplatePath);
  if (mailTemplateWorkbook.worksheets.length !== 1) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-mail-template-sheet-count',
      '重复入金召回邮件模板必须且只能包含一个 sheet'
    );
  }
  const mailTemplateSheet = mailTemplateWorkbook.worksheets[0];
  assertHeaders(rowValues(mailTemplateSheet, 1, MAIL_HEADERS.length), MAIL_HEADERS, '邮件模板');
  const headerStyles = MAIL_HEADERS.map((_header, index) => (
    cloneStyle(mailTemplateSheet.getRow(1).getCell(index + 1).style)
  ));
  const dataStyles = MAIL_HEADERS.map((_header, index) => (
    cloneStyle(mailTemplateSheet.getRow(2).getCell(index + 1).style)
  ));

  const workbook = new ExcelJS.Workbook();
  const mailSheet = workbook.addWorksheet(MAIL_SHEET_NAME);
  for (let index = 0; index < MAIL_HEADERS.length; index += 1) {
    mailSheet.getColumn(index + 1).width = mailTemplateSheet.getColumn(index + 1).width;
  }
  const mailHeaderRow = mailSheet.addRow(MAIL_HEADERS);
  mailHeaderRow.height = mailTemplateSheet.getRow(1).height;
  for (let index = 0; index < MAIL_HEADERS.length; index += 1) {
    mailHeaderRow.getCell(index + 1).style = cloneStyle(headerStyles[index]);
  }
  for (const source of mailRows) {
    const row = mailSheet.addRow(MAIL_HEADERS.map((header) => source[header] ?? ''));
    row.height = 18.75;
    for (let index = 0; index < MAIL_HEADERS.length; index += 1) {
      const cell = row.getCell(index + 1);
      cell.style = cloneStyle(dataStyles[index]);
      const numberFormat = MAIL_DATA_NUMBER_FORMATS[MAIL_HEADERS[index]];
      if (numberFormat) cell.numFmt = numberFormat;
    }
  }

  const bankWorkbook = new ExcelJS.Workbook();
  await bankWorkbook.xlsx.readFile(bankTemplatePath);
  const bankSheet = bankWorkbook.getWorksheet('渠道对账单');
  if (!bankSheet) {
    throw new DuplicateInboundExportError(
      'duplicate-inbound-bank-template-sheet-missing',
      '银行对账单模板缺少 sheet「渠道对账单」'
    );
  }
  assertHeaders(rowValues(bankSheet, 1, BANK_STATEMENT_FIELDS.length), BANK_STATEMENT_FIELDS, '银行对账单');

  const manualSheet = workbook.addWorksheet(MANUAL_SHEET_NAME);
  for (let index = 0; index < BANK_STATEMENT_FIELDS.length; index += 1) {
    const sourceColumn = bankSheet.getColumn(index + 1);
    manualSheet.getColumn(index + 1).width = sourceColumn.width;
  }
  manualSheet.getColumn(BANK_STATEMENT_FIELDS.length + 1).width = 36;
  const headerRow = manualSheet.addRow([...BANK_STATEMENT_FIELDS, MANUAL_REASON_HEADER]);
  for (let index = 0; index < BANK_STATEMENT_FIELDS.length; index += 1) {
    headerRow.getCell(index + 1).style = cloneStyle(bankSheet.getRow(1).getCell(index + 1).style);
  }
  headerRow.getCell(BANK_STATEMENT_FIELDS.length + 1).style = cloneStyle(
    bankSheet.getRow(1).getCell(BANK_STATEMENT_FIELDS.length).style
  );
  for (const item of manualRows) {
    manualSheet.addRow([
      ...BANK_STATEMENT_FIELDS.map((field) => item.row[field] ?? ''),
      item.reason || ''
    ]);
  }
  return workbook;
}

function moveTempIntoPlace(tempPath, targetPath) {
  const backupPath = `${targetPath}.backup-${crypto.randomUUID()}`;
  const targetExists = fs.existsSync(targetPath);
  let backupCreated = false;
  const warnings = [];
  try {
    if (targetExists) {
      fs.renameSync(targetPath, backupPath);
      backupCreated = true;
    }
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    if (backupCreated && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
      try {
        fs.renameSync(backupPath, targetPath);
      } catch (restoreError) {
        throw new Error(
          `${error.message || error}；原文件恢复失败，备份保留在 ${backupPath}：${restoreError.message || restoreError}`,
          { cause: error }
        );
      }
    }
    throw error;
  }
  if (backupCreated) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch (error) {
      warnings.push(`新文件已导出，但旧文件备份未能删除：${backupPath}（${error.message || error}）`);
    }
  }
  return warnings;
}

async function writeDuplicateInboundWorkbook({
  mailTemplatePath,
  bankTemplatePath,
  savePath,
  mailRows = [],
  manualRows = []
}) {
  if (!savePath || typeof savePath !== 'string') {
    throw new TypeError('重复入金导出 savePath 必填');
  }
  const workbook = await buildWorkbook({ mailTemplatePath, bankTemplatePath, mailRows, manualRows });
  const targetPath = path.resolve(savePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    await workbook.xlsx.writeFile(tempPath);
    const warnings = moveTempIntoPlace(tempPath, targetPath);
    return {
      status: 'success',
      filePath: targetPath,
      fileName: path.basename(targetPath),
      mailRowCount: mailRows.length,
      manualRowCount: manualRows.length,
      warnings
    };
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

module.exports = {
  MAIL_HEADERS,
  MAIL_SHEET_NAME,
  MANUAL_REASON_HEADER,
  MANUAL_SHEET_NAME,
  DuplicateInboundExportError,
  buildDefaultFileName,
  buildWorkbook,
  writeDuplicateInboundWorkbook
};
