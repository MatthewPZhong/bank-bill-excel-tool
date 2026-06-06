// v2.1.13 D-3/D-4：自带写死场景（builtin-fixed）数据层迁移回归测试
//   覆盖：场景归类 / CHECK 5→6 值扩展 / 老库无损升级 / 迁移幂等 / 已删场景不复活 /
//        无 channel_id 防御 / 场景-渠道多对多表
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
  hasColumn,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');
const scenariosRepository = require('../../../../src/backend/database/scenarios-repository');

let tmpDir;
let dbPath;
let backupDir;
let db;

// v2.1.13（增量）：场景重命名后新名
const EXTRACT_NAME = '从银行对账单的信息里提取调拨订单对账ID';

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

// 只到 5 值（不跑 N5）：模拟 v2.1.0-beta.3 老库（无 channels 表、无 channel_id 列）
function bootstrapV210Schema(currentDb) {
  bootstrapAppSettings(currentDb);
  ensureScenariosSupport(currentDb); // 建表 3 值 + seed 3 内置场景（含 extract-recon-id 提取场景 priority 3）
  ensureScenariosCategoryReconIdFix(currentDb); // →4 值
  ensureScenariosCategoryGatewayReconIdFix(currentDb); // →5 值
}

// 带到 v2.1.12「最终态」：5 值 CHECK + channel_id + 复合 UNIQUE(channel_id, name) + seed 3 内置场景
function bootstrapFinalState(currentDb, backupFn) {
  bootstrapV210Schema(currentDb);
  ensureSchemaV2_1_9_N5(currentDb, backupFn); // channels 表 + channel_id 列 + backfill 1
  ensureScenariosNameUniqueByChannelId(currentDb, backupFn); // →复合 UNIQUE(channel_id, name)
}

// 跑 v2.1.13 三个新迁移（init 链中 SR-FIX-1 之后的顺序）
function runBuiltinFixedMigrations(currentDb) {
  ensureScenariosCategoryBuiltinFixed(currentDb);
  ensureBuiltinFixedScenarioNameUpdate(currentDb);
  ensureBuiltinFixedScenarioMigration(currentDb);
  ensureScenarioApplicableChannelsTable(currentDb);
}

function scenariosTableSql(currentDb) {
  return currentDb
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'")
    .get().sql;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-fixed-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.13 builtin-fixed 数据层迁移', () => {
  test('最终态库 → 内置提取场景归入 builtin-fixed（category/priority/channel_id）+ config 保持 + 其他场景不变', () => {
    bootstrapFinalState(db, makeBackupFn());

    // 迁移前：提取场景仍是 extract-recon-id / priority 3
    const before = db.prepare('SELECT category, priority FROM scenarios WHERE name = ?').get(EXTRACT_NAME);
    assert.strictEqual(before.category, 'extract-recon-id');
    assert.strictEqual(before.priority, 3);

    runBuiltinFixedMigrations(db);

    // CHECK 含 builtin-fixed
    assert.ok(scenariosTableSql(db).includes("'builtin-fixed'"), 'CHECK 应含 builtin-fixed');

    // 提取场景归类
    const after = db
      .prepare('SELECT category, priority, channel_id, is_builtin, config_json FROM scenarios WHERE name = ?')
      .get(EXTRACT_NAME);
    assert.strictEqual(after.category, 'builtin-fixed');
    assert.strictEqual(after.priority, 0);
    assert.strictEqual(after.channel_id, 1);
    assert.strictEqual(after.is_builtin, 1);

    // config.extractByFeature 保持不变（D-5：执行仍跑提取逻辑）
    const config = JSON.parse(after.config_json);
    assert.strictEqual(config.extractByFeature.featureCode, 'FT');
    assert.strictEqual(config.extractByFeature.digitCount, 12);
    assert.strictEqual(config.extractByFeature.totalLength, 15);

    // 其他 2 个内置场景 category 不变
    const others = db.prepare('SELECT category FROM scenarios WHERE name != ?').all(EXTRACT_NAME);
    const cats = others.map((r) => r.category).sort();
    assert.deepStrictEqual(cats, ['gateway-recon-join', 'offset-bill-mark'].sort());

    // 多对多表存在
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scenario_applicable_channels'")
      .get();
    assert.ok(tbl, 'scenario_applicable_channels 表应存在');
  });

  test('老库旧名场景 → 迁移后改为新名 + 归入 builtin-fixed/priority 0', () => {
    bootstrapFinalState(db, makeBackupFn());
    // 模拟老库：把 seed 场景还原成旧名 + extract-recon-id + priority 3（未改名/未归类的老库状态）
    db.prepare(
      "UPDATE scenarios SET name = '从银行对账单的信息里提取对账ID', category = 'extract-recon-id', priority = 3 WHERE name = ?"
    ).run(EXTRACT_NAME);

    runBuiltinFixedMigrations(db);

    // 旧名应已不存在（迁移成新名）
    const oldCnt = db.prepare("SELECT COUNT(*) AS c FROM scenarios WHERE name = '从银行对账单的信息里提取对账ID'").get().c;
    assert.strictEqual(oldCnt, 0, '旧名应已迁移为新名');
    // 新名场景归入 builtin-fixed / priority 0
    const renamed = db.prepare('SELECT category, priority FROM scenarios WHERE name = ?').get(EXTRACT_NAME);
    assert.ok(renamed, '应存在新名场景');
    assert.strictEqual(renamed.category, 'builtin-fixed');
    assert.strictEqual(renamed.priority, 0);
  });

  // v2.1.13 PR#58 review P2-B：迁移改用 is_builtin + config.extractByFeature 定位（不依赖 name）
  test('用户改过名的内置提取场景 → 按 config 定位仍归入 builtin-fixed（P2-B 不依赖 name）', () => {
    bootstrapFinalState(db, makeBackupFn());
    // 模拟用户把内置提取场景改成自定义名（is_builtin=1 + extract-recon-id + config.extractByFeature 保持）
    db.prepare(
      "UPDATE scenarios SET name = '我的自定义提取场景', category = 'extract-recon-id', priority = 3 WHERE name = ?"
    ).run(EXTRACT_NAME);

    runBuiltinFixedMigrations(db);

    // 按 config 定位迁移成功（即使名既非旧名也非新名）
    const renamed = db
      .prepare("SELECT category, priority, channel_id FROM scenarios WHERE name = '我的自定义提取场景'")
      .get();
    assert.ok(renamed, '改名场景应仍存在');
    assert.strictEqual(renamed.category, 'builtin-fixed', '应按 config.extractByFeature 定位迁入 builtin-fixed');
    assert.strictEqual(renamed.priority, 0);
    assert.strictEqual(renamed.channel_id, 1);
  });

  test('新名已被同渠道占用（nameUpdate 撞 UNIQUE）→ migration 仍按 config 迁内置场景（P2-B + Codex）', () => {
    bootstrapFinalState(db, makeBackupFn());
    // 内置提取场景还原为旧名（未改名/未归类的老库）
    db.prepare(
      "UPDATE scenarios SET name = '从银行对账单的信息里提取对账ID', category = 'extract-recon-id', priority = 3 WHERE name = ?"
    ).run(EXTRACT_NAME);
    // 同 channel_id=1 用户新建一个非内置场景占用新名 → 使 nameUpdate（旧名→新名）撞 (channel_id,name) UNIQUE
    db.prepare(
      `INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
       VALUES ('offset-bill-mark', ?, 2, 1, '{}', 0, 1, ?, ?)`
    ).run(EXTRACT_NAME, new Date().toISOString(), new Date().toISOString());

    runBuiltinFixedMigrations(db);

    // 内置提取场景（nameUpdate 因 UNIQUE 失败 → 名仍旧名）仍被 migration 按 config 迁入 builtin-fixed
    const builtin = db
      .prepare("SELECT category, priority FROM scenarios WHERE is_builtin = 1 AND config_json LIKE '%extractByFeature%'")
      .get();
    assert.ok(builtin, '内置提取场景应存在');
    assert.strictEqual(builtin.category, 'builtin-fixed', 'nameUpdate UNIQUE 失败不应阻止 category 迁移');
    assert.strictEqual(builtin.priority, 0);
    // 用户占名场景不被误迁（config 无 extractByFeature）
    const userScn = db.prepare('SELECT category FROM scenarios WHERE name = ? AND is_builtin = 0').get(EXTRACT_NAME);
    assert.strictEqual(userScn.category, 'offset-bill-mark', '用户场景不应被误迁');
  });

  test('CHECK 扩展：迁移前 INSERT builtin-fixed 抛错；迁移后可成功', () => {
    bootstrapFinalState(db, makeBackupFn());
    const now = new Date().toISOString();
    const insertSql =
      "INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id) VALUES ('builtin-fixed', 'X', 0, 1, '{}', 0, ?, ?, 1)";

    assert.throws(() => db.prepare(insertSql).run(now, now), /CHECK|constraint/i);

    ensureScenariosCategoryBuiltinFixed(db);

    db.prepare(insertSql).run(now, now);
    const row = db.prepare("SELECT category FROM scenarios WHERE name = 'X'").get();
    assert.strictEqual(row.category, 'builtin-fixed');
  });

  test('幂等：三个新迁移跑两次结果一致，行数不变', () => {
    bootstrapFinalState(db, makeBackupFn());
    runBuiltinFixedMigrations(db);
    assert.doesNotThrow(() => runBuiltinFixedMigrations(db));

    const after = db.prepare('SELECT category, priority FROM scenarios WHERE name = ?').get(EXTRACT_NAME);
    assert.strictEqual(after.category, 'builtin-fixed');
    assert.strictEqual(after.priority, 0);
    const count = db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c;
    assert.strictEqual(count, 3);
  });

  test('老库升级无损：5 值老库（含用户自建场景）经新迁移 → 数据/id 全保留 + 提取场景归类', () => {
    bootstrapFinalState(db, makeBackupFn());
    // 模拟用户在通用渠道自建一个 offset-bill-mark 场景
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id) VALUES ('offset-bill-mark', '我的自建场景', 2, 1, '{\"billTypes\":[]}', 0, ?, ?, 1)"
    ).run(now, now);
    const userIdBefore = db.prepare("SELECT id FROM scenarios WHERE name = '我的自建场景'").get().id;
    const totalBefore = db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c;

    runBuiltinFixedMigrations(db);

    // 行数不变（重建表无损）
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM scenarios').get().c, totalBefore);
    // 用户场景 id 保留
    const userAfter = db.prepare("SELECT id, category, priority FROM scenarios WHERE name = '我的自建场景'").get();
    assert.strictEqual(userAfter.id, userIdBefore);
    assert.strictEqual(userAfter.category, 'offset-bill-mark');
    assert.strictEqual(userAfter.priority, 2);
    // 提取场景归类
    assert.strictEqual(db.prepare('SELECT category FROM scenarios WHERE name = ?').get(EXTRACT_NAME).category, 'builtin-fixed');
  });

  test('用户已删提取场景 → ensureBuiltinFixedScenarioMigration 不复活', () => {
    bootstrapFinalState(db, makeBackupFn());
    db.prepare('DELETE FROM scenarios WHERE name = ?').run(EXTRACT_NAME); // 模拟 D14 删除终态
    runBuiltinFixedMigrations(db);
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM scenarios WHERE name = ?').get(EXTRACT_NAME).c;
    assert.strictEqual(cnt, 0, '已删场景不应复活');
  });

  test('防御：无 channel_id 列（N5 未完成）→ ensureScenariosCategoryBuiltinFixed 跳过不报错', () => {
    bootstrapV210Schema(db); // 只到 5 值，无 channel_id
    assert.strictEqual(hasColumn(db, 'scenarios', 'channel_id'), false);
    assert.doesNotThrow(() => ensureScenariosCategoryBuiltinFixed(db));
    assert.ok(!scenariosTableSql(db).includes("'builtin-fixed'"), '无 channel_id 时应跳过重建');
  });

  test('多对多表：FK + 复合主键可插入/查询，重复插入抛错', () => {
    bootstrapFinalState(db, makeBackupFn());
    runBuiltinFixedMigrations(db);
    const sid = db.prepare('SELECT id FROM scenarios WHERE name = ?').get(EXTRACT_NAME).id;

    db.prepare(
      "INSERT INTO channels (id, name, owner_location, is_builtin, sort_order, created_at) VALUES (2, 'ICBC', '上海', 0, 1, CURRENT_TIMESTAMP)"
    ).run();
    db.prepare('INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, 1)').run(sid);
    db.prepare('INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, 2)').run(sid);

    const rows = db
      .prepare('SELECT channel_id FROM scenario_applicable_channels WHERE scenario_id = ? ORDER BY channel_id')
      .all(sid);
    assert.deepStrictEqual(rows.map((r) => r.channel_id), [1, 2]);

    // 复合主键：重复插入抛错
    assert.throws(
      () => db.prepare('INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, 1)').run(sid),
      /UNIQUE|PRIMARY|constraint/i
    );
  });
});

test.describe('v2.1.13 适用渠道 repository（getApplicable / setApplicable / listBuiltinFixedForChannel）', () => {
  function setupWithBuiltinFixed() {
    bootstrapFinalState(db, makeBackupFn());
    runBuiltinFixedMigrations(db);
    db.prepare(
      "INSERT INTO channels (id, name, owner_location, is_builtin, sort_order, created_at) VALUES (2, 'ICBC', '上海', 0, 1, CURRENT_TIMESTAMP)"
    ).run();
    return db.prepare('SELECT id FROM scenarios WHERE name = ?').get(EXTRACT_NAME).id;
  }

  test('getApplicableChannelIds：无关联 → 空数组（= 全部）', () => {
    const sid = setupWithBuiltinFixed();
    assert.deepStrictEqual(scenariosRepository.getApplicableChannelIds(db, sid), []);
  });

  test('setApplicableChannelIds：写入后 get 返回升序数组 + 去重', () => {
    const sid = setupWithBuiltinFixed();
    scenariosRepository.setApplicableChannelIds(db, sid, [2, 1, 2]); // 含重复 + 乱序
    assert.deepStrictEqual(scenariosRepository.getApplicableChannelIds(db, sid), [1, 2]);
  });

  test('setApplicableChannelIds：空数组 → 清空（回到全部语义）', () => {
    const sid = setupWithBuiltinFixed();
    scenariosRepository.setApplicableChannelIds(db, sid, [2]);
    assert.deepStrictEqual(scenariosRepository.getApplicableChannelIds(db, sid), [2]);
    scenariosRepository.setApplicableChannelIds(db, sid, []);
    assert.deepStrictEqual(scenariosRepository.getApplicableChannelIds(db, sid), []);
  });

  test('listBuiltinFixedForChannel：无关联（全部）→ 任意渠道命中 + 含 config', () => {
    const sid = setupWithBuiltinFixed();
    const ch1 = scenariosRepository.listBuiltinFixedForChannel(db, 1);
    const ch2 = scenariosRepository.listBuiltinFixedForChannel(db, 2);
    assert.strictEqual(ch1.length, 1);
    assert.strictEqual(ch2.length, 1);
    assert.strictEqual(ch1[0].id, sid);
    assert.ok(ch1[0].config && ch1[0].config.extractByFeature, 'dispatcher 需要 config');
  });

  test('listBuiltinFixedForChannel：限定渠道 → 仅该渠道命中', () => {
    const sid = setupWithBuiltinFixed();
    scenariosRepository.setApplicableChannelIds(db, sid, [2]); // 仅适用渠道 2
    assert.strictEqual(scenariosRepository.listBuiltinFixedForChannel(db, 2).length, 1);
    assert.strictEqual(scenariosRepository.listBuiltinFixedForChannel(db, 1).length, 0);
  });

  test('listBuiltinFixedForChannel：disabled 场景不返回', () => {
    const sid = setupWithBuiltinFixed();
    db.prepare('UPDATE scenarios SET enabled = 0 WHERE id = ?').run(sid);
    assert.strictEqual(scenariosRepository.listBuiltinFixedForChannel(db, 1).length, 0);
  });
});
