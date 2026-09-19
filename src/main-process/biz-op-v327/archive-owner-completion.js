'use strict';

const { artifactManifestFromFilePlan } = require('../archive-center/file-plan');
const { freezePersistedTaskOwner } = require('../archive-center/worker-operation-context');
const { ACTIONS, MODULE_ID, fail, hash, sourceKey } = require('./contracts');

function archiveOwnerBinding(service, output) {
  const archiveInstanceId = service?.repository.getArchiveInstanceId();
  if (!archiveInstanceId) fail('BIZOP_ARCHIVE_INSTANCE_MISMATCH');
  return { version: 1, archiveInstanceId,
    manifestIdentity: artifactManifestFromFilePlan({ allocation: 'eager', inputs: [], outputs: [output] }).identity };
}

function compensatedCleanupComplete({ catalog, payloadStore, protection, source, op, context }) {
  const { db } = catalog;
  const abort = db.prepare('SELECT * FROM biz_op_v327_abort_finalizations WHERE source_kind=? AND source_ref=?')
    .get(source.sourceKind, source.sourceRef);
  const followup = db.prepare('SELECT * FROM biz_op_v327_recovery_followups WHERE source_kind=? AND source_ref=?')
    .get(source.sourceKind, source.sourceRef);
  if (!abort || !followup || abort.task_run_id !== context.taskRunId || abort.action_key !== op.action_key
      || abort.operation_key !== context.operationKey || abort.intent_digest !== op.intent_digest
      || abort.finalization_ref !== `finalization-${hash(sourceKey(source))}`
      || !['FAILED', 'CANCELLED'].includes(abort.terminal_reason)
      || abort.closure_manifest_digest !== protection.closureDigest(context.taskRunId)
      || followup.task_run_id !== context.taskRunId || followup.action_key !== op.action_key
      || followup.operation_key !== context.operationKey || followup.intent_digest !== op.intent_digest
      || followup.finalization_ref !== abort.finalization_ref
      || followup.inspection_evidence_digest !== abort.inspection_evidence_digest
      || hash(JSON.parse(followup.source_json)) !== hash(source)
      || !['CONTROL_PENDING', 'COMPLETE'].includes(followup.state)
      || catalog.receipt(context.taskRunId)) fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  const intent = payloadStore.readDocument(op.intent_rel_path, op.intent_digest).value;
  if (intent.phase !== 'export-workbook-v1') fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  const plan = payloadStore.readDocument(abort.cleanup_plan_rel_path, abort.cleanup_plan_digest).value;
  if (abort.cleanup_plan_rel_path !== `operations/${context.taskRunId}/abort-${hash(sourceKey(source)).slice(0, 24)}.json`
      || plan.schemaVersion !== 1 || plan.taskRunId !== context.taskRunId || plan.sourceRef !== source.sourceRef
      || plan.intentDigest !== op.intent_digest || !Array.isArray(plan.files) || !Array.isArray(plan.directories)
      || [...plan.files, ...plan.directories].some((value) => typeof value !== 'string' || !value)) {
    fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  }
  const queue = db.prepare("SELECT * FROM biz_op_v327_reclaim_queue WHERE payload_kind='ABORTED_STAGE' AND object_id=?")
    .get(context.taskRunId);
  if (!plan.directories.length) {
    if (plan.files.length || queue) fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
    return true;
  }
  if (!queue || queue.manifest_digest !== abort.cleanup_plan_digest || queue.plan_rel_path !== abort.cleanup_plan_rel_path
      || queue.receipt_task_run_id !== null) fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  const reclaimOp = catalog.operation(queue.owner_task_run_id);
  const reclaimTask = reclaimOp && catalog.assertTask(reclaimOp);
  if (reclaimOp?.action !== 'RECLAIM' || reclaimTask.taskKey !== ACTIONS['biz-op-v327:reclaim'].taskKey
      || reclaimTask.parentRunId !== context.parentRunId || reclaimTask.metadata.requestedByTaskRunId !== context.taskRunId) {
    fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  }
  // 回收由原 driver 的后续轮次处理；此处等待，不抛错中止同轮其他来源的清理。
  if (queue.state !== 'DONE' || reclaimTask.status !== 'succeeded') return false;
  if (!queue.completed_at || !queue.authorization_digest) fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  const authorization = payloadStore.readDocument(`operations/${queue.owner_task_run_id}/reclaim-plan.json`, queue.authorization_digest).value;
  if (authorization.queueDigest !== hash([queue.reclaim_id, queue.owner_task_run_id, queue.payload_kind,
    queue.object_id, queue.manifest_digest, queue.plan_rel_path, queue.receipt_task_run_id])
      || hash(authorization.stageFiles) !== hash(plan.files) || hash(authorization.stageDirectories) !== hash(plan.directories)) {
    fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  }
  return true;
}

function unpublishedOwnerCompletion({ catalog, repository, publication, payloadStore, protection, source, op }) {
  const task = catalog.assertTask(op);
  const observed = publication.fact(task.taskRunId);
  if (!['failed', 'cancelled'].includes(task.status) || op.input_obligation !== 'COMPLETE'
      || !protection.closed(task.taskRunId) || observed?.state !== 'NOT_COMMITTED'
      || observed.outcome.publisherNeverRegistered !== true
      || catalog.db.prepare('SELECT 1 FROM biz_op_v327_dispatches WHERE task_run_id=? LIMIT 1').get(task.taskRunId)) {
    fail('BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE');
  }
  const batches = catalog.db.prepare('SELECT id FROM archive_batches WHERE task_run_id=?').all(task.taskRunId);
  if (batches.length > 1) fail('BIZOP_ARCHIVE_OWNER_IDENTITY_MISMATCH');
  if (batches.length) {
    const batch = repository.getBatch(batches[0].id);
    const context = { batchId: batch.id, batchNumber: batch.batchNumber,
      ...Object.fromEntries(['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'].map((field) => [field, batch[field]])) };
    const owner = freezePersistedTaskOwner({ version: 1, kind: 'file-batch', batchContext: context }, { required: true });
    const proof = repository.getOwnerTerminalCompletion(owner);
    if (['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'].some((field) => context[field] !== task[field])
        || proof && (proof.archiveInstanceId !== repository.getArchiveInstanceId() || proof.afterTerminal !== null
          || proof.terminalStatus !== task.status)) {
      fail('BIZOP_ARCHIVE_OWNER_BINDING_MISMATCH');
    }
  }
  // beforeStart 登记失败且没有派发时尚无匿名后处理；普通终态通知仍由 Lifecycle/Controller 收口。
  // 已有凭证必须精确匹配；这里不补造 publication binding 或新的 File Task 完成凭证。
  return { completed: compensatedCleanupComplete({ catalog, payloadStore, protection, source, op, context: task }), recorded: false };
}

// 只由 BizOP 原发布 owner 调用；与 phase/settlement 关闭共用目录事务。
// 不从空 outbox 或单独一个终态推断匿名后处理已完成。
function recordExportOwnerCompletion({ catalog, service, publication, source, payloadStore, protection }) {
  const repository = service?.repository;
  if (!repository || repository.db !== catalog.db) fail('BIZOP_ARCHIVE_CONNECTION_MISMATCH');
  const op = catalog.operation(source.taskRunId);
  if (op?.action !== 'EXPORT' || ACTIONS[op.action_key]?.kind !== 'EXPORT'
      || source.boundedEvidence.category !== 'OPERATION' || source.sourceKind !== op.source_kind
      || source.sourceRef !== op.source_ref || source.actionKey !== op.action_key
      || source.operationKey !== op.operation_key || source.boundedEvidence.intentDigest !== op.intent_digest) {
    fail('BIZOP_ARCHIVE_OWNER_SOURCE_MISMATCH');
  }
  if (!publication.record(source.taskRunId)) {
    return unpublishedOwnerCompletion({ catalog, repository, publication, payloadStore, protection, source, op });
  }
  const bound = publication.binding(source.taskRunId);
  if (!bound) fail('BIZOP_ARCHIVE_OWNER_BINDING_MISMATCH');
  const expected = archiveOwnerBinding(service, bound.output);
  const bindingHasOwner = Object.prototype.hasOwnProperty.call(bound, 'archiveOwnerCompletion');
  // 历史 binding 缺新增字段时仍须核验同库 exact owner、冻结 manifest 与原提交/补偿事实。
  // 显式写入的字段不允许缺项、降级或换实例。
  if (bindingHasOwner && hash(bound.archiveOwnerCompletion) !== hash(expected)) fail('BIZOP_ARCHIVE_OWNER_BINDING_MISMATCH');
  const owner = freezePersistedTaskOwner({ version: 1, kind: 'file-batch', batchContext: bound.batchContext }, { required: true });
  const context = owner.batchContext;
  const task = catalog.assertTask(op);
  const batch = repository.getBatch(context.batchId);
  const fields = ['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'];
  const issuance = repository.getOperationIssuance(context.moduleId, context.operationKey);
  if (context.moduleId !== MODULE_ID || context.taskKey !== ACTIONS[op.action_key].taskKey
      || !batch || batch.batchNumber !== context.batchNumber
      || fields.some((field) => task[field] !== context[field] || batch[field] !== context[field])
      || !issuance || issuance.deletedAt || issuance.batchId !== context.batchId
      || issuance.batchNumber !== context.batchNumber || !['succeeded', 'failed', 'cancelled'].includes(task.status)) {
    fail('BIZOP_ARCHIVE_OWNER_IDENTITY_MISMATCH');
  }
  const overlay = catalog.db.prepare('SELECT * FROM background_execution_batch_recovery_states WHERE batch_id=?').get(context.batchId);
  if (overlay ? overlay.task_run_id !== context.taskRunId || overlay.state !== 'resolved'
      || overlay.final_outcome !== task.status || overlay.source_kind !== op.source_kind || overlay.source_ref !== op.source_ref
      : batch.taskStatus !== task.status) fail('BIZOP_ARCHIVE_OWNER_TERMINAL_MISMATCH');
  const manifest = batch.metadata?._fileManifest;
  const artifacts = repository.listArtifacts(context.batchId);
  const artifact = artifacts[0];
  if (!manifest || manifest.version !== 1 || manifest.identity !== expected.manifestIdentity
      || hash(manifest.artifactKeys) !== hash([bound.output.artifactKey]) || artifacts.length !== 1
      || artifact.artifactKey !== bound.output.artifactKey || artifact.direction !== 'output'
      || artifact.sourcePath !== bound.output.filePath || artifact.role !== bound.output.role
      || artifact.sourceOperation !== bound.output.sourceOperation) fail('BIZOP_ARCHIVE_OWNER_MANIFEST_MISMATCH');
  const row = publication.record(context.taskRunId);
  const observed = publication.fact(context.taskRunId);
  if (!row || row.acknowledged !== 1 || row.cleanup_completed !== 1 || !publication.closed(context.taskRunId)
      || !protection.closed(context.taskRunId) || op.input_obligation !== 'COMPLETE'
      || !observed) fail('BIZOP_ARCHIVE_OWNER_PUBLICATION_INCOMPLETE');
  if (observed.state === 'COMMITTED') {
    const output = observed.outcome.files?.[0];
    if (task.status !== 'succeeded' || row.archive_settled !== 1 || artifact.status !== 'ready'
        || observed.outcome.files.length !== 1 || hash(observed.outcome.batchContext) !== hash(context)
        || output.artifactKey !== artifact.artifactKey || output.filePath !== artifact.sourcePath
        || output.sha256 !== artifact.blob?.sha256 || output.byteSize !== artifact.blob?.sizeBytes) {
      fail('BIZOP_ARCHIVE_OWNER_PUBLICATION_INCOMPLETE');
    }
  } else {
    if (observed.state !== 'NOT_COMMITTED' || !['failed', 'cancelled'].includes(task.status)
        || row.archive_settled !== 0 || row.commit_proof_json !== null
        || !['pending', 'failed'].includes(artifact.status) || artifact.blob || artifact.archivedAt || artifact.storageRelativePath) {
      fail('BIZOP_ARCHIVE_OWNER_PUBLICATION_INCOMPLETE');
    }
    if (!compensatedCleanupComplete({ catalog, payloadStore, protection, source, op, context })) {
      return { completed: false, recorded: false };
    }
  }
  const existing = repository.getOwnerTerminalCompletion(owner);
  repository.recordOwnerTerminalCompletion({ archiveInstanceId: expected.archiveInstanceId, owner,
    terminalStatus: task.status, afterTerminal: null });
  return { completed: true, recorded: !existing };
}

module.exports = { archiveOwnerBinding, recordExportOwnerCompletion };
