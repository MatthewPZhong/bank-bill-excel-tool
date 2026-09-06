'use strict';

const { randomUUID } = require('node:crypto');

const { resolveArchiveScope } = require('./module-scope-registry');
const {
  TASK_FILE_PLAN_DEFINITIONS,
  getTaskFilePlanDefinition
} = require('./task-file-plan-registry');

const EXCLUDE_REASONS = Object.freeze([
  'read-only-query',
  'file-picker-only',
  'staging-preflight-only',
  'preview-only',
  'cancel-active-task',
  'archive-center-maintenance',
  'ui-navigation'
]);
const EXCLUDE_REASON_SET = new Set(EXCLUDE_REASONS);

const SUPPORT_ACTION_POLICIES = Object.freeze([
  Object.freeze({
    channel: 'app:save-user-guide',
    kind: 'support-action',
    reason: 'user-document-export'
  }),
  Object.freeze({
    channel: 'error:export-last',
    kind: 'support-action',
    reason: 'diagnostic-report-export'
  })
]);

const FILE_ACTION_CHANNELS = Object.freeze(Object.keys(TASK_FILE_PLAN_DEFINITIONS));
const NO_FILE_ACTION_CHANNELS = Object.freeze([
  'bizOpReconV327:run',
  'bizOpReconV327:delete',
  'bizOpReconV327:maintenance:upgrade',
  'bizOpReconV327:maintenance:reclaim',

  'account-mapping:distribute-migration',
  'account-mapping:save',
  'balance-adjustment:save',
  'big-account-mode:save',
  'big-account-order:save',
  'big-account:save-own-accounts',
  'template:clear-bill-split-merge-groups',
  'template:delete',
  'template:delete-bill-split-row',
  'template:rename',
  'template:save-amount-split-rules',
  'template:save-bill-split-amount-rules',
  'template:save-bill-split-mappings',
  'template:save-bill-split-merge-group',
  'template:save-bill-split-meta',
  'template:save-bill-split-row',
  'template:save-bill-split-row-count',
  'template:save-filename-fixed-field',
  'template:set-child-parent',
  'template:set-parent-status',
  'channels:create',
  'channels:delete',
  'channels:update',
  'fund-transfer-account-mapping:save',
  'scenarios:batch-delete',
  'scenarios:create',
  'scenarios:delete',
  'scenarios:set-applicable-channels',
  'scenarios:toggle-enabled',
  'scenarios:transfer',
  'scenarios:update',
  'linked-table:delete-by-date-range',
  'recon-id-fix:clear-session',
  'recon-id-fix:run',
  'pending:reconcile:run',
  'pending:rule:save',
  'bankBuRecon:run',
  'bizOpRecon:run',
  'vccOpCalc:run:compute-amounts',
  'vccOpCalc:run:save',
  'vccFinancialOp:data-manager:delete',
  'vccFinancialOp:opening:initialize',
  'vccFinancialOp:run:adjustment-add',
  'vccFinancialOp:run:archive',
  'vccFinancialOp:run:calculate',
  'vccFinancialOp:run:unarchive',
  'acquiringBillCurrency:clearMonth',
  'pre-fund-reconciliation:run',
  'pre-fund-reconciliation:temp:clear',
  'pre-fund-reconciliation:temp:delete',
  'pre-fund-reconciliation:temp:delete-by-date-range',
  'duplicate-inbound-match:run',
  'position-reconciliation:bank:delete',
  'position-reconciliation:mappings:save',
  'position-reconciliation:run',
  'position-reconciliation:run:confirm',
  'position-reconciliation:source:delete',
  'bank-statement:run',
  'template:save-mappings'
]);
const NO_FILE_ACTION_SET = new Set(NO_FILE_ACTION_CHANNELS);
const OPERATION_WORKER_ACTIONS = new Set([
  'bizOpReconV327:run',
  'bizOpReconV327:delete',
  'bizOpReconV327:maintenance:upgrade',
  'bizOpReconV327:maintenance:reclaim',

  'acquiringBillCurrency:clearMonth',
  'position-reconciliation:bank:delete',
  'position-reconciliation:mappings:save',
  'position-reconciliation:run',
  'position-reconciliation:run:confirm',
  'position-reconciliation:source:delete',
  'vccOpCalc:run:compute-amounts',
  'vccOpCalc:run:save',
  'vccFinancialOp:data-manager:delete',
  'vccFinancialOp:opening:initialize',
  'vccFinancialOp:run:adjustment-add',
  'vccFinancialOp:run:archive',
  'vccFinancialOp:run:calculate',
  'vccFinancialOp:run:unarchive'
]);

const RESERVE_CHANNELS_BY_SCOPE = Object.freeze({
  STATEMENT: Object.freeze([
    'account-mapping:distribute-migration',
    'account-mapping:save',
    'balance-adjustment:save',
    'big-account-mode:save',
    'big-account-order:save',
    'big-account:import-bank-info',
    'big-account:save-own-accounts',
    'file:complete-big-account-selection',
    'file:export-balance',
    'file:export-detail',
    'file:import',
    'file:save-balance-seed',
    'monthly-balance:assemble',
    'monthly-balance:export',
    'template:save-mappings',
    'template:clear-bill-split-merge-groups',
    'template:delete',
    'template:delete-bill-split-row',
    'template:export-bundle',
    'template:import',
    'template:import-bundle',
    'template:rename',
    'template:save-amount-split-rules',
    'template:save-bill-split-amount-rules',
    'template:save-bill-split-mappings',
    'template:save-bill-split-merge-group',
    'template:save-bill-split-meta',
    'template:save-bill-split-row',
    'template:save-bill-split-row-count',
    'template:save-filename-fixed-field',
    'template:set-child-parent',
    'template:set-parent-status'
  ]),
  NEWACCOUNT: Object.freeze([
    'new-account:export',
    'new-account:generate'
  ]),
  FUNDRECON: Object.freeze([
    'bank-statement:batch-import',
    'bank-statement:export',
    'bank-statement:import',
    'bank-statement:run',
    'channels:create',
    'channels:delete',
    'channels:update',
    'fund-transfer-account-mapping:save',
    'gateway-recon:import',
    'scenarios:batch-delete',
    'scenarios:create',
    'scenarios:delete',
    'scenarios:export-bundle',
    'scenarios:import-bundle-apply',
    'scenarios:set-applicable-channels',
    'scenarios:toggle-enabled',
    'scenarios:transfer',
    'scenarios:update'
  ]),
  LINKED: Object.freeze([
    'linked-table:delete-by-date-range',
    'linked-table:import'
  ]),
  RECONFIX: Object.freeze([
    'recon-id-fix:clear-session',
    'recon-id-fix:export',
    'recon-id-fix:import',
    'recon-id-fix:run'
  ]),
  PENDING: Object.freeze([
    'pending:diff:export-aggregate',
    'pending:diff:export-single',
    'pending:error:export-report',
    'pending:import:start',
    'pending:reconcile:run',
    'pending:removed:import',
    'pending:rule:save'
  ]),
  BANKBU: Object.freeze([
    'bankBuRecon:export:aggregate',
    'bankBuRecon:export:single',
    'bankBuRecon:import:run',
    'bankBuRecon:run'
  ]),
  BIZOP: Object.freeze([
    'bizOpReconV327:import',
    'bizOpReconV327:run',
    'bizOpReconV327:delete',
    'bizOpReconV327:maintenance:upgrade',
    'bizOpReconV327:maintenance:reclaim',
    'bizOpReconV327:export:op-raw',
    'bizOpReconV327:export:flow-raw',
    'bizOpReconV327:export:op-check',
    'bizOpReconV327:export:flow-check',
    'bizOpReconV327:export:result-full',
    'bizOpReconV327:export:result-diff',
    'bizOpReconV327:export:errors',

    'bizOpRecon:export:date',
    'bizOpRecon:export:date-range',
    'bizOpRecon:import:run-biz-op',
    'bizOpRecon:import:run-flow',
    'bizOpRecon:run'
  ]),
  VCCOP: Object.freeze([
    'vccOpCalc:import:scan',
    'vccOpCalc:run:compute-amounts',
    'vccOpCalc:run:save'
  ]),
  VCCFINOP: Object.freeze([
    'vccFinancialOp:data-manager:delete',
    'vccFinancialOp:data-manager:export',
    'vccFinancialOp:export:import-audit',
    'vccFinancialOp:export:result',
    'vccFinancialOp:import:apply',
    'vccFinancialOp:opening:initialize',
    'vccFinancialOp:run:adjustment-add',
    'vccFinancialOp:run:archive',
    'vccFinancialOp:run:calculate',
    'vccFinancialOp:run:unarchive'
  ]),
  ACQUIRING: Object.freeze([
    'acquiringBillCurrency:clearMonth',
    'acquiringBillCurrency:export',
    'acquiringBillCurrency:importBill',
    'acquiringBillCurrency:importFlow',
    'acquiringBillCurrency:run',
    'acquiringBillCurrency:run:resume'
  ]),
  PREFUND: Object.freeze([
    'pre-fund-reconciliation:export',
    'pre-fund-reconciliation:import-bank',
    'pre-fund-reconciliation:run',
    'pre-fund-reconciliation:temp:clear',
    'pre-fund-reconciliation:temp:delete',
    'pre-fund-reconciliation:temp:delete-by-date-range'
  ]),
  PREFUNDTEMP: Object.freeze([
    'pre-fund-reconciliation:import-mpt',
    'pre-fund-reconciliation:mpt-errors:export',
    'pre-fund-reconciliation:mpt-errors:repair'
  ]),
  DUPINBOUND: Object.freeze([
    'duplicate-inbound-match:export',
    'duplicate-inbound-match:import-files',
    'duplicate-inbound-match:run'
  ]),
  POSITION: Object.freeze([
    'position-reconciliation:bank:apply-import',
    'position-reconciliation:bank:delete',
    'position-reconciliation:bank:export',
    'position-reconciliation:mappings:save',
    'position-reconciliation:run',
    'position-reconciliation:run:confirm',
    'position-reconciliation:run:export',
    'position-reconciliation:run:export-filtered',
    'position-reconciliation:run:import-result'
  ]),
  POSITIONLINK: Object.freeze([
    'position-reconciliation:linked:export',
    'position-reconciliation:raw:export',
    'position-reconciliation:source:apply-import',
    'position-reconciliation:source:delete',
    'position-reconciliation:source:export-anomaly',
    'position-reconciliation:source:prepare-import'
  ]),
  TOOLBOX: Object.freeze([
    'toolbox:merge',
    'toolbox:split:export'
  ])
});

const EXCLUDED_CHANNELS_BY_REASON = Object.freeze({
  'read-only-query': Object.freeze([
    'bizOpReconV327:status',
    'bizOpReconV327:metadata:months',
    'bizOpReconV327:metadata:list',
    'bizOpReconV327:metadata:input',
    'account-mapping:check-migration-pending',
    'account-mapping:get-migration-data',
    'account-mapping:list',
    'acquiringBillCurrency:listMonths',
    'acquiringBillCurrency:sessionStatus',
    'app-update:get-status',
    'app:get-info',
    'archive-center:get-batch',
    'archive-center:get-settings',
    'archive-center:get-stats',
    'archive-center:list-batches',
    'balance-adjustment:list',
    'bank-statement:c3-candidate-count',
    'bank-statement:refund-candidate-count',
    'bank-statement:session-status',
    'bankBuRecon:months:list',
    'bankBuRecon:run:history',
    'bankBuRecon:run:list-ready-months',
    'bankBuRecon:run:list-success-months',
    'bankBuRecon:status',
    'big-account-mode:load',
    'big-account-order:load',
    'big-account:get-with-own',
    'bizOpRecon:bu:list',
    'bizOpRecon:export:list-success-dates',
    'bizOpRecon:import:check-single-day',
    'bizOpRecon:run:history',
    'bizOpRecon:run:list-ready-dates',
    'bizOpRecon:status',
    'channels:list',
    'duplicate-inbound-match:session-status',
    'fund-transfer-account-mapping:list',
    'linked-table:count-by-date-range',
    'linked-table:list',
    'linked-table:row-count',
    'pending:columns',
    'pending:diff:latest-run-for',
    'pending:diff:runs-for-month-pair',
    'pending:diff:runs-list',
    'pending:months:list',
    'pending:rule:get',
    'position-reconciliation:data-manager',
    'position-reconciliation:linked-manager',
    'position-reconciliation:mappings:list',
    'position-reconciliation:status',
    'pre-fund-reconciliation:session-status',
    'pre-fund-reconciliation:temp:count-by-date-range',
    'pre-fund-reconciliation:temp:list',
    'recon-id-fix:session-status',
    'scenarios:fund-type-enum',
    'scenarios:gateway-recon-headers',
    'scenarios:get',
    'scenarios:get-applicable-channels',
    'scenarios:list',
    'settings:get-enabled-modules',
    'settings:get-ui-style',
    'template:get-amount-split-rules',
    'template:get-bill-split-config',
    'template:get-mappings',
    'template:list',
    'template:list-children',
    'vccOpCalc:balance:get',
    'vccOpCalc:balance:list-months',
    'vccFinancialOp:data-manager:delete-targets',
    'vccFinancialOp:data-manager:overview',
    'vccFinancialOp:imports:list-months',
    'vccFinancialOp:imports:list-records',
    'vccFinancialOp:run:adjustment-options',
    'vccFinancialOp:run:archived-months',
    'vccFinancialOp:run:get',
    'vccFinancialOp:run:latest-archived'
  ]),
  'file-picker-only': Object.freeze([
    'bizOpReconV327:files:pick',
    'bizOpReconV327:export:pick',
    'background:select-file',
    'bankBuRecon:export:pick-save-path',
    'bankBuRecon:import:pick-bank-file',
    'bankBuRecon:import:pick-pending-file',
    'bizOpRecon:export:pick-save-path',
    'bizOpRecon:import:open-error-report-folder',
    'bizOpRecon:import:pick-biz-op-file',
    'bizOpRecon:import:pick-flow-file',
    'pending:import:pick-files',
    'pending:removed:pick-files',
    'scenarios:import-bundle',
    'vccOpCalc:import:pick-files',
    'vccFinancialOp:import:pick-files'
  ]),
  'staging-preflight-only': Object.freeze([
    'position-reconciliation:bank:prepare-import'
  ]),
  'preview-only': Object.freeze([
    'bizOpReconV327:run:preflight',
    'bizOpReconV327:delete:preview',
    'file:extract-big-account-order',
    'template:preview-delete-bill-split-row',
    'toolbox:split:read',
    'vccFinancialOp:data-manager:delete-preview',
    'vccFinancialOp:data-manager:export-preview',
    'vccFinancialOp:run:preflight',
    'vccFinancialOp:run:unarchive-preview'
  ]),
  'cancel-active-task': Object.freeze([
    'bizOpReconV327:task:cancel',
    'acquiringBillCurrency:run:cancel',
    'file:cancel-big-account-selection',
    'position-reconciliation:bank:cancel-import',
    'position-reconciliation:import:cancel',
    'position-reconciliation:source:cancel-import',
    'vccFinancialOp:task:cancel'
  ]),
  'archive-center-maintenance': Object.freeze([
    'bizOpReconV327:recovery:retry',
    'archive-center:change-storage-location',
    'archive-center:delete-batch',
    'archive-center:open-file',
    'archive-center:retry-batch',
    'archive-center:save-as',
    'archive-center:select-retry-sources',
    'archive-center:set-locked',
    'archive-center:set-retention-days',
    'archive-center:start-entry-maintenance'
  ]),
  'ui-navigation': Object.freeze([
    'app-update:check-now',
    'app-update:restart-and-install',
    'app-update:set-enabled',
    'background:reset',
    'background:save',
    'settings:set-current-module',
    'settings:set-enabled-modules',
    'settings:set-recon-id-fix-bill-category',
    'window:close',
    'window:minimize',
    'window:toggle-maximize'
  ])
});

const STANDARD_SUCCESS_STATUSES = new Set([
  'completed_with_errors',
  'ok',
  'ready',
  'success',
  'warning'
]);
const STANDARD_FAILURE_STATUSES = new Set([
  'ambiguous',
  'busy',
  'conflict',
  'disabled',
  'empty',
  'error',
  'failed',
  'invalid',
  'manual-balance-invalid',
  'not-active',
  'not-cancellable',
  'overwrite-required',
  'partial',
  'read-error',
  'rejected',
  'stopping',
  'unrecognized',
  'unsupported',
  'write-error'
]);

function classifyKnownStatus(result, extraSuccessStatuses = []) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (!status || STANDARD_SUCCESS_STATUSES.has(status) || extraSuccessStatuses.includes(status)) {
    return 'succeeded';
  }
  if (STANDARD_FAILURE_STATUSES.has(status)) return 'failed';
  throw new TypeError(`未审计的业务结果 status：${status}`);
}

function standardResultClassifier(result) {
  return classifyKnownStatus(result);
}

function vccOpSaveRunResultClassifier(result) {
  // E03-B unknown 已由 Main exact owner seam 先 CAS 为 interrupted；这里仍分类为
  // failure，使 TaskLifecycle 的通用 terminal 路径执行并以状态冲突保留 interrupted。
  if (String(result && result.status || '').trim().toLowerCase() === 'recovery-required') {
    return 'failed';
  }
  return standardResultClassifier(result);
}

function standardResultMetadataResolver(result) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (!status) return {};
  return {
    resultStatus: status,
    ...(status === 'completed_with_errors' ? { completedWithErrors: true } : {})
  };
}

function statementResultClassifier(result) {
  // 大账号选择、记住顺序不匹配与导出范围选择均已在 prepare 阶段以
  // proceed:false 返回，不能再被 execute 分类器静默接受为成功批次。
  return classifyKnownStatus(result, ['manual-balance-required']);
}

function positionResultClassifier(result) {
  return classifyKnownStatus(result, ['needs-confirmation']);
}

function vccFinancialOpResultClassifier(result) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'blocked') return 'failed';
  return classifyKnownStatus(result, ['calculated', 'initialized', 'all_skipped', 'archived']);
}

function vccFlowIdentity(kind, value) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized) {
    const error = new TypeError(`VCC ${kind} 稳定业务身份缺失`);
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return {
    type: `vcc-financial-op-${kind}`,
    value: normalized
  };
}

function vccInvocationPayload(invocation = {}) {
  const args = Array.isArray(invocation.args) ? invocation.args : [];
  return args[0] && typeof args[0] === 'object' ? args[0] : {};
}

function vccRunFlowIdentity(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const payload = vccInvocationPayload(invocation);
  return vccFlowIdentity('run', prepared.runId ?? payload.runId);
}

function vccImportRecordFlowIdentity(invocation = {}) {
  return vccFlowIdentity('import-record', vccInvocationPayload(invocation).recordId);
}

function vccDeleteFlowPlan(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const runIds = Array.isArray(prepared.runIds) ? prepared.runIds : [];
  if (prepared.targetType === 'result' && runIds.length === 1) {
    return { startsNewFlow: false, flowIdentity: vccFlowIdentity('run', runIds[0]) };
  }
  return { startsNewFlow: true, flowIdentity: null };
}

function vccImportResultFlowIdentities(result) {
  if (!result || typeof result !== 'object') return [];
  const identities = [];
  if (String(result.batchId || '').trim()) {
    identities.push(vccFlowIdentity('import-batch', result.batchId));
  }
  for (const record of Array.isArray(result.records) ? result.records : []) {
    if (record && String(record.recordId || '').trim()) {
      identities.push(vccFlowIdentity('import-record', record.recordId));
    }
  }
  return identities;
}

function vccResultFlowIdentities(channel, result) {
  if (channel === 'vccFinancialOp:import:apply') {
    return vccImportResultFlowIdentities(result);
  }
  if (!result || typeof result !== 'object' || !String(result.runId || '').trim()) return [];
  return [vccFlowIdentity('run', result.runId)];
}

function vccFinancialOpResultMetadata(result) {
  const source = result && typeof result === 'object' ? result : {};
  const metadata = standardResultMetadataResolver(source);
  for (const key of [
    'runId',
    'targetMonth',
    'resultRevision',
    'batchId',
    'recordId',
    'auditId',
    'deletionId',
    'deletedRunCount',
    'deletedDataCount'
  ]) {
    const value = source[key];
    if (value !== undefined && value !== null) metadata[key] = value;
  }
  if (source.adjustment && source.adjustment.id !== undefined) {
    metadata.adjustmentId = source.adjustment.id;
  }
  if (Array.isArray(source.initializedSubjects)) {
    metadata.initializedSubjectCount = source.initializedSubjects.length;
  }
  if (Array.isArray(source.filePaths)) metadata.outputFileCount = source.filePaths.length;
  if (source.filePath) metadata.outputFileCount = 1;
  return metadata;
}

function resultBusinessRunIdentities(result) {
  if (!result || typeof result !== 'object') return [];
  for (const key of ['runId', 'mirrorId', 'operationToken', 'ranAt']) {
    const value = String(result[key] == null ? '' : result[key]).trim();
    if (value) return [{ type: key === 'operationToken' ? 'operation-token' : 'business-run-id', value }];
  }
  return [];
}

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

function bankStatementFlowIdentity(value) {
  const identity = value && typeof value === 'object' ? value : null;
  const identityValue = String(identity && identity.value || '').trim();
  if (!identity
      || identity.type !== 'business-run-id'
      || !identityValue.startsWith('bank-statement-run:')) {
    return null;
  }
  return { type: 'business-run-id', value: identityValue };
}

function createBankStatementRunFlowIdentity(createId = randomUUID) {
  if (typeof createId !== 'function') throw new TypeError('createId 必须是函数');
  const value = String(createId() || '').trim();
  if (!value) throw new TypeError('银行对账 run 身份不能为空');
  return Object.freeze({
    type: 'business-run-id',
    value: `bank-statement-run:${value}`
  });
}

function bankStatementExportFlowPlan(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const processingResult = prepared.inspected && prepared.inspected.processingResult;
  const flowIdentity = bankStatementFlowIdentity(
    processingResult && processingResult.archiveFlowIdentity
  );
  if (!flowIdentity) {
    const error = new TypeError('银行对账导出缺少本轮运行的稳定流程证据');
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return { startsNewFlow: false, flowIdentity };
}

function bankStatementExportResultFlowIdentities(result, _context, invocation = {}) {
  if (!result || String(result.status || '') !== 'ok') return [];
  try {
    return [bankStatementExportFlowPlan(invocation).flowIdentity];
  } catch (_error) {
    return [];
  }
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

async function resolveBankBuImportEvidence(invocation = {}) {
  if (typeof invocation.resolveFlowEvidence !== 'function') return null;
  const evidence = await invocation.resolveFlowEvidence('bank-bu-import-bundle');
  if (!evidence || !evidence.identity) return null;
  const type = String(evidence.identity.type || evidence.identity.identityType || '').trim();
  const value = String(evidence.identity.value || evidence.identity.identityValue || '').trim();
  if (type !== 'bank-bu-import-bundle' || !value) return null;
  return {
    identity: { type, value },
    hasRun: evidence.hasRun === true
  };
}

// 首次 run 可由当前持久导入行主键证明续接；已有 run 时本次点击就是显式重跑，必须新建 parent。
// 证据不可读或不存在时宁可新建流程，绝不按月份/最新批次猜测继承。
async function bankBuRunFlowPlan(invocation = {}) {
  const evidence = await resolveBankBuImportEvidence(invocation);
  if (!evidence || evidence.hasRun) {
    return { startsNewFlow: true, flowIdentity: null };
  }
  return {
    startsNewFlow: false,
    flowIdentity: evidence.identity
  };
}

async function bankBuImportResultFlowIdentities(_result, _context, invocation = {}) {
  const evidence = await resolveBankBuImportEvidence(invocation);
  return evidence ? [evidence.identity] : [];
}

const CONTINUATION_CHANNELS = new Set([
  'bankBuRecon:export:single',
  'bizOpRecon:export:date',
  'pending:diff:export-single',
  'position-reconciliation:run:confirm',
  'position-reconciliation:run:export',
  'position-reconciliation:run:export-filtered',
  'position-reconciliation:run:import-result'
]);

function invocationBusinessRunIdentity(invocation = {}) {
  const args = Array.isArray(invocation.args) ? invocation.args : [];
  const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
  const candidate = payload.runId ?? (
    typeof args[0] === 'string' || typeof args[0] === 'number' ? args[0] : null
  );
  const value = String(candidate == null ? '' : candidate).trim();
  if (!value) {
    const error = new TypeError('续接任务缺少稳定 runId');
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return { type: 'business-run-id', value };
}

function resultClassifierForChannel(channel) {
  if (channel.startsWith('file:') || channel.startsWith('monthly-balance:')) {
    return statementResultClassifier;
  }
  if (channel.startsWith('position-reconciliation:')) return positionResultClassifier;
  if (channel.startsWith('vccFinancialOp:')) return vccFinancialOpResultClassifier;
  if (channel === 'vccOpCalc:run:save') return vccOpSaveRunResultClassifier;
  return standardResultClassifier;
}

function createReservePolicy(channel, scopeKey) {
  const scope = resolveArchiveScope(scopeKey);
  if (!scope) throw new Error(`未知 archive scope：${scopeKey}`);
  const isBankBuImport = channel === 'bankBuRecon:import:run';
  const isBankBuRun = channel === 'bankBuRecon:run';
  const isAcquiringRun = channel === 'acquiringBillCurrency:run';
  const isAcquiringResume = channel === 'acquiringBillCurrency:run:resume';
  const isAcquiringExport = channel === 'acquiringBillCurrency:export';
  const isBankStatementExport = channel === 'bank-statement:export';
  const isVcc = channel.startsWith('vccFinancialOp:');
  const isVccRunContinuation = [
    'vccFinancialOp:export:result',
    'vccFinancialOp:run:adjustment-add',
    'vccFinancialOp:run:archive',
    'vccFinancialOp:run:unarchive'
  ].includes(channel);
  const isVccImportContinuation = channel === 'vccFinancialOp:export:import-audit';
  const isVccDelete = channel === 'vccFinancialOp:data-manager:delete';
  const fileDefinition = getTaskFilePlanDefinition(channel);
  const isNoFileAction = NO_FILE_ACTION_SET.has(channel);
  if (Boolean(fileDefinition) === isNoFileAction) {
    throw new TypeError(`mutation action 必须且只能登记一种 task kind：${channel}`);
  }
  const taskKind = fileDefinition ? 'file' : 'no-file';
  return Object.freeze({
    channel,
    scopeId: scope.id,
    moduleCode: scope.storageCode,
    moduleName: scope.name,
    taskKey: channel,
    batchPolicy: taskKind === 'file' ? 'reserve' : 'no-file',
    taskKind,
    allocation: fileDefinition ? fileDefinition.allocation : 'none',
    filePlanSourceKind: fileDefinition ? fileDefinition.sourceKind : null,
    filePlanResolver: fileDefinition ? fileDefinition.filePlanResolver : null,
    promotionManifestResolver: fileDefinition
      ? fileDefinition.promotionManifestResolver
      : null,
    workerContext: fileDefinition
      ? fileDefinition.workerContext
      : OPERATION_WORKER_ACTIONS.has(channel)
        ? 'operation'
        : 'none',
    startsNewFlow: (isAcquiringExport || isBankStatementExport
      || isVccRunContinuation || isVccImportContinuation)
      ? false
      : !CONTINUATION_CHANNELS.has(channel),
    flowIdentityResolver: isVccRunContinuation
      ? vccRunFlowIdentity
      : isVccImportContinuation
        ? vccImportRecordFlowIdentity
        : CONTINUATION_CHANNELS.has(channel)
          ? invocationBusinessRunIdentity
          : null,
    flowPlanResolver: isBankBuRun
      ? bankBuRunFlowPlan
      : isAcquiringExport
        ? acquiringExportFlowPlan
        : isBankStatementExport
          ? bankStatementExportFlowPlan
        : isVccDelete
          ? vccDeleteFlowPlan
          : null,
    resultClassifier: resultClassifierForChannel(channel),
    bindResultFlowIdentitiesOnFailure: channel === 'vccFinancialOp:import:apply',
    resultMetadataResolver: isVcc
      ? vccFinancialOpResultMetadata
      : standardResultMetadataResolver,
    resultFlowIdentities: isVcc
      ? (result) => vccResultFlowIdentities(channel, result)
      : isBankBuImport
      ? bankBuImportResultFlowIdentities
      : isAcquiringExport
        ? acquiringExportResultFlowIdentities
      : isBankStatementExport
        ? bankStatementExportResultFlowIdentities
      : (isAcquiringRun || isAcquiringResume)
        ? (result, context, invocation) => acquiringRunResultFlowIdentities(
            result,
            context,
            invocation,
            isAcquiringResume
          )
        : resultBusinessRunIdentities
  });
}

function createExcludePolicy(channel, excludeReason) {
  if (!EXCLUDE_REASON_SET.has(excludeReason)) {
    throw new TypeError(`不支持的 excludeReason：${excludeReason}`);
  }
  return Object.freeze({
    channel,
    batchPolicy: 'exclude',
    taskKind: 'exclude',
    workerContext: 'none',
    excludeReason
  });
}

function buildPolicies() {
  const policies = new Map();
  const add = (policy) => {
    if (policies.has(policy.channel)) throw new Error(`Task policy 重复：${policy.channel}`);
    policies.set(policy.channel, policy);
  };
  for (const [scopeKey, channels] of Object.entries(RESERVE_CHANNELS_BY_SCOPE)) {
    for (const channel of channels) add(createReservePolicy(channel, scopeKey));
  }
  for (const [reason, channels] of Object.entries(EXCLUDED_CHANNELS_BY_REASON)) {
    for (const channel of channels) {
      add(createExcludePolicy(channel, reason));
    }
  }
  const classifiedChannels = new Set([
    ...FILE_ACTION_CHANNELS,
    ...NO_FILE_ACTION_CHANNELS
  ]);
  const registeredMutationChannels = [...policies.values()]
    .filter((policy) => policy.taskKind === 'file' || policy.taskKind === 'no-file')
    .map((policy) => policy.channel);
  if (classifiedChannels.size !== FILE_ACTION_CHANNELS.length + NO_FILE_ACTION_CHANNELS.length
      || registeredMutationChannels.length !== classifiedChannels.size
      || registeredMutationChannels.some((channel) => !classifiedChannels.has(channel))) {
    throw new TypeError('mutation action 的 file/no-file literal inventory 未精确闭合');
  }
  return policies;
}

class TaskPolicyRegistry {
  constructor(policies = buildPolicies()) {
    this.policies = new Map(policies);
  }

  get(channel) {
    return this.policies.get(String(channel || '')) || null;
  }

  require(channel) {
    const policy = this.get(channel);
    if (!policy) throw new Error(`未登记 task policy：${String(channel || '')}`);
    return policy;
  }

  list() {
    return [...this.policies.values()];
  }

  channels(batchPolicy = '') {
    return this.list()
      .filter((policy) => !batchPolicy || policy.batchPolicy === batchPolicy)
      .map((policy) => policy.channel)
      .sort();
  }
}

const ARCHIVE_TASK_POLICIES = buildPolicies();

function createTaskPolicyRegistry() {
  return new TaskPolicyRegistry(ARCHIVE_TASK_POLICIES);
}

module.exports = {
  ARCHIVE_TASK_POLICIES,
  EXCLUDED_CHANNELS_BY_REASON,
  EXCLUDE_REASONS,
  FILE_ACTION_CHANNELS,
  NO_FILE_ACTION_CHANNELS,
  RESERVE_CHANNELS_BY_SCOPE,
  SUPPORT_ACTION_POLICIES,
  TaskPolicyRegistry,
  bankBuImportResultFlowIdentities,
  bankBuRunFlowPlan,
  createBankStatementRunFlowIdentity,
  invocationBusinessRunIdentity,
  positionResultClassifier,
  createTaskPolicyRegistry,
  resultBusinessRunIdentities,
  standardResultMetadataResolver,
  statementResultClassifier,
  standardResultClassifier,
  vccOpSaveRunResultClassifier,
  vccDeleteFlowPlan,
  vccFinancialOpResultClassifier,
  vccImportResultFlowIdentities,
  vccRunFlowIdentity
};
