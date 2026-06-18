// v3.0.9 T4 测试 fixture worker（仅 unit test 用）—— jobId 过滤场景。
//
// 用途：先发一条 jobId 不匹配的 done（dispatch 应忽略，不 resolve），再发匹配 jobId 的 done
//   （dispatch 应据此 resolve）。验证 toolbox-large-split-dispatch 按 jobId 过滤、
//   不被错 jobId 的消息误 settle（照搬 big-table-import-dispatch.js:81 的 jobId 过滤契约）。
//
// 注：不 require 任何业务模块；纯协议桩。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') { process.exit(0); return; }
    if (msg.type !== 'run') return;

    const { jobId } = msg;
    // ① 错 jobId 的 done（dispatch 必须忽略，绝不 resolve 成这个 result）。
    parentPort.postMessage({ type: 'done', jobId: 'WRONG-JOBID-SHOULD-BE-IGNORED', result: { matchedCount: -999 } });
    // ② 正确 jobId 的 done（dispatch 应据此 resolve）。
    parentPort.postMessage({ type: 'done', jobId, result: { matchedCount: 7 } });
  });
}
