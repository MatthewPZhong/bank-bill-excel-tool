'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const {
  createBankStatementRunFlowIdentity,
  createTaskPolicyRegistry
} = require('../../../src/main-process/archive-center/task-policy-registry');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');

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

const NO_FILE_POLICY = Object.freeze({
  ...POLICY,
  channel: 'pending:reconcile:query',
  taskKey: 'reconcile-query',
  batchPolicy: 'no-file',
  taskKind: 'no-file'
});

const FILE_POLICY = Object.freeze({
  ...POLICY,
  channel: 'toolbox:merge',
  taskKey: 'toolbox-merge',
  taskKind: 'file',
  allocation: 'eager'
});

const DEFERRED_FILE_POLICY = Object.freeze({
  ...POLICY,
  channel: 'monthly-balance:assemble',
  taskKey: 'monthly-balance-assemble',
  taskKind: 'file',
  allocation: 'deferred'
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

function normalizedToolboxPlan(inputPath, outputPath) {
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'toolbox:merge' }],
    outputs: [{ filePath: outputPath, role: 'output', sourceOperation: 'toolbox:merge' }]
  });
}

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
    async beginTaskRun(payload) {
      calls.push(['begin-task-run', payload]);
      return overrides.beginTaskRunResult || {
        ok: true,
        taskRun: {
          taskRunId: payload.taskRunId,
          taskKey: payload.taskKey,
          moduleId: payload.moduleId,
          parentRunId: payload.parentRunId,
          operationKey: payload.operationKey
        }
      };
    },
    async markTaskRunStarted(taskRunId) {
      calls.push(['start-task-run', taskRunId]);
      return overrides.markTaskRunStartedResult || { ok: true };
    },
    async finishTaskRun(taskRunId, outcome) {
      calls.push(['finish-task-run', taskRunId, outcome]);
      if (typeof overrides.finishTaskRun === 'function') {
        return overrides.finishTaskRun(taskRunId, outcome);
      }
      return overrides.finishTaskRunResult || { ok: true };
    },
    async reserveFileTaskBatch(payload) {
      calls.push(['reserve-file-task', payload]);
      if (typeof overrides.reserveFileTask === 'function') {
        return overrides.reserveFileTask(payload);
      }
      return overrides.reserveFileTaskResult || { ok: false, code: 'not-configured' };
    },
    async beginFileTaskRecovery(batchContext, options) {
      calls.push(['recover-file-task', batchContext, options]);
      return overrides.fileRecoveryResult || {
        ok: true,
        status: 'reopened',
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
    async startFileTask(taskRunId, batchId) {
      calls.push(['start-file-task', taskRunId, batchId]);
      return overrides.startFileTaskResult || { ok: true };
    },
    async settleManifestArtifacts(payload) {
      calls.push(['settle-manifest', payload]);
      return overrides.settleManifestResult || { ok: true, durable: true };
    },
    async finishFileTask(taskRunId, batchId, outcome) {
      calls.push(['finish-file-task', taskRunId, batchId, outcome]);
      if (typeof overrides.finishFileTask === 'function') {
        return overrides.finishFileTask(taskRunId, batchId, outcome);
      }
      return overrides.finishFileTaskResult || { ok: true };
    },
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
      if (typeof overrides.resolveFlow === 'function') return overrides.resolveFlow(payload);
      return overrides.flowResult || { parentRunId: 'parent-1', source: 'new', identity: null };
    },
    async bind(payload) {
      calls.push(['bind-flow', payload]);
      if (overrides.bindError) throw overrides.bindError;
      if (typeof overrides.bindFlow === 'function') return overrides.bindFlow(payload);
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
    async persistTerminalIntent(payload) {
      calls.push(['persist-terminal-intent', payload]);
      if (overrides.persistTerminalIntentError) throw overrides.persistTerminalIntentError;
      return overrides.persistTerminalIntentResult || { persisted: true };
    },
    onArchiveWarning: (warning) => warnings.push(warning)
  });
  return { archiveService, calls, lifecycle, warnings };
}

test('input-only file task 原子 reserve 后默认 settle 全部 inputs 并原子终结', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-lifecycle-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'input.xlsx');
  fs.writeFileSync(inputPath, 'input');
  const { calls, lifecycle } = createHarness({
    reserveFileTask(payload) {
      return {
        ok: true,
        created: true,
        batch: {
          id: 31,
          batchNumber: '2026-08-17-031',
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    }
  });
  const result = await lifecycle.runFileTask({
    policy: FILE_POLICY,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: () => normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [{ filePath: inputPath, role: 'input', sourceOperation: 'test:input-only' }],
      outputs: []
    }),
    beforeStart: () => ({ parsedInputCount: 1 }),
    execute: (_context, taskContext) => {
      assert.equal(taskContext.fileEvidence.parsedInputCount, 1);
      calls.push(['execute-file']);
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin',
    'resolve-flow',
    'begin-task-run',
    'reserve-file-task',
    'start-file-task',
    'execute-file',
    'settle-manifest',
    'finish-file-task',
    'end'
  ]);
  const reserve = calls.find((call) => call[0] === 'reserve-file-task')[1];
  assert.equal(reserve.manifest.inputs.length, 1);
  assert.equal(reserve.manifest.outputs.length, 0);
  const settlePayload = calls.find((call) => call[0] === 'settle-manifest')[1];
  assert.equal(settlePayload.batchContext.batchId, 31);
  assert.deepEqual(
    settlePayload.files.map((file) => file.artifactKey),
    reserve.manifest.inputs.map((file) => file.artifactKey)
  );
  assert.equal(calls.some((call) => call[0] === 'append'), false);
});

test('FilePlan resolver 在 Task Run 建立后失败仍以 operation owner 终结', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.runFileTask({
    policy: FILE_POLICY,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: () => {
      const error = new Error('deterministic output 无法形成');
      error.code = 'ARCHIVE_FILE_PLAN_INVALID';
      throw error;
    },
    execute: () => {
      throw new Error('业务不应开始');
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_FILE_PLAN_INVALID');
  assert.equal(calls.filter((call) => call[0] === 'finish-task-run').length, 1);
  assert.equal(calls.some((call) => call[0] === 'reserve-file-task'), false);
});

test('File Task interrupted recovery 复用原 exact owner 与 manifest，不 begin/reserve/发新号', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-recovery-'));
  const outputPath = path.join(rootDir, 'diff.xlsx');
  const plan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: outputPath,
      role: 'output',
      sourceOperation: FILE_POLICY.channel
    }]
  });
  const recoveryContext = {
    batchId: 88,
    batchNumber: '2026-08-18-088',
    taskRunId: 'file-recovery-task-88',
    taskKey: FILE_POLICY.taskKey,
    moduleId: FILE_POLICY.scopeId,
    parentRunId: 'file-recovery-parent-88',
    operationKey: 'file-recovery-operation-88'
  };
  const { calls, lifecycle } = createHarness();
  try {
    const result = await lifecycle.runFileTask({
      policy: FILE_POLICY,
      meta: { channel: FILE_POLICY.channel },
      recovery: { batchContext: recoveryContext, evidence: { runId: 88 } },
      filePlanResolver: ({ taskRun }) => {
        assert.equal(taskRun.taskRunId, recoveryContext.taskRunId);
        return plan;
      },
      execute: async (context, controls) => {
        assert.deepEqual(context, recoveryContext);
        fs.writeFileSync(outputPath, 'recovered');
        await controls.settleArtifacts({
          files: plan.outputs.map((item) => ({ artifactKey: item.artifactKey }))
        });
        return { status: 'success' };
      }
    });
    assert.equal(result.status, 'success');
    assert.equal(calls.some((call) => call[0] === 'begin-task-run'), false);
    assert.equal(calls.some((call) => call[0] === 'reserve-file-task'), false);
    assert.deepEqual(
      calls.filter((call) => call[0] === 'recover-file-task').map((call) => call[1]),
      [recoveryContext]
    );
    assert.equal(calls.filter((call) => call[0] === 'start-file-task').length, 1);
    assert.equal(calls.filter((call) => call[0] === 'finish-file-task').length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('file task cancel-wins 后迟到 success 不执行 afterTerminal', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-cancel-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'input.xlsx');
  const outputPath = path.join(tempDir, 'output.xlsx');
  fs.writeFileSync(inputPath, 'input');
  let release;
  let terminal = 'running';
  let afterTerminalCalls = 0;
  const { calls, lifecycle } = createHarness({
    reserveFileTask(payload) {
      return {
        ok: true,
        batch: {
          id: 32,
          batchNumber: '2026-08-17-032',
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    },
    finishFileTask(_taskRunId, _batchId, outcome) {
      if (terminal !== 'running') {
        return {
          ok: false,
          code: 'ARCHIVE_TASK_STATUS_CONFLICT',
          taskRun: { status: terminal }
        };
      }
      terminal = outcome.taskStatus;
      return { ok: true, taskRun: { status: terminal } };
    }
  });
  const pending = lifecycle.runFileTask({
    policy: FILE_POLICY,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: () => normalizedToolboxPlan(inputPath, outputPath),
    execute: () => new Promise((resolve) => { release = resolve; }),
    afterTerminal: () => { afterTerminalCalls += 1; }
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await lifecycle.cancelActive(null, '用户取消');
  assert.equal(cancelled.cancelled, true);
  assert.equal(calls.filter((call) => call[0] === 'finish-file-task').length, 1);
  assert.equal(calls.some((call) => call[0] === 'cancel'), false);
  release({ status: 'success' });
  await pending;
  assert.equal(terminal, 'cancelled');
  assert.equal(afterTerminalCalls, 0);
  assert.equal(calls.some((call) => call[0] === 'persist-terminal-intent'), false);
});

test('file task 成功但 manifest 未 durable 时只写 file-owner outbox，不提前终结', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-outbox-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'input.xlsx');
  const outputPath = path.join(tempDir, 'output.xlsx');
  fs.writeFileSync(inputPath, 'input');
  const { calls, lifecycle } = createHarness({
    reserveFileTask(payload) {
      return {
        ok: true,
        batch: {
          id: 33,
          batchNumber: '2026-08-17-033',
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    },
    settleManifestResult: { ok: false, durable: false, code: 'ARCHIVE_OUTPUT_NOT_READY' }
  });
  const result = await lifecycle.runFileTask({
    policy: FILE_POLICY,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: () => normalizedToolboxPlan(inputPath, outputPath),
    execute: () => {
      fs.writeFileSync(outputPath, 'output');
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.some((call) => call[0] === 'finish-file-task'), false);
  const persisted = calls.find((call) => call[0] === 'persist-terminal-intent')[1];
  assert.equal(persisted.owner.kind, 'file-batch');
  assert.equal(persisted.owner.batchContext.batchId, 33);
  assert.equal(persisted.terminalOutcome.taskStatus, 'succeeded');
});

test('file artifact 失败结果已耐久时直接终结为业务 succeeded，不创建永久 outbox', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-file-incomplete-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'input.xlsx');
  const outputPath = path.join(tempDir, 'missing.xlsx');
  fs.writeFileSync(inputPath, 'input');
  const { calls, lifecycle } = createHarness({
    reserveFileTask(payload) {
      return {
        ok: true,
        batch: {
          id: 34,
          batchNumber: '2026-08-17-034',
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    },
    settleManifestResult: {
      ok: false,
      durable: true,
      code: 'ARCHIVE_OUTPUT_NOT_PRODUCED'
    }
  });
  const result = await lifecycle.runFileTask({
    policy: FILE_POLICY,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: () => normalizedToolboxPlan(inputPath, outputPath),
    execute: () => ({ status: 'success' })
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.filter((call) => call[0] === 'finish-file-task').length, 1);
  assert.equal(calls.some((call) => call[0] === 'persist-terminal-intent'), false);
});

test('deferred 零输出只终结 Task Run，不预留 File Batch', async () => {
  const { calls, lifecycle } = createHarness();
  const initialPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'deferred',
    inputs: [],
    outputs: []
  });
  const result = await lifecycle.runDeferredFileTask({
    policy: DEFERRED_FILE_POLICY,
    prepared: { filePlan: initialPlan },
    filePlanResolver: () => initialPlan,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    beforeStart: () => ({}),
    execute: (_context, controls) => {
      assert.equal(controls.fileEvidence.filePlan.allocation, 'deferred');
      assert.equal(controls.fileEvidence.filePlan.inputs.length, 0);
      assert.equal(controls.fileEvidence.filePlan.outputs.length, 0);
      return { status: 'failed', message: '没有可生成的记录' };
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(calls.some((call) => call[0] === 'reserve-file-task'), false);
  assert.equal(calls.some((call) => call[0] === 'settle-manifest'), false);
  assert.equal(calls.filter((call) => call[0] === 'finish-task-run').length, 1);
});

test('deferred literal FilePlan resolver 失败以 operation owner 收口，不遗留 prepared Task Run', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.runDeferredFileTask({
    policy: DEFERRED_FILE_POLICY,
    prepared: {},
    filePlanResolver: () => {
      const error = new Error('入口缺少 deferred filePlan');
      error.code = 'ARCHIVE_FILE_PLAN_INVALID';
      throw error;
    },
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    execute: () => {
      throw new Error('业务不应开始');
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_FILE_PLAN_INVALID');
  assert.equal(calls.filter((call) => call[0] === 'begin-task-run').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'finish-task-run').length, 1);
  assert.equal(calls.some((call) => call[0] === 'reserve-file-task'), false);
});

test('deferred 在正式写入前 promote，并以同一 manifest settle/终结 File Task', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-deferred-file-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputPath = path.join(tempDir, 'monthly.xlsx');
  let manifest;
  const { calls, lifecycle } = createHarness({
    reserveFileTask(payload) {
      manifest = payload.manifest;
      return {
        ok: true,
        batch: {
          id: 35,
          batchNumber: '2026-08-18-035',
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    }
  });
  const initialPlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'deferred',
    inputs: [],
    outputs: []
  });
  const result = await lifecycle.runDeferredFileTask({
    policy: DEFERRED_FILE_POLICY,
    prepared: { filePlan: initialPlan },
    filePlanResolver: () => initialPlan,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    execute: async (_context, controls) => {
      const promotionManifest = artifactManifestFromFilePlan(normalizeFilePlanV1({
        version: 1,
        allocation: 'eager',
        inputs: [],
        outputs: [{
          filePath: outputPath,
          role: 'output',
          sourceOperation: DEFERRED_FILE_POLICY.channel
        }]
      }));
      const batchContext = await controls.ensureFileBatch(promotionManifest);
      assert.equal(batchContext.batchId, 35);
      assert.equal(fs.existsSync(outputPath), false);
      fs.writeFileSync(promotionManifest.outputs[0].filePath, 'monthly');
      await controls.settleArtifacts({
        files: promotionManifest.outputs.map((item) => ({ artifactKey: item.artifactKey }))
      });
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(manifest.outputs[0].filePath, outputPath);
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin',
    'resolve-flow',
    'begin-task-run',
    'start-task-run',
    'reserve-file-task',
    'settle-manifest',
    'finish-file-task',
    'end'
  ]);
  assert.deepEqual(
    calls.find((call) => call[0] === 'settle-manifest')[1].files,
    manifest.outputs.map((item) => ({ artifactKey: item.artifactKey }))
  );
});

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

test('no-file Task Run 使用 exact-5 operation owner，且不进入 batch reserve/append', async () => {
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    execute(context, runtime) {
      assert.deepEqual(Object.keys(context), [
        'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'
      ]);
      assert.deepEqual(runtime.fileEvidence, {});
      return { status: 'success' };
    }
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'begin-task-run', 'start-task-run',
    'finish-task-run', 'end'
  ]);
});

test('lifecycle 只在 begin 边界规范化 lineage，并把同一冻结集合交给 taskContext', async () => {
  const { calls, lifecycle } = createHarness();
  const rawLineage = [{
    version: 1,
    kind: 'dataset-input',
    lineageKey: 'pending-dataset-1',
    inputRole: 'Upper Pending',
    sourceContractVersion: 1,
    producerTaskRunId: 'producer-task-1'
  }];
  await lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    lineageIntents: rawLineage,
    execute(_context, runtime) {
      assert.equal(Object.isFrozen(runtime.lineageIntents), true);
      assert.equal(Object.isFrozen(runtime.lineageIntents[0]), true);
      assert.equal(runtime.lineageIntents[0].lineageKey, 'pending-dataset-1');
      return { status: 'success' };
    }
  });
  const begun = calls.find((call) => call[0] === 'begin-task-run')[1];
  assert.equal(begun.lineageIntents[0].lineageKey, 'pending-dataset-1');
  assert.equal(Object.isFrozen(begun.lineageIntents), true);
  rawLineage[0].lineageKey = 'mutated-after-run';
  assert.equal(begun.lineageIntents[0].lineageKey, 'pending-dataset-1');
});

test('no-file 入口绑定、evidence、start 失败时终态 CAS 失败均写 operation owner intent', async (t) => {
  const cases = [
    {
      name: 'initial-bind',
      overrides: { flowResult: { parentRunId: 'parent-1', source: 'new', identity: { type: 'run', value: '1' } }, bindError: new Error('bind failed') },
      invocation: {}
    },
    {
      name: 'evidence',
      overrides: {},
      invocation: { beforeStart() { throw new Error('evidence failed'); } }
    },
    {
      name: 'start',
      overrides: { markTaskRunStartedResult: { ok: false, code: 'START_FAILED' } },
      invocation: {}
    }
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { calls, lifecycle } = createHarness({
        ...entry.overrides,
        finishTaskRunResult: { ok: false, code: 'DB_DOWN', message: 'db down' }
      });
      const result = await lifecycle.runOperationOnly({
        policy: NO_FILE_POLICY,
        meta: { channel: NO_FILE_POLICY.channel },
        execute: () => ({ status: 'success' }),
        ...entry.invocation
      });
      assert.equal(result.status, 'failed');
      const persisted = calls.find((call) => call[0] === 'persist-terminal-intent');
      assert.ok(persisted, entry.name);
      assert.equal(persisted[1].owner.kind, 'operation');
      assert.equal(persisted[1].owner.version, 1);
      assert.equal(persisted[1].owner.operationContext.taskRunId, 'task-1');
    });
  }
});

test('no-file initial flow bind 与 durable intent 同时失败仍终结 Task Run', async () => {
  const persistError = Object.assign(new Error('intent db down'), { code: 'FLOW_INTENT_DOWN' });
  const { calls, lifecycle } = createHarness({
    flowResult: {
      parentRunId: 'parent-1',
      source: 'new',
      identity: { type: 'run', value: '1' }
    },
    bindError: new Error('bind failed'),
    persistBindIntentError: persistError
  });
  const result = await lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    execute: () => ({ status: 'success' })
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'FLOW_INTENT_DOWN');
  const finish = calls.find((call) => call[0] === 'finish-task-run');
  assert.equal(finish[2].taskStatus, 'failed');
  assert.equal(calls.some((call) => call[0] === 'execute'), false);
});

test('no-file result identity resolve 失败只告警，但一定继续 terminal settle', async () => {
  const { calls, lifecycle, warnings } = createHarness();
  const result = await lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    execute: () => ({ status: 'success' }),
    resultFlowIdentities() {
      throw Object.assign(new Error('identity parse failed'), { code: 'IDENTITY_PARSE_FAILED' });
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(calls.find((call) => call[0] === 'finish-task-run')[2].taskStatus, 'succeeded');
  assert.equal(warnings.some((warning) => warning.code === 'IDENTITY_PARSE_FAILED'), true);
});

test('no-file result bind 与 intent 同时失败改写 failed terminal；CAS 失败则写 owner outbox', async () => {
  const { calls, lifecycle } = createHarness({
    bindError: new Error('bind failed'),
    persistBindIntentError: Object.assign(new Error('intent failed'), {
      code: 'RESULT_FLOW_INTENT_FAILED'
    }),
    finishTaskRunResult: { ok: false, code: 'DB_DOWN', message: 'terminal db down' }
  });
  const result = await lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    lineageIntents: [{
      version: 1,
      kind: 'dataset-input',
      lineageKey: 'pending-dataset-1',
      inputRole: 'Pending',
      sourceContractVersion: 1,
      producerTaskRunId: 'producer-task-1'
    }],
    execute: () => ({ status: 'success', runId: 'result-1' }),
    resultFlowIdentities: (value) => [{ type: 'run-id', value: value.runId }]
  });
  assert.equal(result.status, 'success');
  const finish = calls.find((call) => call[0] === 'finish-task-run');
  assert.equal(finish[2].taskStatus, 'failed');
  assert.equal(finish[2].code, 'RESULT_FLOW_INTENT_FAILED');
  const persisted = calls.find((call) => call[0] === 'persist-terminal-intent');
  assert.equal(persisted[1].owner.kind, 'operation');
  assert.equal(persisted[1].terminalOutcome.taskStatus, 'failed');
  assert.equal('lineageIntents' in persisted[1], false);
});

test('no-file cancel 先到终态后，迟到 success 保持 cancelled 且不执行 afterTerminal', async () => {
  let terminal = 'running';
  let release;
  let afterTerminalCalls = 0;
  const { calls, lifecycle } = createHarness({
    finishTaskRun(_taskRunId, outcome) {
      if (terminal !== 'running') {
        return {
          ok: false,
          code: 'ARCHIVE_TASK_STATUS_CONFLICT',
          taskRun: { status: terminal }
        };
      }
      terminal = outcome.taskStatus;
      return { ok: true, taskRun: { status: terminal } };
    }
  });
  const pending = lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    meta: { channel: NO_FILE_POLICY.channel },
    execute: () => new Promise((resolve) => { release = resolve; }),
    afterTerminal: () => { afterTerminalCalls += 1; }
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await lifecycle.cancelActive(null, 'user cancelled');
  assert.equal(cancelled.status, 'cancelled');
  release({ status: 'success' });
  await pending;
  assert.equal(terminal, 'cancelled');
  assert.equal(afterTerminalCalls, 0);
  assert.equal(calls.some((call) => call[0] === 'persist-terminal-intent'), false);
});

test('no-file policy 对任何 filePlan fail-fast', async () => {
  const { calls, lifecycle } = createHarness();
  await assert.rejects(lifecycle.runOperationOnly({
    policy: NO_FILE_POLICY,
    prepared: {
      filePlan: {
        version: 1,
        allocation: 'eager',
        inputs: [{ filePath: '/tmp/input.xlsx' }],
        outputs: []
      }
    },
    execute: () => ({ status: 'success' })
  }), /不能丢弃 filePlan/);
  assert.equal(calls.length, 0);
});

test('显式允许的部分提交失败结果仍绑定业务身份并以 failed 收口', async () => {
  const { calls, lifecycle } = createHarness();
  const partialPolicy = Object.freeze({
    ...POLICY,
    bindResultFlowIdentitiesOnFailure: true
  });
  const result = await lifecycle.run({
    policy: partialPolicy,
    meta: { channel: partialPolicy.channel },
    execute: () => ({
      status: 'failed',
      batchId: 'partial-batch',
      recordId: 9,
      partialCommitted: true
    }),
    resultFlowIdentities: (value) => [
      { type: 'partial-batch', value: value.batchId },
      { type: 'partial-record', value: value.recordId }
    ]
  });
  assert.equal(result.status, 'failed');
  const bindCall = calls.find((call) => call[0] === 'bind-flow');
  assert.deepEqual(bindCall[1].identities, [
    { type: 'partial-batch', value: 'partial-batch' },
    { type: 'partial-record', value: 9 }
  ]);
  assert.ok(calls.some((call) => call[0] === 'fail'));
});

test('toolbox reserve 失败时不进入算法或输出副作用', async () => {
  const toolboxPolicy = createTaskPolicyRegistry().require('toolbox:split:export');
  const { calls, lifecycle } = createHarness({
    reserveResult: {
      ok: false,
      code: 'ARCHIVE_BATCH_RESERVATION_FAILED',
      message: 'reserve failed'
    }
  });
  const result = await lifecycle.run({
    policy: toolboxPolicy,
    meta: { channel: toolboxPolicy.channel },
    execute: () => {
      calls.push(['unexpected-toolbox-output']);
      return { status: 'success' };
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ARCHIVE_BATCH_RESERVATION_FAILED');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'end'
  ]);
});

test('toolbox freshness 在 reserve 后失败时终结原批次且不执行算法', async () => {
  const toolboxPolicy = createTaskPolicyRegistry().require('toolbox:split:export');
  const { calls, lifecycle } = createHarness();
  const result = await lifecycle.run({
    policy: toolboxPolicy,
    meta: { channel: toolboxPolicy.channel },
    beforeStart: () => {
      calls.push(['verify-toolbox-source']);
      const error = new Error('拆分源文件在读取后已变化，请重新选择');
      error.code = 'TOOLBOX_SPLIT_SOURCE_CHANGED';
      throw error;
    },
    execute: () => {
      calls.push(['unexpected-toolbox-output']);
      return { status: 'success' };
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'TOOLBOX_SPLIT_SOURCE_CHANGED');
  assert.deepEqual(calls.map((call) => call[0]), [
    'begin', 'resolve-flow', 'reserve', 'verify-toolbox-source', 'fail', 'end'
  ]);
  assert.equal(calls.find((call) => call[0] === 'fail')[1], 11);
});

test('reserve 后业务未开始且直接终态写失败时，把 failed 意图持久化到原批次 outbox', async () => {
  const { calls, lifecycle } = createHarness({
    failResult: {
      ok: false,
      code: 'ARCHIVE_DATABASE_BUSY',
      message: 'terminal write failed'
    }
  });
  const result = await lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    beforeStart: () => {
      const error = new Error('source changed');
      error.code = 'SOURCE_CHANGED';
      throw error;
    },
    execute: () => ({ status: 'success' })
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SOURCE_CHANGED');
  const persisted = calls.find((call) => call[0] === 'persist-terminal-intent');
  assert.ok(persisted);
  assert.equal(persisted[1].batchContext.batchId, 11);
  assert.deepEqual(persisted[1].terminalOutcome, {
    taskStatus: 'failed',
    code: 'SOURCE_CHANGED',
    message: 'source changed',
    metadata: {}
  });
  assert.equal(calls.some((call) => call[0] === 'execute'), false);
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

test('Bank Statement run 在 TaskRun 前绑定稳定 identity，重复 export 继承同一 parent，显式 rerun 新建 parent', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-flow-parent-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const anchors = new Map();
  let parentSequence = 0;
  let batchSequence = 0;
  const { calls, lifecycle } = createHarness({
    resolveFlow(payload) {
      if (payload.startsNewFlow) {
        parentSequence += 1;
        return {
          parentRunId: `parent-${parentSequence}`,
          source: 'new',
          identity: payload.identity
        };
      }
      return {
        parentRunId: anchors.get(payload.identity.value),
        source: 'existing',
        identity: payload.identity
      };
    },
    bindFlow(payload) {
      for (const identity of payload.identities) {
        anchors.set(identity.value, payload.parentRunId);
      }
      return [];
    },
    reserveFileTask(payload) {
      batchSequence += 1;
      return {
        ok: true,
        batch: {
          id: batchSequence,
          batchNumber: `batch-${batchSequence}`,
          taskRunId: payload.taskRun.taskRunId,
          taskKey: payload.taskRun.taskKey,
          moduleId: payload.taskRun.moduleId,
          parentRunId: payload.taskRun.parentRunId,
          operationKey: payload.taskRun.operationKey
        }
      };
    }
  });
  const registry = createTaskPolicyRegistry();
  const runPolicy = registry.require('bank-statement:run');
  const exportPolicy = registry.require('bank-statement:export');
  const firstIdentity = createBankStatementRunFlowIdentity(() => 'run-1');
  await lifecycle.runOperationOnly({
    policy: runPolicy,
    meta: { channel: runPolicy.channel },
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: firstIdentity }),
    execute: () => ({ status: 'ok' })
  });
  for (let index = 0; index < 2; index += 1) {
    const outputPath = path.join(rootDir, `export-${index}.xlsx`);
    const plan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{
        filePath: outputPath,
        role: 'output',
        sourceOperation: exportPolicy.channel
      }]
    });
    await lifecycle.runFileTask({
      policy: exportPolicy,
      meta: { channel: exportPolicy.channel },
      flowPlanResolver: () => ({ startsNewFlow: false, flowIdentity: firstIdentity }),
      filePlanResolver: () => plan,
      execute: async (_context, controls) => {
        fs.writeFileSync(outputPath, 'export');
        await controls.settleArtifacts({
          files: plan.outputs.map((item) => ({ artifactKey: item.artifactKey }))
        });
        return { status: 'ok' };
      }
    });
  }
  const secondIdentity = createBankStatementRunFlowIdentity(() => 'run-2');
  await lifecycle.runOperationOnly({
    policy: runPolicy,
    meta: { channel: runPolicy.channel },
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: secondIdentity }),
    execute: () => ({ status: 'ok' })
  });
  const parents = calls
    .filter((call) => call[0] === 'begin-task-run')
    .map((call) => call[1].parentRunId);
  assert.deepEqual(parents, ['parent-1', 'parent-1', 'parent-1', 'parent-2']);
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

test('业务成功但 terminal 返回失败时持久化同批次终态意图并保留业务结果', async () => {
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
  const persisted = calls.find((call) => call[0] === 'persist-terminal-intent');
  assert.deepEqual(persisted[1].batchContext, {
    batchId: 11,
    batchNumber: '2026-08-10-001',
    taskRunId: 'task-1',
    taskKey: POLICY.taskKey,
    moduleId: POLICY.scopeId,
    parentRunId: 'parent-1',
    operationKey: 'reconcile-run:task-1'
  });
  assert.equal(persisted[1].terminalOutcome.taskStatus, 'succeeded');
  assert.equal(warnings.some((warning) => warning.code === 'ARCHIVE_DB_WRITE_FAILED'), true);
});

test('任务终态写入和持久意图登记均失败时 fail-closed', async () => {
  const { lifecycle } = createHarness({
    completeResult: { ok: false, code: 'ARCHIVE_DB_WRITE_FAILED', message: 'write failed' },
    persistTerminalIntentError: new Error('outbox unavailable')
  });
  await assert.rejects(lifecycle.run({
    policy: POLICY,
    meta: { channel: POLICY.channel },
    execute: () => ({ status: 'success', value: 9 })
  }), (error) => (
    error.code === 'ARCHIVE_TASK_TERMINAL_INTENT_FAILED'
    && error.businessResult.value === 9
    && error.cause.message === 'outbox unavailable'
  ));
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
