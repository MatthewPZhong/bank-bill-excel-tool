'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test.describe('v3.0.25 设置与存档中心静态契约', () => {
  const renderer = read('src/renderer.js');
  const preload = read('src/preload.js');
  const styles = read('src/styles-gemini-extra.css');
  const main = read('src/main.js');
  const positionOperationLifecycle = read(
    'src/main-process/position-reconciliation/operation-lifecycle.js'
  );

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

  test('业务 IPC 返回成功前等待本次存档登记与处理，不只写入内存尾队列', () => {
    const start = main.indexOf('async function runArchiveAwareOperation');
    const end = main.indexOf('function runRegisteredBusinessOperation', start);
    const operationFlow = main.slice(start, end);
    assert.match(operationFlow, /return settlePositionArchiveResult\(\{/);
    const settlementStart = positionOperationLifecycle.indexOf(
      'async function settlePositionArchiveResult'
    );
    const settlementEnd = positionOperationLifecycle.indexOf(
      'async function runPositionOperationLifecycle',
      settlementStart
    );
    const settlementFlow = positionOperationLifecycle.slice(settlementStart, settlementEnd);
    assert.match(settlementFlow, /const archiveResult = await archiveTask/);
    assert.ok(
      settlementFlow.indexOf('await archiveTask') < settlementFlow.lastIndexOf('return result'),
      '存档任务应在返回业务结果前完成'
    );
  });

  test('存档写操作纳入业务退出闸门，平盘失败源由存档状态驱动释放', () => {
    assert.match(
      main,
      /function archiveCenterMutationIpcHandle[\s\S]*?runRegisteredBusinessOperation\(meta, handler\)/
    );
    for (const channel of [
      'archive-center:save-as',
      'archive-center:set-locked',
      'archive-center:delete-batch',
      'archive-center:retry-batch',
      'archive-center:set-retention-days'
    ]) {
      assert.ok(
        main.includes(`archiveCenterMutationIpcHandle('${channel}'`),
        `${channel} 应接入退出闸门`
      );
    }
    assert.match(main, /onSourceReleased:\s*cleanupPositionArchiveSourcePaths/);
    assert.match(main, /protectedStagingPaths:[\s\S]*?listUnresolvedSourcePaths\(\)/);
    assert.match(main, /filterStagingPathsWithoutProtectedSources\(targets,\s*unresolvedSourcePaths\)/);
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

  test('preload 仅暴露保留中的 archiveCenter API 与约定 IPC 通道', () => {
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
    assert.doesNotMatch(preload, /listTemplatePolicies|setTemplateExcluded/);
    assert.doesNotMatch(main, /archive-center:(?:list-template-policies|set-template-excluded)/);
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

  test('批次、文件、失败重试和全局确认均接入 archiveCenter', () => {
    for (const action of [
      'open-archive-file',
      'save-as-archive-file',
      'toggle-archive-lock',
      'delete-archive-batch',
      'retry-archive-batch',
      'open-archive-settings',
      'confirm-settings'
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
    assert.match(
      renderer,
      /archiveState\.activeTab === 'archive' && archiveState\.archiveSettingsOpen[\s\S]*?saveArchiveSettings\(event\.currentTarget\)/
    );
    assert.doesNotMatch(renderer, /data-action="(?:save|cancel)-archive-settings"/);
  });

  test('存档设置仅保留期限与存储统计，模板不存档完全退役', () => {
    for (const value of ['30', '60', '90', '180', '365', 'permanent']) {
      assert.match(renderer, new RegExp(`<option value="${value}"(?: selected)?>`), `保留期 ${value} 应存在`);
    }
    assert.match(renderer, /<option value="60" selected>60 天<\/option>/);
    assert.match(renderer, /<option value="90">90 天<\/option>/);
    assert.match(renderer, /data-role="archive-retention-days"/);
    assert.match(renderer, /data-role="archive-retention-days" aria-label="保留期限"/);
    assert.match(
      renderer,
      /api\.setRetentionDays\(\s*retentionValue === 'permanent' \? null : Number\(retentionValue\)\s*\)/
    );
    assert.match(renderer, /getArchiveCenterApi\(\)\.getStats\(\)/);
    assert.doesNotMatch(renderer, /archive-template-policies|setTemplateExcluded|listTemplatePolicies/);
    assert.doesNotMatch(renderer, /网银账单生成模板|不存档/);
    assert.doesNotMatch(renderer, /锁定批次不参与自动清理。默认保留期为 90 天。|默认保留/);
  });

  test('永久保留值保持为 permanent，返回时丢弃草稿且加载期间禁用确认', () => {
    assert.match(
      renderer,
      /Object\.prototype\.hasOwnProperty\.call\(settings, 'retentionDays'\)[\s\S]*?\? settings\.retentionDays/
    );
    assert.match(
      renderer,
      /retentionDays === null \|\| retentionDays === 'permanent'[\s\S]*?\? 'permanent'/
    );
    const openStateStart = renderer.indexOf('function setArchiveSettingsOpen');
    const tabStateStart = renderer.indexOf('function setSettingsTab', openStateStart);
    const openStateSource = renderer.slice(openStateStart, tabStateStart);
    assert.match(openStateSource, /archiveState\.settingsRequestId \+= 1/);
    assert.match(openStateSource, /retentionSelect\.value = archiveState\.savedRetentionValue/);
    assert.match(renderer, /confirmButton\.disabled = archiveState\.settingsLoading/);
    assert.match(renderer, /if \(archiveState\.settingsLoading\) return false/);
  });

  test('确认按钮保存并关闭，失败时保留弹窗且恢复按钮', () => {
    const saveStart = renderer.indexOf('async function saveArchiveSettings');
    const saveEnd = renderer.indexOf('function closeSettingsDialog', saveStart);
    const saveSource = renderer.slice(saveStart, saveEnd);
    assert.match(saveSource, /retentionValue === archiveState\.savedRetentionValue[\s\S]*?closeSettingsDialog\(\)/);
    assert.match(saveSource, /button\.disabled = true/);
    assert.match(saveSource, /await api\.setRetentionDays/);
    assert.match(saveSource, /closeSettingsDialog\(\);[\s\S]*?return true/);
    assert.match(saveSource, /catch \(error\)[\s\S]*?存档设置保存失败/);
    assert.match(saveSource, /finally \{[\s\S]*?button\.isConnected[\s\S]*?button\.disabled = false/);
    assert.match(renderer, /data-action="confirm-settings"[^>]*data-role="close-update-dialog">确认<\/button>/);
    assert.doesNotMatch(renderer, /data-role="close-update-dialog">完成<\/button>/);
  });

  test('指定说明被删除，portable 下载提示保留且安装版空说明收起', () => {
    for (const removedText of [
      '管理软件版本检查、下载与安装。',
      '开启后每次启动仅在后台检查一次，不会定时检查。',
      '按日期、模块和批次号查看已参与处理的输入文件与结果表。'
    ]) {
      assert.doesNotMatch(renderer, new RegExp(removedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(renderer, /便携版不会自动安装更新。点击“前往下载”可打开稳定版下载页面。/);
    assert.match(renderer, /note\.hidden = note\.textContent === ''/);
  });

  test('自动更新文字字号和右边界由共享尺寸变量约束', () => {
    assert.match(styles, /--app-settings-footer-inline-padding:\s*24px/);
    assert.match(styles, /--app-settings-confirm-width:\s*72px/);
    assert.match(styles, /--app-update-pane-inline-padding:\s*36px/);
    assert.match(styles, /\.app-update-toggle\s*\{[\s\S]*?font-size:\s*14px/);
    assert.match(
      styles,
      /\.app-settings-footer \[data-role="close-update-dialog"\]\s*\{[\s\S]*?width:\s*var\(--app-settings-confirm-width\)/
    );
    assert.match(
      styles,
      /\.app-update-settings-body\s*\{[\s\S]*?var\(--app-settings-footer-inline-padding\)[\s\S]*?var\(--app-settings-confirm-width\)[\s\S]*?var\(--app-update-pane-inline-padding\)/
    );
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
