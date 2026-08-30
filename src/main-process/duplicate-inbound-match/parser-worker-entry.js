'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { writeDuplicateInputSpool } = require('./spool-writer');

if (!parentPort) throw new Error('Duplicate Parser必须运行在worker_threads');

const controller = new AbortController();
parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') controller.abort();
});

function safeError(error) {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const code = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawCode)
    ? rawCode
    : 'DUPLICATE_PARSER_FAILED';
  // Parser可能持有本地绝对路径和业务行；跨回Main的terminal只允许bounded code。
  return Object.freeze({ code, message: 'Duplicate Parser失败' });
}

(async () => {
  try {
    const result = await writeDuplicateInputSpool(workerData && workerData.spool, {
      signal: controller.signal
    });
    parentPort.postMessage({
      ok: true,
      result: Object.freeze({ ...result, rssBytes: process.memoryUsage().rss })
    });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: safeError(error) });
  } finally {
    parentPort.close();
  }
})();
