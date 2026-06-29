// v3.0.12 批E 修复C：ensureC3GwFieldCurrencyCaseRevert 单元回归
//   🔴 资金红线 — 旧迁移 ensureC3GwFieldCurrencyCaseFix 每次开机无条件把 C3「网关对账单赋值银行对账单」
//   (category='gateway-recon-join') 的 reconFields[].gwField='currency'（小写）改成 'Currency'（大写），
//   但 UI 下拉源 / 引擎取数源现已统一为小写 → 重启后大写匹配不到下拉项落空 + currency 维度静默不比对。
//   本迁移反转语义：把被旧迁移改坏的存量大写 'Currency' 改回小写 'currency'，并加 marker 只跑一次。
//
// 覆盖：
//   - 大写存量 → 反转回小写 + marker 写入（status=reverted / scanned / updated）
//   - 小写 currency → 跑反向迁移后仍小写（不再被改成大写）+ marker 写入
//   - marker 已存在 → no-op（不重复跑、不误改用户后续合法改动）
//   - 幂等：连跑两次（第二次 already-migrated、数据不变）
//   - 🔴 仅处理 reconFields[].gwField：assign.gwField / bankField / 其它 gwField 一律不动（surgical scope）
//   - 混合多场景：大写改、小写不改，scanned/updated 计数正确
//   - 不误伤：非 gateway-recon-join 场景不被扫到
//   - scenarios 表不存在 → skipped-no-scenarios-table 不抛错
//   - app_settings 表不存在 → skipped-no-settings-table 不抛错
//   - 非法 JSON config → 跳过不抛错、marker 仍写
//   - 防回退：migrations 不再 export 旧名 ensureC3GwFieldCurrencyCaseFix
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const migrations = require('../../../../src/backend/database/migrations');
const { ensureC3GwFieldCurrencyCaseRevert } = migrations;

const MARKER_KEY = 'c3_gw_field_currency_revert_done';

let tmpDir;
let dbPath;
let db;

// 最小 scenarios 表；CHECK 含 'gateway-recon-join'（C3 真实归类）
function createScenariosTable(currentDb) {
  currentDb.exec(`
    CREATE TABLE scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'builtin-fixed')),
      name TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name)
    );
  `);
}

function createAppSettingsTable(currentDb) {
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function insertScenario(currentDb, { name, category = 'gateway-recon-join', priority = 2, config, rawConfigJson, isBuiltin = 0, updatedAt = '2026-01-01T00:00:00.000Z' }) {
  const now = '2026-01-01T00:00:00.000Z';
  const configJson = rawConfigJson !== undefined ? rawConfigJson : JSON.stringify(config);
  currentDb.prepare(`
    INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
  `).run(category, name, priority, configJson, isBuiltin, now, updatedAt);
}

function getByName(currentDb, name) {
  return currentDb.prepare('SELECT * FROM scenarios WHERE name = ?').get(name);
}

function getMarker(currentDb) {
  const row = currentDb.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(MARKER_KEY);
  return row ? row.setting_value : undefined;
}

function setMarker(currentDb, value = 'true') {
  currentDb.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `).run(MARKER_KEY, value, '2026-01-01T00:00:00.000Z');
}

// 一个典型 C3 config：reconFields 网关字段对账 + assign 赋值
function c3Config({ gwField = 'currency' } = {}) {
  return {
    funcCategory: 'gateway-recon-join',
    reconFields: [{ gwField, bankField: 'Currency' }],
    assign: { gwField: 'merchantid', mode: 'direct', customValue: '' },
  };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-gw-currency-revert-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v3.0.12 批E 修复C ensureC3GwFieldCurrencyCaseRevert', () => {
  test('大写存量 Currency → 反转回小写 currency + marker 写入', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    // 模拟被旧迁移改坏的存量：reconFields[].gwField = 'Currency'（大写）
    insertScenario(db, { name: 'C3-网关赋值', config: c3Config({ gwField: 'Currency' }) });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.status, 'reverted');
    assert.strictEqual(res.scanned, 1);
    assert.strictEqual(res.updated, 1);

    const cfg = JSON.parse(getByName(db, 'C3-网关赋值').config_json);
    assert.strictEqual(cfg.reconFields[0].gwField, 'currency', '大写应被改回小写');
    assert.strictEqual(getMarker(db), 'true', 'marker 应写入');
    // updated_at 应被刷新（命中改动行）
    assert.notStrictEqual(getByName(db, 'C3-网关赋值').updated_at, '2026-01-01T00:00:00.000Z');
  });

  test('小写 currency → 跑反向迁移后仍小写（不再被改成大写）+ marker 写入', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    insertScenario(db, { name: 'C3-网关赋值', config: c3Config({ gwField: 'currency' }) });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.status, 'reverted');
    assert.strictEqual(res.scanned, 1);
    assert.strictEqual(res.updated, 0, '小写无需改动');

    const cfg = JSON.parse(getByName(db, 'C3-网关赋值').config_json);
    assert.strictEqual(cfg.reconFields[0].gwField, 'currency', '小写应保持小写（不再被改大写）');
    assert.strictEqual(getMarker(db), 'true', '0 改动也应写 marker（此后永不再跑）');
    // 未命中改动 → updated_at 不变
    assert.strictEqual(getByName(db, 'C3-网关赋值').updated_at, '2026-01-01T00:00:00.000Z');
  });

  test('marker 已存在 → no-op（不重复跑、不误改用户后续合法改动）', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    setMarker(db, 'true');
    // 用户后续把网关字段合法改回大写（假想场景）→ 有 marker 不应再被反转
    insertScenario(db, { name: 'C3-网关赋值', config: c3Config({ gwField: 'Currency' }), updatedAt: '2026-05-05T00:00:00.000Z' });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.status, 'already-migrated');

    const row = getByName(db, 'C3-网关赋值');
    assert.strictEqual(JSON.parse(row.config_json).reconFields[0].gwField, 'Currency', 'marker 存在 → 不动数据');
    assert.strictEqual(row.updated_at, '2026-05-05T00:00:00.000Z', '未跑 → updated_at 不变');
  });

  test('幂等：连跑两次（第二次 already-migrated、数据不变）', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    insertScenario(db, { name: 'C3-网关赋值', config: c3Config({ gwField: 'Currency' }) });

    const r1 = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(r1.status, 'reverted');
    assert.strictEqual(r1.updated, 1);
    const afterFirst = getByName(db, 'C3-网关赋值').config_json;

    const r2 = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(r2.status, 'already-migrated', '第二次 marker 已写 → no-op');

    const afterSecond = getByName(db, 'C3-网关赋值').config_json;
    assert.strictEqual(afterFirst, afterSecond, '第二次跑数据应完全不变（幂等）');
  });

  test('🔴 仅处理 reconFields[].gwField：assign.gwField / bankField / 其它 gwField 不动', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    const cfg = {
      funcCategory: 'gateway-recon-join',
      reconFields: [
        { gwField: 'Currency', bankField: 'Currency' }, // 仅这个 gwField 应被反转
        { gwField: 'merchantid', bankField: 'MerchantId' }, // 非 Currency → 不动
      ],
      assign: { gwField: 'Currency', mode: 'direct', customValue: '' }, // assign 不在处理范围 → 不动
    };
    insertScenario(db, { name: 'C3-多字段', config: cfg });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.updated, 1);

    const after = JSON.parse(getByName(db, 'C3-多字段').config_json);
    assert.strictEqual(after.reconFields[0].gwField, 'currency', 'reconFields[0].gwField 反转');
    assert.strictEqual(after.reconFields[0].bankField, 'Currency', 'bankField 不动（非 gwField，不做盲替换）');
    assert.strictEqual(after.reconFields[1].gwField, 'merchantid', '非 Currency 的 gwField 不动');
    assert.strictEqual(after.assign.gwField, 'Currency', '🔴 assign.gwField 不在处理范围 → 保持不动');
  });

  test('混合多场景：大写改、小写不改，scanned/updated 计数正确', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    insertScenario(db, { name: 'C3-大写', config: c3Config({ gwField: 'Currency' }) });
    insertScenario(db, { name: 'C3-小写', config: c3Config({ gwField: 'currency' }) });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.scanned, 2, '两个 gateway-recon-join 均被扫到');
    assert.strictEqual(res.updated, 1, '仅大写场景被改');

    assert.strictEqual(JSON.parse(getByName(db, 'C3-大写').config_json).reconFields[0].gwField, 'currency');
    assert.strictEqual(JSON.parse(getByName(db, 'C3-小写').config_json).reconFields[0].gwField, 'currency');
  });

  test('不误伤：非 gateway-recon-join 场景不被扫到', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    // offset-bill-mark 场景即便含 reconFields[].gwField='Currency' 也不应被 WHERE category 扫到
    insertScenario(db, {
      name: '打标场景',
      category: 'offset-bill-mark',
      config: { funcCategory: 'offset-bill-mark', reconFields: [{ gwField: 'Currency' }] },
      updatedAt: '2026-02-02T00:00:00.000Z',
    });

    const res = ensureC3GwFieldCurrencyCaseRevert(db);
    assert.strictEqual(res.scanned, 0, '无 gateway-recon-join 场景');
    assert.strictEqual(res.updated, 0);

    const after = getByName(db, '打标场景');
    assert.strictEqual(JSON.parse(after.config_json).reconFields[0].gwField, 'Currency', '非 C3 场景不被改');
    assert.strictEqual(after.updated_at, '2026-02-02T00:00:00.000Z', '非 C3 场景 updated_at 不变');
  });

  test('scenarios 表不存在（极早期启动）→ skipped-no-scenarios-table 不抛错', () => {
    createAppSettingsTable(db); // 仅建 app_settings，不建 scenarios
    let res;
    assert.doesNotThrow(() => { res = ensureC3GwFieldCurrencyCaseRevert(db); });
    assert.strictEqual(res.status, 'skipped-no-scenarios-table');
    assert.strictEqual(getMarker(db), undefined, '未完成 → 不写 marker（下次重试）');
  });

  test('app_settings 表不存在（极早期启动）→ skipped-no-settings-table 不抛错', () => {
    createScenariosTable(db); // 仅建 scenarios，不建 app_settings
    let res;
    assert.doesNotThrow(() => { res = ensureC3GwFieldCurrencyCaseRevert(db); });
    assert.strictEqual(res.status, 'skipped-no-settings-table');
  });

  test('非法 JSON config（防御）→ 跳过不抛错、marker 仍写', () => {
    createScenariosTable(db);
    createAppSettingsTable(db);
    insertScenario(db, { name: 'C3-坏JSON', rawConfigJson: '{"reconFields":[{"gwField":"Currency"}], BROKEN' });

    let res;
    assert.doesNotThrow(() => { res = ensureC3GwFieldCurrencyCaseRevert(db); });
    assert.strictEqual(res.scanned, 1);
    assert.strictEqual(res.updated, 0, '非法 JSON 跳过 → 不改');
    assert.strictEqual(getByName(db, 'C3-坏JSON').config_json, '{"reconFields":[{"gwField":"Currency"}], BROKEN', '原始 config 不变');
    assert.strictEqual(getMarker(db), 'true', '扫描已完成 → 写 marker');
  });

  test('防回退：migrations 不再 export 旧名 ensureC3GwFieldCurrencyCaseFix', () => {
    assert.strictEqual(typeof migrations.ensureC3GwFieldCurrencyCaseRevert, 'function', '新名应存在');
    assert.strictEqual(
      migrations.ensureC3GwFieldCurrencyCaseFix,
      undefined,
      '不得再 export 旧的"小写→大写" ensureC3GwFieldCurrencyCaseFix（防回退）'
    );
  });
});
