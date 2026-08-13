'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, parentPort } = require('node:worker_threads');
const {
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
} = require('../../../../src/main-process/toolbox-output-publication');
const {
  serializeError
} = require('../../../../src/main-process/serialize-error');

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (!message || message.type !== 'run') return;
    const userDataDir = message.payload && message.payload.userDataDir;
    if (message.op === 'publish') {
      try {
        const prepared = prepareToolboxPublication({
          ...message.payload,
          checkpoint(name) {
            const checkpointName = String(message.payload.taskId || '').startsWith(
              'committed-crash-recover'
            )
              ? 'publish:after-committed'
              : 'publish:after-publish-rename-before-journal';
            if (name === checkpointName) {
              process.exit(23);
            }
          }
        });
        publishPreparedToolboxPublication(prepared);
      } catch (error) {
        parentPort.postMessage({
          type: 'error',
          jobId: message.jobId,
          error: serializeError(error)
        });
      }
      return;
    }
    if (message.op === 'recover') {
      try {
        const result = recoverPendingToolboxPublications({
          userDataDir,
          deferCommittedRecovery: message.payload.deferCommittedRecovery === true,
          acknowledgedCommittedTaskIds: message.payload.acknowledgedCommittedTaskIds
        });
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.writeFileSync(path.join(userDataDir, 'recovery-ran.txt'), 'recovered');
        parentPort.postMessage({
          type: 'done',
          jobId: message.jobId,
          result
        });
      } catch (error) {
        parentPort.postMessage({
          type: 'error',
          jobId: message.jobId,
          error: serializeError(error)
        });
      }
    }
  });
}
