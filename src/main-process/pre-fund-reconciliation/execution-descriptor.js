'use strict';

const path = require('node:path');
const { PRE_FUND_MPT_POLICIES, PRE_FUND_MPT_REPAIR_ACTION,
  validatePreFundMptImportResult, validatePreFundMptRepairResult } = require('./mpt-import/policies');
const { createPreFundMptTopologyPlanner } = require('./mpt-import/topology');
const { PRE_FUND_READ_ONLY_POLICIES, validatePreFundReadOnlyExportResult } = require('../read-only-exports/pre-fund/policies');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

const policies = Object.freeze([...PRE_FUND_MPT_POLICIES, ...PRE_FUND_READ_ONLY_POLICIES]);

function createModuleExecutionDescriptor(context = {}) {
  const writerEntry = Object.freeze({ path: path.resolve(__dirname, 'mpt-import/writer-worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['PREFUND_WRITER_CANCELLED']) });
  const exportEntry = Object.freeze({ path: path.resolve(__dirname, '../read-only-exports/pre-fund/worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['PRE_FUND_EXPORT_CANCELLED']) });
  const topology = createPreFundMptTopologyPlanner({ availableParallelism: context.availableParallelism });
  return createDescriptor({
    moduleId: 'pre-fund', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey,
      value: policy.moduleId === 'pre-fund' ? writerEntry : exportEntry })),
    validators: validatorBindings(policies, (policy) => policy.moduleId !== 'pre-fund'
      ? validatePreFundReadOnlyExportResult
      : (policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION ? validatePreFundMptRepairResult : validatePreFundMptImportResult)),
    topologies: PRE_FUND_MPT_POLICIES.filter((policy) => policy.resources.compound)
      .map((policy) => ({ key: policy.resources.compound.topologyKey, value: topology })),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
