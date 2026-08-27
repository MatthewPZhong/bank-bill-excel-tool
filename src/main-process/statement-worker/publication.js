'use strict';

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { assertFilePlanFresh } = require('../archive-center/file-plan');
const { pathsAlias } = require('../toolbox-target-identity');
const {
  disposeToolboxGeneration,
  prepareToolboxPublication,
  publishPreparedToolboxPublication
} = require('../toolbox-output-publication');
const { validateStatementGenerationResult } = require('./generation-contracts');
const { sha256File } = require('./generation');

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

function insideStagingRoot(stagingRoot, generationPath) {
  const root = path.resolve(stagingRoot);
  const candidate = path.resolve(generationPath);
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function validateTechnicalArtifacts({ result, filePlan, stagingRoot, fsImpl = fs }) {
  if (!validateStatementGenerationResult(result)) {
    fail('STATEMENT_GENERATION_MANIFEST_INVALID', 'Statement artifact manifest is invalid');
  }
  if (!filePlan || filePlan.allocation !== 'eager' || !Array.isArray(filePlan.outputs) ||
      result.artifacts.length !== filePlan.outputs.length || result.artifacts.length < 1 ||
      result.artifacts.length > 2) {
    fail('STATEMENT_GENERATION_FILE_PLAN_INVALID', 'Statement FilePlan does not match artifact count');
  }
  assertFilePlanFresh(filePlan, { fsImpl });
  const expectedSourceOperation = `statement:generate-${result.scope}`;
  return Object.freeze(result.artifacts.map((artifact, index) => {
    const output = filePlan.outputs[index];
    if (artifact.artifactKey !== output.artifactKey ||
        output.sourceOperation !== expectedSourceOperation) {
      fail('STATEMENT_GENERATION_OWNERSHIP_MISMATCH', 'Statement artifact ownership does not match FilePlan');
    }
    if (!insideStagingRoot(stagingRoot, artifact.generationPath)) {
      fail('STATEMENT_GENERATION_PATH_INVALID', 'Statement artifact is outside task staging');
    }
    for (const item of [...filePlan.inputs, ...filePlan.outputs]) {
      if (pathsAlias(fsImpl, artifact.generationPath, item.filePath, {
        allowMissingParentLexicalFallback: true
      })) {
        fail('STATEMENT_GENERATION_PATH_INVALID', 'Statement staging aliases FilePlan input/output');
      }
    }
    let stat;
    try {
      stat = fsImpl.lstatSync(artifact.generationPath);
    } catch (_error) {
      fail('STATEMENT_GENERATION_ARTIFACT_MISSING', 'Statement staging artifact is missing');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== artifact.size ||
        sha256File(artifact.generationPath) !== artifact.sha256) {
      fail('STATEMENT_GENERATION_ARTIFACT_TAMPERED', 'Statement staging artifact failed size/hash validation');
    }
    return Object.freeze({ artifact, output });
  }));
}

function validateBusinessArtifacts(technicalArtifacts) {
  const expectedInputRows = technicalArtifacts[0].artifact.rowCounts.input;
  for (const { artifact } of technicalArtifacts) {
    let workbook;
    try {
      workbook = XLSX.readFile(artifact.generationPath, { raw: true });
    } catch (_error) {
      fail('STATEMENT_GENERATION_WORKBOOK_INVALID', 'Statement workbook cannot be read back');
    }
    if (workbook.SheetNames.length !== 1) {
      fail('STATEMENT_GENERATION_WORKBOOK_INVALID', 'Statement workbook sheet count is invalid');
    }
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
      defval: '',
      raw: true
    });
    if (artifact.rowCounts.input !== expectedInputRows || rows.length === 0 ||
        Math.max(0, rows.length - 1) !== artifact.rowCounts.output) {
      fail('STATEMENT_GENERATION_ROW_COUNTS_MISMATCH', 'Statement workbook rowCounts mismatch');
    }
    if (artifact.warningSummary.manualBalanceRequired) {
      fail('STATEMENT_MANUAL_BALANCE_REQUIRED', 'Manual balance settlement is not part of E09-C');
    }
  }
  return technicalArtifacts;
}

function journalPublisher({ taskId, userDataDir, technicalArtifacts, options = {} }) {
  const artifacts = technicalArtifacts.map(({ artifact }) => ({
    generationPath: artifact.generationPath,
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
  const prepared = prepareToolboxPublication({
    taskId,
    userDataDir,
    artifacts,
    targets,
    requireValidatedArtifacts: true,
    requireArchiveHandoff: false,
    ...options
  });
  return publishPreparedToolboxPublication(prepared);
}

function cleanupStatementStagingResources({ stagingRoot, resourceIds, fsImpl = fs }) {
  const root = path.resolve(stagingRoot);
  const disposed = [];
  const warnings = [];
  for (const resourceId of [...new Set(Array.isArray(resourceIds) ? resourceIds : [])]) {
    const candidate = path.resolve(root, String(resourceId || ''));
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
      warnings.push(`拒绝清理越过Statement task staging的路径：${String(resourceId)}`);
      continue;
    }
    try {
      const stat = fsImpl.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        warnings.push(`Statement staging不是可清理的普通文件：${candidate}`);
        continue;
      }
      fsImpl.rmSync(candidate, { force: true });
      disposed.push(candidate);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        warnings.push(`Statement staging清理失败：${candidate}`);
      }
    }
  }
  return Object.freeze({ disposed: Object.freeze(disposed), warnings: Object.freeze(warnings) });
}

async function validateAndPublishStatementGeneration(options = {}) {
  const {
    result,
    filePlan,
    stagingRoot,
    taskId,
    userDataDir,
    publisher = journalPublisher,
    publisherOptions = {}
  } = options;
  let technicalArtifacts;
  let preserveTemporaryFiles = false;
  try {
    technicalArtifacts = validateTechnicalArtifacts({ result, filePlan, stagingRoot });
    validateBusinessArtifacts(technicalArtifacts);
    const publication = await publisher({
      taskId,
      userDataDir,
      technicalArtifacts,
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
    if (!preserveTemporaryFiles && result && Array.isArray(result.artifacts)) {
      disposeToolboxGeneration({ artifacts: result.artifacts });
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
