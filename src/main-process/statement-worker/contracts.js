'use strict';

const { types: utilTypes } = require('node:util');

const {
  canonicalJsonSnapshot,
  canonicalizeJson
} = require('../background-execution/canonical-json-v1');
const {
  financeSafeTextViolation
} = require('../background-execution/error-codec');
const {
  validateManifestItem,
  validateStatementGenerationResult
} = require('./generation-contracts');

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
const INTERACTION_CANCELLED_RESULT_KEYS = Object.freeze(['status', 'tokenId']);
const IMPORT_RESULT_KEYS = Object.freeze(['status', 'summary', 'session']);
const IMPORT_SESSION_KEYS = Object.freeze([
  'sessionKey',
  'currentBatchId',
  'entryCount',
  'importedEntryIds'
]);
const STATUS_RESULT_KEYS = Object.freeze(['status', 'summary']);
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
const BALANCE_SEED_OVERWRITE_PROMPT_KEYS = Object.freeze(['status', 'message']);
const SCOPE_GENERATION_PROMPT_KEYS = Object.freeze(['status', 'kind', 'options']);
const SCOPE_OPTION_KEYS = Object.freeze(['scope', 'label']);
const BALANCE_SEED_OVERWRITE_PRIVATE_KEYS = Object.freeze([
  'kind',
  'purpose',
  'serviceGeneration',
  'sessionRevision',
  'record',
  'freshnessEvidence',
  'inputSourceCount',
  'allowedChoiceDigest'
]);
const BALANCE_SEED_OVERWRITE_RECORD_KEYS = Object.freeze([
  'bankName',
  'merchantId',
  'currency',
  'billDate',
  'endBalance',
  'templateName',
  'generationMethod',
  'existingIndex'
]);
const BALANCE_SEED_OVERWRITE_FRESHNESS_KEYS = Object.freeze([
  'recordsDigest',
  'inputSourcesDigest',
  'statementSessionKey',
  'currentBatchId',
  'scope'
]);
const BALANCE_SEED_OVERWRITE_RELEASE_INPUT_KEYS = Object.freeze([
  'event',
  'currentTokenId',
  'replacementTokenId'
]);
const MAX_BIG_ACCOUNT_ROWS = 1024;
const MAX_BIG_ACCOUNTS = 1024;
const MAX_CURRENCIES_PER_ACCOUNT = 64;
const MAX_MISMATCH_MESSAGE_ALIAS_PREVIEW = 8;
const BIG_ACCOUNT_SELECT_MESSAGE = '请选择本次使用的大账号 / 币种';
const BIG_ACCOUNT_MISMATCH_MESSAGE = '部分来源文件的账户个数或账户号无法自动匹配，请检查后重新选择';
const BALANCE_SEED_OVERWRITE_MESSAGE = '该日期的余额已存在，确认覆盖吗？';
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
  const rawRows = boundedArray(record.rows, 'rows', MAX_BIG_ACCOUNT_ROWS)
    .map((row, index) => createBigAccountRowDto(row, index, 'rows'));
  const rawRowsWithEmptyBlocks = boundedArray(
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
  const rawFailedFileNames = hasFailedFileNames
    ? boundedArray(
      record.failedFileNames,
      'failedFileNames',
      MAX_BIG_ACCOUNT_ROWS
    ).map((fileName, index) => boundedOptionalText(
      fileName,
      `failedFileNames[${index}]`,
      512
    ))
    : null;
  // Legacy Main 提供用于展示的 basename，但其中仍可能包含完整账号或用户自定义目录名。
  // 冻结 Worker 边界只在 private context 保留原名，对外仅暴露按首次出现顺序生成的稳定别名。
  const sourceAliases = new Map();
  const displayAlias = (fileName) => {
    if (!fileName) return '';
    if (!sourceAliases.has(fileName)) {
      sourceAliases.set(fileName, `来源文件 ${sourceAliases.size + 1}`);
    }
    return sourceAliases.get(fileName);
  };
  const rows = rawRows.map((row) => ({ ...row, fileName: displayAlias(row.fileName) }));
  const rowsWithEmptyBlocks = rawRowsWithEmptyBlocks
    .map((row) => ({ ...row, fileName: displayAlias(row.fileName) }));
  const failedFileNames = rawFailedFileNames
    ? rawFailedFileNames.map(displayAlias)
    : null;
  const publicMessage = status === 'select-big-account'
    ? BIG_ACCOUNT_SELECT_MESSAGE
    : (() => {
        const uniqueAliases = Array.from(new Set(failedFileNames.filter(Boolean)));
        const preview = uniqueAliases.slice(0, MAX_MISMATCH_MESSAGE_ALIAS_PREVIEW);
        const suffix = uniqueAliases.length > preview.length ? '等' : '';
        const previewText = preview.length ? `：${preview.join('、')}${suffix}` : '';
        return `${BIG_ACCOUNT_MISMATCH_MESSAGE}（共${failedFileNames.length}个${previewText}）`;
      })();
  // legacy Main 会把全部失败 basename 拼入该字段，但这里必定以固定摘要重建，原文不进入
  // public graph；因此只冻结真实 producer 的非空字符串类型，不设置任意预清洗长度上限。
  if (typeof record.message !== 'string' || record.message.length === 0) {
    fail('STATEMENT_DTO_TEXT_INVALID', 'message must be a non-empty string');
  }
  const result = {
    status,
    message: publicMessage,
    selectionMode: record.selectionMode,
    templateId: templateIdentity(record.templateId),
    rows,
    rowsWithEmptyBlocks,
    bigAccounts,
    expandedBigAccountOptions,
    fixedAssignments
  };
  if (hasFailedFileNames) {
    result.failedFileNames = failedFileNames;
  }
  if (hasForceMode) {
    if (!['fixed', 'unfixed'].includes(record.forceMode)) {
      fail('STATEMENT_PUBLIC_DTO_MODE_INVALID', 'Big-account forceMode is invalid');
    }
    result.forceMode = record.forceMode;
  }
  return result;
}

function createStatementBalanceSeedOverwritePrivateContextDto(input) {
  const record = ownDataRecord(
    input,
    BALANCE_SEED_OVERWRITE_PRIVATE_KEYS,
    'StatementBalanceSeedOverwritePrivateContext'
  );
  const seedRecord = ownDataRecord(
    record.record,
    BALANCE_SEED_OVERWRITE_RECORD_KEYS,
    'StatementBalanceSeedOverwritePrivateContext.record'
  );
  const freshness = ownDataRecord(
    record.freshnessEvidence,
    BALANCE_SEED_OVERWRITE_FRESHNESS_KEYS,
    'StatementBalanceSeedOverwritePrivateContext.freshnessEvidence'
  );
  if (record.kind !== 'balance-seed-overwrite' || record.purpose !== 'manual-balance') {
    fail(
      'STATEMENT_BALANCE_SEED_OVERWRITE_KIND_INVALID',
      'Balance-seed overwrite private context must use the manual-balance purpose'
    );
  }
  if (typeof seedRecord.endBalance !== 'number' || !Number.isFinite(seedRecord.endBalance)) {
    fail(
      'STATEMENT_DTO_NUMBER_INVALID',
      'StatementBalanceSeedOverwritePrivateContext.record.endBalance must be finite'
    );
  }
  const result = {
    kind: record.kind,
    purpose: record.purpose,
    serviceGeneration: positiveInteger(record.serviceGeneration, 'serviceGeneration'),
    sessionRevision: nonNegativeInteger(record.sessionRevision, 'sessionRevision'),
    record: {
      bankName: boundedText(seedRecord.bankName, 'record.bankName', 512),
      merchantId: boundedText(seedRecord.merchantId, 'record.merchantId', 512),
      currency: boundedOptionalText(seedRecord.currency, 'record.currency', 32),
      billDate: boundedText(seedRecord.billDate, 'record.billDate', 32),
      endBalance: seedRecord.endBalance,
      templateName: boundedText(seedRecord.templateName, 'record.templateName', 512),
      generationMethod: boundedText(seedRecord.generationMethod, 'record.generationMethod', 128),
      existingIndex: nonNegativeInteger(seedRecord.existingIndex, 'record.existingIndex')
    },
    freshnessEvidence: {
      recordsDigest: freshness.recordsDigest,
      inputSourcesDigest: freshness.inputSourcesDigest,
      statementSessionKey: boundedOptionalText(
        freshness.statementSessionKey,
        'freshnessEvidence.statementSessionKey',
        512
      ),
      currentBatchId: boundedOptionalText(
        freshness.currentBatchId,
        'freshnessEvidence.currentBatchId',
        512
      ),
      scope: freshness.scope
    },
    inputSourceCount: nonNegativeInteger(record.inputSourceCount, 'inputSourceCount'),
    allowedChoiceDigest: record.allowedChoiceDigest
  };
  if (!['current', 'all'].includes(result.freshnessEvidence.scope)) {
    fail(
      'STATEMENT_PUBLIC_DTO_SCOPE_INVALID',
      'Balance-seed overwrite generation scope is invalid'
    );
  }
  if (!SHA256_PATTERN.test(result.freshnessEvidence.recordsDigest) ||
      !SHA256_PATTERN.test(result.freshnessEvidence.inputSourcesDigest) ||
      !SHA256_PATTERN.test(result.allowedChoiceDigest)) {
    fail(
      'STATEMENT_TOKEN_DIGEST_INVALID',
      'Balance-seed overwrite evidence must use lowercase SHA-256 digests'
    );
  }
  return canonicalJsonSnapshot(result);
}

function createStatementBalanceSeedOverwriteReleaseCharacterization(input) {
  const record = ownDataRecord(
    input,
    BALANCE_SEED_OVERWRITE_RELEASE_INPUT_KEYS,
    'StatementBalanceSeedOverwriteReleaseCharacterization'
  );
  const reasons = {
    confirm: 'consumed',
    cancel: 'cancelled',
    stale: 'stale',
    replacement: 'replaced'
  };
  if (!Object.hasOwn(reasons, record.event)) {
    fail(
      'STATEMENT_BALANCE_SEED_OVERWRITE_EVENT_INVALID',
      'Balance-seed overwrite release event is invalid'
    );
  }
  const currentTokenId = boundedText(record.currentTokenId, 'currentTokenId');
  let nextTokenId = null;
  if (record.event === 'replacement') {
    nextTokenId = boundedText(record.replacementTokenId, 'replacementTokenId');
    if (nextTokenId === currentTokenId) {
      fail(
        'STATEMENT_BALANCE_SEED_OVERWRITE_REPLACEMENT_INVALID',
        'Replacement must use a fresh token identity'
      );
    }
  } else if (record.replacementTokenId !== null) {
    fail(
      'STATEMENT_BALANCE_SEED_OVERWRITE_REPLACEMENT_INVALID',
      'Only replacement may provide a replacement token identity'
    );
  }
  return canonicalJsonSnapshot({
    event: record.event,
    releasedTokenId: currentTokenId,
    releaseReason: reasons[record.event],
    nextTokenId
  });
}

function createBalanceSeedOverwritePromptDto(input) {
  const record = ownDataRecord(
    input,
    BALANCE_SEED_OVERWRITE_PROMPT_KEYS,
    'BalanceSeedOverwriteInteractionPrompt'
  );
  if (record.status !== 'confirm-overwrite' || record.message !== BALANCE_SEED_OVERWRITE_MESSAGE) {
    fail(
      'STATEMENT_BALANCE_SEED_OVERWRITE_PROMPT_INVALID',
      'Balance-seed overwrite prompt must use the canonical status and message'
    );
  }
  return {
    status: record.status,
    message: record.message
  };
}

function createStatementBalanceSeedOverwritePromptDto() {
  return canonicalJsonSnapshot({
    status: 'confirm-overwrite',
    message: BALANCE_SEED_OVERWRITE_MESSAGE
  });
}

function createManualBalancePromptDto(input) {
  const statusDescriptor = input && typeof input === 'object' && !utilTypes.isProxy(input)
    ? Object.getOwnPropertyDescriptor(input, 'status')
    : null;
  if (statusDescriptor) return createBalanceSeedOverwritePromptDto(input);
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

function createStatementInteractionPromptDto(promptPurpose, input) {
  return canonicalJsonSnapshot(createPurposePromptDto(promptPurpose, input));
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
  if (interaction.prompt.status === 'confirm-overwrite' &&
      actionKey !== 'statement:resolve-manual-balance') {
    fail(
      'STATEMENT_RESULT_PURPOSE_INVALID',
      'Balance-seed overwrite confirmation is only valid for statement:resolve-manual-balance'
    );
  }
  return canonicalJsonSnapshot({ status: record.status, interaction });
}

function createStatementInteractionCancelledResult(input) {
  const record = ownDataRecord(
    input,
    INTERACTION_CANCELLED_RESULT_KEYS,
    'StatementInteractionCancelledResult'
  );
  if (record.status !== 'interaction-cancelled') {
    fail('STATEMENT_RESULT_STATUS_INVALID', 'Statement interaction cancellation status is invalid');
  }
  return canonicalJsonSnapshot({
    status: record.status,
    tokenId: boundedText(record.tokenId, 'tokenId')
  });
}

function createStatementImportResult(input) {
  const record = ownDataRecord(input, IMPORT_RESULT_KEYS, 'StatementImportResult');
  if (record.status !== 'imported') {
    fail('STATEMENT_RESULT_STATUS_INVALID', 'Statement import result status must be imported');
  }
  const session = ownDataRecord(record.session, IMPORT_SESSION_KEYS, 'StatementImportSessionResult');
  const entryCount = positiveInteger(session.entryCount, 'entryCount');
  const importedEntryIds = boundedArray(
    session.importedEntryIds,
    'importedEntryIds',
    MAX_BIG_ACCOUNT_ROWS
  ).map((entryId, index) => boundedText(entryId, `importedEntryIds[${index}]`, 256));
  if (new Set(importedEntryIds).size !== importedEntryIds.length ||
      importedEntryIds.length === 0 ||
      importedEntryIds.length > entryCount) {
    fail(
      'STATEMENT_RESULT_ENTRY_ID_INVALID',
      'Statement importedEntryIds must be unique, non-empty, and bounded by entryCount'
    );
  }
  return canonicalJsonSnapshot({
    status: record.status,
    summary: createStatementStatusDto(record.summary),
    session: {
      sessionKey: boundedText(session.sessionKey, 'sessionKey', 512),
      currentBatchId: boundedText(session.currentBatchId, 'currentBatchId', 256),
      entryCount,
      importedEntryIds
    }
  });
}

function createStatementStatusResult(input) {
  const record = ownDataRecord(input, STATUS_RESULT_KEYS, 'StatementStatusResult');
  if (record.status !== 'status') {
    fail('STATEMENT_RESULT_STATUS_INVALID', 'Statement status result status must be status');
  }
  return canonicalJsonSnapshot({
    status: record.status,
    summary: createStatementStatusDto(record.summary)
  });
}

function merchantPathKind(path) {
  if (typeof path !== 'string') return null;
  const prefix = '/payload/result/interaction/prompt/';
  if (!path.startsWith(prefix)) return null;
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
    if (typeof value !== 'string') return false;
    const violation = financeSafeTextViolation(value);
    if (['statement:generate-current', 'statement:generate-all'].includes(actionKey)) {
      try {
        if (/^\/payload\/result\/artifacts\/(0|1)\/(artifactKey|generationPath|sha256|inputEvidenceHash)$/.test(path) &&
            ['artifactKey', 'generationPath', 'sha256', 'inputEvidenceHash'].includes(key) &&
            parent && parent[key] === value && validateManifestItem(parent)) {
          return true;
        }
        if (path === '/payload/result/inputEvidenceHash' && key === 'inputEvidenceHash' &&
            parent && parent[key] === value && validateStatementGenerationResult(parent)) {
          return true;
        }
      } catch (_generationError) {}
    }
    if (violation !== 'full-account') return false;
    if (key !== 'merchantId') return false;
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
      const normalized = createStatementInteractionRequiredResult(value, actionKey);
      return canonicalizeJson(normalized) === canonicalizeJson(value);
    } catch (_error) {
      if (['statement:generate-current', 'statement:generate-all'].includes(actionKey)) {
        return validateStatementGenerationResult(value);
      }
      if (!['statement:import', 'statement:resolve-big-account'].includes(actionKey)) return false;
      try {
        createStatementImportResult(value);
        return true;
      } catch (_importError) {
        if (actionKey === 'statement:resolve-big-account') {
          try {
            createStatementInteractionCancelledResult(value);
            return true;
          } catch (_cancelError) {
            return false;
          }
        }
        try {
          createStatementStatusResult(value);
          return true;
        } catch (_statusError) {
          return false;
        }
      }
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

function readStatusPendingInteractions(value, pendingInteractionCount) {
  const count = nonNegativeInteger(pendingInteractionCount, 'pendingInteractionCount');
  const maxOutstanding = STATEMENT_RESOURCE_CONTRACT.tokenMaxOutstanding;
  if (count > maxOutstanding) {
    fail(
      'STATEMENT_STATUS_INTERACTION_COUNT_INVALID',
      'pendingInteractionCount exceeds the canonical outstanding-token limit'
    );
  }
  if (utilTypes.isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) {
    fail(
      'STATEMENT_STATUS_INTERACTIONS_INVALID',
      'pendingInteractions must be an exact non-Proxy Array'
    );
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0) {
    fail(
      'STATEMENT_STATUS_INTERACTIONS_INVALID',
      'pendingInteractions.length must be an own data property'
    );
  }
  const length = lengthDescriptor.value;
  if (length > maxOutstanding || count !== length) {
    fail(
      'STATEMENT_STATUS_INTERACTION_COUNT_INVALID',
      'pendingInteractionCount must match the bounded pendingInteractions list'
    );
  }

  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length }, (_unused, index) => String(index));
  expectedKeys.push('length');
  if (ownKeys.some((key) => typeof key === 'symbol') ||
      ownKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !ownKeys.includes(key))) {
    fail(
      'STATEMENT_STATUS_INTERACTIONS_INVALID',
      'pendingInteractions must contain only dense index data properties and length'
    );
  }

  const items = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(
        'STATEMENT_STATUS_INTERACTIONS_INVALID',
        `pendingInteractions[${index}] must be an enumerable own data property`
      );
    }
    items.push(descriptor.value);
  }
  return { count, items };
}

function createStatementStatusDto(input) {
  const record = ownDataRecord(input, STATUS_KEYS, 'StatementStatusDto');
  if (!STATEMENT_ACTIVE_PHASES.includes(record.activePhase)) {
    fail('STATEMENT_STATUS_PHASE_INVALID', 'activePhase is not a supported Statement phase');
  }
  const pendingInput = readStatusPendingInteractions(
    record.pendingInteractions,
    record.pendingInteractionCount
  );
  const pendingInteractions = pendingInput.items.map((item, index) => {
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
    pendingInteractionCount: pendingInput.count,
    pendingInteractions,
    activePhase: record.activePhase
  };
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
  createStatementBalanceSeedOverwritePromptDto,
  createStatementBalanceSeedOverwritePrivateContextDto,
  createStatementBalanceSeedOverwriteReleaseCharacterization,
  createStatementFinanceSafeValueDelegate,
  createStatementImportResult,
  createStatementInteractionCancelledResult,
  createStatementInteractionRequiredResult,
  createStatementInteractionPromptDto,
  createStatementPublicInteractionDto,
  createStatementResultValidator,
  createStatementStatusDto,
  createStatementStatusResult,
  createStatementTokenHandleDto
};
