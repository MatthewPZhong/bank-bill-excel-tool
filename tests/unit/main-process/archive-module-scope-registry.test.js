'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ARCHIVE_SCOPE_ALIASES,
  PRIMARY_ARCHIVE_SCOPES,
  getArchiveScope,
  listVisibleArchiveScopes,
  resolveArchiveScope
} = require('../../../src/main-process/archive-center/module-scope-registry');

test('PR3-VCC 登记 13 个唯一 primary archive scope', () => {
  assert.equal(PRIMARY_ARCHIVE_SCOPES.length, 13);
  assert.equal(new Set(PRIMARY_ARCHIVE_SCOPES.map((scope) => scope.id)).size, 13);
  assert.equal(new Set(PRIMARY_ARCHIVE_SCOPES.map((scope) => scope.code)).size, 13);
  assert.ok(PRIMARY_ARCHIVE_SCOPES.every((scope) => scope.kind === 'primary'));
  assert.deepEqual(getArchiveScope('vcc-financial-op'), {
    id: 'vcc-financial-op',
    code: 'VCCFINOP',
    name: 'VCC财务OP校验',
    kind: 'primary'
  });
  assert.equal(getArchiveScope('VCCOP').id, 'vcc-op-calc');
  assert.equal(getArchiveScope('toolbox'), null);
});

test('内部 alias 解析到 primary，但不增加可见筛选 scope', () => {
  assert.deepEqual(Object.keys(ARCHIVE_SCOPE_ALIASES).sort(), [
    'LINKED',
    'POSITIONLINK',
    'PREFUNDTEMP'
  ]);
  assert.equal(listVisibleArchiveScopes().length, 13);
  assert.equal(resolveArchiveScope('LINKED').id, 'bank-statement-process');
  assert.equal(resolveArchiveScope('LINKED').storageCode, 'LINKED');
  assert.equal(resolveArchiveScope('PREFUNDTEMP').id, 'pre-fund-reconciliation');
  assert.equal(resolveArchiveScope('POSITIONLINK').id, 'position-reconciliation-process');
  assert.ok(!listVisibleArchiveScopes().some((scope) => scope.code === 'LINKED'));
});

test('registry 导出不可被调用方改写', () => {
  const first = PRIMARY_ARCHIVE_SCOPES[0];
  assert.equal(Object.isFrozen(PRIMARY_ARCHIVE_SCOPES), true);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    first.name = 'changed';
  }, TypeError);
  assert.equal(getArchiveScope(first.id).name, '网银账单生成');
});
