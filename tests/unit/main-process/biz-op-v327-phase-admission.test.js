'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { acquireBizOpPhaseLease, BIZ_OP_RESOURCE_WAIT_MS } = require('../../../src/main-process/biz-op-v327/phase-admission');
const { createResourceGovernor, closeResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { createPlatformResourceBudgets } = require('../../../src/main-process/background-execution/resource-budget');
const { createBizOpPublication, EXPORT_IO_RESOURCES } = require('../../../src/main-process/biz-op-v327/export-publication');

const budgets = { cpuSlots: 2, workerThreadSlots: 2, utilityProcessSlots: 0, ioHeavySlots: 2, memoryBytes: 2 * 1024 ** 3 };
const request = { ownerKey: 'test-phase', actionKey: 'biz-op-v327:export-result-diff',
  operationKey: 'test-operation', resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'queue' };

function fixture(overrides = {}) {
  let now = 0;
  const timers = new Set();
  const governor = createResourceGovernor({ budgets: { ...budgets, ...overrides }, now: () => now,
    setTimer(callback, ms) { const timer = { callback, at: now + ms }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); }
  });
  return { governor, runtime: { resourceGovernor: governor },
    async advance(ms) {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('当前平台内存公式得到零预算，真实共享恢复入口立即拒绝且不开始 I/O', async () => {
  const platform = createPlatformResourceBudgets({ availableParallelism: 12, totalMemoryBytes: 48 * 1024 ** 3,
    freeMemoryBytes: 978108416 });
  const { governor, runtime } = fixture(platform);
  let reads = 0;
  const publication = createBizOpPublication({ catalog: { now: Date.now, db: {
    prepare(sql) {
      assert.match(sql, /SELECT 1 FROM biz_op_v327_publications WHERE cleanup_completed=0/);
      return { get() { reads += 1; return { pending: true }; } };
    }
  } }, getRuntime: () => runtime });
  await assert.rejects(publication.recoverOtherOwners({ deferCommittedRecovery: true }), (error) => {
    assert.equal(error.code, 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT');
    assert.match(error.detailLines.join('\n'), /需要 1024.0 MiB，本次预算 0.0 MiB/);
    return true;
  });
  assert.equal(reads, 1);
  assert.equal(governor.snapshot().queued.size, 0);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('非零但不足的固定预算和槽位不足都不能排入永远无法满足的队列', async () => {
  for (const limit of [{ memoryBytes: 768 * 1024 ** 2 }, { workerThreadSlots: 0 }, { cpuSlots: 0 }, { ioHeavySlots: 0 }]) {
    const f = fixture(limit);
    await assert.rejects(acquireBizOpPhaseLease(f.runtime, request), { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
    assert.equal(f.governor.snapshot().queued.size, 0);
  }
  const f = fixture();
  await assert.rejects(acquireBizOpPhaseLease(f.runtime, {
    ...request, resources: { ...EXPORT_IO_RESOURCES, utilityProcessSlots: 1 }
  }), { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
  assert.equal(f.governor.snapshot().queued.size, 0);
});

test('已有队列时永久不足仍立即拒绝，不改变原队列或资源持有者', async () => {
  const f = fixture({ memoryBytes: 512 * 1024 ** 2 });
  const small = { ...request, resources: { ...EXPORT_IO_RESOURCES, memoryBytes: 512 * 1024 ** 2 } };
  const blocker = await f.governor.acquirePhaseLease(small);
  const cancellation = new AbortController();
  const queued = f.governor.acquirePhaseLease({ ...small, signal: cancellation.signal });
  const cancelled = assert.rejects(queued, { code: 'ADMISSION_CANCELLED' });
  await assert.rejects(acquireBizOpPhaseLease(f.runtime, request), { code: 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT' });
  assert.equal(f.governor.snapshot().queued.size, 1);
  cancellation.abort(); await cancelled;
  blocker.release('test-complete');
});

test('暂时竞争在 5 秒内释放后继续；拿到 lease 后不因等待期限到达而提前释放', async () => {
  const f = fixture();
  const blocker = await f.governor.acquirePhaseLease({ ...request, resources: budgets });
  const pending = acquireBizOpPhaseLease(f.runtime, request);
  assert.equal(f.governor.snapshot().queued.size, 1);
  await f.advance(BIZ_OP_RESOURCE_WAIT_MS - 1);
  blocker.release('other-work-complete');
  const lease = await pending;
  await f.advance(BIZ_OP_RESOURCE_WAIT_MS * 2);
  assert.equal(f.governor.snapshot().activeLeaseCount, 1);
  assert.deepEqual(f.governor.snapshot().activeUsage, EXPORT_IO_RESOURCES);
  lease.release('actual-work-complete');
  assert.equal(f.governor.snapshot().activeLeaseCount, 0);
});

test('排队满 5 秒后明确失败并移除；后来释放容量不会迟到执行或泄露 lease', async () => {
  const f = fixture();
  const blocker = await f.governor.acquirePhaseLease({ ...request, resources: budgets });
  let admitted = false;
  const pending = acquireBizOpPhaseLease(f.runtime, request).then((lease) => { admitted = true; return lease; });
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'BIZOP_RESOURCE_WAIT_TIMEOUT');
    assert.equal(error.cause.code, 'ADMISSION_TIMEOUT');
    assert.match(error.message, /5 秒/);
    return true;
  });
  await f.advance(BIZ_OP_RESOURCE_WAIT_MS);
  await rejected;
  assert.equal(f.governor.snapshot().queued.size, 0);
  blocker.release('late-capacity');
  await f.advance(BIZ_OP_RESOURCE_WAIT_MS);
  assert.equal(admitted, false);
  assert.equal(f.governor.snapshot().activeLeaseCount, 0);
});

test('取消和 shutdown 保留原错误，零预算不掩盖已关闭或已取消的请求', async () => {
  const f = fixture({ memoryBytes: 0 });
  const signal = AbortSignal.abort();
  await assert.rejects(acquireBizOpPhaseLease(f.runtime, { ...request, signal }), { code: 'ADMISSION_CANCELLED' });
  closeResourceGovernor(f.governor, 'supervisor-shutdown');
  await assert.rejects(acquireBizOpPhaseLease(f.runtime, request), { code: 'RESOURCE_GOVERNOR_CLOSED' });
  const occupied = fixture();
  const blocker = await occupied.governor.acquirePhaseLease({ ...request, resources: budgets });
  const pending = acquireBizOpPhaseLease(occupied.runtime, request);
  const rejected = assert.rejects(pending, { code: 'ADMISSION_QUEUE_CLOSED', message: 'supervisor-shutdown' });
  closeResourceGovernor(occupied.governor, 'supervisor-shutdown');
  await rejected;
  blocker.release('closed');
});
