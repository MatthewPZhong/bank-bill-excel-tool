'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { FileValidationError } = require('../../backend/file-service/common');
const { BANK_STATEMENT_SHEET_NAME } = require('../bank-statement-io');
const { readXlsxSheetNames } = require('./document-statement-reader');

async function inspectSheetNames(filePath) {
  if (path.extname(filePath).toLowerCase() === '.xlsx') {
    return readXlsxSheetNames(filePath);
  }
  const workbook = XLSX.readFile(filePath, { bookSheets: true });
  return Array.isArray(workbook.SheetNames) ? workbook.SheetNames.slice() : [];
}

async function inspectDuplicateInputFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  let sheetNames;
  try {
    sheetNames = await inspectSheetNames(filePath);
  } catch (error) {
    if (error instanceof FileValidationError) throw error;
    throw new FileValidationError(
      'duplicate-inbound-input-unreadable',
      `文件无法读取：${path.basename(filePath)}`,
      { detailLines: [error && error.message ? error.message : String(error)] }
    );
  }
  return Object.freeze({
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    sheetNames: Object.freeze(sheetNames.map((value) => String(value))),
    isBank: sheetNames.includes(BANK_STATEMENT_SHEET_NAME)
  });
}

function resolveDuplicateInputFiles(inspected) {
  if (!Array.isArray(inspected) || inspected.length !== 2) {
    throw new FileValidationError(
      'duplicate-inbound-input-file-count',
      '请一次选择 1 份银行对账单和 1 份单据对账单（共 2 个文件）'
    );
  }
  const bankFiles = inspected.filter((file) => file && file.isBank === true);
  if (bankFiles.length !== 1) {
    throw new FileValidationError(
      'duplicate-inbound-input-type-ambiguous',
      '无法唯一识别银行对账单：两份文件中必须且只能有一份包含 sheet“渠道对账单”',
      {
        detailLines: inspected.map((file) =>
          `${file.fileName}：${file.sheetNames.join(' / ') || '无工作表'}`)
      }
    );
  }
  const bank = bankFiles[0];
  const document = inspected.find((file) => file !== bank);
  if (path.extname(document.filePath).toLowerCase() !== '.xlsx') {
    throw new FileValidationError(
      'duplicate-inbound-document-extension',
      '单据对账单只支持 .xlsx 文件'
    );
  }
  return Object.freeze({ bank, document });
}

async function identifyInputFiles(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length !== 2) {
    return resolveDuplicateInputFiles(filePaths);
  }
  return resolveDuplicateInputFiles(await Promise.all(
    filePaths.map((filePath) => inspectDuplicateInputFile(filePath))
  ));
}

module.exports = {
  identifyInputFiles,
  inspectDuplicateInputFile,
  inspectSheetNames,
  resolveDuplicateInputFiles
};
