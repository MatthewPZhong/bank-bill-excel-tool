// v2.1.9 N5：channels:* IPC handler 单元测试
//
// 测试策略：channels:list / create / update / delete 4 个 handler 是 thin wrapper：
//   handler(database, ...args) → { status: 'ok' | 'failed', ... }
//
// main.js 内闭包风格难以直接 import，本测试用同构 sham 函数复刻 handler 主体逻辑：
//   - try { database.xxxChannel(...) } catch → { status: 'failed', message: error.message }
//   - 成功路径包 { status: 'ok', ... }
// 这样能保证 IPC 包装语义（status 转换 + error.message 安全 toString）一致。
//
// AppDatabase 用真实 SQLite in-memory（:memory: 不行，因为 backup 需要文件路径；用 tmpdir 文件）
// 不需要走 Electron，跳过 trackedIpcHandle 统计逻辑（仅业务包装层是 channels 关心的）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../../../src/backend/database');

// ---- IPC handler 同构函数（与 src/main.js 行 ~2931+ 中 channels:* 4 个 handler 一致）----
//
// 注意：main.js 中 trackedIpcHandle 第 4 个参数是 handler；这里抽出 handler 内部主体。
// 用户验证：grep 'channels:list\|channels:create\|channels:update\|channels:delete' src/main.js
// 与本文件 handler 主体逻辑必须一致。

function handlerChannelsList(database) {
  try {
    return { status: 'ok', channels: database.listChannels() };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerChannelsCreate(database, payload) {
  try {
    const channel = database.createChannel(payload || {});
    return { status: 'ok', channel };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerChannelsUpdate(database, id, fields) {
  try {
    const channel = database.updateChannel(id, fields || {});
    return { status: 'ok', channel };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerChannelsDelete(database, id) {
  try {
    database.deleteChannel(id);
    return { status: 'ok', id };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

// ---- 测试上下文 ----

let tmpDir;
let database;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-ipc-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  database = new AppDatabase(dbPath);
  database.init(); // 触发 N5 migration → channels 表 + 「通用」自动建出
});

test.afterEach(() => {
  if (database && database.db) {
    try { database.db.close(); } catch (_) {}
  }
  database = null;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

// ---- channels:list ----

test.describe('channels:list handler', () => {
  test('成功路径返回 status=ok + channels 数组', () => {
    const result = handlerChannelsList(database);
    assert.strictEqual(result.status, 'ok');
    assert.ok(Array.isArray(result.channels));
    assert.ok(result.channels.length >= 1);
    // 「通用」应在列表中
    const general = result.channels.find((c) => c.id === 1);
    assert.ok(general);
    assert.strictEqual(general.name, '通用');
    assert.strictEqual(general.isBuiltin, true);
    assert.strictEqual(general.displayIndex, 1);
  });

  test('database 异常 → status=failed + 携带 message', () => {
    // mock database 让 listChannels 抛错
    const brokenDb = { listChannels: () => { throw new Error('mock list failure'); } };
    const result = handlerChannelsList(brokenDb);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /mock list failure/);
  });

  test('list 包含新创建的渠道（2026-05-27 fix1-N5-UI-6.3：自定义新增最上，通用最下）', () => {
    handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' });
    handlerChannelsCreate(database, { name: '招商', ownerLocation: '北京' });
    const result = handlerChannelsList(database);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.channels.length, 3);
    // displayIndex 1-based
    assert.strictEqual(result.channels[0].displayIndex, 1);
    assert.strictEqual(result.channels[1].displayIndex, 2);
    assert.strictEqual(result.channels[2].displayIndex, 3);
    // 新增渠道在前，通用排最下
    assert.strictEqual(result.channels[0].name, '招商');
    assert.strictEqual(result.channels[0].isBuiltin, false);
    assert.strictEqual(result.channels[1].name, '工商');
    assert.strictEqual(result.channels[2].name, '通用');
    assert.strictEqual(result.channels[2].isBuiltin, true);
  });
});

// ---- channels:create ----

test.describe('channels:create handler', () => {
  test('正常创建返回 status=ok + channel 对象', () => {
    const result = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' });
    assert.strictEqual(result.status, 'ok');
    assert.ok(result.channel);
    assert.ok(result.channel.id > 1);
    assert.strictEqual(result.channel.name, '工商');
    assert.strictEqual(result.channel.ownerLocation, '上海');
    assert.strictEqual(result.channel.isBuiltin, false);
  });

  test('重复 (name, location) → status=failed', () => {
    handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' });
    const r2 = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' });
    assert.strictEqual(r2.status, 'failed');
    assert.match(r2.message, /已存在/);
  });

  test('名称为空 → status=failed', () => {
    const r = handlerChannelsCreate(database, { name: '', ownerLocation: '上海' });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /渠道名称不能为空/);
  });

  test('开户地为空 → status=failed', () => {
    const r = handlerChannelsCreate(database, { name: '工商', ownerLocation: '' });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /开户地不能为空/);
  });

  test('payload 为 null → status=failed（参数默认 {} 兜底但缺名称还是抛）', () => {
    const r = handlerChannelsCreate(database, null);
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /渠道名称不能为空/);
  });
});

// ---- channels:update ----

test.describe('channels:update handler', () => {
  test('正常修改返回 status=ok + 更新后的 channel', () => {
    const c = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' }).channel;
    const result = handlerChannelsUpdate(database, c.id, { name: '工商银行', ownerLocation: '北京' });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.channel.name, '工商银行');
    assert.strictEqual(result.channel.ownerLocation, '北京');
  });

  test('修改「通用」(id=1) → status=failed', () => {
    const r = handlerChannelsUpdate(database, 1, { name: '通用-改' });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /系统内置「通用」渠道不可修改/);
  });

  test('id 不存在 → status=failed', () => {
    const r = handlerChannelsUpdate(database, 9999, { name: 'x' });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /id=9999 不存在/);
  });

  test('fields 为 null → status=ok（兜底空对象后 updateChannel 字段全用现值，noop 等价）', () => {
    const c = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' }).channel;
    const r = handlerChannelsUpdate(database, c.id, null);
    // 传入 null → handler 兜底为 {} → updateChannel 校验 name=undefined → 沿用现 name → ok
    // 实际无字段变更等同于 noop
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.channel.name, '工商');
  });
});

// ---- channels:delete ----

test.describe('channels:delete handler', () => {
  test('正常删除无下属 scenarios 的渠道 → status=ok', () => {
    const c = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' }).channel;
    const r = handlerChannelsDelete(database, c.id);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.id, c.id);
  });

  test('删除「通用」(id=1) → status=failed', () => {
    const r = handlerChannelsDelete(database, 1);
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /系统内置「通用」渠道不可删除/);
  });

  test('删除有下属 scenarios 的渠道 → status=failed', () => {
    const c = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' }).channel;
    // 直接插 scenarios.channel_id = 新渠道
    const now = new Date().toISOString();
    database.db.prepare(`
      INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id)
      VALUES ('extract-recon-id', 'test-ipc', 0, 1, '{}', 0, ?, ?, ?)
    `).run(now, now, c.id);
    const r = handlerChannelsDelete(database, c.id);
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /该渠道下有 1 个场景/);
  });

  test('id 不存在 → status=failed', () => {
    const r = handlerChannelsDelete(database, 9999);
    assert.strictEqual(r.status, 'failed');
    assert.match(r.message, /id=9999 不存在/);
  });
});

// ---- 链路验证：list → create → update → delete → list ----

test.describe('完整 CRUD 链路', () => {
  test('list → create → list → update → list → delete → list', () => {
    // 初始：仅「通用」
    let r = handlerChannelsList(database);
    assert.strictEqual(r.channels.length, 1);

    // 创建工商-上海
    const created = handlerChannelsCreate(database, { name: '工商', ownerLocation: '上海' });
    assert.strictEqual(created.status, 'ok');
    const newId = created.channel.id;

    // list 现在 2 条
    r = handlerChannelsList(database);
    assert.strictEqual(r.channels.length, 2);

    // 更新
    handlerChannelsUpdate(database, newId, { name: '工商银行', ownerLocation: '北京' });
    r = handlerChannelsList(database);
    const updated = r.channels.find((c) => c.id === newId);
    assert.strictEqual(updated.name, '工商银行');
    assert.strictEqual(updated.ownerLocation, '北京');

    // 删除
    const del = handlerChannelsDelete(database, newId);
    assert.strictEqual(del.status, 'ok');

    // list 回到 1 条
    r = handlerChannelsList(database);
    assert.strictEqual(r.channels.length, 1);
  });
});
