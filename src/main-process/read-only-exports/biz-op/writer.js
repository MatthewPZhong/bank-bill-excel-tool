'use strict';

const fs = require('node:fs');

const bizOpReconRunData = require('../../biz-op-recon-run-data');
const {
  writeDateRangeDiffWorkbook,
  writeSingleDateDiffWorkbook
} = require('../../biz-op-recon-writer');
const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { normalizeBizOpReadOnlyExportInput } = require('./actions');
const {
  assertBizOpSourceSnapshot,
  assertSourceGroupEvidence,
  openBizOpReadDatabase,
  readBizOpSourceSnapshot
} = require('./query');
const { BIZ_OP_READ_ONLY_ACTIONS } = require('./policies');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw workerError('BIZ_OP_EXPORT_CANCELLED', 'BizOP read-only export 已取消');
  }
}

function selectorForInput(input) {
  return input.actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY
    ? Object.freeze({ kind: 'biz-op-day', mirrorRunId: input.context.mirrorRunId })
    : Object.freeze({
        kind: 'biz-op-range',
        buName: input.context.buName,
        startDate: input.context.startDate,
        endDate: input.context.endDate
      });
}

function buildFrozenExportDb(input, signal) {
  const source = input.dbPathOrManagedSource;
  const mainDb = openBizOpReadDatabase(source.mainDatabasePath);
  let memDb = null;
  mainDb.exec('BEGIN');
  try {
    const snapshot = assertBizOpSourceSnapshot(readBizOpSourceSnapshot({
      userDataDir: source.userDataDir,
      mainDb,
      selector: selectorForInput(input),
      openSourceDb: openBizOpReadDatabase
    }), input.stableRunEvidence);
    throwIfCancelled(signal);
    memDb = bizOpReconRunData.buildFrozenRangeExportDb({
      userDataDir: source.userDataDir,
      mainDb,
      runLocators: snapshot.runLocators,
      openSourceDb: openBizOpReadDatabase,
      mainSnapshotActive: true,
      beforeCopyGroup({ sourceKey, srcDb, selections }) {
        assertSourceGroupEvidence(srcDb, selections, snapshot.sourceGroups, sourceKey);
        throwIfCancelled(signal);
      }
    });
    mainDb.exec('COMMIT');
    return Object.freeze({ memDb, snapshot });
  } catch (error) {
    try { mainDb.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve */ }
    if (memDb) { try { memDb.close(); } catch (_closeError) { /* preserve */ } }
    throw error;
  } finally {
    mainDb.close();
  }
}

async function executeBizOpReadOnlyExport(rawInput, signal) {
  const input = normalizeBizOpReadOnlyExportInput(rawInput);
  const generationPath = input.generationPlan.generationPath;
  let memDb = null;
  try {
    throwIfCancelled(signal);
    const frozen = buildFrozenExportDb(input, signal);
    memDb = frozen.memDb;
    const legacyResult = input.actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY
      ? await writeSingleDateDiffWorkbook({
          db: memDb,
          date: frozen.snapshot.runLocators[0].date,
          buName: frozen.snapshot.runLocators[0].buName,
          runId: frozen.snapshot.runLocators[0].sideRunId,
          savePath: generationPath
        })
      : await writeDateRangeDiffWorkbook({
          db: memDb,
          buName: input.context.buName,
          startDate: input.context.startDate,
          endDate: input.context.endDate,
          savePath: generationPath
        });
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
      summary: input.actionKey === BIZ_OP_READ_ONLY_ACTIONS.DAY
        ? Object.freeze({ rowCount: Number(legacyResult.rowCount) || 0 })
        : Object.freeze({
            sheetCount: Number(legacyResult.sheetCount) || 0,
            rowCount: Number(legacyResult.rowCount) || 0,
            skippedDates: Object.freeze((legacyResult.skippedDates || []).slice())
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
  } finally {
    if (memDb) { try { memDb.close(); } catch (_closeError) { /* swallow */ } }
  }
}

module.exports = {
  buildFrozenExportDb,
  executeBizOpReadOnlyExport,
  selectorForInput,
  throwIfCancelled
};
