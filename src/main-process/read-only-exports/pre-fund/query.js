'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../backend/run-data-store');
const mirrorRepository = require('../../../backend/database/pre-fund-reconciliation-run-repository');
const { canonicalSha256 } = require('../../background-execution/canonical-json-v1');
const { iterateDuplicateAuditRows } = require('../../pre-fund-reconciliation/output-mapper');

function sourceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hashOrdinaryFile(filePath) {
  const pathStat = fs.lstatSync(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || Number(pathStat.size) < 1) {
    throw sourceError(
      'PRE_FUND_EXPORT_TEMPLATE_INVALID',
      'PreFund 导出模板必须为非空普通文件'
    );
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino ||
        Number(opened.size) !== Number(pathStat.size)) {
      throw sourceError(
        'PRE_FUND_EXPORT_TEMPLATE_INVALID',
        'PreFund 导出模板身份在打开期间发生变化'
      );
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (Number(after.size) !== Number(opened.size) ||
        Number(after.mtimeMs) !== Number(opened.mtimeMs) ||
        bytes.length !== Number(opened.size)) {
      throw sourceError(
        'PRE_FUND_EXPORT_TEMPLATE_INVALID',
        'PreFund 导出模板在读取期间发生变化'
      );
    }
    return Object.freeze({
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length
    });
  } finally {
    fs.closeSync(fd);
  }
}

function openReadDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
  return db;
}

function withReadSnapshot(db, work) {
  db.exec('BEGIN');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

function resolveSideDatabasePath(userDataDir, sideDbRelPath, monthKey) {
  const expected = path.resolve(runDataStore.sideDbPath(
    userDataDir,
    runDataStore.MODULE_PRE_FUND_RECONCILIATION_RESULTS,
    monthKey
  ));
  const resolved = path.resolve(runDataStore.resolveFromRel(userDataDir, sideDbRelPath));
  if (resolved !== expected) {
    throw sourceError('PRE_FUND_EXPORT_SIDE_PATH_INVALID', 'PreFund side DB 路径与 month locator 不一致');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw sourceError('PRE_FUND_EXPORT_SIDE_PATH_INVALID', 'PreFund side DB 必须为普通文件');
  }
  return resolved;
}

function assertStableReceipt(mirror, run, locator) {
  if (!mirror || !run || mirror.status !== 'success' || run.status !== 'success' ||
      !mirror.finishedAt || !run.finished_at) {
    throw sourceError('PRE_FUND_EXPORT_RUN_NOT_STABLE', 'PreFund run 尚未稳定完成');
  }
  if (mirror.id !== locator.mirrorRunId || mirror.monthKey !== locator.monthKey ||
      mirror.sideRunId !== locator.sideRunId || Number(run.id) !== locator.sideRunId ||
      mirror.sideDbRelPath !== locator.sideDbRelPath) {
    throw sourceError('PRE_FUND_EXPORT_RUN_IDENTITY_MISMATCH', 'PreFund mirror/side locator 身份不一致');
  }
  const snapshotHash = crypto.createHash('sha256')
    .update(String(run.snapshot_json || ''), 'utf8')
    .digest('hex');
  if (mirror.scenario !== run.scenario || mirror.snapshotHash !== snapshotHash ||
      JSON.stringify(mirror.bankFiles) !== run.bank_files_json ||
      JSON.stringify(mirror.summary) !== run.summary_json) {
    throw sourceError(
      'PRE_FUND_EXPORT_RUN_IDENTITY_MISMATCH',
      'PreFund mirror/side 业务 revision 不一致'
    );
  }
  const mirrorContract = Number(mirror.archiveContractVersion) || 0;
  const runContract = Number(run.archive_contract_version) || 0;
  if (![0, 1].includes(mirrorContract) || mirrorContract !== runContract) {
    throw sourceError('PRE_FUND_EXPORT_RUN_NOT_STABLE', 'PreFund archive contract version 不一致');
  }
  if (mirrorContract === 1 && (
    !locator.archiveTaskRunId || mirror.archiveTaskRunId !== locator.archiveTaskRunId ||
    run.archive_task_run_id !== locator.archiveTaskRunId ||
    !mirror.archiveTerminalAckAt || !run.archive_terminal_ack_at
  )) {
    throw sourceError('PRE_FUND_EXPORT_RUN_NOT_STABLE', 'PreFund v1 run terminal 尚未 ACK');
  }
  if (mirrorContract === 0 && locator.archiveTaskRunId !== null) {
    throw sourceError('PRE_FUND_EXPORT_RUN_IDENTITY_MISMATCH', 'PreFund legacy run 不应携带 task receipt');
  }
}

function listChannelInventory(sideDb, runId) {
  const rows = sideDb.prepare(`
    WITH channel_events AS (
      SELECT channel, bank_ordinal AS event_order, 0 AS duplicate_count
      FROM pre_fund_reconciliation_balanced_rows WHERE run_id = ?
      UNION ALL
      SELECT channel, bank_ordinal AS event_order, 0 AS duplicate_count
      FROM pre_fund_reconciliation_unbalanced_rows WHERE run_id = ?
      UNION ALL
      SELECT channel, first_event_order AS event_order, 1 AS duplicate_count
      FROM pre_fund_reconciliation_duplicate_groups WHERE run_id = ?
    )
    SELECT channel, MIN(event_order) AS first_event_order,
           MAX(duplicate_count) AS has_duplicate_records
    FROM channel_events
    GROUP BY channel
    ORDER BY first_event_order ASC, channel ASC
  `).all(runId, runId, runId);
  return Object.freeze(rows.map((row) => Object.freeze({
    channel: String(row.channel == null ? '' : row.channel),
    channelDigest: canonicalSha256(String(row.channel == null ? '' : row.channel)),
    hasDuplicateRecords: Number(row.has_duplicate_records) === 1
  })));
}

function runEnvelope(run) {
  return Object.freeze({
    id: Number(run.id),
    scenario: run.scenario,
    snapshotJson: run.snapshot_json,
    bankFilesJson: run.bank_files_json,
    status: run.status,
    summaryJson: run.summary_json,
    archiveContractVersion: Number(run.archive_contract_version) || 0,
    archiveTaskRunId: run.archive_task_run_id || null,
    archiveTerminalAckAt: run.archive_terminal_ack_at || null,
    createdAt: run.created_at,
    finishedAt: run.finished_at
  });
}

function mirrorEnvelope(mirror) {
  return Object.freeze({
    id: mirror.id,
    monthKey: mirror.monthKey,
    sideRunId: mirror.sideRunId,
    scenario: mirror.scenario,
    status: mirror.status,
    summary: mirror.summary,
    snapshotHash: mirror.snapshotHash,
    bankFiles: mirror.bankFiles,
    sideDbRelPath: mirror.sideDbRelPath,
    finishedAt: mirror.finishedAt,
    archiveContractVersion: mirror.archiveContractVersion,
    archiveTaskRunId: mirror.archiveTaskRunId,
    archiveTerminalAckAt: mirror.archiveTerminalAckAt
  });
}

function readPreFundSourceSnapshotFromDatabases({
  mainDb,
  sideDb,
  sideDbPath,
  templatePath,
  userDataDir,
  locator
}) {
  const mirror = mirrorRepository.getRunMirror(mainDb, locator.mirrorRunId);
  if (!mirror) throw sourceError('PRE_FUND_EXPORT_RUN_NOT_FOUND', 'PreFund mirror run 不存在');
  const expectedSideDbPath = resolveSideDatabasePath(
    userDataDir,
    mirror.sideDbRelPath,
    locator.monthKey
  );
  if (path.resolve(sideDbPath) !== expectedSideDbPath) {
    throw sourceError('PRE_FUND_EXPORT_SIDE_PATH_INVALID', 'PreFund Worker side DB authority 不一致');
  }
  const run = sideDb.prepare(
    'SELECT * FROM pre_fund_reconciliation_runs WHERE id = ?'
  ).get(locator.sideRunId);
  assertStableReceipt(mirror, run, { ...locator, sideDbRelPath: mirror.sideDbRelPath });
  const channels = listChannelInventory(sideDb, locator.sideRunId);
  if (channels.length === 0) {
    throw sourceError('PRE_FUND_EXPORT_EMPTY', 'PreFund run 没有可导出的渠道');
  }
  const template = hashOrdinaryFile(templatePath);
  const channelSetDigest = canonicalSha256(channels);
  const sourceDigest = canonicalSha256(Object.freeze({
    mirror: mirrorEnvelope(mirror),
    run: runEnvelope(run),
    channels,
    template
  }));
  return Object.freeze({
    sideDbPath: expectedSideDbPath,
    channels,
    evidence: Object.freeze({
      contractVersion: 1,
      mirrorRunId: mirror.id,
      monthKey: locator.monthKey,
      sideRunId: Number(run.id),
      archiveTaskRunId: mirror.archiveTaskRunId,
      channelSetDigest,
      templateSha256: template.sha256,
      templateSizeBytes: template.sizeBytes,
      sourceDigest
    })
  });
}

function readPreFundSourceSnapshot({
  mainDb,
  userDataDir,
  templatePath,
  locator,
  openSourceDb = openReadDatabase
}) {
  const mirror = mirrorRepository.getRunMirror(mainDb, locator.mirrorRunId);
  if (!mirror) throw sourceError('PRE_FUND_EXPORT_RUN_NOT_FOUND', 'PreFund mirror run 不存在');
  const sideDbPath = resolveSideDatabasePath(userDataDir, mirror.sideDbRelPath, locator.monthKey);
  const sideDb = openSourceDb(sideDbPath);
  try {
    return withReadSnapshot(sideDb, () => readPreFundSourceSnapshotFromDatabases({
      mainDb,
      sideDb,
      sideDbPath,
      templatePath,
      userDataDir,
      locator
    }));
  } finally {
    sideDb.close();
  }
}

function freezePreFundSourceSnapshot({
  mainDb,
  userDataDir,
  templatePath,
  locator,
  openSourceDb = openReadDatabase
}) {
  return withReadSnapshot(mainDb, () => readPreFundSourceSnapshot({
    mainDb,
    userDataDir,
    templatePath,
    locator,
    openSourceDb
  }));
}

function assertPreFundSourceSnapshot(current, expected) {
  if (!expected || expected.contractVersion !== 1 ||
      current.evidence.mirrorRunId !== expected.mirrorRunId ||
      current.evidence.monthKey !== expected.monthKey ||
      current.evidence.sideRunId !== expected.sideRunId ||
      current.evidence.archiveTaskRunId !== expected.archiveTaskRunId ||
      current.evidence.channelSetDigest !== expected.channelSetDigest ||
      current.evidence.templateSha256 !== expected.templateSha256 ||
      current.evidence.templateSizeBytes !== expected.templateSizeBytes ||
      current.evidence.sourceDigest !== expected.sourceDigest) {
    throw sourceError('PRE_FUND_EXPORT_SOURCE_STALE', 'PreFund export 来源已变化，请重新导出');
  }
  return current;
}

function parseObjectJson(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) {
    throw sourceError('PRE_FUND_EXPORT_ROW_INVALID', `${label} JSON 损坏：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw sourceError('PRE_FUND_EXPORT_ROW_INVALID', `${label} JSON 结构非法`);
  }
  return parsed;
}

function* iterateOutputRows(sideDb, runId, channel, table, jsonColumn) {
  const cursor = sideDb.prepare(`
    SELECT id, ${jsonColumn} AS row_json
    FROM ${table}
    WHERE run_id = ? AND channel = ?
    ORDER BY bank_ordinal ASC, id ASC
  `).iterate(runId, channel);
  for (const row of cursor) {
    yield parseObjectJson(row.row_json, `${table}#${row.id}`);
  }
}

function* iterateDuplicateRecords(sideDb, runId, channel) {
  const cursor = sideDb.prepare(`
    SELECT * FROM (
      SELECT g.id AS group_id, g.first_event_order, g.fold_reason,
             0 AS object_rank, p.id AS object_id, p.source_priority,
             p.source_order, p.source_label, p.reconciliation_id,
             p.fingerprint, p.fields_json, p.name, p.card_no,
             p.source_location_json, s.raw_json
      FROM pre_fund_reconciliation_duplicate_groups g
      JOIN pre_fund_reconciliation_gateway_pool p ON p.id = g.kept_pool_id
      LEFT JOIN pre_fund_reconciliation_gateway_candidate_snapshots s ON s.pool_id = p.id
      WHERE g.run_id = ? AND g.channel = ?
      UNION ALL
      SELECT g.id AS group_id, g.first_event_order, g.fold_reason,
             1 AS object_rank, f.id AS object_id, f.source_priority,
             f.source_order, f.source_label, f.reconciliation_id,
             f.fingerprint, f.fields_json, f.name, f.card_no,
             f.source_location_json, f.raw_json
      FROM pre_fund_reconciliation_duplicate_groups g
      JOIN pre_fund_reconciliation_folded_gateway_rows f ON f.group_id = g.id
      WHERE g.run_id = ? AND g.channel = ?
    ) audit
    ORDER BY first_event_order ASC, group_id ASC, object_rank ASC,
             source_priority ASC, source_order ASC, object_id ASC
  `).iterate(runId, channel, runId, channel);
  for (const row of cursor) {
    if (typeof row.raw_json !== 'string') {
      throw sourceError('PRE_FUND_EXPORT_AUDIT_INVALID', `PreFund duplicate raw JSON 缺失：#${row.object_id}`);
    }
    parseObjectJson(row.raw_json, `duplicate raw #${row.object_id}`);
    yield {
      foldRecordId: `PF-${runId}-${row.group_id}`,
      objectType: row.object_rank === 0 ? '保留记录' : '被折叠记录',
      foldReason: row.fold_reason,
      candidate: {
        source: row.source_label,
        sourcePriority: row.source_priority,
        sourceOrder: row.source_order,
        reconciliationId: row.reconciliation_id,
        fingerprint: row.fingerprint,
        fields: parseObjectJson(row.fields_json, `duplicate fields #${row.object_id}`),
        name: row.name || '',
        cardNo: row.card_no || '',
        location: parseObjectJson(row.source_location_json, `duplicate location #${row.object_id}`),
        rawJson: row.raw_json
      }
    };
  }
}

function readChannelExport(sideDb, runId, channel, hasDuplicateRecords) {
  return Object.freeze({
    channel,
    hasDuplicateRecords,
    balancedRows: iterateOutputRows(
      sideDb, runId, channel, 'pre_fund_reconciliation_balanced_rows', 'output_json'
    ),
    unbalancedRows: iterateOutputRows(
      sideDb, runId, channel, 'pre_fund_reconciliation_unbalanced_rows', 'output_json'
    ),
    channelBillRows: iterateOutputRows(
      sideDb, runId, channel, 'pre_fund_reconciliation_unbalanced_rows', 'channel_output_json'
    ),
    duplicateRows: hasDuplicateRecords
      ? iterateDuplicateAuditRows(iterateDuplicateRecords(sideDb, runId, channel))
      : []
  });
}

module.exports = {
  assertPreFundSourceSnapshot,
  assertStableReceipt,
  freezePreFundSourceSnapshot,
  hashOrdinaryFile,
  iterateDuplicateRecords,
  iterateOutputRows,
  listChannelInventory,
  openReadDatabase,
  readChannelExport,
  readPreFundSourceSnapshot,
  readPreFundSourceSnapshotFromDatabases,
  resolveSideDatabasePath,
  withReadSnapshot
};
