'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'changes/v3.2.9/codex/v3.2.9-night-mode/evidence');
const prefix = 'DARK_MODE_LIVE_RESULT=';

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
    fs.writeFileSync(path.join(evidence, 'live-runtime.json'), JSON.stringify({ status: 'PASS', kind: '真实 Main + Preload + Renderer，临时数据库与真实单实例锁', resources, results }, null, 2));
    console.log('==== 2/2 PASS ====');
  } catch (error) {
    const resourceBlocked = String(error).includes('BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE');
    fs.writeFileSync(path.join(evidence, 'live-runtime.json'), JSON.stringify({
      status: resourceBlocked ? 'BLOCKED' : 'FAILED',
      kind: '真实 Main + Preload + Renderer，临时数据库与真实单实例锁',
      resources, results,
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
        const loadSnapshot = await web.executeJavaScript('({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.body).backgroundColor })');
        check(loadSnapshot.theme === initial, `加载完成后的主题 ${loadSnapshot.theme} != ${initial}`);
        check(nativeTheme.themeSource === initial, '原生窗口主题与加载完成后的主题不一致');
        check(app.hasSingleInstanceLock(), '真实应用未持有单实例锁');
        const initializedAt = await waitForRendererReady();
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
        await web.executeJavaScript(`(async () => {
          const settingsButton = document.getElementById('settingsBtn');
          if (!settingsButton) throw new Error('初始化完成后缺少设置按钮');
          settingsButton.click();
          const appearanceTab = document.querySelector('[data-tab="appearance"]');
          if (!appearanceTab) throw new Error('设置打开后缺少外观导航');
          appearanceTab.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        const appearance = await web.executeJavaScript(`({visible: !document.getElementById('appearancePane').hidden, status: document.querySelector('[data-role="dark-mode-status"]').textContent, checked: document.getElementById('darkModeEnabled').checked})`);
        check(appearance.visible && appearance.checked && appearance.status.includes('深色'), '真实外观设置与已保存时段不同步');
        const screenshot = await web.capturePage();
        const imagePath = path.join(evidence, `live-${initial}-startup-dark-settings.png`);
        fs.writeFileSync(imagePath, screenshot.toPNG());
        check(rendererErrors.length === 0, `Renderer 错误：${rendererErrors.join('; ')}`);
        console.log(prefix + JSON.stringify({ ok: failures.length === 0, initial, assertions, application, loadSnapshot, initializedAt, reinitializedAt, reloaded, appearance, imageSize: screenshot.getSize(), failures, rendererErrors }));
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
