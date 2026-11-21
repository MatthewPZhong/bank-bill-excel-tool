'use strict';

// v3.2.21：原始账单预处理「跨 Sheet 回填」——【导出明细】时写出回填后的原始账单（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md §3.3）。
//   - xlsx：复制原工作簿，只改写主表（第一个 Sheet）中被回填的单元格及其所需的日期样式，其余部件原样保留；
//     文本写为内联字符串（不动共享字符串表），日期写为 Excel 日期序号并套用模板日期顺序的显示格式。
//   - 其他格式（xls 等）：经读取库转成 xlsx，只保留值与数字格式。
//   - 补丁来自导入时的 applyCrossSheetBackfill（cross-sheet-backfill.js）：rowNumber 为 Excel 物理行号，
//     cells[].columnIndex 为按模板表头截取后的列下标，加上 source.columnOffset 即物理列下标（A 列为 0）。
// 一致性由调用方保证：导入时记下源文件指纹（computeFileFingerprint），导出前重算，不一致时不调用本模块。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { FileValidationError } = require('./common');

const CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX = '_回填';
const DATE_FORMAT_BY_ORDER = Object.freeze({ MDY: 'mm/dd/yyyy' });
const DEFAULT_DATE_FORMAT = 'dd/mm/yyyy';

function writeError(message) {
  return new FileValidationError('CROSS_SHEET_BACKFILL_EXPORT', message);
}

function computeFileFingerprint(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function resolveCrossSheetBackfillDateFormat(dateParseOrder) {
  return DATE_FORMAT_BY_ORDER[String(dateParseOrder || '')] || DEFAULT_DATE_FORMAT;
}

function buildCrossSheetBackfillOutputBaseName(sourceFilePath) {
  return `${path.parse(String(sourceFilePath || '')).name}${CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX}`;
}

// 为每个源文件分配「<原文件名>_回填.xlsx」：已存在或与 reservedPaths / 前面分配的重名（不区分大小写）时追加 (1)、(2)……
function allocateCrossSheetBackfillOutputPaths({ directory, sourceFilePaths = [], reservedPaths = [], existsSync = fs.existsSync }) {
  const used = new Set(reservedPaths.map((item) => path.resolve(item).toLowerCase()));
  return sourceFilePaths.map((sourceFilePath) => {
    const baseName = buildCrossSheetBackfillOutputBaseName(sourceFilePath);
    for (let index = 0; ; index += 1) {
      const candidate = path.join(directory, `${baseName}${index ? `(${index})` : ''}.xlsx`);
      const key = path.resolve(candidate).toLowerCase();
      if (!used.has(key) && !existsSync(candidate)) {
        used.add(key);
        return candidate;
      }
    }
  });
}

function columnName(columnIndex) {
  let index = columnIndex + 1;
  let name = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function columnIndexOfReference(reference) {
  const match = /^\$?([A-Z]+)\$?\d*$/i.exec(String(reference || ''));
  if (!match) return -1;
  return match[1].toUpperCase().split('').reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0) - 1;
}

// yyyy-mm-dd → Excel 日期序号（1900 日期系统按 1899-12-30 起算，与 Excel 自 1900-03-01 起一致；1904 日期系统按 1904-01-01 起算）
function isoDateToSerial(isoDate, date1904 = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!match) throw writeError(`回填日期无法写出：${isoDate}`);
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return Math.round((time - epoch) / 86400000);
}

// 补丁 → Map<物理行号, Map<物理列下标, { kind, value }>>；同一单元格出现两次时拒绝（不应发生）
function buildCellPlan(patches, columnOffset) {
  const plan = new Map();
  (Array.isArray(patches) ? patches : []).forEach((patch) => {
    const rowNumber = Number(patch && patch.rowNumber);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw writeError('回填补丁行号无效');
    (Array.isArray(patch.cells) ? patch.cells : []).forEach((cell) => {
      const column = Number(columnOffset || 0) + Number(cell && cell.columnIndex);
      if (!Number.isSafeInteger(column) || column < 0) throw writeError('回填补丁列号无效');
      if (!plan.has(rowNumber)) plan.set(rowNumber, new Map());
      const row = plan.get(rowNumber);
      if (row.has(column)) throw writeError(`回填补丁重复：${columnName(column)}${rowNumber}`);
      row.set(column, { kind: cell.kind === 'date' ? 'date' : 'value', value: cell.value });
    });
  });
  return plan;
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function decodeXmlAttribute(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function readAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return match ? decodeXmlAttribute(match[1] !== undefined ? match[1] : match[2]) : null;
}

function setAttribute(attributes, name, value) {
  const pattern = new RegExp(`(\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
  const text = `${name}="${escapeXmlAttribute(value)}"`;
  return pattern.test(attributes) ? attributes.replace(pattern, `$1${text}`) : `${attributes} ${text}`;
}

function removeAttribute(attributes, name) {
  return attributes.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`), '');
}

function resolvePartPath(baseDirectory, target) {
  const text = String(target || '');
  if (text.startsWith('/')) return text.slice(1);
  return path.posix.normalize(path.posix.join(baseDirectory, text));
}

function relationshipsPathOf(partPath) {
  return path.posix.join(path.posix.dirname(partPath), '_rels', `${path.posix.basename(partPath)}.rels`);
}

async function readZipText(zip, partPath, label) {
  const entry = zip.file(partPath);
  if (!entry) throw writeError(`原始账单缺少${label}`);
  return entry.async('string');
}

function parseRelationships(xml) {
  const relationships = new Map();
  const pattern = /<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const id = readAttribute(match[1], 'Id');
    if (id) relationships.set(id, { type: readAttribute(match[1], 'Type') || '', target: readAttribute(match[1], 'Target') || '' });
  }
  return relationships;
}

// 主表 = workbook.xml 中第一个 <sheet>（与读取库 SheetNames[0] 一致）
async function locateMainWorksheet(zip) {
  const rootRelationships = parseRelationships(await readZipText(zip, '_rels/.rels', '根关系'));
  const officeDocument = Array.from(rootRelationships.values()).find((item) => /\/officeDocument$/.test(item.type));
  const workbookPath = resolvePartPath('', officeDocument ? officeDocument.target : 'xl/workbook.xml');
  const workbookXml = await readZipText(zip, workbookPath, '工作簿');
  const sheetMatch = /<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/.exec(workbookXml);
  if (!sheetMatch) throw writeError('原始账单中没有工作表');
  const relationshipIdMatch = /(?:^|\s)[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(sheetMatch[1]);
  const relationshipId = relationshipIdMatch ? decodeXmlAttribute(relationshipIdMatch[1] ?? relationshipIdMatch[2]) : '';
  const workbookRelationships = parseRelationships(await readZipText(zip, relationshipsPathOf(workbookPath), '工作簿关系'));
  const relationship = workbookRelationships.get(relationshipId);
  if (!relationship) throw writeError('原始账单的主表关系缺失');
  const date1904Match = /<(?:[\w.-]+:)?workbookPr\b([^>]*?)\/?>/.exec(workbookXml);
  const date1904Value = date1904Match ? readAttribute(date1904Match[1], 'date1904') : null;
  const stylesRelationship = Array.from(workbookRelationships.values()).find((item) => /\/styles$/.test(item.type));
  const workbookDirectory = path.posix.dirname(workbookPath);
  return {
    sheetName: readAttribute(sheetMatch[1], 'name') || '',
    sheetPath: resolvePartPath(workbookDirectory, relationship.target),
    stylesPath: stylesRelationship ? resolvePartPath(workbookDirectory, stylesRelationship.target) : '',
    date1904: date1904Value === '1' || date1904Value === 'true'
  };
}

// 日期样式：以单元格原样式为底、换成日期数字格式；同一底样式只新增一次。没有样式表时不支持（xlsx 必有）。
function createDateStyleRegistry(stylesXml, formatCode) {
  if (!stylesXml) throw writeError('原始账单缺少样式表，无法写出日期');
  const rootMatch = /<((?:[\w.-]+:)?)styleSheet\b[^>]*>/.exec(stylesXml);
  if (!rootMatch) throw writeError('原始账单的样式表无法识别');
  const prefix = rootMatch[1];
  let xml = stylesXml;
  // 数字格式：已有同格式时复用其编号，否则在自定义编号（≥164）之后新增
  const numFmtPattern = new RegExp(`<${prefix}numFmt\\b([^>]*?)\\/?>`, 'g');
  let numFmtId = null;
  let maxId = 163;
  let match;
  while ((match = numFmtPattern.exec(xml))) {
    const id = Number(readAttribute(match[1], 'numFmtId'));
    if (Number.isFinite(id)) maxId = Math.max(maxId, id);
    if (readAttribute(match[1], 'formatCode') === formatCode && numFmtId === null) numFmtId = id;
  }
  if (numFmtId === null) {
    numFmtId = maxId + 1;
    const element = `<${prefix}numFmt numFmtId="${numFmtId}" formatCode="${escapeXmlAttribute(formatCode)}"/>`;
    const numFmtsMatch = new RegExp(`<${prefix}numFmts\\b([^>]*?)(\\/>|>)`).exec(xml);
    if (numFmtsMatch) {
      const count = Number(readAttribute(numFmtsMatch[1], 'count')) || 0;
      const attributes = setAttribute(numFmtsMatch[1], 'count', String(count + 1));
      const replacement = numFmtsMatch[2] === '/>'
        ? `<${prefix}numFmts${attributes}>${element}</${prefix}numFmts>`
        : `<${prefix}numFmts${attributes}>`;
      xml = xml.slice(0, numFmtsMatch.index) + replacement + xml.slice(numFmtsMatch.index + numFmtsMatch[0].length);
      if (numFmtsMatch[2] !== '/>') xml = xml.replace(new RegExp(`</${prefix}numFmts>`), `${element}</${prefix}numFmts>`);
    } else {
      const insertAt = rootMatch.index + rootMatch[0].length;
      xml = `${xml.slice(0, insertAt)}<${prefix}numFmts count="1">${element}</${prefix}numFmts>${xml.slice(insertAt)}`;
    }
  }

  const cellXfsMatch = new RegExp(`<${prefix}cellXfs\\b([^>]*?)>([\\s\\S]*?)</${prefix}cellXfs>`).exec(xml);
  if (!cellXfsMatch) throw writeError('原始账单的样式表缺少单元格格式');
  const xfPattern = new RegExp(`<${prefix}xf\\b[^>]*?(?:\\/>|>[\\s\\S]*?</${prefix}xf>)`, 'g');
  const existingXfs = cellXfsMatch[2].match(xfPattern) || [];
  const addedXfs = [];
  const styleByBase = new Map();

  return {
    styleIndexFor(baseIndex) {
      const base = Number.isSafeInteger(baseIndex) && baseIndex >= 0 && baseIndex < existingXfs.length ? baseIndex : 0;
      if (styleByBase.has(base)) return styleByBase.get(base);
      const baseXf = existingXfs[base] || `<${prefix}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
      const openTag = /^<[^>]*?(?=\/?>)/.exec(baseXf)[0];
      let attributes = openTag.slice(`<${prefix}xf`.length);
      attributes = setAttribute(attributes, 'numFmtId', String(numFmtId));
      attributes = setAttribute(attributes, 'applyNumberFormat', '1');
      addedXfs.push(`<${prefix}xf${attributes}${baseXf.slice(openTag.length)}`);
      const index = existingXfs.length + addedXfs.length - 1;
      styleByBase.set(base, index);
      return index;
    },
    toXml() {
      if (!addedXfs.length) return null;
      const attributes = setAttribute(cellXfsMatch[1], 'count', String(existingXfs.length + addedXfs.length));
      const current = new RegExp(`<${prefix}cellXfs\\b([^>]*?)>([\\s\\S]*?)</${prefix}cellXfs>`).exec(xml);
      return xml.slice(0, current.index)
        + `<${prefix}cellXfs${attributes}>${current[2]}${addedXfs.join('')}</${prefix}cellXfs>`
        + xml.slice(current.index + current[0].length);
    }
  };
}

function buildCellXml(prefix, reference, styleIndex, entry, { date1904, dateStyles }) {
  const tag = `${prefix}c`;
  if (entry.kind === 'date') {
    const style = dateStyles.styleIndexFor(styleIndex);
    return `<${tag} r="${reference}" s="${style}"><${prefix}v>${isoDateToSerial(entry.value, date1904)}</${prefix}v></${tag}>`;
  }
  const styleAttribute = Number.isSafeInteger(styleIndex) && styleIndex > 0 ? ` s="${styleIndex}"` : '';
  const value = entry.value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<${tag} r="${reference}"${styleAttribute}><${prefix}v>${String(value)}</${prefix}v></${tag}>`;
  }
  if (typeof value === 'boolean') {
    return `<${tag} r="${reference}"${styleAttribute} t="b"><${prefix}v>${value ? 1 : 0}</${prefix}v></${tag}>`;
  }
  const text = value === null || value === undefined ? '' : String(value);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<${tag} r="${reference}"${styleAttribute} t="inlineStr"><${prefix}is><${prefix}t${space}>${escapeXmlText(text)}</${prefix}t></${prefix}is></${tag}>`;
}

// 改写一行：已有单元格按列替换（含公式的单元格拒绝改写），没有的按列序插入；行内单元格缺少 r 时补上（插入后其后单元格的隐含列号不变）
function patchRowContent({ prefix, rowNumber, content, cellPlan, context }) {
  const cellPattern = new RegExp(`<${prefix}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)</${prefix}c>)`, 'g');
  const cells = [];
  let previousColumn = -1;
  let match;
  let lastIndex = 0;
  const between = [];
  while ((match = cellPattern.exec(content))) {
    between.push(content.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const reference = readAttribute(match[1], 'r');
    const column = reference ? columnIndexOfReference(reference) : previousColumn + 1;
    if (column < 0) throw writeError(`第 ${rowNumber} 行有无法识别的单元格`);
    previousColumn = column;
    cells.push({ column, attributes: match[1], inner: match[2] || '', xml: match[0], hasReference: Boolean(reference) });
  }
  const tail = content.slice(lastIndex);
  // 单元格之外的内容（如 extLst）保持在行尾；单元格之间只有空白
  if (between.some((text) => text.trim() !== '')) throw writeError(`第 ${rowNumber} 行结构无法识别`);

  const output = [];
  const pending = Array.from(cellPlan.entries()).sort((left, right) => left[0] - right[0]);
  let pendingIndex = 0;
  const emitPending = (beforeColumn) => {
    while (pendingIndex < pending.length && pending[pendingIndex][0] < beforeColumn) {
      const [column, entry] = pending[pendingIndex];
      output.push(buildCellXml(prefix, `${columnName(column)}${rowNumber}`, 0, entry, context));
      pendingIndex += 1;
    }
  };
  cells.forEach((cell) => {
    emitPending(cell.column);
    const reference = `${columnName(cell.column)}${rowNumber}`;
    if (pendingIndex < pending.length && pending[pendingIndex][0] === cell.column) {
      if (new RegExp(`<${prefix}f\\b`).test(cell.inner)) {
        throw writeError(`单元格 ${reference} 含公式，未改写`);
      }
      const styleIndex = Number(readAttribute(cell.attributes, 's'));
      output.push(buildCellXml(prefix, reference, Number.isSafeInteger(styleIndex) ? styleIndex : 0, pending[pendingIndex][1], context));
      pendingIndex += 1;
      return;
    }
    output.push(cell.hasReference ? cell.xml : cell.xml.replace(new RegExp(`^<${prefix}c\\b`), `<${prefix}c r="${reference}"`));
  });
  emitPending(Number.POSITIVE_INFINITY);
  return output.join('') + tail;
}

function patchWorksheetXml(sheetXml, plan, context) {
  const sheetDataMatch = /<((?:[\w.-]+:)?)sheetData\b[^>]*?(\/>|>)/.exec(sheetXml);
  if (!sheetDataMatch || sheetDataMatch[2] === '/>') throw writeError('原始账单的主表没有数据');
  const prefix = sheetDataMatch[1];
  const start = sheetDataMatch.index + sheetDataMatch[0].length;
  const end = sheetXml.indexOf(`</${prefix}sheetData>`, start);
  if (end < 0) throw writeError('原始账单的主表结构无法识别');
  const content = sheetXml.slice(start, end);
  const rowPattern = new RegExp(`<${prefix}row\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)</${prefix}row>)`, 'g');
  const remaining = new Set(plan.keys());
  let previousRow = 0;
  const patched = content.replace(rowPattern, (rowXml, attributes, inner = '') => {
    const declared = Number(readAttribute(attributes, 'r'));
    const rowNumber = Number.isSafeInteger(declared) && declared > 0 ? declared : previousRow + 1;
    previousRow = rowNumber;
    const cellPlan = plan.get(rowNumber);
    if (!cellPlan) return rowXml;
    remaining.delete(rowNumber);
    // spans 只是列范围提示，插入单元格后可能不准，去掉
    const rowAttributes = setAttribute(removeAttribute(attributes, 'spans'), 'r', String(rowNumber));
    return `<${prefix}row${rowAttributes}>${patchRowContent({ prefix, rowNumber, content: inner, cellPlan, context })}</${prefix}row>`;
  });
  if (remaining.size) {
    throw writeError(`原始账单主表中找不到第 ${Array.from(remaining).sort((a, b) => a - b).join('、')} 行`);
  }
  return sheetXml.slice(0, start) + patched + sheetXml.slice(end);
}

async function writePatchedXlsx({ sourceFilePath, plan, mainSheetName, dateFormat }) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourceFilePath));
  const main = await locateMainWorksheet(zip);
  if (mainSheetName && main.sheetName !== mainSheetName) {
    throw writeError(`原始账单的第一个 Sheet 已不是「${mainSheetName}」`);
  }
  const hasDate = Array.from(plan.values()).some((row) => Array.from(row.values()).some((entry) => entry.kind === 'date'));
  const stylesXml = hasDate ? await readZipText(zip, main.stylesPath, '样式表') : '';
  const dateStyles = hasDate ? createDateStyleRegistry(stylesXml, dateFormat) : { styleIndexFor: () => 0, toXml: () => null };
  const sheetXml = await readZipText(zip, main.sheetPath, '主表');
  const patchedSheet = patchWorksheetXml(sheetXml, plan, { date1904: main.date1904, dateStyles });
  zip.file(main.sheetPath, patchedSheet);
  const patchedStyles = dateStyles.toXml();
  if (patchedStyles) zip.file(main.stylesPath, patchedStyles);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function writeConvertedWorkbook({ sourceFilePath, plan, mainSheetName, dateFormat }) {
  const workbook = XLSX.readFile(sourceFilePath, { cellDates: false, cellNF: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (mainSheetName && sheetName !== mainSheetName) {
    throw writeError(`原始账单的第一个 Sheet 已不是「${mainSheetName}」`);
  }
  const sheet = workbook.Sheets[sheetName];
  const date1904 = Boolean(workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904);
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  plan.forEach((cells, rowNumber) => {
    cells.forEach((entry, column) => {
      const reference = XLSX.utils.encode_cell({ r: rowNumber - 1, c: column });
      const existing = sheet[reference];
      if (existing && existing.f) throw writeError(`单元格 ${reference} 含公式，未改写`);
      if (entry.kind === 'date') {
        sheet[reference] = { t: 'n', v: isoDateToSerial(entry.value, date1904), z: dateFormat };
      } else if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
        sheet[reference] = { t: 'n', v: entry.value, ...(existing && existing.z ? { z: existing.z } : {}) };
      } else if (typeof entry.value === 'boolean') {
        sheet[reference] = { t: 'b', v: entry.value };
      } else {
        sheet[reference] = { t: 's', v: entry.value === null || entry.value === undefined ? '' : String(entry.value) };
      }
      range.s.r = Math.min(range.s.r, rowNumber - 1);
      range.e.r = Math.max(range.e.r, rowNumber - 1);
      range.s.c = Math.min(range.s.c, column);
      range.e.c = Math.max(range.e.c, column);
    });
  });
  sheet['!ref'] = XLSX.utils.encode_range(range);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function isZipFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    return read === 4 && head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04;
  } finally {
    fs.closeSync(fd);
  }
}

// 写出回填后的原始账单；返回 { converted（非 xlsx 转换）, cellCount }。先写临时文件再改名，失败时不留半成品。
async function writeCrossSheetBackfillWorkbook({ sourceFilePath, outputFilePath, patches, source = {} }) {
  const plan = buildCellPlan(patches, source.columnOffset);
  if (!plan.size) throw writeError('没有需要写出的回填单元格');
  const dateFormat = resolveCrossSheetBackfillDateFormat(source.dateParseOrder);
  const converted = !isZipFile(sourceFilePath);
  const buffer = converted
    ? writeConvertedWorkbook({ sourceFilePath, plan, mainSheetName: source.mainSheetName, dateFormat })
    : await writePatchedXlsx({ sourceFilePath, plan, mainSheetName: source.mainSheetName, dateFormat });
  const temporaryPath = path.join(
    path.dirname(outputFilePath),
    `.${path.basename(outputFilePath)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
    fs.renameSync(temporaryPath, outputFilePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_ignored) { /* 清理失败不掩盖原错误 */ }
    throw error;
  }
  const cellCount = Array.from(plan.values()).reduce((sum, row) => sum + row.size, 0);
  return { converted, cellCount };
}

module.exports = {
  CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX,
  allocateCrossSheetBackfillOutputPaths,
  buildCrossSheetBackfillOutputBaseName,
  computeFileFingerprint,
  isoDateToSerial,
  resolveCrossSheetBackfillDateFormat,
  writeCrossSheetBackfillWorkbook
};
