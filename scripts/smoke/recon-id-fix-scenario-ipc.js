// v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块的 scenarios IPC 占位 + 资金红线清缓存
//
// 模拟 main.js IPC handler 内核：
// - scenarios:create / update / delete / toggle-enabled 对 C4 类（category='recon-id-fix'）的 CRUD
// - 4 个变更 handler 触发后必须把 reconIdFixResult / processingResult 同步置 null（spec §10.1 第一层防御）
//
// 不真正打开 main.js（避免拉起 Electron），只验证 database 层 + 数据流契约。

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosCategoryReconIdFix
} = require('../../src/backend/database/migrations');
const {
  createScenario,
  getScenario,
  listScenarios,
  updateScenario,
  deleteScenario,
  toggleScenarioEnabled
} = require('../../src/backend/database/scenarios-repository');

function setupDb() {
  const db = new DatabaseSync(':memory:');
  // 旧 schema 起步 → 跑迁移扩到 4 值
  db.exec(`
    CREATE TABLE scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join')),
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
  ensureScenariosCategoryReconIdFix(db);
  return db;
}

function makeC4Payload(name = 'C4-test') {
  return {
    category: 'recon-id-fix',
    name,
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'X' }] }
      ],
      reconFields: [
        { seq: 1, leftTypeSeq: 1, leftField: 'OrderId', rightTypeSeq: 1, rightField: 'OrderId' }
      ],
      output: {
        mode: 'main',
        commonId: null,
        subBizType: { mode: 'auto', mainValue: null, oppValue: null }
      }
    }
  };
}

// 模拟 main.js trackedIpcHandle 中 4 个 scenarios:* handler 的资金红线清缓存
function simulateIpcCreate(db, payload, processCache) {
  const r = createScenario(db, payload);
  processCache.processingResult = null;
  processCache.reconIdFixResult = null;
  return { status: 'ok', id: r.id };
}
function simulateIpcUpdate(db, id, fields, processCache) {
  updateScenario(db, id, fields);
  processCache.processingResult = null;
  processCache.reconIdFixResult = null;
  return { status: 'ok', id };
}
function simulateIpcDelete(db, id, processCache) {
  const r = deleteScenario(db, id);
  processCache.processingResult = null;
  processCache.reconIdFixResult = null;
  return { status: 'ok', id, deleted: r.deleted };
}
function simulateIpcToggle(db, id, enabled, processCache) {
  const r = toggleScenarioEnabled(db, id, enabled);
  processCache.processingResult = null;
  processCache.reconIdFixResult = null;
  return { status: 'ok', id, enabled: r.enabled };
}

function runReconIdFixScenarioIpcSmokeTests() {
  // ===== T1：scenarios:create 创建 C4 类成功 + 清 reconIdFixResult =====
  {
    const db = setupDb();
    const cache = { processingResult: { dummy: 1 }, reconIdFixResult: { dummy: 1 } };
    const result = simulateIpcCreate(db, makeC4Payload('T1-c4'), cache);
    assert.strictEqual(result.status, 'ok', 'T1 create C4 status=ok');
    assert.strictEqual(result.id, 1, 'T1 create C4 id=1');
    assert.strictEqual(cache.processingResult, null, 'T1 processingResult 已清');
    assert.strictEqual(cache.reconIdFixResult, null, 'T1 reconIdFixResult 已清');

    const fetched = getScenario(db, 1);
    assert.strictEqual(fetched.category, 'recon-id-fix', 'T1 category 持久化');
    assert.strictEqual(fetched.name, 'T1-c4', 'T1 name 持久化');
    assert.ok(fetched.config && fetched.config.matchRules, 'T1 config 正确反序列化');
  }

  // ===== T2：scenarios:list 含 C4 类 =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T2-c4-a'), cache);
    simulateIpcCreate(db, makeC4Payload('T2-c4-b'), cache);
    simulateIpcCreate(db, {
      category: 'extract-recon-id', name: 'T2-c1', priority: 1, enabled: true,
      config: { conditions: [{ field: 'X', op: '等于', value: 'y' }], extractByFeature: null, extractByOtherField: { field: 'X' } }
    }, cache);

    const list = listScenarios(db);
    const c4s = list.filter((s) => s.category === 'recon-id-fix');
    assert.strictEqual(c4s.length, 2, 'T2 list 含 2 条 C4');
    assert.strictEqual(list.length, 3, 'T2 list 含全部 3 条');
  }

  // ===== T3：scenarios:get C4 类返回完整 config =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T3-c4'), cache);
    const sc = getScenario(db, 1);
    assert.ok(sc, 'T3 getScenario 返回非空');
    assert.strictEqual(sc.category, 'recon-id-fix', 'T3 category=recon-id-fix');
    assert.deepStrictEqual(
      sc.config.matchRules,
      { oneToOne: true, oneToMany: false, manyToOne: false },
      'T3 config.matchRules 完整反序列化'
    );
  }

  // ===== T4：scenarios:update 改 C4 + 清 reconIdFixResult =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T4-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale-result' };
    cache.processingResult = { dummy: 'stale-bs' };

    simulateIpcUpdate(db, 1, { name: 'T4-c4-renamed', priority: 2 }, cache);
    assert.strictEqual(cache.reconIdFixResult, null, 'T4 update 后 reconIdFixResult 清');
    assert.strictEqual(cache.processingResult, null, 'T4 update 后 processingResult 清');

    const sc = getScenario(db, 1);
    assert.strictEqual(sc.name, 'T4-c4-renamed', 'T4 name 已更新');
    assert.strictEqual(sc.priority, 2, 'T4 priority 已更新');
  }

  // ===== T5：scenarios:toggle-enabled 切 C4 + 清 reconIdFixResult =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T5-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale' };

    simulateIpcToggle(db, 1, false, cache);
    assert.strictEqual(cache.reconIdFixResult, null, 'T5 toggle 后 reconIdFixResult 清');
    const sc = getScenario(db, 1);
    assert.strictEqual(sc.enabled, false, 'T5 enabled=false 已持久化');
  }

  // ===== T6：scenarios:delete 删 C4 + 清 reconIdFixResult =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T6-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale' };

    const result = simulateIpcDelete(db, 1, cache);
    assert.strictEqual(result.deleted, true, 'T6 delete=true');
    assert.strictEqual(cache.reconIdFixResult, null, 'T6 delete 后 reconIdFixResult 清');
    assert.strictEqual(getScenario(db, 1), null, 'T6 已从 DB 删除');
  }

  // ===== T7：UNIQUE(name) 约束在 C4 类同样生效 =====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T7-c4-dup'), cache);
    assert.throws(
      () => simulateIpcCreate(db, makeC4Payload('T7-c4-dup'), cache),
      /已存在/,
      'T7 重复 name 应抛错'
    );
  }

  console.log('  recon-id-fix-scenario-ipc: 7/7 PASS');
}

module.exports = {
  runReconIdFixScenarioIpcSmokeTests
};
