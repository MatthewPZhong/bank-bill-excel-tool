'use strict';

const pureComputePolicy = require('./pure-compute-policy.json');
const durableRecoveryPolicy = require('./durable-policy.json');
const {
  executePureComputeCanary,
  validatePureComputeCanaryResult
} = require('./pure-compute');

const PURE_COMPUTE_ACTION_KEY = 'background-execution:pure-compute-canary';
const PURE_COMPUTE_ENTRY_KEY = 'executor.background-execution:pure-compute-canary';
const PURE_COMPUTE_RESULT_VALIDATOR_KEY = 'result-validator.background-execution:pure-compute-canary';
const PURE_COMPUTE_WORKER_ENTRY = require.resolve('./pure-compute-worker');
const PURE_COMPUTE_WORKER_BINDING = Object.freeze({
  path: PURE_COMPUTE_WORKER_ENTRY,
  cancellationTerminalErrorCodes: Object.freeze(['CANARY_CANCELLED'])
});

function createPureComputeCanaryRegistrations() {
  return Object.freeze({
    policy: pureComputePolicy,
    entryKey: PURE_COMPUTE_ENTRY_KEY,
    workerEntry: PURE_COMPUTE_WORKER_BINDING,
    resultValidatorKey: PURE_COMPUTE_RESULT_VALIDATOR_KEY,
    resultValidator: validatePureComputeCanaryResult
  });
}

module.exports = {
  PURE_COMPUTE_ACTION_KEY,
  PURE_COMPUTE_ENTRY_KEY,
  PURE_COMPUTE_RESULT_VALIDATOR_KEY,
  PURE_COMPUTE_WORKER_BINDING,
  PURE_COMPUTE_WORKER_ENTRY,
  createPureComputeCanaryRegistrations,
  durableRecoveryPolicy,
  executePureComputeCanary,
  pureComputePolicy,
  validatePureComputeCanaryResult
};
