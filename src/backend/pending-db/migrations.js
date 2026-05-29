// Pending 模块独立 DB 的幂等 schema 迁移
// 7 张表：rule / pending_months / pending_rows / diff_runs / diff_rows
//        + removed_pending_rows / pending_removal_matches（v2.1.11 T2 移除核对）
// 所有 CREATE 都用 IF NOT EXISTS，支持重复运行

const PENDING_COLUMNS = require('./columns');

function runMigrations(db) {
  // 规则表：单条全局（id 固定 '__GLOBAL__'）
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule (
      id TEXT PRIMARY KEY,
      match_fields TEXT NOT NULL,
      compare_fields TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 月份元数据表
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_months (
      year_month TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      source_files TEXT NOT NULL,
      archive_path TEXT
    );
  `);

  // 行级数据表：31 列具名 TEXT（原中文列名反引号包裹）
  const colDefs = PENDING_COLUMNS.map((c) => `\`${c}\` TEXT`).join(',\n      ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year_month TEXT NOT NULL,
      row_hash TEXT NOT NULL,
      ${colDefs}
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_rows_month ON pending_rows(year_month);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_rows_fund_type ON pending_rows(year_month, \`pending资金类型\`);`);
  // 同月 row_hash 唯一 → 支持 §5.4.5 行级冲突检测
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_rows_hash ON pending_rows(year_month, row_hash);`);

  // 运算 record 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS diff_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upper_month TEXT NOT NULL,
      lower_month TEXT NOT NULL,
      rule_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      stat_new INTEGER NOT NULL,
      stat_missing INTEGER NOT NULL,
      stat_changed INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_diff_runs_months ON diff_runs(lower_month, upper_month, created_at DESC);`);

  // 差异明细表
  db.exec(`
    CREATE TABLE IF NOT EXISTS diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES diff_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      upper_row_id INTEGER,
      lower_row_id INTEGER
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_diff_rows_run ON diff_rows(run_id, type);`);

  // === v2.1.11 T2 — pending 移除核对 ===
  // 表 1：removed_pending_rows — 存「移除归档Pending账单.xlsx」解析行（全 46 列 raw_json + 索引列）
  //   - year_month：关联"上月"(missing 来源月)，D-T2-1
  //   - raw_json：全 46 列原始数据 JSON（D-T2-3 导出展示用）
  //   - 索引列（order_no/recon_id/金额/channel/merchant_id/bank_ref）：matchFields 与 pending_rows
  //     公共字段中最常用作匹配 key 的 6 个，值从 raw_json 提取，仅用于查询加速；
  //     matchFields 若配其它列，匹配时从 raw 取值参与（慢路径，不依赖索引列正确性）
  db.exec(`
    CREATE TABLE IF NOT EXISTS removed_pending_rows (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      year_month    TEXT NOT NULL,
      source_file   TEXT,
      raw_json      TEXT NOT NULL,
      order_no      TEXT,
      recon_id      TEXT,
      \`金额\`        TEXT,
      channel       TEXT,
      merchant_id   TEXT,
      bank_ref      TEXT,
      created_at    TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_removed_ym ON removed_pending_rows(year_month);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_removed_order ON removed_pending_rows(year_month, order_no);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_removed_recon ON removed_pending_rows(year_month, recon_id);`);

  // 表 2：pending_removal_matches — 对账后 missing↔移除 匹配结果（D-T2-2 对账后自动）
  //   - run_id：关联 diff_runs.id
  //   - diff_row_id：匹配上的 missing diff_rows.id
  //   - removed_row_id：匹配上的 removed_pending_rows.id
  //   - match_field：命中哪个 matchField（留痕）
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_removal_matches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id         INTEGER NOT NULL,
      diff_row_id    INTEGER NOT NULL,
      removed_row_id INTEGER NOT NULL,
      match_field    TEXT,
      created_at     TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prm_run ON pending_removal_matches(run_id);`);
}

module.exports = { runMigrations };
