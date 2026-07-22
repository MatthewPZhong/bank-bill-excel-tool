'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test.describe('v3.0.22 设置与存档中心静态契约', () => {
  const renderer = read('src/renderer.js');
  const preload = read('src/preload.js');
  const styles = read('src/styles-gemini-extra.css');
  const main = read('src/main.js');

  test('主进程源码不含真实 NUL 字节，保持 Git 文本差异可审查', () => {
    const mainBuffer = fs.readFileSync(path.join(ROOT, 'src', 'main.js'));
    assert.equal(mainBuffer.includes(0), false);
  });

  test('正常退出等待后台存档排空，不在固定超时后丢弃尚未登记的批次', () => {
    const start = main.indexOf('async function prepareApplicationForQuit');
    const end = main.indexOf("app.on('before-quit'", start);
    const quitFlow = main.slice(start, end);
    assert.match(quitFlow, /await archiveOperationTail/);
    assert.doesNotMatch(quitFlow, /Promise\.race\(\[\s*archiveOperationTail/);
  });

  test('设置弹窗为双栏导航且默认停留在自动更新', () => {
    assert.match(renderer, /function createAppUpdateSettingsDialog\(\)/);
    assert.match(renderer, /dialog\.className = 'modal-card app-update-settings-card'/);
    assert.match(
      renderer,
      /class="app-settings-nav-item is-active"[^>]*data-tab="update"[\s\S]*?<span>自动更新<\/span>/
    );
    assert.match(
      renderer,
      /class="app-settings-nav-item"[^>]*data-tab="archive"[\s\S]*?<span>存档中心<\/span>/
    );
    assert.match(renderer, /data-pane="update"/);
    assert.match(renderer, /data-pane="archive"[^>]*hidden/);
    assert.match(renderer, /archiveState\.activeTab = tab === 'archive' \? 'archive' : 'update'/);

    const modulesStart = renderer.indexOf('const MODULES = Object.freeze({');
    const modulesEnd = renderer.indexOf('const RENDERER_STARTUP_MARKS', modulesStart);
    const modulesSource = renderer.slice(modulesStart, modulesEnd);
    assert.equal((modulesSource.match(/\n\s+id:\s*'[^']+'/g) || []).length, 12);
    assert.doesNotMatch(modulesSource, /id:\s*'archive-center'/);
    assert.match(renderer, /const archiveModules = new Map\([\s\S]*?Object\.values\(MODULES\)/);
  });

  test('自动更新既有选择器与行为契约继续存在', () => {
    for (const selector of [
      'current-version',
      'distribution',
      'auto-update-toggle',
      'auto-update-toggle-text',
      'update-state',
      'last-checked',
      'target-row',
      'target-version',
      'download-progress',
      'update-note',
      'close-update-dialog'
    ]) {
      assert.ok(renderer.includes(`data-role="${selector}"`), `${selector} 应保留`);
    }
    assert.match(renderer, /window\.desktopApi\.appUpdate\.setEnabled\(toggle\.checked\)/);
    assert.match(renderer, /window\.desktopApi\.appUpdate\.checkNow\(\)/);
    assert.match(renderer, /restartAndInstallAppUpdate\(\{ inline: true \}\)/);
  });

  test('preload 完整暴露 archiveCenter API 与约定 IPC 通道', () => {
    const contracts = [
      ['listBatches', 'archive-center:list-batches'],
      ['getBatch', 'archive-center:get-batch'],
      ['openFile', 'archive-center:open-file'],
      ['saveAs', 'archive-center:save-as'],
      ['setLocked', 'archive-center:set-locked'],
      ['deleteBatch', 'archive-center:delete-batch'],
      ['retryBatch', 'archive-center:retry-batch'],
      ['getSettings', 'archive-center:get-settings'],
      ['setRetentionDays', 'archive-center:set-retention-days'],
      ['listTemplatePolicies', 'archive-center:list-template-policies'],
      ['setTemplateExcluded', 'archive-center:set-template-excluded'],
      ['getStats', 'archive-center:get-stats']
    ];

    assert.match(preload, /archiveCenter:\s*\{/);
    for (const [method, channel] of contracts) {
      assert.match(
        preload,
        new RegExp(`${method}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`),
        `${method} 应调用 ${channel}`
      );
    }
    assert.match(preload, /setLocked:\s*\(batchId, locked\)/);
    assert.match(preload, /setTemplateExcluded:\s*\(templateId, excluded\)/);
  });

  test('筛选仅包含日期、模块、批次号，不提供文件名搜索', () => {
    const filtersStart = renderer.indexOf('class="archive-center-filters"');
    const filtersEnd = renderer.indexOf('class="archive-center-workspace"', filtersStart);
    assert.ok(filtersStart >= 0 && filtersEnd > filtersStart, '应找到存档筛选区');
    const filters = renderer.slice(filtersStart, filtersEnd);

    assert.match(filters, /data-filter="date"/);
    assert.match(filters, /data-filter="module"/);
    assert.match(filters, /data-filter="batch-id"/);
    assert.doesNotMatch(filters, /data-filter="(?:file-name|filename)"/i);
    assert.doesNotMatch(filters, /搜索文件名|按文件名搜索/);
    assert.match(renderer, /localDate: dateFilter\.value/);
    assert.match(renderer, /batchNumber/);
    assert.match(renderer, /listBatches\(filters\)/);
    assert.match(renderer, /archiveCenterBatchNumber\(batch\)[\s\S]*?includes\(requestedBatchNumber\)/);
  });

  test('批次、文件、失败重试和设置动作均接入 archiveCenter', () => {
    for (const action of [
      'open-archive-file',
      'save-as-archive-file',
      'toggle-archive-lock',
      'delete-archive-batch',
      'retry-archive-batch',
      'open-archive-settings',
      'save-archive-settings'
    ]) {
      assert.ok(renderer.includes(`data-action="${action}"`), `${action} 应存在`);
    }

    assert.match(renderer, /api\.openFile\(fileRefId\)/);
    assert.match(renderer, /api\.saveAs\(fileRefId\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.setLocked\(batchId, nextLocked\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.deleteBatch\(batchId\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.retryBatch\(batchId\)/);
    assert.match(renderer, /confirmOverlay = createConfirmDialog\(\{/);
    assert.match(renderer, /batch\?\.internalId \?\? batch\?\.batchId/);
    assert.match(renderer, /data-batch-number="\$\{escapeHtml\(batchNumber\)\}"/);
    assert.match(renderer, /const batchNumber = button\.dataset\.batchNumber \|\| batchId/);
    assert.match(renderer, /data-role="archive-delete-error"/);
    assert.match(renderer, /data-role="archive-feedback"/);
    assert.match(renderer, /if \(isObject && result\.ok === false\)/);
    assert.match(renderer, /showArchiveFeedback\(`存档设置保存失败：/);
    assert.doesNotMatch(
      renderer,
      /querySelector\('\[data-action="save-archive-settings"\]'\)\.addEventListener/,
      '存档设置保存只应由 archive pane 的委托监听处理一次'
    );
  });

  test('存档设置覆盖保留期、模板不存档与存储统计', () => {
    for (const value of ['30', '90', '180', '365', 'permanent']) {
      assert.match(renderer, new RegExp(`<option value="${value}"(?: selected)?>`), `保留期 ${value} 应存在`);
    }
    assert.match(renderer, /<option value="90" selected>90 天<\/option>/);
    assert.match(renderer, /data-role="archive-retention-days"/);
    assert.match(renderer, /data-role="archive-template-policies"/);
    assert.match(renderer, /api\.setRetentionDays\(retentionValue === 'permanent' \? null : Number\(retentionValue\)\)/);
    assert.match(renderer, /api\.setTemplateExcluded\(templateId, input\.checked\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.getStats\(\)/);
  });

  test('锁定批次仍显示原到期日，不误写成永久保留', () => {
    assert.match(renderer, /\$\{String\(value\)\}（已锁定）/);
    assert.doesNotMatch(renderer, /locked === true\) return '永久保留'/);
  });

  test('文件角色使用中文语义，锁定与重试按钮异常后可恢复操作', () => {
    assert.match(renderer, /function archiveCenterRoleText\(value\)/);
    assert.match(renderer, /if \(role === 'input'\) return '业务输入'/);
    assert.match(renderer, /if \(role === 'output'\) return '首次结果'/);
    assert.match(renderer, /const role = archiveCenterRoleText\(file\.role \?\? file\.fileRole\)/);
    assert.match(renderer, /const canRetry = typeof batch\.canRetry === 'boolean'/);

    const lockStart = renderer.indexOf('async function toggleArchiveBatchLock');
    const retryStart = renderer.indexOf('async function retryArchiveBatch', lockStart);
    const deleteStart = renderer.indexOf('function confirmArchiveBatchDelete', retryStart);
    assert.match(renderer.slice(lockStart, retryStart), /finally \{[\s\S]*?button\.isConnected/);
    assert.match(renderer.slice(retryStart, deleteStart), /finally \{[\s\S]*?button\.isConnected/);
  });

  test('图标按钮具备可访问名称，尺寸覆盖两个目标窗口', () => {
    const iconButtons = [...renderer.matchAll(/<button class="archive-center-icon-button[^"]*"[^>]*>/g)];
    assert.ok(iconButtons.length >= 5, '应存在存档操作图标按钮');
    for (const [button] of iconButtons) {
      assert.match(button, /title="[^"]+"/);
      assert.match(button, /aria-label="[^"]+"/);
    }

    assert.match(styles, /\.app-update-settings-card\s*\{[\s\S]*?width:\s*min\(1088px, calc\(100vw - 56px\)\)/);
    assert.match(styles, /height:\s*min\(704px, calc\(100vh - 56px\)\)/);
    assert.match(styles, /@media \(max-width: 1120px\)/);
    assert.match(styles, /@media \(max-height: 800px\)/);
    assert.match(styles, /\.archive-center-workspace\s*\{[\s\S]*?grid-template-columns:/);
  });
});
