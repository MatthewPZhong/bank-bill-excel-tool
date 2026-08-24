'use strict';

const path = require('node:path');
const {
  MAX_PARSER_ERROR_ROWS,
  PARSER_RESULT_MAX_BYTES,
  PARSER_RESULT_KEYS,
  assertExactKeys,
  centsToAmountString,
  computeParserSemanticHash,
  normalizeParserInput
} = require('./parser-core');
const { normalizeSourceSnapshot } = require('../archive-center/source-snapshot');
const {
  canonicalJsonSnapshot,
  canonicalSha256,
  canonicalizeJson
} = require('../background-execution/canonical-json-v1');

const INPUT_EVIDENCE_PROJECTION_VERSION = 1;
const COMPUTE_SNAPSHOT_CONTRACT_VERSION = 1;

class VccOrderedReducerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VccOrderedReducerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VccOrderedReducerError(code, message);
}

function exactJsonEqual(left, right) {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch (_error) {
    return false;
  }
}

// v1 evidence 明确绑定输入顺序、归一化绝对路径和冻结 source snapshot。
// 相同有序输入 canonical JSON 稳定；任一顺序改变会同时改变数组位置/fileIndex，digest 必变。
function parserInputEvidenceProjection(units) {
  return {
    projectionVersion: INPUT_EVIDENCE_PROJECTION_VERSION,
    inputs: units.map((unit) => ({
      fileIndex: unit.fileIndex,
      filePath: unit.filePath,
      sourceSnapshot: unit.sourceSnapshot
    }))
  };
}

function buildParserInputEvidenceHash(units) {
  return canonicalSha256(parserInputEvidenceProjection(units));
}

function assertSortedUniqueStrings(values, predicate, label) {
  if (!Array.isArray(values)) fail('VCC_REDUCER_RESULT_SHAPE_INVALID', `${label} 必须是数组`);
  let previous = null;
  for (const value of values) {
    if (typeof value !== 'string' || !predicate(value)) {
      fail('VCC_REDUCER_RESULT_SHAPE_INVALID', `${label} 含非法值`);
    }
    if (previous !== null && value <= previous) {
      fail('VCC_REDUCER_RESULT_SHAPE_INVALID', `${label} 必须升序且唯一`);
    }
    previous = value;
  }
}

function assertSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('VCC_REDUCER_RESULT_SHAPE_INVALID', `${label} 必须是非负安全整数`);
  }
}

function assertErrorRows(result, unit) {
  if (!Array.isArray(result.errorRows)) {
    fail('VCC_REDUCER_RESULT_SHAPE_INVALID', 'errorRows 必须是数组');
  }
  const expectedCount = Math.min(result.errorCount, unit.maxErrors);
  if (result.errorRows.length !== expectedCount) {
    fail('VCC_REDUCER_ERROR_ROWS_INCOMPLETE', 'errorRows 与 errorCount/maxErrors 不一致');
  }
  const expectedFileName = path.basename(unit.filePath);
  for (const row of result.errorRows) {
    assertExactKeys(row, ['fileName', 'reason', 'rowIndex'], 'Parser error row');
    if (row.fileName !== expectedFileName) {
      fail('VCC_REDUCER_ERROR_LINEAGE_MISMATCH', 'errorRows.fileName 与输入文件不一致');
    }
    assertSafeNonNegativeInteger(row.rowIndex, 'errorRows.rowIndex');
    if (typeof row.reason !== 'string' || row.reason.length === 0) {
      fail('VCC_REDUCER_RESULT_SHAPE_INVALID', 'errorRows.reason 必须是非空字符串');
    }
  }
}

function validateUnitResult(rawResult, unit) {
  assertExactKeys(rawResult, PARSER_RESULT_KEYS, 'Parser Worker result');
  if (rawResult.fileIndex !== unit.fileIndex) {
    fail('VCC_REDUCER_FILE_INDEX_MISMATCH', 'result.fileIndex 与目标 unit 不一致');
  }
  const normalizedSnapshot = normalizeSourceSnapshot(rawResult.sourceSnapshot);
  if (!normalizedSnapshot
      || !exactJsonEqual(rawResult.sourceSnapshot, normalizedSnapshot)
      || !exactJsonEqual(normalizedSnapshot, unit.sourceSnapshot)) {
    fail('VCC_REDUCER_SOURCE_SNAPSHOT_MISMATCH', 'Worker result sourceSnapshot 与冻结输入不一致');
  }
  assertSafeNonNegativeInteger(rawResult.rowCount, 'rowCount');
  assertSafeNonNegativeInteger(rawResult.errorCount, 'errorCount');
  if (rawResult.errorCount > rawResult.rowCount) {
    fail('VCC_REDUCER_RESULT_SHAPE_INVALID', 'errorCount 不得大于 rowCount');
  }
  if (!Number.isSafeInteger(rawResult.amountOutCents)
      || !Number.isSafeInteger(rawResult.amountInCents)) {
    fail('VCC_REDUCER_AMOUNT_UNSAFE', 'Worker 金额必须是安全整数分');
  }
  assertSortedUniqueStrings(rawResult.monthKeys, (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value), 'monthKeys');
  assertSortedUniqueStrings(rawResult.currencies, (value) => value.trim() === value && value !== '', 'currencies');
  assertErrorRows(rawResult, unit);
  if (typeof rawResult.semanticHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawResult.semanticHash)) {
    fail('VCC_REDUCER_SEMANTIC_HASH_INVALID', 'semanticHash 格式非法');
  }
  if (rawResult.semanticHash !== computeParserSemanticHash(rawResult)) {
    fail('VCC_REDUCER_SEMANTIC_HASH_MISMATCH', 'Worker semanticHash 重算不一致');
  }
  return canonicalJsonSnapshot(rawResult);
}

function safeAdd(left, right, code, message) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail(code, message);
  return value;
}

function safeSubtract(left, right, code, message) {
  const value = left - right;
  if (!Number.isSafeInteger(value)) fail(code, message);
  return value;
}

function consumeOrderedResult(candidate, result, unit, maxErrors) {
  candidate.totalRows = safeAdd(
    candidate.totalRows,
    result.rowCount,
    'VCC_REDUCER_ROW_COUNT_UNSAFE',
    '总行数超出安全整数范围'
  );
  candidate.errorCount = safeAdd(
    candidate.errorCount,
    result.errorCount,
    'VCC_REDUCER_ERROR_COUNT_UNSAFE',
    '错误数超出安全整数范围'
  );
  candidate.totalOutCents = safeAdd(
    candidate.totalOutCents,
    result.amountOutCents,
    'VCC_REDUCER_AMOUNT_UNSAFE',
    '发生额出超出安全整数范围'
  );
  candidate.totalInCents = safeAdd(
    candidate.totalInCents,
    result.amountInCents,
    'VCC_REDUCER_AMOUNT_UNSAFE',
    '发生额入超出安全整数范围'
  );
  for (const month of result.monthKeys) candidate.months.add(month);
  for (const currency of result.currencies) candidate.currencies.add(currency);
  for (const row of result.errorRows) {
    if (candidate.errorRows.length < maxErrors) candidate.errorRows.push(row);
  }
  const amountCents = safeSubtract(
    result.amountInCents,
    result.amountOutCents,
    'VCC_REDUCER_AMOUNT_UNSAFE',
    '单文件发生额超出安全整数范围'
  );
  candidate.perFile.push({
    fileName: path.basename(unit.filePath),
    rowCount: result.rowCount,
    amountOutCents: result.amountOutCents,
    amountInCents: result.amountInCents,
    amountCents,
    amountOut: centsToAmountString(result.amountOutCents),
    amountIn: centsToAmountString(result.amountInCents),
    amount: centsToAmountString(amountCents)
  });
}

function buildRejectedResult(candidate) {
  if (candidate.totalRows === 0) {
    return canonicalJsonSnapshot({
      ok: false,
      errorRows: [{ fileName: '', rowIndex: 0, reason: '所选文件无有效数据行' }],
      errorCount: 1
    }, { maxBytes: PARSER_RESULT_MAX_BYTES });
  }
  if (candidate.months.size > 1) {
    candidate.errorCount = safeAdd(
      candidate.errorCount,
      1,
      'VCC_REDUCER_ERROR_COUNT_UNSAFE',
      '错误数超出安全整数范围'
    );
    candidate.errorRows.push({
      fileName: '',
      rowIndex: 0,
      reason: `一次导入流水跨多个月份（${[...candidate.months].sort().join(', ')}），请按月分开导入`
    });
  }
  if (candidate.errorCount === 0) return null;
  return canonicalJsonSnapshot({
    ok: false,
    errorRows: candidate.errorRows,
    errorCount: candidate.errorCount
  }, { maxBytes: PARSER_RESULT_MAX_BYTES });
}

function buildComputeSnapshot(units, candidate) {
  if (candidate.months.size !== 1) {
    fail('VCC_REDUCER_MONTH_INCOMPLETE', '成功结果必须且只能归属一个月份');
  }
  const totalAmountCents = safeSubtract(
    candidate.totalInCents,
    candidate.totalOutCents,
    'VCC_REDUCER_AMOUNT_UNSAFE',
    '总发生额超出安全整数范围'
  );
  const currencyList = [...candidate.currencies].sort();
  const currency = currencyList.length === 0
    ? null
    : (currencyList.length === 1 ? currencyList[0] : currencyList.join(','));

  return canonicalJsonSnapshot({
    computeSnapshotContractVersion: COMPUTE_SNAPSHOT_CONTRACT_VERSION,
    inputEvidenceHash: buildParserInputEvidenceHash(units),
    yearMonth: [...candidate.months][0],
    totalRows: candidate.totalRows,
    totals: {
      totalOutCents: candidate.totalOutCents,
      totalInCents: candidate.totalInCents,
      totalAmountCents,
      totalOut: centsToAmountString(candidate.totalOutCents),
      totalIn: centsToAmountString(candidate.totalInCents),
      totalAmount: centsToAmountString(totalAmountCents),
      currency
    },
    perFile: candidate.perFile
  }, { maxBytes: PARSER_RESULT_MAX_BYTES });
}

function createOrderedReducer({ inputs, maxErrors = MAX_PARSER_ERROR_ROWS } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    fail('VCC_REDUCER_INPUTS_INVALID', 'Ordered Reducer 至少需要一个输入');
  }
  if (!Number.isSafeInteger(maxErrors) || maxErrors < 1 || maxErrors > MAX_PARSER_ERROR_ROWS) {
    fail('VCC_REDUCER_MAX_ERRORS_INVALID', `maxErrors 必须是 1-${MAX_PARSER_ERROR_ROWS} 的安全整数`);
  }
  const units = inputs.map(normalizeParserInput);
  for (let index = 0; index < units.length; index += 1) {
    if (units[index].fileIndex !== index) {
      fail('VCC_REDUCER_INPUT_INDEX_INVALID', '输入 fileIndex 必须从 0 连续递增');
    }
    if (units[index].maxErrors !== maxErrors) {
      fail('VCC_REDUCER_MAX_ERRORS_MISMATCH', '全部 unit.maxErrors 必须与 reducer 一致');
    }
  }

  const buffered = new Map();
  const seen = new Set();
  const candidate = {
    totalRows: 0,
    totalOutCents: 0,
    totalInCents: 0,
    errorCount: 0,
    errorRows: [],
    months: new Set(),
    currencies: new Set(),
    perFile: []
  };
  let nextExpectedIndex = 0;
  let finalized = false;

  function accept(rawResult) {
    if (finalized) fail('VCC_REDUCER_ALREADY_FINALIZED', 'Reducer 已完成，不能再接收结果');
    const rawIndex = rawResult && rawResult.fileIndex;
    if (!Number.isSafeInteger(rawIndex) || rawIndex < 0 || rawIndex >= units.length) {
      fail('VCC_REDUCER_FILE_INDEX_UNKNOWN', 'Worker result.fileIndex 不在输入范围内');
    }
    if (seen.has(rawIndex)) {
      fail('VCC_REDUCER_FILE_INDEX_DUPLICATE', `重复的 fileIndex=${rawIndex}`);
    }
    const result = validateUnitResult(rawResult, units[rawIndex]);
    seen.add(rawIndex);
    buffered.set(rawIndex, result);
    while (buffered.has(nextExpectedIndex)) {
      consumeOrderedResult(candidate, buffered.get(nextExpectedIndex), units[nextExpectedIndex], maxErrors);
      buffered.delete(nextExpectedIndex);
      nextExpectedIndex += 1;
    }
  }

  function finalize() {
    if (finalized) fail('VCC_REDUCER_ALREADY_FINALIZED', 'Reducer 已完成');
    finalized = true;
    if (seen.size !== units.length || nextExpectedIndex !== units.length || buffered.size !== 0) {
      fail('VCC_REDUCER_FILE_INDEX_MISSING', `缺少 fileIndex=${nextExpectedIndex}`);
    }
    const rejected = buildRejectedResult(candidate);
    if (rejected) return rejected;
    const snapshot = buildComputeSnapshot(units, candidate);
    return Object.freeze({ ok: true, snapshot });
  }

  function state() {
    return Object.freeze({
      nextExpectedIndex,
      bufferedCount: buffered.size,
      acceptedCount: seen.size,
      expectedCount: units.length,
      finalized
    });
  }

  return Object.freeze({ accept, finalize, state });
}

module.exports = {
  COMPUTE_SNAPSHOT_CONTRACT_VERSION,
  INPUT_EVIDENCE_PROJECTION_VERSION,
  VccOrderedReducerError,
  buildParserInputEvidenceHash,
  createOrderedReducer,
  parserInputEvidenceProjection,
  validateUnitResult
};
