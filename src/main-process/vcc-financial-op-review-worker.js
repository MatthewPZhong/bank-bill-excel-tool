'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { prepareReviewManifest, extractReviewSources } = require('../backend/vcc-financial-op/review-export-plan');
const { writeReviewWorkbook } = require('./vcc-financial-op-review-writer');
const { validateReviewWorkbook } = require('./vcc-financial-op-review-validator');
const { serializeError } = require('./serialize-error');
const { reviewError } = require('../backend/vcc-financial-op/review-export-contract');

const controller = new AbortController();
parentPort.on('message', (message) => {
  if (message?.type === 'cancel') controller.abort(reviewError('vcc-review-cancelled', '待确认表导出已取消'));
});
const onProgress = (progress) => parentPort.postMessage({ type: 'progress', progress });
(async () => {
  const options = { ...workerData.payload, signal: controller.signal, onProgress };
  try {
    let result;
    if (workerData.action === 'prepare') result = await prepareReviewManifest(options);
    else if (workerData.action === 'write') {
      const extraction = await extractReviewSources(options);
      onProgress({ phase: 'writing' });
      const written = await writeReviewWorkbook(options);
      onProgress({ phase: 'validating' });
      const evidence = await validateReviewWorkbook(options);
      result = { ...written, extraction, evidence };
    } else throw reviewError('vcc-review-worker-protocol', '待确认导出阶段无效');
    parentPort.postMessage({ type: 'result', result });
  } catch (error) {
    if (error.code === 'XLSX_ROW_RESOURCE_LIMIT') error.code = 'vcc-review-resource-limit';
    if (controller.signal.aborted) error = controller.signal.reason;
    parentPort.postMessage({ type: 'error', error: serializeError(error) });
  }
  finally { parentPort.close(); }
})();
