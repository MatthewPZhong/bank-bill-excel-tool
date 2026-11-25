'use strict';

// v3.2.21：原始账单预处理「跨 Sheet 回填」——【导出明细】时写出回填后的原始账单（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md §3.3）。
//   - xlsx：复制原工作簿，只改写主表（第一个 Sheet）中被回填的单元格及其所需的日期样式，其余部件原样保留；
//     文本写为内联字符串（不动共享字符串表），日期写为 Excel 日期序号并套用模板日期顺序的显示格式。
//   - 其他格式（xls 等）：经读取库转成 xlsx，只保留值与数字格式（公式冻结为读取到的结果值）。
//   - 补丁来自导入时的 applyCrossSheetBackfill（cross-sheet-backfill.js）：rowNumber 为 Excel 物理行号，
//     cells[].columnIndex 为按模板表头截取后的列下标，加上 source.columnOffset 即物理列下标（A 列为 0）。
// 一致性由调用方保证：导入时记下源文件指纹（computeFileFingerprint），导出时读出原文件、按同一份字节核对指纹
//   （computeBufferFingerprint），一致才把这份字节交给本模块（sourceBuffer），不再按路径重读。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { FileValidationError } = require('./common');
const { decodeExcelStXstring, encodeExcelStXstring } = require('../xlsx/excel-text');
const {
  decodeXmlAttributeValue, loadOdsContent, maskXmlMarkup, normalizeXlmlWorkbookBuffer, normalizeXlsxSharedStringsBuffer, odsWorkbookBuffer, parseXlsxRelationships, sharedStringItemSources, xmlCharacterData, restoreOdsSelfClosingCells, xlsxWorkbookDate1904, xlsxWorkbookRootInfo,
  xlsxWorkbookXmlOf,
  xmlTagsHiddenInMarkup, scanOdsWorkbookCells, scanXlmlWorkbookCells, scanXlsxSheetCells,
  xmlStartTagPattern
} = require('./readers');

const CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX = '_回填';
const DATE_FORMAT_BY_ORDER = Object.freeze({ MDY: 'mm/dd/yyyy' });
const DEFAULT_DATE_FORMAT = 'dd/mm/yyyy';
// 1904 与 1900 日期系统同一天的序号差（与 readers.js 一致）
const EXCEL_1904_DAY_OFFSET = 1462;

function decodeSheetName(value) {
  try {
    return decodeExcelStXstring(value);
  } catch (_error) {
    return value;
  }
}

function writeError(message) {
  return new FileValidationError('CROSS_SHEET_BACKFILL_EXPORT', message);
}

function computeBufferFingerprint(buffer) {
  return {
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

// 打开要核对指纹的源文件：先按路径确认是普通文件（管道、设备等不打开，避免打开或读取时阻塞），再以非阻塞方式打开、按句柄
//   复核；不是普通文件时抛出（调用方按已变化处理）
function openRegularFile(filePath) {
  if (!fs.statSync(filePath).isFile()) throw writeError('源文件不是普通文件');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw writeError('源文件不是普通文件');
    return { fd, size: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

// 从句柄当前位置最多读 limit 字节，按块交给 onChunk，返回实际读到的字节数
function readChunks(fd, limit, onChunk) {
  const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(FINGERPRINT_CHUNK_BYTES, limit)));
  let total = 0;
  while (total < limit) {
    const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - total), null);
    if (read <= 0) break;
    onChunk(chunk.subarray(0, read));
    total += read;
  }
  return total;
}

// 源文件指纹，分块计算（不把整份文件读入内存）。给出 expectedSize 时先比较大小，不一致直接返回 sha256: null，不读内容；
//   读取时最多读到 expectedSize + 1 字节（核对期间文件变长同样判为不一致）
function computeFileFingerprint(filePath, { expectedSize } = {}) {
  const { fd, size } = openRegularFile(filePath);
  try {
    const checkSize = Number.isSafeInteger(expectedSize);
    if (checkSize && size !== expectedSize) return { size, sha256: null };
    const hash = crypto.createHash('sha256');
    const read = readChunks(fd, checkSize ? expectedSize + 1 : Infinity, (chunk) => hash.update(chunk));
    return { size: read, sha256: checkSize && read !== expectedSize ? null : hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

// 读出与导入时指纹（{ size, sha256 }）一致的源文件内容：按句柄核对普通文件与大小后只读这么多字节（再多读到 1 字节即视为
//   已变化），摘要一致才返回这份字节（核对与写出用同一份字节）；不一致返回 null，读不到时抛出
function readFingerprintedFile(filePath, expected) {
  const expectedSize = expected && expected.size;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return null;
  const { fd, size } = openRegularFile(filePath);
  try {
    if (size !== expectedSize) return null;
    const buffer = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    const read = readChunks(fd, expectedSize + 1, (chunk) => {
      if (offset + chunk.length <= expectedSize) chunk.copy(buffer, offset);
      offset += chunk.length;
    });
    if (read !== expectedSize) return null;
    return computeBufferFingerprint(buffer).sha256 === expected.sha256 ? buffer : null;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveCrossSheetBackfillDateFormat(dateParseOrder) {
  return DATE_FORMAT_BY_ORDER[String(dateParseOrder || '')] || DEFAULT_DATE_FORMAT;
}

function buildCrossSheetBackfillOutputBaseName(sourceFilePath) {
  return `${path.parse(String(sourceFilePath || '')).name}${CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX}`;
}

// 单个文件名的上限（常见文件系统为 255 字节 / 字符；按 UTF-8 字节计，且按分解形式计，覆盖以分解形式存名的文件系统）
const MAX_OUTPUT_FILE_NAME_BYTES = 255;

// 「<原文件名>_回填<序号>.xlsx」超过单个文件名上限时，按字符截短原文件名部分（后缀、序号与扩展名保留），避免登记导出计划时
//   因文件名过长失败、连带明细也不能导出
function buildCrossSheetBackfillOutputFileName(sourceFilePath, index) {
  const tail = `${CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX}${index ? `(${index})` : ''}.xlsx`;
  const fits = (name) => Buffer.byteLength(name.normalize('NFD'), 'utf8') <= MAX_OUTPUT_FILE_NAME_BYTES;
  const stem = Array.from(path.parse(String(sourceFilePath || '')).name.normalize('NFC'));
  let fileName = `${stem.join('')}${tail}`;
  while (!fits(fileName) && stem.length) {
    stem.pop();
    fileName = `${stem.join('')}${tail}`;
  }
  return fileName;
}

// 为每个源文件分配「<原文件名>_回填.xlsx」：已存在或与 reservedPaths / 前面分配的重名（不区分大小写）时追加 (1)、(2)……；
//   超过单个文件名上限时截短原文件名部分（见 buildCrossSheetBackfillOutputFileName）
//   目录中已有的文件同样不区分大小写比较（区分大小写的文件系统上 Statement_回填.xlsx 也占用 statement_回填.xlsx）。
function allocateCrossSheetBackfillOutputPaths({
  directory,
  sourceFilePaths = [],
  reservedPaths = [],
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync
}) {
  // 没有要写出的回填文件时不访问目录（普通导出也会以空列表调用）
  if (!Array.isArray(sourceFilePaths) || !sourceFilePaths.length) return [];
  // 名称按 Unicode NFC 规范化后不区分大小写比较（macOS 上 Café 的组合 / 分解写法指向同一个文件，同 main.js
  //   findGenerationGroupOutputPathConflicts）
  const nameKey = (value) => String(value).normalize('NFC').toLowerCase();
  const used = new Set(reservedPaths.map((item) => nameKey(path.resolve(item))));
  let existingNames = new Set();
  try {
    existingNames = new Set(readdirSync(directory).map(nameKey));
  } catch (_error) {
    // 读不到目录时只按 existsSync 判断
  }
  return sourceFilePaths.map((sourceFilePath) => {
    for (let index = 0; ; index += 1) {
      const fileName = buildCrossSheetBackfillOutputFileName(sourceFilePath, index);
      const candidate = path.join(directory, fileName);
      const key = nameKey(path.resolve(candidate));
      if (!used.has(key) && !existingNames.has(nameKey(fileName)) && !existsSync(candidate)) {
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
  const serial = Math.round((time - epoch) / 86400000);
  // 1900 日期系统把 1900-02-29 算作存在的日期，1900-03-01 之前的序号比实际天数少 1（与读取侧 isoTextToSerial 一致）
  return !date1904 && serial < 61 ? serial - 1 : serial;
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

// 内联字符串文本：按 SpreadsheetML 的 ST_Xstring 编码（控制字符写成 _xHHHH_，原文中像 _xHHHH_ 的片段逐个把开头下划线写成
//   _x005F_，相邻片段共用下划线时同样保留），再做 XML 转义。复用 xlsx 公共基础设施的编码（src/backend/xlsx/excel-text.js）
function encodeSpreadsheetText(value) {
  return escapeXmlText(encodeExcelStXstring(String(value)));
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function readAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return match ? decodeXmlAttributeValue(match[1] !== undefined ? match[1] : match[2]) : null;
}

function setAttribute(attributes, name, value) {
  const pattern = new RegExp(`(\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
  const text = `${name}="${escapeXmlAttribute(value)}"`;
  // 按回调写入：属性值按字面量保留（表名等值中的 `$1`、`$&` 不当作替换标记）
  return pattern.test(attributes) ? attributes.replace(pattern, (_whole, space) => `${space}${text}`) : `${attributes} ${text}`;
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

// 生效的关系（与读取侧共用 parseXlsxRelationships）：注释等标记中藏有 <Relationship>、或 Id 重复时无法确认读取库用的是哪一条，拒绝
function parseRelationships(xml) {
  const relationships = xmlTagsHiddenInMarkup(xml, 'Relationship') ? null : parseXlsxRelationships(xml);
  if (!relationships) throw writeError('原始账单的关系声明中有被注释的旧关系或重复编号，无法确认各部件');
  return relationships;
}

// 主表 = workbook.xml 中第一个 <sheet>（与读取库 SheetNames[0] 一致）
async function locateMainWorksheet(zip) {
  const rootRelationships = parseXlsxRelationships(await readZipText(zip, '_rels/.rels', '根关系'));
  if (!rootRelationships) throw writeError('原始账单的根关系编号重复，无法确认工作簿');
  const officeDocument = Array.from(rootRelationships.values()).find((item) => /\/officeDocument$/.test(item.type));
  const workbookPath = resolvePartPath('', officeDocument ? officeDocument.target : 'xl/workbook.xml');
  const workbookXml = await readZipText(zip, workbookPath, '工作簿');
  // 属性值按引号边界读取：表名可含字面 `>`（如 `A > B`）；注释、CDATA、处理指令中的旧元素不算（与读取侧一致）
  if (xmlTagsHiddenInMarkup(workbookXml, 'sheet')) throw writeError('原始账单的工作簿中有被注释的工作表声明，无法确认主表');
  const sheetMatch = xmlStartTagPattern('sheet', '').exec(maskXmlMarkup(workbookXml));
  if (!sheetMatch) throw writeError('原始账单中没有工作表');
  const relationshipIdMatch = /(?:^|\s)[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(sheetMatch[1]);
  const relationshipId = relationshipIdMatch ? decodeXmlAttributeValue(relationshipIdMatch[1] ?? relationshipIdMatch[2]) : '';
  const workbookRelationships = parseRelationships(await readZipText(zip, relationshipsPathOf(workbookPath), '工作簿关系'));
  const relationship = workbookRelationships.get(relationshipId);
  if (!relationship) throw writeError('原始账单的主表关系缺失');
  // 日期系统按根元素下实际生效的 workbookPr（与读取侧同一函数，见 readers.js xlsxWorkbookRootInfo）
  const rootInfo = xlsxWorkbookRootInfo(workbookXml);
  if (!rootInfo || rootInfo.date1904 === null) throw writeError('原始账单的工作簿结构无法识别，无法确定日期系统');
  const { date1904 } = rootInfo;
  const stylesRelationship = Array.from(workbookRelationships.values()).find((item) => /\/styles$/.test(item.type));
  const sharedStringsRelationship = Array.from(workbookRelationships.values()).find((item) => /\/sharedStrings$/.test(item.type));
  const workbookDirectory = path.posix.dirname(workbookPath);
  return {
    // 表名可以按 ST_Xstring 转义存储，与读取侧（读取库解码后的名字）按同一规则解码后核对
    sheetName: decodeSheetName(readAttribute(sheetMatch[1], 'name') || ''),
    sheetPath: resolvePartPath(workbookDirectory, relationship.target),
    stylesPath: stylesRelationship ? resolvePartPath(workbookDirectory, stylesRelationship.target) : '',
    sharedStringsPath: sharedStringsRelationship ? resolvePartPath(workbookDirectory, sharedStringsRelationship.target) : '',
    workbookDirectory,
    workbookRelationshipsPath: relationshipsPathOf(workbookPath),
    relationshipIds: new Set(workbookRelationships.keys()),
    date1904,
    strict: rootInfo.namespace === STRICT_SPREADSHEETML_MAIN_NAMESPACE
  };
}

const MINIMAL_STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';
const STYLES_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
// Strict OOXML（工作簿根元素为 purl.oclc.org 命名空间）：补建的样式表与样式关系同样用 Strict 的命名空间与关系类型（第二十七轮）
const STRICT_SPREADSHEETML_MAIN_NAMESPACE = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const STRICT_STYLES_RELATIONSHIP_TYPE = 'http://purl.oclc.org/ooxml/officeDocument/relationships/styles';
const STYLES_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';

// XML 文档根元素结束标签之后允许的内容（空白、注释、处理指令）：按此定位根元素实际的结束标签
const XML_TRAILING_MISC = '(?:\\s|<!--[\\s\\S]*?-->|<\\?[\\s\\S]*?\\?>)*$';

// 样式部件是可选的：没有时新建最小样式表，并登记工作簿关系与内容类型（只在需要写日期时）
async function ensureStylesPart(zip, main) {
  if (main.stylesPath) {
    return { stylesPath: main.stylesPath, stylesXml: await readZipText(zip, main.stylesPath, '样式表') };
  }
  let stylesPath = path.posix.join(main.workbookDirectory, 'styles.xml');
  for (let index = 1; zip.file(stylesPath); index += 1) {
    stylesPath = path.posix.join(main.workbookDirectory, `styles${index}.xml`);
  }
  let relationshipId = 'rIdStyles';
  for (let index = 1; main.relationshipIds.has(relationshipId); index += 1) relationshipId = `rIdStyles${index}`;
  const relationshipsXml = await readZipText(zip, main.workbookRelationshipsPath, '工作簿关系');
  const relationshipsClose = new RegExp(`</((?:[\\w.-]+:)?)Relationships>${XML_TRAILING_MISC}`).exec(relationshipsXml);
  if (!relationshipsClose) throw writeError('原始账单的工作簿关系无法识别');
  const target = path.posix.relative(main.workbookDirectory || '.', stylesPath);
  zip.file(
    main.workbookRelationshipsPath,
    relationshipsXml.slice(0, relationshipsClose.index)
      + `<${relationshipsClose[1]}Relationship Id="${relationshipId}" Type="${main.strict ? STRICT_STYLES_RELATIONSHIP_TYPE : STYLES_RELATIONSHIP_TYPE}" Target="${escapeXmlAttribute(target)}"/>`
      + relationshipsXml.slice(relationshipsClose.index)
  );
  const contentTypesXml = await readZipText(zip, '[Content_Types].xml', '内容类型');
  const typesClose = new RegExp(`</((?:[\\w.-]+:)?)Types>${XML_TRAILING_MISC}`).exec(contentTypesXml);
  if (!typesClose) throw writeError('原始账单的内容类型无法识别');
  zip.file(
    '[Content_Types].xml',
    contentTypesXml.slice(0, typesClose.index)
      + `<${typesClose[1]}Override PartName="/${escapeXmlAttribute(stylesPath)}" ContentType="${STYLES_CONTENT_TYPE}"/>`
      + contentTypesXml.slice(typesClose.index)
  );
  const stylesXml = main.strict
    ? MINIMAL_STYLES_XML.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', `xmlns="${STRICT_SPREADSHEETML_MAIN_NAMESPACE}"`)
    : MINIMAL_STYLES_XML;
  return { stylesPath, stylesXml };
}

const SPREADSHEETML_MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]);
// 开始 / 结束 / 自闭合标签：1 结束标记、2 前缀（含冒号）、3 本地名、4 属性（按引号边界，属性值中可有字面 >）、5 自闭合标记
const XML_TAG_SOURCE = '<(\\/?)((?:[\\w.-]+:)?)([\\w.-]+)((?:[^>"\']|"[^"]*"|\'[^\']*\')*?)(\\/?)>';

// 从 from（父元素开始标签之后）起列出直接子元素，到父元素的结束标签为止：
//   { children: [{ prefix, local, start, openEnd, end, selfClosing }], closeStart（父元素结束标签的位置） }；标签不配对时拒绝
function listChildElements(masked, from) {
  const pattern = new RegExp(XML_TAG_SOURCE, 'g');
  pattern.lastIndex = from;
  const children = [];
  let depth = 0;
  let current = null;
  let match;
  while ((match = pattern.exec(masked))) {
    const [text, closing, prefix, local, , selfClosing] = match;
    if (closing) {
      if (depth === 0) return { children, closeStart: match.index };
      depth -= 1;
      if (depth === 0) {
        current.end = match.index + text.length;
        children.push(current);
        current = null;
      }
    } else if (depth === 0) {
      current = { prefix, local, start: match.index, openEnd: match.index + text.length, selfClosing: Boolean(selfClosing) };
      if (selfClosing) {
        current.end = current.openEnd;
        children.push(current);
        current = null;
      } else {
        depth = 1;
      }
    } else if (!selfClosing) {
      depth += 1;
    }
  }
  throw writeError('原始账单的样式表无法识别');
}

// 样式表的结构视图：按命名空间与本地名识别元素。绑定到 SpreadsheetML 主命名空间的前缀（含默认命名空间 ''）可以有多个、
//   在同一份样式表中混用（如默认命名空间的 cellXfs 下写 <m:xf>），不只认根元素的前缀；同一前缀在文档中另被绑定到其他
//   命名空间时无法只按前缀判断归属，拒绝写出。根元素前缀没有声明时（不规范的样式表）按主命名空间处理。
//   空的样式表可以是自闭合的根元素（<styleSheet …/>）：先展开，补建的元素才能放在根元素之内
function parseStyleSheet(stylesXml) {
  let xml = stylesXml;
  let masked = maskXmlMarkup(xml);
  const pattern = new RegExp(XML_TAG_SOURCE, 'g');
  let root = pattern.exec(masked);
  if (!root || root[1] || root[3] !== 'styleSheet') throw writeError('原始账单的样式表无法识别');
  const rootPrefix = root[2];
  if (root[5]) {
    const expanded = `${root[0].replace(/\s*\/>$/, '>')}</${rootPrefix}styleSheet>`;
    xml = xml.slice(0, root.index) + expanded + xml.slice(root.index + root[0].length);
    masked = maskXmlMarkup(xml);
    pattern.lastIndex = 0;
    root = pattern.exec(masked);
  }
  const bindings = new Map();
  pattern.lastIndex = 0;
  let tag;
  while ((tag = pattern.exec(masked))) {
    if (tag[1]) continue;
    const declarationPattern = /(?:^|\s)xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let declaration;
    while ((declaration = declarationPattern.exec(tag[4]))) {
      const prefix = declaration[1] ? `${declaration[1]}:` : '';
      if (!bindings.has(prefix)) bindings.set(prefix, new Set());
      bindings.get(prefix).add(decodeXmlAttributeValue(declaration[2] !== undefined ? declaration[2] : declaration[3]).trim());
    }
  }
  const prefixes = new Set();
  bindings.forEach((namespaces, prefix) => {
    if (!Array.from(namespaces).some((namespace) => SPREADSHEETML_MAIN_NAMESPACES.has(namespace))) return;
    if (namespaces.size > 1) throw writeError('原始账单的样式表命名空间无法识别');
    prefixes.add(prefix);
  });
  if (!prefixes.has(rootPrefix)) {
    if (bindings.has(rootPrefix)) throw writeError('原始账单的样式表命名空间无法识别');
    prefixes.add(rootPrefix);
  }
  const rootOpenEnd = root.index + root[0].length;
  const { children, closeStart } = listChildElements(masked, rootOpenEnd);
  const childOf = (name) => children.find((child) => child.local === name && prefixes.has(child.prefix)) || null;
  return { xml, masked, prefixes, rootPrefix, rootOpenEnd, children, closeStart, childOf };
}

// 元素的直接子元素须都是主命名空间中的 localName（如 cellXfs 下只有 xf）：有其他元素时无法确定下标，拒绝写出
function expectChildElements(view, element, localName) {
  if (element.selfClosing) return { children: [], closeStart: null };
  const listed = listChildElements(view.masked, element.openEnd);
  if (listed.children.some((child) => child.local !== localName || !view.prefixes.has(child.prefix))) {
    throw writeError('原始账单的样式表无法识别');
  }
  return listed;
}

// 样式表中各子元素的规定顺序（SpreadsheetML CT_Stylesheet）
const STYLE_SHEET_CHILD_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs',
  'tableStyles', 'colors', 'extLst'];
const MINIMAL_STYLE_CHILDREN = {
  fonts: (p) => `<${p}fonts count="1"><${p}font><${p}sz val="11"/><${p}name val="Calibri"/></${p}font></${p}fonts>`,
  fills: (p) => `<${p}fills count="2"><${p}fill><${p}patternFill patternType="none"/></${p}fill>`
    + `<${p}fill><${p}patternFill patternType="gray125"/></${p}fill></${p}fills>`,
  borders: (p) => `<${p}borders count="1"><${p}border><${p}left/><${p}right/><${p}top/><${p}bottom/><${p}diagonal/></${p}border></${p}borders>`,
  cellStyleXfs: (p) => `<${p}cellStyleXfs count="1"><${p}xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></${p}cellStyleXfs>`,
  cellXfs: (p) => `<${p}cellXfs count="1"><${p}xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></${p}cellXfs>`
};

// 已有样式表但没有（或只有空的）cellXfs（可选元素，所有单元格用默认样式）：补建默认单元格格式，缺少的字体、填充、
//   边框、样式格式一并补最小定义，按规定顺序插在根元素的直接子元素之间（不按全文搜索：xf、dxf 内同样有 extLst），
//   其他样式定义保持不变
function ensureCellXfs(stylesXml) {
  let view = parseStyleSheet(stylesXml);
  const cellXfs = view.childOf('cellXfs');
  if (cellXfs && expectChildElements(view, cellXfs, 'xf').children.length) return view.xml;
  let next = cellXfs ? view.xml.slice(0, cellXfs.start) + view.xml.slice(cellXfs.end) : view.xml;
  ['fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs'].forEach((name) => {
    view = parseStyleSheet(next);
    if (name !== 'cellXfs' && view.childOf(name)) return;
    const laterNames = STYLE_SHEET_CHILD_ORDER.slice(STYLE_SHEET_CHILD_ORDER.indexOf(name) + 1);
    const later = view.children.find((child) => laterNames.includes(child.local) && view.prefixes.has(child.prefix));
    const insertAt = later ? later.start : view.closeStart;
    next = next.slice(0, insertAt) + MINIMAL_STYLE_CHILDREN[name](view.rootPrefix) + next.slice(insertAt);
  });
  return next;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// 开始标签去掉结尾的 > 或 />，只剩「<名称 属性」
function openTagCore(text) {
  return text.replace(/\s*\/?>$/, '');
}

// 日期样式：以单元格原样式为底、换成日期数字格式；同一底样式只新增一次。没有样式表时不支持（xlsx 必有）。
function createDateStyleRegistry(stylesXml, formatCode) {
  if (!stylesXml) throw writeError('原始账单缺少样式表，无法写出日期');
  let view = parseStyleSheet(stylesXml);
  let xml = view.xml;
  // 数字格式：全局 numFmts 中已有同格式时复用其编号，否则在已用的最大自定义编号（≥164，含条件格式 dxf 内的编号）之后新增。
  //   条件格式 dxf 内的 numFmt 只在条件成立时生效，普通单元格引用其编号显示不出该格式，不复用
  //   按属性引号边界匹配元素：formatCode 中可以有字面的 >（如 [>0]0.00），不能在那里截断
  const prefixPattern = Array.from(view.prefixes).sort((left, right) => right.length - left.length).map(escapeRegExp).join('|');
  const numFmtPattern = new RegExp(`<(?:${prefixPattern})numFmt\\b((?:[^>"']|"[^"]*"|'[^']*')*?)\\/?>`, 'g');
  let numFmtId = null;
  let maxId = 163;
  let match;
  while ((match = numFmtPattern.exec(view.masked))) {
    const id = Number(readAttribute(match[1], 'numFmtId'));
    if (Number.isFinite(id)) maxId = Math.max(maxId, id);
  }
  const numFmts = view.childOf('numFmts');
  const globalNumFmts = numFmts ? expectChildElements(view, numFmts, 'numFmt') : { children: [], closeStart: null };
  for (const element of globalNumFmts.children) {
    const attributes = xml.slice(element.start, element.openEnd);
    const id = Number(readAttribute(attributes, 'numFmtId'));
    if (readAttribute(attributes, 'formatCode') === formatCode && Number.isSafeInteger(id)) {
      numFmtId = id;
      break;
    }
  }
  if (numFmtId === null) {
    numFmtId = maxId + 1;
    if (numFmts) {
      const element = `<${numFmts.prefix}numFmt numFmtId="${numFmtId}" formatCode="${escapeXmlAttribute(formatCode)}"/>`;
      // count 是可选属性：原本省略时保持省略；声明了时按全局 numFmts 中实际的子元素个数更新（不按声明值累加，避免与实际不符）
      const core = openTagCore(xml.slice(numFmts.start, numFmts.openEnd));
      const attributes = core.slice(`<${numFmts.prefix}numFmts`.length);
      const nextAttributes = readAttribute(attributes, 'count') === null
        ? attributes
        : setAttribute(attributes, 'count', String(globalNumFmts.children.length + 1));
      const openTag = `<${numFmts.prefix}numFmts${nextAttributes}>`;
      xml = numFmts.selfClosing
        ? `${xml.slice(0, numFmts.start)}${openTag}${element}</${numFmts.prefix}numFmts>${xml.slice(numFmts.end)}`
        : `${xml.slice(0, numFmts.start)}${openTag}${xml.slice(numFmts.openEnd, globalNumFmts.closeStart)}${element}${xml.slice(globalNumFmts.closeStart)}`;
    } else {
      const prefix = view.rootPrefix;
      const element = `<${prefix}numFmt numFmtId="${numFmtId}" formatCode="${escapeXmlAttribute(formatCode)}"/>`;
      xml = `${xml.slice(0, view.rootOpenEnd)}<${prefix}numFmts count="1">${element}</${prefix}numFmts>${xml.slice(view.rootOpenEnd)}`;
    }
  }

  xml = ensureCellXfs(xml);
  view = parseStyleSheet(xml);
  const cellXfs = view.childOf('cellXfs');
  if (!cellXfs) throw writeError('原始账单的样式表缺少单元格格式');
  const cellXfEntries = expectChildElements(view, cellXfs, 'xf');
  // 各 xf 保留自身的前缀（与 cellXfs 的前缀可以不同）：新增的 xf 沿用底样式的前缀与内容
  const existingXfs = cellXfEntries.children.map((element) => ({
    prefix: element.prefix,
    core: openTagCore(xml.slice(element.start, element.openEnd)),
    rest: xml.slice(element.start, element.end).slice(openTagCore(xml.slice(element.start, element.openEnd)).length)
  }));
  const addedXfs = [];
  const styleByBase = new Map();

  return {
    styleIndexFor(baseIndex) {
      const base = Number.isSafeInteger(baseIndex) && baseIndex >= 0 && baseIndex < existingXfs.length ? baseIndex : 0;
      if (styleByBase.has(base)) return styleByBase.get(base);
      const baseXf = existingXfs[base];
      let attributes = baseXf.core.slice(`<${baseXf.prefix}xf`.length);
      attributes = setAttribute(attributes, 'numFmtId', String(numFmtId));
      attributes = setAttribute(attributes, 'applyNumberFormat', '1');
      addedXfs.push(`<${baseXf.prefix}xf${attributes}${baseXf.rest}`);
      const index = existingXfs.length + addedXfs.length - 1;
      styleByBase.set(base, index);
      return index;
    },
    toXml() {
      if (!addedXfs.length) return null;
      const core = openTagCore(xml.slice(cellXfs.start, cellXfs.openEnd));
      const attributes = setAttribute(core.slice(`<${cellXfs.prefix}cellXfs`.length), 'count', String(existingXfs.length + addedXfs.length));
      return xml.slice(0, cellXfs.start)
        + `<${cellXfs.prefix}cellXfs${attributes}>`
        + xml.slice(cellXfs.openEnd, cellXfEntries.closeStart)
        + addedXfs.join('')
        + xml.slice(cellXfEntries.closeStart);
    }
  };
}

// explicitStyle：原单元格显式带 s（含 s="0"，它覆盖行 / 列继承的样式），写出时保留；否则只在有效样式非 0 时写出
function buildCellXml(prefix, reference, styleIndex, entry, { date1904, dateStyles }, { explicitStyle = false, namespaceAttributes = '' } = {}) {
  // namespaceAttributes：替换的原单元格自身声明的命名空间（xmlns:m="…"），沿用其前缀时一并保留
  const tag = `${prefix}c${namespaceAttributes}`;
  if (entry.kind === 'date') {
    const style = dateStyles.styleIndexFor(styleIndex);
    return `<${tag} r="${reference}" s="${style}"><${prefix}v>${isoDateToSerial(entry.value, date1904)}</${prefix}v></${prefix}c>`;
  }
  const validStyle = Number.isSafeInteger(styleIndex) && styleIndex >= 0;
  const styleAttribute = validStyle && (styleIndex > 0 || explicitStyle) ? ` s="${styleIndex}"` : '';
  const value = entry.value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<${tag} r="${reference}"${styleAttribute}><${prefix}v>${String(value)}</${prefix}v></${prefix}c>`;
  }
  if (typeof value === 'boolean') {
    return `<${tag} r="${reference}"${styleAttribute} t="b"><${prefix}v>${value ? 1 : 0}</${prefix}v></${prefix}c>`;
  }
  const text = value === null || value === undefined ? '' : String(value);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<${tag} r="${reference}"${styleAttribute} t="inlineStr"><${prefix}is><${prefix}t${space}>${encodeSpreadsheetText(text)}</${prefix}t></${prefix}is></${prefix}c>`;
}

// 列样式（<cols><col min max style>，列号从 1 起）：单元格没有自身样式时按「行样式（customFormat）→ 列样式」继承
//   （与 readers.js 核对数字格式的口径一致）。返回 column（0 起）→ 样式下标，没有时为 null
function parseColumnStyles(sheetXml) {
  const body = (/<(?:[\w.-]+:)?cols\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cols>/.exec(sheetXml) || [])[1] || '';
  const columns = (body.match(/<(?:[\w.-]+:)?col\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) || [])
    .map((tag) => ({
      min: Number(readAttribute(tag, 'min')),
      max: Number(readAttribute(tag, 'max')),
      style: Number(readAttribute(tag, 'style'))
    }))
    .filter((item) => Number.isSafeInteger(item.min) && Number.isSafeInteger(item.max) && Number.isSafeInteger(item.style));
  return (column) => {
    const hit = columns.find((item) => column + 1 >= item.min && column + 1 <= item.max);
    return hit ? hit.style : null;
  };
}

// 字符串项（内联字符串 <is> 或共享字符串 <si>）的文本：各 <t> 先取 XML 字符数据（CDATA 取原样内容、其余解码实体，注释不算；
//   第三十三轮审查）、再按 ST_Xstring 解码（_x000D_ 等）后拼接，注音（<rPh>）不计；元素在遮盖注释、CDATA 后的视图中定位。
//   文本无法解码时返回 null（按已有值处理，不覆盖）
function stringItemText(xml) {
  const source = String(xml || '');
  const masked = maskXmlMarkup(source).replace(/<((?:[\w.-]+:)?)rPh\b[\s\S]*?<\/\1rPh>/g, (text) => ' '.repeat(text.length));
  const texts = [];
  const pattern = /<(?:[\w.-]+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?t>)/gd;
  let match;
  try {
    while ((match = pattern.exec(masked))) {
      const raw = match.indices[1] ? source.slice(match.indices[1][0], match.indices[1][1]) : '';
      texts.push(decodeExcelStXstring(xmlCharacterData(raw)));
    }
  } catch (_error) {
    return null;
  }
  return texts.join('');
}

// 共享字符串表各项的文本：只按实际生效的 <si> 建立下标（注释中的旧条目不算，与读取侧同一枚举，第三十五轮审查）
function parseSharedStrings(xml) {
  return sharedStringItemSources(xml).map((item) => stringItemText(item));
}

// 待回填的原单元格是否已有值：回填只填读取时为空的单元格，原文已有值说明写出位置与读取时对不上（不覆盖，整份拒绝）。
//   与读取时判断空单元格同口径：文本去首尾空白后为空的视为空；数值、布尔、错误值等有 <v> 即有值
//   子元素的命名空间前缀可与单元格不同（按任意前缀识别，结束标签与开始标签同前缀）
//   子元素在遮盖注释、CDATA 后的视图中定位，<v> 的值取 XML 字符数据（CDATA 取原样内容，注释不算，第三十四轮审查）
function existingCellHasValue(cell, sharedTextOf) {
  const type = readAttribute(cell.attributes, 't') || 'n';
  const source = String(cell.inner || '');
  const masked = maskXmlMarkup(source);
  const contentOf = (match) => (match && match.indices[2] ? source.slice(match.indices[2][0], match.indices[2][1]) : '');
  if (type === 'inlineStr') {
    const inline = /<((?:[\w.-]+:)?)is\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1is>)/d.exec(masked);
    if (!inline) return false;
    const text = stringItemText(contentOf(inline));
    return text === null || text.trim() !== '';
  }
  const valueMatch = /<((?:[\w.-]+:)?)v\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1v>)/d.exec(masked);
  const raw = xmlCharacterData(contentOf(valueMatch));
  if (type === 's') {
    if (!raw.trim()) return false;
    const text = sharedTextOf(Number(raw.trim()));
    return text === undefined || text === null || text.trim() !== '';
  }
  if (type === 'str') {
    // 公式文本结果同样按 Excel 转义 `_xHHHH_` 解码后判断（`_x000D_` 读成回车，视为空）；解码失败时按有值处理，不覆盖
    let text;
    try {
      text = decodeExcelStXstring(raw);
    } catch (_error) {
      return true;
    }
    return text.trim() !== '';
  }
  return raw.trim() !== '';
}

// 改写一行：已有单元格按列替换（含公式或已有值的单元格拒绝改写），没有的按列序插入；行内单元格缺少 r 时补上（插入后其后单元格的隐含列号不变）。
//   写入的单元格以其有效样式为底：自身样式，没有时继承行样式（customFormat）、再继承列样式（inheritedStyleOf）
//   单元格可用与行不同的命名空间前缀（如默认命名空间的 <row> 中写 <m:c>）：按任意前缀识别并按列替换，替换时沿用原单元格的前缀
//   与其自身的命名空间声明；新插入的单元格用行的前缀（prefix）
// maskedContent：遮盖了注释、CDATA 与处理指令的同长视图（缺省为原文），单元格边界在其上定位，单元格内容取原文
function patchRowContent({
  prefix, rowNumber, content, maskedContent = content, cellPlan, context, inheritedStyleOf = () => 0, sharedTextOf = () => undefined
}) {
  const cellPattern = /<((?:[\w.-]+:)?)c\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g;
  const cells = [];
  let previousColumn = -1;
  let match;
  let lastIndex = 0;
  const between = [];
  while ((match = cellPattern.exec(maskedContent))) {
    // 单元格之间的注释、处理指令在遮盖视图中是空白，与空白一样不保留
    between.push(maskedContent.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const reference = readAttribute(match[2], 'r');
    const column = reference ? columnIndexOfReference(reference) : previousColumn + 1;
    if (column < 0) throw writeError(`第 ${rowNumber} 行有无法识别的单元格`);
    previousColumn = column;
    const xml = content.slice(match.index, lastIndex);
    const innerEnd = lastIndex - `</${match[1]}c>`.length;
    cells.push({
      column,
      prefix: match[1],
      attributes: match[2],
      inner: match[3] === undefined ? '' : content.slice(innerEnd - match[3].length, innerEnd),
      xml,
      hasReference: Boolean(reference)
    });
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
      output.push(buildCellXml(prefix, `${columnName(column)}${rowNumber}`, inheritedStyleOf(column), entry, context));
      pendingIndex += 1;
    }
  };
  cells.forEach((cell) => {
    emitPending(cell.column);
    const reference = `${columnName(cell.column)}${rowNumber}`;
    if (pendingIndex < pending.length && pending[pendingIndex][0] === cell.column) {
      if (/<(?:[\w.-]+:)?f\b/.test(maskXmlMarkup(cell.inner))) {
        throw writeError(`单元格 ${reference} 含公式，未改写`);
      }
      if (existingCellHasValue(cell, sharedTextOf)) {
        throw writeError(`单元格 ${reference} 已有值，与回填时读到的空单元格对不上，未改写`);
      }
      const ownStyle = readAttribute(cell.attributes, 's');
      const styleIndex = ownStyle === null ? inheritedStyleOf(cell.column) : Number(ownStyle);
      const namespaceAttributes = (cell.attributes.match(/\sxmlns(?::[\w.-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/g) || []).join('');
      output.push(buildCellXml(cell.prefix, reference, Number.isSafeInteger(styleIndex) ? styleIndex : 0, pending[pendingIndex][1], context, {
        explicitStyle: ownStyle !== null && Number.isSafeInteger(styleIndex),
        namespaceAttributes
      }));
      pendingIndex += 1;
      return;
    }
    output.push(cell.hasReference ? cell.xml : cell.xml.replace(/^<(?:[\w.-]+:)?c\b/, (open) => `${open} r="${reference}"`));
  });
  emitPending(Number.POSITIVE_INFINITY);
  return output.join('') + tail;
}

// 定位元素在遮盖了注释、CDATA 与处理指令的视图上进行（与读取侧一致：注释中的旧 sheetData、旧行不算），改写按同一坐标作用于原文
function patchWorksheetXml(sheetXml, plan, context) {
  const masked = maskXmlMarkup(sheetXml);
  const sheetDataMatch = /<((?:[\w.-]+:)?)sheetData\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/>|>)/.exec(masked);
  if (!sheetDataMatch || sheetDataMatch[2] === '/>') throw writeError('原始账单的主表没有数据');
  const prefix = sheetDataMatch[1];
  const start = sheetDataMatch.index + sheetDataMatch[0].length;
  const end = masked.indexOf(`</${prefix}sheetData>`, start);
  if (end < 0) throw writeError('原始账单的主表结构无法识别');
  const content = sheetXml.slice(start, end);
  const maskedContent = masked.slice(start, end);
  // 行与单元格可用与 sheetData 不同的命名空间前缀（同一命名空间可绑定不同前缀）：按任意前缀识别，结束标签与开始标签同前缀
  const rowPattern = /<((?:[\w.-]+:)?)row\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/\1row>)/g;
  const columnStyleOf = parseColumnStyles(masked);
  const remaining = new Set(plan.keys());
  // 行号：有 r 取 r，没有时为前一行加 1。读取库遇到自闭合的空行（<row/>、<row r="2"/>）不推进行号，其后省略 r 的行
  //   在两种算法下行号不同——读取时的行号与写出位置无法确认对应，整份拒绝，不按任一种猜测写入
  let previousRow = 0;
  let previousReaderRow = 0;
  let patched = '';
  let cursor = 0;
  let rowMatch;
  const patchRow = (rowXml, rowPrefix, attributes, inner, maskedInner) => {
    const declared = Number(readAttribute(attributes, 'r'));
    const hasDeclared = Number.isSafeInteger(declared) && declared > 0;
    const rowNumber = hasDeclared ? declared : previousRow + 1;
    previousRow = rowNumber;
    if (inner === undefined) return rowXml;
    const readerRow = hasDeclared ? declared : previousReaderRow + 1;
    previousReaderRow = readerRow;
    if (readerRow !== rowNumber) {
      throw writeError(`原始账单主表第 ${rowNumber} 行省略了行号且前面有空行标记，无法与读取结果核对行号`);
    }
    const cellPlan = plan.get(rowNumber);
    if (!cellPlan) return rowXml;
    remaining.delete(rowNumber);
    // spans 只是列范围提示，插入单元格后可能不准，去掉
    const rowAttributes = setAttribute(removeAttribute(attributes, 'spans'), 'r', String(rowNumber));
    const rowStyle = /^(?:1|true)$/i.test(readAttribute(attributes, 'customFormat') || '') ? Number(readAttribute(attributes, 's')) : NaN;
    const inheritedStyleOf = (column) => {
      if (Number.isSafeInteger(rowStyle)) return rowStyle;
      const columnStyle = columnStyleOf(column);
      return Number.isSafeInteger(columnStyle) ? columnStyle : 0;
    };
    return `<${rowPrefix}row${rowAttributes}>${patchRowContent({
      prefix: rowPrefix, rowNumber, content: inner, maskedContent: maskedInner, cellPlan, context, inheritedStyleOf, sharedTextOf: context.sharedTextOf
    })}</${rowPrefix}row>`;
  };
  while ((rowMatch = rowPattern.exec(maskedContent))) {
    const rowStart = rowMatch.index;
    const rowEnd = rowStart + rowMatch[0].length;
    const maskedInner = rowMatch[3];
    // 行内容在原文中的位置：结束标签之前、长度与遮盖视图相同（属性中不会出现注释，遮盖前后一致）
    const innerEnd = rowEnd - `</${rowMatch[1]}row>`.length;
    const inner = maskedInner === undefined ? undefined : content.slice(innerEnd - maskedInner.length, innerEnd);
    patched += content.slice(cursor, rowStart) + patchRow(content.slice(rowStart, rowEnd), rowMatch[1], rowMatch[2], inner, maskedInner);
    cursor = rowEnd;
  }
  patched += content.slice(cursor);
  if (remaining.size) {
    throw writeError(`原始账单主表中找不到第 ${Array.from(remaining).sort((a, b) => a - b).join('、')} 行`);
  }
  return sheetXml.slice(0, start) + patched + sheetXml.slice(end);
}

async function writePatchedXlsx({ sourceBuffer, plan, mainSheetName, dateFormat }) {
  const zip = await JSZip.loadAsync(sourceBuffer);
  const main = await locateMainWorksheet(zip);
  if (mainSheetName && main.sheetName !== mainSheetName) {
    throw writeError(`原始账单的第一个 Sheet 已不是「${mainSheetName}」`);
  }
  const hasDate = Array.from(plan.values()).some((row) => Array.from(row.values()).some((entry) => entry.kind === 'date'));
  const sheetXml = await readZipText(zip, main.sheetPath, '主表');
  const styles = hasDate ? await ensureStylesPart(zip, main) : null;
  const dateStyles = styles ? createDateStyleRegistry(styles.stylesXml, dateFormat) : { styleIndexFor: () => 0, toXml: () => null };
  const sharedStrings = main.sharedStringsPath && zip.file(main.sharedStringsPath)
    ? parseSharedStrings(await zip.file(main.sharedStringsPath).async('string'))
    : [];
  const patchedSheet = patchWorksheetXml(sheetXml, plan, {
    date1904: main.date1904,
    dateStyles,
    sharedTextOf: (index) => (Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] : undefined)
  });
  zip.file(main.sheetPath, patchedSheet);
  const patchedStyles = dateStyles.toXml();
  if (patchedStyles) zip.file(styles.stylesPath, patchedStyles);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// 非 xlsx 原始账单转成 xlsx：只保留值与数字格式——所有工作表的公式都去掉，保留读取到的结果值（重算不会改变）
function freezeFormulas(workbook) {
  (workbook.SheetNames || []).forEach((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return;
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const cell = sheet[address];
      if (cell && (cell.f !== undefined || cell.F !== undefined)) {
        delete cell.f;
        delete cell.F;
      }
    });
  });
}

// ZIP 中的 SpreadsheetML 工作簿（启用宏、模板等）：读取库把原文为 ISO 文本的日期单元格（t="d"）一律按 1900 日期系统换算
//   （且带本机时区偏差），工作簿声明 1904 时写出后会偏移四年。按原文与工作簿日期系统重新换算所有工作表的这类单元格，
//   与导入时读到的账单一致（readers.js isoTextToSerial）；原文日期不存在时保留原文文本，写法无法识别时保持读取库的值
//   没有缓存结果的公式（读取库把其中的布尔公式读成 false）按空值写出，不冻结成读取库给出的值
function restoreFromSheetXml(workbook, date1904) {
  if (!workbook.files) return;
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    const scanned = scanXlsxSheetCells(null, workbook, sheetName, { isoDates: true, formulas: true, date1904 });
    scanned.formulaCells.forEach(({ r, c, cached }) => {
      if (!cached) delete sheet[XLSX.utils.encode_cell({ r, c })];
    });
    scanned.isoDateCells.forEach(({ r, c, text, serial }) => {
      const reference = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[reference];
      // 公式单元格同样换算其缓存结果（随后 freezeFormulas 冻结为值）
      if (!cell || serial === null) return;
      if (Number.isFinite(serial)) {
        sheet[reference] = { ...cell, t: 'n', v: serial };
      } else {
        sheet[reference] = { t: 's', v: text };
      }
      delete sheet[reference].w;
    });
  });
}

// 转换写出只保留工作表、日期系统，以及每个单元格的值、类型与数字格式：新建输出工作簿逐项复制（不复用原工作簿对象，
//   超链接、批注、富文本、定义名称中的外部引用等一律不带出，避免把外部地址或原文件路径带入留档）。XLSX.write 不对字面的
//   `_xHHHH_` 片段转义，读回时会被解码成别的字符：文本按 ST_Xstring 编码后写出（与原位改写分支同一编码），未改动的单元格
//   与补丁都能原样往返
//   ODS 的工作表键是表名属性的原文（读取库不解码字符引用，Cash & Bank 的键是 Cash &amp; Bank）：decodeNames 时按实际表名
//   （解码一次）写出，读取键只用于取表（第二十八轮）
function buildOutputWorkbook(workbook, date1904, { decodeNames = false } = {}) {
  const output = { SheetNames: [], Sheets: {}, Workbook: { WBProps: { date1904: Boolean(date1904) } } };
  (workbook.SheetNames || []).forEach((name) => {
    const sheet = workbook.Sheets[name] || {};
    const rebuiltSheet = {};
    if (sheet['!ref']) rebuiltSheet['!ref'] = sheet['!ref'];
    Object.keys(sheet).forEach((address) => {
      if (address[0] === '!') return;
      const cell = sheet[address];
      if (!cell || cell.t === 'z') return;
      const rebuilt = { t: cell.t, v: cell.t === 's' && typeof cell.v === 'string' ? encodeExcelStXstring(cell.v) : cell.v };
      if (cell.z !== undefined) rebuilt.z = cell.z;
      rebuiltSheet[address] = rebuilt;
    });
    const outputName = decodeNames ? decodeXmlAttributeValue(name) : name;
    if (Object.prototype.hasOwnProperty.call(output.Sheets, outputName)) {
      throw writeError(`原始账单中有两张工作表的实际表名都是「${outputName}」，无法转换`);
    }
    output.SheetNames.push(outputName);
    output.Sheets[outputName] = rebuiltSheet;
  });
  return output;
}

// 读取库读到的值是否非空（不含只有空白的文本，与原位改写分支 existingCellHasValue 同口径）
function convertedCellHasValue(cell) {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return false;
  return typeof cell.v === 'string' ? cell.v.trim() !== '' : true;
}

// Excel 错误值的内部编码（与读取库一致）；其他写法（如 LibreOffice 的 Err:502）按 #N/A（不可用值）写出
const EXCEL_ERROR_CODES = Object.freeze({
  '#NULL!': 0x00, '#DIV/0!': 0x07, '#VALUE!': 0x0F, '#REF!': 0x17, '#NAME?': 0x1D, '#NUM!': 0x24, '#N/A': 0x2A
});

function excelErrorCodeOf(text) {
  const key = String(text || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(EXCEL_ERROR_CODES, key) ? EXCEL_ERROR_CODES[key] : EXCEL_ERROR_CODES['#N/A'];
}

// 转换写出的表名按 ST_Xstring 编码写入 workbook.xml：读取库写出表名时不转义，字面的 `_xHHHH_` 读回会被解码成别的字符
//   （Ref_x0041_ 读回成 RefA，与另一张 RefA 同名，按名称只能取到其中一张）。只改需要转义的表名，其余部件不动
async function encodeConvertedSheetNames(buffer, sheetNames) {
  const encoded = sheetNames.map((name) => {
    try {
      return encodeExcelStXstring(name);
    } catch (_error) {
      return name;
    }
  });
  if (encoded.every((name, index) => name === sheetNames[index])) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await readZipText(zip, 'xl/workbook.xml', '转换后的工作簿');
  let index = 0;
  const next = workbookXml.replace(xmlStartTagPattern('sheet'), (tag, attributes) => {
    const name = encoded[index];
    index += 1;
    if (name === undefined) return tag;
    return `${tag.slice(0, tag.length - attributes.length - 1)}${setAttribute(attributes, 'name', name)}>`;
  });
  if (index !== sheetNames.length) throw writeError('转换后的工作簿表名无法核对');
  zip.file('xl/workbook.xml', next);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

async function writeConvertedWorkbook({ sourceBuffer, plan, mainSheetName, dateFormat }) {
  const isZip = isZipBuffer(sourceBuffer);
  const isTextContainer = !isZip && !isOle2Buffer(sourceBuffer);
  // ODS 的日期系统取其声明的日期基准（table:null-date，读取库不识别），与读取侧一致（readers.js loadOdsContent）；
  //   平面 OpenDocument（FODS，文本容器）同样如此
  const odsContent = isZip || isTextContainer ? loadOdsContent(sourceBuffer) : null;
  // 只有样式、没有值的单元格（<c r="B2" s="1"/>、BIFF 的 BLANK）：读取库只在保留占位单元格（sheetStubs）时带出其数字格式。
  //   xlsx 系（含 xlsm、xlsb）与 OLE2 二进制工作簿按文件中实际存在的单元格保留占位；ODS 的重复空单元格会展开成大量占位，
  //   文本格式不带数字格式，都不保留
  const keepStubs = (isZip && !odsContent) || isOle2Buffer(sourceBuffer);
  // SpreadsheetML 自闭合的合并单元格、ODS 覆盖格的重复计数与自闭合的行、xlsx 系共享字符串表的注释与自闭合空条目按读取侧同一
  //   改写（readers.js normalizeXlmlWorkbookBuffer、odsWorkbookBuffer、normalizeXlsxSharedStringsBuffer），坐标与文本与导入时一致
  const workbook = XLSX.read((odsContent && odsWorkbookBuffer(odsContent))
    || (isTextContainer && !odsContent && normalizeXlmlWorkbookBuffer(sourceBuffer))
    || (isZip && !odsContent && normalizeXlsxSharedStringsBuffer(sourceBuffer)) || sourceBuffer, {
    type: 'buffer', cellDates: false, cellNF: true, raw: false, ...(keepStubs ? { sheetStubs: true } : {}), ...(isZip ? { bookFiles: true } : {})
  });
  const sheetName = workbook.SheetNames[0];
  if (mainSheetName && sheetName !== mainSheetName) {
    throw writeError(`原始账单的第一个 Sheet 已不是「${mainSheetName}」`);
  }
  const sheet = workbook.Sheets[sheetName];
  // 记下主表占位单元格的数字格式，供回填的值沿用（如格式 000000 的空格子回填 123 显示 000123），随后去掉全部占位单元格，
  //   其余处理与不保留占位时一致
  const stubFormats = new Map();
  workbook.SheetNames.forEach((name) => {
    const target = workbook.Sheets[name];
    if (!target) return;
    Object.keys(target).forEach((address) => {
      const cell = target[address];
      if (address[0] === '!' || !cell || cell.t !== 'z' || cell.f) return;
      if (target === sheet && cell.z) stubFormats.set(address, cell.z);
      delete target[address];
    });
  });
  if (odsContent && !odsContent.dateSystem) {
    throw writeError('ODS 文件声明的日期基准不是 1899-12-30 或 1904-01-01（或其命名空间无法确定），无法确定日期');
  }
  // ZIP 中的 SpreadsheetML（xlsm 等）按 workbook.xml 中实际生效的 workbookPr（与导入侧同一判断，readers.js xlsxWorkbookDate1904）；
  //   没有工作簿原文（xlsb 等二进制工作簿）时沿用读取库
  const workbookXml = isZip && !odsContent ? xlsxWorkbookXmlOf(workbook) : null;
  const ownDate1904 = workbookXml ? xlsxWorkbookDate1904(workbookXml) : null;
  // 工作簿声明了无法识别的日期系统（与导入侧同样拒绝，不沿用读取库的判断）
  if (workbookXml && ownDate1904 === null && xlsxWorkbookRootInfo(workbookXml)) {
    throw writeError('原始账单的工作簿日期系统无法识别，无法确定日期');
  }
  let date1904 = Boolean(workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904);
  if (odsContent) date1904 = odsContent.dateSystem === '1904';
  else if (ownDate1904 !== null) date1904 = ownDate1904;
  // 文本容器（如 SpreadsheetML 2003 的 .xls）的 DateTime 单元格以 ISO 文本存储，读取库一律换算成 1900 序号，同表的数值日期却是
  //   工作簿日期系统的序号；ODS 的日期单元格读取库按本机时区换算（西半球时区早一天）：所有工作表的这类单元格按原文与工作簿日期
  //   系统重新换算，保留原工作簿的日期系统，未改动的数值日期与补丁同一口径（与读取侧 readers.js 一致）。原文是不存在的日期
  //   （如 2026-02-30）时保留原文文本，不写成读取库滚入下月的日期；原文写法无法换算的，SpreadsheetML 按读取库的值平移到
  //   工作簿日期系统，ODS 保持读取库的值
  //   ODS 的公式错误（LibreOffice 写成文本加 calcext:value-type="error"，读取库读成 #DIV/0! 等文本）按错误值写出，与导入时
  //   「不可用值」的处理一致，下游按错误值判断（ISERROR）的结果与原表相同
  const exactDateSheets = odsContent
    ? scanOdsWorkbookCells(odsContent, { isoDates: true, formulas: true, date1904 })
    : (isTextContainer ? scanXlmlWorkbookCells(sourceBuffer, { isoDates: true, date1904 }) : new Map());
  exactDateSheets.forEach((scannedCells, name) => {
    const { isoDateCells, errorCells = [] } = scannedCells;
    const target = workbook.Sheets[name];
    if (!target) return;
    // ODS 自闭合单元格（日期、数值等只写在属性上）读取库读成空：与读取侧同样补回（日期带读取库给 ODS 日期的格式 m/d/yy），
    //   不在留档文件中丢失银行原值
    if (odsContent) restoreOdsSelfClosingCells(target, scannedCells, { dateFormat: 'm/d/yy' });
    // 按扫描出的物理坐标写入（读取库不把表尾自闭合的单元格计入 !ref：只有公式错误的末行会在留档中丢失），并扩展该表的范围
    errorCells.forEach(({ r, c, text }) => {
      target[XLSX.utils.encode_cell({ r, c })] = { t: 'e', v: excelErrorCodeOf(text) };
      const range = target['!ref'] ? XLSX.utils.decode_range(target['!ref']) : { s: { r, c }, e: { r, c } };
      range.s.r = Math.min(range.s.r, r);
      range.s.c = Math.min(range.s.c, c);
      range.e.r = Math.max(range.e.r, r);
      range.e.c = Math.max(range.e.c, c);
      target['!ref'] = XLSX.utils.encode_range(range);
    });
    isoDateCells.forEach(({ r, c, text, serial }) => {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = target[address];
      if (!cell) return;
      // 读取库读成文本的日期（SpreadsheetML 带时区偏移的 DateTime 读成原文末尾加 Z）同样按原文换算（与读取侧一致，第三十一轮审查）
      if (typeof cell.v !== 'number') {
        if (Number.isFinite(serial)) {
          cell.t = 'n';
          cell.v = serial;
          delete cell.w;
        } else if (Number.isNaN(serial)) {
          target[address] = { t: 's', v: text };
        }
        return;
      }
      if (Number.isFinite(serial)) cell.v = serial;
      else if (Number.isNaN(serial) || !Number.isFinite(cell.v)) target[address] = { t: 's', v: text };
      else if (date1904 && isTextContainer && !odsContent) cell.v -= EXCEL_1904_DAY_OFFSET;
    });
  });
  if (isZip) {
    restoreFromSheetXml(workbook, date1904);
    delete workbook.files;
    delete workbook.keys;
  }
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  // 与原位改写分支同样核对补丁坐标：目标行须在原表中存在（有内容），目标格须为空，否则不写出这份留档文件
  const rowsWithContent = new Set();
  Object.keys(sheet).forEach((address) => {
    if (address[0] === '!' || !convertedCellHasValue(sheet[address])) return;
    rowsWithContent.add(XLSX.utils.decode_cell(address).r);
  });
  plan.forEach((cells, rowNumber) => {
    if (!rowsWithContent.has(rowNumber - 1)) {
      throw writeError(`原始账单主表第 ${rowNumber} 行不存在或为空，与回填时读到的行对不上，未改写`);
    }
    cells.forEach((entry, column) => {
      const reference = XLSX.utils.encode_cell({ r: rowNumber - 1, c: column });
      const existing = sheet[reference];
      if (existing && existing.f) throw writeError(`单元格 ${reference} 含公式，未改写`);
      if (convertedCellHasValue(existing)) {
        throw writeError(`单元格 ${reference} 已有值，与回填时读到的空单元格对不上，未改写`);
      }
      if (entry.kind === 'date') {
        sheet[reference] = { t: 'n', v: isoDateToSerial(entry.value, date1904), z: dateFormat };
      } else {
        // 非日期补丁不分值类型沿用目标格原有的数字格式（如文本格式 0;0;0;"Order: "@ 回填 123 后仍显示 Order: 123）
        const format = existing && existing.z ? existing.z : stubFormats.get(reference);
        const keptFormat = format ? { z: format } : {};
        if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
          sheet[reference] = { t: 'n', v: entry.value, ...keptFormat };
        } else if (typeof entry.value === 'boolean') {
          sheet[reference] = { t: 'b', v: entry.value, ...keptFormat };
        } else {
          sheet[reference] = { t: 's', v: entry.value === null || entry.value === undefined ? '' : String(entry.value), ...keptFormat };
        }
      }
      range.s.r = Math.min(range.s.r, rowNumber - 1);
      range.e.r = Math.max(range.e.r, rowNumber - 1);
      range.s.c = Math.min(range.s.c, column);
      range.e.c = Math.max(range.e.c, column);
    });
  });
  sheet['!ref'] = XLSX.utils.encode_range(range);
  freezeFormulas(workbook);
  const output = buildOutputWorkbook(workbook, date1904, { decodeNames: Boolean(odsContent) });
  return encodeConvertedSheetNames(XLSX.write(output, { type: 'buffer', bookType: 'xlsx' }), output.SheetNames);
}

function isZipBuffer(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function isOle2Buffer(buffer) {
  return buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
}

// ZIP 不是 xlsx 独有的容器（xlsb、ods、xlsm 同样是 ZIP）：只有工作簿部件是普通 xlsx 工作簿内容类型的才按 xlsx 原位改写，
//   其他可读的工作簿走转换分支（与读取一致，读取库按内容识别格式）
async function isSpreadsheetMlPackage(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (_error) {
    return false;
  }
  const rootRelationshipsEntry = zip.file('_rels/.rels');
  const contentTypesEntry = zip.file('[Content_Types].xml');
  if (!rootRelationshipsEntry || !contentTypesEntry) return false;
  // 根关系只认生效的元素（注释中的旧关系按 Excel 忽略：读取库不按根关系定位工作簿，原位改写也不经读取库）；编号重复时无法确认，
  //   拒绝写出，不把它当成「不是 xlsx」降级为转换（会丢掉公式等部件）
  const rootRelationships = parseXlsxRelationships(await rootRelationshipsEntry.async('string'));
  if (!rootRelationships) throw writeError('原始账单的根关系编号重复，无法确认工作簿');
  const officeDocument = Array.from(rootRelationships.values()).find((item) => /\/officeDocument$/.test(item.type));
  if (!officeDocument) return false;
  const workbookPath = resolvePartPath('', officeDocument.target);
  // 内容类型只认生效的声明（注释中的旧 Override / Default 不算，与 Excel 一致）
  const contentTypesXml = maskXmlMarkup(await contentTypesEntry.async('string'));
  const overridePattern = /<(?:[\w.-]+:)?Override\b([^>]*?)\/?>/g;
  let contentType = null;
  let match;
  while ((match = overridePattern.exec(contentTypesXml))) {
    if (String(readAttribute(match[1], 'PartName') || '').replace(/^\/+/, '').toLowerCase() === workbookPath.toLowerCase()) {
      contentType = readAttribute(match[1], 'ContentType');
      break;
    }
  }
  if (contentType === null) {
    const extension = path.posix.extname(workbookPath).slice(1).toLowerCase();
    const defaultPattern = /<(?:[\w.-]+:)?Default\b([^>]*?)\/?>/g;
    while ((match = defaultPattern.exec(contentTypesXml))) {
      if (String(readAttribute(match[1], 'Extension') || '').toLowerCase() === extension) {
        contentType = readAttribute(match[1], 'ContentType');
        break;
      }
    }
  }
  // 只认普通 xlsx 工作簿：启用宏（xlsm）、模板（xltx / xltm）的内容类型写成 .xlsx 后与扩展名不符，Excel 可能拒绝打开，走转换分支
  return /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml$/i.test(String(contentType || '').trim());
}

// 不覆盖地发布：硬链接到目标路径（目标已存在时原子地失败）；文件系统不支持硬链接时改为独占打开目标文件再写入。
//   目标已存在时拒绝写出，保留已有文件。写入失败只清理确认由本次创建、且路径仍指向它的文件（取得句柄后按设备号与
//   inode 核对），打开失败或路径已被替换时不按路径删除，避免删到他人的文件。
function publishWithoutReplace(temporaryPath, outputFilePath, buffer, fsImpl = fs) {
  try {
    fsImpl.linkSync(temporaryPath, outputFilePath);
    return;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw writeError(`目标文件已存在，未覆盖：${path.basename(outputFilePath)}`);
    }
  }
  let fd;
  try {
    fd = fsImpl.openSync(outputFilePath, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw writeError(`目标文件已存在，未覆盖：${path.basename(outputFilePath)}`);
    }
    throw error;
  }
  try {
    let offset = 0;
    while (offset < buffer.length) {
      offset += fsImpl.writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsImpl.fsyncSync(fd);
  } catch (error) {
    // 按路径删除无法保证删的是本次创建的文件（检查与删除之间可能被替换）：只通过本次持有的句柄清空其内容，并报告需要
    //   手动删除的路径，不按名称删除
    let cleared = false;
    try {
      fsImpl.ftruncateSync(fd, 0);
      cleared = true;
    } catch (_ignored) { /* 清空失败不掩盖原错误 */ }
    throw writeError(`回填文件写出失败（${error && error.message ? error.message : error}），`
      + `未完成的文件${cleared ? '已清空' : ''}，请手动删除：${outputFilePath}`);
  } finally {
    try { fsImpl.closeSync(fd); } catch (_ignored) { /* 关闭失败不掩盖原错误 */ }
  }
}

// 写出回填后的原始账单；返回 { converted（非 xlsx 转换）, cellCount, sha256, size（写出内容的摘要，存档结算核对用）}。sourceBuffer 为调用方已核对指纹的原文件内容
//   （核对与写出用同一份字节）；先写临时文件再不覆盖地发布，失败时不留半成品。
async function writeCrossSheetBackfillWorkbook({ sourceFilePath, sourceBuffer = null, outputFilePath, patches, source = {} }) {
  const plan = buildCellPlan(patches, source.columnOffset);
  if (!plan.size) throw writeError('没有需要写出的回填单元格');
  const dateFormat = resolveCrossSheetBackfillDateFormat(source.dateParseOrder);
  const original = Buffer.isBuffer(sourceBuffer) ? sourceBuffer : fs.readFileSync(sourceFilePath);
  const converted = !(isZipBuffer(original) && await isSpreadsheetMlPackage(original));
  const buffer = converted
    ? await writeConvertedWorkbook({ sourceBuffer: original, plan, mainSheetName: source.mainSheetName, dateFormat })
    : await writePatchedXlsx({ sourceBuffer: original, plan, mainSheetName: source.mainSheetName, dateFormat });
  // 临时名长度与原文件名无关（长文件名账单的「原名 + 后缀」可能超过文件名上限）
  const temporaryPath = path.join(
    path.dirname(outputFilePath),
    `.backfill-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  // 独占创建成功后才取得清理权；删除前确认路径仍指向本次创建的文件（临时名已被占用时不删除他人的文件）
  let created = null;
  try {
    const fd = fs.openSync(temporaryPath, 'wx');
    try {
      created = fs.fstatSync(fd);
      let offset = 0;
      while (offset < buffer.length) {
        offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
      }
    } finally {
      fs.closeSync(fd);
    }
    publishWithoutReplace(temporaryPath, outputFilePath, buffer);
  } finally {
    if (created) {
      try {
        const current = fs.lstatSync(temporaryPath);
        if (current.isFile() && current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(temporaryPath);
      } catch (_ignored) { /* 清理失败不掩盖原错误 */ }
    }
  }
  const cellCount = Array.from(plan.values()).reduce((sum, row) => sum + row.size, 0);
  const fingerprint = computeBufferFingerprint(buffer);
  return { converted, cellCount, sha256: fingerprint.sha256, size: fingerprint.size };
}

module.exports = {
  CROSS_SHEET_BACKFILL_OUTPUT_SUFFIX,
  publishWithoutReplace,
  allocateCrossSheetBackfillOutputPaths,
  buildCrossSheetBackfillOutputBaseName,
  computeBufferFingerprint,
  computeFileFingerprint,
  readFingerprintedFile,
  isoDateToSerial,
  resolveCrossSheetBackfillDateFormat,
  writeCrossSheetBackfillWorkbook
};
