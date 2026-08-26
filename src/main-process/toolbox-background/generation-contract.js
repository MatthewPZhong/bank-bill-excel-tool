'use strict';

const path = require('node:path');

const { normalizeCell } = require('../../backend/file-service/common');
const {
  normalizeSourceSnapshot
} = require('../archive-center/source-snapshot');

const TOOLBOX_GENERATION_SCHEMA_VERSION = 1;
const TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES = 262144;
const TOOLBOX_GENERATION_ACTIONS = Object.freeze({
  MERGE: 'toolbox:merge',
  SPLIT_SINGLE: 'toolbox:split-single',
  SPLIT_MULTI_OUTPUT: 'toolbox:split-multi-output'
});

function contractError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `${label}必须是普通对象`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const keys = expected.slice().sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw contractError(
      'TOOLBOX_GENERATION_CONTRACT_INVALID',
      `${label}字段必须精确为：${expected.join(', ')}`
    );
  }
}

function nonEmptyText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `${label}不能为空`);
  return text;
}

function absolutePath(value, label) {
  const filePath = path.normalize(nonEmptyText(value, label));
  if (!path.isAbsolute(filePath)) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `${label}必须是绝对路径`);
  }
  return filePath;
}

function normalizeSource(value, index) {
  assertExactKeys(value, ['filePath', 'sourceSnapshot'], `sources[${index}]`);
  const sourceSnapshot = normalizeSourceSnapshot(value.sourceSnapshot);
  if (!sourceSnapshot) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `sources[${index}].sourceSnapshot非法`);
  }
  return Object.freeze({
    filePath: absolutePath(value.filePath, `sources[${index}].filePath`),
    sourceSnapshot: Object.freeze({ ...sourceSnapshot })
  });
}

function normalizeGeneration(value) {
  assertExactKeys(
    value,
    ['outputId', 'outputArtifactKey', 'generationPath'],
    'generation'
  );
  return Object.freeze({
    outputId: nonEmptyText(value.outputId, 'generation.outputId'),
    outputArtifactKey: nonEmptyText(value.outputArtifactKey, 'generation.outputArtifactKey'),
    generationPath: absolutePath(value.generationPath, 'generation.generationPath')
  });
}

function normalizeMergeInput(value) {
  assertExactKeys(value, ['schemaVersion', 'sources', 'operation', 'generation'], 'merge input');
  if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'merge input schemaVersion非法');
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'merge input sources不能为空');
  }
  assertExactKeys(value.operation, ['sheetBaseName'], 'merge operation');
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    sources: Object.freeze(value.sources.map(normalizeSource)),
    operation: Object.freeze({
      sheetBaseName: nonEmptyText(value.operation.sheetBaseName, 'operation.sheetBaseName')
    }),
    generation: normalizeGeneration(value.generation)
  });
}

function normalizeSplitInput(value) {
  assertExactKeys(value, ['schemaVersion', 'sources', 'operation', 'generation'], 'split input');
  if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'split input schemaVersion非法');
  }
  if (!Array.isArray(value.sources) || value.sources.length !== 1) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'split input必须精确包含一个 source');
  }
  assertExactKeys(value.operation, ['field', 'values'], 'split operation');
  const field = normalizeCell(value.operation.field);
  if (!field) throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'operation.field不能为空');
  if (!Array.isArray(value.operation.values) || value.operation.values.length === 0) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'operation.values不能为空');
  }
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    sources: Object.freeze(value.sources.map(normalizeSource)),
    operation: Object.freeze({
      field,
      values: Object.freeze(value.operation.values.map((item) => normalizeCell(item)))
    }),
    generation: normalizeGeneration(value.generation)
  });
}

function normalizeMultiSplitInput(value) {
  assertExactKeys(
    value,
    ['schemaVersion', 'sources', 'operation', 'generations', 'route'],
    'multi split input'
  );
  if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION ||
      !Array.isArray(value.sources) || value.sources.length !== 1) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'multi split input非法');
  }
  assertExactKeys(value.operation, ['groups'], 'multi split operation');
  if (!Array.isArray(value.operation.groups) || value.operation.groups.length < 1 ||
      value.operation.groups.length > 8) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'multi split groups必须为1..8组');
  }
  if (!Array.isArray(value.generations) ||
      value.generations.length !== value.operation.groups.length) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'multi split generations数量非法');
  }
  const outputIds = new Set();
  const artifactKeys = new Set();
  const groups = value.operation.groups.map((group, index) => {
    assertExactKeys(group, ['outputIndex', 'outputId', 'field', 'values'], `groups[${index}]`);
    if (group.outputIndex !== index) {
      throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `groups[${index}].outputIndex非法`);
    }
    const outputId = nonEmptyText(group.outputId, `groups[${index}].outputId`);
    const field = normalizeCell(group.field);
    if (!field || outputIds.has(outputId) || !Array.isArray(group.values) || group.values.length === 0) {
      throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `groups[${index}]非法`);
    }
    outputIds.add(outputId);
    return Object.freeze({
      outputIndex: index,
      outputId,
      field,
      values: Object.freeze(group.values.map((item) => normalizeCell(item)))
    });
  });
  const generations = value.generations.map((generation, index) => {
    assertExactKeys(
      generation,
      ['outputIndex', 'outputId', 'outputArtifactKey', 'generationPath'],
      `generations[${index}]`
    );
    const outputId = nonEmptyText(generation.outputId, `generations[${index}].outputId`);
    const outputArtifactKey = nonEmptyText(
      generation.outputArtifactKey,
      `generations[${index}].outputArtifactKey`
    );
    if (generation.outputIndex !== index || outputId !== groups[index].outputId ||
        artifactKeys.has(outputArtifactKey)) {
      throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', `generations[${index}]非法`);
    }
    artifactKeys.add(outputArtifactKey);
    return Object.freeze({
      outputIndex: index,
      outputId,
      outputArtifactKey,
      generationPath: absolutePath(generation.generationPath, `generations[${index}].generationPath`)
    });
  });
  assertExactKeys(value.route, ['dbPath', 'manifestPath'], 'multi split route');
  const dbPath = absolutePath(value.route.dbPath, 'route.dbPath');
  const manifestPath = absolutePath(value.route.manifestPath, 'route.manifestPath');
  if (dbPath === manifestPath) {
    throw contractError('TOOLBOX_GENERATION_CONTRACT_INVALID', 'Route DB与manifest路径不能相同');
  }
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    sources: Object.freeze(value.sources.map(normalizeSource)),
    operation: Object.freeze({ groups: Object.freeze(groups) }),
    generations: Object.freeze(generations),
    route: Object.freeze({ dbPath, manifestPath })
  });
}

function normalizeWarningSummary(value) {
  assertExactKeys(value, ['warningCount', 'warningSamples'], 'artifact.warningSummary');
  if (!Number.isSafeInteger(value.warningCount) || value.warningCount < 0 ||
      !Array.isArray(value.warningSamples) || value.warningSamples.length > 20 ||
      value.warningCount < value.warningSamples.length) {
    throw contractError('TOOLBOX_GENERATION_RESULT_INVALID', 'artifact.warningSummary非法');
  }
  for (let index = 0; index < value.warningSamples.length; index += 1) {
    const sample = value.warningSamples[index];
    assertExactKeys(
      sample,
      ['code', 'sourceFileName', 'sourceSheet', 'cellRef', 'message'],
      `artifact.warningSummary.warningSamples[${index}]`
    );
    if (Object.values(sample).some((item) => typeof item !== 'string')) {
      throw contractError('TOOLBOX_GENERATION_RESULT_INVALID', 'artifact.warningSummary sample非法');
    }
  }
  return value;
}

function normalizeGenerationEvidence(value) {
  assertExactKeys(value, ['schemaVersion', 'normalizedHeaders', 'warningSummary'], 'generation evidence');
  if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION ||
      !Array.isArray(value.normalizedHeaders) || value.normalizedHeaders.length === 0 ||
      value.normalizedHeaders.some((header) => typeof header !== 'string')) {
    throw contractError('TOOLBOX_GENERATION_EVIDENCE_INVALID', 'generation evidence非法');
  }
  normalizeWarningSummary(value.warningSummary);
  return Object.freeze({
    schemaVersion: TOOLBOX_GENERATION_SCHEMA_VERSION,
    normalizedHeaders: Object.freeze(value.normalizedHeaders.slice()),
    warningSummary: Object.freeze({
      warningCount: value.warningSummary.warningCount,
      warningSamples: Object.freeze(value.warningSummary.warningSamples.map((sample) =>
        Object.freeze({ ...sample })))
    })
  });
}

function generationEvidencePath(generationPath) {
  return `${path.resolve(String(generationPath || ''))}.e04a-evidence.json`;
}

const STYLE_COUNT_KEYS = Object.freeze([
  'cellXfs', 'fonts', 'fills', 'borders', 'customNumFmts'
]);

function validStyleStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const allowed = new Set(['counts', 'projectedFinalCounts', 'budgets', 'actualCounts']);
  const keys = Object.keys(value);
  if (!value.projectedFinalCounts || !value.actualCounts || keys.some((key) => !allowed.has(key))) return false;
  return keys.every((key) => {
    const counts = value[key];
    if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(counts))) return false;
    const countKeys = Object.keys(counts);
    return countKeys.length === STYLE_COUNT_KEYS.length &&
      STYLE_COUNT_KEYS.every((item) => countKeys.includes(item)) &&
      Object.values(counts).every((count) => Number.isSafeInteger(count) && count >= 0);
  });
}

function validateToolboxGenerationResult(value, expectedActionKey = null) {
  try {
    assertExactKeys(value, ['schemaVersion', 'actionKey', 'artifacts', 'summary'], 'generation result');
    if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION ||
        !Object.values(TOOLBOX_GENERATION_ACTIONS).includes(value.actionKey) ||
        (expectedActionKey && value.actionKey !== expectedActionKey) ||
        !Array.isArray(value.artifacts) || value.artifacts.length !== 1) {
      return false;
    }
    const artifact = value.artifacts[0];
    assertExactKeys(artifact, [
      'outputId',
      'outputArtifactKey',
      'byteSize',
      'sha256',
      'dataRowCount',
      'sheetCount',
      'matchedCount',
      'warningCount',
      'evidenceArtifact',
      'styleStats'
    ], 'artifact');
    if (!nonEmptyText(artifact.outputId, 'artifact.outputId') ||
        !nonEmptyText(artifact.outputArtifactKey, 'artifact.outputArtifactKey') ||
        !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.dataRowCount) || artifact.dataRowCount < 0 ||
        !Number.isSafeInteger(artifact.sheetCount) || artifact.sheetCount < 1 ||
        !Number.isSafeInteger(artifact.matchedCount) || artifact.matchedCount < 0 ||
        !Number.isSafeInteger(artifact.warningCount) || artifact.warningCount < 0 ||
        !artifact.evidenceArtifact || typeof artifact.evidenceArtifact !== 'object' ||
        Array.isArray(artifact.evidenceArtifact)) {
      return false;
    }
    assertExactKeys(artifact.evidenceArtifact, ['byteSize', 'sha256'], 'artifact.evidenceArtifact');
    if (!Number.isSafeInteger(artifact.evidenceArtifact.byteSize) ||
        artifact.evidenceArtifact.byteSize <= 0 ||
        artifact.evidenceArtifact.byteSize > TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(artifact.evidenceArtifact.sha256) ||
        !validStyleStats(artifact.styleStats)) return false;
    assertExactKeys(value.summary, [
      'sourceFileCount',
      'inputSheetCount',
      'inputDataRowCount',
      'outputDataRowCount',
      'skippedHiddenSheetCount',
      'skippedEmptySheetCount'
    ], 'summary');
    return Object.values(value.summary).every((count) => Number.isSafeInteger(count) && count >= 0);
  } catch (_error) {
    return false;
  }
}

function validateToolboxMultiGenerationResult(value) {
  try {
    assertExactKeys(
      value,
      ['schemaVersion', 'actionKey', 'artifacts', 'summary', 'routeDb'],
      'multi generation result'
    );
    if (value.schemaVersion !== TOOLBOX_GENERATION_SCHEMA_VERSION ||
        value.actionKey !== TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT ||
        !Array.isArray(value.artifacts) || value.artifacts.length < 1 ||
        value.artifacts.length > 8) return false;
    const seenIds = new Set();
    const seenKeys = new Set();
    for (let index = 0; index < value.artifacts.length; index += 1) {
      const artifact = value.artifacts[index];
      assertExactKeys(artifact, [
        'outputIndex', 'outputId', 'outputArtifactKey', 'byteSize', 'sha256',
        'dataRowCount', 'sheetCount', 'matchedCount', 'warningCount',
        'evidenceArtifact', 'styleStats'
      ], `artifacts[${index}]`);
      if (artifact.outputIndex !== index ||
          !nonEmptyText(artifact.outputId, `artifacts[${index}].outputId`) ||
          !nonEmptyText(artifact.outputArtifactKey, `artifacts[${index}].outputArtifactKey`) ||
          seenIds.has(artifact.outputId) || seenKeys.has(artifact.outputArtifactKey) ||
          !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0 ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.dataRowCount) || artifact.dataRowCount < 0 ||
          !Number.isSafeInteger(artifact.sheetCount) || artifact.sheetCount < 1 ||
          artifact.matchedCount !== artifact.dataRowCount ||
          !Number.isSafeInteger(artifact.warningCount) || artifact.warningCount < 0 ||
          !artifact.evidenceArtifact || typeof artifact.evidenceArtifact !== 'object' ||
          Array.isArray(artifact.evidenceArtifact)) return false;
      assertExactKeys(artifact.evidenceArtifact, ['byteSize', 'sha256'], 'evidenceArtifact');
      if (!Number.isSafeInteger(artifact.evidenceArtifact.byteSize) ||
          artifact.evidenceArtifact.byteSize <= 0 ||
          artifact.evidenceArtifact.byteSize > TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES ||
          !/^[a-f0-9]{64}$/.test(artifact.evidenceArtifact.sha256) ||
          !validStyleStats(artifact.styleStats)) return false;
      seenIds.add(artifact.outputId);
      seenKeys.add(artifact.outputArtifactKey);
    }
    assertExactKeys(value.summary, [
      'sourceFileCount', 'inputSheetCount', 'inputDataRowCount', 'outputDataRowCount',
      'skippedHiddenSheetCount', 'skippedEmptySheetCount'
    ], 'summary');
    if (!Object.values(value.summary).every((count) => Number.isSafeInteger(count) && count >= 0)) {
      return false;
    }
    assertExactKeys(value.routeDb, [
      'byteSize', 'sha256', 'manifestArtifact', 'rowCount', 'styleCount', 'outputPlanHash'
    ], 'routeDb');
    assertExactKeys(value.routeDb.manifestArtifact, ['byteSize', 'sha256'], 'routeDb.manifestArtifact');
    return Number.isSafeInteger(value.routeDb.byteSize) && value.routeDb.byteSize > 0 &&
      /^[a-f0-9]{64}$/.test(value.routeDb.sha256) &&
      Number.isSafeInteger(value.routeDb.manifestArtifact.byteSize) &&
      value.routeDb.manifestArtifact.byteSize > 0 &&
      /^[a-f0-9]{64}$/.test(value.routeDb.manifestArtifact.sha256) &&
      Number.isSafeInteger(value.routeDb.rowCount) && value.routeDb.rowCount >= 0 &&
      Number.isSafeInteger(value.routeDb.styleCount) && value.routeDb.styleCount >= 1 &&
      /^[a-f0-9]{64}$/.test(value.routeDb.outputPlanHash);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  TOOLBOX_GENERATION_ACTIONS,
  TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES,
  TOOLBOX_GENERATION_SCHEMA_VERSION,
  generationEvidencePath,
  normalizeGenerationEvidence,
  normalizeMergeInput,
  normalizeMultiSplitInput,
  normalizeSplitInput,
  normalizeWarningSummary,
  validateToolboxGenerationResult,
  validateToolboxMultiGenerationResult
};
