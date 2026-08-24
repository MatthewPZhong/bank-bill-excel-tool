// 通用大表导入引擎 — pipeline（多文件并行解析调度 · 运行于持 DB 的一侧）🔴 资金红线（按文件序单写 = rowid 顺序契约）
//
// 职责（spec §2.2 拓扑 + §七 内存闸）：
//   起 N 个解析子 worker（import-worker.js）做**文件级并行**解析，主侧维护单写循环——
//   严格按文件 index 顺序把各文件的行批交给调用方注入的 writeBatch（INSERT）。
//
// 🔴 按文件序单写（rowid 顺序 = 串行导入 byte-for-byte 的关键，spec §2.2）：
//   解析完成顺序乱无妨；写入侧用 nextWriteIndex 游标 + 乱序结果缓存（Map<index, parsed>），
//   只有当 results.has(nextWriteIndex) 时才消费该文件全部行 INSERT，再 nextWriteIndex++。
//   → 文件 i 的全部行恒先于 i+1 INSERT → 表内 rowid 顺序与现状「串行逐文件导入」完全一致。
//   绝不改成「完成序写入」（那会让 rowid 顺序随 worker 完成时序漂移，破 byte-for-byte 口径）。
//
// 缓冲策略 v1（spec §2.2）：每文件解析产物全量缓冲后整体交写入侧（白名单裁剪后行负载小）。
//   message+ack 流式背压留 v2（500w 实测后再评估）。
//
// 内存闸（spec §七 / D33 同款）：启动时 os.freemem() < 2GB → 并行度降 1（最低 1），写一条日志说明。
//
// cancel（spec §2.2）：cancel() → terminate 全部解析子 worker + 置 cancelled 标志，
//   让写循环在下个文件边界抛 CancelError；调用方（engine）据此 ROLLBACK。语义对齐现有 CancelError 模式。
//
// 约束：本文件不得 require 任何业务模块；引擎自包含。worker 路径用 path.join(__dirname, ...)（asar 场景）。

'use strict';

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// 引擎自带 CancelError（不 require 收单 session；语义对齐 acquiring-bill-currency-session.CancelError——
//   调用方按 err.name === 'CancelError' 识别，跨线程 instanceof 不可靠故用 name）。
class CancelError extends Error {
  constructor(message, options = {}) {
    super(message || '导入已取消');
    this.name = 'CancelError';
    if (options.stage) this.stage = options.stage;
  }
}

// 引擎自带错误类（与 zip-reader.BigTableImportError 同形态，避免循环 require）。
class PipelineError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'BigTableImportError';
    this.detailLines = detailLines;
  }
}

const WORKER_SCRIPT_PATH = path.join(__dirname, 'import-worker.js');

// 内存闸阈值：freemem < 2GB → 降并行度 1（spec §七 / D33）。
const FREEMEM_GATE_BYTES = 2 * 1024 * 1024 * 1024;

// 计算有效并行度（maxParallel 默认 min(4, cpus-2)，下限 1；内存闸再降 1）。
//   抽成纯函数便于单测（mock os.freemem / os.cpus 后验证边界）。
function computeMaxParallel({ requested, fileCount, freemem, cpuCount, onLog } = {}) {
  const cpus = Number.isInteger(cpuCount) && cpuCount > 0 ? cpuCount : os.cpus().length;
  // 默认上限 min(4, cpus-2)，下限 1。
  let base = Number.isInteger(requested) && requested > 0
    ? requested
    : Math.min(4, cpus - 2);
  if (!Number.isFinite(base) || base < 1) base = 1;
  // 不超过文件数（多起的 worker 无文件可派）。
  if (Number.isInteger(fileCount) && fileCount > 0 && base > fileCount) base = fileCount;

  // 内存闸：freemem < 2GB → 降 1（最低 1）。
  const fm = Number.isFinite(freemem) ? freemem : os.freemem();
  if (fm < FREEMEM_GATE_BYTES && base > 1) {
    const lowered = base - 1;
    if (typeof onLog === 'function') {
      onLog({
        level: 'warning',
        message: `[big-table-import] 可用内存 ${(fm / 1024 / 1024 / 1024).toFixed(2)}GB < 2GB，并行度降级 ${base} → ${lowered}`
      });
    }
    base = lowered < 1 ? 1 : lowered;
  }
  return base;
}

// 多文件并行解析 + 按文件序单写。
//   入参：
//     files               — string[] 文件绝对路径（写入顺序 = 数组顺序，rowid 顺序契约）
//     contractModulePath  — 契约模块路径（worker require）
//     contractOptions     — 契约工厂入参（可序列化）
//     useWhitelist        — false 时强制全列解码（byte-for-byte 对照组）；默认 true（走契约白名单）
//     writeBatch          — (fileIndex, parsed) => void  调用方注入的写入回调（持 DB，按序调用；
//                           parsed = { batch, errors, importedCount, rowErrorTotal, truncated, monthKeys, headerError }）
//                           writeBatch 内部可抛错（如整批拒绝 / 跨月）→ 终止 pipeline、拒绝 promise。
//     parallel            — 期望并行度（默认 min(4, cpus-2)）
//     parallelFrozen      — true 表示 parallel 已由 CompoundLease admission 冻结，不再重复内存闸
//     onProgress          — ({ sourceFile, importedCount }) 透传（worker 每 1w 行；engine 再节流到对外形状）
//     onLog               — ({ level, message }) 日志透传（内存闸等）
//     cancelToken         — { cancelled } 可选；置位后写循环在文件边界抛 CancelError
//   返回 Promise<{ maxParallel, totalImported }>。
//   暴露 cancel()：见 runPipeline 返回的 controller。
function runPipeline({
  files,
  contractModulePath,
  contractOptions,
  batchContext,
  useWhitelist,
  writeBatch,
  parallel,
  parallelFrozen,
  onProgress,
  onLog,
  cancelToken
}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { promise: Promise.reject(new PipelineError('pipeline：files 必须是非空数组')), cancel() {} };
  }
  if (typeof writeBatch !== 'function') {
    return { promise: Promise.reject(new PipelineError('pipeline：writeBatch 必填（持 DB 的单写回调）')), cancel() {} };
  }

  const fileCount = files.length;
  const maxParallel = computeMaxParallel({
    requested: parallel,
    fileCount,
    // mature adapter 已在 admission 前按同一函数完成内存闸并冻结 topology；
    // 获批 childCount 不得在 engine 内二次降级，也不得重新扩容。
    freemem: parallelFrozen === true ? Number.MAX_SAFE_INTEGER : os.freemem(),
    cpuCount: os.cpus().length,
    onLog
  });

  // 调度状态
  const workers = [];                 // 活跃解析子 worker 实例
  let nextDispatchIndex = 0;          // 下一个待派发文件 index
  let nextWriteIndex = 0;             // 下一个待写入文件 index（rowid 顺序游标）
  const parsedResults = new Map();    // 乱序到达缓存：fileIndex → parsed
  const workerFileMap = new Map();    // worker → 当前在解析的 fileIndex（cancel/异常诊断）
  let cancelled = false;
  let settled = false;
  let totalImported = 0;
  const jobId = `btie-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  let resolveOuter, rejectOuter;
  const promise = new Promise((res, rej) => { resolveOuter = res; rejectOuter = rej; });

  function terminateAllWorkers() {
    for (const w of workers) {
      try { w.terminate(); } catch (_e) { /* swallow */ }
    }
    workers.length = 0;
  }

  function finish(err) {
    if (settled) return;
    settled = true;
    terminateAllWorkers();
    if (err) rejectOuter(err);
    else resolveOuter({ maxParallel, totalImported });
  }

  function fail(err) {
    finish(err);
  }

  // 检查 cancelToken（engine 透传的外部取消信号）；置位 → 等价 cancel()。
  function checkExternalCancel() {
    if (cancelToken && cancelToken.cancelled && !cancelled) {
      cancelled = true;
    }
  }

  // 按文件序消费已缓存的解析结果（rowid 顺序写入）。
  //   只要 parsedResults 有 nextWriteIndex → 调 writeBatch 写该文件全部行 → nextWriteIndex++ → 继续。
  function drainWrites() {
    if (settled) return;
    checkExternalCancel();
    while (parsedResults.has(nextWriteIndex)) {
      // cancel 在文件边界生效：写下一个文件前若已取消 → 抛 CancelError（让 engine ROLLBACK）。
      if (cancelled) {
        fail(new CancelError('导入已取消（pipeline 写循环文件边界）', { stage: 'pipeline-write' }));
        return;
      }
      const idx = nextWriteIndex;
      const parsed = parsedResults.get(idx);
      parsedResults.delete(idx);
      try {
        writeBatch(idx, parsed);   // 🔴 持 DB 的单写：按文件序 INSERT（调用方实现，可抛整批拒绝/跨月错）
      } catch (writeErr) {
        fail(writeErr);
        return;
      }
      totalImported += parsed.importedCount || 0;
      nextWriteIndex += 1;
    }
    // 全部文件已写完 → 成功收尾。
    if (nextWriteIndex >= fileCount) {
      finish(null);
    }
  }

  // 给一个空闲 worker 派发下一个待解析文件（若有）。
  function dispatchNext(worker) {
    if (settled || cancelled) return;
    if (nextDispatchIndex >= fileCount) return;   // 没有更多文件
    const fileIndex = nextDispatchIndex;
    nextDispatchIndex += 1;
    workerFileMap.set(worker, fileIndex);
    try {
      worker.postMessage({
        type: 'parse',
        jobId,
        fileIndex,
        filePath: files[fileIndex],
        contractModulePath,
        contractOptions,
        batchContext,
        useWhitelist: useWhitelist !== false
      });
    } catch (postErr) {
      fail(new PipelineError(`pipeline：派发文件 #${fileIndex} 失败 — ${postErr && postErr.message ? postErr.message : String(postErr)}`));
    }
  }

  function handleMessage(worker, msg) {
    if (settled || !msg || typeof msg !== 'object') return;
    if (msg.jobId !== jobId) return;
    if (msg.type === 'progress') {
      if (typeof onProgress === 'function') {
        try {
          onProgress({ sourceFile: path.basename(files[msg.fileIndex]), importedCount: msg.importedCount });
        } catch (_e) { /* swallow */ }
      }
      return;
    }
    if (msg.type === 'parsed') {
      const fileIndex = msg.fileIndex;
      workerFileMap.delete(worker);
      // 缓存解析产物（乱序到达）。
      parsedResults.set(fileIndex, {
        batch: msg.batch,
        errors: msg.errors,
        importedCount: msg.importedCount,
        rowErrorTotal: msg.rowErrorTotal,
        truncated: msg.truncated,
        monthKeys: msg.monthKeys,
        headerError: msg.headerError,
        sourceFile: path.basename(files[fileIndex])
      });
      // 该 worker 空闲 → 派下一个文件。
      dispatchNext(worker);
      // 按文件序写入（消费已就绪的连续 index）。
      drainWrites();
      return;
    }
    if (msg.type === 'parse-error') {
      // 解析子 worker 系统级失败（zip 损坏 / 契约模块加载失败等）→ 整体失败（按文件序语义下，任一文件解析失败即整批不可用）。
      const e = deserialize(msg.error);
      fail(e);
      return;
    }
  }

  function deserialize(serialized) {
    try {
      const helper = require('../../main-process/serialize-error');
      return helper.deserializeError(serialized);
    } catch (_e) {
      if (!serialized) return new PipelineError('pipeline：解析子 worker 未知错误');
      const err = new Error(serialized.message || 'unknown');
      if (serialized.name) err.name = serialized.name;
      if (serialized.detailLines) err.detailLines = serialized.detailLines;
      if (serialized.code) err.code = serialized.code;
      return err;
    }
  }

  // 起 worker 池（数量 = min(maxParallel, fileCount)），各 worker 立即派一个文件。
  const poolSize = Math.min(maxParallel, fileCount);
  for (let i = 0; i < poolSize; i++) {
    let w;
    try {
      w = new Worker(WORKER_SCRIPT_PATH);
    } catch (spawnErr) {
      fail(new PipelineError(`pipeline：启动解析子 worker 失败 — ${spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr)}`));
      break;
    }
    workers.push(w);
    w.on('message', (msg) => handleMessage(w, msg));
    w.on('error', (err) => {
      // worker 线程级崩溃（非业务错）→ 整体失败。
      if (settled) return;
      fail(new PipelineError(`pipeline：解析子 worker 异常 — ${err && err.message ? err.message : String(err)}`));
    });
    w.on('exit', (code) => {
      // cancel/正常 terminate（settled 后）忽略；非预期退出（仍有未完成文件）→ 失败。
      if (settled || cancelled) return;
      if (code !== 0 && workerFileMap.has(w)) {
        fail(new PipelineError(`pipeline：解析子 worker 退出码 ${code}（文件 #${workerFileMap.get(w)} 未完成）`));
      }
    });
    dispatchNext(w);
  }

  // 暴露 cancel：terminate 全部解析子 worker + 置 cancelled，让写循环在文件边界抛 CancelError。
  //   若此刻已无待写文件（写循环不会再被触发）→ 直接以 CancelError 收尾。
  function cancel() {
    if (settled) return;
    cancelled = true;
    terminateAllWorkers();
    // 主动收尾（写循环可能已 drain 完当前可写 index，不会再被 message 触发）。
    fail(new CancelError('导入已取消（pipeline.cancel）', { stage: 'pipeline-cancel' }));
  }

  return { promise, cancel, maxParallel };
}

module.exports = {
  runPipeline,
  computeMaxParallel,
  CancelError,
  PipelineError,
  FREEMEM_GATE_BYTES,
  WORKER_SCRIPT_PATH
};
