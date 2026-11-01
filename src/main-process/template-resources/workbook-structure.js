'use strict';

// 设置 → 模板文件：模板的结构描述（各 Sheet 表头、数据行数、枚举取值）与运行时口径的取值解析。
//   主进程用于随包的内置模板；用户导入的文件只在受限的检查 Worker 中解析（见 inspection-runner.js）。

const XLSX = require('xlsx');
const { parseFundTypeEnumWorkbook } = require('../../constants/fund-type-enum');
const { CUSTOM_VALUE_SENTINEL } = require('../../constants/gateway-recon-headers-loader');
const { canonicalHeaderMapping, storedHeaderNames } = require('../../backend/file-service/header-structure-diff');
const { ALL_CELLS, sheetCells } = require('../../constants/sheetjs-sparse-cells');
const { TEMPLATE_RESOURCES } = require('./catalog');
const { INPUT_STRUCTURES, isSingleSheetStructure, structureLabel } = require('./input-structures');

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

// 输入原表的导入识别结构：指定工作表（null 为第 1 个）表头行的文本（中间空列保留为空串，末尾空列去掉）。
//   与导入时读表头的口径是否一致，由模板检查用各模块的读取函数再核对一次。
function sheetHeaders(workbook, sheetName, headerRow) {
  const name = sheetName === null ? workbook.SheetNames[0] : sheetName;
  if (!name || !workbook.Sheets[name]) return [];
  return rowTexts(textCells(workbook.Sheets[name]), headerRow - 1);
}

function firstSheetHeaders(workbook, headerRow) {
  return sheetHeaders(workbook, null, headerRow);
}

// 取值快照：单表原表为表头列表；多表原表为「工作表」列名标签（用于比较基准与“取值变化”展示），
//   各表的表头另由结构描述 sheets[].headers 保存。values 为 'stored' 的表（网关对账单）取入库后实际可用的列名，
//   即场景配置下拉与场景引用保护的口径。headersBySheet 与 spec.sheets 一一对应。
function inputStructureValuesFromHeaders(spec, headersBySheet) {
  if (spec.values === 'stored') {
    const builtin = spec.sheets[0].builtinHeaders();
    const headers = headersBySheet[0] || [];
    return storedHeaderNames(builtin, canonicalHeaderMapping(builtin, headers), { keepExtra: spec.keepExtra === true })
      .filter((header) => header !== CUSTOM_VALUE_SENTINEL);
  }
  if (isSingleSheetStructure(spec)) return [...(headersBySheet[0] || [])];
  return spec.sheets.flatMap((sheet, index) => (headersBySheet[index] || []).map((header) => structureLabel(sheet.name, header)));
}

function inputStructureValues(spec, workbook, headerRow) {
  return inputStructureValuesFromHeaders(spec, spec.sheets.map((sheet) => sheetHeaders(workbook, sheet.name, headerRow)));
}

// 运行时 loader 的解析函数：FundType 枚举按其口径（声明范围的首列）计算，声明范围不从 A1 开始时也与场景配置实际读到的取值一致。
//   输入原表（含网关对账单）的取值为表头列表或入库后的列名，见 inputStructureValuesFromHeaders。
const RUNTIME_VALUE_PARSERS = Object.freeze({
  'fund-type-enum': parseFundTypeEnumWorkbook,
  ...Object.fromEntries(Object.entries(INPUT_STRUCTURES).map(([resourceId, spec]) => {
    const headerRow = TEMPLATE_RESOURCES.find((resource) => resource.id === resourceId).headerRow;
    return [resourceId, (workbook) => inputStructureValues(spec, workbook, headerRow)];
  }))
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

// 结构描述、取值快照与早期记录的重新解析共用同一组读取选项（不解析公式、HTML 与格式化文本），
//   同一份字节在各条路径上得到相同的取值。
const READ_OPTIONS = Object.freeze({ type: 'buffer', cellFormula: false, cellHTML: false, cellText: false });

function describeWorkbook(bytes, resource) {
  const workbook = XLSX.read(bytes, READ_OPTIONS);
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
  return parse ? parse(XLSX.read(bytes, READ_OPTIONS)) : null;
}

module.exports = {
  RUNTIME_VALUE_PARSERS,
  firstSheetHeaders,
  inputStructureValuesFromHeaders,
  sheetHeaders,
  describeWorkbook,
  parseRuntimeValues
};
