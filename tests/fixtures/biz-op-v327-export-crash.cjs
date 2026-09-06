'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost, request } = require('../helpers/biz-op-v327-export');
const { seed, compute } = require('../helpers/biz-op-v327-compute');
(async () => {
  const [root, outputRoot, phase] = process.argv.slice(2);
  const f = await createExportHost({ after() {} }, { root, outputRoot, keep: true });
  await seed(f, { end: '120' }); const run = await compute(f);
  function crash(taskRunId) {
    fs.writeFileSync(path.join(root, 'export-evidence.json'), JSON.stringify({ taskRunId, runId: run.runId, phase }));
    process.exit(73);
  }
  await request(f, 'RESULT_FULL', run.runId, {
    afterWorker({ taskRunId, outcome }) { if (phase === 'before-publish') {
      if (outcome.outcome !== 'completed') throw new Error(JSON.stringify(outcome)); crash(taskRunId);
    } },
    onPublishProgress(value) { if (phase === 'committed-before-observation' && value.checkpoint === 'publish:after-committed') {
      crash(value.context.taskId.slice('biz-op-v327-export-'.length));
    } },
    afterPublish({ taskRunId }) { if (phase === 'after-publish') crash(taskRunId); }
  });
  process.exit(1);
})().catch((error) => { process.stderr.write(String(error.stack)); process.exit(1); });
