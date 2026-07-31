'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const {
  createPositionReconciliationService,
  assertEngineResultSet
} = require('../../../src/main-process/position-reconciliation/service');
const {
  SCHEMA: POSITION_RECONCILIATION_SCHEMA,
  POSITION_DB_INITIALIZATION_MODES,
  createPositionReconciliationStore
} = require('../../../src/main-process/position-reconciliation/store');
const {
  ensurePositionLargeImportSchemaAtPath
} = require('../../../src/main-process/position-reconciliation/large-import-schema');
const {
  dispatchPositionLargeImportSchemaMigration
} = require('../../../src/main-process/position-reconciliation/import-dispatch');
const {
  positionCommittedRecoveryArchiveFiles,
  requirePositionPendingArchiveFiles
} = require('../../../src/main-process/position-reconciliation/operation-lifecycle');
const {
  STAGING_RELATIVE_PATH,
  hashFileSha256Sync,
  filterStagingPathsWithoutProtectedSources,
  pruneStagingRoot
} = require('../../../src/main-process/position-reconciliation/input-staging');
const {
  sourceSnapshotFromStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  BANK_SHEET_NAME,
  POSITION_DB_RELATIVE_PATH,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES,
  SOURCE_DISPLAY_ORDER
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../../../src/constants/bank-statement-fields');
const {
  POSITION_IMPORT_COMMANDS
} = require('../../../src/backend/position-reconciliation-import/constants');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filePath);
}

function mutateFileSameLength(filePath) {
  const before = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  assert.ok(content.length > 0, '故障注入文件不能为空');
  content[content.length - 1] ^= 0x01;
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, before.atime, before.mtime);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'POSITION-BIZ-1',
    BillDate: '2026-07-20',
    Channel: 'DBS',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: 'RID-1',
    FundType: 'Inbound&FX',
    ...overrides
  };
}

function inboundRow(overrides = {}) {
  return {
    bizId: 'INBOUND-1',
    billDate: '2026-07-20',
    tradeType: 'Inbound-VA',
    reconId: 'RID-1',
    channel: 'DBS',
    merchantId: 'M001',
    currency: 'USD',
    amount: '100',
    originOutboundCurrency: 'USD',
    ...overrides
  };
}

function transferRow(overrides = {}) {
  return {
    调拨单号: 'TRANSFER-1',
    调拨状态: '付款成功',
    渠道流水号: 'TRANSFER-RID-1',
    交易时间: '2026-06-20',
    '付款账户（卡号）': 'PAY-001',
    '收款账户（卡号）': 'RECEIVE-001',
    付款金额: '100',
    付款币种: 'USD',
    收款金额: '95',
    收款币种: 'EUR',
    ...overrides
  };
}

const LEGACY_POSITION_TABLES = Object.freeze([
  'position_meta',
  'position_revisions',
  'position_bank_rows',
  'position_source_rows',
  'position_link_rows',
  'position_account_mappings',
  'position_runs',
  'position_run_rows',
  'position_differences',
  'position_consumed_sources'
]);

function createEmptyLegacyPositionDatabase(userDataDir) {
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(POSITION_RECONCILIATION_SCHEMA);
  db.exec(`
    DROP INDEX idx_position_bank_scope_dates;
    DROP TABLE position_source_summaries;
    DROP TABLE position_operation_inputs;
    DROP TABLE position_checkpoint_history;
    ALTER TABLE position_run_rows DROP COLUMN integrity_hash;
    ALTER TABLE position_run_rows DROP COLUMN consumes_source;
  `);
  db.close();
  return dbPath;
}

function insertLegacyPlaceholderRow(db, table) {
  db.exec('PRAGMA foreign_keys = OFF;');
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all().filter((column) => (
    !(Number(column.pk) === 1 && String(column.type).toUpperCase() === 'INTEGER')
    && column.dflt_value === null
    && (Number(column.notnull) === 1 || Number(column.pk) > 0)
  ));
  const values = columns.map((column) => (
    String(column.type).toUpperCase() === 'INTEGER'
      ? 1
      : `${table}-${column.name}`
  ));
  db.prepare(`
    INSERT INTO "${table}"(${columns.map((column) => `"${column.name}"`).join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).run(...values);
}

test('链接管理和原始表始终按业务规定顺序返回', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-order-contract-'));
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const manager = service.linkedManager();
  assert.deepEqual(manager.linked.map((row) => row.sourceType), [...SOURCE_DISPLAY_ORDER]);
  assert.deepEqual(manager.raw.map((row) => row.sourceType), [...SOURCE_DISPLAY_ORDER]);
});

test('链接管理汇总缓存随导入和删除原子刷新，损坏时回退事实表', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-summary-cache-'));
  const sourcePath = path.join(userDataDir, 'gateway-inbound.xlsx');
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ originOutboundCurrency: 'EUR' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    positionImportEngine: 'disabled',
    operationTokenProvider: () => 'source-summary-cache-operation'
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  let manager = service.linkedManager();
  assert.equal(
    manager.raw.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    1
  );
  assert.equal(
    manager.linked.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    1
  );
  assert.deepEqual(manager.sourceMonths[SOURCE_TYPES.GATEWAY_INBOUND], ['2026-07']);

  service.store.db.prepare(`
    UPDATE position_source_summaries
    SET source_months_json = '{'
    WHERE source_type = ?
  `).run(SOURCE_TYPES.GATEWAY_INBOUND);
  manager = service.linkedManager();
  assert.equal(
    manager.raw.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    1,
    '缓存损坏时原始表汇总必须回退事实表'
  );
  assert.equal(
    manager.linked.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    1,
    '缓存损坏时链接表汇总必须回退事实表'
  );
  assert.deepEqual(manager.sourceMonths[SOURCE_TYPES.GATEWAY_INBOUND], ['2026-07']);

  service.store.deleteSource({
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    months: ['2026-07']
  });
  manager = service.linkedManager();
  assert.equal(
    manager.raw.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    0
  );
  assert.equal(
    manager.linked.find((row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND).rowCount,
    0
  );
  assert.deepEqual(manager.sourceMonths[SOURCE_TYPES.GATEWAY_INBOUND], []);
});

test('银行管理快照单次聚合范围、总数、日期和状态并使用覆盖索引', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-manager-'));
  const store = createPositionReconciliationStore(userDataDir);
  t.after(() => {
    store.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  const insert = store.db.prepare(`
    INSERT INTO position_bank_rows(
      biz_id, channel, month_key, bill_date, status,
      source_file_path, source_file_name, source_sheet, source_row_number,
      import_order, original_json, working_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')
  `);
  insert.run(
    'MANAGER-1', 'DBS', '2026-06', '2026-06-30', '未处理',
    '/tmp/a.xlsx', 'a.xlsx', BANK_SHEET_NAME, 2, 0
  );
  insert.run(
    'MANAGER-2', 'DBS', '2026-07', '2026-07-01', '已校验性质',
    '/tmp/b.xlsx', 'b.xlsx', BANK_SHEET_NAME, 2, 1
  );
  insert.run(
    'MANAGER-3', 'JPM', '2026-07', '2026-07-31', '未处理',
    '/tmp/c.xlsx', 'c.xlsx', BANK_SHEET_NAME, 2, 2
  );

  const snapshot = store.getBankManagerSnapshot();
  assert.equal(snapshot.summary.rowCount, 3);
  assert.equal(snapshot.summary.dateMin, '2026-06-30');
  assert.equal(snapshot.summary.dateMax, '2026-07-31');
  assert.deepEqual(snapshot.summary.statuses, [
    { status: '已校验性质', rowCount: 1 },
    { status: '未处理', rowCount: 2 }
  ]);
  assert.equal(snapshot.scopes.length, 3);

  const plan = store.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT channel, month_key, status, COUNT(*), MIN(bill_date), MAX(bill_date)
    FROM position_bank_rows
    GROUP BY channel, month_key, status
    ORDER BY channel COLLATE NOCASE, month_key, status
  `).all().map((row) => String(row.detail || '')).join('\n');
  assert.match(plan, /COVERING INDEX idx_position_bank_scope_dates/);
});

test('现代来源身份下旧小文件路径保留同业务主键的不同内容', (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-modern-legacy-source-path-')
  );
  const checkpoint = {
    identity: 'modern-legacy-source-identity',
    generation: 0,
    token: 'modern-legacy-source-token'
  };
  let store = createPositionReconciliationStore(userDataDir, {
    initialCheckpoint: checkpoint
  });
  const sideDbPath = store.dbPath;
  store.close();
  ensurePositionLargeImportSchemaAtPath({
    sideDbPath,
    expectedCheckpoint: checkpoint,
    availableBytesProvider: () => 10n ** 15n
  });
  store = createPositionReconciliationStore(userDataDir, {
    expectedCheckpoint: checkpoint
  });
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    store,
    positionImportEngine: 'disabled',
    operationTokenProvider: () => 'modern-legacy-source-operation'
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const sourcePath = path.join(userDataDir, 'same-business-key.xlsx');
  const definition = SOURCE_DEFINITIONS[SOURCE_TYPES.TEST_PAYMENT];
  const common = {
    付款单号: 'SAME-PAYMENT-ORDER',
    付款状态: '付款成功',
    源金额: '100',
    源币种: 'USD',
    目标金额: '95',
    目标币种: 'EUR',
    创建时间: '2026-07-20'
  };
  writeWorkbook(sourcePath, '账单明细', definition.headers, [
    {
      ...common,
      渠道流水号: 'SAME-PAYMENT-RID-1',
      付款渠道: 'CHANNEL-A'
    },
    {
      ...common,
      渠道流水号: 'SAME-PAYMENT-RID-2',
      付款渠道: 'CHANNEL-B'
    }
  ]);

  const result = service.prepareSourceImport([sourcePath]);
  assert.equal(result.successCount, 1);
  assert.equal(result.results[0].rowCount, 2);
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.TEST_PAYMENT), 2);
  const links = service.store.listLinkRows(
    SOURCE_TYPES.TEST_PAYMENT,
    { includeHidden: true }
  );
  assert.equal(links.length, 2);
  assert.equal(new Set(links.map((row) => row.business_key)).size, 1);
  assert.equal(new Set(links.map((row) => row.source_record_key)).size, 2);
});

test('同业务主键的不同来源记录可分别匹配并独立消费', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-modern-source-consumption-')
  );
  const checkpoint = {
    identity: 'modern-source-consumption-identity',
    generation: 0,
    token: 'modern-source-consumption-token'
  };
  let store = createPositionReconciliationStore(userDataDir, {
    initialCheckpoint: checkpoint
  });
  const sideDbPath = store.dbPath;
  store.close();
  ensurePositionLargeImportSchemaAtPath({
    sideDbPath,
    expectedCheckpoint: checkpoint,
    availableBytesProvider: () => 10n ** 15n
  });
  store = createPositionReconciliationStore(userDataDir, {
    expectedCheckpoint: checkpoint
  });
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    store,
    positionImportEngine: 'disabled'
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const bankPath = path.join(userDataDir, 'same-key-bank.xlsx');
  const sourcePath = path.join(userDataDir, 'same-key-outbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({
      BizId: 'SAME-KEY-BANK-1',
      MerchantId: 'M001',
      Currency: 'USD',
      'Credit Amount': '0',
      'Debit Amount': '100',
      ReconciliationId: 'SAME-KEY-RID-1',
      FundType: 'outbound'
    }),
    bankRow({
      BizId: 'SAME-KEY-BANK-2',
      MerchantId: 'M001',
      Currency: 'USD',
      'Credit Amount': '0',
      'Debit Amount': '200',
      ReconciliationId: 'SAME-KEY-RID-2',
      FundType: 'outbound'
    })
  ]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND].headers,
    [
      {
        账单日期: '2026-07-20',
        渠道名称: 'DBS',
        账户号: 'M001',
        交易类型: 'Outbound',
        主对账id: 'SAME-KEY-RID-1',
        业务单号: 'SAME-OUTBOUND-ORDER',
        币种: 'EUR',
        金额: '100',
        原始币种: 'EUR',
        原始金额: '100',
        银行扣款币种: 'USD'
      },
      {
        账单日期: '2026-07-20',
        渠道名称: 'DBS',
        账户号: 'M001',
        交易类型: 'Outbound',
        主对账id: 'SAME-KEY-RID-2',
        业务单号: 'SAME-OUTBOUND-ORDER',
        币种: 'EUR',
        金额: '200',
        原始币种: 'EUR',
        原始金额: '200',
        银行扣款币种: 'USD'
      }
    ]
  );

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(run.summary.changedRows, 2);
  assert.equal(run.summary.differenceRows, 0);
  const runRows = service.store.listRunRows(run.runId);
  assert.equal(new Set(runRows.map((row) => row.lineage.sourceBusinessKey)).size, 1);
  assert.equal(new Set(runRows.map((row) => row.lineage.sourceRecordKey)).size, 2);

  await service.exportRun(
    run.runId,
    path.join(userDataDir, 'same-key-result.xlsx')
  );
  service.confirmRun(run.runId);
  const consumption = service.store.db.prepare(`
    SELECT COUNT(*) AS rowCount,
           COUNT(DISTINCT business_key) AS businessKeyCount,
           COUNT(DISTINCT source_record_key) AS sourceRecordKeyCount
    FROM position_consumed_sources
    WHERE business_key = 'SAME-OUTBOUND-ORDER'
  `).get();
  assert.equal(consumption.rowCount, 2);
  assert.equal(consumption.businessKeyCount, 1);
  assert.equal(consumption.sourceRecordKeyCount, 2);
});

test('流式来源配置收窄时未启用来源明确失败且不得自动回退旧路径', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-streaming-hybrid-source-path-')
  );
  const checkpoint = {
    identity: 'streaming-hybrid-source-identity',
    generation: 0,
    token: 'streaming-hybrid-source-token'
  };
  const outboundPath = path.join(userDataDir, 'gateway-outbound.xlsx');
  const paymentPath = path.join(userDataDir, 'test-payment.xlsx');
  writeWorkbook(
    outboundPath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND].headers,
    [{
      账单日期: '2026-07-20',
      渠道名称: 'DBS',
      账户号: 'M001',
      交易类型: 'Outbound',
      主对账id: 'OUT-HYBRID-RID',
      业务单号: 'OUT-HYBRID-ORDER',
      币种: 'USD',
      金额: '100',
      原始币种: 'EUR',
      原始金额: '95',
      银行扣款币种: 'USD'
    }]
  );
  writeWorkbook(
    paymentPath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.TEST_PAYMENT].headers,
    [{
      付款单号: 'PAYMENT-HYBRID-ORDER',
      付款状态: '付款成功',
      渠道流水号: 'PAYMENT-HYBRID-RID',
      源金额: '100',
      源币种: 'USD',
      目标金额: '95',
      目标币种: 'EUR',
      创建时间: '2026-07-20'
    }]
  );

  let service = null;
  service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: checkpoint,
    positionImportEngine: 'streaming',
    streamingSourceTypes: SOURCE_TYPES.GATEWAY_OUTBOUND,
    operationTokenProvider: () => 'streaming-hybrid-operation',
    authorizeStreamingSourceApply: async (ready) => {
      const schema = await dispatchPositionLargeImportSchemaMigration({
        engine: 'streaming',
        userDataDir,
        sideDbPath: service.store.dbPath,
        expectedCheckpoint: service.persistenceCheckpoint()
      }).promise;
      return {
        operationToken: 'streaming-hybrid-operation',
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schema.fingerprint,
        baseCheckpoint: service.persistenceCheckpoint()
      };
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = await service.prepareSourceImport([outboundPath, paymentPath]);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(
    result.results.map((item) => item.sourceType),
    [SOURCE_TYPES.GATEWAY_OUTBOUND, SOURCE_TYPES.TEST_PAYMENT]
  );
  assert.equal(
    service.store.countSourceRows(SOURCE_TYPES.GATEWAY_OUTBOUND),
    1
  );
  assert.equal(
    service.store.countSourceRows(SOURCE_TYPES.TEST_PAYMENT),
    0
  );
  assert.equal(service.persistenceCheckpoint().generation, 1);
  assert.equal(
    service.listCommittedOperationInputs('streaming-hybrid-operation').length,
    1
  );
  assert.equal(result.results[1].code, 'position-streaming-source-type-disabled');
});

test('普通来源 worker 退出恢复后 Service 保留已提交文件的存档证据', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-streaming-recovery-evidence-')
  );
  const stagedPath = path.join(userDataDir, 'committed-source.xlsx');
  fs.writeFileSync(stagedPath, 'committed');
  const evidence = {
    filePath: stagedPath,
    role: 'input',
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    originalName: 'committed-source.xlsx',
    sourceSnapshot: sourceSnapshotFromStat(fs.statSync(stagedPath)),
    expectedSha256: hashFileSha256Sync(stagedPath).sha256,
    sizeBytes: fs.statSync(stagedPath).size
  };
  const recovered = {
    status: 'ok',
    recoveredFromWorkerExit: true,
    results: [{
      status: 'ok',
      fileIndex: 0,
      filePath: '/original/source.xlsx',
      archivePath: stagedPath,
      stagingDir: path.dirname(stagedPath),
      sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
      sourceName: '中台网关原始出账订单',
      rowCount: 1
    }],
    inputPaths: [stagedPath],
    inputFiles: [evidence],
    cleanupPaths: [path.dirname(stagedPath)]
  };
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    positionImportEngine: 'streaming',
    operationTokenProvider: () => 'streaming-recovery-operation',
    authorizeStreamingSourceApply: async () => ({}),
    positionImportDispatcher: () => ({
      jobId: 'streaming-recovery-job',
      promise: Promise.resolve(recovered),
      cancel: () => true,
      terminate: () => true
    })
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = await service.prepareSourceImport(['/original/source.xlsx']);
  assert.deepEqual(result.inputPaths, [stagedPath]);
  assert.deepEqual(result.inputFiles, [evidence]);
  assert.equal(result.successCount, 1);
});

test('流式 service 完成银行确认、普通来源自动提交和账户快照确认替换', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-streaming-bank-account-service-')
  );
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const outboundPath = path.join(userDataDir, 'gateway-outbound.xlsx');
  const accountPath = path.join(userDataDir, 'bank-account.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    POSITION_BANK_HEADERS,
    [bankRow({ BizId: 'STREAMING-BANK-1' })]
  );
  writeWorkbook(
    outboundPath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND].headers,
    [{
      账单日期: '2026-07-20',
      渠道名称: 'DBS',
      账户号: 'M001',
      交易类型: 'Outbound',
      主对账id: 'STREAMING-OUT-RID',
      业务单号: 'STREAMING-OUT-ORDER',
      币种: 'USD',
      金额: '100',
      原始币种: 'EUR',
      原始金额: '95',
      银行扣款币种: 'USD'
    }]
  );
  const accountDefinition = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT];
  writeWorkbook(
    accountPath,
    '清结算银行账户表',
    accountDefinition.headers,
    [
      {
        账户状态: '正常',
        账户性质: '自有',
        币种: 'USD',
        银行账号: 'STREAMING-ACCOUNT-1'
      },
      {
        账户状态: '注销',
        账户性质: '自有',
        币种: 'EUR',
        银行账号: 'STREAMING-ACCOUNT-CLOSED'
      }
    ]
  );

  let service = null;
  let confirmedSequence = 0;
  let ordinarySequence = 0;
  service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    positionImportEngine: 'streaming',
    operationTokenProvider: () => `streaming-confirmed-${++confirmedSequence}`,
    authorizeStreamingSourceApply: async (ready) => {
      const baseCheckpoint = service.persistenceCheckpoint();
      const schema = await dispatchPositionLargeImportSchemaMigration({
        engine: 'streaming',
        userDataDir,
        sideDbPath: service.store.dbPath,
        expectedCheckpoint: baseCheckpoint
      }).promise;
      return {
        operationToken: `streaming-ordinary-${++ordinarySequence}`,
        archiveManifestHash: ready.archiveManifestHash,
        schemaFingerprint: schema.fingerprint,
        baseCheckpoint
      };
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const bankPrepared = await service.prepareBankImport([bankPath]);
  assert.equal(bankPrepared.status, 'needs-confirmation');
  assert.equal(bankPrepared.rowCount, 1);
  assert.equal(
    service.bankImportArchiveIntent(bankPrepared.token)[0].sourceType,
    'position-bank'
  );
  const bankApplied = await service.applyBankImport(bankPrepared.token);
  assert.equal(bankApplied.status, 'ok');
  assert.equal(bankApplied.rowCount, 1);
  assert.equal(service.persistenceCheckpoint().generation, 1);

  const sourcePrepared = await service.prepareSourceImport([outboundPath, accountPath]);
  assert.equal(sourcePrepared.successCount, 1);
  assert.equal(sourcePrepared.confirmationCount, 1);
  assert.deepEqual(
    sourcePrepared.results.map((item) => item.status),
    ['ok', 'needs-confirmation']
  );
  const accountItem = sourcePrepared.results.find(
    (item) => item.status === 'needs-confirmation'
  );
  assert.ok(accountItem && accountItem.token);
  assert.equal(
    service.sourceImportArchiveIntent(accountItem.token)[0].sourceType,
    SOURCE_TYPES.BANK_ACCOUNT
  );
  assert.equal(service.persistenceCheckpoint().generation, 2);

  const accountApplied = await service.applySourceImport(accountItem.token);
  assert.equal(accountApplied.status, 'ok');
  assert.equal(accountApplied.rowCount, 1);
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.BANK_ACCOUNT), 1);
  assert.equal(service.persistenceCheckpoint().generation, 3);
});

test('流式 service 通过 utility worker 删除来源并同步 checkpoint', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-streaming-maintenance-service-')
  );
  const sourcePath = path.join(userDataDir, 'gateway-inbound.xlsx');
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );

  let legacy = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    positionImportEngine: 'disabled',
    operationTokenProvider: () => 'maintenance-seed-operation'
  });
  assert.equal(legacy.prepareSourceImport([sourcePath]).successCount, 1);
  const checkpoint = legacy.persistenceCheckpoint();
  legacy.close();

  const store = createPositionReconciliationStore(userDataDir, {
    expectedCheckpoint: checkpoint
  });
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    store,
    positionImportEngine: 'streaming',
    operationTokenProvider: () => 'maintenance-delete-operation'
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = await service.deleteSource({
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    months: ['2026-07']
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.deletedCount, 1);
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 0);
  assert.equal(service.persistenceCheckpoint().generation, checkpoint.generation + 1);
});

test('流式导入取消由主进程跟踪，汇总与提交阶段拒绝取消', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-streaming-cancel-state-')
  );
  const jobs = new Map();
  let sequence = 0;
  const progressEvents = [];
  const dispatcher = (input) => {
    sequence += 1;
    const jobId = `cancel-state-${sequence}`;
    let resolveJob;
    const job = {
      input,
      cancelCount: 0,
      terminateCount: 0,
      resolve(value) {
        resolveJob(value);
      }
    };
    jobs.set(jobId, job);
    return {
      jobId,
      promise: new Promise((resolve) => {
        resolveJob = resolve;
      }),
      cancel() {
        job.cancelCount += 1;
        return true;
      },
      terminate() {
        job.terminateCount += 1;
        return true;
      }
    };
  };
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    positionImportDispatcher: dispatcher,
    onImportProgress: (progress) => progressEvents.push(progress)
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const first = service.dispatchTrackedImport({ command: 'test-cancel' }, '测试取消');
  const firstJob = jobs.get(first.jobId);
  firstJob.input.onProgress({ jobId: first.jobId, stage: 'preflight' });
  assert.deepEqual(service.cancelActiveImport(first.jobId), {
    status: 'stopping',
    jobId: first.jobId
  });
  assert.equal(firstJob.cancelCount, 1);
  firstJob.input.onCancelAck({ jobId: first.jobId });
  firstJob.resolve({ status: 'cancelled' });
  await first.promise;

  const raced = service.dispatchTrackedImport(
    { command: 'test-cancel-race' },
    '测试取消竞态'
  );
  const racedJob = jobs.get(raced.jobId);
  racedJob.input.onProgress({ jobId: raced.jobId, stage: 'applying' });
  assert.deepEqual(service.cancelActiveImport(raced.jobId), {
    status: 'stopping',
    jobId: raced.jobId
  });
  racedJob.input.onCancelAck({
    jobId: raced.jobId,
    stage: 'committing',
    accepted: false
  });
  assert.equal(service.activeImportJobs.get(raced.jobId).forceTimer, null);
  assert.deepEqual(service.cancelActiveImport(raced.jobId), {
    status: 'not-cancellable',
    jobId: raced.jobId,
    message: '数据正在提交，当前阶段无法取消'
  });
  racedJob.resolve({ status: 'ok' });
  await raced.promise;

  const second = service.dispatchTrackedImport({ command: 'test-commit' }, '测试提交');
  const secondJob = jobs.get(second.jobId);
  secondJob.input.onProgress({ jobId: second.jobId, stage: 'summarizing' });
  assert.deepEqual(service.cancelActiveImport(second.jobId), {
    status: 'not-cancellable',
    jobId: second.jobId,
    message: '数据正在提交，当前阶段无法取消'
  });
  secondJob.input.onProgress({ jobId: second.jobId, stage: 'committing' });
  assert.deepEqual(service.cancelActiveImport(second.jobId), {
    status: 'not-cancellable',
    jobId: second.jobId,
    message: '数据正在提交，当前阶段无法取消'
  });
  assert.equal(secondJob.cancelCount, 0);
  secondJob.resolve({ status: 'ok' });
  await second.promise;

  const preparedJobRoot = path.join(
    userDataDir,
    STAGING_RELATIVE_PATH,
    'source-prepare-job'
  );
  const accountApply = service.dispatchTrackedImport({
    command: POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
    payload: {
      preflightReady: {
        ledgerEvidence: {
          ledgerPath: path.join(preparedJobRoot, 'job-ledger.sqlite')
        }
      }
    }
  }, '测试账户确认');
  assert.ok(service.activeImportStagingPaths().includes(preparedJobRoot));
  jobs.get(accountApply.jobId).resolve({ status: 'ok' });
  await accountApply.promise;

  assert.ok(progressEvents.some((event) => event.stage === 'stopping'));
  assert.ok(progressEvents.some((event) => (
    event.stage === 'committing' && event.accepted === false
  )));
  assert.ok(progressEvents.some((event) => event.stage === 'summarizing'));
  assert.ok(progressEvents.some((event) => event.stage === 'committing'));
});

test('平盘 service 完成导入、隐藏非FX证据、运行、导出、回导和确认', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-service-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'result.xlsx');
  const differenceOutputPath = path.join(userDataDir, 'differences.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );

  let operationToken = 'position-bank-input-proof';
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    operationTokenProvider: () => operationToken
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const bankPrepared = service.prepareBankImport([bankPath]);
  const bankApplied = service.applyBankImport(bankPrepared.token);
  assert.equal(bankApplied.rowCount, 1);
  assert.deepEqual(
    service.listCommittedOperationInputs(operationToken).map((item) => item.sourceType),
    ['position-bank']
  );

  operationToken = 'position-source-input-proof';
  const sourceApplied = service.prepareSourceImport([sourcePath]);
  assert.equal(sourceApplied.successCount, 1);
  assert.deepEqual(
    service.listCommittedOperationInputs(operationToken).map((item) => item.sourceType),
    [SOURCE_TYPES.GATEWAY_INBOUND]
  );
  const inboundSummary = service.linkedManager().linked.find(
    (row) => row.sourceType === SOURCE_TYPES.GATEWAY_INBOUND
  );
  assert.equal(inboundSummary.rowCount, 0, '非FX证据不应出现在管理页可见链接表');
  assert.match(inboundSummary.updatedAt, /^\d{4}-\d{2}-\d{2}/, '派生为0行仍应记录表库更新日期');

  operationToken = 'position-run-proof';
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(run.status, 'ok');
  assert.equal(run.summary.changedRows, 1);
  assert.equal(run.summary.differenceRows, 0);

  await service.exportRun(run.runId, outputPath);
  const exported = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(exported.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.deepEqual(rows[0], POSITION_BANK_HEADERS);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('FundType')], 'Inbound');

  rows[1][POSITION_BANK_HEADERS.indexOf('Payee Name')] = ' ';
  const tampered = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tampered, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
  XLSX.writeFile(tampered, outputPath);
  assert.throws(
    () => service.importRunResult(run.runId, outputPath),
    (error) => error && error.code === 'position-result-field-tampered'
  );
  rows[1][POSITION_BANK_HEADERS.indexOf('Payee Name')] = '';
  rows[1][POSITION_BANK_HEADERS.indexOf('FundType')] = 'Inbound&FX';
  rows[1][POSITION_BANK_HEADERS.indexOf('匹配命中详情')] = '人工确认应保留FX';
  const edited = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(edited, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
  XLSX.writeFile(edited, outputPath);
  operationToken = 'position-result-input-proof';
  const reimported = service.importRunResult(run.runId, outputPath);
  assert.equal(reimported.modifiedCount, 1);
  assert.deepEqual(
    service.listCommittedOperationInputs(operationToken).map((item) => item.sourceType),
    ['position-result-reimport']
  );
  assert.equal(service.dataManager().differences[0].status, '待确认');
  const reimportedRun = service.store.getRun(run.runId);
  assert.equal(reimportedRun.summary.changedRows, 0);
  assert.equal(reimportedRun.summary.differenceRows, 1);
  assert.equal(reimportedRun.summary.manualModifiedRows, 1);
  assert.equal(service.store.listRunRows(run.runId)[0].outcome, 'difference');

  const confirmed = service.confirmRun(run.runId);
  assert.equal(confirmed.confirmedRows, 1);
  assert.equal(
    service.store.db.prepare(
      'SELECT COUNT(*) AS count FROM position_consumed_sources WHERE bank_biz_id = ?'
    ).get('POSITION-BIZ-1').count,
    1,
    '人工回导保留原匹配关系时仍必须消费对应链接记录'
  );
  const saved = service.store.getBankRows()[0];
  assert.equal(saved.status, '已校验性质');
  assert.equal(saved.workingRow.FundType, 'Inbound&FX');
  assert.equal(saved.originalRow.FundType, 'Inbound&FX');
  assert.equal(saved.hit_summary, '', '回导改回原值时不得留下“原值 → 原值”审计');
  const differences = service.dataManager().differences;
  assert.equal(differences.length, 1);
  assert.equal(differences[0].status, '人工修改后确认');
  const differenceExport = await service.exportRun(
    run.runId,
    differenceOutputPath,
    { differencesOnly: true }
  );
  assert.equal(differenceExport.rowCount, 1);
  assert.equal(fs.existsSync(differenceOutputPath), true);
});

test('结果文件发布后导出状态落库失败时保留已发布文件', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-export-state-failure-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const outputPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({ FundType: 'Charge' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  service.store.markRunExported = () => {
    throw new Error('injected markRunExported failure');
  };

  await assert.rejects(
    service.exportRun(run.runId, outputPath),
    /injected markRunExported failure/
  );
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(service.store.getRun(run.runId).exported_at, null);
});

test('差异页隐藏失效和被替换草稿，并保留当前草稿批次', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-difference-lifecycle-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const sourceRefreshPath = path.join(userDataDir, 'inbound-refresh.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID' })]
  );
  writeWorkbook(
    sourceRefreshPath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID', finishTime: '2026-07-20 12:00:00' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(firstRun.summary.differenceRows, 1);
  assert.equal(service.dataManager().differences[0].runId, firstRun.runId);

  const createRun = service.store.createRun.bind(service.store);
  service.store.createRun = () => {
    throw new Error('模拟新草稿写入失败');
  };
  assert.throws(
    () => service.run({
      channels: ['DBS'],
      months: ['2026-07'],
      replacePendingRunId: firstRun.runId
    }),
    /模拟新草稿写入失败/
  );
  service.store.createRun = createRun;
  assert.equal(
    service.store.latestPendingRun().id,
    firstRun.runId,
    '新草稿失败时旧草稿必须保持待确认'
  );

  assert.equal(service.prepareSourceImport([sourceRefreshPath]).successCount, 1);
  assert.equal(service.dataManager().differences.length, 0, '失效草稿不应留在可操作差异列表');

  const secondRun = service.run({
    channels: ['DBS'],
    months: ['2026-07'],
    replacePendingRunId: firstRun.runId
  });
  const activeDifferences = service.dataManager().differences;
  assert.equal(activeDifferences.length, 1);
  assert.equal(activeDifferences[0].runId, secondRun.runId);
});

test('清结算银行账户表只保存状态正常的行，零有效行不覆盖旧快照', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-account-'));
  const validPath = path.join(userDataDir, 'accounts-valid.xlsx');
  const invalidPath = path.join(userDataDir, 'accounts-invalid.xlsx');
  const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers;
  writeWorkbook(validPath, 'sheet1', headers, [
    {
      账户状态: '正常',
      账户性质: '自有',
      币种: 'USD',
      银行账号: 'OWN-001'
    },
    {
      账户状态: '注销',
      账户性质: '外部',
      币种: 'EUR',
      银行账号: 'OLD-001'
    }
  ]);
  writeWorkbook(invalidPath, 'sheet1', headers, [{
    账户状态: '注销',
    账户性质: '自有',
    币种: 'USD',
    银行账号: 'OLD-002'
  }]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const prepared = service.prepareSourceImport([validPath]);
  assert.equal(prepared.archiveDeferred, true);
  const confirmation = prepared.results.find((row) => row.status === 'needs-confirmation');
  assert.ok(confirmation);
  writeWorkbook(validPath, 'sheet1', headers, [{
    账户状态: '正常',
    账户性质: '自有',
    币种: 'EUR',
    银行账号: 'REPLACED-001'
  }]);
  const applied = service.applySourceImport(confirmation.token);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT).length, 1);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT)[0].row['银行账号'], 'OWN-001');
  assert.equal(applied.originalInputPaths[0], validPath);
  assert.notEqual(applied.inputPaths[0], validPath);

  const cancelled = service.prepareSourceImport([validPath]).results.find(
    (row) => row.status === 'needs-confirmation'
  );
  assert.ok(cancelled);
  await service.cancelSourceImport(cancelled.token);
  assert.throws(
    () => service.applySourceImport(cancelled.token),
    (error) => error && error.code === 'position-source-import-token-expired'
  );

  const rejected = service.prepareSourceImport([invalidPath]);
  assert.equal(rejected.failedCount, 1);
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT).length, 1);
});

test('链接原始表混合批次保持选择顺序，供存档中心准确关联成功文件', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-order-'));
  const validPath = path.join(userDataDir, 'valid-transfer.xlsx');
  const invalidPath = path.join(userDataDir, 'invalid-source.xlsx');
  writeWorkbook(
    validPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers,
    [{
      调拨单号: 'FT-1',
      调拨状态: '付款成功',
      渠道流水号: 'RID-1',
      交易时间: '2026-07-20',
      '付款账户（卡号）': 'PAY-1',
      '收款账户（卡号）': 'REC-1',
      付款金额: '100',
      付款币种: 'USD',
      收款金额: '95',
      收款币种: 'EUR'
    }]
  );
  writeWorkbook(invalidPath, 'Sheet1', ['未知字段'], [{ 未知字段: 'x' }]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = service.prepareSourceImport([validPath, invalidPath]);
  assert.deepEqual(
    result.results.map((item) => item.fileName),
    ['valid-transfer.xlsx', 'invalid-source.xlsx']
  );
  assert.deepEqual(result.results.map((item) => item.status), ['ok', 'failed']);
});

test('多文件来源操作只为真正提交的文件写入凭证，失败文件不阻断恢复已提交文件', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-commit-proof-'));
  const firstPath = path.join(userDataDir, 'first-inbound.xlsx');
  const secondPath = path.join(userDataDir, 'second-inbound.xlsx');
  writeWorkbook(
    firstPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ bizId: 'COMMITTED-A', reconId: 'RID-A' })]
  );
  writeWorkbook(
    secondPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ bizId: 'PREPARED-B', reconId: 'RID-B' })]
  );
  const pendingInputs = [];
  let intentCount = 0;
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    operationTokenProvider: () => 'multi-source-commit-proof',
    recordArchiveIntent: (files) => {
      pendingInputs.push(...files);
      intentCount += 1;
      if (intentCount === 2) mutateFileSameLength(files[0].filePath);
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = service.prepareSourceImport([firstPath, secondPath]);
  assert.equal(result.successCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(pendingInputs.length, 2);
  const committed = service.listCommittedOperationInputs('multi-source-commit-proof');
  assert.equal(committed.length, 1);
  assert.equal(committed[0].filePath, pendingInputs[0].filePath);
  assert.equal(fs.existsSync(pendingInputs[1].filePath), false, '失败文件暂存已删除');

  const filtered = positionCommittedRecoveryArchiveFiles({
    operationToken: 'multi-source-commit-proof',
    archiveFiles: pendingInputs.map((file) => ({
      filePath: file.filePath,
      role: 'input',
      sourceType: file.sourceType,
      sourceSnapshot: file.sourceSnapshot,
      sha256: file.expectedSha256,
      sizeBytes: file.sizeBytes
    }))
  }, committed);
  assert.deepEqual(filtered.map((file) => file.filePath), [pendingInputs[0].filePath]);
});

test('同一多文件操作全部提交时，每份输入都有独立 side DB 提交凭证', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-all-committed-'));
  const firstPath = path.join(userDataDir, 'first-inbound.xlsx');
  const secondPath = path.join(userDataDir, 'second-outbound.xlsx');
  writeWorkbook(
    firstPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ bizId: 'ALL-A', reconId: 'RID-ALL-A' })]
  );
  writeWorkbook(
    secondPath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND].headers,
    [{
      业务单号: 'ALL-B',
      主对账id: 'RID-ALL-B',
      账单日期: '2026-07-20',
      币种: 'USD',
      原始币种: 'EUR',
      原始金额: '100',
      银行扣款币种: 'USD'
    }]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    operationTokenProvider: () => 'multi-source-all-committed'
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const result = service.prepareSourceImport([firstPath, secondPath]);
  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 0);
  const committed = service.listCommittedOperationInputs('multi-source-all-committed');
  assert.equal(committed.length, 2);
  assert.deepEqual(
    committed.map((item) => item.sourceType).sort(),
    [SOURCE_TYPES.GATEWAY_INBOUND, SOURCE_TYPES.GATEWAY_OUTBOUND].sort()
  );
});

test('文件级提交凭证与业务写入共享事务，任一侧失败都整体回滚', (t) => {
  const cases = [
    {
      label: 'journal-failure',
      trigger: `
        CREATE TRIGGER fail_position_operation_input
        BEFORE INSERT ON position_operation_inputs
        BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;
      `
    },
    {
      label: 'business-failure',
      trigger: `
        CREATE TRIGGER fail_position_source_row
        BEFORE INSERT ON position_source_rows
        BEGIN SELECT RAISE(ABORT, 'injected business failure'); END;
      `
    }
  ];

  for (const item of cases) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `position-proof-${item.label}-`));
    const sourcePath = path.join(userDataDir, 'inbound.xlsx');
    writeWorkbook(
      sourcePath,
      'Sheet1',
      SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
      [inboundRow({ bizId: item.label, reconId: `RID-${item.label}` })]
    );
    const operationToken = `proof-${item.label}`;
    const service = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      operationTokenProvider: () => operationToken
    });
    const checkpointBefore = service.persistenceCheckpoint();
    service.store.db.exec(item.trigger);

    const result = service.prepareSourceImport([sourcePath]);
    assert.equal(result.successCount, 0, item.label);
    assert.equal(result.failedCount, 1, item.label);
    assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 0, item.label);
    assert.deepEqual(service.listCommittedOperationInputs(operationToken), [], item.label);
    assert.deepEqual(service.persistenceCheckpoint(), checkpointBefore, item.label);
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('持久侧库关键 JSON 损坏时阻断运行，不降级成普通未命中', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-corrupt-json-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  service.store.db.prepare(
    "UPDATE position_link_rows SET linked_json = '{' WHERE source_type = ?"
  ).run(SOURCE_TYPES.GATEWAY_INBOUND);
  assert.throws(
    () => service.run({ channels: ['DBS'], months: ['2026-07'] }),
    /平盘侧库链接行 ID=.*JSON 损坏/
  );
});

test('持久侧库非法日期标记必须阻断读取', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-corrupt-date-json-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  service.store.db.prepare(`
    UPDATE position_bank_rows
    SET working_json = ?
    WHERE biz_id = ?
  `).run(
    JSON.stringify({
      BizId: 'POSITION-BIZ-1',
      BillDate: {
        __position_reconciliation_type__: 'Date',
        value: 'not-a-date'
      }
    }),
    'POSITION-BIZ-1'
  );
  assert.throws(
    () => service.store.getBankRows(),
    /平盘侧库银行工作行 BizId=POSITION-BIZ-1 JSON 损坏：日期标记无效/
  );
});

test('持久侧库语法合法但缺字段的 JSON 必须 fail-closed', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-missing-json-fields-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  service.store.db.prepare(
    "UPDATE position_bank_rows SET working_json = '{}' WHERE biz_id = ?"
  ).run('POSITION-BIZ-1');
  assert.throws(
    () => service.store.getBankRows(),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  service.store.db.prepare(
    'DELETE FROM position_bank_rows WHERE biz_id = ?'
  ).run('POSITION-BIZ-1');
  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.store.db.prepare(
    "UPDATE position_run_rows SET lineage_json = '{}' WHERE run_id = ?"
  ).run(run.runId);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('不适用行的空对象血缘也必须 fail-closed', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-not-applicable-lineage-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({ BizId: 'POSITION-NOT-APPLICABLE-1', FundType: 'Charge' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.store.db.prepare(
    "UPDATE position_run_rows SET lineage_json = '{}' WHERE run_id = ?"
  ).run(run.runId);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('运行结果、血缘、差异集合及当前链接引用被改写时必须 fail-closed', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-run-integrity-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const stored = service.store.db.prepare(`
    SELECT result_json, lineage_json
    FROM position_run_rows
    WHERE run_id = ? AND biz_id = ?
  `).get(run.runId, 'POSITION-BIZ-1');

  const changedResult = JSON.parse(stored.result_json);
  changedResult['Credit Amount'] = '999';
  service.store.db.prepare(`
    UPDATE position_run_rows SET result_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(JSON.stringify(changedResult), run.runId, 'POSITION-BIZ-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '非 FundType 结果字段被改写时必须阻断'
  );
  service.store.db.prepare(`
    UPDATE position_run_rows SET result_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(stored.result_json, run.runId, 'POSITION-BIZ-1');

  const changedLineage = JSON.parse(stored.lineage_json);
  changedLineage.pairKey = 'tampered-pair';
  service.store.db.prepare(`
    UPDATE position_run_rows SET lineage_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(JSON.stringify(changedLineage), run.runId, 'POSITION-BIZ-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '语法合法的血缘改写也必须通过完整性哈希识别'
  );
  service.store.db.prepare(`
    UPDATE position_run_rows SET lineage_json = ?
    WHERE run_id = ? AND biz_id = ?
  `).run(stored.lineage_json, run.runId, 'POSITION-BIZ-1');

  service.store.db.prepare(`
    INSERT INTO position_differences(
      run_id, biz_id, channel, month_key, status, reason, lineage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId,
    'POSITION-BIZ-1',
    'DBS',
    '2026-07',
    '待确认',
    '伪造差异',
    stored.lineage_json
  );
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '匹配行被额外写入差异表时必须阻断'
  );
  service.store.db.prepare(
    'DELETE FROM position_differences WHERE run_id = ? AND biz_id = ?'
  ).run(run.runId, 'POSITION-BIZ-1');

  service.store.db.prepare(`
    UPDATE position_link_rows
    SET business_key = ?
    WHERE source_type = ? AND business_key = ?
  `).run('OTHER-BUSINESS-KEY', SOURCE_TYPES.GATEWAY_INBOUND, 'INBOUND-1');
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '当前链接记录与运行血缘不一致时必须阻断'
  );
});

test('链接表删除必须明确月份，清空来源后运行会被阻断', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-delete-guard-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  assert.throws(
    () => service.deleteSource({ sourceType: SOURCE_TYPES.GATEWAY_INBOUND, months: [] }),
    /至少选择一个月份/
  );
  assert.throws(
    () => service.deleteSource({
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      wholeTable: true
    }),
    /不允许整表删除/
  );
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 1);

  service.deleteSource({
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    months: ['2026-07']
  });
  assert.equal(service.store.countSourceRows(SOURCE_TYPES.GATEWAY_INBOUND), 0);
  assert.throws(
    () => service.run({ channels: ['DBS'], months: ['2026-07'] }),
    (error) => error && error.code === 'position-run-source-missing'
  );
});

test('FundTransfer-in 使用的外部 out 银行数据变化会使草稿失效', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-transfer-snapshot-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'transfer.xlsx');
  const outputPath = path.join(userDataDir, 'stale.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({
      BizId: 'TRANSFER-OUT-BIZ',
      BillDate: '2026-06-21',
      Channel: 'DBS',
      MerchantId: 'PAY-001',
      Currency: 'USD',
      'Credit Amount': '0',
      'Debit Amount': '100',
      ReconciliationId: 'TRANSFER-RID-1',
      FundType: 'FundTransfer-out'
    }),
    bankRow({
      BizId: 'TRANSFER-IN-BIZ',
      BillDate: '2026-07-21',
      Channel: 'DBS',
      MerchantId: 'RECEIVE-001',
      Currency: 'EUR',
      'Credit Amount': '95',
      'Debit Amount': '0',
      ReconciliationId: 'TRANSFER-RID-1',
      FundType: 'FundTransfer-in'
    })
  ]);
  writeWorkbook(
    sourcePath,
    '调拨',
    SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers,
    [transferRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(run.summary.differenceRows, 0);
  service.deleteBank({ channels: ['DBS'], months: ['2026-06'] });
  await assert.rejects(
    service.exportRun(run.runId, outputPath),
    (error) => error && error.code === 'position-run-stale'
  );
});

test('差异汇总和导出严格限定当前银行渠道、月份和状态', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-difference-scope-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'difference-dbs.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({ BizId: 'DIFF-DBS', ReconciliationId: 'RID-DBS' }),
    bankRow({
      BizId: 'DIFF-DBS-US',
      地区: 'US',
      ReconciliationId: 'RID-DBS-US'
    }),
    bankRow({
      BizId: 'DIFF-MAYBANK',
      BillDate: '2026-08-20',
      Channel: 'MAYBANK',
      MerchantId: 'M002',
      ReconciliationId: 'RID-MAYBANK'
    })
  ]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ reconId: 'OTHER-RID' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({
    channels: ['DBS', 'MAYBANK'],
    months: ['2026-07', '2026-08']
  });
  assert.equal(run.summary.differenceRows, 3);
  const differences = service.dataManager().differences;
  assert.equal(differences.length, 3);
  assert.deepEqual(
    differences.map((row) => row.bankChannel).sort(),
    ['DBS-HK', 'DBS-US', 'MAYBANK-HK']
  );
  const exported = await service.exportRun(run.runId, outputPath, {
    differencesOnly: true,
    channels: ['DBS'],
    regions: ['HK'],
    months: ['2026-07'],
    differenceStatuses: ['待确认']
  });
  assert.equal(exported.rowCount, 1);
  const workbook = XLSX.readFile(outputPath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('BizId')], 'DIFF-DBS');
});

test('引擎输出必须与输入 BizId 集合严格一一对应', () => {
  const bankRows = [{ biz_id: 'BIZ-A' }, { biz_id: 'BIZ-B' }];
  assert.doesNotThrow(() => assertEngineResultSet([
    { bizId: 'BIZ-A' },
    { bizId: 'BIZ-B' }
  ], bankRows));
  assert.throws(
    () => assertEngineResultSet([
      { bizId: 'BIZ-A' },
      { bizId: 'BIZ-A' }
    ], bankRows),
    (error) => error && error.code === 'position-run-row-conservation'
  );
});

test('银行 Excel 日期单元格经过侧库后仍以日期类型导出', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-date-roundtrip-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const outputPath = path.join(userDataDir, 'bank-export.xlsx');
  const resultPath = path.join(userDataDir, 'result-export.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BillDate: new Date(2026, 6, 20),
    ValueDate: new Date(2026, 6, 21),
    最近修改时间: new Date(2026, 6, 20, 12, 34, 56)
  })]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const stored = service.store.getBankRows()[0];
  assert.equal(stored.originalRow.BillDate instanceof Date, true);
  assert.equal(stored.workingRow.ValueDate instanceof Date, true);
  assert.equal(stored.workingRow.最近修改时间 instanceof Date, true);

  await service.exportBank({ channels: ['DBS'], months: ['2026-07'] }, outputPath);
  const workbook = XLSX.readFile(outputPath, { cellDates: true, raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: '',
    raw: true
  });
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('BillDate')] instanceof Date, true);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('ValueDate')] instanceof Date, true);
  assert.equal(rows[1][POSITION_BANK_HEADERS.indexOf('最近修改时间')] instanceof Date, true);

  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  assert.doesNotThrow(() => service.importRunResult(run.runId, resultPath));

  const edited = XLSX.readFile(resultPath, { cellDates: true, raw: true });
  const editedRows = XLSX.utils.sheet_to_json(edited.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: '',
    raw: true
  });
  const modifiedAtColumn = POSITION_BANK_HEADERS.indexOf('最近修改时间');
  editedRows[1][modifiedAtColumn] = new Date(editedRows[1][modifiedAtColumn].getTime() + (60 * 60 * 1000));
  const tampered = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    tampered,
    XLSX.utils.aoa_to_sheet(editedRows),
    BANK_SHEET_NAME
  );
  XLSX.writeFile(tampered, resultPath);
  assert.throws(
    () => service.importRunResult(run.runId, resultPath),
    (error) => error && error.code === 'position-result-field-tampered'
  );
});

test('结果回导在解析后、写侧库前暂存发生变化时拒绝更新草稿', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-result-staged-change-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({ FundType: 'Charge' })]
  );
  let mutateResult = false;
  let stagedResultPath = '';
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    beforeStagedInputCommit: ({ phase, files }) => {
      if (phase !== 'result-apply' || !mutateResult) return;
      stagedResultPath = files[0].filePath;
      mutateFileSameLength(stagedResultPath);
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  const checkpointBefore = service.persistenceCheckpoint();
  const rowBefore = service.store.listRunRows(run.runId)[0];
  mutateResult = true;

  assert.throws(
    () => service.importRunResult(run.runId, resultPath),
    (error) => error && error.code === 'position-staged-input-changed'
  );
  const storedRun = service.store.getRun(run.runId);
  assert.equal(storedRun.reimported_at, null);
  assert.deepEqual(service.store.listRunRows(run.runId)[0].resultRow, rowBefore.resultRow);
  assert.deepEqual(service.persistenceCheckpoint(), checkpointBefore);
  assert.equal(fs.existsSync(stagedResultPath), false);
});

test('结果回导拒绝 BillDate/ValueDate 同日时分秒、跨日和非法文本篡改', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-result-date-tamper-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    FundType: 'Charge',
    BillDate: new Date(2026, 6, 20, 9, 30, 15),
    ValueDate: new Date(2026, 6, 21, 10, 45, 20)
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  assert.doesNotThrow(
    () => service.importRunResult(run.runId, resultPath),
    'ExcelJS → SheetJS 的已知时区往返必须继续接受'
  );

  const cases = [
    ['BillDate', (value) => new Date(value.getTime() + (60 * 60 * 1000))],
    ['BillDate', (value) => new Date(value.getTime() + (60 * 1000))],
    ['BillDate', (value) => new Date(value.getTime() + 1000)],
    ['ValueDate', (value) => new Date(value.getTime() + (60 * 60 * 1000))],
    ['ValueDate', (value) => new Date(value.getTime() + (60 * 1000))],
    ['ValueDate', (value) => new Date(value.getTime() + 1000)],
    ['BillDate', (value) => new Date(value.getTime() + (24 * 60 * 60 * 1000))],
    ['ValueDate', (value) => new Date(value.getTime() + (24 * 60 * 60 * 1000))],
    ['BillDate', () => 'Invalid Date'],
    ['ValueDate', () => '不是日期']
  ];
  for (const [header, mutate] of cases) {
    await service.exportRun(run.runId, resultPath);
    const workbook = XLSX.readFile(resultPath, { cellDates: true, raw: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
      header: 1,
      defval: '',
      raw: true
    });
    const column = POSITION_BANK_HEADERS.indexOf(header);
    rows[1][column] = mutate(rows[1][column]);
    const tampered = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(tampered, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
    XLSX.writeFile(tampered, resultPath);
    assert.throws(
      () => service.importRunResult(run.runId, resultPath),
      (error) => error && error.code === 'position-result-field-tampered',
      `${header} 篡改应被拒绝`
    );
  }
});

test('结果回导接受纯日期文本与等价 Excel 日期单元格', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-result-pure-date-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    FundType: 'Charge',
    BillDate: '2026-07-20',
    ValueDate: '2026/07/21'
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  const workbook = XLSX.readFile(resultPath, { cellDates: true, raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: '',
    raw: true
  });
  rows[1][POSITION_BANK_HEADERS.indexOf('BillDate')] = new Date(2026, 6, 20);
  rows[1][POSITION_BANK_HEADERS.indexOf('ValueDate')] = new Date(2026, 6, 21);
  const equivalent = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(equivalent, XLSX.utils.aoa_to_sheet(rows), BANK_SHEET_NAME);
  XLSX.writeFile(equivalent, resultPath);

  assert.doesNotThrow(() => service.importRunResult(run.runId, resultPath));
});

test('已确认订单链接记录跨月份及原始表重建后仍禁止重复消费', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-consumption-'));
  const julyBankPath = path.join(userDataDir, 'bank-july.xlsx');
  const augustBankPath = path.join(userDataDir, 'bank-august.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const refreshedSourcePath = path.join(userDataDir, 'inbound-refreshed.xlsx');
  const resultPath = path.join(userDataDir, 'july-result.xlsx');
  writeWorkbook(julyBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(augustBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'POSITION-BIZ-AUGUST',
    BillDate: '2026-08-20'
  })]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  writeWorkbook(
    refreshedSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ finishTime: '2026-07-21 10:00:00' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([julyBankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const julyRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(julyRun.summary.differenceRows, 0);
  await service.exportRun(julyRun.runId, resultPath);
  service.confirmRun(julyRun.runId);
  assert.deepEqual(
    service.store.listConsumedSources().map((item) => ({
      sourceType: item.sourceType,
      businessKey: item.businessKey,
      legIndex: item.legIndex,
      bankBizId: item.bankBizId
    })),
    [{
      sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
      businessKey: 'INBOUND-1',
      legIndex: 0,
      bankBizId: 'POSITION-BIZ-1'
    }]
  );

  assert.equal(service.prepareSourceImport([refreshedSourcePath]).successCount, 1);
  service.applyBankImport(service.prepareBankImport([augustBankPath]).token);
  const augustRun = service.run({ channels: ['DBS'], months: ['2026-08'] });
  assert.equal(augustRun.summary.changedRows, 0);
  assert.equal(augustRun.summary.differenceRows, 1);
  const augustResult = service.store.listRunRows(augustRun.runId)[0];
  assert.equal(augustResult.result_fund_type, 'Inbound&FX');
  assert.match(augustResult.match_detail, /链接记录已被已确认运行#\d+的银行BizId=POSITION-BIZ-1消费/);
});

test('同一银行 BizId 重导后可幂等复核同一链接记录', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-idempotent-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const firstResultPath = path.join(userDataDir, 'first.xlsx');
  const secondResultPath = path.join(userDataDir, 'second.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(firstRun.runId, firstResultPath);
  service.confirmRun(firstRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const secondRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(secondRun.summary.changedRows, 1);
  assert.equal(secondRun.summary.differenceRows, 0);
  await service.exportRun(secondRun.runId, secondResultPath);
  assert.doesNotThrow(() => service.confirmRun(secondRun.runId));
  assert.doesNotThrow(() => service.store.getRun(secondRun.runId));
  assert.equal(service.store.listConsumedSources().length, 1);
});

test('已确认来源消费表与运行血缘必须保持双向一致', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-consumption-integrity-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  const resultPath = path.join(userDataDir, 'result.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(run.runId, resultPath);
  service.confirmRun(run.runId);
  assert.equal(service.store.listConsumedSources().length, 1);

  service.store.db.prepare(
    'DELETE FROM position_consumed_sources WHERE run_id = ?'
  ).run(run.runId);
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
  assert.throws(
    () => service.store.listConsumedSources(),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('来源消费 owner 必须由对应 confirmed 运行血缘证明', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-consumption-owner-'));
  const unrelatedBankPath = path.join(userDataDir, 'bank-unrelated.xlsx');
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(
    unrelatedBankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow({
      BizId: 'POSITION-BIZ-UNRELATED',
      ReconciliationId: 'RID-UNRELATED',
      FundType: 'Charge'
    })]
  );
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([unrelatedBankPath]).token);
  const unrelatedRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(unrelatedRun.runId, path.join(userDataDir, 'unrelated.xlsx'));
  service.confirmRun(unrelatedRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const ownerRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(ownerRun.runId, path.join(userDataDir, 'owner.xlsx'));
  service.confirmRun(ownerRun.runId);

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  const idempotentRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(idempotentRun.runId, path.join(userDataDir, 'idempotent.xlsx'));
  service.confirmRun(idempotentRun.runId);
  assert.doesNotThrow(() => service.store.getRun(idempotentRun.runId));

  const updateOwner = service.store.db.prepare(`
    UPDATE position_consumed_sources
    SET run_id = ?
    WHERE source_type = ? AND business_key = ? AND leg_index = ?
  `);
  updateOwner.run(
    unrelatedRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.throws(
    () => service.store.getRun(idempotentRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  updateOwner.run(
    idempotentRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.throws(
    () => service.store.getRun(ownerRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );

  updateOwner.run(
    ownerRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'INBOUND-1',
    0
  );
  assert.doesNotThrow(() => service.store.getRun(idempotentRun.runId));
  service.store.db.prepare(`
    INSERT INTO position_consumed_sources(
      run_id, source_type, business_key, leg_index, bank_biz_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    idempotentRun.runId,
    SOURCE_TYPES.GATEWAY_INBOUND,
    'UNRELATED-SOURCE',
    0,
    'UNRELATED-BANK-BIZ'
  );
  assert.throws(
    () => service.store.getRun(idempotentRun.runId),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('同一银行 BizId 已确认后禁止改配到另一条链接记录', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-reassignment-'));
  const firstBankPath = path.join(userDataDir, 'bank-first.xlsx');
  const secondBankPath = path.join(userDataDir, 'bank-second.xlsx');
  const firstSourcePath = path.join(userDataDir, 'inbound-first.xlsx');
  const secondSourcePath = path.join(userDataDir, 'inbound-second.xlsx');
  const firstResultPath = path.join(userDataDir, 'first.xlsx');
  writeWorkbook(firstBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(secondBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    ReconciliationId: 'RID-2'
  })]);
  writeWorkbook(
    firstSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  writeWorkbook(
    secondSourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow({ bizId: 'INBOUND-2', reconId: 'RID-2' })]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([firstBankPath]).token);
  assert.equal(service.prepareSourceImport([firstSourcePath]).successCount, 1);
  const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  await service.exportRun(firstRun.runId, firstResultPath);
  service.confirmRun(firstRun.runId);

  assert.equal(service.prepareSourceImport([secondSourcePath]).successCount, 1);
  service.applyBankImport(service.prepareBankImport([secondBankPath]).token);
  const secondRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
  assert.equal(secondRun.summary.changedRows, 0);
  assert.equal(secondRun.summary.differenceRows, 1);
  assert.equal(secondRun.summary.engine.matched, 0);
  assert.equal(secondRun.summary.engine.differences, 1);
  assert.equal(secondRun.summary.engine.confirmedConsumptionConflicts, 1);
  const row = service.store.listRunRows(secondRun.runId)[0];
  assert.equal(row.result_fund_type, 'Inbound&FX');
  assert.match(row.match_detail, /禁止改配到其他链接记录/);
  assert.equal(row.lineage.reasonCode, 'position-bank-counterparty-reassigned');
});

test('银行导出拒绝实际无数据的 Channel 月份组合', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-export-empty-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const outputPath = path.join(userDataDir, 'empty.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  await assert.rejects(
    service.exportBank({ channels: ['DBS'], months: ['2026-08'] }, outputPath),
    (error) => error && error.code === 'position-bank-export-empty'
  );
  assert.throws(
    () => service.deleteBank({ channels: ['DBS'], months: ['2026-08'] }),
    (error) => error && error.code === 'position-bank-delete-empty'
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test('银行导入 BizId 与其他范围冲突时明确拒绝并保留原数据', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-bizid-conflict-'));
  const julyPath = path.join(userDataDir, 'july.xlsx');
  const augustPath = path.join(userDataDir, 'august.xlsx');
  writeWorkbook(julyPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(augustPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BillDate: '2026-08-20',
    Channel: 'MAYBANK'
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([julyPath]).token);
  const prepared = service.prepareBankImport([augustPath]);
  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => (
      error
      && error.code === 'position-bank-existing-bizid-conflict'
      && error.detailLines.some((line) => line.includes('DBS/2026-07'))
      && error.detailLines.some((line) => line.includes('MAYBANK/2026-08'))
    )
  );
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'DBS');
  assert.equal(rows[0].month_key, '2026-07');
});

test('银行批量同时替换新旧范围时也禁止 BizId 跨范围迁移', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-bizid-move-'));
  const originalPath = path.join(userDataDir, 'original.xlsx');
  const mixedPath = path.join(userDataDir, 'mixed.xlsx');
  writeWorkbook(originalPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'BIZ-X',
    Channel: 'A',
    BillDate: '2026-06-20'
  })]);
  writeWorkbook(mixedPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
    bankRow({
      BizId: 'BIZ-X',
      Channel: 'B',
      BillDate: '2026-07-20'
    }),
    bankRow({
      BizId: 'BIZ-A-KEEP',
      Channel: 'A',
      BillDate: '2026-06-21'
    })
  ]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([originalPath]).token);
  const prepared = service.prepareBankImport([mixedPath]);
  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => (
      error
      && error.code === 'position-bank-existing-bizid-conflict'
      && error.detailLines.some((line) => line.includes('A/2026-06'))
      && error.detailLines.some((line) => line.includes('B/2026-07'))
    )
  );
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].biz_id, 'BIZ-X');
  assert.equal(rows[0].channel, 'A');
  assert.equal(rows[0].month_key, '2026-06');
});

test('银行导入确认使用不可变暂存副本，原路径被覆盖不改变写库和存档来源', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-staging-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'STAGED-A',
    Channel: 'DBS'
  })]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const prepared = service.prepareBankImport([bankPath]);
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'REPLACED-B',
    Channel: 'MAYBANK'
  })]);
  const applied = service.applyBankImport(prepared.token);
  const rows = service.store.getBankRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].biz_id, 'STAGED-A');
  assert.equal(rows[0].channel, 'DBS');
  assert.equal(applied.originalInputPaths[0], bankPath);
  assert.notEqual(applied.inputPaths[0], bankPath);
  assert.equal(fs.existsSync(applied.inputPaths[0]), true);
  const archivedCopy = XLSX.readFile(applied.inputPaths[0], { raw: true });
  const values = XLSX.utils.sheet_to_json(archivedCopy.Sheets[BANK_SHEET_NAME], {
    header: 1,
    defval: ''
  });
  assert.equal(values[1][BANK_STATEMENT_FIELDS.indexOf('BizId')], 'STAGED-A');
});

test('银行 prepare 后暂存字节变化时 apply 拒绝写库并回收失效 token', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-bank-staged-change-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const checkpointBefore = service.persistenceCheckpoint();
  const prepared = service.prepareBankImport([bankPath]);
  const [archiveFile] = service.bankImportArchiveIntent(prepared.token);
  assert.equal(archiveFile.expectedSha256.length, 64);
  assert.equal(archiveFile.sourceSnapshot.sizeBytes, archiveFile.sizeBytes);
  mutateFileSameLength(archiveFile.filePath);

  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => error && error.code === 'position-staged-input-changed'
  );
  assert.equal(service.store.getBankRows().length, 0);
  assert.deepEqual(service.persistenceCheckpoint(), checkpointBefore);
  assert.equal(fs.existsSync(archiveFile.filePath), false);
  assert.throws(
    () => service.applyBankImport(prepared.token),
    (error) => error && error.code === 'position-bank-import-token-expired'
  );
});

test('账户表确认前暂存字节变化时拒绝覆盖旧快照', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-account-staged-change-'));
  const accountPath = path.join(userDataDir, 'accounts.xlsx');
  const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.BANK_ACCOUNT].headers;
  writeWorkbook(accountPath, 'Sheet1', headers, [{
    账户状态: '正常',
    账户性质: '自有',
    币种: 'USD',
    银行账号: 'OWN-001'
  }]);
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const checkpointBefore = service.persistenceCheckpoint();
  const prepared = service.prepareSourceImport([accountPath]);
  const confirmation = prepared.results.find((item) => item.status === 'needs-confirmation');
  const [archiveFile] = service.sourceImportArchiveIntent(confirmation.token);
  mutateFileSameLength(archiveFile.filePath);

  assert.throws(
    () => service.applySourceImport(confirmation.token),
    (error) => error && error.code === 'position-staged-input-changed'
  );
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.BANK_ACCOUNT).length, 0);
  assert.deepEqual(service.persistenceCheckpoint(), checkpointBefore);
  assert.equal(fs.existsSync(archiveFile.filePath), false);
});

test('普通链接表在解析与自动落库之间发生暂存变化时整份失败', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-source-staged-change-'));
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(
    sourcePath,
    'Sheet1',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  let stagedPath = '';
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    recordArchiveIntent: (files) => {
      stagedPath = files[0].filePath;
      mutateFileSameLength(stagedPath);
    }
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const checkpointBefore = service.persistenceCheckpoint();
  const result = service.prepareSourceImport([sourcePath]);
  assert.equal(result.successCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.results[0].code, 'position-staged-input-changed');
  assert.equal(service.store.sourceRecords(SOURCE_TYPES.GATEWAY_INBOUND).length, 0);
  assert.deepEqual(service.persistenceCheckpoint(), checkpointBefore);
  assert.equal(fs.existsSync(stagedPath), false);
});

test('启动暂存清理跳过仍被存档失败批次引用的文件', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-staging-prune-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  const protectedRoot = path.join(root, 'protected-batch');
  const staleRoot = path.join(root, 'stale-batch');
  const protectedFile = path.join(protectedRoot, '1', 'protected.xlsx');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(protectedFile, 'protected');
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(protectedRoot, oldDate, oldDate);
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const removed = pruneStagingRoot(userDataDir, {
    now: new Date('2026-07-20T00:00:00.000Z').getTime(),
    maxAgeMs: 24 * 60 * 60 * 1000,
    protectedPaths: [protectedFile]
  });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(staleRoot), false);
});

test('主库 pending 单独引用的过期暂存文件必须在恢复前保留', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-pending-staging-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const expectedCheckpoint = bootstrap.persistenceCheckpoint();
  bootstrap.close();

  const root = path.join(userDataDir, STAGING_RELATIVE_PATH);
  const protectedRoot = path.join(root, 'pending-batch');
  const staleRoot = path.join(root, 'stale-batch');
  const protectedFile = path.join(protectedRoot, '1', 'pending.xlsx');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(protectedFile, 'pending');
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(protectedRoot, oldDate, oldDate);
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const recovered = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: expectedCheckpoint,
    expectedPendingOperation: JSON.stringify({
      operationToken: 'pending-operation',
      baseCheckpoint: expectedCheckpoint,
      archiveFiles: [{
        filePath: protectedFile,
        role: 'input',
        sourceSnapshot: sourceSnapshotFromStat(fs.statSync(protectedFile)),
        sha256: hashFileSha256Sync(protectedFile).sha256,
        sizeBytes: fs.statSync(protectedFile).size
      }]
    }),
    protectedStagingPaths: () => []
  });
  recovered.close();

  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(staleRoot), false);
});

test('存档保护来源不可用时保守跳过全部过期暂存清理', (t) => {
  const providers = [
    ['null', () => null],
    ['undefined', () => undefined],
    ['非数组', () => ({})],
    ['抛异常', () => {
      throw new Error('archive center unavailable');
    }]
  ];

  for (const [label, protectedStagingPaths] of providers) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-staging-protection-${label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const bootstrap = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    const expectedCheckpoint = bootstrap.persistenceCheckpoint();
    bootstrap.close();

    const staleRoot = path.join(
      userDataDir,
      STAGING_RELATIVE_PATH,
      'stale-batch'
    );
    const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'stale');
    const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    fs.utimesSync(staleRoot, oldDate, oldDate);

    const recovered = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      protectedStagingPaths
    });
    recovered.close();

    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 不得触发过期暂存清理`
    );
  }
});

test('pending archiveFiles 缺失或损坏时保守跳过全部过期暂存清理', (t) => {
  const invalidArchiveFiles = [
    ['缺失', undefined, true],
    ['非数组', {}, false],
    ['空项', [null], false],
    ['空路径', [{ filePath: '   ' }], false],
    ['非字符串路径', [{ filePath: 123 }], false]
  ];

  for (const [label, archiveFiles, omitField] of invalidArchiveFiles) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-pending-archive-files-${label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const bootstrap = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    const expectedCheckpoint = bootstrap.persistenceCheckpoint();
    bootstrap.close();

    const staleRoot = path.join(
      userDataDir,
      STAGING_RELATIVE_PATH,
      'stale-batch'
    );
    const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'stale');
    const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    fs.utimesSync(staleRoot, oldDate, oldDate);

    const pending = {
      operationToken: `pending-${label}`,
      baseCheckpoint: expectedCheckpoint,
      archiveRequired: true,
      archiveState: 'intent-recorded',
      businessState: 'success'
    };
    if (!omitField) pending.archiveFiles = archiveFiles;
    const serializedPending = JSON.stringify(pending);
    const recovered = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      expectedPendingOperation: serializedPending,
      protectedStagingPaths: () => []
    });
    recovered.close();

    assert.throws(
      () => requirePositionPendingArchiveFiles(pending),
      /存档文件清单损坏/,
      `${label} 必须阻断恢复登记`
    );
    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 不得把 pending 当成空保护集`
    );

    const restarted = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: expectedCheckpoint,
      expectedPendingOperation: serializedPending,
      protectedStagingPaths: () => []
    });
    restarted.close();
    assert.equal(
      fs.existsSync(staleFile),
      true,
      `${label} 第二次启动仍须保留真实暂存文件`
    );
  }
});

test('pending 合法空 archiveFiles 允许清理无保护的过期暂存', (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-pending-empty-archive-files-')
  );
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const bootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const expectedCheckpoint = bootstrap.persistenceCheckpoint();
  bootstrap.close();

  const staleRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, 'stale-batch');
  const staleFile = path.join(staleRoot, '1', 'stale.xlsx');
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, 'stale');
  const oldDate = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
  fs.utimesSync(staleRoot, oldDate, oldDate);

  const recovered = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: expectedCheckpoint,
    expectedPendingOperation: JSON.stringify({
      operationToken: 'pending-empty-archive-files',
      baseCheckpoint: expectedCheckpoint,
      archiveFiles: []
    }),
    protectedStagingPaths: () => []
  });
  recovered.close();

  assert.equal(fs.existsSync(staleFile), false);
});

test('业务后置清理只返回没有未完成存档引用的暂存目录', () => {
  const root = path.resolve('/tmp/position-staging-filter');
  const sharedDir = path.join(root, 'shared', '1');
  const freeDir = path.join(root, 'free', '1');
  assert.deepEqual(
    filterStagingPathsWithoutProtectedSources(
      [sharedDir, freeDir],
      [path.join(sharedDir, 'bank.xlsx')]
    ),
    [freeDir]
  );
  assert.deepEqual(
    filterStagingPathsWithoutProtectedSources([sharedDir], [sharedDir]),
    []
  );
});

test('取消账户确认不得删除普通来源存档重试仍引用的共享暂存目录', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-account-cancel-staging-protection-')
  );
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let protectedPaths = [];
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    protectedStagingPaths: () => protectedPaths
  });
  t.after(() => service.close());

  const jobRoot = path.join(
    userDataDir,
    STAGING_RELATIVE_PATH,
    'mixed-source-account-job'
  );
  const ordinaryFile = path.join(jobRoot, 'ordinary', 'gateway-outbound.xlsx');
  const accountFile = path.join(jobRoot, 'account', 'bank-account.xlsx');
  fs.mkdirSync(path.dirname(ordinaryFile), { recursive: true });
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  fs.writeFileSync(ordinaryFile, 'ordinary');
  fs.writeFileSync(accountFile, 'account');

  protectedPaths = [ordinaryFile];
  service.sourceImportTokens.set('protected-account-token', {
    streaming: true,
    jobRoot
  });
  assert.deepEqual(await service.cancelSourceImport('protected-account-token'), {
    status: 'cancelled'
  });
  assert.equal(fs.existsSync(ordinaryFile), true);
  assert.equal(fs.existsSync(accountFile), true);

  protectedPaths = [];
  service.sourceImportTokens.set('released-account-token', {
    streaming: true,
    jobRoot
  });
  await service.cancelSourceImport('released-account-token');
  assert.equal(fs.existsSync(jobRoot), false);
});

test('账户确认取消时存档保护集不可读会保守保留暂存目录', async (t) => {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'position-account-cancel-protection-unavailable-')
  );
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    protectedStagingPaths: () => {
      throw new Error('archive center unavailable');
    }
  });
  t.after(() => service.close());

  const jobRoot = path.join(
    userDataDir,
    STAGING_RELATIVE_PATH,
    'unavailable-protection-job'
  );
  const accountFile = path.join(jobRoot, 'account', 'bank-account.xlsx');
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  fs.writeFileSync(accountFile, 'account');
  service.sourceImportTokens.set('account-token', {
    streaming: true,
    jobRoot
  });

  await service.cancelSourceImport('account-token');
  assert.equal(fs.existsSync(accountFile), true);
});

test('规则版本变化后持久草稿自动失效并禁止确认', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-ruleset-stale-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const snapshot = service.store.getRun(run.runId).snapshot;
  snapshot.rulesetVersion = 0;
  service.store.db.prepare(
    'UPDATE position_runs SET snapshot_json = ? WHERE id = ?'
  ).run(JSON.stringify(snapshot), run.runId);

  assert.equal(service.status().pendingRun.stale, true);
  assert.throws(
    () => service.confirmRun(run.runId),
    (error) => error && error.code === 'position-run-stale'
  );
});

test('已初始化的平盘侧库缺失或被替换为空库时必须阻断，不得静默重建', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-guard-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const initialized = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const checkpoint = initialized.persistenceCheckpoint();
  initialized.close();
  assert.equal(fs.existsSync(dbPath), true);

  fs.rmSync(dbPath);
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: checkpoint
    }),
    (error) => error && error.code === 'position-side-db-missing'
  );

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, '');
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: checkpoint
    }),
    (error) => error && error.code === 'position-side-db-missing'
  );
});

test('侧库初始化结果只暴露 new 或 existing 模式', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-init-mode-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const created = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const checkpoint = created.persistenceCheckpoint();
  const createdResult = created.store.initializationResult();
  assert.deepEqual(createdResult, {
    mode: POSITION_DB_INITIALIZATION_MODES.NEW
  });
  assert.deepEqual(Object.keys(createdResult), ['mode']);
  assert.equal(
    created.store.db.prepare('PRAGMA journal_mode').get().journal_mode,
    'wal',
    '新建初始化提交后必须进入正式 WAL 模式'
  );
  created.close();

  const reopened = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: checkpoint
  });
  const reopenedResult = reopened.store.initializationResult();
  assert.deepEqual(reopenedResult, {
    mode: POSITION_DB_INITIALIZATION_MODES.EXISTING
  });
  assert.deepEqual(Object.keys(reopenedResult), ['mode']);
  reopened.close();
});

test('新建侧库在 existsSync 后被第二连接抢先创建时必须锁内拒绝', {
  concurrency: false
}, (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-new-db-race-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  const dbDir = path.dirname(dbPath);
  const externalTable = 'sensitive_external_records';
  const injectedValue = 'sensitive-business-value';
  const originalMkdirSync = fs.mkdirSync;
  let injected = false;
  let injectedJournalMode = null;
  let rejection = null;
  let unexpectedService = null;
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  fs.mkdirSync = function mkdirWithNewDatabaseRace(target, options) {
    const result = originalMkdirSync.call(fs, target, options);
    if (!injected && path.resolve(String(target)) === dbDir) {
      const competingDb = new DatabaseSync(dbPath);
      try {
        competingDb.exec(`
          CREATE TABLE "${externalTable}" (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        competingDb.prepare(`
          INSERT INTO "${externalTable}"(id, value) VALUES (?, ?)
        `).run('external-row', injectedValue);
        injectedJournalMode = competingDb.prepare('PRAGMA journal_mode').get().journal_mode;
        injected = true;
      } finally {
        competingDb.close();
      }
    }
    return result;
  };

  try {
    assert.throws(
      () => {
        unexpectedService = createPositionReconciliationService({
          userDataDir,
          templatePath: TEMPLATE_PATH
        });
      },
      (error) => {
        rejection = error;
        return error
          && error.code === 'position-side-db-missing'
          && error.reason === '新建候选已存在用户 schema 对象';
      }
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
    if (unexpectedService) unexpectedService.close();
  }

  assert.equal(injected, true, '第二连接必须在 existsSync=false 后、Store 打开数据库前写入');
  assert.equal(rejection.code, 'position-side-db-missing');
  assert.equal(rejection.reason, '新建候选已存在用户 schema 对象');
  assert.doesNotMatch(
    [
      rejection.message,
      rejection.reason,
      ...(rejection.detailLines || [])
    ].join('\n'),
    new RegExp(`${externalTable}|${injectedValue}`),
    '结构化拒绝错误不得泄露外部表名或业务值'
  );

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const userSchemaObjects = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'view', 'trigger')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(userSchemaObjects, [{ type: 'table', name: externalTable }]);
  assert.deepEqual(
    db.prepare(`SELECT id, value FROM "${externalTable}"`).all().map((row) => ({ ...row })),
    [{ id: 'external-row', value: injectedValue }]
  );
  assert.equal(
    db.prepare('PRAGMA journal_mode').get().journal_mode,
    injectedJournalMode,
    '拒绝接管不得持久修改外部数据库的日志模式'
  );
  assert.equal(
    userSchemaObjects.some((item) => item.name.startsWith('position_')),
    false,
    '拒绝后不得残留现代侧库 schema 或 checkpoint'
  );
  db.close();
});

test('完整空旧侧库只在合法 generation 0 bootstrap 下原地升级', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-empty-legacy-upgrade-'));
  const dbPath = createEmptyLegacyPositionDatabase(userDataDir);
  const beforeStat = fs.statSync(dbPath);
  const bootstrap = {
    identity: 'empty-legacy-bootstrap-identity',
    generation: 0,
    token: 'empty-legacy-bootstrap-token'
  };
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const upgraded = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(upgraded.store.initializationResult(), {
    mode: POSITION_DB_INITIALIZATION_MODES.EMPTY_LEGACY_UPGRADE
  });
  assert.deepEqual(upgraded.persistenceCheckpoint(), bootstrap);
  assert.equal(
    upgraded.store.db.prepare('PRAGMA journal_mode').get().journal_mode,
    'wal',
    '空旧库升级提交后必须进入正式 WAL 模式'
  );
  upgraded.close();

  const afterStat = fs.statSync(dbPath);
  assert.equal(afterStat.ino, beforeStat.ino, '兼容初始化必须保留原侧库文件');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const modernTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `).all().map((row) => row.name);
  assert.ok(modernTables.includes('position_checkpoint_history'));
  assert.ok(modernTables.includes('position_operation_inputs'));
  const runRowColumns = db.prepare('PRAGMA table_info(position_run_rows)')
    .all().map((column) => column.name);
  assert.ok(runRowColumns.includes('consumes_source'));
  assert.ok(runRowColumns.includes('integrity_hash'));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_checkpoint_history').get().count,
    1
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_operation_inputs').get().count,
    0
  );
  for (const table of LEGACY_POSITION_TABLES.filter((table) => table !== 'position_meta')) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count,
      0,
      `${table} 不得生成业务行`
    );
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_meta').get().count,
    3,
    '只允许写入三项 checkpoint 元数据'
  );
  db.close();

  const restarted = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(restarted.store.initializationResult(), {
    mode: POSITION_DB_INITIALIZATION_MODES.EXISTING
  });
  assert.deepEqual(restarted.persistenceCheckpoint(), bootstrap);
  restarted.close();
});

test('空旧侧库预检后被第二连接写入时，加锁后的复检必须阻断升级', {
  concurrency: false
}, (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-legacy-race-'));
  const dbPath = createEmptyLegacyPositionDatabase(userDataDir);
  const injectedValue = 'sensitive-business-race-value';
  const bootstrap = {
    identity: 'legacy-race-bootstrap-identity',
    generation: 0,
    token: 'legacy-race-bootstrap-token'
  };
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  let rejection = null;
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  DatabaseSync.prototype.prepare = function prepareWithLegacyRace(sql) {
    const statement = originalPrepare.call(this, sql);
    const normalizedSql = String(sql);
    if (!injected
        && normalizedSql.includes('COUNT(*)')
        && normalizedSql.includes('FROM "position_source_rows"')) {
      const originalGet = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = originalGet(...args);
        const competingDb = new DatabaseSync(dbPath);
        try {
          competingDb.prepare(
            'INSERT INTO position_meta(key, value) VALUES (?, ?)'
          ).run('race-row', injectedValue);
          injected = true;
        } finally {
          competingDb.close();
        }
        return row;
      };
    }
    return statement;
  };

  try {
    assert.throws(
      () => createPositionReconciliationService({
        userDataDir,
        templatePath: TEMPLATE_PATH,
        initialSideDbCheckpoint: bootstrap
      }),
      (error) => {
        rejection = error;
        return error
          && error.code === 'position-side-db-missing'
          && error.reason === '旧版表不是空表：position_meta';
      }
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }

  assert.equal(injected, true, '故障注入必须发生在首次预检完成后');
  assert.equal(rejection.code, 'position-side-db-missing');
  assert.equal(rejection.reason, '旧版表不是空表：position_meta');
  assert.doesNotMatch(
    [rejection.message, ...(rejection.detailLines || [])].join('\n'),
    new RegExp(injectedValue),
    '拒绝错误不得泄露第二连接写入的业务值'
  );

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `).all().map((row) => row.name);
  assert.equal(tables.includes('position_checkpoint_history'), false);
  assert.equal(tables.includes('position_operation_inputs'), false);
  const runRowColumns = db.prepare('PRAGMA table_info(position_run_rows)')
    .all().map((column) => column.name);
  assert.equal(runRowColumns.includes('consumes_source'), false);
  assert.equal(runRowColumns.includes('integrity_hash'), false);
  assert.deepEqual(
    db.prepare('SELECT key, value FROM position_meta').all().map((row) => ({ ...row })),
    [{ key: 'race-row', value: injectedValue }]
  );
  db.close();
});

test('空旧侧库的 bootstrap 所有权或 generation 不合法时保持阻断', (t) => {
  const bootstrap = {
    identity: 'empty-legacy-guard-identity',
    generation: 0,
    token: 'empty-legacy-guard-token'
  };
  const cases = [
    {
      label: '主库已有 checkpoint',
      options: {
        requireExistingSideDb: true,
        expectedSideDbCheckpoint: bootstrap
      }
    },
    {
      label: '主库仍有 pending',
      options: {
        initialSideDbCheckpoint: bootstrap,
        expectedPendingOperation: {
          operationToken: 'empty-legacy-pending',
          baseCheckpoint: bootstrap
        }
      }
    },
    {
      label: '首次 bootstrap 不是 generation 0',
      options: {
        initialSideDbCheckpoint: {
          ...bootstrap,
          generation: 1
        }
      }
    }
  ];

  for (const item of cases) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-empty-legacy-${item.label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    createEmptyLegacyPositionDatabase(userDataDir);
    assert.throws(
      () => createPositionReconciliationService({
        userDataDir,
        templatePath: TEMPLATE_PATH,
        ...item.options
      }),
      (error) => error && error.code === 'position-side-db-missing',
      item.label
    );
  }
});

test('空旧侧库十张表任一非空都不得自动接管', (t) => {
  const bootstrap = {
    identity: 'non-empty-legacy-identity',
    generation: 0,
    token: 'non-empty-legacy-token'
  };
  for (const table of LEGACY_POSITION_TABLES) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-non-empty-legacy-${table}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const dbPath = createEmptyLegacyPositionDatabase(userDataDir);
    const db = new DatabaseSync(dbPath);
    insertLegacyPlaceholderRow(db, table);
    db.close();

    assert.throws(
      () => createPositionReconciliationService({
        userDataDir,
        templatePath: TEMPLATE_PATH,
        initialSideDbCheckpoint: bootstrap
      }),
      (error) => error && error.code === 'position-side-db-missing',
      `${table} 非空必须阻断`
    );
  }
});

test('空旧侧库缺表、错列或未知 schema 对象时保持阻断', (t) => {
  const bootstrap = {
    identity: 'legacy-schema-guard-identity',
    generation: 0,
    token: 'legacy-schema-guard-token'
  };
  const mutations = [
    ['缺表', 'DROP TABLE position_account_mappings;'],
    ['错列', 'ALTER TABLE position_bank_rows ADD COLUMN unexpected_column TEXT;'],
    [
      '列类型篡改',
      `DROP TABLE position_meta;
       CREATE TABLE position_meta (
         key INTEGER PRIMARY KEY,
         value TEXT NOT NULL
       );`
    ],
    [
      '非空约束篡改',
      `DROP TABLE position_meta;
       CREATE TABLE position_meta (
         key TEXT PRIMARY KEY,
         value TEXT
       );`
    ],
    [
      '默认值篡改',
      `DROP TABLE position_revisions;
       CREATE TABLE position_revisions (
         kind TEXT NOT NULL,
         scope_key TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 1,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY(kind, scope_key)
       );`
    ],
    [
      '主键篡改',
      `DROP TABLE position_meta;
       CREATE TABLE position_meta (
         key TEXT NOT NULL,
         value TEXT PRIMARY KEY
       );`
    ],
    [
      '同名索引定义篡改',
      `DROP INDEX idx_position_bank_scope;
       CREATE INDEX idx_position_bank_scope
         ON position_bank_rows(channel, month_key, status);`
    ],
    [
      'UNIQUE 约束缺失',
      `DROP TABLE position_runs;
       CREATE TABLE position_runs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_uuid TEXT NOT NULL,
         status TEXT NOT NULL,
         scope_json TEXT NOT NULL,
         snapshot_json TEXT NOT NULL,
         summary_json TEXT NOT NULL,
         exported_at TEXT,
         reimported_at TEXT,
         confirmed_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       CREATE INDEX idx_position_runs_status
         ON position_runs(status, id DESC);
       CREATE UNIQUE INDEX idx_position_runs_single_pending
         ON position_runs(status) WHERE status = 'pending';`
    ],
    [
      'FOREIGN KEY 约束缺失',
      `DROP TABLE position_run_rows;
       CREATE TABLE position_run_rows (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id INTEGER NOT NULL,
         biz_id TEXT NOT NULL,
         channel TEXT NOT NULL,
         month_key TEXT NOT NULL,
         source_order INTEGER NOT NULL,
         original_fund_type TEXT,
         result_fund_type TEXT,
         hit_summary TEXT,
         hit_type TEXT,
         match_detail TEXT,
         outcome TEXT NOT NULL,
         changed INTEGER NOT NULL DEFAULT 0,
         manual_modified INTEGER NOT NULL DEFAULT 0,
         original_json TEXT NOT NULL,
         result_json TEXT NOT NULL,
         lineage_json TEXT NOT NULL,
         UNIQUE(run_id, biz_id)
       );
       CREATE INDEX idx_position_run_rows_scope
         ON position_run_rows(run_id, channel, month_key, source_order);`
    ],
    ['未知表', 'CREATE TABLE unexpected_position_table (id INTEGER PRIMARY KEY);'],
    ['未知视图', 'CREATE VIEW unexpected_position_view AS SELECT key FROM position_meta;'],
    [
      '未知触发器',
      `CREATE TRIGGER unexpected_position_trigger
       AFTER INSERT ON position_meta
       BEGIN
         SELECT 1;
       END;`
    ]
  ];

  for (const [label, statement] of mutations) {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `position-legacy-schema-${label}-`)
    );
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const dbPath = createEmptyLegacyPositionDatabase(userDataDir);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(statement);
    db.close();

    assert.throws(
      () => createPositionReconciliationService({
        userDataDir,
        templatePath: TEMPLATE_PATH,
        initialSideDbCheckpoint: bootstrap
      }),
      (error) => error && error.code === 'position-side-db-missing',
      `${label} 必须阻断`
    );
  }
});

test('空旧侧库 quick_check 失败时不得修补或写入 checkpoint', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-legacy-corrupt-'));
  const dbPath = createEmptyLegacyPositionDatabase(userDataDir);
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  const rootPage = Number(db.prepare(`
    SELECT rootpage
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_position_bank_scope'
  `).get().rootpage);
  db.close();
  const fd = fs.openSync(dbPath, 'r+');
  try {
    fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize);
  } finally {
    fs.closeSync(fd);
  }
  const before = fs.readFileSync(dbPath);

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      initialSideDbCheckpoint: {
        identity: 'corrupt-legacy-identity',
        generation: 0,
        token: 'corrupt-legacy-token'
      }
    }),
    (error) => error && error.code === 'position-side-db-missing'
  );
  assert.deepEqual(fs.readFileSync(dbPath), before, '失败校验不得改写异常侧库');
});

test('首次 bootstrap 只绑定同一份 generation 0 侧库，旧 marker 和既有现代库均不得接管', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-bootstrap-'));
  const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-unrelated-'));
  const markerOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-marker-only-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  const markerOnlyPath = path.join(markerOnlyDir, POSITION_DB_RELATIVE_PATH);
  const bootstrap = {
    identity: 'bootstrap-identity',
    generation: 0,
    token: 'bootstrap-token'
  };
  t.after(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(unrelatedDir, { recursive: true, force: true });
    fs.rmSync(markerOnlyDir, { recursive: true, force: true });
  });

  const initialized = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(initialized.persistenceCheckpoint(), bootstrap);
  initialized.close();

  const recoveredBootstrap = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    initialSideDbCheckpoint: bootstrap
  });
  assert.deepEqual(recoveredBootstrap.persistenceCheckpoint(), bootstrap);
  recoveredBootstrap.close();

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '主库无 checkpoint/bootstrap 时不得接管已有现代侧库'
  );

  const unrelated = createPositionReconciliationService({
    userDataDir: unrelatedDir,
    templatePath: TEMPLATE_PATH
  });
  unrelated.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: unrelatedDir,
      templatePath: TEMPLATE_PATH,
      initialSideDbCheckpoint: bootstrap
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '另一份现代侧库不得被新的 bootstrap 接管'
  );

  fs.mkdirSync(path.dirname(markerOnlyPath), { recursive: true });
  const markerOnly = new DatabaseSync(markerOnlyPath);
  markerOnly.exec('CREATE TABLE position_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  markerOnly.prepare('INSERT INTO position_meta(key, value) VALUES (?, ?)').run(
    'position_database_initialized_v1',
    '1'
  );
  markerOnly.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: markerOnlyDir,
      templatePath: TEMPLATE_PATH,
      initialSideDbCheckpoint: bootstrap
    }),
    (error) => error && error.code === 'position-side-db-missing',
    '仅有旧 marker 的残缺库不得被补成空库'
  );
});

test('checkpoint 父链允许线性追平并阻断新旧 generation 分叉', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-checkpoint-'));
  const dbPath = path.join(userDataDir, POSITION_DB_RELATIVE_PATH);
  const backupPath = path.join(userDataDir, 'position-data-t1.sqlite');
  const divergedUserDataDir = path.join(userDataDir, 'diverged');
  const divergedDbPath = path.join(divergedUserDataDir, POSITION_DB_RELATIVE_PATH);
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  const initialService = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  const initialCheckpoint = initialService.persistenceCheckpoint();
  initialService.close();
  fs.copyFileSync(dbPath, backupPath);

  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow({
    BizId: 'CHECKPOINT-T2'
  })]);
  const currentService = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    operationTokenProvider: () => 'linear-operation'
  });
  const prepared = currentService.prepareBankImport([bankPath]);
  currentService.applyBankImport(prepared.token);
  const currentCheckpoint = currentService.persistenceCheckpoint();
  assert.ok(currentCheckpoint.generation > initialCheckpoint.generation);
  assert.notEqual(currentCheckpoint.token, initialCheckpoint.token);
  assert.equal(currentCheckpoint.identity, initialCheckpoint.identity);
  currentService.close();

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: initialCheckpoint
    }),
    (error) => error && error.code === 'position-side-db-mismatch',
    '仅恢复旧主库、没有待完成操作记录时不得沿父链误追平'
  );
  const recoveredAfterMainCheckpointLag = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    expectedPendingOperation: {
      operationToken: 'linear-operation',
      baseCheckpoint: initialCheckpoint
    }
  });
  assert.deepEqual(recoveredAfterMainCheckpointLag.persistenceCheckpoint(), currentCheckpoint);
  recoveredAfterMainCheckpointLag.close();

  fs.mkdirSync(path.dirname(divergedDbPath), { recursive: true });
  fs.copyFileSync(backupPath, divergedDbPath);
  const divergedService = createPositionReconciliationService({
    userDataDir: divergedUserDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint,
    operationTokenProvider: () => 'diverged-operation'
  });
  divergedService.saveMappings([]);
  divergedService.saveMappings([{
    midAccountId: 'DIVERGED-MID',
    clearingAccountId: 'DIVERGED-CLEARING'
  }]);
  const divergedCheckpoint = divergedService.persistenceCheckpoint();
  assert.equal(divergedCheckpoint.identity, currentCheckpoint.identity);
  assert.ok(divergedCheckpoint.generation > currentCheckpoint.generation);
  divergedService.close();
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir: divergedUserDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: currentCheckpoint,
      expectedPendingOperation: {
        operationToken: 'diverged-operation',
        baseCheckpoint: currentCheckpoint
      }
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );

  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.copyFileSync(backupPath, dbPath);

  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: currentCheckpoint
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );
  assert.throws(
    () => createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      requireExistingSideDb: true,
      expectedSideDbCheckpoint: {
        ...initialCheckpoint,
        token: 'same-generation-different-history'
      }
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );

  const restoredTogether = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    requireExistingSideDb: true,
    expectedSideDbCheckpoint: initialCheckpoint
  });
  assert.deepEqual(restoredTogether.persistenceCheckpoint(), initialCheckpoint);
  restoredTogether.close();
});

test('运行范围、快照和汇总 JSON 语法合法但结构不完整时必须 fail-closed', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-run-envelope-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const sourcePath = path.join(userDataDir, 'inbound.xlsx');
  writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
  writeWorkbook(
    sourcePath,
    '账单明细',
    SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
    [inboundRow()]
  );
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH
  });
  t.after(() => {
    service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  service.applyBankImport(service.prepareBankImport([bankPath]).token);
  assert.equal(service.prepareSourceImport([sourcePath]).successCount, 1);
  const run = service.run({ channels: ['DBS'], months: ['2026-07'] });
  const stored = service.store.db.prepare(
    'SELECT scope_json, snapshot_json, summary_json FROM position_runs WHERE id = ?'
  ).get(run.runId);
  const scopeWithUnusedChannel = JSON.parse(stored.scope_json);
  scopeWithUnusedChannel.channels.push('UNUSED');
  const summaryWithoutManualCount = JSON.parse(stored.summary_json);
  delete summaryWithoutManualCount.manualModifiedRows;
  for (const [column, invalidValue] of [
    ['scope_json', JSON.stringify(scopeWithUnusedChannel)],
    ['snapshot_json', '{"rulesetVersion":1}'],
    ['summary_json', JSON.stringify(summaryWithoutManualCount)]
  ]) {
    service.store.db.prepare(
      `UPDATE position_runs SET ${column} = ? WHERE id = ?`
    ).run(invalidValue, run.runId);
    assert.throws(
      () => service.store.getRun(run.runId),
      (error) => error && error.code === 'position-side-data-invalid',
      `${column} 缺字段时必须阻断`
    );
    service.store.db.prepare(
      `UPDATE position_runs SET ${column} = ? WHERE id = ?`
    ).run(stored[column], run.runId);
  }

  const jointlyTamperedSnapshot = JSON.parse(stored.snapshot_json);
  const jointlyTamperedSummary = JSON.parse(stored.summary_json);
  jointlyTamperedSnapshot.sources = {};
  jointlyTamperedSummary.sourceTypes = [];
  service.store.db.prepare(`
    UPDATE position_runs SET snapshot_json = ?, summary_json = ? WHERE id = ?
  `).run(
    JSON.stringify(jointlyTamperedSnapshot),
    JSON.stringify(jointlyTamperedSummary),
    run.runId
  );
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '快照和汇总共同篡改来源集合也必须由原始运行行识别'
  );

  const tamperedConflictSummary = JSON.parse(stored.summary_json);
  tamperedConflictSummary.engine.confirmedConsumptionConflicts += 1;
  service.store.db.prepare(`
    UPDATE position_runs SET snapshot_json = ?, summary_json = ? WHERE id = ?
  `).run(stored.snapshot_json, JSON.stringify(tamperedConflictSummary), run.runId);
  assert.throws(
    () => service.store.getRun(run.runId),
    (error) => error && error.code === 'position-side-data-invalid',
    '已确认消费冲突计数必须与逐行血缘一致'
  );
});
