'use strict';

// 空闲存储整理与 v3.2.18 链接表过期清理在 main.js 中的接入：空闲定时器与主窗口关闭入口（执行生产函数，依赖用桩替换）。
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

// v3.2.20：收单单据币种校验下线，原「收单空闲清理先于主库整理」随之删除；空闲定时器先做链接表过期清理，再交给主库整理自行判断。
function idleTimerHarness({ compactionError = null } = {}) {
  const events = [];
  let tick = null;
  const context = vm.createContext({
    idleCleanupTimer: null,
    IDLE_CHECK_INTERVAL_MS: 2 * MINUTE,
    setInterval(callback) { tick = callback; return { unref() { events.push('unref'); } }; },
    observeBackgroundMemoryActivity: (work) => work,
    idleLinkedTableRetention: { async maybeRun() { events.push('retention-check'); } },
    idleDatabaseCompaction: {
      async maybeRun() {
        events.push('compaction-check');
        if (compactionError) throw compactionError;
      }
    }
  });
  vm.runInContext(productionFunction('setupIdleCleanupTimer'), context);
  context.setupIdleCleanupTimer();
  context.setupIdleCleanupTimer();
  assert.equal(typeof tick, 'function');
  return { tick, events };
}

test('空闲定时器只建一次，每次触发先做链接表过期清理，再交给主库整理自行判断', async () => {
  const { tick, events } = idleTimerHarness();
  assert.deepEqual(events, ['unref'], '重复调用不重复建定时器');
  await tick();
  await tick();
  assert.deepEqual(events, ['unref', 'retention-check', 'compaction-check', 'retention-check', 'compaction-check']);
});

test('主库整理检查抛错不逃出定时器回调', async () => {
  const { tick, events } = idleTimerHarness({ compactionError: new Error('整理失败') });
  await tick();
  assert.deepEqual(events, ['unref', 'retention-check', 'compaction-check']);
});

function closeHarness({
  compactionRunning = false,
  retentionRunning = false,
  installTransition = false,
  quitPrepared = false,
  destroyed = false
} = {}) {
  const events = [];
  let finishStop;
  const window = {
    isDestroyed: () => destroyed,
    close() { events.push('window-close'); }
  };
  const context = vm.createContext({
    quitPreparationComplete: quitPrepared,
    mainWindow: window,
    idleLinkedTableRetention: {
      isRunning: () => retentionRunning,
      stop(reason) {
        events.push(`retention-stop:${reason}`);
        return Promise.resolve();
      }
    },
    idleDatabaseCompaction: {
      isRunning: () => compactionRunning,
      stop(reason) {
        events.push(`stop:${reason}`);
        return new Promise((resolve) => { finishStop = resolve; });
      }
    },
    businessOperationRegistry: {
      isInstallTransitionActive: () => installTransition || compactionRunning || retentionRunning
    }
  });
  vm.runInContext(productionFunction('handleMainWindowClose'), context);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  return { context, event, events, finish: () => finishStop() };
}

test('整理进行中关闭主窗口：先阻止关闭并中止整理，收尾后重新关闭窗口', async () => {
  const harness = closeHarness({ compactionRunning: true });
  harness.context.handleMainWindowClose(harness.event);
  assert.equal(harness.event.prevented, true);
  assert.deepEqual(harness.events, ['retention-stop:window-close', 'stop:window-close']);
  harness.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events, ['retention-stop:window-close', 'stop:window-close', 'window-close']);
});

test('链接表过期清理进行中关闭主窗口：同样先中止并等两者收尾，再重新关闭窗口', async () => {
  const harness = closeHarness({ retentionRunning: true });
  harness.context.handleMainWindowClose(harness.event);
  assert.equal(harness.event.prevented, true);
  assert.deepEqual(harness.events, ['retention-stop:window-close', 'stop:window-close']);
  harness.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events, ['retention-stop:window-close', 'stop:window-close', 'window-close']);
});

test('整理收尾前窗口已销毁时不再重复关闭', async () => {
  const harness = closeHarness({ compactionRunning: true, destroyed: true });
  harness.context.handleMainWindowClose(harness.event);
  harness.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.events, ['retention-stop:window-close', 'stop:window-close']);
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

test('整理准入：银行对账单锁忙时判为忙（收单相关忙检查随模块下线删除）', () => {
  const reasonWith = (overrides) => {
    const context = vm.createContext({ bankStatementOperationLock: { inFlight: false }, ...overrides });
    vm.runInContext(productionFunction('idleCompactionBusyReason'), context);
    return context.idleCompactionBusyReason();
  };
  assert.equal(reasonWith({}), '');
  assert.equal(reasonWith({ bankStatementOperationLock: { inFlight: true } }), 'bank-statement-operation-busy');
});

test('整理控制器接入生产准入函数', () => {
  assert.match(source, /isOtherWorkBusy: \(\) => idleCompactionBusyReason\(\)/);
});

test('链接表过期清理控制器与整理同准入，持银行对账锁，并在用户活动时中止', () => {
  const block = source.slice(
    source.indexOf('const idleLinkedTableRetention = createIdleLinkedTableRetentionController({'),
    source.indexOf('const taskPolicyRegistry = createTaskPolicyRegistry();')
  );
  assert.match(block, /isOtherWorkBusy: \(\) => idleCompactionBusyReason\(\)/);
  assert.match(block, /acquireLock: \(\) => tryAcquireBankStatementOpLock\('linked-retention'\)/);
  assert.match(block, /releaseLock: \(\) => releaseBankStatementOpLock\(\)/);
  assert.match(block, /deleteExpired: \(range\) => deleteLinkedTableRowsByDateRange\(linkedTableDeleteDeps\(\), range\)/);
  const activity = source.slice(source.indexOf("ipcMain.on('app:user-activity'"));
  assert.match(activity.slice(0, 400), /idleLinkedTableRetention\.abort\('user-activity'\)/);
});
