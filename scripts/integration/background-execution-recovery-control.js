// Background Execution RecoveryControl C1 持久化集成测试
//   覆盖：真实文件 SQLite 重启、Task/Batch 同事务、owner/event replay、
//   Option B effective status、canonical/legacy binding 与失败整体回滚。
//
// 用法：node scripts/integration/background-execution-recovery-control.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository,
  ensureArchiveMetadataSupport
} = require('../../src/backend/database/archive-repository');
const {
  createActionTaskBindingRegistry
} = require('../../src/main-process/background-execution/action-task-binding-registry');
const {
  createRecoveryControlReadRepository
} = require('../../src/main-process/background-execution/critical/recovery-control-read-repository');
const {
  createRecoveryControlRepository
} = require('../../src/main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryRequestOwnerRepository
} = require('../../src/main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createRecoveryTransitionAdapter
} = require('../../src/main-process/background-execution/task-lifecycle-adapter');
const {
  createTaskPolicyRegistry
} = require('../../src/main-process/archive-center/task-policy-registry');

let passed = 0;
let failed = 0;
const failures = [];

function check(condition, label, details = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, details });
}

function equal(actual, expected, label) {
  check(Object.is(actual, expected), label, `actual=${actual} expected=${expected}`);
}

function openDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureArchiveMetadataSupport(db);
  return db;
}

function productionBinding() {
  const taskPolicyRegistry = createTaskPolicyRegistry();
  return createActionTaskBindingRegistry({
    taskPolicyRegistry: Object.freeze({ list: taskPolicyRegistry.list.bind(taskPolicyRegistry) })
  });
}

function adapter(db, binding) {
  return createRecoveryTransitionAdapter({
    actionTaskBindingRegistry: binding,
    requestOwnerRepository: createRecoveryRequestOwnerRepository(db),
    recoveryControlRepository: createRecoveryControlRepository(db)
  });
}

function taskTransition(command, additions = {}) {
  return {
    entityKind: 'task-run',
    command,
    actionKey: 'statement:import',
    expectedTaskKey: 'file:import',
    operationKey: 'integration-operation',
    taskRunId: 'integration-task',
    sourceKind: 'module-recovery',
    sourceRef: 'integration-source',
    ...additions
  };
}

function batchTransition(command, additions = {}) {
  return {
    entityKind: 'batch-overlay',
    command,
    actionKey: 'statement:import',
    expectedTaskKey: 'file:import',
    operationKey: 'integration-operation',
    batchId: 1,
    taskRunId: 'integration-task',
    sourceKind: 'module-recovery',
    sourceRef: 'integration-source',
    ...additions
  };
}

function seed(db) {
  const archive = createArchiveRepository(db, { now: () => new Date('2026-08-24T00:00:00.000Z') });
  archive.beginTaskRun({
    taskRunId: 'integration-task',
    moduleId: 'integration',
    taskKey: 'file:import',
    operationKey: 'integration-operation',
    parentRunId: 'integration-parent'
  });
  archive.transitionTaskRun('integration-task', 'running');
  db.prepare(`
    INSERT INTO archive_batches (
      id, batch_number, module_id, module_code, module_name,
      operation_key, local_date, daily_sequence,
      task_key, task_run_id, parent_run_id, task_status,
      created_at, updated_at
    ) VALUES (
      1, 'RCT-20260824-001', 'integration', 'RCT', 'Recovery Integration',
      'integration-operation', '2026-08-24', 1,
      'file:import', 'integration-task', 'integration-parent', 'running',
      '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
    )
  `).run();
}

function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-control-integration-'));
  const dbPath = path.join(tempDir, 'control.sqlite');
  const binding = productionBinding();
  let db;
  try {
    db = openDatabase(dbPath);
    seed(db);
    const first = adapter(db, binding);
    const interruptedItems = [
      {
        transition: taskTransition('mark-interrupted', {
          expectedState: 'running',
          failureCode: 'TRANSPORT_LOST',
          failureMessage: 'transport lost',
          metadataPatch: { integration: true }
        }),
        safePayload: { phase: 'interrupted' }
      },
      {
        transition: batchTransition('mark-interrupted', {
          expectedState: null,
          failureCode: 'TRANSPORT_LOST',
          failureMessage: 'transport lost'
        }),
        safePayload: { phase: 'interrupted' }
      }
    ];
    const firstResults = first.transitionMany(interruptedItems);
    equal(firstResults.length, 2, 'Task+Batch interruption 同事务返回两个 event');
    equal(db.prepare(`SELECT status FROM archive_task_runs`).get().status, 'interrupted', 'Task 持久 interrupted');
    equal(db.prepare(`SELECT task_status FROM archive_batches`).get().task_status, 'failed', 'Batch 基础兼容 failed');
    equal(createRecoveryControlReadRepository(db).getEffectiveBatchStatus(1, 'integration-task'), 'interrupted', 'overlay effective interrupted');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 2, '首次写入两条 append-only event');
    db.close();
    db = null;

    db = openDatabase(dbPath);
    const restarted = adapter(db, binding);
    const replay = restarted.transitionMany(interruptedItems);
    equal(replay[0].eventId, firstResults[0].eventId, '重启 replay 复用 Task eventId');
    equal(replay[1].eventId, firstResults[1].eventId, '重启 replay 复用 Batch eventId');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 2, 'replay 不增加 event');
    equal(db.prepare(`SELECT status FROM archive_task_runs`).get().status, 'interrupted', 'replay 不二次 CAS');

    let conflictCode = '';
    try {
      restarted.transition(interruptedItems[0].transition, { phase: 'changed' });
    } catch (error) {
      conflictCode = error && error.code;
    }
    equal(conflictCode, 'RECOVERY_REQUEST_KEY_CONFLICT', '同 durable key changed request fail closed');

    const recoveryAttemptId = 'integration-attempt-1';
    restarted.transitionMany([
      {
        transition: taskTransition('begin-recovery', {
          expectedState: 'interrupted',
          recoveryAttemptId,
          metadataPatch: { recovery: 'integration' }
        }),
        safePayload: { phase: 'recovering' }
      },
      {
        transition: batchTransition('begin-recovery', {
          expectedState: 'interrupted',
          recoveryAttemptId
        }),
        safePayload: { phase: 'recovering' }
      }
    ]);
    equal(db.prepare(`SELECT status FROM archive_task_runs`).get().status, 'running', 'Task 进入 running(recovery)');
    equal(createRecoveryControlReadRepository(db).getEffectiveBatchStatus(1, 'integration-task'), 'recovering', 'Batch effective recovering');

    restarted.transitionMany([
      {
        transition: taskTransition('complete-recovery-success', {
          expectedState: 'running',
          recoveryAttemptId,
          metadataPatch: { recovered: true }
        }),
        safePayload: { phase: 'resolved' }
      },
      {
        transition: batchTransition('resolve-success', {
          expectedState: 'recovering',
          recoveryAttemptId,
          finalOutcome: 'succeeded'
        }),
        safePayload: { phase: 'resolved' }
      }
    ]);
    equal(db.prepare(`SELECT status FROM archive_task_runs`).get().status, 'succeeded', 'Task recovery succeeded');
    equal(db.prepare(`SELECT task_status FROM archive_batches`).get().task_status, 'failed', '恢复成功不抹 Batch 基础 failed 历史');
    equal(createRecoveryControlReadRepository(db).getEffectiveBatchStatus(1, 'integration-task'), 'succeeded', 'overlay effective succeeded');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 6, '完整 Task+Batch 三阶段六条 event');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_request_owners WHERE status = 'committed'`).get().n, 6, '六个 owner committed');
    equal(db.prepare(`PRAGMA foreign_key_check`).all().length, 0, 'owner/event composite FK 完整');

    const archive = createArchiveRepository(db, { now: () => new Date('2026-08-24T01:00:00.000Z') });
    archive.beginTaskRun({
      taskRunId: 'rollback-task',
      moduleId: 'integration',
      taskKey: 'file:import',
      operationKey: 'rollback-operation',
      parentRunId: 'rollback-parent'
    });
    archive.transitionTaskRun('rollback-task', 'running');
    const rollbackTask = {
      ...taskTransition('mark-interrupted', {
        expectedState: 'running',
        failureCode: 'ROLLBACK_TEST',
        failureMessage: 'rollback test',
        metadataPatch: {}
      }),
      operationKey: 'rollback-operation',
      taskRunId: 'rollback-task',
      sourceRef: 'rollback-source'
    };
    const rollbackBatch = {
      ...batchTransition('mark-interrupted', {
        expectedState: null,
        failureCode: 'ROLLBACK_TEST',
        failureMessage: 'rollback test'
      }),
      operationKey: 'rollback-operation',
      taskRunId: 'rollback-task',
      batchId: 999,
      sourceRef: 'rollback-source'
    };
    let rollbackCode = '';
    try {
      restarted.transitionMany([
        { transition: rollbackTask, safePayload: {} },
        { transition: rollbackBatch, safePayload: {} }
      ]);
    } catch (error) {
      rollbackCode = error && error.code;
    }
    equal(rollbackCode, 'RECOVERY_BATCH_IDENTITY_CONFLICT', '第二个控制对象失败显式返回 identity conflict');
    equal(db.prepare(`SELECT status FROM archive_task_runs WHERE task_run_id = 'rollback-task'`).get().status, 'running', '同事务前一个 Task CAS 已回滚');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_events`).get().n, 6, '失败事务没有部分 event');
    equal(db.prepare(`SELECT COUNT(*) AS n FROM background_execution_recovery_request_owners WHERE status = 'prepared'`).get().n, 2, '失败只保留两个 durable prepared owner');

    const read = createRecoveryControlReadRepository(db);
    const events = read.listRecoveryEvents('integration-task');
    equal(events.length, 6, '只读 event lineage 返回六条');
    check(events.every((item, index) => item.sequenceId === index + 1), 'event cursor 严格递增');
    check(events.every((item) => item.actionKey === 'statement:import'), 'event canonical actionKey 不从 legacy 猜造');
    check(events.every((item) => item.operationKey === 'integration-operation'), 'event operationKey 血缘守恒');
    check(events.every((item) => item.taskRunId === 'integration-task'), 'event taskRunId 血缘守恒');
  } finally {
    if (db) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    for (const failure of failures) {
      console.error(`  - ${failure.label}: ${failure.details}`);
    }
    process.exit(1);
  }
}

try {
  run();
} catch (error) {
  console.error('FATAL', error);
  process.exit(1);
}
