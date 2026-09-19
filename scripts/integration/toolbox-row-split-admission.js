'use strict';

// 隔离集成：使用 Main 的实际 rows prepare/execute、真实 Runtime/Governor、
// rows Worker 和 Publisher Worker。原生目录/覆盖对话框、TaskLifecycle 的批次身份与
// settleArtifacts 耐久回执是夹具；不启动 Electron 桌面，不验证归档数据库持久化。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const ExcelJS = require('exceljs');
const { createBackgroundExecutionRuntime } = require('../../src/main-process/background-execution/runtime');
const { scanToolboxSplitFields } = require('../../src/main-process/toolbox-format-operations');
const { prepareRows, generateValidateAndPublishRows } = require('../../src/main-process/toolbox-row-split/service');
const { publicResult, buildRowTargets, planRowCounts } = require('../../src/main-process/toolbox-row-split/contracts');
const { ROWS_POLICY } = require('../../src/main-process/toolbox-row-split/policy');
const { prepareIpcTaskInvocation, createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('../../src/main-process/archive-center/source-snapshot');
const { pathsAlias } = require('../../src/main-process/toolbox-target-identity');
const { publishToolboxPublicationAsync } = require('../../src/main-process/toolbox-output-publication-dispatch');
const { toolboxRecoveryOutputFiles } = require('../../src/main-process/toolbox-archive-recovery');

// 只在内存统一 Git checkout 换行；执行当前源码，避免复制一份 Main rows 实现。
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8').replace(/\r\n/g, '\n');
function section(startText, endText) {
  const start = mainSource.indexOf(startText), end = mainSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Main section missing: ${startText}`);
  return mainSource.slice(start, end);
}
const mainFunctions = [
  section('function toolboxFailureResult(', 'const EMPTY_TOOLBOX_WARNING_SUMMARY'),
  section('async function publishToolboxArtifacts(', 'function captureToolboxTargetSnapshot('),
  section('function assertToolboxTargetsDoNotAliasSources(', 'async function recoverToolboxPublicationsAtStartup('),
  section("trackedIpcHandle('toolbox:split:export'", '\n}\n\n// v2.0.0-beta.4')
].join('\n');
const MIB = 1024 ** 2;
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function writeBook(file, rows) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('流水');
  sheet.addRow(['序号', '编号']); rows.forEach((row) => sheet.addRow(row));
  sheet.getColumn(2).numFmt = '@'; await book.xlsx.writeFile(file);
}
async function readRows(file) {
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file);
  const rows = [];
  for (const sheet of book.worksheets) {
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['序号', '编号']);
    for (let row = 2; row <= sheet.rowCount; row++) rows.push(sheet.getRow(row).values.slice(1));
  }
  return rows;
}

async function runCase(memoryBytes, shouldSucceed) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-admission-')));
  const outputDirectory = path.join(directory, 'output'), userDataDir = path.join(directory, 'userdata');
  fs.mkdirSync(outputDirectory); fs.mkdirSync(userDataDir);
  const diagnostics = [], workers = [], cleanup = [], activity = [];
  const runtime = createBackgroundExecutionRuntime({ availableParallelism: 4, freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3, memoryHardCeilingBytes: memoryBytes,
    diagnostics: (event) => diagnostics.push(event) });
  const observeWorker = (worker) => workers.push({ threadId: worker.threadId });
  let publisherCalls = 0, settleCalls = 0, overwriteCalls = 0;
  try {
    assert.equal(runtime.resourceGovernor.snapshot().budgets.memoryBytes, memoryBytes);
    assert.equal(ROWS_POLICY.resources.phase.memoryBytes, 1024 * MIB);
    const sourcePath = path.join(directory, 'source.xlsx');
    const expectedRows = [[1, '00001'], [2, '00002'], [3, '00003'], [4, '00004'], [5, '00005']];
    await writeBook(sourcePath, expectedRows);
    const oldTarget = buildRowTargets(sourcePath, outputDirectory, planRowCounts(5, 2))[0].filePath;
    await writeBook(oldTarget, [[99, '已有目标，失败时保留']]);
    const sourceHash = hashFile(sourcePath), oldHash = hashFile(oldTarget);
    const scan = await scanToolboxSplitFields(sourcePath); assert.equal(scan.dataRowCount, 5);
    let contract;
    const scope = {
      fs: { ...fs, rmSync(file, options) {
        if (path.dirname(file) === outputDirectory && path.basename(file).startsWith('.toolbox-rows-')) {
          cleanup.push({ path: file, files: fs.readdirSync(file).sort() });
        }
        return fs.rmSync(file, options);
      } },
      path, randomUUID, pathsAlias, sourceSnapshotFromStat, sourceSnapshotMatchesStat,
      trackedIpcHandle(channel, _scope, _label, value) { assert.equal(channel, 'toolbox:split:export'); contract = value; },
      app: { getPath: () => userDataDir }, mainWindow: null,
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [outputDirectory] }),
      dialog: { async showMessageBox(_window, options) {
        overwriteCalls++; assert.equal(options.title, '文件已存在'); return { response: 1 };
      } },
      prepareToolboxRows: prepareRows, generateValidateAndPublishRows,
      backgroundExecutionRuntimeManager: { get: () => runtime },
      async publishToolboxPublicationAsync(options) {
        publisherCalls++; return publishToolboxPublicationAsync(options);
      },
      toolboxRowsPublicResult: publicResult, toolboxFinalOutputFiles: toolboxRecoveryOutputFiles,
      appendActivityLogEntry: (entry) => activity.push(entry), buildToolboxAuditDetailLines: () => []
    };
    const helpers = Function(...Object.keys(scope), mainFunctions + '\nreturn { createToolboxSplitReadContext };')(...Object.values(scope));
    const readContext = helpers.createToolboxSplitReadContext(sourcePath, scan.dataRowCount);
    const prepared = await prepareIpcTaskInvocation(contract, {}, [{ sourceFilePath: sourcePath,
      splitReadToken: readContext.token, mode: 'rows', rowsPerFile: 2 }]);
    assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
    assert.equal(overwriteCalls, 1, '失败场景也须覆盖已确认的旧目标');
    assert.equal(prepared.filePlan, prepared.rows.filePlan);
    const fileEvidence = { filePlan: prepared.filePlan, inputFiles: prepared.filePlan.inputs,
      targetSnapshots: prepared.filePlan.outputs.map((file) => file.targetSnapshot) };
    const batchContext = { batchId: 1, batchNumber: 'ROWS-ADMISSION', taskRunId: randomUUID(),
      taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-admission-parent', operationKey: randomUUID() };
    prepared.beforeStart(batchContext, fileEvidence);
    const context = createIpcTaskContext(batchContext, { fileEvidence, async settleArtifacts(evidence) {
      settleCalls++; assert.equal(evidence.files.length, 4); return { durable: true };
    } });
    process.on('worker', observeWorker);
    const started = process.hrtime.bigint();
    const result = await contract.execute({}, prepared, context);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.off('worker', observeWorker);
    assert.equal(hashFile(sourcePath), sourceHash); assert.deepEqual(await readRows(sourcePath), expectedRows);
    assert.equal(cleanup.length, 1, '必须由 Main finally 清理本次私有目录');
    assert.equal(fs.existsSync(cleanup[0].path), false);
    const governor = runtime.resourceGovernor.snapshot();
    assert.equal(governor.activeLeaseCount, 0); assert.equal(governor.queued.size, 0);
    if (!shouldSucceed) {
      assert.equal(result.status, 'failed', JSON.stringify(result));
      assert.equal(result.code, 'RESOURCE_BUDGET_UNAVAILABLE');
      assert.match(result.message, /按行拆分/); assert.match(result.message, /内存|资源/);
      assert.ok(!/Admission timed out|Resource budget cannot admit/.test(result.message));
      assert.ok(Array.isArray(result.detailLines) && result.detailLines.length > 0);
      assert.ok(result.detailLines.every((line) => typeof line === 'string'));
      assert.ok(result.detailLines.some((line) => line.startsWith('申请资源：') && line.includes('1,024.000 MiB')));
      assert.ok(result.detailLines.some((line) => line.startsWith('总预算：') && line.includes('768.000 MiB')));
      assert.ok(result.detailLines.every((line) => !line.includes('[redacted')));
      const rejected = diagnostics.find((event) => event.type === 'resource-admission-failed');
      assert.equal(rejected?.admission?.reason, 'total-budget-insufficient');
      assert.equal(rejected.admission.required.memoryBytes, 1024 * MIB);
      assert.equal(rejected.admission.budgets.memoryBytes, memoryBytes);
      assert.equal(governor.diagnostics.granted, 0);
      assert.ok(elapsedMs < 2000, `永久不足必须立即拒绝，实际耗时 ${elapsedMs.toFixed(1)} ms`);
      assert.equal(workers.length, 0, '预算不足不能创建任何 Worker');
      assert.equal(publisherCalls, 0); assert.equal(settleCalls, 0);
      assert.deepEqual(cleanup[0].files, ['plan.json'], 'Worker 不能创建缓存、输出或产物清单');
      assert.equal(hashFile(oldTarget), oldHash);
      assert.deepEqual(fs.readdirSync(outputDirectory), [path.basename(oldTarget)]);
      assert.deepEqual(fs.readdirSync(userDataDir), []);
      process.stdout.write(`PASS 768 MiB 预算立即拒绝 1 GiB rows：${elapsedMs.toFixed(1)} ms，零 Worker/Publisher，原件和旧目标保留\n`);
    } else {
      assert.equal(result.status, 'success', JSON.stringify(result)); assert.equal(result.files.length, 3);
      assert.ok(workers.length >= 2, '必须实际创建 rows Worker 和发布 Worker');
      assert.equal(publisherCalls, 1); assert.equal(settleCalls, 1);
      assert.ok(cleanup[0].files.includes('rows.sqlite') && cleanup[0].files.includes('outputs.json'));
      const actualRows = [];
      for (const [index, output] of prepared.filePlan.outputs.entries()) {
        const rows = await readRows(output.filePath); assert.equal(rows.length, index < 2 ? 2 : 1); actualRows.push(...rows);
      }
      assert.deepEqual(actualRows, expectedRows); assert.notEqual(hashFile(oldTarget), oldHash);
      assert.equal(activity.some((entry) => entry.level === 'error'), false, JSON.stringify(activity));
      process.stdout.write('PASS 充足预算下真实 rows Worker 生成三份、真实 Publisher 发布、2/2/1 行独立回读\n');
    }
  } finally {
    process.off('worker', observeWorker);
    await runtime.shutdown(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function run() {
  await runCase(768 * MIB, false);
  await runCase(2 * 1024 ** 3, true);
  process.stdout.write('2/2 PASS toolbox rows Main → Runtime → Governor admission\n');
}
run().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
