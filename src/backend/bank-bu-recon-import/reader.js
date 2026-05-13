// v2.1.2 T2 — 月度银行对账单BU回填校验：模板文件读取
// 用 SheetJS (xlsx) 读取第一个 sheet（spec §3.1：不 hardcode sheet 名，按第一个 sheet 读）
// 表头校验失败 → 抛 FileValidationError（src/backend/file-service/common.js）
// 数据规模：单月 < 10w 行（财务对账规模），不需要 Pending 模块的流式 reader

const XLSX = require('xlsx');
const path = require('node:path');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');
const {
  PENDING_GUANLI_HEADERS,
  PENDING_GUANLI_DB_COLUMNS,
  BANK_HEADERS,
  BANK_DB_COLUMNS
} = require('../bank-bu-recon-db/columns');
const {
  validatePendingGuanliHeaders,
  validateBankHeaders
} = require('./validator');

// 从 worksheet 读出 2D 数组形式的所有行（含表头）
// PR #43 Codex round 3 F5 修复：blankrows: true 保留空行 — 否则 sheet_to_json 会移除中间空行，
// 导致 array index 不再对应 Excel 真实行号，N:M 异常 sheet / 错误报告里的行号会指向错误源行
function readSheetAsRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,           // 返回数组形式
    defval: '',          // 空 cell 填 ''
    blankrows: true,     // 保留空行（让 i+1 严格对应 Excel 1-based 行号）
    raw: false           // 所有 cell 转字符串（避免 Excel serial 日期 / 数字精度问题）
  });
}

function buildRowMapper(dbColumns) {
  return function mapRowToObject(cells) {
    const obj = {};
    for (let i = 0; i < dbColumns.length; i++) {
      obj[dbColumns[i]] = normalizeCell(cells[i]);
    }
    return obj;
  };
}

const pendingRowMapper = buildRowMapper(PENDING_GUANLI_DB_COLUMNS);
const bankRowMapper = buildRowMapper(BANK_DB_COLUMNS);

function buildFileReader({
  templateLabel,
  expectedHeaders,
  validateHeaders,
  rowMapper,
  errorCode
}) {
  return function readFile(filePath) {
    const fileName = path.basename(filePath);
    let workbook;
    try {
      workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: false });
    } catch (err) {
      throw new FileValidationError(
        errorCode,
        `${templateLabel} 文件读取失败：${err.message}`,
        {
          detailLines: [`文件：${fileName}`, `路径：${filePath}`],
          context: { filePath, fileName, templateLabel }
        }
      );
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new FileValidationError(
        errorCode,
        `${templateLabel} 文件没有 sheet`,
        {
          detailLines: [`文件：${fileName}`],
          context: { filePath, fileName, templateLabel }
        }
      );
    }

    const sourceSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sourceSheetName];
    const allRows = readSheetAsRows(worksheet);

    if (allRows.length === 0) {
      throw new FileValidationError(
        errorCode,
        `${templateLabel} sheet 内容为空（无表头）`,
        {
          detailLines: [`文件：${fileName}`, `Sheet：${sourceSheetName}`],
          context: { filePath, fileName, sourceSheetName, templateLabel }
        }
      );
    }

    const headerRow = allRows[0];
    const validation = validateHeaders(headerRow);
    if (!validation.ok) {
      throw new FileValidationError(
        errorCode,
        validation.error,
        {
          detailLines: [
            `文件：${fileName}`,
            `Sheet：${sourceSheetName}`,
            ...(validation.detailLines || [])
          ],
          context: {
            filePath,
            fileName,
            sourceSheetName,
            templateLabel,
            expectedColumnCount: expectedHeaders.length,
            actualColumnCount: Array.isArray(headerRow) ? headerRow.length : 0
          }
        }
      );
    }

    // 数据行：从第 2 行起；row_index 沿用 Excel 实际行号（1 起，表头=1，数据从 2 起）
    const rows = [];
    for (let i = 1; i < allRows.length; i++) {
      const cells = allRows[i];
      if (!isRowMeaningful(cells)) continue;
      const rowIndex = i + 1;       // Excel 1-based 行号
      const obj = rowMapper(cells);
      obj._rowIndex = rowIndex;
      rows.push(obj);
    }

    return {
      rows,
      headerRow: expectedHeaders.slice(),   // 用模板表头（即 spec 锚定的常量），不用文件实际表头
      sourceSheetName,
      totalRows: rows.length,
      fileName,
      filePath
    };
  };
}

const readPendingGuanliFile = buildFileReader({
  templateLabel: 'Pending 数据管理',
  expectedHeaders: PENDING_GUANLI_HEADERS,
  validateHeaders: validatePendingGuanliHeaders,
  rowMapper: pendingRowMapper,
  errorCode: 'BANK_BU_RECON_PENDING_HEADER_MISMATCH'
});

const readBankFile = buildFileReader({
  templateLabel: '银行对账单',
  expectedHeaders: BANK_HEADERS,
  validateHeaders: validateBankHeaders,
  rowMapper: bankRowMapper,
  errorCode: 'BANK_BU_RECON_BANK_HEADER_MISMATCH'
});

module.exports = {
  readPendingGuanliFile,
  readBankFile
};
