'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const { createGenerationHelpers } = require('../statement-generation-business');
const {
  assertDistinctTaskOwnedPaths,
  resolveTaskStagingResource,
  validateTaskOwnedStagingPath
} = require('./staging-ownership');
const { MAX_ARTIFACT_BYTES } = require('./generation-contracts');

class StatementGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementGenerationError';
    this.code = code;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function warningSummary(warnings) {
  const byType = {};
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    const type = typeof warning?.type === 'string' && warning.type.length <= 64
      ? warning.type
      : 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }
  return Object.freeze({
    count: Object.values(byType).reduce((sum, count) => sum + count, 0),
    byType: Object.freeze(byType),
    manualBalanceRequired: Boolean(byType['balance-seed-required'])
  });
}

function assertSourcesCurrent(entries) {
  for (const entry of entries) {
    let stat;
    try {
      stat = fs.lstatSync(entry.filePath, { bigint: true });
    } catch (_error) {
      throw new StatementGenerationError(
        'STATEMENT_GENERATION_INPUT_STALE',
        'Statement source evidence changed before generation'
      );
    }
    if (stat.isSymbolicLink() || !stat.isFile() ||
        !sourceSnapshotMatchesStat(entry.sourceEvidence.snapshot, stat)) {
      throw new StatementGenerationError(
        'STATEMENT_GENERATION_INPUT_STALE',
        'Statement source evidence changed before generation'
      );
    }
  }
}

function workbookOutputRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  if (workbook.SheetNames.length !== 1) {
    throw new StatementGenerationError(
      'STATEMENT_GENERATION_WORKBOOK_INVALID',
      'Statement workbook must contain exactly one sheet'
    );
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: true
  });
  return Math.max(0, rows.length - 1);
}

function removeArtifacts(paths, options = {}) {
  for (const filePath of paths) {
    try {
      validateTaskOwnedStagingPath({
        stagingRoot: options.stagingRoot,
        candidatePath: filePath,
        finalState: 'file'
      });
      fs.rmSync(filePath, { force: true });
    } catch (_error) {}
  }
}

function resolveArtifactPlans(stagingRoot, artifacts) {
  try {
    const plans = artifacts.map((artifact) => Object.freeze({
      artifact,
      generationPath: resolveTaskStagingResource(stagingRoot, artifact.stagingResourceId)
    }));
    for (const plan of plans) {
      validateTaskOwnedStagingPath({
        stagingRoot,
        candidatePath: plan.generationPath,
        finalState: 'missing',
        allowMissingAncestors: true
      });
    }
    assertDistinctTaskOwnedPaths(plans.map((plan) => plan.generationPath));
    return Object.freeze(plans);
  } catch (error) {
    if (error && error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID') {
      throw new StatementGenerationError(
        error.reason === 'collision'
          ? 'STATEMENT_GENERATION_STAGING_COLLISION'
          : 'STATEMENT_GENERATION_STAGING_PATH_INVALID',
        error.message
      );
    }
    throw error;
  }
}

function executeStatementGeneration(options) {
  const {
    session,
    entries,
    request,
    scope,
    inputEvidenceHash,
    stagingRoot,
    storageRoot,
    balanceTemplatePath,
    assertNotCancelled = () => {}
  } = options;
  if (!session || !session.generationConfig || entries.length === 0) {
    throw new StatementGenerationError(
      'STATEMENT_GENERATION_EMPTY_SCOPE',
      `Statement ${scope} scope has no entries`
    );
  }
  assertSourcesCurrent(entries);
  assertNotCancelled();
  const artifactPlans = resolveArtifactPlans(stagingRoot, request.artifacts);
  const artifactPaths = {};
  for (const plan of artifactPlans) {
    fs.mkdirSync(path.dirname(plan.generationPath), { recursive: true });
  }
  try {
    for (const plan of artifactPlans) {
      validateTaskOwnedStagingPath({
        stagingRoot,
        candidatePath: plan.generationPath,
        finalState: 'missing'
      });
      artifactPaths[plan.artifact.kind] = plan.generationPath;
    }
    assertDistinctTaskOwnedPaths(Object.values(artifactPaths));
  } catch (error) {
    if (error && error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID') {
      throw new StatementGenerationError(
        error.reason === 'collision'
          ? 'STATEMENT_GENERATION_STAGING_COLLISION'
          : 'STATEMENT_GENERATION_STAGING_PATH_INVALID',
        error.message
      );
    }
    throw error;
  }
  const helpers = createGenerationHelpers({
    storageRoot,
    balanceTemplatePath,
    artifactPaths
  });
  const plannedPaths = Object.values(artifactPaths);
  try {
    const preparedBatch = helpers.buildPreparedStatementBatchFromEntries({
      config: session.generationConfig,
      fileEntries: entries
    });
    assertNotCancelled();
    const generated = helpers.generateStatementFiles({
      config: session.generationConfig,
      preparedBatch,
      scope,
      includeDetail: Boolean(artifactPaths.detail),
      includeBalance: Boolean(artifactPaths.balance)
    });
    assertNotCancelled();
    const summary = warningSummary(generated.warnings);
    if (summary.manualBalanceRequired) {
      throw new StatementGenerationError(
        'STATEMENT_MANUAL_BALANCE_REQUIRED',
        'Statement balance requires manual seed settlement'
      );
    }
    assertSourcesCurrent(entries);
    const inputRows = Math.max(0, preparedBatch.detailRows.length - 1);
    const artifacts = request.artifacts.map((plan) => {
      const generatedFile = generated[plan.kind];
      if (!generatedFile || path.resolve(generatedFile.filePath) !== artifactPaths[plan.kind]) {
        throw new StatementGenerationError(
          'STATEMENT_GENERATION_ARTIFACT_MISSING',
          `Statement ${plan.kind} artifact is missing`
        );
      }
      let ownership;
      try {
        ownership = validateTaskOwnedStagingPath({
          stagingRoot,
          candidatePath: generatedFile.filePath,
          finalState: 'file'
        });
      } catch (error) {
        if (error && error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID') {
          throw new StatementGenerationError(
            'STATEMENT_GENERATION_ARTIFACT_INVALID',
            error.message
          );
        }
        throw error;
      }
      const stat = ownership.stat;
      const artifactSize = Number(stat.size);
      if (!Number.isSafeInteger(artifactSize) || artifactSize < 1 ||
          artifactSize > MAX_ARTIFACT_BYTES) {
        throw new StatementGenerationError(
          'STATEMENT_GENERATION_ARTIFACT_INVALID',
          `Statement ${plan.kind} artifact is invalid`
        );
      }
      return Object.freeze({
        artifactKey: plan.artifactKey,
        generationPath: generatedFile.filePath,
        size: artifactSize,
        sha256: sha256File(generatedFile.filePath),
        rowCounts: Object.freeze({ input: inputRows, output: workbookOutputRows(generatedFile.filePath) }),
        warningSummary: summary,
        sessionRevision: request.sessionRevision,
        inputEvidenceHash
      });
    });
    return Object.freeze({
      status: 'generated',
      scope,
      artifacts: Object.freeze(artifacts),
      warningSummary: summary,
      sessionRevision: request.sessionRevision,
      inputEvidenceHash
    });
  } catch (error) {
    removeArtifacts(plannedPaths, { stagingRoot });
    throw error;
  }
}

module.exports = {
  StatementGenerationError,
  assertSourcesCurrent,
  executeStatementGeneration,
  removeArtifacts,
  resolveArtifactPlans,
  sha256File,
  warningSummary
};
