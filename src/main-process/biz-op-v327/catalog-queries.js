'use strict';

const { fail } = require('./contracts');

// 仅投影同一 catalog 连接的即时读取；准入、预算和文件验证由调用方保持。
function createBizOpCatalogQueries({ db }) {
  function readActiveDataset(kind, dataDate) {
    const row = db.prepare(`SELECT d.* FROM biz_op_v327_input_heads h JOIN biz_op_v327_datasets d USING(dataset_id)
      WHERE h.kind=? AND h.data_date=? AND d.state='ACTIVE'`).get(kind, dataDate);
    return row ? { datasetId: row.dataset_id, kind: row.kind, dataDate: row.data_date,
      publicVersion: row.public_version, rowCount: row.row_count, sourceManifestDigest: row.source_manifest_digest,
      manifestRelativePath: row.payload_manifest_rel_path, manifestDigest: row.payload_manifest_digest } : null;
  }
  function* iterateDatasetSources(datasetId) {
    for (const row of db.prepare('SELECT * FROM biz_op_v327_dataset_sources WHERE dataset_id=? ORDER BY source_file_order').iterate(datasetId)) {
      yield { artifactId: row.artifact_id, sha256: row.source_sha256, originalName: row.source_file_name,
        order: row.source_file_order, sheetName: row.source_sheet_name, bu: row.normalized_bu, rowCount: row.row_count };
    }
  }
  function readExportObject(outputKind, objectId) {
    let row; let source;
    if (outputKind.startsWith('RESULT_')) {
      row = db.prepare("SELECT * FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(objectId);
      if (row) source = { objectKind: 'RESULT', metadata: { version: row.result_version,
        startDate: row.start_date, endDate: row.end_date, inputFingerprint: row.input_fingerprint, publishedAt: row.published_at } };
      if (source) {
        const endpoints = db.prepare("SELECT role,input_version FROM biz_op_v327_run_inputs WHERE run_id=? AND role IN ('START_OP','END_OP')").all(objectId);
        if (endpoints.length !== 2) fail('BIZOP_EXPORT_INPUT_METADATA_MISSING');
        source.metadata.startInputVersion = endpoints.find((item) => item.role === 'START_OP')?.input_version;
        source.metadata.endInputVersion = endpoints.find((item) => item.role === 'END_OP')?.input_version;
        if (!source.metadata.startInputVersion || !source.metadata.endInputVersion) fail('BIZOP_EXPORT_INPUT_METADATA_MISSING');
      }
    } else if (outputKind === 'ERRORS') {
      row = db.prepare(`SELECT d.*,l.sealed_manifest_rel_path AS payload_manifest_rel_path,d.manifest_digest AS payload_manifest_digest
        FROM biz_op_v327_diagnostic_reports d JOIN biz_op_v327_diagnostic_lifecycle l USING(report_ref)
        WHERE report_ref=? AND state='READY'`).get(objectId);
      if (row) source = { objectKind: 'DIAGNOSTIC', metadata: { producerTaskRunId: row.task_run_id,
        scanComplete: Boolean(row.scan_complete), errorCountExact: Boolean(row.error_count_exact), sampleCount: row.sample_count } };
    } else {
      row = db.prepare("SELECT * FROM biz_op_v327_datasets WHERE dataset_id=? AND state='ACTIVE' AND kind=?")
        .get(objectId, outputKind.split('_')[0]);
      if (row) source = { objectKind: 'DATASET', metadata: { version: row.public_version, dataDate: row.data_date,
        sourceManifestDigest: row.source_manifest_digest, activatedAt: row.activated_at } };
    }
    return source ? { ...source, manifestRelativePath: row.payload_manifest_rel_path, manifestDigest: row.payload_manifest_digest } : null;
  }
  function readActiveDatasetForDelete(datasetId) {
    const row = db.prepare("SELECT * FROM biz_op_v327_datasets WHERE dataset_id=? AND state='ACTIVE'").get(datasetId);
    return row ? { datasetId: row.dataset_id, kind: row.kind, dataDate: row.data_date,
      publicVersion: row.public_version, activatedAt: row.activated_at } : null;
  }
  function* iteratePublishedRunIdsUsingDataset(datasetId) {
    for (const row of db.prepare(`SELECT DISTINCT r.run_id FROM biz_op_v327_runs r JOIN biz_op_v327_run_inputs i USING(run_id)
      WHERE i.dataset_id=? AND r.state='PUBLISHED'`).iterate(datasetId)) yield row.run_id;
  }
  function readPublishedRunForDelete(runId) {
    const row = db.prepare("SELECT * FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(runId);
    return row ? { runId: row.run_id, startDate: row.start_date, endDate: row.end_date, resultVersion: row.result_version,
      manifestDigest: row.payload_manifest_digest, operationMonth: row.operation_month } : null;
  }
  function* iterateRunArtifacts(runId) {
    for (const row of db.prepare('SELECT * FROM biz_op_v327_run_artifacts WHERE run_id=? ORDER BY artifact_id').iterate(runId)) {
      yield { artifactId: row.artifact_id, originalName: row.source_file_name, sha256: row.source_sha256 };
    }
  }
  function readDispatchesForPlan(taskRunId, planDigest) {
    return db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND plan_digest=?').all(taskRunId, planDigest);
  }
  function readDiagnosticByRef(reportRef) {
    return db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(reportRef) || null;
  }
  return Object.freeze({ readActiveDataset, iterateDatasetSources, readExportObject, readActiveDatasetForDelete,
    iteratePublishedRunIdsUsingDataset, readPublishedRunForDelete, iterateRunArtifacts, readDispatchesForPlan, readDiagnosticByRef });
}

module.exports = { createBizOpCatalogQueries };
