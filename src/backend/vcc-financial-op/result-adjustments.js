'use strict';

const crypto = require('node:crypto');
const {
  addCanonicalDecimals,
  subtractCanonicalDecimals
} = require('../../main-process/financial-decimal');
const { canonicalizeVccAmount } = require('./amount-rules');
const { SOURCE_TYPES, SUPPORTED_CURRENCIES } = require('./definitions');

const RUN_ROW_KEY_VERSION = 'v1';
const ADJUSTABLE_ROW_KINDS = new Set(['movement', 'pending']);
const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCIES);
const MOVEMENT_SOURCE_TYPES = new Set([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL
]);

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

function addAmount(map, key, amount, label) {
  const next = addCanonicalDecimals(map.get(key) || '0', amount, { label });
  map.set(key, canonicalizeVccAmount(next, label));
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
  const periodTotals = new Map();
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
      periodTotals,
      subjectCurrencyKey(metadata.subject, currency),
      amount,
      `${metadata.subject} ${currency} 基础发生额汇总`
    );
    return normalized;
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
  const totals = new Map();
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
    if (!reason || reason !== reason.trim() || reason.length > 500) {
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
      totals,
      subjectCurrencyKey(target.subject, currency),
      amount,
      `${target.subject} ${currency} 人工调整汇总`
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
  return { adjustments, totals };
}

function buildEffectiveRows(baseState, adjustments) {
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
      adjustmentAmount: '0'
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
        adjustmentAmount: '0'
      };
      rowsByCoordinate.set(coord, row);
    }
    row.adjustmentAmount = addCanonicalDecimals(
      row.adjustmentAmount,
      adjustment.adjustmentAmount,
      { label: `${row.subject} ${row.currency} 结果行调整` }
    );
  }
  return [...rowsByCoordinate.values()].map((row) => Object.freeze({
    ...row,
    adjustmentAmount: canonicalizeVccAmount(
      row.adjustmentAmount,
      `${row.subject} ${row.currency} 结果行调整`
    ),
    effectiveAmount: canonicalizeVccAmount(
      addCanonicalDecimals(row.baseAmount, row.adjustmentAmount, {
        label: `${row.subject} ${row.currency} 生效结果行金额`
      }),
      `${row.subject} ${row.currency} 生效结果行金额`
    )
  }));
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
    const recomputedCalculated = canonicalizeVccAmount(
      addCanonicalDecimals(openingBalance, basePeriodAmount, {
        label: `${subject} ${currency} 基础计算余额复核`
      }),
      `${subject} ${currency} 基础计算余额复核`
    );
    const recomputedDifference = canonicalizeVccAmount(
      subtractCanonicalDecimals(systemBalance, baseCalculatedBalance, {
        label: `${subject} ${currency} 基础差异复核`
      }),
      `${subject} ${currency} 基础差异复核`
    );
    if (recomputedCalculated !== baseCalculatedBalance || recomputedDifference !== baseDifference) {
      throw resultStateError(
        'run-base-balance-mismatch',
        `run ${runId} 的基础余额公式不一致：${subject} / ${currency}`,
        { runId, subject, currency }
      );
    }
    const adjustmentAmount = adjustmentTotals.get(key) || '0';
    const effectivePeriodAmount = canonicalizeVccAmount(
      addCanonicalDecimals(basePeriodAmount, adjustmentAmount, {
        label: `${subject} ${currency} 生效发生额`
      }),
      `${subject} ${currency} 生效发生额`
    );
    const effectiveCalculatedBalance = canonicalizeVccAmount(
      addCanonicalDecimals(openingBalance, effectivePeriodAmount, {
        label: `${subject} ${currency} 生效计算余额`
      }),
      `${subject} ${currency} 生效计算余额`
    );
    const effectiveDifference = canonicalizeVccAmount(
      subtractCanonicalDecimals(systemBalance, effectiveCalculatedBalance, {
        label: `${subject} ${currency} 生效差异`
      }),
      `${subject} ${currency} 生效差异`
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
  const effectiveRows = buildEffectiveRows(baseState, adjustmentState.adjustments);
  const balances = buildEffectiveBalances(
    db,
    normalizedRunId,
    baseState,
    adjustmentState.totals
  );
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
    balances: Object.freeze(balances)
  });
}

module.exports = {
  RUN_ROW_KEY_VERSION,
  buildRunRowKey,
  getEffectiveRunResult
};
