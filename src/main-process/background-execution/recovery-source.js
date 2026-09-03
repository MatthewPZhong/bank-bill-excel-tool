'use strict';

const recoverySourceSchema = require('./schemas/platform-recovery-source-v1.schema.json');
const { canonicalJsonSnapshot, canonicalSha256, canonicalizeJson } = require('./canonical-json-v1');
const { createSchemaValidator, SchemaValidationError } = require('./schema-validator');

const RECOVERY_EVIDENCE_MAX_BYTES = 65536;
const RECOVERY_ENVELOPE_MAX_BYTES = 131072;
const SOURCE_IDENTITY_FIELDS = Object.freeze([
  'sourceKind', 'sourceRef', 'actionKey', 'operationKey', 'taskRunId'
]);

class RecoverySourceValidationError extends Error {
  constructor(code, message, path = '/', details = null) {
    super(message);
    this.name = 'RecoverySourceValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function definitionValidator(definition) {
  const runtimeSchema = createRuntimeSchemaView();
  return createSchemaValidator({
    $schema: runtimeSchema.$schema,
    $defs: runtimeSchema.$defs,
    $ref: `#/$defs/${definition}`
  }, { schemaName: definition });
}

// 冻结 authority 的 identityFields 是供其它 definition 复用的 property map，
// 而不是可独立求值的 JSON Schema。编译时只展开这些叶子引用，不改写或
// 放宽对外发布的 authority schema。
function createRuntimeSchemaView() {
  const identityFields = recoverySourceSchema.$defs.identityFields;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/identityFields/')) {
      const field = value.$ref.slice('#/$defs/identityFields/'.length);
      return visit(identityFields[field]);
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !(key === 'identityFields' && value === recoverySourceSchema.$defs))
      .map(([key, nested]) => [key, visit(nested)]));
  };
  return visit(recoverySourceSchema);
}

const runtimeRecoverySourceSchema = createRuntimeSchemaView();
const sourceValidator = createSchemaValidator(runtimeRecoverySourceSchema, {
  schemaName: 'RecoverySourceV1'
});
const inspectionValidator = definitionValidator('RecoveryInspectionResultV1');
const settlementValidator = definitionValidator('SettlementRecoveryResultV1');

function validate(validator, input, code) {
  try {
    const owned = canonicalJsonSnapshot(input, { maxBytes: RECOVERY_ENVELOPE_MAX_BYTES });
    validator.assertValid(owned, code);
    return owned;
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new RecoverySourceValidationError(code, error.message, error.path, error.errors);
    }
    if (error && typeof error.code === 'string' && error.code.startsWith('CANONICAL_JSON_')) {
      throw new RecoverySourceValidationError(
        code,
        'Recovery contract value 必须是有界 canonical plain JSON',
        error.path || '/',
        { causeCode: error.code }
      );
    }
    throw error;
  }
}

function validateBoundedObject(value, path) {
  try {
    canonicalizeJson(value, { maxBytes: RECOVERY_EVIDENCE_MAX_BYTES });
  } catch (error) {
    throw new RecoverySourceValidationError(
      'RECOVERY_SOURCE_EVIDENCE_INVALID',
      `${path} 必须是至多 ${RECOVERY_EVIDENCE_MAX_BYTES} UTF-8 bytes 的 canonical plain JSON object`,
      path,
      error && error.code ? { causeCode: error.code } : null
    );
  }
}

function normalizeRecoverySource(input) {
  const source = validate(sourceValidator, input, 'RECOVERY_SOURCE_INVALID');
  validateBoundedObject(source.boundedEvidence, '/boundedEvidence');
  return Object.freeze(source);
}

function assertIdentity(source, result, code) {
  for (const field of SOURCE_IDENTITY_FIELDS) {
    if (result[field] !== source[field]) {
      throw new RecoverySourceValidationError(
        code,
        `${field} 与 RecoverySourceV1 identity 不一致`,
        `/${field}`
      );
    }
  }
}

function normalizeRecoveryInspectionResult(sourceInput, resultInput) {
  const source = normalizeRecoverySource(sourceInput);
  const result = validate(
    inspectionValidator,
    resultInput,
    'RECOVERY_INSPECTION_RESULT_INVALID'
  );
  validateBoundedObject(result.boundedEvidence, '/boundedEvidence');
  assertIdentity(source, result, 'RECOVERY_INSPECTION_IDENTITY_MISMATCH');
  const evidenceHash = canonicalSha256(result.boundedEvidence);
  if (result.evidenceHash !== evidenceHash) {
    throw new RecoverySourceValidationError(
      'RECOVERY_INSPECTION_EVIDENCE_HASH_MISMATCH',
      'inspection evidenceHash 与 boundedEvidence canonical SHA-256 不一致',
      '/evidenceHash'
    );
  }
  return Object.freeze(result);
}

function normalizeSettlementRecoveryResult(sourceInput, inspectionInput, resultInput) {
  const source = normalizeRecoverySource(sourceInput);
  const inspection = normalizeRecoveryInspectionResult(source, inspectionInput);
  const result = validate(
    settlementValidator,
    resultInput,
    'SETTLEMENT_RECOVERY_RESULT_INVALID'
  );
  validateBoundedObject(result.boundedResult, '/boundedResult');
  assertIdentity(source, result, 'SETTLEMENT_RECOVERY_IDENTITY_MISMATCH');
  if (source.settlementKey === null || result.settlementKey !== source.settlementKey) {
    throw new RecoverySourceValidationError(
      'SETTLEMENT_RECOVERY_KEY_MISMATCH',
      'settlementKey 与 RecoverySourceV1 不一致',
      '/settlementKey'
    );
  }
  if (result.inspectionEvidenceHash !== inspection.evidenceHash) {
    throw new RecoverySourceValidationError(
      'SETTLEMENT_RECOVERY_INSPECTION_HASH_MISMATCH',
      'inspectionEvidenceHash 与唯一 inspection 不一致',
      '/inspectionEvidenceHash'
    );
  }
  const resultHash = canonicalSha256(result.boundedResult);
  if (result.resultHash !== resultHash) {
    throw new RecoverySourceValidationError(
      'SETTLEMENT_RECOVERY_RESULT_HASH_MISMATCH',
      'resultHash 与 boundedResult canonical SHA-256 不一致',
      '/resultHash'
    );
  }
  return Object.freeze(result);
}

module.exports = {
  RECOVERY_EVIDENCE_MAX_BYTES,
  RECOVERY_ENVELOPE_MAX_BYTES,
  RecoverySourceValidationError,
  normalizeRecoveryInspectionResult,
  normalizeRecoverySource,
  normalizeSettlementRecoveryResult,
  recoverySourceSchema
};
