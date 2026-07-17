'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const start = mainSource.indexOf("trackedIpcHandle('toolbox:split:export'");
const end = mainSource.indexOf('\n}\n\n// v2.0.0-beta.4', start);
const handlerSource = mainSource.slice(start, end);

test.describe('toolbox:split:export 多文件 IPC 接线', () => {
  test('多文件分支位于旧单文件 field/values 校验之前', () => {
    const multiIndex = handlerSource.indexOf("payload.mode === 'multiple'");
    const oldValidationIndex = handlerSource.indexOf("if (!field)");
    assert.ok(multiIndex >= 0 && oldValidationIndex > multiIndex);
  });

  test('只选择一次目录，冲突统一确认后才创建临时目录', () => {
    const directoryIndex = handlerSource.indexOf("showImportOpenDialog('toolbox-split-export-directory'");
    const invalidTargetIndex = handlerSource.indexOf('const invalidTargets = targetPlans.filter');
    const conflictIndex = handlerSource.indexOf("buttons: ['取消', '覆盖全部']");
    const tempIndex = handlerSource.indexOf("fs.mkdtempSync(path.join(outputDirectory, '.toolbox-split-'))");
    assert.ok(directoryIndex >= 0);
    assert.ok(invalidTargetIndex > directoryIndex);
    assert.ok(conflictIndex > directoryIndex);
    assert.ok(tempIndex > conflictIndex && tempIndex > invalidTargetIndex);
    assert.equal(handlerSource.match(/showImportOpenDialog\('toolbox-split-export-directory'/g).length, 1);
  });

  test('大文件和普通文件均走多过滤器写出，最后统一原子发布', () => {
    const workerIndex = handlerSource.indexOf("op: 'exportMultiFilters'");
    const ordinaryIndex = handlerSource.indexOf('toolboxWriteRowsToMultipleFilesStreamed({');
    const publishIndex = handlerSource.indexOf('toolboxPublishPreparedSplitFiles(preparedPlans)');
    assert.ok(workerIndex >= 0);
    assert.ok(ordinaryIndex >= 0);
    assert.ok(publishIndex > workerIndex && publishIndex > ordinaryIndex);
  });

  test('返回新 files 契约，finally 清理本批临时目录', () => {
    assert.ok(handlerSource.includes("return { status: 'success', files };"));
    assert.ok(handlerSource.includes('preserveTempDir = error && error.preserveTemporaryFiles === true'));
    assert.ok(handlerSource.includes('if (!preserveTempDir)'));
    assert.match(handlerSource, /finally\s*\{[\s\S]*?fs\.rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  });
});
