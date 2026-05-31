// v2.1.12 需求1 T-vcc-2 — VCC业务OP计算：流水文件读取
// 用 SheetJS (xlsx) 读第一个 sheet（不 hardcode sheet 名），表头校验流水 28 列。
// 范式蓝本：src/backend/bank-bu-recon-import/reader.js（buildFileReader 结构）
// 表头校验失败 → 抛 FileValidationError（src/backend/file-service/common.js）
//
// 输入 = 流水对账单（28 列，与第 5 模块 FLOW 相同），复用 vcc-op-calc-db/columns.js 的列定义。

const XLSX = require('xlsx');
const path = require('node:path');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');
const { FLOW_HEADERS, FLOW_DB_COLUMNS } = require('../vcc-op-calc-db/columns');
const { validateFlowHeaders } = require('./validator');

const ERROR_CODE = 'VCC_OP_CALC_FLOW_HEADER_MISMATCH';
const TEMPLATE_LABEL = '流水对账单';

// 从 worksheet 读出 2D 数组形式的所有行（含表头）
// blankrows: true 保留空行（让 i+1 严格对应 Excel 1-based 行号，与 bank-bu-recon reader 一致）
function readSheetAsRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,           // 返回数组形式
    defval: '',          // 空 cell 填 ''
    blankrows: true,     // 保留空行（让 i+1 严格对应 Excel 1-based 行号）
    raw: false           // 所有 cell 转字符串（避免 Excel serial 日期 / 数字精度问题）
  });
}

// 把一行 cells → { dbColumn: value } 对象（按 FLOW_DB_COLUMNS 顺序）
function mapRowToObject(cells) {
  const obj = {};
  for (let i = 0; i < FLOW_DB_COLUMNS.length; i++) {
    obj[FLOW_DB_COLUMNS[i]] = normalizeCell(cells[i]);
  }
  return obj;
}

// 读单个流水文件 → { rows, headerRow, sourceSheetName, totalRows, fileName, filePath }
function readFlowFile(filePath) {
  const fileName = path.basename(filePath);
  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: false });
  } catch (err) {
    throw new FileValidationError(
      ERROR_CODE,
      `${TEMPLATE_LABEL} 文件读取失败：${err.message}`,
      {
        detailLines: [`文件：${fileName}`, `路径：${filePath}`],
        context: { filePath, fileName, templateLabel: TEMPLATE_LABEL }
      }
    );
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new FileValidationError(
      ERROR_CODE,
      `${TEMPLATE_LABEL} 文件没有 sheet`,
      {
        detailLines: [`文件：${fileName}`],
        context: { filePath, fileName, templateLabel: TEMPLATE_LABEL }
      }
    );
  }

  const sourceSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sourceSheetName];
  const allRows = readSheetAsRows(worksheet);

  if (allRows.length === 0) {
    throw new FileValidationError(
      ERROR_CODE,
      `${TEMPLATE_LABEL} sheet 内容为空（无表头）`,
      {
        detailLines: [`文件：${fileName}`, `Sheet：${sourceSheetName}`],
        context: { filePath, fileName, sourceSheetName, templateLabel: TEMPLATE_LABEL }
      }
    );
  }

  const headerRow = allRows[0];
  const validation = validateFlowHeaders(headerRow);
  if (!validation.ok) {
    throw new FileValidationError(
      ERROR_CODE,
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
          templateLabel: TEMPLATE_LABEL,
          expectedColumnCount: FLOW_HEADERS.length,
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
    const obj = mapRowToObject(cells);
    obj._rowIndex = i + 1;       // Excel 1-based 行号
    rows.push(obj);
  }

  return {
    rows,
    headerRow: FLOW_HEADERS.slice(),   // 用模板表头（spec 锚定常量），不用文件实际表头
    sourceSheetName,
    totalRows: rows.length,
    fileName,
    filePath
  };
}

module.exports = {
  readFlowFile,
  ERROR_CODE,
  TEMPLATE_LABEL
};
