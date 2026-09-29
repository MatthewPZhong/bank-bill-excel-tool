'use strict';

const { fail, hash, snapshot, count } = require('./contracts');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { compareText } = require('./compute-group');
const { COMPUTE_RULE_VERSION } = require('./result-schema');

function intervalInputs(startDate, endDate) {
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('BIZOP_INTERVAL_INVALID', '起止日期须为有效公历日期');
    const time = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) fail('BIZOP_INTERVAL_INVALID');
    return time;
  }
  const start = timestamp(startDate); const end = timestamp(endDate);
  if (start >= end) fail('BIZOP_INTERVAL_INVALID', '起始日期须早于终止日期');
  if ((end - start) / 86400000 + 2 > 4096) fail('BIZOP_RUN_INPUT_BUDGET', '区间清单超出当前元数据预算');
  const required = [{ role: 'START_OP', kind: 'OP', dataDate: startDate }, { role: 'END_OP', kind: 'OP', dataDate: endDate }];
  for (let date = start + 86400000; date <= end; date += 86400000) required.push({ role: 'FLOW', kind: 'FLOW', dataDate: new Date(date).toISOString().slice(0, 10) });
  return required;
}
function fingerprintOf({ startDate, endDate, inputs, bus, originalDigests }) {
  return hash({ fingerprintVersion: 2, startDate, endDate, bus, inputs,
    originalsDigest: hash(originalDigests), cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION,
    computeRuleVersion: COMPUTE_RULE_VERSION });
}
function collectInputs({ catalog, payloadStore, startDate, endDate }) {
  const required = intervalInputs(startDate, endDate);
  const documents = []; const missing = []; const bus = new Set(); const originals = new Map();
  let metadataCount = required.length;
  const selected = [];
  for (const item of required) {
    const dataset = catalog.queries.readActiveDataset(item.kind, item.dataDate);
    if (!dataset) { missing.push(item); continue; }
    selected.push({ item, dataset });
  }
  if (missing.length) throw Object.assign(new Error('所选区间缺少必需的校验表，未开始核对'), { code: 'BIZOP_RUN_INPUT_MISSING', missing: snapshot(missing) });
  for (const { item, dataset } of selected) {
    const reference = { role: item.role, dataDate: item.dataDate, datasetId: dataset.datasetId,
      inputVersion: dataset.publicVersion, sourceManifestDigest: dataset.sourceManifestDigest };
    const sources = [];
    for (const source of catalog.queries.iterateDatasetSources(dataset.datasetId)) {
      if (++metadataCount > 4096) fail('BIZOP_RUN_INPUT_BUDGET');
      const artifact = catalog.archive.getArtifact(source.artifactId);
      if (!artifact || artifact.status !== 'ready' || artifact.blob?.sha256 !== source.sha256) fail('BIZOP_RUN_ORIGINAL_UNAVAILABLE');
      const hold = catalog.archive.listArtifactHolds(source.artifactId).some((value) => value.ownerModule === 'biz-op-recon'
        && value.ownerType === 'v327-input' && value.ownerId === dataset.datasetId);
      if (!hold) fail('BIZOP_RUN_ORIGINAL_UNPROTECTED');
      bus.add(source.bu); originals.set(source.artifactId, source.sha256);
      sources.push({ artifactId: source.artifactId, sha256: source.sha256, originalName: source.originalName,
        order: source.order, sheetName: source.sheetName, bu: source.bu, rowCount: source.rowCount });
    }
    if (!sources.length || sources.reduce((sum, source) => sum + count(source.rowCount), 0) !== dataset.rowCount) fail('BIZOP_RUN_SOURCE_COUNT_MISMATCH');
    const manifest = payloadStore.readDocument(dataset.manifestRelativePath, dataset.manifestDigest).value;
    if (manifest.objectId !== dataset.datasetId || manifest.objectKind !== 'DATASET' || manifest.rowCount !== dataset.rowCount
        || manifest.catalog.sourceManifestDigest !== dataset.sourceManifestDigest
        || manifest.catalog.cellContractVersion !== CELL_CONTRACT_VERSION || manifest.catalog.ruleVersion !== RULE_VERSION) fail('BIZOP_RUN_INPUT_CONTRACT_MISMATCH');
    documents.push({ ...reference, kind: item.kind, rowCount: dataset.rowCount, sources,
      manifestRelativePath: dataset.manifestRelativePath, manifestDigest: dataset.manifestDigest });
  }
  const inputs = documents.map(({ role, dataDate, datasetId, inputVersion, sourceManifestDigest }) => ({ role, dataDate, datasetId, inputVersion, sourceManifestDigest }));
  const actualBus = [...bus].sort(compareText);
  const originalDigests = [...new Set(originals.values())].sort(compareText);
  const inputFingerprint = fingerprintOf({ startDate, endDate, inputs, bus: actualBus, originalDigests });
  // 先证明完整快照可编码，再创建 Task/计划；超限不能以清单前缀继续。
  snapshot({ startDate, endDate, inputs, bus: actualBus, originalDigests }, { maxBytes: 65536 });
  return { startDate, endDate, documents, inputs, bus: actualBus, originalDigests, inputFingerprint,
    expectedGeneration: catalog.control().generation };
}
async function persistInputs({ frozen, payloadStore, getArchiveService, taskRunId }) {
  const references = []; const files = new Map();
  for (let index = 0; index < frozen.documents.length; index += 1) {
    const document = frozen.documents[index];
    const sources = [];
    for (const source of document.sources) {
      let verified = files.get(source.artifactId);
      if (!verified) {
        verified = await getArchiveService().resolveVerifiedArtifact(source.artifactId);
        if (!verified.ok || verified.sha256 !== source.sha256) fail('BIZOP_RUN_ORIGINAL_UNAVAILABLE');
        files.set(source.artifactId, verified);
      }
      sources.push({ ...source, filePath: verified.filePath, sizeBytes: verified.sizeBytes });
    }
    const relativePath = `operations/${taskRunId}/input-${index + 1}.json`;
    const written = payloadStore.writeDocument(relativePath, { ...document, sources });
    references.push({ relativePath, digest: written.digest });
  }
  const root = { schemaVersion: 1, taskRunId, startDate: frozen.startDate, endDate: frozen.endDate,
    inputs: frozen.inputs, bus: frozen.bus, originalDigests: frozen.originalDigests, inputFingerprint: frozen.inputFingerprint,
    cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION, computeRuleVersion: COMPUTE_RULE_VERSION, references };
  const relativePath = `operations/${taskRunId}/compute-inputs.json`;
  const written = payloadStore.writeDocument(relativePath, root);
  return { relativePath, digest: written.digest };
}

module.exports = { intervalInputs, fingerprintOf, collectInputs, persistInputs };
