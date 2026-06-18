// v3.0.9 T4 测试 fixture worker（仅 unit test 用）—— done 场景。
//
// 用途：模拟 large-split-worker 收到 { type:'run', jobId, op, ... } 后正常完成，回
//   { type:'done', jobId, result }。验证 toolbox-large-split-dispatch 的 done→resolve(result)。
//   result 内容随 op 不同（scanFields/exportFilter），用于断言 dispatch 原样透传 result。
//
// 注：不 require 任何业务模块（避免依赖加载副作用）；纯协议桩。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') { process.exit(0); return; }
    if (msg.type !== 'run') return;

    const { jobId, op } = msg;
    // 先发一条 progress + log（验证 dispatch 的 onProgress / onLog 透传 + jobId 过滤），再 done。
    parentPort.postMessage({ type: 'progress', jobId, payload: { phase: 'scan', pct: 50 } });
    parentPort.postMessage({ type: 'log', jobId, entry: { level: 'info', message: 'stub-progress' } });

    const result = op === 'exportFilter'
      ? { matchedCount: 123 }
      : { headers: ['A', 'B'], valuesByField: { A: ['a1', 'a2'], B: ['b1'] } };
    parentPort.postMessage({ type: 'done', jobId, result });
  });
}
