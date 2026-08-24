'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository,
  ensureArchiveMetadataSupport
} = require('../../../../src/backend/database/archive-repository');
const {
  ensureBackgroundExecutionRecoveryControlSchema
} = require('../../../../src/backend/database/background-execution-schema');
const {
  createActionTaskBindingRegistry
} = require('../../../../src/main-process/background-execution/action-task-binding-registry');
const {
  canonicalSha256,
  parseStrictJson
} = require('../../../../src/main-process/background-execution/canonical-json-v1');
const {
  observationRequestKey,
  observationScopeKey,
  parseTransitionRequest,
  transitionRequestKey
} = require('../../../../src/main-process/background-execution/recovery-control-contract');
const {
  createRecoveryControlReadRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  RecoveryControlError,
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('../../../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createRecoveryTaskLifecycleAdapter
} = require('../../../../src/main-process/background-execution/task-lifecycle-adapter');
const {
  createTaskPolicyRegistry
} = require('../../../../src/main-process/archive-center/task-policy-registry');

const ROOT = path.resolve(__dirname, '../../../..');
const CONTRACT_DIR = path.join(
  ROOT,
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution'
);
const FIXTURE = require(path.join(
  CONTRACT_DIR,
  'validation/fixtures/valid/recovery-control-requests.v1.json'
));

function expectCode(code) {
  return (error) => error && error.code === code;
}

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  return db;
}

function seedTask(db, transition, status, metadata = {}) {
  const archive = createArchiveRepository(db, { now: () => new Date('2026-08-20T00:00:00.000Z') });
  archive.beginTaskRun({
    taskRunId: transition.taskRunId,
    moduleId: 'recovery-test',
    taskKey: transition.expectedTaskKey,
    operationKey: transition.operationKey,
    parentRunId: 'parent-recovery-test'
  });
  db.prepare(`
    UPDATE archive_task_runs
    SET status = ?, metadata_json = ?, updated_at = '2026-08-20T00:00:00.000Z'
    WHERE task_run_id = ?
  `).run(status, JSON.stringify(metadata), transition.taskRunId);
  return archive;
}

function seedBatch(db, transition, baseStatus, overlayState = null) {
  db.prepare(`
    INSERT INTO archive_batches (
      id, batch_number, module_id, module_code, module_name,
      operation_key, local_date, daily_sequence,
      task_key, task_run_id, parent_run_id, task_status,
      created_at, updated_at
    ) VALUES (?, ?, 'recovery-test', 'RCT', 'Recovery Test', ?, '2026-08-23', 1,
              ?, ?, 'parent-recovery-test', ?,
              '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')
  `).run(
    transition.batchId,
    `RCT-20260823-${String(transition.batchId).padStart(3, '0')}`,
    transition.operationKey,
    transition.expectedTaskKey,
    transition.taskRunId,
    baseStatus
  );
  if (overlayState) {
    db.prepare(`
      INSERT INTO background_execution_batch_recovery_states (
        batch_id, task_run_id, state, final_outcome, recovery_attempt_id,
        source_kind, source_ref, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?,
                '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL)
    `).run(
      transition.batchId,
      transition.taskRunId,
      overlayState,
      overlayState === 'recovering' ? transition.recoveryAttemptId : null,
      transition.sourceKind,
      transition.sourceRef
    );
  }
}

function setupTransitionFixture(entry) {
  const db = createDb();
  const transition = entry.request.transition;
  let status = transition.entityKind === 'task-run' ? transition.expectedState : 'running';
  let metadata = {};
  if (transition.entityKind === 'task-run'
      && !['mark-interrupted', 'begin-recovery'].includes(transition.command)) {
    metadata = { recoveryMode: true, recoveryAttemptId: transition.recoveryAttemptId };
  }
  seedTask(db, transition, status, metadata);
  if (transition.entityKind === 'batch-overlay') {
    seedBatch(
      db,
      transition,
      transition.command === 'mark-interrupted' ? 'running' : 'failed',
      transition.command === 'mark-interrupted'
        ? null
        : transition.command === 'begin-recovery'
          ? 'interrupted'
          : 'recovering'
    );
  }
  return db;
}

function reserveFixtureTransition(db, entry) {
  const event = entry.request.event;
  return createRecoveryRequestOwnerRepository(db, {
    now: () => new Date(event.createdAt),
    createEventId: () => event.eventId
  }).reserveTransitionRequest({
    requestKey: entry.requestKey,
    transition: entry.request.transition,
    safePayload: event.safePayload
  });
}

function assertTransitionPostImage(db, transition) {
  if (transition.entityKind === 'task-run') {
    const row = db.prepare(`
      SELECT status, failure_code AS failureCode, failure_message AS failureMessage,
             metadata_json AS metadataJson
      FROM archive_task_runs WHERE task_run_id = ?
    `).get(transition.taskRunId);
    const expectedStatus = transition.command === 'mark-interrupted'
      || transition.command === 'interrupt-recovery'
      ? 'interrupted'
      : transition.command === 'begin-recovery'
        ? 'running'
        : transition.command === 'complete-recovery-success'
          ? 'succeeded'
          : 'failed';
    assert.equal(row.status, expectedStatus);
    assert.equal(row.failureCode, transition.failureCode ?? null);
    assert.equal(row.failureMessage, transition.failureMessage ?? null);
    const metadata = JSON.parse(row.metadataJson);
    for (const [key, value] of Object.entries(transition.metadataPatch)) {
      assert.deepEqual(metadata[key], value);
    }
    if (transition.command === 'interrupt-recovery') {
      assert.equal(metadata.recoveryMode, false);
      assert.equal(metadata.recoveryAttemptId, null);
    } else if (transition.command !== 'mark-interrupted') {
      assert.equal(metadata.recoveryMode, true);
      assert.equal(metadata.recoveryAttemptId, transition.recoveryAttemptId);
    }
    return;
  }

  const batch = db.prepare(`SELECT task_status AS status FROM archive_batches WHERE id = ?`)
    .get(transition.batchId);
  const overlay = db.prepare(`
    SELECT state, final_outcome AS finalOutcome,
           recovery_attempt_id AS recoveryAttemptId,
           source_kind AS sourceKind, source_ref AS sourceRef
    FROM background_execution_batch_recovery_states
    WHERE batch_id = ? AND task_run_id = ?
  `).get(transition.batchId, transition.taskRunId);
  assert.equal(batch.status, 'failed');
  assert.equal(
    overlay.state,
    transition.command === 'mark-interrupted'
      ? 'interrupted'
      : transition.command === 'begin-recovery'
        ? 'recovering'
        : 'resolved'
  );
  assert.equal(overlay.finalOutcome, transition.finalOutcome ?? null);
  assert.equal(overlay.recoveryAttemptId, transition.recoveryAttemptId ?? null);
  assert.equal(overlay.sourceKind, transition.sourceKind);
  assert.equal(overlay.sourceRef, transition.sourceRef);
}

function observationScope(event) {
  return {
    eventType: event.eventType,
    actionKey: event.actionKey,
    operationKey: event.operationKey,
    taskRunId: event.taskRunId,
    sourceKind: event.sourceKind,
    sourceRef: event.sourceRef,
    batchId: event.batchId ?? null,
    intentId: event.intentId ?? null,
    holdId: event.holdId ?? null,
    recoveryAttemptId: event.recoveryAttemptId ?? null
  };
}

test('runtime RecoveryControl Schema 与冻结 authority 逐字节一致，request/result KAT digest 固定', () => {
  const runtime = fs.readFileSync(path.join(
    ROOT,
    'src/main-process/background-execution/schemas/platform-recovery-control-v1.schema.json'
  ));
  const authority = fs.readFileSync(path.join(CONTRACT_DIR, 'platform-recovery-control-v1.schema.json'));
  assert.deepEqual(runtime, authority);
  assert.equal(
    canonicalSha256(FIXTURE.resultProjectionKnownAnswers),
    FIXTURE.resultProjectionKnownAnswerContract.sha256
  );
  for (const entry of FIXTURE.transitionRequests.slice(0, 9)) {
    assert.equal(transitionRequestKey(entry.request.transition), entry.requestKey, entry.name);
  }
  for (const entry of FIXTURE.observationRequests) {
    assert.equal(observationRequestKey(entry.request.event), entry.requestKey, entry.name);
  }
});

test('C1 migration 幂等且外键完整；RecoveryControlReadRepository 构造保持纯只读', () => {
  const bare = new DatabaseSync(':memory:');
  const read = createRecoveryControlReadRepository(bare);
  assert.deepEqual(Object.keys(read), [
    'getCriticalIntentById',
    'getCriticalIntentByOperation',
    'listOpenCriticalIntents',
    'listCriticalIntentsByScope',
    'getRecoveryHoldBySource',
    'getActiveRecoveryHoldByScope',
    'listActiveRecoveryHolds',
    'getEffectiveBatchStatus',
    'listRecoveryEvents'
  ]);
  assert.equal(
    bare.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'background_execution_recovery_%'`).get().n,
    0
  );
  bare.close();

  const db = createDb();
  ensureBackgroundExecutionRecoveryControlSchema(db);
  ensureBackgroundExecutionRecoveryControlSchema(db);
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name));
  assert.equal(tables.has('background_execution_batch_recovery_states'), true);
  assert.equal(tables.has('background_execution_recovery_observation_attempts'), true);
  assert.equal(tables.has('background_execution_recovery_request_owners'), true);
  assert.equal(tables.has('background_execution_recovery_events'), true);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('9 个 E02-C1 Task/Batch transition 经真实 DDL/CAS/event SELECT 匹配独立 20-field KAT', async (t) => {
  for (const entry of FIXTURE.transitionRequests.slice(0, 9)) {
    await t.test(entry.name, () => {
      const db = setupTransitionFixture(entry);
      const reserved = reserveFixtureTransition(db, entry);
      const committedAt = '2026-08-24T12:00:00.000Z';
      const result = createRecoveryControlRepository(db, {
        now: () => new Date(committedAt)
      }).runInControlTransaction(
        (tx) => tx.transitionWithRecoveryEvent(reserved)
      );
      const known = FIXTURE.resultProjectionKnownAnswers.find(
        (candidate) => candidate.requestName === entry.name
      );
      assert.deepEqual(result, known.projection);
      assert.equal(Object.isFrozen(result), true);
      assertTransitionPostImage(db, entry.request.transition);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 1);
      assert.deepEqual(
        { ...db.prepare(`SELECT status, created_at AS createdAt, committed_at AS committedAt
                         FROM background_execution_recovery_request_owners`).get() },
        { status: 'committed', createdAt: entry.request.event.createdAt, committedAt }
      );
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      db.close();
    });
  }
});

test('4 个 observation branch 持久 ordinal/owner/event 且匹配独立 20-field KAT', async (t) => {
  for (const entry of FIXTURE.observationRequests) {
    await t.test(entry.name, () => {
      const db = createDb();
      const event = entry.request.event;
      const scope = observationScope(event);
      const attemptRepository = createRecoveryObservationAttemptRepository(db, {
        now: () => new Date('2026-08-23T00:00:10.000Z')
      });
      const attempt = attemptRepository.allocateNextObservationAttempt(scope);
      assert.equal(attempt.observationAttemptId, event.observationAttemptId);
      assert.equal(attempt.observationScopeKey, observationScopeKey(scope));
      assert.deepEqual(
        attemptRepository.resumePreparedObservationAttempt(attempt.observationScopeKey),
        attempt
      );
      const draft = { ...event };
      delete draft.eventId;
      delete draft.createdAt;
      const reserved = createRecoveryRequestOwnerRepository(db, {
        now: () => new Date(event.createdAt),
        createEventId: () => event.eventId
      }).reserveObservationRequest({
        requestKey: entry.requestKey,
        observationScopeKey: attempt.observationScopeKey,
        event: draft
      });
      const result = createRecoveryControlRepository(db).runInControlTransaction(
        (tx) => tx.appendObservationEvent(reserved)
      );
      const known = FIXTURE.resultProjectionKnownAnswers.find(
        (candidate) => candidate.requestName === entry.name
      );
      assert.deepEqual(result, known.projection);
      assert.equal(attemptRepository.resumePreparedObservationAttempt(attempt.observationScopeKey), null);
      db.close();
    });
  }
});

test('lookup-before-CAS：A→B→restart→replay A 返回首次 A，不二次 CAS/event；changed A 冲突', () => {
  const [markEntry, beginEntry] = FIXTURE.transitionRequests;
  const db = setupTransitionFixture(markEntry);
  const markRequest = reserveFixtureTransition(db, markEntry);
  const firstControl = createRecoveryControlRepository(db);
  const projectionA = firstControl.runInControlTransaction(
    (tx) => tx.transitionWithRecoveryEvent(markRequest)
  );
  const beginRequest = reserveFixtureTransition(db, beginEntry);
  firstControl.runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(beginRequest));
  assert.equal(db.prepare(`SELECT status FROM archive_task_runs WHERE task_run_id = ?`).get('task-run-1').status, 'running');

  const restarted = createRecoveryControlRepository(db);
  assert.deepEqual(
    restarted.runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(markRequest)),
    projectionA
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 2);
  assert.equal(db.prepare(`SELECT status FROM archive_task_runs WHERE task_run_id = ?`).get('task-run-1').status, 'running');

  assert.throws(() => createRecoveryRequestOwnerRepository(db, {
    now: () => new Date(markEntry.request.event.createdAt),
    createEventId: () => markEntry.request.event.eventId
  }).reserveTransitionRequest({
    requestKey: markEntry.requestKey,
    transition: markEntry.request.transition,
    safePayload: { reason: 'changed' }
  }), expectCode('RECOVERY_REQUEST_KEY_CONFLICT'));
  db.close();
});

test('不同 durable requestKey 复用同一 eventId fail closed，且不留下第二个 owner', () => {
  const [markEntry, beginEntry] = FIXTURE.transitionRequests;
  const db = createDb();
  const sharedEventId = markEntry.request.event.eventId;
  const owner = createRecoveryRequestOwnerRepository(db, {
    now: () => new Date(markEntry.request.event.createdAt),
    createEventId: () => sharedEventId
  });
  owner.reserveTransitionRequest({
    requestKey: markEntry.requestKey,
    transition: markEntry.request.transition,
    safePayload: markEntry.request.event.safePayload
  });
  assert.throws(() => owner.reserveTransitionRequest({
    requestKey: beginEntry.requestKey,
    transition: beginEntry.request.transition,
    safePayload: beginEntry.request.event.safePayload
  }), expectCode('RECOVERY_EVENT_ID_CONFLICT'));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_request_owners').get().n,
    1
  );
  db.close();
});

test('同一 control transaction 第二个 Batch identity/CAS 失败时 Task、overlay、events 整体回滚', () => {
  const taskEntry = FIXTURE.transitionRequests[0];
  const batchEntry = FIXTURE.transitionRequests[5];
  const db = setupTransitionFixture(taskEntry);
  const batchTransition = { ...batchEntry.request.transition, batchId: 999 };
  const taskRequest = reserveFixtureTransition(db, taskEntry);
  const owner = createRecoveryRequestOwnerRepository(db, {
    now: () => new Date(batchEntry.request.event.createdAt),
    createEventId: () => batchEntry.request.event.eventId
  });
  const batchRequest = owner.reserveTransitionRequest({
    requestKey: transitionRequestKey(batchTransition),
    transition: batchTransition,
    safePayload: batchEntry.request.event.safePayload
  });
  let firstError;
  assert.throws(() => createRecoveryControlRepository(db).runInControlTransaction((tx) => {
    tx.transitionWithRecoveryEvent(taskRequest);
    try {
      tx.transitionWithRecoveryEvent(batchRequest);
    } catch (error) {
      firstError = error;
    }
    assert.throws(
      () => tx.transitionWithRecoveryEvent(taskRequest),
      expectCode('RECOVERY_CONTROL_TRANSACTION_POISONED')
    );
    return 'callback-caught-first-error';
  }), (error) => error === firstError && expectCode('RECOVERY_BATCH_IDENTITY_CONFLICT')(error));
  assert.equal(db.prepare(`SELECT status FROM archive_task_runs WHERE task_run_id = 'task-run-1'`).get().status, 'running');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_batch_recovery_states').get().n, 0);
  assert.deepEqual(
    db.prepare(`SELECT status FROM background_execution_recovery_request_owners ORDER BY id`)
      .all().map((row) => row.status),
    ['prepared', 'prepared']
  );
  db.close();
});

test('callback 吞掉 event INSERT/owner commit scoped error 仍 poison 并回滚 Task/event/owner', async (t) => {
  for (const injection of [
    {
      name: 'event-insert',
      sql: `
        CREATE TEMP TRIGGER fail_recovery_event_insert
        BEFORE INSERT ON background_execution_recovery_events
        BEGIN SELECT RAISE(ABORT, 'injected event insert failure'); END;
      `,
      pattern: /injected event insert failure/
    },
    {
      name: 'owner-commit',
      sql: `
        CREATE TEMP TRIGGER fail_recovery_owner_commit
        BEFORE UPDATE OF status ON background_execution_recovery_request_owners
        WHEN NEW.status = 'committed'
        BEGIN SELECT RAISE(ABORT, 'injected owner commit failure'); END;
      `,
      pattern: /injected owner commit failure/
    }
  ]) {
    await t.test(injection.name, () => {
      const entry = FIXTURE.transitionRequests[0];
      const db = setupTransitionFixture(entry);
      const reserved = reserveFixtureTransition(db, entry);
      db.exec(injection.sql);
      let firstError;
      assert.throws(() => createRecoveryControlRepository(db).runInControlTransaction((tx) => {
        try {
          tx.transitionWithRecoveryEvent(reserved);
        } catch (error) {
          firstError = error;
        }
        assert.throws(
          () => tx.transitionWithRecoveryEvent(reserved),
          expectCode('RECOVERY_CONTROL_TRANSACTION_POISONED')
        );
        return 'caught';
      }), (error) => error === firstError && injection.pattern.test(error.message));
      assert.equal(
        db.prepare(`SELECT status FROM archive_task_runs WHERE task_run_id = ?`)
          .get(entry.request.transition.taskRunId).status,
        'running'
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 0);
      assert.equal(
        db.prepare('SELECT status FROM background_execution_recovery_request_owners').get().status,
        'prepared'
      );
      db.close();
    });
  }
});

test('observation event/owner/attempt 任一步失败整体回滚，下一 ordinal 仅在前次 committed 后分配', () => {
  const entry = FIXTURE.observationRequests[1];
  const event = entry.request.event;
  const db = createDb();
  const attempts = createRecoveryObservationAttemptRepository(db);
  const scope = observationScope(event);
  const attempt = attempts.allocateNextObservationAttempt(scope);
  assert.throws(() => attempts.allocateNextObservationAttempt(scope), expectCode('RECOVERY_OBSERVATION_ATTEMPT_PENDING'));
  const draft = { ...event };
  delete draft.eventId;
  delete draft.createdAt;
  const reserved = createRecoveryRequestOwnerRepository(db, {
    now: () => new Date(event.createdAt),
    createEventId: () => event.eventId
  }).reserveObservationRequest({
    requestKey: entry.requestKey,
    observationScopeKey: attempt.observationScopeKey,
    event: draft
  });
  db.exec(`
    CREATE TEMP TRIGGER fail_observation_attempt_commit
    BEFORE UPDATE OF status ON background_execution_recovery_observation_attempts
    WHEN NEW.status = 'committed'
    BEGIN SELECT RAISE(ABORT, 'injected attempt failure'); END;
  `);
  let firstError;
  assert.throws(() => createRecoveryControlRepository(db).runInControlTransaction((tx) => {
    try {
      tx.appendObservationEvent(reserved);
    } catch (error) {
      firstError = error;
    }
    assert.throws(
      () => tx.appendObservationEvent(reserved),
      expectCode('RECOVERY_CONTROL_TRANSACTION_POISONED')
    );
    return 'callback-caught-attempt-commit';
  }), (error) => error === firstError && /injected attempt failure/.test(error.message));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 0);
  assert.equal(db.prepare(`SELECT status FROM background_execution_recovery_request_owners`).get().status, 'prepared');
  assert.equal(db.prepare(`SELECT status FROM background_execution_recovery_observation_attempts`).get().status, 'prepared');
  db.exec('DROP TRIGGER fail_observation_attempt_commit');
  createRecoveryControlRepository(db).runInControlTransaction((tx) => tx.appendObservationEvent(reserved));
  assert.equal(attempts.allocateNextObservationAttempt(scope).observationAttemptId, 2);
  db.close();
});

test('attempt1 interrupt 清 active metadata，重启后 attempt2 可开始且旧 event lineage 不变', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-attempt-restart-'));
  const dbPath = path.join(tempDir, 'control.sqlite');
  let db;
  const base = {
    entityKind: 'task-run',
    actionKey: 'statement:import',
    expectedTaskKey: 'file:import',
    operationKey: 'restart-attempt-operation',
    taskRunId: 'restart-attempt-task',
    sourceKind: 'module-recovery',
    sourceRef: 'restart-attempt-source'
  };
  const mark = {
    ...base,
    command: 'mark-interrupted',
    expectedState: 'running',
    failureCode: 'TRANSPORT_LOST',
    failureMessage: 'transport lost',
    metadataPatch: {}
  };
  const begin1 = {
    ...base,
    command: 'begin-recovery',
    expectedState: 'interrupted',
    recoveryAttemptId: 'restart-attempt-1',
    metadataPatch: { attempt: 1 }
  };
  const interrupt1 = {
    ...base,
    command: 'interrupt-recovery',
    expectedState: 'running',
    recoveryAttemptId: 'restart-attempt-1',
    failureCode: 'RECOVERY_INTERRUPTED',
    failureMessage: 'recovery interrupted',
    metadataPatch: { interruptedAttempt: 1 }
  };
  const begin2 = {
    ...base,
    command: 'begin-recovery',
    expectedState: 'interrupted',
    recoveryAttemptId: 'restart-attempt-2',
    metadataPatch: { attempt: 2 }
  };
  const reserve = (transition, safePayload = {}) => (
    createRecoveryRequestOwnerRepository(db).reserveTransitionRequest({
      requestKey: transitionRequestKey(transition),
      transition,
      safePayload
    })
  );
  const apply = (reserved) => createRecoveryControlRepository(db)
    .runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(reserved));
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    ensureArchiveMetadataSupport(db);
    seedTask(db, base, 'running');
    apply(reserve(mark, { phase: 'mark' }));
    apply(reserve(begin1, { phase: 'begin-1' }));

    const bypass = {
      ...mark,
      sourceRef: 'active-recovery-normal-mark-bypass',
      failureCode: 'NORMAL_MARK_FORBIDDEN'
    };
    assert.throws(
      () => apply(reserve(bypass, { phase: 'forbidden-bypass' })),
      expectCode('RECOVERY_TASK_ATTEMPT_CONFLICT')
    );
    const interruptRequest = reserve(interrupt1, { phase: 'interrupt-1' });
    const interruptResult = apply(interruptRequest);
    assert.equal(interruptResult.recoveryAttemptId, 'restart-attempt-1');
    assert.deepEqual(
      JSON.parse(db.prepare(`SELECT metadata_json FROM archive_task_runs WHERE task_run_id = ?`)
        .get(base.taskRunId).metadata_json),
      {
        attempt: 1,
        interruptedAttempt: 1,
        recoveryAttemptId: null,
        recoveryMode: false
      }
    );
    db.close();
    db = null;

    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    ensureArchiveMetadataSupport(db);
    apply(reserve(begin2, { phase: 'begin-2' }));
    assert.deepEqual(
      JSON.parse(db.prepare(`SELECT metadata_json FROM archive_task_runs WHERE task_run_id = ?`)
        .get(base.taskRunId).metadata_json),
      {
        attempt: 2,
        interruptedAttempt: 1,
        recoveryAttemptId: 'restart-attempt-2',
        recoveryMode: true
      }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT event_type AS eventType, recovery_attempt_id AS recoveryAttemptId
        FROM background_execution_recovery_events
        ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        { eventType: 'interrupted-recorded', recoveryAttemptId: null },
        { eventType: 'recovery-started', recoveryAttemptId: 'restart-attempt-1' },
        { eventType: 'recovery-interrupted', recoveryAttemptId: 'restart-attempt-1' },
        { eventType: 'recovery-started', recoveryAttemptId: 'restart-attempt-2' }
      ]
    );
    assert.deepEqual(
      db.prepare(`SELECT status, COUNT(*) AS n
                  FROM background_execution_recovery_request_owners
                  GROUP BY status ORDER BY status`).all().map((row) => ({ ...row })),
      [
        { status: 'committed', n: 4 },
        { status: 'prepared', n: 1 }
      ]
    );
    const replay = createRecoveryControlRepository(db).runInControlTransaction(
      (tx) => tx.transitionWithRecoveryEvent(interruptRequest)
    );
    assert.deepEqual(replay, interruptResult);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 4);
  } finally {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Batch Option B 保留基础 failed interruption 历史，effective overlay 独立推进到 succeeded', () => {
  const entries = FIXTURE.transitionRequests.slice(5, 8);
  const db = setupTransitionFixture(entries[0]);
  const control = createRecoveryControlRepository(db);
  for (const entry of entries) {
    const request = reserveFixtureTransition(db, entry);
    control.runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(request));
  }
  const read = createRecoveryControlReadRepository(db);
  assert.equal(db.prepare('SELECT task_status FROM archive_batches WHERE id = 7').get().task_status, 'failed');
  assert.equal(read.getEffectiveBatchStatus(7, 'task-run-1'), 'succeeded');
  assert.deepEqual({ ...db.prepare(`
    SELECT batch_id AS batchId, task_run_id AS taskRunId, state,
           final_outcome AS finalOutcome, recovery_attempt_id AS recoveryAttemptId,
           source_kind AS sourceKind, source_ref AS sourceRef,
           created_at AS createdAt, updated_at AS updatedAt, resolved_at AS resolvedAt
    FROM background_execution_batch_recovery_states
    WHERE batch_id = 7 AND task_run_id = 'task-run-1'
  `).get() }, {
    batchId: 7,
    taskRunId: 'task-run-1',
    state: 'resolved',
    finalOutcome: 'succeeded',
    recoveryAttemptId: 'attempt-1',
    sourceKind: 'module-recovery',
    sourceRef: 'source-1',
    createdAt: '2026-08-23T00:00:05.000Z',
    updatedAt: '2026-08-23T00:00:07.000Z',
    resolvedAt: '2026-08-23T00:00:07.000Z'
  });
  const events = read.listRecoveryEvents('task-run-1');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((item) => item.eventType), Array(3).fill('batch-overlay-transitioned'));
  assert.deepEqual(events.map((item) => item.sequenceId), [1, 2, 3]);
  db.close();
});

test('raw request 在 JSON.parse 前拒绝 nested duplicate key/unsafe integer，Schema 拒绝 alias/unknown key', () => {
  assert.throws(
    () => parseStrictJson('{"outer":{"same":1,"same":2}}'),
    expectCode('CANONICAL_JSON_DUPLICATE_KEY')
  );
  assert.throws(
    () => parseStrictJson('{"value":9007199254740992}'),
    expectCode('CANONICAL_JSON_INTEGER_UNSAFE')
  );
  const valid = FIXTURE.transitionRequests[0].request;
  assert.throws(
    () => parseTransitionRequest(JSON.stringify({ ...valid, requestHash: '0'.repeat(64) })),
    expectCode('RECOVERY_TRANSITION_REQUEST_INVALID')
  );
  assert.throws(
    () => parseTransitionRequest(JSON.stringify({
      ...valid,
      transition: { ...valid.transition, unexpected: true }
    })),
    expectCode('RECOVERY_TRANSITION_REQUEST_INVALID')
  );
});

test('C2 semantic guard 在 owner/hash 前拒绝 Hold source/intent 与 Intent 状态语义漂移', () => {
  const fixture = FIXTURE.transitionRequests.slice(9, 16);
  const recovered = structuredClone(fixture.find((entry) => entry.name === 'intent-mark-recovered').request.transition);
  recovered.inspection.outcome = 'committed';
  assert.throws(() => transitionRequestKey(recovered), expectCode('RECOVERY_INTENT_COMMITTED_CANNOT_RECOVER'));

  const hold = structuredClone(fixture.find((entry) => entry.name === 'hold-create-or-get').request.transition);
  hold.input.sourceKind = 'critical-intent';
  hold.input.intentId = null;
  assert.throws(() => transitionRequestKey(hold), expectCode('RECOVERY_HOLD_SOURCE_INTENT_MISMATCH'));
});

test('7 个 E02-C2 Intent/Hold transition 经真实 DDL/CAS/event SELECT 匹配独立 20-field KAT', async (t) => {
  for (const entry of FIXTURE.transitionRequests.slice(9, 16)) {
    await t.test(entry.name, () => {
      const db = createDb();
      ensureBackgroundExecutionRecoveryControlSchema(db);
      const transition = entry.request.transition;
      if (transition.entityKind === 'critical-intent' && transition.command !== 'create-prepared') {
        db.prepare(`
          INSERT INTO background_execution_critical_intents (
            contract_version, intent_id, action_key, operation_key, task_run_id,
            job_id, coordination_kind, state, conflict_scope_key, inspector_key,
            evidence_version, evidence_json, evidence_sha256,
            receipt_ref_json, result_json, created_at, updated_at,
            closed_at, retention_until
          ) VALUES (
            1, ?, 'statement:generate-all', 'operation-1', 'task-run-1',
            'job-1', 'main-owned-settlement', ?, 'scope-1',
            'inspector.statement:generate-all', 1, '{}',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            NULL, NULL, '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:00.000Z', NULL, NULL
          )
        `).run(transition.intentId, transition.expectedState);
      }
      if (transition.entityKind === 'recovery-hold' && transition.command === 'resolve') {
        db.prepare(`
          INSERT INTO background_execution_recovery_holds (
            hold_id, source_kind, source_ref, intent_id, action_key,
            operation_key, task_run_id, conflict_scope_key, reason_code,
            status, resolution, safe_summary_json,
            created_at, updated_at, resolved_at
          ) VALUES (
            ?, 'module-recovery', 'source-1', NULL, 'statement:generate-all',
            'operation-1', 'task-run-1', 'scope-1', 'INSPECTOR_UNAVAILABLE',
            'active', NULL, '{}',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          )
        `).run(transition.holdId);
      }
      const reserved = createRecoveryRequestOwnerRepository(db, {
        now: () => new Date(entry.request.event.createdAt),
        createEventId: () => entry.request.event.eventId
      }).reserveTransitionRequest({
        requestKey: entry.requestKey,
        transition,
        safePayload: entry.request.event.safePayload
      });
      const result = createRecoveryControlRepository(db, {
        now: () => new Date('2026-08-24T12:00:00.000Z')
      }).runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(reserved));
      const known = FIXTURE.resultProjectionKnownAnswers.find(
        (candidate) => candidate.requestName === entry.name
      );
      assert.deepEqual(result, known.projection);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 1);
      const replay = createRecoveryControlRepository(db).runInControlTransaction(
        (tx) => tx.transitionWithRecoveryEvent(reserved)
      );
      assert.deepEqual(replay, result);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 1);
      db.close();
    });
  }
});

test('唯一 writer API 无顶层 mutation，拒绝 async/nested callback 并关闭泄漏 tx object', () => {
  const db = createDb();
  const control = createRecoveryControlRepository(db);
  assert.deepEqual(Object.keys(control), ['runInControlTransaction']);
  assert.throws(
    () => control.runInControlTransaction(async () => undefined),
    expectCode('RECOVERY_CONTROL_ASYNC_TRANSACTION_FORBIDDEN')
  );
  assert.equal(db.isTransaction, false);
  assert.throws(
    () => control.runInControlTransaction(() => control.runInControlTransaction(() => null)),
    expectCode('RECOVERY_CONTROL_TRANSACTION_NESTED')
  );
  let leaked;
  control.runInControlTransaction((tx) => { leaked = tx; });
  assert.throws(() => leaked.appendObservationEvent({}), expectCode('RECOVERY_CONTROL_TRANSACTION_CLOSED'));
  db.close();
});

test('TaskLifecycle adapter 消费生产 ActionTaskBindingRegistry，合法 pair 写入、mismatch 在 owner/CAS 前拒绝', () => {
  const db = createDb();
  const transition = {
    taskRunId: 'adapter-task',
    expectedTaskKey: 'file:import',
    operationKey: 'adapter-operation'
  };
  seedTask(db, transition, 'running');
  const taskPolicies = createTaskPolicyRegistry();
  const binding = createActionTaskBindingRegistry({
    taskPolicyRegistry: Object.freeze({ list: taskPolicies.list.bind(taskPolicies) })
  });
  const adapter = createRecoveryTaskLifecycleAdapter({
    actionTaskBindingRegistry: binding,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db)
  });
  const result = adapter.settleInterrupted({
    actionKey: 'statement:import',
    expectedTaskKey: 'file:import',
    operationKey: 'adapter-operation',
    taskRunId: 'adapter-task',
    sourceKind: 'module-recovery',
    sourceRef: 'adapter-source',
    expectedState: 'running',
    failureCode: 'TRANSPORT_LOST',
    failureMessage: 'transport lost',
    metadataPatch: {},
    safePayload: {}
  });
  assert.equal(result.actionKey, 'statement:import');
  const ownerCount = db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_request_owners').get().n;
  assert.throws(() => adapter.beginRecovery({
    actionKey: 'statement:import',
    expectedTaskKey: 'monthly-balance:export',
    operationKey: 'adapter-operation',
    taskRunId: 'adapter-task',
    sourceKind: 'module-recovery',
    sourceRef: 'adapter-source',
    recoveryAttemptId: 'adapter-attempt',
    metadataPatch: {},
    safePayload: {}
  }), expectCode('ACTION_TASK_BINDING_PAIR_REJECTED'));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_request_owners').get().n,
    ownerCount
  );
  db.close();
});

test('ArchiveRepository normal owner 与 legacy recovery 路径保持兼容', () => {
  const db = createDb();
  const archive = createArchiveRepository(db, { now: () => new Date('2026-08-24T00:00:00.000Z') });
  archive.beginTaskRun({
    taskRunId: 'legacy-task',
    moduleId: 'legacy',
    taskKey: 'legacy:task',
    operationKey: 'legacy-operation',
    parentRunId: 'legacy-parent'
  });
  assert.equal(archive.transitionTaskRun('legacy-task', 'running').status, 'updated');
  assert.equal(archive.transitionTaskRun('legacy-task', 'interrupted').status, 'updated');
  assert.equal(archive.transitionTaskRun('legacy-task', 'running', { recovery: true }).status, 'updated');
  assert.equal(archive.transitionTaskRun('legacy-task', 'failed').status, 'updated');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM background_execution_recovery_events').get().n, 0);
  db.close();
});
