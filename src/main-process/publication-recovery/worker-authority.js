'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const authorities = new WeakMap();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function recoveryError(code, root, message, paths = []) {
  const error = new Error(message || code);
  error.code = code;
  error.preserveTemporaryFiles = true;
  error.recoveryPaths = [...new Set([
    ...(root ? [path.join(path.resolve(root), 'toolbox-publish-journal-index.json')] : []),
    ...paths
  ])];
  return error;
}
// 仅 dispatcher/worker 和测试 authority 装配使用；业务调用方不持有此能力。
function createWorkerAuthority(key) {
  if (typeof key !== 'string' || key.length < 32) throw new TypeError('publication worker authority key required');
  const authority = Object.freeze({});
  authorities.set(authority, { key, consumed: new Set() });
  return authority;
}
function seal(key, kind, value) {
  return { kind, value, signature: crypto.createHmac('sha256', key).update(canonical({ kind, value })).digest('hex') };
}
function verify(authority, envelope, kind, root, once = false) {
  const state = authorities.get(authority);
  if (!state || !envelope) {
    throw recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', root, '发布恢复缺少受信任 authority，恢复材料已保留');
  }
  const expected = seal(state.key, kind, envelope.value);
  if (envelope.kind !== kind || envelope.signature !== expected.signature) {
    throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '发布恢复授权不匹配，恢复材料已保留');
  }
  if (once) {
    if (state.consumed.has(envelope.signature)) {
      throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '发布预检证明已消费');
    }
    state.consumed.add(envelope.signature);
  }
  return envelope.value;
}
module.exports = { canonical, digest, recoveryError, createWorkerAuthority, seal, verify };
