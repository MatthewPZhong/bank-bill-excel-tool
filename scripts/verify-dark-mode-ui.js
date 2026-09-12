'use strict';

// 真实 index / Renderer / CSS 的隐藏窗口界面检查；业务 desktopApi 为显式内存模拟。
// 每组尺寸是 CSS viewport，设备缩放和网页 zoom 分开记录；不宣称物理显示器或 Main 启动验收。
// node scripts/verify-dark-mode-ui.js；可用 DARK_MODE_UI_FILTER=2560x1440@1 复现单组。
// DARK_MODE_UI_WEB_ZOOM=1.25（或 1.5）固定窗口尺寸和 DPR=1，额外验证真实页面缩放。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'changes/v3.2.9/codex/v3.2.9-night-mode/evidence');
const PREFIX = 'DARK_MODE_UI_RESULT=';
const VIEWPORTS = [[1080, 760], [1240, 860], [2560, 1440]];
const SCALES = [1, 1.25, 1.5];

function installStub() {
  window.__darkModeGui = {
    revision: 0, saveCalls: [], backgroundWrites: [], subscribers: new Set(), failNextSave: false,
    current: { enabled: false, startTime: '18:30', endTime: '06:00' },
    publish(config = this.current) {
      this.current = { ...config };
      const snapshot = {
        darkModeSchedule: { ...config },
        effectiveTheme: window.DarkModeSchedule.resolveEffectiveTheme(config, new Date(2026, 8, 12, 21, 0)),
        themeRevision: ++this.revision
      };
      this.subscribers.forEach((listener) => listener(snapshot));
      return snapshot;
    },
    theme(value) { return this.publish({ ...this.current, enabled: value === 'dark' }); }
  };
  const status = async () => ({ status: 'ok', fileCount: 0, rowCount: 0, canRun: false, canExport: false });
  window.desktopApi = {
    settings: {
      onDarkModeScheduleChanged(listener) {
        window.__darkModeGui.subscribers.add(listener);
        return () => window.__darkModeGui.subscribers.delete(listener);
      },
      async setDarkModeSchedule(config) {
        window.__darkModeGui.saveCalls.push({ ...config });
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (window.__darkModeGui.failNextSave) {
          window.__darkModeGui.failNextSave = false;
          return { status: 'failed', message: '模拟数据库写入失败' };
        }
        return { status: 'ok', ...window.__darkModeGui.publish(config) };
      },
      async setCurrentModule() { return { status: 'ok' }; }
    },
    app: { reportLog() {}, reportUserActivity() {} },
    background: {
      async save(value) { window.__darkModeGui.backgroundWrites.push(value); return { status: 'cancelled' }; },
      async reset() { window.__darkModeGui.backgroundWrites.push('reset'); return { status: 'cancelled' }; }
    },
    bankStatement: { sessionStatus: status },
    preFundReconciliation: { sessionStatus: status },
    reconIdFix: { sessionStatus: status },
    positionReconciliation: { sessionStatus: status },
    scenarios: { async list() { return { status: 'ok', scenarios: [] }; } },
    bizOpReconV327: { async status() { return { mode: 'ACTIVE', recoveryReady: true }; } },
    appUpdate: { async setEnabled() { return { status: 'success' }; } }
  };
  window.__uiErrors = [];
  addEventListener('error', (event) => window.__uiErrors.push(event.message));
  addEventListener('unhandledrejection', (event) => window.__uiErrors.push(String(event.reason)));
}

async function inspectPage(theme, runBehavior) {
  const failures = [];
  let assertions = 0;
  const check = (condition, label, detail) => {
    assertions += 1;
    if (!condition) failures.push({ label, detail });
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  function resolvedColor(variable) {
    const element = document.createElement('span');
    element.style.color = `var(${variable})`;
    document.body.appendChild(element);
    const value = getComputedStyle(element).color;
    element.remove();
    return value;
  }
  function luminance(color) {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => Number(value) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  function contrast(foreground, background) {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  applyUiStyle();
  state.backgroundSettings = cloneBackgroundSettings({ colorHex: '#f9fafc' });
  state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
  const controller = getDarkModeController();
  window.__darkModeGui.theme(theme);
  applyBackgroundSettings(state.backgroundSettings);
  check(document.documentElement.dataset.theme === theme, '真实主题控制器应用主题', theme);
  check(Boolean(window.DarkModeSchedule && window.DarkModeUI), '共享契约及首屏主题脚本均已加载');

  const modules = [];
  for (const module of Object.values(MODULES)) {
    setCurrentModule(module.id, { persist: false });
    await frame();
    const visiblePanels = [...document.querySelectorAll('section[id$="ModulePanel"]')]
      .filter((panel) => !panel.hidden && getComputedStyle(panel).display !== 'none');
    const panels = visiblePanels.map((panel) => ({ id: panel.id, ...rect(panel), scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth }));
    check(visiblePanels.length === 1, `模块 ${module.id} 显示一个主面板`, panels);
    for (const panel of panels) {
      check(panel.width > 0 && panel.x >= -1 && panel.right <= innerWidth + 1, `模块 ${module.id} 水平边界`, panel);
      check(panel.scrollWidth <= panel.clientWidth + 2, `模块 ${module.id} 面板无水平溢出`, panel);
    }
    const labels = visiblePanels.flatMap((panel) => [...panel.querySelectorAll('button,select,label')])
      .filter((node) => node.getClientRects().length > 0);
    const minFont = labels.length ? Math.min(...labels.map((node) => parseFloat(getComputedStyle(node).fontSize))) : null;
    if (minFont !== null) check(minFont >= 11, `模块 ${module.id} 基础控件字体`, { minFont });
    modules.push({ id: module.id, panels, minControlFontPx: minFont });
  }
  setCurrentModule(MODULES.statementGenerator.id, { persist: false });
  setStatus('欢迎使用小助手', 'info');
  closeModal();
  openModal(createAppUpdateSettingsDialog());
  const overlay = document.querySelector('#modalRoot .modal-overlay');
  overlay.querySelector('[data-tab="appearance"]').click();
  await frame();
  const card = overlay.querySelector('.app-update-settings-card');
  const pane = overlay.querySelector('[data-pane="appearance"]');
  const enabled = pane.querySelector('[data-role="dark-mode-enabled"]');
  const start = pane.querySelector('[data-role="dark-mode-start"]');
  const end = pane.querySelector('[data-role="dark-mode-end"]');
  const feedback = pane.querySelector('[data-role="dark-mode-feedback"]');
  const current = pane.querySelector('[data-role="dark-mode-status"]');
  const fields = pane.querySelector('fieldset');
  const cardRect = rect(card);
  const startRect = rect(start);
  const endRect = rect(end);
  check(!pane.hidden && !fields.disabled, '真实设置外观页已加载且可以编辑');
  check(cardRect.x >= -1 && cardRect.y >= -1 && cardRect.right <= innerWidth + 1 && cardRect.bottom <= innerHeight + 1,
    '设置弹窗在 viewport 内', cardRect);
  check(startRect.right < endRect.x && startRect.width >= 100 && endRect.width >= 100,
    '时间控件有足够宽度且不重叠', { startRect, endRect });
  check(pane.scrollWidth <= pane.clientWidth + 1, '外观设置无水平滚动', { scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth });
  check(document.documentElement.scrollWidth <= innerWidth + 1, '页面无水平滚动', document.documentElement.scrollWidth);
  const palette = {};
  for (const variable of ['--bg', '--bg-soft', '--panel', '--text', '--muted', '--input', '--primary', '--on-primary', '--danger', '--danger-soft', '--success', '--success-soft', '--warning', '--warning-soft']) {
    palette[variable] = resolvedColor(variable);
  }
  const contrastPairs = [['--text', '--panel'], ['--muted', '--panel'], ['--text', '--input'], ['--on-primary', '--primary'], ['--danger', '--danger-soft'], ['--success', '--success-soft'], ['--warning', '--warning-soft']]
    .map(([foreground, background]) => ({ foreground, background, ratio: contrast(palette[foreground], palette[background]) }));
  for (const pair of contrastPairs) check(pair.ratio >= 4.5, '组件文字对比度至少 4.5:1', pair);

  const paletteButtonStyle = getComputedStyle(document.getElementById('backgroundDoneBtn'));
  const paletteAction = { color: paletteButtonStyle.color, background: paletteButtonStyle.backgroundColor };
  paletteAction.contrast = contrast(paletteAction.color, paletteAction.background);
  check(paletteAction.color === palette['--on-primary'] && paletteAction.background === palette['--primary'],
    '实际背景完成按钮使用 primary / on-primary', paletteAction);
  check(paletteAction.contrast >= 4.5, '实际背景完成按钮文字对比度至少 4.5:1', paletteAction);
  start.focus({ preventScroll: true });
  await frame();
  const focusStyle = getComputedStyle(start);
  const timeInputFocus = {
    active: document.activeElement === start,
    focusVisible: start.matches(':focus-visible'),
    outlineStyle: focusStyle.outlineStyle,
    outlineWidth: focusStyle.outlineWidth,
    outlineColor: focusStyle.outlineColor
  };
  check(timeInputFocus.active && timeInputFocus.outlineStyle !== 'none' && parseFloat(timeInputFocus.outlineWidth) > 0,
    '真实时间输入 DOM.focus 后有可见焦点轮廓', timeInputFocus);
  check(timeInputFocus.outlineColor === palette['--primary'], '时间输入焦点轮廓使用 primary', timeInputFocus);
  start.blur();

  const fixture = document.createElement('div');
  fixture.style.cssText = 'position:fixed;left:0;top:0;width:1080px;visibility:hidden';
  fixture.innerHTML = '<div class="status-box" data-tone="error">错误</div><div class="status-box" data-tone="success">成功</div><div class="status-box" data-tone="warning">警告</div><table class="data-table"><thead><tr><th>账户</th></tr></thead><tbody><tr><td>示例账户</td></tr></tbody></table><div class="vcc-fin-op-dialog"><table class="vcc-fin-op-table vcc-fin-op-balance-table"><thead><tr><th>币种</th></tr></thead><tbody><tr><td class="is-difference">-10.00</td></tr></tbody></table></div>';
  document.body.appendChild(fixture);
  const probes = [
    ['status-error', '[data-tone="error"]', theme === 'dark' ? '--danger' : null, theme === 'dark' ? '--danger-soft' : null],
    ['status-success', '[data-tone="success"]', theme === 'dark' ? '--success' : null, theme === 'dark' ? '--success-soft' : null],
    ['status-warning', '[data-tone="warning"]', theme === 'dark' ? '--warning' : null, theme === 'dark' ? '--warning-soft' : null],
    ['account-table', '.data-table th', '--muted', null],
    ['vcc-panel', '.vcc-fin-op-dialog', '--text', '--panel'],
    ['vcc-header', '.vcc-fin-op-table th', '--text', '--bg-soft'],
    ['vcc-difference', '.is-difference', '--danger', '--danger-soft']
  ].map(([name, selector, colorToken, backgroundToken]) => {
    const computed = getComputedStyle(fixture.querySelector(selector));
    const value = { name, color: computed.color, background: computed.backgroundColor };
    if (colorToken) check(value.color === palette[colorToken], `${name} 文字采用语义色`, { ...value, expected: palette[colorToken] });
    if (backgroundToken) check(value.background === palette[backgroundToken], `${name} 背景采用语义色`, { ...value, expected: palette[backgroundToken] });
    return value;
  });
  fixture.remove();

  const behavior = [];
  if (runBehavior) {
    const change = (input, value) => {
      if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.__darkModeGui.theme('light');
    change(enabled, true);
    check(fields.disabled, '保存中禁用外观选项');
    await delay(45);
    check(document.documentElement.dataset.theme === 'dark' && /深色/.test(current.textContent), '启用定时模式立即按模拟本机 21:00 转深色');
    behavior.push('开关真实 DOM change → controller → 模拟 IPC → 主题/状态');
    const beforeFailed = JSON.stringify(controller.getSnapshot().darkModeSchedule);
    window.__darkModeGui.failNextSave = true;
    change(enabled, false);
    await delay(45);
    check(!feedback.hidden && /写入失败/.test(feedback.textContent), '保存失败显示原因');
    check(document.documentElement.dataset.theme === 'dark' && enabled.checked && JSON.stringify(controller.getSnapshot().darkModeSchedule) === beforeFailed,
      '保存失败保留原主题与开关状态');
    const savesBeforeInvalid = window.__darkModeGui.saveCalls.length;
    change(end, start.value);
    await frame();
    check(!feedback.hidden && /不能相同/.test(feedback.textContent) && window.__darkModeGui.saveCalls.length === savesBeforeInvalid,
      '相同起止时间在提交前拒绝');
    change(end, '07:45');
    await delay(45);
    change(enabled, false);
    await delay(45);
    check(document.documentElement.dataset.theme === 'light' && end.value === '07:45', '禁用立即恢复浅色并保留自定义时间');
    behavior.push('失败保留 / 等时拒绝 / 时段保存与禁用保留');
    const imageDataUrl = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#ddf4f0"/></svg>');
    const savedBackground = cloneBackgroundSettings({ colorHex: '#bbccdd', imageDataUrl, filePath: '/isolated/example.png', sourceFileName: 'example.png' });
    state.backgroundSettings = savedBackground;
    openBackgroundPalette();
    state.backgroundDraft.colorHex = '#efd5c2';
    state.backgroundDraft.sourcePath = '/isolated/draft.png';
    const draftBefore = JSON.stringify(state.backgroundDraft);
    applyBackgroundSettings(state.backgroundDraft);
    window.__darkModeGui.theme('dark');
    check(JSON.stringify(state.backgroundDraft) === draftBefore && elements.appShell.style.backgroundImage.includes('0.72'), '转深色保留当前背景草稿并添加遮罩');
    check(elements.appShell.style.backgroundSize.endsWith('cover') && elements.appShell.style.backgroundRepeat.split(',').every((value) => value.trim() === 'no-repeat'), '图片裁切与重复方式保持');
    window.__darkModeGui.theme('light');
    check(JSON.stringify(state.backgroundDraft) === draftBefore && !elements.appShell.style.backgroundImage.includes('0.72), rgba(11'), '转浅色移除遮罩且不丢草稿');
    closeBackgroundPalette();
    check(JSON.stringify(state.backgroundSettings) === JSON.stringify(savedBackground) && state.backgroundDraft.colorHex === savedBackground.colorHex && window.__darkModeGui.backgroundWrites.length === 0,
      '取消背景恢复已保存配置，主题操作不保存或重置背景');
    behavior.push('图片背景草稿 / 日夜遮罩 / 取消 / 无背景写入');
    window.__darkModeGui.publish({ enabled: theme === 'dark', startTime: '18:30', endTime: '06:00' });
    state.backgroundSettings = cloneBackgroundSettings({ colorHex: '#f9fafc' });
    applyBackgroundSettings(state.backgroundSettings);
  }
  await frame();
  check(window.__uiErrors.length === 0, '页面无脚本错误', window.__uiErrors);
  return {
    theme, ok: failures.length === 0, assertions, failures, behavior, modules, palette, contrastPairs, probes,
    interactionProbes: { paletteAction, timeInputFocus },
    layout: { card: cardRect, start: startRect, end: endRect, statusFontPx: getComputedStyle(current).fontSize },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height }
  };
}

async function runChild() {
  console.log('DARK_MODE_UI_STAGE=initialize');
  const { app, BrowserWindow, session } = require('electron');
  const config = JSON.parse(process.env.DARK_MODE_UI_CASE);
  const isolatedRoot = process.env.DARK_MODE_UI_TEMP;
  const userData = path.join(isolatedRoot, 'userData');
  const documents = path.join(isolatedRoot, 'Documents');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(documents, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('documents', documents);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', String(config.scale));
  await app.whenReady();
  console.log('DARK_MODE_UI_STAGE=ready');
  const uiSession = session.fromPartition(`dark-mode-${process.pid}`);
  uiSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer.js'), 'utf8');
  const initialization = source.lastIndexOf('\ninitialize().catch(');
  if (initialization < 0) throw new Error('找不到 Renderer 初始化入口，不能静默跳过');
  const rendererPath = path.join(isolatedRoot, 'renderer-under-test.js');
  const stubPath = path.join(isolatedRoot, 'desktop-api-stub.js');
  const pagePath = path.join(isolatedRoot, 'index-under-test.html');
  fs.writeFileSync(rendererPath, source.slice(0, initialization));
  fs.writeFileSync(stubPath, `(${installStub.toString()})();`);
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sourcePaths = ['index.html', 'scripts/verify-dark-mode-ui.js', ...html.matchAll(/(?:src|href)="\.\/(src\/[^\"]+)"/g)]
    .map((entry) => typeof entry === 'string' ? entry : entry[1]);
  const sourceHashes = Object.fromEntries([...new Set(sourcePaths)].map((file) => [
    file, createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')
  ]));
  html = html.replace('<head>', `<head><base href="${pathToFileURL(ROOT + path.sep).href}"><script src="${pathToFileURL(stubPath).href}"></script>`)
    .replace('./src/renderer.js', pathToFileURL(rendererPath).href);
  fs.writeFileSync(pagePath, html);
  const window = new BrowserWindow({
    width: config.width, height: config.height, frame: false, show: false, enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, session: uiSession, zoomFactor: 1, backgroundThrottling: false }
  });
  try {
    console.log('DARK_MODE_UI_STAGE=window');
    await window.loadFile(pagePath);
    console.log('DARK_MODE_UI_STAGE=loaded');
    window.webContents.debugger.attach('1.3');
    // 隐藏窗口不抢系统焦点；让 Chromium 接收文档焦点，再用真实 DOM.focus 检查样式。
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: config.width, height: config.height, deviceScaleFactor: config.scale, mobile: false,
      screenWidth: config.width, screenHeight: config.height
    });
    window.webContents.setZoomFactor(config.webZoom || 1);
    const results = [];
    for (const theme of ['light', 'dark']) {
      console.log(`DARK_MODE_UI_STAGE=inspect-${theme}`);
      const result = await window.webContents.executeJavaScript(`(${inspectPage.toString()})(${JSON.stringify(theme)}, ${config.behavior && theme === 'dark'})`);
      const zoom = config.webZoom || 1;
      if (Math.abs(result.viewport.width - config.width / zoom) > 1 || Math.abs(result.viewport.height - config.height / zoom) > 1 || Math.abs(result.viewport.dpr - config.scale * zoom) > 0.001 || Math.abs(window.webContents.getZoomFactor() - zoom) > 0.001) {
        result.failures.push({ label: '实际 CSS viewport / DPR 与本组要求一致', detail: { actual: result.viewport, requested: config } });
        result.ok = false;
      }
      const capture = await window.webContents.capturePage();
      const zoomSuffix = zoom !== 1 ? `-webzoom-${Math.round(zoom * 100)}` : '';
      const name = `ui-${config.width}x${config.height}-${Math.round(config.scale * 100)}${zoomSuffix}-${theme}.png`;
      fs.writeFileSync(path.join(EVIDENCE, name), capture.toPNG());
      result.capture = { file: name, pixels: capture.getSize() };
      results.push(result);
    }
    console.log(PREFIX + JSON.stringify({
      config, ok: results.every((item) => item.ok), results, sourceHashes,
      rendering: { mode: 'hidden-window-device-emulation', focusMode: 'CDP document-focus emulation + DOM.focus; no OS focus or Tab traversal', viewportAtZoom100: { width: config.width, height: config.height }, requestedDeviceScale: config.scale, webZoom: window.webContents.getZoomFactor(), bounds: window.getBounds(), contentBounds: window.getContentBounds(), platform: process.platform, electron: process.versions.electron },
      isolation: { realMainLoaded: false, realBusinessApi: false, realRendererLoaded: true, realCssLoaded: true, initializer: '只有 initialize() 自动调用被停用；真实组件函数、主题 bootstrap、控制器与 CSS 全部加载', userData: '临时目录，结束清理', documents: '临时目录，结束清理' }
    }));
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    app.quit();
  }
}

function runParent() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const cases = [];
  const failures = [];
  let passed = 0;
  const webZoom = Number(process.env.DARK_MODE_UI_WEB_ZOOM || 1);
  if (![1, 1.25, 1.5].includes(webZoom)) throw new Error('DARK_MODE_UI_WEB_ZOOM 只接受 1、1.25、1.5');
  for (const [width, height] of VIEWPORTS) {
    for (const scale of webZoom === 1 ? SCALES : [1]) {
      const key = `${width}x${height}@${scale}`;
      if (process.env.DARK_MODE_UI_FILTER && key !== process.env.DARK_MODE_UI_FILTER) continue;
      const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-mode-ui-'));
      const config = { width, height, scale, webZoom, behavior: true };
      try {
        const child = spawnSync(require('electron'), [__filename], {
          cwd: ROOT, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, DARK_MODE_UI_CHILD: '1', DARK_MODE_UI_CASE: JSON.stringify(config), DARK_MODE_UI_TEMP: isolatedRoot, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
        });
        const line = String(child.stdout || '').split(/\r?\n/).find((value) => value.startsWith(PREFIX));
        if (child.error || child.status !== 0 || !line) {
          failures.push({ key, message: child.error?.message || `exit ${child.status}, signal ${child.signal}`, stderr: child.stderr, stdout: child.stdout });
          console.log(`FAIL ${key} 启动或脚本执行失败`);
          continue;
        }
        const result = JSON.parse(line.slice(PREFIX.length));
        cases.push(result);
        if (result.ok) passed += 1;
        else failures.push({ key, failures: result.results.flatMap((item) => item.failures.map((failure) => ({ theme: item.theme, ...failure }))) });
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${key}：两色 / 13 模块 / 设置与背景行为；viewport=${result.results[0].viewport.width}x${result.results[0].viewport.height} DPR=${result.results[0].viewport.dpr} capture=${result.results[0].capture.pixels.width}x${result.results[0].capture.pixels.height}`);
      } finally {
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
      }
    }
  }
  const output = {
    createdAt: new Date().toISOString(), ok: failures.length === 0,
    command: `${webZoom !== 1 ? `DARK_MODE_UI_WEB_ZOOM=${webZoom} ` : ''}node scripts/verify-dark-mode-ui.js`,
    interpretation: webZoom === 1
      ? '固定 CSS viewport + DPR设备媒体模拟；网页 zoom=1；隐藏窗口不等于实机显示器、原生系统缩放或真实 Main 启动验证'
      : '固定窗口内容尺寸，设备缩放1，调用真实 webContents.setZoomFactor；CSS viewport相应缩小，DPR包含页面zoom；隐藏窗口不等于原生系统缩放或真实 Main 启动验证',
    coverageLimitations: [
      '模块检查覆盖基础主面板几何和最小控件字体；不穷举业务数据状态或完整操作流程',
      '完整打开并操作的代表弹窗仅设置/外观页；账户表格和VCC组件使用真实CSS类的静态测试节点',
      '隐藏窗口启用CDP文档焦点模拟后，通过真实DOM.focus检查时间输入的可见焦点轮廓；未触发鼠标hover、OS焦点切换、完整键盘Tab顺序或屏幕阅读器',
      '禁用覆盖保存期间fieldset禁用；未穷举所有业务按钮的disabled配色',
      '对比度检查针对列出的不透明语义色组合；未量化自定义图片每个像素后的实际文字对比度',
      '所有业务desktopApi均为内存模拟，未证明Main冷启动、真实IPC、真实持久化或Windows行为'
    ], cases, failures
  };
  const suffix = (webZoom !== 1 ? `-webzoom-${Math.round(webZoom * 100)}` : '')
    + (process.env.DARK_MODE_UI_FILTER ? '-' + process.env.DARK_MODE_UI_FILTER.replace('@', '-') : '');
  fs.writeFileSync(path.join(EVIDENCE, `ui-verification${suffix}.json`), JSON.stringify(output, null, 2));
  console.log(`==== ${passed}/${cases.length + failures.filter((item) => !item.failures).length} PASS ====`);
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
}

if (process.versions.electron && process.env.DARK_MODE_UI_CHILD === '1') {
  runChild().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
} else runParent();
