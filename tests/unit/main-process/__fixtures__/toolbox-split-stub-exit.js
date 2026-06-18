// v3.0.9 T4 测试 fixture worker（仅 unit test 用）—— 非零 exit 兜底场景。
//
// 用途：模拟 large-split-worker 收到 run 后硬崩（process.exit(1)），不回任何 done/error message。
//   验证 toolbox-large-split-dispatch 的 worker.on('exit') 兜底：未 settled 的非零退出 → reject。
//
// 注：不 require 任何业务模块；纯协议桩。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') { process.exit(0); return; }
    if (msg.type === 'run') {
      // 硬崩 —— 不写、不回 message，触发 dispatch 的 exit 兜底 reject。
      process.exit(1);
    }
  });
}
