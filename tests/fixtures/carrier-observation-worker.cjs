'use strict';

const { parentPort } = require('node:worker_threads');
const { createJobEnvelope } = require('../../src/main-process/background-execution/protocol');

let command;
let seq = 0;
function emit(operation, payload) {
  parentPort.postMessage(createJobEnvelope({
    direction: 'event', operation, actionKey: command.actionKey,
    operationKey: command.operationKey, jobId: command.jobId,
    workerInstanceId: command.workerInstanceId, serviceGeneration: null,
    unitId: null, seq: ++seq, context: command.context, payload
  }));
}

parentPort.on('message', (message) => {
  // 由测试直接控制原生退出，不经过业务协议声明关闭。
  if (message.fixture === 'exit') return parentPort.close();
  if (message.operation === 'job:start') {
    command = message;
    const behavior = message.payload.input.behavior;
    if (behavior === 'error') {
      emit('job:error', { error: {
        code: 'FIXTURE_BUSINESS_FAILED', message: '测试业务失败',
        stage: 'execute', detailLines: []
      } });
    } else if (behavior === 'done') {
      emit('job:done', { result: { checksum: 6004, count: 2, rounds: 2, sum: 3 } });
    }
  } else if (message.operation === 'job:cancel') {
    emit('cancel:ack', { cancellation: { scope: 'job' } });
  }
});
