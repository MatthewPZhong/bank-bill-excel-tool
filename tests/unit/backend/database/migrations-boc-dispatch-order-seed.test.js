// v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（ensureBocDispatchOrderScenarioSeed）幂等回归测试
//   🔴 资金红线 —— BOC 场景默认休眠 enabled=0；独立 marker 绕开全局 marker 短路；
//      category='gateway-recon-id-fix'（不是 builtin-fixed），前置校验 CHECK 含 gateway-recon-id-fix。
//
//   覆盖（镜像 JPM 种子 6 案 + 排序案）：
//     ① fresh：补种 1 条，字段正确（category/name/enabled=0/is_builtin=1/priority=3/channel_id=1/不带 funcCategory + 含 channelName）。
//     ② 重跑幂等：独立 marker 短路 / 凭 subCategory 定位不重复。
//     ③ 删除终态保护：用户删除后重跑不复活（独立 marker）。
//     ④ CHECK 未扩到 'gateway-recon-id-fix' → 跳过不报错、不写 marker（下次重试）。
//     ⑤ UNIQUE(channel_id, name) 撞名 → 单条跳过、仍写 marker（不复活）。
//     ⑥ 「功能类别」回退：不带 funcCategory → getScenarioCategoryDisplay 回退「网关对账单修复」。
//     ⑦ 排序案：JPM→BOC 依次 seed 后，gateway 类别子集按 (priority DESC, id ASC) 顺序 = [JPM, BOC]（序号 2 = BOC）。

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
  ensureBocDispatchOrderScenarioSeed,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');

let tmpDir;
let dbPath;
let backupDir;
let db;

const BOC_MARKER = 'boc_dispatch_order_scenario_seeded';
const BOC_LIKE = '%"subCategory":"boc-dispatch-order-fix"%';
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

// 一站式：建到 scenarios CHECK 含 'gateway-recon-id-fix' + channel_id 列 + 复合 UNIQUE 的最终态（BOC seed 前置）。
function bootstrapReadyForSeed(currentDb, backupFn) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb);
  ensureScenariosCategoryReconIdFix(currentDb);
  ensureScenariosCategoryGatewayReconIdFix(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn);
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn);
}

function getBocRows(currentDb) {
  return currentDb
    .prepare(
      `SELECT * FROM scenarios
        WHERE is_builtin = 1 AND category = 'gateway-recon-id-fix' AND config_json LIKE ?`
    )
    .all(BOC_LIKE);
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boc-dispatch-seed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v3.0.4 块 E ensureBocDispatchOrderScenarioSeed', () => {
  test('① fresh：补种 1 条，字段正确（enabled=0 / is_builtin=1 / priority=3 / channel_id=1 / 不带 funcCategory / 含 channelName）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 1);

    const rows = getBocRows(db);
    assert.strictEqual(rows.length, 1, 'BOC 场景恰好 1 条');
    const row = rows[0];
    assert.strictEqual(row.category, 'gateway-recon-id-fix');
    assert.strictEqual(row.name, 'BOC调拨订单修复');
    assert.strictEqual(row.enabled, 0, '🔴 默认休眠 enabled=0');
    assert.strictEqual(row.is_builtin, 1);
    assert.strictEqual(row.priority, 3);
    assert.strictEqual(row.channel_id, 1);

    const cfg = JSON.parse(row.config_json);
    assert.strictEqual(cfg.subCategory, 'boc-dispatch-order-fix');
    assert.strictEqual(cfg.channelName, 'BOC', 'channelName 收进 config');
    assert.strictEqual(cfg.funcCategory, undefined, '🔴 不带 funcCategory（回退显示「网关对账单修复」）');

    // 独立 marker 已写
    assert.strictEqual(getMarker(db, BOC_MARKER).setting_value, 'true');
  });

  test('② 重跑幂等：连跑两次不重复（独立 marker 短路）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res1 = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res1.status, 'seeded');
    assert.strictEqual(res1.inserted, 1);

    const res2 = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res2.status, 'already-seeded', '第二次应被独立 marker 短路');
    assert.strictEqual(getBocRows(db).length, 1, 'BOC 场景仍恰好 1 条，不重复');
  });

  test('②bis 凭 subCategory 定位：marker 缺失但场景已在场 → 不重复插（skippedExisting）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureBocDispatchOrderScenarioSeed(db); // 首跑：插入 + 写 marker
    // 人为清掉 marker，模拟「场景在场但 marker 丢失」（如手工改库）
    db.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(BOC_MARKER);

    const res = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '已存在 → 不重复插');
    assert.strictEqual(res.skippedExisting, 1);
    assert.strictEqual(getBocRows(db).length, 1);
  });

  test('③ 删除终态保护：补种后用户删除 BOC 场景 → 再跑不复活（独立 marker）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(getBocRows(db).length, 1);

    // 用户删除 BOC 场景
    db.prepare(
      "DELETE FROM scenarios WHERE is_builtin=1 AND category='gateway-recon-id-fix' AND config_json LIKE ?"
    ).run(BOC_LIKE);
    assert.strictEqual(getBocRows(db).length, 0);

    const res = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'already-seeded');
    assert.strictEqual(getBocRows(db).length, 0, '已删 BOC 场景不应复活');
  });

  test('④ CHECK 未扩到 gateway-recon-id-fix → 跳过不报错、不写 marker（下次重试）', () => {
    // 仅建基础 scenarios（CHECK 只含 extract-recon-id 等 3 值，未扩 gateway-recon-id-fix）
    bootstrapAppSettings(db);
    ensureScenariosSupport(db);
    assert.ok(!scenariosTableSql(db).includes("'gateway-recon-id-fix'"));

    let res;
    assert.doesNotThrow(() => { res = ensureBocDispatchOrderScenarioSeed(db); });
    assert.strictEqual(res.status, 'skipped-check-not-extended');
    assert.strictEqual(getBocRows(db).length, 0, '未插入 BOC 场景');
    assert.strictEqual(getMarker(db, BOC_MARKER), undefined, 'CHECK 未扩时不应写独立 marker');
  });

  test('⑥ 「功能类别」回退：不带 funcCategory + category=gateway-recon-id-fix → 显示「网关对账单修复」', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureBocDispatchOrderScenarioSeed(db);
    const cfg = JSON.parse(getBocRows(db)[0].config_json);

    // 复刻 renderer-dialogs.js getScenarioCategoryDisplay 的纯逻辑（前端模块为 IIFE 闭包，不可直接 require）：
    //   funcCategory 缺失 → 回退 SCENARIO_CATEGORY_LABELS[category]。
    const SCENARIO_CATEGORY_LABELS = { 'gateway-recon-id-fix': '网关对账单修复' };
    const FUNC_CATEGORY_LABELS = { 'fund-nature-check': '资金性质校验', 'platform-order': '中台订单数据处理' };
    const scenario = { category: 'gateway-recon-id-fix', config: cfg };
    const funcCategory = scenario.config && scenario.config.funcCategory;
    const display = (funcCategory && FUNC_CATEGORY_LABELS[funcCategory])
      ? FUNC_CATEGORY_LABELS[funcCategory]
      : (SCENARIO_CATEGORY_LABELS[scenario.category] || scenario.category);
    assert.strictEqual(funcCategory, undefined, 'BOC 场景不带 funcCategory');
    assert.strictEqual(display, '网关对账单修复', '回退到 SCENARIO_CATEGORY_LABELS[gateway-recon-id-fix]');
  });

  test('⑤ UNIQUE(channel_id, name) 撞名（用户已有同名「BOC调拨订单修复」）→ 单条跳过、仍写 marker（不复活）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    // 用户已建一个同名但 subCategory 不同的场景（不会被定位为已存在）
    const now = new Date().toISOString();
    const cfg = JSON.stringify({ subCategory: 'user-custom', channelName: 'XYZ' });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('gateway-recon-id-fix', 'BOC调拨订单修复', 3, 1, ?, 0, 1, ?, ?)
    `).run(cfg, now, now);

    const res = ensureBocDispatchOrderScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '撞名 → BOC 场景未插入');
    assert.strictEqual(res.skippedConflict, 1, '应记为冲突跳过');
    // 真正的 BOC 场景（subCategory=boc-dispatch-order-fix）没插进去
    assert.strictEqual(getBocRows(db).length, 0);
    // marker 仍写 → 不会无限重试
    assert.strictEqual(getMarker(db, BOC_MARKER).setting_value, 'true');
  });

  test('⑦ 排序案：JPM→BOC 依次 seed → gateway 类别子集按 (priority DESC, id ASC) 顺序 = [JPM, BOC]（序号 2 = BOC）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    // 复刻 database.js init 链顺序：先 JPM 后 BOC（BOC id 紧随 JPM）。
    ensureJpmDispatchOrderScenarioSeed(db);
    ensureBocDispatchOrderScenarioSeed(db);

    // gateway 类别内置场景按 listScenarios 同口径排序 (priority DESC, id ASC)。
    const ordered = db
      .prepare(
        `SELECT name FROM scenarios
          WHERE is_builtin = 1 AND category = 'gateway-recon-id-fix'
          ORDER BY priority DESC, id ASC`
      )
      .all()
      .map((r) => r.name);
    assert.deepStrictEqual(ordered, ['JPM调拨订单修复', 'BOC调拨订单修复'], 'BOC 排在 JPM 之后（序号 2）');

    // 进一步证：两者 priority 相同、BOC id > JPM id（靠 id ASC 成序）。
    const jpm = db.prepare("SELECT id, priority FROM scenarios WHERE config_json LIKE ?").get(JPM_LIKE);
    const boc = db.prepare("SELECT id, priority FROM scenarios WHERE config_json LIKE ?").get(BOC_LIKE);
    assert.strictEqual(jpm.priority, boc.priority, '两者 priority 相同（=3）');
    assert.ok(boc.id > jpm.id, 'BOC id 紧随 JPM（更大）→ id ASC 下排第二');
  });
});
