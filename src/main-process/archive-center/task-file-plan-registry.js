'use strict';

function requiredPreparedFilePlan(invocation = {}) {
  const plan = invocation.prepared && invocation.prepared.filePlan;
  if (!plan) {
    const error = new TypeError(`file action 缺少入口显式 filePlan：${invocation.channel || ''}`);
    error.code = 'ARCHIVE_FILE_PLAN_INVALID';
    throw error;
  }
  return plan;
}

function preparedPickerPlan(invocation) {
  return requiredPreparedFilePlan(invocation);
}

function preparedExportPlan(invocation) {
  return requiredPreparedFilePlan(invocation);
}

function preparedWorkerPlan(invocation) {
  const resolver = invocation.prepared && invocation.prepared.filePlanResolver;
  if (typeof resolver !== 'function') {
    const error = new TypeError(`worker file action 缺少 TaskRun-dependent FilePlan resolver：${invocation.channel || ''}`);
    error.code = 'ARCHIVE_FILE_PLAN_INVALID';
    throw error;
  }
  return resolver({ taskRun: invocation.taskRun });
}

function persistedResumePlan(invocation) {
  const prepared = invocation.prepared || {};
  if (typeof prepared.assertPreRecoveryFresh === 'function') {
    prepared.assertPreRecoveryFresh();
  }
  if (typeof prepared.filePlanResolver === 'function') {
    return prepared.filePlanResolver({ taskRun: invocation.taskRun });
  }
  return requiredPreparedFilePlan(invocation);
}

function preparedSessionPlan(invocation) {
  return requiredPreparedFilePlan(invocation);
}

function preparedPayloadPlan(invocation) {
  return requiredPreparedFilePlan(invocation);
}

function promotedResultManifest(result = {}) {
  if (!result.promotionManifest) {
    const error = new TypeError('deferred file action 缺少显式 promotion manifest');
    error.code = 'ARCHIVE_FILE_MANIFEST_EMPTY';
    throw error;
  }
  return result.promotionManifest;
}

const FILE_PLAN_RESOLVERS_BY_SOURCE_KIND = Object.freeze({
  'prepare-selected-inputs': preparedPickerPlan,
  'prepare-bundle-input': preparedPickerPlan,
  'prepare-retry-token-inputs': preparedPickerPlan,
  'inspected-inputs': preparedPickerPlan,
  'normalized-submission-inputs': preparedPickerPlan,
  'prepare-inputs-and-output': preparedPickerPlan,
  'prepare-source-and-concrete-outputs': preparedPickerPlan,
  'prepare-save-target': preparedExportPlan,
  'prepare-export-plan': preparedExportPlan,
  'prepare-target-snapshot': preparedExportPlan,
  'prepare-multi-target-snapshots': preparedExportPlan,
  'pre-worker-deterministic-outputs': preparedWorkerPlan,
  'persisted-resume-outputs': persistedResumePlan,
  'statement-session-inputs': preparedSessionPlan,
  'payload-pending-and-bank-inputs': preparedPayloadPlan,
  'payload-input-paths': preparedPayloadPlan,
  'prepare-selected-and-staging': preparedPayloadPlan,
  'staged-token-inputs': preparedPayloadPlan,
  'nonempty-result-before-workbook-write': preparedWorkerPlan
});

function eager(sourceKind, workerContext = 'none') {
  const filePlanResolver = FILE_PLAN_RESOLVERS_BY_SOURCE_KIND[sourceKind];
  if (!filePlanResolver) throw new TypeError(`未定义 filePlan source kind：${sourceKind}`);
  return Object.freeze({
    allocation: 'eager',
    sourceKind,
    workerContext,
    filePlanResolver,
    promotionManifestResolver: null
  });
}

function deferred(sourceKind) {
  const filePlanResolver = FILE_PLAN_RESOLVERS_BY_SOURCE_KIND[sourceKind];
  if (!filePlanResolver) throw new TypeError(`未定义 filePlan source kind：${sourceKind}`);
  return Object.freeze({
    allocation: 'deferred',
    sourceKind,
    workerContext: 'none',
    filePlanResolver,
    promotionManifestResolver: promotedResultManifest
  });
}

// 每个 action 都是 literal inventory；sourceKind 是 prepare 接线/测试的审计标签，
// 不参与运行时路径猜测。
const TASK_FILE_PLAN_DEFINITIONS = Object.freeze({
  'bizOpReconV327:import': eager('prepare-selected-inputs', 'operation'),
  'bizOpReconV327:export:op-raw': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:flow-raw': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:op-check': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:flow-check': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:result-full': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:result-diff': eager('prepare-export-plan', 'operation'),
  'bizOpReconV327:export:errors': eager('prepare-export-plan', 'operation'),

  'acquiringBillCurrency:importBill': eager('prepare-selected-inputs', 'batch'),
  'acquiringBillCurrency:importFlow': eager('prepare-selected-inputs', 'batch'),
  'acquiringBillCurrency:run': eager('pre-worker-deterministic-outputs', 'batch'),
  'acquiringBillCurrency:run:resume': eager('persisted-resume-outputs', 'batch'),
  'acquiringBillCurrency:export': eager('prepare-save-target'),
  'bank-statement:import': eager('prepare-selected-inputs'),
  'bank-statement:batch-import': eager('prepare-selected-inputs'),
  'bank-statement:export': eager('prepare-export-plan'),
  'bankBuRecon:import:run': eager('payload-pending-and-bank-inputs'),
  'bankBuRecon:export:single': eager('prepare-save-target'),
  'bankBuRecon:export:aggregate': eager('prepare-save-target'),
  'big-account:import-bank-info': eager('prepare-selected-inputs'),
  'file:import': eager('prepare-selected-inputs'),
  'file:complete-big-account-selection': eager('statement-session-inputs'),
  'file:save-balance-seed': eager('statement-session-inputs'),
  'file:export-detail': eager('prepare-save-target'),
  'file:export-balance': eager('prepare-save-target'),
  'monthly-balance:export': eager('prepare-save-target'),
  'monthly-balance:assemble': deferred('nonempty-result-before-workbook-write'),
  'new-account:generate': deferred('nonempty-result-before-workbook-write'),
  'new-account:export': eager('prepare-save-target'),
  'template:import': eager('prepare-selected-inputs'),
  'template:import-bundle': eager('prepare-selected-inputs'),
  'template:export-bundle': eager('prepare-save-target'),
  'scenarios:import-bundle-apply': eager('prepare-bundle-input'),
  'scenarios:export-bundle': eager('prepare-save-target'),
  'gateway-recon:import': eager('prepare-selected-inputs'),
  'linked-table:import': eager('prepare-selected-inputs'),
  'bizOpRecon:import:run-biz-op': eager('payload-input-paths', 'batch'),
  'bizOpRecon:import:run-flow': eager('payload-input-paths', 'batch'),
  'bizOpRecon:export:date': eager('prepare-save-target'),
  'bizOpRecon:export:date-range': eager('prepare-save-target'),
  'duplicate-inbound-match:import-files': eager('prepare-selected-inputs'),
  'duplicate-inbound-match:export': eager('prepare-save-target'),
  'pending:import:start': eager('normalized-submission-inputs', 'batch'),
  'pending:removed:import': eager('normalized-submission-inputs'),
  'pending:diff:export-single': eager('prepare-save-target'),
  'pending:diff:export-aggregate': eager('prepare-save-target'),
  'pending:error:export-report': eager('prepare-save-target'),
  'position-reconciliation:bank:apply-import': eager('staged-token-inputs', 'batch'),
  'position-reconciliation:source:prepare-import': eager('prepare-selected-and-staging', 'batch'),
  'position-reconciliation:source:apply-import': eager('staged-token-inputs', 'batch'),
  'position-reconciliation:run:import-result': eager('prepare-selected-inputs', 'batch'),
  'position-reconciliation:bank:export': eager('prepare-save-target'),
  'position-reconciliation:linked:export': eager('prepare-save-target'),
  'position-reconciliation:raw:export': eager('prepare-save-target'),
  'position-reconciliation:run:export': eager('prepare-save-target'),
  'position-reconciliation:run:export-filtered': eager('prepare-save-target'),
  'position-reconciliation:source:export-anomaly': eager('prepare-save-target'),
  'pre-fund-reconciliation:import-bank': eager('prepare-selected-inputs'),
  'pre-fund-reconciliation:import-mpt': eager('prepare-selected-inputs'),
  'pre-fund-reconciliation:mpt-errors:repair': eager('prepare-retry-token-inputs'),
  'pre-fund-reconciliation:mpt-errors:export': eager('prepare-save-target'),
  'pre-fund-reconciliation:export': eager('prepare-export-plan'),
  'recon-id-fix:import': eager('prepare-selected-inputs'),
  'recon-id-fix:export': eager('prepare-export-plan'),
  'vccOpCalc:import:scan': eager('payload-input-paths'),
  'vccFinancialOp:import:apply': eager('inspected-inputs', 'batch'),
  'vccFinancialOp:data-manager:export': eager('prepare-target-snapshot', 'batch'),
  'vccFinancialOp:export:import-audit': eager('prepare-target-snapshot', 'batch'),
  'vccFinancialOp:export:result': eager('prepare-multi-target-snapshots', 'batch'),
  'toolbox:merge': eager('prepare-inputs-and-output', 'batch'),
  'toolbox:split:export': eager('prepare-source-and-concrete-outputs', 'batch')
});

function getTaskFilePlanDefinition(channel) {
  return TASK_FILE_PLAN_DEFINITIONS[String(channel || '')] || null;
}

module.exports = {
  TASK_FILE_PLAN_DEFINITIONS,
  getTaskFilePlanDefinition
};
