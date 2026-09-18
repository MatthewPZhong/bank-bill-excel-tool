'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the whole renderer and its real click handler; only the DOM and IPC boundary are synthetic.
function harness(initial) {
  const doc = { activeElement: null };
  function element(tag) {
    const item = {
      tag, children: [], dataset: {}, hidden: false, disabled: false, textContent: '',
      isConnected: true, parent: null, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      append(...children) {
        for (const child of children) {
          if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
          child.parent = this; this.children.push(child);
        }
      },
      querySelectorAll(selector) {
        const matches = selector.split(',');
        return this.children.flatMap((child) => [
          ...(matches.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)
        ]);
      },
      focus() { doc.activeElement = this; },
      click() { if (!this.disabled && !this.hidden) this.listeners.click?.(); }
    };
    return item;
  }
  doc.createElement = element; doc.body = element('body');
  const panel = element('section'); const legacyPanel = element('section');
  let state = initial; let retries = 0; let retryWork = async () => ({ ready: true });
  const window = { document: doc, crypto: { randomUUID: () => 'request' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/renderer-biz-op-v327.js'), 'utf8'), { window });
  const controller = window.createBizOpV327Controller({
    api: { status: async () => state, retryRecovery: () => { retries += 1; return retryWork(); } },
    panel, legacyPanel, restoreLegacy() {}, document: doc
  });
  const buttons = panel.querySelectorAll('button');
  const retry = buttons.find((button) => button.textContent === '重试恢复');
  const business = buttons.filter((button) => ['导入文件', '开始运行', '导出校验结果表', '数据管理'].includes(button.textContent));
  const status = panel.querySelectorAll('span').find((span) => span.className === 'status-box-text');
  return {
    controller, retry, business, status,
    setState(value) { state = value; }, setRetry(work) { retryWork = work; },
    get retries() { return retries; },
    async clickRetry() { retry.click(); await new Promise((resolve) => setImmediate(resolve)); }
  };
}

test('历史存档待检查时业务可用，并可连续检查直到全部完成', async () => {
  const h = harness({ mode: 'ACTIVE', recoveryReady: true, archiveOwnerBackfillPending: true });
  await h.controller.setSelected(true);
  assert.equal(h.retry.hidden, false);
  assert.equal(h.retry.textContent, '继续检查存档');
  assert.ok(h.business.every((button) => !button.disabled));
  assert.match(h.status.textContent, /仍有存档记录待检查/);
  await h.clickRetry();
  assert.equal(h.retries, 1);
  assert.equal(h.retry.hidden, false);
  assert.match(h.status.textContent, /仍有存档记录待检查/);
  h.setRetry(async () => {
    h.setState({ mode: 'ACTIVE', recoveryReady: true, archiveOwnerBackfillPending: false });
    return { ready: true };
  });
  await h.clickRetry();
  assert.equal(h.retries, 2);
  assert.equal(h.retry.hidden, true);
  assert.ok(h.business.every((button) => !button.disabled));
  assert.equal(h.status.textContent, '欢迎使用小助手');
});

test('真正未决的恢复仍阻止业务，并保留重试恢复入口', async () => {
  const h = harness({ mode: 'ACTIVE', recoveryReady: false, archiveOwnerBackfillPending: true });
  h.setRetry(async () => ({ ready: false }));
  await h.controller.setSelected(true);
  assert.equal(h.retry.textContent, '重试恢复');
  assert.equal(h.retry.hidden, false);
  assert.ok(h.business.every((button) => button.disabled));
  await h.clickRetry();
  assert.equal(h.retries, 1);
  assert.match(h.status.textContent, /仍有未决任务或文件/);
  assert.ok(h.business.every((button) => button.disabled));
});

test('一次存档检查未完成时重复点击不会启动第二次', async () => {
  const h = harness({ mode: 'ACTIVE', recoveryReady: true, archiveOwnerBackfillPending: true });
  let finish;
  h.setRetry(() => new Promise((resolve) => { finish = resolve; }));
  await h.controller.setSelected(true);
  await h.clickRetry();
  assert.equal(h.controller.busy, true);
  assert.equal(h.retry.disabled, true);
  await h.clickRetry();
  assert.equal(h.retries, 1);
  finish({ ready: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.controller.busy, false);
  assert.equal(h.retry.disabled, false);
  assert.ok(h.business.every((button) => !button.disabled));
});

test('继续检查发现新的真正未决时立即禁用业务并保留错误提示', async () => {
  const h = harness({ mode: 'ACTIVE', recoveryReady: true, archiveOwnerBackfillPending: true });
  h.setRetry(async () => {
    h.setState({ mode: 'ACTIVE', recoveryReady: false, archiveOwnerBackfillPending: true });
    return { ready: false };
  });
  await h.controller.setSelected(true);
  await h.clickRetry();
  assert.ok(h.business.every((button) => button.disabled));
  assert.equal(h.retry.hidden, false);
  assert.equal(h.retry.disabled, false);
  assert.equal(h.retry.textContent, '重试恢复');
  assert.match(h.status.textContent, /仍有未决任务或文件/);
});

test('旧版状态未返回待检查字段时保持原有入口行为', async () => {
  const h = harness({ mode: 'ACTIVE', recoveryReady: true });
  await h.controller.setSelected(true);
  assert.equal(h.retry.hidden, true);
  assert.ok(h.business.every((button) => !button.disabled));
});

test('模块尚未激活时不能继续检查或操作业务', async () => {
  const h = harness({ mode: 'SHADOW', recoveryReady: true, archiveOwnerBackfillPending: true });
  await h.controller.setSelected(true);
  assert.equal(h.retry.disabled, true);
  assert.ok(h.business.every((button) => button.disabled));
  await h.clickRetry();
  assert.equal(h.retries, 0);
  assert.match(h.status.textContent, /正在准备/);
});
