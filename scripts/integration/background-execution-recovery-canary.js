'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureArchiveMetadataSupport
} = require('../../src/backend/database/archive-repository');
const {
  canonicalSha256
} = require('../../src/main-process/background-execution/canonical-json-v1');
const {
  durableRecoveryPolicy
} = require('../../src/main-process/background-execution/canary');
const {
  createCanaryReceiptInspector,
  createCanarySettlementProvider,
  ensureCanaryReceiptSchema,
  runWorkerDurableCanary,
  writeCanaryTargetPostImage
} = require('../../src/main-process/background-execution/canary/durable-recovery');
const {
  createRecoveryControlReadRepository
} = require('../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createInspectorRegistry
} = require('../../src/main-process/background-execution/inspector-registry');
const {
  transitionRequestKey
} = require('../../src/main-process/background-execution/recovery-control-contract');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../src/main-process/background-execution/startup-recovery-coordinator');

let passed = 0;
const failures = [];

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push({ label, actual, expected });
}

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  ensureCanaryReceiptSchema(db);
  return db;
}

function transition(db, value, safePayload) {
  const request = createRecoveryRequestOwnerRepository(db).reserveTransitionRequest({
    requestKey: transitionRequestKey(value),
    transition: value,
    safePayload
  });
  return createRecoveryControlRepository(db).runInControlTransaction(
    (tx) => tx.transitionWithRecoveryEvent(request)
  );
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-recovery-canary-'));
  const dbPath = path.join(tempDir, 'private-control.sqlite');
  let db = openDb(dbPath);
  const evidence = { expectedValue: 'durable-value' };
  const input = {
    contractVersion: 1,
    intentId: 'intent-integration-canary',
    actionKey: 'background-execution:canary',
    operationKey: 'operation-integration-canary',
    taskRunId: 'task-integration-canary',
    jobId: 'job-integration-canary',
    coordinationKind: 'worker-critical',
    conflictScopeKey: 'scope:integration-canary',
    inspectorKey: 'inspector.background-execution:canary',
    evidenceVersion: 1,
    evidenceHash: canonicalSha256(evidence),
    boundedEvidence: evidence
  };
  transition(db, { entityKind: 'critical-intent', command: 'create-prepared', input }, { state: 'prepared' });
  transition(db, {
    entityKind: 'critical-intent',
    command: 'mark-acked',
    intentId: input.intentId,
    expectedState: 'prepared',
    patch: { admission: 'main' }
  }, { state: 'acked' });
  db.close();

  const crash = await runWorkerDurableCanary({
    dbPath,
    operationKey: input.operationKey,
    value: 'durable-value',
    committedAt: '2026-08-24T00:00:00.000Z',
    crashAfterCommit: true
  });
  assertEqual(crash.status, 'crashed-after-commit', 'worker crashes after durable COMMIT');

  db = openDb(dbPath);
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.register(input.inspectorKey, createCanaryReceiptInspector(db));
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  const coordinator = createStartupRecoveryCoordinator({
    readRepository: createRecoveryControlReadRepository(db),
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db),
    backoffBaseMs: 0,
    backoffMaxMs: 0
  });
  const first = await coordinator.scanAndRecover();
  const second = await coordinator.scanAndRecover();
  assertEqual(first.sourceCount, 1, 'restart enumerates open critical intent');
  assertEqual(second.sourceCount, 0, 'closed intent is not replayed as open source');
  assertEqual(
    createRecoveryControlReadRepository(db).getCriticalIntentById(input.intentId).state,
    'closed',
    'receipt inspection closes committed intent'
  );
  assertEqual(db.prepare(`
    SELECT COUNT(*) AS n FROM background_execution_canary_receipts WHERE operation_key = ?
  `).get(input.operationKey).n, 1, 'durable mutation and receipt remain exactly once');

  const targetPath = path.join(tempDir, 'target-post-image.json');
  const target = writeCanaryTargetPostImage(targetPath, '{"post":true}');
  assertEqual([
    ['committed', 'durability-unavailable'].includes(target.status),
    target.directoryFsync.capability,
    target.status === 'committed' || typeof target.directoryFsync.errorCode === 'string',
    fs.readFileSync(targetPath, 'utf8')
  ], [
    true,
    target.status === 'committed' ? 'supported' : 'unsupported',
    true,
    '{"post":true}'
  ], 'target post-image uses file+directory durability barrier');

  const provider = createCanarySettlementProvider({ journalDirectory: path.join(tempDir, 'journals') });
  const prepared = provider.prepare({
    sourceKind: 'publisher-journal',
    sourceRef: 'publisher-journal:integration-canary',
    operationKey: input.operationKey,
    taskRunId: 'task-provider-integration',
    conflictScopeKey: 'scope:provider-integration',
    settlementKey: 'settlement.background-execution:canary',
    intentId: null,
    boundedEvidence: evidence
  });
  assertEqual([
    ['committed', 'durability-unavailable'].includes(prepared.durability.status),
    prepared.durability.directoryFsync.capability,
    prepared.durability.status === 'committed' ||
      typeof prepared.durability.directoryFsync.errorCode === 'string'
  ], [
    true,
    prepared.durability.status === 'committed' ? 'supported' : 'unsupported',
    true
  ], 'provider journal reports the real directory durability capability');
  assertEqual((await provider.listOpenSources()).length, 1, 'provider enumerates source without intent/hold');
  assertEqual(durableRecoveryPolicy.production.enabled, false, 'durable canary remains production disabled');
  db.close();

  console.log(
    `[recovery-canary] targetDirectoryFsync=${target.directoryFsync.capability} ` +
    `providerDirectoryFsync=${prepared.durability.directoryFsync.capability}`
  );

  if (failures.length > 0) {
    console.error('FAILURES:', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
  console.log(`==== ${passed}/${passed + failures.length} PASS ====`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
