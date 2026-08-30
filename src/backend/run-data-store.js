// v3.0.5 PR-3（Part B Phase 1）— per-月侧库管理器 🔴🔴 资金红线（差异表数据完整性）
//
// 背景与拍板（spec §B.4 Phase 1 / §B.6 / §B.9 B-D1/B-D3 + 用户 2026-06-12 拍板 A：per-month 侧库）：
//   对账类模块的 run 级批量数据（flow/bill/diff_rows 三表）禁止写主库，迁出到 per-月独立 sqlite 文件。
//   acquiring 的 flow/bill imports 生命周期键 = month_key（UNIQUE(month_key, recon_main_id)、import/run
//   两个独立 handler、clearRunsByMonth 按月清旧 runs/diff），故侧库文件键 = month（通则：侧库文件键 =
//   模块数据生命周期键）。runs 元数据留主库（轻量，含侧库相对路径 + 状态列）。
//
//   文件布局：{userData}/run-data/{module}/month-{monthKey}.sqlite
//     module = 'acquiring-bill-currency'（PR-3 唯一接入方；PR-4 推广 biz-op-recon / bank-bu-recon）
//
//   生命周期语义：
//     - 删整月（覆盖删除该月 / 孤儿清理 / cleanup）= 删侧库文件（原子、零碎片、零 VACUUM、零百万行 DELETE 阻塞）
//     - 删单 run（retention「仅保留 diff」二态另一态）= 文件内按 run_id 删 diff 行（与 clearRunsByMonth 同语义）
//
//   双库一致性（spec §B.6）：主库 runs 元数据与侧库文件非同事务，以「侧库文件存在性为准」——
//     启动孤儿扫描双向兜底（有文件无元数据 → 删文件；有元数据无文件 → 标记 run 失效）。
//
// 🔴 本模块不含任何对账算法语义；仅负责侧库文件的 建/开/删/路径解析 + 三表 DDL 平移（byte-for-byte 自主库 DDL）。
//   DDL 必须与主库 ensureAcquiringBillCurrencyTables*（migrations.js）的 flow/bill/diff 三表 + 索引一致，
//   且 diff_rows 的 FK ON DELETE CASCADE（bill_import_id / run_id）在侧库内保留（侧库内含 runs 影子表用于
//   FK 目标——见 DDL 注释；runs 业务真值仍在主库，侧库 runs 仅作 FK 锚 + diff JOIN 自洽）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ensureBizOpReconTablesSupport } = require('./biz-op-recon-db/migrations');

// 主库 init 的 PRAGMA 顺序（database.js:113-122）+ worker 追加 busy_timeout（run-check-worker.js:49-57）。
//   侧库被主进程直连（cleanup / 孤儿扫描 / retention）与 worker 直连（runCheck / import 引擎）双方打开，
//   两侧 PRAGMA 必须一致 → 统一在此声明，主进程打开走本清单，worker 打开走 run-check-worker 既有清单（值相同）。
const SIDE_DB_PRAGMA_STATEMENTS = Object.freeze([
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',
  'PRAGMA mmap_size = 268435456;',
  'PRAGMA temp_store = MEMORY;',
  'PRAGMA busy_timeout = 30000;',
]);

// 已接入侧库的模块白名单（PR-3 acquiring；PR-4 扩 biz-op-recon / bank-bu-recon）。
const MODULE_ACQUIRING = 'acquiring-bill-currency';
// v3.0.5 PR-4（Part B Phase 2）：业务OP数据核对 / 月度银行对账单BU回填校验 两模块侧库化。
//   两者生命周期键均 = per-month（month-{YYYY-MM}.sqlite）：
//     - bank-bu：天然按 year_month（importMonthAtomic 原子覆盖），与 acquiring 同构。
//     - biz-op：imports 按 date 分片但数据量小，按「对账归属月」= month(date) 单库自洽（免 ATTACH）。
const MODULE_BIZ_OP = 'biz-op-recon';
const MODULE_BANK_BU = 'bank-bu-recon';
// v3.0.14 PR2：前置资金对账双生命周期侧库。
//   临时 MPT 生命周期键 = 账单月份；运行结果生命周期键 = 运行月份且只保留当前进程最后一次结果。
//   两者分目录，临时明细不写 linked_gateway_bill 主表，旧运行结果可整文件回收。
const MODULE_PRE_FUND_RECONCILIATION = 'pre-fund-reconciliation';
// 运行候选池/结果与跨重启临时 MPT 的生命周期不同：结果只服务当前进程最后一次 run，
// 单独放可整文件删除的 results 模块，避免反复 run 让保留临时批次的月库永久膨胀。
const MODULE_PRE_FUND_RECONCILIATION_RESULTS = 'pre-fund-reconciliation-results';
// v3.0.15：重复入金匹配的银行导入与运行结果仅服务当前启动周期，
// 独立侧库保存含姓名/卡号的批量明细，主库只保留轻量运行镜像。
const MODULE_DUPLICATE_INBOUND_MATCH = 'duplicate-inbound-match';
const KNOWN_MODULES = Object.freeze([
  MODULE_ACQUIRING,
  MODULE_BIZ_OP,
  MODULE_BANK_BU,
  MODULE_PRE_FUND_RECONCILIATION,
  MODULE_PRE_FUND_RECONCILIATION_RESULTS,
  MODULE_DUPLICATE_INBOUND_MATCH,
]);

// run-data 根目录名（{userData}/run-data/）。
const RUN_DATA_DIRNAME = 'run-data';

// monthKey 格式校验（YYYY-MM）— 防路径注入 + 文件名稳定。
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function assertModule(module) {
  if (!KNOWN_MODULES.includes(module)) {
    throw new Error(`run-data-store：未知 module「${module}」（已接入：${KNOWN_MODULES.join(', ')}）`);
  }
}

function assertMonthKey(monthKey) {
  if (typeof monthKey !== 'string' || !MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`run-data-store：monthKey 必须为 YYYY-MM 格式，收到「${monthKey}」`);
  }
}

// run-data 根目录绝对路径（基于主库 dbPath 的同级目录 {userData}）。
//   caller 传 userDataDir（= path.dirname(database.dbPath)，即 {userData}）。
function runDataRoot(userDataDir) {
  if (!userDataDir || typeof userDataDir !== 'string') {
    throw new Error('run-data-store：userDataDir 必填');
  }
  return path.join(userDataDir, RUN_DATA_DIRNAME);
}

// 某 module 的侧库目录绝对路径（{userData}/run-data/{module}/）。
function moduleDir(userDataDir, module) {
  assertModule(module);
  return path.join(runDataRoot(userDataDir), module);
}

// 侧库文件名（month-{monthKey}.sqlite）。
function sideDbFileName(monthKey) {
  assertMonthKey(monthKey);
  return `month-${monthKey}.sqlite`;
}

// 侧库文件绝对路径。
function sideDbPath(userDataDir, module, monthKey) {
  return path.join(moduleDir(userDataDir, module), sideDbFileName(monthKey));
}

// 侧库文件相对路径（存进主库 runs 元数据列；与 userDataDir 解耦，便于跨机/迁移目录）。
//   形如 run-data/acquiring-bill-currency/month-2026-03.sqlite
function sideDbRelPath(module, monthKey) {
  assertModule(module);
  return path.join(RUN_DATA_DIRNAME, module, sideDbFileName(monthKey));
}

// 由相对路径还原绝对路径（读路径用：主库 runs 元数据存 rel，打开时拼 userDataDir）。
function resolveFromRel(userDataDir, relPath) {
  if (!userDataDir || typeof userDataDir !== 'string') {
    throw new Error('run-data-store：userDataDir 必填');
  }
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('run-data-store：relPath 必填');
  }
  return path.join(userDataDir, relPath);
}

// 从侧库文件名解析 monthKey（孤儿扫描用）；非法名返回 null。
function monthKeyFromFileName(fileName) {
  const m = /^month-(\d{4}-\d{2})\.sqlite$/.exec(fileName);
  return m ? m[1] : null;
}

// ── 三表 DDL（byte-for-byte 平移自主库 ensureAcquiringBillCurrencyTablesSupport，migrations.js:2602-2691）──
//   差异点（侧库专属，spec §B.6）：
//     1. 侧库内含 runs **影子表**（与主库 runs 同 schema），仅作 diff_rows.run_id 的 FK 目标 +
//        diff JOIN 自洽；run 业务真值（ran_at / 路径 / status / cleanup_pending / chunk_progress）仍在主库。
//        runCheckCore 在侧库内 insertRun 拿 runId（侧库自增），主库 runs 元数据行另存映射（side_db_rel_path）。
//     2. diff_rows 的 2 个 FK 直接带 ON DELETE CASCADE（侧库新建即终态，无需 N4-cont-2 那套 rebuild 迁移）。
const SIDE_DB_DDL_ACQUIRING = `
  CREATE TABLE IF NOT EXISTS acquiring_bill_currency_flow_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_row_index INTEGER NOT NULL,
    recon_main_id TEXT NOT NULL,
    settle_amount TEXT NOT NULL,
    settle_amount_abs TEXT NOT NULL,
    settle_currency TEXT,
    settle_currency_norm TEXT,
    raw_json TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (month_key, recon_main_id)
  );
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join_v2
    ON acquiring_bill_currency_flow_imports(month_key, recon_main_id, settle_currency_norm);

  CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_key TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_row_index INTEGER NOT NULL,
    recon_main_id TEXT NOT NULL,
    settle_currency TEXT,
    settle_currency_norm TEXT,
    raw_json TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (month_key, recon_main_id)
  );
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join_v2
    ON acquiring_bill_currency_bill_imports(month_key, recon_main_id, settle_currency_norm);
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_source_file
    ON acquiring_bill_currency_bill_imports(source_file);

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
    report_file_path TEXT,
    cleanup_pending INTEGER DEFAULT 0,
    chunk_progress TEXT
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
  CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_diff_run
    ON acquiring_bill_currency_diff_rows(run_id);
`;

// ── biz-op 4 表 DDL（byte-for-byte 平移自 biz-op-recon-db/migrations.js ensureBizOpReconTablesSupport）──
//   差异点（侧库专属）：
//     1. runs.t2_anomaly_account_count 在新库建表即含该列（主库走 hasColumn+ALTER 幂等加列分支，
//        侧库新建即终态，直接含列；schema 等价）。
//     2. diff_rows FK 引用 runs(id)（主库无 ON DELETE CASCADE，侧库也不加——byte-for-byte；
//        删整月 = 删文件，无需级联；删单 (date,BU) 由 clearRunsAndDiffsByDateBu 按 FK 顺序手删）。
//   ⚠️ worker（import-worker.js openDb）打开侧库时也会 ensureBizOpReconTablesSupport(db) 防御性建表，
//     必须与本 DDL 同 schema（CREATE TABLE/INDEX IF NOT EXISTS 幂等，先到先建，schema 一致即无冲突）。
const SIDE_DB_DDL_BIZ_OP = `
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

  CREATE TABLE IF NOT EXISTS biz_op_recon_month_end_copy_intents (
    source_task_run_id TEXT PRIMARY KEY,
    data_date TEXT NOT NULL,
    normalized_bu TEXT NOT NULL,
    dataset_id TEXT NOT NULL UNIQUE,
    dataset_version INTEGER NOT NULL CHECK (dataset_version >= 1),
    producer_task_run_id TEXT NOT NULL,
    target_month TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (data_date, normalized_bu)
  );

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
  CREATE INDEX IF NOT EXISTS idx_biz_op_runs_date_bu
    ON biz_op_recon_runs(data_date, bu_name, run_at DESC);
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
`;

// ── bank-bu 3 业务表 + v3.2.2 operation receipt DDL ──
//   bank-bu 无 diff_rows 表（差异由 session.runReconciliation 实时算，不落库）；侧库只含
//   pending_imports / bank_imports / runs 三表 + 5 索引。runs 业务真值在侧库（insertRun），
//   主库另存镜像行（side_db_rel_path + summary + status，供 UI/导出读）。
//   operation receipt 是加法 schema；E06-P0 不接 live writer，后续 E08-A 必须把它与
//   import/run 的 side mutation 放在同一事务，并独立完成 main mirror CAS identity。
const SIDE_DB_DDL_BANK_BU = `
  CREATE TABLE IF NOT EXISTS bank_bu_recon_pending_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_month TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    pending_biz_id TEXT,
    bill_date TEXT,
    pending_type TEXT,
    fund_type TEXT,
    entity TEXT,
    finance_bu TEXT,
    biz_dept TEXT,
    counter_dept TEXT,
    recon_id TEXT,
    channel TEXT,
    account_no TEXT,
    amount TEXT,
    currency TEXT,
    bank_period TEXT,
    balance_period TEXT,
    remark TEXT,
    status TEXT,
    update_time TEXT,
    operator TEXT,
    bu_fix_flag TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bbr_pending_month
    ON bank_bu_recon_pending_imports(year_month);
  CREATE INDEX IF NOT EXISTS idx_bbr_pending_reconid
    ON bank_bu_recon_pending_imports(year_month, recon_id);

  CREATE TABLE IF NOT EXISTS bank_bu_recon_bank_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_month TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    account_entity TEXT,
    account_bu TEXT,
    biz_id TEXT,
    bill_date TEXT,
    value_date TEXT,
    channel TEXT,
    region TEXT,
    merchant_id TEXT,
    currency TEXT,
    credit_amount TEXT,
    debit_amount TEXT,
    reconciliation_id TEXT,
    channel_order_no TEXT,
    customer_ref TEXT,
    account_reference TEXT,
    transaction_description TEXT,
    extra_information TEXT,
    payment_detail TEXT,
    payee_name TEXT,
    payee_card_no TEXT,
    drawee_name TEXT,
    drawee_card_no TEXT,
    by_order_of_beneficiary TEXT,
    extra_fee TEXT,
    trade_channel TEXT,
    fund_type TEXT,
    remark_description TEXT,
    datasource TEXT,
    remark_bu TEXT,
    fill_method TEXT,
    related_account TEXT,
    auto_category_rule TEXT,
    categorized_by TEXT,
    clearing_network TEXT,
    last_modified_time TEXT,
    recon_amount TEXT,
    origin_bill_id TEXT,
    fx_channel TEXT,
    fx_recon_id TEXT,
    buy_currency TEXT,
    buy_amount TEXT,
    sell_currency TEXT,
    sell_amount TEXT,
    split_info TEXT,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bbr_bank_month
    ON bank_bu_recon_bank_imports(year_month);
  CREATE INDEX IF NOT EXISTS idx_bbr_bank_reconid
    ON bank_bu_recon_bank_imports(year_month, reconciliation_id);

  CREATE TABLE IF NOT EXISTS bank_bu_recon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_month TEXT NOT NULL,
    run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    pending_total INTEGER NOT NULL,
    bank_total INTEGER NOT NULL,
    matched_count INTEGER NOT NULL,
    bu_diff_count INTEGER NOT NULL,
    pending_unmatched INTEGER NOT NULL,
    bank_unmatched INTEGER NOT NULL,
    anomaly_count INTEGER NOT NULL DEFAULT 0,
    anomaly_report_path TEXT,
    export_path TEXT,
    operation_key TEXT,
    producer_task_run_id TEXT,
    input_evidence_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bbr_runs_month
    ON bank_bu_recon_runs(year_month, run_at DESC);

  CREATE TABLE IF NOT EXISTS bank_bu_operation_receipts (
    action_key TEXT NOT NULL CHECK (action_key IN ('bank-bu:import-month', 'bank-bu:run')),
    operation_key TEXT NOT NULL,
    producer_task_run_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('import', 'run')),
    year_month TEXT NOT NULL,
    side_run_id INTEGER,
    input_evidence_hash TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(action_key, operation_key),
    CHECK (
      (action_key = 'bank-bu:import-month' AND operation_kind = 'import' AND side_run_id IS NULL)
      OR
      (action_key = 'bank-bu:run' AND operation_kind = 'run' AND side_run_id IS NOT NULL AND side_run_id > 0)
    )
  );

  CREATE TABLE IF NOT EXISTS bank_bu_dataset_evidence (
    year_month TEXT PRIMARY KEY,
    pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
    bank_count INTEGER NOT NULL CHECK (bank_count >= 0),
    pending_evidence_hash TEXT NOT NULL,
    bank_evidence_hash TEXT NOT NULL,
    dataset_hash TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    producer_task_run_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function ensureBankBuManagedSchema(db) {
  db.exec(SIDE_DB_DDL_BANK_BU);
  const columns = new Set(
    db.prepare('PRAGMA table_info(bank_bu_recon_runs)').all().map((column) => column.name)
  );
  if (!columns.has('operation_key')) {
    db.exec('ALTER TABLE bank_bu_recon_runs ADD COLUMN operation_key TEXT');
  }
  if (!columns.has('producer_task_run_id')) {
    db.exec('ALTER TABLE bank_bu_recon_runs ADD COLUMN producer_task_run_id TEXT');
  }
  if (!columns.has('input_evidence_hash')) {
    db.exec('ALTER TABLE bank_bu_recon_runs ADD COLUMN input_evidence_hash TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bbr_runs_operation
      ON bank_bu_recon_runs(operation_key)
      WHERE operation_key IS NOT NULL;
  `);
}

// ── 前置资金对账临时 MPT 网关账单（v3.0.14 PR2）──
//   一个 side DB 对应一个账单月份。批次表负责文件身份、hash 和重推序号；规范行表保留
//   来源血缘、未来 1:1 对账所需字段、原始 33 字段 JSON 与十字段业务指纹。
//   同批次替换保留 batch.id，在单事务内清旧 rows + UPDATE meta + INSERT new rows，
//   防重推改变批次稳定顺序；失败回滚后旧批次完整恢复。
const SIDE_DB_DDL_PRE_FUND_GATEWAY = `
  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_batches (
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
    dataset_id TEXT,
    producer_task_run_id TEXT,
    dataset_version INTEGER NOT NULL DEFAULT 0 CHECK (dataset_version >= 0),
    archive_contract_version INTEGER NOT NULL DEFAULT 0
      CHECK (archive_contract_version IN (0, 1)),
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_type, source_batch),
    UNIQUE (source_file_name)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_gateway_batches_date
    ON pre_fund_reconciliation_gateway_batches(source_date, source_type, source_batch);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_batch TEXT NOT NULL,
    source_date TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_file_sequence TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    reconciliation_id TEXT,
    gateway_date TEXT NOT NULL,
    channel TEXT,
    merchant_id TEXT,
    order_id TEXT,
    bill_recon_id TEXT,
    recon_bill_biz_id TEXT,
    currency TEXT NOT NULL,
    amount TEXT NOT NULL,
    trade_type TEXT,
    name TEXT,
    card_no TEXT,
    real_channel TEXT,
    clearing_network TEXT,
    raw_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES pre_fund_reconciliation_gateway_batches(id) ON DELETE CASCADE,
    UNIQUE (batch_id, source_row_number)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_gateway_rows_recon
    ON pre_fund_reconciliation_gateway_rows(reconciliation_id, batch_id, source_row_number);
  CREATE INDEX IF NOT EXISTS idx_pre_fund_gateway_rows_fingerprint
    ON pre_fund_reconciliation_gateway_rows(reconciliation_id, fingerprint);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_excluded_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_row_number INTEGER NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    field_name TEXT,
    fields_json TEXT NOT NULL,
    raw_line TEXT NOT NULL,
    FOREIGN KEY (batch_id) REFERENCES pre_fund_reconciliation_gateway_batches(id) ON DELETE CASCADE,
    UNIQUE (batch_id, source_row_number)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_gateway_excluded_batch
    ON pre_fund_reconciliation_gateway_excluded_rows(batch_id, source_row_number);

  CREATE TABLE IF NOT EXISTS pre_fund_operation_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    producer_task_run_id TEXT NOT NULL,
    file_index INTEGER NOT NULL,
    outcome_kind TEXT NOT NULL CHECK(outcome_kind IN (
      'inserted','replaced','noop-existing-batch'
    )),
    batch_id INTEGER NOT NULL,
    dataset_id TEXT,
    dataset_version_before INTEGER,
    dataset_version_after INTEGER,
    source_file_name TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    UNIQUE(action_key, operation_key)
  );
`;

// 前置资金对账 run 级数据：候选池和结果均为 bulk，放独立 results 月侧库，主库不落明细。
const SIDE_DB_DDL_PRE_FUND_RUNS = `
  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    bank_files_json TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    archive_contract_version INTEGER NOT NULL DEFAULT 0
      CHECK (archive_contract_version IN (0, 1)),
    archive_task_run_id TEXT,
    archive_terminal_ack_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_runs_created
    ON pre_fund_reconciliation_runs(created_at DESC);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source_priority INTEGER NOT NULL,
    source_order INTEGER NOT NULL,
    source_label TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    raw_json_hash BLOB NOT NULL,
    fields_json TEXT NOT NULL,
    name TEXT,
    card_no TEXT,
    source_location_json TEXT NOT NULL,
    consumed_bank_ordinal INTEGER,
    FOREIGN KEY (run_id) REFERENCES pre_fund_reconciliation_runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, reconciliation_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_pool_match
    ON pre_fund_reconciliation_gateway_pool(
      run_id, reconciliation_id, consumed_bank_ordinal, source_priority, source_order
    );

  -- 仅在首次发现重复组时按来源记录 ID 回读并保存保留候选原始 JSON。
  -- 唯一候选绝不写本表，避免百万候选产生全量宽数据复制。
  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_gateway_candidate_snapshots (
    pool_id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (pool_id) REFERENCES pre_fund_reconciliation_gateway_pool(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES pre_fund_reconciliation_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_candidate_snapshots_run
    ON pre_fund_reconciliation_gateway_candidate_snapshots(run_id, pool_id);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_duplicate_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    kept_pool_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    first_event_order INTEGER NOT NULL,
    fold_reason TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES pre_fund_reconciliation_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (kept_pool_id) REFERENCES pre_fund_reconciliation_gateway_pool(id) ON DELETE CASCADE,
    UNIQUE (run_id, kept_pool_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_duplicate_groups_channel
    ON pre_fund_reconciliation_duplicate_groups(run_id, channel, first_event_order, id);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_folded_gateway_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    source_priority INTEGER NOT NULL,
    source_order INTEGER NOT NULL,
    source_label TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    name TEXT,
    card_no TEXT,
    source_location_json TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (group_id) REFERENCES pre_fund_reconciliation_duplicate_groups(id) ON DELETE CASCADE,
    UNIQUE (group_id, source_priority, source_order)
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_folded_rows_group
    ON pre_fund_reconciliation_folded_gateway_rows(group_id, source_priority, source_order, id);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_balanced_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    bank_ordinal INTEGER NOT NULL,
    output_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES pre_fund_reconciliation_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_balanced_channel
    ON pre_fund_reconciliation_balanced_rows(run_id, channel, bank_ordinal);

  CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_unbalanced_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    bank_ordinal INTEGER NOT NULL,
    output_json TEXT NOT NULL,
    channel_output_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES pre_fund_reconciliation_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pre_fund_unbalanced_channel
    ON pre_fund_reconciliation_unbalanced_rows(run_id, channel, bank_ordinal);
`;

function hasTableColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((entry) => entry.name === column);
}

function ensurePreFundGatewayArchiveSupport(db) {
  db.exec(SIDE_DB_DDL_PRE_FUND_GATEWAY);
  const columns = [
    ['dataset_id', 'TEXT'],
    ['producer_task_run_id', 'TEXT'],
    ['dataset_version', 'INTEGER NOT NULL DEFAULT 0 CHECK (dataset_version >= 0)'],
    [
      'archive_contract_version',
      'INTEGER NOT NULL DEFAULT 0 CHECK (archive_contract_version IN (0, 1))'
    ]
  ];
  for (const [column, definition] of columns) {
    if (!hasTableColumn(db, 'pre_fund_reconciliation_gateway_batches', column)) {
      db.exec(`ALTER TABLE pre_fund_reconciliation_gateway_batches ADD COLUMN ${column} ${definition}`);
    }
  }
  const legacyRows = db.prepare(`
    SELECT id FROM pre_fund_reconciliation_gateway_batches
    WHERE dataset_id IS NULL OR dataset_id = ''
    ORDER BY id ASC
  `).all();
  if (legacyRows.length > 0) {
    const backfill = db.prepare(`
      UPDATE pre_fund_reconciliation_gateway_batches
      SET dataset_id = ?, producer_task_run_id = NULL,
          dataset_version = 0, archive_contract_version = 0
      WHERE id = ?
    `);
    db.exec('BEGIN');
    try {
      for (const row of legacyRows) backfill.run(randomUUID(), row.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 原错误优先 */ }
      throw error;
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_fund_gateway_batches_dataset
      ON pre_fund_reconciliation_gateway_batches(dataset_id)
      WHERE dataset_id IS NOT NULL AND dataset_id <> '';
    CREATE TRIGGER IF NOT EXISTS trg_pre_fund_gateway_batch_legacy_update
    AFTER UPDATE OF source_date, source_file_name, source_file_sequence,
                    content_hash, declared_row_count, row_count,
                    excluded_row_count, import_mode
    ON pre_fund_reconciliation_gateway_batches
    WHEN OLD.archive_contract_version = 1
      AND NEW.dataset_id IS OLD.dataset_id
      AND NEW.producer_task_run_id IS OLD.producer_task_run_id
      AND NEW.dataset_version = OLD.dataset_version
      AND NEW.archive_contract_version = OLD.archive_contract_version
    BEGIN
      UPDATE pre_fund_reconciliation_gateway_batches
      SET dataset_id = NULL, producer_task_run_id = NULL,
          dataset_version = OLD.dataset_version + 1, archive_contract_version = 0
      WHERE id = NEW.id;
    END;
  `);
}

function ensurePreFundRunArchiveSupport(db) {
  db.exec(SIDE_DB_DDL_PRE_FUND_RUNS);
  const columns = [
    [
      'archive_contract_version',
      'INTEGER NOT NULL DEFAULT 0 CHECK (archive_contract_version IN (0, 1))'
    ],
    ['archive_task_run_id', 'TEXT'],
    ['archive_terminal_ack_at', 'TEXT']
  ];
  for (const [column, definition] of columns) {
    if (!hasTableColumn(db, 'pre_fund_reconciliation_runs', column)) {
      db.exec(`ALTER TABLE pre_fund_reconciliation_runs ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_fund_runs_archive_task
      ON pre_fund_reconciliation_runs(archive_task_run_id)
      WHERE archive_contract_version = 1
        AND archive_task_run_id IS NOT NULL AND archive_task_run_id <> '';
  `);
}

// 重复入金匹配当前会话侧库。一个导入会话对应一组银行+单据输入；每次 run 只保留最新结果。
// 银行原始 46 列、单据身份字段和人工判定行均只存在本侧库，不进入 tool-data.sqlite。
// v3.2.2 operation receipt 与 E07-B result_digest 均为加法 schema；managed writer 才要求
// side mutation + receipt + 完整 post-image digest 同事务，legacy/live 路由保持原状。
const SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH = `
  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_file_name TEXT NOT NULL,
    bank_content_hash TEXT NOT NULL,
    bank_row_count INTEGER NOT NULL,
    document_file_name TEXT NOT NULL,
    document_content_hash TEXT NOT NULL,
    document_row_count INTEGER NOT NULL,
    document_matchable_row_count INTEGER NOT NULL,
    document_empty_order_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_bank_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    source_ordinal INTEGER NOT NULL,
    excel_row_number INTEGER NOT NULL,
    biz_id TEXT NOT NULL,
    fund_type TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (import_id) REFERENCES duplicate_inbound_match_imports(id) ON DELETE CASCADE,
    UNIQUE (import_id, source_ordinal),
    UNIQUE (import_id, biz_id)
  );
  CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_bank_fund_type
    ON duplicate_inbound_match_bank_rows(import_id, fund_type, source_ordinal);

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_document_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    source_ordinal INTEGER NOT NULL,
    excel_row_number INTEGER NOT NULL,
    business_order_no TEXT NOT NULL,
    business_order_key TEXT NOT NULL,
    user_no TEXT NOT NULL,
    account_no TEXT NOT NULL,
    business_department TEXT NOT NULL,
    FOREIGN KEY (import_id) REFERENCES duplicate_inbound_match_imports(id) ON DELETE CASCADE,
    UNIQUE (import_id, source_ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_document_order
    ON duplicate_inbound_match_document_rows(import_id, business_order_key, source_ordinal);

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    result_digest TEXT CHECK (
      result_digest IS NULL OR (
        length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    FOREIGN KEY (import_id) REFERENCES duplicate_inbound_match_imports(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_mail_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source_ordinal INTEGER NOT NULL,
    output_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES duplicate_inbound_match_runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, source_ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_mail_order
    ON duplicate_inbound_match_mail_rows(run_id, source_ordinal);

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_manual_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    group_order INTEGER NOT NULL,
    row_order INTEGER NOT NULL,
    reason TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES duplicate_inbound_match_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_manual_order
    ON duplicate_inbound_match_manual_rows(run_id, group_order, row_order, id);

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_group_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    group_order INTEGER NOT NULL,
    disposition TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      bank_lineage_json TEXT NOT NULL,
      mpt_lineage_json TEXT NOT NULL,
      document_lineage_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES duplicate_inbound_match_runs(id) ON DELETE CASCADE,
    UNIQUE (run_id, group_order)
  );
  CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_audit_order
    ON duplicate_inbound_match_group_audits(run_id, group_order);

  CREATE TABLE IF NOT EXISTS duplicate_inbound_match_operation_receipts (
    action_key TEXT NOT NULL CHECK (action_key IN ('duplicate:import', 'duplicate:run')),
    operation_key TEXT NOT NULL,
    producer_task_run_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('import-side-committed', 'run-side-committed')),
    month_key TEXT NOT NULL,
    import_bundle_id INTEGER NOT NULL CHECK (import_bundle_id > 0),
    side_run_id INTEGER,
    input_evidence_hash TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(action_key, operation_key),
    CHECK (
      (action_key = 'duplicate:import' AND phase = 'import-side-committed' AND side_run_id IS NULL)
      OR
      (action_key = 'duplicate:run' AND phase = 'run-side-committed' AND side_run_id IS NOT NULL AND side_run_id > 0)
    )
  );
`;

function ensureDuplicateInboundMatchResultDigestSupport(db) {
  db.exec(SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH);
  if (!hasTableColumn(db, 'duplicate_inbound_match_runs', 'result_digest')) {
    db.exec(`
      ALTER TABLE duplicate_inbound_match_runs
      ADD COLUMN result_digest TEXT CHECK (
        result_digest IS NULL OR (
          length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
        )
      )
    `);
  }
}

const MODULE_DDL = Object.freeze({
  [MODULE_ACQUIRING]: SIDE_DB_DDL_ACQUIRING,
  [MODULE_BIZ_OP]: SIDE_DB_DDL_BIZ_OP,
  [MODULE_BANK_BU]: SIDE_DB_DDL_BANK_BU,
  [MODULE_PRE_FUND_RECONCILIATION]: SIDE_DB_DDL_PRE_FUND_GATEWAY,
  [MODULE_PRE_FUND_RECONCILIATION_RESULTS]: SIDE_DB_DDL_PRE_FUND_RUNS,
  [MODULE_DUPLICATE_INBOUND_MATCH]: SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH,
});

// 打开（必要时建库）侧库连接。
//   - 目录不存在自动建（recursive）。
//   - 新建文件 / 已存在文件均执行 DDL（CREATE TABLE/INDEX IF NOT EXISTS 幂等）。
//   - PRAGMA 按 SIDE_DB_PRAGMA_STATEMENTS（主进程直连用）。
//   返回 DatabaseSync 实例；caller 负责 close。
function openSideDb(userDataDir, module, monthKey) {
  assertModule(module);
  assertMonthKey(monthKey);
  const dir = moduleDir(userDataDir, module);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = sideDbPath(userDataDir, module, monthKey);
  const db = new DatabaseSync(filePath);
  for (const sql of SIDE_DB_PRAGMA_STATEMENTS) db.exec(sql);
  if (module === MODULE_BIZ_OP) {
    ensureBizOpReconTablesSupport(db);
  } else if (module === MODULE_PRE_FUND_RECONCILIATION) {
    ensurePreFundGatewayArchiveSupport(db);
  } else if (module === MODULE_PRE_FUND_RECONCILIATION_RESULTS) {
    ensurePreFundRunArchiveSupport(db);
  } else if (module === MODULE_DUPLICATE_INBOUND_MATCH) {
    ensureDuplicateInboundMatchResultDigestSupport(db);
  } else if (module === MODULE_BANK_BU) {
    ensureBankBuManagedSchema(db);
  } else {
    db.exec(MODULE_DDL[module]);
  }
  return db;
}

// 仅打开（不建表）— 读路径用，文件必须已存在；不存在抛错（caller 先 existsSync 判存在性）。
function openExistingSideDb(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('run-data-store：filePath 必填');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`run-data-store：侧库文件不存在「${filePath}」`);
  }
  const db = new DatabaseSync(filePath);
  for (const sql of SIDE_DB_PRAGMA_STATEMENTS) db.exec(sql);
  return db;
}

// 侧库文件是否存在。
function sideDbExists(userDataDir, module, monthKey) {
  try {
    return fs.existsSync(sideDbPath(userDataDir, module, monthKey));
  } catch (_e) {
    return false;
  }
}

// 删整月侧库文件（删 run / 孤儿清理 / cleanup 的文件级回收）。
//   连同 WAL/SHM 旁文件一并删（WAL 模式产生 *.sqlite-wal / *.sqlite-shm）。
//   返回 { deleted: bool, path }；文件本不存在视为 deleted:false（幂等）。
function deleteSideDb(userDataDir, module, monthKey) {
  const filePath = sideDbPath(userDataDir, module, monthKey);
  return deleteSideDbByPath(filePath);
}

// 按绝对路径删侧库文件（孤儿扫描用：扫到的文件名直接删）。
function deleteSideDbByPath(filePath) {
  let deleted = false;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = filePath + suffix;
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        if (suffix === '') deleted = true;
      }
    } catch (_e) { /* swallow — 单文件删失败不阻断 */ }
  }
  return { deleted, path: filePath };
}

// 列出某 module 侧库目录下所有侧库文件（孤儿扫描用）。
//   返回 [{ fileName, monthKey, path }]；目录不存在返回 []。
function listSideDbFiles(userDataDir, module) {
  assertModule(module);
  const dir = moduleDir(userDataDir, module);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_e) {
    return []; // 目录不存在 → 无侧库文件
  }
  const out = [];
  for (const name of entries) {
    const monthKey = monthKeyFromFileName(name);
    if (!monthKey) continue; // 跳过 -wal / -shm / 非法名
    out.push({ fileName: name, monthKey, path: path.join(dir, name) });
  }
  return out;
}

module.exports = {
  MODULE_ACQUIRING,
  MODULE_BIZ_OP,
  MODULE_BANK_BU,
  MODULE_PRE_FUND_RECONCILIATION,
  MODULE_PRE_FUND_RECONCILIATION_RESULTS,
  MODULE_DUPLICATE_INBOUND_MATCH,
  KNOWN_MODULES,
  RUN_DATA_DIRNAME,
  SIDE_DB_PRAGMA_STATEMENTS,
  runDataRoot,
  moduleDir,
  sideDbFileName,
  sideDbPath,
  sideDbRelPath,
  resolveFromRel,
  monthKeyFromFileName,
  openSideDb,
  openExistingSideDb,
  sideDbExists,
  deleteSideDb,
  deleteSideDbByPath,
  listSideDbFiles,
  // P2（codex PR#73 复审修复）：暴露侧库 schema DDL，供 date-range 导出在 :memory: 库重建表结构
  //   （biz-op buildRangeExportDb 用 SIDE_DB_DDL_BIZ_OP；此前未导出 → undefined → exec 抛错）。
  SIDE_DB_DDL_ACQUIRING,
  SIDE_DB_DDL_BIZ_OP,
  SIDE_DB_DDL_BANK_BU,
  SIDE_DB_DDL_PRE_FUND_GATEWAY,
  SIDE_DB_DDL_PRE_FUND_RUNS,
  SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH,
  ensurePreFundGatewayArchiveSupport,
  ensurePreFundRunArchiveSupport,
  ensureDuplicateInboundMatchResultDigestSupport,
  ensureBankBuManagedSchema,
};
