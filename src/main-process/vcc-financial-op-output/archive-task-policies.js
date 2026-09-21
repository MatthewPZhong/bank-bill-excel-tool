'use strict';

const {
  createBaseTaskPolicy,
  classifyKnownStatus,
  standardResultMetadataResolver
} = require('../archive-center/task-policy-common');

function vccFinancialOpResultClassifier(result) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (status === 'blocked') return 'failed';
  return classifyKnownStatus(result, ['calculated', 'initialized', 'all_skipped', 'archived']);
}

function vccFlowIdentity(kind, value) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized) {
    const error = new TypeError(`VCC ${kind} 稳定业务身份缺失`);
    error.code = 'ARCHIVE_FLOW_IDENTITY_REQUIRED';
    throw error;
  }
  return {
    type: `vcc-financial-op-${kind}`,
    value: normalized
  };
}

function vccInvocationPayload(invocation = {}) {
  const args = Array.isArray(invocation.args) ? invocation.args : [];
  return args[0] && typeof args[0] === 'object' ? args[0] : {};
}

function vccRunFlowIdentity(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const payload = vccInvocationPayload(invocation);
  return vccFlowIdentity('run', prepared.runId ?? payload.runId);
}

function vccImportRecordFlowIdentity(invocation = {}) {
  return vccFlowIdentity('import-record', vccInvocationPayload(invocation).recordId);
}

function vccDeleteFlowPlan(invocation = {}) {
  const prepared = invocation.prepared && typeof invocation.prepared === 'object'
    ? invocation.prepared
    : {};
  const runIds = Array.isArray(prepared.runIds) ? prepared.runIds : [];
  if (prepared.targetType === 'result' && runIds.length === 1) {
    return { startsNewFlow: false, flowIdentity: vccFlowIdentity('run', runIds[0]) };
  }
  return { startsNewFlow: true, flowIdentity: null };
}

function vccImportResultFlowIdentities(result) {
  if (!result || typeof result !== 'object') return [];
  const identities = [];
  if (String(result.batchId || '').trim()) {
    identities.push(vccFlowIdentity('import-batch', result.batchId));
  }
  for (const record of Array.isArray(result.records) ? result.records : []) {
    if (record && String(record.recordId || '').trim()) {
      identities.push(vccFlowIdentity('import-record', record.recordId));
    }
  }
  return identities;
}

function vccRunResultFlowIdentities(result) {
  if (!result || typeof result !== 'object' || !String(result.runId || '').trim()) return [];
  return [vccFlowIdentity('run', result.runId)];
}

function vccFinancialOpResultMetadata(result) {
  const source = result && typeof result === 'object' ? result : {};
  const metadata = standardResultMetadataResolver(source);
  for (const key of [
    'runId',
    'targetMonth',
    'resultRevision',
    'batchId',
    'recordId',
    'auditId',
    'deletionId',
    'deletedRunCount',
    'deletedDataCount'
  ]) {
    const value = source[key];
    if (value !== undefined && value !== null) metadata[key] = value;
  }
  if (source.adjustment && source.adjustment.id !== undefined) {
    metadata.adjustmentId = source.adjustment.id;
  }
  if (Array.isArray(source.initializedSubjects)) {
    metadata.initializedSubjectCount = source.initializedSubjects.length;
  }
  if (Array.isArray(source.filePaths)) metadata.outputFileCount = source.filePaths.length;
  if (source.filePath) metadata.outputFileCount = 1;
  return metadata;
}

const archivePolicies = Object.freeze([
  createBaseTaskPolicy('vccFinancialOp:data-manager:delete', 'VCCFINOP', {
    workerContext: 'operation',
    flowPlanResolver: vccDeleteFlowPlan,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:data-manager:export', 'VCCFINOP', {
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:export:import-audit', 'VCCFINOP', {
    startsNewFlow: false,
    flowIdentityResolver: vccImportRecordFlowIdentity,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:export:result', 'VCCFINOP', {
    startsNewFlow: false,
    flowIdentityResolver: vccRunFlowIdentity,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:import:apply', 'VCCFINOP', {
    resultClassifier: vccFinancialOpResultClassifier,
    bindResultFlowIdentitiesOnFailure: true,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccImportResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:opening:initialize', 'VCCFINOP', {
    workerContext: 'operation',
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:run:adjustment-add', 'VCCFINOP', {
    workerContext: 'operation',
    startsNewFlow: false,
    flowIdentityResolver: vccRunFlowIdentity,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:run:archive', 'VCCFINOP', {
    workerContext: 'operation',
    startsNewFlow: false,
    flowIdentityResolver: vccRunFlowIdentity,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:run:calculate', 'VCCFINOP', {
    workerContext: 'operation',
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  }),
  createBaseTaskPolicy('vccFinancialOp:run:unarchive', 'VCCFINOP', {
    workerContext: 'operation',
    startsNewFlow: false,
    flowIdentityResolver: vccRunFlowIdentity,
    resultClassifier: vccFinancialOpResultClassifier,
    resultMetadataResolver: vccFinancialOpResultMetadata,
    resultFlowIdentities: vccRunResultFlowIdentities
  })
]);

module.exports = {
  archivePolicies,
  vccFinancialOpResultClassifier,
  vccFlowIdentity,
  vccInvocationPayload,
  vccRunFlowIdentity,
  vccImportRecordFlowIdentity,
  vccDeleteFlowPlan,
  vccImportResultFlowIdentities,
  vccRunResultFlowIdentities,
  vccFinancialOpResultMetadata
};
