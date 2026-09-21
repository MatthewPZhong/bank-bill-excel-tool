'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createScenarioCommandService } = require('../../../src/renderer/scenario-command-service');
const { createScenarioChangeRouter } = require('../../../src/renderer/scenario-change-router');
const { createSharedReconSession } = require('../../../src/renderer/shared-recon-session');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const rows = new Map((options.rows || [{ id: 1, category: 'recon-id-fix' }]).map((row) => [row.id, { ...row }]));
  const events = [];
  const calls = [];
  const holds = new Map();
  const failures = new Map();
  function invoke(name, args, operation) {
    calls.push({ name, args });
    const queue = holds.get(name);
    const hold = queue && queue.shift();
    const failure = failures.get(name);
    if (failure) { failures.delete(name); return Promise.resolve(failure); }
    const result = operation();
    if (hold) { hold.result = result; return hold.promise; }
    return Promise.resolve(result);
  }
  const scenariosApi = {
    list: (...args) => invoke('list', args, () => ({ status: 'ok', scenarios: [...rows.values()].map((row) => ({ ...row })) })),
    get: (id) => invoke('get', [id], () => rows.has(id) ? { status: 'ok', scenario: { ...rows.get(id) } }
      : { status: 'failed', message: `场景 id=${id} 不存在` }),
    create: (payload) => invoke('create', [payload], () => {
      let id = 1;
      while (rows.has(id)) id += 1;
      rows.set(id, { id, category: payload.category });
      return { status: 'ok', id };
    }),
    update: (id, fields) => invoke('update', [id, fields], () => ({ status: 'ok', id })),
    toggleEnabled: (id, enabled) => invoke('toggleEnabled', [id, enabled], () => ({ status: 'ok', id, enabled })),
    deleteOne: (id) => invoke('deleteOne', [id], () => ({ status: 'ok', id, deleted: rows.delete(id) })),
    transfer: (payload) => invoke('transfer', [payload], () => ({ status: 'ok', transferredCount: payload.scenarioIds.length, targetChannelId: payload.targetChannelId })),
    batchDelete: (ids) => invoke('batchDelete', [ids], () => ({ status: 'ok', deletedCount: ids.filter((id) => rows.delete(id)).length })),
    setApplicableChannels: (id, ids) => invoke('setApplicableChannels', [id, ids], () => ({ status: 'ok', scenarioId: id, channelIds: ids })),
    applyImport: (...args) => invoke('applyImport', args, () => ({ status: 'ok', importedCount: 0, createdChannels: [], conflicts: [] })),
    importBundle: (...args) => invoke('importBundle', args, () => ({ status: 'ready-to-apply', preparedContextId: 'prepared-1' })),
    exportBundle: (...args) => invoke('exportBundle', args, () => ({ status: 'ok', filePath: 'test.json' })),
    getApplicableChannels: (...args) => invoke('getApplicableChannels', args, () => ({ status: 'ok', channelIds: [] })),
    getFundTypeEnum: (...args) => invoke('getFundTypeEnum', args, () => ({ status: 'ok', values: [] })),
    getGatewayReconHeaders: (...args) => invoke('getGatewayReconHeaders', args, () => ({ status: 'ok', values: [] }))
  };
  const channelsApi = {
    list: (...args) => invoke('channels.list', args, () => ({ status: 'ok', channels: [] })),
    create: (payload) => invoke('channels.create', [payload], () => ({ status: 'ok', channel: { id: 2, ...payload } })),
    update: (id, fields) => invoke('channels.update', [id, fields], () => ({ status: 'ok', channel: { id, ...fields } })),
    deleteOne: (id) => invoke('channels.deleteOne', [id], () => ({ status: 'ok', id }))
  };
  const service = createScenarioCommandService({ scenariosApi, channelsApi, publish: (event) => events.push(event),
    // 每个 fixture 创建独占的模拟 Main；此声明不可搬到无法证明启动边界的生产装配。
    writerBoundaryTrusted: options.trusted !== false, reportError: options.reportError });
  return { service, scenariosApi, channelsApi, rows, events, calls, failures,
    hold(name) { const item = deferred(); const queue = holds.get(name) || []; queue.push(item); holds.set(name, queue); return item; },
    count(name) { return calls.filter((call) => call.name === name).length; },
    last() { return events.at(-1); }
  };
}
const BOTH = ['bank-statement', 'recon-id-fix'];
const categories = ['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'builtin-fixed', 'recon-id-fix', 'gateway-recon-id-fix', 'future-category'];
for (const category of categories) {
  test(`单项命令使用已证明的实际类别：${category}`, async () => {
    const f = fixture({ rows: [{ id: 1, category }] });
    const expected = category === 'future-category' ? BOTH : category.endsWith('recon-id-fix') ? ['recon-id-fix'] : ['bank-statement'];
    await f.service.scenarios.list();
    await f.service.scenarios.update(1, { priority: 4 });
    assert.deepEqual(f.last().invalidationScope, expected);
    await f.service.scenarios.toggleEnabled(1, false);
    assert.deepEqual(f.last().invalidationScope, expected);
    await f.service.scenarios.deleteOne(1);
    assert.deepEqual(f.last().invalidationScope, expected);
    assert.equal(f.count('get'), 0);
    assert.deepEqual(f.events.map((event) => event.revision), [1, 2, 3]);
    assert.equal(f.count('update'), 1);
    assert.equal(f.count('toggleEnabled'), 1);
    assert.equal(f.count('deleteOne'), 1);
  });
}

test('create 取 dispatch 时提交的类别，不受后续草稿修改影响', async () => {
  const f = fixture({ rows: [] });
  const hold = f.hold('create');
  const payload = { category: 'gateway-recon-id-fix', name: '测试' };
  const writing = f.service.scenarios.create(payload);
  payload.category = 'extract-recon-id';
  hold.resolve(hold.result);
  await writing;
  assert.deepEqual(f.last().invalidationScope, ['recon-id-fix']);
  await f.service.scenarios.update(1, {});
  assert.deepEqual(f.last().categories, ['gateway-recon-id-fix']);
  assert.equal(f.count('get'), 0);
});

for (const [oldCategory, newCategory] of [['recon-id-fix', 'extract-recon-id'], ['extract-recon-id', 'recon-id-fix']]) {
  for (const method of ['update', 'toggleEnabled', 'deleteOne']) {
    test(`ID 复用 ${oldCategory} → ${newCategory} 后旧 list/get 不污染 ${method}`, async () => {
      const f = fixture({ rows: [{ id: 1, category: oldCategory }] });
      await f.service.scenarios.list();
      const oldList = f.hold('list');
      const oldGet = f.hold('get');
      const listing = f.service.scenarios.list();
      const getting = f.service.scenarios.get(1);
      await f.service.scenarios.deleteOne(1);
      const created = await f.service.scenarios.create({ category: newCategory });
      assert.equal(created.id, 1);
      oldList.resolve(oldList.result);
      oldGet.resolve(oldGet.result);
      await Promise.all([listing, getting]);
      await f.service.scenarios[method](1, method === 'toggleEnabled' ? true : {});
      assert.deepEqual(f.last().categories, [newCategory]);
      assert.deepEqual(f.last().invalidationScope, newCategory === 'recon-id-fix' ? ['recon-id-fix'] : ['bank-statement']);
      assert.equal(f.count(method), method === 'deleteOne' ? 2 : 1);
    });
  }
}

for (const crossing of ['delete-create', 'applyImport']) {
  test(`补读跨 ${crossing} 即使合法晚到也 resync，原写只发一次`, async () => {
    const f = fixture();
    const hold = f.hold('get');
    const updating = f.service.scenarios.update(1, { priority: 3 });
    if (crossing === 'delete-create') {
      await f.service.scenarios.deleteOne(1);
      await f.service.scenarios.create({ category: 'extract-recon-id' });
    } else {
      await f.service.scenarios.applyImport('prepared', { confirmCreateMissingChannels: true });
    }
    hold.resolve(hold.result);
    await updating;
    assert.equal(f.last().kind, 'scenarios-resync-required');
    assert.deepEqual(f.last().resyncScope, BOTH);
    assert.equal('invalidationScope' in f.last(), false);
    assert.equal(f.count('update'), 1);
    assert.equal(f.count('get'), crossing === 'delete-create' ? 2 : 1);
  });
}

for (const reverse of [false, true]) {
  test(`A/B 交错写${reverse ? '逆序' : '顺序'}返回均不猜类别，失败 B 也不恢复 A 证据`, async () => {
    const f = fixture();
    await f.service.scenarios.list();
    const first = f.hold('update');
    const a = f.service.scenarios.update(1, {});
    const second = f.hold('toggleEnabled');
    const b = f.service.scenarios.toggleEnabled(1, false);
    // B 的 get 在 A 活动期间发出，返回不能进入元数据。
    await Promise.resolve();
    await Promise.resolve();
    if (reverse) {
      second.resolve({ status: 'failed', message: '业务校验失败' }); await b;
      first.resolve(first.result); await a;
    } else {
      first.resolve(first.result); await a;
      second.resolve(second.result); await b;
    }
    assert.equal(f.last().kind, 'scenarios-resync-required');
    assert.equal(f.count('update'), 1);
    assert.equal(f.count('toggleEnabled'), 1);
  });
}

test('写入期间发出的 get 在结算后返回也不能播种', async () => {
  const f = fixture();
  await f.service.scenarios.list();
  const write = f.hold('transfer');
  const writing = f.service.scenarios.transfer({ scenarioIds: [1], targetChannelId: 2 });
  const read = f.hold('get');
  const reading = f.service.scenarios.get(1);
  write.resolve(write.result); await writing;
  read.resolve(read.result); await reading;
  f.failures.set('get', { status: 'failed', message: '读取失败' });
  await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
  assert.equal(f.count('get'), 2);
});

for (const method of ['batchDelete', 'applyImport', 'transfer', 'setApplicableChannels', 'channels.create', 'channels.update', 'channels.deleteOne']) {
  test(`${method} 清整份分类缓存，固定结果 scope 不依赖缓存`, async () => {
    const f = fixture({ rows: [{ id: 1, category: 'recon-id-fix' }, { id: 2, category: 'extract-recon-id' }] });
    await f.service.scenarios.list();
    if (method === 'batchDelete') await f.service.scenarios.batchDelete([2]);
    else if (method === 'applyImport') await f.service.scenarios.applyImport('prepared');
    else if (method === 'transfer') await f.service.scenarios.transfer({ scenarioIds: [2], targetChannelId: 2 });
    else if (method === 'setApplicableChannels') await f.service.scenarios.setApplicableChannels(2, []);
    else await f.service.channels[method.split('.')[1]](2, {});
    assert.deepEqual(f.last().invalidationScope, method.startsWith('channels') ? [] : method === 'setApplicableChannels' ? ['bank-statement'] : BOTH);
    f.failures.set('get', { status: 'failed', message: '读取失败' });
    await f.service.scenarios.update(1, {});
    assert.equal(f.last().kind, 'scenarios-resync-required');
    assert.equal(f.count('get'), 1);
  });
}

test('渠道写在单项写期间交错，使该写证据失效，但渠道事件不清结果', async () => {
  const f = fixture();
  await f.service.scenarios.list();
  const hold = f.hold('update');
  const writing = f.service.scenarios.update(1, {});
  await f.service.channels.create({ name: '渠道' });
  assert.equal(f.last().kind, 'configuration-changed');
  assert.deepEqual(f.last().invalidationScope, []);
  hold.resolve(hold.result); await writing;
  assert.equal(f.last().kind, 'scenarios-resync-required');
});

test('create 回包跨写不播种，之后仍须 get 取证', async () => {
  const f = fixture({ rows: [] });
  const hold = f.hold('create');
  const creating = f.service.scenarios.create({ category: 'recon-id-fix' });
  await f.service.scenarios.applyImport('prepared');
  hold.resolve(hold.result); await creating;
  assert.deepEqual(f.last().invalidationScope, ['recon-id-fix']);
  f.failures.set('get', { status: 'failed', message: '读取失败' });
  await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
});

for (const status of ['failed', 'cancelled']) {
  test(`明确 ${status} 不广播且不回滚写前分类缓存`, async () => {
    const f = fixture();
    await f.service.scenarios.list();
    f.failures.set('update', { status, message: '预检结束' });
    await f.service.scenarios.update(1, {});
    assert.equal(f.events.length, 0);
    f.failures.set('get', { status: 'failed', message: '查询失败' });
    await f.service.scenarios.toggleEnabled(1, false);
    assert.equal(f.last().kind, 'scenarios-resync-required');
  });
}

for (const unknown of ['reject', 'malformed', 'unknown-status']) {
  test(`${unknown} 后成功查询、页面刷新与重建 service 均不能恢复信任`, async () => {
    const f = fixture();
    await f.service.scenarios.list();
    const hold = f.hold('update');
    const writing = f.service.scenarios.update(1, {});
    if (unknown === 'reject') {
      const failure = new Error('传输中断');
      hold.reject(failure);
      await assert.rejects(writing, (error) => error === failure);
    } else {
      hold.resolve(unknown === 'malformed' ? { status: 'ok' } : { status: 'pending' });
      await writing;
    }
    assert.equal(f.last().kind, 'scenarios-resync-required');
    await f.service.scenarios.list(); await f.service.scenarios.get(1);
    await f.service.scenarios.toggleEnabled(1, false);
    assert.equal(f.last().kind, 'scenarios-resync-required');
    const nextEvents = [];
    f.service.dispose();
    const replacement = createScenarioCommandService({ scenariosApi: f.scenariosApi, channelsApi: f.channelsApi,
      writerBoundaryTrusted: true, publish: (event) => nextEvents.push(event) });
    await replacement.scenarios.list();
    await replacement.scenarios.update(1, {});
    assert.equal(nextEvents[0].kind, 'scenarios-resync-required');
    assert.ok(nextEvents[0].revision > f.last().revision);
  });
}

test('新服务默认不可信，成功 list/get 不是 Main 启动收口证明', async () => {
  const f = fixture({ trusted: false });
  await f.service.scenarios.list(); await f.service.scenarios.get(1);
  await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
  await f.service.scenarios.create({ category: 'extract-recon-id' });
  assert.deepEqual(f.last().invalidationScope, ['bank-statement']);
  await f.service.scenarios.transfer({ scenarioIds: [1], targetChannelId: 2 });
  assert.deepEqual(f.last().invalidationScope, BOTH);
  await f.service.scenarios.deleteOne(999);
  assert.deepEqual(f.last().invalidationScope, []);
});

test('dispose 后旧 list/get 及旧写不能通知或恢复新 service，且不重发写', async () => {
  const f = fixture();
  const listHold = f.hold('list'); const getHold = f.hold('get');
  const listing = f.service.scenarios.list(); const getting = f.service.scenarios.get(1);
  const writeHold = f.hold('transfer'); const writing = f.service.scenarios.transfer({ scenarioIds: [1], targetChannelId: 2 });
  f.service.dispose(); f.service.dispose();
  const events = [];
  const next = createScenarioCommandService({ scenariosApi: f.scenariosApi, channelsApi: f.channelsApi, publish: (event) => events.push(event) });
  listHold.resolve(listHold.result); getHold.resolve(getHold.result); writeHold.resolve(writeHold.result);
  await Promise.all([listing, getting, writing]);
  assert.equal(f.events.length, 0);
  await next.scenarios.update(1, {});
  assert.equal(events[0].kind, 'scenarios-resync-required');
  assert.equal(f.count('transfer'), 1);
  assert.throws(() => f.service.scenarios.update(1, {}), { code: 'SCENARIO_COMMAND_SERVICE_DISPOSED' });
});

test('非法字段/部分 list 不进入缓存，明确不存在不伪造普通类别', async () => {
  const f = fixture();
  f.failures.set('list', { status: 'ok', scenarios: [{ id: 1 }] });
  await f.service.scenarios.list();
  f.failures.set('get', { status: 'ok', scenario: { id: 1, category: undefined } });
  await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
  await f.service.scenarios.list({ category: 'recon-id-fix' });
  f.failures.set('get', { status: 'failed', message: '场景 id=1 不存在' });
  await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
});

test('只读预检/导出与无变更关闭不清结果；事件深冻结且通道 ID 去重', async () => {
  const f = fixture();
  await f.service.scenarios.importBundle(); await f.service.scenarios.exportBundle([1]);
  await f.service.scenarios.getApplicableChannels(1); await f.service.channels.list();
  assert.equal(f.events.length, 0);
  f.service.closed();
  assert.deepEqual(Object.keys(f.last()).sort(), ['kind', 'revision']);
  await f.service.channels.update(2, { name: '渠道' });
  assert.deepEqual(f.last(), { kind: 'configuration-changed', resource: 'channels', command: 'channels:update', channelIds: [2], invalidationScope: [], revision: 2 });
  assert.ok(Object.isFrozen(f.last())); assert.ok(Object.isFrozen(f.last().channelIds));
  await f.service.scenarios.transfer({ scenarioIds: [1, 1], targetChannelId: 2 });
  assert.deepEqual(f.last().scenarioIds, [1]);
  assert.ok(Object.isFrozen(f.last().categories)); assert.ok(Object.isFrozen(f.last().invalidationScope));
});

test('连续适用渠道成功后 priority 失败，第一项通知和原参数保留', async () => {
  const f = fixture();
  const channelIds = [2, 3]; const fields = { priority: 2 };
  await f.service.scenarios.setApplicableChannels(1, channelIds);
  f.failures.set('update', { status: 'failed', message: '优先级保存失败' });
  const result = await f.service.scenarios.update(1, fields);
  assert.equal(result.status, 'failed');
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.last().invalidationScope, ['bank-statement']);
  assert.equal(f.calls.find((call) => call.name === 'setApplicableChannels').args[1], channelIds);
  assert.equal(f.calls.find((call) => call.name === 'update').args[1], fields);
});

test('通知者异常不改写业务成功响应，不阻止下一条事件', async () => {
  const f = fixture(); const errors = [];
  const service = createScenarioCommandService({ scenariosApi: f.scenariosApi, channelsApi: f.channelsApi,
    publish() { throw new Error('订阅失败'); }, reportError(error) { errors.push(error); } });
  assert.equal((await service.scenarios.create({ category: 'recon-id-fix' })).status, 'ok');
  assert.equal((await service.channels.deleteOne(2)).status, 'ok');
  assert.equal(errors.length, 2);
});

test('router 按 scope/事件 kind 通知，频道配置与仅关闭保持结果；重复和退订生效', () => {
  const bank = []; const recon = []; const lists = []; const channels = [];
  const router = createScenarioChangeRouter({ bankStatement: { invalidate: (event) => bank.push(event) },
    reconIdFix: { invalidate: (event) => recon.push(event) } });
  const offScenarios = router.subscribeScenarios((event) => lists.push(event));
  const offChannels = router.subscribeChannels((event) => channels.push(event));
  const categoryMisleading = { kind: 'scenarios-changed', categories: ['extract-recon-id'], invalidationScope: BOTH, revision: 1 };
  assert.equal(router.route(categoryMisleading), true);
  assert.equal(router.route(categoryMisleading), false);
  router.route({ kind: 'scenarios-changed', invalidationScope: ['recon-id-fix'], revision: 2 });
  assert.equal(bank.length, 2); assert.equal(recon.length, 2);
  router.route({ kind: 'configuration-changed', resource: 'channels', invalidationScope: [], revision: 3 });
  router.route({ kind: 'scenarios-closed', revision: 4 });
  assert.equal(bank.length, 2); assert.equal(recon.length, 2);
  assert.equal(lists.length, 3); assert.equal(channels.length, 1);
  router.route({ kind: 'scenarios-resync-required', resyncScope: BOTH, revision: 5 });
  assert.equal(bank.at(-1).kind, 'scenarios-resync-required');
  offScenarios(); offScenarios(); offChannels();
  router.route({ kind: 'scenarios-closed', revision: 6 });
  assert.equal(lists.length, 4);
  router.dispose(); router.dispose();
  assert.equal(router.route({ kind: 'scenarios-closed', revision: 7 }), false);
});

test('共享会话五个命名 API 原参原结果，mutation 结算唯一通知，不复制结果', async () => {
  const calls = []; const events = []; const failure = new Error('断开');
  const api = Object.fromEntries(['import', 'run', 'export', 'sessionStatus', 'clearSession'].map((method) => [method,
    (...args) => { calls.push({ method, args }); return method === 'clearSession' ? Promise.reject(failure) : Promise.resolve({ status: method === 'run' ? 'failed' : 'ok' }); }]));
  const session = createSharedReconSession({ api });
  const off = session.subscribe((event) => events.push(event));
  const payload = { originModuleId: 'bank-statement-process', subMode: 'gateway' };
  await session.import(payload); await session.run(payload); await session.export(); await session.sessionStatus();
  await assert.rejects(session.clearSession(), (error) => error === failure);
  assert.equal(calls[0].args[0], payload); assert.equal(calls[1].args[0], payload);
  assert.deepEqual(events.map((event) => [event.kind, event.outcome]), [['import', 'succeeded'], ['run', 'failed'], ['clearSession', 'unknown']]);
  assert.equal(events[1].source, 'bank-statement-process');
  off(); off(); await session.import(payload);
  assert.equal(events.length, 3);
  session.dispose(); session.dispose();
});

test('经典脚本只声明明确命名空间，加载阶段不触发 IPC', () => {
  const sandbox = { window: {}, Map, Set, WeakMap, Object, Number, Promise, TypeError, Error };
  vm.createContext(sandbox);
  for (const file of ['scenario-command-service', 'scenario-change-router', 'shared-recon-session']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../src/renderer', `${file}.js`), 'utf8'), sandbox);
  }
  assert.equal(typeof sandbox.window.ScenarioCommandService.createScenarioCommandService, 'function');
  assert.equal(typeof sandbox.window.ScenarioChangeRouter.createScenarioChangeRouter, 'function');
  assert.equal(typeof sandbox.window.SharedReconSession.createSharedReconSession, 'function');
});

test('create 不合法提交类别却成功的矛盾响应进入 sticky resync', async () => {
  const f = fixture({ rows: [] });
  await f.service.scenarios.create({ category: undefined });
  assert.equal(f.last().kind, 'scenarios-resync-required');
  f.rows.set(1, { id: 1, category: 'extract-recon-id' });
  await f.service.scenarios.list(); await f.service.scenarios.update(1, {});
  assert.equal(f.last().kind, 'scenarios-resync-required');
});

test('共享写通知来源取 dispatch 快照，不取回包时已改的 UI payload', async () => {
  const hold = deferred(); const events = [];
  const service = createSharedReconSession({ api: { run: () => hold.promise } });
  service.subscribe((event) => events.push(event));
  const payload = { originModuleId: 'bank-statement-process' };
  const pending = service.run(payload);
  payload.originModuleId = 'recon-id-fix';
  hold.resolve({ status: 'ok' }); await pending;
  assert.equal(events[0].source, 'bank-statement-process');
});
