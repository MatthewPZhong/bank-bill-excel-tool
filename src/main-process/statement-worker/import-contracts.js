'use strict';

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');

const IMPORT_KEYS = Object.freeze(['command', 'sessionOwner', 'sources', 'templateCatalog']);
const SESSION_OWNER_KEYS = Object.freeze(['sessionKey', 'templateId', 'templateName']);
const SOURCE_KEYS = Object.freeze(['resourceId', 'snapshot', 'templateRef']);
const TEMPLATE_CATALOG_ENTRY_KEYS = Object.freeze(['templateRef', 'digest', 'snapshot']);
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
const TEMPLATE_INTERACTION_KEYS = Object.freeze(['bigAccounts', 'fixedAssignments']);
const MAX_IMPORT_INPUT_BYTES = 1024 * 1024;
const MAX_IMPORT_SOURCES = 1024;
const MAX_TEMPLATE_CATALOG_ENTRIES = 1024;
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

function templateIdentity(value, label) {
  if (typeof value === 'string') return boundedText(value, label, 128);
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail('STATEMENT_IMPORT_TEMPLATE_INVALID', `${label} must be a string or positive integer`);
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
  const interactionKeys = TEMPLATE_INTERACTION_KEYS.filter((key) => Object.hasOwn(value, key));
  const record = exactRecord(value, TEMPLATE_KEYS.concat(interactionKeys), 'StatementTemplateSnapshot');
  assertNoRetainedBusinessState(value, 'StatementTemplateSnapshot');
  const templateId = templateIdentity(record.templateId, 'templateId');
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
  const result = {
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
  };
  if (interactionKeys.includes('bigAccounts')) {
    if (!Array.isArray(record.bigAccounts) || record.bigAccounts.length > 1024) {
      fail('STATEMENT_IMPORT_CONFIG_INVALID', 'bigAccounts must be a bounded array');
    }
    result.bigAccounts = canonicalJsonSnapshot(record.bigAccounts);
  }
  if (interactionKeys.includes('fixedAssignments')) {
    if (!Array.isArray(record.fixedAssignments) || record.fixedAssignments.length > 1024) {
      fail('STATEMENT_IMPORT_CONFIG_INVALID', 'fixedAssignments must be a bounded array');
    }
    result.fixedAssignments = canonicalJsonSnapshot(record.fixedAssignments);
  }
  return canonicalJsonSnapshot(result);
}

function createStatementTemplateEvidence(snapshot) {
  const owned = createStatementTemplateSnapshot(snapshot);
  return Object.freeze({
    digest: canonicalSha256(owned),
    snapshot: owned
  });
}

function createStatementTemplateCatalogEntry(templateRef, snapshot) {
  const evidence = createStatementTemplateEvidence(snapshot);
  return Object.freeze({
    templateRef: boundedText(templateRef, 'templateRef', 128),
    digest: evidence.digest,
    snapshot: evidence.snapshot
  });
}

function createStatementImportRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_IMPORT_INPUT_BYTES });
  const record = exactRecord(value, IMPORT_KEYS, 'StatementImportRequest');
  if (record.command !== 'import') {
    fail('STATEMENT_IMPORT_COMMAND_INVALID', 'Statement import command must be import');
  }
  const owner = exactRecord(record.sessionOwner, SESSION_OWNER_KEYS, 'StatementSessionOwner');
  const sessionOwner = Object.freeze({
    sessionKey: boundedText(owner.sessionKey, 'sessionOwner.sessionKey', 512),
    templateId: templateIdentity(owner.templateId, 'sessionOwner.templateId'),
    templateName: boundedText(owner.templateName, 'sessionOwner.templateName', 512)
  });
  if (!Array.isArray(record.templateCatalog) || record.templateCatalog.length === 0 ||
      record.templateCatalog.length > MAX_TEMPLATE_CATALOG_ENTRIES) {
    fail(
      'STATEMENT_IMPORT_TEMPLATE_CATALOG_INVALID',
      'templateCatalog must contain 1..1024 entries'
    );
  }
  const templateRefs = new Set();
  const templateIds = new Set();
  const templateCatalog = record.templateCatalog.map((item, index) => {
    const evidence = exactRecord(
      item,
      TEMPLATE_CATALOG_ENTRY_KEYS,
      `templateCatalog[${index}]`
    );
    const templateRef = boundedText(
      evidence.templateRef,
      `templateCatalog[${index}].templateRef`,
      128
    );
    if (templateRefs.has(templateRef)) {
      fail('STATEMENT_IMPORT_TEMPLATE_REF_DUPLICATE', `Duplicate templateRef: ${templateRef}`);
    }
    const templateSnapshot = createStatementTemplateSnapshot(evidence.snapshot);
    if (templateIds.has(templateSnapshot.templateId)) {
      fail(
        'STATEMENT_IMPORT_TEMPLATE_ID_DUPLICATE',
        `Duplicate templateId in templateCatalog: ${templateSnapshot.templateId}`
      );
    }
    if (!SHA256_PATTERN.test(evidence.digest) ||
        canonicalSha256(templateSnapshot) !== evidence.digest) {
      fail(
        'STATEMENT_IMPORT_TEMPLATE_EVIDENCE_INVALID',
        `Template digest does not match snapshot for ${templateRef}`
      );
    }
    templateRefs.add(templateRef);
    templateIds.add(templateSnapshot.templateId);
    return Object.freeze({
      templateRef,
      digest: evidence.digest,
      snapshot: templateSnapshot
    });
  });
  if (!Array.isArray(record.sources) || record.sources.length === 0 ||
      record.sources.length > MAX_IMPORT_SOURCES) {
    fail('STATEMENT_IMPORT_SOURCES_INVALID', 'sources must contain 1..1024 resources');
  }
  const resourceIds = new Set();
  const sources = record.sources.map((source, index) => {
    const item = exactRecord(source, SOURCE_KEYS, `sources[${index}]`);
    const resourceId = boundedText(item.resourceId, `sources[${index}].resourceId`, 256);
    const templateRef = boundedText(item.templateRef, `sources[${index}].templateRef`, 128);
    if (resourceIds.has(resourceId)) {
      fail('STATEMENT_IMPORT_SOURCE_DUPLICATE', `Duplicate resourceId: ${resourceId}`);
    }
    if (!templateRefs.has(templateRef)) {
      fail(
        'STATEMENT_IMPORT_TEMPLATE_REF_UNKNOWN',
        `sources[${index}].templateRef is not in templateCatalog`
      );
    }
    resourceIds.add(resourceId);
    const snapshot = normalizeSourceSnapshot(item.snapshot);
    if (!snapshot) {
      fail('STATEMENT_IMPORT_SOURCE_EVIDENCE_INVALID', `sources[${index}].snapshot is invalid`);
    }
    return Object.freeze({
      resourceId,
      snapshot: Object.freeze({ ...snapshot }),
      templateRef
    });
  });
  const usedTemplateRefs = new Set(sources.map((source) => source.templateRef));
  if (usedTemplateRefs.size !== templateCatalog.length) {
    fail(
      'STATEMENT_IMPORT_TEMPLATE_CATALOG_UNUSED',
      'Every templateCatalog entry must be referenced by at least one source'
    );
  }
  return Object.freeze({
    command: 'import',
    sessionOwner,
    sources: Object.freeze(sources),
    templateCatalog: Object.freeze(templateCatalog)
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
  MAX_TEMPLATE_CATALOG_ENTRIES,
  StatementImportContractError,
  createStatementImportRequest,
  createStatementServiceRequest,
  createStatementStatusRequest,
  createStatementTemplateCatalogEntry,
  createStatementTemplateEvidence,
  createStatementTemplateSnapshot
};
