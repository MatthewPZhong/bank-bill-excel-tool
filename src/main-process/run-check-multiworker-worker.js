// v2.1.12 β.1-T1 — 多 worker write-splitting（plan-b）worker 入口脚本
//
// 跑在 worker_threads 子线程内。本 worker 是 plan-b（每 worker 把 SELECT JOIN 结果写自己的
// temp db；主进程 ATTACH 各 temp db 汇总 INSERT 到目标表）的 reader + temp-writer 角色。
//
// 设计蓝本：scripts/poc/v2.1.12-beta-multiworker-worker.js（已验证 plan-b）。
// 生产化加固（与 POC 差异）：
//   1. SQL 不写死 —— init message 注入 selectSql + partColumns（业务 SQL 由调用方决定，模块不绑定
//      acquiring-bill-currency；将来 T-b1-2 接入 runCheckCore 时传 run-repository 同款 SELECT）
//   2. 错误序列化复用生产 src/main-process/serialize-error.js（与单 worker run-check-worker.js 同一套），
//      不再用 POC 的内联简化版（保留 cause 链 / SQLITE_* code / FileValidationError 字段）
//   3. PRAGMA 清单 + busy_timeout=30000 与 run-check-worker.js:48-55 完全一致 + verify int 比较
//   4. temp db 由 worker 写、worker close；写完回 message 报 tempDbPath + rowCount，
//      temp db 文件清理由主进程 pool 负责（worker 崩溃时主进程仍能清）
//
// 进程边界（与 run-check-worker.js 一致）：
//   - 不访问 Electron API（app / dialog / BrowserWindow / Notification）
//   - 不直写 activity log（本 worker 不产生业务 log；如需透传按 run-check-worker.js 范式加 'log' message）
//
// DB 连接：
//   - 收到 'init' 消息后 new DatabaseSync(dbPath)（只读主源；WAL 下并发 SELECT 不冲突）
//   - 6 条 PRAGMA 按 run-check-worker.js 顺序设置 + verify（int 比较：synchronous=1 / journal_mode='wal'）
//
// Message 协议：
//   主 → worker：
//     { type:'init', dbPath, selectSql, partColumns }                 — 打开只读 connection + prepare selectSql
//     { type:'select-chunk-to-temp', jobId, chunkIndex, bindParams, tempDbPath } — 写 temp db
//     { type:'close' }                                                — 关 DB + process.exit(0)
//   worker → 主：
//     { type:'init-done', pragmaValues }
//     { type:'init-error', error: serialized }
//     { type:'temp-done', jobId, chunkIndex, tempDbPath, rowCount, ms }
//     { type:'error', jobId, chunkIndex, error: serialized }
//
// 🔴 资金红线：worker 写 temp db 的 diff_part 必须保留 SELECT 返回的物理顺序（seq 自增 = 插入顺序），
//   主进程按 chunkIndex 升序 + diff_part.seq ASC 汇总，才能与单 worker 逐 chunk INSERT...SELECT byte-for-byte 一致。

'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');
const fs = require('node:fs');

// ─────────────────────────────────────────────────────────────────
// 模块级 helpers（unit test 在主线程 require 时只拿这部分；worker 进程内同名）
// ─────────────────────────────────────────────────────────────────

// PRAGMA 强制清单（与 run-check-worker.js:48-55 完全一致 + busy_timeout 30s）
const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',     // 64MB
  'PRAGMA mmap_size = 268435456;',   // 256MB
  'PRAGMA temp_store = MEMORY;',     // v3.0.3 PR-C（W1）：临时表/排序驻内存（与主进程同步）
  'PRAGMA busy_timeout = 30000;',    // 30s（防主进程 DB 写冲突 SQLITE_BUSY）
];

// PRAGMA verify 预期值（与 run-check-worker.js:58-65 一致；synchronous=int 1 / journal_mode='wal' 小写；temp_store=MEMORY 查询返回整数 2）
const PRAGMA_EXPECTED = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 1,
  cache_size: -65536,
  mmap_size: 268435456,
  temp_store: 2,
  busy_timeout: 30000,
};

// temp db 内中间结果表名 + schema（worker 写、主进程 ATTACH 读）
//   seq INTEGER PRIMARY KEY AUTOINCREMENT —— 保 INSERT 物理顺序 = SELECT 返回顺序（🔴 byte-for-byte 不变量）
const PART_TABLE = 'diff_part';

// 初始化 worker DB connection（只读主源）；返回 { db, pragmaValues }
//   - 主线程 unit test 直接调用本函数（dbPath = 临时 sqlite）
//   - worker 内 'init' message handler 也直接调用
function initWorkerDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  for (const sql of PRAGMA_STATEMENTS) {
    db.exec(sql);
  }
  const pragmaValues = {};
  for (const name of Object.keys(PRAGMA_EXPECTED)) {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const key = Object.keys(row)[0];
    pragmaValues[name] = row[key];
  }
  // 严格 verify — 不匹配 fail-fast（与 run-check-worker.js 同范式）
  for (const name of Object.keys(PRAGMA_EXPECTED)) {
    const expected = PRAGMA_EXPECTED[name];
    const actual = pragmaValues[name];
    const ok = typeof expected === 'string'
      ? String(actual).toLowerCase() === expected
      : Number(actual) === Number(expected);
    if (!ok) {
      try { db.close(); } catch (_e) { /* swallow */ }
      throw new Error(`multiworker PRAGMA verify 失败：${name} 期望 ${expected} 实际 ${actual}`);
    }
  }
  return { db, pragmaValues };
}

// 构造 temp db 的 PART_TABLE CREATE 语句（列由 init 注入的 partColumns 决定）
//   partColumns: [{ name, type }]（type 可省，默认无类型亲和 — SQLite 动态类型）
//   ⚠️ 不含 seq 列：seq 由 schema 固定加在最前（AUTOINCREMENT 保顺序）
function buildPartTableSql(partColumns) {
  if (!Array.isArray(partColumns) || partColumns.length === 0) {
    throw new Error('buildPartTableSql：partColumns 必须是非空数组');
  }
  const cols = partColumns.map((c) => {
    const name = typeof c === 'string' ? c : (c && c.name);
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`buildPartTableSql：非法列名 ${JSON.stringify(name)}`);
    }
    const type = (c && typeof c === 'object' && c.type) ? ` ${c.type}` : '';
    return `${name}${type}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${PART_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ${cols.join(',\n    ')}
  );`;
}

// 把一个 chunk 的 SELECT 结果写进 temp db 的 PART_TABLE（plan-b 核心）
//   - selectStmt：init 时 prepare 的只读 SELECT（业务 SQL，调用方注入）
//   - bindParams：本 chunk 的绑定参数数组（调用方决定 SQL 占位符顺序，常见 [monthKey, limit, offset]）
//   - partColumnNames：PART_TABLE 业务列名（顺序 = SELECT 输出列别名顺序）
//   返回 { rowCount, ms }
//
//   抽成纯函数便于 unit test 在主线程直接验证（不必起 worker 即可锁 byte-for-byte 顺序契约）
function writeChunkToTemp({ DatabaseSync, selectStmt, bindParams, tempDbPath, partColumnNames }) {
  const t0 = Date.now();
  const rows = selectStmt.all(...(Array.isArray(bindParams) ? bindParams : []));
  // 🔴 v2.1.12 β.1 self-review C1（资金红线）：固定 tempDir（main.js 的 storageRoot/.mw-tmp）跨 run 复用，
  //   若上一个 run 在 merge 期被硬杀 / OOM / 断电 → runWriteSplitChunks 的 finally 未执行 → part-<ci>.sqlite 残留。
  //   本函数 CREATE TABLE IF NOT EXISTS + INSERT（seq AUTOINCREMENT 续涨）会**追加**到残留行 →
  //   主进程 merge 按 seq 升序把残留+新行全收走 → diff_rows 重复（对账多算）。
  //   写前先删 temp db 文件 + WAL/SHM/journal sidecar，使每次写入幂等（与残留无关）。
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(tempDbPath + suffix, { force: true }); } catch (_e) { /* swallow — 不存在即可 */ }
  }
  const tdb = new DatabaseSync(tempDbPath);
  try {
    for (const sql of PRAGMA_STATEMENTS) tdb.exec(sql);
    const partTableSql = buildPartTableSql(partColumnNames.map((name) => ({ name })));
    tdb.exec(partTableSql);
    const placeholders = partColumnNames.map(() => '?').join(', ');
    const ins = tdb.prepare(
      `INSERT INTO ${PART_TABLE} (${partColumnNames.join(', ')}) VALUES (${placeholders})`
    );
    tdb.exec('BEGIN');
    try {
      for (const r of rows) {
        ins.run(...partColumnNames.map((name) => r[name]));
      }
      tdb.exec('COMMIT');
    } catch (err) {
      try { tdb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
      throw err;
    }
  } finally {
    try { tdb.close(); } catch (_e) { /* swallow */ }
  }
  return { rowCount: rows.length, ms: Date.now() - t0 };
}

// ─────────────────────────────────────────────────────────────────
// worker-only 副作用：仅 isMainThread=false 时执行（避免 unit test 污染主进程）
// ─────────────────────────────────────────────────────────────────

if (!isMainThread) {
  // 静默 SQLite ExperimentalWarning（与 run-check-worker.js 一致）
  process.on('warning', (warning) => {
    try {
      const name = warning && warning.name ? String(warning.name) : '';
      const msg = warning && warning.message ? String(warning.message) : '';
      const isSqliteExperimental =
        name === 'ExperimentalWarning' && (msg.includes('SQLite') || msg.includes('node:sqlite'));
      if (isSqliteExperimental) return;
      process.stderr.write(`(node:run-check-multiworker-worker) ${name}: ${msg}\n`);
    } catch (_e) { /* swallow */ }
  });

  // 错误序列化复用生产 serialize-error.js（与单 worker 同一套；保 cause 链 / SQLITE_* code）
  let serializeError;
  try {
    serializeError = require('./serialize-error').serializeError;
  } catch (_e) {
    serializeError = function serializeErrorFallback(err) {
      if (!err) return null;
      return {
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack || null,
        code: err.code !== undefined && err.code !== null ? String(err.code) : null,
      };
    };
  }

  const { DatabaseSync } = require('node:sqlite');

  let workerDb = null;        // 只读主源 connection
  let selectStmt = null;      // init 注入的业务 SELECT prepared statement
  let partColumnNames = null; // PART_TABLE 业务列名（顺序 = SELECT 输出列别名）
  let initialized = false;

  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    try {
      if (type === 'init') {
        if (initialized) {
          parentPort.postMessage({ type: 'init-done', pragmaValues: null });
          return;
        }
        const { dbPath, selectSql, partColumns } = msg;
        if (!dbPath || typeof dbPath !== 'string') {
          throw new Error('init message 缺 dbPath');
        }
        if (!selectSql || typeof selectSql !== 'string') {
          throw new Error('init message 缺 selectSql');
        }
        if (!Array.isArray(partColumns) || partColumns.length === 0) {
          throw new Error('init message 缺 partColumns（非空数组）');
        }
        partColumnNames = partColumns.map((c) => (typeof c === 'string' ? c : c && c.name));
        for (const name of partColumnNames) {
          if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`init message partColumns 含非法列名 ${JSON.stringify(name)}`);
          }
        }
        const { db, pragmaValues } = initWorkerDb(dbPath);
        workerDb = db;
        selectStmt = workerDb.prepare(selectSql);
        initialized = true;
        parentPort.postMessage({ type: 'init-done', pragmaValues });
        return;
      }

      if (type === 'select-chunk-to-temp') {
        if (!initialized || !workerDb) {
          throw new Error('worker 未初始化（请先发 init message）');
        }
        const { jobId, chunkIndex, bindParams, tempDbPath } = msg;
        if (!tempDbPath || typeof tempDbPath !== 'string') {
          throw new Error('select-chunk-to-temp message 缺 tempDbPath');
        }
        const { rowCount, ms } = writeChunkToTemp({
          DatabaseSync,
          selectStmt,
          bindParams,
          tempDbPath,
          partColumnNames,
        });
        parentPort.postMessage({ type: 'temp-done', jobId, chunkIndex, tempDbPath, rowCount, ms });
        return;
      }

      if (type === 'close') {
        try { if (workerDb) workerDb.close(); } catch (_e) { /* swallow */ }
        process.exit(0);
      }

      // 测试专用 — 模拟 worker crash（process.exit 非 0）。生产代码不发此 message。
      if (type === '__crash_for_test__') {
        const code = (msg && typeof msg.code === 'number') ? msg.code : 1;
        process.exit(code);
      }
    } catch (err) {
      const jobIdForError = msg && msg.jobId ? msg.jobId : null;
      const chunkIndexForError = msg && typeof msg.chunkIndex === 'number' ? msg.chunkIndex : null;
      if (type === 'init') {
        parentPort.postMessage({ type: 'init-error', error: serializeError(err) });
      } else {
        parentPort.postMessage({ type: 'error', jobId: jobIdForError, chunkIndex: chunkIndexForError, error: serializeError(err) });
      }
    }
  });
}

// 测试 / 主进程模块用导出（主线程 require 时使用）
module.exports = {
  PART_TABLE,
  PRAGMA_STATEMENTS,
  PRAGMA_EXPECTED,
  __test_only__: {
    initWorkerDb,
    buildPartTableSql,
    writeChunkToTemp,
  },
};
