'use strict';

const crypto = require('node:crypto');
const {
  addCanonicalDecimals,
  subtractCanonicalDecimals,
  canonicalizeDecimal
} = require('../../main-process/financial-decimal');
const { canonicalizeVccAmount } = require('./amount-rules');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES
} = require('./definitions');
const { normalizeYearMonth } = require('./row-mapper');
const { DecimalAccumulator, addToAccumulatorMap } = require('./decimal-accumulator');

const REQUIRED_DETAIL_TYPES = Object.freeze([
  SOURCE_TYPES.RECHARGE,
  SOURCE_TYPES.FEE_FX,
  SOURCE_TYPES.CHANNEL,
  SOURCE_TYPES.PENDING
]);
const REQUIRED_DATASET_TYPES = Object.freeze([
  ...REQUIRED_DETAIL_TYPES,
  SOURCE_TYPES.SYSTEM_OP
]);

function previousYearMonth(yearMonth) {
  const normalized = normalizeYearMonth(yearMonth);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  const date = new Date(year, month - 2, 1);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextYearMonth(yearMonth) {
  const normalized = normalizeYearMonth(yearMonth);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  const date = new Date(year, month, 1);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parseBalancesJson(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (_error) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}余额数据损坏`);
  }
  const balances = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    if (!Object.hasOwn(parsed, currency)) throw new Error(`${label}缺少 ${currency} 余额`);
    balances[currency] = canonicalizeDecimal(parsed[currency], { label: `${label} ${currency}` });
  }
  return balances;
}

function datasetSnapshot(db, targetMonth) {
  const rows = db.prepare(`
    SELECT dataset_type, data_status, revision
    FROM vcc_fin_op_datasets
    WHERE target_month = ?
    ORDER BY dataset_type
  `).all(targetMonth);
  return {
    rows,
    revisions: Object.fromEntries(rows.map((row) => [row.dataset_type, Number(row.revision) || 1]))
  };
}

function unresolvedImports(db, targetMonth) {
  return db.prepare(`
    SELECT id, source_type, status, error_message
    FROM vcc_fin_op_import_records
    WHERE target_month = ? AND resolution_status = 'unresolved'
    ORDER BY id
  `).all(targetMonth);
}

function activeImportBatches(db, targetMonth) {
  return db.prepare(`
    SELECT b.id, b.started_at, COUNT(r.id) AS record_count
    FROM vcc_fin_op_import_batches b
    LEFT JOIN vcc_fin_op_import_records r ON r.batch_id = b.id
    WHERE b.target_month = ? AND b.status = 'importing'
    GROUP BY b.id, b.started_at
    ORDER BY b.started_at, b.id
  `).all(targetMonth);
}

function preflightCalculation(db, targetMonth) {
  const snapshot = datasetSnapshot(db, targetMonth);
  const byType = new Map(snapshot.rows.map((row) => [row.dataset_type, row]));
  const detailCounts = new Map();
  for (const sourceType of REQUIRED_DETAIL_TYPES) {
    const count = db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    `).get(targetMonth, sourceType);
    detailCounts.set(sourceType, Number(count.row_count) || 0);
  }
  const systemRows = db.prepare(`
    SELECT subject, balances_json, content_hash
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
    ORDER BY subject
  `).all(targetMonth);
  const invalidSystemSubjects = [];
  for (const row of systemRows) {
    try {
      parseBalancesJson(row.balances_json, `${targetMonth} ${row.subject} 系统财务OP`);
    } catch (error) {
      invalidSystemSubjects.push({ subject: row.subject, reason: error.message });
    }
  }
  const datasets = REQUIRED_DATASET_TYPES.map((sourceType) => {
    const dataset = byType.get(sourceType) || null;
    const rowCount = sourceType === SOURCE_TYPES.SYSTEM_OP
      ? systemRows.length
      : (detailCounts.get(sourceType) || 0);
    const reasons = [];
    if (!dataset) reasons.push('缺少数据集');
    if (rowCount === 0) reasons.push('没有有效数据');
    if (dataset && dataset.data_status !== 'unprocessed') reasons.push('数据已归档');
    if (sourceType === SOURCE_TYPES.SYSTEM_OP && invalidSystemSubjects.length > 0) {
      reasons.push(`九币种快照不完整：${invalidSystemSubjects.map((item) => item.subject).join('、')}`);
    }
    return {
      sourceType,
      label: sourceType === SOURCE_TYPES.SYSTEM_OP
        ? SOURCE_LABELS[sourceType]
        : `${SOURCE_LABELS[sourceType]}_校验表`,
      datasetExists: Boolean(dataset),
      rowCount,
      dataStatus: dataset ? dataset.data_status : null,
      revision: dataset ? Number(dataset.revision) || 1 : null,
      complete: reasons.length === 0,
      reason: reasons.join('；')
    };
  });
  const missing = datasets.filter((item) => (
    !item.datasetExists
    || item.rowCount === 0
    || (item.sourceType === SOURCE_TYPES.SYSTEM_OP && invalidSystemSubjects.length > 0)
  )).map((item) => item.sourceType);
  const archived = snapshot.rows
    .filter((row) => row.data_status === 'archived')
    .map((row) => row.dataset_type);
  const activeImports = activeImportBatches(db, targetMonth);
  const unresolved = unresolvedImports(db, targetMonth);
  const detailSubjects = db.prepare(`
    SELECT DISTINCT subject
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ? AND source_type IN (?, ?, ?, ?)
    ORDER BY subject
  `).all(targetMonth, ...REQUIRED_DETAIL_TYPES).map((row) => row.subject);
  const systemSubjects = systemRows.map((row) => row.subject);
  const previousMonth = previousYearMonth(targetMonth);
  const openingSubjects = db.prepare(`
    SELECT subject FROM vcc_fin_op_archives WHERE target_month = ?
    UNION
    SELECT subject FROM vcc_fin_op_opening_balances WHERE target_month = ?
    ORDER BY subject
  `).all(previousMonth, targetMonth).map((row) => row.subject);
  const expectedSubjects = [...new Set([...detailSubjects, ...openingSubjects])].sort();
  const systemSubjectSet = new Set(systemSubjects);
  const expectedSubjectSet = new Set(expectedSubjects);
  const missingSystemSubjects = expectedSubjects.filter((subject) => !systemSubjectSet.has(subject));
  const unexpectedSystemSubjects = systemSubjects.filter((subject) => !expectedSubjectSet.has(subject));
  const inputFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    targetMonth,
    datasets: datasets.map((item) => ({
      sourceType: item.sourceType,
      rowCount: item.rowCount,
      dataStatus: item.dataStatus,
      revision: item.revision
    })),
    system: systemRows.map((row) => [row.subject, row.content_hash]),
    unresolved: unresolved.map((row) => row.id)
  }), 'utf8').digest('hex');
  if (
    activeImports.length > 0
    || missing.length > 0
    || archived.length > 0
    || unresolved.length > 0
    || missingSystemSubjects.length > 0
    || unexpectedSystemSubjects.length > 0
  ) {
    return {
      ok: false,
      code: activeImports.length > 0
        ? 'active-imports'
        : (missing.length > 0
          ? 'missing-datasets'
          : (archived.length > 0
            ? 'month-already-archived'
            : (unresolved.length > 0
              ? 'unresolved-imports'
              : (missingSystemSubjects.length > 0 ? 'missing-system-subject' : 'subject-mismatch')))),
      missing: missing.map((sourceType) => (
        datasets.find((item) => item.sourceType === sourceType).label
      )),
      archived: archived.map((sourceType) => SOURCE_LABELS[sourceType]),
      activeImports,
      unresolved,
      invalidSystemSubjects,
      missingSystemSubjects,
      unexpectedSystemSubjects,
      datasets,
      revisions: snapshot.revisions,
      inputFingerprint
    };
  }
  return { ok: true, datasets, revisions: snapshot.revisions, inputFingerprint };
}

function movementGroupKey(row) {
  if (row.source_type === SOURCE_TYPES.RECHARGE) {
    return JSON.stringify([
      row.subject,
      row.source_type,
      row.business_sub_type || '',
      row.counterparty_department || '',
      row.stat_currency
    ]);
  }
  if (row.source_type === SOURCE_TYPES.FEE_FX) {
    return JSON.stringify([
      row.subject,
      row.source_type,
      row.business_sub_type || '',
      '',
      row.stat_currency
    ]);
  }
  return JSON.stringify([
    row.subject,
    row.source_type,
    row.mid || '',
    row.channel_name || '',
    row.stat_currency
  ]);
}

function pendingSummaryKey(row) {
  return JSON.stringify([
    row.subject,
    row.channel_name || '',
    Number(row.currency_mismatch) || 0,
    row.flow_currency,
    row.pending_currency,
    row.recon_type || ''
  ]);
}

function nestedAmountKey(subject, currency) {
  return JSON.stringify([subject, currency]);
}

function aggregateEffectiveRows(db, targetMonth) {
  const movementGroups = new Map();
  const pendingGroups = new Map();
  const pendingCurrencyTotals = new Map();
  const periodTotals = new Map();
  const subjects = new Set();
  const rows = db.prepare(`
    SELECT source_type, subject, stat_currency, signed_amount,
           business_sub_type, counterparty_department, channel_name, mid,
           recon_type, pending_currency, pending_amount,
           flow_currency, flow_amount, currency_mismatch
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ?
    ORDER BY id
  `).iterate(targetMonth);

  for (const row of rows) {
    subjects.add(row.subject);
    if (row.source_type !== SOURCE_TYPES.PENDING) {
      const key = movementGroupKey(row);
      let group = movementGroups.get(key);
      if (!group) {
        const parsed = JSON.parse(key);
        group = {
          subject: parsed[0], sourceType: parsed[1], categoryMajor: parsed[2],
          categoryMinor: parsed[3], currency: parsed[4], amount: new DecimalAccumulator()
        };
        movementGroups.set(key, group);
      }
      group.amount.add(row.signed_amount);
      addToAccumulatorMap(periodTotals, nestedAmountKey(row.subject, row.stat_currency), row.signed_amount);
      continue;
    }

    const summaryKey = pendingSummaryKey(row);
    let summary = pendingGroups.get(summaryKey);
    if (!summary) {
      const parsed = JSON.parse(summaryKey);
      summary = {
        subject: parsed[0], channelName: parsed[1], currencyMismatch: parsed[2],
        flowCurrency: parsed[3], pendingCurrency: parsed[4], reconType: parsed[5],
        flowAmount: new DecimalAccumulator(), pendingAmount: new DecimalAccumulator()
      };
      pendingGroups.set(summaryKey, summary);
    }
    summary.flowAmount.add(row.flow_amount);
    summary.pendingAmount.add(row.pending_amount);
    addToAccumulatorMap(
      pendingCurrencyTotals,
      nestedAmountKey(row.subject, row.flow_currency),
      row.flow_amount
    );
    addToAccumulatorMap(
      pendingCurrencyTotals,
      nestedAmountKey(row.subject, row.pending_currency),
      row.pending_amount
    );
  }

  for (const [key, amount] of pendingCurrencyTotals) {
    addToAccumulatorMap(periodTotals, key, amount.value());
  }
  return { movementGroups, pendingGroups, pendingCurrencyTotals, periodTotals, subjects };
}

function loadSystemSnapshots(db, targetMonth) {
  const rows = db.prepare(`
    SELECT subject, balances_json FROM vcc_fin_op_system_snapshots
    WHERE target_month = ? ORDER BY subject
  `).all(targetMonth);
  return new Map(rows.map((row) => [row.subject, parseBalancesJson(row.balances_json, `${targetMonth} ${row.subject} 系统财务OP`)]));
}

function loadOpeningBalances(db, targetMonth) {
  const previousMonth = previousYearMonth(targetMonth);
  const archiveRows = db.prepare(`
    SELECT subject, balances_json FROM vcc_fin_op_archives
    WHERE target_month = ? ORDER BY subject
  `).all(previousMonth);
  const initializedRows = db.prepare(`
    SELECT subject, balances_json FROM vcc_fin_op_opening_balances
    WHERE target_month = ? ORDER BY subject
  `).all(targetMonth);
  const balances = new Map();
  const sources = new Map();
  for (const row of archiveRows) {
    balances.set(row.subject, parseBalancesJson(row.balances_json, `${previousMonth} ${row.subject} 归档OP`));
    sources.set(row.subject, 'previous_archive');
  }
  for (const row of initializedRows) {
    if (balances.has(row.subject)) {
      throw new Error(`${targetMonth} ${row.subject} 同时存在上月归档和人工期初，数据状态异常`);
    }
    balances.set(row.subject, parseBalancesJson(row.balances_json, `${targetMonth} ${row.subject} 人工期初OP`));
    sources.set(row.subject, 'manual_initialization');
  }
  return {
    previousMonth,
    balances,
    sources
  };
}

function buildBalanceRows(aggregate, systemSnapshots, openingBalances) {
  const subjects = new Set([
    ...aggregate.subjects,
    ...systemSnapshots.keys(),
    ...openingBalances.balances.keys()
  ]);
  const missingSystemSubjects = [...subjects].filter((subject) => !systemSnapshots.has(subject));
  const missingOpeningSubjects = [...subjects].filter((subject) => !openingBalances.balances.has(subject));
  if (missingSystemSubjects.length > 0 || missingOpeningSubjects.length > 0) {
    return { ok: false, missingSystemSubjects, missingOpeningSubjects };
  }

  const balances = [];
  for (const subject of [...subjects].sort()) {
    const opening = openingBalances.balances.get(subject);
    const system = systemSnapshots.get(subject);
    for (const currency of SUPPORTED_CURRENCIES) {
      const periodAccumulator = aggregate.periodTotals.get(nestedAmountKey(subject, currency));
      const periodAmount = periodAccumulator ? periodAccumulator.value() : '0';
      const calculatedBalance = addCanonicalDecimals(opening[currency], periodAmount, {
        label: `${subject} ${currency} 当月计算财务OP`
      });
      const difference = subtractCanonicalDecimals(system[currency], calculatedBalance, {
        label: `${subject} ${currency} 财务OP差异`
      });
      balances.push({
        subject,
        currency,
        openingBalance: opening[currency],
        periodAmount,
        calculatedBalance,
        systemBalance: system[currency],
        difference
      });
    }
  }
  return { ok: true, subjects: [...subjects].sort(), balances };
}

function validateCalculatedOutputAmounts(aggregate, balanceResult) {
  for (const group of aggregate.movementGroups.values()) {
    canonicalizeVccAmount(group.amount.value(), `${group.subject} ${group.currency} 单据发生额汇总`);
  }
  for (const group of aggregate.pendingGroups.values()) {
    canonicalizeVccAmount(group.flowAmount.value(), `${group.subject} Pending流水金额汇总`);
    canonicalizeVccAmount(group.pendingAmount.value(), `${group.subject} Pending金额汇总`);
  }
  for (const [key, amount] of aggregate.pendingCurrencyTotals) {
    const [subject, currency] = JSON.parse(key);
    canonicalizeVccAmount(amount.value(), `${subject} ${currency} Pending差额`);
  }
  for (const balance of balanceResult.balances) {
    for (const [field, label] of [
      ['openingBalance', '期初财务OP'],
      ['periodAmount', '当月发生额'],
      ['calculatedBalance', '当月计算财务OP'],
      ['systemBalance', '系统财务OP'],
      ['difference', '差异']
    ]) {
      canonicalizeVccAmount(
        balance[field],
        `${balance.subject} ${balance.currency} ${label}`
      );
    }
  }
}

function normalizeOpeningEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('至少需要填写一个主体的期初财务OP余额');
  }
  const seen = new Set();
  return entries.map((entry) => {
    const subject = String(entry && entry.subject || '').trim();
    if (!subject) throw new Error('期初财务OP公司主体不能为空');
    if (seen.has(subject)) throw new Error(`期初财务OP公司主体重复：${subject}`);
    seen.add(subject);
    const inputBalances = entry && entry.balances;
    if (!inputBalances || typeof inputBalances !== 'object' || Array.isArray(inputBalances)) {
      throw new Error(`${subject} 期初财务OP余额格式无效`);
    }
    const unsupported = Object.keys(inputBalances).filter((currency) => !SUPPORTED_CURRENCIES.includes(currency));
    if (unsupported.length > 0) {
      throw new Error(`${subject} 期初财务OP包含不支持币种：${unsupported.join('、')}`);
    }
    const balances = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      if (!Object.hasOwn(inputBalances, currency)) throw new Error(`${subject} 期初财务OP缺少 ${currency} 余额`);
      balances[currency] = canonicalizeVccAmount(
        inputBalances[currency],
        `${subject} ${currency} 期初财务OP`
      );
    }
    const balancesJson = JSON.stringify(balances);
    const contentHash = crypto.createHash('sha256').update(balancesJson, 'utf8').digest('hex');
    return { subject, balances, balancesJson, contentHash };
  });
}

function initializeOpeningBalances({ db, targetMonth, entries, note }) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`期初财务OP账期格式无效：${targetMonth}`);
  const normalizedNote = String(note == null ? '' : note).trim();
  if (!normalizedNote) throw new Error('期初财务OP核对说明不能为空');
  if (normalizedNote.length > 500) throw new Error('期初财务OP核对说明不能超过 500 个字符');
  const normalizedEntries = normalizeOpeningEntries(entries);

  db.exec('BEGIN IMMEDIATE');
  try {
    const preflight = preflightCalculation(db, normalizedMonth);
    if (!preflight.ok) {
      throw new Error('当前账期原表不完整、已归档或仍有未处理异常，不能初始化期初财务OP');
    }
    const aggregate = aggregateEffectiveRows(db, normalizedMonth);
    const systemSnapshots = loadSystemSnapshots(db, normalizedMonth);
    const opening = loadOpeningBalances(db, normalizedMonth);
    const subjects = new Set([
      ...aggregate.subjects,
      ...systemSnapshots.keys(),
      ...opening.balances.keys()
    ]);
    const missingSystem = [...subjects].filter((subject) => !systemSnapshots.has(subject));
    if (missingSystem.length > 0) {
      throw new Error(`以下主体缺少系统财务OP，不能初始化期初余额：${missingSystem.join('、')}`);
    }
    const missing = [...subjects].filter((subject) => !opening.balances.has(subject));
    const entryBySubject = new Map(normalizedEntries.map((entry) => [entry.subject, entry]));
    const omitted = missing.filter((subject) => !entryBySubject.has(subject));
    if (omitted.length > 0) throw new Error(`以下主体仍缺少期初财务OP：${omitted.join('、')}`);

    const initializedSubjects = [];
    const skippedSubjects = [];
    const insert = db.prepare(`
      INSERT INTO vcc_fin_op_opening_balances (
        target_month, subject, balances_json, content_hash, initialization_note
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const entry of normalizedEntries) {
      if (!subjects.has(entry.subject)) {
        throw new Error(`${entry.subject} 不属于 ${normalizedMonth} 的有效原表主体`);
      }
      if (opening.sources.get(entry.subject) === 'previous_archive') {
        throw new Error(`${entry.subject} 已有 ${opening.previousMonth} 归档余额，不允许人工初始化期初`);
      }
      const existing = db.prepare(`
        SELECT content_hash FROM vcc_fin_op_opening_balances
        WHERE target_month = ? AND subject = ?
      `).get(normalizedMonth, entry.subject);
      if (existing) {
        if (existing.content_hash !== entry.contentHash) {
          throw new Error(`${normalizedMonth} ${entry.subject} 期初财务OP已经初始化，禁止改写`);
        }
        skippedSubjects.push(entry.subject);
        continue;
      }
      insert.run(
        normalizedMonth,
        entry.subject,
        entry.balancesJson,
        entry.contentHash,
        normalizedNote
      );
      initializedSubjects.push(entry.subject);
    }
    db.exec('COMMIT');
    return {
      status: initializedSubjects.length > 0 ? 'initialized' : 'all_skipped',
      targetMonth: normalizedMonth,
      initializedSubjects,
      skippedSubjects
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function persistCalculation(db, targetMonth, revisions, aggregate, balanceResult) {
  db.prepare(`
    DELETE FROM vcc_fin_op_runs
    WHERE target_month = ? AND status = 'calculated'
  `).run(targetMonth);
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, input_revisions_json)
    VALUES (?, ?)
  `).run(targetMonth, JSON.stringify(revisions));
  const runId = Number(result.lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const group of aggregate.movementGroups.values()) {
    insertRow.run(
      runId, group.subject, 'movement', group.sourceType,
      group.categoryMajor, group.categoryMinor, group.currency, group.amount.value()
    );
  }
  for (const [key, amount] of aggregate.pendingCurrencyTotals) {
    const [subject, currency] = JSON.parse(key);
    insertRow.run(
      runId, subject, 'pending', SOURCE_TYPES.PENDING,
      '当月移除pending', '', currency, amount.value()
    );
  }

  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const balance of balanceResult.balances) {
    insertBalance.run(
      runId,
      balance.subject,
      balance.currency,
      balance.openingBalance,
      balance.periodAmount,
      balance.calculatedBalance,
      balance.systemBalance,
      balance.difference
    );
  }

  const insertPendingSummary = db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type,
      flow_amount, pending_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const group of aggregate.pendingGroups.values()) {
    insertPendingSummary.run(
      runId,
      group.subject,
      group.channelName,
      group.currencyMismatch,
      group.flowCurrency,
      group.pendingCurrency,
      group.reconType,
      group.flowAmount.value(),
      group.pendingAmount.value()
    );
  }

  const insertPendingTotal = db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, ?, ?, ?)
  `);
  for (const [key, amount] of aggregate.pendingCurrencyTotals) {
    const [subject, currency] = JSON.parse(key);
    insertPendingTotal.run(runId, subject, currency, amount.value());
  }
  return runId;
}

function calculateMonth({ db, targetMonth, expectedInputFingerprint = '' }) {
  const normalizedMonth = normalizeYearMonth(targetMonth);
  if (!normalizedMonth) throw new Error(`计算账期格式无效：${targetMonth}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const preflight = preflightCalculation(db, normalizedMonth);
    if (!preflight.ok) {
      db.exec('ROLLBACK');
      return { status: 'blocked', targetMonth: normalizedMonth, ...preflight };
    }
    if (expectedInputFingerprint && preflight.inputFingerprint !== expectedInputFingerprint) {
      db.exec('ROLLBACK');
      return {
        status: 'blocked',
        code: 'state-changed',
        targetMonth: normalizedMonth,
        message: '数据状态已变化，请刷新并重新确认。',
        datasets: preflight.datasets,
        inputFingerprint: preflight.inputFingerprint
      };
    }
    const aggregate = aggregateEffectiveRows(db, normalizedMonth);
    const systemSnapshots = loadSystemSnapshots(db, normalizedMonth);
    const openingBalances = loadOpeningBalances(db, normalizedMonth);
    const balanceResult = buildBalanceRows(aggregate, systemSnapshots, openingBalances);
    if (!balanceResult.ok) {
      db.exec('ROLLBACK');
      return {
        status: 'blocked',
        code: balanceResult.missingSystemSubjects.length > 0
          ? 'missing-system-subject'
          : 'missing-opening-balance',
        targetMonth: normalizedMonth,
        previousMonth: openingBalances.previousMonth,
        ...balanceResult
      };
    }
    validateCalculatedOutputAmounts(aggregate, balanceResult);
    const runId = persistCalculation(
      db,
      normalizedMonth,
      preflight.revisions,
      aggregate,
      balanceResult
    );
    db.exec('COMMIT');
    return {
      status: 'calculated',
      runId,
      targetMonth: normalizedMonth,
      previousMonth: openingBalances.previousMonth,
      subjects: balanceResult.subjects,
      balances: balanceResult.balances
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function currentRevisionJson(db, targetMonth) {
  return JSON.stringify(datasetSnapshot(db, targetMonth).revisions);
}

function archiveRun({ db, runId }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(runId);
    if (!run) throw new Error(`财务OP计算记录不存在：${runId}`);
    if (run.status !== 'calculated') throw new Error('该财务OP计算记录已经归档');
    if (currentRevisionJson(db, run.target_month) !== run.input_revisions_json) {
      throw new Error('计算完成后原表数据已变化，请重新运行后再归档');
    }
    if (activeImportBatches(db, run.target_month).length > 0) {
      throw new Error('当前账期仍有原表正在导入，禁止归档');
    }
    const unresolved = unresolvedImports(db, run.target_month);
    if (unresolved.length > 0) throw new Error('仍有未处理的失败导入记录，禁止归档');
    const existing = db.prepare(`
      SELECT subject FROM vcc_fin_op_archives WHERE target_month = ? LIMIT 1
    `).get(run.target_month);
    if (existing) throw new Error(`${run.target_month} 已归档，禁止重复归档`);

    const balances = db.prepare(`
      SELECT subject, currency, calculated_balance
      FROM vcc_fin_op_run_balances
      WHERE run_id = ? ORDER BY subject, currency
    `).all(runId);
    const bySubject = new Map();
    for (const row of balances) {
      if (!bySubject.has(row.subject)) bySubject.set(row.subject, {});
      bySubject.get(row.subject)[row.currency] = row.calculated_balance;
    }
    const insertArchive = db.prepare(`
      INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
      VALUES (?, ?, ?, ?)
    `);
    for (const [subject, subjectBalances] of bySubject) {
      parseBalancesJson(JSON.stringify(subjectBalances), `${run.target_month} ${subject} 计算财务OP`);
      const nextMonth = nextYearMonth(run.target_month);
      const nextOpening = db.prepare(`
        SELECT 1 FROM vcc_fin_op_opening_balances
        WHERE target_month = ? AND subject = ?
      `).get(nextMonth, subject);
      if (nextOpening) {
        throw new Error(`${nextMonth} ${subject} 已人工初始化期初余额，禁止再归档 ${run.target_month}`);
      }
      insertArchive.run(run.target_month, subject, JSON.stringify(subjectBalances), runId);
    }
    if (bySubject.size === 0) throw new Error('计算记录没有可归档的主体余额');

    db.prepare(`
      UPDATE vcc_fin_op_runs
      SET status = 'archived', archived_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(runId);
    db.prepare(`
      UPDATE vcc_fin_op_datasets
      SET data_status = 'archived', archived_run_id = ?,
          updated_at = datetime('now', 'localtime')
      WHERE target_month = ?
    `).run(runId, run.target_month);
    db.exec('COMMIT');
    return {
      status: 'archived',
      runId,
      targetMonth: run.target_month,
      subjects: [...bySubject.keys()].sort()
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    throw error;
  }
}

function getRunResult(db, runId) {
  const run = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(runId);
  if (!run) return null;
  return {
    runId: run.id,
    targetMonth: run.target_month,
    status: run.status,
    createdAt: run.created_at,
    archivedAt: run.archived_at,
    balances: db.prepare(`
      SELECT subject, currency,
             opening_balance AS openingBalance,
             period_amount AS periodAmount,
             calculated_balance AS calculatedBalance,
             system_balance AS systemBalance,
             difference
      FROM vcc_fin_op_run_balances
      WHERE run_id = ? ORDER BY subject, currency
    `).all(runId)
  };
}

module.exports = {
  REQUIRED_DETAIL_TYPES,
  REQUIRED_DATASET_TYPES,
  previousYearMonth,
  nextYearMonth,
  parseBalancesJson,
  datasetSnapshot,
  activeImportBatches,
  unresolvedImports,
  preflightCalculation,
  aggregateEffectiveRows,
  loadOpeningBalances,
  buildBalanceRows,
  validateCalculatedOutputAmounts,
  initializeOpeningBalances,
  calculateMonth,
  archiveRun,
  getRunResult
};
