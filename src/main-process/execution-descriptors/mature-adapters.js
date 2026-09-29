'use strict';

const path = require('node:path');
const { PENDING_READ_ONLY_POLICIES, PENDING_READ_ONLY_ACTIONS,
  validatePendingReadOnlyExportResult } = require('../read-only-exports/pending/policies');
const { BIZ_OP_READ_ONLY_POLICIES, BIZ_OP_READ_ONLY_ACTION_SET,
  validateBizOpReadOnlyExportResult } = require('../read-only-exports/biz-op/policies');
const { ACQUIRING_EXPORT_POLICIES, ACQUIRING_EXPORT_ACTIONS,
  ACQUIRING_EXPORT_ACTION_SET, validateAcquiringExportResult } = require('../read-only-exports/acquiring/policies');
const { runAcquiringExistingDiffCopyInline } = require('../read-only-exports/acquiring/executor');
const { PENDING_BIZOP_ADAPTER_POLICIES, PENDING_BIZOP_ADAPTER_ACTION_SET,
  validatePendingBizOpAdapterResult } = require('../background-execution/pending-bizop-adapter-policies');
const { ACQUIRING_ADAPTER_POLICIES, ACQUIRING_ADAPTER_ACTIONS,
  validateAcquiringImportAdapterResult, validateAcquiringRunAdapterResult } = require('../background-execution/acquiring-adapter-policies');
const { createMatureActionAdapterBindings } = require('../background-execution/mature-action-adapters');
const {
  createBaseTaskPolicy,
  invocationBusinessRunIdentity
} = require('../archive-center/task-policy-common');

function acquiringRunResultFlowIdentities(result, _context, invocation = {}, isResume = false) {
  if (!result || typeof result !== 'object') return [];
  const runId = String(result.runId == null ? '' : result.runId).trim();
  if (!runId) return [];

  const args = Array.isArray(invocation.args) ? invocation.args : [];
  const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const resumePlan = prepared.resumePlan && typeof prepared.resumePlan === 'object'
    ? prepared.resumePlan
    : null;
  if (isResume && !resumePlan) return [];

  const payloadMonthKey = String(payload.monthKey == null ? '' : payload.monthKey).trim();
  const preparedMonthKey = String(
    (isResume ? resumePlan.monthKey : prepared.monthKey) == null
      ? ''
      : (isResume ? resumePlan.monthKey : prepared.monthKey)
  ).trim();
  if (payloadMonthKey && preparedMonthKey && payloadMonthKey !== preparedMonthKey) return [];
  const monthKey = preparedMonthKey || payloadMonthKey;
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return [];

  const source = isResume ? String(resumePlan.source || '').trim() : 'side';
  if (source !== 'side' && source !== 'main') return [];
  if (isResume && resumePlan.runId != null && String(resumePlan.runId).trim() !== runId) return [];
  const taskRunId = String(_context && _context.taskRunId || '').trim();
  return [{
    type: 'business-run-id',
    value: taskRunId
      ? `acquiring-task:${taskRunId}`
      : `acquiring-run:${source}:${monthKey}:${runId}`
  }];
}

function acquiringExportPlan(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const plan = prepared.exportPlan && typeof prepared.exportPlan === 'object'
    ? prepared.exportPlan
    : null;
  if (!plan) return null;
  const source = String(plan.source || '').trim();
  const monthKey = String(plan.monthKey || '').trim();
  const runId = String(plan.runId == null ? '' : plan.runId).trim();
  if (!['side', 'main'].includes(source) || !/^\d{4}-\d{2}$/.test(monthKey) || !runId) {
    return null;
  }
  const flowIdentity = plan.flowIdentity;
  const identityValue = String(flowIdentity && flowIdentity.value || '').trim();
  const legacyValue = `acquiring-run:${source}:${monthKey}:${runId}`;
  if (!flowIdentity
      || flowIdentity.type !== 'business-run-id'
      || (identityValue !== legacyValue && !identityValue.startsWith('acquiring-task:'))) {
    return null;
  }
  return { ...plan, flowIdentity };
}

function acquiringExportFlowPlan(invocation = {}) {
  const plan = acquiringExportPlan(invocation);
  if (!plan) {
    const error = new TypeError('收单导出缺少已选 run 的稳定流程证据');
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return { startsNewFlow: false, flowIdentity: plan.flowIdentity };
}

function acquiringExportResultFlowIdentities(result, _context, invocation = {}) {
  const plan = acquiringExportPlan(invocation);
  if (!plan || !result || typeof result !== 'object') return [];
  if (String(result.runId == null ? '' : result.runId).trim() !== String(plan.runId)
      || String(result.monthKey || '').trim() !== plan.monthKey
      || String(result.source || '').trim() !== plan.source) {
    return [];
  }
  return [plan.flowIdentity];
}

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('pending:diff:export-aggregate', 'PENDING'),
  createBaseTaskPolicy('pending:diff:export-single', 'PENDING', {
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity
  }),
  createBaseTaskPolicy('pending:error:export-report', 'PENDING'),
  createBaseTaskPolicy('pending:import:start', 'PENDING'),
  createBaseTaskPolicy('pending:reconcile:run', 'PENDING'),
  createBaseTaskPolicy('pending:removed:import', 'PENDING'),
  createBaseTaskPolicy('pending:rule:save', 'PENDING'),
  createBaseTaskPolicy('bizOpRecon:export:date', 'BIZOP', {
    startsNewFlow: false,
    flowIdentityResolver: invocationBusinessRunIdentity
  }),
  createBaseTaskPolicy('bizOpRecon:export:date-range', 'BIZOP'),
  createBaseTaskPolicy('bizOpRecon:import:run-biz-op', 'BIZOP'),
  createBaseTaskPolicy('bizOpRecon:import:run-flow', 'BIZOP'),
  createBaseTaskPolicy('bizOpRecon:run', 'BIZOP'),
  createBaseTaskPolicy('acquiringBillCurrency:clearMonth', 'ACQUIRING', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('acquiringBillCurrency:export', 'ACQUIRING', {
    startsNewFlow: false,
    flowPlanResolver: acquiringExportFlowPlan,
    resultFlowIdentities: acquiringExportResultFlowIdentities
  }),
  createBaseTaskPolicy('acquiringBillCurrency:importBill', 'ACQUIRING'),
  createBaseTaskPolicy('acquiringBillCurrency:importFlow', 'ACQUIRING'),
  createBaseTaskPolicy('acquiringBillCurrency:run', 'ACQUIRING', {
    resultFlowIdentities: (result, context, invocation) => acquiringRunResultFlowIdentities(
      result, context, invocation, false
    )
  }),
  createBaseTaskPolicy('acquiringBillCurrency:run:resume', 'ACQUIRING', {
    resultFlowIdentities: (result, context, invocation) => acquiringRunResultFlowIdentities(
      result, context, invocation, true
    )
  })
]);

const { createDescriptor, passthroughInput, validatorBindings } = require('./descriptor-builder');

const adapterPolicies = Object.freeze([...PENDING_BIZOP_ADAPTER_POLICIES, ...ACQUIRING_ADAPTER_POLICIES]);
const policies = Object.freeze([...PENDING_READ_ONLY_POLICIES, ...BIZ_OP_READ_ONLY_POLICIES,
  ...ACQUIRING_EXPORT_POLICIES, ...adapterPolicies]);

function createModuleExecutionDescriptor(context = {}) {
  const pendingDatabasePath = context.pendingDatabasePath && path.resolve(context.pendingDatabasePath);
  const mainDatabasePath = context.mainDatabasePath && path.resolve(context.mainDatabasePath);
  const userDataDir = context.userDataDir && path.resolve(context.userDataDir);
  const bindings = createMatureActionAdapterBindings({
    toolboxPublication: context.toolboxPublication,
    acquiring: { userDataDir: context.userDataDir, mainDb: context.acquiringMainDb,
      mainDbProvider: context.acquiringMainDbProvider, mainDatabasePath: context.mainDatabasePath,
      onLog: context.acquiringLog },
    position: context.positionImport || {}
  });
  const pendingEntry = Object.freeze({ path: path.resolve(__dirname, '../read-only-exports/pending/worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['PENDING_EXPORT_CANCELLED']) });
  const bizOpEntry = Object.freeze({ path: path.resolve(__dirname, '../read-only-exports/biz-op/worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['BIZ_OP_EXPORT_CANCELLED']) });
  const acquiringEntry = Object.freeze({ path: path.resolve(__dirname, '../read-only-exports/acquiring/worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['ACQUIRING_EXPORT_CANCELLED']) });
  function bindPendingInput({ input }) {
    if (!pendingDatabasePath) {
      throw Object.assign(new Error('Pending export runtime 缺少 Main database authority'), {
        code: 'PENDING_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE'
      });
    }
    if (Object.hasOwn(input, 'dbPathOrManagedSource')) {
      throw Object.assign(new Error('Pending export database authority 不接受 caller override'), {
        code: 'PENDING_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN'
      });
    }
    return Object.freeze({ ...input, dbPathOrManagedSource: Object.freeze({ kind: 'sqlite', databasePath: pendingDatabasePath }) });
  }
  function bindBizOpInput({ input }) {
    if (!mainDatabasePath || !userDataDir) {
      throw Object.assign(new Error('BizOP export runtime 缺少 Main database/userData authority'), {
        code: 'BIZ_OP_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE'
      });
    }
    if (Object.hasOwn(input, 'dbPathOrManagedSource')) {
      throw Object.assign(new Error('BizOP export database authority 不接受 caller override'), {
        code: 'BIZ_OP_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN'
      });
    }
    return Object.freeze({ ...input, dbPathOrManagedSource: Object.freeze({ kind: 'biz-op-sqlite', mainDatabasePath, userDataDir }) });
  }
  return createDescriptor({
    moduleId: 'mature-adapters', policies, archivePolicies, registration: context.registration,
    entries: policies.filter((policy) => policy.entryKey !== null).map((policy) => ({ key: policy.entryKey,
      value: policy.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY ? runAcquiringExistingDiffCopyInline
        : (policy.actionKey === ACQUIRING_EXPORT_ACTIONS.REGENERATE ? acquiringEntry
          : (BIZ_OP_READ_ONLY_ACTION_SET.has(policy.actionKey) ? bizOpEntry : pendingEntry)) })),
    adapters: adapterPolicies.map((policy) => ({ key: policy.adapterKey, value: bindings[policy.actionKey] })),
    validators: validatorBindings(policies, (policy) => PENDING_BIZOP_ADAPTER_ACTION_SET.has(policy.actionKey)
      ? validatePendingBizOpAdapterResult
      : (policy.adapterKey !== null
        ? (policy.actionKey === ACQUIRING_ADAPTER_ACTIONS.IMPORT ? validateAcquiringImportAdapterResult : validateAcquiringRunAdapterResult)
        : (ACQUIRING_EXPORT_ACTION_SET.has(policy.actionKey) ? validateAcquiringExportResult
          : (BIZ_OP_READ_ONLY_ACTION_SET.has(policy.actionKey) ? validateBizOpReadOnlyExportResult : validatePendingReadOnlyExportResult)))),
    topologies: adapterPolicies.filter((policy) => policy.resources.compound)
      .map((policy) => ({ key: policy.resources.compound.topologyKey, value: bindings[policy.actionKey].inspectTopology })),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: [PENDING_READ_ONLY_ACTIONS.DIFF, PENDING_READ_ONLY_ACTIONS.SUMMARY].includes(policy.actionKey)
        ? bindPendingInput : (BIZ_OP_READ_ONLY_ACTION_SET.has(policy.actionKey) ? bindBizOpInput : passthroughInput),
      beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor, archivePolicies,
  acquiringRunResultFlowIdentities, acquiringExportPlan, acquiringExportFlowPlan,
  acquiringExportResultFlowIdentities };
