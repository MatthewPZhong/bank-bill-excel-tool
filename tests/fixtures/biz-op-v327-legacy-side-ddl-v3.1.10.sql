-- v3.0.13–v3.1.10 业务 OP 月度文件（G1）建表语句，原样取自 git show v3.1.10^{commit}:src/backend/run-data-store.js 的 SIDE_DB_DDL_BIZ_OP。
-- 这些版本中该语句完全相同；只有 4 张表，biz_op_recon_runs 没有 archive_* 列，也没有触发器。不要按当前 schema 修改本文件。
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
  CREATE INDEX IF NOT EXISTS idx_biz_op_imports_date_bu
    ON biz_op_recon_imports(data_date, bu_name);
  CREATE INDEX IF NOT EXISTS idx_biz_op_imports_account
    ON biz_op_recon_imports(data_date, bu_name, account_no);
  CREATE INDEX IF NOT EXISTS idx_biz_op_imports_bu
    ON biz_op_recon_imports(bu_name);

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
  CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_date
    ON biz_op_recon_flow_imports(data_date);
  CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_date_bu
    ON biz_op_recon_flow_imports(data_date, bu_dept);
  CREATE INDEX IF NOT EXISTS idx_biz_op_flow_imports_account
    ON biz_op_recon_flow_imports(data_date, account_no);

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
    export_path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_biz_op_runs_date_bu
    ON biz_op_recon_runs(data_date, bu_name, run_at DESC);
  CREATE INDEX IF NOT EXISTS idx_biz_op_runs_status
    ON biz_op_recon_runs(status, data_date);

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
  CREATE INDEX IF NOT EXISTS idx_biz_op_diff_run
    ON biz_op_recon_diff_rows(run_id);
  CREATE INDEX IF NOT EXISTS idx_biz_op_diff_date_bu
    ON biz_op_recon_diff_rows(data_date, bu_name);
