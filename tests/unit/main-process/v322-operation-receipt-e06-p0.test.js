'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runDataStore = require('../../../src/backend/run-data-store');
const duplicateReceipts = require(
  '../../../src/main-process/duplicate-inbound-match/operation-receipt-repository'
);
const bankBuReceipts = require(
  '../../../src/main-process/bank-bu-worker/operation-receipt-repository'
);
const {
  DuplicateInboundMatchStore
} = require('../../../src/backend/duplicate-inbound-match-store');

let tempRoot;

test.beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v322-e06-p0-receipt-'));
});

test.afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function insertInTransaction(db, repository, payload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = repository.insertOperationReceipt(db, payload);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function primaryKeyColumns(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all()
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function duplicatePayload(overrides = {}) {
  const actionKey = overrides.actionKey || 'duplicate:import';
  const isRun = actionKey === 'duplicate:run';
  return {
    actionKey,
    operationKey: overrides.operationKey || `task/duplicate/${isRun ? 'run' : 'import'}`,
    producerTaskRunId: overrides.producerTaskRunId || 'task-duplicate-owner',
    phase: overrides.phase || (isRun ? 'run-side-committed' : 'import-side-committed'),
    monthKey: overrides.monthKey || '2026-08',
    importBundleId: overrides.importBundleId || 11,
    sideRunId: overrides.sideRunId === undefined ? (isRun ? 21 : null) : overrides.sideRunId,
    inputEvidenceHash: overrides.inputEvidenceHash || 'a'.repeat(64)
  };
}

function bankBuPayload(overrides = {}) {
  const actionKey = overrides.actionKey || 'bank-bu:import-month';
  const isRun = actionKey === 'bank-bu:run';
  return {
    actionKey,
    operationKey: overrides.operationKey || `task/bank-bu/${isRun ? 'run' : 'import'}`,
    producerTaskRunId: overrides.producerTaskRunId || 'task-bank-bu-owner',
    operationKind: overrides.operationKind || (isRun ? 'run' : 'import'),
    yearMonth: overrides.yearMonth || '2026-08',
    sideRunId: overrides.sideRunId === undefined ? (isRun ? 31 : null) : overrides.sideRunId,
    inputEvidenceHash: overrides.inputEvidenceHash || 'b'.repeat(64)
  };
}

test('旧Duplicate月库重复open时幂等补齐side receipt schema且不绑定可删除业务行', () => {
  const first = runDataStore.openSideDb(
    tempRoot,
    runDataStore.MODULE_DUPLICATE_INBOUND_MATCH,
    '2026-08'
  );
  first.exec(`DROP TABLE ${duplicateReceipts.RECEIPTS_TABLE}`);
  first.close();

  for (let index = 0; index < 2; index += 1) {
    runDataStore.openSideDb(
      tempRoot,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH,
      '2026-08'
    ).close();
  }
  const db = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    tempRoot,
    runDataStore.MODULE_DUPLICATE_INBOUND_MATCH,
    '2026-08'
  ));
  try {
    assert.equal(duplicateReceipts.hasOperationReceiptTable(db), true);
    assert.deepEqual(
      db.prepare(`PRAGMA table_info('${duplicateReceipts.RECEIPTS_TABLE}')`).all()
        .map((column) => column.name),
      [
        'action_key', 'operation_key', 'producer_task_run_id', 'phase', 'month_key',
        'import_bundle_id', 'side_run_id', 'input_evidence_hash', 'committed_at'
      ]
    );
    assert.deepEqual(primaryKeyColumns(db, duplicateReceipts.RECEIPTS_TABLE), [
      'action_key', 'operation_key'
    ]);
    assert.deepEqual(db.prepare(
      `PRAGMA foreign_key_list('${duplicateReceipts.RECEIPTS_TABLE}')`
    ).all(), []);
    const sql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(duplicateReceipts.RECEIPTS_TABLE).sql;
    for (const phase of duplicateReceipts.PHASES) assert.match(sql, new RegExp(`'${phase}'`));
  } finally {
    db.close();
  }
});

test('Duplicate receipt要求同事务、exact replay幂等且identity冲突fail closed', () => {
  const db = runDataStore.openSideDb(
    tempRoot,
    runDataStore.MODULE_DUPLICATE_INBOUND_MATCH,
    '2026-08'
  );
  try {
    const importPayload = duplicatePayload();
    assert.throws(
      () => duplicateReceipts.insertOperationReceipt(db, importPayload),
      (error) => error.code === 'DUPLICATE_RECEIPT_TRANSACTION_REQUIRED'
    );
    const created = insertInTransaction(db, duplicateReceipts, importPayload);
    assert.equal(created.created, true);
    assert.deepEqual(
      duplicateReceipts.normalizeExactOperationReceipt(created.receipt),
      created.receipt
    );
    const replay = insertInTransaction(db, duplicateReceipts, importPayload);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.receipt, created.receipt);

    assert.throws(
      () => insertInTransaction(db, duplicateReceipts, duplicatePayload({
        inputEvidenceHash: 'c'.repeat(64)
      })),
      (error) => error.code === 'DUPLICATE_RECEIPT_IDENTITY_CONFLICT'
    );
    const runReceipt = insertInTransaction(db, duplicateReceipts, duplicatePayload({
      actionKey: 'duplicate:run'
    }));
    assert.equal(runReceipt.receipt.sideRunId, 21);
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS count FROM ${duplicateReceipts.RECEIPTS_TABLE}`
    ).get().count, 2);

    assert.throws(() => duplicateReceipts.normalizeReceiptPayload(duplicatePayload({
      phase: 'run-side-committed'
    })), /action\/phase/);
    assert.throws(() => duplicateReceipts.normalizeReceiptPayload(duplicatePayload({
      actionKey: 'duplicate:run',
      sideRunId: null
    })), /sideRunId/);
    assert.throws(() => duplicateReceipts.normalizeReceiptPayload(duplicatePayload({
      operationKey: 123
    })), /operationKey/);
  } finally {
    db.close();
  }
});

test('旧BankBU月库重复open时幂等补齐TechDoc冻结receipt schema', () => {
  const first = runDataStore.openSideDb(tempRoot, runDataStore.MODULE_BANK_BU, '2026-08');
  first.exec(`DROP TABLE ${bankBuReceipts.RECEIPTS_TABLE}`);
  first.close();

  for (let index = 0; index < 2; index += 1) {
    runDataStore.openSideDb(tempRoot, runDataStore.MODULE_BANK_BU, '2026-08').close();
  }
  const db = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    tempRoot,
    runDataStore.MODULE_BANK_BU,
    '2026-08'
  ));
  try {
    assert.equal(bankBuReceipts.hasOperationReceiptTable(db), true);
    assert.deepEqual(
      db.prepare(`PRAGMA table_info('${bankBuReceipts.RECEIPTS_TABLE}')`).all()
        .map((column) => column.name),
      [
        'action_key', 'operation_key', 'producer_task_run_id', 'operation_kind',
        'year_month', 'side_run_id', 'input_evidence_hash', 'committed_at'
      ]
    );
    assert.deepEqual(primaryKeyColumns(db, bankBuReceipts.RECEIPTS_TABLE), [
      'action_key', 'operation_key'
    ]);
    assert.deepEqual(db.prepare(
      `PRAGMA foreign_key_list('${bankBuReceipts.RECEIPTS_TABLE}')`
    ).all(), []);
  } finally {
    db.close();
  }
});

test('BankBU receipt要求同事务并冻结import/run side identity', () => {
  const db = runDataStore.openSideDb(tempRoot, runDataStore.MODULE_BANK_BU, '2026-08');
  try {
    const importPayload = bankBuPayload();
    assert.throws(
      () => bankBuReceipts.insertOperationReceipt(db, importPayload),
      (error) => error.code === 'BANK_BU_RECEIPT_TRANSACTION_REQUIRED'
    );
    const created = insertInTransaction(db, bankBuReceipts, importPayload);
    assert.equal(created.created, true);
    assert.deepEqual(bankBuReceipts.normalizeExactOperationReceipt(created.receipt), created.receipt);
    assert.equal(insertInTransaction(db, bankBuReceipts, importPayload).created, false);

    assert.throws(
      () => insertInTransaction(db, bankBuReceipts, bankBuPayload({
        producerTaskRunId: 'different-task'
      })),
      (error) => error.code === 'BANK_BU_RECEIPT_IDENTITY_CONFLICT'
    );
    const runReceipt = insertInTransaction(db, bankBuReceipts, bankBuPayload({
      actionKey: 'bank-bu:run'
    }));
    assert.equal(runReceipt.receipt.operationKind, 'run');
    assert.equal(runReceipt.receipt.sideRunId, 31);
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS count FROM ${bankBuReceipts.RECEIPTS_TABLE}`
    ).get().count, 2);

    assert.throws(() => bankBuReceipts.normalizeReceiptPayload(bankBuPayload({
      operationKind: 'run'
    })), /operationKind/);
    assert.throws(() => bankBuReceipts.normalizeReceiptPayload(bankBuPayload({
      actionKey: 'bank-bu:run',
      sideRunId: null
    })), /sideRunId/);
    assert.throws(() => bankBuReceipts.normalizeReceiptPayload(bankBuPayload({
      producerTaskRunId: 456
    })), /producerTaskRunId/);
  } finally {
    db.close();
  }
});

test('receipt payload验证拒绝Proxy/getter且不触发副作用', () => {
  let getterCalls = 0;
  const getterPayload = duplicatePayload();
  Object.defineProperty(getterPayload, 'operationKey', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'task/duplicate/import';
    }
  });
  let proxyGets = 0;
  const proxyPayload = new Proxy(bankBuPayload(), {
    get(target, key, receiver) {
      proxyGets += 1;
      return Reflect.get(target, key, receiver);
    }
  });

  assert.throws(
    () => duplicateReceipts.normalizeReceiptPayload(getterPayload),
    /enumerable own data property/
  );
  assert.throws(
    () => bankBuReceipts.normalizeReceiptPayload(proxyPayload),
    /non-Proxy/
  );
  assert.equal(getterCalls, 0);
  assert.equal(proxyGets, 0);
});

test('Duplicate import/run receipt writer故障与side mutation同事务回滚', async () => {
  const injectedReceipts = {
    insertOperationReceipt() {
      throw Object.assign(new Error('injected receipt failure'), {
        code: 'INJECTED_DUPLICATE_RECEIPT_FAILURE'
      });
    }
  };
  const store = new DuplicateInboundMatchStore(tempRoot, {
    operationReceipts: injectedReceipts
  });
  await assert.rejects(() => store.createImportBundle({
    monthKey: '2026-08',
    bank: { fileName: 'bank.xlsx', contentHash: 'a'.repeat(64), rows: [] },
    document: { fileName: 'document.xlsx', contentHash: 'b'.repeat(64) },
    writeDocumentRows: async () => ({
      rowCount: 0, matchableRowCount: 0, emptyBusinessOrderCount: 0
    }),
    operationReceipt: duplicatePayload({ importBundleId: 1 })
  }), (error) => error.code === 'INJECTED_DUPLICATE_RECEIPT_FAILURE');
  const db = runDataStore.openSideDb(
    tempRoot, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, '2026-08'
  );
  try {
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM duplicate_inbound_match_imports'
    ).get().count, 0);
    const importId = Number(db.prepare(`
      INSERT INTO duplicate_inbound_match_imports (
        bank_file_name, bank_content_hash, bank_row_count,
        document_file_name, document_content_hash, document_row_count,
        document_matchable_row_count, document_empty_order_count
      ) VALUES ('bank.xlsx', ?, 0, 'document.xlsx', ?, 0, 0, 0)
    `).run('a'.repeat(64), 'b'.repeat(64)).lastInsertRowid);
    const runId = Number(db.prepare(`
      INSERT INTO duplicate_inbound_match_runs (
        import_id, snapshot_json, snapshot_hash, status
      ) VALUES (?, '{}', ?, 'running')
    `).run(importId, 'c'.repeat(64)).lastInsertRowid);
    db.close();
    assert.throws(() => store.finishRun({
      monthKey: '2026-08',
      runId,
      summary: {
        mailRowCount: 1,
        manualRowCount: 0,
        auditGroupCount: 1,
        finalSuccessGroupCount: 1,
        manualGroupCount: 0
      },
      mailRows: [{ sourceOrdinal: 0, output: { BizId: 'sensitive' } }],
      manualRows: [],
      auditRows: [{
        groupOrder: 0,
        disposition: 'success',
        reasonCodes: [],
        bankLineage: [],
        mptLineage: [],
        documentLineage: []
      }],
      operationReceipt: duplicatePayload({
        actionKey: 'duplicate:run', importBundleId: importId, sideRunId: runId
      })
    }), (error) => error.code === 'INJECTED_DUPLICATE_RECEIPT_FAILURE');
    const verify = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
      tempRoot, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, '2026-08'
    ));
    try {
      const rolledBackRun = verify.prepare(
        'SELECT status, result_digest FROM duplicate_inbound_match_runs WHERE id = ?'
      ).get(runId);
      assert.equal(rolledBackRun.status, 'running');
      assert.equal(rolledBackRun.result_digest, null);
      assert.equal(verify.prepare(
        'SELECT COUNT(*) AS count FROM duplicate_inbound_match_mail_rows WHERE run_id = ?'
      ).get(runId).count, 0);
      assert.equal(verify.prepare(
        'SELECT COUNT(*) AS count FROM duplicate_inbound_match_group_audits WHERE run_id = ?'
      ).get(runId).count, 0);
      assert.equal(verify.prepare(
        `SELECT COUNT(*) AS count FROM ${duplicateReceipts.RECEIPTS_TABLE}`
      ).get().count, 0);
    } finally {
      verify.close();
    }
  } finally {
    if (db.isOpen) db.close();
  }
});
