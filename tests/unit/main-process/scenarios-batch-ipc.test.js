// v2.1.9 N5 Phase 5：scenarios:transfer / scenarios:batch-delete IPC handler 单元测试
//
// 测试策略（与 channels-ipc-handlers.test.js 同范式）：handler 是 thin wrapper：
//   handler(database, payload) → { status: 'ok' | 'failed', ... }
//
// main.js 内闭包风格难以直接 import，本测试用同构 sham 函数复刻 handler 主体逻辑：
//   - try { database.xxx(...) } catch → { status: 'failed', message: error.message }
//   - 成功路径包 { status: 'ok', ... }
// AppDatabase 用真实 SQLite tmpdir 文件（backup 需要文件路径）
// 不需要走 Electron，跳过 trackedIpcHandle 统计逻辑

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../../../src/backend/database');

// ---- IPC handler 同构函数（与 src/main.js 行 ~2934+ 中 scenarios:transfer / scenarios:batch-delete 一致）----
//
// 注意：main.js 中 trackedIpcHandle 第 4 个参数是 handler；这里抽出 handler 内部主体。
// 用户验证：grep 'scenarios:transfer\|scenarios:batch-delete' src/main.js
// 与本文件 handler 主体逻辑必须一致（双清缓存语义本测试不验，由集成测试覆盖）。

function handlerScenariosTransfer(database, payload) {
  try {
    const { scenarioIds, targetChannelId } = payload || {};
    const result = database.transferScenarios(scenarioIds, targetChannelId);
    return { status: 'ok', transferredCount: result.transferredCount, targetChannelId: result.targetChannelId };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function handlerScenariosBatchDelete(database, payload) {
  try {
    const { scenarioIds } = payload || {};
    const result = database.batchDeleteScenarios(scenarioIds);
    return { status: 'ok', deletedCount: result.deletedCount };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

// ---- 测试上下文 ----

let tmpDir;
let database;
let channels;

function createChannelFixtures() {
  return {
    general: { id: 1 }, // 「通用」内置渠道（init 时自动建）
    icbc_sh: database.createChannel({ name: '工商', ownerLocation: '上海' }),
    cmb_bj: database.createChannel({ name: '招商', ownerLocation: '北京' })
  };
}

function createScenarioFixture(name, channelId) {
  const result = database.createScenario({
    category: 'extract-recon-id',
    name,
    priority: 1,
    enabled: true,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }],
      extractByFeature: null,
      extractByOtherField: { field: 'CustomerRef' }
    }
  });
  // createScenario 不支持指定 channel_id，直接 UPDATE
  database.db.prepare('UPDATE scenarios SET channel_id = ? WHERE id = ?').run(channelId, result.id);
  return result;
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-batch-ipc-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  database = new AppDatabase(dbPath);
  database.init(); // 触发 N5 migration → channels 表 + 「通用」自动建出
  channels = createChannelFixtures();
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

// ---- scenarios:transfer ----

test.describe('scenarios:transfer handler', () => {
  test('单条转移：status=ok + transferredCount=1', () => {
    const s = createScenarioFixture('s1', channels.icbc_sh.id);
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [s.id],
      targetChannelId: channels.cmb_bj.id
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.transferredCount, 1);
    assert.strictEqual(result.targetChannelId, channels.cmb_bj.id);
  });

  test('批量转移：3 条场景一次搬运到目标渠道', () => {
    const s1 = createScenarioFixture('s1', channels.icbc_sh.id);
    const s2 = createScenarioFixture('s2', channels.icbc_sh.id);
    const s3 = createScenarioFixture('s3', channels.icbc_sh.id);
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [s1.id, s2.id, s3.id],
      targetChannelId: channels.cmb_bj.id
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.transferredCount, 3);
  });

  test('payload 为 null → status=failed', () => {
    const result = handlerScenariosTransfer(database, null);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /scenarioIds 必须是非空数组/);
  });

  test('scenarioIds 为空数组 → status=failed', () => {
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [],
      targetChannelId: channels.cmb_bj.id
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /scenarioIds 必须是非空数组/);
  });

  test('targetChannelId 不存在 → status=failed（事务回滚）', () => {
    const s = createScenarioFixture('s1', channels.icbc_sh.id);
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [s.id],
      targetChannelId: 99999
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /目标渠道 id=99999 不存在/);
  });

  test('其中一条 scenario id 不存在 → status=failed + 整批回滚', () => {
    const s1 = createScenarioFixture('s1', channels.icbc_sh.id);
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [s1.id, 99999],
      targetChannelId: channels.cmb_bj.id
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /场景 id=99999 不存在/);
    // 整批回滚：s1 没被转移
    const cmbList = database.db
      .prepare('SELECT id FROM scenarios WHERE channel_id = ? AND name = ?')
      .all(channels.cmb_bj.id, 's1');
    assert.strictEqual(cmbList.length, 0, '事务回滚后 s1 未到 cmb_bj');
  });

  test('targetChannelId 非数字 → status=failed', () => {
    const s = createScenarioFixture('s1', channels.icbc_sh.id);
    const result = handlerScenariosTransfer(database, {
      scenarioIds: [s.id],
      targetChannelId: 'invalid'
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /targetChannelId 必须是正整数/);
  });
});

// ---- scenarios:batch-delete ----

test.describe('scenarios:batch-delete handler', () => {
  test('单条删除：status=ok + deletedCount=1', () => {
    const s = createScenarioFixture('s1', channels.icbc_sh.id);
    const result = handlerScenariosBatchDelete(database, { scenarioIds: [s.id] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.deletedCount, 1);
    assert.strictEqual(database.getScenario(s.id), null);
  });

  test('批量删除 3 条非内置场景', () => {
    const s1 = createScenarioFixture('s1', channels.icbc_sh.id);
    const s2 = createScenarioFixture('s2', channels.icbc_sh.id);
    const s3 = createScenarioFixture('s3', channels.icbc_sh.id);
    const result = handlerScenariosBatchDelete(database, {
      scenarioIds: [s1.id, s2.id, s3.id]
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.deletedCount, 3);
  });

  test('内置场景（is_builtin=1）阻止删除 → status=failed', () => {
    const s = createScenarioFixture('builtin-s', channels.icbc_sh.id);
    database.db.prepare('UPDATE scenarios SET is_builtin = 1 WHERE id = ?').run(s.id);
    const result = handlerScenariosBatchDelete(database, { scenarioIds: [s.id] });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /内置场景不可删/);
    // 验证未删
    assert.ok(database.getScenario(s.id));
  });

  test('payload 为 null → status=failed', () => {
    const result = handlerScenariosBatchDelete(database, null);
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /scenarioIds 必须是非空数组/);
  });

  test('scenarioIds 为空数组 → status=failed', () => {
    const result = handlerScenariosBatchDelete(database, { scenarioIds: [] });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /scenarioIds 必须是非空数组/);
  });

  test('id 不存在 → status=ok + deletedCount=0（DELETE 语义幂等）', () => {
    const result = handlerScenariosBatchDelete(database, { scenarioIds: [99999] });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.deletedCount, 0);
  });

  test('混合内置 + 非内置 → 整批回滚（status=failed）', () => {
    const s1 = createScenarioFixture('s1', channels.icbc_sh.id);
    const s2 = createScenarioFixture('builtin-s', channels.icbc_sh.id);
    database.db.prepare('UPDATE scenarios SET is_builtin = 1 WHERE id = ?').run(s2.id);

    const result = handlerScenariosBatchDelete(database, {
      scenarioIds: [s1.id, s2.id]
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(result.message, /内置场景不可删/);
    // 关键：s1 也未删（事务保护）
    assert.ok(database.getScenario(s1.id), '事务回滚后 s1 未删');
    assert.ok(database.getScenario(s2.id));
  });
});
