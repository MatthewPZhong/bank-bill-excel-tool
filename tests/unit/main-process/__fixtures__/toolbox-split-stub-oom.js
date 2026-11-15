// 测试 fixture worker（仅 unit test 用）—— 堆到达 resourceLimits 被 V8 强杀的场景。
//
// 用途：收到 run 后持续分配并保留对象，直到真实触发 ERR_WORKER_OUT_OF_MEMORY，
//   验证 toolbox-large-split-dispatch 把 Node 英文报错归一为中文可解释错误。
//   分批异步分配（与真实流式读取一致）：同步死循环分配时，V8 到达上限后的终止处理会被拖住，
//   进程内存持续上涨而不退出，测试会挂起。
//
// 注：不 require 任何业务模块；纯协议桩。须配合很小的 resourceLimits 使用。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

if (!isMainThread && parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') { process.exit(0); return; }
    if (msg.type === 'run') {
      const retained = [];
      const grow = () => {
        for (let index = 0; index < 256; index += 1) retained.push(new Array(1024).fill(retained.length));
        setImmediate(grow);
      };
      grow();
    }
  });
}
