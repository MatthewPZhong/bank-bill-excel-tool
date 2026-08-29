'use strict';

const { validateResourceVector } = require('../background-execution/resource-lease');
const {
  MAX_RECORDS,
  createNewAccountGenerationInput,
  projectNewAccountGenerationRecordCount
} = require('./generation-contract');

const MEBIBYTE = 1024 ** 2;
const NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION = 1;
const NEW_ACCOUNT_GENERATION_MEMORY_MODEL = Object.freeze({
  executorBaselineBytes: 256 * MEBIBYTE,
  workbookEnvelopeBytes: 64 * MEBIBYTE,
  readbackEnvelopeBytes: 64 * MEBIBYTE,
  safetyMarginBytes: 64 * MEBIBYTE,
  perProjectedRowBytes: 4096,
  minProjectedRows: 0,
  maxProjectedRows: MAX_RECORDS
});

class NewAccountResourceEstimateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NewAccountResourceEstimateError';
    this.code = code;
  }
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_OVERFLOW',
      `${label}超过安全整数范围`
    );
  }
  return value;
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_OVERFLOW',
      `${label}超过安全整数范围`
    );
  }
  return value;
}

const FIXED_MEMORY_ENVELOPE_BYTES = Object.freeze([
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.executorBaselineBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.workbookEnvelopeBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackEnvelopeBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.safetyMarginBytes
]).reduce((sum, value) => checkedAdd(sum, value, '固定内存 envelope'), 0);

const MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES = FIXED_MEMORY_ENVELOPE_BYTES;
const MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES = checkedAdd(
  FIXED_MEMORY_ENVELOPE_BYTES,
  checkedMultiply(MAX_RECORDS, NEW_ACCOUNT_GENERATION_MEMORY_MODEL.perProjectedRowBytes, '最大行数内存'),
  '最大 NewAccount generation 内存'
);

function estimateNewAccountGenerationMemory(projectedOutputRows) {
  if (!Number.isSafeInteger(projectedOutputRows) || projectedOutputRows < 0) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_ROW_COUNT_INVALID',
      '预计输出行数必须是非负安全整数'
    );
  }
  // 先乘法后检查业务上限：即使调用方绕过 bounded DTO，
  // Number.MAX_SAFE_INTEGER 之类输入也不得在资源计算中静默丢失精度。
  const projectedRowsBytes = checkedMultiply(
    projectedOutputRows,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.perProjectedRowBytes,
    '预计输出行内存'
  );
  if (projectedOutputRows > MAX_RECORDS) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_ROW_LIMIT',
      `预计输出行数不得超过 ${MAX_RECORDS}`
    );
  }
  const memoryBytes = checkedAdd(
    FIXED_MEMORY_ENVELOPE_BYTES,
    projectedRowsBytes,
    'NewAccount generation 内存'
  );
  if (memoryBytes < MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES ||
      memoryBytes > MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_BOUNDS',
      'NewAccount generation 内存估算超出冻结上下界'
    );
  }
  return Object.freeze({
    memoryBytes,
    components: Object.freeze({
      executorBaselineBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.executorBaselineBytes,
      workbookEnvelopeBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.workbookEnvelopeBytes,
      readbackEnvelopeBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackEnvelopeBytes,
      safetyMarginBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.safetyMarginBytes,
      projectedRowsBytes
    })
  });
}

function createNewAccountGenerationResourceEstimate(rawInput, staticPhaseResources) {
  const input = createNewAccountGenerationInput(rawInput);
  const staticPhase = validateResourceVector(staticPhaseResources, 'newAccountStaticPhase');
  const projectedOutputRows = projectNewAccountGenerationRecordCount(input.accounts, input.asOfDate);
  const memory = estimateNewAccountGenerationMemory(projectedOutputRows);
  return Object.freeze({
    modelVersion: NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION,
    projectedOutputRows,
    accountCount: input.accounts.length,
    currencyCount: input.accounts.reduce((sum, account) => sum + account.currencies.length, 0),
    components: memory.components,
    resources: Object.freeze({
      cpuSlots: staticPhase.cpuSlots,
      workerThreadSlots: staticPhase.workerThreadSlots,
      utilityProcessSlots: staticPhase.utilityProcessSlots,
      ioHeavySlots: staticPhase.ioHeavySlots,
      memoryBytes: memory.memoryBytes
    })
  });
}

function estimateNewAccountGenerationPhaseResources(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_REQUEST_INVALID',
      'NewAccount resource profile request非法'
    );
  }
  return createNewAccountGenerationResourceEstimate(request.input, request.staticPhase).resources;
}

module.exports = {
  FIXED_MEMORY_ENVELOPE_BYTES,
  MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES,
  MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL,
  NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION,
  NewAccountResourceEstimateError,
  createNewAccountGenerationResourceEstimate,
  estimateNewAccountGenerationMemory,
  estimateNewAccountGenerationPhaseResources
};
