'use strict';

const { fail } = require('./contracts');
const { inspectFiles, reclaimFiles } = require('./upgrade-legacy');
async function runUpgradePipeline({ payloadStore, plan, cancelToken }) {
  const safePoint = () => { if (cancelToken.cancelled) fail('BIZOP_CANCELLED'); };
  safePoint();
  if (!['inspect', 'reclaim'].includes(plan.step)) fail('BIZOP_UPGRADE_PLAN_INVALID');
  const result = plan.step === 'inspect'
    ? await inspectFiles(plan.userDataDir, plan.names, plan.quiescent === true, safePoint)
    : await reclaimFiles(plan.userDataDir, plan.files, safePoint);
  const value = { schemaVersion: 1, taskRunId: plan.taskRunId, intentDigest: plan.intentDigest,
    candidateRef: plan.candidateRef, step: plan.step, result };
  const saved = payloadStore.writeDocument(`operations/${plan.taskRunId}/${plan.candidateRef}.json`, value);
  return { contractVersion: 1, candidateRef: plan.candidateRef, rowCount: result.length, sha256: saved.digest };
}
module.exports = { runUpgradePipeline };
