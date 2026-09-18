'use strict';

const { positionReportSourceIdentity } = require('../../backend/position-report-source-identity');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSourceSnapshot, sourceSnapshotMatchesStat } = require('./source-snapshot');
const { stableSerialize } = require('../../backend/database/archive-terminal-completion');

const MODULE_ID = 'position-reconciliation-process';
const SOURCE_OPERATIONS = new Set([
  'position-reconciliation:bank:apply-import',
  'position-reconciliation:source:prepare-import',
  'position-reconciliation:source:apply-import'
]);
const STAGING_PARTS = ['run-data', 'position-reconciliation', 'import-staging'];
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function failure(code, message) {
  throw Object.assign(new Error(message), { code });
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function objectIdentity(stat) {
  if (!Number.isSafeInteger(stat.dev) || stat.dev <= 0
      || !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
    failure('ARCHIVE_DELETE_SOURCE_IDENTITY_UNAVAILABLE', '受管暂存文件系统无法提供可靠的对象身份');
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sourceEvidence(proof) {
  const sourceSnapshot = normalizeSourceSnapshot(proof.sourceSnapshot);
  const expectedSha256 = proof.expectedSha256;
  const expectedSizeBytes = proof.expectedSizeBytes;
  if (!sourceSnapshot || !sourceSnapshot.ino || sourceSnapshot.ino === '0'
      || typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)
      || !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0
      || sourceSnapshot.sizeBytes !== expectedSizeBytes) {
    failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '平盘暂存文件缺少原始对象快照、摘要或大小证据');
  }
  return { sourceSnapshot, expectedSha256, expectedSizeBytes };
}

function persistedSourceMetadata(artifact) {
  const metadata = artifact?.metadata || {};
  if (artifact?.direction === 'input') return metadata;
  if (artifact?.direction === 'output' && artifact.role === 'output'
      && artifact.sourceOperation === 'position-reconciliation:source:prepare-import'
      && metadata.preGeneratedOutput?.version === 1
      && metadata.preGeneratedOutput?.kind === 'position-anomaly-report'
      && metadata.targetSnapshot?.exists === true) {
    return { ...metadata, sourceSnapshot: metadata.targetSnapshot.snapshot };
  }
  return {};
}

function samePersistedSource(left, right) {
  const leftSnapshot = normalizeSourceSnapshot(left?.sourceSnapshot);
  const rightSnapshot = normalizeSourceSnapshot(right?.sourceSnapshot);
  return leftSnapshot?.ino && rightSnapshot?.ino
    && ['ino', 'sizeBytes', 'mtimeMs', 'ctimeMs'].every((field) => leftSnapshot[field] === rightSnapshot[field])
    && SHA256_RE.test(left.expectedSha256) && left.expectedSha256 === right.expectedSha256
    && Number.isSafeInteger(left.expectedSizeBytes) && left.expectedSizeBytes === leftSnapshot.sizeBytes
    && left.expectedSizeBytes === right.expectedSizeBytes;
}

function positionDeleteSourceReferences(repository, excludeBatchId, ownArtifacts = []) {
  const protectedPaths = [];
  const sharedPaths = [];
  const batches = repository.db.prepare(`
    SELECT DISTINCT batch_id FROM archive_artifacts
    WHERE batch_id <> ? AND source_path <> '' ORDER BY batch_id
  `).all(excludeBatchId);
  for (const { batch_id: batchId } of batches) {
    const batch = repository.getBatch(batchId);
    const terminal = batch && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(batch.taskStatus);
    const recovery = repository.db.prepare(`
      SELECT 1 FROM background_execution_batch_recovery_states
      WHERE batch_id = ? AND state IN ('interrupted', 'recovering')
    `).get(batchId);
    const owner = terminal && !recovery && batch.taskRunId && batch.taskKey
      ? { version: 1, kind: 'file-batch', batchContext: {
          batchId: batch.id, batchNumber: batch.batchNumber, taskRunId: batch.taskRunId,
          taskKey: batch.taskKey, moduleId: batch.moduleId, parentRunId: batch.parentRunId,
          operationKey: batch.operationKey
        } }
      : null;
    const completion = owner && repository.getOwnerTerminalCompletion(owner);
    const task = completion && repository.getTaskRun(batch.taskRunId);
    for (const artifact of repository.listArtifacts(batchId)) {
      if (!artifact.sourcePath) continue;
      // ready 只是文件状态；原 owner 尚未收口或恢复中的引用继续硬保护。
      const target = completion && completion.archiveInstanceId === repository.getArchiveInstanceId()
        && completion.batchId === batch.id && stableSerialize(completion.owner) === stableSerialize(owner)
        && completion.terminalStatus === batch.taskStatus
        && task?.status === batch.taskStatus && artifact.status === 'ready' && artifact.blob
        && ['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey']
          .every((field) => task[field] === batch[field])
        && ownArtifacts.some((own) => samePersistedSource(persistedSourceMetadata(own), persistedSourceMetadata(artifact)))
        ? sharedPaths : protectedPaths;
      target.push(artifact.sourcePath);
    }
  }
  return { protectedPaths, sharedPaths };
}

function createPositionOwnedDeleteSourceResolver({ userDataPath, fsImpl = fs, protectedPathProvider, reportReferenceProvider } = {}) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('userDataPath 必须是配置中的绝对路径');
  }
  const userDataRoot = path.resolve(userDataPath);
  const applicationRunRoot = path.join(userDataRoot, 'run-data');
  const positionRunRoot = path.join(applicationRunRoot, 'position-reconciliation');
  const stagingRoot = path.join(userDataRoot, ...STAGING_PARTS);

  function parseSourcePath(sourcePath, reportSource = false) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '平盘暂存来源路径证据非法');
    }
    const resolved = path.resolve(sourcePath);
    const relative = path.relative(stagingRoot, resolved);
    const parts = relative.split(path.sep);
    if (!inside(stagingRoot, resolved) || parts.length !== 3
        || !JOB_ID_RE.test(parts[0]) || ['.', '..'].includes(parts[0])
        || (reportSource ? parts[1] !== 'anomaly-report' || path.extname(parts[2]).toLowerCase() !== '.xlsx'
          : !/^[1-9][0-9]*$/.test(parts[1]) || !Number.isSafeInteger(Number(parts[1])))
        || !parts[2] || ['.', '..'].includes(parts[2])
        || sourcePath.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
      failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '暂存来源不符合已登记的平盘导入目录结构');
    }
    return { sourcePath: resolved, managedRelativePath: parts.join('/'), parts };
  }

  async function directoryChain(relativePath) {
    const components = [...STAGING_PARTS, ...relativePath.split('/').slice(0, -1)];
    const chain = [];
    let current = userDataRoot;
    let rootRealPath = '';
    for (let index = -1; index < components.length; index += 1) {
      if (index >= 0) current = path.join(current, components[index]);
      let stat;
      try { stat = await fsImpl.promises.lstat(current); } catch (error) {
        if (error.code === 'ENOENT' && index >= STAGING_PARTS.length) {
          return { chain, missing: true, rootRealPath };
        }
        if (error.code === 'ENOENT') {
          failure('ARCHIVE_DELETE_SOURCE_ROOT_UNAVAILABLE', '平盘受管暂存根不可访问，无法确认文件已删除');
        }
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        failure('ARCHIVE_DELETE_SOURCE_PATH_UNSAFE', '平盘暂存路径含符号链接、目录联接或非目录对象');
      }
      const realPath = await fsImpl.promises.realpath(current);
      if (index === -1) rootRealPath = realPath;
      else if (realPath !== path.join(rootRealPath, ...components.slice(0, index + 1))) {
        failure('ARCHIVE_DELETE_SOURCE_PATH_UNSAFE', '平盘暂存路径的真实父目录不匹配');
      }
      chain.push({ path: current, realPath, ...objectIdentity(stat) });
    }
    return { chain, missing: false, rootRealPath };
  }

  async function sourceProtection(batch, artifacts, sourcePath, { allowShared = false } = {}) {
    if (typeof protectedPathProvider !== 'function') {
      failure('ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE', '平盘暂存文件引用清单不可用');
    }
    let values;
    try { values = await protectedPathProvider({ batch, artifacts }); } catch (_error) {
      failure('ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE', '无法核对平盘活动任务及恢复引用');
    }
    const protectedPaths = Array.isArray(values) ? values : values?.protectedPaths;
    const sharedPaths = Array.isArray(values) ? [] : values?.sharedPaths;
    if (![protectedPaths, sharedPaths].every((paths) => Array.isArray(paths)
        && paths.every((value) => typeof value === 'string' && path.isAbsolute(value)))) {
      failure('ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE', '平盘暂存文件引用清单格式非法');
    }
    const reportArtifacts = artifacts.filter((artifact) => artifact.direction === 'output');
    let reportPaths = [];
    if (reportArtifacts.length) {
      try {
        if (typeof reportReferenceProvider !== 'function') throw new Error('报告引用核验缺失');
        reportPaths = await reportReferenceProvider({ batch, artifacts: reportArtifacts });
        if (!Array.isArray(reportPaths) || reportPaths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
          throw new Error('报告引用清单非法');
        }
      } catch (_error) {
        failure('ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE', '无法核对平盘报告的活动业务及历史运行引用');
      }
    }
    let canonicalSource = null;
    const matches = async (value) => {
      const protectedPath = path.resolve(value);
      if (inside(protectedPath, sourcePath) || inside(sourcePath, protectedPath)) {
        return true;
      }
      // 其他批次可能通过真实路径或目录别名引用同一文件，不能只比较路径字符串。
      try {
        if (canonicalSource === null) canonicalSource = await fsImpl.promises.realpath(sourcePath);
        const canonicalProtected = await fsImpl.promises.realpath(protectedPath);
        if (inside(canonicalProtected, canonicalSource) || inside(canonicalSource, canonicalProtected)) {
          return true;
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
          failure('ARCHIVE_DELETE_SOURCE_REFERENCES_UNAVAILABLE', '无法核对保护路径的真实对象');
        }
      }
      return false;
    };
    for (const value of protectedPaths.concat(reportPaths)) {
      if (await matches(value)) {
        failure('ARCHIVE_DELETE_SOURCE_HELD', '平盘暂存输入仍被活动任务或恢复流程持有');
      }
    }
    for (const value of sharedPaths) {
      if (!await matches(value)) continue;
      if (!allowShared) failure('ARCHIVE_DELETE_SOURCE_HELD', '原删除计划的暂存输入已被其他批次持有');
      return true;
    }
    return false;
  }

  async function resolver(batch, artifacts) {
    const candidates = (Array.isArray(artifacts) ? artifacts : []).filter((artifact) => (
      typeof artifact.sourcePath === 'string' && artifact.sourcePath
      && (inside(positionRunRoot, path.resolve(artifact.sourcePath))
        || (batch?.moduleId === MODULE_ID && inside(applicationRunRoot, path.resolve(artifact.sourcePath))))
    ));
    const entries = [];
    for (const artifact of candidates) {
      const reportSource = artifact.direction === 'output';
      if (batch?.moduleId !== MODULE_ID || artifact.batchId !== batch.id
          || !Number.isSafeInteger(batch.id) || batch.id < 1
          || !Number.isSafeInteger(artifact.id) || artifact.id < 1
          || !SOURCE_OPERATIONS.has(artifact.sourceOperation)
          || (reportSource ? artifact.role !== 'output'
            || artifact.sourceOperation !== 'position-reconciliation:source:prepare-import'
            || artifact.metadata?.preGeneratedOutput?.version !== 1
            || artifact.metadata?.preGeneratedOutput?.kind !== 'position-anomaly-report'
            || artifact.metadata?.targetSnapshot?.exists !== true
            || !positionReportSourceIdentity(artifact.sourcePath, artifact.metadata.preGeneratedOutput.producerArtifactKey)
            : artifact.direction !== 'input')) {
        failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '应用暂存来源缺少匹配的平盘输入归属记录');
      }
      const parsed = parseSourcePath(artifact.sourcePath, reportSource);
      const evidence = sourceEvidence(persistedSourceMetadata(artifact));
      await sourceProtection(batch, artifacts, parsed.sourcePath, { allowShared: true });
      const before = await directoryChain(parsed.managedRelativePath);
      if (!before.missing) {
        let stat;
        try { stat = await fsImpl.promises.lstat(parsed.sourcePath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink()) {
            failure('ARCHIVE_DELETE_SOURCE_PATH_UNSAFE', '平盘暂存删除目标必须为已登记的普通文件');
          }
          if (!sourceSnapshotMatchesStat(evidence.sourceSnapshot, stat)) {
            failure('ARCHIVE_DELETE_SOURCE_CHANGED', '平盘暂存文件与业务读取时的对象快照不一致');
          }
          const digest = crypto.createHash('sha256');
          let sizeBytes = 0;
          for await (const chunk of fsImpl.createReadStream(parsed.sourcePath)) {
            digest.update(chunk);
            sizeBytes += chunk.length;
          }
          const after = await fsImpl.promises.lstat(parsed.sourcePath);
          if (!sourceSnapshotMatchesStat(evidence.sourceSnapshot, after)
              || sizeBytes !== evidence.expectedSizeBytes
              || digest.digest('hex') !== evidence.expectedSha256) {
            failure('ARCHIVE_DELETE_SOURCE_CHANGED', '平盘暂存文件内容或读取期间对象身份发生变化');
          }
        }
      }
      const after = await directoryChain(parsed.managedRelativePath);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        failure('ARCHIVE_DELETE_SOURCE_CHANGED', '核对期间平盘暂存父目录发生变化');
      }
      const shared = await sourceProtection(batch, artifacts, parsed.sourcePath, { allowShared: true });
      // 其他已收口批次仍保存同源关系时保留原来源，由最后一个持有者清理。
      // 即使共享也先核验原身份，不能借共享关系跳过同路径替代对象的诊断。
      if (shared) continue;
      entries.push({
        artifactId: artifact.id,
        managedRelativePath: parsed.managedRelativePath,
        rootDir: stagingRoot,
        expectedSha256: evidence.expectedSha256,
        sourceSnapshot: evidence.sourceSnapshot,
        ownerProof: {
          moduleId: batch.moduleId, batchId: batch.id, artifactId: artifact.id,
          sourcePath: artifact.sourcePath, sourceOperation: artifact.sourceOperation,
          ...(reportSource ? { sourceKind: 'position-anomaly-report',
            operationKey: batch.operationKey, artifactKey: artifact.artifactKey,
            producerArtifactKey: artifact.metadata.preGeneratedOutput.producerArtifactKey } : {}),
          ...evidence
        }
      });
    }
    return entries;
  }

  resolver.assertDeletionTargetReady = async (item) => {
    const proof = item && item.sourceOwnerProof;
    if (!proof || proof.moduleId !== MODULE_ID || !SOURCE_OPERATIONS.has(proof.sourceOperation)
        || !Number.isSafeInteger(proof.batchId) || proof.batchId < 1
        || !Number.isSafeInteger(proof.artifactId) || proof.artifactId < 1
        || item.sourceArtifactId !== proof.artifactId
        || item.managedRootIdentity?.rootDir !== stagingRoot) {
      failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '持久删除目标的平盘来源或配置根身份不匹配');
    }
    const reportSource = proof.sourceKind === 'position-anomaly-report';
    if (proof.sourceKind !== undefined && (!reportSource
        || proof.sourceOperation !== 'position-reconciliation:source:prepare-import'
        || typeof proof.operationKey !== 'string' || !proof.operationKey
        || typeof proof.artifactKey !== 'string' || !proof.artifactKey
        || !positionReportSourceIdentity(proof.sourcePath, proof.producerArtifactKey))) {
      failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '持久报告来源缺少原业务及 artifact 身份');
    }
    const parsed = parseSourcePath(proof.sourcePath, reportSource);
    if (parsed.managedRelativePath !== item.managedRelativePath) {
      failure('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '持久删除目标与原暂存路径不匹配');
    }
    sourceEvidence(proof);
    const checked = await directoryChain(parsed.managedRelativePath);
    const actualRoot = checked.chain.find((entry) => entry.path === stagingRoot);
    if (!actualRoot || ['realPath', 'dev', 'ino'].some((field) => (
      actualRoot[field] !== item.managedRootIdentity[field]
    ))) {
      failure('ARCHIVE_DELETE_SOURCE_ROOT_UNAVAILABLE', '平盘受管暂存根与持久删除计划身份不一致');
    }
    await sourceProtection({ id: proof.batchId, moduleId: proof.moduleId, operationKey: proof.operationKey },
      reportSource ? [{ direction: 'output', sourcePath: proof.sourcePath,
        sourceOperation: proof.sourceOperation, artifactKey: proof.artifactKey,
        metadata: { preGeneratedOutput: { producerArtifactKey: proof.producerArtifactKey } } }] : [], parsed.sourcePath);
  };
  return resolver;
}

module.exports = { createPositionOwnedDeleteSourceResolver, positionDeleteSourceReferences };
