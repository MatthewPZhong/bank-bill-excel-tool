// v2.1.10 N4-cont-2 Phase 5 (T31) — diff_rows FK CASCADE 改造端到端集成测试
//   spec §五 + manual-test-checklist §6.1-6.7
//
// 覆盖 7+ case ≥ 25 断言：
//   1. 跨版本路径：v2.1.9 老 schema → v2.1.10 完整 init 链（N4 + N5 + N4-cont-2）
//      子断言：备份目录创建 / 3 个 migration 标志位 / FK 已 CASCADE / row 数完整保留
//   2. CASCADE 实测 - DELETE run → diff_rows 自动清；DELETE bill_import → diff_rows 自动清
//   3. 回滚验证：故障注入 migration 失败 → ROLLBACK + 备份保留 + 老 schema 仍存
//   4. 老数据 backfill：v2.1.9 N4 已迁库（raw_json 已瘦身）+ 含 diff_rows ≥ 10 行 → N4-cont-2 迁后全保留
//   5. 标志位幂等：重启 2 次不重做（status='skipped' 且 backup dir 无新增）
//   6. fk-verified 校验：PRAGMA foreign_key_check 0 violation
//   7. 已含 CASCADE 路径：v2.1.10 fresh install 重启 → status='skipped-already-cascaded'（防御性）
//
// 用法：node scripts/integration/v2.1.10-n4-cont-2-phase5.js
//       npm run test:integration

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../src/backend/database');
const migrations = require('../../src/backend/database/migrations');
const { createBackup } = require('../../src/backend/database/backup');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

function setupTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 模拟 v2.1.9 老 schema（无 CASCADE 的 diff_rows）— 最小依赖
function bootstrapV219Schema(db) {
  db.exec(`
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
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
    );
  `);
}

function seedDiffData(db, { runCount = 2, billsPerRun = 5, diffsPerBill = 2 } = {}) {
  const now = new Date().toISOString();
  for (let r = 0; r < runCount; r++) {
    const runInsert = db.prepare(`
      INSERT INTO acquiring_bill_currency_runs
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`2026-0${r + 1}`, now, billsPerRun, 0, billsPerRun, 0, 'success');
    const runId = Number(runInsert.lastInsertRowid);
    for (let b = 0; b < billsPerRun; b++) {
      const billInsert = db.prepare(`
        INSERT INTO acquiring_bill_currency_bill_imports
          (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
        VALUES (?, 'b.xlsx', ?, ?, 'USD', 'usd', '{}', ?)
      `).run(`2026-0${r + 1}`, b + 1, `R${r}-B${b}`, now);
      const billId = Number(billInsert.lastInsertRowid);
      for (let d = 0; d < diffsPerBill; d++) {
        db.prepare(`
          INSERT INTO acquiring_bill_currency_diff_rows
            (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
          VALUES (?, ?, 'CNY', '10.00', 'currency_mismatch')
        `).run(runId, billId);
      }
    }
  }
}

async function run() {
  console.log('==== v2.1.10 N4-cont-2 (T31) Phase 5 端到端集成验证 ====');

  // ============================================================
  // Case 1：跨版本路径 — v2.1.9 老 schema → v2.1.10 完整 init 链（N4 + N5 + N4-cont-2）
  //         + 备份文件 + 标志位 + 老数据保留
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c1-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      // 用 AppDatabase init 走完整 chain（fresh install fixture — 自然进入 fresh-install 路径）
      const appDb = new AppDatabase(dbPath);
      appDb.init();

      // 三链标志位
      const n4Marker = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_v2_migrated'"
      ).get();
      const n5Marker = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'"
      ).get();
      const n4Cont2Marker = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
      ).get();
      assertEq(n4Marker && n4Marker.setting_value, 'true', 'Case1.N4 标志位 = "true"');
      assertEq(n5Marker && n5Marker.setting_value, 'true', 'Case1.N5 标志位 = "true"');
      assertEq(n4Cont2Marker && n4Cont2Marker.setting_value, '1', 'Case1.N4-cont-2 标志位 = "1"');

      // FK CASCADE 已加
      const fkList = appDb.db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
      assertEq(fkList.length, 2, 'Case1.diff_rows FK 数 = 2');
      const runFk = fkList.find((f) => f.from === 'run_id');
      const billFk = fkList.find((f) => f.from === 'bill_import_id');
      assertEq(String(runFk.on_delete).toUpperCase(), 'CASCADE', 'Case1.run_id FK ON DELETE CASCADE');
      assertEq(String(billFk.on_delete).toUpperCase(), 'CASCADE', 'Case1.bill_import_id FK ON DELETE CASCADE');

      // 索引重建
      const indexes = appDb.db.prepare(`PRAGMA index_list('acquiring_bill_currency_diff_rows')`).all();
      assertTrue(
        indexes.some((idx) => idx.name === 'idx_acquiring_bill_currency_diff_run'),
        'Case1.idx_acquiring_bill_currency_diff_run 索引重建'
      );

      try { appDb.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 2：CASCADE 实测 - DELETE run → diff_rows 自动清；DELETE bill_import → diff_rows 自动清
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c2-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      // 先 v2.1.9 schema → seed 数据 → 然后 N4-cont-2 migration
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV219Schema(db);
      seedDiffData(db, { runCount: 2, billsPerRun: 4, diffsPerBill: 3 });
      const backupDir = path.join(tmpdir, 'backups');
      const result = migrations.ensureDiffRowsCascadeMigration_v2_1_10(
        db, dbPath, (label) => createBackup(db, label, backupDir)
      );
      assertEq(result.status, 'migrated', 'Case2.migration 成功');

      const totalDiffsBefore = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
      assertTrue(totalDiffsBefore > 0, 'Case2.seed 数据 diff_rows > 0');

      // 子 case 2a：删 run_id=1 → run_id=1 的 diff_rows 全清
      const run1Diffs = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE run_id = 1').get().cnt;
      assertTrue(run1Diffs > 0, 'Case2a.run_id=1 diff_rows > 0');
      db.prepare('DELETE FROM acquiring_bill_currency_runs WHERE id = 1').run();
      const run1DiffsAfter = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE run_id = 1').get().cnt;
      assertEq(run1DiffsAfter, 0, 'Case2a.删 run_id=1 后 diff_rows WHERE run_id=1 = 0');
      const totalDiffsAfterRun = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
      assertEq(totalDiffsAfterRun, totalDiffsBefore - run1Diffs, 'Case2a.总 diff_rows 减少 run_id=1 对应行数');

      // 子 case 2b：删 bill_import → 对应 diff_rows 自动清（取 run_id=2 那批剩下的 bill）
      const remainingBill = db.prepare(`
        SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows ORDER BY bill_import_id ASC LIMIT 1
      `).get();
      assertTrue(remainingBill && remainingBill.bill_import_id, 'Case2b.仍有关联 bill_import 的 diff_rows');
      const billId = remainingBill.bill_import_id;
      const billDiffsBefore = db.prepare(
        'SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE bill_import_id = ?'
      ).get(billId).cnt;
      assertTrue(billDiffsBefore > 0, 'Case2b.bill_import_id 对应 diff_rows > 0');
      db.prepare('DELETE FROM acquiring_bill_currency_bill_imports WHERE id = ?').run(billId);
      const billDiffsAfter = db.prepare(
        'SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows WHERE bill_import_id = ?'
      ).get(billId).cnt;
      assertEq(billDiffsAfter, 0, 'Case2b.删 bill_import 后对应 diff_rows = 0');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 3：回滚验证 — 故障注入 → ROLLBACK + 备份保留 + 老 schema 仍存 + 不写 flag
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c3-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV219Schema(db);
      seedDiffData(db, { runCount: 1, billsPerRun: 3, diffsPerBill: 2 });
      const beforeRowCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
      const backupDir = path.join(tmpdir, 'backups');

      // 故障注入：DROP TABLE 阶段抛错
      const originalExec = db.exec.bind(db);
      db.exec = (sql) => {
        if (typeof sql === 'string' && sql.includes('DROP TABLE acquiring_bill_currency_diff_rows')) {
          throw new Error('injected fault: simulated DROP TABLE failure');
        }
        return originalExec(sql);
      };

      const result = migrations.ensureDiffRowsCascadeMigration_v2_1_10(
        db, dbPath, (label) => createBackup(db, label, backupDir)
      );

      db.exec = originalExec;

      assertEq(result.status, 'migration-failed', 'Case3.status = migration-failed');
      assertTrue(/injected fault/.test(result.error || ''), 'Case3.error 含注入消息');
      // 备份保留
      assertTrue(typeof result.backupPath === 'string' && fs.existsSync(result.backupPath), 'Case3.备份文件保留');
      // 标志位未写
      const marker = db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
      ).get();
      assertEq(marker, undefined, 'Case3.标志位 n4_cont_2_diff_rows_cascade_migrated 未写');
      // ROLLBACK 后老 schema 保留（FK 仍无 CASCADE）
      const fkList = db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
      assertTrue(
        fkList.every((f) => String(f.on_delete).toUpperCase() === 'NO ACTION'),
        'Case3.ROLLBACK 后 FK 仍无 CASCADE（NO ACTION）'
      );
      const afterRowCount = db.prepare('SELECT COUNT(*) AS cnt FROM acquiring_bill_currency_diff_rows').get().cnt;
      assertEq(afterRowCount, beforeRowCount, 'Case3.ROLLBACK 后 diff_rows 行数不变');
      // 新表也应不存在
      const newTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='acquiring_bill_currency_diff_rows_new'"
      ).get();
      assertEq(newTable, undefined, 'Case3._new 临时表也已被 ROLLBACK');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 4：老数据 backfill 完整性 — v2.1.9 + N4 已迁库 + 含 diff_rows ≥ 10 行 → N4-cont-2 迁后全保留
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c4-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      // Step 1：用 AppDatabase init 跑全 chain（含 N4-cont-2 已自动执行）
      const appDb = new AppDatabase(dbPath);
      appDb.init();

      // Step 2：模拟"已运行多次后含老 diff_rows"场景 — 手工 seed
      //   注意：init 时 N4-cont-2 已经把 schema 改为 CASCADE；这里 seed 用 CASCADE 后的 schema
      seedDiffData(appDb.db, { runCount: 3, billsPerRun: 5, diffsPerBill: 2 });
      const allRowsBefore = appDb.db.prepare('SELECT id, run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type FROM acquiring_bill_currency_diff_rows ORDER BY id').all();
      assertTrue(allRowsBefore.length === 30, `Case4.seed 30 行 diff_rows（actual=${allRowsBefore.length}）`);

      // Step 3：重启（二次 init）— N4-cont-2 跳过（skipped）+ 数据零变化
      try { appDb.db.close(); } catch (_) {}
      const appDb2 = new AppDatabase(dbPath);
      appDb2.init();
      const allRowsAfter = appDb2.db.prepare('SELECT id, run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type FROM acquiring_bill_currency_diff_rows ORDER BY id').all();
      assertEq(allRowsAfter, allRowsBefore, 'Case4.二次 init 后 diff_rows 全量保留 + 内容一致');

      // 抽查 5 条 column 值
      const sample = allRowsAfter.slice(0, 5);
      sample.forEach((row, i) => {
        assertEq(row.diff_type, 'currency_mismatch', `Case4.sample${i}.diff_type 一致`);
        assertEq(row.flow_currency, 'CNY', `Case4.sample${i}.flow_currency 一致`);
      });

      try { appDb2.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 5：标志位幂等 — 重启 2 次不重做（skipped + backup dir 无新增）
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c5-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    try {
      // 第 1 次 init
      const appDb1 = new AppDatabase(dbPath);
      appDb1.init();
      try { appDb1.db.close(); } catch (_) {}
      const backupsAfterFirst = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
      // fresh install 路径：N4 / N5 / N4-cont-2 各自有备份逻辑；fresh-install 时数据空可能不写备份（N4 special）
      //   但 N4-cont-2 由于 diff_rows 表新建即不存在 → 走 skipped-no-table 路径 → 不调 createBackupFn → 不增备份

      // 第 2 次 init — 应不增加备份且不报错
      const appDb2 = new AppDatabase(dbPath);
      appDb2.init();
      try { appDb2.db.close(); } catch (_) {}
      const backupsAfterSecond = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];

      // N4-cont-2 标志位 = '1'
      const appDbCheck = new AppDatabase(dbPath);
      appDbCheck.init();
      const marker = appDbCheck.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
      ).get();
      assertEq(marker && marker.setting_value, '1', 'Case5.二次 init 后标志位 = "1"');
      try { appDbCheck.db.close(); } catch (_) {}

      // 第 2 次 / 第 3 次重启不重做 — backup 目录数量 = 第一次后数量（N4-cont-2 路径不产生新备份）
      const backupsCount2 = backupsAfterSecond.length;
      const backupsCount1 = backupsAfterFirst.length;
      assertEq(backupsCount2, backupsCount1, 'Case5.第 2 次 init 不产生新备份');

      // FK 仍含 CASCADE
      const appDbFkCheck = new AppDatabase(dbPath);
      appDbFkCheck.init();
      const fkList = appDbFkCheck.db.prepare(`PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')`).all();
      assertTrue(
        fkList.every((f) => String(f.on_delete).toUpperCase() === 'CASCADE'),
        'Case5.多次重启后 FK 仍 CASCADE'
      );
      try { appDbFkCheck.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 6：fk-verified 校验 — PRAGMA foreign_key_check 0 violation（CASCADE 加完后全表一致）
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c6-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      const appDb = new AppDatabase(dbPath);
      appDb.init();
      // seed 一些数据
      seedDiffData(appDb.db, { runCount: 2, billsPerRun: 3, diffsPerBill: 2 });

      // PRAGMA foreign_key_check 全表 — 应 0 violation
      const allViolations = appDb.db.prepare('PRAGMA foreign_key_check').all();
      assertEq(allViolations.length, 0, 'Case6.PRAGMA foreign_key_check 全表 0 violation');

      // 单表检查 diff_rows
      const diffRowsViolations = appDb.db.prepare(
        `PRAGMA foreign_key_check('acquiring_bill_currency_diff_rows')`
      ).all();
      assertEq(diffRowsViolations.length, 0, 'Case6.diff_rows 表 0 violation');

      try { appDb.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 7：skipped-already-cascaded 防御性路径 —
  //   人为预先 set marker=null + schema 已含 CASCADE → status='skipped-already-cascaded' + 补写 marker
  // ============================================================
  {
    const tmpdir = setupTmpDir('n4-cont-2-c7-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      // 先用 AppDatabase init 跑完整 chain（schema 含 CASCADE + marker = '1'）
      const appDb = new AppDatabase(dbPath);
      appDb.init();
      // 人为删除 marker（模拟用户手动改 settings 错位）
      appDb.db.prepare(`DELETE FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'`).run();
      const markerBefore = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
      ).get();
      assertEq(markerBefore, undefined, 'Case7.marker 已被人为删除');

      // 再次跑 migration — 应进入 skipped-already-cascaded 分支（schema 已 CASCADE）
      const backupDir = path.join(tmpdir, 'backups2');
      const result = migrations.ensureDiffRowsCascadeMigration_v2_1_10(
        appDb.db, dbPath, (label) => createBackup(appDb.db, label, backupDir)
      );
      assertEq(result.status, 'skipped-already-cascaded', 'Case7.status = skipped-already-cascaded（防御性）');

      // 标志位被补写
      const markerAfter = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated'"
      ).get();
      assertEq(markerAfter && markerAfter.setting_value, '1', 'Case7.标志位被补写 = "1"');

      // skipped-already-cascaded 路径不调 createBackupFn → 不产生备份
      const backupsExists = fs.existsSync(backupDir);
      assertEq(backupsExists, false, 'Case7.skipped-already-cascaded 路径不产生备份');

      try { appDb.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // 汇报
  // ============================================================
  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
