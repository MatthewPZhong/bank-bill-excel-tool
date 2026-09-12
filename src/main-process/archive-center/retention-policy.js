'use strict';

const { getArchiveScope, listVisibleArchiveScopes } = require('./module-scope-registry');

const ARCHIVE_RETENTION_SETTING_KEY = 'archive_center_retention_days';
const ARCHIVE_MODULE_RETENTION_SETTING_KEY = 'archive_center_retention_days_by_module';
const DEFAULT_RETENTION_DAYS = 60;
const ALLOWED_RETENTION_DAYS = new Set([30, 60, 90, 180, 365]);

function parseRetentionDays(value) {
  if (value === null || value === 'permanent') return null;
  const parsed = Number(value);
  return ALLOWED_RETENTION_DAYS.has(parsed) ? parsed : DEFAULT_RETENTION_DAYS;
}

function readDefaultRetentionDays(database, fallback = DEFAULT_RETENTION_DAYS) {
  const value = database.getSetting(ARCHIVE_RETENTION_SETTING_KEY);
  if (value === 'permanent') return null;
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return ALLOWED_RETENTION_DAYS.has(parsed) ? parsed : fallback;
}

function readRetentionDaysByModule(database) {
  const raw = database.getSetting(ARCHIVE_MODULE_RETENTION_SETTING_KEY);
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (_error) {
    return {};
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const result = {};
  for (const scope of listVisibleArchiveScopes()) {
    if (!Object.prototype.hasOwnProperty.call(stored, scope.id)) continue;
    const value = stored[scope.id];
    if (value === null || ALLOWED_RETENTION_DAYS.has(value)) result[scope.id] = value;
  }
  return result;
}

function resolveRetentionDays(database, moduleId, defaultRetentionDays = DEFAULT_RETENTION_DAYS) {
  const scope = getArchiveScope(moduleId);
  if (scope) {
    const overrides = readRetentionDaysByModule(database);
    if (Object.prototype.hasOwnProperty.call(overrides, scope.id)) return overrides[scope.id];
  }
  return readDefaultRetentionDays(database, defaultRetentionDays);
}

function setModuleRetentionDays(database, payload = {}) {
  const scope = getArchiveScope(payload && payload.moduleId);
  if (!scope) throw new TypeError('请选择有效的存档模块');
  const value = payload.retentionDays;
  if (value !== 'inherit' && value !== null && !ALLOWED_RETENTION_DAYS.has(value)) {
    throw new TypeError('保留期限仅支持继承默认、30、60、90、180、365 天或永久');
  }
  const overrides = readRetentionDaysByModule(database);
  if (value === 'inherit') delete overrides[scope.id];
  else overrides[scope.id] = value;
  database.setSetting(ARCHIVE_MODULE_RETENTION_SETTING_KEY, JSON.stringify(overrides));
  return overrides;
}

module.exports = {
  ALLOWED_RETENTION_DAYS,
  ARCHIVE_MODULE_RETENTION_SETTING_KEY,
  ARCHIVE_RETENTION_SETTING_KEY,
  DEFAULT_RETENTION_DAYS,
  parseRetentionDays,
  readDefaultRetentionDays,
  readRetentionDaysByModule,
  resolveRetentionDays,
  setModuleRetentionDays
};
