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
const STATEMENT_ACTION_PURPOSES = Object.freeze({
  'statement:import': Object.freeze(['big-account', 'manual-balance']),
  'statement:resolve-big-account': Object.freeze(['manual-balance']),
  'statement:resolve-manual-balance': Object.freeze(['manual-balance']),
  'statement:generate-current': Object.freeze(['manual-balance', 'scope-generation']),
  'statement:generate-all': Object.freeze(['manual-balance', 'scope-generation'])
});
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
  publicInteractionWireReserveBytes: 16 * 1024,
  publicInteractionMaxBytes: 240 * 1024,
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
const PUBLIC_INTERACTION_KEYS = Object.freeze([
  'tokenId',
  'purpose',
  'serviceGeneration',
  'sessionRevision',
  'expiresAt',
  'allowedChoiceDigest',
  'prompt'
]);
const INTERACTION_REQUIRED_RESULT_KEYS = Object.freeze(['status', 'interaction']);
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
const BIG_ACCOUNT_BASE_PROMPT_KEYS = Object.freeze([
  'status',
  'message',
  'selectionMode',
  'templateId',
  'rows',
  'rowsWithEmptyBlocks',
  'bigAccounts',
  'expandedBigAccountOptions',
  'fixedAssignments'
]);
const BIG_ACCOUNT_ROW_KEYS = Object.freeze([
  'index',
  'label',
  'sourceRowNumber',
  'fileName'
]);
const BIG_ACCOUNT_KEYS = Object.freeze(['merchantId', 'currencies', 'isMultiCurrency']);
const EXPANDED_BIG_ACCOUNT_KEYS = Object.freeze(['merchantId', 'currency', 'accountNature']);
const FIXED_ASSIGNMENT_KEYS = Object.freeze(['merchantId', 'currency', 'rowIndex']);
const MANUAL_BALANCE_PROMPT_KEYS = Object.freeze([
  'templateName',
  'bankName',
  'merchantId',
  'currency',
  'targetBillDate',
  'queueIndex',
  'queueTotal'
]);
const SCOPE_GENERATION_PROMPT_KEYS = Object.freeze(['status', 'kind', 'options']);
const SCOPE_OPTION_KEYS = Object.freeze(['scope', 'label']);
const MAX_BIG_ACCOUNT_ROWS = 1024;
const MAX_BIG_ACCOUNTS = 1024;
const MAX_CURRENCIES_PER_ACCOUNT = 64;
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
const FINANCE_SAFE_MERCHANT_ID_PATTERN = /^\d{12,32}$/;

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

function boundedOptionalText(value, label, maxLength = 256) {
  if (typeof value !== 'string' || value.length > maxLength) {
    fail('STATEMENT_DTO_TEXT_INVALID', `${label} must be a string up to ${maxLength} characters`);
  }
  return value;
}

function boundedArray(value, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail('STATEMENT_DTO_ARRAY_INVALID', `${label} must be an array with at most ${maxLength} items`);
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

function templateIdentity(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  return boundedText(value, 'templateId', 128);
}

function createBigAccountRowDto(input, index, label) {
  const row = ownDataRecord(input, BIG_ACCOUNT_ROW_KEYS, `${label}[${index}]`);
  return {
    index: nonNegativeInteger(row.index, `${label}[${index}].index`),
    label: boundedText(row.label, `${label}[${index}].label`, 32),
    sourceRowNumber: nonNegativeInteger(
      row.sourceRowNumber,
      `${label}[${index}].sourceRowNumber`
    ),
    fileName: boundedOptionalText(row.fileName, `${label}[${index}].fileName`, 512)
  };
}

function createBigAccountItemDto(input, index = 0) {
  const account = ownDataRecord(input, BIG_ACCOUNT_KEYS, `bigAccounts[${index}]`);
  if (typeof account.isMultiCurrency !== 'boolean') {
    fail('STATEMENT_DTO_BOOLEAN_INVALID', `bigAccounts[${index}].isMultiCurrency must be boolean`);
  }
  return {
    merchantId: boundedText(account.merchantId, `bigAccounts[${index}].merchantId`, 512),
    currencies: boundedArray(
      account.currencies,
      `bigAccounts[${index}].currencies`,
      MAX_CURRENCIES_PER_ACCOUNT
    ).map((currency, currencyIndex) => boundedText(
      currency,
      `bigAccounts[${index}].currencies[${currencyIndex}]`,
      32
    )),
    isMultiCurrency: account.isMultiCurrency
  };
}

function createExpandedBigAccountItemDto(input, index = 0) {
  const option = ownDataRecord(
    input,
    EXPANDED_BIG_ACCOUNT_KEYS,
    `expandedBigAccountOptions[${index}]`
  );
  if (!['own', 'client'].includes(option.accountNature)) {
    fail(
      'STATEMENT_PUBLIC_DTO_ACCOUNT_NATURE_INVALID',
      `expandedBigAccountOptions[${index}].accountNature is invalid`
    );
  }
  return {
    merchantId: boundedText(
      option.merchantId,
      `expandedBigAccountOptions[${index}].merchantId`,
      512
    ),
    currency: boundedOptionalText(
      option.currency,
      `expandedBigAccountOptions[${index}].currency`,
      32
    ),
    accountNature: option.accountNature
  };
}

function createFixedAssignmentItemDto(input, index = 0) {
  const assignment = ownDataRecord(input, FIXED_ASSIGNMENT_KEYS, `fixedAssignments[${index}]`);
  return {
    merchantId: boundedText(
      assignment.merchantId,
      `fixedAssignments[${index}].merchantId`,
      512
    ),
    currency: boundedOptionalText(
      assignment.currency,
      `fixedAssignments[${index}].currency`,
      32
    ),
    rowIndex: nonNegativeInteger(assignment.rowIndex, `fixedAssignments[${index}].rowIndex`)
  };
}

function createBigAccountPromptDto(input) {
  const statusDescriptor = input && typeof input === 'object' && !utilTypes.isProxy(input)
    ? Object.getOwnPropertyDescriptor(input, 'status')
    : null;
  const status = statusDescriptor && Object.prototype.hasOwnProperty.call(statusDescriptor, 'value')
    ? statusDescriptor.value
    : null;
  const forceModeDescriptor = input && typeof input === 'object' && !utilTypes.isProxy(input)
    ? Object.getOwnPropertyDescriptor(input, 'forceMode')
    : null;
  const hasForceMode = Boolean(forceModeDescriptor);
  const failedNamesDescriptor = input && typeof input === 'object' && !utilTypes.isProxy(input)
    ? Object.getOwnPropertyDescriptor(input, 'failedFileNames')
    : null;
  const hasFailedFileNames = Boolean(failedNamesDescriptor);
  const keys = BIG_ACCOUNT_BASE_PROMPT_KEYS.concat(
    hasFailedFileNames ? ['failedFileNames'] : [],
    hasForceMode ? ['forceMode'] : []
  );
  const record = ownDataRecord(input, keys, 'BigAccountInteractionPrompt');
  if (!['select-big-account', 'remember-order-mismatch'].includes(status)) {
    fail('STATEMENT_PUBLIC_DTO_STATUS_INVALID', 'Big-account prompt status is invalid');
  }
  if (status === 'remember-order-mismatch' && (!hasFailedFileNames || !hasForceMode)) {
    fail(
      'STATEMENT_PUBLIC_DTO_KEYS_INVALID',
      'Remember-order mismatch prompt requires failedFileNames and forceMode'
    );
  }
  if (record.selectionMode !== 'multi-row') {
    fail('STATEMENT_PUBLIC_DTO_MODE_INVALID', 'Big-account selectionMode must be multi-row');
  }
  const rows = boundedArray(record.rows, 'rows', MAX_BIG_ACCOUNT_ROWS)
    .map((row, index) => createBigAccountRowDto(row, index, 'rows'));
  const rowsWithEmptyBlocks = boundedArray(
    record.rowsWithEmptyBlocks,
    'rowsWithEmptyBlocks',
    MAX_BIG_ACCOUNT_ROWS
  ).map((row, index) => createBigAccountRowDto(row, index, 'rowsWithEmptyBlocks'));
  const bigAccounts = boundedArray(record.bigAccounts, 'bigAccounts', MAX_BIG_ACCOUNTS)
    .map(createBigAccountItemDto);
  const expandedBigAccountOptions = boundedArray(
    record.expandedBigAccountOptions,
    'expandedBigAccountOptions',
    MAX_BIG_ACCOUNTS * MAX_CURRENCIES_PER_ACCOUNT
  ).map(createExpandedBigAccountItemDto);
  const fixedAssignments = boundedArray(
    record.fixedAssignments,
    'fixedAssignments',
    MAX_BIG_ACCOUNT_ROWS
  ).map(createFixedAssignmentItemDto);
  const result = {
    status,
    message: boundedText(record.message, 'message', 1024),
    selectionMode: record.selectionMode,
    templateId: templateIdentity(record.templateId),
    rows,
    rowsWithEmptyBlocks,
    bigAccounts,
    expandedBigAccountOptions,
    fixedAssignments
  };
  if (hasFailedFileNames) {
    result.failedFileNames = boundedArray(
      record.failedFileNames,
      'failedFileNames',
      MAX_BIG_ACCOUNT_ROWS
    ).map((fileName, index) => boundedOptionalText(
      fileName,
      `failedFileNames[${index}]`,
      512
    ));
  }
  if (hasForceMode) {
    if (!['fixed', 'unfixed'].includes(record.forceMode)) {
      fail('STATEMENT_PUBLIC_DTO_MODE_INVALID', 'Big-account forceMode is invalid');
    }
    result.forceMode = record.forceMode;
  }
  return result;
}

function createManualBalancePromptDto(input) {
  const record = ownDataRecord(input, MANUAL_BALANCE_PROMPT_KEYS, 'ManualBalanceInteractionPrompt');
  return {
    templateName: boundedText(record.templateName, 'templateName', 512),
    bankName: boundedOptionalText(record.bankName, 'bankName', 512),
    merchantId: boundedText(record.merchantId, 'merchantId', 512),
    currency: boundedOptionalText(record.currency, 'currency', 32),
    targetBillDate: boundedText(record.targetBillDate, 'targetBillDate', 32),
    queueIndex: positiveInteger(record.queueIndex, 'queueIndex'),
    queueTotal: positiveInteger(record.queueTotal, 'queueTotal')
  };
}

function createScopeGenerationPromptDto(input) {
  const record = ownDataRecord(input, SCOPE_GENERATION_PROMPT_KEYS, 'ScopeGenerationInteractionPrompt');
  if (record.status !== 'select-export-scope' || !['detail', 'balance'].includes(record.kind)) {
    fail('STATEMENT_PUBLIC_DTO_SCOPE_INVALID', 'Scope-generation status or kind is invalid');
  }
  const options = boundedArray(record.options, 'options', 2).map((item, index) => {
    const option = ownDataRecord(item, SCOPE_OPTION_KEYS, `options[${index}]`);
    return {
      scope: option.scope,
      label: boundedText(option.label, `options[${index}].label`, 128)
    };
  });
  if (options.length !== 2 || options[0].scope !== 'current' || options[1].scope !== 'all') {
    fail('STATEMENT_PUBLIC_DTO_SCOPE_INVALID', 'Scope-generation options must be current then all');
  }
  return {
    status: record.status,
    kind: record.kind,
    options
  };
}

function createPurposePromptDto(promptPurpose, input) {
  if (promptPurpose === 'big-account') return createBigAccountPromptDto(input);
  if (promptPurpose === 'manual-balance') return createManualBalancePromptDto(input);
  if (promptPurpose === 'scope-generation') return createScopeGenerationPromptDto(input);
  fail('STATEMENT_TOKEN_PURPOSE_INVALID', 'Unsupported Statement interaction purpose');
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

function createStatementPublicInteractionValue(input) {
  const record = ownDataRecord(input, PUBLIC_INTERACTION_KEYS, 'StatementPublicInteractionDto');
  const interactionPurpose = purpose(record.purpose);
  let promptSnapshot;
  try {
    promptSnapshot = canonicalJsonSnapshot(record.prompt);
  } catch (_error) {
    fail('STATEMENT_PUBLIC_DTO_JSON_INVALID', 'Statement public prompt must be safe plain JSON');
  }
  assertNoPrivatePublicKeys(promptSnapshot, '/prompt');
  const result = {
    tokenId: boundedText(record.tokenId, 'tokenId'),
    purpose: interactionPurpose,
    serviceGeneration: positiveInteger(record.serviceGeneration, 'serviceGeneration'),
    sessionRevision: nonNegativeInteger(record.sessionRevision, 'sessionRevision'),
    expiresAt: positiveInteger(record.expiresAt, 'expiresAt'),
    allowedChoiceDigest: record.allowedChoiceDigest,
    prompt: createPurposePromptDto(interactionPurpose, promptSnapshot)
  };
  if (!SHA256_PATTERN.test(result.allowedChoiceDigest)) {
    fail('STATEMENT_TOKEN_DIGEST_INVALID', 'allowedChoiceDigest must be a lowercase SHA-256 digest');
  }
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

function createStatementPublicInteractionDto({ token, prompt }) {
  const handle = createStatementTokenHandleDto(token);
  return createStatementPublicInteractionValue({
    tokenId: handle.tokenId,
    purpose: handle.purpose,
    serviceGeneration: handle.serviceGeneration,
    sessionRevision: handle.sessionRevision,
    expiresAt: handle.expiresAt,
    allowedChoiceDigest: handle.allowedChoiceDigest,
    prompt
  });
}

function allowedInteractionPurposes(actionKey) {
  const allowed = STATEMENT_ACTION_PURPOSES[actionKey];
  if (!allowed) {
    fail('STATEMENT_ACTION_INVALID', `Unsupported Statement action: ${String(actionKey)}`);
  }
  return allowed;
}

function createStatementInteractionRequiredResult(input, actionKey) {
  const record = ownDataRecord(
    input,
    INTERACTION_REQUIRED_RESULT_KEYS,
    'StatementInteractionRequiredResult'
  );
  if (record.status !== 'interaction-required') {
    fail(
      'STATEMENT_RESULT_STATUS_INVALID',
      'Statement interaction result status must be interaction-required'
    );
  }
  const interaction = createStatementPublicInteractionValue(record.interaction);
  if (!allowedInteractionPurposes(actionKey).includes(interaction.purpose)) {
    fail(
      'STATEMENT_RESULT_PURPOSE_INVALID',
      `${actionKey} cannot return ${interaction.purpose} interaction`
    );
  }
  return canonicalJsonSnapshot({ status: record.status, interaction });
}

function merchantPathKind(path) {
  if (typeof path !== 'string') return null;
  const prefixes = [
    '/payload/progress/prompt/',
    '/payload/result/interaction/prompt/'
  ];
  const prefix = prefixes.find((candidate) => path.startsWith(candidate));
  if (!prefix) return null;
  const relativePath = path.slice(prefix.length);
  if (relativePath === 'merchantId') return Object.freeze({ kind: 'manual-balance', index: 0 });
  const match = /^(bigAccounts|expandedBigAccountOptions|fixedAssignments)\/(0|[1-9]\d*)\/merchantId$/.exec(
    relativePath
  );
  if (!match) return null;
  const index = Number(match[2]);
  const maxItems = match[1] === 'expandedBigAccountOptions'
    ? MAX_BIG_ACCOUNTS * MAX_CURRENCIES_PER_ACCOUNT
    : match[1] === 'bigAccounts' ? MAX_BIG_ACCOUNTS : MAX_BIG_ACCOUNT_ROWS;
  if (!Number.isSafeInteger(index) || index >= maxItems) return null;
  return Object.freeze({ kind: match[1], index });
}

function parentMerchantIdForPath(parent, pathKind) {
  if (pathKind.kind === 'manual-balance') return createManualBalancePromptDto(parent).merchantId;
  if (pathKind.kind === 'bigAccounts') return createBigAccountItemDto(parent, pathKind.index).merchantId;
  if (pathKind.kind === 'expandedBigAccountOptions') {
    return createExpandedBigAccountItemDto(parent, pathKind.index).merchantId;
  }
  if (pathKind.kind === 'fixedAssignments') {
    return createFixedAssignmentItemDto(parent, pathKind.index).merchantId;
  }
  return null;
}

function createStatementFinanceSafeValueDelegate(actionKey) {
  const allowedPurposes = allowedInteractionPurposes(actionKey);
  return function allowStatementFinanceSafeValue(input = {}) {
    if (!input || typeof input !== 'object') return false;
    const { value, path, parent, key } = input;
    if (key !== 'merchantId' || typeof value !== 'string' ||
        !FINANCE_SAFE_MERCHANT_ID_PATTERN.test(value)) return false;
    const pathKind = merchantPathKind(path);
    if (!pathKind) return false;
    const impliedPurpose = pathKind.kind === 'manual-balance' ? 'manual-balance' : 'big-account';
    if (!allowedPurposes.includes(impliedPurpose)) return false;
    try {
      return parentMerchantIdForPath(parent, pathKind) === value;
    } catch (_error) {
      return false;
    }
  };
}

function createStatementResultValidator(actionKey) {
  const allowFinanceSafeValue = createStatementFinanceSafeValueDelegate(actionKey);
  const validator = function validateStatementInteractionRequiredResult(value) {
    try {
      createStatementInteractionRequiredResult(value, actionKey);
      return true;
    } catch (_error) {
      return false;
    }
  };
  Object.defineProperty(validator, 'allowFinanceSafeValue', {
    value: allowFinanceSafeValue
  });
  return validator;
}

const STATEMENT_RESULT_VALIDATORS = Object.freeze(Object.fromEntries(
  Object.keys(STATEMENT_ACTION_PURPOSES).map((actionKey) => [
    actionKey,
    createStatementResultValidator(actionKey)
  ])
));

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
  STATEMENT_ACTION_PURPOSES,
  STATEMENT_ACTIVE_PHASES,
  STATEMENT_PURPOSES,
  STATEMENT_RESOURCE_CONTRACT,
  STATEMENT_RESULT_VALIDATORS,
  StatementContractError,
  createStatementFinanceSafeValueDelegate,
  createStatementInteractionRequiredResult,
  createStatementPublicInteractionDto,
  createStatementResultValidator,
  createStatementStatusDto,
  createStatementTokenHandleDto
};
