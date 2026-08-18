'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

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
  JOURNAL_INDEX_NAME,
  ToolboxPublicationCrashError,
  prepareToolboxPublication,
  publishPreparedToolboxPublication
} = require('../../../src/main-process/toolbox-output-publication');
const {
  recoverToolboxPublicationsIntoArchive
} = require('../../../src/main-process/toolbox-archive-recovery');
const {
  publishToolboxPublicationAsync,
  recoverToolboxPublicationsAsync
} = require('../../../src/main-process/toolbox-output-publication-dispatch');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  freezeWorkerBatchContext
} = require('../../../src/main-process/archive-center/worker-batch-context');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8').replace(/\r\n?/g, '\n');
const TOOLBOX_RECOVERY_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main-process',
  'toolbox-archive-recovery.js'
);
const toolboxRecoverySource = fs.readFileSync(TOOLBOX_RECOVERY_PATH, 'utf8');

function workerBatchContext(batch) {
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

function toolboxInputDescriptor(filePath, sourceOperation = 'toolbox:merge') {
  const sourceSnapshot = sourceSnapshotFromStat(fs.statSync(filePath));
  assert.ok(sourceSnapshot);
  return {
    filePath,
    role: 'input',
    sourceOperation,
    sourceSnapshot
  };
}

function validatedPublicationArtifact(filePath, fileName = path.basename(filePath)) {
  const bytes = fs.readFileSync(filePath);
  return {
    sourcePath: filePath,
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    fileName
  };
}

function buildSplitReadContextHarness() {
  const start = mainSource.indexOf('let toolboxSplitReadContext = null;');
  const end = mainSource.indexOf('\nasync function recoverToolboxPublicationsAtStartup(', start);
  assert.ok(start >= 0 && end > start, '应定位 split read context 实现');
  const source = mainSource.slice(start, end);
  let sequence = 0;
  return Function(
    'fs',
    'path',
    'randomUUID',
    'sourceSnapshotFromStat',
    'sourceSnapshotMatchesStat',
    `${source}\nreturn {\n` +
      '  createToolboxSplitReadContext,\n' +
      '  requireToolboxSplitReadContext,\n' +
      '  clearToolboxSplitReadContext,\n' +
      '  assertToolboxSplitSourceFresh\n' +
      '};'
  )(
    fs,
    path,
    () => `split-token-${++sequence}`,
    sourceSnapshotFromStat,
    sourceSnapshotMatchesStat
  );
}

function buildToolboxRecoveryBatchIdsReader(fsImpl = fs) {
  const start = mainSource.indexOf('function readToolboxRecoveryBatchIds(userDataDir)');
  const end = mainSource.indexOf('\nasync function recoverPositionPendingBeforeInterruptedSweep()', start);
  assert.ok(start >= 0 && end > start, '应定位 Toolbox recovery index 读取实现');
  const source = mainSource.slice(start, end);
  return Function(
    'fs',
    'path',
    'JOURNAL_INDEX_NAME',
    'freezeWorkerBatchContext',
    `${source}\nreturn readToolboxRecoveryBatchIds;`
  )(fsImpl, path, JOURNAL_INDEX_NAME, freezeWorkerBatchContext);
}

function buildPositionPendingRecoveryOwner({ database, getService, recoveryPromise }) {
  const start = mainSource.indexOf('async function recoverPositionPendingBeforeInterruptedSweep()');
  const end = mainSource.indexOf('\nfunction recoverPendingRunsBeforeInterruptedSweep()', start);
  assert.ok(start >= 0 && end > start, '应定位 Position pending owner recovery');
  const source = mainSource.slice(start, end);
  return Function(
    'database',
    'POSITION_SIDE_DB_PENDING_SETTING',
    'getPositionReconciliationService',
    'positionPendingRecoveryPromise',
    `${source}\nreturn recoverPositionPendingBeforeInterruptedSweep;`
  )(
    database,
    'position_reconciliation_side_db_pending_v1',
    getService,
    recoveryPromise
  );
}

test('split read 只走裸 preview IPC，merge/export 的全部 dialog 在 execute 前完成', () => {
  const mergeStart = mainSource.indexOf("trackedIpcHandle('toolbox:merge'");
  const readStart = mainSource.indexOf("ipcMain.handle('toolbox:split:read'", mergeStart);
  const exportStart = mainSource.indexOf("trackedIpcHandle('toolbox:split:export'", readStart);
  const handlerEnd = mainSource.indexOf('\n}\n\n// v2.0.0-beta.4', exportStart);
  assert.ok(mergeStart >= 0 && readStart > mergeStart && exportStart > readStart);

  const mergeSource = mainSource.slice(mergeStart, readStart);
  const readSource = mainSource.slice(readStart, exportStart);
  const exportSource = mainSource.slice(exportStart, handlerEnd);
  const mergeExecute = mergeSource.indexOf('async execute(_event, prepared, taskContext)');
  const exportExecute = exportSource.indexOf('async execute(_event, prepared, taskContext)');
  const mergePrepareSource = mergeSource.slice(0, mergeExecute);
  const exportPrepareSource = exportSource.slice(0, exportExecute);
  const mergeExecuteSource = mergeSource.slice(mergeExecute);
  const exportExecuteSource = exportSource.slice(exportExecute);
  const publicationStart = mainSource.indexOf('async function publishToolboxArtifacts(');
  const publicationEnd = mainSource.indexOf('\nfunction ', publicationStart + 1);
  const publicationSource = mainSource.slice(publicationStart, publicationEnd);
  assert.match(publicationSource, /settled\.durable !== true/);
  assert.doesNotMatch(publicationSource, /settled\.ok === false/);

  assert.ok(!readSource.includes("trackedIpcHandle('toolbox:split:read'"));
  assert.ok(!readSource.includes('batchContext'));
  assert.ok(mergePrepareSource.includes('showImportOpenDialog'));
  assert.ok(mergePrepareSource.includes('showSaveDialog'));
  assert.ok(mergePrepareSource.match(/proceed: false/g).length >= 2);
  assert.ok(!mergePrepareSource.includes('toolboxMergeFilesToXlsx'));
  assert.ok(mergePrepareSource.includes('assertToolboxTargetsDoNotAliasSources'));
  assert.ok(mergePrepareSource.includes('filePlan'));
  assert.ok(!mergePrepareSource.includes('assertToolboxTargetSnapshotsFresh'));
  assert.ok(mergeSource.indexOf('toolboxMergeFilesToXlsx') > mergeExecute);
  assert.ok(exportPrepareSource.includes("showImportOpenDialog('toolbox-split-export-directory'"));
  assert.ok(exportPrepareSource.includes('showSaveDialog'));
  assert.ok(exportPrepareSource.match(/proceed: false/g).length >= 4);
  assert.ok(!exportPrepareSource.includes('exportToolboxFilter'));
  assert.ok(exportPrepareSource.includes('assertToolboxTargetsDoNotAliasSources'));
  assert.ok(exportPrepareSource.includes('filePlan'));
  assert.ok(!exportPrepareSource.includes('assertToolboxTargetSnapshotsFresh'));
  assert.ok(exportSource.indexOf('exportToolboxFilter') > exportExecute);
  assert.match(mergeExecuteSource, /fileEvidence\.filePlan\.outputs\[0\]\.filePath/);
  assert.doesNotMatch(mergeExecuteSource, /prepared\.(?:savePath|outputPaths|filePaths|inputPaths)/);
  assert.match(exportExecuteSource, /fileEvidence\.filePlan\.outputs/);
  assert.doesNotMatch(
    exportExecuteSource,
    /prepared\.(?:savePath|outputPaths|filePaths|inputPaths|outputDirectory)/
  );
  assert.doesNotMatch(exportExecuteSource, /targetPlans\[[^\]]+\]\.targetPath/);
});

test('committed 恢复输出携 exact7 回原批次，output descriptor 显式标记方向', () => {
  const recoverStart = mainSource.indexOf('async function recoverToolboxPublicationsAtStartup()');
  const recoverEnd = mainSource.indexOf('\nfunction registerToolboxHandlers()', recoverStart);
  const recoverSource = mainSource.slice(recoverStart, recoverEnd);
  assert.match(recoverSource, /recoverToolboxPublicationsIntoArchive\(/);
  assert.match(toolboxRecoverySource, /archiveCenter\.persistAppendIntent\(/);
  assert.match(toolboxRecoverySource, /batchContext: item\.batchContext/);
  assert.match(toolboxRecoverySource, /role: 'output'/);
  assert.match(toolboxRecoverySource, /expectedSha256/);
  assert.match(toolboxRecoverySource, /taskStatus: 'succeeded'/);

  const initStart = mainSource.indexOf('function initializeArchiveCenter()');
  const initEnd = mainSource.indexOf('\nfunction registerAppHandlers()', initStart);
  const initSource = mainSource.slice(initStart, initEnd);
  assert.match(
    initSource,
    /recoverInterruptedTaskOwners: \[/
  );
  assert.ok(
    initSource.indexOf("ownerName: 'Position'")
      < initSource.indexOf("ownerName: 'Toolbox/VCC output publications'"),
    'Position 与 Toolbox/VCC 输出应作为独立 owner 按固定顺序 settle'
  );
  assert.match(
    initSource,
    /archiveCenterService\.initialize\(\)\.catch\(\(error\) => \{[\s\S]*?throw error;/,
    'ArchiveCenter initialize reject 不得降级成可继续的 unavailable 结果'
  );
  const startupStart = mainSource.indexOf('async function runBackgroundInitChain()');
  const startupEnd = mainSource.indexOf('\n// init 完成标记', startupStart);
  const startupSource = mainSource.slice(startupStart, startupEnd);
  assert.ok(
    startupSource.indexOf('await archiveCenterInitializationPromise')
      < startupSource.indexOf('if (toolboxStartupRecoveryError) throw toolboxStartupRecoveryError'),
    'Toolbox owner 失败必须在 ArchiveCenter 保留批次后继续阻断启动放行'
  );
});

test('Position owner 等待实际异步恢复，失败时保留 pending 并阻止 generic sweep', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-owner-recovery-failure-'));
  const db = new DatabaseSync(path.join(root, 'tool-data.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pendingRaw = JSON.stringify({ operationToken: 'position-pending-recovery' });
  const settings = new Map([
    ['position_reconciliation_side_db_pending_v1', pendingRaw]
  ]);
  let rejectRecovery;
  const recoveryPromise = new Promise((_resolve, reject) => {
    rejectRecovery = reject;
  });
  let serviceCalls = 0;
  let markOwnerEntered;
  const ownerEntered = new Promise((resolve) => {
    markOwnerEntered = resolve;
  });
  const recover = buildPositionPendingRecoveryOwner({
    database: {
      db,
      getSetting: (key) => settings.get(key) || ''
    },
    getService: () => {
      serviceCalls += 1;
      markOwnerEntered();
      return {};
    },
    recoveryPromise
  });
  assert.match(
    mainSource,
    /positionPendingRecoveryPromise = Promise\.resolve\(recoveryTask\)[\s\S]*?readPositionPendingOperation\(\)/
  );

  const service = createArchiveService({
    database: db,
    rootDir: path.join(root, 'archive')
  });
  let sweepCalls = 0;
  service.markInterruptedTasks = async () => {
    sweepCalls += 1;
    return { ok: true, taskCount: 0, batchIds: [] };
  };
  const controller = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value),
      listTemplates: () => []
    },
    service,
    recoverInterruptedTaskOwners: [{ ownerName: 'Position', recover }]
  });
  const initializing = controller.initialize();
  await ownerEntered;
  assert.equal(serviceCalls, 1);
  rejectRecovery(new Error('position recovery async failure'));
  await assert.rejects(
    initializing,
    (error) => error && error.code === 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED'
  );
  assert.equal(sweepCalls, 0);
  assert.equal(settings.get('position_reconciliation_side_db_pending_v1'), pendingRaw);
});

test('after-committed 崩溃首次完整启动即归档 ready + task succeeded，第二次启动幂等', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-archive-startup-recovery-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(generationDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const initialDb = new DatabaseSync(dbPath);
  initialDb.exec('PRAGMA foreign_keys = ON;');
  const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
  await initialService.initialize();
  const reserved = await initialService.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:after-committed-recovery',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-after-committed-run',
    parentRunId: 'toolbox-after-committed-parent'
  });
  assert.equal(reserved.ok, true);
  await initialService.markTaskStarted(reserved.batchId);
  const batchContext = {
    batchId: reserved.batch.id,
    batchNumber: reserved.batch.batchNumber,
    taskRunId: reserved.batch.taskRunId,
    taskKey: reserved.batch.taskKey,
    moduleId: reserved.batch.moduleId,
    parentRunId: reserved.batch.parentRunId,
    operationKey: reserved.batch.operationKey
  };

  const generationPath = path.join(generationDir, 'result.xlsx');
  const targetPath = path.join(outputDir, 'result.xlsx');
  fs.writeFileSync(generationPath, 'committed toolbox output');
  const generated = fs.readFileSync(generationPath);
  const prepared = prepareToolboxPublication({
    taskId: 'toolbox-after-committed-recovery',
    artifacts: [{
      sourcePath: generationPath,
      byteSize: generated.length,
      sha256: crypto.createHash('sha256').update(generated).digest('hex'),
      fileName: 'result.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext,
    requireValidatedArtifacts: true,
    checkpoint(name) {
      if (name === 'publish:after-committed') {
        throw new ToolboxPublicationCrashError(name);
      }
    }
  });
  assert.throws(
    () => publishPreparedToolboxPublication(prepared),
    ToolboxPublicationCrashError
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'committed toolbox output');
  assert.equal(createArchiveRepository(initialDb).getBatch(reserved.batchId).taskStatus, 'running');
  initialDb.close();

  function openStartup() {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const settings = new Map();
    const service = createArchiveService({ database: db, rootDir: archiveRoot });
    const outboxStore = createArchiveOutboxStore(outboxRoot);
    let controller;
    controller = createArchiveCenterController({
      database: {
        getSetting: (key) => settings.get(key) || null,
        setSetting: (key, value) => settings.set(key, value),
        listTemplates: () => []
      },
      service,
      outboxStore,
      recoverInterruptedTasks: () => recoverToolboxPublicationsIntoArchive({
        userDataDir,
        archiveCenter: controller,
        recoverPublications: recoverToolboxPublicationsAsync
      }),
      // owner recovery 成功后不应再依赖 protected-list 才避免误扫。
      getProtectedInterruptedTaskBatchIds: () => []
    });
    return { db, service, outboxStore, controller };
  }

  const firstStartup = openStartup();
  await firstStartup.controller.initialize();
  const firstDetail = createArchiveRepository(firstStartup.db).getBatchDetail(reserved.batchId);
  assert.equal(firstDetail.taskStatus, 'succeeded');
  assert.equal(firstDetail.artifacts.length, 1);
  assert.equal(firstDetail.artifacts[0].status, 'ready');
  assert.equal(firstDetail.artifacts[0].role, 'output');
  assert.equal(firstDetail.artifacts[0].sourcePath, targetPath);
  assert.equal(firstStartup.outboxStore.list().length, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  firstStartup.db.close();

  const secondStartup = openStartup();
  await secondStartup.controller.initialize();
  const secondDetail = createArchiveRepository(secondStartup.db).getBatchDetail(reserved.batchId);
  assert.equal(secondDetail.taskStatus, 'succeeded');
  assert.equal(secondDetail.artifacts.length, 1);
  assert.equal(secondDetail.artifacts[0].status, 'ready');
  assert.equal(secondStartup.outboxStore.list().length, 0);
  secondStartup.db.close();
});

test('Position owner 失败不阻断 Toolbox 同次恢复，后续同目标发布不丢旧 artifact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-owner-settle-recovery-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(generationDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const initialDb = new DatabaseSync(dbPath);
  initialDb.exec('PRAGMA foreign_keys = ON;');
  const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
  await initialService.initialize();
  const oldReserved = await initialService.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:owner-settle-old',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-owner-settle-old-run',
    parentRunId: 'toolbox-owner-settle-old-parent'
  });
  assert.equal(oldReserved.ok, true);
  await initialService.markTaskStarted(oldReserved.batchId);
  const oldBatchContext = {
    batchId: oldReserved.batch.id,
    batchNumber: oldReserved.batch.batchNumber,
    taskRunId: oldReserved.batch.taskRunId,
    taskKey: oldReserved.batch.taskKey,
    moduleId: oldReserved.batch.moduleId,
    parentRunId: oldReserved.batch.parentRunId,
    operationKey: oldReserved.batch.operationKey
  };
  const targetPath = path.join(outputDir, 'same-target.xlsx');
  const oldGenerationPath = path.join(generationDir, 'old.xlsx');
  fs.writeFileSync(oldGenerationPath, 'OLD');
  const oldBytes = fs.readFileSync(oldGenerationPath);
  const oldPrepared = prepareToolboxPublication({
    taskId: 'toolbox-owner-settle-old-publication',
    artifacts: [{
      sourcePath: oldGenerationPath,
      byteSize: oldBytes.length,
      sha256: crypto.createHash('sha256').update(oldBytes).digest('hex'),
      fileName: 'same-target.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext: oldBatchContext,
    requireValidatedArtifacts: true,
    checkpoint(name) {
      if (name === 'publish:after-committed') {
        throw new ToolboxPublicationCrashError(name);
      }
    }
  });
  assert.throws(
    () => publishPreparedToolboxPublication(oldPrepared),
    ToolboxPublicationCrashError
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'OLD');
  assert.equal(
    createArchiveRepository(initialDb).getBatch(oldReserved.batchId).taskStatus,
    'running'
  );
  initialDb.close();

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const settings = new Map();
  const service = createArchiveService({ database: db, rootDir: archiveRoot });
  const outboxStore = createArchiveOutboxStore(outboxRoot);
  const warnings = [];
  let controller;
  controller = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value),
      listTemplates: () => []
    },
    service,
    outboxStore,
    recoverInterruptedTaskOwners: [
      {
        ownerName: 'Position',
        recover: async () => {
          throw Object.assign(new Error('position owner recovery failed'), {
            code: 'POSITION_RECOVERY_FAILED'
          });
        }
      },
      {
        ownerName: 'Toolbox',
        recover: () => recoverToolboxPublicationsIntoArchive({
          userDataDir,
          archiveCenter: controller,
          recoverPublications: recoverToolboxPublicationsAsync
        })
      }
    ],
    // Toolbox 成功接管后，正确性不应依赖 journal protected-list。
    getProtectedInterruptedTaskBatchIds: () => [],
    logWarning: (...args) => warnings.push(args)
  });

  await controller.initialize();

  const repository = createArchiveRepository(db);
  const recoveredOld = repository.getBatchDetail(oldReserved.batchId);
  assert.equal(recoveredOld.taskStatus, 'succeeded');
  assert.equal(recoveredOld.artifacts.length, 1);
  assert.equal(recoveredOld.artifacts[0].status, 'ready');
  assert.equal(outboxStore.list().length, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /Position/);
  const oldBlobPath = path.join(
    archiveRoot,
    ...recoveredOld.artifacts[0].blob.relativePath.split('/')
  );
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');

  const newReserved = await service.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:owner-settle-new',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-owner-settle-new-run',
    parentRunId: 'toolbox-owner-settle-new-parent'
  });
  assert.equal(newReserved.ok, true);
  await service.markTaskStarted(newReserved.batchId);
  const newGenerationPath = path.join(generationDir, 'new.xlsx');
  fs.writeFileSync(newGenerationPath, 'NEW');
  const newBytes = fs.readFileSync(newGenerationPath);
  const newPrepared = prepareToolboxPublication({
    taskId: 'toolbox-owner-settle-new-publication',
    artifacts: [{
      sourcePath: newGenerationPath,
      byteSize: newBytes.length,
      sha256: crypto.createHash('sha256').update(newBytes).digest('hex'),
      fileName: 'same-target.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext: {
      batchId: newReserved.batch.id,
      batchNumber: newReserved.batch.batchNumber,
      taskRunId: newReserved.batch.taskRunId,
      taskKey: newReserved.batch.taskKey,
      moduleId: newReserved.batch.moduleId,
      parentRunId: newReserved.batch.parentRunId,
      operationKey: newReserved.batch.operationKey
    },
    requireValidatedArtifacts: true
  });
  const published = publishPreparedToolboxPublication(newPrepared);
  assert.equal(published.committed, true);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'NEW');

  const oldAfterNewPublish = repository.getBatchDetail(oldReserved.batchId);
  assert.equal(oldAfterNewPublish.taskStatus, 'succeeded');
  assert.equal(oldAfterNewPublish.artifacts.length, 1);
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');
  db.close();
});

test('损坏 outbox 不短路 Toolbox owner 且阻断新发布，修复后重启保全旧 artifact', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-corrupt-outbox-recovery-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(generationDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const initialDb = new DatabaseSync(dbPath);
  initialDb.exec('PRAGMA foreign_keys = ON;');
  const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
  await initialService.initialize();
  const oldReserved = await initialService.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:corrupt-outbox-old',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-corrupt-outbox-old-run',
    parentRunId: 'toolbox-corrupt-outbox-old-parent'
  });
  assert.equal(oldReserved.ok, true);
  await initialService.markTaskStarted(oldReserved.batchId);
  const oldBatchContext = {
    batchId: oldReserved.batch.id,
    batchNumber: oldReserved.batch.batchNumber,
    taskRunId: oldReserved.batch.taskRunId,
    taskKey: oldReserved.batch.taskKey,
    moduleId: oldReserved.batch.moduleId,
    parentRunId: oldReserved.batch.parentRunId,
    operationKey: oldReserved.batch.operationKey
  };
  const targetPath = path.join(outputDir, 'same-target.xlsx');
  const oldGenerationPath = path.join(generationDir, 'old-corrupt-outbox.xlsx');
  fs.writeFileSync(oldGenerationPath, 'OLD');
  const oldBytes = fs.readFileSync(oldGenerationPath);
  const oldPrepared = prepareToolboxPublication({
    taskId: 'toolbox-corrupt-outbox-old-publication',
    artifacts: [{
      sourcePath: oldGenerationPath,
      byteSize: oldBytes.length,
      sha256: crypto.createHash('sha256').update(oldBytes).digest('hex'),
      fileName: 'same-target.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext: oldBatchContext,
    requireValidatedArtifacts: true,
    checkpoint(name) {
      if (name === 'publish:after-committed') {
        throw new ToolboxPublicationCrashError(name);
      }
    }
  });
  assert.throws(
    () => publishPreparedToolboxPublication(oldPrepared),
    ToolboxPublicationCrashError
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'OLD');
  initialDb.close();

  fs.mkdirSync(outboxRoot, { recursive: true });
  const corruptOutboxPath = path.join(outboxRoot, 'corrupt.json');
  fs.writeFileSync(corruptOutboxPath, '{broken-json', 'utf8');

  function openStartup(onToolboxRecovery = () => {}) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const settings = new Map();
    const service = createArchiveService({ database: db, rootDir: archiveRoot });
    const outboxStore = createArchiveOutboxStore(outboxRoot);
    const warnings = [];
    let controller;
    controller = createArchiveCenterController({
      database: {
        getSetting: (key) => settings.get(key) || null,
        setSetting: (key, value) => settings.set(key, value),
        listTemplates: () => []
      },
      service,
      outboxStore,
      recoverInterruptedTaskOwners: [{
        ownerName: 'Toolbox',
        recover: async () => {
          onToolboxRecovery();
          await recoverToolboxPublicationsIntoArchive({
            userDataDir,
            archiveCenter: controller,
            recoverPublications: recoverToolboxPublicationsAsync
          });
        }
      }],
      getProtectedInterruptedTaskBatchIds: () => [],
      logWarning: (...args) => warnings.push(args)
    });
    return { db, service, outboxStore, warnings, controller };
  }

  let toolboxRecoveryCalls = 0;
  const blockedStartup = openStartup(() => { toolboxRecoveryCalls += 1; });
  const startupAdmission = blockedStartup.controller.initialize();
  await assert.rejects(startupAdmission, (error) => {
    assert.equal(error.code, 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED');
    assert.deepEqual(error.owners, ['Toolbox']);
    return true;
  });
  assert.equal(toolboxRecoveryCalls, 1, '损坏 outbox 读取前必须先调用 Toolbox owner');
  assert.ok(blockedStartup.warnings.some(([message]) => /Toolbox/.test(message)));
  assert.ok(blockedStartup.warnings.some(([message]) => /模块恢复后的.*重放未全部完成/.test(message)));

  const blockedRepository = createArchiveRepository(blockedStartup.db);
  const blockedOld = blockedRepository.getBatchDetail(oldReserved.batchId);
  assert.equal(blockedOld.taskStatus, 'running');
  assert.equal(blockedOld.artifacts.length, 0);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'OLD');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries.length,
    1,
    'durable outbox 无法接管时必须保留 publication journal'
  );

  let newOperationStarted = false;
  await assert.rejects(
    (async () => {
      await startupAdmission;
      newOperationStarted = true;
      return blockedStartup.service.reserveTaskBatch({
        moduleId: 'toolbox',
        moduleCode: 'TOOLBOX',
        moduleName: '工具箱',
        operationKey: 'toolbox:merge:must-stay-blocked',
        taskKey: 'toolbox:merge',
        taskRunId: 'toolbox-must-stay-blocked-run',
        parentRunId: 'toolbox-must-stay-blocked-parent'
      });
    })(),
    (error) => error && error.code === 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED'
  );
  assert.equal(newOperationStarted, false, '启动 admission 失败后不得 reserve/publish 新任务');
  blockedStartup.db.close();

  fs.rmSync(corruptOutboxPath, { force: true });
  const recoveredStartup = openStartup();
  await recoveredStartup.controller.initialize();
  const recoveredRepository = createArchiveRepository(recoveredStartup.db);
  const recoveredOld = recoveredRepository.getBatchDetail(oldReserved.batchId);
  assert.equal(recoveredOld.taskStatus, 'succeeded');
  assert.equal(recoveredOld.artifacts.length, 1);
  assert.equal(recoveredOld.artifacts[0].status, 'ready');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  assert.equal(recoveredStartup.outboxStore.list().length, 0);
  const oldBlobPath = path.join(
    archiveRoot,
    ...recoveredOld.artifacts[0].blob.relativePath.split('/')
  );
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');

  const newReserved = await recoveredStartup.service.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:corrupt-outbox-new',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-corrupt-outbox-new-run',
    parentRunId: 'toolbox-corrupt-outbox-new-parent'
  });
  assert.equal(newReserved.ok, true);
  await recoveredStartup.service.markTaskStarted(newReserved.batchId);
  const newGenerationPath = path.join(generationDir, 'new-after-corrupt-outbox.xlsx');
  fs.writeFileSync(newGenerationPath, 'NEW');
  const newBytes = fs.readFileSync(newGenerationPath);
  const newPrepared = prepareToolboxPublication({
    taskId: 'toolbox-corrupt-outbox-new-publication',
    artifacts: [{
      sourcePath: newGenerationPath,
      byteSize: newBytes.length,
      sha256: crypto.createHash('sha256').update(newBytes).digest('hex'),
      fileName: 'same-target.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext: {
      batchId: newReserved.batch.id,
      batchNumber: newReserved.batch.batchNumber,
      taskRunId: newReserved.batch.taskRunId,
      taskKey: newReserved.batch.taskKey,
      moduleId: newReserved.batch.moduleId,
      parentRunId: newReserved.batch.parentRunId,
      operationKey: newReserved.batch.operationKey
    },
    requireValidatedArtifacts: true
  });
  assert.equal(publishPreparedToolboxPublication(newPrepared).committed, true);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');
  assert.equal(recoveredRepository.getBatchDetail(oldReserved.batchId).artifacts.length, 1);
  recoveredStartup.db.close();
});

test('正常 worker committed 后 receipt 保留 N 个输入与全部输出，存档接管完整后才清理', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-normal-handoff-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  const inputDir = path.join(root, 'inputs');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  for (const dir of [userDataDir, outputDir, generationDir, inputDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inputA = path.join(inputDir, 'input-a.xlsx');
  const inputB = path.join(inputDir, 'input-b.xlsx');
  const generationPath = path.join(generationDir, 'old-result.xlsx');
  const targetPath = path.join(outputDir, 'same-target.xlsx');
  fs.writeFileSync(inputA, 'INPUT-A');
  fs.writeFileSync(inputB, 'INPUT-B');
  fs.writeFileSync(generationPath, 'OLD');

  const initialDb = new DatabaseSync(dbPath);
  initialDb.exec('PRAGMA foreign_keys = ON;');
  const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
  await initialService.initialize();
  const reserved = await initialService.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:normal-worker-handoff-old',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-normal-worker-old-run',
    parentRunId: 'toolbox-normal-worker-old-parent'
  });
  assert.equal(reserved.ok, true);
  await initialService.markTaskStarted(reserved.batchId);
  const batchContext = workerBatchContext(reserved.batch);
  const publication = await publishToolboxPublicationAsync({
    taskId: 'toolbox-normal-worker-handoff-old-publication',
    artifacts: [validatedPublicationArtifact(generationPath, 'same-target.xlsx')],
    targets: [{ targetPath }],
    userDataDir,
    batchContext,
    protectedSourcePaths: [inputA, inputB],
    archiveInputFiles: [
      toolboxInputDescriptor(inputA),
      toolboxInputDescriptor(inputB)
    ]
  });
  assert.equal(publication.committed, true);
  assert.equal(publication.pendingArchiveHandoff, true);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'OLD');
  const receiptBeforeHandoff = JSON.parse(fs.readFileSync(
    path.join(userDataDir, JOURNAL_INDEX_NAME),
    'utf8'
  ));
  assert.equal(receiptBeforeHandoff.entries.length, 1);
  assert.deepEqual(receiptBeforeHandoff.entries[0].batchContext, batchContext);
  assert.equal(receiptBeforeHandoff.entries[0].archiveInputFiles.length, 2);
  assert.equal(receiptBeforeHandoff.entries[0].outputFiles.length, 1);
  initialDb.close();

  function openStartup({ failFirstAppend = false } = {}) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const settings = new Map();
    const service = createArchiveService({ database: db, rootDir: archiveRoot });
    if (failFirstAppend) {
      const appendFiles = service.appendFiles.bind(service);
      let shouldFail = true;
      service.appendFiles = async (...args) => {
        if (shouldFail) {
          shouldFail = false;
          throw Object.assign(new Error('transient archive EIO'), { code: 'EIO' });
        }
        return appendFiles(...args);
      };
    }
    const outboxStore = createArchiveOutboxStore(outboxRoot);
    let controller;
    controller = createArchiveCenterController({
      database: {
        getSetting: (key) => settings.get(key) || null,
        setSetting: (key, value) => settings.set(key, value),
        listTemplates: () => []
      },
      service,
      outboxStore,
      recoverInterruptedTaskOwners: [{
        ownerName: 'Toolbox',
        recover: () => recoverToolboxPublicationsIntoArchive({
          userDataDir,
          archiveCenter: controller,
          recoverPublications: recoverToolboxPublicationsAsync
        })
      }],
      getProtectedInterruptedTaskBatchIds: () => []
    });
    return { db, service, outboxStore, controller };
  }

  const firstStartup = openStartup({ failFirstAppend: true });
  await assert.rejects(
    firstStartup.controller.initialize(),
    (error) => error && error.code === 'ARCHIVE_STARTUP_OWNER_RECOVERY_FAILED'
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries.length,
    1,
    'transient EIO 后即使 controller 的后置重放成功，也不能提前 ack receipt'
  );
  const blockedGeneration = path.join(generationDir, 'must-not-publish.xlsx');
  fs.writeFileSync(blockedGeneration, 'BLOCKED');
  assert.throws(
    () => prepareToolboxPublication({
      taskId: 'toolbox-must-not-enter-while-handoff-pending',
      artifacts: [validatedPublicationArtifact(blockedGeneration)],
      targets: [{ targetPath }],
      userDataDir
    }),
    /等待存档中心耐久接管/
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'OLD');
  firstStartup.db.close();

  const secondStartup = openStartup();
  await secondStartup.controller.initialize();
  const repository = createArchiveRepository(secondStartup.db);
  const recovered = repository.getBatchDetail(reserved.batchId);
  assert.equal(recovered.taskStatus, 'succeeded');
  assert.equal(recovered.artifacts.length, 3);
  assert.deepEqual(
    recovered.artifacts.map((artifact) => artifact.role).sort(),
    ['input', 'input', 'output']
  );
  assert.ok(recovered.artifacts.every((artifact) => artifact.status === 'ready'));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  const oldOutput = recovered.artifacts.find((artifact) => artifact.role === 'output');
  const oldBlobPath = path.join(archiveRoot, ...oldOutput.blob.relativePath.split('/'));
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');

  const newInput = path.join(inputDir, 'input-new.xlsx');
  const newGeneration = path.join(generationDir, 'new-result.xlsx');
  fs.writeFileSync(newInput, 'INPUT-NEW');
  fs.writeFileSync(newGeneration, 'NEW');
  const newReserved = await secondStartup.service.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:normal-worker-handoff-new',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-normal-worker-new-run',
    parentRunId: 'toolbox-normal-worker-new-parent'
  });
  await secondStartup.service.markTaskStarted(newReserved.batchId);
  const newPublication = await publishToolboxPublicationAsync({
    taskId: 'toolbox-normal-worker-handoff-new-publication',
    artifacts: [validatedPublicationArtifact(newGeneration, 'same-target.xlsx')],
    targets: [{ targetPath }],
    userDataDir,
    batchContext: workerBatchContext(newReserved.batch),
    protectedSourcePaths: [newInput],
    archiveInputFiles: [toolboxInputDescriptor(newInput)]
  });
  await recoverToolboxPublicationsIntoArchive({
    userDataDir,
    archiveCenter: secondStartup.controller,
    recoverPublications: recoverToolboxPublicationsAsync,
    taskIds: [newPublication.taskId]
  });
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(oldBlobPath, 'utf8'), 'OLD');
  secondStartup.db.close();
});

test('工具箱 publication cancel-wins 后迟到 success 不 ACK committed receipt', async () => {
  let acknowledgeCalls = 0;
  let finishCalls = 0;
  const batchContext = {
    batchId: 91,
    batchNumber: '2026-08-18-091',
    taskRunId: 'toolbox-cancel-wins-run',
    taskKey: 'toolbox:merge',
    moduleId: 'toolbox',
    parentRunId: 'toolbox-cancel-wins-parent',
    operationKey: 'toolbox:cancel-wins'
  };
  const recoverPublications = async (options = {}) => {
    if (Array.isArray(options.acknowledgedCommittedTaskIds)) {
      acknowledgeCalls += 1;
      return { recovered: [], skippedActive: [] };
    }
    return {
      recovered: [{
        action: 'commit-handoff-pending',
        taskId: 'toolbox-cancel-wins-publication',
        batchContext,
        inputFiles: [],
        files: []
      }],
      skippedActive: []
    };
  };
  const archiveCenter = {
    persistAppendIntent() {
      throw new Error('manifest publication 不应走 legacy append');
    },
    async flushOutbox() {
      throw new Error('异终态不应触发 outbox ACK 链');
    },
    service: {
      repository: {
        getBatch: () => ({ metadata: { _fileManifest: { artifactKeys: [] } } }),
        getTaskRun: () => ({ taskRunId: batchContext.taskRunId, status: 'running' }),
        getBatchDetail: () => ({
          metadata: { _fileManifest: { artifactKeys: [] } },
          artifacts: []
        })
      },
      async settleManifestArtifacts() {
        return { ok: true, durable: true };
      },
      async finishFileTask() {
        finishCalls += 1;
        return {
          ok: false,
          code: 'ARCHIVE_TASK_STATUS_CONFLICT',
          taskRun: { taskRunId: batchContext.taskRunId, status: 'cancelled' }
        };
      }
    }
  };
  await assert.rejects(
    recoverToolboxPublicationsIntoArchive({
      userDataDir: '/tmp/toolbox-cancel-wins',
      archiveCenter,
      recoverPublications
    }),
    (error) => error
      && error.blocksArchiveStartup === true
      && /终态收口失败/.test(error.message)
  );
  assert.equal(finishCalls, 1);
  assert.equal(acknowledgeCalls, 0);
});

test('恢复索引首读 EIO 时 sweepUnsafe 阻止通用扫尾，二启完成原批次恢复', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-index-eio-recovery-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const inputDir = path.join(root, 'inputs');
  const generationDir = path.join(root, 'generation');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  for (const dir of [userDataDir, outputDir, inputDir, generationDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inputPath = path.join(inputDir, 'input.xlsx');
  const generationPath = path.join(generationDir, 'result.xlsx');
  const targetPath = path.join(outputDir, 'result.xlsx');
  fs.writeFileSync(inputPath, 'INPUT');
  fs.writeFileSync(generationPath, 'OUTPUT');
  const initialDb = new DatabaseSync(dbPath);
  initialDb.exec('PRAGMA foreign_keys = ON;');
  const initialService = createArchiveService({ database: initialDb, rootDir: archiveRoot });
  await initialService.initialize();
  const reserved = await initialService.reserveTaskBatch({
    moduleId: 'toolbox',
    moduleCode: 'TOOLBOX',
    moduleName: '工具箱',
    operationKey: 'toolbox:merge:index-eio',
    taskKey: 'toolbox:merge',
    taskRunId: 'toolbox-index-eio-run',
    parentRunId: 'toolbox-index-eio-parent'
  });
  await initialService.markTaskStarted(reserved.batchId);
  await publishToolboxPublicationAsync({
    taskId: 'toolbox-index-eio-publication',
    artifacts: [validatedPublicationArtifact(generationPath)],
    targets: [{ targetPath }],
    userDataDir,
    batchContext: workerBatchContext(reserved.batch),
    protectedSourcePaths: [inputPath],
    archiveInputFiles: [toolboxInputDescriptor(inputPath)]
  });
  initialDb.close();

  const firstDb = new DatabaseSync(dbPath);
  firstDb.exec('PRAGMA foreign_keys = ON;');
  const firstService = createArchiveService({ database: firstDb, rootDir: archiveRoot });
  const firstOutbox = createArchiveOutboxStore(outboxRoot);
  const settings = new Map();
  let sweepCalls = 0;
  let failIndexRead = true;
  const readRecoveryBatchIds = buildToolboxRecoveryBatchIdsReader({
    ...fs,
    readFileSync(filePath, ...args) {
      if (failIndexRead
          && path.resolve(filePath) === path.resolve(userDataDir, JOURNAL_INDEX_NAME)) {
        failIndexRead = false;
        throw Object.assign(new Error('toolbox recovery index read EIO'), { code: 'EIO' });
      }
      return fs.readFileSync(filePath, ...args);
    }
  });
  firstService.markInterruptedTasks = async () => {
    sweepCalls += 1;
    return { ok: true, taskCount: 1, batchIds: [reserved.batchId] };
  };
  const firstController = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value),
      listTemplates: () => []
    },
    service: firstService,
    outboxStore: firstOutbox,
    getProtectedInterruptedTaskBatchIds: () => readRecoveryBatchIds(userDataDir)
  });
  await assert.rejects(
    firstController.initialize(),
    (error) => error && error.code === 'ARCHIVE_STARTUP_RECOVERY_EVIDENCE_UNAVAILABLE'
  );
  assert.equal(sweepCalls, 0);
  assert.equal(createArchiveRepository(firstDb).getBatch(reserved.batchId).taskStatus, 'running');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries.length,
    1
  );
  firstDb.close();

  const secondDb = new DatabaseSync(dbPath);
  secondDb.exec('PRAGMA foreign_keys = ON;');
  const secondService = createArchiveService({ database: secondDb, rootDir: archiveRoot });
  const secondOutbox = createArchiveOutboxStore(outboxRoot);
  let secondController;
  secondController = createArchiveCenterController({
    database: {
      getSetting: (key) => settings.get(key) || null,
      setSetting: (key, value) => settings.set(key, value),
      listTemplates: () => []
    },
    service: secondService,
    outboxStore: secondOutbox,
    recoverInterruptedTaskOwners: [{
      ownerName: 'Toolbox',
      recover: () => recoverToolboxPublicationsIntoArchive({
        userDataDir,
        archiveCenter: secondController,
        recoverPublications: recoverToolboxPublicationsAsync
      })
    }],
    getProtectedInterruptedTaskBatchIds: () => readRecoveryBatchIds(userDataDir)
  });
  await secondController.initialize();
  const recovered = createArchiveRepository(secondDb).getBatchDetail(reserved.batchId);
  assert.equal(recovered.taskStatus, 'succeeded');
  assert.equal(recovered.artifacts.length, 2);
  assert.ok(recovered.artifacts.every((artifact) => artifact.status === 'ready'));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  secondDb.close();
});

test('split read context 新读覆盖旧读，取消导出可重试同一 token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-read-context-'));
  const sourcePath = path.join(root, 'source.xlsx');
  fs.writeFileSync(sourcePath, 'first');
  const harness = buildSplitReadContextHarness();
  try {
    const first = harness.createToolboxSplitReadContext(sourcePath);
    const payload = { sourceFilePath: sourcePath, splitReadToken: first.token };
    assert.equal(harness.requireToolboxSplitReadContext(payload), first);
    assert.equal(harness.requireToolboxSplitReadContext(payload), first);

    const second = harness.createToolboxSplitReadContext(sourcePath);
    assert.throws(
      () => harness.requireToolboxSplitReadContext(payload),
      /准备信息已失效/
    );
    assert.equal(harness.requireToolboxSplitReadContext({
      sourceFilePath: sourcePath,
      splitReadToken: second.token
    }), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('split export freshness 发现源变化后清除 token，要求重新选择', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-read-freshness-'));
  const sourcePath = path.join(root, 'source.xlsx');
  fs.writeFileSync(sourcePath, 'before');
  const harness = buildSplitReadContextHarness();
  try {
    const context = harness.createToolboxSplitReadContext(sourcePath);
    const payload = { sourceFilePath: sourcePath, splitReadToken: context.token };
    fs.appendFileSync(sourcePath, '-changed');

    assert.throws(
      () => harness.assertToolboxSplitSourceFresh(context, {
        filePath: sourcePath,
        sourceSnapshot: context.snapshot
      }),
      /读取后已变化/
    );
    assert.throws(
      () => harness.requireToolboxSplitReadContext(payload),
      /准备信息已失效/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
