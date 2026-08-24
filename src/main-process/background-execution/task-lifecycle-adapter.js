'use strict';

const { canonicalJsonSnapshot } = require('./canonical-json-v1');
const { transitionRequestKey } = require('./recovery-control-contract');

function assertDependencies(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Recovery lifecycle adapter options 必须是对象');
  }
  const binding = options.actionTaskBindingRegistry;
  const owner = options.requestOwnerRepository;
  const control = options.recoveryControlRepository;
  if (!binding || typeof binding.assertPair !== 'function') {
    throw new TypeError('Recovery lifecycle adapter 需要 ActionTaskBindingRegistry');
  }
  if (!owner || typeof owner.reserveTransitionRequest !== 'function') {
    throw new TypeError('Recovery lifecycle adapter 需要 RecoveryRequestOwnerRepository');
  }
  if (!control || typeof control.runInControlTransaction !== 'function') {
    throw new TypeError('Recovery lifecycle adapter 需要 RecoveryControlRepository');
  }
  return { binding, owner, control };
}

function createRecoveryTransitionAdapter(options) {
  const { binding, owner, control } = assertDependencies(options);

  function reserve(item) {
    const owned = canonicalJsonSnapshot(item);
    binding.assertPair(owned.transition.actionKey, owned.transition.expectedTaskKey);
    return owner.reserveTransitionRequest({
      requestKey: transitionRequestKey(owned.transition),
      transition: owned.transition,
      safePayload: owned.safePayload
    });
  }

  return Object.freeze({
    transition(transition, safePayload) {
      const reserved = reserve({ transition, safePayload });
      return control.runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(reserved));
    },

    transitionMany(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new TypeError('transitionMany items 必须是非空数组');
      }
      const reserved = items.map(reserve);
      return control.runInControlTransaction((tx) => Object.freeze(
        reserved.map((request) => tx.transitionWithRecoveryEvent(request))
      ));
    }
  });
}

function taskBase(payload) {
  return {
    entityKind: 'task-run',
    actionKey: payload.actionKey,
    expectedTaskKey: payload.expectedTaskKey,
    operationKey: payload.operationKey,
    taskRunId: payload.taskRunId,
    sourceKind: payload.sourceKind ?? null,
    sourceRef: payload.sourceRef ?? null
  };
}

function createRecoveryTaskLifecycleAdapter(options) {
  const transitionAdapter = createRecoveryTransitionAdapter(options);
  return Object.freeze({
    settleInterrupted(payload = {}) {
      return transitionAdapter.transition({
        ...taskBase(payload),
        command: 'mark-interrupted',
        expectedState: payload.expectedState,
        failureCode: payload.failureCode,
        failureMessage: payload.failureMessage,
        metadataPatch: payload.metadataPatch || {}
      }, payload.safePayload || {});
    },

    beginRecovery(payload = {}) {
      return transitionAdapter.transition({
        ...taskBase(payload),
        command: 'begin-recovery',
        expectedState: 'interrupted',
        recoveryAttemptId: payload.recoveryAttemptId,
        metadataPatch: payload.metadataPatch || {}
      }, payload.safePayload || {});
    },

    settleRecovery(payload = {}) {
      const toStatus = payload.toStatus;
      if (!['succeeded', 'failed', 'interrupted'].includes(toStatus)) {
        throw new TypeError('settleRecovery.toStatus 只支持 succeeded/failed/interrupted');
      }
      const success = toStatus === 'succeeded';
      if (success && (payload.failureCode !== undefined || payload.failureMessage !== undefined)) {
        throw new TypeError('recovery success 不接受 failureCode/failureMessage');
      }
      if (!success && (typeof payload.failureCode !== 'string'
          || typeof payload.failureMessage !== 'string')) {
        throw new TypeError('recovery failed/interrupted 必须提供 failureCode/failureMessage');
      }
      return transitionAdapter.transition({
        ...taskBase(payload),
        command: success
          ? 'complete-recovery-success'
          : toStatus === 'failed'
            ? 'complete-recovery-failure'
            : 'interrupt-recovery',
        expectedState: 'running',
        recoveryAttemptId: payload.recoveryAttemptId,
        ...(success ? {} : {
          failureCode: payload.failureCode,
          failureMessage: payload.failureMessage
        }),
        metadataPatch: payload.metadataPatch || {}
      }, payload.safePayload || {});
    }
  });
}

function batchBase(payload) {
  return {
    entityKind: 'batch-overlay',
    actionKey: payload.actionKey,
    expectedTaskKey: payload.expectedTaskKey,
    operationKey: payload.operationKey,
    batchId: payload.batchId,
    taskRunId: payload.taskRunId,
    sourceKind: payload.sourceKind,
    sourceRef: payload.sourceRef
  };
}

function createBatchRecoveryOverlayAdapter(options) {
  const transitionAdapter = createRecoveryTransitionAdapter(options);
  return Object.freeze({
    markInterrupted(payload = {}) {
      return transitionAdapter.transition({
        ...batchBase(payload),
        command: 'mark-interrupted',
        expectedState: null,
        failureCode: payload.failureCode,
        failureMessage: payload.failureMessage
      }, payload.safePayload || {});
    },

    beginRecovery(payload = {}) {
      return transitionAdapter.transition({
        ...batchBase(payload),
        command: 'begin-recovery',
        expectedState: 'interrupted',
        recoveryAttemptId: payload.recoveryAttemptId
      }, payload.safePayload || {});
    },

    resolve(payload = {}) {
      if (!['succeeded', 'failed'].includes(payload.finalOutcome)) {
        throw new TypeError('Batch overlay finalOutcome 只支持 succeeded/failed');
      }
      return transitionAdapter.transition({
        ...batchBase(payload),
        command: payload.finalOutcome === 'succeeded' ? 'resolve-success' : 'resolve-failure',
        expectedState: 'recovering',
        recoveryAttemptId: payload.recoveryAttemptId,
        finalOutcome: payload.finalOutcome
      }, payload.safePayload || {});
    }
  });
}

module.exports = {
  createBatchRecoveryOverlayAdapter,
  createRecoveryTaskLifecycleAdapter,
  createRecoveryTransitionAdapter
};
