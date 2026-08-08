'use strict';

const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  SOURCE_TYPES,
  SOURCE_LABELS,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS,
  getSourceDefinition,
  headersEqual
} = require('../backend/vcc-financial-op/definitions');
const {
  normalizeYearMonth,
  pendingCanonicalValues
} = require('../backend/vcc-financial-op/row-mapper');
const { writeXlsxAtomically } = require('./vcc-financial-op-output-publication');

const MAX_DATA_ROWS_PER_SHEET = 1048575;
const WORKBOOK_ABORT_TIMEOUT_MS = 2000;
const EXPORT_KINDS = Object.freeze({ RAW: 'raw', CHECK: 'check' });
const ALLOWED_SOURCE_TYPES = new Set(Object.values(SOURCE_TYPES));

const CHECK_EXPORT_DEFINITIONS = Object.freeze({
  [SOURCE_TYPES.RECHARGE]: Object.freeze({
    label: 'VCC充值清退明细_校验表',
    sourceHeaders: Object.freeze([
      '订单号', 'BillDate', '业务部门', '对手部门', '业务子类型',
      '出入方向', '公司主体', '我方币种', '我方到账金额'
    ]),
    derivedHeaders: Object.freeze(['发生额'])
  }),
  [SOURCE_TYPES.FEE_FX]: Object.freeze({
    label: 'VCC费用及换汇明细_校验表',
    sourceHeaders: Object.freeze([
      '订单号', 'BillDate', '业务部门', '业务子类型', '出入方向',
      '公司主体', '我方币种', '我方到账金额'
    ]),
    derivedHeaders: Object.freeze(['发生额'])
  }),
  [SOURCE_TYPES.CHANNEL]: Object.freeze({
    label: 'VCC通道明细_校验表',
    sourceHeaders: Object.freeze([
      '渠道订单号', '账单日期', '部门', '通道名称', 'MID', '交易金额',
      '交易币种', '清算金额', '清算币种', '借贷方向', 'billdate',
      '结算币种', '实际到账金额'
    ]),
    derivedHeaders: Object.freeze(['公司主体', '统计币种', '发生额'])
  }),
  [SOURCE_TYPES.PENDING]: Object.freeze({
    label: '移除归档Pending账单_校验表',
    sourceHeaders: Object.freeze([
      'PendingBizId', '主体', '对账类型', 'channel', '金额', '币种',
      '流水_币种', '流水_对账金额'
    ]),
    derivedHeaders: Object.freeze(['Pending发生额', '流水_发生额', '是否错币'])
  }),
  [SOURCE_TYPES.SYSTEM_OP]: Object.freeze({
    label: SOURCE_LABELS[SOURCE_TYPES.SYSTEM_OP],
    sourceHeaders: SYSTEM_OP_HEADERS,
    derivedHeaders: Object.freeze([])
  })
});

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDatasetExportScope(targetMonth, sourceType, targetKind) {
  const month = normalizeYearMonth(targetMonth);
  if (!month) throw exportError('invalid-month', `月份账期格式无效：${targetMonth || ''}`);
  const type = String(sourceType || '').trim();
  if (!ALLOWED_SOURCE_TYPES.has(type)) {
    throw exportError('invalid-source-type', `不支持导出的目标表：${sourceType || ''}`);
  }
  const kind = String(targetKind || '').trim();
  if (!Object.values(EXPORT_KINDS).includes(kind)) {
    throw exportError('invalid-target-kind', `不支持的导出表类型：${targetKind || ''}`);
  }
  const tableName = kind === EXPORT_KINDS.RAW
    ? SOURCE_LABELS[type]
    : CHECK_EXPORT_DEFINITIONS[type].label;
  return { targetMonth: month, sourceType: type, targetKind: kind, tableName };
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function detailRawValues(row) {
  const definition = getSourceDefinition(row.source_type);
  const values = parseJson(row.raw_json, null);
  let normalizedValues = values;
  if (definition && Array.isArray(values) && row.source_type === SOURCE_TYPES.PENDING) {
    try {
      normalizedValues = pendingCanonicalValues(values, row.raw_contract_version);
    } catch (_error) {
      normalizedValues = null;
    }
  }
  if (!definition || !Array.isArray(normalizedValues) || normalizedValues.length !== definition.headers.length) {
    throw exportError(
      'invalid-export-lineage',
      `${SOURCE_LABELS[row.source_type] || row.source_type}有效行 ${row.id} 的原始字段血缘不完整，无法导出`
    );
  }
  return normalizedValues.map((value) => value == null ? '' : String(value));
}

function selectedValues(sourceType, values, headers) {
  const definition = getSourceDefinition(sourceType);
  return headers.map((header) => values[definition.indexes[header]] ?? '');
}

function detailCheckValues(row, rawValues) {
  const definition = CHECK_EXPORT_DEFINITIONS[row.source_type];
  const sourceValues = selectedValues(row.source_type, rawValues, definition.sourceHeaders);
  const required = (value, field) => {
    if (value === null || value === undefined || value === '') {
      throw exportError(
        'invalid-export-lineage',
        `${definition.label}有效行 ${row.id} 缺少已生效字段“${field}”，无法导出`
      );
    }
    return value;
  };
  if (row.source_type === SOURCE_TYPES.CHANNEL) {
    return [
      ...sourceValues,
      required(row.subject, '公司主体'),
      required(row.stat_currency, '统计币种'),
      required(row.signed_amount, '发生额')
    ];
  }
  if (row.source_type === SOURCE_TYPES.PENDING) {
    const mismatchValue = required(row.currency_mismatch, '是否错币');
    let currencyMismatch;
    if (mismatchValue === true || mismatchValue === 1 || mismatchValue === '1') {
      currencyMismatch = true;
    } else if (mismatchValue === false || mismatchValue === 0 || mismatchValue === '0') {
      currencyMismatch = false;
    } else {
      throw exportError(
        'invalid-export-lineage',
        `${definition.label}有效行 ${row.id} 的已生效字段“是否错币”不是 0/1，无法导出`
      );
    }
    return [
      ...sourceValues,
      required(row.pending_amount, 'Pending发生额'),
      required(row.flow_amount, '流水_发生额'),
      currencyMismatch
    ];
  }
  required(row.subject, '公司主体');
  required(row.stat_currency, '统计币种');
  return [...sourceValues, required(row.signed_amount, '发生额')];
}

function systemSnapshotRows(snapshot) {
  const payload = parseJson(snapshot.raw_json, null);
  if (
    !payload
    || !headersEqual(payload.displayHeaders, SYSTEM_OP_HEADERS)
    || !Array.isArray(payload.rows)
    || payload.rows.length !== SUPPORTED_CURRENCIES.length
  ) {
    throw exportError(
      'invalid-export-lineage',
      `系统财务OP主体 ${snapshot.subject || snapshot.id} 的 16 列原始行血缘不完整，无法导出`
    );
  }
  const normalizedCurrencies = new Set();
  const rows = payload.rows.map((row) => {
    if (!row || !Array.isArray(row.displayValues) || row.displayValues.length !== SYSTEM_OP_HEADERS.length) {
      throw exportError(
        'invalid-export-lineage',
        `系统财务OP主体 ${snapshot.subject || snapshot.id} 存在字段不完整的原始行，无法导出`
      );
    }
    const currency = String(row.normalizedCurrency || '').trim();
    if (!SUPPORTED_CURRENCIES.includes(currency) || normalizedCurrencies.has(currency)) {
      throw exportError(
        'invalid-export-lineage',
        `系统财务OP主体 ${snapshot.subject || snapshot.id} 的九币种血缘不完整或重复，无法导出`
      );
    }
    normalizedCurrencies.add(currency);
    return row.displayValues.map((value) => value == null ? '' : String(value));
  });
  if (SUPPORTED_CURRENCIES.some((currency) => !normalizedCurrencies.has(currency))) {
    throw exportError(
      'invalid-export-lineage',
      `系统财务OP主体 ${snapshot.subject || snapshot.id} 的九币种血缘不完整或重复，无法导出`
    );
  }
  return rows;
}

function exportHeaders(scope) {
  if (scope.sourceType === SOURCE_TYPES.SYSTEM_OP) return [...SYSTEM_OP_HEADERS];
  if (scope.targetKind === EXPORT_KINDS.RAW) {
    return [...getSourceDefinition(scope.sourceType).headers];
  }
  const definition = CHECK_EXPORT_DEFINITIONS[scope.sourceType];
  return [...definition.sourceHeaders, ...definition.derivedHeaders];
}

function *iterateDatasetRows(db, scope) {
  if (scope.sourceType === SOURCE_TYPES.SYSTEM_OP) {
    const snapshots = db.prepare(`
      SELECT id, subject, raw_json
      FROM vcc_fin_op_system_snapshots
      WHERE target_month = ?
      ORDER BY id
    `).iterate(scope.targetMonth);
    for (const snapshot of snapshots) {
      for (const values of systemSnapshotRows(snapshot)) yield values;
    }
    return;
  }

  const rows = db.prepare(`
    SELECT id, source_type, raw_json, raw_contract_version,
           subject, stat_currency, signed_amount,
           pending_amount, flow_amount, currency_mismatch
    FROM vcc_fin_op_effective_rows
    WHERE target_month = ? AND source_type = ?
    ORDER BY id
  `).iterate(scope.targetMonth, scope.sourceType);
  for (const row of rows) {
    const rawValues = detailRawValues(row);
    yield scope.targetKind === EXPORT_KINDS.RAW
      ? rawValues
      : detailCheckValues(row, rawValues);
  }
}

function countDatasetRows(db, scope) {
  if (scope.sourceType !== SOURCE_TYPES.SYSTEM_OP) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS row_count
      FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = ?
    `).get(scope.targetMonth, scope.sourceType).row_count) || 0;
  }
  let count = 0;
  for (const snapshot of db.prepare(`
    SELECT id, subject, raw_json
    FROM vcc_fin_op_system_snapshots
    WHERE target_month = ?
    ORDER BY id
  `).iterate(scope.targetMonth)) {
    count += systemSnapshotRows(snapshot).length;
  }
  return count;
}

function inspectDatasetExport(db, targetMonth, sourceType, targetKind, { taskActive = false } = {}) {
  const scope = normalizeDatasetExportScope(targetMonth, sourceType, targetKind);
  const activeBatch = db.prepare(`
    SELECT id FROM vcc_fin_op_import_batches
    WHERE status = 'importing'
    ORDER BY started_at, id
    LIMIT 1
  `).get() || null;
  const dataCount = countDatasetRows(db, scope);
  let code = '';
  let message = '';
  if (taskActive || activeBatch) {
    code = 'active-task';
    message = '当前仍有 VCC 财务OP任务或原表导入进行中，禁止导出';
  } else if (dataCount === 0) {
    code = 'no-data';
    message = '当前选择没有可导出的有效数据';
  }
  return {
    ...scope,
    dataCount,
    exportable: !code,
    code,
    message
  };
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5EA8' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
}

function worksheetName(baseName, index) {
  const suffix = index > 1 ? `-${index}` : '';
  const safeBase = String(baseName || '导出数据').replace(/[\\/?*:[\]]/g, '_');
  return `${safeBase.slice(0, 31 - suffix.length)}${suffix}`;
}

function createWorksheet(workbook, scope, headers, index) {
  const sheet = workbook.addWorksheet(worksheetName(scope.tableName, index), {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.columns = headers.map((header) => ({
    width: Math.max(10, Math.min(30, String(header).length * 2 + 2))
  }));
  const headerRow = sheet.addRow(headers);
  styleHeader(headerRow);
  headerRow.commit();
  return sheet;
}

async function abortWorkbook(workbook) {
  if (!workbook) return;
  try {
    if (workbook.zip && typeof workbook.zip.abort === 'function') workbook.zip.abort();
  } catch (_error) { /* best effort */ }
  const stream = workbook.stream;
  if (!stream || stream.closed || typeof stream.destroy !== 'function') return;
  await new Promise((resolve) => {
    let settled = false;
    let timeout;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.off('close', done);
      stream.off('finish', done);
      stream.off('error', done);
      resolve();
    };
    stream.once('close', done);
    stream.once('finish', done);
    stream.once('error', done);
    timeout = setTimeout(done, WORKBOOK_ABORT_TIMEOUT_MS);
    stream.destroy();
    if (stream.closed) done();
  });
}

async function writeDatasetWorkbook({
  db,
  targetMonth,
  sourceType,
  targetKind,
  outputPath,
  onProgress,
  maxDataRowsPerSheet = MAX_DATA_ROWS_PER_SHEET
}) {
  const safeSheetLimit = Number(maxDataRowsPerSheet);
  if (!Number.isInteger(safeSheetLimit) || safeSheetLimit < 1 || safeSheetLimit > MAX_DATA_ROWS_PER_SHEET) {
    throw new RangeError(`单 sheet 数据行上限必须为 1-${MAX_DATA_ROWS_PER_SHEET}`);
  }

  let transactionOpen = false;
  db.exec('BEGIN');
  transactionOpen = true;
  try {
    const inspection = inspectDatasetExport(db, targetMonth, sourceType, targetKind);
    if (!inspection.exportable) throw exportError(inspection.code, inspection.message);
    const headers = exportHeaders(inspection);
    let writtenRows = 0;
    let sheetCount = 1;

    const publishedPath = await writeXlsxAtomically({
      outputPath,
      writeStaged: async (stagedPath) => {
        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: stagedPath,
          useStyles: true,
          useSharedStrings: false
        });
        try {
          let sheet = createWorksheet(workbook, inspection, headers, sheetCount);
          let rowsInSheet = 0;
          for (const values of iterateDatasetRows(db, inspection)) {
            if (rowsInSheet >= safeSheetLimit) {
              sheet.commit();
              sheetCount += 1;
              rowsInSheet = 0;
              sheet = createWorksheet(workbook, inspection, headers, sheetCount);
            }
            sheet.addRow(values).commit();
            rowsInSheet += 1;
            writtenRows += 1;
            if (writtenRows % 50000 === 0 && typeof onProgress === 'function') {
              onProgress({ processedRows: writtenRows, totalRows: inspection.dataCount });
            }
          }
          sheet.commit();
          if (writtenRows !== inspection.dataCount) {
            throw exportError('export-count-mismatch', '导出行数与有效数据不一致，未生成文件');
          }
          await workbook.commit();
        } catch (error) {
          await abortWorkbook(workbook);
          throw error;
        }
      },
      beforePublish: async () => {
        db.exec('COMMIT');
        transactionOpen = false;
      }
    });
    return {
      targetMonth: inspection.targetMonth,
      sourceType: inspection.sourceType,
      targetKind: inspection.targetKind,
      tableName: inspection.tableName,
      dataCount: writtenRows,
      sheetCount,
      filePath: path.resolve(publishedPath)
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* ignore */ }
    }
    throw error;
  }
}

module.exports = {
  MAX_DATA_ROWS_PER_SHEET,
  EXPORT_KINDS,
  CHECK_EXPORT_DEFINITIONS,
  normalizeDatasetExportScope,
  inspectDatasetExport,
  writeDatasetWorkbook
};
