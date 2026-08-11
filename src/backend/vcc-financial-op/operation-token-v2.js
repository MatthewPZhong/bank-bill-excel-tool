'use strict';

const crypto = require('node:crypto');

const OPERATION_TOKEN_VERSION = 2;

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function validatedResultDigest(validation) {
  if (!validation || !Array.isArray(validation.violations) || validation.violations.length > 0) {
    return null;
  }
  const effectiveBalances = [...validation.effectiveBalances].sort((left, right) => (
    compareText(left.subject, right.subject) || compareText(left.currency, right.currency)
  ));
  const payload = {
    resultValidationVersion: validation.resultValidationVersion,
    runId: validation.runId,
    baseRowCount: validation.baseRowCount,
    adjustmentCount: validation.adjustmentCount,
    adjustmentSequenceMax: validation.adjustmentSequenceMax,
    sequenceContinuous: validation.sequenceContinuous,
    revisionMatchesAdjustmentCount: validation.revisionMatchesAdjustmentCount,
    adjustmentTargetsValid: validation.adjustmentTargetsValid,
    adjustmentMetadataValid: validation.adjustmentMetadataValid,
    baseBalanceFormulaValid: validation.baseBalanceFormulaValid,
    currenciesComplete: validation.currenciesComplete,
    effectiveBalances
  };
  return Object.freeze({
    resultEvidenceDigest: sha256(stableStringify(payload)),
    effectiveBalanceHash: sha256(stableStringify(effectiveBalances))
  });
}

function archiveStructuralEvidence(archiveEvidence, archiveContract) {
  const runId = Number(archiveContract.runId);
  const run = archiveEvidence.runs.find((item) => Number(item.id) === runId) || null;
  const validation = archiveEvidence.resultValidations
    .find((item) => Number(item.runId) === runId) || null;
  const digests = validatedResultDigest(validation);
  if (!run || !validation || !digests) return null;
  return {
    run,
    datasets: archiveEvidence.datasets,
    archives: archiveEvidence.archives.map((archive) => ({
      subject: archive.subject,
      runId: archive.runId,
      archivedAt: archive.archivedAt,
      balancesHash: archive.balancesHash
    })),
    resultValidationVersion: validation.resultValidationVersion,
    resultEvidenceDigest: digests.resultEvidenceDigest,
    effectiveBalanceHash: digests.effectiveBalanceHash,
    adjustmentCount: validation.adjustmentCount,
    adjustmentSequenceMax: validation.adjustmentSequenceMax,
    pendingEffectiveFactCount: archiveEvidence.pendingEffectiveFactCount,
    pendingChildCounts: {
      runRows: archiveEvidence.pendingRunRowCount,
      summaries: archiveEvidence.pendingSummaryCount,
      currencyTotals: archiveEvidence.pendingCurrencyTotalCount
    }
  };
}

function canonicalGateEvidence(gateEvidence) {
  return {
    taskGeneration: Number(gateEvidence.taskGeneration),
    activeBatchIds: [...gateEvidence.activeBatchIds].map(String).sort(),
    importingRecordIds: [...gateEvidence.importingRecordIds].map(Number).sort((a, b) => a - b),
    unresolvedRecords: [...gateEvidence.unresolvedRecords].sort((left, right) => (
      Number(left.id) - Number(right.id)
    )),
    laterDependencies: [...gateEvidence.laterDependencies].sort((left, right) => (
      compareText(left.targetMonth, right.targetMonth)
    ))
  };
}

function buildOperationTokenV2({
  action,
  targetMonth,
  scope = null,
  archiveEvidence,
  archiveContract,
  gateEvidence
}) {
  const structuralEvidence = archiveStructuralEvidence(archiveEvidence, archiveContract);
  if (!structuralEvidence) return null;
  const canonicalPayload = {
    tokenVersion: OPERATION_TOKEN_VERSION,
    action,
    targetMonth,
    scope,
    classifierVersion: archiveContract.classifierVersion,
    archiveContract,
    structuralEvidence,
    gateEvidence: canonicalGateEvidence(gateEvidence)
  };
  return Object.freeze({
    canonicalPayload,
    previewToken: `v${OPERATION_TOKEN_VERSION}:${sha256(stableStringify(canonicalPayload))}`
  });
}

function buildDeleteTargetTokenV2(deleteEvidence, targetType) {
  const canonicalPayload = {
    tokenVersion: OPERATION_TOKEN_VERSION,
    action: 'delete-data-target',
    targetMonth: deleteEvidence.targetMonth,
    scope: { targetType },
    deleteEvidence
  };
  return Object.freeze({
    canonicalPayload,
    previewToken: `v${OPERATION_TOKEN_VERSION}:${sha256(stableStringify(canonicalPayload))}`
  });
}

module.exports = {
  OPERATION_TOKEN_VERSION,
  canonicalJsonValue,
  stableStringify,
  sha256,
  validatedResultDigest,
  archiveStructuralEvidence,
  canonicalGateEvidence,
  buildOperationTokenV2,
  buildDeleteTargetTokenV2
};
