// v2.1.10 A3 Phase 1 T07 — runCheck worker pool 管理（单 worker）
//
// 设计选型（PM/Dev 自决）：
//   - 单 worker，不做并发 pool（spec §2.1.1 + business — runCheck 同 monthKey 已有 op lock 互斥）
//     多 worker 留 v2.1.11+，配合 N1' idle cleanup 跨 worker 协调一起设计
//   - lazy init，不做 pre-warm（POC surprise #3：cold-start 仅 11ms 时可放宽 — 节约启动开销）
//     首次 dispatchRunCheck 时启动 worker；后续复用同一 worker
//   - jobId：timestamp + 随机数（无需 uuid 依赖；冲突概率可忽略）
//
// crash recovery（spec §2.1.3）：
//   - worker 'error' 事件：reject 当前 job + 标记 workerInstance=null + 下次 dispatch 时 cold-start 重启
//   - worker 'exit' 事件（非正常）：同上
//   - 主进程 quit：shutdown() 调 worker.terminate() 等 close
//
// 进程边界（spec §1.2）：
//   - Notification + op lock 释放 + idle timer 通知留主进程 IPC handler（T10）做
//   - 本 pool 只负责：dispatch / cancel / shutdown / status；不调 Electron API
//   - 'log' message → forward 到 caller 回调（caller 是 main.js IPC handler → appendActivityLogEntry）
//
// callbacks 协议（dispatchRunCheck 参数）：
//   {
//     onProgress: (ev) => void,  // worker progress 事件透传
//     onLog: (entry) => void,    // worker log 事件透传（caller 调 appendActivityLogEntry）
//   }
//
// 单例导出：模块顶层维护 workerInstance / activeJob 状态，require 多次仍同 instance。

'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT_PATH = path.join(__dirname, 'run-check-worker.js');

// ─────────────────────────────────────────────────────────────────
// 模块级状态（单例 worker）
// ─────────────────────────────────────────────────────────────────
let workerInstance = null;     // 当前 worker 实例（null = 未启动 / 已 crash）
let workerInitPromise = null;  // 启动期 promise（避免并发 dispatch 触发多次 cold-start）
let workerDbPath = null;       // 记 init 时传的 dbPath（重启时复用）
let activeJob = null;          // { jobId, resolve, reject, onProgress, onLog }
// v2.1.10 Phase 2 T12 — Phase 1 surprise #1 mitigate（spec §2.3.2）：
//   isBusy() 仅反映 activeJob 槽位；worker 内 DB 事务结束可能滞后 isBusy() 翻转
//   → idle cleanup timer 必须 30s grace 内不触发，防与 worker 残留事务抢写锁
//   每次 done / reject / crash 都更新 lastBusyEndTs；初始 0（不参与判断）
let lastBusyEndTs = 0;
// v2.1.10 Phase 2 T14 — worker failure 监听器（Notification + op lock 释放交给主进程）
//   pool 不直接调 Electron API，而是 emit 通知；caller (main.js) 注册回调
let failureListener = null;    // (info: { source, message, cause }) => void

// ─────────────────────────────────────────────────────────────────
// jobId 生成（timestamp + 6 位随机；够低冲突概率 + 无外部依赖）
// ─────────────────────────────────────────────────────────────────
function generateJobId() {
  return `job-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────────
// 启动单例 worker + init
// ─────────────────────────────────────────────────────────────────
function coldStartWorker(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('coldStartWorker：dbPath 必填');
  }
  const worker = new Worker(WORKER_SCRIPT_PATH);
  workerDbPath = dbPath;

  // 'error' / 'exit' 事件 → crash recovery
  worker.on('error', (err) => {
    handleWorkerFailure(worker, err, 'error');
  });
  worker.on('exit', (code) => {
    // 正常 close (code=0) 时也清掉 activeJob 引用避免泄漏；异常 (≠0) 走 failure 路径
    if (code !== 0) {
      handleWorkerFailure(worker, new Error(`worker exit code=${code}`), 'exit');
    } else if (activeJob) {
      // 正常退出但还有 active job — 当作异常处理（极少触发：用户 close before done）
      handleWorkerFailure(worker, new Error('worker exited before job done'), 'exit');
    } else if (workerInstance === worker) {
      workerInstance = null;
      workerInitPromise = null;
    }
  });

  // 'message' 事件 → 按 type 分派
  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    if (type === 'progress') {
      if (activeJob && activeJob.jobId === msg.jobId && typeof activeJob.onProgress === 'function') {
        try { activeJob.onProgress(msg.payload); } catch (_e) { /* swallow */ }
      }
      return;
    }
    if (type === 'log') {
      if (activeJob && typeof activeJob.onLog === 'function') {
        try { activeJob.onLog(msg.entry); } catch (_e) { /* swallow */ }
      }
      return;
    }
    if (type === 'done') {
      if (activeJob && activeJob.jobId === msg.jobId) {
        const job = activeJob;
        activeJob = null;
        // v2.1.10 Phase 2 T12 — 记录 busy 结束时间（spec §2.3.2 grace 30s）
        lastBusyEndTs = Date.now();
        try { job.resolve(msg.result); } catch (_e) { /* swallow */ }
      }
      return;
    }
    if (type === 'error') {
      if (activeJob && activeJob.jobId === msg.jobId) {
        const job = activeJob;
        activeJob = null;
        // v2.1.10 Phase 2 T12 — 记录 busy 结束时间（spec §2.3.2 grace 30s）
        lastBusyEndTs = Date.now();
        try { job.reject(deserializeFromMessage(msg.error)); } catch (_e) { /* swallow */ }
      }
      return;
    }
    // init-done / init-error 由 initPromise 接管，不在这里处理
  });

  workerInstance = worker;
  return worker;
}

// 失败处理（worker error / exit 非 0）
function handleWorkerFailure(failedWorker, err, source) {
  // 仅处理"当前活跃 worker"的失败（防过期事件）
  if (workerInstance !== failedWorker) return;
  workerInstance = null;
  workerInitPromise = null;
  const hadActiveJob = !!activeJob;
  let wrappedErr = null;
  if (activeJob) {
    const job = activeJob;
    activeJob = null;
    // v2.1.10 Phase 2 T12 — crash 也更新 lastBusyEndTs（spec §2.3.2 grace 30s）
    lastBusyEndTs = Date.now();
    // 给 caller 透传 error，附带 source（'error' / 'exit'）便于诊断
    wrappedErr = new Error(
      `worker ${source} 异常：${err && err.message ? err.message : String(err)}`
    );
    wrappedErr.cause = err;
    wrappedErr.workerFailureSource = source;
    try { job.reject(wrappedErr); } catch (_e) { /* swallow */ }
  }
  // v2.1.10 Phase 2 T14 — 通知主进程：释放 op lock + Notification + 下次 dispatch cold-start
  //   pool 不直接 require electron / op lock 模块（保持模块独立可 unit test）
  //   caller (main.js) 通过 setFailureListener 注册回调
  if (failureListener) {
    try {
      failureListener({
        source, // 'error' | 'exit'
        message: err && err.message ? err.message : String(err),
        cause: err,
        hadActiveJob,
        wrappedError: wrappedErr, // null when no active job
      });
    } catch (_e) { /* swallow — listener 抛错不阻塞 pool 状态恢复 */ }
  }
}

// 反序列化 message 中的 error（T08 落地后切到 ./serialize-error.deserializeError）
function deserializeFromMessage(serialized) {
  if (!serialized) return new Error('worker unknown error');
  try {
    const helper = require('./serialize-error');
    return helper.deserializeError(serialized);
  } catch (_e) {
    // T07 阶段 serialize-error.js 可能未落地 — 内联兜底
    const err = new Error(serialized.message || 'unknown');
    if (serialized.name) err.name = serialized.name;
    if (serialized.stack) err.stack = serialized.stack;
    if (serialized.code) err.code = serialized.code;
    if (serialized.detailLines) err.detailLines = serialized.detailLines;
    if (serialized.context) err.context = serialized.context;
    return err;
  }
}

// init worker（cold-start + 发 init message + 等 init-done）
function ensureInitialized(dbPath) {
  if (workerInstance && workerInitPromise) {
    // 已 init 完毕（init-done 时 workerInitPromise 已 resolve）→ 复用
    return workerInitPromise;
  }
  if (!workerInstance) {
    coldStartWorker(dbPath);
  }
  workerInitPromise = new Promise((resolve, reject) => {
    const w = workerInstance;
    if (!w) return reject(new Error('worker cold-start 失败'));
    const onInitMsg = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init-done') {
        w.off('message', onInitMsg);
        resolve(msg.pragmaValues);
      } else if (msg.type === 'init-error') {
        w.off('message', onInitMsg);
        reject(deserializeFromMessage(msg.error));
      }
    };
    w.on('message', onInitMsg);
    w.postMessage({ type: 'init', dbPath });
  });
  return workerInitPromise;
}

// ─────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────

// dispatchRunCheck — 主进程 IPC handler 调用入口
//   payload: { monthKey, storageRoot }
//   callbacks: { onProgress(ev), onLog(entry) }
//   return: Promise<runCheckResult> — 解 done.result / 拒 worker error
async function dispatchRunCheck(payload, callbacks = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('dispatchRunCheck：payload 必填');
  }
  // dbPath 必须有 — 否则 worker init 不了
  // caller (main.js IPC handler) 应从 database.dbPath 传入；T10 阶段做参数对接
  const dbPath = payload.__dbPath || workerDbPath;
  if (!dbPath) {
    throw new Error('dispatchRunCheck：dbPath 未设置（caller 应传 payload.__dbPath 或先调 preWarm）');
  }
  if (activeJob) {
    throw new Error('worker 正忙（业务侧已有 op lock 防御 — 此处理应不可达）');
  }

  await ensureInitialized(dbPath);

  const jobId = generateJobId();
  const jobPromise = new Promise((resolve, reject) => {
    activeJob = {
      jobId,
      resolve,
      reject,
      onProgress: typeof callbacks.onProgress === 'function' ? callbacks.onProgress : null,
      onLog: typeof callbacks.onLog === 'function' ? callbacks.onLog : null,
    };
  });
  // v2.1.10 A4 T18 / T19：payload 透传 chunkSize + resumeFromRun
  //   - chunkSize：caller (main.js IPC handler) 从 settings 注入；undefined 时 runCheckCore 用 default 100000
  //   - resumeFromRun：{ runId, lastCompletedChunkIndex }；undefined 时全新 run（默认 path）
  workerInstance.postMessage({
    type: 'run',
    jobId,
    payload: {
      monthKey: payload.monthKey,
      storageRoot: payload.storageRoot,
      chunkSize: payload.chunkSize,
      resumeFromRun: payload.resumeFromRun,
    },
  });
  return jobPromise;
}

// cancel — 取消当前 job（worker 内 graceful 退出）
//   仅设 cancelFlag，不强制 terminate；worker 内下个 cancelToken check 点自然抛 CancelError
//   T13 已配合 runCheckCore 内 cancelToken 5 阶段间检查（spec §2.1.3 + spec §3.2 chunked cancel）
//
// v2.1.10 Phase 2 T13 — hard terminate fallback：
//   - cancel 后 hardTimeoutMs（默认 5000ms）内 worker 仍未 exit / done / reject → terminate
//   - 防 worker 内死循环（如 SQL 卡死 / 死锁）导致 main 端永远拿不到 reject
function cancel(jobId, options = {}) {
  if (!workerInstance) return false;
  if (!activeJob) return false;
  if (jobId && activeJob.jobId !== jobId) return false;
  const targetJobId = activeJob.jobId;
  const hardTimeoutMs = typeof options.hardTimeoutMs === 'number' ? options.hardTimeoutMs : 5000;
  try {
    workerInstance.postMessage({ type: 'cancel', jobId: targetJobId });
  } catch (_e) {
    return false;
  }
  // hard timeout — 5s 内 activeJob 仍未释放则 terminate（pool message handler 监听 done/error 会清 activeJob）
  if (hardTimeoutMs > 0) {
    setTimeout(() => {
      // 只有 activeJob 仍是同一个 jobId 才 terminate（防 done/error 已正常完成）
      if (activeJob && activeJob.jobId === targetJobId && workerInstance) {
        const w = workerInstance;
        try { w.terminate(); } catch (_e) { /* swallow — exit handler 接管 */ }
        // exit handler 会 reject activeJob + 调 failureListener
      }
    }, hardTimeoutMs);
  }
  return true;
}

// pre-warm — 显式预热（T10 IPC handler 可选调用；POC surprise #3 表明非必需）
async function preWarm(dbPath) {
  if (!dbPath) throw new Error('preWarm：dbPath 必填');
  await ensureInitialized(dbPath);
}

// shutdown — 主进程 quit 前调用；关闭 worker + 等 exit
//   若 activeJob 仍在挂着，主动 reject（防 caller pending Promise 变 unhandled rejection）
async function shutdown(timeoutMs = 5000) {
  if (!workerInstance) return;
  const w = workerInstance;
  // 主动 reject 任何 pending job — 防 unhandled rejection
  if (activeJob) {
    const job = activeJob;
    activeJob = null;
    try {
      const err = new Error('worker pool 已 shutdown，pending job 被主动中断');
      err.code = 'WORKER_POOL_SHUTDOWN';
      job.reject(err);
    } catch (_e) { /* swallow */ }
  }
  const exitPromise = new Promise((resolve) => {
    w.on('exit', () => resolve());
  });
  try { w.postMessage({ type: 'close' }); } catch (_e) { /* swallow */ }
  // 等 exit；超时直接 terminate
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
  });
  await Promise.race([exitPromise, timeoutPromise]);
  if (timedOut) {
    try { await w.terminate(); } catch (_e) { /* swallow */ }
  }
  workerInstance = null;
  workerInitPromise = null;
  activeJob = null;
}

// isBusy — 主进程 idle timer 协调使用（Phase 2 T12 接入；spec §2.3.2）
//   ⚠️ 仅反映 activeJob 槽位；worker DB 事务结束可能滞后 isBusy() 翻转
//   → caller 需结合 getLastBusyEndTs() 做 30s grace 判断
function isBusy() {
  return !!activeJob;
}

// v2.1.10 Phase 2 T12 — Phase 1 surprise #1 mitigate（spec §2.3.2 grace 30s）
//   返回上次 worker busy 结束的 timestamp（ms）；初始 0
//   caller（main.js setupIdleCleanupTimer）判断 Date.now() - getLastBusyEndTs() < 30000 时 skip cleanup
function getLastBusyEndTs() {
  return lastBusyEndTs;
}

// v2.1.10 Phase 2 T14 — 注册 worker failure 监听器
//   caller (main.js) 负责：释放 op lock + Electron Notification + activity log
//   pool 自身不调 Electron API，保持模块独立可在 Node 直跑 unit test
function setFailureListener(fn) {
  if (fn !== null && typeof fn !== 'function') {
    throw new Error('setFailureListener：参数必须是 function 或 null');
  }
  failureListener = fn;
}

// getStatus — 调试 / unit test 用
function getStatus() {
  return {
    workerAlive: !!workerInstance,
    initialized: !!(workerInstance && workerInitPromise),
    busy: !!activeJob,
    activeJobId: activeJob ? activeJob.jobId : null,
    dbPath: workerDbPath,
    lastBusyEndTs,
  };
}

// __reset_for_test__ — 仅 unit test 用，清模块级状态防 case 间污染
async function __reset_for_test__() {
  await shutdown(1000);
  workerInstance = null;
  workerInitPromise = null;
  workerDbPath = null;
  activeJob = null;
  lastBusyEndTs = 0;
  failureListener = null;
}

// v2.1.10 A3 Phase 2 T14 — __test_only_post__：测试专用，给当前 worker 发一条 raw message
//   生产代码不应调用（dispatchRunCheck / cancel / preWarm / shutdown 已覆盖所有正常路径）
//   仅集成 / unit test 用于注入 `__crash_for_test__` 等测试 message
function __test_only_post__(msg) {
  if (!workerInstance) throw new Error('__test_only_post__：worker 未启动');
  workerInstance.postMessage(msg);
}

module.exports = {
  dispatchRunCheck,
  cancel,
  preWarm,
  shutdown,
  isBusy,
  getLastBusyEndTs,
  setFailureListener,
  getStatus,
  __reset_for_test__,
  __test_only_post__,
};
