// v3.0.5 PR-3（Part B Phase 1）— run-data-store per-月侧库管理器单测
//   覆盖：建/开/删/目录自动建/DDL 含 FK CASCADE/路径解析/孤儿扫描列表/幂等

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const rds = require('../../../src/backend/run-data-store');

const MODULE = rds.MODULE_ACQUIRING;

let tmpdir;
test.beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-test-'));
});
test.afterEach(() => {
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
});

test.describe('路径解析', () => {
  test('sideDbPath / sideDbRelPath / sideDbFileName 形态', () => {
    assert.equal(rds.sideDbFileName('2026-03'), 'month-2026-03.sqlite');
    assert.equal(rds.sideDbRelPath(MODULE, '2026-03'), path.join('run-data', MODULE, 'month-2026-03.sqlite'));
    assert.equal(
      rds.sideDbPath(tmpdir, MODULE, '2026-03'),
      path.join(tmpdir, 'run-data', MODULE, 'month-2026-03.sqlite')
    );
  });

  test('resolveFromRel 还原绝对路径', () => {
    const rel = rds.sideDbRelPath(MODULE, '2026-03');
    assert.equal(rds.resolveFromRel(tmpdir, rel), rds.sideDbPath(tmpdir, MODULE, '2026-03'));
  });

  test('monthKeyFromFileName 解析与非法名拒绝', () => {
    assert.equal(rds.monthKeyFromFileName('month-2026-03.sqlite'), '2026-03');
    assert.equal(rds.monthKeyFromFileName('month-2026-03.sqlite-wal'), null);
    assert.equal(rds.monthKeyFromFileName('tool-data.sqlite'), null);
    assert.equal(rds.monthKeyFromFileName('month-bad.sqlite'), null);
  });

  test('非法 module / monthKey 抛错', () => {
    assert.throws(() => rds.sideDbPath(tmpdir, 'unknown-module', '2026-03'), /未知 module/);
    assert.throws(() => rds.sideDbFileName('2026/03'), /YYYY-MM/);
    assert.throws(() => rds.sideDbFileName('bad'), /YYYY-MM/);
  });
});

test.describe('建/开/删 + 目录自动建', () => {
  test('openSideDb 目录不存在自动建 + 文件创建 + DDL 四表', () => {
    const dir = rds.moduleDir(tmpdir, MODULE);
    assert.equal(fs.existsSync(dir), false, '前置：目录尚不存在');
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      assert.equal(fs.existsSync(dir), true, '目录自动建');
      assert.equal(rds.sideDbExists(tmpdir, MODULE, '2026-03'), true, '侧库文件创建');
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'acquiring_bill_currency_%' ORDER BY name"
      ).all().map((r) => r.name);
      assert.deepEqual(tables, [
        'acquiring_bill_currency_bill_imports',
        'acquiring_bill_currency_diff_rows',
        'acquiring_bill_currency_flow_imports',
        'acquiring_bill_currency_runs',
      ]);
    } finally {
      db.close();
    }
  });

  test('DDL diff_rows 含 2 个 FK ON DELETE CASCADE', () => {
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      const fks = db.prepare("PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')").all();
      assert.equal(fks.length, 2, 'diff_rows 有 2 个 FK');
      const byTable = {};
      for (const fk of fks) byTable[fk.table] = fk;
      assert.equal(byTable['acquiring_bill_currency_bill_imports'].on_delete, 'CASCADE', 'bill_import_id FK CASCADE');
      assert.equal(byTable['acquiring_bill_currency_runs'].on_delete, 'CASCADE', 'run_id FK CASCADE');
    } finally {
      db.close();
    }
  });

  test('FK CASCADE 实际级联：删 runs 行 → diff_rows 自动清', () => {
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      db.prepare(`INSERT INTO acquiring_bill_currency_runs (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES ('2026-03',1,1,1,0,'success')`).run();
      const runId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      db.prepare(`INSERT INTO acquiring_bill_currency_bill_imports (month_key, source_file, source_row_index, recon_main_id, raw_json) VALUES ('2026-03','f.xlsx',2,'X','{}')`).run();
      const billId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      db.prepare(`INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?,?,'usd','10','currency_mismatch')`).run(runId, billId);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c, 1);
      db.prepare('DELETE FROM acquiring_bill_currency_runs WHERE id = ?').run(runId);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c, 0, '删 run → diff CASCADE 清');
    } finally {
      db.close();
    }
  });

  test('openSideDb 幂等：二次打开同库 DDL no-op + 数据保留', () => {
    let db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    db.prepare(`INSERT INTO acquiring_bill_currency_flow_imports (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, raw_json) VALUES ('2026-03','f.xlsx',2,'X','10','10','')`).run();
    db.close();
    db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c, 1, '二次打开数据保留');
    } finally {
      db.close();
    }
  });

  test('deleteSideDb 删文件（含 wal/shm 旁文件）+ 幂等', () => {
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    db.close();
    const filePath = rds.sideDbPath(tmpdir, MODULE, '2026-03');
    // 模拟 WAL/SHM 旁文件存在
    fs.writeFileSync(filePath + '-wal', 'x');
    fs.writeFileSync(filePath + '-shm', 'x');
    const r1 = rds.deleteSideDb(tmpdir, MODULE, '2026-03');
    assert.equal(r1.deleted, true);
    assert.equal(fs.existsSync(filePath), false, '主文件删除');
    assert.equal(fs.existsSync(filePath + '-wal'), false, 'wal 旁文件删除');
    assert.equal(fs.existsSync(filePath + '-shm'), false, 'shm 旁文件删除');
    // 幂等：再删不报错，deleted=false
    const r2 = rds.deleteSideDb(tmpdir, MODULE, '2026-03');
    assert.equal(r2.deleted, false, '再删幂等 deleted=false');
  });

  test('openExistingSideDb 文件不存在抛错', () => {
    const filePath = rds.sideDbPath(tmpdir, MODULE, '2026-03');
    assert.throws(() => rds.openExistingSideDb(filePath), /不存在/);
  });
});

test.describe('孤儿扫描列表', () => {
  test('listSideDbFiles 目录不存在返回空', () => {
    assert.deepEqual(rds.listSideDbFiles(tmpdir, MODULE), []);
  });

  test('listSideDbFiles 列出侧库文件、跳过非法名 + wal/shm', () => {
    rds.openSideDb(tmpdir, MODULE, '2026-03').close();
    rds.openSideDb(tmpdir, MODULE, '2026-04').close();
    const dir = rds.moduleDir(tmpdir, MODULE);
    fs.writeFileSync(path.join(dir, 'month-2026-03.sqlite-wal'), 'x'); // 旁文件
    fs.writeFileSync(path.join(dir, 'README.txt'), 'x');               // 非法名
    const files = rds.listSideDbFiles(tmpdir, MODULE);
    const months = files.map((f) => f.monthKey).sort();
    assert.deepEqual(months, ['2026-03', '2026-04'], '仅列出合法侧库文件');
  });
});

// v3.0.5 PR-4（Part B Phase 2）：biz-op / bank-bu 两模块侧库 DDL + KNOWN_MODULES 扩展。
test.describe('PR-4 biz-op / bank-bu 模块侧库', () => {
  test('KNOWN_MODULES 含既有模块、前置对账双生命周期模块和重复入金结果模块', () => {
    assert.deepEqual([...rds.KNOWN_MODULES].sort(), [
      'acquiring-bill-currency',
      'bank-bu-recon',
      'biz-op-recon',
      'duplicate-inbound-match',
      'pre-fund-reconciliation',
      'pre-fund-reconciliation-results'
    ]);
    assert.equal(rds.MODULE_BIZ_OP, 'biz-op-recon');
    assert.equal(rds.MODULE_BANK_BU, 'bank-bu-recon');
    assert.equal(rds.MODULE_PRE_FUND_RECONCILIATION_RESULTS, 'pre-fund-reconciliation-results');
    assert.equal(rds.MODULE_DUPLICATE_INBOUND_MATCH, 'duplicate-inbound-match');
  });

  test('biz-op 侧库 DDL 建业务表与 dataset heads', () => {
    const db = rds.openSideDb(tmpdir, rds.MODULE_BIZ_OP, '2026-03');
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'biz_op_recon_%' ORDER BY name"
      ).all().map((r) => r.name);
      assert.deepEqual(tables, [
        'biz_op_recon_dataset_heads',
        'biz_op_recon_diff_rows',
        'biz_op_recon_flow_imports',
        'biz_op_recon_imports',
        'biz_op_recon_month_end_copy_intents',
        'biz_op_recon_runs',
      ]);
      // runs 含 t2_anomaly_account_count（新库建表即含）。
      const cols = db.prepare("PRAGMA table_info(biz_op_recon_runs)").all().map((c) => c.name);
      assert.ok(cols.includes('t2_anomaly_account_count'), 'runs 含 t2_anomaly_account_count');
      assert.ok(cols.includes('archive_task_run_id'), 'runs 含 Archive receipt');
      // diff_rows FK 引用 runs（无 CASCADE，与主库一致）。
      const fks = db.prepare("PRAGMA foreign_key_list('biz_op_recon_diff_rows')").all();
      assert.equal(fks.length, 1, 'diff_rows 1 个 FK（runs）');
      assert.equal(fks[0].table, 'biz_op_recon_runs');
      assert.equal(fks[0].on_delete, 'NO ACTION', 'biz-op diff_rows FK 无 CASCADE（与主库 byte-for-byte）');
      const intentColumns = db.prepare(
        "PRAGMA table_info(biz_op_recon_month_end_copy_intents)"
      ).all().map((column) => column.name);
      assert.deepEqual(intentColumns, [
        'source_task_run_id',
        'data_date',
        'normalized_bu',
        'dataset_id',
        'dataset_version',
        'producer_task_run_id',
        'target_month',
        'created_at'
      ]);
    } finally {
      db.close();
    }
  });

  test('旧 Biz OP side DB 先 additive migrate receipt 列，再创建新索引', () => {
    const filePath = rds.sideDbPath(tmpdir, rds.MODULE_BIZ_OP, '2026-04');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const legacyDb = new DatabaseSync(filePath);
    legacyDb.exec(`
      CREATE TABLE biz_op_recon_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_date TEXT NOT NULL,
        bu_name TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'success',
        t1_op_total INTEGER NOT NULL DEFAULT 0,
        t2_op_total INTEGER NOT NULL DEFAULT 0,
        flow_total INTEGER NOT NULL DEFAULT 0,
        amount_diff_count INTEGER NOT NULL DEFAULT 0,
        multi_op_account_count INTEGER NOT NULL DEFAULT 0,
        t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0,
        t1_not_t2_count INTEGER NOT NULL DEFAULT 0,
        t2_not_t1_count INTEGER NOT NULL DEFAULT 0,
        export_path TEXT
      );
      INSERT INTO biz_op_recon_runs (data_date, bu_name) VALUES ('2026-04-01', 'BU-A');
    `);
    legacyDb.close();

    const upgraded = rds.openSideDb(tmpdir, rds.MODULE_BIZ_OP, '2026-04');
    try {
      const columns = upgraded.prepare('PRAGMA table_info(biz_op_recon_runs)').all()
        .map((column) => column.name);
      assert.ok(columns.includes('archive_contract_version'));
      assert.ok(columns.includes('archive_task_run_id'));
      assert.ok(columns.includes('archive_terminal_ack_at'));
      assert.ok(upgraded.prepare(`SELECT 1 FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_biz_op_runs_archive_task'`).get());
      const historical = upgraded.prepare('SELECT * FROM biz_op_recon_runs WHERE id = 1').get();
      assert.equal(historical.archive_contract_version, 0);
      assert.equal(historical.archive_task_run_id, null);
      assert.equal(upgraded.prepare(
        'SELECT COUNT(*) AS count FROM biz_op_recon_month_end_copy_intents'
      ).get().count, 0, '历史库 additive migration 不伪造 copy intent');
    } finally {
      upgraded.close();
    }
  });

  test('bank-bu 侧库 DDL 建 3 表（pending_imports/bank_imports/runs，无 diff_rows）', () => {
    const db = rds.openSideDb(tmpdir, rds.MODULE_BANK_BU, '2026-03');
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bank_bu_recon_%' ORDER BY name"
      ).all().map((r) => r.name);
      assert.deepEqual(tables, [
        'bank_bu_recon_bank_imports',
        'bank_bu_recon_pending_imports',
        'bank_bu_recon_runs',
      ]);
      // bank_imports 列数（44 数据 + id/year_month/row_index/imported_at = 48）。
      const bankCols = db.prepare("PRAGMA table_info(bank_bu_recon_bank_imports)").all().length;
      assert.equal(bankCols, 48, 'bank_imports 列数（44 数据 + id/year_month/row_index/imported_at = 48）');
    } finally {
      db.close();
    }
  });

  test('旧 Pre-fund MPT 侧库升级后逐批回填 canonical v0 dataset UUID', () => {
    const module = rds.MODULE_PRE_FUND_RECONCILIATION;
    const filePath = rds.sideDbPath(tmpdir, module, '2026-05');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const legacyDb = new DatabaseSync(filePath);
    legacyDb.exec(`
      CREATE TABLE pre_fund_reconciliation_gateway_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_batch TEXT NOT NULL,
        source_date TEXT NOT NULL,
        source_file_name TEXT NOT NULL,
        source_file_sequence TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        declared_row_count INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        excluded_row_count INTEGER NOT NULL DEFAULT 0,
        import_mode TEXT NOT NULL DEFAULT 'strict',
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (source_type, source_batch),
        UNIQUE (source_file_name)
      );
      INSERT INTO pre_fund_reconciliation_gateway_batches
        (source_type, source_batch, source_date, source_file_name,
         source_file_sequence, content_hash, declared_row_count, row_count)
      VALUES
        ('inbound', 'B-1', '2026-05-01', 'a.txt', '1', 'hash-a', 1, 1),
        ('outbound', 'B-2', '2026-05-01', 'b.txt', '2', 'hash-b', 1, 1);
    `);
    legacyDb.close();

    const upgraded = rds.openSideDb(tmpdir, module, '2026-05');
    try {
      const rows = upgraded.prepare(`
        SELECT dataset_id, producer_task_run_id, dataset_version, archive_contract_version
        FROM pre_fund_reconciliation_gateway_batches ORDER BY id
      `).all();
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.dataset_id)));
      assert.notEqual(rows[0].dataset_id, rows[1].dataset_id);
      assert.ok(rows.every((row) => row.producer_task_run_id === null
        && row.dataset_version === 0
        && row.archive_contract_version === 0));
    } finally {
      upgraded.close();
    }
  });

  test('旧 Pre-fund results 侧库先 additive migrate receipt 列，再创建唯一索引', () => {
    const module = rds.MODULE_PRE_FUND_RECONCILIATION_RESULTS;
    const filePath = rds.sideDbPath(tmpdir, module, '2026-06');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const legacyDb = new DatabaseSync(filePath);
    legacyDb.exec(`
      CREATE TABLE pre_fund_reconciliation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        bank_files_json TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );
      INSERT INTO pre_fund_reconciliation_runs
        (scenario, snapshot_json, bank_files_json, status)
      VALUES ('missing-gateway', '{}', '[]', 'success');
    `);
    legacyDb.close();

    const upgraded = rds.openSideDb(tmpdir, module, '2026-06');
    try {
      const columns = upgraded.prepare('PRAGMA table_info(pre_fund_reconciliation_runs)').all()
        .map((column) => column.name);
      assert.ok(columns.includes('archive_contract_version'));
      assert.ok(columns.includes('archive_task_run_id'));
      assert.ok(columns.includes('archive_terminal_ack_at'));
      assert.ok(upgraded.prepare(`SELECT 1 FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_pre_fund_runs_archive_task'`).get());
      const historical = upgraded.prepare('SELECT * FROM pre_fund_reconciliation_runs WHERE id = 1').get();
      assert.equal(historical.archive_contract_version, 0);
      assert.equal(historical.archive_task_run_id, null);
    } finally {
      upgraded.close();
    }
  });

  test('biz-op / bank-bu 侧库文件命名 + 路径', () => {
    assert.equal(
      rds.sideDbRelPath(rds.MODULE_BIZ_OP, '2026-03'),
      path.join('run-data', 'biz-op-recon', 'month-2026-03.sqlite')
    );
    assert.equal(
      rds.sideDbRelPath(rds.MODULE_BANK_BU, '2026-03'),
      path.join('run-data', 'bank-bu-recon', 'month-2026-03.sqlite')
    );
  });
});
