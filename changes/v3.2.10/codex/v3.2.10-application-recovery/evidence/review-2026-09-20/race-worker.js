'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const repo = '/private/tmp/application-recovery-review-7pcbw8r1';
const core = require(repo + '/src/main-process/toolbox-output-publication');
const { createWorkerAuthority } = require(repo + '/src/main-process/publication-recovery/worker-authority');
const { serializeError } = require(repo + '/src/main-process/serialize-error');
const authority = createWorkerAuthority(workerData.publicationRecoveryKey);
parentPort.on('message', (message) => {
  if (message.type === 'close') return process.exit(0);
  if (message.type !== 'run') return;
  const payload = message.payload;
  try {
    let result;
    if (message.op === 'discover-recovery') result = core.discoverToolboxPublicationRecovery(payload);
    if (message.op === 'execute-recovery') {
      // Deterministically simulate another process registering a valid journal
      // after this recovery's last index removal but before its ending snapshot.
      const fsImpl = { ...fs, renameSync(from, to) {
        fs.renameSync(from, to);
        if (to !== path.join(payload.userDataDir, core.JOURNAL_INDEX_NAME)) return;
        const index = JSON.parse(fs.readFileSync(to, 'utf8'));
        if (index.entries.length !== 0) return;
        const injection = path.join(payload.userDataDir, 'external-entry.json');
        if (!fs.existsSync(injection)) return;
        index.entries.push(JSON.parse(fs.readFileSync(injection, 'utf8')));
        fs.writeFileSync(to, JSON.stringify(index));
        fs.unlinkSync(injection);
      } };
      result = core.recoverPendingToolboxPublications({ ...payload, workerAuthority: authority, fsImpl });
    }
    if (message.op === 'publish') {
      result = core.publishPreparedToolboxPublication(core.prepareToolboxPublication({ ...payload, workerAuthority: authority }));
    }
    parentPort.postMessage({ type: 'done', jobId: message.jobId, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', jobId: message.jobId, error: serializeError(error) });
  }
});
