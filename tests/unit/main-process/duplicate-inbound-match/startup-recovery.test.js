'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const {
  createRecoveryControlRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryControlReadRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-read-repository');
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
const {
  canonicalSha256
} = require('../../../../src/main-process/background-execution/canonical-json-v1');

const servicePath = require.resolve(
  '../../../../src/main-process/duplicate-inbound-match/service'
);
const {
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  DUPLICATE_STARTUP_RECOVERY_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider,
  operationSource
} = require('../../../../src/main-process/duplicate-inbound-match/startup-recovery');
const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const mirrorRepository = require(
  '../../../../src/backend/database/duplicate-inbound-match-run-repository'
);
const runDataStore = require('../../../../src/backend/run-data-store');
const operationReceipts = require(
  '../../../../src/main-process/duplicate-inbound-match/operation-receipt-repository'
);

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function createCommittedSideRun(userDataDir, suffix = '1', options = {}) {
  const monthKey = '2026-08';
  const db = runDataStore.openSideDb(
    userDataDir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, monthKey
  );
  const bankHash = stableHash(`bank-${suffix}`);
  const documentHash = stableHash(`document-${suffix}`);
  const snapshotHash = stableHash({ snapshot: suffix });
  const importEvidenceHash = stableHash({
    evidenceVersion: 1,
    bankFileHash: bankHash,
    documentFileHash: documentHash
  });
  const runOperationKey = `duplicate/run/recovery-${suffix}`;
  const runTaskRunId = `task-duplicate-run-recovery-${suffix}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    const imported = db.prepare(`
      INSERT INTO duplicate_inbound_match_imports (
        bank_file_name, bank_content_hash, bank_row_count,
        document_file_name, document_content_hash, document_row_count,
        document_matchable_row_count, document_empty_order_count
      ) VALUES ('bank.xlsx', ?, 0, 'document.xlsx', ?, 0, 0, 0)
    `).run(bankHash, documentHash);
    const importId = Number(imported.lastInsertRowid);
    operationReceipts.insertOperationReceipt(db, {
      actionKey: 'duplicate:import',
      operationKey: `duplicate/import/recovery-${suffix}`,
      producerTaskRunId: `task-duplicate-import-recovery-${suffix}`,
      phase: 'import-side-committed',
      monthKey,
      importBundleId: importId,
      sideRunId: null,
      inputEvidenceHash: importEvidenceHash
    });
    const runResult = db.prepare(`
      INSERT INTO duplicate_inbound_match_runs (
        import_id, snapshot_json, snapshot_hash, status, summary_json, finished_at
      ) VALUES (?, '{}', ?, 'success', ?, CURRENT_TIMESTAMP)
    `).run(importId, snapshotHash, JSON.stringify({
      mailRowCount: 0, manualRowCount: 0, auditGroupCount: 0
    }));
    const sideRunId = Number(runResult.lastInsertRowid);
    const inputEvidenceHash = stableHash({
      evidenceVersion: 1,
      importBundleId: importId,
      bankFileHash: bankHash,
      documentFileHash: documentHash,
      snapshotHash
    });
    operationReceipts.insertOperationReceipt(db, {
      actionKey: 'duplicate:run',
      operationKey: runOperationKey,
      producerTaskRunId: runTaskRunId,
      phase: 'run-side-committed',
      monthKey,
      importBundleId: importId,
      sideRunId,
      inputEvidenceHash
    });
    db.exec('COMMIT');
    return {
      monthKey, bankHash, documentHash, snapshotHash, importId, sideRunId,
      operationKey: runOperationKey, producerTaskRunId: runTaskRunId, inputEvidenceHash,
      openDb: options.keepOpen === true ? db : null
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    if (options.keepOpen !== true) db.close();
  }
}

function snapshotFamily(sidePath) {
  const snapshot = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = sidePath + suffix;
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath, { bigint: true });
    snapshot[suffix || 'main'] = {
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      bytes: fs.readFileSync(filePath)
    };
  }
  return snapshot;
}

test('startup inspector独立于Service且clean结果为not-committed', async (t) => {
  assert.equal(require.cache[servicePath], undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-startup-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = createDuplicateStartupRecoveryProvider();
  const [source] = await provider.listOpenSources();
  assert.deepEqual((await provider.listOpenSources())[0], source, 'module source identity必须跨扫描稳定');
  assert.equal(source.settlementKey, DUPLICATE_STARTUP_RECOVERY_KEY);
  assert.equal(source.conflictScopeKey, DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY);
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const result = await inspect(source);
  assert.equal(result.outcome, 'not-committed');
  assert.equal(result.boundedEvidence.sideDbCount, 0);
  assert.equal(result.boundedEvidence.mirrorCount, 0);
  assert.equal(require.cache[servicePath], undefined);
});

test('任一side或main持久残留只判unknown，Inspector读取不写不删', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-startup-residue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  fs.mkdirSync(sideDir, { recursive: true });
  const sidePath = path.join(sideDir, 'month-2026-07.sqlite');
  const db = new DatabaseSync(sidePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE duplicate_inbound_match_imports (id INTEGER PRIMARY KEY);
    INSERT INTO duplicate_inbound_match_imports DEFAULT VALUES;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  db.close();
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(sidePath + suffix); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  const before = fs.statSync(sidePath, { bigint: true });
  const beforeBytes = fs.readFileSync(sidePath);
  const provider = createDuplicateStartupRecoveryProvider();
  const [source] = await provider.listOpenSources();
  const mirrors = [{ id: 3, monthKey: '2026-07', sideRunId: 4, status: 'running' }];
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => mirrors.map((item) => ({ ...item }))
  });
  const result = await inspect(source);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.boundedEvidence.disposition, 'persistent-residue-requires-hold');
  assert.equal(result.boundedEvidence.sideDbCount, 1);
  assert.equal(result.boundedEvidence.mirrorCount, 1);
  assert.equal(fs.existsSync(sidePath), true);
  const after = fs.statSync(sidePath, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readFileSync(sidePath), beforeBytes);
  assert.deepEqual(fs.readdirSync(sideDir).sort(), ['month-2026-07.sqlite']);
  assert.deepEqual(mirrors, [{ id: 3, monthKey: '2026-07', sideRunId: 4, status: 'running' }]);
});

test('Inspector读取失败向上抛出且不破坏side文件', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-startup-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  fs.mkdirSync(sideDir, { recursive: true });
  const sidePath = path.join(sideDir, 'month-2026-07.sqlite');
  fs.writeFileSync(sidePath, 'not sqlite');
  const [source] = await createDuplicateStartupRecoveryProvider().listOpenSources();
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  await assert.rejects(() => inspect(source));
  assert.equal(fs.readFileSync(sidePath, 'utf8'), 'not sqlite');
});

test('孤立WAL/SHM也属于不可忽略的unknown residue且不被清理', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-startup-sidecar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  fs.mkdirSync(sideDir, { recursive: true });
  const walPath = path.join(sideDir, 'month-2026-08.sqlite-wal');
  const shmPath = path.join(sideDir, 'month-2026-08.sqlite-shm');
  fs.writeFileSync(walPath, 'wal-evidence');
  fs.writeFileSync(shmPath, 'shm-evidence');
  const [source] = await createDuplicateStartupRecoveryProvider().listOpenSources();
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const result = await inspect(source);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.boundedEvidence.sideDbCount, 1);
  assert.equal(fs.readFileSync(walPath, 'utf8'), 'wal-evidence');
  assert.equal(fs.readFileSync(shmPath, 'utf8'), 'shm-evidence');
});

function recoveryHarness(inspector, provider = createDuplicateStartupRecoveryProvider()) {
  const db = new DatabaseSync(':memory:');
  const inspectorRegistry = createInspectorRegistry();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  inspectorRegistry.register('inspector.duplicate:run', inspector);
  providerRegistry.register(
    DUPLICATE_STARTUP_RECOVERY_KEY,
    provider
  );
  inspectorRegistry.freeze();
  providerRegistry.freeze();
  const readRepository = createRecoveryControlReadRepository(db);
  const coordinator = createStartupRecoveryCoordinator({
    readRepository,
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db),
    resolvePolicy: () => null,
    planTransitions: () => [],
    sleep: async () => {}
  });
  return { coordinator, db, readRepository };
}

test('unknown和Inspector失败均由Platform Contract创建active Hold', async () => {
  const provider = createDuplicateStartupRecoveryProvider();
  const [source] = await provider.listOpenSources();
  const unknownHarness = recoveryHarness(async () => ({
    contractVersion: 1,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef,
    actionKey: source.actionKey,
    operationKey: source.operationKey,
    taskRunId: source.taskRunId,
    outcome: 'unknown',
    evidenceVersion: 1,
    evidenceHash: require(
      '../../../../src/main-process/background-execution/canonical-json-v1'
    ).canonicalSha256({ disposition: 'residue' }),
    boundedEvidence: { disposition: 'residue' }
  }));
  try {
    await unknownHarness.coordinator.scanAndRecover();
    const hold = unknownHarness.readRepository.getActiveRecoveryHoldByScope(
      DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY
    );
    assert.equal(hold.reasonCode, 'INSPECTION_UNKNOWN');
  } finally {
    unknownHarness.db.close();
  }

  let attempts = 0;
  const failureHarness = recoveryHarness(async () => {
    attempts += 1;
    throw Object.assign(new Error('read failed'), { code: 'SIDE_DB_READ_FAILED' });
  });
  try {
    await failureHarness.coordinator.scanAndRecover();
    assert.equal(attempts, 3);
    const hold = failureHarness.readRepository.getActiveRecoveryHoldByScope(
      DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY
    );
    assert.equal(hold.reasonCode, 'INSPECTOR_UNAVAILABLE');
  } finally {
    failureHarness.db.close();
  }
});

test('exact run inspector区分partial/committed/unknown且complete-mirror CAS与audit原子幂等', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'atomic');
  const mainDb = new DatabaseSync(':memory:');
  t.after(() => mainDb.close());
  ensureDuplicateInboundMatchRunMetadataSupport(mainDb);
  const options = {
    userDataDir: dir,
    listRunMirrors: () => mirrorRepository.listRunMirrors(mainDb),
    getRecoveryAuditBySource: (sourceRef) => (
      mirrorRepository.getRecoveryAuditBySource(mainDb, sourceRef)
    )
  };
  const inspect = createDuplicateStartupOutcomeInspector(options);
  const source = operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  });
  const partial = await inspect(source);
  assert.equal(partial.outcome, 'partially-committed');
  assert.equal(partial.boundedEvidence.sideRunId, side.sideRunId);
  const importSource = operationSource({
    actionKey: 'duplicate:import',
    operationKey: 'duplicate/import/recovery-atomic',
    producerTaskRunId: 'task-duplicate-import-recovery-atomic'
  });
  assert.equal((await inspect(importSource)).outcome, 'committed');
  assert.equal((await inspect(operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: 'different-owner'
  }))).outcome, 'unknown');

  const provider = createDuplicateStartupRecoveryProvider({
    ...options,
    mainDatabase: mainDb,
    getRecoveryAuditByOperation: (actionKey, operationKey, taskRunId) => (
      mirrorRepository.getRecoveryAuditByOperation(mainDb, actionKey, operationKey, taskRunId)
    ),
    inspectOperation: inspect
  });
  const recovered = await provider.recover(source, partial);
  assert.equal(recovered.outcome, 'completed');
  assert.equal(recovered.boundedResult.recoveryAction, 'complete-mirror');
  const mirror = mirrorRepository.getRunMirrorByOperation(mainDb, side.operationKey);
  assert.equal(mirror.sideRunId, side.sideRunId);
  assert.equal(mirror.operationKey, side.operationKey);
  assert.equal(mirror.producerTaskRunId, side.producerTaskRunId);
  assert.equal((await inspect(source)).outcome, 'committed');
  const audit = mirrorRepository.getRecoveryAuditBySource(mainDb, source.sourceRef);
  assert.equal(audit.recoveryAction, 'complete-mirror');
  assert.equal(audit.mirrorId, mirror.id);

  const replay = await provider.recover(source, partial);
  assert.deepEqual(replay, recovered);
  assert.equal(mirrorRepository.listRunMirrors(mainDb).length, 1);
  assert.equal(mainDb.prepare(
    'SELECT COUNT(*) AS count FROM duplicate_inbound_match_recovery_audits'
  ).get().count, 1);

  const absentSource = operationSource({
    actionKey: 'duplicate:run',
    operationKey: 'duplicate/run/absent',
    producerTaskRunId: 'task-duplicate-run-absent'
  });
  assert.equal((await inspect(absentSource)).outcome, 'not-committed');
  mirrorRepository.createCommittedRunMirror(mainDb, {
    monthKey: '2026-08', sideRunId: 999, snapshotHash: '1'.repeat(64),
    bankFileName: 'bank.xlsx', bankFileHash: '2'.repeat(64),
    documentFileName: 'document.xlsx', documentFileHash: '3'.repeat(64),
    sideDbRelPath: 'run-data/duplicate-inbound-match/month-2026-08.sqlite',
    summary: {}, operationKey: absentSource.operationKey,
    producerTaskRunId: absentSource.taskRunId, inputEvidenceHash: '4'.repeat(64)
  });
  assert.equal((await inspect(absentSource)).outcome, 'unknown');

  const compensatedSource = operationSource({
    actionKey: 'duplicate:import',
    operationKey: 'duplicate/import/compensated',
    producerTaskRunId: 'task-duplicate-import-compensated'
  });
  const boundedResult = { disposition: 'expired-before-replacement' };
  mainDb.exec('BEGIN IMMEDIATE');
  try {
    mirrorRepository.insertRecoveryAudit(mainDb, {
      sourceRef: compensatedSource.sourceRef,
      actionKey: compensatedSource.actionKey,
      operationKey: compensatedSource.operationKey,
      producerTaskRunId: compensatedSource.taskRunId,
      inspectionEvidenceHash: '5'.repeat(64),
      outcome: 'compensated',
      recoveryAction: 'expire',
      sideRunId: null,
      mirrorId: null,
      boundedResult,
      resultHash: canonicalSha256(boundedResult)
    });
    mainDb.exec('COMMIT');
  } catch (error) {
    mainDb.exec('ROLLBACK');
    throw error;
  }
  const compensated = await inspect(compensatedSource);
  assert.equal(compensated.outcome, 'compensated');
  assert.equal(compensated.boundedEvidence.recoveryAction, 'expire');
});

test('exact partial由Platform创建Hold且不会自动调用complete-mirror provider', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-partial-hold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'hold');
  const source = operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  });
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  let recoverCalls = 0;
  const provider = Object.freeze({
    async listOpenSources() { return Object.freeze([source]); },
    async recover() {
      recoverCalls += 1;
      throw new Error('partial不应自动调用provider');
    }
  });
  const harness = recoveryHarness(inspect, provider);
  try {
    const summary = await harness.coordinator.scanAndRecover();
    assert.equal(summary.activeHoldCount, 1);
    assert.equal(recoverCalls, 0);
    const hold = harness.readRepository.getActiveRecoveryHoldByScope(
      DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY
    );
    assert.equal(hold.reasonCode, 'PARTIALLY_COMMITTED');
  } finally {
    harness.db.close();
  }
});

test('Platform critical-intent source不依赖module policy marker也走exact inspector', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-critical-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'critical-intent');
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const operation = operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  });
  const criticalIntentSource = {
    ...operation,
    sourceKind: 'critical-intent',
    sourceRef: 'critical-intent:intent-duplicate-run-critical-intent',
    settlementKey: null,
    intentId: 'intent-duplicate-run-critical-intent',
    boundedEvidence: {
      criticalState: 'acked',
      receiptKind: 'module-local'
    }
  };
  const result = await inspect(criticalIntentSource);
  assert.equal(result.outcome, 'partially-committed');
  assert.equal(result.boundedEvidence.sideRunId, side.sideRunId);
});

test('receipt target实际行数与import metadata不守恒时import/run均判unknown', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-import-conservation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'row-conservation');
  const sideDb = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    dir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, side.monthKey
  ));
  try {
    sideDb.prepare(`
      UPDATE duplicate_inbound_match_imports SET bank_row_count = 1 WHERE id = ?
    `).run(side.importId);
  } finally {
    sideDb.close();
  }
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const importResult = await inspect(operationSource({
    actionKey: 'duplicate:import',
    operationKey: 'duplicate/import/recovery-row-conservation',
    producerTaskRunId: 'task-duplicate-import-recovery-row-conservation'
  }));
  assert.equal(importResult.outcome, 'unknown');
  const runResult = await inspect(operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  }));
  assert.equal(runResult.outcome, 'unknown');
});

test('exact inspector读取未checkpoint WAL中的receipt且原始DB family逐字节不变', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-wal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'wal', { keepOpen: true });
  t.after(() => side.openDb.close());
  const sidePath = runDataStore.sideDbPath(
    dir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, side.monthKey
  );
  assert.equal(fs.existsSync(sidePath + '-wal'), true, 'fixture必须保留未checkpoint WAL');
  const before = snapshotFamily(sidePath);
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const result = await inspect(operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  }));
  assert.equal(result.outcome, 'partially-committed');
  const after = snapshotFamily(sidePath);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const key of Object.keys(before)) {
    assert.equal(after[key].size, before[key].size);
    assert.equal(after[key].mtimeNs, before[key].mtimeNs);
    assert.deepEqual(after[key].bytes, before[key].bytes);
  }
});

test('exact source旁的孤立WAL family仍保留legacy unknown source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-orphan-wal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'with-orphan');
  const sideDir = path.join(dir, 'run-data', 'duplicate-inbound-match');
  fs.writeFileSync(path.join(sideDir, 'month-2026-07.sqlite-wal'), 'orphan-wal');
  const mainDb = new DatabaseSync(':memory:');
  t.after(() => mainDb.close());
  ensureDuplicateInboundMatchRunMetadataSupport(mainDb);
  const inspect = createDuplicateStartupOutcomeInspector({
    userDataDir: dir,
    listRunMirrors: () => []
  });
  const provider = createDuplicateStartupRecoveryProvider({
    userDataDir: dir,
    mainDatabase: mainDb,
    listRunMirrors: () => [],
    getRecoveryAuditByOperation: () => null,
    inspectOperation: inspect
  });
  const sources = await provider.listOpenSources();
  assert.equal(sources.some((item) => item.operationKey === side.operationKey), true);
  const legacy = sources.find((item) => item.boundedEvidence.policy === 'startup-residue-requires-hold-v1');
  assert.ok(legacy);
  assert.equal((await inspect(legacy)).outcome, 'unknown');
  assert.equal(fs.readFileSync(path.join(sideDir, 'month-2026-07.sqlite-wal'), 'utf8'), 'orphan-wal');
});

test('complete-mirror在audit写入前故障会同时回滚mirror与audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-cas-fault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'fault');
  const mainDb = new DatabaseSync(':memory:');
  t.after(() => mainDb.close());
  ensureDuplicateInboundMatchRunMetadataSupport(mainDb);
  const options = {
    userDataDir: dir,
    listRunMirrors: () => mirrorRepository.listRunMirrors(mainDb),
    getRecoveryAuditBySource: (sourceRef) => (
      mirrorRepository.getRecoveryAuditBySource(mainDb, sourceRef)
    )
  };
  const inspect = createDuplicateStartupOutcomeInspector(options);
  const source = operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  });
  const partial = await inspect(source);
  const provider = createDuplicateStartupRecoveryProvider({
    ...options,
    mainDatabase: mainDb,
    getRecoveryAuditByOperation: () => null,
    inspectOperation: inspect,
    afterMirrorCas() {
      throw Object.assign(new Error('injected crash after mirror CAS'), {
        code: 'INJECTED_AFTER_MIRROR_CAS'
      });
    }
  });
  await assert.rejects(
    () => provider.recover(source, partial),
    (error) => error.code === 'INJECTED_AFTER_MIRROR_CAS'
  );
  assert.equal(mirrorRepository.getRunMirrorByOperation(mainDb, side.operationKey), null);
  assert.equal(mirrorRepository.getRecoveryAuditBySource(mainDb, source.sourceRef), null);
  assert.equal((await inspect(source)).outcome, 'partially-committed');
});

test('complete-mirror复检后side post-image变化会fail closed且不写mirror/audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-e07-b-side-toctou-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const side = createCommittedSideRun(dir, 'toctou');
  const mainDb = new DatabaseSync(':memory:');
  t.after(() => mainDb.close());
  ensureDuplicateInboundMatchRunMetadataSupport(mainDb);
  const options = {
    userDataDir: dir,
    listRunMirrors: () => mirrorRepository.listRunMirrors(mainDb),
    getRecoveryAuditBySource: (sourceRef) => (
      mirrorRepository.getRecoveryAuditBySource(mainDb, sourceRef)
    )
  };
  const inspect = createDuplicateStartupOutcomeInspector(options);
  const source = operationSource({
    actionKey: 'duplicate:run',
    operationKey: side.operationKey,
    producerTaskRunId: side.producerTaskRunId
  });
  const partial = await inspect(source);
  const provider = createDuplicateStartupRecoveryProvider({
    ...options,
    mainDatabase: mainDb,
    getRecoveryAuditByOperation: () => null,
    async inspectOperation(candidateSource) {
      const current = await inspect(candidateSource);
      const sideDb = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
        dir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH, side.monthKey
      ));
      try {
        sideDb.prepare(`
          UPDATE duplicate_inbound_match_runs
          SET summary_json = ? WHERE id = ?
        `).run(JSON.stringify({
          mailRowCount: 0,
          manualRowCount: 0,
          auditGroupCount: 0,
          injectedPostInspectionChange: true
        }), side.sideRunId);
      } finally {
        sideDb.close();
      }
      return current;
    }
  });
  const result = await provider.recover(source, partial);
  assert.equal(result.outcome, 'terminal-failure');
  assert.equal(result.safeError.code, 'DUPLICATE_COMMITTED_SIDE_CHANGED');
  assert.equal(mirrorRepository.getRunMirrorByOperation(mainDb, side.operationKey), null);
  assert.equal(mirrorRepository.getRecoveryAuditBySource(mainDb, source.sourceRef), null);
});
