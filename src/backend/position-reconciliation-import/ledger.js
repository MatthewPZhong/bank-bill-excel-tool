'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../main-process/archive-center/source-snapshot');
const {
  hashFileSha256Async
} = require('../../main-process/position-reconciliation/input-staging');
const {
  stableHash
} = require('../../main-process/position-reconciliation/common');
const {
  POSITION_IMPORT_LEDGER_SCHEMA_VERSION,
  POSITION_IMPORT_MAX_ERROR_DETAILS,
  POSITION_IMPORT_PROTOCOL_VERSION
} = require('./constants');

const LEDGER_SCHEMA = `
  CREATE TABLE job_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE job_files (
    file_index INTEGER PRIMARY KEY,
    original_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    staged_path TEXT NOT NULL,
    source_type TEXT,
    sheet_name TEXT,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    source_snapshot_json TEXT NOT NULL,
    preflight_status TEXT NOT NULL,
    scanned_non_blank_rows INTEGER NOT NULL DEFAULT 0,
    persisted_candidate_rows INTEGER NOT NULL DEFAULT 0,
    filtered_rows INTEGER NOT NULL DEFAULT 0,
    collapsed_duplicate_rows INTEGER NOT NULL DEFAULT 0,
    reader_filtered_rows INTEGER NOT NULL DEFAULT 0,
    invalid_rows INTEGER NOT NULL DEFAULT 0,
    visible_link_rows INTEGER NOT NULL DEFAULT 0,
    hidden_link_rows INTEGER NOT NULL DEFAULT 0,
    derived_zero_source_rows INTEGER NOT NULL DEFAULT 0,
    date_min TEXT,
    date_max TEXT,
    content_hash TEXT,
    filter_reason_json TEXT NOT NULL DEFAULT '{}',
    first_error_code TEXT,
    first_error_message TEXT,
    first_error_detail_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE source_seen_records (
    source_type TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    row_guard_hash TEXT NOT NULL,
    business_key TEXT NOT NULL,
    disposition TEXT NOT NULL,
    first_file_index INTEGER NOT NULL,
    first_row_number INTEGER NOT NULL,
    PRIMARY KEY(source_type, row_hash)
  );
  CREATE INDEX idx_source_seen_business_key
    ON source_seen_records(source_type, business_key, disposition);

  CREATE TABLE filtered_source_rows (
    report_row_key TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    business_key TEXT NOT NULL,
    recon_id TEXT NOT NULL DEFAULT '',
    event_date TEXT,
    month_key TEXT,
    error_code TEXT NOT NULL,
    error_reason TEXT NOT NULL,
    source_file_index INTEGER NOT NULL,
    source_row_number INTEGER NOT NULL,
    row_hash TEXT NOT NULL,
    row_guard_hash TEXT NOT NULL,
    is_owner INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    UNIQUE(source_file_index, source_row_number),
    FOREIGN KEY(source_file_index) REFERENCES job_files(file_index)
  );
  CREATE INDEX idx_filtered_source_business_key
    ON filtered_source_rows(source_type, business_key, source_file_index);
  CREATE INDEX idx_filtered_source_month
    ON filtered_source_rows(source_type, month_key, source_file_index);

  CREATE TABLE bank_seen_biz_ids (
    biz_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    month_key TEXT NOT NULL,
    first_file_index INTEGER NOT NULL,
    first_row_number INTEGER NOT NULL
  );

  CREATE TABLE bank_scopes (
    channel TEXT NOT NULL,
    month_key TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    PRIMARY KEY(channel, month_key)
  );

  CREATE TABLE file_errors (
    file_index INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    row_number INTEGER,
    code TEXT NOT NULL,
    field TEXT,
    message TEXT NOT NULL,
    PRIMARY KEY(file_index, seq)
  );
`;

const FILE_STAT_FIELDS = Object.freeze([
  'scannedNonBlankRows',
  'persistedCandidateRows',
  'filteredRows',
  'collapsedDuplicateRows',
  'readerFilteredRows',
  'invalidRows',
  'visibleLinkRows',
  'hiddenLinkRows',
  'derivedZeroSourceRows'
]);

const FILE_STAT_COLUMNS = Object.freeze({
  scannedNonBlankRows: 'scanned_non_blank_rows',
  persistedCandidateRows: 'persisted_candidate_rows',
  filteredRows: 'filtered_rows',
  collapsedDuplicateRows: 'collapsed_duplicate_rows',
  readerFilteredRows: 'reader_filtered_rows',
  invalidRows: 'invalid_rows',
  visibleLinkRows: 'visible_link_rows',
  hiddenLinkRows: 'hidden_link_rows',
  derivedZeroSourceRows: 'derived_zero_source_rows'
});

class PositionImportLedgerError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'PositionImportLedgerError';
    this.code = 'position-import-job-ledger-invalid';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

function json(value) {
  return JSON.stringify(value);
}

function parsedJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new PositionImportLedgerError(
      `${label} JSON 损坏`,
      [error && error.message ? error.message : String(error)]
    );
  }
}

function normalizedFileIndex(value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('fileIndex 必须是非负安全整数');
  }
  return index;
}

function savepointName(fileIndex) {
  return `position_file_${normalizedFileIndex(fileIndex)}`;
}

function normalizeError(error) {
  return {
    code: String(error && error.code || 'position-source-import-failed'),
    message: String(error && error.message || error || '文件预检失败'),
    detailLines: Array.isArray(error && error.detailLines)
      ? error.detailLines.map((line) => String(line))
      : []
  };
}

class PositionImportLedger {
  constructor({ ledgerPath, jobId, kind, createdAt = new Date().toISOString() }) {
    this.ledgerPath = path.resolve(String(ledgerPath || ''));
    this.jobId = String(jobId || '').trim();
    this.kind = String(kind || '').trim();
    if (!this.jobId || !this.kind) throw new TypeError('ledger jobId/kind 不能为空');
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.ledgerPath);
    fs.chmodSync(this.ledgerPath, 0o600);
    this.closed = false;
    this.activeFileIndex = null;
    this.activeBatchName = null;
    this.db.exec('PRAGMA journal_mode=DELETE');
    this.db.exec('PRAGMA synchronous=FULL');
    this.db.exec('PRAGMA temp_store=FILE');
    this.db.exec(LEDGER_SCHEMA);
    this.setMeta('ledgerSchemaVersion', POSITION_IMPORT_LEDGER_SCHEMA_VERSION);
    this.setMeta('protocolVersion', POSITION_IMPORT_PROTOCOL_VERSION);
    this.setMeta('jobId', this.jobId);
    this.setMeta('kind', this.kind);
    this.setMeta('createdAt', createdAt);
  }

  _assertOpen() {
    if (this.closed || !this.db) throw new PositionImportLedgerError('job ledger 已关闭');
  }

  setMeta(key, value) {
    this._assertOpen();
    this.db.prepare(`
      INSERT INTO job_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), typeof value === 'string' ? value : json(value));
  }

  getMeta(key) {
    this._assertOpen();
    const row = this.db.prepare('SELECT value FROM job_meta WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }

  addFile(descriptor) {
    this._assertOpen();
    const fileIndex = normalizedFileIndex(descriptor.fileIndex);
    this.db.prepare(`
      INSERT INTO job_files(
        file_index, original_path, original_name, staged_path, sha256,
        size_bytes, source_snapshot_json, preflight_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      fileIndex,
      path.resolve(String(descriptor.sourceFilePath || descriptor.originalPath || '')),
      String(descriptor.sourceFileName || descriptor.originalName || ''),
      path.resolve(String(descriptor.filePath || descriptor.stagedPath || '')),
      String(descriptor.stagedSha256 || descriptor.sha256 || '').toLowerCase(),
      Number(descriptor.stagedSizeBytes ?? descriptor.sizeBytes),
      json(descriptor.stagedSnapshot || descriptor.sourceSnapshot || null)
    );
  }

  beginFile(fileIndex) {
    this._assertOpen();
    const index = normalizedFileIndex(fileIndex);
    if (this.activeFileIndex !== null) {
      throw new PositionImportLedgerError('另一个文件 savepoint 尚未结束');
    }
    this.db.exec(`SAVEPOINT ${savepointName(index)}`);
    this.activeFileIndex = index;
  }

  beginBatch(name) {
    this._assertOpen();
    if (this.activeBatchName !== null || this.activeFileIndex !== null) {
      throw new PositionImportLedgerError('另一个 ledger batch/savepoint 尚未结束');
    }
    const normalized = String(name || '').trim();
    if (!/^[a-z][a-z0-9_]*$/i.test(normalized)) {
      throw new TypeError('ledger batch 名称非法');
    }
    this.db.exec(`SAVEPOINT ${normalized}`);
    this.activeBatchName = normalized;
  }

  commitBatch() {
    this._assertOpen();
    if (!this.activeBatchName || this.activeFileIndex !== null) {
      throw new PositionImportLedgerError('ledger batch 状态不允许提交');
    }
    this.db.exec(`RELEASE ${this.activeBatchName}`);
    this.activeBatchName = null;
  }

  rollbackBatch() {
    this._assertOpen();
    if (!this.activeBatchName || this.activeFileIndex !== null) {
      throw new PositionImportLedgerError('ledger batch 状态不允许回滚');
    }
    this.db.exec(`ROLLBACK TO ${this.activeBatchName}`);
    this.db.exec(`RELEASE ${this.activeBatchName}`);
    this.activeBatchName = null;
  }

  claimSourceRecord({
    sourceType,
    businessKey,
    rowHash,
    rowGuardHash,
    fileIndex,
    rowNumber,
    disposition = 'accepted'
  }) {
    this._assertOpen();
    const index = normalizedFileIndex(fileIndex);
    const existing = this.db.prepare(`
      SELECT business_key AS businessKey, row_guard_hash AS rowGuardHash,
             disposition,
             first_file_index AS firstFileIndex,
             first_row_number AS firstRowNumber
      FROM source_seen_records
      WHERE source_type = ? AND row_hash = ?
    `).get(String(sourceType), String(rowHash));
    if (!existing) {
      this.db.prepare(`
        INSERT INTO source_seen_records(
          source_type, row_hash, row_guard_hash, business_key, disposition,
          first_file_index, first_row_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(sourceType),
        String(rowHash),
        String(rowGuardHash),
        String(businessKey),
        String(disposition),
        index,
        Number(rowNumber)
      );
      return { status: 'accepted' };
    }
    if (existing.businessKey !== String(businessKey)
        || existing.rowGuardHash !== String(rowGuardHash)
        || existing.disposition !== String(disposition)) {
      return {
        status: 'hash-collision',
        firstFileIndex: Number(existing.firstFileIndex),
        firstRowNumber: Number(existing.firstRowNumber)
      };
    }
    return {
      status: 'collapsed',
      firstFileIndex: Number(existing.firstFileIndex),
      firstRowNumber: Number(existing.firstRowNumber)
    };
  }

  recordFilteredRow(input = {}) {
    this._assertOpen();
    const fileIndex = normalizedFileIndex(input.fileIndex);
    if (this.activeFileIndex !== fileIndex) {
      throw new PositionImportLedgerError('过滤行不属于当前文件 savepoint');
    }
    this.db.prepare(`
      INSERT INTO filtered_source_rows(
        report_row_key, source_type, business_key, recon_id,
        event_date, month_key, error_code, error_reason,
        source_file_index, source_row_number, row_hash, row_guard_hash,
        is_owner, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(input.reportRowKey || ''),
      String(input.sourceType || ''),
      String(input.businessKey || ''),
      String(input.reconId || ''),
      input.eventDate || null,
      input.monthKey || null,
      String(input.errorCode || ''),
      String(input.errorReason || ''),
      fileIndex,
      Number(input.rowNumber),
      String(input.rowHash || ''),
      String(input.rowGuardHash || ''),
      input.isOwner === false ? 0 : 1,
      json(input.row || {})
    );
  }

  *iterateFilteredRows({ sourceTypes = [], fileIndexes = [] } = {}) {
    this._assertOpen();
    const normalizedTypes = Array.isArray(sourceTypes)
      ? sourceTypes.map(String).filter(Boolean)
      : [];
    const normalizedIndexes = Array.isArray(fileIndexes)
      ? [...new Set(fileIndexes.map(normalizedFileIndex))]
      : [];
    const conditions = ['f.is_owner = 1'];
    const params = [];
    if (normalizedTypes.length > 0) {
      conditions.push(`f.source_type IN (${normalizedTypes.map(() => '?').join(', ')})`);
      params.push(...normalizedTypes);
    }
    if (normalizedIndexes.length > 0) {
      conditions.push(`f.source_file_index IN (${normalizedIndexes.map(() => '?').join(', ')})`);
      params.push(...normalizedIndexes);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    for (const row of this.db.prepare(`
      SELECT f.report_row_key AS reportRowKey,
             f.source_type AS sourceType, f.business_key AS businessKey,
             f.recon_id AS reconId, f.event_date AS eventDate,
             f.month_key AS monthKey, f.error_code AS errorCode,
             f.error_reason AS errorReason,
             f.source_file_index AS fileIndex,
             f.source_row_number AS rowNumber,
             f.row_hash AS rowHash, f.row_guard_hash AS rowGuardHash,
             f.raw_json AS rawJson,
             j.original_name AS fileName, j.sheet_name AS sheetName
      FROM filtered_source_rows f
      INNER JOIN job_files j ON j.file_index = f.source_file_index
      ${where}
      ORDER BY f.source_file_index, f.source_row_number
    `).iterate(...params)) {
      yield {
        ...row,
        row: parsedJson(row.rawJson, 'filtered source raw row')
      };
    }
  }

  listFilteredRows(options = {}) {
    return [...this.iterateFilteredRows(options)];
  }

  listFilteredFileIndexes() {
    this._assertOpen();
    return this.db.prepare(`
      SELECT DISTINCT source_file_index AS fileIndex
      FROM filtered_source_rows
      ORDER BY source_file_index
    `).all().map((row) => Number(row.fileIndex));
  }

  listFilteredBatchCollisions() {
    this._assertOpen();
    return this.db.prepare(`
      SELECT DISTINCT filtered.source_file_index AS fileIndex,
             filtered.source_type AS sourceType,
             filtered.business_key AS businessKey,
             accepted.first_file_index AS acceptedFileIndex,
             accepted.first_row_number AS acceptedRowNumber
      FROM filtered_source_rows filtered
      INNER JOIN source_seen_records accepted
        ON accepted.source_type = filtered.source_type
       AND accepted.business_key = filtered.business_key
       AND accepted.disposition = 'accepted'
      ORDER BY filtered.source_file_index, filtered.source_type, filtered.business_key
    `).all();
  }

  *iterateFilteredBusinessKeys() {
    this._assertOpen();
    yield* this.db.prepare(`
      SELECT source_type AS sourceType, business_key AS businessKey,
             source_file_index AS fileIndex,
             MIN(source_row_number) AS rowNumber
      FROM filtered_source_rows
      GROUP BY source_type, business_key, source_file_index
      ORDER BY source_type, business_key, source_file_index
    `).iterate();
  }

  setAnomalyReport(report) {
    this._assertOpen();
    this.setMeta('anomalyReport', report || null);
  }

  setAnomalyReports(reports) {
    this._assertOpen();
    this.setMeta('anomalyReports', Array.isArray(reports) ? reports : []);
  }

  claimBankBizId({ bizId, channel, monthKey, fileIndex, rowNumber }) {
    this._assertOpen();
    const existing = this.db.prepare(`
      SELECT first_file_index AS firstFileIndex, first_row_number AS firstRowNumber
      FROM bank_seen_biz_ids
      WHERE biz_id = ?
    `).get(String(bizId));
    if (existing) {
      return {
        status: 'conflict',
        firstFileIndex: Number(existing.firstFileIndex),
        firstRowNumber: Number(existing.firstRowNumber)
      };
    }
    this.db.prepare(`
      INSERT INTO bank_seen_biz_ids(
        biz_id, channel, month_key, first_file_index, first_row_number
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      String(bizId),
      String(channel),
      String(monthKey),
      normalizedFileIndex(fileIndex),
      Number(rowNumber)
    );
    this.db.prepare(`
      INSERT INTO bank_scopes(channel, month_key, row_count)
      VALUES (?, ?, 1)
      ON CONFLICT(channel, month_key)
      DO UPDATE SET row_count = row_count + 1
    `).run(String(channel), String(monthKey));
    return { status: 'accepted' };
  }

  hasAcceptedAccountSnapshot() {
    this._assertOpen();
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM job_files
      WHERE source_type = 'bank-account' AND preflight_status = 'accepted'
      LIMIT 1
    `).get());
  }

  acceptFile(fileIndex, input = {}) {
    this._assertOpen();
    const index = normalizedFileIndex(fileIndex);
    if (this.activeFileIndex !== index) {
      throw new PositionImportLedgerError('文件 savepoint 所有权不一致');
    }
    const stats = Object.fromEntries(FILE_STAT_FIELDS.map((key) => [
      key,
      Number.isSafeInteger(Number(input[key])) && Number(input[key]) >= 0
        ? Number(input[key])
        : 0
    ]));
    this.db.prepare(`
      UPDATE job_files
      SET source_type = ?, sheet_name = ?, preflight_status = 'accepted',
          scanned_non_blank_rows = ?, persisted_candidate_rows = ?, filtered_rows = ?,
          collapsed_duplicate_rows = ?, reader_filtered_rows = ?, invalid_rows = ?,
          visible_link_rows = ?, hidden_link_rows = ?, derived_zero_source_rows = ?,
          date_min = ?, date_max = ?, content_hash = ?, filter_reason_json = ?,
          first_error_code = NULL, first_error_message = NULL,
          first_error_detail_json = '[]'
      WHERE file_index = ?
    `).run(
      String(input.sourceType || ''),
      String(input.sheetName || ''),
      stats.scannedNonBlankRows,
      stats.persistedCandidateRows,
      stats.filteredRows,
      stats.collapsedDuplicateRows,
      stats.readerFilteredRows,
      stats.invalidRows,
      stats.visibleLinkRows,
      stats.hiddenLinkRows,
      stats.derivedZeroSourceRows,
      input.dateMin || null,
      input.dateMax || null,
      input.contentHash || null,
      json(input.filterReasonCounts || {}),
      index
    );
    this.db.exec(`RELEASE ${savepointName(index)}`);
    this.activeFileIndex = null;
  }

  rejectFile(fileIndex, error, input = {}) {
    this._assertOpen();
    const index = normalizedFileIndex(fileIndex);
    if (this.activeFileIndex === index) {
      this.db.exec(`ROLLBACK TO ${savepointName(index)}`);
      this.db.exec(`RELEASE ${savepointName(index)}`);
      this.activeFileIndex = null;
    }
    const normalized = normalizeError(error);
    const invalidRows = Number.isSafeInteger(Number(input.invalidRows))
      ? Number(input.invalidRows)
      : 0;
    this.db.prepare(`
      UPDATE job_files
      SET source_type = ?, sheet_name = ?, preflight_status = 'failed',
          scanned_non_blank_rows = ?, invalid_rows = ?,
          first_error_code = ?, first_error_message = ?, first_error_detail_json = ?
      WHERE file_index = ?
    `).run(
      String(input.sourceType || ''),
      String(input.sheetName || ''),
      Number(input.scannedNonBlankRows || 0),
      invalidRows,
      normalized.code,
      normalized.message,
      json(normalized.detailLines.slice(0, POSITION_IMPORT_MAX_ERROR_DETAILS)),
      index
    );
    this.db.prepare('DELETE FROM file_errors WHERE file_index = ?').run(index);
    const insert = this.db.prepare(`
      INSERT INTO file_errors(file_index, seq, row_number, code, field, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    normalized.detailLines
      .slice(0, POSITION_IMPORT_MAX_ERROR_DETAILS)
      .forEach((message, seq) => {
        insert.run(
          index,
          seq,
          input.rowNumber || null,
          normalized.code,
          input.field || null,
          message
        );
      });
  }

  listFiles() {
    this._assertOpen();
    return this.db.prepare(`
      SELECT file_index AS fileIndex, original_path AS originalPath,
             original_name AS originalName, staged_path AS stagedPath,
             source_type AS sourceType, sheet_name AS sheetName, sha256,
             size_bytes AS sizeBytes, source_snapshot_json AS sourceSnapshotJson,
             preflight_status AS preflightStatus,
             scanned_non_blank_rows AS scannedNonBlankRows,
             persisted_candidate_rows AS persistedCandidateRows,
             filtered_rows AS filteredRows,
             collapsed_duplicate_rows AS collapsedDuplicateRows,
             reader_filtered_rows AS readerFilteredRows,
             invalid_rows AS invalidRows, visible_link_rows AS visibleLinkRows,
             hidden_link_rows AS hiddenLinkRows,
             derived_zero_source_rows AS derivedZeroSourceRows,
             date_min AS dateMin, date_max AS dateMax, content_hash AS contentHash,
             filter_reason_json AS filterReasonJson,
             first_error_code AS firstErrorCode,
             first_error_message AS firstErrorMessage,
             first_error_detail_json AS firstErrorDetailJson
      FROM job_files
      ORDER BY file_index
    `).all().map((row) => ({
      ...row,
      sourceSnapshot: parsedJson(row.sourceSnapshotJson, 'source snapshot'),
      filterReasonCounts: parsedJson(row.filterReasonJson, 'filter reason counts'),
      firstErrorDetailLines: parsedJson(row.firstErrorDetailJson, 'first error detail')
    }));
  }

  listBankScopes() {
    this._assertOpen();
    return this.db.prepare(`
      SELECT channel, month_key AS monthKey, row_count AS rowCount
      FROM bank_scopes
      ORDER BY channel, month_key
    `).all();
  }

  manifest() {
    this._assertOpen();
    return {
      ledgerSchemaVersion: POSITION_IMPORT_LEDGER_SCHEMA_VERSION,
      protocolVersion: POSITION_IMPORT_PROTOCOL_VERSION,
      jobId: this.jobId,
      kind: this.kind,
      files: this.listFiles().map((file) => ({
        fileIndex: file.fileIndex,
        originalName: file.originalName,
        sourceType: file.sourceType,
        sheetName: file.sheetName,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        sourceSnapshot: file.sourceSnapshot,
        preflightStatus: file.preflightStatus,
        scannedNonBlankRows: file.scannedNonBlankRows,
        persistedCandidateRows: file.persistedCandidateRows,
        filteredRows: file.filteredRows,
        collapsedDuplicateRows: file.collapsedDuplicateRows,
        readerFilteredRows: file.readerFilteredRows,
        invalidRows: file.invalidRows,
        visibleLinkRows: file.visibleLinkRows,
        hiddenLinkRows: file.hiddenLinkRows,
        derivedZeroSourceRows: file.derivedZeroSourceRows,
        dateMin: file.dateMin,
        dateMax: file.dateMax,
        contentHash: file.contentHash,
        filterReasonCounts: file.filterReasonCounts,
        firstErrorCode: file.firstErrorCode,
        firstErrorMessage: file.firstErrorMessage,
        firstErrorDetailLines: file.firstErrorDetailLines
      })),
      bankScopes: this.kind === 'bank' ? this.listBankScopes() : [],
      anomalyReport: this.getMeta('anomalyReport')
        ? parsedJson(this.getMeta('anomalyReport'), 'anomaly report')
        : null,
      anomalyReports: this.getMeta('anomalyReports')
        ? parsedJson(this.getMeta('anomalyReports'), 'anomaly reports')
        : []
    };
  }

  assertConsistentCounts() {
    this._assertOpen();
    const persisted = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE
          WHEN preflight_status = 'accepted' THEN persisted_candidate_rows
          ELSE 0
        END), 0) AS allAcceptedRows,
        COALESCE(SUM(CASE
          WHEN preflight_status = 'accepted' AND source_type <> 'bank-account'
            THEN persisted_candidate_rows
          ELSE 0
        END), 0) AS keyedSourceRows,
        COALESCE(SUM(CASE
          WHEN preflight_status = 'accepted' THEN filtered_rows
          ELSE 0
        END), 0) AS filteredRows
      FROM job_files
    `).get();
    if (this.kind === 'source') {
      const seen = this.db.prepare(`
        SELECT COUNT(*) AS rowCount
        FROM source_seen_records
      `).get();
      const filtered = this.db.prepare(`
        SELECT COUNT(*) AS rowCount
        FROM filtered_source_rows
        WHERE is_owner = 1
      `).get();
      const expectedSeen = Number(persisted.keyedSourceRows) + Number(persisted.filteredRows);
      if (Number(seen.rowCount) !== expectedSeen
          || Number(filtered.rowCount) !== Number(persisted.filteredRows)) {
        throw new PositionImportLedgerError(
          'job ledger 来源记录计数不一致',
          [
            `来源身份数=${Number(seen.rowCount)}`,
            `文件持久化候选行数=${Number(persisted.keyedSourceRows)}`,
            `过滤身份数=${Number(filtered.rowCount)}`,
            `文件过滤行数=${Number(persisted.filteredRows)}`
          ]
        );
      }
      const conservationFailures = this.db.prepare(`
        SELECT original_name AS fileName,
               scanned_non_blank_rows AS scannedRows,
               persisted_candidate_rows AS acceptedRows,
               filtered_rows AS filteredRows,
               collapsed_duplicate_rows AS duplicateRows,
               reader_filtered_rows AS readerFilteredRows
        FROM job_files
        WHERE preflight_status = 'accepted'
          AND scanned_non_blank_rows <>
            persisted_candidate_rows + filtered_rows
            + collapsed_duplicate_rows + reader_filtered_rows
        ORDER BY file_index
      `).all();
      if (conservationFailures.length > 0) {
        throw new PositionImportLedgerError(
          'job ledger 文件行数不守恒',
          conservationFailures.slice(0, 20).map((row) => (
            `${row.fileName}：扫描=${row.scannedRows}，正常=${row.acceptedRows}，` +
            `过滤=${row.filteredRows}，重复=${row.duplicateRows}，读取过滤=${row.readerFilteredRows}`
          ))
        );
      }
      return;
    }

    const bank = this.db.prepare(`
      SELECT COUNT(*) AS rowCount
      FROM bank_seen_biz_ids
    `).get();
    const scoped = this.db.prepare(`
      SELECT COALESCE(SUM(row_count), 0) AS rowCount
      FROM bank_scopes
    `).get();
    const expected = Number(persisted.allAcceptedRows);
    if (Number(bank.rowCount) !== expected || Number(scoped.rowCount) !== expected) {
      throw new PositionImportLedgerError(
        'job ledger 银行记录计数不一致',
        [
          `银行 BizId 数=${Number(bank.rowCount)}`,
          `月份范围行数=${Number(scoped.rowCount)}`,
          `文件持久化候选行数=${expected}`
        ]
      );
    }
  }

  async seal() {
    this._assertOpen();
    if (this.activeFileIndex !== null || this.activeBatchName !== null) {
      throw new PositionImportLedgerError('存在未结束的 batch/savepoint，不能封存');
    }
    this.assertConsistentCounts();
    const manifest = this.manifest();
    const manifestHash = stableHash(manifest);
    this.setMeta('manifest', manifest);
    this.setMeta('manifestHash', manifestHash);
    const checks = this.db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
      throw new PositionImportLedgerError('job ledger quick_check 失败');
    }
    this.close();
    if (fs.existsSync(`${this.ledgerPath}-journal`)) {
      throw new PositionImportLedgerError('job ledger 封存后仍存在未完成 journal');
    }
    const before = await fs.promises.stat(this.ledgerPath);
    const hashed = await hashFileSha256Async(this.ledgerPath);
    const after = await fs.promises.stat(this.ledgerPath);
    const snapshot = sourceSnapshotFromStat(after);
    if (!sourceSnapshotMatchesStat(sourceSnapshotFromStat(before), after) ||
        !snapshot ||
        hashed.sizeBytes !== snapshot.sizeBytes) {
      throw new PositionImportLedgerError('job ledger 封存摘要期间发生变化');
    }
    return {
      ledgerPath: this.ledgerPath,
      ledgerSchemaVersion: POSITION_IMPORT_LEDGER_SCHEMA_VERSION,
      ledgerSnapshot: snapshot,
      ledgerSizeBytes: hashed.sizeBytes,
      ledgerSha256: hashed.sha256,
      manifestHash,
      manifest
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.db) {
      try { this.db.close(); } finally { this.db = null; }
    }
  }
}

async function verifySealedLedger(evidence) {
  const ledgerPath = path.resolve(String(evidence && evidence.ledgerPath || ''));
  const expectedSnapshot = evidence && evidence.ledgerSnapshot;
  const expectedSize = Number(evidence && evidence.ledgerSizeBytes);
  const expectedSha = String(evidence && evidence.ledgerSha256 || '').toLowerCase();
  const expectedManifestHash = String(evidence && evidence.manifestHash || '');
  const before = await fs.promises.stat(ledgerPath);
  if (!sourceSnapshotMatchesStat(expectedSnapshot, before) ||
      Number(before.size) !== expectedSize) {
    throw new PositionImportLedgerError('job ledger snapshot 或 size 不一致');
  }
  const firstHash = await hashFileSha256Async(ledgerPath);
  if (firstHash.sha256 !== expectedSha || firstHash.sizeBytes !== expectedSize) {
    throw new PositionImportLedgerError('job ledger SHA-256 不一致');
  }

  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    db.exec('PRAGMA cache_size=-2048;');
    db.exec('PRAGMA mmap_size=0;');
    db.exec('PRAGMA temp_store=FILE;');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
      throw new PositionImportLedgerError('只读 job ledger quick_check 失败');
    }
    const metaRows = db.prepare('SELECT key, value FROM job_meta').all();
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    if (Number(meta.get('ledgerSchemaVersion')) !== POSITION_IMPORT_LEDGER_SCHEMA_VERSION ||
        Number(meta.get('protocolVersion')) !== POSITION_IMPORT_PROTOCOL_VERSION) {
      throw new PositionImportLedgerError('job ledger schema/protocol 版本不兼容');
    }
    const manifest = parsedJson(meta.get('manifest'), 'manifest');
    const manifestHash = meta.get('manifestHash');
    if (manifestHash !== expectedManifestHash ||
        stableHash(manifest) !== expectedManifestHash) {
      throw new PositionImportLedgerError('job ledger manifest hash 不一致');
    }
    const afterOpen = await fs.promises.stat(ledgerPath);
    const secondHash = await hashFileSha256Async(ledgerPath);
    if (!sourceSnapshotMatchesStat(expectedSnapshot, afterOpen) ||
        secondHash.sha256 !== expectedSha ||
        secondHash.sizeBytes !== expectedSize) {
      throw new PositionImportLedgerError('job ledger 打开后发生替换或截断');
    }
    return { db, manifest, meta };
  } catch (error) {
    try { db.close(); } catch (_closeError) {}
    throw error;
  }
}

module.exports = {
  LEDGER_SCHEMA,
  FILE_STAT_COLUMNS,
  PositionImportLedgerError,
  PositionImportLedger,
  verifySealedLedger
};
