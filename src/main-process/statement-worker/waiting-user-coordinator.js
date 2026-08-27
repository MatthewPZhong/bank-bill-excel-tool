'use strict';

const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');

const TOKEN_KEYS = Object.freeze([
  'tokenId', 'purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest'
]);

class StatementWaitingUserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementWaitingUserError';
    this.code = code;
  }
}

function createStatementWaitingUserCoordinator() {
  const tasks = new Map();

  function fail(code, message) {
    throw new StatementWaitingUserError(code, message);
  }

  function boundedToken(input) {
    const token = canonicalJsonSnapshot(input, { maxBytes: 4096 });
    if (!token || typeof token !== 'object' || Array.isArray(token) ||
        Object.keys(token).length !== TOKEN_KEYS.length ||
        TOKEN_KEYS.some((key) => !Object.hasOwn(token, key)) ||
        typeof token.tokenId !== 'string' || token.tokenId.length === 0 || token.tokenId.length > 256 ||
        token.purpose !== 'big-account' ||
        !Number.isSafeInteger(token.serviceGeneration) || token.serviceGeneration < 1 ||
        !Number.isSafeInteger(token.sessionRevision) || token.sessionRevision < 0 ||
        !Number.isSafeInteger(token.expiresAt) || token.expiresAt < 1 ||
        !/^[0-9a-f]{64}$/.test(token.allowedChoiceDigest)) {
      fail('STATEMENT_WAITING_TOKEN_INVALID', 'Waiting-user token must be an exact bounded public handle');
    }
    return Object.freeze(token);
  }

  async function enterWaiting(input) {
    const token = boundedToken(input.token);
    let record = tasks.get(input.taskRunId);
    if (record) {
      if (record.originJobId !== input.jobId || record.token.tokenId !== token.tokenId ||
          !['entering-wait', 'waiting-user'].includes(record.state)) {
        fail('STATEMENT_WAITING_DUPLICATE', 'Task already has a different waiting interaction');
      }
      if (record.state === 'waiting-user') {
        return Object.freeze({ taskRunId: input.taskRunId, status: 'running', phase: 'waiting-user' });
      }
    } else {
      record = {
        taskRunId: input.taskRunId,
        taskKey: input.taskKey,
        operationKey: input.operationKey,
        originJobId: input.jobId,
        token,
        state: 'entering-wait',
        continuationJobId: null,
        continuationOperationKey: null,
        phaseLeaseId: input.phaseLeaseId,
        lockId: input.lockId,
        phaseReleased: false,
        lockReleased: false
      };
      tasks.set(input.taskRunId, record);
    }
    if (!record.phaseReleased) {
      await input.phaseOwner.release(record.phaseLeaseId, input.jobId);
      record.phaseReleased = true;
    }
    if (!record.lockReleased) {
      await input.lockOwner.release(record.lockId, input.jobId);
      record.lockReleased = true;
    }
    record.state = 'waiting-user';
    record.phaseLeaseId = null;
    record.lockId = null;
    return Object.freeze({ taskRunId: input.taskRunId, status: 'running', phase: 'waiting-user' });
  }

  async function beginContinuation(input) {
    const token = boundedToken(input.token);
    const record = tasks.get(input.taskRunId);
    if (!record || record.state !== 'waiting-user') fail('STATEMENT_WAITING_STALE', 'Task is not waiting for this interaction');
    if (record.taskKey !== input.taskKey || record.operationKey !== input.originOperationKey ||
        typeof input.operationKey !== 'string' || input.operationKey.length === 0 ||
        TOKEN_KEYS.some((key) => record.token[key] !== token[key])) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Continuation identity does not match waiting task');
    }
    record.state = 'acquiring-continuation';
    let lock;
    let phase;
    try {
      lock = await input.lockOwner.acquire(input.taskRunId, input.jobId);
      phase = await input.phaseOwner.acquire(input.taskRunId, input.jobId);
    } catch (error) {
      if (lock) await input.lockOwner.release(lock.id, input.jobId);
      record.state = 'waiting-user';
      throw error;
    }
    record.state = 'executing';
    record.continuationJobId = input.jobId;
    record.continuationOperationKey = input.operationKey;
    record.lockId = lock.id;
    record.phaseLeaseId = phase.id;
    record.phaseReleased = false;
    record.lockReleased = false;
    return Object.freeze({ taskRunId: input.taskRunId, status: 'running', phase: 'executing' });
  }

  async function settleContinuation(input) {
    const record = tasks.get(input.taskRunId);
    if (!record || !['executing', 'settling-continuation'].includes(record.state) ||
        record.continuationJobId !== input.jobId ||
        record.continuationOperationKey !== input.operationKey) {
      fail('STATEMENT_CONTINUATION_OWNER_MISMATCH', 'Only the active continuation owner may settle');
    }
    record.state = 'settling-continuation';
    if (!record.phaseReleased) {
      await input.phaseOwner.release(record.phaseLeaseId, input.jobId);
      record.phaseReleased = true;
    }
    if (!record.lockReleased) {
      await input.lockOwner.release(record.lockId, input.jobId);
      record.lockReleased = true;
    }
    if (input.nextToken) {
      record.token = boundedToken(input.nextToken);
      record.state = 'waiting-user';
      record.continuationJobId = null;
      record.continuationOperationKey = null;
      record.phaseLeaseId = null;
      record.lockId = null;
      record.phaseReleased = true;
      record.lockReleased = true;
      return Object.freeze({ taskRunId: input.taskRunId, status: 'running', phase: 'waiting-user' });
    }
    tasks.delete(input.taskRunId);
    return Object.freeze({ taskRunId: input.taskRunId, status: input.outcome, phase: null });
  }

  function invalidate(input) {
    const record = tasks.get(input.taskRunId);
    if (!record) return false;
    if (record.token.tokenId !== input.tokenId) fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Invalidation token mismatch');
    if (record.state !== 'waiting-user') {
      fail('STATEMENT_CONTINUATION_ACTIVE', 'Cannot invalidate while an ownership transition is active');
    }
    tasks.delete(input.taskRunId);
    return true;
  }

  return Object.freeze({ beginContinuation, enterWaiting, invalidate, settleContinuation });
}

module.exports = {
  StatementWaitingUserError,
  createStatementWaitingUserCoordinator
};
