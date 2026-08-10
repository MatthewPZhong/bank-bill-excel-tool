'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTaskLifecycle,
  createWorkerBatchContext,
  taskResultStatus
} = require('../../../src/main-process/archive-center/task-lifecycle');
const {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../../src/main-process/archive-center/ipc-task-contract');

const POLICY = Object.freeze({
  channel: 'pending:reconcile:run',
  scopeId: 'pending-reconciliation',
  moduleCode: 'PENDING',
  moduleName: '月度Pending数据核对',
  taskKey: 'reconcile-run',
  batchPolicy: 'reserve',
  startsNewFlow: true,
  resultClassifier(result) {
    const status = result && result.status;
    if (status === 'success') return 'succeeded';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    throw new TypeError(`unexpected result status: ${status}`);
  }
});

const RECOVERY_CONTEXT = Object.freeze({
  batchId: 77,
  batchNumber: '2026-08-10-077',
  taskRunId: 'task-recovery-77',
  taskKey: POLICY.taskKey,
  moduleId: POLICY.scopeId,
  parentRunId: 'parent-recovery-77',
  operationKey: 'recovery-operation-77'
});

function createHarness(overrides = {}) {
  const calls = [];
  let activeToken = 0;
  const businessOperationRegistry = {
    begin(meta) {
      calls.push(['begin', meta.channel]);
      if (overrides.beginResult) return overrides.beginResult;
      activeToken += 1;
      return { accepted: true, token: activeToken };
    },
    end(token) { calls.push(['end', token]); }
  };
  const archiveService = {
    async reserveTaskBatch(payload) {
      calls.push(['reserve', payload]);
      return overrides.reserveResult || {
        ok: true,
        created: true,
        batchId: 11,
        batchNumber: '2026-08-10-001',
        batch: {
          id: 11,
          batchNumber: '2026-08-10-001',
          taskRunId: payload.taskRunId,
          taskKey: payload.taskKey,
          moduleId: payload.moduleId,
          parentRunId: payload.parentRunId,
          operationKey: payload.operationKey,
          taskStatus: 'reserved'
        }
      };
    },
    async beginTaskRecovery(batchContext, options) {
      calls.push(['recover', batchContext.batchId, options]);
      return overrides.recoveryResult || {
        ok: true,
        batchId: batchContext.batchId,
        batch: {
          id: batchContext.batchId,
          batchNumber: batchContext.batchNumber,
          taskRunId: batchContext.taskRunId,
          taskKey: batchContext.taskKey,
          moduleId: batchContext.moduleId,
          parentRunId: batchContext.parentRunId,
          operationKey: batchContext.operationKey,
          taskStatus: 'running'
        }
      };
    },
    async markTaskStarted(batchId) {
      calls.push(['started', batchId]);
      return overrides.startedResult || { ok: true };
    },
    async completeTaskBatch(batchId, completion) {
      calls.push(['complete', batchId, completion]);
      if (overrides.completeError) throw overrides.completeError;
      return overrides.completeResult || { ok: true };
    },
    async failTaskBatch(batchId, failure) {
      calls.push(['fail', batchId, failure]);
      if (overrides.failError) throw overrides.failError;
      return overrides.failResult || { ok: true };
    },
    async cancelTaskBatch(batchId, cancellation) {
      calls.push(['cancel', batchId, cancellation]);
      return overrides.cancelResult || { ok: true };
    },
    async recordFailure(batchId, failure) {
      calls.push(['record-failure', batchId, failure]);
      return overrides.recordFailureResult || { ok: true };
    }
  };
  const flowResolver = {
    async resolve(payload) {
      calls.push(['resolve-flow', payload]);
      return overrides.flowResult || { parentRunId: 'parent-1', source: 'new', identity: null };
    },
    async bind(payload) {
      calls.push(['bind-flow', payload]);
      if (overrides.bindError) throw overrides.bindError;
      return [];
    },
    async persistBindIntent(payload) {
      calls.push(['persist-flow-intent', payload]);
      if (overrides.persistBindIntentError) throw overrides.persistBindIntentError;
      return [payload];
    }
  };
  const operationTracker = {
    async appendOperationFiles(payload) {
      calls.push(['append', payload.batchContext.batchId, payload]);
      if (overrides.appendError) throw overrides.appendError;
      return overrides.appendResult || { archiveFailed: false };
    }
  };
  const warnings = [];
  const lifecycle = createTaskLifecycle({
    businessOperationRegistry,
    archiveService,
    flowResolver,
    operationTracker,
    createTaskRunId: () => 'task-1',
    onArchiveWarning: (warning) => warnings.push(warning)
  });
  return { archiveService, calls, lifecycle, warnings };
}

test('严格按 BOR → reserve → started → execute → append → terminal → end 执行', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: (context) => {
      calls.push(['execute', lifecycle.getContext() === context]);
      return { status: 'success', runId: 42 };
    },
    resultFlowIdentities: (value) => [{ type: 'business-run-id', value: value.runId }]
  });

  assert.equal(result.runId, 42);
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin',
    'resolve-flow',
    'reserve',
    'started',
    'execute',
    'append',
    'bind-flow',
    'complete',
    'end'
  ]);
  assert.equal(calls.find((call) => call[0] === 'execute')[1], true);
});

test('已持久化 batchContext 恢复直接重开原批次，不解析 flow/不 reserve/不再 started', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    recovery: { batchContext: RECOVERY_CONTEXT, evidence: { runId: 501 } },
    beforeStart: () => {
      calls.push(['revalidate-recovery-input']);
      return { valid: true };
    },
    execute: (context) => {
      assert.deepEqual(context, RECOVERY_CONTEXT);
      calls.push(['execute-recovery']);
      return { status: 'success', runId: 501 };
    }
  });

  assert.equal(result.runId, 501);
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'revalidate-recovery-input', 'recover', 'execute-recovery', 'append', 'complete', 'end'
  ]);
  assert.deepEqual(calls.find((call) => call[0] === 'recover')[2], {
    evidence: { runId: 501 }
  });
});

test('已持久化恢复在 beforeStart 重校验失败时不 reopen/不 fail 原批次', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.run({
    policy: POLICY,
    recovery: { batchContext: RECOVERY_CONTEXT },
    beforeStart: () => {
      calls.push(['revalidate-recovery-input']);
      const error = new Error('source changed');
      error.code = 'SOURCE_CHANGED';
      throw error;
    },
    execute: () => {
      calls.push(['unexpected-execute']);
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SOURCE_CHANGED');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'revalidate-recovery-input', 'end'
  ]);
});

test('legacy 稳定 operation 复用 reserved 批次时直接 mark started，不调 recovery reopen', async () => {
  const batch = {
    id: 81,
    batchNumber: '2026-08-10-081',
    taskRunId: 'legacy-task-81',
    taskKey: POLICY.taskKey,
    moduleId: POLICY.scopeId,
    parentRunId: 'legacy-parent-81',
    operationKey: 'legacy-operation-81',
    taskStatus: 'reserved'
  };
  const { calls, lifecycle } = createHarness({
    reserveResult: {
      ok: true,
      created: false,
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      batch
    }
  });
  const result = await lifecycle.run({
    policy: POLICY,
    recovery: { legacy: true, evidence: { runId: 601 } },
    taskRunId: batch.taskRunId,
    operationKey: batch.operationKey,
    execute: () => ({ status: 'success', runId: 601 })
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.filter((call) => call[0] === 'recover').length, 0);
  assert.equal(calls.filter((call) => call[0] === 'started').length, 1);
});

test('legacy 复用非 reserved 批次时先校 freshness，失败不 reopen/不 fail 原批次', async () => {
  const batch = {
    id: 82,
    batchNumber: '2026-08-10-082',
    taskRunId: 'legacy-task-82',
    taskKey: POLICY.taskKey,
    moduleId: POLICY.scopeId,
    parentRunId: 'legacy-parent-82',
    operationKey: 'legacy-operation-82',
    taskStatus: 'failed'
  };
  const { calls, lifecycle } = createHarness({
    reserveResult: {
      ok: true,
      created: false,
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      batch
    }
  });
  const result = await lifecycle.run({
    policy: POLICY,
    recovery: { legacy: true, evidence: { runId: 602 } },
    taskRunId: batch.taskRunId,
    operationKey: batch.operationKey,
    beforeStart: () => {
      calls.push(['revalidate-legacy-input']);
      const error = new Error('resume progress changed');
      error.code = 'ACQUIRING_RUN_RESUME_STALE';
      throw error;
    },
    execute: () => {
      calls.push(['unexpected-execute']);
      return { status: 'success', runId: 602 };
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ACQUIRING_RUN_RESUME_STALE');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'revalidate-legacy-input', 'end'
  ]);
  assert.equal(calls.filter((call) => call[0] === 'recover').length, 0);
  assert.equal(calls.filter((call) => call[0] === 'fail').length, 0);
});

test('同进程同 batchId 双恢复时第二个 busy，不 reserve/reopen/execute/fail', async () => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const firstReleasePromise = new Promise((resolve) => { releaseFirst = resolve; });
  const { calls, lifecycle } = createHarness();
  const first = lifecycle.run({
    policy: POLICY,
    recovery: { batchContext: RECOVERY_CONTEXT },
    execute: async () => {
      calls.push(['execute-first']);
      firstStarted();
      await firstReleasePromise;
      return { status: 'success' };
    }
  });
  await firstStartedPromise;

  const second = await lifecycle.run({
    policy: POLICY,
    recovery: { batchContext: RECOVERY_CONTEXT },
    execute: () => {
      calls.push(['execute-second']);
      return { status: 'success' };
    }
  });
  assert.equal(second.status, 'busy');
  assert.equal(calls.filter((call) => call[0] === 'recover').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'reserve').length, 0);
  assert.equal(calls.filter((call) => call[0] === 'execute-second').length, 0);
  assert.equal(calls.filter((call) => call[0] === 'fail').length, 0);

  releaseFirst();
  await first;
});

test('已成功批次恢复被拒绝，不执行业务也不改写终态', async () => {
  const { calls, lifecycle } = createHarness({
    recoveryResult: {
      ok: false,
      code: 'ARCHIVE_TASK_ALREADY_SUCCEEDED',
      message: '已成功任务不能恢复执行',
      batch: { taskStatus: 'succeeded' }
    }
  });
  const result = await lifecycle.run({
    policy: POLICY,
    recovery: { batchContext: RECOVERY_CONTEXT },
    execute: () => {
      calls.push(['unexpected-execute']);
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_TASK_ALREADY_SUCCEEDED');
  assert.deepEqual(calls.map((call) => call[0]), ['begin', 'recover', 'end']);
});

test('IPC prepare 完成后先 BOR.begin，再在 reserve 前解析持久 flow plan', async () => {
  const { calls, lifecycle } = createHarness();
  const contract = normalizeIpcTaskHandler({
    async prepare() {
      calls.push(['prepare-ui']);
      return { proceed: true };
    },
    execute(_event, _prepared, taskContext) {
      calls.push(['execute-contract', taskContext.batchContext.batchId]);
      return { status: 'success' };
    }
  });
  const prepared = await prepareIpcTaskInvocation(contract, {}, []);
  await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    prepared,
    flowPlanResolver: async () => {
      calls.push(['resolve-flow-plan']);
      return { startsNewFlow: true, flowIdentity: null };
    },
    execute: (batchContext, controls) => executeIpcTaskInvocation(
      contract,
      {},
      prepared,
      prepared.args,
      createIpcTaskContext(batchContext, controls)
    )
  });
  assert.deepEqual(calls.map((call) => call[0]), [
    'prepare-ui',
    'begin',
    'resolve-flow-plan',
    'resolve-flow',
    'reserve',
    'started',
    'execute-contract',
    'append',
    'complete',
    'end'
  ]);
});

test('输入证据只在 reserve 后、started 前采集并传给执行后 runtime', async () => {
  const { calls, lifecycle } = createHarness();
  const snapshot = new Map([['/tmp/input.xlsx', { sizeBytes: 7 }]]);
  await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    beforeStart: () => {
      calls.push(['capture-input']);
      return { sourceSnapshots: snapshot };
    },
    runtimeResolver: ({ beforeStartEvidence }) => {
      calls.push(['resolve-runtime']);
      assert.equal(beforeStartEvidence.sourceSnapshots, snapshot);
      return { sourceSnapshots: beforeStartEvidence.sourceSnapshots };
    },
    execute: () => {
      calls.push(['execute']);
      return { status: 'success' };
    }
  });
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'capture-input', 'started', 'execute',
    'resolve-runtime', 'append', 'complete', 'end'
  ]);
  const appendPayload = calls.find((call) => call[0] === 'append')[2];
  assert.equal(appendPayload.runtime.sourceSnapshots, snapshot);
});

test('异步结果 identity 完成解析后才绑定，不把 Promise 当 identity', async () => {
  const { calls, lifecycle } = createHarness();
  await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'success', runId: 88 }),
    resultFlowIdentities: async (result) => {
      await Promise.resolve();
      calls.push(['resolve-result-identity']);
      return [{ type: 'business-run-id', value: result.runId }];
    }
  });
  const bind = calls.find((call) => call[0] === 'bind-flow');
  assert.deepEqual(bind[1].identities, [{ type: 'business-run-id', value: 88 }]);
  assert.ok(
    calls.findIndex((call) => call[0] === 'resolve-result-identity')
      < calls.findIndex((call) => call[0] === 'bind-flow')
  );
});

test('结果 identity 直接绑定失败时先持久化 flow-bind intent，再终结 succeeded', async () => {
  const bindError = Object.assign(new Error('anchor db busy'), {
    code: 'ARCHIVE_FLOW_BIND_FAILED'
  });
  const { calls, lifecycle, warnings } = createHarness({ bindError });
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'success', runId: 'run-persist-1' }),
    resultFlowIdentities: (value) => [{ type: 'business-run-id', value: value.runId }]
  });
  assert.equal(result.status, 'success');
  const persistIndex = calls.findIndex((call) => call[0] === 'persist-flow-intent');
  const completeIndex = calls.findIndex((call) => call[0] === 'complete');
  assert.ok(persistIndex > calls.findIndex((call) => call[0] === 'bind-flow'));
  assert.ok(completeIndex > persistIndex);
  assert.deepEqual(calls[persistIndex][1], {
    moduleId: POLICY.scopeId,
    parentRunId: 'parent-1',
    sourceBatchId: 11,
    identities: [{ type: 'business-run-id', value: 'run-persist-1' }]
  });
  assert.equal(warnings.some((warning) => warning.code === 'ARCHIVE_FLOW_BIND_FAILED'), true);
});

test('预留失败时业务和 worker 均不执行，BOR 仍释放', async () => {
  const { calls, lifecycle } = createHarness({
    reserveResult: { ok: false, code: 'ARCHIVE_DB_BUSY', message: 'busy' }
  });
  let executed = false;
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => { executed = true; }
  });
  assert.equal(executed, false);
  assert.equal(result.code, 'ARCHIVE_DB_BUSY');
  assert.deepEqual(calls.map((call) => call[0]), ['begin', 'resolve-flow', 'reserve', 'end']);
});

test('started 失败终结原批次且不执行业务', async () => {
  const { calls, lifecycle } = createHarness({
    startedResult: { ok: false, code: 'ARCHIVE_TASK_STATUS_CONFLICT', message: 'conflict' }
  });
  let executed = false;
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => { executed = true; }
  });
  assert.equal(executed, false);
  assert.equal(result.code, 'ARCHIVE_TASK_STATUS_CONFLICT');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'started', 'fail', 'end'
  ]);
});

test('started CAS 发现批次已取消时不执行业务且不强制 failed', async () => {
  const { calls, lifecycle } = createHarness({
    startedResult: {
      ok: false,
      code: 'ARCHIVE_TASK_STATUS_CONFLICT',
      message: 'already cancelled',
      batch: { taskStatus: 'cancelled' }
    }
  });
  let executed = false;
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => { executed = true; }
  });
  assert.equal(executed, false);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'started', 'end'
  ]);
});

test('新流程稳定 identity 在 reserve 后、started 前立即绑定', async () => {
  const identity = { identityType: 'operation-token', identityValue: 'op-1' };
  const { calls, lifecycle } = createHarness({
    flowResult: { parentRunId: 'parent-1', source: 'new', identity }
  });
  await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    flowIdentity: identity,
    execute: () => {
      calls.push(['execute']);
      return { status: 'success' };
    }
  });
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'bind-flow', 'started',
    'execute', 'append', 'complete', 'end'
  ]);
});

test('业务异常先 append/failed 收口再原样抛出', async () => {
  const { calls, lifecycle } = createHarness();
  const expected = Object.assign(new Error('worker crashed'), { code: 'WORKER_CRASHED' });
  await assert.rejects(lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => { throw expected; }
  }), (error) => error === expected);
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'started', 'append', 'fail', 'end'
  ]);
});

test('业务成功但文件 append 失败不覆盖业务结果', async () => {
  const { calls, lifecycle, warnings } = createHarness({
    appendError: Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  });
  const expected = { status: 'success', value: 7 };
  const actual = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => expected
  });
  assert.equal(actual, expected);
  assert.ok(calls.some((call) => call[0] === 'record-failure'));
  assert.ok(calls.some((call) => call[0] === 'complete'));
  assert.equal(warnings.length, 1);
});

test('append 已持久记录 failure 时 lifecycle 不重复 recordFailure 但仍告警', async () => {
  const { calls, lifecycle, warnings } = createHarness({
    appendResult: {
      archiveFailed: true,
      failureRecorded: true,
      persistentRetryAvailable: true,
      warning: { message: 'outbox queued' }
    }
  });
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'success' })
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.some((call) => call[0] === 'record-failure'), false);
  assert.equal(warnings.length, 1);
});

test('业务成功但 terminal 返回失败仍保留业务结果并记录不完整', async () => {
  const { calls, lifecycle, warnings } = createHarness({
    completeResult: { ok: false, code: 'ARCHIVE_DB_WRITE_FAILED', message: 'write failed' }
  });
  const expected = { status: 'success', value: 9 };
  const actual = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => expected
  });
  assert.equal(actual, expected);
  assert.ok(calls.some((call) => call[0] === 'record-failure'));
  assert.equal(warnings.some((warning) => warning.code === 'ARCHIVE_DB_WRITE_FAILED'), true);
});

test('cancel 先到、success 后到时 terminal CAS 冲突不污染 archive failure', async () => {
  const { calls, lifecycle, warnings } = createHarness({
    completeResult: {
      ok: false,
      code: 'ARCHIVE_TASK_STATUS_CONFLICT',
      message: 'already cancelled',
      batch: { taskStatus: 'cancelled' }
    }
  });
  let release;
  const pending = lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => new Promise((resolve) => { release = resolve; })
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await lifecycle.cancelActive(null, 'user cancelled');
  assert.equal(cancelled.cancelled, true);
  release({ status: 'success', value: 10 });
  const result = await pending;
  assert.equal(result.value, 10);
  assert.equal(calls.some((call) => call[0] === 'record-failure'), false);
  assert.equal(warnings.length, 0);
});

test('success 先到、late cancel 冲突时不声称已取消', async () => {
  const { calls, lifecycle } = createHarness({
    cancelResult: {
      ok: false,
      code: 'ARCHIVE_TASK_STATUS_CONFLICT',
      message: 'already succeeded',
      batch: { taskStatus: 'succeeded' }
    }
  });
  let release;
  const pending = lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => new Promise((resolve) => { release = resolve; })
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await lifecycle.cancelActive(null, 'late cancel');
  assert.equal(cancelled.status, 'conflict');
  assert.equal(cancelled.cancelled, false);
  release({ status: 'success' });
  await pending;
  assert.ok(calls.some((call) => call[0] === 'complete'));
});

test('recordFailure 返回 ok:false 会产生独立 warning', async () => {
  const { lifecycle, warnings } = createHarness({
    appendError: new Error('append failed'),
    recordFailureResult: {
      ok: false,
      code: 'ARCHIVE_BATCH_NOT_FOUND',
      message: 'batch missing'
    }
  });
  await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'success' })
  });
  assert.equal(warnings.some((warning) => warning.code === 'ARCHIVE_BATCH_NOT_FOUND'), true);
  assert.equal(warnings.some((warning) => warning.message === 'append failed'), true);
});

test('terminal 抛错不覆盖原始业务异常', async () => {
  const original = Object.assign(new Error('business failed'), { code: 'BUSINESS_FAILED' });
  const { calls, lifecycle } = createHarness({
    failError: Object.assign(new Error('archive unavailable'), { code: 'ARCHIVE_DOWN' })
  });
  await assert.rejects(lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => { throw original; }
  }), (error) => error === original);
  assert.ok(calls.some((call) => call[0] === 'record-failure'));
});

test('取消只 CAS 活动批次，不查询 latest 或建立第二批次', async () => {
  const { calls, lifecycle } = createHarness();
  let release;
  const pending = lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => {
      calls.push(['execute']);
      return new Promise((resolve) => { release = resolve; });
    }
  });
  while (!calls.some((call) => call[0] === 'execute')) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await lifecycle.cancelActive(
    (context) => context.moduleId === 'pending-reconciliation',
    'user cancelled'
  );
  assert.equal(cancelled.status, 'cancelled');
  release({ status: 'cancelled' });
  await pending;
  assert.equal(calls.filter((call) => call[0] === 'reserve').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'cancel').length, 2);
});

test('worker batch context 是可序列化冻结 DTO', () => {
  const context = createWorkerBatchContext({
    batchId: 1,
    batchNumber: '2026-08-10-001',
    taskRunId: 'task-1',
    taskKey: 'run',
    moduleId: 'biz-op-recon',
    parentRunId: 'parent-1',
    operationKey: 'run:task-1'
  });
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
  assert.throws(() => { context.batchId = 2; }, TypeError);
});

test('result status 完全由当前 policy classifier 决定', () => {
  assert.equal(taskResultStatus({ status: 'success' }, POLICY.resultClassifier), 'succeeded');
  assert.equal(taskResultStatus({ status: 'cancelled' }, POLICY.resultClassifier), 'cancelled');
  assert.equal(taskResultStatus(
    { status: 'completed_with_errors' },
    () => 'succeeded'
  ), 'succeeded');
  assert.equal(taskResultStatus({ status: 'blocked' }, () => 'failed'), 'failed');
  assert.throws(() => taskResultStatus({ status: 'unknown' }), /resultClassifier/);
  assert.throws(
    () => taskResultStatus({ status: 'unknown' }, () => 'unknown'),
    /不支持的任务终态/
  );
});

test('completed_with_errors 保持 succeeded，并在终态 CAS 同步合并审计 metadata', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.run({
    policy: {
      ...POLICY,
      resultClassifier: () => 'succeeded',
      resultMetadataResolver(value) {
        return {
          resultStatus: value.status,
          completedWithErrors: true,
          errorCount: value.errorCount
        };
      }
    },
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'completed_with_errors', errorCount: 3 })
  });
  assert.equal(result.status, 'completed_with_errors');
  const complete = calls.find((call) => call[0] === 'complete');
  assert.deepEqual(complete[2], {
    metadata: {
      resultStatus: 'completed_with_errors',
      completedWithErrors: true,
      errorCount: 3
    }
  });
});
