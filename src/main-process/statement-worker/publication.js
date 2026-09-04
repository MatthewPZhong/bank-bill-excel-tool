'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assertFilePlanFresh } = require('../archive-center/file-plan');
const { canonicalizeJson } = require('../background-execution/canonical-json-v1');
const { pathsAlias } = require('../toolbox-target-identity');
const {
  prepareToolboxPublication,
  publishPreparedToolboxPublication
} = require('../toolbox-output-publication');
const {
  createMainExpectedArtifactDescriptors,
  fileSha256,
  validateStatementArtifactWorkbook
} = require('./artifact-descriptor');
const { validateStatementGenerationResult } = require('./generation-contracts');
const {
  assertDistinctTaskOwnedPaths,
  resolveTaskStagingResource,
  validateTaskOwnedStagingPath
} = require('./staging-ownership');

class StatementPublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementPublicationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatementPublicationError(code, message);
}

function ownershipFailure(error, missingCode = 'STATEMENT_GENERATION_PATH_INVALID') {
  if (error && error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID') {
    fail(
      error.reason === 'file-missing' ? 'STATEMENT_GENERATION_ARTIFACT_MISSING' : missingCode,
      error.message
    );
  }
  throw error;
}

function validateOwnedArtifactEvidence({ artifact, generationPath, stagingRoot, fsImpl = fs }) {
  let ownership;
  try {
    ownership = validateTaskOwnedStagingPath({
      stagingRoot,
      candidatePath: generationPath,
      finalState: 'file',
      fsImpl
    });
  } catch (error) {
    ownershipFailure(error);
  }
  if (Number(ownership.stat.size) !== artifact.size ||
      fileSha256(generationPath, fsImpl) !== artifact.sha256) {
    fail('STATEMENT_GENERATION_ARTIFACT_TAMPERED', 'Statement staging artifact failed size/hash validation');
  }
  return ownership;
}

function validateTechnicalArtifacts({
  result,
  filePlan,
  stagingRoot,
  expectedArtifacts,
  fsImpl = fs
}) {
  if (!validateStatementGenerationResult(result)) {
    fail('STATEMENT_GENERATION_MANIFEST_INVALID', 'Statement artifact manifest is invalid');
  }
  let descriptors;
  try {
    descriptors = createMainExpectedArtifactDescriptors(expectedArtifacts);
  } catch (error) {
    fail(error.code || 'STATEMENT_EXPECTED_ARTIFACT_INVALID', error.message);
  }
  if (!filePlan || filePlan.allocation !== 'eager' || !Array.isArray(filePlan.outputs) ||
      result.artifacts.length !== filePlan.outputs.length ||
      result.artifacts.length !== descriptors.length || result.artifacts.length < 1 ||
      result.artifacts.length > 2) {
    fail('STATEMENT_GENERATION_FILE_PLAN_INVALID', 'Statement FilePlan does not match artifact count');
  }
  assertFilePlanFresh(filePlan, { fsImpl });
  const expectedSourceOperation = `statement:generate-${result.scope}`;
  const technicalArtifacts = result.artifacts.map((artifact, index) => {
    const output = filePlan.outputs[index];
    const expected = descriptors[index];
    if (artifact.artifactKey !== output.artifactKey || artifact.artifactKey !== expected.artifactKey ||
        output.sourceOperation !== expectedSourceOperation) {
      fail('STATEMENT_GENERATION_OWNERSHIP_MISMATCH', 'Statement artifact ownership does not match FilePlan');
    }
    if (artifact.rowCounts.input !== expected.rowCounts.input ||
        artifact.rowCounts.output !== expected.rowCounts.output) {
      fail('STATEMENT_GENERATION_ROW_COUNTS_MISMATCH', 'Statement manifest does not match Main rowCounts');
    }
    if (artifact.sessionRevision !== expected.sessionRevision ||
        artifact.inputEvidenceHash !== expected.inputEvidenceHash ||
        canonicalizeJson(artifact.warningSummary) !== canonicalizeJson(expected.warningSummary)) {
      fail('STATEMENT_GENERATION_SESSION_EVIDENCE_MISMATCH', 'Statement manifest does not match Main evidence');
    }
    let expectedPath;
    try {
      expectedPath = resolveTaskStagingResource(stagingRoot, expected.stagingResourceId);
    } catch (error) {
      ownershipFailure(error);
    }
    if (path.resolve(artifact.generationPath) !== expectedPath) {
      fail('STATEMENT_GENERATION_OWNERSHIP_MISMATCH', 'Statement manifest path does not match Main staging resource');
    }
    for (const item of [...filePlan.inputs, ...filePlan.outputs]) {
      if (pathsAlias(fsImpl, expectedPath, item.filePath, {
        allowMissingParentLexicalFallback: true
      })) {
        fail('STATEMENT_GENERATION_PATH_INVALID', 'Statement staging aliases FilePlan input/output');
      }
    }
    const ownership = validateOwnedArtifactEvidence({
      artifact,
      generationPath: expectedPath,
      stagingRoot,
      fsImpl
    });
    return Object.freeze({ artifact, output, expected, generationPath: expectedPath, ownership });
  });
  try {
    assertDistinctTaskOwnedPaths(
      technicalArtifacts.map(({ generationPath }) => generationPath),
      { fsImpl }
    );
  } catch (error) {
    ownershipFailure(error);
  }
  return Object.freeze(technicalArtifacts);
}

function validateBusinessArtifacts(technicalArtifacts, options = {}) {
  const expectedInputRows = technicalArtifacts[0].artifact.rowCounts.input;
  for (const { artifact, expected, generationPath } of technicalArtifacts) {
    if (artifact.warningSummary.manualBalanceRequired) {
      fail('STATEMENT_MANUAL_BALANCE_REQUIRED', 'Manual balance settlement is not part of E09-C');
    }
    try {
      validateStatementArtifactWorkbook({
        filePath: generationPath,
        descriptor: expected,
        balanceTemplatePath: options.balanceTemplatePath
      });
    } catch (error) {
      fail(error.code || 'STATEMENT_GENERATION_WORKBOOK_INVALID', error.message);
    }
    if (artifact.rowCounts.input !== expectedInputRows) {
      fail('STATEMENT_GENERATION_ROW_COUNTS_MISMATCH', 'Statement workbook rowCounts mismatch');
    }
  }
  return technicalArtifacts;
}

function journalPublisher({
  taskId,
  userDataDir,
  technicalArtifacts,
  stagingRoot,
  fsImpl = fs,
  options = {}
}) {
  for (const { artifact, generationPath } of technicalArtifacts) {
    validateOwnedArtifactEvidence({ artifact, generationPath, stagingRoot, fsImpl });
  }
  try {
    assertDistinctTaskOwnedPaths(
      technicalArtifacts.map(({ generationPath }) => generationPath),
      { fsImpl }
    );
  } catch (error) {
    ownershipFailure(error);
  }
  const artifacts = technicalArtifacts.map(({ artifact, generationPath }) => ({
    generationPath,
    byteSize: artifact.size,
    sha256: artifact.sha256,
    dataRowCount: artifact.rowCounts.output,
    sheetCount: 1,
    warningSummary: artifact.warningSummary
  }));
  const targets = technicalArtifacts.map(({ output }) => ({
    targetPath: output.filePath,
    expectedTargetSnapshot: output.targetSnapshot,
    fileName: output.originalName
  }));
  const runtimeOptions = {};
  for (const key of ['checkpoint', 'now', 'randomUUID']) {
    if (options && typeof options[key] === 'function') {
      runtimeOptions[key] = options[key];
    }
  }
  const prepared = prepareToolboxPublication({
    ...runtimeOptions,
    fsImpl,
    taskId,
    userDataDir,
    artifacts,
    targets,
    requireValidatedArtifacts: true,
    requireArchiveHandoff: false
  });
  return publishPreparedToolboxPublication(prepared);
}

function cleanupStatementStagingResources({ stagingRoot, resourceIds, fsImpl = fs }) {
  const disposed = [];
  const warnings = [];
  for (const resourceId of [...new Set(Array.isArray(resourceIds) ? resourceIds : [])]) {
    let candidate;
    try {
      candidate = resolveTaskStagingResource(stagingRoot, resourceId);
      validateTaskOwnedStagingPath({
        stagingRoot,
        candidatePath: candidate,
        finalState: 'file',
        fsImpl
      });
      fsImpl.rmSync(candidate, { force: true });
      disposed.push(candidate);
    } catch (error) {
      if (error && error.code === 'STATEMENT_STAGING_OWNERSHIP_INVALID' &&
          error.reason === 'file-missing') {
        continue;
      }
      warnings.push(`拒绝清理非Statement task-owned staging：${candidate || String(resourceId)}`);
    }
  }
  return Object.freeze({ disposed: Object.freeze(disposed), warnings: Object.freeze(warnings) });
}

function safeExpectedResourceIds(expectedArtifacts) {
  try {
    return createMainExpectedArtifactDescriptors(expectedArtifacts)
      .map((descriptor) => descriptor.stagingResourceId);
  } catch (_error) {
    return [];
  }
}

async function validateAndPublishStatementGeneration(options = {}) {
  const {
    result,
    filePlan,
    stagingRoot,
    expectedArtifacts,
    taskId,
    userDataDir,
    publisher = journalPublisher,
    publisherOptions = {},
    balanceTemplatePath,
    fsImpl = fs
  } = options;
  const cleanupResourceIds = safeExpectedResourceIds(expectedArtifacts);
  let technicalArtifacts;
  let preserveTemporaryFiles = false;
  try {
    technicalArtifacts = validateTechnicalArtifacts({
      result,
      filePlan,
      stagingRoot,
      expectedArtifacts,
      fsImpl
    });
    validateBusinessArtifacts(technicalArtifacts, { balanceTemplatePath });
    const publication = await publisher({
      taskId,
      userDataDir,
      technicalArtifacts,
      stagingRoot,
      fsImpl,
      options: publisherOptions
    });
    return Object.freeze({
      artifacts: Object.freeze(technicalArtifacts.map(({ artifact }) => artifact)),
      publication
    });
  } catch (error) {
    preserveTemporaryFiles = error && error.preserveTemporaryFiles === true;
    throw error;
  } finally {
    if (!preserveTemporaryFiles && cleanupResourceIds.length > 0) {
      cleanupStatementStagingResources({
        stagingRoot,
        resourceIds: cleanupResourceIds,
        fsImpl
      });
    }
  }
}

module.exports = {
  StatementPublicationError,
  cleanupStatementStagingResources,
  journalPublisher,
  validateAndPublishStatementGeneration,
  validateBusinessArtifacts,
  validateTechnicalArtifacts
};
