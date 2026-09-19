'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createExecutionPolicyRegistry, createStaticRegistry } = require('../../../../src/main-process/background-execution/execution-policy-registry');
const { createExecutionSupervisor } = require('../../../../src/main-process/background-execution/supervisor');
const { createResourceGovernor, closeResourceGovernor } = require('../../../../src/main-process/background-execution/resource-governor');
const { createJobEnvelope } = require('../../../../src/main-process/background-execution/protocol');
const { fromProtocolError, toProtocolError, validateSafeErrorV1 } = require('../../../../src/main-process/background-execution/error-codec');
const canary = require('../../../../src/main-process/background-execution/canary');
const { ROWS_POLICY } = require('../../../../src/main-process/toolbox-row-split/policy');

const GiB = 1024 ** 3;
const ZERO = { cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 0 };
const RESULT = { checksum: 6004, count: 2, rounds: 2, sum: 3 };
const BUDGETS = { cpuSlots: 4, workerThreadSlots: 5, utilityProcessSlots: 1, ioHeavySlots: 2, memoryBytes: 2 * GiB };
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

function createClock() {
  let timestamp = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => timestamp,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { at: timestamp + delay, callback }); return key; },
    clearTimer(key) { timers.delete(key); },
    advance(ms) {
      timestamp += ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= timestamp).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [key, timer] = due[0]; timers.delete(key); timer.callback();
      }
    },
    timerCount: () => timers.size
  };
}

function harness(t, { budgets = BUDGETS, base = ZERO, phase = ROWS_POLICY.resources.phase, mode = 'thread-single', behavior = 'queue', diagnosticsThrow = false } = {}) {
  const clock = createClock();
  const governor = createResourceGovernor({ budgets, ...clock });
  const policy = structuredClone(canary.pureComputePolicy);
  policy.mode = mode;
  policy.resources.base = { ...base };
  policy.resources.phase = { ...phase };
  policy.resources.lowMemoryBehavior = behavior;
  const entryRegistry = createStaticRegistry({ [policy.entryKey]: '/isolated/admission-worker.js' });
  const validatorRegistry = createStaticRegistry({ [policy.result.validatorKey]: canary.validatePureComputeCanaryResult });
  entryRegistry.freeze(); validatorRegistry.freeze();
  const policyRegistry = createExecutionPolicyRegistry({ policies: [policy], entryRegistry, validatorRegistry,
    staticKeys: { resourceProfileKeys: [policy.resources.profile] }, generatedAt: '2026-09-19T00:00:00Z' });
  policyRegistry.freeze();
  const state = { starts: 0, startedJobs: [], closes: 0, terminates: 0, admissionSnapshots: [] };
  const adapter = {
    start(callbacks) {
      state.starts += 1;
      state.startedJobs.push(callbacks.jobId);
      state.admissionSnapshots.push(governor.snapshot());
      return {
        ready: Promise.resolve(),
        send(command) {
          if (command.operation !== 'job:start') return;
          queueMicrotask(() => callbacks.onMessage(createJobEnvelope({ direction: 'event', operation: 'job:done',
            actionKey: command.actionKey, operationKey: command.operationKey, jobId: command.jobId,
            workerInstanceId: command.workerInstanceId, serviceGeneration: null, unitId: null, seq: 1,
            context: command.context, payload: { result: RESULT } })));
        },
        close() { state.closes += 1; },
        terminate() { state.terminates += 1; return Promise.resolve(0); }
      };
    }
  };
  const diagnostics = [];
  const supervisor = createExecutionSupervisor({ policyRegistry, resourceGovernor: governor,
    workerThreadAdapter: adapter, utilityProcessAdapter: adapter, now: clock.now,
    diagnostics(entry) { if (diagnosticsThrow) throw new Error('诊断输出不可用'); diagnostics.push(entry); } });
  t.after(async () => { await supervisor.shutdown({ timeoutMs: 50 }); closeResourceGovernor(governor); });
  function execute(id) {
    return supervisor.execute({ actionKey: policy.actionKey, operationKey: `operation-${id}`,
      jobId: id, workerInstanceId: `worker-${id}`, input: { values: [1, 2], rounds: 2 } });
  }
  async function block(resources, ownerKey = '/Users/private/business-file.xlsx') {
    return governor.acquirePhaseLease({ ownerKey, actionKey: 'test-blocker', operationKey: 'private-business-identifier', resources });
  }
  return { clock, governor, supervisor, state, diagnostics, execute, block, policy };
}

function assertReleased(h, expectedActive = 0) {
  const snapshot = h.governor.snapshot();
  assert.equal(snapshot.activeLeaseCount, expectedActive);
  assert.equal(snapshot.queued.size, 0);
  if (!expectedActive) assert.deepEqual(snapshot.activeUsage, ZERO);
  assert.equal(h.clock.timerCount(), 0);
}

function assertSafeDiagnostic(result, h, reason) {
  assert.equal(result.error.stage, 'admission');
  assert.deepEqual(Object.keys(result.error).sort(), ['code', 'detailLines', 'message', 'stage']);
  validateSafeErrorV1(result.error);
  assert.deepEqual(toProtocolError(fromProtocolError(result.error)), result.error);
  assert.equal(result.error.detailLines.length, 5);
  assert.ok(result.error.detailLines.some((line) => line.startsWith('申请资源：')));
  assert.ok(result.error.detailLines.some((line) => line.includes('MiB')));
  assert.ok(result.error.detailLines.every((line) => Buffer.byteLength(line) <= 2048 && !line.includes('[redacted')));
  const entry = h.diagnostics.find((item) => item.type === 'resource-admission-failed');
  assert.ok(entry);
  assert.equal(entry.admission.schemaVersion, 1);
  assert.equal(entry.admission.reason, reason);
  assert.deepEqual(Object.keys(entry.admission).sort(), ['schemaVersion', 'reason', 'requestedLease', 'required', 'budgets', 'activeUsage', 'available', 'queueCount'].sort());
  assert.ok(!JSON.stringify(entry).includes('private'));
  assert.ok(!JSON.stringify(result.error).includes('private'));
  return entry.admission;
}

for (const key of ['memoryBytes', 'cpuSlots', 'workerThreadSlots', 'ioHeavySlots', 'utilityProcessSlots']) {
  test(`静态 ${key} 超过总预算时立即拒绝，既不排队也不启动载体`, async (t) => {
    const phase = key === 'utilityProcessSlots' ? { ...ROWS_POLICY.resources.phase, workerThreadSlots: 0, utilityProcessSlots: 1 } : ROWS_POLICY.resources.phase;
    const budgets = { ...BUDGETS, [key]: key === 'memoryBytes' ? 768 * 1024 ** 2 : 0 };
    const h = harness(t, { budgets, phase, mode: key === 'utilityProcessSlots' ? 'utility-process' : 'thread-single' });
    let settled = false;
    const pending = h.execute(`insufficient-${key}`).then((result) => { settled = true; return result; });
    await flush();
    const immediate = settled;
    // 前态也有界结算，避免失败回归悬挂或留下未处理拒绝。
    if (!settled) { h.clock.advance(5000); await flush(); }
    const result = await pending;
    assert.equal(immediate, true, `静态 ${key} 不可能满足，不应进入等待`);
    assert.equal(result.error.code, 'RESOURCE_BUDGET_UNAVAILABLE');
    assert.equal(h.state.starts, 0);
    assert.equal(h.governor.snapshot().diagnostics.granted, 0);
    const diagnostic = assertSafeDiagnostic(result, h, 'total-budget-insufficient');
    assert.deepEqual(diagnostic.required, phase);
    assert.equal(diagnostic.requestedLease, 'base-and-phase');
    assert.deepEqual(diagnostic.budgets, budgets);
    assertReleased(h);
  });
}

test('Base 与 Phase 各自可容纳但合计超额时，尚未取得 Base 就拒绝', async (t) => {
  const h = harness(t, { base: { ...ZERO, memoryBytes: 768 * 1024 ** 2 }, budgets: { ...BUDGETS, memoryBytes: 1536 * 1024 ** 2 } });
  const pending = h.execute('aggregate-insufficient');
  await flush(); h.clock.advance(5000); await flush();
  const result = await pending;
  assert.equal(result.error.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(h.governor.snapshot().diagnostics.granted, 0);
  assert.equal(h.state.starts, 0);
  const diagnostic = assertSafeDiagnostic(result, h, 'total-budget-insufficient');
  assert.equal(diagnostic.required.memoryBytes, 1792 * 1024 ** 2);
  assertReleased(h);
});

test('足额静态预算在载体启动前取得 Base 与 Phase，完成后分别只释放一次', async (t) => {
  const h = harness(t, { base: { ...ZERO, memoryBytes: 128 * 1024 ** 2 } });
  const result = await h.execute('sufficient');
  assert.equal(result.outcome, 'completed');
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.admissionSnapshots[0].activeLeaseCount, 2);
  assert.equal(h.state.admissionSnapshots[0].activeUsage.memoryBytes, 1152 * 1024 ** 2);
  assert.equal(h.governor.snapshot().diagnostics.granted, 2);
  assert.equal(h.governor.snapshot().diagnostics.released, 2);
  assert.equal(h.governor.snapshot().diagnostics.duplicateRelease, 0);
  assertReleased(h);
});

test('临时占用保持排队，释放容量后按先后次序完成两个任务', async (t) => {
  const h = harness(t, { budgets: { ...BUDGETS, memoryBytes: GiB } });
  const blocker = await h.block({ ...ZERO, memoryBytes: GiB });
  const order = [];
  const first = h.execute('first').then((result) => { order.push('first'); return result; });
  await flush();
  const second = h.execute('second').then((result) => { order.push('second'); return result; });
  await flush();
  assert.equal(h.state.starts, 0);
  assert.equal(h.governor.snapshot().queued.size, 2);
  h.clock.advance(4999); await flush();
  blocker.release('容量恢复');
  assert.equal((await first).outcome, 'completed');
  assert.equal((await second).outcome, 'completed');
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(h.state.starts, 2);
  assertReleased(h);
});

test('临时占用到 5000 ms 仍未释放时保留 timeout，诊断只含数值且清理本任务 Base', async (t) => {
  const h = harness(t, { base: { ...ZERO, memoryBytes: 128 * 1024 ** 2 } });
  const blocker = await h.block({ ...ZERO, memoryBytes: 1536 * 1024 ** 2 });
  let settled = false;
  const pending = h.execute('phase-timeout').then((result) => { settled = true; return result; });
  await flush();
  assert.equal(h.governor.snapshot().activeLeaseCount, 2);
  h.clock.advance(4999); await flush(); assert.equal(settled, false);
  h.clock.advance(1); await flush();
  const result = await pending;
  assert.equal(result.error.code, 'ADMISSION_TIMEOUT');
  assert.equal(result.error.message, 'Admission request timed out after 5000ms');
  assert.equal(h.state.starts, 0);
  const diagnostic = assertSafeDiagnostic(result, h, 'admission-timeout');
  assert.equal(diagnostic.requestedLease, 'phase');
  assert.deepEqual(diagnostic.required, ROWS_POLICY.resources.phase);
  assert.equal(diagnostic.activeUsage.memoryBytes, 1664 * 1024 ** 2);
  assert.equal(diagnostic.available.memoryBytes, 384 * 1024 ** 2);
  assert.equal(diagnostic.queueCount, 0);
  assertReleased(h, 1);
  blocker.release('清理测试占用'); assertReleased(h);
});

test('Base 本身被临时占用时超时保留 Base 申请诊断，不影响其他持有者', async (t) => {
  const base = { ...ZERO, memoryBytes: 128 * 1024 ** 2 };
  const h = harness(t, { base });
  const blocker = await h.block({ ...ZERO, memoryBytes: 2 * GiB });
  const pending = h.execute('base-timeout');
  await flush(); h.clock.advance(5000); await flush();
  const result = await pending;
  assert.equal(result.error.code, 'ADMISSION_TIMEOUT');
  const diagnostic = assertSafeDiagnostic(result, h, 'admission-timeout');
  assert.equal(diagnostic.requestedLease, 'base');
  assert.deepEqual(diagnostic.required, base);
  assert.equal(h.state.starts, 0);
  assertReleased(h, 1);
  blocker.release('清理测试占用'); assertReleased(h);
});

test('等待 Phase 时取消释放已取得的 Base，不启动载体、不取消其他持有者', async (t) => {
  const h = harness(t, { base: { ...ZERO, memoryBytes: 128 * 1024 ** 2 } });
  const blocker = await h.block({ ...ZERO, memoryBytes: 1536 * 1024 ** 2 });
  const pending = h.execute('cancel-pending');
  await flush();
  const cancellation = await h.supervisor.cancel('cancel-pending', { reason: 'user-requested' });
  assert.equal(cancellation.accepted, true);
  const result = await pending;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.error.code, 'ADMISSION_CANCELLED');
  assert.equal(h.state.starts, 0);
  assertReleased(h, 1);
  blocker.release('清理测试占用'); assertReleased(h);
  assert.equal(h.governor.snapshot().diagnostics.duplicateRelease, 0);
});

test('reject 策略临时容量不足仍立即拒绝，不能误称总预算不可满足', async (t) => {
  const h = harness(t, { behavior: 'reject' });
  const blocker = await h.block({ ...ZERO, memoryBytes: 1536 * 1024 ** 2 });
  const result = await h.execute('reject-competition');
  assert.equal(result.error.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  const diagnostic = assertSafeDiagnostic(result, h, 'capacity-unavailable');
  assert.deepEqual(diagnostic.budgets, BUDGETS);
  assert.equal(h.state.starts, 0);
  assertReleased(h, 1);
  blocker.release('清理测试占用'); assertReleased(h);
});

test('大整数预算的中文 MiB 摘要完整通过 finance-safe 往返，不误判为账号', async (t) => {
  const budgets = Object.fromEntries(Object.keys(BUDGETS).map((key) => [key, Number.MAX_SAFE_INTEGER]));
  budgets.memoryBytes = 768 * 1024 ** 2;
  const h = harness(t, { budgets });
  const pending = h.execute('large-safe-budget');
  await flush(); h.clock.advance(5000); await flush();
  const result = await pending;
  const diagnostic = assertSafeDiagnostic(result, h, 'total-budget-insufficient');
  assert.equal(diagnostic.budgets.cpuSlots, Number.MAX_SAFE_INTEGER);
  assert.ok(result.error.detailLines.some((line) => line.includes('9,007,199,254,740,991')));
  assertReleased(h);
});

test('诊断输出回调失败不得阻止原始失败结算或资源清理', async (t) => {
  const h = harness(t, { budgets: { ...BUDGETS, memoryBytes: 768 * 1024 ** 2 }, diagnosticsThrow: true });
  const pending = h.execute('diagnostic-sink-failure');
  await flush(); h.clock.advance(5000); await flush();
  const result = await pending;
  assert.equal(result.error.code, 'RESOURCE_BUDGET_UNAVAILABLE');
  assert.equal(h.state.starts, 0);
  assertReleased(h);
});
