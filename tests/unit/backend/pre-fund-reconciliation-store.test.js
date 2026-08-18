'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../src/backend/run-data-store');
const {
  PreFundReconciliationStore,
} = require('../../../src/backend/pre-fund-reconciliation-store');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND,
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-schema');

const MODULE = runDataStore.MODULE_PRE_FUND_RECONCILIATION;
let tmpdir;

test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-store-test-'));
});
test.afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.prototype.hasOwnProperty.call(overrides, field) ? overrides[field] : '');
}

function inboundRow(overrides = {}) {
  return valuesFor(INBOUND_FIELDS, {
    batchNo: 'MPT_INBOUND_20260708', billDate: '2026-07-08', channel: 'CITI', merchantId: 'M1',
    tradeType: 'Inbound-VA', orderId: 'OI-1', reconId: 'RI-1', billReconId: 'BI-1',
    currency: 'USD', originAmount: '10.00', fee: '0', amount: '10.00', payerName: 'PAYER',
    payerAccount: 'CARD-I', valueDate: '2026-07-08', bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03', tradeScope: 'INBOUND', realChannel: 'REAL-I',
    clearingNetwork: 'SWIFT', ...overrides,
  });
}

function outboundRow(overrides = {}) {
  return valuesFor(OUTBOUND_FIELDS, {
    batchNo: 'MPT_OUTBOUND_20260707', billDate: '2026-07-07', tradeType: 'WITHDRAW',
    orderNo: 'OO-1', billReconId: 'BO-1', reconId: 'RO-1', name: 'PAYEE', cardNo: 'CARD-O',
    originCurrency: 'USD', targetCurrency: 'USD', originAmount: '8', fee: '0', originNetAmount: '8',
    targetAmount: '8', createTime: '2026-07-07 01:02:03', finishTime: '2026-07-07 01:03:04',
    channel: 'CITI', merchantId: 'M2', tradeScope: 'OUTBOUND', bankDebitCurrency: 'EUR',
    bankDebitAmount: '7.5', realChannel: 'REAL-O', clearingNetwork: 'SWIFT', ...overrides,
  });
}

function writeFixture(fileName, header, rows, options = {}) {
  const text = `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`;
  const filePath = path.join(tmpdir, fileName);
  fs.writeFileSync(filePath, options.gzip || fileName.endsWith('.gz')
    ? zlib.gzipSync(Buffer.from(text, 'utf8'))
    : text);
  return filePath;
}

test('run-data-store 注册临时 MPT 模块并建立批次/明细/错误审计表', () => {
  assert.ok(runDataStore.KNOWN_MODULES.includes(MODULE));
  const db = runDataStore.openSideDb(tmpdir, MODULE, '2026-07');
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'pre_fund_reconciliation_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      'pre_fund_reconciliation_gateway_batches',
      'pre_fund_reconciliation_gateway_excluded_rows',
      'pre_fund_reconciliation_gateway_rows'
    ]);
    const fks = db.prepare("PRAGMA foreign_key_list('pre_fund_reconciliation_gateway_rows')").all();
    assert.equal(fks.length, 1);
    assert.equal(fks[0].on_delete, 'CASCADE');
  } finally {
    db.close();
  }
});

test('旧月侧库 listBatches 先 additive migrate 并回填 v0 UUID，首次导入继续可用', async () => {
  const legacyDb = runDataStore.openSideDb(tmpdir, MODULE, '2026-07');
  try {
    legacyDb.exec(`
      DROP TABLE pre_fund_reconciliation_gateway_excluded_rows;
      DROP TRIGGER trg_pre_fund_gateway_batch_legacy_update;
      DROP INDEX idx_pre_fund_gateway_batches_dataset;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN archive_contract_version;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN dataset_version;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN producer_task_run_id;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN dataset_id;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN import_mode;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN excluded_row_count;
      INSERT INTO pre_fund_reconciliation_gateway_batches
        (source_type, source_batch, source_date, source_file_name,
         source_file_sequence, content_hash, declared_row_count, row_count)
      VALUES ('MPT_INBOUND_GATEWAY', 'LEGACY-BATCH', '2026-07-01',
              'legacy.txt', '1', 'legacy-hash', 0, 0);
    `);
  } finally {
    legacyDb.close();
  }
  const store = new PreFundReconciliationStore(tmpdir);
  const historical = store.listBatches()[0];
  assert.match(historical.datasetId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(historical.producerTaskRunId, null);
  assert.equal(historical.archiveContractVersion, 0);

  const filePath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_090.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'LEGACY-UPGRADE' })]
  );
  const imported = await store.importLegacyFile(filePath);
  assert.equal(imported.batch.importMode, 'strict');
  assert.equal(imported.batch.excludedRowCount, 0);

  const upgradedDb = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(tmpdir, MODULE, '2026-07')
  );
  try {
    const columns = upgradedDb.prepare(
      'PRAGMA table_info(pre_fund_reconciliation_gateway_batches)'
    ).all().map((column) => column.name);
    assert.ok(columns.includes('excluded_row_count'));
    assert.ok(columns.includes('import_mode'));
    assert.ok(upgradedDb.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'pre_fund_reconciliation_gateway_excluded_rows'
    `).get());
  } finally {
    upgradedDb.close();
  }
});

test('不同 sourceType+sourceBatch 追加，跨实例可 list，规范行按稳定顺序迭代', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const inbound = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_100.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'R-I-1' }), inboundRow({ reconId: 'R-I-2', orderId: 'OI-2' })]
  );
  const outbound = writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260707101.gz',
    ['20260707', 'MPT_OUTBOUND_20260707', '1'],
    [outboundRow({ reconId: 'R-O-1' })]
  );

  assert.equal((await store.importLegacyFile(inbound)).status, 'imported');
  assert.equal((await store.importLegacyFile(outbound)).status, 'imported');

  const reopened = new PreFundReconciliationStore(tmpdir);
  const batches = reopened.listBatches();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.rowCount).sort(), [1, 2]);

  const rows1 = [...reopened.iterateRows()].map((row) => [row.sourceType, row.sourceRowNumber, row.reconciliationId]);
  const rows2 = [...reopened.iterateRows()].map((row) => [row.sourceType, row.sourceRowNumber, row.reconciliationId]);
  assert.deepEqual(rows1, rows2, '重复迭代顺序稳定');
  assert.deepEqual(rows1, [
    ['MPT_INBOUND_GATEWAY', 2, 'R-I-1'],
    ['MPT_INBOUND_GATEWAY', 3, 'R-I-2'],
    ['MPT_OUTBOUND_GATEWAY', 2, 'R-O-1'],
  ]);
  const outRow = [...reopened.iterateRows({ reconciliationId: 'R-O-1' })][0];
  assert.equal(outRow.currency, 'EUR');
  assert.equal(outRow.amount, '7.5');
  assert.equal(outRow.reconBillBizId, 'BO-1');
  assert.doesNotThrow(() => JSON.parse(outRow.rawJson));
  assert.equal(reopened.getRawJsonById(outRow.monthKey, outRow.id), outRow.rawJson);
  assert.equal(reopened.getRawJsonById(outRow.monthKey, 999999), null);
});

test('重复入金查询跨全部月份只返回精确 INBOUND-VA 条件且每月份一次批量读取', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  await store.importLegacyFile(writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_110.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [
      inboundRow({ reconId: 'R-LOOKUP', business: 'BIZ-1', clientId: 'C1', accId: 'A1' }),
      inboundRow({ reconId: 'R-LOOKUP', tradeType: 'Inbound-OTHER', orderId: 'WRONG-TRADE' })
    ]
  ));
  await store.importLegacyFile(writeFixture(
    'MPT_INBOUND_GATEWAY_20260801_111.txt',
    ['20260801', 'MPT_INBOUND_20260801', '1'],
    [inboundRow({
      batchNo: 'MPT_INBOUND_20260801',
      billDate: '2026-08-01',
      valueDate: '2026-08-01',
      bookDate: '2026-08-01',
      businessDate: '2026-08-01',
      reconId: 'R-LOOKUP',
      orderId: 'OI-AUG'
    })]
  ));
  await store.importLegacyFile(writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260707112.txt',
    ['20260707', 'MPT_OUTBOUND_20260707', '1'],
    [outboundRow({ reconId: 'R-LOOKUP', channel: 'CITI', merchantId: 'M1' })]
  ));

  const originalOpenExistingSideDb = runDataStore.openExistingSideDb;
  let bulkSelectCount = 0;
  runDataStore.openExistingSideDb = (...args) => {
    const db = originalOpenExistingSideDb(...args);
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (String(sql).includes('JOIN duplicate_inbound_match_lookup_ids wanted')) {
              bulkSelectCount += 1;
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  let found;
  try {
    found = store.lookupInboundRows([
      { lookupId: 'bank-1', channel: ' CITI ', merchantId: 'M1', reconciliationId: 'R-LOOKUP' },
      { lookupId: 'bank-2', channel: 'DBS', merchantId: 'M1', reconciliationId: 'R-LOOKUP' },
      { lookupId: 'bank-3', channel: 'CITI', merchantId: 'M1', reconciliationId: 'R-LOOKUP' }
    ]);
  } finally {
    runDataStore.openExistingSideDb = originalOpenExistingSideDb;
  }
  assert.equal(found.get('bank-1').candidateCount, 2);
  assert.deepEqual(found.get('bank-1').candidates.map((row) => row.orderId), ['OI-1', 'OI-AUG']);
  assert.deepEqual(found.get('bank-1').candidates.map((row) => row.monthKey), ['2026-07', '2026-08']);
  assert.deepEqual(found.get('bank-2'), { candidateCount: 0, candidates: [] });
  assert.equal(new Set(found.get('bank-1').candidates.map((row) => row.candidateId)).size, 2);
  assert.strictEqual(found.get('bank-1'), found.get('bank-3'), '重复查询键共享同一有界候选集合');
  assert.equal(Object.isFrozen(found.get('bank-1').candidates), true);
  assert.equal(bulkSelectCount, 2, '两个保留月份各执行一次候选批量 SELECT');
});

test('重复入金查询的空 reconciliationId 不进入候选池', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  await store.importLegacyFile(writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_114.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [
      inboundRow({ reconId: '', merchantId: 'M1', orderId: 'EMPTY-1', batchSeq: '1' }),
      inboundRow({ reconId: '', merchantId: 'M2', orderId: 'EMPTY-2', batchSeq: '2' })
    ]
  ));

  const found = store.lookupInboundRows([
    { lookupId: 'bank-empty-1', channel: 'CITI', merchantId: 'M1', reconciliationId: '' },
    { lookupId: 'bank-empty-2', channel: 'CITI', merchantId: 'M2', reconciliationId: '   ' }
  ]);
  assert.deepEqual(found.get('bank-empty-1'), { candidateCount: 0, candidates: [] });
  assert.deepEqual(found.get('bank-empty-2'), { candidateCount: 0, candidates: [] });
});

test('重复银行查询键共享有界 MPT 多候选集合，不按 N×K 展开对象', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const rows = Array.from({ length: 25 }, (_unused, index) => inboundRow({
    batchNo: 'MPT_INBOUND_20260708',
    reconId: 'R-BOUNDED',
    channel: 'CITI',
    merchantId: 'M1',
    orderId: `ORDER-${index + 1}`,
    batchSeq: String(index + 1)
  }));
  await store.importLegacyFile(writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_113.txt',
    ['20260708', 'MPT_INBOUND_20260708', String(rows.length)],
    rows
  ));
  const criteria = Array.from({ length: 500 }, (_unused, index) => ({
    lookupId: `bank-${index}`,
    channel: 'CITI',
    merchantId: 'M1',
    reconciliationId: 'R-BOUNDED'
  }));

  const found = store.lookupInboundRows(criteria);
  const first = found.get('bank-0');
  assert.equal(first.candidateCount, 25);
  assert.equal(first.candidates.length, 2, '多候选只保留两条审计样本');
  for (const criterion of criteria) {
    assert.strictEqual(found.get(criterion.lookupId), first);
  }

  const sideFile = runDataStore.listSideDbFiles(tmpdir, MODULE)[0];
  const db = runDataStore.openExistingSideDb(sideFile.path);
  try {
    db.prepare(`
      UPDATE pre_fund_reconciliation_gateway_rows
      SET raw_json = '{broken'
      WHERE source_row_number = 4
    `).run();
  } finally {
    db.close();
  }
  assert.throws(
    () => store.lookupInboundRows(criteria),
    (error) => error.code === 'duplicate-inbound-invalid-mpt-raw-json'
      && error.detailLines.some((line) => /行号：4/.test(line))
  );
});

test('同文件同 hash 为 no-op；同文件名不同 hash 拒绝且旧数据不变', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const fileName = 'MPT_INBOUND_GATEWAY_20260708_200.txt';
  const filePath = writeFixture(
    fileName,
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'ORIGINAL' })]
  );
  assert.equal((await store.importLegacyFile(filePath)).status, 'imported');
  assert.equal((await store.importLegacyFile(filePath)).status, 'noop');

  writeFixture(
    fileName,
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'CHANGED' })]
  );
  await assert.rejects(
    () => store.importLegacyFile(filePath),
    (error) => error.code === 'MPT_FILE_IDENTITY_CONFLICT'
  );
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['ORIGINAL']);
});

test('v1 MPT 同 hash noop 保留原 tag，物理替换才写入新 dataset 并递增 version', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const firstPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_210.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'V1-OLD' })]
  );
  await store.importFile(firstPath, {
    datasetSeed: { datasetId: 'mpt-dataset-1', producerTaskRunId: 'mpt-task-1' }
  });
  const first = store.listBatches()[0];
  assert.equal(first.datasetId, 'mpt-dataset-1');
  assert.equal(first.datasetVersion, 1);
  assert.equal(first.archiveContractVersion, 1);

  const noop = await store.importFile(firstPath, {
    datasetSeed: { datasetId: 'mpt-dataset-unused', producerTaskRunId: 'mpt-task-unused' }
  });
  assert.equal(noop.status, 'noop');
  const afterNoop = store.listBatches()[0];
  assert.equal(afterNoop.datasetId, 'mpt-dataset-1');
  assert.equal(afterNoop.producerTaskRunId, 'mpt-task-1');
  assert.equal(afterNoop.datasetVersion, 1);

  const replacement = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_211.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'V1-NEW' })]
  );
  await store.importFile(replacement, {
    datasetSeed: { datasetId: 'mpt-dataset-2', producerTaskRunId: 'mpt-task-2' }
  });
  const replaced = store.listBatches()[0];
  assert.equal(replaced.datasetId, 'mpt-dataset-2');
  assert.equal(replaced.producerTaskRunId, 'mpt-task-2');
  assert.equal(replaced.datasetVersion, 2);
  assert.equal(replaced.archiveContractVersion, 1);
});

test('同批次更高序号原子替换，更低序号拒绝', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const oldPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_300.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'OLD-1' }), inboundRow({ reconId: 'OLD-2' })]
  );
  await store.importLegacyFile(oldPath);
  const originalBatchId = store.listBatches()[0].id;

  const newerPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_301.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'NEW' })]
  );
  const replaced = await store.importLegacyFile(newerPath);
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.replacedFileName, path.basename(oldPath));
  assert.equal(replaced.batch.id, originalBatchId, '替换保留 batch.id，候选稳定顺序不漂移');
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['NEW']);

  const stalePath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_299.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'STALE' })]
  );
  await assert.rejects(
    () => store.importLegacyFile(stalePath),
    (error) => error.code === 'MPT_BATCH_SEQUENCE_STALE'
  );
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['NEW']);
});

test('替换较早导入批次后仍保持其在其它临时批次之前', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const first = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_610.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'FIRST-OLD' })]
  );
  const second = writeFixture(
    'MPT_INBOUND_GATEWAY_20260709_620.txt',
    ['20260709', 'MPT_INBOUND_20260709', '1'],
    [inboundRow({ batchNo: 'MPT_INBOUND_20260709', billDate: '2026-07-09', reconId: 'SECOND' })]
  );
  await store.importLegacyFile(first);
  await store.importLegacyFile(second);
  const originalIds = store.listBatches().map((batch) => batch.id);

  const replacement = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_611.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'FIRST-NEW' })]
  );
  await store.importLegacyFile(replacement);

  assert.deepEqual(store.listBatches().map((batch) => batch.id), originalIds);
  assert.deepEqual(
    [...store.iterateRows()].map((row) => row.reconciliationId),
    ['FIRST-NEW', 'SECOND']
  );
});

test('更高序号文件尾部校验失败时，已写批次回滚且旧批次完整保留', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const oldPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_400.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'OLD-1' }), inboundRow({ reconId: 'OLD-2' })]
  );
  await store.importLegacyFile(oldPath);

  const brokenPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_401.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'NEW-1' }), inboundRow({ reconId: 'NEW-2', amount: 'bad' })]
  );
  await assert.rejects(
    () => store.importLegacyFile(brokenPath),
    (error) => error.code === 'MPT_ROW_ERRORS'
      && error.rowErrorCount === 1
      && error.rowErrorSamples[0].code === 'MPT_DECIMAL_INVALID'
  );

  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['OLD-1', 'OLD-2']);
  assert.equal(store.listBatches()[0].sourceFileSequence, '400');
});

test('严格导入汇总明细错误并整批回滚，逻辑删除重跑只落有效行和排除审计', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const filePath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_410.txt',
    ['20260708', 'MPT_INBOUND_20260708', '3'],
    [
      inboundRow({ reconId: 'VALID' }),
      inboundRow({ reconId: 'BAD-AMOUNT', amount: 'not-decimal' }),
      inboundRow({ reconId: 'BAD-DATE', billDate: '2026-02-30' })
    ]
  );

  let strictError;
  await assert.rejects(
    () => store.importLegacyFile(filePath),
    (error) => {
      strictError = error;
      return error.code === 'MPT_ROW_ERRORS'
        && error.rowErrorCount === 2
        && error.rowErrorSamples.map((issue) => issue.sourceRowNumber).join(',') === '3,4'
        && /^[a-f0-9]{64}$/.test(error.contentHash);
    }
  );
  assert.deepEqual(store.listBatches(), [], '严格导入失败不得留下批次或有效行');

  await assert.rejects(
    () => store.importLegacyFile(filePath, {
      skipInvalidRows: true,
      expectedContentHash: '0'.repeat(64)
    }),
    (error) => error.code === 'MPT_REPAIR_SOURCE_CHANGED'
  );
  assert.deepEqual(store.listBatches(), [], '源文件哈希不符不得留下重跑结果');

  const repaired = await store.importLegacyFile(filePath, {
    skipInvalidRows: true,
    expectedContentHash: strictError.contentHash
  });
  assert.equal(repaired.status, 'imported');
  assert.equal(repaired.excludedRowCount, 2);
  assert.deepEqual(repaired.batch, {
    ...repaired.batch,
    declaredRowCount: 3,
    rowCount: 1,
    excludedRowCount: 2,
    importMode: 'exclude-invalid-rows'
  });
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['VALID']);
  assert.deepEqual(
    [...store.iterateExcludedRows()].map((row) => [
      row.sourceRowNumber,
      row.errorCode,
      row.fields.length,
      row.rawLine.includes(MPT_DELIMITER)
    ]),
    [
      [3, 'MPT_DECIMAL_INVALID', INBOUND_FIELDS.length, true],
      [4, 'MPT_ROW_DATE_MISMATCH', INBOUND_FIELDS.length, true]
    ]
  );

  await store.deleteBatch({
    sourceType: SOURCE_TYPE_INBOUND,
    sourceBatch: 'MPT_INBOUND_20260708'
  });
  assert.deepEqual([...store.iterateExcludedRows()], [], '删除批次必须级联删除排除审计');
});

test('更高序号逻辑删除重跑失败时恢复原批次和原错误审计', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const oldPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_420.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'OLD-VALID' }), inboundRow({ reconId: 'OLD-BAD', amount: 'bad' })]
  );
  let oldError;
  await assert.rejects(() => store.importLegacyFile(oldPath), (error) => {
    oldError = error;
    return error.code === 'MPT_ROW_ERRORS';
  });
  await store.importLegacyFile(oldPath, {
    skipInvalidRows: true,
    expectedContentHash: oldError.contentHash
  });

  const newerPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_421.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'NEW-VALID' }), inboundRow({ reconId: 'NEW-BAD', amount: 'bad' })]
  );
  let newerError;
  await assert.rejects(() => store.importLegacyFile(newerPath), (error) => {
    newerError = error;
    return error.code === 'MPT_ROW_ERRORS';
  });
  fs.writeFileSync(
    newerPath,
    fs.readFileSync(newerPath, 'utf8').replace('NEW-VALID', 'CHANGED-VALID'),
    'utf8'
  );
  await assert.rejects(
    () => store.importLegacyFile(newerPath, {
      skipInvalidRows: true,
      expectedContentHash: newerError.contentHash
    }),
    (error) => error.code === 'MPT_REPAIR_SOURCE_CHANGED'
  );

  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['OLD-VALID']);
  assert.deepEqual([...store.iterateExcludedRows()].map((row) => row.sourceFileName), [
    path.basename(oldPath)
  ]);
  const batch = store.listBatches()[0];
  assert.equal(batch.sourceFileSequence, '420');
  assert.equal(batch.excludedRowCount, 1);
});

test('更高序号 gzip 在尾部截断时整批回滚，旧批次保持可用', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const oldPath = writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260707900.txt',
    ['20260707', 'MPT_OUTBOUND_20260707', '1'],
    [outboundRow({ reconId: 'OLD-GZIP' })]
  );
  await store.importLegacyFile(oldPath);

  const truncatedPath = writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260707901.gz',
    ['20260707', 'MPT_OUTBOUND_20260707', '2'],
    [outboundRow({ reconId: 'NEW-GZIP-1' }), outboundRow({ reconId: 'NEW-GZIP-2' })]
  );
  const gzip = fs.readFileSync(truncatedPath);
  fs.writeFileSync(truncatedPath, gzip.subarray(0, gzip.length - 4));
  await assert.rejects(
    () => store.importLegacyFile(truncatedPath),
    (error) => error.code === 'MPT_GZIP_INVALID'
  );

  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['OLD-GZIP']);
  assert.equal(store.listBatches()[0].sourceFileSequence, '900');
});

test('分批 DB 写入中途失败时外层事务回滚，旧批次保持完整', async () => {
  const store = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const oldPath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_1000.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'OLD-DB' })]
  );
  await store.importLegacyFile(oldPath);

  const db = runDataStore.openSideDb(tmpdir, MODULE, '2026-07');
  db.exec(`
    CREATE TRIGGER reject_second_synthetic_row
    BEFORE INSERT ON pre_fund_reconciliation_gateway_rows
    WHEN NEW.source_file_sequence = '1001' AND NEW.source_row_number = 3
    BEGIN
      SELECT RAISE(ABORT, 'synthetic row insert failure');
    END;
  `);
  db.close();

  const replacement = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_1001.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'NEW-DB-1' }), inboundRow({ reconId: 'NEW-DB-2' })]
  );
  await assert.rejects(() => store.importLegacyFile(replacement), /synthetic row insert failure/);

  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['OLD-DB']);
  assert.equal(store.listBatches()[0].sourceFileSequence, '1000');
});

test('删除单批次不影响其它批次；clear 回收临时月库且不影响独立结果侧库', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const inbound = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_500.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow()]
  );
  const outbound = writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260707501.txt',
    ['20260707', 'MPT_OUTBOUND_20260707', '1'],
    [outboundRow()]
  );
  await store.importLegacyFile(inbound);
  await store.importLegacyFile(outbound);
  const resultDb = runDataStore.openSideDb(
    tmpdir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
    '2026-07'
  );
  resultDb.prepare(`
    INSERT INTO pre_fund_reconciliation_runs
      (id, scenario, snapshot_json, bank_files_json, status, summary_json)
    VALUES (1, 'missing-gateway', '{}', '[]', 'success', '{}')
  `).run();
  resultDb.close();

  const deleted = await store.deleteBatch({
    sourceType: 'MPT_INBOUND_GATEWAY',
    sourceBatch: 'MPT_INBOUND_20260708',
  });
  assert.deepEqual(deleted, { deletedBatches: 1, deletedRows: 1 });
  assert.deepEqual(store.listBatches().map((batch) => batch.sourceType), ['MPT_OUTBOUND_GATEWAY']);

  const cleared = await store.clear();
  assert.equal(cleared.deletedFiles, 1);
  assert.equal(cleared.deletedBatches, 1);
  assert.equal(cleared.deletedRows, 1);
  assert.deepEqual(store.listBatches(), []);
  assert.equal(runDataStore.listSideDbFiles(tmpdir, MODULE).length, 0, '临时批次清空后整文件回收');
  const preservedDb = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    tmpdir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
    '2026-07'
  ));
  try {
    assert.equal(preservedDb.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_runs').get().count, 1);
  } finally {
    preservedDb.close();
  }
});

test('按账单月份分库，跨月迭代按 monthKey 稳定排序', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const august = writeFixture(
    'MPT_INBOUND_GATEWAY_20260801_700.txt',
    ['20260801', 'MPT_INBOUND_20260801', '1'],
    [inboundRow({ batchNo: 'MPT_INBOUND_20260801', billDate: '2026-08-01', reconId: 'AUG' })]
  );
  const july = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_701.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'JUL' })]
  );
  await store.importLegacyFile(august);
  await store.importLegacyFile(july);

  assert.deepEqual(
    runDataStore.listSideDbFiles(tmpdir, MODULE).map((file) => file.monthKey).sort(),
    ['2026-07', '2026-08']
  );
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['JUL', 'AUG']);
});

test('按 sourceDate 闭区间跨月统计/删除，边界命中且范围外批次与非空月库保留', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const fixtures = [
    {
      fileName: 'MPT_INBOUND_GATEWAY_20260630_710.txt',
      compactDate: '20260630',
      date: '2026-06-30',
      batch: 'MPT_INBOUND_20260630',
      rows: [inboundRow({ batchNo: 'MPT_INBOUND_20260630', billDate: '2026-06-30', reconId: 'JUN' })]
    },
    {
      fileName: 'MPT_INBOUND_GATEWAY_20260701_711.txt',
      compactDate: '20260701',
      date: '2026-07-01',
      batch: 'MPT_INBOUND_20260701',
      rows: [
        inboundRow({ batchNo: 'MPT_INBOUND_20260701', billDate: '2026-07-01', reconId: 'JUL-1' }),
        inboundRow({ batchNo: 'MPT_INBOUND_20260701', billDate: '2026-07-01', reconId: 'JUL-2' })
      ]
    },
    {
      fileName: 'MPT_INBOUND_GATEWAY_20260715_712.txt',
      compactDate: '20260715',
      date: '2026-07-15',
      batch: 'MPT_INBOUND_20260715',
      rows: [inboundRow({ batchNo: 'MPT_INBOUND_20260715', billDate: '2026-07-15', reconId: 'JUL-KEEP' })]
    },
    {
      fileName: 'MPT_INBOUND_GATEWAY_20260801_713.txt',
      compactDate: '20260801',
      date: '2026-08-01',
      batch: 'MPT_INBOUND_20260801',
      rows: [inboundRow({ batchNo: 'MPT_INBOUND_20260801', billDate: '2026-08-01', reconId: 'AUG' })]
    }
  ];
  for (const fixture of fixtures) {
    await store.importLegacyFile(writeFixture(
      fixture.fileName,
      [fixture.compactDate, fixture.batch, String(fixture.rows.length)],
      fixture.rows
    ));
  }

  assert.deepEqual(store.countByDateRange('2026-06-30', '2026-07-01'), {
    batchCount: 2,
    rowCount: 3
  });
  assert.deepEqual(store.countByDateRange('2026-09-01', '2026-09-30'), {
    batchCount: 0,
    rowCount: 0
  });
  assert.deepEqual(await store.deleteByDateRange('2026-09-01', '2026-09-30'), {
    deletedFiles: 0,
    deletedBatches: 0,
    deletedRows: 0
  });

  const deleted = await store.deleteByDateRange('2026-06-30', '2026-07-01');
  assert.deepEqual(deleted, { deletedFiles: 1, deletedBatches: 2, deletedRows: 3 });
  assert.deepEqual(store.listBatches().map((batch) => batch.sourceDate), ['2026-07-15', '2026-08-01']);
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), ['JUL-KEEP', 'AUG']);
  assert.deepEqual(
    runDataStore.listSideDbFiles(tmpdir, MODULE).map((file) => file.monthKey).sort(),
    ['2026-07', '2026-08'],
    '空的 6 月库回收，仍有范围外批次的 7/8 月库保留'
  );
  assert.deepEqual(await store.deleteByDateRange('2026-06-30', '2026-07-01'), {
    deletedFiles: 0,
    deletedBatches: 0,
    deletedRows: 0
  }, '相同范围重跑幂等');

  assert.throws(() => store.countByDateRange('2026/07/01', '2026/07/31'), /日期格式非法/);
  assert.throws(() => store.countByDateRange('2026-02-30', '2026-07-31'), /日期值非法/);
  await assert.rejects(store.deleteByDateRange('2026-08-01', '2026-07-01'), /日期范围非法/);
  assert.equal(store.listBatches().length, 2, '非法范围不得继续删除');
});

test('同月 INBOUND/OUTBOUND 按 sourceType 逻辑隔离统计和删除', async () => {
  const store = new PreFundReconciliationStore(tmpdir);
  const inbound = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_720.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'INBOUND-KEEP-SEPARATE' })]
  );
  const outbound = writeFixture(
    'MPT_OUTBOUND_GATEWAY_20260708721.txt',
    ['20260708', 'MPT_OUTBOUND_20260708', '1'],
    [outboundRow({
      batchNo: 'MPT_OUTBOUND_20260708',
      billDate: '2026-07-08',
      reconId: 'OUTBOUND-KEEP-SEPARATE'
    })]
  );
  await store.importLegacyFile(inbound);
  await store.importLegacyFile(outbound);

  assert.deepEqual(store.countByDateRange('2026-07-08', '2026-07-08'), {
    batchCount: 2,
    rowCount: 2
  }, '无来源过滤时保留底层兼容汇总口径');
  assert.deepEqual(store.countByDateRange('2026-07-08', '2026-07-08', {
    sourceType: SOURCE_TYPE_INBOUND
  }), { batchCount: 1, rowCount: 1 });
  assert.deepEqual(store.countByDateRange('2026-07-08', '2026-07-08', {
    sourceType: SOURCE_TYPE_OUTBOUND
  }), { batchCount: 1, rowCount: 1 });

  const deleted = await store.deleteByDateRange('2026-07-08', '2026-07-08', {
    sourceType: SOURCE_TYPE_INBOUND
  });
  assert.deepEqual(deleted, { deletedFiles: 0, deletedBatches: 1, deletedRows: 1 });
  assert.deepEqual(store.listBatches().map((batch) => batch.sourceType), [SOURCE_TYPE_OUTBOUND]);
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), [
    'OUTBOUND-KEEP-SEPARATE'
  ]);
  assert.equal(runDataStore.sideDbExists(tmpdir, MODULE, '2026-07'), true, '另一逻辑表有数据时月库保留');

  assert.equal((await store.importLegacyFile(inbound)).status, 'imported');
  const reverseDeleted = await store.deleteByDateRange('2026-07-08', '2026-07-08', {
    sourceType: SOURCE_TYPE_OUTBOUND
  });
  assert.deepEqual(reverseDeleted, { deletedFiles: 0, deletedBatches: 1, deletedRows: 1 });
  assert.deepEqual(store.listBatches().map((batch) => batch.sourceType), [SOURCE_TYPE_INBOUND]);
  assert.deepEqual([...store.iterateRows()].map((row) => row.reconciliationId), [
    'INBOUND-KEEP-SEPARATE'
  ]);
  assert.equal(runDataStore.sideDbExists(tmpdir, MODULE, '2026-07'), true, '反向删除仍保留共享月库');

  assert.throws(
    () => store.countByDateRange('2026-07-08', '2026-07-08', { sourceType: 'MPT_UNKNOWN' }),
    /不支持的 MPT sourceType/
  );
  await assert.rejects(
    store.deleteByDateRange('2026-07-08', '2026-07-08', { sourceType: 'MPT_UNKNOWN' }),
    /不支持的 MPT sourceType/
  );
  assert.equal(store.listBatches().length, 1, '未知来源不得继续删除');
});

test('并发导入由共享 mutation lock 串行化，最终保留最高文件序号且不自锁', async () => {
  const storeA = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const storeB = new PreFundReconciliationStore(tmpdir, { writeBatchSize: 1 });
  const lower = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_800.txt',
    ['20260708', 'MPT_INBOUND_20260708', '2'],
    [inboundRow({ reconId: 'LOW-1' }), inboundRow({ reconId: 'LOW-2' })]
  );
  const higher = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_801.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow({ reconId: 'HIGH' })]
  );

  const results = await Promise.allSettled([storeA.importLegacyFile(lower), storeB.importLegacyFile(higher)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.deepEqual([...storeA.iterateRows()].map((row) => row.reconciliationId), ['HIGH']);
  assert.equal(storeA.listBatches()[0].sourceFileSequence, '801');
});

test('主库 linked_gateway_bill 内容不受导入、替换、删除影响', async () => {
  const mainDbPath = path.join(tmpdir, 'tool-data.sqlite');
  const mainDb = new DatabaseSync(mainDbPath);
  mainDb.exec('CREATE TABLE linked_gateway_bill (id INTEGER PRIMARY KEY, raw_json TEXT NOT NULL)');
  mainDb.prepare('INSERT INTO linked_gateway_bill (id, raw_json) VALUES (1, ?)').run('{"keep":true}');
  mainDb.close();

  const store = new PreFundReconciliationStore(tmpdir);
  const filePath = writeFixture(
    'MPT_INBOUND_GATEWAY_20260708_600.txt',
    ['20260708', 'MPT_INBOUND_20260708', '1'],
    [inboundRow()]
  );
  await store.importLegacyFile(filePath);
  await store.clearAll();

  const check = new DatabaseSync(mainDbPath, { readOnly: true });
  try {
    const rows = check.prepare('SELECT * FROM linked_gateway_bill').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 1);
    assert.equal(rows[0].raw_json, '{"keep":true}');
  } finally {
    check.close();
  }
});
