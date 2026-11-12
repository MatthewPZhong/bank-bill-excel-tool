'use strict';

// 用户活动上报须在 window 捕获阶段监听：弹窗在 document 捕获阶段拦截 Tab/Escape 时仍能上报，
// 空闲存储整理据此立即中止（执行生产函数，事件派发按 DOM 捕获顺序模拟）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const espree = require('espree');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer.js'), 'utf8');
const declaration = espree.parse(source, { ecmaVersion: 'latest', range: true }).body
  .find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'setupUserActivityReporter');
assert.ok(declaration, '必须执行生产函数 setupUserActivityReporter');

function dispatchThroughModal(windowListeners, type) {
  // DOM 捕获顺序：window(capture) → document(capture，弹窗在此 stopPropagation) → … → window(bubble)。
  const event = { type, stopped: false, stopPropagation() { this.stopped = true; } };
  for (const entry of windowListeners.filter((item) => item.type === type && item.capture)) entry.listener(event);
  event.stopPropagation(); // 弹窗在 document 捕获阶段拦截 Tab/Escape（modal-host.js）。
  if (!event.stopped) {
    for (const entry of windowListeners.filter((item) => item.type === type && !item.capture)) entry.listener(event);
  }
}

test('弹窗拦截键盘事件时，用户活动仍在 window 捕获阶段上报', () => {
  const windowListeners = [];
  let reports = 0;
  const context = vm.createContext({
    Date,
    USER_ACTIVITY_REPORT_INTERVAL_MS: 10 * 1000,
    lastUserActivityReportTs: 0,
    shellAbort: { signal: {} },
    window: {
      desktopApi: { app: { reportUserActivity() { reports += 1; } } },
      addEventListener(type, listener, options = {}) {
        windowListeners.push({ type, listener, capture: options === true || options.capture === true });
      }
    }
  });
  vm.runInContext(source.slice(...declaration.range), context);
  context.setupUserActivityReporter();
  assert.deepEqual(
    windowListeners.map((item) => [item.type, item.capture]),
    ['mousemove', 'keydown', 'click', 'wheel', 'touchstart'].map((type) => [type, true])
  );
  dispatchThroughModal(windowListeners, 'keydown');
  assert.equal(reports, 1);
});
