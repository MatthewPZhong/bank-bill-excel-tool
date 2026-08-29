'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertFilePlanFresh,
  assertNormalizedFilePlanV1
} = require('../archive-center/file-plan');
const {
  normalizeTargetParentIdentity
} = require('../archive-center/target-parent-identity');
const {
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../archive-center/source-snapshot');
const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');
const {
  pathsAlias
} = require('../toolbox-target-identity');
const {
  resolveTaskStagingResource,
  validateTaskOwnedStagingPath
} = require('../statement-worker/staging-ownership');
const {
  publishDurableArtifactAsync,
  recoverToolboxPublicationsAsync
} = require('../toolbox-output-publication-dispatch');
const {
  validateNewAccountGenerationResult
} = require('./generation-contract');
const {
  readBackAndValidateCooperatively
} = require('./generation-core');
const {
  assertNewAccountExpectedArtifactAuthority
} = require('./generation-validator');

const NEW_ACCOUNT_SAVE_AS_ACTION = 'new-account:save-as';
const NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION = 1;
const MAX_COPY_CONTRACT_BYTES = 256 * 1024;
const MAX_COPY_ARTIFACT_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

class NewAccountSaveAsError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'NewAccountSaveAsError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new NewAccountSaveAsError(code, message, cause);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    fail('NEW_ACCOUNT_SAVE_AS_CONTRACT_INVALID', `${label}字段非法`);
  }
  return value;
}

function boundedText(value, label, max = 4096) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    fail('NEW_ACCOUNT_SAVE_AS_CONTRACT_INVALID', `${label}非法`);
  }
  return value;
}

function absolutePath(value, label) {
  const normalized = path.normalize(boundedText(value, label));
  if (!path.isAbsolute(normalized)) {
    fail('NEW_ACCOUNT_SAVE_AS_PATH_INVALID', `${label}必须是绝对路径`);
  }
  return normalized;
}

function statIdentityValue(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString(10);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  fail('NEW_ACCOUNT_SAVE_AS_SOURCE_IDENTITY_INVALID', `${label}非法`);
}

function statLinkCountIsOne(stat) {
  return typeof stat.nlink === 'bigint' ? stat.nlink === 1n : stat.nlink === 1;
}

function sourceIdentityFromStat(filePath, canonicalPath, stat, expectedSha256) {
  const deviceId = statIdentityValue(stat.dev, 'source.deviceId');
  const inode = statIdentityValue(stat.ino, 'source.inode');
  const snapshot = sourceSnapshotFromStat(stat);
  if (!snapshot) fail('NEW_ACCOUNT_SAVE_AS_SOURCE_INVALID', 'NewAccount save-as source必须是普通文件');
  return Object.freeze({
    filePath: path.resolve(filePath),
    canonicalPath,
    canonicalPathSha256: crypto.createHash('sha256').update(canonicalPath, 'utf8').digest('hex'),
    deviceId,
    inode,
    fileIdReliable: deviceId !== '0' || inode !== '0',
    snapshot: Object.freeze({ ...snapshot }),
    byteSize: Number(stat.size),
    contentSha256: expectedSha256
  });
}

function assertNoSymlinkPathChain(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = fsImpl.lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error && error.code === 'ENOENT' && options.allowMissingFinal === true &&
          index === components.length - 1) {
        return Object.freeze({ resolved, exists: false, stat: null });
      }
      fail('NEW_ACCOUNT_SAVE_AS_PATH_INVALID', 'NewAccount save-as路径祖先缺失或不可读', error);
    }
    if (stat.isSymbolicLink()) {
      // macOS 的 /var、/tmp、/etc 是系统级 top-level compatibility aliases；
      // 允许仅这一层且 real target basename 不变。任务/用户路径内的任何 symlink
      // （包括 ancestor symlink）仍 fail closed。
      let topLevelCompatibilityAlias = false;
      if (platform === 'darwin' && index === 0 &&
          ['etc', 'tmp', 'var'].includes(components[index])) {
        try {
          topLevelCompatibilityAlias = path.basename(fsImpl.realpathSync(cursor)) === components[index];
        } catch (_error) {
          topLevelCompatibilityAlias = false;
        }
      }
      if (!topLevelCompatibilityAlias) {
        fail('NEW_ACCOUNT_SAVE_AS_PATH_SYMLINK', 'NewAccount save-as路径链不得包含符号链接');
      }
      continue;
    }
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail('NEW_ACCOUNT_SAVE_AS_PATH_INVALID', 'NewAccount save-as路径祖先必须是目录');
    }
  }
  const stat = fsImpl.lstatSync(resolved, { bigint: true });
  return Object.freeze({ resolved, exists: true, stat });
}

function sourceStat(filePath, fsImpl = fs, platform = process.platform) {
  const chain = assertNoSymlinkPathChain(filePath, { fsImpl, platform });
  const stat = chain.stat;
  if (!stat || !stat.isFile() || !statLinkCountIsOne(stat)) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_INVALID', 'NewAccount save-as source必须是普通单链接文件');
  }
  let canonicalPath;
  try {
    canonicalPath = path.resolve(fsImpl.realpathSync(chain.resolved));
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_INVALID', 'NewAccount save-as source realpath不可用', error);
  }
  return Object.freeze({ filePath: chain.resolved, canonicalPath, stat });
}

function normalizeSourceIdentity(value) {
  const source = exactObject(value, [
    'filePath', 'canonicalPath', 'canonicalPathSha256', 'deviceId', 'inode',
    'fileIdReliable', 'snapshot', 'byteSize', 'contentSha256'
  ], 'source');
  const snapshot = normalizeSourceSnapshot(source.snapshot);
  if (!snapshot || typeof source.fileIdReliable !== 'boolean' ||
      !Number.isSafeInteger(source.byteSize) || source.byteSize < 1 ||
      source.byteSize > MAX_COPY_ARTIFACT_BYTES ||
      !SHA256.test(source.canonicalPathSha256) || !SHA256.test(source.contentSha256)) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_IDENTITY_INVALID', 'NewAccount save-as source identity非法');
  }
  const filePath = absolutePath(source.filePath, 'source.filePath');
  const canonicalPath = absolutePath(source.canonicalPath, 'source.canonicalPath');
  const normalized = Object.freeze({
    filePath,
    canonicalPath,
    canonicalPathSha256: source.canonicalPathSha256,
    deviceId: statIdentityValue(source.deviceId, 'source.deviceId'),
    inode: statIdentityValue(source.inode, 'source.inode'),
    fileIdReliable: source.fileIdReliable,
    snapshot: Object.freeze({ ...snapshot }),
    byteSize: source.byteSize,
    contentSha256: source.contentSha256
  });
  if (crypto.createHash('sha256').update(canonicalPath, 'utf8').digest('hex') !==
      normalized.canonicalPathSha256) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_IDENTITY_INVALID', 'NewAccount save-as canonical path摘要非法');
  }
  return normalized;
}

function normalizeCopyInput(rawInput) {
  const value = canonicalJsonSnapshot(rawInput, { maxBytes: MAX_COPY_CONTRACT_BYTES });
  const record = exactObject(value, ['schemaVersion', 'artifactKey', 'source', 'staging'], 'input');
  if (record.schemaVersion !== NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION) {
    fail('NEW_ACCOUNT_SAVE_AS_CONTRACT_INVALID', 'NewAccount save-as schemaVersion非法');
  }
  const staging = exactObject(
    record.staging,
    ['root', 'resourceId', 'filePath'],
    'staging'
  );
  const root = absolutePath(staging.root, 'staging.root');
  const resourceId = boundedText(staging.resourceId, 'staging.resourceId', 256);
  const filePath = absolutePath(staging.filePath, 'staging.filePath');
  let expectedPath;
  try {
    expectedPath = resolveTaskStagingResource(root, resourceId);
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging resource非法', error);
  }
  if (expectedPath !== filePath) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging path与resource不一致');
  }
  return Object.freeze({
    schemaVersion: NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION,
    artifactKey: boundedText(record.artifactKey, 'artifactKey', 256),
    source: normalizeSourceIdentity(record.source),
    staging: Object.freeze({ root, resourceId, filePath })
  });
}

function snapshotSourceGenerationResult(value) {
  const snapshot = canonicalJsonSnapshot(value, { maxBytes: MAX_COPY_CONTRACT_BYTES });
  if (!validateNewAccountGenerationResult(snapshot)) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_EVIDENCE_INVALID', 'E10-A source artifact evidence非法');
  }
  return snapshot;
}

function assertSaveAsPathsDistinct(filePlan, input, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  for (const [left, right] of [
    [filePlan.inputs[0].filePath, filePlan.outputs[0].filePath],
    [filePlan.inputs[0].filePath, input.staging.filePath],
    [filePlan.outputs[0].filePath, input.staging.filePath]
  ]) {
    if (pathsAlias(fsImpl, left, right, {
      platform,
      allowMissingParentLexicalFallback: true
    })) {
      fail('NEW_ACCOUNT_SAVE_AS_PATH_ALIAS', 'NewAccount source/target/staging不得互为别名');
    }
  }
}

function createNewAccountSaveAsInput(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const sourceGenerationResult = snapshotSourceGenerationResult(options.sourceGenerationResult);
  let filePlan;
  try {
    filePlan = assertNormalizedFilePlanV1(options.filePlan);
  } catch (error) {
    fail(
      'NEW_ACCOUNT_SAVE_AS_FILE_PLAN_AUTHORITY_INVALID',
      'NewAccount save-as只接受Main冻结的FilePlan authority',
      error
    );
  }
  if (filePlan.allocation !== 'eager' || filePlan.inputs.length !== 1 ||
      filePlan.outputs.length !== 1 ||
      filePlan.inputs[0].sourceOperation !== NEW_ACCOUNT_SAVE_AS_ACTION ||
      filePlan.outputs[0].sourceOperation !== NEW_ACCOUNT_SAVE_AS_ACTION) {
    fail('NEW_ACCOUNT_SAVE_AS_FILE_PLAN_INVALID', 'NewAccount save-as FilePlan必须精确绑定一个source和target');
  }
  try {
    normalizeTargetParentIdentity(filePlan.outputs[0].targetParentIdentity, {
      requireReliable: true
    });
  } catch (error) {
    fail(
      'NEW_ACCOUNT_SAVE_AS_TARGET_PARENT_IDENTITY_UNAVAILABLE',
      'NewAccount save-as要求可靠的direct target parent identity',
      error
    );
  }
  const sourcePath = filePlan.inputs[0].filePath;
  const targetPath = filePlan.outputs[0].filePath;
  try {
    assertFilePlanFresh(filePlan, { fsImpl });
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_FILE_PLAN_CHANGED', 'NewAccount save-as FilePlan证据已变化', error);
  }
  const source = sourceStat(sourcePath, fsImpl, platform);
  if (!sourceSnapshotMatchesStat(filePlan.inputs[0].sourceSnapshot, source.stat) ||
      Number(source.stat.size) !== sourceGenerationResult.artifact.byteSize) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_CHANGED', 'E10-A source artifact已变化');
  }
  assertNoSymlinkPathChain(targetPath, { fsImpl, platform, allowMissingFinal: true });
  const stagingRoot = absolutePath(options.stagingRoot, 'stagingRoot');
  const stagingPath = absolutePath(options.stagingPath, 'stagingPath');
  let expectedStagingPath;
  try {
    expectedStagingPath = resolveTaskStagingResource(stagingRoot, options.stagingResourceId);
    validateTaskOwnedStagingPath({
      stagingRoot,
      candidatePath: stagingPath,
      finalState: 'missing',
      fsImpl
    });
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging必须是task-owned missing resource', error);
  }
  if (expectedStagingPath !== stagingPath) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging path与resource不一致');
  }
  const sourceIdentity = sourceIdentityFromStat(
    sourcePath,
    source.canonicalPath,
    source.stat,
    sourceGenerationResult.artifact.sha256
  );
  const input = normalizeCopyInput({
    schemaVersion: NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION,
    artifactKey: filePlan.outputs[0].artifactKey,
    source: sourceIdentity,
    staging: {
      root: stagingRoot,
      resourceId: options.stagingResourceId,
      filePath: stagingPath
    }
  });
  assertSaveAsPathsDistinct(filePlan, input, { fsImpl, platform });
  return input;
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) {
    fail('NEW_ACCOUNT_SAVE_AS_CANCELLED', '新开账户另存为复制已取消');
  }
}

async function checkpoint(options, name, details = {}) {
  if (typeof options.checkpoint === 'function') {
    await options.checkpoint(name, Object.freeze({ ...details }));
  }
}

async function fileSha256Async(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const createReadStream = typeof fsImpl.createReadStream === 'function'
    ? fsImpl.createReadStream.bind(fsImpl)
    : fs.createReadStream.bind(fs);
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of createReadStream(filePath)) {
      assertNotCancelled(options.signal);
      hash.update(chunk);
    }
  } catch (error) {
    if (error && error.code === 'NEW_ACCOUNT_SAVE_AS_CANCELLED') throw error;
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_READ_FAILED', 'NewAccount save-as source无法读取', error);
  }
  assertNotCancelled(options.signal);
  return hash.digest('hex');
}

function assertSourceMetadataCurrent(source, fsImpl = fs, platform = process.platform) {
  const current = sourceStat(source.filePath, fsImpl, platform);
  if (current.canonicalPath !== source.canonicalPath ||
      crypto.createHash('sha256').update(current.canonicalPath, 'utf8').digest('hex') !==
        source.canonicalPathSha256 ||
      !sourceSnapshotMatchesStat(source.snapshot, current.stat) ||
      Number(current.stat.size) !== source.byteSize) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_CHANGED', 'NewAccount save-as source identity/snapshot已变化');
  }
  const deviceId = statIdentityValue(current.stat.dev, 'source.deviceId');
  const inode = statIdentityValue(current.stat.ino, 'source.inode');
  if (source.fileIdReliable && (deviceId !== source.deviceId || inode !== source.inode)) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_CHANGED', 'NewAccount save-as source file identity已变化');
  }
  return current;
}

async function assertSourceCurrent(source, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const before = assertSourceMetadataCurrent(source, fsImpl, platform);
  const sha256 = await fileSha256Async(source.canonicalPath, {
    fsImpl,
    signal: options.signal
  });
  const after = assertSourceMetadataCurrent(source, fsImpl, platform);
  const beforeSnapshot = sourceSnapshotFromStat(before.stat);
  if (!beforeSnapshot || !sourceSnapshotMatchesStat(beforeSnapshot, after.stat) ||
      sha256 !== source.contentSha256) {
    fail('NEW_ACCOUNT_SAVE_AS_SOURCE_CHANGED', 'NewAccount save-as source content已变化');
  }
  return true;
}

function cleanupOwnedCopyStaging(rawInput, options = {}) {
  let input;
  try {
    input = normalizeCopyInput(rawInput);
    const owned = validateTaskOwnedStagingPath({
      stagingRoot: input.staging.root,
      candidatePath: input.staging.filePath,
      finalState: 'missing-or-file',
      fsImpl: options.fsImpl || fs
    });
    if (owned.exists) (options.fsImpl || fs).rmSync(owned.candidate, { force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function snapshotMatches(left, right) {
  const normalized = normalizeSourceSnapshot(left);
  if (!normalized || !right) return false;
  return sourceSnapshotMatchesStat(normalized, right);
}

function validateNewAccountSaveAsResult(value) {
  try {
    const result = exactObject(value, ['schemaVersion', 'status', 'artifact'], 'result');
    const artifact = exactObject(result.artifact, [
      'artifactKey', 'byteSize', 'sha256', 'sourceIdentitySha256', 'stagingSnapshot'
    ], 'result.artifact');
    return result.schemaVersion === NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION &&
      result.status === 'copied' &&
      typeof artifact.artifactKey === 'string' && artifact.artifactKey.length > 0 &&
      Number.isSafeInteger(artifact.byteSize) && artifact.byteSize > 0 &&
      artifact.byteSize <= MAX_COPY_ARTIFACT_BYTES &&
      SHA256.test(artifact.sha256) && SHA256.test(artifact.sourceIdentitySha256) &&
      Boolean(normalizeSourceSnapshot(artifact.stagingSnapshot));
  } catch (_error) {
    return false;
  }
}

Object.defineProperty(validateNewAccountSaveAsResult, 'allowFinanceSafeValue', {
  value({ value, key, parent }) {
    return ['sha256', 'sourceIdentitySha256'].includes(key) &&
      typeof value === 'string' && SHA256.test(value) &&
      parent && typeof parent === 'object' && parent[key] === value;
  }
});

async function executeNewAccountArtifactCopy(rawInput, signal, options = {}) {
  const input = normalizeCopyInput(rawInput);
  const fsImpl = options.fsImpl || fs;
  const fsPromises = options.fsPromises || fs.promises;
  assertNotCancelled(signal);
  try {
    validateTaskOwnedStagingPath({
      stagingRoot: input.staging.root,
      candidatePath: input.staging.filePath,
      finalState: 'missing',
      fsImpl
    });
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging不是task-owned missing resource', error);
  }
  try {
    await checkpoint(options, 'copy:before-source-verify');
    await assertSourceCurrent(input.source, { fsImpl, signal });
    await checkpoint(options, 'copy:before-copy');
    assertNotCancelled(signal);
    await fsPromises.copyFile(
      input.source.canonicalPath,
      input.staging.filePath,
      fs.constants.COPYFILE_EXCL
    );
    await checkpoint(options, 'copy:after-copy');
    assertNotCancelled(signal);
    const owned = validateTaskOwnedStagingPath({
      stagingRoot: input.staging.root,
      candidatePath: input.staging.filePath,
      finalState: 'file',
      fsImpl
    });
    await assertSourceCurrent(input.source, { fsImpl, signal });
    await checkpoint(options, 'copy:after-source-verify');
    await assertSourceCurrent(input.source, { fsImpl, signal });
    const stagingSha256 = await fileSha256Async(input.staging.filePath, {
      fsImpl,
      signal
    });
    const finalOwned = validateTaskOwnedStagingPath({
      stagingRoot: input.staging.root,
      candidatePath: input.staging.filePath,
      finalState: 'file',
      fsImpl
    });
    if (!snapshotMatches(sourceSnapshotFromStat(owned.stat), finalOwned.stat) ||
        Number(finalOwned.stat.size) !== input.source.byteSize ||
        stagingSha256 !== input.source.contentSha256) {
      fail('NEW_ACCOUNT_SAVE_AS_STAGING_TAMPERED', 'NewAccount copy staging size/hash/identity不一致');
    }
    await checkpoint(options, 'copy:before-terminal');
    assertNotCancelled(signal);
    return Object.freeze({
      schemaVersion: NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION,
      status: 'copied',
      artifact: Object.freeze({
        artifactKey: input.artifactKey,
        byteSize: input.source.byteSize,
        sha256: stagingSha256,
        sourceIdentitySha256: canonicalSha256(input.source),
        stagingSnapshot: Object.freeze({ ...sourceSnapshotFromStat(finalOwned.stat) })
      })
    });
  } catch (error) {
    cleanupOwnedCopyStaging(input, { fsImpl });
    if (error && typeof error.code === 'string' && error.code.startsWith('NEW_ACCOUNT_SAVE_AS_')) {
      throw error;
    }
    fail('NEW_ACCOUNT_SAVE_AS_COPY_FAILED', '新开账户另存为异步复制失败', error);
  }
}

async function runNewAccountArtifactCopyInline({ input, signal }) {
  try {
    return await executeNewAccountArtifactCopy(input, signal);
  } catch (error) {
    // Inline adapter 用 AbortSignal.reason 的对象身份形成 cancellation terminal
    // evidence；模块 direct seam 仍保留稳定业务错误码供 fault tests/日志使用。
    if (signal && signal.aborted && error && error.code === 'NEW_ACCOUNT_SAVE_AS_CANCELLED') {
      throw signal.reason;
    }
    throw error;
  }
}

async function validateCopiedArtifact(input, result, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!validateNewAccountSaveAsResult(result) ||
      result.artifact.artifactKey !== input.artifactKey ||
      result.artifact.sourceIdentitySha256 !== canonicalSha256(input.source)) {
    fail('NEW_ACCOUNT_SAVE_AS_RESULT_INVALID', 'NewAccount copy result contract非法');
  }
  let owned;
  try {
    owned = validateTaskOwnedStagingPath({
      stagingRoot: input.staging.root,
      candidatePath: input.staging.filePath,
      finalState: 'file',
      fsImpl
    });
  } catch (error) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_INVALID', 'NewAccount copy staging ownership失效', error);
  }
  const sha256 = await fileSha256Async(input.staging.filePath, { fsImpl });
  if (!snapshotMatches(result.artifact.stagingSnapshot, owned.stat) ||
      Number(owned.stat.size) !== result.artifact.byteSize ||
      sha256 !== result.artifact.sha256) {
    fail('NEW_ACCOUNT_SAVE_AS_STAGING_TAMPERED', 'NewAccount copy staging technical evidence不一致');
  }
  await assertSourceCurrent(input.source, { fsImpl });
  return Object.freeze({ owned, sha256 });
}

async function validateAndPublishNewAccountSaveAs(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const expectedArtifact = assertNewAccountExpectedArtifactAuthority(
    options.expectedArtifactAuthority
  );
  if (typeof options.settleArtifacts !== 'function') {
    fail(
      'NEW_ACCOUNT_SAVE_AS_SETTLEMENT_REQUIRED',
      'NewAccount save-as缺少Task artifact durable settlement owner'
    );
  }
  const sourceGenerationResult = snapshotSourceGenerationResult(options.sourceGenerationResult);
  let filePlan;
  try {
    filePlan = assertNormalizedFilePlanV1(options.filePlan);
  } catch (error) {
    fail(
      'NEW_ACCOUNT_SAVE_AS_FILE_PLAN_AUTHORITY_INVALID',
      'NewAccount save-as只接受Main冻结的FilePlan authority',
      error
    );
  }
  const input = createNewAccountSaveAsInput({
    ...options,
    filePlan,
    sourceGenerationResult
  });
  const publisher = options.publisher || publishDurableArtifactAsync;
  let preserveTemporaryFiles = false;
  try {
    const execution = await options.runtime.execute({
      actionKey: NEW_ACCOUNT_SAVE_AS_ACTION,
      operationKey: options.operationKey,
      production: options.production === true,
      context: options.context,
      input
    });
    if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
      return Object.freeze({ execution, copied: null, publication: null });
    }
    if (typeof options.onCopyCompleted === 'function') {
      await options.onCopyCompleted({ stagingPath: input.staging.filePath });
    }
    await validateCopiedArtifact(input, execution.result, { fsImpl });
    assertFilePlanFresh(filePlan, { fsImpl });
    assertNoSymlinkPathChain(filePlan.outputs[0].filePath, {
      fsImpl,
      platform,
      allowMissingFinal: filePlan.outputs[0].targetSnapshot.exists === false
    });
    const readback = await readBackAndValidateCooperatively(
      input.staging.filePath,
      {
        sheetNames: expectedArtifact.sheetNames,
        headers: expectedArtifact.headers,
        rowCount: expectedArtifact.rowCount,
        businessEvidence: expectedArtifact.businessEvidence,
        worksheetAuthority: expectedArtifact.worksheetAuthority
      },
      null
    );
    const validated = await validateCopiedArtifact(input, execution.result, { fsImpl });
    assertFilePlanFresh(filePlan, { fsImpl });
    assertNoSymlinkPathChain(filePlan.outputs[0].filePath, {
      fsImpl,
      platform,
      allowMissingFinal: filePlan.outputs[0].targetSnapshot.exists === false
    });
    assertSaveAsPathsDistinct(filePlan, input, { fsImpl, platform });
    const publication = await publisher({
      taskId: options.taskId,
      userDataDir: options.userDataDir,
      batchContext: options.batchContext,
      protectedSourcePaths: [filePlan.inputs[0].filePath],
      artifacts: [{
        sourcePath: input.staging.filePath,
        byteSize: Number(validated.owned.stat.size),
        sha256: validated.sha256,
        fileName: filePlan.outputs[0].originalName,
        dataRowCount: readback.rowCount,
        sheetCount: readback.sheetCount
      }],
      targets: [{
        targetPath: filePlan.outputs[0].filePath,
        expectedTargetSnapshot: filePlan.outputs[0].targetSnapshot,
        expectedTargetParentIdentity: filePlan.outputs[0].targetParentIdentity,
        fileName: filePlan.outputs[0].originalName
      }],
      requireTargetParentIdentity: true,
      archiveInputFiles: [{
        filePath: filePlan.inputs[0].filePath,
        sourceOperation: filePlan.inputs[0].sourceOperation,
        originalName: filePlan.inputs[0].originalName,
        sourceSnapshot: filePlan.inputs[0].sourceSnapshot,
        expectedSha256: input.source.contentSha256,
        expectedSizeBytes: input.source.byteSize
      }]
    });
    if (!publication || publication.committed !== true ||
        publication.pendingArchiveHandoff !== true) {
      fail(
        'NEW_ACCOUNT_SAVE_AS_PUBLICATION_RECEIPT_INVALID',
        'NewAccount Publisher未返回durable archive-handoff receipt'
      );
    }
    let settlement;
    let publicationForReturn = publication;
    try {
      settlement = await options.settleArtifacts({
        files: [
          { artifactKey: filePlan.inputs[0].artifactKey },
          {
            artifactKey: filePlan.outputs[0].artifactKey,
            expectedSha256: validated.sha256,
            expectedSizeBytes: Number(validated.owned.stat.size)
          }
        ]
      });
      if (!settlement || settlement.durable !== true) {
        throw Object.assign(new Error('NewAccount Task artifact尚未durable'), {
          code: 'NEW_ACCOUNT_SAVE_AS_SETTLEMENT_NOT_DURABLE'
        });
      }
    } catch (error) {
      publicationForReturn = Object.freeze({
        ...publication,
        pendingArchiveHandoff: true,
        warnings: Object.freeze([
          ...(Array.isArray(publication.warnings) ? publication.warnings : []),
          '正式输出已提交；Task artifact durable settlement 待既有启动 recovery 接管。'
        ])
      });
      settlement = Object.freeze({
        durable: false,
        pendingRecovery: true,
        code: error && error.code || 'NEW_ACCOUNT_SAVE_AS_SETTLEMENT_FAILED'
      });
    }
    return Object.freeze({
      execution,
      copied: execution.result.artifact,
      publication: publicationForReturn,
      settlement
    });
  } catch (error) {
    preserveTemporaryFiles = Boolean(error && error.preserveTemporaryFiles === true);
    throw error;
  } finally {
    if (!preserveTemporaryFiles) cleanupOwnedCopyStaging(input, { fsImpl });
  }
}

async function acknowledgeNewAccountSaveAsPublication(options = {}) {
  if (options.taskTerminalPersisted !== true) {
    fail(
      'NEW_ACCOUNT_SAVE_AS_RECEIPT_ACK_PREMATURE',
      'NewAccount publication receipt只能在Task终态持久化后确认'
    );
  }
  const taskId = boundedText(options.taskId, 'taskId', 512);
  const recovered = await (options.recoverPublications || recoverToolboxPublicationsAsync)({
    userDataDir: absolutePath(options.userDataDir, 'userDataDir'),
    deferCommittedRecovery: true,
    acknowledgedCommittedTaskIds: [taskId]
  });
  const finalized = Array.isArray(recovered && recovered.recovered)
    ? recovered.recovered.find((item) => item && String(item.taskId) === taskId)
    : null;
  if (!finalized || finalized.action !== 'commit-cleanup') {
    fail(
      'NEW_ACCOUNT_SAVE_AS_RECEIPT_ACK_FAILED',
      'NewAccount publication receipt未完成Task终态确认清理'
    );
  }
  return Object.freeze({ taskId, acknowledged: true });
}

module.exports = {
  MAX_COPY_ARTIFACT_BYTES,
  NEW_ACCOUNT_SAVE_AS_ACTION,
  NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION,
  NewAccountSaveAsError,
  assertNoSymlinkPathChain,
  acknowledgeNewAccountSaveAsPublication,
  assertSaveAsPathsDistinct,
  assertSourceCurrent,
  cleanupOwnedCopyStaging,
  createNewAccountSaveAsInput,
  executeNewAccountArtifactCopy,
  fileSha256Async,
  normalizeCopyInput,
  runNewAccountArtifactCopyInline,
  snapshotSourceGenerationResult,
  validateAndPublishNewAccountSaveAs,
  validateCopiedArtifact,
  validateNewAccountSaveAsResult
};
