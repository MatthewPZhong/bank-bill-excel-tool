'use strict';

const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ipcTaskContract = require('../../src/main-process/archive-center/ipc-task-contract');
const { createTaskPolicyRegistry } = require('../../src/main-process/archive-center/task-policy-registry');

const { createPreparedResourceScope } = require('../../src/main-process/task-adapters/prepared-resources');
const { createTaskAdapterRegistry } = require('../../src/main-process/task-adapters/registry');
const { createPassthroughTaskAdapter } = require('../../src/main-process/task-adapters/passthrough');
const { createPositionTaskAdapter } = require('../../src/main-process/position-reconciliation/task-adapter');
const { createToolboxTaskAdapter } = require('../../src/main-process/toolbox-background/task-adapter');
const { createVccOutputTaskAdapter } = require('../../src/main-process/vcc-financial-op-output/task-adapter');

const MAIN_PATH = path.resolve(__dirname, '../../src/main.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
const entryStart = mainSource.indexOf('function trackArchiveOperationPromise(');
const entryEnd = mainSource.indexOf('\nfunction runRegisteredBusinessOperation(', entryStart);
assert.ok(entryStart >= 0 && entryEnd > entryStart, 'Main 公共入口提取边界必须存在');
const entrySource = mainSource.slice(entryStart, entryEnd);

// 执行 Main 原函数和真实 prepared/helper 合同；外部 lifecycle、Hold gate、Archive、
// 领域存储及文件读取都是可注入协作者。本夹具不启动 Electron，也不证明 BOR/DB/GUI 集成。
function createArchiveAwareOperationHarness(options = {}) {
  const calls = [];
  const lifecycleOptions = [];
  const counts = { gate: 0, initialize: 0, lifecycle: 0, business: 0, admission: 0 };
  const channel = options.channel || 'template:rename';
  const registry = createTaskPolicyRegistry();
  const policy = options.policy || registry.require(channel);
  const ownerContext = options.ownerContext || {
    taskRunId: 'task-fixture',
    taskKey: channel,
    moduleId: policy.scopeId,
    parentRunId: 'parent-fixture',
    operationKey: 'operation-fixture',
    ...(policy.batchPolicy === 'reserve' ? { batchId: 17, batchNumber: 'batch-fixture' } : {})
  };
  const controls = options.controls || {
    fileEvidence: { filePlan: { inputs: [], outputs: [] } },
    async settleArtifacts() { calls.push('settle'); return { durable: true }; }
  };
  const runLifecycle = (method, input) => {
    calls.push(method);
    counts.lifecycle += 1;
    lifecycleOptions.push({ method, input });
    if (options.runLifecycle) return options.runLifecycle(input, { method, ownerContext, controls, calls });
    return (async () => {
      await input.beforeStart(ownerContext, controls.fileEvidence);
      const result = await input.execute(ownerContext, controls);
      if (input.afterTerminal) await input.afterTerminal({ result, context: ownerContext });
      return result;
    })();
  };
  const lifecycle = Object.fromEntries([
    'runOperationOnly', 'runFileTask', 'runDeferredFileTask', 'run'
  ].map((method) => [method, (input) => runLifecycle(method, input)]));
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const cleanupDiagnostics = [];
  const domainBinding = (name, fallback) => options.bindings && options.bindings[name] || fallback;
  const owner = {
    terminalRegistration: {
      finalize: domainBinding('finalizePositionPendingAfterTaskTerminal', record('position-finalize'))
    },
    recordPositionFilePlanIntent: record('position-intent'),
    markPositionBusinessOutcome: record('position-outcome'),
    markPositionArchiveDurable: record('position-durable'),
    markPositionArchiveIncomplete: record('position-incomplete'),
    cleanupPositionArchiveStaging: record('position-cleanup'),
    persistCurrentPositionArchiveIntentIfNeeded: record('position-persist-recovery'),
    runPositionReconciliationOperation(_channel, execute, identity) {
      counts.admission += 1;
      calls.push('position-admission');
      return options.admitPosition ? options.admitPosition(execute, identity) : execute();
    }
  };
  const acknowledgeReceipts = domainBinding('acknowledgeToolboxPublicationReceipts', record('receipt-acknowledge'));
  const adapterId = policy.scopeId === 'position-reconciliation-process' ? 'position-reconciliation'
    : policy.scopeId === 'toolbox' ? 'toolbox' : policy.scopeId === 'vcc-financial-op' ? 'vcc-financial-op' : 'passthrough';
  const adapterRegistry = options.adapterRegistry || createTaskAdapterRegistry({
    adapters: [createPassthroughTaskAdapter(), createPositionTaskAdapter({ owner,
      reportArchiveFailure: record('archive-failure'), createOperationToken: () => 'position-token-fixture' }),
    createToolboxTaskAdapter({ acknowledgeReceipts }), createVccOutputTaskAdapter({ acknowledgeReceipts })],
    taskBindings: [{ taskKey: policy.taskKey, adapterId }]
  });
  const context = vm.createContext({
    createPreparedResourceScope,
    taskAdapterRegistry: adapterRegistry,
    reportPreparedResourceCleanupFailure: (diagnostic) => cleanupDiagnostics.push(diagnostic),
    ...ipcTaskContract,
    archiveOperationContext: new AsyncLocalStorage(),
    archiveOperationTail: Promise.resolve(),
    taskPolicyRegistry: { get: (taskKey) => taskKey === channel ? policy : registry.get(taskKey) },
    archiveCenterService: options.initialize || options.initializeError ? null : {},
    archiveTaskLifecycle: options.lifecycleUnavailable ? null : lifecycle,
    initializeArchiveCenter() {
      calls.push('initialize');
      counts.initialize += 1;
      if (options.initializeError) throw options.initializeError;
      return options.initialize ? options.initialize() : {};
    },
    assertTaskPolicyNotHeld(actualPolicy, prepared) {
      counts.gate += 1;
      calls.push(`gate:${counts.gate}`);
      if (options.gate) options.gate(actualPolicy, prepared, counts.gate);
    },
    runWithStatementConfirmedSourceSnapshots: (_channel, _taskContext, execute) => execute(),
    resolveArchiveFlowEvidence: async () => null,
    resolveTaskFlowPlan: async () => ({ startsNewFlow: false, flowIdentity: null }),
    captureArchiveSourceSnapshots: ({ selectedPaths }) => selectedPaths.map((filePath) => ({ filePath })),
    resolveOperationInputPaths: ({ prepared }) => prepared.inputPaths,
    ...options.bindings
  });
  vm.runInContext(entrySource, context, { filename: MAIN_PATH });

  return {
    calls,
    counts,
    policy,
    lifecycleOptions,
    cleanupDiagnostics,
    getTail: () => context.archiveOperationTail,
    run(handler, invocation = {}) {
      const execute = typeof handler === 'function' ? handler : handler.execute;
      const countedExecute = (...args) => {
        counts.business += 1;
        calls.push('business');
        return execute(...args);
      };
      const countedHandler = typeof handler === 'function'
        ? countedExecute
        : { ...handler, execute: countedExecute };
      return context.runArchiveAwareOperation(
        invocation.meta || { channel, functionKey: '入口测试' },
        invocation.event || {},
        invocation.args || [],
        countedHandler
      );
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

module.exports = { createArchiveAwareOperationHarness, deferred };
