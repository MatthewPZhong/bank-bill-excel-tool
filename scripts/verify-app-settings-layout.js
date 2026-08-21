'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VIEWPORTS = [
  { width: 1240, height: 860 },
  { width: 1080, height: 760 }
];
const SCALE_FACTORS = [1, 1.25, 1.5];
const RESULT_PREFIX = 'APP_SETTINGS_LAYOUT_RESULT=';

function runParent() {
  const electronBinary = require('electron');
  const projectRoot = path.resolve(__dirname, '..');
  const failures = [];

  for (const viewport of VIEWPORTS) {
    for (const scaleFactor of SCALE_FACTORS) {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-settings-layout-'));
      const child = spawnSync(electronBinary, [__filename], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          APP_SETTINGS_LAYOUT_CHILD: '1',
          APP_SETTINGS_LAYOUT_WIDTH: String(viewport.width),
          APP_SETTINGS_LAYOUT_HEIGHT: String(viewport.height),
          APP_SETTINGS_LAYOUT_SCALE: String(scaleFactor),
          APP_SETTINGS_LAYOUT_USER_DATA: userDataDir,
          APP_SETTINGS_LAYOUT_RUN_BEHAVIOR: viewport.width === 1240 && scaleFactor === 1 ? '1' : '0',
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
        }
      });

      fs.rmSync(userDataDir, { recursive: true, force: true });

      const outputLines = String(child.stdout || '').trim().split(/\r?\n/);
      const resultLine = outputLines.find((line) => line.startsWith(RESULT_PREFIX));
      if (child.error || child.status !== 0 || !resultLine) {
        failures.push({
          viewport,
          scaleFactor,
          reason: child.error ? child.error.message : `electron exit ${child.status}`,
          stdout: String(child.stdout || '').trim(),
          stderr: String(child.stderr || '').trim()
        });
        continue;
      }

      const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
      console.log(
        `[app-settings-layout] ${viewport.width}x${viewport.height} @ ${scaleFactor * 100}% ` +
        `${result.ok ? 'PASS' : 'FAIL'} ` +
        `(right=${result.metrics.rightEdgeDelta.toFixed(4)}px, ` +
        `font=${result.metrics.toggleFontSize}, dpr=${result.metrics.devicePixelRatio})`
      );
      if (!result.ok) failures.push({ viewport, scaleFactor, details: result.failures });
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('[app-settings-layout] 6/6 PASS');
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function waitFor(test, timeoutMs = 2000) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (test()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        reject(new Error('等待设置弹窗状态超时'));
        return;
      }
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function installDesktopApiStub({ retentionDays = 60, retentionHandler = null } = {}) {
  window.__retentionSaveCalls = [];
  window.__archiveListCalls = [];
  const batches = [
    {
      internalId: 101,
      batchId: '2026-08-10-127',
      batchNumber: '2026-08-10-127',
      moduleId: 'bank-statement-process',
      moduleName: '超长模块名称用于验证最小窗口下省略显示但完整标题仍可访问',
      taskStatus: 'failed',
      archiveStatus: 'complete',
      businessStatus: '',
      locked: true,
      createdAt: '2026-08-10T06:36:08.000Z'
    },
    {
      internalId: 102,
      batchId: '2026-08-11-001',
      batchNumber: '2026-08-11-001',
      moduleId: 'vcc-financial-op',
      moduleName: 'VCC财务OP校验',
      taskStatus: 'cancelled',
      archiveStatus: 'complete',
      businessStatus: '',
      createdAt: '2026-08-11T06:37:09.000Z'
    },
    {
      internalId: 103,
      batchId: '2026-08-11-002',
      batchNumber: '2026-08-11-002',
      moduleId: 'toolbox',
      moduleName: '工具箱',
      taskStatus: 'running',
      archiveStatus: 'staging',
      businessStatus: '',
      createdAt: '2026-08-11T06:38:10.000Z'
    },
    {
      internalId: 104,
      batchId: 'BANK-20260720-001',
      batchNumber: 'BANK-20260720-001',
      moduleId: 'bank-statement-process',
      moduleName: '资金对账数据处理',
      taskStatus: 'succeeded',
      archiveStatus: 'incomplete',
      businessStatus: '',
      createdAt: '2026-07-20T06:39:11.000Z'
    }
  ];
  const relatedBatches = [
    { batchId: 101, batchNumber: '2026-08-10-127', localDate: '2026-08-10', globalDailySequence: 127 },
    { batchId: 102, batchNumber: '2026-08-11-001', localDate: '2026-08-11', globalDailySequence: 1 },
    { batchId: 103, batchNumber: '2026-08-11-002', localDate: '2026-08-11', globalDailySequence: 2 }
  ];
  const archiveCenter = {
    async listBatches(filters = {}) {
      window.__archiveListCalls.push({ ...filters });
      return { status: 'success', batches };
    },
    async getBatch(batchId) {
      const batch = batches.find((item) => String(item.internalId) === String(batchId));
      return batch
        ? {
            status: 'success',
            batch: {
              ...batch,
              parentRunId: 'internal-parent-must-not-render',
              relatedBatches,
              retentionUntil: '2026-11-09',
              files: [{
                fileRefId: 501,
                fileName: '用于验证超长文件名省略但仍可安全打开和另存的对账结果文件.xlsx',
                direction: 'output',
                role: 'output',
                sizeBytes: 4096,
                archiveStatus: 'ready'
              }]
            }
          }
        : { status: 'failed', message: '未找到批次' };
    },
    async openFile() { return { status: 'success' }; },
    async saveAs() { return { status: 'cancelled' }; },
    async setLocked() { return { status: 'success' }; },
    async deleteBatch() { return { status: 'success', metadataDeleted: true }; },
    async retryBatch() { return { status: 'success' }; },
    async getSettings() {
      return {
        status: 'success',
        settings: {
          retentionDays,
          storageRoot: '/very/long/archive/root/用于验证存档位置完整换行和选择/年份/月/日期/批次号',
          storageMigration: { status: 'idle', phase: '', processed: 0, total: 0 }
        }
      };
    },
    async setRetentionDays(value) {
      window.__retentionSaveCalls.push(value);
      if (typeof retentionHandler === 'function') return retentionHandler(value);
      return { status: 'success', settings: { retentionDays: value } };
    },
    async getStats() {
      return {
        status: 'success',
        stats: {
          storagePath: '/very/long/archive/root/用于验证存档位置完整换行和选择/年份/月/日期/批次号',
          fileTotalBytes: 1325400064,
          runCount: 128,
          latestBatchNumber: '2026-08-11-128',
          latestBatchId: 128,
          latestBatchStatus: 'succeeded',
          migrationStatus: { status: 'idle', phase: '', processed: 0, total: 0 }
        }
      };
    },
    onStorageMigrationProgress() { return () => {}; }
  };
  const desktopApi = {
    archiveCenter,
    appUpdate: {
      async setEnabled() { return { status: 'success' }; },
      async checkNow() { return { status: 'success' }; },
      async restartAndInstall() { return { status: 'success' }; }
    }
  };
  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    value: desktopApi
  });
}

function openSettingsDialog() {
  const modalRoot = document.getElementById('modalRoot');
  modalRoot.innerHTML = '';
  modalRoot.appendChild(createAppUpdateSettingsDialog());
  return modalRoot;
}

async function openArchiveSettings() {
  document.querySelector('.app-settings-nav-item[data-tab="archive"]').click();
  await waitFor(() => !document.querySelector('[data-pane="archive"]').hidden);
  document.querySelector('[data-action="open-archive-settings"]').click();
  await waitFor(() => (
    !document.querySelector('[data-archive-view="settings"]').hidden
    && !document.querySelector('[data-archive-view="settings"]').hasAttribute('aria-busy')
  ));
}

function changeRetention(value) {
  const select = document.querySelector('[data-role="archive-retention-days"]');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function verifyArchiveRetentionBehavior(failures) {
  const oldFailure = createDeferred();
  let activeSaves = 0;
  let maxActiveSaves = 0;
  installDesktopApiStub({
    retentionDays: 30,
    retentionHandler(value) {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      const result = value === 60
        ? oldFailure.promise
        : Promise.resolve({ status: 'success', settings: { retentionDays: value } });
      return result.finally(() => { activeSaves -= 1; });
    }
  });
  openSettingsDialog();
  await openArchiveSettings();
  changeRetention('60');
  await waitFor(() => JSON.stringify(window.__retentionSaveCalls) === '[60]');
  changeRetention('90');
  changeRetention('180');
  if (JSON.stringify(window.__retentionSaveCalls) !== '[60]') {
    failures.push(`pending intents wrote concurrently: ${JSON.stringify(window.__retentionSaveCalls)}`);
  }
  const pendingReturn = document.querySelector('[data-role="close-update-dialog"]');
  const pendingClose = document.querySelector('[data-action="close"]');
  if (!pendingReturn.disabled || !pendingClose.disabled) failures.push('pending save did not disable Return/X');
  pendingClose.click();
  if (document.getElementById('modalRoot').childElementCount !== 1) failures.push('disabled X closed pending dialog');
  oldFailure.resolve({ status: 'failed', message: '旧请求失败不应成为最终错误' });
  await waitFor(() => JSON.stringify(window.__retentionSaveCalls) === '[60,180]');
  await waitFor(() => document.querySelector('[data-role="archive-retention-days"]').value === '180');
  const oldFailureFeedback = document.querySelector('[data-role="archive-feedback"]').textContent;
  if (oldFailureFeedback.includes('旧请求失败')) failures.push('stale failed intent rendered final error');
  if (maxActiveSaves !== 1) failures.push(`retention saves ran concurrently: ${maxActiveSaves}`);
  if (pendingReturn.disabled || pendingClose.disabled) failures.push('final settle left Return/X disabled');

  const finalFailure = createDeferred();
  installDesktopApiStub({ retentionDays: 60, retentionHandler: () => finalFailure.promise });
  openSettingsDialog();
  await openArchiveSettings();
  changeRetention('180');
  await waitFor(() => window.__retentionSaveCalls.length === 1);
  finalFailure.resolve({ status: 'failed', message: '最终保存失败' });
  await waitFor(() => document.querySelector('[data-role="archive-feedback"]').textContent.includes('最终保存失败'));
  if (document.querySelector('[data-role="archive-retention-days"]').value !== '60') {
    failures.push('final failure did not restore last persisted value');
  }
  if (document.querySelector('[data-role="close-update-dialog"]').disabled
      || document.querySelector('[data-action="close"]').disabled) {
    failures.push('final failure left Return/X disabled');
  }

  const destroyedSave = createDeferred();
  installDesktopApiStub({ retentionDays: 60, retentionHandler: () => destroyedSave.promise });
  const modalRoot = openSettingsDialog();
  await openArchiveSettings();
  changeRetention('90');
  await waitFor(() => window.__retentionSaveCalls.length === 1);
  const detachedFeedback = document.querySelector('[data-role="archive-feedback"]');
  const feedbackBeforeDestroy = detachedFeedback.textContent;
  modalRoot.innerHTML = '';
  destroyedSave.resolve({ status: 'failed', message: '销毁后不得写入' });
  await Promise.resolve();
  await Promise.resolve();
  if (detachedFeedback.textContent !== feedbackBeforeDestroy) {
    failures.push('destroyed dialog promise wrote detached feedback');
  }
}

async function verifyArchiveBrowserLayout(failures) {
  document.querySelector('.app-settings-nav-item[data-tab="archive"]').click();
  await waitFor(() => document.querySelectorAll('.archive-center-batch-item').length === 4);
  await waitFor(() => document.querySelectorAll('.archive-center-related-batch').length === 3);

  const dateFilter = document.querySelector('[data-filter="date"]');
  const initialListFilters = window.__archiveListCalls[0] || null;
  if (dateFilter.value !== '') failures.push(`archive date default is not empty: ${dateFilter.value}`);
  if (!initialListFilters
      || initialListFilters.localDate !== ''
      || initialListFilters.moduleId !== ''
      || initialListFilters.batchNumber !== '') {
    failures.push(`initial archive filters are not empty: ${JSON.stringify(initialListFilters)}`);
  }

  const headerCopy = document.querySelector('.archive-center-header-copy');
  const archiveHeading = document.getElementById('archiveCenterHeading');
  const archiveSettingsButton = document.querySelector('[data-action="open-archive-settings"]');
  const storageSummary = document.querySelector('.archive-center-storage-summary');
  if (archiveSettingsButton.parentElement !== headerCopy
      || archiveSettingsButton.previousElementSibling !== archiveHeading) {
    failures.push('archive settings button is not immediately after archive center heading');
  }
  if (storageSummary.contains(archiveSettingsButton)) {
    failures.push('archive settings button still belongs to storage summary');
  }
  const browserFileTotal = storageSummary.querySelector('[data-role="archive-file-total-size"]');
  if (!browserFileTotal || browserFileTotal.textContent.trim() === '-') {
    failures.push('browser file total size is missing');
  }
  const archiveHeadingRect = archiveHeading.getBoundingClientRect();
  const settingsRect = archiveSettingsButton.getBoundingClientRect();
  const settingsGap = settingsRect.left - archiveHeadingRect.right;
  if (settingsGap < -1 || settingsGap > 16
      || Math.abs((archiveHeadingRect.top + archiveHeadingRect.bottom) / 2 - (settingsRect.top + settingsRect.bottom) / 2) > 2) {
    failures.push(`archive settings button is not adjacent/aligned: gap=${settingsGap}`);
  }

  for (const item of document.querySelectorAll('.archive-center-batch-item')) {
    const rows = item.querySelectorAll(':scope > .archive-center-batch-row');
    if (rows.length !== 2) failures.push(`archive batch direct row count ${rows.length}`);
  }
  const firstItem = document.querySelector('.archive-center-batch-item');
  const moduleName = firstItem.querySelector('[data-role="archive-batch-module"]');
  const batchNumber = firstItem.querySelector('[data-role="archive-batch-number"]');
  if (!moduleName.title.includes('超长模块名称')) failures.push('long module title missing');
  if (batchNumber.title !== '2026-08-10-127') failures.push(`batch number title ${batchNumber.title}`);
  if (batchNumber.scrollWidth > batchNumber.clientWidth + 1) {
    failures.push('old batch number is not visually identifiable');
  }
  firstItem.focus();
  if (document.activeElement !== firstItem) failures.push('batch item cannot receive keyboard focus');

  const detailTitle = document.querySelector('.archive-center-detail-title-line h4');
  const related = document.querySelector('.archive-center-related');
  const detailActions = document.querySelector('.archive-center-detail-actions');
  if (detailTitle.scrollWidth > detailTitle.clientWidth + 1) {
    failures.push('current batch number is not visually identifiable');
  }
  const titleRect = detailTitle.getBoundingClientRect();
  const relatedRect = related.getBoundingClientRect();
  if (Math.abs((titleRect.top + titleRect.bottom) / 2 - (relatedRect.top + relatedRect.bottom) / 2) > 2) {
    failures.push('related batches left the current-number title line');
  }
  const actionsRect = detailActions.getBoundingClientRect();
  const headingContentRect = detailTitle.parentElement.parentElement.getBoundingClientRect();
  const actionsOverlapContent = actionsRect.left < headingContentRect.right
    && actionsRect.right > headingContentRect.left
    && actionsRect.top < headingContentRect.bottom
    && actionsRect.bottom > headingContentRect.top;
  if (actionsOverlapContent) failures.push('detail actions overlap title content');

  const relatedText = document.querySelector('.archive-center-related').textContent.replace(/\s+/g, '');
  if (relatedText !== '关联任务：2026-08-10-127·2026-08-11-001/002') {
    failures.push(`related grouped text ${relatedText}`);
  }
  if (document.querySelector('.archive-center-detail-heading').textContent.includes('internal-parent')) {
    failures.push('parentRunId rendered in detail');
  }
  const initialTaskStatus = document.querySelector('[data-role="archive-task-status"]')?.textContent.trim();
  const initialArchiveStatus = document.querySelector('[data-role="archive-detail-status"]')?.textContent.trim();
  if (initialTaskStatus !== '任务失败' || initialArchiveStatus !== '存档完成') {
    failures.push(`failed task/detail status ${initialTaskStatus}/${initialArchiveStatus}`);
  }
  const stagingListStatus = document.querySelector('[data-batch-id="103"] [data-role="archive-batch-status"]');
  if (stagingListStatus?.dataset.status !== 'pending' || stagingListStatus?.textContent.trim() !== '处理中') {
    failures.push(`staging list status ${stagingListStatus?.dataset.status}/${stagingListStatus?.textContent.trim()}`);
  }
  const initialRunningTarget = document.querySelector('[data-related-batch-id="103"]');
  const focusableOrder = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  const relatedIndex = focusableOrder.indexOf(initialRunningTarget);
  const lockIndex = focusableOrder.indexOf(document.querySelector('[data-action="toggle-archive-lock"]'));
  const openIndex = focusableOrder.indexOf(document.querySelector('[data-action="open-archive-file"]'));
  const saveIndex = focusableOrder.indexOf(document.querySelector('[data-action="save-as-archive-file"]'));
  if (relatedIndex < 0 || lockIndex <= relatedIndex || openIndex <= lockIndex || saveIndex <= openIndex) {
    failures.push(`detail tab order drifted: related=${relatedIndex}, lock=${lockIndex}, open=${openIndex}, save=${saveIndex}`);
  }
  document.querySelector('[data-related-batch-id="102"]').click();
  await waitFor(() => (
    document.querySelector('.archive-center-detail-heading h4')?.textContent.trim()
      === '2026-08-11-001'
  ));
  const cancelledTaskStatus = document.querySelector('[data-role="archive-task-status"]')?.textContent.trim();
  const cancelledArchiveStatus = document.querySelector('[data-role="archive-detail-status"]')?.textContent.trim();
  if (cancelledTaskStatus !== '已取消' || cancelledArchiveStatus !== '存档完成') {
    failures.push(`cancelled task/detail status ${cancelledTaskStatus}/${cancelledArchiveStatus}`);
  }
  document.querySelector('[data-related-batch-id="103"]').click();
  await waitFor(() => (
    document.querySelector('.archive-center-detail-heading h4')?.textContent.trim()
      === '2026-08-11-002'
  ));
  const runningTaskStatus = document.querySelector('[data-role="archive-task-status"]')?.textContent.trim();
  const stagingArchiveStatus = document.querySelector('[data-role="archive-detail-status"]')?.textContent.trim();
  if (runningTaskStatus !== '运行中' || stagingArchiveStatus !== '处理中') {
    failures.push(`running task/detail status ${runningTaskStatus}/${stagingArchiveStatus}`);
  }
  const statusProjectionText = `${initialTaskStatus}${initialArchiveStatus}${cancelledTaskStatus}${cancelledArchiveStatus}${runningTaskStatus}${stagingArchiveStatus}`;
  if (statusProjectionText.includes('-') || statusProjectionText.includes('状态未知')) {
    failures.push(`task/archive status projection is not observable: ${statusProjectionText}`);
  }
  if (document.querySelectorAll('.archive-center-related-batch[aria-current="true"]').length !== 1) {
    failures.push('related current batch aria state invalid');
  }

  const browserRect = document.querySelector('.archive-center-browser').getBoundingClientRect();
  for (const field of document.querySelectorAll('.archive-center-filters .archive-center-field')) {
    const rect = field.getBoundingClientRect();
    if (rect.left < browserRect.left - 1 || rect.right > browserRect.right + 1) {
      failures.push('archive filter is clipped by browser viewport');
      break;
    }
  }

  document.querySelector('[data-action="open-archive-settings"]').click();
  await waitFor(() => (
    !document.querySelector('[data-archive-view="settings"]').hidden
    && !document.querySelector('[data-archive-view="settings"]').hasAttribute('aria-busy')
  ));
  const storagePath = document.querySelector('[data-role="archive-storage-path"]');
  const storageHeading = document.querySelector('.archive-center-storage-location-heading');
  const storageLabel = storageHeading.querySelector('span');
  const storageChange = document.querySelector('[data-action="change-archive-storage"]');
  const storageStyle = getComputedStyle(storagePath);
  const storageRect = storagePath.getBoundingClientRect();
  const headingRect = storageHeading.getBoundingClientRect();
  const storageLabelRect = storageLabel.getBoundingClientRect();
  const changeRect = storageChange.getBoundingClientRect();
  if (!storagePath.title.includes('用于验证存档位置完整换行和选择')) {
    failures.push('storage path full title missing');
  }
  if (storagePath.textContent !== storagePath.title) failures.push('storage path text is not complete');
  if (storageStyle.textOverflow === 'ellipsis') failures.push('storage path must not use ellipsis');
  if (storageStyle.whiteSpace !== 'normal' || storageStyle.overflowWrap !== 'anywhere') {
    failures.push(`storage path wrapping drifted: ${storageStyle.whiteSpace}/${storageStyle.overflowWrap}`);
  }
  if (storageStyle.userSelect !== 'text') failures.push(`storage path is not selectable: ${storageStyle.userSelect}`);
  const changeGap = changeRect.left - storageLabelRect.right;
  if (storageChange.previousElementSibling !== storageLabel
      || changeGap < -1
      || changeGap > 18
      || Math.abs((storageLabelRect.top + storageLabelRect.bottom) / 2 - (changeRect.top + changeRect.bottom) / 2) > 2
      || storageRect.top < headingRect.bottom - 1) {
    failures.push('storage location heading/button/path are not arranged in two rows');
  }
  const settingsView = document.querySelector('[data-archive-view="settings"]');
  if (document.querySelector('[data-role="archive-settings-file-total-size"]')
      || settingsView.textContent.includes('存储统计')
      || settingsView.textContent.includes('文件总大小')) {
    failures.push('removed archive settings storage stats are still rendered');
  }
  if (document.querySelector('[data-role="archive-stat-runs"]')
      || document.querySelector('[data-role="archive-stat-latest"]')
      || settingsView.textContent.includes('运行次数')
      || settingsView.textContent.includes('最新批次')) {
    failures.push('removed archive run/latest stats are still rendered');
  }
  for (const removed of ['唯一文件', '逻辑文件', '文件引用']) {
    if (document.querySelector('.app-update-settings-card').textContent.includes(removed)) {
      failures.push(`internal archive term rendered: ${removed}`);
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    failures.push('archive document horizontal overflow');
  }
}

async function measurePage(expectedScaleFactor, runBehavior) {
  const failures = [];
  document.body.dataset.platform = 'win32';
  installDesktopApiStub();
  openSettingsDialog();
  await nextFrame();

  const body = document.querySelector('.app-update-settings-body');
  const confirmButton = document.querySelector('[data-role="close-update-dialog"]');
  const toggleText = document.querySelector('[data-role="auto-update-toggle-text"]');
  const rowValue = document.querySelector('[data-role="current-version"]');
  const note = document.querySelector('[data-role="update-note"]');
  const bodyRect = body.getBoundingClientRect();
  const confirmRect = confirmButton.getBoundingClientRect();
  const rightEdgeDelta = Math.abs(bodyRect.right - confirmRect.left);
  const toggleFontSize = getComputedStyle(toggleText).fontSize;
  const valueFontSize = getComputedStyle(rowValue).fontSize;

  if (Math.abs(window.devicePixelRatio - expectedScaleFactor) > 0.01) {
    failures.push(`device scale factor: expected ${expectedScaleFactor}, got ${window.devicePixelRatio}`);
  }
  if (rightEdgeDelta > 1) failures.push(`right edge delta ${rightEdgeDelta}`);
  if (toggleFontSize !== '14px' || valueFontSize !== '14px') {
    failures.push(`font sizes toggle=${toggleFontSize}, value=${valueFontSize}`);
  }
  if (!note.hidden || note.textContent !== '') failures.push('NSIS update note should be collapsed');
  if (confirmButton.textContent.trim() !== '返回') failures.push(`unexpected return text ${confirmButton.textContent}`);
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    failures.push('document horizontal overflow');
  }

  const removedTexts = [
    '管理软件版本检查、下载与安装。',
    '开启后每次启动仅在后台检查一次，不会定时检查。',
    '按日期、模块和批次号查看已参与处理的输入文件与结果表。',
    '锁定批次不参与自动清理。默认保留期为 90 天。',
    '默认保留'
  ];
  for (const text of removedTexts) {
    if (document.body.textContent.includes(text)) failures.push(`removed text remains: ${text}`);
  }

  await verifyArchiveBrowserLayout(failures);

  if (runBehavior) {
    applyAppUpdateStatus({
      enabled: true,
      supported: true,
      distribution: 'nsis',
      state: 'downloaded',
      currentVersion: '3.0.25',
      targetVersion: '3.0.26',
      percent: 100,
      lastCheckedAt: '2026-07-23T12:00:00.000Z',
      canRestart: true,
      busyOperations: [],
      error: ''
    }, { prompt: false });
    if (confirmButton.textContent.trim() !== '返回') {
      failures.push(`downloaded update button text ${confirmButton.textContent}`);
    }
    await verifyArchiveRetentionBehavior(failures);
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      rightEdgeDelta,
      toggleFontSize,
      devicePixelRatio: window.devicePixelRatio
    }
  };
}

async function runElectronChild() {
  const { app, BrowserWindow } = require('electron');
  const width = Number(process.env.APP_SETTINGS_LAYOUT_WIDTH);
  const height = Number(process.env.APP_SETTINGS_LAYOUT_HEIGHT);
  const scaleFactor = Number(process.env.APP_SETTINGS_LAYOUT_SCALE);
  const runBehavior = process.env.APP_SETTINGS_LAYOUT_RUN_BEHAVIOR === '1';

  app.commandLine.appendSwitch('force-device-scale-factor', String(scaleFactor));
  app.disableHardwareAcceleration();
  if (process.env.APP_SETTINGS_LAYOUT_USER_DATA) {
    app.setPath('userData', process.env.APP_SETTINGS_LAYOUT_USER_DATA);
  }

  await app.whenReady();
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 1080,
    minHeight: 760,
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  try {
    await window.loadFile(path.resolve(__dirname, '..', 'index.html'));
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scaleFactor,
      mobile: false,
      screenWidth: width,
      screenHeight: height
    });
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        ${nextFrame.toString()}
        ${waitFor.toString()}
        ${createDeferred.toString()}
        ${installDesktopApiStub.toString()}
        ${openSettingsDialog.toString()}
        ${openArchiveSettings.toString()}
        ${changeRetention.toString()}
        ${verifyArchiveRetentionBehavior.toString()}
        ${verifyArchiveBrowserLayout.toString()}
        return (${measurePage.toString()})(${JSON.stringify(scaleFactor)}, ${JSON.stringify(runBehavior)});
      })()
    `);
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    app.quit();
  }
}

if (process.versions.electron && process.env.APP_SETTINGS_LAYOUT_CHILD === '1') {
  runElectronChild().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    const { app } = require('electron');
    app.exit(1);
  });
} else {
  runParent();
}
