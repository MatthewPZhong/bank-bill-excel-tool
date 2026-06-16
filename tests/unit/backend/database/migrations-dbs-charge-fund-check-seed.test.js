// v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（ensureDbsChargeFundCheckScenarioSeed）
//   + 旧库 charge-outbound 孤儿每次启动幂等 DELETE（retireChargeOutboundOrphans）回归测试。
//
//   🔴 资金红线 —— DBS-Charge 场景改写 ReconciliationId + FundType；默认 enabled=1（区别于 JPM/BOC 默认休眠）。
//      category='builtin-fixed'（同 R4/R5 内置场景），前置校验 CHECK 含 'builtin-fixed'；独立 marker 绕开全局 marker 短路。
//
//   覆盖 A（DBS-Charge seed，镜像 BOC 种子 6 案 + 分桶案）：
//     ① fresh：补种 1 条，字段正确（category=builtin-fixed / name / enabled=1 / is_builtin=1 / priority=1 / channel_id=1 +
//        config 含 funcCategory/subCategory='dbs-charge-fund-check' / bankChannel/dispatchChannelValue/setFundTypeCharge/
//        setFundTypeOutbound/chargeSiblingsScope='dbs-only'/roundPhase=3.5/involvedFiles）。
//     ② 重跑幂等：独立 marker 短路 / 凭 subCategory 定位不重复。
//     ②bis marker 缺失但场景在场 → 不重复插（skippedExisting）。
//     ③ 删除终态保护：用户删除后重跑不复活（独立 marker）。
//     ④ CHECK 未扩到 'builtin-fixed' → 跳过不报错、不写 marker（下次重试）。
//     ⑤ UNIQUE(channel_id, name) 撞名 → 单条跳过、仍写 marker（不复活）。
//     ⑥ 分桶：seed 出来的 DBS-Charge 经编排器 bucketScenarios 落 dbsChargeFundCheck 桶（→ R3.5），不漂 R4/R2。
//   覆盖 B（charge-outbound 退役迁移 retireChargeOutboundOrphans —— v3.0.6 改每次启动幂等 DELETE + 去 marker）：
//     ⑦ 旧库孤儿（charge-outbound enabled=1）+ 一条关联行 → 跑迁移后场景行被 DELETE（SELECT 不到）+ 关联行也被级联删；deleted=1。
//     ⑧ 重复跑幂等：第二次 deleted=0（无孤儿 no-op，不报错）。
//     ⑨ 无孤儿（新库）→ no-op（deleted=0，不报错）。
//     ⑪ 不误删：DBS-Charge(subCategory='dbs-charge-fund-check') + 一条普通 R4 子场景 → 跑后均仍在。

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
  ensureScenarioApplicableChannelsTable,
  ensureDbsChargeFundCheckScenarioSeed,
  retireChargeOutboundOrphans,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');
const { bucketScenarios } = require('../../../../src/main-process/reconciliation-orchestrator');

let tmpDir;
let dbPath;
let backupDir;
let db;

const DBS_MARKER = 'dbs_charge_fund_check_scenario_seeded';
const DBS_LIKE = '%"subCategory":"dbs-charge-fund-check"%';
const CHARGE_OUTBOUND_LIKE = '%"subCategory":"charge-outbound"%';

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

// 一站式：建到 scenarios CHECK 含 'builtin-fixed' + channel_id 列 + 复合 UNIQUE 的最终态（DBS-Charge seed 前置）。
function bootstrapReadyForSeed(currentDb, backupFn) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb);
  ensureScenariosCategoryReconIdFix(currentDb);
  ensureScenariosCategoryGatewayReconIdFix(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn); // 建 channels 表（scenario_applicable_channels.channel_id FK 目标）
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn);
  ensureScenariosCategoryBuiltinFixed(currentDb); // 扩 CHECK 到含 'builtin-fixed'
  ensureScenarioApplicableChannelsTable(currentDb); // 场景-渠道关联表（退役迁移级联删的目标表）
}

function getDbsRows(currentDb) {
  return currentDb
    .prepare(
      `SELECT * FROM scenarios
        WHERE is_builtin = 1 AND category = 'builtin-fixed' AND config_json LIKE ?`
    )
    .all(DBS_LIKE);
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

// 模拟旧库残留的 charge-outbound 内置孤儿（enabled=1）—— 用于退役迁移用例。返回插入行 id。
function insertChargeOutboundOrphan(currentDb, { enabled = 1 } = {}) {
  const now = new Date().toISOString();
  const cfg = JSON.stringify({
    funcCategory: 'fund-nature-check',
    subCategory: 'charge-outbound',
    roundPhase: 4,
    requireBankFundType: 'Charge',
    setFundType: 'outbound',
    function: '旧库残留',
    involvedFiles: ['银行对账单']
  });
  const info = currentDb.prepare(`
    INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('builtin-fixed', '资金性质校验-Charge转outbound', 1, ?, ?, 1, 1, ?, ?)
  `).run(enabled, cfg, now, now);
  return Number(info.lastInsertRowid);
}

// 关联一条 scenario_applicable_channels（复用 ensureSchemaV2_1_9_N5 自动种入的 channel id=1「通用」）。
function linkScenarioToChannel(currentDb, scenarioId, channelId = 1) {
  currentDb
    .prepare('INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, ?)')
    .run(scenarioId, channelId);
}

function countApplicableChannels(currentDb, scenarioId) {
  return currentDb
    .prepare('SELECT COUNT(*) AS n FROM scenario_applicable_channels WHERE scenario_id = ?')
    .get(scenarioId).n;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbs-charge-seed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v3.0.6 需求3（T9）ensureDbsChargeFundCheckScenarioSeed', () => {
  test('① fresh：补种 1 条，字段正确（enabled=1 / is_builtin=1 / priority=1 / channel_id=1 / config 字段齐全含 chargeSiblingsScope=dbs-only）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 1);

    const rows = getDbsRows(db);
    assert.strictEqual(rows.length, 1, 'DBS-Charge 场景恰好 1 条');
    const row = rows[0];
    assert.strictEqual(row.category, 'builtin-fixed');
    assert.strictEqual(row.name, 'DBS-Charge资金校验');
    assert.strictEqual(row.enabled, 1, '🔴 DBS-Charge 默认 enabled=1（启用即生效）');
    assert.strictEqual(row.is_builtin, 1);
    assert.strictEqual(row.priority, 1);
    assert.strictEqual(row.channel_id, 1);

    // 🔴 config 字段须与引擎 DEFAULT_CONFIG / 编排器 R3.5 桶逐字对齐。
    const cfg = JSON.parse(row.config_json);
    assert.strictEqual(cfg.funcCategory, 'dbs-charge-fund-check', '编排器 R3.5 分流键');
    assert.strictEqual(cfg.subCategory, 'dbs-charge-fund-check', 'seed 幂等定位键');
    assert.strictEqual(cfg.roundPhase, 3.5);
    assert.strictEqual(cfg.bankChannel, 'DBS');
    assert.strictEqual(cfg.dispatchChannelValue, 'DBS');
    assert.strictEqual(cfg.setFundTypeCharge, 'Charge');
    assert.strictEqual(cfg.setFundTypeOutbound, 'outbound');
    assert.strictEqual(cfg.chargeSiblingsScope, 'dbs-only', '🔴 步骤1末批量置 Charge 波及范围默认 = 仅 DBS 渠道行（防跨渠道误伤）');
    assert.ok(typeof cfg.function === 'string' && cfg.function.length > 0, 'function 非空');
    assert.deepStrictEqual(cfg.involvedFiles, ['银行对账单', '调拨对账单', '网关对账单']);

    // 独立 marker 已写
    assert.strictEqual(getMarker(db, DBS_MARKER).setting_value, 'true');
  });

  test('② 重跑幂等：连跑两次不重复（独立 marker 短路）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    const res1 = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res1.status, 'seeded');
    assert.strictEqual(res1.inserted, 1);

    const res2 = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res2.status, 'already-seeded', '第二次应被独立 marker 短路');
    assert.strictEqual(getDbsRows(db).length, 1, 'DBS-Charge 场景仍恰好 1 条，不重复');
  });

  test('②bis 凭 subCategory 定位：marker 缺失但场景已在场 → 不重复插（skippedExisting）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureDbsChargeFundCheckScenarioSeed(db); // 首跑：插入 + 写 marker
    // 人为清掉 marker，模拟「场景在场但 marker 丢失」（如手工改库）
    db.prepare('DELETE FROM app_settings WHERE setting_key = ?').run(DBS_MARKER);

    const res = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '已存在 → 不重复插');
    assert.strictEqual(res.skippedExisting, 1);
    assert.strictEqual(getDbsRows(db).length, 1);
  });

  test('③ 删除终态保护：补种后用户删除 DBS-Charge 场景 → 再跑不复活（独立 marker）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(getDbsRows(db).length, 1);

    // 用户删除 DBS-Charge 场景
    db.prepare(
      "DELETE FROM scenarios WHERE is_builtin=1 AND category='builtin-fixed' AND config_json LIKE ?"
    ).run(DBS_LIKE);
    assert.strictEqual(getDbsRows(db).length, 0);

    const res = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res.status, 'already-seeded');
    assert.strictEqual(getDbsRows(db).length, 0, '已删 DBS-Charge 场景不应复活');
  });

  test('④ CHECK 未扩到 builtin-fixed → 跳过不报错、不写 marker（下次重试）', () => {
    // 仅建基础 scenarios（CHECK 未扩 builtin-fixed）
    bootstrapAppSettings(db);
    ensureScenariosSupport(db);
    assert.ok(!scenariosTableSql(db).includes("'builtin-fixed'"));

    let res;
    assert.doesNotThrow(() => { res = ensureDbsChargeFundCheckScenarioSeed(db); });
    assert.strictEqual(res.status, 'skipped-check-not-extended');
    assert.strictEqual(getDbsRows(db).length, 0, '未插入 DBS-Charge 场景');
    assert.strictEqual(getMarker(db, DBS_MARKER), undefined, 'CHECK 未扩时不应写独立 marker');
  });

  test('⑤ UNIQUE(channel_id, name) 撞名（用户已有同名「DBS-Charge资金校验」）→ 单条跳过、仍写 marker（不复活）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());

    // 用户已建一个同名但 subCategory 不同的场景（不会被定位为已存在）
    const now = new Date().toISOString();
    const cfg = JSON.stringify({ subCategory: 'user-custom', note: 'x' });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', 'DBS-Charge资金校验', 1, 1, ?, 0, 1, ?, ?)
    `).run(cfg, now, now);

    const res = ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 0, '撞名 → DBS-Charge 场景未插入');
    assert.strictEqual(res.skippedConflict, 1, '应记为冲突跳过');
    // 真正的 DBS-Charge 场景（subCategory=dbs-charge-fund-check）没插进去
    assert.strictEqual(getDbsRows(db).length, 0);
    // marker 仍写 → 不会无限重试
    assert.strictEqual(getMarker(db, DBS_MARKER).setting_value, 'true');
  });

  test('⑥ 🔴 资金红线：seed 出来的 DBS-Charge 经 bucketScenarios 落 dbsChargeFundCheck 桶（→ R3.5），不漂 R4/R2', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureDbsChargeFundCheckScenarioSeed(db);

    const rows = getDbsRows(db).map((r) => ({ ...r, config: JSON.parse(r.config_json) }));
    assert.strictEqual(rows.length, 1);

    const { dbsChargeFundCheck, r2, r4 } = bucketScenarios(rows);
    assert.strictEqual(dbsChargeFundCheck.length, 1, 'DBS-Charge 应落 dbsChargeFundCheck 桶（R3.5）');
    assert.strictEqual(dbsChargeFundCheck[0].config.subCategory, 'dbs-charge-fund-check');
    assert.strictEqual(r4.length, 0, 'DBS-Charge 不应漂 R4');
    assert.strictEqual(r2.length, 0, 'DBS-Charge 不应漂 R2');
  });

  test('⑩ 「功能类别」标签：funcCategory=dbs-charge-fund-check + category=builtin-fixed → 显示「资金性质校验」（v3.0.6 用户反馈）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureDbsChargeFundCheckScenarioSeed(db);

    const rows = getDbsRows(db).map((r) => ({ ...r, config: JSON.parse(r.config_json) }));
    assert.strictEqual(rows.length, 1);
    const scenario = rows[0];

    // 复刻 renderer-dialogs.js getScenarioCategoryDisplay 的纯逻辑（前端模块为 IIFE 闭包，不可直接 require）：
    //   优先 config.funcCategory 映射 FUNC_CATEGORY_LABELS，映射不到才回退 category 标签。
    const FUNC_CATEGORY_LABELS = {
      'fund-nature-check': '资金性质校验',
      'platform-order': '中台订单数据处理',
      'dbs-charge-fund-check': '资金性质校验'
    };
    const SCENARIO_CATEGORY_LABELS = { 'builtin-fixed': '银行对账单赋值自身' };
    const funcCategory = scenario.config && scenario.config.funcCategory;
    const display = (funcCategory && FUNC_CATEGORY_LABELS[funcCategory])
      ? FUNC_CATEGORY_LABELS[funcCategory]
      : (SCENARIO_CATEGORY_LABELS[scenario.category] || scenario.category);

    assert.strictEqual(funcCategory, 'dbs-charge-fund-check', '前置：seed config.funcCategory 为分桶键');
    assert.strictEqual(display, '资金性质校验', 'DBS-Charge 应归「资金性质校验」，不再回退「银行对账单赋值自身」');
  });
});

test.describe('v3.0.6 需求3（T9）retireChargeOutboundOrphans（旧库孤儿每次启动幂等 DELETE + 级联）', () => {
  test('⑦ 旧库孤儿（charge-outbound enabled=1）+ 一条关联行 → 场景行被 DELETE（SELECT 不到）+ 关联行级联删；deleted=1', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const orphanId = insertChargeOutboundOrphan(db, { enabled: 1 });
    linkScenarioToChannel(db, orphanId); // 关联 channel id=1
    assert.strictEqual(countApplicableChannels(db, orphanId), 1, '前置：孤儿有 1 条关联行');
    const before = db.prepare('SELECT enabled FROM scenarios WHERE config_json LIKE ?').get(CHARGE_OUTBOUND_LIKE);
    assert.strictEqual(before.enabled, 1, '前置：孤儿 enabled=1');

    const res = retireChargeOutboundOrphans(db);
    assert.strictEqual(res.status, 'retired');
    assert.strictEqual(res.deleted, 1, '应 DELETE 1 条孤儿');

    // 🔴 场景行被彻底删除（SELECT 不到，场景管理 UI 不再显示）
    const after = db.prepare('SELECT * FROM scenarios WHERE config_json LIKE ?').all(CHARGE_OUTBOUND_LIKE);
    assert.strictEqual(after.length, 0, '🔴 charge-outbound 孤儿被彻底 DELETE（用户决策：彻底删除）');
    // 关联行也被级联删（显式 DELETE，不留 FK 残留）
    assert.strictEqual(countApplicableChannels(db, orphanId), 0, '关联行被级联删除（无 FK 残留）');
  });

  test('⑧ 重复跑幂等：第二次 deleted=0（无孤儿 no-op，不报错）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const orphanId = insertChargeOutboundOrphan(db, { enabled: 1 });
    linkScenarioToChannel(db, orphanId);

    const res1 = retireChargeOutboundOrphans(db); // 首跑：DELETE 1 条
    assert.strictEqual(res1.status, 'retired');
    assert.strictEqual(res1.deleted, 1);

    // 第二次：孤儿已不在 → no-op，不报错
    let res2;
    assert.doesNotThrow(() => { res2 = retireChargeOutboundOrphans(db); });
    assert.strictEqual(res2.status, 'retired');
    assert.strictEqual(res2.deleted, 0, '🔴 重复跑幂等：第二次无孤儿 → deleted=0 no-op');
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE config_json LIKE ?').get(CHARGE_OUTBOUND_LIKE).n,
      0,
      '孤儿仍不存在'
    );
  });

  test('⑨ 无孤儿（新库）→ no-op（deleted=0，不报错）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    // 不插任何 charge-outbound 孤儿

    let res;
    assert.doesNotThrow(() => { res = retireChargeOutboundOrphans(db); });
    assert.strictEqual(res.status, 'retired');
    assert.strictEqual(res.deleted, 0, '无孤儿 → 0 行删除 no-op');
  });

  test('⑪ 🔴 不误删：DBS-Charge(subCategory=dbs-charge-fund-check) + 一条普通 R4 子场景 → 跑后均仍在', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    // DBS-Charge 场景（绝不能误删）
    ensureDbsChargeFundCheckScenarioSeed(db);
    assert.strictEqual(getDbsRows(db).length, 1, '前置：DBS-Charge 场景在场');
    // 一条普通 R4 fund-nature-check 子场景（非 charge-outbound，绝不能误删）
    const now = new Date().toISOString();
    const r4Cfg = JSON.stringify({
      funcCategory: 'fund-nature-check',
      subCategory: 'ach-return',
      roundPhase: 4,
      function: '普通 R4 子场景',
      involvedFiles: ['银行对账单']
    });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '资金性质校验-ACH-Return', 1, 1, ?, 1, 1, ?, ?)
    `).run(r4Cfg, now, now);
    // 同时放一条 charge-outbound 孤儿（验证只删它、不殃及上面两条）
    insertChargeOutboundOrphan(db, { enabled: 1 });

    const res = retireChargeOutboundOrphans(db);
    assert.strictEqual(res.status, 'retired');
    assert.strictEqual(res.deleted, 1, '只 DELETE 那 1 条 charge-outbound 孤儿');

    // DBS-Charge 仍在
    assert.strictEqual(getDbsRows(db).length, 1, '🔴 DBS-Charge 场景未被误删');
    // 普通 R4 子场景仍在
    const r4After = db.prepare(
      "SELECT * FROM scenarios WHERE config_json LIKE '%\"subCategory\":\"ach-return\"%'"
    ).all();
    assert.strictEqual(r4After.length, 1, '🔴 普通 R4 子场景（ach-return）未被误删');
    // charge-outbound 孤儿已删
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE config_json LIKE ?').get(CHARGE_OUTBOUND_LIKE).n,
      0,
      'charge-outbound 孤儿已删'
    );
  });
});
