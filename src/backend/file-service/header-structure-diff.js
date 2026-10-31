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

// sheets：[{ name, headers }]，文件中各工作表的表头行；candidates：[{ name, headers, versionLabel }]。
// 返回 detailLines；hint 为 null 时不附加模板文件提示（结构不可替换的表）。
function describeHeaderMismatch({ sheets, candidates, hint = TEMPLATE_STRUCTURE_HINT } = {}) {
  const actualSheets = (Array.isArray(sheets) ? sheets : [])
    .map((sheet) => ({ name: cellText(sheet && sheet.name), headers: normalizeHeaders(sheet && sheet.headers) }));
  const expected = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      name: cellText(candidate && candidate.name),
      versionLabel: cellText(candidate && candidate.versionLabel),
      headers: normalizeHeaders(candidate && candidate.headers)
    }))
    .filter((candidate) => candidate.headers.length > 0);
  const lines = [];
  const best = closestPair(actualSheets, expected);
  const sheetPrefix = (sheet) => (actualSheets.length > 1 && sheet.name ? `工作表「${sheet.name}」` : '');

  if (!best || best.score === 0) {
    lines.push('文件表头与所有已知结构都没有相同的列名');
    for (const sheet of actualSheets.slice(0, 5)) {
      const label = sheetPrefix(sheet) || '文件';
      lines.push(sheet.headers.length
        ? `${label}第 1 行（${sheet.headers.length} 列）：${listText(sheet.headers)}`
        : `${label}第 1 行为空`);
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

module.exports = {
  TEMPLATE_STRUCTURE_HINT,
  describeHeaderMismatch,
  normalizeHeaders
};
