'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createModalHost } = require('../../../src/renderer/modal-host');
const { createModalDom } = require('../../helpers/modal-dom');

function setup(options = {}) {
  const dom = createModalDom();
  const errors = [];
  const host = createModalHost({ ...dom, reportError: (error, context) => errors.push({ error, context }), ...options });
  return { ...dom, host, errors };
}

function open(env, properties = {}, options) {
  const descriptor = env.createDialog(properties);
  const result = env.host.openRoot(() => descriptor, options);
  return { ...descriptor, ...result };
}

test('经典脚本加载只暴露工厂，不执行 DOM 或 IPC', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../src/renderer/modal-host'), 'utf8'), { window });
  assert.equal(typeof window.__modalHost.createModalHost, 'function');
});

test('普通关闭使 DOM、abort、逆序清理、closed 只完成一次，清理失败仍继续', async () => {
  const env = setup();
  const events = [];
  const descriptor = env.createDialog();
  const { handle } = env.host.openRoot((scope) => {
    scope.signal.addEventListener('abort', () => events.push('abort'));
    scope.onDispose(() => events.push('first'));
    scope.onDispose(() => { events.push('throw'); throw new Error('cleanup'); });
    scope.onDispose(() => events.push('last'));
    return descriptor;
  });
  let completions = 0;
  handle.closed.then(() => { completions += 1; });
  assert.deepEqual(handle.close(), { status: 'closed' });
  assert.deepEqual(handle.close(), { status: 'already-closed' });
  handle.dispose('renderer-dispose');
  env.host.dispose();
  env.host.dispose();
  assert.deepEqual(await handle.closed, { status: 'cancelled', reason: 'cancel' });
  assert.deepEqual(events, ['abort', 'last', 'throw', 'first']);
  assert.equal(completions, 1);
  assert.equal(descriptor.overlay.isConnected, false);
  assert.equal(handle.signal.aborted, true);
  assert.equal(env.document.listenerCount('keydown'), 0);
  assert.equal(env.frames.size, 0);
  assert.equal(env.errors.length, 1);
});

test('忙碌子层拒绝根替换、父关闭和导航，后继工厂不运行且草稿焦点保留', () => {
  const env = setup();
  const root = open(env, {}, { owner: 'vcc' });
  const childDom = env.createDialog({ canClose: () => false });
  const child = env.host.push(root.handle, () => childDom).handle;
  let calls = 0;
  const factory = () => { calls += 1; return env.createDialog(); };
  const expected = { status: 'blocked', by: child.id };
  assert.deepEqual(env.host.openRoot(factory), expected);
  assert.deepEqual(env.host.replace(root.handle, factory), expected);
  assert.deepEqual(root.handle.close(), expected);
  assert.deepEqual(env.host.closeOwner('vcc', 'navigation'), expected);
  assert.equal(calls, 0);
  assert.equal(env.document.activeElement, childDom.first);
  assert.equal(env.root.children.length, 2);
  assert.equal(root.overlay.inert, true);
  env.host.dispose();
});

test('canClose 从顶到底预检，任一抛错拒绝并记录', () => {
  const env = setup();
  const checks = [];
  const parent = open(env, { canClose: (reason) => { checks.push(`parent:${reason}`); throw new Error('blocked'); } });
  const childDom = env.createDialog({ canClose: (reason) => { checks.push(`child:${reason}`); return true; } });
  const child = env.host.push(parent.handle, () => childDom).handle;
  assert.deepEqual(parent.handle.close(), { status: 'blocked', by: parent.handle.id });
  assert.deepEqual(checks, ['child:cancel', 'parent:cancel']);
  assert.equal(child.isOpen(), true);
  assert.equal(env.errors[0].context.phase, 'can-close');
  env.host.dispose();
});

test('canClose 异步返回不能绕过忙碌检查，拒绝的 Promise 有错误记录', async () => {
  const env = setup();
  const modal = open(env, { canClose: () => Promise.reject(new Error('async close')) });
  assert.equal(modal.handle.close().status, 'blocked');
  await Promise.resolve();
  assert.ok(env.errors.some(({ error }) => error.code === 'MODAL_CLOSE_INVALID'));
  assert.ok(env.errors.some(({ error }) => error.message === 'async close'));
  env.host.dispose();
});

test('工厂失败只释放新 scope，原栈、焦点、监听及 Promise 全部保留', async () => {
  const env = setup();
  const original = open(env);
  let cleaned = 0;
  let signal;
  let originalClosed = false;
  original.handle.closed.then(() => { originalClosed = true; });
  assert.throws(() => env.host.openRoot((scope) => {
    signal = scope.signal;
    scope.onDispose(() => { cleaned += 1; });
    throw new Error('construction');
  }), /construction/);
  await Promise.resolve();
  assert.equal(cleaned, 1);
  assert.equal(signal.aborted, true);
  assert.equal(originalClosed, false);
  assert.equal(env.root.children[0], original.overlay);
  assert.equal(env.document.activeElement, original.first);
  assert.equal(original.overlay.listenerCount('click'), 1);
  env.host.dispose();
});

test('拒绝已挂载节点和已经关闭的节点再次挂载，仍保留当前栈', () => {
  const env = setup();
  const first = open(env);
  assert.throws(() => env.host.openRoot(() => first), { code: 'MODAL_NODE_REUSED' });
  first.handle.close();
  const second = open(env);
  assert.throws(() => env.host.openRoot(() => first), { code: 'MODAL_NODE_REUSED' });
  assert.equal(second.handle.isOpen(), true);
  env.host.dispose();
});

test('push 只允许本宿主当前父层且强制继承 owner', () => {
  const env = setup();
  const root = open(env, {}, { owner: 'linked-table' });
  assert.throws(() => env.host.push(root.handle, () => env.createDialog(), { owner: 'vcc' }), { code: 'MODAL_OWNER_INVALID' });
  const child = env.host.push(root.handle, () => env.createDialog()).handle;
  assert.equal(child.owner, 'linked-table');
  assert.throws(() => env.host.push(root.handle, () => env.createDialog()), { code: 'MODAL_PARENT_INVALID' });
  assert.throws(() => env.host.push({ id: child.id }, () => env.createDialog()), { code: 'MODAL_PARENT_INVALID' });
  child.close();
  assert.throws(() => env.host.push(child, () => env.createDialog()), { code: 'MODAL_PARENT_INVALID' });
  env.host.dispose();
});

test('映射保存成功替换映射及其后代，告警关闭返回原链接表且无孤儿', async () => {
  const env = setup();
  const parent = open(env);
  parent.last.focus();
  const mappingDom = env.createDialog();
  const mapping = env.host.push(parent.handle, () => mappingDom).handle;
  const nested = env.host.push(mapping, () => env.createDialog()).handle;
  const alert = env.host.replace(mapping, () => env.createDialog()).handle;
  assert.deepEqual(await mapping.closed, { status: 'cancelled', reason: 'replaced' });
  assert.deepEqual(await nested.closed, { status: 'cancelled', reason: 'replaced' });
  assert.equal(parent.handle.isOpen(), true);
  assert.equal(env.root.children.length, 2);
  alert.close({ status: 'submitted', value: true });
  assert.equal(env.document.activeElement, parent.last);
  assert.equal(parent.handle.isTop(), true);
  assert.equal(parent.overlay.inert, false);
  env.host.dispose();
});

test('父层提交关闭时子层取消 parent-closed，按顶到底清理，观察者见到完整切换', async () => {
  const env = setup();
  const cleanups = [];
  const parent = env.host.openRoot((scope) => { scope.onDispose(() => cleanups.push('parent')); return env.createDialog(); }).handle;
  const child = env.host.push(parent, (scope) => { scope.onDispose(() => cleanups.push('child')); return env.createDialog(); }).handle;
  let observerTop;
  child.closed.then(() => { observerTop = env.host.getTop(); });
  parent.close({ status: 'submitted', value: 0 });
  assert.deepEqual(await parent.closed, { status: 'submitted', value: 0 });
  assert.deepEqual(await child.closed, { status: 'cancelled', reason: 'parent-closed' });
  assert.deepEqual(cleanups, ['child', 'parent']);
  assert.equal(observerTop, null);
  env.host.dispose();
});

test('canClose 和 disposer 重入被拒绝，不插入幽灵窗口且清理继续', async () => {
  const env = setup();
  let created = 0;
  const factory = () => { created += 1; return env.createDialog(); };
  const root = open(env, { canClose: () => { env.host.openRoot(factory); return true; } });
  assert.equal(root.handle.close().status, 'blocked');
  assert.equal(created, 0);
  root.handle.dispose();
  const descriptor = env.createDialog();
  const next = env.host.openRoot((scope) => {
    scope.onDispose(() => env.host.openRoot(factory));
    scope.onDispose(() => env.host.dispose());
    return descriptor;
  }).handle;
  next.close();
  assert.equal((await next.closed).reason, 'cancel');
  assert.equal(created, 0);
  assert.equal(env.root.children.length, 0);
  assert.ok(env.errors.filter(({ error }) => error.code === 'MODAL_REENTRANT').length >= 3);
  env.host.dispose();
});

test('只有栈顶处理 Escape 和遮罩，默认禁止 dismiss 策略保持', async () => {
  const env = setup();
  const parent = open(env, { dismiss: { escape: true, backdrop: true } });
  const childDom = env.createDialog();
  const child = env.host.push(parent.handle, () => childDom).handle;
  env.document.dispatch('keydown', { key: 'Escape' });
  parent.overlay.dispatch('click');
  childDom.overlay.dispatch('click');
  assert.equal(child.isOpen(), true);
  assert.equal(parent.handle.isOpen(), true);
  child.close();
  parent.overlay.dispatch('click', { target: parent.dialog });
  assert.equal(parent.handle.isOpen(), true);
  parent.overlay.dispatch('click');
  assert.deepEqual(await parent.handle.closed, { status: 'cancelled', reason: 'backdrop' });
  const escape = open(env, { dismiss: { escape: true } });
  const event = env.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(await escape.handle.closed, { status: 'cancelled', reason: 'escape' });
  assert.equal(env.document.listenerCount('keydown'), 1);
  env.host.dispose();
});

test('焦点优先显式控件，Tab 双向环绕且底层还原原 aria/inert 值', () => {
  const env = setup();
  const parent = open(env);
  parent.overlay.setAttribute('aria-hidden', 'false');
  const childDom = env.createDialog();
  childDom.initialFocus = () => childDom.last;
  const child = env.host.push(parent.handle, () => childDom).handle;
  assert.equal(env.document.activeElement, childDom.last);
  assert.equal(parent.overlay.getAttribute('aria-hidden'), 'true');
  env.document.dispatch('keydown', { key: 'Tab' });
  assert.equal(env.document.activeElement, childDom.first);
  env.document.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(env.document.activeElement, childDom.last);
  child.close();
  assert.equal(parent.overlay.getAttribute('aria-hidden'), 'false');
  assert.equal(parent.overlay.getAttribute('inert'), null);
  assert.equal(parent.overlay.inert, false);
  assert.equal(env.document.activeElement, parent.first);
  env.host.dispose();
});

test('焦点跳过隐藏/禁用控件，恢复目标不可用时回父层默认控件', () => {
  const env = setup();
  const parent = open(env);
  parent.last.focus();
  const childDom = env.createDialog();
  childDom.first.disabled = true;
  const child = env.host.push(parent.handle, () => childDom).handle;
  assert.equal(env.document.activeElement, childDom.last);
  parent.last.remove();
  child.close();
  assert.equal(env.document.activeElement, parent.first);
  env.host.dispose();
});

test('没有可聚焦控件使用临时 tabindex 并清理；过期 frame 不会抢新层焦点', () => {
  const env = setup();
  const descriptor = env.createDialog();
  descriptor.first.remove(); descriptor.last.remove();
  const handle = env.host.openRoot(() => descriptor).handle;
  assert.equal(env.document.activeElement, descriptor.dialog);
  assert.equal(descriptor.dialog.getAttribute('tabindex'), '-1');
  const stale = [...env.frames.values()][0];
  const next = open(env);
  stale();
  env.flushFrames();
  assert.equal(handle.isOpen(), false);
  assert.equal(descriptor.dialog.getAttribute('tabindex'), null);
  assert.equal(env.document.activeElement, next.first);
  env.host.dispose();
});

test('根替换和最终关闭恢复原调用入口；入口消失时使用当前面板默认焦点', () => {
  const dom = createModalDom();
  const trigger = dom.document.createElement('button');
  const fallback = dom.document.createElement('button');
  dom.document.body.append(trigger, fallback);
  const host = createModalHost({ ...dom, resolveFallbackFocus: () => fallback });
  trigger.focus();
  host.openRoot(() => dom.createDialog());
  const replaced = host.openRoot(() => dom.createDialog()).handle;
  replaced.close();
  assert.equal(dom.document.activeElement, trigger);
  trigger.focus();
  const final = host.openRoot(() => dom.createDialog()).handle;
  trigger.remove();
  final.close();
  assert.equal(dom.document.activeElement, fallback);
  host.dispose();
});

test('onMount 在事务完成后执行，可打开子层；失败记录且不复活旧栈', async () => {
  const env = setup();
  const original = open(env);
  let child;
  const next = open(env, { onMount(handle) {
    assert.equal(handle.isTop(), true);
    child = env.host.push(handle, () => env.createDialog()).handle;
    throw new Error('load');
  } });
  assert.equal((await original.handle.closed).reason, 'replaced');
  assert.equal(next.handle.isOpen(), true);
  assert.equal(child.isTop(), true);
  assert.equal(env.errors.at(-1).context.phase, 'on-mount');
  env.host.dispose();
});

test('scope 晚登记清理立即释放，关闭后的异步加载可用 signal 阻止 DOM 写入', async () => {
  const env = setup();
  let resolveLoad;
  const load = new Promise((resolve) => { resolveLoad = resolve; });
  let writes = 0;
  let cleanup = 0;
  let publicScope;
  const handle = env.host.openRoot((scope) => {
    publicScope = scope;
    return { ...env.createDialog(), onMount: async () => { await load; if (!scope.signal.aborted) writes += 1; } };
  }).handle;
  handle.close();
  publicScope.onDispose(() => { cleanup += 1; });
  resolveLoad();
  await load;
  assert.equal(writes, 0);
  assert.equal(cleanup, 1);
  env.host.dispose();
});

test('owner 导航只关闭匹配会话；销毁无视 busy 且结果统一 disposed', async () => {
  const env = setup();
  const parent = open(env, { canClose: () => false }, { owner: 'vcc' });
  const child = env.host.push(parent.handle, () => env.createDialog({ canClose: () => false })).handle;
  assert.deepEqual(env.host.closeOwner('position'), { status: 'closed' });
  assert.equal(child.isTop(), true);
  env.host.dispose();
  assert.deepEqual(await child.closed, { status: 'cancelled', reason: 'disposed' });
  assert.deepEqual(await parent.handle.closed, { status: 'cancelled', reason: 'disposed' });
  assert.equal(env.document.listenerCount('keydown'), 0);
  assert.throws(() => env.host.openRoot(() => env.createDialog()), { code: 'MODAL_HOST_DISPOSED' });
});

test('只读 getHandle/getTop 不暴露可变栈，关闭后不能查回旧句柄', () => {
  const env = setup();
  const parent = open(env);
  const childDom = env.createDialog();
  const child = env.host.push(parent.handle, () => childDom).handle;
  assert.equal(env.host.getHandle(parent.last), parent.handle);
  assert.equal(env.host.getHandle(childDom.overlay), child);
  assert.equal(env.host.getTop(), child);
  assert.equal(env.host.getHandle(env.document.body), null);
  assert.equal(Object.isFrozen(child), true);
  child.close();
  assert.equal(env.host.getHandle(childDom.first), null);
  assert.equal(env.host.getTop(), parent.handle);
  env.host.dispose();
});

test('栈顶 overlay 的浮动兄弟面板控件参与 Tab，不被 dialog 范围漏掉', () => {
  const env = setup();
  const descriptor = env.createDialog();
  const floating = env.document.createElement('input');
  descriptor.overlay.appendChild(floating);
  const handle = env.host.openRoot(() => descriptor).handle;
  descriptor.last.focus();
  env.document.dispatch('keydown', { key: 'Tab' });
  assert.equal(env.document.activeElement, floating);
  env.flushFrames();
  assert.equal(env.document.activeElement, floating);
  handle.close();
  env.host.dispose();
});
