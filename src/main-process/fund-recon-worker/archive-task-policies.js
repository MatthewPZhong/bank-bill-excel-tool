'use strict';

const { randomUUID } = require('node:crypto');
const {
  createBaseTaskPolicy
} = require('../archive-center/task-policy-common');

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

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('bank-statement:batch-import', 'FUNDRECON'),
  createBaseTaskPolicy('bank-statement:export', 'FUNDRECON', {
    startsNewFlow: false,
    flowPlanResolver: bankStatementExportFlowPlan,
    resultFlowIdentities: bankStatementExportResultFlowIdentities
  }),
  createBaseTaskPolicy('bank-statement:import', 'FUNDRECON'),
  createBaseTaskPolicy('bank-statement:run', 'FUNDRECON'),
  createBaseTaskPolicy('channels:create', 'FUNDRECON'),
  createBaseTaskPolicy('channels:delete', 'FUNDRECON'),
  createBaseTaskPolicy('channels:update', 'FUNDRECON'),
  createBaseTaskPolicy('fund-transfer-account-mapping:save', 'FUNDRECON'),
  createBaseTaskPolicy('gateway-recon:import', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:batch-delete', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:create', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:delete', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:export-bundle', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:import-bundle-apply', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:set-applicable-channels', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:toggle-enabled', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:transfer', 'FUNDRECON'),
  createBaseTaskPolicy('scenarios:update', 'FUNDRECON')
]);

module.exports = {
  archivePolicies,
  bankStatementFlowIdentity,
  createBankStatementRunFlowIdentity,
  bankStatementExportFlowPlan,
  bankStatementExportResultFlowIdentities
};
