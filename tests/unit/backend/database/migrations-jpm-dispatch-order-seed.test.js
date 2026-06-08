// v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（ensureJpmDispatchOrderScenarioSeed）幂等回归测试
//   🔴 资金红线 —— JPM 场景默认休眠 enabled=0；独立 marker 绕开全局 marker 短路；
//      category='gateway-recon-id-fix'（不是 builtin-fixed），前置校验 CHECK 含 gateway-recon-id-fix。
//
//   覆盖（PRD §6.4 AC4-1~AC4-4）：
//     ① fresh：补种 1 条，字段正确（category/name/enabled=0/is_builtin=1/不带 funcCategory + 含 merchantId）。
//     ② 重跑幂等：独立 marker 短路 / 凭 subCategory 定位不重复。
//     ③ 删除终态保护：用户删除后重跑不复活（独立 marker）。
//     ④ CHECK 未扩到 'gateway-recon-id-fix' → 跳过不报错、不写 marker（下次重试）。
//     ⑤ UNIQUE(channel_id, name) 撞名 → 单条跳过、仍写 marker（不复活）。
//     ⑥ 「功能类别」回退：不带 funcCategory → getScenarioCategoryDisplay 回退「网关对账单修复」（与 PRD §5.4 一致）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  ensureSchemaV2_1_9_N5,
  ensureScenariosNameUniqueByChannelId,
  ensureJpmDispatchOrderScenarioSeed,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');
const { ADM_MERCHANT_ID } = require('../../../../src/constants/adm-bank-deposit-fields');

let tmpDir;
let dbPath;
let backupDir;
let db;

const JPM_MARKER = 'jpm_dispatch_order_scenario_seeded';
const JPM_LIKE = '%"subCategory":"jpm-dispatch-order-fix"%';

function makeBackupFn() {
  return (label) => createBackup(db, label, backupDir);
}

function bootstrapAppSettings(currentDb) {
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// 一站式：建到 scenarios CHECK 含 'gateway-recon-id-fix' + channel_id 列 + 复合 UNIQUE 的最终态（JPM seed 前置）。
function bootstrapReadyForSeed(currentDb, backupFn) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb);
  ensureScenariosCategoryReconIdFix(currentDb);
  ensureScenariosCategoryGatewayReconIdFix(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn);
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn);
}

function getJpmRows(currentDb) {
  return currentDb
    .prepare(
      `SELECT * FROM scenarios
        WHERE is_builtin = 1 AND category = 'gateway-recon-id-fix' AND config_json LIKE ?`
    )
    .all(JPM_LIKE);
}

function getMarker(currentDb, key) {
  return currentDb
    .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
    .get(key);
}

function scenariosTableSql(currentDb) {
  return currentDb
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'")
    .get().sql;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpm-dispatch-seed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.16-beta.5 ④ ensureJpmDispatchOrderScenarioSeed', () => {
  test('① fresh：补种 1 条，字段正确（enabled=0 / is_builtin=1 / 不带 funcCategory / 含 merchantId）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 1);

    const rows = getJpmRows(db);
    assert.strictEqual(rows.length, 1, 'JPM 场景恰好 1 条');
    const row = rows[0];
    assert.strictEqual(row.category, 'gateway-recon-id-fix');
    assert.strictEqual(row.name, 'JPM调拨订单修复');
    assert.strictEqual(row.enabled, 0, '🔴 默认休眠 enabled=0');
    assert.strictEqual(row.is_builtin, 1);
    assert.strictEqual(row.priority, 3);
    assert.strictEqual(row.channel_id, 1);

    const cfg = JSON.parse(row.config_json);
    assert.strictEqual(cfg.subCategory, 'jpm-dispatch-order-fix');
    assert.strictEqual(cfg.merchantId, ADM_MERCHANT_ID, 'merchantId 收进 config');
    assert.strictEqual(cfg.funcCategory, undefined, '🔴 不带 funcCategory（回退显示「网关对账单修复」）');

    // 独立 marker 已写
    assert.strictEqual(getMarker(db, JPM_MARKER).setting_value, 'true');
  });

  test('② 重跑幂等：连跑两次不重复（独立 marker 短路）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res1 = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res1.status, 'seeded');
    assert.strictEqual(res1.inserted, 1);

    const res2 = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res2.status, 'already-seeded', '第二次应被独立 marker 短路');
    assert.strictEqual(getJpmRows(db).length, 1, 'JPM 场景仍恰好 1 条，不重复');
  });

  test('②bis 凭 subCategory 定位：marker 缺失但场景已在场 → 不重复插（skippedExisting）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureJpmDispatchOrderScenarioSeed(db); // 首跑：插入 + 写 marker
    // 人为清掉 marker，模拟「场景在场但 marker 丢失」（如手工改库）
    db.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(JPM_MARKER);

    const res = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '已存在 → 不重复插');
    assert.strictEqual(res.skippedExisting, 1);
    assert.strictEqual(getJpmRows(db).length, 1);
  });

  test('③ 删除终态保护：补种后用户删除 JPM 场景 → 再跑不复活（独立 marker）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(getJpmRows(db).length, 1);

    // 用户删除 JPM 场景
    db.prepare(
      "DELETE FROM scenarios WHERE is_builtin=1 AND category='gateway-recon-id-fix' AND config_json LIKE ?"
    ).run(JPM_LIKE);
    assert.strictEqual(getJpmRows(db).length, 0);

    const res = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'already-seeded');
    assert.strictEqual(getJpmRows(db).length, 0, '已删 JPM 场景不应复活');
  });

  test('④ CHECK 未扩到 gateway-recon-id-fix → 跳过不报错、不写 marker（下次重试）', () => {
    // 仅建基础 scenarios（CHECK 只含 extract-recon-id 等 3 值，未扩 gateway-recon-id-fix）
    bootstrapAppSettings(db);
    ensureScenariosSupport(db);
    assert.ok(!scenariosTableSql(db).includes("'gateway-recon-id-fix'"));

    let res;
    assert.doesNotThrow(() => { res = ensureJpmDispatchOrderScenarioSeed(db); });
    assert.strictEqual(res.status, 'skipped-check-not-extended');
    assert.strictEqual(getJpmRows(db).length, 0, '未插入 JPM 场景');
    assert.strictEqual(getMarker(db, JPM_MARKER), undefined, 'CHECK 未扩时不应写独立 marker');
  });

  test('⑥ 「功能类别」回退：不带 funcCategory + category=gateway-recon-id-fix → 显示「网关对账单修复」', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureJpmDispatchOrderScenarioSeed(db);
    const cfg = JSON.parse(getJpmRows(db)[0].config_json);

    // 复刻 renderer-dialogs.js getScenarioCategoryDisplay 的纯逻辑（前端模块为 IIFE 闭包，不可直接 require）：
    //   funcCategory 缺失 → 回退 SCENARIO_CATEGORY_LABELS[category]。
    const SCENARIO_CATEGORY_LABELS = { 'gateway-recon-id-fix': '网关对账单修复' };
    const FUNC_CATEGORY_LABELS = { 'fund-nature-check': '资金性质校验', 'platform-order': '中台订单数据处理' };
    const scenario = { category: 'gateway-recon-id-fix', config: cfg };
    const funcCategory = scenario.config && scenario.config.funcCategory;
    const display = (funcCategory && FUNC_CATEGORY_LABELS[funcCategory])
      ? FUNC_CATEGORY_LABELS[funcCategory]
      : (SCENARIO_CATEGORY_LABELS[scenario.category] || scenario.category);
    assert.strictEqual(funcCategory, undefined, 'JPM 场景不带 funcCategory');
    assert.strictEqual(display, '网关对账单修复', '回退到 SCENARIO_CATEGORY_LABELS[gateway-recon-id-fix]');
  });

  test('⑤ UNIQUE(channel_id, name) 撞名（用户已有同名「JPM调拨订单修复」）→ 单条跳过、仍写 marker（不复活）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    // 用户已建一个同名但 subCategory 不同的场景（不会被定位为已存在）
    const now = new Date().toISOString();
    const cfg = JSON.stringify({ subCategory: 'user-custom', merchantId: '000' });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('gateway-recon-id-fix', 'JPM调拨订单修复', 3, 1, ?, 0, 1, ?, ?)
    `).run(cfg, now, now);

    const res = ensureJpmDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '撞名 → JPM 场景未插入');
    assert.strictEqual(res.skippedConflict, 1, '应记为冲突跳过');
    // 真正的 JPM 场景（subCategory=jpm-dispatch-order-fix）没插进去
    assert.strictEqual(getJpmRows(db).length, 0);
    // marker 仍写 → 不会无限重试
    assert.strictEqual(getMarker(db, JPM_MARKER).setting_value, 'true');
  });
});
