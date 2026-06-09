// v3.0.1 需求1（task1）：linked_gateway_bill 幂等键 recon_bill_biz_id + UNIQUE 索引迁移单测。
//
// 背景（🔴 资金对账链接表 schema 迁移）：
//   网关对账单批量导入改「按 ReconBillBizId 幂等累加」需在 linked_gateway_bill 上加幂等键列
//   recon_bill_biz_id（回填自 raw_json 精确大小写 ReconBillBizId）+ UNIQUE 索引。
//   🔴 资金红线（spec R-2）：建 UNIQUE 前若存量含空键 / 重复键，CREATE UNIQUE INDEX 抛错
//     → 整个 ensureLinkedTableSupport 事务 ROLLBACK → 资金模块启动失败。
//   清洗策略（OPEN-8 用户拍板）：空键行直接删；重复键保留最大 id（最新导入）。
//   口径：回填用 TRIM(json_extract(...)) 与 linked-table-repository.normalizeKey（String().trim()）一致。
//
// 覆盖：
//   UT-GW-BIZ-1  全新 DB → 跑迁移不报错、含 recon_bill_biz_id 列 + UNIQUE 索引、空表
//   UT-GW-BIZ-2  旧库（无列，含 正常/空键/缺键/重复/带空格键 5 行）→ 迁移：不抛错（AC1-6）、
//                回填 TRIM、空/缺键删除、重复保留最大 id、UNIQUE 建起来并强制约束
//   UT-GW-BIZ-3  旧库连调 2 次 ensureLinkedTableSupport 幂等（第二次列已存在 → 跳过、不再删数据）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-biz-key-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

function colNames(database) {
  return database.prepare("PRAGMA table_info('linked_gateway_bill')").all().map((c) => c.name).sort();
}

function gatewayIndexList(database) {
  return database.prepare("PRAGMA index_list('linked_gateway_bill')").all();
}

function bizValues(database) {
  return database
    .prepare('SELECT recon_bill_biz_id FROM linked_gateway_bill ORDER BY recon_bill_biz_id')
    .all()
    .map((r) => r.recon_bill_biz_id);
}

function rowCount(database) {
  return database.prepare('SELECT COUNT(*) AS c FROM linked_gateway_bill').get().c;
}

// 构造旧 schema（pre-3.0.1：无 recon_bill_biz_id 列）+ 5 行覆盖各清洗分支
function buildLegacyGatewayDb(database) {
  database.exec(`
    CREATE TABLE linked_gateway_bill (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id TEXT,
      bill_date TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
  database.exec('CREATE INDEX idx_linked_gateway_bill_recon ON linked_gateway_bill(reconciliation_id);');
  database.exec('CREATE INDEX idx_linked_gateway_bill_date ON linked_gateway_bill(bill_date);');
  const ins = database.prepare(
    'INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
  );
  // id=1：BIZ-1（旧）
  ins.run('R1', '2026-01-01', JSON.stringify({ ReconBillBizId: 'BIZ-1', reconciliationid: 'R1' }), '2026-01-01T00:00:00.000Z');
  // id=2：BIZ-1 重复（更晚 id → dedup 保留这条）
  ins.run('R1b', '2026-01-02', JSON.stringify({ ReconBillBizId: 'BIZ-1', reconciliationid: 'R1b' }), '2026-01-02T00:00:00.000Z');
  // id=3：空键 → 删
  ins.run('R3', '2026-01-03', JSON.stringify({ ReconBillBizId: '', reconciliationid: 'R3' }), '2026-01-03T00:00:00.000Z');
  // id=4：缺键（json_extract → NULL）→ 删
  ins.run('R4', '2026-01-04', JSON.stringify({ reconciliationid: 'R4' }), '2026-01-04T00:00:00.000Z');
  // id=5：带前后空格键 → 回填 TRIM 成 BIZ-2
  ins.run('R5', '2026-01-05', JSON.stringify({ ReconBillBizId: '  BIZ-2  ', reconciliationid: 'R5' }), '2026-01-05T00:00:00.000Z');
}

test.describe('migrations — linked_gateway_bill recon_bill_biz_id 幂等键 + UNIQUE 迁移（v3.0.1 task1）', () => {
  // UT-GW-BIZ-1：全新 DB → 建表 + 加列 + UNIQUE 索引，空表 UNIQUE 无冲突
  test('UT-GW-BIZ-1：全新 DB → 跑迁移不报错、含 recon_bill_biz_id 列 + UNIQUE 索引、空表', () => {
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '全新 DB 跑迁移不应报错');
    assert.ok(colNames(db).includes('recon_bill_biz_id'), '建表后含 recon_bill_biz_id 列');
    const idx = gatewayIndexList(db).find((i) => i.name === 'idx_linked_gateway_bill_biz');
    assert.ok(idx, '建出 idx_linked_gateway_bill_biz 索引');
    assert.equal(idx.unique, 1, '🔴 该索引为 UNIQUE');
    assert.equal(rowCount(db), 0, '全新库空表');
  });

  // UT-GW-BIZ-2：旧库含空/重复键 → 迁移不抛错（AC1-6）+ 回填 TRIM + 清洗 + UNIQUE 强制
  test('UT-GW-BIZ-2：旧库（空/缺/重复/带空格键）→ 迁移不抛错、回填 TRIM、清洗、UNIQUE 强制（AC1-6）', () => {
    buildLegacyGatewayDb(db);
    assert.ok(!colNames(db).includes('recon_bill_biz_id'), '前置：旧表无 recon_bill_biz_id');
    assert.equal(rowCount(db), 5, '前置 5 行');

    // 🔴 AC1-6 核心：含空键 + 重复键的旧库跑迁移不抛错（否则资金模块启动失败）
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '含空/重复键旧库迁移不抛错（AC1-6）');

    assert.ok(colNames(db).includes('recon_bill_biz_id'), '迁移后含 recon_bill_biz_id 列');
    // 空键(id=3) + 缺键(id=4) 删 2 行；重复 BIZ-1(id=1) 删 1 行 → 剩 2 行
    assert.equal(rowCount(db), 2, '空键 + 缺键 + 重复键清洗后剩 2 行');
    assert.deepEqual(bizValues(db), ['BIZ-1', 'BIZ-2'], '回填值 = 去重后的 BIZ-1 / BIZ-2');

    // 重复键保留最大 id（id=2 的 R1b，非 id=1 的 R1）
    const biz1 = db.prepare("SELECT reconciliation_id FROM linked_gateway_bill WHERE recon_bill_biz_id = 'BIZ-1'").get();
    assert.equal(biz1.reconciliation_id, 'R1b', '重复键保留最大 id（最新导入）那条');

    // 带空格键回填后 TRIM（与 normalizeKey 口径一致）
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM linked_gateway_bill WHERE recon_bill_biz_id = 'BIZ-2'").get().c,
      1,
      '带前后空格键回填后 TRIM 成 BIZ-2（无空格）'
    );

    // UNIQUE 索引建起来 + 真正强制约束
    const idx = gatewayIndexList(db).find((i) => i.name === 'idx_linked_gateway_bill_biz');
    assert.ok(idx && idx.unique === 1, 'UNIQUE 索引建起来');
    assert.throws(
      () => {
        db.prepare(
          'INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at, recon_bill_biz_id) VALUES (?,?,?,?,?)'
        ).run('Rx', '2026-02-01', '{}', '2026-02-01T00:00:00.000Z', 'BIZ-1');
      },
      /UNIQUE|constraint/i,
      '🔴 UNIQUE 约束生效：重复 recon_bill_biz_id 插入被拒'
    );
  });

  // UT-GW-BIZ-3：旧库连调 2 次 ensure 幂等（第二次列已存在 → 守卫跳过，不再删数据）
  test('UT-GW-BIZ-3：旧库连调 2 次 ensureLinkedTableSupport 幂等（不重复清洗）', () => {
    buildLegacyGatewayDb(db);
    ensureLinkedTableSupport(db); // 第一次：ALTER + 回填 + 清洗 + 建 UNIQUE
    const count1 = rowCount(db);
    const biz1 = bizValues(db);
    assert.equal(count1, 2, '第一次迁移后 2 行');

    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '第二次 ensure 不报错');
    assert.equal(rowCount(db), count1, '幂等：第二次不再删数据（守卫 hasColumn 跳过整块）');
    assert.deepEqual(bizValues(db), biz1, '幂等：recon_bill_biz_id 值不变');
  });
});
