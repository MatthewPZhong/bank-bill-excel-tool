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
    for (const name of ['new-domain:unknown-heavy', 'toolbox:split:read', 'toolbox:split:cancel-read', 'bizOpReconV327:run']) {
      ipc.handle(name, () => memoryActivitySnapshot().blockers.length);
    }
  });
  assert.equal(ipc.handle, original);
  assert.equal(await callbacks.get('new-domain:unknown-heavy')({}), 1);
  assert.equal(await callbacks.get('toolbox:split:read')({}, { version: 2 }), 0);
  assert.equal(await callbacks.get('toolbox:split:read')({}), 1);
  assert.equal(await callbacks.get('toolbox:split:cancel-read')({}), 0);
  assert.equal(await callbacks.get('bizOpReconV327:run')({}), 0);
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
