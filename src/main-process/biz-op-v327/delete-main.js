'use strict';

const { randomUUID } = require('node:crypto');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { fail, hash } = require('./contracts');

function createBizOpDeleteCoordinator({ userDataDir, catalog, payloadStore, protection, admission, sources,
  prepareOperation, prepareDispatch, forgetDispatch, previews, preservation }) {
  async function runDelete({ taskLifecycle, runtime, previewId, mode, signal, onControl, afterWorker, afterCommit }) {
    return admission.exclusive(async () => {
      const { row, closure } = previews.validate(previewId, mode);
      const intent = catalog.deleteIntent({ datasetIds: closure.selection.datasetIds,
        runIds: mode === 'KEEP_RESULTS' ? [] : closure.runs.map((run) => run.objectId), deleteMode: mode,
        expectedGeneration: row.generation, previewBinding: { previewId, closureDigest: row.closure_digest } });
      if (row.confirmed_task_id) {
        if (catalog.receipt(row.confirmed_task_id)) {
          const receipt = catalog.commitDelete({ taskRunId: row.confirmed_task_id, intentDigest: hash(intent), intent });
          return { status: 'ok', receipt, taskRunId: row.confirmed_task_id, reused: true };
        }
        fail('BIZOP_DELETE_PREVIEW_USED', '该预览已用于一次删除任务，请先核对任务状态，再重新预览');
      }
      if (signal?.aborted) return { status: 'cancelled' };
      let taskRunId; const candidateRef = `candidate-${randomUUID()}`;
      try {
        const result = await taskLifecycle.runOperationOnly({ policy: createTaskPolicyRegistry().require('bizOpReconV327:delete'),
          meta: { channel: 'bizOpReconV327:delete' }, execute: async (context) => {
            taskRunId = context.taskRunId;
            prepareOperation({ taskRunId, operationKey: context.operationKey, actionKey: 'biz-op-v327:delete-plan', intent });
            previews.bind(previewId, mode, taskRunId);
            const sourcePath = `operations/${taskRunId}/delete-source.json`;
            const source = payloadStore.writeDocument(sourcePath, { schemaVersion: 1, taskRunId, intentDigest: hash(intent),
              previewId, mode, closure, closureDigest: row.closure_digest });
            const request = prepareDispatch({ taskContext: context, actionKey: 'biz-op-v327:delete-plan', plan: {
              phase: 'delete-plan-v1', userDataDir, candidateRef, intentDigest: hash(intent),
              sourceRef: { relativePath: sourcePath, digest: source.digest } } });
            const planDigest = payloadStore.readDocument(`operations/${taskRunId}/${request.input.planRef}.json`).digest;
            const control = runtime.start(request); protection.attachControl(control);
            const cancel = () => control.cancel({ reason: '用户取消业务 OP 删除准备' });
            if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
            let outcome;
            try { if (onControl) onControl(control); outcome = await control.promise; await control.waitForCarrierClosure({ timeoutMs: 5000 }); }
            finally {
              if (signal) signal.removeEventListener('abort', cancel);
              protection.refresh(taskRunId); if (protection.closed(taskRunId)) forgetDispatch(request);
            }
            if (!protection.closed(taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
            if (afterWorker) await afterWorker({ taskRunId, outcome });
            protection.completeInputObligation(taskRunId); protection.releasePins(taskRunId);
            if (outcome.outcome !== 'completed' || signal?.aborted) return { status: signal?.aborted || outcome.outcome === 'cancelled'
              || outcome.error?.code === 'BIZOP_CANCELLED' ? 'cancelled' : 'error', code: outcome.error?.code || 'BIZOP_DELETE_PLAN_FAILED' };
            if (outcome.result.planDigest !== planDigest || outcome.result.candidateRef !== candidateRef) fail('BIZOP_DELETE_PLAN_INVALID');
            const actual = payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
            if (actual.schemaVersion !== 1 || actual.taskRunId !== taskRunId || actual.candidateRef !== candidateRef
                || actual.intentDigest !== hash(intent) || actual.previewId !== previewId || actual.mode !== mode
                || actual.closureDigest !== row.closure_digest || actual.generation !== row.generation
                || hash(actual.datasetIds) !== hash(intent.datasetIds) || hash(actual.runIds) !== hash(intent.runIds)
                || actual.datasetIds.length + actual.runIds.length !== outcome.result.rowCount) fail('BIZOP_DELETE_PLAN_INVALID');
            if (row.expires_at <= catalog.now() || hash(previews.collect(closure.selection)) !== row.closure_digest) {
              fail('BIZOP_DELETE_PREVIEW_STALE', '数据或保护状态已变化，请重新查看删除影响并确认');
            }
            if (mode === 'KEEP_RESULTS') await preservation.verify(closure, { runtime, taskRunId, operationKey: context.operationKey });
            if (signal?.aborted) return { status: 'cancelled' };
            if (row.expires_at <= catalog.now() || hash(previews.collect(closure.selection)) !== row.closure_digest) fail('BIZOP_DELETE_PREVIEW_STALE');
            const receipt = catalog.commitDelete({ taskRunId, intentDigest: hash(intent), intent });
            if (afterCommit) await afterCommit(receipt);
            return { status: 'ok', taskRunId, receipt, reused: false };
          } });
        if (taskRunId && catalog.receipt(taskRunId)) sources.syncCompletion(sources.operationSource(taskRunId));
        else if (taskRunId) admission.requireRecovery();
        return result;
      } catch (error) { if (taskRunId) admission.requireRecovery(); throw error; }
    });
  }
  return { runDelete };
}
module.exports = { createBizOpDeleteCoordinator };
