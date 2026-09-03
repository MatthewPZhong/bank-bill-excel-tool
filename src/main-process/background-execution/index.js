'use strict';

const {
  createExecutionPolicyRegistry,
  createStaticRegistry,
  validatePolicyDocument
} = require('./execution-policy-registry');
const { createExecutionSupervisor } = require('./supervisor');
const {
  ACTION_TASK_BINDING_CONTRACT,
  ActionTaskBindingRegistryError,
  bindingSnapshot,
  createActionTaskBindingRegistry,
  initializeActionTaskBindingRegistry,
  initializeActionTaskBindingStartup
} = require('./action-task-binding-registry');
const protocol = require('./protocol');
const protocolValidator = require('./protocol-validator');
const { validateProtocolSequence } = require('./protocol-sequence-validator');
const { createDirectionSequenceTracker } = require('./sequence-tracker');
const { createResourceGovernor } = require('./resource-governor');
const {
  createPlatformResourceBudgets
} = require('./resource-budget');
const { createServiceHost } = require('./service-host');
const { createServiceClient, ServiceClientError } = require('./service-client');
const {
  createBatchRecoveryOverlayAdapter,
  createRecoveryTaskLifecycleAdapter,
  createRecoveryTransitionAdapter
} = require('./task-lifecycle-adapter');
const {
  createRecoveryControlRepository
} = require('./critical/recovery-control-repository');
const {
  createRecoveryControlReadRepository
} = require('./critical/recovery-control-read-repository');
const {
  RecoveryControlError,
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('./critical/recovery-request-owner-repository');
const errorCodec = require('./error-codec');
const { createInlineAsyncAdapter } = require('./adapters/inline-async-adapter');
const { createWorkerThreadAdapter } = require('./adapters/worker-thread-adapter');
const { createUtilityProcessAdapter } = require('./adapters/utility-process-adapter');
const { createExistingDispatchAdapter } = require('./adapters/existing-dispatch-adapter');
const canary = require('./canary');
const durableCanary = require('./canary/durable-recovery');
const {
  createInspectorRegistry,
  RecoveryRegistryError
} = require('./inspector-registry');
const {
  createSettlementRecoveryProviderRegistry
} = require('./settlement-recovery-provider-registry');
const recoverySource = require('./recovery-source');
const {
  createStartupRecoveryCoordinator,
  StartupRecoveryError
} = require('./startup-recovery-coordinator');
const {
  createRecoveryHoldGate,
  RecoveryHoldActiveError
} = require('./recovery-hold-gate');
const durableFile = require('./durable-file');
const matureActionAdapters = require('./mature-action-adapters');
const actionManifest = require('./action-manifest');
const actionCoverage = require('./coverage-check');
const capabilityInventory = require('./capability-inventory');
const productionStrategySnapshot = require('./production-strategy-snapshot');

module.exports = {
  ...protocol,
  ...protocolValidator,
  ...errorCodec,
  ...canary,
  ...durableCanary,
  ...durableFile,
  ...matureActionAdapters,
  ...actionManifest,
  ...actionCoverage,
  ...capabilityInventory,
  ...productionStrategySnapshot,
  ...recoverySource,
  ACTION_TASK_BINDING_CONTRACT,
  ActionTaskBindingRegistryError,
  bindingSnapshot,
  createActionTaskBindingRegistry,
  initializeActionTaskBindingRegistry,
  initializeActionTaskBindingStartup,
  createDirectionSequenceTracker,
  createInspectorRegistry,
  createExecutionPolicyRegistry,
  createExecutionSupervisor,
  createExistingDispatchAdapter,
  createInlineAsyncAdapter,
  createBatchRecoveryOverlayAdapter,
  createRecoveryControlReadRepository,
  createRecoveryControlRepository,
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository,
  createRecoveryTaskLifecycleAdapter,
  createRecoveryTransitionAdapter,
  createResourceGovernor,
  createPlatformResourceBudgets,
  createRecoveryHoldGate,
  createServiceClient,
  createServiceHost,
  createSettlementRecoveryProviderRegistry,
  createStartupRecoveryCoordinator,
  createStaticRegistry,
  createUtilityProcessAdapter,
  createWorkerThreadAdapter,
  RecoveryControlError,
  RecoveryHoldActiveError,
  RecoveryRegistryError,
  ServiceClientError,
  StartupRecoveryError,
  validatePolicyDocument,
  validateProtocolSequence
};
