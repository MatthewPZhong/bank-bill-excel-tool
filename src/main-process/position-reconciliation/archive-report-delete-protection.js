'use strict';

const { positionReportSourceIdentity } = require('../../backend/position-report-source-identity');

const { openPositionReconciliationStoreReadOnly } = require('./store');
const { normalizePositionCheckpoint } = require('./side-db-mutation');

// 只读核对原 operation/artifact；不打开可写 Store，不从缺库或新同名库推断无引用。
function createPositionReportDeleteProtection({ userDataPath, getExpectedCheckpoint }) {
  return ({ batch, artifacts }) => {
    if (!artifacts.length) return [];
    const expectedCheckpoint = normalizePositionCheckpoint(getExpectedCheckpoint());
    if (!expectedCheckpoint || batch.moduleId !== 'position-reconciliation-process'
        || typeof batch.operationKey !== 'string' || !batch.operationKey) {
      throw new Error('平盘报告缺少可验证的原侧库及业务身份');
    }
    const store = openPositionReconciliationStoreReadOnly(userDataPath, { expectedCheckpoint });
    try {
      const active = store.db.prepare(`SELECT 1 FROM position_filtered_source_rows
        WHERE archive_operation_key=? AND report_artifact_key=? AND resolved_at IS NULL LIMIT 1`);
      const frozen = store.db.prepare(`SELECT 1 FROM position_run_filtered_sources
        WHERE archive_operation_key=? AND report_artifact_key=? LIMIT 1`);
      return artifacts.filter((artifact) => {
        const producerKey = artifact.metadata?.preGeneratedOutput?.producerArtifactKey;
        if (typeof artifact.artifactKey !== 'string' || !artifact.artifactKey
            || !positionReportSourceIdentity(artifact.sourcePath, producerKey)) {
          throw new Error('平盘报告缺少原 artifact 身份');
        }
        return active.get(batch.operationKey, producerKey)
          || frozen.get(batch.operationKey, producerKey);
      }).map((artifact) => artifact.sourcePath);
    } finally { store.close(); }
  };
}

module.exports = { createPositionReportDeleteProtection };
