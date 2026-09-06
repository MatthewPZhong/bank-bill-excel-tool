'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createTaskPolicyRegistry } = require('../archive-center/task-policy-registry');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { readVerifiedManifest } = require('./payload-store');
const { hash, fail, count } = require('./contracts');

function createBizOpImportCoordinator({ userDataDir, catalog, payloadStore, protection, admission, sources,
  prepareOperation, prepareDispatch, forgetDispatch, getArchiveService }) {
  async function restoreDiagnostic(taskRunId) {
    const op = catalog.operation(taskRunId);
    if (!op || op.action !== 'IMPORT') return null;
    const intent = payloadStore.readDocument(op.intent_rel_path).value;
    if (intent.phase !== 'xlsx-import-v1') return null;
    const relative = `diagnostics/${intent.reportRef}/manifest.json`;
    if (!fs.existsSync(payloadStore.resolve(relative, { mustExist: false }))) return null;
    protection.refresh(taskRunId);
    if (!protection.closed(taskRunId)) fail('BIZOP_CARRIER_CLOSURE_PENDING');
    const document = payloadStore.readDocument(relative);
    const manifest = document.value;
    if (typeof manifest.catalog.scanComplete !== 'boolean' || typeof manifest.catalog.errorCountExact !== 'boolean'
        || count(manifest.catalog.collectedSamples) > 1000 || count(manifest.catalog.sampleBytes) > 8388608
        || manifest.parts.length !== 1 || manifest.parts[0].byteSize !== manifest.catalog.sampleBytes) fail('BIZOP_REPORT_SUMMARY_MISMATCH');
    const carriers = catalog.db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND plan_digest=?')
      .all(taskRunId, manifest.catalog.producerPlanDigest);
    if (carriers.length !== 1) fail('BIZOP_REPORT_OWNER_MISMATCH');
    const carrier = carriers[0];
    const existing = catalog.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(intent.reportRef);
    if (existing) {
      if (existing.task_run_id !== taskRunId || existing.manifest_digest !== document.digest
          || existing.producer_job_id !== carrier.job_id || existing.producer_session_id !== carrier.session_id) fail('BIZOP_REPORT_OWNER_MISMATCH');
      return existing.report_ref;
    }
    // 诊断最多 8 MiB，独立复核实际样本文件哈希，不能仅根据新读到的元数据登记报告。
    const token = await payloadStore.verifyManifest(relative, document.digest);
    return protection.registerDiagnostic({ taskRunId, jobId: carrier.job_id, sessionId: carrier.session_id, token,
      sampleCount: manifest.catalog.collectedSamples, sampleBytes: manifest.catalog.sampleBytes,
      scanComplete: manifest.catalog.scanComplete, errorCountExact: manifest.catalog.errorCountExact });
  }
  function summaryOf(value) {
    return Object.fromEntries(['scannedDataRows', 'acceptedRows', 'rowErrorCount', 'fileErrorCount',
      'collectedSamples', 'errorSamplesTruncated', 'scanComplete', 'errorCountExact'].map((key) => [key, value[key]]));
  }
  async function runImport({ taskLifecycle, runtime, filePlan, signal, onControl, afterWorker, afterCommit, options = {} }) {
    return admission.exclusive(async () => {
      if (signal?.aborted) return { status: 'cancelled' };
      let taskRunId;
      const candidateRef = `candidate-${randomUUID()}`;
      const reportRef = `report-${randomUUID()}`;
      try {
        const result = await taskLifecycle.runFileTask({
          policy: createTaskPolicyRegistry().require('bizOpReconV327:import'),
          meta: { channel: 'bizOpReconV327:import' }, filePlanResolver: () => filePlan,
          execute: async (context, controls) => {
            taskRunId = context.taskRunId;
            const op = prepareOperation({ taskRunId, operationKey: context.operationKey, actionKey: 'biz-op-v327:import-candidate',
              intent: { phase: 'xlsx-import-v1', candidateRef, reportRef, cellContractVersion: CELL_CONTRACT_VERSION,
                ruleVersion: RULE_VERSION, filePlanDigest: hash(filePlan), commitPlanRef: `operations/${taskRunId}/import-commit.json` } });
            const settled = await controls.settleArtifacts({ files: filePlan.inputs.map((file) => ({ artifactKey: file.artifactKey })) });
            if (!settled.ok || !settled.durable) fail('BIZOP_ORIGINAL_SETTLEMENT_FAILED');
            const originals = catalog.archive.listArtifacts(context.batchId).filter((file) => file.direction === 'input');
            const byKey = new Map(originals.map((file) => [file.artifactKey, file]));
            const files = [];
            const seen = new Set();
            for (let order = 0; order < filePlan.inputs.length; order += 1) {
              const artifact = byKey.get(filePlan.inputs[order].artifactKey);
              if (!artifact) fail('BIZOP_ORIGINAL_SET_INCOMPLETE');
              const original = catalog.original(artifact.id, taskRunId);
              if (seen.has(original.sha256)) continue;
              const verified = await getArchiveService().resolveVerifiedArtifact(artifact.id);
              if (!verified.ok || verified.sha256 !== original.sha256) fail('BIZOP_ORIGINAL_VERIFY_FAILED');
              seen.add(original.sha256);
              files.push({ artifactId: artifact.id, order, sha256: original.sha256, filePath: verified.filePath });
            }
            if (!files.length) fail('BIZOP_INPUT_SET_EMPTY');
            const request = prepareDispatch({ taskContext: context, actionKey: 'biz-op-v327:import-candidate',
              plan: { phase: 'xlsx-import-v1', userDataDir, candidateRef, reportRef, intentDigest: op.intent_digest, files, options } });
            const planDigest = payloadStore.readDocument(`operations/${taskRunId}/${request.input.planRef}.json`).digest;
            const control = runtime.start(request);
            protection.attachControl(control);
            const cancel = () => control.cancel({ reason: '用户取消业务 OP 导入' });
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
            if (afterWorker) await afterWorker({ taskRunId, candidateRef, reportRef, outcome });
            await restoreDiagnostic(taskRunId);
            protection.completeInputObligation(taskRunId);
            if (outcome.outcome !== 'completed') return { status: outcome.outcome === 'cancelled' ? 'cancelled' : 'error',
              code: outcome.error?.code || 'BIZOP_IMPORT_FAILED', reportRef };
            if (outcome.result.planDigest !== planDigest || outcome.result.candidateRef !== candidateRef) fail('BIZOP_IMPORT_RESULT_MISMATCH');
            const imported = payloadStore.readDocument(`operations/${taskRunId}/${candidateRef}.json`, outcome.result.sha256).value;
            if (imported.taskRunId !== taskRunId || imported.intentDigest !== op.intent_digest || imported.candidateRef !== candidateRef
                || imported.reportRef !== reportRef || imported.acceptedRows !== outcome.result.rowCount) fail('BIZOP_IMPORT_RESULT_MISMATCH');
            if (imported.schemaVersion !== 1 || imported.cellContractVersion !== CELL_CONTRACT_VERSION || imported.ruleVersion !== RULE_VERSION
                || !['batchRejected', 'scanComplete', 'errorCountExact', 'cancelled', 'errorSamplesTruncated'].every((key) => typeof imported[key] === 'boolean')
                || count(imported.scannedDataRows) !== count(imported.acceptedRows) + count(imported.rowErrorCount)
                || count(imported.collectedSamples) > 1000 || count(imported.sampleBytes) > 8388608) fail('BIZOP_IMPORT_RESULT_MISMATCH');
            count(imported.fileErrorCount);
            const registeredReport = catalog.db.prepare('SELECT manifest_digest FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(reportRef);
            if (!registeredReport || registeredReport.manifest_digest !== imported.reportManifestDigest) fail('BIZOP_REPORT_SUMMARY_MISMATCH');
            const summary = summaryOf(imported);
            if (imported.batchRejected || !imported.scanComplete || !imported.errorCountExact || imported.rowErrorCount || imported.fileErrorCount) {
              return { status: imported.cancelled ? 'cancelled' : 'error', code: 'BIZOP_IMPORT_REJECTED', reportRef, summary };
            }
            const candidates = [];
            let sealedRows = 0;
            for (const reference of imported.references) {
              const token = await payloadStore.verifyClosedWorkerManifest(`inputs/${reference.objectId}/manifest.json`, reference.digest);
              const manifest = readVerifiedManifest(token);
              if (manifest.catalog.cellContractVersion !== CELL_CONTRACT_VERSION || manifest.catalog.ruleVersion !== RULE_VERSION) fail('BIZOP_CELL_CONTRACT_MISMATCH');
              if (manifest.catalog.sources.reduce((sum, source) => sum + count(source.rowCount), 0) !== manifest.rowCount
                  || manifest.catalog.sources.some((source) => !files.some((file) => file.artifactId === source.artifactId
                    && file.sha256 === source.sha256 && file.order === source.order))) fail('BIZOP_ORIGINAL_SET_INCOMPLETE');
              sealedRows += count(manifest.rowCount);
              candidates.push(token);
            }
            if (sealedRows !== imported.acceptedRows || imported.files.length !== files.length
                || imported.files.some((file, index) => file.artifactId !== files[index].artifactId || !file.scanComplete)
                || imported.files.reduce((sum, file) => sum + count(file.acceptedRows), 0) !== sealedRows) fail('BIZOP_ROW_COUNT_MISMATCH');
            payloadStore.writeDocument(`operations/${taskRunId}/import-commit.json`, { taskRunId, intentDigest: op.intent_digest,
              expectedGeneration: op.expected_generation, importResultDigest: outcome.result.sha256, candidates: imported.references });
            const receipt = catalog.commitImport({ taskRunId, intentDigest: op.intent_digest, candidates });
            if (afterCommit) await afterCommit(receipt);
            return { status: 'ok', receipt, summary };
          }
        });
        if (taskRunId && catalog.receipt(taskRunId)) {
          sources.syncCompletion(sources.operationSource(taskRunId));
          // 成功批次的空诊断通过既有真实维护 Task 回收，不留下无主文件。
          const report = catalog.db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(reportRef);
          if (report && report.sample_count === 0) protection.retireDiagnostic(reportRef, taskRunId);
        } else if (taskRunId) admission.requireRecovery();
        return result;
      } catch (error) { if (taskRunId) admission.requireRecovery(); throw error; }
    });
  }
  return Object.freeze({ runImport, restoreDiagnostic });
}

module.exports = { createBizOpImportCoordinator };
