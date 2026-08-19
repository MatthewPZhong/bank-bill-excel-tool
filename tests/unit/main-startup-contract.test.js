'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const database = fs.readFileSync(path.join(root, 'src/backend/database.js'), 'utf8');

test('完整初始化成功后才注册 IPC、建窗并等待 ready-to-show', () => {
  const readyChain = main.slice(main.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const initializeIndex = readyChain.indexOf('await initializeApplication()');
  const handlersIndex = readyChain.indexOf('registerAllIpcHandlers()');
  const windowIndex = readyChain.indexOf("await createWindow({ instrumentation: 'initial' })");
  assert.ok(initializeIndex >= 0 && handlersIndex > initializeIndex && windowIndex > handlersIndex);
  const totalStartIndex = readyChain.indexOf("finishStartupTotal = startStartupPhase('startup-total'");
  const appMarkIndex = readyChain.indexOf('markStartupMetric(STARTUP_METRIC_MARKS.appReady)');
  assert.ok(totalStartIndex >= 0 && totalStartIndex < appMarkIndex);

  const createSource = main.slice(
    main.indexOf('function createWindow(options = {})'),
    main.indexOf('function buildTemplateSummary', main.indexOf('function createWindow(options = {})'))
  );
  assert.match(createSource, /new BrowserWindow\(windowOptions\)/);
  assert.match(createSource, /waitForWindowReady\(\{[\s\S]*?mainWindow\.loadFile/);
  assert.match(createSource, /resolveReady\(mainWindow\)/);
  assert.match(createSource, /instrumentation\.startPhase\('window-ready'/);
  assert.match(createSource, /options\.instrumentation === 'initial'/);
  const readySuccess = createSource.slice(createSource.indexOf('readiness.then'));
  assert.ok(readySuccess.indexOf('showReadyWindow') >= 0);
  assert.ok(readySuccess.indexOf('settled = true') > readySuccess.indexOf('showReadyWindow'));
});

test('失败销毁隐藏窗口后只走 native failure，activate/second-instance 不旁路屏障', () => {
  assert.match(main, /function handleStartupFailure\(error\) \{[\s\S]*?mainWindow\.destroy\(\)[\s\S]*?dialog\.showErrorBox/);
  assert.match(main, /function handleStartupFailure\(error\) \{[\s\S]*?try \{[\s\S]*?getActivityLogFallbackFilePath\(\)[\s\S]*?initializeActivityLog\(\)[\s\S]*?\} catch/);
  assert.match(main, /app\.on\('activate',[\s\S]*?if \(applicationStartupComplete && BrowserWindow\.getAllWindows\(\)\.length === 0\)/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*?if \(!applicationStartupComplete \|\| !mainWindowReady\) return/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*?if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return/);
  assert.match(main, /finishStartupTotal\('success'\);[\s\S]*?reportStartupMetrics\(\)/);
});

test('startup-total 覆盖 usage 尝试，但 usage 初始化仍 warning + default 非阻塞降级', () => {
  const readyChain = main.slice(main.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const totalIndex = readyChain.indexOf("startStartupPhase('startup-total'");
  const usageTryIndex = readyChain.indexOf('usageStats = usageStatsModule.loadStats');
  const initializeIndex = readyChain.indexOf('await initializeApplication()');
  assert.ok(totalIndex >= 0 && usageTryIndex > totalIndex && initializeIndex > usageTryIndex);
  assert.match(readyChain, /message: '\[usage-stats\] init failed'[\s\S]*?usageStats = usageStatsModule\.defaultStats\(\);[\s\S]*?await initializeApplication\(\)/);
});

test('两阶段 init API 与 loading 合同已从产品全链删除', () => {
  const productSource = [main, preload, renderer].join('\n');
  for (const retired of [
    'DEFERRED_WINDOW_STARTUP',
    'initPending',
    'app:init-progress',
    'app:init-done',
    'onInitProgress',
    'onInitDone'
  ]) assert.doesNotMatch(productSource, new RegExp(retired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('SQLite 使用 exact optimize 且产品数据库初始化无无参数 ANALYZE', () => {
  assert.match(database, /this\.db\.exec\('PRAGMA optimize=0x10002;'\)/);
  assert.doesNotMatch(database, /ANALYZE\s*;/);
  assert.doesNotMatch(database, /-wal['"`][\s\S]*?(unlink|rmSync|rm\()/);
});

test('主初始化不重复执行 VCC gate，Archive post-outbox hook 是唯一启动入口', () => {
  const initialization = main.slice(
    main.indexOf('async function initializeApplication()'),
    main.indexOf('if (hasSingleInstanceLock) app.whenReady()')
  );
  assert.doesNotMatch(initialization, /syncImportArchiveLineage\(/);
  assert.equal((main.match(/postOutboxStartupHooks:\s*\[\{/g) || []).length, 1);
});
