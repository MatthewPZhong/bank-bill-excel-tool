'use strict';

function invalidParticipant() {
  return Object.assign(new TypeError('应用恢复参与者配置无效'), {
    code: 'APPLICATION_RECOVERY_PARTICIPANT_INVALID'
  });
}

function createApplicationRecoveryCoordinator({ platform, participants } = {}) {
  if (!platform || typeof platform.scanAndRecover !== 'function'
      || typeof platform.recoverSource !== 'function' || !Array.isArray(participants)) {
    throw invalidParticipant();
  }
  const ids = new Set();
  const ordered = Object.freeze(participants.map((participant) => {
    if (!participant || typeof participant.id !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(participant.id) || ids.has(participant.id)
        || typeof participant.ownerName !== 'string' || !participant.ownerName.trim()
        || ['preflight', 'recoverOwner', 'postOutbox'].some((key) => (
          participant[key] !== null && typeof participant[key] !== 'function'
        )) || (participant.hookName !== undefined
          && (typeof participant.hookName !== 'string' || !participant.hookName.trim()))) {
      throw invalidParticipant();
    }
    ids.add(participant.id);
    return Object.freeze({ ...participant });
  }));
  let phase = 'created';
  let failureCode = null;
  let platformScanCompleted = false;
  let preflightPending = null;
  let preflightResult = null;
  const snapshot = () => Object.freeze({ phase, platformScanCompleted, failureCode });
  function failArchiveInitialization(error) {
    if (phase === 'ready') return;
    phase = 'failed';
    failureCode = error && error.code || null;
  }
  const platformFacade = Object.freeze({
    async scanAndRecover() {
      const result = await platform.scanAndRecover();
      platformScanCompleted = true;
      return result;
    },
    recoverSource(source, hold = null) { return platform.recoverSource(source, hold); },
    snapshot
  });
  function onceSuccessful(work) {
    let pending = null;
    let completed = false;
    let result;
    return () => {
      if (pending) return pending;
      if (completed || phase === 'ready') return Promise.resolve(result);
      pending = Promise.resolve().then(work).then((value) => {
        completed = true;
        result = value;
        return value;
      }, (error) => {
        failArchiveInitialization(error);
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    };
  }
  const ownerHooks = Object.freeze(ordered.filter((entry) => entry.recoverOwner).map((entry) => Object.freeze({
    ownerName: entry.ownerName,
    recover: onceSuccessful(entry.recoverOwner)
  })));
  const afterHooks = Object.freeze(ordered.filter((entry) => entry.postOutbox).map((entry) => Object.freeze({
    hookName: entry.hookName || entry.ownerName,
    run: onceSuccessful(entry.postOutbox)
  })));
  return Object.freeze({
    platformFacade,
    preflight() {
      if (preflightPending) return preflightPending;
      if (preflightResult) return Promise.resolve(preflightResult);
      if (phase === 'ready') return Promise.resolve(Object.freeze({ snapshot: snapshot(), participantResults: Object.freeze([]) }));
      phase = 'preflight';
      failureCode = null;
      preflightPending = (async () => {
        const participantResults = [];
        for (const entry of ordered) {
          if (entry.preflight) participantResults.push(Object.freeze({ id: entry.id, result: await entry.preflight() }));
        }
        phase = 'archive';
        preflightResult = Object.freeze({ snapshot: snapshot(), participantResults: Object.freeze(participantResults) });
        return preflightResult;
      })().catch((error) => {
        failArchiveInitialization(error);
        throw error;
      }).finally(() => { preflightPending = null; });
      return preflightPending;
    },
    archiveOwnerHooks: () => ownerHooks,
    postOutboxHooks: () => afterHooks,
    completeArchiveInitialization() {
      if (phase === 'ready') return;
      if (!platformScanCompleted) {
        const error = Object.assign(new Error('启动恢复尚未完成平台完整扫描'), { code: 'BACKGROUND_RECOVERY_SCAN_PENDING' });
        failArchiveInitialization(error);
        throw error;
      }
      phase = 'ready';
      failureCode = null;
    },
    failArchiveInitialization,
    snapshot
  });
}

module.exports = { createApplicationRecoveryCoordinator };
