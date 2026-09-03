// 大表导入引擎 共享 dispatch 模块（v3.0.4 块 B · PR-C · OPEN-2 拍板不收编收单）
//
// 职责：把「new Worker(engine-worker-entry) + jobId + progress/log/done/error 协议 + serialize-error 还原」
//   抽成共享 dispatch，供 pending / biz-op flow 等迁移模块复用（收单自己的 dispatchEngineImport 保持原样不动）。
//   范式平移自 acquiring-bill-currency-session.dispatchEngineImport（v3.0.3 PR-H）。
//
// 与收单 dispatch 的差异（新增能力）：
//   - resourceLimits：透传 new Worker(...) 的 resourceLimits（pending 用 maxOldGenerationSizeMb=4096，spec R-5
//     ——worker_threads 堆替代旧 utilityProcess 8GB child；dedupe Set 300w≈360MB + 写批缓冲需显式放大堆上限）。
//   - onLog：日志条目回调（由调用方决定落库 domain；不在本模块内联业务 logger）。
//
// 约束：纯 Node，不访问 Electron API；不 require 任何业务模块（仅 serialize-error 通用工具）。

'use strict';

const { Worker } = require('node:worker_threads');
const { computeMaxParallel } = require('../backend/big-table-import/pipeline');

// 引擎薄 worker 入口（new Worker 拉起 → 内部跑 engine.importFiles → pipeline 起解析子 worker）。
const ENGINE_WORKER_ENTRY = require.resolve('../backend/big-table-import/engine-worker-entry');

// dispatch 引擎 worker 跑一批文件导入（append / overwrite 通用）。
//   入参：
//     dbPath              — 引擎 worker 自开连接的 DB 文件路径
//     files               — string[] 文件绝对路径（写入顺序 = rowid 顺序契约）
//     contractModulePath  — 契约模块路径（worker require）
//     contractOptions     — 契约工厂入参（可序列化）
//     mode                — 'append' | 'overwrite'
//     monthKey            — 期望月份（跨月校验基准）；pending monthKeyOf=null ⇒ 传 undefined（旁路）
//     resourceLimits      — { maxOldGenerationSizeMb, ... } 透传 new Worker（R-5；缺省 = worker 默认堆）
//     parallel/frozen     — 仅 mature adapter 使用的已获批 Parser childCount；legacy wrapper 强制不冻结
//     onEngineProgress    — ({ sourceFile, importedCount }) 引擎每 1w 行节流上报
//     onLog               — ({ level, message, details? }) 日志条目透传（调用方落库）
//   返回引擎 result：{ monthKey, fileCount, totalImported, deletedCount, maxParallel }。
//   错误：worker postMessage 'error' → 用 deserializeError 还原（保 name/message/detailLines/structuredImportErrors）→ reject。
function dispatchEngineImportHandle({
  dbPath,
  files,
  contractModulePath,
  contractOptions,
  mode,
  monthKey,
  batchContext,
  parallel,
  parallelFrozen,
  resourceLimits,
  onEngineProgress,
  onLog,
  WorkerClass = Worker
}) {
  let worker = null;
  let jobId = null;
  let settled = false;
  let cancelMessagePosted = false;
  let terminationPromise = null;

  function ensureTermination() {
    if (!worker) return Promise.resolve(0);
    if (!terminationPromise) {
      terminationPromise = Promise.resolve().then(() => worker.terminate());
      // legacy 调用方只消费业务 promise；先挂 observer 避免 rejected termination
      // 在 Supervisor close barrier 接手前形成 unhandled rejection。原 Promise 仍保留拒绝态。
      void terminationPromise.catch(() => {});
    }
    return terminationPromise;
  }

  const promise = new Promise((resolve, reject) => {
    try {
      // resourceLimits 仅在显式传入时透传（不传 = worker 默认堆，行为与收单 dispatch 一致）。
      const workerOptions = (resourceLimits && typeof resourceLimits === 'object')
        ? { resourceLimits }
        : undefined;
      worker = new WorkerClass(ENGINE_WORKER_ENTRY, workerOptions);
    } catch (spawnErr) {
      reject(spawnErr);
      return;
    }
    jobId = `btie-dispatch-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { worker.postMessage({ type: 'close' }); } catch (_e) { /* swallow */ }
      void ensureTermination();
      fn(arg);
    };

    const forwardLog = (entry) => {
      if (typeof onLog !== 'function' || !entry) return;
      try {
        onLog({
          level: entry.level || 'info',
          message: entry.message || '[big-table-import] log',
          details: Array.isArray(entry.details) ? entry.details : undefined
        });
      } catch (_e) { /* swallow */ }
    };

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      // log 消息（带 jobId）也透传；jobId 不匹配的非 log 消息忽略。
      if (msg.jobId !== jobId) {
        if (msg.type === 'log' && msg.entry) forwardLog(msg.entry);
        return;
      }
      if (msg.type === 'progress') {
        if (typeof onEngineProgress === 'function') {
          try { onEngineProgress(msg.payload || {}); } catch (_e) { /* swallow */ }
        }
        return;
      }
      if (msg.type === 'log' && msg.entry) {
        forwardLog(msg.entry);
        return;
      }
      if (msg.type === 'done') {
        finish(resolve, msg.result);
        return;
      }
      if (msg.type === 'error') {
        const { deserializeError } = require('./serialize-error');
        finish(reject, deserializeError(msg.error));
        return;
      }
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (settled) return;
      // 未 settled 的非零退出 → 失败（settled 后的 terminate 退出忽略）。
      settled = true;
      reject(new Error(`big-table-import engine worker 异常退出（code=${code}）`));
    });

    worker.postMessage({
      type: 'run',
      jobId,
      payload: {
        dbPath,
        files,
        contractModulePath,
        contractOptions: contractOptions || {},
        mode: mode || 'append',
        monthKey,
        batchContext,
        // mature adapter 在 admission 前用 pipeline 同一纯函数冻结完整 Parser Pool
        // topology；这里只透传获批 childCount，禁止 engine 再按旧上限自行扩容。
        parallel,
        parallelFrozen: parallelFrozen === true
      }
    });
  });

  return {
    promise,
    cancel() {
      if (!worker || settled || !jobId) return { acknowledged: false };
      try {
        worker.postMessage({ type: 'cancel', jobId });
        cancelMessagePosted = true;
        // 这里只证明请求已投递，不能伪造 Worker ACK 或取消终态。
        return { acknowledged: false };
      } catch (_error) {
        return { acknowledged: false };
      }
    },
    // existing-dispatch 私有握手：必须同时有本 handle 成功投递的 cancel，且
    // Worker 真实返回 CancelError，才允许 Supervisor 建立取消终态因果。
    isCancellationTerminalError(error) {
      return cancelMessagePosted && Boolean(error && error.name === 'CancelError');
    },
    close() {
      return ensureTermination();
    },
    terminate() {
      return ensureTermination();
    }
  };
}

function dispatchEngineImport(options) {
  // 现有 Pending/BizOP 默认入口始终保留 engine 自己的并行度/内存闸；
  // 只有经过 CompoundLease admission 的 mature binding 才能设置 parallelFrozen。
  return dispatchEngineImportHandle({ ...(options || {}), parallelFrozen: false }).promise;
}

function inspectBigTableImportTopology(request = {}) {
  const input = request.input || {};
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0) {
    throw new TypeError('big-table mature adapter requires non-empty input.files');
  }
  return {
    effectiveChildCount: computeMaxParallel({
      requested: input.parallel,
      fileCount: files.length
    })
  };
}

function createBigTableImportMatureBinding(options = {}) {
  const dispatch = options.dispatch || dispatchEngineImportHandle;
  const inspectTopology = options.inspectTopology || inspectBigTableImportTopology;
  return Object.freeze({
    inspectTopology,
    dispatch(request = {}) {
      const topology = request.topology;
      if (!topology || !Number.isSafeInteger(topology.effectiveChildCount)) {
        throw new TypeError('big-table mature adapter requires admitted topology');
      }
      return dispatch({
        ...(request.input || {}),
        topology,
        parallel: topology.effectiveChildCount,
        parallelFrozen: true,
        onEngineProgress: request.onProgress
      });
    }
  });
}

module.exports = {
  createBigTableImportMatureBinding,
  dispatchEngineImport,
  dispatchEngineImportHandle,
  inspectBigTableImportTopology,
  ENGINE_WORKER_ENTRY
};
