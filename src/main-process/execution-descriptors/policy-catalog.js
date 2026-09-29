'use strict';

// 纯 policy 清单：不能 import descriptor 工厂或初始化 Main authority。
const { BIZ_OP_V327_POLICIES } = require('../biz-op-v327/policies');
const { TOOLBOX_GENERATION_POLICIES } = require('../toolbox-background/policies');
const { ROWS_POLICY } = require('../toolbox-row-split/policy');
const { PRE_FUND_MPT_POLICIES } = require('../pre-fund-reconciliation/mpt-import/policies');
const { NEW_ACCOUNT_GENERATION_POLICY, NEW_ACCOUNT_SAVE_AS_POLICY } = require('../new-account/policies');
const { FUND_RECON_POLICIES } = require('../fund-recon-worker/policies');
const { DUPLICATE_POLICIES } = require('../duplicate-inbound-match/policies');
const { RECON_FIX_POLICIES } = require('../recon-id-fix-service/policies');
const { VCC_EXPORT_SINGLE_POLICY, VCC_EXPORT_SUBJECTS_POLICY } = require('../vcc-financial-op-output/policies');
const { PENDING_READ_ONLY_POLICIES } = require('../read-only-exports/pending/policies');
const { BIZ_OP_READ_ONLY_POLICIES } = require('../read-only-exports/biz-op/policies');
const { PRE_FUND_READ_ONLY_POLICIES } = require('../read-only-exports/pre-fund/policies');
const { POSITION_READ_ONLY_POLICY } = require('../read-only-exports/position/policies');
const { VCC_FINANCIAL_OP_READ_ONLY_POLICY } = require('../read-only-exports/vcc-financial-op/policies');
const { ACQUIRING_EXPORT_POLICIES } = require('../read-only-exports/acquiring/policies');
const { PENDING_BIZOP_ADAPTER_POLICIES } = require('../background-execution/pending-bizop-adapter-policies');
const { ACQUIRING_ADAPTER_POLICIES } = require('../background-execution/acquiring-adapter-policies');
const { POSITION_IMPORT_ADAPTER_POLICY } = require('../background-execution/position-import-adapter-policy');

const BACKGROUND_EXECUTION_POLICIES = Object.freeze([
  ...BIZ_OP_V327_POLICIES, ...TOOLBOX_GENERATION_POLICIES, ROWS_POLICY,
  ...PRE_FUND_MPT_POLICIES, NEW_ACCOUNT_GENERATION_POLICY, NEW_ACCOUNT_SAVE_AS_POLICY,
  ...FUND_RECON_POLICIES, ...DUPLICATE_POLICIES, ...RECON_FIX_POLICIES,
  VCC_EXPORT_SINGLE_POLICY, VCC_EXPORT_SUBJECTS_POLICY,
  ...PENDING_READ_ONLY_POLICIES, ...BIZ_OP_READ_ONLY_POLICIES, ...PRE_FUND_READ_ONLY_POLICIES,
  POSITION_READ_ONLY_POLICY, VCC_FINANCIAL_OP_READ_ONLY_POLICY, ...ACQUIRING_EXPORT_POLICIES,
  ...PENDING_BIZOP_ADAPTER_POLICIES, ...ACQUIRING_ADAPTER_POLICIES, POSITION_IMPORT_ADAPTER_POLICY
]);

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = BACKGROUND_EXECUTION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

module.exports = { BACKGROUND_EXECUTION_POLICIES, isBackgroundExecutionProductionEnabled };
