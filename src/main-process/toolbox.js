// v3.0.8 需求1：工具箱🧰（合表 / 拆表）核心纯逻辑
//
// 背景：脱离主对账流程的轻量 Excel 行级搬运小工具。两条链路——
//   合表：多选 ≥2 个表头完全一致的 Excel/CSV → 首文件表头 + 各文件数据行 → 合并为一张另存为。
//   拆表：单选 1 个文件 → 读表头 + 各字段去重值 → 用户选字段/若干值 → 过滤出命中行另存为子集。
//
// 设计：本模块只放「纯数据变换」，不碰 Electron dialog / 文件 IO。
//   IPC handler（src/main.js toolbox:merge / toolbox:split:read / toolbox:split:export）
//   负责 showOpenDialog / showSaveDialog / extractHeaders / readRows / writeWorkbookRows / copyFileSync，
//   把读到的 aoa（二维数组，第 0 行 = 表头）交给本模块做合并 / 去重 / 过滤，再写回。
//   这样跨接缝（renderer↔preload↔main↔file-service）的核心变换可被 integration 端到端覆盖，无需起 Electron。
//
// 关键口径（与 TECHDOC v3.0.8 §3.4 接缝契约一致）：
//   - readRows 返回 aoa（不是对象数组）→ 合并 / 过滤一律按「列索引」操作，不假设对象键。
//   - extractHeaders 已 normalizeCell（trim）→ 表头比对天然 trim；本模块比对用 JSON.stringify 全等（列名 + 列序，大小写敏感）。
//   - 去重值用 normalizeCell 归一后去重 + 保留首现序。
//   - 时间戳 YYYYMMDDHHmm（12 位，24 小时制）。

const { normalizeCell } = require('../backend/file-service/common');

// 合表表头不一致专用错误——handler 据 name 判定后回 {status:'failed'}（前端 alert detailLines 停止，不产文件）。
class ToolboxHeaderMismatchError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxHeaderMismatchError';
    this.detailLines = detailLines;
  }
}

// 12 位时间戳 YYYYMMDDHHmm（年年月月日日时时分分，24 小时制）。三 handler（合表/拆表）共用。
function pad2(value) {
  return String(value).padStart(2, '0');
}
function formatTimestamp12(date = new Date()) {
  return (
    String(date.getFullYear()) +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    pad2(date.getHours()) +
    pad2(date.getMinutes())
  );
}

// 校验一批文件的表头是否全部完全相同（列名 + 列序，大小写敏感）。
//   不同 → 抛 ToolboxHeaderMismatchError，detailLines 含「不一致文件名 + 其表头」供前端 alert。
//   口径：以首文件表头为基准，逐个 JSON.stringify 全等比对（headers 已是 extractHeaders 的 trim 数组）。
//
// 入参：
//   headersList  string[][]  各文件 extractHeaders 的结果（与 fileNames 一一对应）
//   fileNames    string[]     各文件名（仅用于报错文案，与 headersList 同序）
// 返回：基准表头（headersList[0] 的副本）
function assertHeadersIdentical(headersList, fileNames = []) {
  if (!Array.isArray(headersList) || headersList.length === 0) {
    throw new ToolboxHeaderMismatchError('未选择任何文件，无法合并');
  }
  const baseHeaders = Array.isArray(headersList[0]) ? headersList[0] : [];
  const baseKey = JSON.stringify(baseHeaders);
  const baseName = fileNames[0] || '文件1';

  for (let i = 1; i < headersList.length; i += 1) {
    const current = Array.isArray(headersList[i]) ? headersList[i] : [];
    if (JSON.stringify(current) !== baseKey) {
      const curName = fileNames[i] || `文件${i + 1}`;
      const detailLines = [
        `基准文件「${baseName}」表头：${baseHeaders.join(' | ') || '（空）'}`,
        `不一致文件「${curName}」表头：${current.join(' | ') || '（空）'}`,
        '合并要求所有文件表头完全一致（列名 + 列序），请确认后重新选择。'
      ];
      throw new ToolboxHeaderMismatchError(
        `文件「${curName}」表头与「${baseName}」不一致，无法合并`,
        detailLines
      );
    }
  }
  return baseHeaders.slice();
}

// 合并多文件 aoa = [首文件表头行, ...各文件数据行（切掉各自首行表头）]。
//   前置：调用方已用 assertHeadersIdentical 校验表头一致；本函数只做行拼接。
//
// 入参：aoaList  各文件 readRows 的结果（每个是二维数组，第 0 行 = 表头）
// 返回：合并后的 aoa（第 0 行 = 首文件表头，其后为各文件数据行）
function mergeAoaRows(aoaList) {
  if (!Array.isArray(aoaList) || aoaList.length === 0) {
    return [];
  }
  const firstAoa = Array.isArray(aoaList[0]) ? aoaList[0] : [];
  const headerRow = Array.isArray(firstAoa[0]) ? firstAoa[0].slice() : [];
  const merged = [headerRow];

  for (const aoa of aoaList) {
    if (!Array.isArray(aoa)) continue;
    // 切掉每个文件的首行（表头），其余为数据行
    for (let r = 1; r < aoa.length; r += 1) {
      const row = aoa[r];
      merged.push(Array.isArray(row) ? row.slice() : row);
    }
  }
  return merged;
}

// 按列计算每个字段（表头）的去重值：normalizeCell 归一 → 去重 → 保留首现序，空串不计。
//
// 入参：
//   headers  string[]    表头数组（extractHeaders 结果，已 trim）
//   aoa      any[][]      readRows 结果（第 0 行 = 表头，1..N 为数据行）
// 返回：{ [header]: string[] }  每个表头对应其列的去重值数组（首现序）
//   注：若同名表头重复，后者覆盖前者的列索引（与「按列名取值」语义一致，单字段筛选场景表头一般唯一）。
function computeValuesByField(headers, aoa) {
  const safeHeaders = Array.isArray(headers) ? headers : [];
  const dataRows = Array.isArray(aoa) ? aoa.slice(1) : [];
  const valuesByField = {};
  const seenByField = {};

  safeHeaders.forEach((header) => {
    valuesByField[header] = [];
    seenByField[header] = new Set();
  });

  safeHeaders.forEach((header, colIdx) => {
    const seen = seenByField[header];
    const bucket = valuesByField[header];
    for (const row of dataRows) {
      if (!Array.isArray(row)) continue;
      const value = normalizeCell(row[colIdx]);
      if (value === '' || seen.has(value)) continue;
      seen.add(value);
      bucket.push(value);
    }
  });

  return valuesByField;
}

// 按字段 + 多个值过滤数据行（多选值 → 单结果，含所有命中任一选中值的行）。
//   命中口径：normalizeCell(row[字段列索引]) ∈ values（values 也按 normalize 比对）。
//
// 入参：
//   aoa     any[][]    readRows 结果（第 0 行 = 表头）
//   field   string     单选字段（= 某个表头列名）
//   values  string[]   该字段被选中的若干值
// 返回：{ rows, headerRow, matchedCount, fieldFound }
//   rows         [表头行, ...命中行]（直接可交 writeWorkbookRows）
//   headerRow    表头行副本
//   matchedCount 命中数据行数
//   fieldFound   field 是否在表头中找到（false → 调用方应回 failed，不产文件）
function filterRowsByFieldValues(aoa, field, values) {
  const fullAoa = Array.isArray(aoa) ? aoa : [];
  const headerRow = Array.isArray(fullAoa[0]) ? fullAoa[0].slice() : [];
  const normalizedHeader = headerRow.map((cell) => normalizeCell(cell));
  const colIdx = normalizedHeader.indexOf(normalizeCell(field));

  if (colIdx < 0) {
    return { rows: [headerRow], headerRow, matchedCount: 0, fieldFound: false };
  }

  const valueSet = new Set((Array.isArray(values) ? values : []).map((v) => normalizeCell(v)));
  const rows = [headerRow];
  let matchedCount = 0;

  for (let r = 1; r < fullAoa.length; r += 1) {
    const row = fullAoa[r];
    if (!Array.isArray(row)) continue;
    if (valueSet.has(normalizeCell(row[colIdx]))) {
      rows.push(row.slice());
      matchedCount += 1;
    }
  }

  return { rows, headerRow, matchedCount, fieldFound: true };
}

// ============================================================
// v3.0.8 BUG3：流式增量版（修大文件 OOM）——逐行喂，绝不全量物化行。
//   口径与上面全量版（computeValuesByField / filterRowsByFieldValues）完全一致，仅改成「逐行 feed」接口，
//   供 src/main.js 工具箱 handler 配合 toolbox-stream-io.streamDataRows 流式消费。
// ============================================================

// 流式去重值累加器：按列名增量收集去重值（normalizeCell 归一 + 去重 + 保留首现序，空串不计）。
//   用法：
//     const acc = createValuesByFieldAccumulator(headers);
//     for (每个数据行 cells) acc.addRow(cells);
//     const valuesByField = acc.result();   // { [header]: string[] }（与全量 computeValuesByField 同构）
//   注：headers 为 normalize 后的表头数组（extractHeaders / readHeaderRowStreamed 结果）。
//       同名表头重复时，后者覆盖前者的列索引（与全量版「按列名取值」语义一致）。
function createValuesByFieldAccumulator(headers) {
  const safeHeaders = Array.isArray(headers) ? headers : [];
  const valuesByField = {};
  const seenByField = {};
  // header -> 列索引（同名后者覆盖前者，对齐全量 computeValuesByField 的对象键覆盖语义）
  const colIdxByField = new Map();

  safeHeaders.forEach((header, colIdx) => {
    valuesByField[header] = [];
    seenByField[header] = new Set();
    colIdxByField.set(header, colIdx);
  });

  return {
    addRow(cells) {
      if (!Array.isArray(cells)) return;
      for (const [header, colIdx] of colIdxByField.entries()) {
        const value = normalizeCell(cells[colIdx]);
        if (value === '') continue;
        const seen = seenByField[header];
        if (seen.has(value)) continue;
        seen.add(value);
        valuesByField[header].push(value);
      }
    },
    result() {
      return valuesByField;
    }
  };
}

// 流式行过滤器：定位字段列 + 预编译选中值集合，逐行判定是否命中（口径与全量 filterRowsByFieldValues 一致）。
//   用法：
//     const f = createRowFilter(normalizedHeaders, field, values);
//     if (!f.fieldFound) { ...handler 回 failed... }
//     for (每个数据行 cells) if (f.matches(cells)) emit(cells);
//   命中口径：normalizeCell(cells[字段列索引]) ∈ normalize(values)。
//   入参：
//     normalizedHeaders  normalize 后的表头数组（与全量版「headerRow.map(normalizeCell)」一致）
//     field              单选字段（= 某个表头列名）
//     values             该字段被选中的若干值
//   返回：{ fieldFound, colIdx, matches(cells)->boolean }
function createRowFilter(normalizedHeaders, field, values) {
  const headers = Array.isArray(normalizedHeaders) ? normalizedHeaders : [];
  const colIdx = headers.indexOf(normalizeCell(field));
  if (colIdx < 0) {
    return { fieldFound: false, colIdx: -1, matches: () => false };
  }
  const valueSet = new Set((Array.isArray(values) ? values : []).map((v) => normalizeCell(v)));
  return {
    fieldFound: true,
    colIdx,
    matches(cells) {
      if (!Array.isArray(cells)) return false;
      return valueSet.has(normalizeCell(cells[colIdx]));
    }
  };
}

// 合表默认文件名：合并-YYYYMMDDHHmm.xlsx
function buildMergeFileName(date = new Date()) {
  return `合并-${formatTimestamp12(date)}.xlsx`;
}

// 拆表默认文件名：拆分-{选中值拼接 sanitize}-YYYYMMDDHHmm.xlsx
//   - 多选值用 '_' 拼接后整体过 sanitizeFileName（去非法字符）。
//   - sanitize 由调用方注入（main.js 复用其 sanitizeFileName 单一真理来源；测试传等价实现）。
//   - 拼接结果超长时截断（防文件名过长，保留前 80 字符），空则兜底 '子集'。
const SPLIT_VALUE_SEPARATOR = '_';
const SPLIT_VALUE_MAX_LEN = 80;
function buildSplitFileName(values, sanitizeFileName, date = new Date()) {
  const safeSanitize = typeof sanitizeFileName === 'function' ? sanitizeFileName : (v) => String(v || '');
  const joined = (Array.isArray(values) ? values : [])
    .map((v) => normalizeCell(v))
    .filter((v) => v !== '')
    .join(SPLIT_VALUE_SEPARATOR);
  let safeValuePart = safeSanitize(joined);
  if (safeValuePart.length > SPLIT_VALUE_MAX_LEN) {
    safeValuePart = safeValuePart.slice(0, SPLIT_VALUE_MAX_LEN);
  }
  if (!safeValuePart) {
    safeValuePart = '子集';
  }
  return `拆分-${safeValuePart}-${formatTimestamp12(date)}.xlsx`;
}

module.exports = {
  ToolboxHeaderMismatchError,
  formatTimestamp12,
  assertHeadersIdentical,
  mergeAoaRows,
  computeValuesByField,
  filterRowsByFieldValues,
  // v3.0.8 BUG3 流式增量版（修大文件 OOM）
  createValuesByFieldAccumulator,
  createRowFilter,
  buildMergeFileName,
  buildSplitFileName,
  SPLIT_VALUE_SEPARATOR,
  SPLIT_VALUE_MAX_LEN
};
