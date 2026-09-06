'use strict';

const crypto = require('node:crypto');
const { canonicalSha256, canonicalJsonSnapshot } = require('./canonical-json-v1');

// 只标识当前 Main 进程，不能由新进程据此推断旧进程已退出。
const MAIN_PROCESS_INSTANCE_ID = `main-${crypto.randomUUID()}`;

function createCarrierIdentity({ context, actionKey, operationKey, jobId, workerInstanceId, runtimeInstanceId }) {
  return canonicalJsonSnapshot({
    taskRunId: context.value.taskRunId,
    taskKey: context.value.taskKey,
    actionKey,
    operationKey,
    jobId,
    workerInstanceId,
    runtimeInstanceId,
    sessionId: MAIN_PROCESS_INSTANCE_ID,
    processInstanceId: MAIN_PROCESS_INSTANCE_ID,
    carrierKind: 'thread-single',
    dispatchNonce: `dispatch-${crypto.randomUUID()}`
  });
}

function createCarrierObservation(identity, readFacts, now = Date.now) {
  const waiters = new Set();
  let snapshot = null;
  let factHash = null;
  function terminal(value) {
    return ['NOT_CREATED', 'EXITED'].includes(value.disposition);
  }
  function refresh() {
    const facts = readFacts();
    const nextHash = canonicalSha256(facts);
    if (nextHash !== factHash) {
      const value = { contractVersion: 1, ...identity, ...facts,
        observationSequence: snapshot ? snapshot.observationSequence + 1 : 1, observedAt: now() };
      snapshot = canonicalJsonSnapshot({ ...value, evidenceDigest: canonicalSha256(value) });
      factHash = nextHash;
    }
    if (terminal(snapshot)) {
      for (const waiter of [...waiters]) waiter(snapshot);
    }
    return snapshot;
  }
  function waitForCarrierClosure({ timeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000) {
      throw new TypeError('关闭观察 timeoutMs 必须是 0..300000 的整数');
    }
    const current = refresh();
    if (terminal(current) || timeoutMs === 0) return Promise.resolve(current);
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(value);
      };
      waiters.add(finish);
      timer = setTimeout(() => finish(refresh()), timeoutMs);
    });
  }
  return Object.freeze({ refresh, getCarrierObservation: refresh, waitForCarrierClosure });
}

module.exports = { createCarrierIdentity, createCarrierObservation };
