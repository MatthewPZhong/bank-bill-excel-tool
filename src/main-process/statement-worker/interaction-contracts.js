'use strict';

const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { createStatementImportRequest } = require('./import-contracts');

class StatementInteractionContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementInteractionContractError';
    this.code = code;
  }
}

const PUBLIC_TOKEN_KEYS = Object.freeze([
  'tokenId', 'purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest'
]);

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new StatementInteractionContractError('STATEMENT_CONTINUATION_SHAPE_INVALID', `${label} has invalid keys`);
  }
  return value;
}

function createStatementPublicTokenIdentity(input, options = {}) {
  const token = exact(
    canonicalJsonSnapshot(input, { maxBytes: 4096 }),
    PUBLIC_TOKEN_KEYS,
    'StatementPublicToken'
  );
  const expectedPurpose = options.purpose || 'big-account';
  if (token.purpose !== expectedPurpose) {
    throw new StatementInteractionContractError('STATEMENT_CONTINUATION_PURPOSE_INVALID', 'Continuation purpose is invalid');
  }
  if (typeof token.tokenId !== 'string' || token.tokenId.length === 0 || token.tokenId.length > 256 ||
      !Number.isSafeInteger(token.serviceGeneration) || token.serviceGeneration < 1 ||
      !Number.isSafeInteger(token.sessionRevision) || token.sessionRevision < 0 ||
      !Number.isSafeInteger(token.expiresAt) || token.expiresAt < 1 ||
      typeof token.allowedChoiceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(token.allowedChoiceDigest)) {
    throw new StatementInteractionContractError('STATEMENT_CONTINUATION_TOKEN_INVALID', 'Continuation token is invalid');
  }
  return Object.freeze(token);
}

function createStatementBigAccountContinuationRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: 1024 * 1024 });
  const record = exact(value, ['command', 'token', 'choice', 'importEvidence'], 'StatementBigAccountContinuation');
  if (record.command !== 'resolve-big-account') {
    throw new StatementInteractionContractError('STATEMENT_CONTINUATION_COMMAND_INVALID', 'Continuation command is invalid');
  }
  const token = createStatementPublicTokenIdentity(record.token);
  const choice = exact(record.choice, ['mode', 'assignments'], 'StatementBigAccountChoice');
  if (!['fixed', 'unfixed'].includes(choice.mode) ||
      !Array.isArray(choice.assignments) || choice.assignments.length === 0) {
    throw new StatementInteractionContractError('STATEMENT_CONTINUATION_CHOICE_INVALID', 'Big-account choice is invalid');
  }
  const assignments = choice.assignments.map((item, index) => {
    const assignment = exact(item, ['rowIndex', 'merchantId', 'currency'], `assignments[${index}]`);
    if (!Number.isSafeInteger(assignment.rowIndex) || assignment.rowIndex < 0 ||
        typeof assignment.merchantId !== 'string' || !assignment.merchantId ||
        typeof assignment.currency !== 'string' || !assignment.currency) {
      throw new StatementInteractionContractError('STATEMENT_CONTINUATION_CHOICE_INVALID', 'Big-account assignment is invalid');
    }
    return assignment;
  });
  return Object.freeze({
    command: record.command,
    token: Object.freeze({ ...token }),
    choice: Object.freeze({ mode: choice.mode, assignments: Object.freeze(assignments) }),
    importEvidence: createStatementImportRequest(record.importEvidence)
  });
}

function createStatementCancelInteractionRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: 8192 });
  const record = exact(value, ['command', 'token'], 'StatementCancelInteraction');
  if (record.command !== 'cancel-interaction') {
    throw new StatementInteractionContractError(
      'STATEMENT_CONTINUATION_COMMAND_INVALID',
      'Cancel-interaction command is invalid'
    );
  }
  return Object.freeze({
    command: record.command,
    token: createStatementPublicTokenIdentity(record.token)
  });
}

module.exports = {
  StatementInteractionContractError,
  createStatementBigAccountContinuationRequest,
  createStatementCancelInteractionRequest,
  createStatementPublicTokenIdentity
};
