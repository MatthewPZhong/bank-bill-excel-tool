'use strict';

const path = require('node:path');
const { POSITION_READ_ONLY_POLICY, validatePositionReadOnlyExportResult } = require('../read-only-exports/position/policies');
const { POSITION_IMPORT_ADAPTER_POLICY, validatePositionImportAdapterResult } = require('../background-execution/position-import-adapter-policy');
const { createPositionImportMatureBinding } = require('../background-execution/adapters/position-import-adapter');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

const policies = Object.freeze([POSITION_READ_ONLY_POLICY, POSITION_IMPORT_ADAPTER_POLICY]);

function createModuleExecutionDescriptor(context = {}) {
  const binding = createPositionImportMatureBinding(context.positionImport || {});
  return createDescriptor({
    moduleId: 'position', policies, archivePolicies, registration: context.registration,
    entries: [{ key: POSITION_READ_ONLY_POLICY.entryKey, value: Object.freeze({
      path: path.resolve(__dirname, '../read-only-exports/position/worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['POSITION_EXPORT_CANCELLED'])
    }) }],
    adapters: [{ key: POSITION_IMPORT_ADAPTER_POLICY.adapterKey, value: binding }],
    validators: validatorBindings(policies, (policy) => policy === POSITION_READ_ONLY_POLICY
      ? validatePositionReadOnlyExportResult : validatePositionImportAdapterResult),
    topologies: [{ key: POSITION_IMPORT_ADAPTER_POLICY.resources.compound.topologyKey,
      value: binding.inspectTopology }],
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
