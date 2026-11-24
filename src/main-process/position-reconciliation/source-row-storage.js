'use strict';

// 平盘链接原始表行的存储（v3.2.22）：只保存程序读取的必用列（SOURCE_REQUIRED_FIELDS），
// 一行一份；其余列留在原始文件里，经 raw_version + source_row_number 追溯。
// Main 的 store 与导入进程共用这里的取列、来源记录标识和写入语句。
// 本文件不依赖 store，避免与导入进程形成环形依赖。

const {
  LINK_HEADERS,
  RAW_ROW_NUMBER_HEADER,
  RAW_VERSION_HEADER,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('./constants');
const { PositionReconciliationError, stableHash, stableJson, text } = require('./common');
const { RAW_FILE_STATUSES } = require('./bank-row-storage');

const DATE_JSON_TYPE_KEY = '__position_reconciliation_type__';

// 来源行导出列：必用列 + 原始版本号 / 行号。
function sourceExportHeaders(sourceType) {
  return [...SOURCE_REQUIRED_FIELDS[sourceType], RAW_VERSION_HEADER, RAW_ROW_NUMBER_HEADER];
}

// 从按当前结构读出的整行取出必用列，缺的列按空串；列顺序固定，保证同内容得到同一个标识。
function pickSourceFields(sourceType, row) {
  const picked = {};
  for (const field of SOURCE_REQUIRED_FIELDS[sourceType]) picked[field] = row[field] ?? '';
  return picked;
}

// 来源记录标识：保存下来的必用列内容相同即同一条记录（再次导入时更新文件血缘，不新增）；
// 业务单号相同但内容不同的行各自成为独立记录。标识只在入库时算一次，不用于任何复核。
function sourceRecordKeyOf(fields) {
  return stableHash(fields);
}

// 账户快照允许内容完全相同的两行独立存在；整表替换后行号是稳定的批内身份。
function accountRecordKeyOf(fields, sourceRowNumber) {
  return stableHash({ row: fields, sourceRowNumber });
}

function serializeSourceFields(fields) {
  return JSON.stringify(fields, function replacer(key, item) {
    const original = key === '' ? fields : this[key];
    if (original instanceof Date) {
      if (Number.isNaN(original.getTime())) return 'Invalid Date';
      return { [DATE_JSON_TYPE_KEY]: 'Date', value: original.toISOString() };
    }
    return item;
  });
}

function sameSourceFields(left, right) {
  return stableJson(left) === stableJson(right);
}

function insertSourceRowStatement(db) {
  return db.prepare(`
    INSERT INTO position_source_rows(
      source_type, business_key, event_date, month_key,
      raw_version, source_row_number, row_hash, fields_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
}

function insertLinkRowStatement(db) {
  return db.prepare(`
    INSERT INTO position_link_rows(
      source_type, business_key, source_record_key, source_row_id,
      source_row_number, ordinal, leg_index, recon_id, merchant_id,
      currency, amount, fund_type, status, event_date, visible, linked_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

// 写入一条来源记录派生出的链接行；返回可见 / 隐藏行数。链接行必须带齐该来源的固定列。
function writeLinkRows(insertLink, sourceType, record, derived) {
  let visible = 0;
  let hidden = 0;
  for (const item of derived) {
    const linked = item.row;
    const missing = LINK_HEADERS[sourceType].filter(
      (header) => !Object.prototype.hasOwnProperty.call(linked, header)
    );
    if (missing.length > 0) {
      throw new PositionReconciliationError(
        'position-side-data-invalid',
        `链接行 ${sourceType}/${text(record.businessKey)} 缺少必填字段`,
        missing
      );
    }
    const isVisible = item.visible !== false;
    insertLink.run(
      sourceType,
      text(record.businessKey),
      text(record.sourceRecordKey),
      Number(record.sourceRowId),
      Number(record.sourceRowNumber),
      Number(record.sourceRowId),
      Number(item.legIndex),
      text(linked.ReconID),
      text(linked.MerchantId),
      text(sourceType === SOURCE_TYPES.BANK_ACCOUNT ? linked['币种'] : linked.Currency),
      text(linked.Amount),
      text(linked.FundType),
      text(linked['调拨状态'] || linked['付款状态']),
      text(linked['交易时间'] || linked['创建时间'] || linked.billDate || linked['账单日期']),
      isVisible ? 1 : 0,
      serializeSourceFields(linked)
    );
    if (isVisible) visible += 1;
    else hidden += 1;
  }
  return { visible, hidden };
}

function insertSourceRawFile(db, {
  sourceType, originalName, originalPath, sheetName = '', sizeBytes = 0, sha256 = '',
  operationToken = '', archiveBatchNumber = ''
}) {
  return Number(db.prepare(`
    INSERT INTO position_raw_files(
      kind, original_name, original_path, sheet_name, size_bytes, sha256, row_count,
      status, operation_token, archive_batch_number
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    sourceType,
    text(originalName),
    String(originalPath || ''),
    text(sheetName),
    Number(sizeBytes) || 0,
    text(sha256),
    RAW_FILE_STATUSES.ACTIVE,
    text(operationToken),
    text(archiveBatchNumber)
  ).lastInsertRowid);
}

// 既没有来源行、也没有未处理过滤记录引用的原始文件版本标为「已被替换」；原件仍在存档中心。
function markSupersededSourceRawFiles(db, sourceType) {
  return Number(db.prepare(`
    UPDATE position_raw_files
    SET status = ?, superseded_at = CURRENT_TIMESTAMP
    WHERE kind = ? AND status = ?
      AND NOT EXISTS (
        SELECT 1 FROM position_source_rows source
        WHERE source.raw_version = position_raw_files.version
      )
      AND NOT EXISTS (
        SELECT 1 FROM position_filtered_source_rows filtered
        WHERE filtered.raw_version = position_raw_files.version
          AND filtered.resolved_at IS NULL
      )
  `).run(RAW_FILE_STATUSES.SUPERSEDED, sourceType, RAW_FILE_STATUSES.ACTIVE).changes || 0);
}

module.exports = {
  accountRecordKeyOf,
  insertLinkRowStatement,
  insertSourceRawFile,
  insertSourceRowStatement,
  markSupersededSourceRawFiles,
  pickSourceFields,
  sameSourceFields,
  serializeSourceFields,
  sourceExportHeaders,
  sourceRecordKeyOf,
  writeLinkRows
};
