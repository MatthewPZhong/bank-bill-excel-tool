'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeFilePlanV1 } = require('../archive-center/file-plan');
const { sourceSnapshotMatchesStat } = require('../archive-center/source-snapshot');
const { pathsAlias } = require('../toolbox-target-identity');
const {
  validateTaskOwnedStagingPath
} = require('../statement-worker/staging-ownership');
const {
  NEW_ACCOUNT_GENERATION_ACTION,
  NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
  createNewAccountGenerationInput,
  validateNewAccountGenerationResult
} = require('./generation-contract');
const {
  createTemplateEvidence,
  fileSha256,
  formatDateLabel,
  normalizeNewAccountAccounts,
  normalizeNewAccountCurrencyValues,
  validateNewAccountAccounts
} = require('./generation-core');

function normalizeMainAccounts(payload) {
  const normalized = validateNewAccountAccounts(normalizeNewAccountAccounts(payload));
  return Object.freeze(normalized.map((account) => Object.freeze({
    bankName: account.bankName,
    location: account.location,
    bankAccount: account.bankAccount,
    openingDate: formatDateLabel(account.openingDate),
    currencies: Object.freeze(normalizeNewAccountCurrencyValues(account))
  })));
}

function createNewAccountFilePlan(filePlan, templatePath) {
  const normalized = normalizeFilePlanV1(filePlan);
  if (normalized.allocation !== 'eager' || normalized.inputs.length !== 1 ||
      normalized.outputs.length !== 1 ||
      path.resolve(normalized.inputs[0].filePath) !== path.resolve(templatePath) ||
      normalized.inputs[0].sourceOperation !== NEW_ACCOUNT_GENERATION_ACTION ||
      normalized.outputs[0].sourceOperation !== NEW_ACCOUNT_GENERATION_ACTION) {
    const error = new Error('NewAccount FilePlan必须精确绑定一个白名单模板和一个输出');
    error.code = 'NEW_ACCOUNT_FILE_PLAN_INVALID';
    throw error;
  }
  return normalized;
}

function createNewAccountWorkerInput(options) {
  const filePlan = createNewAccountFilePlan(options.filePlan, options.templatePath);
  const template = createTemplateEvidence(options.templatePath);
  const templateStat = fs.lstatSync(template.filePath, { bigint: true });
  if (!sourceSnapshotMatchesStat(filePlan.inputs[0].sourceSnapshot, templateStat) ||
      !sourceSnapshotMatchesStat(template.snapshot, templateStat)) {
    const error = new Error('NewAccount FilePlan模板快照与当前模板不一致');
    error.code = 'NEW_ACCOUNT_TEMPLATE_CHANGED';
    throw error;
  }
  if (pathsAlias(fs, options.generationPath, template.filePath, {
    allowMissingParentLexicalFallback: true
  }) || pathsAlias(fs, options.generationPath, filePlan.outputs[0].filePath, {
    allowMissingParentLexicalFallback: true
  })) {
    const error = new Error('NewAccount generationPath不得与模板或final target互为别名');
    error.code = 'NEW_ACCOUNT_GENERATION_PATH_ALIAS';
    throw error;
  }
  return createNewAccountGenerationInput({
    schemaVersion: NEW_ACCOUNT_GENERATION_SCHEMA_VERSION,
    accounts: normalizeMainAccounts(options.payload),
    asOfDate: options.asOfDate,
    template,
    generation: {
      artifactKey: filePlan.outputs[0].artifactKey,
      stagingRoot: options.stagingRoot,
      stagingResourceId: options.stagingResourceId,
      generationPath: options.generationPath
    }
  });
}

function technicalValidateNewAccountArtifact(input, result) {
  if (!validateNewAccountGenerationResult(result) ||
      result.artifact.artifactKey !== input.generation.artifactKey ||
      result.artifact.templateSha256 !== input.template.sha256) {
    const error = new Error('NewAccount Worker result contract非法');
    error.code = 'NEW_ACCOUNT_GENERATION_RESULT_INVALID';
    throw error;
  }
  const owned = validateTaskOwnedStagingPath({
    stagingRoot: input.generation.stagingRoot,
    candidatePath: input.generation.generationPath,
    finalState: 'file'
  });
  if (Number(owned.stat.size) !== result.artifact.byteSize ||
      fileSha256(input.generation.generationPath) !== result.artifact.sha256) {
    const error = new Error('NewAccount staging workbook技术证据不一致');
    error.code = 'NEW_ACCOUNT_GENERATION_ARTIFACT_CHANGED';
    throw error;
  }
  return Object.freeze({
    generationPath: input.generation.generationPath,
    artifact: result.artifact,
    summary: result.summary
  });
}

function cleanupOwnedGeneration(input) {
  try {
    const owned = validateTaskOwnedStagingPath({
      stagingRoot: input.generation.stagingRoot,
      candidatePath: input.generation.generationPath,
      finalState: 'missing-or-file'
    });
    if (owned.exists) fs.rmSync(owned.candidate, { force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

async function generateAndValidateNewAccount(options) {
  const input = createNewAccountWorkerInput(options);
  validateTaskOwnedStagingPath({
    stagingRoot: input.generation.stagingRoot,
    candidatePath: input.generation.generationPath,
    finalState: 'missing'
  });
  const cleanupGeneration = () => {
    const cleaned = cleanupOwnedGeneration(input);
    // 只暴露清理完成观察点给 lifecycle 测试；调用方不能替换或跳过 Main cleanup owner。
    if (typeof options.onOwnedGenerationCleanup === 'function') {
      try { options.onOwnedGenerationCleanup({ cleaned }); } catch (_) {}
    }
    return cleaned;
  };
  let execution;
  try {
    execution = await options.runtime.execute({
      actionKey: NEW_ACCOUNT_GENERATION_ACTION,
      operationKey: options.operationKey,
      production: options.production === true,
      context: options.context,
      input
    });
    if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
      cleanupGeneration();
      return Object.freeze({ execution, generated: null });
    }
    return Object.freeze({
      execution,
      generated: technicalValidateNewAccountArtifact(input, execution.result)
    });
  } catch (error) {
    cleanupGeneration();
    throw error;
  }
}

module.exports = {
  cleanupOwnedGeneration,
  createNewAccountFilePlan,
  createNewAccountWorkerInput,
  generateAndValidateNewAccount,
  normalizeMainAccounts,
  technicalValidateNewAccountArtifact
};
