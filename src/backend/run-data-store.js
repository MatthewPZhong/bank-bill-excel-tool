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
const { DatabaseSync } = require('node:sqlite');

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

// 已接入侧库的模块白名单（PR-3 仅 acquiring；PR-4 扩 biz-op-recon / bank-bu-recon）。
const MODULE_ACQUIRING = 'acquiring-bill-currency';
const KNOWN_MODULES = Object.freeze([MODULE_ACQUIRING]);

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

const MODULE_DDL = Object.freeze({
  [MODULE_ACQUIRING]: SIDE_DB_DDL_ACQUIRING,
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
  db.exec(MODULE_DDL[module]);
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
};
