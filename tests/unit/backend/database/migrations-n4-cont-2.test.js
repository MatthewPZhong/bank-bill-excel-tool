// v2.1.10 N4-cont-2 (T29)：ensureDiffRowsCascadeMigration_v2_1_10 单元测试
//   spec §5.2 + §5.3 + §5.4
//
// 覆盖（spec §5.3.2 + tasks T29 §unit test）：
//   1. status='skipped'（已迁过 — flag = '1'）
//   2. status='skipped-no-table'（diff_rows 表不存在 — 新装用户极早期路径）
//   3. status='skipped-already-cascaded'（PRAGMA foreign_key_list 显示 2 FK 都已 CASCADE）
//   4. status='migrated' 正常路径 + 验证新 schema 含 ON DELETE CASCADE
//   5. status='backup-failed'（人为 createBackupFn throw → 不动 schema + 不写 flag）
//   6. status='migration-failed'（人为 db.exec proxy 抛错 → ROLLBACK + 保留备份 + 不写 flag）
//   7. status='conflict-detected'（人为 INSERT INTO new 时漏行 → 行数对账失败 → ROLLBACK）
//   8. 跨版本：v2.1.7 老 schema → v2.1.10 一步迁（含 N4 + N5 + N4-cont-2 链协同）
//   9. CASCADE 实测：迁后插测试数据 → DELETE run → diff_rows 自动清；DELETE bill_import → diff_rows 自动清
//  10. 二次跑 skipped + 不修改数据 + 不动备份目录
//  11. backupFn 缺失（兼容老调用方）→ migration 仍跑 + backupPath=null
//  12. statusReached 字段在各 status 下符合 8-status state machine

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureDiffRowsCascadeMigration_v2_1_10,
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');

let tmpDir;
let dbPath;
let db;
let backupDir;

function makeBackupFn() {
  return (label) => createBackup(db, label, backupDir);
}

// 模拟 v2.1.9 老 schema（diff_rows 表存在，FK 无 ON DELETE CASCADE）
//   只建 N4-cont-2 strict dependency：app_settings + runs + bill_imports + diff_rows
//   不引入其他 migration（避免触发 Phase 4 ensureAcquiringBillCurrencyRawJsonRetentionSettings 等噪音）
function bootstrapV219DiffRowsSchema(currentDb) {
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL,
      matched_rows INTEGER NOT NULL,
      mismatch_rows INTEGER NOT NULL,
      unmatched_rows INTEGER NOT NULL,
      status TEXT NOT NULL,
      diff_file_path TEXT,
      report_file_path TEXT
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
    );

    CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_diff_run
      ON acquiring_bill_currency_diff_rows(run_id);
  `);
}

// 模拟 v2.1.10 schema（diff_rows 表已含 CASCADE — 用于 case 3 skipped-already-cascaded）
function bootstrapV2110DiffRowsSchemaWithCascade(currentDb) {
  currentDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL,
      matched_rows INTEGER NOT NULL,
      mismatch_rows INTEGER NOT NULL,
      unmatched_rows INTEGER NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id) ON DELETE CASCADE
    );
  `);
}

function seedRunAndBills(currentDb, { runCount = 1, billsPerRun = 3, diffsPerBill = 1 } = {}) {
  const now = new Date().toISOString();
  const runIds = [];
  for (let r = 0; r < runCount; r++) {
    const runInsert = currentDb.prepare(`
      INSERT INTO acquiring_bill_currency_runs
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`2026-0${r + 1}`, now, billsPerRun, 0, billsPerRun, 0, 'success');
    const runId = Number(runInsert.lastInsertRowid);
    runIds.push(runId);
    for (let b = 0; b < billsPerRun; b++) {
      const billInsert = currentDb.prepare(`
        INSERT INTO acquiring_bill_currency_bill_imports
          (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
        VALUES (?, 'b.xlsx', ?, ?, 'USD', 'usd', '{}', ?)
      `).run(`2026-0${r + 1}`, b + 1, `R${r}-B${b}`, now);
      const billId = Number(billInsert.lastInsertRowid);
      for (let d = 0; d < diffsPerBill; d++) {
        currentDb.prepare(`
          INSERT INTO acquiring_bill_currency_diff_rows
            (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
          VALUES (?, ?, 'CNY', '10.00', 'currency_mismatch')
        `).run(runId, billId);
      }
    }
  }
  return { runIds };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-cont-2-test-'));
  dbPath = path.join(tmpDir, 'tool-data.sqlite');
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('ensureDiffRowsCascadeMigration_v2_1_10', () => {
  test('case 1：标志位 = "1" → status=skipped + 不改 schema', () => {
    bootstrapV219DiffRowsSchema(db);
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, '1', ?)
    `).run('n4_cont_2_diff_rows_cascade_migrated', new Date().toISOString());

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.statusReached, 'pending');
    // 备份目录不应被建（skipped 路径不调 createBackupFn）
    assert.strictEqual(fs.existsSync(backupDir), false);
  });

  test('case 2：diff_rows 表不存在 → status=skipped-no-table + 标志位被补写', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // 不建 diff_rows / runs / bill_imports

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(result.status, 'skipped-no-table');
    // 标志位被补写（避免下次重复 check）
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker && marker.setting_value, '1');
  });

  test('case 3：FK 已含 ON DELETE CASCADE → status=skipped-already-cascaded + 标志位被补写', () => {
    bootstrapV2110DiffRowsSchemaWithCascade(db);

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(result.status, 'skipped-already-cascaded');
    // 标志位被补写
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker && marker.setting_value, '1');
    // schema 未变（FK 仍是 CASCADE）
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.strictEqual(fkList.length, 2);
    assert.ok(fkList.every((f) => String(f.on_delete).toUpperCase() === 'CASCADE'));
  });

  test('case 4：正常 migrated → 新 schema 含 CASCADE + 备份文件存在 + statusReached=committed + 标志位写入', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db, { runCount: 2, billsPerRun: 3, diffsPerBill: 2 });
    const beforeDiffCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(result.status, 'migrated');
    assert.strictEqual(result.statusReached, 'committed');
    assert.strictEqual(result.rowsAffected, beforeDiffCount);
    assert.ok(typeof result.backupPath === 'string');
    assert.ok(fs.existsSync(result.backupPath));
    assert.match(path.basename(result.backupPath), /^tool-data-bak-pre-N4-cont-2-\d{8}T\d{6}\.sqlite$/);

    // 新 schema FK 都已加 CASCADE
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.strictEqual(fkList.length, 2);
    const runFk = fkList.find((f) => f.from === 'run_id');
    const billFk = fkList.find((f) => f.from === 'bill_import_id');
    assert.strictEqual(String(runFk.on_delete).toUpperCase(), 'CASCADE');
    assert.strictEqual(String(billFk.on_delete).toUpperCase(), 'CASCADE');

    // 行数完全保留
    const afterDiffCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
    assert.strictEqual(afterDiffCount, beforeDiffCount);

    // 索引重建
    const indexes = db.prepare(`PRAGMA index_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(indexes.some((idx) => idx.name === 'idx_acquiring_bill_currency_diff_run'));

    // 标志位 = '1'
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker && marker.setting_value, '1');
  });

  test('case 5：createBackupFn 抛错 → status=backup-failed + schema 未动 + 标志位不写', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);

    const failingBackup = () => { throw new Error('mock disk full'); };
    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, failingBackup);

    assert.strictEqual(result.status, 'backup-failed');
    assert.match(result.error, /mock disk full/);
    // 标志位不写
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker, undefined);
    // schema 未变（FK 仍无 CASCADE）
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(fkList.every((f) => String(f.on_delete).toUpperCase() === 'NO ACTION'));
  });

  test('case 6：rebuild 内 step 失败（DROP TABLE 阶段注入错误） → status=migration-failed + ROLLBACK + 备份保留', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);
    const beforeDiffCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;

    // 注入：DROP TABLE 阶段抛错
    const originalExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (typeof sql === 'string' && sql.includes('DROP TABLE acquiring_bill_currency_diff_rows')) {
        throw new Error('injected fault: DROP TABLE failed');
      }
      return originalExec(sql);
    };

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());

    // 恢复 exec 以便后续 cleanup
    db.exec = originalExec;

    assert.strictEqual(result.status, 'migration-failed');
    assert.match(result.error, /injected fault/);
    // 备份保留
    assert.ok(typeof result.backupPath === 'string');
    assert.ok(fs.existsSync(result.backupPath));
    // 标志位不写
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker, undefined);
    // ROLLBACK 后老 schema 保留（diff_rows 行数不变 + FK 仍无 CASCADE）
    const afterDiffCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
    assert.strictEqual(afterDiffCount, beforeDiffCount);
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(fkList.every((f) => String(f.on_delete).toUpperCase() === 'NO ACTION'));
    // 新表也应不存在
    const newTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='acquiring_bill_currency_diff_rows_new'"
    ).get();
    assert.strictEqual(newTable, undefined);
  });

  test('case 7：conflict-detected（人为 INSERT 漏行）→ status=conflict-detected + ROLLBACK + 不写 flag', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db, { runCount: 1, billsPerRun: 3, diffsPerBill: 2 });

    // 注入：拦截 INSERT INTO ..._new SELECT — 替换 SELECT 加 LIMIT 1 制造漏行
    const originalExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (typeof sql === 'string' && /INSERT INTO acquiring_bill_currency_diff_rows_new/.test(sql)) {
        // 模拟漏行：手工执行只插 1 行（与全表对账失败）
        const limitedSql = sql.replace(
          /FROM acquiring_bill_currency_diff_rows;?/,
          'FROM acquiring_bill_currency_diff_rows LIMIT 1;'
        );
        return originalExec(limitedSql);
      }
      return originalExec(sql);
    };

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    db.exec = originalExec;

    assert.strictEqual(result.status, 'conflict-detected');
    assert.match(result.error, /行数不匹配/);
    // 备份保留 + 标志位不写
    assert.ok(typeof result.backupPath === 'string');
    assert.ok(fs.existsSync(result.backupPath));
    const marker = db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(marker, undefined);
    // 老 schema 保留
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(fkList.every((f) => String(f.on_delete).toUpperCase() === 'NO ACTION'));
  });

  test('case 8：跨版本 v2.1.7 老 schema → v2.1.10 一步迁（T30 集成后 N4 / N5 / N4-cont-2 三链协同 + 二次幂等）', () => {
    // 模拟 v2.1.7 老库 — 仅起 minimum schema，由 AppDatabase init 跑全链 migration
    db.close();
    db = null;

    // Step 1：AppDatabase init 完整走 N4 (v2.1.8) + N5 (v2.1.9) + N4-cont-2 (v2.1.10)
    const { AppDatabase } = require('../../../../src/backend/database');
    const v217DbPath = path.join(tmpDir, 'v217-bootstrap.sqlite');
    const appDb = new AppDatabase(v217DbPath);
    appDb.init();

    // 三链标志位全部写入
    const n4Marker = appDb.db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_v2_migrated'"
    ).get();
    const n5Marker = appDb.db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'"
    ).get();
    const n4Cont2Marker = appDb.db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(n4Marker && n4Marker.setting_value, 'true', 'N4 标志位 = true（v2.1.7 → v2.1.8 N4 已迁）');
    assert.strictEqual(n5Marker && n5Marker.setting_value, 'true', 'N5 标志位 = true（v2.1.8 → v2.1.9 N5 已迁）');
    assert.strictEqual(n4Cont2Marker && n4Cont2Marker.setting_value, '1', 'N4-cont-2 标志位 = "1"（v2.1.9 → v2.1.10 已迁）');

    // schema 已含 CASCADE（T30 集成后 init 末尾自然完成 N4-cont-2）
    const fkAfter = appDb.db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.strictEqual(fkAfter.length, 2, 'diff_rows FK 数 = 2 (run_id + bill_import_id)');
    assert.ok(fkAfter.every((f) => String(f.on_delete).toUpperCase() === 'CASCADE'), '2 FK 都已含 ON DELETE CASCADE');

    // Step 2：二次 init 幂等 — 标志位仍 = '1' / schema 不变 / N4-cont-2 跳过（skipped 路径）
    try { appDb.db.close(); } catch (_) {}
    const appDb2 = new AppDatabase(v217DbPath);
    appDb2.init();
    const n4Cont2Marker2 = appDb2.db.prepare(
      "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
    ).get();
    assert.strictEqual(n4Cont2Marker2 && n4Cont2Marker2.setting_value, '1', '二次 init 后 N4-cont-2 标志位仍 = "1"');
    const fkAfter2 = appDb2.db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(fkAfter2.every((f) => String(f.on_delete).toUpperCase() === 'CASCADE'), '二次 init 后 FK 仍 CASCADE');

    try { appDb2.db.close(); } catch (_) {}
  });

  test('case 9：CASCADE 实测 — DELETE run → diff_rows 自动清；DELETE bill_import → diff_rows 自动清', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db, { runCount: 2, billsPerRun: 3, diffsPerBill: 2 });

    // 迁移到 v2.1.10
    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(result.status, 'migrated');

    // 实测 CASCADE 删 run
    const totalDiffsBefore = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
    const run1Diffs = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE run_id = 1').get().cnt;
    assert.ok(run1Diffs > 0);
    db.prepare('DELETE FROM acquiring_bill_currency_runs WHERE id = 1').run();
    const totalDiffsAfter = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
    assert.strictEqual(totalDiffsAfter, totalDiffsBefore - run1Diffs, '删 run_id=1 后 diff_rows 自动清对应行');
    const orphanRun = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE run_id = 1').get().cnt;
    assert.strictEqual(orphanRun, 0, 'run_id=1 的 diff_rows 全部消失');

    // 实测 CASCADE 删 bill_import — 用 run_id=2 那批仍有 diff_rows 的 bill
    const remainingBill = db.prepare(`
      SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows ORDER BY bill_import_id ASC LIMIT 1
    `).get();
    assert.ok(remainingBill && remainingBill.bill_import_id, '应仍有 diff_rows 关联的 bill_import');
    const billId = remainingBill.bill_import_id;
    const billDiffsBefore = db.prepare(
      'SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE bill_import_id = ?'
    ).get(billId).cnt;
    assert.ok(billDiffsBefore > 0);
    db.prepare('DELETE FROM acquiring_bill_currency_bill_imports WHERE id = ?').run(billId);
    const billDiffsAfter = db.prepare(
      'SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE bill_import_id = ?'
    ).get(billId).cnt;
    assert.strictEqual(billDiffsAfter, 0, '删 bill_import 后对应 diff_rows 自动清');
  });

  test('case 10：二次跑 skipped + 数据不变 + 不产生新备份', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);

    const r1 = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(r1.status, 'migrated');
    const backupsBefore = fs.readdirSync(backupDir).sort();

    const diffsBefore = db.prepare('SELECT id, run_id, bill_import_id FROM acquiring_bill_currency_diff_rows ORDER BY id').all();

    const r2 = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(r2.status, 'skipped');
    assert.strictEqual(r2.statusReached, 'pending');

    const diffsAfter = db.prepare('SELECT id, run_id, bill_import_id FROM acquiring_bill_currency_diff_rows ORDER BY id').all();
    assert.deepStrictEqual(diffsAfter, diffsBefore, '二次跑数据零变化');

    const backupsAfter = fs.readdirSync(backupDir).sort();
    assert.deepStrictEqual(backupsAfter, backupsBefore, 'skipped 路径不调 createBackupFn → 备份目录无新增');
  });

  test('case 11：createBackupFn 缺失（兼容老调用方）→ migration 仍跑 + backupPath=null', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, null);
    assert.strictEqual(result.status, 'migrated');
    assert.strictEqual(result.backupPath, null);
    // schema 已含 CASCADE
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    assert.ok(fkList.every((f) => String(f.on_delete).toUpperCase() === 'CASCADE'));
  });

  test('case 12：statusReached 在各 status 下符合 8-status state machine', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);

    // 12a：正常路径 statusReached='committed'
    const r1 = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(r1.statusReached, 'committed', '成功路径 statusReached=committed');

    // 12b：skipped 路径 statusReached='pending'（未进 backup-done）
    const r2 = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());
    assert.strictEqual(r2.statusReached, 'pending', 'skipped 路径 statusReached=pending');

    // 12c：backup-failed 路径 statusReached='pending'（备份失败前）— 新建一个干净库
    const dbPath2 = path.join(tmpDir, 'tool-data-2.sqlite');
    const db2 = new DatabaseSync(dbPath2);
    db2.exec('PRAGMA foreign_keys = ON;');
    bootstrapV219DiffRowsSchema(db2);
    const r3 = ensureDiffRowsCascadeMigration_v2_1_10(db2, dbPath2, () => { throw new Error('fail'); });
    assert.strictEqual(r3.status, 'backup-failed');
    assert.strictEqual(r3.statusReached, 'pending', 'backup-failed 路径 statusReached=pending');
    db2.close();
  });

  // v2.1.10 SR-FIX-1 round 2 P1-3：spec §5.3.2 8-status state machine 第 3 步 'checked'
  //   pre-migration FK check（PRAGMA foreign_key_check）跑在 Step 4 backup-done 之后 / Step 5 rebuild 之前
  //   如老库已有 FK violation（极少 — SQLite WAL replay 边界 / 用户 sqlite3 直改）→ 拒绝 migration 保护数据
  test('case 13：pre-migration FK violation → status=pre-fk-violation + 备份保留 + schema 未动（SR-FIX-1 round 2 P1-3）', () => {
    bootstrapV219DiffRowsSchema(db);
    seedRunAndBills(db);

    // 人为插一行 diff_row 引用不存在的 run_id（违反 FK 约束）
    // 关键：PRAGMA foreign_keys = OFF 才能绕过约束插 orphan row
    db.exec('PRAGMA foreign_keys = OFF;');
    db.prepare(`
      INSERT INTO acquiring_bill_currency_diff_rows
        (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
      VALUES (?, ?, 'CNY', '999.99', 'orphan-fk-violation')
    `).run(99999, 99999); // 99999 不存在于 runs / bill_imports 表
    db.exec('PRAGMA foreign_keys = ON;');

    // sanity：foreign_key_check 应能 detect
    const preCheck = db.prepare(`PRAGMA foreign_key_check('acquiring_bill_currency_diff_rows')`).all();
    assert.strictEqual(preCheck.length >= 1, true, 'pre-check 应 detect ≥1 violation（sanity）');

    const result = ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, makeBackupFn());

    // 验证 status / statusReached
    assert.strictEqual(result.status, 'pre-fk-violation', 'status=pre-fk-violation');
    assert.strictEqual(result.statusReached, 'backup-done', 'statusReached=backup-done（未进 checked）');
    assert.ok(result.error && result.error.includes('FK check'), 'error 含 FK check 字样');

    // 验证：备份已保留
    assert.ok(result.backupPath, '备份路径已记');
    assert.ok(fs.existsSync(result.backupPath), '备份文件存在');

    // 验证：schema 未动（仍是老 schema 无 ON DELETE CASCADE）
    const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
    const cascadeCount = fkList.filter(fk => fk.on_delete === 'CASCADE').length;
    assert.strictEqual(cascadeCount, 0, 'schema 未改造（仍无 CASCADE）');

    // 验证：标志位未写（下次启动会 retry）
    const flagRow = db.prepare(`SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'`).get();
    assert.strictEqual(flagRow, undefined, 'migration 标志位未写');
  });
});
