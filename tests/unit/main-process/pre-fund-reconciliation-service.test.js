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
  ensurePreFundReconciliationRunMetadataSupport
} = require('../../../src/backend/database/migrations');
const mirrorRepository = require('../../../src/backend/database/pre-fund-reconciliation-run-repository');
const runDataStore = require('../../../src/backend/run-data-store');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER,
  SOURCE_TYPE_INBOUND
} = require('../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  createPreFundReconciliationService
} = require('../../../src/main-process/pre-fund-reconciliation/service');

function bankRow(values = {}) {
  return BANK_STATEMENT_FIELDS.map((field) => values[field] ?? '');
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
  return Object.assign(database, {
    _mirrorDb: mirrorDb,
    createPreFundReconciliationRunMirror: (payload) => mirrorRepository.createRunMirror(mirrorDb, payload),
    finishPreFundReconciliationRunMirror: (id, summary) => mirrorRepository.finishRunMirror(mirrorDb, id, summary),
    failPreFundReconciliationRunMirror: (id, error) => mirrorRepository.failRunMirror(mirrorDb, id, error),
    markPreFundReconciliationRunMirrorUnavailable: (id, status, message) => (
      mirrorRepository.markRunMirrorUnavailable(mirrorDb, id, status, message)
    ),
    listPreFundReconciliationRunMirrors: () => mirrorRepository.listRunMirrors(mirrorDb)
  });
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

function writeMptFile(filePath, rows) {
  const header = ['20260708', 'MPT_INBOUND_20260708', String(rows.length)];
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
    const persistentRows = [{
      id: 1,
      reconciliationId: 'R-1',
      billDate: '2026-07-01',
      reconBillBizId: 'RB-1',
      row: {
        Billdate: '2026-07-01', Channel: 'CIT', merchantid: 'M-1', orderid: 'G-1',
        ReconBillBizId: 'RB-1', reconciliationid: 'R-1', currency: 'USD', amount: '10.00',
        TradeType: 'INBOUND', name: 'Gateway Name', cardNo: 'Gateway Card',
        '真实渠道': 'CIT', '清算网络': 'VISA'
      }
    }];
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({
        tableKey: 'gateway-bill', rowCount: 1, dataDateMin: '2026-07-01',
        dataDateMax: '2026-07-01', sourceFileName: 'gateway.xlsx', updatedAt: '2026-07-10T00:00:00Z'
      }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });

    const imported = service.importBank(bankFile);
    assert.equal(imported.acceptedRows, 2);
    assert.equal(imported.excludedEmptyIdRows, 1);
    assert.equal(imported.skippedZeroRows, 1);

    const result = await service.run();
    assert.equal(result.summary.bankInputRows, 4);
    assert.equal(result.summary.bankValidRows, 2);
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
        OrderId: `G-${index + 1}`
      }
    }));
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 4, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    service.importBank(bankFile);

    const result = await service.run();
    assert.equal(result.summary.matchedPairs, 1);
    assert.equal(result.summary.unmatchedBankRows, 3);
    assert.equal(result.summary.unusedGatewayRows, 3);
    const exports = [...service.runStore.iterateChannelExports(result.monthKey, service.lastRun.sideRunId)];
    assert.equal([...exports[0].balancedRows].length, 1);
    assert.equal([...exports[0].unbalancedRows].length, 3);
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
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });
    service.importBank(bankFile);

    await assert.rejects(
      () => service.run(),
      (error) => error && error.code === 'pre-fund-gateway-pool-empty'
    );
    assert.equal(service.status().canExport, false);
    assert.equal(mirrorRepository.listRunMirrors(database._mirrorDb)[0].status, 'failed');
  });

  test('same-month temporary MPT runs and exports the real five-sheet template, then source deletion invalidates export', async () => {
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
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({
        tableKey: 'gateway-bill', rowCount: 0, dataDateMin: null, dataDateMax: null,
        sourceFileName: null, updatedAt: null
      }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.resolve(__dirname, '../../../assets/资金对账导出不平.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });

    service.importBank(bankFile);
    const importedMpt = await service.importMptFiles([mptFile]);
    assert.equal(importedMpt.successCount, 1, JSON.stringify(importedMpt));
    assert.equal(importedMpt.results[0].sourceType, SOURCE_TYPE_INBOUND);
    assert.equal(importedMpt.results[0].rowCount, 1, '导入汇总显示实际落库行数');
    const run = await service.run();
    assert.equal(run.summary.matchedPairs, 1);
    assert.equal(run.summary.unmatchedBankRows, 1);
    assert.equal(run.summary.tempGatewayRawRows, 1);

    const outputDirectory = path.join(userDataDir, 'exports');
    const exported = await service.export({ outputDirectory });
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
    assert.throws(
      () => service.countTempByDateRange({ start: '2026-07-08', end: '2026-07-08' }),
      /请选择临时中台入金或出金网关账单表库/
    );
    assert.deepEqual(await service.deleteTempByDateRange({
      start: '2026-07-08',
      end: '2026-07-08',
      sourceType: SOURCE_TYPE_INBOUND
    }), {
      deletedFiles: 1,
      deletedBatches: 1,
      deletedRows: 1
    });
    assert.equal(service.status().run.stale, true);
    assert.equal(service.status().canExport, false);
    await assert.rejects(
      () => service.export({ outputDirectory: path.join(userDataDir, 'exports-2') }),
      (error) => error && error.code === 'pre-fund-run-stale'
    );
  });

  test('startup marks unfinished runs interrupted and successful mirrors with missing side DB unavailable', () => {
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 0 }),
      iterateGatewayBillRows: () => [][Symbol.iterator]()
    });
    const runningId = database.createPreFundReconciliationRunMirror({
      monthKey: '2026-06', sideRunId: 1, scenario: 'missing-gateway', snapshotHash: 'a',
      sideDbRelPath: 'run-data/pre-fund-reconciliation/month-2026-06.sqlite'
    });
    const missingId = database.createPreFundReconciliationRunMirror({
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
    const expiringId = database.createPreFundReconciliationRunMirror({
      monthKey: '2026-04', sideRunId: 3, scenario: 'missing-gateway', snapshotHash: 'c',
      sideDbRelPath: runDataStore.sideDbRelPath(
        runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
        '2026-04'
      )
    });
    database.finishPreFundReconciliationRunMirror(expiringId, { matchedPairs: 1 });

    createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx')
    });

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

  test('new run supersedes the previous mirror and replaces the whole result side DB', async () => {
    writeBankFile(bankFile, [
      bankRow({ Channel: 'CIT', Currency: 'USD', 'Credit Amount': '10', ReconciliationId: 'R-1' })
    ]);
    const persistentRows = [{
      id: 1,
      reconciliationId: 'R-1',
      row: {
        Billdate: '2026-07-01', reconciliationid: 'R-1', currency: 'USD', amount: '10',
        Channel: 'CIT', MerchantId: 'M-1', OrderId: 'G-1', ReconBillBizId: 'B-1'
      }
    }];
    const database = attachRunMirrorRepository({
      getLinkedTableMeta: () => ({ tableKey: 'gateway-bill', rowCount: 1, updatedAt: 'x' }),
      iterateGatewayBillRows: () => persistentRows.values()
    });
    const service = createPreFundReconciliationService({
      userDataDir,
      database,
      templatePath: path.join(userDataDir, 'unused.xlsx'),
      now: () => new Date(2026, 6, 10, 12, 0, 0)
    });
    service.importBank(bankFile);

    const first = await service.run();
    const second = await service.run();
    const mirrors = mirrorRepository.listRunMirrors(database._mirrorDb);
    assert.deepEqual(mirrors.map((mirror) => mirror.status), ['superseded', 'success']);
    assert.notEqual(first.runId, second.runId);

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
});
