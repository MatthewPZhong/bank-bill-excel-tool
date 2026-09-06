'use strict';

const { ACTIONS, snapshot } = require('./contracts');
const candidate = require('./candidate-policy.json');
const exported = require('./export-policy.json');

const BIZ_OP_V327_POLICIES = Object.freeze(Object.entries(ACTIONS).map(([actionKey, action]) => {
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
  return snapshot(policy);
}));

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
function rejectUnimplementedExport() { return false; }

module.exports = { BIZ_OP_V327_POLICIES, validateBizOpCandidateResult, rejectUnimplementedExport };
