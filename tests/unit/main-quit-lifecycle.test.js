'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const espree = require('espree');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
const declaration = espree.parse(source, { ecmaVersion: 'latest', range: true }).body
  .find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'prepareApplicationForQuit');
assert.ok(declaration, '必须执行生产退出函数');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  const events = [];
  const context = vm.createContext({
    setTimeout, clearTimeout,
    quitPreparationComplete: false, quitPreparationPromise: null,
    appUpdateTransitionToken: null, quitPreparationPreviousLastClosedAt: null,
    businessOperationRegistry: {
      beginShutdownTransition() { events.push('transition'); return { acquired: true, token: 'quit-token' }; },
      async waitForIdle() { events.push('business-idle'); },
      releaseTransition(token) { events.push(`release:${token}`); }
    },
    appendActivityLogEntry() {},
    async shutdownBackgroundExecutionRuntimeGracefully() { events.push('runtime-closed'); },
    needsWorkerShutdown: () => false,
    archiveOperationTail: Promise.resolve(),
    listPendingCleanupRunsForQuit: () => [],
    positionReconciliationService: null, vccFinancialOpService: null,
    usageStats: null,
    flushUsageStatsForQuit() { events.push('usage-flushed'); },
    backgroundExecutionRuntimeManager: { resume() { events.push('runtime-resumed'); } },
    releaseAppUpdateTransition() { events.push('updater-released'); },
    ...overrides
  });
  vm.runInContext(source.slice(...declaration.range), context);
  return { context, events };
}

test('生产退出等待完整存档排空；重复调用复用同一清理且不提前报成功', async () => {
  const archive = deferred();
  const { context, events } = harness({ archiveOperationTail: archive.promise });
  const first = context.prepareApplicationForQuit();
  const second = context.prepareApplicationForQuit();
  const settled = Promise.allSettled([first, second]);
  let done = false;
  settled.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const completedBeforeDrain = done;
  archive.resolve();
  const results = await settled;
  assert.equal(completedBeforeDrain, false);
  assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results));
  assert.deepEqual(events, ['transition', 'business-idle', 'runtime-closed', 'usage-flushed']);
  assert.equal(context.quitPreparationComplete, true);
});

test('runtime clean 之后清理失败，保留原错误并恢复 runtime、释放 gate 后允许重试', async () => {
  const failure = new Error('统计落盘失败');
  const { context, events } = harness({ flushUsageStatsForQuit() { throw failure; } });
  await assert.rejects(context.prepareApplicationForQuit(), (error) => error === failure);
  assert.equal(context.quitPreparationComplete, false);
  assert.equal(context.quitPreparationPromise, null);
  assert.deepEqual(events, ['transition', 'business-idle', 'runtime-closed', 'runtime-resumed', 'release:quit-token']);
  context.flushUsageStatsForQuit = () => {};
  await context.prepareApplicationForQuit();
  assert.equal(context.quitPreparationComplete, true);
});

test('runtime 关闭失败时不误调用 resume，仍释放本次 gate 并传播原错误', async () => {
  const failure = new Error('载体未关闭');
  const { context, events } = harness({ async shutdownBackgroundExecutionRuntimeGracefully() { throw failure; } });
  await assert.rejects(context.prepareApplicationForQuit(), (error) => error === failure);
  assert.deepEqual(events, ['transition', 'business-idle', 'release:quit-token']);
  assert.equal(context.quitPreparationPromise, null);
});

test('升级退出失败只释放持有的 updater token；非法 token 不开始清理', async () => {
  const failure = new Error('关闭失败');
  const { context, events } = harness({ appUpdateTransitionToken: 'updater-token',
    async shutdownBackgroundExecutionRuntimeGracefully() { throw failure; } });
  await assert.rejects(context.prepareApplicationForQuit({ transitionOwner: 'app-updater', transitionToken: 'wrong' }),
    { code: 'APP_UPDATE_TRANSITION_TOKEN_MISMATCH' });
  assert.deepEqual(events, []);
  assert.equal(context.quitPreparationPromise, null);
  await assert.rejects(context.prepareApplicationForQuit({ transitionOwner: 'app-updater', transitionToken: 'updater-token' }),
    (error) => error === failure);
  assert.deepEqual(events, ['business-idle', 'updater-released']);
});
