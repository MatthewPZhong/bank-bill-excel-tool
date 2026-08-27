'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

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

const servicePath = require.resolve(
  '../../../../src/main-process/duplicate-inbound-match/service'
);
const {
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  DUPLICATE_STARTUP_RECOVERY_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider
} = require('../../../../src/main-process/duplicate-inbound-match/startup-recovery');

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

function recoveryHarness(inspector) {
  const db = new DatabaseSync(':memory:');
  const inspectorRegistry = createInspectorRegistry();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  inspectorRegistry.register('inspector.duplicate:run', inspector);
  providerRegistry.register(
    DUPLICATE_STARTUP_RECOVERY_KEY,
    createDuplicateStartupRecoveryProvider()
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
