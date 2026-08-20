'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_SCENARIOS,
  REQUIRED_VARIANTS,
  main: runPackagedMeasurement
} = require('./measure-packaged-startup');

const OWNER_MARKER = '.windows-startup-acceptance-owner.json';
const ACCEPTANCE_THRESHOLD_PERCENT = 70;
const FORMAL_GOLDEN_MIN_BYTES = 2_700_000_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POWER_PLAN_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMING_TOLERANCE_MS = 0.000001;
const PUBLIC_PRIVACY = Object.freeze({
  allowlistVersion: 1,
  publishable: true,
  pathsRecorded: false,
  rawReportsIncluded: false,
  rawLogsIncluded: false,
  databaseFilesIncluded: false
});
const REQUIRED_STARTUP_PHASES = Object.freeze([
  'database-open',
  'database-migrations',
  'database-vacuum',
  'database-optimize',
  'archive-root-recovery',
  'archive-outbox',
  'vcc-lineage-gate',
  'template-sync',
  'window-create',
  'window-load',
  'window-ready',
  'startup-total'
]);
const PUBLIC_TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'kind', 'mode', 'generatedAt', 'comparisonId', 'candidateEvidenceSha256',
  'releaseCandidateSha256', 'releaseBoundAt', 'environment', 'artifacts', 'scenarios', 'manualReceipts',
  'evaluation', 'privacy'
]);
const PUBLIC_ALLOWED_NESTED_KEYS = new Set([
  ...REQUIRED_SCENARIOS, ...REQUIRED_VARIANTS,
  'status', 'evidenceSource', 'digest', 'hostIdSha256', 'os', 'cpu', 'memory', 'localDisk',
  'pathClass', 'goldenPathClass', 'powerPlan', 'defender', 'cachePolicy', 'diskBudget',
  'caption', 'version', 'build', 'arch', 'model', 'logicalCores', 'totalBytes', 'driveType',
  'fileSystem', 'sizeBytes', 'freeBytes', 'mediaType', 'busType', 'guid',
  'realtimeProtectionEnabled', 'engineVersion', 'productVersion', 'signatureVersion',
  'workRootExcluded', 'goldenExcluded', 'firstSampleRetained', 'explicitCacheFlush', 'order',
  'comparisonScope', 'normalSimultaneousCopies', 'nonNormalPeakEquivalentCopies',
  'completedNonNormalSamplesRetained', 'requiredFreeBytes', 'safetyBytes', 'availableFreeBytes',
  'sufficient', 'variants', 'cleanup', 'artifact', 'provenance', 'label', 'sha256', 'fileVersion',
  'pathRecorded', 'kind', 'source', 'setup', 'installed', 'launched', 'frozen', 'installMode',
  'installedExeResolvedFrom', 'verified', 'installedApplicationsRemoved',
  'controlledWorkRootRemoved', 'schemaVersion', 'scenario', 'run', 'requiresManualCleanup',
  'contract', 'runsPerVariant', 'rotatingOrder', 'golden', 'walSha256', 'shmSha256',
  'walSizeBytes', 'shmSizeBytes',
  'sourcePathRecorded', 'sampleCount', 'samples', 'round', 'externalFullReadyMs', 'phaseEvidence',
  'required', 'count', 'records', 'phase', 'durationMs', 'outcome', 'counts', 'readyEvidence', 'mode',
  'rendererInitMs', 'windowReadyMs', 'startupTotalMs',
  'processEvidence', 'observedProcessCount', 'nonceSha256', 'closeAcceptedCount',
  'closeTokenRevalidated', 'rootExitCode', 'rootExitSignal', 'treeExited', 'verifiedEmpty',
  'quiescenceEmptySnapshots', 'bundleEvidence', 'before', 'after', 'main', 'wal', 'shm',
  'recoveryEvidence', 'cleanupReceipt', 'processTree', 'workingCopy', 'targetIdentitySha256',
  'verifiedAbsent',
  'scenarioEvidence', 'prePending', 'postPending', 'activeTaskRuns', 'activeBatches',
  'pendingArtifacts', 'flowBindIntents', 'vacuumFlagAfter', 'schemaChanged', 'validWalPending',
  'vacuumFlagBefore', 'journalSentinelPresentBefore', 'journalSentinelConsumedAfter',
  'schemaCurrentBefore',
  'legacySteady', 'vacuumOutcome', 'recoveryCountsZero', 'schemaValid', 'columnDeltaValid',
  'indexDefinitionValid', 'schemaDelta', 'added', 'removed', 'changed', 'type', 'name',
  'schemaFingerprintBefore', 'schemaFingerprintAfter', 'columnDefinitions',
  'vcc_fin_op_system_snapshots', 'archive_blobs', 'archive_artifacts', 'cid', 'notNull',
  'defaultValue', 'primaryKey', 'indexEvidence', 'actualDefinitionSha256',
  'expectedDefinitionSha256', 'matchesExpected',
  'walBytesBefore', 'walSentinelBaseDiffers', 'walSentinelCheckpointed',
  'fullReportSha256', 'processSeams', 'finalSignoff', 'receiptSha256', 'signedAt', 'formal', 'reasonCodes',
  'releaseBoundAt', 'evidenceCode',
  'comparisons', 'installer', 'portable', 'baselineMedianMs', 'currentMedianMs',
  'reductionPercent', 'thresholdPercent', 'passed', 'metric', 'allowlistVersion', 'publishable',
  'pathsRecorded', 'rawReportsIncluded', 'rawLogsIncluded', 'databaseFilesIncluded'
]);
const PUBLIC_BOOLEAN_KEYS = new Set([
  'realtimeProtectionEnabled', 'workRootExcluded', 'goldenExcluded', 'firstSampleRetained',
  'explicitCacheFlush', 'sufficient', 'pathRecorded', 'verified', 'installedApplicationsRemoved',
  'controlledWorkRootRemoved', 'requiresManualCleanup', 'sourcePathRecorded', 'required',
  'closeTokenRevalidated', 'treeExited', 'verifiedEmpty', 'verifiedAbsent', 'schemaChanged', 'validWalPending',
  'legacySteady', 'recoveryCountsZero', 'schemaValid', 'columnDeltaValid', 'indexDefinitionValid',
  'walSentinelBaseDiffers', 'walSentinelCheckpointed', 'matchesExpected', 'formal', 'passed', 'publishable',
  'journalSentinelPresentBefore', 'journalSentinelConsumedAfter',
  'schemaCurrentBefore',
  'pathsRecorded', 'rawReportsIncluded', 'rawLogsIncluded', 'databaseFilesIncluded'
]);
const PUBLIC_NUMBER_KEYS = new Set([
  'logicalCores', 'totalBytes', 'driveType', 'sizeBytes', 'freeBytes',
  'normalSimultaneousCopies', 'nonNormalPeakEquivalentCopies', 'completedNonNormalSamplesRetained',
  'requiredFreeBytes', 'safetyBytes', 'availableFreeBytes', 'runsPerVariant', 'sampleCount', 'round',
  'externalFullReadyMs', 'count', 'durationMs', 'rendererInitMs', 'windowReadyMs', 'startupTotalMs',
  'observedProcessCount', 'closeAcceptedCount', 'rootExitCode', 'quiescenceEmptySnapshots',
  'databaseSizeBytes', 'activeTaskRuns', 'activeBatches', 'pendingArtifacts', 'flowBindIntents',
  'walBytesBefore', 'walSizeBytes', 'shmSizeBytes', 'cid', 'notNull', 'primaryKey',
  'baselineMedianMs', 'currentMedianMs', 'reductionPercent', 'thresholdPercent',
  'allowlistVersion'
]);
const PUBLIC_ARRAY_KEYS = new Set(['rotatingOrder', 'samples', 'reasonCodes', 'records', 'counts',
  'vcc_fin_op_system_snapshots', 'archive_blobs', 'archive_artifacts']);
const PUBLIC_STRING_KEYS = new Set([
  'status', 'evidenceSource', 'digest', 'hostIdSha256', 'pathClass', 'goldenPathClass',
  'caption', 'version', 'build', 'arch', 'model', 'fileSystem', 'mediaType', 'busType', 'guid',
  'engineVersion', 'productVersion', 'signatureVersion', 'order', 'comparisonScope', 'label',
  'sha256', 'fileVersion', 'kind', 'installMode', 'installedExeResolvedFrom', 'scenario', 'mode',
  'phase', 'type', 'name',
  'walSha256', 'shmSha256', 'nonceSha256', 'vacuumFlagBefore', 'vacuumFlagAfter', 'vacuumOutcome', 'outcome',
  'targetIdentitySha256', 'schemaFingerprintBefore', 'schemaFingerprintAfter',
  'actualDefinitionSha256', 'expectedDefinitionSha256', 'fullReportSha256', 'receiptSha256',
  'signedAt', 'releaseBoundAt', 'evidenceCode', 'metric'
]);
const REQUIRED_INPUT_KEYS = Object.freeze([
  '3.1.11-setup', '3.1.11-portable', '3.1.12-setup', '3.1.12-portable'
]);

function codedError(code, message, evidence = {}) {
  const error = new Error(message);
  error.code = code;
  error.evidence = evidence;
  return error;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function fileIdentity(filePath, readFileVersion) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw codedError('ACCEPTANCE_INPUT_NOT_FILE', '输入制品必须是普通文件');
  return {
    sha256: sha256File(filePath),
    sizeBytes: stat.size,
    fileVersion: String(readFileVersion(filePath) || '').trim(),
    pathRecorded: false
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function evidenceDigest(value) {
  return sha256Text(JSON.stringify(stableValue(value)));
}

function canonicalIsoTimestamp(value, label) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw codedError('CANONICAL_TIME_INVALID', `${label} 必须是 canonical ISO UTC millisecond timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw codedError('CANONICAL_TIME_INVALID', `${label} 必须是 canonical ISO UTC millisecond timestamp`);
  }
  return value;
}

function canonicalNow(options = {}, label = 'now') {
  const provider = options && options.now;
  const raw = typeof provider === 'function' ? provider() : provider;
  const value = raw instanceof Date ? raw.toISOString()
    : raw === undefined ? new Date().toISOString() : raw;
  return canonicalIsoTimestamp(value, label);
}

function cleanupTargetIdentitySha256({ comparisonId, scenario, label, round }) {
  if (typeof comparisonId !== 'string' || !comparisonId
      || !REQUIRED_SCENARIOS.includes(scenario) || !REQUIRED_VARIANTS.includes(label)
      || !Number.isSafeInteger(round) || round < 1) {
    throw codedError('CLEANUP_TARGET_BINDING_INVALID', 'cleanup public target binding 坐标无效');
  }
  return evidenceDigest({
    schemaVersion: 1,
    kind: 'windows-startup-cleanup-target',
    comparisonId,
    scenario,
    label,
    round
  });
}

function stableFileIdentity(filePath, options = {}) {
  const lexicalPath = path.resolve(filePath);
  const linkStat = fs.lstatSync(lexicalPath, { bigint: true });
  if (linkStat.isSymbolicLink() && options.rejectLink) {
    throw codedError('PROTECTED_PATH_LINK_REJECTED', `${options.label || 'protected file'} 不能是 symlink/reparse alias`);
  }
  const realPath = fs.realpathSync.native(lexicalPath);
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isFile()) throw codedError('PROTECTED_PATH_NOT_FILE', `${options.label || 'protected file'} 必须是普通文件`);
  if (stat.dev <= 0n || stat.ino <= 0n) {
    throw codedError('STABLE_FILE_ID_UNAVAILABLE', `${options.label || 'protected file'} 无可靠 volume/file identity，拒绝继续`);
  }
  return {
    lexicalPath,
    realPath,
    volumeId: stat.dev.toString(),
    fileId: stat.ino.toString(),
    sizeBytes: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString()
  };
}

function sameStableIdentity(left, right) {
  return left.volumeId === right.volumeId && left.fileId === right.fileId
    && left.sizeBytes === right.sizeBytes && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.realPath === right.realPath;
}

function stableDirectoryIdentity(directoryPath, options = {}) {
  const lexicalPath = path.resolve(directoryPath);
  const linkStat = fs.lstatSync(lexicalPath, { bigint: true });
  if (linkStat.isSymbolicLink()) {
    throw codedError('OUTPUT_PARENT_LINK_REJECTED', `${options.label || 'output parent'} 不能是 symlink/reparse alias`);
  }
  const realPath = fs.realpathSync.native(lexicalPath);
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isDirectory()) {
    throw codedError('OUTPUT_PARENT_NOT_DIRECTORY', `${options.label || 'output parent'} 必须是真实目录`);
  }
  if (stat.dev <= 0n || stat.ino <= 0n) {
    throw codedError('STABLE_DIRECTORY_ID_UNAVAILABLE', `${options.label || 'output parent'} 无可靠 volume/file identity，拒绝继续`);
  }
  return {
    lexicalPath,
    realPath,
    volumeId: stat.dev.toString(),
    fileId: stat.ino.toString()
  };
}

function sameStableDirectoryIdentity(left, right) {
  return left.lexicalPath === right.lexicalPath && left.realPath === right.realPath
    && left.volumeId === right.volumeId && left.fileId === right.fileId;
}

function protectedFileInputs(config) {
  const entries = [];
  const add = (label, filePath) => { if (filePath) entries.push({ label, filePath }); };
  add('config', config && config._configPath);
  add('draftReport', config && config.draftReport);
  add('finalSignoffReceipt', config && config.finalSignoffReceipt);
  add('processSeamsReceipt', config && config.processSeamsReceipt);
  for (const [key, filePath] of Object.entries(config && config.inputs || {})) add(`inputs.${key}`, filePath);
  for (const [scenario, value] of Object.entries(config && config.scenarios || {})) {
    for (const key of ['goldenDb', 'goldenWal', 'goldenShm', 'recoverySentinel', 'manualReceipt']) {
      add(`${scenario}.${key}`, value && value[key]);
    }
  }
  return entries;
}

function createProtectedOutputGuard(config) {
  const outputPath = path.resolve(config && config.output || '');
  if (!config || !config.output) throw codedError('OUTPUT_PATH_REQUIRED', 'output 必须显式提供');
  try {
    fs.lstatSync(outputPath);
    throw codedError('OUTPUT_MUST_NOT_EXIST', 'output 必须不存在，拒绝覆盖或跟随 symlink/reparse/hardlink');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const outputParent = path.dirname(outputPath);
  const outputParentIdentity = stableDirectoryIdentity(outputParent, { label: 'output parent' });
  const outputCanonicalPath = path.join(outputParentIdentity.realPath, path.basename(outputPath));
  const protectedFiles = protectedFileInputs(config).map(({ label, filePath }) => ({
    label,
    identity: stableFileIdentity(filePath, { label, rejectLink: true })
  }));
  for (const entry of protectedFiles) {
    if (outputPath === entry.identity.lexicalPath || outputCanonicalPath === entry.identity.realPath) {
      throw codedError('OUTPUT_ALIASES_PROTECTED_INPUT', `output 与 ${entry.label} alias，拒绝写入`);
    }
  }
  const literalEvidence = Object.fromEntries(REQUIRED_SCENARIOS.map((scenario) => [scenario,
    evidenceDigest({
      walSentinel: config.scenarios && config.scenarios[scenario] && config.scenarios[scenario].walSentinel || null,
      recoverySentinelConfigured: Boolean(config.scenarios && config.scenarios[scenario]
        && config.scenarios[scenario].recoverySentinel)
    })
  ]));
  return { outputPath, outputCanonicalPath, outputParentIdentity, protectedFiles, literalEvidence };
}

function assertProtectedOutputGuard(guard, config) {
  let currentParent;
  try {
    currentParent = stableDirectoryIdentity(guard.outputParentIdentity.lexicalPath, { label: 'output parent' });
  } catch (error) {
    throw codedError('OUTPUT_PARENT_IDENTITY_DRIFT', 'output parent 在运行期间缺失、被链接替换或身份不可验证', {
      causeCode: error && error.code || 'UNKNOWN'
    });
  }
  if (!sameStableDirectoryIdentity(guard.outputParentIdentity, currentParent)) {
    throw codedError('OUTPUT_PARENT_IDENTITY_DRIFT', 'output parent 在运行期间发生稳定身份漂移');
  }
  try {
    fs.lstatSync(guard.outputCanonicalPath);
    throw codedError('OUTPUT_CREATED_DURING_RUN', 'output 在运行期间被创建，拒绝覆盖');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  for (const entry of guard.protectedFiles) {
    let current;
    try {
      current = stableFileIdentity(entry.identity.lexicalPath, { label: entry.label, rejectLink: true });
    } catch (error) {
      throw codedError('PROTECTED_INPUT_IDENTITY_DRIFT', `${entry.label} 在运行期间缺失或身份不可验证`, { causeCode: error && error.code });
    }
    if (!sameStableIdentity(entry.identity, current)) {
      throw codedError('PROTECTED_INPUT_IDENTITY_DRIFT', `${entry.label} 在运行期间发生身份漂移`);
    }
  }
  for (const scenario of REQUIRED_SCENARIOS) {
    const current = evidenceDigest({
      walSentinel: config.scenarios && config.scenarios[scenario] && config.scenarios[scenario].walSentinel || null,
      recoverySentinelConfigured: Boolean(config.scenarios && config.scenarios[scenario]
        && config.scenarios[scenario].recoverySentinel)
    });
    if (guard.literalEvidence[scenario] !== current) {
      throw codedError('PROTECTED_LITERAL_IDENTITY_DRIFT', `${scenario} sentinel contract 发生漂移`);
    }
  }
}

function writeProtectedJson(guard, config, value) {
  assertProtectedOutputGuard(guard, config);
  fs.writeFileSync(guard.outputCanonicalPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function isSubpath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lstatIfPresent(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertRealDirectoryNoLink(directoryPath, label) {
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw codedError('ACCEPTANCE_LINKED_DIRECTORY', `${label} 必须是真实目录，不能是 link/symlink/junction`);
  }
}

function createOwnedWorkRoot(workRoot, options = {}) {
  const resolvedRoot = path.resolve(workRoot);
  const existed = fs.existsSync(resolvedRoot);
  if (!existed) fs.mkdirSync(resolvedRoot, { recursive: true });
  assertRealDirectoryNoLink(resolvedRoot, 'workRoot');
  const realRoot = fs.realpathSync(resolvedRoot);
  const markerPath = path.join(realRoot, OWNER_MARKER);
  if (fs.existsSync(markerPath)) {
    if (!options.allowExisting) throw codedError('ACCEPTANCE_OWNER_EXISTS', 'workRoot 已有 ownership marker');
    const existing = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (existing.kind !== 'windows-startup-acceptance-owned-root'
        || existing.schemaVersion !== 1
        || existing.rootPathSha256 !== sha256Text(realRoot)) {
      throw codedError('ACCEPTANCE_OWNER_INVALID', 'workRoot ownership marker 无效');
    }
    return { root: realRoot, markerPath, marker: existing };
  }
  const entries = fs.readdirSync(realRoot);
  if (existed && entries.length > 0) {
    throw codedError('ACCEPTANCE_WORK_ROOT_NOT_EMPTY', '既存 workRoot 必须为空，禁止接管未知内容');
  }
  const marker = {
    schemaVersion: 1,
    kind: 'windows-startup-acceptance-owned-root',
    ownerId: String(options.ownerId || crypto.randomUUID()),
    rootPathSha256: sha256Text(realRoot),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { root: realRoot, markerPath, marker };
}

function readAndValidateMarker(ownerRoot, supplied) {
  const inputRoot = path.resolve(ownerRoot);
  assertRealDirectoryNoLink(inputRoot, 'ownerRoot');
  const resolvedRoot = fs.realpathSync(inputRoot);
  const markerPath = path.join(resolvedRoot, OWNER_MARKER);
  if (!fs.existsSync(markerPath)) throw codedError('ACCEPTANCE_OWNER_MARKER_MISSING', 'ownership marker 缺失');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.kind !== 'windows-startup-acceptance-owned-root'
      || marker.schemaVersion !== 1
      || marker.rootPathSha256 !== sha256Text(fs.realpathSync(resolvedRoot))) {
    throw codedError('ACCEPTANCE_OWNER_MARKER_INVALID', 'ownership marker 与根目录不匹配');
  }
  const suppliedMarker = supplied && supplied.marker ? supplied.marker : supplied;
  if (suppliedMarker && suppliedMarker.ownerId !== marker.ownerId) {
    throw codedError('ACCEPTANCE_OWNER_MARKER_MISMATCH', 'ownership marker owner 不匹配');
  }
  return { root: resolvedRoot, inputRoot, marker, markerPath };
}

function removeExactOwnedTree({ ownerRoot, target, expectedRelative, marker }) {
  const ownership = readAndValidateMarker(ownerRoot, marker);
  const normalizedRelative = String(expectedRelative || '').replace(/\\/g, '/');
  if (normalizedRelative === '.') {
    throw codedError('ACCEPTANCE_DELETE_ROOT_REFUSED', '禁止删除 ownership 根目录');
  }
  if (!normalizedRelative || normalizedRelative.startsWith('/')
      || normalizedRelative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw codedError('ACCEPTANCE_DELETE_RELATIVE_INVALID', '删除 relative 目标无效或越界');
  }
  const expectedTarget = path.resolve(ownership.root, ...normalizedRelative.split('/'));
  const inputRelative = path.relative(ownership.inputRoot, path.resolve(target));
  const directTarget = path.resolve(target);
  const convertedTarget = path.resolve(ownership.root, inputRelative);
  const resolvedTarget = directTarget === expectedTarget ? directTarget : convertedTarget;
  if (resolvedTarget !== expectedTarget || !isSubpath(ownership.root, resolvedTarget)) {
    throw codedError('ACCEPTANCE_DELETE_TARGET_MISMATCH', '删除目标不是 marker 下的 exact identity');
  }
  let cursor = ownership.root;
  for (const segment of normalizedRelative.split('/')) {
    cursor = path.join(cursor, segment);
    const stat = lstatIfPresent(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw codedError('ACCEPTANCE_DELETE_LINK_REFUSED', '删除目标祖先包含 link/symlink/junction');
    }
  }
  if (lstatIfPresent(resolvedTarget)) fs.rmSync(resolvedTarget, { recursive: true, force: false });
  if (lstatIfPresent(resolvedTarget)) {
    throw codedError('ACCEPTANCE_DELETE_NOT_VERIFIED', 'exact target 删除后仍存在');
  }
  return {
    status: 'success',
    targetIdentitySha256: sha256Text(`${ownership.marker.ownerId}:${normalizedRelative}`),
    verifiedAbsent: true,
    pathRecorded: false
  };
}

function defaultReadFileVersion(filePath) {
  const escaped = String(filePath).replace(/'/g, "''");
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
}

function assertVersion(label, fileVersion) {
  const expected = label.slice(0, 6);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(fileVersion));
  if (!match || `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` !== expected) {
    throw codedError('ACCEPTANCE_FILE_VERSION_MISMATCH', `${label} exact fileVersion 与 label 不匹配`);
  }
}

function findInstalledExecutable(installRoot) {
  const candidates = fs.readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name)
      && !/^uninstall/i.test(entry.name) && !/^unins/i.test(entry.name))
    .map((entry) => path.join(installRoot, entry.name));
  if (candidates.length !== 1) {
    throw codedError('ACCEPTANCE_INSTALLED_EXE_AMBIGUOUS', '安装根必须恰有一个非卸载器产品 exe', {
      candidateCount: candidates.length
    });
  }
  return candidates[0];
}

function findUninstaller(installRoot) {
  const candidates = fs.existsSync(installRoot)
    ? fs.readdirSync(installRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(uninstall|unins).*\.exe$/i.test(entry.name))
      .map((entry) => path.join(installRoot, entry.name))
    : [];
  if (candidates.length !== 1) {
    throw codedError('ACCEPTANCE_UNINSTALLER_AMBIGUOUS', '安装根必须恰有一个卸载器', {
      candidateCount: candidates.length
    });
  }
  return candidates[0];
}

function copyFrozenInput(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  const source = { sha256: sha256File(sourcePath), sizeBytes: fs.statSync(sourcePath).size };
  const frozen = { sha256: sha256File(targetPath), sizeBytes: fs.statSync(targetPath).size };
  if (source.sha256 !== frozen.sha256 || source.sizeBytes !== frozen.sizeBytes) {
    throw codedError('ACCEPTANCE_ARTIFACT_FREEZE_MISMATCH', 'runner-owned 制品冻结副本不一致');
  }
  return { source, frozen };
}

function installWindowsVariants({ workRoot, inputs, marker }, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'win32') throw codedError('ACCEPTANCE_WINDOWS_REQUIRED', '受控启动验收只能在 Windows 执行');
  const ownership = marker
    ? readAndValidateMarker(workRoot, marker)
    : createOwnedWorkRoot(workRoot, { ownerId: 'windows-installation-inputs', allowExisting: fs.existsSync(path.join(path.resolve(workRoot), OWNER_MARKER)) });
  const readFileVersion = dependencies.readFileVersion || defaultReadFileVersion;
  const runInstaller = dependencies.runInstaller || ((setupPath, args) => {
    execFileSync(setupPath, args, { windowsHide: true, timeout: 300000, stdio: 'ignore' });
  });
  const requiredInputKeys = ['3.1.11-setup', '3.1.11-portable', '3.1.12-setup', '3.1.12-portable'];
  for (const key of requiredInputKeys) {
    const inputPath = path.resolve(inputs[key] || '');
    if (!inputPath || !fs.statSync(inputPath).isFile()) throw codedError('ACCEPTANCE_ARTIFACT_INPUT_MISSING', `缺少 ${key}`);
    if (inputPath === ownership.root || isSubpath(ownership.root, inputPath)) {
      throw codedError('ACCEPTANCE_SOURCE_INSIDE_WORK_ROOT', '源制品不得位于可清理 workRoot 内');
    }
  }
  const variants = {};
  const setupSources = {};
  const runtimePaths = {};
  const installRoots = {};
  const sourceIdentities = {};
  for (const version of ['3.1.11', '3.1.12']) {
    const setupSource = path.resolve(inputs[`${version}-setup`]);
    const setupFrozen = path.join(ownership.root, 'artifacts', 'setups', `${version}-setup.exe`);
    const setupCopy = copyFrozenInput(setupSource, setupFrozen);
    setupSources[version] = setupFrozen;
    sourceIdentities[`${version}-setup`] = setupCopy.source;
    const setupSourceVersion = String(readFileVersion(setupSource) || '').trim();
    const setupVersion = String(readFileVersion(setupFrozen) || '').trim();
    assertVersion(`${version}-installer`, setupSourceVersion);
    assertVersion(`${version}-installer`, setupVersion);
    if (setupSourceVersion !== setupVersion) throw codedError('ACCEPTANCE_SETUP_VERSION_FREEZE_MISMATCH', 'setup source/frozen exact fileVersion 不一致');
    const setupIdentity = {
      ...setupCopy.frozen,
      fileVersion: setupVersion,
      pathRecorded: false
    };
    const installRoot = path.join(ownership.root, 'installations', version);
    installRoots[version] = installRoot;
    fs.mkdirSync(installRoot, { recursive: true });
    const installArgs = ['/S', `/D=${installRoot}`];
    runInstaller(setupFrozen, installArgs, installRoot);
    const installedExe = findInstalledExecutable(installRoot);
    const installedVersion = String(readFileVersion(installedExe) || '').trim();
    assertVersion(`${version}-installer`, installedVersion);
    const installerLabel = `${version}-installer`;
    runtimePaths[installerLabel] = installedExe;
    variants[installerLabel] = {
      artifact: { ...fileIdentity(installedExe, () => installedVersion), label: installerLabel },
      provenance: {
        kind: 'installer-installed',
        source: { ...setupCopy.source, fileVersion: setupSourceVersion, pathRecorded: false },
        setup: setupIdentity,
        installMode: 'nsis-silent-explicit-owned-root',
        installedExeResolvedFrom: 'unique-root-product-exe',
        installed: { ...fileIdentity(installedExe, () => installedVersion), label: installerLabel },
        launched: { ...fileIdentity(installedExe, () => installedVersion), label: installerLabel },
        pathRecorded: false
      }
    };

    const portableSource = path.resolve(inputs[`${version}-portable`]);
    const portableFrozen = path.join(ownership.root, 'artifacts', 'portable', `${version}-portable.exe`);
    const portableCopy = copyFrozenInput(portableSource, portableFrozen);
    sourceIdentities[`${version}-portable`] = portableCopy.source;
    const portableSourceVersion = String(readFileVersion(portableSource) || '').trim();
    const portableVersion = String(readFileVersion(portableFrozen) || '').trim();
    const portableLabel = `${version}-portable`;
    assertVersion(portableLabel, portableVersion);
    assertVersion(portableLabel, portableSourceVersion);
    if (portableSourceVersion !== portableVersion) throw codedError('ACCEPTANCE_PORTABLE_VERSION_FREEZE_MISMATCH', 'portable source/frozen exact fileVersion 不一致');
    runtimePaths[portableLabel] = portableFrozen;
    variants[portableLabel] = {
      artifact: { ...fileIdentity(portableFrozen, () => portableVersion), label: portableLabel },
      provenance: {
        kind: 'portable-frozen-copy',
        source: { ...portableCopy.source, fileVersion: portableSourceVersion, pathRecorded: false },
        frozen: { ...fileIdentity(portableFrozen, () => portableVersion), label: portableLabel },
        launched: { ...fileIdentity(portableFrozen, () => portableVersion), label: portableLabel },
        pathRecorded: false
      }
    };
  }
  const result = { variants, sourceIdentities, pathRecorded: false };
  Object.defineProperty(result, 'runtimePaths', { enumerable: false, value: runtimePaths });
  Object.defineProperty(result, 'setupSources', { enumerable: false, value: setupSources });
  Object.defineProperty(result, 'installRoots', { enumerable: false, value: installRoots });
  return result;
}

function cleanupInstalledVariants({ workRoot, marker, install }, dependencies = {}) {
  const runUninstaller = dependencies.runUninstaller || ((uninstallerPath) => {
    execFileSync(uninstallerPath, ['/S'], {
      windowsHide: true,
      timeout: 300000,
      stdio: 'ignore'
    });
  });
  const receipts = {};
  for (const version of ['3.1.11', '3.1.12']) {
    const installRoot = install.installRoots[version];
    const installedPath = install.runtimePaths[`${version}-installer`];
    const uninstaller = findUninstaller(installRoot);
    runUninstaller(uninstaller, ['/S'], installRoot);
    if (fs.existsSync(installedPath)) {
      throw codedError('ACCEPTANCE_UNINSTALL_NOT_VERIFIED', `${version} installed exe 卸载后仍存在`);
    }
    receipts[version] = removeExactOwnedTree({
      ownerRoot: workRoot,
      target: installRoot,
      expectedRelative: `installations/${version}`,
      marker
    });
  }
  const installationsRoot = path.join(workRoot, 'installations');
  const artifactsRoot = path.join(workRoot, 'artifacts');
  const installations = removeExactOwnedTree({
    ownerRoot: workRoot,
    target: installationsRoot,
    expectedRelative: 'installations',
    marker
  });
  const artifacts = removeExactOwnedTree({
    ownerRoot: workRoot,
    target: artifactsRoot,
    expectedRelative: 'artifacts',
    marker
  });
  return {
    verified: Object.values(receipts).every((receipt) => receipt.verifiedAbsent)
      && installations.verifiedAbsent && artifacts.verifiedAbsent,
    installedApplicationsRemoved: true,
    controlledArtifactsRemoved: true,
    pathRecorded: false,
    receipts
  };
}

function finalizeOwnedWorkRoot({ workRoot, marker }) {
  const ownership = readAndValidateMarker(workRoot, marker);
  const entries = fs.readdirSync(ownership.root);
  if (entries.length !== 1 || entries[0] !== OWNER_MARKER) {
    throw codedError('ACCEPTANCE_WORK_ROOT_NOT_EMPTY', '受控 workRoot 仍含未清理内容，拒绝删除根');
  }
  fs.rmSync(ownership.markerPath);
  fs.rmdirSync(ownership.root);
  if (lstatIfPresent(ownership.root)) {
    throw codedError('ACCEPTANCE_WORK_ROOT_DELETE_NOT_VERIFIED', '受控 workRoot 删除后 lexical entry 仍存在');
  }
  return {
    verified: true,
    controlledWorkRootRemoved: true,
    pathRecorded: false
  };
}

function enumClass(value, entries) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  for (const [safeValue, aliases] of Object.entries(entries)) {
    if (aliases.includes(normalized)) return safeValue;
  }
  return 'other';
}

function safeNumericVersion(value) {
  const normalized = String(value || '').trim();
  return /^\d{1,10}(?:\.\d{1,10}){0,5}$/.test(normalized) ? normalized : null;
}

function sanitizeMachineEnvironment(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawDefender = source.defender && typeof source.defender === 'object' ? source.defender : {};
  const powerPlanGuid = String(source.powerPlan && source.powerPlan.guid || '').toLowerCase();
  const powerPlan = POWER_PLAN_GUID_PATTERN.test(powerPlanGuid) ? { guid: powerPlanGuid } : null;
  const os = {
    caption: 'windows',
    version: safeNumericVersion(source.os && source.os.version),
    build: safeNumericVersion(source.os && source.os.build),
    arch: enumClass(source.os && source.os.arch, {
      x64: ['64bit', 'amd64', 'x64'],
      x86: ['32bit', 'x86'],
      arm64: ['arm64', 'aarch64']
    })
  };
  const cpu = {
    model: String(source.cpu && source.cpu.model || '').trim()
      ? sha256Text(String(source.cpu.model).trim()) : '',
    logicalCores: source.cpu && source.cpu.logicalCores
  };
  const localDisk = {
    driveType: source.localDisk && Number(source.localDisk.driveType),
    fileSystem: enumClass(source.localDisk && source.localDisk.fileSystem, {
      ntfs: ['ntfs'], refs: ['refs'], exfat: ['exfat'], fat32: ['fat32']
    }),
    sizeBytes: source.localDisk && source.localDisk.sizeBytes,
    freeBytes: source.localDisk && source.localDisk.freeBytes,
    mediaType: enumClass(source.localDisk && source.localDisk.mediaType, {
      ssd: ['ssd', 'solidstatedrive'], hdd: ['hdd', 'harddiskdrive'], scm: ['scm']
    }),
    busType: enumClass(source.localDisk && source.localDisk.busType, {
      nvme: ['nvme'], sata: ['sata'], sas: ['sas'], scsi: ['scsi'], raid: ['raid'], usb: ['usb']
    })
  };
  const defender = {
    status: rawDefender.status === 'recorded' ? 'recorded' : 'unavailable',
    realtimeProtectionEnabled: typeof rawDefender.realtimeProtectionEnabled === 'boolean'
      ? rawDefender.realtimeProtectionEnabled : null,
    engineVersion: safeNumericVersion(rawDefender.engineVersion),
    productVersion: safeNumericVersion(rawDefender.productVersion),
    signatureVersion: safeNumericVersion(rawDefender.signatureVersion),
    workRootExcluded: typeof rawDefender.workRootExcluded === 'boolean'
      ? rawDefender.workRootExcluded : null,
    goldenExcluded: typeof rawDefender.goldenExcluded === 'boolean'
      ? rawDefender.goldenExcluded : null
  };
  const machineComplete = SHA256_PATTERN.test(String(source.hostIdSha256 || ''))
    && os.version && os.build && os.arch !== 'other'
    && SHA256_PATTERN.test(cpu.model) && Number.isSafeInteger(cpu.logicalCores) && cpu.logicalCores > 0
    && source.memory && Number.isFinite(source.memory.totalBytes) && source.memory.totalBytes > 0
    && localDisk.driveType === 3 && localDisk.fileSystem !== 'other'
    && Number.isFinite(localDisk.sizeBytes) && Number.isFinite(localDisk.freeBytes)
    && localDisk.mediaType !== 'other' && localDisk.busType !== 'other'
    && powerPlan
    && defender.status === 'recorded'
    && [defender.engineVersion, defender.productVersion, defender.signatureVersion].every(Boolean)
    && typeof defender.realtimeProtectionEnabled === 'boolean'
    && typeof defender.workRootExcluded === 'boolean'
    && typeof defender.goldenExcluded === 'boolean';
  return {
    status: machineComplete && source.pathClass === 'local-fixed' && source.goldenPathClass === 'local-fixed'
      ? 'recorded' : 'not-evaluated',
    evidenceSource: 'machine',
    hostIdSha256: String(source.hostIdSha256 || ''),
    os,
    cpu,
    memory: source.memory ? { totalBytes: source.memory.totalBytes } : null,
    localDisk,
    pathClass: source.pathClass || 'unknown',
    goldenPathClass: source.goldenPathClass || 'unknown',
    powerPlan,
    defender,
    cachePolicy: {
      evidenceSource: 'machine-policy',
      firstSampleRetained: true,
      explicitCacheFlush: false,
      order: 'four-variant-rotation',
      comparisonScope: 'single-process-single-host'
    }
  };
}

function canonicalMachineEnvironment(input) {
  const source = input && typeof input === 'object' ? input : {};
  const body = {
    status: source.status,
    evidenceSource: source.evidenceSource,
    hostIdSha256: source.hostIdSha256,
    os: source.os && {
      caption: source.os.caption, version: source.os.version,
      build: source.os.build, arch: source.os.arch
    },
    cpu: source.cpu && { model: source.cpu.model, logicalCores: source.cpu.logicalCores },
    memory: source.memory && { totalBytes: source.memory.totalBytes },
    localDisk: source.localDisk && {
      driveType: source.localDisk.driveType, fileSystem: source.localDisk.fileSystem,
      sizeBytes: source.localDisk.sizeBytes, freeBytes: source.localDisk.freeBytes,
      mediaType: source.localDisk.mediaType, busType: source.localDisk.busType
    },
    pathClass: source.pathClass,
    goldenPathClass: source.goldenPathClass,
    powerPlan: source.powerPlan && { guid: source.powerPlan.guid },
    defender: source.defender && {
      status: source.defender.status,
      realtimeProtectionEnabled: source.defender.realtimeProtectionEnabled,
      engineVersion: source.defender.engineVersion,
      productVersion: source.defender.productVersion,
      signatureVersion: source.defender.signatureVersion,
      workRootExcluded: source.defender.workRootExcluded,
      goldenExcluded: source.defender.goldenExcluded
    },
    cachePolicy: source.cachePolicy && {
      evidenceSource: source.cachePolicy.evidenceSource,
      firstSampleRetained: source.cachePolicy.firstSampleRetained,
      explicitCacheFlush: source.cachePolicy.explicitCacheFlush,
      order: source.cachePolicy.order,
      comparisonScope: source.cachePolicy.comparisonScope
    },
    diskBudget: source.diskBudget && {
      evidenceSource: source.diskBudget.evidenceSource,
      normalSimultaneousCopies: source.diskBudget.normalSimultaneousCopies,
      nonNormalPeakEquivalentCopies: source.diskBudget.nonNormalPeakEquivalentCopies,
      completedNonNormalSamplesRetained: source.diskBudget.completedNonNormalSamplesRetained,
      requiredFreeBytes: source.diskBudget.requiredFreeBytes,
      safetyBytes: source.diskBudget.safetyBytes,
      availableFreeBytes: source.diskBudget.availableFreeBytes,
      sufficient: source.diskBudget.sufficient
    }
  };
  const complete = body.status === 'recorded' && body.evidenceSource === 'machine'
    && SHA256_PATTERN.test(String(body.hostIdSha256 || ''))
    && body.os && body.os.caption === 'windows'
    && safeNumericVersion(body.os.version) === body.os.version
    && safeNumericVersion(body.os.build) === body.os.build
    && ['x64', 'x86', 'arm64'].includes(body.os.arch)
    && body.cpu && SHA256_PATTERN.test(String(body.cpu.model || ''))
    && Number.isSafeInteger(body.cpu.logicalCores) && body.cpu.logicalCores > 0
    && body.memory && Number.isFinite(body.memory.totalBytes) && body.memory.totalBytes > 0
    && body.localDisk && body.localDisk.driveType === 3
    && ['ntfs', 'refs', 'exfat', 'fat32'].includes(body.localDisk.fileSystem)
    && Number.isFinite(body.localDisk.sizeBytes) && body.localDisk.sizeBytes > 0
    && Number.isFinite(body.localDisk.freeBytes) && body.localDisk.freeBytes >= 0
    && ['ssd', 'hdd', 'scm'].includes(body.localDisk.mediaType)
    && ['nvme', 'sata', 'sas', 'scsi', 'raid', 'usb'].includes(body.localDisk.busType)
    && body.pathClass === 'local-fixed' && body.goldenPathClass === 'local-fixed'
    && body.powerPlan && POWER_PLAN_GUID_PATTERN.test(String(body.powerPlan.guid || ''))
    && body.defender && body.defender.status === 'recorded'
    && typeof body.defender.realtimeProtectionEnabled === 'boolean'
    && [body.defender.engineVersion, body.defender.productVersion, body.defender.signatureVersion]
      .every((value) => safeNumericVersion(value) === value)
    && typeof body.defender.workRootExcluded === 'boolean'
    && typeof body.defender.goldenExcluded === 'boolean'
    && body.cachePolicy && body.cachePolicy.evidenceSource === 'machine-policy'
    && body.cachePolicy.firstSampleRetained === true
    && body.cachePolicy.explicitCacheFlush === false
    && body.cachePolicy.order === 'four-variant-rotation'
    && body.cachePolicy.comparisonScope === 'single-process-single-host'
    && body.diskBudget && body.diskBudget.evidenceSource === 'machine-calculated'
    && body.diskBudget.normalSimultaneousCopies === 5
    && body.diskBudget.nonNormalPeakEquivalentCopies === 4.25
    && body.diskBudget.completedNonNormalSamplesRetained === 0
    && Number.isFinite(body.diskBudget.requiredFreeBytes) && body.diskBudget.requiredFreeBytes > 0
    && Number.isFinite(body.diskBudget.safetyBytes) && body.diskBudget.safetyBytes > 0
    && Number.isFinite(body.diskBudget.availableFreeBytes) && body.diskBudget.availableFreeBytes >= 0
    && body.diskBudget.sufficient === true;
  if (!complete) {
    const minimal = { status: 'not-evaluated', evidenceSource: 'machine' };
    return {
      projection: { ...minimal, digest: evidenceDigest(minimal) },
      complete: false,
      digestMatches: false
    };
  }
  const digest = evidenceDigest(body);
  return {
    projection: { ...body, digest },
    complete: true,
    digestMatches: source.digest === digest
  };
}

function sanitizeArtifactEvidence(artifacts) {
  if (!artifacts || !artifacts.variants || !artifacts.cleanup) return {};
  const identity = (value, includeLabel) => ({
    ...(includeLabel ? { label: value.label } : {}),
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    fileVersion: value.fileVersion,
    pathRecorded: false
  });
  return {
    variants: Object.fromEntries(REQUIRED_VARIANTS.map((label) => {
      const source = artifacts.variants[label];
      if (!source || !source.provenance || !source.artifact) return [label, null];
      const provenance = source.provenance;
      return [label, {
        artifact: identity(source.artifact, true),
        provenance: label.endsWith('-installer') ? {
          kind: provenance.kind,
          source: identity(provenance.source, false),
          setup: identity(provenance.setup, false),
          installMode: provenance.installMode,
          installedExeResolvedFrom: provenance.installedExeResolvedFrom,
          installed: identity(provenance.installed, true),
          launched: identity(provenance.launched, true),
          pathRecorded: false
        } : {
          kind: provenance.kind,
          source: identity(provenance.source, false),
          frozen: identity(provenance.frozen, true),
          launched: identity(provenance.launched, true),
          pathRecorded: false
        }
      }];
    })),
    cleanup: {
      verified: artifacts.cleanup.verified,
      installedApplicationsRemoved: artifacts.cleanup.installedApplicationsRemoved,
      controlledWorkRootRemoved: artifacts.cleanup.controlledWorkRootRemoved,
      pathRecorded: false
    }
  };
}

function estimateDiskBudget({ scenarios, inputs }) {
  const bundleBytes = (scenario) => ['goldenDb', 'goldenWal', 'goldenShm']
    .map((key) => scenario && scenario[key])
    .filter(Boolean)
    .reduce((sum, filePath) => sum + fs.statSync(path.resolve(filePath)).size, 0);
  const normalBytes = bundleBytes(scenarios['normal-clean-shutdown']);
  const nonNormalPeak = Math.max(
    bundleBytes(scenarios['migration-vacuum']),
    bundleBytes(scenarios['crash-recovery'])
  );
  const artifactBytes = Object.values(inputs).reduce((sum, filePath) => (
    sum + fs.statSync(path.resolve(filePath)).size
  ), 0);
  const safetyBytes = 4 * 1024 * 1024 * 1024;
  const requiredFreeBytes = Math.ceil(Math.max(normalBytes * 5, nonNormalPeak * 4.25)
    + artifactBytes * 2 + safetyBytes);
  return {
    evidenceSource: 'machine-calculated',
    normalSimultaneousCopies: 5,
    nonNormalPeakEquivalentCopies: 4.25,
    completedNonNormalSamplesRetained: 0,
    requiredFreeBytes,
    safetyBytes
  };
}

function defaultCollectWindowsEnvironment({ workRoot, goldenPath }) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$work = $env:STARTUP_ACCEPTANCE_WORK_ROOT
$golden = $env:STARTUP_ACCEPTANCE_GOLDEN_PATH
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $hostHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:COMPUTERNAME)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor)
$memory = Get-CimInstance Win32_ComputerSystem
$root = [IO.Path]::GetPathRoot($work).TrimEnd('\\')
$logical = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $root.Replace("'", "''") + "'")
$goldenRoot = [IO.Path]::GetPathRoot($golden).TrimEnd('\\')
$goldenLogical = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $goldenRoot.Replace("'", "''") + "'")
$partition = Get-Partition -DriveLetter $root.Substring(0,1) -ErrorAction Stop
$disk = $partition | Get-Disk
$powerRaw = (& powercfg.exe /GETACTIVESCHEME | Out-String)
$powerGuid = if ($powerRaw -match '([0-9a-fA-F-]{36})') { $Matches[1].ToLowerInvariant() } else { '' }
$defender = @{ status = 'unavailable' }
try {
  $mp = Get-MpComputerStatus
  $pref = Get-MpPreference
  $exclusions = @($pref.ExclusionPath)
  function IsExcluded([string]$candidate) {
    foreach ($entry in $exclusions) {
      if ($entry) {
        $entryFull = [IO.Path]::GetFullPath($entry).TrimEnd('\\')
        $candidateFull = [IO.Path]::GetFullPath($candidate).TrimEnd('\\')
        if ($candidateFull.Equals($entryFull, [StringComparison]::OrdinalIgnoreCase) -or $candidateFull.StartsWith($entryFull + '\\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
      }
    }
    return $false
  }
  $defender = @{
    status = 'recorded'
    realtimeProtectionEnabled = [bool]$mp.RealTimeProtectionEnabled
    engineVersion = [string]$mp.AMEngineVersion
    productVersion = [string]$mp.AMProductVersion
    signatureVersion = [string]$mp.AntivirusSignatureVersion
    workRootExcluded = IsExcluded $work
    goldenExcluded = IsExcluded $golden
  }
} catch { $defender = @{ status = 'unavailable' } }
@{
  hostIdSha256 = $hostHash
  os = @{ caption = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber; arch = [string]$os.OSArchitecture }
  cpu = @{ model = [string]$cpu[0].Name; logicalCores = [int]($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum }
  memory = @{ totalBytes = [uint64]$memory.TotalPhysicalMemory }
  localDisk = @{ driveType = [int]$logical.DriveType; fileSystem = [string]$logical.FileSystem; sizeBytes = [uint64]$logical.Size; freeBytes = [uint64]$logical.FreeSpace; mediaType = [string]$disk.MediaType; busType = [string]$disk.BusType }
  pathClass = if ($logical.DriveType -eq 3) { 'local-fixed' } else { 'non-local-or-unknown' }
  goldenPathClass = if ($goldenLogical.DriveType -eq 3) { 'local-fixed' } else { 'non-local-or-unknown' }
  powerPlan = @{ guid = $powerGuid }
  defender = $defender
} | ConvertTo-Json -Depth 6 -Compress
`;
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: {
      ...process.env,
      STARTUP_ACCEPTANCE_WORK_ROOT: workRoot,
      STARTUP_ACCEPTANCE_GOLDEN_PATH: goldenPath
    }
  });
  return JSON.parse(output);
}

function captureWindowsEnvironment(input, dependencies = {}) {
  if ((dependencies.platform || process.platform) !== 'win32') {
    throw codedError('ACCEPTANCE_WINDOWS_REQUIRED', '环境证据只能在 Windows 采集');
  }
  const collect = dependencies.collect || defaultCollectWindowsEnvironment;
  return sanitizeMachineEnvironment(collect(input));
}

function validatePhaseInventory(label, records) {
  if (String(label).startsWith('3.1.11')) {
    return { status: 'unavailable-legacy', required: false, records: [] };
  }
  if (!String(label).startsWith('3.1.12')) throw codedError('PHASE_LABEL_INVALID', '未知版本 label');
  if (!Array.isArray(records)) throw codedError('PHASE_INVENTORY_MISSING', '3.1.12 phase inventory 缺失');
  const byName = new Map();
  for (const record of records) {
    const phase = String(record && record.phase || '');
    if (!REQUIRED_STARTUP_PHASES.includes(phase)) {
      throw codedError('PHASE_INVENTORY_EXTRA', `3.1.12 phase inventory 含未知项：${phase}`);
    }
    if (byName.has(phase)) throw codedError('PHASE_INVENTORY_DUPLICATE', `3.1.12 phase 重复：${phase}`);
    if (record.event !== 'startup-phase' || record.state !== 'end') {
      throw codedError('PHASE_NOT_CLOSED', `3.1.12 phase 未闭合：${phase}`);
    }
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
      throw codedError('PHASE_DURATION_INVALID', `3.1.12 phase duration 必须 finite：${phase}`);
    }
    const legalOutcomes = phase === 'database-vacuum' ? ['success', 'skipped'] : ['success'];
    if (!legalOutcomes.includes(record.outcome)) {
      throw codedError('PHASE_OUTCOME_INVALID', `3.1.12 phase outcome 非法：${phase}`);
    }
    if (record.counts !== undefined) {
      if (!record.counts || typeof record.counts !== 'object' || Array.isArray(record.counts)
          || Object.values(record.counts).some((value) => !Number.isFinite(value) || value < 0)) {
        throw codedError('PHASE_COUNTS_INVALID', `3.1.12 phase counts 非法：${phase}`);
      }
    }
    byName.set(phase, record);
  }
  const missing = REQUIRED_STARTUP_PHASES.filter((phase) => !byName.has(phase));
  if (missing.length > 0) throw codedError('PHASE_INVENTORY_MISSING', `3.1.12 phase 缺失：${missing.join(',')}`);
  return {
    status: 'complete',
    required: true,
    count: byName.size,
    records: REQUIRED_STARTUP_PHASES.map((phase) => {
      const record = byName.get(phase);
      return {
        phase,
        durationMs: record.durationMs,
        outcome: record.outcome,
        counts: Object.entries(record.counts || {}).sort(([left], [right]) => left.localeCompare(right))
          .map(([name, count]) => ({ name, count }))
      };
    })
  };
}

function validateReadyEvidence(label, ready, phaseEvidence) {
  const current = String(label).startsWith('3.1.12');
  const expectedMode = current ? 'phase-and-renderer-contract' : 'legacy-renderer-complete';
  if (!ready || ready.mode !== expectedMode
      || !Number.isFinite(ready.rendererInitMs) || ready.rendererInitMs < 0) {
    throw codedError('READY_EVIDENCE_INVALID', `${label} ready mode/renderer duration 无效`);
  }
  if (!current) return { mode: expectedMode, rendererInitMs: ready.rendererInitMs };
  if (!Number.isFinite(ready.windowReadyMs) || ready.windowReadyMs < 0
      || !Number.isFinite(ready.startupTotalMs) || ready.startupTotalMs < 0) {
    throw codedError('READY_EVIDENCE_INVALID', `${label} ready phase duration 无效`);
  }
  const recordByPhase = new Map((phaseEvidence.records || []).map((record) => [record.phase, record]));
  const windowReady = recordByPhase.get('window-ready');
  const startupTotal = recordByPhase.get('startup-total');
  if (!windowReady || windowReady.outcome !== 'success' || windowReady.durationMs !== ready.windowReadyMs
      || !startupTotal || startupTotal.outcome !== 'success'
      || startupTotal.durationMs !== ready.startupTotalMs) {
    throw codedError('READY_PHASE_CROSS_BIND_INVALID', `${label} ready duration 未与完整 phase record 交叉绑定`);
  }
  return {
    mode: expectedMode,
    rendererInitMs: ready.rendererInitMs,
    windowReadyMs: ready.windowReadyMs,
    startupTotalMs: ready.startupTotalMs
  };
}

function validateTimingPhysics(label, externalFullReadyMs, ready) {
  if (!Number.isFinite(externalFullReadyMs) || externalFullReadyMs <= 0 || !ready) {
    throw codedError('READY_TIMING_PHYSICS_INVALID', `${label} external/ready timing 缺失`);
  }
  const internalDurations = [ready.rendererInitMs];
  if (String(label).startsWith('3.1.12')) {
    internalDurations.push(ready.windowReadyMs, ready.startupTotalMs);
    if (ready.startupTotalMs + TIMING_TOLERANCE_MS < ready.windowReadyMs) {
      throw codedError('READY_TIMING_PHYSICS_INVALID', `${label} startupTotal 必须不小于 windowReady`);
    }
  }
  if (internalDurations.some((duration) => (
    !Number.isFinite(duration) || externalFullReadyMs + TIMING_TOLERANCE_MS < duration
  ))) {
    throw codedError('READY_TIMING_PHYSICS_INVALID', `${label} external full-ready 必须覆盖全部内部 ready timing`);
  }
}

function validateProjectedPhaseEvidence(label, evidence) {
  if (String(label).startsWith('3.1.11')) {
    if (!evidence || evidence.status !== 'unavailable-legacy' || evidence.required !== false
        || !Array.isArray(evidence.records) || evidence.records.length !== 0) {
      throw codedError('PHASE_INVENTORY_INVALID', `${label} legacy phase projection 无效`);
    }
    return evidence;
  }
  if (!evidence || evidence.status !== 'complete' || evidence.required !== true
      || evidence.count !== REQUIRED_STARTUP_PHASES.length || !Array.isArray(evidence.records)
      || evidence.records.length !== REQUIRED_STARTUP_PHASES.length) {
    throw codedError('PHASE_INVENTORY_INVALID', `${label} phase projection 不完整`);
  }
  for (let index = 0; index < REQUIRED_STARTUP_PHASES.length; index += 1) {
    const record = evidence.records[index];
    const phase = REQUIRED_STARTUP_PHASES[index];
    if (!record || record.phase !== phase || !Number.isFinite(record.durationMs) || record.durationMs < 0
        || !Array.isArray(record.counts)
        || record.counts.some((item) => !item || !/^[A-Za-z][A-Za-z0-9]*$/.test(item.name)
          || !Number.isFinite(item.count) || item.count < 0)
        || (phase === 'database-vacuum'
          ? !['success', 'skipped'].includes(record.outcome) : record.outcome !== 'success')) {
      throw codedError('PHASE_INVENTORY_INVALID', `${label}/${phase} phase projection 无效`);
    }
  }
  return evidence;
}

function sidecarIdentity(sha256, sizeBytes, label) {
  if (sha256 === null) {
    if (sizeBytes !== 0) throw codedError('SIDECAR_IDENTITY_INVALID', `${label} hash=null 时 size 必须为 0`);
    return { sha256: null, sizeBytes: 0 };
  }
  if (!SHA256_PATTERN.test(String(sha256 || '')) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw codedError('SIDECAR_IDENTITY_INVALID', `${label} non-null hash 必须为 64hex 且 size 合法`);
  }
  return { sha256, sizeBytes };
}

function mainIdentity(sha256, sizeBytes, label) {
  if (!SHA256_PATTERN.test(String(sha256 || '')) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw codedError('MAIN_IDENTITY_INVALID', `${label} main hash 必须为 64hex 且 size>0`);
  }
  return { sha256, sizeBytes };
}

function projectRawBundle(bundle, label) {
  if (!bundle || !bundle.database || bundle.database.exists !== true) {
    throw codedError('BUNDLE_EVIDENCE_INVALID', `${label} main bundle 缺失`);
  }
  const projectSidecar = (value, name) => {
    if (!value || typeof value.exists !== 'boolean') throw codedError('BUNDLE_EVIDENCE_INVALID', `${label}.${name} 缺失`);
    if (value.exists === false && (value.sha256 !== null || value.size !== 0)) {
      throw codedError('BUNDLE_EVIDENCE_INVALID', `${label}.${name} absence identity 无效`);
    }
    return sidecarIdentity(value.sha256, value.size, `${label}.${name}`);
  };
  return {
    main: mainIdentity(bundle.database.sha256, bundle.database.size, `${label}.main`),
    wal: projectSidecar(bundle.wal, 'wal'),
    shm: projectSidecar(bundle.shm, 'shm')
  };
}

function validateProjectedBundle(bundle, label) {
  if (!bundle || !bundle.main || !bundle.wal || !bundle.shm) {
    throw codedError('BUNDLE_EVIDENCE_INVALID', `${label} projected bundle 缺失`);
  }
  return {
    main: mainIdentity(bundle.main.sha256, bundle.main.sizeBytes, `${label}.main`),
    wal: sidecarIdentity(bundle.wal.sha256, bundle.wal.sizeBytes, `${label}.wal`),
    shm: sidecarIdentity(bundle.shm.sha256, bundle.shm.sizeBytes, `${label}.shm`)
  };
}

function projectGoldenBundle(golden) {
  return {
    main: mainIdentity(golden && golden.sha256, golden && golden.sizeBytes, 'golden.main'),
    wal: sidecarIdentity(golden && golden.walSha256, golden && golden.walSizeBytes, 'golden.wal'),
    shm: sidecarIdentity(golden && golden.shmSha256, golden && golden.shmSizeBytes, 'golden.shm')
  };
}

function bundleIdentityEqual(left, right) {
  return ['main', 'wal', 'shm'].every((name) => left && right
    && left[name].sha256 === right[name].sha256
    && left[name].sizeBytes === right[name].sizeBytes);
}

function countEntries(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('RECOVERY_COUNTS_INVALID', `${label} counts 必须是对象`);
  }
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || !Number.isFinite(count) || count < 0) {
      throw codedError('RECOVERY_COUNTS_INVALID', `${label}.${name} count 无效`);
    }
    return { name, count };
  });
}

function projectRecoveryCounts(sample, phaseEvidence, postPending) {
  const raw = sample && sample.recoveryCounts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw codedError('RECOVERY_COUNTS_INVALID', 'sample 完整 recoveryCounts 缺失');
  }
  const expectedSources = new Map((phaseEvidence.records || [])
    .filter((record) => record.counts.length > 0)
    .map((record) => [record.phase, record.counts]));
  expectedSources.set('actualPostcondition', countEntries(postPending, 'actualPostcondition'));
  const actualSources = new Map(Object.entries(raw).map(([source, counts]) => [
    source, countEntries(counts, source)
  ]));
  if (actualSources.size !== expectedSources.size
      || [...expectedSources].some(([source, counts]) => (
        JSON.stringify(actualSources.get(source)) !== JSON.stringify(counts)
      ))) {
    throw codedError('RECOVERY_COUNTS_INCOMPLETE', 'sample recoveryCounts 未完整绑定 phase/postcondition');
  }
  return {
    records: [...actualSources].sort(([left], [right]) => left.localeCompare(right))
      .map(([source, counts]) => ({ source, counts }))
  };
}

function validateProjectedRecoveryCounts(evidence, phaseEvidence, postPending) {
  if (!evidence || !Array.isArray(evidence.records)) {
    throw codedError('RECOVERY_COUNTS_INVALID', 'projected recovery records 缺失');
  }
  const expected = new Map((phaseEvidence.records || []).filter((record) => record.counts.length > 0)
    .map((record) => [record.phase, record.counts]));
  expected.set('actualPostcondition', countEntries(postPending, 'actualPostcondition'));
  const actual = new Map();
  for (const record of evidence.records) {
    if (!record || typeof record.source !== 'string' || actual.has(record.source)
        || !Array.isArray(record.counts)) {
      throw codedError('RECOVERY_COUNTS_INVALID', 'projected recovery source 重复或无效');
    }
    const countNames = new Set();
    const projectedCounts = {};
    for (const item of record.counts) {
      if (!item || typeof item.name !== 'string' || countNames.has(item.name)) {
        throw codedError('RECOVERY_COUNTS_INVALID', 'projected recovery count 重复或无效');
      }
      countNames.add(item.name);
      projectedCounts[item.name] = item.count;
    }
    actual.set(record.source, countEntries(projectedCounts, record.source));
  }
  if (actual.size !== expected.size || [...expected].some(([source, counts]) => (
    JSON.stringify(actual.get(source)) !== JSON.stringify(counts)
  ))) throw codedError('RECOVERY_COUNTS_INCOMPLETE', 'projected recovery counts 不完整');
}

const MIGRATION_COLUMN_DEFINITIONS = Object.freeze({
  vcc_fin_op_system_snapshots: [['import_source_id', 'INTEGER']],
  archive_blobs: [
    ['fingerprint_size_bytes', 'INTEGER'], ['fingerprint_mtime_ms', 'REAL'],
    ['fingerprint_ctime_ms', 'REAL'], ['fingerprint_ino', 'TEXT']
  ],
  archive_artifacts: [
    ['storage_fingerprint_size_bytes', 'INTEGER'], ['storage_fingerprint_mtime_ms', 'REAL'],
    ['storage_fingerprint_ctime_ms', 'REAL'], ['storage_fingerprint_ino', 'TEXT']
  ]
});

function projectMigrationEvidence(pre, post, label) {
  const before = pre && pre.schema;
  const after = post && post.schema;
  if (!before || !after || !SHA256_PATTERN.test(String(before.fingerprint || ''))
      || !SHA256_PATTERN.test(String(after.fingerprint || ''))) {
    throw codedError('MIGRATION_SCHEMA_FINGERPRINT_INVALID', `${label} migration schema fingerprint 缺失`);
  }
  const arrays = {
    vcc_fin_op_system_snapshots: ['systemSnapshotColumns', 'systemSnapshotColumns'],
    archive_blobs: ['archiveBlobColumns', 'archiveBlobColumns'],
    archive_artifacts: ['archiveArtifactColumns', 'archiveArtifactColumns']
  };
  const columnDefinitions = {};
  const legacy = label.startsWith('3.1.11');
  for (const [table, [beforeKey, afterKey]] of Object.entries(arrays)) {
    const beforeColumns = before[beforeKey];
    const afterColumns = after[afterKey];
    if (!Array.isArray(beforeColumns) || !Array.isArray(afterColumns)) {
      throw codedError('MIGRATION_COLUMN_DEFINITION_INVALID', `${label}/${table} column evidence 缺失`);
    }
    const appended = afterColumns.slice(beforeColumns.length).map((column) => ({
      cid: column.cid,
      name: column.name,
      type: column.type,
      notNull: column.notNull,
      defaultValue: column.defaultValue,
      primaryKey: column.primaryKey
    }));
    const expected = legacy ? [] : MIGRATION_COLUMN_DEFINITIONS[table].map(([name, type], index) => ({
      cid: beforeColumns.length + index,
      name,
      type,
      notNull: 0,
      defaultValue: null,
      primaryKey: 0
    }));
    if (JSON.stringify(afterColumns.slice(0, beforeColumns.length)) !== JSON.stringify(beforeColumns)
        || JSON.stringify(appended) !== JSON.stringify(expected)) {
      throw codedError('MIGRATION_COLUMN_DEFINITION_INVALID', `${label}/${table} 精确 appended columns 不匹配`);
    }
    columnDefinitions[table] = appended;
  }
  const actualIndexDefinitionSha256 = sha256Text(after.importSourceIndexSql || '');
  const expectedIndexDefinitionSha256 = sha256Text(after.expectedImportSourceIndexSql || '');
  const indexMatchesExpected = actualIndexDefinitionSha256 === expectedIndexDefinitionSha256;
  if ((!legacy && !indexMatchesExpected) || (legacy && after.importSourceIndexSql)) {
    throw codedError('MIGRATION_INDEX_DEFINITION_INVALID', `${label} index definition evidence 无效`);
  }
  return {
    schemaFingerprintBefore: before.fingerprint,
    schemaFingerprintAfter: after.fingerprint,
    columnDefinitions,
    indexEvidence: {
      name: 'idx_vcc_fin_op_system_snapshots_import_source',
      actualDefinitionSha256: actualIndexDefinitionSha256,
      expectedDefinitionSha256: expectedIndexDefinitionSha256,
      matchesExpected: indexMatchesExpected
    }
  };
}

function validateProjectedMigrationEvidence(evidence, label) {
  const legacy = label.startsWith('3.1.11');
  if (!evidence || !SHA256_PATTERN.test(String(evidence.schemaFingerprintBefore || ''))
      || !SHA256_PATTERN.test(String(evidence.schemaFingerprintAfter || ''))
      || !evidence.columnDefinitions || !evidence.indexEvidence) {
    throw codedError('MIGRATION_STRUCTURED_EVIDENCE_INVALID', `${label} migration structured evidence 缺失`);
  }
  for (const [table, expectedPairs] of Object.entries(MIGRATION_COLUMN_DEFINITIONS)) {
    const definitions = evidence.columnDefinitions[table];
    const expected = legacy ? [] : expectedPairs;
    if (!Array.isArray(definitions) || definitions.length !== expected.length) {
      throw codedError('MIGRATION_STRUCTURED_EVIDENCE_INVALID', `${label}/${table} column definitions 数量无效`);
    }
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      if (!definition || definition.name !== expected[index][0] || definition.type !== expected[index][1]
          || !Number.isSafeInteger(definition.cid) || definition.cid < 0
          || (index > 0 && definition.cid !== definitions[index - 1].cid + 1)
          || definition.notNull !== 0 || definition.defaultValue !== null || definition.primaryKey !== 0) {
        throw codedError('MIGRATION_STRUCTURED_EVIDENCE_INVALID', `${label}/${table} column definition 无效`);
      }
    }
  }
  const index = evidence.indexEvidence;
  if (index.name !== 'idx_vcc_fin_op_system_snapshots_import_source'
      || !SHA256_PATTERN.test(String(index.actualDefinitionSha256 || ''))
      || !SHA256_PATTERN.test(String(index.expectedDefinitionSha256 || ''))
      || (legacy ? index.matchesExpected !== false
        : index.matchesExpected !== true
          || index.actualDefinitionSha256 !== index.expectedDefinitionSha256)
      || (legacy && index.actualDefinitionSha256 === index.expectedDefinitionSha256)
      || (legacy
        ? evidence.schemaFingerprintBefore !== evidence.schemaFingerprintAfter
        : evidence.schemaFingerprintBefore === evidence.schemaFingerprintAfter)) {
    throw codedError('MIGRATION_STRUCTURED_EVIDENCE_INVALID', `${label} index/fingerprint evidence 无效`);
  }
}

function validateSigner(signer, role) {
  if (!signer || typeof signer.id !== 'string' || !signer.id.trim() || signer.role !== role) {
    throw codedError('MANUAL_RECEIPT_SIGNER_INVALID', `manual receipt signer 必须为 ${role}`);
  }
}

function validateGoldenManualReceipt(receipt, report, options = {}) {
  if (!receipt || receipt.schemaVersion !== 1
      || receipt.kind !== 'windows-startup-golden-manual-receipt'
      || receipt.evidenceSource !== 'manual') {
    throw codedError('GOLDEN_MANUAL_RECEIPT_INVALID', 'golden manual receipt kind/schema/evidenceSource 无效');
  }
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'evidenceSource', 'scenario', 'goldenSha256',
    'goldenWalSha256', 'goldenShmSha256', 'goldenSizeBytes', 'goldenWalSizeBytes',
    'goldenShmSizeBytes', 'sourceClass', 'anonymizationConfirmed',
    'representativenessConfirmed', 'dataOwnerConfirmed', 'signer', 'signedAt'
  ], 'GOLDEN_MANUAL_RECEIPT_SCHEMA', 'golden manual receipt');
  assertExactKeys(receipt.signer, ['id', 'role'],
    'GOLDEN_MANUAL_RECEIPT_SCHEMA', 'golden manual receipt signer');
  if (receipt.scenario !== report.scenario) throw codedError('GOLDEN_MANUAL_RECEIPT_SCENARIO', 'golden receipt scenario 不匹配');
  if (!SHA256_PATTERN.test(String(receipt.goldenSha256))
      || receipt.goldenSha256 !== report.golden.sha256) {
    throw codedError('GOLDEN_MANUAL_RECEIPT_HASH', 'golden receipt SHA/hash 不匹配');
  }
  if ((receipt.goldenWalSha256 !== null && !SHA256_PATTERN.test(String(receipt.goldenWalSha256 || '')))
      || (receipt.goldenShmSha256 !== null && !SHA256_PATTERN.test(String(receipt.goldenShmSha256 || '')))
      || (receipt.goldenWalSha256 || null) !== (report.golden.walSha256 || null)
      || (receipt.goldenShmSha256 || null) !== (report.golden.shmSha256 || null)
      || receipt.goldenSizeBytes !== report.golden.sizeBytes
      || receipt.goldenWalSizeBytes !== report.golden.walSizeBytes
      || receipt.goldenShmSizeBytes !== report.golden.shmSizeBytes) {
    throw codedError('GOLDEN_MANUAL_RECEIPT_BUNDLE', 'golden receipt WAL/size 不匹配');
  }
  if (receipt.sourceClass !== 'controlled-windows-local-mounted-anonymized-copy'
      || receipt.anonymizationConfirmed !== true
      || receipt.representativenessConfirmed !== true
      || receipt.dataOwnerConfirmed !== true) {
    throw codedError('GOLDEN_MANUAL_RECEIPT_CONFIRMATION', 'golden receipt 缺少脱敏/代表性/数据负责人确认');
  }
  validateSigner(receipt.signer, 'data-owner');
  const signedAt = canonicalIsoTimestamp(receipt.signedAt, 'golden receipt signedAt');
  if (options.machineGeneratedAt) {
    const machineGeneratedAt = canonicalIsoTimestamp(
      options.machineGeneratedAt, 'machine candidate generatedAt'
    );
    if (Date.parse(signedAt) > Date.parse(machineGeneratedAt)) {
      throw codedError('MANUAL_RECEIPT_TIME_INVALID', 'golden receipt 不得晚于 machine candidate');
    }
  }
  return {
    status: 'confirmed', evidenceSource: 'manual', signedAt,
    receiptSha256: evidenceDigest(receipt)
  };
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateScenarioEnvelope(scenario, envelope, environment, reasonCodes, identityRegistry) {
  const report = envelope && envelope.report;
  if (!report || report.schemaVersion !== 2 || report.scenario !== scenario) {
    reasonCodes.add('SCENARIO_REPORT_INVALID');
    return null;
  }
  if (envelope.environmentDigest !== environment.digest
      || !envelope.cleanupEvidence || envelope.cleanupEvidence.verifiedAbsent !== true
      || report.run && (report.run.status !== 'completed' || report.run.requiresManualCleanup === true)) {
    reasonCodes.add('HOST_OR_CLEANUP_EVIDENCE_INVALID');
  }
  const expected = Number(report.contract && report.contract.runsPerVariant);
  if (!Number.isSafeInteger(expected) || expected < 5) reasonCodes.add('SAMPLE_CONTRACT_INVALID');
  if (report.contract && report.contract.firstSampleRetained !== true) reasonCodes.add('SAMPLE_CONTRACT_INVALID');
  const rotation = report.contract && report.contract.rotatingOrder;
  if (!Array.isArray(rotation) || rotation.length !== expected
      || rotation.some((order, round) => JSON.stringify(order) !== JSON.stringify(
        REQUIRED_VARIANTS.slice(round % REQUIRED_VARIANTS.length)
          .concat(REQUIRED_VARIANTS.slice(0, round % REQUIRED_VARIANTS.length))
      ))) reasonCodes.add('ROTATION_CONTRACT_INVALID');
  const pendingZero = (value) => value && typeof value === 'object'
    && ['activeTaskRuns', 'activeBatches', 'pendingArtifacts', 'flowBindIntents']
      .every((key) => Number(value[key]) === 0);
  let goldenBundle = null;
  try { goldenBundle = projectGoldenBundle(report.golden); } catch (_error) {
    reasonCodes.add('GOLDEN_BUNDLE_IDENTITY_INVALID');
  }
  const scenarioEvidenceValid = (sample, label) => {
    const pre = sample.scenarioEvidence && sample.scenarioEvidence.precondition;
    const post = sample.scenarioEvidence && sample.scenarioEvidence.postcondition;
    if (!pre || !post || !pendingZero(pre.pendingRecovery) || !pendingZero(post.pendingRecovery)) return false;
    if (scenario === 'normal-clean-shutdown') {
      return pre.vacuumFlagBefore === '1' && Number.isFinite(pre.walBytesBefore)
        && pre.walBytesBefore >= 0 && pre.walBytesBefore <= 32
        && pre.schema && pre.schema.current === true && post.schema
        && SHA256_PATTERN.test(String(pre.schema.fingerprint || ''))
        && post.schema.fingerprint === pre.schema.fingerprint
        && post.vacuumFlagAfter === '1' && post.schemaChanged === false && post.validWalPending === false
        && (label.startsWith('3.1.11') ? post.legacySteady === true
          : post.vacuumOutcome === 'skipped' && post.recoveryCountsZero === true);
    }
    if (scenario === 'migration-vacuum') {
      const delta = post.schemaDelta || {};
      const exact312Delta = Array.isArray(delta.removed) && delta.removed.length === 0
        && Array.isArray(delta.added) && delta.added.length === 1
        && delta.added[0].type === 'index'
        && delta.added[0].name === 'idx_vcc_fin_op_system_snapshots_import_source'
        && Array.isArray(delta.changed)
        && JSON.stringify(delta.changed.map((item) => item.name).sort())
          === JSON.stringify(['archive_artifacts', 'archive_blobs', 'vcc_fin_op_system_snapshots'])
        && delta.changed.every((item) => item.type === 'table');
      return Object.hasOwn(pre, 'vacuumFlagBefore') && pre.vacuumFlagBefore !== '1'
        && post.vacuumFlagAfter === '1' && post.schemaValid === true
        && (label.startsWith('3.1.11') ? post.vacuumOutcome === 'legacy-flag-transition'
          && post.schemaChanged === false && Array.isArray(delta.added) && delta.added.length === 0
          && Array.isArray(delta.removed) && delta.removed.length === 0
          && Array.isArray(delta.changed) && delta.changed.length === 0
          : post.vacuumOutcome === 'success' && post.columnDeltaValid === true
            && post.indexDefinitionValid === true && exact312Delta);
    }
    const journalSentinelValid = (pre.journalSentinelPresent === null
        && post.journalSentinelConsumed === null)
      || (pre.journalSentinelPresent === true && post.journalSentinelConsumed === true);
    return Number(pre.walBytes) > 32 && pre.walSentinel && journalSentinelValid
      && pre.schema && pre.schema.current === true && post.schema
      && SHA256_PATTERN.test(String(pre.schema.fingerprint || ''))
      && post.schema.fingerprint === pre.schema.fingerprint
      && pre.walSentinel.baseValue !== pre.walSentinel.walVisibleValue
      && post.walSentinelCheckpointed === true && post.validWalPending === false
      && post.schemaChanged === false;
  };
  for (const label of REQUIRED_VARIANTS) {
    const variant = report.variants && report.variants[label];
    const sampleList = variant && variant.samples;
    if (!variant || !SHA256_PATTERN.test(String(variant.initialSha256 || ''))
        || (variant.initialWalSha256 !== null && !SHA256_PATTERN.test(String(variant.initialWalSha256 || '')))
        || (variant.initialShmSha256 !== null && !SHA256_PATTERN.test(String(variant.initialShmSha256 || '')))
        || !goldenBundle || variant.initialSha256 !== goldenBundle.main.sha256
        || (variant.initialWalSha256 || null) !== goldenBundle.wal.sha256
        || (variant.initialShmSha256 || null) !== goldenBundle.shm.sha256) {
      reasonCodes.add('GOLDEN_INITIAL_IDENTITY_MISMATCH');
    }
    if (!Array.isArray(sampleList) || sampleList.length !== expected) {
      reasonCodes.add('FAILED_OR_MISSING_SAMPLE');
      continue;
    }
    const rounds = new Set();
    const bundleByRound = new Map();
    for (const sample of sampleList) {
      if (!sample || sample.status !== 'success' || !Number.isFinite(sample.externalFullReadyMs)
          || sample.externalFullReadyMs <= 0 || !Number.isSafeInteger(sample.round)
          || sample.round < 1 || sample.round > expected || rounds.has(sample.round)) {
        reasonCodes.add('FAILED_OR_MISSING_SAMPLE');
        continue;
      }
      rounds.add(sample.round);
      let phaseEvidence = null;
      try {
        phaseEvidence = validatePhaseInventory(label, sample.phases);
      } catch (_error) {
        reasonCodes.add('PHASE_INVENTORY_INVALID');
      }
      const ready = sample.readyEvidence;
      const close = sample.gracefulCloseEvidence;
      const exit = sample.processExitEvidence;
      const cleanup = sample.cleanupEvidence;
      const nonceSha256 = sample.processTree && sample.processTree.nonceSha256;
      try {
        const readyProjection = validateReadyEvidence(label, ready, phaseEvidence);
        validateTimingPhysics(label, sample.externalFullReadyMs, readyProjection);
      } catch (_error) {
        reasonCodes.add('READY_EVIDENCE_INVALID');
      }
      if (sample.gracefulClose !== true || !close || close.tokenRevalidated !== true
          || !Array.isArray(close.acceptedPids) || close.acceptedPids.length < 1
          || !sample.processTree || !(sample.processTree.observedProcessCount >= 1)
          || !/^[0-9a-f]{64}$/.test(String(sample.processTree.nonceSha256 || ''))
          || !exit || !exit.rootExit || Number(exit.rootExit.code) !== 0 || exit.rootExit.signal !== null
          || exit.treeExited !== true || exit.verifiedEmpty !== true
          || !Array.isArray(exit.quiescenceSnapshots) || exit.quiescenceSnapshots.length < 3
          || exit.quiescenceSnapshots.some((snapshot) => !Array.isArray(snapshot) || snapshot.length !== 0)
          || !cleanup || cleanup.mode !== 'graceful' || cleanup.verifiedEmpty !== true
          || !Array.isArray(cleanup.quiescenceSnapshots) || cleanup.quiescenceSnapshots.length < 3
          || cleanup.quiescenceSnapshots.some((snapshot) => !Array.isArray(snapshot) || snapshot.length !== 0)) {
        reasonCodes.add('PROCESS_WINDOW_CLEANUP_EVIDENCE_INVALID');
      }
      if (SHA256_PATTERN.test(String(nonceSha256 || ''))) {
        if (identityRegistry.nonces.has(nonceSha256)) reasonCodes.add('PROCESS_NONCE_REUSED');
        else identityRegistry.nonces.add(nonceSha256);
      }
      try {
        const before = projectRawBundle(sample.before, `${scenario}/${label}/round${sample.round}.before`);
        const after = projectRawBundle(sample.after, `${scenario}/${label}/round${sample.round}.after`);
        bundleByRound.set(sample.round, { before, after });
      } catch (_error) {
        reasonCodes.add('SAMPLE_BUNDLE_IDENTITY_INVALID');
      }
      try {
        const postPending = sample.scenarioEvidence && sample.scenarioEvidence.postcondition
          && sample.scenarioEvidence.postcondition.pendingRecovery;
        projectRecoveryCounts(sample, phaseEvidence, postPending);
      } catch (_error) {
        reasonCodes.add('RECOVERY_COUNTS_INCOMPLETE');
      }
      if (scenario === 'migration-vacuum') {
        try {
          projectMigrationEvidence(sample.scenarioEvidence.precondition,
            sample.scenarioEvidence.postcondition, label);
        } catch (_error) {
          reasonCodes.add('MIGRATION_STRUCTURED_EVIDENCE_INVALID');
        }
      }
      if (scenario !== 'normal-clean-shutdown') {
        const deleteReceipt = sample.afterSampleCleanupEvidence;
        let expectedCleanupIdentity = null;
        try {
          expectedCleanupIdentity = cleanupTargetIdentitySha256({
            comparisonId: envelope.comparisonId,
            scenario,
            label,
            round: sample.round
          });
        } catch (_error) {
          reasonCodes.add('NON_NORMAL_SAMPLE_CLEANUP_RECEIPT_INVALID');
        }
        if (!deleteReceipt || deleteReceipt.status !== 'success'
            || !SHA256_PATTERN.test(String(deleteReceipt.targetIdentitySha256 || ''))
            || deleteReceipt.targetIdentitySha256 !== expectedCleanupIdentity
            || deleteReceipt.verifiedAbsent !== true || deleteReceipt.pathRecorded !== false) {
          reasonCodes.add('NON_NORMAL_SAMPLE_CLEANUP_RECEIPT_INVALID');
        } else if (identityRegistry.cleanupTokens.has(deleteReceipt.targetIdentitySha256)) {
          reasonCodes.add('NON_NORMAL_SAMPLE_CLEANUP_RECEIPT_REUSED');
        } else {
          identityRegistry.cleanupTokens.add(deleteReceipt.targetIdentitySha256);
        }
      }
      if (!scenarioEvidenceValid(sample, label)) reasonCodes.add('SCENARIO_POSTCONDITION_INVALID');
    }
    if (goldenBundle && bundleByRound.size === expected) {
      for (let round = 1; round <= expected; round += 1) {
        const current = bundleByRound.get(round);
        const expectedBefore = scenario === 'normal-clean-shutdown' && round > 1
          ? bundleByRound.get(round - 1).after : goldenBundle;
        if (!current || !bundleIdentityEqual(current.before, expectedBefore)) {
          reasonCodes.add(scenario === 'normal-clean-shutdown'
            ? 'NORMAL_BUNDLE_CONTINUITY_INVALID' : 'GOLDEN_SAMPLE_IDENTITY_MISMATCH');
        }
      }
    }
    if (rounds.size !== expected) reasonCodes.add('FAILED_OR_MISSING_SAMPLE');
  }
  return report;
}

function sanitizeScenario(report) {
  const pendingProjection = (value) => ({
    activeTaskRuns: Number(value && value.activeTaskRuns),
    activeBatches: Number(value && value.activeBatches),
    pendingArtifacts: Number(value && value.pendingArtifacts),
    flowBindIntents: Number(value && value.flowBindIntents)
  });
  const scenarioProjection = (sample, label) => {
    const pre = sample.scenarioEvidence.precondition;
    const post = sample.scenarioEvidence.postcondition;
    const common = {
      kind: report.scenario,
      prePending: pendingProjection(pre.pendingRecovery),
      postPending: pendingProjection(post.pendingRecovery)
    };
    if (report.scenario === 'normal-clean-shutdown') return {
      ...common,
      vacuumFlagBefore: pre.vacuumFlagBefore,
      walBytesBefore: pre.walBytesBefore,
      schemaCurrentBefore: pre.schema.current === true,
      schemaFingerprintBefore: pre.schema.fingerprint,
      schemaFingerprintAfter: post.schema.fingerprint,
      vacuumFlagAfter: post.vacuumFlagAfter,
      schemaChanged: post.schemaChanged,
      validWalPending: post.validWalPending,
      legacySteady: label.startsWith('3.1.11') ? post.legacySteady : null,
      vacuumOutcome: label.startsWith('3.1.12') ? post.vacuumOutcome : null,
      recoveryCountsZero: label.startsWith('3.1.12') ? post.recoveryCountsZero : null
    };
    if (report.scenario === 'migration-vacuum') return {
      ...common,
      vacuumFlagBefore: pre.vacuumFlagBefore,
      vacuumFlagAfter: post.vacuumFlagAfter,
      vacuumOutcome: post.vacuumOutcome,
      schemaValid: post.schemaValid,
      columnDeltaValid: label.startsWith('3.1.12') ? post.columnDeltaValid : null,
      indexDefinitionValid: label.startsWith('3.1.12') ? post.indexDefinitionValid : null,
      schemaDelta: {
        added: (post.schemaDelta && post.schemaDelta.added || []).map(({ type, name }) => ({ type, name })),
        removed: (post.schemaDelta && post.schemaDelta.removed || []).map(({ type, name }) => ({ type, name })),
        changed: (post.schemaDelta && post.schemaDelta.changed || []).map(({ type, name }) => ({ type, name }))
      },
      ...projectMigrationEvidence(pre, post, label)
    };
    return {
      ...common,
      walBytesBefore: pre.walBytes,
      walSentinelBaseDiffers: pre.walSentinel.baseValue !== pre.walSentinel.walVisibleValue,
      walSentinelCheckpointed: post.walSentinelCheckpointed,
      journalSentinelPresentBefore: pre.journalSentinelPresent,
      journalSentinelConsumedAfter: post.journalSentinelConsumed,
      schemaCurrentBefore: pre.schema.current === true,
      schemaFingerprintBefore: pre.schema.fingerprint,
      schemaFingerprintAfter: post.schema.fingerprint,
      validWalPending: post.validWalPending,
      schemaChanged: post.schemaChanged
    };
  };
  const safeFailureCode = (value) => /^[A-Z][A-Z0-9_]{0,127}$/.test(String(value || ''))
    ? String(value) : 'UNAVAILABLE';
  const tryProjection = (project, fallback) => {
    try { return project(); } catch (_error) { return fallback; }
  };
  const projectFailedSample = (sample, label) => {
    const phaseEvidence = tryProjection(
      () => validatePhaseInventory(label, sample.phases),
      {
        status: 'unavailable',
        required: label.startsWith('3.1.12'),
        records: []
      }
    );
    const readyEvidence = tryProjection(() => {
      const ready = validateReadyEvidence(label, sample.readyEvidence, phaseEvidence);
      validateTimingPhysics(label, sample.externalFullReadyMs, ready);
      return ready;
    }, { status: 'unavailable' });
    const before = tryProjection(
      () => projectRawBundle(sample.before, `${report.scenario}/${label}/failed.before`), null
    );
    const after = tryProjection(
      () => projectRawBundle(sample.after, `${report.scenario}/${label}/failed.after`), null
    );
    const processEvidence = tryProjection(() => {
      const process = sample.processTree;
      const close = sample.gracefulCloseEvidence;
      const exit = sample.processExitEvidence;
      if (!process || process.observedProcessCount < 1 || !SHA256_PATTERN.test(process.nonceSha256)
          || !close || !Array.isArray(close.acceptedPids) || close.acceptedPids.length < 1
          || close.tokenRevalidated !== true || !exit || !exit.rootExit
          || !Number.isFinite(Number(exit.rootExit.code))
          || typeof exit.treeExited !== 'boolean' || typeof exit.verifiedEmpty !== 'boolean'
          || !Array.isArray(exit.quiescenceSnapshots)) throw new Error('unavailable');
      return {
        observedProcessCount: process.observedProcessCount,
        nonceSha256: process.nonceSha256,
        closeAcceptedCount: close.acceptedPids.length,
        closeTokenRevalidated: close.tokenRevalidated,
        rootExitCode: Number(exit.rootExit.code),
        rootExitSignal: exit.rootExit.signal === null ? null : safeFailureCode(exit.rootExit.signal),
        treeExited: exit.treeExited,
        verifiedEmpty: exit.verifiedEmpty,
        quiescenceEmptySnapshots: exit.quiescenceSnapshots.filter((snapshot) => (
          Array.isArray(snapshot) && snapshot.length === 0
        )).length
      };
    }, { status: 'unavailable' });
    const postPending = sample.scenarioEvidence && sample.scenarioEvidence.postcondition
      && sample.scenarioEvidence.postcondition.pendingRecovery;
    const recoveryEvidence = tryProjection(
      () => projectRecoveryCounts(sample, phaseEvidence, postPending),
      { status: 'unavailable', records: [] }
    );
    const processCleanup = sample.cleanupEvidence && sample.cleanupEvidence.mode === 'graceful'
      && Array.isArray(sample.cleanupEvidence.quiescenceSnapshots)
      ? {
        mode: 'graceful',
        verifiedEmpty: sample.cleanupEvidence.verifiedEmpty === true,
        quiescenceEmptySnapshots: sample.cleanupEvidence.quiescenceSnapshots.filter((snapshot) => (
          Array.isArray(snapshot) && snapshot.length === 0
        )).length
      } : null;
    let workingCopy = null;
    if (report.scenario === 'normal-clean-shutdown') {
      workingCopy = {
        status: 'not-applicable-normal-continuity', targetIdentitySha256: null,
        verifiedAbsent: null, pathRecorded: false
      };
    } else if (sample.afterSampleCleanupEvidence
        && SHA256_PATTERN.test(String(sample.afterSampleCleanupEvidence.targetIdentitySha256 || ''))) {
      workingCopy = {
        status: sample.afterSampleCleanupEvidence.status === 'success' ? 'success' : 'failed',
        targetIdentitySha256: sample.afterSampleCleanupEvidence.targetIdentitySha256,
        verifiedAbsent: sample.afterSampleCleanupEvidence.verifiedAbsent === true,
        pathRecorded: false
      };
    }
    return {
      round: Number.isSafeInteger(sample.round) ? sample.round : null,
      status: 'failed',
      evidenceCode: safeFailureCode(sample.evidenceCode),
      externalFullReadyMs: Number.isFinite(sample.externalFullReadyMs)
        ? sample.externalFullReadyMs : null,
      phaseEvidence,
      readyEvidence,
      processEvidence,
      bundleEvidence: {
        status: before && after ? 'complete' : before || after ? 'partial' : 'unavailable',
        before,
        after
      },
      recoveryEvidence,
      cleanupReceipt: {
        status: processCleanup || workingCopy ? 'partial' : 'unavailable',
        processTree: processCleanup,
        workingCopy
      },
      scenarioEvidence: tryProjection(
        () => scenarioProjection(sample, label),
        { kind: report.scenario, status: 'unavailable' }
      )
    };
  };
  const unavailableVariant = (label, evidenceCode) => ({
    label,
    status: 'unavailable',
    evidenceCode,
    sampleCount: 0,
    samples: []
  });
  return {
    schemaVersion: report.schemaVersion,
    scenario: report.scenario,
    run: {
      status: report.run.status,
      requiresManualCleanup: report.run.requiresManualCleanup === true
    },
    contract: {
      runsPerVariant: report.contract.runsPerVariant,
      firstSampleRetained: report.contract.firstSampleRetained === true,
      rotatingOrder: report.contract.rotatingOrder.map((order) => [...order])
    },
    golden: {
      sha256: report.golden.sha256,
      walSha256: report.golden.walSha256 || null,
      shmSha256: report.golden.shmSha256 || null,
      sizeBytes: report.golden.sizeBytes,
      walSizeBytes: report.golden.walSizeBytes,
      shmSizeBytes: report.golden.shmSizeBytes,
      sourcePathRecorded: false
    },
    variants: Object.fromEntries(REQUIRED_VARIANTS.map((label) => {
      const variant = report.variants && report.variants[label];
      if (!variant) return [label, unavailableVariant(label, 'MISSING_VARIANT')];
      if (!Array.isArray(variant.samples)) {
        return [label, unavailableVariant(label, 'MISSING_VARIANT_SAMPLES')];
      }
      return [label, {
        sampleCount: variant.samples.length,
        samples: (() => {
          const projected = variant.samples.map((sample) => {
          if (!sample || sample.status !== 'success') return projectFailedSample(sample || {}, label);
          try {
            const phaseEvidence = validatePhaseInventory(label, sample.phases);
            const readyEvidence = validateReadyEvidence(label, sample.readyEvidence, phaseEvidence);
            validateTimingPhysics(label, sample.externalFullReadyMs, readyEvidence);
            const before = projectRawBundle(sample.before, `${report.scenario}/${label}/before`);
            const after = projectRawBundle(sample.after, `${report.scenario}/${label}/after`);
            const postPending = sample.scenarioEvidence.postcondition.pendingRecovery;
            const workingCopyCleanup = report.scenario === 'normal-clean-shutdown'
              ? {
                status: 'not-applicable-normal-continuity', targetIdentitySha256: null,
                verifiedAbsent: null, pathRecorded: false
              }
              : {
                status: sample.afterSampleCleanupEvidence.status,
                targetIdentitySha256: sample.afterSampleCleanupEvidence.targetIdentitySha256,
                verifiedAbsent: sample.afterSampleCleanupEvidence.verifiedAbsent,
                pathRecorded: false
              };
            return {
              round: sample.round,
              status: sample.status,
              externalFullReadyMs: sample.externalFullReadyMs,
              phaseEvidence,
              readyEvidence,
              processEvidence: {
                observedProcessCount: sample.processTree.observedProcessCount,
                nonceSha256: sample.processTree.nonceSha256,
                closeAcceptedCount: sample.gracefulCloseEvidence.acceptedPids.length,
                closeTokenRevalidated: sample.gracefulCloseEvidence.tokenRevalidated,
                rootExitCode: sample.processExitEvidence.rootExit.code,
                rootExitSignal: sample.processExitEvidence.rootExit.signal,
                treeExited: sample.processExitEvidence.treeExited,
                verifiedEmpty: sample.processExitEvidence.verifiedEmpty,
                quiescenceEmptySnapshots: sample.processExitEvidence.quiescenceSnapshots.length
              },
              bundleEvidence: { before, after },
              recoveryEvidence: projectRecoveryCounts(sample, phaseEvidence, postPending),
              cleanupReceipt: {
                processTree: {
                  mode: sample.cleanupEvidence.mode,
                  verifiedEmpty: sample.cleanupEvidence.verifiedEmpty,
                  quiescenceEmptySnapshots: sample.cleanupEvidence.quiescenceSnapshots.length
                },
                workingCopy: workingCopyCleanup
              },
              scenarioEvidence: scenarioProjection(sample, label)
            };
          } catch (_error) {
            return projectFailedSample({
              ...sample,
              status: 'failed',
              evidenceCode: safeFailureCode(sample.evidenceCode || 'EVIDENCE_PROJECTION_INVALID')
            }, label);
          }
          });
          const presentRounds = new Set(variant.samples
            .filter((sample) => Number.isSafeInteger(sample && sample.round))
            .map((sample) => sample.round));
          for (let round = 1; round <= report.contract.runsPerVariant; round += 1) {
            if (!presentRounds.has(round)) {
              projected.push(projectFailedSample({
                round, status: 'failed', evidenceCode: 'MISSING_SAMPLE'
              }, label));
            }
          }
          return projected.sort((left, right) => (left.round || 0) - (right.round || 0));
        })()
      }];
    })),
    fullReportSha256: evidenceDigest(report)
  };
}

function unavailableScenarioProjection(scenario) {
  const unavailable = {
    schemaVersion: 2,
    scenario,
    run: { status: 'unavailable', requiresManualCleanup: true },
    contract: { runsPerVariant: 0, firstSampleRetained: false, rotatingOrder: [] },
    golden: {
      sha256: null,
      walSha256: null,
      shmSha256: null,
      sizeBytes: 0,
      walSizeBytes: 0,
      shmSizeBytes: 0,
      sourcePathRecorded: false
    },
    variants: Object.fromEntries(REQUIRED_VARIANTS.map((label) => [label, {
      sampleCount: 0,
      samples: []
    }]))
  };
  return { ...unavailable, fullReportSha256: evidenceDigest(unavailable) };
}

function comparison(baseline, current) {
  const rawBaselineMedianMs = median(baseline);
  const rawCurrentMedianMs = median(current);
  const rawReductionPercent = ((rawBaselineMedianMs - rawCurrentMedianMs) / rawBaselineMedianMs) * 100;
  return {
    baselineMedianMs: Number(rawBaselineMedianMs.toFixed(3)),
    currentMedianMs: Number(rawCurrentMedianMs.toFixed(3)),
    reductionPercent: Number(rawReductionPercent.toFixed(3)),
    thresholdPercent: ACCEPTANCE_THRESHOLD_PERCENT,
    passed: rawReductionPercent >= ACCEPTANCE_THRESHOLD_PERCENT,
    metric: 'raw-externalFullReadyMs-median'
  };
}

function isPublicFileIdentity(identity, label, requireLabel = true) {
  if (!identity || !/^[0-9a-f]{64}$/.test(String(identity.sha256 || ''))
      || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes <= 0
      || identity.pathRecorded !== false || typeof identity.fileVersion !== 'string'
      || !identity.fileVersion.trim()) return false;
  if (requireLabel && identity.label !== label) return false;
  try { assertVersion(label, identity.fileVersion); } catch (_error) { return false; }
  return true;
}

function validateArtifactEvidence(artifacts, reasonCodes) {
  const expected = new Map();
  const hashes = new Set();
  for (const label of REQUIRED_VARIANTS) {
    const variant = artifacts && artifacts.variants && artifacts.variants[label];
    const identity = variant && variant.artifact;
    const provenance = variant && variant.provenance;
    let valid = isPublicFileIdentity(identity, label);
    if (valid && hashes.has(identity.sha256)) valid = false;
    if (valid) hashes.add(identity.sha256);
    if (label.endsWith('-installer')) {
      valid = valid && provenance && provenance.kind === 'installer-installed'
        && provenance.pathRecorded === false
        && provenance.installMode === 'nsis-silent-explicit-owned-root'
        && provenance.installedExeResolvedFrom === 'unique-root-product-exe'
        && isPublicFileIdentity(provenance.source, label, false)
        && isPublicFileIdentity(provenance.setup, label, false)
        && ['sha256', 'sizeBytes', 'fileVersion'].every((key) => provenance.source[key] === provenance.setup[key])
        && isPublicFileIdentity(provenance.installed, label)
        && isPublicFileIdentity(provenance.launched, label)
        && ['sha256', 'sizeBytes', 'fileVersion'].every((key) => provenance.installed[key] === identity[key]
          && provenance.launched[key] === identity[key]);
    } else {
      valid = valid && provenance && provenance.kind === 'portable-frozen-copy'
        && provenance.pathRecorded === false
        && isPublicFileIdentity(provenance.source, label, false)
        && isPublicFileIdentity(provenance.frozen, label)
        && isPublicFileIdentity(provenance.launched, label)
        && ['sha256', 'sizeBytes', 'fileVersion'].every((key) => provenance.source[key] === identity[key])
        && ['sha256', 'sizeBytes', 'fileVersion'].every((key) => provenance.frozen[key] === identity[key]
          && provenance.launched[key] === identity[key]);
    }
    if (!valid) reasonCodes.add('ARTIFACT_EVIDENCE_INVALID');
    else expected.set(label, identity);
  }
  return expected;
}

function validateReportArtifacts(report, expectedArtifacts, reasonCodes) {
  for (const label of REQUIRED_VARIANTS) {
    const actual = report && report.variants && report.variants[label] && report.variants[label].artifact;
    const expected = expectedArtifacts.get(label);
    if (!expected || !actual || actual.label !== label
        || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes
        || actual.fileVersion !== expected.fileVersion || actual.pathRecorded !== false) {
      reasonCodes.add('ARTIFACT_RUN_IDENTITY_MISMATCH');
    }
  }
}

function validateFinalReceipt(receipt, releaseCandidateSha256, releaseBoundAt, finalizeNow) {
  if (!receipt || receipt.schemaVersion !== 1
      || receipt.kind !== 'windows-startup-final-signoff-manual-receipt'
      || receipt.evidenceSource !== 'manual'
      || receipt.releaseCandidateSha256 !== releaseCandidateSha256
      || receipt.reductionsReviewed !== true
      || receipt.formalReleaseApproved !== true) return null;
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'evidenceSource', 'releaseCandidateSha256',
    'reductionsReviewed', 'formalReleaseApproved', 'signer', 'signedAt'
  ], 'FINAL_SIGNOFF_RECEIPT_SCHEMA', 'final signoff receipt');
  assertExactKeys(receipt.signer, ['id', 'role'],
    'FINAL_SIGNOFF_RECEIPT_SCHEMA', 'final signoff signer');
  validateSigner(receipt.signer, 'release-owner');
  const signedAt = canonicalIsoTimestamp(receipt.signedAt, 'final receipt signedAt');
  const boundAt = canonicalIsoTimestamp(releaseBoundAt, 'release boundAt');
  const now = canonicalIsoTimestamp(finalizeNow, 'finalize now');
  if (Date.parse(signedAt) < Date.parse(boundAt) || Date.parse(signedAt) > Date.parse(now)) return null;
  return {
    status: 'confirmed', evidenceSource: 'manual', signedAt,
    receiptSha256: evidenceDigest(receipt)
  };
}

function validateProcessSeamsReceipt(receipt, candidateEvidenceSha256, machineGeneratedAt, bindNow) {
  if (!receipt || receipt.schemaVersion !== 1
      || receipt.kind !== 'windows-startup-process-seams-manual-receipt'
      || receipt.evidenceSource !== 'manual'
      || receipt.candidateEvidenceSha256 !== candidateEvidenceSha256
      || receipt.installerAndPortableTreesObserved !== true
      || receipt.ownedMainWindowObserved !== true
      || receipt.closeMainWindowReceiptReviewed !== true
      || receipt.failureCleanupObserved !== true
      || receipt.noUnownedProcessTouchedConfirmed !== true) return null;
  assertExactKeys(receipt, [
    'schemaVersion', 'kind', 'evidenceSource', 'candidateEvidenceSha256',
    'installerAndPortableTreesObserved', 'ownedMainWindowObserved',
    'closeMainWindowReceiptReviewed', 'failureCleanupObserved',
    'noUnownedProcessTouchedConfirmed', 'signer', 'signedAt'
  ], 'PROCESS_SEAMS_RECEIPT_SCHEMA', 'process seams receipt');
  assertExactKeys(receipt.signer, ['id', 'role'],
    'PROCESS_SEAMS_RECEIPT_SCHEMA', 'process seams signer');
  validateSigner(receipt.signer, 'windows-evidence-reviewer');
  const signedAt = canonicalIsoTimestamp(receipt.signedAt, 'process receipt signedAt');
  const generatedAt = canonicalIsoTimestamp(machineGeneratedAt, 'machine candidate generatedAt');
  const now = canonicalIsoTimestamp(bindNow, 'bind now');
  if (Date.parse(signedAt) < Date.parse(generatedAt) || Date.parse(signedAt) > Date.parse(now)) return null;
  return {
    status: 'confirmed', evidenceSource: 'manual', signedAt,
    receiptSha256: evidenceDigest(receipt)
  };
}

function releaseCandidateDigest(machineCandidateSha256, processReceiptSha256, boundAt) {
  return evidenceDigest({
    schemaVersion: 1,
    kind: 'windows-startup-release-candidate',
    machineCandidateSha256,
    processReceiptSha256,
    boundAt: canonicalIsoTimestamp(boundAt, 'release boundAt')
  });
}

function assertPendingProjectionZero(value) {
  return value && Object.keys(value).sort().join(',') === 'activeBatches,activeTaskRuns,flowBindIntents,pendingArtifacts'
    && Object.values(value).every((count) => Number(count) === 0);
}

function isExactMigrationProjection(delta, legacy) {
  if (!delta || !Array.isArray(delta.added) || !Array.isArray(delta.removed)
      || !Array.isArray(delta.changed) || delta.removed.length !== 0) return false;
  if (legacy) return delta.added.length === 0 && delta.changed.length === 0;
  return delta.added.length === 1
    && delta.added[0].type === 'index'
    && delta.added[0].name === 'idx_vcc_fin_op_system_snapshots_import_source'
    && JSON.stringify(delta.changed.map((item) => item.name).sort())
      === JSON.stringify(['archive_artifacts', 'archive_blobs', 'vcc_fin_op_system_snapshots'])
    && delta.changed.every((item) => item.type === 'table');
}

function validateProjectedScenario(scenario, report, comparisonId, identityRegistry) {
  if (!report || report.schemaVersion !== 2 || report.scenario !== scenario
      || report.run.status !== 'completed' || report.run.requiresManualCleanup !== false
      || report.contract.runsPerVariant !== 8 || report.contract.firstSampleRetained !== true
      || !Array.isArray(report.contract.rotatingOrder) || report.contract.rotatingOrder.length !== 8
      || !SHA256_PATTERN.test(String(report.fullReportSha256 || ''))
      || report.golden.sizeBytes < FORMAL_GOLDEN_MIN_BYTES || report.golden.sourcePathRecorded !== false) {
    throw codedError('FINALIZE_SCENARIO_INVALID', `${scenario} canonical scenario header 无效`);
  }
  const goldenBundle = projectGoldenBundle(report.golden);
  for (let round = 0; round < 8; round += 1) {
    const expected = REQUIRED_VARIANTS.slice(round % 4).concat(REQUIRED_VARIANTS.slice(0, round % 4));
    if (JSON.stringify(report.contract.rotatingOrder[round]) !== JSON.stringify(expected)) {
      throw codedError('FINALIZE_ROTATION_INVALID', `${scenario} rotation 无效`);
    }
  }
  for (const label of REQUIRED_VARIANTS) {
    const variant = report.variants && report.variants[label];
    if (!variant || variant.sampleCount !== 8 || !Array.isArray(variant.samples) || variant.samples.length !== 8) {
      throw codedError('FINALIZE_SAMPLE_COUNT_INVALID', `${scenario}/${label} sample count 无效`);
    }
    const rounds = new Set();
    const bundleByRound = new Map();
    for (const sample of variant.samples) {
      const phase = sample.phaseEvidence;
      const process = sample.processEvidence;
      const bundle = sample.bundleEvidence;
      const evidence = sample.scenarioEvidence;
      if (sample.status !== 'success' || !Number.isFinite(sample.externalFullReadyMs)
          || sample.externalFullReadyMs <= 0 || !Number.isSafeInteger(sample.round)
          || sample.round < 1 || sample.round > 8 || rounds.has(sample.round)) {
        throw codedError('FINALIZE_SAMPLE_INVALID', `${scenario}/${label} sample 无效`);
      }
      rounds.add(sample.round);
      validateProjectedPhaseEvidence(label, phase);
      const ready = validateReadyEvidence(label, sample.readyEvidence, phase);
      validateTimingPhysics(label, sample.externalFullReadyMs, ready);
      if (!process || process.observedProcessCount < 1 || !SHA256_PATTERN.test(process.nonceSha256)
          || process.closeAcceptedCount < 1 || process.closeTokenRevalidated !== true
          || process.rootExitCode !== 0 || process.rootExitSignal !== null
          || process.treeExited !== true || process.verifiedEmpty !== true
          || process.quiescenceEmptySnapshots < 3) {
        throw codedError('FINALIZE_PROCESS_EVIDENCE_INVALID', `${scenario}/${label} process evidence 无效`);
      }
      if (identityRegistry.nonces.has(process.nonceSha256)) {
        throw codedError('FINALIZE_PROCESS_NONCE_REUSED', `${scenario}/${label} process nonce 被重复使用`);
      }
      identityRegistry.nonces.add(process.nonceSha256);
      const before = validateProjectedBundle(bundle && bundle.before, `${scenario}/${label}/before`);
      const after = validateProjectedBundle(bundle && bundle.after, `${scenario}/${label}/after`);
      bundleByRound.set(sample.round, { before, after });
      if (!evidence || evidence.kind !== scenario || !assertPendingProjectionZero(evidence.prePending)
          || !assertPendingProjectionZero(evidence.postPending)) {
        throw codedError('FINALIZE_SCENARIO_EVIDENCE_INVALID', `${scenario}/${label} pending evidence 无效`);
      }
      validateProjectedRecoveryCounts(sample.recoveryEvidence, phase, evidence.postPending);
      const cleanup = sample.cleanupReceipt;
      if (!cleanup || !cleanup.processTree || cleanup.processTree.mode !== 'graceful'
          || cleanup.processTree.verifiedEmpty !== true
          || cleanup.processTree.quiescenceEmptySnapshots < 3 || !cleanup.workingCopy
          || cleanup.workingCopy.pathRecorded !== false
          || (scenario === 'normal-clean-shutdown'
            ? cleanup.workingCopy.status !== 'not-applicable-normal-continuity'
              || cleanup.workingCopy.targetIdentitySha256 !== null
              || cleanup.workingCopy.verifiedAbsent !== null
            : cleanup.workingCopy.status !== 'success'
              || !SHA256_PATTERN.test(String(cleanup.workingCopy.targetIdentitySha256 || ''))
              || cleanup.workingCopy.targetIdentitySha256 !== cleanupTargetIdentitySha256({
                comparisonId, scenario, label, round: sample.round
              })
              || cleanup.workingCopy.verifiedAbsent !== true)) {
        throw codedError('FINALIZE_CLEANUP_RECEIPT_INVALID', `${scenario}/${label} cleanup receipt 无效`);
      }
      if (scenario !== 'normal-clean-shutdown') {
        if (identityRegistry.cleanupTokens.has(cleanup.workingCopy.targetIdentitySha256)) {
          throw codedError('FINALIZE_CLEANUP_RECEIPT_REUSED', `${scenario}/${label} cleanup receipt 被重复使用`);
        }
        identityRegistry.cleanupTokens.add(cleanup.workingCopy.targetIdentitySha256);
      }
      if (scenario === 'normal-clean-shutdown'
          && !(evidence.vacuumFlagBefore === '1' && evidence.walBytesBefore >= 0
            && evidence.walBytesBefore <= 32 && evidence.schemaCurrentBefore === true
            && SHA256_PATTERN.test(String(evidence.schemaFingerprintBefore || ''))
            && evidence.schemaFingerprintAfter === evidence.schemaFingerprintBefore
            && evidence.vacuumFlagAfter === '1' && evidence.schemaChanged === false
            && evidence.validWalPending === false
            && (label.startsWith('3.1.11') ? evidence.legacySteady === true
              : evidence.vacuumOutcome === 'skipped' && evidence.recoveryCountsZero === true))) {
        throw codedError('FINALIZE_NORMAL_EVIDENCE_INVALID', `${scenario}/${label} normal evidence 无效`);
      }
      if (scenario === 'migration-vacuum'
          && !(evidence.vacuumFlagBefore !== '1'
            && (evidence.vacuumFlagBefore === null || typeof evidence.vacuumFlagBefore === 'string')
            && evidence.vacuumFlagAfter === '1' && evidence.schemaValid === true
            && (label.startsWith('3.1.11') ? evidence.vacuumOutcome === 'legacy-flag-transition'
              && isExactMigrationProjection(evidence.schemaDelta, true)
              : evidence.vacuumOutcome === 'success' && evidence.columnDeltaValid === true
                && evidence.indexDefinitionValid === true
                && isExactMigrationProjection(evidence.schemaDelta, false)))) {
        throw codedError('FINALIZE_MIGRATION_EVIDENCE_INVALID', `${scenario}/${label} migration evidence 无效`);
      }
      if (scenario === 'migration-vacuum') validateProjectedMigrationEvidence(evidence, label);
      if (scenario === 'crash-recovery'
          && !(evidence.walBytesBefore > 32 && evidence.walSentinelBaseDiffers === true
            && evidence.walSentinelCheckpointed === true && evidence.validWalPending === false
            && evidence.schemaChanged === false
            && evidence.schemaCurrentBefore === true
            && SHA256_PATTERN.test(String(evidence.schemaFingerprintBefore || ''))
            && evidence.schemaFingerprintAfter === evidence.schemaFingerprintBefore
            && ((evidence.journalSentinelPresentBefore === null
                && evidence.journalSentinelConsumedAfter === null)
              || (evidence.journalSentinelPresentBefore === true
                && evidence.journalSentinelConsumedAfter === true)))) {
        throw codedError('FINALIZE_CRASH_EVIDENCE_INVALID', `${scenario}/${label} crash evidence 无效`);
      }
    }
    for (let round = 1; round <= 8; round += 1) {
      const current = bundleByRound.get(round);
      const expectedBefore = scenario === 'normal-clean-shutdown' && round > 1
        ? bundleByRound.get(round - 1).after : goldenBundle;
      if (!current || !bundleIdentityEqual(current.before, expectedBefore)) {
        throw codedError('FINALIZE_BUNDLE_CONTINUITY_INVALID', `${scenario}/${label}/round${round} bundle continuity 无效`);
      }
    }
  }
}

function machineCandidateCore({
  mode, generatedAt, comparisonId, environment, artifacts, scenarios, manualReceipts, comparisons
}) {
  const environmentWithoutDigest = {
    status: environment.status,
    evidenceSource: environment.evidenceSource,
    hostIdSha256: environment.hostIdSha256,
    os: environment.os,
    cpu: environment.cpu,
    memory: environment.memory,
    localDisk: environment.localDisk,
    pathClass: environment.pathClass,
    goldenPathClass: environment.goldenPathClass,
    powerPlan: environment.powerPlan,
    defender: environment.defender,
    cachePolicy: environment.cachePolicy,
    diskBudget: environment.diskBudget
  };
  return {
    schemaVersion: 1,
    mode,
    generatedAt,
    comparisonId,
    environment: environmentWithoutDigest,
    privacy: PUBLIC_PRIVACY,
    artifactDigest: evidenceDigest(artifacts),
    scenarioDigests: Object.fromEntries(Object.entries(scenarios).map(([scenario, report]) => [
      scenario, evidenceDigest(report)
    ])),
    manualReceiptDigests: Object.fromEntries(Object.entries(manualReceipts)
      .filter(([name]) => REQUIRED_SCENARIOS.includes(name))
      .map(([scenario, receipt]) => [scenario, receipt.receiptSha256])),
    comparisons
  };
}

function buildPublicReport({
  mode, generatedAt, comparisonId, candidateEvidenceSha256, releaseCandidateSha256,
  releaseBoundAt = null, environment, artifacts, scenarios, manualReceipts, evaluation
}) {
  return {
    schemaVersion: 1,
    kind: 'windows-startup-acceptance-public-report',
    mode,
    generatedAt,
    comparisonId,
    candidateEvidenceSha256,
    releaseCandidateSha256,
    releaseBoundAt,
    environment,
    artifacts,
    scenarios,
    manualReceipts,
    evaluation,
    privacy: { ...PUBLIC_PRIVACY }
  };
}

function revalidateCanonicalDraft(draftReport) {
  assertPrivacyAllowlist(draftReport);
  const environmentResult = canonicalMachineEnvironment(draftReport.environment);
  if (draftReport.mode !== 'formal' || draftReport.evaluation.status !== 'not-evaluated'
      || !environmentResult.complete || !environmentResult.digestMatches
      || draftReport.artifacts.cleanup.verified !== true
      || draftReport.artifacts.cleanup.installedApplicationsRemoved !== true
      || draftReport.artifacts.cleanup.controlledWorkRootRemoved !== true) {
    throw codedError('FINAL_SIGNOFF_DRAFT_INVALID', 'formal draft 顶层机器/cleanup evidence 无效');
  }
  const artifactReasons = new Set();
  validateArtifactEvidence(draftReport.artifacts, artifactReasons);
  if (artifactReasons.size) throw codedError('FINALIZE_ARTIFACT_INVALID', 'artifact provenance 无效');
  const identityRegistry = { nonces: new Set(), cleanupTokens: new Set() };
  for (const scenario of REQUIRED_SCENARIOS) {
    validateProjectedScenario(
      scenario, draftReport.scenarios[scenario], draftReport.comparisonId, identityRegistry
    );
  }
  const normal = draftReport.scenarios['normal-clean-shutdown'];
  const comparisons = {
    installer: comparison(
      normal.variants['3.1.11-installer'].samples.map((sample) => sample.externalFullReadyMs),
      normal.variants['3.1.12-installer'].samples.map((sample) => sample.externalFullReadyMs)
    ),
    portable: comparison(
      normal.variants['3.1.11-portable'].samples.map((sample) => sample.externalFullReadyMs),
      normal.variants['3.1.12-portable'].samples.map((sample) => sample.externalFullReadyMs)
    )
  };
  if (!comparisons.installer.passed || !comparisons.portable.passed) {
    throw codedError('FINALIZE_THRESHOLD_FAILED', '当前 canonical evidence 双配对未达到 70%');
  }
  const goldenReceipts = {};
  const goldenReceiptDigests = new Set();
  const generatedAt = canonicalIsoTimestamp(draftReport.generatedAt, 'draft generatedAt');
  for (const scenario of REQUIRED_SCENARIOS) {
    const receipt = draftReport.manualReceipts[scenario];
    if (!receipt || receipt.status !== 'confirmed' || receipt.evidenceSource !== 'manual'
        || !SHA256_PATTERN.test(String(receipt.receiptSha256 || ''))
        || canonicalIsoTimestamp(receipt.signedAt, `${scenario} golden receipt signedAt`) !== receipt.signedAt
        || Date.parse(receipt.signedAt) > Date.parse(generatedAt)
        || goldenReceiptDigests.has(receipt.receiptSha256)) {
      throw codedError('FINALIZE_GOLDEN_RECEIPT_INVALID', `${scenario} receipt digest 无效`);
    }
    goldenReceiptDigests.add(receipt.receiptSha256);
    goldenReceipts[scenario] = receipt;
  }
  const candidateEvidenceSha256 = evidenceDigest(machineCandidateCore({
    mode: 'formal',
    generatedAt: draftReport.generatedAt,
    comparisonId: draftReport.comparisonId,
    environment: environmentResult.projection,
    artifacts: sanitizeArtifactEvidence(draftReport.artifacts),
    scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map((scenario) => [scenario, draftReport.scenarios[scenario]])),
    manualReceipts: goldenReceipts,
    comparisons
  }));
  if (draftReport.candidateEvidenceSha256 !== candidateEvidenceSha256) {
    throw codedError('FINALIZE_MACHINE_CANDIDATE_MISMATCH', 'draft machine candidate 与当前 canonical evidence 不匹配');
  }
  return {
    candidateEvidenceSha256,
    comparisons,
    environment: environmentResult.projection,
    artifacts: sanitizeArtifactEvidence(draftReport.artifacts),
    scenarios: Object.fromEntries(REQUIRED_SCENARIOS.map((scenario) => [scenario, draftReport.scenarios[scenario]])),
    goldenReceipts
  };
}

function bindProcessReceipt(draftReport, processSeamsReceipt, options = {}) {
  if (draftReport.releaseCandidateSha256 !== null) {
    throw codedError('RELEASE_CANDIDATE_ALREADY_BOUND', 'release candidate 已绑定，禁止重新绑定 process receipt');
  }
  const canonical = revalidateCanonicalDraft(draftReport);
  const boundAt = canonicalNow(options, 'bind now');
  const seams = validateProcessSeamsReceipt(
    processSeamsReceipt, canonical.candidateEvidenceSha256, draftReport.generatedAt, boundAt
  );
  if (!seams) throw codedError('PROCESS_SEAMS_RECEIPT_INVALID', 'process seams receipt 无效、时序错误或未绑定 machine candidate');
  const releaseCandidateSha256 = releaseCandidateDigest(
    canonical.candidateEvidenceSha256, seams.receiptSha256, boundAt
  );
  const result = buildPublicReport({
    mode: 'formal',
    generatedAt: draftReport.generatedAt,
    comparisonId: draftReport.comparisonId,
    candidateEvidenceSha256: canonical.candidateEvidenceSha256,
    releaseCandidateSha256,
    releaseBoundAt: boundAt,
    environment: canonical.environment,
    artifacts: canonical.artifacts,
    scenarios: canonical.scenarios,
    manualReceipts: { ...canonical.goldenReceipts, processSeams: seams },
    evaluation: {
      status: 'not-evaluated',
      formal: false,
      reasonCodes: ['FINAL_MANUAL_SIGNOFF_REQUIRED'],
      comparisons: canonical.comparisons
    }
  });
  assertPrivacyAllowlist(result);
  return result;
}

function finalizeAcceptanceReport(draftReport, processSeamsReceipt, finalSignoffReceipt, options = {}) {
  const canonical = revalidateCanonicalDraft(draftReport);
  const boundAt = canonicalIsoTimestamp(draftReport.releaseBoundAt, 'release boundAt');
  const finalizeNow = canonicalNow(options, 'finalize now');
  const seams = validateProcessSeamsReceipt(
    processSeamsReceipt, canonical.candidateEvidenceSha256, draftReport.generatedAt, boundAt
  );
  if (!seams) throw codedError('PROCESS_SEAMS_RECEIPT_INVALID', 'process seams receipt 无效、时序错误或未绑定 machine candidate');
  const releaseCandidateSha256 = releaseCandidateDigest(
    canonical.candidateEvidenceSha256, seams.receiptSha256, boundAt
  );
  if (draftReport.releaseCandidateSha256 !== releaseCandidateSha256) {
    throw codedError('RELEASE_CANDIDATE_NOT_BOUND', '必须先输出并复核绑定 process receipt 的 release candidate');
  }
  const signoff = validateFinalReceipt(
    finalSignoffReceipt, releaseCandidateSha256, boundAt, finalizeNow
  );
  if (!signoff) throw codedError('FINAL_SIGNOFF_RECEIPT_INVALID', 'final manual signoff receipt 无效、时序错误或未绑定 release candidate');
  const finalized = buildPublicReport({
    mode: 'formal',
    generatedAt: draftReport.generatedAt,
    comparisonId: draftReport.comparisonId,
    candidateEvidenceSha256: canonical.candidateEvidenceSha256,
    releaseCandidateSha256,
    releaseBoundAt: boundAt,
    environment: canonical.environment,
    artifacts: canonical.artifacts,
    scenarios: canonical.scenarios,
    manualReceipts: {
      ...canonical.goldenReceipts,
      processSeams: seams,
      finalSignoff: signoff
    },
    evaluation: {
      status: 'pass', formal: true, reasonCodes: [], comparisons: canonical.comparisons
    }
  });
  assertPrivacyAllowlist(finalized);
  return finalized;
}

function evaluateAcceptance({
  mode, reports, goldenReceipts = {},
  environment = {}, artifacts = {}, comparisonId = null, generatedAt = new Date().toISOString()
}) {
  const reasonCodes = new Set();
  if (!['formal', 'rehearsal'].includes(mode)) throw codedError('ACCEPTANCE_MODE_INVALID', 'mode 必须为 formal/rehearsal');
  const machineGeneratedAt = canonicalIsoTimestamp(generatedAt, 'machine candidate generatedAt');
  if (mode === 'rehearsal') reasonCodes.add('REHEARSAL_NEVER_FORMAL');
  const environmentResult = canonicalMachineEnvironment(environment);
  if (!environmentResult.complete || !environmentResult.digestMatches) reasonCodes.add('MACHINE_ENVIRONMENT_INCOMPLETE');
  const validReports = {};
  const identityRegistry = { nonces: new Set(), cleanupTokens: new Set() };
  const artifactReasons = new Set();
  const expectedArtifacts = validateArtifactEvidence(artifacts, artifactReasons);
  for (const code of artifactReasons) reasonCodes.add(code);
  if (mode === 'formal' && (!artifacts.cleanup || artifacts.cleanup.verified !== true
      || artifacts.cleanup.installedApplicationsRemoved !== true
      || artifacts.cleanup.controlledWorkRootRemoved !== true)) {
    reasonCodes.add('HOST_OR_CLEANUP_EVIDENCE_INVALID');
  }
  let commonComparisonId = comparisonId;
  for (const scenario of REQUIRED_SCENARIOS) {
    const envelope = reports && reports[scenario];
    if (!envelope) {
      reasonCodes.add('SCENARIO_REPORT_MISSING');
      continue;
    }
    if (!commonComparisonId) commonComparisonId = envelope.comparisonId;
    if (envelope.comparisonId !== commonComparisonId) reasonCodes.add('COMPARISON_HOST_SCOPE_MISMATCH');
    const report = validateScenarioEnvelope(
      scenario, envelope, environmentResult.projection, reasonCodes, identityRegistry
    );
    if (!report) continue;
    validateReportArtifacts(report, expectedArtifacts, reasonCodes);
    validReports[scenario] = report;
    if (mode === 'formal' && report.golden.sizeBytes < FORMAL_GOLDEN_MIN_BYTES) {
      reasonCodes.add('FORMAL_GOLDEN_TOO_SMALL');
    }
    if (mode === 'formal' && report.contract.runsPerVariant !== 8) reasonCodes.add('FORMAL_RUNS_MUST_BE_EIGHT');
    if (mode === 'formal' && (report.golden.synthetic === true || report.golden.formalUseAllowed === false
        || report.golden.origin === 'rehearsal' || report.golden.origin === 'synthetic')) {
      reasonCodes.add('FORMAL_SYNTHETIC_OR_REHEARSAL_FORBIDDEN');
    }
    if (mode === 'formal') {
      try {
        validateGoldenManualReceipt(goldenReceipts[scenario], report, { machineGeneratedAt });
      } catch (_error) {
        reasonCodes.add('GOLDEN_MANUAL_RECEIPT_INVALID');
      }
    }
  }
  let comparisons = null;
  const evidenceBlockers = Array.from(reasonCodes).filter((code) => !['REHEARSAL_NEVER_FORMAL'].includes(code));
  if (evidenceBlockers.length === 0 && validReports['normal-clean-shutdown']) {
    const normal = validReports['normal-clean-shutdown'];
    comparisons = {
      installer: comparison(
        normal.variants['3.1.11-installer'].samples.map((sample) => sample.externalFullReadyMs),
        normal.variants['3.1.12-installer'].samples.map((sample) => sample.externalFullReadyMs)
      ),
      portable: comparison(
        normal.variants['3.1.11-portable'].samples.map((sample) => sample.externalFullReadyMs),
        normal.variants['3.1.12-portable'].samples.map((sample) => sample.externalFullReadyMs)
      )
    };
  }
  const sanitizedScenarios = Object.fromEntries(REQUIRED_SCENARIOS.map((scenario) => [
    scenario,
    validReports[scenario] ? sanitizeScenario(validReports[scenario])
      : unavailableScenarioProjection(scenario)
  ]));
  const receiptEvidence = mode === 'formal' && evidenceBlockers.length === 0
    ? Object.fromEntries(REQUIRED_SCENARIOS.map((scenario) => [scenario,
      validateGoldenManualReceipt(goldenReceipts[scenario], validReports[scenario], {
        machineGeneratedAt
      })
    ]))
    : {};
  const safeArtifacts = artifactReasons.size === 0 ? sanitizeArtifactEvidence(artifacts) : {};
  const candidateEvidenceSha256 = evidenceDigest(machineCandidateCore({
    mode,
    generatedAt: machineGeneratedAt,
    comparisonId: commonComparisonId || 'unavailable',
    environment: environmentResult.projection,
    artifacts: safeArtifacts,
    scenarios: sanitizedScenarios,
    manualReceipts: receiptEvidence,
    comparisons
  }));
  let releaseCandidateSha256 = null;
  let status = 'not-evaluated';
  let formal = false;
  if (mode === 'formal' && evidenceBlockers.length === 0 && comparisons) {
    if (!comparisons.installer.passed || !comparisons.portable.passed) {
      status = 'fail';
      reasonCodes.add('MEDIAN_REDUCTION_BELOW_70_PERCENT');
    } else {
      reasonCodes.add('PROCESS_SEAMS_MANUAL_RECEIPT_REQUIRED');
      reasonCodes.add('FINAL_MANUAL_SIGNOFF_REQUIRED');
    }
  }
  const publicReport = buildPublicReport({
    mode,
    generatedAt: machineGeneratedAt,
    comparisonId: commonComparisonId || 'unavailable',
    candidateEvidenceSha256,
    releaseCandidateSha256,
    releaseBoundAt: null,
    environment: environmentResult.projection,
    artifacts: safeArtifacts,
    scenarios: sanitizedScenarios,
    manualReceipts: receiptEvidence,
    evaluation: {
      status,
      formal,
      reasonCodes: Array.from(reasonCodes).sort(),
      comparisons
    }
  });
  assertPrivacyAllowlist(publicReport);
  return publicReport;
}

function assertPrivacyAllowlist(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw codedError('PRIVACY_ALLOWLIST_INVALID', 'privacy allowlist 仅接受对象报告');
  }
  const topKeys = Object.keys(report);
  const unknown = topKeys.filter((key) => !PUBLIC_TOP_LEVEL_KEYS.has(key));
  const missing = [...PUBLIC_TOP_LEVEL_KEYS].filter((key) => !topKeys.includes(key));
  if (unknown.length > 0 || missing.length > 0) {
    throw codedError('PRIVACY_ALLOWLIST_TOP_LEVEL_SCHEMA', `privacy allowlist 顶层 schema 不精确；unknown=${unknown.join(',')} missing=${missing.join(',')}`);
  }
  if (report.schemaVersion !== 1 || report.kind !== 'windows-startup-acceptance-public-report'
      || !['formal', 'rehearsal'].includes(report.mode)
      || canonicalIsoTimestamp(report.generatedAt, 'report.generatedAt') !== report.generatedAt
      || typeof report.comparisonId !== 'string'
      || !SHA256_PATTERN.test(String(report.candidateEvidenceSha256 || ''))
      || (report.releaseCandidateSha256 !== null
        && !SHA256_PATTERN.test(String(report.releaseCandidateSha256 || '')))
      || (report.releaseBoundAt !== null
        && canonicalIsoTimestamp(report.releaseBoundAt, 'report.releaseBoundAt') !== report.releaseBoundAt)
      || ((report.releaseCandidateSha256 === null) !== (report.releaseBoundAt === null))
      || !report.environment || typeof report.environment !== 'object' || Array.isArray(report.environment)
      || !report.artifacts || typeof report.artifacts !== 'object' || Array.isArray(report.artifacts)
      || !report.scenarios || typeof report.scenarios !== 'object' || Array.isArray(report.scenarios)
      || !report.manualReceipts || typeof report.manualReceipts !== 'object' || Array.isArray(report.manualReceipts)
      || !report.evaluation || typeof report.evaluation !== 'object' || Array.isArray(report.evaluation)
      || !report.privacy || typeof report.privacy !== 'object' || Array.isArray(report.privacy)) {
    throw codedError('PRIVACY_ALLOWLIST_TOP_LEVEL_TYPE', 'privacy allowlist 顶层 type/schema 无效');
  }
  const visit = (value, key = '') => {
    if (typeof value === 'string') {
      if (value.includes('/') || value.includes('\\')) {
        throw codedError('PRIVACY_PATH_VALUE', 'privacy allowlist 拒绝任何绝对或相对 path value');
      }
      if (key === 'guid' && !POWER_PLAN_GUID_PATTERN.test(value)) {
        throw codedError('PRIVACY_GUID_INVALID', 'privacy allowlist 仅接受 canonical lowercase power plan GUID');
      }
      const normalized = value.toLowerCase().replace(/[_-]+/g, ' ');
      if (/(customer\s*account|account\s*(number|id)?|账户|账号|卡号|金额|余额|\bsql\b|\bselect\b|\binsert\b|\bupdate\b|\bdelete\s+from\b|\braw\s*logs?\b)/i.test(normalized)
          || (!SHA256_PATTERN.test(value)
            && !(key === 'guid' && POWER_PLAN_GUID_PATTERN.test(value))
            && !/^\d{4}-\d{2}-\d{2}T/.test(value) && /\d{12,}/.test(value))) {
        throw codedError('PRIVACY_STRING_REJECTED', 'privacy allowlist 拒绝敏感自由字符串或长账号型数字');
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (key && !PUBLIC_ALLOWED_NESTED_KEYS.has(childKey)) {
        throw codedError('PRIVACY_ALLOWLIST_UNKNOWN_NESTED_KEY', `privacy allowlist 拒绝未知嵌套字段：${childKey}`);
      }
      if (childKey !== 'pathRecorded'
          && /customerAccount|(^|_)(amount|sql|sqlParams|sourcePath|absolutePath|databasePath|walPath|shmPath|workRoot|userData|documents|rawLog|rawLogs|rawReport|rawReports)$/i.test(childKey)) {
        throw codedError('PRIVACY_FIELD_REJECTED', `privacy allowlist 拒绝敏感字段：${childKey}`);
      }
      if (PUBLIC_BOOLEAN_KEYS.has(childKey) && childValue !== null && typeof childValue !== 'boolean') {
        throw codedError('PRIVACY_SCHEMA_TYPE_INVALID', `privacy allowlist 字段类型无效：${childKey}`);
      }
      if (PUBLIC_NUMBER_KEYS.has(childKey) && childValue !== null && !Number.isFinite(childValue)) {
        throw codedError('PRIVACY_SCHEMA_TYPE_INVALID', `privacy allowlist 数值字段无效：${childKey}`);
      }
      if (PUBLIC_ARRAY_KEYS.has(childKey) && !Array.isArray(childValue)) {
        throw codedError('PRIVACY_SCHEMA_TYPE_INVALID', `privacy allowlist 数组字段无效：${childKey}`);
      }
      if (PUBLIC_STRING_KEYS.has(childKey) && childValue !== null && typeof childValue !== 'string') {
        throw codedError('PRIVACY_SCHEMA_TYPE_INVALID', `privacy allowlist 字符串字段无效：${childKey}`);
      }
      visit(childValue, childKey || key);
    }
  };
  visit(report);
  assertExactKeys(report.privacy, [
    'allowlistVersion', 'publishable', 'pathsRecorded', 'rawReportsIncluded',
    'rawLogsIncluded', 'databaseFilesIncluded'
  ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'privacy');
  if (JSON.stringify(stableValue(report.privacy)) !== JSON.stringify(stableValue(PUBLIC_PRIVACY))) {
    throw codedError('PRIVACY_SEMANTICS_INVALID', 'privacy 固定语义不得由 draft 改写');
  }
  assertExactKeys(report.evaluation, ['status', 'formal', 'reasonCodes', 'comparisons'],
    'PRIVACY_SCHEMA_EXACT_KEYS', 'evaluation');
  if (report.evaluation.comparisons !== null) {
    assertExactKeys(report.evaluation.comparisons, ['installer', 'portable'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'evaluation.comparisons');
    for (const artifactKind of ['installer', 'portable']) {
      assertExactKeys(report.evaluation.comparisons[artifactKind], [
        'baselineMedianMs', 'currentMedianMs', 'reductionPercent',
        'thresholdPercent', 'passed', 'metric'
      ], 'PRIVACY_SCHEMA_EXACT_KEYS', `evaluation.comparisons.${artifactKind}`);
    }
  }
  const environmentKeys = Object.keys(report.environment);
  if (environmentKeys.length === 3) {
    if (report.mode === 'formal') {
      throw codedError('FORMAL_MACHINE_ENVIRONMENT_REQUIRED', 'formal 报告禁止三字段 environment 占位');
    }
    assertExactKeys(report.environment, ['status', 'evidenceSource', 'digest'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'environment');
  } else {
    assertExactKeys(report.environment, [
      'status', 'evidenceSource', 'hostIdSha256', 'os', 'cpu', 'memory', 'localDisk',
      'pathClass', 'goldenPathClass', 'powerPlan', 'defender', 'cachePolicy', 'diskBudget', 'digest'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'environment');
    assertExactKeys(report.environment.os, ['caption', 'version', 'build', 'arch'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.os');
    assertExactKeys(report.environment.cpu, ['model', 'logicalCores'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.cpu');
    assertExactKeys(report.environment.memory, ['totalBytes'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.memory');
    assertExactKeys(report.environment.localDisk, [
      'driveType', 'fileSystem', 'sizeBytes', 'freeBytes', 'mediaType', 'busType'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.localDisk');
    assertExactKeys(report.environment.powerPlan, ['guid'],
      'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.powerPlan');
    assertExactKeys(report.environment.defender, [
      'status', 'realtimeProtectionEnabled', 'engineVersion', 'productVersion', 'signatureVersion',
      'workRootExcluded', 'goldenExcluded'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.defender');
    assertExactKeys(report.environment.cachePolicy, [
      'evidenceSource', 'firstSampleRetained', 'explicitCacheFlush', 'order', 'comparisonScope'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.cachePolicy');
    assertExactKeys(report.environment.diskBudget, [
      'evidenceSource', 'normalSimultaneousCopies', 'nonNormalPeakEquivalentCopies',
      'completedNonNormalSamplesRetained', 'requiredFreeBytes', 'safetyBytes',
      'availableFreeBytes', 'sufficient'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'environment.diskBudget');
    const canonicalEnvironment = canonicalMachineEnvironment(report.environment);
    if (!canonicalEnvironment.complete || !canonicalEnvironment.digestMatches) {
      throw codedError('MACHINE_ENVIRONMENT_DIGEST_INVALID', '完整 machine environment digest 必须由 canonical sanitized fields 重算');
    }
  }
  const manualReceiptDigests = new Set();
  for (const [name, receipt] of Object.entries(report.manualReceipts)) {
    if (![...REQUIRED_SCENARIOS, 'processSeams', 'finalSignoff'].includes(name)) {
      throw codedError('PRIVACY_SCHEMA_EXACT_KEYS', `manualReceipts.${name} 未知`);
    }
    assertExactKeys(receipt, ['status', 'evidenceSource', 'signedAt', 'receiptSha256'],
      'PRIVACY_SCHEMA_EXACT_KEYS', `manualReceipts.${name}`);
    if (receipt.status !== 'confirmed' || receipt.evidenceSource !== 'manual'
        || canonicalIsoTimestamp(receipt.signedAt, `manualReceipts.${name}.signedAt`) !== receipt.signedAt
        || !SHA256_PATTERN.test(String(receipt.receiptSha256 || ''))
        || manualReceiptDigests.has(receipt.receiptSha256)) {
      throw codedError('MANUAL_RECEIPT_PROJECTION_INVALID', `manualReceipts.${name} 投影无效或重复`);
    }
    manualReceiptDigests.add(receipt.receiptSha256);
  }
  for (const scenario of REQUIRED_SCENARIOS) {
    const receipt = report.manualReceipts[scenario];
    if (receipt && Date.parse(receipt.signedAt) > Date.parse(report.generatedAt)) {
      throw codedError('MANUAL_RECEIPT_TIME_INVALID', `${scenario} golden receipt 晚于 machine candidate`);
    }
  }
  const processReceipt = report.manualReceipts.processSeams;
  if (report.releaseCandidateSha256 !== null) {
    if (!processReceipt || Date.parse(processReceipt.signedAt) < Date.parse(report.generatedAt)
        || Date.parse(processReceipt.signedAt) > Date.parse(report.releaseBoundAt)) {
      throw codedError('MANUAL_RECEIPT_TIME_INVALID', 'process receipt 与 M/boundAt 时序无效');
    }
  } else if (processReceipt || report.manualReceipts.finalSignoff) {
    throw codedError('MANUAL_RECEIPT_STAGE_INVALID', '未绑定 release candidate 时不得发布后续 receipt');
  }
  const finalReceipt = report.manualReceipts.finalSignoff;
  if (finalReceipt && Date.parse(finalReceipt.signedAt) < Date.parse(report.releaseBoundAt)) {
    throw codedError('MANUAL_RECEIPT_TIME_INVALID', 'final receipt 早于 release boundAt');
  }
  if (Object.keys(report.artifacts).length > 0) {
    assertExactKeys(report.artifacts, ['variants', 'cleanup'], 'PRIVACY_SCHEMA_EXACT_KEYS', 'artifacts');
    assertExactKeys(report.artifacts.variants, REQUIRED_VARIANTS, 'PRIVACY_SCHEMA_EXACT_KEYS', 'artifacts.variants');
    assertExactKeys(report.artifacts.cleanup, [
      'verified', 'installedApplicationsRemoved', 'controlledWorkRootRemoved', 'pathRecorded'
    ], 'PRIVACY_SCHEMA_EXACT_KEYS', 'artifacts.cleanup');
    for (const label of REQUIRED_VARIANTS) {
      const variant = report.artifacts.variants[label];
      assertExactKeys(variant, ['artifact', 'provenance'], 'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}`);
      assertExactKeys(variant.artifact, ['sha256', 'sizeBytes', 'fileVersion', 'pathRecorded', 'label'],
        'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.artifact`);
      const provenance = variant.provenance;
      if (label.endsWith('-installer')) {
        assertExactKeys(provenance, [
          'kind', 'source', 'setup', 'installMode', 'installedExeResolvedFrom',
          'installed', 'launched', 'pathRecorded'
        ], 'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.provenance`);
        for (const key of ['source', 'setup']) assertExactKeys(provenance[key],
          ['sha256', 'sizeBytes', 'fileVersion', 'pathRecorded'],
          'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.${key}`);
        for (const key of ['installed', 'launched']) assertExactKeys(provenance[key],
          ['sha256', 'sizeBytes', 'fileVersion', 'pathRecorded', 'label'],
          'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.${key}`);
      } else {
        assertExactKeys(provenance, ['kind', 'source', 'frozen', 'launched', 'pathRecorded'],
          'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.provenance`);
        assertExactKeys(provenance.source, ['sha256', 'sizeBytes', 'fileVersion', 'pathRecorded'],
          'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.source`);
        for (const key of ['frozen', 'launched']) assertExactKeys(provenance[key],
          ['sha256', 'sizeBytes', 'fileVersion', 'pathRecorded', 'label'],
          'PRIVACY_SCHEMA_EXACT_KEYS', `artifacts.${label}.${key}`);
      }
    }
  }
  if (Object.keys(report.scenarios).length > 0) {
    assertExactKeys(report.scenarios, REQUIRED_SCENARIOS, 'PRIVACY_SCHEMA_EXACT_KEYS', 'scenarios');
    for (const scenario of REQUIRED_SCENARIOS) {
      const scenarioReport = report.scenarios[scenario];
      assertExactKeys(scenarioReport, [
        'schemaVersion', 'scenario', 'run', 'contract', 'golden', 'variants', 'fullReportSha256'
      ], 'PRIVACY_SCHEMA_EXACT_KEYS', `scenarios.${scenario}`);
      assertExactKeys(scenarioReport.run, ['status', 'requiresManualCleanup'],
        'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.run`);
      assertExactKeys(scenarioReport.contract, ['runsPerVariant', 'firstSampleRetained', 'rotatingOrder'],
        'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.contract`);
      assertExactKeys(scenarioReport.golden, [
        'sha256', 'walSha256', 'shmSha256', 'sizeBytes', 'walSizeBytes', 'shmSizeBytes',
        'sourcePathRecorded'
      ], 'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.golden`);
      assertExactKeys(scenarioReport.variants, REQUIRED_VARIANTS,
        'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.variants`);
      for (const label of REQUIRED_VARIANTS) {
        const variant = scenarioReport.variants[label];
        if (variant.status === 'unavailable') {
          assertExactKeys(variant, ['label', 'status', 'evidenceCode', 'sampleCount', 'samples'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}`);
          if (variant.label !== label || !['MISSING_VARIANT', 'MISSING_VARIANT_SAMPLES'].includes(variant.evidenceCode)
              || variant.sampleCount !== 0 || !Array.isArray(variant.samples)
              || variant.samples.length !== 0) {
            throw codedError('PRIVACY_UNAVAILABLE_VARIANT_INVALID', `${scenario}.${label} unavailable projection 无效`);
          }
        } else {
          assertExactKeys(variant, ['sampleCount', 'samples'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}`);
        }
        for (const sample of variant.samples) {
          const sampleKeys = [
            'round', 'status', 'externalFullReadyMs', 'phaseEvidence', 'readyEvidence',
            'processEvidence', 'bundleEvidence', 'recoveryEvidence', 'cleanupReceipt',
            'scenarioEvidence'
          ];
          if (sample.status === 'failed') sampleKeys.push('evidenceCode');
          assertExactKeys(sample, sampleKeys,
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.sample`);
          const phaseKeys = sample.phaseEvidence.status === 'unavailable'
            ? ['status', 'required', 'records']
            : label.startsWith('3.1.12')
              ? ['status', 'required', 'count', 'records'] : ['status', 'required', 'records'];
          assertExactKeys(sample.phaseEvidence, phaseKeys,
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.phaseEvidence`);
          for (const record of sample.phaseEvidence.records) {
            assertExactKeys(record, ['phase', 'durationMs', 'outcome', 'counts'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.phaseRecord`);
            for (const count of record.counts) assertExactKeys(count, ['name', 'count'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.phaseCount`);
          }
          assertExactKeys(sample.readyEvidence, sample.readyEvidence.status === 'unavailable'
            ? ['status'] : label.startsWith('3.1.12')
              ? ['mode', 'rendererInitMs', 'windowReadyMs', 'startupTotalMs']
              : ['mode', 'rendererInitMs'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.readyEvidence`);
          assertExactKeys(sample.processEvidence, sample.processEvidence.status === 'unavailable'
            ? ['status'] : [
              'observedProcessCount', 'nonceSha256', 'closeAcceptedCount', 'closeTokenRevalidated',
              'rootExitCode', 'rootExitSignal', 'treeExited', 'verifiedEmpty', 'quiescenceEmptySnapshots'
            ], 'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.processEvidence`);
          assertExactKeys(sample.bundleEvidence, sample.status === 'failed'
            ? ['status', 'before', 'after'] : ['before', 'after'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.bundleEvidence`);
          for (const boundary of ['before', 'after']) {
            if (sample.bundleEvidence[boundary] === null) continue;
            assertExactKeys(sample.bundleEvidence[boundary], ['main', 'wal', 'shm'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.${boundary}`);
            for (const fileKind of ['main', 'wal', 'shm']) assertExactKeys(
              sample.bundleEvidence[boundary][fileKind], ['sha256', 'sizeBytes'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.${boundary}.${fileKind}`
            );
          }
          assertExactKeys(sample.recoveryEvidence, sample.recoveryEvidence.status === 'unavailable'
            ? ['status', 'records'] : ['records'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.recoveryEvidence`);
          for (const record of sample.recoveryEvidence.records) {
            assertExactKeys(record, ['source', 'counts'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.recoveryRecord`);
            for (const count of record.counts) assertExactKeys(count, ['name', 'count'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.recoveryCount`);
          }
          assertExactKeys(sample.cleanupReceipt, sample.status === 'failed'
            ? ['status', 'processTree', 'workingCopy'] : ['processTree', 'workingCopy'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.cleanupReceipt`);
          if (sample.cleanupReceipt.processTree !== null) assertExactKeys(
            sample.cleanupReceipt.processTree,
            ['mode', 'verifiedEmpty', 'quiescenceEmptySnapshots'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.cleanupReceipt.processTree`
          );
          if (sample.cleanupReceipt.workingCopy !== null) assertExactKeys(
            sample.cleanupReceipt.workingCopy,
            ['status', 'targetIdentitySha256', 'verifiedAbsent', 'pathRecorded'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.cleanupReceipt.workingCopy`
          );
          if (sample.scenarioEvidence.status === 'unavailable') {
            assertExactKeys(sample.scenarioEvidence, ['kind', 'status'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.scenarioEvidence`);
            continue;
          }
          const scenarioKeys = scenario === 'normal-clean-shutdown'
            ? ['kind', 'prePending', 'postPending', 'vacuumFlagBefore', 'walBytesBefore',
              'schemaCurrentBefore', 'schemaFingerprintBefore', 'schemaFingerprintAfter',
              'vacuumFlagAfter', 'schemaChanged', 'validWalPending', 'legacySteady',
              'vacuumOutcome', 'recoveryCountsZero']
            : scenario === 'migration-vacuum'
              ? ['kind', 'prePending', 'postPending', 'vacuumFlagBefore', 'vacuumFlagAfter', 'vacuumOutcome',
                'schemaValid', 'columnDeltaValid', 'indexDefinitionValid', 'schemaDelta',
                'schemaFingerprintBefore', 'schemaFingerprintAfter', 'columnDefinitions',
                'indexEvidence']
              : ['kind', 'prePending', 'postPending', 'walBytesBefore', 'walSentinelBaseDiffers',
                'walSentinelCheckpointed', 'journalSentinelPresentBefore',
                'journalSentinelConsumedAfter', 'schemaCurrentBefore',
                'schemaFingerprintBefore', 'schemaFingerprintAfter', 'validWalPending',
                'schemaChanged'];
          assertExactKeys(sample.scenarioEvidence, scenarioKeys,
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.scenarioEvidence`);
          for (const pendingKey of ['prePending', 'postPending']) assertExactKeys(
            sample.scenarioEvidence[pendingKey],
            ['activeTaskRuns', 'activeBatches', 'pendingArtifacts', 'flowBindIntents'],
            'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.${pendingKey}`
          );
          if (scenario === 'migration-vacuum') {
            assertExactKeys(sample.scenarioEvidence.columnDefinitions,
              ['vcc_fin_op_system_snapshots', 'archive_blobs', 'archive_artifacts'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.columnDefinitions`);
            for (const definitions of Object.values(sample.scenarioEvidence.columnDefinitions)) {
              for (const definition of definitions) assertExactKeys(definition,
                ['cid', 'name', 'type', 'notNull', 'defaultValue', 'primaryKey'],
                'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.columnDefinition`);
            }
            assertExactKeys(sample.scenarioEvidence.indexEvidence, [
              'name', 'actualDefinitionSha256', 'expectedDefinitionSha256', 'matchesExpected'
            ], 'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.indexEvidence`);
            assertExactKeys(sample.scenarioEvidence.schemaDelta, ['added', 'removed', 'changed'],
              'PRIVACY_SCHEMA_EXACT_KEYS', `${scenario}.${label}.schemaDelta`);
            for (const collection of ['added', 'removed', 'changed']) {
              for (const item of sample.scenarioEvidence.schemaDelta[collection]) {
                assertExactKeys(item, ['type', 'name'], 'PRIVACY_SCHEMA_EXACT_KEYS',
                  `${scenario}.${label}.schemaDelta.${collection}`);
              }
            }
          }
        }
      }
    }
  }
  return { status: 'pass', allowlistVersion: 1 };
}

function parseConfigArg(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new TypeError('用法：node scripts/windows-startup-acceptance.js --config <local-config.json>');
  const configPath = path.resolve(argv[1]);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.defineProperty(config, '_configPath', { enumerable: false, value: configPath });
  return config;
}

function assertSourceOutsideWorkRoot(workRoot, sourcePath, label) {
  const resolved = path.resolve(sourcePath);
  if (resolved === workRoot || isSubpath(workRoot, resolved)) {
    throw codedError('ACCEPTANCE_SOURCE_INSIDE_WORK_ROOT', `${label} 不得位于可清理 workRoot 内`);
  }
}

function assertExactKeys(value, requiredKeys, code, label) {
  const keys = Object.keys(value || {}).sort();
  const expected = [...requiredKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw codedError(code, `${label} 必须且只能包含：${expected.join(', ')}`);
  }
}

function validateOrchestrationConfig(config) {
  if (!config || config.schemaVersion !== 1 || !['formal', 'rehearsal'].includes(config.mode)) {
    throw codedError('ACCEPTANCE_CONFIG_INVALID', 'config schemaVersion/mode 无效');
  }
  const runs = config.runs === undefined ? 8 : Number(config.runs);
  if (!Number.isSafeInteger(runs) || runs < 5) throw codedError('ACCEPTANCE_RUNS_INVALID', 'runs 必须 >=5，建议 8');
  if (config.mode === 'formal' && runs !== 8) {
    throw codedError('FORMAL_RUNS_MUST_BE_EIGHT', 'formal normal comparison 固定 runs=8；rehearsal 才允许其它 >=5 轮数');
  }
  if (!config.workRoot || !config.output) {
    throw codedError('ACCEPTANCE_OUTPUT_SCOPE_INVALID', 'workRoot/output 必须显式提供');
  }
  if (config.mode === 'formal' && (config.processSeamsReceipt || config.finalSignoffReceipt)) {
    throw codedError(
      'FORMAL_RECEIPTS_MUST_BE_STAGED',
      'formal orchestration 只接受 golden receipts；process/final 必须在 draft 后分两阶段绑定'
    );
  }
  const workRoot = path.resolve(config.workRoot);
  const outputPath = path.resolve(config.output);
  if (outputPath === workRoot || isSubpath(workRoot, outputPath)) {
    throw codedError('ACCEPTANCE_OUTPUT_SCOPE_INVALID', 'output 必须显式位于可清理 workRoot 外');
  }
  assertExactKeys(config.inputs, REQUIRED_INPUT_KEYS, 'ACCEPTANCE_INPUTS_INVALID', 'inputs 制品键');
  assertExactKeys(config.scenarios, REQUIRED_SCENARIOS, 'ACCEPTANCE_SCENARIOS_INVALID', 'scenarios 场景键');
  for (const key of REQUIRED_INPUT_KEYS) {
    const sourcePath = config.inputs[key];
    assertSourceOutsideWorkRoot(workRoot, sourcePath, `inputs.${key}`);
    if (!fs.existsSync(path.resolve(sourcePath)) || !fs.statSync(path.resolve(sourcePath)).isFile()) {
      throw codedError('ACCEPTANCE_ARTIFACT_INPUT_MISSING', `缺少 inputs.${key} 普通文件`);
    }
  }
  for (const scenario of REQUIRED_SCENARIOS) {
    const scenarioConfig = config.scenarios[scenario];
    if (!scenarioConfig || !scenarioConfig.goldenDb) {
      throw codedError('ACCEPTANCE_SCENARIO_CONFIG_MISSING', `缺少 ${scenario} golden config`);
    }
    if (config.mode === 'formal' && !scenarioConfig.manualReceipt) {
      throw codedError('GOLDEN_MANUAL_RECEIPT_REQUIRED', `formal 缺少 ${scenario} golden manual receipt`);
    }
    for (const key of ['goldenDb', 'goldenWal', 'goldenShm', 'recoverySentinel']) {
      if (!scenarioConfig[key]) continue;
      assertSourceOutsideWorkRoot(workRoot, scenarioConfig[key], `${scenario}.${key}`);
    }
    for (const key of ['goldenDb', 'goldenWal', 'goldenShm', 'recoverySentinel', 'manualReceipt']) {
      if (!scenarioConfig[key]) continue;
      if (key === 'manualReceipt') assertSourceOutsideWorkRoot(workRoot, scenarioConfig[key], `${scenario}.${key} receipt`);
      const inputPath = path.resolve(scenarioConfig[key]);
      if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        throw codedError('ACCEPTANCE_SCENARIO_INPUT_MISSING', `缺少 ${scenario}.${key} 普通文件`);
      }
    }
  }
  for (const receiptKey of ['processSeamsReceipt', 'finalSignoffReceipt']) {
    if (!config[receiptKey]) continue;
    assertSourceOutsideWorkRoot(workRoot, config[receiptKey], `${receiptKey} receipt`);
    const receiptPath = path.resolve(config[receiptKey]);
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
      throw codedError('ACCEPTANCE_RECEIPT_MISSING', `${receiptKey} 必须是普通文件`);
    }
  }
  return { runs, workRoot, outputPath };
}

function loadReceipt(receiptPath) {
  return JSON.parse(fs.readFileSync(path.resolve(receiptPath), 'utf8'));
}

function formalGoldenSourceReport(scenario, scenarioConfig) {
  const identity = (filePath, kind) => {
    if (!filePath) return kind === 'main' ? null : { sha256: null, sizeBytes: 0 };
    stableFileIdentity(filePath, { label: `${scenario}.${kind}`, rejectLink: true });
    const stat = fs.statSync(path.resolve(filePath));
    return { sha256: sha256File(path.resolve(filePath)), sizeBytes: stat.size };
  };
  const main = identity(scenarioConfig.goldenDb, 'main');
  const wal = identity(scenarioConfig.goldenWal, 'wal');
  const shm = identity(scenarioConfig.goldenShm, 'shm');
  mainIdentity(main && main.sha256, main && main.sizeBytes, `${scenario}.source.main`);
  sidecarIdentity(wal.sha256, wal.sizeBytes, `${scenario}.source.wal`);
  sidecarIdentity(shm.sha256, shm.sizeBytes, `${scenario}.source.shm`);
  return {
    scenario,
    golden: {
      sha256: main.sha256,
      walSha256: wal.sha256,
      shmSha256: shm.sha256,
      sizeBytes: main.sizeBytes,
      walSizeBytes: wal.sizeBytes,
      shmSizeBytes: shm.sizeBytes
    }
  };
}

function preflightFormalGoldenReceipts(config, machineGeneratedAt) {
  if (config.mode !== 'formal') return {};
  const receipts = {};
  const sourceReports = {};
  const receiptDigests = new Set();
  for (const scenario of REQUIRED_SCENARIOS) {
    const scenarioConfig = config.scenarios[scenario];
    stableFileIdentity(scenarioConfig.manualReceipt, {
      label: `${scenario}.manualReceipt`, rejectLink: true
    });
    const receipt = loadReceipt(scenarioConfig.manualReceipt);
    const sourceReport = formalGoldenSourceReport(scenario, scenarioConfig);
    const projected = validateGoldenManualReceipt(
      receipt,
      sourceReport,
      { machineGeneratedAt }
    );
    if (receiptDigests.has(projected.receiptSha256)) {
      throw codedError('GOLDEN_MANUAL_RECEIPT_REUSED', '三场景 golden receipt 不得重复使用');
    }
    receiptDigests.add(projected.receiptSha256);
    receipts[scenario] = receipt;
    sourceReports[scenario] = sourceReport;
  }
  for (const scenario of REQUIRED_SCENARIOS) {
    if (sourceReports[scenario].golden.sizeBytes < FORMAL_GOLDEN_MIN_BYTES) {
      throw codedError('FORMAL_GOLDEN_TOO_SMALL', `${scenario} formal golden main 小于 2.7GB，拒绝正式验收`);
    }
  }
  return receipts;
}

async function runControlledAcceptance(config, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'win32') throw codedError('ACCEPTANCE_WINDOWS_REQUIRED', '正式/演练 orchestration 只能在 Windows 执行');
  const { runs, workRoot, outputPath } = validateOrchestrationConfig(config);
  const generatedAt = canonicalNow(dependencies, 'machine candidate generatedAt');
  const outputGuard = createProtectedOutputGuard(config);
  const goldenReceipts = preflightFormalGoldenReceipts(config, generatedAt);
  const ownership = createOwnedWorkRoot(workRoot, { ownerId: crypto.randomUUID() });
  const comparisonId = crypto.randomUUID();
  const normalGolden = config.scenarios && config.scenarios['normal-clean-shutdown']
    && config.scenarios['normal-clean-shutdown'].goldenDb;
  const environmentDetail = captureWindowsEnvironment({ workRoot, goldenPath: normalGolden }, {
    ...dependencies,
    platform
  });
  const diskBudget = estimateDiskBudget({ scenarios: config.scenarios, inputs: config.inputs });
  environmentDetail.diskBudget = {
    ...diskBudget,
    availableFreeBytes: environmentDetail.localDisk && environmentDetail.localDisk.freeBytes,
    sufficient: Boolean(environmentDetail.localDisk
      && environmentDetail.localDisk.freeBytes >= diskBudget.requiredFreeBytes)
  };
  if (!environmentDetail.diskBudget.sufficient) {
    finalizeOwnedWorkRoot({ workRoot, marker: ownership });
    throw codedError('ACCEPTANCE_DISK_BUDGET_INSUFFICIENT', '受控 workRoot 磁盘不足，拒绝复制 golden 或安装制品', {
      requiredFreeBytes: diskBudget.requiredFreeBytes,
      availableFreeBytes: environmentDetail.diskBudget.availableFreeBytes
    });
  }
  const environment = {
    ...environmentDetail,
    digest: evidenceDigest(environmentDetail)
  };
  const install = installWindowsVariants({ workRoot, inputs: config.inputs, marker: ownership }, {
    ...dependencies,
    platform
  });
  const reports = {};
  const scenarioCleanup = {};
  const runnerMain = dependencies.runPackagedMeasurement || runPackagedMeasurement;
  let fatalFailure = null;
  for (const scenario of REQUIRED_SCENARIOS) {
    const scenarioConfig = config.scenarios && config.scenarios[scenario];
    if (!scenarioConfig || !scenarioConfig.goldenDb) {
      fatalFailure = codedError('ACCEPTANCE_SCENARIO_CONFIG_MISSING', `缺少 ${scenario} golden config`);
      break;
    }
    const scenarioRelative = `scenario-${scenario}`;
    const scenarioRoot = path.join(workRoot, scenarioRelative);
    const scenarioMarker = createOwnedWorkRoot(scenarioRoot, { ownerId: `${comparisonId}:${scenario}` });
    const args = [];
    for (const label of REQUIRED_VARIANTS) args.push('--variant', `${label}=${install.runtimePaths[label]}`);
    args.push('--golden-db', scenarioConfig.goldenDb, '--scenario', scenario, '--runs', String(runs),
      '--timeout-ms', String(config.timeoutMs || 300000), '--work-root', scenarioRoot);
    if (scenarioConfig.goldenWal) args.push('--golden-wal', scenarioConfig.goldenWal);
    if (scenarioConfig.goldenShm) args.push('--golden-shm', scenarioConfig.goldenShm);
    if (scenarioConfig.walSentinel) args.push('--wal-sentinel', scenarioConfig.walSentinel);
    if (scenarioConfig.recoverySentinel) args.push('--recovery-sentinel', scenarioConfig.recoverySentinel);
    try {
      const report = await runnerMain(args, {
        silent: true,
        skipReportWrite: true,
        afterSampleCleanup: ({ label, round, sampleRoot, cleanupVerified }) => {
          if (!cleanupVerified) {
            throw codedError('NON_NORMAL_SAMPLE_CLEANUP_UNVERIFIED', 'process cleanup 未证实，禁止删除 sample 副本');
          }
          const expectedRelative = `${label}/samples/${String(round).padStart(2, '0')}`;
          const removal = removeExactOwnedTree({
            ownerRoot: scenarioRoot,
            target: sampleRoot,
            expectedRelative,
            marker: scenarioMarker
          });
          return {
            ...removal,
            targetIdentitySha256: cleanupTargetIdentitySha256({
              comparisonId, scenario, label, round
            })
          };
        }
      });
      const cleanupEvidence = removeExactOwnedTree({
        ownerRoot: workRoot,
        target: scenarioRoot,
        expectedRelative: scenarioRelative,
        marker: ownership
      });
      scenarioCleanup[scenario] = cleanupEvidence;
      reports[scenario] = { comparisonId, environmentDigest: environment.digest, cleanupEvidence, report };
    } catch (error) {
      if (error && error.report) {
        reports[scenario] = { comparisonId, environmentDigest: environment.digest, report: error.report };
      }
      fatalFailure = error;
      break;
    }
  }
  let cleanup = {
    verified: false, installedApplicationsRemoved: false,
    controlledWorkRootRemoved: false, pathRecorded: false
  };
  if (!fatalFailure) {
    try {
      const installedCleanup = cleanupInstalledVariants({ workRoot, marker: ownership, install }, dependencies);
      const rootCleanup = finalizeOwnedWorkRoot({ workRoot, marker: ownership });
      cleanup = {
        verified: installedCleanup.verified && rootCleanup.verified,
        installedApplicationsRemoved: installedCleanup.installedApplicationsRemoved,
        controlledWorkRootRemoved: rootCleanup.controlledWorkRootRemoved,
        pathRecorded: false
      };
    } catch (error) {
      fatalFailure = error;
    }
  }
  const artifactEvidence = { variants: install.variants, cleanup };
  const result = evaluateAcceptance({
    mode: config.mode,
    reports,
    goldenReceipts,
    environment,
    artifacts: artifactEvidence,
    comparisonId,
    generatedAt
  });
  if (fatalFailure && result.evaluation.status !== 'not-evaluated') {
    throw codedError('ACCEPTANCE_FATAL_NOT_REFLECTED', 'fatal failure 必须保持 not-evaluated');
  }
  writeProtectedJson(outputGuard, config, result);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const config = parseConfigArg(argv);
  if (config.action === 'bind-process') {
    const outputGuard = createProtectedOutputGuard(config);
    const draft = JSON.parse(fs.readFileSync(path.resolve(config.draftReport), 'utf8'));
    const processReceipt = loadReceipt(config.processSeamsReceipt);
    const result = bindProcessReceipt(draft, processReceipt);
    writeProtectedJson(outputGuard, config, result);
    process.stdout.write(`Windows startup acceptance: ${result.evaluation.status}\n`);
    return;
  }
  if (config.action === 'finalize') {
    const outputGuard = createProtectedOutputGuard(config);
    const draft = JSON.parse(fs.readFileSync(path.resolve(config.draftReport), 'utf8'));
    const processReceipt = loadReceipt(config.processSeamsReceipt);
    const receipt = loadReceipt(config.finalSignoffReceipt);
    const result = finalizeAcceptanceReport(draft, processReceipt, receipt);
    writeProtectedJson(outputGuard, config, result);
    process.stdout.write(`Windows startup acceptance: ${result.evaluation.status}\n`);
    return;
  }
  const result = await runControlledAcceptance(config);
  process.stdout.write(`Windows startup acceptance: ${result.evaluation.status}\n`);
  if (result.evaluation.status === 'fail') process.exitCode = 2;
  if (result.evaluation.status === 'not-evaluated' && config.mode === 'formal') process.exitCode = 3;
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error && error.code || 'WINDOWS_STARTUP_ACCEPTANCE_FAILED'}: ${error && error.message || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  ACCEPTANCE_THRESHOLD_PERCENT,
  REQUIRED_STARTUP_PHASES,
  assertPrivacyAllowlist,
  bindProcessReceipt,
  captureWindowsEnvironment,
  createOwnedWorkRoot,
  evaluateAcceptance,
  evidenceDigest,
  estimateDiskBudget,
  finalizeAcceptanceReport,
  finalizeOwnedWorkRoot,
  installWindowsVariants,
  cleanupInstalledVariants,
  comparison,
  createProtectedOutputGuard,
  main,
  removeExactOwnedTree,
  runControlledAcceptance,
  validateGoldenManualReceipt,
  validatePhaseInventory,
  writeProtectedJson
};
