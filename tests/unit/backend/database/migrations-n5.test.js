const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosSupport,
  ensureSchemaV2_1_9_N5,
  hasColumn,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');

let tmpDir;
let dbPath;
let db;
let backupDir;

function makeBackupFn() {
  return (label) => createBackup(db, label, backupDir);
}

function bootstrapV218Schema(currentDb) {
  // 模拟 v2.1.8 老库：app_settings + scenarios（不含 channels 表、不含 channel_id 列）
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureScenariosSupport(currentDb);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-migration-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  bootstrapV218Schema(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('ensureSchemaV2_1_9_N5', () => {
  test('首次执行：建 channels 表 + 加 channel_id 列 + backfill「通用」+ 标志位 + 备份文件存在', () => {
    const result = ensureSchemaV2_1_9_N5(db, makeBackupFn());

    assert.strictEqual(result.status, 'migrated');
    assert.strictEqual(result.columnAdded, true);
    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));

    // channels 表存在 + 「通用」内置
    const channels = db.prepare('SELECT * FROM channels').all();
    assert.strictEqual(channels.length, 1);
    assert.strictEqual(channels[0].id, 1);
    assert.strictEqual(channels[0].name, '通用');
    assert.strictEqual(channels[0].is_builtin, 1);

    // scenarios 有 channel_id 列
    assert.strictEqual(hasColumn(db, 'scenarios', 'channel_id'), true);

    // 标志位 = true
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'n5_channels_migrated'"
    ).get();
    assert.strictEqual(marker.setting_value, 'true');
  });

  test('幂等：第二次执行返回 skipped + 数据不变', () => {
    ensureSchemaV2_1_9_N5(db, makeBackupFn());
    const result2 = ensureSchemaV2_1_9_N5(db, makeBackupFn());
    assert.strictEqual(result2.status, 'skipped');
  });

  test('备份失败：返回 backup-failed + 不动 schema', () => {
    const failingBackupFn = () => { throw new Error('disk full (mock)'); };
    const result = ensureSchemaV2_1_9_N5(db, failingBackupFn);
    assert.strictEqual(result.status, 'backup-failed');
    assert.match(result.error, /disk full/);
    // channels 表不应被建出
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='channels'"
    ).get();
    assert.strictEqual(exists, undefined);
    // 标志位不存在
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'n5_channels_migrated'"
    ).get();
    assert.strictEqual(marker, undefined);
  });

  test('backfill：现有 scenarios.channel_id 全部 = 1', () => {
    // 先 seed 一些 scenarios（绕过 ensureScenariosSupport marker）
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, 0, 1, '{}', 0, ?, ?)
    `);
    insert.run('extract-recon-id', 'test-scenario-1', now, now);
    insert.run('offset-bill-mark', 'test-scenario-2', now, now);

    ensureSchemaV2_1_9_N5(db, makeBackupFn());

    const rows = db.prepare('SELECT id, name, channel_id FROM scenarios').all();
    // ensureScenariosSupport seed 3 内置场景 + 此处插 2 = 5 行
    assert.ok(rows.length >= 2, `expected at least 2 scenarios, got ${rows.length}`);
    assert.ok(rows.every(r => r.channel_id === 1), 'all scenarios should be backfilled to channel_id=1');
  });

  test('备份文件命名规范 pre-N5', () => {
    const result = ensureSchemaV2_1_9_N5(db, makeBackupFn());
    assert.strictEqual(result.status, 'migrated');
    const basename = path.basename(result.backupPath);
    assert.match(basename, /^tool-data-bak-pre-N5-\d{8}T\d{6}\.sqlite$/);
  });

  test('createBackupFn 缺失：不报错且跳过备份步骤', () => {
    // 允许 createBackupFn 为 null/undefined（兜底容错）
    const result = ensureSchemaV2_1_9_N5(db, null);
    assert.strictEqual(result.status, 'migrated');
    assert.strictEqual(result.backupPath, null);
  });
});
