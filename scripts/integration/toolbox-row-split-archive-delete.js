'use strict';

// 隔离集成：执行 Main 实际 rows prepare/execute、发布与 ACK helper；系统对话框、
// 业务准入和流程跟踪使用夹具，未启动 Electron 桌面。生成和发布均使用真实 Worker。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');
const { prepareIpcTaskInvocation, createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('../../src/main-process/archive-center/source-snapshot');
const { pathsAlias } = require('../../src/main-process/toolbox-target-identity');
const { createBackgroundExecutionRuntime } = require('../../src/main-process/background-execution/runtime');
const { scanToolboxSplitFields } = require('../../src/main-process/toolbox-format-operations');
const { prepareRows, generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
const { publicResult } = require('../../src/main-process/toolbox-row-split/contracts');
const { publishToolboxPublicationAsync, recoverToolboxPublicationsAsync } = require('../../src/main-process/toolbox-output-publication-dispatch');
const { JOURNAL_INDEX_NAME } = require('../../src/main-process/toolbox-output-publication');
const { acknowledgeToolboxPublicationReceipts: acknowledgeToolboxPublicationReceiptsIntoArchive,
  recoverToolboxPublicationsIntoArchive, toolboxRecoveryOutputFiles } = require('../../src/main-process/toolbox-archive-recovery');

const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
function section(startText, endText) {
  const start = mainSource.indexOf(startText);
  const end = mainSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Main section missing: ${startText}`);
  return mainSource.slice(start, end);
}
const mainFunctions = [
  section('function toolboxFailureResult(', 'const EMPTY_TOOLBOX_WARNING_SUMMARY'),
  section('async function publishToolboxArtifacts(', 'function captureToolboxTargetSnapshot('),
  section('function assertToolboxTargetsDoNotAliasSources(', 'async function recoverToolboxPublicationsAtStartup('),
  section("trackedIpcHandle('toolbox:split:export'", '\n}\n\n// v2.0.0-beta.4')
].join('\n');

function fileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function readRows(filePath) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(filePath);
  const rows = [];
  for (const sheet of book.worksheets) {
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['序号', '编号']);
    for (let index = 2; index <= sheet.rowCount; index += 1) {
      rows.push(sheet.getRow(index).values.slice(1));
    }
  }
  return rows;
}

async function run() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-archive-delete-')));
  const archiveRoot = path.join(directory, 'archive');
  const userDataDir = path.join(directory, 'userdata');
  const outputDirectory = path.join(directory, 'output');
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(outputDirectory);
  const dbPath = path.join(directory, 'archive.sqlite');
  let db = new DatabaseSync(dbPath);
  let service;
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 });
  try {
    service = createArchiveService({ database: db, rootDir: archiveRoot });
    assert.equal((await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const outboxStore = createArchiveOutboxStore(path.join(directory, 'outbox'));
    const controller = createArchiveCenterController({ service, outboxStore,
      database: { getSetting: () => null, setSetting() {} } });
    const sourcePath = path.join(directory, 'source.xlsx');
    const expectedRows = [[1, '00001'], [2, '00002'], [3, '00003'], [4, '00004'], [5, '00005']];
    const sourceBook = new ExcelJS.Workbook();
    const sheet = sourceBook.addWorksheet('流水');
    sheet.addRow(['序号', '编号']);
    expectedRows.forEach((row) => sheet.addRow(row));
    await sourceBook.xlsx.writeFile(sourcePath);
    const sourceHash = fileHash(sourcePath);
    const scan = await scanToolboxSplitFields(sourcePath);
    assert.equal(scan.dataRowCount, expectedRows.length);
    let contract;
    const activity = [];
    const scope = {
      fs, path, randomUUID, pathsAlias, sourceSnapshotFromStat, sourceSnapshotMatchesStat,
      trackedIpcHandle: (channel, _scope, _label, value) => {
        assert.equal(channel, 'toolbox:split:export');
        contract = value;
      },
      app: { getPath: () => userDataDir }, mainWindow: null,
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [outputDirectory] }),
      dialog: { showMessageBox: async () => { throw new Error('新输出目录不应提示覆盖'); } },
      prepareToolboxRows: prepareRows, generateValidateAndPublishRows,
      backgroundExecutionRuntimeManager: { get: () => runtime },
      publishToolboxPublicationAsync, recoverToolboxPublicationsAsync,
      acknowledgeToolboxPublicationReceiptsIntoArchive, recoverToolboxPublicationsIntoArchive,
      archiveCenterService: controller, toolboxFinalOutputFiles: toolboxRecoveryOutputFiles,
      toolboxRowsPublicResult: publicResult,
      appendActivityLogEntry: (entry) => activity.push(entry), buildToolboxAuditDetailLines: () => []
    };
    const helpers = Function(...Object.keys(scope), mainFunctions +
      '\nreturn { createToolboxSplitReadContext, acknowledgeToolboxPublicationReceipts };')(...Object.values(scope));
    const readContext = helpers.createToolboxSplitReadContext(sourcePath, scan.dataRowCount);
    const payload = { sourceFilePath: sourcePath, splitReadToken: readContext.token, mode: 'rows', rowsPerFile: 2 };
    const prepared = await prepareIpcTaskInvocation(contract, {}, [payload]);
    assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
    assert.equal(prepared.filePlan, prepared.rows.filePlan, 'IPC 必须保留确认前的 FilePlan authority');
    const policy = createTaskPolicyRegistry().require('toolbox:split:export');
    assert.equal(policy.taskKey, 'toolbox:split:export');
    const lifecycle = createTaskLifecycle({ archiveService: service,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'rows-archive-delete' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'rows-archive-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (intent) => controller.persistTaskTerminalIntent(intent) });
    let batchContext;
    let afterTerminalCalls = 0;
    const result = await lifecycle.runFileTask({ policy, meta: { channel: policy.channel },
      taskRunId: 'rows-archive-task', operationKey: 'rows-archive-operation',
      filePlanResolver: () => prepared.filePlan, beforeStart: prepared.beforeStart,
      execute: async (context, controls) => {
        batchContext = context;
        assert.equal(context.taskKey, 'toolbox:split:export');
        const generated = await contract.execute({}, prepared, createIpcTaskContext(context, controls));
        assert.equal(generated.status, 'success', JSON.stringify(generated));
        assert.equal(generated.files.length, 3);
        const journals = fs.readdirSync(outputDirectory).filter((name) => name.endsWith('.journal.json'));
        assert.equal(journals.length, 1, '原 owner 收口前保留 publication journal');
        const journal = JSON.parse(fs.readFileSync(path.join(outputDirectory, journals[0]), 'utf8'));
        assert.equal(journal.entries.length, 3);
        for (const [index, output] of prepared.filePlan.outputs.entries()) {
          assert.deepEqual(journal.entries[index].expectedTargetParentIdentity, output.targetParentIdentity);
        }
        return generated;
      },
      afterTerminal: async () => {
        afterTerminalCalls += 1;
        const owner = { version: 1, kind: 'file-batch', batchContext };
        assert.equal(service.repository.getOwnerTerminalCompletion(owner), null);
        const blocked = await controller.prepareDeleteBatch(batchContext.batchId);
        assert.equal(blocked.code, 'ARCHIVE_DELETE_OWNER_COMPLETION_REQUIRED');
        await helpers.acknowledgeToolboxPublicationReceipts(prepared.toolboxPublicationTaskIds);
      }
    });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(afterTerminalCalls, 1);
    assert.equal(activity.some((entry) => entry.level === 'error'), false, JSON.stringify(activity));
    assert.deepEqual(await readRows(sourcePath), expectedRows);
    const concatenated = [];
    const outputHashes = new Map();
    for (const [index, output] of prepared.filePlan.outputs.entries()) {
      const rows = await readRows(output.filePath);
      assert.equal(rows.length, index < 2 ? 2 : 1);
      concatenated.push(...rows);
      outputHashes.set(output.filePath, fileHash(output.filePath));
    }
    assert.deepEqual(concatenated, expectedRows);
    assert.equal(fileHash(sourcePath), sourceHash);
    assert.equal(outboxStore.list().length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDataDir, JOURNAL_INDEX_NAME), 'utf8')).entries, []);
    const artifacts = service.repository.listArtifacts(batchContext.batchId);
    assert.equal(artifacts.length, 4);
    assert.ok(artifacts.every((artifact) => artifact.status === 'ready'));
    const storedPaths = artifacts.flatMap((artifact) => [
      path.join(archiveRoot, artifact.storageRelativePath), path.join(archiveRoot, artifact.blob.relativePath)
    ]);
    assert.ok(storedPaths.every((filePath) => fs.existsSync(filePath)));
    const owner = { version: 1, kind: 'file-batch', batchContext };
    const proof = service.repository.getOwnerTerminalCompletion(owner);
    assert.equal(proof.terminalStatus, 'succeeded');
    assert.equal(proof.afterTerminal, null);
    process.stdout.write('PASS rows Worker 发布、父目录身份、真实归档和原 owner ACK\n');

    // 重新打开数据库确认 completion 已耐久落盘，再走正式删除预检和确认。
    await service.pauseBackgroundMaterialization();
    db.close();
    db = new DatabaseSync(dbPath);
    service = createArchiveService({ database: db, rootDir: archiveRoot });
    assert.equal((await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const reopened = createArchiveCenterController({ service,
      database: { getSetting: () => null, setSetting() {} }, outboxStore });
    assert.deepEqual(service.repository.getOwnerTerminalCompletion(owner), proof);
    const deletion = await reopened.prepareDeleteBatch(batchContext.batchId, { senderId: 329 });
    assert.equal(deletion.ok, true, JSON.stringify(deletion));
    assert.ok(storedPaths.every((filePath) => fs.existsSync(filePath)), '预检不能先删除受管文件');
    const deleted = await reopened.deleteBatch(batchContext.batchId, deletion.confirmationToken, { senderId: 329 });
    assert.equal(deleted.fullyDeleted, true, JSON.stringify(deleted));
    assert.equal(service.repository.getBatch(batchContext.batchId), null);
    assert.ok(storedPaths.every((filePath) => !fs.existsSync(filePath)), '受管输入、输出及 Blob 均应真实移除');
    assert.equal(fileHash(sourcePath), sourceHash, '外部输入原件保持不变');
    for (const [filePath, hash] of outputHashes) assert.equal(fileHash(filePath), hash, '外部正式输出保持不变');
    assert.deepEqual(await readRows(sourcePath), expectedRows);
    const remainingRows = [];
    for (const output of prepared.filePlan.outputs) remainingRows.push(...await readRows(output.filePath));
    assert.deepEqual(remainingRows, expectedRows);
    process.stdout.write('PASS completion 重开可读、删除受管原件与 Blob、外部输入和输出完整保留\n');
    process.stdout.write('2/2 PASS toolbox rows → archive owner completion → permanent delete\n');
  } finally {
    await runtime.shutdown();
    if (service) await service.pauseBackgroundMaterialization();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
