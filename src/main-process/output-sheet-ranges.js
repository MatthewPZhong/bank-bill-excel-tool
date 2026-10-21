'use strict';

// 输出模板的筛选与打印区域是按模板当时的行数保存的固定范围。写入本次结果后统一调整：
//   首行固定为第 1 行（表头），末行为最后一行结果（零结果时为表头行），列范围不变。
//   只调整单个区域；多个打印区域无法判断哪些该延伸（逐段延伸会造成重叠），由导入预检拒绝，这里保持原样。

const XLSX = require('xlsx');

function decodeRef(ref) {
  const range = XLSX.utils.decode_range(String(ref).replace(/^.*!/, ''));
  return [range.s.r, range.s.c, range.e.r, range.e.c].every((value) => Number.isInteger(value) && value >= 0) ? range : null;
}

function fitRefToRows(ref, lastRow) {
  const range = decodeRef(ref);
  if (!range) return String(ref);
  range.s.r = 0;
  range.e.r = Math.max(0, lastRow - 1);
  return `${XLSX.utils.encode_cell(range.s)}:${XLSX.utils.encode_cell(range.e)}`;
}

// ExcelJS 的 autoFilter 可以是 'A1:C3'，也可以是 { from, to }（地址字符串或 { row, column }）。
function autoFilterRef(autoFilter) {
  if (typeof autoFilter === 'string') return autoFilter;
  if (!autoFilter || !autoFilter.from || !autoFilter.to) return '';
  const cell = (value) => (typeof value === 'string'
    ? value
    : XLSX.utils.encode_cell({ r: Number(value.row) - 1, c: Number(value.column) - 1 }));
  return `${cell(autoFilter.from)}:${cell(autoFilter.to)}`;
}

// worksheet 可以是 ExcelJS 的普通工作表或流式工作表（须在 commit 之前调用）；lastRow 为最后一行的行号。
function fitOutputRangesToRows(worksheet, lastRow) {
  const filterRef = worksheet.autoFilter ? autoFilterRef(worksheet.autoFilter) : '';
  if (filterRef) worksheet.autoFilter = fitRefToRows(filterRef, lastRow);
  const printArea = worksheet.pageSetup && worksheet.pageSetup.printArea;
  if (printArea && !String(printArea).includes('&&')) worksheet.pageSetup.printArea = fitRefToRows(printArea, lastRow);
}

module.exports = {
  decodeRef,
  fitOutputRangesToRows
};
