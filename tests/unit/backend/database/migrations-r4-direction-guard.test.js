// v3.0.10 需求1：R4 方向守卫 config 字段补种（ensureR4DirectionGuardConfigMigration）单元回归
//   🔴 资金红线 — 老库 4 个 R4 场景缺 requireBankZeroField 则守卫静默失效，须每次启动幂等补回（不覆盖用户值）。
//
// 覆盖：
//   - 老库补字段：4 个 R4 子场景 config 缺 requireBankZeroField → 各补对应值
//       （ach-return/hx-out → 'Credit Amount'；wire-return/hx-in → 'Debit Amount'）
//   - 幂等：连跑两次稳定（第二次 updated=0、no-op，数据不再变化）
//   - 🔴 不覆盖用户已改的值：已存在 requireBankZeroField（含被用户改成空串 ''）→ 跳过不动
//   - 不误伤：非 R4 场景（subCategory 不在 4 个之列）config 完全不动；R4 场景的其它字段不变
//   - scenarios 表不存在（极早期启动）→ no-op 不抛错
//   - 非法 JSON config → 跳过不抛错（防御）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureR4DirectionGuardConfigMigration,
  ensureR4StrictDescriptionMigration,
  R4_STRICT_FUNCTION_BY_SUBCATEGORY,
} = require('../../../../src/backend/database/migrations');

let tmpDir;
let dbPath;
let db;

// R4 子场景 → 期望补种值（与 migration / seed / 引擎逐字一致）
const EXPECTED_GUARD = {
  'ach-return': 'Credit Amount',
  'wire-return': 'Debit Amount',
  'hx-out': 'Credit Amount',
  'hx-in': 'Debit Amount',
};

// 最小 scenarios 表；CHECK 含 'builtin-fixed'（R4 内置场景真实归类）+ 几个常见值，
//   迁移本身只凭 config_json LIKE + JSON.parse 定位，不依赖 category。
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

function insertScenario(currentDb, { name, category = 'builtin-fixed', priority = 0, config, rawConfigJson, isBuiltin = 1, updatedAt = '2026-01-01T00:00:00.000Z' }) {
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

// 插入一个不含 requireBankZeroField 的 R4 子场景（模拟老库 seed 出的 config）
function r4Config(subCategory, setFundType, gwTradeType) {
  return {
    funcCategory: 'fund-nature-check',
    subCategory,
    roundPhase: 4,
    gwTradeType,
    setFundType,
    function: `网关交易类型为 ${gwTradeType} 时改写 FundType（老库无方向守卫字段）。`,
    involvedFiles: ['银行对账单'],
  };
}

function seedAllFourR4Old(currentDb) {
  insertScenario(currentDb, { name: '资金性质校验-Ach Return', priority: 3, config: r4Config('ach-return', 'Ach Return', 'AchReturn') });
  insertScenario(currentDb, { name: '资金性质校验-Wire Return', priority: 2, config: r4Config('wire-return', 'Wire Return', 'WireReturn') });
  insertScenario(currentDb, { name: '资金性质校验-HX-out', priority: 1, config: r4Config('hx-out', 'HX-out', 'HX_OUTBOUND') });
  insertScenario(currentDb, { name: '资金性质校验-HX-in', priority: 0, config: r4Config('hx-in', 'HX-in', 'HX_INBOUND') });
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-direction-guard-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v3.0.10 需求1 ensureR4DirectionGuardConfigMigration', () => {
  test('老库补字段：4 个 R4 子场景缺 requireBankZeroField → 各补对应值（出账 Credit / 入账 Debit）', () => {
    createScenariosTable(db);
    seedAllFourR4Old(db);

    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.status, 'migrated');
    assert.strictEqual(res.scanned, 4, '应扫描到 4 个 R4 子场景');
    assert.strictEqual(res.updated, 4, '应补种 4 条');

    const byName = {
      'ach-return': '资金性质校验-Ach Return',
      'wire-return': '资金性质校验-Wire Return',
      'hx-out': '资金性质校验-HX-out',
      'hx-in': '资金性质校验-HX-in',
    };
    for (const [sub, expected] of Object.entries(EXPECTED_GUARD)) {
      const row = getByName(db, byName[sub]);
      const cfg = JSON.parse(row.config_json);
      assert.strictEqual(cfg.requireBankZeroField, expected, `${sub} 应补种 requireBankZeroField=${expected}`);
      // 其它字段不变
      assert.strictEqual(cfg.subCategory, sub);
      assert.strictEqual(cfg.funcCategory, 'fund-nature-check');
      assert.strictEqual(cfg.roundPhase, 4);
      // updated_at 应被刷新（命中补种行）
      assert.notStrictEqual(row.updated_at, '2026-01-01T00:00:00.000Z', `${sub} 补种行 updated_at 应刷新`);
    }
  });

  test('幂等：连跑两次稳定（第二次 updated=0、no-op，数据不再变化）', () => {
    createScenariosTable(db);
    seedAllFourR4Old(db);

    const r1 = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(r1.status, 'migrated');
    assert.strictEqual(r1.updated, 4);
    const afterFirst = getByName(db, '资金性质校验-Ach Return').config_json;

    const r2 = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(r2.status, 'no-op', '第二次应 no-op（4 条都已含字段）');
    assert.strictEqual(r2.scanned, 4, '仍扫描到 4 条（LIKE 命中）');
    assert.strictEqual(r2.updated, 0, '第二次不应再补种');

    const afterSecond = getByName(db, '资金性质校验-Ach Return').config_json;
    assert.strictEqual(afterFirst, afterSecond, '第二次跑数据应完全不变（幂等）');
  });

  test('🔴 不覆盖用户已改的值：requireBankZeroField 已存在（被改成另一列）→ 跳过不动', () => {
    createScenariosTable(db);
    // 用户把 ach-return 的方向守卫字段改成了 'Debit Amount'（非默认 'Credit Amount'）
    const userCfg = r4Config('ach-return', 'Ach Return', 'AchReturn');
    userCfg.requireBankZeroField = 'Debit Amount';
    insertScenario(db, { name: '资金性质校验-Ach Return', priority: 3, config: userCfg, updatedAt: '2026-05-05T00:00:00.000Z' });

    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.status, 'no-op', '已存在字段 → 不补种');
    assert.strictEqual(res.scanned, 1);
    assert.strictEqual(res.updated, 0);

    const row = getByName(db, '资金性质校验-Ach Return');
    const cfg = JSON.parse(row.config_json);
    assert.strictEqual(cfg.requireBankZeroField, 'Debit Amount', '🔴 不应覆盖用户改的值');
    assert.strictEqual(row.updated_at, '2026-05-05T00:00:00.000Z', '未命中补种 → updated_at 不变');
  });

  test('🔴 不覆盖用户已改的值：requireBankZeroField 被用户清空成空串 \'\' → 仍跳过（用 hasOwnProperty 判存在）', () => {
    createScenariosTable(db);
    const userCfg = r4Config('wire-return', 'Wire Return', 'WireReturn');
    userCfg.requireBankZeroField = ''; // 用户清空（关掉该场景的方向守卫）
    insertScenario(db, { name: '资金性质校验-Wire Return', priority: 2, config: userCfg, updatedAt: '2026-06-06T00:00:00.000Z' });

    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.updated, 0, '空串也算"已存在" → 不补回（尊重用户关闭意图）');

    const cfg = JSON.parse(getByName(db, '资金性质校验-Wire Return').config_json);
    assert.strictEqual(cfg.requireBankZeroField, '', '🔴 空串应保留、不被补回成 Debit Amount');
  });

  test('混合：部分 R4 缺字段补、部分已有跳过', () => {
    createScenariosTable(db);
    // ach-return 缺字段（应补 Credit Amount）；hx-in 已有用户值（应保留）
    insertScenario(db, { name: '资金性质校验-Ach Return', priority: 3, config: r4Config('ach-return', 'Ach Return', 'AchReturn') });
    const hxinCfg = r4Config('hx-in', 'HX-in', 'HX_INBOUND');
    hxinCfg.requireBankZeroField = 'Credit Amount'; // 用户故意设成非默认
    insertScenario(db, { name: '资金性质校验-HX-in', priority: 0, config: hxinCfg });

    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.status, 'migrated');
    assert.strictEqual(res.scanned, 2, '扫描到 ach-return + hx-in');
    assert.strictEqual(res.updated, 1, '仅 ach-return 补种');

    assert.strictEqual(JSON.parse(getByName(db, '资金性质校验-Ach Return').config_json).requireBankZeroField, 'Credit Amount');
    assert.strictEqual(JSON.parse(getByName(db, '资金性质校验-HX-in').config_json).requireBankZeroField, 'Credit Amount', '用户值保留');
  });

  test('不误伤：非 R4 场景（subCategory 不在 4 个之列）config 完全不动', () => {
    createScenariosTable(db);
    // R5 退款回填场景（platform-order，不在 4 个 R4 之列）
    insertScenario(db, {
      name: '中台退款订单回填',
      priority: 0,
      config: { funcCategory: 'platform-order', subCategory: 'refund-order-backfill', roundPhase: 5 },
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    // 用户自建 offset-bill-mark 场景
    insertScenario(db, {
      name: '我的打标场景',
      category: 'offset-bill-mark',
      isBuiltin: 0,
      config: { funcCategory: 'offset-bill-mark', markValue: { value: 'Inbound' } },
      updatedAt: '2026-02-02T00:00:00.000Z',
    });

    const before1 = getByName(db, '中台退款订单回填');
    const before2 = getByName(db, '我的打标场景');

    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.status, 'no-op', '无 R4 场景 → no-op');
    assert.strictEqual(res.scanned, 0, '无 R4 子场景被 LIKE 命中');
    assert.strictEqual(res.updated, 0);

    const after1 = getByName(db, '中台退款订单回填');
    const after2 = getByName(db, '我的打标场景');
    assert.strictEqual(after1.config_json, before1.config_json, 'R5 场景 config 不变');
    assert.strictEqual(after1.updated_at, before1.updated_at, 'R5 场景 updated_at 不变');
    assert.strictEqual(after2.config_json, before2.config_json, '用户场景 config 不变');
    assert.strictEqual(after2.updated_at, before2.updated_at, '用户场景 updated_at 不变');
    // R5 场景不应被塞进 requireBankZeroField
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(after1.config_json), 'requireBankZeroField'), 'R5 场景不应被加方向守卫字段');
  });

  test('不误伤 + 补种共存：4 个 R4 补字段，非 R4 场景不动', () => {
    createScenariosTable(db);
    seedAllFourR4Old(db);
    insertScenario(db, {
      name: '中台调拨订单对账ID回填',
      priority: 0,
      config: { funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill', roundPhase: 5 },
      updatedAt: '2026-03-03T00:00:00.000Z',
    });

    const beforeR5 = getByName(db, '中台调拨订单对账ID回填');
    const res = ensureR4DirectionGuardConfigMigration(db);
    assert.strictEqual(res.updated, 4, '4 个 R4 补种');

    const afterR5 = getByName(db, '中台调拨订单对账ID回填');
    assert.strictEqual(afterR5.config_json, beforeR5.config_json, 'R5 场景不受影响');
    assert.strictEqual(afterR5.updated_at, beforeR5.updated_at);
  });

  test('scenarios 表不存在（极早期启动）→ no-op 不抛错', () => {
    // 不建表
    let res;
    assert.doesNotThrow(() => { res = ensureR4DirectionGuardConfigMigration(db); });
    assert.deepStrictEqual(res, { status: 'no-op', scanned: 0, updated: 0 });
  });

  test('非法 JSON config（防御）→ 跳过不抛错、不补种', () => {
    createScenariosTable(db);
    // config_json 含 "subCategory":"ach-return" 文本以命中 LIKE，但整体非法 JSON
    insertScenario(db, {
      name: '坏JSON-ach',
      priority: 3,
      rawConfigJson: '{"subCategory":"ach-return", BROKEN',
    });

    let res;
    assert.doesNotThrow(() => { res = ensureR4DirectionGuardConfigMigration(db); });
    assert.strictEqual(res.scanned, 1, 'LIKE 命中 1 行');
    assert.strictEqual(res.updated, 0, '非法 JSON 跳过 → 不补种');
    // 原始 config_json 不变
    assert.strictEqual(getByName(db, '坏JSON-ach').config_json, '{"subCategory":"ach-return", BROKEN');
  });
});

test.describe('v3.0.23 ensureR4StrictDescriptionMigration', () => {
  test('老库四个内置场景只刷新 function，保留其它配置并保持幂等', () => {
    createScenariosTable(db);
    seedAllFourR4Old(db);
    const before = JSON.parse(getByName(db, '资金性质校验-Ach Return').config_json);

    const first = ensureR4StrictDescriptionMigration(db);
    assert.deepStrictEqual(first, { status: 'migrated', scanned: 4, updated: 4 });

    const names = {
      'ach-return': '资金性质校验-Ach Return',
      'wire-return': '资金性质校验-Wire Return',
      'hx-out': '资金性质校验-HX-out',
      'hx-in': '资金性质校验-HX-in'
    };
    for (const [subCategory, name] of Object.entries(names)) {
      const config = JSON.parse(getByName(db, name).config_json);
      assert.strictEqual(config.function, R4_STRICT_FUNCTION_BY_SUBCATEGORY[subCategory]);
      assert.strictEqual(config.subCategory, subCategory);
      assert.strictEqual(config.funcCategory, 'fund-nature-check');
    }
    const after = JSON.parse(getByName(db, '资金性质校验-Ach Return').config_json);
    assert.strictEqual(after.gwTradeType, before.gwTradeType, '历史展示字段保留');
    assert.strictEqual(after.setFundType, before.setFundType, '历史展示字段保留');
    assert.deepStrictEqual(after.involvedFiles, before.involvedFiles, '其它配置保留');

    const second = ensureR4StrictDescriptionMigration(db);
    assert.deepStrictEqual(second, { status: 'no-op', scanned: 4, updated: 0 });
  });

  test('不修改非内置、非 fund-nature-check、非法 JSON 或其它 subCategory', () => {
    createScenariosTable(db);
    insertScenario(db, {
      name: '用户Ach场景',
      isBuiltin: 0,
      config: r4Config('ach-return', 'Ach Return', 'AchReturn')
    });
    insertScenario(db, {
      name: '伪R4场景',
      config: { funcCategory: 'platform-order', subCategory: 'ach-return', function: '原说明' }
    });
    insertScenario(db, {
      name: '其它内置场景',
      config: { funcCategory: 'fund-nature-check', subCategory: 'other', function: '原说明' }
    });
    insertScenario(db, {
      name: '坏JSON内置场景',
      rawConfigJson: '{"funcCategory":"fund-nature-check","subCategory":"ach-return",broken'
    });

    const before = db.prepare('SELECT name, config_json, updated_at FROM scenarios ORDER BY id').all();
    const result = ensureR4StrictDescriptionMigration(db);
    const after = db.prepare('SELECT name, config_json, updated_at FROM scenarios ORDER BY id').all();
    assert.strictEqual(result.updated, 0);
    assert.deepStrictEqual(after, before);
  });

  test('scenarios 表不存在时 no-op', () => {
    assert.deepStrictEqual(
      ensureR4StrictDescriptionMigration(db),
      { status: 'no-op', scanned: 0, updated: 0 }
    );
  });
});
