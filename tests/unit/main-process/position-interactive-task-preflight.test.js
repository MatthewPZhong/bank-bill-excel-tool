'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  createPositionRunTaskContract,
  createPositionSourceImportTaskContract,
  executeAfterPositionAdmission,
  runWithPreparedResourceCleanup
} = require('../../../src/main-process/position-reconciliation/interactive-task-preflight');
const {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../../src/main-process/archive-center/ipc-task-contract');
const {
  createTaskLifecycle
} = require('../../../src/main-process/archive-center/task-lifecycle');

const POLICY = Object.freeze({
  channel: 'position-reconciliation:test',
  scopeId: 'position-reconciliation-process',
  moduleCode: 'POSITION_RECONCILIATION',
  moduleName: '平盘对账数据处理',
  taskKey: 'position-reconciliation:test',
  batchPolicy: 'reserve',
  taskKind: 'file',
  allocation: 'eager',
  startsNewFlow: true,
  resultClassifier(result) {
    if (result && result.status === 'ok') return 'succeeded';
    if (result && result.status === 'cancelled') return 'cancelled';
    return 'failed';
  }
});

function createLifecycleHarness({ reserveOk = true } = {}) {
  const calls = [];
  const settledFiles = [];
  const lifecycle = createTaskLifecycle({
    businessOperationRegistry: {
      begin() { calls.push('bor-begin'); return { accepted: true, token: 'bor-1' }; },
      end() { calls.push('bor-end'); }
    },
    archiveService: {
      async beginTaskRun(payload) {
        calls.push('begin-task-run');
        return { ok: true, taskRun: { ...payload, status: 'prepared' } };
      },
      async markTaskRunStarted() { return { ok: true }; },
      async reserveFileTaskBatch({ taskRun }) {
        calls.push('reserve');
        return reserveOk
          ? { ok: true, batch: { id: 1, batchNumber: 'position-1', ...taskRun } }
          : { ok: false, code: 'reserve-failed', message: 'reserve failed' };
      },
      async beginFileTaskRecovery() { throw new Error('unexpected file recovery'); },
      async startFileTask() { calls.push('started'); return { ok: true }; },
      async settleManifestArtifacts(payload) {
        calls.push('settle');
        settledFiles.push(payload.files);
        return { ok: true, durable: true };
      },
      async finishFileTask(_taskRunId, _batchId, outcome) {
        calls.push(outcome.taskStatus === 'succeeded' ? 'complete' : outcome.taskStatus);
        return { ok: true };
      },
      async finishTaskRun() { return { ok: true }; },
      async reserveTaskBatch(payload) {
        calls.push('reserve');
        return reserveOk
          ? {
            ok: true,
            created: true,
            batchId: 1,
            batchNumber: 'position-1',
            batch: {
              id: 1,
              batchNumber: 'position-1',
              taskRunId: payload.taskRunId,
              taskKey: payload.taskKey,
              moduleId: payload.moduleId,
              parentRunId: payload.parentRunId,
              operationKey: payload.operationKey
            }
          }
          : { ok: false, code: 'reserve-failed', message: 'reserve failed' };
      },
      async beginTaskRecovery() { throw new Error('unexpected recovery'); },
      async markTaskStarted() { calls.push('started'); return { ok: true }; },
      async completeTaskBatch() { calls.push('complete'); return { ok: true }; },
      async failTaskBatch() { calls.push('fail'); return { ok: true }; },
      async cancelTaskBatch() { calls.push('cancel'); return { ok: true }; },
      async recordFailure() { calls.push('record-failure'); return { ok: true }; }
    },
    flowResolver: {
      async resolve() {
        calls.push('resolve-flow');
        return { parentRunId: 'position-parent-1', source: 'new', identity: null };
      },
      async bind() { return []; },
      async persistBindIntent() { return []; }
    },
    operationTracker: {
      async appendOperationFiles() { calls.push('append'); return { archiveFailed: false }; }
    },
    createTaskRunId: () => 'position-task-1'
  });
  return { calls, lifecycle, settledFiles };
}

async function invoke(contract, args, harness) {
  const normalized = normalizeIpcTaskHandler(contract);
  const prepared = await prepareIpcTaskInvocation(normalized, {}, args);
  if (!prepared.proceed) return { prepared, result: prepared.result };
  const lifecycleRun = prepared.filePlan
    ? harness.lifecycle.runFileTask.bind(harness.lifecycle)
    : harness.lifecycle.run.bind(harness.lifecycle);
  const result = await runWithPreparedResourceCleanup(prepared, (markExecuteStarted) => (
    lifecycleRun({
      policy: POLICY,
      meta: { channel: POLICY.channel },
      prepared,
      filePlanResolver: prepared.filePlan ? () => prepared.filePlan : undefined,
      execute: (batchContext, controls) => {
        markExecuteStarted();
        return executeIpcTaskInvocation(
          normalized,
          {},
          prepared,
          prepared.args,
          createIpcTaskContext(batchContext, controls)
        );
      }
    })
  ));
  return { prepared, result };
}

test('position run replace 首调/取消 0 BOR，opaque 确认后恰好一次 lifecycle/run', async () => {
  const runCalls = [];
  const service = {
    prepareRun(payload) {
      return {
        selection: {
          channels: payload.channels || ['DBS'],
          months: payload.months || ['2026-07']
        },
        bankRows: [{ id: 1 }],
        existing: { id: 41, scope: { channels: ['HSBC'], months: ['2026-06'] } }
      };
    },
    persistenceCheckpoint: () => ({ identity: 'position', generation: 7, token: 'g7' }),
    run(payload) { runCalls.push(payload); return { status: 'ok', runId: 42 }; }
  };
  const contract = createPositionRunTaskContract({
    getService: () => service,
    withRunLock: (task) => task(),
    createContextId: () => 'position-context-1'
  });
  const firstHarness = createLifecycleHarness();
  const first = await invoke(contract, [{ channels: ['DBS'], months: ['2026-07'] }], firstHarness);
  assert.equal(first.result.status, 'needs-replace-confirmation');
  assert.deepEqual(Object.keys(first.result).sort(), [
    'contextId', 'message', 'pendingScope', 'status'
  ]);
  assert.deepEqual(firstHarness.calls, []);
  assert.equal(runCalls.length, 0, '取消确认时 renderer 不发送第二次 IPC');

  const confirmedHarness = createLifecycleHarness();
  const confirmed = await invoke(contract, [{
    contextId: first.result.contextId,
    confirmReplace: true
  }], confirmedHarness);
  assert.equal(confirmed.result.status, 'ok');
  for (const call of ['bor-begin', 'reserve', 'started', 'append', 'complete']) {
    assert.equal(confirmedHarness.calls.filter((item) => item === call).length, 1, call);
  }
  assert.deepEqual(runCalls, [{
    channels: ['DBS'],
    months: ['2026-07'],
    replacePendingRunId: 41
  }]);
});

test('position run 选择校验在 lifecycle 前失败', async () => {
  let runCount = 0;
  const contract = createPositionRunTaskContract({
    getService: () => ({
      prepareRun() {
        throw Object.assign(new Error('运行前请至少选择一个银行渠道和一个月份'), {
          code: 'position-scope-selection-empty'
        });
      },
      run() { runCount += 1; return { status: 'ok' }; }
    }),
    withRunLock: (task) => task(),
    createContextId: () => 'unused'
  });
  const harness = createLifecycleHarness();
  const { result } = await invoke(contract, [{ channels: [], months: [] }], harness);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'position-scope-selection-empty');
  assert.deepEqual(harness.calls, []);
  assert.equal(runCount, 0);
});

test('position renderer replace 二次请求只含 contextId + confirmReplace', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'renderer-position-reconciliation.js'),
    'utf8'
  );
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const payload = context.window.__positionReconciliation
    .buildRunReplaceConfirmationRequest('position-context');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    contextId: 'position-context',
    confirmReplace: true
  });
  assert.match(
    source,
    /api\.run\(buildRunReplaceConfirmationRequest\(result\.contextId\)\)/
  );
});

test('source picker cancel 在 getService/BOR/reserve 前停止', async () => {
  let getServiceCount = 0;
  const contract = createPositionSourceImportTaskContract({
    pickFiles: async () => ({ canceled: true, filePaths: [] }),
    getService: () => { getServiceCount += 1; return {}; },
    withSourceLock: (task) => task()
  });
  const harness = createLifecycleHarness();
  const { result } = await invoke(contract, [], harness);
  assert.equal(result.status, 'cancelled');
  assert.equal(getServiceCount, 0);
  assert.deepEqual(harness.calls, []);
});

test('source account-only、ordinary 与 mixed 均由真实输入 File Task 收口', async () => {
  for (const fixture of [
    { name: 'account-only', requiresExecution: false, execute: 0 },
    { name: 'ordinary-only', requiresExecution: true, execute: 1 },
    { name: 'mixed', requiresExecution: true, execute: 1 }
  ]) {
    let executeCount = 0;
    let receivedBatchContext = null;
    const service = {
      async prepareSourceImportForLifecycle() {
        if (!fixture.requiresExecution) {
          return {
            requiresExecution: false,
            result: {
              status: 'ok',
              archiveDeferred: true,
              results: [{ status: 'needs-confirmation', token: 'account-token' }]
            }
          };
        }
        return {
          requiresExecution: true,
          inputPaths: ['/staging/source.xlsx'],
          plan: { engine: fixture.name }
        };
      },
      executePreparedSourceImport(_plan, batchContext) {
        executeCount += 1;
        receivedBatchContext = batchContext;
        return {
          status: 'ok',
          successCount: 1,
          confirmationCount: fixture.name === 'mixed' ? 1 : 0
        };
      },
      abandonPreparedSourceImport() { throw new Error('正常执行不应 abandon'); }
    };
    const contract = createPositionSourceImportTaskContract({
      pickFiles: async () => ({ canceled: false, filePaths: [__filename] }),
      getService: () => service,
      withSourceLock: (task) => task()
    });
    const harness = createLifecycleHarness();
    const { result } = await invoke(contract, [], harness);
    assert.equal(result.status, 'ok', fixture.name);
    assert.equal(executeCount, fixture.execute, fixture.name);
    if (fixture.execute === 1) {
      assert.equal(receivedBatchContext.batchId, 1, fixture.name);
      assert.equal(Object.isFrozen(receivedBatchContext), true, fixture.name);
    }
    assert.equal(harness.calls.filter((item) => item === 'reserve').length, 1);
    assert.equal(harness.calls.filter((item) => item === 'complete').length, 1);
  }
});

test('source reserve 失败会 abandon prepared worker/staging 且 0 apply', async () => {
  let abandonCount = 0;
  let applyCount = 0;
  const service = {
    async prepareSourceImportForLifecycle() {
      return {
        requiresExecution: true,
        inputPaths: ['/staging/source.xlsx'],
        plan: {
          engine: 'streaming',
          preflightReady: {
            acceptedOrdinaryInputFiles: [{
              archivePath: path.resolve(__dirname, '../../../src/main-process/position-reconciliation/service.js')
            }],
            accountConfirmationDescriptor: null,
            outputFiles: []
          }
        }
      };
    },
    executePreparedSourceImport() { applyCount += 1; return { status: 'ok' }; },
    async abandonPreparedSourceImport() { abandonCount += 1; }
  };
  const contract = createPositionSourceImportTaskContract({
    pickFiles: async () => ({ canceled: false, filePaths: [__filename] }),
    getService: () => service,
    withSourceLock: (task) => task()
  });
  const harness = createLifecycleHarness({ reserveOk: false });
  const { result } = await invoke(contract, [], harness);
  assert.equal(result.status, 'failed');
  assert.equal(harness.calls.filter((item) => item === 'reserve').length, 1);
  assert.equal(harness.calls.includes('started'), false);
  assert.equal(applyCount, 0);
  assert.equal(abandonCount, 1);
});

test('source mixed preflight 把全部选择、实际 staging 与 anomaly output 固定为同一 manifest', async () => {
  const selectedA = __filename;
  const selectedB = path.resolve(__dirname, '../../../src/main-process/position-reconciliation/common.js');
  const staged = path.resolve(__dirname, '../../../src/main-process/position-reconciliation/service.js');
  const anomaly = path.resolve(__dirname, '../../../src/main-process/position-reconciliation/operation-lifecycle.js');
  const service = {
    async prepareSourceImportForLifecycle() {
      return {
        requiresExecution: true,
        plan: {
          engine: 'streaming',
          preflightReady: {
            acceptedOrdinaryInputFiles: [{
              archivePath: staged,
              fileName: 'staged.xlsx',
              sourceType: 'fund-transfer'
            }],
            accountConfirmationDescriptor: null,
            orderedFileResults: [
              { status: 'ok', archivePath: staged },
              { status: 'failed', fileName: 'rejected.xlsx' }
            ],
            outputFiles: [{ filePath: anomaly }]
          }
        }
      };
    },
    executePreparedSourceImport(_plan, _batchContext, fileEvidence) {
      assert.deepEqual(fileEvidence.executionInputPaths, [staged]);
      assert.equal(fileEvidence.outputs.length, 1);
      return { status: 'ok', successCount: 1, failedCount: 1 };
    },
    abandonPreparedSourceImport() { throw new Error('正常执行不应 abandon'); }
  };
  const contract = createPositionSourceImportTaskContract({
    pickFiles: async () => ({ canceled: false, filePaths: [selectedA, selectedB] }),
    getService: () => service,
    withSourceLock: (task) => task()
  });
  const harness = createLifecycleHarness();
  const { prepared, result } = await invoke(contract, [], harness);
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    prepared.filePlan.inputs.map((item) => item.filePath),
    [selectedA, selectedB, staged].map((value) => path.resolve(value))
  );
  assert.deepEqual(prepared.filePlan.outputs.map((item) => item.filePath), [anomaly]);
  assert.equal(prepared.filePlan.inputs.length + prepared.filePlan.outputs.length, 4);
});

test('position outer 拒绝时 abandon；实际进入业务 callback 后正常执行且不 abandon', async () => {
  let abandonCount = 0;
  let executeCount = 0;
  const prepared = {
    async onAbandon() { abandonCount += 1; }
  };
  const rejected = await runWithPreparedResourceCleanup(
    prepared,
    (markExecuteStarted) => executeAfterPositionAdmission({
      isPositionOperation: true,
      markExecuteStarted,
      execute: () => { executeCount += 1; return { status: 'ok' }; },
      admitPosition: () => ({ status: 'failed', code: 'position-operation-busy' })
    })
  );
  assert.equal(rejected.status, 'failed');
  assert.equal(executeCount, 0);
  assert.equal(abandonCount, 1);

  const executed = await runWithPreparedResourceCleanup(
    prepared,
    (markExecuteStarted) => executeAfterPositionAdmission({
      isPositionOperation: true,
      markExecuteStarted,
      execute: () => { executeCount += 1; return { status: 'ok' }; },
      admitPosition: (operation) => operation()
    })
  );
  assert.equal(executed.status, 'ok');
  assert.equal(executeCount, 1);
  assert.equal(abandonCount, 1);
});
