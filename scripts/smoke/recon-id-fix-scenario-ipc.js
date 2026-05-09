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
  // PR-B Q1=B：reconGroups[]
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
      reconGroups: [
        { leftTypeSeq: 1, rightTypeSeq: 1, fieldPairs: [{ leftField: 'OrderId', rightField: 'OrderId' }] }
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
//
// PR #35 Codex round 3 P2（资金红线分流）：4 个 handler 不再无条件清两个全局缓存
// 而是按变更场景的 category 分流：
// - C1/C2/C3（extract-recon-id / offset-bill-mark / gateway-recon-join）→ 只清 processingResult
// - C4（recon-id-fix）→ 只清 reconIdFixResult
//
// 此处 simulator 镜像 main.js clearResultCacheForCategory()，让 smoke 验证分流行为。
function clearResultCacheForCategory(processCache, category) {
  if (category === 'recon-id-fix') {
    processCache.reconIdFixResult = null;
  } else {
    processCache.processingResult = null;
  }
}
function simulateIpcCreate(db, payload, processCache) {
  const r = createScenario(db, payload);
  clearResultCacheForCategory(processCache, payload && payload.category);
  return { status: 'ok', id: r.id };
}
function simulateIpcUpdate(db, id, fields, processCache) {
  // 先查 category（与 main.js 一致 — update 不允许改 category）
  const existing = getScenario(db, id);
  updateScenario(db, id, fields);
  clearResultCacheForCategory(processCache, existing && existing.category);
  return { status: 'ok', id };
}
function simulateIpcDelete(db, id, processCache) {
  // DELETE 后 row 不存在 → 必须先 SELECT category 再删
  const existing = getScenario(db, id);
  const r = deleteScenario(db, id);
  if (existing) {
    clearResultCacheForCategory(processCache, existing.category);
  }
  return { status: 'ok', id, deleted: r.deleted };
}
function simulateIpcToggle(db, id, enabled, processCache) {
  const existing = getScenario(db, id);
  const r = toggleScenarioEnabled(db, id, enabled);
  clearResultCacheForCategory(processCache, existing && existing.category);
  return { status: 'ok', id, enabled: r.enabled };
}

function makeC1Payload(name = 'C1-test') {
  return {
    category: 'extract-recon-id',
    name,
    priority: 1,
    enabled: true,
    config: {
      conditions: [{ field: 'X', op: '等于', value: 'y' }],
      extractByFeature: null,
      extractByOtherField: { field: 'X' }
    }
  };
}

function runReconIdFixScenarioIpcSmokeTests() {
  // ===== T1：scenarios:create 创建 C4 类成功 + 仅清 reconIdFixResult（round 3 P2 分流）=====
  {
    const db = setupDb();
    const cache = { processingResult: { dummy: 1 }, reconIdFixResult: { dummy: 1 } };
    const result = simulateIpcCreate(db, makeC4Payload('T1-c4'), cache);
    assert.strictEqual(result.status, 'ok', 'T1 create C4 status=ok');
    assert.strictEqual(result.id, 1, 'T1 create C4 id=1');
    // round 3 P2：C4 变更不应清 processingResult（银行对账已就绪结果不能误抹）
    assert.deepStrictEqual(cache.processingResult, { dummy: 1 }, 'T1 processingResult 保留');
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

  // ===== T4：scenarios:update 改 C4 + 仅清 reconIdFixResult（round 3 P2 分流）=====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T4-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale-result' };
    cache.processingResult = { dummy: 'stale-bs' };

    simulateIpcUpdate(db, 1, { name: 'T4-c4-renamed', priority: 2 }, cache);
    assert.strictEqual(cache.reconIdFixResult, null, 'T4 update C4 后 reconIdFixResult 清');
    // round 3 P2：C4 update 不应清 processingResult
    assert.deepStrictEqual(cache.processingResult, { dummy: 'stale-bs' }, 'T4 processingResult 保留');

    const sc = getScenario(db, 1);
    assert.strictEqual(sc.name, 'T4-c4-renamed', 'T4 name 已更新');
    assert.strictEqual(sc.priority, 2, 'T4 priority 已更新');
  }

  // ===== T5：scenarios:toggle-enabled 切 C4 + 仅清 reconIdFixResult（round 3 P2 分流）=====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T5-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale' };
    cache.processingResult = { dummy: 'bs-ok' };

    simulateIpcToggle(db, 1, false, cache);
    assert.strictEqual(cache.reconIdFixResult, null, 'T5 toggle C4 后 reconIdFixResult 清');
    // round 3 P2：toggle C4 不应清 processingResult
    assert.deepStrictEqual(cache.processingResult, { dummy: 'bs-ok' }, 'T5 processingResult 保留');
    const sc = getScenario(db, 1);
    assert.strictEqual(sc.enabled, false, 'T5 enabled=false 已持久化');
  }

  // ===== T6：scenarios:delete 删 C4 + 仅清 reconIdFixResult（round 3 P2 分流）=====
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T6-c4'), cache);
    cache.reconIdFixResult = { dummy: 'stale' };
    cache.processingResult = { dummy: 'bs-ok' };

    const result = simulateIpcDelete(db, 1, cache);
    assert.strictEqual(result.deleted, true, 'T6 delete=true');
    assert.strictEqual(cache.reconIdFixResult, null, 'T6 delete C4 后 reconIdFixResult 清');
    // round 3 P2：删除 C4 不应清 processingResult
    assert.deepStrictEqual(cache.processingResult, { dummy: 'bs-ok' }, 'T6 processingResult 保留');
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

  // ===== T8（round 3 P2 资金红线分流）：create C1 不清 reconIdFixResult =====
  // 用户跑完单据对账模块（reconIdFixResult 已就绪）后新增银行对账场景 C1，
  // 不应误清 reconIdFixResult，否则前端会把 C4 模块的导出按钮置灰。
  {
    const db = setupDb();
    const cache = {
      processingResult: { dummy: 'bs-ok' },
      reconIdFixResult: { dummy: 'c4-ok' }
    };
    const result = simulateIpcCreate(db, makeC1Payload('T8-c1'), cache);
    assert.strictEqual(result.status, 'ok', 'T8 create C1 status=ok');
    assert.strictEqual(cache.processingResult, null, 'T8 processingResult 已清（C1 走银行对账 dispatcher）');
    assert.deepStrictEqual(
      cache.reconIdFixResult,
      { dummy: 'c4-ok' },
      'T8 reconIdFixResult 保留（C4 模块结果不应被 C1 变更误抹）'
    );
  }

  // ===== T9（round 3 P2 资金红线分流）：create C4 不清 processingResult =====
  // T1 的逆向断言独立用例（更直接的 finding 描述对应）
  {
    const db = setupDb();
    const cache = {
      processingResult: { dummy: 'bs-ok' },
      reconIdFixResult: null
    };
    const result = simulateIpcCreate(db, makeC4Payload('T9-c4'), cache);
    assert.strictEqual(result.status, 'ok', 'T9 create C4 status=ok');
    assert.deepStrictEqual(
      cache.processingResult,
      { dummy: 'bs-ok' },
      'T9 processingResult 保留（银行对账结果不应被 C4 变更误抹）'
    );
    assert.strictEqual(cache.reconIdFixResult, null, 'T9 reconIdFixResult 仍为 null');
  }

  // ===== T10（round 3 P2 资金红线分流）：delete C1 不清 reconIdFixResult =====
  // delete 路径需先 SELECT 老 row 取 category 再走分流（DELETE 后查不到）
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC1Payload('T10-c1'), cache);
    // 模拟用户先跑了银行对账（processingResult ok）+ 跑了 C4（reconIdFixResult ok）
    cache.processingResult = { dummy: 'bs-ok' };
    cache.reconIdFixResult = { dummy: 'c4-ok' };

    const result = simulateIpcDelete(db, 1, cache);
    assert.strictEqual(result.deleted, true, 'T10 delete C1 deleted=true');
    assert.strictEqual(cache.processingResult, null, 'T10 processingResult 已清（C1 走银行对账 dispatcher）');
    assert.deepStrictEqual(
      cache.reconIdFixResult,
      { dummy: 'c4-ok' },
      'T10 reconIdFixResult 保留（删 C1 不应抹 C4 模块结果）'
    );
    assert.strictEqual(getScenario(db, 1), null, 'T10 已从 DB 删除');
  }

  // ===== T11（round 3 P2 资金红线分流）：toggle C4 不清 processingResult =====
  // toggle 路径需先 SELECT 老 row 取 category 再走分流（toggle 不改 category）
  {
    const db = setupDb();
    const cache = { processingResult: null, reconIdFixResult: null };
    simulateIpcCreate(db, makeC4Payload('T11-c4'), cache);
    cache.processingResult = { dummy: 'bs-ok' };
    cache.reconIdFixResult = { dummy: 'c4-ok' };

    const result = simulateIpcToggle(db, 1, false, cache);
    assert.strictEqual(result.enabled, false, 'T11 toggle C4 enabled=false');
    assert.strictEqual(cache.reconIdFixResult, null, 'T11 reconIdFixResult 已清（C4 走 C4 模块）');
    assert.deepStrictEqual(
      cache.processingResult,
      { dummy: 'bs-ok' },
      'T11 processingResult 保留（toggle C4 不应抹银行对账结果）'
    );
    const sc = getScenario(db, 1);
    assert.strictEqual(sc.enabled, false, 'T11 enabled=false 已持久化');
  }

  console.log('  recon-id-fix-scenario-ipc: 11/11 PASS');
}

module.exports = {
  runReconIdFixScenarioIpcSmokeTests
};
