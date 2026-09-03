'use strict';

const fs = require('node:fs');

const { writeChannelWorkbook } = require('../../pre-fund-reconciliation/excel-writer');
const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { normalizePreFundReadOnlyExportInput } = require('./actions');
const {
  assertPreFundSourceSnapshot,
  openReadDatabase,
  readChannelExport,
  readPreFundSourceSnapshotFromDatabases
} = require('./query');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw workerError('PRE_FUND_EXPORT_CANCELLED', 'PreFund read-only export 已取消');
  }
}

function locatorFromEvidence(evidence) {
  return Object.freeze({
    mirrorRunId: evidence.mirrorRunId,
    monthKey: evidence.monthKey,
    sideRunId: evidence.sideRunId,
    archiveTaskRunId: evidence.archiveTaskRunId
  });
}

function findExactChannel(snapshot, context) {
  const matches = snapshot.channels.filter((item) => (
    item.channel === context.channel && item.channelDigest === context.channelDigest
  ));
  if (matches.length !== 1 ||
      matches[0].hasDuplicateRecords !== context.hasDuplicateRecords) {
    throw workerError(
      'PRE_FUND_EXPORT_CHANNEL_STALE',
      'PreFund export 渠道身份或审计分类已变化'
    );
  }
  return matches[0];
}

function rollbackQuietly(db) {
  if (!db) return;
  try { db.exec('ROLLBACK'); } catch (_error) { /* preserve original */ }
}

async function executePreFundReadOnlyExport(rawInput, signal) {
  const input = normalizePreFundReadOnlyExportInput(rawInput);
  const generationPath = input.generationPlan.generationPath;
  let mainDb = null;
  let sideDb = null;
  let mainTransaction = false;
  let sideTransaction = false;
  try {
    throwIfCancelled(signal);
    mainDb = openReadDatabase(input.dbPathOrManagedSource.mainDatabasePath);
    sideDb = openReadDatabase(input.dbPathOrManagedSource.sideDatabasePath);
    mainDb.exec('BEGIN');
    mainTransaction = true;
    sideDb.exec('BEGIN');
    sideTransaction = true;

    const frozen = assertPreFundSourceSnapshot(
      readPreFundSourceSnapshotFromDatabases({
        mainDb,
        sideDb,
        sideDbPath: input.dbPathOrManagedSource.sideDatabasePath,
        templatePath: input.dbPathOrManagedSource.templatePath,
        userDataDir: input.dbPathOrManagedSource.userDataDir,
        locator: locatorFromEvidence(input.stableRunEvidence)
      }),
      input.stableRunEvidence
    );
    const channel = findExactChannel(frozen, input.context);
    throwIfCancelled(signal);

    const legacyResult = await writeChannelWorkbook({
      templatePath: input.dbPathOrManagedSource.templatePath,
      outputPath: generationPath,
      ...readChannelExport(
        sideDb,
        input.stableRunEvidence.sideRunId,
        channel.channel,
        channel.hasDuplicateRecords
      )
    });
    throwIfCancelled(signal);

    sideDb.exec('COMMIT');
    sideTransaction = false;
    mainDb.exec('COMMIT');
    mainTransaction = false;

    const rowCounts = legacyResult && legacyResult.rowCounts;
    if (!rowCounts || typeof rowCounts !== 'object') {
      throw workerError('PRE_FUND_EXPORT_GENERATION_FAILED', 'PreFund writer 未返回行数证据');
    }
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
      summary: Object.freeze({
        channelDigest: input.context.channelDigest,
        hasDuplicateRecords: input.context.hasDuplicateRecords,
        balancedCount: Number(rowCounts.balanced) || 0,
        unbalancedCount: Number(rowCounts.unbalanced) || 0,
        channelBillCount: Number(rowCounts.channelBill) || 0,
        duplicateGatewayCount: Number(rowCounts.duplicateGateway) || 0
      })
    });
  } catch (error) {
    if (sideTransaction) rollbackQuietly(sideDb);
    if (mainTransaction) rollbackQuietly(mainDb);
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
    if (sideDb) { try { sideDb.close(); } catch (_error) { /* preserve result */ } }
    if (mainDb) { try { mainDb.close(); } catch (_error) { /* preserve result */ } }
  }
}

module.exports = {
  executePreFundReadOnlyExport,
  findExactChannel,
  locatorFromEvidence,
  throwIfCancelled
};
