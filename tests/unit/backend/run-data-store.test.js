// v3.0.5 PR-3（Part B Phase 1）— run-data-store per-月侧库管理器单测
//   覆盖：建/开/删/目录自动建/DDL 含 FK CASCADE/路径解析/孤儿扫描列表/幂等

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const rds = require('../../../src/backend/run-data-store');

// v3.2.20 收单下线后，通用侧库机制以前置资金对账网关侧库（批次 → 行 CASCADE）为样本。
const MODULE = rds.MODULE_PRE_FUND_RECONCILIATION;
const BATCH_SQL = `INSERT INTO pre_fund_reconciliation_gateway_batches
  (source_type, source_batch, source_date, source_file_name, source_file_sequence, content_hash, declared_row_count, row_count)
  VALUES ('inbound', 'B-1', '2026-03-01', 'a.txt', '1', 'hash-a', 1, 1)`;
const ROW_SQL = `INSERT INTO pre_fund_reconciliation_gateway_rows
  (batch_id, source_type, source_batch, source_date, source_file_name, source_file_sequence, source_row_number,
   gateway_date, currency, amount, raw_json, fingerprint)
  VALUES (?, 'inbound', 'B-1', '2026-03-01', 'a.txt', '1', 2, '2026-03-01', 'USD', '10', '{}', 'fp-1')`;

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
  test('openSideDb 目录不存在自动建 + 文件创建 + DDL 网关三表', () => {
    const dir = rds.moduleDir(tmpdir, MODULE);
    assert.equal(fs.existsSync(dir), false, '前置：目录尚不存在');
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      assert.equal(fs.existsSync(dir), true, '目录自动建');
      assert.equal(rds.sideDbExists(tmpdir, MODULE, '2026-03'), true, '侧库文件创建');
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pre_fund_reconciliation_gateway_%' ORDER BY name"
      ).all().map((r) => r.name);
      assert.deepEqual(tables, [
        'pre_fund_reconciliation_gateway_batches',
        'pre_fund_reconciliation_gateway_excluded_rows',
        'pre_fund_reconciliation_gateway_rows',
      ]);
    } finally {
      db.close();
    }
  });

  test('DDL gateway_rows FK ON DELETE CASCADE 指向批次', () => {
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      const fks = db.prepare("PRAGMA foreign_key_list('pre_fund_reconciliation_gateway_rows')").all();
      assert.equal(fks.length, 1, 'gateway_rows 有 1 个 FK');
      assert.equal(fks[0].table, 'pre_fund_reconciliation_gateway_batches');
      assert.equal(fks[0].on_delete, 'CASCADE', 'batch_id FK CASCADE');
    } finally {
      db.close();
    }
  });

  test('FK CASCADE 实际级联：删批次行 → gateway_rows 自动清', () => {
    const db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      db.prepare(BATCH_SQL).run();
      const batchId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      db.prepare(ROW_SQL).run(batchId);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pre_fund_reconciliation_gateway_rows').get().c, 1);
      db.prepare('DELETE FROM pre_fund_reconciliation_gateway_batches WHERE id = ?').run(batchId);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pre_fund_reconciliation_gateway_rows').get().c, 0, '删批次 → 行 CASCADE 清');
    } finally {
      db.close();
    }
  });

  test('openSideDb 幂等：二次打开同库 DDL no-op + 数据保留', () => {
    let db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    db.prepare(BATCH_SQL).run();
    db.close();
    db = rds.openSideDb(tmpdir, MODULE, '2026-03');
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pre_fund_reconciliation_gateway_batches').get().c, 1, '二次打开数据保留');
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
    assert.deepEqual(rds.listSideDbFiles(tmpdir, MODULE, { strictErrors: true }), []);
  });

  test('严格恢复清单读取不把目录错误当作空清单，普通扫描保持原语义', (t) => {
    const readdirSync = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...args) => {
      if (directory === rds.moduleDir(tmpdir, MODULE)) {
        throw Object.assign(new Error('暂时不可读'), { code: 'EACCES' });
      }
      return readdirSync(directory, ...args);
    });
    assert.deepEqual(rds.listSideDbFiles(tmpdir, MODULE), []);
    assert.throws(() => rds.listSideDbFiles(tmpdir, MODULE, { strictErrors: true }), { code: 'EACCES' });
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
    assert.deepEqual(rds.listSideDbFiles(tmpdir, MODULE, { strictErrors: true }), files);
  });
});

// v3.2.20：月度银行对账单BU回填校验 / 业务OP数据核对 / 收单单据币种校验下线，三模块侧库不再登记（用户磁盘上的历史侧库原样保留）。
test.describe('已登记模块与侧库升级', () => {
  test('KNOWN_MODULES 只含前置对账双生命周期模块和重复入金结果模块', () => {
    assert.deepEqual([...rds.KNOWN_MODULES].sort(), [
      'duplicate-inbound-match',
      'pre-fund-reconciliation',
      'pre-fund-reconciliation-results'
    ]);
    assert.equal(rds.MODULE_PRE_FUND_RECONCILIATION_RESULTS, 'pre-fund-reconciliation-results');
    assert.equal(rds.MODULE_DUPLICATE_INBOUND_MATCH, 'duplicate-inbound-match');
    for (const retired of ['acquiring-bill-currency', 'biz-op-recon', 'bank-bu-recon']) {
      assert.throws(() => rds.sideDbPath(tmpdir, retired, '2026-03'), /未知 module/, retired);
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
});
