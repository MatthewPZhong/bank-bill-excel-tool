'use strict';

const { canonicalSha256 } = require('./canonical-json-v1');
const { transitionRequestKey } = require('./recovery-control-contract');

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} 不能为空`);
  }
  return value;
}

function recoveryHoldIdFor(source) {
  const sourceKind = requireText(source && source.sourceKind, 'sourceKind');
  const sourceRef = requireText(source && source.sourceRef, 'sourceRef');
  return `hold:v1:${canonicalSha256([sourceKind, sourceRef])}`;
}

function recoveryHoldSafeSummary(source, reasonCode) {
  return Object.freeze({
    reasonCode: requireText(reasonCode, 'reasonCode'),
    sourceKind: requireText(source && source.sourceKind, 'sourceKind'),
    sourceRef: requireText(source && source.sourceRef, 'sourceRef')
  });
}

function createRecoveryHoldRequest(source, reasonCode) {
  const safeSummary = recoveryHoldSafeSummary(source, reasonCode);
  const holdId = recoveryHoldIdFor(source);
  const transition = Object.freeze({
    entityKind: 'recovery-hold',
    command: 'create-or-get',
    input: Object.freeze({
      contractVersion: 1,
      holdId,
      sourceKind: safeSummary.sourceKind,
      sourceRef: safeSummary.sourceRef,
      intentId: source.intentId ?? null,
      actionKey: requireText(source.actionKey, 'actionKey'),
      operationKey: requireText(source.operationKey, 'operationKey'),
      taskRunId: requireText(source.taskRunId, 'taskRunId'),
      conflictScopeKey: requireText(source.conflictScopeKey, 'conflictScopeKey'),
      reasonCode: safeSummary.reasonCode,
      safeSummary,
      evidenceHash: canonicalSha256(safeSummary)
    })
  });
  return Object.freeze({
    holdId,
    reasonCode: safeSummary.reasonCode,
    requestKey: transitionRequestKey(transition),
    transition,
    safePayload: Object.freeze({ reasonCode: safeSummary.reasonCode })
  });
}

function recoveryHoldReasonForInspection(inspection) {
  if (!inspection || typeof inspection !== 'object') {
    throw new TypeError('inspection 不能为空');
  }
  if (inspection.outcome === 'partially-committed') return 'PARTIALLY_COMMITTED';
  if (inspection.outcome !== 'unknown') {
    throw new TypeError('只有 unknown/partially-committed inspection 需要 Hold');
  }
  const evidence = inspection.boundedEvidence;
  if (evidence && evidence.matchesExpectedPost === true &&
      evidence.durabilityBarrierCompleted === false) {
    return 'DURABILITY_BARRIER_UNAVAILABLE';
  }
  return 'INSPECTION_UNKNOWN';
}

function inspectionObservationSafePayload(inspection, additions = {}) {
  if (!inspection || typeof inspection.outcome !== 'string' ||
      typeof inspection.evidenceHash !== 'string') {
    throw new TypeError('inspection observation 缺少 outcome/evidenceHash');
  }
  const payload = {
    outcome: inspection.outcome,
    evidenceHash: inspection.evidenceHash
  };
  const durabilityBarrierCompleted = Object.hasOwn(additions, 'durabilityBarrierCompleted')
    ? additions.durabilityBarrierCompleted
    : inspection.boundedEvidence && inspection.boundedEvidence.durabilityBarrierCompleted;
  if (typeof durabilityBarrierCompleted === 'boolean') {
    payload.durabilityBarrierCompleted = durabilityBarrierCompleted;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (key !== 'durabilityBarrierCompleted') payload[key] = value;
  }
  return Object.freeze(payload);
}

module.exports = {
  createRecoveryHoldRequest,
  inspectionObservationSafePayload,
  recoveryHoldIdFor,
  recoveryHoldReasonForInspection,
  recoveryHoldSafeSummary
};
