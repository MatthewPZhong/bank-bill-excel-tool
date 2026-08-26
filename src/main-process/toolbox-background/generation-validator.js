'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fromProtocolError } = require('../background-execution/error-codec');
const {
  freezeWorkerOperationContext
} = require('../archive-center/worker-operation-context');
const { pathsAlias } = require('../toolbox-target-identity');
const {
  sha256File,
  validateGeneratedWorkbook
} = require('../toolbox-output-writer');
const {
  TOOLBOX_GENERATION_ACTIONS,
  TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES,
  TOOLBOX_GENERATION_SCHEMA_VERSION,
  generationEvidencePath,
  normalizeGenerationEvidence,
  validateToolboxGenerationResult
} = require('./generation-contract');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function operationContextFromBatch(batchContext) {
  return freezeWorkerOperationContext({
    taskRunId: batchContext && batchContext.taskRunId,
    taskKey: batchContext && batchContext.taskKey,
    moduleId: batchContext && batchContext.moduleId,
    parentRunId: batchContext && batchContext.parentRunId,
    operationKey: batchContext && batchContext.operationKey
  }, { required: true });
}

function createGenerationInput({ actionKey, filePlan, generationPath, operationConfig }) {
  if (!filePlan || filePlan.allocation !== 'eager' || !Array.isArray(filePlan.inputs) ||
      !Array.isArray(filePlan.outputs) || filePlan.outputs.length !== 1) {
    throw validationError('TOOLBOX_GENERATION_FILE_PLAN_INVALID', '工具箱生成需要单一输出 FilePlan');
  }
  const isMerge = actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE;
  if (!isMerge && actionKey !== TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE) {
    throw validationError('TOOLBOX_GENERATION_ACTION_INVALID', `不支持的工具箱生成 action：${actionKey}`);
  }
  if ((isMerge && filePlan.inputs.length === 0) || (!isMerge && filePlan.inputs.length !== 1)) {
    throw validationError('TOOLBOX_GENERATION_FILE_PLAN_INVALID', '工具箱生成输入数量与 action 不一致');
  }
  const resolvedGenerationPath = path.resolve(String(generationPath || ''));
  for (const item of [...filePlan.inputs, ...filePlan.outputs]) {
    if (pathsAlias(fs, resolvedGenerationPath, item.filePath, {
      allowMissingParentLexicalFallback: true
    })) {
      throw validationError('TOOLBOX_GENERATION_PATH_INVALID', '工具箱 generation path 不能与 FilePlan 输入或正式目标重合');
    }
  }
  const operation = isMerge
    ? { sheetBaseName: String(operationConfig && operationConfig.sheetBaseName || 'COMMON') }
    : {
        field: operationConfig && operationConfig.field,
        values: operationConfig && operationConfig.values
      };
  return {
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    sources: filePlan.inputs.map((item) => ({
      filePath: item.filePath,
      sourceSnapshot: item.sourceSnapshot
    })),
    operation,
    generation: {
      outputId: isMerge ? 'merge-1' : 'split-1',
      outputArtifactKey: filePlan.outputs[0].artifactKey,
      generationPath: resolvedGenerationPath
    }
  };
}

async function validateGeneratedArtifact({ actionKey, filePlan, generationInput, result }) {
  if (!validateToolboxGenerationResult(result, actionKey)) {
    throw validationError('TOOLBOX_GENERATION_MANIFEST_INVALID', '工具箱 generation artifact manifest 非法');
  }
  const artifact = result.artifacts[0];
  const expected = generationInput.generation;
  if (artifact.outputId !== expected.outputId ||
      artifact.outputArtifactKey !== expected.outputArtifactKey ||
      artifact.outputArtifactKey !== filePlan.outputs[0].artifactKey) {
    throw validationError('TOOLBOX_GENERATION_OWNERSHIP_MISMATCH', '工具箱 staging artifact 与 FilePlan ownership 不一致');
  }
  const generationPath = expected.generationPath;
  const evidencePath = generationEvidencePath(generationPath);
  let stat;
  try {
    stat = await fs.promises.lstat(generationPath);
  } catch (_error) {
    throw validationError('TOOLBOX_GENERATION_ARTIFACT_MISSING', '工具箱 staging artifact 不存在');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== artifact.byteSize) {
    throw validationError('TOOLBOX_GENERATION_ARTIFACT_INVALID', '工具箱 staging artifact 文件身份或大小非法');
  }
  const technicalHash = await sha256File(generationPath);
  if (technicalHash !== artifact.sha256) {
    throw validationError('TOOLBOX_GENERATION_ARTIFACT_HASH_MISMATCH', '工具箱 staging artifact SHA-256 不一致');
  }
  let evidenceStat;
  let evidenceBytes;
  try {
    evidenceStat = await fs.promises.lstat(evidencePath);
    if (evidenceStat.isSymbolicLink() || !evidenceStat.isFile() ||
        evidenceStat.size !== artifact.evidenceArtifact.byteSize ||
        evidenceStat.size > TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES) {
      throw validationError('TOOLBOX_GENERATION_EVIDENCE_INVALID', '工具箱 generation evidence 文件身份或大小非法');
    }
    evidenceBytes = await fs.promises.readFile(evidencePath);
  } catch (error) {
    if (error && error.code === 'TOOLBOX_GENERATION_EVIDENCE_INVALID') throw error;
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_MISSING', '工具箱 generation evidence 不存在');
  }
  const evidenceHash = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceHash !== artifact.evidenceArtifact.sha256) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_HASH_MISMATCH', '工具箱 generation evidence SHA-256 不一致');
  }
  let evidence;
  try {
    evidence = normalizeGenerationEvidence(JSON.parse(evidenceBytes.toString('utf8')));
  } catch (_error) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_INVALID', '工具箱 generation evidence 内容非法');
  }
  if (evidence.warningSummary.warningCount !== artifact.warningCount) {
    throw validationError('TOOLBOX_GENERATION_EVIDENCE_MISMATCH', '工具箱 generation evidence warning 计数不一致');
  }
  const projectedStyleCounts = artifact.styleStats && artifact.styleStats.actualCounts
    ? artifact.styleStats.actualCounts
    : null;
  const businessEvidence = await validateGeneratedWorkbook(
    generationPath,
    undefined,
    projectedStyleCounts,
    {
      sheetCount: artifact.sheetCount,
      dataRowCount: artifact.dataRowCount,
      normalizedHeaders: evidence.normalizedHeaders
    }
  );
  if (businessEvidence.byteSize !== artifact.byteSize || businessEvidence.sha256 !== artifact.sha256) {
    throw validationError('TOOLBOX_GENERATION_BUSINESS_EVIDENCE_MISMATCH', '工具箱 staging artifact 业务回读证据不一致');
  }
  return Object.freeze({
    outputId: artifact.outputId,
    outputArtifactKey: artifact.outputArtifactKey,
    generationPath,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
    dataRowCount: artifact.dataRowCount,
    sheetCount: artifact.sheetCount,
    matchedCount: artifact.matchedCount,
    normalizedHeaders: evidence.normalizedHeaders,
    warningSummary: evidence.warningSummary,
    styleStats: artifact.styleStats
  });
}

async function generateValidateAndPublish(options = {}) {
  const {
    runtime,
    actionKey,
    filePlan,
    batchContext,
    generationPath,
    operationConfig,
    publisher,
    requireNonEmptySplit = false,
    production = true
  } = options;
  if (!runtime || typeof runtime.execute !== 'function') {
    throw new TypeError('工具箱后台生成 runtime 缺失');
  }
  if (typeof publisher !== 'function') throw new TypeError('工具箱 Publisher 缺失');
  const generationInput = createGenerationInput({
    actionKey,
    filePlan,
    generationPath,
    operationConfig
  });
  const operationContext = operationContextFromBatch(batchContext);
  const execution = await runtime.execute({
    actionKey,
    operationKey: operationContext.operationKey,
    production,
    context: { kind: 'operation', value: operationContext },
    input: generationInput
  });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw validationError('TOOLBOX_GENERATION_FAILED', '工具箱后台生成失败');
  }
  const artifact = await validateGeneratedArtifact({
    actionKey,
    filePlan,
    generationInput,
    result: execution.result
  });
  if (requireNonEmptySplit && artifact.matchedCount === 0) {
    throw validationError(
      'TOOLBOX_SPLIT_NO_MATCHES',
      '所选值在源文件中无匹配行，未生成文件'
    );
  }
  const publication = await publisher(Object.freeze([artifact]), execution.result.summary);
  return Object.freeze({
    artifact,
    summary: execution.result.summary,
    publication
  });
}

module.exports = {
  createGenerationInput,
  generateValidateAndPublish,
  operationContextFromBatch,
  validateGeneratedArtifact
};
