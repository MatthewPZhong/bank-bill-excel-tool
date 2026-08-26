'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const {
  createBackgroundExecutionRuntime,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  createArchiveRepository,
  ensureArchiveMetadataSupport
} = require('../../../../src/backend/database/archive-repository');
const {
  canonicalSha256
} = require('../../../../src/main-process/background-execution/canonical-json-v1');
const {
  assertFinanceSafeValue
} = require('../../../../src/main-process/background-execution/error-codec');
const {
  createRecoveryControlReadRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createInspectorRegistry
} = require('../../../../src/main-process/background-execution/inspector-registry');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../../../src/main-process/background-execution/startup-recovery-coordinator');

const { PreFundReconciliationStore } = require(
  '../../../../src/backend/pre-fund-reconciliation-store'
);
const runDataStore = require('../../../../src/backend/run-data-store');
const { sourceSnapshotFromStat } = require(
  '../../../../src/main-process/archive-center/source-snapshot'
);
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  derivePreFundMptConflictScopeKey
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope');
const {
  createPreFundMptHoldGate
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/hold-gate');
const {
  executeManagedPreFundMptImport
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/managed-import');
const {
  readAndValidateMptFileSpool
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-reader');
const {
  createOrderedMptCoordinator
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator');
const {
  createPreFundMptOutcomeInspector
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector');
const {
  PRE_FUND_MPT_POLICIES,
  validatePreFundMptImportResult,
  validatePreFundMptRepairResult
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/policies');
const {
  readParserOutcome,
  writeParserOutcome
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome');
const {
  allowMptFinanceSafeValue,
  isSafeMptErrorText,
  safeMptFileName
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety');
const {
  preFundMptRecoveryPlanTransitions
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/recovery-plan');
const {
  createSingleWriterSession,
  normalizeUnitInput
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session');
const {
  deriveFileIdentity,
  mptSpoolPaths
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-contract');
const {
  createWorkerDurableCoordinator
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator');
const {
  createPreFundMptReceiptAuthority
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority');
const {
  getOperationReceipt,
  normalizeExactOperationReceipt
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository');
const {
  cleanupMptFileSpool,
  cleanupMptSpoolParents,
  writeMptFileSpool
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-writer');
const {
  createPreFundReconciliationService
} = require('../../../../src/main-process/pre-fund-reconciliation/service');

let tempRoot;
let userDataDir;

function createIsolatedPoolGovernor() {
  return createResourceGovernor({
    budgets: {
      cpuSlots: 5,
      workerThreadSlots: 6,
      utilityProcessSlots: 1,
      ioHeavySlots: 5,
      memoryBytes: 2 * 1024 ** 3
    }
  });
}

test.beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-b-'));
  userDataDir = path.join(tempRoot, 'user-data');
  fs.mkdirSync(userDataDir);
});

test.afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function inboundRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_INBOUND_20260708',
    billDate: '2026-07-08',
    channel: 'CITI',
    entity: 'PPEU',
    merchantId: 'M-001',
    business: 'MPT',
    oppBu: 'SMB',
    tradeType: 'Inbound-VA',
    fileId: 'FILE-1',
    txId: 'TX-1',
    orderId: 'ORDER-1',
    reconId: 'RECON-1',
    billReconId: 'BILL-1',
    currency: 'USD',
    originAmount: '1.23',
    fee: '0',
    amount: '1.23',
    payerName: '付款人',
    payerAccount: 'A-1',
    valueDate: '2026-07-08',
    bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03',
    businessDate: '2026-07-08',
    tradeScope: 'INBOUND',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    batchSeq: '1',
    ...overrides
  };
  return INBOUND_FIELDS.map((field) => values[field] || '');
}

function writeFile(sequence, rows, sourceBatch = 'MPT_INBOUND_20260708') {
  const filePath = path.join(tempRoot, `MPT_INBOUND_GATEWAY_20260708_${sequence}.txt`);
  const header = ['20260708', sourceBatch, String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

function spoolInput(filePath, parentOperationKey, fileIndex = 0, disposition = 'error') {
  return {
    taskStagingDir: path.join(tempRoot, 'task-staging'),
    jobId: `job-${parentOperationKey.replace(/[^a-z0-9]/gi, '-')}`,
    fileIndex,
    parentOperationKey,
    source: {
      filePath,
      sourceSnapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
    },
    invalidRowDisposition: disposition,
    batchSize: 2
  };
}

function managedOptions(parentOperationKey, datasetId, overrides = {}) {
  const fileIndex = overrides.fileIndex || 0;
  return {
    actionKey: overrides.actionKey || 'pre-fund:mpt-import',
    operationKey: `${parentOperationKey}/file/${String(fileIndex).padStart(6, '0')}`,
    producerTaskRunId: overrides.producerTaskRunId || 'task-run-1',
    datasetId,
    fileIndex,
    ...overrides
  };
}

function mirrorDatabase() {
  const noop = () => null;
  return {
    dbPath: path.join(userDataDir, 'tool-data.sqlite'),
    createPreFundReconciliationRunMirror: noop,
    finishPreFundReconciliationRunMirror: noop,
    getPreFundReconciliationRunMirrorByTaskRun: noop,
    acknowledgePreFundReconciliationRunMirror: noop,
    failPreFundReconciliationRunMirror: noop,
    markPreFundReconciliationRunMirrorUnavailable: noop,
    listPreFundReconciliationRunMirrors: () => []
  };
}

test('validated spool Writer以同事务receipt覆盖insert、exact replay、noop与replacement lineage', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const inspect = createPreFundMptOutcomeInspector({ userDataDir });
  const receiptAuthority = createPreFundMptReceiptAuthority({
    userDataDir,
    outcomeInspector: inspect
  });
  const firstPath = writeFile('101', [inboundRow({ reconId: 'FIRST', amount: '001.2300' })]);
  const firstInput = spoolInput(firstPath, 'parent-insert');
  const firstWritten = await writeMptFileSpool(firstInput);
  const firstOptions = managedOptions('parent-insert', 'dataset-1');

  const inserted = await store.importValidatedSpool(firstInput, firstOptions);
  assert.equal(inserted.status, 'imported');
  assert.equal(inserted.batch.datasetVersion, 1);
  assert.equal(inserted.batch.datasetId, 'dataset-1');
  assert.equal(inserted.batch.producerTaskRunId, 'task-run-1');
  assert.equal(inserted.batch.rowCount, 1);
  const originalBatchId = inserted.batch.id;
  assert.equal((await receiptAuthority.verify({
    source: recoverySourceFrom(firstWritten, firstOptions, inserted),
    receipt: inserted.receipt
  })).outcomeKind, 'inserted');
  const incompleteReceipt = { ...inserted.receipt };
  delete incompleteReceipt.contentHash;
  await assert.rejects(() => receiptAuthority.verify({
    source: recoverySourceFrom(firstWritten, firstOptions, inserted),
    receipt: incompleteReceipt
  }), { code: 'WORKER_DURABLE_RECEIPT_SHAPE_INVALID' });
  const wrongInspectionAuthority = createPreFundMptReceiptAuthority({
    userDataDir,
    async outcomeInspector(source) {
      return { ...(await inspect(source)), operationKey: 'wrong/file/000000' };
    }
  });
  await assert.rejects(() => wrongInspectionAuthority.verify({
    source: recoverySourceFrom(firstWritten, firstOptions, inserted),
    receipt: inserted.receipt
  }), { code: 'WORKER_DURABLE_RECEIPT_EVIDENCE_INVALID' });

  const replay = await store.importValidatedSpool(firstInput, firstOptions);
  assert.equal(replay.status, 'imported');
  assert.equal(replay.batch.id, originalBatchId);
  assert.equal(replay.receipt.id, inserted.receipt.id);

  const noopInput = spoolInput(firstPath, 'parent-noop');
  const noopWritten = await writeMptFileSpool(noopInput);
  const noopOptions = managedOptions('parent-noop', 'unused-seed');
  const noop = await store.importValidatedSpool(noopInput, noopOptions);
  assert.equal(noop.status, 'noop');
  assert.equal(noop.batch.id, originalBatchId);
  assert.equal(noop.receipt.outcomeKind, 'noop-existing-batch');
  assert.equal(noop.receipt.datasetId, 'dataset-1');
  assert.equal(noop.receipt.datasetVersionBefore, 1);
  assert.equal(noop.receipt.datasetVersionAfter, 1);
  assert.equal((await receiptAuthority.verify({
    source: recoverySourceFrom(noopWritten, noopOptions, noop),
    receipt: noop.receipt
  })).outcomeKind, 'noop-existing-batch');
  const replacementPath = writeFile('102', [
    inboundRow({ reconId: 'REPLACED-1', currency: 'EUR', amount: '2.50' }),
    inboundRow({ reconId: 'REPLACED-2', currency: 'USD', amount: '3.75' })
  ]);
  const replacementInput = spoolInput(replacementPath, 'parent-replace');
  const replacementWritten = await writeMptFileSpool(replacementInput);
  const replacementOptions = managedOptions('parent-replace', 'dataset-2', {
    producerTaskRunId: 'task-run-2'
  });
  const replaced = await store.importValidatedSpool(
    replacementInput,
    replacementOptions
  );
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.batch.id, originalBatchId, 'replacement必须保留batch.id');
  assert.equal(replaced.batch.datasetVersion, 2);
  assert.equal(replaced.batch.datasetId, 'dataset-2');
  assert.equal(replaced.receipt.datasetVersionBefore, 1);
  assert.equal(replaced.receipt.datasetVersionAfter, 2);
  assert.equal(replaced.receipt.outcomeKind, 'replaced');
  assert.equal((await receiptAuthority.verify({
    source: recoverySourceFrom(replacementWritten, replacementOptions, replaced),
    receipt: replaced.receipt
  })).outcomeKind, 'replaced');
  const db = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07')
  );
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_operation_receipts').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_reconciliation_gateway_rows').get().n, 2);
    assert.equal(getOperationReceipt(db, firstOptions.actionKey, firstOptions.operationKey).outcomeKind, 'inserted');
  } finally {
    db.close();
  }
});

test('historical additive migration v0的repair noop 0→0与import replacement 0→1可形成authoritative receipt', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const originalPath = writeFile('120', [inboundRow({ reconId: 'HISTORICAL-V0' })]);
  const historical = await store.importLegacyFile(originalPath);
  assert.equal(historical.batch.datasetVersion, 0);

  const dbPath = runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION,
    '2026-07'
  );
  const legacyDb = runDataStore.openExistingSideDb(dbPath);
  try {
    legacyDb.exec(`
      DROP TRIGGER trg_pre_fund_gateway_batch_legacy_update;
      DROP INDEX idx_pre_fund_gateway_batches_dataset;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN archive_contract_version;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN dataset_version;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN producer_task_run_id;
      ALTER TABLE pre_fund_reconciliation_gateway_batches DROP COLUMN dataset_id;
    `);
  } finally {
    legacyDb.close();
  }

  const migrated = store.listBatches({ monthKey: '2026-07' })[0];
  assert.equal(migrated.id, historical.batch.id);
  assert.equal(migrated.datasetVersion, 0);
  assert.equal(migrated.archiveContractVersion, 0);
  assert.equal(migrated.producerTaskRunId, null);
  assert.match(migrated.datasetId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const inspect = createPreFundMptOutcomeInspector({ userDataDir });
  const receiptAuthority = createPreFundMptReceiptAuthority({
    userDataDir,
    outcomeInspector: inspect
  });
  const noopInput = spoolInput(originalPath, 'parent-historical-v0-noop', 0, 'excluded');
  const noopWritten = await writeMptFileSpool(noopInput);
  const noopOptions = managedOptions('parent-historical-v0-noop', 'unused-v1-seed', {
    actionKey: 'pre-fund:mpt-repair-import',
    skipInvalidRows: true,
    expectedContentHash: noopWritten.manifest.contentHash
  });
  const noop = await store.importValidatedSpool(noopInput, noopOptions);
  assert.equal(noop.status, 'noop');
  assert.equal(noop.receipt.datasetVersionBefore, 0);
  assert.equal(noop.receipt.datasetVersionAfter, 0);
  assert.equal((await inspect(recoverySourceFrom(noopWritten, noopOptions, noop))).outcome, 'committed');
  assert.equal((await receiptAuthority.verify({
    source: recoverySourceFrom(noopWritten, noopOptions, noop),
    receipt: noop.receipt
  })).outcomeKind, 'noop-existing-batch');
  const noopReplay = await store.importValidatedSpool(noopInput, noopOptions);
  assert.equal(noopReplay.receipt.id, noop.receipt.id);
  assert.equal(noopReplay.receipt.datasetVersionBefore, 0);
  assert.equal(noopReplay.receipt.datasetVersionAfter, 0);
  assert.throws(() => normalizeExactOperationReceipt({
    ...noop.receipt,
    datasetVersionBefore: -1
  }), TypeError);
  assert.throws(() => normalizeExactOperationReceipt({
    ...noop.receipt,
    datasetVersionBefore: Number.MAX_SAFE_INTEGER + 1,
    datasetVersionAfter: Number.MAX_SAFE_INTEGER + 1
  }), TypeError);
  assert.throws(() => normalizeExactOperationReceipt({
    ...noop.receipt,
    datasetVersionAfter: 1
  }), TypeError);

  const replacementPath = writeFile('121', [inboundRow({ reconId: 'HISTORICAL-V0-REPLACED' })]);
  const replacementInput = spoolInput(replacementPath, 'parent-historical-v0-replace');
  const replacementWritten = await writeMptFileSpool(replacementInput);
  const replacementOptions = managedOptions(
    'parent-historical-v0-replace',
    'historical-v0-upgraded-dataset',
    { producerTaskRunId: 'historical-v0-replacement-task' }
  );
  const replaced = await store.importValidatedSpool(replacementInput, replacementOptions);
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.batch.id, historical.batch.id);
  assert.equal(replaced.receipt.datasetVersionBefore, 0);
  assert.equal(replaced.receipt.datasetVersionAfter, 1);
  assert.equal((await inspect(
    recoverySourceFrom(replacementWritten, replacementOptions, replaced)
  )).outcome, 'committed');
  assert.equal((await receiptAuthority.verify({
    source: recoverySourceFrom(replacementWritten, replacementOptions, replaced),
    receipt: replaced.receipt
  })).outcomeKind, 'replaced');
  const replacementReplay = await store.importValidatedSpool(replacementInput, replacementOptions);
  assert.equal(replacementReplay.receipt.id, replaced.receipt.id);
  assert.equal(replacementReplay.receipt.datasetVersionBefore, 0);
  assert.equal(replacementReplay.receipt.datasetVersionAfter, 1);
  assert.throws(() => normalizeExactOperationReceipt({
    ...replaced.receipt,
    datasetVersionAfter: 2
  }), TypeError);
  assert.throws(() => normalizeExactOperationReceipt({
    ...replaced.receipt,
    outcomeKind: 'inserted',
    datasetVersionBefore: 0
  }), TypeError);
});

test('Single Writer首遍预验证加ACK后streaming transaction总计只扫描spool两遍', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const filePath = writeFile('105', [
    inboundRow({ reconId: 'TWO-PASS-1' }),
    inboundRow({ reconId: 'TWO-PASS-2' })
  ]);
  const input = spoolInput(filePath, 'parent-two-pass');
  await writeMptFileSpool(input);
  const paths = mptSpoolPaths(input);
  const scans = { rows: 0, issues: 0 };
  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function countedCreateReadStream(file, ...args) {
    if (file === paths.rowsReady) scans.rows += 1;
    if (file === paths.issuesReady) scans.issues += 1;
    return originalCreateReadStream.call(this, file, ...args);
  };
  try {
    const prevalidatedSpool = await readAndValidateMptFileSpool(input);
    const result = await store.importValidatedSpool(input, {
      ...managedOptions('parent-two-pass', 'dataset-two-pass'),
      prevalidatedSpool
    });
    assert.equal(result.status, 'imported');
    assert.deepEqual(scans, { rows: 2, issues: 2 });
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});

test('same operation不同source identity fail closed，低序号与同名异hash不产生receipt', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const currentPath = writeFile('200', [inboundRow({ reconId: 'CURRENT' })]);
  const currentInput = spoolInput(currentPath, 'parent-current');
  await writeMptFileSpool(currentInput);
  await store.importValidatedSpool(currentInput, managedOptions('parent-current', 'dataset-current'));

  const lowPath = writeFile('199', [inboundRow({ reconId: 'LOW' })]);
  const lowInput = spoolInput(lowPath, 'parent-low');
  await writeMptFileSpool(lowInput);
  await assert.rejects(
    () => store.importValidatedSpool(lowInput, managedOptions('parent-low', 'dataset-low')),
    (error) => error.code === 'MPT_BATCH_SEQUENCE_STALE'
  );

  fs.writeFileSync(currentPath, fs.readFileSync(currentPath, 'utf8').replace('CURRENT', 'CHANGED'), 'utf8');
  const conflictInput = spoolInput(currentPath, 'parent-conflict');
  await writeMptFileSpool(conflictInput);
  await assert.rejects(
    () => store.importValidatedSpool(conflictInput, managedOptions('parent-conflict', 'dataset-conflict')),
    (error) => error.code === 'MPT_FILE_IDENTITY_CONFLICT'
  );

  const differentPath = writeFile('201', [inboundRow({ reconId: 'DIFFERENT' })]);
  const identityConflict = spoolInput(differentPath, 'parent-current');
  identityConflict.jobId = 'job-parent-current-conflict-source';
  await writeMptFileSpool(identityConflict);
  await assert.rejects(
    () => store.importValidatedSpool(identityConflict, managedOptions('parent-current', 'dataset-current')),
    (error) => error.code === 'PREFUND_RECEIPT_IDENTITY_CONFLICT'
  );

  const db = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07')
  );
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_operation_receipts').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_reconciliation_gateway_batches').get().n, 1);
  } finally {
    db.close();
  }
});

test('repair spool保持valid+excluded=declared守恒并同事务记录repair receipt', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const filePath = writeFile('301', [
    inboundRow({ reconId: 'VALID' }),
    inboundRow({ reconId: 'INVALID', amount: 'bad' })
  ]);
  const input = spoolInput(filePath, 'parent-repair', 0, 'excluded');
  const written = await writeMptFileSpool(input);
  const result = await store.importValidatedSpool(input, managedOptions('parent-repair', 'dataset-repair', {
    actionKey: 'pre-fund:mpt-repair-import',
    skipInvalidRows: true,
    expectedContentHash: written.manifest.contentHash
  }));
  assert.equal(result.batch.declaredRowCount, 2);
  assert.equal(result.batch.rowCount, 1);
  assert.equal(result.batch.excludedRowCount, 1);
  assert.equal(result.batch.importMode, 'exclude-invalid-rows');
  assert.equal(result.receipt.actionKey, 'pre-fund:mpt-repair-import');
});

test('opaque exact batch scope：同identity一致，同月不同batch不互阻，import/repair action无关', () => {
  const first = derivePreFundMptConflictScopeKey({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'BATCH-A'
  });
  assert.equal(first, derivePreFundMptConflictScopeKey({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'BATCH-A'
  }));
  assert.notEqual(first, derivePreFundMptConflictScopeKey({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'BATCH-B'
  }));
  assert.match(first, /^pre-fund:mpt-batch:[a-f0-9]{64}$/);
});

test('legacy与spool同名同hash noop先于repair token校验；receipt replay校验真实行数', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const filePath = writeFile('401', [inboundRow({ reconId: 'NOOP-PARITY' })]);
  const legacy = await store.importFile(filePath, {
    datasetSeed: { datasetId: 'legacy-dataset', producerTaskRunId: 'legacy-task' }
  });
  const noopLegacy = await store.importFile(filePath, {
    skipInvalidRows: true,
    expectedContentHash: '0'.repeat(64),
    datasetSeed: { datasetId: 'unused-legacy', producerTaskRunId: 'legacy-noop-task' }
  });
  assert.equal(noopLegacy.status, 'noop');
  assert.equal(noopLegacy.batch.id, legacy.batch.id);

  const input = spoolInput(filePath, 'parent-noop-order', 0, 'excluded');
  await writeMptFileSpool(input);
  const options = managedOptions('parent-noop-order', 'unused-spool', {
    actionKey: 'pre-fund:mpt-repair-import',
    skipInvalidRows: true,
    expectedContentHash: 'f'.repeat(64)
  });
  const noopSpool = await store.importValidatedSpool(input, options);
  assert.equal(noopSpool.status, 'noop');

  const dbPath = runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION,
    '2026-07'
  );
  const db = runDataStore.openExistingSideDb(dbPath);
  try {
    db.prepare('DELETE FROM pre_fund_reconciliation_gateway_rows WHERE batch_id = ?')
      .run(legacy.batch.id);
  } finally {
    db.close();
  }
  await assert.rejects(
    () => store.importValidatedSpool(input, options),
    (error) => error.code === 'PREFUND_RECEIPT_IDENTITY_CONFLICT'
  );
});

function recoverySourceFrom(written, options, result) {
  const header = written.manifest.header;
  return {
    contractVersion: 1,
    sourceKind: 'critical-intent',
    sourceRef: `critical-intent:${options.operationKey}`,
    actionKey: options.actionKey,
    operationKey: options.operationKey,
    taskRunId: options.producerTaskRunId,
    conflictScopeKey: derivePreFundMptConflictScopeKey(header),
    inspectorKey: `inspector.${options.actionKey}`,
    settlementKey: null,
    intentId: `intent-${options.fileIndex}`,
    evidenceVersion: 1,
    boundedEvidence: {
      fileIndex: options.fileIndex,
      sourceType: header.sourceType,
      sourceBatch: header.sourceBatch,
      sourceDate: header.sourceDate,
      sourceFileSequence: header.sourceFileSequence,
      monthKey: header.sourceDate.slice(0, 7),
      sourceFileName: header.sourceFileName,
      sourceSha256: written.manifest.source.sha256,
      contentHash: written.manifest.contentHash,
      datasetId: options.datasetId,
      counts: written.manifest.counts,
      archiveBatchId: result ? result.batch.id : 999,
      parentOperationKey: options.operationKey.split('/file/')[0]
    }
  };
}

test('Inspector canonical只读：insert/noop committed，缺receipt not-committed，receipt-only与缺行unknown', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const filePath = writeFile('501', [inboundRow({ reconId: 'INSPECT' })]);
  const firstInput = spoolInput(filePath, 'inspect-insert');
  const firstWritten = await writeMptFileSpool(firstInput);
  const firstOptions = managedOptions('inspect-insert', 'inspect-dataset');
  const inserted = await store.importValidatedSpool(firstInput, firstOptions);
  const inspect = createPreFundMptOutcomeInspector({ userDataDir });
  assert.equal((await inspect(recoverySourceFrom(firstWritten, firstOptions, inserted))).outcome, 'committed');

  const julyPath = runDataStore.sideDbPath(
    userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'
  );
  const augustPath = runDataStore.sideDbPath(
    userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-08'
  );
  fs.copyFileSync(julyPath, augustPath);
  const duplicateDb = runDataStore.openExistingSideDb(augustPath);
  try {
    duplicateDb.exec('DELETE FROM pre_fund_operation_receipts');
  } finally {
    duplicateDb.close();
  }
  const duplicateInspection = await inspect(recoverySourceFrom(firstWritten, firstOptions, inserted));
  assert.equal(duplicateInspection.outcome, 'unknown');
  assert.equal(duplicateInspection.boundedEvidence.businessMatchCount, 2);
  fs.rmSync(augustPath);

  const noopInput = spoolInput(filePath, 'inspect-noop');
  const noopWritten = await writeMptFileSpool(noopInput);
  const noopOptions = managedOptions('inspect-noop', 'unused-noop', {
    producerTaskRunId: 'inspect-noop-task'
  });
  const noop = await store.importValidatedSpool(noopInput, noopOptions);
  assert.equal(noop.receipt.outcomeKind, 'noop-existing-batch');
  assert.equal((await inspect(recoverySourceFrom(noopWritten, noopOptions, noop))).outcome, 'committed');

  const absentOptions = managedOptions('inspect-absent', 'absent-dataset', {
    producerTaskRunId: 'absent-task'
  });
  assert.equal((await inspect(recoverySourceFrom(firstWritten, absentOptions))).outcome, 'not-committed');

  const db = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION,
    '2026-07'
  ));
  try {
    db.prepare('DELETE FROM pre_fund_reconciliation_gateway_rows WHERE batch_id = ?').run(inserted.batch.id);
  } finally {
    db.close();
  }
  assert.equal((await inspect(recoverySourceFrom(firstWritten, firstOptions, inserted))).outcome, 'unknown');
  const db2 = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION,
    '2026-07'
  ));
  try {
    db2.prepare('DELETE FROM pre_fund_reconciliation_gateway_batches WHERE id = ?').run(inserted.batch.id);
  } finally {
    db2.close();
  }
  assert.equal((await inspect(recoverySourceFrom(noopWritten, noopOptions, noop))).outcome, 'unknown');
});

test('exact Hold gate：同batch import/repair/delete阻断，同月不同batch继续，date-range与clear覆盖旁路', async () => {
  const heldScope = derivePreFundMptConflictScopeKey({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708'
  });
  const holds = [{ conflictScopeKey: heldScope, actionKey: 'pre-fund:mpt-import' }];
  const gate = createPreFundMptHoldGate({
    readRepository: { listActiveRecoveryHolds: () => holds },
    recoveryHoldGate: {
      assertNoRecoveryHold({ conflictScopeKey }) {
        if (conflictScopeKey === heldScope) throw Object.assign(new Error('held'), { code: 'RECOVERY_HOLD_ACTIVE' });
      }
    }
  });
  const heldPath = writeFile('601', [inboundRow()]);
  await assert.rejects(() => gate.inspectFiles([heldPath]), { code: 'RECOVERY_HOLD_ACTIVE' });
  await assert.rejects(() => gate.inspectFiles([heldPath], [{
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708'
  }]), { code: 'RECOVERY_HOLD_ACTIVE' });
  const otherBatch = 'MPT_INBOUND_20260708_ALT';
  const otherPath = writeFile('602', [
    inboundRow({ batchNo: otherBatch })
  ], otherBatch);
  assert.equal((await gate.inspectFiles([otherPath])).conflictScopeKeys.length, 1);
  assert.doesNotThrow(() => gate.assertDeleteBatch({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: otherBatch
  }));
  assert.throws(() => gate.assertDeleteBatch({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708'
  }), { code: 'RECOVERY_HOLD_ACTIVE' });
  const service = {
    inspectTempDateRange() {
      return { range: {
        sourceType: 'MPT_INBOUND_GATEWAY', start: '2026-07-01', end: '2026-07-31'
      }, identities: [{
        sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708', sourceDate: '2026-07-08'
      }] };
    }
  };
  assert.throws(() => gate.assertDeleteDateRange(service, {
    sourceType: 'MPT_INBOUND_GATEWAY', start: '2026-07-01', end: '2026-07-31'
  }), { code: 'RECOVERY_HOLD_ACTIVE' });
  assert.throws(() => gate.assertAnyMutationAllowed(), { code: 'RECOVERY_HOLD_ACTIVE' });
});

test('date-range Hold gate与legacy删除共享trim后的权威range，held batch不可被空白payload绕过', async () => {
  const service = createPreFundReconciliationService({
    userDataDir,
    database: mirrorDatabase(),
    templatePath: 'unused.xlsx'
  });
  const heldPath = writeFile('603', [inboundRow({ reconId: 'HELD-RANGE-ROW' })]);
  const imported = await service.importMptFiles([heldPath], {
    producerTaskRunId: 'held-range-task'
  });
  assert.equal(imported.results[0].status, 'ok');
  const heldScope = derivePreFundMptConflictScopeKey({
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708'
  });
  const gate = createPreFundMptHoldGate({
    readRepository: {
      listActiveRecoveryHolds: () => [{ conflictScopeKey: heldScope }]
    },
    recoveryHoldGate: {
      assertNoRecoveryHold({ conflictScopeKey }) {
        if (conflictScopeKey === heldScope) {
          throw Object.assign(new Error('held exact range'), { code: 'RECOVERY_HOLD_ACTIVE' });
        }
      }
    }
  });
  let deleteCalls = 0;
  const deleteWithGate = async (payload) => {
    const range = gate.assertDeleteDateRange(service, payload);
    deleteCalls += 1;
    return service.deleteTempByDateRange(range);
  };
  await assert.rejects(() => deleteWithGate({
    sourceType: '  MPT_INBOUND_GATEWAY  ',
    start: ' 2026-07-01 ',
    end: ' 2026-07-31 '
  }), { code: 'RECOVERY_HOLD_ACTIVE' });
  assert.equal(deleteCalls, 0);
  assert.deepEqual(service.countTempByDateRange({
    sourceType: 'MPT_INBOUND_GATEWAY', start: '2026-07-01', end: '2026-07-31'
  }), { batchCount: 1, rowCount: 1 });
  assert.doesNotThrow(() => gate.assertDeleteDateRange(service, {
    sourceType: ' MPT_INBOUND_GATEWAY ', start: ' 2026-07-09 ', end: ' 2026-07-31 '
  }), '范围外active scope不得误阻');

  const openGate = createPreFundMptHoldGate({
    readRepository: { listActiveRecoveryHolds: () => [] },
    recoveryHoldGate: { assertNoRecoveryHold() {} }
  });
  const normalized = openGate.assertDeleteDateRange(service, {
    sourceType: ' MPT_INBOUND_GATEWAY ', start: ' 2026-07-01 ', end: ' 2026-07-31 '
  });
  const deleted = await service.deleteTempByDateRange(normalized);
  assert.equal(deleted.deletedBatches, 1);
  assert.equal(deleted.deletedRows, 1);
});

test('legacy mutation在BEGIN前按实际header identity复核Hold，prepare后换成held batch不能写入', async () => {
  const store = new PreFundReconciliationStore(userDataDir);
  const preparedBatch = 'MPT_INBOUND_20260708_PREPARED';
  const filePath = writeFile('611', [inboundRow({ batchNo: preparedBatch })], preparedBatch);
  const seen = [];
  fs.writeFileSync(
    filePath,
    `${[['20260708', 'MPT_INBOUND_20260708_HELD', '1'], inboundRow({
      batchNo: 'MPT_INBOUND_20260708_HELD', reconId: 'HELD-AFTER-PREPARE'
    })].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  await assert.rejects(() => store.importFile(filePath, {
    identityGate(identity) {
      seen.push(identity);
      const error = Object.assign(new Error('held actual identity'), { code: 'RECOVERY_HOLD_ACTIVE' });
      throw error;
    },
    datasetSeed: { datasetId: 'held-dataset', producerTaskRunId: 'held-task' }
  }), { code: 'RECOVERY_HOLD_ACTIVE' });
  assert.deepEqual(seen.map(({ sourceType, sourceBatch }) => ({ sourceType, sourceBatch })), [{
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708_HELD'
  }]);
  assert.equal(store.listBatches().length, 0);
});

test('sealed parser outcome绑定固定identity并拒绝tamper与symlink，cleanup覆盖sidecar', async () => {
  const filePath = writeFile('621', [inboundRow({ reconId: 'OUTCOME' })]);
  const input = spoolInput(filePath, 'parser-outcome-parent');
  await writeMptFileSpool(input);
  writeParserOutcome(input, { kind: 'spool' });
  assert.deepEqual(readParserOutcome(input), { kind: 'spool' });
  const paths = mptSpoolPaths(input);
  const parsed = JSON.parse(fs.readFileSync(paths.parserOutcomeReady, 'utf8'));
  parsed.fileIndex = 1;
  fs.writeFileSync(paths.parserOutcomeReady, `${JSON.stringify(parsed)}\n`, 'utf8');
  assert.throws(() => readParserOutcome(input), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  fs.rmSync(paths.parserOutcomeReady);
  const external = path.join(tempRoot, 'external-outcome.json');
  fs.writeFileSync(external, '{}\n', 'utf8');
  fs.symlinkSync(external, paths.parserOutcomeReady);
  assert.throws(() => readParserOutcome(input), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  cleanupMptFileSpool(input);
  assert.equal(fs.existsSync(paths.fileDir), false);
  assert.equal(fs.existsSync(external), true);

  const unsafeInput = { ...input, jobId: 'parser-outcome-unsafe', fileIndex: 1 };
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'BAD', message: 'bad', detailLines: [],
      sourcePath: '/Users/private/input.txt'
    }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'BAD', message: 'bad',
      detailLines: ['source: /var/private/input.txt']
    }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'BAD',
      message: 'path /Users/private/input.txt', detailLines: []
    }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'BAD',
      message: 'source /tmp', detailLines: []
    }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'BAD',
      message: 'safe', detailLines: ['config: /etc']
    }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed', fileName: 'safe.txt', code: 'SAFE_URL',
      message: 'See https://example.com/a/b; compare input/output', detailLines: []
    }
  });
  assert.equal(readParserOutcome(unsafeInput).fileResult.code, 'SAFE_URL');
  for (const unsafeText of [
    "ENOENT: open '/private/tmp/customer.csv'",
    'ENOENT: open "/tmp"',
    "EACCES: open 'C:\\Users\\alice\\statement.txt'",
    'EACCES: open "\\\\server\\share\\statement.txt"'
  ]) {
    assert.equal(isSafeMptErrorText(unsafeText), false, unsafeText);
  }
  for (const safeText of [
    'See https://example.com/a/b',
    'compare input/output before retry',
    'use / as the separator'
  ]) {
    assert.equal(isSafeMptErrorText(safeText), true, safeText);
  }
  const unsafePaths = mptSpoolPaths(unsafeInput);
  const unsafeCode = JSON.parse(fs.readFileSync(unsafePaths.parserOutcomeReady, 'utf8'));
  unsafeCode.outcome.fileResult.code = '/private/tmp/secret-code';
  fs.writeFileSync(unsafePaths.parserOutcomeReady, `${JSON.stringify(unsafeCode)}\n`, 'utf8');
  assert.throws(() => readParserOutcome(unsafeInput), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
  cleanupMptFileSpool(unsafeInput);
  cleanupMptSpoolParents(unsafeInput);
  assert.doesNotThrow(() => {
    cleanupMptFileSpool(unsafeInput);
    cleanupMptSpoolParents(unsafeInput);
  });
});

test('sealed success sidecar后的Coordinator失败保留原cause且Main清理未交接spool', async () => {
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('submit失败不应进入critical'); },
      async observeReceipt() {}, async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const filePath = writeFile('631', [inboundRow({ reconId: 'SEALED-SUBMIT-FAIL' })]);
  const staging = path.join(tempRoot, 'sealed-submit-fail');
  try {
    await assert.rejects(() => executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [filePath], userDataDir, taskStagingDir: staging,
      batchContext: {
        batchId: 5, batchNumber: 'BATCH-SUBMIT', taskRunId: 'submit-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'submit-parent', operationKey: 'submit-operation'
      },
      coordinatorFactory() {
        return {
          waitForDispatchCapacity: async () => {},
          submitReady() {
            throw Object.assign(new Error('sealed submit failed'), { code: 'TEST_COORDINATOR_SUBMIT_FAILED' });
          },
          submitBusinessError() { throw new Error('不得改写sealed success为parser error'); },
          completion: async () => []
        };
      }
    }), { code: 'TEST_COORDINATOR_SUBMIT_FAILED' });
    assert.equal(fs.existsSync(staging), false);
  } finally {
    await runtime.shutdown();
  }
});

test('import/repair input与expectedContentHash按action精确fail closed', async () => {
  const shapePath = writeFile('641', [inboundRow({ reconId: 'SHAPE' })]);
  const base = {
    runtime: { start() { throw new Error('normalize必须先于runtime'); } },
    filePaths: [shapePath], userDataDir: '/tmp/user-data', taskStagingDir: '/tmp/staging',
    batchContext: { operationKey: 'shape-parent' }
  };
  await assert.rejects(() => executeManagedPreFundMptImport({
    ...base, actionKey: 'pre-fund:mpt-import', repairFailures: []
  }), TypeError);
  await assert.rejects(() => executeManagedPreFundMptImport({
    ...base, actionKey: 'pre-fund:mpt-import', expectedContentHash: 'a'.repeat(64)
  }), TypeError);
  await assert.rejects(() => executeManagedPreFundMptImport({
    ...base, actionKey: 'pre-fund:mpt-repair-import', repairFailures: []
  }), TypeError);
  await assert.rejects(() => executeManagedPreFundMptImport({
    ...base,
    actionKey: 'pre-fund:mpt-repair-import',
    repairFailures: [{
      failureId: '11111111-1111-4111-8111-111111111111',
      filePath: shapePath, sourceType: 'MPT_INBOUND_GATEWAY',
      sourceBatch: 'BATCH', contentHash: 'a'.repeat(64), rowErrorCount: 1
    }]
  }), /normalize必须先于runtime/);
  await assert.rejects(() => executeManagedPreFundMptImport({
    ...base,
    actionKey: 'pre-fund:mpt-repair-import',
    repairFailures: [{
      failureId: 'failure-1', filePath: shapePath, sourceType: 'MPT_INBOUND_GATEWAY',
      sourceBatch: 'BATCH', contentHash: 'bad', rowErrorCount: 1
    }]
  }), TypeError);
  const job = { fileCount: 1, parentOperationKey: 'shape-parent', producerTaskRunId: 'shape-task' };
  const spool = { source: { filePath: '/tmp/a.txt' } };
  assert.throws(() => normalizeUnitInput({
    kind: 'spool', fileIndex: 0, ...deriveFileIdentity('shape-parent', 0),
    spool, datasetId: 'dataset', expectedContentHash: 'a'.repeat(64)
  }, job, 'pre-fund:mpt-import', 0), { code: 'PREFUND_WRITER_UNIT_INPUT_INVALID' });
  assert.throws(() => normalizeUnitInput({
    kind: 'spool', fileIndex: 0, ...deriveFileIdentity('shape-parent', 0),
    spool, datasetId: 'dataset'
  }, job, 'pre-fund:mpt-repair-import', 0), { code: 'PREFUND_WRITER_UNIT_INPUT_INVALID' });
});

test('Single Writer只消费validated spool、fileIndex递增且ACK后protected不取消', async () => {
  const filePath = writeFile('701', [inboundRow({ reconId: 'WRITER' })]);
  const input = spoolInput(filePath, 'writer-parent');
  await writeMptFileSpool(input);
  const events = [];
  let criticalReady;
  const criticalReadyPromise = new Promise((resolve) => { criticalReady = resolve; });
  let finishMutation;
  const mutationGate = new Promise((resolve) => { finishMutation = resolve; });
  const session = createSingleWriterSession({
    actionKey: 'pre-fund:mpt-import',
    jobInput: { fileCount: 1, parentOperationKey: 'writer-parent', producerTaskRunId: 'writer-task' },
    store: {
      async importValidatedSpool() {
        await mutationGate;
        return {
          status: 'imported',
          batch: { sourceFileName: path.basename(filePath), sourceType: 'MPT_INBOUND_GATEWAY', rowCount: 1, excludedRowCount: 0 },
          receipt: {
            id: 1, actionKey: 'pre-fund:mpt-import', operationKey: 'writer-parent/file/000000',
            producerTaskRunId: 'writer-task', batchId: 1, outcomeKind: 'inserted'
          }
        };
      }
    },
    emit(operation, payload, unitId) {
      events.push({ operation, payload, unitId });
      if (operation === 'critical:ready') criticalReady();
    }
  });
  const unit = session.startUnit({
    kind: 'spool',
    fileIndex: 0,
    fileOperationKey: 'writer-parent/file/000000',
    unitId: 'file:000000',
    spool: input,
    datasetId: 'writer-dataset'
  }, 'file:000000');
  await criticalReadyPromise;
  assert.deepEqual(events.map((event) => event.operation), ['critical:ready']);
  assert.equal(session.cancel(), false, 'critical ready后不得按普通取消收口');
  await assert.rejects(() => session.startUnit({
    kind: 'parser-error', fileIndex: 0, fileOperationKey: 'writer-parent/file/000000',
    unitId: 'file:000000', fileResult: { status: 'failed', fileName: 'x', code: 'x', message: 'x', detailLines: [] }
  }, 'file:000000'), { code: 'PREFUND_WRITER_CONCURRENT_UNIT' });
  session.acknowledge('file:000000', {
    intentId: 'writer-intent', fileOperationKey: 'writer-parent/file/000000'
  });
  assert.equal(session.cancel(), false, 'ACK后SQL/COMMIT期间保持protected');
  finishMutation();
  await unit;
  assert.deepEqual(events.map((event) => event.operation), [
    'critical:ready', 'commit:receipt', 'unit:done', 'job:done'
  ]);
  assert.equal(fs.existsSync(mptSpoolPaths(input).manifestReady), false);
});

test('Single Writer active pre-critical安全点接受shutdown cancel并清理，未进入store', async () => {
  const filePath = writeFile('711', [inboundRow({ reconId: 'WRITER-CANCEL' })]);
  const input = spoolInput(filePath, 'writer-cancel-parent');
  await writeMptFileSpool(input);
  const events = [];
  let storeCalls = 0;
  const session = createSingleWriterSession({
    actionKey: 'pre-fund:mpt-import',
    jobInput: {
      fileCount: 1,
      parentOperationKey: 'writer-cancel-parent',
      producerTaskRunId: 'writer-cancel-task'
    },
    store: { async importValidatedSpool() { storeCalls += 1; } },
    emit(operation, payload, unitId) { events.push({ operation, payload, unitId }); }
  });
  const activeUnit = session.startUnit({
    kind: 'spool', fileIndex: 0,
    ...deriveFileIdentity('writer-cancel-parent', 0),
    spool: input, datasetId: 'writer-cancel-dataset'
  }, 'file:000000');
  assert.equal(session.cancel(), true);
  await activeUnit;
  assert.equal(storeCalls, 0);
  assert.deepEqual(events.map((event) => event.operation), ['cancel:ack', 'job:error']);
  assert.equal(fs.existsSync(mptSpoolPaths(input).fileDir), false);
});

test('Writer技术错误与parent validator独立清除或拒绝绝对路径，后续file继续', async () => {
  const firstPath = writeFile('721', [inboundRow({ reconId: 'UNSAFE-WRITER-1' })]);
  const secondBatch = 'MPT_INBOUND_20260708_SAFE_WRITER_2';
  const secondPath = writeFile('722', [
    inboundRow({ batchNo: secondBatch, reconId: 'SAFE-WRITER-2' })
  ], secondBatch);
  const firstInput = spoolInput(firstPath, 'writer-safe-parent', 0);
  const secondInput = spoolInput(secondPath, 'writer-safe-parent', 1);
  await writeMptFileSpool(firstInput);
  await writeMptFileSpool(secondInput);
  const events = [];
  let storeCalls = 0;
  let session;
  session = createSingleWriterSession({
    actionKey: 'pre-fund:mpt-import',
    jobInput: {
      fileCount: 2,
      parentOperationKey: 'writer-safe-parent',
      producerTaskRunId: 'writer-safe-task'
    },
    store: {
      async importValidatedSpool(_spool, options) {
        storeCalls += 1;
        if (storeCalls === 1) {
          throw Object.assign(new Error("ENOENT: no such file, open '/private/tmp/input.txt'"), {
            code: '/private/tmp/private-code',
            detailLines: [
              'safe writer detail',
              'EACCES: open "C:\\Users\\secret\\input.txt"',
              "EIO: open '\\\\server\\share\\secret.txt'"
            ]
          });
        }
        return {
          status: 'imported',
          batch: {
            sourceFileName: path.basename(secondPath), sourceType: 'MPT_INBOUND_GATEWAY',
            rowCount: 1, excludedRowCount: 0
          },
          receipt: {
            id: 2, actionKey: 'pre-fund:mpt-import', operationKey: options.operationKey,
            producerTaskRunId: 'writer-safe-task', batchId: 2, outcomeKind: 'inserted'
          }
        };
      }
    },
    emit(operation, payload, unitId) {
      events.push({ operation, payload, unitId });
      if (operation === 'critical:ready') {
        queueMicrotask(() => session.acknowledge(unitId, {
          intentId: `intent-${unitId}`,
          fileOperationKey: payload.critical.fileOperationKey
        }));
      }
    }
  });
  await session.startUnit({
    kind: 'spool', fileIndex: 0, ...deriveFileIdentity('writer-safe-parent', 0),
    spool: firstInput, datasetId: 'writer-safe-dataset-1'
  }, 'file:000000');
  await session.startUnit({
    kind: 'spool', fileIndex: 1, ...deriveFileIdentity('writer-safe-parent', 1),
    spool: secondInput, datasetId: 'writer-safe-dataset-2'
  }, 'file:000001');

  const unitError = events.find((event) => event.operation === 'unit:error').payload.error;
  const parentResult = events.find((event) => event.operation === 'job:done').payload.result;
  assert.deepEqual(unitError, {
    code: 'PREFUND_WRITER_FILE_FAILED',
    message: 'PreFund Writer处理当前文件失败',
    stage: 'execute',
    detailLines: ['safe writer detail', '当前文件技术错误详情已隐藏']
  });
  assert.deepEqual(parentResult.results.map((item) => item.status), ['failed', 'ok']);
  assert.equal(validatePreFundMptImportResult(parentResult), true);
  assert.doesNotMatch(JSON.stringify({ unitError, parentResult }),
    /\/private\/tmp|\/tmp|C:\\Users|server\\share/);

  for (const mutate of [
    (item) => { item.code = '/private/tmp/code'; },
    (item) => { item.message = "ENOENT: open '/tmp'"; },
    (item) => { item.detailLines = ['EACCES: open "C:\\Users\\secret\\input.txt"']; },
    (item) => { item.detailLines = ["EIO: open '\\\\server\\share\\secret.txt'"]; },
    (item) => { item.extra = 'unsafe-extra'; }
  ]) {
    const tampered = structuredClone(parentResult);
    mutate(tampered.results[0]);
    assert.equal(validatePreFundMptImportResult(tampered), false);
  }
});

test('Parser cleanup元数据在Writer完成cleanup后不进入公开file result', async () => {
  const filePath = writeFile('723', [inboundRow({ reconId: 'PARSER-CLEANUP-SHAPE' })]);
  const input = spoolInput(filePath, 'parser-cleanup-shape-parent', 0);
  writeParserOutcome(input, {
    kind: 'parser-error',
    fileResult: {
      status: 'failed',
      fileName: path.basename(filePath),
      code: 'PREFUND_PARSER_WORKER_FAILED',
      message: 'MPT parser worker处理当前文件失败',
      detailLines: ['safe parser detail'],
      cleanupRequired: true,
      cleanupScope: 'current-file-spool',
      causeCode: 'EIO'
    }
  });
  const events = [];
  const session = createSingleWriterSession({
    actionKey: 'pre-fund:mpt-import',
    jobInput: {
      fileCount: 1,
      parentOperationKey: 'parser-cleanup-shape-parent',
      producerTaskRunId: 'parser-cleanup-shape-task'
    },
    store: {
      async importValidatedSpool() {
        assert.fail('parser-error unit不得进入store');
      }
    },
    emit(operation, payload, unitId) { events.push({ operation, payload, unitId }); }
  });
  await session.startUnit({
    kind: 'parser-outcome', fileIndex: 0,
    ...deriveFileIdentity('parser-cleanup-shape-parent', 0),
    spool: input, datasetId: 'parser-cleanup-shape-dataset'
  }, 'file:000000');

  const result = events.find((event) => event.operation === 'job:done').payload.result;
  assert.deepEqual(result.results[0], {
    status: 'failed',
    fileName: path.basename(filePath),
    code: 'PREFUND_PARSER_WORKER_FAILED',
    message: 'MPT parser worker处理当前文件失败',
    detailLines: ['safe parser detail']
  });
  assert.equal(validatePreFundMptImportResult(result), true);
  assert.equal(fs.existsSync(mptSpoolPaths(input).fileDir), false);
});

test('import与repair parent result validator保持action-specific exact public shape', () => {
  const failed = {
    status: 'failed',
    fileName: 'safe.txt',
    code: 'MPT_ROW_ERRORS',
    message: '文件包含 1 行格式错误',
    detailLines: ['第2行：字段数量不匹配']
  };
  const imported = {
    status: 'ok',
    results: [failed],
    successCount: 0,
    failedCount: 1
  };
  const repaired = {
    ...imported,
    importedRowCount: 0,
    excludedRowCount: 0
  };
  assert.equal(validatePreFundMptImportResult(imported), true);
  assert.equal(validatePreFundMptRepairResult(repaired), true);
  assert.equal(validatePreFundMptImportResult(repaired), false);
  assert.equal(validatePreFundMptRepairResult(imported), false);
  assert.equal(validatePreFundMptImportResult({ ...imported, extra: true }), false);
  assert.equal(validatePreFundMptRepairResult({ ...repaired, excludedRowCount: -1 }), false);
  assert.equal(validatePreFundMptImportResult({
    ...imported,
    results: [{
      ...failed,
      cleanupRequired: true,
      cleanupScope: 'current-file-spool',
      causeCode: 'EIO'
    }]
  }), false);
  const importWithRepairEvidence = {
    ...failed,
    managedRepairEvidence: {
      sourceType: 'MPT_INBOUND_GATEWAY',
      sourceBatch: 'MPT_INBOUND_20260708_SAFE',
      contentHash: 'a'.repeat(64),
      rowErrorCount: 1
    }
  };
  assert.equal(validatePreFundMptImportResult(importWithRepairEvidence), true);
  assert.equal(validatePreFundMptRepairResult(importWithRepairEvidence), false);
});

test('canonical MPT超长sequence fileName保持公开parity，任意账号样式文件名仍fail closed', () => {
  const longFileName = 'MPT_INBOUND_GATEWAY_20260708_12345678901234567890.txt';
  const arbitraryAccountFileName = '12345678901234567890.txt';
  const success = {
    status: 'ok',
    importStatus: 'imported',
    fileName: longFileName,
    sourceType: 'MPT_INBOUND_GATEWAY',
    rowCount: 1,
    excludedRowCount: 0
  };
  assert.equal(safeMptFileName(path.join('/private/tmp', longFileName)), longFileName);
  assert.equal(safeMptFileName(arbitraryAccountFileName), 'unknown-file');
  assert.throws(() => assertFinanceSafeValue({ fileName: longFileName }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  }, '通用finance-safe不得全局放行MPT业务文件名');
  assert.doesNotThrow(() => assertFinanceSafeValue({
    sourceFileName: longFileName,
    sourceFileSequence: '12345678901234567890',
    sourceType: 'MPT_INBOUND_GATEWAY',
    sourceDate: '2026-07-08',
    sourceBatch: 'MPT_INBOUND_20260708_12345678901234567890'
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }));
  assert.throws(() => assertFinanceSafeValue({
    message: longFileName
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  }, '同一长数字只允许在exact domain filename/source identity key中出现');
  assert.throws(() => assertFinanceSafeValue({
    fileName: 'report_12345678901234567890.txt'
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  });
  const opaqueIntentId =
    'prefund-intent-cf114ee865cd8ef8b5b4e36eb724822113685f6984de474104e52c9166abbb6e';
  const fileOperationKey =
    'pre-fund-reconciliation:import-mpt:4bcc9162-9748-4470-b9d0-91a4233a8fb7/file/000000';
  const repairFileOperationKey =
    'pre-fund-reconciliation:mpt-errors:repair:4bcc9162-9748-4470-b9d0-91a4233a8fb7/file/000000';
  const producerTaskRunId = 'f1234567-1234-4123-8123-123456789012';
  assert.doesNotThrow(() => assertFinanceSafeValue({
    intentId: opaqueIntentId,
    fileOperationKey,
    operationKey: fileOperationKey,
    datasetId: 'a1234567-1234-4123-8123-123456789012',
    producerTaskRunId,
    fileIndex: 0
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }));
  assert.doesNotThrow(() => assertFinanceSafeValue({
    fileOperationKey: repairFileOperationKey,
    operationKey: repairFileOperationKey,
    fileIndex: 0
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }));
  assert.throws(() => assertFinanceSafeValue({
    message: opaqueIntentId
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  });
  assert.throws(() => assertFinanceSafeValue({
    fileOperationKey,
    fileIndex: 1
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  }, 'fileOperationKey suffix必须与同payload fileIndex一致');
  for (const rejectedOperationKey of [
    '4bcc9162-9748-4470-b9d0-91a4233a8fb7/file/000000',
    'other-task:4bcc9162-9748-4470-b9d0-91a4233a8fb7/file/000000',
    'pre-fund-reconciliation:run:4bcc9162-9748-4470-b9d0-91a4233a8fb7/file/000000'
  ]) {
    assert.throws(() => assertFinanceSafeValue({
      fileOperationKey: rejectedOperationKey,
      fileIndex: 0
    }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
      code: 'PRIVACY_VALUE_FORBIDDEN'
    });
  }
  assert.throws(() => assertFinanceSafeValue({
    sourceFileName: longFileName,
    sourceFileSequence: '99999999999999999999',
    sourceType: 'MPT_INBOUND_GATEWAY',
    sourceDate: '2026-07-08'
  }, 'finance-safe-v1', '/', { allowValue: allowMptFinanceSafeValue }), {
    code: 'PRIVACY_VALUE_FORBIDDEN'
  });
  assert.equal(validatePreFundMptImportResult(success), true);
  assert.equal(validatePreFundMptRepairResult(success), true);
  assert.equal(validatePreFundMptImportResult({
    status: 'ok', results: [success], successCount: 1, failedCount: 0
  }), true);
  assert.equal(validatePreFundMptRepairResult({
    status: 'ok', results: [success], successCount: 1, failedCount: 0,
    importedRowCount: 1, excludedRowCount: 0
  }), true);
  assert.equal(validatePreFundMptImportResult({
    ...success, fileName: arbitraryAccountFileName
  }), false);
});

test('sealed Parser error保留canonical超长sequence basename并拒绝任意账号样式fileName', () => {
  const sequence = '12345678901234567890';
  const filePath = writeFile(sequence, [inboundRow({ reconId: 'LONG-PARSER-SEQUENCE' })]);
  const input = spoolInput(filePath, 'long-parser-sequence-parent');
  const fileResult = {
    status: 'failed',
    fileName: path.basename(filePath),
    code: 'MPT_ROW_ERRORS',
    message: '文件包含格式错误',
    detailLines: ['第2行：字段数量不匹配']
  };
  writeParserOutcome(input, { kind: 'parser-error', fileResult });
  assert.deepEqual(readParserOutcome(input), {
    kind: 'parser-error',
    fileResult
  });

  const unsafeInput = {
    ...input,
    fileIndex: 1,
    source: {
      filePath: path.join(tempRoot, '12345678901234567890.txt'),
      sourceSnapshot: input.source.sourceSnapshot
    }
  };
  assert.throws(() => writeParserOutcome(unsafeInput, {
    kind: 'parser-error',
    fileResult: { ...fileResult, fileName: '12345678901234567890.txt' }
  }), { code: 'PREFUND_PARSER_OUTCOME_INVALID' });
});

test('PreFund policy保持冻结action-specific static keys、资源和production gate', () => {
  const [importPolicy, repairPolicy] = PRE_FUND_MPT_POLICIES;
  assert.deepEqual({
    moduleId: importPolicy.moduleId,
    entry: importPolicy.entryKey,
    inspector: importPolicy.commit.inspectorKey,
    scope: importPolicy.commit.conflictScopeResolverKey,
    validator: importPolicy.result.validatorKey,
    mode: importPolicy.mode,
    base: importPolicy.resources.base,
    phase: importPolicy.resources.phase,
    compound: importPolicy.resources.compound,
    workUnits: importPolicy.workUnits,
    transportCrash: importPolicy.failure.unitTransportCrash,
    production: importPolicy.production
  }, {
    moduleId: 'pre-fund',
    entry: 'executor.pre-fund:mpt-import',
    inspector: 'inspector.pre-fund:mpt-import',
    scope: 'scope.pre-fund:mpt-import',
    validator: 'result-validator.pre-fund:mpt-import',
    mode: 'thread-pool',
    base: { cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 33554432 },
    phase: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 268435456 },
    compound: {
      topologyKey: 'topology.pre-fund:mpt-import', childrenMax: 4,
      childResource: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 268435456 }
    },
    workUnits: {
      kind: 'file', ordering: 'input-index-reducer', requestedMaxWorkers: 4, minUnitsPerWorker: 2,
      plannerKey: 'planner.pre-fund:mpt-import', reducerKey: 'reducer.pre-fund:mpt-import'
    },
    transportCrash: 'fail-unit-and-continue',
    production: {
      enabled: false, effectiveMode: 'legacy', effectiveWorkerCount: 0, recoveryStatus: 'probe',
      evidenceStatus: 'baseline', downgradeReason: 'production gate not yet passed', benchmarkEvidenceId: null
    }
  });
  assert.equal(repairPolicy.entryKey, 'executor.pre-fund:mpt-repair-import');
  assert.equal(repairPolicy.commit.inspectorKey, 'inspector.pre-fund:mpt-repair-import');
  assert.equal(repairPolicy.commit.conflictScopeResolverKey, 'scope.pre-fund:mpt-repair-import');
  assert.equal(repairPolicy.result.validatorKey, 'result-validator.pre-fund:mpt-repair-import');
  assert.equal(repairPolicy.resources.phase.memoryBytes, 201326592);
  assert.deepEqual(repairPolicy.resources.compound, {
    topologyKey: 'topology.pre-fund:mpt-repair-import',
    childrenMax: 1,
    childResource: {
      cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
      ioHeavySlots: 1, memoryBytes: 268435456
    }
  });
  assert.equal(repairPolicy.production.enabled, false);
  assert.equal(repairPolicy.production.effectiveWorkerCount, 0);
});

test('managed Writer以canonical超长sequence形成receipt后unit与parent validator仍接受', async () => {
  const calls = [];
  const opaqueIntentId =
    'prefund-intent-cf114ee865cd8ef8b5b4e36eb724822113685f6984de474104e52c9166abbb6e';
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        calls.push(`prepare:${input.unitId}`);
        return { intentId: opaqueIntentId, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        calls.push(`receipt:${input.unitId}`);
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted(input) { calls.push(`closed:${input.unitId}`); },
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const sequence = '12345678901234567890';
  const sourceBatch = `MPT_INBOUND_20260708_${sequence}`;
  const filePath = writeFile(sequence, [inboundRow({
    batchNo: sourceBatch,
    reconId: 'LONG-MANAGED-SEQUENCE'
  })], sourceBatch);
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: { adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [filePath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'managed-long-sequence-staging'),
      batchContext: {
        batchId: 1,
        batchNumber: 'BATCH-LONG-SEQUENCE',
        taskRunId: 'f1234567-1234-4123-8123-123456789012',
        taskKey: 'pre-fund-reconciliation:import-mpt',
        moduleId: 'pre-fund',
        parentRunId: 'managed-long-sequence-parent',
        operationKey:
          'pre-fund-reconciliation:import-mpt:4bcc9162-9748-4470-b9d0-91a4233a8fb7'
      },
      production: false
    });
    assert.equal(result.results[0].status, 'ok');
    assert.equal(result.results[0].fileName, path.basename(filePath));
    assert.equal(validatePreFundMptImportResult(result), true);
    assert.deepEqual(calls, [
      'prepare:file:000000', 'receipt:file:000000', 'closed:file:000000'
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('一个parent job复用单一Writer transport，Parser effective=1按unit receipt后递增提交', async () => {
  const calls = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    memoryHardCeilingBytes: 4 * 1024 ** 3,
    systemReserveBytes: 1024 ** 3,
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        calls.push(`prepare:${input.unitId}`);
        return { intentId: `intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        calls.push(`receipt:${input.unitId}`);
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted(input) { calls.push(`closed:${input.unitId}`); },
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  assert.deepEqual(runtime.resourceGovernor.snapshot().budgets, {
    cpuSlots: 4,
    workerThreadSlots: 5,
    utilityProcessSlots: 1,
    ioHeavySlots: 2,
    memoryBytes: 4 * 1024 ** 3
  });
  const firstPath = writeFile('801', [inboundRow({ reconId: 'MANAGED-1' })]);
  const otherBatch = 'MPT_INBOUND_20260708_MANAGED2';
  const secondPath = writeFile('802', [
    inboundRow({ batchNo: otherBatch, reconId: 'MANAGED-2' })
  ], otherBatch);
  const progress = [];
  try {
    let result;
    try {
      result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: { adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [firstPath, secondPath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'managed-staging'),
      batchContext: {
        batchId: 1,
        batchNumber: 'BATCH-1',
        taskRunId: 'managed-task-run',
        taskKey: 'pre-fund-reconciliation:import-mpt',
        moduleId: 'pre-fund',
        parentRunId: 'managed-parent-run',
        operationKey: 'managed-parent-operation'
      },
      production: false,
      onProgress(value) { progress.push(value); }
      });
    } catch (error) {
      error.message += ` calls=${JSON.stringify(calls)}`;
      throw error;
    }
    assert.deepEqual(result.results.map((item) => item.fileName), [
      path.basename(firstPath), path.basename(secondPath)
    ]);
    assert.deepEqual(result.results.map((item) => item.status), ['ok', 'ok']);
    assert.deepEqual(calls, [
      'prepare:file:000000', 'receipt:file:000000', 'closed:file:000000',
      'prepare:file:000001', 'receipt:file:000001', 'closed:file:000001'
    ]);
    assert.deepEqual(progress, [
      { stage: 'mpt-import', current: 1, total: 2, fileName: path.basename(firstPath) },
      { stage: 'mpt-import', current: 2, total: 2, fileName: path.basename(secondPath) }
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('E05-C真实8文件Parser Pool + Single Writer形成逐file唯一receipt并与legacy业务行parity', async () => {
  const criticalOrder = [];
  const receiptOrder = [];
  const runtime = createNonProductionBackgroundExecutionRuntime({
    availableParallelism: 8,
    resourceGovernor: createIsolatedPoolGovernor(),
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        criticalOrder.push(input.unitId);
        return { intentId: `pool-intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        receiptOrder.push(input.unitId);
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const filePaths = Array.from({ length: 8 }, (_, index) => {
    const sourceBatch = `MPT_INBOUND_20260708_POOL_${index}`;
    return writeFile(String(830 + index), [inboundRow({
      batchNo: sourceBatch,
      reconId: `REAL-POOL-${index}`,
      currency: index % 2 ? 'EUR' : 'USD',
      amount: `${index + 1}.25`
    })], sourceBatch);
  });
  let parserActive = 0;
  let parserMaxActive = 0;
  const parserExited = new Set();
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: {
        beginManagedMptImport() {},
        adoptManagedMptImportResults: (_paths, items) => items
      },
      filePaths,
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'real-pool-staging'),
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      onParserWorkerState(event) {
        if (event.state === 'started') {
          parserActive += 1;
          parserMaxActive = Math.max(parserMaxActive, parserActive);
        } else {
          parserActive -= 1;
          parserExited.add(event.fileIndex);
        }
      },
      batchContext: {
        batchId: 11, batchNumber: 'BATCH-REAL-POOL', taskRunId: 'real-pool-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'real-pool-parent', operationKey: 'real-pool-operation'
      }
    });
    assert.equal(parserMaxActive > 1, true);
    assert.equal(parserActive, 0);
    assert.equal(parserExited.size, 8);
    assert.deepEqual(criticalOrder, Array.from({ length: 8 }, (_, index) =>
      `file:${String(index).padStart(6, '0')}`));
    assert.deepEqual(receiptOrder, criticalOrder);
    assert.deepEqual(result.results.map((item) => item.fileName), filePaths.map((item) => path.basename(item)));
    assert.deepEqual(result.results.map((item) => item.status), Array(8).fill('ok'));

    const managedDbPath = runDataStore.sideDbPath(
      userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'
    );
    const managedDb = runDataStore.openExistingSideDb(managedDbPath);
    let managedRows;
    try {
      const receipts = managedDb.prepare(`
        SELECT file_index, operation_key, outcome_kind
        FROM pre_fund_operation_receipts ORDER BY file_index
      `).all();
      assert.deepEqual(receipts.map((item) => Number(item.file_index)), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(receipts.map((item) => item.operation_key), Array.from(
        { length: 8 },
        (_, index) => `real-pool-operation/file/${String(index).padStart(6, '0')}`
      ));
      assert.deepEqual(receipts.map((item) => item.outcome_kind), Array(8).fill('inserted'));
      managedRows = managedDb.prepare(`
        SELECT source_batch, source_file_name, source_file_sequence, source_row_number,
          reconciliation_id, gateway_date, currency, amount, fingerprint
        FROM pre_fund_reconciliation_gateway_rows
        ORDER BY source_file_sequence, source_row_number
      `).all();
    } finally {
      managedDb.close();
    }

    const legacyDir = path.join(tempRoot, 'legacy-parity-user-data');
    fs.mkdirSync(legacyDir);
    const legacyStore = new PreFundReconciliationStore(legacyDir);
    for (const filePath of filePaths) await legacyStore.importLegacyFile(filePath);
    const legacyDb = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
      legacyDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'
    ));
    try {
      const legacyRows = legacyDb.prepare(`
        SELECT source_batch, source_file_name, source_file_sequence, source_row_number,
          reconciliation_id, gateway_date, currency, amount, fingerprint
        FROM pre_fund_reconciliation_gateway_rows
        ORDER BY source_file_sequence, source_row_number
      `).all();
      assert.deepEqual(managedRows, legacyRows);
    } finally {
      legacyDb.close();
    }
  } finally {
    await runtime.shutdown();
  }
});

test('E05-C Pool中一个真实transport crash只失败当前file，后续真实Writer/receipt继续', async () => {
  const criticalOrder = [];
  const runtime = createNonProductionBackgroundExecutionRuntime({
    availableParallelism: 8,
    resourceGovernor: createIsolatedPoolGovernor(),
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        criticalOrder.push(input.unitId);
        return { intentId: `crash-intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const filePaths = Array.from({ length: 8 }, (_, index) => {
    const sourceBatch = `MPT_INBOUND_20260708_POOL_CRASH_${index}`;
    return writeFile(String(850 + index), [inboundRow({
      batchNo: sourceBatch,
      reconId: `POOL-CRASH-${index}`
    })], sourceBatch);
  });
  function SelectiveCrashWorker(entry, workerOptions) {
    if (workerOptions.workerData.input.fileIndex !== 1) {
      return new Worker(entry, workerOptions);
    }
    const fake = new EventEmitter();
    fake.postMessage = () => {};
    fake.terminate = () => Promise.resolve(9);
    setImmediate(() => fake.emit('exit', 9));
    return fake;
  }
  let parserActive = 0;
  let parserMaxActive = 0;
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      ParserWorkerClass: SelectiveCrashWorker,
      service: {
        beginManagedMptImport() {},
        adoptManagedMptImportResults: (_paths, items) => items
      },
      filePaths,
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'pool-crash-staging'),
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      onParserWorkerState(event) {
        if (event.state === 'started') {
          parserActive += 1;
          parserMaxActive = Math.max(parserMaxActive, parserActive);
        } else {
          parserActive -= 1;
        }
      },
      batchContext: {
        batchId: 12, batchNumber: 'BATCH-POOL-CRASH', taskRunId: 'pool-crash-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'pool-crash-parent', operationKey: 'pool-crash-operation'
      }
    });
    assert.equal(parserMaxActive > 1, true);
    assert.equal(parserActive, 0);
    assert.deepEqual(result.results.map((item) => item.status), [
      'ok', 'failed', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'
    ]);
    assert.equal(result.results[1].code, 'PREFUND_PARSER_TRANSPORT_CRASH');
    assert.deepEqual(criticalOrder, [0, 2, 3, 4, 5, 6, 7].map((index) =>
      `file:${String(index).padStart(6, '0')}`));
    const db = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
      userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'
    ));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_operation_receipts').get().n, 7);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pre_fund_reconciliation_gateway_rows').get().n, 7);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS n FROM pre_fund_operation_receipts WHERE file_index = 1
      `).get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    await runtime.shutdown();
  }
});

test('parser-error作为显式预注册unit保留原错误并继续后续file', async () => {
  const calls = [];
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        calls.push(input.unitId);
        return { intentId: `intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt() { return {}; },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const invalidPath = writeFile('811', [inboundRow()]);
  fs.writeFileSync(invalidPath, 'invalid-header\n', 'utf8');
  const validBatch = 'MPT_INBOUND_20260708_AFTER_ERROR';
  const validPath = writeFile('812', [
    inboundRow({ batchNo: validBatch, reconId: 'AFTER-PARSER-ERROR' })
  ], validBatch);
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: {
        beginManagedMptImport() {},
        adoptManagedMptImportResults: (_paths, items) => items
      },
      filePaths: [invalidPath, validPath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'parser-error-staging'),
      batchContext: {
        batchId: 2,
        batchNumber: 'BATCH-2',
        taskRunId: 'parser-error-task',
        taskKey: 'pre-fund-reconciliation:import-mpt',
        moduleId: 'pre-fund',
        parentRunId: 'parser-error-parent',
        operationKey: 'parser-error-operation'
      }
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].fileName, path.basename(invalidPath));
    assert.equal(result.results[0].code, 'MPT_HEADER_FIELD_COUNT');
    assert.deepEqual(result.results[0].detailLines, [
      `文件：${path.basename(invalidPath)}`,
      '行号：1'
    ]);
    assert.equal(result.results[1].status, 'ok');
    assert.deepEqual(calls, ['file:000001'], 'parser-error unit不应进入critical，后续unit继续');
  } finally {
    await runtime.shutdown();
  }
});

test('managed strict MPT_ROW_ERRORS与legacy保持可定位detail及顶层repair shape', async () => {
  const sourceBatch = 'MPT_INBOUND_20260708_12345678901234567890';
  const filePath = writeFile('8121', [
    inboundRow({ batchNo: sourceBatch, reconId: 'BAD-AMOUNT', amount: 'not-decimal' }),
    inboundRow({ batchNo: sourceBatch, reconId: 'BAD-DATE', billDate: '2026-02-30' })
  ], sourceBatch);
  const service = createPreFundReconciliationService({
    userDataDir,
    database: mirrorDatabase(),
    templatePath: 'unused.xlsx'
  });
  const legacy = await service.importMptFiles([filePath], {
    producerTaskRunId: 'legacy-strict-parity-task'
  });
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('strict row error不应进入critical'); },
      async observeReceipt() {},
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  try {
    const managed = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service,
      filePaths: [filePath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'strict-detail-parity-staging'),
      batchContext: {
        batchId: 8, batchNumber: 'BATCH-STRICT-PARITY', taskRunId: 'managed-strict-parity-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'strict-parity-parent', operationKey: 'strict-parity-operation'
      }
    });
    const project = (item) => ({
      code: item.code,
      message: item.message,
      detailLines: item.detailLines,
      rowErrorCount: item.rowErrorCount,
      canRepair: item.canRepair,
      sourceType: item.sourceType
    });
    assert.deepEqual(project(managed.results[0]), project(legacy.results[0]));
    assert.deepEqual(managed.results[0].detailLines, [
      '第2行：MPT 金额字段不是合法十进制字符串',
      '第3行：MPT 明细行账单日期与文件名/首行不一致'
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('Parser OS error在sidecar边界清除绝对路径，当前file失败且后续file继续', async () => {
  class PrivatePathErrorWorker extends EventEmitter {
    constructor(_entry, workerOptions) {
      super();
      const input = workerOptions.workerData.input;
      setImmediate(async () => {
        if (input.fileIndex === 0) {
          this.emit('message', {
            ok: false,
            error: {
              code: 'ENOENT',
              message: 'ENOENT: no such file, open /private/tmp/customer-secret/input.txt',
              detailLines: [
                'safe parser detail',
                'source: /private/tmp/customer-secret/input.txt'
              ]
            }
          });
          this.emit('exit', 0);
          return;
        }
        const result = await writeMptFileSpool(input);
        this.emit('message', {
          ok: true,
          result: {
            schemaVersion: result.schemaVersion,
            jobId: result.jobId,
            fileIndex: result.fileIndex,
            fileOperationKey: result.fileOperationKey,
            unitId: result.unitId
          }
        });
        this.emit('exit', 0);
      });
    }
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }
  const criticalUnits = [];
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        criticalUnits.push(input.unitId);
        return { intentId: `intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt() { return {}; },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const firstPath = writeFile('8131', [inboundRow({ reconId: 'PRIVATE-PATH-ERROR' })]);
  const secondBatch = 'MPT_INBOUND_20260708_AFTER_PRIVATE_ERROR';
  const secondPath = writeFile('8132', [
    inboundRow({ batchNo: secondBatch, reconId: 'AFTER-PRIVATE-PATH-ERROR' })
  ], secondBatch);
  const progress = [];
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      ParserWorkerClass: PrivatePathErrorWorker,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [firstPath, secondPath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'private-path-error-staging'),
      onProgress(value) { progress.push(value); },
      batchContext: {
        batchId: 7, batchNumber: 'BATCH-PRIVATE-PATH', taskRunId: 'private-path-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'private-path-parent', operationKey: 'private-path-operation'
      }
    });
    assert.equal(result.results[0].status, 'failed');
    assert.equal(result.results[0].code, 'ENOENT');
    assert.equal(result.results[0].message, 'MPT parser worker处理当前文件失败');
    assert.deepEqual(result.results[0].detailLines, [
      'safe parser detail',
      '当前文件技术错误详情已隐藏'
    ]);
    assert.equal(result.results[1].status, 'ok');
    assert.deepEqual(criticalUnits, ['file:000001']);
    assert.doesNotMatch(JSON.stringify({ result, progress }), /\/private\/tmp|customer-secret/);
  } finally {
    await runtime.shutdown();
  }
});

test('Writer cleanup failure是authoritative file结果，不被Main parser error覆盖', async () => {
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('parser error不应进入critical'); },
      async observeReceipt() {}, async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const invalidPath = writeFile('813', [inboundRow()]);
  fs.writeFileSync(invalidPath, 'invalid-header\n', 'utf8');
  const staging = path.join(tempRoot, 'cleanup-authority-staging');
  let foreignPath = null;
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import', runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [invalidPath], userDataDir, taskStagingDir: staging,
      batchContext: {
        batchId: 6, batchNumber: 'BATCH-CLEANUP', taskRunId: 'cleanup-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'cleanup-parent', operationKey: 'cleanup-operation'
      },
      coordinatorFactory(coordinatorOptions) {
        const coordinator = createOrderedMptCoordinator(coordinatorOptions);
        return {
          waitForDispatchCapacity: () => coordinator.waitForDispatchCapacity(),
          submitReady: (index, spool) => coordinator.submitReady(index, spool),
          submitBusinessError(index, fileResult) {
            const jobDir = path.join(staging, 'mpt', fs.readdirSync(path.join(staging, 'mpt'))[0]);
            const fileDir = path.join(jobDir, fs.readdirSync(jobDir)[0]);
            foreignPath = path.join(fileDir, 'foreign.keep');
            fs.writeFileSync(foreignPath, 'foreign', 'utf8');
            coordinator.submitBusinessError(index, fileResult);
          },
          completion: () => coordinator.completion()
        };
      }
    });
    assert.equal(result.results[0].code, 'PREFUND_SPOOL_CLEANUP_INCOMPLETE');
    assert.notEqual(result.results[0].code, 'MPT_HEADER_FIELD_COUNT');
    assert.equal(fs.existsSync(foreignPath), true);
  } finally {
    await runtime.shutdown();
  }
});

test('Parser result必须等待clean exit，result后nonzero按当前file crash且Parser绝不重叠', async () => {
  let active = 0;
  let maxActive = 0;
  class ResultThenCrashWorker extends EventEmitter {
    constructor(_entry, workerOptions) {
      super();
      active += 1;
      maxActive = Math.max(maxActive, active);
      const input = workerOptions.workerData.input;
      const identity = deriveFileIdentity(input.parentOperationKey, input.fileIndex);
      setImmediate(() => {
        this.emit('message', {
          ok: true,
          result: {
            schemaVersion: 1,
            jobId: input.jobId,
            fileIndex: input.fileIndex,
            ...identity
          }
        });
        setImmediate(() => {
          active -= 1;
          this.emit('exit', 9);
        });
      });
    }
    postMessage() {}
    terminate() { return Promise.resolve(9); }
  }
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('transport crash不应进入critical'); },
      async observeReceipt() {},
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const firstPath = writeFile('815', [inboundRow({ reconId: 'CRASH-1' })]);
  const secondBatch = 'MPT_INBOUND_20260708_CRASH2';
  const secondPath = writeFile('816', [inboundRow({ batchNo: secondBatch, reconId: 'CRASH-2' })], secondBatch);
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      ParserWorkerClass: ResultThenCrashWorker,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [firstPath, secondPath],
      userDataDir,
      taskStagingDir: path.join(tempRoot, 'parser-crash-staging'),
      batchContext: {
        batchId: 4, batchNumber: 'BATCH-CRASH', taskRunId: 'crash-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'crash-parent', operationKey: 'crash-operation'
      }
    });
    assert.equal(maxActive, 1);
    assert.deepEqual(result.results.map((item) => item.code), [
      'PREFUND_PARSER_TRANSPORT_CRASH', 'PREFUND_PARSER_TRANSPORT_CRASH'
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test('Writer dispatch后critical前transport exit交还Main cleanup且不升级资金不确定', async () => {
  let inspectCount = 0;
  let exitCount = 0;
  const workerThreadAdapter = {
    start(callbacks) {
      return {
        ready: Promise.resolve(),
        send(message) {
          if (message.operation === 'unit:start') {
            queueMicrotask(() => {
              exitCount += 1;
              callbacks.onExit(17, null);
            });
          }
        },
        close() {},
        terminate() { return Promise.resolve(0); }
      };
    }
  };
  const runtime = createBackgroundExecutionRuntime({
    workerThreadAdapter,
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('pre-critical exit不应创建Intent'); },
      async observeReceipt() {},
      async settleCommitted() {},
      async resolveUncertain() {
        inspectCount += 1;
        return { outcome: 'unknown' };
      }
    }
  });
  const filePath = writeFile('819', [inboundRow({ reconId: 'WRITER-PRECRITICAL-EXIT' })]);
  const staging = path.join(tempRoot, 'writer-precritical-exit-staging');
  const cleanupCounts = new Map();
  try {
    await assert.rejects(() => executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import', runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [filePath], userDataDir, taskStagingDir: staging,
      cleanupMainOwnedFile(spool) {
        cleanupCounts.set(spool.fileIndex, (cleanupCounts.get(spool.fileIndex) || 0) + 1);
        cleanupMptFileSpool(spool);
        cleanupMptSpoolParents(spool);
      },
      batchContext: {
        batchId: 9, batchNumber: 'BATCH-WRITER-EXIT', taskRunId: 'writer-exit-task',
        taskKey: 'pre-fund-reconciliation:import-mpt', moduleId: 'pre-fund',
        parentRunId: 'writer-exit-parent', operationKey: 'writer-exit-operation'
      }
    }), { code: 'PREFUND_WRITER_PARENT_INTERRUPTED' });
    assert.equal(exitCount, 1);
    assert.equal(inspectCount, 0, 'pre-critical transport exit不得进入Inspector/Hold路径');
    assert.deepEqual(Object.fromEntries(cleanupCounts), { 0: 1 });
    assert.equal(fs.existsSync(staging), false);
  } finally {
    await runtime.shutdown();
  }
});

test('ordinary shutdown cancel终止Parser并清理当前及未来未start unit的spool与空owner目录', async () => {
  const runtime = createBackgroundExecutionRuntime({
    workerDurableCoordinator: {
      async prepareAndAck() { throw new Error('取消路径不应进入critical'); },
      async observeReceipt() {},
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const firstPath = writeFile('821', Array.from(
    { length: 20_000 },
    (_, index) => inboundRow({ reconId: `CANCEL-${index}` })
  ));
  const secondBatch = 'MPT_INBOUND_20260708_CANCEL2';
  const secondPath = writeFile('822', [
    inboundRow({ batchNo: secondBatch, reconId: 'CANCEL-2' })
  ], secondBatch);
  const staging = path.join(tempRoot, 'cancel-staging');
  const mainCleanupCounts = new Map();
  let shutdownPromise = null;
  const execution = executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [firstPath, secondPath],
      userDataDir,
      taskStagingDir: staging,
      cleanupMainOwnedFile(spool) {
        mainCleanupCounts.set(spool.fileIndex, (mainCleanupCounts.get(spool.fileIndex) || 0) + 1);
        cleanupMptFileSpool(spool);
        cleanupMptSpoolParents(spool);
      },
      onProgress({ current }) {
        if (current === 1 && !shutdownPromise) {
          setTimeout(() => { shutdownPromise = runtime.shutdown(); }, 5);
        }
      },
      batchContext: {
        batchId: 3,
        batchNumber: 'BATCH-CANCEL',
        taskRunId: 'cancel-task',
        taskKey: 'pre-fund-reconciliation:import-mpt',
        moduleId: 'pre-fund',
        parentRunId: 'cancel-parent',
        operationKey: 'cancel-operation'
      }
    });
  await assert.rejects(() => execution,
    (error) => ['PREFUND_WRITER_PARENT_INTERRUPTED', 'PREFUND_PARSER_CANCELLED'].includes(error.code));
  while (!shutdownPromise) await new Promise((resolve) => setImmediate(resolve));
  await shutdownPromise;
  assert.equal(fs.existsSync(staging), false);
  assert.deepEqual(Object.fromEntries(mainCleanupCounts), { 0: 1, 1: 1 });
});

function seedRecoveryOwner(db, { batchId, taskRunId, operationKey }) {
  const archive = createArchiveRepository(db);
  archive.beginTaskRun({
    taskRunId,
    moduleId: 'pre-fund',
    taskKey: 'pre-fund-reconciliation:import-mpt',
    operationKey,
    parentRunId: 'recovery-parent-run'
  });
  db.prepare(`
    UPDATE archive_task_runs SET status = 'running' WHERE task_run_id = ?
  `).run(taskRunId);
  db.prepare(`
    INSERT INTO archive_batches (
      id, batch_number, module_id, module_code, module_name,
      operation_key, local_date, daily_sequence, task_key, task_run_id,
      parent_run_id, task_status, created_at, updated_at
    ) VALUES (?, 'PFT-20260708-001', 'pre-fund', 'PFT', '前置资金对账',
      ?, '2026-07-08', 1, 'pre-fund-reconciliation:import-mpt', ?,
      'recovery-parent-run', 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(batchId, operationKey, taskRunId);
}

function criticalPayload(parentOperationKey) {
  return {
    fileOperationKey: `${parentOperationKey}/file/000000`,
    fileIndex: 0,
    sourceType: 'MPT_INBOUND_GATEWAY',
    sourceBatch: 'MPT_INBOUND_20260708',
    sourceDate: '2026-07-08',
    sourceFileSequence: '901',
    monthKey: '2026-07',
    sourceFileName: 'MPT_INBOUND_GATEWAY_20260708_901.txt',
    sourceSha256: '1'.repeat(64),
    contentHash: '1'.repeat(64),
    datasetId: 'recovery-dataset',
    expectedContentHash: '',
    counts: { parsed: 1, valid: 1, error: 0, excluded: 0 }
  };
}

async function recoveryHarness(outcome, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  const batchId = 91;
  const taskRunId = `recovery-task-${outcome}`;
  const parentOperationKey = `recovery-parent-${outcome}`;
  seedRecoveryOwner(db, { batchId, taskRunId, operationKey: parentOperationKey });
  const readRepository = createRecoveryControlReadRepository(db);
  const requestOwnerRepository = createRecoveryRequestOwnerRepository(db);
  const baseRecoveryControlRepository = createRecoveryControlRepository(db);
  const recoveryControlRepository = typeof options.wrapRecoveryControlRepository === 'function'
    ? options.wrapRecoveryControlRepository(baseRecoveryControlRepository)
    : baseRecoveryControlRepository;
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register('inspector.pre-fund:mpt-import', async (source) => {
    const boundedEvidence = { disposition: `test-${outcome}` };
    return {
      contractVersion: 1,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      outcome,
      evidenceVersion: 1,
      evidenceHash: canonicalSha256(boundedEvidence),
      boundedEvidence
    };
  });
  inspectorRegistry.freeze();
  const providers = createSettlementRecoveryProviderRegistry();
  providers.freeze();
  const startup = createStartupRecoveryCoordinator({
    readRepository,
    inspectorRegistry,
    providerRegistry: providers,
    requestOwnerRepository,
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository,
    resolvePolicy: () => PRE_FUND_MPT_POLICIES[0],
    planTransitions: preFundMptRecoveryPlanTransitions,
    transientAttempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0
  });
  const durable = createWorkerDurableCoordinator({
    readRepository,
    requestOwnerRepository,
    recoveryControlRepository,
    recoveryCoordinator: startup,
    receiptAuthority: options.receiptAuthority || {
      async verify({ receipt }) { return receipt; }
    },
    ...(options.conflictScopeGate ? { conflictScopeGate: options.conflictScopeGate } : {})
  });
  if (options.skipPrepare === true) {
    return { db, durable, readRepository, batchId, taskRunId, parentOperationKey };
  }
  let prepared;
  try {
    prepared = await durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[0],
      actionKey: 'pre-fund:mpt-import',
      parentOperationKey,
      taskRunId,
      batchId,
      jobId: `job-${outcome}`,
      unitId: 'file:000000',
      critical: criticalPayload(parentOperationKey)
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, durable, prepared, readRepository, batchId, taskRunId, parentOperationKey };
}

test('managed critical:ready按Writer实际header scope在持久ACK前复核Hold', async () => {
  const seen = [];
  await assert.rejects(() => recoveryHarness('not-committed', {
    conflictScopeGate(identity) {
      seen.push(identity);
      throw Object.assign(new Error('held actual Writer identity'), { code: 'RECOVERY_HOLD_ACTIVE' });
    }
  }), { code: 'RECOVERY_HOLD_ACTIVE' });
  assert.deepEqual(seen.map(({ sourceType, sourceBatch }) => ({ sourceType, sourceBatch })), [{
    sourceType: 'MPT_INBOUND_GATEWAY', sourceBatch: 'MPT_INBOUND_20260708'
  }]);
});

test('prepared与acked同一Control transaction，mark-acked注入失败不留open Intent或Hold', async () => {
  let transitionCount = 0;
  const harness = await recoveryHarness('not-committed', {
    skipPrepare: true,
    wrapRecoveryControlRepository(base) {
      return {
        runInControlTransaction(work) {
          return base.runInControlTransaction((tx) => work({
            transitionWithRecoveryEvent(request) {
              transitionCount += 1;
              if (transitionCount === 2) {
                throw Object.assign(new Error('injected mark-acked failure'), {
                  code: 'TEST_MARK_ACKED_FAILED'
                });
              }
              return tx.transitionWithRecoveryEvent(request);
            },
            appendObservationEvent(event) {
              return tx.appendObservationEvent(event);
            }
          }));
        }
      };
    }
  });
  try {
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[0],
      actionKey: 'pre-fund:mpt-import',
      parentOperationKey: harness.parentOperationKey,
      taskRunId: harness.taskRunId,
      batchId: harness.batchId,
      jobId: 'atomic-ack-failure-job',
      unitId: 'file:000000',
      critical: criticalPayload(harness.parentOperationKey)
    }), { code: 'TEST_MARK_ACKED_FAILED' });
    assert.equal(transitionCount, 2);
    assert.deepEqual(harness.readRepository.listOpenCriticalIntents(), []);
    assert.deepEqual(harness.readRepository.listActiveRecoveryHolds(), []);
  } finally {
    harness.db.close();
  }
});

test('durable recovery：prepared→acked；COMMIT结果丢失原子写interrupted/Hold并close，未提交直接recovered', async () => {
  const observed = await recoveryHarness('not-committed');
  try {
    await observed.durable.observeReceipt({
      actionKey: 'pre-fund:mpt-import',
      fileOperationKey: `${observed.parentOperationKey}/file/000000`,
      taskRunId: observed.taskRunId,
      intentId: observed.prepared.intentId,
      receipt: {
        id: 7,
        actionKey: 'pre-fund:mpt-import',
        operationKey: `${observed.parentOperationKey}/file/000000`,
        producerTaskRunId: observed.taskRunId,
        batchId: observed.batchId,
        outcomeKind: 'inserted'
      }
    });
    assert.equal(observed.readRepository.getCriticalIntentById(observed.prepared.intentId).state, 'committed');
    await observed.durable.settleCommitted({
      intentId: observed.prepared.intentId,
      result: { status: 'ok' }
    });
    assert.equal(observed.readRepository.getCriticalIntentById(observed.prepared.intentId).state, 'closed');
  } finally {
    observed.db.close();
  }

  const committed = await recoveryHarness('committed');
  try {
    assert.equal(committed.readRepository.getCriticalIntentById(committed.prepared.intentId).state, 'acked');
    const decision = await committed.durable.resolveUncertain({ intentId: committed.prepared.intentId });
    assert.equal(decision.outcome, 'committed');
    assert.equal(committed.readRepository.getCriticalIntentById(committed.prepared.intentId).state, 'closed');
    assert.equal(committed.db.prepare('SELECT status FROM archive_task_runs WHERE task_run_id = ?')
      .get(committed.taskRunId).status, 'interrupted');
    assert.equal(committed.db.prepare(`
      SELECT state FROM background_execution_batch_recovery_states WHERE batch_id = ?
    `).get(committed.batchId).state, 'interrupted');
    const hold = committed.readRepository.listActiveRecoveryHolds()[0];
    assert.equal(hold.reasonCode, 'RESULT_LOST');
    assert.equal(hold.operationKey, `${committed.parentOperationKey}/file/000000`);
  } finally {
    committed.db.close();
  }

  const absent = await recoveryHarness('not-committed');
  try {
    const decision = await absent.durable.resolveUncertain({ intentId: absent.prepared.intentId });
    assert.equal(decision.outcome, 'not-committed');
    assert.equal(absent.readRepository.getCriticalIntentById(absent.prepared.intentId).state, 'closed');
    assert.equal(absent.readRepository.listActiveRecoveryHolds().length, 0);
    assert.equal(absent.db.prepare('SELECT status FROM archive_task_runs WHERE task_run_id = ?')
      .get(absent.taskRunId).status, 'running');
  } finally {
    absent.db.close();
  }

  const unknown = await recoveryHarness('unknown');
  try {
    const decision = await unknown.durable.resolveUncertain({ intentId: unknown.prepared.intentId });
    assert.equal(decision.outcome, 'unknown');
    assert.equal(unknown.readRepository.getCriticalIntentById(unknown.prepared.intentId).state, 'acked');
    assert.equal(unknown.db.prepare('SELECT status FROM archive_task_runs WHERE task_run_id = ?')
      .get(unknown.taskRunId).status, 'interrupted');
    assert.equal(unknown.readRepository.listActiveRecoveryHolds()[0].reasonCode, 'INSPECTION_UNKNOWN');
  } finally {
    unknown.db.close();
  }
});

test('receipt authority拒绝后Intent保持acked并由唯一Inspector形成RESULT_LOST Hold', async () => {
  const observed = await recoveryHarness('committed', {
    receiptAuthority: {
      async verify() {
        throw Object.assign(new Error('authoritative receipt conflict'), {
          code: 'WORKER_DURABLE_RECEIPT_AUTHORITY_CONFLICT'
        });
      }
    }
  });
  try {
    await assert.rejects(() => observed.durable.observeReceipt({
      actionKey: 'pre-fund:mpt-import',
      fileOperationKey: `${observed.parentOperationKey}/file/000000`,
      taskRunId: observed.taskRunId,
      intentId: observed.prepared.intentId,
      receipt: { tampered: true }
    }), { code: 'WORKER_DURABLE_RECEIPT_AUTHORITY_CONFLICT' });
    assert.equal(observed.readRepository.getCriticalIntentById(observed.prepared.intentId).state, 'acked');
    const decision = await observed.durable.resolveUncertain({ intentId: observed.prepared.intentId });
    assert.equal(decision.outcome, 'committed');
    assert.equal(observed.readRepository.getCriticalIntentById(observed.prepared.intentId).state, 'closed');
    assert.equal(observed.readRepository.listActiveRecoveryHolds()[0].reasonCode, 'RESULT_LOST');
  } finally {
    observed.db.close();
  }
});

test('critical payload拒绝缺失source sequence与非守恒counts', async () => {
  const harness = await recoveryHarness('not-committed');
  try {
    const badCounts = criticalPayload('another-parent');
    badCounts.counts = { parsed: 2, valid: 1, error: 0, excluded: 0 };
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[0],
      actionKey: 'pre-fund:mpt-import',
      parentOperationKey: 'another-parent',
      taskRunId: 'another-task',
      batchId: 92,
      jobId: 'another-job',
      unitId: 'file:000000',
      critical: badCounts
    }), { code: 'PREFUND_CRITICAL_PAYLOAD_INVALID' });
    const missingSequence = criticalPayload('another-parent');
    delete missingSequence.sourceFileSequence;
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[0],
      actionKey: 'pre-fund:mpt-import',
      parentOperationKey: 'another-parent',
      taskRunId: 'another-task',
      batchId: 92,
      jobId: 'another-job',
      unitId: 'file:000000',
      critical: missingSequence
    }), { code: 'PREFUND_CRITICAL_PAYLOAD_INVALID' });
    const importWithRepairHash = criticalPayload('import-hash-parent');
    importWithRepairHash.expectedContentHash = 'a'.repeat(64);
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[0], actionKey: 'pre-fund:mpt-import',
      parentOperationKey: 'import-hash-parent', taskRunId: 'import-hash-task', batchId: 93,
      jobId: 'import-hash-job', unitId: 'file:000000', critical: importWithRepairHash
    }), { code: 'PREFUND_CRITICAL_PAYLOAD_INVALID' });
    const repairWithoutHash = criticalPayload('repair-hash-parent');
    await assert.rejects(() => harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[1], actionKey: 'pre-fund:mpt-repair-import',
      parentOperationKey: 'repair-hash-parent', taskRunId: 'repair-hash-task', batchId: 94,
      jobId: 'repair-hash-job', unitId: 'file:000000', critical: repairWithoutHash
    }), { code: 'PREFUND_CRITICAL_PAYLOAD_INVALID' });
    const validRepair = criticalPayload(harness.parentOperationKey);
    validRepair.expectedContentHash = 'b'.repeat(64);
    const accepted = await harness.durable.prepareAndAck({
      policy: PRE_FUND_MPT_POLICIES[1], actionKey: 'pre-fund:mpt-repair-import',
      parentOperationKey: harness.parentOperationKey,
      taskRunId: harness.taskRunId,
      batchId: harness.batchId,
      jobId: 'valid-repair-job', unitId: 'file:000000', critical: validRepair
    });
    assert.match(accepted.intentId, /^prefund-intent-/);
  } finally {
    harness.db.close();
  }
});
