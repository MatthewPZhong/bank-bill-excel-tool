'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  STATEMENT_RESOURCE_CONTRACT,
  createStatementInteractionPromptDto,
  createStatementPublicInteractionDto,
  createStatementTokenHandleDto
} = require('./contracts');
const {
  createStatementPublicTokenIdentity
} = require('./interaction-contracts');
const {
  estimateStatementPendingInteractionFootprint
} = require('./state-footprint');

class StatementTokenStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementTokenStoreError';
    this.code = code;
  }
}

const BIG_ACCOUNT_CHOICE_KEYS = Object.freeze(['mode', 'assignments']);
const BIG_ACCOUNT_ASSIGNMENT_KEYS = Object.freeze(['rowIndex', 'merchantId', 'currency']);

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function createStatementTokenStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const createId = typeof options.createId === 'function' ? options.createId : randomUUID;
  const ttlMs = options.ttlMs || STATEMENT_RESOURCE_CONTRACT.tokenTtlMs;
  const budgetBytes = options.budgetBytes || STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes;
  const maxOutstanding = options.maxOutstanding || STATEMENT_RESOURCE_CONTRACT.tokenMaxOutstanding;
  const records = new Map();
  let totalBytes = 0;

  function fail(code, message) {
    throw new StatementTokenStoreError(code, message);
  }

  function prepareDraft(input, replacementRecord = null) {
    const projectedCount = records.size - (replacementRecord ? 1 : 0) + 1;
    if (projectedCount > maxOutstanding) {
      fail('STATEMENT_TOKEN_LIMIT_EXCEEDED', 'Statement token limit exceeded');
    }
    const privateContext = canonicalJsonSnapshot(input.privateContext);
    const footprint = estimateStatementPendingInteractionFootprint(privateContext, { budgetBytes });
    const projectedBytes = totalBytes - (replacementRecord ? replacementRecord.bytes : 0) +
      footprint.estimatedBytes;
    if (projectedBytes > budgetBytes) {
      fail('STATEMENT_TOKEN_BUDGET_EXCEEDED', 'Statement pending-interaction budget exceeded');
    }
    const tokenId = createId();
    const expiresAt = now() + ttlMs;
    const allowedChoiceDigest = canonicalSha256(input.allowedChoices);
    const prompt = createStatementInteractionPromptDto(input.purpose, input.prompt);
    const publicInteraction = createStatementPublicInteractionDto({
      token: {
        tokenId,
        purpose: input.purpose,
        serviceGeneration: input.serviceGeneration,
        sessionKey: input.sessionKey,
        sessionRevision: input.sessionRevision,
        expiresAt,
        allowedChoiceDigest,
        reservationId: 'preflight-reservation'
      },
      prompt
    });
    return Object.freeze({
      tokenId,
      purpose: input.purpose,
      serviceGeneration: input.serviceGeneration,
      sessionKey: input.sessionKey,
      sessionRevision: input.sessionRevision,
      expiresAt,
      allowedChoiceDigest,
      privateContext,
      prompt,
      publicInteraction,
      footprint,
      replacementTokenId: replacementRecord ? replacementRecord.handle.tokenId : null,
      replacesReservationId: replacementRecord ? replacementRecord.handle.reservationId : null
    });
  }

  function prepare(input) {
    return prepareDraft(input);
  }

  function prepareReplacement(input, currentTokenId) {
    const current = records.get(currentTokenId);
    if (!current || current.state !== 'published') {
      fail('STATEMENT_TOKEN_REPLACEMENT_STALE', 'Replacement must reference the published current token');
    }
    if (input.purpose !== current.publicInteraction.purpose) {
      fail('STATEMENT_TOKEN_REPLACEMENT_PURPOSE_MISMATCH', 'Replacement token purpose must remain unchanged');
    }
    if ([...records.values()].some((record) => record.replacementTokenId === currentTokenId)) {
      fail('STATEMENT_TOKEN_REPLACEMENT_IN_PROGRESS', 'Statement token already has a replacement candidate');
    }
    return prepareDraft(input, current);
  }

  function claimBigAccountChoice(input, choiceDomain) {
    let choice;
    try {
      choice = canonicalJsonSnapshot(input, { maxBytes: 1024 * 1024 });
    } catch (_error) {
      fail('STATEMENT_TOKEN_CHOICE_INVALID', 'Big-account choice is not an exact bounded value');
    }
    if (!hasExactKeys(choice, BIG_ACCOUNT_CHOICE_KEYS) ||
        !['fixed', 'unfixed'].includes(choice.mode) ||
        !Array.isArray(choice.assignments) || choice.assignments.length === 0) {
      fail('STATEMENT_TOKEN_CHOICE_INVALID', 'Big-account choice is invalid');
    }
    const expectedRows = choice.mode === 'fixed'
      ? choiceDomain && choiceDomain.rowsWithEmptyBlocks
      : choiceDomain && choiceDomain.rows;
    const options = choiceDomain && choiceDomain.options;
    if (!Array.isArray(expectedRows) || !Array.isArray(options) ||
        choice.assignments.length !== expectedRows.length) {
      fail('STATEMENT_TOKEN_CHOICE_INVALID', 'Big-account assignment rows are invalid');
    }
    const assignments = choice.assignments.map((assignment) => {
      if (!hasExactKeys(assignment, BIG_ACCOUNT_ASSIGNMENT_KEYS) ||
          !Number.isSafeInteger(assignment.rowIndex) || assignment.rowIndex < 0 ||
          typeof assignment.merchantId !== 'string' || assignment.merchantId.length === 0 ||
          typeof assignment.currency !== 'string' || assignment.currency.length === 0) {
        fail('STATEMENT_TOKEN_CHOICE_INVALID', 'Big-account assignment is invalid');
      }
      return assignment;
    }).sort((left, right) => left.rowIndex - right.rowIndex);
    const sortedExpectedRows = expectedRows.slice().sort((left, right) => left - right);
    if (new Set(assignments.map((assignment) => assignment.rowIndex)).size !== assignments.length ||
        assignments.some((assignment, index) => assignment.rowIndex !== sortedExpectedRows[index]) ||
        assignments.some((assignment) => !options.some((option) =>
          option.merchantId === assignment.merchantId && option.currency === assignment.currency))) {
      fail('STATEMENT_TOKEN_CHOICE_INVALID', 'Big-account choice is not allowed');
    }
    return canonicalJsonSnapshot({ mode: choice.mode, assignments }, { maxBytes: 1024 * 1024 });
  }

  function insertPrivate(draft, grant) {
    const replacement = draft.replacementTokenId
      ? records.get(draft.replacementTokenId)
      : null;
    if (records.has(draft.tokenId) || (!replacement && records.size >= maxOutstanding)) {
      fail('STATEMENT_TOKEN_LIMIT_EXCEEDED', 'Statement token cannot be inserted');
    }
    if (draft.replacementTokenId &&
        (!replacement || replacement.state !== 'published' ||
         replacement.handle.reservationId !== draft.replacesReservationId ||
         grant.replacesReservationId !== draft.replacesReservationId)) {
      fail('STATEMENT_TOKEN_REPLACEMENT_STALE', 'Replacement grant does not match the published current token');
    }
    const handle = createStatementTokenHandleDto({
      tokenId: draft.tokenId,
      purpose: draft.purpose,
      serviceGeneration: draft.serviceGeneration,
      sessionKey: draft.sessionKey,
      sessionRevision: draft.sessionRevision,
      expiresAt: draft.expiresAt,
      allowedChoiceDigest: draft.allowedChoiceDigest,
      reservationId: grant.reservationId
    });
    const record = {
      handle,
      grantId: grant.grantId,
      requestId: grant.requestId,
      owner: grant.owner,
      ownerJobRef: grant.ownerJobRef,
      privateContext: draft.privateContext,
      prompt: draft.prompt,
      publicInteraction: draft.publicInteraction,
      bytes: draft.footprint.estimatedBytes,
      replacementTokenId: draft.replacementTokenId,
      state: 'inserted'
    };
    records.set(handle.tokenId, record);
    totalBytes += record.bytes;
    return record;
  }

  function markAdopted(tokenId, identity) {
    const record = records.get(tokenId);
    if (!record || record.state !== 'inserted' || record.grantId !== identity.grantId ||
        record.handle.reservationId !== identity.reservationId) {
      fail('STATEMENT_TOKEN_ADOPT_ACK_STALE', 'Token adopt ack does not match private insert');
    }
    if (record.replacementTokenId) {
      const replaced = records.get(record.replacementTokenId);
      if (!replaced || replaced.state !== 'published') {
        fail('STATEMENT_TOKEN_REPLACEMENT_STALE', 'Replacement token is no longer current');
      }
      records.delete(replaced.handle.tokenId);
      totalBytes -= replaced.bytes;
      replaced.state = 'replaced';
    }
    record.state = 'published';
    return record;
  }

  function inspect(tokenId) {
    return records.get(tokenId) || null;
  }

  function beginConsume(publicToken, expected) {
    const token = canonicalJsonSnapshot(publicToken);
    const record = records.get(token.tokenId);
    if (!record || record.state !== 'published') fail('STATEMENT_TOKEN_STALE', 'Statement token is stale');
    const handle = record.handle;
    if (now() >= handle.expiresAt) fail('STATEMENT_TOKEN_EXPIRED', 'Statement token expired');
    for (const key of ['purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest']) {
      if (token[key] !== handle[key]) fail('STATEMENT_TOKEN_TAMPERED', `Statement token ${key} mismatch`);
    }
    if (expected.serviceGeneration !== handle.serviceGeneration ||
        expected.sessionRevision !== handle.sessionRevision ||
        expected.purpose !== handle.purpose || expected.sessionKey !== handle.sessionKey ||
        !isDeepStrictEqual(expected.evidence, record.privateContext.evidence)) {
      fail('STATEMENT_TOKEN_STALE', 'Statement token evidence is stale');
    }
    if (canonicalSha256(expected.choiceDomain) !== handle.allowedChoiceDigest) {
      fail('STATEMENT_TOKEN_CHOICE_DOMAIN_STALE', 'Statement token choice domain changed');
    }
    const claimedChoice = claimBigAccountChoice(expected.choice, expected.choiceDomain);
    record.claimedChoice = claimedChoice;
    record.state = 'consuming';
    return record;
  }

  function claimCancellation(publicToken, expected) {
    const token = createStatementPublicTokenIdentity(publicToken);
    const record = records.get(token.tokenId);
    if (!record || !['published', 'releasing'].includes(record.state)) {
      fail('STATEMENT_TOKEN_STALE', 'Statement token is not cancellable');
    }
    const handle = record.handle;
    for (const key of ['purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest']) {
      if (token[key] !== handle[key]) fail('STATEMENT_TOKEN_TAMPERED', `Statement token ${key} mismatch`);
    }
    if (expected.serviceGeneration !== handle.serviceGeneration ||
        expected.sessionRevision !== handle.sessionRevision ||
        expected.purpose !== handle.purpose) {
      fail('STATEMENT_TOKEN_STALE', 'Statement cancellation identity is stale');
    }
    return record;
  }

  function remove(tokenId) {
    const record = records.get(tokenId);
    if (!record) return null;
    records.delete(tokenId);
    totalBytes -= record.bytes;
    record.state = 'released';
    return record;
  }

  function markReleasing(tokenId) {
    const record = records.get(tokenId);
    if (!record || !['published', 'consuming', 'inserted'].includes(record.state)) {
      fail('STATEMENT_TOKEN_STALE', 'Statement token cannot be released');
    }
    record.state = 'releasing';
    return record;
  }

  function listStatus() {
    return [...records.values()]
      .filter((record) => record.state === 'published')
      .map((record) => ({ purpose: record.handle.purpose, expiresAt: record.handle.expiresAt }));
  }

  function listRecords() {
    return [...records.values()];
  }

  return Object.freeze({
    beginConsume,
    claimCancellation,
    insertPrivate,
    inspect,
    listStatus,
    listRecords,
    markAdopted,
    markReleasing,
    prepare,
    prepareReplacement,
    remove,
    snapshot: () => Object.freeze({ count: records.size, totalBytes })
  });
}

module.exports = {
  StatementTokenStoreError,
  createStatementTokenStore
};
