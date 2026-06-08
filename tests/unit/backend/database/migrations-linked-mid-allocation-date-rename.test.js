// 块B 前置 spec①：linked_mid_allocation 日期列名残留迁移（business_date → transaction_date）单测。
//
// 背景（🔴 资金对账链接表 schema 迁移）：
//   代码现 schema 该表日期列 = transaction_date（migrations.js 建表）；但跑过中间 beta 构建的机器
//   残留旧列名 business_date。CREATE TABLE IF NOT EXISTS 不迁移已存在表 → 导入 replaceLinkedTable
//   INSERT 用 transaction_date 撞「no column named transaction_date」报错。
//   ensureLinkedTableSupport 内、建表前加幂等 RENAME 防御（双条件门控：旧列在 ∧ 新列不在）。
//
// 覆盖：
//   UT-MID-RENAME-1  正常 DB（已 transaction_date）→ 跑迁移 no-op、不报错、列名/索引不变（幂等）
//   UT-MID-RENAME-2  旧表 DB（business_date + 索引 + 数据）→ 跑迁移 → 列变 transaction_date、
//                    索引引用同步、数据保留
//   UT-MID-RENAME-3  全新 DB（表不存在）→ 跑迁移不报错 + 建表后即为 transaction_date
//   UT-MID-RENAME-4  对旧表 DB 连调 2 次 ensureLinkedTableSupport 幂等（第二次 no-op、结构不变）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureLinkedTableSupport } = require('../../../../src/backend/database/migrations');

let tmpDir;
let db;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-alloc-rename-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 取 linked_mid_allocation 列名集合
function colNames(database) {
  return database.prepare("PRAGMA table_info('linked_mid_allocation')").all().map((c) => c.name).sort();
}

// 取该表的索引名 → 索引覆盖列（验证 RENAME 后索引引用是否同步到新列名）
function indexColumns(database, indexName) {
  return database.prepare(`PRAGMA index_info('${indexName}')`).all().map((r) => r.name);
}

// 构造旧 schema：日期列叫 business_date，索引建在 business_date 上，含一行旧数据
function buildLegacyDb(database) {
  database.exec(`
    CREATE TABLE linked_mid_allocation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      allocation_no TEXT,
      business_date TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
  database.exec('CREATE INDEX idx_linked_mid_allocation_no ON linked_mid_allocation(allocation_no);');
  database.exec('CREATE INDEX idx_linked_mid_allocation_date ON linked_mid_allocation(business_date);');
  database.prepare(
    'INSERT INTO linked_mid_allocation (allocation_no, business_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
  ).run('ALLOC-OLD', '2026-05-04', '{"调拨单号":"ALLOC-OLD"}', '2026-05-04T00:00:00.000Z');
}

test.describe('migrations — linked_mid_allocation business_date→transaction_date 迁移（块B spec①）', () => {
  // UT-MID-RENAME-1：正常 DB（代码现 schema，已 transaction_date）→ 迁移是 no-op，不误改
  test('UT-MID-RENAME-1：已是 transaction_date 的 DB → 跑迁移 no-op、不报错、列名不变（幂等）', () => {
    // 第一次 ensure 建出正常表（transaction_date）
    assert.doesNotThrow(() => ensureLinkedTableSupport(db));
    const before = colNames(db);
    assert.ok(before.includes('transaction_date'), '建表后应含 transaction_date');
    assert.ok(!before.includes('business_date'), '正常表不应含 business_date');

    // 第二次 ensure：双条件门控（旧列在 ∧ 新列不在）不满足 → RENAME 不执行
    assert.doesNotThrow(() => ensureLinkedTableSupport(db));
    const after = colNames(db);
    assert.deepEqual(after, before, '正常 DB 上迁移为 no-op，列名集合不变');
    assert.ok(after.includes('transaction_date'), '仍是 transaction_date');
    assert.ok(!after.includes('business_date'), '未误引入 business_date');
  });

  // UT-MID-RENAME-2：残留旧表（business_date + 索引 + 数据）→ 迁移改名、索引同步、数据保留
  test('UT-MID-RENAME-2：business_date 旧表 → 跑迁移 → 列变 transaction_date、索引同步、数据保留', () => {
    buildLegacyDb(db);
    // 前置确认：旧表确为 business_date，索引建在 business_date
    assert.ok(colNames(db).includes('business_date'), '前置：旧表含 business_date');
    assert.ok(!colNames(db).includes('transaction_date'), '前置：旧表不含 transaction_date');
    assert.deepEqual(
      indexColumns(db, 'idx_linked_mid_allocation_date'), ['business_date'],
      '前置：日期索引建在 business_date'
    );

    // 跑迁移
    assert.doesNotThrow(() => ensureLinkedTableSupport(db));

    // 列名已改名
    const cols = colNames(db);
    assert.ok(cols.includes('transaction_date'), '迁移后含 transaction_date');
    assert.ok(!cols.includes('business_date'), '迁移后不再含 business_date');

    // 索引引用同步到新列名（SQLite RENAME COLUMN 自动更新索引引用）
    assert.deepEqual(
      indexColumns(db, 'idx_linked_mid_allocation_date'), ['transaction_date'],
      '🔴 RENAME 后日期索引引用同步到 transaction_date'
    );

    // 数据保留（17 行旧数据无需丢——RENAME 不动行数据）
    const row = db.prepare('SELECT allocation_no, transaction_date FROM linked_mid_allocation').get();
    assert.equal(row.allocation_no, 'ALLOC-OLD', '旧行 allocation_no 保留');
    assert.equal(row.transaction_date, '2026-05-04', '旧行日期值在新列名下保留');

    // INSERT 用 transaction_date 不再报错（复现报错场景已修复）
    assert.doesNotThrow(() => {
      db.prepare(
        'INSERT INTO linked_mid_allocation (allocation_no, transaction_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
      ).run('ALLOC-NEW', '2026-05-05', '{"调拨单号":"ALLOC-NEW"}', '2026-05-05T00:00:00.000Z');
    }, 'INSERT transaction_date 不再撞 no column named transaction_date');
  });

  // UT-MID-RENAME-3：全新 DB（表尚不存在）→ 迁移前 hasColumn 对空表返回空 → 双条件 false → no-op；建表后即正确列名
  test('UT-MID-RENAME-3：全新 DB（表不存在）→ 跑迁移不报错、建表后为 transaction_date', () => {
    // 表尚不存在时 ensure（迁移判断在建表前；hasColumn 对不存在的表返回空数组 → 双条件 false）
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '全新 DB 跑迁移不应报错');
    const cols = colNames(db);
    assert.ok(cols.includes('transaction_date'), '全新建表即为 transaction_date');
    assert.ok(!cols.includes('business_date'), '全新建表无 business_date');
  });

  // UT-MID-RENAME-4：旧表 DB 连调 2 次 ensure 幂等（第二次迁移条件不满足 → no-op）
  test('UT-MID-RENAME-4：旧表 DB 连调 2 次 ensureLinkedTableSupport 幂等', () => {
    buildLegacyDb(db);
    ensureLinkedTableSupport(db); // 第一次：执行 RENAME
    const after1 = colNames(db);
    assert.ok(after1.includes('transaction_date') && !after1.includes('business_date'), '第一次后已改名');

    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '第二次 ensure 不报错');
    const after2 = colNames(db);
    assert.deepEqual(after2, after1, '幂等：第二次为 no-op，列名集合不变');
    // 数据仍在
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM linked_mid_allocation').get().c;
    assert.equal(cnt, 1, '连调不丢数据');
  });
});
