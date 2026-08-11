'use strict';

const { canonicalizeVccAmount } = require('./amount-rules');
const { isValidInputFingerprint } = require('./calculator');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('./definitions');

const ARCHIVE_CLASSIFIER_VERSION = 1;
const ARCHIVE_CONTRACTS = Object.freeze({
  CURRENT: 'current-five-dataset',
  LEGACY: 'legacy-v3.1.7-four-dataset',
  INCONSISTENT: 'inconsistent'
});
const CURRENT_DATASET_TYPES = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING,
  SOURCE_TYPES.SYSTEM_OP
].sort());
const LEGACY_DATASET_TYPES = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.SYSTEM_OP
].sort());

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function validRevisionObject(inputRevisions, datasets) {
  if (!inputRevisions || typeof inputRevisions !== 'object' || Array.isArray(inputRevisions)) {
    return false;
  }
  const revisionKeys = Object.keys(inputRevisions).sort();
  const datasetTypes = datasets.map((dataset) => dataset.datasetType).sort();
  if (!sameArray(revisionKeys, datasetTypes)) return false;
  return datasets.every((dataset) => (
    Number.isSafeInteger(inputRevisions[dataset.datasetType])
    && inputRevisions[dataset.datasetType] === Number(dataset.revision)
  ));
}

function inconsistentResult({ reasons, run, archives, datasets }) {
  return Object.freeze({
    classifierVersion: ARCHIVE_CLASSIFIER_VERSION,
    contract: ARCHIVE_CONTRACTS.INCONSISTENT,
    structuralReasons: Object.freeze(reasons),
    runId: run ? Number(run.id) : null,
    archivedAt: run ? run.archivedAt : null,
    resultRevision: run ? Number(run.resultRevision) : null,
    subjects: Object.freeze(uniqueSorted(archives.map((archive) => String(archive.subject)))),
    datasetTypes: Object.freeze(datasets.map((dataset) => String(dataset.datasetType)).sort())
  });
}

function classifyArchiveContract(evidence) {
  const reasons = [];
  const archivedRuns = evidence.runs.filter((run) => run.status === 'archived');
  const calculatedRuns = evidence.runs.filter((run) => run.status === 'calculated');
  if (archivedRuns.length !== 1) addReason(reasons, `archived-run-count:${archivedRuns.length}`);
  if (calculatedRuns.length !== 0) addReason(reasons, `calculated-run-count:${calculatedRuns.length}`);
  const run = archivedRuns.length === 1 ? archivedRuns[0] : null;

  if (evidence.archives.length === 0) addReason(reasons, 'archives-empty');
  const archiveSubjects = evidence.archives.map((archive) => String(archive.subject));
  if (uniqueSorted(archiveSubjects).length !== archiveSubjects.length) {
    addReason(reasons, 'archive-subject-duplicate');
  }
  if (run && evidence.archives.some((archive) => Number(archive.runId) !== Number(run.id))) {
    addReason(reasons, 'archive-run-mismatch');
  }

  const validations = run
    ? evidence.resultValidations.filter((validation) => Number(validation.runId) === Number(run.id))
    : [];
  if (validations.length !== 1) addReason(reasons, `result-validation-count:${validations.length}`);
  const validation = validations.length === 1 ? validations[0] : null;
  if (run && [evidence.runRows, evidence.runAdjustments, evidence.storedRunBalances]
    .some((rows) => rows.some((row) => Number(row.runId) !== Number(run.id)))) {
    addReason(reasons, 'result-evidence-run-mismatch');
  }
  if (validation && validation.violations.length > 0) {
    addReason(reasons, 'effective-run-result-invalid');
  }

  const effectiveCoordinates = new Set();
  const effectiveSubjects = new Map();
  const effectiveBalances = new Map();
  for (const balance of validation ? validation.effectiveBalances : []) {
    const subject = String(balance.subject);
    const currency = String(balance.currency);
    const key = JSON.stringify([subject, currency]);
    if (effectiveCoordinates.has(key)) addReason(reasons, 'effective-balance-coordinate-duplicate');
    effectiveCoordinates.add(key);
    if (!effectiveSubjects.has(subject)) effectiveSubjects.set(subject, new Set());
    effectiveSubjects.get(subject).add(currency);
    try {
      effectiveBalances.set(
        key,
        canonicalizeVccAmount(balance.effectiveCalculatedBalance, `${subject} ${currency} 生效归档余额`)
      );
    } catch (_error) {
      addReason(reasons, `effective-balance-invalid:${subject}/${currency}`);
    }
  }
  for (const [subject, currencies] of effectiveSubjects) {
    if (
      currencies.size !== SUPPORTED_CURRENCIES.length
      || SUPPORTED_CURRENCIES.some((currency) => !currencies.has(currency))
    ) {
      addReason(reasons, `effective-balance-currencies:${subject}`);
    }
  }
  if (!sameArray(uniqueSorted(archiveSubjects), [...effectiveSubjects.keys()].sort())) {
    addReason(reasons, 'archive-run-subjects-mismatch');
  }
  for (const archive of evidence.archives) {
    const subject = String(archive.subject);
    const balances = archive.balances;
    const currencyKeys = balances && typeof balances === 'object' && !Array.isArray(balances)
      ? Object.keys(balances).sort()
      : [];
    if (
      archive.balancesParseError
      || !sameArray(currencyKeys, [...SUPPORTED_CURRENCIES].sort())
    ) {
      addReason(reasons, `archive-balance-currencies:${subject}`);
      continue;
    }
    for (const currency of SUPPORTED_CURRENCIES) {
      let archivedAmount;
      try {
        archivedAmount = canonicalizeVccAmount(
          balances[currency],
          `${subject} ${currency} 归档余额`
        );
      } catch (_error) {
        addReason(reasons, `archive-balance-invalid:${subject}/${currency}`);
        continue;
      }
      if (archivedAmount !== effectiveBalances.get(JSON.stringify([subject, currency]))) {
        addReason(reasons, `archive-balance-mismatch:${subject}/${currency}`);
      }
    }
  }

  if (reasons.length > 0) {
    return inconsistentResult({ reasons, run, archives: evidence.archives, datasets: evidence.datasets });
  }

  const datasetTypes = evidence.datasets.map((dataset) => String(dataset.datasetType)).sort();
  const datasetTypesUnique = uniqueSorted(datasetTypes);
  let contract = null;
  if (sameArray(datasetTypes, datasetTypesUnique) && sameArray(datasetTypes, CURRENT_DATASET_TYPES)) {
    contract = ARCHIVE_CONTRACTS.CURRENT;
  } else if (sameArray(datasetTypes, datasetTypesUnique) && sameArray(datasetTypes, LEGACY_DATASET_TYPES)) {
    contract = ARCHIVE_CONTRACTS.LEGACY;
  } else {
    addReason(reasons, `dataset-types:${datasetTypes.join(',')}`);
  }

  if (run && evidence.datasets.some((dataset) => (
    dataset.dataStatus !== 'archived' || Number(dataset.archivedRunId) !== Number(run.id)
  ))) {
    addReason(reasons, 'dataset-archive-state-mismatch');
  }
  if (run && (run.inputRevisionsParseError || !validRevisionObject(run.inputRevisions, evidence.datasets))) {
    addReason(reasons, 'input-revisions-mismatch');
  }

  if (contract === ARCHIVE_CONTRACTS.CURRENT) {
    if (!isValidInputFingerprint(run.inputFingerprint)) {
      addReason(reasons, 'input-fingerprint-invalid');
    }
    if (
      Number(run.resultRevision) !== validation.adjustmentCount
      || !validation.revisionMatchesAdjustmentCount
      || !validation.sequenceContinuous
      || validation.adjustmentSequenceMax !== validation.adjustmentCount
      || !validation.adjustmentTargetsValid
      || !validation.adjustmentMetadataValid
      || !validation.baseBalanceFormulaValid
      || !validation.currenciesComplete
    ) {
      addReason(reasons, 'current-result-contract-invalid');
    }
  } else if (contract === ARCHIVE_CONTRACTS.LEGACY) {
    if (run.inputFingerprint !== null) addReason(reasons, 'legacy-input-fingerprint-not-null');
    if (Number(run.resultRevision) !== 0) addReason(reasons, 'legacy-result-revision-not-zero');
    if (validation.adjustmentCount !== 0 || validation.adjustmentSequenceMax !== 0) {
      addReason(reasons, 'legacy-adjustments-present');
    }
    if (
      evidence.pendingEffectiveFactCount !== 0
      || evidence.pendingRunRowCount !== 0
      || evidence.pendingSummaryCount !== 0
      || evidence.pendingCurrencyTotalCount !== 0
    ) {
      addReason(reasons, 'legacy-pending-evidence-present');
    }
  }

  if (reasons.length > 0 || !contract) {
    return inconsistentResult({ reasons, run, archives: evidence.archives, datasets: evidence.datasets });
  }
  return Object.freeze({
    classifierVersion: ARCHIVE_CLASSIFIER_VERSION,
    contract,
    structuralReasons: Object.freeze([]),
    runId: Number(run.id),
    archivedAt: run.archivedAt,
    resultRevision: Number(run.resultRevision),
    subjects: Object.freeze(uniqueSorted(archiveSubjects)),
    datasetTypes: Object.freeze(datasetTypes)
  });
}

module.exports = {
  ARCHIVE_CLASSIFIER_VERSION,
  ARCHIVE_CONTRACTS,
  CURRENT_DATASET_TYPES,
  LEGACY_DATASET_TYPES,
  classifyArchiveContract
};
