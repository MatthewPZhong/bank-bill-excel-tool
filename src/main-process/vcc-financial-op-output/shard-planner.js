'use strict';

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { VCC_EXPORT_SUBJECTS_MAX_WRITERS } = require('./policies');

function shardError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validateGenerationSet(generations) {
  if (!Array.isArray(generations) || generations.length < 1) {
    throw shardError('VCC_EXPORT_SHARD_INPUT_INVALID', 'VCC shard planner 缺少 generation set');
  }
  const keys = new Set();
  const paths = new Set();
  for (let index = 0; index < generations.length; index += 1) {
    const generation = generations[index];
    if (!exactKeys(generation, ['generationPath', 'outputArtifactKey', 'subjectIndex']) ||
        generation.subjectIndex !== index ||
        typeof generation.outputArtifactKey !== 'string' ||
        !/^output-[a-f0-9]{64}$/.test(generation.outputArtifactKey) ||
        keys.has(generation.outputArtifactKey) ||
        typeof generation.generationPath !== 'string' || !generation.generationPath ||
        paths.has(generation.generationPath)) {
      throw shardError(
        'VCC_EXPORT_SHARD_INPUT_INVALID',
        'VCC shard planner generation identity/set/order 非法'
      );
    }
    keys.add(generation.outputArtifactKey);
    paths.add(generation.generationPath);
  }
}

function planVccExportShards(generations, effectiveChildCount) {
  validateGenerationSet(generations);
  if (!Number.isSafeInteger(effectiveChildCount) || effectiveChildCount < 1 ||
      effectiveChildCount > VCC_EXPORT_SUBJECTS_MAX_WRITERS ||
      effectiveChildCount > generations.length) {
    throw shardError('VCC_EXPORT_SHARD_COUNT_INVALID', 'VCC shard count 必须是已获批的 1 或 2');
  }
  const baseSize = Math.floor(generations.length / effectiveChildCount);
  const remainder = generations.length % effectiveChildCount;
  let offset = 0;
  const shards = [];
  for (let shardIndex = 0; shardIndex < effectiveChildCount; shardIndex += 1) {
    const size = baseSize + (shardIndex < remainder ? 1 : 0);
    const owned = generations.slice(offset, offset + size).map((item) => Object.freeze({ ...item }));
    const subjectIndexes = owned.map((item) => item.subjectIndex);
    const body = Object.freeze({
      contractVersion: 1,
      shardIndex,
      shardCount: effectiveChildCount,
      subjectIndexes: Object.freeze(subjectIndexes)
    });
    shards.push(Object.freeze({
      ...body,
      shardDigest: canonicalSha256(body),
      generations: Object.freeze(owned)
    }));
    offset += size;
  }
  const coverage = shards.flatMap((shard) => shard.subjectIndexes);
  if (coverage.length !== generations.length ||
      coverage.some((subjectIndex, index) => subjectIndex !== index)) {
    throw shardError(
      'VCC_EXPORT_SHARD_COVERAGE_INVALID',
      'VCC shard planner 未形成 exact subjectIndex coverage'
    );
  }
  return Object.freeze(shards);
}

function normalizeVccExportShard(value, generations) {
  if (!exactKeys(value, [
    'contractVersion', 'shardCount', 'shardDigest', 'shardIndex', 'subjectIndexes'
  ]) || value.contractVersion !== 1 ||
      !Number.isSafeInteger(value.shardIndex) || value.shardIndex < 0 ||
      !Number.isSafeInteger(value.shardCount) || value.shardCount < 1 ||
      value.shardCount > VCC_EXPORT_SUBJECTS_MAX_WRITERS ||
      value.shardIndex >= value.shardCount ||
      typeof value.shardDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.shardDigest) ||
      !Array.isArray(value.subjectIndexes) || value.subjectIndexes.length < 1 ||
      value.subjectIndexes.length !== generations.length ||
      value.subjectIndexes.some((subjectIndex, index) => (
        !Number.isSafeInteger(subjectIndex) || subjectIndex < 0 ||
        subjectIndex !== generations[index].subjectIndex ||
        (index > 0 && subjectIndex !== value.subjectIndexes[index - 1] + 1)
      ))) {
    throw shardError('VCC_EXPORT_SHARD_IDENTITY_INVALID', 'VCC Writer shard identity 非法');
  }
  const body = {
    contractVersion: 1,
    shardIndex: value.shardIndex,
    shardCount: value.shardCount,
    subjectIndexes: value.subjectIndexes
  };
  if (canonicalSha256(body) !== value.shardDigest) {
    throw shardError('VCC_EXPORT_SHARD_IDENTITY_INVALID', 'VCC Writer shard digest 非法');
  }
  return Object.freeze({
    ...body,
    subjectIndexes: Object.freeze([...value.subjectIndexes]),
    shardDigest: value.shardDigest
  });
}

module.exports = {
  normalizeVccExportShard,
  planVccExportShards
};
