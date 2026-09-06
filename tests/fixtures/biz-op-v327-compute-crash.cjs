'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../helpers/biz-op-v327-host');
const { seed, compute } = require('../helpers/biz-op-v327-compute');
(async () => {
  const root = process.argv[2]; const phase = process.argv[3];
  const f = await createHost({ after() {} }, { root });
  await seed(f);
  await compute(f, phase === 'after-commit' ? { afterCommit(receipt) {
    fs.writeFileSync(path.join(root, 'compute-evidence.json'), JSON.stringify(receipt)); process.exit(73);
  } } : { afterWorker({ taskRunId, candidateRef, outcome }) {
    if (outcome.outcome !== 'completed') throw new Error(JSON.stringify(outcome));
    fs.writeFileSync(path.join(root, 'compute-evidence.json'), JSON.stringify({ taskRunId, candidateRef })); process.exit(73);
  } });
  process.exit(1);
})().catch((error) => { process.stderr.write(String(error.stack)); process.exit(1); });
