'use strict';
const { fail, hash } = require('./contracts');
const { EXPORT_IO_RESOURCES } = require('./export-publication');
const { acquireBizOpPhaseLease } = require('./phase-admission');

function createDeletePreservation({ catalog, payloadStore, getArchiveService, getRuntime }) {
  async function verify(closure, { runtime = getRuntime?.(), operationKey, taskRunId, admit = () => {}, committedAt } = {}) {
    if (!closure.runs.length) return;
    if (!runtime?.resourceGovernor || !getArchiveService()) fail('BIZOP_DELETE_PRESERVATION_OWNER_REQUIRED');
    const lease = await acquireBizOpPhaseLease(runtime, { ownerKey: `biz-op-v327:delete-preservation:${taskRunId}`,
      actionKey: 'biz-op-v327:delete-plan', operationKey, resources: EXPORT_IO_RESOURCES, lowMemoryBehavior: 'queue' });
    const originals = new Map();
    try {
      for (const expected of closure.runs) {
        admit();
        const row = catalog.db.prepare('SELECT * FROM biz_op_v327_runs WHERE run_id=?').get(expected.objectId);
        // 更晚的独立删除收据仍有权退出结果；旧 KEEP_RESULTS 不复活用户之后删除的对象。
        if (row?.state === 'DELETED' && committedAt && catalog.db.prepare(`SELECT 1 FROM biz_op_v327_receipts r,
          json_each(r.outcome_json,'$.runIds') v WHERE r.action='DELETE' AND r.committed_at>=? AND r.task_run_id!=? AND v.value=? LIMIT 1`)
          .get(committedAt, taskRunId, expected.objectId)) continue;
        if (!row || row.state !== 'PUBLISHED' || row.payload_manifest_digest !== expected.manifestDigest
            || row.result_version !== expected.version) fail('BIZOP_DELETE_PRESERVATION_CONFLICT', '需要保留的结果状态或文件已变化，已阻断删除收尾');
        await payloadStore.verifyClosedWorkerManifest(row.payload_manifest_rel_path, expected.manifestDigest);
        const refs = catalog.db.prepare(`SELECT artifact_id AS artifactId,source_file_name AS originalName,source_sha256 AS sha256
          FROM biz_op_v327_run_artifacts WHERE run_id=? ORDER BY artifact_id`).all(expected.objectId).map((item) => ({ ...item }));
        if (hash(refs) !== hash(expected.originals)) fail('BIZOP_DELETE_PRESERVATION_CONFLICT');
        for (const source of refs) {
          admit();
          if (!catalog.archive.listArtifactHolds(source.artifactId).some((hold) => hold.ownerModule === 'biz-op-recon'
              && hold.ownerType === 'v327-result' && hold.ownerId === expected.objectId)) fail('BIZOP_DELETE_PRESERVATION_CONFLICT');
          if (!originals.has(source.artifactId)) {
            const verified = await getArchiveService().resolveVerifiedArtifact(source.artifactId);
            if (!verified.ok || verified.sha256 !== source.sha256) fail('BIZOP_DELETE_PRESERVATION_CONFLICT', '历史结果引用的原件无法验证，已保留未决保护');
            originals.set(source.artifactId, verified.sha256);
          } else if (originals.get(source.artifactId) !== source.sha256) fail('BIZOP_DELETE_PRESERVATION_CONFLICT');
        }
      }
    } finally { lease.release('delete-preservation-files-closed'); }
  }
  async function committed(taskRunId, { admit = () => {} } = {}) {
    if (typeof taskRunId !== 'string') return;
    const op = catalog.operation(taskRunId); const receipt = catalog.receipt(taskRunId);
    if (op?.action !== 'DELETE' || receipt?.outcome.deleteMode !== 'KEEP_RESULTS') return;
    const intent = payloadStore.readDocument(op.intent_rel_path, op.intent_digest).value;
    if (!intent.previewBinding) return;
    const preview = catalog.db.prepare('SELECT * FROM biz_op_v327_delete_previews WHERE preview_id=?').get(intent.previewBinding.previewId);
    if (!preview || preview.confirmed_task_id !== taskRunId || preview.confirmed_mode !== 'KEEP_RESULTS'
        || preview.closure_digest !== intent.previewBinding.closureDigest) fail('BIZOP_DELETE_PRESERVATION_CONFLICT');
    const closure = JSON.parse(preview.closure_json);
    if (hash(closure) !== preview.closure_digest) fail('BIZOP_DELETE_PRESERVATION_CONFLICT');
    await verify(closure, { taskRunId, operationKey: op.operation_key, admit, committedAt: receipt.committedAt });
  }
  return { verify, committed };
}
module.exports = { createDeletePreservation };
