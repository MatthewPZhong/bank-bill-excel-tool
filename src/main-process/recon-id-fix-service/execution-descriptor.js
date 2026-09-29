'use strict';

const path = require('node:path');
const { RECON_FIX_POLICIES: policies, RECON_FIX_EXPORT_ACTION, RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_JPM_UNIT_ID, validateReconFixExportResult, validateReconFixJpmResult,
  validateReconFixServiceResult } = require('./policies');
const { createReconFixJpmDatabaseAuthority } = require('./jpm-database-authority');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

function createModuleExecutionDescriptor(context = {}) {
  const authority = context.reconFixJpmDatabasePath === undefined || context.reconFixJpmDatabasePath === null
    ? null : createReconFixJpmDatabaseAuthority(context.reconFixJpmDatabasePath);
  const entry = Object.freeze({ path: path.resolve(__dirname, 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['RECON_FIX_CANCELLED']) });
  function bindJpmInput({ input }) {
    if (!authority) {
      throw Object.assign(new Error('ReconFix JPM runtime generation 缺少 Main database authority'), {
        code: 'RECON_FIX_JPM_DATABASE_AUTHORITY_UNAVAILABLE'
      });
    }
    if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'databaseIdentity')) {
      throw Object.assign(new Error('ReconFix JPM database authority 不接受 caller override'), {
        code: 'RECON_FIX_JPM_DATABASE_AUTHORITY_OVERRIDE_FORBIDDEN'
      });
    }
    return Object.freeze({ ...input, databasePath: authority.databasePath });
  }
  const jpmUnits = Object.freeze([Object.freeze({ unitId: RECON_FIX_JPM_UNIT_ID, input: Object.freeze({}) })]);
  return createDescriptor({
    moduleId: 'recon-fix', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey, value: entry })),
    validators: validatorBindings(policies, (policy) => policy.actionKey === RECON_FIX_EXPORT_ACTION
      ? validateReconFixExportResult
      : (policy.actionKey === RECON_FIX_RUN_JPM_ACTION ? validateReconFixJpmResult : validateReconFixServiceResult)),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: policy.actionKey === RECON_FIX_RUN_JPM_ACTION ? bindJpmInput : passthroughInput,
      beforeDispatch: null,
      defaultUnits: policy.actionKey === RECON_FIX_RUN_JPM_ACTION ? () => jpmUnits : null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
