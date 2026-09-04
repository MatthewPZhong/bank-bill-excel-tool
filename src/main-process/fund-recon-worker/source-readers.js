'use strict';

const path = require('node:path');

const readers = require('../../backend/file-service/readers');
const { normalizeCell } = require('../../backend/file-service/common');
const {
  ZHONGTAI_REFUND_ORDER_SIGNATURE
} = require('../../constants/table-signatures');
const {
  readBankStatement,
  readGatewayRecon
} = require('../bank-statement-io');

class FundReconSourceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FundReconSourceError';
    this.code = code;
    this.details = details;
  }
}

function requireFilePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FundReconSourceError('FUND_RECON_SOURCE_INVALID', 'FundRecon source filePath 不能为空');
  }
  return value;
}

function readLinkedRowsAsObjects(filePath, signature, sheetName = null) {
  const expected = Array.isArray(signature && signature.expectedHeaders)
    ? signature.expectedHeaders
    : [];
  if (expected.length === 0) {
    throw new FundReconSourceError('FUND_RECON_SOURCE_SIGNATURE_INVALID', '链接表签名缺少 expectedHeaders');
  }
  const result = readers.readRowsWithMetadata(filePath, [], {
    ...(sheetName ? { sheetName } : {})
  });
  const rows = Array.isArray(result.rows) ? result.rows : [];
  let headerRowIndex = -1;
  let columnOffset = -1;
  for (let rowIndex = 0; rowIndex < rows.length && headerRowIndex < 0; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    for (let start = 0; start <= row.length - expected.length; start += 1) {
      let matched = true;
      for (let index = 0; index < expected.length; index += 1) {
        if (normalizeCell(row[start + index]) !== normalizeCell(expected[index])) {
          matched = false;
          break;
        }
      }
      if (matched) {
        headerRowIndex = rowIndex;
        columnOffset = start;
        break;
      }
    }
  }
  if (headerRowIndex < 0) {
    throw new FundReconSourceError(
      'FUND_RECON_SOURCE_HEADER_MISMATCH',
      `文件未匹配到「${signature.label || signature.tableKey || '链接表'}」表头`
    );
  }
  return rows.slice(headerRowIndex + 1).map((row) => {
    const source = Array.isArray(row) ? row : [];
    const output = {};
    for (let index = 0; index < expected.length; index += 1) {
      const header = normalizeCell(expected[index]);
      if (!header) continue;
      output[header] = normalizeCell(source[columnOffset + index]);
    }
    return output;
  });
}

function readBankSource(source) {
  const filePath = requireFilePath(source && source.filePath);
  const parsed = readBankStatement(filePath);
  return {
    filePath: parsed.filePath,
    fileName: parsed.fileName,
    rows: parsed.rows,
    headers: parsed.headers,
    rowCount: parsed.rowCount
  };
}

function readGatewaySource(source) {
  const filePath = requireFilePath(source && source.filePath);
  const parsed = readGatewayRecon(filePath);
  return {
    filePath: parsed.filePath,
    fileName: parsed.fileName,
    rows: parsed.gwRows,
    rowCount: parsed.rowCount
  };
}

function readRefundSource(source) {
  const filePath = requireFilePath(source && source.filePath);
  const rows = readLinkedRowsAsObjects(
    filePath,
    ZHONGTAI_REFUND_ORDER_SIGNATURE,
    source && source.sheetName ? String(source.sheetName) : null
  );
  return {
    filePath,
    fileName: path.basename(filePath),
    rows,
    rowCount: rows.length
  };
}

module.exports = {
  FundReconSourceError,
  readBankSource,
  readGatewaySource,
  readLinkedRowsAsObjects,
  readRefundSource
};
