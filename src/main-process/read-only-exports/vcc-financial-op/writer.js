'use strict';

const fs = require('node:fs');

const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { writeImportAuditWorkbook } = require('../../vcc-financial-op-audit-writer');
const { writeDatasetWorkbook } = require('../../vcc-financial-op-dataset-writer');
const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { normalizeVccFinancialOpReadOnlyExportInput } = require('./actions');
const {
  assertVccFinancialOpSourceSnapshot,
  openVccFinancialOpExportDatabase,
  readVccDatasetSourceSnapshotFromDb,
  readVccImportAuditSourceSnapshotFromDb,
  withReadSnapshot
} = require('./query');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw workerError('VCC_FINANCIAL_OP_EXPORT_CANCELLED', 'VCC Financial OP read-only export 已取消');
  }
}

async function writeAudit(input, db, signal) {
  return withReadSnapshot(db, async () => {
    const current = assertVccFinancialOpSourceSnapshot(
      readVccImportAuditSourceSnapshotFromDb(db, input.context.recordId),
      input.stableRunEvidence
    );
    throwIfCancelled(signal);
    const result = await writeImportAuditWorkbook({
      db,
      recordId: input.context.recordId,
      outputPath: input.generationPlan.generationPath
    });
    return Object.freeze({ current, result });
  });
}

async function writeDataset(input, db, signal) {
  let current = null;
  const result = await writeDatasetWorkbook({
    db,
    targetMonth: input.context.targetMonth,
    sourceType: input.context.sourceType,
    targetKind: input.context.targetKind,
    outputPath: input.generationPlan.generationPath,
    archiveSources: input.context.archiveSources,
    expectedInspection: input.context.expectedInspection,
    assertSourceFresh() {
      current = assertVccFinancialOpSourceSnapshot(
        readVccDatasetSourceSnapshotFromDb({
          db,
          targetMonth: input.context.targetMonth,
          sourceType: input.context.sourceType,
          targetKind: input.context.targetKind,
          archiveSources: input.context.archiveSources
        }),
        input.stableRunEvidence
      );
      throwIfCancelled(signal);
    }
  });
  return Object.freeze({ current, result });
}

function resultSummary(input, written) {
  if (input.stableRunEvidence.variant === 'import-audit') {
    return Object.freeze({
      variant: 'import-audit',
      recordId: written.result.recordId,
      rowCount: written.result.rowCount,
      sheetCount: written.result.sheetCount
    });
  }
  return Object.freeze({
    variant: 'dataset',
    targetMonth: written.result.targetMonth,
    sourceType: written.result.sourceType,
    targetKind: written.result.targetKind,
    dataCount: written.result.dataCount,
    totalRows: written.result.totalRows,
    missingRows: written.result.missingRows,
    incomplete: written.result.incomplete,
    sheetCount: written.result.sheetCount
  });
}

async function executeVccFinancialOpReadOnlyExport(rawInput, signal) {
  const input = normalizeVccFinancialOpReadOnlyExportInput(rawInput);
  const generationPath = input.generationPlan.generationPath;
  let db = null;
  try {
    throwIfCancelled(signal);
    db = openVccFinancialOpExportDatabase(input.dbPathOrManagedSource);
    const written = input.stableRunEvidence.variant === 'import-audit'
      ? await writeAudit(input, db, signal)
      : await writeDataset(input, db, signal);
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
      summary: resultSummary(input, written)
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
    if (db) {
      try { db.close(); } catch (_closeError) { /* preserve result */ }
    }
  }
}

module.exports = {
  executeVccFinancialOpReadOnlyExport,
  resultSummary,
  throwIfCancelled,
  writeAudit,
  writeDataset
};
