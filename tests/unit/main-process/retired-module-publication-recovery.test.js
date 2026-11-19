'use strict';

// v3.2.20（spec D6）：已下线模块（月度Pending / 业务OP / 收单）的 publication-only 导出，升级前已提交发布、
//   归档尚未收口时，新版启动按原 owner 证明照常收尾（与旧版重启时一致），不得阻止启动。
//   旧格式批次（v3.1.10 及更早，无 _fileManifest）经 outbox 追加意图收尾；v3.1.11 起的 manifest 批次直接收口。
//   同模块其他遗留 outbox 通知仍原样保留给旧版。

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createArchiveCenterController } = require('../../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../../src/main-process/archive-center/outbox-store');
const { createArchiveService } = require('../../../src/main-process/archive-center/archive-service');
const { createArchiveRepository } = require('../../../src/backend/database/archive-repository');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const { recoverToolboxPublicationsIntoArchive } = require('../../../src/main-process/toolbox-archive-recovery');
const { createArchivePublicationOwner } = require('../../../src/main-process/publication-recovery/archive-owner');
const {
  JOURNAL_INDEX_NAME,
  ToolboxPublicationCrashError,
  createTestPublicationHarness,
  prepareToolboxPublication,
  publishPreparedToolboxPublication
} = require('../../helpers/publication-authority');

const RETIRED_EXPORTS = [
  { moduleId: 'pending-reconciliation', moduleCode: 'PENDING', moduleName: '月度Pending数据核对', taskKey: 'pending:diff:export-single' },
  { moduleId: 'biz-op-recon', moduleCode: 'BIZOP', moduleName: '业务OP数据核对', taskKey: 'bizOpRecon:export:date' },
  { moduleId: 'acquiring-bill-currency', moduleCode: 'ACQCUR', moduleName: '收单单据币种校验', taskKey: 'acquiringBillCurrency:export' }
];

function batchContextOf(batch) {
  return {
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    taskRunId: batch.taskRunId,
    taskKey: batch.taskKey,
    moduleId: batch.moduleId,
    parentRunId: batch.parentRunId,
    operationKey: batch.operationKey
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('已下线模块旧格式批次（无 _fileManifest）的 committed 导出：新版启动照常收尾，同模块其他遗留通知仍原样保留', async (t) => {
  for (const [index, entry] of RETIRED_EXPORTS.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `retired-legacy-publication-${index}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataDir = path.join(root, 'user-data');
    const outputDir = path.join(root, 'outputs');
    const generationDir = path.join(root, 'generation');
    const archiveRoot = path.join(root, 'archive');
    const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
    const dbPath = path.join(userDataDir, 'tool-data.sqlite');
    for (const dir of [userDataDir, outputDir, generationDir]) fs.mkdirSync(dir, { recursive: true });

    // 旧版现场：一个导出已提交发布但归档未收口；另一个同模块批次留有旧版自己的追加通知（无恢复标记）。
    const initialDb = new DatabaseSync(dbPath);
    initialDb.exec('PRAGMA foreign_keys = ON;');
    const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
    await initialService.initialize();
    const reserve = async (suffix) => {
      const reserved = await initialService.reserveTaskBatch({
        moduleId: entry.moduleId,
        moduleCode: entry.moduleCode,
        moduleName: entry.moduleName,
        operationKey: `${entry.taskKey}:${suffix}`,
        taskKey: entry.taskKey,
        taskRunId: `${entry.moduleId}-${suffix}-run`,
        parentRunId: `${entry.moduleId}-${suffix}-parent`
      });
      assert.equal(reserved.ok, true);
      await initialService.markTaskStarted(reserved.batchId);
      return reserved;
    };
    const committed = await reserve('after-committed');
    const leftover = await reserve('old-append-leftover');
    assert.equal(committed.batch.metadata._fileManifest, undefined, '旧格式批次没有 _fileManifest');

    const generationPath = path.join(generationDir, 'result.xlsx');
    const targetPath = path.join(outputDir, 'result.xlsx');
    fs.writeFileSync(generationPath, `committed ${entry.taskKey}`);
    const generated = fs.readFileSync(generationPath);
    const prepared = prepareToolboxPublication({
      taskId: `${entry.moduleId}-after-committed`,
      artifacts: [{ sourcePath: generationPath, byteSize: generated.length, sha256: sha256(generated), fileName: 'result.xlsx' }],
      targets: [targetPath],
      userDataDir,
      batchContext: batchContextOf(committed.batch),
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-committed') throw new ToolboxPublicationCrashError(name);
      }
    });
    assert.throws(() => publishPreparedToolboxPublication(prepared), ToolboxPublicationCrashError);
    initialDb.close();

    const leftoverFile = path.join(outputDir, 'leftover.xlsx');
    fs.writeFileSync(leftoverFile, 'old version leftover');

    let publicationHost = null;
    function openStartup() {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      const service = createArchiveService({ database: db, rootDir: archiveRoot });
      const outboxStore = createArchiveOutboxStore(outboxRoot);
      let controller;
      if (!publicationHost) {
        let center = null;
        const owner = createArchivePublicationOwner({ getArchiveCenter: () => center });
        publicationHost = { ...createTestPublicationHarness(userDataDir, { owners: [owner] }), setCenter(value) { center = value; } };
      }
      controller = createArchiveCenterController({
        database: { getSetting: () => null, setSetting: () => undefined, listTemplates: () => [] },
        service,
        outboxStore,
        recoverInterruptedTasks: () => recoverToolboxPublicationsIntoArchive({
          userDataDir,
          archiveCenter: controller,
          recoverPublications: (options) => publicationHost.recovery.recover(options)
        }),
        getProtectedInterruptedTaskBatchIds: () => []
      });
      publicationHost.setCenter(controller);
      return { db, outboxStore, controller };
    }

    // 旧版自己的追加通知只在 outbox 中存在，交给新版前写入（与恢复意图同为无 owner 的旧格式）。
    {
      const seeding = openStartup();
      seeding.controller.persistAppendIntent({
        batchContext: batchContextOf(leftover.batch),
        sourceOperation: entry.taskKey,
        files: [{ filePath: leftoverFile, role: 'output', sourceOperation: entry.taskKey }],
        terminalOutcome: { taskStatus: 'succeeded', code: '', message: '', metadata: {} }
      });
      seeding.db.close();
    }
    const retainedBefore = JSON.stringify(createArchiveOutboxStore(outboxRoot).list());

    const first = openStartup();
    await first.controller.initialize();
    const repository = createArchiveRepository(first.db);
    const detail = repository.getBatchDetail(committed.batchId);
    assert.equal(detail.taskStatus, 'succeeded', entry.moduleId);
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].status, 'ready');
    assert.equal(detail.artifacts[0].sourcePath, targetPath);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), `committed ${entry.taskKey}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries, []);
    assert.equal(JSON.stringify(first.outboxStore.list()), retainedBefore, '旧版遗留通知逐字保留');
    assert.equal(repository.getBatch(leftover.batchId).taskStatus, 'running', '旧版遗留批次不被改写');
    first.db.close();

    const second = openStartup();
    await second.controller.initialize();
    assert.equal(createArchiveRepository(second.db).getBatchDetail(committed.batchId).taskStatus, 'succeeded');
    assert.equal(JSON.stringify(second.outboxStore.list()), retainedBefore);
    second.db.close();
  }
});

test('已下线模块 manifest 批次的 committed 导出：worker 硬退出后新版启动照常收尾', async (t) => {
  for (const [index, entry] of RETIRED_EXPORTS.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `retired-manifest-publication-${index}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataDir = path.join(root, 'user-data');
    const db = new DatabaseSync(path.join(root, 'tool-data.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    const service = createArchiveService({ database: db, rootDir: path.join(root, 'archive') });
    await service.initialize();
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const target = path.join(outputDir, 'target.xlsx');
    const taskRun = (await service.beginTaskRun({
      moduleId: entry.moduleId,
      operationKey: `${entry.taskKey}:hard-kill`,
      taskKey: entry.taskKey,
      taskRunId: `${entry.moduleId}-hard-kill`,
      parentRunId: `${entry.moduleId}-parent`
    })).taskRun;
    const filePlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{ filePath: target, role: 'output', sourceOperation: entry.taskKey }]
    });
    const reserved = await service.reserveFileTaskBatch({
      taskRun,
      manifest: artifactManifestFromFilePlan(filePlan),
      moduleCode: entry.moduleCode,
      moduleName: entry.moduleName
    });
    assert.equal(reserved.ok, true);
    assert.ok(reserved.batch.metadata._fileManifest, 'manifest 批次');
    await service.startFileTask(taskRun.taskRunId, reserved.batchId);
    const generationDir = path.join(root, 'generation');
    fs.mkdirSync(generationDir, { recursive: true });
    const generated = path.join(generationDir, 'generated.xlsx');
    fs.writeFileSync(generated, `retired-output-${entry.taskKey}`);
    const { dispatcher, recovery } = createTestPublicationHarness(userDataDir, {
      dispatcherOptions: { workerScriptPath: path.join(__dirname, '__fixtures__', 'toolbox-publication-stub-crash-recover.js') }
    });
    const publication = await dispatcher.publish({
      taskId: `committed-crash-recover-${entry.moduleId}`, // 夹具按此前缀在 publish:after-committed 硬退出
      artifacts: [{
        sourcePath: generated,
        fileName: path.basename(target),
        byteSize: fs.statSync(generated).size,
        sha256: sha256(fs.readFileSync(generated))
      }],
      targets: [{ targetPath: target, expectedTargetSnapshot: { exists: false } }],
      protectedSourcePaths: [],
      userDataDir,
      batchContext: Object.freeze(batchContextOf(reserved.batch)),
      archiveInputFiles: [],
      allowEmptyArchiveInputs: true,
      requireArchiveHandoff: true,
      requireValidatedArtifacts: true
    });
    assert.equal(publication.pendingArchiveHandoff, true);
    assert.equal(createArchiveRepository(db).getBatch(reserved.batchId).taskStatus, 'running');

    let controller;
    controller = createArchiveCenterController({
      database: { getSetting: () => null, setSetting: () => undefined, listTemplates: () => [] },
      service,
      outboxStore: createArchiveOutboxStore(path.join(userDataDir, 'run-data', 'archive-center', 'outbox')),
      recoverInterruptedTaskOwners: [{
        ownerName: 'retired export publication',
        recover: () => recoverToolboxPublicationsIntoArchive({
          userDataDir,
          archiveCenter: controller,
          recoverPublications: recovery.recover
        })
      }],
      getProtectedInterruptedTaskBatchIds: () => []
    });
    await controller.initialize();
    const detail = createArchiveRepository(db).getBatchDetail(reserved.batchId);
    assert.equal(detail.taskStatus, 'succeeded', entry.moduleId);
    assert.equal(detail.artifacts.length, 1);
    assert.equal(detail.artifacts[0].status, 'ready');
    assert.equal(detail.artifacts[0].sourcePath, target);
    db.close();
  }
});
