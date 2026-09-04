'use strict';

const path = require('node:path');

const {
  canonicalizeJson,
  canonicalJsonSnapshot
} = require('../background-execution/canonical-json-v1');
const { normalizeTargetAliasKey } = require('../toolbox-target-identity');
const { createStatementPublicTokenIdentity } = require('./interaction-contracts');
const { isValidTaskStagingResourceId } = require('./staging-ownership');

const MAX_ARTIFACTS = 2;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

class StatementGenerationContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementGenerationContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StatementGenerationContractError(code, message);
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('STATEMENT_GENERATION_SHAPE_INVALID', `${label} has invalid keys`);
  }
  return value;
}

function text(value, label, max = 512) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    fail('STATEMENT_GENERATION_TEXT_INVALID', `${label} is invalid`);
  }
  return value;
}

function publicGenerationToken(input) {
  const token = createStatementPublicTokenIdentity(input, { purpose: 'scope-generation' });
  if (token.purpose !== 'scope-generation') {
    fail('STATEMENT_GENERATION_TOKEN_PURPOSE_INVALID', 'Generation token purpose is invalid');
  }
  return token;
}

function normalizeKind(value) {
  if (!['detail', 'balance', 'both'].includes(value)) {
    fail('STATEMENT_GENERATION_KIND_INVALID', 'Generation kind is invalid');
  }
  return value;
}

function createStatementGenerationPrepareRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_INPUT_BYTES });
  const record = exact(value, ['command', 'sessionKey', 'kind'], 'StatementGenerationPrepare');
  if (record.command !== 'prepare-generation') {
    fail('STATEMENT_GENERATION_COMMAND_INVALID', 'Generation prepare command is invalid');
  }
  return Object.freeze({
    command: record.command,
    sessionKey: text(record.sessionKey, 'sessionKey'),
    kind: normalizeKind(record.kind)
  });
}

function createStatementGenerationExecuteRequest(input) {
  const value = canonicalJsonSnapshot(input, { maxBytes: MAX_INPUT_BYTES });
  const record = exact(
    value,
    ['command', 'token', 'sessionKey', 'sessionRevision', 'kind', 'artifacts'],
    'StatementGenerationExecute'
  );
  if (record.command !== 'generate') {
    fail('STATEMENT_GENERATION_COMMAND_INVALID', 'Generation execute command is invalid');
  }
  if (!Number.isSafeInteger(record.sessionRevision) || record.sessionRevision < 1) {
    fail('STATEMENT_GENERATION_REVISION_INVALID', 'sessionRevision is invalid');
  }
  const kind = normalizeKind(record.kind);
  const expectedKinds = kind === 'both' ? ['detail', 'balance'] : [kind];
  if (!Array.isArray(record.artifacts) || record.artifacts.length !== expectedKinds.length ||
      record.artifacts.length > MAX_ARTIFACTS) {
    fail('STATEMENT_GENERATION_ARTIFACTS_INVALID', 'Generation artifacts are invalid');
  }
  const seen = new Set();
  const stagingAliases = new Set();
  const artifacts = record.artifacts.map((item, index) => {
    const artifact = exact(item, ['kind', 'artifactKey', 'stagingResourceId'], `artifacts[${index}]`);
    if (artifact.kind !== expectedKinds[index]) {
      fail('STATEMENT_GENERATION_ARTIFACT_ORDER_INVALID', 'Generation artifacts must be detail then balance');
    }
    const artifactKey = text(artifact.artifactKey, `artifacts[${index}].artifactKey`, 256);
    if (seen.has(artifactKey)) fail('STATEMENT_GENERATION_ARTIFACT_DUPLICATE', 'artifactKey must be unique');
    seen.add(artifactKey);
    const stagingResourceId = text(
      artifact.stagingResourceId,
      `artifacts[${index}].stagingResourceId`,
      256
    );
    if (!isValidTaskStagingResourceId(stagingResourceId)) {
      fail('STATEMENT_GENERATION_STAGING_RESOURCE_INVALID', 'stagingResourceId must be relative');
    }
    const stagingAlias = normalizeTargetAliasKey(path.normalize(stagingResourceId));
    if (stagingAliases.has(stagingAlias)) {
      fail('STATEMENT_GENERATION_STAGING_RESOURCE_ALIAS', 'stagingResourceId must be unique by platform alias');
    }
    stagingAliases.add(stagingAlias);
    return Object.freeze({ kind: artifact.kind, artifactKey, stagingResourceId });
  });
  return Object.freeze({
    command: record.command,
    token: publicGenerationToken(record.token),
    sessionKey: text(record.sessionKey, 'sessionKey'),
    sessionRevision: record.sessionRevision,
    kind,
    artifacts: Object.freeze(artifacts)
  });
}

function createStatementGenerationRequest(input) {
  const snapshot = canonicalJsonSnapshot(input, { maxBytes: MAX_INPUT_BYTES });
  return snapshot.command === 'prepare-generation'
    ? createStatementGenerationPrepareRequest(snapshot)
    : createStatementGenerationExecuteRequest(snapshot);
}

function validateWarningSummary(input) {
  const warningSummary = exact(
    input,
    ['count', 'byType', 'manualBalanceRequired'],
    'warningSummary'
  );
  if (!Number.isSafeInteger(warningSummary.count) || warningSummary.count < 0 ||
      typeof warningSummary.manualBalanceRequired !== 'boolean' ||
      !warningSummary.byType || typeof warningSummary.byType !== 'object' ||
      Array.isArray(warningSummary.byType) || Object.keys(warningSummary.byType).length > 16 ||
      Object.keys(warningSummary.byType).some((type) => type.length < 1 || type.length > 64) ||
      Object.values(warningSummary.byType).some((count) => !Number.isSafeInteger(count) || count < 1)) {
    fail('STATEMENT_GENERATION_WARNING_SUMMARY_INVALID', 'warningSummary is invalid');
  }
  const warningCount = Object.values(warningSummary.byType).reduce((sum, count) => sum + count, 0);
  if (warningSummary.count !== warningCount ||
      warningSummary.manualBalanceRequired !== Object.hasOwn(warningSummary.byType, 'balance-seed-required')) {
    fail('STATEMENT_GENERATION_WARNING_SUMMARY_INVALID', 'warningSummary totals are inconsistent');
  }
  return warningSummary;
}

function validateManifestItem(item) {
  const value = exact(item, [
    'artifactKey', 'generationPath', 'size', 'sha256', 'rowCounts', 'warningSummary',
    'sessionRevision', 'inputEvidenceHash'
  ], 'StatementArtifactManifest');
  text(value.artifactKey, 'artifactKey', 256);
  if (!path.isAbsolute(value.generationPath) || value.generationPath.length > 4096) {
    fail('STATEMENT_GENERATION_PATH_INVALID', 'generationPath must be a bounded absolute path');
  }
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ARTIFACT_BYTES ||
      !SHA256.test(value.sha256)) {
    fail('STATEMENT_GENERATION_FILE_EVIDENCE_INVALID', 'Artifact size/hash is invalid');
  }
  const rowCounts = exact(value.rowCounts, ['input', 'output'], 'rowCounts');
  if (![rowCounts.input, rowCounts.output].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    fail('STATEMENT_GENERATION_ROW_COUNTS_INVALID', 'rowCounts are invalid');
  }
  validateWarningSummary(value.warningSummary);
  if (!Number.isSafeInteger(value.sessionRevision) || value.sessionRevision < 1 ||
      !SHA256.test(value.inputEvidenceHash)) {
    fail('STATEMENT_GENERATION_SESSION_EVIDENCE_INVALID', 'Session evidence is invalid');
  }
  return true;
}

function validateStatementGenerationResult(value) {
  try {
    const result = exact(value, [
      'status', 'scope', 'artifacts', 'warningSummary', 'sessionRevision', 'inputEvidenceHash'
    ], 'StatementGenerationResult');
    if (result.status !== 'generated' || !['current', 'all'].includes(result.scope) ||
        !Array.isArray(result.artifacts) || result.artifacts.length < 1 ||
        result.artifacts.length > MAX_ARTIFACTS) return false;
    result.artifacts.forEach(validateManifestItem);
    validateWarningSummary(result.warningSummary);
    if (result.artifacts.some((item) => item.sessionRevision !== result.sessionRevision ||
        item.inputEvidenceHash !== result.inputEvidenceHash ||
        canonicalizeJson(item.warningSummary) !== canonicalizeJson(result.warningSummary))) return false;
    canonicalizeJson(result, { maxBytes: 256 * 1024 });
    return true;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  StatementGenerationContractError,
  createStatementGenerationExecuteRequest,
  createStatementGenerationPrepareRequest,
  createStatementGenerationRequest,
  validateManifestItem,
  validateStatementGenerationResult
};
