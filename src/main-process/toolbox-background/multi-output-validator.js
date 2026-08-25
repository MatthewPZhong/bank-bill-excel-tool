'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fromProtocolError } = require('../background-execution/error-codec');
const { pathsAlias } = require('../toolbox-target-identity');
const { sha256File, validateGeneratedWorkbook } = require('../toolbox-output-writer');
const {
  TOOLBOX_GENERATION_ACTIONS,
  TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES,
  TOOLBOX_GENERATION_SCHEMA_VERSION,
  generationEvidencePath,
  normalizeGenerationEvidence,
  normalizeMultiSplitInput,
  validateToolboxMultiGenerationResult
} = require('./generation-contract');
const { operationContextFromBatch } = require('./generation-validator');
const { inspectSealedRouteDb, outputPlanHash } = require('./route-db-contract');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPrivatePaths(filePlan, privatePaths) {
  const ownedPaths = [
    ...filePlan.inputs.map((item) => item.filePath),
    ...filePlan.outputs.map((item) => item.filePath)
  ];
  for (let index = 0; index < privatePaths.length; index += 1) {
    const candidate = privatePaths[index];
    for (const owned of ownedPaths) {
      if (pathsAlias(fs, candidate, owned, { allowMissingParentLexicalFallback: true })) {
        throw validationError('TOOLBOX_GENERATION_PATH_INVALID', 'task-private路径不能与FilePlan输入或正式目标重合');
      }
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (pathsAlias(fs, candidate, privatePaths[previous], {
        allowMissingParentLexicalFallback: true
      })) {
        throw validationError('TOOLBOX_GENERATION_PATH_INVALID', 'task-private路径必须互不重合');
      }
    }
  }
}

function createMultiGenerationInput({
  filePlan,
  groups,
  generationPaths,
  routeDbPath,
  routeManifestPath
}) {
  if (!filePlan || filePlan.allocation !== 'eager' || !Array.isArray(filePlan.inputs) ||
      filePlan.inputs.length !== 1 || !Array.isArray(filePlan.outputs) ||
      filePlan.outputs.length < 1 || filePlan.outputs.length > 8 ||
      !Array.isArray(groups) || groups.length !== filePlan.outputs.length ||
      !Array.isArray(generationPaths) || generationPaths.length !== groups.length) {
    throw validationError('TOOLBOX_GENERATION_FILE_PLAN_INVALID', '多文件拆分需要1..8输出的eager FilePlan');
  }
  const resolvedGenerationPaths = generationPaths.map((item) => path.resolve(String(item || '')));
  const resolvedRouteDbPath = path.resolve(String(routeDbPath || ''));
  const resolvedRouteManifestPath = path.resolve(String(routeManifestPath || ''));
  assertPrivatePaths(filePlan, [
    ...resolvedGenerationPaths,
    resolvedRouteDbPath,
    resolvedRouteManifestPath
  ]);
  return normalizeMultiSplitInput({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    sources: filePlan.inputs.map((item) => ({
      filePath: item.filePath,
      sourceSnapshot: item.sourceSnapshot
    })),
    operation: {
      groups: groups.map((group, outputIndex) => ({
        outputIndex,
        outputId: group.outputId,
        field: group.field,
        values: group.values
      }))
    },
    generations: groups.map((group, outputIndex) => ({
      outputIndex,
      outputId: group.outputId,
      outputArtifactKey: filePlan.outputs[outputIndex].artifactKey,
      generationPath: resolvedGenerationPaths[outputIndex]
    })),
    route: { dbPath: resolvedRouteDbPath, manifestPath: resolvedRouteManifestPath }
  });
}

async function readAndValidateEvidence(artifact, generationPath) {
  const evidencePath = generationEvidencePath(generationPath);
  let stat;
  let bytes;
  try {
    stat = await fs.promises.lstat(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        stat.size !== artifact.evidenceArtifact.byteSize ||
        stat.size > TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES) {
      throw validationError('TOOLBOX_GENERATION_EVIDENCE_INVALID', 'generation evidence文件非法');
    }
    bytes = await fs.promises.readFile(evidencePath);
  } catch (error) {
    if (error && error.code === 'TOOLBOX_GENERATION_EVIDENCE_INVALID') throw error;
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_MISSING', 'generation evidence不存在');
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.evidenceArtifact.sha256) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_HASH_MISMATCH', 'generation evidence SHA-256不一致');
  }
  let evidence;
  try {
    evidence = normalizeGenerationEvidence(JSON.parse(bytes.toString('utf8')));
  } catch (_error) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_INVALID', 'generation evidence内容非法');
  }
  if (evidence.warningSummary.warningCount !== artifact.warningCount) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_MISMATCH', 'generation evidence warning计数不一致');
  }
  return evidence;
}

async function validateMultiGenerationResult({ filePlan, generationInput, result }) {
  if (!validateToolboxMultiGenerationResult(result)) {
    throw validationError('TOOLBOX_GENERATION_MANIFEST_INVALID', '多文件拆分generation manifest非法');
  }
  const planHash = outputPlanHash(
    generationInput.operation.groups,
    generationInput.generations
  );
  const route = inspectSealedRouteDb({
    dbPath: generationInput.route.dbPath,
    manifestPath: generationInput.route.manifestPath,
    expectedOutputPlanHash: planHash
  });
  if (result.routeDb.byteSize !== route.byteSize || result.routeDb.sha256 !== route.sha256 ||
      result.routeDb.rowCount !== route.rowCount || result.routeDb.styleCount !== route.styleCount ||
      result.routeDb.outputPlanHash !== route.outputPlanHash ||
      result.routeDb.manifestArtifact.byteSize !== route.manifestArtifact.byteSize ||
      result.routeDb.manifestArtifact.sha256 !== route.manifestArtifact.sha256) {
    throw validationError('TOOLBOX_ROUTE_EVIDENCE_MISMATCH', 'Main复核的Route DB evidence不一致');
  }
  const artifacts = [];
  for (let outputIndex = 0; outputIndex < generationInput.generations.length; outputIndex += 1) {
    const generation = generationInput.generations[outputIndex];
    const artifact = result.artifacts[outputIndex];
    const outputPlan = filePlan.outputs[outputIndex];
    if (artifact.outputIndex !== outputIndex || artifact.outputId !== generation.outputId ||
        artifact.outputArtifactKey !== generation.outputArtifactKey ||
        artifact.outputArtifactKey !== outputPlan.artifactKey) {
      throw validationError('TOOLBOX_GENERATION_OWNERSHIP_MISMATCH', 'artifact outputIndex/FilePlan ownership不一致');
    }
    let stat;
    try { stat = await fs.promises.lstat(generation.generationPath); } catch (_error) {
      throw validationError('TOOLBOX_GENERATION_ARTIFACT_MISSING', 'staging artifact不存在');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.byteSize ||
        await sha256File(generation.generationPath) !== artifact.sha256) {
      throw validationError('TOOLBOX_GENERATION_ARTIFACT_HASH_MISMATCH', 'staging artifact文件身份、大小或SHA-256不一致');
    }
    // eslint-disable-next-line no-await-in-loop
    const evidence = await readAndValidateEvidence(artifact, generation.generationPath);
    const projectedStyleCounts = artifact.styleStats && artifact.styleStats.actualCounts
      ? artifact.styleStats.actualCounts
      : null;
    // eslint-disable-next-line no-await-in-loop
    const businessEvidence = await validateGeneratedWorkbook(
      generation.generationPath,
      undefined,
      projectedStyleCounts,
      {
        sheetCount: artifact.sheetCount,
        dataRowCount: artifact.dataRowCount,
        normalizedHeaders: evidence.normalizedHeaders
      }
    );
    if (businessEvidence.byteSize !== artifact.byteSize ||
        businessEvidence.sha256 !== artifact.sha256) {
      throw validationError('TOOLBOX_GENERATION_BUSINESS_EVIDENCE_MISMATCH', 'staging artifact业务回读证据不一致');
    }
    artifacts.push(Object.freeze({
      outputIndex,
      outputId: artifact.outputId,
      outputArtifactKey: artifact.outputArtifactKey,
      generationPath: generation.generationPath,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      dataRowCount: artifact.dataRowCount,
      sheetCount: artifact.sheetCount,
      matchedCount: artifact.matchedCount,
      normalizedHeaders: evidence.normalizedHeaders,
      warningSummary: evidence.warningSummary,
      styleStats: artifact.styleStats
    }));
  }
  return Object.freeze({ artifacts: Object.freeze(artifacts), route });
}

async function generateValidateAndPublishMultiOutput(options = {}) {
  const {
    runtime,
    filePlan,
    batchContext,
    groups,
    generationPaths,
    routeDbPath,
    routeManifestPath,
    publisher,
    production = true
  } = options;
  if (!runtime || typeof runtime.execute !== 'function') throw new TypeError('工具箱后台runtime缺失');
  if (typeof publisher !== 'function') throw new TypeError('工具箱Publisher缺失');
  const generationInput = createMultiGenerationInput({
    filePlan,
    groups,
    generationPaths,
    routeDbPath,
    routeManifestPath
  });
  const operationContext = operationContextFromBatch(batchContext);
  const execution = await runtime.execute({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
    operationKey: operationContext.operationKey,
    production,
    context: { kind: 'operation', value: operationContext },
    input: generationInput
  });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw validationError('TOOLBOX_GENERATION_FAILED', '多文件拆分后台生成失败');
  }
  const validated = await validateMultiGenerationResult({
    filePlan,
    generationInput,
    result: execution.result
  });
  const publication = await publisher(validated.artifacts, execution.result.summary);
  return Object.freeze({
    artifacts: validated.artifacts,
    summary: execution.result.summary,
    route: validated.route,
    publication
  });
}

module.exports = {
  createMultiGenerationInput,
  generateValidateAndPublishMultiOutput,
  validateMultiGenerationResult
};
