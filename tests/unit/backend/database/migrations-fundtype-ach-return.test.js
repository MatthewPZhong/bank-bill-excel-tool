// v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'
//   ensureFundTypeAchReturnConfigMigration 单元回归（🔴 资金红线 — FundType 枚举值 / 存量 config 迁移）
//
// 覆盖：
//   - 含 'Ach Ruturn'（C2 打标 markValue）的 scenario → 迁移后变 'Ach Return'；config 其它字段不变
//   - 同一行内多处出现 'Ach Ruturn'（如条件 value + markValue）→ 全部替换
//   - 不含 'Ach Ruturn' 的行 → 完全不动（updated_at 不变 / config_json 逐字不变）
//   - 含正确拼写 'Ach Return' 的行（如 R4 内置场景）→ 不被误伤
//   - 无命中行 → no-op（status='no-op', scanned=0, updated=0）
//   - 幂等：连跑两次稳定（第二次 no-op，数据不再变化）
//   - scenarios 表不存在（极早期启动）→ no-op 不抛错
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureFundTypeAchReturnConfigMigration,
} = require('../../../../src/backend/database/migrations');

let tmpDir;
let dbPath;
let db;

// 最小 scenarios 表（与 ensureScenariosSupport 初始结构一致，category 初始 3 值）
function createScenariosTable(currentDb) {
  currentDb.exec(`
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
}

function insertScenario(currentDb, { name, category = 'offset-bill-mark', priority = 0, config, updatedAt = '2026-01-01T00:00:00.000Z' }) {
  const now = '2026-01-01T00:00:00.000Z';
  currentDb.prepare(`
    INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 0, ?, ?)
  `).run(category, name, priority, JSON.stringify(config), now, updatedAt);
}

function getByName(currentDb, name) {
  return currentDb.prepare('SELECT * FROM scenarios WHERE name = ?').get(name);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundtype-ach-return-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.16-beta.2 §FundType ensureFundTypeAchReturnConfigMigration', () => {
  test('含 Ach Ruturn 的 C2 打标 markValue → 迁移后变 Ach Return，其它字段不变', () => {
    createScenariosTable(db);
    // 典型 C2 打标 config：markValue.value 存了错拼 FundType
    insertScenario(db, {
      name: '打标-错拼Ach',
      config: {
        funcCategory: 'offset-bill-mark',
        conditions: [{ field: 'tradeChannel', op: '等于', value: 'XYZ' }],
        markField: 'FundType',
        markValue: { type: 2, field: 'FundType', value: 'Ach Ruturn' },
      },
    });

    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(res.status, 'migrated');
    assert.strictEqual(res.scanned, 1, '应扫描到 1 条命中行');
    assert.strictEqual(res.updated, 1, '应更新 1 条');

    const row = getByName(db, '打标-错拼Ach');
    const cfg = JSON.parse(row.config_json);
    assert.strictEqual(cfg.markValue.value, 'Ach Return', 'markValue 应改为正确拼写');
    // 其它字段逐字不变
    assert.strictEqual(cfg.funcCategory, 'offset-bill-mark');
    assert.strictEqual(cfg.conditions[0].value, 'XYZ');
    assert.strictEqual(cfg.markField, 'FundType');
    // config 文本里不再含错拼
    assert.ok(row.config_json.indexOf('Ach Ruturn') === -1, 'config 不应再含 Ach Ruturn');
    // updated_at 应被刷新（命中行）
    assert.notStrictEqual(row.updated_at, '2026-01-01T00:00:00.000Z', '命中行 updated_at 应刷新');
  });

  test('同一行多处出现 Ach Ruturn → 全部替换', () => {
    createScenariosTable(db);
    insertScenario(db, {
      name: '打标-多处错拼',
      config: {
        conditions: [{ field: 'FundType', op: '等于', value: 'Ach Ruturn' }],
        markValue: { type: 2, field: 'FundType', value: 'Ach Ruturn' },
        note: '把 Ach Ruturn 统一改名',
      },
    });

    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(res.updated, 1);

    const row = getByName(db, '打标-多处错拼');
    // 三处错拼应全部消失
    assert.ok(row.config_json.indexOf('Ach Ruturn') === -1, '所有 Ach Ruturn 应全被替换');
    const occurrences = (row.config_json.match(/Ach Return/g) || []).length;
    assert.strictEqual(occurrences, 3, '应出现 3 处 Ach Return');
  });

  test('不含 Ach Ruturn 的行（含正确拼写 Ach Return 的行）→ 完全不动', () => {
    createScenariosTable(db);
    // 正确拼写行（模拟 R4 内置场景 setFundType: 'Ach Return'）
    insertScenario(db, {
      name: '资金性质校验-Ach Return',
      category: 'offset-bill-mark',
      config: { funcCategory: 'fund-nature-check', subCategory: 'ach-return', setFundType: 'Ach Return' },
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    // 无关行
    insertScenario(db, {
      name: '无关场景',
      config: { funcCategory: 'offset-bill-mark', markValue: { value: 'Inbound' } },
      updatedAt: '2026-02-02T00:00:00.000Z',
    });

    const before1 = getByName(db, '资金性质校验-Ach Return');
    const before2 = getByName(db, '无关场景');

    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(res.status, 'no-op', '无错拼 → no-op');
    assert.strictEqual(res.scanned, 0);
    assert.strictEqual(res.updated, 0);

    const after1 = getByName(db, '资金性质校验-Ach Return');
    const after2 = getByName(db, '无关场景');
    // 逐字不变 + updated_at 不变（未被误伤）
    assert.strictEqual(after1.config_json, before1.config_json, '正确拼写行 config 不变');
    assert.strictEqual(after1.updated_at, before1.updated_at, '正确拼写行 updated_at 不变');
    assert.strictEqual(after2.config_json, before2.config_json, '无关行 config 不变');
    assert.strictEqual(after2.updated_at, before2.updated_at, '无关行 updated_at 不变');
  });

  test('混合：命中行被改、未命中行不动', () => {
    createScenariosTable(db);
    insertScenario(db, {
      name: '命中行',
      config: { markValue: { value: 'Ach Ruturn' } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    insertScenario(db, {
      name: '正确行',
      config: { setFundType: 'Ach Return' },
      updatedAt: '2026-03-03T00:00:00.000Z',
    });

    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(res.status, 'migrated');
    assert.strictEqual(res.scanned, 1, '只扫描到 1 条命中行（LIKE 过滤）');
    assert.strictEqual(res.updated, 1);

    assert.strictEqual(JSON.parse(getByName(db, '命中行').config_json).markValue.value, 'Ach Return');
    // 正确行不动
    const correct = getByName(db, '正确行');
    assert.strictEqual(correct.updated_at, '2026-03-03T00:00:00.000Z');
    assert.strictEqual(JSON.parse(correct.config_json).setFundType, 'Ach Return');
  });

  test('无命中 → no-op（status/scanned/updated）', () => {
    createScenariosTable(db);
    insertScenario(db, { name: '仅Inbound', config: { markValue: { value: 'Inbound' } } });

    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.deepStrictEqual(res, { status: 'no-op', scanned: 0, updated: 0 });
  });

  test('幂等：连跑两次稳定（第二次 no-op，数据不再变）', () => {
    createScenariosTable(db);
    insertScenario(db, {
      name: '打标-错拼Ach',
      config: { markValue: { value: 'Ach Ruturn' } },
    });

    const r1 = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(r1.status, 'migrated');
    assert.strictEqual(r1.updated, 1);
    const afterFirst = getByName(db, '打标-错拼Ach').config_json;

    const r2 = ensureFundTypeAchReturnConfigMigration(db);
    assert.strictEqual(r2.status, 'no-op', '第二次应 no-op');
    assert.strictEqual(r2.scanned, 0);
    assert.strictEqual(r2.updated, 0);
    const afterSecond = getByName(db, '打标-错拼Ach').config_json;

    assert.strictEqual(afterFirst, afterSecond, '第二次跑数据应完全不变（幂等）');
    assert.strictEqual(JSON.parse(afterSecond).markValue.value, 'Ach Return');
  });

  test('scenarios 表不存在（极早期启动）→ no-op 不抛错', () => {
    // 不建表
    const res = ensureFundTypeAchReturnConfigMigration(db);
    assert.deepStrictEqual(res, { status: 'no-op', scanned: 0, updated: 0 });
  });
});
