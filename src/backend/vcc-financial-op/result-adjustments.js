'use strict';

const crypto = require('node:crypto');
const {
  subtractCanonicalDecimals
} = require('../../main-process/financial-decimal');
const { canonicalizeVccAmount } = require('./amount-rules');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES
} = require('./definitions');
const {
  DecimalAccumulator,
  addToAccumulatorMap
} = require('./decimal-accumulator');

const RUN_ROW_KEY_VERSION = 'v1';
const ADJUSTABLE_ROW_KINDS = new Set(['movement', 'pending']);
const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCIES);
const MOVEMENT_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL
]);
const RESULT_REVISION_CHANGED_CODE = 'result-revision-changed';
const RESULT_REVISION_CHANGED_MESSAGE = '结果已发生变化，请重新核对后归档。';

function resultStateError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedRunRowMetadata(row) {
  return {
    rowKind: String(row.rowKind ?? row.row_kind ?? ''),
    subject: String(row.subject ?? ''),
    sourceType: String(row.sourceType ?? row.source_type ?? ''),
    categoryMajor: String(row.categoryMajor ?? row.category_major ?? ''),
    categoryMinor: String(row.categoryMinor ?? row.category_minor ?? '')
  };
}

function buildRunRowKey(row) {
  const metadata = normalizedRunRowMetadata(row);
  if (!metadata.rowKind || !metadata.subject || !metadata.sourceType) {
    throw resultStateError(
      'invalid-run-row-metadata',
      '结果行缺少 row_kind、subject 或 source_type，无法生成稳定 rowKey',
      { metadata }
    );
  }
  const payload = [
    metadata.rowKind,
    metadata.subject,
    metadata.sourceType,
    metadata.categoryMajor,
    metadata.categoryMinor
  ];
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  return `${RUN_ROW_KEY_VERSION}:${digest}`;
}

function coordinateKey(rowKey, currency) {
  return JSON.stringify([rowKey, currency]);
}

function subjectCurrencyKey(subject, currency) {
  return JSON.stringify([subject, currency]);
}

function resultRevisionChanged(details = {}) {
  return resultStateError(
    RESULT_REVISION_CHANGED_CODE,
    RESULT_REVISION_CHANGED_MESSAGE,
    details
  );
}

function normalizeExpectedResultRevision(value) {
  if (value === null || value === undefined || value === '') {
    throw resultRevisionChanged({ expectedResultRevision: null });
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== String(value).trim()) {
    throw resultRevisionChanged({ expectedResultRevision: value });
  }
  return revision;
}

function assertExpectedResultRevision(value, actualRevision, details = {}) {
  const expectedRevision = normalizeExpectedResultRevision(value);
  if (expectedRevision !== actualRevision) {
    throw resultRevisionChanged({
      ...details,
      expectedResultRevision: expectedRevision,
      actualResultRevision: actualRevision
    });
  }
  return expectedRevision;
}

function normalizeAdjustmentAmount(value) {
  let token = value;
  if (typeof value === 'string') {
    token = value.trim();
    const accounting = token.match(/^\(([^()]*)\)$/);
    if (accounting) {
      const unsigned = accounting[1].trim();
      if (!unsigned || /^[+-]/.test(unsigned)) {
        throw resultStateError(
          'invalid-adjustment-amount',
          `调整值不是有效会计负数：${value}`,
          { value }
        );
      }
      token = `-${unsigned}`;
    }
  }
  let canonical;
  try {
    canonical = canonicalizeVccAmount(token, '调整值');
  } catch (error) {
    throw resultStateError('invalid-adjustment-amount', error.message, {
      cause: error,
      value
    });
  }
  if (canonical === '0') {
    throw resultStateError('invalid-adjustment-amount', '调整值不能为 0', { value });
  }
  return canonical;
}

function normalizeAdjustmentReason(value) {
  const reason = String(value == null ? '' : value).trim();
  const length = Array.from(reason).length;
  if (length < 1 || length > 500) {
    throw resultStateError(
      'invalid-adjustment-reason',
      '调整原因必须为 1～500 个字符',
      { reasonLength: length }
    );
  }
  return reason;
}

function canonicalStoredAmount(value, label, code) {
  const raw = String(value == null ? '' : value);
  let canonical;
  try {
    canonical = canonicalizeVccAmount(raw, label);
  } catch (error) {
    throw resultStateError(code, error.message, { cause: error, value: raw });
  }
  if (raw !== canonical) {
    throw resultStateError(code, `${label}不是规范十进制字符串：${raw}`, {
      value: raw,
      canonical
    });
  }
  return canonical;
}

function canonicalFinalAmount(value, { label, field, ...context }) {
  const raw = String(value == null ? '' : value);
  try {
    return canonicalizeVccAmount(raw, label);
  } catch (error) {
    const errorContext = {
      ...context,
      field,
      value: raw,
      reason: error.message
    };
    throw resultStateError('result-amount-out-of-range', error.message, {
      ...errorContext,
      context: errorContext
    });
  }
}

function accumulateAmounts(...amounts) {
  const accumulator = new DecimalAccumulator();
  for (const amount of amounts) accumulator.add(amount);
  return accumulator.value();
}

function addAmount(map, key, amount) {
  addToAccumulatorMap(map, key, amount);
}

function finalizeSummaryAmounts(accumulators, {
  runId,
  field,
  summaryType,
  labelFor
}) {
  const totals = new Map();
  for (const [key, accumulator] of accumulators) {
    const [subject, currency] = JSON.parse(key);
    const value = accumulator.value();
    totals.set(key, canonicalFinalAmount(value, {
      label: labelFor(subject, currency),
      runId,
      scope: 'summary',
      summaryType,
      field,
      subject,
      currency
    }));
  }
  return totals;
}

function validateBaseRows(db, runId) {
  const rawRows = db.prepare(`
    SELECT id, subject, row_kind, source_type, category_major, category_minor,
           currency, amount
    FROM vcc_fin_op_run_rows
    WHERE run_id = ?
    ORDER BY id
  `).all(runId);
  if (rawRows.length === 0) {
    throw resultStateError(
      'run-base-rows-empty',
      `run ${runId} 没有基础结果行，不能读取生效结果`,
      { runId }
    );
  }
  const coordinates = new Map();
  const logicalRows = new Map();
  const periodAccumulators = new Map();
  const baseRows = rawRows.map((row) => {
    const metadata = normalizedRunRowMetadata(row);
    if (!ADJUSTABLE_ROW_KINDS.has(metadata.rowKind)) {
      throw resultStateError(
        'invalid-run-row-metadata',
        `结果行 ${row.id} 的 row_kind 无效：${metadata.rowKind}`,
        { rowId: Number(row.id), metadata }
      );
    }
    const validSourceType = metadata.rowKind === 'movement'
      ? MOVEMENT_SOURCE_TYPES.has(metadata.sourceType)
      : metadata.sourceType === SOURCE_TYPES.PENDING;
    if (!validSourceType) {
      throw resultStateError(
        'invalid-run-row-source-type',
        `结果行 ${row.id} 的 row_kind 与 source_type 不匹配：${metadata.rowKind} / ${metadata.sourceType}`,
        { rowId: Number(row.id), metadata }
      );
    }
    const currency = String(row.currency == null ? '' : row.currency);
    if (!SUPPORTED_CURRENCY_SET.has(currency)) {
      throw resultStateError(
        'invalid-run-row-currency',
        `结果行 ${row.id} 包含不支持币种：${currency}`,
        { rowId: Number(row.id), currency }
      );
    }
    const rowKey = buildRunRowKey(metadata);
    const coord = coordinateKey(rowKey, currency);
    if (coordinates.has(coord)) {
      throw resultStateError(
        'run-row-key-collision',
        `run ${runId} 存在重复 rowKey + currency 坐标：${rowKey} / ${currency}`,
        { runId, rowKey, currency, rowIds: [coordinates.get(coord).id, Number(row.id)] }
      );
    }
    const amount = canonicalStoredAmount(
      row.amount,
      `run ${runId} 结果行 ${row.id} 金额`,
      'invalid-run-row-amount'
    );
    const normalized = Object.freeze({
      id: Number(row.id),
      rowKey,
      ...metadata,
      currency,
      amount
    });
    coordinates.set(coord, normalized);
    if (!logicalRows.has(rowKey)) logicalRows.set(rowKey, normalized);
    addAmount(
      periodAccumulators,
      subjectCurrencyKey(metadata.subject, currency),
      amount
    );
    return normalized;
  });
  const periodTotals = finalizeSummaryAmounts(periodAccumulators, {
    runId,
    field: 'basePeriodAmount',
    summaryType: 'base-period',
    labelFor: (subject, currency) => `${subject} ${currency} 基础发生额汇总`
  });
  return { baseRows, coordinates, logicalRows, periodTotals };
}

function validateAdjustments(db, runId, logicalRows) {
  const rows = db.prepare(`
    SELECT id, run_id, row_key, subject, source_type, category_major, category_minor,
           currency, adjustment_amount, reason, sequence, created_at,
           created_app_version, created_build_sha
    FROM vcc_fin_op_run_adjustments
    WHERE run_id = ?
    ORDER BY sequence, id
  `).all(runId);
  const coordinates = new Set();
  const totalAccumulators = new Map();
  const adjustments = rows.map((row) => {
    const rowKey = String(row.row_key == null ? '' : row.row_key);
    const target = logicalRows.get(rowKey);
    if (!target) {
      throw resultStateError(
        'invalid-adjustment-target',
        `调整 ${row.id} 的 rowKey 不属于 run ${runId}`,
        { adjustmentId: Number(row.id), runId, rowKey }
      );
    }
    const actualMetadata = {
      subject: String(row.subject == null ? '' : row.subject),
      sourceType: String(row.source_type == null ? '' : row.source_type),
      categoryMajor: String(row.category_major == null ? '' : row.category_major),
      categoryMinor: String(row.category_minor == null ? '' : row.category_minor)
    };
    const expectedMetadata = {
      subject: target.subject,
      sourceType: target.sourceType,
      categoryMajor: target.categoryMajor,
      categoryMinor: target.categoryMinor
    };
    if (JSON.stringify(actualMetadata) !== JSON.stringify(expectedMetadata)) {
      throw resultStateError(
        'invalid-adjustment-metadata',
        `调整 ${row.id} 的主体/分类元数据与 rowKey 不一致`,
        { adjustmentId: Number(row.id), actualMetadata, expectedMetadata }
      );
    }
    const currency = String(row.currency == null ? '' : row.currency);
    if (!SUPPORTED_CURRENCY_SET.has(currency)) {
      throw resultStateError(
        'invalid-adjustment-currency',
        `调整 ${row.id} 包含不支持币种：${currency}`,
        { adjustmentId: Number(row.id), currency }
      );
    }
    const coord = coordinateKey(rowKey, currency);
    if (coordinates.has(coord)) {
      throw resultStateError(
        'adjustment-coordinate-duplicate',
        `run ${runId} 的调整坐标重复：${rowKey} / ${currency}`,
        { runId, rowKey, currency }
      );
    }
    coordinates.add(coord);
    const amount = canonicalStoredAmount(
      row.adjustment_amount,
      `调整 ${row.id} 金额`,
      'invalid-adjustment-amount'
    );
    if (amount === '0') {
      throw resultStateError(
        'invalid-adjustment-amount',
        `调整 ${row.id} 的金额不能为 0`,
        { adjustmentId: Number(row.id) }
      );
    }
    const reason = String(row.reason == null ? '' : row.reason);
    if (!reason || reason !== reason.trim() || Array.from(reason).length > 500) {
      throw resultStateError(
        'invalid-adjustment-reason',
        `调整 ${row.id} 的原因必须是 1～500 字的规范文本`,
        { adjustmentId: Number(row.id) }
      );
    }
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw resultStateError(
        'invalid-adjustment-sequence',
        `调整 ${row.id} 的 sequence 无效`,
        { adjustmentId: Number(row.id), sequence: row.sequence }
      );
    }
    addAmount(
      totalAccumulators,
      subjectCurrencyKey(target.subject, currency),
      amount
    );
    return Object.freeze({
      id: Number(row.id),
      runId: Number(row.run_id),
      rowKey,
      ...actualMetadata,
      currency,
      adjustmentAmount: amount,
      reason,
      sequence,
      createdAt: row.created_at,
      createdAppVersion: row.created_app_version,
      createdBuildSha: row.created_build_sha
    });
  });
  for (let index = 0; index < adjustments.length; index += 1) {
    const expected = index + 1;
    if (adjustments[index].sequence !== expected) {
      throw resultStateError(
        'adjustment-sequence-inconsistent',
        `run ${runId} 的调整 sequence 必须从 1 连续递增，期望 ${expected}，实际 ${adjustments[index].sequence}`,
        {
          runId,
          adjustmentId: adjustments[index].id,
          expectedSequence: expected,
          actualSequence: adjustments[index].sequence
        }
      );
    }
  }
  const totals = finalizeSummaryAmounts(totalAccumulators, {
    runId,
    field: 'adjustmentAmount',
    summaryType: 'adjustment-total',
    labelFor: (subject, currency) => `${subject} ${currency} 人工调整汇总`
  });
  return { adjustments, totals };
}

function buildEffectiveRows(runId, baseState, adjustments) {
  const rowsByCoordinate = new Map();
  for (const baseRow of baseState.baseRows) {
    rowsByCoordinate.set(coordinateKey(baseRow.rowKey, baseRow.currency), {
      rowKey: baseRow.rowKey,
      rowKind: baseRow.rowKind,
      subject: baseRow.subject,
      sourceType: baseRow.sourceType,
      categoryMajor: baseRow.categoryMajor,
      categoryMinor: baseRow.categoryMinor,
      currency: baseRow.currency,
      baseAmount: baseRow.amount,
      adjustmentAccumulator: new DecimalAccumulator()
    });
  }
  for (const adjustment of adjustments) {
    const coord = coordinateKey(adjustment.rowKey, adjustment.currency);
    let row = rowsByCoordinate.get(coord);
    if (!row) {
      const target = baseState.logicalRows.get(adjustment.rowKey);
      row = {
        rowKey: adjustment.rowKey,
        rowKind: target.rowKind,
        subject: target.subject,
        sourceType: target.sourceType,
        categoryMajor: target.categoryMajor,
        categoryMinor: target.categoryMinor,
        currency: adjustment.currency,
        baseAmount: '0',
        adjustmentAccumulator: new DecimalAccumulator()
      };
      rowsByCoordinate.set(coord, row);
    }
    row.adjustmentAccumulator.add(adjustment.adjustmentAmount);
  }
  return [...rowsByCoordinate.values()].map((row) => {
    const adjustmentValue = row.adjustmentAccumulator.value();
    const context = {
      runId,
      scope: 'row',
      rowKey: row.rowKey,
      subject: row.subject,
      currency: row.currency
    };
    return Object.freeze({
      rowKey: row.rowKey,
      rowKind: row.rowKind,
      subject: row.subject,
      sourceType: row.sourceType,
      categoryMajor: row.categoryMajor,
      categoryMinor: row.categoryMinor,
      currency: row.currency,
      baseAmount: row.baseAmount,
      adjustmentAmount: canonicalFinalAmount(adjustmentValue, {
        ...context,
        field: 'adjustmentAmount',
        label: `${row.subject} ${row.currency} 结果行调整`
      }),
      effectiveAmount: canonicalFinalAmount(
        accumulateAmounts(row.baseAmount, adjustmentValue),
        {
          ...context,
          field: 'effectiveAmount',
          label: `${row.subject} ${row.currency} 生效结果行金额`
        }
      )
    });
  });
}

function buildEffectiveBalances(db, runId, baseState, adjustmentTotals) {
  const rows = db.prepare(`
    SELECT subject, currency, opening_balance, period_amount,
           calculated_balance, system_balance, difference
    FROM vcc_fin_op_run_balances
    WHERE run_id = ?
    ORDER BY subject, currency
  `).all(runId);
  if (rows.length === 0) {
    throw resultStateError(
      'run-balances-empty',
      `run ${runId} 没有基础余额，不能读取生效结果`,
      { runId }
    );
  }
  const seen = new Set();
  const subjects = new Map();
  const balances = rows.map((row) => {
    const subject = String(row.subject == null ? '' : row.subject);
    const currency = String(row.currency == null ? '' : row.currency);
    if (!subject || !SUPPORTED_CURRENCY_SET.has(currency)) {
      throw resultStateError(
        'invalid-run-balance-coordinate',
        `run ${runId} 包含无效余额坐标：${subject} / ${currency}`,
        { runId, subject, currency }
      );
    }
    const key = subjectCurrencyKey(subject, currency);
    if (seen.has(key)) {
      throw resultStateError('run-balance-coordinate-duplicate', `run ${runId} 余额坐标重复`, {
        runId, subject, currency
      });
    }
    seen.add(key);
    if (!subjects.has(subject)) subjects.set(subject, new Set());
    subjects.get(subject).add(currency);
    const openingBalance = canonicalStoredAmount(
      row.opening_balance, `${subject} ${currency} 基础期初余额`, 'invalid-run-balance-amount'
    );
    const basePeriodAmount = canonicalStoredAmount(
      row.period_amount, `${subject} ${currency} 基础发生额`, 'invalid-run-balance-amount'
    );
    const baseCalculatedBalance = canonicalStoredAmount(
      row.calculated_balance, `${subject} ${currency} 基础计算余额`, 'invalid-run-balance-amount'
    );
    const systemBalance = canonicalStoredAmount(
      row.system_balance, `${subject} ${currency} 系统财务OP`, 'invalid-run-balance-amount'
    );
    const baseDifference = canonicalStoredAmount(
      row.difference, `${subject} ${currency} 基础差异`, 'invalid-run-balance-amount'
    );
    const recomputedPeriod = baseState.periodTotals.get(key) || '0';
    if (recomputedPeriod !== basePeriodAmount) {
      throw resultStateError(
        'run-base-period-mismatch',
        `run ${runId} 的基础发生额与结果行汇总不一致：${subject} / ${currency}`,
        { runId, subject, currency, stored: basePeriodAmount, recomputed: recomputedPeriod }
      );
    }
    const balanceContext = { runId, scope: 'balance', subject, currency };
    const recomputedCalculated = canonicalFinalAmount(
      accumulateAmounts(openingBalance, basePeriodAmount),
      {
        ...balanceContext,
        field: 'baseCalculatedBalance',
        label: `${subject} ${currency} 基础计算余额复核`
      }
    );
    const recomputedDifference = canonicalFinalAmount(
      subtractCanonicalDecimals(systemBalance, baseCalculatedBalance, {
        label: `${subject} ${currency} 基础差异复核`
      }),
      {
        ...balanceContext,
        field: 'baseDifference',
        label: `${subject} ${currency} 基础差异复核`
      }
    );
    if (recomputedCalculated !== baseCalculatedBalance || recomputedDifference !== baseDifference) {
      throw resultStateError(
        'run-base-balance-mismatch',
        `run ${runId} 的基础余额公式不一致：${subject} / ${currency}`,
        { runId, subject, currency }
      );
    }
    const adjustmentAmount = adjustmentTotals.get(key) || '0';
    const effectivePeriodValue = accumulateAmounts(basePeriodAmount, adjustmentAmount);
    const effectiveCalculatedValue = accumulateAmounts(
      openingBalance,
      basePeriodAmount,
      adjustmentAmount
    );
    const effectivePeriodAmount = canonicalFinalAmount(effectivePeriodValue, {
      ...balanceContext,
      field: 'effectivePeriodAmount',
      label: `${subject} ${currency} 生效发生额`
    });
    const effectiveCalculatedBalance = canonicalFinalAmount(effectiveCalculatedValue, {
      ...balanceContext,
      field: 'effectiveCalculatedBalance',
      label: `${subject} ${currency} 生效计算余额`
    });
    const effectiveDifference = canonicalFinalAmount(
      subtractCanonicalDecimals(systemBalance, effectiveCalculatedValue, {
        label: `${subject} ${currency} 生效差异`
      }),
      {
        ...balanceContext,
        field: 'effectiveDifference',
        label: `${subject} ${currency} 生效差异`
      }
    );
    return Object.freeze({
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
    });
  });
  for (const key of baseState.periodTotals.keys()) {
    if (!seen.has(key)) {
      const [subject, currency] = JSON.parse(key);
      throw resultStateError(
        'run-base-balance-coordinate-missing',
        `基础结果行缺少对应 run balance：${subject} / ${currency}`,
        { runId, subject, currency }
      );
    }
  }
  for (const [subject, currencies] of subjects) {
    const missing = SUPPORTED_CURRENCIES.filter((currency) => !currencies.has(currency));
    if (missing.length > 0) {
      throw resultStateError(
        'run-balance-currencies-incomplete',
        `run ${runId} 的 ${subject} 缺少余额币种：${missing.join('、')}`,
        { runId, subject, missingCurrencies: missing }
      );
    }
  }
  for (const key of adjustmentTotals.keys()) {
    if (!seen.has(key)) {
      const [subject, currency] = JSON.parse(key);
      throw resultStateError(
        'invalid-adjustment-coordinate',
        `调整目标缺少 run balance：${subject} / ${currency}`,
        { runId, subject, currency }
      );
    }
  }
  return balances;
}

function emptyCurrencyAmounts() {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, null]));
}

function buildReviewRows(baseState, adjustments) {
  const logicalRows = new Map();
  for (const row of baseState.baseRows) {
    let logical = logicalRows.get(row.rowKey);
    if (!logical) {
      logical = {
        type: 'base',
        rowKey: row.rowKey,
        rowKind: row.rowKind,
        subject: row.subject,
        sourceType: row.sourceType,
        sourceLabel: SOURCE_LABELS[row.sourceType] || row.sourceType,
        categoryMajor: row.categoryMajor,
        categoryMinor: row.categoryMinor,
        currencyAmounts: emptyCurrencyAmounts(),
        baseRowIds: []
      };
      logicalRows.set(row.rowKey, logical);
    }
    logical.currencyAmounts[row.currency] = row.amount;
    logical.baseRowIds.push(row.id);
  }

  const adjustmentsByRowKey = new Map();
  for (const adjustment of adjustments) {
    if (!adjustmentsByRowKey.has(adjustment.rowKey)) {
      adjustmentsByRowKey.set(adjustment.rowKey, []);
    }
    adjustmentsByRowKey.get(adjustment.rowKey).push(adjustment);
  }

  const reviewRows = [];
  for (const logical of logicalRows.values()) {
    reviewRows.push(Object.freeze({
      ...logical,
      currencyAmounts: Object.freeze({ ...logical.currencyAmounts }),
      baseRowIds: Object.freeze([...logical.baseRowIds])
    }));
    for (const adjustment of adjustmentsByRowKey.get(logical.rowKey) || []) {
      const currencyAmounts = emptyCurrencyAmounts();
      currencyAmounts[adjustment.currency] = adjustment.adjustmentAmount;
      reviewRows.push(Object.freeze({
        type: 'adjustment',
        adjustmentId: adjustment.id,
        rowKey: adjustment.rowKey,
        rowKind: logical.rowKind,
        subject: logical.subject,
        sourceType: logical.sourceType,
        sourceLabel: logical.sourceLabel,
        categoryMajor: logical.categoryMajor,
        categoryMinor: logical.categoryMinor,
        currency: adjustment.currency,
        currencyAmounts: Object.freeze(currencyAmounts),
        adjustmentAmount: adjustment.adjustmentAmount,
        reason: adjustment.reason,
        sequence: adjustment.sequence,
        createdAt: adjustment.createdAt
      }));
    }
  }
  return reviewRows;
}

function buildReviewSubjects(reviewRows, balances) {
  const subjectOrder = [];
  const rowsBySubject = new Map();
  for (const row of reviewRows) {
    if (!rowsBySubject.has(row.subject)) {
      rowsBySubject.set(row.subject, []);
      subjectOrder.push(row.subject);
    }
    rowsBySubject.get(row.subject).push(row);
  }
  for (const balance of balances) {
    if (!rowsBySubject.has(balance.subject)) {
      rowsBySubject.set(balance.subject, []);
      subjectOrder.push(balance.subject);
    }
  }
  const balanceByCoordinate = new Map(
    balances.map((row) => [subjectCurrencyKey(row.subject, row.currency), row])
  );
  return subjectOrder.map((subject) => {
    const summaries = {
      openingBalance: {},
      effectiveCalculatedBalance: {},
      systemBalance: {},
      effectiveDifference: {}
    };
    for (const currency of SUPPORTED_CURRENCIES) {
      const balance = balanceByCoordinate.get(subjectCurrencyKey(subject, currency));
      if (!balance) {
        throw resultStateError(
          'run-balance-coordinate-missing',
          `run 结果复核缺少余额坐标：${subject} / ${currency}`,
          { subject, currency }
        );
      }
      summaries.openingBalance[currency] = balance.openingBalance;
      summaries.effectiveCalculatedBalance[currency] = balance.effectiveCalculatedBalance;
      summaries.systemBalance[currency] = balance.systemBalance;
      summaries.effectiveDifference[currency] = balance.effectiveDifference;
    }
    return Object.freeze({
      subject,
      rows: Object.freeze([...(rowsBySubject.get(subject) || [])]),
      summaries: Object.freeze(Object.fromEntries(
        Object.entries(summaries).map(([key, amounts]) => [key, Object.freeze(amounts)])
      ))
    });
  });
}

function getEffectiveRunResult(db, runId) {
  const normalizedRunId = Number(runId);
  if (!Number.isSafeInteger(normalizedRunId) || normalizedRunId < 1) {
    throw resultStateError('invalid-run-id', `财务OP run id 无效：${runId}`);
  }
  const run = db.prepare(`
    SELECT id, target_month, status, input_revisions_json, result_revision,
           input_fingerprint, created_at, updated_at, archived_at
    FROM vcc_fin_op_runs
    WHERE id = ?
  `).get(normalizedRunId);
  if (!run) return null;
  const baseState = validateBaseRows(db, normalizedRunId);
  const adjustmentState = validateAdjustments(db, normalizedRunId, baseState.logicalRows);
  const resultRevision = Number(run.result_revision);
  if (!Number.isSafeInteger(resultRevision) || resultRevision < 0
      || resultRevision !== adjustmentState.adjustments.length) {
    throw resultStateError(
      'result-revision-inconsistent',
      `run ${normalizedRunId} 的 result_revision 与调整事实不一致`,
      {
        runId: normalizedRunId,
        resultRevision: run.result_revision,
        adjustmentCount: adjustmentState.adjustments.length
      }
    );
  }
  const effectiveRows = buildEffectiveRows(
    normalizedRunId,
    baseState,
    adjustmentState.adjustments
  );
  const balances = buildEffectiveBalances(
    db,
    normalizedRunId,
    baseState,
    adjustmentState.totals
  );
  const reviewRows = buildReviewRows(baseState, adjustmentState.adjustments);
  const reviewSubjects = buildReviewSubjects(reviewRows, balances);
  return Object.freeze({
    run: Object.freeze({
      runId: Number(run.id),
      targetMonth: run.target_month,
      status: run.status,
      inputRevisionsJson: run.input_revisions_json,
      resultRevision,
      inputFingerprint: run.input_fingerprint,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      archivedAt: run.archived_at
    }),
    baseRows: Object.freeze(baseState.baseRows),
    adjustments: Object.freeze(adjustmentState.adjustments),
    effectiveRows: Object.freeze(effectiveRows),
    balances: Object.freeze(balances),
    review: Object.freeze({
      currencies: Object.freeze([...SUPPORTED_CURRENCIES]),
      subjects: Object.freeze(reviewSubjects)
    })
  });
}

function requireEffectiveRun(db, runId) {
  const effective = getEffectiveRunResult(db, runId);
  if (!effective) {
    throw resultStateError('run-not-found', `财务OP计算记录不存在：${runId}`, {
      runId: Number(runId)
    });
  }
  return effective;
}

function listAdjustmentOptions(db, runId) {
  const effective = requireEffectiveRun(db, runId);
  if (effective.run.status !== 'calculated') {
    throw resultStateError(
      'adjustment-locked',
      '已归档结果不能修改，请先解归档。',
      { runId: effective.run.runId, status: effective.run.status }
    );
  }
  const adjusted = new Set(
    effective.adjustments.map((row) => coordinateKey(row.rowKey, row.currency))
  );
  const logicalRows = new Map();
  for (const row of effective.baseRows) {
    if (!logicalRows.has(row.rowKey)) logicalRows.set(row.rowKey, row);
  }
  const options = [...logicalRows.values()].map((row) => {
    const adjustedCurrencies = SUPPORTED_CURRENCIES.filter((currency) => (
      adjusted.has(coordinateKey(row.rowKey, currency))
    ));
    const availableCurrencies = SUPPORTED_CURRENCIES.filter((currency) => (
      !adjusted.has(coordinateKey(row.rowKey, currency))
    ));
    return Object.freeze({
      rowKey: row.rowKey,
      subject: row.subject,
      sourceType: row.sourceType,
      sourceLabel: SOURCE_LABELS[row.sourceType] || row.sourceType,
      categoryMajor: row.categoryMajor,
      categoryMinor: row.categoryMinor,
      availableCurrencies: Object.freeze(availableCurrencies),
      adjustedCurrencies: Object.freeze(adjustedCurrencies)
    });
  }).filter((row) => row.availableCurrencies.length > 0);
  return Object.freeze({
    runId: effective.run.runId,
    targetMonth: effective.run.targetMonth,
    status: effective.run.status,
    resultRevision: effective.run.resultRevision,
    currencies: Object.freeze([...SUPPORTED_CURRENCIES]),
    options: Object.freeze(options)
  });
}

function translateAdjustmentConstraint(db, runId, rowKey, currency, error) {
  const existing = db.prepare(`
    SELECT id FROM vcc_fin_op_run_adjustments
    WHERE run_id = ? AND row_key = ? AND currency = ?
  `).get(runId, rowKey, currency);
  if (existing) {
    return resultStateError(
      'adjustment-already-exists',
      '该结果坐标已经修改过，不能再次调整。',
      { runId, rowKey, currency, adjustmentId: Number(existing.id), cause: error }
    );
  }
  return error;
}

function addRunAdjustment({
  db,
  runId,
  rowKey,
  currency,
  adjustmentAmount,
  reason,
  expectedResultRevision,
  appVersion = null,
  buildSha = null
}) {
  const normalizedRunId = Number(runId);
  if (!Number.isSafeInteger(normalizedRunId) || normalizedRunId < 1) {
    throw resultStateError('invalid-run-id', `财务OP run id 无效：${runId}`);
  }
  const expectedRevision = normalizeExpectedResultRevision(expectedResultRevision);
  const normalizedRowKey = String(rowKey == null ? '' : rowKey).trim();
  if (!/^v1:[a-f0-9]{64}$/.test(normalizedRowKey)) {
    throw resultStateError('invalid-adjustment-target', '调整目标 rowKey 无效', {
      runId: normalizedRunId,
      rowKey
    });
  }
  const normalizedCurrency = String(currency == null ? '' : currency).trim();
  if (!SUPPORTED_CURRENCY_SET.has(normalizedCurrency)) {
    throw resultStateError('invalid-adjustment-currency', `不支持调整币种：${normalizedCurrency}`, {
      currency
    });
  }
  const normalizedAmount = normalizeAdjustmentAmount(adjustmentAmount);
  const normalizedReason = normalizeAdjustmentReason(reason);

  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const before = requireEffectiveRun(db, normalizedRunId);
    if (before.run.status !== 'calculated') {
      throw resultStateError(
        'adjustment-locked',
        '已归档结果不能修改，请先解归档。',
        { runId: normalizedRunId, status: before.run.status }
      );
    }
    if (before.run.resultRevision !== expectedRevision) {
      throw resultRevisionChanged({
        runId: normalizedRunId,
        expectedResultRevision: expectedRevision,
        actualResultRevision: before.run.resultRevision
      });
    }
    const target = before.baseRows.find((row) => row.rowKey === normalizedRowKey);
    if (!target) {
      throw resultStateError(
        'invalid-adjustment-target',
        '调整目标已变化，请刷新结果表后重试。',
        { runId: normalizedRunId, rowKey: normalizedRowKey }
      );
    }
    const existing = before.adjustments.find((row) => (
      row.rowKey === normalizedRowKey && row.currency === normalizedCurrency
    ));
    if (existing) {
      throw resultStateError(
        'adjustment-already-exists',
        '该结果坐标已经修改过，不能再次调整。',
        {
          runId: normalizedRunId,
          rowKey: normalizedRowKey,
          currency: normalizedCurrency,
          adjustmentId: existing.id
        }
      );
    }
    const nextSequence = before.run.resultRevision + 1;
    let inserted;
    try {
      inserted = db.prepare(`
        INSERT INTO vcc_fin_op_run_adjustments (
          run_id, row_key, subject, source_type, category_major, category_minor,
          currency, adjustment_amount, reason, sequence,
          created_app_version, created_build_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedRunId,
        normalizedRowKey,
        target.subject,
        target.sourceType,
        target.categoryMajor,
        target.categoryMinor,
        normalizedCurrency,
        normalizedAmount,
        normalizedReason,
        nextSequence,
        appVersion,
        buildSha
      );
    } catch (error) {
      throw translateAdjustmentConstraint(
        db,
        normalizedRunId,
        normalizedRowKey,
        normalizedCurrency,
        error
      );
    }
    const updated = db.prepare(`
      UPDATE vcc_fin_op_runs
      SET result_revision = result_revision + 1,
          updated_at = datetime('now', 'localtime')
      WHERE id = ? AND status = 'calculated' AND result_revision = ?
    `).run(normalizedRunId, expectedRevision);
    if (Number(updated.changes) !== 1) {
      throw resultRevisionChanged({
        runId: normalizedRunId,
        expectedResultRevision: expectedRevision
      });
    }
    const after = requireEffectiveRun(db, normalizedRunId);
    const adjustmentId = Number(inserted.lastInsertRowid);
    const saved = after.adjustments.find((row) => row.id === adjustmentId);
    if (
      after.run.resultRevision !== nextSequence
      || !saved
      || saved.rowKey !== normalizedRowKey
      || saved.currency !== normalizedCurrency
      || saved.adjustmentAmount !== normalizedAmount
      || saved.reason !== normalizedReason
      || saved.sequence !== nextSequence
    ) {
      throw resultStateError(
        'adjustment-write-invariant-failed',
        '调整结果提交前断言失败，操作已回滚。',
        { runId: normalizedRunId, adjustmentId }
      );
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return Object.freeze({
      status: 'adjusted',
      runId: normalizedRunId,
      targetMonth: after.run.targetMonth,
      resultRevision: after.run.resultRevision,
      adjustment: saved
    });
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve primary error */ }
    }
    throw error;
  }
}

module.exports = {
  RUN_ROW_KEY_VERSION,
  RESULT_REVISION_CHANGED_CODE,
  RESULT_REVISION_CHANGED_MESSAGE,
  buildRunRowKey,
  normalizeAdjustmentAmount,
  assertExpectedResultRevision,
  getEffectiveRunResult,
  listAdjustmentOptions,
  addRunAdjustment
};
