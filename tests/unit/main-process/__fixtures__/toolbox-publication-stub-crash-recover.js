'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const core = require('../../../../src/main-process/toolbox-output-publication');
const { createWorkerAuthority } = require('../../../../src/main-process/publication-recovery/worker-authority');
const { serializeError } = require('../../../../src/main-process/serialize-error');
const workerAuthority = createWorkerAuthority(workerData.publicationRecoveryKey);
if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (!message || message.type !== 'run') return;
    const payload = message.payload || {};
    try {
      let result;
      if (message.op === 'publish') {
        const prepared = core.prepareToolboxPublication({ ...payload, workerAuthority,
          checkpoint(name) {
            const checkpoint = String(payload.taskId).startsWith('committed-crash-recover')
              ? 'publish:after-committed' : 'publish:after-publish-rename-before-journal';
            if (name === checkpoint) process.exit(23);
          } });
        result = core.publishPreparedToolboxPublication(prepared);
      } else if (message.op === 'discover-recovery') {
        result = core.discoverToolboxPublicationRecovery(payload);
      } else if (message.op === 'execute-recovery') {
        result = core.recoverPendingToolboxPublications({ ...payload, workerAuthority });
        fs.mkdirSync(payload.userDataDir, { recursive: true });
        fs.writeFileSync(path.join(payload.userDataDir, 'recovery-ran.txt'), 'recovered');
      }
      parentPort.postMessage({ type: 'done', jobId: message.jobId, result });
    } catch (error) {
      parentPort.postMessage({ type: 'error', jobId: message.jobId, error: serializeError(error) });
    }
  });
}
