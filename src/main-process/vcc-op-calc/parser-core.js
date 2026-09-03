'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { streamFlowFile } = require('../../backend/vcc-op-calc-import/reader');
const {
  VCC_DIRECTION_DB_COLUMN,
  VCC_RECON_AMOUNT_DB_COLUMN,
  VCC_BILL_DATE_DB_COLUMN,
  VCC_CURRENCY_DB_COLUMN,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
} = require('../../backend/vcc-op-calc-db/columns');
const {
  normalizeSourceSnapshot,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');

const PARSER_CONTRACT_VERSION = 1;
const PARSER_SEMANTIC_PROJECTION_VERSION = 1;
const MAX_PARSER_ERROR_ROWS = 100;
// 权威 action policy `vcc-op:scan-and-compute.result.maxBytes` 的上限；unit result 同样不得越界。
const PARSER_RESULT_MAX_BYTES = 8 * 1024 * 1024;
const PARSER_INPUT_KEYS = Object.freeze([
  'fileIndex',
  'filePath',
  'maxErrors',
  'parserContractVersion',
  'sourceSnapshot'
]);
const PARSER_RESULT_KEYS = Object.freeze([
  'amountInCents',
  'amountOutCents',
  'currencies',
  'errorCount',
  'errorRows',
  'fileIndex',
  'monthKeys',
  'rowCount',
  'semanticHash',
  'sourceSnapshot'
]);

class VccParserContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VccParserContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VccParserContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail('VCC_PARSER_SHAPE_INVALID', `${label} 必须是 plain object`);
  const actual = Object.keys(value).sort();
  if (actual.length !== expectedKeys.length
      || actual.some((key, index) => key !== expectedKeys[index])) {
    fail('VCC_PARSER_SHAPE_INVALID', `${label} 字段不符合 parser contract v1`);
  }
}

// 金额一律转整数分。空值按现有 VCC 口径计 0；非数值由整批拒绝处理。
function parseAmountToCents(value) {
  if (value == null) return { ok: true, cents: 0, empty: true };
  const text = String(value).trim();
  if (text === '') return { ok: true, cents: 0, empty: true };
  const amount = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return { ok: false };
  return { ok: true, cents: Math.round(amount * 100), empty: false };
}

function centsToAmountString(cents) {
  const amount = Number(cents) || 0;
  return (amount / 100).toFixed(2);
}

function extractYearMonth(billDateRaw) {
  if (billDateRaw == null) return null;
  const text = String(billDateRaw).trim();
  if (text === '') return null;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[ T].*)?$/);
  if (match) {
    const month = String(match[2]).padStart(2, '0');
    return Number(month) >= 1 && Number(month) <= 12 ? `${match[1]}-${month}` : null;
  }
  match = text.match(/^(\d{4})(\d{2})(\d{2})?$/);
  if (match) {
    return Number(match[2]) >= 1 && Number(match[2]) <= 12
      ? `${match[1]}-${match[2]}`
      : null;
  }
  return null;
}

function normalizeDirection(value) {
  return String(value == null ? '' : value).trim();
}

// legacy 同步/流式路径与 worker parser 共用这一份行级资金口径。
function validateAndExtractRow(row) {
  const direction = normalizeDirection(row[VCC_DIRECTION_DB_COLUMN]);
  if (direction !== VALID_DIRECTION_IN && direction !== VALID_DIRECTION_OUT) {
    return {
      ok: false,
      reason: `出入方向非法：实际值 "${row[VCC_DIRECTION_DB_COLUMN] == null ? '' : row[VCC_DIRECTION_DB_COLUMN]}"，仅允许 "入" 或 "出"`
    };
  }

  const amount = parseAmountToCents(row[VCC_RECON_AMOUNT_DB_COLUMN]);
  if (!amount.ok) {
    return { ok: false, reason: `对账金额非数值：${row[VCC_RECON_AMOUNT_DB_COLUMN]}` };
  }
  if (!Number.isSafeInteger(amount.cents)) {
    return { ok: false, reason: `对账金额超出安全整数分范围：${row[VCC_RECON_AMOUNT_DB_COLUMN]}` };
  }

  const yearMonth = extractYearMonth(row[VCC_BILL_DATE_DB_COLUMN]);
  if (!yearMonth) {
    return {
      ok: false,
      reason: `账单日期无法解析月份：${row[VCC_BILL_DATE_DB_COLUMN] == null ? '' : row[VCC_BILL_DATE_DB_COLUMN]}`
    };
  }

  const currency = String(row[VCC_CURRENCY_DB_COLUMN] == null ? '' : row[VCC_CURRENCY_DB_COLUMN]).trim();
  return { ok: true, direction, cents: amount.cents, yearMonth, currency };
}

function normalizeParserInput(input) {
  assertExactKeys(input, PARSER_INPUT_KEYS, 'Parser Worker input');
  if (!Number.isSafeInteger(input.fileIndex) || input.fileIndex < 0) {
    fail('VCC_PARSER_FILE_INDEX_INVALID', 'fileIndex 必须是非负安全整数');
  }
  if (typeof input.filePath !== 'string' || input.filePath.trim() === '') {
    fail('VCC_PARSER_FILE_PATH_INVALID', 'filePath 必须是非空字符串');
  }
  if (input.parserContractVersion !== PARSER_CONTRACT_VERSION) {
    fail('VCC_PARSER_CONTRACT_VERSION_UNSUPPORTED', '仅支持 parserContractVersion=1');
  }
  if (!Number.isSafeInteger(input.maxErrors)
      || input.maxErrors < 1
      || input.maxErrors > MAX_PARSER_ERROR_ROWS) {
    fail('VCC_PARSER_MAX_ERRORS_INVALID', `maxErrors 必须是 1-${MAX_PARSER_ERROR_ROWS} 的安全整数`);
  }
  const sourceSnapshot = normalizeSourceSnapshot(input.sourceSnapshot);
  if (!sourceSnapshot) {
    fail('VCC_PARSER_SOURCE_SNAPSHOT_INVALID', 'sourceSnapshot 不符合冻结输入合同');
  }
  return canonicalJsonSnapshot({
    fileIndex: input.fileIndex,
    filePath: path.resolve(input.filePath),
    sourceSnapshot,
    maxErrors: input.maxErrors,
    parserContractVersion: PARSER_CONTRACT_VERSION
  });
}

// semanticHash v1 覆盖全部固定结果字段（仅排除 digest 自身），包括完整的 errorRows。
// maxErrors 不属于固定 result 字段，由 Reducer 对 input.maxErrors 与 errorRows.length 做完整性校验。
// Reducer 必须通过本函数重算，不能信任 Worker 自报。
function parserSemanticProjection(result) {
  return {
    projectionVersion: PARSER_SEMANTIC_PROJECTION_VERSION,
    result: {
      fileIndex: result.fileIndex,
      sourceSnapshot: result.sourceSnapshot,
      rowCount: result.rowCount,
      monthKeys: result.monthKeys,
      currencies: result.currencies,
      amountOutCents: result.amountOutCents,
      amountInCents: result.amountInCents,
      errorCount: result.errorCount,
      errorRows: result.errorRows
    }
  };
}

function computeParserSemanticHash(result) {
  return canonicalSha256(parserSemanticProjection(result), { maxBytes: PARSER_RESULT_MAX_BYTES });
}

function safeAdd(left, right, code) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) fail(code, 'VCC Parser 聚合金额超出安全整数范围');
  return total;
}

async function readStat(filePath, statFile) {
  try {
    return await statFile(filePath);
  } catch (_error) {
    fail('VCC_PARSER_SOURCE_UNAVAILABLE', '解析输入在读取时不可用');
  }
}

function assertSourceSnapshot(sourceSnapshot, stat, phase) {
  if (!sourceSnapshotMatchesStat(sourceSnapshot, stat)) {
    fail(
      'VCC_PARSER_SOURCE_CHANGED',
      phase === 'before'
        ? '解析开始前输入文件已变化'
        : '解析过程中输入文件发生变化'
    );
  }
}

async function parseVccFileUnit(rawInput, dependencies = {}) {
  const input = normalizeParserInput(rawInput);
  const streamFile = dependencies.streamFile || streamFlowFile;
  const statFile = dependencies.statFile || ((filePath) => fs.promises.stat(filePath, { bigint: true }));
  const before = await readStat(input.filePath, statFile);
  assertSourceSnapshot(input.sourceSnapshot, before, 'before');

  const monthKeys = new Set();
  const currencies = new Set();
  const errorRows = [];
  const fileName = path.basename(input.filePath);
  let rowCount = 0;
  let amountOutCents = 0;
  let amountInCents = 0;
  let errorCount = 0;

  await streamFile(input.filePath, {
    onDataRow(row) {
      rowCount = safeAdd(rowCount, 1, 'VCC_PARSER_ROW_COUNT_UNSAFE');
      const parsed = validateAndExtractRow(row);
      if (!parsed.ok) {
        errorCount = safeAdd(errorCount, 1, 'VCC_PARSER_ERROR_COUNT_UNSAFE');
        if (errorRows.length < input.maxErrors) {
          const rawRowIndex = Number(row && row._rowIndex);
          errorRows.push({
            fileName,
            rowIndex: Number.isSafeInteger(rawRowIndex) && rawRowIndex >= 0 ? rawRowIndex : 0,
            reason: parsed.reason
          });
        }
        return;
      }
      monthKeys.add(parsed.yearMonth);
      if (parsed.currency) currencies.add(parsed.currency);
      if (parsed.direction === VALID_DIRECTION_IN) {
        amountInCents = safeAdd(amountInCents, parsed.cents, 'VCC_PARSER_AMOUNT_IN_UNSAFE');
      } else {
        amountOutCents = safeAdd(amountOutCents, parsed.cents, 'VCC_PARSER_AMOUNT_OUT_UNSAFE');
      }
    }
  });

  const after = await readStat(input.filePath, statFile);
  assertSourceSnapshot(input.sourceSnapshot, after, 'after');

  const result = {
    fileIndex: input.fileIndex,
    sourceSnapshot: input.sourceSnapshot,
    rowCount,
    monthKeys: [...monthKeys].sort(),
    currencies: [...currencies].sort(),
    amountOutCents,
    amountInCents,
    errorCount,
    errorRows
  };
  return canonicalJsonSnapshot({
    ...result,
    semanticHash: computeParserSemanticHash(result)
  }, { maxBytes: PARSER_RESULT_MAX_BYTES });
}

module.exports = {
  MAX_PARSER_ERROR_ROWS,
  PARSER_CONTRACT_VERSION,
  PARSER_INPUT_KEYS,
  PARSER_RESULT_MAX_BYTES,
  PARSER_RESULT_KEYS,
  PARSER_SEMANTIC_PROJECTION_VERSION,
  VccParserContractError,
  assertExactKeys,
  centsToAmountString,
  computeParserSemanticHash,
  extractYearMonth,
  normalizeDirection,
  normalizeParserInput,
  parseAmountToCents,
  parseVccFileUnit,
  parserSemanticProjection,
  validateAndExtractRow
};
