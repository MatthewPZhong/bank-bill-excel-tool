'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');

const MAIN_PATH = path.join(__dirname, '..', '..', '..', 'src', 'main.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8').replace(/\r\n?/g, '\n');

function buildSplitReadContextHarness() {
  const start = mainSource.indexOf('let toolboxSplitReadContext = null;');
  const end = mainSource.indexOf('\nfunction toolboxFinalOutputFiles(', start);
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
