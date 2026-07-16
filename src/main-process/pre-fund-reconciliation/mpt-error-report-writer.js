'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { FileValidationError } = require('../../backend/file-service/common');
const { splitUtf16Safe } = require('./output-mapper');
const { parseMptFile } = require('./mpt-parser');
const {
  INBOUND_FIELDS,
  OUTBOUND_FIELDS,
  SOURCE_TYPE_INBOUND,
  SOURCE_TYPE_OUTBOUND
} = require('./mpt-schema');

const RAW_LINE_CHUNK_SIZE = 30000;
const EXCEL_MAX_ROWS = 1048576;
const SHEET_CONTRACTS = Object.freeze({
  [SOURCE_TYPE_INBOUND]: Object.freeze({
    name: 'INBOUND错误数据',
    fields: INBOUND_FIELDS
  }),
  [SOURCE_TYPE_OUTBOUND]: Object.freeze({
    name: 'OUTBOUND错误数据',
    fields: OUTBOUND_FIELDS
  })
});
const META_HEADERS = Object.freeze([
  '错误记录ID',
  '源文件',
  '来源类型',
  '原始行号',
  '错误代码',
  '错误原因',
  '错误字段',
  '分片序号',
  '分片总数'
]);
const RAW_LINE_HEADER = '原始行内容分片';

function reportError(code, message, details = {}) {
  const error = new FileValidationError(code, message, {
    detailLines: Array.isArray(details.detailLines) ? details.detailLines : [],
    context: details.context && typeof details.context === 'object' ? details.context : {}
  });
  Object.assign(error, details);
  return error;
}

function validateFailureRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError('导出错误数据至少需要一个有效失败令牌');
  }
  return records.map((record, index) => {
    const contract = SHEET_CONTRACTS[record && record.sourceType];
    if (!contract) throw new TypeError(`第 ${index + 1} 个错误文件来源类型非法`);
    const filePath = record && typeof record.filePath === 'string' ? path.resolve(record.filePath) : '';
    const contentHash = record && typeof record.contentHash === 'string'
      ? record.contentHash.trim().toLowerCase()
      : '';
    const rowErrorCount = Number(record && record.rowErrorCount);
    if (!filePath || !/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new TypeError(`第 ${index + 1} 个错误文件缺少可信路径或 SHA-256`);
    }
    if (!Number.isSafeInteger(rowErrorCount) || rowErrorCount < 1) {
      throw new TypeError(`第 ${index + 1} 个错误文件错误行数非法`);
    }
    return {
      failureId: record.failureId ? String(record.failureId) : `failure-${index + 1}`,
      filePath,
      fileName: path.basename(filePath),
      sourceType: record.sourceType,
      contentHash,
      rowErrorCount,
      contract
    };
  });
}

function normalizeMaxWorksheetRows(value) {
  if (value === undefined) return EXCEL_MAX_ROWS;
  if (!Number.isSafeInteger(value) || value < 2 || value > EXCEL_MAX_ROWS) {
    throw new TypeError(`错误数据 sheet 行数上限必须为 2 到 ${EXCEL_MAX_ROWS} 的安全整数`);
  }
  return value;
}

async function verifySourceRecord(record) {
  const parsed = await parseMptFile(record.filePath, { collectRowErrors: true });
  if (parsed.contentHash !== record.contentHash) {
    throw reportError(
      'MPT_REPAIR_SOURCE_CHANGED',
      `原始 MPT 文件「${record.fileName}」内容已变化，不能导出旧错误数据`,
      { context: { fileName: record.fileName, sourceType: record.sourceType } }
    );
  }
  if (parsed.sourceType !== record.sourceType || parsed.rowErrorCount !== record.rowErrorCount) {
    throw reportError(
      'MPT_REPAIR_SOURCE_CHANGED',
      `原始 MPT 文件「${record.fileName}」的错误数据已变化，不能导出旧错误数据`,
      { context: { fileName: record.fileName, sourceType: record.sourceType } }
    );
  }
}

function createSheet(workbook, contract) {
  const headers = [...META_HEADERS, ...contract.fields, RAW_LINE_HEADER];
  const worksheet = workbook.addWorksheet(contract.name, {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  worksheet.columns = headers.map((header, index) => ({
    header,
    key: `column_${index + 1}`,
    width: index === headers.length - 1 ? 60 : (index < META_HEADERS.length ? 18 : 16)
  }));
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.commit();
  worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(headers.length).letter}1` };
  return { worksheet, headers, dataRowCount: 0 };
}

function excelSafeField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= RAW_LINE_CHUNK_SIZE) return text;
  return `${text.slice(0, RAW_LINE_CHUNK_SIZE - 14)}...[字段已截断]`;
}

function issueRows(record, issue) {
  const chunks = splitUtf16Safe(issue.rawLine, RAW_LINE_CHUNK_SIZE);
  const errorId = `${record.failureId}:${issue.sourceRowNumber}`;
  const sourceFields = Array.isArray(issue.fields) ? issue.fields : [];
  const fields = record.contract.fields.map((_fieldName, index) => excelSafeField(sourceFields[index]));
  return chunks.map((chunk, chunkIndex) => [
    excelSafeField(errorId),
    excelSafeField(record.fileName),
    excelSafeField(record.sourceType),
    issue.sourceRowNumber,
    excelSafeField(issue.code),
    excelSafeField(issue.message),
    excelSafeField(issue.fieldName || ''),
    chunkIndex + 1,
    chunks.length,
    ...fields,
    chunk
  ]);
}

function publishTempFile(tempPath, outputPath) {
  const backupPath = `${outputPath}.${crypto.randomUUID()}.bak`;
  const hadExisting = fs.existsSync(outputPath);
  let published = false;
  try {
    if (hadExisting) fs.renameSync(outputPath, backupPath);
    fs.renameSync(tempPath, outputPath);
    published = true;
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_cleanupError) { /* best effort */ }
    if (!published && hadExisting && fs.existsSync(backupPath) && !fs.existsSync(outputPath)) {
      try { fs.renameSync(backupPath, outputPath); } catch (_restoreError) { /* message below retains backup */ }
    }
    throw error;
  }
  if (!hadExisting) return [];
  try {
    fs.rmSync(backupPath, { force: true });
    return [];
  } catch (error) {
    return [`错误数据已导出，但旧文件备份未能删除：${backupPath}（${error.message || error}）`];
  }
}

async function writeMptErrorReport({ failureRecords, outputPath, maxWorksheetRows }) {
  const records = validateFailureRecords(failureRecords);
  const worksheetRowLimit = normalizeMaxWorksheetRows(maxWorksheetRows);
  if (!outputPath || typeof outputPath !== 'string' || path.extname(outputPath).toLowerCase() !== '.xlsx') {
    throw new TypeError('错误数据导出路径必须是 .xlsx 文件');
  }
  for (const record of records) await verifySourceRecord(record);

  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(resolvedOutputPath),
    `.${path.basename(resolvedOutputPath)}.${crypto.randomUUID()}.tmp`
  );
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: tempPath,
    useStyles: true,
    useSharedStrings: false
  });
  const sheetMap = new Map();
  for (const sourceType of [SOURCE_TYPE_INBOUND, SOURCE_TYPE_OUTBOUND]) {
    if (records.some((record) => record.sourceType === sourceType)) {
      sheetMap.set(sourceType, createSheet(workbook, SHEET_CONTRACTS[sourceType]));
    }
  }

  let errorRowCount = 0;
  let outputRowCount = 0;
  try {
    for (const record of records) {
      const target = sheetMap.get(record.sourceType);
      const parsed = await parseMptFile(record.filePath, {
        collectRowErrors: true,
        onRowError(issue) {
          for (const values of issueRows(record, issue)) {
            if (target.dataRowCount + 2 > worksheetRowLimit) {
              throw reportError(
                'MPT_ERROR_REPORT_ROW_LIMIT',
                `错误数据 sheet「${target.worksheet.name}」超过 Excel 行数上限 ${worksheetRowLimit}，请拆分源文件后重试`,
                { context: { sheetName: target.worksheet.name, maxRows: worksheetRowLimit } }
              );
            }
            target.worksheet.addRow(values).commit();
            target.dataRowCount += 1;
            outputRowCount += 1;
          }
          errorRowCount += 1;
        }
      });
      if (
        parsed.contentHash !== record.contentHash
        || parsed.sourceType !== record.sourceType
        || parsed.rowErrorCount !== record.rowErrorCount
      ) {
        throw reportError(
          'MPT_REPAIR_SOURCE_CHANGED',
          `原始 MPT 文件「${record.fileName}」在导出期间发生变化，已取消导出`,
          { context: { fileName: record.fileName, sourceType: record.sourceType } }
        );
      }
    }
    await workbook.commit();
    const warnings = publishTempFile(tempPath, resolvedOutputPath);
    return {
      filePath: resolvedOutputPath,
      fileName: path.basename(resolvedOutputPath),
      sheetNames: [...sheetMap.values()].map((item) => item.worksheet.name),
      errorRowCount,
      outputRowCount,
      warnings
    };
  } catch (error) {
    try { await workbook.commit(); } catch (_commitError) { /* 只为释放流式写句柄 */ }
    try { fs.rmSync(tempPath, { force: true }); } catch (_cleanupError) { /* best effort */ }
    throw error;
  }
}

module.exports = {
  EXCEL_MAX_ROWS,
  META_HEADERS,
  RAW_LINE_CHUNK_SIZE,
  RAW_LINE_HEADER,
  SHEET_CONTRACTS,
  writeMptErrorReport
};
