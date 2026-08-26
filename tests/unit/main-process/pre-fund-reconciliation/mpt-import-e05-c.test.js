'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../../src/main-process/background-execution/execution-policy-registry');
const { createJobEnvelope } = require('../../../../src/main-process/background-execution/protocol');
const {
  createBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  executeManagedPreFundMptImport
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/managed-import');
const {
  createOrderedMptCoordinator
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator');
const {
  PRE_FUND_MPT_IMPORT_ACTION,
  PRE_FUND_MPT_REPAIR_ACTION,
  preFundMptPolicy
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/policies');
const {
  FIXED_SAFETY_BYTES,
  PER_FILE_SAFETY_BYTES,
  assertMptSpoolDiskCapacity,
  estimateMptSpoolBytes
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-admission');
const {
  deriveFileIdentity,
  mptSpoolPaths
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-contract');
const {
  createPreFundMptRuntimeResourcePlan,
  createPreFundMptTopologyPlanner,
  maximumChildrenWithinBudget
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/topology');
const {
  writeMptFileSpool
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-writer');

const GIBIBYTE = 1024 ** 3;
let tempRoot;

test.beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-e05-c-'));
});

test.afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function batchContext(operationKey = 'prefund-e05-c-operation') {
  return {
    batchId: 1,
    batchNumber: 'BATCH-E05-C',
    taskRunId: 'e05-c-task-run',
    taskKey: 'pre-fund-reconciliation:import-mpt',
    moduleId: 'pre-fund',
    parentRunId: 'e05-c-parent-run',
    operationKey
  };
}

function valuesFor(fields, overrides) {
  return fields.map((field) => Object.hasOwn(overrides, field) ? overrides[field] : '');
}

function writeInboundFile(sequence) {
  const sourceBatch = `MPT_INBOUND_20260708_${sequence}`;
  const row = valuesFor(INBOUND_FIELDS, {
    batchNo: sourceBatch,
    billDate: '2026-07-08',
    channel: 'CITI',
    entity: 'PPEU',
    merchantId: 'M-E05-C',
    business: 'MPT',
    oppBu: 'SMB',
    tradeType: 'Inbound-VA',
    fileId: `FILE-${sequence}`,
    txId: `TX-${sequence}`,
    orderId: `ORDER-${sequence}`,
    reconId: `RECON-${sequence}`,
    billReconId: `BILL-${sequence}`,
    currency: 'USD',
    originAmount: '1.00',
    fee: '0',
    amount: '1.00',
    payerName: 'payer',
    payerAccount: 'account',
    valueDate: '2026-07-08',
    bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03',
    businessDate: '2026-07-08',
    tradeScope: 'INBOUND',
    realChannel: 'CITI-REAL',
    clearingNetwork: 'SWIFT',
    batchSeq: sequence
  });
  const filePath = path.join(tempRoot, `MPT_INBOUND_GATEWAY_20260708_${sequence}.txt`);
  fs.writeFileSync(
    filePath,
    `${[['20260708', sourceBatch, '1'], row].map((item) => item.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

function topologyRequest(actionKey, count) {
  return Object.freeze({ actionKey, input: Object.freeze({ fileCount: count }), unitCount: count });
}

test('host-safe topology与runtime预算同源收敛4/3/2/1，fileCount与repair边界冻结', () => {
  for (const [parallelism, totalMemoryBytes, expected] of [
    [8, 8 * GIBIBYTE, 4],
    [4, 8 * GIBIBYTE, 3],
    [3, 8 * GIBIBYTE, 2],
    [2, 8 * GIBIBYTE, 1],
    [8, 4 * GIBIBYTE, 2]
  ]) {
    const runtimeResourcePlan = createPreFundMptRuntimeResourcePlan({
      availableParallelism: parallelism,
      totalMemoryBytes
    });
    const planner = createPreFundMptTopologyPlanner({ runtimeResourcePlan });
    assert.equal(runtimeResourcePlan.hostSafeParserCount, expected);
    assert.equal(
      planner(topologyRequest(PRE_FUND_MPT_IMPORT_ACTION, 8)).effectiveChildCount,
      expected
    );
  }

  const runtimeResourcePlan = createPreFundMptRuntimeResourcePlan({
    availableParallelism: 8,
    totalMemoryBytes: 8 * GIBIBYTE
  });
  const planner = createPreFundMptTopologyPlanner({ runtimeResourcePlan });
  assert.deepEqual([1, 2, 4, 6, 8].map((count) =>
    planner(topologyRequest(PRE_FUND_MPT_IMPORT_ACTION, count)).effectiveChildCount), [1, 1, 2, 3, 4]);
  assert.equal(
    planner(topologyRequest(PRE_FUND_MPT_REPAIR_ACTION, 8)).effectiveChildCount,
    1
  );
  assert.throws(() => planner({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    input: { fileCount: 8 },
    unitCount: 7
  }), { code: 'PREFUND_TOPOLOGY_UNIT_COUNT_MISMATCH' });
  assert.equal(maximumChildrenWithinBudget({
    budgets: { cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 0 },
    base: { cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 0, memoryBytes: 1 },
    phase: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1 },
    childResource: { cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1 },
    maximum: 4
  }), 0);
});

test('topology registry freeze捕获带receiver的planner，后续method替换不改变native binding', () => {
  const policy = preFundMptPolicy(PRE_FUND_MPT_IMPORT_ACTION);
  const topology = {
    count: 4,
    plan() { return { effectiveChildCount: this.count }; }
  };
  const entryRegistry = createStaticRegistry({ [policy.entryKey]: '/packaged/prefund-writer.js' });
  const validatorRegistry = createStaticRegistry({ [policy.result.validatorKey]: () => true });
  const topologyRegistry = createStaticRegistry({
    [policy.resources.compound.topologyKey]: topology
  });
  entryRegistry.freeze();
  validatorRegistry.freeze();
  topologyRegistry.freeze();
  const registry = createExecutionPolicyRegistry({
    policies: [policy],
    entryRegistry,
    validatorRegistry,
    topologyRegistry,
    staticKeys: {
      resourceProfileKeys: [policy.resources.profile],
      inspectorKeys: [policy.commit.inspectorKey],
      conflictScopeResolverKeys: [policy.commit.conflictScopeResolverKey],
      plannerKeys: [policy.workUnits.plannerKey],
      reducerKeys: [policy.workUnits.reducerKey]
    }
  });
  registry.freeze();
  const binding = registry.getBinding(policy.actionKey, 'resources.compound.topologyKey');
  topology.plan = () => ({ effectiveChildCount: 1 });
  assert.equal(binding.plan({}).effectiveChildCount, 4);
  assert.equal(Object.isFrozen(binding), true);
});

function terminalAdapter(capture) {
  return {
    start(options) {
      capture.push(options.topology);
      return {
        ready: Promise.resolve(),
        send(command) {
          if (command.operation !== 'job:start') return;
          queueMicrotask(() => options.onMessage(createJobEnvelope({
            direction: 'event',
            operation: 'job:error',
            actionKey: command.actionKey,
            operationKey: command.operationKey,
            jobId: command.jobId,
            workerInstanceId: command.workerInstanceId,
            serviceGeneration: null,
            unitId: null,
            seq: 1,
            context: command.context,
            payload: { error: { code: 'TEST_DONE', message: 'test terminal', stage: 'execute', detailLines: [] } }
          })));
        },
        close() {},
        terminate() { return Promise.resolve(0); }
      };
    }
  };
}

function unusedDurableCoordinator() {
  return {
    async prepareAndAck() { throw new Error('topology probe不得启动unit'); },
    async observeReceipt() { throw new Error('topology probe不得接收receipt'); },
    async settleCommitted() { throw new Error('topology probe不得settle unit'); },
    async resolveUncertain() { return { outcome: 'not-committed' }; }
  };
}

function startTopologyProbe(runtime, actionKey, count, suffix) {
  return runtime.start({
    actionKey,
    operationKey: `e05-c-topology-${suffix}`,
    jobId: `e05-c-topology-job-${suffix}`,
    input: {
      userDataDir: tempRoot,
      fileCount: count,
      parentOperationKey: `e05-c-topology-${suffix}`,
      producerTaskRunId: 'e05-c-task-run'
    },
    context: { kind: 'file-batch', value: batchContext(`e05-c-topology-${suffix}`) },
    units: Array.from({ length: count }, (_, fileIndex) => ({
      unitId: `file:${String(fileIndex).padStart(6, '0')}`,
      input: { fileIndex }
    })),
    deferUnitStart: true
  });
}

test('native Supervisor在admission前使用冻结topology，ready后只读暴露Governor实际count', async () => {
  const captured = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    totalMemoryBytes: 8 * GIBIBYTE,
    workerThreadAdapter: terminalAdapter(captured),
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  try {
    const control = startTopologyProbe(runtime, PRE_FUND_MPT_IMPORT_ACTION, 8, 'native-four');
    await control.ready;
    assert.deepEqual(control.snapshot().topology, {
      topologyKey: 'topology.pre-fund:mpt-import',
      effectiveChildCount: 4
    });
    assert.equal(Object.isFrozen(control.snapshot().topology), true);
    assert.equal(captured[0].effectiveChildCount, 4);
    await control.promise;
  } finally {
    await runtime.shutdown();
  }
});

test('Governor竞争压力把requested4降为1，repair无论文件数都只获批1', async () => {
  const captured = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    totalMemoryBytes: 8 * GIBIBYTE,
    workerThreadAdapter: terminalAdapter(captured),
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  const blocker = await runtime.resourceGovernor.acquirePhaseLease({
    ownerKey: 'e05-c-memory-blocker',
    actionKey: 'test:e05-c-blocker',
    operationKey: 'e05-c-blocker-operation',
    resources: {
      cpuSlots: 0,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: GIBIBYTE
    }
  });
  try {
    const importControl = startTopologyProbe(runtime, PRE_FUND_MPT_IMPORT_ACTION, 8, 'downgrade');
    await importControl.ready;
    assert.deepEqual(importControl.snapshot().topology, {
      topologyKey: 'topology.pre-fund:mpt-import',
      effectiveChildCount: 1,
      downgraded: true,
      downgradeReason: 'resource-budget'
    });
    await importControl.promise;
    blocker.release('probe-complete');

    const repairControl = startTopologyProbe(runtime, PRE_FUND_MPT_REPAIR_ACTION, 8, 'repair-one');
    await repairControl.ready;
    assert.equal(repairControl.snapshot().topology.effectiveChildCount, 1);
    assert.equal(captured.at(-1).effectiveChildCount, 1);
    await repairControl.promise;
  } finally {
    blocker.release('probe-finally');
    await runtime.shutdown();
  }
});

test('file0 straggler下in-flight+ready permit原子有界，Writer仍严格递增单飞', async () => {
  const consumed = [];
  let writerActive = 0;
  let writerMaxActive = 0;
  let releaseFile0;
  const file0Gate = new Promise((resolve) => { releaseFile0 = resolve; });
  const coordinator = createOrderedMptCoordinator({
    fileCount: 5,
    readyHighWaterMark: 4,
    async consumeReady(spool, { fileIndex }) {
      writerActive += 1;
      writerMaxActive = Math.max(writerMaxActive, writerActive);
      consumed.push(fileIndex);
      if (fileIndex === 0) await file0Gate;
      writerActive -= 1;
      return { status: 'ok', fileIndex, id: spool.id };
    }
  });
  const permits = await Promise.all(Array.from({ length: 4 }, () => coordinator.acquireDispatchPermit()));
  permits[1].submitReady(1, { id: 1 });
  permits[2].submitReady(2, { id: 2 });
  permits[3].submitReady(3, { id: 3 });
  let fifthGranted = false;
  const fifth = coordinator.acquireDispatchPermit().then((permit) => {
    fifthGranted = true;
    return permit;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fifthGranted, false);
  assert.deepEqual(coordinator.snapshot(), {
    fileCount: 5,
    nextConsumeIndex: 0,
    acceptedCount: 3,
    bufferedReadyCount: 3,
    activePermitCount: 4,
    maxObservedPermitCount: 4,
    readyHighWaterMark: 4,
    consumerActive: false,
    settled: false
  });
  permits[0].submitReady(0, { id: 0 });
  const permit4 = await fifth;
  permit4.submitReady(4, { id: 4 });
  assert.equal(coordinator.snapshot().activePermitCount, 4);
  releaseFile0();
  const results = await coordinator.completion();
  assert.deepEqual(consumed, [0, 1, 2, 3, 4]);
  assert.equal(writerMaxActive, 1);
  assert.deepEqual(results.map((item) => item.fileIndex), [0, 1, 2, 3, 4]);
  assert.equal(coordinator.snapshot().activePermitCount, 0);
  assert.equal(coordinator.snapshot().maxObservedPermitCount, 4);
});

test('fatal/cancel原子拒绝permit与legacy observer，已提交和in-flight permit最终归零', async () => {
  const coordinator = createOrderedMptCoordinator({
    fileCount: 3,
    readyHighWaterMark: 2,
    consumeReady: async () => ({ status: 'ok' })
  });
  const permit0 = await coordinator.acquireDispatchPermit();
  const permit1 = await coordinator.acquireDispatchPermit();
  permit1.submitReady(1, { id: 1 });
  const pending = coordinator.acquireDispatchPermit();
  const observer = coordinator.waitForDispatchCapacity();
  coordinator.cancel();
  await assert.rejects(pending, { code: 'PREFUND_COORDINATOR_CANCELLED' });
  await assert.rejects(observer, { code: 'PREFUND_COORDINATOR_CANCELLED' });
  await assert.rejects(coordinator.completion(), { code: 'PREFUND_COORDINATOR_CANCELLED' });
  await assert.rejects(coordinator.acquireDispatchPermit(), { code: 'PREFUND_COORDINATOR_CANCELLED' });
  assert.equal(permit0.release(), true);
  assert.equal(permit0.release(), false);
  assert.equal(coordinator.snapshot().activePermitCount, 0);
});

test('spool估算覆盖source放大与余量，溢出/不足fail closed且错误不泄露路径', async () => {
  assert.equal(
    estimateMptSpoolBytes([100]),
    500 + FIXED_SAFETY_BYTES + PER_FILE_SAFETY_BYTES
  );
  assert.throws(() => estimateMptSpoolBytes([Number.MAX_SAFE_INTEGER]), {
    code: 'PREFUND_SPOOL_ESTIMATE_OVERFLOW'
  });
  assert.throws(() => assertMptSpoolDiskCapacity({
    taskStagingDir: path.join(tempRoot, 'customer-secret', 'staging'),
    sourceSizes: [1024],
    getAvailableDiskBytes: () => 1
  }), (error) => error.code === 'PREFUND_SPOOL_DISK_INSUFFICIENT' &&
    !/customer-secret|prefund-e05-c|private|tmp/i.test(error.message));
  assert.throws(() => assertMptSpoolDiskCapacity({
    taskStagingDir: path.join(tempRoot, 'customer-secret', 'staging'),
    sourceSizes: [1024],
    getAvailableDiskBytes() {
      throw Object.assign(new Error('/private/customer-secret/staging denied'), { code: 'EACCES' });
    }
  }), (error) => error.code === 'PREFUND_SPOOL_DISK_CHECK_FAILED' &&
    error.causeCode === 'EACCES' && !Object.hasOwn(error, 'cause') &&
    !/customer-secret|prefund-e05-c|private|tmp/i.test(error.message));

  const filePath = writeInboundFile('900');
  const calls = [];
  await assert.rejects(() => executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime: { start() { calls.push('runtime.start'); throw new Error('不得启动Writer'); } },
    service: { beginManagedMptImport() { calls.push('begin'); } },
    filePaths: [filePath],
    userDataDir: tempRoot,
    taskStagingDir: path.join(tempRoot, 'disk-insufficient'),
    getAvailableDiskBytes: () => 0,
    batchContext: batchContext('e05-c-disk-insufficient')
  }), { code: 'PREFUND_SPOOL_DISK_INSUFFICIENT' });
  assert.deepEqual(calls, ['begin']);

  await assert.rejects(() => executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime: { start() { calls.push('missing-runtime.start'); throw new Error('不得启动Writer'); } },
    service: { beginManagedMptImport() { calls.push('missing-begin'); } },
    filePaths: [path.join(tempRoot, 'missing-customer-secret.txt')],
    userDataDir: tempRoot,
    taskStagingDir: path.join(tempRoot, 'missing'),
    batchContext: batchContext('e05-c-source-missing')
  }), { code: 'ENOENT' });
  assert.deepEqual(calls, ['begin', 'missing-begin']);
});

test('Parser Pool可乱序完成但fake Writer严格fileIndex单飞，parent结果仍等长同序', async () => {
  const filePaths = Array.from({ length: 8 }, (_, index) => writeInboundFile(String(1000 + index)));
  let parserActive = 0;
  let parserMaxActive = 0;
  const parserCompletionOrder = [];
  class SpoolingParserWorker extends EventEmitter {
    constructor(_entry, workerOptions) {
      super();
      this.exited = false;
      const input = workerOptions.workerData.input;
      parserActive += 1;
      parserMaxActive = Math.max(parserMaxActive, parserActive);
      const delay = input.fileIndex === 0 ? 50 : (input.fileIndex % 3) * 3;
      setTimeout(async () => {
        try {
          await writeMptFileSpool(input);
          parserCompletionOrder.push(input.fileIndex);
          const identity = deriveFileIdentity(input.parentOperationKey, input.fileIndex);
          this.emit('message', { ok: true, result: { fileIndex: input.fileIndex, ...identity } });
          parserActive -= 1;
          this.exited = true;
          this.emit('exit', 0);
        } catch (error) {
          parserActive -= 1;
          this.exited = true;
          this.emit('error', error);
          this.emit('exit', 1);
        }
      }, delay);
    }
    postMessage() {}
    terminate() { return Promise.resolve(0); }
  }

  const writerOrder = [];
  let writerActive = 0;
  let writerMaxActive = 0;
  const writerResults = new Array(filePaths.length);
  let resolveParent;
  const parentPromise = new Promise((resolve) => { resolveParent = resolve; });
  const runtime = {
    start() {
      return {
        ready: Promise.resolve(),
        promise: parentPromise,
        snapshot() {
          return { topology: { topologyKey: 'topology.pre-fund:mpt-import', effectiveChildCount: 4 } };
        },
        startUnit(unitId) {
          const fileIndex = Number(unitId.slice('file:'.length));
          let resolveAccepted;
          const dispatchAccepted = new Promise((resolve) => { resolveAccepted = resolve; });
          const terminal = (async () => {
            writerActive += 1;
            writerMaxActive = Math.max(writerMaxActive, writerActive);
            writerOrder.push(fileIndex);
            resolveAccepted(true);
            await new Promise((resolve) => setImmediate(resolve));
            writerActive -= 1;
            const result = {
              status: 'ok',
              fileName: path.basename(filePaths[fileIndex]),
              importStatus: 'imported',
              sourceType: 'MPT_INBOUND_GATEWAY',
              rowCount: 1,
              excludedRowCount: 0
            };
            writerResults[fileIndex] = result;
            if (writerResults.filter(Boolean).length === writerResults.length) {
              resolveParent({ outcome: 'completed', result: { results: writerResults.slice() } });
            }
            return { status: 'completed', result };
          })();
          Object.defineProperty(terminal, 'dispatchAccepted', { value: dispatchAccepted });
          return terminal;
        }
      };
    }
  };

  const result = await executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime,
    ParserWorkerClass: SpoolingParserWorker,
    service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
    filePaths,
    userDataDir: tempRoot,
    taskStagingDir: path.join(tempRoot, 'pool-staging'),
    getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    batchContext: batchContext('e05-c-pool-order')
  });
  assert.equal(parserMaxActive, 4);
  assert.notEqual(parserCompletionOrder[0], 0);
  assert.deepEqual(writerOrder, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(writerMaxActive, 1);
  assert.deepEqual(result.results.map((item) => item.fileName), filePaths.map((item) => path.basename(item)));
});

test('parent终止会取消全部active Parser并等待clean exit barrier，Main cleanup每file exactly once', async () => {
  const filePaths = Array.from({ length: 8 }, (_, index) => writeInboundFile(String(1100 + index)));
  let parserActive = 0;
  let parserMaxActive = 0;
  let cancelCount = 0;
  class HangingParserWorker extends EventEmitter {
    constructor() {
      super();
      this.exited = false;
      parserActive += 1;
      parserMaxActive = Math.max(parserMaxActive, parserActive);
    }
    postMessage(message) {
      if (!message || message.operation !== 'cancel' || this.exited) return;
      cancelCount += 1;
      setImmediate(() => {
        if (this.exited) return;
        this.exited = true;
        parserActive -= 1;
        this.emit('exit', 0);
      });
    }
    terminate() {
      if (!this.exited) {
        this.exited = true;
        parserActive -= 1;
        this.emit('exit', 1);
      }
      return Promise.resolve(1);
    }
  }
  let resolveParent;
  const parentPromise = new Promise((resolve) => { resolveParent = resolve; });
  const runtime = {
    start() {
      return {
        ready: Promise.resolve(),
        promise: parentPromise,
        snapshot: () => ({
          topology: { topologyKey: 'topology.pre-fund:mpt-import', effectiveChildCount: 4 }
        }),
        startUnit() { throw new Error('parent终止前不得启动Writer unit'); }
      };
    }
  };
  const cleanupCounts = new Map();
  await assert.rejects(() => executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime,
    ParserWorkerClass: HangingParserWorker,
    service: { beginManagedMptImport() {} },
    filePaths,
    userDataDir: tempRoot,
    taskStagingDir: path.join(tempRoot, 'cancel-staging'),
    getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    cleanupMainOwnedFile(spool) {
      cleanupCounts.set(spool.fileIndex, (cleanupCounts.get(spool.fileIndex) || 0) + 1);
    },
    onProgress({ current }) {
      if (current === 4) {
        queueMicrotask(() => resolveParent({ outcome: 'cancelled', result: null }));
      }
    },
    batchContext: batchContext('e05-c-parent-cancel')
  }), { code: 'PREFUND_WRITER_PARENT_INTERRUPTED' });
  assert.equal(parserMaxActive, 4);
  assert.equal(cancelCount, 4);
  assert.equal(parserActive, 0);
  assert.deepEqual(Object.fromEntries(cleanupCounts), {
    0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1
  });
});

test('真实Supervisor在file0 dispatchAccepted后pre-critical中断，混合ownership与Pool clean barrier准确收口', async () => {
  const filePaths = Array.from({ length: 8 }, (_, index) => writeInboundFile(String(1200 + index)));
  let parserActive = 0;
  let parserMaxActive = 0;
  let parserCancelCount = 0;
  let hangingParserActive = 0;
  let writerExitCount = 0;
  let writerCallbacks = null;
  let writerUnitStarted = false;
  let writerExitScheduled = false;
  let parserActiveAtWriterDispatch = null;
  let writerDispatchedFileIndex = null;
  let writerSawReadyManifest = false;
  const writerUnitStarts = [];
  function scheduleWriterExitAtMixedOwnershipBoundary() {
    if (!writerCallbacks || !writerUnitStarted || hangingParserActive < 4 || writerExitScheduled) return;
    writerExitScheduled = true;
    setImmediate(() => {
      writerExitCount += 1;
      writerCallbacks.onExit(9, null);
    });
  }
  class MixedOwnershipParserWorker extends EventEmitter {
    constructor(_entry, workerOptions) {
      super();
      this.exited = false;
      this.input = workerOptions.workerData.input;
      parserActive += 1;
      parserMaxActive = Math.max(parserMaxActive, parserActive);
      if (this.input.fileIndex === 0) {
        setImmediate(async () => {
          try {
            await writeMptFileSpool(this.input);
            const identity = deriveFileIdentity(this.input.parentOperationKey, this.input.fileIndex);
            this.emit('message', { ok: true, result: { fileIndex: 0, ...identity } });
            this.exited = true;
            parserActive -= 1;
            this.emit('exit', 0);
          } catch (error) {
            this.emit('error', error);
            this.exited = true;
            parserActive -= 1;
            this.emit('exit', 1);
          }
        });
      } else {
        hangingParserActive += 1;
        scheduleWriterExitAtMixedOwnershipBoundary();
      }
    }
    postMessage(message) {
      if (!message || message.operation !== 'cancel' || this.exited) return;
      parserCancelCount += 1;
      setImmediate(() => {
        if (this.exited) return;
        this.exited = true;
        parserActive -= 1;
        hangingParserActive -= 1;
        this.emit('exit', 0);
      });
    }
    terminate() { return Promise.resolve(0); }
  }
  const writerAdapter = {
    start(callbacks) {
      writerCallbacks = callbacks;
      return {
        ready: Promise.resolve(),
        send(command) {
          if (command.operation !== 'unit:start') return;
          writerUnitStarts.push(command.unitId);
          writerDispatchedFileIndex = command.payload.input.fileIndex;
          writerSawReadyManifest = fs.existsSync(
            mptSpoolPaths(command.payload.input.spool).manifestReady
          );
          parserActiveAtWriterDispatch = parserActive;
          writerUnitStarted = true;
          scheduleWriterExitAtMixedOwnershipBoundary();
        },
        close() {},
        terminate() { return Promise.resolve(9); }
      };
    }
  };
  let prepareCount = 0;
  let inspectCount = 0;
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    totalMemoryBytes: 8 * GIBIBYTE,
    workerThreadAdapter: writerAdapter,
    workerDurableCoordinator: {
      async prepareAndAck() { prepareCount += 1; throw new Error('pre-critical不得创建Intent'); },
      async observeReceipt() { throw new Error('pre-critical不得观察receipt'); },
      async settleCommitted() { throw new Error('pre-critical不得settle'); },
      async resolveUncertain() { inspectCount += 1; return { outcome: 'unknown' }; }
    }
  });
  const cleanupCounts = new Map();
  const cleanupObservations = [];
  try {
    await assert.rejects(() => executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_IMPORT_ACTION,
      runtime,
      ParserWorkerClass: MixedOwnershipParserWorker,
      service: { beginManagedMptImport() {} },
      filePaths,
      userDataDir: tempRoot,
      taskStagingDir: path.join(tempRoot, 'writer-interruption-staging'),
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      cleanupMainOwnedFile(spool) {
        cleanupCounts.set(spool.fileIndex, (cleanupCounts.get(spool.fileIndex) || 0) + 1);
        cleanupObservations.push({ fileIndex: spool.fileIndex, parserActive });
      },
      batchContext: batchContext('e05-c-writer-interruption')
    }), { code: 'PREFUND_WRITER_PARENT_INTERRUPTED' });
    assert.equal(writerExitCount, 1);
    assert.deepEqual(writerUnitStarts, ['file:000000']);
    assert.equal(writerDispatchedFileIndex, 0);
    assert.equal(writerSawReadyManifest, true);
    assert.ok(parserActiveAtWriterDispatch >= 3, 'file0 dispatch时其余Parser必须仍active');
    assert.equal(prepareCount, 0, 'pre-critical exit不得创建Intent或转移到unknown ownership');
    assert.equal(inspectCount, 0, 'pre-critical exit不得进入Inspector/Hold路径');
    assert.equal(parserMaxActive, 4);
    assert.equal(parserCancelCount, 4);
    assert.equal(parserActive, 0);
    assert.deepEqual(Object.fromEntries(cleanupCounts), {
      0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1
    });
    assert.equal(
      cleanupObservations.filter(({ fileIndex }) => fileIndex !== 0)
        .every(({ parserActive: active }) => active === 0),
      true,
      '未dispatch文件只能在全部active Parser clean exit barrier后由Main清理'
    );
  } finally {
    await runtime.shutdown();
  }
});
