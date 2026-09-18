'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');
const { assertFilePlanFresh } = require('../../../src/main-process/archive-center/file-plan');
const { prepareIpcTaskInvocation } = require('../../../src/main-process/archive-center/ipc-task-contract');
const { prepareRows, generateValidateAndPublishRows } = require('../../../src/main-process/toolbox-row-split/service');
const { executeRowsGeneration } = require('../../../src/main-process/toolbox-row-split/executor');
const { buildRowTargets, planRowCounts } = require('../../../src/main-process/toolbox-row-split/contracts');
const { publishToolboxPublicationAsync } = require('../../../src/main-process/toolbox-output-publication-dispatch');

const mainSource = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const start = mainSource.indexOf("trackedIpcHandle('toolbox:split:export'");
const end = mainSource.indexOf('\n}\n\n// v2.0.0-beta.4', start);
assert.ok(start > 0 && end > start);
const handlerSource = mainSource.slice(start, end);

// 执行真实 Main prepare 和 IPC 冻结入口，仅替换系统对话框及导入上下文。
function fixture(t, confirm = async () => true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rows-overwrite-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input.csv');
  fs.writeFileSync(source, 'A\n1\n2\n');
  const userDataDir = path.join(directory, 'user-data');
  fs.mkdirSync(userDataDir);
  const targets = buildRowTargets(source, directory, planRowCounts(2, 1));
  fs.writeFileSync(targets[0].filePath, 'confirmed-old');
  const readContext = { sourceFilePath: source, dataRowCount: 2,
    snapshot: sourceSnapshotFromStat(fs.statSync(source)) };
  const payload = { sourceFilePath: source, splitReadToken: 't', mode: 'rows', rowsPerFile: 1 };
  let contract;
  const scope = {
    trackedIpcHandle: (_channel, _scope, _name, value) => { contract = value; },
    requireToolboxSplitReadContext: () => readContext,
    prepareToolboxRows: prepareRows,
    app: { getPath: () => userDataDir }, mainWindow: null,
    showImportOpenDialog: async () => ({ canceled: false, filePaths: [directory] }),
    dialog: { showMessageBox: async (_window, options) => ({ response: await confirm(options, targets) ? 1 : 0 }) },
    assertToolboxTargetsDoNotAliasSources: (inputs, outputs) => {
      assert.ok(outputs.every((output) => !inputs.includes(output)));
    },
    toolboxFailureResult: (error) => ({ status: 'failed', code: error.code, message: error.message })
  };
  Function(...Object.keys(scope), handlerSource)(...Object.values(scope));
  return { directory, source, userDataDir, targets, payload, contract };
}

function replaceFile(filePath) {
  const replacement = filePath + '.replacement';
  fs.writeFileSync(replacement, 'unconfirmed-replacement');
  fs.renameSync(replacement, filePath);
}

for (const change of ['create', 'replace']) {
  test(`覆盖确认期间 ${change} 目标，Main 在任务前拒绝且保留全部文件`, async (t) => {
    const f = fixture(t, async (options, targets) => {
      assert.equal(options.detail, targets[0].fileName);
      if (change === 'create') fs.writeFileSync(targets[1].filePath, 'unconfirmed-new');
      else replaceFile(targets[0].filePath);
      return true;
    });
    const result = await prepareIpcTaskInvocation(f.contract, {}, [f.payload]);
    assert.equal(result.proceed, false);
    assert.equal(result.result.code, 'ARCHIVE_TARGET_CHANGED');
    assert.equal(fs.readFileSync(f.targets[0].filePath, 'utf8'),
      change === 'create' ? 'confirmed-old' : 'unconfirmed-replacement');
    assert.equal(fs.existsSync(f.targets[1].filePath), change === 'create');
    if (change === 'create') assert.equal(fs.readFileSync(f.targets[1].filePath, 'utf8'), 'unconfirmed-new');
  });

  test(`Main prepare 返回后 ${change} 目标，IPC 不能重新采集并接受新快照`, async (t) => {
    const f = fixture(t);
    let approvedPlan;
    const contract = { ...f.contract, async prepare(...args) {
      const prepared = await f.contract.prepare(...args);
      approvedPlan = prepared.rows.filePlan;
      if (change === 'create') fs.writeFileSync(f.targets[1].filePath, 'unconfirmed-new');
      else replaceFile(f.targets[0].filePath);
      return prepared;
    } };
    const prepared = await prepareIpcTaskInvocation(contract, {}, [f.payload]);
    assert.equal(prepared.proceed, true);
    assert.equal(prepared.filePlan, approvedPlan);
    assert.equal(prepared.filePlan.outputs[1].targetSnapshot.exists, false);
    assert.throws(() => assertFilePlanFresh(prepared.filePlan), { code: 'ARCHIVE_TARGET_CHANGED' });
  });
}

test('取消覆盖确认不创建 File Task 或输出文件', async (t) => {
  const f = fixture(t, async () => false);
  const result = await prepareIpcTaskInvocation(f.contract, {}, [f.payload]);
  assert.deepEqual(result, { proceed: false, result: { status: 'cancelled' } });
  assert.equal(fs.readFileSync(f.targets[0].filePath, 'utf8'), 'confirmed-old');
  assert.equal(fs.existsSync(f.targets[1].filePath), false);
});

for (const change of ['none', 'create', 'replace']) {
  test(`确认快照传至真实 Publisher：生成后 ${change} 目标`, async (t) => {
    const f = fixture(t);
    const prepared = await prepareIpcTaskInvocation(f.contract, {}, [f.payload]);
    assert.equal(prepared.proceed, true);
    const { filePlan } = prepared;
    assertFilePlanFresh(filePlan);
    const batchContext = { batchId: 1, batchNumber: 'ROWS-OVERWRITE', taskRunId: 'rows-overwrite-run',
      taskKey: 'toolbox:split:export', moduleId: 'toolbox', parentRunId: 'rows-parent', operationKey: 'rows-operation' };
    let publicationCalls = 0;
    const operation = generateValidateAndPublishRows({ counts: prepared.rows.counts, filePlan, batchContext,
      privateDirectory: fs.mkdtempSync(path.join(f.directory, '.private-')),
      runtime: { async execute(request) {
        const result = await executeRowsGeneration(request.input);
        if (change === 'create') fs.writeFileSync(f.targets[1].filePath, 'unconfirmed-new');
        if (change === 'replace') replaceFile(f.targets[0].filePath);
        return { outcome: 'completed', terminalSource: 'job:done', result };
      } },
      publisher: (artifacts) => {
        publicationCalls += 1;
        return publishToolboxPublicationAsync({ taskId: 'rows-overwrite-publication', artifacts,
          targets: filePlan.outputs.map((item) => ({ targetPath: item.filePath, expectedTargetSnapshot: item.targetSnapshot })),
          userDataDir: f.userDataDir, batchContext, archiveInputFiles: filePlan.inputs, protectedSourcePaths: [f.source] });
      } });
    if (change === 'none') {
      const result = await operation;
      assert.equal(result.publication.files.length, 2);
      for (const target of f.targets) assert.equal(fs.readFileSync(target.filePath).subarray(0, 2).toString(), 'PK');
    } else {
      await assert.rejects(operation, /目标.*变化/);
      assert.equal(fs.readFileSync(f.targets[0].filePath, 'utf8'),
        change === 'create' ? 'confirmed-old' : 'unconfirmed-replacement');
      assert.equal(fs.existsSync(f.targets[1].filePath), change === 'create');
      if (change === 'create') assert.equal(fs.readFileSync(f.targets[1].filePath, 'utf8'), 'unconfirmed-new');
    }
    assert.equal(publicationCalls, 1);
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'A\n1\n2\n');
  });
}
