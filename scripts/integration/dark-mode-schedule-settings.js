// 定时深色模式设置集成验证。
// 覆盖真实 Preload → Main handler → 调度器 → AppDatabase 持久化、重启重判、
// 失败不改主题、坏配置安全关闭，以及已有背景配置和图片文件保全。
// Main 的生产 handler / 初始化源码直接执行于隔离 VM，所有数据库和文件均在临时目录。
// 用法：node scripts/integration/dark-mode-schedule-settings.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AppDatabase } = require('../../src/backend/database');
const { createDarkModeScheduler } = require('../../src/main-process/dark-mode-scheduler');
const { DEFAULT_DARK_MODE_SCHEDULE } = require('../../src/shared/dark-mode-schedule');

const repoRoot = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(repoRoot, 'src/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(repoRoot, 'src/preload.js'), 'utf8');
const enabled = { ...DEFAULT_DARK_MODE_SCHEDULE, enabled: true };
const localTime = (hour, minute) => new Date(2026, 8, 12, hour, minute);
const plain = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
const failures = [];

function sliceProductionSource(startText, endText) {
  const start = mainSource.indexOf(startText);
  const end = mainSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `缺少生产入口 ${startText}`);
  return mainSource.slice(start, end);
}

function bootRuntime(database, storageRoot, initialTime) {
  let currentTime = initialTime;
  let scheduler;
  let nextTimerId = 0;
  const timers = new Map();
  const handlers = new Map();
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (channel, ...args) => {
    assert.ok(handlers.has(channel), `未注册 IPC ${channel}`);
    return handlers.get(channel)({}, ...args);
  };
  const app = new EventEmitter();
  app.getVersion = () => '3.2.8';
  const powerMonitor = new EventEmitter();
  const nativeTheme = { themeSource: 'system' };
  const window = {
    color: null,
    isDestroyed: () => false,
    setBackgroundColor(color) { this.color = color; },
    webContents: {
      isDestroyed: () => false,
      send: (channel, value) => ipcRenderer.emit(channel, { sender: 'main' }, value)
    }
  };
  const context = vm.createContext({
    database,
    app,
    powerMonitor,
    nativeTheme,
    BrowserWindow: { getAllWindows: () => [window] },
    createDarkModeScheduler(options) {
      scheduler = createDarkModeScheduler({
        ...options,
        now: () => currentTime,
        setTimeoutFn(callback, delay) {
          const id = ++nextTimerId;
          timers.set(id, { callback, delay });
          return id;
        },
        clearTimeoutFn: (id) => timers.delete(id)
      });
      return scheduler;
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getEnumConfig: () => null,
    ensureStorageRoot: () => storageRoot,
    lastErrorReport: null,
    getAvailableCurrencyCodes: () => [],
    buildBackgroundPayload: () => database.getBackgroundConfig(),
    lastOwnAccountsMigrationError: null,
    process: { env: {} },
    fs
  });
  vm.runInContext(`let darkModeScheduler; ${sliceProductionSource(
    '    darkModeScheduler = createDarkModeScheduler({',
    '    markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);'
  )}`, context);
  vm.runInContext(sliceProductionSource(
    "  ipcMain.handle('app:get-info',",
    "  ipcMain.handle('settings:set-current-module',"
  ), context);

  let desktopApi;
  vm.runInNewContext(preloadSource, {
    process: { env: {} },
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld: (key, api) => { if (key === 'desktopApi') desktopApi = api; }
        }
      };
    }
  });
  return {
    desktopApi, scheduler, nativeTheme, window, app, powerMonitor, timers,
    setTime: (date) => { currentTime = date; }
  };
}

async function check(label, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`PASS ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.stack || error}`);
    console.error(`FAIL ${label}: ${error.message}`);
  }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-mode-schedule-'));
  const dbPath = path.join(tempDir, 'tool-data.sqlite');
  const imagePath = path.join(tempDir, 'background.png');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYXsAAAAASUVORK5CYII=', 'base64');
  const background = { type: 'image', color: '#e8f0fa', imagePath, imageName: 'background.png' };
  let database;
  let runtime;
  try {
    fs.writeFileSync(imagePath, imageBytes);
    database = new AppDatabase(dbPath);
    database.init();
    database.ensureUiStyleDefault();
    database.setBackgroundConfig(background);
    runtime = bootRuntime(database, tempDir, localTime(23, 0));

    await check('首次启动即使处于默认夜间时段也关闭，读取不写入默认键', async () => {
      const info = await runtime.desktopApi.app.getInfo();
      assert.deepEqual(plain(info.darkModeSchedule), DEFAULT_DARK_MODE_SCHEDULE);
      assert.equal(info.effectiveTheme, 'light');
      assert.equal(runtime.nativeTheme.themeSource, 'light');
      assert.equal(runtime.window.color, '#f9fafc');
      assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE setting_key = 'dark_mode_schedule'").get().n, 0);
    });

    await check('真实 Preload/Main 保存完整配置、推送一致快照并更新窗口底色', async () => {
      const events = [];
      const cancel = runtime.desktopApi.settings.onDarkModeScheduleChanged((snapshot) => events.push(snapshot));
      const response = await runtime.desktopApi.settings.setDarkModeSchedule(enabled);
      assert.equal(response.status, 'ok');
      assert.equal(response.effectiveTheme, 'dark');
      assert.deepEqual(plain(response.darkModeSchedule), enabled);
      assert.equal(events.length, 1);
      assert.equal(events[0].themeRevision, response.themeRevision);
      assert.equal(runtime.nativeTheme.themeSource, 'dark');
      assert.equal(runtime.window.color, '#111419');
      const raw = database.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'dark_mode_schedule'").get().setting_value;
      assert.deepEqual(JSON.parse(raw), enabled);
      const unchanged = await runtime.desktopApi.settings.setDarkModeSchedule(enabled);
      assert.equal(unchanged.themeRevision, response.themeRevision);
      assert.equal(events.length, 1);
      cancel();
      const off = await runtime.desktopApi.settings.setDarkModeSchedule({ ...enabled, enabled: false });
      assert.equal(off.effectiveTheme, 'light');
      assert.equal(events.length, 1);
      await runtime.desktopApi.settings.setDarkModeSchedule(enabled);
    });

    await check('非法配置与真实 SQLite 写入失败保持原配置、revision 和主题', async () => {
      const before = runtime.scheduler.getSnapshot();
      const invalid = await runtime.desktopApi.settings.setDarkModeSchedule({ ...enabled, endTime: enabled.startTime });
      assert.equal(invalid.status, 'failed');
      assert.match(invalid.message, /不能相同/);
      database.db.exec('PRAGMA query_only = ON');
      try {
        const failed = await runtime.desktopApi.settings.setDarkModeSchedule({ ...enabled, enabled: false });
        assert.equal(failed.status, 'failed');
        assert.ok(failed.message.length > 0);
      } finally {
        database.db.exec('PRAGMA query_only = OFF');
      }
      assert.deepEqual(runtime.scheduler.getSnapshot(), before);
      assert.deepEqual(database.getDarkModeSchedule(), enabled);
      assert.equal(runtime.nativeTheme.themeSource, 'dark');
    });

    await check('关闭再打开真实数据库恢复配置，当前时间决定启动有效主题', async () => {
      runtime.scheduler.stop();
      database.close();
      database = new AppDatabase(dbPath);
      database.init();
      runtime = bootRuntime(database, tempDir, localTime(6, 0));
      const info = await runtime.desktopApi.app.getInfo();
      assert.deepEqual(plain(info.darkModeSchedule), enabled);
      assert.equal(info.effectiveTheme, 'light');
      assert.equal(runtime.nativeTheme.themeSource, 'light');
      runtime.setTime(localTime(18, 30));
      runtime.app.emit('browser-window-focus');
      assert.equal(runtime.scheduler.getSnapshot().effectiveTheme, 'dark');
      runtime.setTime(localTime(6, 0));
      runtime.powerMonitor.emit('resume');
      assert.equal(runtime.scheduler.getSnapshot().effectiveTheme, 'light');
    });

    await check('坏 JSON 和非法历史配置只在读取时回退，不改写原记录', () => {
      const writeRaw = database.db.prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'dark_mode_schedule'");
      for (const raw of ['{broken', 'null', '[]', '{"enabled":true,"startTime":"24:00","endTime":"06:00"}']) {
        writeRaw.run(raw);
        assert.deepEqual(database.getDarkModeSchedule(), DEFAULT_DARK_MODE_SCHEDULE);
        assert.equal(database.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'dark_mode_schedule'").get().setting_value, raw);
      }
      runtime.scheduler.stop();
      runtime = bootRuntime(database, tempDir, localTime(23, 0));
      assert.equal(runtime.nativeTheme.themeSource, 'light');
    });

    await check('停用保留自定义时段，主题保存及读取不改写 Clear、背景或图片', async () => {
      const config = { enabled: false, startTime: '22:15', endTime: '07:45' };
      const result = await runtime.desktopApi.settings.setDarkModeSchedule(config);
      assert.equal(result.status, 'ok');
      assert.deepEqual(database.getDarkModeSchedule(), config);
      assert.equal(database.getUiStyle(), 'Clear');
      assert.deepEqual(database.getBackgroundConfig(), background);
      assert.deepEqual(fs.readFileSync(imagePath), imageBytes);
      runtime.scheduler.stop();
      assert.equal(runtime.timers.size, 0);
      assert.equal(runtime.app.listenerCount('browser-window-focus'), 0);
      assert.equal(runtime.powerMonitor.listenerCount('resume'), 0);
    });
  } finally {
    if (runtime) runtime.scheduler.stop();
    if (database && database.db) database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`==== ${passed}/${passed + failures.length} PASS ====`);
  if (failures.length) {
    console.error('FAILURES\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('FAILURES', error);
  process.exitCode = 1;
});
