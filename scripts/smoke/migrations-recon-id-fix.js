// v2.1.0-beta.1 PR-A：scenarios.category CHECK 约束扩 4 值（'recon-id-fix'）的迁移 smoke
//
// 覆盖三档：
// A1 空库启动：无 scenarios 表 → ensureScenariosSupport 建表 + ensureScenariosCategoryReconIdFix 扩约束
// B1 v2.0.0-beta.3 老库启动：3 内置 scenario 已 seed → 迁移后 builtin 完整保留
// C1 重复启动幂等：同库连跑 3 次扩约束，行为不变 + 表结构含 'recon-id-fix'

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosCategoryReconIdFix
} = require('../../src/backend/database/migrations');
const {
  createScenario,
  listScenarios,
  VALID_CATEGORIES
} = require('../../src/backend/database/scenarios-repository');

function setupOldSchemaDb() {
  // 模拟 v2.0.0-beta.3 旧 schema：CHECK 仅 3 值
  const db = new DatabaseSync(':memory:');
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
  return db;
}

function setupNewSchemaDb() {
  // 模拟 v2.1.0 新 schema：CHECK 已含 4 值
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN (
        'extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix'
      )),
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
  return db;
}

function getScenariosTableSql(db) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  return row ? row.sql : null;
}

function insertOldBuiltin(db, payload) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.id,
    payload.category,
    payload.name,
    payload.priority,
    payload.enabled ? 1 : 0,
    JSON.stringify(payload.config || {}),
    payload.isBuiltin ? 1 : 0,
    now,
    now
  );
}

function runMigrationsReconIdFixSmokeTests() {
  // ===== A1：空（已建表但无数据）库启动 =====
  {
    const db = setupOldSchemaDb();
    const before = getScenariosTableSql(db);
    assert.ok(before && !before.includes("'recon-id-fix'"), 'A1 旧 schema 不应含 recon-id-fix');

    ensureScenariosCategoryReconIdFix(db);

    const after = getScenariosTableSql(db);
    assert.ok(after && after.includes("'recon-id-fix'"), 'A1 迁移后 schema 应含 recon-id-fix');

    const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios').get().cnt;
    assert.strictEqual(Number(cnt), 0, 'A1 空库迁移后行数仍为 0');

    // 迁移后能直接 INSERT C4 类
    const result = createScenario(db, {
      category: 'recon-id-fix',
      name: 'C4-A1-test',
      priority: 0,
      enabled: true,
      config: { matchRules: { oneToOne: true, oneToMany: false, manyToOne: false } }
    });
    assert.strictEqual(result.id, 1, 'A1 迁移后第一条 C4 场景 id=1');
  }

  // ===== B1：v2.0.0-beta.3 老库启动（含 3 builtin） =====
  {
    const db = setupOldSchemaDb();
    insertOldBuiltin(db, {
      id: 1, category: 'extract-recon-id',
      name: '从银行对账单的信息里提取对账ID', priority: 3, enabled: true, isBuiltin: true,
      config: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'AFT' }] }
    });
    insertOldBuiltin(db, {
      id: 2, category: 'offset-bill-mark',
      name: 'outbound改标为outbound Fail', priority: 2, enabled: true, isBuiltin: true,
      config: { billTypes: [], reconFields: [], markValue: { type: 2, field: '', value: '' } }
    });
    insertOldBuiltin(db, {
      id: 3, category: 'gateway-recon-join',
      name: '与网关对账单根据金额币种一对一匹配对账ID', priority: 1, enabled: true, isBuiltin: true,
      config: { reconFields: [{ seq: 1, gwField: 'Currency', bankField: 'Currency' }], assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' } }
    });
    const beforeRows = db.prepare('SELECT id, category, name, is_builtin FROM scenarios ORDER BY id').all();
    assert.strictEqual(beforeRows.length, 3, 'B1 迁移前 3 条 builtin');

    ensureScenariosCategoryReconIdFix(db);

    const afterRows = db.prepare('SELECT id, category, name, is_builtin FROM scenarios ORDER BY id').all();
    assert.strictEqual(afterRows.length, 3, 'B1 迁移后 3 条 builtin 仍在');
    afterRows.forEach((row, idx) => {
      assert.strictEqual(row.id, beforeRows[idx].id, `B1 迁移后 id[${idx}] 保持不变`);
      assert.strictEqual(row.category, beforeRows[idx].category, `B1 迁移后 category[${idx}] 保持不变`);
      assert.strictEqual(row.name, beforeRows[idx].name, `B1 迁移后 name[${idx}] 保持不变`);
      assert.strictEqual(Number(row.is_builtin), 1, `B1 迁移后 is_builtin[${idx}]=1`);
    });

    // 迁移后再 INSERT C4 类，UNIQUE(name) 仍生效
    createScenario(db, {
      category: 'recon-id-fix',
      name: 'C4-B1-test', priority: 0, enabled: true,
      config: {}
    });
    assert.throws(
      () => createScenario(db, {
        category: 'recon-id-fix',
        name: 'C4-B1-test', priority: 0, enabled: true,
        config: {}
      }),
      /已存在/,
      'B1 迁移后 UNIQUE(name) 仍生效'
    );

    // listScenarios 排序兼容（priority desc, id asc）
    const list = listScenarios(db);
    assert.strictEqual(list.length, 4, 'B1 list = 3 builtin + 1 C4');
    assert.strictEqual(list[0].priority, 3, 'B1 最高优先级排第一');
  }

  // ===== C1：重复启动幂等 =====
  {
    const db = setupOldSchemaDb();
    insertOldBuiltin(db, {
      id: 1, category: 'extract-recon-id',
      name: 'C1-test-builtin', priority: 0, enabled: true, isBuiltin: true,
      config: {}
    });

    const sqlBeforeMig = getScenariosTableSql(db);
    ensureScenariosCategoryReconIdFix(db);
    const sqlAfter1st = getScenariosTableSql(db);
    assert.ok(sqlAfter1st.includes("'recon-id-fix'"), 'C1 第 1 次迁移后 schema 含 recon-id-fix');
    assert.notStrictEqual(sqlAfter1st, sqlBeforeMig, 'C1 第 1 次迁移后 schema 应有变化');

    // 再跑 2 次：应 no-op，schema 不变
    ensureScenariosCategoryReconIdFix(db);
    const sqlAfter2nd = getScenariosTableSql(db);
    ensureScenariosCategoryReconIdFix(db);
    const sqlAfter3rd = getScenariosTableSql(db);
    assert.strictEqual(sqlAfter1st, sqlAfter2nd, 'C1 第 2 次幂等：schema 不变');
    assert.strictEqual(sqlAfter1st, sqlAfter3rd, 'C1 第 3 次幂等：schema 不变');

    // 数据无损
    const rows = db.prepare('SELECT id, name, is_builtin FROM scenarios').all();
    assert.strictEqual(rows.length, 1, 'C1 幂等后行数不变');
    assert.strictEqual(rows[0].name, 'C1-test-builtin', 'C1 幂等后 name 不变');
  }

  // ===== D1：新 schema 库（v2.1+ 全新装）启动 → 直接 no-op =====
  {
    const db = setupNewSchemaDb();
    const before = getScenariosTableSql(db);
    assert.ok(before.includes("'recon-id-fix'"), 'D1 新 schema 已含 recon-id-fix');
    ensureScenariosCategoryReconIdFix(db); // no-op
    const after = getScenariosTableSql(db);
    assert.strictEqual(before, after, 'D1 新 schema 直接 no-op，schema 不变');
  }

  // ===== E1：scenarios-repository.VALID_CATEGORIES 已含 'recon-id-fix' =====
  {
    assert.ok(VALID_CATEGORIES.includes('recon-id-fix'), 'E1 VALID_CATEGORIES 已含 recon-id-fix');
    assert.strictEqual(VALID_CATEGORIES.length, 4, 'E1 VALID_CATEGORIES 4 项');
  }

  // ===== F1：CHECK 约束在 INSERT 非法值时拒绝 =====
  {
    const db = setupOldSchemaDb();
    ensureScenariosCategoryReconIdFix(db);
    assert.throws(
      () => {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(99, 'invalid-category', 'F1-test', 0, 1, '{}', 0, now, now);
      },
      /CHECK constraint failed/,
      'F1 非法 category 被 CHECK 拒绝'
    );
  }

  console.log('  migrations-recon-id-fix: 6/6 PASS');
}

module.exports = {
  runMigrationsReconIdFixSmokeTests
};
