'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ARCHIVE_MODULE_RETENTION_SETTING_KEY,
  ARCHIVE_RETENTION_SETTING_KEY,
  readRetentionDaysByModule,
  resolveRetentionDays,
  setModuleRetentionDays
} = require('../../../src/main-process/archive-center/retention-policy');
const { listVisibleArchiveScopes } = require('../../../src/main-process/archive-center/module-scope-registry');

function fixture(entries = []) {
  const settings = new Map(entries);
  return {
    settings,
    database: {
      getSetting: (key) => settings.has(key) ? settings.get(key) : null,
      setSetting: (key, value) => settings.set(key, value)
    }
  };
}

test('模块未覆盖时兼容旧默认值，永久与无效设置分别解析', () => {
  for (const [stored, expected] of [
    [undefined, 60], ['', 60], ['30', 30], ['60', 60], ['90', 90],
    ['180', 180], ['365', 365], ['permanent', null], ['45', 60], ['broken', 60]
  ]) {
    const { database } = fixture([[ARCHIVE_RETENTION_SETTING_KEY, stored]]);
    assert.equal(resolveRetentionDays(database, 'statement-generator'), expected);
    assert.equal(resolveRetentionDays(database, 'unknown-historical-module'), expected);
    assert.equal(resolveRetentionDays(database), expected);
  }
  assert.equal(resolveRetentionDays(fixture().database, 'toolbox', 90), 90);
});

test('14 个模块独立覆盖，默认值修改不覆盖已设置模块，inherit 恢复动态继承', () => {
  const { database, settings } = fixture([[ARCHIVE_RETENTION_SETTING_KEY, '90']]);
  const scopes = listVisibleArchiveScopes();
  assert.equal(scopes.length, 14);
  for (const scope of scopes) {
    setModuleRetentionDays(database, { moduleId: scope.id, retentionDays: 30 });
  }
  setModuleRetentionDays(database, { moduleId: 'vcc-financial-op', retentionDays: null });
  settings.set(ARCHIVE_RETENTION_SETTING_KEY, '180');
  assert.equal(resolveRetentionDays(database, 'vcc-financial-op'), null);
  assert.equal(resolveRetentionDays(database, 'toolbox'), 30);
  setModuleRetentionDays(database, { moduleId: 'toolbox', retentionDays: 'inherit' });
  assert.equal(resolveRetentionDays(database, 'toolbox'), 180);
  assert.equal(Object.hasOwn(readRetentionDaysByModule(database), 'toolbox'), false);
  assert.equal(settings.get(ARCHIVE_RETENTION_SETTING_KEY), '180');
});

test('code 和附属别名归属 canonical 模块，不生成独立设置行', () => {
  const { database } = fixture();
  for (const [alias, canonical] of [
    ['STATEMENT', 'statement-generator'], ['LINKED', 'bank-statement-process'],
    ['PREFUNDTEMP', 'pre-fund-reconciliation'], ['POSITIONLINK', 'position-reconciliation-process']
  ]) {
    setModuleRetentionDays(database, { moduleId: alias, retentionDays: null });
    assert.equal(resolveRetentionDays(database, canonical), null);
    assert.equal(resolveRetentionDays(database, alias.toLowerCase()), null);
    assert.equal(Object.hasOwn(readRetentionDaysByModule(database), alias), false);
  }
});

test('损坏 map 与非法字段安全继承默认，合法模块覆盖独立保留且读取不写入', () => {
  for (const raw of ['{broken', 'null', '[]', '30', '"text"', '']) {
    const { database, settings } = fixture([
      [ARCHIVE_RETENTION_SETTING_KEY, 'permanent'],
      [ARCHIVE_MODULE_RETENTION_SETTING_KEY, raw]
    ]);
    assert.deepEqual(readRetentionDaysByModule(database), {});
    assert.equal(resolveRetentionDays(database, 'toolbox'), null);
    assert.equal(settings.get(ARCHIVE_MODULE_RETENTION_SETTING_KEY), raw);
  }
  const { database } = fixture([
    [ARCHIVE_RETENTION_SETTING_KEY, '90'],
    [ARCHIVE_MODULE_RETENTION_SETTING_KEY, JSON.stringify({
      toolbox: 30, 'vcc-financial-op': null, 'statement-generator': '30',
      'bank-statement-process': false, 'new-account-generator': 45,
      'biz-op-recon': { days: 30 }, unknown: 365
    })]
  ]);
  assert.deepEqual(readRetentionDaysByModule(database), { toolbox: 30, 'vcc-financial-op': null });
  assert.equal(resolveRetentionDays(database, 'statement-generator'), 90);
});

test('未知模块与非法期限拒绝保存，已有配置保持不变', () => {
  const { database, settings } = fixture();
  setModuleRetentionDays(database, { moduleId: 'toolbox', retentionDays: 30 });
  const before = [...settings];
  for (const payload of [
    null, {}, { moduleId: 'unknown', retentionDays: 90 },
    ...[undefined, false, '', '30', 'permanent', 45, [], {}].map((retentionDays) => ({
      moduleId: 'toolbox', retentionDays
    }))
  ]) {
    assert.throws(() => setModuleRetentionDays(database, payload), TypeError);
    assert.deepEqual([...settings], before);
  }
});
