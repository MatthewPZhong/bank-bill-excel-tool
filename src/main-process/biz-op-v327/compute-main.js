'use strict';

const { randomUUID } = require('node:crypto');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { collectInputs, persistInputs } = require('./compute-inputs');
const { readVerifiedManifest } = require('./payload-store');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { RESULT_SCHEMA_VERSION } = require('./result-schema');
const { fail, hash, count } = require('./contracts');

function createBizOpComputeCoordinator({ userDataDir, catalog, payloadStore, protection, admission, sources,
  prepareOperation, prepareDispatch, forgetDispatch, getArchiveService }) {
  async function runCompute({ taskLifecycle, runtime, startDate, endDate, signal, onControl, afterWorker, afterCommit, options = {} }) {
    return admission.exclusive(async () => {
      if (signal?.aborted) return { status: 'cancelled' };
      const frozen = collectInputs({ catalog, payloadStore, startDate, endDate });
      const existing = catalog.db.prepare("SELECT * FROM biz_op_v327_runs WHERE input_fingerprint=? AND state='PUBLISHED'").get(frozen.inputFingerprint);
      if (existing) {
        try {
          protection.refresh(existing.producer_task_id);
          if (!protection.closed(existing.producer_task_id)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
          await payloadStore.verifyClosedWorkerManifest(existing.payload_manifest_rel_path, existing.payload_manifest_digest);
        } catch (error) { admission.requireRecovery(); throw error; }
        return { status: 'ok', reused: true, runId: existing.run_id, version: existing.result_version, publishedAt: existing.published_at };
      }
      let taskRunId;
      const candidateRef = `candidate-${randomUUID()}`;
      try {
        const result = await taskLifecycle.runOperationOnly({ policy: createTaskPolicyRegistry().require('bizOpReconV327:run'),
          meta: { channel: 'bizOpReconV327:run' }, execute: async (context) => {
            taskRunId = context.taskRunId;
            const op = prepareOperation({ taskRunId, operationKey: context.operationKey, actionKey: 'biz-op-v327:run-candidate',
              intent: { phase: 'interval-compute-v1', candidateRef, inputManifestRef: `operations/${taskRunId}/compute-inputs.json`, inputFingerprint: frozen.inputFingerprint,
                startDate, endDate, ruleVersion: RULE_VERSION, cellContractVersion: CELL_CONTRACT_VERSION } });
            const inputReference = await persistInputs({ frozen, payloadStore, getArchiveService, taskRunId });
            if (catalog.control().generation !== frozen.expectedGeneration) fail('BIZOP_GENERATION_CHANGED');
            const request = prepareDispatch({ taskContext: context, actionKey: 'biz-op-v327:run-candidate',
              reads: frozen.documents.map((input) => ({ objectKind: 'DATASET', objectId: input.datasetId, manifestDigest: input.manifestDigest })),
              plan: { phase: 'interval-compute-v1', userDataDir, candidateRef, intentDigest: op.intent_digest, inputReference, options } });
            const planDigest = payloadStore.readDocument(`operations/${taskRunId}/${request.input.planRef}.json`).digest;
            const control = runtime.start(request); protection.attachControl(control);
            const cancel = () => control.cancel({ reason: '用户取消业务 OP 核对' });
            if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
            let outcome;
            try {
              if (onControl) onControl(control);
              outcome = await control.promise;
              await control.waitForCarrierClosure({ timeoutMs: 5000 });
            } finally {
              if (signal) signal.removeEventListener('abort', cancel);
              protection.refresh(taskRunId);
              if (protection.closed(taskRunId)) forgetDispatch(request);
            }
            if (!protection.closed(taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
            if (afterWorker) await afterWorker({ taskRunId, candidateRef, outcome, frozen });
            protection.completeInputObligation(taskRunId);
            protection.releasePins(taskRunId);
            if (outcome.outcome !== 'completed' || signal?.aborted) return {
              status: signal?.aborted || outcome.outcome === 'cancelled' || outcome.error?.code === 'BIZOP_CANCELLED' ? 'cancelled' : 'error',
              code: outcome.error?.code || 'BIZOP_COMPUTE_FAILED' };
            if (outcome.result.planDigest !== planDigest || outcome.result.candidateRef !== candidateRef) fail('BIZOP_COMPUTE_RESULT_MISMATCH');
            const output = payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
            if (output.schemaVersion !== 1 || output.taskRunId !== taskRunId || output.candidateRef !== candidateRef
                || output.intentDigest !== op.intent_digest || output.inputDigest !== inputReference.digest) fail('BIZOP_COMPUTE_RESULT_MISMATCH');
            const candidate = await payloadStore.verifyClosedWorkerManifest(`results/${candidateRef}/manifest.json`, output.manifestDigest);
            const manifest = readVerifiedManifest(candidate); const info = manifest.catalog;
            if (manifest.rowCount !== count(outcome.result.rowCount) || count(info.fullRowCount) !== manifest.rowCount
                || count(info.diffRowCount) > info.fullRowCount || info.startDate !== startDate || info.endDate !== endDate
                || hash(info.inputs) !== hash(frozen.inputs) || hash(info.bus) !== hash(frozen.bus)
                || hash(info.originalDigests) !== hash(frozen.originalDigests) || info.inputFingerprint !== frozen.inputFingerprint
                || info.resultSchemaVersion !== RESULT_SCHEMA_VERSION || info.cellContractVersion !== CELL_CONTRACT_VERSION
                || info.ruleVersion !== RULE_VERSION) fail('BIZOP_COMPUTE_RESULT_MISMATCH');
            const receipt = catalog.commitRun({ taskRunId, intentDigest: op.intent_digest, candidate });
            if (afterCommit) await afterCommit(receipt);
            return { status: 'ok', receipt, runId: receipt.outcome.runId, version: receipt.outcome.version,
              reused: receipt.outcome.reused, fullRowCount: info.fullRowCount, diffRowCount: info.diffRowCount,
              reasonCounts: info.reasonCounts, metrics: output.metrics };
          } });
        if (taskRunId && catalog.receipt(taskRunId)) sources.syncCompletion(sources.operationSource(taskRunId));
        else if (taskRunId) admission.requireRecovery();
        return result;
      } catch (error) { if (taskRunId) admission.requireRecovery(); throw error; }
    });
  }
  return Object.freeze({ runCompute });
}

module.exports = { createBizOpComputeCoordinator };
