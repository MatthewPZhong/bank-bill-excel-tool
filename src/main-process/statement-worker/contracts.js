'use strict';

const { types: utilTypes } = require('node:util');

const {
  canonicalJsonSnapshot,
  canonicalizeJson
} = require('../background-execution/canonical-json-v1');

const MEBIBYTE = 1024 ** 2;
const STATEMENT_PURPOSES = Object.freeze([
  'big-account',
  'manual-balance',
  'scope-generation'
]);
const STATEMENT_ACTIVE_PHASES = Object.freeze([
  'idle',
  'import',
  'resolve-big-account',
  'resolve-manual-balance',
  'generate-current',
  'generate-all',
  'waiting-user'
]);
const STATEMENT_RESOURCE_CONTRACT = Object.freeze({
  serviceKey: 'service.statement',
  stateFootprintEstimatorKey: 'footprint.statement',
  persistentStateBudgetBytes: 256 * MEBIBYTE,
  pendingInteractionBudgetBytes: 256 * MEBIBYTE,
  protocolEnvelopeMaxBytes: 256 * 1024,
  statusMaxBytes: 1 * MEBIBYTE,
  publicInteractionMaxBytes: 256 * 1024,
  tokenMaxOutstanding: 1,
  tokenTtlMs: 15 * 60 * 1000,
  tokenSingleUse: true,
  allowedRequestKinds: Object.freeze([
    'persistent-state-replace',
    'pending-interaction-create',
    'phase-extension'
  ]),
  maxPendingRequests: 8,
  grantTimeoutMs: 30000,
  adoptionTimeoutMs: 30000
});

const TOKEN_HANDLE_KEYS = Object.freeze([
  'tokenId',
  'purpose',
  'serviceGeneration',
  'sessionKey',
  'sessionRevision',
  'expiresAt',
  'allowedChoiceDigest',
  'reservationId'
]);
const STATUS_KEYS = Object.freeze([
  'serviceGeneration',
  'sessionRevision',
  'sessionCount',
  'batchCount',
  'fileCount',
  'rowCount',
  'pendingInteractionCount',
  'pendingInteractions',
  'activePhase'
]);
const STATUS_INTERACTION_KEYS = Object.freeze(['purpose', 'expiresAt']);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'detailRows',
  'preparedBatch',
  'preparedDetailRows',
  'fileEntries',
  'inputFilePath',
  'inputFilePaths',
  'filePath',
  'sourceSelections',
  'assertSessionCurrent',
  'sessionKey',
  'reservationId',
  'grantId',
  'privateContext'
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class StatementContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StatementContractError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new StatementContractError(code, message, details);
}

function ownDataRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('STATEMENT_DTO_SHAPE_INVALID', `${label} must be a plain non-Proxy object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol') ||
      ownKeys.length !== keys.length ||
      keys.some((key) => !ownKeys.includes(key))) {
    fail('STATEMENT_DTO_KEYS_INVALID', `${label} must contain exact keys`, {
      expectedKeys: keys.slice(),
      actualKeys: ownKeys.map(String)
    });
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('STATEMENT_DTO_PROPERTY_INVALID', `${label}.${key} must be an enumerable own data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedText(value, label, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail('STATEMENT_DTO_TEXT_INVALID', `${label} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('STATEMENT_DTO_INTEGER_INVALID', `${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('STATEMENT_DTO_INTEGER_INVALID', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function purpose(value, label = 'purpose') {
  if (!STATEMENT_PURPOSES.includes(value)) {
    fail('STATEMENT_TOKEN_PURPOSE_INVALID', `${label} is not a supported Statement interaction purpose`);
  }
  return value;
}

function createStatementTokenHandleDto(input) {
  const record = ownDataRecord(input, TOKEN_HANDLE_KEYS, 'StatementTokenHandleDto');
  const snapshot = {
    tokenId: boundedText(record.tokenId, 'tokenId'),
    purpose: purpose(record.purpose),
    serviceGeneration: positiveInteger(record.serviceGeneration, 'serviceGeneration'),
    sessionKey: boundedText(record.sessionKey, 'sessionKey', 512),
    sessionRevision: nonNegativeInteger(record.sessionRevision, 'sessionRevision'),
    expiresAt: positiveInteger(record.expiresAt, 'expiresAt'),
    allowedChoiceDigest: record.allowedChoiceDigest,
    reservationId: boundedText(record.reservationId, 'reservationId')
  };
  if (!SHA256_PATTERN.test(snapshot.allowedChoiceDigest)) {
    fail('STATEMENT_TOKEN_DIGEST_INVALID', 'allowedChoiceDigest must be a lowercase SHA-256 digest');
  }
  return canonicalJsonSnapshot(snapshot);
}

function assertNoPrivatePublicKeys(value, path = '', ancestors = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertNoPrivatePublicKeys(item, `${path}/${index}`, ancestors));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (FORBIDDEN_PUBLIC_KEYS.has(key) || normalizedKey.endsWith('path') ||
          normalizedKey.endsWith('paths')) {
        fail('STATEMENT_PUBLIC_DTO_PRIVATE_FIELD', `Statement public DTO contains private field ${key}`, {
          path: `${path}/${key}`
        });
      }
      assertNoPrivatePublicKeys(item, `${path}/${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function createStatementPublicInteractionDto({ token, prompt }) {
  const handle = createStatementTokenHandleDto(token);
  let promptSnapshot;
  try {
    promptSnapshot = canonicalJsonSnapshot(prompt);
  } catch (_error) {
    fail('STATEMENT_PUBLIC_DTO_JSON_INVALID', 'Statement public prompt must be safe plain JSON');
  }
  assertNoPrivatePublicKeys(promptSnapshot, '/prompt');
  const result = {
    tokenId: handle.tokenId,
    purpose: handle.purpose,
    serviceGeneration: handle.serviceGeneration,
    sessionRevision: handle.sessionRevision,
    expiresAt: handle.expiresAt,
    allowedChoiceDigest: handle.allowedChoiceDigest,
    prompt: promptSnapshot
  };
  try {
    canonicalizeJson(result, { maxBytes: STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes });
  } catch (_error) {
    fail(
      'STATEMENT_PUBLIC_DTO_TOO_LARGE',
      `Statement public interaction DTO exceeds ${STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes} bytes`
    );
  }
  return canonicalJsonSnapshot(result);
}

function createStatementStatusDto(input) {
  const record = ownDataRecord(input, STATUS_KEYS, 'StatementStatusDto');
  if (!STATEMENT_ACTIVE_PHASES.includes(record.activePhase)) {
    fail('STATEMENT_STATUS_PHASE_INVALID', 'activePhase is not a supported Statement phase');
  }
  if (!Array.isArray(record.pendingInteractions)) {
    fail('STATEMENT_STATUS_INTERACTIONS_INVALID', 'pendingInteractions must be an array');
  }
  const pendingInteractions = record.pendingInteractions.map((item, index) => {
    const pending = ownDataRecord(item, STATUS_INTERACTION_KEYS, `pendingInteractions[${index}]`);
    return {
      purpose: purpose(pending.purpose, `pendingInteractions[${index}].purpose`),
      expiresAt: positiveInteger(pending.expiresAt, `pendingInteractions[${index}].expiresAt`)
    };
  });
  const result = {
    serviceGeneration: positiveInteger(record.serviceGeneration, 'serviceGeneration'),
    sessionRevision: nonNegativeInteger(record.sessionRevision, 'sessionRevision'),
    sessionCount: nonNegativeInteger(record.sessionCount, 'sessionCount'),
    batchCount: nonNegativeInteger(record.batchCount, 'batchCount'),
    fileCount: nonNegativeInteger(record.fileCount, 'fileCount'),
    rowCount: nonNegativeInteger(record.rowCount, 'rowCount'),
    pendingInteractionCount: nonNegativeInteger(
      record.pendingInteractionCount,
      'pendingInteractionCount'
    ),
    pendingInteractions,
    activePhase: record.activePhase
  };
  if (result.pendingInteractionCount !== pendingInteractions.length ||
      result.pendingInteractionCount > STATEMENT_RESOURCE_CONTRACT.tokenMaxOutstanding) {
    fail(
      'STATEMENT_STATUS_INTERACTION_COUNT_INVALID',
      'pendingInteractionCount must match the bounded pendingInteractions list'
    );
  }
  try {
    canonicalizeJson(result, { maxBytes: STATEMENT_RESOURCE_CONTRACT.statusMaxBytes });
  } catch (_error) {
    fail('STATEMENT_STATUS_TOO_LARGE', 'Statement status DTO exceeds the canonical status byte ceiling');
  }
  return canonicalJsonSnapshot(result);
}

module.exports = {
  STATEMENT_ACTIVE_PHASES,
  STATEMENT_PURPOSES,
  STATEMENT_RESOURCE_CONTRACT,
  StatementContractError,
  createStatementPublicInteractionDto,
  createStatementStatusDto,
  createStatementTokenHandleDto
};
