'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Transform } = require('node:stream');
const { TextDecoder } = require('node:util');
const zlib = require('node:zlib');

const { FileValidationError } = require('../../backend/file-service/common');
const {
  MPT_DELIMITER,
  identifyMptHeader,
  normalizeMptRow,
  parseMptFileName,
  validationError,
} = require('./mpt-schema');

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_ROW_ERROR_SAMPLE_LIMIT = 20;
const MAX_LINE_LENGTH = 4 * 1024 * 1024;

function createHashingTransform(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function* iterateUtf8Lines(filePath, fileMetadata, hash) {
  const rawStream = fs.createReadStream(filePath);
  const hashingStream = createHashingTransform(hash);
  const streams = [rawStream, hashingStream];
  let contentStream = rawStream.pipe(hashingStream);
  if (fileMetadata.extension === 'gz') {
    const gunzip = zlib.createGunzip();
    streams.push(gunzip);
    contentStream = contentStream.pipe(gunzip);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let carry = '';
  try {
    for await (const chunk of contentStream) {
      let decoded;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch (_error) {
        throw validationError('MPT_UTF8_INVALID', 'MPT 文件不是有效的 UTF-8 编码', {
          fileName: fileMetadata.sourceFileName,
        });
      }
      carry += decoded;

      let newlineIndex;
      while ((newlineIndex = carry.indexOf('\n')) >= 0) {
        let line = carry.slice(0, newlineIndex);
        carry = carry.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length > MAX_LINE_LENGTH) {
          throw validationError('MPT_LINE_TOO_LONG', 'MPT 单行长度超过安全上限', {
            fileName: fileMetadata.sourceFileName,
          });
        }
        yield line;
      }
      if (carry.length > MAX_LINE_LENGTH) {
        throw validationError('MPT_LINE_TOO_LONG', 'MPT 单行长度超过安全上限', {
          fileName: fileMetadata.sourceFileName,
        });
      }
    }

    try {
      carry += decoder.decode();
    } catch (_error) {
      throw validationError('MPT_UTF8_INVALID', 'MPT 文件不是有效的 UTF-8 编码', {
        fileName: fileMetadata.sourceFileName,
      });
    }
    if (carry !== '') {
      if (carry.endsWith('\r')) carry = carry.slice(0, -1);
      if (carry.length > MAX_LINE_LENGTH) {
        throw validationError('MPT_LINE_TOO_LONG', 'MPT 单行长度超过安全上限', {
          fileName: fileMetadata.sourceFileName,
        });
      }
      yield carry;
    }
  } finally {
    for (const stream of streams) {
      if (!stream.destroyed) stream.destroy();
    }
  }
}

function normalizeBatchSize(value) {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000) {
    throw new TypeError('MPT batchSize 必须为 1 到 100000 的安全整数');
  }
  return value;
}

function normalizeRowErrorSampleLimit(value) {
  if (value === undefined) return DEFAULT_ROW_ERROR_SAMPLE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) {
    throw new TypeError('MPT rowErrorSampleLimit 必须为 0 到 1000 的安全整数');
  }
  return value;
}

function buildRowIssue(error, fields, rawLine, sourceRowNumber) {
  return {
    code: error.code || 'MPT_ROW_INVALID',
    message: error.message || String(error),
    detailLines: Array.isArray(error.detailLines) ? error.detailLines.slice() : [],
    context: error.context && typeof error.context === 'object' ? { ...error.context } : {},
    sourceRowNumber,
    fieldName: error.context && error.context.fieldName ? String(error.context.fieldName) : '',
    fields: Array.isArray(fields) ? fields.slice() : [],
    rawLine: String(rawLine || '')
  };
}

function mapStreamError(error, fileMetadata) {
  if (error instanceof FileValidationError) return error;
  if (error && typeof error.code === 'string' && error.code.startsWith('Z_')) {
    return validationError('MPT_GZIP_INVALID', 'MPT gzip 文件损坏或不完整', {
      fileName: fileMetadata.sourceFileName,
    });
  }
  if (error && ['ENOENT', 'EACCES', 'EISDIR'].includes(error.code)) {
    return validationError('MPT_FILE_READ_FAILED', 'MPT 文件无法读取', {
      fileName: fileMetadata.sourceFileName,
    });
  }
  return error;
}

/**
 * 流式解析一个 MPT 文件。
 *
 * options.onHeader(metadata)：首行完成强校验后调用一次。
 * options.onRows(rows)：按 batchSize 交付规范行，允许返回 Promise 形成背压。
 * 返回值只含轻量元数据；不会在内存中累计全文件行。
 */
async function parseMptFile(filePath, options = {}) {
  const fileMetadata = parseMptFileName(filePath);
  const batchSize = normalizeBatchSize(options.batchSize);
  const onHeader = typeof options.onHeader === 'function' ? options.onHeader : null;
  const onRows = typeof options.onRows === 'function' ? options.onRows : null;
  const collectRowErrors = options.collectRowErrors === true;
  const onRowError = typeof options.onRowError === 'function' ? options.onRowError : null;
  const rowErrorSampleLimit = normalizeRowErrorSampleLimit(options.rowErrorSampleLimit);
  const hash = crypto.createHash('sha256');
  let headerMetadata = null;
  let sourceRowNumber = 0;
  let parsedRowCount = 0;
  let validRowCount = 0;
  let rowErrorCount = 0;
  const rowErrorSamples = [];
  let pendingRows = [];

  try {
    for await (let line of iterateUtf8Lines(filePath, fileMetadata, hash)) {
      sourceRowNumber += 1;
      if (sourceRowNumber === 1 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      const fields = line.split(MPT_DELIMITER);

      if (sourceRowNumber === 1) {
        headerMetadata = identifyMptHeader(fields, fileMetadata);
        if (onHeader) await onHeader(headerMetadata);
        continue;
      }

      if (!headerMetadata) {
        throw validationError('MPT_HEADER_MISSING', 'MPT 文件缺少有效首行', {
          fileName: fileMetadata.sourceFileName,
          rowNumber: 1,
        });
      }
      parsedRowCount += 1;
      let normalizedRow;
      try {
        normalizedRow = normalizeMptRow(fields, headerMetadata, sourceRowNumber);
      } catch (error) {
        if (!collectRowErrors || !(error instanceof FileValidationError)) throw error;
        const issue = buildRowIssue(error, fields, line, sourceRowNumber);
        rowErrorCount += 1;
        if (rowErrorSamples.length < rowErrorSampleLimit) rowErrorSamples.push(issue);
        if (onRowError) await onRowError(issue);
        continue;
      }
      pendingRows.push(normalizedRow);
      validRowCount += 1;
      if (pendingRows.length >= batchSize) {
        if (onRows) await onRows(pendingRows);
        pendingRows = [];
      }
    }

    if (!headerMetadata) {
      throw validationError('MPT_HEADER_MISSING', 'MPT 文件为空或缺少有效首行', {
        fileName: fileMetadata.sourceFileName,
        rowNumber: 1,
      });
    }
    if (parsedRowCount !== headerMetadata.declaredRowCount) {
      throw validationError(
        'MPT_DECLARED_COUNT_MISMATCH',
        `MPT 声明明细数为 ${headerMetadata.declaredRowCount}，实际解析 ${parsedRowCount} 行`,
        { fileName: fileMetadata.sourceFileName }
      );
    }
    if (pendingRows.length > 0 && onRows) await onRows(pendingRows);

    return {
      ...headerMetadata,
      parsedRowCount,
      validRowCount,
      rowErrorCount,
      rowErrorSamples,
      contentHash: hash.digest('hex'),
    };
  } catch (error) {
    throw mapStreamError(error, fileMetadata);
  }
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_ROW_ERROR_SAMPLE_LIMIT,
  MAX_LINE_LENGTH,
  parseMptFile,
};
