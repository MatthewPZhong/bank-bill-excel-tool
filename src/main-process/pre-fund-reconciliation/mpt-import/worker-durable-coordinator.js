'use strict';

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { transitionRequestKey } = require('../../background-execution/recovery-control-contract');
const { normalizeRecoverySource } = require('../../background-execution/recovery-source');
const {
  derivePreFundMptConflictScopeKey
} = require('./conflict-scope');

function coordinatorError(code, message) {
  return Object.assign(new Error(message), { code });
}

function exactCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'error,excluded,parsed,valid') return false;
  const counts = [value.parsed, value.valid, value.error, value.excluded];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    value.parsed === value.valid + value.error + value.excluded;
}

function createWorkerDurableCoordinator(options) {
  const required = [
    'readRepository', 'requestOwnerRepository', 'recoveryControlRepository', 'recoveryCoordinator'
  ];
  if (!options || required.some((key) => !options[key])) {
    throw new TypeError('WorkerDurableCoordinator依赖不完整');
  }
  const readRepository = options.readRepository;
  const requestOwnerRepository = options.requestOwnerRepository;
  const recoveryControlRepository = options.recoveryControlRepository;
  const recoveryCoordinator = options.recoveryCoordinator;
  const conflictScopeGate = typeof options.conflictScopeGate === 'function'
    ? options.conflictScopeGate
    : null;

  function writeTransition(transition, safePayload) {
    const reserved = requestOwnerRepository.reserveTransitionRequest({
      requestKey: transitionRequestKey(transition),
      transition,
      safePayload
    });
    return recoveryControlRepository.runInControlTransaction(
      (tx) => tx.transitionWithRecoveryEvent(reserved)
    );
  }

  function exactCritical(input) {
    const critical = input.critical;
    const repair = input.actionKey === 'pre-fund:mpt-repair-import';
    const fileIndex = Number(String(input.unitId || '').match(/^file:(\d{6})$/)?.[1]);
    if (!critical || typeof critical !== 'object' || !Number.isSafeInteger(fileIndex) ||
        critical.fileIndex !== fileIndex ||
        critical.fileOperationKey !== `${input.parentOperationKey}/file/${String(fileIndex).padStart(6, '0')}` ||
        typeof input.taskRunId !== 'string' || !input.taskRunId ||
        typeof critical.sourceType !== 'string' || !critical.sourceType ||
        typeof critical.sourceBatch !== 'string' || !critical.sourceBatch ||
        typeof critical.sourceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(critical.sourceDate) ||
        typeof critical.sourceFileSequence !== 'string' || !/^\d+$/.test(critical.sourceFileSequence) ||
        typeof critical.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(critical.monthKey) ||
        critical.sourceDate.slice(0, 7) !== critical.monthKey ||
        typeof critical.sourceFileName !== 'string' || !critical.sourceFileName ||
        !/^[a-f0-9]{64}$/.test(critical.sourceSha256 || '') ||
        !/^[a-f0-9]{64}$/.test(critical.contentHash || '') ||
        typeof critical.datasetId !== 'string' || !critical.datasetId ||
        !['pre-fund:mpt-import', 'pre-fund:mpt-repair-import'].includes(input.actionKey) ||
        (repair
          ? !/^[a-f0-9]{64}$/.test(critical.expectedContentHash || '')
          : critical.expectedContentHash !== '') ||
        !exactCounts(critical.counts) ||
        typeof input.parentOperationKey !== 'string' || !input.parentOperationKey ||
        !Number.isSafeInteger(input.batchId) || input.batchId < 1) {
      throw coordinatorError('PREFUND_CRITICAL_PAYLOAD_INVALID', 'PreFund critical payload identity非法');
    }
    const boundedEvidence = Object.freeze({
      fileIndex,
      sourceType: critical.sourceType,
      sourceBatch: critical.sourceBatch,
      sourceDate: critical.sourceDate,
      sourceFileSequence: critical.sourceFileSequence,
      monthKey: critical.monthKey,
      sourceFileName: critical.sourceFileName,
      sourceSha256: critical.sourceSha256,
      contentHash: critical.contentHash,
      datasetId: critical.datasetId,
      expectedContentHash: critical.expectedContentHash || '',
      counts: critical.counts,
      archiveBatchId: input.batchId,
      parentOperationKey: input.parentOperationKey
    });
    const conflictScopeKey = derivePreFundMptConflictScopeKey(critical);
    const intentId = `prefund-intent-${canonicalSha256([
      input.actionKey,
      critical.fileOperationKey,
      input.taskRunId
    ])}`;
    return Object.freeze({
      intentId,
      fileOperationKey: critical.fileOperationKey,
      conflictScopeKey,
      boundedEvidence,
      evidenceHash: canonicalSha256(boundedEvidence)
    });
  }

  function assertExistingExact(existing, input, prepared) {
    if (!existing || existing.intentId !== prepared.intentId ||
        existing.actionKey !== input.actionKey || existing.operationKey !== prepared.fileOperationKey ||
        existing.taskRunId !== input.taskRunId ||
        (existing.state !== 'closed' && existing.jobId !== input.jobId) ||
        existing.conflictScopeKey !== prepared.conflictScopeKey ||
        existing.inspectorKey !== input.policy.commit.inspectorKey ||
        existing.evidenceHash !== prepared.evidenceHash) {
      throw coordinatorError(
        'WORKER_DURABLE_INTENT_IDENTITY_CONFLICT',
        '同一fileOperationKey的Critical Intent identity冲突'
      );
    }
  }

  async function prepareAndAck(input) {
    const prepared = exactCritical(input);
    if (conflictScopeGate) {
      await conflictScopeGate({
        sourceType: input.critical.sourceType,
        sourceBatch: input.critical.sourceBatch,
        conflictScopeKey: prepared.conflictScopeKey
      });
    }
    let existing = readRepository.getCriticalIntentByOperation(
      input.actionKey,
      prepared.fileOperationKey,
      input.taskRunId
    );
    if (!existing) {
      writeTransition({
        entityKind: 'critical-intent',
        command: 'create-prepared',
        input: {
          contractVersion: 1,
          intentId: prepared.intentId,
          actionKey: input.actionKey,
          operationKey: prepared.fileOperationKey,
          taskRunId: input.taskRunId,
          jobId: input.jobId,
          coordinationKind: 'worker-critical',
          conflictScopeKey: prepared.conflictScopeKey,
          inspectorKey: input.policy.commit.inspectorKey,
          evidenceVersion: 1,
          evidenceHash: prepared.evidenceHash,
          boundedEvidence: prepared.boundedEvidence
        }
      }, { state: 'prepared', unitId: input.unitId });
      existing = readRepository.getCriticalIntentById(prepared.intentId);
    }
    assertExistingExact(existing, input, prepared);
    if (existing.state === 'prepared') {
      writeTransition({
        entityKind: 'critical-intent',
        command: 'mark-acked',
        intentId: existing.intentId,
        expectedState: 'prepared',
        patch: { admission: 'main-persisted-before-worker-ack' }
      }, { state: 'acked', unitId: input.unitId });
      existing = readRepository.getCriticalIntentById(existing.intentId);
    }
    if (!['acked', 'committed', 'closed'].includes(existing.state)) {
      throw coordinatorError('WORKER_DURABLE_INTENT_STATE_INVALID', 'Critical Intent不能进入ACK状态');
    }
    return Object.freeze({
      intentId: existing.intentId,
      fileOperationKey: prepared.fileOperationKey
    });
  }

  async function observeReceipt(input) {
    const receipt = input.receipt;
    if (!receipt || receipt.actionKey !== input.actionKey ||
        receipt.operationKey !== input.fileOperationKey ||
        receipt.producerTaskRunId !== input.taskRunId ||
        !Number.isSafeInteger(receipt.id) || receipt.id < 1) {
      throw coordinatorError('WORKER_DURABLE_RECEIPT_MISMATCH', 'commit receipt与当前Intent不匹配');
    }
    const intent = readRepository.getCriticalIntentById(input.intentId);
    if (!intent) throw coordinatorError('WORKER_DURABLE_INTENT_MISSING', 'commit receipt缺少Intent');
    if (intent.state === 'acked') {
      writeTransition({
        entityKind: 'critical-intent',
        command: 'mark-committed',
        intentId: intent.intentId,
        expectedState: 'acked',
        receiptRef: {
          receiptKind: 'module-local',
          receiptId: receipt.id,
          actionKey: receipt.actionKey,
          operationKey: receipt.operationKey,
          batchId: receipt.batchId,
          outcomeKind: receipt.outcomeKind
        }
      }, { state: 'committed', outcomeKind: receipt.outcomeKind });
    } else if (!['committed', 'closed'].includes(intent.state)) {
      throw coordinatorError('WORKER_DURABLE_INTENT_STATE_INVALID', 'receipt只能收口acked Intent');
    }
    return Object.freeze({
      receiptHint: {
        receiptKind: 'module-local',
        receiptIdentity: `${receipt.actionKey}:${receipt.operationKey}:${receipt.id}`
      }
    });
  }

  async function settleCommitted(input) {
    const intent = readRepository.getCriticalIntentById(input.intentId);
    if (!intent) throw coordinatorError('WORKER_DURABLE_INTENT_MISSING', 'unit done缺少Intent');
    if (intent.state === 'committed') {
      writeTransition({
        entityKind: 'critical-intent',
        command: 'close',
        intentId: intent.intentId,
        expectedState: 'committed',
        result: { outcome: 'completed', fileStatus: input.result.status }
      }, { state: 'closed', outcome: 'completed' });
    } else if (intent.state !== 'closed') {
      throw coordinatorError('WORKER_DURABLE_INTENT_STATE_INVALID', 'unit done只能收口committed Intent');
    }
  }

  async function resolveUncertain(input) {
    const intent = readRepository.getCriticalIntentById(input.intentId);
    if (!intent) throw coordinatorError('WORKER_DURABLE_INTENT_MISSING', 'inspection缺少Intent');
    const source = normalizeRecoverySource({
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
    const activeHold = readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey);
    const decision = await recoveryCoordinator.recoverSource(source, activeHold);
    if (!decision || !decision.inspection) {
      return Object.freeze({ outcome: 'unknown', held: true });
    }
    return decision.inspection;
  }

  return Object.freeze({
    observeReceipt,
    prepareAndAck,
    resolveUncertain,
    settleCommitted
  });
}

module.exports = {
  createWorkerDurableCoordinator
};
