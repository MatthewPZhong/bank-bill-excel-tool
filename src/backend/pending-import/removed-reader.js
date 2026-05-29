// v2.1.11 T2 — 移除归档 Pending 文件读取器
// 解析 assets/移除归档Pending账单.xlsx 模板（46 列）→ 每行 { raw, order_no, recon_id, 金额, channel, merchant_id, bank_ref }
//
// 设计依据（PRD §2.2 / spec §3.2 / D-T2-3 / D-T2-4）：
//   - D-T2-4=a：取 workbook 第一个 sheet（模板 sheet 名是数字 ID 如 "1405800876820465666"，
//     超出 JS 安全整数且因模板而异，不可硬编码；取 workbook.SheetNames[0]）。
//   - D-T2-3：全 46 列原样保留进 raw（供导出展示）；同时抽 6 个索引字段供匹配/加速。
//   - 数据规模：单月移除归档 < 10w 行（财务对账规模），不需要 Pending 模块的流式 reader；
//     用 SheetJS 标准读取（与 bank-bu-recon-import/reader.js 同范式）。
//   - 缺表头 / 空文件 / 列数不符 → 抛 FileValidationError（src/backend/file-service/common.js）。
//
// ⚠️ 仅解析、不入库（入库见 pending-db/removed-repository.js）；纯函数式，可独立 unit。

const XLSX = require('xlsx');
const path = require('node:path');
const {
  FileValidationError,
  normalizeCell,
  isRowMeaningful
} = require('../file-service/common');

const ERROR_CODE = 'PENDING_REMOVED_HEADER_MISMATCH';
const TEMPLATE_LABEL = '移除归档 Pending';

// 移除归档 Pending 模板 46 列表头（与 assets/移除归档Pending账单.xlsx 第 1 行严格对齐，顺序+内容）
// 前 28 列与 pending_rows（columns.js 31 列）的前 28 列一致；后 18 列为流水扩展字段。
const REMOVED_PENDING_COLUMNS = Object.freeze([
  'pending类型',
  'pending资金类型',
  '账单类型',
  'billDate',
  'valueDate',
  '平账账期',
  '业务BU',
  '对手业务BU',
  '财务BU',
  '主体',
  '对账类型',
  'recon_id',
  '金额',
  '币种',
  'order_no',
  'acc_id',
  'finish_time',
  '穿透ID',
  'channel',
  'merchant_id',
  'bank_ref',
  '对账明细ID',
  '对账单ID',
  'PendingBizId',
  '备注',
  '计算金额',
  '计算币种',
  '是否拆分Pending',
  '流水_账单日期',
  '流水_公司主体',
  '流水_流水类型',
  '流水_业务部门',
  '流水_主对账ID',
  '流水_出入方向',
  '流水_流水单号',
  '流水_用户编号',
  '流水_账户编号',
  '流水_币种',
  '流水_对账金额',
  '流水_账户类型',
  '授信金额',
  '非授信金额',
  '维护人',
  '维护人BU',
  '客户所在地',
  '是否已流水替换'
]);

// 索引字段：与 removed_pending_rows 索引列、matchFields 公共字段对齐
// 值从 raw 提取（列名即 REMOVED_PENDING_COLUMNS 中的同名列）
const INDEX_FIELDS = Object.freeze([
  'order_no',
  'recon_id',
  '金额',
  'channel',
  'merchant_id',
  'bank_ref'
]);

// 表头校验：列数 + 逐列内容（与模板严格对齐）
function validateRemovedHeaders(headerRow) {
  if (!Array.isArray(headerRow)) {
    return { ok: false, error: '移除归档 Pending 表头不可读：不是数组' };
  }
  if (headerRow.length !== REMOVED_PENDING_COLUMNS.length) {
    return {
      ok: false,
      error: `移除归档 Pending 表头列数不匹配：模板 ${REMOVED_PENDING_COLUMNS.length} 列，文件 ${headerRow.length} 列`,
      detailLines: [`模板列数：${REMOVED_PENDING_COLUMNS.length}`, `文件列数：${headerRow.length}`]
    };
  }
  for (let i = 0; i < REMOVED_PENDING_COLUMNS.length; i++) {
    if (normalizeCell(headerRow[i]) !== REMOVED_PENDING_COLUMNS[i]) {
      return {
        ok: false,
        error: `移除归档 Pending 表头第 ${i + 1} 列不匹配：模板 "${REMOVED_PENDING_COLUMNS[i]}"，文件 "${normalizeCell(headerRow[i])}"`,
        detailLines: [
          `第 ${i + 1} 列模板："${REMOVED_PENDING_COLUMNS[i]}"`,
          `第 ${i + 1} 列文件："${normalizeCell(headerRow[i])}"`
        ]
      };
    }
  }
  return { ok: true };
}

// 从 worksheet 读出 2D 数组（含表头）
// blankrows: true 保留空行，让 array index 与 Excel 行号一一对应（i+1 = Excel 1-based 行号）
function readSheetAsRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: true,
    raw: false
  });
}

// 把一行 cells（数组）映射成 { raw: {列名:值,...}, order_no, recon_id, 金额, channel, merchant_id, bank_ref }
function mapRow(cells) {
  const raw = {};
  for (let i = 0; i < REMOVED_PENDING_COLUMNS.length; i++) {
    raw[REMOVED_PENDING_COLUMNS[i]] = normalizeCell(cells[i]);
  }
  const out = { raw };
  for (const f of INDEX_FIELDS) {
    out[f] = raw[f] === undefined ? '' : raw[f];
  }
  return out;
}

// 主入口：解析移除归档 Pending xlsx
// 返回 { rows: [{raw, order_no, recon_id, 金额, channel, merchant_id, bank_ref, _rowIndex}], headerRow, sourceSheetName, totalRows, fileName, filePath }
// 缺表头 / 空 sheet / 列数或内容不符 → 抛 FileValidationError
function readRemovedPendingFile(filePath) {
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

  // D-T2-4=a：取第一个 sheet（不硬编码数字 sheet 名）
  const sourceSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sourceSheetName];
  const allRows = readSheetAsRows(worksheet);

  if (!Array.isArray(allRows) || allRows.length === 0) {
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
  const validation = validateRemovedHeaders(headerRow);
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
          expectedColumnCount: REMOVED_PENDING_COLUMNS.length,
          actualColumnCount: Array.isArray(headerRow) ? headerRow.length : 0
        }
      }
    );
  }

  // 数据行：从第 2 行起；跳过全空行；_rowIndex 沿用 Excel 1-based 行号
  const rows = [];
  for (let i = 1; i < allRows.length; i++) {
    const cells = allRows[i];
    if (!isRowMeaningful(cells)) continue;
    const obj = mapRow(cells);
    obj._rowIndex = i + 1;
    rows.push(obj);
  }

  return {
    rows,
    headerRow: REMOVED_PENDING_COLUMNS.slice(),
    sourceSheetName,
    totalRows: rows.length,
    fileName,
    filePath
  };
}

module.exports = {
  readRemovedPendingFile,
  validateRemovedHeaders,
  REMOVED_PENDING_COLUMNS,
  INDEX_FIELDS,
  ERROR_CODE,
  // 暴露给测试
  __internal: { mapRow, readSheetAsRows }
};
