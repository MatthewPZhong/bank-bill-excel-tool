'use strict';

const { STATIC_REFERENCE_PATHS } = require('../background-execution/execution-policy-registry');

function passthroughInput({ input }) { return input; }

function staticKeysForPolicies(policies) {
  return Object.fromEntries(STATIC_REFERENCE_PATHS.map(([fieldPath, bucket]) => [
    bucket,
    [...new Set(policies.map((policy) => fieldPath.split('.').reduce(
      (value, key) => value && value[key], policy
    )).filter((key) => key !== null && key !== undefined))]
  ]));
}

function uniqueBindings(bindings) {
  const values = new Map();
  for (const { key, value } of bindings) {
    if (values.has(key) && values.get(key) !== value) {
      const error = new Error(`领域内重复定义 runtime binding：${key}`);
      error.code = 'EXECUTION_DESCRIPTOR_DUPLICATE';
      throw error;
    }
    values.set(key, value);
  }
  return [...values].map(([key, value]) => ({ key, value }));
}

// 原 runtime 对 artifact capability 绑定相同的同步结果校验器；
// 真正异步技术/业务校验继续由 Main 在 Publisher 前执行。
function validatorBindings(policies, validatorForPolicy) {
  return uniqueBindings(policies.flatMap((policy) => {
    const value = validatorForPolicy(policy);
    return [policy.result.validatorKey, policy.artifacts.technicalValidatorKey,
      policy.artifacts.businessValidatorKey]
      .filter((key) => key !== null && key !== undefined)
      .map((key) => ({ key, value }));
  }));
}

function createDescriptor({ moduleId, policies, mainBindings, entries = [], adapters = [],
  validators = [], resourceProfiles = [], topologies = [], archivePolicies = [],
  registration = {} }) {
  return {
    schemaVersion: 1,
    moduleId,
    policies,
    entries: uniqueBindings(entries),
    adapters: uniqueBindings(adapters),
    validators: uniqueBindings(validators),
    resourceProfiles: uniqueBindings(resourceProfiles),
    topologies: uniqueBindings(topologies),
    mainBindings,
    staticKeys: staticKeysForPolicies(policies),
    archivePolicies,
    taskAdapters: registration.taskAdapters || [],
    taskBindings: registration.taskBindings || [],
    terminalRoutes: registration.terminalRoutes || [],
    recoveryParticipants: registration.recoveryParticipants || []
  };
}

module.exports = { createDescriptor, passthroughInput, uniqueBindings, validatorBindings };
