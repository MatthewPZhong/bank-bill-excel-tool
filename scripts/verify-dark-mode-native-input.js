'use strict';

// node scripts/verify-dark-mode-native-input.js [证据 JSON 路径]
// DARK_MODE_NATIVE_FILTER 可只运行一个用例。真实原生 time 控件和 CDP 键盘/鼠标输入；不启动业务 Main。
// DARK_MODE_NATIVE_BASELINE_DIR 可加载冻结的 renderer-dark-mode.js 与 dark-mode-schedule.js，保留修复前反例。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const RESULT_PREFIX = 'DARK_MODE_NATIVE_RESULT=';
const SOURCE_FILES = ['scripts/verify-dark-mode-native-input.js', 'src/shared/dark-mode-schedule.js', 'src/renderer-dark-mode.js', 'src/styles-dark-mode.css', 'src/styles-dark-mode-settings.css'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 此函数在隔离 Renderer 内执行；API 模拟持久化与 Main 广播，事件和值均从真实控件读取。
function installHarness(options) {
  const initial = { enabled: false, startTime: '18:30', endTime: '06:00', ...options.initial };
  const h = window.nativeInputHarness = { stored: { ...initial }, revision: 1, requests: [], events: [], themeEvents: [], errors: [], inFlight: 0, maxConcurrent: 0 };
  const listeners = new Set();
  const snapshot = () => ({ darkModeSchedule: { ...h.stored }, themeRevision: h.revision,
    effectiveTheme: window.DarkModeSchedule.resolveEffectiveTheme(h.stored, new Date(2026, 8, 15, 21, 0)) });
  h.controller = window.DarkModeUI.createController({ document,
    onChange(next) { h.themeEvents.push({ theme: next.effectiveTheme, colorScheme: document.documentElement.style.colorScheme, at: performance.now() }); },
    api: {
    onDarkModeScheduleChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async setDarkModeSchedule(config) {
      const request = { config: { ...config }, startedAt: performance.now(), status: 'pending' };
      h.requests.push(request); h.inFlight += 1; h.maxConcurrent = Math.max(h.maxConcurrent, h.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, options.saveDelay));
        if (options.failAll) { request.status = 'failed'; return { status: 'failed', message: '模拟外观设置保存失败' }; }
        h.stored = { ...config }; h.revision += 1; request.status = 'ok';
        const next = snapshot(); listeners.forEach((listener) => listener(next));
        return { status: 'ok', ...next };
      } finally { request.finishedAt = performance.now(); h.inFlight -= 1; }
    }
  } });
  h.controller.accept(snapshot());
  const host = document.getElementById('host');
  if (options.control) {
    host.innerHTML = '<label>开始时间<input data-role="dark-mode-start" type="time" step="60" value="18:30" /></label>';
  } else h.view = window.DarkModeUI.mountSettings(host, h.controller);
  for (const node of host.querySelectorAll('input')) {
    for (const type of ['focus', 'blur', 'input', 'change']) {
      node.addEventListener(type, () => h.events.push({ type, role: node.dataset.role, value: node.value, checked: node.checked,
        disabled: node.matches(':disabled'), active: document.activeElement === node, at: performance.now() }));
    }
  }
  addEventListener('error', (event) => h.errors.push(event.message));
  addEventListener('unhandledrejection', (event) => h.errors.push(String(event.reason)));
  h.read = () => ({ stored: { ...h.stored }, requests: h.requests, events: h.events, themeEvents: h.themeEvents, errors: h.errors,
    inFlight: h.inFlight, maxConcurrent: h.maxConcurrent, snapshot: h.controller.getSnapshot(), theme: document.documentElement.dataset.theme,
    values: Object.fromEntries([...host.querySelectorAll('input')].map((node) => [node.dataset.role, { value: node.value, checked: node.checked, disabled: node.matches(':disabled'), focused: document.activeElement === node }])),
    feedback: { hidden: host.querySelector('[data-role="dark-mode-feedback"]')?.hidden,
      text: host.querySelector('[data-role="dark-mode-feedback"]')?.textContent || '' } });
}

async function runChild() {
  const { app, BrowserWindow } = require('electron');
  const isolatedRoot = process.env.DARK_MODE_NATIVE_TEMP;
  app.setPath('userData', path.join(isolatedRoot, 'userData'));
  app.setPath('documents', path.join(isolatedRoot, 'Documents'));
  fs.mkdirSync(app.getPath('documents'), { recursive: true });
  app.disableHardwareAcceleration();
  await app.whenReady();
  const win = new BrowserWindow({ width: 900, height: 760, show: false, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const sourcePath = (file) => process.env.DARK_MODE_NATIVE_BASELINE_DIR && ['src/shared/dark-mode-schedule.js', 'src/renderer-dark-mode.js'].includes(file)
    ? path.join(process.env.DARK_MODE_NATIVE_BASELINE_DIR, path.basename(file)) : path.join(ROOT, file);
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, createHash('sha256').update(fs.readFileSync(sourcePath(file))).digest('hex')]));
  const fixturePath = path.join(isolatedRoot, 'fixture.html');
  const url = (file) => pathToFileURL(sourcePath(file)).href;
  fs.writeFileSync(fixturePath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script src="${url('src/shared/dark-mode-schedule.js')}"></script><script src="${url('src/renderer-dark-mode.js')}"></script><link rel="stylesheet" href="${url('src/styles-dark-mode.css')}"><link rel="stylesheet" href="${url('src/styles-dark-mode-settings.css')}"></head><body><div id="host" style="width:700px"></div></body></html>`);
  const results = [];
  let nativeHour20Control = null;
  let locale = null;
  async function key(value) {
    const special = { ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], Backspace: ['Backspace', 8] };
    const [code, virtualKey] = special[value] || ['Digit' + value, value.charCodeAt(0)];
    const options = { key: value, code, windowsVirtualKeyCode: virtualKey };
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...options, ...(!special[value] ? { text: value } : {}) });
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...options });
  }
  async function read() { return win.webContents.executeJavaScript('nativeInputHarness.read()'); }
  async function focusSegment(field, segment = 'hour') {
    await win.webContents.executeJavaScript(`document.querySelector('[data-role="dark-mode-${field}"]').focus();`);
    // 左移回第一个分段；关键时间编辑始终交给原生键盘事件。
    await key('ArrowLeft'); await key('ArrowLeft');
    if (segment === 'minute') await key('ArrowRight');
  }
  async function typeDigits(field, segment, digits, interval) {
    await focusSegment(field, segment);
    await key(digits[0]); await wait(interval); await key(digits[1]);
    return read();
  }
  async function clickSwitch() {
    const point = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-role="dark-mode-enabled"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function settled() {
    const deadline = Date.now() + 5000;
    let stableSince = null;
    while (Date.now() < deadline) {
      const state = await read();
      if (state.inFlight === 0 && !state.snapshot.saving) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= 60) return state;
      } else stableSince = null;
      await wait(20);
    }
    throw new Error('保存队列未在 5 秒内完成');
  }
  const cases = [{ name: 'native-control-19', control: true, saveDelay: 0, interval: 100, field: 'start', segment: 'hour', digits: '19', expected: '19:30' }];
  for (const [saveDelay, interval] of [[15, 100], [200, 30]]) {
    for (const [field, segment, digits, expected] of [['start', 'hour', '19', '19:30'], ['start', 'minute', '45', '18:45'], ['end', 'hour', '07', '07:00'], ['end', 'minute', '45', '06:45']]) {
      cases.push({ name: `${field}-${segment}-save${saveDelay}-key${interval}`, saveDelay, interval, field, segment, digits, expected });
    }
  }
  // 原生 12 小时制首位 1 会产生 13:30，24 小时制产生 01:30；两者都必须跨过浅色再回到深色。
  cases.push({ name: 'enabled-start-hour-save15-key100', saveDelay: 15, interval: 100, initial: { enabled: true, endTime: '14:00' },
    field: 'start', segment: 'hour', digits: '19', expected: '19:30', expectThemes: ['dark', 'light', 'dark'] });
  cases.push({ name: 'slow-two-fields', saveDelay: 200, initial: { enabled: true } },
    { name: 'disable-during-save', saveDelay: 200, initial: { enabled: true } },
    { name: 'edit-time-after-queued-off', saveDelay: 300, initial: { enabled: true } },
    { name: 'invalid-time-after-queued-off', saveDelay: 300, initial: { enabled: true } },
    { name: 'invalid-time-before-queued-off', saveDelay: 300, initial: { enabled: true } },
    { name: 'save-failure-keeps-focus', saveDelay: 15, interval: 100, failAll: true, initial: { enabled: true } });
  const selectedCases = cases.filter((entry) => !process.env.DARK_MODE_NATIVE_FILTER || entry.name === process.env.DARK_MODE_NATIVE_FILTER);
  if (!selectedCases.length) throw new Error('没有匹配的原生时间输入用例');
  try {
    await win.loadFile(fixturePath);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    // 裸控件只记录平台按键解释，不将其观测值用作产品保存断言的替代预期。
    await win.webContents.executeJavaScript(`(${installHarness.toString()})(${JSON.stringify({ control: true, saveDelay: 0 })});`);
    const control20 = await typeDigits('start', 'hour', '20', 30);
    nativeHour20Control = { value: control20.values['dark-mode-start'].value, events: control20.events, requests: control20.requests };
    locale = await win.webContents.executeJavaScript(`({ language: navigator.language, languages: navigator.languages,
      dateTimeFormat: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric' }).resolvedOptions() })`);
    for (const entry of selectedCases) {
      const checks = []; let during = null; let state = null;
      const check = (passed, name, detail) => checks.push({ passed: Boolean(passed), name, ...(detail === undefined ? {} : { detail }) });
      try {
        await win.loadFile(fixturePath);
        await win.webContents.executeJavaScript(`(${installHarness.toString()})(${JSON.stringify(entry)});`);
        if (entry.field) {
          during = await typeDigits(entry.field, entry.segment, entry.digits, entry.interval);
          state = await settled();
          check(state.values[`dark-mode-${entry.field}`].value === entry.expected, '连续数字保留完整控件值', state.values);
          if (!entry.control) {
            check(state.stored[entry.field === 'start' ? 'startTime' : 'endTime'] === entry.expected, '最终保存完整时间', state.stored);
            check(!state.events.some((event) => event.type === 'blur'), '连续编辑没有被保存打断焦点', state.events);
          }
          if (entry.expectThemes) {
            const themes = state.themeEvents.map((event) => event.theme).filter((theme, index, all) => index === 0 || theme !== all[index - 1]);
            check(JSON.stringify(themes) === JSON.stringify(entry.expectThemes) && state.themeEvents.every((event) => event.colorScheme === event.theme),
              '连续输入跨越浅深色和原生 color-scheme 切换仍完整', state.themeEvents);
          }
        } else if (entry.name === 'slow-two-fields') {
          await typeDigits('start', 'hour', '19', 30);
          during = await typeDigits('end', 'hour', '07', 30);
          check(during.inFlight > 0, '第二字段在先前保存未完成时编辑');
          state = await settled();
          check(state.stored.startTime === '19:30' && state.stored.endTime === '07:00' && state.stored.enabled, '慢保存期间两字段最后输入都保存', state.stored);
          check(state.values['dark-mode-start'].value === '19:30' && state.values['dark-mode-end'].value === '07:00', '回包没有覆盖后续输入', state.values);
        } else if (entry.name === 'disable-during-save') {
          await focusSegment('start'); await key('ArrowUp'); during = await read();
          check(during.inFlight === 1, '关闭前真实键盘编辑已进入保存');
          const pendingConfig = during.requests[0]?.config;
          await clickSwitch();
          state = await settled();
          check(state.stored.enabled === false && state.theme === 'light', '保存中点击关闭最终关闭并转浅色', state.stored);
          check(state.stored.startTime === pendingConfig?.startTime && state.stored.endTime === pendingConfig?.endTime, '关闭保留先前在途保存成功的时段', { pendingConfig, stored: state.stored });
        } else if (entry.name.endsWith('-queued-off')) {
          await focusSegment('end'); await key('ArrowUp');
          const firstSave = await read();
          check(firstSave.inFlight === 1 && firstSave.requests[0]?.config.endTime === '07:00', '结束时间的真实按键已产生在途保存', firstSave.requests);
          const invalidBeforeOff = entry.name === 'invalid-time-before-queued-off';
          if (invalidBeforeOff) { await focusSegment('start'); await key('Backspace'); }
          await clickSwitch();
          if (entry.name === 'edit-time-after-queued-off') during = await typeDigits('start', 'hour', '19', 30);
          else if (!invalidBeforeOff) { await focusSegment('start'); await key('Backspace'); }
          during = during || await read();
          check(during.requests.length === 1 && during.inFlight === 1 && during.requests.every((request) => request.config.enabled), '后续输入发生时关闭请求仍排队', during.requests);
          check(!during.values['dark-mode-enabled'].checked, '关闭意图没有被编辑时间覆盖', during.values);
          if (entry.name !== 'edit-time-after-queued-off') check(during.events.some((event) => event.role === 'dark-mode-start' && event.type === 'input' && event.value === ''),
            'Backspace 已产生原生非法时间草稿', during.events);
          state = await settled();
          check(!state.stored.enabled && state.theme === 'light', '旧或新时间草稿均不阻止队列关闭', state.stored);
          const expectedStart = entry.name === 'edit-time-after-queued-off' ? '19:30' : '18:30';
          check(state.stored.startTime === expectedStart && state.stored.endTime === '07:00',
            entry.name === 'edit-time-after-queued-off' ? '关闭之后新编辑的合法时间最终保存' : '非法时间没有替换已保存时段', state.stored);
          if (entry.name === 'edit-time-after-queued-off') {
            const beforeBlur = state.values['dark-mode-start'].value;
            await focusSegment('end'); state = await read();
            check(beforeBlur === '19:30' && state.values['dark-mode-start'].value === '19:30', '失焦后没有回退关闭之后的输入', state.values);
          } else if (invalidBeforeOff) {
            check(state.values['dark-mode-start'].value === '18:30', '关闭前的非法草稿按原语义恢复已保存时段', state.values);
          }
        } else {
          during = await typeDigits('start', 'hour', '19', entry.interval);
          state = await settled();
          check(state.stored.startTime === '18:30' && state.stored.enabled && state.theme === 'dark', '保存失败保留已保存配置与主题', state.stored);
          check(state.values['dark-mode-start'].focused && !state.events.some((event) => event.type === 'blur'), '保存失败没有打断正在编辑的焦点', state.events);
          check(!state.values['dark-mode-start'].disabled, '失败后仍可继续编辑');
          check(!state.feedback.hidden && /保存失败/.test(state.feedback.text), '保存失败原因可见', state.feedback);
        }
        check(state.maxConcurrent <= 1, '保存请求没有并发', state.maxConcurrent);
        check(state.errors.length === 0, '没有页面异常', state.errors);
      } catch (error) { check(false, '原生交互执行完成', error.stack || String(error)); state = await read().catch(() => null); }
      results.push({ name: entry.name, options: entry, passed: checks.every((item) => item.passed), checks, during, state });
    }
    const evidence = { generatedAt: new Date().toISOString(), platform: process.platform, electron: process.versions.electron, sourceHashes, locale, nativeHour20Control,
      isolation: { realMain: false, businessData: false, renderer: '真实共享 UI 与原生 type=time', input: 'CDP 键盘/鼠标，DOM.focus 选定控件；未用赋 value 或合成 change 代替时间输入', userData: '临时目录，父进程结束清理', windowsVerified: process.platform === 'win32' }, results };
    console.log(RESULT_PREFIX + JSON.stringify(evidence));
  } finally { if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach(); win.destroy(); app.quit(); }
}

function runParent() {
  const { spawnSync } = require('node:child_process');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-mode-native-'));
  const env = { ...process.env, DARK_MODE_NATIVE_CHILD: '1', DARK_MODE_NATIVE_TEMP: isolatedRoot }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename], { env, cwd: ROOT, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    const line = String(result.stdout || '').split(/\r?\n/).find((value) => value.startsWith(RESULT_PREFIX));
    if (result.error || result.status !== 0 || !line) throw new Error(result.error?.message || `隔离 Electron 失败：${result.status} ${result.stderr} ${result.stdout}`);
    const evidence = JSON.parse(line.slice(RESULT_PREFIX.length));
    if (process.argv[2]) { const target = path.resolve(process.argv[2]); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n'); }
    for (const entry of evidence.results) {
      console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.name}${entry.passed ? '' : ': ' + entry.checks.filter((check) => !check.passed).map((check) => check.name).join('；')}`);
    }
    const passed = evidence.results.filter((entry) => entry.passed).length;
    console.log(`原生时间输入 ${passed}/${evidence.results.length} PASS；${evidence.platform} / Electron ${evidence.electron}；真实 Main 与业务数据未加载`);
    if (passed !== evidence.results.length) process.exitCode = 1;
  } finally { fs.rmSync(isolatedRoot, { recursive: true, force: true }); }
}

if (process.versions.electron && process.env.DARK_MODE_NATIVE_CHILD === '1') {
  runChild().catch((error) => { console.error(error.stack || error); require('electron').app.exit(1); });
} else runParent();
