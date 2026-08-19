'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createWindowInstrumentation,
  showReadyWindow,
  shouldAcceptInitialRendererMetrics,
  waitForWindowReady
} = require('../../../src/main-process/startup-window');

function fakeWindow() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  return window;
}

function assertNoReadinessListeners(window) {
  assert.equal(window.listenerCount('ready-to-show'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  assert.equal(window.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(window.webContents.listenerCount('did-fail-load'), 0);
}

test('load 与 ready-to-show 都完成后才 resolve 并清理 listener/timer', async () => {
  const window = fakeWindow();
  let resolveLoad;
  const load = new Promise((resolve) => { resolveLoad = resolve; });
  let settled = false;
  const waiting = waitForWindowReady({ window, load: () => load, timeoutMs: 1000 })
    .then(() => { settled = true; });
  window.emit('ready-to-show');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveLoad();
  await waiting;
  assert.equal(settled, true);
  assertNoReadinessListeners(window);
});

for (const scenario of [
  ['closed', (window) => window.emit('closed'), 'STARTUP_WINDOW_CLOSED'],
  ['renderer gone', (window) => window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }), 'STARTUP_RENDERER_GONE'],
  ['main-frame load failure', (window) => window.webContents.emit('did-fail-load', {}, -2, 'failed', '', true), 'STARTUP_WINDOW_LOAD_FAILED']
]) {
  test(`${scenario[0]} 在 ready 前 fail-closed 并清理 listener`, async () => {
    const window = fakeWindow();
    const waiting = waitForWindowReady({ window, load: () => new Promise(() => {}), timeoutMs: 1000 });
    scenario[1](window);
    await assert.rejects(waiting, (error) => error.code === scenario[2]);
    assertNoReadinessListeners(window);
  });
}

test('sub-frame did-fail-load 不阻断，合理 timeout 会 reject 且清理', async () => {
  const window = fakeWindow();
  const waiting = waitForWindowReady({ window, load: async () => {}, timeoutMs: 10 });
  window.webContents.emit('did-fail-load', {}, -2, 'subframe', '', false);
  await assert.rejects(waiting, (error) => error.code === 'STARTUP_WINDOW_READY_TIMEOUT');
  assertNoReadinessListeners(window);
});

test('supplemental instrumentation 不写首次 startup mark/phase', () => {
  const calls = [];
  const disabled = createWindowInstrumentation({
    enabled: false,
    mark: (value) => calls.push(value),
    startPhase: (value) => { calls.push(value); return () => {}; }
  });
  disabled.mark('window-created');
  disabled.startPhase('window-ready')('success');
  assert.deepEqual(calls, []);
});

test('renderer metrics 只接受首次窗口且不可被补窗覆盖', () => {
  assert.equal(shouldAcceptInitialRendererMetrics({
    senderId: 17,
    initialWebContentsId: 17,
    hasExistingMetrics: false
  }), true);
  assert.equal(shouldAcceptInitialRendererMetrics({
    senderId: 18,
    initialWebContentsId: 17,
    hasExistingMetrics: false
  }), false);
  assert.equal(shouldAcceptInitialRendererMetrics({
    senderId: 17,
    initialWebContentsId: 17,
    hasExistingMetrics: true
  }), false);
});

test('show 抛错会向调用方传播且不发送窗口状态', () => {
  const expected = new Error('native show failed');
  let stateSent = false;
  assert.throws(() => showReadyWindow({
    window: { show() { throw expected; } },
    sendWindowState() { stateSent = true; }
  }), (error) => error === expected);
  assert.equal(stateSent, false);
});
