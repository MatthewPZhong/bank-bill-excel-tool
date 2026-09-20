'use strict';

const { randomUUID } = require('node:crypto');
const { fail, opaque, hash, snapshot } = require('./contracts');
const { outputName } = require('./export-cells');

function normalizeSelection({ datasetIds = [], runIds = [] } = {}) {
  if (!Array.isArray(datasetIds) || !Array.isArray(runIds) || !datasetIds.length && !runIds.length
      || datasetIds.length + runIds.length > 4096) fail('BIZOP_DELETE_SELECTION_INVALID', '请先选取要删除的数据');
  return { datasetIds: [...new Set(datasetIds.map((id) => opaque(id)))].sort(), runIds: [...new Set(runIds.map((id) => opaque(id)))].sort() };
}
function createBizOpDeletePreview({ catalog, admission }) {
  const { db, now } = catalog;
  function collect(input) {
    const selection = normalizeSelection(input); const generation = catalog.control().generation;
    const runIds = new Set(selection.runIds); const artifacts = new Set(); let bytes = 0; let evaluated = 0;
    const charge = (value) => {
      bytes += Buffer.byteLength(JSON.stringify(value)); evaluated += 1;
      if (bytes > 49152 || evaluated > 4096) fail('BIZOP_DELETE_PREVIEW_LIMIT', '完整删除影响超过当前预览预算，请缩小选取范围或先选取结果表分批处理');
      return value;
    };
    const datasets = selection.datasetIds.map((id) => {
      const row = db.prepare("SELECT * FROM biz_op_v327_datasets WHERE dataset_id=? AND state='ACTIVE'").get(id);
      if (!row) fail('BIZOP_DELETE_SELECTION_CHANGED', '选取的数据已被覆盖或删除，请重新选取');
      const originals = [];
      for (const item of db.prepare('SELECT artifact_id,source_file_name,source_sha256 FROM biz_op_v327_dataset_sources WHERE dataset_id=? ORDER BY source_file_order').iterate(id)) {
        artifacts.add(item.artifact_id); originals.push(charge({ artifactId: item.artifact_id, originalName: item.source_file_name, sha256: item.source_sha256 }));
      }
      for (const related of db.prepare(`SELECT DISTINCT r.run_id FROM biz_op_v327_runs r JOIN biz_op_v327_run_inputs i USING(run_id)
        WHERE i.dataset_id=? AND r.state='PUBLISHED'`).iterate(id)) {
        runIds.add(related.run_id); if (runIds.size > 4096) fail('BIZOP_DELETE_PREVIEW_LIMIT');
      }
      return charge({ objectId: id, kind: row.kind, dataDate: row.data_date, version: row.public_version,
        operationMonth: row.activated_at.slice(0, 7), originals });
    });
    const runs = [...runIds].sort().map((id) => {
      const row = db.prepare("SELECT * FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(id);
      if (!row) fail('BIZOP_DELETE_SELECTION_CHANGED', '选取的结果表已被删除，请重新选取');
      const originals = [];
      for (const item of db.prepare('SELECT * FROM biz_op_v327_run_artifacts WHERE run_id=? ORDER BY artifact_id').iterate(id)) {
        artifacts.add(item.artifact_id); originals.push(charge({ artifactId: item.artifact_id, originalName: item.source_file_name, sha256: item.source_sha256 }));
      }
      return charge({ objectId: id, startDate: row.start_date, endDate: row.end_date, version: row.result_version,
        manifestDigest: row.payload_manifest_digest,
        operationMonth: row.operation_month, tableName: outputName('RESULT_DIFF', { startDate: row.start_date, endDate: row.end_date, version: row.result_version }),
        directlySelected: selection.runIds.includes(id), originals });
    });
    const inputOwners = new Set(selection.datasetIds);
    const references = { originalCount: artifacts.size, protectedAfterKeep: 0, protectedAfterDelete: 0, userLockedOriginals: 0, sharedBlobOriginals: 0 };
    for (const id of artifacts) {
      const artifact = catalog.archive.getArtifact(id); if (!artifact) fail('BIZOP_DELETE_ORIGINAL_CHANGED');
      const locked = catalog.archive.getBatch(artifact.batchId).locked;
      // 当前 artifact 的业务保护与相同 blob 的其他归档引用分别计数；本模块从不删除归档文件。
      if (artifact.blobId && db.prepare('SELECT 1 FROM archive_artifacts WHERE blob_id=? AND id!=? LIMIT 1').get(artifact.blobId, id)) references.sharedBlobOriginals += 1;
      if (locked) references.userLockedOriginals += 1;
      let keep = locked; let remove = locked;
      for (const hold of catalog.archive.listArtifactHolds(id)) {
        charge({ artifactId: id, ownerModule: hold.ownerModule, ownerType: hold.ownerType, ownerId: hold.ownerId });
        const inputRemoved = hold.ownerModule === 'biz-op-recon' && hold.ownerType === 'v327-input' && inputOwners.has(hold.ownerId);
        const resultRemoved = hold.ownerModule === 'biz-op-recon' && hold.ownerType === 'v327-result' && runIds.has(hold.ownerId);
        if (!inputRemoved) keep = true;
        if (!inputRemoved && !resultRemoved) remove = true;
      }
      if (keep) references.protectedAfterKeep += 1;
      if (remove) references.protectedAfterDelete += 1;
    }
    return snapshot({ schemaVersion: 1, generation, selection, datasets, runs, references }, { maxBytes: 65536 });
  }
  function get(previewId) {
    opaque(previewId);
    const row = db.prepare('SELECT * FROM biz_op_v327_delete_previews WHERE preview_id=?').get(previewId);
    if (!row) fail('BIZOP_DELETE_PREVIEW_EXPIRED', '删除预览已失效，请重新预览');
    const closure = JSON.parse(row.closure_json);
    if (hash(closure) !== row.closure_digest || closure.generation !== row.generation) fail('BIZOP_DELETE_PREVIEW_CHANGED');
    return { row, closure };
  }
  function create(selection) {
    return admission.read(() => {
      const closure = collect(selection); const previewId = `preview-${randomUUID()}`; const createdAt = now();
      const expiresAt = new Date(Date.parse(createdAt) + 10 * 60000).toISOString();
      catalog.transaction(() => {
        db.prepare('DELETE FROM biz_op_v327_delete_previews WHERE expires_at<? AND confirmed_task_id IS NULL').run(createdAt);
        if (db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_delete_previews WHERE confirmed_task_id IS NULL').get().n >= 64) {
          fail('BIZOP_DELETE_PREVIEW_BUSY', '待确认的删除预览过多，请稍后重试');
        }
        db.prepare('INSERT INTO biz_op_v327_delete_previews(preview_id,generation,closure_json,closure_digest,created_at,expires_at) VALUES (?,?,?,?,?,?)')
          .run(previewId, closure.generation, JSON.stringify(closure), hash(closure), createdAt, expiresAt);
      });
      return snapshot({ previewId, expiresAt, ...closure }, { maxBytes: 131072 });
    });
  }
  function validate(previewId, mode) {
    const value = get(previewId); const { row, closure } = value;
    if (!['KEEP_RESULTS', 'DELETE_ASSOCIATED'].includes(mode) || mode === 'KEEP_RESULTS' && closure.selection.runIds.length) fail('BIZOP_DELETE_MODE_INVALID');
    if (row.confirmed_mode && row.confirmed_mode !== mode) fail('BIZOP_DELETE_MODE_CONFLICT');
    if (row.confirmed_task_id) return value;
    if (row.expires_at <= now()) fail('BIZOP_DELETE_PREVIEW_EXPIRED', '删除预览已过期，请重新预览');
    if (catalog.control().generation !== row.generation || hash(collect(closure.selection)) !== row.closure_digest) {
      fail('BIZOP_DELETE_PREVIEW_STALE', '数据或保护状态已变化，请重新查看删除影响并确认');
    }
    return value;
  }
  function bind(previewId, mode, taskRunId) {
    admission.assertExclusive();
    const value = validate(previewId, mode);
    if (value.row.confirmed_task_id) fail('BIZOP_DELETE_PREVIEW_USED');
    if (db.prepare('UPDATE biz_op_v327_delete_previews SET confirmed_task_id=?,confirmed_mode=? WHERE preview_id=? AND confirmed_task_id IS NULL')
      .run(taskRunId, mode, previewId).changes !== 1) fail('BIZOP_DELETE_PREVIEW_USED');
  }
  return { create, get, collect, validate, bind };
}
module.exports = { createBizOpDeletePreview, normalizeSelection };
