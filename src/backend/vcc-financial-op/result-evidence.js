'use strict';

const {
  addCanonicalDecimals,
  subtractCanonicalDecimals
} = require('../../main-process/financial-decimal');
const { canonicalizeVccAmount } = require('./amount-rules');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('./definitions');
const { DecimalAccumulator } = require('./decimal-accumulator');
const { buildRunRowKey } = require('./result-adjustments');

const RESULT_VALIDATION_VERSION = 1;
const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCIES);
const MOVEMENT_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL
]);

function coordinateKey(left, right) {
  return JSON.stringify([left, right]);
}

function canonicalStoredAmount(value, label) {
  const raw = String(value == null ? '' : value);
  const canonical = canonicalizeVccAmount(raw, label);
  if (raw !== canonical) throw new Error(`${label}不是规范十进制字符串`);
  return canonical;
}

function addToAmountMap(map, key, amount) {
  let accumulator = map.get(key);
  if (!accumulator) {
    accumulator = new DecimalAccumulator();
    map.set(key, accumulator);
  }
  accumulator.add(amount);
}

function finalizedAmountMap(accumulators, { violations, violationCode, label }) {
  const totals = new Map();
  for (const [key, accumulator] of accumulators) {
    try {
      totals.set(key, canonicalizeVccAmount(accumulator.value(), label));
    } catch (_error) {
      pushViolation(violations, violationCode);
    }
  }
  return totals;
}

function pushViolation(violations, code) {
  if (!violations.includes(code)) violations.push(code);
}

function validateEffectiveResultEvidence({
  run,
  runRows,
  runAdjustments,
  storedRunBalances
}) {
  const runId = Number(run.id);
  const violations = [];
  const logicalRows = new Map();
  const rowCoordinates = new Set();
  const basePeriodAccumulators = new Map();
  let adjustmentTargetsValid = true;
  let adjustmentMetadataValid = true;
  let baseBalanceFormulaValid = true;
  let currenciesComplete = true;

  if (runRows.length === 0) pushViolation(violations, 'run-base-rows-empty');
  for (const row of runRows) {
    if (Number(row.runId) !== runId) {
      pushViolation(violations, 'run-row-run-id-mismatch');
      continue;
    }
    const metadata = {
      rowKind: String(row.rowKind ?? ''),
      subject: String(row.subject ?? ''),
      sourceType: String(row.sourceType ?? ''),
      categoryMajor: String(row.categoryMajor ?? ''),
      categoryMinor: String(row.categoryMinor ?? '')
    };
    const validKind = metadata.rowKind === 'movement' || metadata.rowKind === 'pending';
    if (!validKind || !metadata.subject || !metadata.sourceType) {
      pushViolation(violations, 'invalid-run-row-metadata');
      continue;
    }
    const validSource = metadata.rowKind === 'movement'
      ? MOVEMENT_SOURCE_TYPES.has(metadata.sourceType)
      : metadata.sourceType === SOURCE_TYPES.PENDING;
    if (!validSource) {
      pushViolation(violations, 'invalid-run-row-source-type');
      continue;
    }
    const derivedRowKey = buildRunRowKey(metadata);
    if (String(row.rowKey) !== derivedRowKey) {
      pushViolation(violations, 'invalid-run-row-metadata');
      continue;
    }
    const currency = String(row.currency);
    if (!SUPPORTED_CURRENCY_SET.has(currency)) {
      pushViolation(violations, 'invalid-run-row-currency');
      continue;
    }
    const rowCoordinate = coordinateKey(derivedRowKey, currency);
    if (rowCoordinates.has(rowCoordinate)) {
      pushViolation(violations, 'run-row-key-collision');
      continue;
    }
    let amount;
    try {
      amount = canonicalStoredAmount(row.amount, `run ${runId} 结果行 ${row.id} 金额`);
    } catch (_error) {
      pushViolation(violations, 'invalid-run-row-amount');
      continue;
    }
    rowCoordinates.add(rowCoordinate);
    if (!logicalRows.has(derivedRowKey)) {
      logicalRows.set(derivedRowKey, Object.freeze({
        rowKey: derivedRowKey,
        ...metadata
      }));
    }
    addToAmountMap(
      basePeriodAccumulators,
      coordinateKey(metadata.subject, currency),
      amount
    );
  }
  const basePeriodTotals = finalizedAmountMap(basePeriodAccumulators, {
    violations,
    violationCode: 'invalid-run-row-amount',
    label: `run ${runId} 基础发生额汇总`
  });

  const orderedAdjustments = [...runAdjustments].sort((left, right) => (
    Number(left.sequence) - Number(right.sequence) || Number(left.id) - Number(right.id)
  ));
  const adjustmentCoordinates = new Set();
  const adjustmentAccumulators = new Map();
  const rawSequences = orderedAdjustments.map((adjustment) => Number(adjustment.sequence));
  const adjustmentSequenceMax = rawSequences.length === 0 ? 0 : Math.max(...rawSequences);
  const sequenceContinuous = rawSequences.every((sequence, index) => (
    Number.isSafeInteger(sequence) && sequence === index + 1
  ));
  if (!sequenceContinuous) pushViolation(violations, 'adjustment-sequence-inconsistent');
  for (const adjustment of orderedAdjustments) {
    if (Number(adjustment.runId) !== runId) {
      adjustmentTargetsValid = false;
      pushViolation(violations, 'adjustment-run-id-mismatch');
      continue;
    }
    const rowKey = String(adjustment.rowKey);
    const target = logicalRows.get(rowKey);
    if (!target) {
      adjustmentTargetsValid = false;
      pushViolation(violations, 'invalid-adjustment-target');
      continue;
    }
    const actualMetadata = [
      String(adjustment.subject),
      String(adjustment.sourceType),
      String(adjustment.categoryMajor),
      String(adjustment.categoryMinor)
    ];
    const expectedMetadata = [
      target.subject,
      target.sourceType,
      target.categoryMajor,
      target.categoryMinor
    ];
    if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
      adjustmentMetadataValid = false;
      pushViolation(violations, 'invalid-adjustment-metadata');
      continue;
    }
    const currency = String(adjustment.currency);
    if (!SUPPORTED_CURRENCY_SET.has(currency)) {
      adjustmentMetadataValid = false;
      pushViolation(violations, 'invalid-adjustment-currency');
      continue;
    }
    const adjustmentCoordinate = coordinateKey(rowKey, currency);
    if (adjustmentCoordinates.has(adjustmentCoordinate)) {
      pushViolation(violations, 'adjustment-coordinate-duplicate');
      continue;
    }
    let amount;
    try {
      amount = canonicalStoredAmount(
        adjustment.adjustmentAmount,
        `run ${runId} 调整 ${adjustment.id} 金额`
      );
      if (amount === '0') throw new Error('调整金额不能为 0');
    } catch (_error) {
      pushViolation(violations, 'invalid-adjustment-amount');
      continue;
    }
    const reason = String(adjustment.reason);
    if (!reason || reason !== reason.trim() || Array.from(reason).length > 500) {
      pushViolation(violations, 'invalid-adjustment-reason');
      continue;
    }
    const sequence = Number(adjustment.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      pushViolation(violations, 'invalid-adjustment-sequence');
      continue;
    }
    adjustmentCoordinates.add(adjustmentCoordinate);
    addToAmountMap(
      adjustmentAccumulators,
      coordinateKey(target.subject, currency),
      amount
    );
  }
  const adjustmentTotals = finalizedAmountMap(adjustmentAccumulators, {
    violations,
    violationCode: 'invalid-adjustment-amount',
    label: `run ${runId} 调整金额汇总`
  });
  const resultRevision = Number(run.resultRevision);
  const revisionMatchesAdjustmentCount = Number.isSafeInteger(resultRevision)
    && resultRevision >= 0
    && resultRevision === orderedAdjustments.length;
  if (!revisionMatchesAdjustmentCount) {
    pushViolation(violations, 'result-revision-inconsistent');
  }

  const balanceCoordinates = new Set();
  const subjectCurrencies = new Map();
  const effectiveBalances = [];
  if (storedRunBalances.length === 0) {
    baseBalanceFormulaValid = false;
    currenciesComplete = false;
    pushViolation(violations, 'run-balances-empty');
  }
  for (const balance of storedRunBalances) {
    if (Number(balance.runId) !== runId) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'run-balance-run-id-mismatch');
      continue;
    }
    const subject = String(balance.subject);
    const currency = String(balance.currency);
    if (!subject || !SUPPORTED_CURRENCY_SET.has(currency)) {
      currenciesComplete = false;
      pushViolation(violations, 'invalid-run-balance-coordinate');
      continue;
    }
    const balanceCoordinate = coordinateKey(subject, currency);
    if (balanceCoordinates.has(balanceCoordinate)) {
      currenciesComplete = false;
      pushViolation(violations, 'run-balance-coordinate-duplicate');
      continue;
    }
    let openingBalance;
    let basePeriodAmount;
    let baseCalculatedBalance;
    let systemBalance;
    let baseDifference;
    try {
      openingBalance = canonicalStoredAmount(balance.openingBalance, `${subject} ${currency} 期初余额`);
      basePeriodAmount = canonicalStoredAmount(balance.periodAmount, `${subject} ${currency} 基础发生额`);
      baseCalculatedBalance = canonicalStoredAmount(
        balance.calculatedBalance,
        `${subject} ${currency} 基础计算余额`
      );
      systemBalance = canonicalStoredAmount(balance.systemBalance, `${subject} ${currency} 系统余额`);
      baseDifference = canonicalStoredAmount(balance.difference, `${subject} ${currency} 基础差异`);
    } catch (_error) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'invalid-run-balance-amount');
      continue;
    }
    const recomputedPeriod = basePeriodTotals.get(balanceCoordinate) || '0';
    if (recomputedPeriod !== basePeriodAmount) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'run-base-period-mismatch');
    }
    let recomputedCalculated;
    let recomputedDifference;
    let adjustmentAmount;
    let effectivePeriodAmount;
    let effectiveCalculatedBalance;
    let effectiveDifference;
    try {
      recomputedCalculated = canonicalizeVccAmount(
        addCanonicalDecimals(openingBalance, basePeriodAmount, {
          label: `${subject} ${currency} 基础计算余额复核`
        }),
        `${subject} ${currency} 基础计算余额复核`
      );
      recomputedDifference = canonicalizeVccAmount(
        subtractCanonicalDecimals(systemBalance, baseCalculatedBalance, {
          label: `${subject} ${currency} 基础差异复核`
        }),
        `${subject} ${currency} 基础差异复核`
      );
      adjustmentAmount = adjustmentTotals.get(balanceCoordinate) || '0';
      effectivePeriodAmount = canonicalizeVccAmount(
        addCanonicalDecimals(basePeriodAmount, adjustmentAmount, {
          label: `${subject} ${currency} 生效发生额`
        }),
        `${subject} ${currency} 生效发生额`
      );
      effectiveCalculatedBalance = canonicalizeVccAmount(
        addCanonicalDecimals(openingBalance, effectivePeriodAmount, {
          label: `${subject} ${currency} 生效计算余额`
        }),
        `${subject} ${currency} 生效计算余额`
      );
      effectiveDifference = canonicalizeVccAmount(
        subtractCanonicalDecimals(systemBalance, effectiveCalculatedBalance, {
          label: `${subject} ${currency} 生效差异`
        }),
        `${subject} ${currency} 生效差异`
      );
    } catch (_error) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'result-amount-out-of-range');
      continue;
    }
    if (recomputedCalculated !== baseCalculatedBalance || recomputedDifference !== baseDifference) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'run-base-balance-mismatch');
    }
    balanceCoordinates.add(balanceCoordinate);
    if (!subjectCurrencies.has(subject)) subjectCurrencies.set(subject, new Set());
    subjectCurrencies.get(subject).add(currency);
    effectiveBalances.push(Object.freeze({
      runId,
      subject,
      currency,
      openingBalance,
      basePeriodAmount,
      baseCalculatedBalance,
      baseDifference,
      systemBalance,
      adjustmentAmount,
      effectivePeriodAmount,
      effectiveCalculatedBalance,
      effectiveDifference
    }));
  }
  for (const key of basePeriodTotals.keys()) {
    if (!balanceCoordinates.has(key)) {
      baseBalanceFormulaValid = false;
      pushViolation(violations, 'run-base-balance-coordinate-missing');
    }
  }
  for (const [subject, currencies] of subjectCurrencies) {
    if (
      currencies.size !== SUPPORTED_CURRENCIES.length
      || SUPPORTED_CURRENCIES.some((currency) => !currencies.has(currency))
    ) {
      currenciesComplete = false;
      pushViolation(violations, 'run-balance-currencies-incomplete');
      break;
    }
  }
  for (const key of adjustmentTotals.keys()) {
    if (!balanceCoordinates.has(key)) {
      adjustmentTargetsValid = false;
      pushViolation(violations, 'invalid-adjustment-coordinate');
    }
  }

  effectiveBalances.sort((left, right) => (
    left.subject.localeCompare(right.subject) || left.currency.localeCompare(right.currency)
  ));
  return Object.freeze({
    resultValidationVersion: RESULT_VALIDATION_VERSION,
    runId,
    baseRowCount: runRows.length,
    adjustmentCount: runAdjustments.length,
    adjustmentSequenceMax,
    sequenceContinuous,
    revisionMatchesAdjustmentCount,
    adjustmentTargetsValid,
    adjustmentMetadataValid,
    baseBalanceFormulaValid,
    currenciesComplete,
    effectiveBalances: Object.freeze(effectiveBalances),
    violations: Object.freeze(violations)
  });
}

module.exports = {
  RESULT_VALIDATION_VERSION,
  validateEffectiveResultEvidence
};
