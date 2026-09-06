'use strict';

const { schemaFor } = require('./export-cells');
const { fail, opaque, snapshot } = require('./contracts');

async function freezeExportSource({ catalog, payloadStore, getArchiveService, outputKind, objectId, columnSchemaVersion = 1 }) {
  schemaFor(outputKind, columnSchemaVersion); opaque(objectId);
  let row; let source;
  if (outputKind.startsWith('RESULT_')) {
    row = catalog.db.prepare("SELECT * FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(objectId);
    if (row) source = { objectKind: 'RESULT', metadata: { version: row.result_version,
      startDate: row.start_date, endDate: row.end_date, inputFingerprint: row.input_fingerprint, publishedAt: row.published_at } };
    if (source) {
      const endpoints = catalog.db.prepare("SELECT role,input_version FROM biz_op_v327_run_inputs WHERE run_id=? AND role IN ('START_OP','END_OP')").all(objectId);
      if (endpoints.length !== 2) fail('BIZOP_EXPORT_INPUT_METADATA_MISSING');
      source.metadata.startInputVersion = endpoints.find((item) => item.role === 'START_OP')?.input_version;
      source.metadata.endInputVersion = endpoints.find((item) => item.role === 'END_OP')?.input_version;
      if (!source.metadata.startInputVersion || !source.metadata.endInputVersion) fail('BIZOP_EXPORT_INPUT_METADATA_MISSING');
    }
  } else if (outputKind === 'ERRORS') {
    row = catalog.db.prepare(`SELECT d.*,l.sealed_manifest_rel_path AS payload_manifest_rel_path,d.manifest_digest AS payload_manifest_digest
      FROM biz_op_v327_diagnostic_reports d JOIN biz_op_v327_diagnostic_lifecycle l USING(report_ref)
      WHERE report_ref=? AND state='READY'`).get(objectId);
    if (row) source = { objectKind: 'DIAGNOSTIC', metadata: { producerTaskRunId: row.task_run_id,
      scanComplete: Boolean(row.scan_complete), errorCountExact: Boolean(row.error_count_exact), sampleCount: row.sample_count } };
  } else {
    row = catalog.db.prepare("SELECT * FROM biz_op_v327_datasets WHERE dataset_id=? AND state='ACTIVE' AND kind=?")
      .get(objectId, outputKind.split('_')[0]);
    if (row) source = { objectKind: 'DATASET', metadata: { version: row.public_version, dataDate: row.data_date,
      sourceManifestDigest: row.source_manifest_digest, activatedAt: row.activated_at } };
  }
  if (!row || !source) fail('BIZOP_EXPORT_SOURCE_UNAVAILABLE');
  Object.assign(source, { outputKind, columnSchemaVersion, objectId,
    manifestRelativePath: row.payload_manifest_rel_path, manifestDigest: row.payload_manifest_digest });
  if (outputKind.endsWith('_RAW')) {
    const manifest = payloadStore.readDocument(source.manifestRelativePath, source.manifestDigest).value;
    source.originals = [];
    for (const original of manifest.catalog.sources) {
      const artifact = catalog.archive.getArtifact(original.artifactId);
      if (!artifact || artifact.status !== 'ready' || artifact.blob.sha256 !== original.sha256
          || !catalog.archive.listArtifactHolds(original.artifactId).some((hold) => hold.ownerType === 'v327-input'
            && hold.ownerModule === 'biz-op-recon' && hold.ownerId === objectId)) fail('BIZOP_EXPORT_ORIGINAL_UNPROTECTED');
      const file = await getArchiveService().resolveVerifiedArtifact(original.artifactId);
      if (!file.ok || file.sha256 !== original.sha256) fail('BIZOP_EXPORT_ORIGINAL_CHANGED');
      source.originals.push({ ...original, filePath: file.filePath, sizeBytes: file.sizeBytes, originalName: artifact.fileName || artifact.originalName || '' });
    }
  }
  return snapshot(source, { maxBytes: 65536 });
}
module.exports = { freezeExportSource };
