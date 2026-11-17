'use strict';

// v3.2.18 链接表保留期限设置：内置默认、保存校验、上次成功时间清空与过期截止日期边界。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LINKED_RETENTION_SETTING_KEY,
  LINKED_RETENTION_LAST_SUCCESS_KEY,
  LINKED_RETENTION_TABLES,
  readRetentionDaysByTable,
  setTableRetentionDays,
  expiredCutoffDate,
  listPublicRetentionTables
} = require('../../../src/main-process/linked-table-retention/policy');
const { LINKED_DELETE_TABLE_KEYS } = require('../../../src/main-process/linked-table-delete');

function memorySettings(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getSetting: (key) => (values.has(key) ? values.get(key) : null),
    setSetting: (key, value) => { values.set(key, value); }
  };
}

test('三张累加表与手工删除白名单一致，顺序固定，默认网关 15 天、外汇交割永久、银行对账单 60 天', () => {
  assert.deepEqual(LINKED_RETENTION_TABLES.map((table) => table.tableKey), LINKED_DELETE_TABLE_KEYS);
  assert.deepEqual(listPublicRetentionTables(), [
    { tableKey: 'gateway-bill', name: '网关对账单表库', defaultRetentionDays: 15 },
    { tableKey: 'fx-settlement', name: '外汇交割表库', defaultRetentionDays: null },
    { tableKey: 'bank-deposit', name: '银行对账单表', defaultRetentionDays: 60 }
  ]);
  assert.deepEqual(readRetentionDaysByTable(memorySettings()), {
    'gateway-bill': 15, 'fx-settlement': null, 'bank-deposit': 60
  });
});

test('保存值优先，null 表示永久；非法或损坏的保存值按默认处理', () => {
  const settings = memorySettings({
    [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'gateway-bill': null, 'fx-settlement': 7, 'bank-deposit': 365, unknown: 30 })
  });
  assert.deepEqual(readRetentionDaysByTable(settings), {
    'gateway-bill': null, 'fx-settlement': null, 'bank-deposit': 365
  });
  for (const broken of ['{bad', '[]', 'null', '15']) {
    assert.deepEqual(readRetentionDaysByTable(memorySettings({ [LINKED_RETENTION_SETTING_KEY]: broken })), {
      'gateway-bill': 15, 'fx-settlement': null, 'bank-deposit': 60
    }, broken);
  }
});

test('保存单张表：只改该表，清空上次成功清理时间，丢弃未知键与非法旧值', () => {
  const settings = memorySettings({
    [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'bank-deposit': 180, 'fx-settlement': 'x', stale: 30 }),
    [LINKED_RETENTION_LAST_SUCCESS_KEY]: '1700000000000'
  });
  const result = setTableRetentionDays(settings, { tableKey: 'gateway-bill', retentionDays: 30 });
  assert.deepEqual(result, { 'gateway-bill': 30, 'fx-settlement': null, 'bank-deposit': 180 });
  assert.deepEqual(JSON.parse(settings.getSetting(LINKED_RETENTION_SETTING_KEY)), { 'bank-deposit': 180, 'gateway-bill': 30 });
  assert.equal(settings.getSetting(LINKED_RETENTION_LAST_SUCCESS_KEY), '');
  setTableRetentionDays(settings, { tableKey: 'fx-settlement', retentionDays: 60 });
  assert.equal(readRetentionDaysByTable(settings)['fx-settlement'], 60);
  setTableRetentionDays(settings, { tableKey: 'gateway-bill', retentionDays: null });
  assert.equal(readRetentionDaysByTable(settings)['gateway-bill'], null);
});

test('非法表名或期限被拒绝且不改设置', () => {
  const settings = memorySettings({ [LINKED_RETENTION_SETTING_KEY]: JSON.stringify({ 'gateway-bill': 30 }) });
  const before = settings.getSetting(LINKED_RETENTION_SETTING_KEY);
  for (const payload of [
    { tableKey: 'mid-allocation', retentionDays: 30 },
    { tableKey: 'adm-bank-deposit', retentionDays: 30 },
    { tableKey: 'gateway-bill', retentionDays: 14 },
    { tableKey: 'gateway-bill', retentionDays: '30' },
    { tableKey: 'gateway-bill', retentionDays: 'permanent' },
    { tableKey: 'gateway-bill' },
    null
  ]) {
    assert.throws(() => setTableRetentionDays(settings, payload), TypeError, JSON.stringify(payload));
  }
  assert.equal(settings.getSetting(LINKED_RETENTION_SETTING_KEY), before);
});

test('截止日期（含）= 本地今天 − N − 1：保留最近 N 天及到期当天，跨月、跨年、闰年正确', () => {
  const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 30).getTime();
  assert.equal(expiredCutoffDate(at(2026, 11, 13), 15), '2026-10-28');
  assert.equal(expiredCutoffDate(at(2026, 11, 13), 30), '2026-10-13');
  assert.equal(expiredCutoffDate(at(2026, 11, 13, 0), 60), '2026-09-13');
  assert.equal(expiredCutoffDate(at(2026, 11, 13, 23), 60), '2026-09-13');
  assert.equal(expiredCutoffDate(at(2027, 1, 10), 15), '2026-12-25');
  assert.equal(expiredCutoffDate(at(2028, 3, 16), 15), '2028-02-29');
  assert.equal(expiredCutoffDate(at(2027, 3, 16), 15), '2027-02-28');
  assert.equal(expiredCutoffDate(at(2026, 11, 13), 365), '2025-11-12');
  assert.throws(() => expiredCutoffDate(at(2026, 11, 13), 14), TypeError);
});
