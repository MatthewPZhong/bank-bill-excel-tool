'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');
const { assertFilePlanFresh } = require('../../../src/main-process/archive-center/file-plan');
const { prepareIpcTaskInvocation } = require('../../../src/main-process/archive-center/ipc-task-contract');
const { prepareRows, generateValidateAndPublishRows } = require('../../../src/main-process/toolbox-row-split/service');
const { executeRowsGeneration } = require('../../../src/main-process/toolbox-row-split/executor');
const { publicResult } = require('../../../src/main-process/toolbox-row-split/contracts');
const { publishToolboxPublicationAsync } = require('../../../src/main-process/toolbox-output-publication-dispatch');

const main = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
function section(startText, endText) {
  const start = main.indexOf(startText);
  const end = main.indexOf(endText, start);
  assert.ok(start >= 0 && end > start);
  return main.slice(start, end);
}
const mainFunctions = [
  section('function toolboxFailureResult(', 'const EMPTY_TOOLBOX_WARNING_SUMMARY'),
  section('async function publishToolboxArtifacts(', 'async function acknowledgeToolboxPublicationReceipts'),
  section("trackedIpcHandle('toolbox:split:export'", '\n}\n\n// v2.0.0-beta.4')
].join('\n');

const batchContext = { batchId: 1, batchNumber: 'ROWS-PARENT', taskRunId: 'rows-parent-run',
  taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-parent', operationKey: 'rows-operation' };

for (const stage of ['before-generation', 'before-publication', 'unchanged']) {
  test(`rows 父目录身份贯穿真实 Main execute 与 Worker Publisher：${stage}`, async (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-parent-test-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'source.csv');
    fs.writeFileSync(source, 'A\n1\n2\n');
    const output = path.join(directory, 'chosen');
    const moved = path.join(directory, 'chosen-moved');
    const userDataDir = path.join(directory, 'user-data');
    fs.mkdirSync(output); fs.mkdirSync(userDataDir);
    fs.writeFileSync(path.join(output, 'original.txt'), 'keep-original');
    const readContext = { sourceFilePath: source, dataRowCount: 2,
      snapshot: sourceSnapshotFromStat(fs.statSync(source)) };
    const payload = { sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 };
    let contract, filePlan, publicationOptions, publicationError;
    let generationCalls = 0, publicationCalls = 0, settleCalls = 0;
    const replaceParent = () => {
      fs.renameSync(output, moved);
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'new-owner.txt'), 'keep-new-owner');
      assert.notEqual(String(fs.statSync(output, { bigint: true }).ino), filePlan.outputs[0].targetParentIdentity.inode);
      assert.throws(() => assertFilePlanFresh(filePlan), { code: 'ARCHIVE_TARGET_PARENT_CHANGED' });
    };
    const scope = {
      fs, path, randomUUID,
      trackedIpcHandle: (_channel, _scope, _name, value) => { contract = value; },
      requireToolboxSplitReadContext: () => readContext, prepareToolboxRows: prepareRows,
      app: { getPath: () => userDataDir }, mainWindow: null,
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [output] }),
      dialog: { showMessageBox: async () => { throw new Error('两个正式目标应均不存在'); } },
      assertToolboxTargetsDoNotAliasSources: (inputs, outputs) => assert.ok(outputs.every((item) => !inputs.includes(item))),
      generateValidateAndPublishRows,
      publishToolboxPublicationAsync: async (options) => {
        publicationCalls += 1;
        publicationOptions = options;
        // 全部产物已校验、Main wrapper 已组装请求，尚未进入 Worker 发布。
        // 连同原生产布局下的 generation 目录一起重命名，不迁移临时产物来绕过检查。
        if (stage === 'before-publication') replaceParent();
        try { return await publishToolboxPublicationAsync(options); }
        catch (error) { publicationError = error; throw error; }
      },
      backgroundExecutionRuntimeManager: { get: () => ({ async execute(request) {
        generationCalls += 1;
        return { outcome: 'completed', terminalSource: 'job:done', result: await executeRowsGeneration(request.input) };
      } }) },
      clearToolboxSplitReadContext: () => {}, appendActivityLogEntry: () => {}, buildToolboxAuditDetailLines: () => [],
      toolboxFinalOutputFiles: (files) => files, toolboxRowsPublicResult: publicResult
    };
    // 系统对话框、调度及归档结算为替身；执行 Main 原始 prepare/execute、发布 wrapper 和清理逻辑。
    Function(...Object.keys(scope), mainFunctions)(...Object.values(scope));
    const prepared = await prepareIpcTaskInvocation(contract, {}, [payload]);
    assert.equal(prepared.proceed, true);
    filePlan = prepared.filePlan;
    assertFilePlanFresh(filePlan);
    if (stage === 'before-generation') replaceParent();
    const result = await contract.execute({}, prepared, { batchContext,
      fileEvidence: { filePlan, inputFiles: filePlan.inputs, targetSnapshots: filePlan.outputs.map((item) => item.targetSnapshot) },
      settleArtifacts: async () => { settleCalls += 1; return { durable: true }; } });
    assert.equal(generationCalls, 1);
    assert.equal(publicationCalls, 1);
    assert.equal(fs.readFileSync(source, 'utf8'), 'A\n1\n2\n');

    if (stage === 'unchanged') {
      assert.equal(result.status, 'success');
      assert.equal(settleCalls, 1);
      assert.equal(result.files.length, 2);
      const journalName = fs.readdirSync(output).find((name) => name.endsWith('.journal.json'));
      assert.ok(journalName, '归档结算前保留原 Publisher receipt');
      const journal = JSON.parse(fs.readFileSync(path.join(output, journalName), 'utf8'));
      assert.equal(journal.entries.length, 2);
      for (const [index, item] of filePlan.outputs.entries()) {
        assert.deepEqual(journal.entries[index].expectedTargetParentIdentity, item.targetParentIdentity);
        assert.equal(publicationOptions.targets[index].expectedTargetParentIdentity, item.targetParentIdentity);
        const book = new ExcelJS.Workbook();
        await book.xlsx.readFile(item.filePath);
        assert.equal(book.worksheets[0].getCell('A1').value, 'A');
        assert.equal(String(book.worksheets[0].getCell('A2').value), String(index + 1));
      }
      assert.equal(fs.readFileSync(path.join(output, 'original.txt'), 'utf8'), 'keep-original');
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(publicationError && publicationError.code, 'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED');
      assert.equal(settleCalls, 0);
      assert.deepEqual(fs.readdirSync(output), ['new-owner.txt']);
      assert.equal(fs.readFileSync(path.join(output, 'new-owner.txt'), 'utf8'), 'keep-new-owner');
      assert.equal(fs.readFileSync(path.join(moved, 'original.txt'), 'utf8'), 'keep-original');
      for (const item of filePlan.outputs) {
        assert.equal(fs.existsSync(item.filePath), false);
        assert.equal(fs.existsSync(path.join(moved, path.basename(item.filePath))), false);
      }
    }
  });
}
