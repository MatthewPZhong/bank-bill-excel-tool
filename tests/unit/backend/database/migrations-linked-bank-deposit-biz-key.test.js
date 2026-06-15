// v3.0.5 需求1：linked_bank_deposit 幂等键 biz_id + UNIQUE 索引迁移单测。
//
// 背景（🔴 资金对账链接表 schema 迁移）：
//   银行对账单入金表批量导入改「按 BizId 幂等累加」需在 linked_bank_deposit 上加幂等键列
//   biz_id（回填自 raw_json 精确大小写 BizId）+ UNIQUE 索引。
//   🔴🔴 资金红线（spec R-1/R-6）：65.7 万行存量表，全程 SQL 侧（不可 JS 全表读 OOM）；建 UNIQUE 前若存量含
//     空键 / 重复键，CREATE UNIQUE INDEX 抛错 → 整个 ensureLinkedTableSupport 事务 ROLLBACK → 资金模块启动失败。
//   清洗策略（OPEN-1 同 gateway 口径）：空键行直接删；重复键保留最大 id（最新导入）。
//   口径：回填用 TRIM(json_extract(...,'$.BizId')) 与 linked-table-repository.normalizeKey（String().trim()）字节一致。
//   ⚠️ 新建 UNIQUE 索引须用不同名（idx_linked_bank_deposit_biz）——现状已有普通索引 idx_linked_bank_deposit_recon。
//
// 覆盖：
//   UT-BD-BIZ-1  全新 DB → 跑迁移不报错、含 biz_id 列 + UNIQUE 索引、空表
//   UT-BD-BIZ-2  旧库（无列，含 正常/空键/缺键/重复/带空格键 5 行）→ 迁移：不抛错、回填 TRIM、
//                空/缺键删除、重复保留最大 id、UNIQUE 建起来并强制约束、meta 重算
//   UT-BD-BIZ-3  旧库连调 2 次 ensureLinkedTableSupport 幂等（第二次列已存在 → 跳过、不再删数据）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-biz-key-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

function colNames(database) {
  return database.prepare("PRAGMA table_info('linked_bank_deposit')").all().map((c) => c.name).sort();
}

function bdIndexList(database) {
  return database.prepare("PRAGMA index_list('linked_bank_deposit')").all();
}

function bizValues(database) {
  return database
    .prepare('SELECT biz_id FROM linked_bank_deposit ORDER BY biz_id')
    .all()
    .map((r) => r.biz_id);
}

function rowCount(database) {
  return database.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c;
}

// 构造旧 schema（pre-3.0.5：无 biz_id 列）+ 5 行覆盖各清洗分支。
function buildLegacyBankDepositDb(database) {
  database.exec(`
    CREATE TABLE linked_bank_deposit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id TEXT,
      bill_date TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
  database.exec('CREATE INDEX idx_linked_bank_deposit_recon ON linked_bank_deposit(reconciliation_id);');
  database.exec('CREATE INDEX idx_linked_bank_deposit_date ON linked_bank_deposit(bill_date);');
  const ins = database.prepare(
    'INSERT INTO linked_bank_deposit (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
  );
  // id=1：BIZ-1（旧）
  ins.run('R1', '2026-01-01', JSON.stringify({ BizId: 'BIZ-1', ReconciliationId: 'R1' }), '2026-01-01T00:00:00.000Z');
  // id=2：BIZ-1 重复（更晚 id → dedup 保留这条）
  ins.run('R1b', '2026-01-02', JSON.stringify({ BizId: 'BIZ-1', ReconciliationId: 'R1b' }), '2026-01-02T00:00:00.000Z');
  // id=3：空键 → 删
  ins.run('R3', '2026-01-03', JSON.stringify({ BizId: '', ReconciliationId: 'R3' }), '2026-01-03T00:00:00.000Z');
  // id=4：缺键（json_extract → NULL）→ 删
  ins.run('R4', '2026-01-04', JSON.stringify({ ReconciliationId: 'R4' }), '2026-01-04T00:00:00.000Z');
  // id=5：带前后空格键 → 回填 TRIM 成 BIZ-2
  ins.run('R5', '2026-01-05', JSON.stringify({ BizId: '  BIZ-2  ', ReconciliationId: 'R5' }), '2026-01-05T00:00:00.000Z');
}

// 旧库已有 linked_table_meta 的 bank-deposit 旧 meta 行（旧行数 / 旧日期范围）。
//   迁移清洗删除后须重算该 meta 行（否则 row-count/日期范围读旧值）。
function seedLegacyBankDepositMeta(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS linked_table_meta (
      table_key TEXT PRIMARY KEY,
      data_date_min TEXT,
      data_date_max TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      source_file_name TEXT,
      updated_at TEXT
    );
  `);
  database
    .prepare(
      'INSERT INTO linked_table_meta (table_key, data_date_min, data_date_max, row_count, source_file_name, updated_at) VALUES (?,?,?,?,?,?)'
    )
    .run('bank-deposit', '2026-01-01', '2026-01-05', 5, '旧银行对账单.xlsx', '2026-01-05T00:00:00.000Z');
}

function bankDepositMeta(database) {
  return database
    .prepare("SELECT row_count, data_date_min, data_date_max, source_file_name FROM linked_table_meta WHERE table_key = 'bank-deposit'")
    .get();
}

test.describe('migrations — linked_bank_deposit biz_id 幂等键 + UNIQUE 迁移（v3.0.5 需求1）', () => {
  // UT-BD-BIZ-1：全新 DB → 建表 + 加列 + UNIQUE 索引，空表 UNIQUE 无冲突
  test('UT-BD-BIZ-1：全新 DB → 跑迁移不报错、含 biz_id 列 + UNIQUE 索引、空表', () => {
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '全新 DB 跑迁移不应报错');
    assert.ok(colNames(db).includes('biz_id'), '建表后含 biz_id 列');
    const idx = bdIndexList(db).find((i) => i.name === 'idx_linked_bank_deposit_biz');
    assert.ok(idx, '建出 idx_linked_bank_deposit_biz 索引');
    assert.equal(idx.unique, 1, '🔴 该索引为 UNIQUE');
    assert.equal(rowCount(db), 0, '全新库空表');
  });

  // UT-BD-BIZ-2：旧库含空/重复键 → 迁移不抛错 + 回填 TRIM + 清洗 + UNIQUE 强制 + meta 重算
  test('UT-BD-BIZ-2：旧库（空/缺/重复/带空格键）→ 迁移不抛错、回填 TRIM、清洗、UNIQUE 强制、meta 重算', () => {
    buildLegacyBankDepositDb(db);
    seedLegacyBankDepositMeta(db);
    assert.ok(!colNames(db).includes('biz_id'), '前置：旧表无 biz_id');
    assert.equal(rowCount(db), 5, '前置 5 行');
    assert.equal(bankDepositMeta(db).row_count, 5, '前置 meta row_count=5（旧值）');

    // 🔴 核心：含空键 + 重复键的旧库跑迁移不抛错（否则资金模块启动失败）
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '含空/重复键旧库迁移不抛错');

    assert.ok(colNames(db).includes('biz_id'), '迁移后含 biz_id 列');
    // 空键(id=3) + 缺键(id=4) 删 2 行；重复 BIZ-1(id=1) 删 1 行 → 剩 2 行
    assert.equal(rowCount(db), 2, '空键 + 缺键 + 重复键清洗后剩 2 行');
    assert.deepEqual(bizValues(db), ['BIZ-1', 'BIZ-2'], '回填值 = 去重后的 BIZ-1 / BIZ-2');

    // 重复键保留最大 id（id=2 的 R1b，非 id=1 的 R1）
    const biz1 = db.prepare("SELECT reconciliation_id FROM linked_bank_deposit WHERE biz_id = 'BIZ-1'").get();
    assert.equal(biz1.reconciliation_id, 'R1b', '重复键保留最大 id（最新导入）那条');

    // 带空格键回填后 TRIM
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM linked_bank_deposit WHERE biz_id = 'BIZ-2'").get().c,
      1,
      '带前后空格键回填后 TRIM 成 BIZ-2（无空格）'
    );

    // UNIQUE 索引建起来 + 真正强制约束
    const idx = bdIndexList(db).find((i) => i.name === 'idx_linked_bank_deposit_biz');
    assert.ok(idx && idx.unique === 1, 'UNIQUE 索引建起来');
    assert.throws(
      () => {
        db.prepare(
          'INSERT INTO linked_bank_deposit (reconciliation_id, bill_date, raw_json, imported_at, biz_id) VALUES (?,?,?,?,?)'
        ).run('Rx', '2026-02-01', '{}', '2026-02-01T00:00:00.000Z', 'BIZ-1');
      },
      /UNIQUE|constraint/i,
      '🔴 UNIQUE 约束生效：重复 biz_id 插入被拒'
    );

    // meta 重算（口径对齐 recomputeLinkedMeta）：保留行 = id=2（BIZ-1，2026-01-02）+ id=5（BIZ-2，2026-01-05）
    const meta = bankDepositMeta(db);
    assert.equal(meta.row_count, 2, 'meta row_count 重算为清洗后剩余 2 行（非旧值 5）');
    assert.equal(meta.data_date_min, '2026-01-02', 'meta 日期下界重算 = 保留行最早 bill_date');
    assert.equal(meta.data_date_max, '2026-01-05', 'meta 日期上界重算 = 保留行最晚 bill_date');
  });

  // UT-BD-BIZ-3：旧库连调 2 次 ensure 幂等（第二次列已存在 → 守卫跳过，不再删数据）
  test('UT-BD-BIZ-3：旧库连调 2 次 ensureLinkedTableSupport 幂等（不重复清洗）', () => {
    buildLegacyBankDepositDb(db);
    ensureLinkedTableSupport(db); // 第一次：ALTER + 回填 + 清洗 + 建 UNIQUE
    const count1 = rowCount(db);
    const biz1 = bizValues(db);
    assert.equal(count1, 2, '第一次迁移后 2 行');

    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '第二次 ensure 不报错');
    assert.equal(rowCount(db), count1, '幂等：第二次不再删数据（守卫 hasColumn 跳过整块）');
    assert.deepEqual(bizValues(db), biz1, '幂等：biz_id 值不变');
  });
});
