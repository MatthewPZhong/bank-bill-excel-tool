'use strict';

const { canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');

const TOKEN_KEYS = Object.freeze([
  'tokenId', 'purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest'
]);
const CLEANUP_RECEIPT_KEYS = Object.freeze(['status', 'tokenId']);
const TERMINAL_FORGET_KEYS = Object.freeze(['taskRunId', 'tokenId']);

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

  function exactBoundedCleanupReceipt(input) {
    let receipt;
    try {
      receipt = canonicalJsonSnapshot(input, { maxBytes: 4096 });
    } catch (_error) {
      fail('STATEMENT_CANCEL_ACK_INVALID', 'Cancellation owner returned an invalid cleanup receipt');
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).length !== CLEANUP_RECEIPT_KEYS.length ||
        CLEANUP_RECEIPT_KEYS.some((key) => !Object.hasOwn(receipt, key)) ||
        !['interaction-cancelled', 'interaction-crash-cleaned'].includes(receipt.status) ||
        typeof receipt.tokenId !== 'string' || receipt.tokenId.length === 0 ||
        receipt.tokenId.length > 256) {
      fail('STATEMENT_CANCEL_ACK_INVALID', 'Cancellation owner did not return an exact cleanup receipt');
    }
    return receipt;
  }

  function exactBoundedForgetIdentity(input) {
    let identity;
    try {
      identity = canonicalJsonSnapshot(input, { maxBytes: 4096 });
    } catch (_error) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Terminal forget identity is invalid');
    }
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        Object.keys(identity).length !== TERMINAL_FORGET_KEYS.length ||
        TERMINAL_FORGET_KEYS.some((key) => !Object.hasOwn(identity, key)) ||
        typeof identity.taskRunId !== 'string' || identity.taskRunId.length === 0 ||
        identity.taskRunId.length > 512 || typeof identity.tokenId !== 'string' ||
        identity.tokenId.length === 0 || identity.tokenId.length > 256) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Terminal forget identity must be exact and bounded');
    }
    return identity;
  }

  function continuationIdentityMatches(record, input, token) {
    return record.taskKey === input.taskKey &&
      record.operationKey === input.originOperationKey &&
      typeof input.operationKey === 'string' && input.operationKey.length > 0 &&
      TOKEN_KEYS.every((key) => record.token[key] === token[key]);
  }

  function phaseAcquireError(error) {
    const code = error && typeof error.code === 'string'
      ? error.code
      : 'STATEMENT_PHASE_ACQUIRE_FAILED';
    const message = error && typeof error.message === 'string'
      ? error.message.slice(0, 1024)
      : 'Continuation phase acquisition failed';
    return Object.freeze({ code, message });
  }

  function throwRecordedPhaseError(record) {
    const saved = record.phaseAcquireError;
    throw new StatementWaitingUserError(saved.code, saved.message);
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
    if (!record || !['waiting-user', 'continuation-cleanup-required'].includes(record.state)) {
      fail('STATEMENT_WAITING_STALE', 'Task is not waiting for this interaction');
    }
    if (!continuationIdentityMatches(record, input, token)) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Continuation identity does not match waiting task');
    }
    if (record.state === 'continuation-cleanup-required') {
      if (record.continuationJobId !== input.jobId ||
          record.continuationOperationKey !== input.operationKey) {
        fail(
          'STATEMENT_CONTINUATION_OWNER_MISMATCH',
          'Only the failed continuation owner may retry lock cleanup'
        );
      }
      await input.lockOwner.release(record.lockId, input.jobId);
      record.lockId = null;
      record.lockReleased = true;
      record.state = 'waiting-user';
      record.continuationJobId = null;
      record.continuationOperationKey = null;
      throwRecordedPhaseError(record);
    }
    record.state = 'acquiring-continuation';
    let lock;
    let phase;
    try {
      lock = await input.lockOwner.acquire(input.taskRunId, input.jobId);
      phase = await input.phaseOwner.acquire(input.taskRunId, input.jobId);
    } catch (error) {
      if (!lock) {
        record.state = 'waiting-user';
        throw error;
      }
      record.state = 'continuation-cleanup-required';
      record.continuationJobId = input.jobId;
      record.continuationOperationKey = input.operationKey;
      record.lockId = lock.id;
      record.lockReleased = false;
      record.phaseAcquireError = phaseAcquireError(error);
      try {
        await input.lockOwner.release(lock.id, input.jobId);
      } catch (_cleanupError) {
        fail(
          'STATEMENT_CONTINUATION_CLEANUP_REQUIRED',
          'Continuation phase failed and the acquired business lock still requires cleanup'
        );
      }
      record.lockId = null;
      record.lockReleased = true;
      record.state = 'waiting-user';
      record.continuationJobId = null;
      record.continuationOperationKey = null;
      throw error;
    }
    record.state = 'executing';
    record.continuationJobId = input.jobId;
    record.continuationOperationKey = input.operationKey;
    record.lockId = lock.id;
    record.phaseLeaseId = phase.id;
    record.phaseReleased = false;
    record.lockReleased = false;
    record.phaseAcquireError = null;
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

  function cancelInteraction(input) {
    const token = boundedToken(input.token);
    const record = tasks.get(input.taskRunId);
    if (!record || !['waiting-user', 'cancelling-interaction', 'cancelled', 'interrupted'].includes(record.state)) {
      fail('STATEMENT_WAITING_STALE', 'Task is not waiting for this interaction');
    }
    if (record.taskKey !== input.taskKey || record.operationKey !== input.originOperationKey ||
        TOKEN_KEYS.some((key) => record.token[key] !== token[key]) ||
        typeof input.cancelOwnerKey !== 'string' || input.cancelOwnerKey.length === 0 ||
        input.cancelOwnerKey.length > 256) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Cancellation identity does not match waiting task');
    }
    if (record.cancelOwnerKey && record.cancelOwnerKey !== input.cancelOwnerKey) {
      fail('STATEMENT_CONTINUATION_OWNER_MISMATCH', 'Cancellation retry owner does not match');
    }
    if (['cancelled', 'interrupted'].includes(record.state)) return Promise.resolve(record.cancelResult);
    if (record.state === 'cancelling-interaction') return record.cancelPromise;
    if (!input.cancelOwner || typeof input.cancelOwner.cancel !== 'function') {
      fail('STATEMENT_CANCEL_OWNER_INVALID', 'Cancellation owner is unavailable');
    }
    record.state = 'cancelling-interaction';
    record.cancelOwnerKey = input.cancelOwnerKey;
    const cancellation = Promise.resolve().then(() => input.cancelOwner.cancel(Object.freeze({
      taskRunId: record.taskRunId,
      taskKey: record.taskKey,
      originOperationKey: record.operationKey,
      token: record.token
    }))).then((result) => {
      const receipt = exactBoundedCleanupReceipt(result);
      if (receipt.tokenId !== record.token.tokenId) {
        fail('STATEMENT_CANCEL_ACK_INVALID', 'Cancellation owner did not confirm exact token cleanup');
      }
      const crashed = receipt.status === 'interaction-crash-cleaned';
      record.state = crashed ? 'interrupted' : 'cancelled';
      record.cancelPromise = null;
      record.cancelResult = Object.freeze({
        taskRunId: record.taskRunId,
        status: crashed ? 'interrupted' : 'cancelled',
        phase: crashed ? 'recovery-required' : null
      });
      return record.cancelResult;
    }).catch((error) => {
      record.state = 'waiting-user';
      record.cancelPromise = null;
      throw error;
    });
    record.cancelPromise = cancellation;
    return cancellation;
  }

  function forgetCancelled(input) {
    const identity = exactBoundedForgetIdentity(input);
    const record = tasks.get(identity.taskRunId);
    if (!record || record.state !== 'cancelled') return false;
    if (record.token.tokenId !== identity.tokenId) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Cancelled token identity does not match');
    }
    tasks.delete(identity.taskRunId);
    return true;
  }

  function forgetInterrupted(input) {
    const identity = exactBoundedForgetIdentity(input);
    const record = tasks.get(identity.taskRunId);
    if (!record || record.state !== 'interrupted') return false;
    if (record.token.tokenId !== identity.tokenId) {
      fail('STATEMENT_WAITING_IDENTITY_MISMATCH', 'Interrupted token identity does not match');
    }
    tasks.delete(identity.taskRunId);
    return true;
  }

  return Object.freeze({
    beginContinuation,
    cancelInteraction,
    enterWaiting,
    forgetCancelled,
    forgetInterrupted,
    settleContinuation
  });
}

module.exports = {
  StatementWaitingUserError,
  createStatementWaitingUserCoordinator
};
