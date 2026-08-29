'use strict';

const { validateResourceVector } = require('../background-execution/resource-lease');
const {
  MAX_RECORDS,
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS,
  createNewAccountGenerationInput,
  projectNewAccountGenerationShape
} = require('./generation-contract');

const MEBIBYTE = 1024 ** 2;
const NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION = 2;
// 固定项覆盖独立 executor、writer/readback 基线与不可归因波动；可变项分别描述
// records/cells 结构及 writer/readback 对同一业务文本的 UTF-8/UTF-16 多份驻留。
// RSS 只用于向上校准这些确定性项，不直接进入单测断言。
const NEW_ACCOUNT_GENERATION_MEMORY_MODEL = Object.freeze({
  executorBaselineBytes: 256 * MEBIBYTE,
  writerFixedEnvelopeBytes: 64 * MEBIBYTE,
  readbackFixedEnvelopeBytes: 64 * MEBIBYTE,
  safetyMarginBytes: 256 * MEBIBYTE,
  perProjectedRecordBytes: 2048,
  perProjectedCellBytes: 384,
  writerUtf8TextCopies: 3,
  writerUtf16TextCopies: 3,
  writerCellEncodedUtf8Copies: 2,
  readbackUtf8TextCopies: 2,
  readbackUtf16TextCopies: 2,
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

function checkedSum(values, label) {
  return values.reduce((sum, value) => checkedAdd(sum, value, label), 0);
}

const FIXED_MEMORY_ENVELOPE_BYTES = checkedSum([
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.executorBaselineBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.writerFixedEnvelopeBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackFixedEnvelopeBytes,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL.safetyMarginBytes
], '固定内存 envelope');

const MAX_OUTPUT_TEXT_CODE_UNITS_PER_RECORD = checkedSum([
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.bankNameCodeUnits,
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.locationCodeUnits,
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.bankAccountCodeUnits,
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.currencyCodeUnits
], '单行最大文本 code units');
const MAX_OUTPUT_TEXT_UTF8_BYTES_PER_RECORD = checkedAdd(
  checkedMultiply(
    MAX_OUTPUT_TEXT_CODE_UNITS_PER_RECORD,
    NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.maxUtf8BytesPerCodeUnit,
    '单行最大 UTF-8 文本'
  ),
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf8Bytes,
  '单行最大 UTF-8 文本'
);
const MAX_OUTPUT_TEXT_UTF16_BYTES_PER_RECORD = checkedAdd(
  checkedMultiply(MAX_OUTPUT_TEXT_CODE_UNITS_PER_RECORD, 2, '单行最大 UTF-16 文本'),
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf16Bytes,
  '单行最大 UTF-16 文本'
);
const MAX_OUTPUT_CELL_ENCODED_UTF8_BYTES_PER_RECORD = checkedAdd(
  checkedMultiply(
    MAX_OUTPUT_TEXT_CODE_UNITS_PER_RECORD,
    NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.maxCellEncodedUtf8BytesPerCodeUnit,
    '单行最大单元格编码文本'
  ),
  NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputDateUtf8Bytes,
  '单行最大单元格编码文本'
);

function validateProjectionShape(value) {
  const keys = [
    'projectedOutputRows',
    'projectedOutputCells',
    'repeatedTextUtf8Bytes',
    'repeatedTextUtf16Bytes',
    'repeatedCellEncodedUtf8Bytes'
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_SHAPE_INVALID',
      'NewAccount generation shape必须是非负安全整数摘要'
    );
  }
  if (value.projectedOutputRows > MAX_RECORDS) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_ROW_LIMIT',
      `预计输出行数不得超过 ${MAX_RECORDS}`
    );
  }
  const expectedCells = checkedMultiply(
    value.projectedOutputRows,
    NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputCellsPerRecord,
    '预计输出单元格数'
  );
  if (value.projectedOutputCells !== expectedCells) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_SHAPE_INVALID',
      '预计输出单元格数与冻结行形状不一致'
    );
  }
  return value;
}

function calculateNewAccountGenerationMemory(rawShape) {
  const shape = validateProjectionShape(rawShape);
  const projectedRecordEnvelopeBytes = checkedMultiply(
    shape.projectedOutputRows,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.perProjectedRecordBytes,
    '预计记录结构内存'
  );
  const projectedCellEnvelopeBytes = checkedMultiply(
    shape.projectedOutputCells,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.perProjectedCellBytes,
    '预计单元格结构内存'
  );
  const writerUtf8TextBytes = checkedMultiply(
    shape.repeatedTextUtf8Bytes,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.writerUtf8TextCopies,
    'Writer UTF-8文本驻留'
  );
  const writerUtf16TextBytes = checkedMultiply(
    shape.repeatedTextUtf16Bytes,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.writerUtf16TextCopies,
    'Writer UTF-16文本驻留'
  );
  const writerCellEncodedUtf8Bytes = checkedMultiply(
    shape.repeatedCellEncodedUtf8Bytes,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.writerCellEncodedUtf8Copies,
    'Writer单元格编码文本驻留'
  );
  const readbackUtf8TextBytes = checkedMultiply(
    shape.repeatedTextUtf8Bytes,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackUtf8TextCopies,
    'Readback UTF-8文本驻留'
  );
  const readbackUtf16TextBytes = checkedMultiply(
    shape.repeatedTextUtf16Bytes,
    NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackUtf16TextCopies,
    'Readback UTF-16文本驻留'
  );
  const maxUtf8Bytes = checkedMultiply(
    shape.projectedOutputRows,
    MAX_OUTPUT_TEXT_UTF8_BYTES_PER_RECORD,
    '冻结最大 UTF-8文本'
  );
  const maxUtf16Bytes = checkedMultiply(
    shape.projectedOutputRows,
    MAX_OUTPUT_TEXT_UTF16_BYTES_PER_RECORD,
    '冻结最大 UTF-16文本'
  );
  const maxCellEncodedUtf8Bytes = checkedMultiply(
    shape.projectedOutputRows,
    MAX_OUTPUT_CELL_ENCODED_UTF8_BYTES_PER_RECORD,
    '冻结最大单元格编码文本'
  );
  if (shape.repeatedTextUtf8Bytes > maxUtf8Bytes || shape.repeatedTextUtf16Bytes > maxUtf16Bytes ||
      shape.repeatedCellEncodedUtf8Bytes > maxCellEncodedUtf8Bytes) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_SHAPE_BOUNDS',
      '预计重复文本超过冻结字段上界'
    );
  }
  const memoryBytes = checkedSum([
    FIXED_MEMORY_ENVELOPE_BYTES,
    projectedRecordEnvelopeBytes,
    projectedCellEnvelopeBytes,
    writerUtf8TextBytes,
    writerUtf16TextBytes,
    writerCellEncodedUtf8Bytes,
    readbackUtf8TextBytes,
    readbackUtf16TextBytes
  ], 'NewAccount generation 内存');
  return Object.freeze({
    memoryBytes,
    components: Object.freeze({
      executorBaselineBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.executorBaselineBytes,
      writerFixedEnvelopeBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.writerFixedEnvelopeBytes,
      readbackFixedEnvelopeBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.readbackFixedEnvelopeBytes,
      safetyMarginBytes: NEW_ACCOUNT_GENERATION_MEMORY_MODEL.safetyMarginBytes,
      projectedRecordEnvelopeBytes,
      projectedCellEnvelopeBytes,
      writerUtf8TextBytes,
      writerUtf16TextBytes,
      writerCellEncodedUtf8Bytes,
      readbackUtf8TextBytes,
      readbackUtf16TextBytes
    })
  });
}

const MAX_NEW_ACCOUNT_GENERATION_SHAPE = Object.freeze({
  projectedOutputRows: MAX_RECORDS,
  projectedOutputCells: checkedMultiply(
    MAX_RECORDS,
    NEW_ACCOUNT_GENERATION_SHAPE_LIMITS.outputCellsPerRecord,
    '最大输出单元格数'
  ),
  repeatedTextUtf8Bytes: checkedMultiply(
    MAX_RECORDS,
    MAX_OUTPUT_TEXT_UTF8_BYTES_PER_RECORD,
    '最大重复 UTF-8文本'
  ),
  repeatedTextUtf16Bytes: checkedMultiply(
    MAX_RECORDS,
    MAX_OUTPUT_TEXT_UTF16_BYTES_PER_RECORD,
    '最大重复 UTF-16文本'
  ),
  repeatedCellEncodedUtf8Bytes: checkedMultiply(
    MAX_RECORDS,
    MAX_OUTPUT_CELL_ENCODED_UTF8_BYTES_PER_RECORD,
    '最大重复单元格编码文本'
  )
});
const MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES = FIXED_MEMORY_ENVELOPE_BYTES;
const MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES = calculateNewAccountGenerationMemory(
  MAX_NEW_ACCOUNT_GENERATION_SHAPE
).memoryBytes;

function estimateNewAccountGenerationMemory(shape) {
  const memory = calculateNewAccountGenerationMemory(shape);
  if (memory.memoryBytes < MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES ||
      memory.memoryBytes > MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES) {
    throw new NewAccountResourceEstimateError(
      'NEW_ACCOUNT_RESOURCE_ESTIMATE_BOUNDS',
      'NewAccount generation 内存估算超出冻结上下界'
    );
  }
  return memory;
}

function createNewAccountGenerationResourceEstimate(rawInput, staticPhaseResources) {
  const input = createNewAccountGenerationInput(rawInput);
  const staticPhase = validateResourceVector(staticPhaseResources, 'newAccountStaticPhase');
  const shape = projectNewAccountGenerationShape(input.accounts, input.asOfDate);
  const memory = estimateNewAccountGenerationMemory(shape);
  return Object.freeze({
    modelVersion: NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION,
    ...shape,
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
  MAX_NEW_ACCOUNT_GENERATION_SHAPE,
  MAX_OUTPUT_CELL_ENCODED_UTF8_BYTES_PER_RECORD,
  MAX_OUTPUT_TEXT_UTF8_BYTES_PER_RECORD,
  MAX_OUTPUT_TEXT_UTF16_BYTES_PER_RECORD,
  MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES,
  NEW_ACCOUNT_GENERATION_MEMORY_MODEL,
  NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION,
  NewAccountResourceEstimateError,
  createNewAccountGenerationResourceEstimate,
  estimateNewAccountGenerationMemory,
  estimateNewAccountGenerationPhaseResources
};
