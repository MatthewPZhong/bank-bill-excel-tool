'use strict';

const { createHash } = require('node:crypto');

function requireIdentityText(value, label) {
  const textValue = value == null ? '' : String(value).trim();
  if (!textValue) throw new TypeError(`PreFund MPT ${label}不能为空`);
  return textValue;
}

function canonicalMptBatchIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('PreFund MPT batch identity必须是对象');
  }
  return JSON.stringify([
    requireIdentityText(identity.sourceType, 'sourceType'),
    requireIdentityText(identity.sourceBatch, 'sourceBatch')
  ]);
}

function derivePreFundMptConflictScopeKey(identity) {
  const digest = createHash('sha256')
    .update(canonicalMptBatchIdentity(identity), 'utf8')
    .digest('hex');
  return `pre-fund:mpt-batch:${digest}`;
}

function isPreFundMptConflictScopeKey(value) {
  return typeof value === 'string' && /^pre-fund:mpt-batch:[a-f0-9]{64}$/.test(value);
}

module.exports = {
  canonicalMptBatchIdentity,
  derivePreFundMptConflictScopeKey,
  isPreFundMptConflictScopeKey
};
