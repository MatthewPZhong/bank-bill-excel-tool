'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../archive-center/source-snapshot');
const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { validateTaskOwnedStagingPath } = require('../../statement-worker/staging-ownership');
const { writeDiffWorkbook } = require('../../acquiring-bill-currency-writer');
const { readOwnedArtifactEvidence } = require('../common/artifact-evidence');
const { readWorkbookBusinessEvidence } = require('../common/workbook-evidence');
const { normalizeAcquiringExportInput } = require('./actions');
const {
  ACQUIRING_EXPORT_ACTIONS
} = require('./policies');
const { readRegenerateEvidenceFromDb } = require('./query');

function executorError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    throw executorError('ACQUIRING_EXPORT_CANCELLED', 'Acquiring export 已取消');
  }
}

function copySourceStat(source) {
  let stat;
  try {
    stat = fs.lstatSync(source.filePath, { bigint: true });
  } catch (cause) {
    throw executorError('ACQUIRING_COPY_SOURCE_UNAVAILABLE', 'Acquiring copy source 不可读', cause);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n ||
      path.resolve(fs.realpathSync(source.filePath)) !== source.canonicalPath ||
      !sourceSnapshotMatchesStat(source.sourceSnapshot, stat) ||
      Number(stat.size) !== source.byteSize) {
    throw executorError('ACQUIRING_COPY_SOURCE_STALE', 'Acquiring copy source identity 已变化');
  }
  return stat;
}

async function sha256WithCancellation(filePath, signal) {
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of fs.createReadStream(filePath)) {
      throwIfCancelled(signal);
      hash.update(chunk);
    }
  } catch (error) {
    if (error && error.code === 'ACQUIRING_EXPORT_CANCELLED') throw error;
    throw executorError('ACQUIRING_EXPORT_FILE_READ_FAILED', 'Acquiring export 文件读取失败', error);
  }
  throwIfCancelled(signal);
  return hash.digest('hex');
}

async function assertCopySourceCurrent(source, signal) {
  const before = copySourceStat(source);
  const sha256 = await sha256WithCancellation(source.canonicalPath, signal);
  const after = copySourceStat(source);
  const beforeSnapshot = sourceSnapshotFromStat(before);
  if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, after) ||
      sha256 !== source.contentSha256) {
    throw executorError('ACQUIRING_COPY_SOURCE_STALE', 'Acquiring copy source 内容已变化');
  }
  return true;
}

function cleanupOwnedStaging(input) {
  try {
    const owned = validateTaskOwnedStagingPath({
      stagingRoot: input.generationPlan.stagingRoot,
      candidatePath: input.generationPlan.generationPath,
      finalState: 'missing-or-file'
    });
    if (owned.exists) fs.rmSync(owned.candidate, { force: true });
  } catch (_error) { /* task owner performs final cleanup */ }
}

async function executeCopy(input, signal) {
  const plan = input.generationPlan;
  try {
    throwIfCancelled(signal);
    validateTaskOwnedStagingPath({
      stagingRoot: plan.stagingRoot,
      candidatePath: plan.generationPath,
      finalState: 'missing'
    });
    await assertCopySourceCurrent(input.dbPathOrManagedSource, signal);
    throwIfCancelled(signal);
    await fs.promises.copyFile(
      input.dbPathOrManagedSource.canonicalPath,
      plan.generationPath,
      fs.constants.COPYFILE_EXCL
    );
    throwIfCancelled(signal);
    await assertCopySourceCurrent(input.dbPathOrManagedSource, signal);
    const owned = validateTaskOwnedStagingPath({
      stagingRoot: plan.stagingRoot,
      candidatePath: plan.generationPath,
      finalState: 'file'
    });
    const copiedSha256 = await sha256WithCancellation(owned.candidate, signal);
    if (Number(owned.stat.size) !== input.dbPathOrManagedSource.byteSize ||
        copiedSha256 !== input.dbPathOrManagedSource.contentSha256) {
      throw executorError('ACQUIRING_COPY_ARTIFACT_TAMPERED', 'Acquiring copy 结果与 source 不一致');
    }
    return Object.freeze({
      contractVersion: 1,
      actionKey: input.actionKey,
      operationKey: input.operationKey,
      taskRunId: input.taskRunId,
      sourceDigest: input.stableRunEvidence.sourceDigest,
      artifacts: Object.freeze([Object.freeze({
        outputArtifactKey: plan.outputArtifactKey,
        byteSize: Number(owned.stat.size),
        sha256: copiedSha256,
        businessDigest: copiedSha256,
        sheetCount: 0,
        dataRowCount: 0
      })]),
      summary: Object.freeze({
        kind: input.context.kind,
        monthKey: input.context.monthKey,
        runId: input.context.runId
      })
    });
  } catch (error) {
    cleanupOwnedStaging(input);
    throw error;
  }
}

async function executeRegenerate(input, signal) {
  const plan = input.generationPlan;
  let db = null;
  try {
    throwIfCancelled(signal);
    validateTaskOwnedStagingPath({
      stagingRoot: plan.stagingRoot,
      candidatePath: plan.generationPath,
      finalState: 'missing'
    });
    db = new DatabaseSync(input.dbPathOrManagedSource.databasePath, { readOnly: true });
    db.exec('BEGIN');
    const currentEvidence = readRegenerateEvidenceFromDb(db, {
      sourceKind: input.dbPathOrManagedSource.sourceKind,
      monthKey: input.context.monthKey,
      runId: input.context.runId,
      mirrorId: input.stableRunEvidence.mirrorId
    });
    if (canonicalSha256(currentEvidence) !== canonicalSha256(input.stableRunEvidence)) {
      throw executorError('ACQUIRING_REGENERATE_SOURCE_STALE', 'Acquiring regenerate run 已变化');
    }
    throwIfCancelled(signal);
    await writeDiffWorkbook({
      db,
      runId: input.context.runId,
      monthKey: input.context.monthKey,
      savePath: plan.generationPath,
      runElapsedMs: null
    });
    throwIfCancelled(signal);
    db.exec('COMMIT');
    const technical = await readOwnedArtifactEvidence(plan);
    const business = readWorkbookBusinessEvidence(plan.generationPath);
    return Object.freeze({
      contractVersion: 1,
      actionKey: input.actionKey,
      operationKey: input.operationKey,
      taskRunId: input.taskRunId,
      sourceDigest: input.stableRunEvidence.sourceDigest,
      artifacts: Object.freeze([Object.freeze({
        outputArtifactKey: plan.outputArtifactKey,
        byteSize: technical.byteSize,
        sha256: technical.sha256,
        businessDigest: business.businessDigest,
        sheetCount: business.sheetCount,
        dataRowCount: business.dataRowCount
      })]),
      summary: Object.freeze({
        kind: input.context.kind,
        monthKey: input.context.monthKey,
        runId: input.context.runId
      })
    });
  } catch (error) {
    if (db) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    }
    cleanupOwnedStaging(input);
    throw error;
  } finally {
    if (db) {
      try { db.close(); } catch (_closeError) { /* preserve result */ }
    }
  }
}

async function executeAcquiringExport(rawInput, signal) {
  const input = normalizeAcquiringExportInput(rawInput);
  return input.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY
    ? executeCopy(input, signal)
    : executeRegenerate(input, signal);
}

async function runAcquiringExistingDiffCopyInline({ input, signal }) {
  try {
    return await executeAcquiringExport(input, signal);
  } catch (error) {
    if (signal && signal.aborted && error && error.code === 'ACQUIRING_EXPORT_CANCELLED') {
      throw signal.reason;
    }
    throw error;
  }
}

module.exports = {
  assertCopySourceCurrent,
  cleanupOwnedStaging,
  executeAcquiringExport,
  executeCopy,
  executeRegenerate,
  runAcquiringExistingDiffCopyInline,
  sha256WithCancellation,
  throwIfCancelled
};
