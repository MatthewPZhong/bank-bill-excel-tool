'use strict';

const { identityInteger, readIdentityStat, readIdentityStatSync } = require('./filesystem-identity');

const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeSourceSnapshot, sourceSnapshotMatchesStat } = require('./source-snapshot');
const { stableSerialize } = require('../../backend/database/archive-terminal-completion');

const COMPLETE_STATES = new Set(['deleted', 'already-missing', 'preserved-shared']);

function fail(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.deleteDetails = { status: ({ ARCHIVE_BATCH_ACTIVE: 'active', ARCHIVE_BATCH_LOCKED: 'locked',
    ARCHIVE_BATCH_BUSINESS_HELD: 'business-held', ARCHIVE_BATCH_RECOVERY_ACTIVE: 'recovery-active',
    ARCHIVE_BATCH_NOT_FOUND: 'not-found' })[code] || 'blocked', ...detail };
  throw error;
}

function objectIdentity(stat) {
  if (!stat || !identityInteger(stat.dev) || !identityInteger(stat.ino)) {
    fail('ARCHIVE_DELETE_IDENTITY_UNAVAILABLE', '当前文件系统无法提供可靠的存档对象身份');
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameObject(left, stat) {
  const right = objectIdentity(stat);
  return left.dev === right.dev && left.ino === right.ino;
}

function managedPath(service, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\')
      || path.isAbsolute(relativePath)
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('ARCHIVE_DELETE_PATH_INVALID', '永久删除计划包含非法受管路径');
  }
  return service._resolveManagedRelative(relativePath);
}

async function rootIdentity(service) {
  await service._assertManagedRoot();
  const stat = await readIdentityStat(service.fs, service.rootDir);
  return {
    rootDir: service.rootDir,
    realPath: await service.fs.promises.realpath(service.rootDir),
    ...objectIdentity(stat)
  };
}

async function assertRoot(service, expected) {
  const actual = await rootIdentity(service);
  if (!expected || expected.rootDir !== actual.rootDir || expected.realPath !== actual.realPath
      || expected.dev !== actual.dev || expected.ino !== actual.ino) {
    fail('ARCHIVE_DELETE_ROOT_CHANGED', '存档根身份发生变化，删除未完成');
  }
}

async function digestFile(service, filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of service.fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function captureFileIdentity(service, relativePath, evidence = {}) {
  const filePath = managedPath(service, relativePath);
  await service._assertManagedRoot();
  const parents = [];
  const parts = relativePath.split('/');
  let current = service.rootDir;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await readIdentityStat(service.fs, current); } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, parents };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('ARCHIVE_PATH_SYMLINK_REJECTED', '存档路径包含链接或非目录对象');
    }
    parents.push({ relativePath: parts.slice(0, index + 1).join('/'), ...objectIdentity(stat) });
  }
  let stat;
  try { stat = await readIdentityStat(service.fs, filePath); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, parents };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ARCHIVE_PATH_SYMLINK_REJECTED', '删除目标必须是已登记的普通文件');
  }
  if (evidence.requireFingerprint && !normalizeSourceSnapshot(evidence.fingerprint)?.ino) {
    fail('ARCHIVE_DELETE_OWNER_IDENTITY_MISSING', '存档文件缺少持久对象身份，保留文件等待原任务恢复');
  }
  if (evidence.fingerprint && !sourceSnapshotMatchesStat(evidence.fingerprint, stat)) {
    fail('ARCHIVE_DELETE_FILE_CHANGED', '存档文件已被修改或替换，不能删除当前对象');
  }
  const identity = {
    exists: true, ...objectIdentity(stat), sizeBytes: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs),
    birthtimeMs: Number(stat.birthtimeMs), nlink: Number(stat.nlink), mode: Number(stat.mode), parents
  };
  const sha256 = await digestFile(service, filePath);
  const after = await readIdentityStat(service.fs, filePath);
  if (!sameObject(identity, after) || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || after.birthtimeMs !== stat.birthtimeMs || after.nlink !== stat.nlink || after.mode !== stat.mode
      || (evidence.sha256 && evidence.sha256 !== sha256)) {
    fail('ARCHIVE_DELETE_FILE_CHANGED', '存档文件身份或内容不再匹配，不能删除当前对象');
  }
  return { ...identity, sha256 };
}

function batchRevision(service, batch, artifacts, temps) {
  return crypto.createHash('sha256').update(JSON.stringify({
    batch, rootDir: service.rootDir, rootIdentity: objectIdentity(readIdentityStatSync(service.fs, service.rootDir)),
    archiveInstanceId: service.archiveInstanceId,
    artifacts: artifacts.map((artifact) => ({
      ...artifact, holds: service.repository.listArtifactHolds(artifact.id)
    })),
    temps
  })).digest('hex');
}

function assertBatchDeletable(service, batch) {
  if (!batch) fail('ARCHIVE_BATCH_NOT_FOUND', '存档批次不存在');
  if (['reserved', 'running'].includes(batch.taskStatus)) {
    fail('ARCHIVE_BATCH_ACTIVE', '批次任务仍在执行，暂不能删除');
  }
  if (batch.locked) fail('ARCHIVE_BATCH_LOCKED', '批次已锁定，请先解除锁定');
  const artifacts = service.repository.listArtifacts(batch.id);
  const held = artifacts.filter((artifact) => service.repository.listArtifactHolds(artifact.id).length);
  if (held.length) {
    fail('ARCHIVE_BATCH_BUSINESS_HELD', '批次输入文件仍被当前有效业务数据引用，不能删除',
      { artifactIds: held.map((artifact) => artifact.id) });
  }
  // Repository 在事务中再次校验恢复 overlay，此处用于只读预检。
  const overlay = service.repository.db.prepare(`
    SELECT * FROM background_execution_batch_recovery_states
    WHERE batch_id = ? AND task_run_id = ?
  `).get(batch.id, batch.taskRunId);
  if (overlay && ['interrupted', 'recovering'].includes(overlay.state)) {
    fail('ARCHIVE_BATCH_RECOVERY_ACTIVE', '批次仍处于中断或恢复处理中，暂不能删除', {
      recoveryState: { state: overlay.state, finalOutcome: overlay.final_outcome || null,
        recoveryAttemptId: overlay.recovery_attempt_id || null, sourceKind: overlay.source_kind,
        sourceRef: overlay.source_ref, updatedAt: overlay.updated_at, resolvedAt: overlay.resolved_at || null }
    });
  }
  return artifacts;
}

async function buildDeletePlan(service, batchId, options = {}) {
  if (service.assertDeleteAllowed) await service.assertDeleteAllowed(options);
  const batch = service.repository.getBatch(batchId);
  const artifacts = assertBatchDeletable(service, batch);
  const temps = service.repository.listOwnedTemporaryFiles(batchId);
  const revision = batchRevision(service, batch, artifacts, temps);
  if (options.expectedRevision && revision !== options.expectedRevision) {
    fail('ARCHIVE_DELETE_CONFIRMATION_STALE', '批次状态或文件清单已变化，请重新确认');
  }
  const root = await rootIdentity(service);
  const items = [];
  const paths = new Set();
  const add = async (kind, relativePath, evidence, extra = {}) => {
    if (!relativePath || paths.has(relativePath)) return;
    paths.add(relativePath);
    const expectedIdentity = await captureFileIdentity(service, relativePath, {
      ...evidence, requireFingerprint: ['materialized', 'blob'].includes(kind)
    });
    items.push({ itemId: crypto.randomUUID(), kind, managedRelativePath: relativePath,
      expectedIdentity, state: 'pending', ...extra });
  };
  for (const temp of temps) {
    if (temp.state === 'creating') {
      const identity = await captureFileIdentity(service, temp.managedRelativePath);
      const creatorIdentity = temp.expectedIdentity || temps.find((candidate) =>
        candidate.managedRelativePath === `${temp.managedRelativePath}.tmp`)?.expectedIdentity;
      if (identity.exists && (!creatorIdentity?.exists
          || identity.dev !== creatorIdentity.dev || identity.ino !== creatorIdentity.ino
          || JSON.stringify(identity.parents) !== JSON.stringify(creatorIdentity.parents))) {
        fail('ARCHIVE_DELETE_TEMP_OWNER_PENDING', '受管临时文件尚未完成归属登记，请先完成原任务恢复');
      }
    }
    if (temp.state === 'ready') {
      const current = await captureFileIdentity(service, temp.managedRelativePath);
      const expected = temp.expectedIdentity;
      if (current.exists && (!expected?.exists || current.dev !== expected.dev
          || current.ino !== expected.ino
          || JSON.stringify(current.parents) !== JSON.stringify(expected.parents))) {
        fail('ARCHIVE_DELETE_FILE_CHANGED', '受管临时文件与登记对象身份不一致');
      }
    }
    await add('owned-temp', temp.managedRelativePath, {
      sha256: temp.state === 'ready' ? temp.expectedIdentity?.sha256 : null,
      fingerprint: temp.state === 'ready' && temp.expectedIdentity?.exists ? {
        sizeBytes: temp.expectedIdentity.sizeBytes, mtimeMs: temp.expectedIdentity.mtimeMs,
        ctimeMs: temp.expectedIdentity.ctimeMs, ino: temp.expectedIdentity.ino
      } : null
    }, { ownerId: temp.id });
  }
  for (const artifact of artifacts) {
    await add('materialized', artifact.storageRelativePath, {
      sha256: artifact.blob?.sha256, fingerprint: artifact.storageFingerprint
    });
  }
  for (const artifact of artifacts) {
    if (artifact.blob) await add('blob', artifact.blob.relativePath, {
      sha256: artifact.blob.sha256, fingerprint: artifact.blob.fingerprint
    }, { sha256: artifact.blob.sha256 });
  }
  if (service.resolveOwnedDeleteSources) {
    const sources = await service.resolveOwnedDeleteSources(batch, artifacts);
    for (const source of sources) {
      const scoped = serviceAtManagedRoot(service, { rootDir: source.rootDir });
      const managedRootIdentity = await rootIdentity(scoped);
      const expectedIdentity = await captureFileIdentity(scoped, source.managedRelativePath, {
        sha256: source.expectedSha256, fingerprint: source.sourceSnapshot
      });
      items.push({ itemId: crypto.randomUUID(), kind: 'owned-temp', sourceArtifactId: source.artifactId,
        managedRelativePath: source.managedRelativePath, managedRootIdentity,
        sourceOwnerProof: source.ownerProof, expectedIdentity, state: 'pending' });
    }
  }
  await assertRoot(service, root);
  const current = service.repository.getBatch(batchId);
  if (!current || batchRevision(service, current, service.repository.listArtifacts(batchId),
    service.repository.listOwnedTemporaryFiles(batchId)) !== revision) {
    fail('ARCHIVE_DELETE_CONFIRMATION_STALE', '批次状态或文件清单已变化，请重新确认');
  }
  const plan = {
    version: 2, deletionId: crypto.randomUUID(),
    archiveInstanceId: service.archiveInstanceId,
    batchId: batch.id, batchNumber: batch.batchNumber, localDate: batch.localDate,
    moduleId: batch.moduleId, origin: options.origin || 'manual', sourcePolicy: 'managed-only',
    rootIdentity: root, batchRevision: revision, items, createdAt: service.now().toISOString()
  };
  service.repository.assertNoPendingHardlinkDeleteConflicts(plan);
  return plan;
}

async function upgradeLegacyDeletePlan(service, job) {
  if (job.planError) fail('ARCHIVE_DELETE_PLAN_INVALID', '旧清理任务损坏，保留任务等待诊断');
  const items = [];
  const paths = new Set();
  for (const relativePath of job.materializedPaths) {
    if (!relativePath.startsWith(`${job.layoutRelativeDir}/`)) {
      fail('ARCHIVE_DELETE_PATH_INVALID', '旧清理计划路径不属于原批次目录');
    }
    if (paths.has(relativePath)) continue;
    paths.add(relativePath);
    const expectedIdentity = await captureFileIdentity(service, relativePath);
    if (expectedIdentity.exists) {
      fail('ARCHIVE_DELETE_LEGACY_IDENTITY_MISSING', '旧计划的目录文件缺少原始对象身份，保留任务等待诊断');
    }
    items.push({ itemId: crypto.randomUUID(), kind: 'materialized', managedRelativePath: relativePath,
      expectedIdentity, state: 'pending' });
  }
  for (const blob of job.releasedBlobs) {
    if (paths.has(blob.relativePath)) continue;
    paths.add(blob.relativePath);
    const expectedIdentity = await captureFileIdentity(service, blob.relativePath, { sha256: blob.sha256 });
    if (expectedIdentity.exists) {
      fail('ARCHIVE_DELETE_LEGACY_IDENTITY_MISSING', '旧计划的内容文件缺少原始对象身份，保留任务等待诊断');
    }
    items.push({ itemId: crypto.randomUUID(), kind: 'blob', managedRelativePath: blob.relativePath,
      sha256: blob.sha256, expectedIdentity, state: 'pending' });
  }
  return service.repository.upgradeCleanupJobPlan(job.id, {
    version: 2, deletionId: crypto.randomUUID(), archiveInstanceId: service.archiveInstanceId,
    batchId: job.batchId, batchNumber: job.batchNumber, localDate: job.localDate,
    moduleId: 'legacy-archive', origin: 'legacy-recovery', sourcePolicy: 'managed-only',
    rootIdentity: await rootIdentity(service), batchRevision: `legacy-${job.id}-${job.updatedAt}`,
    items, createdAt: job.createdAt
  });
}

function serviceAtManagedRoot(service, root) {
  if (!root) return service;
  const scoped = Object.create(service);
  scoped.rootDir = root.rootDir;
  return scoped;
}

function sameFileIdentity(expected, actual) {
  return expected.exists && actual.exists && actual.dev === expected.dev && actual.ino === expected.ino
    && actual.sizeBytes === expected.sizeBytes && actual.mtimeMs === expected.mtimeMs
    && (expected.birthtimeMs === undefined || actual.birthtimeMs === expected.birthtimeMs)
    && (expected.mode === undefined || actual.mode === expected.mode)
    && JSON.stringify(actual.parents) === JSON.stringify(expected.parents);
}

function immutableDeletePlan(plan) {
  return { ...plan, items: plan.items.map((item) => {
    const { state: _state, lastErrorCode: _code, lastErrorMessage: _message, ...target } = item;
    return target;
  }) };
}

function matchesRepublishedDeletedBlob(service, plan, sibling, actual, jobId) {
  const expected = sibling.expectedIdentity;
  if (sibling.kind !== 'blob' || sibling.managedRootIdentity || !actual.exists
      || (actual.dev === expected.dev && actual.ino === expected.ino)
      || stableSerialize(actual.parents) !== stableSerialize(expected.parents)) return false;
  // 新对象只能解释同一原计划中已持久完成的 unlink；循环内进度和其他完成状态不作证明。
  const durableJob = service.repository.getCleanupJob(jobId);
  if (!durableJob || durableJob.planError || durableJob.planVersion !== 2
      || stableSerialize(immutableDeletePlan(durableJob.plan)) !== stableSerialize(immutableDeletePlan(plan))
      || durableJob.plan.items.find((item) => item.itemId === sibling.itemId)?.state !== 'deleted') return false;
  const referenced = service.repository.findReferencedBlob({
    sha256: expected.sha256, relativePath: sibling.managedRelativePath
  });
  const fingerprint = normalizeSourceSnapshot(referenced?.fingerprint);
  return referenced?.relativePath === sibling.managedRelativePath
    && referenced.sha256 === expected.sha256 && fingerprint?.ino
    && ['ino', 'sizeBytes', 'mtimeMs', 'ctimeMs'].every((field) => fingerprint[field] === actual[field]);
}

async function matchesRemovedHardlinks(service, plan, item, actual, jobId) {
  const expected = item.expectedIdentity;
  // 只有冻结计划中的原始硬链接组可解释 unlink 引起的 ctime 变化；旧计划不能补造 nlink。
  if (!['materialized', 'blob'].includes(item.kind) || item.managedRootIdentity
      || !Number.isSafeInteger(expected.nlink) || expected.nlink < 2
      || !Number.isFinite(expected.birthtimeMs) || expected.birthtimeMs <= 0
      || actual.birthtimeMs !== expected.birthtimeMs || actual.nlink >= expected.nlink) return false;
  const siblings = plan.items.filter((candidate) => {
    const identity = candidate.expectedIdentity;
    return candidate.itemId !== item.itemId && ['materialized', 'blob'].includes(candidate.kind)
      && !candidate.managedRootIdentity && identity.exists && identity.dev === expected.dev
      && identity.ino === expected.ino && identity.nlink === expected.nlink
      && identity.birthtimeMs === expected.birthtimeMs && identity.mode === expected.mode
      && identity.sha256 === expected.sha256
      && identity.sizeBytes === expected.sizeBytes && identity.mtimeMs === expected.mtimeMs
      && identity.ctimeMs === expected.ctimeMs;
  });
  let missingLinks = 0;
  for (const sibling of siblings) {
    const identity = await captureFileIdentity(service, sibling.managedRelativePath,
      { sha256: expected.sha256 });
    if (!identity.exists) {
      if (!identity.parents.every((parent) => sibling.expectedIdentity.parents.some((prior) =>
        parent.relativePath === prior.relativePath && parent.dev === prior.dev && parent.ino === prior.ino))) return false;
      missingLinks += 1;
    } else if (matchesRepublishedDeletedBlob(service, plan, sibling, identity, jobId)) {
      // 原 Blob 的链接已删除，当前位置已由另一有效引用持有；不删除或改写这个新 inode。
      missingLinks += 1;
    } else if (!sameFileIdentity(sibling.expectedIdentity, identity)
        || identity.ctimeMs !== actual.ctimeMs || identity.nlink !== actual.nlink) return false;
  }
  return missingLinks > 0 && actual.nlink === expected.nlink - missingLinks;
}

async function removeItem(service, plan, item, jobId) {
  await assertRoot(service, plan.rootIdentity);
  const scoped = serviceAtManagedRoot(service, item.managedRootIdentity);
  const sourceGuard = service.resolveOwnedDeleteSources?.assertDeletionTargetReady;
  if (item.sourceArtifactId) {
    if (typeof sourceGuard !== 'function') fail('ARCHIVE_DELETE_SOURCE_OWNER_UNKNOWN', '受管源清理适配不可用');
    await sourceGuard(item);
  }
  if (item.managedRootIdentity) await assertRoot(scoped, item.managedRootIdentity);
  const expected = item.expectedIdentity;
  const sharedTargets = item.kind === 'blob' ? plan.items.filter((candidate) =>
    candidate.kind === 'materialized' && !candidate.managedRootIdentity
      && candidate.expectedIdentity.exists && candidate.expectedIdentity.dev === expected.dev
      && candidate.expectedIdentity.ino === expected.ino) : [];
  // 普通 copy 的旧 Blob 被新批次重新引用时仍直接保留；硬链接组还须完成原 inode 的指纹收口。
  if (item.kind === 'blob' && !sharedTargets.length && service.repository.findReferencedBlob({
    sha256: item.sha256 || expected.sha256, relativePath: item.managedRelativePath
  })) return 'preserved-shared';
  const actual = await captureFileIdentity(scoped, item.managedRelativePath,
    { sha256: expected.sha256 });
  if (item.kind === 'blob' && sharedTargets.length && actual.exists
      && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
    const referenced = service.repository.findReferencedBlob({
      sha256: item.sha256 || expected.sha256, relativePath: item.managedRelativePath
    });
    const fingerprint = normalizeSourceSnapshot(referenced?.fingerprint);
    if (referenced?.relativePath === item.managedRelativePath && referenced.sha256 === expected.sha256
        && fingerprint?.ino && ['ino', 'sizeBytes', 'mtimeMs', 'ctimeMs']
          .every((field) => fingerprint[field] === actual[field])
        && sharedTargets.every((target) => COMPLETE_STATES.has(target.state))) {
      for (const target of sharedTargets) {
        // 已完成项不会再次删除；仍要确认原 inode 没有重新出现在原目录路径。
        const current = await captureFileIdentity(service, target.managedRelativePath);
        if (current.exists && current.dev === expected.dev && current.ino === expected.ino) {
          fail('ARCHIVE_DELETE_HARDLINKS_PENDING', '原批次目录中仍有待清理的原始硬链接');
        }
      }
      await assertRoot(service, plan.rootIdentity);
      return 'preserved-shared';
    }
  }
  if (!actual.exists) {
    for (const parent of actual.parents) {
      const prior = expected.parents.find((entry) => entry.relativePath === parent.relativePath);
      if (!prior || prior.dev !== parent.dev || prior.ino !== parent.ino) {
        fail('ARCHIVE_DELETE_FILE_CHANGED', '原文件缺失但父目录身份发生变化');
      }
    }
    await assertRoot(service, plan.rootIdentity);
    return 'already-missing';
  }
  if (!sameFileIdentity(expected, actual)
      || ((actual.ctimeMs !== expected.ctimeMs
        || (expected.nlink !== undefined && actual.nlink !== expected.nlink))
        && !await matchesRemovedHardlinks(service, plan, item, actual, jobId))) {
    fail('ARCHIVE_DELETE_FILE_CHANGED', '删除目标或父目录已被替换，原计划保持待处理');
  }
  if (item.sourceArtifactId) await sourceGuard(item);
  const filePath = managedPath(scoped, item.managedRelativePath);
  // 在同一根串行队列内复核；同步最后核验和 unlink 避免应用自身异步回调夹入。
  // OS 级外部写入者无法由路径 API 原子排除，不能把此处称为原子身份删除。
  const fsImpl = service.fs;
  const rootStat = readIdentityStatSync(fsImpl, service.rootDir);
  if (rootStat.isSymbolicLink() || !sameObject(plan.rootIdentity, rootStat)) {
    fail('ARCHIVE_DELETE_ROOT_CHANGED', '存档根身份发生变化');
  }
  for (const parent of expected.parents) {
    const stat = readIdentityStatSync(fsImpl, managedPath(scoped, parent.relativePath));
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameObject(parent, stat)) {
      fail('ARCHIVE_DELETE_FILE_CHANGED', '删除目标父目录发生变化');
    }
  }
  if (item.managedRootIdentity) {
    const managedStat = readIdentityStatSync(fsImpl, scoped.rootDir);
    if (managedStat.isSymbolicLink() || !managedStat.isDirectory()
        || !sameObject(item.managedRootIdentity, managedStat)) {
      fail('ARCHIVE_DELETE_ROOT_CHANGED', '受管暂存根身份发生变化');
    }
  }
  const finalStat = readIdentityStatSync(fsImpl, filePath);
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || !sameObject(expected, finalStat)
      || finalStat.size !== expected.sizeBytes || finalStat.mtimeMs !== expected.mtimeMs
      || finalStat.ctimeMs !== actual.ctimeMs
      || finalStat.nlink !== actual.nlink || finalStat.birthtimeMs !== actual.birthtimeMs
      || finalStat.mode !== actual.mode) {
    fail('ARCHIVE_DELETE_FILE_CHANGED', '删除目标在最后核验时发生变化');
  }
  if (item.kind === 'blob' && service.repository.findReferencedBlob({
    sha256: item.sha256 || expected.sha256, relativePath: item.managedRelativePath
  })) {
    if (sharedTargets.some((candidate) => !COMPLETE_STATES.has(candidate.state))) {
      fail('ARCHIVE_DELETE_HARDLINKS_PENDING', '共享内容的原批次目录文件尚未全部清理');
    }
    if (actual.nlink !== expected.nlink) {
      service.repository.refreshReferencedHardlinkFingerprints(jobId, item.itemId, actual);
    }
    return 'preserved-shared';
  }
  fsImpl.unlinkSync(filePath);
  return 'deleted';
}

async function executeDeletePlan(service, job, options = {}) {
  const plan = job.plan;
  if (job.planError || !plan || plan.version !== 2 || plan.sourcePolicy !== 'managed-only') {
    fail('ARCHIVE_DELETE_PLAN_INVALID', '永久删除计划损坏或版本不支持，保留任务等待诊断');
  }
  if (plan.archiveInstanceId !== service.archiveInstanceId) {
    fail('ARCHIVE_DELETE_INSTANCE_CHANGED', '删除计划与当前存档实例不一致');
  }
  if (job.state === 'waiting-migration') {
    return { ok: false, status: 'waiting-migration', failures: [{ code: 'ARCHIVE_DELETE_WAITING_MIGRATION' }] };
  }
  const context = service.getDeleteMigrationContext && await service.getDeleteMigrationContext();
  if (context && !options.waitForMigration) {
    fail('ARCHIVE_STORAGE_MIGRATION_PENDING', '存档迁移尚未收口，删除任务由迁移恢复流程接管');
  }
  const failures = [];
  let deletedMaterializedFiles = 0;
  let deletedBlobFiles = 0;
  let releasedBytes = 0;
  for (const item of plan.items) {
    if (COMPLETE_STATES.has(item.state)) continue;
    try {
      item.state = await removeItem(service, plan, item, job.id);
      delete item.lastErrorCode;
      delete item.lastErrorMessage;
      if (item.kind === 'blob' && item.state === 'deleted') {
        deletedBlobFiles += 1;
        releasedBytes += item.expectedIdentity.sizeBytes || 0;
      } else if (item.state === 'deleted') deletedMaterializedFiles += 1;
    } catch (error) {
      item.state = 'failed';
      item.lastErrorCode = error.code || 'ARCHIVE_DELETE_FILE_FAILED';
      item.lastErrorMessage = '受管文件清理未完成，请重试或检查存档位置';
      failures.push({ itemId: item.itemId, code: item.lastErrorCode, message: item.lastErrorMessage });
    }
    service.repository.updateCleanupJobProgress(job.id, { items: plan.items, state: failures.length ? 'failed' : 'running' });
  }
  if (!failures.length) {
    await assertRoot(service, plan.rootIdentity);
    failures.push(...await service._removeEmptyLayoutDirectories(job));
    // 只回收有归属文件所在的空目录，不递归清空其他任务。
    for (const item of plan.items.filter((entry) => entry.kind === 'owned-temp' || entry.kind === 'blob')) {
      try { await service.fs.promises.rmdir(path.dirname(managedPath(serviceAtManagedRoot(service, item.managedRootIdentity), item.managedRelativePath))); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) failures.push({ code: error.code }); }
    }
  }
  if (failures.length) service.repository.recordCleanupJobFailure(job.id, {
    code: failures[0].code, message: '批次信息已删除，受管文件清理未完成'
  });
  else if (options.waitForMigration) {
    service.repository.updateCleanupJobProgress(job.id, { items: plan.items,
      state: 'waiting-migration', migration: options.waitForMigration });
    return { ok: false, status: 'waiting-migration', failures: [], deletedMaterializedFiles, deletedBlobFiles, releasedBytes };
  } else if (!service.repository.completeCleanupJob(job.id)) {
    fail('ARCHIVE_DELETE_COMPLETION_FAILED', '删除完成凭证尚未保存');
  }
  return { ok: !failures.length, status: failures.length ? 'cleanup-pending' : 'cleaned',
    deletedMaterializedFiles, deletedBlobFiles, releasedBytes, failures };
}

module.exports = { buildDeletePlan, executeDeletePlan, captureFileIdentity, batchRevision, upgradeLegacyDeletePlan };
