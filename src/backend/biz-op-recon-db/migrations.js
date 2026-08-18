// v2.1.3 T1 — 业务OP数据核对模块的 4 张表 migration
// PRD §三 / spec §四：
//   - biz_op_recon_imports：业务OP 主表（按日期 + BU 分片，23 列业务数据）
//   - biz_op_recon_flow_imports：流水对账单主表（按日期分片，28 列流水数据）
//   - biz_op_recon_runs：对账运行记录（按日期 + BU，含统计字段）
//   - biz_op_recon_diff_rows：差异行明细（FK biz_op_recon_runs.id）
// 幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op
// 与 v2.1.2 bank_bu_recon_* 完全独立（主 DB tool-data.sqlite 内表名前缀严格区分）
// 设计依据：spec §四（DDL 全部固化），#5 拍板 = 整批拒绝 + 失败报告 xlsx → 不需要 errors 表

const { randomUUID } = require('node:crypto');

// v2.1.3 round 1（spec §4.3）：runs 表新增 t2_anomaly_account_count
//   - 新装用户：CREATE TABLE 直接含该列
//   - 已有库：通过 hasColumn + ALTER TABLE 幂等加列
function hasColumn(db, tableName, columnName) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((c) => c.name === columnName);
}

function ensureBizOpReconTablesSupport(db) {
  db.exec('BEGIN');

  try {
    // 表 1：业务 OP 主表（spec §4.1，23 列业务数据）
    db.exec(`
      CREATE TABLE IF NOT EXISTS biz_op_recon_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_date TEXT NOT NULL,
        bu_name TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        bill_date_raw TEXT,
        customer_no TEXT,
        entity TEXT,
        account_no TEXT NOT NULL,
        account_type TEXT,
        currency TEXT,
        begin_balance TEXT,
        amount TEXT,
        amount_in TEXT,
        amount_out TEXT,
        end_balance TEXT,
        end_available_balance TEXT,
        end_frozen_balance TEXT,
        last_updated TEXT,
        channel TEXT,
        pp_card_id TEXT,
        bank_card_no TEXT,
        extra_info TEXT,
        account_status TEXT,
        biz_id TEXT,
        sys_created_at TEXT,
        sys_updated_at TEXT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_imports_date_bu
        ON biz_op_recon_imports(data_date, bu_name);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_imports_account
        ON biz_op_recon_imports(data_date, bu_name, account_no);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_imports_bu
        ON biz_op_recon_imports(bu_name);
    `);

    // 表 2：流水对账单主表（spec §4.2，28 列流水数据）
    db.exec(`
      CREATE TABLE IF NOT EXISTS biz_op_recon_flow_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_date TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        biz_id TEXT,
        bill_date_raw TEXT,
        origin_biz_id TEXT,
        main_account TEXT,
        company_entity TEXT,
        flow_type TEXT,
        bu_dept TEXT,
        recon_main_id TEXT,
        direction TEXT NOT NULL,
        flow_no TEXT,
        user_no TEXT,
        account_no TEXT NOT NULL,
        split_type TEXT,
        recon_amount TEXT NOT NULL,
        currency TEXT,
        account_type TEXT,
        flow_start_at TEXT,
        flow_end_at TEXT,
        channel TEXT,
        merchant_id TEXT,
        value_date TEXT,
        bank_ref TEXT,
        pending_flag TEXT,
        flow_biz_id TEXT,
        trace_id TEXT,
        operator TEXT,
        sys_created_at TEXT,
        sys_updated_at TEXT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_date
        ON biz_op_recon_flow_imports(data_date);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_date_bu
        ON biz_op_recon_flow_imports(data_date, bu_dept);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_account
        ON biz_op_recon_flow_imports(data_date, account_no);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS biz_op_recon_dataset_heads (
        dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('op', 'flow')),
        data_date TEXT NOT NULL,
        normalized_bu TEXT NOT NULL DEFAULT '',
        dataset_id TEXT NOT NULL,
        producer_task_run_id TEXT,
        dataset_version INTEGER NOT NULL CHECK (dataset_version >= 0),
        archive_contract_version INTEGER NOT NULL DEFAULT 0
          CHECK (archive_contract_version IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (dataset_kind, data_date, normalized_bu),
        UNIQUE (dataset_id)
      );
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_op_head_on_insert
      AFTER INSERT ON biz_op_recon_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'op' AND data_date = NEW.data_date
          AND normalized_bu = LOWER(TRIM(NEW.bu_name));
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_op_head_on_update
      AFTER UPDATE ON biz_op_recon_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'op'
          AND ((data_date = OLD.data_date AND normalized_bu = LOWER(TRIM(OLD.bu_name)))
            OR (data_date = NEW.data_date AND normalized_bu = LOWER(TRIM(NEW.bu_name))));
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_op_head_on_delete
      AFTER DELETE ON biz_op_recon_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'op' AND data_date = OLD.data_date
          AND normalized_bu = LOWER(TRIM(OLD.bu_name));
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_flow_head_on_insert
      AFTER INSERT ON biz_op_recon_flow_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'flow' AND data_date = NEW.data_date AND normalized_bu = '';
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_flow_head_on_update
      AFTER UPDATE ON biz_op_recon_flow_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'flow' AND normalized_bu = ''
          AND data_date IN (OLD.data_date, NEW.data_date);
      END;
      CREATE TRIGGER IF NOT EXISTS invalidate_biz_flow_head_on_delete
      AFTER DELETE ON biz_op_recon_flow_imports
      BEGIN
        DELETE FROM biz_op_recon_dataset_heads
        WHERE dataset_kind = 'flow' AND data_date = OLD.data_date AND normalized_bu = '';
      END;
    `);

    // 表 3：对账运行记录（spec §4.3）
    // status: 永远 'success'（系统错误直接 throw 给 IPC handler，不落 runs）
    db.exec(`
      CREATE TABLE IF NOT EXISTS biz_op_recon_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data_date TEXT NOT NULL,
        bu_name TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        t1_op_total INTEGER NOT NULL DEFAULT 0,
        t2_op_total INTEGER NOT NULL DEFAULT 0,
        flow_total INTEGER NOT NULL DEFAULT 0,
        amount_diff_count INTEGER NOT NULL DEFAULT 0,
        multi_op_account_count INTEGER NOT NULL DEFAULT 0,
        t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0,
        t1_not_t2_count INTEGER NOT NULL DEFAULT 0,
        t2_not_t1_count INTEGER NOT NULL DEFAULT 0,
        export_path TEXT,
        archive_contract_version INTEGER NOT NULL DEFAULT 0
          CHECK (archive_contract_version IN (0, 1)),
        archive_task_run_id TEXT,
        archive_terminal_ack_at TEXT
      );
    `);

    // v2.1.3 round 1（spec §4.3）：已有库幂等加列
    // 资金红线 ⚠️：T-2 期末 NaN silent drop 账户号数量（fix7-I3 持久化）
    if (!hasColumn(db, 'biz_op_recon_runs', 't2_anomaly_account_count')) {
      db.exec(`
        ALTER TABLE biz_op_recon_runs
        ADD COLUMN t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0;
      `);
    }
    if (!hasColumn(db, 'biz_op_recon_runs', 'archive_contract_version')) {
      db.exec(`ALTER TABLE biz_op_recon_runs ADD COLUMN archive_contract_version INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hasColumn(db, 'biz_op_recon_runs', 'archive_task_run_id')) {
      db.exec(`ALTER TABLE biz_op_recon_runs ADD COLUMN archive_task_run_id TEXT`);
    }
    if (!hasColumn(db, 'biz_op_recon_runs', 'archive_terminal_ack_at')) {
      db.exec(`ALTER TABLE biz_op_recon_runs ADD COLUMN archive_terminal_ack_at TEXT`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_runs_date_bu
        ON biz_op_recon_runs(data_date, bu_name, run_at DESC);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_runs_status
        ON biz_op_recon_runs(status, data_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_biz_op_runs_archive_task
        ON biz_op_recon_runs(archive_task_run_id)
        WHERE archive_contract_version = 1
          AND archive_task_run_id IS NOT NULL
          AND archive_task_run_id <> '';
      CREATE INDEX IF NOT EXISTS idx_biz_op_runs_unacked_archive
        ON biz_op_recon_runs(archive_terminal_ack_at, id)
        WHERE archive_contract_version = 1 AND archive_terminal_ack_at IS NULL;
      CREATE TRIGGER IF NOT EXISTS protect_biz_op_unacked_archive_run
      BEFORE DELETE ON biz_op_recon_runs
      WHEN OLD.archive_contract_version = 1 AND OLD.archive_terminal_ack_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'Biz OP run Archive terminal 尚未确认，禁止覆盖来源数据');
      END;
    `);

    // 表 4：差异行明细（spec §4.4）
    // FK 引用 biz_op_recon_runs(id)；删除顺序：diff_rows → runs（避免 FK 约束失败）
    db.exec(`
      CREATE TABLE IF NOT EXISTS biz_op_recon_diff_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        data_date TEXT NOT NULL,
        bu_name TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_row_id INTEGER NOT NULL,
        cmp_t2 TEXT NOT NULL DEFAULT '',
        multi_op_flag TEXT NOT NULL,
        cmp_amount TEXT NOT NULL DEFAULT '',
        amount_diff TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (run_id) REFERENCES biz_op_recon_runs(id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_diff_run
        ON biz_op_recon_diff_rows(run_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_biz_op_diff_date_bu
        ON biz_op_recon_diff_rows(data_date, bu_name);
    `);

    const insertLegacyHead = db.prepare(`
      INSERT OR IGNORE INTO biz_op_recon_dataset_heads (
        dataset_kind, data_date, normalized_bu, dataset_id,
        producer_task_run_id, dataset_version, archive_contract_version, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)
    `);
    const now = new Date().toISOString();
    for (const row of db.prepare(`
      SELECT DISTINCT data_date, LOWER(TRIM(bu_name)) AS normalized_bu
      FROM biz_op_recon_imports
      ORDER BY data_date, normalized_bu
    `).all()) {
      insertLegacyHead.run('op', row.data_date, row.normalized_bu, randomUUID(), now);
    }
    for (const row of db.prepare(`
      SELECT DISTINCT data_date FROM biz_op_recon_flow_imports ORDER BY data_date
    `).all()) {
      insertLegacyHead.run('flow', row.data_date, '', randomUUID(), now);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureBizOpReconTablesSupport
};
