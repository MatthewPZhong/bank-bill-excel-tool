'use strict';

const path = require('node:path');
const { artifactManifestFromFilePlan } = require('../archive-center/file-plan');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const { acquireBizOpPhaseLease } = require('./phase-admission');
const { hash } = require('./contracts');

const OWNER_ID = 'biz-op-v327';
const EXPORT_IO_RESOURCES = Object.freeze({ cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
  ioHeavySlots: 1, memoryBytes: 1073741824 });
const COMMITTED = new Set(['committed', 'committed-cleanup-pending', 'finalizing']);

function ownerError(code) {
  const error = new Error(code);
  error.code = code;
  error.preserveTemporaryFiles = true;
  return error;
}

// 领域持久事实只在此适配器内读取；协调器不取得 catalog 或读取 BizOP SQL。
function createBizOpPublicationOwner({ userDataDir, catalog, protection, publication, getRuntime }) {
  const root = path.resolve(userDataDir);
  const capabilities = new WeakMap();
  function fail(code) { throw ownerError(code); }
  function identify(record) {
    const taskId = String(record.taskId || '');
    if (!taskId.startsWith('biz-op-v327-export-')) return 'not-owned';
    const id = taskId.slice('biz-op-v327-export-'.length);
    const row = publication.record(id);
    if (!row) return 'not-owned';
    const bound = publication.binding(id);
    const op = catalog.operation(id);
    const task = catalog.assertTask(op);
    const batch = catalog.archive.getBatch(bound.batchContext.batchId);
    if (bound.publisherTaskId !== taskId || op.action !== 'EXPORT' || !batch
        || task.taskRunId !== id || batch.taskRunId !== id || batch.id !== bound.batchContext.batchId
        || batch.batchNumber !== bound.batchContext.batchNumber || batch.taskKey !== bound.batchContext.taskKey
        || batch.moduleId !== bound.batchContext.moduleId || batch.operationKey !== bound.batchContext.operationKey
        || batch.parentRunId !== bound.batchContext.parentRunId
        || task.taskKey !== bound.batchContext.taskKey || task.moduleId !== bound.batchContext.moduleId
        || task.parentRunId !== bound.batchContext.parentRunId || task.operationKey !== bound.batchContext.operationKey) {
      fail('PUBLICATION_RECOVERY_OWNER_CONFLICT');
    }
    const contextDigest = hash(freezeWorkerBatchContext(bound.batchContext, { required: true }));
    // index 和 journal 都是身份来源；一方缺失只用于有持久锚点的 preparing/finalizing。
    for (const evidence of [record.indexEntry, record.journal].filter(Boolean)) {
      if (!evidence.batchContext) fail('PUBLICATION_RECOVERY_OWNER_UNKNOWN');
      if (evidence.taskId !== taskId
          || hash(freezeWorkerBatchContext(evidence.batchContext, { required: true })) !== contextDigest) {
        fail('PUBLICATION_RECOVERY_OWNER_CONFLICT');
      }
    }
    const targets = record.journal ? record.journal.entries?.map((entry) => entry.targetPath)
      : record.indexEntry?.targetAbsolutePaths;
    if (!Array.isArray(targets) || targets.length !== 1 || path.resolve(targets[0]) !== bound.output.filePath) {
      fail('PUBLICATION_RECOVERY_OWNER_CONFLICT');
    }
    return Object.freeze({ ownerId: OWNER_ID, publisherTaskId: taskId, taskRunId: id,
      batchId: bound.batchContext.batchId, operationKey: bound.batchContext.operationKey,
      proofDigest: hash({ bindingDigest: row.binding_digest, intentDigest: op.intent_digest, contextDigest }),
      legacyProofKind: 'bizop-durable-binding-exact-7' });
  }
  function requestMatches(capability, request) {
    const saved = capabilities.get(capability);
    if (!saved || !saved.active || request.root !== root) return false;
    if (saved.kind === 'owned') {
      return request.ownerId === saved.ownerId
        && hash(request.taskIds || []) === saved.taskIdsDigest
        && (request.reason === saved.reason || saved.reason === 'publish-preflight' && request.reason === 'transport-error');
    }
    if (request.ownerId !== OWNER_ID && request.ownerId !== null) return false;
    if (!Array.isArray(request.taskIds) || request.taskIds.length !== 1 || request.taskIds[0] !== saved.publisherTaskId) return false;
    const allowedReasons = saved.operation === 'publish' ? ['publish-preflight', 'transport-error']
      : saved.operation === 'recover' ? ['business-retry'] : ['receipt-ack'];
    if (!allowedReasons.includes(request.reason)) return false;
    const row = publication.record(saved.taskRunId);
    return Boolean(row && row.state === 'STARTED' && row.attempt_nonce === saved.attemptNonce
      && row.binding_digest === saved.bindingDigest && protection.closed(saved.taskRunId)
      && protection.closureDigest(saved.taskRunId) === saved.protectionDigest);
  }
  function verifyObservation(capability, request) { return requestMatches(capability, request); }
  function issueBorrowedObservation({ taskRunId, attemptNonce, kind }) {
    if (!['publish', 'recover', 'acknowledge'].includes(kind) || !attemptNonce
        || !publication.closed(taskRunId) || !protection.closed(taskRunId)) fail('BIZOP_PUBLICATION_CLOSURE_PENDING');
    const bound = publication.binding(taskRunId);
    const row = publication.record(taskRunId);
    if (!bound || !row) fail('BIZOP_PUBLICATION_BINDING_INVALID');
    const capability = Object.freeze({ verifyScope(request) { return requestMatches(capability, request); },
      // 借用租约只能由外层 io 在真实退出后释放。
      release() {} });
    capabilities.set(capability, { active: true, kind: 'borrowed', operation: kind, taskRunId, attemptNonce,
      publisherTaskId: bound.publisherTaskId, bindingDigest: row.binding_digest,
      protectionDigest: protection.closureDigest(taskRunId) });
    return { capability, close() { capabilities.get(capability).active = false; } };
  }
  async function acquireObservation(request) {
    if (request.observation) {
      if (!verifyObservation(request.observation, request)) fail('PUBLICATION_RECOVERY_AUTHORITY_REQUIRED');
      return request.observation;
    }
    if (!catalog.db.prepare('SELECT 1 FROM biz_op_v327_publications WHERE cleanup_completed=0 LIMIT 1').get()) return null;
    const lease = await acquireBizOpPhaseLease(getRuntime(), {
      ownerKey: 'biz-op-v327:shared-publication-observation', actionKey: 'biz-op-v327:export-result-full',
      operationKey: 'biz-op-v327:shared-publication-observation', resources: EXPORT_IO_RESOURCES,
      lowMemoryBehavior: 'queue'
    });
    const capability = Object.freeze({ verifyScope(value) { return requestMatches(capability, value); },
      release(reason) {
        const saved = capabilities.get(capability);
        if (!saved.active) return;
        saved.active = false;
        lease.release(reason);
      } });
    capabilities.set(capability, { active: true, kind: 'owned', ownerId: request.ownerId,
      reason: request.reason, taskIdsDigest: hash(request.taskIds || []) });
    return capability;
  }
  function hasAcknowledgementProof(id) {
    const row = publication.record(id);
    const observed = publication.fact(id);
    const bound = publication.binding(id);
    const op = catalog.operation(id);
    if (!row || observed?.state !== 'COMMITTED' || !row.archive_settled || !bound
        || catalog.task(id)?.status !== 'succeeded' || op?.input_obligation !== 'COMPLETE'
        || op.phase === 'HOLD' || op.settlement_state === 'RECOVERY_BLOCKED' || !protection.closed(id)) return false;
    const batch = catalog.archive.getBatch(bound.batchContext.batchId);
    const artifacts = catalog.archive.listArtifacts(bound.batchContext.batchId);
    const output = observed.outcome.files?.[0];
    const artifact = artifacts[0];
    const manifestIdentity = artifactManifestFromFilePlan({ allocation: 'eager', inputs: [], outputs: [bound.output] }).identity;
    return Boolean(batch && batch.metadata?._fileManifest?.identity === manifestIdentity
      && (!bound.archiveOwnerCompletion || bound.archiveOwnerCompletion.archiveInstanceId === catalog.archive.getArchiveInstanceId()
        && bound.archiveOwnerCompletion.manifestIdentity === manifestIdentity)
      && artifacts.length === 1 && observed.outcome.files.length === 1
      && artifact.status === 'ready' && artifact.direction === 'output'
      && artifact.artifactKey === bound.output.artifactKey && output.artifactKey === artifact.artifactKey
      && artifact.sourcePath === bound.output.filePath && output.filePath === artifact.sourcePath
      && output.sha256 === artifact.blob?.sha256 && output.byteSize === artifact.blob?.sizeBytes);
  }
  function authorize(record, request, identity) {
    const id = identity.taskRunId;
    const defer = (code) => ({ disposition: 'defer', permission: null, identity, code });
    const borrowed = request.observation && verifyObservation(request.observation, request)
      && capabilities.get(request.observation).kind === 'borrowed'
      && capabilities.get(request.observation).taskRunId === id;
    if ((!borrowed && !publication.closed(id)) || !protection.closed(id)) return defer('BIZOP_PUBLICATION_CLOSURE_PENDING');
    const op = catalog.operation(id);
    if (op.phase === 'HOLD' || op.settlement_state === 'RECOVERY_BLOCKED') return defer('BIZOP_PUBLICATION_RECOVERY_HOLD');
    const observed = publication.fact(id);
    const status = record.journalStatus || record.discoveryState;
    const committed = COMMITTED.has(status);
    if (!committed) {
      if (observed?.state === 'COMMITTED') fail('BIZOP_PUBLICATION_OBSERVATION_CHANGED');
      return { disposition: 'allow', permission: 'recover-uncommitted', identity };
    }
    const ack = request.acknowledgedCommittedTaskIds?.includes(record.taskId);
    if (!ack) return { disposition: 'allow', permission: 'observe-committed', identity };
    if (request.ownerId !== OWNER_ID) fail('PUBLICATION_RECOVERY_OWNER_CONFLICT');
    if (!borrowed || capabilities.get(request.observation).operation !== 'acknowledge'
        || !hasAcknowledgementProof(id)) {
      return defer('BIZOP_PUBLICATION_ACK_PENDING');
    }
    const files = record.journal ? record.journal.entries.map((entry) => ({ filePath: entry.targetPath,
      sha256: entry.generated.sha256, byteSize: entry.generated.size })) : record.indexEntry.outputFiles;
    const committedFile = observed.outcome.files[0];
    if (!Array.isArray(files) || files.length !== 1 || path.resolve(files[0].filePath) !== committedFile.filePath
        || files[0].sha256 !== committedFile.sha256 || files[0].byteSize !== committedFile.byteSize) {
      fail('PUBLICATION_RECOVERY_OWNER_CONFLICT');
    }
    return { disposition: 'allow', permission: request.deferCommittedFinalization ? 'ack-stage' : 'ack-finalize', identity };
  }
  return Object.freeze({ id: OWNER_ID, identify, authorize, acquireObservation, verifyObservation, issueBorrowedObservation, hasAcknowledgementProof });
}

module.exports = { createBizOpPublicationOwner, EXPORT_IO_RESOURCES };
