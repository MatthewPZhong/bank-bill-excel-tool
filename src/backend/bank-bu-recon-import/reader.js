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
  validateBankHeaders,
  normalizeHeaderCell
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

// v3.0.8 迭代2-B（🔴资金对账红线）— 按列名定位取值（不再按固定列索引）：
//   原实现 obj[dbColumns[i]] = normalizeCell(cells[i]) 假定文件列顺序与模板严格一致。
//   新版 46 列银行对账单在中间插入了「合并单号」「合并状态」，会让其后所有列右移，
//   按索引取值会导致 Extra Information / Remark-BU 等后移列整体错位（资金对账错列 = 红线事故）。
//   改为：用实际表头建 normalizeHeaderCell(列名) → 文件实际列索引 的 Map，
//   按 (expectedHeaders[i] → dbColumns[i]) 配对取值，无论列是否位移、是否有多余列都按名正确取。
//   多出的列（合并单号/合并状态）不在 expectedHeaders 中 → 自然不进 obj、不落库。
//   对 Pending（20 列模板未变）此改动等价安全（按名取 == 原按索引取）。
function buildHeaderIndexMap(headerRow) {
  const map = new Map();
  if (Array.isArray(headerRow)) {
    for (let i = 0; i < headerRow.length; i++) {
      const name = normalizeHeaderCell(headerRow[i]);
      // 首次出现优先：与 validator 有序子序列校验一致，重复列名取最先出现的位置
      if (name !== '' && !map.has(name)) {
        map.set(name, i);
      }
    }
  }
  return map;
}

function buildRowMapper(expectedHeaders, dbColumns, headerIndexMap) {
  return function mapRowToObject(cells) {
    const obj = {};
    for (let i = 0; i < dbColumns.length; i++) {
      const colIndex = headerIndexMap.get(expectedHeaders[i]);
      // validateHeaders 已保证每个模板列都命中；colIndex===undefined 时 cells[undefined]→undefined→normalizeCell→''（兜底）
      obj[dbColumns[i]] = normalizeCell(colIndex === undefined ? undefined : cells[colIndex]);
    }
    return obj;
  };
}

function buildFileReader({
  templateLabel,
  expectedHeaders,
  dbColumns,
  validateHeaders,
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

    // 表头校验通过后，用文件"实际表头"建 列名→实际列索引 的 Map，按名取值（兼容列位移 / 多余列）
    const headerIndexMap = buildHeaderIndexMap(headerRow);
    const rowMapper = buildRowMapper(expectedHeaders, dbColumns, headerIndexMap);

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
  dbColumns: PENDING_GUANLI_DB_COLUMNS,
  validateHeaders: validatePendingGuanliHeaders,
  errorCode: 'BANK_BU_RECON_PENDING_HEADER_MISMATCH'
});

const readBankFile = buildFileReader({
  templateLabel: '银行对账单',
  expectedHeaders: BANK_HEADERS,
  dbColumns: BANK_DB_COLUMNS,
  validateHeaders: validateBankHeaders,
  errorCode: 'BANK_BU_RECON_BANK_HEADER_MISMATCH'
});

module.exports = {
  readPendingGuanliFile,
  readBankFile
};
