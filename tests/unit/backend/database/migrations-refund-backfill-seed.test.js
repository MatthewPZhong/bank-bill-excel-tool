// v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（ensureRefundBackfillScenarioSeed）幂等回归测试
//   🔴 资金红线 —— 退款回填场景默认休眠 enabled=0；独立 marker 绕开全局 marker 短路坑（N5b）。
//
//   覆盖：
//     ① 新库 fresh（ensureReconRoundBuiltinScenariosSeed 已插过 8 条含退款场景）→ 本函数走幂等定位为已存在跳过，
//        且退款场景 enabled=0、既有 2 条 R5 仍 enabled=1。
//     ② 旧库（已写全局 marker recon_round_builtin_scenarios_seeded + 已有既有 7 条 R4/R5，但无退款场景）
//        → ensureReconRoundBuiltinScenariosSeed 短路不补种；ensureRefundBackfillScenarioSeed 仍能补种退款场景且 enabled=0。
//     ③ 重跑幂等：独立 marker 短路 / 凭 subCategory 定位不重复。
//     ④ 用户删除退款场景后重跑 → 独立 marker 终态保护，不复活。
//     ⑤ CHECK 未扩到 'builtin-fixed' → 跳过不报错、不写 marker（下次重试）。
//     ⑥ UNIQUE(channel_id, name) 撞名 → 单条跳过、仍写 marker（不复活）。
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
  ensureScenariosCategoryBuiltinFixed,
  ensureBuiltinFixedScenarioNameUpdate,
  ensureBuiltinFixedScenarioMigration,
  ensureScenarioApplicableChannelsTable,
  ensureReconRoundBuiltinScenariosSeed,
  ensureRefundBackfillScenarioSeed,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');

let tmpDir;
let dbPath;
let backupDir;
let db;

const GLOBAL_MARKER = 'recon_round_builtin_scenarios_seeded';
const REFUND_MARKER = 'refund_backfill_scenario_seeded';
const REFUND_LIKE = '%"subCategory":"refund-order-backfill"%';

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

function bootstrapV210Schema(currentDb) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb);
  ensureScenariosCategoryReconIdFix(currentDb);
  ensureScenariosCategoryGatewayReconIdFix(currentDb);
}

function bootstrapFinalState(currentDb, backupFn) {
  bootstrapV210Schema(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn);
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn);
}

function runBuiltinFixedMigrations(currentDb) {
  ensureScenariosCategoryBuiltinFixed(currentDb);
  ensureBuiltinFixedScenarioNameUpdate(currentDb);
  ensureBuiltinFixedScenarioMigration(currentDb);
  ensureScenarioApplicableChannelsTable(currentDb);
}

// 一站式：建到 CHECK 含 builtin-fixed 的最终态（seed 的前置）
function bootstrapReadyForSeed(currentDb, backupFn) {
  bootstrapFinalState(currentDb, backupFn);
  runBuiltinFixedMigrations(currentDb);
}

function getRefundRows(currentDb) {
  return currentDb
    .prepare(
      `SELECT * FROM scenarios
        WHERE is_builtin = 1 AND category = 'builtin-fixed' AND config_json LIKE ?`
    )
    .all(REFUND_LIKE);
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

// 模拟「旧库」：跑既有 R4/R5 seed 但把退款场景删掉 + 强制写全局 marker（仿真实老库已 seed 既有 7 条状态）。
//   注意：ensureReconRoundBuiltinScenariosSeed 现会插 8 条（含退款）→ 删掉退款 + 写全局 marker
//   即可还原「升级前已 seed 既有 7 条、marker=true、无退款场景」的旧库形态。
function bootstrapLegacyDbWithoutRefund(currentDb) {
  ensureReconRoundBuiltinScenariosSeed(currentDb); // 插 8 条 + 写全局 marker
  // 删掉退款场景，模拟旧版本（当时数组只有 7 条）
  currentDb.prepare(
    "DELETE FROM scenarios WHERE is_builtin=1 AND category='builtin-fixed' AND config_json LIKE ?"
  ).run(REFUND_LIKE);
  // 全局 marker 已由上面 seed 写过（=true）
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-backfill-seed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.16-beta.4 ③ ensureRefundBackfillScenarioSeed', () => {
  test('① 新库 fresh：ensureReconRoundBuiltinScenariosSeed 已插退款场景 → 本函数幂等跳过；退款 enabled=0、既有 2 条 R5 enabled=1', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureReconRoundBuiltinScenariosSeed(db); // 插 8 条（含退款 enabled=0）

    // 退款场景已在场 → 本函数定位为已存在跳过，但仍写自己的 marker
    const res = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '退款场景已在场 → 不重复插');
    assert.strictEqual(res.skippedExisting, 1, '退款场景应被识别为已存在跳过');

    const refundRows = getRefundRows(db);
    assert.strictEqual(refundRows.length, 1, '退款场景恰好 1 条（不重复）');
    assert.strictEqual(refundRows[0].enabled, 0, '退款场景默认休眠 enabled=0');

    // 既有 2 条 R5 仍 enabled=1
    const r5KeepEnabled = db.prepare(
      "SELECT enabled FROM scenarios WHERE category='builtin-fixed' AND config_json LIKE ?"
    );
    assert.strictEqual(r5KeepEnabled.get('%"subCategory":"fund-transfer-backfill"%').enabled, 1, '调拨回填仍 enabled=1');
    assert.strictEqual(r5KeepEnabled.get('%"subCategory":"platform-inbound-cleanup"%').enabled, 1, '加款单脏数据仍 enabled=1');

    // 独立 marker 已写
    assert.strictEqual(getMarker(db, REFUND_MARKER).setting_value, 'true');
  });

  test('🔴 N5b 短路坑：旧库（全局 marker=true + 已有 7 条 R4/R5、无退款场景）→ ensureReconRound 短路、ensureRefundBackfill 仍补种 enabled=0', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    bootstrapLegacyDbWithoutRefund(db);

    // 前提核对：全局 marker=true、退款场景不存在
    assert.strictEqual(getMarker(db, GLOBAL_MARKER).setting_value, 'true', '全局 marker 应已写（旧库）');
    assert.strictEqual(getRefundRows(db).length, 0, '旧库不应有退款场景');

    // ensureReconRoundBuiltinScenariosSeed 再跑 → 全局 marker 命中 → 短路、不补种退款（复现 N5b 短路坑）
    const reconRes = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(reconRes.status, 'already-seeded', '旧库再跑 ensureReconRound 应被全局 marker 短路');
    assert.strictEqual(getRefundRows(db).length, 0, '🔴 全局 marker 短路 → 退款场景仍未被 ensureReconRound 补种');

    // ensureRefundBackfillScenarioSeed 独立函数 → 仍能补种退款场景且 enabled=0
    const refundRes = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(refundRes.status, 'seeded');
    assert.strictEqual(refundRes.inserted, 1, '旧库应补种 1 条退款场景');

    const refundRows = getRefundRows(db);
    assert.strictEqual(refundRows.length, 1, '退款场景应被独立函数补种进来');
    assert.strictEqual(refundRows[0].enabled, 0, '补种的退款场景 enabled=0');
    assert.strictEqual(refundRows[0].is_builtin, 1);
    assert.strictEqual(refundRows[0].category, 'builtin-fixed');
    assert.strictEqual(refundRows[0].channel_id, 1);
    const cfg = JSON.parse(refundRows[0].config_json);
    assert.strictEqual(cfg.funcCategory, 'platform-order');
    assert.strictEqual(cfg.subCategory, 'refund-order-backfill');
    assert.strictEqual(cfg.bankPaymentSerialFuzzyMatchEnabled, false, '退款流水号模糊匹配默认关闭');
    assert.strictEqual(cfg.directions, undefined, '退款场景无 directions');
  });

  test('③ 重跑幂等：连跑两次不重复（独立 marker 短路）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    bootstrapLegacyDbWithoutRefund(db);

    const res1 = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(res1.status, 'seeded');
    assert.strictEqual(res1.inserted, 1);

    const res2 = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(res2.status, 'already-seeded', '第二次应被独立 marker 短路');
    assert.strictEqual(getRefundRows(db).length, 1, '退款场景仍恰好 1 条，不重复');
  });

  test('④ 删除终态保护：补种后用户删除退款场景 → 再跑不复活（独立 marker）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    bootstrapLegacyDbWithoutRefund(db);
    ensureRefundBackfillScenarioSeed(db); // 首跑补种 + 写独立 marker
    assert.strictEqual(getRefundRows(db).length, 1);

    // 用户删除退款场景
    db.prepare(
      "DELETE FROM scenarios WHERE is_builtin=1 AND category='builtin-fixed' AND config_json LIKE ?"
    ).run(REFUND_LIKE);
    assert.strictEqual(getRefundRows(db).length, 0);

    // 再跑 → 独立 marker 命中 → 整体跳过 → 不复活
    const res = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(res.status, 'already-seeded');
    assert.strictEqual(getRefundRows(db).length, 0, '已删退款场景不应复活');
  });

  test('⑤ CHECK 未扩到 builtin-fixed → 跳过不报错、不写 marker（下次重试）', () => {
    bootstrapFinalState(db, makeBackupFn()); // 仅 5 值，未跑 builtin-fixed 三迁移
    assert.ok(!scenariosTableSql(db).includes("'builtin-fixed'"));

    let res;
    assert.doesNotThrow(() => { res = ensureRefundBackfillScenarioSeed(db); });
    assert.strictEqual(res.status, 'skipped-check-not-extended');
    assert.strictEqual(getRefundRows(db).length, 0, '未插入退款场景');
    assert.strictEqual(getMarker(db, REFUND_MARKER), undefined, 'CHECK 未扩时不应写独立 marker');
  });

  test('⑥ UNIQUE(channel_id, name) 撞名（用户已有同名「中台退款订单回填」）→ 单条跳过、仍写 marker（不复活）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    bootstrapLegacyDbWithoutRefund(db);

    // 用户已建一个同名但 subCategory 不同的场景（不会被定位为已存在）
    const now = new Date().toISOString();
    const cfg = JSON.stringify({ funcCategory: 'whatever', subCategory: 'user-custom' });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '中台退款订单回填', 0, 1, ?, 0, 1, ?, ?)
    `).run(cfg, now, now);

    const res = ensureRefundBackfillScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '撞名 → 退款场景未插入');
    assert.strictEqual(res.skippedConflict, 1, '应记为冲突跳过');
    // 真正的退款场景（subCategory=refund-order-backfill）没插进去
    assert.strictEqual(getRefundRows(db).length, 0);
    // marker 仍写 → 不会无限重试（与既有冲突跳过语义一致）
    assert.strictEqual(getMarker(db, REFUND_MARKER).setting_value, 'true');
  });
});
