'use strict';

// v3.2.20 下线业务OP数据核对（BizOP v327）：升级前遗留的 BizOP recovery hold 只读跳过，不阻断启动、不改写记录。
const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ensureArchiveMetadataSupport } = require('../../../../src/backend/database/archive-repository');
const { canonicalSha256 } = require('../../../../src/main-process/background-execution/canonical-json-v1');
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
const { createInspectorRegistry } = require('../../../../src/main-process/background-execution/inspector-registry');
const { transitionRequestKey } = require('../../../../src/main-process/background-execution/recovery-control-contract');
const {
  createSettlementRecoveryProviderRegistry
} = require('../../../../src/main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('../../../../src/main-process/background-execution/startup-recovery-coordinator');
const {
  RETIRED_RECOVERY_ACTION_KEYS,
  isRetiredRecoveryAction,
  withoutRetiredRecoveryRecords
} = require('../../../../src/main-process/background-execution/retired-recovery-actions');
const { CANONICAL_ACTION_KEYS } = require('../../../../src/main-process/background-execution/action-manifest');

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  return db;
}

function createActiveHold(db, input) {
  const reasonCode = 'INSPECTION_UNKNOWN';
  const safeSummary = { reasonCode };
  const transition = {
    entityKind: 'recovery-hold',
    command: 'create-or-get',
    input: { contractVersion: 1, intentId: null, reasonCode, safeSummary,
      evidenceHash: canonicalSha256(safeSummary), ...input }
  };
  const reserved = createRecoveryRequestOwnerRepository(db).reserveTransitionRequest({
    requestKey: transitionRequestKey(transition), transition, safePayload: { reasonCode }
  });
  createRecoveryControlRepository(db).runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(reserved));
}

function coordinatorFor(db, readRepository) {
  const inspectorRegistry = createInspectorRegistry();
  inspectorRegistry.freeze();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  providerRegistry.freeze();
  return createStartupRecoveryCoordinator({
    readRepository,
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    observationAttemptRepository: createRecoveryObservationAttemptRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db),
    resolvePolicy: () => null,
    planTransitions: () => [],
    transientAttempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    sleep: async () => undefined
  });
}

test('已下线 action 清单只含 BizOP v327，且全部不在当前 manifest 中', () => {
  assert.equal(RETIRED_RECOVERY_ACTION_KEYS.length, 12);
  assert.ok(RETIRED_RECOVERY_ACTION_KEYS.every((key) => key.startsWith('biz-op-v327:')));
  assert.deepEqual(RETIRED_RECOVERY_ACTION_KEYS.filter((key) => CANONICAL_ACTION_KEYS.includes(key)), []);
  assert.equal(isRetiredRecoveryAction('biz-op-v327:run-candidate'), true);
  assert.equal(isRetiredRecoveryAction('statement:generate-current'), false);
  assert.equal(isRetiredRecoveryAction(undefined), false);
  assert.throws(() => withoutRetiredRecoveryRecords({}), TypeError);
});

test('遗留 BizOP hold 原样阻断启动扫描；经包装只读跳过后扫描完成，记录不被改写', async () => {
  const db = openDb();
  try {
    createActiveHold(db, {
      holdId: 'hold:bizop-leftover', sourceKind: 'publisher-journal', sourceRef: 'publisher-journal:bizop-leftover',
      actionKey: 'biz-op-v327:run-candidate', operationKey: 'bizop-operation', taskRunId: 'bizop-task',
      conflictScopeKey: 'scope:biz-op-v327'
    });
    createActiveHold(db, {
      holdId: 'hold:manual-retained', sourceKind: 'manual', sourceRef: 'manual:retained',
      actionKey: 'statement:generate-current', operationKey: 'manual-operation', taskRunId: 'manual-task',
      conflictScopeKey: 'scope:manual'
    });
    const raw = createRecoveryControlReadRepository(db);
    const before = raw.listActiveRecoveryHolds().map((hold) => hold.holdId).sort();
    assert.deepEqual(before, ['hold:bizop-leftover', 'hold:manual-retained']);

    await assert.rejects(coordinatorFor(db, raw).scanAndRecover(), { code: 'STARTUP_RECOVERY_HOLD_SOURCE_MISSING' });

    const filtered = withoutRetiredRecoveryRecords(raw);
    assert.equal(Object.isFrozen(filtered), true);
    assert.deepEqual(filtered.listActiveRecoveryHolds().map((hold) => hold.holdId), ['hold:manual-retained']);
    const summary = await coordinatorFor(db, filtered).scanAndRecover();
    assert.equal(summary.sourceCount, 0);
    assert.equal(summary.activeHoldCount, 1);

    assert.deepEqual(raw.listActiveRecoveryHolds().map((hold) => hold.holdId).sort(), before, '已下线记录保留给回退旧版继续恢复');
  } finally {
    db.close();
  }
});
