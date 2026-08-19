'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test.describe('v3.1.9 设置与存档中心静态契约', () => {
  const renderer = read('src/renderer.js');
  const preload = read('src/preload.js');
  const styles = read('src/styles-gemini-extra.css');
  const main = read('src/main.js');
  const archiveController = read('src/main-process/archive-center/controller.js');
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
    const artifactSettleIndex = operationFlow.indexOf('await controls.settleArtifacts');
    const positionSettleIndex = operationFlow.indexOf('await settlePositionArchiveResult');
    const returnIndex = operationFlow.indexOf('return settledResult');
    assert.ok(artifactSettleIndex >= 0, 'position execute 必须先等待 lifecycle artifact barrier');
    assert.ok(positionSettleIndex > artifactSettleIndex, 'position settle 必须位于 artifact barrier 之后');
    assert.ok(returnIndex > positionSettleIndex, '业务结果只能在 position settle 完成后返回');
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
      'archive-center:select-retry-sources',
      'archive-center:retry-batch',
      'archive-center:change-storage-location',
      'archive-center:set-retention-days'
    ]) {
      assert.ok(
        main.includes(`archiveCenterMutationIpcHandle('${channel}'`),
        `${channel} 应接入退出闸门`
      );
    }
    assert.match(main, /onSourceReleased:\s*cleanupPositionArchiveSourcePaths/);
    assert.match(main, /protectedStagingPaths:\s*positionArchivePersistentStagingPaths/);
    assert.match(
      main,
      /positionPersistentStagingProtectionPaths\(\s*archiveCenterService\.listUnresolvedSourcePaths\(\),\s*readPositionPendingOperation\(\)\s*\)/
    );
    assert.match(
      main,
      /protectedPaths\s*=\s*protectedPaths\.concat\(activePaths\)/
    );
    assert.match(main, /filterStagingPathsWithoutProtectedSources\(targets,\s*protectedPaths\)/);
  });

  test('异常恢复按删除证据计算清理候选，并在清除 pending 后执行受保护目录清理', () => {
    const persistenceStart = main.indexOf('function persistPositionArchiveIntentIfNeeded');
    const persistenceEnd = main.indexOf('function recoverPositionArchiveIntent', persistenceStart);
    const persistenceFlow = main.slice(persistenceStart, persistenceEnd);
    const finalizeStart = main.indexOf('async function finalizeRecoveredPositionPending');
    const finalizeEnd = main.indexOf('function positionOutboxTerminalIntent', finalizeStart);
    const finalizeFlow = main.slice(finalizeStart, finalizeEnd);
    const serviceStart = main.indexOf('function getPositionReconciliationService');
    const serviceEnd = main.indexOf('function syncPositionReconciliationCheckpoint', serviceStart);
    const recoveryFlow = main.slice(serviceStart, serviceEnd);
    assert.match(recoveryFlow, /const recovery = recoverPositionArchiveIntent\(/);
    assert.match(
      persistenceFlow,
      /const archiveResult = readDeletedPositionArchiveResult\(pending\);[\s\S]*?positionRecoveryCleanupInputPaths\([\s\S]*?archiveResult/
    );
    assert.match(
      finalizeFlow,
      /positionCommittedRecoveryArchiveFiles\(\s*current,\s*positionReconciliationService\.listCommittedOperationInputs\(operationToken\)\s*\)/
    );
    assert.match(
      finalizeFlow,
      /const cleanupInputPaths = currentBatch[\s\S]*?currentBatch\.metadata\._fileManifest[\s\S]*?\? \[\][\s\S]*?: positionRecoveryCleanupInputPaths\(/
    );
    assert.doesNotMatch(
      recoveryFlow,
      /cleanupPositionArchiveSourcePaths\(recovery\.cleanupInputPaths\)/
    );
    const settleIndex = finalizeFlow.indexOf('await settlePositionRecoveredTask');
    const syncIndex = finalizeFlow.indexOf('syncPositionReconciliationCheckpoint()');
    const bootstrapClearIndex = finalizeFlow.indexOf(
      "database.setSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, '')"
    );
    const pendingClearIndex = finalizeFlow.indexOf('clearPositionPendingOperation(operationToken)');
    const cleanupIndex = finalizeFlow.indexOf(
      'await cleanupPositionArchiveSourcePaths(cleanupInputPaths)'
    );
    assert.ok(
      settleIndex >= 0
        && syncIndex > settleIndex
        && bootstrapClearIndex > syncIndex
        && pendingClearIndex > bootstrapClearIndex
        && cleanupIndex > pendingClearIndex,
      '未提交 staging 只能在原任务终态、checkpoint 与当前 pending 收口后清理'
    );
    assert.match(recoveryFlow, /: finalizeRecoveredPositionPending\(operationToken,/);
    const outboxStart = main.indexOf('async function finalizePositionTerminalIntent');
    const outboxEnd = main.indexOf('function persistCurrentPositionArchiveIntentIfNeeded', outboxStart);
    assert.match(
      main.slice(outboxStart, outboxEnd),
      /await finalizeRecoveredPositionPending\(operationToken,/
    );
  });

  test('设置弹窗为双栏导航且默认停留在版本管理，内部自动更新名称保留', () => {
    assert.match(renderer, /function createAppUpdateSettingsDialog\(options = \{\}\)/);
    assert.match(renderer, /const archiveCenterApi = options\.archiveCenterApi \|\| null/);
    assert.match(renderer, /dialog\.className = 'modal-card app-update-settings-card'/);
    assert.match(
      renderer,
      /class="app-settings-nav-item is-active"[^>]*data-tab="update"[\s\S]*?<span>版本管理<\/span>/
    );
    assert.match(
      renderer,
      /class="app-settings-nav-item"[^>]*data-tab="archive"[\s\S]*?<span>存档中心<\/span>/
    );
    assert.match(renderer, /data-pane="update"/);
    assert.match(renderer, /data-pane="archive"[^>]*hidden/);
    assert.match(renderer, /id="appUpdatePaneHeading"[^>]*>版本管理<\/h3>/);
    assert.match(renderer, /data-role="auto-update-toggle" aria-label="自动更新"/);
    assert.match(renderer, /archiveState\.activeTab = tab === 'archive' \? 'archive' : 'update'/);

    const modulesStart = renderer.indexOf('const MODULES = Object.freeze({');
    const modulesEnd = renderer.indexOf('const RENDERER_STARTUP_MARKS', modulesStart);
    const modulesSource = renderer.slice(modulesStart, modulesEnd);
    assert.equal((modulesSource.match(/\n\s+id:\s*'[^']+'/g) || []).length, 13);
    assert.doesNotMatch(modulesSource, /id:\s*'archive-center'/);
    const archiveModulesStart = renderer.indexOf('const archiveModules = new Map(');
    const archiveModulesEnd = renderer.indexOf('const archiveState = {', archiveModulesStart);
    const archiveModulesSource = renderer.slice(archiveModulesStart, archiveModulesEnd);
    assert.match(archiveModulesSource, /Object\.values\(MODULES\)/);
    assert.match(archiveModulesSource, /\['toolbox', '工具箱'\]/);
    assert.doesNotMatch(archiveModulesSource, /module\.id !== MODULES\.vccFinancialOp\.id/);
    const mainModulesSource = renderer.slice(
      renderer.indexOf('const MODULES = Object.freeze({'),
      renderer.indexOf('\n});', renderer.indexOf('const MODULES = Object.freeze({')) + 4
    );
    assert.doesNotMatch(mainModulesSource, /toolbox/);
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
      ['selectRetrySources', 'archive-center:select-retry-sources'],
      ['retryBatch', 'archive-center:retry-batch'],
      ['getSettings', 'archive-center:get-settings'],
      ['changeStorageLocation', 'archive-center:change-storage-location'],
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
    assert.match(
      preload,
      /onStorageMigrationProgress:\s*\(listener\)[\s\S]*?ipcRenderer\.on\('archive-center:storage-migration-progress', wrapped\)[\s\S]*?removeListener\('archive-center:storage-migration-progress', wrapped\)/
    );
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
      'change-archive-storage',
      'confirm-settings'
    ]) {
      assert.ok(renderer.includes(`data-action="${action}"`), `${action} 应存在`);
    }

    assert.match(renderer, /api\.openFile\(fileRefId\)/);
    assert.match(renderer, /api\.saveAs\(fileRefId\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.setLocked\(batchId, nextLocked\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.deleteBatch\(batchId\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.selectRetrySources\(batchId\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.retryBatch\(batchId, sourcePaths\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.changeStorageLocation\(\)/);
    assert.match(renderer, /batch\.requiresBusinessRerun === true/);
    assert.match(renderer, /需要重新运行业务/);
    assert.match(renderer, /batch\.rerunHint \|\|/);
    assert.match(archiveController, /请从工具箱重新执行/);
    assert.match(renderer, /batch\.failureMessage/);
    assert.match(preload, /retryBatch:\s*\(batchId, sourcePaths\)/);
    assert.match(
      main,
      /archive-center:retry-batch'[\s\S]*?\(_event, batchId, sourcePaths\)[\s\S]*?retryBatch', batchId, sourcePaths/
    );
    assert.match(
      main,
      /showOpenDialog:\s*\(options\)\s*=>\s*showImportOpenDialog\('archive-center-retry-source', options\)/
    );
    assert.match(renderer, /confirmOverlay = createConfirmDialog\(\{/);
    assert.match(renderer, /batch\?\.internalId \?\? batch\?\.batchId/);
    assert.match(renderer, /data-batch-number="\$\{escapeHtml\(batchNumber\)\}"/);
    assert.match(renderer, /const batchNumber = button\.dataset\.batchNumber \|\| batchId/);
    assert.match(renderer, /data-role="archive-delete-error"/);
    assert.match(renderer, /data-role="archive-feedback"/);
    assert.match(renderer, /if \(isObject && result\.ok === false\)/);
    assert.match(renderer, /retentionSelect\.addEventListener\('change', saveRetentionSelection\)/);
    assert.match(renderer, /data-action="confirm-settings"[^>]*data-role="close-update-dialog">返回<\/button>/);
    assert.match(renderer, /data-action="confirm-settings"\]'.*addEventListener\('click', closeSettingsDialog\)/);
    assert.doesNotMatch(renderer, /data-action="(?:save|cancel)-archive-settings"/);
  });

  test('存档设置显示位置、迁移进度、期限与统计，模板不存档完全退役', () => {
    for (const value of ['30', '60', '90', '180', '365', 'permanent']) {
      assert.match(renderer, new RegExp(`<option value="${value}"(?: selected)?>`), `保留期 ${value} 应存在`);
    }
    assert.match(renderer, /<option value="60" selected>60 天<\/option>/);
    assert.match(renderer, /<option value="90">90 天<\/option>/);
    assert.match(renderer, /data-role="archive-retention-days"/);
    assert.match(renderer, /data-role="archive-retention-days" aria-label="保留期限"/);
    assert.match(renderer, /api\.setRetentionDays\(retentionDaysApiValue\(intent\.value\)\)/);
    assert.match(renderer, /getArchiveCenterApi\(\)\.getStats\(\)/);
    assert.match(renderer, /data-role="archive-storage-path"/);
    assert.match(renderer, /data-role="archive-storage-migration"/);
    assert.match(renderer, /migration\.status === 'running'/);
    assert.match(renderer, /migration\.phase === 'cleanup-pending'/);
    assert.match(renderer, /`\$\{phaseText\}（\$\{processed\}\/\$\{total\}）`/);
    assert.match(renderer, /running \? '变更中…' : '变更'/);
    for (const role of [
      'archive-file-total-size',
      'archive-settings-file-total-size',
      'archive-stat-runs',
      'archive-stat-latest'
    ]) {
      assert.match(renderer, new RegExp(`data-role="${role}"`));
    }
    assert.match(renderer, /stats\.fileTotalBytes/);
    assert.match(renderer, /stats\.runCount/);
    assert.match(renderer, /stats\.latestBatchNumber \|\| '-'/);
    assert.match(renderer, /storagePath\.title = storageRoot/);
    assert.doesNotMatch(renderer, /archive-(?:unique|logical)|archive-stat-files|archive-storage-meter/);
    assert.doesNotMatch(renderer, />唯一文件<|>逻辑文件<|>文件引用</);
    assert.doesNotMatch(renderer, /archive-template-policies|setTemplateExcluded|listTemplatePolicies/);
    assert.doesNotMatch(renderer, /网银账单生成模板|不存档/);
    assert.doesNotMatch(renderer, /锁定批次不参与自动清理。默认保留期为 90 天。|默认保留/);
  });

  test('永久保留值保持为 permanent，加载和即时保存期间禁用返回与关闭入口', () => {
    assert.match(
      renderer,
      /Object\.prototype\.hasOwnProperty\.call\(settings, 'retentionDays'\)[\s\S]*?\? settings\.retentionDays/
    );
    assert.match(
      renderer,
      /retentionDays === null \|\| retentionDays === 'permanent'[\s\S]*?\? 'permanent'/
    );
    assert.match(renderer, /const busy = archiveState\.settingsLoading \|\| archiveState\.retentionSaving/);
    assert.match(renderer, /returnButton\.disabled = busy/);
    assert.match(renderer, /closeDialogButton\.disabled = busy/);
    assert.match(renderer, /if \(archiveState\.settingsLoading \|\| archiveState\.retentionSaving\) return false/);
    assert.match(renderer, /retentionSelect\.disabled = archiveState\.settingsLoading/);
  });

  test('保留期限使用单一串行 latest-intent，旧失败有 pending 时继续且最终失败才恢复', () => {
    const drainStart = renderer.indexOf('async function drainRetentionIntents');
    const saveStart = renderer.indexOf('function saveRetentionSelection', drainStart);
    const drainSource = renderer.slice(drainStart, saveStart);
    assert.match(renderer, /retentionIntentToken: 0/);
    assert.match(renderer, /retentionPendingIntent: null/);
    assert.match(renderer, /retentionSavePromise: null/);
    assert.match(drainSource, /while \(archiveState\.retentionPendingIntent && archiveDialogAlive\(\)\)/);
    assert.match(drainSource, /const intent = archiveState\.retentionPendingIntent;[\s\S]*?archiveState\.retentionPendingIntent = null/);
    assert.match(drainSource, /await api\.setRetentionDays/);
    assert.match(drainSource, /const isLatestIntent = intent\.token === archiveState\.retentionIntentToken[\s\S]*?&& !archiveState\.retentionPendingIntent/);
    assert.match(drainSource, /if \(failure\) \{[\s\S]*?if \(!isLatestIntent\) continue;[\s\S]*?retentionSelect\.value = archiveState\.savedRetentionValue/);
    assert.match(renderer, /archiveState\.retentionIntentToken \+= 1/);
    assert.match(renderer, /if \(!archiveState\.retentionSavePromise\)/);
    assert.match(renderer, /!archiveState\.destroyed && overlay\.isConnected/);
    assert.match(renderer, /archiveState\.destroyed = true/);
  });

  test('批次列表严格两行并保留状态、时间、锁定、焦点和 aria-current', () => {
    const listStart = renderer.indexOf('function renderArchiveBatches');
    const relatedStart = renderer.indexOf('function renderArchiveRelatedBatches', listStart);
    const listSource = renderer.slice(listStart, relatedStart);
    assert.match(listSource, /archive-center-batch-row archive-center-batch-row-primary/);
    assert.match(listSource, /data-role="archive-batch-module"/);
    assert.match(listSource, /data-role="archive-batch-number" title=/);
    assert.match(listSource, /archive-center-lock-mark[^>]*title="已锁定"[^>]*>🔒/);
    assert.match(listSource, /archive-center-batch-row archive-center-batch-row-secondary/);
    assert.match(listSource, /data-role="archive-batch-status"/);
    assert.match(listSource, /<time data-role="archive-batch-time"/);
    assert.doesNotMatch(listSource, /archive-center-batch-module|archive-center-batch-meta/);
    assert.match(styles, /\.archive-center-batch-item:hover/);
    assert.match(styles, /\.archive-center-batch-item:focus-visible/);
    assert.match(styles, /\.archive-center-batch-item\.is-active/);
    assert.match(listSource, /aria-current="\$\{active \? 'true' : 'false'\}"/);
  });

  test('详情独立投影任务状态，列表与详情存档状态支持合法 staging', () => {
    const statusStart = renderer.indexOf('function archiveCenterStatusKey');
    const moduleStart = renderer.indexOf('function archiveCenterModuleName', statusStart);
    const statusSource = renderer.slice(statusStart, moduleStart);
    assert.match(statusSource, /\['running', 'retrying', 'pending', 'staging'\]/);
    assert.match(statusSource, /function archiveCenterTaskStatusText\(item\)/);
    for (const [status, text] of [
      ['reserved', '已预留'],
      ['running', '运行中'],
      ['succeeded', '已完成'],
      ['failed', '任务失败'],
      ['cancelled', '已取消']
    ]) {
      assert.match(statusSource, new RegExp(`status === '${status}'\\) return '${text}'`));
    }
    assert.match(statusSource, /item\?\.businessStatusText \?\? item\?\.businessStatus/);

    const listStart = renderer.indexOf('function renderArchiveBatches');
    const relatedStart = renderer.indexOf('function renderArchiveRelatedBatches', listStart);
    const listSource = renderer.slice(listStart, relatedStart);
    assert.match(listSource, /archiveCenterStatusKey\(batch\.archiveStatus \?\? batch\.status\)/);
    assert.doesNotMatch(listSource, /taskStatus/);

    const detailStart = renderer.indexOf('function renderArchiveDetail');
    const statsStart = renderer.indexOf('function renderArchiveStats', detailStart);
    const detailSource = renderer.slice(detailStart, statsStart);
    assert.match(detailSource, /data-role="archive-task-status">\$\{escapeHtml\(archiveCenterTaskStatusText\(batch\)\)\}/);
    assert.match(detailSource, /data-role="archive-detail-status" data-status="\$\{status\}"/);
    assert.match(detailSource, /archiveCenterStatusKey\(batch\.archiveStatus \?\? batch\.status\)/);

    const previewStart = renderer.indexOf('function createArchiveCenterPreviewApi');
    const settingsStart = renderer.indexOf('function createAppUpdateSettingsDialog', previewStart);
    const previewSource = renderer.slice(previewStart, settingsStart);
    assert.match(previewSource, /taskStatus: 'failed',[\s\S]*?archiveStatus: 'complete',[\s\S]*?businessStatus: ''/);
    assert.match(previewSource, /taskStatus: 'cancelled',[\s\S]*?archiveStatus: 'complete',[\s\S]*?businessStatus: ''/);
    assert.match(previewSource, /taskStatus: 'running',[\s\S]*?archiveStatus: 'staging',[\s\S]*?businessStatus: ''/);
    assert.doesNotMatch(previewSource, /archiveStatus: 'failed'|businessStatus: '已完成'/);
  });

  test('详情使用结构化 relatedBatches 同日/跨日分组并只切换现有 selectedBatchId', () => {
    const relatedStart = renderer.indexOf('function renderArchiveRelatedBatches');
    const detailStart = renderer.indexOf('function renderArchiveDetail', relatedStart);
    const relatedSource = renderer.slice(relatedStart, detailStart);
    assert.match(relatedSource, /Array\.isArray\(batch\.relatedBatches\)/);
    assert.match(relatedSource, /if \(related\.length < 2\) return ''/);
    assert.match(relatedSource, /item\.localDate/);
    assert.match(relatedSource, /item\.globalDailySequence/);
    assert.match(relatedSource, /padStart\(3, '0'\)/);
    assert.match(relatedSource, /archive-center-related-group-separator[^>]*> · </);
    assert.match(relatedSource, /data-action="view-related-batch"/);
    assert.doesNotMatch(relatedSource, /parentRunId|taskKey|taskRunId|split\(|match\(|exec\(/);
    assert.match(renderer, /action === 'view-related-batch'[\s\S]*?selectArchiveBatch\(button\.dataset\.relatedBatchId\)/);
    const selectStart = renderer.indexOf('function selectArchiveBatch');
    const listClickStart = renderer.indexOf("batchList.addEventListener('click'", selectStart);
    const selectSource = renderer.slice(selectStart, listClickStart);
    assert.match(selectSource, /archiveState\.selectedBatchId = nextBatchId/);
    assert.match(selectSource, /loadArchiveDetail\(nextBatchId\)/);
    assert.doesNotMatch(selectSource, /reserve|createBatch|Task/);
  });

  test('详情按钮文案和无障碍名称符合锁定、打开、另存为合同', () => {
    assert.match(renderer, /title="打开只读副本" aria-label="打开只读副本">打开<\/button>/);
    assert.match(renderer, /title="另存为" aria-label="另存为">💾<\/button>/);
    assert.match(renderer, /file\.businessLocked === true[\s\S]*?aria-label="业务引用锁" disabled>🔒<\/button>/);
    assert.match(renderer, /businessLocked \? '业务引用锁不能手工解除'/);
    assert.match(renderer, /businessLocked \? '🔒' : \(locked \? '🔓' : '🔒'\)/);
    assert.match(renderer, /deletionLocked \? ' disabled' : ''/);
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
    assert.match(renderer, /batch\.retryMode === 'select-source'/);
    assert.match(renderer, /选择原文件并重试/);

    const lockStart = renderer.indexOf('async function toggleArchiveBatchLock');
    const retryStart = renderer.indexOf('async function retryArchiveBatch', lockStart);
    const deleteStart = renderer.indexOf('function confirmArchiveBatchDelete', retryStart);
    const retrySource = renderer.slice(retryStart, deleteStart);
    assert.match(renderer.slice(lockStart, retryStart), /finally \{[\s\S]*?button\.isConnected/);
    assert.match(retrySource, /let retryAttempted = false/);
    assert.match(
      retrySource,
      /retryAttempted = true;[\s\S]*?retryBatch\(batchId, sourcePaths\)/
    );
    assert.match(
      retrySource,
      /finally \{[\s\S]*?if \(retryAttempted\)[\s\S]*?loadArchiveBatches\(\{ clearFeedback: false \}\)[\s\S]*?loadArchiveStats\(\)[\s\S]*?showArchiveFeedback\([\s\S]*?button\.isConnected/
    );
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

  test('迁移恢复完成前，Controller、FlowResolver 与 TaskLifecycle 仅共享稳定 delegate', () => {
    assert.match(main, /const runtimeService = createArchiveRuntimeDelegate\(/);
    assert.match(main, /service:\s*runtimeService,[\s\S]*?storageRootManager:/);
    assert.match(main, /createBusinessFlowResolver\(\{ archiveService: runtimeService \}\)/);
    assert.match(main, /createTaskLifecycle\(\{[\s\S]*?archiveService: runtimeService,/);
    assert.match(main, /runtimeDelegate:\s*runtimeService/);
  });

  test('启动放行必须等待 storage journal 恢复，失败时 delegate 保持 unavailable', () => {
    const initStart = main.indexOf('async function runBackgroundInitChain');
    const initEnd = main.indexOf('function markAppInitDone', initStart);
    const initFlow = main.slice(initStart, initEnd);
    const pendingDbIndex = initFlow.indexOf("pendingDb = openPendingDb(app.getPath('userData'))");
    const createIndex = initFlow.indexOf('initializeArchiveCenter()');
    const recoveryIndex = initFlow.indexOf(
      'await archiveCenterInitializationPromise',
      createIndex
    );
    const postSetupIndex = initFlow.indexOf('runStartupPostSetup()', recoveryIndex);
    assert.ok(
      pendingDbIndex >= 0
        && createIndex > pendingDbIndex
        && recoveryIndex > createIndex
        && postSetupIndex > recoveryIndex,
      'Pending DB migrations 必须先于 Archive owner recovery，且启动只保留一个 open 入口'
    );
    assert.equal(
      (initFlow.match(/pendingDb = openPendingDb\(app\.getPath\('userData'\)\)/g) || []).length,
      1
    );
    assert.match(main, /setImmediate\(async \(\) => \{[\s\S]*?await runBackgroundInitChain\(\)/);
    assert.match(main, /else \{[\s\S]*?await runBackgroundInitChain\(\);[\s\S]*?markAppInitDone\(\)/);
  });
});
