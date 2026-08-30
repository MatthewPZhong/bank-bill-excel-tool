'use strict';

const fs = require('node:fs');

const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { writeResultWorkbook } = require('../../position-reconciliation/excel-io');
const {
  writeRunFilteredSourcesWorkbook
} = require('../../position-reconciliation/filtered-source-report');
const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { normalizePositionReadOnlyExportInput } = require('./actions');
const {
  assertPositionSourceSnapshot,
  openPositionExportStore,
  readPositionSourceSnapshotFromStore,
  withReadSnapshot
} = require('./query');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw workerError('POSITION_EXPORT_CANCELLED', 'Position read-only export 已取消');
  }
}

async function executePositionReadOnlyExport(rawInput, signal) {
  const input = normalizePositionReadOnlyExportInput(rawInput);
  const generationPath = input.generationPlan.generationPath;
  let store = null;
  try {
    throwIfCancelled(signal);
    store = openPositionExportStore(input.dbPathOrManagedSource, input.stableRunEvidence);
    const snapshot = await withReadSnapshot(store, async () => {
      const current = assertPositionSourceSnapshot(
        await readPositionSourceSnapshotFromStore({
          store,
          templatePath: input.dbPathOrManagedSource.templatePath,
          variant: input.context.variant,
          runId: input.stableRunEvidence.runId,
          filters: input.context.filters,
          reportFiles: input.context.reportFiles
        }),
        input.stableRunEvidence
      );
      throwIfCancelled(signal);
      if (input.context.variant === 'filtered') {
        await writeRunFilteredSourcesWorkbook({
          outputPath: generationPath,
          run: current.run,
          filteredSources: current.filteredSources,
          reportFiles: input.context.reportFiles
        });
        return current;
      }
      const rows = store.listRunRows(current.run.id, {
        differencesOnly: input.context.variant === 'differences',
        ...input.context.filters
      });
      if (input.context.variant === 'differences' && rows.length === 0) {
        throw workerError(
          'POSITION_EXPORT_DIFFERENCE_EMPTY',
          '所选银行渠道、月份和状态下没有可导出的差异数据'
        );
      }
      await writeResultWorkbook({
        templatePath: input.dbPathOrManagedSource.templatePath,
        outputPath: generationPath,
        rows,
        highlightChanged: true
      });
      return Object.freeze({ ...current, exportedRowCount: rows.length });
    });
    throwIfCancelled(signal);
    const technical = await readOwnedArtifactEvidence(input.generationPlan);
    const business = readWorkbookBusinessEvidence(generationPath);
    const rowCount = input.context.variant === 'filtered'
      ? snapshot.filteredSources.length
      : snapshot.exportedRowCount;
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
        variant: input.context.variant,
        runId: snapshot.run.id,
        rowCount
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
    if (store) {
      try { store.close(); } catch (_closeError) { /* preserve result */ }
    }
  }
}

module.exports = { executePositionReadOnlyExport, throwIfCancelled };
