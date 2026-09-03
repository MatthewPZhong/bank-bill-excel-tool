'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const {
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const { exportToolboxFilter } = require('../toolbox-format-operations');
const { mergeToolboxFilesToXlsx } = require('../toolbox-merge-io');
const {
  TOOLBOX_GENERATION_ACTIONS,
  TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES,
  TOOLBOX_GENERATION_SCHEMA_VERSION,
  generationEvidencePath,
  normalizeGenerationEvidence,
  normalizeMergeInput,
  normalizeSplitInput
} = require('./generation-contract');

function generationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSourcesFresh(sources) {
  for (const source of sources) {
    let stat;
    try {
      stat = fs.lstatSync(source.filePath, { bigint: true });
    } catch (_error) {
      throw generationError('ARCHIVE_INPUT_CHANGED', '输入文件在生成期间已变化');
    }
    if (stat.isSymbolicLink() || !stat.isFile() ||
        !sourceSnapshotMatchesStat(source.sourceSnapshot, stat)) {
      throw generationError('ARCHIVE_INPUT_CHANGED', '输入文件在生成期间已变化');
    }
  }
}

function cancelTokenFor(signal) {
  return Object.freeze({
    get cancelled() {
      return Boolean(signal && signal.aborted);
    }
  });
}

function assertNotCancelled(signal) {
  if (!signal || !signal.aborted) return;
  throw generationError('TOOLBOX_GENERATION_CANCELLED', '工具箱生成已取消');
}

function writeGenerationEvidence(generation, normalizedHeaders, warningSummary) {
  const evidence = normalizeGenerationEvidence({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    normalizedHeaders,
    warningSummary: warningSummary || { warningCount: 0, warningSamples: [] }
  });
  const bytes = Buffer.from(JSON.stringify(evidence), 'utf8');
  if (bytes.length === 0 || bytes.length > TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES) {
    throw generationError('TOOLBOX_GENERATION_EVIDENCE_TOO_LARGE', '工具箱 generation evidence 超出安全上限');
  }
  fs.writeFileSync(generationEvidencePath(generation.generationPath), bytes, { flag: 'wx' });
  return Object.freeze({
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function artifactFrom(result, generation, matchedCount, normalizedHeaders) {
  const warningSummary = result.warningSummary || { warningCount: 0, warningSamples: [] };
  const evidenceArtifact = writeGenerationEvidence(
    generation,
    normalizedHeaders,
    warningSummary
  );
  return Object.freeze({
    outputId: generation.outputId,
    outputArtifactKey: generation.outputArtifactKey,
    byteSize: Number(result.byteSize),
    sha256: String(result.sha256 || ''),
    dataRowCount: Number(result.dataRowCount),
    sheetCount: Number(result.sheetCount),
    matchedCount: Number(matchedCount),
    warningCount: Number(warningSummary.warningCount) || 0,
    evidenceArtifact,
    styleStats: result.styleStats || null
  });
}

async function executeMergeGeneration(rawInput, signal) {
  const input = normalizeMergeInput(rawInput);
  assertNotCancelled(signal);
  assertSourcesFresh(input.sources);
  let result;
  try {
    result = await mergeToolboxFilesToXlsx({
      filePaths: input.sources.map((source) => source.filePath),
      savePath: input.generation.generationPath,
      sheetBaseName: input.operation.sheetBaseName,
      cancelToken: cancelTokenFor(signal)
    });
  } catch (error) {
    if (signal && signal.aborted) throw generationError('TOOLBOX_GENERATION_CANCELLED', '工具箱生成已取消');
    throw error;
  }
  assertNotCancelled(signal);
  assertSourcesFresh(input.sources);
  const artifact = artifactFrom(result, input.generation, result.dataRowCount, result.baseHeaders);
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    actionKey: TOOLBOX_GENERATION_ACTIONS.MERGE,
    artifacts: Object.freeze([artifact]),
    summary: Object.freeze({
      sourceFileCount: Number(result.fileCount) || input.sources.length,
      inputSheetCount: Number(result.inputSheetCount) || 0,
      inputDataRowCount: Number(result.dataRowCount) || 0,
      outputDataRowCount: Number(result.dataRowCount) || 0,
      skippedHiddenSheetCount: Number(result.skippedHiddenSheetCount) || 0,
      skippedEmptySheetCount: Number(result.skippedEmptySheetCount) || 0
    })
  });
}

async function executeSplitGeneration(rawInput, signal) {
  const input = normalizeSplitInput(rawInput);
  assertNotCancelled(signal);
  assertSourcesFresh(input.sources);
  let result;
  try {
    result = await exportToolboxFilter({
      filePath: input.sources[0].filePath,
      field: input.operation.field,
      values: input.operation.values,
      savePath: input.generation.generationPath,
      outputId: input.generation.outputId,
      cancelToken: cancelTokenFor(signal)
    });
  } catch (error) {
    if (signal && signal.aborted) throw generationError('TOOLBOX_GENERATION_CANCELLED', '工具箱生成已取消');
    throw error;
  }
  assertNotCancelled(signal);
  assertSourcesFresh(input.sources);
  const artifact = artifactFrom(result, input.generation, result.matchedCount, result.normalizedHeaders);
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    artifacts: Object.freeze([artifact]),
    summary: Object.freeze({
      sourceFileCount: 1,
      inputSheetCount: 0,
      inputDataRowCount: Number(result.inputDataRowCount) || 0,
      outputDataRowCount: Number(result.matchedCount) || 0,
      skippedHiddenSheetCount: 0,
      skippedEmptySheetCount: 0
    })
  });
}

module.exports = {
  artifactFrom,
  assertSourcesFresh,
  executeMergeGeneration,
  executeSplitGeneration,
  writeGenerationEvidence
};
