'use strict';

// SheetJS 稀疏工作表（sheet['A1'] 形式）按实际存在的单元格取值，不按范围逐格展开。
//   <dimension> 声明或一个零散单元格就能让范围覆盖整张表（如 A1:XFD1048576），
//   sheet_to_json 按矩形逐行逐列展开会在主进程耗尽内存；这里的开销只与实际单元格数有关。
//   取值口径与 sheet_to_json({ header: 1, defval: '' }) 一致：s/n/b/d 取原值，空值、错误值与占位单元格按空处理（不返回）。

const XLSX = require('xlsx');

const VALUE_TYPES = new Set(['s', 'n', 'b', 'd']);
// 不限范围：按全部实际单元格计算（用于 <dimension> 声明小于实际单元格的文件）。
const ALL_CELLS = Object.freeze({ s: Object.freeze({ r: 0, c: 0 }), e: Object.freeze({ r: Infinity, c: Infinity }) });

// 声明范围（!ref）；没有声明时返回 null。
function declaredRange(sheet) {
  return sheet && sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
}

// range 内有值的单元格 { r, c, value }，按行、列排序。
function sheetCells(sheet, range) {
  if (!sheet || !range) return [];
  const cells = [];
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const cell = sheet[key];
    if (!cell || !VALUE_TYPES.has(cell.t) || cell.v === undefined || cell.v === null) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r < range.s.r || r > range.e.r || c < range.s.c || c > range.e.c) continue;
    cells.push({ r, c, value: cell.v });
  }
  return cells.sort((a, b) => a.r - b.r || a.c - b.c);
}

module.exports = {
  ALL_CELLS,
  declaredRange,
  sheetCells
};
