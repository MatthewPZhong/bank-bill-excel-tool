// 通用大表导入引擎 — engine-worker-entry（薄 worker 入口 · worker_threads）
//
// 职责（spec §2.2 拓扑「import 主 worker」可被 new Worker() 直接拉起的薄壳）：
//   本文件让 engine.importFiles 在「import 主 worker 进程域」内执行（它再调 pipeline 起解析子 worker
//   ×N → 两级拓扑跑通）。本 PR 不做主进程 dispatch 接线（PR-H 的事）；此入口供集成脚本以真实
//   worker 拓扑跑通全链（dbPath 自开连接 + 按文件序单写 + 多 worker 并行解析 + cancel）。
//
// 进程边界：纯 Node，不访问 Electron API。worker 内持 DB（engine 自开按第 5 处 PRAGMA 契约连接）。
//
// Message 协议：
//   主 → worker：
//     { type:'run', jobId, payload:{ dbPath, files, contractModulePath, contractOptions, mode,
//       monthKey, parallel, parallelFrozen, useWhitelist } }
//     { type:'cancel', jobId }   — 置 cancelToken.cancelled（engine/pipeline 在文件边界 ROLLBACK + CancelError）
//     { type:'close' }           — process.exit(0)
//   worker → 主：
//     { type:'progress', jobId, payload:{ sourceFile, importedCount } }
//     { type:'log', jobId, entry }
//     { type:'done', jobId, result }
//     { type:'error', jobId, error: serialized }
//
// 约束：本文件不得 require 任何业务模块；引擎自包含。

'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');
const {
  freezeWorkerBatchContext
} = require('../../main-process/archive-center/worker-batch-context');

if (!isMainThread && parentPort) {
  process.on('warning', (warning) => {
    try {
      const name = warning && warning.name ? String(warning.name) : '';
      const msg = warning && warning.message ? String(warning.message) : '';
      if (name === 'ExperimentalWarning' && (msg.includes('SQLite') || msg.includes('node:sqlite'))) return;
      process.stderr.write(`(node:big-table-import-engine-worker) ${name}: ${msg}\n`);
    } catch (_e) { /* swallow */ }
  });

  let serializeError;
  try {
    serializeError = require('../../main-process/serialize-error').serializeError;
  } catch (_e) {
    serializeError = function fallback(err) {
      if (!err) return null;
      return {
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack || null,
        code: err.code != null ? String(err.code) : null,
        detailLines: Array.isArray(err.detailLines) ? err.detailLines.slice() : null
      };
    };
  }

  const engine = require('./engine');

  // 当前 job 的取消令牌（engine/pipeline 透传；cancel message 置位）。
  let activeCancelToken = null;
  let activeJobId = null;

  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'cancel') {
      if (activeCancelToken && (!msg.jobId || msg.jobId === activeJobId)) {
        activeCancelToken.cancelled = true;
      }
      return;
    }

    if (msg.type === 'close') {
      process.exit(0);
      return;
    }

    if (msg.type !== 'run') return;
    const { jobId, payload } = msg;
    activeJobId = jobId;
    activeCancelToken = { cancelled: false };

    try {
      const batchContext = freezeWorkerBatchContext(payload.batchContext);
      const result = await engine.importFiles({
        dbPath: payload.dbPath,
        files: payload.files,
        contractModulePath: payload.contractModulePath,
        contractOptions: payload.contractOptions,
        mode: payload.mode || 'append',
        monthKey: payload.monthKey,
        parallel: payload.parallel,
        parallelFrozen: payload.parallelFrozen === true,
        useWhitelist: payload.useWhitelist,
        batchContext,
        onProgress: (ev) => {
          try { parentPort.postMessage({ type: 'progress', jobId, payload: ev }); } catch (_e) { /* swallow */ }
        },
        onLog: (entry) => {
          try { parentPort.postMessage({ type: 'log', jobId, entry }); } catch (_e) { /* swallow */ }
        },
        cancelToken: activeCancelToken
      });
      parentPort.postMessage({ type: 'done', jobId, result });
    } catch (err) {
      parentPort.postMessage({ type: 'error', jobId, error: serializeError(err) });
    } finally {
      activeCancelToken = null;
      activeJobId = null;
    }
  });
}

module.exports = { __workerScriptPath: __filename };
