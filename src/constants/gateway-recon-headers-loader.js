// v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废、存量不迁移）：
//   C3 场景（gateway-recon-join）「网关账单字段」下拉枚举 —— 运行时读取
//   assets/网关对账单.xlsx 第一个 sheet（sheet 名 1409155847565936642）的「表头行」作为字段枚举。
//
// 设计要点（照搬 C2 fund-type-enum.js 已上线模式）：
//   - 取「第一个 sheet 的第 0 行（表头）」，逐列 trim + 去空列 + 去重（保持表内列顺序）。
//     注意与 fund-type-enum.js 的差异：那个取「第一列、跳表头」；本模块取「表头行整行」。
//   - 模块级缓存（按解析后的绝对路径为 key）：dev 默认路径与 main IPC 传入的打包路径不同，
//     用 Map 以路径为 key 避免互相污染；缓存「成功」与「降级（fallback）」结果，reset 后才重读。
//   - ⚠️ Electron sandbox 限制 preload require 自定义模块（见 gateway-recon-fields.js 注释）：
//     本模块只在 **main 进程** require，经 IPC（scenarios:gateway-recon-headers）暴露给 renderer，不在 preload inline。
//   - 降级（文件缺失 / 读取失败 / 表头为空）→ **fallback 到旧硬编码 GATEWAY_RECON_FIELDS**（防崩，不抛错）。
//     与 fund-type-enum.js「降级返空数组」不同：本模块降级仍给一份可用枚举，保证 C3 弹窗下拉不空白。
//   - 🔴 资金红线防御：读到的表头若包含 sentinel `__CUSTOM__` 必须剔除（见 gateway-recon-fields.js:9-13）。
//     `__CUSTOM__` 是 C3「自取值」选项保留 value，表头冲突会让 C3 引擎把真实字段值当「使用自取值」→ mode 误判。
//
// 默认路径：dev 期 = <repo>/assets/网关对账单.xlsx；
//   打包后 main 进程通过 IPC handler 用 app.getAppPath() 拼路径后显式传入（见 src/main.js handler）。

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { GATEWAY_RECON_FIELDS } = require('./gateway-recon-fields');

const GATEWAY_RECON_HEADERS_FILE_NAME = '网关对账单.xlsx';

// 🔴 C3「自取值」选项保留 value sentinel（与 renderer-dialogs.js / c3-gateway-recon-join.js 一致）。
//   表头若误含此值必须剔除，否则资金红线 mode 误判。
const CUSTOM_VALUE_SENTINEL = '__CUSTOM__';

// 默认路径（dev / 测试用）：从本文件位置回溯到 repo 根 assets/
function getDefaultGatewayReconHeadersPath() {
  return path.join(__dirname, '..', '..', 'assets', GATEWAY_RECON_HEADERS_FILE_NAME);
}

// 模块级缓存：key = 解析后的绝对路径，value = 有序表头数组（含降级 fallback 结果）
const headersCacheByPath = new Map();

// 解析 xlsx 第一个 sheet 的表头行（第 0 行）→ 有序去空去重数组，并剔除 __CUSTOM__ sentinel。
//   返回空数组表示「表头不可用」（空表 / 全空列），由调用方决定是否 fallback。
function readHeadersFromWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) return [];
  // header:1 → 二维数组；defval 保证空单元格为空串而非跳过（列对齐）
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const values = [];
  const seen = new Set();
  for (let i = 0; i < headerRow.length; i += 1) {
    const cell = headerRow[i];
    const value = cell === undefined || cell === null ? '' : String(cell).trim();
    if (value === '') continue; // 去空列
    // 🔴 资金红线：剔除 __CUSTOM__ sentinel（表头冲突会导致 C3 自取值 mode 误判）
    if (value === CUSTOM_VALUE_SENTINEL) continue;
    if (seen.has(value)) continue; // 去重（保持首次出现顺序）
    seen.add(value);
    values.push(value);
  }
  return values;
}

// 加载网关账单表头枚举（有序数组）。
//   - filePath 缺省 → getDefaultGatewayReconHeadersPath()
//   - 命中模块级缓存直接返回（含降级 fallback 结果）
//   - 文件缺失 / 读取失败 / 表头为空 → 降级 fallback 到旧硬编码 GATEWAY_RECON_FIELDS（防崩，不抛错）
function loadGatewayReconHeaders(filePath) {
  const resolvedPath = filePath ? path.resolve(filePath) : getDefaultGatewayReconHeadersPath();
  if (headersCacheByPath.has(resolvedPath)) {
    return headersCacheByPath.get(resolvedPath);
  }
  let result;
  try {
    if (fs.existsSync(resolvedPath)) {
      const headers = readHeadersFromWorkbook(resolvedPath);
      // 表头读出为空（空表 / 全空列 / 仅含被剔除的 sentinel）→ fallback 兜底
      result = headers.length > 0 ? headers : [...GATEWAY_RECON_FIELDS];
    } else {
      result = [...GATEWAY_RECON_FIELDS]; // 文件缺失 → fallback
    }
  } catch (error) {
    result = [...GATEWAY_RECON_FIELDS]; // 读取/解析失败 → fallback
  }
  headersCacheByPath.set(resolvedPath, result);
  return result;
}

// 测试 hook：清缓存（unit test 切换 fixture 路径 / 验证降级与重读时用）
function resetGatewayReconHeadersCache() {
  headersCacheByPath.clear();
}

module.exports = {
  GATEWAY_RECON_HEADERS_FILE_NAME,
  CUSTOM_VALUE_SENTINEL,
  getDefaultGatewayReconHeadersPath,
  loadGatewayReconHeaders,
  resetGatewayReconHeadersCache
};
