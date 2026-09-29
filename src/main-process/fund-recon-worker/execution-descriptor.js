'use strict';

const path = require('node:path');
const { FUND_RECON_POLICIES: policies, validateFundReconImportResult,
  validateFundReconRunResult, validateFundReconExportResult } = require('./policies');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

function createModuleExecutionDescriptor(context = {}) {
  const entry = Object.freeze({ path: path.resolve(__dirname, 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['FUND_RECON_SHUTDOWN']) });
  return createDescriptor({
    moduleId: 'fund-recon', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey, value: entry })),
    validators: validatorBindings(policies, (policy) => policy.actionKey === 'fund-recon:import'
      ? validateFundReconImportResult
      : (policy.actionKey === 'fund-recon:run' ? validateFundReconRunResult : validateFundReconExportResult)),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
