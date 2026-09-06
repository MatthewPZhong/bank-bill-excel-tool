'use strict';

const { ACTIONS, hash, snapshot } = require('./contracts');
// 只由已评审的发布提交填写。renderer、环境变量、版本号均不能提供或覆盖此证据。
const RELEASE_GATES = snapshot({ schemaVersion: 1, version: '3.2.7', enabled: false,
  windowsDurability: null, targetScale: null, fundsAcceptance: null, workbookAcceptance: null,
  legacyQuiescence: null, actions: {} });
const REQUIRED_GATES = Object.freeze(['windowsDurability', 'targetScale', 'fundsAcceptance', 'workbookAcceptance', 'legacyQuiescence']);
function evidence(value) { return value && value.status === 'PASS' && typeof value.reference === 'string' && value.reference.trim().length >= 8; }
function evaluateReleaseGates(value = RELEASE_GATES) {
  const missing = REQUIRED_GATES.filter((key) => !evidence(value?.[key]));
  for (const key of Object.keys(ACTIONS)) if (!evidence(value?.actions?.[key])) missing.push(key);
  if (value?.schemaVersion !== 1 || value?.version !== '3.2.7' || value?.enabled !== true) missing.unshift('release-enabled');
  return snapshot({ ready: missing.length === 0, missing, digest: hash(value || {}) });
}
module.exports = { RELEASE_GATES, REQUIRED_GATES, evaluateReleaseGates };
