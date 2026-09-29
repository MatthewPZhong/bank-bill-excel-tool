'use strict';

// 合成 publication fixture 专用 authority；生产代码从不导入本文件。
const crypto = require('node:crypto');
const path = require('node:path');
const core = require('../../src/main-process/toolbox-output-publication');
const { createWorkerAuthority, seal } = require('../../src/main-process/publication-recovery/worker-authority');
const { createPublicationRecoveryCoordinator } = require('../../src/main-process/publication-recovery/coordinator');
const { createToolboxPublicationDispatcher } = require('../../src/main-process/toolbox-output-publication-dispatch');
const key = crypto.randomBytes(32).toString('hex');
const workerAuthority = createWorkerAuthority(key);
const CONTEXT = Object.freeze({ batchId: 1, batchNumber: 'test-001', taskRunId: 'test-publication',
  taskKey: 'toolbox:merge', moduleId: 'toolbox', parentRunId: 'test-parent', operationKey: 'test-operation' });
function identity(record, ownerId = 'test-publication') {
  const context = record.journal && record.journal.batchContext || record.indexEntry.batchContext || {};
  return { ownerId, publisherTaskId: record.taskId, taskRunId: context.taskRunId || record.taskId,
    batchId: context.batchId || 1, operationKey: context.operationKey || record.taskId,
    proofDigest: 'test-fixture-proof', legacyProofKind: 'test-fixture' };
}
function committed(record) {
  return record.discoveryState === 'finalizing' || ['committed', 'committed-cleanup-pending'].includes(record.journalStatus);
}
function createTestPublicationOwner(options = {}) {
  const id = options.id || 'test-publication';
  return { id,
    async identify(record) { return identity(record, id); },
    async authorize(record, request, ownerIdentity) {
      const ack = request.ownerId === id && request.acknowledgedCommittedTaskIds.includes(record.taskId);
      return { disposition: 'allow', identity: ownerIdentity, permission: !committed(record) ? 'recover-uncommitted'
        : ack ? request.deferCommittedFinalization ? 'ack-stage' : 'ack-finalize' : 'observe-committed' };
    },
    async acquireObservation() { return null; },
    ...options
  };
}
function recoverPendingToolboxPublications(options = {}) {
  const snapshot = core.discoverToolboxPublicationRecovery(options);
  const ackIds = new Set(options.acknowledgedCommittedTaskIds || []);
  const entries = snapshot.records.map((record) => {
    const ack = committed(record) && (ackIds.has(record.taskId) || options.deferCommittedRecovery !== true);
    return { taskId: record.taskId, recordDigest: record.recordDigest, ownerId: 'test-publication',
      identity: identity(record), disposition: 'allow', active: snapshot.skippedActive.includes(record.taskId),
      permission: !committed(record) ? 'recover-uncommitted' : ack
        ? options.deferCommittedFinalization ? 'ack-stage' : 'ack-finalize' : 'observe-committed', acknowledged: ack };
  });
  return core.recoverPendingToolboxPublications({ ...options, workerAuthority,
    authorization: seal(key, 'recovery', { root: snapshot.root, indexDigest: snapshot.indexDigest, entries, nonce: crypto.randomUUID() }) });
}
function prepareToolboxPublication(options = {}) {
  // 保留旧算法 fixture 的低层便利入口，显式建立测试授权；未授权生产入口另有拒绝回归。
  if (!options.userDataDir || !options.taskId) return core.prepareToolboxPublication(options);
  const recovery = recoverPendingToolboxPublications({ ...options, deferCommittedRecovery: true });
  if (recovery.recovered.some((item) => item.action === 'commit-handoff-pending')) {
    throw new core.ToolboxPublicationManualRecoveryError('已有工具箱输出等待存档中心耐久接管，已阻止新的发布任务');
  }
  const snapshot = core.discoverToolboxPublicationRecovery(options);
  return core.prepareToolboxPublication({ ...(!options.requireArchiveHandoff && options.batchContext === undefined
    ? { batchContext: CONTEXT } : {}), ...options, workerAuthority,
    preflight: seal(key, 'preflight', { root: path.resolve(options.userDataDir), taskId: options.taskId,
      indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID() }) });
}
function createTestPublicationHarness(userDataDir, options = {}) {
  const dispatcher = options.dispatcher || createToolboxPublicationDispatcher(options.dispatcherOptions);
  const owners = options.owners || [createTestPublicationOwner(options.ownerOptions)];
  const coordinator = createPublicationRecoveryCoordinator({ userDataDir, dispatcher, owners });
  coordinator.bindDispatcherAuthority();
  return { dispatcher, coordinator, recovery: coordinator.forOwner(options.ownerId || owners[0].id) };
}
module.exports = { ...core, prepareToolboxPublication, recoverPendingToolboxPublications,
  createTestPublicationOwner, createTestPublicationHarness, CONTEXT };
