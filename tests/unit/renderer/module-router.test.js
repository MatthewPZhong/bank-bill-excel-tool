'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createModuleRouter } = require('../../../src/renderer/module-router');
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = []; const saves = []; const errors = []; const views = [];
  const deferredEnters = { a: [], b: [], c: [] };
  const controllers = {}; const panels = {};
  for (const id of ['a', 'b', 'c']) {
    panels[id] = { hidden: true };
    controllers[id] = {
      enter(context) { calls.push({ method: 'enter', id, context }); return deferredEnters[id].shift() || Promise.resolve({ status: 'ready' }); },
      leave(context) { calls.push({ method: 'leave', id, context }); return { status: 'left' }; },
      dispose() { calls.push({ method: 'dispose', id }); }
    };
  }
  const modules = Object.keys(controllers).map((id) => ({ id, controller: controllers[id], panel: panels[id] }));
  const router = createModuleRouter({ modules, defaultModuleId: 'a', onNavigate: (event) => views.push(event),
    persistCurrentModule: (id, context) => saves.push({ id, context }), reportError: (error) => errors.push(error) });
  return { router, modules, controllers, panels, calls, saves, errors, views, deferredEnters };
}

test('静态注册复制冻结；未知模块沿默认模块回退，面板与持久化只在成功切换后变更', async () => {
  const f = fixture();
  f.modules.push({ id: 'injected', controller: f.controllers.c });
  assert.ok(Object.isFrozen(f.router.moduleIds));
  assert.deepEqual(f.router.moduleIds, ['a', 'b', 'c']);
  const startup = f.router.navigate('missing', { reason: 'startup', persist: false });
  assert.equal(startup.moduleId, 'a');
  assert.equal(f.router.getCurrentModuleId(), 'a');
  assert.deepEqual(Object.values(f.panels).map((panel) => panel.hidden), [false, true, true]);
  assert.equal(f.saves.length, 0);
  await startup.ready;
  const switched = f.router.navigate('b');
  assert.equal(switched.status, 'navigated');
  assert.equal(f.router.getCurrentModuleId(), 'b');
  assert.deepEqual(Object.values(f.panels).map((panel) => panel.hidden), [true, false, true]);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].id, 'b');
  await switched.ready;
  assert.deepEqual(f.calls.map((call) => `${call.id}.${call.method}`), ['a.enter', 'a.leave', 'b.enter']);
  assert.equal(f.views[1].previousModuleId, 'a');
});

test('leave blocked 保留路由、面板、持久化和上一 enter 的有效代次', async () => {
  const f = fixture(); const hold = deferred();
  f.deferredEnters.a.push(hold.promise);
  const entering = f.router.navigate('a');
  const before = f.router.getCurrentRoute();
  f.controllers.a.leave = () => ({ status: 'blocked' });
  const rejected = f.router.navigate('b');
  assert.equal(rejected.status, 'blocked');
  assert.deepEqual(f.router.getCurrentRoute(), before);
  assert.deepEqual(Object.values(f.panels).map((panel) => panel.hidden), [false, true, true]);
  assert.equal(f.saves.length, 1);
  assert.equal(f.calls.filter((call) => call.id === 'b').length, 0);
  hold.resolve({ status: 'ready' });
  assert.equal((await entering.ready).status, 'ready');
});

test('同模块重复导航不重复 enter、订阅、持久化或递增代次', async () => {
  const f = fixture(); const hold = deferred(); f.deferredEnters.a.push(hold.promise);
  const first = f.router.navigate('a');
  const second = f.router.navigate('a');
  const unknown = f.router.navigate('not-registered');
  assert.equal(second.status, 'unchanged'); assert.equal(unknown.status, 'unchanged');
  assert.equal(first.ready, second.ready);
  assert.equal(second.routeVersion, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(f.calls.length, 1);
  hold.resolve({ status: 'ready' }); await first.ready;
  assert.equal(f.router.navigate('a').status, 'unchanged');
});

test('A → B → A 的旧 enter 后到为 stale，旧完成不回切页面', async () => {
  const f = fixture(); const a1 = deferred(); const b = deferred(); const a2 = deferred();
  f.deferredEnters.a.push(a1.promise, a2.promise); f.deferredEnters.b.push(b.promise);
  const first = f.router.navigate('a'); const second = f.router.navigate('b'); const third = f.router.navigate('a');
  a2.resolve({ status: 'ready' }); assert.equal((await third.ready).status, 'ready');
  b.resolve({ status: 'ready' }); a1.resolve({ status: 'ready' });
  assert.equal((await second.ready).status, 'stale'); assert.equal((await first.ready).status, 'stale');
  assert.equal(f.router.getCurrentModuleId(), 'a');
  assert.equal(f.views.length, 3); assert.equal(f.saves.length, 3);
});

test('异步 leave 违反同步资格合同，等待中其他导航也不能偷偷提交旧请求', async () => {
  const f = fixture(); await f.router.navigate('a').ready;
  const hold = deferred(); f.controllers.a.leave = () => hold.promise;
  assert.equal(f.router.navigate('b').status, 'blocked');
  assert.equal(f.router.navigate('c').status, 'blocked');
  hold.resolve({ status: 'left' }); await Promise.resolve();
  assert.equal(f.router.getCurrentModuleId(), 'a');
  assert.equal(f.saves.length, 1); assert.equal(f.views.length, 1);
  assert.equal(f.errors.length, 2);
  f.controllers.a.leave = () => ({ status: 'left' });
  await f.router.navigate('c').ready;
  assert.equal(f.router.getCurrentModuleId(), 'c');
});

test('leave 抛错保留原模块，enter 失败由本域反馈/日志处理，壳不读取别域状态修复', async () => {
  const f = fixture(); await f.router.navigate('a').ready;
  const failure = new Error('关闭预检失败'); f.controllers.a.leave = () => { throw failure; };
  assert.equal(f.router.navigate('b').status, 'error');
  assert.equal(f.router.getCurrentModuleId(), 'a');
  assert.equal(f.errors[0], failure);
  f.controllers.a.leave = () => ({ status: 'left' });
  const enterFailure = new Error('领域读取失败'); f.controllers.b.enter = () => Promise.reject(enterFailure);
  const changed = f.router.navigate('b');
  assert.equal((await changed.ready).status, 'error');
  assert.equal(f.router.getCurrentModuleId(), 'b');
  assert.equal(f.errors[1], enterFailure);
});

test('同步 leave 重入被拒绝；enter 发起新导航后旧 ready 不能覆盖新 ready', async () => {
  const f = fixture(); await f.router.navigate('a').ready;
  let nested;
  f.controllers.a.leave = () => { nested = f.router.navigate('c'); return { status: 'left' }; };
  f.controllers.b.enter = () => { f.router.navigate('c'); return Promise.resolve({ status: 'ready' }); };
  const b = f.router.navigate('b');
  assert.equal(nested.status, 'blocked');
  assert.equal(f.router.getCurrentModuleId(), 'c');
  assert.equal((await b.ready).status, 'stale');
  assert.equal((await f.router.navigate('c').ready).status, 'ready');
});

test('持久化 reject/明确失败只日志，不回滚或重复切换', async () => {
  const panels = [{ hidden: true }, { hidden: true }]; const errors = [];
  const controller = { enter: () => ({ status: 'ready' }), leave: () => ({ status: 'left' }), dispose() {} };
  const router = createModuleRouter({ modules: ['a', 'b'].map((id, index) => ({ id, panel: panels[index], controller })),
    defaultModuleId: 'a', persistCurrentModule: (id) => id === 'a' ? Promise.reject(new Error('保存断开')) : { status: 'failed', message: '保存失败' },
    reportError: (error) => errors.push(error) });
  await router.navigate('a').ready; await router.navigate('b').ready;
  assert.equal(router.getCurrentModuleId(), 'b'); assert.equal(errors.length, 2);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
});

test('dispose 全部控制器恰好一次，单个抛错不截断清理，晚到 enter 为 stale', async () => {
  const f = fixture(); const hold = deferred(); f.deferredEnters.a.push(hold.promise);
  const entering = f.router.navigate('a');
  f.controllers.b.dispose = () => { f.calls.push({ method: 'dispose', id: 'b' }); throw new Error('清理失败'); };
  f.router.dispose(); f.router.dispose();
  assert.deepEqual(f.calls.filter((call) => call.method === 'dispose').map((call) => call.id), ['a', 'b', 'c']);
  assert.equal(f.errors.length, 1);
  hold.resolve({ status: 'ready' }); assert.equal((await entering.ready).status, 'stale');
  assert.equal(f.router.navigate('c').status, 'disposed');
  assert.equal(f.router.getCurrentModuleId(), null);
});

test('注册表拒绝重复/不完整/缺默认模块，同一个门面跨条目只 dispose 一次', () => {
  const f = fixture();
  assert.throws(() => createModuleRouter({ modules: [f.modules[0], f.modules[0]], defaultModuleId: 'a' }), /重复/);
  assert.throws(() => createModuleRouter({ modules: [{ id: 'a', controller: {} }], defaultModuleId: 'a' }), /生命周期/);
  assert.throws(() => createModuleRouter({ modules: f.modules, defaultModuleId: 'missing' }), /默认模块/);
  let disposed = 0;
  const controller = { enter() {}, leave: () => ({ status: 'left' }), dispose() { disposed += 1; } };
  const router = createModuleRouter({ modules: [{ id: 'a', controller }, { id: 'b', controller }], defaultModuleId: 'a' });
  router.dispose(); assert.equal(disposed, 1);
});

test('leave 或视图提交回调销毁 router 时，不再 enter/保存下一模块', async () => {
  const f = fixture(); await f.router.navigate('a').ready;
  f.controllers.a.leave = () => { f.router.dispose(); return { status: 'left' }; };
  assert.equal(f.router.navigate('b').status, 'disposed');
  assert.equal(f.router.getCurrentModuleId(), null);
  assert.equal(f.saves.length, 1);
  assert.equal(f.calls.some((call) => call.id === 'b' && call.method === 'enter'), false);
  let saves = 0; let enters = 0; let router;
  const controller = { enter() { enters += 1; }, leave: () => ({ status: 'left' }), dispose() {} };
  router = createModuleRouter({ modules: [{ id: 'a', controller }], defaultModuleId: 'a',
    onNavigate() { router.dispose(); }, persistCurrentModule() { saves += 1; } });
  assert.equal(router.navigate('a').status, 'disposed');
  assert.equal(enters, 0); assert.equal(saves, 0);
});
