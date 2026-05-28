// v2.1.10 A3 Phase 1 T06 — runCheck worker 入口脚本
//
// 跑在 worker_threads 子线程内（D23 = (a)；POC 实测启动 11ms / IPC 0.010ms）。
// 主进程通过 message pipe 与本 worker 通讯（spec §2.1 / §2.2.1 / §2.4 / §2.5）。
//
// 进程边界（spec §1.2 关键不变量）：
//   - 不访问 Electron API（app / dialog / BrowserWindow / Notification）
//   - 不持有 lastUserActivityTs / idleCleanupTimer
//   - 不调 cleanupAfterRunBackground
//   - 不直写 activity log，全部通过 { type: 'log', entry } 转主进程 appendActivityLogEntry
//     （avoid 主/子进程并发追加 app_activity_log.txt 的 read-modify-write race —
//      logger.appendActivityRecord 不是 fs.appendFile 原子操作）
//
// DB 连接（spec §2.2.1 D24 = (a) 独立 connection）：
//   - 收到 'init' 消息后 new DatabaseSync(dbPath)
//   - 6 条 PRAGMA 必须按主进程 database.js:42 顺序设置（spec §2.5 强制清单 + busy_timeout 30s）
//   - PRAGMA verify 用 int 比较（POC surprise #5：synchronous 返回 int 1）
//
// POC 6 surprise 落地（spec §2.6.5）：
//   #1 静默 SQLite ExperimentalWarning
//   #5 PRAGMA verify int 比较（synchronous=1 / journal_mode='wal' 小写）
//
// Message 协议：
//   主 → worker：
//     { type: 'init', dbPath }                                   — 初始化 DB（独立 connection）
//     { type: 'run', jobId, payload: { monthKey, storageRoot } } — 执行 runCheck
//     { type: 'cancel', jobId }                                  — 设 cancelFlag（worker 内 graceful 退出）
//     { type: 'close' }                                          — 关 DB + process.exit(0)
//   worker → 主：
//     { type: 'init-done', pragmaValues }
//     { type: 'init-error', error: serialized }
//     { type: 'progress', jobId, payload }
//     { type: 'log', entry }                                     — appendActivityLogEntry 透传
//     { type: 'done', jobId, result }
//     { type: 'error', jobId, error: serialized }
//
// ⚠️ 资金红线：worker 内 runCheck 与主进程 byte-for-byte 一致（contract test 在 T09 落地）。

'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

// ─────────────────────────────────────────────────────────────────
// 模块级 helpers（unit test 在主线程 require 时只拿这部分；worker 进程内同名）
// ─────────────────────────────────────────────────────────────────

// PRAGMA 强制清单（spec §2.5 — 与主进程 database.js:42 完全一致 + busy_timeout 30s）
const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',     // 64MB
  'PRAGMA mmap_size = 268435456;',   // 256MB
  'PRAGMA busy_timeout = 30000;',    // 30s（A3 新增 — 防主进程 DB 写冲突 SQLITE_BUSY）
];

// PRAGMA verify 预期值（POC surprise #5：synchronous=int 1 / journal_mode='wal' 小写）
const PRAGMA_EXPECTED = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 1,
  cache_size: -65536,
  mmap_size: 268435456,
  busy_timeout: 30000,
};

// 内部函数：初始化 worker DB connection；返回 { db, pragmaValues }
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
  // 严格 verify — 不匹配 fail-fast（spec §2.5.3 失败影响表）
  for (const name of Object.keys(PRAGMA_EXPECTED)) {
    const expected = PRAGMA_EXPECTED[name];
    const actual = pragmaValues[name];
    const ok = typeof expected === 'string'
      ? String(actual).toLowerCase() === expected
      : Number(actual) === Number(expected);
    if (!ok) {
      try { db.close(); } catch (_e) { /* swallow */ }
      throw new Error(`worker PRAGMA verify 失败：${name} 期望 ${expected} 实际 ${actual}`);
    }
  }
  return { db, pragmaValues };
}

// ─────────────────────────────────────────────────────────────────
// worker-only 副作用：仅 isMainThread=false 时执行（避免 unit test 污染主进程）
// ─────────────────────────────────────────────────────────────────

if (!isMainThread) {
  // ── POC surprise #1：静默 SQLite ExperimentalWarning（保留其他 warning） ──
  process.on('warning', (warning) => {
    try {
      const name = warning && warning.name ? String(warning.name) : '';
      const msg = warning && warning.message ? String(warning.message) : '';
      const isSqliteExperimental =
        name === 'ExperimentalWarning' && (msg.includes('SQLite') || msg.includes('node:sqlite'));
      if (isSqliteExperimental) return;
      // 其他 warning 保留输出（Node 默认行为）
      process.stderr.write(`(node:run-check-worker) ${name}: ${msg}\n`);
    } catch (_e) { /* swallow */ }
  });

  // ── 错误序列化（T06 提供内联兜底；T08 落地后切到 ./serialize-error） ──
  let serializeError;
  try {
    serializeError = require('./serialize-error').serializeError;
  } catch (_e) {
    // T06 阶段 serialize-error.js 尚未落地 — 用内联兜底（10 层 cause + FileValidationError 字段）
    serializeError = function serializeErrorFallback(err, depth = 0) {
      if (!err) return null;
      if (depth > 10) {
        return { name: 'Error', message: '<cause chain too deep>', stack: null, code: null };
      }
      return {
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack || null,
        code: err.code || null,
        cause: err.cause ? serializeErrorFallback(err.cause, depth + 1) : null,
        detailLines: Array.isArray(err.detailLines) ? err.detailLines.slice() : null,
        context: err.context && typeof err.context === 'object' ? { ...err.context } : null,
      };
    };
  }

  // ── Log forwarder：monkey-patch logger.appendModuleLog 让 worker 内日志走 message pipe ──
  //   理由：logger.appendActivityRecord 内部 readFileSync + appendFileSync 非原子；
  //        主/子并发追加 app_activity_log.txt 会导致 [date] 头重复 / 行交错。
  const logger = require('../backend/logger');
  const originalAppendModuleLog = logger.appendModuleLog;
  logger.appendModuleLog = function workerAppendModuleLogForward(entry) {
    try {
      parentPort.postMessage({ type: 'log', entry: entry || {} });
    } catch (_e) {
      // 兜底：message pipe 失败时本地写盘（极少触发）
      try { originalAppendModuleLog(entry); } catch (_e2) { /* swallow */ }
    }
  };

  // ── runCheck 执行（worker 端） ──
  //   T06 阶段直接 require session.runCheck（与主进程路径完全一致）
  //   T09 阶段切到 require 抽出后的 runCheckCore，保持 byte-for-byte
  async function runCheckInWorker(workerDb, payload, jobId, cancelToken) {
    const { monthKey, storageRoot } = payload || {};
    if (!monthKey) {
      throw new Error('runCheckInWorker：monthKey 必填');
    }
    const session = require('./acquiring-bill-currency-session');
    const onProgress = (ev) => {
      try {
        parentPort.postMessage({ type: 'progress', jobId, payload: ev });
      } catch (_e) { /* swallow */ }
    };
    // cancelToken 占位（T13 接入 graceful cancel；T06 阶段仅检查启动前一次）
    if (cancelToken && cancelToken.cancelled) {
      throw new Error('worker canceled before runCheck start');
    }
    return await session.runCheck({ db: workerDb, monthKey, storageRoot, onProgress });
  }

  // ── 主消息循环 ──
  let workerDb = null;
  let initialized = false;
  let activeJob = null; // { jobId, cancelToken }

  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    try {
      if (type === 'init') {
        if (initialized) {
          // 幂等：已 init 直接回 init-done（不再重设 PRAGMA）
          parentPort.postMessage({ type: 'init-done', pragmaValues: null });
          return;
        }
        const { dbPath } = msg;
        if (!dbPath || typeof dbPath !== 'string') {
          throw new Error('init message 缺 dbPath');
        }
        const { db, pragmaValues } = initWorkerDb(dbPath);
        workerDb = db;
        initialized = true;
        parentPort.postMessage({ type: 'init-done', pragmaValues });
        return;
      }

      if (type === 'run') {
        if (!initialized || !workerDb) {
          throw new Error('worker 未初始化（请先发 init message）');
        }
        const { jobId, payload } = msg;
        if (!jobId) throw new Error('run message 缺 jobId');
        if (activeJob) {
          throw new Error(`worker 正在执行 jobId=${activeJob.jobId}，拒绝并发 run`);
        }
        const cancelToken = { cancelled: false };
        activeJob = { jobId, cancelToken };
        try {
          const result = await runCheckInWorker(workerDb, payload, jobId, cancelToken);
          parentPort.postMessage({ type: 'done', jobId, result });
        } catch (err) {
          parentPort.postMessage({ type: 'error', jobId, error: serializeError(err) });
        } finally {
          activeJob = null;
        }
        return;
      }

      if (type === 'cancel') {
        const { jobId } = msg;
        if (activeJob && (!jobId || activeJob.jobId === jobId)) {
          activeJob.cancelToken.cancelled = true;
        }
        return;
      }

      if (type === 'close') {
        try { if (workerDb) workerDb.close(); } catch (_e) { /* swallow */ }
        process.exit(0);
      }
    } catch (err) {
      const jobIdForError = msg && msg.jobId ? msg.jobId : null;
      if (type === 'init') {
        parentPort.postMessage({ type: 'init-error', error: serializeError(err) });
      } else {
        parentPort.postMessage({ type: 'error', jobId: jobIdForError, error: serializeError(err) });
      }
    }
  });
}

// 测试 / 调试用导出（主线程 require 时使用；worker 进程内也可用但通常不需要）
module.exports = {
  __test_only__: {
    initWorkerDb,
    PRAGMA_STATEMENTS,
    PRAGMA_EXPECTED,
  },
};
