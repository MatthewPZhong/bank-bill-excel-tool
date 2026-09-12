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
        `font=${result.metrics.toggleFontSize}, dpr=${result.metrics.devicePixelRatio}, ` +
        `retentionControls=${result.metrics.retentionControlCount})`
      );
      if (result.screenshotPath) console.log(`[app-settings-layout] screenshot: ${result.screenshotPath}`);
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

function installDesktopApiStub({
  retentionDays = 60,
  retentionDaysByModule = {},
  retentionHandler = null,
  moduleRetentionHandler = null,
  settingsHandler = null,
  statsHandler = null
} = {}) {
  window.__retentionSaveCalls = [];
  window.__moduleRetentionSaveCalls = [];
  window.__archiveListCalls = [];
  window.__archiveDeleteCalls = [];
  const savedModuleRetentions = { ...retentionDaysByModule };
  const retentionModules = [
    { id: 'bank-statement-process', name: '资金对账数据处理' },
    { id: 'vcc-financial-op', name: 'VCC财务OP校验' },
    { id: 'bank-bu-recon', name: '月度银行对账单BU回填校验' },
    { id: 'toolbox', name: '工具箱' }
  ];
  const getSavedSettings = () => ({
    retentionDays,
    retentionDaysByModule: { ...savedModuleRetentions },
    retentionModules: retentionModules.map((module) => ({ ...module })),
    storageRoot: '/very/long/archive/root/用于验证存档位置完整换行和选择/年份/月/日期/批次号',
    storageMigration: { status: 'idle', phase: '', processed: 0, total: 0 }
  });
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
    async deleteBatch(batchId) {
      window.__archiveDeleteCalls.push(batchId);
      return { status: 'success', metadataDeleted: true };
    },
    async retryBatch() { return { status: 'success' }; },
    async getSettings() {
      if (typeof settingsHandler === 'function') return settingsHandler(getSavedSettings());
      return { status: 'success', settings: getSavedSettings() };
    },
    async setRetentionDays(value) {
      window.__retentionSaveCalls.push(value);
      const result = typeof retentionHandler === 'function'
        ? await retentionHandler(value)
        : { status: 'success', settings: { retentionDays: value } };
      if (result?.status === 'success') retentionDays = value;
      return result;
    },
    async setModuleRetentionDays(payload) {
      window.__moduleRetentionSaveCalls.push({ ...payload });
      const result = typeof moduleRetentionHandler === 'function'
        ? await moduleRetentionHandler(payload)
        : { status: 'success', settings: {
            retentionDaysByModule: payload.retentionDays === 'inherit'
              ? {}
              : { [payload.moduleId]: payload.retentionDays }
          } };
      if (result?.status === 'success') {
        if (payload.retentionDays === 'inherit') delete savedModuleRetentions[payload.moduleId];
        else savedModuleRetentions[payload.moduleId] = payload.retentionDays;
      }
      return result;
    },
    async getStats() {
      const stats = {
        storagePath: '/very/long/archive/root/用于验证存档位置完整换行和选择/年份/月/日期/批次号',
        fileTotalBytes: 1325400064,
        runCount: 128,
        latestBatchNumber: '2026-08-11-128',
        latestBatchId: 128,
        latestBatchStatus: 'succeeded',
        migrationStatus: { status: 'idle', phase: '', processed: 0, total: 0 }
      };
      if (typeof statsHandler === 'function') return statsHandler(stats);
      return { status: 'success', stats };
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

function changeRetentionModule(moduleId) {
  const select = document.querySelector('[data-role="archive-retention-module"]');
  select.value = moduleId;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForRetentionSettled() {
  await waitFor(() => (
    !document.querySelector('[data-role="archive-retention-module"]').disabled
    && !document.querySelector('[data-role="close-update-dialog"]').disabled
  ));
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
  if (!document.querySelector('[data-role="archive-retention-module"]').disabled) {
    failures.push('pending default save did not disable module selection');
  }
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

async function verifyArchiveModuleRetentionBehavior(failures) {
  const bankModule = 'bank-statement-process';
  const vccModule = 'vcc-financial-op';
  const unusedModule = 'bank-bu-recon';
  const retentionSelect = () => document.querySelector('[data-role="archive-retention-days"]');
  const moduleSelect = () => document.querySelector('[data-role="archive-retention-module"]');
  const assertSelection = (moduleId, expected, context) => {
    changeRetentionModule(moduleId);
    if (moduleSelect().value !== moduleId || retentionSelect().value !== expected) {
      failures.push(`${context}: module=${moduleSelect().value}, retention=${retentionSelect().value}, expected=${expected}`);
    }
  };

  const loadingSettings = createDeferred();
  let loadedSettings;
  let settingsReadCount = 0;
  installDesktopApiStub({
    retentionDays: 60,
    retentionDaysByModule: { [bankModule]: 90, [vccModule]: null },
    settingsHandler(settings) {
      settingsReadCount += 1;
      if (settingsReadCount > 1) return { status: 'success', settings };
      loadedSettings = settings;
      return loadingSettings.promise;
    }
  });
  openSettingsDialog();
  document.querySelector('.app-settings-nav-item[data-tab="archive"]').click();
  document.querySelector('[data-action="open-archive-settings"]').click();
  await waitFor(() => loadedSettings !== undefined);
  if (!moduleSelect().disabled || !retentionSelect().disabled) {
    failures.push('loading settings did not disable module and retention selections');
  }
  loadingSettings.resolve({ status: 'success', settings: loadedSettings });
  await waitForRetentionSettled();

  assertSelection('', '60', 'default retention did not load');
  const defaultOptions = [...retentionSelect().options]
    .filter((option) => !option.hidden && !option.disabled)
    .map((option) => option.value);
  if (JSON.stringify(defaultOptions) !== '["30","60","90","180","365","permanent"]') {
    failures.push(`default retention options drifted: ${JSON.stringify(defaultOptions)}`);
  }
  assertSelection(bankModule, '90', 'bank override did not load');
  assertSelection(vccModule, 'permanent', 'module permanent became inherited');
  assertSelection(unusedModule, 'inherit', 'module without batches/override cannot inherit');
  if (window.__retentionSaveCalls.length || window.__moduleRetentionSaveCalls.length) {
    failures.push('switching retention modules unexpectedly saved settings');
  }
  assertSelection(bankModule, '90', 'switching modules lost bank override');
  changeRetention('180');
  await waitForRetentionSettled();
  assertSelection(vccModule, 'permanent', 'partial bank save erased another module override');
  assertSelection('', '60', 'module save changed default retention');
  assertSelection(bankModule, '180', 'module save did not retain selected override');
  changeRetention('permanent');
  await waitForRetentionSettled();
  if (window.__moduleRetentionSaveCalls.at(-1)?.retentionDays !== null) {
    failures.push('module permanent was not sent as null');
  }
  assertSelection(bankModule, 'permanent', 'saved module permanent did not render');
  changeRetention('inherit');
  await waitForRetentionSettled();
  if (window.__moduleRetentionSaveCalls.at(-1)?.retentionDays !== 'inherit') {
    failures.push('module inheritance was not sent as inherit');
  }
  assertSelection('', '60', 'inheritance save changed default retention');
  changeRetention('90');
  await waitForRetentionSettled();
  assertSelection(bankModule, 'inherit', 'default save materialized inherited module override');
  assertSelection(vccModule, 'permanent', 'default save erased explicit permanent override');
  assertSelection(unusedModule, 'inherit', 'default save changed unconfigured module');
  changeRetention('365');
  await waitForRetentionSettled();
  const expectedModuleCalls = [
    { moduleId: bankModule, retentionDays: 180 },
    { moduleId: bankModule, retentionDays: null },
    { moduleId: bankModule, retentionDays: 'inherit' },
    { moduleId: unusedModule, retentionDays: 365 }
  ];
  if (JSON.stringify(window.__moduleRetentionSaveCalls) !== JSON.stringify(expectedModuleCalls)) {
    failures.push(`module saves were misrouted: ${JSON.stringify(window.__moduleRetentionSaveCalls)}`);
  }
  if (JSON.stringify(window.__retentionSaveCalls) !== '[90]') {
    failures.push(`default saves were misrouted: ${JSON.stringify(window.__retentionSaveCalls)}`);
  }
  document.querySelector('[data-role="close-update-dialog"]').click();
  await waitFor(() => document.getElementById('modalRoot').childElementCount === 0);
  openSettingsDialog();
  await openArchiveSettings();
  assertSelection('', '90', 'reopened default retention was not persisted');
  assertSelection(bankModule, 'inherit', 'reopened inheritance was not persisted');
  assertSelection(vccModule, 'permanent', 'reopened permanent override was not persisted');
  assertSelection(unusedModule, '365', 'reopened module override was not persisted');
  assertSelection('', '90', 'switching from reopened module lost default');
  changeRetention('permanent');
  await waitForRetentionSettled();
  if (window.__retentionSaveCalls.at(-1) !== null) failures.push('default permanent was not sent as null');
  openSettingsDialog();
  await openArchiveSettings();
  assertSelection('', 'permanent', 'reopened default permanent was not persisted');
  assertSelection(bankModule, 'inherit', 'default permanent overwrote module inheritance');
  assertSelection(unusedModule, '365', 'default permanent overwrote explicit module days');

  const firstSave = createDeferred();
  let activeSaves = 0;
  let maxActiveSaves = 0;
  installDesktopApiStub({
    retentionDaysByModule: { [bankModule]: 90, [vccModule]: 365 },
    moduleRetentionHandler(payload) {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      const result = payload.retentionDays === 60
        ? firstSave.promise
        : Promise.resolve({ status: 'success', settings: {
            retentionDaysByModule: { [payload.moduleId]: payload.retentionDays }
          } });
      return result.finally(() => { activeSaves -= 1; });
    }
  });
  openSettingsDialog();
  await openArchiveSettings();
  assertSelection(bankModule, '90', 'rapid-change module did not initialize');
  changeRetention('60');
  await waitFor(() => window.__moduleRetentionSaveCalls.length === 1);
  changeRetention('30');
  changeRetention('180');
  if (!moduleSelect().disabled || retentionSelect().disabled) {
    failures.push('pending module save must disable module selection and allow latest retention intent');
  }
  const pendingReturn = document.querySelector('[data-role="close-update-dialog"]');
  const pendingClose = document.querySelector('[data-action="close"]');
  if (!pendingReturn.disabled || !pendingClose.disabled) failures.push('pending module save did not disable Return/X');
  pendingReturn.click();
  pendingClose.click();
  if (document.getElementById('modalRoot').childElementCount !== 1) failures.push('pending module save allowed dialog close');
  if (window.__moduleRetentionSaveCalls.length !== 1) failures.push('rapid module intents wrote concurrently');
  firstSave.resolve({ status: 'failed', message: '旧模块请求失败不应成为最终错误' });
  await waitFor(() => window.__moduleRetentionSaveCalls.length === 2);
  await waitForRetentionSettled();
  if (maxActiveSaves !== 1
      || JSON.stringify(window.__moduleRetentionSaveCalls) !== JSON.stringify([
        { moduleId: bankModule, retentionDays: 60 },
        { moduleId: bankModule, retentionDays: 180 }
      ])) {
    failures.push(`rapid module saves did not serialize/coalesce latest intent: ${JSON.stringify(window.__moduleRetentionSaveCalls)}`);
  }
  if (document.querySelector('[data-role="archive-feedback"]').textContent.includes('旧模块请求失败')) {
    failures.push('stale module failure rendered final error');
  }
  assertSelection(vccModule, '365', 'rapid module save erased unrelated override');
  assertSelection(bankModule, '180', 'latest module intent did not become persisted display');

  const saveAcrossReopen = createDeferred();
  const delayedStats = createDeferred();
  let holdStats = false;
  let heldStats;
  let reopenSettingsReads = 0;
  installDesktopApiStub({
    retentionDaysByModule: { [bankModule]: 90, [vccModule]: 365 },
    moduleRetentionHandler: () => saveAcrossReopen.promise,
    settingsHandler(settings) {
      reopenSettingsReads += 1;
      return { status: 'success', settings };
    },
    statsHandler(stats) {
      if (!holdStats) return { status: 'success', stats };
      heldStats = stats;
      return delayedStats.promise;
    }
  });
  openSettingsDialog();
  await openArchiveSettings();
  assertSelection(bankModule, '90', 'reopen-race module did not initialize');
  changeRetention('180');
  await waitFor(() => window.__moduleRetentionSaveCalls.length === 1);
  holdStats = true;
  document.querySelector('[data-action="back-to-archive"]').click();
  document.querySelector('[data-action="open-archive-settings"]').click();
  await nextFrame();
  if (reopenSettingsReads !== 1) {
    failures.push('reopening settings read stale retention while module save was pending');
  }
  saveAcrossReopen.resolve({ status: 'success', settings: { retentionDaysByModule: { [bankModule]: 180 } } });
  await waitFor(() => heldStats !== undefined);
  delayedStats.resolve({ status: 'success', stats: heldStats });
  await waitForRetentionSettled();
  assertSelection(bankModule, '180', 'slow settings reload overwrote newly saved module retention');
  assertSelection(vccModule, '365', 'slow settings reload erased unrelated module retention');
  holdStats = false;
  document.querySelector('[data-role="close-update-dialog"]').click();
  await waitFor(() => document.getElementById('modalRoot').childElementCount === 0);
  openSettingsDialog();
  await openArchiveSettings();
  assertSelection(bankModule, '180', 'save across settings reopen was not persisted');

  for (const rollback of [
    { saved: { [bankModule]: 180 }, expected: '180' },
    { saved: { [bankModule]: null }, expected: 'permanent' },
    { saved: {}, expected: 'inherit' }
  ]) {
    const failedSave = createDeferred();
    installDesktopApiStub({
      retentionDaysByModule: { ...rollback.saved, [vccModule]: 30 },
      moduleRetentionHandler: () => failedSave.promise
    });
    openSettingsDialog();
    await openArchiveSettings();
    assertSelection(bankModule, rollback.expected, 'rollback module did not initialize');
    changeRetention('90');
    await waitFor(() => window.__moduleRetentionSaveCalls.length === 1);
    failedSave.resolve({ status: 'failed', message: '模块期限保存失败' });
    await waitForRetentionSettled();
    if (!document.querySelector('[data-role="archive-feedback"]').textContent.includes('模块期限保存失败')) {
      failures.push(`module failure feedback missing for ${rollback.expected}`);
    }
    if (retentionSelect().value !== rollback.expected) {
      failures.push(`failed module save did not restore ${rollback.expected}: ${retentionSelect().value}`);
    }
    assertSelection(vccModule, '30', 'failed module save changed unrelated override');
    assertSelection(bankModule, rollback.expected, 'failed module save remained in saved map');
  }
}

async function verifyArchiveRetentionDeleteGuard(failures) {
  const moduleId = 'toolbox';
  const otherModuleId = 'vcc-financial-op';
  const modalRoot = document.getElementById('modalRoot');
  const retentionSelect = () => document.querySelector('[data-role="archive-retention-days"]');
  const feedback = () => document.querySelector('[data-role="archive-feedback"]');
  const deleteButton = () => document.querySelector('[data-action="delete-archive-batch"][data-batch-id="102"]');
  const returnButton = () => document.querySelector('[data-role="close-update-dialog"]');
  const closeButton = () => document.querySelector('[data-action="close"]');
  const openDeletableBatch = async () => {
    document.querySelector('[data-action="back-to-archive"]').click();
    await waitFor(() => document.querySelector('[data-batch-id="102"].archive-center-batch-item'));
    document.querySelector('[data-batch-id="102"].archive-center-batch-item').click();
    await waitFor(() => deleteButton() && !deleteButton().disabled);
  };
  const assertDeleteBlocked = async (settingsOverlay, context, expectedFeedback) => {
    deleteButton().click();
    await nextFrame();
    if (!settingsOverlay.isConnected || modalRoot.firstElementChild !== settingsOverlay
        || document.querySelector('[data-action="confirm"]')) {
      throw new Error(`${context}: delete confirmation detached the pending settings dialog`);
    }
    const message = feedback();
    if (message.hidden || message.getClientRects().length === 0 || !expectedFeedback.test(message.textContent)) {
      failures.push(`${context}: pending delete guard feedback is not visible: ${message.textContent}`);
    }
    if (window.__archiveDeleteCalls.length !== 0) {
      failures.push(`${context}: pending settings triggered delete API`);
    }
  };
  const assertDeleteAvailableAndCancel = async (settingsOverlay, context) => {
    deleteButton().click();
    await waitFor(() => document.querySelector('[data-action="confirm"]'));
    if (settingsOverlay.isConnected) failures.push(`${context}: normal delete confirmation did not replace settings`);
    document.querySelector('[data-action="cancel"]').click();
    await waitFor(() => settingsOverlay.isConnected && modalRoot.firstElementChild === settingsOverlay);
    await nextFrame();
    if (returnButton().disabled || closeButton().disabled) {
      failures.push(`${context}: cancelling delete left Return/X disabled`);
    }
    if (window.__archiveDeleteCalls.length !== 0) failures.push(`${context}: cancelling delete called delete API`);
  };

  const loadingSettings = createDeferred();
  let initialSettings;
  installDesktopApiStub({
    settingsHandler(settings) {
      initialSettings = settings;
      return loadingSettings.promise;
    }
  });
  openSettingsDialog();
  const loadingOverlay = modalRoot.firstElementChild;
  document.querySelector('.app-settings-nav-item[data-tab="archive"]').click();
  document.querySelector('[data-action="open-archive-settings"]').click();
  await waitFor(() => initialSettings !== undefined);
  await openDeletableBatch();
  // 返回列表会取消本次设置加载，尚未返回的旧请求不应继续阻塞删除。
  await assertDeleteAvailableAndCancel(loadingOverlay, 'cancelled settings load');
  loadingSettings.resolve({ status: 'success', settings: initialSettings });
  await nextFrame();
  await waitForRetentionSettled();
  await assertDeleteAvailableAndCancel(loadingOverlay, 'stale settings load completed');

  for (const targetModule of ['', moduleId]) {
    for (const failFinalSave of [false, true]) {
      const context = `${targetModule || 'default'} ${failFinalSave ? 'failed' : 'saved'} final permanent`;
      const firstSave = createDeferred();
      const makeResult = (value) => targetModule
        ? { status: 'success', settings: { retentionDaysByModule: { [targetModule]: value } } }
        : { status: 'success', settings: { retentionDays: value } };
      const handleSave = (value) => {
        if (value === 30) return firstSave.promise;
        return failFinalSave
          ? { status: 'failed', message: '最终永久期限保存失败' }
          : makeResult(value);
      };
      installDesktopApiStub({
        retentionDays: 60,
        retentionDaysByModule: { [moduleId]: 90, [otherModuleId]: 365 },
        retentionHandler: handleSave,
        moduleRetentionHandler: (payload) => handleSave(payload.retentionDays)
      });
      openSettingsDialog();
      const settingsOverlay = modalRoot.firstElementChild;
      await openArchiveSettings();
      changeRetentionModule(targetModule);
      changeRetention('30');
      const saveCalls = () => targetModule ? window.__moduleRetentionSaveCalls : window.__retentionSaveCalls;
      await waitFor(() => saveCalls().length === 1);
      changeRetention('permanent');
      await openDeletableBatch();
      await assertDeleteBlocked(settingsOverlay, context, /保存/);
      if (!returnButton().disabled || !closeButton().disabled || retentionSelect().value !== 'permanent') {
        failures.push(`${context}: blocked delete lost final intent or released Return/X prematurely`);
      }
      if (saveCalls().length !== 1) failures.push(`${context}: final intent saved before first request completed`);
      firstSave.resolve(makeResult(30));
      await waitForRetentionSettled();
      const expectedCalls = targetModule
        ? [{ moduleId: targetModule, retentionDays: 30 }, { moduleId: targetModule, retentionDays: null }]
        : [30, null];
      if (JSON.stringify(saveCalls()) !== JSON.stringify(expectedCalls)) {
        failures.push(`${context}: final intent was lost or misrouted: ${JSON.stringify(saveCalls())}`);
      }
      if ((targetModule ? window.__retentionSaveCalls : window.__moduleRetentionSaveCalls).length !== 0) {
        failures.push(`${context}: retention save crossed API boundaries`);
      }
      if (failFinalSave && !feedback().textContent.includes('最终永久期限保存失败')) {
        failures.push(`${context}: final save failure feedback is missing`);
      }
      const expectedValue = failFinalSave ? 30 : null;
      const saved = (await window.desktopApi.archiveCenter.getSettings()).settings;
      if ((targetModule ? saved.retentionDaysByModule[targetModule] : saved.retentionDays) !== expectedValue
          || saved.retentionDaysByModule[otherModuleId] !== 365
          || (targetModule ? saved.retentionDays !== 60 : saved.retentionDaysByModule[moduleId] !== 90)) {
        failures.push(`${context}: persisted retention or module isolation is wrong: ${JSON.stringify(saved)}`);
      }
      if (retentionSelect().value !== (failFinalSave ? '30' : 'permanent')
          || returnButton().disabled || closeButton().disabled) {
        failures.push(`${context}: final value or Return/X did not settle`);
      }
      await assertDeleteAvailableAndCancel(settingsOverlay, context);
      await openArchiveSettings();
      if (retentionSelect().value !== (failFinalSave ? '30' : 'permanent')) {
        failures.push(`${context}: reopening settings lost persisted final value`);
      }
      changeRetentionModule(otherModuleId);
      if (retentionSelect().value !== '365') failures.push(`${context}: unrelated module display changed`);
      returnButton().click();
      await waitFor(() => modalRoot.childElementCount === 0);
      openSettingsDialog();
      await openArchiveSettings();
      changeRetentionModule(targetModule);
      if (retentionSelect().value !== (failFinalSave ? '30' : 'permanent')) {
        failures.push(`${context}: reopened dialog did not use persisted final value`);
      }
      closeButton().click();
      await waitFor(() => modalRoot.childElementCount === 0);
    }
  }
  openSettingsDialog();
  await openArchiveSettings();
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
  const retentionControls = settingsView.querySelectorAll(
    '[data-role="archive-retention-module"], [data-role="archive-retention-days"]'
  );
  if (retentionControls.length !== 2) failures.push(`retention controls missing: ${retentionControls.length}`);
  const settingsRectBounds = settingsView.getBoundingClientRect();
  const paneBounds = document.querySelector('[data-pane="archive"]').getBoundingClientRect();
  for (const control of retentionControls) {
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible' || style.display === 'none'
        || rect.left < settingsRectBounds.left - 1 || rect.right > settingsRectBounds.right + 1
        || rect.top < paneBounds.top - 1 || rect.bottom > paneBounds.bottom + 1) {
      failures.push(`retention control is clipped or hidden: ${control.dataset.role}`);
    }
  }
  if (settingsView.scrollWidth > settingsView.clientWidth + 1) failures.push('retention settings horizontal overflow');
  if (!/仅影响[^；。]*(新建|新增|新创建|新)[^；。]*批次/.test(settingsView.textContent)) {
    failures.push('retention settings do not explain that changes affect new batches');
  }
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

async function measurePage(expectedScaleFactor, runBehavior, prepareScreenshot) {
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
    '锁定批次不参与自动清理。默认保留期为 90 天。'
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
    await verifyArchiveModuleRetentionBehavior(failures);
    await verifyArchiveRetentionDeleteGuard(failures);
  }

  if (prepareScreenshot) {
    installDesktopApiStub({ retentionDaysByModule: { 'vcc-financial-op': null } });
    openSettingsDialog();
    await openArchiveSettings();
    changeRetentionModule('vcc-financial-op');
    await nextFrame();
  }

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      rightEdgeDelta,
      toggleFontSize,
      devicePixelRatio: window.devicePixelRatio,
      retentionControlCount: document.querySelectorAll(
        '[data-role="archive-retention-module"], [data-role="archive-retention-days"]'
      ).length
    }
  };
}

async function runElectronChild() {
  const { app, BrowserWindow } = require('electron');
  const width = Number(process.env.APP_SETTINGS_LAYOUT_WIDTH);
  const height = Number(process.env.APP_SETTINGS_LAYOUT_HEIGHT);
  const scaleFactor = Number(process.env.APP_SETTINGS_LAYOUT_SCALE);
  const runBehavior = process.env.APP_SETTINGS_LAYOUT_RUN_BEHAVIOR === '1';
  const screenshotPath = runBehavior ? process.env.APP_SETTINGS_LAYOUT_SCREENSHOT : '';

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
        ${changeRetentionModule.toString()}
        ${waitForRetentionSettled.toString()}
        ${verifyArchiveRetentionBehavior.toString()}
        ${verifyArchiveModuleRetentionBehavior.toString()}
        ${verifyArchiveRetentionDeleteGuard.toString()}
        ${verifyArchiveBrowserLayout.toString()}
        return (${measurePage.toString()})(${JSON.stringify(scaleFactor)}, ${JSON.stringify(runBehavior)}, ${JSON.stringify(Boolean(screenshotPath))});
      })()
    `);
    if (screenshotPath && result.ok) {
      const screenshot = await window.webContents.capturePage();
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, screenshot.toPNG());
      result.screenshotPath = screenshotPath;
    }
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
