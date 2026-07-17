'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const {
  UPDATE_STATES,
  PRODUCTION_UPDATER_CONFIG,
  AppUpdaterService,
  createAppUpdaterService,
  detectDistribution,
  isStrictStableUpgrade
} = require('../../../src/main-process/app-updater');

const STATUS_KEYS = [
  'enabled',
  'supported',
  'distribution',
  'state',
  'currentVersion',
  'targetVersion',
  'percent',
  'lastCheckedAt',
  'canRestart',
  'busyOperations',
  'error'
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.cancelCalls = 0;
    this.quitCalls = [];
    this.lastCancellationToken = null;
    this.checkImpl = async () => null;
    this.downloadImpl = async () => [];
  }

  checkForUpdates() {
    this.checkCalls += 1;
    return this.checkImpl();
  }

  downloadUpdate(cancellationToken) {
    this.downloadCalls += 1;
    this.lastCancellationToken = cancellationToken;
    return this.downloadImpl(cancellationToken);
  }

  cancelDownload() {
    this.cancelCalls += 1;
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.quitCalls.push([isSilent, isForceRunAfter]);
  }
}

function createLogger() {
  const entries = { info: [], warn: [], error: [] };
  return {
    entries,
    info(message) { entries.info.push(message); },
    warn(message) { entries.warn.push(message); },
    error(message) { entries.error.push(message); }
  };
}

function createHarness(overrides = {}) {
  const updater = overrides.updater || new FakeUpdater();
  const logger = overrides.logger || createLogger();
  const app = overrides.app || {
    isPackaged: true,
    getVersion: () => '3.0.17'
  };
  const options = {
    app,
    updater,
    logger,
    distribution: 'nsis',
    enabled: true,
    now: () => new Date('2026-07-16T12:34:56.000Z'),
    ...overrides
  };
  delete options.service;
  return {
    app,
    updater,
    logger,
    service: createAppUpdaterService(options)
  };
}

async function prepareDownloaded(service, updater) {
  updater.checkImpl = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '3.0.18' }
  });
  updater.downloadImpl = async () => ['/tmp/update.exe'];
  await service.checkForUpdatesManually();
  await service.downloadUpdate({ source: 'manual' });
}

test.describe('AppUpdaterService', () => {
  test('模块加载阶段不解析 electron-updater', () => {
    const modulePath = require.resolve('../../../src/main-process/app-updater');
    const script = [
      "const Module = require('node:module');",
      'const originalLoad = Module._load;',
      'Module._load = function guardedLoad(request) {',
      "  if (request === 'electron-updater') throw new Error('eager electron-updater load');",
      '  return originalLoad.apply(this, arguments);',
      '};',
      'require(process.argv[1]);'
    ].join('\n');

    const result = spawnSync(process.execPath, ['-e', script, modulePath], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test('CommonJS 可直接加载，初始化写入全部生产安全配置与完整状态契约', async () => {
    const { service, updater, logger } = createHarness();

    const status = await service.initialize();

    assert.ok(service instanceof AppUpdaterService);
    assert.deepEqual(Object.keys(status), STATUS_KEYS);
    assert.deepEqual(UPDATE_STATES, [
      'disabled',
      'idle',
      'checking',
      'available',
      'downloading',
      'downloaded',
      'up-to-date',
      'error'
    ]);
    assert.deepEqual(status, {
      enabled: true,
      supported: true,
      distribution: 'nsis',
      state: 'idle',
      currentVersion: '3.0.17',
      targetVersion: null,
      percent: 0,
      lastCheckedAt: null,
      canRestart: false,
      busyOperations: [],
      error: null
    });
    for (const [key, value] of Object.entries(PRODUCTION_UPDATER_CONFIG)) {
      assert.equal(updater[key], value, `${key} 应写入生产配置`);
    }
    assert.equal(updater.logger, logger, 'electron-updater 使用注入 logger');
  });

  test('NSIS 未显式传 enabled 时默认关闭，避免未来调用方意外开启更新', async () => {
    const updater = new FakeUpdater();
    const service = createAppUpdaterService({
      app: { isPackaged: true, getVersion: () => '3.0.17' },
      updater,
      distribution: 'nsis',
      logger: createLogger()
    });

    const status = await service.initialize();

    assert.equal(status.enabled, false);
    assert.equal(status.state, 'disabled');
    assert.equal(updater.checkCalls, 0);
  });

  test('开发版与 portable 发行版不加载 electron-updater，并明确标记 unsupported', async () => {
    let loaderCalls = 0;
    const updaterLoader = () => {
      loaderCalls += 1;
      throw new Error('不应加载');
    };
    const app = { isPackaged: false, getVersion: () => '3.0.17' };
    const developmentService = createAppUpdaterService({ app, updaterLoader });

    const developmentStatus = await developmentService.initialize();
    assert.equal(loaderCalls, 0);
    assert.equal(developmentStatus.distribution, 'development');
    assert.equal(developmentStatus.supported, false);
    assert.equal(developmentStatus.state, 'disabled');
    assert.equal((await developmentService.enable()).state, 'disabled');

    const portableService = createAppUpdaterService({
      app: { isPackaged: true, getVersion: () => '3.0.17' },
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Tool\\tool.exe' },
      updaterLoader
    });
    const portableStatus = await portableService.initialize();
    assert.equal(loaderCalls, 0);
    assert.equal(portableStatus.distribution, 'portable');
    assert.equal(portableStatus.supported, false);
    assert.equal(portableStatus.state, 'disabled');

    assert.equal(
      detectDistribution({ app: { isPackaged: true }, platform: 'win32', env: {} }),
      'nsis'
    );
  });

  test('初始化失败后手动检查不绕过错误状态调用残缺 updater', async () => {
    let checkCalls = 0;
    const invalidUpdater = {
      on() {},
      checkForUpdates() {
        checkCalls += 1;
      }
    };
    const service = createAppUpdaterService({
      app: { isPackaged: true, getVersion: () => '3.0.17' },
      updater: invalidUpdater,
      logger: createLogger()
    });

    let status = await service.initialize();
    assert.equal(status.state, 'error');
    assert.equal(status.error.message, '在线升级服务初始化失败');

    status = await service.checkForUpdates();
    assert.equal(checkCalls, 0);
    assert.equal(status.state, 'error');
  });

  test('初始化延迟 loader 支持 electron-updater 模块形态及 CancellationToken', async () => {
    const updater = new FakeUpdater();
    let loaderCalls = 0;
    let tokenInstances = 0;
    class FakeCancellationToken {
      constructor() {
        tokenInstances += 1;
      }
      cancel() {}
    }
    const service = createAppUpdaterService({
      app: { isPackaged: true, getVersion: () => '3.0.17' },
      distribution: 'nsis',
      updaterLoader: () => {
        loaderCalls += 1;
        return { autoUpdater: updater, CancellationToken: FakeCancellationToken };
      },
      logger: createLogger()
    });
    updater.checkImpl = async () => {
      updater.emit('update-available', { version: '3.0.18' });
      return { isUpdateAvailable: true, updateInfo: { version: '3.0.18' } };
    };

    await service.initialize();
    await service.initialize();
    await service.checkForUpdates();
    const downloadGate = deferred();
    updater.downloadImpl = () => downloadGate.promise;
    const downloadPromise = service.downloadUpdate();
    await flushMicrotasks();

    assert.equal(loaderCalls, 1, '重复 initialize 不重复加载依赖');
    assert.equal(tokenInstances, 1, '下载时才构造 CancellationToken');
    assert.ok(updater.lastCancellationToken instanceof FakeCancellationToken);

    updater.emit('update-downloaded', { version: '3.0.18' });
    downloadGate.resolve([]);
    await downloadPromise;
  });

  test('启动自动检查每次进程至多一次，重复调用共享进行中的检查且没有轮询', async () => {
    const { service, updater } = createHarness();
    const checkGate = deferred();
    updater.checkImpl = async () => {
      updater.emit('checking-for-update');
      await checkGate.promise;
      updater.emit('update-not-available', { version: '3.0.17' });
      return { isUpdateAvailable: false, updateInfo: { version: '3.0.17' } };
    };

    const first = service.checkForUpdatesOnStartup();
    const second = service.checkForUpdatesOnStartup();
    assert.equal(first, second, '并发启动检查应共享 Promise');
    await flushMicrotasks();
    assert.equal(updater.checkCalls, 1);
    assert.equal(service.getStatus().state, 'checking');

    checkGate.resolve();
    const status = await first;
    assert.equal(status.state, 'up-to-date');
    assert.equal(status.lastCheckedAt, '2026-07-16T12:34:56.000Z');

    await service.checkForUpdatesOnStartup();
    assert.equal(updater.checkCalls, 1, '检查完成后重复调用也不再请求');
  });

  test('关闭时启动检查不执行且机会被消费，手动检查仍不受开关限制', async () => {
    const { service, updater } = createHarness({ enabled: false });
    updater.checkImpl = async () => {
      updater.emit('checking-for-update');
      updater.emit('update-not-available', { version: '3.0.17' });
      return { isUpdateAvailable: false, updateInfo: { version: '3.0.17' } };
    };

    let status = await service.checkForUpdatesOnStartup();
    assert.equal(status.state, 'disabled');
    assert.equal(updater.checkCalls, 0);

    await service.enable();
    await service.checkForUpdatesOnStartup();
    assert.equal(updater.checkCalls, 0, '开启后不补跑已经消费的启动检查');

    await service.disable();
    status = await service.checkForUpdatesManually();
    assert.equal(updater.checkCalls, 1);
    assert.equal(status.enabled, false);
    assert.equal(status.state, 'up-to-date');
  });

  test('关闭使自动检查失效后，立即检查排队为新的 manual 请求且只排一次', async () => {
    const { service, updater } = createHarness();
    const firstCheck = deferred();
    const secondCheck = deferred();
    updater.checkImpl = () => (updater.checkCalls === 1 ? firstCheck.promise : secondCheck.promise);

    const automaticPromise = service.checkForUpdates('toggle');
    await flushMicrotasks();
    assert.equal(updater.checkCalls, 1);

    await service.disable();
    const firstManual = service.checkForUpdatesManually();
    const secondManual = service.checkForUpdatesManually();
    assert.equal(updater.checkCalls, 1, '旧 automatic settle 前不并发启动新检查');

    firstCheck.resolve({
      isUpdateAvailable: false,
      updateInfo: { version: '3.0.17' }
    });
    await automaticPromise;
    await flushMicrotasks();
    assert.equal(updater.checkCalls, 2, '旧检查结束后启动一条新的 manual 检查');

    secondCheck.resolve({
      isUpdateAvailable: false,
      updateInfo: { version: '3.0.17' }
    });
    const [firstStatus, secondStatus] = await Promise.all([firstManual, secondManual]);
    assert.equal(firstStatus.enabled, false);
    assert.equal(firstStatus.state, 'up-to-date');
    assert.deepEqual(secondStatus, firstStatus);
    assert.equal(updater.checkCalls, 2, '连续点击合并为一个排队 manual 请求');
  });

  test('失效检查收尾时重新开启会排队新的 toggle 检查', async () => {
    const { service, updater } = createHarness();
    const firstCheck = deferred();
    const secondCheck = deferred();
    updater.checkImpl = () => (updater.checkCalls === 1 ? firstCheck.promise : secondCheck.promise);

    const staleAutomatic = service.checkForUpdates('toggle');
    await flushMicrotasks();
    await service.disable();
    await service.enable();
    const queuedToggle = service.checkForUpdates('toggle');
    assert.equal(updater.checkCalls, 1);

    firstCheck.resolve({ isUpdateAvailable: false, updateInfo: { version: '3.0.17' } });
    await staleAutomatic;
    await flushMicrotasks();
    assert.equal(updater.checkCalls, 2, '旧检查收尾后必须真正执行重新开启触发的检查');

    secondCheck.resolve({ isUpdateAvailable: false, updateInfo: { version: '3.0.17' } });
    const status = await queuedToggle;
    assert.equal(status.enabled, true);
    assert.equal(status.state, 'up-to-date');
  });

  test('排队的 toggle 检查在再次关闭后失效', async () => {
    const { service, updater } = createHarness();
    const firstCheck = deferred();
    updater.checkImpl = () => firstCheck.promise;

    const staleAutomatic = service.checkForUpdates('toggle');
    await flushMicrotasks();
    await service.disable();
    await service.enable();
    const queuedToggle = service.checkForUpdates('toggle');
    await service.disable();

    firstCheck.resolve({ isUpdateAvailable: false, updateInfo: { version: '3.0.17' } });
    await Promise.all([staleAutomatic, queuedToggle]);

    assert.equal(updater.checkCalls, 1);
    assert.equal(service.getStatus().state, 'disabled');
  });

  test('手动检查在关闭状态可进入 available，并记录目标版本和检查时间', async () => {
    const { service, updater } = createHarness({ enabled: false });
    updater.checkImpl = async () => {
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '3.0.18' });
      return { isUpdateAvailable: true, updateInfo: { version: '3.0.18' } };
    };

    const status = await service.checkForUpdates();

    assert.equal(status.enabled, false);
    assert.equal(status.state, 'available');
    assert.equal(status.targetVersion, '3.0.18');
    assert.equal(status.lastCheckedAt, '2026-07-16T12:34:56.000Z');
  });

  test('无事件的检查结果也能回退到 available/up-to-date 状态', async () => {
    const { service, updater } = createHarness();
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    let status = await service.checkForUpdates();
    assert.equal(status.state, 'available');
    assert.equal(status.targetVersion, '3.0.18');

    updater.checkImpl = async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '3.0.17' }
    });
    status = await service.checkForUpdates();
    assert.equal(status.state, 'up-to-date');
    assert.equal(status.targetVersion, null);
  });

  test('只接受严格升版的 stable SemVer，拒绝同版、降级和预发布', async () => {
    assert.equal(isStrictStableUpgrade('3.0.17', '3.0.18'), true);
    assert.equal(isStrictStableUpgrade('3.0.17', '3.0.17'), false);
    assert.equal(isStrictStableUpgrade('3.0.17', '3.0.16'), false);
    assert.equal(isStrictStableUpgrade('3.0.17', '3.0.18-beta.1'), false);

    for (const targetVersion of ['3.0.17', '3.0.16', '3.0.18-beta.1']) {
      const { service, updater } = createHarness();
      updater.checkImpl = async () => {
        updater.emit('update-available', { version: targetVersion });
        return { isUpdateAvailable: true, updateInfo: { version: targetVersion } };
      };

      const status = await service.checkForUpdates();
      assert.equal(status.state, 'up-to-date', `${targetVersion} 不得进入 available`);
      assert.equal(status.targetVersion, null);
      assert.equal(updater.downloadCalls, 0);
    }
  });

  test('下载进度受控更新，update-downloaded 后开放 restart', async () => {
    const tokens = [];
    const { service, updater } = createHarness({
      createCancellationToken: () => {
        const token = { cancel() {} };
        tokens.push(token);
        return token;
      }
    });
    updater.checkImpl = async () => {
      updater.emit('update-available', { version: '3.0.18' });
      return { isUpdateAvailable: true, updateInfo: { version: '3.0.18' } };
    };
    await service.checkForUpdates();

    const downloadGate = deferred();
    updater.downloadImpl = async () => {
      updater.emit('download-progress', { percent: 37.5 });
      await downloadGate.promise;
      updater.emit('download-progress', { percent: 120 });
      updater.emit('update-downloaded', { version: '3.0.18' });
      return ['/tmp/update.exe'];
    };

    const downloadPromise = service.downloadUpdate();
    await flushMicrotasks();
    let status = service.getStatus();
    assert.equal(status.state, 'downloading');
    assert.equal(status.percent, 37.5);
    assert.equal(status.canRestart, false);
    assert.equal(updater.downloadCalls, 1);
    assert.equal(updater.lastCancellationToken, tokens[0]);

    downloadGate.resolve();
    status = await downloadPromise;
    assert.equal(status.state, 'downloaded');
    assert.equal(status.percent, 100, '百分比钳制到 100');
    assert.equal(status.canRestart, true);
    assert.equal(status.targetVersion, '3.0.18');
  });

  test('优先复用 checkForUpdates 返回的 CancellationToken 下载和取消', async () => {
    const checkToken = { cancelled: false, cancel() { this.cancelled = true; } };
    let fallbackTokenCalls = 0;
    const { service, updater } = createHarness({
      createCancellationToken: () => {
        fallbackTokenCalls += 1;
        return { cancel() {} };
      }
    });
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' },
      cancellationToken: checkToken
    });
    updater.downloadImpl = async () => ['/tmp/update.exe'];

    await service.checkForUpdates();
    await service.downloadUpdate();

    assert.equal(updater.lastCancellationToken, checkToken);
    assert.equal(fallbackTokenCalls, 0);
  });

  test('手动取消通过 CancellationToken 收敛回 available，不把预期取消记为 error', async () => {
    const downloadGate = deferred();
    let token;
    const { service, updater } = createHarness({
      createCancellationToken: () => {
        token = {
          cancelled: false,
          cancel() {
            this.cancelled = true;
            const error = new Error('cancelled');
            error.name = 'CancellationError';
            downloadGate.reject(error);
          }
        };
        return token;
      }
    });
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    updater.downloadImpl = () => downloadGate.promise;
    await service.checkForUpdates();

    const downloadPromise = service.downloadUpdate();
    await flushMicrotasks();
    assert.equal(await service.cancelDownload(), true);
    const status = await downloadPromise;

    assert.equal(token.cancelled, true);
    assert.equal(status.state, 'available');
    assert.equal(status.percent, 0);
    assert.equal(status.error, null);

    updater.emit('download-progress', { percent: 88 });
    updater.emit('update-downloaded', { version: '3.0.18' });
    assert.equal(service.getStatus().state, 'available', '取消后的迟到完成事件必须忽略');
    assert.equal(service.getStatus().percent, 0, '取消后的迟到进度事件必须忽略');
    assert.equal(service.getStatus().canRestart, false);
  });

  test('关闭会取消进行中的自动下载并保持 disabled，迟到完成结果不能覆盖状态', async () => {
    const downloadGate = deferred();
    let cancelCalls = 0;
    const { service, updater } = createHarness({
      createCancellationToken: () => ({
        cancel() {
          cancelCalls += 1;
          const error = new Error('cancelled');
          error.code = 'ERR_CANCELLED';
          downloadGate.reject(error);
        }
      })
    });
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    updater.downloadImpl = () => downloadGate.promise;
    await service.checkForUpdates();

    const downloadPromise = service.downloadUpdate({ source: 'automatic' });
    await flushMicrotasks();
    const disabledStatus = await service.disable();
    await downloadPromise;
    await service.enable();
    updater.emit('download-progress', { percent: 99 });
    updater.emit('update-downloaded', { version: '3.0.18' });

    assert.equal(cancelCalls, 1);
    assert.equal(disabledStatus.enabled, false);
    assert.equal(disabledStatus.state, 'disabled');
    assert.equal(service.getStatus().state, 'idle', '重开后迟到下载事件不能恢复 downloading/downloaded');
    assert.equal(service.getStatus().percent, 0);
    assert.equal(service.getStatus().canRestart, false);
  });

  test('自动下载完成后关闭开关会隐藏旧安装动作，重新开启回到 idle', async () => {
    const { service, updater } = createHarness();
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    updater.downloadImpl = async () => ['/tmp/update.exe'];

    await service.checkForUpdates('toggle');
    let status = await service.downloadUpdate({ source: 'automatic' });
    assert.equal(status.state, 'downloaded');
    assert.equal(status.canRestart, true);

    status = await service.disable();
    assert.equal(status.enabled, false);
    assert.equal(status.state, 'disabled');
    assert.equal(status.canRestart, false);

    status = await service.enable();
    assert.equal(status.state, 'idle');
    assert.equal(status.canRestart, false);
  });

  test('关闭自动更新不取消用户手动触发的下载', async () => {
    const downloadGate = deferred();
    let cancelCalls = 0;
    const { service, updater } = createHarness({
      createCancellationToken: () => ({ cancel() { cancelCalls += 1; } })
    });
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    updater.downloadImpl = async () => {
      await downloadGate.promise;
      updater.emit('update-downloaded', { version: '3.0.18' });
      return ['/tmp/update.exe'];
    };
    await service.checkForUpdatesManually();

    const downloadPromise = service.downloadUpdate({ source: 'manual' });
    await flushMicrotasks();
    const disabledStatus = await service.disable();

    assert.equal(cancelCalls, 0);
    assert.equal(disabledStatus.enabled, false);
    assert.equal(disabledStatus.state, 'downloading');

    downloadGate.resolve();
    const downloadedStatus = await downloadPromise;
    assert.equal(downloadedStatus.enabled, false);
    assert.equal(downloadedStatus.state, 'downloaded');
    assert.equal(downloadedStatus.canRestart, true);
  });

  test('关闭后尚未开始的自动下载不会启动', async () => {
    const { service, updater } = createHarness();
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    await service.checkForUpdates('toggle');
    await service.disable();

    const status = await service.downloadUpdate({ source: 'automatic' });

    assert.equal(status.state, 'disabled');
    assert.equal(updater.downloadCalls, 0);
  });

  test('没有 CancellationToken 时可回退 fake updater.cancelDownload', async () => {
    const downloadGate = deferred();
    const { service, updater } = createHarness();
    updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    updater.downloadImpl = () => downloadGate.promise;
    updater.cancelDownload = () => {
      updater.cancelCalls += 1;
      const error = new Error('canceled');
      error.name = 'CancellationError';
      downloadGate.reject(error);
    };
    await service.checkForUpdates();

    const downloadPromise = service.downloadUpdate();
    await flushMicrotasks();
    await service.cancelDownload();
    await downloadPromise;

    assert.equal(updater.cancelCalls, 1);
    assert.equal(service.getStatus().state, 'available');
  });

  test('自动下载失败保留开关并返回错误状态，手动下载失败继续 reject', async () => {
    const automaticHarness = createHarness();
    automaticHarness.updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    automaticHarness.updater.downloadImpl = async () => { throw new Error('自动下载网络失败'); };
    await automaticHarness.service.checkForUpdates('toggle');

    const automaticStatus = await automaticHarness.service.downloadUpdate({ source: 'automatic' });
    assert.equal(automaticStatus.enabled, true);
    assert.equal(automaticStatus.state, 'error');
    assert.equal(automaticStatus.error.message, '下载失败，请稍后重试');

    const manualHarness = createHarness({ enabled: false });
    manualHarness.updater.checkImpl = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });
    const manualFailure = new Error('手动下载网络失败');
    manualHarness.updater.downloadImpl = async () => { throw manualFailure; };
    await manualHarness.service.checkForUpdatesManually();

    await assert.rejects(
      () => manualHarness.service.downloadUpdate({ source: 'manual' }),
      manualFailure
    );
    assert.equal(manualHarness.service.getStatus().state, 'error');
  });

  test('手动检查失败只向状态暴露脱敏错误，原始原因写日志并保留 reject', async () => {
    const { service, updater, logger } = createHarness();
    const failure = new Error('网络不可达');
    failure.code = 'ENETDOWN';
    updater.checkImpl = async () => { throw failure; };

    await assert.rejects(() => service.checkForUpdates(), failure);
    const status = service.getStatus();

    assert.equal(status.state, 'error');
    assert.deepEqual(status.error, { code: 'ENETDOWN', message: '检查失败，请稍后重试' });
    assert.equal(status.lastCheckedAt, '2026-07-16T12:34:56.000Z');
    assert.equal(logger.entries.error.length, 1);
    assert.match(logger.entries.error[0], /检查失败/);
    assert.match(logger.entries.error[0], /网络不可达/);
  });

  test('启动后台检查失败只写日志，不把错误状态广播给设置页', async () => {
    const { service, updater, logger } = createHarness();
    const failure = new Error('C:\\Users\\alice\\secret\\latest.yml 不可读');
    failure.code = 'ENOENT';
    updater.checkImpl = async () => { throw failure; };

    const status = await service.checkForUpdatesOnStartup();

    assert.equal(status.state, 'idle');
    assert.equal(status.error, null);
    assert.equal(status.lastCheckedAt, '2026-07-16T12:34:56.000Z');
    assert.equal(logger.entries.error.length, 1);
    assert.match(logger.entries.error[0], /secret/);
  });

  test('并发 manual 加入 startup 检查时保留 startup 来源', async () => {
    const gate = deferred();
    const { service, updater } = createHarness();
    updater.checkImpl = () => gate.promise;

    const startup = service.checkForUpdatesOnStartup();
    await flushMicrotasks();
    const manual = service.checkForUpdatesManually();
    gate.resolve({
      isUpdateAvailable: true,
      updateInfo: { version: '3.0.18' }
    });

    const [startupStatus, manualStatus] = await Promise.all([startup, manual]);
    assert.equal(updater.checkCalls, 1);
    assert.equal(startupStatus.state, 'available');
    assert.deepEqual(manualStatus, startupStatus);
    assert.equal(service.getLastCompletedCheckKind(), 'startup');
  });

  test('状态订阅立即给快照，退订后不再接收且外部修改不污染内部状态', async () => {
    const { service, updater } = createHarness();
    const snapshots = [];
    const unsubscribe = service.subscribe((status) => snapshots.push(status));
    snapshots[0].busyOperations.push('外部污染');
    updater.checkImpl = async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '3.0.17' }
    });

    await service.checkForUpdates();
    assert.ok(snapshots.length >= 2);
    assert.deepEqual(service.getStatus().busyOperations, []);
    const countBeforeUnsubscribe = snapshots.length;
    unsubscribe();
    await service.disable();
    assert.equal(snapshots.length, countBeforeUnsubscribe);
  });

  test('无活跃操作时迟到的 updater 事件只记录错误，不改写已完成状态', async () => {
    const { service, updater, logger } = createHarness();
    updater.checkImpl = async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '3.0.17' }
    });
    const completed = await service.checkForUpdatesManually();

    updater.emit('update-available', { version: '9.9.9' });
    updater.emit('download-progress', { percent: 100 });
    updater.emit('update-downloaded', { version: '9.9.9' });
    updater.emit('error', new Error('旧请求迟到错误'));

    assert.deepEqual(service.getStatus(), completed);
    assert.equal(logger.entries.error.length, 1);
    assert.match(logger.entries.error[0], /忽略未关联/);
  });

  test('restartAndInstall 先执行业务忙检查，忙时不清理也不退出', async () => {
    let cleanupCalls = 0;
    let transitionCancelCalls = 0;
    const callbacks = {
      getBusyOperations: async () => ['银行账单正在导出'],
      cleanupBeforeRestart: async () => { cleanupCalls += 1; },
      cancelInstallTransition: async () => { transitionCancelCalls += 1; }
    };
    const { service, updater } = createHarness({ callbacks });
    await prepareDownloaded(service, updater);

    const result = await service.restartAndInstall();

    assert.equal(result.restarted, false);
    assert.equal(result.reason, 'busy');
    assert.deepEqual(result.busyOperations, ['银行账单正在导出']);
    assert.equal(cleanupCalls, 0);
    assert.equal(transitionCancelCalls, 1);
    assert.deepEqual(updater.quitCalls, []);
    assert.equal(result.status.state, 'downloaded');
    assert.equal(result.status.canRestart, true);
  });

  test('restartAndInstall 安装闸门合并并发调用，退出清理和 quitAndInstall 均只执行一次', async () => {
    const cleanupGate = deferred();
    let busyChecks = 0;
    let cleanupCalls = 0;
    let transitionCancelCalls = 0;
    const callbacks = {
      getBusyOperations: async () => {
        busyChecks += 1;
        return [];
      },
      cleanupBeforeRestart: async () => {
        cleanupCalls += 1;
        await cleanupGate.promise;
      },
      cancelInstallTransition: async () => { transitionCancelCalls += 1; }
    };
    const { service, updater } = createHarness({ callbacks });
    await prepareDownloaded(service, updater);

    const first = service.restartAndInstall();
    const second = service.restartAndInstall();
    assert.equal(first, second, '安装闸门返回同一个 Promise');
    await flushMicrotasks();
    assert.equal(busyChecks, 1);
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(updater.quitCalls, []);

    cleanupGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.restarted, true);
    assert.deepEqual(secondResult, firstResult);
    assert.deepEqual(updater.quitCalls, [[true, true]]);
    assert.equal(transitionCancelCalls, 0, '成功交给安装器后不释放主进程过渡闸门');

    const third = service.restartAndInstall();
    assert.equal(third, first, '成功交给安装器后服务安装闸门持续锁定');
    await third;
    assert.deepEqual(updater.quitCalls, [[true, true]], '进程退出前不得二次调用安装器');
  });

  test('退出清理失败时不调用安装器，保留 canRestart 供修复后重试', async () => {
    const failure = new Error('退出清理失败');
    let transitionCancelCalls = 0;
    let resumeCalls = 0;
    const callbacks = {
      getBusyOperations: () => [],
      cleanupBeforeRestart: async () => { throw failure; },
      resumeAfterFailedRestart: async () => { resumeCalls += 1; },
      cancelInstallTransition: async () => { transitionCancelCalls += 1; }
    };
    const { service, updater } = createHarness({ callbacks });
    await prepareDownloaded(service, updater);

    await assert.rejects(() => service.restartAndInstall(), failure);
    const status = service.getStatus();

    assert.equal(status.state, 'downloaded');
    assert.equal(status.canRestart, true);
    assert.equal(resumeCalls, 0, '清理未完成时没有需要恢复的已清理状态');
    assert.equal(transitionCancelCalls, 1);
    assert.deepEqual(updater.quitCalls, []);
    assert.equal(status.error.message, '重启升级失败，请稍后重试');
  });

  test('quitAndInstall 抛错时释放主进程过渡闸门并保留重试能力', async () => {
    const failure = new Error('安装器启动失败');
    let transitionCancelCalls = 0;
    let resumeCalls = 0;
    const callbacks = {
      getBusyOperations: () => [],
      cleanupBeforeRestart: async () => {},
      resumeAfterFailedRestart: async () => { resumeCalls += 1; },
      cancelInstallTransition: async () => { transitionCancelCalls += 1; }
    };
    const { service, updater } = createHarness({ callbacks });
    updater.quitAndInstall = () => { throw failure; };
    await prepareDownloaded(service, updater);

    await assert.rejects(() => service.restartAndInstall(), failure);
    const status = service.getStatus();

    assert.equal(transitionCancelCalls, 1);
    assert.equal(resumeCalls, 1, '清理完成但安装器未启动时恢复应用运行态');
    assert.equal(status.state, 'downloaded');
    assert.equal(status.canRestart, true);
    assert.equal(status.error.message, '重启升级失败，请稍后重试');
  });
});
