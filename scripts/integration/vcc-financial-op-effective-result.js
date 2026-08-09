// VCC 财务OP生效结果金额累计集成测试。
//
// 覆盖：真实文件 SQLite 持久化后读取基础行/不可变 adjustment 抵消链；
// sequence、result_revision、九币种与 archived 事实保持只读；真正最终溢出结构化失败且零部分 DTO/零账本改写。
//
// 用法：node scripts/integration/vcc-financial-op-effective-result.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../src/backend/vcc-financial-op-db/migrations');
const {
  buildRunRowKey,
  getEffectiveRunResult
} = require('../../src/backend/vcc-financial-op/result-adjustments');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../src/backend/vcc-financial-op/definitions');

const MAX_VCC_AMOUNT = '999999999999999';
let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, actual, expected });
}

function assertTrue(condition, label) {
  assertEq(Boolean(condition), true, label);
}

function movementRow(categoryMinor) {
  return {
    rowKind: 'movement',
    subject: 'PPHK',
    sourceType: SOURCE_TYPES.RECHARGE,
    categoryMajor: '充值',
    categoryMinor
  };
}

function insertRun(db, targetMonth, status, resultRevision) {
  return Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, updated_at, archived_at
    ) VALUES (?, ?, '{"integration":1}', ?, 'integration-fingerprint',
              '2026-08-09 10:00:00', ?)
  `).run(
    targetMonth,
    status,
    resultRevision,
    status === 'archived' ? '2026-08-09 11:00:00' : null
  ).lastInsertRowid);
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

function insertBalanceSubject(db, runId, overrides = {}) {
  const insert = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, 'PPHK', ?, ?, ?, ?, ?, ?)
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
      currency,
      values.opening,
      values.period,
      values.calculated,
      values.system,
      values.difference
    );
  }
}

function insertAdjustment(db, runId, row, currency, amount, sequence) {
  db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence,
      created_app_version, created_build_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '集成测试人工核对', ?, '3.1.8', 'integration-sha')
  `).run(
    runId,
    buildRunRowKey(row),
    row.subject,
    row.sourceType,
    row.categoryMajor,
    row.categoryMinor,
    currency,
    amount,
    sequence
  );
}

function snapshotRun(db, runId) {
  return {
    run: db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(runId),
    rows: db.prepare(`
      SELECT * FROM vcc_fin_op_run_rows WHERE run_id = ? ORDER BY id
    `).all(runId),
    balances: db.prepare(`
      SELECT * FROM vcc_fin_op_run_balances
      WHERE run_id = ? ORDER BY subject, currency
    `).all(runId),
    adjustments: db.prepare(`
      SELECT * FROM vcc_fin_op_run_adjustments
      WHERE run_id = ? ORDER BY sequence, id
    `).all(runId),
    archives: db.prepare(`
      SELECT * FROM vcc_fin_op_archives WHERE run_id = ? ORDER BY subject
    `).all(runId)
  };
}

function run() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-effective-result-'));
  const dbPath = path.join(tempDirectory, 'vcc-effective.sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    ensureVccFinancialOpTablesSupport(db);

    const archivedRunId = insertRun(db, '2026-06', 'archived', 3);
    const chainRows = [movementRow('CHAIN-A'), movementRow('CHAIN-B'), movementRow('CHAIN-C')];
    const chainAmounts = [MAX_VCC_AMOUNT, '1', '-1'];
    for (let index = 0; index < chainRows.length; index += 1) {
      insertRunRow(db, archivedRunId, chainRows[index], 'USD', chainAmounts[index]);
      insertRunRow(db, archivedRunId, chainRows[index], 'JPY', '0');
      insertAdjustment(
        db,
        archivedRunId,
        chainRows[index],
        'JPY',
        chainAmounts[index],
        index + 1
      );
    }
    insertBalanceSubject(db, archivedRunId, {
      USD: {
        period: MAX_VCC_AMOUNT,
        calculated: MAX_VCC_AMOUNT,
        system: MAX_VCC_AMOUNT,
        difference: '0'
      }
    });
    const archiveBalances = Object.fromEntries(
      SUPPORTED_CURRENCIES.map((currency) => [
        currency,
        ['USD', 'JPY'].includes(currency) ? MAX_VCC_AMOUNT : '0'
      ])
    );
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
      VALUES ('2026-06', 'PPHK', ?, ?)
    `).run(JSON.stringify(archiveBalances), archivedRunId);

    db.close();
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    const archivedBefore = snapshotRun(db, archivedRunId);
    const result = getEffectiveRunResult(db, archivedRunId);
    const usd = result.balances.find((row) => row.currency === 'USD');
    const jpy = result.balances.find((row) => row.currency === 'JPY');

    assertEq(result.run.status, 'archived', '归档 run 状态保持 archived');
    assertEq(result.run.resultRevision, 3, 'result_revision 与三条 adjustment 一致');
    assertEq(result.adjustments.map((row) => row.sequence), [1, 2, 3], 'sequence 保持 1..3');
    assertEq(result.balances.length, SUPPORTED_CURRENCIES.length, '完整返回九币种余额');
    assertEq(usd.basePeriodAmount, MAX_VCC_AMOUNT, '基础行越界中间态抵消后保留最终合法值');
    assertEq(usd.effectivePeriodAmount, MAX_VCC_AMOUNT, 'USD 生效发生额保持最终合法值');
    assertEq(jpy.adjustmentAmount, MAX_VCC_AMOUNT, 'adjustment 越界中间态抵消后保留最终合法值');
    assertEq(jpy.effectivePeriodAmount, MAX_VCC_AMOUNT, 'JPY 生效发生额包含最终 adjustment');
    assertTrue(result.balances.every((row) => (
      typeof row.effectivePeriodAmount === 'string'
      && typeof row.effectiveCalculatedBalance === 'string'
      && typeof row.effectiveDifference === 'string'
    )), '全部生效金额保持定点字符串');
    assertEq(snapshotRun(db, archivedRunId), archivedBefore, 'reader 不改归档/基础/adjustment 事实');

    const overflowRunId = insertRun(db, '2026-07', 'calculated', 1);
    const overflowBase = movementRow('OVERFLOW-BASE');
    const overflowAdjustment = movementRow('OVERFLOW-ADJUSTMENT');
    insertRunRow(db, overflowRunId, overflowBase, 'USD', MAX_VCC_AMOUNT);
    insertRunRow(db, overflowRunId, overflowAdjustment, 'USD', '0');
    insertBalanceSubject(db, overflowRunId, {
      USD: {
        period: MAX_VCC_AMOUNT,
        calculated: MAX_VCC_AMOUNT,
        system: MAX_VCC_AMOUNT,
        difference: '0'
      }
    });
    insertAdjustment(db, overflowRunId, overflowAdjustment, 'USD', '1', 1);
    const overflowBefore = snapshotRun(db, overflowRunId);
    let overflowDto;
    let overflowError;
    try {
      overflowDto = getEffectiveRunResult(db, overflowRunId);
    } catch (error) {
      overflowError = error;
    }

    assertEq(overflowDto, undefined, '最终溢出不返回部分 DTO');
    assertTrue(Boolean(overflowError), '最终溢出 fail-closed 抛错');
    assertEq(overflowError && overflowError.code, 'result-amount-out-of-range', '最终溢出 code 稳定');
    assertEq(overflowError && overflowError.scope, 'balance', '最终溢出 scope 指向 balance');
    assertEq(overflowError && overflowError.field, 'effectivePeriodAmount', '最终溢出 field 明确');
    assertEq(
      [overflowError && overflowError.subject, overflowError && overflowError.currency],
      ['PPHK', 'USD'],
      '最终溢出包含主体/币种坐标'
    );
    assertEq(overflowError && overflowError.value, '1000000000000000', '错误金额为十进制字符串');
    assertEq(overflowError && overflowError.context, {
      runId: overflowRunId,
      scope: 'balance',
      subject: 'PPHK',
      currency: 'USD',
      field: 'effectivePeriodAmount',
      value: '1000000000000000',
      reason: overflowError && overflowError.message
    }, '最终溢出 context 为可序列化完整坐标');
    assertEq(snapshotRun(db, overflowRunId), overflowBefore, '最终溢出不改 run/ledger');
  } catch (error) {
    failed += 1;
    failures.push({
      label: '集成链运行抛错',
      actual: String(error && error.stack ? error.stack : error),
      expected: '无未断言异常'
    });
  } finally {
    try { if (db) db.close(); } catch (_error) { /* ignore cleanup error */ }
    try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  }

  const total = passed + failed;
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`  - ${failure.label}: actual=${JSON.stringify(failure.actual)} expected=${JSON.stringify(failure.expected)}`);
    }
    console.log(`${passed}/${total} PASS`);
    process.exitCode = 1;
    return;
  }
  console.log(`${passed}/${total} PASS`);
}

run();
