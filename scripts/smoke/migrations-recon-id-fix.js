// v2.1.0-beta.1 PR-A：scenarios.category CHECK 约束扩 4 值（'recon-id-fix'）的迁移 smoke
//
// 覆盖三档：
// A1 空库启动：无 scenarios 表 → ensureScenariosSupport 建表 + ensureScenariosCategoryReconIdFix 扩约束
// B1 v2.0.0-beta.3 老库启动：3 内置 scenario 已 seed → 迁移后 builtin 完整保留
// C1 重复启动幂等：同库连跑 3 次扩约束，行为不变 + 表结构含 'recon-id-fix'

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  migrateGatewayReconIdFixFieldPairs
} = require('../../src/backend/database/migrations');
const {
  createScenario,
  getScenario,
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

  // ===== E1：scenarios-repository.VALID_CATEGORIES 已含 'recon-id-fix' / 'gateway-recon-id-fix' / 'builtin-fixed' =====
  // v2.1.0-beta.3 T2/T10：扩到 5 项（新增 'gateway-recon-id-fix' 网关子模式）
  // v2.1.13 T1/D3：扩到 6 项（新增 'builtin-fixed' 自带写死场景类别）
  {
    assert.ok(VALID_CATEGORIES.includes('recon-id-fix'), 'E1 VALID_CATEGORIES 已含 recon-id-fix');
    assert.ok(VALID_CATEGORIES.includes('gateway-recon-id-fix'), 'E1 VALID_CATEGORIES 已含 gateway-recon-id-fix');
    assert.ok(VALID_CATEGORIES.includes('builtin-fixed'), 'E1 VALID_CATEGORIES 已含 builtin-fixed');
    assert.strictEqual(VALID_CATEGORIES.length, 6, 'E1 VALID_CATEGORIES 6 项');
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

  // ===== G1：v2.1.0-beta.1 PR-B（Q1=B）— migrateC4ReconGroupsStructure 把
  //   老 C4 reconFields[] 结构迁移到 reconGroups[]（按 seq 聚合）
  {
    const db = setupNewSchemaDb();
    // 写一个 v2.1.0-beta.1 PR-A 老格式的 C4 场景：reconFields[] 含 3 条（同 seq AND，不同 seq OR）
    const oldConfig = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
      ],
      reconFields: [
        { seq: 1, leftTypeSeq: 1, leftField: 'Currency', rightTypeSeq: 2, rightField: 'Currency' },
        { seq: 1, leftTypeSeq: 1, leftField: 'Amount', rightTypeSeq: 2, rightField: 'Amount' },
        { seq: 2, leftTypeSeq: 1, leftField: 'BizType', rightTypeSeq: 2, rightField: 'BizType' }
      ],
      output: { mode: 'main', commonId: null, subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'G1-old-cfg', 0, 1, JSON.stringify(oldConfig), 0, now, now);

    // 跑迁移
    migrateC4ReconGroupsStructure(db);

    // 验证：reconFields 已删除，reconGroups[] 出现 + 按 seq 正确聚合
    const after = getScenario(db, 1);
    assert.ok(after, 'G1 行仍存在');
    assert.ok(!('reconFields' in after.config), 'G1 reconFields 字段已删除');
    assert.ok(Array.isArray(after.config.reconGroups), 'G1 reconGroups 是数组');
    assert.strictEqual(after.config.reconGroups.length, 2, 'G1 2 组（按 seq 1 / 2 分组）');
    // 第一组：同 seq=1 两条 → fieldPairs 2 条
    const grp1 = after.config.reconGroups[0];
    assert.strictEqual(grp1.leftTypeSeq, 1, 'G1 第 1 组 leftTypeSeq=1');
    assert.strictEqual(grp1.rightTypeSeq, 2, 'G1 第 1 组 rightTypeSeq=2');
    assert.strictEqual(grp1.fieldPairs.length, 2, 'G1 第 1 组 fieldPairs 2 条（AND）');
    assert.strictEqual(grp1.fieldPairs[0].leftField, 'Currency', 'G1 第 1 组第 1 对左字段');
    assert.strictEqual(grp1.fieldPairs[1].leftField, 'Amount', 'G1 第 1 组第 2 对左字段');
    // 第二组：seq=2 一条
    const grp2 = after.config.reconGroups[1];
    assert.strictEqual(grp2.fieldPairs.length, 1, 'G1 第 2 组 fieldPairs 1 条');
    assert.strictEqual(grp2.fieldPairs[0].leftField, 'BizType', 'G1 第 2 组左字段');
    // 其他 config 字段不动
    assert.strictEqual(after.config.matchRules.oneToOne, true, 'G1 matchRules 不被破坏');
    assert.strictEqual(after.config.billTypes.length, 2, 'G1 billTypes 不被破坏');
  }

  // ===== G2：幂等三连（已是 reconGroups 的库）— migrateC4ReconGroupsStructure 跑 3 次行为不变
  {
    const db = setupNewSchemaDb();
    const newConfig = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'X', op: '等于', value: '1' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'Y', op: '等于', value: '2' }] }
      ],
      reconGroups: [
        { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [{ leftField: 'A', rightField: 'B' }, { leftField: 'C', rightField: 'D' }] }
      ],
      output: { mode: 'main', commonId: null, subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'G2-new-cfg', 0, 1, JSON.stringify(newConfig), 0, now, now);

    const before = getScenario(db, 1);
    migrateC4ReconGroupsStructure(db);
    migrateC4ReconGroupsStructure(db);
    migrateC4ReconGroupsStructure(db);
    const after = getScenario(db, 1);
    // 三连后结构与 before 一致（深比较）
    assert.deepStrictEqual(after.config.reconGroups, before.config.reconGroups, 'G2 reconGroups 幂等不变');
    assert.ok(!('reconFields' in after.config), 'G2 仍无 reconFields 字段');
  }

  // ===== G3：迁移仅扫 category='recon-id-fix'，不影响 C1/C2/C3 老库 =====
  {
    const db = setupNewSchemaDb();
    // C2 场景（offset-bill-mark）含 reconFields[]——是 C2 自己的结构（不应该被改）
    const c2Config = {
      billTypes: [{ seq: 1, field: 'X', op: '等于', value: 'Y' }],
      reconFields: [{ seq: 1, leftType: 1, leftField: 'A', rightType: 2, rightField: 'B' }],
      markValue: { type: 1, field: 'X', value: 'M' }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, 'offset-bill-mark', 'G3-c2', 0, 1, JSON.stringify(c2Config), 0, now, now);

    migrateC4ReconGroupsStructure(db);

    const after = getScenario(db, 2);
    // C2 场景 reconFields 应保留（迁移仅扫 C4）
    assert.ok(Array.isArray(after.config.reconFields), 'G3 C2 reconFields 保留（迁移不动 C2）');
    assert.ok(!Array.isArray(after.config.reconGroups), 'G3 C2 不应出现 reconGroups');
  }

  // ===== G4：迁移容错 — 解析失败的 config_json 跳过，不抛错 =====
  {
    const db = setupNewSchemaDb();
    const now = new Date().toISOString();
    // 直接插入非法 JSON（绕过 createScenario 校验）
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'G4-bad-json', 0, 1, 'not-a-json', 0, now, now);
    // 不应抛
    migrateC4ReconGroupsStructure(db);
    // 行仍在
    const row = db.prepare('SELECT id FROM scenarios WHERE id=1').get();
    assert.ok(row, 'G4 解析失败行仍存在');
  }

  // ===== G5：兼顾"已含 reconGroups 但残留 reconFields"边界 — 应清掉 reconFields 残留
  {
    const db = setupNewSchemaDb();
    const mixed = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [] }],
      reconGroups: [
        { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [{ leftField: 'X', rightField: 'Y' }] }
      ],
      reconFields: [ // 残留——理论上不应出现，但若用户手编 JSON 入侵需清理
        { seq: 1, leftTypeSeq: 1, leftField: 'OLD', rightTypeSeq: 2, rightField: 'OLD' }
      ],
      output: { mode: 'main', subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'G5-mixed', 0, 1, JSON.stringify(mixed), 0, now, now);

    migrateC4ReconGroupsStructure(db);
    const after = getScenario(db, 1);
    assert.ok(!('reconFields' in after.config), 'G5 残留 reconFields 已清除');
    assert.strictEqual(after.config.reconGroups.length, 1, 'G5 reconGroups 不动');
    assert.strictEqual(after.config.reconGroups[0].fieldPairs[0].leftField, 'X', 'G5 reconGroups 内容不动');
  }

  // ===== H1（Round 3）：老 reconGroups 中已有 Amount/Amount 但缺 locked 标记 → 自动补 locked=true
  {
    const db = setupNewSchemaDb();
    const cfg = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [] }],
      reconGroups: [
        {
          leftTypeSeq: 1, rightTypeSeq: 2,
          fieldPairs: [
            { leftField: 'Amount', rightField: 'Amount' }, // 没有 locked 标记
            { leftField: 'Currency', rightField: 'Currency' }
          ]
        }
      ],
      output: { mode: 'main', subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'H1-no-locked', 0, 1, JSON.stringify(cfg), 0, now, now);
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    const after = getScenario(db, 1);
    const fps = after.config.reconGroups[0].fieldPairs;
    const amountFp = fps.find((fp) => fp.leftField === 'Amount');
    assert.strictEqual(amountFp.locked, true, 'H1 Amount/Amount fieldPair 自动补 locked=true');
    // Currency 不变
    const currFp = fps.find((fp) => fp.leftField === 'Currency');
    assert.ok(!currFp.locked, 'H1 Currency 不被加 locked');
    assert.strictEqual(fps.length, 2, 'H1 fieldPair 数不变');
  }

  // ===== H2（Round 3）：老 reconGroups 中无 Amount/Amount → 头部插入锁定 Amount 行
  {
    const db = setupNewSchemaDb();
    const cfg = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [] }],
      reconGroups: [
        {
          leftTypeSeq: 1, rightTypeSeq: 2,
          fieldPairs: [
            { leftField: 'OrderId', rightField: 'OrderId' },
            { leftField: 'Currency', rightField: 'Currency' }
          ]
        }
      ],
      output: { mode: 'main', subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'H2-no-amount', 0, 1, JSON.stringify(cfg), 0, now, now);
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    const after = getScenario(db, 1);
    const fps = after.config.reconGroups[0].fieldPairs;
    assert.strictEqual(fps.length, 3, 'H2 fieldPair 数 +1');
    // 头部插入
    assert.strictEqual(fps[0].leftField, 'Amount', 'H2 头部插入 Amount/Amount');
    assert.strictEqual(fps[0].rightField, 'Amount', 'H2 头部插入');
    assert.strictEqual(fps[0].locked, true, 'H2 头部插入带 locked=true');
    // 原 fieldPairs 顺序保持
    assert.strictEqual(fps[1].leftField, 'OrderId', 'H2 OrderId 仍在');
    assert.strictEqual(fps[2].leftField, 'Currency', 'H2 Currency 仍在');
  }

  // ===== H3（Round 3）：已含 locked Amount/Amount → no-op（幂等三连）
  {
    const db = setupNewSchemaDb();
    const cfg = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [] }],
      reconGroups: [
        {
          leftTypeSeq: 1, rightTypeSeq: 2,
          fieldPairs: [
            { leftField: 'Amount', rightField: 'Amount', locked: true },
            { leftField: 'OrderId', rightField: 'OrderId' }
          ]
        }
      ],
      output: { mode: 'main', subBizType: { mode: 'auto' } }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'H3-already-locked', 0, 1, JSON.stringify(cfg), 0, now, now);
    const before = getScenario(db, 1);
    // 跑 3 次
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    const after = getScenario(db, 1);
    assert.deepStrictEqual(after.config.reconGroups, before.config.reconGroups, 'H3 已 locked 时 3 次幂等不变');
  }

  // ===== H4（Round 3）：仅扫 category='recon-id-fix'，C1/C2/C3 不动
  {
    const db = setupNewSchemaDb();
    const c2cfg = {
      billTypes: [{ seq: 1, field: 'OrderId', op: '等于', value: 'X' }],
      reconFields: [{ seq: 1, leftType: 1, leftField: 'Amount', rightType: 2, rightField: 'Amount' }],
      markValue: { type: 1, field: 'Type', value: 1 }
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'offset-bill-mark', 'H4-c2', 0, 1, JSON.stringify(c2cfg), 0, now, now);
    migrateC4ReconGroupsAmountLockedFieldPair(db);
    const after = getScenario(db, 1);
    // v2.1.11 T3：C2 读取经 normalizeC2Config 惰性迁移 billTypes 单条件 {field,op,value}
    //   → {conditions:[{field,op,value}]}（spec §4.2）。本用例验证 C4 migration 不动 C2 的
    //   reconFields/markValue —— billTypes 和 v3.2.6 op 默认值来自读取归一化，数据库原文不变。
    const c2cfgAfterMigration = {
      billTypes: [{ seq: 1, conditions: [{ field: 'OrderId', op: '等于', value: 'X' }] }],
      reconFields: [{ seq: 1, leftType: 1, leftField: 'Amount', op: '等于', rightType: 2, rightField: 'Amount' }],
      markValue: { type: 1, field: 'Type', value: 1 }
    };
    assert.deepStrictEqual(after.config, c2cfgAfterMigration, 'H4 C2 reconFields/markValue 不被 C4 migration 改动（billTypes 经 T3 惰性迁移为 conditions）');
    assert.equal(db.prepare('SELECT config_json FROM scenarios WHERE id = 1').get().config_json, JSON.stringify(c2cfg));
  }

  // ===== H5（v2.1.0-beta.3 PR #39 self-review P1-1）：migrateGatewayReconIdFixFieldPairs 主路径 =====
  // 旧 gateway 场景（v2.1.0-beta.3 fix-5 测试期创建，fieldPairs locked Amount/Amount）→ 迁移后 rightField='receiveAmount'
  {
    const db = setupNewSchemaDb();
    // 先扩 CHECK 到 5 值（含 'gateway-recon-id-fix'）
    ensureScenariosCategoryGatewayReconIdFix(db);
    const oldGw = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'gw' }] }],
      reconGroups: [{
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },
          { leftField: 'OrderId', rightField: 'channelOrderNo' }
        ]
      }]
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'gateway-recon-id-fix', 'H5-old-gw', 0, 1, JSON.stringify(oldGw), 0, now, now);
    migrateGatewayReconIdFixFieldPairs(db);
    const after = getScenario(db, 1);
    const locked = after.config.reconGroups[0].fieldPairs.find((fp) => fp.locked === true);
    assert.strictEqual(locked.leftField, 'Amount', 'H5 locked.leftField 仍 Amount');
    assert.strictEqual(locked.rightField, 'receiveAmount', 'H5 locked.rightField 已迁移到 receiveAmount');
    // 非 locked 行不动
    const unlocked = after.config.reconGroups[0].fieldPairs.find((fp) => fp.locked !== true);
    assert.strictEqual(unlocked.rightField, 'channelOrderNo', 'H5 非 locked 行 rightField 不动');
  }

  // ===== H6.1：幂等（已是 receiveAmount 不动 + 3 次连跑无错）=====
  {
    const db = setupNewSchemaDb();
    ensureScenariosCategoryGatewayReconIdFix(db);
    const newGw = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'gw' }] }],
      reconGroups: [{
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'receiveAmount', locked: true }]
      }]
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'gateway-recon-id-fix', 'H6.1-new-gw', 0, 1, JSON.stringify(newGw), 0, now, now);
    const before = getScenario(db, 1);
    migrateGatewayReconIdFixFieldPairs(db);
    migrateGatewayReconIdFixFieldPairs(db);
    migrateGatewayReconIdFixFieldPairs(db);
    const after = getScenario(db, 1);
    assert.deepStrictEqual(after.config.reconGroups, before.config.reconGroups, 'H6.1 已 receiveAmount 时 3 次幂等不变');
  }

  // ===== H6.2：非 gateway 场景不动（仅扫 category='gateway-recon-id-fix'）=====
  {
    const db = setupNewSchemaDb();
    ensureScenariosCategoryGatewayReconIdFix(db);
    // business 场景：fieldPairs locked Amount/Amount（应保持，不应被网关 migration 误改）
    const businessCfg = {
      matchRules: { oneToOne: true },
      billTypes: [{ seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }],
      reconGroups: [{
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'Amount', locked: true }]
      }]
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'recon-id-fix', 'H6.2-business', 0, 1, JSON.stringify(businessCfg), 0, now, now);
    migrateGatewayReconIdFixFieldPairs(db);
    const after = getScenario(db, 1);
    const locked = after.config.reconGroups[0].fieldPairs[0];
    assert.strictEqual(locked.leftField, 'Amount', 'H6.2 business leftField 不被动');
    assert.strictEqual(locked.rightField, 'Amount', 'H6.2 business rightField 保持 Amount（不应被误改）');
  }

  // ===== H6.3（PR #39 self-review round 3 P2-1）：gateway 场景内 unlocked Amount/Amount 不被误迁移
  // 防御性边界：migration 必须严格按 locked === true 判定，不能仅匹配 leftField/rightField
  {
    const db = setupNewSchemaDb();
    ensureScenariosCategoryGatewayReconIdFix(db);
    // gateway 场景：fieldPairs 含 1 unlocked Amount/Amount 用户自定义行（locked=false）+ 1 locked Amount/Amount（应改）
    const mixedGwCfg = {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [{ seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'gw' }] }],
      reconGroups: [{
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },   // 应迁移 → receiveAmount
          { leftField: 'Amount', rightField: 'Amount', locked: false }   // 不应改（防御性）
        ]
      }]
    };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'gateway-recon-id-fix', 'H6.3-mixed', 0, 1, JSON.stringify(mixedGwCfg), 0, now, now);
    migrateGatewayReconIdFixFieldPairs(db);
    const after = getScenario(db, 1);
    const fps = after.config.reconGroups[0].fieldPairs;
    const lockedFp = fps.find((fp) => fp.locked === true);
    const unlockedFp = fps.find((fp) => fp.locked === false);
    assert.strictEqual(lockedFp.rightField, 'receiveAmount', 'H6.3 locked Amount/Amount → receiveAmount（应迁移）');
    assert.strictEqual(unlockedFp.rightField, 'Amount', 'H6.3 unlocked Amount/Amount 不动（防御性 — migration 仅按 locked=true 判定）');
  }

  console.log('  migrations-recon-id-fix: 19/19 PASS');
}

module.exports = {
  runMigrationsReconIdFixSmokeTests
};
