'use strict';

const PRIMARY_ARCHIVE_SCOPES = Object.freeze([
  Object.freeze({ id: 'statement-generator', code: 'STATEMENT', name: '网银账单生成', kind: 'primary' }),
  Object.freeze({ id: 'new-account-generator', code: 'NEWACCOUNT', name: '新开账户余额账单生成', kind: 'primary' }),
  Object.freeze({ id: 'pending-reconciliation', code: 'PENDING', name: '月度Pending数据核对', kind: 'primary' }),
  Object.freeze({ id: 'bank-statement-process', code: 'FUNDRECON', name: '资金对账数据处理', kind: 'primary' }),
  Object.freeze({ id: 'recon-id-fix', code: 'RECONFIX', name: '对账单修复', kind: 'primary' }),
  Object.freeze({ id: 'bank-bu-recon', code: 'BANKBU', name: '月度银行对账单BU回填校验', kind: 'primary' }),
  Object.freeze({ id: 'biz-op-recon', code: 'BIZOP', name: '业务OP数据核对', kind: 'primary' }),
  Object.freeze({ id: 'acquiring-bill-currency', code: 'ACQUIRING', name: '收单单据币种校验', kind: 'primary' }),
  Object.freeze({ id: 'vcc-op-calc', code: 'VCCOP', name: 'VCC业务OP计算', kind: 'primary' }),
  Object.freeze({ id: 'pre-fund-reconciliation', code: 'PREFUND', name: '前置资金对账', kind: 'primary' }),
  Object.freeze({ id: 'duplicate-inbound-match', code: 'DUPINBOUND', name: '重复入金匹配', kind: 'primary' }),
  Object.freeze({ id: 'position-reconciliation-process', code: 'POSITION', name: '平盘对账数据处理', kind: 'primary' })
]);

const ARCHIVE_SCOPE_ALIASES = Object.freeze({
  LINKED: Object.freeze({ scopeId: 'bank-statement-process', code: 'LINKED' }),
  PREFUNDTEMP: Object.freeze({ scopeId: 'pre-fund-reconciliation', code: 'PREFUNDTEMP' }),
  POSITIONLINK: Object.freeze({ scopeId: 'position-reconciliation-process', code: 'POSITIONLINK' })
});

const SCOPE_BY_ID = new Map(PRIMARY_ARCHIVE_SCOPES.map((scope) => [scope.id, scope]));
const SCOPE_BY_CODE = new Map(PRIMARY_ARCHIVE_SCOPES.map((scope) => [scope.code, scope]));

function getArchiveScope(value) {
  const key = String(value || '').trim();
  if (!key) return null;
  const primary = SCOPE_BY_ID.get(key) || SCOPE_BY_CODE.get(key.toUpperCase());
  if (primary) return primary;
  const alias = ARCHIVE_SCOPE_ALIASES[key.toUpperCase()];
  return alias ? SCOPE_BY_ID.get(alias.scopeId) || null : null;
}

function resolveArchiveScope(value) {
  const key = String(value || '').trim();
  const primary = getArchiveScope(key);
  if (!primary) return null;
  const alias = ARCHIVE_SCOPE_ALIASES[key.toUpperCase()] || null;
  return Object.freeze({
    ...primary,
    storageCode: alias ? alias.code : primary.code,
    alias: alias ? alias.code : ''
  });
}

function listVisibleArchiveScopes() {
  return PRIMARY_ARCHIVE_SCOPES.slice();
}

module.exports = {
  ARCHIVE_SCOPE_ALIASES,
  PRIMARY_ARCHIVE_SCOPES,
  getArchiveScope,
  listVisibleArchiveScopes,
  resolveArchiveScope
};
