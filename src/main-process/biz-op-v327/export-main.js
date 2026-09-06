'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { freezeExportSource } = require('./export-inputs');
const { EXPORT_IO_RESOURCES } = require('./export-publication');
const { schemaFor, evidenceIdentity } = require('./export-cells');
const { fail, hash, count } = require('./contracts');

function createBizOpExportCoordinator({ userDataDir, catalog, payloadStore, protection, admission, sources,
  publication, getArchiveService, prepareOperation, prepareDispatch, forgetDispatch }) {
  async function runExport({ taskLifecycle, runtime, outputKind, objectId, filePlan, signal, options = {},
    onControl, afterWorker, onPublishProgress, afterPublish }) {
    schemaFor(outputKind);
    const suffix = outputKind.toLowerCase().replace('_', '-');
    const actionKey = `biz-op-v327:export-${suffix}`;
    const policy = createTaskPolicyRegistry().require(`bizOpReconV327:export:${suffix}`);
    if (!filePlan || filePlan.inputs.length || filePlan.outputs.length !== 1) fail('BIZOP_EXPORT_FILE_PLAN_REQUIRED');
    return admission.readTask(null, async ({ bindTask }) => {
      let taskRunId; let frozen; let prepared; let op;
      const candidateRef = `candidate-${randomUUID()}`;
      const result = await taskLifecycle.runFileTask({ policy, meta: { channel: policy.channel }, filePlanResolver: () => filePlan,
        beforeStart: async (context, fileEvidence) => {
          taskRunId = context.taskRunId; bindTask(taskRunId);
          // RAW 的既有 Archive 原件核验会计算大文件摘要，单独准入后再冻结。
          // 此时共享读取 gate 和原件 INPUT hold 已保护来源，不能在无预算 Main 阶段读取。
          const lease = outputKind.endsWith('_RAW') ? await runtime.resourceGovernor.acquirePhaseLease({
            ownerKey: `biz-op-v327:raw-source:${taskRunId}`, actionKey, operationKey: context.operationKey,
            resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'queue'
          }) : null;
          try { frozen = await freezeExportSource({ catalog, payloadStore, getArchiveService, outputKind, objectId }); }
          finally { lease?.release('raw-archive-evidence-closed'); }
          const relativePath = `operations/${taskRunId}/export-source.json`;
          const document = payloadStore.writeDocument(relativePath, frozen);
          const sourceRef = { relativePath, digest: document.digest };
          op = prepareOperation({ taskRunId, actionKey, operationKey: context.operationKey,
            intent: { phase: 'export-workbook-v1', candidateRef, sourceRef, sourceDigest: hash(frozen),
              output: fileEvidence.filePlan.outputs[0] } });
          publication.register({ context, intentDigest: op.intent_digest, sourceDigest: hash(frozen), candidateRef,
            output: fileEvidence.filePlan.outputs[0], targetSnapshot: fileEvidence.targetSnapshots[0] });
          prepared = { phase: 'export-workbook-v1', userDataDir, candidateRef, sourceRef, intentDigest: op.intent_digest, options };
          return {};
        },
        execute: async (context, { settleArtifacts }) => {
          if (signal?.aborted) return { status: 'cancelled' };
          const request = prepareDispatch({ taskContext: context, actionKey, plan: prepared,
            reads: [{ objectKind: frozen.objectKind, objectId, manifestDigest: frozen.manifestDigest }] });
          const planDigest = payloadStore.readDocument(`operations/${taskRunId}/${request.input.planRef}.json`).digest;
          const control = runtime.start(request); protection.attachControl(control);
          const cancel = () => control.cancel({ reason: '用户取消业务 OP 导出' });
          if (signal) { signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); }
          let outcome;
          try { if (onControl) onControl(control); outcome = await control.promise; await control.waitForCarrierClosure({ timeoutMs: 5000 }); }
          finally {
            if (signal) signal.removeEventListener('abort', cancel);
            protection.refresh(taskRunId); if (protection.closed(taskRunId)) forgetDispatch(request);
          }
          if (!protection.closed(taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
          if (afterWorker) await afterWorker({ taskRunId, candidateRef, outcome });
          if (outcome.outcome !== 'completed' || signal?.aborted) return {
            status: signal?.aborted || outcome.outcome === 'cancelled' || outcome.error?.code === 'BIZOP_CANCELLED' ? 'cancelled' : 'error',
            code: outcome.error?.code || 'BIZOP_EXPORT_FAILED' };
          if (outcome.result.planDigest !== planDigest || outcome.result.candidateRef !== candidateRef) fail('BIZOP_EXPORT_RESULT_MISMATCH');
          const evidence = payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
          const expectedIdentity = evidenceIdentity({ ...frozen, maxRowsPerSheet: options.maxRowsPerSheet ?? 1048575 });
          if (evidence.schemaVersion !== 1 || evidence.taskRunId !== taskRunId || evidence.candidateRef !== candidateRef
              || evidence.intentDigest !== op.intent_digest || evidence.sourceDigest !== hash(frozen)
              || hash(evidence.identity) !== hash(expectedIdentity) || !/^[a-f0-9]{64}$/.test(evidence.expectedDigest)
              || evidence.expectedDigest !== evidence.actualDigest || evidence.dataRowCount !== count(outcome.result.rowCount)
              || count(evidence.sheetCount) < (expectedIdentity.notesSchemaVersion === null ? 1 : 2)
              || expectedIdentity.notesSchemaVersion === null && count(evidence.noteRowCount) !== 0
              || count(evidence.byteSize) < 1 || !/^[a-f0-9]{64}$/.test(evidence.sha256)) fail('BIZOP_EXPORT_RESULT_MISMATCH');
          const stat = fs.lstatSync(payloadStore.resolve(`staging/${taskRunId}/${candidateRef}/output.xlsx`));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== evidence.byteSize
              || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => stat[key] !== evidence.fileIdentity[key])) fail('BIZOP_EXPORT_FILE_CHANGED');
          let published;
          try { published = await publication.publish(taskRunId, evidence, runtime, onPublishProgress, signal); }
          catch (error) {
            if (signal?.aborted && error.code === 'BIZOP_CANCELLED' && publication.record(taskRunId).state === 'NOT_STARTED') return { status: 'cancelled' };
            throw error;
          }
          if (afterPublish) await afterPublish({ taskRunId, published });
          const settled = await publication.settle(taskRunId, settleArtifacts, runtime);
          return { status: 'ok', taskRunId, outputKind, objectId, filePath: published.files[0].filePath,
            pendingArchiveHandoff: !settled, dataRowCount: evidence.dataRowCount, noteRowCount: evidence.noteRowCount,
            sheetCount: evidence.sheetCount, sha256: evidence.sha256, metrics: evidence.metrics };
        },
        beforeTerminalSettlement: async ({ businessError }) => {
          const row = publication.record(taskRunId);
          if (!row || row.state === 'NOT_STARTED') return;
          await publication.reconcile(taskRunId, runtime);
          const observed = publication.fact(taskRunId);
          if (!observed || !publication.closed(taskRunId) || !protection.closed(taskRunId)
              || observed.state === 'COMMITTED' && businessError) {
            fail('BIZOP_PUBLICATION_RECOVERY_REQUIRED', '发布结果需要恢复核验，已保留原任务和读取保护');
          }
        },
        afterTerminal: async ({ terminalStatus }) => {
          if (terminalStatus === 'succeeded' && await publication.acknowledge(taskRunId, runtime)) sources.syncCompletion(sources.operationSource(taskRunId));
        }
      });
      return result;
    });
  }
  return { runExport };
}
module.exports = { createBizOpExportCoordinator };
