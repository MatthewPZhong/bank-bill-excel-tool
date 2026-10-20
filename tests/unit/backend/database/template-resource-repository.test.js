'use strict';

// 设置 → 模板文件用户版本仓储：建表幂等、提交/切换/删除的事务边界与冲突回滚。
const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { ensureTemplateResourceVersionSupport } = require('../../../../src/backend/database/migrations');
const repo = require('../../../../src/backend/database/template-resource-repository');

const SHA = 'a'.repeat(64);
const plain = (rows) => rows.map((row) => ({ ...row }));

function setup() {
  const db = new DatabaseSync(':memory:');
  ensureTemplateResourceVersionSupport(db);
  ensureTemplateResourceVersionSupport(db);
  return db;
}

function version(versionNo, sha = SHA) {
  return {
    versionId: `v${versionNo}`,
    versionNo,
    fileName: `模板-${versionNo}.xlsx`,
    sizeBytes: 100 + versionNo,
    sha256: sha,
    validation: 'passed',
    structure: { sheets: [{ name: 'Sheet1', headers: ['A'] }] },
    appVersion: '9.9.9',
    createdAt: `2026-10-19T0${versionNo}:00:00.000Z`
  };
}

const change = (action, fromLabel, toLabel) => ({
  createdAt: '2026-10-19T10:00:00.000Z', resourceId: 'fund-type-enum', action, fromLabel, toLabel, result: 'success', appVersion: '9.9.9'
});

test('建表幂等；无状态行时当前为内置 v1', () => {
  const db = setup();
  assert.deepEqual(repo.listVersions(db), []);
  assert.deepEqual(repo.listStates(db), []);
  assert.deepEqual(repo.listChanges(db), []);
});

test('提交、切换与删除在同一事务内更新版本、指针与变更记录', () => {
  const db = setup();
  assert.deepEqual(
    repo.commitVersion(db, { resourceId: 'fund-type-enum', version: version(2), enable: true, expectedVersionId: 'v1', change: change('导入并启用', 'V1', 'V2'), now: 'n1' }),
    { status: 'success', previousVersionId: 'v1' }
  );
  assert.deepEqual(repo.listVersions(db).map((row) => [row.versionId, row.structure.sheets[0].name]), [['v2', 'Sheet1']]);
  assert.deepEqual(plain(repo.listStates(db)).map(({ updatedAt, ...row }) => row), [
    { resourceId: 'fund-type-enum', currentVersionId: 'v2', nextVersionNo: 3 }
  ]);

  assert.equal(repo.commitVersion(db, { resourceId: 'fund-type-enum', version: version(3, 'b'.repeat(64)), enable: false, expectedVersionId: 'v2', change: change('导入', '', 'V3'), now: 'n2' }).status, 'success');
  assert.equal(repo.listStates(db)[0].currentVersionId, 'v2');
  assert.deepEqual(repo.setCurrentVersion(db, { resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v2', change: change('恢复默认', 'V2', 'V1'), now: 'n3' }),
    { status: 'success', previousVersionId: 'v2' });
  assert.deepEqual(repo.setCurrentVersion(db, { resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v1', change: change('恢复默认', 'V1', 'V1'), now: 'n4' }),
    { status: 'success', unchanged: true });
  assert.deepEqual(repo.deleteVersion(db, { resourceId: 'fund-type-enum', versionId: 'v2', change: change('删除版本', 'V2', '') }), { status: 'success' });
  assert.deepEqual(repo.listChanges(db).map((row) => row.action), ['删除版本', '恢复默认', '导入', '导入并启用']);
  assert.equal(repo.listStates(db)[0].nextVersionNo, 4, '删除后版本号不回退');
});

test('冲突与非法操作整体回滚，不留下版本行或变更记录', () => {
  const db = setup();
  repo.commitVersion(db, { resourceId: 'fund-type-enum', version: version(2), enable: true, expectedVersionId: 'v1', change: change('导入并启用', 'V1', 'V2'), now: 'n1' });
  assert.deepEqual(
    repo.commitVersion(db, { resourceId: 'fund-type-enum', version: version(3, 'c'.repeat(64)), enable: true, expectedVersionId: 'v1', change: change('导入并启用', 'V1', 'V3'), now: 'n2' }),
    { status: 'conflict', currentVersionId: 'v2' }
  );
  assert.deepEqual(
    repo.commitVersion(db, { resourceId: 'fund-type-enum', version: version(4, 'c'.repeat(64)), enable: false, expectedVersionId: 'v2', change: change('导入', '', 'V4'), now: 'n2' }),
    { status: 'conflict', currentVersionId: 'v2' }, '版本号与 next_version_no 不一致'
  );
  assert.deepEqual(repo.setCurrentVersion(db, { resourceId: 'fund-type-enum', versionId: 'v9', change: change('启用', 'V2', 'V9'), now: 'n3' }), { status: 'missing' });
  assert.deepEqual(repo.deleteVersion(db, { resourceId: 'fund-type-enum', versionId: 'v2', change: change('删除版本', 'V2', '') }), { status: 'current' });
  assert.deepEqual(repo.deleteVersion(db, { resourceId: 'fund-type-enum', versionId: 'v1', change: change('删除版本', 'V1', '') }), { status: 'builtin' });
  assert.deepEqual(repo.listVersions(db).map((row) => row.versionId), ['v2']);
  assert.deepEqual(repo.listChanges(db).map((row) => row.action), ['导入并启用']);
  assert.throws(() => repo.commitVersion(db, {
    resourceId: 'fund-type-enum', version: { ...version(3), sha256: 'not-a-sha' }, enable: false, expectedVersionId: 'v2', change: change('导入', '', 'V3'), now: 'n4'
  }), /CHECK constraint failed/);
  assert.equal(repo.listStates(db)[0].nextVersionNo, 3, 'CHECK 失败时状态回滚');
});
