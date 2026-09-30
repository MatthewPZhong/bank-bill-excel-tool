'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceGovernor } = require('../../../../src/main-process/background-execution/resource-governor');
const { createAdmissionOnlyOwner } = require('../../../../src/main-process/background-execution/admission-only-owner');
const resources = { cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 100 };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(start, cleanup) {
  const governor = createResourceGovernor({ budgets: resources });
  const owner = createAdmissionOnlyOwner({ governor, descriptor: {
    ownerKey: 'prepare', actionKey: 'metadata', resources, timeoutMs: 5000
  }, start, cleanup });
  return { governor, owner };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('completed scan holds quota and temporary ownership until real carrier closure', async () => {
  const result = deferred(), closed = deferred();
  let cleaned = false;
  const { governor, owner } = setup(() => ({ promise: result.promise, closed: closed.promise, cancel() {} }),
    () => { assert.equal(governor.snapshot().activeLeaseCount, 1); cleaned = true; });
  const pending = owner.run({});
  await flush();
  result.resolve({ headers: ['列'] });
  await flush();
  assert.equal(cleaned, false);
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  assert.deepEqual(owner.snapshot().states, ['closing']);
  closed.resolve();
  assert.deepEqual(await pending, { headers: ['列'] });
  assert.equal(cleaned, true);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('cancellation waits for closure, cleans once and never exposes a late successful result', async () => {
  const result = deferred(), closed = deferred();
  let cancelled = 0, cleaned = 0;
  const { governor, owner } = setup(() => ({ promise: result.promise, closed: closed.promise, cancel() { cancelled++; } }), () => { cleaned++; });
  const controller = new AbortController();
  const pending = owner.run({}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ADMISSION_CANCELLED' });
  await flush();
  controller.abort(); controller.abort();
  result.resolve('late');
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(governor.snapshot().activeLeaseCount, 1);
  closed.resolve();
  await rejected;
  assert.equal(cleaned, 1);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('pre-aborted admission never creates a carrier or temporary files', async () => {
  const { governor, owner } = setup(() => { assert.fail('不能启动'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(owner.run({}, { signal: controller.signal }), { code: 'ADMISSION_CANCELLED' });
  assert.equal(governor.snapshot().activeLeaseCount, 0);
  assert.equal(owner.snapshot().activeCount, 0);
});

test('worker construction failure with confirmed no-carrier closes and releases', async () => {
  const boom = new Error('spawn failed');
  const { governor, owner } = setup(() => ({ promise: Promise.reject(boom), closed: Promise.resolve(), cancel() {} }));
  await assert.rejects(owner.run({}), (error) => error === boom);
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('missing or rejected closure proof keeps the lease visible and close reports it', async () => {
  for (const broken of [
    () => ({ promise: Promise.resolve('value'), cancel() {} }),
    () => ({ promise: Promise.resolve('value'), closed: Promise.reject(new Error('unconfirmed')), cancel() {} })
  ]) {
    const { governor, owner } = setup(broken, () => { assert.fail('未确认退出不能清理'); });
    await assert.rejects(owner.run({}), /关闭承诺|关闭未确认/);
    assert.equal(governor.snapshot().activeLeaseCount, 1);
    assert.deepEqual(await owner.close(), { closed: false, unclosedCount: 1 });
    governor.release(governor.snapshot().activeLeases[0].leaseId, 'test-fixture-no-real-carrier');
  }
});

test('cleanup failure does not report success; a confirmed exited carrier can release its quota', async () => {
  const { governor, owner } = setup(() => ({ promise: Promise.resolve('value'), closed: Promise.resolve(), cancel() {} }),
    () => { throw new Error('cleanup failed'); });
  await assert.rejects(owner.run({}), { name: 'AggregateError' });
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});

test('owner shutdown cancels active scans and refuses new admissions', async () => {
  const closed = deferred();
  const { governor, owner } = setup(() => ({ promise: Promise.resolve('value'), closed: closed.promise, cancel() { closed.resolve(); } }));
  const pending = owner.run({});
  const rejected = assert.rejects(pending, { code: 'ADMISSION_CANCELLED' });
  await flush();
  assert.deepEqual(await owner.close(), { closed: true, unclosedCount: 0 });
  await rejected;
  await assert.rejects(owner.run({}), { code: 'RESOURCE_PREPARE_OWNER_CLOSED' });
  assert.equal(governor.snapshot().activeLeaseCount, 0);
});
