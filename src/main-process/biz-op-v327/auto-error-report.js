'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeFilePlanV1 } = require('../archive-center/file-plan');
const { hashClosedFile } = require('./export-validator');
const { acquireBizOpPhaseLease } = require('./phase-admission');
const { EXPORT_IO_RESOURCES } = require('./export-publication');
const { count, fail, opaque } = require('./contracts');

const CODE = Object.freeze({
  failed: 'BIZOP_AUTO_REPORT_SAVE_FAILED',
  recovery: 'BIZOP_AUTO_REPORT_RECOVERY_REQUIRED',
  pending: 'BIZOP_AUTO_REPORT_PUBLICATION_PENDING',
  unavailable: 'BIZOP_AUTO_REPORT_UNAVAILABLE'
});
const MESSAGE = Object.freeze({
  failed: '错误报告未能自动保存；请检查目录权限、可用磁盘空间或任务记录，排除问题后重新导入。原业务结果不变。',
  recovery: '模块恢复尚未就绪，错误报告未能自动保存；请先完成恢复。',
  pending: '错误报告已进入发布流程，保存结果仍待核验；请完成模块恢复后检查。',
  unavailable: '本次任务没有可用的结构化错误报告，原业务错误信息已保留。'
});

function reportError(status, kind = status, taskRunId) {
  return { status, code: CODE[kind], message: MESSAGE[kind], ...(taskRunId ? { taskRunId } : {}) };
}

function saveFailure(error, taskRunId) {
  const code = error?.code;
  let message = MESSAGE.failed;
  // 仅分类已知错误码；系统异常的 message、path 和堆栈不进入页面反馈。
  if (['EACCES', 'EPERM'].includes(code)) {
    message = '错误报告保存目录没有写入权限；请检查文档目录权限，排除问题后重新导入。';
  } else if (code === 'ENOSPC') {
    message = '保存错误报告的磁盘空间不足；请释放空间后重新导入。';
  } else if (['ENOTDIR', 'EISDIR', 'EEXIST', 'BIZOP_AUTO_REPORT_TARGET_INVALID', 'ARCHIVE_FILE_PLAN_INVALID',
    'ARCHIVE_TARGET_CHANGED', 'ARCHIVE_TARGET_PARENT_CHANGED', 'TOOLBOX_PUBLICATION_DESTINATION_EXISTS',
    'TOOLBOX_PUBLICATION_TARGET_CHANGED', 'TOOLBOX_PUBLICATION_TARGET_CHANGED_SINCE_CONFIRMATION',
    'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED'].includes(code)) {
    message = '错误报告目标或父目录被占用、已变化或不可用；请检查文档目录下的 error-reports 目录，排除问题后重新导入。';
  } else if (code === 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT') {
    message = '自动保存所需资源超过本次应用预算；请释放内存后重新启动应用，再重新导入。';
  } else if (code === 'BIZOP_RESOURCE_WAIT_TIMEOUT') {
    message = '自动保存等待后台资源超过 5 秒；请等待其他任务结束后重新导入。';
  } else if (code === 'BIZOP_RECOVERY_REQUIRED') {
    return reportError('failed', 'recovery', taskRunId);
  }
  return { ...reportError('failed', 'failed', taskRunId), message };
}

function createBizOpAutoErrorReportService({ getStorageRoot, module, now = () => new Date(), uuid = randomUUID }) {
  function diagnostic(identity) {
    return module.admission.read(() => {
      const { taskRunId, reportRef } = identity;
      opaque(taskRunId); opaque(reportRef);
      const operation = module.catalog.operation(taskRunId);
      if (!operation || operation.action !== 'IMPORT') fail(CODE.unavailable);
      const intent = module.payloadStore.readDocument(operation.intent_rel_path, operation.intent_digest).value;
      if (intent.phase !== 'xlsx-import-v1' || intent.reportRef !== reportRef) fail(CODE.unavailable);
      const row = module.catalog.db.prepare(`SELECT d.*,l.sealed_manifest_rel_path
        FROM biz_op_v327_diagnostic_reports d JOIN biz_op_v327_diagnostic_lifecycle l USING(report_ref)
        WHERE report_ref=? AND state='READY'`).get(reportRef);
      if (!row || row.task_run_id !== taskRunId || row.sealed_manifest_rel_path !== `diagnostics/${reportRef}/manifest.json`
          || !module.protection.closed(taskRunId)) fail(CODE.unavailable);
      // 这里只同步读取有界的封存元数据；样本正文由原 ERRORS Task 在 pin 保护下再次验证。
      const manifest = module.payloadStore.readDocument(row.sealed_manifest_rel_path, row.manifest_digest).value;
      if (manifest.schemaVersion !== 1 || manifest.objectKind !== 'DIAGNOSTIC' || manifest.objectId !== reportRef || manifest.taskRunId !== taskRunId
          || manifest.intentDigest !== operation.intent_digest || count(manifest.rowCount) !== row.sample_count
          || !Array.isArray(manifest.parts) || manifest.parts.length !== 1
          || count(manifest.parts[0].rowCount) !== row.sample_count || count(manifest.parts[0].byteSize) !== row.sample_bytes
          || count(manifest.catalog.collectedSamples) !== row.sample_count || count(manifest.catalog.sampleBytes) !== row.sample_bytes
          || row.sample_count > 1000 || row.sample_bytes > 8388608
          || typeof manifest.catalog.scanComplete !== 'boolean' || typeof manifest.catalog.errorCountExact !== 'boolean'
          || typeof manifest.catalog.errorSamplesTruncated !== 'boolean'
          || Number(manifest.catalog.scanComplete) !== row.scan_complete || Number(manifest.catalog.errorCountExact) !== row.error_count_exact) {
        fail(CODE.unavailable);
      }
      const carriers = module.catalog.db.prepare(`SELECT job_id,session_id FROM biz_op_v327_dispatches
        WHERE task_run_id=? AND plan_digest=?`).all(taskRunId, manifest.catalog.producerPlanDigest);
      if (carriers.length !== 1 || carriers[0].job_id !== row.producer_job_id
          || carriers[0].session_id !== row.producer_session_id) fail(CODE.unavailable);
      return { sampleCount: row.sample_count, scanComplete: manifest.catalog.scanComplete,
        errorCountExact: manifest.catalog.errorCountExact, errorSamplesTruncated: manifest.catalog.errorSamplesTruncated };
    });
  }

  async function targetPlan() {
    const root = getStorageRoot();
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('BIZOP_AUTO_REPORT_TARGET_INVALID');
    const time = new Date(now());
    if (!Number.isFinite(time.getTime())) fail(CODE.failed);
    const pad = (value) => String(value).padStart(2, '0');
    const date = [time.getFullYear(), pad(time.getMonth() + 1), pad(time.getDate())].join('-');
    const clock = [time.getHours(), time.getMinutes(), time.getSeconds()].map(pad).join('');
    const nonce = uuid();
    if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(nonce)) fail(CODE.failed);
    const fileName = `业务OP导入错误报告-${date.replaceAll('-', '')}-${clock}-${nonce}.xlsx`;
    const relativePath = path.posix.join('error-reports', date, fileName);
    const targetPath = path.join(root, 'error-reports', date, fileName);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [],
      outputs: [{ filePath: targetPath, role: 'output', sourceOperation: 'bizOpReconV327:export:errors' }] });
    // 冻结不存在的目标。之后出现的占用由原 FilePlan/Publisher 拒绝，绝不把重名当成覆盖许可。
    if (filePlan.outputs[0].targetSnapshot.exists) fail('EEXIST');
    return { filePlan, targetPath, fileName, relativePath };
  }

  async function savedFact(taskRunId, target, runtime) {
    const observed = module.publication.fact(taskRunId);
    if (observed?.state !== 'COMMITTED') return observed?.state === 'NOT_COMMITTED' ? 'failed' : null;
    const file = observed.outcome.files?.[0];
    if (observed.outcome.files?.length !== 1 || file.filePath !== target.targetPath) fail(CODE.pending);
    const binding = module.publication.binding(taskRunId);
    const lease = await acquireBizOpPhaseLease(runtime, {
      ownerKey: `biz-op-v327:auto-report-verify:${taskRunId}`, actionKey: 'biz-op-v327:export-errors',
      operationKey: binding.batchContext.operationKey, resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'queue'
    });
    try {
      // 复用既有句柄身份和摘要校验；单凭 COMMITTED 记录或目标存在不能声称文件仍然有效。
      const measured = await hashClosedFile(target.targetPath);
      if (measured.sha256 !== file.sha256 || measured.byteSize !== file.byteSize) fail(CODE.pending);
    } finally { lease.release('auto-report-target-verified'); }
    return 'saved';
  }

  async function save({ identity, businessResult, taskLifecycle, runtime, signal, onControl, onTaskIdentified, recoveryReady }) {
    if (businessResult?.status === 'cancelled' || signal?.aborted) return {};
    const summary = businessResult?.summary;
    const successWithoutErrors = businessResult?.status === 'ok' && summary
      && summary.rowErrorCount === 0 && summary.fileErrorCount === 0
      && summary.collectedSamples === 0 && summary.scanComplete === true && summary.errorCountExact === true;
    if (successWithoutErrors) return {};
    if (!identity?.taskRunId || !identity?.reportRef) return businessResult?.status === 'ok'
      ? {} : { errorReport: reportError('unavailable') };
    if (recoveryReady === false || !module.admission.snapshot().recoveryReady) {
      return { errorReport: reportError('failed', 'recovery'), cleanupPending: true };
    }
    let descriptor;
    try { descriptor = diagnostic(identity); }
    catch (error) {
      if (error.code === 'BIZOP_RECOVERY_REQUIRED') return {
        errorReport: reportError('failed', 'recovery'), cleanupPending: true };
      return { errorReport: reportError('unavailable') };
    }
    // Main 在无业务错误的 worker 完成后仍可能失败，不能把这种内部空诊断当成错误报告。
    // 样本为零但发生截断或扫描不完整时，原 ERRORS 说明仍有实际诊断意义。
    if (descriptor.sampleCount === 0 && descriptor.scanComplete && descriptor.errorCountExact
        && !descriptor.errorSamplesTruncated && !summary?.rowErrorCount && !summary?.fileErrorCount) {
      return businessResult?.status === 'ok' ? {} : { errorReport: reportError('unavailable') };
    }
    let target;
    try { target = await targetPlan(); }
    catch (error) { return { errorReport: saveFailure(error) }; }
    if (signal?.aborted) return {};
    let taskRunId; let exported; let exportError;
    try {
      exported = await module.runExport({ taskLifecycle, runtime, outputKind: 'ERRORS', objectId: identity.reportRef,
        filePlan: target.filePlan, signal, onControl,
        onTaskIdentified(value) {
          taskRunId = opaque(value.taskRunId);
          if (onTaskIdentified) onTaskIdentified(Object.freeze({ taskRunId }));
        } });
      // 正常返回也必须引用本次真实导出 Task；不接受业务任务或无绑定路径代替发布证据。
      if (!taskRunId && exported?.taskRunId) taskRunId = opaque(exported.taskRunId);
      if (exported?.status !== 'ok') exportError = exported;
    } catch (error) { exportError = error; }
    let cleanupPending = false;
    try {
      const recovered = await module.recovery.run();
      cleanupPending = recovered?.ready !== true || !module.admission.snapshot().recoveryReady;
    } catch { cleanupPending = true; }
    if (!taskRunId) return { errorReport: saveFailure(exportError), cleanupPending };
    try {
      const fact = await savedFact(taskRunId, target, runtime);
      if (fact === 'saved') {
        const row = module.publication.record(taskRunId);
        return { errorReport: { status: 'saved', fileName: target.fileName, relativePath: target.relativePath,
          taskRunId, pendingArchiveHandoff: row?.archive_settled !== 1 }, cleanupPending };
      }
      const row = module.publication.record(taskRunId);
      if (fact === 'failed' || !row || row.state === 'NOT_STARTED') {
        return { errorReport: saveFailure(exportError, taskRunId), cleanupPending };
      }
    } catch { /* 已开始发布但无法核实完整事实时，保留原任务，禁止换目标重复导出。 */ }
    return { errorReport: reportError('pending', 'pending', taskRunId), cleanupPending };
  }

  return Object.freeze({ save });
}

module.exports = { createBizOpAutoErrorReportService };
