'use strict';

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');

const IMPORT_KEYS = Object.freeze(['command', 'sessionKey', 'sources', 'templateEvidence']);
const SOURCE_KEYS = Object.freeze(['resourceId', 'snapshot']);
const TEMPLATE_EVIDENCE_KEYS = Object.freeze(['digest', 'snapshot']);
const TEMPLATE_KEYS = Object.freeze([
  'templateId',
  'templateName',
  'expectedSourceHeaders',
  'orderedTargetFields',
  'mappingByField',
  'accountMappingByBankId',
  'currencyMappings',
  'amountMappingRules',
  'amountSplitByField',
  'billSplitMerge',
  'dateParseOrder'
]);
const MAX_IMPORT_INPUT_BYTES = 1024 * 1024;
const MAX_IMPORT_SOURCES = 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_TEMPLATE_STATE_KEYS = new Set([
  'detailRows',
  'fileEntries',
  'preparedBatch',
  'preparedRows',
  'preparedDetailRows',
  'privateContext',
  'selectedBigAccount'
]);

class StatementImportContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementImportContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatementImportContractError(code, message);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('STATEMENT_IMPORT_SHAPE_INVALID', `${label} must be a plain object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    fail('STATEMENT_IMPORT_KEYS_INVALID', `${label} must contain exact keys`);
  }
  return value;
}

function boundedText(value, label, maxLength = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail('STATEMENT_IMPORT_TEXT_INVALID', `${label} must be a bounded non-empty string`);
  }
  return value;
}

function stringArray(value, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength ||
      value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 512)) {
    fail('STATEMENT_IMPORT_ARRAY_INVALID', `${label} must be a bounded string array`);
  }
  return value.slice();
}

function plainJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('STATEMENT_IMPORT_CONFIG_INVALID', `${label} must be a plain JSON object`);
  }
  return canonicalJsonSnapshot(value);
}

function nullableJson(value, label, { objectOnly = false } = {}) {
  if (value === null) return null;
  if (objectOnly) return plainJsonObject(value, label);
  return canonicalJsonSnapshot(value);
}

function assertNoRetainedBusinessState(value, label) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRetainedBusinessState(item, `${label}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_TEMPLATE_STATE_KEYS.has(key)) {
      fail('STATEMENT_IMPORT_PRIVATE_STATE_FORBIDDEN', `${label}.${key} is not template evidence`);
    }
    assertNoRetainedBusinessState(item, `${label}.${key}`);
  }
}

function createStatementTemplateSnapshot(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_IMPORT_INPUT_BYTES });
  const record = exactRecord(value, TEMPLATE_KEYS, 'StatementTemplateSnapshot');
  assertNoRetainedBusinessState(value, 'StatementTemplateSnapshot');
  const templateId = typeof record.templateId === 'string'
    ? boundedText(record.templateId, 'templateId', 128)
    : (Number.isSafeInteger(record.templateId) && record.templateId > 0
        ? String(record.templateId)
        : fail('STATEMENT_IMPORT_TEMPLATE_INVALID', 'templateId must be a string or positive integer'));
  const templateName = boundedText(record.templateName, 'templateName', 512);
  const expectedSourceHeaders = stringArray(
    record.expectedSourceHeaders,
    'expectedSourceHeaders',
    4096
  );
  if (expectedSourceHeaders.length === 0) {
    fail('STATEMENT_IMPORT_TEMPLATE_INVALID', 'expectedSourceHeaders must not be empty');
  }
  const orderedTargetFields = stringArray(
    record.orderedTargetFields,
    'orderedTargetFields',
    4096
  );
  if (orderedTargetFields.length === 0) {
    fail('STATEMENT_IMPORT_TEMPLATE_INVALID', 'orderedTargetFields must not be empty');
  }
  return canonicalJsonSnapshot({
    templateId,
    templateName,
    expectedSourceHeaders,
    orderedTargetFields,
    mappingByField: plainJsonObject(record.mappingByField, 'mappingByField'),
    accountMappingByBankId: plainJsonObject(
      record.accountMappingByBankId,
      'accountMappingByBankId'
    ),
    currencyMappings: Array.isArray(record.currencyMappings)
      ? canonicalJsonSnapshot(record.currencyMappings)
      : fail('STATEMENT_IMPORT_CONFIG_INVALID', 'currencyMappings must be an array'),
    amountMappingRules: plainJsonObject(record.amountMappingRules, 'amountMappingRules'),
    amountSplitByField: nullableJson(
      record.amountSplitByField,
      'amountSplitByField',
      { objectOnly: true }
    ),
    billSplitMerge: nullableJson(
      record.billSplitMerge,
      'billSplitMerge',
      { objectOnly: true }
    ),
    dateParseOrder: boundedText(record.dateParseOrder, 'dateParseOrder', 32)
  });
}

function createStatementTemplateEvidence(snapshot) {
  const owned = createStatementTemplateSnapshot(snapshot);
  return Object.freeze({
    digest: canonicalSha256(owned),
    snapshot: owned
  });
}

function createStatementImportRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_IMPORT_INPUT_BYTES });
  const record = exactRecord(value, IMPORT_KEYS, 'StatementImportRequest');
  if (record.command !== 'import') {
    fail('STATEMENT_IMPORT_COMMAND_INVALID', 'Statement import command must be import');
  }
  const sessionKey = boundedText(record.sessionKey, 'sessionKey', 512);
  if (!Array.isArray(record.sources) || record.sources.length === 0 ||
      record.sources.length > MAX_IMPORT_SOURCES) {
    fail('STATEMENT_IMPORT_SOURCES_INVALID', 'sources must contain 1..1024 resources');
  }
  const resourceIds = new Set();
  const sources = record.sources.map((source, index) => {
    const item = exactRecord(source, SOURCE_KEYS, `sources[${index}]`);
    const resourceId = boundedText(item.resourceId, `sources[${index}].resourceId`, 256);
    if (resourceIds.has(resourceId)) {
      fail('STATEMENT_IMPORT_SOURCE_DUPLICATE', `Duplicate resourceId: ${resourceId}`);
    }
    resourceIds.add(resourceId);
    const snapshot = normalizeSourceSnapshot(item.snapshot);
    if (!snapshot) {
      fail('STATEMENT_IMPORT_SOURCE_EVIDENCE_INVALID', `sources[${index}].snapshot is invalid`);
    }
    return Object.freeze({
      resourceId,
      snapshot: Object.freeze({ ...snapshot })
    });
  });
  const evidence = exactRecord(
    record.templateEvidence,
    TEMPLATE_EVIDENCE_KEYS,
    'StatementTemplateEvidence'
  );
  const templateSnapshot = createStatementTemplateSnapshot(evidence.snapshot);
  if (!SHA256_PATTERN.test(evidence.digest) || canonicalSha256(templateSnapshot) !== evidence.digest) {
    fail('STATEMENT_IMPORT_TEMPLATE_EVIDENCE_INVALID', 'Template digest does not match snapshot');
  }
  if (sessionKey !== templateSnapshot.templateId) {
    fail('STATEMENT_IMPORT_SESSION_TEMPLATE_MISMATCH', 'sessionKey must equal templateId');
  }
  return Object.freeze({
    command: 'import',
    sessionKey,
    sources: Object.freeze(sources),
    templateEvidence: Object.freeze({
      digest: evidence.digest,
      snapshot: templateSnapshot
    })
  });
}

function createStatementStatusRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: 1024 });
  exactRecord(value, ['command'], 'StatementStatusRequest');
  if (value.command !== 'status') {
    fail('STATEMENT_IMPORT_COMMAND_INVALID', 'Statement status command must be status');
  }
  return Object.freeze({ command: 'status' });
}

function createStatementServiceRequest(input) {
  const snapshot = canonicalJsonSnapshot(input, { maxBytes: MAX_IMPORT_INPUT_BYTES });
  const command = Object.getOwnPropertyDescriptor(snapshot, 'command');
  if (!command || !Object.hasOwn(command, 'value')) {
    fail('STATEMENT_IMPORT_COMMAND_INVALID', 'Statement command is required');
  }
  return command.value === 'status'
    ? createStatementStatusRequest(snapshot)
    : createStatementImportRequest(snapshot);
}

module.exports = {
  MAX_IMPORT_INPUT_BYTES,
  StatementImportContractError,
  createStatementImportRequest,
  createStatementServiceRequest,
  createStatementStatusRequest,
  createStatementTemplateEvidence,
  createStatementTemplateSnapshot
};
