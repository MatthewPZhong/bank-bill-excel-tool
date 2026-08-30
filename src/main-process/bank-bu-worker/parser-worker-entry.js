'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { writeBankBuInputSpool } = require('./spool-writer');

if (!parentPort) throw new Error('BankBU Parser必须运行在worker_threads');

const controller = new AbortController();
parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') controller.abort();
});

function safeError(error) {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const code = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawCode)
    ? rawCode
    : 'BANK_BU_PARSER_FAILED';
  return Object.freeze({ code, message: 'BankBU Parser失败' });
}

(async () => {
  try {
    const result = await writeBankBuInputSpool(workerData && workerData.spool, {
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
