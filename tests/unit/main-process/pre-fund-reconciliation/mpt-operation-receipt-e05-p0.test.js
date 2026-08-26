'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runDataStore = require('../../../../src/backend/run-data-store');
const {
  PreFundReconciliationStore
} = require('../../../../src/backend/pre-fund-reconciliation-store');
const {
  OUTCOME_KINDS,
  RECEIPTS_TABLE,
  getOperationReceipt,
  hasAnyOperationReceipts,
  insertOperationReceipt
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION;
const SOURCE_TYPE = 'MPT_INBOUND_GATEWAY';
let tempRoot;

test.beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-p0-receipt-'));
});

test.afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedBatch(db, suffix, sourceDate = '2026-07-08') {
  const sourceBatch = `MPT_INBOUND_${sourceDate.replaceAll('-', '')}_${suffix}`;
  const fileName = `MPT_INBOUND_GATEWAY_${sourceDate.replaceAll('-', '')}_${suffix}.txt`;
  db.prepare(`
    INSERT INTO pre_fund_reconciliation_gateway_batches (
      source_type, source_batch, source_date, source_file_name, source_file_sequence,
      content_hash, declared_row_count, row_count, dataset_id,
      producer_task_run_id, dataset_version, archive_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1, 1)
  `).run(
    SOURCE_TYPE,
    sourceBatch,
    sourceDate,
    fileName,
    suffix,
    'a'.repeat(64),
    `dataset-${suffix}`,
    `task-${suffix}`
  );
  return {
    id: Number(db.prepare('SELECT last_insert_rowid() AS id').get().id),
    sourceBatch,
    fileName
  };
}

function receiptPayload(batch, overrides = {}) {
  const fileIndex = overrides.fileIndex ?? 0;
  return {
    actionKey: overrides.actionKey || 'pre-fund:mpt-import',
    operationKey: overrides.operationKey || `parent-operation/file/${String(fileIndex).padStart(6, '0')}`,
    producerTaskRunId: overrides.producerTaskRunId || 'task-receipt-owner',
    fileIndex,
    outcomeKind: overrides.outcomeKind || 'inserted',
    batchId: overrides.batchId || batch.id,
    datasetId: overrides.datasetId === undefined ? 'dataset-receipt' : overrides.datasetId,
    datasetVersionBefore: overrides.datasetVersionBefore === undefined
      ? null
      : overrides.datasetVersionBefore,
    datasetVersionAfter: overrides.datasetVersionAfter === undefined
      ? 1
      : overrides.datasetVersionAfter,
    sourceFileName: batch.fileName,
    sourceSha256: overrides.sourceSha256 || 'b'.repeat(64),
    contentHash: overrides.contentHash || 'c'.repeat(64)
  };
}

function seedChildRows(db, batch) {
  db.prepare(`
    INSERT INTO pre_fund_reconciliation_gateway_rows (
      batch_id, source_type, source_batch, source_date, source_file_name,
      source_file_sequence, source_row_number, gateway_date, currency,
      amount, raw_json, fingerprint
    ) VALUES (?, ?, ?, '2026-07-08', ?, '1', 2, '2026-07-08',
              'USD', '1', '{}', ?)
  `).run(batch.id, SOURCE_TYPE, batch.sourceBatch, batch.fileName, 'f'.repeat(64));
  db.prepare(`
    INSERT INTO pre_fund_reconciliation_gateway_excluded_rows (
      batch_id, source_type, source_file_name, source_row_number, error_code,
      error_message, field_name, fields_json, raw_line
    ) VALUES (?, ?, ?, 3, 'MPT_ROW_INVALID', 'invalid', '', '[]', 'bad row')
  `).run(batch.id, SOURCE_TYPE, batch.fileName);
  db.prepare(`
    UPDATE pre_fund_reconciliation_gateway_batches SET row_count = 1 WHERE id = ?
  `).run(batch.id);
}

function insertReceiptInTransaction(db, payload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = insertOperationReceipt(db, payload);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('source-month Side DB幂等创建冻结receipt schema、唯一键、三outcome且无batch FK', () => {
  for (let index = 0; index < 2; index += 1) {
    const db = runDataStore.openSideDb(tempRoot, MODULE, '2026-07');
    db.close();
  }
  const db = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(tempRoot, MODULE, '2026-07')
  );
  try {
    const columns = db.prepare(`PRAGMA table_info('${RECEIPTS_TABLE}')`).all()
      .map((column) => [column.name, column.type, column.notnull]);
    assert.deepEqual(columns, [
      ['id', 'INTEGER', 0],
      ['action_key', 'TEXT', 1],
      ['operation_key', 'TEXT', 1],
      ['producer_task_run_id', 'TEXT', 1],
      ['file_index', 'INTEGER', 1],
      ['outcome_kind', 'TEXT', 1],
      ['batch_id', 'INTEGER', 1],
      ['dataset_id', 'TEXT', 0],
      ['dataset_version_before', 'INTEGER', 0],
      ['dataset_version_after', 'INTEGER', 0],
      ['source_file_name', 'TEXT', 1],
      ['source_sha256', 'TEXT', 1],
      ['content_hash', 'TEXT', 1],
      ['committed_at', 'TEXT', 1]
    ]);
    const uniqueIndex = db.prepare(`PRAGMA index_list('${RECEIPTS_TABLE}')`).all()
      .find((index) => index.unique === 1);
    assert.ok(uniqueIndex);
    assert.deepEqual(
      db.prepare(`PRAGMA index_info('${uniqueIndex.name}')`).all().map((column) => column.name),
      ['action_key', 'operation_key']
    );
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list('${RECEIPTS_TABLE}')`).all(), []);
    const sql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(RECEIPTS_TABLE).sql;
    assert.deepEqual(OUTCOME_KINDS, ['inserted', 'replaced', 'noop-existing-batch']);
    for (const outcome of OUTCOME_KINDS) assert.match(sql, new RegExp(`'${outcome}'`));
    assert.throws(() => db.prepare(`
      INSERT INTO ${RECEIPTS_TABLE} (
        action_key, operation_key, producer_task_run_id, file_index, outcome_kind,
        batch_id, source_file_name, source_sha256, content_hash, committed_at
      ) VALUES ('pre-fund:mpt-import', 'invalid', 'task', 0, 'noop', 1,
                'a.txt', 'a', 'b', CURRENT_TIMESTAMP)
    `).run(), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test('repository只在现有事务写receipt，三outcome唯一且exact replay幂等', () => {
  const db = runDataStore.openSideDb(tempRoot, MODULE, '2026-07');
  try {
    const batches = OUTCOME_KINDS.map((outcome, index) => ({
      outcome,
      batch: seedBatch(db, String(index + 1))
    }));
    assert.throws(
      () => insertOperationReceipt(db, receiptPayload(batches[0].batch)),
      (error) => error.code === 'PREFUND_RECEIPT_TRANSACTION_REQUIRED'
    );

    for (let index = 0; index < batches.length; index += 1) {
      const { outcome, batch } = batches[index];
      const payload = receiptPayload(batch, {
        fileIndex: index,
        outcomeKind: outcome,
        datasetVersionBefore: outcome === 'inserted' ? null : index,
        datasetVersionAfter: outcome === 'inserted' ? 1 : index
      });
      const first = insertReceiptInTransaction(db, payload);
      assert.equal(first.created, true);
      const replay = insertReceiptInTransaction(db, payload);
      assert.equal(replay.created, false);
      assert.deepEqual(replay.receipt, first.receipt);
      assert.equal(getOperationReceipt(db, payload.actionKey, payload.operationKey).outcomeKind, outcome);
    }

    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${RECEIPTS_TABLE}`).get().count, 3);
    const conflictPayload = receiptPayload(batches[0].batch, { batchId: batches[1].batch.id });
    assert.throws(
      () => insertReceiptInTransaction(db, conflictPayload),
      (error) => error.code === 'PREFUND_RECEIPT_IDENTITY_CONFLICT'
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${RECEIPTS_TABLE}`).get().count, 3);
  } finally {
    db.close();
  }
});

for (const deletion of [
  {
    name: 'deleteBatch',
    run: (store, batch) => store.deleteBatch({
      sourceType: SOURCE_TYPE,
      sourceBatch: batch.sourceBatch,
      monthKey: '2026-07'
    })
  },
  {
    name: 'deleteByDateRange',
    run: (store) => store.deleteByDateRange('2026-07-08', '2026-07-08')
  },
  {
    name: 'clearAll',
    run: (store) => store.clearAll()
  }
]) {
  test(`${deletion.name}在receipt=0时物理删库，receipt>0时只删业务batch并保留receipt`, async () => {
    const store = new PreFundReconciliationStore(tempRoot);

    const emptyReceiptDb = runDataStore.openSideDb(tempRoot, MODULE, '2026-07');
    const emptyReceiptBatch = seedBatch(emptyReceiptDb, `empty-${deletion.name}`);
    emptyReceiptDb.close();
    const emptyReceiptResult = await deletion.run(store, emptyReceiptBatch);
    assert.equal(runDataStore.sideDbExists(tempRoot, MODULE, '2026-07'), false);
    if (deletion.name === 'clearAll') {
      assert.deepEqual(emptyReceiptResult, {
        deletedFiles: 1,
        deletedBatches: 1,
        deletedRows: 0
      });
    }

    const receiptDb = runDataStore.openSideDb(tempRoot, MODULE, '2026-07');
    const receiptBatch = seedBatch(receiptDb, `receipt-${deletion.name}`);
    seedChildRows(receiptDb, receiptBatch);
    insertReceiptInTransaction(receiptDb, receiptPayload(receiptBatch));
    receiptDb.close();
    const result = await deletion.run(store, receiptBatch);
    assert.equal(runDataStore.sideDbExists(tempRoot, MODULE, '2026-07'), true);
    assert.equal(result.deletedBatches, 1);
    assert.equal(result.deletedRows, 1);
    if (Object.hasOwn(result, 'deletedFiles')) assert.equal(result.deletedFiles, 0);
    if (deletion.name === 'clearAll') {
      assert.deepEqual(result, {
        deletedFiles: 0,
        deletedBatches: 1,
        deletedRows: 1
      });
    }

    const verify = runDataStore.openExistingSideDb(
      runDataStore.sideDbPath(tempRoot, MODULE, '2026-07')
    );
    try {
      assert.equal(verify.prepare(`
        SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_batches
      `).get().count, 0);
      assert.equal(verify.prepare(`
        SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_rows
      `).get().count, 0);
      assert.equal(verify.prepare(`
        SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_excluded_rows
      `).get().count, 0);
      assert.equal(hasAnyOperationReceipts(verify), true);
      assert.equal(verify.prepare(`SELECT COUNT(*) AS count FROM ${RECEIPTS_TABLE}`).get().count, 1);
    } finally {
      verify.close();
    }
  });
}

test('旧月库没有receipt table时按receipt=0处理并维持物理删除', async () => {
  const db = runDataStore.openSideDb(tempRoot, MODULE, '2026-07');
  const batch = seedBatch(db, 'legacy-no-table');
  db.exec(`DROP TABLE ${RECEIPTS_TABLE}`);
  db.close();

  const store = new PreFundReconciliationStore(tempRoot);
  const deleted = await store.deleteBatch({
    sourceType: SOURCE_TYPE,
    sourceBatch: batch.sourceBatch,
    monthKey: '2026-07'
  });
  assert.deepEqual(deleted, { deletedBatches: 1, deletedRows: 0 });
  assert.equal(runDataStore.sideDbExists(tempRoot, MODULE, '2026-07'), false);

  const clearDb = runDataStore.openSideDb(tempRoot, MODULE, '2026-08');
  seedBatch(clearDb, 'legacy-clear', '2026-08-08');
  clearDb.exec(`DROP TABLE ${RECEIPTS_TABLE}`);
  clearDb.close();

  assert.deepEqual(await store.clearAll(), {
    deletedFiles: 1,
    deletedBatches: 1,
    deletedRows: 0
  });
  assert.equal(runDataStore.sideDbExists(tempRoot, MODULE, '2026-08'), false);
});
