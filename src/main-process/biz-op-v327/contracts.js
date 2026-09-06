'use strict';

const { canonicalJsonSnapshot, canonicalSha256 } = require('../background-execution/canonical-json-v1');

const MODULE_ID = 'biz-op-recon';
const CATALOG_SCOPE = 'biz-op-v327:catalog';
// 分期实现共用这一组持久身份，业务启用由 PR6 控制。
const ACTIONS = Object.freeze({
  'biz-op-v327:import-candidate': { taskKey: 'bizOpReconV327:import', kind: 'IMPORT' },
  'biz-op-v327:run-candidate': { taskKey: 'bizOpReconV327:run', kind: 'RUN' },
  'biz-op-v327:delete-plan': { taskKey: 'bizOpReconV327:delete', kind: 'DELETE' },
  'biz-op-v327:upgrade-preflight': { taskKey: 'bizOpReconV327:maintenance:upgrade', kind: 'UPGRADE' },
  'biz-op-v327:reclaim': { taskKey: 'bizOpReconV327:maintenance:reclaim', kind: 'RECLAIM' },
  'biz-op-v327:export-op-raw': { taskKey: 'bizOpReconV327:export:op-raw', kind: 'EXPORT' },
  'biz-op-v327:export-flow-raw': { taskKey: 'bizOpReconV327:export:flow-raw', kind: 'EXPORT' },
  'biz-op-v327:export-op-check': { taskKey: 'bizOpReconV327:export:op-check', kind: 'EXPORT' },
  'biz-op-v327:export-flow-check': { taskKey: 'bizOpReconV327:export:flow-check', kind: 'EXPORT' },
  'biz-op-v327:export-result-full': { taskKey: 'bizOpReconV327:export:result-full', kind: 'EXPORT' },
  'biz-op-v327:export-result-diff': { taskKey: 'bizOpReconV327:export:result-diff', kind: 'EXPORT' },
  'biz-op-v327:export-errors': { taskKey: 'bizOpReconV327:export:errors', kind: 'EXPORT' }
});
Object.values(ACTIONS).forEach(Object.freeze);

function fail(code, message = '业务 OP 状态或证据不满足操作条件') {
  throw Object.assign(new Error(message), { code });
}
function opaque(value, label = '引用') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(value)) {
    fail('BIZOP_REFERENCE_INVALID', `${label}非法`);
  }
  return value;
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('BIZOP_DIGEST_INVALID');
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('BIZOP_COUNT_INVALID');
  return value;
}
function identity(source) {
  return Object.fromEntries(['sourceKind', 'sourceRef', 'actionKey', 'operationKey', 'taskRunId']
    .map((key) => [key, source[key]]));
}
function sameSource(left, right) {
  return Boolean(left && right && Object.keys(identity(left)).every((key) => left[key] === right[key]));
}
function sourceKey(source) { return `${source.sourceKind}\0${source.sourceRef}`; }
function registryKeys(kind) {
  const group = kind === 'EXPORT' ? 'publication' : kind === 'RECLAIM' ? 'reclaim' : 'operation';
  return { inspectorKey: `inspector.biz-op-v327:${group}`, settlementKey: `settlement.biz-op-v327:${group}` };
}
module.exports = { MODULE_ID, CATALOG_SCOPE, ACTIONS, fail, opaque, digest, count, identity,
  sameSource, sourceKey, registryKeys, snapshot: canonicalJsonSnapshot, hash: canonicalSha256 };
