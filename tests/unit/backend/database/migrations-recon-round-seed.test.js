// v2.1.16-beta.2 §8 / v2.1.16-beta.4 ③ / v3.0.6 需求3（T9）：5 轮对账内置场景 seed（ensureReconRoundBuiltinScenariosSeed）幂等回归测试
//   ⚠️ v3.0.6 需求3（T9）：原 R4 charge-outbound 子场景退役（重写为 DBS-Charge / R3.5）—— 内置场景由 8 → 7（R4 5 → 4）。
//   覆盖（🔴 资金红线 —— config 字段须与引擎/编排器逐字对齐）：
//     - 7 个内置场景（4 R4 + 2 R5 既有 + 1 R5 场景4 退款回填）插入：category='builtin-fixed' / is_builtin=1 / channel_id=1 / priority 正确
//       · 既有 6 条 enabled=1；退款回填（refund-order-backfill）enabled=0（Layer 1 引擎层休眠）
//     - config_json 含正确 funcCategory + subCategory + setFundType / directions / excludeFundType 等
//     - charge-outbound 不再在 RECON_ROUND_BUILTIN_SCENARIOS（seed 后该 subCategory 0 条）
//     - 幂等：跑两次仍 7 条（不重复）
//     - 删除一条 → 再跑 → 不复活（marker 终态保护）
//     - 改名一条（模拟用户改名，marker 未写场景）→ 凭 subCategory 仍能定位、不重复插入、不覆盖
//     - CHECK 未扩到 'builtin-fixed' → 跳过不报错（下次重试）
//     - seed 出来的 7 条经编排器 bucketScenarios 正确分桶（funcCategory/subCategory 逐字一致实证）
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
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');
const { bucketScenarios } = require('../../../../src/main-process/reconciliation-orchestrator');

let tmpDir;
let dbPath;
let backupDir;
let db;

const SEED_MARKER = 'recon_round_builtin_scenarios_seeded';

// 期望的 7 个内置场景（subCategory → 期望字段），用于逐条断言（与 6 场景表 + v2.1.16-beta.4 ③退款场景逐字对齐）
//   ⚠️ v3.0.6 需求3（T9）：charge-outbound 已退役（重写为 DBS-Charge / R3.5），不在本数组。
//   expectedEnabled 缺省按 1；退款回填场景显式 0（Layer 1 引擎层休眠）。
const EXPECTED = {
  'ach-return':              { funcCategory: 'fund-nature-check', priority: 3, roundPhase: 4, gwTradeType: 'AchReturn',  setFundType: 'Ach Return',  name: '资金性质校验-Ach Return',  involvedFiles: ['银行对账单'] },
  'wire-return':            { funcCategory: 'fund-nature-check', priority: 2, roundPhase: 4, gwTradeType: 'WireReturn', setFundType: 'Wire Return', name: '资金性质校验-Wire Return', involvedFiles: ['银行对账单'] },
  'hx-out':                { funcCategory: 'fund-nature-check', priority: 1, roundPhase: 4, gwTradeType: 'HX_OUTBOUND', setFundType: 'HX-out', name: '资金性质校验-HX-out', involvedFiles: ['银行对账单'] },
  'hx-in':                 { funcCategory: 'fund-nature-check', priority: 0, roundPhase: 4, gwTradeType: 'HX_INBOUND', setFundType: 'HX-in', name: '资金性质校验-HX-in', involvedFiles: ['银行对账单'] },
  'fund-transfer-backfill':{ funcCategory: 'platform-order', priority: 0, roundPhase: 5, dateToleranceDays: 1, reconSourceMid: true, name: '中台调拨订单对账ID回填', involvedFiles: ['银行对账单'] },
  'platform-inbound-cleanup':{ funcCategory: 'platform-order', priority: 0, roundPhase: 5, gwTradeType: 'Inbound-VA', excludeFundType: 'Inbound', name: '中台加款单脏数据处理', involvedFiles: ['中台加款单剔除模板'] },
  // v2.1.16-beta.4 ③：退款回填场景（无 directions、无 gwTradeType，默认休眠 enabled=0）
  'refund-order-backfill': { funcCategory: 'platform-order', priority: 0, roundPhase: 5, expectedEnabled: 0, name: '中台退款订单回填', involvedFiles: ['中台退款订单', '中台退款订单回填模板', '银行对账单入金表'] },
};

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

// 只到 5 值（无 channels / channel_id）：模拟 v2.1.0-beta.3 老库
function bootstrapV210Schema(currentDb) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb);
  ensureScenariosCategoryReconIdFix(currentDb);
  ensureScenariosCategoryGatewayReconIdFix(currentDb);
}

// 最终态：5 值 + channel_id + 复合 UNIQUE(channel_id, name)
function bootstrapFinalState(currentDb, backupFn) {
  bootstrapV210Schema(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn);
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn);
}

// builtin-fixed 三迁移（CHECK 扩到 6 值 + 内置提取场景归类 + 多对多表）
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

function scenariosTableSql(currentDb) {
  return currentDb
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'")
    .get().sql;
}

// 取某 subCategory 的 seed 行（凭 is_builtin + builtin-fixed + config_json LIKE）
function getBySubCategory(currentDb, subCategory) {
  return currentDb
    .prepare(
      `SELECT * FROM scenarios
        WHERE is_builtin = 1 AND category = 'builtin-fixed' AND config_json LIKE ?`
    )
    .all(`%"subCategory":"${subCategory}"%`);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-round-seed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.16-beta.2 §8 ensureReconRoundBuiltinScenariosSeed', () => {
  test('首次 seed：插入 7 个内置场景，category/is_builtin/enabled/channel_id/priority 正确', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const before = db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c; // 仅内置提取场景 1 条 + 用户 0

    const res = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res.status, 'seeded');
    assert.strictEqual(res.inserted, 7, '应插入 7 条（4 R4 + 2 R5 既有 + 1 退款回填；charge-outbound 已退役）');

    // 7 条新内置场景（fund-nature-check 4 + platform-order 3，含退款回填）
    const r4 = db.prepare("SELECT COUNT(*) AS c FROM scenarios WHERE category='builtin-fixed' AND config_json LIKE '%\"funcCategory\":\"fund-nature-check\"%'").get().c;
    const r5 = db.prepare("SELECT COUNT(*) AS c FROM scenarios WHERE category='builtin-fixed' AND config_json LIKE '%\"funcCategory\":\"platform-order\"%'").get().c;
    assert.strictEqual(r4, 4, 'R4 资金性质校验应 4 条（charge-outbound 退役）');
    assert.strictEqual(r5, 3, 'R5 中台订单数据处理应 3 条（调拨回填 + 加款单脏数据 + 退款回填）');
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c, before + 7);

    // v3.0.6 需求3（T9）：charge-outbound 不再 seed（该 subCategory 0 条）
    assert.strictEqual(getBySubCategory(db, 'charge-outbound').length, 0, 'charge-outbound 已退役，不应被 seed');

    // 逐条断言字段（category / is_builtin / enabled / channel_id / priority + config 关键字段）
    for (const [sub, exp] of Object.entries(EXPECTED)) {
      const rows = getBySubCategory(db, sub);
      assert.strictEqual(rows.length, 1, `subCategory=${sub} 应恰好 1 条`);
      const row = rows[0];
      assert.strictEqual(row.category, 'builtin-fixed', `${sub}.category`);
      assert.strictEqual(row.is_builtin, 1, `${sub}.is_builtin`);
      // 既有 7 条 enabled=1；退款回填 enabled=0（默认休眠）
      assert.strictEqual(row.enabled, exp.expectedEnabled ?? 1, `${sub}.enabled`);
      assert.strictEqual(row.channel_id, 1, `${sub}.channel_id`);
      assert.strictEqual(row.priority, exp.priority, `${sub}.priority`);
      assert.strictEqual(row.name, exp.name, `${sub}.name`);

      const cfg = JSON.parse(row.config_json);
      assert.strictEqual(cfg.funcCategory, exp.funcCategory, `${sub}.config.funcCategory`);
      assert.strictEqual(cfg.subCategory, sub, `${sub}.config.subCategory`);
      assert.strictEqual(cfg.roundPhase, exp.roundPhase, `${sub}.config.roundPhase`);
      assert.deepStrictEqual(cfg.involvedFiles, exp.involvedFiles, `${sub}.config.involvedFiles`);
      assert.ok(typeof cfg.function === 'string' && cfg.function.length > 0, `${sub}.config.function 非空`);
      if (exp.setFundType !== undefined) assert.strictEqual(cfg.setFundType, exp.setFundType, `${sub}.config.setFundType`);
      if (exp.gwTradeType !== undefined) assert.strictEqual(cfg.gwTradeType, exp.gwTradeType, `${sub}.config.gwTradeType`);
      if (exp.requireBankFundType !== undefined) assert.strictEqual(cfg.requireBankFundType, exp.requireBankFundType, `${sub}.config.requireBankFundType`);
      if (exp.excludeFundType !== undefined) assert.strictEqual(cfg.excludeFundType, exp.excludeFundType, `${sub}.config.excludeFundType`);
      if (exp.dateToleranceDays !== undefined) assert.strictEqual(cfg.dateToleranceDays, exp.dateToleranceDays, `${sub}.config.dateToleranceDays`);
      // v3.0.6 需求2（T6）：fund-transfer-backfill 场景 seed 默认 reconSourceMid=true（对账数据来源默认勾选「中台调拨单表」）
      if (exp.reconSourceMid !== undefined) assert.strictEqual(cfg.reconSourceMid, exp.reconSourceMid, `${sub}.config.reconSourceMid`);
    }
  });

  test('R5 场景2 config.directions 双方向取值正确（FundTransfer-out / FundTransfer-in）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureReconRoundBuiltinScenariosSeed(db);
    const row = getBySubCategory(db, 'fund-transfer-backfill')[0];
    const cfg = JSON.parse(row.config_json);
    assert.deepStrictEqual(cfg.directions, [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ]);
  });

  test('幂等：连跑两次仍是 7 条（marker 短路 + 不重复插入）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const res1 = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res1.status, 'seeded');
    assert.strictEqual(res1.inserted, 7);

    const res2 = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res2.status, 'already-seeded', '第二次应被 marker 短路');

    // 每个 subCategory 仍恰好 1 条
    for (const sub of Object.keys(EXPECTED)) {
      assert.strictEqual(getBySubCategory(db, sub).length, 1, `${sub} 不应重复`);
    }
  });

  test('删除其中一条 → 再跑 → 不复活（marker 终态保护，仿 D14 删除终态）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureReconRoundBuiltinScenariosSeed(db); // 首跑写 marker

    // 删除 R4 Ach Return + R5 场景3（模拟用户删两条内置场景）
    db.prepare("DELETE FROM scenarios WHERE is_builtin=1 AND category='builtin-fixed' AND config_json LIKE ?")
      .run('%"subCategory":"ach-return"%');
    db.prepare("DELETE FROM scenarios WHERE is_builtin=1 AND category='builtin-fixed' AND config_json LIKE ?")
      .run('%"subCategory":"platform-inbound-cleanup"%');
    assert.strictEqual(getBySubCategory(db, 'ach-return').length, 0);
    assert.strictEqual(getBySubCategory(db, 'platform-inbound-cleanup').length, 0);

    // 再跑 → marker 命中 → 整体跳过 → 不复活
    const res = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res.status, 'already-seeded');
    assert.strictEqual(getBySubCategory(db, 'ach-return').length, 0, '已删场景不应复活');
    assert.strictEqual(getBySubCategory(db, 'platform-inbound-cleanup').length, 0, '已删场景不应复活');
  });

  test('改名一条（用户改名，marker 未写）→ 凭 subCategory 仍能定位、不重复插入、不覆盖名字', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    // 模拟「老库」：用户机器上已存在改过名的内置场景（同 subCategory），但本次 seed 的 marker 尚未写。
    //   手动插入一条「hx-in」内置场景，名字被用户改成自定义名。
    const now = new Date().toISOString();
    const userConfig = JSON.stringify({
      funcCategory: 'fund-nature-check',
      subCategory: 'hx-in',
      roundPhase: 4,
      gwTradeType: 'HX_INBOUND',
      setFundType: 'HX-in',
      function: '用户改过描述',
      involvedFiles: ['银行对账单']
    });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '我改名的HX入账场景', 0, 1, ?, 1, 1, ?, ?)
    `).run(userConfig, now, now);

    // marker 尚未写 → seed 走逐条定位路径
    const res = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res.status, 'seeded');
    // hx-in 已在场 → 跳过；其余 6 条插入（含退款回填；charge-outbound 已退役）
    assert.strictEqual(res.inserted, 6, '已存在的 hx-in 应跳过，仅插其余 6 条');
    assert.strictEqual(res.skippedExisting, 1, 'hx-in 应被识别为已存在跳过');

    // hx-in 仍恰好 1 条，且名字保持用户改的名（不覆盖）
    const rows = getBySubCategory(db, 'hx-in');
    assert.strictEqual(rows.length, 1, 'hx-in 不应被重复插入');
    assert.strictEqual(rows[0].name, '我改名的HX入账场景', '不应覆盖用户改的名字');

    // 总数 = 1（内置提取） + 1（用户改名 hx-in） + 6（新插）= 8
    const total = db.prepare("SELECT COUNT(*) AS c FROM scenarios WHERE category='builtin-fixed'").get().c;
    assert.strictEqual(total, 8);
  });

  test('改 priority 的用户场景（marker 未写）→ 凭 subCategory 定位跳过、不覆盖 priority', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const now = new Date().toISOString();
    // 用户把 ach-return 的 priority 从 3 改成 0（marker 未写）
    const cfg = JSON.stringify({
      funcCategory: 'fund-nature-check', subCategory: 'ach-return', roundPhase: 4,
      gwTradeType: 'AchReturn', setFundType: 'Ach Return', function: 'x', involvedFiles: ['银行对账单']
    });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '资金性质校验-Ach Return', 0, 1, ?, 1, 1, ?, ?)
    `).run(cfg, now, now);

    ensureReconRoundBuiltinScenariosSeed(db);
    const rows = getBySubCategory(db, 'ach-return');
    assert.strictEqual(rows.length, 1, 'ach-return 不应重复');
    assert.strictEqual(rows[0].priority, 0, '不应覆盖用户改的 priority');
  });

  test('UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ 单条跳过，不中断其余', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const now = new Date().toISOString();
    // 用户在 channel_id=1 建了一个同名「资金性质校验-HX-out」但 subCategory 不同（不会被定位为已存在）
    const cfg = JSON.stringify({ funcCategory: 'whatever', subCategory: 'user-custom', note: 'x' });
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '资金性质校验-HX-out', 1, 1, ?, 0, 1, ?, ?)
    `).run(cfg, now, now);

    const res = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(res.status, 'seeded');
    // hx-out 因 (channel_id=1, name) UNIQUE 冲突跳过 → 只插 6 条（含退款回填；charge-outbound 已退役）
    assert.strictEqual(res.inserted, 6, '撞名的 hx-out 应跳过，其余 6 条仍插入');
    assert.strictEqual(res.skippedConflict, 1, 'hx-out 应记为冲突跳过');
    // hx-out 这个 subCategory 没被插进去（用户场景 subCategory 是 user-custom）
    assert.strictEqual(getBySubCategory(db, 'hx-out').length, 0);
    // 其余 3 个 R4 子场景 + 3 个 R5 中除 hx-out 外都在
    assert.strictEqual(getBySubCategory(db, 'ach-return').length, 1);
    assert.strictEqual(getBySubCategory(db, 'fund-transfer-backfill').length, 1);
  });

  test('CHECK 未扩到 builtin-fixed（前置未完成）→ 跳过不报错、不插入', () => {
    bootstrapFinalState(db, makeBackupFn()); // 仅 5 值，未跑 builtin-fixed 三迁移
    assert.ok(!scenariosTableSql(db).includes("'builtin-fixed'"));

    let res;
    assert.doesNotThrow(() => { res = ensureReconRoundBuiltinScenariosSeed(db); });
    assert.strictEqual(res.status, 'skipped-check-not-extended');
    // 没插入任何 builtin-fixed 场景
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS c FROM scenarios WHERE category='builtin-fixed'").get().c,
      0
    );
    // marker 未写 → 下次启动可重试
    const marker = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(SEED_MARKER);
    assert.strictEqual(marker, undefined, 'CHECK 未扩时不应写 marker');
  });

  test('CHECK 扩展后重试：第一次跳过、扩 CHECK 后再跑 → 成功插 7 条', () => {
    bootstrapFinalState(db, makeBackupFn());
    const r1 = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(r1.status, 'skipped-check-not-extended');

    runBuiltinFixedMigrations(db); // 扩 CHECK 到含 builtin-fixed
    const r2 = ensureReconRoundBuiltinScenariosSeed(db);
    assert.strictEqual(r2.status, 'seeded');
    assert.strictEqual(r2.inserted, 7);
  });

  test('🔴 资金红线：seed 出来的 7 条经编排器 bucketScenarios 正确分桶（funcCategory/subCategory 逐字一致实证）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    ensureReconRoundBuiltinScenariosSeed(db);

    // 从库里读回 7 条新内置场景，还原成编排器需要的形态（config 反序列化）
    const rows = db
      .prepare("SELECT * FROM scenarios WHERE category='builtin-fixed' AND config_json LIKE '%\"funcCategory\":%'")
      .all()
      .map((r) => ({ ...r, config: JSON.parse(r.config_json) }));
    assert.strictEqual(rows.length, 7, '应读回 7 条带 funcCategory 的内置场景（charge-outbound 已退役）');

    const { r2, r4, r5s2, r5s3, r5s4 } = bucketScenarios(rows);
    // R4：4 个 fund-nature-check（charge-outbound 退役）
    assert.strictEqual(r4.length, 4, 'R4 桶应 4 条');
    // R5 场景2：fund-transfer-backfill 1 条
    assert.strictEqual(r5s2.length, 1, 'R5 场景2 桶应 1 条');
    assert.strictEqual(r5s2[0].config.subCategory, 'fund-transfer-backfill');
    // R5 场景3：platform-inbound-cleanup 1 条
    assert.strictEqual(r5s3.length, 1, 'R5 场景3 桶应 1 条');
    assert.strictEqual(r5s3[0].config.subCategory, 'platform-inbound-cleanup');
    // R5 场景4：refund-order-backfill 1 条
    assert.strictEqual(r5s4.length, 1, 'R5 场景4 桶应 1 条');
    assert.strictEqual(r5s4[0].config.subCategory, 'refund-order-backfill');
    // 7 条都不应落入 R2（否则会静默走错轮次 = 资金红线偏离）
    assert.strictEqual(r2.length, 0, '内置 R4/R5 场景不应误落 R2');

    // R4 桶 4 条的 subCategory 完整且无重复（charge-outbound 已退役，不在内）
    const r4Subs = r4.map((s) => s.config.subCategory).sort();
    assert.deepStrictEqual(
      r4Subs,
      ['ach-return', 'hx-in', 'hx-out', 'wire-return']
    );
  });

  test('老库无损：已有用户自建场景 + 内置提取场景 → seed 后它们不受影响（id 保留）', () => {
    bootstrapReadyForSeed(db, makeBackupFn());
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id) VALUES ('offset-bill-mark', '我的自建场景', 2, 1, '{\"billTypes\":[]}', 0, ?, ?, 1)"
    ).run(now, now);
    const userIdBefore = db.prepare("SELECT id FROM scenarios WHERE name='我的自建场景'").get().id;
    const extractIdBefore = db.prepare("SELECT id FROM scenarios WHERE is_builtin=1 AND config_json LIKE '%extractByFeature%'").get().id;

    ensureReconRoundBuiltinScenariosSeed(db);

    const userAfter = db.prepare("SELECT id, category, priority FROM scenarios WHERE name='我的自建场景'").get();
    assert.strictEqual(userAfter.id, userIdBefore, '用户场景 id 应保留');
    assert.strictEqual(userAfter.category, 'offset-bill-mark');
    assert.strictEqual(userAfter.priority, 2);
    const extractAfter = db.prepare("SELECT id FROM scenarios WHERE is_builtin=1 AND config_json LIKE '%extractByFeature%'").get();
    assert.strictEqual(extractAfter.id, extractIdBefore, '内置提取场景 id 应保留、不被本 seed 触碰');
  });
});
