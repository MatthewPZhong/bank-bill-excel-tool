'use strict';

const path = require('node:path');

const { resolveArchiveScope } = require('./module-scope-registry');
const { sourceSnapshotForPath } = require('./source-snapshot');

function moduleDescriptor(scopeKey) {
  const scope = resolveArchiveScope(scopeKey);
  if (!scope) throw new Error(`未知 archive scope：${scopeKey}`);
  return Object.freeze({ id: scope.id, code: scope.storageCode, name: scope.name });
}

const MODULES = Object.freeze({
  statement: moduleDescriptor('STATEMENT'),
  newAccount: moduleDescriptor('NEWACCOUNT'),
  pending: moduleDescriptor('PENDING'),
  bankStatement: moduleDescriptor('FUNDRECON'),
  reconIdFix: moduleDescriptor('RECONFIX'),
  bankBu: moduleDescriptor('BANKBU'),
  bizOp: moduleDescriptor('BIZOP'),
  acquiring: moduleDescriptor('ACQUIRING'),
  vcc: moduleDescriptor('VCCOP'),
  vccFinancial: moduleDescriptor('VCCFINOP'),
  toolbox: moduleDescriptor('TOOLBOX'),
  preFund: moduleDescriptor('PREFUND'),
  duplicateInbound: moduleDescriptor('DUPINBOUND'),
  position: moduleDescriptor('POSITION'),
  positionLink: moduleDescriptor('POSITIONLINK'),
  linkedTable: moduleDescriptor('LINKED'),
  preFundTemp: moduleDescriptor('PREFUNDTEMP')
});

const FILE_CHANNELS = new Set([
  'acquiringBillCurrency:export',
  'acquiringBillCurrency:importBill',
  'acquiringBillCurrency:importFlow',
  'acquiringBillCurrency:run',
  'acquiringBillCurrency:run:resume',
  'bank-statement:batch-import',
  'bank-statement:export',
  'bank-statement:import',
  'bankBuRecon:export:aggregate',
  'bankBuRecon:export:single',
  'bankBuRecon:import:run',
  'big-account:import-bank-info',
  'bizOpRecon:export:date',
  'bizOpRecon:export:date-range',
  'bizOpRecon:import:run-biz-op',
  'bizOpRecon:import:run-flow',
  'duplicate-inbound-match:export',
  'duplicate-inbound-match:import-files',
  'file:complete-big-account-selection',
  'file:export-balance',
  'file:export-detail',
  'file:import',
  'file:save-balance-seed',
  'gateway-recon:import',
  'linked-table:import',
  'monthly-balance:assemble',
  'monthly-balance:export',
  'new-account:export',
  'new-account:generate',
  'pending:diff:export-aggregate',
  'pending:diff:export-single',
  'pending:error:export-report',
  'pending:import:start',
  'pending:removed:import',
  'position-reconciliation:bank:apply-import',
  'position-reconciliation:bank:export',
  'position-reconciliation:linked:export',
  'position-reconciliation:raw:export',
  'position-reconciliation:run:export',
  'position-reconciliation:run:export-filtered',
  'position-reconciliation:run:import-result',
  'position-reconciliation:source:apply-import',
  'position-reconciliation:source:export-anomaly',
  'position-reconciliation:source:prepare-import',
  'pre-fund-reconciliation:export',
  'pre-fund-reconciliation:import-bank',
  'pre-fund-reconciliation:import-mpt',
  'pre-fund-reconciliation:mpt-errors:export',
  'pre-fund-reconciliation:mpt-errors:repair',
  'recon-id-fix:export',
  'recon-id-fix:import',
  'scenarios:export-bundle',
  'scenarios:import-bundle-apply',
  'template:export-bundle',
  'template:import',
  'template:import-bundle',
  'toolbox:merge',
  'toolbox:split:export',
  'vccOpCalc:import:scan',
  'vccFinancialOp:data-manager:export',
  'vccFinancialOp:export:import-audit',
  'vccFinancialOp:export:result',
  'vccFinancialOp:import:apply'
]);

const SELECTED_INPUT_CHANNELS = new Set([
  'acquiringBillCurrency:importBill',
  'acquiringBillCurrency:importFlow',
  'bank-statement:batch-import',
  'bank-statement:import',
  'big-account:import-bank-info',
  'duplicate-inbound-match:import-files',
  'file:import',
  'gateway-recon:import',
  'linked-table:import',
  'pending:import:start',
  'position-reconciliation:bank:apply-import',
  'position-reconciliation:run:import-result',
  'position-reconciliation:source:apply-import',
  'position-reconciliation:source:prepare-import',
  'pre-fund-reconciliation:import-bank',
  'pre-fund-reconciliation:import-mpt',
  'recon-id-fix:import',
  'scenarios:import-bundle-apply',
  'template:import',
  'template:import-bundle',
  'toolbox:merge',
  'toolbox:split:export',
  'vccFinancialOp:import:apply'
]);

const PAYLOAD_INPUT_CHANNELS = new Set([
  'acquiringBillCurrency:importBill',
  'acquiringBillCurrency:importFlow',
  'bankBuRecon:import:run',
  'bizOpRecon:import:run-biz-op',
  'bizOpRecon:import:run-flow',
  'pending:import:start',
  'pending:removed:import',
  'scenarios:import-bundle-apply',
  'vccOpCalc:import:scan',
  'vccFinancialOp:import:apply'
]);

const RESULT_OUTPUT_KEYS = Object.freeze({
  'acquiringBillCurrency:export': ['filePath', 'savedPath', 'savePath'],
  'acquiringBillCurrency:run': ['diffFilePath', 'reportFilePath'],
  'acquiringBillCurrency:run:resume': ['diffFilePath', 'reportFilePath'],
  'bank-statement:export': [
    'mainFilePath',
    'hitRowsReportPath',
    'platformCleanupPath',
    'refundBackfillPath'
  ],
  'bankBuRecon:export:aggregate': ['filePath', 'savedPath'],
  'bankBuRecon:export:single': ['filePath', 'savedPath'],
  'bizOpRecon:export:date': ['filePath', 'savedPath'],
  'bizOpRecon:export:date-range': ['filePath', 'savedPath'],
  'duplicate-inbound-match:export': ['filePath', 'savePath'],
  'file:export-balance': ['filePath', 'savedPath'],
  'file:export-detail': ['filePath', 'savedPath'],
  'monthly-balance:export': ['filePath', 'savedPath'],
  'new-account:export': ['filePath', 'savedPath'],
  'pending:diff:export-aggregate': ['filePath', 'savedPath'],
  'pending:diff:export-single': ['filePath', 'savedPath'],
  'pending:error:export-report': ['filePath', 'savedPath'],
  'position-reconciliation:bank:export': ['filePath'],
  'position-reconciliation:linked:export': ['filePath'],
  'position-reconciliation:raw:export': ['filePath'],
  'position-reconciliation:run:export': ['filePath'],
  'position-reconciliation:run:export-filtered': ['filePath'],
  'position-reconciliation:source:export-anomaly': ['filePath'],
  'pre-fund-reconciliation:mpt-errors:export': ['filePath', 'savedPath'],
  'recon-id-fix:export': ['mainFilePath', 'unmatchedFilePath'],
  'scenarios:export-bundle': ['filePath', 'savedPath'],
  'template:export-bundle': ['filePath', 'savedPath'],
  'toolbox:merge': ['filePath'],
  'toolbox:split:export': ['filePath'],
  'vccFinancialOp:data-manager:export': ['filePath'],
  'vccFinancialOp:export:import-audit': ['filePath']
});

function normalizePathList(values) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const seen = new Set();
  const normalized = [];
  for (const value of source) {
    const filePath = String(value || '').trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    normalized.push(filePath);
  }
  return normalized;
}

function firstPayload(args) {
  return Array.isArray(args) && args[0] && typeof args[0] === 'object' ? args[0] : {};
}

function pathsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return normalizePathList([
    ...(Array.isArray(payload.files) ? payload.files : []),
    ...(Array.isArray(payload.filePaths) ? payload.filePaths : []),
    payload.filePath,
    payload.pendingPath,
    payload.bankPath
  ]);
}

function pathsFromResultKeys(result, keys) {
  if (!result || typeof result !== 'object') return [];
  return normalizePathList((Array.isArray(keys) ? keys : []).map((key) => result[key]));
}

function outputPathsFromFiles(result) {
  if (!result || !Array.isArray(result.files)) return [];
  return normalizePathList(result.files.map((item) => item && (
    item.filePath || item.savedPath || item.path
  )));
}

function buildFileSpecs(values, role, sourceOperation) {
  const source = Array.isArray(values) ? values : (values ? [values] : []);
  const files = [];
  for (const value of source) {
    const descriptor = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { filePath: value };
    const filePath = String(descriptor.filePath || '').trim();
    if (!filePath) continue;
    files.push({
      ...descriptor,
      filePath,
      role: descriptor.role || role,
      sourceOperation: descriptor.sourceOperation || sourceOperation,
      originalName: descriptor.originalName || path.basename(filePath)
    });
  }
  return files;
}

function dedupeFileSpecs(files) {
  const seen = new Set();
  return (Array.isArray(files) ? files : []).filter((item) => {
    const key = `${item && item.role || ''}\u0000${item && item.filePath || ''}`;
    if (!item || !item.filePath || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapSelectionsToResults(selectedPaths, results) {
  const paths = normalizePathList(selectedPaths);
  const rows = Array.isArray(results) ? results : [];
  if (paths.length === rows.length) {
    return rows.map((row, index) => ({ row: row || {}, filePath: paths[index] }));
  }
  const unused = paths.slice();
  return rows.map((row) => {
    const fileName = String(row && row.fileName || '');
    const index = unused.findIndex((filePath) => path.basename(filePath) === fileName);
    return { row: row || {}, filePath: index >= 0 ? unused.splice(index, 1)[0] : '' };
  });
}

function selectSuccessfulPathsByResultIndex(sourcePaths, results) {
  const paths = Array.isArray(sourcePaths) ? sourcePaths : [];
  const rows = Array.isArray(results) ? results : [];
  return paths.filter((filePath, index) => (
    typeof filePath === 'string'
    && filePath.trim()
    && rows[index]
    && rows[index].status === 'ok'
  ));
}

function successfulSelectedPaths(selectedPaths, result) {
  if (!result || !Array.isArray(result.results)) return normalizePathList(selectedPaths);
  return mapSelectionsToResults(selectedPaths, result.results)
    .filter(({ row, filePath }) => filePath && row.status === 'ok')
    .map(({ filePath }) => filePath);
}

const VCC_SUCCESSFUL_IMPORT_STATUSES = new Set([
  'success',
  'success_with_skips',
  'all_skipped'
]);

function successfulVccImportPaths(payload, result) {
  const successfulTypes = new Set((Array.isArray(result && result.records) ? result.records : [])
    .filter((record) => VCC_SUCCESSFUL_IMPORT_STATUSES.has(String(record && record.status || '')))
    .map((record) => String(record.sourceType || ''))
    .filter(Boolean));
  return normalizePathList((Array.isArray(payload && payload.files) ? payload.files : [])
    .filter((file) => file && successfulTypes.has(String(file.sourceType || '')))
    .map((file) => file.filePath));
}

function resolveOperationInputPaths(operation = {}) {
  const channel = String(operation.channel || '');
  if (!FILE_CHANNELS.has(channel)) return [];
  const runtime = operation.runtime || {};
  const payload = firstPayload(operation.args);
  const selected = normalizePathList([
    ...(Array.isArray(runtime.inputPaths) ? runtime.inputPaths : []),
    ...(Array.isArray(operation.selectedPaths) ? operation.selectedPaths : []),
    ...(Array.isArray(operation.prepared && operation.prepared.inputPaths)
      ? operation.prepared.inputPaths
      : []),
    ...(Array.isArray(operation.prepared && operation.prepared.selectedPaths)
      ? operation.prepared.selectedPaths
      : [])
  ]);
  let inputPaths = [];
  if (SELECTED_INPUT_CHANNELS.has(channel)) inputPaths = selected;
  if (PAYLOAD_INPUT_CHANNELS.has(channel)) {
    const payloadPaths = channel === 'vccFinancialOp:import:apply'
      ? normalizePathList((Array.isArray(payload.files) ? payload.files : []).map(
        (file) => file && file.filePath
      ))
      : pathsFromPayload(payload);
    inputPaths = normalizePathList([...inputPaths, ...payloadPaths]);
  }
  return inputPaths;
}

function descriptorsForPaths(descriptors, paths) {
  const byPath = new Map((Array.isArray(descriptors) ? descriptors : []).map(
    (item) => [String(item && item.filePath || ''), item]
  ));
  return paths.map((filePath) => byPath.get(filePath) || filePath);
}

function attachSourceSnapshots(files, snapshots) {
  return (Array.isArray(files) ? files : []).map((file) => {
    if (!file || file.sourceSnapshot) return file;
    const snapshot = sourceSnapshotForPath(snapshots, file.filePath);
    return snapshot ? { ...file, sourceSnapshot: snapshot } : file;
  });
}

function resolveOperationFiles(operation = {}) {
  const channel = String(operation.channel || '');
  if (!FILE_CHANNELS.has(channel)) return [];
  const runtime = operation.runtime || {};
  const payload = firstPayload(operation.args);
  if (runtime.skipArchive === true) return [];
  let inputPaths = resolveOperationInputPaths(operation);
  if (channel === 'pre-fund-reconciliation:import-mpt'
      || channel === 'linked-table:import'
      || channel === 'bank-statement:batch-import') {
    inputPaths = successfulSelectedPaths(inputPaths, operation.result);
  }
  if (channel === 'pre-fund-reconciliation:mpt-errors:repair') {
    inputPaths = normalizePathList(runtime.inputPaths || []);
  }
  if (channel === 'file:complete-big-account-selection'
      || channel === 'file:save-balance-seed') {
    inputPaths = normalizePathList(runtime.inputPaths || []);
  }
  if (channel === 'vccFinancialOp:import:apply') {
    const evidencedInputPaths = normalizePathList(
      (Array.isArray(runtime.inputFiles) ? runtime.inputFiles : [])
        .map((item) => item && item.filePath)
    );
    inputPaths = evidencedInputPaths.length > 0
      ? evidencedInputPaths
      : successfulVccImportPaths(payload, operation.result);
  }

  let outputPaths = normalizePathList(runtime.outputPaths || []);
  if (outputPaths.length === 0 && RESULT_OUTPUT_KEYS[channel]) {
    outputPaths = pathsFromResultKeys(operation.result, RESULT_OUTPUT_KEYS[channel]);
  }
  if (channel === 'pre-fund-reconciliation:export') {
    outputPaths = normalizePathList([...outputPaths, ...outputPathsFromFiles(operation.result)]);
  }
  if (channel === 'vccFinancialOp:export:result') {
    outputPaths = normalizePathList([
      ...outputPaths,
      ...(Array.isArray(operation.result && operation.result.filePaths)
        ? operation.result.filePaths
        : [])
    ]);
  }
  const inputValues = descriptorsForPaths(runtime.inputFiles, inputPaths);
  const outputValues = Array.isArray(runtime.outputFiles) && runtime.outputFiles.length > 0
    ? runtime.outputFiles
    : outputPaths;
  return attachSourceSnapshots(dedupeFileSpecs([
    ...buildFileSpecs(inputValues, 'input', channel),
    ...buildFileSpecs(outputValues, 'output', channel)
  ]), runtime.sourceSnapshots);
}

function createArchiveOperationTracker({ sink } = {}) {
  if (!sink || typeof sink.appendFiles !== 'function') {
    throw new TypeError('archive operation tracker 需要 appendFiles sink');
  }

  async function appendOperationFiles(operation = {}) {
    const batchContext = operation.batchContext;
    const batchId = Number(batchContext && batchContext.batchId);
    if (!Number.isSafeInteger(batchId) || batchId < 1) {
      throw new TypeError('appendOperationFiles 需要当前任务 batchContext');
    }
    const files = resolveOperationFiles(operation);
    if (files.length === 0) {
      return { ok: true, handled: false, batchId, attempted: 0 };
    }
    const appended = await sink.appendFiles({
      batchId,
      files,
      sourceOperation: operation.channel,
      metadata: operation.runtime && operation.runtime.metadata
    });
    return {
      ...(appended || {}),
      ok: Boolean(appended) && appended.ok !== false && appended.archiveFailed !== true,
      handled: true,
      batchId
    };
  }

  return Object.freeze({
    appendOperationFiles,
    resolveOperationInputPaths,
    resolveOperationFiles,
    supportsChannel(channel) {
      return FILE_CHANNELS.has(String(channel || ''));
    }
  });
}

module.exports = {
  FILE_CHANNELS,
  MODULES,
  createArchiveOperationTracker,
  mapSelectionsToResults,
  normalizePathList,
  resolveOperationInputPaths,
  resolveOperationFiles,
  selectSuccessfulPathsByResultIndex,
  successfulVccImportPaths
};
