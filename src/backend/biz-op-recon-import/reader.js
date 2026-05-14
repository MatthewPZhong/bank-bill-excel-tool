// v2.1.3 T2 — 业务OP数据核对：模板文件读取
// 用 SheetJS (xlsx) 读取第一个 sheet（spec §3.1：不 hardcode sheet 名，按第一个 sheet 读）
// 表头校验失败 → 抛 FileValidationError（src/backend/file-service/common.js）
// 数据规模：单日业务OP 约几百到几千行；单日流水 < 10w 行
// 复用 v2.1.2 PR #43 F5 fix 经验：blankrows: true 保留行号一致性

const XLSX = require('xlsx');
const path = require('node:path');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');
const {
  BIZ_OP_HEADERS,
  BIZ_OP_DB_COLUMNS,
  FLOW_HEADERS,
  FLOW_DB_COLUMNS
} = require('../biz-op-recon-db/columns');
const {
  validateBizOpHeaders,
  validateFlowHeaders
} = require('./validator');

// 从 worksheet 读出 2D 数组形式的所有行（含表头）
// blankrows: true 保留空行 → i+1 严格对应 Excel 1-based 行号
function readSheetAsRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: true,
    raw: false
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

const bizOpRowMapper = buildRowMapper(BIZ_OP_DB_COLUMNS);
const flowRowMapper = buildRowMapper(FLOW_DB_COLUMNS);

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
      const rowIndex = i + 1;
      const obj = rowMapper(cells);
      obj._rowIndex = rowIndex;
      rows.push(obj);
    }

    return {
      rows,
      headerRow: expectedHeaders.slice(),
      sourceSheetName,
      totalRows: rows.length,
      fileName,
      filePath
    };
  };
}

const readBizOpFile = buildFileReader({
  templateLabel: '业务OP账单',
  expectedHeaders: BIZ_OP_HEADERS,
  validateHeaders: validateBizOpHeaders,
  rowMapper: bizOpRowMapper,
  errorCode: 'BIZ_OP_RECON_BIZ_OP_HEADER_MISMATCH'
});

const readFlowFile = buildFileReader({
  templateLabel: '流水对账单',
  expectedHeaders: FLOW_HEADERS,
  validateHeaders: validateFlowHeaders,
  rowMapper: flowRowMapper,
  errorCode: 'BIZ_OP_RECON_FLOW_HEADER_MISMATCH'
});

module.exports = {
  readBizOpFile,
  readFlowFile
};
