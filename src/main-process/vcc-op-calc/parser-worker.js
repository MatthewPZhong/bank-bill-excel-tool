'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { parseVccFileUnit } = require('./parser-core');
const { toProtocolError } = require('../background-execution/error-codec');

const WORKER_ERROR_MARKER = '__vccParserWorkerErrorV1';

function serializeWorkerError(error) {
  return {
    [WORKER_ERROR_MARKER]: true,
    error: toProtocolError(error, 'VCC_PARSER_WORKER_FAILED', {
      stage: 'parse',
      maxErrorItems: 100
    })
  };
}

async function main() {
  try {
    const result = await parseVccFileUnit(workerData);
    parentPort.postMessage(result);
  } catch (error) {
    parentPort.postMessage(serializeWorkerError(error));
  }
}

if (!isMainThread && parentPort) {
  void main();
}

module.exports = {
  WORKER_ERROR_MARKER,
  serializeWorkerError
};
