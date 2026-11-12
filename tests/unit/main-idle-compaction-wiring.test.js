'use strict';

// 空闲存储整理在 main.js 中的接入：空闲定时器与主窗口关闭入口（执行生产函数，依赖用桩替换）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const espree = require('espree');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
const declarations = espree.parse(source, { ecmaVersion: 'latest', range: true }).body
  .filter((node) => node.type === 'FunctionDeclaration');

function productionFunction(name) {
  const declaration = declarations.find((node) => node.id.name === name);
  assert.ok(declaration, `必须执行生产函数 ${name}`);
  return source.slice(...declaration.range);
}

const MINUTE = 60 * 1000;

function idleTimerHarness({ acquiringThresholdMinutes, idleMinutes, accepted = true }) {
  const events = [];
  let tick = null;
  const context = vm.createContext({
    idleCleanupTimer: null,
    IDLE_CLEANUP_MS: 30 * MINUTE,
    IDLE_CHECK_INTERVAL_MS: 2 * MINUTE,
    RUN_CHECK_WORKER_GRACE_MS: 30000,
    lastUserActivityTs: Date.now() - idleMinutes * MINUTE,
    runCheckWorkerPool: null,
    database: { getAcquiringBillRawJsonRetentionDays: () => 7, db: {} },
    loadIdleCleanupMsFromSettings() { context.IDLE_CLEANUP_MS = acquiringThresholdMinutes * MINUTE; },
    setInterval(callback) { tick = callback; return { unref() {} }; },
    observeBackgroundMemoryActivity: (work) => work,
    businessOperationRegistry: {
      begin() { events.push('acquiring-begin'); return accepted ? { accepted: true, token: 1 } : { accepted: false }; },
      end() { events.push('acquiring-end'); }
    },
    async triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded() { events.push('acquiring-cleanup'); },
    clearStaleSuccessfulRawJson: () => ({ clearedCount: 0, elapsedMs: 0 }),
    appendActivityLogEntry() {},
    idleDatabaseCompaction: { async maybeRun() { events.push('compaction-check'); } }
  });
  vm.runInContext(productionFunction('setupIdleCleanupTimer'), context);
  context.setupIdleCleanupTimer();
  assert.equal(typeof tick, 'function');
  return { tick, events };
}

test('收单清理阈值设为 60 分钟、空闲 31 分钟：收单清理不跑，主库整理检查仍执行', async () => {
  const { tick, events } = idleTimerHarness({ acquiringThresholdMinutes: 60, idleMinutes: 31 });
  await tick();
  assert.deepEqual(events, ['acquiring-begin', 'acquiring-end', 'compaction-check']);
});

test('收单清理达到阈值时先完成并结束登记，再检查主库整理', async () => {
  const { tick, events } = idleTimerHarness({ acquiringThresholdMinutes: 30, idleMinutes: 31 });
  await tick();
  assert.deepEqual(events, ['acquiring-begin', 'acquiring-cleanup', 'acquiring-end', 'compaction-check']);
});

test('收单清理未获登记（其他任务进行中）时仍交给主库整理自行判断', async () => {
  const { tick, events } = idleTimerHarness({ acquiringThresholdMinutes: 30, idleMinutes: 31, accepted: false });
  await tick();
  assert.deepEqual(events, ['acquiring-begin', 'compaction-check']);
});

function closeHarness({ compactionRunning = false, installTransition = false, quitPrepared = false, destroyed = false } = {}) {
  const events = [];
  let finishStop;
  const window = {
    isDestroyed: () => destroyed,
    close() { events.push('window-close'); }
  };
  const context = vm.createContext({
    quitPreparationComplete: quitPrepared,
    mainWindow: window,
    idleDatabaseCompaction: {
      isRunning: () => compactionRunning,
      stop(reason) {
        events.push(`stop:${reason}`);
        return new Promise((resolve) => { finishStop = resolve; });
      }
    },
    businessOperationRegistry: { isInstallTransitionActive: () => installTransition || compactionRunning }
  });
  vm.runInContext(productionFunction('handleMainWindowClose'), context);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  return { context, event, events, finish: () => finishStop() };
}

test('整理进行中关闭主窗口：先阻止关闭并中止整理，收尾后重新关闭窗口', async () => {
  const harness = closeHarness({ compactionRunning: true });
  harness.context.handleMainWindowClose(harness.event);
  assert.equal(harness.event.prevented, true);
  assert.deepEqual(harness.events, ['stop:window-close']);
  harness.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events, ['stop:window-close', 'window-close']);
});

test('整理收尾前窗口已销毁时不再重复关闭', async () => {
  const harness = closeHarness({ compactionRunning: true, destroyed: true });
  harness.context.handleMainWindowClose(harness.event);
  harness.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events, ['stop:window-close']);
});

test('升级准备期间仍阻止关闭；退出准备完成或无租约时放行', () => {
  const install = closeHarness({ installTransition: true });
  install.context.handleMainWindowClose(install.event);
  assert.equal(install.event.prevented, true);
  assert.deepEqual(install.events, []);

  const prepared = closeHarness({ compactionRunning: true, quitPrepared: true });
  prepared.context.handleMainWindowClose(prepared.event);
  assert.equal(prepared.event.prevented, false);
  assert.deepEqual(prepared.events, []);

  const idle = closeHarness();
  idle.context.handleMainWindowClose(idle.event);
  assert.equal(idle.event.prevented, false);
});
