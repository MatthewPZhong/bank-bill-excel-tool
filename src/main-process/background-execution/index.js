'use strict';

const {
  createExecutionPolicyRegistry,
  createStaticRegistry,
  validatePolicyDocument
} = require('./execution-policy-registry');
const { createExecutionSupervisor } = require('./supervisor');
const protocol = require('./protocol');
const protocolValidator = require('./protocol-validator');
const { validateProtocolSequence } = require('./protocol-sequence-validator');
const { createDirectionSequenceTracker } = require('./sequence-tracker');
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
  createDirectionSequenceTracker,
  createExecutionPolicyRegistry,
  createExecutionSupervisor,
  createExistingDispatchAdapter,
  createInlineAsyncAdapter,
  createStaticRegistry,
  createUtilityProcessAdapter,
  createWorkerThreadAdapter,
  validatePolicyDocument,
  validateProtocolSequence
};
