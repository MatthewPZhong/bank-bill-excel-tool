'use strict';

const { randomUUID } = require('node:crypto');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { createBizOpCatalog } = require('./catalog');
const { createBizOpPayloadStore } = require('./payload-store');
const { createBizOpAdmission } = require('./admission');
const { createBizOpReadProtection } = require('./read-protection');
const { createBizOpRecoverySources } = require('./recovery-sources');
const { createBizOpRecoveryDriver } = require('./recovery-driver');
const { createBizOpRecoveryPlan } = require('./recovery-plan');
const { createBizOpReclaimer } = require('./reclaim');
const { createBizOpImportCoordinator } = require('./import-main');
const { createBizOpComputeCoordinator } = require('./compute-main');
const { createBizOpPublication } = require('./export-publication');
const { createBizOpExportCoordinator } = require('./export-main');
const { createBizOpMetadata } = require('./metadata');
const { createBizOpDeletePreview } = require('./delete-preview');
const { createBizOpDeleteCoordinator } = require('./delete-main');
const { createDeletePreservation } = require('./delete-preservation');
const { ACTIONS, fail, hash } = require('./contracts');

function createBizOpV327Module({ db, userDataDir, readRepository, getArchiveService, getRuntime, budgetOptions }) {
  const catalog = createBizOpCatalog(db, { assertCommitReady(op) {
    admission.assertExclusive();
    protection.refresh(op.task_run_id);
    if (!['PREPARING', 'SEALED'].includes(op.phase) || catalog.task(op.task_run_id).status !== 'running'
        || !protection.closed(op.task_run_id)) {
      fail('BIZOP_COMMIT_CLOSURE_REQUIRED');
    }
  } });
  const payloadStore = createBizOpPayloadStore({ userDataDir });
  payloadStore.initialize();
  const protection = createBizOpReadProtection({ catalog, payloadStore });
  const admission = createBizOpAdmission({ canReleaseRead(id) {
    return protection.canRelease(id) && (catalog.operation(id)?.action !== 'EXPORT'
      || publication.closed(id) && publication.record(id)?.cleanup_completed === 1);
  } });
  const sources = createBizOpRecoverySources({ catalog, protection, payloadStore, readRepository, getArchiveService,
    requireRecovery: admission.requireRecovery });
  const recovery = createBizOpRecoveryDriver({ catalog, sources, admission, readRepository, budgetOptions });
  const plan = createBizOpRecoveryPlan({ catalog });
  const preservation = createDeletePreservation({ catalog, payloadStore, getArchiveService, getRuntime });
  sources.setReclaimHandler(createBizOpReclaimer({ catalog, payloadStore, protection, admission, beforeReclaim: preservation.committed }));
  sources.setBeforeCommitted(preservation.committed);
  const dispatchPlans = new Map();
  const dispatchPlansByJob = new Map();
  function prepareOperation({ taskRunId, actionKey, operationKey, intent }) {
    if (ACTIONS[actionKey]?.kind === 'EXPORT') admission.assertTaskAccess(taskRunId);
    else admission.assertExclusive();
    const relative = `operations/${taskRunId}/intent.json`;
    payloadStore.writeDocument(relative, intent);
    return catalog.prepare({ taskRunId, actionKey, operationKey, intent, intentRelPath: relative,
      expectedGeneration: catalog.control().generation });
  }
  function prepareDispatch({ taskContext, actionKey, plan: input, reads = [] }) {
    if (ACTIONS[actionKey]?.kind === 'EXPORT') admission.assertTaskAccess(taskContext.taskRunId);
    else admission.assertExclusive();
    const jobId = `bizop-job-${randomUUID()}`;
    const ref = `plan-${randomUUID()}`;
    const boundPlan = { ...input, taskRunId: taskContext.taskRunId, operationKey: taskContext.operationKey };
    const relative = `operations/${taskContext.taskRunId}/${ref}.json`;
    const document = payloadStore.writeDocument(relative, boundPlan);
    const dispatchPlan = { actionKey, jobId, taskRunId: taskContext.taskRunId, operationKey: taskContext.operationKey,
      path: payloadStore.resolve(relative), digest: document.digest, reads };
    dispatchPlans.set(ref, dispatchPlan);
    dispatchPlansByJob.set(jobId, dispatchPlan);
    return { actionKey, operationKey: taskContext.operationKey, jobId, workerInstanceId: `bizop-worker-${randomUUID()}`,
      input: { planRef: ref }, context: { kind: 'operation', value: Object.fromEntries(
        ['taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'].map((key) => [key, taskContext[key]])) } };
  }
  const runtimeBindings = Object.freeze({
    actionKeys: Object.freeze(Object.keys(ACTIONS)),
    bindInput({ actionKey, operationKey, input }) {
      const entry = input && dispatchPlans.get(input.planRef);
      if (!entry || entry.actionKey !== actionKey || entry.operationKey !== operationKey
          || Object.keys(input).length !== 1) fail('BIZOP_MAIN_INPUT_AUTHORITY_REQUIRED');
      return { planPath: entry.path, planDigest: entry.digest };
    },
    beforeDispatch(identity) {
      if (ACTIONS[identity.actionKey]?.kind === 'EXPORT') admission.assertTaskAccess(identity.taskRunId);
      else admission.assertExclusive();
      const entry = dispatchPlansByJob.get(identity.jobId);
      if (!entry || entry.taskRunId !== identity.taskRunId || entry.actionKey !== identity.actionKey
          || entry.operationKey !== identity.operationKey) fail('BIZOP_DISPATCH_AUTHORITY_REQUIRED');
      protection.beforeDispatch(identity, entry.digest, entry.reads);
    }
  });
  function forgetDispatch(request) {
    dispatchPlans.delete(request.input.planRef); dispatchPlansByJob.delete(request.jobId);
  }
  const mainBindings = { userDataDir, catalog, payloadStore, protection, admission, sources,
    prepareOperation, prepareDispatch, getArchiveService, forgetDispatch };
  const publication = createBizOpPublication({ ...mainBindings, getRuntime });
  const exports = createBizOpExportCoordinator({ ...mainBindings, publication });
  const metadata = createBizOpMetadata({ catalog, admission });
  const previews = createBizOpDeletePreview({ catalog, admission });
  const deletion = createBizOpDeleteCoordinator({ ...mainBindings, previews, preservation });
  sources.setPublication(publication);
  const imports = createBizOpImportCoordinator(mainBindings);
  const compute = createBizOpComputeCoordinator(mainBindings);
  sources.setBeforeFinalize((taskRunId) => imports.restoreDiagnostic(taskRunId));
  async function executeCandidateValidation({ runtime, taskContext, artifactId, candidateRef }) {
    admission.assertExclusive();
    const original = catalog.original(artifactId, taskContext.taskRunId);
    const resolved = await getArchiveService().resolveVerifiedArtifact(artifactId);
    if (!resolved.ok || resolved.sha256 !== original.sha256) fail('BIZOP_ORIGINAL_VERIFY_FAILED');
    const candidate = payloadStore.prepareCandidate(taskContext.taskRunId, candidateRef);
    const request = prepareDispatch({ taskContext, actionKey: 'biz-op-v327:import-candidate',
      plan: { phase: 'candidate-validation', candidateRef, candidateDirectory: candidate.directory, originalPath: resolved.filePath } });
    const control = runtime.start(request);
    protection.attachControl(control);
    const result = await control.promise;
    await control.waitForCarrierClosure({ timeoutMs: 5000 });
    protection.refresh(taskContext.taskRunId);
    dispatchPlans.delete(request.input.planRef);
    dispatchPlansByJob.delete(request.jobId);
    if (!protection.closed(taskContext.taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
    if (result.outcome !== 'completed') fail(result.error?.code || 'BIZOP_CANDIDATE_FAILED');
    protection.completeInputObligation(taskContext.taskRunId);
    return result.result;
  }
  // 此 Main 内部入口只验证 PR1b 候选/目录闭环；不接受 renderer 原始路径，也不声明 Excel 导入已实现。
  async function runCandidateValidation({ taskLifecycle, runtime, filePlan, dataset, afterCommit }) {
    return admission.exclusive(async () => {
      let taskRunId;
      const candidateRef = `candidate-${randomUUID()}`;
      let result;
      try { result = await taskLifecycle.runFileTask({
        policy: createTaskPolicyRegistry().require('bizOpReconV327:import'),
        meta: { channel: 'bizOpReconV327:import' }, filePlanResolver: () => filePlan,
        execute: async (context, controls) => {
          taskRunId = context.taskRunId;
          const op = prepareOperation({ taskRunId, actionKey: 'biz-op-v327:import-candidate',
            operationKey: context.operationKey, intent: { phase: 'candidate-validation', candidateRef, dataset } });
          const settled = await controls.settleArtifacts({ files: filePlan.inputs.map((file) => ({ artifactKey: file.artifactKey })) });
          if (!settled.ok || !settled.durable) fail('BIZOP_ORIGINAL_SETTLEMENT_FAILED');
          const originals = catalog.archive.listArtifacts(context.batchId).filter((file) => file.direction === 'input');
          if (originals.length !== 1) fail('BIZOP_CANDIDATE_VALIDATION_INPUT_COUNT');
          const output = await executeCandidateValidation({ runtime, taskContext: context, artifactId: originals[0].id, candidateRef });
          const verified = await payloadStore.sealCandidate({ taskRunId, objectId: candidateRef, objectKind: 'DATASET',
            intentDigest: op.intent_digest, parts: [{ name: 'part-000001.sqlite', rowCount: output.rowCount }],
            catalog: { kind: dataset.kind, dataDate: dataset.dataDate, inputFingerprint: hash([dataset, originals[0].blob.sha256]),
              sourceManifestDigest: hash([originals[0].id, originals[0].blob.sha256]), sources: [{ artifactId: originals[0].id,
                sha256: originals[0].blob.sha256, order: 0, sheetName: 'candidate_rows', bu: dataset.bu, rowCount: output.rowCount }] } });
          const receipt = catalog.commitImport({ taskRunId, intentDigest: op.intent_digest, candidates: [verified] });
          if (afterCommit) await afterCommit(receipt);
          return { status: 'ok', receipt };
        }
      }); } catch (error) { admission.requireRecovery(); throw error; }
      if (taskRunId && catalog.receipt(taskRunId)) sources.syncCompletion(sources.operationSource(taskRunId));
      return result;
    });
  }
  function protectedTasks() {
    const taskRunIds = [];
    const batchIds = [];
    for (const row of db.prepare(`SELECT p.task_run_id FROM biz_op_v327_prepared_ops p
      WHERE p.phase!='CLOSED' OR EXISTS (SELECT 1 FROM biz_op_v327_read_pins r WHERE r.task_run_id=p.task_run_id)
      OR EXISTS (SELECT 1 FROM biz_op_v327_dispatches d WHERE d.task_run_id=p.task_run_id AND d.state!='CLOSED'
        AND d.process_exit_evidence_json IS NULL)`).iterate()) {
      if (taskRunIds.length >= 4096) fail('BIZOP_PROTECTED_TASK_INVENTORY_LIMIT');
      taskRunIds.push(row.task_run_id);
      for (const batch of db.prepare('SELECT id FROM archive_batches WHERE task_run_id=?').iterate(row.task_run_id)) batchIds.push(batch.id);
    }
    return { taskRunIds, batchIds };
  }
  return Object.freeze({ catalog, payloadStore, admission, protection, sources, recovery, plan, runtimeBindings,
    prepareOperation, prepareDispatch, runCandidateValidation, runImport: imports.runImport, runCompute: compute.runCompute,
    runExport: exports.runExport, runDelete: deletion.runDelete, metadata, previews, publication, protectedTasks,
    readyHold: catalog.readyHold,
    assertBusinessEnabled() { fail('BIZOP_V327_NOT_ENABLED', '业务 OP 新区间功能尚未启用'); },
    getStatus: () => ({ mode: catalog.control().mode, recoveryReady: admission.snapshot().recoveryReady }) });
}

module.exports = { createBizOpV327Module };
