// rows CSV 跨阶段回归装配：真实 Main 函数、生产策略、Supervisor、Worker 与 Publisher。
// 仅注入平台身份、内存采样、对话框及归档回执；不修改生产装配入口。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const ExcelJS = require('exceljs');
const { loadProductionMemoryProfiles } = require('./production-memory-policy');
const { createTestPublicationHarness } = require('./publication-authority');
const { createToolboxSplitReadOwner } = require('../../src/main-process/toolbox-split-read-owner');
const { prepareRows, generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
const { publicResult } = require('../../src/main-process/toolbox-row-split/contracts');
const { prepareIpcTaskInvocation, createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('../../src/main-process/archive-center/source-snapshot');
const { pathsAlias } = require('../../src/main-process/toolbox-target-identity');
const { toolboxRecoveryOutputFiles } = require('../../src/main-process/toolbox-archive-recovery');
const { createWorkerThreadAdapter } = require('../../src/main-process/background-execution/adapters/worker-thread-adapter');
const { registerWithMemoryActivity, sealMemoryActivityInventory, memoryActivitySnapshot } = require('../../src/main-process/memory-activity');
const { createPublicationMemoryAdmission } = require('../../src/main-process/execution-descriptors/publication-memory');
const main = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8').replace(/\r\n/g, '\n');
function section(startText, endText) {
  const start = main.indexOf(startText), end = main.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Main section missing: ${startText}`);
  return main.slice(start, end);
}
const mainFunctions = [
  section('function toolboxFailureResult(', 'const EMPTY_TOOLBOX_WARNING_SUMMARY'),
  section('async function publishToolboxArtifacts(', 'function captureToolboxTargetSnapshot('),
  section('function assertToolboxTargetsDoNotAliasSources(', 'async function recoverToolboxPublicationsAtStartup('),
  section("ipcMain.handle('toolbox:split:read'", '  // IPC 3'),
  section("trackedIpcHandle('toolbox:split:export'", '\n}\n\n// v2.0.0-beta.4')
].join('\n');
const MiB = 1024 ** 2;
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(check) {
  for (let n = 0; n < 200 && !check(); n++) await tick();
  assert.ok(check(), '等待测试边界超时');
}
async function withRowsCsv(options, run) {
  sealMemoryActivityInventory();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-csv-admission-')));
  const output = path.join(root, 'output'), userData = path.join(root, 'userdata'), source = path.join(root, 'input.csv');
  let runtime, owner, observe;
  const grants = [], starts = [], exits = [], workerLimits = [], cleanup = [], workers = [];
  try {
    fs.mkdirSync(output); fs.mkdirSync(userData);
    if (options.createSource) await options.createSource(source);
    else if (options.dense) {
      const fd = fs.openSync(source, 'wx');
      try {
        fs.writeSync(fd, 'a,b,c,d,e,f,g,h\n');
        const chunk = Buffer.from('1,2,3,4,5,6,7,8\n'.repeat(10000));
        for (let n = 0; n < 150; n++) fs.writeSync(fd, chunk);
      } finally { fs.closeSync(fd); }
      assert.equal(fs.statSync(source).size, 24000016);
    } else fs.writeFileSync(source, options.content ?? '编号,金额\n0001,12\n0002,13\n0003,14\n');
    const state = { availableMiB: options.availableMiB ?? 2048, publisherCalls: 0, settled: 0 };
    const profiles = loadProductionMemoryProfiles({ runtime: { platform: 'win32', arch: 'x64', versions: { electron: '36.9.5' } },
      ...(options.pending ? { qualification: { schemaVersion: 2, status: 'pending' } } : {}),
      sampleMemory: () => ({ availableBytes: state.availableMiB * MiB, sampledAt: Date.now() }) });
    const filename = path.resolve(__dirname, '../../src/main-process/execution-descriptors/composition.js');
    const localRequire = createRequire(filename), module = { exports: {} };
    vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename })(
      (name) => name === './memory-profiles' ? profiles : localRequire(name), module, module.exports, filename, path.dirname(filename));
    const adapter = createWorkerThreadAdapter();
    runtime = module.exports.createBackgroundExecutionRuntime({ availableParallelism: 4,
      freeMemoryBytes: 8 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3, memoryHardCeilingBytes: (options.hardMiB ?? 2048) * MiB,
      diagnostics(entry) { if (entry.type === 'resource-granted' && entry.memoryProfile) grants.push(entry); },
      workerThreadAdapter: { start(args) {
        if (options.forceRowsLow) args = { ...args, memoryConfig: profiles.profile('rows-generation', 'low', 'reader-guard-fixture') };
        starts.push({ memoryConfig: args.memoryConfig });
        options.beforeWorker?.({ source, args, state });
        return adapter.start(args);
      } } });
    const publication = createTestPublicationHarness(userData, { acquireMemory: createPublicationMemoryAdmission(() => runtime) });
    let contract;
    const ipcHandlers = new Map();
    const ipcMain = { handle(name, callback) { ipcHandlers.set(name, callback); } };
    const scope = {
      fs: { ...fs, rmSync(file, flags) {
        if (path.dirname(file) === output && path.basename(file).startsWith('.toolbox-rows-')) cleanup.push(fs.readdirSync(file).sort());
        return fs.rmSync(file, flags);
      } }, path, randomUUID, pathsAlias, sourceSnapshotFromStat, sourceSnapshotMatchesStat, createToolboxSplitReadOwner, ipcMain,
      trackedIpcHandle(_channel, _scope, _label, value) { contract = value; }, app: { getPath: () => userData }, mainWindow: null,
      statementFileDialogFilters: () => [], showImportOpenDialog: async (key) => ({ canceled: false,
        filePaths: [key === 'toolbox-split-export-directory' ? output : source] }),
      dialog: { showMessageBox: async () => ({ response: 1 }) }, prepareToolboxRows: prepareRows, generateValidateAndPublishRows,
      backgroundExecutionRuntimeManager: { get: () => runtime },
      async publishToolboxPublicationAsync(value) {
        state.publisherCalls++;
        return publication.dispatcher.publish({ ...value, requireArchiveHandoff: true, requireValidatedArtifacts: true });
      }, recoverArchivePublications: publication.recovery.recover,
      toolboxRowsPublicResult: publicResult, toolboxFinalOutputFiles: toolboxRecoveryOutputFiles,
      appendActivityLogEntry: () => {}, buildToolboxAuditDetailLines: () => []
    };
    let helpers;
    registerWithMemoryActivity(ipcMain, () => { helpers = Function(...Object.keys(scope), mainFunctions +
      '\nreturn { getToolboxSplitReadOwner };')(...Object.values(scope)); });
    owner = helpers.getToolboxSplitReadOwner();
    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }), event = { sender };
    observe = (worker) => {
      workers.push(worker);
      workerLimits.push({ ...worker.resourceLimits });
      worker.once('exit', (code) => exits.push(code));
    };
    process.on('worker', observe);
    const scan = () => ipcHandlers.get('toolbox:split:read')(event, { version: 2, scanKind: 'metadata', requestId: 'rows-csv' });
    async function prepare(metadata, rowsPerFile = Math.ceil(metadata.dataRowCount / 2), extra = {}) {
      const prepared = await prepareIpcTaskInvocation(contract, event, [{ sourceFilePath: source,
        splitReadToken: metadata.splitReadToken, mode: 'rows', rowsPerFile, ...extra }]);
      if (!prepared.proceed) return { prepared };
      const fileEvidence = { filePlan: prepared.filePlan, inputFiles: prepared.filePlan.inputs,
        targetSnapshots: prepared.filePlan.outputs.map((item) => item.targetSnapshot) };
      const batchContext = { batchId: 1, batchNumber: 'ROWS-CSV-TEST', taskRunId: randomUUID(),
        taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-csv-parent', operationKey: randomUUID() };
      prepared.beforeStart(batchContext, fileEvidence);
      const context = createIpcTaskContext(batchContext, { fileEvidence, async settleArtifacts() { state.settled++; return { durable: true }; } });
      return { prepared, execute: () => contract.execute(event, prepared, context) };
    }
    return await run({ root, source, output, userData, state, runtime, owner, grants, starts, exits, workerLimits,
      cleanup, workers, scan, prepare, hash, publication });
  } finally {
    if (observe) process.off('worker', observe);
    const [closed] = await Promise.allSettled([owner?.close()]);
    const [shutdown] = await Promise.allSettled([runtime?.shutdown()]);
    try {
      assert.equal(closed.status, 'fulfilled'); assert.equal(shutdown.status, 'fulfilled');
      if (owner) { assert.equal(closed.value.closed, true); assert.equal(closed.value.cleanupPendingCount, 0); }
      if (runtime) {
        assert.equal(runtime.resourceGovernor.snapshot().activeLeaseCount, 0);
        assert.equal(runtime.resourceGovernor.snapshot().queued.size, 0);
      }
      assert.ok(workers.every((worker) => worker.threadId === -1));
      if (runtime) assert.deepEqual(shutdown.value.leakedTransports, []);
      assert.deepEqual(memoryActivitySnapshot().blockers, []);
      assert.ok((fs.existsSync(output) ? fs.readdirSync(output) : []).every((name) => !name.startsWith('.toolbox-rows-')));
      const scans = path.join(userData, 'toolbox-scan-temp');
      assert.deepEqual(fs.existsSync(scans) ? fs.readdirSync(scans) : [], []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
async function readOutputRows(result) {
  const rows = [];
  for (const file of result.files) {
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file.filePath);
    for (const sheet of book.worksheets) for (let n = 2; n <= sheet.rowCount; n++) rows.push(sheet.getRow(n).values.slice(1));
  }
  return rows;
}
module.exports = { withRowsCsv, waitFor, readOutputRows };
