'use strict';

const { fail, hash, snapshot } = require('./contracts');
const { normalizeSelection } = require('./delete-preview');

async function runDeletePipeline({ payloadStore, taskRunId, candidateRef, intentDigest, sourceRef, cancelToken }) {
  if (cancelToken.cancelled) fail('BIZOP_CANCELLED');
  const source = payloadStore.readDocument(sourceRef.relativePath, sourceRef.digest).value;
  if (source.schemaVersion !== 1 || source.taskRunId !== taskRunId || source.intentDigest !== intentDigest
      || hash(source.closure) !== source.closureDigest || !['KEEP_RESULTS', 'DELETE_ASSOCIATED'].includes(source.mode)) fail('BIZOP_DELETE_PLAN_INVALID');
  const selection = normalizeSelection(source.closure.selection);
  if (hash(selection.datasetIds) !== hash(source.closure.datasets.map((row) => row.objectId).sort())
      || source.mode === 'KEEP_RESULTS' && selection.runIds.length) fail('BIZOP_DELETE_PLAN_INVALID');
  const runIds = source.mode === 'KEEP_RESULTS' ? [] : [...new Set(source.closure.runs.map((row) => row.objectId))].sort();
  if (source.closure.runs.some((row) => row.directlySelected !== selection.runIds.includes(row.objectId))
      || selection.runIds.some((id) => !runIds.includes(id))) fail('BIZOP_DELETE_PLAN_INVALID');
  const result = snapshot({ schemaVersion: 1, taskRunId, candidateRef, intentDigest, previewId: source.previewId,
    closureDigest: source.closureDigest, mode: source.mode, datasetIds: selection.datasetIds, runIds,
    generation: source.closure.generation });
  if (cancelToken.cancelled) fail('BIZOP_CANCELLED');
  const document = payloadStore.writeDocument(`operations/${taskRunId}/${candidateRef}.json`, result);
  return { contractVersion: 1, candidateRef, sha256: document.digest, rowCount: result.datasetIds.length + result.runIds.length };
}
module.exports = { runDeletePipeline };
