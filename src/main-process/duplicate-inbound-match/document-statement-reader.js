'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sax = require('sax');

const { FileValidationError } = require('../../backend/file-service/common');
const { BILL_HEADERS } = require('../../backend/acquiring-bill-currency-db/columns');
const {
  openZipWithEntries,
  loadSharedStrings,
  SHEET_ENTRY_NAME,
  SHARED_STRINGS_ENTRY_NAME
} = require('../../backend/acquiring-bill-currency-import/reader');
const {
  streamSheetRowsHandRolled
} = require('../../backend/acquiring-bill-currency-import/reader-handrolled');

const DOCUMENT_FIELDS = Object.freeze({
  businessOrderNo: '业务订单号',
  userNo: '用户编号',
  accountNo: '账户号',
  businessDepartment: '业务部门'
});
const DOCUMENT_FIELD_INDICES = Object.freeze(Object.fromEntries(
  Object.entries(DOCUMENT_FIELDS).map(([key, field]) => [key, BILL_HEADERS.indexOf(field)])
));
const DOCUMENT_VALUE_COLUMN_WHITELIST = Object.freeze(
  new Set(Object.values(DOCUMENT_FIELD_INDICES))
);
const WORKBOOK_ENTRY_NAME = 'xl/workbook.xml';

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function assertExactHeaders(actualHeaders, fileName) {
  const actual = actualHeaders.map(toText);
  if (actual.length !== BILL_HEADERS.length) {
    throw new FileValidationError(
      'duplicate-inbound-document-column-count',
      `${fileName}：单据对账单表头列数不符，期望 ${BILL_HEADERS.length} 列，实际 ${actual.length} 列`,
      {
        detailLines: [
          `期望表头：${BILL_HEADERS.join(' / ')}`,
          `实际表头：${actual.join(' / ')}`
        ]
      }
    );
  }
  const detailLines = [];
  for (let index = 0; index < BILL_HEADERS.length; index += 1) {
    if (actual[index] === BILL_HEADERS[index]) continue;
    detailLines.push(`第 ${index + 1} 列：期望“${BILL_HEADERS[index]}”，实际“${actual[index]}”`);
  }
  if (detailLines.length > 0) {
    throw new FileValidationError(
      'duplicate-inbound-document-header-mismatch',
      `${fileName}：单据对账单表头不符合标准（${detailLines.length} 处）`,
      { detailLines }
    );
  }
}

async function readXlsxSheetNames(filePath) {
  const fileName = path.basename(filePath);
  const { zip, entries } = await openZipWithEntries(fileName, filePath);
  try {
    const workbookEntry = entries.get(WORKBOOK_ENTRY_NAME);
    if (!workbookEntry) {
      throw new FileValidationError(
        'duplicate-inbound-workbook-missing',
        `${fileName}：xlsx 缺少 ${WORKBOOK_ENTRY_NAME}`
      );
    }
    return await new Promise((resolve, reject) => {
      zip.openReadStream(workbookEntry, (openError, stream) => {
        if (openError) {
          reject(openError);
          return;
        }
        const parser = sax.createStream(false, { lowercase: true });
        const sheetNames = [];
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(sheetNames);
        };
        parser.on('opentag', (node) => {
          if (node.name !== 'sheet') return;
          sheetNames.push(toText(node.attributes.name));
        });
        parser.on('end', () => finish());
        parser.on('error', finish);
        stream.on('error', finish);
        stream.pipe(parser);
      });
    });
  } finally {
    try { zip.close(); } catch (_error) { /* best effort */ }
  }
}

async function streamDocumentStatement(filePath, { onRow, onProgress } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  if (path.extname(filePath).toLowerCase() !== '.xlsx') {
    throw new FileValidationError(
      'duplicate-inbound-document-extension',
      '单据对账单只支持 .xlsx 文件'
    );
  }
  if (onRow !== undefined && typeof onRow !== 'function') {
    throw new TypeError('单据对账单 onRow 必须是函数');
  }

  const fileName = path.basename(filePath);
  let opened;
  try {
    opened = await openZipWithEntries(fileName, filePath);
  } catch (error) {
    throw new FileValidationError(
      'duplicate-inbound-document-unreadable',
      `${fileName}：单据对账单无法读取`,
      { detailLines: [error && error.message ? error.message : String(error)] }
    );
  }
  const { zip, entries } = opened;
  let headerValidated = false;
  let rowCount = 0;
  let matchableRowCount = 0;
  let emptyBusinessOrderCount = 0;
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    if (!sheetEntry) {
      throw new FileValidationError(
        'duplicate-inbound-document-sheet-missing',
        `${fileName}：单据对账单缺少第一工作表`
      );
    }
    let sharedStrings = [];
    try {
      sharedStrings = await loadSharedStrings(zip, entries.get(SHARED_STRINGS_ENTRY_NAME));
    } catch (_error) {
      sharedStrings = [];
    }

    await streamSheetRowsHandRolled({
      zip,
      sheetEntry,
      expectedHeaders: BILL_HEADERS,
      sharedStrings,
      valueColumnWhitelist: DOCUMENT_VALUE_COLUMN_WHITELIST,
      onRow: ({ rowR, values, hasAnyCellText }) => {
        if (rowR === 1) {
          assertExactHeaders(values, fileName);
          headerValidated = true;
          return;
        }
        if (!headerValidated) {
          throw new FileValidationError(
            'duplicate-inbound-document-header-missing',
            `${fileName}：单据对账单缺少第 1 行标准表头`
          );
        }
        if (!hasAnyCellText) return;

        const businessOrderNo = toText(values[DOCUMENT_FIELD_INDICES.businessOrderNo]);
        const row = {
          sourceOrdinal: rowCount,
          excelRowNumber: rowR,
          businessOrderNo,
          businessOrderKey: businessOrderNo.trim(),
          userNo: toText(values[DOCUMENT_FIELD_INDICES.userNo]),
          accountNo: toText(values[DOCUMENT_FIELD_INDICES.accountNo]),
          businessDepartment: toText(values[DOCUMENT_FIELD_INDICES.businessDepartment])
        };
        if (row.businessOrderKey === '') emptyBusinessOrderCount += 1;
        else matchableRowCount += 1;
        if (onRow) onRow(row);
        rowCount += 1;
        if (onProgress && rowCount % 10000 === 0) {
          onProgress({ rowCount, message: `正在导入单据对账单：已处理 ${rowCount} 行...` });
        }
      }
    });
    if (!headerValidated) {
      throw new FileValidationError(
        'duplicate-inbound-document-header-missing',
        `${fileName}：单据对账单缺少第 1 行标准表头`
      );
    }
    return { fileName, rowCount, matchableRowCount, emptyBusinessOrderCount };
  } finally {
    try { zip.close(); } catch (_error) { /* best effort */ }
  }
}

module.exports = {
  DOCUMENT_FIELDS,
  DOCUMENT_FIELD_INDICES,
  DOCUMENT_VALUE_COLUMN_WHITELIST,
  readXlsxSheetNames,
  assertExactHeaders,
  streamDocumentStatement
};
