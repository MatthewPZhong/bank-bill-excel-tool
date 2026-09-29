'use strict';

const path = require('node:path');
const { VCC_EXPORT_SINGLE_ACTION, VCC_EXPORT_SINGLE_POLICY, VCC_EXPORT_SUBJECTS_POLICY,
  validateVccExportSingleResult, validateVccExportSubjectsResult } = require('./policies');
const { createVccExportTopologyPlanner } = require('./topology');
const { VCC_FINANCIAL_OP_READ_ONLY_POLICY, validateVccFinancialOpReadOnlyExportResult } = require('../read-only-exports/vcc-financial-op/policies');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

const outputPolicies = Object.freeze([VCC_EXPORT_SINGLE_POLICY, VCC_EXPORT_SUBJECTS_POLICY]);
const policies = Object.freeze([...outputPolicies, VCC_FINANCIAL_OP_READ_ONLY_POLICY]);

function createModuleExecutionDescriptor(context = {}) {
  const databasePath = context.vccFinancialOpDatabasePath && path.resolve(context.vccFinancialOpDatabasePath);
  const assetsDir = context.vccFinancialOpAssetsDir && path.resolve(context.vccFinancialOpAssetsDir);
  const topology = createVccExportTopologyPlanner();
  function bindOutputInput({ input }) {
    if (!databasePath || !assetsDir) {
      throw Object.assign(new Error('VCC export runtime generation 缺少 Main database/assets authority'), {
        code: 'VCC_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE'
      });
    }
    if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'assetsDir')) {
      throw Object.assign(new Error('VCC export database/assets authority 不接受 caller override'), {
        code: 'VCC_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN'
      });
    }
    return Object.freeze({ ...input, databasePath, assetsDir });
  }
  return createDescriptor({
    moduleId: 'vcc-financial-op', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey, value: Object.freeze({
      path: policy === VCC_FINANCIAL_OP_READ_ONLY_POLICY
        ? path.resolve(__dirname, '../read-only-exports/vcc-financial-op/worker-entry.js')
        : path.resolve(__dirname, policy.actionKey === VCC_EXPORT_SINGLE_ACTION
          ? 'single-writer-worker-entry.js' : 'writer-worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze([policy === VCC_FINANCIAL_OP_READ_ONLY_POLICY
        ? 'VCC_FINANCIAL_OP_EXPORT_CANCELLED' : 'VCC_EXPORT_CANCELLED']),
      ...(policy === VCC_EXPORT_SUBJECTS_POLICY ? { admittedTopologyWorkerData: true } : {})
    }) })),
    validators: validatorBindings(policies, (policy) => policy === VCC_FINANCIAL_OP_READ_ONLY_POLICY
      ? validateVccFinancialOpReadOnlyExportResult
      : (policy.actionKey === VCC_EXPORT_SINGLE_ACTION ? validateVccExportSingleResult : validateVccExportSubjectsResult)),
    topologies: [{ key: VCC_EXPORT_SUBJECTS_POLICY.resources.compound.topologyKey, value: topology }],
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: policy === VCC_FINANCIAL_OP_READ_ONLY_POLICY ? passthroughInput : bindOutputInput,
      beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
