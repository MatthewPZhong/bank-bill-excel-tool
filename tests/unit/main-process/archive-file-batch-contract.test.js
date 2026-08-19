'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  assertFilePlanFresh,
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  sourceSnapshotFromStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  freezePersistedTaskOwner,
  freezeWorkerOperationContext
} = require('../../../src/main-process/archive-center/worker-operation-context');
const {
  normalizeLineageIntentsV1
} = require('../../../src/main-process/archive-center/task-lineage');

const ARCHIVE_REPOSITORY_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'backend',
  'database',
  'archive-repository.js'
);

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.xlsx');
  fs.writeFileSync(inputPath, 'input');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => db.close());
  const repository = createArchiveRepository(db, {
    now: () => new Date('2026-08-17T12:00:00.000Z')
  });
  repository.ensureSchema();
  return { db, repository, directory, inputPath };
}

function taskPayload(suffix = '1') {
  return {
    taskRunId: `task-${suffix}`,
    moduleId: 'toolbox',
    taskKey: 'toolbox:merge',
    operationKey: `operation-${suffix}`,
    parentRunId: `parent-${suffix}`
  };
}

function makeManifest(fixture, overrides = {}) {
  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'toolbox-source',
      sourceOperation: 'toolbox:merge'
    }],
    outputs: [{
      filePath: path.join(fixture.directory, overrides.outputName || 'merged.xlsx'),
      role: 'toolbox-output',
      sourceOperation: 'toolbox:merge'
    }]
  });
  return artifactManifestFromFilePlan(plan);
}

function reserveVisibleFileTask(fixture, suffix, direction, lineageIntents = []) {
  const task = fixture.repository.beginTaskRun({
    ...taskPayload(suffix),
    lineageIntents
  }).taskRun;
  const filePath = direction === 'input'
    ? fixture.inputPath
    : path.join(fixture.directory, `${suffix}.xlsx`);
  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: direction === 'input'
      ? [{ filePath, role: 'input', sourceOperation: `test:${suffix}` }]
      : [],
    outputs: direction === 'output'
      ? [{ filePath, role: 'output', sourceOperation: `test:${suffix}` }]
      : []
  });
  const reserved = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest: artifactManifestFromFilePlan(plan),
    moduleCode: 'TEST',
    moduleName: '血缘测试'
  });
  fixture.repository.startFileTask(task.taskRunId, reserved.batch.id);
  fixture.repository.finishFileTask(task.taskRunId, reserved.batch.id, {
    taskStatus: 'succeeded'
  });
  return { task: fixture.repository.getTaskRun(task.taskRunId), batch: reserved.batch };
}

test('Task Run 是无编号 exact-5 owner，建立本身不写 batch/issuance/sequence', (t) => {
  const { db, repository } = createFixture(t);
  const payload = taskPayload('no-file');
  const started = repository.beginTaskRun(payload);
  assert.equal(started.created, true);
  assert.equal(started.taskRun.status, 'prepared');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_batches').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_operation_issuances').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_daily_sequences').get().count, 0);

  const context = freezeWorkerOperationContext(payload, { required: true });
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(Object.keys(context), [
    'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'
  ]);
  const persisted = freezePersistedTaskOwner({
    version: 1,
    kind: 'operation',
    operationContext: context
  }, { required: true });
  assert.equal(persisted.kind, 'operation');
  assert.throws(
    () => freezeWorkerOperationContext({ ...payload, batchId: 1 }, { required: true }),
    /exact-5/
  );
  assert.equal(repository.transitionTaskRun(payload.taskRunId, 'succeeded').status, 'conflict');
  assert.equal(repository.transitionTaskRun(payload.taskRunId, 'running').status, 'updated');
  assert.equal(repository.transitionTaskRun(payload.taskRunId, 'succeeded', {
    metadata: { resultRevision: 7 }
  }).status, 'updated');
  assert.equal(repository.getTaskRun(payload.taskRunId).metadata.resultRevision, 7);
  assert.equal(repository.transitionTaskRun(payload.taskRunId, 'running').status, 'conflict');
});

test('LineageIntentV1 在 lifecycle 边界排序并深冻结，v0 producer 只能为 null', () => {
  const raw = [
    {
      version: 1,
      kind: 'run-output',
      lineageKey: 'pending:run-9',
      inputRole: 'Export Run',
      sourceContractVersion: 1,
      producerTaskRunId: 'task-run-9'
    },
    {
      version: 1,
      kind: 'dataset-input',
      lineageKey: 'dataset-old',
      inputRole: 'Upper Pending',
      sourceContractVersion: 0,
      producerTaskRunId: null
    }
  ];
  const normalized = normalizeLineageIntentsV1(raw);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[0]), true);
  assert.deepEqual(normalized.map((item) => item.kind), ['dataset-input', 'run-output']);
  raw[0].lineageKey = 'mutated';
  assert.equal(normalized[1].lineageKey, 'pending:run-9');
  assert.throws(() => normalizeLineageIntentsV1([raw[1], { ...raw[1] }]), /重复/);
  assert.throws(() => normalizeLineageIntentsV1([{ ...raw[1], producerTaskRunId: 'guessed' }]), /必须为 null/);
  assert.throws(() => normalizeLineageIntentsV1([{ ...raw[0], extra: true }]), /字段或版本非法/);
});

test('Task Run 与 planned lineage 同事务建立，replay 集合一致幂等、不同则冲突', (t) => {
  const { db, repository } = createFixture(t);
  const producerA = repository.beginTaskRun(taskPayload('producer-a')).taskRun;
  const producerB = repository.beginTaskRun(taskPayload('producer-b')).taskRun;
  const payload = {
    ...taskPayload('consumer'),
    lineageIntents: normalizeLineageIntentsV1([
      {
        version: 1,
        kind: 'dataset-input',
        lineageKey: 'dataset-1',
        inputRole: 'Upper Pending',
        sourceContractVersion: 1,
        producerTaskRunId: producerA.taskRunId
      },
      {
        version: 1,
        kind: 'dataset-input',
        lineageKey: 'legacy-dataset',
        inputRole: 'Removed Pending',
        sourceContractVersion: 0,
        producerTaskRunId: null
      }
    ])
  };
  const begun = repository.beginTaskRun(payload);
  assert.equal(begun.created, true);
  assert.deepEqual(begun.lineage.map((item) => [item.lineageKey, item.state]), [
    ['dataset-1', 'planned'],
    ['legacy-dataset', 'planned']
  ]);
  assert.equal(repository.beginTaskRun(payload).created, false);
  assert.throws(() => repository.beginTaskRun({
    ...payload,
    lineageIntents: normalizeLineageIntentsV1([
      {
        ...payload.lineageIntents[0],
        producerTaskRunId: producerB.taskRunId
      },
      payload.lineageIntents[1]
    ])
  }), (error) => error.code === 'ARCHIVE_TASK_LINEAGE_CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_task_runs').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM archive_task_lineage').get().count, 2);
});

test('lineage planned/terminal 写入故障与 Task Run 同事务回滚', (t) => {
  const { db, repository } = createFixture(t);
  const producer = repository.beginTaskRun(taskPayload('fault-producer')).taskRun;
  const lineageIntents = normalizeLineageIntentsV1([{
    version: 1,
    kind: 'dataset-input',
    lineageKey: 'fault-dataset',
    inputRole: 'Pending',
    sourceContractVersion: 1,
    producerTaskRunId: producer.taskRunId
  }]);
  db.exec(`
    CREATE TRIGGER fail_lineage_insert
    BEFORE INSERT ON archive_task_lineage
    BEGIN SELECT RAISE(ABORT, 'lineage insert failed'); END
  `);
  assert.throws(
    () => repository.beginTaskRun({ ...taskPayload('fault-consumer'), lineageIntents }),
    /lineage insert failed/
  );
  assert.equal(repository.getTaskRun(taskPayload('fault-consumer').taskRunId), null);
  db.exec('DROP TRIGGER fail_lineage_insert');

  const consumer = repository.beginTaskRun({
    ...taskPayload('fault-consumer'),
    lineageIntents
  }).taskRun;
  repository.transitionTaskRun(consumer.taskRunId, 'running');
  db.exec(`
    CREATE TRIGGER fail_lineage_commit
    BEFORE UPDATE OF state ON archive_task_lineage
    WHEN NEW.state = 'committed'
    BEGIN SELECT RAISE(ABORT, 'lineage commit failed'); END
  `);
  assert.throws(
    () => repository.transitionTaskRun(consumer.taskRunId, 'succeeded'),
    /lineage commit failed/
  );
  assert.equal(repository.getTaskRun(consumer.taskRunId).status, 'running');
  assert.equal(repository.listTaskLineageForConsumer(consumer.taskRunId)[0].state, 'planned');
});

test('Task Run terminal 与 lineage 同事务提交；interrupted 保留 planned 且仅它可恢复', (t) => {
  const { repository } = createFixture(t);
  const producer = repository.beginTaskRun(taskPayload('producer')).taskRun;
  const lineageIntents = normalizeLineageIntentsV1([{
    version: 1,
    kind: 'dataset-input',
    lineageKey: 'dataset-1',
    inputRole: 'Pending',
    sourceContractVersion: 1,
    producerTaskRunId: producer.taskRunId
  }]);

  const succeeded = repository.beginTaskRun({ ...taskPayload('success'), lineageIntents }).taskRun;
  repository.transitionTaskRun(succeeded.taskRunId, 'running');
  repository.transitionTaskRun(succeeded.taskRunId, 'succeeded');
  assert.equal(repository.listTaskLineageForConsumer(succeeded.taskRunId)[0].state, 'committed');

  const failed = repository.beginTaskRun({ ...taskPayload('failed'), lineageIntents }).taskRun;
  repository.transitionTaskRun(failed.taskRunId, 'failed');
  assert.equal(repository.listTaskLineageForConsumer(failed.taskRunId)[0].state, 'discarded');
  assert.equal(repository.transitionTaskRun(failed.taskRunId, 'running', { recovery: true }).status, 'conflict');

  const interrupted = repository.beginTaskRun({ ...taskPayload('interrupted'), lineageIntents }).taskRun;
  repository.transitionTaskRun(interrupted.taskRunId, 'interrupted');
  assert.equal(repository.listTaskLineageForConsumer(interrupted.taskRunId)[0].state, 'planned');
  assert.equal(repository.transitionTaskRun(interrupted.taskRunId, 'running', { recovery: true }).status, 'updated');
  repository.transitionTaskRun(interrupted.taskRunId, 'succeeded');
  assert.equal(repository.listTaskLineageForConsumer(interrupted.taskRunId)[0].state, 'committed');

  const startupInterrupted = repository.beginTaskRun({
    ...taskPayload('startup-interrupted'),
    lineageIntents
  }).taskRun;
  repository.markInterruptedTasks();
  assert.equal(repository.getTaskRun(startupInterrupted.taskRunId).status, 'interrupted');
  assert.equal(
    repository.listTaskLineageForConsumer(startupInterrupted.taskRunId)[0].state,
    'planned'
  );
});

test('related 以 visible seed 做 same-parent 与 pivot run 一跳查询，不沿共享输入递归扩散', (t) => {
  const fixture = createFixture(t);
  const imported = reserveVisibleFileTask(fixture, 'import', 'input');
  const datasetIntent = (role) => ({
    version: 1,
    kind: 'dataset-input',
    lineageKey: 'pending-dataset-1',
    inputRole: role,
    sourceContractVersion: 1,
    producerTaskRunId: imported.task.taskRunId
  });
  const run1 = fixture.repository.beginTaskRun({
    ...taskPayload('run-1'),
    lineageIntents: normalizeLineageIntentsV1([datasetIntent('Upper Pending')])
  }).taskRun;
  fixture.repository.transitionTaskRun(run1.taskRunId, 'running');
  fixture.repository.transitionTaskRun(run1.taskRunId, 'succeeded');
  const exportIntent = (run, locator) => normalizeLineageIntentsV1([{
    version: 1,
    kind: 'run-output',
    lineageKey: locator,
    inputRole: 'Export Run',
    sourceContractVersion: 1,
    producerTaskRunId: run.taskRunId
  }]);
  const export1 = reserveVisibleFileTask(
    fixture,
    'export-1',
    'output',
    exportIntent(run1, 'pending:run-1')
  );

  const run2 = fixture.repository.beginTaskRun({
    ...taskPayload('run-2'),
    lineageIntents: normalizeLineageIntentsV1([datasetIntent('Lower Pending')])
  }).taskRun;
  fixture.repository.transitionTaskRun(run2.taskRunId, 'running');
  fixture.repository.transitionTaskRun(run2.taskRunId, 'succeeded');
  const export2 = reserveVisibleFileTask(
    fixture,
    'export-2',
    'output',
    exportIntent(run2, 'pending:run-2')
  );

  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(export1.batch.id)
      .map((batch) => batch.id),
    [imported.batch.id, export1.batch.id]
  );
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(imported.batch.id)
      .map((batch) => batch.id),
    [imported.batch.id, export1.batch.id, export2.batch.id]
  );

  const aggregate = reserveVisibleFileTask(
    fixture,
    'aggregate',
    'output',
    normalizeLineageIntentsV1([
      exportIntent(run1, 'pending:run-1')[0],
      exportIntent(run2, 'pending:run-2')[0]
    ])
  );
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(aggregate.batch.id)
      .map((batch) => batch.id),
    [imported.batch.id, export1.batch.id, export2.batch.id, aggregate.batch.id]
  );
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(export1.batch.id)
      .map((batch) => batch.id),
    [imported.batch.id, export1.batch.id, aggregate.batch.id]
  );
});

test('v0/null producer lineage 不按日期、月份或 latest 伪造输入关联', (t) => {
  const fixture = createFixture(t);
  reserveVisibleFileTask(fixture, 'unrelated-import', 'input');
  const legacyRun = fixture.repository.beginTaskRun({
    ...taskPayload('legacy-run'),
    lineageIntents: normalizeLineageIntentsV1([{
      version: 1,
      kind: 'dataset-input',
      lineageKey: 'legacy-month-dataset',
      inputRole: 'Pending',
      sourceContractVersion: 0,
      producerTaskRunId: null
    }])
  }).taskRun;
  fixture.repository.transitionTaskRun(legacyRun.taskRunId, 'running');
  fixture.repository.transitionTaskRun(legacyRun.taskRunId, 'succeeded');
  const exported = reserveVisibleFileTask(
    fixture,
    'legacy-export',
    'output',
    normalizeLineageIntentsV1([{
      version: 1,
      kind: 'run-output',
      lineageKey: 'pending:legacy-run',
      inputRole: 'Export Run',
      sourceContractVersion: 1,
      producerTaskRunId: legacyRun.taskRunId
    }])
  );
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(exported.batch.id)
      .map((batch) => batch.id),
    [exported.batch.id]
  );
});

test('legacy 空 parent seed 不会把所有空 parent 历史批次关联在一起', (t) => {
  const fixture = createFixture(t);
  const first = reserveVisibleFileTask(fixture, 'legacy-empty-parent-1', 'input');
  const second = reserveVisibleFileTask(fixture, 'legacy-empty-parent-2', 'output');
  fixture.db.prepare(`
    UPDATE archive_batches SET parent_run_id = '' WHERE id IN (?, ?)
  `).run(first.batch.id, second.batch.id);
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatchesForBatch(first.batch.id)
      .map((batch) => batch.id),
    [first.batch.id]
  );
});

test('File Batch 与非空 pending manifest 原子创建，同 manifest replay 幂等', (t) => {
  const fixture = createFixture(t);
  const task = fixture.repository.beginTaskRun(taskPayload('atomic')).taskRun;
  const manifest = makeManifest(fixture);
  const reserved = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest,
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱'
  });
  assert.equal(reserved.created, true);
  assert.equal(reserved.batch.artifactCount, 2);
  assert.equal(reserved.batch.pendingArtifactCount, 2);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_operation_issuances').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT last_sequence FROM archive_daily_sequences').get().last_sequence, 1);

  const replay = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest,
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱'
  });
  assert.equal(replay.created, false);
  assert.equal(replay.batch.id, reserved.batch.id);
  assert.throws(
    () => fixture.repository.reserveFileTaskBatch({
      taskRun: task,
      manifest: makeManifest(fixture, { outputName: 'other.xlsx' }),
      moduleCode: 'TOOLBOX',
      moduleName: '工具箱'
    }),
    (error) => error && error.code === 'ARCHIVE_MANIFEST_IDENTITY_CONFLICT'
  );
  assert.equal(fixture.repository.startFileTask(task.taskRunId, reserved.batch.id).status, 'updated');
  const finished = fixture.repository.finishFileTask(task.taskRunId, reserved.batch.id, {
    taskStatus: 'cancelled',
    message: 'test cancellation',
    metadata: { durableReceipt: 'receipt-1' }
  });
  assert.equal(finished.status, 'updated');
  assert.equal(finished.taskRun.metadata.durableReceipt, 'receipt-1');
  assert.equal(finished.batch.metadata.durableReceipt, 'receipt-1');
});

test('deferred Task Run 已 running 时 promote 原子建立 running File Batch', (t) => {
  const fixture = createFixture(t);
  const task = fixture.repository.beginTaskRun(taskPayload('deferred')).taskRun;
  fixture.repository.transitionTaskRun(task.taskRunId, 'running', {
    expectedStatuses: ['prepared']
  });
  const reserved = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest: makeManifest(fixture, { outputName: 'deferred.xlsx' }),
    moduleCode: 'STATEMENT',
    moduleName: '生成网银账单'
  });
  assert.equal(reserved.batch.taskStatus, 'running');
  assert.ok(reserved.batch.startedAt);
  assert.equal(fixture.repository.getTaskRun(task.taskRunId).status, 'running');
});

test('manifest 首批 artifact 插入失败时 batch、issuance、sequence 全部回滚', (t) => {
  const fixture = createFixture(t);
  const task = fixture.repository.beginTaskRun(taskPayload('rollback')).taskRun;
  const manifest = makeManifest(fixture);
  fixture.db.exec(`
    CREATE TRIGGER fail_manifest_output
    BEFORE INSERT ON archive_artifacts
    WHEN NEW.role = 'toolbox-output'
    BEGIN
      SELECT RAISE(ABORT, 'manifest artifact fault');
    END
  `);
  assert.throws(() => fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest,
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱'
  }), /manifest artifact fault/);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_batches').get().count, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_artifacts').get().count, 0);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) count FROM archive_operation_issuances').get().count,
    0
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_daily_sequences').get().count, 0);
  assert.equal(fixture.repository.getTaskRun(task.taskRunId).status, 'prepared');
});

test('visible query 在 SQL 分页前排除零 artifact，并保留 failed-only', (t) => {
  const fixture = createFixture(t);
  const hidden = fixture.repository.createBatch({
    moduleId: 'legacy',
    moduleCode: 'LEGACY',
    moduleName: '历史空批',
    operationKey: 'legacy-empty',
    localDate: '2026-08-17'
  }).batch;
  const task = fixture.repository.beginTaskRun(taskPayload('visible')).taskRun;
  const manifest = makeManifest(fixture);
  const visible = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest,
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱'
  }).batch;
  fixture.db.prepare('UPDATE archive_batches SET parent_run_id = ? WHERE id = ?')
    .run(visible.parentRunId, hidden.id);
  for (const artifact of fixture.repository.listArtifacts(visible.id)) {
    fixture.repository.failArtifact(artifact.id, {
      code: 'ARCHIVE_BLOB_MISSING',
      message: '测试失败文件 evidence'
    });
  }

  assert.equal(fixture.repository.getBatch(hidden.id).artifactCount, 0);
  assert.equal(fixture.repository.getVisibleBatch(hidden.id), null);
  assert.equal(fixture.repository.getVisibleBatchByNumber(hidden.batchNumber), null);
  assert.equal(fixture.repository.getVisibleBatch(visible.id).failedArtifactCount, 2);
  assert.equal(fixture.repository.getVisibleBatchByNumber(visible.batchNumber).id, visible.id);
  assert.deepEqual(
    fixture.repository.listVisibleBatches({ limit: 1, offset: 0 }).map((row) => row.id),
    [visible.id]
  );
  assert.equal(fixture.repository.getVisibleStats().batchCount, 1);
  assert.equal(fixture.repository.getStats().batchCount, 2);
  assert.equal(fixture.repository.getLatestVisibleBatch().id, visible.id);
  assert.deepEqual(
    fixture.repository.listRelatedBatches(visible.parentRunId).map((row) => row.id).sort(),
    [hidden.id, visible.id].sort()
  );
  assert.deepEqual(
    fixture.repository.listVisibleRelatedBatches(visible.parentRunId).map((row) => row.id),
    [visible.id]
  );
});

test('public visible 查询只复用一个 repository SQL predicate fragment', () => {
  const source = fs.readFileSync(ARCHIVE_REPOSITORY_PATH, 'utf8');
  assert.equal((source.match(/visible_artifact\.batch_id = b\.id/g) || []).length, 1);
  for (const method of [
    'getVisibleBatch',
    'getVisibleBatchByNumber',
    'getLatestVisibleBatch',
    'listVisibleRelatedBatches',
    'listVisibleBatches',
    'getVisibleStats'
  ]) {
    const start = source.indexOf(`  ${method}(`);
    const end = source.indexOf('\n  }', start);
    assert.ok(start >= 0 && end > start, method);
    assert.match(source.slice(start, end), /VISIBLE_BATCH_PREDICATE_SQL/, method);
  }
});

test('filePlan boundary 接受零字节普通文件，拒绝目录、symlink 和 input/output alias', (t) => {
  const fixture = createFixture(t);
  const zeroPath = path.join(fixture.directory, 'zero.xlsx');
  fs.writeFileSync(zeroPath, '');
  const zeroPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: zeroPath, role: 'input', sourceOperation: 'test' }],
    outputs: []
  });
  assert.equal(zeroPlan.inputs[0].sourceSnapshot.sizeBytes, 0);

  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: fixture.directory, role: 'input', sourceOperation: 'test' }],
    outputs: []
  }), /普通文件/);

  const linkPath = path.join(fixture.directory, 'link.xlsx');
  fs.symlinkSync(fixture.inputPath, linkPath);
  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: linkPath, role: 'input', sourceOperation: 'test' }],
    outputs: []
  }), /符号链接/);

  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: fixture.inputPath, role: 'input', sourceOperation: 'test' }],
    outputs: [{ filePath: fixture.inputPath, role: 'output', sourceOperation: 'test' }]
  }), /别名指向输入/);

  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: null,
    outputs: []
  }), /必须是数组/);

  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'test',
      artifactKey: 'caller-controlled'
    }],
    outputs: []
  }), /artifactKey/);

  const hardlinkPath = path.join(fixture.directory, 'hardlink.xlsx');
  fs.linkSync(fixture.inputPath, hardlinkPath);
  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [
      { filePath: fixture.inputPath, role: 'source-a', sourceOperation: 'test' },
      { filePath: hardlinkPath, role: 'source-b', sourceOperation: 'test' }
    ],
    outputs: []
  }), /同一方向/);

  const realOutputDirectory = path.join(fixture.directory, 'real-output');
  const linkedOutputDirectory = path.join(fixture.directory, 'linked-output');
  fs.mkdirSync(realOutputDirectory);
  fs.symlinkSync(realOutputDirectory, linkedOutputDirectory);
  const linkedParentPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(linkedOutputDirectory, 'result.xlsx'),
      role: 'output',
      sourceOperation: 'test'
    }]
  });
  assert.equal(linkedParentPlan.outputs.length, 1);
});

test('FilePlan reserve 后 freshness 只复核冻结 input 与 target identity', (t) => {
  const fixture = createFixture(t);
  const inputChangedPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: fixture.inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
    outputs: []
  });
  fs.appendFileSync(fixture.inputPath, '-changed');
  assert.throws(
    () => assertFilePlanFresh(inputChangedPlan),
    (error) => error && error.code === 'ARCHIVE_INPUT_CHANGED'
  );

  const outputPath = path.join(fixture.directory, 'freshness-output.xlsx');
  const targetChangedPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'toolbox:merge' }]
  });
  fs.writeFileSync(outputPath, 'occupied-after-reserve');
  assert.throws(
    () => assertFilePlanFresh(targetChangedPlan),
    (error) => error && error.code === 'ARCHIVE_TARGET_CHANGED'
  );

  const existingPath = path.join(fixture.directory, 'existing-output.xlsx');
  fs.writeFileSync(existingPath, 'existing');
  const existingPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{ filePath: existingPath, role: 'output', sourceOperation: 'toolbox:merge' }]
  });
  assert.equal(assertFilePlanFresh(existingPlan), existingPlan);
  fs.appendFileSync(existingPath, '-replaced');
  assert.throws(
    () => assertFilePlanFresh(existingPlan),
    (error) => error && error.code === 'ARCHIVE_TARGET_CHANGED'
  );
});

test('FilePlan input 可继承 picker snapshot，并只在最终 freshness 使用定制失败合同', (t) => {
  const fixture = createFixture(t);
  const pickerStat = fs.lstatSync(fixture.inputPath, { bigint: true });
  const pickerSnapshot = sourceSnapshotFromStat(pickerStat);
  fs.appendFileSync(fixture.inputPath, '-changed-during-preview');

  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: pickerSnapshot,
      freshnessFailure: {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      }
    }],
    outputs: []
  });

  assert.deepEqual(plan.inputs[0].sourceSnapshot, pickerSnapshot);
  assert.throws(
    () => assertFilePlanFresh(plan),
    (error) => error
      && error.code === 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION'
      && error.message === '网银明细源文件在确认期间已变化，请重新选择'
  );

  const missingPath = path.join(fixture.directory, 'missing-after-picker.xlsx');
  fs.writeFileSync(missingPath, 'picked');
  const missingStat = fs.lstatSync(missingPath, { bigint: true });
  const missingPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: missingPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: sourceSnapshotFromStat(missingStat),
      freshnessFailure: {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      }
    }],
    outputs: []
  });
  fs.unlinkSync(missingPath);
  assert.throws(
    () => assertFilePlanFresh(missingPlan),
    (error) => error
      && error.code === 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION'
      && error.message === '网银明细源文件在确认期间已变化，请重新选择'
  );
});

test('提供 picker snapshot 时 normalize 不读源，最终 freshness 恰好比较一次', (t) => {
  const fixture = createFixture(t);
  const pickerStat = fs.lstatSync(fixture.inputPath, { bigint: true });
  const pickerSnapshot = sourceSnapshotFromStat(pickerStat);
  let comparisonCount = 0;
  const fsImpl = Object.create(fs);
  fsImpl.lstatSync = (...args) => {
    comparisonCount += 1;
    return fs.lstatSync(...args);
  };

  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: pickerSnapshot,
      freshnessFailure: {
        code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
        message: '网银明细源文件在确认期间已变化，请重新选择'
      }
    }],
    outputs: []
  }, { fsImpl });

  assert.equal(comparisonCount, 0);
  assert.equal(assertFilePlanFresh(plan, { fsImpl }), plan);
  assert.equal(comparisonCount, 1);
});

test('supplied snapshot 的父目录消失时仍形成 plan，并保留多输入与 alias 防护', (t) => {
  const fixture = createFixture(t);
  const vanishedParent = path.join(fixture.directory, 'vanished-parent');
  fs.mkdirSync(vanishedParent);
  const vanishedInput = path.join(vanishedParent, 'statement.xlsx');
  fs.writeFileSync(vanishedInput, 'statement');
  const vanishedStat = fs.lstatSync(vanishedInput, { bigint: true });
  const vanishedSnapshot = sourceSnapshotFromStat(vanishedStat);
  fs.renameSync(vanishedParent, path.join(fixture.directory, 'moved-parent'));

  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [
      {
        filePath: vanishedInput,
        role: 'input',
        sourceOperation: 'file:import',
        sourceSnapshot: vanishedSnapshot
      },
      {
        filePath: fixture.inputPath,
        role: 'input',
        sourceOperation: 'file:import'
      }
    ],
    outputs: []
  });
  assert.equal(plan.inputs.length, 2);
  assert.throws(
    () => assertFilePlanFresh(plan),
    (error) => error && error.code === 'ARCHIVE_INPUT_CHANGED'
  );

  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: plan.inputs[1].sourceSnapshot
    }],
    outputs: [{
      filePath: fixture.inputPath,
      role: 'output',
      sourceOperation: 'file:import'
    }]
  }), /输出目标不能覆盖或别名指向输入文件/);

  const suppliedHardlink = path.join(fixture.directory, 'supplied-hardlink.xlsx');
  fs.linkSync(fixture.inputPath, suppliedHardlink);
  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: plan.inputs[1].sourceSnapshot
    }],
    outputs: [{
      filePath: suppliedHardlink,
      role: 'output',
      sourceOperation: 'file:import'
    }]
  }), /输出目标不能覆盖或别名指向输入文件/);
});

test('FilePlan 拒绝非法 picker snapshot，未提供 snapshot 的旧调用保持 normalize 时捕获', (t) => {
  const fixture = createFixture(t);
  assert.throws(() => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{
      filePath: fixture.inputPath,
      role: 'input',
      sourceOperation: 'file:import',
      sourceSnapshot: { sizeBytes: -1, mtimeMs: 1, ctimeMs: 1 }
    }],
    outputs: []
  }), /sourceSnapshot/);

  const legacy = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: fixture.inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
    outputs: []
  });
  assert.equal(legacy.inputs[0].sourceSnapshot.sizeBytes, 5);
  assert.equal(Object.hasOwn(legacy.inputs[0], 'freshnessFailure'), false);
});

test('task-owned 与 batch-owned flow intent 跨表幂等复用且不产生双 owner', (t) => {
  const fixture = createFixture(t);
  const task = fixture.repository.beginTaskRun(taskPayload('flow')).taskRun;
  const batch = fixture.repository.reserveFileTaskBatch({
    taskRun: task,
    manifest: makeManifest(fixture),
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱'
  }).batch;
  const identityA = {
    moduleId: 'toolbox',
    identityType: 'business-run-id',
    identityValue: 'flow-a',
    parentRunId: task.parentRunId
  };
  const taskFirst = fixture.repository.persistTaskFlowBindIntent({
    ...identityA,
    sourceTaskRunId: task.taskRunId
  });
  assert.equal(taskFirst.created, true);
  const batchReplay = fixture.repository.persistFlowBindIntent({
    ...identityA,
    sourceBatchId: batch.id
  });
  assert.equal(batchReplay.ownerKind, 'task-run');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_flow_bind_intents').get().count, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_task_flow_bind_intents').get().count, 1);

  const identityB = { ...identityA, identityValue: 'flow-b' };
  const batchFirst = fixture.repository.persistFlowBindIntent({
    ...identityB,
    sourceBatchId: batch.id
  });
  assert.equal(batchFirst.created, true);
  const taskReplay = fixture.repository.persistTaskFlowBindIntent({
    ...identityB,
    sourceTaskRunId: task.taskRunId
  });
  assert.equal(taskReplay.ownerKind, 'file-batch');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_flow_bind_intents').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) count FROM archive_task_flow_bind_intents').get().count, 1);

  assert.throws(() => fixture.repository.bindFlowAnchor({
    ...identityA,
    sourceBatchId: null
  }), /必须有 file-batch 或 task-run owner/);
});
