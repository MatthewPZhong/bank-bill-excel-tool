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
const { createServiceHost } = require('./service-host');
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

module.exports = {
  ...protocol,
  ...protocolValidator,
  ...errorCodec,
  ...canary,
  ACTION_TASK_BINDING_CONTRACT,
  ActionTaskBindingRegistryError,
  bindingSnapshot,
  createActionTaskBindingRegistry,
  initializeActionTaskBindingRegistry,
  initializeActionTaskBindingStartup,
  createDirectionSequenceTracker,
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
  createServiceHost,
  createStaticRegistry,
  createUtilityProcessAdapter,
  createWorkerThreadAdapter,
  RecoveryControlError,
  validatePolicyDocument,
  validateProtocolSequence
};
