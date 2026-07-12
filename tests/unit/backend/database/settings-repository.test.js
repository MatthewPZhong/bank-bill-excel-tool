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
  test('ALL_MODULE_IDS 包含 10 个模块', () => {
    assert.equal(settingsRepo.ALL_MODULE_IDS.length, 10);
    assert.ok(Object.isFrozen(settingsRepo.ALL_MODULE_IDS));
  });

  test('ALL_MODULE_IDS 包含既有模块和前置资金对账', () => {
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('statement-generator'));
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('acquiring-bill-currency'));
    // v2.1.12 需求1：VCC业务OP计算模块注册（spec §8.1，修复 dev d2050b0 漏注册）
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('vcc-op-calc'));
    assert.ok(settingsRepo.ALL_MODULE_IDS.includes('pre-fund-reconciliation'));
  });

  test('前置资金对账默认不启用，由用户从功能收纳中打开', () => {
    assert.equal(settingsRepo.DEFAULT_ENABLED_MODULES.includes('pre-fund-reconciliation'), false);
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
// LastImportDirectory
// ========================================================================

test.describe('getLastImportDirectory / setLastImportDirectory', () => {
  test('build key：空 scope 使用 global，非空 scope 加前缀', () => {
    assert.equal(settingsRepo.buildLastImportDirectoryKey(''), settingsRepo.LAST_IMPORT_DIRECTORY_GLOBAL_KEY);
    assert.equal(settingsRepo.buildLastImportDirectoryKey('bank-statement-process'), 'last_import_directory:bank-statement-process');
    assert.equal(settingsRepo.buildLastImportDirectoryKey('  template  '), 'last_import_directory:template');
  });

  test('未设置时返回 null', () => {
    assert.equal(settingsRepo.getLastImportDirectory(db, 'bank-statement-process'), null);
  });

  test('同 scope 优先读 scoped，同时写入 global fallback', () => {
    settingsRepo.setLastImportDirectory(db, 'template', '/tmp/template');
    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', '/tmp/bank');

    assert.equal(settingsRepo.getLastImportDirectory(db, 'template'), '/tmp/template');
    assert.equal(settingsRepo.getLastImportDirectory(db, 'bank-statement-process'), '/tmp/bank');
    assert.equal(settingsRepo.getLastImportDirectory(db, 'unknown-scope'), '/tmp/bank');
  });

  test('空目录不写入', () => {
    settingsRepo.setLastImportDirectory(db, 'template', '/tmp/template');
    settingsRepo.setLastImportDirectory(db, 'template', '   ');
    assert.equal(settingsRepo.getLastImportDirectory(db, 'template'), '/tmp/template');
  });

  test('空白 scope 等价于全局，不产生双写', () => {
    settingsRepo.setLastImportDirectory(db, '   ', '/tmp/global-only');
    assert.equal(
      settingsRepo.getSetting(db, settingsRepo.LAST_IMPORT_DIRECTORY_GLOBAL_KEY),
      '/tmp/global-only'
    );
    // trim 后为空的 scope 不应在 scoped key 空间留下键
    assert.equal(settingsRepo.getSetting(db, 'last_import_directory:   '), null);
  });

  test('candidates：scoped 优先、global 兜底、同值去重', () => {
    assert.deepEqual(settingsRepo.getLastImportDirectoryCandidates(db, 'template'), []);

    settingsRepo.setLastImportDirectory(db, 'template', '/tmp/template');
    // 写入 template 时同步写了 global，同值去重后只剩 1 个候选
    assert.deepEqual(
      settingsRepo.getLastImportDirectoryCandidates(db, 'template'),
      ['/tmp/template']
    );

    settingsRepo.setLastImportDirectory(db, 'bank-statement-process', '/tmp/bank');
    // template scoped 仍在，global 已被 bank 覆盖 → 两个候选按 scoped → global 排序
    assert.deepEqual(
      settingsRepo.getLastImportDirectoryCandidates(db, 'template'),
      ['/tmp/template', '/tmp/bank']
    );
    // 未知 scope 只有 global 兜底
    assert.deepEqual(
      settingsRepo.getLastImportDirectoryCandidates(db, 'unknown-scope'),
      ['/tmp/bank']
    );
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

// v2.1.15 W4：弃用 General 风格，UI 风格恒为 'Clear'。
//   - setUiStyle 写链路已移除（不再有任何路径写入 'General'）。
//   - getUiStyle 对任何历史/非法值无声兜底为 'Clear'；ensureUiStyleDefault 就地迁移老库 'General'→'Clear'。
test.describe('UI Style（W4：恒 Clear + General 迁移）', () => {
  test('未 set → getUiStyle 兜底返回 Clear（不再返回 null）', () => {
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
  });

  test('老库 ui_style=General → getUiStyle 无声归一为 Clear', () => {
    settingsRepo.setSetting(db, 'ui_style', 'General');
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
  });

  test('DB 内任意非法值 → getUiStyle 返回 Clear（不抛错）', () => {
    settingsRepo.setSetting(db, 'ui_style', 'NotValid');
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
  });

  test('ui_style=Clear → getUiStyle 原样返回 Clear', () => {
    settingsRepo.setSetting(db, 'ui_style', 'Clear');
    assert.equal(settingsRepo.getUiStyle(db), 'Clear');
  });

  test('ensureUiStyleDefault：首次启动 seed Clear', () => {
    const r = settingsRepo.ensureUiStyleDefault(db);
    assert.equal(r, 'Clear');
    assert.equal(settingsRepo.getSetting(db, 'ui_style'), 'Clear');
  });

  test('ensureUiStyleDefault：老库 General → 就地迁移为 Clear（落盘值被改写）', () => {
    settingsRepo.setSetting(db, 'ui_style', 'General');
    const r = settingsRepo.ensureUiStyleDefault(db);
    assert.equal(r, 'Clear');
    // 关键：底层落盘值被迁移为 'Clear'，老用户启动后不再残留 'General'
    assert.equal(settingsRepo.getSetting(db, 'ui_style'), 'Clear');
  });

  test('setUiStyle 写链路已移除（不再导出）', () => {
    assert.equal(typeof settingsRepo.setUiStyle, 'undefined');
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
