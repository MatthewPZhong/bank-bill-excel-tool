'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy } = require('../../../src/main-process/execution-descriptors/memory-profiles');
const { observeMemoryCarrier, registerMemoryGovernor, runMemoryActivity, memoryActivitySnapshot,
  inventoryForGovernor, registerWithMemoryActivity, sealMemoryActivityInventory } = require('../../../src/main-process/memory-activity');
const MiB = 1024 ** 2;
const resources = { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1024 * MiB };
const request = { ownerKey: 'toolbox-split-read', actionKey: 'toolbox:split:prepare', operationKey: 'scan', resources,
  timeoutMs: 50, lowMemoryBehavior: 'queue' };
function governor(t) {
  sealMemoryActivityInventory();
  const g = createResourceGovernor({ budgets: { ...resources, cpuSlots: 4, workerThreadSlots: 4,
    ioHeavySlots: 4, memoryBytes: 2048 * MiB }, memoryRecheckMs: 5,
  memoryAdmission: createExperimentalMemoryPolicy({ sampleMemory: () => ({ availableBytes: 512 * MiB, sampledAt: Date.now() }),
    inventory: () => inventoryForGovernor(() => g) }) });
  const unregister = registerMemoryGovernor(g); t.after(() => assert.equal(unregister(), true)); return g;
}

test('未受管载体 done/error/terminate 请求不能释放观察；真实 exit 才放行低档', async (t) => {
  const g = governor(t);
  const carrier = observeMemoryCarrier(() => new EventEmitter());
  carrier.emit('done'); carrier.emit('message', { type: 'done' });
  await assert.rejects(g.acquirePhaseLease(request), { code: 'ADMISSION_TIMEOUT' });
  assert.equal(memoryActivitySnapshot().blockers.length, 1);
  carrier.emit('exit', 1);
  const lease = await g.acquirePhaseLease(request);
  assert.equal(lease.memoryMode, 'low'); lease.release();
});

test('低档反向阻断旧 Worker 和 Main 工作，已获批载体可创建；退出后允许重试', async (t) => {
  const g = governor(t); const lease = await g.acquirePhaseLease(request);
  let started = 0;
  assert.throws(() => observeMemoryCarrier(() => { started++; return new EventEmitter(); }), { code: 'RESOURCE_MEMORY_ACTIVITY_BUSY' });
  await assert.rejects(runMemoryActivity(() => { started++; }, { timeoutMs: 1 }), { code: 'RESOURCE_MEMORY_ACTIVITY_BUSY' });
  assert.equal(started, 0);
  const owned = observeMemoryCarrier(() => new EventEmitter(), lease.memoryConfig);
  assert.equal(memoryActivitySnapshot().blockers.length, 1);
  owned.emit('exit', 0); lease.release();
  await runMemoryActivity(() => { started++; }); assert.equal(started, 1);
});

test('Main 增长未知工作与上一 runtime 活动都参与排他；新 runtime 不能遗忘旧代', async (t) => {
  const first = governor(t), second = governor(t);
  let end;
  const work = runMemoryActivity(() => new Promise((resolve) => { end = resolve; }));
  await assert.rejects(first.acquirePhaseLease(request), { code: 'ADMISSION_TIMEOUT' });
  end(); await work;
  const lease = await first.acquirePhaseLease(request);
  await assert.rejects(second.acquirePhaseLease(request), { code: 'ADMISSION_TIMEOUT' });
  lease.release(); const next = await second.acquirePhaseLease(request); next.release();
});

test('所有 IPC 默认观察，目标新路径自身准入；控制和取消不被旧活动锁住', async () => {
  const callbacks = new Map(); const ipc = { handle: (name, callback) => callbacks.set(name, callback) };
  const original = ipc.handle;
  registerWithMemoryActivity(ipc, () => {
    // v3.2.20：业务OP v327 通道随模块下线删除，不再豁免观察。
    for (const name of ['new-domain:unknown-heavy', 'toolbox:split:read', 'toolbox:split:cancel-read', 'bizOpReconV327:run']) {
      ipc.handle(name, () => memoryActivitySnapshot().blockers.length);
    }
  });
  assert.equal(ipc.handle, original);
  assert.equal(await callbacks.get('new-domain:unknown-heavy')({}), 1);
  assert.equal(await callbacks.get('toolbox:split:read')({}, { version: 2 }), 0);
  assert.equal(await callbacks.get('toolbox:split:read')({}), 1);
  assert.equal(await callbacks.get('toolbox:split:cancel-read')({}), 0);
  assert.equal(await callbacks.get('bizOpReconV327:run')({}), 1, '已下线通道名不再自带准入豁免');
});

test('拆分账单行管理激活 / 结束撤销会话属控制操作：低档租约占用时照常执行，同通道的配置读取仍等待屏障', async (t) => {
  const g = governor(t); const lease = await g.acquirePhaseLease(request);
  const callbacks = new Map(); const calls = [];
  const ipc = { handle: (name, callback) => callbacks.set(name, callback) };
  registerWithMemoryActivity(ipc, () => ipc.handle('template:get-bill-split-config', (_event, templateId, options) => {
    calls.push([templateId, options]); return { status: 'success' };
  }));
  const handler = callbacks.get('template:get-bill-split-config');
  let pending = [];
  try {
    assert.deepEqual(await handler({}, 7, { activateRestoreSession: 'token-7' }), { status: 'success' });
    assert.deepEqual(await handler({}, 7, { endRestoreSession: 'token-7' }), { status: 'success' });
    // 配置读取与打开会话在租约占用期间排队，不进入 handler（不等满超时，释放后应照常执行）
    pending = [handler({}, 7), handler({}, 7, { openRestoreSession: true })];
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, [[7, { activateRestoreSession: 'token-7' }], [7, { endRestoreSession: 'token-7' }]], '控制操作照常执行，读取未执行');
  } finally { lease.release(); }
  assert.deepEqual(await Promise.all(pending), [{ status: 'success' }, { status: 'success' }]);
  assert.deepEqual(calls.slice(2), [[7, undefined], [7, { openRestoreSession: true }]], '租约释放后读取与打开会话照常执行');
});

test('同一模板的拆分写入与行管理打开时的快照读取按受理顺序执行：快照读取等此前受理的写入结算；其他模板、普通读取不排队', async () => {
  const callbacks = new Map(); const events = []; const gates = [];
  const defer = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
  const ipc = { handle: (name, callback) => callbacks.set(name, callback) };
  registerWithMemoryActivity(ipc, () => {
    ipc.handle('template:save-bill-split-row-count', async (_event, payload) => {
      events.push(`write:${payload.templateId}`); const gate = defer(); gates.push(gate); await gate.promise; events.push(`written:${payload.templateId}`);
      return { status: 'success' };
    });
    ipc.handle('template:get-bill-split-config', (_event, templateId, options) => {
      events.push(`read:${templateId}:${options && options.openRestoreSession ? 'open' : 'plain'}`); return { status: 'success' };
    });
  });
  const write = callbacks.get('template:save-bill-split-row-count');
  const read = callbacks.get('template:get-bill-split-config');
  const pendingWrite = write({}, { templateId: 7, nextN: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  const pendingOpen = read({}, 7, { openRestoreSession: true });
  await Promise.all([read({}, 7), read({}, 8, { openRestoreSession: true })]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['write:7', 'read:7:plain', 'read:8:open'], '同模板快照读取等待写入；普通读取与其他模板不排队');
  gates[0].resolve();
  await Promise.all([pendingWrite, pendingOpen]);
  assert.deepEqual(events.slice(3), ['written:7', 'read:7:open'], '写入结算后再读取并签发快照');
  // 前一项写入失败（异常）也不阻塞后续：失败照常反馈给调用方，排在其后的快照读取照常执行
  const failed = write({}, { templateId: 9 });
  await new Promise((resolve) => setImmediate(resolve));
  const afterFailure = read({}, 9, { openRestoreSession: true });
  gates[1].reject(new Error('写入失败'));
  await assert.rejects(failed, /写入失败/);
  assert.deepEqual(await afterFailure, { status: 'success' });
});

test('同一模板排队的快照读取在低档租约占用时从受理起算超时：两次连续打开都约 5 秒返回忙碌，不逐次累加', async (t) => {
  const g = governor(t); const lease = await g.acquirePhaseLease(request);
  const callbacks = new Map(); let calls = 0;
  const ipc = { handle: (name, callback) => callbacks.set(name, callback) };
  registerWithMemoryActivity(ipc, () => ipc.handle('template:get-bill-split-config', () => { calls += 1; return { status: 'success' }; }));
  const read = callbacks.get('template:get-bill-split-config');
  const started = Date.now();
  const settled = (promise) => promise.then(() => 'ok', (error) => ({ code: error.code, elapsed: Date.now() - started }));
  try {
    const results = await Promise.all([settled(read({}, 21, { openRestoreSession: true })), settled(read({}, 21, { openRestoreSession: true }))]);
    assert.deepEqual(results.map((item) => item.code), ['RESOURCE_MEMORY_ACTIVITY_BUSY', 'RESOURCE_MEMORY_ACTIVITY_BUSY']);
    assert.ok(results[1].elapsed < 6500, `第二次打开在受理后约 5 秒返回（实际 ${results[1].elapsed}ms），不在第一次之后再等满 5 秒`);
    assert.equal(calls, 0);
  } finally { lease.release(); }
});

test('IPC 等待不足经异常通道反馈，不伪造数组或标量结果，释放后可直接重试', async (t) => {
  const g = governor(t); const lease = await g.acquirePhaseLease(request);
  const callbacks = new Map(); let started = 0;
  const ipc = { handle: (name, callback) => callbacks.set(name, callback) };
  registerWithMemoryActivity(ipc, () => ipc.handle('legacy:raw-array', () => { started++; return ['value']; }));
  try {
    await assert.rejects(callbacks.get('legacy:raw-array')({}), { code: 'RESOURCE_MEMORY_ACTIVITY_BUSY' });
    assert.equal(started, 0);
  } finally { lease.release(); }
  assert.deepEqual(await callbacks.get('legacy:raw-array')({}), ['value']);
});
