'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { writeBankBuInputSpool } = require(
  '../../../../src/main-process/bank-bu-worker/spool-writer'
);

if (!parentPort) throw new Error('测试Parser必须运行在worker_threads');

let spoolReady = false;
let cancelRequested = false;
let terminalScheduled = false;

function scheduleCancelledTerminal() {
  if (!spoolReady || !cancelRequested || terminalScheduled) return;
  terminalScheduled = true;
  setTimeout(() => {
    parentPort.postMessage({
      ok: false,
      error: { code: 'BANK_BU_PARSER_CANCELLED', message: 'BankBU Parser失败' }
    });
    parentPort.close();
  }, 180);
}

parentPort.on('message', (message) => {
  if (message && message.operation === 'cancel') {
    cancelRequested = true;
    scheduleCancelledTerminal();
  }
});

(async () => {
  try {
    await writeBankBuInputSpool(workerData && workerData.spool);
    spoolReady = true;
    scheduleCancelledTerminal();
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: { code: error.code || 'BANK_BU_PARSER_FAILED', message: 'BankBU Parser失败' }
    });
    parentPort.close();
  }
})();
