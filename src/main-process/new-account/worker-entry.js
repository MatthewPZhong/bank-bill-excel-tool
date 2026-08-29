'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { createCanonicalEventEmitter } = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const { createDirectionSequenceTracker } = require('../background-execution/sequence-tracker');
const { NEW_ACCOUNT_GENERATION_ACTION } = require('./generation-contract');
const {
  executeNewAccountGeneration,
  newAccountGenerationCancellationSafePoint
} = require('./generation-core');

if (!parentPort) throw new Error('NewAccount worker requires worker_threads parentPort');

const defaultTemplatePath = path.resolve(__dirname, '..', '..', '..', 'assets', '余额账单模版.xlsx');
const allowedTemplatePath = workerData && typeof workerData.allowedTemplatePath === 'string'
  ? path.resolve(workerData.allowedTemplatePath)
  : defaultTemplatePath;
// 以下控制端口只由真实阶段测试注入；生产 entry Registry 不配置，且不属于 Protocol/业务 DTO。
const testReadbackStagePort = workerData && workerData.testReadbackStagePort;
const testReadbackPauseStage = workerData && typeof workerData.testReadbackPauseStage === 'string'
  ? workerData.testReadbackPauseStage
  : null;
const testReadbackPauseOccurrence = workerData && Number.isSafeInteger(workerData.testReadbackPauseOccurrence) &&
  workerData.testReadbackPauseOccurrence > 0
  ? workerData.testReadbackPauseOccurrence
  : 1;
const incomingSequence = createDirectionSequenceTracker();
let startEnvelope = null;
let emit = null;
let abortController = null;
let terminal = false;

function createTestReadbackStageHook(signal) {
  if (!testReadbackStagePort || !testReadbackPauseStage) return null;
  let matched = 0;
  let pauseConsumed = false;
  return async (stage, details) => {
    if (stage === testReadbackPauseStage) matched += 1;
    const shouldPause = stage === testReadbackPauseStage &&
      matched === testReadbackPauseOccurrence && !pauseConsumed;
    testReadbackStagePort.postMessage({
      kind: 'new-account-readback-stage',
      stage,
      details,
      paused: shouldPause
    });
    if (!shouldPause) return;
    pauseConsumed = true;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        testReadbackStagePort.off('message', onMessage);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const onMessage = (message) => {
        if (message && message.kind === 'new-account-readback-resume') finish();
      };
      testReadbackStagePort.on('message', onMessage);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  };
}

function closeTestReadbackStagePort() {
  if (testReadbackStagePort && typeof testReadbackStagePort.close === 'function') {
    try { testReadbackStagePort.close(); } catch (_) {}
  }
}

parentPort.on('message', (message) => {
  try {
    const envelope = validateEnvelope(message);
    if (envelope.direction !== 'command' || envelope.actionKey !== NEW_ACCOUNT_GENERATION_ACTION) {
      throw new Error('NewAccount worker received an invalid command route');
    }
    incomingSequence.observe(envelope);
    if (envelope.operation === 'job:start') {
      if (startEnvelope) throw new Error('NewAccount worker received duplicate job:start');
      startEnvelope = envelope;
      emit = createCanonicalEventEmitter(startEnvelope, (event) => parentPort.postMessage(event));
      abortController = new AbortController();
      const readbackStageHook = createTestReadbackStageHook(abortController.signal);
      executeNewAccountGeneration(envelope.payload.input, abortController.signal, {
        allowedTemplatePath,
        ...(readbackStageHook ? { readbackStageHook } : {})
      })
        .then(async (result) => {
          if (readbackStageHook) await readbackStageHook('worker:before-job-done', {});
          // Core 成功后再让出一轮，确保已投递的 shutdown cancel
          // 优先于 job:done 被观察，不把未发布 staging 伪报为 artifact。
          await newAccountGenerationCancellationSafePoint(abortController.signal);
          return result;
        })
        .then((result) => {
          if (terminal) return;
          terminal = true;
          emit('job:done', { result });
          closeTestReadbackStagePort();
        }, (error) => {
          if (terminal) return;
          terminal = true;
          emit('job:error', { error: toProtocolError(error) });
          closeTestReadbackStagePort();
        });
      return;
    }
    if (envelope.operation === 'job:cancel' && abortController && !terminal) {
      abortController.abort(envelope.payload.cancel);
      emit('cancel:ack', { cancellation: { scope: 'job' } });
      return;
    }
    throw new Error(`NewAccount worker received unsupported operation: ${envelope.operation}`);
  } catch (error) {
    if (emit && !terminal) {
      terminal = true;
      emit('job:error', { error: toProtocolError(error, 'NEW_ACCOUNT_GENERATION_PROTOCOL_ERROR') });
      closeTestReadbackStagePort();
    } else {
      throw error;
    }
  }
});
