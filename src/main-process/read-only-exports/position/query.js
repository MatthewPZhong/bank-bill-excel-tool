'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { text } = require('../../position-reconciliation/common');
const {
  openPositionReconciliationStoreReadOnly
} = require('../../position-reconciliation/store');
const {
  verifyAnomalyReportFile
} = require('../../position-reconciliation/filtered-source-report');

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function hashOrdinaryFile(filePath) {
  const pathStat = await fs.promises.lstat(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || Number(pathStat.size) < 1) {
    throw sourceError('POSITION_EXPORT_SOURCE_FILE_INVALID', 'Position 来源必须为非空普通文件');
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino ||
        Number(opened.size) !== Number(pathStat.size)) {
      throw sourceError(
        'POSITION_EXPORT_SOURCE_FILE_INVALID',
        'Position 来源文件身份在打开期间发生变化'
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (Number(after.size) !== Number(opened.size) ||
        Number(after.mtimeMs) !== Number(opened.mtimeMs) ||
        bytes.length !== Number(opened.size)) {
      throw sourceError(
        'POSITION_EXPORT_SOURCE_FILE_INVALID',
        'Position 来源文件在读取期间发生变化'
      );
    }
    return Object.freeze({
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length
    });
  } finally {
    await handle.close();
  }
}

function normalizeExportFilters(value = {}) {
  const channels = (Array.isArray(value.channels) ? value.channels : [])
    .map(text).filter(Boolean);
  const hasRegionFilter = Array.isArray(value.regions) && value.regions.length > 0;
  const regions = hasRegionFilter ? value.regions.map(text) : [];
  const months = (Array.isArray(value.months) ? value.months : [])
    .map(text).filter(Boolean);
  const differenceStatuses = (Array.isArray(value.differenceStatuses)
    ? value.differenceStatuses : []).map(text).filter(Boolean);
  return Object.freeze({
    channels: Object.freeze(channels),
    regions: Object.freeze(regions),
    months: Object.freeze(months),
    differenceStatuses: Object.freeze(differenceStatuses)
  });
}

function runEnvelope(run) {
  return Object.freeze({
    id: Number(run.id),
    runUuid: text(run.run_uuid),
    status: text(run.status),
    scope: run.scope,
    snapshot: run.snapshot,
    summary: run.summary,
    filteredRowCount: Number(run.filteredRowCount) || 0,
    exportedAt: run.exported_at || null,
    reimportedAt: run.reimported_at || null,
    confirmedAt: run.confirmed_at || null
  });
}

function requireExportRun(store, runId, variant) {
  const normalizedRunId = Number(runId);
  const run = Number.isSafeInteger(normalizedRunId) && normalizedRunId > 0
    ? store.getRun(normalizedRunId)
    : (variant === 'differences' ? null : store.latestPendingRun());
  if (!run) {
    throw sourceError('POSITION_EXPORT_RUN_NOT_FOUND', 'Position export run 不存在');
  }
  if (variant === 'differences') {
    if (!['pending', 'confirmed'].includes(run.status)) {
      throw sourceError('POSITION_EXPORT_RUN_NOT_STABLE', 'Position 差异 run 状态不可导出');
    }
    if (run.status === 'pending' && !store.snapshotIsCurrent(run.snapshot)) {
      throw sourceError('POSITION_EXPORT_SOURCE_STALE', 'Position 差异 run 已过期');
    }
    return run;
  }
  if (run.status !== 'pending') {
    throw sourceError('POSITION_EXPORT_RUN_NOT_STABLE', 'Position run 不是待确认稳定状态');
  }
  if (!store.snapshotIsCurrent(run.snapshot)) {
    throw sourceError('POSITION_EXPORT_SOURCE_STALE', 'Position run 已过期');
  }
  return run;
}

function reportInventoryFromRows(rows) {
  const inventory = new Map();
  for (const row of rows) {
    const item = Object.freeze({
      reportKey: text(row.reportKey),
      reportArtifactKey: text(row.reportArtifactKey),
      archiveOperationKey: text(row.archiveOperationKey),
      reportSha256: text(row.reportSha256).toLowerCase(),
      reportSizeBytes: Number(row.reportSizeBytes),
      reportFileName: text(row.reportFileName)
    });
    if (!item.reportKey || !item.reportArtifactKey || !item.archiveOperationKey ||
        !/^[a-f0-9]{64}$/.test(item.reportSha256) ||
        !Number.isSafeInteger(item.reportSizeBytes) || item.reportSizeBytes < 1) {
      throw sourceError('POSITION_EXPORT_REPORT_IDENTITY_INVALID', 'Position 异常报告引用非法');
    }
    const existing = inventory.get(item.reportKey);
    if (existing && canonicalSha256(existing) !== canonicalSha256(item)) {
      throw sourceError('POSITION_EXPORT_REPORT_IDENTITY_INVALID', 'Position 异常报告引用不一致');
    }
    inventory.set(item.reportKey, existing || item);
  }
  return Object.freeze([...inventory.values()].sort(
    (left, right) => left.reportKey.localeCompare(right.reportKey)
  ));
}

async function resolveReportFiles(inventory, provided) {
  const byKey = new Map((Array.isArray(provided) ? provided : []).map(
    (item) => [text(item.reportKey), item]
  ));
  if (byKey.size !== inventory.length) {
    throw sourceError('POSITION_EXPORT_REPORT_SET_MISMATCH', 'Position 异常报告文件集合不完整');
  }
  const resolved = [];
  for (const item of inventory) {
    const source = byKey.get(item.reportKey);
    if (!source || text(source.sha256).toLowerCase() !== item.reportSha256 ||
        Number(source.sizeBytes) !== item.reportSizeBytes) {
      throw sourceError('POSITION_EXPORT_REPORT_SET_MISMATCH', 'Position 异常报告文件 identity 不一致');
    }
    const verified = await verifyAnomalyReportFile(source);
    resolved.push(Object.freeze({
      reportKey: item.reportKey,
      filePath: verified.filePath,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes
    }));
  }
  return Object.freeze(resolved);
}

async function readPositionSourceSnapshotFromStore({
  store,
  templatePath,
  variant,
  runId,
  filters = {},
  reportFiles = []
}) {
  if (!store || !store.db) throw new TypeError('Position source store 缺失');
  if (!['run', 'differences', 'filtered'].includes(variant)) {
    throw new TypeError('Position export variant 非法');
  }
  const checkpoint = store.persistenceCheckpoint();
  const run = requireExportRun(store, runId, variant);
  const normalizedFilters = normalizeExportFilters(filters);
  const template = await hashOrdinaryFile(templatePath);
  const filteredSources = variant === 'filtered'
    ? store.listRunFilteredSources(run.id)
    : Object.freeze([]);
  if (variant === 'filtered' && filteredSources.length === 0) {
    throw sourceError('POSITION_EXPORT_FILTERED_EMPTY', 'Position run 没有过滤数据');
  }
  const reportInventory = reportInventoryFromRows(filteredSources);
  const resolvedReportFiles = variant === 'filtered'
    ? await resolveReportFiles(reportInventory, reportFiles)
    : Object.freeze([]);
  const currentCheckpoint = store.persistenceCheckpoint();
  if (canonicalSha256(checkpoint) !== canonicalSha256(currentCheckpoint)) {
    throw sourceError('POSITION_EXPORT_SOURCE_STALE', 'Position 来源在冻结期间已变化');
  }
  const runDigest = canonicalSha256(runEnvelope(run));
  const filterDigest = canonicalSha256(normalizedFilters);
  const reportSetDigest = canonicalSha256(Object.freeze({
    inventory: reportInventory,
    files: resolvedReportFiles
  }));
  const sourceDigest = canonicalSha256(Object.freeze({
    checkpoint,
    runDigest,
    filterDigest,
    reportSetDigest,
    template,
    variant
  }));
  return Object.freeze({
    run,
    filteredSources: Object.freeze(filteredSources.slice()),
    context: Object.freeze({
      kind: 'position-run-export',
      variant,
      filters: normalizedFilters,
      reportFiles: resolvedReportFiles
    }),
    evidence: Object.freeze({
      contractVersion: 1,
      variant,
      runId: run.id,
      checkpoint: Object.freeze({ ...checkpoint }),
      runDigest,
      filterDigest,
      reportSetDigest,
      templateSha256: template.sha256,
      templateSizeBytes: template.sizeBytes,
      sourceDigest
    })
  });
}

async function freezePositionSourceSnapshot(options) {
  return readPositionSourceSnapshotFromStore(options);
}

function evidenceMatches(current, expected) {
  return Boolean(current && current.evidence && expected) &&
    current.evidence.contractVersion === expected.contractVersion &&
    current.evidence.variant === expected.variant &&
    current.evidence.runId === expected.runId &&
    current.evidence.runDigest === expected.runDigest &&
    current.evidence.filterDigest === expected.filterDigest &&
    current.evidence.reportSetDigest === expected.reportSetDigest &&
    current.evidence.templateSha256 === expected.templateSha256 &&
    current.evidence.templateSizeBytes === expected.templateSizeBytes &&
    current.evidence.sourceDigest === expected.sourceDigest &&
    canonicalSha256(current.evidence.checkpoint) === canonicalSha256(expected.checkpoint);
}

function assertPositionSourceSnapshot(current, expected) {
  if (!evidenceMatches(current, expected)) {
    throw sourceError('POSITION_EXPORT_SOURCE_STALE', 'Position export 来源已变化，请重新导出');
  }
  return current;
}

async function withReadSnapshot(store, work) {
  store.db.exec('BEGIN');
  try {
    const value = await work();
    store.db.exec('COMMIT');
    return value;
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

function openPositionExportStore(source, evidence) {
  return openPositionReconciliationStoreReadOnly(source.userDataDir, {
    expectedCheckpoint: evidence.checkpoint
  });
}

module.exports = {
  assertPositionSourceSnapshot,
  evidenceMatches,
  freezePositionSourceSnapshot,
  hashOrdinaryFile,
  normalizeExportFilters,
  openPositionExportStore,
  readPositionSourceSnapshotFromStore,
  reportInventoryFromRows,
  requireExportRun,
  resolveReportFiles,
  runEnvelope,
  withReadSnapshot
};
