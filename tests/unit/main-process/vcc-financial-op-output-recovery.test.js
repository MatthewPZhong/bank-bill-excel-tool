'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  publishVccFinancialOpOutputs
} = require('../../../src/main-process/vcc-financial-op-output-recovery');
const {
  createArchiveCenterController
} = require('../../../src/main-process/archive-center/controller');
const {
  createArchiveOutboxStore
} = require('../../../src/main-process/archive-center/outbox-store');
const {
  createArchiveService
} = require('../../../src/main-process/archive-center/archive-service');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  recoverToolboxPublicationsIntoArchive
} = require('../../../src/main-process/toolbox-archive-recovery');
const {
  createToolboxPublicationDispatcher,
  recoverToolboxPublicationsAsync
} = require('../../../src/main-process/toolbox-output-publication-dispatch');

const BATCH_CONTEXT = Object.freeze({
  batchId: 77,
  batchNumber: '2026-08-13-004',
  taskRunId: 'vcc-output-task-77',
  taskKey: 'vccFinancialOp:export:result',
  moduleId: 'vcc-financial-op',
  parentRunId: 'vcc-run:51',
  operationKey: 'vccFinancialOp:export:result:vcc-output-task-77'
});

test('VCC 输出用 exact7 + N 产物发布并仅在 archive handoff 后确认 receipt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-output-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generatedA = path.join(root, 'generated-a.xlsx');
  const generatedB = path.join(root, 'generated-b.xlsx');
  const targetA = path.join(root, 'target-a.xlsx');
  const targetB = path.join(root, 'target-b.xlsx');
  fs.writeFileSync(generatedA, 'subject-a');
  fs.writeFileSync(generatedB, 'subject-b');

  let publicationPayload;
  let recoveryPayload;
  let durableHandoff = 0;
  const result = await publishVccFinancialOpOutputs({
    batchContext: BATCH_CONTEXT,
    generationFilePaths: [generatedA, generatedB],
    targetFilePaths: [targetA, targetB],
    targetSnapshots: [{ exists: false }, { exists: false }],
    userDataDir: root,
    archiveCenter: { marker: 'archive-center' },
    publishPublication: async (payload) => {
      publicationPayload = payload;
      return { taskId: payload.taskId, files: [{ filePath: targetA }, { filePath: targetB }] };
    },
    recoverPublications: async () => ({ recovered: [] }),
    recoverIntoArchive: async (payload) => {
      recoveryPayload = payload;
      return { recovered: [] };
    },
    onDurableHandoff: async () => { durableHandoff += 1; }
  });

  assert.match(publicationPayload.taskId, /^vcc-output-vcc-output-task-77-/);
  assert.deepEqual(publicationPayload.batchContext, BATCH_CONTEXT);
  assert.equal(publicationPayload.allowEmptyArchiveInputs, true);
  assert.deepEqual(publicationPayload.archiveInputFiles, []);
  assert.deepEqual(publicationPayload.targets, [
    { targetPath: targetA, expectedTargetSnapshot: { exists: false } },
    { targetPath: targetB, expectedTargetSnapshot: { exists: false } }
  ]);
  assert.equal(publicationPayload.artifacts.length, 2);
  assert.ok(publicationPayload.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.deepEqual(recoveryPayload.taskIds, [publicationPayload.taskId]);
  assert.equal(recoveryPayload.archiveCenter.marker, 'archive-center');
  assert.equal(result.taskId, publicationPayload.taskId);
  assert.equal(durableHandoff, 1);
  assert.equal(fs.existsSync(generatedA), false);
  assert.equal(fs.existsSync(generatedB), false);
});

test('VCC 正式目标 committed 后 archive handoff 失败保留 receipt 但不改写业务成功', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-output-handoff-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generated = path.join(root, 'generated.xlsx');
  const target = path.join(root, 'target.xlsx');
  fs.writeFileSync(generated, 'published-output');
  let logged = null;
  let durableHandoff = 0;

  const result = await publishVccFinancialOpOutputs({
    batchContext: BATCH_CONTEXT,
    generationFilePaths: [generated],
    targetFilePaths: [target],
    targetSnapshots: [{ exists: false }],
    userDataDir: root,
    archiveCenter: {},
    publishPublication: async (payload) => ({ taskId: payload.taskId, committed: true }),
    recoverPublications: async () => ({ recovered: [] }),
    recoverIntoArchive: async () => { throw new Error('archive temporarily unavailable'); },
    onHandoffPending(error, publication) {
      logged = { error, publication };
    },
    onDurableHandoff: async () => { durableHandoff += 1; }
  });

  assert.equal(result.pendingArchiveHandoff, true);
  assert.match(result.warnings.at(-1), /receipt/);
  assert.match(logged.error.message, /temporarily unavailable/);
  assert.equal(logged.publication.committed, true);
  assert.equal(durableHandoff, 0);
  assert.equal(fs.existsSync(generated), false);
});

test('result/data/audit 在 actual worker committed 后硬退出均由原 exact7 批次二启接管', async (t) => {
  for (const [index, taskKey] of [
    'vccFinancialOp:export:result',
    'vccFinancialOp:data-manager:export',
    'vccFinancialOp:export:import-audit'
  ].entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `vcc-output-hard-kill-${index}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataDir = path.join(root, 'user-data');
    const archiveRoot = path.join(root, 'archive');
    const db = new DatabaseSync(path.join(root, 'tool-data.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    const service = createArchiveService({ database: db, rootDir: archiveRoot });
    await service.initialize();
    const reserved = await service.reserveTaskBatch({
      moduleId: 'vcc-financial-op',
      moduleCode: 'VCCFINOP',
      moduleName: 'VCC财务OP校验',
      operationKey: `${taskKey}:hard-kill-${index}`,
      taskKey,
      taskRunId: `vcc-hard-kill-${index}`,
      parentRunId: `vcc-parent-${index}`
    });
    assert.equal(reserved.ok, true);
    await service.markTaskStarted(reserved.batchId);
    const batchContext = Object.freeze({
      batchId: reserved.batch.id,
      batchNumber: reserved.batch.batchNumber,
      taskRunId: reserved.batch.taskRunId,
      taskKey: reserved.batch.taskKey,
      moduleId: reserved.batch.moduleId,
      parentRunId: reserved.batch.parentRunId,
      operationKey: reserved.batch.operationKey
    });
    const generationDir = path.join(root, 'generation');
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const generated = path.join(generationDir, `generated-${index}.xlsx`);
    const target = path.join(outputDir, `target-${index}.xlsx`);
    fs.writeFileSync(generated, `vcc-output-${taskKey}`);
    const crashWorker = path.join(
      __dirname,
      '__fixtures__',
      'toolbox-publication-stub-crash-recover.js'
    );
    const dispatcher = createToolboxPublicationDispatcher({ workerScriptPath: crashWorker });
    const publication = await dispatcher.publish({
      taskId: `committed-crash-recover-${index}`,
      artifacts: [{
        sourcePath: generated,
        fileName: path.basename(target),
        byteSize: fs.statSync(generated).size,
        sha256: require('node:crypto').createHash('sha256')
          .update(fs.readFileSync(generated)).digest('hex')
      }],
      targets: [{ targetPath: target, expectedTargetSnapshot: { exists: false } }],
      protectedSourcePaths: [],
      userDataDir,
      batchContext,
      archiveInputFiles: [],
      allowEmptyArchiveInputs: true,
      requireArchiveHandoff: true,
      requireValidatedArtifacts: true
    });
    assert.equal(publication.recoveredAfterWorkerExit, true);
    assert.equal(publication.pendingArchiveHandoff, true);
    assert.equal(createArchiveRepository(db).getBatch(reserved.batchId).taskStatus, 'running');

    const outboxStore = createArchiveOutboxStore(
      path.join(userDataDir, 'run-data', 'archive-center', 'outbox')
    );
    let controller;
    controller = createArchiveCenterController({
      database: {
        getSetting: () => null,
        setSetting: () => undefined,
        listTemplates: () => []
      },
      service,
      outboxStore,
      recoverInterruptedTasks: () => recoverToolboxPublicationsIntoArchive({
        userDataDir,
        archiveCenter: controller,
        recoverPublications: recoverToolboxPublicationsAsync
      }),
      getProtectedInterruptedTaskBatchIds: () => []
    });
    await controller.initialize();
    const detail = createArchiveRepository(db).getBatchDetail(reserved.batchId);
    assert.equal(detail.taskStatus, 'succeeded');
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].role, 'output');
    assert.equal(detail.artifacts[0].sourcePath, target);
    assert.equal(detail.artifacts[0].status, 'ready');
    assert.equal(fs.readFileSync(target, 'utf8'), `vcc-output-${taskKey}`);
    await controller.initialize();
    assert.equal(createArchiveRepository(db).getBatchDetail(reserved.batchId).artifacts.length, 1);
    db.close();
  }
});
