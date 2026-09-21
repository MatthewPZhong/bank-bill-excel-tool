'use strict';

const path = require('node:path');
const { TOOLBOX_GENERATION_POLICIES } = require('./policies');
const { TOOLBOX_GENERATION_ACTIONS, validateToolboxGenerationResult,
  validateToolboxMultiGenerationResult } = require('./generation-contract');
const { ROWS_POLICY } = require('../toolbox-row-split/policy');
const { ROWS_ACTION, validateRowsResult } = require('../toolbox-row-split/contracts');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

const policies = Object.freeze([...TOOLBOX_GENERATION_POLICIES, ROWS_POLICY]);

function createModuleExecutionDescriptor(context = {}) {
  const entries = policies.map((policy) => ({ key: policy.entryKey, value: Object.freeze({
    path: policy.actionKey === ROWS_ACTION
      ? path.resolve(__dirname, '../toolbox-row-split/worker-entry.js')
      : path.resolve(__dirname, policy.actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE
        ? 'merge-worker-entry.js'
        : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
          ? 'route-scanner-worker-entry.js' : 'split-worker-entry.js')),
    ...(policy.actionKey === ROWS_ACTION
      ? { resourceLimits: Object.freeze({ maxOldGenerationSizeMb: 640, maxYoungGenerationSizeMb: 32 }) } : {}),
    cancellationTerminalErrorCodes: Object.freeze(['TOOLBOX_GENERATION_CANCELLED'])
  }) }));
  return createDescriptor({
    moduleId: 'toolbox', policies, entries, archivePolicies, registration: context.registration,
    validators: validatorBindings(policies, (policy) => policy.actionKey === ROWS_ACTION
      ? validateRowsResult
      : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
        ? validateToolboxMultiGenerationResult
        : (value) => validateToolboxGenerationResult(value, policy.actionKey))),
    // 原多输出 route scanner 的固定单子项拓扑，保持既有准入策略。
    topologies: policies.filter((policy) => policy.resources.compound).map((policy) => ({
      key: policy.resources.compound.topologyKey,
      value: () => Object.freeze({ effectiveChildCount: 1 })
    })),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
