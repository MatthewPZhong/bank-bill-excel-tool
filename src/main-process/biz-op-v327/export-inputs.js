'use strict';

const { schemaFor } = require('./export-cells');
const { resultContractFor } = require('./result-schema');
const { fail, opaque, snapshot } = require('./contracts');

async function freezeExportSource({ catalog, payloadStore, getArchiveService, outputKind, objectId, columnSchemaVersion }) {
  schemaFor(outputKind, columnSchemaVersion); opaque(objectId);
  const object = catalog.queries.readExportObject(outputKind, objectId);
  if (!object) fail('BIZOP_EXPORT_SOURCE_UNAVAILABLE');
  // 按原位置装配快照字段，避免查询的内部字段透传到导出合同。
  const source = { objectKind: object.objectKind, metadata: object.metadata };
  if (source.objectKind === 'RESULT') {
    const manifest = payloadStore.readDocument(object.manifestRelativePath, object.manifestDigest).value;
    if (manifest.objectId !== objectId || manifest.objectKind !== 'RESULT') fail('BIZOP_EXPORT_OWNER_MISMATCH');
    const contract = resultContractFor(manifest.catalog);
    if (columnSchemaVersion !== undefined && columnSchemaVersion !== contract.columnSchemaVersion) fail('BIZOP_EXPORT_CONTRACT_MISMATCH');
    columnSchemaVersion = contract.columnSchemaVersion;
  } else if (columnSchemaVersion === undefined) columnSchemaVersion = 1;
  Object.assign(source, { outputKind, columnSchemaVersion, objectId,
    manifestRelativePath: object.manifestRelativePath, manifestDigest: object.manifestDigest });
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
