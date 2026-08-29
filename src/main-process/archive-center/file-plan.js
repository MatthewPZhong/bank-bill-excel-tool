'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('./source-snapshot');
const {
  pathsAlias,
  targetPathAliasKey
} = require('../toolbox-target-identity');

const FILE_PLAN_ALLOCATIONS = new Set(['eager', 'deferred', 'none']);
const normalizedFilePlans = new WeakSet();

function planError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function requiredText(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw planError('ARCHIVE_FILE_PLAN_INVALID', `${label}不能为空`);
  return text;
}

function absolutePath(value, label) {
  const filePath = requiredText(value, label);
  if (!path.isAbsolute(filePath)) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', `${label}必须是绝对路径`);
  }
  return path.normalize(filePath);
}

function snapshotFromRegularFile(fsImpl, filePath) {
  const stat = fsImpl.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', '输入必须是普通文件且不能是符号链接');
  }
  return Object.freeze({ ...sourceSnapshotFromStat(stat) });
}

function normalizeFreshnessFailure(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'freshnessFailure 必须是对象');
  }
  return Object.freeze({
    code: requiredText(value.code, 'freshnessFailure.code'),
    message: requiredText(value.message, 'freshnessFailure.message')
  });
}

function targetSnapshot(fsImpl, filePath) {
  const realParentPath = fsImpl.realpathSync(path.dirname(filePath));
  const parent = fsImpl.statSync(realParentPath);
  if (!parent.isDirectory()) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', '输出父目录必须是已存在的普通目录');
  }
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw planError('ARCHIVE_FILE_PLAN_INVALID', '输出目标必须是可覆盖的普通文件');
    }
    return Object.freeze({
      exists: true,
      snapshot: Object.freeze({ ...sourceSnapshotFromStat(stat) })
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') return Object.freeze({ exists: false });
    throw error;
  }
}

function artifactKeyOf(item) {
  const identity = [
    item.direction,
    item.role,
    item.sourceOperation,
    item.aliasKey
  ].join('\u0000');
  return `${item.direction}-${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

function normalizeItem(raw, direction, options) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'filePlan item 必须是对象');
  }
  const fsImpl = options.fsImpl;
  const filePath = absolutePath(raw.filePath, `${direction}.filePath`);
  const hasProvidedSourceSnapshot = direction === 'input'
    && Object.hasOwn(raw, 'sourceSnapshot');
  const aliasKey = targetPathAliasKey(fsImpl, filePath, {
    platform: options.platform,
    allowMissingParentLexicalFallback: hasProvidedSourceSnapshot
  });
  const base = {
    direction,
    filePath,
    originalName: path.basename(requiredText(raw.originalName || filePath, 'originalName')),
    role: requiredText(raw.role, 'role'),
    sourceOperation: requiredText(raw.sourceOperation, 'sourceOperation'),
    aliasKey
  };
  if (direction === 'input') {
    if (hasProvidedSourceSnapshot) {
      const sourceSnapshot = normalizeSourceSnapshot(raw.sourceSnapshot);
      if (!sourceSnapshot) {
        throw planError('ARCHIVE_FILE_PLAN_INVALID', 'input.sourceSnapshot 格式非法');
      }
      base.sourceSnapshot = Object.freeze({ ...sourceSnapshot });
    } else {
      base.sourceSnapshot = snapshotFromRegularFile(fsImpl, filePath);
    }
    const freshnessFailure = normalizeFreshnessFailure(raw.freshnessFailure);
    if (freshnessFailure) base.freshnessFailure = freshnessFailure;
  } else {
    base.targetSnapshot = targetSnapshot(fsImpl, filePath);
  }
  const derivedArtifactKey = artifactKeyOf(base);
  if (raw.artifactKey !== undefined
      && requiredText(raw.artifactKey, 'artifactKey') !== derivedArtifactKey) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'artifactKey 与规范化文件身份不一致');
  }
  base.artifactKey = derivedArtifactKey;
  return Object.freeze(base);
}

function assertNoAliasConflict(inputs, outputs, options) {
  const items = [...inputs, ...outputs];
  const seen = new Map();
  for (const item of items) {
    if (seen.has(item.artifactKey)) {
      throw planError('ARCHIVE_FILE_PLAN_INVALID', '同一 manifest 的 artifactKey 必须唯一');
    }
    seen.set(item.artifactKey, item);
  }
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      const crossDirection = left.direction !== right.direction;
      if (pathsAlias(options.fsImpl, left.filePath, right.filePath, {
        platform: options.platform,
        allowMissingParentLexicalFallback: options.providedSourceSnapshotPaths.has(left.filePath)
          || options.providedSourceSnapshotPaths.has(right.filePath)
      })) {
        throw planError(
          'ARCHIVE_FILE_PLAN_INVALID',
          crossDirection
            ? '输出目标不能覆盖或别名指向输入文件'
            : '同一方向不能重复登记别名指向同一文件'
        );
      }
    }
  }
}

function normalizeFilePlanV1(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'filePlan 必须是 version 1 对象');
  }
  const allocation = String(value.allocation || '');
  if (!FILE_PLAN_ALLOCATIONS.has(allocation)) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'filePlan allocation 非法');
  }
  const normalizedOptions = {
    fsImpl: options.fsImpl || fs,
    platform: options.platform || process.platform,
    providedSourceSnapshotPaths: new Set()
  };
  if (!Array.isArray(value.inputs) || !Array.isArray(value.outputs)) {
    throw planError('ARCHIVE_FILE_PLAN_INVALID', 'filePlan inputs/outputs 必须是数组');
  }
  const rawInputs = value.inputs;
  const rawOutputs = value.outputs;
  rawInputs.forEach((item) => {
    if (item && typeof item === 'object' && Object.hasOwn(item, 'sourceSnapshot')) {
      normalizedOptions.providedSourceSnapshotPaths.add(
        absolutePath(item.filePath, 'input.filePath')
      );
    }
  });
  if (allocation !== 'eager') {
    if (rawInputs.length || rawOutputs.length) {
      throw planError('ARCHIVE_FILE_PLAN_INVALID', 'deferred/none filePlan 必须为空');
    }
    const plan = Object.freeze({
      version: 1,
      allocation,
      inputs: Object.freeze([]),
      outputs: Object.freeze([])
    });
    normalizedFilePlans.add(plan);
    return plan;
  }
  if (rawInputs.length + rawOutputs.length === 0) {
    throw planError('ARCHIVE_FILE_MANIFEST_EMPTY', 'eager filePlan 必须至少包含一个文件');
  }
  const inputs = Object.freeze(rawInputs.map((item) => normalizeItem(item, 'input', normalizedOptions)));
  const outputs = Object.freeze(rawOutputs.map((item) => normalizeItem(item, 'output', normalizedOptions)));
  assertNoAliasConflict(inputs, outputs, normalizedOptions);
  const plan = Object.freeze({ version: 1, allocation, inputs, outputs });
  normalizedFilePlans.add(plan);
  return plan;
}

function assertNormalizedFilePlanV1(plan) {
  if (!plan || !normalizedFilePlans.has(plan)) {
    throw planError(
      'ARCHIVE_FILE_PLAN_AUTHORITY_INVALID',
      'filePlan必须是Main当前进程冻结的normalized authority'
    );
  }
  return plan;
}

function assertFilePlanFresh(plan, options = {}) {
  const fsImpl = options.fsImpl || fs;
  for (const input of plan.inputs) {
    const freshnessFailure = input.freshnessFailure || {
      code: 'ARCHIVE_INPUT_CHANGED',
      message: '输入文件在任务确认后已变化'
    };
    let stat;
    try {
      stat = fsImpl.lstatSync(input.filePath, { bigint: true });
    } catch (_error) {
      throw planError(freshnessFailure.code, freshnessFailure.message);
    }
    if (stat.isSymbolicLink()
        || !stat.isFile()
        || !sourceSnapshotMatchesStat(input.sourceSnapshot, stat)) {
      throw planError(freshnessFailure.code, freshnessFailure.message);
    }
  }
  for (const output of plan.outputs) {
    const expected = output.targetSnapshot;
    try {
      const stat = fsImpl.lstatSync(output.filePath);
      if (!expected.exists
          || stat.isSymbolicLink()
          || !stat.isFile()
          || !sourceSnapshotMatchesStat(expected.snapshot, stat)) {
        throw planError('ARCHIVE_TARGET_CHANGED', '输出目标在任务确认后已变化');
      }
    } catch (error) {
      if (error && error.code === 'ENOENT' && expected.exists === false) continue;
      if (error && error.code === 'ARCHIVE_TARGET_CHANGED') throw error;
      throw planError('ARCHIVE_TARGET_CHANGED', '输出目标在任务确认后已变化');
    }
  }
  return plan;
}

function manifestIdentityOf(items) {
  const canonical = [...items]
    .sort((left, right) => left.artifactKey.localeCompare(right.artifactKey))
    .map((item) => [
      '1', item.artifactKey, item.direction, item.role, item.sourceOperation, item.aliasKey
    ].join('\u0000'))
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function artifactManifestFromFilePlan(plan) {
  if (plan.allocation !== 'eager') {
    throw new TypeError('内部合同违反：只有 normalized eager filePlan 可以形成 manifest');
  }
  const items = [...plan.inputs, ...plan.outputs];
  return Object.freeze({
    version: 1,
    identity: manifestIdentityOf(items),
    inputs: plan.inputs,
    outputs: plan.outputs
  });
}

module.exports = {
  assertFilePlanFresh,
  assertNormalizedFilePlanV1,
  artifactKeyOf,
  artifactManifestFromFilePlan,
  manifestIdentityOf,
  normalizeFilePlanV1
};
