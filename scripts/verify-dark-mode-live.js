'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = path.resolve(process.env.DARK_MODE_LIVE_EVIDENCE_DIR
  || path.join(root, 'changes/v3.2.9/codex/v3.2.9-night-mode/evidence'));
const prefix = 'DARK_MODE_LIVE_RESULT=';
const evidenceLimit = 'did-finish-load 只验证加载完成状态；本脚本未连续采样启动全过程，不证明首帧或无闪白';

async function waitForVisibleWindow(window) {
  const deadline = Date.now() + 15000;
  while (!window.isVisible() || window.isMinimized()) {
    if (window.isDestroyed() || Date.now() >= deadline) throw new Error('真实 Main 窗口未正常显示');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function capturePresentedPage(window, name, settings = false) {
  await waitForVisibleWindow(window);
  const web = window.webContents;
  const state = await web.executeJavaScript(`(() => {
    const settings = ${JSON.stringify(settings)};
    const pane = document.getElementById('appearancePane');
    const card = pane?.closest('[role="dialog"]');
    const viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    if (settings && (!pane || pane.hidden || !card?.isConnected)) throw new Error('外观设置未显示');
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const paneRect = settings ? rect(pane) : null;
    const cardRect = settings ? rect(card) : null;
    const points = settings ? [
      { x: cardRect.x + cardRect.width - 80, y: cardRect.y + 20 },
      { x: paneRect.x + paneRect.width - 12, y: paneRect.y + 12 },
      { x: paneRect.x + paneRect.width - 12, y: paneRect.y + paneRect.height - 12 }
    ] : [{ x: 10, y: innerHeight / 2 }];
    const samples = points.map((point) => {
      let element = document.elementFromPoint(point.x, point.y);
      if (!element || (settings && !card.contains(element))) throw new Error('截图采样点不在可见设置弹窗内');
      while (element) {
        const color = getComputedStyle(element).backgroundColor;
        if (color.startsWith('rgb(')) return { ...point, color };
        element = element.parentElement;
      }
      throw new Error('截图采样点没有可核对的不透明背景');
    });
    return { viewport, paneRect, cardRect, samples, theme: document.documentElement.dataset.theme,
      documentVisibility: document.visibilityState, appearanceVisible: settings ? !pane.hidden : null,
      checked: settings ? document.getElementById('darkModeEnabled').checked : null };
  })()`);
  let frames = 0;
  let lastChecks = [];
  const image = await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, captured) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(repaint);
      web.endFrameSubscription();
      if (error) reject(error);
      else resolve(captured);
    };
    const timer = setTimeout(() => finish(new Error(`呈现帧未匹配当前 DOM：${JSON.stringify(lastChecks)}`)), 10000);
    const repaint = setInterval(() => web.invalidate(), 100);
    web.beginFrameSubscription(false, (captured) => {
      try {
        frames += 1;
        const size = captured.getSize();
        const bitmap = captured.toBitmap();
        if (!size.width || !size.height || bitmap.length !== size.width * size.height * 4) return;
        lastChecks = state.samples.map((sample) => {
          const x = Math.min(size.width - 1, Math.round(sample.x * size.width / state.viewport.width));
          const y = Math.min(size.height - 1, Math.round(sample.y * size.height / state.viewport.height));
          const offset = (y * size.width + x) * 4;
          const actual = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
          const expected = sample.color.match(/[\d.]+/g).map(Number);
          return { x, y, expected, actual, matches: expected.every((value, index) => Math.abs(value - actual[index]) <= 3) };
        });
        if (lastChecks.every((sample) => sample.matches)) finish(null, captured);
      } catch (error) { finish(error); }
    });
    // rAF 回调发生在提交给 compositor 之前；订阅实际呈现帧并验证弹窗像素。
    web.invalidate();
  });
  fs.writeFileSync(path.join(evidence, name), image.toPNG());
  return { file: name, imageSize: image.getSize(), presentedFrames: frames, pixelChecks: lastChecks,
    windowVisible: window.isVisible(), windowMinimized: window.isMinimized(), ...state };
}

function parent() {
  const deadline = Date.now() + 90000;
  const { AppDatabase } = require('../src/backend/database');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'night-mode-live-'));
  const userData = path.join(temp, 'userData');
  fs.mkdirSync(userData);
  fs.mkdirSync(evidence, { recursive: true });
  const results = [];
  const resources = { freeMemoryMiB: os.freemem() / 1048576, totalMemoryMiB: os.totalmem() / 1048576 };
  try {
    for (const initialTheme of ['light', 'dark']) {
      const now = new Date();
      const time = (offset) => {
        const minutes = (now.getHours() * 60 + now.getMinutes() + offset) % 1440;
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      };
      const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
      database.init();
      database.setDarkModeSchedule({ enabled: initialTheme === 'dark', startTime: time(0), endTime: time(60) });
      database.close();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('冷启动验证超过 90 秒总时限');
      const child = spawnSync(require('electron'), [__filename], {
        cwd: root, encoding: 'utf8', timeout: remainingMs, killSignal: 'SIGKILL',
        env: {
          ...process.env,
          DARK_MODE_LIVE_CHILD: '1', DARK_MODE_LIVE_INITIAL: initialTheme,
          DARK_MODE_LIVE_EVIDENCE_DIR: evidence,
          APP_USER_DATA_DIR: userData, APP_DOCUMENTS_DIR: path.join(temp, 'Documents'),
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
        }
      });
      fs.writeFileSync(path.join(evidence, `live-${initialTheme}-runtime.log`), `${child.stdout || ''}\n${child.stderr || ''}`);
      const line = String(child.stdout).split(/\r?\n/).find((item) => item.startsWith(prefix));
      const result = line ? JSON.parse(line.slice(prefix.length)) : null;
      if (result) results.push(result);
      if (child.error || child.status !== 0 || !result) {
        throw new Error([child.error?.message, `测试进程退出码 ${child.status}，信号 ${child.signal || '无'}`, child.stdout, child.stderr].filter(Boolean).join('\n'));
      }
      if (!result.ok) throw new Error(JSON.stringify(result));
      console.log(`[dark-mode-live] ${initialTheme} startup/reload/settings PASS`);
    }
    fs.writeFileSync(path.join(evidence, 'live-runtime.json'), JSON.stringify({ status: 'PASS', kind: '真实 Main + Preload + Renderer，临时数据库与真实单实例锁', evidenceLimit, resources, results }, null, 2));
    console.log('==== 2/2 PASS ====');
  } catch (error) {
    const resourceBlocked = String(error).includes('BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
    fs.writeFileSync(path.join(evidence, 'live-runtime.json'), JSON.stringify({
      status: resourceBlocked ? 'BLOCKED' : 'FAILED',
      kind: '真实 Main + Preload + Renderer，临时数据库与真实单实例锁',
      evidenceLimit, resources, results,
      reason: resourceBlocked ? '现有 BizOP 首次激活资源准入失败；未创建业务窗口，不能判定 GUI 冷启动通过' : String(error),
      code: resourceBlocked ? 'BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE' : null
    }, null, 2));
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function child() {
  const { app, nativeTheme } = require('electron');
  // 文件入口的默认 appPath 是 scripts；恢复根 package.json 对应的应用身份。
  const packageInfo = require('../package.json');
  const expectedName = packageInfo.productName || packageInfo.name;
  app.setAppPath(root);
  app.name = expectedName;
  app.setVersion(packageInfo.version);
  assert.equal(app.getAppPath(), root);
  assert.equal(app.getName(), expectedName);
  assert.equal(app.getVersion(), packageInfo.version);
  const application = { appPath: app.getAppPath(), name: app.getName(), version: app.getVersion() };
  const initial = process.env.DARK_MODE_LIVE_INITIAL;
  let handled = false;
  const timeout = setTimeout(() => { console.error('真实应用启动验证超时'); app.exit(1); }, 80000);
  app.on('browser-window-created', (_event, window) => {
    if (handled) return;
    handled = true;
    const web = window.webContents;
    const rendererErrors = [];
    web.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
    const waitForRendererReady = () => web.executeJavaScript(`(async () => {
      const deadline = performance.now() + 30000;
      while (typeof getRendererStartupValue !== 'function'
        || getRendererStartupValue('renderer-init-complete') === undefined) {
        if (performance.now() >= deadline) throw new Error('等待 Renderer 初始化完成超过 30 秒');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return getRendererStartupValue('renderer-init-complete');
    })()`);
    web.once('did-finish-load', async () => {
      const failures = [];
      let assertions = 0;
      const check = (value, message) => { assertions += 1; if (!value) failures.push(message); };
      try {
        const windowAtLoad = { visible: window.isVisible(), minimized: window.isMinimized() };
        const loadSnapshot = await web.executeJavaScript('({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.body).backgroundColor })');
        check(loadSnapshot.theme === initial, `加载完成后的主题 ${loadSnapshot.theme} != ${initial}`);
        check(nativeTheme.themeSource === initial, '原生窗口主题与加载完成后的主题不一致');
        check(app.hasSingleInstanceLock(), '真实应用未持有单实例锁');
        const initializedAt = await waitForRendererReady();
        const windowAfterInit = { visible: window.isVisible(), minimized: window.isMinimized() };
        assert.equal(app.getPath('userData'), process.env.APP_USER_DATA_DIR);
        assert.equal(app.getPath('documents'), process.env.APP_DOCUMENTS_DIR);
        const startupCapture = await capturePresentedPage(window, `live-${initial}-startup.png`);
        const result = await web.executeJavaScript(`(async () => {
          const info = await window.desktopApi.app.getInfo();
          const snapshots = [];
          const unsubscribe = window.desktopApi.settings.onDarkModeScheduleChanged(s => snapshots.push(s));
          const dark = await window.desktopApi.settings.setDarkModeSchedule({ ...info.darkModeSchedule, enabled: true });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const paintedDark = document.documentElement.dataset.theme;
          const light = await window.desktopApi.settings.setDarkModeSchedule({ ...info.darkModeSchedule, enabled: false });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const paintedLight = document.documentElement.dataset.theme;
          const restored = await window.desktopApi.settings.setDarkModeSchedule({ ...info.darkModeSchedule, enabled: true });
          unsubscribe();
          return { info, dark, light, restored, snapshots, paintedDark, paintedLight };
        })()`);
        check(result.info.effectiveTheme === initial, '真实 app:get-info 启动主题错误');
        check(result.dark.status === 'ok' && result.paintedDark === 'dark', '真实 IPC 开启定时模式未显示深色');
        check(result.light.status === 'ok' && result.paintedLight === 'light', '真实 IPC 关闭定时模式未显示浅色');
        check(result.snapshots.length >= 2, '真实主题事件未到达 Preload');
        await new Promise((resolve) => { web.once('did-finish-load', resolve); web.reload(); });
        const reloaded = await web.executeJavaScript('document.documentElement.dataset.theme');
        check(reloaded === 'dark', '页面重载完成后没有保持深色');
        // 等真实初始化完成，随后通过真实设置入口打开外观。
        const reinitializedAt = await waitForRendererReady();
        const reloadCapture = await capturePresentedPage(window, `live-${initial}-reload-dark.png`);
        await web.executeJavaScript(`(async () => {
          const settingsButton = document.getElementById('settingsBtn');
          if (!settingsButton) throw new Error('初始化完成后缺少设置按钮');
          settingsButton.click();
          const appearanceTab = document.querySelector('[data-tab="appearance"]');
          if (!appearanceTab) throw new Error('设置打开后缺少外观导航');
          appearanceTab.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        const appearance = await web.executeJavaScript(`({visible: !document.getElementById('appearancePane').hidden, theme: document.documentElement.dataset.theme, checked: document.getElementById('darkModeEnabled').checked,
          values: { start: document.querySelector('[data-role="dark-mode-start"]').value, end: document.querySelector('[data-role="dark-mode-end"]').value }})`);
        check(appearance.visible && appearance.checked && appearance.theme === 'dark', '真实外观设置与已保存时段不同步');
        const settingsCapture = await capturePresentedPage(window, `live-${initial}-startup-dark-settings.png`, true);
        check(settingsCapture.appearanceVisible && settingsCapture.checked && settingsCapture.theme === 'dark'
          && settingsCapture.pixelChecks.every((sample) => sample.matches), '实际呈现帧与外观设置 DOM 不一致');
        const { inspectNativeTimeLayout } = require('./lib/native-time-layout');
        const timeLayout = { original: await inspectNativeTimeLayout(web) };
        const oldGridStyle = await web.executeJavaScript(`document.querySelector('.appearance-time-grid').getAttribute('style')`);
        const oldBounds = window.getBounds();
        const oldMinimumSize = window.getMinimumSize();
        // Windows 首次呈现可被工作区压到小于 minSize；setBounds 会恢复最小尺寸约束。
        const restorableBounds = { ...oldBounds,
          width: Math.max(oldBounds.width, oldMinimumSize[0]),
          height: Math.max(oldBounds.height, oldMinimumSize[1]) };
        const oldZoom = web.getZoomFactor();
        const settleLayout = () => web.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const waitForViewport = async (bounds, zoom) => {
          const expected = { width: bounds.width / zoom, height: bounds.height / zoom };
          const startedAt = Date.now();
          const samples = [];
          let consecutive = 0;
          let sampleCount = 0;
          while (Date.now() - startedAt < 5000) {
            const viewport = await web.executeJavaScript(`({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`);
            const actualBounds = window.getBounds();
            const actualZoom = web.getZoomFactor();
            sampleCount += 1;
            samples.push({ ...viewport, actualBounds, actualZoom, elapsedMs: Date.now() - startedAt });
            if (samples.length > 20) samples.shift();
            consecutive = Math.abs(viewport.width - expected.width) <= 1
              && Math.abs(viewport.height - expected.height) <= 1
              && actualBounds.width === bounds.width && actualBounds.height === bounds.height
              && Math.abs(actualZoom - zoom) < 0.001 ? consecutive + 1 : 0;
            if (consecutive === 2) return { ok: true, expected, sampleCount, samples };
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return { ok: false, expected, sampleCount, samples };
        };
        const restoreGridStyle = () => web.executeJavaScript(`(() => {
          const grid = document.querySelector('.appearance-time-grid');
          if (!grid) throw new Error('恢复时缺少时间框网格');
          const oldStyle = ${JSON.stringify(oldGridStyle)};
          if (oldStyle === null) grid.removeAttribute('style'); else grid.setAttribute('style', oldStyle);
        })()`);
        try {
          await web.executeJavaScript(`(async () => {
            document.querySelector('.appearance-time-grid').style.gridTemplateColumns = '104px 22px 104px';
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`);
          timeLayout.historical104 = await inspectNativeTimeLayout(web);
          timeLayout.historical104Capture = await capturePresentedPage(window, `live-${initial}-historical-time-width-104.png`, true);
          check(['PASS', 'FAIL'].includes(timeLayout.historical104.status)
            && timeLayout.historical104.inputs.length === 2
            && timeLayout.historical104.inputs.every(input => ['PASS', 'FAIL'].includes(input.status)
              && Array.isArray(input.missing) && input.missing.length === 0
              && Math.abs(input.host?.rect?.width - 104) < 1),
          '历史 104px 对照缺少有效字段几何证据');
          // 历史对照可因 AM/PM 裁切而 FAIL；恢复生产样式后再测最窄合同窗口。
          await restoreGridStyle();
          window.setSize(1080, 760, false);
          web.setZoomFactor(1.5);
          // Browser 侧 zoom getter 先更新；等待 Renderer 实际接收视觉尺寸，不能仅等固定帧数。
          const narrowViewportWait = await waitForViewport({ width: 1080, height: 760 }, 1.5);
          check(narrowViewportWait.ok, '窄窗口 Renderer 未在 5 秒内应用实际页面缩放');
          await settleLayout();
          const narrowPage = await web.executeJavaScript(`(() => {
            const pane = document.getElementById('appearancePane');
            const scroll = pane?.querySelector('.appearance-pane-scroll');
            const grid = pane?.querySelector('.appearance-time-grid');
            if (!pane || pane.hidden || !scroll || !grid || !document.body) throw new Error('窄窗口外观设置节点不完整');
            const metrics = element => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
            };
            return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
              pane: metrics(pane), scroll: metrics(scroll), grid: metrics(grid),
              document: metrics(document.documentElement), body: metrics(document.body),
              gridInlineStyle: grid.getAttribute('style') };
          })()`);
          timeLayout.narrow150 = {
            requested: { width: 1080, height: 760, zoomFactor: 1.5 },
            bounds: window.getBounds(), contentBounds: window.getContentBounds(),
            minimumSize: window.getMinimumSize(), zoomFactor: web.getZoomFactor(),
            viewportWait: narrowViewportWait,
            ...narrowPage,
            geometry: await inspectNativeTimeLayout(web),
          };
          const narrow = timeLayout.narrow150;
          check(narrow.bounds.width === 1080 && narrow.bounds.height === 760
            && Math.abs(narrow.zoomFactor - 1.5) < 0.001
            && Math.abs(narrow.viewport.width - narrow.contentBounds.width / 1.5) <= 1
            && Math.abs(narrow.viewport.height - narrow.contentBounds.height / 1.5) <= 1,
          '窄窗口实际 bounds / viewport / 页面缩放与请求不一致');
          check(narrow.gridInlineStyle === oldGridStyle && narrow.geometry.status === 'PASS',
            '窄窗口生产样式或原生时间内部字段完整性未通过');
          check(narrow.geometry.inputs.length === 2 && narrow.geometry.inputs.every(input =>
            ['width', 'height', 'dpr'].every(key => Math.abs(
              (key === 'dpr' ? input.host?.devicePixelRatio : input.host?.viewport?.[key]) - narrow.viewport[key]) <= 0.001)),
          '窄窗口页面与原生字段不是同一实际 viewport');
          check([narrow.pane, narrow.scroll].every(item => Number.isFinite(item.scrollWidth)
            && Number.isFinite(item.clientWidth) && item.clientWidth > 0
            && item.scrollWidth <= item.clientWidth + 1), '窄窗口外观 pane 存在水平溢出或缺少尺寸');
          check([narrow.document, narrow.body].every(item => Number.isFinite(item.scrollWidth)
            && item.scrollWidth > 0 && item.scrollWidth <= narrow.viewport.width + 1),
          '窄窗口 document 存在水平溢出或缺少尺寸');
          timeLayout.narrow150Capture = await capturePresentedPage(window, `live-${initial}-production-1080x760-zoom-150.png`, true);
          check(['width', 'height', 'dpr'].every(key =>
            Math.abs(timeLayout.narrow150Capture.viewport[key] - narrow.viewport[key]) <= 0.001),
          '窄窗口截图与几何证据不是同一实际 viewport');
        } finally {
          // 每项均尝试恢复，避免某个恢复异常阻止其余状态复原。
          const restoreErrors = [];
          for (const [name, restore] of [
            ['gridInlineStyle', restoreGridStyle],
            ['zoomFactor', () => web.setZoomFactor(oldZoom)],
            ['bounds', () => window.setBounds(restorableBounds, false)],
          ]) {
            try { await restore(); }
            catch (error) { restoreErrors.push(`${name}: ${error.message}`); }
          }
          timeLayout.restoreViewportWait = await waitForViewport(restorableBounds, oldZoom);
          check(timeLayout.restoreViewportWait.ok, '恢复时 Renderer 未在 5 秒内应用实际页面缩放');
          await settleLayout();
          if (restoreErrors.length) throw new Error(`时间框取证恢复失败：${restoreErrors.join('; ')}`);
        }
        timeLayout.restoration = {
          originalBounds: oldBounds, expectedBounds: restorableBounds, actualBounds: window.getBounds(),
          minimumSizeApplied: restorableBounds.width !== oldBounds.width || restorableBounds.height !== oldBounds.height,
          expectedMinimumSize: oldMinimumSize, actualMinimumSize: window.getMinimumSize(),
          expectedZoom: oldZoom, actualZoom: web.getZoomFactor(),
          expectedGridInlineStyle: oldGridStyle,
          actualGridInlineStyle: await web.executeJavaScript(`document.querySelector('.appearance-time-grid').getAttribute('style')`),
        };
        const restoredState = timeLayout.restoration;
        check(['x', 'y', 'width', 'height'].every(key => restoredState.actualBounds[key] === restorableBounds[key])
          && oldMinimumSize.every((value, index) => restoredState.actualMinimumSize[index] === value)
          && Math.abs(restoredState.actualZoom - oldZoom) < 0.001
          && restoredState.actualGridInlineStyle === oldGridStyle, '时间框取证未恢复最小尺寸约束下的 bounds / zoom / inline style');
        timeLayout.restored = await inspectNativeTimeLayout(web);
        timeLayout.valuesUnchanged = [timeLayout.original, timeLayout.historical104,
          timeLayout.narrow150.geometry, timeLayout.restored].every(sample =>
          sample.inputs.length === 2 && ['dark-mode-start', 'dark-mode-end'].every(role => {
            const inputs = sample.inputs.filter(input => input.role === role);
            return inputs.length === 1 && inputs[0].value === appearance.values[role === 'dark-mode-start' ? 'start' : 'end'];
          }));
        check(timeLayout.valuesUnchanged, '时间框宽度或窄窗口取证改变了输入值');
        check(timeLayout.original.status === 'PASS' && timeLayout.restored.status === 'PASS', '原生时间字段含 AM/PM 完整可见性未通过');
        check(rendererErrors.length === 0, `Renderer 错误：${rendererErrors.join('; ')}`);
        console.log(prefix + JSON.stringify({ ok: failures.length === 0, initial, assertions, application,
          isolation: { userData: app.getPath('userData'), documents: app.getPath('documents') },
          windowAtLoad, windowAfterInit, loadSnapshot, initializedAt, reinitializedAt, reloaded, appearance,
          startupCapture, reloadCapture, settingsCapture, timeLayout, evidenceLimit, failures, rendererErrors }));
        process.exitCode = failures.length ? 1 : 0;
      } catch (error) {
        console.log(prefix + JSON.stringify({ ok: false, initial, failures: [String(error.stack || error)] }));
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
        app.quit();
      }
    });
  });
  // 不设置 APP_CAPTURE_PATH：真实单实例锁与业务启动保护均按正常入口执行。
  require('../src/main');
}

if (process.env.DARK_MODE_LIVE_CHILD === '1') child();
else {
  try { parent(); }
  catch (error) { console.error(error.stack || String(error)); process.exitCode = 1; }
}
