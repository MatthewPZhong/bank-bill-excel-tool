'use strict';

const path = require('node:path');
const { DUPLICATE_POLICIES: policies, DUPLICATE_ACTIONS, validateDuplicateImportResult,
  validateDuplicateRunResult, validateDuplicateExportResult } = require('./policies');
const { normalizeDuplicateStartupGateDescriptor } = require('./startup-gate');
const { createDuplicatePairedTopologyPlanner } = require('./topology');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

function createModuleExecutionDescriptor(context = {}) {
  const entry = Object.freeze({ path: path.resolve(__dirname, 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['DUPLICATE_SHUTDOWN']),
    workerData: Object.freeze({ startupGate: normalizeDuplicateStartupGateDescriptor(context.duplicateStartupGate) }) });
  const topology = createDuplicatePairedTopologyPlanner({ availableParallelism: context.availableParallelism });
  return createDescriptor({
    moduleId: 'duplicate', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey, value: entry })),
    validators: validatorBindings(policies, (policy) => policy.actionKey === DUPLICATE_ACTIONS.IMPORT
      ? validateDuplicateImportResult
      : (policy.actionKey === DUPLICATE_ACTIONS.RUN ? validateDuplicateRunResult : validateDuplicateExportResult)),
    topologies: policies.filter((policy) => policy.resources.compound)
      .map((policy) => ({ key: policy.resources.compound.topologyKey, value: topology })),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
