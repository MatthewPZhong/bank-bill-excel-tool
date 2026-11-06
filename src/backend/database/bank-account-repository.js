'use strict';

// v3.2.15：设置 → 账户管理的清结算系统银行账户表仓储。
//   表由 migrations.ensureBankAccountSnapshotSupport 建立；主库只保留当前一份账户表，导入整份替换。
//   元数据与账户行在同一事务内替换；预检后账户表已被替换（snapshot_no 变化）时在事务内判定并整体回滚。

const SNAPSHOT_ID = 1;

function parseHeaders(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch (_error) {
    return [];
  }
}

function parseValues(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value.map((item) => (item === null || item === undefined ? '' : String(item))) : [];
  } catch (_error) {
    return [];
  }
}

function readSnapshot(db) {
  const row = db.prepare(`
    SELECT snapshot_no AS snapshotNo, file_name AS fileName, file_extension AS fileExtension,
      size_bytes AS sizeBytes, sha256, sheet_name AS sheetName, headers_json AS headersJson,
      channel_header AS channelHeader, structure_version_id AS structureVersionId,
      structure_label AS structureLabel, row_count AS rowCount, app_version AS appVersion,
      imported_at AS importedAt
    FROM bank_account_snapshot WHERE id = ?
  `).get(SNAPSHOT_ID);
  if (!row) return null;
  const { headersJson, ...rest } = row;
  return { ...rest, headers: parseHeaders(headersJson) };
}

function currentSnapshotNo(db) {
  const row = db.prepare('SELECT snapshot_no AS snapshotNo FROM bank_account_snapshot WHERE id = ?').get(SNAPSHOT_ID);
  return row ? row.snapshotNo : 0;
}

// 渠道值：非空去重，按中文排序（与界面下拉一致）。
function listChannels(db) {
  return db.prepare(`
    SELECT channel, COUNT(*) AS rowCount FROM bank_account_rows
    WHERE channel <> '' GROUP BY channel
  `).all()
    .map((row) => ({ channel: row.channel, rowCount: row.rowCount }))
    .sort((left, right) => left.channel.localeCompare(right.channel, 'zh-Hans-CN'));
}

function countRows(db, { channel = '' } = {}) {
  const row = channel
    ? db.prepare('SELECT COUNT(*) AS total FROM bank_account_rows WHERE channel = ?').get(channel)
    : db.prepare('SELECT COUNT(*) AS total FROM bank_account_rows').get();
  return row ? row.total : 0;
}

// channel 为空串时返回全部行；limit 为 0 时不分页。
function listRows(db, { channel = '', offset = 0, limit = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (channel) {
    clauses.push('WHERE channel = ?');
    params.push(channel);
  }
  clauses.push('ORDER BY ordinal ASC');
  if (limit > 0) {
    clauses.push('LIMIT ? OFFSET ?');
    params.push(limit, offset);
  }
  return db.prepare(`
    SELECT ordinal, excel_row_number AS excelRowNumber, channel, values_json AS valuesJson
    FROM bank_account_rows ${clauses.join(' ')}
  `).all(...params).map((row) => ({
    ordinal: row.ordinal,
    excelRowNumber: row.excelRowNumber,
    channel: row.channel,
    values: parseValues(row.valuesJson)
  }));
}

class BankAccountSnapshotConflictError extends Error {
  constructor(expected, actual) {
    super('账户表已被替换，请重新导入');
    this.name = 'BankAccountSnapshotConflictError';
    this.code = 'bank-account-snapshot-conflict';
    this.expectedSnapshotNo = expected;
    this.actualSnapshotNo = actual;
  }
}

// payload.expectedSnapshotNo：预检时的 snapshot_no（未导入为 0）；不一致时抛冲突，不写入。
function replaceSnapshot(db, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new TypeError('账户表没有账户行');
  db.exec('BEGIN IMMEDIATE');
  try {
    const actual = currentSnapshotNo(db);
    if (actual !== payload.expectedSnapshotNo) throw new BankAccountSnapshotConflictError(payload.expectedSnapshotNo, actual);
    const snapshotNo = actual + 1;
    db.prepare('DELETE FROM bank_account_rows').run();
    db.prepare(`
      INSERT INTO bank_account_snapshot (
        id, snapshot_no, file_name, file_extension, size_bytes, sha256, sheet_name, headers_json,
        channel_header, structure_version_id, structure_label, row_count, app_version, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        snapshot_no = excluded.snapshot_no,
        file_name = excluded.file_name,
        file_extension = excluded.file_extension,
        size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256,
        sheet_name = excluded.sheet_name,
        headers_json = excluded.headers_json,
        channel_header = excluded.channel_header,
        structure_version_id = excluded.structure_version_id,
        structure_label = excluded.structure_label,
        row_count = excluded.row_count,
        app_version = excluded.app_version,
        imported_at = excluded.imported_at
    `).run(
      SNAPSHOT_ID,
      snapshotNo,
      payload.fileName,
      payload.fileExtension,
      payload.sizeBytes,
      payload.sha256,
      payload.sheetName || '',
      JSON.stringify(payload.headers),
      payload.channelHeader,
      payload.structureVersionId || '',
      payload.structureLabel || '',
      rows.length,
      payload.appVersion || '',
      payload.importedAt
    );
    const insert = db.prepare(`
      INSERT INTO bank_account_rows (ordinal, excel_row_number, channel, values_json) VALUES (?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      insert.run(index + 1, row.excelRowNumber, row.channel || '', JSON.stringify(row.values));
    });
    db.exec('COMMIT');
    return { snapshotNo, rowCount: rows.length };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* 保留原错误 */ }
    throw error;
  }
}

module.exports = {
  BankAccountSnapshotConflictError,
  countRows,
  currentSnapshotNo,
  listChannels,
  listRows,
  readSnapshot,
  replaceSnapshot
};
