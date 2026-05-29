// v2.1.11 T3（spec §4.5 / PRD §2.3 T3.2 / 决策 D-T3-2-src=xlsx）：
//   FundType 字段值枚举 — 运行时读取 assets/FundType枚举值.xlsx 第一个 sheet 第一列（跳表头）
//   返回有序枚举数组（保持表内顺序），模块级缓存，避免每次渲染重复读盘。
//
// 设计要点：
//   - 值「严格按文件原样」（大小写/拼写不纠正）；运行时动态读取，不硬编码枚举值
//   - 模块级缓存：首次 loadFundTypeEnum 读盘后缓存结果（含降级时的空数组），后续直接返缓存
//   - 降级（D-T3-2 降级）：文件缺失 / 读取失败 / 表结构异常 → 返回空数组（不抛错）；
//     调用方（main IPC / renderer）据此回退文本输入 + 一次性提示，保证 blocker 未解时其余功能可用
//   - ⚠️ Electron sandbox 限制 preload require 自定义模块（见 bank-statement-fields.js 注释）：
//     本模块只在 **main 进程** require，经 IPC（scenarios:fund-type-enum）暴露给 renderer，不在 preload inline。
//
// 默认路径：dev 期 = <repo>/assets/FundType枚举值.xlsx；
//   打包后 main 进程通过 IPC handler 用 app.getAppPath() 拼路径后显式传入（见 src/main.js handler）。

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const FUND_TYPE_ENUM_FILE_NAME = 'FundType枚举值.xlsx';

// 默认路径（dev / 测试用）：从本文件位置回溯到 repo 根 assets/
function getDefaultFundTypeEnumPath() {
  return path.join(__dirname, '..', '..', 'assets', FUND_TYPE_ENUM_FILE_NAME);
}

// 模块级缓存：key = 解析后的绝对路径，value = 有序枚举数组（含降级空数组）
//   - 用 Map 以路径为 key：dev 默认路径与 main IPC 传入的打包路径不同，避免互相污染
//   - 缓存「成功」与「降级（空数组）」结果：降级后不反复尝试读盘（除非 reset）
const enumCacheByPath = new Map();

// 解析 xlsx 第一个 sheet 第一列（跳表头）→ 有序去空去重数组
function readEnumFromWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  // header:1 → 二维数组；defval 保证空单元格为空串而非跳过
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const values = [];
  const seen = new Set();
  // 第 0 行是表头（FundType），跳过；从第 1 行起取第一列
  for (let i = 1; i < rows.length; i += 1) {
    const cell = rows[i] && rows[i][0];
    const value = cell === undefined || cell === null ? '' : String(cell).trim();
    if (value === '') continue; // 跳空行
    if (seen.has(value)) continue; // 去重（保持首次出现顺序）
    seen.add(value);
    values.push(value);
  }
  return values;
}

// 加载 FundType 枚举（有序数组）。失败/缺失 → 返回空数组（降级，不抛错）。
//   - filePath 缺省 → getDefaultFundTypeEnumPath()
//   - 命中模块级缓存直接返回（含降级空数组）
function loadFundTypeEnum(filePath) {
  const resolvedPath = filePath ? path.resolve(filePath) : getDefaultFundTypeEnumPath();
  if (enumCacheByPath.has(resolvedPath)) {
    return enumCacheByPath.get(resolvedPath);
  }
  let result = [];
  try {
    if (fs.existsSync(resolvedPath)) {
      result = readEnumFromWorkbook(resolvedPath);
    } else {
      result = []; // 文件缺失 → 降级
    }
  } catch (error) {
    result = []; // 读取/解析失败 → 降级
  }
  enumCacheByPath.set(resolvedPath, result);
  return result;
}

// 测试 hook：清缓存（unit test 切换 fixture 文件路径 / 验证降级与重读时用）
function resetFundTypeEnumCache() {
  enumCacheByPath.clear();
}

module.exports = {
  FUND_TYPE_ENUM_FILE_NAME,
  getDefaultFundTypeEnumPath,
  loadFundTypeEnum,
  resetFundTypeEnumCache
};
