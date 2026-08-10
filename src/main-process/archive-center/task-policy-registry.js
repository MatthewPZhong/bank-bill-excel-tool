'use strict';

const { resolveArchiveScope } = require('./module-scope-registry');

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

const PR3_HANDOFF_CHANNELS = Object.freeze([
  'toolbox:merge',
  'toolbox:split:export',
  'toolbox:split:read',
  'vccFinancialOp:data-manager:delete',
  'vccFinancialOp:data-manager:delete-preview',
  'vccFinancialOp:data-manager:delete-targets',
  'vccFinancialOp:data-manager:export',
  'vccFinancialOp:data-manager:export-preview',
  'vccFinancialOp:data-manager:overview',
  'vccFinancialOp:export:import-audit',
  'vccFinancialOp:export:result',
  'vccFinancialOp:import:apply',
  'vccFinancialOp:import:pick-files',
  'vccFinancialOp:imports:get-detail',
  'vccFinancialOp:imports:list-months',
  'vccFinancialOp:imports:list-records',
  'vccFinancialOp:imports:resolve',
  'vccFinancialOp:opening:initialize',
  'vccFinancialOp:run:adjustment-add',
  'vccFinancialOp:run:adjustment-options',
  'vccFinancialOp:run:archive',
  'vccFinancialOp:run:archived-months',
  'vccFinancialOp:run:calculate',
  'vccFinancialOp:run:get',
  'vccFinancialOp:run:latest-archived',
  'vccFinancialOp:run:preflight',
  'vccFinancialOp:run:unarchive',
  'vccFinancialOp:run:unarchive-preview',
  'vccFinancialOp:task:cancel'
]);

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
    'template:save-mappings',
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
  ])
});

const EXCLUDED_CHANNELS_BY_REASON = Object.freeze({
  'read-only-query': Object.freeze([
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
    'vccOpCalc:balance:list-months'
  ]),
  'file-picker-only': Object.freeze([
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
    'vccOpCalc:import:pick-files'
  ]),
  'staging-preflight-only': Object.freeze([
    'position-reconciliation:bank:prepare-import'
  ]),
  'preview-only': Object.freeze([
    'file:extract-big-account-order',
    'template:preview-delete-bill-split-row'
  ]),
  'cancel-active-task': Object.freeze([
    'acquiringBillCurrency:run:cancel',
    'file:cancel-big-account-selection',
    'position-reconciliation:bank:cancel-import',
    'position-reconciliation:import:cancel',
    'position-reconciliation:source:cancel-import'
  ]),
  'archive-center-maintenance': Object.freeze([
    'archive-center:delete-batch',
    'archive-center:open-file',
    'archive-center:retry-batch',
    'archive-center:save-as',
    'archive-center:select-retry-sources',
    'archive-center:set-locked',
    'archive-center:set-retention-days'
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
  return [{
    type: 'business-run-id',
    value: `acquiring-run:${source}:${monthKey}:${runId}`
  }];
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
  return standardResultClassifier;
}

function createReservePolicy(channel, scopeKey) {
  const scope = resolveArchiveScope(scopeKey);
  if (!scope) throw new Error(`未知 archive scope：${scopeKey}`);
  const isBankBuImport = channel === 'bankBuRecon:import:run';
  const isBankBuRun = channel === 'bankBuRecon:run';
  const isAcquiringRun = channel === 'acquiringBillCurrency:run';
  const isAcquiringResume = channel === 'acquiringBillCurrency:run:resume';
  return Object.freeze({
    channel,
    scopeId: scope.id,
    moduleCode: scope.storageCode,
    moduleName: scope.name,
    taskKey: channel,
    batchPolicy: 'reserve',
    startsNewFlow: !CONTINUATION_CHANNELS.has(channel),
    flowIdentityResolver: CONTINUATION_CHANNELS.has(channel)
      ? invocationBusinessRunIdentity
      : null,
    flowPlanResolver: isBankBuRun ? bankBuRunFlowPlan : null,
    resultClassifier: resultClassifierForChannel(channel),
    resultMetadataResolver: standardResultMetadataResolver,
    resultFlowIdentities: isBankBuImport
      ? bankBuImportResultFlowIdentities
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
  return Object.freeze({ channel, batchPolicy: 'exclude', excludeReason });
}

function buildPolicies() {
  const policies = new Map();
  const add = (policy) => {
    if (policies.has(policy.channel)) throw new Error(`Task policy 重复：${policy.channel}`);
    if (PR3_HANDOFF_CHANNELS.includes(policy.channel)) {
      throw new Error(`PR3 handoff 不得在 PR2 注册：${policy.channel}`);
    }
    policies.set(policy.channel, policy);
  };
  for (const [scopeKey, channels] of Object.entries(RESERVE_CHANNELS_BY_SCOPE)) {
    for (const channel of channels) add(createReservePolicy(channel, scopeKey));
  }
  for (const [reason, channels] of Object.entries(EXCLUDED_CHANNELS_BY_REASON)) {
    for (const channel of channels) add(createExcludePolicy(channel, reason));
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
  PR3_HANDOFF_CHANNELS,
  RESERVE_CHANNELS_BY_SCOPE,
  SUPPORT_ACTION_POLICIES,
  TaskPolicyRegistry,
  bankBuImportResultFlowIdentities,
  bankBuRunFlowPlan,
  invocationBusinessRunIdentity,
  positionResultClassifier,
  createTaskPolicyRegistry,
  resultBusinessRunIdentities,
  standardResultMetadataResolver,
  statementResultClassifier,
  standardResultClassifier
};
