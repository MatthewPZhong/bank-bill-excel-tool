'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost } = require('../helpers/biz-op-v327-export');
const { seed, compute } = require('../helpers/biz-op-v327-compute');
(async () => {
  const [root, outputRoot, phase, mode] = process.argv.slice(2);
  const f = await createExportHost({ after() {} }, { root, outputRoot, keep: true });
  await seed(f, { end: '120' }); const run = await compute(f);
  const id = f.db.prepare("SELECT dataset_id FROM biz_op_v327_input_heads WHERE kind='OP' AND data_date='2026-09-01'").get().dataset_id;
  const preview = f.module.previews.create({ datasetIds: [id] });
  function crash(taskRunId) {
    fs.writeFileSync(path.join(root, 'delete-evidence.json'), JSON.stringify({ taskRunId, runId: run.runId, id, mode, previewId: preview.previewId }));
    process.exit(73);
  }
  await f.module.runDelete({ taskLifecycle: f.lifecycle, runtime: f.runtime, previewId: preview.previewId, mode,
    afterWorker({ taskRunId, outcome }) { if (phase === 'before-commit') { if (outcome.outcome !== 'completed') throw new Error('预检失败'); crash(taskRunId); } },
    afterCommit(receipt) { if (phase === 'after-commit') crash(receipt.taskRunId); }
  });
  process.exit(1);
})().catch((error) => { process.stderr.write(String(error.stack)); process.exit(1); });
