'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs
  .readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8')
  .replace(/\r\n?/g, '\n');
const mergeStart = mainSource.indexOf("trackedIpcHandle('toolbox:merge'");
const start = mainSource.indexOf("trackedIpcHandle('toolbox:split:export'");
const end = mainSource.indexOf('\n}\n\n// v2.0.0-beta.4', start);
const mergeSource = mainSource.slice(mergeStart, start);
const handlerSource = mainSource.slice(start, end);
const preserveHelperStart = mainSource.indexOf('function shouldPreserveToolboxTemporaryFiles(error)');
const preserveHelperEnd = mainSource.indexOf(
  '\n}\n\nconst EMPTY_TOOLBOX_WARNING_SUMMARY',
  preserveHelperStart
) + 2;
const preserveHelperSource = mainSource.slice(preserveHelperStart, preserveHelperEnd);
const shouldPreserveToolboxTemporaryFiles = Function(
  `${preserveHelperSource}\nreturn shouldPreserveToolboxTemporaryFiles;`
)();
const cleanupHelperStart = mainSource.indexOf('function cleanupToolboxTemporaryDirectory(directoryPath)');
const cleanupHelperEnd = mainSource.indexOf(
  '\n}\n\nconst EMPTY_TOOLBOX_WARNING_SUMMARY',
  cleanupHelperStart
) + 2;
const cleanupHelperSource = mainSource.slice(cleanupHelperStart, cleanupHelperEnd);
const buildCleanupToolboxTemporaryDirectory = (fsImpl, appendLog) => Function(
  'fs',
  'appendActivityLogEntry',
  `${cleanupHelperSource}\nreturn cleanupToolboxTemporaryDirectory;`
)(fsImpl, appendLog);

test.describe('toolbox:split:export 多文件 IPC 接线', () => {
  test('四类正式发布与启动恢复均 await FIFO worker，不在 Electron 主线程直调同步核心', () => {
    assert.equal(
      mainSource.match(/await publishToolboxArtifacts\(/g).length,
      4,
      '合并、多拆、大文件单拆、普通单拆都必须等待发布 worker 完成'
    );
    assert.ok(mainSource.includes('publishToolboxPublicationAsync'));
    assert.ok(mainSource.includes('recoverToolboxPublicationsAsync'));
    assert.ok(mainSource.includes('await recoverToolboxPublicationsAtStartup()'));
    const recoveryHelper = mainSource.slice(
      mainSource.indexOf('async function recoverToolboxPublicationsAtStartup()'),
      mainSource.indexOf('function registerToolboxHandlers()')
    );
    assert.match(
      recoveryHelper,
      /catch \(error\) \{[\s\S]*?appendActivityLogEntry\([\s\S]*?throw error;[\s\S]*?\}/
    );
    assert.ok(!mainSource.includes('prepareToolboxPublication,'));
    assert.ok(!mainSource.includes('publishPreparedToolboxPublication,'));
  });

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

  test('临时目录保留策略只接受显式 preserveTemporaryFiles=true', () => {
    assert.equal(shouldPreserveToolboxTemporaryFiles(null), false);
    assert.equal(shouldPreserveToolboxTemporaryFiles(new Error('ordinary failure')), false);
    assert.equal(shouldPreserveToolboxTemporaryFiles({ preserveTemporaryFiles: false }), false);
    assert.equal(shouldPreserveToolboxTemporaryFiles({ preserveTemporaryFiles: 'true' }), false);
    assert.equal(shouldPreserveToolboxTemporaryFiles({ preserveTemporaryFiles: true }), true);
  });

  test('正式发布后的临时目录清理失败只记录告警，不抛错覆盖成功结果', () => {
    const logs = [];
    const cleanup = buildCleanupToolboxTemporaryDirectory(
      {
        rmSync() {
          const error = new Error('busy');
          error.code = 'EBUSY';
          throw error;
        }
      },
      (entry) => logs.push(entry)
    );

    assert.doesNotThrow(() => {
      assert.equal(cleanup('/tmp/toolbox-committed'), false);
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warning');
    assert.equal(logs[0].message, '工具箱临时目录清理失败');
    assert.ok(logs[0].details.some((line) => line.includes('EBUSY') || line.includes('busy')));
  });

  test('合并、多拆、大文件单拆和普通单拆统一保留人工恢复所需 generation 目录', () => {
    const fieldValidationIndex = handlerSource.indexOf('if (!field)');
    const multiSource = handlerSource.slice(
      handlerSource.indexOf("if (payload && payload.mode === 'multiple')"),
      fieldValidationIndex
    );
    const largeStart = handlerSource.indexOf(
      'if (await shouldUseLargeChannel(sourceFilePath))',
      fieldValidationIndex
    );
    const normalStart = handlerSource.indexOf(
      "const generationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'))",
      largeStart
    );
    const largeSource = handlerSource.slice(largeStart, normalStart);
    const normalSource = handlerSource.slice(normalStart);

    for (const [label, source] of [
      ['合并', mergeSource],
      ['多文件拆分', multiSource],
      ['大文件单拆', largeSource],
      ['普通单拆', normalSource]
    ]) {
      assert.ok(source.includes('let preserveTempDir = false;'), `${label}应初始化保留状态`);
      assert.ok(
        source.includes(
          'preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);'
        ),
        `${label}应消费跨 worker 的 preserveTemporaryFiles`
      );
      assert.ok(source.includes('if (!preserveTempDir)'), `${label}普通结束仍应清理临时目录`);
      assert.ok(
        source.includes('cleanupToolboxTemporaryDirectory('),
        `${label}临时清理失败不得覆盖正式发布结果`
      );
    }
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
    assert.ok(handlerSource.includes(
      'preserveTempDir = shouldPreserveToolboxTemporaryFiles(error)'
    ));
    assert.ok(handlerSource.includes('if (!preserveTempDir)'));
    assert.match(
      handlerSource,
      /finally\s*\{[\s\S]*?cleanupToolboxTemporaryDirectory\(tempDir\)/
    );
  });
});
