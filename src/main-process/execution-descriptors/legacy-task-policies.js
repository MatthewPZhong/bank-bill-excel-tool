'use strict';

const {
  createBaseTaskPolicy,
  createExcludePolicy,
  classifyKnownStatus,
  standardResultClassifier
} = require('../archive-center/task-policy-common');

function statementResultClassifier(result) {
  // 大账号选择、记住顺序不匹配与导出范围选择均已在 prepare 阶段以
  // proceed:false 返回，不能再被 execute 分类器静默接受为成功批次。
  return classifyKnownStatus(result, ['manual-balance-required']);
}

function vccOpSaveRunResultClassifier(result) {
  // E03-B unknown 已由 Main exact owner seam 先 CAS 为 interrupted；这里仍分类为
  // failure，使 TaskLifecycle 的通用 terminal 路径执行并以状态冲突保留 interrupted。
  if (String(result && result.status || '').trim().toLowerCase() === 'recovery-required') {
    return 'failed';
  }
  return standardResultClassifier(result);
}

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('account-mapping:distribute-migration', 'STATEMENT'),
  createBaseTaskPolicy('account-mapping:save', 'STATEMENT'),
  createBaseTaskPolicy('balance-adjustment:save', 'STATEMENT'),
  createBaseTaskPolicy('big-account:import-bank-info', 'STATEMENT'),
  createBaseTaskPolicy('big-account:save-own-accounts', 'STATEMENT'),
  createBaseTaskPolicy('file:complete-big-account-selection', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('file:export-balance', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('file:export-detail', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('file:import', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('file:save-balance-seed', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('monthly-balance:assemble', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('monthly-balance:export', 'STATEMENT', {
    resultClassifier: statementResultClassifier
  }),
  createBaseTaskPolicy('template:save-mappings', 'STATEMENT'),
  createBaseTaskPolicy('template:clear-bill-split-merge-groups', 'STATEMENT'),
  createBaseTaskPolicy('template:delete', 'STATEMENT'),
  createBaseTaskPolicy('template:delete-bill-split-row', 'STATEMENT'),
  createBaseTaskPolicy('template:export-bundle', 'STATEMENT'),
  createBaseTaskPolicy('template:import', 'STATEMENT'),
  createBaseTaskPolicy('template:import-bundle', 'STATEMENT'),
  createBaseTaskPolicy('template:rename', 'STATEMENT'),
  createBaseTaskPolicy('template:save-amount-split-rules', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-amount-rules', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-mappings', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-merge-group', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-meta', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-row', 'STATEMENT'),
  createBaseTaskPolicy('template:save-bill-split-row-count', 'STATEMENT'),
  createBaseTaskPolicy('template:save-filename-fixed-field', 'STATEMENT'),
  createBaseTaskPolicy('template:set-child-parent', 'STATEMENT'),
  createBaseTaskPolicy('template:set-parent-status', 'STATEMENT'),
  createBaseTaskPolicy('linked-table:delete-by-date-range', 'LINKED'),
  createBaseTaskPolicy('linked-table:import', 'LINKED'),
  createBaseTaskPolicy('vccOpCalc:import:scan', 'VCCOP'),
  createBaseTaskPolicy('vccOpCalc:run:compute-amounts', 'VCCOP', {
    workerContext: 'operation'
  }),
  createBaseTaskPolicy('vccOpCalc:run:save', 'VCCOP', {
    workerContext: 'operation',
    resultClassifier: vccOpSaveRunResultClassifier
  }),
  createExcludePolicy('account-mapping:check-migration-pending', 'read-only-query'),
  createExcludePolicy('account-mapping:get-migration-data', 'read-only-query'),
  createExcludePolicy('account-mapping:list', 'read-only-query'),
  createExcludePolicy('app-update:get-status', 'read-only-query'),
  createExcludePolicy('app:get-info', 'read-only-query'),
  // v3.2.15：网银账单渠道只读查询
  createExcludePolicy('channel:list', 'read-only-query'),
  createExcludePolicy('channel-account-mapping:list-conflicts', 'read-only-query'),
  createExcludePolicy('archive-center:get-batch', 'read-only-query'),
  createExcludePolicy('archive-center:get-settings', 'read-only-query'),
  createExcludePolicy('archive-center:get-stats', 'read-only-query'),
  createExcludePolicy('archive-center:list-batches', 'read-only-query'),
  createExcludePolicy('archive-center:list-delete-cleanup-jobs', 'read-only-query'),
  createExcludePolicy('archive-center:prepare-delete-batch', 'read-only-query'),
  createExcludePolicy('balance-adjustment:list', 'read-only-query'),
  createExcludePolicy('balance-seed:list', 'read-only-query'),
  createExcludePolicy('bank-statement:c3-candidate-count', 'read-only-query'),
  createExcludePolicy('bank-statement:refund-candidate-count', 'read-only-query'),
  createExcludePolicy('bank-statement:session-status', 'read-only-query'),
  createExcludePolicy('big-account:get-with-own', 'read-only-query'),
  createExcludePolicy('channels:list', 'read-only-query'),
  createExcludePolicy('duplicate-inbound-match:session-status', 'read-only-query'),
  createExcludePolicy('fund-transfer-account-mapping:list', 'read-only-query'),
  createExcludePolicy('linked-table:count-by-date-range', 'read-only-query'),
  createExcludePolicy('linked-table:get-retention-settings', 'read-only-query'),
  createExcludePolicy('linked-table:list', 'read-only-query'),
  createExcludePolicy('linked-table:row-count', 'read-only-query'),
  createExcludePolicy('position-reconciliation:data-manager', 'read-only-query'),
  createExcludePolicy('position-reconciliation:linked-manager', 'read-only-query'),
  createExcludePolicy('position-reconciliation:mappings:list', 'read-only-query'),
  createExcludePolicy('position-reconciliation:status', 'read-only-query'),
  createExcludePolicy('pre-fund-reconciliation:session-status', 'read-only-query'),
  createExcludePolicy('pre-fund-reconciliation:temp:count-by-date-range', 'read-only-query'),
  createExcludePolicy('pre-fund-reconciliation:temp:list', 'read-only-query'),
  createExcludePolicy('recon-id-fix:session-status', 'read-only-query'),
  createExcludePolicy('scenarios:fund-type-enum', 'read-only-query'),
  createExcludePolicy('scenarios:gateway-recon-headers', 'read-only-query'),
  createExcludePolicy('scenarios:get', 'read-only-query'),
  createExcludePolicy('scenarios:get-applicable-channels', 'read-only-query'),
  createExcludePolicy('scenarios:list', 'read-only-query'),
  createExcludePolicy('scenarios:recon-id-fix-fields', 'read-only-query'),
  createExcludePolicy('settings:get-enabled-modules', 'read-only-query'),
  createExcludePolicy('settings:get-ui-style', 'read-only-query'),
  createExcludePolicy('bank-accounts:get-overview', 'read-only-query'),
  createExcludePolicy('bank-accounts:list', 'read-only-query'),
  createExcludePolicy('template-resources:get', 'read-only-query'),
  createExcludePolicy('template-resources:list', 'read-only-query'),
  createExcludePolicy('template-resources:list-changes', 'read-only-query'),
  createExcludePolicy('template:get-amount-split-rules', 'read-only-query'),
  createExcludePolicy('template:get-bill-split-config', 'read-only-query'),
  createExcludePolicy('template:get-mappings', 'read-only-query'),
  createExcludePolicy('template:list', 'read-only-query'),
  createExcludePolicy('template:list-children', 'read-only-query'),
  createExcludePolicy('vccOpCalc:balance:get', 'read-only-query'),
  createExcludePolicy('vccOpCalc:balance:list-months', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:data-manager:delete-targets', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:data-manager:overview', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:imports:list-months', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:imports:list-records', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:run:adjustment-options', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:run:archived-months', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:run:get', 'read-only-query'),
  createExcludePolicy('vccFinancialOp:run:latest-archived', 'read-only-query'),
  createExcludePolicy('background:select-file', 'file-picker-only'),
  createExcludePolicy('scenarios:import-bundle', 'file-picker-only'),
  createExcludePolicy('template-resources:pick-import-file', 'file-picker-only'),
  createExcludePolicy('bank-accounts:pick-import-file', 'file-picker-only'),
  createExcludePolicy('vccOpCalc:import:pick-files', 'file-picker-only'),
  createExcludePolicy('vccFinancialOp:import:pick-files', 'file-picker-only'),
  createExcludePolicy('position-reconciliation:bank:prepare-import', 'staging-preflight-only'),
  createExcludePolicy('template-resources:discard-import', 'staging-preflight-only'),
  createExcludePolicy('template-resources:prepare-import', 'staging-preflight-only'),
  createExcludePolicy('bank-accounts:discard-import', 'staging-preflight-only'),
  createExcludePolicy('bank-accounts:prepare-import', 'staging-preflight-only'),
  // v3.2.17：补录余额「导入余额文件」只读预检，确认后仍走 file:save-balance-seed 写入
  createExcludePolicy('file:import-balance-seed-file', 'staging-preflight-only'),
  // v3.2.18 模板管理【更新】：选择文件并预览字段变更，只读；确认后走 support action template:update-headers
  createExcludePolicy('template:preview-header-update', 'staging-preflight-only'),
  // v3.2.18【导入模板】：选文件并识别为新模板（只读预检）与取消命名时丢弃；确认后仍走 template:import 写入
  createExcludePolicy('template:prepare-import', 'staging-preflight-only'),
  createExcludePolicy('template:discard-import', 'staging-preflight-only'),
  createExcludePolicy('file:extract-big-account-order', 'preview-only'),
  createExcludePolicy('template:preview-delete-bill-split-row', 'preview-only'),
  createExcludePolicy('toolbox:split:read', 'preview-only'),
  createExcludePolicy('toolbox:split:read-values', 'preview-only'),
  createExcludePolicy('toolbox:split:cancel-read', 'cancel-active-task'),
  createExcludePolicy('vccFinancialOp:data-manager:delete-preview', 'preview-only'),
  createExcludePolicy('vccFinancialOp:data-manager:export-preview', 'preview-only'),
  createExcludePolicy('vccFinancialOp:run:preflight', 'preview-only'),
  createExcludePolicy('vccFinancialOp:run:unarchive-preview', 'preview-only'),
  createExcludePolicy('file:cancel-big-account-selection', 'cancel-active-task'),
  createExcludePolicy('position-reconciliation:bank:cancel-import', 'cancel-active-task'),
  createExcludePolicy('position-reconciliation:import:cancel', 'cancel-active-task'),
  createExcludePolicy('position-reconciliation:source:cancel-import', 'cancel-active-task'),
  createExcludePolicy('vccFinancialOp:task:cancel', 'cancel-active-task'),
  createExcludePolicy('archive-center:change-storage-location', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:delete-batch', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:open-file', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:retry-batch', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:retry-delete-cleanup-job', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:save-as', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:select-retry-sources', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:set-locked', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:set-retention-days', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:set-module-retention-days', 'archive-center-maintenance'),
  createExcludePolicy('archive-center:start-entry-maintenance', 'archive-center-maintenance'),
  createExcludePolicy('app-update:check-now', 'ui-navigation'),
  createExcludePolicy('app-update:restart-and-install', 'ui-navigation'),
  createExcludePolicy('app-update:set-enabled', 'ui-navigation'),
  createExcludePolicy('background:reset', 'ui-navigation'),
  createExcludePolicy('background:save', 'ui-navigation'),
  createExcludePolicy('linked-table:set-retention-days', 'ui-navigation'),
  createExcludePolicy('settings:acknowledge-release-notes', 'ui-navigation'),
  createExcludePolicy('settings:set-current-module', 'ui-navigation'),
  createExcludePolicy('settings:set-dark-mode-lightness', 'ui-navigation'),
  createExcludePolicy('settings:set-dark-mode-schedule', 'ui-navigation'),
  createExcludePolicy('settings:set-enabled-modules', 'ui-navigation'),
  createExcludePolicy('settings:set-recon-id-fix-bill-category', 'ui-navigation'),
  createExcludePolicy('window:close', 'ui-navigation'),
  createExcludePolicy('window:minimize', 'ui-navigation'),
  createExcludePolicy('window:toggle-maximize', 'ui-navigation')
]);

module.exports = {
  archivePolicies,
  statementResultClassifier,
  vccOpSaveRunResultClassifier
};
