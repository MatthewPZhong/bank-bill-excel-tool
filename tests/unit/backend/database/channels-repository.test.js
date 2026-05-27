const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const channelsRepo = require('../../../../src/backend/database/channels-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport,
} = require('../../../../src/backend/database/migrations');

let tmpDir;
let dbPath;
let db;

function setupDb() {
  // app_settings 表（migrations 依赖）
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureScenariosSupport(db);
  ensureChannelsTable(db);
  ensureScenariosChannelIdColumn(db);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-repo-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  setupDb();
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('listChannels', () => {
  test('启动期自动有「通用」内置渠道（id=1, displayIndex=1, label=「通用」）', () => {
    // 单渠道场景下，「通用」即唯一行，displayIndex 自然 = 1
    const list = channelsRepo.listChannels(db);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 1);
    assert.strictEqual(list[0].name, '通用');
    assert.strictEqual(list[0].ownerLocation, '通用');
    assert.strictEqual(list[0].isBuiltin, true);
    assert.strictEqual(list[0].displayIndex, 1);
    // 2026-05-27 fix1-N5-UI-6.2：is_builtin=1 label 退化为 name（不再「通用-通用」）
    assert.strictEqual(list[0].label, '通用');
  });

  test('多渠道排序：自定义渠道（新增的在前） → 通用最下；displayIndex 1-based', () => {
    // 2026-05-27 fix1-N5-UI-6.3：ORDER BY is_builtin ASC, sort_order DESC, id DESC
    // 创建顺序：招商-北京（id=2, sort=1） → 工商-上海（id=3, sort=2）
    // 期望顺序：工商-上海（最新建 sort=2）→ 招商-北京（sort=1）→ 通用（is_builtin=1 殿后）
    channelsRepo.createChannel(db, { name: '招商', ownerLocation: '北京' });
    channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    const list = channelsRepo.listChannels(db);
    assert.strictEqual(list.length, 3);
    // 自定义渠道：新建的工商-上海 在最上
    assert.strictEqual(list[0].name, '工商');
    assert.strictEqual(list[0].ownerLocation, '上海');
    assert.strictEqual(list[0].displayIndex, 1);
    assert.strictEqual(list[0].isBuiltin, false);
    // 较早创建的招商-北京 在中间
    assert.strictEqual(list[1].name, '招商');
    assert.strictEqual(list[1].ownerLocation, '北京');
    assert.strictEqual(list[1].displayIndex, 2);
    // 「通用」始终在最下
    assert.strictEqual(list[2].id, 1);
    assert.strictEqual(list[2].name, '通用');
    assert.strictEqual(list[2].displayIndex, 3);
    assert.strictEqual(list[2].isBuiltin, true);
    assert.strictEqual(list[2].label, '通用');
  });
});

test.describe('findByNameAndLocation', () => {
  test('命中返回 channel 对象', () => {
    const ch = channelsRepo.findByNameAndLocation(db, '通用', '通用');
    assert.ok(ch);
    assert.strictEqual(ch.id, 1);
  });

  test('未命中返回 null', () => {
    const ch = channelsRepo.findByNameAndLocation(db, '不存在', '北京');
    assert.strictEqual(ch, null);
  });

  test('trim 后匹配（含前后空格）', () => {
    channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    const ch = channelsRepo.findByNameAndLocation(db, '  工商  ', '  上海  ');
    assert.ok(ch);
    assert.strictEqual(ch.name, '工商');
  });
});

test.describe('getBuiltinGeneral', () => {
  test('返回「通用」', () => {
    const general = channelsRepo.getBuiltinGeneral(db);
    assert.strictEqual(general.id, 1);
    assert.strictEqual(general.name, '通用');
  });
});

test.describe('createChannel', () => {
  test('正常创建', () => {
    const ch = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    assert.ok(ch.id > 1);
    assert.strictEqual(ch.name, '工商');
    assert.strictEqual(ch.isBuiltin, false);
  });

  test('UNIQUE 约束 — 重复 (name, location) 抛错', () => {
    channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    assert.throws(
      () => channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' }),
      /已存在/
    );
  });

  test('同名不同地区允许（UNIQUE 是联合键）', () => {
    channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    const ch2 = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '北京' });
    assert.strictEqual(ch2.ownerLocation, '北京');
  });

  test('名称为空抛错', () => {
    assert.throws(
      () => channelsRepo.createChannel(db, { name: '', ownerLocation: '上海' }),
      /渠道名称不能为空/
    );
  });

  test('开户地为空抛错', () => {
    assert.throws(
      () => channelsRepo.createChannel(db, { name: '工商', ownerLocation: '' }),
      /开户地不能为空/
    );
  });

  test('名称超长抛错', () => {
    assert.throws(
      () => channelsRepo.createChannel(db, { name: 'a'.repeat(101), ownerLocation: '上海' }),
      /长度不能超过 100/
    );
  });
});

test.describe('updateChannel', () => {
  test('正常修改名称 + 开户地', () => {
    const ch = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    const updated = channelsRepo.updateChannel(db, ch.id, { name: '工商银行', ownerLocation: '北京' });
    assert.strictEqual(updated.name, '工商银行');
    assert.strictEqual(updated.ownerLocation, '北京');
  });

  test('「通用」内置不可修改', () => {
    assert.throws(
      () => channelsRepo.updateChannel(db, 1, { name: '通用-改' }),
      /系统内置「通用」渠道不可修改/
    );
  });

  test('不存在的 id 抛错', () => {
    assert.throws(
      () => channelsRepo.updateChannel(db, 999, { name: 'x' }),
      /id=999 不存在/
    );
  });
});

test.describe('deleteChannel', () => {
  test('正常删除无下属 scenarios 的渠道', () => {
    const ch = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    const ok = channelsRepo.deleteChannel(db, ch.id);
    assert.strictEqual(ok, true);
    assert.strictEqual(channelsRepo.getChannelById(db, ch.id), null);
  });

  test('「通用」内置不可删除', () => {
    assert.throws(
      () => channelsRepo.deleteChannel(db, 1),
      /系统内置「通用」渠道不可删除/
    );
  });

  test('有下属 scenarios 阻止删除（spec §3.2 b）', () => {
    const ch = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
    // 插入测试 scenario 关联到该渠道
    db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id)
      VALUES ('extract-recon-id', 'test', 0, 1, '{}', 0, ?, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString(), ch.id);

    assert.throws(
      () => channelsRepo.deleteChannel(db, ch.id),
      /该渠道下有 1 个场景，请先转移或删除/
    );
  });
});
