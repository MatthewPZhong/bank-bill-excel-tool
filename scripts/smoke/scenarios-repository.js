// v2.0.0-beta.3 PR #32b：scenariosRepository 最小未使用 id 语义 smoke
// 用 node:sqlite in-memory DB

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  calculateNextScenarioId,
  createScenario,
  deleteScenario
} = require('../../src/backend/database/scenarios-repository');

function setupInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join')),
      name TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name)
    );
  `);
  return db;
}

function makePayload(name, suffix = '') {
  return {
    category: 'extract-recon-id',
    name: `${name}${suffix}`,
    priority: 1,
    enabled: true,
    config: {
      conditions: [{ field: 'CustomerRef', op: '等于', value: 'X' }],
      extractByFeature: null,
      extractByOtherField: { field: 'CustomerRef' }
    }
  };
}

function runScenariosRepositorySmokeTests() {
  // ===== R1: 空表 → 第 1 条 id = 1 =====
  {
    const db = setupInMemoryDb();
    assert.strictEqual(calculateNextScenarioId(db), 1, 'R1 空表 nextId 应为 1');
    const r = createScenario(db, makePayload('A'));
    assert.strictEqual(r.id, 1, 'R1 第一条 id 应为 1');
  }

  // ===== R2: 连续 1/2/3 → 第 4 条 id = 4 =====
  {
    const db = setupInMemoryDb();
    createScenario(db, makePayload('S', '1'));
    createScenario(db, makePayload('S', '2'));
    createScenario(db, makePayload('S', '3'));
    assert.strictEqual(calculateNextScenarioId(db), 4, 'R2 连续 1/2/3 nextId 应为 4');
    const r = createScenario(db, makePayload('S', '4'));
    assert.strictEqual(r.id, 4, 'R2 第四条 id 应为 4');
  }

  // ===== R3: gap 1/2/3/5 → 新增填补 gap = 4 =====
  {
    const db = setupInMemoryDb();
    createScenario(db, makePayload('S', '1'));
    createScenario(db, makePayload('S', '2'));
    createScenario(db, makePayload('S', '3'));
    const fourth = createScenario(db, makePayload('S', '4'));
    const fifth = createScenario(db, makePayload('S', '5'));
    deleteScenario(db, fourth.id);
    // 现状：1, 2, 3, 5（id=4 被删除）
    assert.strictEqual(calculateNextScenarioId(db), 4, 'R3 1/2/3/5 nextId 应为 4');
    const newOne = createScenario(db, makePayload('S', 'new'));
    assert.strictEqual(newOne.id, 4, 'R3 新增填 gap，id 应为 4');
    // 再下一次：1/2/3/4/5 → next = 6
    assert.strictEqual(calculateNextScenarioId(db), 6, 'R3 全连续后 nextId 应为 6');
  }

  // ===== R4: 多 gap → 取最小 =====
  {
    const db = setupInMemoryDb();
    const a = createScenario(db, makePayload('S', '1'));
    const b = createScenario(db, makePayload('S', '2'));
    const c = createScenario(db, makePayload('S', '3'));
    const d = createScenario(db, makePayload('S', '4'));
    const e = createScenario(db, makePayload('S', '5'));
    // 删除 id 2 + 4
    deleteScenario(db, b.id);
    deleteScenario(db, d.id);
    // 现状：1, 3, 5 → next = 2
    assert.strictEqual(calculateNextScenarioId(db), 2, 'R4 1/3/5 nextId 应为 2（最小 missing）');
    const newOne = createScenario(db, makePayload('S', 'new'));
    assert.strictEqual(newOne.id, 2, 'R4 新增填最小 gap，id 应为 2');
  }

  // ===== R5: 删除头部 → next = 1 =====
  {
    const db = setupInMemoryDb();
    const a = createScenario(db, makePayload('S', '1'));
    createScenario(db, makePayload('S', '2'));
    deleteScenario(db, a.id);
    assert.strictEqual(calculateNextScenarioId(db), 1, 'R5 删头部 nextId 应为 1');
    const newOne = createScenario(db, makePayload('S', 'new'));
    assert.strictEqual(newOne.id, 1, 'R5 重新填回 id=1');
  }

  console.log('  scenarios-repository: 5/5 PASS');
}

module.exports = {
  runScenariosRepositorySmokeTests
};
