'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../src/backend/database');
const legacyLinkedRepository = require('../../../src/backend/database/linked-table-repository');
const {
  ensureAdmBankDepositSupport,
  ensureReconFixOperationReceiptSupport
} = require('../../../src/backend/database/migrations');
const {
  ADM_TABLE,
  MAX_REDACTED_ID_SAMPLES,
  readAdmRowsForWriteback
} = require('../../../src/backend/database/linked-table-writeback-reader');
const receiptRepository = require('../../../src/backend/database/recon-fix-operation-receipt-repository');
const {
  RECON_FIX_JPM_ACTION,
  buildJpmNoopResult,
  buildJpmWritebackPlan
} = require('../../../src/main-process/recon-id-fix-service/jpm-writeback-plan');
const {
  commitJpmAdmMutationWithReceipt
} = require('../../../src/main-process/recon-id-fix-service/jpm-writeback-transaction');
const {
  runJpmDispatchOrderFix
} = require('../../../src/main-process/scenario-engines/jpm-dispatch-order-fix');
const { FIELD_MAP, ADM_MERCHANT_ID } = require('../../../src/constants/adm-bank-deposit-fields');

const SCENARIO = Object.freeze({
  id: 99,
  name: 'JPM调拨订单修复',
  category: 'gateway-recon-id-fix',
  config: Object.freeze({
    subCategory: 'jpm-dispatch-order-fix',
    merchantId: ADM_MERCHANT_ID
  })
});

function admRow(overrides = {}) {
  return {
    MerchantId: ADM_MERCHANT_ID,
    Currency: overrides.currency || 'USD',
    Amount: overrides.amount === undefined ? 100 : overrides.amount,
    BillDate: overrides.billDate || '2026-05-04',
    ChannelOrderNo: overrides.channelOrderNo || 'CO1',
    CustomerRef: overrides.customerRef || 'CUSTOMER-1',
    [FIELD_MAP.admBatchNo]: overrides.batchNo || '2026-05-04-CO1',
    [FIELD_MAP.admAllocationNo]: overrides.allocationNo || 'A1',
    [FIELD_MAP.admFundtransferInAmount]: overrides.fundInAmount === undefined
      ? 100
      : overrides.fundInAmount,
    [FIELD_MAP.admReconFundId]: overrides.reconFundId || '',
    [FIELD_MAP.admChannelMatched]: overrides.channelMatched === undefined
      ? 0
      : overrides.channelMatched,
    [FIELD_MAP.admGatewayMatched]: overrides.gatewayMatched === undefined
      ? 0
      : overrides.gatewayMatched
  };
}

function channelRow(overrides = {}) {
  return {
    merchantId: overrides.merchantId || ADM_MERCHANT_ID,
    reconciliationId: overrides.reconciliationId || 'RECON-E11-P0',
    receiveAmount: overrides.receiveAmount === undefined ? 100 : overrides.receiveAmount,
    additionInfo: overrides.additionInfo || 'ATS OF 26/05/04'
  };
}

function gatewayRow(overrides = {}) {
  return {
    MerchantId: overrides.merchantId || ADM_MERCHANT_ID,
    OrderId: overrides.orderId || 'A1',
    Amount: overrides.amount === undefined ? 100 : overrides.amount
  };
}

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureAdmBankDepositSupport(db);
  ensureReconFixOperationReceiptSupport(db);
  return db;
}

function seedAdm(db, rows) {
  legacyLinkedRepository.replaceAdmBankDeposit(db, rows);
}

function rawRows(db) {
  return db.prepare(`SELECT id, raw_json FROM ${ADM_TABLE} ORDER BY id ASC`).all();
}

function receiptCount(db) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ${receiptRepository.RECEIPTS_TABLE}
  `).get().count);
}

function resultIdentity(overrides = {}) {
  return {
    resultHandle: overrides.resultHandle || 'a'.repeat(64),
    boundedSummary: {
      runKind: 'jpm',
      fixedRowCount: overrides.fixedRowCount === undefined ? 1 : overrides.fixedRowCount,
      warningCount: overrides.warningCount || 0,
      unmatchedRowCount: overrides.unmatchedRowCount || 0,
      resultDigest: overrides.resultDigest || 'b'.repeat(64)
    }
  };
}

function buildPlanFromSource(source, admUpdates, operationKey = 'operation/e11-p0/001', overrides = {}) {
  return buildJpmWritebackPlan({
    operationKey,
    sourceEvidence: source,
    admUpdates,
    ...resultIdentity(overrides)
  });
}

function runEngine(source, options = {}) {
  const result = runJpmDispatchOrderFix({
    scenario: SCENARIO,
    admRows: source.rows.map((row) => row.parsed),
    sheets: {
      opponentBills: options.channelRows || [channelRow(options.channel || {})],
      businessBills: options.gatewayRows || [gatewayRow(options.gateway || {})]
    }
  });
  return result;
}

function buildMutationPlan(db, options = {}) {
  if (options.rows) seedAdm(db, options.rows);
  const source = readAdmRowsForWriteback(db);
  const result = runEngine(source, options);
  const plan = buildPlanFromSource(
    source,
    result.admUpdates,
    options.operationKey || 'operation/e11-p0/mutation',
    { fixedRowCount: result.fixedRows.length, warningCount: result.warnings.length }
  );
  return { source, result, plan };
}

function commit(db, plan, injectFault) {
  return commitJpmAdmMutationWithReceipt({
    db,
    plan,
    producerTaskRunId: 'task-run-e11-p0',
    scenarioId: String(SCENARIO.id),
    injectFault
  });
}

test('ID-aware ADM reader 以 id ASC 返回 raw_json/parsed/count/digests，legacy reader 仍独立', () => {
  const db = openDb();
  try {
    seedAdm(db, [admRow({ customerRef: 'FIRST' }), admRow({ customerRef: 'REMOVED' })]);
    db.prepare(`DELETE FROM ${ADM_TABLE} WHERE id = 2`).run();
    db.prepare(`
      INSERT INTO ${ADM_TABLE} (
        reconciliation_id, bill_date, batch_no, channel_order_no, raw_json, imported_at
      ) VALUES ('R3', '2026-05-04', 'B3', 'CO3', ?, '2026-08-28T00:00:00.000Z')
    `).run(JSON.stringify(admRow({ customerRef: 'THIRD', allocationNo: 'A3' })));

    const first = readAdmRowsForWriteback(db);
    const second = readAdmRowsForWriteback(db);
    assert.deepEqual(first.rows.map((row) => row.id), [1, 3]);
    assert.equal(first.rowCount, 2);
    assert.equal(first.rows[0].rawJsonText, rawRows(db)[0].raw_json);
    assert.equal(first.rows[0].parsed.CustomerRef, 'FIRST');
    assert.deepEqual(first.rows[0].currentMatchFlags, {
      reconciliationId: '',
      channelMatched: 0,
      gatewayMatched: 0
    });
    assert.equal(first.idSequenceDigest, second.idSequenceDigest);
    assert.equal(first.imageHash, second.imageHash);
    assert.equal(legacyLinkedRepository.readAdmBankDepositRows(db).length, 2);
  } finally {
    db.close();
  }
});

test('空 ADM image 保持零行血缘并形成 exact noop', () => {
  const db = openDb();
  try {
    const source = readAdmRowsForWriteback(db);
    assert.equal(source.rowCount, 0);
    assert.deepEqual(source.rows, []);
    assert.match(source.idSequenceDigest, /^[a-f0-9]{64}$/);
    assert.match(source.imageHash, /^[a-f0-9]{64}$/);

    const plan = buildPlanFromSource(source, [], 'operation/e11-p0/empty', {
      fixedRowCount: 0
    });
    assert.equal(plan.outcome, 'noop');
    assert.equal(plan.changedRowCount, 0);
    assert.equal(plan.preImageHash, plan.expectedPostImageHash);
    assert.equal(buildJpmNoopResult(plan).resultKind, 'noop');
    assert.equal(receiptCount(db), 0);
  } finally {
    db.close();
  }
});

test('ID-aware reader 对全部坏 JSON hard fail，错误只含有限脱敏 id token 且不回传 raw_json', () => {
  const db = openDb();
  try {
    seedAdm(db, Array.from({ length: 7 }, (_, index) => admRow({ customerRef: `ACCOUNT-${index}` })));
    db.prepare(`UPDATE ${ADM_TABLE} SET raw_json = ?`).run('{"account":"622202-secret"');
    db.prepare(`UPDATE ${ADM_TABLE} SET raw_json = ? WHERE id = 1`).run('{"account":1,"account":2}');
    assert.throws(
      () => readAdmRowsForWriteback(db),
      (error) => {
        assert.equal(error.code, 'ADM_RAW_JSON_CORRUPTED');
        assert.equal(error.corruptedRowCount, 7);
        assert.equal(error.redactedIdSamples.length, MAX_REDACTED_ID_SAMPLES);
        assert.ok(error.redactedIdSamples.every((sample) => /^adm-id:[a-f0-9]{12}$/.test(sample)));
        assert.doesNotMatch(JSON.stringify({
          message: error.message,
          samples: error.redactedIdSamples
        }), /622202|secret|raw_json.*\{/);
        return true;
      }
    );
    assert.equal(legacyLinkedRepository.readAdmBankDepositRows(db).length, 1,
      'legacy live reader 仍跳语法坏行并接受重复 key；本 PR 未改写其线上语义');
  } finally {
    db.close();
  }
});

test('pure plan 用 source object identity 绑定 exact id，engine mutation 只允许三个 writeback 字段', () => {
  const db = openDb();
  try {
    const { source, result, plan } = buildMutationPlan(db, {
      rows: [admRow({ allocationNo: 'A1' }), admRow({ allocationNo: 'A2', customerRef: 'SECOND' })],
      gatewayRows: [gatewayRow({ orderId: 'A1' }), gatewayRow({ orderId: 'A2' })],
      channel: { receiveAmount: 200 }
    });
    assert.equal(plan.outcome, 'mutation-required');
    assert.equal(plan.rowCount, 2);
    assert.equal(plan.changedRowCount, 2);
    assert.deepEqual(plan.changedRows.map((row) => row.id), source.rows.map((row) => row.id));
    for (let index = 0; index < result.admUpdates.length; index += 1) {
      assert.strictEqual(result.admUpdates[index], source.rows[index].parsed);
    }
    assert.ok(plan.changedRows.every((row) =>
      row.expectedPost[FIELD_MAP.admReconFundId] === 'RECON-E11-P0' &&
      row.expectedPost[FIELD_MAP.admChannelMatched] === 1 &&
      row.expectedPost[FIELD_MAP.admGatewayMatched] === 1));
    assert.ok(plan.changedRows.every((row) => row.expectedPost.Currency === 'USD'));
  } finally {
    db.close();
  }
});

test('plan 拒绝 engine 重排、外来 row、非 writeback 字段变化和 candidate 泄漏输入', () => {
  const cases = [
    {
      code: 'RECON_FIX_JPM_ID_SEQUENCE_CHANGED',
      mutate(source) {
        return [source.rows[1].parsed, source.rows[0].parsed];
      }
    },
    {
      code: 'RECON_FIX_JPM_ROW_IDENTITY_CHANGED',
      mutate(source) {
        return [structuredClone(source.rows[0].parsed), source.rows[1].parsed];
      }
    },
    {
      code: 'RECON_FIX_JPM_FIELD_SCOPE_VIOLATION',
      mutate(source) {
        source.rows[0].parsed.Currency = 'EUR';
        return source.rows.map((row) => row.parsed);
      }
    }
  ];

  for (const [index, entry] of cases.entries()) {
    const db = openDb();
    try {
      seedAdm(db, [admRow(), admRow({ allocationNo: 'A2', customerRef: 'SECOND' })]);
      const source = readAdmRowsForWriteback(db);
      assert.throws(
        () => buildPlanFromSource(source, entry.mutate(source), `operation/reject/${index}`),
        (error) => error.code === entry.code
      );
    } finally {
      db.close();
    }
  }

  const db = openDb();
  try {
    seedAdm(db, [admRow()]);
    const source = readAdmRowsForWriteback(db);
    assert.throws(
      () => buildJpmWritebackPlan({
        operationKey: 'operation/reject/private-candidate',
        sourceEvidence: source,
        admUpdates: source.rows.map((row) => row.parsed),
        ...resultIdentity(),
        resultCandidate: { fixedRows: [{ account: 'sensitive' }] }
      }),
      (error) => error.code === 'RECON_FIX_JPM_PLAN_INPUT_INVALID'
    );
  } finally {
    db.close();
  }
});

test('exact noop 只返回 bounded handle/summary，transaction primitive 在触碰 DB 前拒绝', () => {
  const db = openDb();
  try {
    seedAdm(db, [admRow({ reconFundId: 'KEEP', channelMatched: 1, gatewayMatched: 1 })]);
    const source = readAdmRowsForWriteback(db);
    const result = runEngine(source, {
      channel: { merchantId: 'different-merchant' },
      gatewayRows: []
    });
    const plan = buildPlanFromSource(source, result.admUpdates, 'operation/e11-p0/noop', {
      fixedRowCount: result.fixedRows.length,
      warningCount: result.warnings.length
    });
    assert.equal(plan.outcome, 'noop');
    assert.equal(plan.changedRowCount, 0);
    assert.equal(plan.preImageHash, plan.expectedPostImageHash);

    const publicResult = buildJpmNoopResult(plan);
    assert.deepEqual(Object.keys(publicResult).sort(), [
      'boundedSummary',
      'resultHandle',
      'resultKind'
    ]);
    assert.equal(publicResult.resultKind, 'noop');
    assert.equal(Object.hasOwn(publicResult, 'changedRows'), false);
    assert.equal(Object.hasOwn(publicResult, 'operationKey'), false);

    let dbTouched = 0;
    assert.throws(
      () => commitJpmAdmMutationWithReceipt({
        plan,
        db: {
          exec() { dbTouched += 1; },
          prepare() { dbTouched += 1; }
        },
        producerTaskRunId: 'must-not-read',
        scenarioId: 'must-not-read'
      }),
      (error) => error.code === 'RECON_FIX_JPM_NOOP_TRANSACTION_FORBIDDEN'
    );
    assert.equal(dbTouched, 0);
    assert.equal(receiptCount(db), 0);
  } finally {
    db.close();
  }
});

test('receipt migration 幂等、AppDatabase restart 可见，repository 强制同事务且字段 exact', (t) => {
  const db = openDb();
  try {
    ensureReconFixOperationReceiptSupport(db);
    ensureReconFixOperationReceiptSupport(db);
    const columns = db.prepare(`PRAGMA table_info('${receiptRepository.RECEIPTS_TABLE}')`).all();
    assert.deepEqual(columns.map((column) => column.name), [
      'action_key',
      'operation_key',
      'producer_task_run_id',
      'scenario_id',
      'pre_image_hash',
      'post_image_hash',
      'id_sequence_digest',
      'row_count',
      'changed_row_count',
      'committed_at'
    ]);
    assert.deepEqual(columns.filter((column) => column.pk > 0).map((column) => column.name), [
      'action_key',
      'operation_key'
    ]);
    assert.throws(
      () => receiptRepository.insertOperationReceipt(db, {
        actionKey: RECON_FIX_JPM_ACTION,
        operationKey: 'operation/outside-transaction',
        producerTaskRunId: 'task',
        scenarioId: '99',
        preImageHash: '1'.repeat(64),
        postImageHash: '2'.repeat(64),
        idSequenceDigest: '3'.repeat(64),
        rowCount: 1,
        changedRowCount: 1
      }),
      (error) => error.code === 'RECON_FIX_RECEIPT_TRANSACTION_REQUIRED'
    );
  } finally {
    db.close();
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-fix-e11-p0-migration-'));
  const dbPath = path.join(tempRoot, 'tool-data.sqlite');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  for (let index = 0; index < 2; index += 1) {
    const appDb = new AppDatabase(dbPath);
    try {
      appDb.init();
      assert.equal(receiptRepository.hasOperationReceiptTable(appDb.db), true);
    } finally {
      appDb.close();
    }
  }
});

test('mutation primitive 在同一 BEGIN IMMEDIATE 按 exact id 更新并写唯一 receipt', () => {
  const db = openDb();
  try {
    const { plan } = buildMutationPlan(db, {
      rows: [
        admRow({ allocationNo: 'A1', fundInAmount: 60 }),
        admRow({ allocationNo: 'A2', customerRef: 'SECOND', fundInAmount: 40 })
      ],
      gatewayRows: [gatewayRow({ orderId: 'A1' }), gatewayRow({ orderId: 'A2' })]
    });
    const receipt = commit(db, plan);
    assert.equal(receipt.actionKey, RECON_FIX_JPM_ACTION);
    assert.equal(receipt.operationKey, plan.operationKey);
    assert.equal(receipt.preImageHash, plan.preImageHash);
    assert.equal(receipt.postImageHash, plan.expectedPostImageHash);
    assert.equal(receipt.idSequenceDigest, plan.idSequenceDigest);
    assert.equal(receipt.rowCount, 2);
    assert.equal(receipt.changedRowCount, 2);
    assert.equal(receiptCount(db), 1);
    const current = readAdmRowsForWriteback(db);
    assert.equal(current.imageHash, plan.expectedPostImageHash);
    assert.deepEqual(current.rows.map((row) => row.parsed[FIELD_MAP.admReconFundId]), [
      'RECON-E11-P0',
      'RECON-E11-P0'
    ]);
    assert.deepEqual(current.rows.map((row) => row.parsed.Currency), ['USD', 'USD']);
    assert.deepEqual(current.rows.map((row) => row.parsed[FIELD_MAP.admFundtransferInAmount]), [60, 40]);
  } finally {
    db.close();
  }
});

test('mutation primitive 对有缺口的 DB id 仍按 exact id 写回，不按数组下标猜行', () => {
  const db = openDb();
  try {
    seedAdm(db, [
      admRow({ allocationNo: 'A1', fundInAmount: 60 }),
      admRow({ allocationNo: 'REMOVED', customerRef: 'REMOVED', fundInAmount: 999 }),
      admRow({ allocationNo: 'A3', customerRef: 'THIRD', fundInAmount: 40 })
    ]);
    db.prepare(`DELETE FROM ${ADM_TABLE} WHERE id = 2`).run();
    const source = readAdmRowsForWriteback(db);
    const result = runEngine(source, {
      gatewayRows: [gatewayRow({ orderId: 'A1' }), gatewayRow({ orderId: 'A3' })]
    });
    const plan = buildPlanFromSource(source, result.admUpdates, 'operation/e11-p0/id-gap', {
      fixedRowCount: result.fixedRows.length,
      warningCount: result.warnings.length
    });
    assert.deepEqual(plan.changedRows.map((row) => row.id), [1, 3]);
    commit(db, plan);
    assert.deepEqual(rawRows(db).map((row) => row.id), [1, 3]);
    assert.deepEqual(readAdmRowsForWriteback(db).rows.map((row) =>
      row.parsed[FIELD_MAP.admReconFundId]), ['RECON-E11-P0', 'RECON-E11-P0']);
  } finally {
    db.close();
  }
});

for (const staleCase of [
  {
    name: 'rowCount',
    code: 'RECON_FIX_JPM_ROW_COUNT_CHANGED',
    mutate(db) {
      db.prepare(`
        INSERT INTO ${ADM_TABLE} (
          reconciliation_id, bill_date, batch_no, channel_order_no, raw_json, imported_at
        ) VALUES ('EXTRA', '2026-05-05', 'EXTRA', 'EXTRA', ?, '2026-08-28T00:00:00.000Z')
      `).run(JSON.stringify(admRow({ billDate: '2026-05-05', allocationNo: 'EXTRA' })));
    }
  },
  {
    name: 'id/order with same count',
    code: 'RECON_FIX_JPM_ID_SEQUENCE_CHANGED',
    mutate(db) {
      const old = db.prepare(`SELECT raw_json FROM ${ADM_TABLE} ORDER BY id ASC LIMIT 1`).get();
      db.prepare(`DELETE FROM ${ADM_TABLE} WHERE id = (SELECT MIN(id) FROM ${ADM_TABLE})`).run();
      db.prepare(`
        INSERT INTO ${ADM_TABLE} (
          reconciliation_id, bill_date, batch_no, channel_order_no, raw_json, imported_at
        ) VALUES ('REPLACED', '2026-05-04', 'REPLACED', 'REPLACED', ?, '2026-08-28T00:00:00.000Z')
      `).run(old.raw_json);
    }
  },
  {
    name: 'preimage',
    code: 'RECON_FIX_JPM_PREIMAGE_CHANGED',
    mutate(db) {
      const row = db.prepare(`SELECT id, raw_json FROM ${ADM_TABLE} ORDER BY id ASC LIMIT 1`).get();
      const parsed = JSON.parse(row.raw_json);
      parsed.Currency = 'EUR';
      db.prepare(`UPDATE ${ADM_TABLE} SET raw_json = ? WHERE id = ?`).run(JSON.stringify(parsed), row.id);
    }
  }
]) {
  test(`transaction 对 ${staleCase.name} 变化 fail closed 且不写 receipt`, () => {
    const db = openDb();
    try {
      const { plan } = buildMutationPlan(db, { rows: [admRow()] });
      staleCase.mutate(db);
      assert.throws(() => commit(db, plan), (error) => error.code === staleCase.code);
      assert.equal(receiptCount(db), 0);
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
  });
}

for (const stage of ['after-updates', 'after-receipt-insert']) {
  test(`故障注入 ${stage}：ADM mutation 与 receipt 一起 rollback`, () => {
    const db = openDb();
    try {
      const { plan } = buildMutationPlan(db, { rows: [admRow()] });
      const before = rawRows(db);
      assert.throws(
        () => commit(db, plan, (currentStage) => {
          if (currentStage === stage) throw new Error(`injected:${stage}`);
        }),
        new RegExp(`injected:${stage}`)
      );
      assert.deepEqual(rawRows(db), before);
      assert.equal(receiptCount(db), 0);
      assert.equal(db.isTransaction, false);
    } finally {
      db.close();
    }
  });
}

test('before-commit seam 改写 ADM 时最终权威回读阻止 COMMIT 并回滚 receipt', () => {
  const db = openDb();
  try {
    const { plan } = buildMutationPlan(db, { rows: [admRow()] });
    const before = rawRows(db);
    assert.throws(
      () => commit(db, plan, (stage) => {
        if (stage !== 'before-commit') return;
        db.prepare(`UPDATE ${ADM_TABLE} SET raw_json = ?`).run('{"tampered":true}');
      }),
      (error) => error.code === 'RECON_FIX_JPM_POSTIMAGE_MISMATCH'
    );
    assert.deepEqual(rawRows(db), before);
    assert.equal(receiptCount(db), 0);
  } finally {
    db.close();
  }
});

test('before-commit seam 改写 receipt 时最终权威回读阻止 COMMIT 并回滚 ADM', () => {
  const db = openDb();
  try {
    const { plan } = buildMutationPlan(db, { rows: [admRow()] });
    const before = rawRows(db);
    assert.throws(
      () => commit(db, plan, (stage) => {
        if (stage !== 'before-commit') return;
        db.prepare(`
          UPDATE ${receiptRepository.RECEIPTS_TABLE}
          SET producer_task_run_id = 'tampered-task'
          WHERE action_key = ? AND operation_key = ?
        `).run(plan.actionKey, plan.operationKey);
      }),
      (error) => error.code === 'RECON_FIX_RECEIPT_IDENTITY_CONFLICT'
    );
    assert.deepEqual(rawRows(db), before);
    assert.equal(receiptCount(db), 0);
  } finally {
    db.close();
  }
});

test('事务内 trigger 改变未计划行时 postimage 校验失败并整体 rollback', () => {
  const db = openDb();
  try {
    const { plan } = buildMutationPlan(db, {
      rows: [
        admRow({ allocationNo: 'A1' }),
        admRow({
          billDate: '2026-05-05',
          batchNo: '2026-05-05-CO2',
          channelOrderNo: 'CO2',
          allocationNo: 'A2',
          customerRef: 'SECOND'
        })
      ]
    });
    assert.equal(plan.changedRowCount, 1);
    const before = rawRows(db);
    db.exec(`
      CREATE TRIGGER tamper_unplanned_adm_row
      AFTER UPDATE ON ${ADM_TABLE}
      BEGIN
        UPDATE ${ADM_TABLE}
        SET raw_json = '{"tampered":true}'
        WHERE id <> NEW.id;
      END;
    `);
    assert.throws(
      () => commit(db, plan),
      (error) => error.code === 'RECON_FIX_JPM_POSTIMAGE_MISMATCH'
    );
    assert.deepEqual(rawRows(db), before);
    assert.equal(receiptCount(db), 0);
  } finally {
    db.close();
  }
});

test('已有 receipt 时 mutation primitive 不猜 replay，fail closed 且不改 ADM', () => {
  const db = openDb();
  try {
    const { plan } = buildMutationPlan(db, { rows: [admRow()] });
    db.exec('BEGIN IMMEDIATE');
    receiptRepository.insertOperationReceipt(db, {
      actionKey: plan.actionKey,
      operationKey: plan.operationKey,
      producerTaskRunId: 'prior-task',
      scenarioId: String(SCENARIO.id),
      preImageHash: plan.preImageHash,
      postImageHash: plan.expectedPostImageHash,
      idSequenceDigest: plan.idSequenceDigest,
      rowCount: plan.rowCount,
      changedRowCount: plan.changedRowCount
    });
    db.exec('COMMIT');
    const before = rawRows(db);
    assert.throws(
      () => commit(db, plan),
      (error) => error.code === 'RECON_FIX_RECEIPT_ALREADY_EXISTS'
    );
    assert.deepEqual(rawRows(db), before);
    assert.equal(receiptCount(db), 1);
  } finally {
    db.close();
  }
});

test('E11-P0 不注册 JPM managed/critical/inspector/recovery 入口，readonly production 继续关闭', () => {
  const policies = require('../../../src/main-process/recon-id-fix-service/policies');
  assert.deepEqual(
    policies.RECON_FIX_READONLY_POLICIES.map((policy) => policy.actionKey),
    ['recon-fix:import', 'recon-fix:run-readonly']
  );
  assert.ok(policies.RECON_FIX_READONLY_POLICIES.every((policy) =>
    policy.production.enabled === false && policy.production.effectiveMode === 'legacy'));
  const canonicalPolicy = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
  ), 'utf8')).actions[RECON_FIX_JPM_ACTION];
  assert.equal(canonicalPolicy.production.enabled, false);
  assert.equal(canonicalPolicy.production.effectiveMode, 'legacy');
  assert.equal(canonicalPolicy.production.effectiveWorkerCount, 0);
  const sourceFiles = [
    'src/main-process/recon-id-fix-service/jpm-writeback-plan.js',
    'src/main-process/recon-id-fix-service/jpm-writeback-transaction.js',
    'src/backend/database/linked-table-writeback-reader.js',
    'src/backend/database/recon-fix-operation-receipt-repository.js'
  ].map((relative) => fs.readFileSync(path.resolve(__dirname, '../../..', relative), 'utf8')).join('\n');
  assert.doesNotMatch(sourceFiles, /critical:ready|critical:ack|commit:receipt/);
  assert.doesNotMatch(sourceFiles, /inspector-registry|RecoveryHold|startup-recovery/);
});
