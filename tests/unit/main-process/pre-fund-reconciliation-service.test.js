'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const {
  ensureLinkedTableSupport,
  ensurePreFundReconciliationRunMetadataSupport
} = require('../../../src/backend/database/migrations');
const mirrorRepository = require('../../../src/backend/database/pre-fund-reconciliation-run-repository');
const linkedTableRepository = require('../../../src/backend/database/linked-table-repository');
const runDataStore = require('../../../src/backend/run-data-store');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  PreFundReconciliationService,
  createPreFundReconciliationService
} = require('../../../src/main-process/pre-fund-reconciliation/service');

function bankRow(values = {}) {
  const normalized = { FundType: 'Inbound', ...values };
  return BANK_STATEMENT_FIELDS.map((field) => normalized[field] ?? '');
}

function writeBankFile(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BANK_STATEMENT_FIELDS.slice(), ...rows]),
    '渠道对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

let mirrorDatabases = [];

function attachRunMirrorRepository(database) {
  const mirrorDb = new DatabaseSync(':memory:');
  ensurePreFundReconciliationRunMetadataSupport(mirrorDb);
  mirrorDatabases.push(mirrorDb);
  const attached = Object.assign(database, {
    _mirrorDb: mirrorDb,
    createPreFundReconciliationRunMirror: (payload) => mirrorRepository.createRunMirror(mirrorDb, payload),
    finishPreFundReconciliationRunMirror: (id, summary) => mirrorRepository.finishRunMirror(mirrorDb, id, summary),
    getPreFundReconciliationRunMirrorByTaskRun: (taskRunId) => (
      mirrorRepository.getRunMirrorByArchiveTaskRunId(mirrorDb, taskRunId)
    ),
    acknowledgePreFundReconciliationRunMirror: (id, taskRunId) => (
      mirrorRepository.acknowledgeArchiveTerminal(mirrorDb, id, taskRunId)
    ),
    failPreFundReconciliationRunMirror: (id, error) => mirrorRepository.failRunMirror(mirrorDb, id, error),
    markPreFundReconciliationRunMirrorUnavailable: (id, status, message) => (
      mirrorRepository.markRunMirrorUnavailable(mirrorDb, id, status, message)
    ),
    listPreFundReconciliationRunMirrors: () => mirrorRepository.listRunMirrors(mirrorDb)
  });
  if (typeof attached.listGatewayBillSourceTags !== 'function') {
    attached.listGatewayBillSourceTags = () => {
      const counts = new Map();
      for (const row of attached.iterateGatewayBillRows()) {
        const tag = {
          datasetId: row.sourceDatasetId || null,
          producerTaskRunId: row.sourceTaskRunId || null,
          sourceContractVersion: row.sourceContractVersion === 1 ? 1 : 0
        };
        const key = JSON.stringify(tag);
        const existing = counts.get(key) || { ...tag, rowCount: 0 };
        existing.rowCount += 1;
        counts.set(key, existing);
      }
      return [...counts.values()];
    };
  }
  return attached;
}

const fakeGatewayReadRepository = {
  getLinkedTableMeta: (database) => database.getLinkedTableMeta('gateway-bill'),
  listGatewayBillSourceTags: (database) => database.listGatewayBillSourceTags(),
  iterateGatewayBillRows: (database) => database.iterateGatewayBillRows(),
  getGatewayBillRawJsonById: (database, id) => database.getGatewayBillRawJsonById(id)
};

function makeService(options) {
  return createPreFundReconciliationService({
    ...options,
    openGatewayReadSnapshot: () => ({ db: options.database, close() {} }),
    gatewayReadRepository: fakeGatewayReadRepository
  });
}

let producerSequence = 0;

function nextTaskRunId(label) {
  producerSequence += 1;
  return `${label}-task-${producerSequence}`;
}

function importBankV1(service, filePath) {
  return service.importBank(filePath, nextTaskRunId('bank-import'));
}

function importMptV1(service, filePaths) {
  return service.importMptFiles(filePaths, { producerTaskRunId: nextTaskRunId('mpt-import') });
}

function retryMptV1(service, tokens) {
  const filePaths = tokens.map((token) => {
    const failure = service.mptImportFailures.get(token);
    return failure ? failure.filePath : '';
  });
  return service.retryMptImportFailures(tokens, {
    filePaths,
    producerTaskRunId: nextTaskRunId('mpt-repair')
  });
}

function runV1(service, options = {}) {
  const plan = service.prepareRunLineage();
  return service.run({
    ...options,
    taskRunId: nextTaskRunId('pre-fund-run'),
    expectedDatasets: plan.expectedDatasets
  });
}

function exportV1(service, options) {
  return service.export({ ...options, runLocator: service.lastRunLocator() });
}

function assertPublicResultHasNoArchiveIdentity(value) {
  const serialized = JSON.stringify(value);
  for (const field of [
    'datasetId',
    'producerTaskRunId',
    'datasetVersion',
    'archiveContractVersion',
    'archiveTaskRunId',
    'archiveTerminalAckAt',
    'mirrorRunId',
    'sideRunId',
    'runLocator',
    'lineageIntents'
  ]) {
    assert.equal(serialized.includes(`"${field}"`), false, `公共结果不应包含 ${field}`);
  }
}

function inboundMptRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_INBOUND_20260708', billDate: '2026-07-08', channel: 'CIT', merchantId: 'M-1',
    tradeType: 'Inbound-VA', orderId: 'G-TEMP', reconId: 'R-TEMP', billReconId: 'BR-TEMP',
    currency: 'USD', originAmount: '10', fee: '0', amount: '10', payerName: 'Gateway Payer',
    payerAccount: 'GW-CARD', valueDate: '2026-07-08', bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03', tradeScope: 'INBOUND', realChannel: 'CIT-REAL',
    clearingNetwork: 'SWIFT', ...overrides
  };
  return INBOUND_FIELDS.map((field) => values[field] ?? '');
}

function outboundMptRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_OUTBOUND_20260708', billDate: '2026-07-08', tradeType: 'WITHDRAW',
    orderNo: 'G-OUT', billReconId: 'BR-OUT', reconId: 'R-OUT', name: 'Gateway Payee',
    cardNo: 'GW-OUT-CARD', originCurrency: 'USD', targetCurrency: 'USD', originAmount: '3',
    fee: '0', originNetAmount: '3', targetAmount: '3', createTime: '2026-07-08 01:02:03',
    finishTime: '2026-07-08 01:03:04', channel: 'CIT', merchantId: 'M-2',
    tradeScope: 'OUTBOUND', bankDebitCurrency: 'USD', bankDebitAmount: '3', ...overrides
  };
  return OUTBOUND_FIELDS.map((field) => values[field] ?? '');
}

function writeMptFile(filePath, rows) {
  const sourceBatch = path.basename(filePath).startsWith('MPT_OUTBOUND_GATEWAY_')
    ? 'MPT_OUTBOUND_20260708'
    : 'MPT_INBOUND_20260708';
  const header = ['20260708', sourceBatch, String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
}

test.describe('PreFundReconciliationService', () => {
  let userDataDir;
  let bankFile;

  test.beforeEach(() => {
    mirrorDatabases = [];
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-fund-service-'));
    bankFile = path.join(userDataDir, 'bank.xlsx');
  });

  test.afterEach(() => {
    for (const db of mirrorDatabases) db.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('runs strict 1:1 against persistent iterator and stores balanced/unbalanced outputs', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'CIT', MerchantId: 'M-1',
        Currency: 'USD', 'Credit Amount': '10', ReconciliationId: ' R-1 ', ChannelOrderNo: 'C-1',
        'Drawee Name': 'Alice', 'Drawee CardNo': 'CARD-A', OriginBillId: 'OB-1'
      }),
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'CIT', MerchantId: 'M-1',
        Currency: 'USD', 'Debit Amount': '20', ReconciliationId: 'R-2', ChannelOrderNo: 'C-2',
        'Payee Name': 'Bob', 'Payee CardNo': 'CARD-B'
      }),
      bankRow({ Channel: 'CIT', 'Debit Amount': '2', ReconciliationId: '' }),
      bankRow({ Channel: 'CIT', 'Credit Amount': '0', 'Debit Amount': '' })
    ]);
    const persistentRows = [
      { id: 1, reconciliationId: 'BROKEN', row: null, rawJsonInvalid: true },
      {
        id: 2,
        reconciliationId: 'R-1',
        billDate: '2026-07-01',
        reconBillBizId: 'RB-1',
        row: {
          Billdate: '2026-07-01', Channel: 'CIT', merchantid: 'M-1', orderid: 'G-1',
          ReconBillBizId: 'RB-1', reconciliationid: 'R-1', currency: 'USD', amount: '10.00',
          TradeType: 'Inbound-VA', name: 'Gateway Name', cardNo: 'Gateway Card',
          '真实渠道': 'CIT', '清算网络': 'VISA'
        }
      }
    ];
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({
        tableKey: 'gateway-bill', rowCount: 2, dataDateMin: '2026-07-01',
        dataDateMax: '2026-07-01', sourceFileName: 'gateway.xlsx', updatedAt: '2026-07-10T00:00:00Z'
      }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });

    const imported = importBankV1(service, bankFile);
    assert.equal(imported.acceptedRows, 2);
    assert.equal(imported.excludedEmptyIdRows, 1);
    assert.equal(imported.skippedZeroRows, 1);

    const result = await runV1(service);
    assert.equal(result.summary.bankInputRows, 4);
    assert.equal(result.summary.bankValidRows, 2);
    assert.equal(result.summary.linkedGatewayRawRows, 2);
    assert.equal(result.summary.gatewayInvalidRows, 1);
    assert.equal(result.summary.matchedPairs, 1);
    assert.equal(result.summary.unmatchedBankRows, 1);
    assert.equal(result.summary.unusedGatewayRows, 0);
    assert.deepEqual(result.channelSummaries, [
      { channel: 'CIT', matchedCount: 1, unmatchedCount: 1 }
    ]);

    const exports = [...service.runStore.iterateChannelExports(result.monthKey, service.lastRun.sideRunId)];
    const balanced = [...exports[0].balancedRows];
    const unbalanced = [...exports[0].unbalancedRows];
    const channelRows = [...exports[0].channelBillRows];
    assert.equal(balanced[0]['网关-数据来源'], '网关对账单');
    assert.equal(balanced[0]['网关-MerchantId'], 'M-1');
    assert.equal(balanced[0]['银行-name'], 'Alice');
    assert.equal(unbalanced[0]['差错类型'], '右单边账');
    assert.equal(unbalanced[0]['交易类型'], 'DEBIT');
    assert.equal(channelRows[0].name, 'Bob');
    assert.match(channelRows[0].COriginalId, /bank\.xlsx#3$/);
    assert.equal(service.status().canExport, true);
    const mirror = mirrorRepository.getRunMirror(database._mirrorDb, result.runId);
    assert.equal(mirror.status, 'success');
    assert.equal(mirror.sideRunId, 1);
    assert.equal(mirror.summary.matchedPairs, 1);
  });

  test('production side-DB path only consumes candidates matching ID, channel, amount and currency', async () => {
    const bankCases = [
      { id: 'R-OK', channel: 'CIT', amount: '10.00', currency: 'USD' },
      { id: 'R-CHANNEL', channel: 'CIT', amount: '10', currency: 'USD' },
      { id: 'R-AMOUNT', channel: 'CIT', amount: '10', currency: 'USD' },
      { id: 'R-CURRENCY', channel: 'CIT', amount: '10', currency: 'USD' }
    ];
    writeBankFile(bankFile, bankCases.map((item) => bankRow({
      BillDate: '2026-07-01',
      ValueDate: '2026-07-02',
      Channel: item.channel,
      Currency: item.currency,
      'Credit Amount': item.amount,
      ReconciliationId: item.id
    })));
    const persistentRows = [
      { id: 'R-OK', channel: 'CIT', amount: '10', currency: 'USD' },
      { id: 'R-CHANNEL', channel: 'DBS', amount: '10', currency: 'USD' },
      { id: 'R-AMOUNT', channel: 'CIT', amount: '10.01', currency: 'USD' },
      { id: 'R-CURRENCY', channel: 'CIT', amount: '10', currency: 'EUR' }
    ].map((item, index) => ({
      id: index + 1,
      reconciliationId: item.id,
      row: {
        Billdate: '2026-07-01',
        Channel: item.channel,
        reconciliationid: item.id,
        currency: item.currency,
        amount: item.amount,
        OrderId: `G-${index + 1}`,
        TradeType: 'Inbound-VA'
      }
    }));
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 4, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    importBankV1(service, bankFile);

    const result = await runV1(service);
    assert.equal(result.summary.matchedPairs, 1);
    assert.equal(result.summary.unmatchedBankRows, 3);
    assert.equal(result.summary.unusedGatewayRows, 3);
    const exports = [...service.runStore.iterateChannelExports(result.monthKey, service.lastRun.sideRunId)];
    assert.equal([...exports[0].balancedRows].length, 1);
    assert.equal([...exports[0].unbalancedRows].length, 3);
  });

  test('production side-DB path uses direction amount plus Extra Fee and only consumes rule-allowed tradeType', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'CIT',
        Currency: 'USD', 'Credit Amount': '9.50', 'Extra Fee': '0.50',
        ReconciliationId: 'R-FEE', FundType: 'Inbound'
      })
    ]);
    const persistentRows = [
      { id: 1, tradeType: 'Withdraw' },
      { id: 2, tradeType: 'Inbound-VA' }
    ].map((item) => ({
      id: item.id,
      reconciliationId: 'R-FEE',
      row: {
        Billdate: '2026-07-01', Channel: 'CIT', reconciliationid: 'R-FEE',
        currency: 'USD', amount: '10', OrderId: `G-${item.id}`, TradeType: item.tradeType
      }
    }));
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 2, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    importBankV1(service, bankFile);

    const result = await runV1(service);
    assert.equal(result.summary.matchedPairs, 1);
    assert.equal(result.summary.unusedGatewayRows, 1);
    const exports = [...service.runStore.iterateChannelExports(result.monthKey, service.lastRun.sideRunId)];
    const balanced = [...exports[0].balancedRows];
    assert.equal(balanced[0]['网关-TradeType'], 'Inbound-VA');
    assert.equal(balanced[0]['网关-Amount'], '10');
    assert.equal([...exports[0].unbalancedRows].length, 0);
  });

  test('does not enable export when a successful run has no channel output', async () => {
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '0', ReconciliationId: 'R-ZERO' })
    ]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => [{
        id: 1,
        reconciliationId: 'R-GATEWAY',
        row: {
          Billdate: '2026-07-01', Channel: 'CIT', reconciliationid: 'R-GATEWAY',
          currency: 'USD', amount: '10', TradeType: 'Inbound-VA'
        }
      }].values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    importBankV1(service, bankFile);

    const result = await runV1(service);
    assert.equal(result.summary.bankSkippedZeroRows, 1);
    assert.equal(result.summary.channelCount, 0);
    assert.equal(service.status().canExport, false);
  });

  test('production run consumes one million persistent gateway rows lazily', async () => {
    const rowCount = 1_000_000;
    let yieldedRows = 0;
    let insertedRows = 0;
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '0', ReconciliationId: 'R-ZERO' })
    ]);
    function* persistentRows() {
      for (let index = 0; index < rowCount; index += 1) {
        yieldedRows += 1;
        yield {
          id: index + 1,
          reconciliationId: `R-${index}`,
          row: {
            Billdate: '2026-07-01', Channel: 'CIT', merchantid: 'M-1',
            orderid: `O-${index}`, ReconBillBizId: `B-${index}`,
            reconciliationid: `R-${index}`, currency: 'USD', amount: '10',
            TradeType: 'Inbound-VA'
          }
        };
      }
    }
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount, updatedAt: 'x' }),
      listGatewayBillSourceTags: () => [{
        datasetId: null,
        producerTaskRunId: null,
        sourceContractVersion: 0,
        rowCount
      }],
      iterateGatewayBillRows: () => persistentRows()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    service.runStore = {
      assertAllRunDataClearable() {},
      clearAllRunData: () => ({ deletedFiles: 0, deletedRuns: 0 }),
      deleteAllRunDataAfterArchivePreflight: () => ({ deletedFiles: 0, deletedRuns: 0 }),
      open: () => ({
        exec() {},
        prepare: () => ({ run: () => ({ changes: 1 }) }),
        close() {}
      }),
      createRun: () => 1,
      createGatewayCandidateInserter: () => (candidate) => {
        assert.equal(yieldedRows, insertedRows + 1, '持久游标每 yield 一行应立即下沉');
        assert.equal(candidate.sourceOrder, insertedRows);
        insertedRows += 1;
        return true;
      },
      gatewayStats: () => ({
        candidateCount: insertedRows,
        unusedCount: insertedRows,
        conflictingIdGroupCount: 0
      }),
      duplicateStats: () => ({
        snapshotCount: 0,
        duplicateGroupCount: 0,
        foldedRowCount: 0,
        keptRawBytes: 0,
        foldedRawBytes: 0
      }),
      createGatewayConsumer: () => () => null,
      createBalancedRowInserter: () => () => {},
      createUnbalancedRowInserter: () => () => {},
      finishRun() {},
      failRun() {},
      summarizeChannels: () => []
    };
    importBankV1(service, bankFile);

    const result = await runV1(service);

    assert.equal(yieldedRows, rowCount);
    assert.equal(insertedRows, rowCount);
    assert.equal(result.summary.linkedGatewayRawRows, rowCount);
    assert.equal(result.summary.gatewayEligibleRows, rowCount);
    assert.equal(result.summary.unusedGatewayRows, rowCount);
  });

  test('rejects the run when gateway union has no eligible nonblank ID rows', async () => {
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '1', ReconciliationId: 'R-1' })
    ]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => [{
        id: 1,
        reconciliationId: '',
        row: { Billdate: '2026-07-01', reconciliationid: '', amount: '1' }
      }].values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    importBankV1(service, bankFile);

    await assert.rejects(
      () => runV1(service),
      (error) => error && error.code === 'pre-fund-gateway-pool-empty'
    );
    assert.equal(service.status().canExport, false);
    assert.equal(mirrorRepository.listRunMirrors(database._mirrorDb).length, 0);
  });

  test('same-month temporary MPT runs and exports the real five-sheet template, then OUTBOUND deletion invalidates export without deleting INBOUND', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-08', ValueDate: '2026-07-09', Channel: 'CIT', MerchantId: 'M-1',
        Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-TEMP', ChannelOrderNo: 'C-1',
        'Drawee Name': 'Alice', 'Drawee CardNo': 'BANK-CARD-A', OriginBillId: 'BANK-1'
      }),
      bankRow({
        BillDate: '2026-07-08', ValueDate: '2026-07-09', Channel: 'CIT', MerchantId: 'M-1',
        Currency: 'USD', 'Debit Amount': '20', ReconciliationId: 'R-MISSING', ChannelOrderNo: 'C-2',
        'Payee Name': 'Bob', 'Payee CardNo': 'BANK-CARD-B', OriginBillId: 'BANK-2'
      })
    ]);
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260708_900.txt');
    writeMptFile(mptFile, [inboundMptRow()]);
    const outboundFile = path.join(userDataDir, 'MPT_OUTBOUND_GATEWAY_20260708_901.txt');
    writeMptFile(outboundFile, [outboundMptRow()]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({
        tableKey: 'gateway-bill', rowCount: 0, dataDateMin: null, dataDateMax: null,
        sourceFileName: null, updatedAt: null
      }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });

    importBankV1(service, bankFile);
    const importedMpt = await importMptV1(service, [mptFile, outboundFile]);
    assert.equal(importedMpt.successCount, 2, JSON.stringify(importedMpt));
    assert.equal(importedMpt.results[0].sourceType, SOURCE_TYPE_INBOUND);
    assert.equal(importedMpt.results[0].rowCount, 1, '导入汇总显示实际落库行数');
    assert.equal(importedMpt.results[1].sourceType, SOURCE_TYPE_OUTBOUND);
    assert.equal(Object.hasOwn(importedMpt.results[0], 'batch'), false);
    assertPublicResultHasNoArchiveIdentity(importedMpt);
    const publicBatch = service.listTempBatches()[0];
    for (const internalField of [
      'datasetId',
      'producerTaskRunId',
      'datasetVersion',
      'archiveContractVersion'
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(publicBatch, internalField), false);
    }
    const run = await runV1(service);
    assertPublicResultHasNoArchiveIdentity(run);
    assertPublicResultHasNoArchiveIdentity(service.status());
    assert.equal(run.summary.matchedPairs, 1);
    assert.equal(run.summary.unmatchedBankRows, 1);
    assert.equal(run.summary.tempGatewayRawRows, 2);

    const outputDirectory = path.join(userDataDir, 'exports');
    const exported = await exportV1(service, { outputDirectory });
    assertPublicResultHasNoArchiveIdentity(exported);
    assert.equal(exported.status, 'ok');
    assert.equal(exported.files.length, 1);
    assert.equal(exported.files[0].fileName, '资金对账不平_CIT_2026年07月10日.xlsx');

    const workbook = XLSX.readFile(exported.files[0].filePath, { raw: false });
    assert.deepEqual(workbook.SheetNames, ['不平结果', '平账结果', '网关账单', '渠道账单', '订单修复']);
    const sheetRows = Object.fromEntries(workbook.SheetNames.map((name) => [
      name,
      XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' })
    ]));
    assert.equal(sheetRows['不平结果'].length, 2);
    assert.equal(sheetRows['平账结果'].length, 2);
    assert.equal(sheetRows['网关账单'].length, 1);
    assert.equal(sheetRows['渠道账单'].length, 2);
    assert.equal(sheetRows['订单修复'].length, 1);
    assert.equal(sheetRows['不平结果'][1][0], '导入银行对账单');
    assert.equal(sheetRows['平账结果'][1][0], '临时网关对账单');
    assert.equal(sheetRows['平账结果'][1][10], 'Gateway Payer');
    assert.equal(sheetRows['平账结果'][1][23], 'Alice');
    assert.equal(sheetRows['平账结果'][1][24], 'BANK-CARD-A');

    assert.deepEqual(service.countTempByDateRange({
      start: '2026-07-08',
      end: '2026-07-08',
      sourceType: SOURCE_TYPE_INBOUND
    }), {
      batchCount: 1,
      rowCount: 1
    });
    assert.deepEqual(service.countTempByDateRange({
      start: '2026-07-08',
      end: '2026-07-08',
      sourceType: SOURCE_TYPE_OUTBOUND
    }), {
      batchCount: 1,
      rowCount: 1
    });
    assert.throws(
      () => service.countTempByDateRange({ start: '2026-07-08', end: '2026-07-08' }),
      /请选择临时中台入金或出金网关账单表库/
    );
    assert.deepEqual(await service.deleteTempByDateRange({
      start: '2026-07-08',
      end: '2026-07-08',
      sourceType: SOURCE_TYPE_OUTBOUND
    }), {
      deletedFiles: 0,
      deletedBatches: 1,
      deletedRows: 1
    });
    assert.deepEqual(service.listTempBatches().map((batch) => batch.sourceType), [
      SOURCE_TYPE_INBOUND
    ]);
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);
    await assert.rejects(
      () => exportV1(service, { outputDirectory: path.join(userDataDir, 'exports-2') }),
      (error) => error && error.code === 'pre-fund-run-stale'
    );
  });

  test('MPT 明细失败签发轻量令牌，支持错误导出和逻辑删除重跑且令牌一次性失效', async () => {
    const mptFile = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260708_905.txt');
    writeMptFile(mptFile, [
      inboundMptRow({ reconId: 'VALID-ROW' }),
      inboundMptRow({ reconId: 'INVALID-ROW', amount: 'bad' })
    ]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({
        tableKey: 'gateway-bill', rowCount: 0, dataDateMin: null, dataDateMax: null,
        sourceFileName: null, updatedAt: null
      }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx')
    });

    const imported = await importMptV1(service, [mptFile]);
    assert.equal(imported.successCount, 0);
    assert.equal(imported.failedCount, 1);
    assert.equal(imported.results[0].code, 'MPT_ROW_ERRORS');
    assert.equal(imported.results[0].canRepair, true);
    assert.equal(imported.results[0].rowErrorCount, 1);
    assert.match(imported.results[0].repairToken, /^[a-f0-9-]{36}$/i);
    assert.deepEqual(service.listTempBatches(), [], '严格失败不得留下半批数据');

    const repairToken = imported.results[0].repairToken;
    const errorReportPath = path.join(userDataDir, 'mpt-errors.xlsx');
    const exported = await service.exportMptErrorData([repairToken], errorReportPath);
    assert.equal(exported.status, 'ok');
    assert.equal(exported.errorRowCount, 1);
    assert.deepEqual(XLSX.readFile(errorReportPath).SheetNames, ['INBOUND错误数据']);

    const repaired = await retryMptV1(service, [repairToken]);
    assertPublicResultHasNoArchiveIdentity(repaired);
    assert.equal(repaired.status, 'ok');
    assert.equal(repaired.successCount, 1);
    assert.equal(repaired.importedRowCount, 1);
    assert.equal(repaired.excludedRowCount, 1);
    assert.deepEqual(service.listTempBatches().map((batch) => ({
      rowCount: batch.rowCount,
      declaredRowCount: batch.declaredRowCount,
      excludedRowCount: batch.excludedRowCount,
      importMode: batch.importMode
    })), [{
      rowCount: 1,
      declaredRowCount: 2,
      excludedRowCount: 1,
      importMode: 'exclude-invalid-rows'
    }]);
    assert.deepEqual([...service.tempStore.iterateRows()].map((row) => row.reconciliationId), [
      'VALID-ROW'
    ]);
    assert.deepEqual([...service.tempStore.iterateExcludedRows()].map((row) => row.errorCode), [
      'MPT_DECIMAL_INVALID'
    ]);
    await assert.rejects(
      () => retryMptV1(service, [repairToken]),
      (error) => error.code === 'pre-fund-mpt-failure-token-expired'
    );
  });

  test('重新选择 MPT 文件后旧错误令牌失效', async () => {
    const broken = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260708_906.txt');
    writeMptFile(broken, [inboundMptRow({ amount: 'bad' })]);
    const valid = path.join(userDataDir, 'MPT_OUTBOUND_GATEWAY_20260708_907.txt');
    writeMptFile(valid, [outboundMptRow()]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ rowCount: 0 }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx')
    });
    const first = await importMptV1(service, [broken]);
    const oldToken = first.results[0].repairToken;
    assert.ok(oldToken);

    const second = await importMptV1(service, [valid]);
    assert.equal(second.successCount, 1);
    await assert.rejects(
      () => service.exportMptErrorData([oldToken], path.join(userDataDir, 'expired.xlsx')),
      (error) => error.code === 'pre-fund-mpt-failure-token-expired'
    );
  });

  test('逻辑删除重跑发现源文件变化时作废旧令牌且不反复提供修复操作', async () => {
    const broken = path.join(userDataDir, 'MPT_INBOUND_GATEWAY_20260708_908.txt');
    writeMptFile(broken, [inboundMptRow({ amount: 'bad' })]);
    const service = makeService({
      userDataDir,
      database: attachRunMirrorRepository({
        getLinkedTableMeta: () => ({ rowCount: 0 }),
        iterateGatewayBillRows: () => [][Symbol.iterator]()
      }),
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx')
    });
    const imported = await importMptV1(service, [broken]);
    const repairToken = imported.results[0].repairToken;
    fs.writeFileSync(broken, fs.readFileSync(broken, 'utf8').replace('bad', 'changed'), 'utf8');

    const retried = await retryMptV1(service, [repairToken]);
    assert.equal(retried.successCount, 0);
    assert.equal(retried.failedCount, 1);
    assert.equal(retried.results[0].code, 'MPT_REPAIR_SOURCE_CHANGED');
    assert.equal(retried.results[0].canRepair, undefined);
    assert.equal(retried.results[0].repairToken, undefined);
    await assert.rejects(
      () => retryMptV1(service, [repairToken]),
      (error) => error.code === 'pre-fund-mpt-failure-token-expired'
    );
  });

  test('逻辑删除重跑遇到旧批次序号时终止失败令牌', async () => {
    const service = makeService({
      userDataDir,
      database: attachRunMirrorRepository({
        getLinkedTableMeta: () => ({ rowCount: 0 }),
        iterateGatewayBillRows: () => [][Symbol.iterator]()
      }),
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx')
    });
    const repairToken = '11111111-1111-4111-8111-111111111111';
    service.mptImportFailures.set(repairToken, {
      failureId: repairToken,
      filePath: path.join(userDataDir, 'stale.txt'),
      sourceType: 'MPT_INBOUND_GATEWAY',
      contentHash: 'a'.repeat(64),
      rowErrorCount: 1
    });
    service.tempStore.importFile = async () => {
      const error = new Error('同一批次只接受更高文件序号');
      error.code = 'MPT_BATCH_SEQUENCE_STALE';
      throw error;
    };

    const retried = await retryMptV1(service, [repairToken]);
    assert.equal(retried.results[0].code, 'MPT_BATCH_SEQUENCE_STALE');
    assert.equal(retried.results[0].canRepair, undefined);
    assert.equal(service.mptImportFailures.has(repairToken), false);
  });

  test('bank re-import and persistent gateway metadata changes both invalidate the previous result', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'CIT',
        Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-1'
      })
    ]);
    const persistentRows = [{
      id: 1,
      reconciliationId: 'R-1',
      rawJson: '{"reconciliationid":"R-1","Channel":"CIT","Currency":"USD","Amount":"10"}',
      row: {
        Billdate: '2026-07-01', Channel: 'CIT', reconciliationid: 'R-1',
        Currency: 'USD', Amount: '10'
      }
    }];
    const linkedMeta = {
      tableKey: 'gateway-bill', rowCount: 1, dataDateMin: '2026-07-01',
      dataDateMax: '2026-07-01', sourceFileName: 'gateway.xlsx', updatedAt: 'v1'
    };
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ ...linkedMeta }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });

    importBankV1(service, bankFile);
    await runV1(service);
    assert.equal(service.status().canExport, true);

    importBankV1(service, bankFile);
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);
    await assert.rejects(
      () => exportV1(service, { outputDirectory: path.join(userDataDir, 'bank-stale') }),
      (error) => error && error.code === 'pre-fund-run-stale'
    );

    service.acknowledgeRunByTaskRun(service.lastRun.archiveTaskRunId);
    await runV1(service);
    assert.equal(service.status().canExport, true);
    linkedMeta.updatedAt = 'v2';
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);
    await assert.rejects(
      () => exportV1(service, { outputDirectory: path.join(userDataDir, 'gateway-stale') }),
      (error) => error && error.code === 'pre-fund-run-stale'
    );
  });

  test('duplicate-only gateway channel is appended after bank channels and exports isolated sixth sheet', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'BANK-FIRST',
        Currency: 'USD', 'Credit Amount': '1', ReconciliationId: 'BANK-MISS'
      })
    ]);
    const keptRow = {
      Billdate: '2026-07-01', Channel: 'DUP-ONLY', merchantid: 'M-1', orderid: 'O-1',
      ReconBillBizId: 'B-1', reconciliationid: 'DUP', currency: 'USD', amount: '10',
      TradeType: 'PAY', name: 'Kept', cardNo: 'K', extra: 'kept'
    };
    const foldedRow = { ...keptRow, name: 'Folded', cardNo: 'F', extra: 'folded' };
    const rawById = new Map([
      [1, '{ "kind": "kept", "payload": "原样" }'],
      [2, '{ "kind": "folded", "payload": "原样" }']
    ]);
    const persistentRows = [keptRow, foldedRow].map((row, index) => ({
      id: index + 1,
      reconciliationId: 'DUP',
      rawJson: rawById.get(index + 1),
      row
    }));
    let rawLookupCount = 0;
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 2, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values(),
      getGatewayBillRawJsonById(id) {
        rawLookupCount += 1;
        return rawById.get(id) || null;
      }
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    importBankV1(service, bankFile);

    const run = await runV1(service);
    assert.equal(run.summary.gatewayCollapsedDuplicateRows, 1);
    assert.equal(run.summary.duplicateGroupCount, 1);
    assert.equal(rawLookupCount, 1, '同一重复组只回读一次保留行 raw');
    assert.deepEqual(run.channelSummaries.map((item) => item.channel), ['BANK-FIRST', 'DUP-ONLY']);

    const exported = await exportV1(service, { outputDirectory: path.join(userDataDir, 'duplicate-exports') });
    assert.deepEqual(exported.files.map((file) => file.channel), ['BANK-FIRST', 'DUP-ONLY']);
    const bankWorkbook = XLSX.readFile(exported.files[0].filePath, { raw: false });
    const duplicateWorkbook = XLSX.readFile(exported.files[1].filePath, { raw: false });
    assert.deepEqual(bankWorkbook.SheetNames, ['不平结果', '平账结果', '网关账单', '渠道账单', '订单修复']);
    assert.deepEqual(duplicateWorkbook.SheetNames, [
      '不平结果', '平账结果', '网关账单', '渠道账单', '订单修复', '重复网关账单'
    ]);
    for (const name of duplicateWorkbook.SheetNames.slice(0, 5)) {
      assert.equal(XLSX.utils.sheet_to_json(duplicateWorkbook.Sheets[name], { header: 1 }).length, 1);
    }
    const duplicateRows = XLSX.utils.sheet_to_json(
      duplicateWorkbook.Sheets['重复网关账单'],
      { defval: '' }
    );
    assert.deepEqual(duplicateRows.map((row) => row['对象类型']), ['保留记录', '被折叠记录']);
    assert.equal(duplicateRows[0]['原始数据JSON分片'], rawById.get(1));
    assert.equal(duplicateRows[1]['原始数据JSON分片'], rawById.get(2));
    assert.ok(duplicateRows.every((row) => row.Channel === 'DUP-ONLY'));
  });

  test('rolls back candidate and output bulk when side-run finalization fails', async () => {
    writeBankFile(bankFile, [
      bankRow({
        BillDate: '2026-07-01', ValueDate: '2026-07-02', Channel: 'CIT',
        Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-1'
      })
    ]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => [{
        id: 1,
        reconciliationId: 'R-1',
        rawJson: '{"reconciliationid":"R-1"}',
        row: {
          Billdate: '2026-07-01', Channel: 'CIT', reconciliationid: 'R-1',
          currency: 'USD', amount: '10', TradeType: 'Inbound-VA'
        }
      }][Symbol.iterator]()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    importBankV1(service, bankFile);
    service.runStore.finishRun = () => {
      throw new Error('injected-finalize-failure');
    };

    await assert.rejects(() => runV1(service), /injected-finalize-failure/);
    assert.equal(service.lastRun, null);

    const resultDb = service.runStore.open('2026-07');
    try {
      for (const table of [
        'pre_fund_reconciliation_gateway_pool',
        'pre_fund_reconciliation_gateway_candidate_snapshots',
        'pre_fund_reconciliation_duplicate_groups',
        'pre_fund_reconciliation_folded_gateway_rows',
        'pre_fund_reconciliation_balanced_rows',
        'pre_fund_reconciliation_unbalanced_rows'
      ]) {
        assert.equal(
          Number(resultDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
          0,
          `${table} 应随失败事务回滚`
        );
      }
      assert.equal(
        Number(resultDb.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_runs').get().count),
        0
      );
    } finally {
      resultDb.close();
    }
  });

  test('run 使用独立主库读快照，共享连接写入独立提交且 side rollback 不回滚该写入', async () => {
    const mainDbPath = path.join(userDataDir, 'main.sqlite');
    const mainDb = new DatabaseSync(mainDbPath);
    mainDb.exec('PRAGMA journal_mode = WAL;');
    ensureLinkedTableSupport(mainDb);
    ensurePreFundReconciliationRunMetadataSupport(mainDb);
    mainDb.exec('CREATE TABLE isolation_probe (value TEXT NOT NULL);');
    const gatewayRows = [];
    for (let index = 0; index < 5000; index += 1) {
      gatewayRows.push({
        ReconBillBizId: `B-${index}`,
        reconciliationid: `R-${index}`,
        Billdate: '2026-07-01',
        Channel: 'CIT',
        currency: 'USD',
        amount: '1',
        TradeType: 'Inbound-VA'
      });
    }
    gatewayRows.push({
      ReconBillBizId: 'B-DUP-KEPT',
      reconciliationid: 'R-DUP',
      Billdate: '2026-07-01',
      Channel: 'CIT',
      currency: 'USD',
      amount: '1',
      TradeType: 'Inbound-VA',
      Extra: 'snapshot-old'
    });
    linkedTableRepository.upsertLinkedGatewayBill(mainDb, gatewayRows, {
      sourceIdentity: {
        datasetId: 'snapshot-gateway-dataset',
        producerTaskRunId: 'snapshot-gateway-producer',
        sourceContractVersion: 1
      }
    });
    const database = {
      dbPath: mainDbPath,
      db: mainDb,
      getLinkedTableMeta: (tableKey) => linkedTableRepository.getLinkedTableMeta(mainDb, tableKey),
      listGatewayBillSourceTags: () => linkedTableRepository.listGatewayBillSourceTags(mainDb),
      createPreFundReconciliationRunMirror: (payload) => mirrorRepository.createRunMirror(mainDb, payload),
      finishPreFundReconciliationRunMirror: (id, summary) => mirrorRepository.finishRunMirror(mainDb, id, summary),
      getPreFundReconciliationRunMirrorByTaskRun: (taskRunId) => (
        mirrorRepository.getRunMirrorByArchiveTaskRunId(mainDb, taskRunId)
      ),
      acknowledgePreFundReconciliationRunMirror: (id, taskRunId) => (
        mirrorRepository.acknowledgeArchiveTerminal(mainDb, id, taskRunId)
      ),
      failPreFundReconciliationRunMirror: (id, error) => mirrorRepository.failRunMirror(mainDb, id, error),
      markPreFundReconciliationRunMirrorUnavailable: (id, status, message) => (
        mirrorRepository.markRunMirrorUnavailable(mainDb, id, status, message)
      ),
      listPreFundReconciliationRunMirrors: () => mirrorRepository.listRunMirrors(mainDb)
    };
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '0', ReconciliationId: 'R-ZERO' })
    ]);
    let snapshotDb = null;
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      openGatewayReadSnapshot() {
        snapshotDb = new DatabaseSync(mainDbPath, { readOnly: true });
        snapshotDb.exec('PRAGMA query_only = ON;');
        snapshotDb.exec('BEGIN');
        return {
          db: snapshotDb,
          close() {
            snapshotDb.exec('ROLLBACK');
            snapshotDb.close();
          }
        };
      }
    });
    importBankV1(service, bankFile);
    const originalFinishRun = service.runStore.finishRun.bind(service.runStore);
    service.runStore.finishRun = (sideDb, runId, stats) => {
      const sourceId = mainDb.prepare(`
        SELECT id FROM linked_gateway_bill WHERE recon_bill_biz_id = 'B-DUP-KEPT'
      `).get().id;
      const snapshotRaw = linkedTableRepository.getGatewayBillRawJsonById(snapshotDb, sourceId);
      assert.equal(JSON.parse(snapshotRaw).Extra, 'snapshot-old');
      originalFinishRun(sideDb, runId, stats);
      throw new Error('injected-after-snapshot-proof');
    };

    try {
      await assert.rejects(
        () => runV1(service, {
          onProgress(progress) {
            if (progress.stage !== 'gateway-pool' || progress.current !== 5000) return;
            mainDb.prepare('INSERT INTO isolation_probe (value) VALUES (?)').run('committed');
            const changed = { ...gatewayRows[5000], Extra: 'shared-new' };
            mainDb.prepare(`
              UPDATE linked_gateway_bill
              SET raw_json = ?, imported_at = ?
              WHERE recon_bill_biz_id = 'B-DUP-KEPT'
            `).run(JSON.stringify(changed), '2026-07-02T00:00:00.000Z');
          }
        }),
        /injected-after-snapshot-proof/
      );
      assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM isolation_probe').get().count, 1);
      const current = mainDb.prepare(`
        SELECT raw_json FROM linked_gateway_bill WHERE recon_bill_biz_id = 'B-DUP-KEPT'
      `).get();
      assert.equal(JSON.parse(current.raw_json).Extra, 'shared-new');
    } finally {
      mainDb.close();
    }
  });

  test('startup marks unfinished runs interrupted and successful mirrors with missing side DB unavailable', () => {
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 0 }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const runningId = mirrorRepository.createLegacyRunMirror(database._mirrorDb, {
      monthKey: '2026-06', sideRunId: 1, scenario: 'missing-gateway', snapshotHash: 'a',
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-06.sqlite'
    });
    const missingId = mirrorRepository.createLegacyRunMirror(database._mirrorDb, {
      monthKey: '2026-05', sideRunId: 2, scenario: 'missing-gateway', snapshotHash: 'b',
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-05.sqlite'
    });
    database.finishPreFundReconciliationRunMirror(missingId, { matchedPairs: 1 });
    const expiringSideDb = runDataStore.openSideDb(
      userDataDir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      '2026-04'
    );
    expiringSideDb.prepare(`
      INSERT INTO pre_fund_reconciliation_runs
        (id, scenario, snapshot_json, bank_files_json, status, summary_json)
      VALUES (3, 'missing-gateway', '{}', '[]', 'success', '{}')
    `).run();
    expiringSideDb.close();
    const expiringId = mirrorRepository.createLegacyRunMirror(database._mirrorDb, {
      monthKey: '2026-04', sideRunId: 3, scenario: 'missing-gateway', snapshotHash: 'c',
      sideDbRelPath: runDataStore.sideDbRelPath(
        runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
        '2026-04'
      )
    });
    database.finishPreFundReconciliationRunMirror(expiringId, { matchedPairs: 1 });

    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    service.reconcilePersistedRunMirrors();

    assert.equal(mirrorRepository.getRunMirror(database._mirrorDb, runningId).status, 'interrupted');
    assert.equal(mirrorRepository.getRunMirror(database._mirrorDb, missingId).status, 'missing-side-db');
    assert.equal(mirrorRepository.getRunMirror(database._mirrorDb, expiringId).status, 'expired');
    assert.equal(
      runDataStore.listSideDbFiles(
        userDataDir,
        runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS
      ).length,
      0
    );
  });

  test('recovery 以 TaskRun 定位同月复用 sideRunId，并闭合缺失或 running 的精确镜像', () => {
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 0 }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    const oldId = mirrorRepository.createLegacyRunMirror(database._mirrorDb, {
      monthKey: '2026-07', sideRunId: 1, scenario: 'missing-gateway',
      snapshotHash: 'old', sideDbRelPath: 'result.sqlite'
    });
    mirrorRepository.finishRunMirror(database._mirrorDb, oldId, { matchedPairs: 0 });

    const missingReceipt = {
      id: 1,
      monthKey: '2026-07',
      scenario: 'missing-gateway',
      summary: { matchedPairs: 1 },
      snapshot: { source: 'new' },
      bankFiles: ['bank.xlsx'],
      sideDbRelPath: 'result.sqlite',
      archiveTaskRunId: 'task-new-missing'
    };
    const recoveredMissing = service.recoverRunMirror(missingReceipt, { createIfMissing: true });
    assert.notEqual(recoveredMissing.id, oldId);
    assert.equal(recoveredMissing.archiveTaskRunId, 'task-new-missing');
    assert.equal(recoveredMissing.status, 'success');

    const runningReceipt = {
      ...missingReceipt,
      archiveTaskRunId: 'task-new-running',
      summary: { matchedPairs: 2 }
    };
    const runningId = mirrorRepository.createRunMirror(database._mirrorDb, {
      monthKey: runningReceipt.monthKey,
      sideRunId: runningReceipt.id,
      scenario: runningReceipt.scenario,
      snapshotHash: 'running',
      bankFiles: runningReceipt.bankFiles,
      sideDbRelPath: runningReceipt.sideDbRelPath,
      archiveReceipt: { archiveTaskRunId: runningReceipt.archiveTaskRunId }
    });
    const recoveredRunning = service.recoverRunMirror(runningReceipt, { createIfMissing: true });
    assert.equal(recoveredRunning.id, runningId);
    assert.equal(recoveredRunning.status, 'success');
    assert.deepEqual(recoveredRunning.summary, { matchedPairs: 2 });
  });

  test('new run supersedes the previous mirror and replaces the whole result side DB', async () => {
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-1' })
    ]);
    const persistentRows = [{
      id: 1,
      reconciliationId: 'R-1',
      row: {
        Billdate: '2026-07-01', reconciliationid: 'R-1', currency: 'USD', amount: '10',
        Channel: 'CIT', MerchantId: 'M-1', OrderId: 'G-1', ReconBillBizId: 'B-1',
        TradeType: 'Inbound-VA'
      }
    }];
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    importBankV1(service, bankFile);

    const first = await runV1(service);
    const firstLocator = service.lastRunLocator();
    const firstLineage = service.lastRunLineageIntent();
    const firstPlan = service.buildExportPlan(path.join(userDataDir, 'same-name'));
    const firstSidePath = runDataStore.sideDbPath(
      userDataDir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      first.monthKey
    );
    const firstSideStat = fs.statSync(firstSidePath);
    await assert.rejects(() => runV1(service), /Archive terminal 尚未确认/);
    assert.equal(
      mirrorRepository.getRunMirror(database._mirrorDb, first.runId).status,
      'success',
      '未 ACK 时新 run 不先改主库 mirror'
    );
    assert.equal(fs.statSync(firstSidePath).ino, firstSideStat.ino, '未 ACK 时不删除结果侧库');
    const acknowledgeSide = service.runStore.acknowledgeArchiveTerminal.bind(service.runStore);
    service.runStore.acknowledgeArchiveTerminal = () => {
      throw new Error('injected-side-ack-failure');
    };
    assert.throws(
      () => service.acknowledgeRunByTaskRun(firstLocator.archiveTaskRunId),
      /injected-side-ack-failure/
    );
    const mainAcknowledgedAt = mirrorRepository.getRunMirror(
      database._mirrorDb,
      first.runId
    ).archiveTerminalAckAt;
    assert.ok(mainAcknowledgedAt, '跨库 ACK 固定先提交 main mirror');
    assert.equal(
      service.runStore.getRunByArchiveTaskRunId(firstLocator.archiveTaskRunId)
        .archiveTerminalAckAt,
      null,
      'side ACK 失败时保留未确认 receipt 供重放'
    );
    service.runStore.acknowledgeArchiveTerminal = acknowledgeSide;
    service.acknowledgeRunByTaskRun(firstLocator.archiveTaskRunId);
    assert.equal(
      mirrorRepository.getRunMirror(database._mirrorDb, first.runId).archiveTerminalAckAt,
      mainAcknowledgedAt,
      '重放 main ACK 幂等且不会改写首次确认时间'
    );
    assert.ok(
      service.runStore.getRunByArchiveTaskRunId(firstLocator.archiveTaskRunId)
        .archiveTerminalAckAt
    );
    const second = await runV1(service);
    const secondLocator = service.lastRunLocator();
    const secondLineage = service.lastRunLineageIntent();
    const secondPlan = service.buildExportPlan(path.join(userDataDir, 'same-name'));
    const mirrors = mirrorRepository.listRunMirrors(database._mirrorDb);
    assert.deepEqual(mirrors.map((mirror) => mirror.status), ['superseded', 'success']);
    assert.notEqual(first.runId, second.runId);
    assert.equal(firstLocator.sideRunId, secondLocator.sideRunId, '结果侧库重建后 sideRunId 可复用');
    assert.notEqual(firstLocator.mirrorRunId, secondLocator.mirrorRunId);
    assert.notEqual(firstLineage.lineageKey, secondLineage.lineageKey);
    assert.deepEqual(firstPlan.map((item) => item.filePath), secondPlan.map((item) => item.filePath));
    await assert.rejects(
      () => service.export({
        outputDirectory: path.join(userDataDir, 'same-name'),
        runLocator: firstLocator
      }),
      /run 已变化/
    );

    const files = runDataStore.listSideDbFiles(
      userDataDir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS
    );
    assert.equal(files.length, 1);
    const db = runDataStore.openExistingSideDb(files[0].path);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_runs').get().count, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pre_fund_reconciliation_gateway_pool').get().count, 1);
    } finally {
      db.close();
    }
  });

  test('runtime result side-DB loss disables export and marks the mirror unavailable', async () => {
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-1' })
    ]);
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => [{
        id: 1,
        reconciliationId: 'R-1',
        row: {
          Billdate: '2026-07-01', Channel: 'CIT', reconciliationid: 'R-1',
          currency: 'USD', amount: '10', TradeType: 'Inbound-VA'
        }
      }].values()
    });
    const service = makeService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    importBankV1(service, bankFile);
    const run = await runV1(service);
    const resultPath = runDataStore.sideDbPath(
      userDataDir,
      runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
      service.lastRun.monthKey
    );
    runDataStore.deleteSideDbByPath(resultPath);

    const status = service.status();
    assert.equal(status.canExport, false);
    assert.equal(status.run.unavailable, true);
    assert.match(status.run.unavailableMessage, /结果侧库文件不存在/);
    assert.equal(mirrorRepository.getRunMirror(database._mirrorDb, run.runId).status, 'missing-side-db');
    assert.throws(
      () => service.buildExportPlan(path.join(userDataDir, 'exports')),
      (error) => error && error.code === 'pre-fund-run-unavailable'
    );
  });

  test('external file created after conflict check is neither overwritten nor deleted by rollback', async () => {
    const outputDirectory = path.join(userDataDir, 'race-exports');
    const fileName = '资金对账不平_RACE_2026年07月10日.xlsx';
    const filePath = path.join(outputDirectory, fileName);
    const service = Object.create(PreFundReconciliationService.prototype);
    service.now = () => new Date(2026, 6, 10, 12, 0, 0);
    service.templatePath = path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx');
    service.lastRun = { monthKey: '2026-07', sideRunId: 1 };
    service._buildExportPlanForCurrentRun = () => [{ channel: 'RACE', fileName, filePath }];
    service.runStore = {
      *iterateChannelExports() {
        yield {
          channel: 'RACE',
          hasDuplicateRecords: false,
          unbalancedRows: [],
          balancedRows: [],
          channelBillRows: []
        };
      }
    };

    const originalLinkSync = fs.linkSync;
    let injected = false;
    fs.linkSync = (sourcePath, destinationPath) => {
      if (!injected && destinationPath === filePath) {
        injected = true;
        fs.writeFileSync(filePath, 'EXTERNAL-CONTENT');
      }
      return originalLinkSync(sourcePath, destinationPath);
    };
    try {
      await assert.rejects(
        () => exportV1(service, { outputDirectory }),
        /目标文件已存在，未覆盖/
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }

    assert.equal(fs.readFileSync(filePath, 'utf8'), 'EXTERNAL-CONTENT');
    assert.deepEqual(fs.readdirSync(outputDirectory).filter((name) => name.includes('.tmp.xlsx')), []);
  });

  test('overwrite export succeeds through no-clobber copy fallback when hard links are unsupported', async () => {
    const outputDirectory = path.join(userDataDir, 'fallback-exports');
    const fileName = '资金对账不平_FALLBACK_2026年07月10日.xlsx';
    const filePath = path.join(outputDirectory, fileName);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(filePath, 'OLD-CONTENT');

    const service = Object.create(PreFundReconciliationService.prototype);
    service.now = () => new Date(2026, 6, 10, 12, 0, 0);
    service.templatePath = path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx');
    service.lastRun = { monthKey: '2026-07', sideRunId: 1 };
    service._buildExportPlanForCurrentRun = () => [{ channel: 'FALLBACK', fileName, filePath }];
    service.runStore = {
      *iterateChannelExports() {
        yield {
          channel: 'FALLBACK',
          hasDuplicateRecords: false,
          unbalancedRows: [],
          balancedRows: [],
          channelBillRows: []
        };
      }
    };

    const originalLinkSync = fs.linkSync;
    fs.linkSync = () => {
      const error = new Error('hard links unsupported');
      error.code = 'ENOTSUP';
      throw error;
    };
    let exported;
    try {
      exported = await exportV1(service, { outputDirectory, overwrite: true });
    } finally {
      fs.linkSync = originalLinkSync;
    }

    assert.equal(exported.status, 'ok');
    assert.deepEqual(XLSX.readFile(filePath).SheetNames, [
      '不平结果', '平账结果', '网关账单', '渠道账单', '订单修复'
    ]);
    assert.deepEqual(fs.readdirSync(outputDirectory).filter((name) => name.endsWith('.bak')), []);
  });

  test('partial backup failure preserves every pre-existing export file', async () => {
    const outputDirectory = path.join(userDataDir, 'exports');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const firstPath = path.join(outputDirectory, 'first.xlsx');
    const secondPath = path.join(outputDirectory, 'second.xlsx');
    fs.writeFileSync(firstPath, 'FIRST-ORIGINAL');
    fs.writeFileSync(secondPath, 'SECOND-ORIGINAL');

    const service = Object.create(PreFundReconciliationService.prototype);
    service.now = () => new Date(2026, 6, 10, 12, 0, 0);
    service.lastRun = { monthKey: '2026-07', sideRunId: 1, archiveTaskRunId: 'export-task' };
    service._buildExportPlanForCurrentRun = () => [
      { channel: 'A', fileName: 'first.xlsx', filePath: firstPath },
      { channel: 'B', fileName: 'second.xlsx', filePath: secondPath }
    ];

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (source === secondPath) throw new Error('simulated second backup failure');
      return originalRenameSync(source, destination);
    };
    try {
      await assert.rejects(
        () => exportV1(service, { outputDirectory, overwrite: true }),
        /simulated second backup failure/
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(fs.readFileSync(firstPath, 'utf8'), 'FIRST-ORIGINAL');
    assert.equal(fs.readFileSync(secondPath, 'utf8'), 'SECOND-ORIGINAL');
  });
});
