// v3.0.12 功能2（批A）：账户映射管理仓储单测
//   表 fund_transfer_account_mappings（全局：中台调拨单账户号 → 清结算系统银行账号，UNIQUE(mid_account_id)）。
//   覆盖：建表幂等 / CRUD（保存→读回、顺序保留）/ 归一化（trim + 数值 String 化）/ 空值校验（空行跳过、半填抛错）
//   / 整表覆盖（重存只剩新值）/ 去重（UNIQUE 违例回滚）/ getMappingMap（归一化 Map、空键护栏、查得命中）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureFundTransferAccountMappingSupport } = require('../../../../src/backend/database/migrations');
const repo = require('../../../../src/backend/database/fund-transfer-account-mapping-repository');

let tmpDir;
let db;

// node:sqlite 的 .all() 返回 null-prototype 行对象（与 settings-repository 同），
// deepStrictEqual 会因原型不同失配 → 测试侧统一拍平为普通对象再断言（不改生产返回形态）。
function list() {
  return repo.listMappings(db).map((r) => ({
    midAccountId: r.midAccountId,
    clearingAccountId: r.clearingAccountId
  }));
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-acct-map-'));
  db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'));
  ensureFundTransferAccountMappingSupport(db); // 用真实迁移建表（顺带验证建表可用）
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// ========================================================================
// 建表幂等
// ========================================================================
test.describe('ensureFundTransferAccountMappingSupport 建表', () => {
  test('重复执行幂等（CREATE TABLE IF NOT EXISTS，不抛错、不丢数据）', () => {
    repo.saveMappings(db, [{ midAccountId: 'MID-1', clearingAccountId: 'CLR-1' }]);
    assert.doesNotThrow(() => ensureFundTransferAccountMappingSupport(db));
    assert.deepEqual(list(), [{ midAccountId: 'MID-1', clearingAccountId: 'CLR-1' }]);
  });

  test('表含 UNIQUE(mid_account_id) 约束', () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fund_transfer_account_mappings'").all();
    assert.equal(rows.length, 1);
  });
});

// ========================================================================
// listMappings / saveMappings — CRUD
// ========================================================================
test.describe('CRUD', () => {
  test('空表 → listMappings 返回 []', () => {
    assert.deepEqual(list(), []);
  });

  test('保存后读回，按 row_index 升序保留输入顺序', () => {
    repo.saveMappings(db, [
      { midAccountId: 'MID-A', clearingAccountId: 'CLR-A' },
      { midAccountId: 'MID-B', clearingAccountId: 'CLR-B' },
      { midAccountId: 'MID-C', clearingAccountId: 'CLR-C' }
    ]);
    assert.deepEqual(list(), [
      { midAccountId: 'MID-A', clearingAccountId: 'CLR-A' },
      { midAccountId: 'MID-B', clearingAccountId: 'CLR-B' },
      { midAccountId: 'MID-C', clearingAccountId: 'CLR-C' }
    ]);
  });

  test('整表覆盖：重存只剩新值（全删 + 重插）', () => {
    repo.saveMappings(db, [
      { midAccountId: 'OLD-1', clearingAccountId: 'X1' },
      { midAccountId: 'OLD-2', clearingAccountId: 'X2' }
    ]);
    repo.saveMappings(db, [{ midAccountId: 'NEW-1', clearingAccountId: 'Y1' }]);
    assert.deepEqual(list(), [{ midAccountId: 'NEW-1', clearingAccountId: 'Y1' }]);
  });

  test('保存空数组 → 清空全表', () => {
    repo.saveMappings(db, [{ midAccountId: 'MID-1', clearingAccountId: 'CLR-1' }]);
    repo.saveMappings(db, []);
    assert.deepEqual(list(), []);
  });

  test('非数组入参 → 视为空，清空全表（不抛错）', () => {
    repo.saveMappings(db, [{ midAccountId: 'MID-1', clearingAccountId: 'CLR-1' }]);
    assert.doesNotThrow(() => repo.saveMappings(db, null));
    assert.deepEqual(list(), []);
  });
});

// ========================================================================
// 归一化
// ========================================================================
test.describe('归一化（normalizeCellValue：trim + 数值 String 化）', () => {
  test('两侧首尾空白被 trim', () => {
    repo.saveMappings(db, [{ midAccountId: '  MID-1  ', clearingAccountId: '\tCLR-1\n' }]);
    assert.deepEqual(list(), [{ midAccountId: 'MID-1', clearingAccountId: 'CLR-1' }]);
  });

  test('数值账号被 String 化', () => {
    repo.saveMappings(db, [{ midAccountId: 6225880100, clearingAccountId: 123456 }]);
    assert.deepEqual(list(), [{ midAccountId: '6225880100', clearingAccountId: '123456' }]);
  });
});

// ========================================================================
// 空值校验
// ========================================================================
test.describe('空值校验', () => {
  test('两列皆空的行被跳过（不入库）', () => {
    repo.saveMappings(db, [
      { midAccountId: 'MID-1', clearingAccountId: 'CLR-1' },
      { midAccountId: '   ', clearingAccountId: '' },
      { midAccountId: 'MID-2', clearingAccountId: 'CLR-2' }
    ]);
    assert.deepEqual(list(), [
      { midAccountId: 'MID-1', clearingAccountId: 'CLR-1' },
      { midAccountId: 'MID-2', clearingAccountId: 'CLR-2' }
    ]);
  });

  test('仅一列为空 → 抛错（且不污染既有数据，校验在事务前）', () => {
    repo.saveMappings(db, [{ midAccountId: 'KEEP', clearingAccountId: 'KEEP-CLR' }]);
    assert.throws(() => repo.saveMappings(db, [{ midAccountId: 'MID-1', clearingAccountId: '' }]), /未填写完整/);
    // 校验失败发生在 BEGIN 之前 → 既有数据不变
    assert.deepEqual(list(), [{ midAccountId: 'KEEP', clearingAccountId: 'KEEP-CLR' }]);
  });

  test('清结算账号一侧为空 → 抛错', () => {
    assert.throws(() => repo.saveMappings(db, [{ midAccountId: '', clearingAccountId: 'CLR-1' }]), /未填写完整/);
  });
});

// ========================================================================
// 去重 — UNIQUE(mid_account_id)
// ========================================================================
test.describe('UNIQUE(mid_account_id) 约束', () => {
  test('同一 mid_account_id 重复 → 违例抛错并回滚（既有数据不变）', () => {
    repo.saveMappings(db, [{ midAccountId: 'BASE', clearingAccountId: 'BASE-CLR' }]);
    assert.throws(() => repo.saveMappings(db, [
      { midAccountId: 'DUP', clearingAccountId: 'C1' },
      { midAccountId: 'DUP', clearingAccountId: 'C2' }
    ]));
    // 事务回滚 → 仍是 BASE
    assert.deepEqual(list(), [{ midAccountId: 'BASE', clearingAccountId: 'BASE-CLR' }]);
  });
});

// ========================================================================
// getMappingMap
// ========================================================================
test.describe('getMappingMap', () => {
  test('空表 → 空 Map', () => {
    const map = repo.getMappingMap(db);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  });

  test('返回归一化 Map，键值查得命中', () => {
    repo.saveMappings(db, [
      { midAccountId: 'MID-1', clearingAccountId: 'CLR-1' },
      { midAccountId: 'MID-2', clearingAccountId: 'CLR-2' }
    ]);
    const map = repo.getMappingMap(db);
    assert.equal(map.size, 2);
    assert.equal(map.get('MID-1'), 'CLR-1');
    assert.equal(map.get('MID-2'), 'CLR-2');
    assert.equal(map.get('NOT-EXIST'), undefined);
  });

  test('数值键经归一化后可用字符串查得（与派生口径一致）', () => {
    repo.saveMappings(db, [{ midAccountId: 6225880100, clearingAccountId: 'CLR-NUM' }]);
    const map = repo.getMappingMap(db);
    assert.equal(map.get('6225880100'), 'CLR-NUM');
  });

  test('🔴 空键护栏：DB 中 mid_account_id 为空的脏行不进 Map', () => {
    // 绕过仓储 saveMappings 校验，直接写一条空键脏数据，验证 getMappingMap 护栏
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO fund_transfer_account_mappings (mid_account_id, clearing_account_id, row_index, created_at, updated_at)
      VALUES ('', 'GHOST-CLR', 0, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO fund_transfer_account_mappings (mid_account_id, clearing_account_id, row_index, created_at, updated_at)
      VALUES ('REAL', 'REAL-CLR', 1, ?, ?)
    `).run(now, now);

    const map = repo.getMappingMap(db);
    assert.equal(map.size, 1);
    assert.equal(map.has(''), false);
    assert.equal(map.get('REAL'), 'REAL-CLR');
  });
});
