'use strict';

const { ACTIONS, hash, snapshot } = require('./contracts');
const REQUIRED_GATES = Object.freeze(['windowsDurability', 'targetScale', 'fundsAcceptance', 'workbookAcceptance', 'legacyQuiescence']);
// Main 受版本控制的显式授权；不能由 renderer、环境变量或版本号提供。
// 用户要求全部开启不等于验收 PASS，实际资源、关闭与升级保护仍独立执行。
const authorization = { status: 'USER_AUTHORIZED', reference: 'v327-enable-20260906',
  approvedBy: 'pzhong', approvedAt: '2026-09-06', validationStatus: 'NOT_RUN',
  reason: '用户明确要求业务 OP 新版全部开启；未完成验收见 changes/v3.2.7/enablement/spec.md' };
// 固定本次授权集合；新增 action 必须另行提供证据，不能自动继承本次授权。
const authorizedActions = [
  'biz-op-v327:import-candidate', 'biz-op-v327:run-candidate', 'biz-op-v327:delete-plan',
  'biz-op-v327:upgrade-preflight', 'biz-op-v327:reclaim', 'biz-op-v327:export-op-raw',
  'biz-op-v327:export-flow-raw', 'biz-op-v327:export-op-check', 'biz-op-v327:export-flow-check',
  'biz-op-v327:export-result-full', 'biz-op-v327:export-result-diff', 'biz-op-v327:export-errors'
];
const RELEASE_GATES = snapshot({ schemaVersion: 1, version: '3.2.7', enabled: true,
  windowsDurability: authorization, targetScale: authorization, fundsAcceptance: authorization,
  workbookAcceptance: authorization, legacyQuiescence: authorization,
  actions: Object.fromEntries(authorizedActions.map((key) => [key, authorization])) });
function evidence(value) {
  if (!value || typeof value.reference !== 'string' || value.reference.trim().length < 8) return false;
  if (value.status === 'PASS') return true;
  return value.status === 'USER_AUTHORIZED' && value.validationStatus === 'NOT_RUN'
    && typeof value.approvedBy === 'string' && value.approvedBy.trim().length > 0
    && typeof value.approvedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.approvedAt)
    && Number.isFinite(Date.parse(value.approvedAt))
    && new Date(value.approvedAt).toISOString().slice(0, 10) === value.approvedAt
    && typeof value.reason === 'string' && value.reason.trim().length >= 8;
}
function evaluateReleaseGates(value = RELEASE_GATES) {
  const missing = REQUIRED_GATES.filter((key) => !evidence(value?.[key]));
  for (const key of Object.keys(ACTIONS)) if (!evidence(value?.actions?.[key])) missing.push(key);
  if (value?.schemaVersion !== 1 || value?.version !== '3.2.7' || value?.enabled !== true) missing.unshift('release-enabled');
  const authorizationUsed = [...REQUIRED_GATES.map((key) => value?.[key]), ...Object.keys(ACTIONS).map((key) => value?.actions?.[key])]
    .some((item) => evidence(item) && item.status === 'USER_AUTHORIZED');
  return snapshot({ ready: missing.length === 0, missing, authorizationUsed, digest: hash(value || {}) });
}
module.exports = { RELEASE_GATES, REQUIRED_GATES, evaluateReleaseGates };
