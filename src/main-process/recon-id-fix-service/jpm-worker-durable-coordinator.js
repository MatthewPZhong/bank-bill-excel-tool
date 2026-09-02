'use strict';

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { transitionRequestKey } = require('../background-execution/recovery-control-contract');
const { normalizeRecoverySource } = require('../background-execution/recovery-source');
const { deriveReconFixJpmConflictScopeKey } = require('./jpm-conflict-scope');
const { normalizeJpmIntentEvidence } = require('./jpm-outcome-inspector');
const {
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_RUN_JPM_ACTION
} = require('./policies');

function coordinatorError(code, message) {
  return Object.assign(new Error(message), { code });
}

function deriveWorkerInstanceIdentity(workerInstanceId) {
  if (typeof workerInstanceId !== 'string' || !workerInstanceId ||
      workerInstanceId.trim() !== workerInstanceId ||
      Buffer.byteLength(workerInstanceId, 'utf8') > 256) {
    throw coordinatorError(
      'RECON_FIX_JPM_CRITICAL_IDENTITY_INVALID',
      'JPM worker instance identity 非法'
    );
  }
  return canonicalSha256(['recon-fix-jpm-worker-instance-v1', workerInstanceId]);
}

function createReceiptWaiter(identity) {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => {});
  return { ...identity, promise, resolve, reject, settled: false };
}

function createReconFixJpmWorkerDurableCoordinator(options = {}) {
  const required = [
    'readRepository',
    'requestOwnerRepository',
    'recoveryControlRepository',
    'recoveryCoordinator',
    'receiptAuthority'
  ];
  if (required.some((key) => !options[key]) ||
      typeof options.databaseIdentity !== 'string' ||
      !/^[a-f0-9]{64}$/.test(options.databaseIdentity) ||
      typeof options.receiptAuthority.find !== 'function' ||
      typeof options.receiptAuthority.verify !== 'function') {
    throw new TypeError('ReconFix JPM WorkerDurableCoordinator依赖不完整');
  }
  const readRepository = options.readRepository;
  const requestOwnerRepository = options.requestOwnerRepository;
  const recoveryControlRepository = options.recoveryControlRepository;
  const recoveryCoordinator = options.recoveryCoordinator;
  const receiptAuthority = options.receiptAuthority;
  const databaseIdentity = options.databaseIdentity;
  const conflictScopeGate = typeof options.conflictScopeGate === 'function'
    ? options.conflictScopeGate
    : null;
  const receiptWaiters = new Map();

  function reserveTransition(transition, safePayload) {
    return requestOwnerRepository.reserveTransitionRequest({
      requestKey: transitionRequestKey(transition),
      transition,
      safePayload
    });
  }

  function writeTransition(transition, safePayload) {
    const request = reserveTransition(transition, safePayload);
    return recoveryControlRepository.runInControlTransaction(
      (tx) => tx.transitionWithRecoveryEvent(request)
    );
  }

  function writeTransitions(entries) {
    const requests = entries.map(({ transition, safePayload }) =>
      reserveTransition(transition, safePayload));
    return recoveryControlRepository.runInControlTransaction((tx) =>
      requests.map((request) => tx.transitionWithRecoveryEvent(request)));
  }

  function exactCritical(input) {
    if (input.actionKey !== RECON_FIX_RUN_JPM_ACTION ||
        input.unitId !== RECON_FIX_JPM_UNIT_ID ||
        typeof input.parentOperationKey !== 'string' || !input.parentOperationKey ||
        typeof input.taskRunId !== 'string' || !input.taskRunId ||
        typeof input.jobId !== 'string' || !input.jobId ||
        !input.policy || input.policy.commit.inspectorKey !== 'inspector.recon-fix:run-jpm') {
      throw coordinatorError(
        'RECON_FIX_JPM_CRITICAL_IDENTITY_INVALID',
        'JPM critical route/task identity 非法'
      );
    }
    const critical = input.critical;
    if (!critical || critical.contractVersion !== 1 ||
        Object.keys(critical).sort().join(',') !== [
          'boundedSummary',
          'changedRowCount',
          'contractVersion',
          'databaseIdentity',
          'idSequenceDigest',
          'postImageHash',
          'preImageHash',
          'resultHandle',
          'rowCount',
          'scenarioId'
        ].sort().join(',') || critical.databaseIdentity !== databaseIdentity) {
      throw coordinatorError(
        'RECON_FIX_JPM_CRITICAL_PAYLOAD_INVALID',
        'JPM critical contractVersion 非法'
      );
    }
    const boundedEvidence = normalizeJpmIntentEvidence(Object.freeze({
      scenarioId: critical.scenarioId,
      databaseIdentity: critical.databaseIdentity,
      workerInstanceIdentity: deriveWorkerInstanceIdentity(input.workerInstanceId),
      preImageHash: critical.preImageHash,
      postImageHash: critical.postImageHash,
      idSequenceDigest: critical.idSequenceDigest,
      rowCount: critical.rowCount,
      changedRowCount: critical.changedRowCount,
      resultHandle: critical.resultHandle,
      boundedSummary: critical.boundedSummary
    }));
    const conflictScopeKey = deriveReconFixJpmConflictScopeKey();
    return Object.freeze({
      intentId: `recon-jpm-intent-${canonicalSha256([
        input.actionKey,
        input.parentOperationKey,
        input.taskRunId
      ])}`,
      operationKey: input.parentOperationKey,
      conflictScopeKey,
      boundedEvidence,
      evidenceHash: canonicalSha256(boundedEvidence)
    });
  }

  function assertNoReplay(input, prepared) {
    if (receiptAuthority.find(input.actionKey, prepared.operationKey)) {
      throw coordinatorError(
        'RECON_FIX_JPM_OPERATION_ALREADY_COMMITTED',
        'JPM operationKey 已有 authoritative receipt，禁止重跑 mutation'
      );
    }
    const conflicts = readRepository.listCriticalIntentsByScope(prepared.conflictScopeKey)
      .filter((intent) => intent.actionKey === input.actionKey &&
        intent.operationKey === prepared.operationKey);
    if (conflicts.length > 0) {
      throw coordinatorError(
        'RECON_FIX_JPM_OPERATION_REPLAY_FORBIDDEN',
        'JPM operationKey 已有 Critical Intent，禁止重新 ACK mutation'
      );
    }
  }

  function assertExistingExact(existing, input, prepared) {
    if (!existing || existing.intentId !== prepared.intentId ||
        existing.actionKey !== input.actionKey ||
        existing.operationKey !== prepared.operationKey ||
        existing.taskRunId !== input.taskRunId || existing.jobId !== input.jobId ||
        !['prepared', 'acked'].includes(existing.state) ||
        existing.conflictScopeKey !== prepared.conflictScopeKey ||
        existing.inspectorKey !== input.policy.commit.inspectorKey ||
        existing.evidenceHash !== prepared.evidenceHash) {
      throw coordinatorError(
        'RECON_FIX_JPM_INTENT_IDENTITY_CONFLICT',
        'JPM Critical Intent identity/state 冲突'
      );
    }
  }

  async function prepareAndAck(input) {
    const prepared = exactCritical(input);
    if (conflictScopeGate) await conflictScopeGate(prepared.conflictScopeKey);
    assertNoReplay(input, prepared);
    if (receiptWaiters.has(input.jobId)) {
      throw coordinatorError(
        'RECON_FIX_JPM_RECEIPT_WAITER_CONFLICT',
        'JPM jobId 已绑定 pending receipt waiter'
      );
    }
    writeTransitions([{
        transition: {
          entityKind: 'critical-intent',
          command: 'create-prepared',
          input: {
            contractVersion: 1,
            intentId: prepared.intentId,
            actionKey: input.actionKey,
            operationKey: prepared.operationKey,
            taskRunId: input.taskRunId,
            jobId: input.jobId,
            coordinationKind: 'worker-critical',
            conflictScopeKey: prepared.conflictScopeKey,
            inspectorKey: input.policy.commit.inspectorKey,
            evidenceVersion: 1,
            evidenceHash: prepared.evidenceHash,
            boundedEvidence: prepared.boundedEvidence
          }
        },
        safePayload: { state: 'prepared', unitId: input.unitId }
      }, {
        transition: {
          entityKind: 'critical-intent',
          command: 'mark-acked',
          intentId: prepared.intentId,
          expectedState: 'prepared',
          patch: { admission: 'main-persisted-before-worker-ack' }
        },
        safePayload: { state: 'acked', unitId: input.unitId }
      }]);
    let existing = readRepository.getCriticalIntentById(prepared.intentId);
    assertExistingExact(existing, input, prepared);
    if (existing.state !== 'acked') {
      throw coordinatorError(
        'RECON_FIX_JPM_INTENT_STATE_INVALID',
        'JPM Critical Intent不能进入ACK状态'
      );
    }

    const waiter = createReceiptWaiter({
      actionKey: input.actionKey,
      operationKey: prepared.operationKey,
      jobId: input.jobId,
      workerInstanceIdentity: prepared.boundedEvidence.workerInstanceIdentity,
      unitId: input.unitId,
      intentId: existing.intentId
    });
    receiptWaiters.set(input.jobId, waiter);
    return Object.freeze({
      intentId: existing.intentId,
      fileOperationKey: prepared.operationKey
    });
  }

  async function acceptNoop(input) {
    if (input.actionKey !== RECON_FIX_RUN_JPM_ACTION ||
        input.unitId !== RECON_FIX_JPM_UNIT_ID ||
        typeof input.parentOperationKey !== 'string' || !input.parentOperationKey ||
        typeof input.taskRunId !== 'string' || !input.taskRunId ||
        !input.result || input.result.resultKind !== 'noop' ||
        typeof input.result.resultHandle !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.result.resultHandle)) {
      return false;
    }
    assertNoNoopReplay(input.actionKey, input.parentOperationKey);
    return true;
  }

  function assertNoNoopReplay(actionKey, operationKey) {
    if (receiptAuthority.find(actionKey, operationKey)) {
      throw coordinatorError(
        'RECON_FIX_JPM_OPERATION_ALREADY_COMMITTED',
        'JPM noop operationKey 已有 authoritative receipt，禁止覆盖 replay identity'
      );
    }
    const conflictingIntent = readRepository.listCriticalIntentsByScope(
      deriveReconFixJpmConflictScopeKey()
    ).find((intent) => intent.actionKey === actionKey &&
      intent.operationKey === operationKey);
    if (conflictingIntent) {
      throw coordinatorError(
        'RECON_FIX_JPM_NOOP_INTENT_CONFLICT',
        'JPM noop 与既有 Critical Intent 冲突'
      );
    }
  }

  function sourceForIntent(intent) {
    return normalizeRecoverySource({
      contractVersion: 1,
      sourceKind: 'critical-intent',
      sourceRef: `critical-intent:${intent.intentId}`,
      actionKey: intent.actionKey,
      operationKey: intent.operationKey,
      taskRunId: intent.taskRunId,
      conflictScopeKey: intent.conflictScopeKey,
      inspectorKey: intent.inspectorKey,
      settlementKey: null,
      intentId: intent.intentId,
      evidenceVersion: intent.evidenceVersion,
      boundedEvidence: intent.boundedEvidence
    });
  }

  function matchingWaiter(input) {
    const waiter = receiptWaiters.get(input.jobId);
    if (!waiter || waiter.actionKey !== input.actionKey ||
        waiter.operationKey !== input.fileOperationKey ||
        waiter.workerInstanceIdentity !== deriveWorkerInstanceIdentity(input.workerInstanceId) ||
        waiter.unitId !== input.unitId || waiter.intentId !== input.intentId) {
      throw coordinatorError(
        'RECON_FIX_JPM_RECEIPT_WAITER_MISSING',
        'JPM receipt 缺少 matching in-memory adoption gate'
      );
    }
    return waiter;
  }

  async function observeReceipt(input) {
    const waiter = matchingWaiter(input);
    try {
      const intent = readRepository.getCriticalIntentById(input.intentId);
      if (!intent || intent.state !== 'acked' || intent.actionKey !== input.actionKey ||
          intent.operationKey !== input.fileOperationKey || intent.taskRunId !== input.taskRunId) {
        throw coordinatorError('RECON_FIX_JPM_INTENT_MISSING', 'JPM receipt 缺少 matching ACKed Intent');
      }
      const verified = await receiptAuthority.verify(Object.freeze({
        source: sourceForIntent(intent),
        receipt: input.receipt
      }));
      writeTransition({
        entityKind: 'critical-intent',
        command: 'mark-committed',
        intentId: intent.intentId,
        expectedState: 'acked',
        receiptRef: {
          receiptKind: 'module-local',
          receiptDigest: verified.bounded.receiptDigest,
          actionKey: intent.actionKey,
          operationKey: intent.operationKey
        }
      }, { state: 'committed', receiptDigest: verified.bounded.receiptDigest });
      waiter.settled = true;
      waiter.resolve(true);
      return Object.freeze({
        receiptHint: {
          receiptKind: 'module-local',
          receiptIdentity: verified.bounded.receiptDigest
        }
      });
    } catch (error) {
      waiter.settled = true;
      waiter.reject(error);
      throw error;
    }
  }

  async function awaitPersistentStateAdoption(input) {
    if (input.actionKey !== RECON_FIX_RUN_JPM_ACTION) return true;
    const waiter = receiptWaiters.get(input.jobId);
    // No waiter means either pre-critical invalidation or exact noop.  Gate the
    // operation identity before Service adopts either candidate, then unit:done
    // repeats the bounded result validation for the exact noop terminal.
    if (!waiter) {
      assertNoNoopReplay(input.actionKey, input.operationKey);
      return true;
    }
    if (waiter.operationKey !== input.operationKey || waiter.unitId !== input.unitId ||
        waiter.workerInstanceIdentity !== deriveWorkerInstanceIdentity(input.workerInstanceId)) {
      throw coordinatorError(
        'RECON_FIX_JPM_ADOPTION_IDENTITY_CONFLICT',
        'JPM persistent adoption 与 Critical Intent identity 不匹配'
      );
    }
    if (!input.signal) return waiter.promise;
    if (input.signal.aborted) {
      throw coordinatorError('RECON_FIX_JPM_ADOPTION_ABORTED', 'JPM persistent adoption 已中止');
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(coordinatorError(
        'RECON_FIX_JPM_ADOPTION_ABORTED',
        'JPM persistent adoption 已中止'
      ));
      input.signal.addEventListener('abort', onAbort, { once: true });
      waiter.promise.then((value) => {
        input.signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, (error) => {
        input.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  async function settleCommitted(input) {
    const intent = readRepository.getCriticalIntentById(input.intentId);
    if (!intent || intent.state !== 'committed') {
      throw coordinatorError(
        'RECON_FIX_JPM_INTENT_STATE_INVALID',
        'JPM unit:done 只能收口 committed Intent'
      );
    }
    if (!input.result || input.result.resultKind !== 'committed' ||
        input.result.resultHandle !== intent.boundedEvidence.resultHandle) {
      throw coordinatorError(
        'RECON_FIX_JPM_RESULT_IDENTITY_CONFLICT',
        'JPM committed result 与 Intent resultHandle 不匹配'
      );
    }
    writeTransition({
      entityKind: 'critical-intent',
      command: 'close',
      intentId: intent.intentId,
      expectedState: 'committed',
      result: {
        outcome: 'completed',
        resultHandle: input.result.resultHandle,
        resultKind: input.result.resultKind
      }
    }, { state: 'closed', outcome: 'completed' });
    receiptWaiters.delete(input.jobId);
  }

  async function resolveUncertain(input) {
    const waiter = receiptWaiters.get(input.jobId);
    if (waiter && !waiter.settled) {
      waiter.settled = true;
      waiter.reject(coordinatorError(
        'RECON_FIX_JPM_ADOPTION_INTERRUPTED',
        'JPM transport 在 receipt adoption 收口前中断'
      ));
    }
    const intent = readRepository.getCriticalIntentById(input.intentId);
    if (!intent) throw coordinatorError('RECON_FIX_JPM_INTENT_MISSING', 'JPM inspection缺少Intent');
    const source = sourceForIntent(intent);
    const activeHold = readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey);
    const decision = await recoveryCoordinator.recoverSource(source, activeHold);
    receiptWaiters.delete(input.jobId);
    if (!decision || !decision.inspection) {
      return Object.freeze({ outcome: 'unknown', held: true });
    }
    return decision.inspection;
  }

  return Object.freeze({
    acceptNoop,
    awaitPersistentStateAdoption,
    observeReceipt,
    prepareAndAck,
    resolveUncertain,
    settleCommitted
  });
}

module.exports = {
  createReconFixJpmWorkerDurableCoordinator
};
