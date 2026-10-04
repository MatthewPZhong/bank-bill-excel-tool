'use strict';

const path = require('node:path');
const { recoveryError, digest } = require('./worker-authority');
const observations = new WeakSet();
const PUBLIC_REASONS = new Set(['startup', 'live-handoff', 'receipt-ack', 'business-retry']);
const PERMISSIONS = new Set(['recover-uncommitted', 'observe-committed', 'ack-stage', 'ack-finalize']);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function isPublicationRecoveryObservation(observation) {
  return Boolean(observation && observations.has(observation));
}
function pathsFor(record) {
  const entry = record.indexEntry || {};
  return [record.journalPath, ...(entry.stagedAbsolutePaths || []),
    ...(entry.backupAbsolutePaths || []), ...(entry.targetAbsolutePaths || [])].filter(Boolean);
}

function createPublicationRecoveryCoordinator({ userDataDir, dispatcher, owners, acquireMemory = null } = {}) {
  const root = typeof userDataDir === 'string' && userDataDir ? path.resolve(userDataDir) : null;
  const registry = new Map();
  const invalid = () => recoveryError('PUBLICATION_RECOVERY_OWNER_REGISTRATION_INVALID', root,
    '共享发布恢复 owner 注册缺失、重复或接口不完整');
  if (!root || !dispatcher || typeof dispatcher.bindRecoveryAuthority !== 'function'
      || typeof dispatcher.runAuthorizedRecovery !== 'function' || !Array.isArray(owners) || !owners.length) throw invalid();
  for (const owner of owners) {
    if (!owner || typeof owner.id !== 'string' || !owner.id || registry.has(owner.id)
        || ['identify', 'authorize', 'acquireObservation'].some((name) => typeof owner[name] !== 'function')) throw invalid();
    registry.set(owner.id, Object.freeze({ id: owner.id, identify: owner.identify.bind(owner),
      authorize: owner.authorize.bind(owner), acquireObservation: owner.acquireObservation.bind(owner),
      verifyObservation: typeof owner.verifyObservation === 'function' ? owner.verifyObservation.bind(owner) : null }));
  }
  let bound = false;
  function requestFor(ownerId, options = {}, internal = false) {
    if ((options.userDataDir && path.resolve(options.userDataDir) !== root)
        || (options.root && path.resolve(options.root) !== root) || options.ownerId !== undefined) {
      throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '恢复调用方不能覆盖 root 或 owner');
    }
    const reason = options.reason || 'business-retry';
    if (!PUBLIC_REASONS.has(reason) && !(internal && ['publish-preflight', 'transport-error'].includes(reason))) {
      throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '恢复 reason 无效');
    }
    const normalizeIds = (value) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
        throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '恢复 taskIds 无效');
      }
      return [...new Set(value)];
    };
    const taskIds = normalizeIds(options.taskIds);
    const ackIds = normalizeIds(options.acknowledgedCommittedTaskIds);
    if (ackIds.some((id) => !taskIds.includes(id))) {
      throw recoveryError('PUBLICATION_RECOVERY_OWNER_CONFLICT', root, 'receipt ack 必须显式限定同一 taskIds');
    }
    // capability 是不可克隆的 Main 私有对象；不递归冻结其 adapter 内部状态。
    return Object.freeze({ root, ownerId, reason, taskIds: Object.freeze(taskIds),
      acknowledgedCommittedTaskIds: Object.freeze(ackIds), deferCommittedFinalization: options.deferCommittedFinalization === true,
      observation: options.observation || null, onProgress: options.onProgress });
  }
  async function acquire(request) {
    const leases = [];
    try {
      if (request.observation) {
        const validators = [...registry.values()].filter((owner) => owner.verifyObservation
          && owner.verifyObservation(request.observation, request) === true);
        if (validators.length !== 1 || typeof request.observation.verifyScope !== 'function'
            || request.observation.verifyScope(request) !== true) {
          throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, '借用 observation capability 无效或 scope 不匹配');
        }
      }
      for (const owner of registry.values()) {
        const lease = await owner.acquireObservation(request);
        if (lease === null || lease === undefined) continue;
        if (typeof lease.verifyScope !== 'function' || typeof lease.release !== 'function' || lease.verifyScope(request) !== true) {
          // acquire 的返回值已来自受信任 owner；这里只拒绝不完整合同。
          if (typeof lease.release === 'function') await lease.release('invalid-observation');
          throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, 'owner observation scope 无效');
        }
        if (!leases.includes(lease)) leases.push(lease);
      }
      // 已有 owner 观察（含借用）覆盖整个共享 Worker，不重复获取排他额度。
      // 没有 owner 活动时，由 Main 装配的 admission-only I/O owner 承担资源。
      if (leases.length === 0 && acquireMemory) {
        const memoryLease = await acquireMemory();
        if (memoryLease) leases.push(memoryLease);
      }
      const release = async (reason) => {
        for (const lease of leases.slice().reverse()) await lease.release(reason);
      };
      const configs = leases.map((lease) => lease.memoryConfig).filter(Boolean);
      // 同一观察包含多个 owner 时按最紧额度执行；能力仍由各 owner 独立核验和释放。
      Object.defineProperty(release, 'memoryConfig', { value: configs.sort((a, b) => a.phaseMemoryBytes - b.phaseMemoryBytes)[0] || null });
      return release;
    } catch (error) {
      for (const lease of leases.slice().reverse()) await lease.release('admission-failed');
      throw error;
    }
  }
  async function authorizeSnapshot(snapshot, request) {
    if (!snapshot || snapshot.root !== root || !Array.isArray(snapshot.records)) {
      throw recoveryError('PUBLICATION_RECOVERY_SNAPSHOT_CHANGED', root, '恢复 snapshot 根不匹配');
    }
    freeze(snapshot);
    const identities = [];
    // 完整识别阶段先于任何授权及执行，活动记录也必须参与 owner 冲突检测。
    for (const record of snapshot.records) {
      const matches = [];
      for (const owner of registry.values()) {
        let identity;
        try { identity = await owner.identify(record); } catch (error) {
          error.preserveTemporaryFiles = true;
          error.recoveryPaths = [...new Set([path.join(root, 'toolbox-publish-journal-index.json'), ...(error.recoveryPaths || []), ...pathsFor(record)])];
          throw error;
        }
        if (identity === 'not-owned' || identity === null || identity === undefined) continue;
        if (identity.ownerId !== owner.id || identity.publisherTaskId !== record.taskId) {
          throw recoveryError('PUBLICATION_RECOVERY_OWNER_CONFLICT', root, 'publication owner 身份字段冲突', pathsFor(record));
        }
        if (typeof identity.proofDigest !== 'string' || !identity.proofDigest
            || typeof identity.taskRunId !== 'string' || !identity.taskRunId
            || typeof identity.operationKey !== 'string' || !identity.operationKey
            || !Number.isSafeInteger(identity.batchId) || identity.batchId < 1) {
          throw recoveryError('PUBLICATION_RECOVERY_OWNER_UNKNOWN', root, 'publication owner 缺少完整归属证明', pathsFor(record));
        }
        matches.push({ owner, identity: freeze({ ...identity }) });
      }
      if (matches.length !== 1) {
        throw recoveryError(matches.length ? 'PUBLICATION_RECOVERY_OWNER_CONFLICT' : 'PUBLICATION_RECOVERY_OWNER_UNKNOWN',
          root, matches.length ? '多个 owner 声明同一 publication' : '无法证明 publication 的 owner', pathsFor(record));
      }
      identities.push({ record, ...matches[0] });
    }
    const byTask = new Map(identities.map((item) => [item.record.taskId, item]));
    for (const id of request.acknowledgedCommittedTaskIds) {
      const item = byTask.get(id);
      // 已清理 receipt 的显式 absence 仍由 owner 的原 durable proof 判定。
      if (item && item.owner.id !== request.ownerId) {
        throw recoveryError('PUBLICATION_RECOVERY_OWNER_CONFLICT', root, 'receipt ack 指向其他 owner', pathsFor(item.record));
      }
    }
    const entries = [];
    for (const { record, owner, identity } of identities) {
      let decision;
      try { decision = await owner.authorize(record, request, identity); } catch (error) {
        error.preserveTemporaryFiles = true;
        error.recoveryPaths = [...new Set([path.join(root, 'toolbox-publish-journal-index.json'), ...(error.recoveryPaths || []), ...pathsFor(record)])];
        throw error;
      }
      if (!decision || !['allow', 'defer'].includes(decision.disposition)) {
        throw recoveryError(decision && decision.code || 'PUBLICATION_RECOVERY_GRANT_INVALID', root,
          'owner 拒绝本次 publication 恢复', pathsFor(record));
      }
      if (decision.identity && digest(decision.identity) !== digest(identity)) {
        throw recoveryError('PUBLICATION_RECOVERY_OWNER_CONFLICT', root, 'owner 授权身份与发现身份不一致', pathsFor(record));
      }
      const active = snapshot.skippedActive.includes(record.taskId);
      const disposition = active ? 'defer' : decision.disposition;
      const permission = disposition === 'defer' ? null : decision.permission;
      if (disposition === 'allow' && !PERMISSIONS.has(permission)) {
        throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, 'owner permission 无效', pathsFor(record));
      }
      const acknowledged = request.ownerId === owner.id && request.acknowledgedCommittedTaskIds.includes(record.taskId);
      if (['ack-stage', 'ack-finalize'].includes(permission)
          && (!acknowledged || (permission === 'ack-stage') !== request.deferCommittedFinalization)) {
        throw recoveryError('PUBLICATION_RECOVERY_GRANT_INVALID', root, 'receipt cleanup 未获得对应阶段授权', pathsFor(record));
      }
      entries.push({ taskId: record.taskId, recordDigest: record.recordDigest, ownerId: owner.id,
        identity, disposition, permission, acknowledged, active, code: decision.code });
    }
    return freeze({ root, indexDigest: snapshot.indexDigest, entries });
  }
  function complete(snapshot, result, request) {
    const observed = new Set(snapshot.records.map((record) => record.taskId));
    const observation = freeze({ root, indexDigest: snapshot.indexDigest, complete: true,
      requestedTaskIds: request.taskIds.slice(), absentTaskIds: request.taskIds.filter((id) => !observed.has(id)) });
    observations.add(observation);
    return { ...result, recovered: result.recovered.filter((item) => !request.ownerId || item.ownerId === request.ownerId), observation };
  }
  const authority = Object.freeze({ root, requestFor, acquire, authorizeSnapshot, complete });
  return Object.freeze({
    bindDispatcherAuthority() {
      if (bound) throw invalid();
      dispatcher.bindRecoveryAuthority(authority);
      bound = true;
    },
    forOwner(ownerId) {
      if (!registry.has(ownerId)) throw invalid();
      return Object.freeze({
        async recover(options = {}) {
          if (!bound) throw recoveryError('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', root, 'dispatcher authority 尚未绑定');
          const request = requestFor(ownerId, options);
          const release = await acquire(request);
          try {
            return await dispatcher.runAuthorizedRecovery({ authority, request, memoryConfig: release.memoryConfig,
              authorizeSnapshot: (snapshot) => authorizeSnapshot(snapshot, request) });
          } finally { await release('recovery-worker-exited'); }
        }
      });
    }
  });
}
module.exports = { createPublicationRecoveryCoordinator, isPublicationRecoveryObservation };
