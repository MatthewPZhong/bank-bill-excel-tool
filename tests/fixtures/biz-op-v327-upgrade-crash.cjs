'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createUpgradeHost, seedLegacy } = require('../helpers/biz-op-v327-upgrade');
(async () => {
  const [root, phase] = process.argv.slice(2);
  const f = await createUpgradeHost({ after() {} }, { root, keep: true, host: { async afterStage(current, row) {
    if (phase === current) {
      fs.writeFileSync(path.join(root, 'upgrade-evidence.json'), JSON.stringify({ taskRunId: row.task_run_id, phase, intentDigest: row.intent_digest }));
      process.exit(73);
    }
  } } });
  seedLegacy(f); await f.module.activation.run(); process.exit(1);
})().catch((error) => { process.stderr.write(String(error.stack)); process.exit(1); });
