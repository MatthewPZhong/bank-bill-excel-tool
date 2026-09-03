'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../../src/main-process/background-execution/execution-policy-registry');
const { createJobEnvelope } = require('../../../../src/main-process/background-execution/protocol');
const {
  createBackgroundExecutionRuntime,
  createNonProductionBackgroundExecutionRuntime
} = require('../../../../src/main-process/background-execution/runtime');
const {
  createPlatformResourceBudgets
} = require('../../../../src/main-process/background-execution/resource-budget');
const {
  createResourceGovernor
} = require('../../../../src/main-process/background-execution/resource-governor');
const backgroundExecutionPackage = require('../../../../src/main-process/background-execution');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  executeManagedPreFundMptImport: executeManagedPreFundMptImportRaw
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
  estimateMptFileSpoolBytes,
  estimateMptSpoolBytes
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-admission');
const {
  deriveFileIdentity,
  mptSpoolPaths
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-contract');
const {
  IMPORT_WRITER_RESOURCES,
  PARSER_RESOURCES,
  createPreFundMptTopologyPlanner
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/topology');
const {
  writeMptFileSpool: writeMptFileSpoolRaw
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-import/spool-writer');
const {
  createSupportedDirectoryFsyncWorkerClass,
  supportedDirectoryFsync,
  withSupportedDirectoryFsync
} = require('../../shared/directory-fsync-test-runtime');

const SupportedDirectoryFsyncWorker = createSupportedDirectoryFsyncWorkerClass(Worker);

function writeMptFileSpool(input, options = {}) {
  return writeMptFileSpoolRaw(input, withSupportedDirectoryFsync(options));
}

function executeManagedPreFundMptImport(options) {
  return executeManagedPreFundMptImportRaw({
    ParserWorkerClass: SupportedDirectoryFsyncWorker,
    parserOutcomeFsyncDirectory: supportedDirectoryFsync,
    ...options
  });
}

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

function createIsolatedPoolGovernor() {
  return createResourceGovernor({
    budgets: {
      cpuSlots: 5,
      workerThreadSlots: 6,
      utilityProcessSlots: 1,
      ioHeavySlots: 5,
      memoryBytes: 2 * GIBIBYTE
    }
  });
}

function assertGovernorIdle(resourceGovernor) {
  const snapshot = resourceGovernor.snapshot();
  assert.deepEqual(snapshot.activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
  assert.equal(snapshot.activeLeaseCount, 0);
  assert.equal(snapshot.queued.size, 0);
}

test('E00 platform factory冻结canonical CPU/worker/utility/IO与freemem-reserve内存预算', () => {
  for (const [parallelism, expectedCpu] of [[8, 4], [5, 3], [4, 2], [3, 1], [1, 1]]) {
    const budgets = createPlatformResourceBudgets({
      availableParallelism: parallelism,
      freeMemoryBytes: 8 * GIBIBYTE,
      memoryHardCeilingBytes: 4 * GIBIBYTE,
      systemReserveBytes: GIBIBYTE
    });
    assert.deepEqual(budgets, {
      cpuSlots: expectedCpu,
      workerThreadSlots: expectedCpu + 1,
      utilityProcessSlots: 1,
      ioHeavySlots: 2,
      memoryBytes: 4 * GIBIBYTE
    });
    assert.equal(Object.isFrozen(budgets), true);
  }
  assert.equal(createPlatformResourceBudgets({
    availableParallelism: 8,
    freeMemoryBytes: 3 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE
  }).memoryBytes, 2 * GIBIBYTE);
  assert.equal(createPlatformResourceBudgets({
    availableParallelism: 8,
    freeMemoryBytes: GIBIBYTE / 2,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE
  }).memoryBytes, 0);
  assert.equal(createPlatformResourceBudgets({
    availableParallelism: 8,
    totalMemoryBytes: 8 * GIBIBYTE,
    freeMemoryBytes: 8 * GIBIBYTE
  }).memoryBytes, 2 * GIBIBYTE, '默认hard ceiling沿用E05-B totalmem/4且reserve沿用2GiB gate');
  assert.equal(IMPORT_WRITER_RESOURCES.ioHeavySlots, 1);
  assert.equal(PARSER_RESOURCES.ioHeavySlots, 1);
  assert.throws(() => createBackgroundExecutionRuntime({ resourceGovernor: {} }), {
    name: 'TypeError'
  });
  assert.equal(Object.hasOwn(
    backgroundExecutionPackage,
    'createNonProductionBackgroundExecutionRuntime'
  ), false);
  assert.doesNotMatch(
    fs.readFileSync(path.resolve(__dirname, '../../../../src/main.js'), 'utf8'),
    /createNonProductionBackgroundExecutionRuntime/
  );
});

test('PreFund requested topology独立收敛4/3/2/1，fileCount/unitCount与repair边界冻结', () => {
  for (const [parallelism, expected] of [[8, 4], [4, 3], [3, 2], [2, 1], [1, 1]]) {
    const planner = createPreFundMptTopologyPlanner({ availableParallelism: parallelism });
    assert.equal(
      planner(topologyRequest(PRE_FUND_MPT_IMPORT_ACTION, 8)).effectiveChildCount,
      expected
    );
  }

  const planner = createPreFundMptTopologyPlanner({ availableParallelism: 8 });
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

function startTopologyProbe(runtime, actionKey, count, suffix, production = false) {
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
    deferUnitStart: true,
    production
  });
}

test('native Supervisor使用E00 canonical预算，requested4诚实降级为实际1并在ready后只读暴露', async () => {
  const captured = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE,
    workerThreadAdapter: terminalAdapter(captured),
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  try {
    assert.deepEqual(runtime.resourceGovernor.snapshot().budgets, {
      cpuSlots: 4,
      workerThreadSlots: 5,
      utilityProcessSlots: 1,
      ioHeavySlots: 2,
      memoryBytes: 4 * GIBIBYTE
    });
    const control = startTopologyProbe(runtime, PRE_FUND_MPT_IMPORT_ACTION, 8, 'native-single');
    await control.ready;
    assert.deepEqual(control.snapshot().topology, {
      topologyKey: 'topology.pre-fund:mpt-import',
      effectiveChildCount: 1,
      downgraded: true,
      downgradeReason: 'resource-budget'
    });
    assert.equal(control.snapshot().state, 'running');
    assert.equal(Object.isFrozen(control.snapshot().topology), true);
    assert.equal(captured[0].effectiveChildCount, 1);
    await control.promise;
  } finally {
    await runtime.shutdown();
  }
});

test('隔离Governor竞争压力把requested4降为1，repair无论文件数都只获批1', async () => {
  const captured = [];
  const resourceGovernor = createIsolatedPoolGovernor();
  const runtime = createNonProductionBackgroundExecutionRuntime({
    availableParallelism: 8,
    resourceGovernor,
    workerThreadAdapter: terminalAdapter(captured),
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  assert.throws(
    () => startTopologyProbe(runtime, PRE_FUND_MPT_IMPORT_ACTION, 8, 'production-forbidden', true),
    { code: 'BACKGROUND_EXECUTION_RESOURCE_GOVERNOR_OVERRIDE_FORBIDDEN' }
  );
  assertGovernorIdle(resourceGovernor);
  const blocker = await runtime.resourceGovernor.acquirePhaseLease({
    ownerKey: 'e05-c-cpu-blocker',
    actionKey: 'test:e05-c-blocker',
    operationKey: 'e05-c-blocker-operation',
    resources: {
      cpuSlots: 1,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 0
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
  assert.equal(estimateMptFileSpoolBytes(100), 500 + PER_FILE_SAFETY_BYTES);
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

  const programmingErrorCalls = [];
  await assert.rejects(() => executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime: {
      start() {
        programmingErrorCalls.push('runtime.start');
        throw new Error('参数错误不得启动Writer');
      }
    },
    service: {
      beginManagedMptImport() { programmingErrorCalls.push('begin'); }
    },
    filePaths: [{}],
    userDataDir: tempRoot,
    taskStagingDir: path.join(tempRoot, 'programming-error'),
    getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    batchContext: batchContext('e05-c-programming-error')
  }), (error) => error && error.code === 'ERR_INVALID_ARG_TYPE');
  assert.deepEqual(programmingErrorCalls, ['begin']);
});

test('valid+missing+valid逐file fail-closed，结果等长同序且缺失file无critical/receipt', async () => {
  const firstPath = writeInboundFile('901');
  const missingPath = path.join(tempRoot, 'MPT_INBOUND_GATEWAY_20260708_902.txt');
  const thirdPath = writeInboundFile('903');
  const stagingDir = path.join(tempRoot, 'missing-source-staging');
  const criticalUnits = [];
  const receiptUnits = [];
  const settledUnits = [];
  const parserStarted = [];
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE,
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        criticalUnits.push(input.unitId);
        return {
          intentId: `missing-source-intent-${input.unitId}`,
          fileOperationKey: input.critical.fileOperationKey
        };
      },
      async observeReceipt(input) {
        receiptUnits.push(input.unitId);
        return {
          receiptHint: {
            receiptKind: 'module-local',
            receiptIdentity: String(input.receipt.id)
          }
        };
      },
      async settleCommitted(input) { settledUnits.push(input.unitId); },
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_IMPORT_ACTION,
      runtime,
      service: {
        beginManagedMptImport() {},
        adoptManagedMptImportResults: (_paths, items) => items
      },
      filePaths: [firstPath, missingPath, thirdPath],
      userDataDir: path.join(tempRoot, 'missing-source-user-data'),
      taskStagingDir: stagingDir,
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      onParserWorkerState(event) {
        if (event.state === 'started') parserStarted.push(event.fileIndex);
      },
      batchContext: batchContext('e05-c-source-missing-mixed')
    });
    assert.deepEqual(result.results.map((item) => item.status), ['ok', 'failed', 'ok']);
    assert.deepEqual(
      result.results.map((item) => item.fileName),
      [firstPath, missingPath, thirdPath].map((item) => path.basename(item))
    );
    assert.equal(result.successCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.results[1].code, 'PREFUND_SPOOL_SOURCE_CHANGED');
    assert.deepEqual(criticalUnits, ['file:000000', 'file:000002']);
    assert.deepEqual(receiptUnits, criticalUnits);
    assert.deepEqual(settledUnits, criticalUnits);
    assert.deepEqual(parserStarted.sort((left, right) => left - right), [0, 2]);
    assert.equal(fs.existsSync(path.join(stagingDir, 'mpt')), false);
    const failureEvidence = JSON.stringify(result.results[1]);
    assert.equal(failureEvidence.includes(tempRoot), false);
    assert.equal(failureEvidence.includes('customer-secret'), false);
  } finally {
    await runtime.shutdown();
  }
});

test('repair源文件缺失逐file失败并交还adopter，缺失file无critical/receipt或Parser启动', async () => {
  const missingPath = path.join(tempRoot, 'MPT_INBOUND_GATEWAY_20260708_904.txt');
  const repairFailure = Object.freeze({
    failureId: '11111111-1111-4111-8111-111111111111',
    filePath: missingPath,
    sourceType: 'MPT_INBOUND_GATEWAY',
    sourceBatch: 'MPT_INBOUND_20260708_904',
    contentHash: 'a'.repeat(64),
    rowErrorCount: 1
  });
  const criticalUnits = [];
  const receiptUnits = [];
  const parserStarted = [];
  let adopterInput = null;
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE,
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        criticalUnits.push(input.unitId);
        return {
          intentId: `missing-repair-intent-${input.unitId}`,
          fileOperationKey: input.critical.fileOperationKey
        };
      },
      async observeReceipt(input) {
        receiptUnits.push(input.unitId);
        return {
          receiptHint: {
            receiptKind: 'module-local',
            receiptIdentity: String(input.receipt.id)
          }
        };
      },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_REPAIR_ACTION,
      runtime,
      service: {
        adoptManagedMptRepairResults(failures, items) {
          adopterInput = { failures, items };
          return items;
        }
      },
      filePaths: [missingPath],
      repairFailures: [repairFailure],
      userDataDir: path.join(tempRoot, 'missing-repair-user-data'),
      taskStagingDir: path.join(tempRoot, 'missing-repair-staging'),
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      onParserWorkerState(event) {
        if (event.state === 'started') parserStarted.push(event.fileIndex);
      },
      batchContext: batchContext('e05-c-repair-source-missing')
    });
    assert.deepEqual(result.results.map((item) => item.status), ['failed']);
    assert.equal(result.results[0].code, 'PREFUND_SPOOL_SOURCE_CHANGED');
    assert.deepEqual(adopterInput.failures, [repairFailure]);
    assert.deepEqual(adopterInput.items, result.results);
    assert.deepEqual(criticalUnits, []);
    assert.deepEqual(receiptUnits, []);
    assert.deepEqual(parserStarted, []);
    assert.equal(JSON.stringify(result.results[0]).includes(tempRoot), false);
  } finally {
    await runtime.shutdown();
  }
});

test('valid+symlink+valid中null source snapshot磁盘贡献0，Parser逐file fail-closed且结果等长同序脱敏', async (t) => {
  const firstPath = writeInboundFile('910');
  const thirdPath = writeInboundFile('914');
  const privateTarget = path.join(tempRoot, 'customer-secret-symlink-target.txt');
  fs.copyFileSync(firstPath, privateTarget);
  const symlinkPath = path.join(tempRoot, 'MPT_INBOUND_GATEWAY_20260708_912.txt');
  try {
    fs.symlinkSync(privateTarget, symlinkPath, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error && error.code)) {
      t.skip('Windows测试环境未授予创建文件symlink权限');
      return;
    }
    throw error;
  }
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE,
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        return { intentId: `symlink-intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  try {
    const result = await executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_IMPORT_ACTION,
      runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths: [firstPath, symlinkPath, thirdPath],
      userDataDir: path.join(tempRoot, 'symlink-user-data'),
      taskStagingDir: path.join(tempRoot, 'symlink-staging'),
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      batchContext: batchContext('e05-c-symlink-input')
    });
    assert.deepEqual(result.results.map((item) => item.status), ['ok', 'failed', 'ok']);
    assert.deepEqual(
      result.results.map((item) => item.fileName),
      [firstPath, symlinkPath, thirdPath].map((item) => path.basename(item))
    );
    assert.equal(result.successCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.results[1].code, 'PREFUND_SPOOL_CONTRACT_INVALID');
    const failureEvidence = JSON.stringify(result.results[1]);
    assert.equal(failureEvidence.includes(tempRoot), false);
    assert.equal(failureEvidence.includes(privateTarget), false);
    assert.equal(failureEvidence.includes('customer-secret'), false);
  } finally {
    await runtime.shutdown();
  }
});

test('admission cancel先完成parent terminal/release barrier，Parser构造与spool均为0', async () => {
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 0,
      workerThreadSlots: 0,
      utilityProcessSlots: 0,
      ioHeavySlots: 0,
      memoryBytes: 0
    }
  });
  let writerStartCount = 0;
  let parserConstructorCount = 0;
  class ForbiddenParserWorker {
    constructor() { parserConstructorCount += 1; }
  }
  const nativeRuntime = createNonProductionBackgroundExecutionRuntime({
    availableParallelism: 8,
    resourceGovernor,
    workerThreadAdapter: {
      start() {
        writerStartCount += 1;
        throw new Error('admission cancel不得spawn Writer');
      }
    },
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  const runtime = {
    start(request) {
      const control = nativeRuntime.start({ ...request, initTimeoutMs: 1000 });
      queueMicrotask(() => control.cancel({ reason: 'test-admission-cancel' }));
      return control;
    }
  };
  const filePaths = Array.from({ length: 4 }, (_, index) => writeInboundFile(String(920 + index)));
  const staging = path.join(tempRoot, 'cancel-before-running-staging');
  try {
    await assert.rejects(() => executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_IMPORT_ACTION,
      runtime,
      ParserWorkerClass: ForbiddenParserWorker,
      service: { beginManagedMptImport() {} },
      filePaths,
      userDataDir: tempRoot,
      taskStagingDir: staging,
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      batchContext: batchContext('e05-c-admission-cancel')
    }), { code: 'PREFUND_WRITER_START_FAILED' });
    assert.equal(writerStartCount, 0);
    assert.equal(parserConstructorCount, 0);
    assert.equal(fs.existsSync(staging), false);
    assertGovernorIdle(resourceGovernor);
  } finally {
    await nativeRuntime.shutdown();
  }
});

test('Writer spawn失败先完成authoritative terminal/release barrier，Parser构造与spool均为0', async () => {
  let writerStartCount = 0;
  let parserConstructorCount = 0;
  class ForbiddenParserWorker {
    constructor() { parserConstructorCount += 1; }
  }
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * GIBIBYTE,
    memoryHardCeilingBytes: 4 * GIBIBYTE,
    systemReserveBytes: GIBIBYTE,
    workerThreadAdapter: {
      start() {
        writerStartCount += 1;
        throw new Error('/private/customer-secret Writer spawn failed');
      }
    },
    workerDurableCoordinator: unusedDurableCoordinator()
  });
  const filePaths = Array.from({ length: 4 }, (_, index) => writeInboundFile(String(930 + index)));
  const staging = path.join(tempRoot, 'spawn-failure-staging');
  try {
    await assert.rejects(() => executeManagedPreFundMptImport({
      actionKey: PRE_FUND_MPT_IMPORT_ACTION,
      runtime,
      ParserWorkerClass: ForbiddenParserWorker,
      service: { beginManagedMptImport() {} },
      filePaths,
      userDataDir: tempRoot,
      taskStagingDir: staging,
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      batchContext: batchContext('e05-c-writer-spawn-failure')
    }), (error) => error.code === 'PREFUND_WRITER_START_FAILED' &&
      !/private|customer-secret/i.test(error.message));
    assert.equal(writerStartCount, 1);
    assert.equal(parserConstructorCount, 0);
    assert.equal(fs.existsSync(staging), false);
    assertGovernorIdle(runtime.resourceGovernor);
  } finally {
    await runtime.shutdown();
  }
});

test('running但非法topology先cancel并等待parent terminal，Parser构造与spool均为0', async () => {
  const filePath = writeInboundFile('940');
  const staging = path.join(tempRoot, 'invalid-topology-staging');
  let parserConstructorCount = 0;
  let cancelCount = 0;
  let cancelPayload = null;
  let cancelSawParentTerminal = null;
  let parentTerminal = false;
  let importSettled = false;
  let resolveCancelObserved;
  let resolveParent;
  const cancelObserved = new Promise((resolve) => { resolveCancelObserved = resolve; });
  const parentPromise = new Promise((resolve) => {
    resolveParent = (execution) => {
      parentTerminal = true;
      resolve(execution);
    };
  });
  class ForbiddenParserWorker {
    constructor() { parserConstructorCount += 1; }
  }
  const runtime = {
    start() {
      return {
        ready: Promise.resolve(),
        promise: parentPromise,
        snapshot() {
          return {
            state: 'running',
            topology: {
              topologyKey: 'topology.pre-fund:mpt-import',
              effectiveChildCount: 0
            }
          };
        },
        cancel(payload) {
          cancelCount += 1;
          cancelPayload = payload;
          cancelSawParentTerminal = parentTerminal;
          resolveCancelObserved();
          return true;
        },
        startUnit() { throw new Error('非法topology不得dispatch unit'); }
      };
    }
  };
  const importAttempt = executeManagedPreFundMptImport({
    actionKey: PRE_FUND_MPT_IMPORT_ACTION,
    runtime,
    ParserWorkerClass: ForbiddenParserWorker,
    service: { beginManagedMptImport() {} },
    filePaths: [filePath],
    userDataDir: tempRoot,
    taskStagingDir: staging,
    getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
    batchContext: batchContext('e05-c-invalid-admitted-topology')
  });
  importAttempt.then(
    () => { importSettled = true; },
    () => { importSettled = true; }
  );

  await cancelObserved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCount, 1);
  assert.deepEqual(cancelPayload, { reason: 'invalid-admitted-topology' });
  assert.equal(cancelSawParentTerminal, false);
  assert.equal(parentTerminal, false);
  assert.equal(importSettled, false, 'managed失败必须等待parent terminal barrier');
  assert.equal(parserConstructorCount, 0);
  assert.equal(fs.existsSync(staging), false);

  const rejection = assert.rejects(importAttempt, {
    code: 'PREFUND_ADMITTED_TOPOLOGY_INVALID',
    message: 'Supervisor未提供合法的已获批Parser topology'
  });
  resolveParent({ outcome: 'cancelled', result: null });
  await rejection;
  assert.equal(parentTerminal, true);
  assert.equal(importSettled, true);
  assert.equal(parserConstructorCount, 0);
  assert.equal(fs.existsSync(staging), false);
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
          return {
            state: 'running',
            topology: { topologyKey: 'topology.pre-fund:mpt-import', effectiveChildCount: 4 }
          };
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
          state: 'running',
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
  const runtime = createNonProductionBackgroundExecutionRuntime({
    availableParallelism: 8,
    resourceGovernor: createIsolatedPoolGovernor(),
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
