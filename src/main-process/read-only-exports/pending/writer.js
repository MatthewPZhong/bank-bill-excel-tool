'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const pendingExportWriter = require('../../../backend/pending-export/writer');
const {
  writePendingErrorReport
} = require('../../../backend/pending-export/error-report-writer');
const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { sha256RegularFile, readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const {
  assertManagedSourceStillRegular,
  normalizePendingReadOnlyExportInput
} = require('./actions');
const {
  assertPendingRunEvidence,
  withReadSnapshot
} = require('./query');
const {
  PENDING_READ_ONLY_ACTIONS
} = require('./policies');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw workerError('PENDING_EXPORT_CANCELLED', 'Pending read-only export 已取消');
  }
}

function openPendingReadDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
  return db;
}

async function readManagedErrorSnapshot(input) {
  const source = input.dbPathOrManagedSource;
  assertManagedSourceStillRegular(source);
  const before = await sha256RegularFile(source.filePath);
  if (before.byteSize !== source.byteSize || before.sha256 !== source.sha256 ||
      before.sha256 !== input.stableRunEvidence.sourceDigest) {
    throw workerError('PENDING_EXPORT_SOURCE_STALE', 'Pending error source 技术证据不一致');
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(source.filePath, 'utf8'));
  } catch (_error) {
    throw workerError('PENDING_EXPORT_SOURCE_INVALID', 'Pending error source JSON 非法');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray(parsed.errors) || parsed.errors.length !== input.context.errorCount) {
    throw workerError('PENDING_EXPORT_SOURCE_INVALID', 'Pending error source 数量/结构不一致');
  }
  assertManagedSourceStillRegular(source);
  const after = await sha256RegularFile(source.filePath);
  if (after.byteSize !== before.byteSize || after.sha256 !== before.sha256) {
    throw workerError('PENDING_EXPORT_SOURCE_STALE', 'Pending error source 在生成前已变化');
  }
  return parsed;
}

async function executePendingReadOnlyExport(rawInput, signal) {
  const input = normalizePendingReadOnlyExportInput(rawInput);
  const generationPath = input.generationPlan.generationPath;
  let legacyResult;
  try {
    throwIfCancelled(signal);
    if (input.actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS) {
      const snapshot = await readManagedErrorSnapshot(input);
      throwIfCancelled(signal);
      legacyResult = writePendingErrorReport(snapshot, generationPath);
    } else {
      const db = openPendingReadDatabase(input.dbPathOrManagedSource.databasePath);
      try {
        withReadSnapshot(db, () => assertPendingRunEvidence(db, input.stableRunEvidence));
        throwIfCancelled(signal);
        const options = {
          beforeBuild(currentDb) {
            assertPendingRunEvidence(currentDb, input.stableRunEvidence);
            throwIfCancelled(signal);
          }
        };
        legacyResult = input.actionKey === PENDING_READ_ONLY_ACTIONS.DIFF
          ? pendingExportWriter.exportSingleRun(
              db,
              input.stableRunEvidence.runIds[0],
              generationPath,
              options
            )
          : pendingExportWriter.exportAggregateRuns(
              db,
              input.stableRunEvidence.runIds,
              generationPath,
              options
            );
      } finally {
        db.close();
      }
    }
    if (!legacyResult || legacyResult.status !== 'success') {
      throw workerError(
        'PENDING_EXPORT_GENERATION_FAILED',
        legacyResult && legacyResult.message ? legacyResult.message : 'Pending export generation 失败'
      );
    }
    throwIfCancelled(signal);
    const technical = await readOwnedArtifactEvidence(input.generationPlan);
    const business = readWorkbookBusinessEvidence(generationPath);
    return Object.freeze({
      contractVersion: 1,
      actionKey: input.actionKey,
      operationKey: input.operationKey,
      taskRunId: input.taskRunId,
      sourceDigest: input.stableRunEvidence.sourceDigest,
      artifacts: Object.freeze([Object.freeze({
        outputArtifactKey: input.generationPlan.outputArtifactKey,
        byteSize: technical.byteSize,
        sha256: technical.sha256,
        businessDigest: business.businessDigest,
        sheetCount: business.sheetCount,
        dataRowCount: business.dataRowCount
      })]),
      summary: input.actionKey === PENDING_READ_ONLY_ACTIONS.ERRORS
        ? Object.freeze({ errorCount: Number(legacyResult.errorCount) || 0 })
        : input.actionKey === PENDING_READ_ONLY_ACTIONS.DIFF
          ? Object.freeze({
              rowCount: Number(legacyResult.rowCount) || 0,
              sheetCount: Number(legacyResult.sheetCount) || 0,
              fundTypeDiffRowCount: Number(legacyResult.fundTypeDiffRowCount) || 0,
              removalReconcileAppended: legacyResult.removalReconcileAppended === true,
              missingReconRowCount: Number(legacyResult.missingReconRowCount) || 0,
              removalOnlyRowCount: Number(legacyResult.removalOnlyRowCount) || 0
            })
          : Object.freeze({
              runsCount: Number(legacyResult.runsCount) || 0,
              rowCount: Number(legacyResult.rowCount) || 0,
              fundTypeDiffRowCount: Number(legacyResult.fundTypeDiffRowCount) || 0,
              removalDataOmitted: legacyResult.removalDataOmitted === true
            })
    });
  } catch (error) {
    try {
      const owned = validateTaskOwnedStagingPath({
        stagingRoot: input.generationPlan.stagingRoot,
        candidatePath: generationPath,
        finalState: 'missing-or-file'
      });
      if (owned.exists) fs.unlinkSync(owned.candidate);
    } catch (_cleanupError) { /* task owner performs final cleanup */ }
    throw error;
  }
}

module.exports = {
  executePendingReadOnlyExport,
  openPendingReadDatabase,
  readManagedErrorSnapshot,
  throwIfCancelled
};
