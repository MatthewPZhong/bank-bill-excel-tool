'use strict';

// v3.2.18 链接表保留期限（设置 → 数据管理）：设置读写与过期截止日期。
//   规则见 changes/v3.2.18/feat/data-management-retention/spec.md §3.3。
//   - 三张累加表按数据日期判断过期；未保存的表按内置默认（网关 15 天、银行对账单表 60 天、外汇交割表永久）。
//     外汇交割表默认永久（用户 2026-11-13 决定）：其过期按交易日期，删除会联动删 BOC链接表行，
//     远期交易可能在到期日前被删，导致 BOC调拨订单修复匹配不上；需要清理时由用户自行设置期限。
//   - 保存值 null 表示永久（不清理）；保存格式为按 tableKey 的 JSON。
//   - 过期：数据日期 D ≤ 今天（本地）− N − 1，即保留最近 N 天及到期当天（与存档“到期当天仍保留”同口径）。
const { LINKED_DELETE_TABLE_KEYS } = require('../linked-table-delete');

const LINKED_RETENTION_SETTING_KEY = 'linked_table_retention_days_by_table';
const LINKED_RETENTION_LAST_SUCCESS_KEY = 'linked_table_retention_last_success_at';
const LINKED_RETENTION_ALLOWED_DAYS = Object.freeze([15, 30, 60, 90, 180, 365]);
// 删除区间起点：所有合法 YYYY-MM-DD 数据日期都不小于它；数据日期为空的行不在 BETWEEN 范围内，不会被删。
const LINKED_RETENTION_RANGE_START = '0000-01-01';

const LINKED_RETENTION_TABLES = Object.freeze([
  Object.freeze({ tableKey: 'gateway-bill', name: '网关对账单表库', defaultRetentionDays: 15 }),
  Object.freeze({ tableKey: 'fx-settlement', name: '外汇交割表库', defaultRetentionDays: null }),
  Object.freeze({ tableKey: 'bank-deposit', name: '银行对账单表', defaultRetentionDays: 60 })
]);

// 保留期限只能作用于手工删除白名单内的表（同一删除与派生链路）。
for (const table of LINKED_RETENTION_TABLES) {
  if (!LINKED_DELETE_TABLE_KEYS.includes(table.tableKey)) {
    throw new Error(`链接表保留期限包含未登记删除链路的表：${table.tableKey}`);
  }
}

function getRetentionTable(tableKey) {
  return LINKED_RETENTION_TABLES.find((table) => table.tableKey === tableKey) || null;
}

function isAllowedRetentionValue(value) {
  return value === null || LINKED_RETENTION_ALLOWED_DAYS.includes(value);
}

function readStoredRetention(database) {
  let stored;
  try {
    stored = JSON.parse(database.getSetting(LINKED_RETENTION_SETTING_KEY));
  } catch (_error) {
    return {};
  }
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

// 三张表当前生效的期限（含内置默认）；非法保存值按默认处理。
function readRetentionDaysByTable(database) {
  const stored = readStoredRetention(database);
  const result = {};
  for (const table of LINKED_RETENTION_TABLES) {
    const hasStored = Object.prototype.hasOwnProperty.call(stored, table.tableKey)
      && isAllowedRetentionValue(stored[table.tableKey]);
    result[table.tableKey] = hasStored ? stored[table.tableKey] : table.defaultRetentionDays;
  }
  return result;
}

// 保存单张表期限；修改后清空上次成功清理时间，使新设置在下一次空闲即生效。
function setTableRetentionDays(database, payload = {}) {
  const table = getRetentionTable(payload && payload.tableKey);
  if (!table) throw new TypeError('请选择有效的链接表');
  const value = payload.retentionDays;
  if (!isAllowedRetentionValue(value)) {
    throw new TypeError('保留期限仅支持 15、30、60、90、180、365 天或永久');
  }
  const stored = readStoredRetention(database);
  const next = {};
  for (const known of LINKED_RETENTION_TABLES) {
    if (Object.prototype.hasOwnProperty.call(stored, known.tableKey) && isAllowedRetentionValue(stored[known.tableKey])) {
      next[known.tableKey] = stored[known.tableKey];
    }
  }
  next[table.tableKey] = value;
  database.setSetting(LINKED_RETENTION_SETTING_KEY, JSON.stringify(next));
  database.setSetting(LINKED_RETENTION_LAST_SUCCESS_KEY, '');
  return readRetentionDaysByTable(database);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 过期截止日期（含）：本地今天 − N − 1 天。Date 按本地日历进退，跨月、闰年由 Date 处理。
function expiredCutoffDate(nowMs, retentionDays) {
  if (!LINKED_RETENTION_ALLOWED_DAYS.includes(retentionDays)) {
    throw new TypeError(`无效的链接表保留天数：${retentionDays}`);
  }
  const now = new Date(nowMs);
  return formatLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays - 1));
}

function listPublicRetentionTables() {
  return LINKED_RETENTION_TABLES.map(({ tableKey, name, defaultRetentionDays }) => ({
    tableKey,
    name,
    defaultRetentionDays
  }));
}

module.exports = {
  LINKED_RETENTION_SETTING_KEY,
  LINKED_RETENTION_LAST_SUCCESS_KEY,
  LINKED_RETENTION_ALLOWED_DAYS,
  LINKED_RETENTION_RANGE_START,
  LINKED_RETENTION_TABLES,
  getRetentionTable,
  readRetentionDaysByTable,
  setTableRetentionDays,
  expiredCutoffDate,
  listPublicRetentionTables
};
