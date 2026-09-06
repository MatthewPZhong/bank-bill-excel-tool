'use strict';

const { ACTIONS, snapshot } = require('./contracts');
const candidate = require('./candidate-policy.json');
const exported = require('./export-policy.json');
const { RELEASE_GATES, evaluateReleaseGates } = require('./release-gates');

function buildBizOpPolicies(gates = RELEASE_GATES) {
const decision = evaluateReleaseGates(gates);
return Object.freeze(Object.entries(ACTIONS).map(([actionKey, action]) => {
  const policy = structuredClone(action.kind === 'EXPORT' ? exported : candidate);
  policy.actionKey = actionKey;
  policy.entryKey = `executor.${actionKey}`;
  policy.resources.profile = `resource.${actionKey}`;
  policy.result.validatorKey = `result-validator.${actionKey}`;
  policy.featureFlag = `feature.${actionKey}`;
  if (action.kind === 'EXPORT') {
    policy.artifacts.technicalValidatorKey = `technical-validator.${actionKey}`;
    policy.artifacts.businessValidatorKey = `business-validator.${actionKey}`;
    policy.artifacts.publisherKey = `publisher.${actionKey}`;
  }
  if (decision.ready) policy.production = { enabled: true, effectiveMode: 'thread-single', effectiveWorkerCount: 1,
    recoveryStatus: 'proven', evidenceStatus: 'release-pass', downgradeReason: null, benchmarkEvidenceId: gates.actions[actionKey].reference };
  return snapshot(policy);
}));
}
const BIZ_OP_V327_POLICIES = buildBizOpPolicies();

function validateBizOpCandidateResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'candidateRef,contractVersion,planDigest,rowCount,sha256'
      || value.contractVersion !== 1 || !/^candidate-[a-f0-9-]{36}$/.test(value.candidateRef)
      || !/^[a-f0-9]{64}$/.test(value.planDigest) || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 65536;
}
Object.defineProperty(validateBizOpCandidateResult, 'allowFinanceSafeValue', {
  value({ value, key }) {
    return ['planDigest', 'sha256'].includes(key) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
      || key === 'candidateRef' && typeof value === 'string' && /^candidate-[a-f0-9-]{36}$/.test(value);
  }
});
// 导出只返回候选证据引用；实际有界证据仍由 Main 按原 plan 和 FilePlan 核对。
const validateBizOpExportResult = validateBizOpCandidateResult;

module.exports = { buildBizOpPolicies, BIZ_OP_V327_POLICIES, validateBizOpCandidateResult, validateBizOpExportResult };
