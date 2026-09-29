'use strict';

const { types: { isProxy } } = require('node:util');
const { TASK_FILE_PLAN_DEFINITIONS } = require('./task-file-plan-registry');
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

const SUPPORT_ACTION_POLICIES = Object.freeze([
  Object.freeze({
    channel: 'vccFinancialOp:export:review',
    kind: 'support-action',
    reason: 'user-document-export'
  }),
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
    'bizOpReconV327:metadata:run-calendar',
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
    'archive-center:list-delete-cleanup-jobs',
    'archive-center:prepare-delete-batch',
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
    'archive-center:retry-delete-cleanup-job',
    'archive-center:save-as',
    'archive-center:select-retry-sources',
    'archive-center:set-locked',
    'archive-center:set-retention-days',
    'archive-center:set-module-retention-days',
    'archive-center:start-entry-maintenance'
  ]),
  'ui-navigation': Object.freeze([
    'app-update:check-now',
    'app-update:restart-and-install',
    'app-update:set-enabled',
    'background:reset',
    'background:save',
    'settings:set-current-module',
    'settings:set-dark-mode-schedule',
    'settings:set-enabled-modules',
    'settings:set-recon-id-fix-bill-category',
    'window:close',
    'window:minimize',
    'window:toggle-maximize'
  ])
});


const RECOVERABLE_POLICY_KEYS = Object.freeze([
  'channel', 'scopeId', 'moduleCode', 'moduleName', 'taskKey', 'batchPolicy',
  'taskKind', 'allocation', 'filePlanSourceKind', 'filePlanResolver',
  'promotionManifestResolver', 'workerContext', 'startsNewFlow',
  'flowIdentityResolver', 'flowPlanResolver', 'resultClassifier',
  'bindResultFlowIdentitiesOnFailure', 'resultMetadataResolver', 'resultFlowIdentities'
].sort());
const EXCLUDE_POLICY_KEYS = Object.freeze([
  'channel', 'batchPolicy', 'taskKind', 'workerContext', 'excludeReason'
].sort());

// 独立 inventory 只审核显式注入的注册项，不装配或选择任何领域 hook。
function validatePolicies(policies) {
  if (!Array.isArray(policies) || isProxy(policies)) {
    throw new TypeError('TaskPolicyRegistry 必须显式传入 policy 数组');
  }
  const expectedKinds = new Map([
    ...FILE_ACTION_CHANNELS.map((channel) => [channel, 'file']),
    ...NO_FILE_ACTION_CHANNELS.map((channel) => [channel, 'no-file'])
  ]);
  const excludedReasons = new Map(Object.entries(EXCLUDED_CHANNELS_BY_REASON)
    .flatMap(([reason, channels]) => channels.map((channel) => [channel, reason])));
  const expectedScopes = new Map(Object.entries(RESERVE_CHANNELS_BY_SCOPE)
    .flatMap(([scopeKey, channels]) => channels.map((channel) => [channel, resolveArchiveScope(scopeKey)])));
  const byChannel = new Map();
  for (const policy of policies) {
    if (!policy || typeof policy !== 'object' || isProxy(policy)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(policy))) {
      throw new TypeError('TaskPolicy 必须是非 Proxy plain data object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(policy);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
        || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
      throw new TypeError('TaskPolicy 必须只包含 enumerable own data property');
    }
    const snapshot = Object.fromEntries(Object.entries(descriptors)
      .map(([key, descriptor]) => [key, descriptor.value]));
    if (typeof snapshot.channel !== 'string' || byChannel.has(snapshot.channel)) {
      throw new TypeError('TaskPolicy channel 缺失或重复：' + String(snapshot.channel));
    }
    const expectedKind = expectedKinds.get(snapshot.channel);
    const expectedKeys = expectedKind ? RECOVERABLE_POLICY_KEYS : EXCLUDE_POLICY_KEYS;
    const actualKeys = Object.keys(snapshot).sort();
    if (actualKeys.length !== expectedKeys.length
        || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new TypeError('TaskPolicy exact key inventory 漂移：' + snapshot.channel);
    }
    if (expectedKind) {
      if (snapshot.taskKind !== expectedKind || snapshot.taskKey !== snapshot.channel
          || snapshot.batchPolicy !== (expectedKind === 'file' ? 'reserve' : 'no-file')) {
        throw new TypeError('TaskPolicy file/no-file 身份漂移：' + snapshot.channel);
      }
      const scope = expectedScopes.get(snapshot.channel);
      if (!scope || snapshot.scopeId !== scope.id || snapshot.moduleCode !== scope.storageCode
          || snapshot.moduleName !== scope.name
          || typeof snapshot.startsNewFlow !== 'boolean'
          || typeof snapshot.bindResultFlowIdentitiesOnFailure !== 'boolean'
          || !['none', 'batch', 'operation'].includes(snapshot.workerContext)
          || ['resultClassifier', 'resultMetadataResolver', 'resultFlowIdentities']
            .some((key) => typeof snapshot[key] !== 'function')
          || ['flowIdentityResolver', 'flowPlanResolver']
            .some((key) => snapshot[key] !== null && typeof snapshot[key] !== 'function')) {
        throw new TypeError('TaskPolicy module 或 lifecycle hook 非法：' + snapshot.channel);
      }
      const definition = TASK_FILE_PLAN_DEFINITIONS[snapshot.channel];
      if (definition
        ? snapshot.allocation !== definition.allocation
          || snapshot.filePlanSourceKind !== definition.sourceKind
          || snapshot.workerContext !== definition.workerContext
          || typeof snapshot.filePlanResolver !== 'function'
          || (definition.promotionManifestResolver === null
            ? snapshot.promotionManifestResolver !== null
            : typeof snapshot.promotionManifestResolver !== 'function')
        : snapshot.allocation !== 'none' || snapshot.filePlanSourceKind !== null
          || snapshot.filePlanResolver !== null || snapshot.promotionManifestResolver !== null) {
        throw new TypeError('TaskPolicy FilePlan 注册非法：' + snapshot.channel);
      }
    } else if (!excludedReasons.has(snapshot.channel)
        || snapshot.taskKind !== 'exclude' || snapshot.batchPolicy !== 'exclude'
        || snapshot.workerContext !== 'none'
        || snapshot.excludeReason !== excludedReasons.get(snapshot.channel)) {
      throw new TypeError('TaskPolicy 未登记或 exclude 分类漂移：' + snapshot.channel);
    }
    byChannel.set(snapshot.channel, Object.freeze(snapshot));
  }
  const expectedChannels = [...expectedKinds.keys(), ...excludedReasons.keys()];
  if (byChannel.size !== expectedChannels.length
      || expectedChannels.some((channel) => !byChannel.has(channel))) {
    throw new TypeError('TaskPolicy file/no-file/exclude literal inventory 未精确闭合');
  }
  return byChannel;
}

class TaskPolicyRegistry {
  #policies;

  constructor(policies) {
    this.#policies = validatePolicies(policies);
    Object.freeze(this);
  }

  get(channel) {
    return this.#policies.get(String(channel || '')) || null;
  }

  require(channel) {
    const policy = this.get(channel);
    if (!policy) throw new Error('未登记 task policy：' + String(channel || ''));
    return policy;
  }

  list() {
    return [...this.#policies.values()];
  }

  channels(batchPolicy = '') {
    return this.list()
      .filter((policy) => !batchPolicy || policy.batchPolicy === batchPolicy)
      .map((policy) => policy.channel)
      .sort();
  }
}

function createTaskPolicyRegistry(policies) {
  return new TaskPolicyRegistry(policies);
}

module.exports = {
  EXCLUDED_CHANNELS_BY_REASON,
  EXCLUDE_REASONS,
  FILE_ACTION_CHANNELS,
  NO_FILE_ACTION_CHANNELS,
  RESERVE_CHANNELS_BY_SCOPE,
  SUPPORT_ACTION_POLICIES,
  TaskPolicyRegistry,
  createTaskPolicyRegistry
};
