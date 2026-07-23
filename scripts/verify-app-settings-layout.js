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

function installDesktopApiStub({ failRetention = false, retentionDays = 60 } = {}) {
  window.__retentionSaveCalls = [];
  const archiveCenter = {
    async listBatches() { return { status: 'success', batches: [] }; },
    async getBatch() { return { status: 'failed', message: '未找到批次' }; },
    async openFile() { return { status: 'success' }; },
    async saveAs() { return { status: 'cancelled' }; },
    async setLocked() { return { status: 'success' }; },
    async deleteBatch() { return { status: 'success', metadataDeleted: true }; },
    async retryBatch() { return { status: 'success' }; },
    async getSettings() {
      return { status: 'success', settings: { retentionDays } };
    },
    async setRetentionDays(value) {
      window.__retentionSaveCalls.push(value);
      return failRetention
        ? { status: 'failed', message: '模拟保存失败' }
        : { status: 'success', settings: { retentionDays: value } };
    },
    async getStats() {
      return {
        status: 'success',
        stats: {
          batchCount: 0,
          logicalFileCount: 0,
          uniqueBytes: 0,
          logicalBytes: 0,
          storagePath: '/tmp/archive-center'
        }
      };
    }
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

async function verifyArchiveConfirmBehavior(failures) {
  installDesktopApiStub({ retentionDays: null });
  let modalRoot = openSettingsDialog();
  await openArchiveSettings();
  const permanentSelect = document.querySelector('[data-role="archive-retention-days"]');
  if (permanentSelect.value !== 'permanent') {
    failures.push(`permanent retention rendered as ${permanentSelect.value}`);
  }
  permanentSelect.value = '60';
  document.querySelector('[data-role="close-update-dialog"]').click();
  await waitFor(() => modalRoot.childElementCount === 0);
  if (JSON.stringify(window.__retentionSaveCalls) !== '[60]') {
    failures.push(`permanent to 60 calls: ${JSON.stringify(window.__retentionSaveCalls)}`);
  }

  installDesktopApiStub();
  modalRoot = openSettingsDialog();
  await openArchiveSettings();
  document.querySelector('[data-role="archive-retention-days"]').value = '180';
  const successConfirmButton = document.querySelector('[data-role="close-update-dialog"]');
  successConfirmButton.click();
  successConfirmButton.click();
  await waitFor(() => modalRoot.childElementCount === 0);
  if (JSON.stringify(window.__retentionSaveCalls) !== '[180]') {
    failures.push(`save success calls: ${JSON.stringify(window.__retentionSaveCalls)}`);
  }

  installDesktopApiStub({ failRetention: true });
  modalRoot = openSettingsDialog();
  await openArchiveSettings();
  document.querySelector('[data-role="archive-retention-days"]').value = '365';
  const confirmButton = document.querySelector('[data-role="close-update-dialog"]');
  confirmButton.click();
  await waitFor(() => document.querySelector('[data-role="archive-feedback"]').textContent.includes('模拟保存失败'));
  if (modalRoot.childElementCount !== 1) failures.push('save failure closed dialog');
  if (confirmButton.disabled) failures.push('save failure left confirm disabled');
  if (JSON.stringify(window.__retentionSaveCalls) !== '[365]') {
    failures.push(`save failure calls: ${JSON.stringify(window.__retentionSaveCalls)}`);
  }

  installDesktopApiStub();
  modalRoot = openSettingsDialog();
  await openArchiveSettings();
  document.querySelector('[data-role="close-update-dialog"]').click();
  await waitFor(() => modalRoot.childElementCount === 0);
  if (window.__retentionSaveCalls.length !== 0) failures.push('no-change confirm called save API');

  installDesktopApiStub();
  modalRoot = openSettingsDialog();
  await openArchiveSettings();
  document.querySelector('[data-role="archive-retention-days"]').value = '30';
  document.querySelector('[data-action="back-to-archive"]').click();
  if (window.__retentionSaveCalls.length !== 0) failures.push('back action saved draft');
  if (document.querySelector('[data-role="archive-retention-days"]').value !== '60') {
    failures.push('back action did not discard retention draft');
  }
  document.querySelector('[data-action="open-archive-settings"]').click();
  if (!document.querySelector('[data-role="close-update-dialog"]').disabled) {
    failures.push('confirm remained enabled while archive settings reloaded');
  }
  await waitFor(() => !document.querySelector('[data-archive-view="settings"]').hasAttribute('aria-busy'));
  if (document.querySelector('[data-role="archive-retention-days"]').value !== '60') {
    failures.push('reopened archive settings did not restore saved retention');
  }
  document.querySelector('[data-role="archive-retention-days"]').value = '180';
  document.querySelector('[data-action="close"]').click();
  await waitFor(() => modalRoot.childElementCount === 0);
  if (window.__retentionSaveCalls.length !== 0) failures.push('close action saved draft');
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
  if (confirmButton.textContent.trim() !== '确认') failures.push(`unexpected confirm text ${confirmButton.textContent}`);
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
    if (confirmButton.textContent.trim() !== '稍后') {
      failures.push(`downloaded update button text ${confirmButton.textContent}`);
    }
    document.querySelector('.app-settings-nav-item[data-tab="archive"]').click();
    if (confirmButton.textContent.trim() !== '确认') {
      failures.push(`archive tab button text ${confirmButton.textContent}`);
    }
    await verifyArchiveConfirmBehavior(failures);
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
        ${installDesktopApiStub.toString()}
        ${openSettingsDialog.toString()}
        ${openArchiveSettings.toString()}
        ${verifyArchiveConfirmBehavior.toString()}
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
