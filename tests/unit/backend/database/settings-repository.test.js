// v2.1.9 G1-cont — settings-repository 通用 setting / module / UI style 测试
//   既有 settings-repository-idle-cleanup.test.js 覆盖 acquiring-bill idle 阈值，本文件覆盖其他 API
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const settingsRepo = require('../../../../src/backend/database/settings-repository');

let tmpDir;
let db;

function setupDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-repo-'));
  db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'));
  setupDb();
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// ========================================================================
// 常量
// ========================================================================

test.describe('ALL_MODULE_IDS / DEFAULT_ENABLED_MODULES 常量', () => {
  test('ALL_MODULE_IDS 包含 8 个模块', () => {
    assert.equal(settingsRepo.ALL_MODULE_IDS.length, 8);
    assert.ok(Object.isFrozen(settingsRepo.ALL_MODULE_IDS));
  });

  test('ALL_MODULE_IDS 包含 statement-generator / acquiring-bill-currency', () => {
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('statement-generator'));
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('acquiring-bill-currency'));
  });

  test('DEFAULT_ENABLED_MODULES 是 ALL_MODULE_IDS 子集', () => {
    settingsRepo.DEFAULT_ENABLED_MODULES.forEach((id) => {
      assert.ok(settingsRepo.ALL_MODULE_IDS.includes(id));
    });
  });
});

// ========================================================================
// getSetting / setSetting
// ========================================================================

test.describe('getSetting / setSetting', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getSetting(db, 'missing_key'), null);
  });

  test('set 后能 get', () => {
    settingsRepo.setSetting(db, 'my_key', 'value-001');
    assert.equal(settingsRepo.getSetting(db, 'my_key'), 'value-001');
  });

  test('UPSERT — 覆盖既有值', () => {
    settingsRepo.setSetting(db, 'key', 'v1');
    settingsRepo.setSetting(db, 'key', 'v2');
    assert.equal(settingsRepo.getSetting(db, 'key'), 'v2');
  });

  test('空字符串值合法', () => {
    settingsRepo.setSetting(db, 'empty', '');
    assert.equal(settingsRepo.getSetting(db, 'empty'), '');
  });
});

// ========================================================================
// getEnumConfig / setEnumConfig
// ========================================================================

test.describe('getEnumConfig / setEnumConfig — JSON 序列化', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getEnumConfig(db), null);
  });

  test('set 后 get → 反序列化', () => {
    settingsRepo.setEnumConfig(db, { a: 1, b: [2, 3] });
    assert.deepEqual(settingsRepo.getEnumConfig(db), { a: 1, b: [2, 3] });
  });

  test('DB 内非法 JSON → null', () => {
    settingsRepo.setSetting(db, 'enum_config', 'not-json{');
    assert.equal(settingsRepo.getEnumConfig(db), null);
  });
});

test.describe('getBackgroundConfig / setBackgroundConfig', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getBackgroundConfig(db), null);
  });

  test('set 后 get', () => {
    settingsRepo.setBackgroundConfig(db, { color: '#fff' });
    assert.deepEqual(settingsRepo.getBackgroundConfig(db), { color: '#fff' });
  });

  test('DB 内非法 JSON → null', () => {
    settingsRepo.setSetting(db, 'background_config', 'not-json');
    assert.equal(settingsRepo.getBackgroundConfig(db), null);
  });
});

// ========================================================================
// UI Style
// ========================================================================

test.describe('UI Style', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getUiStyle(db), null);
  });

  test('setUiStyle Clear / General', () => {
    settingsRepo.setUiStyle(db, 'Clear');
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
    settingsRepo.setUiStyle(db, 'General');
    assert.equal(settingsRepo.getUiStyle(db), 'General');
  });

  test('非法 style 抛错', () => {
    assert.throws(() => settingsRepo.setUiStyle(db, 'Invalid'), /Invalid ui_style/);
  });

  test('ensureUiStyleDefault：首次启动 seed Clear', () => {
    const r = settingsRepo.ensureUiStyleDefault(db);
    assert.equal(r, 'Clear');
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
  });

  test('ensureUiStyleDefault：已 set → 不覆盖', () => {
    settingsRepo.setUiStyle(db, 'General');
    const r = settingsRepo.ensureUiStyleDefault(db);
    assert.equal(r, 'General');
  });

  test('DB 内非法值 → getUiStyle 返回 null', () => {
    settingsRepo.setSetting(db, 'ui_style', 'NotValid');
    assert.equal(settingsRepo.getUiStyle(db), null);
  });
});

// ========================================================================
// CurrentModule
// ========================================================================

test.describe('getCurrentModule / setCurrentModule', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getCurrentModule(db), null);
  });

  test('合法 module ID set + get', () => {
    settingsRepo.setCurrentModule(db, 'bank-bu-recon');
    assert.equal(settingsRepo.getCurrentModule(db), 'bank-bu-recon');
  });

  test('非法 module ID → 抛错', () => {
    assert.throws(() => settingsRepo.setCurrentModule(db, 'invalid'), /Invalid current_module/);
  });

  test('v2.1.4 bug 防护：bank-bu-recon / biz-op-recon / acquiring-bill-currency 全可 set', () => {
    settingsRepo.setCurrentModule(db, 'bank-bu-recon');
    settingsRepo.setCurrentModule(db, 'biz-op-recon');
    settingsRepo.setCurrentModule(db, 'acquiring-bill-currency');
    assert.equal(settingsRepo.getCurrentModule(db), 'acquiring-bill-currency');
  });

  test('DB 内非法值 → getCurrentModule null', () => {
    settingsRepo.setSetting(db, 'current_module', 'invalid');
    assert.equal(settingsRepo.getCurrentModule(db), null);
  });
});

// ========================================================================
// ReconIdFixBillCategory
// ========================================================================

test.describe('getReconIdFixBillCategory / setReconIdFixBillCategory', () => {
  test('未 set → null', () => {
    assert.equal(settingsRepo.getReconIdFixBillCategory(db), null);
  });

  test('set business / gateway', () => {
    settingsRepo.setReconIdFixBillCategory(db, 'business');
    assert.equal(settingsRepo.getReconIdFixBillCategory(db), 'business');
    settingsRepo.setReconIdFixBillCategory(db, 'gateway');
    assert.equal(settingsRepo.getReconIdFixBillCategory(db), 'gateway');
  });

  test('set null/empty/undefined → 设为空串 → getRichton 返回 null', () => {
    settingsRepo.setReconIdFixBillCategory(db, 'business');
    settingsRepo.setReconIdFixBillCategory(db, null);
    assert.equal(settingsRepo.getReconIdFixBillCategory(db), null);
  });

  test('非法 category 抛错', () => {
    assert.throws(
      () => settingsRepo.setReconIdFixBillCategory(db, 'invalid'),
      /Invalid recon_id_fix_bill_category/
    );
  });
});

// ========================================================================
// EnabledModules
// ========================================================================

test.describe('getEnabledModules / setEnabledModules', () => {
  test('首次启动 → seed 默认列表 + 返回拷贝', () => {
    const r = settingsRepo.getEnabledModules(db);
    assert.deepEqual(r, [...settingsRepo.DEFAULT_ENABLED_MODULES]);
  });

  test('set 后 get', () => {
    settingsRepo.setEnabledModules(db, ['statement-generator', 'bank-statement-process']);
    assert.deepEqual(
      settingsRepo.getEnabledModules(db),
      ['statement-generator', 'bank-statement-process']
    );
  });

  test('set 自动去重', () => {
    settingsRepo.setEnabledModules(db, ['statement-generator', 'statement-generator']);
    const r = settingsRepo.getEnabledModules(db);
    assert.deepEqual(r, ['statement-generator']);
  });

  test('非法模块 ID → setEnabledModules 抛错', () => {
    assert.throws(
      () => settingsRepo.setEnabledModules(db, ['invalid-module']),
      /Invalid module id/
    );
  });

  test('空数组 → 抛错（必须保留至少 1 个）', () => {
    assert.throws(
      () => settingsRepo.setEnabledModules(db, []),
      /must not be empty/
    );
  });

  test('非数组入参 → 抛错', () => {
    assert.throws(
      () => settingsRepo.setEnabledModules(db, 'not-array'),
      /must be an array/
    );
  });

  test('非字符串元素 → 抛错', () => {
    assert.throws(
      () => settingsRepo.setEnabledModules(db, [123]),
      /must be non-empty string/
    );
  });

  test('DB 内非法 JSON → 回退默认（不阻断启动）', () => {
    settingsRepo.setSetting(db, 'enabled_modules', '{not json');
    const r = settingsRepo.getEnabledModules(db);
    assert.deepEqual(r, [...settingsRepo.DEFAULT_ENABLED_MODULES]);
  });

  test('DB 内 sanitize 后全空 → 回退默认', () => {
    settingsRepo.setSetting(db, 'enabled_modules', JSON.stringify(['invalid-1', 'invalid-2']));
    const r = settingsRepo.getEnabledModules(db);
    assert.deepEqual(r, [...settingsRepo.DEFAULT_ENABLED_MODULES]);
  });

  test('DB 内含合法 + 非法 → 过滤非法', () => {
    settingsRepo.setSetting(db, 'enabled_modules', JSON.stringify(['statement-generator', 'invalid', 'bank-statement-process']));
    const r = settingsRepo.getEnabledModules(db);
    assert.deepEqual(r, ['statement-generator', 'bank-statement-process']);
  });
});
