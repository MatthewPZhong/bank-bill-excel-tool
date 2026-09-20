'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repo = '/private/tmp/application-recovery-review-7pcbw8r1';
const core = require(repo + '/src/main-process/toolbox-output-publication');
const { createWorkerAuthority, seal } = require(repo + '/src/main-process/publication-recovery/worker-authority');
const { createTestPublicationHarness, createTestPublicationOwner, CONTEXT } = require(repo + '/tests/helpers/publication-authority');
const root = fs.mkdtempSync('/private/tmp/recovery-drift-fixture-');
const key = crypto.randomBytes(32).toString('hex');
const authority = createWorkerAuthority(key);
function makeOptions(taskId) {
  const out = path.join(root, taskId + '-out');
  const gen = path.join(root, taskId + '-gen');
  fs.mkdirSync(out); fs.mkdirSync(gen);
  const sourcePath = path.join(gen, 'source.xlsx'); const target = path.join(out, 'target.xlsx');
  fs.writeFileSync(sourcePath, taskId + '-new'); fs.writeFileSync(target, taskId + '-old');
  return { taskId, userDataDir: root, artifacts: [{ sourcePath }], targets: [target],
    batchContext: { ...CONTEXT, taskRunId: taskId, operationKey: taskId },
    requireArchiveHandoff: true, allowEmptyArchiveInputs: true };
}
function crashPrepared(taskId) {
  const options = makeOptions(taskId);
  const snapshot = core.discoverToolboxPublicationRecovery(options);
  assert.throws(() => core.prepareToolboxPublication({ ...options, workerAuthority: authority,
    preflight: seal(key, 'preflight', { root, taskId, indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID() }),
    checkpoint(name) { if (name === 'prepare:after-index') throw new core.ToolboxPublicationCrashError(name); }
  }), core.ToolboxPublicationCrashError);
}
async function run() {
  crashPrepared('known'); crashPrepared('unknown');
  const indexPath = path.join(root, core.JOURNAL_INDEX_NAME);
  const index = JSON.parse(fs.readFileSync(indexPath));
  const hidden = index.entries.find(item => item.taskId === 'unknown');
  fs.writeFileSync(path.join(root, 'external-entry.json'), JSON.stringify(hidden));
  index.entries = index.entries.filter(item => item.taskId === 'known');
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const identified = []; const exits = [];
  const owner = createTestPublicationOwner(); const originalIdentify = owner.identify;
  owner.identify = async record => { identified.push(record.taskId); return record.taskId === 'known' ? originalIdentify(record) : 'not-owned'; };
  const { dispatcher, recovery } = createTestPublicationHarness(root, { owners: [owner], dispatcherOptions: {
    workerScriptPath: path.join(__dirname, 'race-worker.js'), onWorkerExit({ op }) { exits.push(op); }
  } });
  const publish = await dispatcher.publish(makeOptions('next'));
  const records = core.discoverToolboxPublicationRecovery({ userDataDir: root }).records.map(record => record.taskId);
  let explicitRecovery;
  try { await recovery.recover({ reason: 'startup' }); explicitRecovery = 'unexpected success'; }
  catch (error) { explicitRecovery = error.code; }
  console.log(JSON.stringify({ root, identified, exits, published: publish.committed,
    nextTarget: fs.readFileSync(path.join(root, 'next-out/target.xlsx'), 'utf8'),
    remainingRecords: records, explicitRecovery }, null, 2));
  assert.equal(publish.committed, true);
  assert.ok(records.includes('unknown'));
  assert.equal(explicitRecovery, 'PUBLICATION_RECOVERY_OWNER_UNKNOWN');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
