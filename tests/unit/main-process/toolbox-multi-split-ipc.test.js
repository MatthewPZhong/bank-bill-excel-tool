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
  test('成功日志记录有界日期样例、样式预计/实际和发布前校验结果', () => {
    const helperStart = mainSource.indexOf('function buildToolboxAuditDetailLines(');
    const helperEnd = mainSource.indexOf('\n}\n\nfunction publishToolboxArtifacts', helperStart);
    const helperSource = mainSource.slice(helperStart, helperEnd);
    assert.ok(helperStart >= 0);
    assert.ok(helperSource.includes('warningSamples.slice(0, 20)'));
    assert.ok(helperSource.includes('styleStats.projectedFinalCounts'));
    assert.ok(helperSource.includes('styleStats.actualCounts'));
    assert.ok(helperSource.includes('临时产物校验：通过'));
    assert.equal(
      mainSource.match(/\.\.\.buildToolboxAuditDetailLines\(/g).length,
      4,
      '合并、普通单拆、大文件单拆、多文件拆分都应记录统一审计详情'
    );
    assert.equal(
      handlerSource.match(/输入有效行数：/g).length,
      3,
      '普通单拆、大文件单拆和多文件拆分都应记录输入有效行数'
    );
  });

  test('发布进入人工恢复时，失败返回会把 recoveryPaths 追加为用户可见路径', () => {
    const failureStart = mainSource.indexOf('function toolboxFailureResult(error)');
    const failureEnd = mainSource.indexOf('\n}\n\nconst EMPTY_TOOLBOX_WARNING_SUMMARY', failureStart);
    const failureSource = mainSource.slice(failureStart, failureEnd);
    assert.ok(failureSource.includes('Array.isArray(error.recoveryPaths)'));
    assert.ok(failureSource.includes('`恢复路径：${recoveryPath}`'));
    assert.ok(failureSource.includes('detailLines.push(line)'));
  });

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

  test('大文件和普通文件均走统一格式保真 facade，最后统一可恢复发布', () => {
    const workerIndex = handlerSource.indexOf("op: 'exportMultiFilters'");
    const ordinaryIndex = handlerSource.indexOf('exportToolboxMultiFilters({');
    const publishIndex = handlerSource.indexOf("publishToolboxArtifacts(\n            'split-multi'");
    assert.ok(workerIndex >= 0);
    assert.ok(ordinaryIndex >= 0);
    assert.ok(publishIndex > workerIndex && publishIndex > ordinaryIndex);
  });

  test('按 outputId 关联产物并返回 warning 契约，finally 清理本批临时目录', () => {
    assert.ok(handlerSource.includes('const generationById = new Map()'));
    assert.ok(handlerSource.includes("status: 'success',\n            files,\n            warningSummary,"));
    assert.ok(handlerSource.includes('preserveTempDir = error && error.preserveTemporaryFiles === true'));
    assert.ok(handlerSource.includes('if (!preserveTempDir)'));
    assert.match(handlerSource, /finally\s*\{[\s\S]*?fs\.rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  });
});
