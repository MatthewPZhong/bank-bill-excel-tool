'use strict';

// v3.2.18：存档「VCC财务OP校验」保留期限默认 15 天的一次性迁移（ensureArchiveVccDefaultRetention）。
//   - 模块设置中没有 VCC 项：写入 15 并写标记；已有显式 VCC 设置（含永久 null）：保留，只写标记。
//   - 标记写入后不再处理：用户改为“跟随默认”（删除 VCC 项）或其他期限都不会被改回。
//   - 设置 JSON 损坏按空设置处理；app_settings 不存在时跳过且不写标记。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { ensureArchiveVccDefaultRetention } = require('../../../../src/backend/database/migrations');
const {
  readRetentionDaysByModule,
  resolveRetentionDays,
  setModuleRetentionDays
} = require('../../../../src/main-process/archive-center/retention-policy');

const MODULE_KEY = 'archive_center_retention_days_by_module';
const MARKER_KEY = 'archive_center_vcc_default_retention_seeded';

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT,
    updated_at TEXT NOT NULL
  )`);
  return db;
}

function settingsFacade(db) {
  return {
    getSetting(key) {
      const row = db.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      db.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`)
        .run(key, value, new Date().toISOString());
    }
  };
}

test('新库：写入 VCC 15 天与标记，VCC 新批次按 15 天、其他模块仍按全局默认', () => {
  const db = createDb();
  const settings = settingsFacade(db);
  assert.deepEqual(ensureArchiveVccDefaultRetention(db), { status: 'seeded' });
  assert.deepEqual(JSON.parse(settings.getSetting(MODULE_KEY)), { 'vcc-financial-op': 15 });
  assert.equal(settings.getSetting(MARKER_KEY), '1');
  assert.equal(resolveRetentionDays(settings, 'vcc-financial-op'), 15);
  assert.equal(resolveRetentionDays(settings, 'toolbox'), null);
});

test('已有其他模块设置时只补 VCC 项，保留原有模块期限', () => {
  const db = createDb();
  const settings = settingsFacade(db);
  settings.setSetting(MODULE_KEY, JSON.stringify({ toolbox: 30, 'bank-statement-process': null }));
  ensureArchiveVccDefaultRetention(db);
  assert.deepEqual(readRetentionDaysByModule(settings), {
    'bank-statement-process': null,
    'vcc-financial-op': 15,
    toolbox: 30
  });
});

for (const explicit of [365, null]) {
  test(`已有显式 VCC 期限 ${explicit === null ? '永久' : `${explicit} 天`}：保留不改，只写标记`, () => {
    const db = createDb();
    const settings = settingsFacade(db);
    settings.setSetting(MODULE_KEY, JSON.stringify({ 'vcc-financial-op': explicit }));
    assert.deepEqual(ensureArchiveVccDefaultRetention(db), { status: 'kept-explicit' });
    assert.deepEqual(JSON.parse(settings.getSetting(MODULE_KEY)), { 'vcc-financial-op': explicit });
    assert.equal(settings.getSetting(MARKER_KEY), '1');
  });
}

test('标记后改为跟随默认：重复启动不再写回 15 天', () => {
  const db = createDb();
  const settings = settingsFacade(db);
  ensureArchiveVccDefaultRetention(db);
  setModuleRetentionDays(settings, { moduleId: 'vcc-financial-op', retentionDays: 'inherit' });
  assert.deepEqual(readRetentionDaysByModule(settings), {});
  assert.deepEqual(ensureArchiveVccDefaultRetention(db), { status: 'already-seeded' });
  assert.deepEqual(ensureArchiveVccDefaultRetention(db), { status: 'already-seeded' });
  assert.deepEqual(readRetentionDaysByModule(settings), {});
});

test('设置 JSON 损坏：按空设置处理，写入 VCC 15 天', () => {
  const db = createDb();
  const settings = settingsFacade(db);
  settings.setSetting(MODULE_KEY, '{not-json');
  ensureArchiveVccDefaultRetention(db);
  assert.deepEqual(JSON.parse(settings.getSetting(MODULE_KEY)), { 'vcc-financial-op': 15 });
});

test('app_settings 不存在时跳过，不建表也不写标记', () => {
  const db = new DatabaseSync(':memory:');
  assert.deepEqual(ensureArchiveVccDefaultRetention(db), { status: 'skipped-no-table' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'app_settings'").get().n, 0);
});

test('15 天可作为默认与模块期限保存；非法值仍拒绝且不改设置', () => {
  const db = createDb();
  const settings = settingsFacade(db);
  setModuleRetentionDays(settings, { moduleId: 'toolbox', retentionDays: 15 });
  assert.equal(resolveRetentionDays(settings, 'toolbox'), 15);
  const before = settings.getSetting(MODULE_KEY);
  for (const invalid of [14, 7, '15', 0]) {
    assert.throws(() => setModuleRetentionDays(settings, { moduleId: 'toolbox', retentionDays: invalid }), /15、30/);
  }
  assert.equal(settings.getSetting(MODULE_KEY), before);
});
