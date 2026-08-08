'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  buildRunRowKey,
  getEffectiveRunResult
} = require('../../../../src/backend/vcc-financial-op/result-adjustments');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  serializeError,
  deserializeError
} = require('../../../../src/main-process/serialize-error');

const RECHARGE_ROW = Object.freeze({
  rowKind: 'movement',
  subject: 'PPHK',
  sourceType: SOURCE_TYPES.RECHARGE,
  categoryMajor: '充值',
  categoryMinor: 'OPS'
});
const PENDING_ROW = Object.freeze({
  rowKind: 'pending',
  subject: 'PPHK',
  sourceType: SOURCE_TYPES.PENDING,
  categoryMajor: '当月移除pending',
  categoryMinor: ''
});
const MAX_VCC_AMOUNT = '999999999999999';

function movementRow(categoryMinor) {
  return Object.freeze({
    ...RECHARGE_ROW,
    categoryMinor
  });
}

function createDb(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  t.after(() => db.close());
  return db;
}

function insertRunRow(db, runId, row, currency, amount) {
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    row.subject,
    row.rowKind,
    row.sourceType,
    row.categoryMajor,
    row.categoryMinor,
    currency,
    amount
  );
}

function insertBalanceSubject(db, runId, subject, opening = '100', periodAmounts = {}) {
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const period = periodAmounts[currency] || '0';
    const calculated = currency === 'USD'
      ? (period === '10' ? '110' : opening)
      : (currency === 'EUR' && period === '5' ? '105' : opening);
    const system = subject === 'PPHK'
      ? (currency === 'USD' ? '112' : (currency === 'EUR' ? '104' : '100'))
      : opening;
    const difference = subject === 'PPHK'
      ? (currency === 'USD' ? '2' : (currency === 'EUR' ? '-1' : '0'))
      : '0';
    insert.run(runId, subject, currency, opening, period, calculated, system, difference);
  }
}

function insertExactBalanceSubject(db, runId, subject, overrides = {}) {
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const currency of SUPPORTED_CURRENCIES) {
    const values = {
      opening: '0',
      period: '0',
      calculated: '0',
      system: '0',
      difference: '0',
      ...(overrides[currency] || {})
    };
    insert.run(
      runId,
      subject,
      currency,
      values.opening,
      values.period,
      values.calculated,
      values.system,
      values.difference
    );
  }
}

function insertRun(db, {
  targetMonth = '2026-06',
  status = 'calculated',
  resultRevision = 0
} = {}) {
  return Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json,
      result_revision, input_fingerprint, updated_at, archived_at
    ) VALUES (?, ?, '{"fixture":1}', ?, 'fixture-fingerprint',
              '2026-07-01 10:00:00', ?)
  `).run(
    targetMonth,
    status,
    resultRevision,
    status === 'archived' ? '2026-07-01 11:00:00' : null
  ).lastInsertRowid);
}

function seedBaseRun(db, { includeRows = true, includeBalances = true } = {}) {
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json,
      result_revision, input_fingerprint, updated_at
    ) VALUES ('2026-06', 'calculated', '{"fixture":1}', 0, 'fixture-fingerprint',
              '2026-07-01 10:00:00')
  `).run().lastInsertRowid);
  if (includeRows) {
    insertRunRow(db, runId, RECHARGE_ROW, 'USD', '10');
    insertRunRow(db, runId, RECHARGE_ROW, 'EUR', '2');
    insertRunRow(db, runId, PENDING_ROW, 'EUR', '3');
  }
  if (includeBalances) {
    insertBalanceSubject(db, runId, 'PPHK', '100', { USD: '10', EUR: '5' });
  }
  return runId;
}

function insertAdjustment(db, runId, rowKey, metadata, {
  currency,
  amount,
  sequence,
  reason = '人工核对差异'
}) {
  return Number(db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence,
      created_app_version, created_build_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '3.1.8', 'fixture-sha')
  `).run(
    runId,
    rowKey,
    metadata.subject,
    metadata.sourceType,
    metadata.categoryMajor,
    metadata.categoryMinor,
    currency,
    amount,
    reason,
    sequence
  ).lastInsertRowid);
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('期望函数抛错');
}

function tableSnapshot(db, runId) {
  return {
    run: { ...db.prepare(`
      SELECT * FROM vcc_fin_op_runs WHERE id = ?
    `).get(runId) },
    rows: db.prepare(`
      SELECT * FROM vcc_fin_op_run_rows WHERE run_id = ? ORDER BY id
    `).all(runId).map((row) => ({ ...row })),
    balances: db.prepare(`
      SELECT * FROM vcc_fin_op_run_balances
      WHERE run_id = ? ORDER BY subject, currency
    `).all(runId).map((row) => ({ ...row })),
    adjustments: db.prepare(`
      SELECT * FROM vcc_fin_op_run_adjustments
      WHERE run_id = ? ORDER BY sequence, id
    `).all(runId).map((row) => ({ ...row })),
    archives: db.prepare(`
      SELECT * FROM vcc_fin_op_archives
      WHERE run_id = ? ORDER BY subject
    `).all(runId).map((row) => ({ ...row }))
  };
}

test('rowKey 严格使用 v1 元数据元组，跨币种稳定且不受金额/run/id/顺序影响', () => {
  const expected = 'v1:a5207f2df099372a6c3620c35d214a9db7bfdecfabc803a8f79e89de7ce9d8b6';
  assert.equal(buildRunRowKey(RECHARGE_ROW), expected);
  assert.equal(buildRunRowKey({
    id: 999,
    runId: 12,
    amount: '-123.45',
    currency: 'JPY',
    displayOrder: 100,
    ...RECHARGE_ROW
  }), expected);
  assert.equal(buildRunRowKey({
    ...RECHARGE_ROW,
    currency: 'USD'
  }), buildRunRowKey({
    ...RECHARGE_ROW,
    currency: 'EUR'
  }));
  assert.notEqual(buildRunRowKey({
    ...RECHARGE_ROW,
    categoryMinor: 'OTHER'
  }), expected);
  assert.match(buildRunRowKey({
    ...RECHARGE_ROW,
    categoryMajor: '',
    categoryMinor: ''
  }), /^v1:[a-f0-9]{64}$/);
});

test('effective result 按主体币种叠加正负调整并保持基础结果不可变', (t) => {
  const db = createDb(t);
  const runId = seedBaseRun(db);
  insertBalanceSubject(db, runId, 'NO-MOVEMENT', '50');
  const rechargeKey = buildRunRowKey(RECHARGE_ROW);
  const pendingKey = buildRunRowKey(PENDING_ROW);
  insertAdjustment(db, runId, rechargeKey, RECHARGE_ROW, {
    currency: 'USD', amount: '-2', sequence: 1
  });
  insertAdjustment(db, runId, rechargeKey, RECHARGE_ROW, {
    currency: 'JPY', amount: '5', sequence: 2
  });
  insertAdjustment(db, runId, pendingKey, PENDING_ROW, {
    currency: 'EUR', amount: '1', sequence: 3
  });
  db.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 3 WHERE id = ?`).run(runId);
  const before = tableSnapshot(db, runId);

  const result = getEffectiveRunResult(db, runId);

  assert.equal(result.run.resultRevision, 3);
  assert.equal(result.run.inputFingerprint, 'fixture-fingerprint');
  assert.equal(result.baseRows.length, 3);
  assert.equal(result.adjustments.length, 3);
  assert.equal(result.effectiveRows.length, 4);
  const addedCurrency = result.effectiveRows.find((row) => (
    row.rowKey === rechargeKey && row.currency === 'JPY'
  ));
  assert.deepEqual(
    {
      baseAmount: addedCurrency.baseAmount,
      adjustmentAmount: addedCurrency.adjustmentAmount,
      effectiveAmount: addedCurrency.effectiveAmount
    },
    { baseAmount: '0', adjustmentAmount: '5', effectiveAmount: '5' }
  );
  const byCurrency = Object.fromEntries(
    result.balances
      .filter((row) => row.subject === 'PPHK')
      .map((row) => [row.currency, row])
  );
  assert.deepEqual(
    {
      adjustment: byCurrency.USD.adjustmentAmount,
      period: byCurrency.USD.effectivePeriodAmount,
      calculated: byCurrency.USD.effectiveCalculatedBalance,
      difference: byCurrency.USD.effectiveDifference
    },
    { adjustment: '-2', period: '8', calculated: '108', difference: '4' }
  );
  assert.deepEqual(
    {
      adjustment: byCurrency.EUR.adjustmentAmount,
      period: byCurrency.EUR.effectivePeriodAmount,
      calculated: byCurrency.EUR.effectiveCalculatedBalance,
      difference: byCurrency.EUR.effectiveDifference
    },
    { adjustment: '1', period: '6', calculated: '106', difference: '-2' }
  );
  assert.deepEqual(
    {
      adjustment: byCurrency.JPY.adjustmentAmount,
      period: byCurrency.JPY.effectivePeriodAmount,
      calculated: byCurrency.JPY.effectiveCalculatedBalance,
      difference: byCurrency.JPY.effectiveDifference
    },
    { adjustment: '5', period: '5', calculated: '105', difference: '-5' }
  );
  assert.equal(
    result.balances.find((row) => row.subject === 'NO-MOVEMENT' && row.currency === 'USD')
      .effectivePeriodAmount,
    '0'
  );
  assert.deepEqual(tableSnapshot(db, runId), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.effectiveRows), true);
});

test('effective result 基础行先越过 15 位再抵消时按最终发生额通过，且归档事实只读', (t) => {
  const db = createDb(t);
  const runId = insertRun(db, { status: 'archived' });
  const rows = [movementRow('BASE-A'), movementRow('BASE-B'), movementRow('BASE-C')];
  insertRunRow(db, runId, rows[0], 'USD', MAX_VCC_AMOUNT);
  insertRunRow(db, runId, rows[1], 'USD', '1');
  insertRunRow(db, runId, rows[2], 'USD', '-1');
  insertExactBalanceSubject(db, runId, 'PPHK', {
    USD: {
      period: MAX_VCC_AMOUNT,
      calculated: MAX_VCC_AMOUNT,
      system: MAX_VCC_AMOUNT,
      difference: '0'
    }
  });
  const archivedBalances = Object.fromEntries(
    SUPPORTED_CURRENCIES.map((currency) => [
      currency,
      currency === 'USD' ? MAX_VCC_AMOUNT : '0'
    ])
  );
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
    VALUES ('2026-06', 'PPHK', ?, ?)
  `).run(JSON.stringify(archivedBalances), runId);
  const before = tableSnapshot(db, runId);

  const result = getEffectiveRunResult(db, runId);

  assert.equal(result.run.status, 'archived');
  assert.equal(result.run.resultRevision, 0);
  assert.equal(result.balances.length, SUPPORTED_CURRENCIES.length);
  const usd = result.balances.find((row) => row.currency === 'USD');
  assert.equal(usd.basePeriodAmount, MAX_VCC_AMOUNT);
  assert.equal(usd.effectivePeriodAmount, MAX_VCC_AMOUNT);
  assert.equal(usd.effectiveCalculatedBalance, MAX_VCC_AMOUNT);
  assert.deepEqual(tableSnapshot(db, runId), before);
});

test('effective result adjustment 抵消链只在最终汇总执行 15 位校验', (t) => {
  const db = createDb(t);
  const runId = insertRun(db, { resultRevision: 3 });
  const rows = [movementRow('ADJ-A'), movementRow('ADJ-B'), movementRow('ADJ-C')];
  for (const row of rows) insertRunRow(db, runId, row, 'JPY', '0');
  insertExactBalanceSubject(db, runId, 'PPHK');
  insertAdjustment(db, runId, buildRunRowKey(rows[0]), rows[0], {
    currency: 'JPY', amount: MAX_VCC_AMOUNT, sequence: 1
  });
  insertAdjustment(db, runId, buildRunRowKey(rows[1]), rows[1], {
    currency: 'JPY', amount: '1', sequence: 2
  });
  insertAdjustment(db, runId, buildRunRowKey(rows[2]), rows[2], {
    currency: 'JPY', amount: '-1', sequence: 3
  });
  const before = tableSnapshot(db, runId);

  const result = getEffectiveRunResult(db, runId);

  assert.equal(result.run.resultRevision, 3);
  assert.deepEqual(result.adjustments.map((row) => row.sequence), [1, 2, 3]);
  assert.equal(result.balances.length, SUPPORTED_CURRENCIES.length);
  const jpy = result.balances.find((row) => row.currency === 'JPY');
  assert.equal(jpy.adjustmentAmount, MAX_VCC_AMOUNT);
  assert.equal(jpy.effectivePeriodAmount, MAX_VCC_AMOUNT);
  assert.equal(jpy.effectiveDifference, `-${MAX_VCC_AMOUNT}`);
  assert.deepEqual(tableSnapshot(db, runId), before);
});

test('effective result 对真正溢出的基础/adjustment 最终汇总返回稳定坐标错误且不改账本', (t) => {
  const baseDb = createDb(t);
  const baseRunId = insertRun(baseDb);
  const baseRows = [movementRow('OVERFLOW-BASE-A'), movementRow('OVERFLOW-BASE-B')];
  insertRunRow(baseDb, baseRunId, baseRows[0], 'USD', MAX_VCC_AMOUNT);
  insertRunRow(baseDb, baseRunId, baseRows[1], 'USD', '1');
  insertExactBalanceSubject(baseDb, baseRunId, 'PPHK');
  const baseBefore = tableSnapshot(baseDb, baseRunId);
  let baseDto;
  const baseError = captureError(() => {
    baseDto = getEffectiveRunResult(baseDb, baseRunId);
  });
  assert.equal(baseDto, undefined);
  assert.deepEqual(
    {
      code: baseError.code,
      scope: baseError.scope,
      summaryType: baseError.summaryType,
      field: baseError.field,
      subject: baseError.subject,
      currency: baseError.currency,
      value: baseError.value
    },
    {
      code: 'result-amount-out-of-range',
      scope: 'summary',
      summaryType: 'base-period',
      field: 'basePeriodAmount',
      subject: 'PPHK',
      currency: 'USD',
      value: '1000000000000000'
    }
  );
  assert.deepEqual(tableSnapshot(baseDb, baseRunId), baseBefore);

  const adjustmentDb = createDb(t);
  const adjustmentRunId = insertRun(adjustmentDb, { resultRevision: 2 });
  const adjustmentRows = [movementRow('OVERFLOW-ADJ-A'), movementRow('OVERFLOW-ADJ-B')];
  for (const row of adjustmentRows) insertRunRow(adjustmentDb, adjustmentRunId, row, 'USD', '0');
  insertExactBalanceSubject(adjustmentDb, adjustmentRunId, 'PPHK');
  insertAdjustment(
    adjustmentDb,
    adjustmentRunId,
    buildRunRowKey(adjustmentRows[0]),
    adjustmentRows[0],
    { currency: 'USD', amount: MAX_VCC_AMOUNT, sequence: 1 }
  );
  insertAdjustment(
    adjustmentDb,
    adjustmentRunId,
    buildRunRowKey(adjustmentRows[1]),
    adjustmentRows[1],
    { currency: 'USD', amount: '1', sequence: 2 }
  );
  const adjustmentBefore = tableSnapshot(adjustmentDb, adjustmentRunId);
  let adjustmentDto;
  const adjustmentError = captureError(() => {
    adjustmentDto = getEffectiveRunResult(adjustmentDb, adjustmentRunId);
  });
  assert.equal(adjustmentDto, undefined);
  assert.deepEqual(
    {
      code: adjustmentError.code,
      scope: adjustmentError.scope,
      summaryType: adjustmentError.summaryType,
      field: adjustmentError.field,
      subject: adjustmentError.subject,
      currency: adjustmentError.currency,
      value: adjustmentError.value
    },
    {
      code: 'result-amount-out-of-range',
      scope: 'summary',
      summaryType: 'adjustment-total',
      field: 'adjustmentAmount',
      subject: 'PPHK',
      currency: 'USD',
      value: '1000000000000000'
    }
  );
  assert.deepEqual(tableSnapshot(adjustmentDb, adjustmentRunId), adjustmentBefore);
});

test('effective result 对基础加调整的真正最终溢出返回 rowKey/字段上下文且不返回部分 DTO', (t) => {
  const db = createDb(t);
  const runId = insertRun(db, { resultRevision: 1 });
  const row = movementRow('OVERFLOW-EFFECTIVE');
  const rowKey = buildRunRowKey(row);
  insertRunRow(db, runId, row, 'USD', MAX_VCC_AMOUNT);
  insertExactBalanceSubject(db, runId, 'PPHK', {
    USD: {
      period: MAX_VCC_AMOUNT,
      calculated: MAX_VCC_AMOUNT,
      system: MAX_VCC_AMOUNT,
      difference: '0'
    }
  });
  insertAdjustment(db, runId, rowKey, row, {
    currency: 'USD', amount: '1', sequence: 1
  });
  const before = tableSnapshot(db, runId);
  let dto;

  const error = captureError(() => {
    dto = getEffectiveRunResult(db, runId);
  });

  assert.equal(dto, undefined);
  assert.deepEqual(
    {
      code: error.code,
      scope: error.scope,
      field: error.field,
      rowKey: error.rowKey,
      subject: error.subject,
      currency: error.currency,
      value: error.value
    },
    {
      code: 'result-amount-out-of-range',
      scope: 'row',
      field: 'effectiveAmount',
      rowKey,
      subject: 'PPHK',
      currency: 'USD',
      value: '1000000000000000'
    }
  );
  const restoredError = deserializeError(serializeError(error));
  assert.equal(restoredError.code, 'result-amount-out-of-range');
  assert.deepEqual(restoredError.context, {
    runId,
    scope: 'row',
    rowKey,
    subject: 'PPHK',
    currency: 'USD',
    field: 'effectiveAmount',
    value: '1000000000000000',
    reason: error.message
  });
  assert.deepEqual(tableSnapshot(db, runId), before);
});

test('effective result 对跨结果行的生效发生额溢出返回 balance 字段上下文', (t) => {
  const db = createDb(t);
  const runId = insertRun(db, { resultRevision: 1 });
  const baseRow = movementRow('EFFECTIVE-BALANCE-BASE');
  const adjustmentRow = movementRow('EFFECTIVE-BALANCE-ADJ');
  insertRunRow(db, runId, baseRow, 'USD', MAX_VCC_AMOUNT);
  insertRunRow(db, runId, adjustmentRow, 'USD', '0');
  insertExactBalanceSubject(db, runId, 'PPHK', {
    USD: {
      period: MAX_VCC_AMOUNT,
      calculated: MAX_VCC_AMOUNT,
      system: MAX_VCC_AMOUNT,
      difference: '0'
    }
  });
  insertAdjustment(db, runId, buildRunRowKey(adjustmentRow), adjustmentRow, {
    currency: 'USD', amount: '1', sequence: 1
  });
  const before = tableSnapshot(db, runId);

  const error = captureError(() => getEffectiveRunResult(db, runId));

  assert.deepEqual(
    {
      code: error.code,
      scope: error.scope,
      field: error.field,
      subject: error.subject,
      currency: error.currency,
      value: error.value
    },
    {
      code: 'result-amount-out-of-range',
      scope: 'balance',
      field: 'effectivePeriodAmount',
      subject: 'PPHK',
      currency: 'USD',
      value: '1000000000000000'
    }
  );
  assert.deepEqual(tableSnapshot(db, runId), before);
});

test('effective result 对 adjustment sequence 与 result_revision 事实不一致 fail-closed', (t) => {
  const gapDb = createDb(t);
  const gapRunId = seedBaseRun(gapDb);
  insertAdjustment(gapDb, gapRunId, buildRunRowKey(RECHARGE_ROW), RECHARGE_ROW, {
    currency: 'USD', amount: '1', sequence: 2
  });
  gapDb.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`).run(gapRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(gapDb, gapRunId),
    'adjustment-sequence-inconsistent'
  );

  const revisionDb = createDb(t);
  const revisionRunId = seedBaseRun(revisionDb);
  insertAdjustment(
    revisionDb,
    revisionRunId,
    buildRunRowKey(RECHARGE_ROW),
    RECHARGE_ROW,
    { currency: 'USD', amount: '1', sequence: 1 }
  );
  assertThrowsCode(
    () => getEffectiveRunResult(revisionDb, revisionRunId),
    'result-revision-inconsistent'
  );
});

test('effective result 拒绝伪造调整元数据、不支持币种与非规范金额', (t) => {
  const rowKeyDb = createDb(t);
  const rowKeyRunId = seedBaseRun(rowKeyDb);
  insertAdjustment(
    rowKeyDb,
    rowKeyRunId,
    `v1:${'0'.repeat(64)}`,
    RECHARGE_ROW,
    { currency: 'USD', amount: '1', sequence: 1 }
  );
  rowKeyDb.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`)
    .run(rowKeyRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(rowKeyDb, rowKeyRunId),
    'invalid-adjustment-target'
  );

  const metadataDb = createDb(t);
  const metadataRunId = seedBaseRun(metadataDb);
  insertAdjustment(
    metadataDb,
    metadataRunId,
    buildRunRowKey(RECHARGE_ROW),
    { ...RECHARGE_ROW, subject: 'FORGED' },
    { currency: 'USD', amount: '1', sequence: 1 }
  );
  metadataDb.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`)
    .run(metadataRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(metadataDb, metadataRunId),
    'invalid-adjustment-metadata'
  );

  const currencyDb = createDb(t);
  const currencyRunId = seedBaseRun(currencyDb);
  insertAdjustment(
    currencyDb,
    currencyRunId,
    buildRunRowKey(RECHARGE_ROW),
    RECHARGE_ROW,
    { currency: 'ZZZ', amount: '1', sequence: 1 }
  );
  currencyDb.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`)
    .run(currencyRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(currencyDb, currencyRunId),
    'invalid-adjustment-currency'
  );

  const amountDb = createDb(t);
  const amountRunId = seedBaseRun(amountDb);
  insertAdjustment(
    amountDb,
    amountRunId,
    buildRunRowKey(RECHARGE_ROW),
    RECHARGE_ROW,
    { currency: 'USD', amount: '1.00', sequence: 1 }
  );
  amountDb.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`)
    .run(amountRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(amountDb, amountRunId),
    'invalid-adjustment-amount'
  );
});

test('effective result 表驱动拒绝零值、三位小数、非有限值与超有效数字金额', (t) => {
  for (const amount of ['0', '1.234', 'NaN', 'Infinity', '9999999999999999']) {
    const db = createDb(t);
    const runId = seedBaseRun(db);
    insertAdjustment(
      db,
      runId,
      buildRunRowKey(RECHARGE_ROW),
      RECHARGE_ROW,
      { currency: 'USD', amount, sequence: 1 }
    );
    db.prepare(`UPDATE vcc_fin_op_runs SET result_revision = 1 WHERE id = ?`).run(runId);
    assertThrowsCode(
      () => getEffectiveRunResult(db, runId),
      'invalid-adjustment-amount'
    );
  }
});

test('effective result 拒绝未知来源和重复基础 rowKey + currency', (t) => {
  const sourceDb = createDb(t);
  const sourceRunId = seedBaseRun(sourceDb);
  sourceDb.prepare(`
    UPDATE vcc_fin_op_run_rows SET source_type = 'unknown'
    WHERE run_id = ? AND currency = 'USD'
  `).run(sourceRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(sourceDb, sourceRunId),
    'invalid-run-row-source-type'
  );

  const collisionDb = createDb(t);
  const collisionRunId = seedBaseRun(collisionDb);
  insertRunRow(collisionDb, collisionRunId, RECHARGE_ROW, 'USD', '1');
  assertThrowsCode(
    () => getEffectiveRunResult(collisionDb, collisionRunId),
    'run-row-key-collision'
  );
});

test('effective result 拒绝基础行与余额坐标脱节及空基础事实', (t) => {
  const detachedDb = createDb(t);
  const detachedRunId = seedBaseRun(detachedDb);
  detachedDb.prepare(`
    DELETE FROM vcc_fin_op_run_balances
    WHERE run_id = ? AND subject = 'PPHK' AND currency = 'USD'
  `).run(detachedRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(detachedDb, detachedRunId),
    'run-base-balance-coordinate-missing'
  );

  const emptyRowsDb = createDb(t);
  const emptyRowsRunId = seedBaseRun(emptyRowsDb, { includeRows: false });
  assertThrowsCode(
    () => getEffectiveRunResult(emptyRowsDb, emptyRowsRunId),
    'run-base-rows-empty'
  );

  const emptyBalancesDb = createDb(t);
  const emptyBalancesRunId = seedBaseRun(emptyBalancesDb, { includeBalances: false });
  assertThrowsCode(
    () => getEffectiveRunResult(emptyBalancesDb, emptyBalancesRunId),
    'run-balances-empty'
  );
});

test('effective result 拒绝基础余额公式或基础发生额汇总被篡改', (t) => {
  const periodDb = createDb(t);
  const periodRunId = seedBaseRun(periodDb);
  periodDb.prepare(`
    UPDATE vcc_fin_op_run_balances SET period_amount = '11'
    WHERE run_id = ? AND subject = 'PPHK' AND currency = 'USD'
  `).run(periodRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(periodDb, periodRunId),
    'run-base-period-mismatch'
  );

  const formulaDb = createDb(t);
  const formulaRunId = seedBaseRun(formulaDb);
  formulaDb.prepare(`
    UPDATE vcc_fin_op_run_balances SET difference = '3'
    WHERE run_id = ? AND subject = 'PPHK' AND currency = 'USD'
  `).run(formulaRunId);
  assertThrowsCode(
    () => getEffectiveRunResult(formulaDb, formulaRunId),
    'run-base-balance-mismatch'
  );
});

test('effective result 对不存在 run 返回 null，并拒绝无效 run id', (t) => {
  const db = createDb(t);
  assert.equal(getEffectiveRunResult(db, 999), null);
  assertThrowsCode(() => getEffectiveRunResult(db, 0), 'invalid-run-id');
});
