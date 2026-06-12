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

// v2.1.10 SR-FIX-1 Round 6 H3：测试专用 — 允许 unit test 注入备用 worker script（如人为模拟 init 期 crash）
//   生产代码不应调用；仅 __test_only_set_worker_script__ 显式注入测试 fixture
let workerScriptOverride = null;
function resolveWorkerScript() {
  return workerScriptOverride || WORKER_SCRIPT_PATH;
}

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
  const worker = new Worker(resolveWorkerScript());
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
        // v2.1.10 SR-FIX-1 Round 4 F2：shutdown 已 reject promise — 跳过二次 resolve
        if (job.shutdownPending) return;
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
        // v2.1.10 SR-FIX-1 Round 4 F2：shutdown 已 reject promise — 跳过二次 reject
        if (job.shutdownPending) return;
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
    // v2.1.10 SR-FIX-1 Round 4 F2：shutdown 已 reject — 跳过二次 reject 防 UnhandledPromiseRejection
    //   shutdown 路径下 job.shutdownPending=true；reject 已经发生
    //   仍走 failureListener 通知主进程兜底 in-progress → partial
    if (!job.shutdownPending) {
      try { job.reject(wrappedErr); } catch (_e) { /* swallow */ }
    }
  }
  // v2.1.10 Phase 2 T14 — 通知主进程：释放 op lock + Notification + 下次 dispatch cold-start
  //   pool 不直接 require electron / op lock 模块（保持模块独立可 unit test）
  //   caller (main.js) 通过 setFailureListener 注册回调
  //
  // v2.1.10 SR-FIX-1 Round 4 F2：shutdown 路径下 hadActiveJob=true → failureListener 兜底执行
  //   main.js failureListener 内调 setRunChunkProgress(runId, ..., 'partial')
  //   防 first-chunk crash + before-quit shutdown 双重路径残留 in-progress
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
//
// v2.1.10 SR-FIX-1 Round 6 H3：init 期 worker error / exit 接入 init promise reject + timeout 兜底
//   触发场景（Codex Round 5 四复审 P1 finding，2026-05-28T11:38）：
//     如果 worker 在 init-done / init-error 之前就 exit / error（如 packaged path 错 / module-load failure /
//     node:sqlite 启动失败 / 系统级 SIGKILL），原 onInitMsg listener 永远不被触发；handleWorkerFailure
//     只 reset 模块级状态但**不 reject 当前 workerInitPromise** → ensureInitialized 永远 hang
//     → 第一次 dispatchRunCheck 永远不返回 → 用户必须重启 app
//   修复：
//     1. init promise 内额外 once('error') / once('exit') 监听器 → reject + reset 模块级状态
//     2. 加 10s init timeout 兜底（防 worker 启动卡死无 exit/error 信号 — 极端情况）
//     3. init-done / init-error / error / exit / timeout 五路径互斥（任一触发即清 timeout + 其他 listener）
//   不变量：
//     - 任意失败路径都 reject promise + reset 模块级状态 → 下次 dispatchRunCheck 自动 cold-start
//     - module-level worker.on('error') / on('exit') 仍照常触发 handleWorkerFailure（多 listener 互不冲突）
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

    // 互斥 settle 保护：任一路径触发后清 timeout + 移除其他 listener
    let settled = false;
    let initTimeout = null;

    const cleanup = () => {
      if (initTimeout) { clearTimeout(initTimeout); initTimeout = null; }
      try { w.off('message', onInitMsg); } catch (_e) { /* swallow */ }
      try { w.off('error', onInitError); } catch (_e) { /* swallow */ }
      try { w.off('exit', onInitExit); } catch (_e) { /* swallow */ }
    };

    const safeReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 失败统一 reset 模块级状态：下次 dispatch 自动 cold-start
      workerInitPromise = null;
      if (workerInstance === w) workerInstance = null;
      reject(err);
    };

    const safeResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onInitMsg = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init-done') {
        safeResolve(msg.pragmaValues);
      } else if (msg.type === 'init-error') {
        // v2.1.10 SR-FIX-1 round 2 P0-2：reset 模块级状态 + terminate worker
        //   修复前：仅 reject promise → workerInstance / workerInitPromise 仍引用 dead worker
        //     下次 dispatchRunCheck 调 ensureInitialized → 直接 return 已 rejected promise
        //     → 永久 brick 主进程 runCheck 能力（必须重启 app）
        //   修复后：reset + terminate → 下次 dispatchRunCheck 触发 cold-start（spec §2.1.3 异常恢复）
        //   Round 6 H3：reset 逻辑由 safeReject 统一处理；terminate 仍保留（init-error 是受控失败）
        try { w.terminate(); } catch (_e) { /* swallow — exit handler 接管 */ }
        safeReject(deserializeFromMessage(msg.error));
      }
    };

    // v2.1.10 SR-FIX-1 Round 6 H3：init 期 worker 'error' / 'exit' 接入 init promise reject
    //   注：module-level worker.on('error') / on('exit')（coldStartWorker 注册）仍会触发 handleWorkerFailure
    //     handleWorkerFailure 内会 workerInstance = null / workerInitPromise = null（与 safeReject 重复但幂等）
    //     listener 顺序：node 触发 error/exit 时按注册顺序回调；safeReject 内 settled 检查防双重 reject
    const onInitError = (err) => {
      safeReject(new Error(`worker init 期 error 事件：${err && err.message ? err.message : String(err)}`));
    };
    const onInitExit = (code) => {
      if (code !== 0) {
        safeReject(new Error(`worker init 期意外 exit（code=${code}）`));
      } else {
        // exit code=0 但 init 未完成 — 罕见但仍是失败
        safeReject(new Error('worker init 期 exit code=0 但未发 init-done'));
      }
    };

    w.on('message', onInitMsg);
    w.once('error', onInitError);
    w.once('exit', onInitExit);

    // 10s timeout 兜底（极端：worker 启动卡死无任何信号）
    initTimeout = setTimeout(() => {
      try { w.terminate(); } catch (_e) { /* swallow */ }
      safeReject(new Error('worker init 超时（10s）— 强制 terminate'));
    }, 10000);

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

  // v3.0.5 PR-3（Part B Phase 1）：per-月侧库 dbPath 切换 —— worker init 时绑定单一 dbPath；
  //   若本次 dispatch 的目标侧库 dbPath 与已 init 的 worker dbPath 不同（用户切月 / 不同月对账），
  //   必须先关掉旧 worker，让 ensureInitialized 重新 cold-start 绑定新侧库（侧库 init 仅 ~11ms+PRAGMA，
  //   开销可忽略；不复用旧连接，避免在错误的侧库文件上跑 runCheck — 资金红线）。
  //   ⚠️ 主库时代 dbPath 恒为主库路径，此分支永不触发（workerDbPath===dbPath）→ 零行为变化。
  if (workerInstance && workerDbPath && workerDbPath !== dbPath) {
    await shutdown(5000);
    // shutdown 已清 workerInstance / workerInitPromise / workerDbPath；ensureInitialized 触发 cold-start
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
  // v2.1.12 β.1-T3：透传 workerCount + tempDir（多 worker write-splitting；undefined→runCheckCore 默认单 worker）
  //   - dbPath 不透传：worker init 时已存 workerDbPath，nested 子 worker 复用之（避免重复传）
  //   - __forceMultiWorkerForTest：仅集成/单测用（强制走多 worker 跳过 D31 性能闸）；生产 caller 不传
  workerInstance.postMessage({
    type: 'run',
    jobId,
    payload: {
      monthKey: payload.monthKey,
      storageRoot: payload.storageRoot,
      chunkSize: payload.chunkSize,
      resumeFromRun: payload.resumeFromRun,
      workerCount: payload.workerCount,
      tempDir: payload.tempDir,
      __forceMultiWorkerForTest: payload.__forceMultiWorkerForTest,
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
//   若 activeJob 仍在挂着，主动 reject caller promise（防 unhandled rejection）
//
// v2.1.10 SR-FIX-1 Round 4 F2：shutdown 不抹 activeJob 状态
//   修复前（Round 3 / round 2 P0-3 留下）：if (activeJob) { ...job.reject; activeJob=null; }
//     问题：reject 后立即 activeJob=null → 后续 worker exit/terminate 触发 handleWorkerFailure 时
//       看到 hadActiveJob=false → failureListener 不执行 in-progress → partial 兜底 →
//       run.chunk_progress 残留 'in-progress' → 制造 Round 4 F1 修复的场景（first-chunk crash 残留路径）
//   修复后（Round 4 F2）：
//     - 仍 reject caller promise（防 unhandled rejection — caller pending Promise 必须 settle）
//     - 但 activeJob 留着 — 让后续 worker exit/terminate 触发 handleWorkerFailure 时 hadActiveJob=true
//       → failureListener 调用（main.js setFailureListener 注册的回调） → 把 in-progress 兜底转 partial
//     - 加 shutdownPending 标记 — 让 message handler 在 done/error 到来时判断 "shutdown 已 reject，跳过二次 reject/resolve"
//   注：close → exit 路径走的是 worker 'exit' 事件 → handleWorkerFailure(source='exit')
//        terminate 路径走 'exit' 事件（code 非 0）→ handleWorkerFailure(source='exit')
//        两路径都会触发 failureListener — Round 4 F2 修复后 hadActiveJob=true → main.js 兜底执行
async function shutdown(timeoutMs = 5000) {
  if (!workerInstance) return;
  const w = workerInstance;
  // 主动 reject 任何 pending job — 防 unhandled rejection
  // Round 4 F2：不抹 activeJob — 让 handleWorkerFailure 看到 hadActiveJob=true，failureListener 能兜底
  if (activeJob) {
    try {
      const err = new Error('worker pool 已 shutdown，pending job 被主动中断');
      err.code = 'WORKER_POOL_SHUTDOWN';
      activeJob.reject(err);
    } catch (_e) { /* swallow */ }
    // 标记 shutdown 已 reject — 防 done/error message 到来时二次 settle caller promise
    //   handleWorkerFailure 仍会调 failureListener 兜底（不依赖此标记）
    //   message handler 用 shutdownPending 跳过 done/error 的 reject/resolve（promise 已 reject）
    activeJob.shutdownPending = true;
    // 注：activeJob 不抹 — workerInstance 也保留，让 exit 事件能正常派发到 handleWorkerFailure
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
  // exit 事件处理后 workerInstance / activeJob 已被 handleWorkerFailure 清空（hadActiveJob=true 路径）
  //   或 'exit' 正常路径（activeJob 已被 done message 清）— 这里兜底再清一遍防泄漏
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

// v2.1.10 SR-FIX-1 Round 6 H3 — __test_only_set_worker_script__：测试专用 — 注入备用 worker script
//   仅 unit test 用于模拟"init 期 worker 立即 exit/error"路径（如指向一个 process.exit(1) 的 fixture）
//   生产代码不应调用；传 null 恢复默认
function __test_only_set_worker_script__(scriptPath) {
  workerScriptOverride = scriptPath || null;
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
  __test_only_set_worker_script__,
};
