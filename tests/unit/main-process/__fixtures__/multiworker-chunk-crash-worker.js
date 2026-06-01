// v2.1.12 β.1-T1 — 测试 fixture worker（仅 unit test 用）
//
// 用途：模拟 multiworker reader 阶段 worker crash —— init 正常，但收到第一个
//   'select-chunk-to-temp'（真正干活的 chunk 任务）时立即 process.exit(1)，模拟硬崩。
//   验证 run-check-multiworker.js 的 crash recovery：dispatch reject + temp db 清理不泄漏。
//
// 行为：
//   - 'init' → 正常回 { type:'init-done' }（让 startWorker 通过 init 门槛）
//   - 'select-chunk-to-temp' → process.exit(1)（不写 temp db、不回 message）
//
// 注：不 require 任何业务模块（避免依赖加载副作用 / 真的 init DB）。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      parentPort.postMessage({ type: 'init-done', pragmaValues: null });
      return;
    }
    if (msg.type === 'select-chunk-to-temp') {
      // 模拟硬崩 — 不写 temp db、不回 message
      process.exit(1);
    }
    if (msg.type === 'close') {
      process.exit(0);
    }
  });
}
