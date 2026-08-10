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
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');

// ─────────────────────────────────────────────────────────────────
// 模块级 helpers（unit test 在主线程 require 时只拿这部分；worker 进程内同名）
// ─────────────────────────────────────────────────────────────────

// PRAGMA 强制清单（spec §2.5 — 与主进程 database.js 完全一致 + busy_timeout 30s）
//   主进程清单 6 条（foreign_keys → WAL → synchronous → cache_size → mmap_size → temp_store）+ worker 追加 busy_timeout。
const PRAGMA_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -65536;',     // 64MB
  'PRAGMA mmap_size = 268435456;',   // 256MB
  'PRAGMA temp_store = MEMORY;',     // v3.0.3 PR-C（W1）：临时表/排序驻内存（与主进程同步）
  'PRAGMA busy_timeout = 30000;',    // 30s（A3 新增 — 防主进程 DB 写冲突 SQLITE_BUSY）
];

// PRAGMA verify 预期值（POC surprise #5：synchronous=int 1 / journal_mode='wal' 小写；temp_store=MEMORY 查询返回整数 2）
const PRAGMA_EXPECTED = {
  foreign_keys: 1,
  journal_mode: 'wal',
  synchronous: 1,
  cache_size: -65536,
  mmap_size: 268435456,
  temp_store: 2,
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
  //   T09：直接调 session.runCheckCore（抽出后的纯函数；与主进程直调路径 byte-for-byte 一致）
  //   v2.1.10 T13：cancelToken 透传 runCheckCore；5 阶段间 check + 事务中 cancel → ROLLBACK + CancelError
  //   v2.1.10 T18：payload 新增 chunkSize（caller 从 settings 注入；spec §3.2 默认 100000）
  //   v2.1.10 T19：payload 新增 resumeFromRun = { runId, lastCompletedChunkIndex }（resume 路径）
  async function runCheckInWorker(workerDb, payload, jobId, cancelToken) {
    const { monthKey, storageRoot, chunkSize, resumeFromRun, workerCount, tempDir, __forceMultiWorkerForTest } = payload || {};
    const batchContext = freezeWorkerBatchContext(payload && payload.batchContext);
    if (!monthKey) {
      throw new Error('runCheckInWorker：monthKey 必填');
    }
    const session = require('./acquiring-bill-currency-session');
    const onProgress = (ev) => {
      try {
        parentPort.postMessage({ type: 'progress', jobId, payload: ev });
      } catch (_e) { /* swallow */ }
    };
    // T13：cancel 启动前快路径
    if (cancelToken && cancelToken.cancelled) {
      // 用 session.CancelError 保持错误类型统一（caller 按 err.name='CancelError' 识别）
      const CancelErrorCtor = session.CancelError || Error;
      throw new CancelErrorCtor('runCheck cancelled before start', { stage: 'before-start' });
    }
    // T13：cancelToken 直接透传 — runCheckCore 内 5 阶段间自己 check + ROLLBACK + throw
    // T18 / T19：chunkSize + resumeFromRun 透传（undefined 兼容旧 caller — runCheckCore 内 default 处理）
    // v2.1.12 β.1-T3：workerCount/tempDir 透传 + dbPath=workerDbPath（多 worker nested 子 worker open 只读连接）
    //   undefined workerCount → runCheckCore 默认单 worker（现有调用零行为变化）
    return await session.runCheckCore({
      db: workerDb,
      monthKey,
      storageRoot,
      onProgress,
      cancelToken,
      chunkSize,
      resumeFromRun,
      workerCount,
      dbPath: workerDbPath,
      tempDir,
      batchContext,
      __forceMultiWorkerForTest,
    });
  }

  // ── 主消息循环 ──
  let workerDb = null;
  let workerDbPath = null; // v2.1.12 β.1-T3：init 时存 dbPath，多 worker nested 子 worker open 只读连接复用
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
        workerDbPath = dbPath; // v2.1.12 β.1-T3：存 dbPath 供多 worker nested 子 worker 复用
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
        // v2.1.10 T13：cancelToken 用 session.createCancelToken 工厂构造（带 throwIfCancelled 接口）
        //   - 'cancel' message 收到 → token.cancel() → cancelled = true
        //   - runCheckCore 5 阶段间 check cancelled → safeRollback + throw CancelError
        const session = require('./acquiring-bill-currency-session');
        const cancelToken = session.createCancelToken
          ? session.createCancelToken()
          : { cancelled: false, cancel() { this.cancelled = true; } };
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
          // v2.1.10 T13：用 cancel() 方法（兼容工厂构造的 token 和兜底 plain object）
          if (typeof activeJob.cancelToken.cancel === 'function') {
            activeJob.cancelToken.cancel();
          } else {
            activeJob.cancelToken.cancelled = true;
          }
        }
        return;
      }

      if (type === 'close') {
        try { if (workerDb) workerDb.close(); } catch (_e) { /* swallow */ }
        process.exit(0);
      }

      // v2.1.10 A3 Phase 2 T14：测试专用 — 模拟 worker crash（process.exit(非 0)）
      //   仅供 unit / integration test 验证 crash recover 路径；生产代码不发此 message
      //   不写 worker DB 关闭：让 DB 连接 leak 模拟硬崩
      if (type === '__crash_for_test__') {
        const code = (msg && typeof msg.code === 'number') ? msg.code : 1;
        process.exit(code);
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
