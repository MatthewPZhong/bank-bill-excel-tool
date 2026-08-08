'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  PENDING_RAW_CONTRACT_V1,
  PENDING_RAW_CONTRACT_V2,
  getRawContractHeaders,
  getSourceDefinition
} = require('../backend/vcc-financial-op/definitions');
const repository = require('../backend/vcc-financial-op-db/repository');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const MAX_DATA_ROWS_PER_SHEET = 1048575;

const DISPOSITION_TEXT = Object.freeze({
  idempotent_skip: '幂等跳过',
  idempotent_conflict: '幂等冲突',
  invalid_key: '空键/非法键',
  format_error: '格式错误',
  rolled_back: '事务回滚'
});

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function dispositionsForTab(tab) {
  if (tab === 'skips') return ['idempotent_skip'];
  if (tab === 'conflicts') return ['idempotent_conflict'];
  if (tab === 'other') return ['invalid_key', 'format_error', 'rolled_back'];
  return ['idempotent_skip', 'idempotent_conflict', 'invalid_key', 'format_error', 'rolled_back'];
}

function detailHeaders(sourceType, rawContractVersion = PENDING_RAW_CONTRACT_V1) {
  const definition = getSourceDefinition(sourceType);
  const contractHeaders = getRawContractHeaders(sourceType, rawContractVersion);
  const original = definition && contractHeaders ? [...contractHeaders] : [];
  const metadata = [
    '审计_账期', '审计_原表类型', '审计_公司主体', '审计_幂等键', '审计_处置结果',
    '审计_来源文件', '审计_sheet', '审计_原始行号', '审计_导入批次',
    '审计_导入时间', '审计_异常字段', '审计_原因', '审计_差异字段'
  ];
  const existing = original.map((header) => `已保留_${header}`);
  const existingMetadata = [
    '已保留_公司主体', '已保留_来源文件', '已保留_sheet', '已保留_原始行号',
    '已保留_导入记录', '已保留_首次导入时间'
  ];
  return { original, metadata, existing, existingMetadata, all: [...original, ...metadata, ...existing, ...existingMetadata] };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5EA8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

function createDetailSheet(workbook, baseName, index, headers) {
  const suffix = index > 1 ? `-${index}` : '';
  const sheet = workbook.addWorksheet(`${baseName}${suffix}`.slice(0, 31));
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  headerRow.commit();
  return sheet;
}

function rawValues(rawJson, sourceType, rawContractVersion, targetHeaders) {
  const values = parseJson(rawJson, []);
  const sourceHeaders = getRawContractHeaders(sourceType, rawContractVersion) || [];
  const byHeader = Object.fromEntries(sourceHeaders.map((header, index) => [header, values[index]]));
  return targetHeaders.map((header) => String(byHeader[header] ?? ''));
}

function detailRowValues(row, headers, record) {
  const existingRaw = row.existing_raw_json || row.comparison_raw_json || '[]';
  return [
    ...rawValues(
      row.raw_json,
      row.source_type,
      row.raw_contract_version,
      headers.original
    ),
    row.target_month,
    SOURCE_LABELS[row.source_type] || row.source_type,
    row.subject || '',
    row.idempotency_key || '',
    DISPOSITION_TEXT[row.disposition] || row.disposition,
    row.source_file,
    row.sheet_name,
    row.source_row,
    record.batch_id,
    row.created_at,
    row.validation_field || '',
    row.validation_message || '',
    parseJson(row.diff_fields_json, []).join('、'),
    ...rawValues(
      existingRaw,
      row.source_type,
      row.existing_raw_contract_version || row.comparison_raw_contract_version,
      headers.original
    ),
    row.existing_subject || row.comparison_subject || '',
    row.existing_source_file || row.comparison_source_file || '',
    row.existing_sheet_name || row.comparison_sheet_name || '',
    row.existing_source_row || row.comparison_source_row || '',
    row.existing_import_record_id || row.comparison_import_record_id || '',
    row.existing_imported_at || row.comparison_created_at || ''
  ];
}

function queryDetailRows(db, recordId, dispositions, filters) {
  const conditions = [
    'i.import_record_id = ?',
    `i.disposition IN (${dispositions.map(() => '?').join(', ')})`
  ];
  const params = [recordId, ...dispositions];
  if (filters.key) {
    conditions.push('i.idempotency_key LIKE ?');
    params.push(`%${filters.key}%`);
  }
  if (filters.fileName) {
    conditions.push('i.source_file LIKE ?');
    params.push(`%${filters.fileName}%`);
  }
  return db.prepare(`
    SELECT i.*,
           COALESCE(e.raw_json, i.existing_raw_json_snapshot) AS existing_raw_json,
           COALESCE(e.raw_contract_version, i.existing_raw_contract_version_snapshot) AS existing_raw_contract_version,
           COALESCE(e.subject, i.existing_subject_snapshot) AS existing_subject,
           COALESCE(e.source_file, i.existing_source_file_snapshot) AS existing_source_file,
           COALESCE(e.sheet_name, i.existing_sheet_name_snapshot) AS existing_sheet_name,
           COALESCE(e.source_row, i.existing_source_row_snapshot) AS existing_source_row,
           COALESCE(e.import_record_id, i.existing_import_record_id_snapshot) AS existing_import_record_id,
           COALESCE(e.first_imported_at, i.existing_imported_at_snapshot) AS existing_imported_at,
           c.raw_json AS comparison_raw_json,
           c.raw_contract_version AS comparison_raw_contract_version,
           c.subject AS comparison_subject,
           c.source_file AS comparison_source_file,
           c.sheet_name AS comparison_sheet_name,
           c.source_row AS comparison_source_row,
           c.import_record_id AS comparison_import_record_id,
           c.created_at AS comparison_created_at
    FROM vcc_fin_op_import_rows i
    LEFT JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
    LEFT JOIN vcc_fin_op_import_rows c ON c.id = i.comparison_import_row_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.id
  `).iterate(...params);
}

function auditRawContractVersion(db, recordId, sourceType) {
  if (sourceType !== SOURCE_TYPES.PENDING) return PENDING_RAW_CONTRACT_V1;
  const row = db.prepare(`
    SELECT 1 AS has_v1
    FROM vcc_fin_op_import_rows i
    LEFT JOIN vcc_fin_op_effective_rows e ON e.id = i.existing_effective_id
    LEFT JOIN vcc_fin_op_import_rows c ON c.id = i.comparison_import_row_id
    WHERE i.import_record_id = ?
      AND (
        i.raw_contract_version = ?
        OR COALESCE(e.raw_contract_version, i.existing_raw_contract_version_snapshot) = ?
        OR c.raw_contract_version = ?
      )
    LIMIT 1
  `).get(
    recordId,
    PENDING_RAW_CONTRACT_V1,
    PENDING_RAW_CONTRACT_V1,
    PENDING_RAW_CONTRACT_V1
  );
  return row ? PENDING_RAW_CONTRACT_V1 : PENDING_RAW_CONTRACT_V2;
}

function writeSystemAttempts(workbook, db, record, dispositions, filters) {
  const conditions = [
    'import_record_id = ?',
    `disposition IN (${dispositions.map(() => '?').join(', ')})`
  ];
  const params = [record.id, ...dispositions];
  if (filters.key) {
    conditions.push('subject LIKE ?');
    params.push(`%${filters.key}%`);
  }
  if (filters.fileName) {
    conditions.push('source_file LIKE ?');
    params.push(`%${filters.fileName}%`);
  }
  const rows = db.prepare(`
    SELECT a.*,
           COALESCE(e.balances_json, a.existing_balances_json_snapshot) AS existing_balances_json,
           COALESCE(e.source_file, a.existing_source_file_snapshot) AS existing_source_file,
           COALESCE(e.sheet_name, a.existing_sheet_name_snapshot) AS existing_sheet_name,
           COALESCE(e.source_row, a.existing_source_row_snapshot) AS existing_source_row,
           COALESCE(e.import_record_id, a.existing_import_record_id_snapshot) AS existing_import_record_id,
           COALESCE(e.imported_at, a.existing_imported_at_snapshot) AS existing_imported_at,
           c.balances_json AS comparison_balances_json,
           c.source_file AS comparison_source_file,
           c.sheet_name AS comparison_sheet_name,
           c.source_row AS comparison_source_row,
           c.import_record_id AS comparison_import_record_id,
           c.created_at AS comparison_imported_at
    FROM vcc_fin_op_system_snapshot_attempts a
    LEFT JOIN vcc_fin_op_system_snapshots e ON e.id = a.existing_snapshot_id
    LEFT JOIN vcc_fin_op_system_snapshot_attempts c ON c.id = a.comparison_attempt_id
    WHERE ${conditions.map((condition) => `a.${condition}`).join(' AND ')}
    ORDER BY a.id
  `).all(...params);
  if (rows.length === 0) return 0;
  const sheet = workbook.addWorksheet('系统OP快照审计');
  const headers = [
    '账期', '主体', '来源文件', 'sheet', '原始行号',
    '处置结果', '余额快照', '原因', '差异币种', '导入批次', '导入时间',
    '已保留_余额快照', '已保留_来源文件', '已保留_sheet', '已保留_原始行号',
    '已保留_导入记录', '已保留_首次导入时间'
  ];
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  headerRow.commit();
  for (const row of rows) {
    const currentBalances = parseJson(row.balances_json, {});
    const comparedBalances = parseJson(
      row.existing_balances_json || row.comparison_balances_json,
      {}
    );
    const differenceCurrencies = Object.keys({ ...currentBalances, ...comparedBalances })
      .filter((currency) => String(currentBalances[currency] ?? '') !== String(comparedBalances[currency] ?? ''))
      .sort()
      .join('、');
    sheet.addRow([
      row.target_month,
      row.subject,
      row.source_file,
      row.sheet_name,
      row.source_row,
      DISPOSITION_TEXT[row.disposition] || row.disposition,
      row.balances_json,
      row.message || '',
      differenceCurrencies,
      record.batch_id,
      row.created_at,
      row.existing_balances_json || row.comparison_balances_json || '',
      row.existing_source_file || row.comparison_source_file || '',
      row.existing_sheet_name || row.comparison_sheet_name || '',
      row.existing_source_row || row.comparison_source_row || '',
      row.existing_import_record_id || row.comparison_import_record_id || '',
      row.existing_imported_at || row.comparison_imported_at || ''
    ]).commit();
  }
  sheet.commit();
  return rows.length;
}

function writeImportErrors(workbook, db, recordId) {
  const errors = db.prepare(`
    SELECT * FROM vcc_fin_op_import_errors
    WHERE import_record_id = ? ORDER BY id
  `).all(recordId);
  if (errors.length === 0) return 0;
  const sheet = workbook.addWorksheet('导入异常');
  const header = sheet.addRow(['来源文件', 'sheet', '原始行号', '字段', '错误码', '原因', '记录时间']);
  styleHeader(header);
  header.commit();
  for (const error of errors) {
    sheet.addRow([
      error.source_file || '', error.sheet_name || '', error.source_row || '',
      error.field_name || '', error.error_code, error.message, error.created_at
    ]).commit();
  }
  sheet.commit();
  return errors.length;
}

async function writeImportAuditWorkbook({ db, recordId, tab = 'all', outputPath, key = '', fileName = '' }) {
  const record = repository.getImportRecord(db, Number(recordId));
  if (!record) throw new Error(`导入记录不存在：${recordId}`);
  const dispositions = dispositionsForTab(tab);
  let rowCount = 0;
  let errorCount = 0;
  await writeXlsxAtomically({
    outputPath,
    writeStaged: async (stagedPath) => {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: stagedPath,
        useStyles: true,
        useSharedStrings: false
      });
      if (record.source_type !== SOURCE_TYPES.SYSTEM_OP) {
        const headers = detailHeaders(
          record.source_type,
          auditRawContractVersion(db, record.id, record.source_type)
        );
        let sheetIndex = 1;
        let rowsInSheet = 0;
        let sheet = createDetailSheet(workbook, '导入审计', sheetIndex, headers.all);
        for (const row of queryDetailRows(db, record.id, dispositions, {
          key: String(key || '').trim(),
          fileName: String(fileName || '').trim()
        })) {
          if (rowsInSheet >= MAX_DATA_ROWS_PER_SHEET) {
            sheet.commit();
            sheetIndex += 1;
            rowsInSheet = 0;
            sheet = createDetailSheet(workbook, '导入审计', sheetIndex, headers.all);
          }
          sheet.addRow(detailRowValues(row, headers, record)).commit();
          rowsInSheet += 1;
          rowCount += 1;
        }
        sheet.commit();
      } else {
        rowCount += writeSystemAttempts(workbook, db, record, dispositions, {
          key: String(key || '').trim(),
          fileName: String(fileName || '').trim()
        });
      }
      errorCount = writeImportErrors(workbook, db, record.id);
      if (rowCount === 0 && errorCount === 0) {
        const sheet = workbook.addWorksheet('导入审计');
        const row = sheet.addRow(['当前筛选条件下没有审计明细']);
        row.commit();
        sheet.commit();
      }
      await workbook.commit();
    }
  });
  return {
    filePath: path.resolve(outputPath),
    recordId: record.id,
    rowCount,
    errorCount
  };
}

module.exports = {
  MAX_DATA_ROWS_PER_SHEET,
  DISPOSITION_TEXT,
  dispositionsForTab,
  detailHeaders,
  auditRawContractVersion,
  writeImportAuditWorkbook
};
