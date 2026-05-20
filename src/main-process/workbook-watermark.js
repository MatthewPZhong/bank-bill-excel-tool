// v2.1.6 Module A T2：跨库 Excel workbook 元数据 watermark helper
// 用途：在所有 xlsx 导出前注入 lastModifiedBy = 'pzhong'
//
// 覆盖两种 workbook 类型：
//   1) ExcelJS workbook（实例对象，有 lastModifiedBy 属性 + _worksheets 内部 map）
//   2) SheetJS workbook（纯对象，有 SheetNames / Sheets，元数据走 Props.LastAuthor）
//
// 调用约定：在所有 `*.writeFile(...)` 之前 `applyWatermark(wb)` 一次
// 仅设置 lastModifiedBy / LastAuthor，不动 creator / Author（保持自然，不像水印）

const WATERMARK_AUTHOR = 'pzhong';

function applyWatermark(workbook) {
  if (!workbook) return workbook;

  // ExcelJS：实例上有可枚举 lastModifiedBy 或内部 _worksheets map
  if (typeof workbook.lastModifiedBy !== 'undefined' || workbook._worksheets) {
    workbook.lastModifiedBy = WATERMARK_AUTHOR;
    return workbook;
  }

  // SheetJS：纯对象，有 SheetNames 或 Sheets
  if (workbook.SheetNames || workbook.Sheets) {
    workbook.Props = workbook.Props || {};
    workbook.Props.LastAuthor = WATERMARK_AUTHOR;
    return workbook;
  }

  return workbook;
}

module.exports = { applyWatermark, WATERMARK_AUTHOR };
