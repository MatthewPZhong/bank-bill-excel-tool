'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  recoverToolboxPublicationsAsync
} = require('../../../src/main-process/toolbox-output-publication-dispatch');
const { DatabaseSync } = require('node:sqlite');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8').replace(/\r\n?/g, '\n');

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

  assert.ok(!readSource.includes("trackedIpcHandle('toolbox:split:read'"));
  assert.ok(!readSource.includes('batchContext'));
  assert.ok(mergePrepareSource.includes('showImportOpenDialog'));
  assert.ok(mergePrepareSource.includes('showSaveDialog'));
  assert.ok(mergePrepareSource.match(/proceed: false/g).length >= 2);
  assert.ok(!mergePrepareSource.includes('toolboxMergeFilesToXlsx'));
  assert.ok(mergeSource.indexOf('toolboxMergeFilesToXlsx') > mergeExecute);
  assert.ok(exportPrepareSource.includes("showImportOpenDialog('toolbox-split-export-directory'"));
  assert.ok(exportPrepareSource.includes('showSaveDialog'));
  assert.ok(exportPrepareSource.match(/proceed: false/g).length >= 4);
  assert.ok(!exportPrepareSource.includes('exportToolboxFilter'));
  assert.ok(exportSource.indexOf('exportToolboxFilter') > exportExecute);
});

test('after-committed 崩溃首次启动即把输出接管到原批次，第二次启动保持幂等', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-archive-startup-recovery-'));
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  const archiveRoot = path.join(root, 'archive');
  const outboxRoot = path.join(userDataDir, 'run-data', 'archive-center', 'outbox');
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  for (const directory of [userDataDir, outputDir, generationDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
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
  const bytes = fs.readFileSync(generationPath);
  const prepared = prepareToolboxPublication({
    taskId: 'toolbox-after-committed-recovery',
    artifacts: [{
      sourcePath: generationPath,
      byteSize: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      fileName: 'result.xlsx'
    }],
    targets: [targetPath],
    userDataDir,
    batchContext,
    archiveInputFiles: [],
    allowEmptyArchiveInputs: true,
    requireArchiveHandoff: true,
    requireValidatedArtifacts: true,
    checkpoint(name) {
      if (name === 'publish:after-committed') throw new ToolboxPublicationCrashError(name);
    }
  });
  assert.throws(() => publishPreparedToolboxPublication(prepared), ToolboxPublicationCrashError);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'committed toolbox output');
  initialDb.close();

  const openStartup = () => {
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
      getProtectedInterruptedTaskBatchIds: () => []
    });
    return { db, controller, outboxStore };
  };

  const first = openStartup();
  await first.controller.initialize();
  const firstDetail = createArchiveRepository(first.db).getBatchDetail(reserved.batchId);
  assert.equal(firstDetail.taskStatus, 'succeeded');
  assert.equal(firstDetail.artifacts.length, 1);
  assert.equal(firstDetail.artifacts[0].status, 'ready');
  assert.equal(firstDetail.artifacts[0].role, 'output');
  assert.equal(first.outboxStore.list().length, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries,
    []
  );
  first.db.close();

  const second = openStartup();
  await second.controller.initialize();
  const secondDetail = createArchiveRepository(second.db).getBatchDetail(reserved.batchId);
  assert.equal(secondDetail.taskStatus, 'succeeded');
  assert.equal(secondDetail.artifacts.length, 1);
  second.db.close();
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
      () => harness.assertToolboxSplitSourceFresh(context),
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
