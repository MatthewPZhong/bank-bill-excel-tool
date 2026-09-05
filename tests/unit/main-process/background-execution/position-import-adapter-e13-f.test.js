'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  POSITION_IMPORT_COMMANDS
} = require('../../../../src/backend/position-reconciliation-import/constants');
const {
  POSITION_IMPORT_ADAPTER_ACTION,
  POSITION_IMPORT_ADAPTER_POLICY,
  validatePositionImportAdapterResult
} = require(
  '../../../../src/main-process/background-execution/position-import-adapter-policy'
);
const {
  POSITION_IMPORT_ADAPTER_INTENTS,
  createPositionImportMatureBinding
} = require(
  '../../../../src/main-process/background-execution/adapters/position-import-adapter'
);
const {
  BACKGROUND_EXECUTION_POLICIES,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const {
  assertFinanceSafeValue
} = require('../../../../src/main-process/background-execution/error-codec');
const {
  bindingSnapshot
} = require(
  '../../../../src/main-process/background-execution/action-task-binding-registry'
);

const CANONICAL_POLICY_FIXTURE = path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json'
);

function operationContext(operationKey = 'operation-e13-f') {
  return Object.freeze({
    taskRunId: 'task-e13-f',
    taskKey: 'position-reconciliation:source:prepare-import',
    moduleId: 'position-reconciliation',
    parentRunId: 'parent-e13-f',
    operationKey
  });
}

function batchContext(operationKey = 'operation-e13-f') {
  return Object.freeze({
    batchId: 32516,
    batchNumber: '2026-08-31-32516',
    ...operationContext(operationKey)
  });
}

function request(intent, input = {}, overrides = {}) {
  const operationKey = overrides.operationKey || 'operation-e13-f';
  return {
    actionKey: POSITION_IMPORT_ADAPTER_ACTION,
    operationKey,
    jobId: overrides.jobId || 'job-e13-f',
    context: { kind: 'operation', value: operationContext(operationKey) },
    topology: {
      effectiveChildCount:
        intent === POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY ? 1 : 0
    },
    input: {
      intent,
      ...input
    },
    ...(overrides.request || {})
  };
}

function checkpoint(generation) {
  return {
    identity: 'position-e13-f-side-db',
    generation,
    token: `position-e13-f-token-${generation}`
  };
}

function bankPreflight(jobId = 'job-e13-f') {
  return {
    jobId,
    archiveManifestHash: 'a'.repeat(64),
    acceptedBankFiles: [{ rowCount: 2 }],
    acceptedOrdinaryInputFiles: [],
    orderedFileResults: [{ status: 'ok', rowCount: 2 }],
    accountConfirmationDescriptor: null
  };
}

function sourcePreflight(jobId = 'job-e13-f') {
  return {
    jobId,
    archiveManifestHash: 'c'.repeat(64),
    acceptedBankFiles: [],
    acceptedOrdinaryInputFiles: [{ rowCount: 3 }],
    orderedFileResults: [{ status: 'ok', rowCount: 3 }],
    accountConfirmationDescriptor: null
  };
}

test('E13-F policy 以 current dispatcher 修正 Position compound topology 并保持 production false', () => {
  const fixture = JSON.parse(fs.readFileSync(CANONICAL_POLICY_FIXTURE, 'utf8'));
  const expected = structuredClone(fixture.actions[POSITION_IMPORT_ADAPTER_ACTION]);
  expected.description =
    'v3.2.5 E13-F Position existing utility-process dispatcher capability';
  expected.resources.compound.childrenMax = 1;
  expected.production = {
    enabled: false,
    effectiveMode: 'legacy',
    effectiveWorkerCount: 0,
    recoveryStatus: 'probe',
    evidenceStatus: 'baseline',
    downgradeReason: 'PENDING_HUMAN_REVIEW',
    benchmarkEvidenceId: null
  };
  assert.deepEqual(POSITION_IMPORT_ADAPTER_POLICY, expected);
  assert.equal(
    BACKGROUND_EXECUTION_POLICIES.find(
      (policy) => policy.actionKey === POSITION_IMPORT_ADAPTER_ACTION
    ),
    POSITION_IMPORT_ADAPTER_POLICY
  );
  assert.deepEqual(bindingSnapshot()[POSITION_IMPORT_ADAPTER_ACTION], [
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:run:import-result',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:prepare-import'
  ]);
});

test('E13-F topology/owner 在 existing dispatcher 前 fail closed', () => {
  let dispatches = 0;
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch() {
      dispatches += 1;
      return { promise: Promise.resolve({}) };
    }
  });
  const bank = request(POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE, {
    files: ['/tmp/e13-f-bank.xlsx']
  });
  assert.deepEqual(binding.inspectTopology(bank), { effectiveChildCount: 0 });
  const source = request(POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY, {
    files: ['/tmp/e13-f-source.xlsx'],
    batchContext: batchContext()
  });
  assert.deepEqual(binding.inspectTopology(source), { effectiveChildCount: 1 });

  assert.throws(
    () => binding.dispatch({
      ...source,
      topology: { effectiveChildCount: 0 }
    }),
    { code: 'POSITION_IMPORT_ADAPTER_TOPOLOGY_MISMATCH' }
  );
  assert.throws(
    () => binding.inspectTopology(request(
      POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY,
      {
        files: ['/tmp/e13-f-source.xlsx'],
        batchContext: { ...batchContext(), taskRunId: 'other-task' }
      }
    )),
    { code: 'POSITION_IMPORT_ADAPTER_OWNER_MISMATCH' }
  );
  assert.throws(
    () => binding.inspectTopology(request(
      POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      {
        files: ['/tmp/e13-f-bank.xlsx'],
        sideDbPath: '/tmp/caller.sqlite'
      }
    )),
    { code: 'POSITION_IMPORT_ADAPTER_AUTHORITY_OVERRIDE_FORBIDDEN' }
  );
  assert.equal(dispatches, 0);
});

test('E13-F bank prepare 复用原 dispatcher、投影隐私安全 progress/result 且不外套 process', async () => {
  const calls = [];
  const progress = [];
  const capturedPreflights = [];
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    onPreflightReady(value) { capturedPreflights.push(value); },
    dispatch(input) {
      calls.push(input);
      input.onProgress({
        jobId: input.jobId,
        stage: 'staging',
        fileName: '6222021234567890.xlsx',
        currentFile: '/Users/example/Documents/6222021234567890.xlsx',
        totalFiles: 1,
        scannedRows: 2,
        acceptedRows: 2,
        committedRows: 0,
        copiedBytes: 128,
        totalBytes: 256,
        elapsedMs: 9
      });
      const preflight = bankPreflight(input.jobId);
      input.onPreflightReady(preflight);
      return {
        promise: Promise.resolve({
          ...preflight,
          preflightReady: preflight,
          cancelAcknowledged: false
        })
      };
    }
  });
  const handle = binding.dispatch({
    ...request(POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE, {
      files: ['/tmp/e13-f-bank.xlsx']
    }),
    onProgress(value) { progress.push(value); }
  });
  const result = await handle.promise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, POSITION_IMPORT_COMMANDS.BANK_PREPARE);
  assert.deepEqual(calls[0].operationContext, operationContext());
  assert.equal(Object.hasOwn(calls[0], 'batchContext'), false);
  assert.equal(capturedPreflights.length, 1);
  assert.deepEqual(result, {
    command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
    jobId: 'job-e13-f',
    outcome: 'preflight-complete',
    acceptedFileCount: 1,
    failedFileCount: 0,
    confirmationCount: 0,
    rowCount: 2,
    committedMutations: 0,
    checkpointGeneration: null,
    recoveredFromWorkerExit: false,
    cancelAcknowledged: false
  });
  assert.equal(validatePositionImportAdapterResult(result), true);
  assert.deepEqual(progress, [{
    stage: 'staging',
    totalFiles: 1,
    scannedRows: 2,
    acceptedRows: 2,
    committedRows: 0,
    copiedBytes: 128,
    totalBytes: 256,
    elapsedMs: 9,
    heartbeat: false
  }]);
  assert.doesNotThrow(() => assertFinanceSafeValue(
    result,
    'finance-safe-v1',
    '/payload/result',
    { allowValue: validatePositionImportAdapterResult.allowFinanceSafeValue }
  ));
  assert.equal(JSON.stringify(progress).includes('622202'), false);
  assert.equal(JSON.stringify(progress).includes('/Users/'), false);
});

test('E13-F confirmed bank apply 先跑 schema migration，再以 Main authority 启动原 apply', async () => {
  const calls = [];
  const preflight = bankPreflight('prepared-bank-e13-f');
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    currentCheckpoint: checkpoint(1),
    operationToken: 'task-e13-f',
    resolvePreparedImport: async (key) => {
      assert.equal(key, 'prepared-bank-e13-f');
      return preflight;
    },
    dispatchSchemaMigration(input) {
      calls.push({ kind: 'schema', input });
      return { promise: Promise.resolve({ fingerprint: 'b'.repeat(64) }) };
    },
    dispatch(input) {
      calls.push({ kind: 'apply', input });
      return {
        promise: Promise.resolve({
          rowCount: 4,
          nextCheckpoint: checkpoint(2),
          preflightReady: preflight,
          cancelAcknowledged: false
        })
      };
    }
  });
  const result = await binding.dispatch(request(
    POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY,
    {
      preparedImportKey: 'prepared-bank-e13-f',
      batchContext: batchContext()
    }
  )).promise;
  assert.deepEqual(calls.map((item) => item.kind), ['schema', 'apply']);
  assert.deepEqual(calls[0].input.batchContext, batchContext());
  assert.equal(calls[1].input.operationToken, 'task-e13-f');
  assert.deepEqual(calls[1].input.expectedCheckpoint, checkpoint(1));
  assert.equal(calls[1].input.payload.schemaFingerprint, 'b'.repeat(64));
  assert.equal(calls[1].input.payload.preflightReady, preflight);
  assert.deepEqual(result, {
    command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
    jobId: 'job-e13-f',
    outcome: 'committed',
    acceptedFileCount: 1,
    failedFileCount: 0,
    confirmationCount: 0,
    rowCount: 4,
    committedMutations: 1,
    checkpointGeneration: 2,
    recoveredFromWorkerExit: false,
    cancelAcknowledged: false
  });
});

test('E13-F confirmed apply 的 schema 拒绝即时取消后，在下一安全点停止且不启动 apply', async () => {
  let schemaInput = null;
  let resolveSchema;
  let applyCalls = 0;
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    currentCheckpoint: checkpoint(1),
    operationToken: 'task-e13-f',
    resolvePreparedImport: async () => bankPreflight('prepared-bank-e13-f'),
    dispatchSchemaMigration(input) {
      schemaInput = input;
      return {
        promise: new Promise((resolve) => { resolveSchema = resolve; }),
        cancel() {
          queueMicrotask(() => input.onCancelAck({
            jobId: input.jobId,
            stage: 'committing',
            accepted: false
          }));
          return true;
        }
      };
    },
    dispatch() {
      applyCalls += 1;
      throw new Error('取消后的 apply 不得启动');
    }
  });
  const handle = binding.dispatch(request(POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY, {
    preparedImportKey: 'prepared-bank-e13-f',
    batchContext: batchContext()
  }));
  while (!schemaInput) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await handle.cancel(), { acknowledged: false });
  resolveSchema({ fingerprint: 'b'.repeat(64) });
  await assert.rejects(handle.promise, { code: 'POSITION_IMPORT_ADAPTER_CANCELLED' });
  assert.equal(applyCalls, 0);
});

test('E13-F source grant 强制绑定 exact-7 owner，且保留原 durable authorizer', async () => {
  const grants = [];
  const calls = [];
  const preflight = sourcePreflight();
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    authorizeSourceApply: async (value) => {
      assert.equal(value, preflight);
      return {
        operationToken: 'task-e13-f',
        archiveManifestHash: value.archiveManifestHash,
        schemaFingerprint: 'd'.repeat(64),
        baseCheckpoint: checkpoint(1),
        batchContext: batchContext(),
        extraSecret: 'must-not-cross-the-grant-boundary'
      };
    },
    dispatch(input) {
      calls.push(input);
      return {
        promise: Promise.resolve().then(async () => {
          input.onPreflightReady(preflight);
          grants.push(await input.authorizeApply(preflight));
          return {
            status: 'ok',
            results: [{ status: 'ok', applied: true, rowCount: 3 }],
            successCount: 1,
            failedCount: 0,
            confirmationCount: 0,
            checkpoint: checkpoint(2),
            preflightReady: preflight,
            cancelAcknowledged: false
          };
        })
      };
    }
  });
  const result = await binding.dispatch(request(
    POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY,
    {
      files: ['/tmp/e13-f-source.xlsx'],
      batchContext: batchContext()
    }
  )).promise;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].operationContext, operationContext());
  assert.equal(Object.hasOwn(calls[0], 'batchContext'), false);
  assert.deepEqual(grants[0].batchContext, batchContext());
  assert.deepEqual(Object.keys(grants[0]).sort(), [
    'archiveManifestHash',
    'baseCheckpoint',
    'batchContext',
    'operationToken',
    'preflightOnly',
    'schemaFingerprint'
  ]);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.committedMutations, 1);
  assert.equal(result.rowCount, 3);
});

test('E13-F source grant 等待 Main authority 时收到真实取消，不再向原 worker 发放 durable grant', async () => {
  let releaseAuthority;
  let markAuthorityStarted;
  let returnedGrant = null;
  const authorityStarted = new Promise((resolve) => { markAuthorityStarted = resolve; });
  const preflight = sourcePreflight();
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    authorizeSourceApply: async () => {
      markAuthorityStarted();
      await new Promise((resolve) => { releaseAuthority = resolve; });
      return {
        operationToken: 'task-e13-f',
        archiveManifestHash: preflight.archiveManifestHash,
        schemaFingerprint: 'd'.repeat(64),
        baseCheckpoint: checkpoint(1),
        batchContext: batchContext()
      };
    },
    dispatch(input) {
      return {
        promise: Promise.resolve().then(async () => {
          input.onPreflightReady(preflight);
          returnedGrant = await input.authorizeApply(preflight);
          return {
            status: 'ok',
            results: [{ status: 'ok', applied: true, rowCount: 3 }],
            checkpoint: checkpoint(2),
            preflightReady: preflight
          };
        }),
        cancel() {
          queueMicrotask(() => input.onCancelAck({
            jobId: input.jobId,
            stage: 'awaiting-apply-grant',
            accepted: true
          }));
          return true;
        }
      };
    }
  });
  const handle = binding.dispatch(request(
    POSITION_IMPORT_ADAPTER_INTENTS.SOURCE_PREPARE_AND_APPLY,
    {
      files: ['/tmp/e13-f-source.xlsx'],
      batchContext: batchContext()
    }
  ));
  await authorityStarted;
  assert.deepEqual(await handle.cancel(), { acknowledged: true });
  releaseAuthority();
  await assert.rejects(handle.promise, { code: 'POSITION_IMPORT_ADAPTER_CANCELLED' });
  assert.equal(returnedGrant, null);
});

test('E13-F invalid preflight/checkpoint evidence 不得降级成 preflight success', async () => {
  const invalidCheckpointBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      const preflight = bankPreflight(input.jobId);
      return {
        promise: Promise.resolve({
          preflightReady: preflight,
          nextCheckpoint: { identity: '', generation: -1, token: '' }
        })
      };
    }
  });
  await assert.rejects(
    invalidCheckpointBinding.dispatch(request(
      POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      { files: ['/tmp/e13-f-bank.xlsx'] }
    )).promise,
    { code: 'POSITION_IMPORT_ADAPTER_CHECKPOINT_EVIDENCE_INVALID' }
  );

  const invalidPreflightBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      const preflight = { ...bankPreflight(input.jobId), archiveManifestHash: '' };
      return { promise: Promise.resolve({ ...preflight, preflightReady: preflight }) };
    }
  });
  await assert.rejects(
    invalidPreflightBinding.dispatch(request(
      POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      { files: ['/tmp/e13-f-bank.xlsx'] }
    )).promise,
    { code: 'POSITION_IMPORT_ADAPTER_PREFLIGHT_EVIDENCE_INVALID' }
  );

  const invalidCountBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      const preflight = bankPreflight(input.jobId);
      return {
        promise: Promise.resolve({
          ...preflight,
          preflightReady: preflight,
          failedCount: -1
        })
      };
    }
  });
  await assert.rejects(
    invalidCountBinding.dispatch(request(
      POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      { files: ['/tmp/e13-f-bank.xlsx'] }
    )).promise,
    { code: 'POSITION_IMPORT_ADAPTER_COUNT_EVIDENCE_INVALID' }
  );

  const conflictingCountBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      const preflight = bankPreflight(input.jobId);
      return {
        promise: Promise.resolve({
          ...preflight,
          preflightReady: preflight,
          results: [{ status: 'failed', rowCount: 0 }],
          failedCount: 0
        })
      };
    }
  });
  await assert.rejects(
    conflictingCountBinding.dispatch(request(
      POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      { files: ['/tmp/e13-f-bank.xlsx'] }
    )).promise,
    { code: 'POSITION_IMPORT_ADAPTER_COUNT_EVIDENCE_CONFLICT' }
  );
});

test('E13-F confirmed apply 拒绝错 kind selector 与错 task owner operation token', async () => {
  const wrongKind = sourcePreflight('prepared-bank-e13-f');
  const wrongKindBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    resolvePreparedImport: async () => wrongKind
  });
  await assert.rejects(
    wrongKindBinding.dispatch(request(POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY, {
      preparedImportKey: 'prepared-bank-e13-f',
      batchContext: batchContext()
    })).promise,
    { code: 'POSITION_IMPORT_ADAPTER_PREPARED_KIND_MISMATCH' }
  );

  const wrongOwnerBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    currentCheckpoint: checkpoint(1),
    operationToken: 'other-task',
    resolvePreparedImport: async () => bankPreflight('prepared-bank-e13-f')
  });
  await assert.rejects(
    wrongOwnerBinding.dispatch(request(POSITION_IMPORT_ADAPTER_INTENTS.BANK_APPLY, {
      preparedImportKey: 'prepared-bank-e13-f',
      batchContext: batchContext()
    })).promise,
    { code: 'POSITION_IMPORT_ADAPTER_OPERATION_TOKEN_OWNER_MISMATCH' }
  );
});

test('E13-F cancel 只在原 worker CANCEL_ACK accepted 后确认；committing reject 不伪装 cancelled', async () => {
  let finish;
  let cancelInput;
  const binding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      cancelInput = input;
      return {
        promise: new Promise((resolve) => { finish = resolve; }),
        cancel() {
          queueMicrotask(() => input.onCancelAck({
            jobId: input.jobId,
            stage: 'committing',
            accepted: false
          }));
          return true;
        }
      };
    }
  });
  const handle = binding.dispatch(request(
    POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
    { files: ['/tmp/e13-f-bank.xlsx'] }
  ));
  await Promise.resolve();
  assert.equal(cancelInput.command, POSITION_IMPORT_COMMANDS.BANK_PREPARE);
  assert.deepEqual(await handle.cancel(), { acknowledged: false });
  const preflight = bankPreflight();
  finish({ ...preflight, preflightReady: preflight, cancelAcknowledged: false });
  assert.equal((await handle.promise).outcome, 'preflight-complete');

  let finishAccepted;
  let acceptedInput;
  const acceptedThenSuccessBinding = createPositionImportMatureBinding({
    userDataDir: '/tmp/e13-f-user-data',
    sideDbPath: '/tmp/e13-f-side.sqlite',
    dispatch(input) {
      acceptedInput = input;
      return {
        promise: new Promise((resolve) => { finishAccepted = resolve; }),
        cancel() {
          queueMicrotask(() => input.onCancelAck({
            jobId: input.jobId,
            stage: 'staging',
            accepted: true
          }));
          return true;
        }
      };
    }
  });
  const acceptedHandle = acceptedThenSuccessBinding.dispatch(request(
    POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
    { files: ['/tmp/e13-f-bank.xlsx'] }
  ));
  while (!acceptedInput) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await acceptedHandle.cancel(), { acknowledged: true });
  finishAccepted({
    ...preflight,
    preflightReady: preflight,
    cancelAcknowledged: true
  });
  await assert.rejects(
    acceptedHandle.promise,
    { code: 'POSITION_IMPORT_ADAPTER_CANCEL_EVIDENCE_INVALID' }
  );
});

test('E13-F Supervisor shutdown 仅以真实 CANCEL_ACK + worker cancel error 收口 cancelled', async () => {
  let cancelCalls = 0;
  let rejectRaw;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 2,
      workerThreadSlots: 0,
      utilityProcessSlots: 2,
      ioHeavySlots: 2,
      memoryBytes: 2 * 1024 ** 3
    }
  });
  const runtime = createNonProductionBackgroundExecutionRuntime({
    resourceGovernor: governor,
    positionImport: {
      userDataDir: '/tmp/e13-f-user-data',
      sideDbPath: '/tmp/e13-f-side.sqlite',
      dispatch(input) {
        markStarted();
        return {
          promise: new Promise((_resolve, reject) => { rejectRaw = reject; }),
          cancel() {
            cancelCalls += 1;
            queueMicrotask(() => {
              input.onCancelAck({
                jobId: input.jobId,
                stage: 'staging',
                accepted: true
              });
              const error = new Error('cancelled by Position worker');
              error.code = 'position-import-cancelled';
              rejectRaw(error);
            });
            return true;
          }
        };
      }
    }
  });
  const execution = runtime.execute({
    actionKey: POSITION_IMPORT_ADAPTER_ACTION,
    operationKey: 'operation-e13-f-shutdown',
    jobId: 'job-e13-f-shutdown',
    production: false,
    context: {
      kind: 'operation',
      value: operationContext('operation-e13-f-shutdown')
    },
    input: {
      intent: POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      files: ['/tmp/e13-f-bank.xlsx']
    }
  });
  await started;
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  const result = await execution;
  assert.equal(cancelCalls, 1);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.terminalSource, 'job:error');
  assert.deepEqual(report.cancelledJobs, ['job-e13-f-shutdown']);
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});

test('E13-F non-production runtime 执行 existing dispatcher binding，不创建外层 utility process', async (t) => {
  let dispatches = 0;
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 2,
      workerThreadSlots: 0,
      utilityProcessSlots: 2,
      ioHeavySlots: 2,
      memoryBytes: 2 * 1024 ** 3
    }
  });
  const runtime = createNonProductionBackgroundExecutionRuntime({
    resourceGovernor: governor,
    positionImport: {
      userDataDir: '/tmp/e13-f-user-data',
      sideDbPath: '/tmp/e13-f-side.sqlite',
      dispatch(input) {
        dispatches += 1;
        const preflight = bankPreflight(input.jobId);
        return {
          promise: Promise.resolve({
            ...preflight,
            preflightReady: preflight,
            cancelAcknowledged: false
          })
        };
      }
    }
  });
  t.after(async () => { await runtime.shutdown({ timeoutMs: 10000 }); });
  const result = await runtime.execute({
    actionKey: POSITION_IMPORT_ADAPTER_ACTION,
    operationKey: 'operation-e13-f',
    jobId: 'job-e13-f-runtime',
    production: false,
    context: { kind: 'operation', value: operationContext() },
    input: {
      intent: POSITION_IMPORT_ADAPTER_INTENTS.BANK_PREPARE,
      files: ['/tmp/e13-f-bank.xlsx']
    }
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.terminalSource, 'job:done');
  assert.equal(result.result.command, POSITION_IMPORT_COMMANDS.BANK_PREPARE);
  assert.equal(dispatches, 1);
  assert.deepEqual(governor.snapshot().activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
});
