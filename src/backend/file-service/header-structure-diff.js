'use strict';

// 导入文件表头与期望结构不一致时的差异明细：在全部候选结构中找出与文件最接近的一个，
// 逐列列出差异、缺少与多出的列，作为各模块结构错误的 detailLines。只生成文案，不改变识别结果。

const MAX_DETAIL_LINES = 100;
const MAX_POSITION_LINES = 20;
const MAX_LISTED_COLUMNS = 20;
const TEMPLATE_STRUCTURE_HINT = '如系统导出结构已变更，请在「设置 → 模板文件」导入新版本';

function cellText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeHeaders(values) {
  const headers = Array.isArray(values) ? values.map(cellText) : [];
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  return headers;
}

function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function listText(values) {
  const shown = values.slice(0, MAX_LISTED_COLUMNS).join('、');
  return values.length > MAX_LISTED_COLUMNS ? `${shown} 等 ${values.length} 个` : shown;
}

// 同名列重合度：重合列数 / 两者中较长的列数，两边列名完全一致时为 1。
function similarity(actual, expected) {
  if (!actual.length || !expected.length) return 0;
  const present = new Set(actual);
  const shared = expected.filter((header) => present.has(header)).length;
  return shared / Math.max(actual.length, expected.length);
}

function closestPair(sheets, candidates) {
  let best = null;
  for (const sheet of sheets) {
    for (const candidate of candidates) {
      const score = similarity(sheet.headers, candidate.headers);
      if (!best || score > best.score) best = { sheet, candidate, score };
    }
  }
  return best;
}

// sheets：[{ name, headers, rowLabel? }]，文件中各工作表的表头行；candidates：[{ name, headers, versionLabel }]。
//   rowLabel：调用方给出的行描述（如“第 2 个非空行”，表头行不确定时按候选行比较），给出时代替“工作表「name」”前缀。
// 返回 detailLines；hint 为 null 时不附加模板文件提示（结构不可替换的表）。
function describeHeaderMismatch({ sheets, candidates, hint = TEMPLATE_STRUCTURE_HINT } = {}) {
  const actualSheets = (Array.isArray(sheets) ? sheets : [])
    .map((sheet) => ({
      name: cellText(sheet && sheet.name),
      rowLabel: sheet && typeof sheet.rowLabel === 'string' ? cellText(sheet.rowLabel) : null,
      headers: normalizeHeaders(sheet && sheet.headers)
    }));
  const expected = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      name: cellText(candidate && candidate.name),
      versionLabel: cellText(candidate && candidate.versionLabel),
      headers: normalizeHeaders(candidate && candidate.headers)
    }))
    .filter((candidate) => candidate.headers.length > 0);
  const lines = [];
  const best = closestPair(actualSheets, expected);
  const sheetPrefix = (sheet) => {
    if (sheet.rowLabel !== null) return sheet.rowLabel;
    return actualSheets.length > 1 && sheet.name ? `工作表「${sheet.name}」` : '';
  };

  if (!best || best.score === 0) {
    lines.push('文件表头与所有已知结构都没有相同的列名');
    for (const sheet of actualSheets.slice(0, 5)) {
      const label = sheet.rowLabel !== null ? (sheet.rowLabel || '第 1 个非空行') : `${sheetPrefix(sheet) || '文件'}第 1 行`;
      lines.push(sheet.headers.length
        ? `${label}（${sheet.headers.length} 列）：${listText(sheet.headers)}`
        : `${label}为空`);
    }
  } else {
    const { sheet, candidate } = best;
    const version = candidate.versionLabel ? `当前版本 ${candidate.versionLabel}，` : '';
    lines.push(`${sheetPrefix(sheet)}最接近：${candidate.name}（${version}${candidate.headers.length} 列；文件 ${sheet.headers.length} 列）`);
    const positions = [];
    const width = Math.max(candidate.headers.length, sheet.headers.length);
    for (let index = 0; index < width; index += 1) {
      const want = candidate.headers[index] || '';
      const got = sheet.headers[index] || '';
      if (want !== got) positions.push({ index, want, got });
    }
    for (const { index, want, got } of positions.slice(0, MAX_POSITION_LINES)) {
      const column = `第 ${index + 1} 列（${columnLetter(index)}）`;
      if (!want) lines.push(`${column}：多出「${got}」`);
      else if (!got) lines.push(`${column}：应为「${want}」，实际为空`);
      else lines.push(`${column}：应为「${want}」，实际为「${got}」`);
    }
    if (positions.length > MAX_POSITION_LINES) {
      lines.push(`另有 ${positions.length - MAX_POSITION_LINES} 列位置不一致`);
    }
    const actualSet = new Set(sheet.headers);
    const expectedSet = new Set(candidate.headers);
    const missing = candidate.headers.filter((header) => !actualSet.has(header));
    const extra = sheet.headers.filter((header) => header && !expectedSet.has(header));
    if (missing.length) lines.push(`缺少列：${listText(missing)}`);
    if (extra.length) lines.push(`多出列：${listText(extra)}`);
    if (!missing.length && !extra.length && positions.length) lines.push('列名一致，但顺序不同');
  }
  if (hint) lines.push(hint);
  return lines.slice(0, MAX_DETAIL_LINES);
}

// 按内置列存储的模块（存量数据、导出与下游按内置列名读取）：把当前版本的表头对应回内置列。
//   先按列名对应；内置列在当前版本中找不到同名列、且同一位置上的列也不是任何内置列名时，视为该列改名（按位置对应）；
//   仍对应不上的内置列导入后为空；当前版本多出的列不导入。必用列须同名存在，由模板预检保证，不走按位置改名。
//   内置结构中的空列（如外汇交割表第 10 列）按物理位置保留，不参与对应，也不计为置空。
//   返回 sourceIndex[i] = 内置第 i 列取文件第几列（-1 为空），以及改名、置空、不导入三类说明。
function canonicalHeaderMapping(canonicalHeaders, versionHeaders) {
  const canonical = normalizeHeaders(canonicalHeaders);
  const version = normalizeHeaders(versionHeaders);
  const canonicalSet = new Set(canonical);
  const byName = new Map();
  version.forEach((header, index) => {
    if (header && !byName.has(header)) byName.set(header, index);
  });
  const used = new Set();
  const sourceIndex = canonical.map((header) => {
    const index = header && byName.has(header) ? byName.get(header) : -1;
    if (index >= 0) used.add(index);
    return index;
  });
  const renamed = [];
  canonical.forEach((header, index) => {
    if (!header || sourceIndex[index] !== -1 || index >= version.length || used.has(index)) return;
    const candidate = version[index];
    if (!candidate || canonicalSet.has(candidate)) return;
    sourceIndex[index] = index;
    used.add(index);
    renamed.push({ column: index + 1, from: header, to: candidate });
  });
  return {
    sourceIndex,
    renamed,
    emptied: canonical.filter((header, index) => header && sourceIndex[index] === -1),
    dropped: version.filter((header, index) => header && !used.has(index))
  };
}

// 按列名取键的行对象（键为当前版本表头）转换为按内置列名取键：内置列取对应列的值（对应不上为空串），
//   内置结构中的空列跳过；keepExtra 时当前版本多出的列按原列名保留（网关对账单的新增列入库）。
function projectObjectToCanonical(row, canonicalHeaders, versionHeaders, mapping, { keepExtra = false } = {}) {
  const canonical = normalizeHeaders(canonicalHeaders);
  const version = normalizeHeaders(versionHeaders);
  const out = {};
  canonical.forEach((header, index) => {
    if (!header) return;
    const source = mapping.sourceIndex[index];
    out[header] = source >= 0 && row && Object.hasOwn(row, version[source]) ? row[version[source]] : '';
  });
  if (keepExtra) {
    for (const header of mapping.dropped) {
      if (row && Object.hasOwn(row, header) && !Object.hasOwn(out, header)) out[header] = row[header];
    }
  }
  return out;
}

// 入库后实际可用的列名：内置列中未被置空的，加上（keepExtra 时）当前版本多出的列。
function storedHeaderNames(canonicalHeaders, mapping, { keepExtra = false } = {}) {
  const canonical = normalizeHeaders(canonicalHeaders);
  const kept = canonical.filter((header, index) => header && mapping.sourceIndex[index] >= 0);
  return keepExtra ? [...kept, ...mapping.dropped.filter((header) => !kept.includes(header))] : kept;
}

// 把一行按当前版本列序读出的取值转换为按内置列序的取值。
function projectRowToCanonical(values, sourceIndex) {
  return sourceIndex.map((index) => (index >= 0 ? values[index] : undefined));
}

// 模板预检展示：当前版本相对内置列的对应关系（改名、导入后为空、不导入）。
function describeCanonicalMapping(mapping) {
  const lines = [];
  if (mapping.renamed.length) {
    lines.push(`按位置视为改名：${mapping.renamed.slice(0, MAX_LISTED_COLUMNS).map((item) => `第 ${item.column} 列「${item.to}」→「${item.from}」`).join('、')}${mapping.renamed.length > MAX_LISTED_COLUMNS ? ` 等 ${mapping.renamed.length} 列` : ''}`);
  }
  if (mapping.emptied.length) lines.push(`导入后为空：${listText(mapping.emptied)}`);
  if (mapping.dropped.length) lines.push(`不导入：${listText(mapping.dropped)}`);
  return lines;
}

module.exports = {
  TEMPLATE_STRUCTURE_HINT,
  canonicalHeaderMapping,
  describeCanonicalMapping,
  describeHeaderMismatch,
  normalizeHeaders,
  projectObjectToCanonical,
  projectRowToCanonical,
  storedHeaderNames
};
