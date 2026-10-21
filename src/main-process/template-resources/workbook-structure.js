'use strict';

// 设置 → 模板文件：模板的结构描述（各 Sheet 表头、数据行数、枚举取值）与运行时口径的取值解析。
//   主进程用于随包的内置模板；用户导入的文件只在受限的检查 Worker 中解析（见 inspection-runner.js）。

const XLSX = require('xlsx');
const { parseFundTypeEnumWorkbook } = require('../../constants/fund-type-enum');
const { parseGatewayReconHeadersWorkbook } = require('../../constants/gateway-recon-headers-loader');
const { ALL_CELLS, sheetCells } = require('../../constants/sheetjs-sparse-cells');

function cellText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function trimTail(values) {
  const copy = [...values];
  while (copy.length && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

// SheetJS 以 <dimension> 声明作为 !ref；部分模板的声明小于实际单元格（如 VCC 结果表），这里按全部实际单元格计算（从 A1 起）。
//   只遍历有值的单元格，不展开矩形：一个落在 XFD1048576 的零散单元格不会让主进程按整张表分配内存。
function textCells(sheet) {
  return sheetCells(sheet, ALL_CELLS)
    .map((cell) => ({ r: cell.r, c: cell.c, text: cellText(cell.value) }))
    .filter((cell) => cell.text);
}

// 某一行从 A 列起的文本（中间空列保留为空串，末尾空列去掉）。
function rowTexts(cells, rowIndex) {
  const row = [];
  for (const cell of cells) {
    if (cell.r === rowIndex) row[cell.c] = cell.text;
  }
  return trimTail(Array.from(row, (value) => value || ''));
}

// 运行时 loader 的解析函数：枚举取值与比较基准都按它们的口径（声明范围的首列 / 首行）计算，
// 声明范围不从 A1 开始时也与场景配置实际读到的取值一致。
const RUNTIME_VALUE_PARSERS = Object.freeze({
  'fund-type-enum': parseFundTypeEnumWorkbook,
  'gateway-recon': parseGatewayReconHeadersWorkbook
});

// 表头以下有内容的行数。合并单元格只在左上角保存值；其覆盖的行在 Excel 中同样显示内容，计数时一并计入。
//   按行区间求并集计数，不逐行展开（合并区域可以覆盖上百万行）。
function filledRowCount(sheet, cells, headerIndex) {
  const textAt = new Set(cells.map((cell) => `${cell.r}:${cell.c}`));
  const intervals = cells.map((cell) => [cell.r, cell.r]);
  for (const merge of sheet['!merges'] || []) {
    if (textAt.has(`${merge.s.r}:${merge.s.c}`)) intervals.push([merge.s.r, merge.e.r]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let count = 0;
  let counted = headerIndex;
  for (const [start, end] of intervals) {
    const from = Math.max(start, counted + 1);
    if (end < from) continue;
    count += end - from + 1;
    counted = end;
  }
  return count;
}

function describeWorkbook(bytes, resource) {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellText: false });
  const headerIndex = resource.headerRow - 1;
  // comparableValues：按运行时口径解析的取值快照，导入时随版本记录保存，作为下一次导入的比较基准。
  const parseValues = RUNTIME_VALUE_PARSERS[resource.id] || null;
  const comparableValues = parseValues ? parseValues(workbook) : null;
  const enumValues = resource.type === 'enum' ? comparableValues : null;
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const cells = textCells(sheet);
    return {
      name,
      headerRow: resource.headerRow,
      headers: rowTexts(cells, headerIndex),
      dataRows: filledRowCount(sheet, cells, headerIndex)
    };
  });
  return { sheets, enumValues, comparableValues };
}

// 按运行时口径解析取值（FundType 取值、网关表头字段）；没有运行时解析的模板返回 null。
function parseRuntimeValues(resourceId, bytes) {
  const parse = RUNTIME_VALUE_PARSERS[resourceId];
  return parse ? parse(XLSX.read(bytes, { type: 'buffer' })) : null;
}

module.exports = {
  RUNTIME_VALUE_PARSERS,
  describeWorkbook,
  parseRuntimeValues
};
