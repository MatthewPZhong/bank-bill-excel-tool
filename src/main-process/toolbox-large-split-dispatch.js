// v3.0.9 子任务 T4：工具箱「按字段值拆分」大文件隔离 worker —— 主侧 dispatch。
//
// 职责（TechDoc v3.0.9 §六 T4 + §四 4.3 + §七接缝契约）：
//   把「new Worker(large-split-worker) + jobId + run/cancel ↔ progress/log/done/error 协议
//   + deserializeError 还原 + terminate + .on('exit') 兜底」抽成一个 Promise 接口，供
//   main.js 的 toolbox:split:read / toolbox:split:export 大通道调用。范式照搬
//   big-table-import-dispatch.js:34-127（new Worker / resourceLimits / jobId / terminate /
//   deserializeError / exit 兜底）。
//
// 与 big-table-import-dispatch 的差异：
//   - worker 入口换成 toolbox 大文件拆分 worker（large-split-worker.js）。
//   - payload 扁平化为 { op, filePath, field?, values?, savePath?, groups? }（拆分作业无 dbPath / 契约模块）。
//   - resourceLimits 固定 maxOldGenerationSizeMb=4096（与 pending dispatch 同口径，TechDoc §8.3 / R-5）。
//   - 返回 dispatch 的 result：scanFields / 单文件过滤 / 多文件过滤各自的结果对象。
//
// 约束：纯 Node，不访问 Electron API；只 require worker_threads + serialize-error（通用工具）。

'use strict';

const { Worker } = require('node:worker_threads');

// 工具箱大文件拆分薄 worker 入口（new Worker 拉起 → 内部跑三种拆分作业）。
//   解析方式与 big-table-import-dispatch.js 一致（require.resolve 相对本文件定位 backend 下 worker entry）。
const DEFAULT_WORKER_ENTRY = require.resolve('../backend/toolbox-xlsx-stream/large-split-worker');

// 当前生效的 worker 脚本路径（默认 = 生产 worker entry）。
//   单测可通过 __test_only_set_worker_script__ 注入桩 worker（照搬 run-check-multiworker 的测试注入范式），
//   验证 done→resolve / error→reject(还原) / exit 非零→reject 兜底 / jobId 过滤，而不必跑真 backend。
let workerScriptPath = DEFAULT_WORKER_ENTRY;

// worker 堆上限（TechDoc §8.3 / R-5）：sharedStrings 全量 + 写批缓冲需显式放大 V8 老生代堆上限。
const WORKER_MAX_OLD_GEN_MB = 4096;

// dispatch 一次大文件拆分作业（scanFields / exportFilter / exportMultiFilters 通用）。
//   入参（对象）：
//     op           string                            作业类型（worker 内分派到对应 T3 纯逻辑）
//     filePath     string                           源 .xlsx 绝对路径
//     field        string?                          exportFilter 的拆分字段（scanFields 不需要）
//     values       string[]?                        exportFilter 的选中值集合
//     savePath     string?                          exportFilter 的输出临时 .xlsx 路径
//     groups       Object[]?                        exportMultiFilters 的 1-8 个输出分组
//     onProgress   ((payload) => void)?             进度回调（v1 无 UI，最终接 activity log；OPEN-3）
//     onLog        ((entry) => void)?               日志条目透传（调用方决定落库 domain）
//   返回：{ promise, cancel }
//     promise  Promise<result>   done→resolve(result) / error·exit→reject（deserializeError 还原 name/message/detailLines）
//     cancel   () => void        v1 无前端触发，仅保留进程退出兜底能力（postMessage cancel + 兜底 terminate）
//
//   错误：worker postMessage 'error' → deserializeError 还原 → reject；未 settled 的非零 exit → reject（兜底）。
//   清理：done / error / exit 任一 settle 后 postMessage close + terminate worker（不泄漏 worker）。
function dispatchLargeSplit({
  op,
  filePath,
  field,
  values,
  savePath,
  groups,
  batchContext,
  onProgress,
  onLog
}) {
  let worker = null;
  let settled = false;
  let jobId = null;

  const promise = new Promise((resolve, reject) => {
    try {
      worker = new Worker(workerScriptPath, {
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB }
      });
    } catch (spawnErr) {
      reject(spawnErr);
      return;
    }

    jobId = `tbx-split-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { worker.postMessage({ type: 'close' }); } catch (_e) { /* swallow */ }
      try { worker.terminate(); } catch (_e) { /* swallow */ }
      fn(arg);
    };

    const forwardLog = (entry) => {
      if (typeof onLog !== 'function' || !entry) return;
      try { onLog(entry); } catch (_e) { /* swallow */ }
    };

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      // log 消息（带 jobId）也透传；jobId 不匹配的非 log 消息忽略（照搬 big-table-import-dispatch.js:81）。
      if (msg.jobId !== jobId) {
        if (msg.type === 'log' && msg.entry) forwardLog(msg.entry);
        return;
      }
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') {
          try { onProgress(msg.payload || {}); } catch (_e) { /* swallow */ }
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
      // 未 settled 的非零退出 → 失败（settle 后的 terminate 退出忽略）。
      settled = true;
      reject(new Error(`工具箱大文件拆分 worker 异常退出（code=${code}）`));
    });

    worker.postMessage({
      type: 'run',
      jobId,
      op,
      filePath,
      field,
      values,
      savePath,
      groups,
      batchContext
    });
  });

  // cancel 能力（v1 无前端触发；保留作进程退出兜底）：发 cancel message（worker 置 cancelToken）。
  //   若 worker 已起且未 settle，发 cancel 让 worker 内 T1 reader 早退；不强杀（让 worker 走 error/done 正常 settle）。
  const cancel = () => {
    if (!worker || settled || !jobId) return;
    try { worker.postMessage({ type: 'cancel', jobId }); } catch (_e) { /* swallow */ }
  };

  return { promise, cancel };
}

// 单测注入桩 worker 脚本（传 null 还原默认生产 worker entry）。
function __test_only_set_worker_script__(scriptPath) {
  workerScriptPath = scriptPath || DEFAULT_WORKER_ENTRY;
}

function createToolboxLargeSplitMatureBinding(options = {}) {
  const dispatch = options.dispatch || dispatchLargeSplit;
  return Object.freeze({
    dispatch(request = {}) {
      return dispatch({
        ...(request.input || {}),
        onProgress: request.onProgress
      });
    }
  });
}

module.exports = {
  createToolboxLargeSplitMatureBinding,
  dispatchLargeSplit,
  DEFAULT_WORKER_ENTRY,
  WORKER_MAX_OLD_GEN_MB,
  __test_only_set_worker_script__
};
