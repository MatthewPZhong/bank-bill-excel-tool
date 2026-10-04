'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceGovernor, closeResourceGovernor } = require('../../../../src/main-process/background-execution/resource-governor');
const { createExperimentalMemoryPolicy } = require('../../../../src/main-process/execution-descriptors/memory-profiles');
const { registerMemoryGovernor, runMemoryActivity, memoryActivitySnapshot, inventoryForGovernor,
  sealMemoryActivityInventory, captureLegacyMemoryContinuation,
  isLegacyMemoryContinuationBlocking } = require('../../../../src/main-process/memory-activity');

const MiB = 1024 ** 2;
const resources = { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1024 * MiB };
const target = { ownerKey: 'auto-report', actionKey: 'biz-op-v327:export-errors', operationKey: 'auto-report',
  resources, timeoutMs: 5000 };
const continuation = { ...target, ownerKey: 'biz-op-v327:shared-publication-observation',
  actionKey: 'publication:legacy-observation', operationKey: 'biz-op-v327:shared-publication-observation' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(t, mode, compatibilityMiB = 2048) {
  let time = 0, sequence = 0;
  const timers = new Map();
  const state = { extra: [] };
  const clock = { now: () => time,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (;;) {
        const due = [...timers].find(([, timer]) => timer.at <= time);
        if (!due) break;
        timers.delete(due[0]); due[1].callback();
      }
    }
  };
  sealMemoryActivityInventory();
  const governor = createResourceGovernor({ ...clock, memoryRecheckMs: 5,
    budgets: { ...resources, cpuSlots: 2, workerThreadSlots: 2, ioHeavySlots: 2, memoryBytes: 2048 * MiB },
    memoryAdmission: createExperimentalMemoryPolicy({ modes: [mode], compatibilityMemoryBytes: compatibilityMiB * MiB,
      sampleMemory: () => ({ availableBytes: 4096 * MiB, sampledAt: Date.now() }),
      inventory() { const value = inventoryForGovernor(() => governor); value.blockers.push(...state.extra); return value; }
    }) });
  const unregister = registerMemoryGovernor(governor);
  t.after(() => {
    closeResourceGovernor(governor);
    assert.equal(governor.snapshot().activeLeaseCount, 0);
    assert.deepEqual(memoryActivitySnapshot().blockers, []);
    assert.equal(unregister(), true);
  });
  return { governor, state, clock };
}

for (const mode of ['normal', 'low']) {
  for (const middle of [false, true]) test(`${mode} 同优先级队首依赖父活动，内部观察先完成${middle ? '（含中间普通请求）' : ''}`, async (t) => {
    const { governor: g, clock } = fixture(t, mode);
    const order = [];
    let head, ordinary;
    await runMemoryActivity(async () => {
      head = g.acquirePhaseLease(target).then((lease) => { order.push('head'); return lease; });
      if (middle) ordinary = g.acquirePhaseLease({ ...target, actionKey: 'legacy:other', resources: { ...resources, memoryBytes: 1 } })
        .then((lease) => { order.push('ordinary'); return lease; });
      await tick();
      assert.equal(g.snapshot().activeLeaseCount, 0);
      const lease = await g.acquirePhaseLease(continuation);
      order.push('continuation');
      assert.equal(lease.memoryConfig, null);
      assert.equal(lease.resources.memoryBytes, 1024 * MiB);
      assert.equal(g.snapshot().queued.size, middle ? 2 : 1);
      lease.release();
      assert.deepEqual(order, ['continuation'], '父活动未结束前不能启动获批 phase');
    });
    clock.advance(5);
    const lease = await head;
    assert.equal(lease.memoryMode, mode);
    lease.release();
    if (ordinary) (await ordinary).release();
    assert.deepEqual(order, middle ? ['continuation', 'head', 'ordinary'] : ['continuation', 'head']);
  });

  test(`${mode} 队首取消后内部观察继续，结束后无租约或活动残留`, async (t) => {
    const { governor: g } = fixture(t, mode);
    await runMemoryActivity(async () => {
      const controller = new AbortController();
      const head = g.acquirePhaseLease({ ...target, signal: controller.signal });
      const checked = assert.rejects(head, { code: 'ADMISSION_CANCELLED' });
      const child = g.acquirePhaseLease(continuation);
      controller.abort();
      (await child).release(); await checked;
    });
  });
}

for (const dimension of ['cpuSlots', 'workerThreadSlots', 'ioHeavySlots', 'memoryBytes']) {
  test(`内部观察仍等待实际 ${dimension} 额度，释放后才可解除队首依赖`, async (t) => {
    const { governor: g, clock } = fixture(t, 'normal');
    const held = await g.acquirePhaseLease({ ...target, actionKey: 'legacy:hold', resources: {
      cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 0,
      [dimension]: dimension === 'memoryBytes' ? 1536 * MiB : 2
    } });
    let head;
    await runMemoryActivity(async () => {
      head = g.acquirePhaseLease(target);
      const child = g.acquirePhaseLease(continuation);
      await tick();
      assert.equal(g.snapshot().activeLeaseCount, 1);
      assert.equal(g.snapshot().queued.size, 2);
      held.release();
      (await child).release();
    });
    clock.advance(5); (await head).release();
  });
}

test('受信任内部观察仍受 Bcompat 和上一 runtime 低档排他约束', async (t) => {
  const { governor: g, state, clock } = fixture(t, 'low', 512);
  await runMemoryActivity(async () => {
    await assert.rejects(g.acquirePhaseLease(continuation), { code: 'RESOURCE_BUDGET_UNAVAILABLE' });
    state.extra = [{ heavy: true, maxGrowthBytes: null, mode: 'low', kind: 'previous-runtime' }];
    const head = g.acquirePhaseLease({ ...target, timeoutMs: 20 });
    const child = g.acquirePhaseLease({ ...continuation, timeoutMs: 10, resources: { ...resources, memoryBytes: 512 * MiB } });
    const checked = Promise.all([assert.rejects(head, { code: 'ADMISSION_TIMEOUT' }), assert.rejects(child, { code: 'ADMISSION_TIMEOUT' })]);
    await tick(); assert.equal(g.snapshot().activeLeaseCount, 0);
    clock.advance(10); await tick();
    assert.equal(g.snapshot().queued.size, 1, '内部观察的独立截止时间先到期');
    clock.advance(10); await checked;
  });
});

test('无关队首保持 FIFO，内部观察不把自己变成通用高优先级请求', async (t) => {
  const { governor: g, clock } = fixture(t, 'normal');
  const held = await g.acquirePhaseLease({ ...target, actionKey: 'legacy:hold', resources: { ...resources, memoryBytes: 1 } });
  let head;
  await runMemoryActivity(async () => {
    // 队首必须等两个 CPU 槽位；内部观察只需剩余的一个，但不能抢先。
    head = g.acquirePhaseLease({ ...target, actionKey: 'legacy:other', resources: { ...resources, cpuSlots: 2, memoryBytes: 1 } });
    const child = g.acquirePhaseLease({ ...continuation, timeoutMs: 10 });
    const checked = assert.rejects(child, { code: 'ADMISSION_TIMEOUT' });
    await tick(); assert.equal(g.snapshot().activeLeaseCount, 1);
    clock.advance(10); await checked;
  });
  held.release(); (await head).release();
});

test('请求字段伪造 continuation 或修改静态 owner/action/operation 都不能插队', async (t) => {
  const { governor: g, clock } = fixture(t, 'normal');
  await runMemoryActivity(async () => {
    const head = g.acquirePhaseLease({ ...target, timeoutMs: 100 });
    const rejectedHead = assert.rejects(head, { code: 'ADMISSION_TIMEOUT' });
    for (const override of [{ ownerKey: 'forged' }, { actionKey: 'forged' }, { operationKey: 'forged' }]) {
      const child = g.acquirePhaseLease({ ...continuation, ...override, continuation: captureLegacyMemoryContinuation(),
        canBypass: true, timeoutMs: 10 });
      const checked = assert.rejects(child, { code: 'ADMISSION_TIMEOUT' });
      await tick(); clock.advance(10); await checked;
      assert.equal(g.snapshot().activeLeaseCount, 0);
    }
    clock.advance(70); await rejectedHead;
  });
});

test('当前活动、原始快照和存活身份缺一不可；作用域结束后能力失效', async () => {
  sealMemoryActivityInventory();
  assert.equal(captureLegacyMemoryContinuation(), null);
  let capability, snapshot;
  await runMemoryActivity(async () => {
    capability = captureLegacyMemoryContinuation(); snapshot = memoryActivitySnapshot();
    assert.equal(isLegacyMemoryContinuationBlocking(capability, snapshot), true);
    assert.equal(isLegacyMemoryContinuationBlocking({}, snapshot), false);
    assert.equal(isLegacyMemoryContinuationBlocking(capability, structuredClone(snapshot)), false);
    assert.equal(isLegacyMemoryContinuationBlocking(capability, { ...snapshot, inventoryComplete: false }), false);
  });
  assert.equal(isLegacyMemoryContinuationBlocking(capability, snapshot), false);
  assert.equal(captureLegacyMemoryContinuation(), null);
});


for (const context of ['outside', 'expired']) test(`静态 action 在 ${context} legacy 作用域时仍排队`, async (t) => {
  const { governor: g, clock, state } = fixture(t, 'normal');
  state.extra = [{ heavy: true, maxGrowthBytes: null, kind: 'unrelated' }];
  const held = await g.acquirePhaseLease({ ...target, actionKey: 'legacy:hold',
    resources: { ...resources, cpuSlots: 2, memoryBytes: 1 } });
  let head, child, checked;
  async function enqueue() {
    head = g.acquirePhaseLease(target);
    child = g.acquirePhaseLease({ ...continuation, timeoutMs: 10 });
    checked = assert.rejects(child, { code: 'ADMISSION_TIMEOUT' });
    await tick();
  }
  if (context === 'expired') await runMemoryActivity(enqueue);
  else await enqueue();
  held.release();
  assert.equal(g.snapshot().activeLeaseCount, 0, '作用域外不能用静态 action 越过未知增长');
  clock.advance(10); await checked;
  state.extra = []; clock.advance(5); (await head).release();
});
