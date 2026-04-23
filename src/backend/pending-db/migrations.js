// Pending 模块独立 DB 的幂等 schema 迁移
// 5 张表：rule / pending_months / pending_rows / diff_runs / diff_rows
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
}

module.exports = { runMigrations };
