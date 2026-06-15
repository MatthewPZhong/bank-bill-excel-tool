// v3.0.5 需求2：linked_fx_settlement 幂等键 transaction_no + UNIQUE 索引迁移单测。
//
// 背景（🔴 资金对账链接表 schema 迁移）：
//   外汇交割表批量导入改「按交易编号幂等累加」需在 linked_fx_settlement 上把幂等键列 transaction_no
//   回填为 normalizeTransactionNo(交易编号)（单一真相 = engine-utils，与仓储 upsert / builder 派生同口径）+ UNIQUE 索引。
//   🔴🔴 资金红线（spec R-7 / TechDoc A-2）：交易编号唯一性仅单文件单日（20260513）证实；建 UNIQUE 前若存量含
//     空键 / 重复键，CREATE UNIQUE INDEX 抛错 → 整个 ensureLinkedTableSupport 事务 ROLLBACK → 资金模块启动失败。
//   清洗策略：空键行直接删（归一为空 = 合计/页脚/非数字行）；重复键保留最大 id（最新导入）。delDup>0 = 异常信号，记 appendModuleLog。
//   ⚠️ 与 bank-deposit（SQL TRIM(json_extract)）不同：fx「交易编号」是 number 类型（9 位纯数字），SQL json_extract 取数有量纲歧义
//     → 走 JS 层全表读 + normalizeTransactionNo 归一回填；幂等守卫用「UNIQUE 索引是否已存在」（transaction_no 列本就存在，不能 hasColumn）。
//   ⚠️ 新建 UNIQUE 索引名 idx_linked_fx_settlement_txn_uniq —— 现状已有普通索引 idx_linked_fx_settlement_no（不复用旧名）。
//
// 覆盖：
//   UT-FX-TXN-1  全新 DB → 跑迁移不报错、含 transaction_no 列 + UNIQUE 索引、空表
//   UT-FX-TXN-2  旧库（正常 number / 带尾零小数 / 合计行非数字 / 缺键 / 重复键 5 行）→ 迁移：不抛错、JS 层归一回填、
//                空/缺键删除、重复保留最大 id、UNIQUE 建起来并强制约束、meta 重算
//   UT-FX-TXN-3  旧库连调 2 次 ensureLinkedTableSupport 幂等（第二次 UNIQUE 索引已存在 → 跳过、不再删数据）
//   UT-FX-TXN-4  🔴🔴 键真撞去重显式断言（R-7）：两行同交易编号 → 剩 1 行（id 最大）+ appendModuleLog 记 delDup=1（日志可见性）
//   UT-FX-TXN-5  number 类型交易编号正确 String 化为键（926181062 number → transaction_no='926181062'）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureLinkedTableSupport } = require('../../../../src/backend/database/migrations');
const logger = require('../../../../src/backend/logger');

let tmpDir;
let db;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-txn-key-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  logger.setActivityLogStorageRoot(null); // 复位日志根，避免污染其他用例
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

function colNames(database) {
  return database.prepare("PRAGMA table_info('linked_fx_settlement')").all().map((c) => c.name).sort();
}

function fxIndexList(database) {
  return database.prepare("PRAGMA index_list('linked_fx_settlement')").all();
}

function txnValues(database) {
  return database
    .prepare('SELECT transaction_no FROM linked_fx_settlement ORDER BY transaction_no')
    .all()
    .map((r) => r.transaction_no);
}

function rowCount(database) {
  return database.prepare('SELECT COUNT(*) AS c FROM linked_fx_settlement').get().c;
}

// 构造旧 schema（pre-3.0.5：transaction_no 列存在但非 UNIQUE，存量整行落库含合计行）。
//   交易编号在 raw_json 内为 number / 文本（合计行），模拟真实交割表导入产物。
function buildLegacyFxDb(database) {
  database.exec(`
    CREATE TABLE linked_fx_settlement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_no TEXT,
      transaction_date TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
  database.exec('CREATE INDEX idx_linked_fx_settlement_no ON linked_fx_settlement(transaction_no);');
  database.exec('CREATE INDEX idx_linked_fx_settlement_date ON linked_fx_settlement(transaction_date);');
  const ins = database.prepare(
    'INSERT INTO linked_fx_settlement (transaction_no, transaction_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
  );
  // id=1：正常 number 交易编号（旧覆盖产物 transaction_no 可能存的是 String(number)）
  ins.run('926181062', '2026-05-13', JSON.stringify({ '交易编号': 926181062, '交易日期': '2026-05-13' }), '2026-05-13T00:00:00.000Z');
  // id=2：与 id=1 同交易编号（更晚 id → dedup 保留这条），值不同便于验证保留最新
  ins.run('926181062', '2026-05-14', JSON.stringify({ '交易编号': 926181062, '交易日期': '2026-05-14', '备注': 'newer' }), '2026-05-14T00:00:00.000Z');
  // id=3：带尾零小数 → 归一去尾零 926181063
  ins.run('926181063.0', '2026-05-13', JSON.stringify({ '交易编号': '926181063.0', '交易日期': '2026-05-13' }), '2026-05-13T00:00:00.000Z');
  // id=4：合计/页脚行（交易编号为非数字文本 "生成日期:..."）→ 归一为空 → 删
  ins.run('生成日期:20260513', '', JSON.stringify({ '交易编号': '生成日期:20260513' }), '2026-05-13T00:00:00.000Z');
  // id=5：缺键（json 无「交易编号」）→ 归一为空 → 删
  ins.run('', '', JSON.stringify({ '交易日期': '2026-05-13' }), '2026-05-13T00:00:00.000Z');
}

// 旧库已有 linked_table_meta 的 fx-settlement 旧 meta 行（旧行数 / 旧日期范围）。
function seedLegacyFxMeta(database) {
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
    .run('fx-settlement', '2026-05-13', '2026-05-14', 5, '旧交割表.xls', '2026-05-14T00:00:00.000Z');
}

function fxMeta(database) {
  return database
    .prepare("SELECT row_count, data_date_min, data_date_max FROM linked_table_meta WHERE table_key = 'fx-settlement'")
    .get();
}

// 读取本用例临时目录里 appendModuleLog 写出的 warning.log（JSON Lines），返回解析后的记录数组。
function readWarningLogs() {
  const logsRoot = path.join(tmpDir, 'logs');
  if (!fs.existsSync(logsRoot)) return [];
  const out = [];
  // logs/{YYYY-MM}/{MM-DD}/warning.log —— 递归找所有 warning.log
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name === 'warning.log') {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try { out.push(JSON.parse(s)); } catch (_e) { /* ignore */ }
        }
      }
    }
  };
  walk(logsRoot);
  return out;
}

test.describe('migrations — linked_fx_settlement transaction_no 幂等键 + UNIQUE 迁移（v3.0.5 需求2）', () => {
  // UT-FX-TXN-1：全新 DB → 建表 + UNIQUE 索引，空表 UNIQUE 无冲突
  test('UT-FX-TXN-1：全新 DB → 跑迁移不报错、含 transaction_no 列 + UNIQUE 索引、空表', () => {
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '全新 DB 跑迁移不应报错');
    assert.ok(colNames(db).includes('transaction_no'), '建表后含 transaction_no 列');
    const idx = fxIndexList(db).find((i) => i.name === 'idx_linked_fx_settlement_txn_uniq');
    assert.ok(idx, '建出 idx_linked_fx_settlement_txn_uniq 索引');
    assert.equal(idx.unique, 1, '🔴 该索引为 UNIQUE');
    assert.equal(rowCount(db), 0, '全新库空表');
  });

  // UT-FX-TXN-2：旧库含合计行/缺键/重复键 → 迁移不抛错 + JS 层归一回填 + 清洗 + UNIQUE 强制 + meta 重算
  test('UT-FX-TXN-2：旧库（正常/尾零小数/合计行/缺键/重复键）→ 迁移不抛错、归一回填、清洗、UNIQUE 强制、meta 重算', () => {
    buildLegacyFxDb(db);
    seedLegacyFxMeta(db);
    const idxBefore = fxIndexList(db).find((i) => i.name === 'idx_linked_fx_settlement_txn_uniq');
    assert.ok(!idxBefore, '前置：旧表无 UNIQUE 索引');
    assert.equal(rowCount(db), 5, '前置 5 行');
    assert.equal(fxMeta(db).row_count, 5, '前置 meta row_count=5（旧值）');

    // 🔴 核心：含合计行(归一为空) + 重复键的旧库跑迁移不抛错（否则资金模块启动失败）
    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '含合计行/重复键旧库迁移不抛错');

    // 合计行(id=4) + 缺键(id=5) 删 2 行；重复 926181062(id=1) 删 1 行 → 剩 2 行（926181062 / 926181063）
    assert.equal(rowCount(db), 2, '合计行 + 缺键 + 重复键清洗后剩 2 行');
    assert.deepEqual(txnValues(db), ['926181062', '926181063'], '归一回填值 = 去重后的两交易编号（尾零小数已去零）');

    // 重复键保留最大 id（id=2 的 newer，非 id=1）
    const kept = db.prepare("SELECT raw_json FROM linked_fx_settlement WHERE transaction_no = '926181062'").get();
    assert.equal(JSON.parse(kept.raw_json)['备注'], 'newer', '重复键保留最大 id（最新导入）那条');

    // UNIQUE 索引建起来 + 真正强制约束
    const idx = fxIndexList(db).find((i) => i.name === 'idx_linked_fx_settlement_txn_uniq');
    assert.ok(idx && idx.unique === 1, 'UNIQUE 索引建起来');
    assert.throws(
      () => {
        db.prepare(
          'INSERT INTO linked_fx_settlement (transaction_no, transaction_date, raw_json, imported_at) VALUES (?,?,?,?)'
        ).run('926181062', '2026-06-01', '{}', '2026-06-01T00:00:00.000Z');
      },
      /UNIQUE|constraint/i,
      '🔴 UNIQUE 约束生效：重复 transaction_no 插入被拒'
    );

    // meta 重算（口径对齐 recomputeLinkedMeta）：保留行 = id=2（926181062，2026-05-14）+ id=3（926181063，2026-05-13）
    const meta = fxMeta(db);
    assert.equal(meta.row_count, 2, 'meta row_count 重算为清洗后剩余 2 行（非旧值 5）');
    assert.equal(meta.data_date_min, '2026-05-13', 'meta 日期下界重算 = 保留行最早 transaction_date');
    assert.equal(meta.data_date_max, '2026-05-14', 'meta 日期上界重算 = 保留行最晚 transaction_date');
  });

  // UT-FX-TXN-3：旧库连调 2 次 ensure 幂等（第二次 UNIQUE 索引已存在 → 守卫跳过，不再删数据）
  test('UT-FX-TXN-3：旧库连调 2 次 ensureLinkedTableSupport 幂等（不重复清洗）', () => {
    buildLegacyFxDb(db);
    ensureLinkedTableSupport(db); // 第一次：回填 + 清洗 + 建 UNIQUE
    const count1 = rowCount(db);
    const txn1 = txnValues(db);
    assert.equal(count1, 2, '第一次迁移后 2 行');

    assert.doesNotThrow(() => ensureLinkedTableSupport(db), '第二次 ensure 不报错');
    assert.equal(rowCount(db), count1, '幂等：第二次不再删数据（守卫 UNIQUE 索引已存在跳过整块）');
    assert.deepEqual(txnValues(db), txn1, '幂等：transaction_no 值不变');
  });

  // UT-FX-TXN-4：🔴🔴 键真撞去重显式断言（R-7）—— delDup=1 + appendModuleLog 记录（日志可见性）
  test('UT-FX-TXN-4：键真撞去重保留 id 最大 + appendModuleLog 记 delDup=1（R-7 资金红线日志可见性）', () => {
    // 注入临时日志根 → appendModuleLog 写到 tmpDir/logs/.../warning.log
    logger.setActivityLogStorageRoot(tmpDir);
    // 仅两行同交易编号（无空键，纯测「真撞键」去重 + 日志）
    db.exec(`
      CREATE TABLE linked_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_no TEXT, transaction_date TEXT, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX idx_linked_fx_settlement_no ON linked_fx_settlement(transaction_no);');
    db.exec('CREATE INDEX idx_linked_fx_settlement_date ON linked_fx_settlement(transaction_date);');
    const ins = db.prepare('INSERT INTO linked_fx_settlement (transaction_no, transaction_date, raw_json, imported_at) VALUES (?,?,?,?)');
    ins.run('555000111', '2026-05-13', JSON.stringify({ '交易编号': 555000111, v: 'old' }), '2026-05-13T00:00:00.000Z');
    ins.run('555000111', '2026-05-14', JSON.stringify({ '交易编号': 555000111, v: 'new' }), '2026-05-14T00:00:00.000Z');

    ensureLinkedTableSupport(db);

    assert.equal(rowCount(db), 1, '🔴 真撞键去重后剩 1 行');
    const kept = db.prepare("SELECT raw_json FROM linked_fx_settlement WHERE transaction_no = '555000111'").get();
    assert.equal(JSON.parse(kept.raw_json).v, 'new', '🔴 保留 id 最大（最新）那条');

    // 日志可见性：warning.log 含 fx 幂等键迁移记录 + delDup=1 明细
    const warns = readWarningLogs();
    const fxLog = warns.find((w) => w && typeof w.message === 'string' && w.message.includes('linked_fx_settlement 幂等键迁移'));
    assert.ok(fxLog, '🔴 appendModuleLog 写出 fx 幂等键迁移 warning（delDup>0 的可见性兜底）');
    assert.ok(
      Array.isArray(fxLog.details) && fxLog.details.some((d) => /删除重复键旧行 1 条/.test(d)),
      '🔴 日志 details 记 delDup=1（真撞键唯一观测口径，spec R-7）'
    );
  });

  // UT-FX-TXN-5：number 类型交易编号正确 String 化为键
  test('UT-FX-TXN-5：number 类型交易编号正确 String 化为 transaction_no 键', () => {
    db.exec(`
      CREATE TABLE linked_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_no TEXT, transaction_date TEXT, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX idx_linked_fx_settlement_no ON linked_fx_settlement(transaction_no);');
    db.exec('CREATE INDEX idx_linked_fx_settlement_date ON linked_fx_settlement(transaction_date);');
    // transaction_no 旧列留空，仅 raw_json 内为 number → 验证 JS 层归一回填 number → 纯数字串
    db.prepare('INSERT INTO linked_fx_settlement (transaction_no, transaction_date, raw_json, imported_at) VALUES (?,?,?,?)')
      .run('', '2026-05-13', JSON.stringify({ '交易编号': 926181062, '交易日期': '2026-05-13' }), '2026-05-13T00:00:00.000Z');

    ensureLinkedTableSupport(db);

    assert.equal(rowCount(db), 1, 'number 交易编号行未被误删（归一非空）');
    assert.deepEqual(txnValues(db), ['926181062'], '🔴 number 926181062 经 normalizeTransactionNo String 化为 transaction_no=926181062');
  });
});
