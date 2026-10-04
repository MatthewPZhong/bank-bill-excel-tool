'use strict';

const os = require('node:os');
const { compileExecutionDescriptors } = require('./contract');
const { createDescriptor } = require('./descriptor-builder');
const { BACKGROUND_EXECUTION_POLICIES, isBackgroundExecutionProductionEnabled } = require('./policy-catalog');
const runtime = require('../background-execution/runtime');
const { createProductionMemoryPolicy } = require('./memory-profiles');
const { createTaskPolicyRegistry: createArchiveRegistry } = require('../archive-center/task-policy-registry');
const { createActionTaskBindingRegistry } = require('../background-execution/action-task-binding-registry');
const { validateApprovedExecutionPolicies } = require('../background-execution/approved-execution-baseline');
const { validateActionCoverage } = require('../background-execution/coverage-check');
const { createBusinessTaskAdapterRegistrations } = require('../task-adapter-composition');
const { createTaskAdapterRegistry } = require('../task-adapters/registry');
const { createTerminalRouteRegistry } = require('../archive-center/terminal-route-registry');
const {
  RECOVERY_PARTICIPANT_ORDER,
  createApplicationRecoveryParticipants,
  createApplicationRecoveryComposition: createRecoveryComposition
} = require('../application-recovery/composition');
const { createReconFixEvidenceSettlementAdmission } = require('../recon-id-fix-service/evidence-settlement-admission');
const toolbox = require('../toolbox-background/execution-descriptor');
const newAccount = require('../new-account/execution-descriptor');
const preFund = require('../pre-fund-reconciliation/execution-descriptor');
const fundRecon = require('../fund-recon-worker/execution-descriptor');
const duplicate = require('../duplicate-inbound-match/execution-descriptor');
const reconFix = require('../recon-id-fix-service/execution-descriptor');
const vcc = require('../vcc-financial-op-output/execution-descriptor');
const position = require('../position-reconciliation/execution-descriptor');
const bizOp = require('../biz-op-v327/execution-descriptor');
const mature = require('./mature-adapters');
const legacy = require('./legacy-task-policies');

const ARCHIVE_POLICIES = Object.freeze([
  ...require('../toolbox-background/archive-task-policies').archivePolicies,
  ...require('../new-account/archive-task-policies').archivePolicies,
  ...require('../pre-fund-reconciliation/archive-task-policies').archivePolicies,
  ...require('../fund-recon-worker/archive-task-policies').archivePolicies,
  ...require('../duplicate-inbound-match/archive-task-policies').archivePolicies,
  ...require('../recon-id-fix-service/archive-task-policies').archivePolicies,
  ...require('../vcc-financial-op-output/archive-task-policies').archivePolicies,
  ...require('../position-reconciliation/archive-task-policies').archivePolicies,
  ...require('../biz-op-v327/archive-task-policies').archivePolicies,
  ...require('./mature-adapters').archivePolicies,
  ...legacy.archivePolicies
]);

// 只汇总纯 Archive policies；调用方不会为读取 inventory 构造 runtime/DB/worker。
function createTaskPolicyRegistry(policies = ARCHIVE_POLICIES) {
  return createArchiveRegistry(policies);
}

function registrationsFor(options) {
  const registrations = new Map();
  function registration(moduleId) {
    if (!registrations.has(moduleId)) registrations.set(moduleId, {
      taskAdapters: [], taskBindings: [], terminalRoutes: [], recoveryParticipants: []
    });
    return registrations.get(moduleId);
  }
  if (options.taskContext) {
    const taskRegistration = createBusinessTaskAdapterRegistrations({
      ...options.taskContext, policies: ARCHIVE_POLICIES
    });
    const adapterModules = {
      passthrough: 'legacy-task-policies', 'position-reconciliation': 'position',
      toolbox: 'toolbox', 'vcc-financial-op': 'vcc-financial-op'
    };
    for (const adapter of taskRegistration.adapters) {
      registration(adapterModules[adapter.id]).taskAdapters.push(adapter);
    }
    for (const binding of taskRegistration.taskBindings) {
      registration(adapterModules[binding.adapterId]).taskBindings.push(binding);
    }
    const routeModules = {
      'position-reconciliation': 'position', 'pending-run': 'mature-adapters',
      'biz-op-run': 'mature-adapters', 'pre-fund-run': 'pre-fund'
    };
    if (!Array.isArray(options.taskContext.terminalRoutes)
        || options.taskContext.terminalRoutes.length !== Object.keys(routeModules).length) {
      throw Object.assign(new Error('缺少完整的历史终态路由注册'), { code: 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING' });
    }
    for (const route of options.taskContext.terminalRoutes) {
      const owner = routeModules[route.route];
      if (!owner) throw Object.assign(new Error('未登记的终态路由'), { code: 'EXECUTION_DESCRIPTOR_INVALID' });
      registration(owner).terminalRoutes.push(route);
    }
  }
  if (options.recoveryContext) {
    const participantModules = {
      'biz-op-v327': 'biz-op-v327', 'pending-runs': 'mature-adapters',
      'legacy-biz-op-runs': 'mature-adapters', 'pre-fund-runs': 'pre-fund',
      position: 'position', 'toolbox-vcc-publications': 'toolbox',
      'vcc-import-terminal': 'vcc-financial-op', 'vcc-import-lineage': 'vcc-financial-op'
    };
    for (const participant of createApplicationRecoveryParticipants(options.recoveryContext)) {
      const owner = participantModules[participant.id];
      if (!owner) throw Object.assign(new Error('未登记的恢复参与者'), { code: 'EXECUTION_DESCRIPTOR_INVALID' });
      registration(owner).recoveryParticipants.push(participant);
    }
  }
  return (moduleId) => registration(moduleId);
}

// 独立生产授权检查始终由装配调用，不提供跳过或替换 authority 的参数。
function validateProductionExecutionDescriptors(compiled) {
  const taskPolicyRegistry = createArchiveRegistry(compiled.archivePolicies);
  const recoverableTasks = new Set(compiled.archivePolicies.filter((policy) => policy.batchPolicy !== 'exclude').map((policy) => policy.taskKey));
  for (const binding of compiled.taskBindings) {
    if (!recoverableTasks.has(binding.taskKey)) {
      throw Object.assign(new Error(`任务适配器引用未登记 TaskPolicy：${binding.taskKey}`), {
        code: 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING'
      });
    }
  }
  const actionTaskBindingRegistry = createActionTaskBindingRegistry({ taskPolicyRegistry: Object.freeze({ list: () => taskPolicyRegistry.list() }) });
  const bindings = require('../background-execution/action-task-binding-registry').bindingSnapshot();
  const { manifest } = validateApprovedExecutionPolicies(compiled.policies, { bindings });
  validateActionCoverage(manifest, { bindings, policies: compiled.policies });
  // catalog 不是候选描述符的期望来源；两者分别对固定批准基线校验，防止同步漂移自证。
  validateApprovedExecutionPolicies(BACKGROUND_EXECUTION_POLICIES, { bindings });
  return { taskPolicyRegistry, actionTaskBindingRegistry };
}

function composeExecutionDescriptors(options = {}) {
  const registration = registrationsFor(options);
  const availableParallelism = options.availableParallelism === undefined
    ? (typeof os.availableParallelism === 'function' ? os.availableParallelism() : Math.max(1, os.cpus().length))
    : options.availableParallelism;
  // 逐域选择最小 Main 能力，禁止把 globals 或 renderer 注册对象交给 factory。
  const descriptors = [
    toolbox.createModuleExecutionDescriptor({ registration: registration('toolbox') }),
    newAccount.createModuleExecutionDescriptor({ registration: registration('new-account') }),
    preFund.createModuleExecutionDescriptor({ availableParallelism, registration: registration('pre-fund') }),
    fundRecon.createModuleExecutionDescriptor({ registration: registration('fund-recon') }),
    duplicate.createModuleExecutionDescriptor({ availableParallelism, duplicateStartupGate: options.duplicateStartupGate, registration: registration('duplicate') }),
    reconFix.createModuleExecutionDescriptor({ reconFixJpmDatabasePath: options.reconFixJpmDatabasePath, registration: registration('recon-fix') }),
    vcc.createModuleExecutionDescriptor({ availableParallelism, vccFinancialOpDatabasePath: options.vccFinancialOpDatabasePath, vccFinancialOpAssetsDir: options.vccFinancialOpAssetsDir, registration: registration('vcc-financial-op') }),
    position.createModuleExecutionDescriptor({ positionImport: options.positionImport, registration: registration('position') }),
    bizOp.createModuleExecutionDescriptor({ bizOpV327: options.bizOpV327, registration: registration('biz-op-v327') }),
    mature.createModuleExecutionDescriptor({
      availableParallelism, toolboxPublication: options.toolboxPublication,
      acquiringMainDb: options.acquiringMainDb, acquiringMainDbProvider: options.acquiringMainDbProvider,
      acquiringLog: options.acquiringLog, mainDatabasePath: options.mainDatabasePath,
      pendingDatabasePath: options.pendingDatabasePath, userDataDir: options.userDataDir,
      positionImport: options.positionImport, registration: registration('mature-adapters')
    }),
    createDescriptor({ moduleId: 'legacy-task-policies', policies: [], mainBindings: [], archivePolicies: legacy.archivePolicies, registration: registration('legacy-task-policies') })
  ];
  // 旧 Main 注入 BizOP 授权后，其他域即使非生产也必须提供自身派发 hook。
  // 用显式拒绝保留该门禁；完全没有 Main 派发授权时仍为 null，保留原非生产观察路径。
  const fallbackDispatch = options.beforeCarrierDispatch == null && options.bizOpV327
    ? function rejectMissingMainDispatch() {
      throw Object.assign(new Error('关闭观察缺少该模块自己的 Main 派发绑定'), {
        code: 'CARRIER_DISPATCH_BINDING_REQUIRED'
      });
    }
    : options.beforeCarrierDispatch;
  const withDispatch = fallbackDispatch === undefined ? descriptors : descriptors.map((descriptor) => ({
    ...descriptor,
    mainBindings: descriptor.mainBindings.map((binding) => ({
      ...binding, beforeDispatch: binding.beforeDispatch === null ? fallbackDispatch : binding.beforeDispatch
    }))
  }));
  const compiled = compileExecutionDescriptors(withDispatch, { generatedAt: '2026-08-25T00:00:00+08:00' });
  const { taskPolicyRegistry, actionTaskBindingRegistry } = validateProductionExecutionDescriptors(compiled);
  const taskAdapterRegistry = options.taskContext ? createTaskAdapterRegistry({
    adapters: compiled.taskAdapters, taskBindings: compiled.taskBindings
  }) : null;
  if (taskAdapterRegistry) {
    for (const policy of compiled.archivePolicies) {
      if (policy.batchPolicy !== 'exclude') taskAdapterRegistry.resolve(policy.taskKey);
    }
  }
  const terminalRouteRegistry = options.taskContext ? createTerminalRouteRegistry(compiled.terminalRoutes) : null;
  return Object.freeze({ ...compiled, taskPolicyRegistry, actionTaskBindingRegistry, taskAdapterRegistry, terminalRouteRegistry });
}

function createExecutionTaskComposition(taskContext) {
  return composeExecutionDescriptors({ taskContext });
}

function createApplicationRecoveryComposition(recoveryContext) {
  const compiled = composeExecutionDescriptors({ recoveryContext });
  const byId = new Map(compiled.recoveryParticipants.map((entry) => [entry.id, entry]));
  if (byId.size !== RECOVERY_PARTICIPANT_ORDER.length
      || RECOVERY_PARTICIPANT_ORDER.some((id) => !byId.has(id))) {
    throw Object.assign(new Error('恢复参与者未完整装配'), { code: 'EXECUTION_DESCRIPTOR_REFERENCE_MISSING' });
  }
  return createRecoveryComposition({
    ...recoveryContext,
    participants: Object.freeze(RECOVERY_PARTICIPANT_ORDER.map((id) => byId.get(id)))
  });
}

function runtimeOptionsForGeneration(options) {
  const next = { ...options };
  for (const key of ['bizOpV327', 'duplicateStartupGate', 'workerDurableCoordinator',
    'reconFixJpmDatabasePath', 'pendingDatabasePath', 'mainDatabasePath', 'userDataDir']) {
    if (typeof options[`${key}Provider`] === 'function') next[key] = options[`${key}Provider`]();
  }
  const executionDescriptors = composeExecutionDescriptors(next);
  return {
    ...next,
    executionDescriptors,
    carrierClosureActionKeys: [...new Set([
      ...(next.carrierClosureActionKeys || []), ...(next.bizOpV327 ? next.bizOpV327.actionKeys : [])
    ])],
    beforeCarrierDispatch: next.beforeCarrierDispatch,
    createEvidenceSettlementAdmission: createReconFixEvidenceSettlementAdmission,
    createMemoryAdmission: createProductionMemoryPolicy
  };
}

function createBackgroundExecutionRuntime(options = {}) {
  return runtime.createBackgroundExecutionRuntime(runtimeOptionsForGeneration(options));
}
function createNonProductionBackgroundExecutionRuntime(options = {}) {
  return runtime.createNonProductionBackgroundExecutionRuntime(runtimeOptionsForGeneration(options));
}
function createBackgroundExecutionRuntimeManager(options = {}) {
  return runtime.createBackgroundExecutionRuntimeManager({
    ...options,
    runtimeFactory: options.runtimeFactory || (() => createBackgroundExecutionRuntime(options)),
    isProductionEnabled: isBackgroundExecutionProductionEnabled
  });
}

module.exports = {
  composeExecutionDescriptors, validateProductionExecutionDescriptors, createTaskPolicyRegistry, createExecutionTaskComposition,
  createApplicationRecoveryComposition,
  createBackgroundExecutionRuntime, createNonProductionBackgroundExecutionRuntime,
  createBackgroundExecutionRuntimeManager
};
