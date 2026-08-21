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
const RESULT_PREFIX = 'MAIN_PANEL_ALIGNMENT_RESULT=';

function runParent() {
  const electronBinary = require('electron');
  const projectRoot = path.resolve(__dirname, '..');
  const failures = [];

  for (const viewport of VIEWPORTS) {
    for (const scaleFactor of SCALE_FACTORS) {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-panel-alignment-'));
      const child = spawnSync(electronBinary, [__filename], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          MAIN_PANEL_ALIGNMENT_CHILD: '1',
          MAIN_PANEL_ALIGNMENT_WIDTH: String(viewport.width),
          MAIN_PANEL_ALIGNMENT_HEIGHT: String(viewport.height),
          MAIN_PANEL_ALIGNMENT_SCALE: String(scaleFactor),
          MAIN_PANEL_ALIGNMENT_USER_DATA: userDataDir,
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
      const outcome = result.ok ? 'PASS' : 'FAIL';
      console.log(
        `[main-panel-alignment] ${viewport.width}x${viewport.height} @ ${scaleFactor * 100}% ` +
        `${outcome} (single-text=${result.metrics.maxSingleTextDelta.toFixed(4)}px, ` +
        `multi-text=${result.metrics.maxMultiTextDelta.toFixed(4)}px, ` +
        `control=${result.metrics.maxControlDelta.toFixed(4)}px, ` +
        `vcc-width=${result.metrics.vccButtonWidthDelta.toFixed(4)}px, ` +
        `vcc-symmetry=${result.metrics.vccButtonSymmetryDelta.toFixed(4)}px, ` +
        `dpr=${result.metrics.devicePixelRatio})`
      );
      if (!result.ok) failures.push({ viewport, scaleFactor, details: result.failures });
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log('[main-panel-alignment] 6/6 PASS');
}

function measurePage(expectedScaleFactor) {
  const statusTargets = [
    ['statementModulePanel', 'statusBox'],
    ['pendingModulePanel', 'pendingStatusBox'],
    ['bizOpReconModulePanel', 'bizOpReconStatusBox'],
    ['bankBuReconModulePanel', 'bankBuReconStatusBox'],
    ['duplicateInboundMatchModulePanel', 'duplicateInboundMatchStatusBox'],
    ['vccOpCalcModulePanel', 'vccOpCalcStatusBox'],
    ['vccFinancialOpModulePanel', 'vccFinancialOpStatusBox'],
    ['bankStatementModulePanel', 'bankStatementStatusBox'],
    ['preFundReconciliationModulePanel', 'preFundReconciliationStatusBox'],
    ['reconIdFixModulePanel', 'reconIdFixStatusBox'],
    ['positionReconciliationModulePanel', 'positionReconciliationStatusBox'],
    ['acquiringBillCurrencyModulePanel', 'acquiringBillCurrencyStatusBox']
  ];
  const controlIds = [
    'templateSelect',
    'bizOpReconBuSelect',
    'preFundReconciliationScenarioSelect',
    'reconIdFixBillCategorySelect',
    'reconIdFixScenarioSelect',
    'positionReconciliationFunctionSelect'
  ];
  const failures = [];
  const welcomeStatusIds = new Set([
    'duplicateInboundMatchStatusBox',
    'vccFinancialOpStatusBox',
    'reconIdFixStatusBox',
    'positionReconciliationStatusBox'
  ]);
  const metrics = {
    devicePixelRatio: window.devicePixelRatio,
    maxSingleTextDelta: 0,
    maxMultiTextDelta: 0,
    maxControlDelta: 0,
    vccButtonWidthDelta: 0,
    vccButtonSymmetryDelta: 0,
    bankStatusClientHeight: 0,
    bankStatusScrollHeight: 0,
    bankStatusBottomScrollTop: 0
  };
  const tolerance = 1;

  document.body.dataset.platform = 'win32';
  if (Math.abs(window.devicePixelRatio - expectedScaleFactor) > 0.01) {
    failures.push(`device scale factor: expected ${expectedScaleFactor}, got ${window.devicePixelRatio}`);
  }
  const panels = Array.from(document.querySelectorAll('.module-panel'));
  const showPanel = (panelId) => {
    panels.forEach((panel) => { panel.hidden = panel.id !== panelId; });
  };
  const centerY = (rect) => rect.top + (rect.height / 2);
  const centerX = (rect) => rect.left + (rect.width / 2);
  const inside = (inner, outer) => (
    inner.top >= outer.top - tolerance &&
    inner.bottom <= outer.bottom + tolerance &&
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance
  );

  for (const [panelId, statusId] of statusTargets) {
    showPanel(panelId);
    const box = document.getElementById(statusId);
    const content = box && box.querySelector('.status-box-content');
    const text = box && box.querySelector('.status-box-text');
    if (!box || !content || !text) {
      failures.push(`${statusId}: missing status structure`);
      continue;
    }
    if (box.querySelector('svg')) failures.push(`${statusId}: unexpected status SVG`);
    const initialText = text.textContent.trim();
    if (!initialText) failures.push(`${statusId}: empty initial status text`);
    if (welcomeStatusIds.has(statusId) && initialText !== '欢迎使用小助手') {
      failures.push(`${statusId}: unexpected initial text ${initialText}`);
    }

    text.textContent = 'Alignment status';
    let textRect = text.getBoundingClientRect();
    let boxRect = box.getBoundingClientRect();
    let contentRect = content.getBoundingClientRect();
    const singleTextDelta = Math.abs(centerY(contentRect) - centerY(textRect));
    metrics.maxSingleTextDelta = Math.max(metrics.maxSingleTextDelta, singleTextDelta);
    if (singleTextDelta > tolerance) failures.push(`${statusId}: single-line text delta ${singleTextDelta}`);
    if (!inside(contentRect, boxRect)) failures.push(`${statusId}: single-line content overflow`);

    text.textContent = 'First line\nSecond line\nThird line';
    textRect = text.getBoundingClientRect();
    boxRect = box.getBoundingClientRect();
    contentRect = content.getBoundingClientRect();
    const multiTextDelta = Math.abs(centerY(contentRect) - centerY(textRect));
    metrics.maxMultiTextDelta = Math.max(metrics.maxMultiTextDelta, multiTextDelta);
    if (multiTextDelta > tolerance) failures.push(`${statusId}: multi-line text delta ${multiTextDelta}`);
    if (!inside(contentRect, boxRect)) failures.push(`${statusId}: multi-line content overflow`);
  }

  for (const controlId of controlIds) {
    const select = document.getElementById(controlId);
    const label = document.querySelector(`label[for="${controlId}"]`);
    const panel = select && select.closest('.module-panel');
    if (!select || !label || !panel) {
      failures.push(`${controlId}: missing label/select pair`);
      continue;
    }
    showPanel(panel.id);
    const selectRect = select.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const deltas = [
      Math.abs(labelRect.top - selectRect.top),
      Math.abs(labelRect.height - selectRect.height),
      Math.abs(centerY(labelRect) - centerY(selectRect))
    ];
    const controlDelta = Math.max(...deltas);
    metrics.maxControlDelta = Math.max(metrics.maxControlDelta, controlDelta);
    if (controlDelta > tolerance) failures.push(`${controlId}: control delta ${controlDelta}`);
  }

  showPanel('vccFinancialOpModulePanel');
  const vccImportButton = document.getElementById('vccFinancialOpImportBtn');
  const vccRunButton = document.getElementById('vccFinancialOpRunBtn');
  const vccStatusBox = document.getElementById('vccFinancialOpStatusBox');
  if (!vccImportButton || !vccRunButton || !vccStatusBox) {
    failures.push('vcc financial op: missing symmetry controls');
  } else {
    const importRect = vccImportButton.getBoundingClientRect();
    const runRect = vccRunButton.getBoundingClientRect();
    const statusRect = vccStatusBox.getBoundingClientRect();
    const statusCenter = centerX(statusRect);
    const importDistance = statusCenter - centerX(importRect);
    const runDistance = centerX(runRect) - statusCenter;
    metrics.vccButtonWidthDelta = Math.abs(importRect.width - runRect.width);
    metrics.vccButtonSymmetryDelta = Math.abs(importDistance - runDistance);
    if (metrics.vccButtonWidthDelta > tolerance) {
      failures.push(`vcc financial op: button width delta ${metrics.vccButtonWidthDelta}`);
    }
    if (Math.abs(importRect.width - 140) > tolerance) {
      failures.push(`vcc financial op: import width ${importRect.width}`);
    }
    if (importDistance <= 0 || runDistance <= 0 || metrics.vccButtonSymmetryDelta > tolerance) {
      failures.push(`vcc financial op: status symmetry delta ${metrics.vccButtonSymmetryDelta}`);
    }
  }

  showPanel('positionReconciliationModulePanel');
  const positionPanel = document.getElementById('positionReconciliationModulePanel');
  const positionControlIds = [
    'positionReconciliationFunctionSelect',
    'positionReconciliationRunBtn',
    'positionReconciliationTableManagerBtn',
    'positionReconciliationLinkedTableManagerBtn',
    'positionReconciliationConfigBtn',
    'positionReconciliationExportBtn',
    'positionReconciliationStatusBox'
  ];
  const positionRects = positionControlIds.map((id) => {
    const element = document.getElementById(id);
    if (!element) {
      failures.push(`${id}: missing position reconciliation control`);
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (!inside(rect, positionPanel.getBoundingClientRect())) {
      failures.push(`${id}: outside position reconciliation panel`);
    }
    return { id, rect };
  }).filter(Boolean);
  for (let leftIndex = 0; leftIndex < positionRects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < positionRects.length; rightIndex += 1) {
      const left = positionRects[leftIndex];
      const right = positionRects[rightIndex];
      const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
      const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
      if (overlapWidth > tolerance && overlapHeight > tolerance) {
        failures.push(`${left.id}/${right.id}: controls overlap`);
      }
    }
  }

  showPanel('bankStatementModulePanel');
  const bankBox = document.getElementById('bankStatementStatusBox');
  const bankText = bankBox.querySelector('.status-box-text');
  bankText.textContent = Array.from(
    { length: 24 },
    (_, index) => `Channel ${index + 1}: scenario one, scenario two`
  ).join('\n');
  bankBox.scrollTop = 0;
  const bankCellHeight = bankBox.parentElement.getBoundingClientRect().height;
  const bankBoxHeight = bankBox.getBoundingClientRect().height;
  metrics.bankStatusClientHeight = bankBox.clientHeight;
  metrics.bankStatusScrollHeight = bankBox.scrollHeight;
  if (bankBox.scrollHeight <= bankBox.clientHeight) failures.push('bank status: long text is not scrollable');
  if (Math.abs(bankCellHeight - bankBoxHeight) > tolerance) failures.push('bank status: box no longer fills fixed grid cell');
  if (Math.abs(bankCellHeight - 176) > tolerance) failures.push(`bank status: grid cell height ${bankCellHeight}`);
  bankBox.scrollTop = bankBox.scrollHeight;
  metrics.bankStatusBottomScrollTop = bankBox.scrollTop;
  if (bankBox.scrollTop <= 0) failures.push('bank status: bottom is unreachable');
  if (bankBox.scrollTop + bankBox.clientHeight < bankBox.scrollHeight - tolerance) {
    failures.push('bank status: incomplete bottom scroll');
  }

  const newAccountStatus = document.getElementById('newAccountStatusBox');
  if (!newAccountStatus || newAccountStatus.querySelector('.status-box-content')) {
    failures.push('new account status: excluded structure changed');
  }
  if (newAccountStatus && newAccountStatus.querySelector('svg')) {
    failures.push('new account status: unexpected status SVG');
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + tolerance) {
    failures.push('document: horizontal overflow');
  }

  return { ok: failures.length === 0, failures, metrics };
}

async function runElectronChild() {
  const { app, BrowserWindow } = require('electron');
  const width = Number(process.env.MAIN_PANEL_ALIGNMENT_WIDTH);
  const height = Number(process.env.MAIN_PANEL_ALIGNMENT_HEIGHT);
  const scaleFactor = Number(process.env.MAIN_PANEL_ALIGNMENT_SCALE);

  app.commandLine.appendSwitch('force-device-scale-factor', String(scaleFactor));
  app.disableHardwareAcceleration();
  if (process.env.MAIN_PANEL_ALIGNMENT_USER_DATA) {
    app.setPath('userData', process.env.MAIN_PANEL_ALIGNMENT_USER_DATA);
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
    const result = await window.webContents.executeJavaScript(
      `(${measurePage.toString()})(${JSON.stringify(scaleFactor)})`
    );
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    app.quit();
  }
}

if (process.versions.electron && process.env.MAIN_PANEL_ALIGNMENT_CHILD === '1') {
  runElectronChild().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    const { app } = require('electron');
    app.exit(1);
  });
} else {
  runParent();
}
