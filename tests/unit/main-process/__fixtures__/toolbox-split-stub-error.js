// v3.0.9 T4 测试 fixture worker（仅 unit test 用）—— error 场景。
//
// 用途：模拟 large-split-worker 作业抛错，回 { type:'error', jobId, error: serialize(err) }。
//   验证 toolbox-large-split-dispatch 的 error→reject(deserializeError(error))，且还原后
//   保留 name / message / detailLines（跨进程错误契约，TechDoc §4.3 / §七接缝契约）。
//
// 用真实 serialize-error.serializeError 序列化（与生产 worker 同口径），让 dispatch 端
//   deserializeError 走真实还原路径。
'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');
const path = require('node:path');

if (!isMainThread && parentPort) {
  // 相对 fixture 位置定位生产 serialize-error（tests/unit/main-process/__fixtures__ → src/main-process）。
  const { serializeError } = require(path.join(__dirname, '..', '..', '..', '..', 'src', 'main-process', 'serialize-error'));

  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'close') { process.exit(0); return; }
    if (msg.type !== 'run') return;

    const { jobId } = msg;
    // 造一个带自定义 name + detailLines 的可解释错误（模拟 ToolboxSharedStringsTooLargeError 等）。
    const err = new Error('文件文本量过大，超出处理能力');
    err.name = 'ToolboxSharedStringsTooLargeError';
    err.detailLines = ['文件内文本表解压后约 1.50 GB，超出上限。', '请拆分文件后重试。'];
    parentPort.postMessage({ type: 'error', jobId, error: serializeError(err) });
  });
}
