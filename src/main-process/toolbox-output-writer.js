'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const sax = require('sax');
const {
  openZipWithEntries,
  readEntryAsString
} = require('../backend/big-table-import/zip-reader');
const {
  SPREADSHEETML_NAMESPACES,
  namespaceAllowed,
  saxAttributeValue
} = require('../backend/toolbox-format/ooxml-namespaces');
const {
  ToolboxExcelTextError,
  assertExcelCellTextLength,
  encodeExcelStXstring
} = require('../backend/toolbox-format/excel-text');
const { WATERMARK_AUTHOR } = require('./workbook-watermark');

const MAX_DATA_ROWS_PER_SHEET = 1048575;
const DEFAULT_STYLE_BUDGETS = Object.freeze({
  cellXfs: 50000,
  fonts: 480,
  fills: 240,
  borders: 10000,
  customNumFmts: 180
});
const WARNING_SAMPLE_LIMIT = 20;

class ToolboxOutputValidationError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxOutputValidationError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

function columnName(columnIndex) {
  let value = Number.isInteger(columnIndex) && columnIndex >= 0 ? columnIndex + 1 : 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function sourceCellRef(context = {}) {
  if (context.cellRef) return String(context.cellRef);
  const rowIndex = Number.isInteger(context.rowIndex) ? context.rowIndex : null;
  const columnIndex = Number.isInteger(context.columnIndex) ? context.columnIndex : null;
  return rowIndex && columnIndex !== null
    ? `${columnName(columnIndex)}${rowIndex}`
    : '（未知）';
}

function prepareExcelTextValue(value, context = {}) {
  try {
    const text = assertExcelCellTextLength(value);
    return encodeExcelStXstring(text);
  } catch (error) {
    if (!(error instanceof ToolboxExcelTextError)) throw error;
    throw new ToolboxOutputValidationError(
      '工具箱输出文本超出 Excel 可保真范围',
      [
        error.message,
        `来源：${context.sourceFile || '（未知）'}`,
        `Sheet：${context.sourceSheet || '（未知）'}`,
        `单元格：${sourceCellRef(context)}`
      ]
    );
  }
}

function prepareOutputValue(value, context = {}) {
  if (typeof value === 'string') return prepareExcelTextValue(value, context);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ToolboxOutputValidationError(
      '工具箱输出包含非有限数值',
      [
        `值：${String(value)}`,
        `来源：${context.sourceFile || '（未知）'}`,
        `Sheet：${context.sourceSheet || '（未知）'}`,
        `单元格：${sourceCellRef(context)}`
      ]
    );
  }
  return value;
}

function sanitizeSheetName(name) {
  return String(name || 'COMMON').replace(/[\/\\*?\[\]:]/g, '-').slice(0, 31) || 'COMMON';
}

function createToolboxWarningCollector(limit = WARNING_SAMPLE_LIMIT) {
  let warningCount = 0;
  const warningSamples = [];
  return {
    add(warning) {
      warningCount += 1;
      if (warningSamples.length < limit) {
        warningSamples.push({ ...(warning || {}) });
      }
    },
    summary() {
      return {
        warningCount,
        warningSamples: warningSamples.map((item) => ({ ...item }))
      };
    }
  };
}

function getRegistry(sourceRegistryResolver, sourceRegistryId) {
  if (!sourceRegistryResolver || !sourceRegistryId) return null;
  if (typeof sourceRegistryResolver === 'function') {
    return sourceRegistryResolver(sourceRegistryId) || null;
  }
  if (typeof sourceRegistryResolver.get === 'function') {
    return sourceRegistryResolver.get(sourceRegistryId) || null;
  }
  return sourceRegistryResolver[sourceRegistryId] || null;
}

function resolveSourceStyle(styleRef, sourceRegistryResolver) {
  if (!styleRef || typeof styleRef !== 'object') return Object.freeze({});
  const registry = getRegistry(sourceRegistryResolver, styleRef.sourceRegistryId);
  if (!registry || typeof registry.get !== 'function') {
    throw new ToolboxOutputValidationError(
      '工具箱输出无法解析来源样式',
      [`来源样式注册表：${styleRef.sourceRegistryId || '（空）'}`, `样式引用：${styleRef.styleRef}`]
    );
  }
  const style = registry.get(styleRef.styleRef);
  if (!style) {
    throw new ToolboxOutputValidationError(
      '工具箱输出引用了不存在的来源样式',
      [`来源样式注册表：${styleRef.sourceRegistryId}`, `样式引用：${styleRef.styleRef}`]
    );
  }
  return style;
}

function defaultProjectCell(cell, warningCollector = null) {
  if (!cell || cell.isExplicitCell === false) return { value: null };
  if (Object.prototype.hasOwnProperty.call(cell, 'outputValue')) {
    return {
      value: cell.outputValue,
      ...(cell.outputNumFmt ? { numFmtOverride: cell.outputNumFmt } : {})
    };
  }

  const semantic = cell.decodedSemanticValue;
  if (semantic && typeof semantic === 'object') {
    switch (semantic.kind) {
      case 'blank':
        return { value: null };
      case 'text':
        return { value: String(semantic.value == null ? '' : semantic.value) };
      case 'boolean':
        return { value: !!semantic.value };
      case 'error':
        return { value: { error: String(semantic.code || semantic.value || '#VALUE!') } };
      case 'number': {
        const lexical = String(semantic.lexical == null ? '' : semantic.lexical);
        const numeric = Number(lexical);
        if (Number.isFinite(numeric) && lexical !== '') return { value: numeric };
        return { value: lexical, numFmtOverride: '@' };
      }
      case 'iso-date':
        if (warningCollector) {
          warningCollector.add({
            code: 'toolbox-date-text-fallback',
            sourceFileName: cell.sourceFile ? path.basename(cell.sourceFile) : '',
            sourceSheet: cell.sourceSheet || '',
            cellRef: cell.cellRef || '',
            message: '日期超出安全转换范围，已按文本保留'
          });
        }
        return { value: String(semantic.lexical || ''), numFmtOverride: '@' };
      default:
        break;
    }
  }

  try {
    // 正式统一模型负责十进制、日期系统和长 ID 输出决策。
    // eslint-disable-next-line global-require
    const { projectOutputCell } = require('../backend/toolbox-format/model');
    if (typeof projectOutputCell === 'function') return projectOutputCell(cell, warningCollector);
  } catch (_error) {
    // 增量接线时保留下方兼容投影。
  }

  const type = String(cell.cellType || '');
  if (type === 'b' || type === 'boolean') return { value: cell.decodedSemanticValue === true };
  if (type === 'e' || type === 'error') {
    return { value: { error: String(cell.decodedSemanticValue || cell.rawLexicalValue || '#VALUE!') } };
  }
  if (type === 'blank') return { value: null };
  return {
    value: cell.decodedSemanticValue == null
      ? (cell.rawLexicalValue == null ? '' : cell.rawLexicalValue)
      : cell.decodedSemanticValue
  };
}

function stripNullish(value) {
  if (Array.isArray(value)) return value.map(stripNullish);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined) continue;
    output[key] = stripNullish(child);
  }
  return output;
}

function applyExcelJsStyle(target, style) {
  if (!target || !style || typeof style !== 'object') return;
  if (style.numFmt) target.numFmt = style.numFmt;
  if (style.font && Object.keys(style.font).length > 0) target.font = stripNullish(style.font);
  if (style.fill && Object.keys(style.fill).length > 0) target.fill = stripNullish(style.fill);
  if (style.border && Object.keys(style.border).length > 0) target.border = stripNullish(style.border);
  if (style.alignment && Object.keys(style.alignment).length > 0) {
    target.alignment = stripNullish(style.alignment);
  }
}

function applyRowMetadata(targetRow, sourceRow) {
  if (!targetRow || !sourceRow) return;
  if (Number.isFinite(Number(sourceRow.height)) && Number(sourceRow.height) > 0) {
    targetRow.height = Number(sourceRow.height);
  }
  if (sourceRow.hidden === true) targetRow.hidden = true;
  if (Number.isInteger(Number(sourceRow.outlineLevel)) && Number(sourceRow.outlineLevel) > 0) {
    targetRow.outlineLevel = Number(sourceRow.outlineLevel);
  }
}

function sheetPropertiesFromLayout(layoutBaseline) {
  const meta = layoutBaseline || {};
  const properties = {};
  if (Number.isFinite(Number(meta.defaultColWidth)) && Number(meta.defaultColWidth) > 0) {
    properties.defaultColWidth = Number(meta.defaultColWidth);
  }
  if (Number.isFinite(Number(meta.defaultRowHeight)) && Number(meta.defaultRowHeight) > 0) {
    const defaultRowHeight = Number(meta.defaultRowHeight);
    // ExcelJS 以严格数字 15 判断是否输出 customHeight。来源显式 customHeight=1 且高度恰好
    // 为 15 时传等价字符串，既保持数值又让 OOXML 保留 customHeight 语义。
    properties.defaultRowHeight = meta.customHeight === true && defaultRowHeight === 15
      ? '15'
      : defaultRowHeight;
  }
  return properties;
}

function applySheetLayout(worksheet, layoutBaseline, sourceRegistryResolver) {
  const meta = layoutBaseline || {};

  const ranges = Array.isArray(meta.columnRanges)
    ? meta.columnRanges
    : (Array.isArray(meta.columns) ? meta.columns : []);
  for (const range of ranges) {
    const usesZeroBasedIndexes = Number.isInteger(range && range.minColumnIndex);
    const min = usesZeroBasedIndexes
      ? Math.max(1, Number(range.minColumnIndex) + 1)
      : Math.max(1, Number(range && range.min) || 1);
    const rawMax = usesZeroBasedIndexes
      ? Number(range.maxColumnIndex) + 1
      : (Number(range && range.max) || min);
    const max = Math.min(16384, Math.max(min, rawMax));
    const sourceStyle = range && range.effectiveStyleRef
      ? resolveSourceStyle(range.effectiveStyleRef, sourceRegistryResolver)
      : null;
    for (let columnNumber = min; columnNumber <= max; columnNumber += 1) {
      const column = worksheet.getColumn(columnNumber);
      if (Number.isFinite(Number(range.width)) && Number(range.width) > 0) {
        column.width = Number(range.width);
      } else {
        delete column.width;
      }
      // OOXML 允许范围重叠且后声明覆盖前声明；false/0 也必须能清掉早先范围。
      column.hidden = range.hidden === true;
      column.outlineLevel = Number.isInteger(Number(range.outlineLevel))
        ? Math.max(0, Number(range.outlineLevel))
        : 0;
      if (sourceStyle) applyExcelJsStyle(column, sourceStyle);
    }
  }
}

function createSheetAndHeader({
  writer,
  sheetName,
  normalizedHeaders,
  rawHeaderCells,
  headerRow,
  layoutBaseline,
  sourceRegistryResolver,
  registerOutputStyle
}) {
  const worksheet = writer.addWorksheet(sanitizeSheetName(sheetName), {
    properties: sheetPropertiesFromLayout(layoutBaseline)
  });
  applySheetLayout(worksheet, layoutBaseline, sourceRegistryResolver);

  const outputHeader = worksheet.addRow(normalizedHeaders.slice());
  applyRowMetadata(outputHeader, headerRow);
  const headerRowStyleRef = headerRow && (headerRow.rowStyleRef || headerRow.effectiveStyleRef);
  if (headerRow && headerRow.customFormat && headerRowStyleRef) {
    const sourceStyle = resolveSourceStyle(headerRowStyleRef, sourceRegistryResolver);
    applyExcelJsStyle(outputHeader, registerOutputStyle(sourceStyle, headerRow));
  }
  const headerCellsByColumn = new Map();
  for (let index = 0; index < rawHeaderCells.length; index += 1) {
    const sourceCell = rawHeaderCells[index];
    if (!sourceCell) continue;
    const columnIndex = Number.isInteger(sourceCell.columnIndex) ? sourceCell.columnIndex : index;
    headerCellsByColumn.set(columnIndex, sourceCell);
  }
  for (let index = 0; index < normalizedHeaders.length; index += 1) {
    const sourceCell = headerCellsByColumn.get(index);
    if (!sourceCell || !sourceCell.effectiveStyleRef) continue;
    const sourceStyle = resolveSourceStyle(sourceCell.effectiveStyleRef, sourceRegistryResolver);
    const outputStyle = registerOutputStyle(sourceStyle, sourceCell);
    applyExcelJsStyle(outputHeader.getCell(index + 1), outputStyle);
  }
  outputHeader.commit();
  return worksheet;
}

function createFallbackOutputRegistry(budgets) {
  const styleMap = new Map();
  const componentMaps = {
    fonts: new Map([['{}', 1]]),
    fills: new Map([['{}', 1], ['{"type":"pattern","pattern":"gray125"}', 2]]),
    borders: new Map([['{}', 1]]),
    customNumFmts: new Map()
  };
  const limits = { ...DEFAULT_STYLE_BUDGETS, ...(budgets || {}) };

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  function registerComponent(component, value, context) {
    if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) return;
    const map = componentMaps[component];
    const signature = stable(value);
    if (map.has(signature)) return;
    const projected = map.size + 1;
    if (projected > limits[component]) {
      throw new ToolboxOutputValidationError(
        `工具箱输出样式组件超过安全预算：${component}`,
        [
          `projected count：${projected}`,
          `预算：${limits[component]}`,
          `来源：${context && context.sourceFile ? context.sourceFile : '（未知）'}`,
          `Sheet：${context && context.sourceSheet ? context.sourceSheet : '（未知）'}`,
          `单元格：${context && context.cellRef ? context.cellRef : '（未知）'}`
        ]
      );
    }
    map.set(signature, projected);
  }

  return {
    register(style, context) {
      const signature = stable(style || {});
      if (!styleMap.has(signature)) {
        const projected = styleMap.size + 2; // ExcelJS base/default XF + new effective XF.
        if (projected > limits.cellXfs) {
          throw new ToolboxOutputValidationError(
            '工具箱输出单元格样式超过安全预算：cellXfs',
            [`projected count：${projected}`, `预算：${limits.cellXfs}`]
          );
        }
        registerComponent('fonts', style && style.font, context);
        registerComponent('fills', style && style.fill, context);
        registerComponent('borders', style && style.border, context);
        if (style && style.numFmt && !/^(General|0|0\.00|@|m\/d\/yy|h:mm(?::ss)?(?: AM\/PM)?)$/i.test(style.numFmt)) {
          registerComponent('customNumFmts', style.numFmt, context);
        }
        styleMap.set(signature, Object.freeze({ ...(style || {}) }));
      }
      return { style: styleMap.get(signature) };
    },
    stats() {
      return {
        projectedFinalCounts: {
          cellXfs: styleMap.size + 1,
          fonts: componentMaps.fonts.size,
          fills: componentMaps.fills.size,
          borders: componentMaps.borders.size,
          customNumFmts: componentMaps.customNumFmts.size
        }
      };
    }
  };
}

function loadOutputRegistry(budgets) {
  try {
    // style-registry 是工具箱专用纯 Node 模块；在旧分支或隔离单测中不存在时使用本文件的保守实现。
    // eslint-disable-next-line global-require
    const { OutputStyleRegistry } = require('../backend/toolbox-format/style-registry');
    if (typeof OutputStyleRegistry === 'function') return new OutputStyleRegistry({ budgets });
  } catch (_error) {
    // Fallback 仅用于兼容增量接线；生产 3.1.2 会提供正式 registry。
  }
  return createFallbackOutputRegistry(budgets);
}

function registerStyle(registry, style, context) {
  const result = registry.register(style || {}, context || {});
  if (result && result.style) return result.style;
  if (Number.isInteger(result) && typeof registry.get === 'function') return registry.get(result);
  if (result && Number.isInteger(result.styleRef) && typeof registry.get === 'function') {
    return registry.get(result.styleRef);
  }
  return result || style || {};
}

async function closeWorkbookOutputStream(writer) {
  const outputStream = writer && writer.stream;
  try {
    if (writer && writer.zip && typeof writer.zip.abort === 'function') {
      await writer.zip.abort();
    }
  } catch (_error) {
    // 继续关闭输出流。
  }
  if (!outputStream || outputStream.closed) return;
  await new Promise((resolve) => {
    let doneCalled = false;
    const finish = () => {
      if (doneCalled) return;
      doneCalled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    outputStream.once('close', finish);
    outputStream.once('error', finish);
    try {
      outputStream.destroy();
      if (outputStream.closed) finish();
    } catch (_error) {
      finish();
    }
  });
}

async function removeFileWithRetry(filePath) {
  const retryable = new Set(['EBUSY', 'EACCES', 'EPERM']);
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error && error.code) || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function countStyleComponents(stylesXml) {
  const xml = String(stylesXml || '');
  const sections = new Map([
    ['cellXfs', { outputKey: 'cellXfs', childName: 'xf', required: true }],
    ['fonts', { outputKey: 'fonts', childName: 'font', required: true }],
    ['fills', { outputKey: 'fills', childName: 'fill', required: true }],
    ['borders', { outputKey: 'borders', childName: 'border', required: true }],
    ['numFmts', { outputKey: 'customNumFmts', childName: 'numFmt', required: false }]
  ]);
  const counts = {
    cellXfs: 0,
    fonts: 0,
    fills: 0,
    borders: 0,
    customNumFmts: 0
  };
  const seenSections = new Set();
  let depth = 0;
  let rootSeen = false;
  let rootClosed = false;
  let activeSection = null;
  let activeSectionDepth = -1;

  const localName = (name) => String(name || '').split(':').pop();
  const recognizedNamesByFold = new Map(
    ['styleSheet', ...sections.keys(), ...[...sections.values()].map((section) => section.childName)]
      .map((name) => [name.toLowerCase(), name])
  );
  const fail = (message, detailLines = []) => {
    throw new ToolboxOutputValidationError(message, detailLines);
  };
  const exactCountAttribute = (attributes, sectionName) => {
    let countValue;
    for (const [rawName, attribute] of Object.entries(attributes || {})) {
      const name = attribute && typeof attribute === 'object' && attribute.local
        ? attribute.local
        : localName(attribute && attribute.name ? attribute.name : rawName);
      if (String(name).toLowerCase() !== 'count') continue;
      if (name !== 'count') {
        fail(`工具箱临时产物的 styles.xml 中 ${sectionName}.count 大小写无效`);
      }
      if (countValue !== undefined) {
        fail(`工具箱临时产物的 styles.xml 中 ${sectionName}.count 重复`);
      }
      countValue = saxAttributeValue(attribute);
    }
    return countValue;
  };

  if (!xml.trim()) fail('工具箱临时产物的 styles.xml 为空');
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    depth += 1;
    const name = node && node.local ? String(node.local) : localName(node.name);
    const canonicalName = recognizedNamesByFold.get(name.toLowerCase());
    if (canonicalName && name !== canonicalName) {
      fail(`工具箱临时产物的 styles.xml 元素 ${name} 大小写无效`);
    }
    const isMonitoredElement = name === 'styleSheet' || sections.has(name) ||
      (activeSection && name === activeSection.childName);
    if (isMonitoredElement &&
        !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) {
      fail(`工具箱临时产物的 styles.xml 元素 ${name} 命名空间无效`);
    }
    if (depth === 1) {
      if (rootSeen || name !== 'styleSheet') {
        fail('工具箱临时产物的 styles.xml 根节点无效');
      }
      rootSeen = true;
      return;
    }
    if (!rootSeen || rootClosed) {
      fail('工具箱临时产物的 styles.xml 包含根节点外内容');
    }
    const section = sections.get(name);
    if (section) {
      if (depth !== 2) {
        fail(`工具箱临时产物的 styles.xml 中 ${name} 层级无效`);
      }
      if (seenSections.has(name)) {
        fail(`工具箱临时产物的 styles.xml 重复声明 ${name}`);
      }
      const declaredValue = exactCountAttribute(node.attributes, name);
      const declaredLexical = String(declaredValue == null ? '' : declaredValue);
      if (!/^\d+$/.test(declaredLexical)) {
        fail(`工具箱临时产物的 styles.xml 中 ${name}.count 无效`);
      }
      const declared = Number(declaredLexical);
      if (!Number.isSafeInteger(declared)) {
        fail(`工具箱临时产物的 styles.xml 中 ${name}.count 超出安全范围`);
      }
      seenSections.add(name);
      activeSection = {
        name,
        ...section,
        declared,
        actual: 0
      };
      activeSectionDepth = depth;
      return;
    }
    if (activeSection && name === activeSection.childName) {
      if (depth !== activeSectionDepth + 1) {
        fail(
          `工具箱临时产物的 styles.xml 中 ${name} 必须是 ${activeSection.name} 的直接子元素`
        );
      }
      activeSection.actual += 1;
    }
  };
  parser.onclosetag = (rawName) => {
    const name = localName(rawName);
    if (activeSection && name === activeSection.name && depth === activeSectionDepth) {
      if (activeSection.declared !== activeSection.actual) {
        fail(
          `工具箱临时产物的 styles.xml 中 ${activeSection.name}.count 与实际节点数不一致`,
          [
            `声明数量：${activeSection.declared}`,
            `实际数量：${activeSection.actual}`
          ]
        );
      }
      counts[activeSection.outputKey] = activeSection.actual;
      activeSection = null;
      activeSectionDepth = -1;
    }
    if (name === 'styleSheet' && depth === 1) rootClosed = true;
    depth -= 1;
  };

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxOutputValidationError) throw error;
    fail(
      '工具箱临时产物的 styles.xml 不是完整有效的 XML',
      [error && error.message ? error.message : String(error)]
    );
  }
  if (!rootSeen || !rootClosed || depth !== 0 || activeSection) {
    fail('工具箱临时产物的 styles.xml 未完整闭合');
  }
  for (const [sectionName, section] of sections) {
    if (section.required && !seenSections.has(sectionName)) {
      fail(`工具箱临时产物的 styles.xml 缺少 ${sectionName}`);
    }
  }
  return counts;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function validateGeneratedWorkbook(
  filePath,
  budgets = DEFAULT_STYLE_BUDGETS,
  projectedStyleCounts = null
) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new ToolboxOutputValidationError('工具箱临时产物为空或不是普通文件');
  }

  const { zip, entries } = await openZipWithEntries(path.basename(filePath), filePath, {
    rejectDuplicateEntries: true
  });
  let actualCounts;
  try {
    const required = ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml'];
    const missing = required.filter((entryName) => !entries.has(entryName));
    const worksheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name));
    if (missing.length > 0 || worksheets.length === 0) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物结构不完整',
        [...missing.map((name) => `缺少：${name}`), ...(worksheets.length === 0 ? ['缺少 worksheet'] : [])]
      );
    }
    const stylesXml = await readEntryAsString(zip, entries.get('xl/styles.xml'));
    actualCounts = countStyleComponents(stylesXml);
  } finally {
    try { zip.close(); } catch (_error) { /* ignore */ }
  }

  const limits = { ...DEFAULT_STYLE_BUDGETS, ...(budgets || {}) };
  for (const component of Object.keys(DEFAULT_STYLE_BUDGETS)) {
    if (actualCounts[component] > limits[component]) {
      throw new ToolboxOutputValidationError(
        `工具箱临时产物样式组件超过安全预算：${component}`,
        [`实际数量：${actualCounts[component]}`, `预算：${limits[component]}`, `临时产物：${filePath}`]
      );
    }
  }
  if (projectedStyleCounts && typeof projectedStyleCounts === 'object') {
    for (const component of Object.keys(DEFAULT_STYLE_BUDGETS)) {
      const projected = Number(projectedStyleCounts[component]);
      if (!Number.isSafeInteger(projected) || projected < 0) {
        throw new ToolboxOutputValidationError(
          `工具箱输出样式预计数量无效：${component}`,
          [`预计数量：${projectedStyleCounts[component]}`, `临时产物：${filePath}`]
        );
      }
      if (actualCounts[component] !== projected) {
        throw new ToolboxOutputValidationError(
          `工具箱临时产物样式组件数量与预计不一致：${component}`,
          [
            `预计数量：${projected}`,
            `实际数量：${actualCounts[component]}`,
            `临时产物：${filePath}`
          ]
        );
      }
    }
  }

  return {
    byteSize: stat.size,
    sha256: await sha256File(filePath),
    actualStyleCounts: actualCounts
  };
}

function createToolboxOutputWriter({
  savePath,
  normalizedHeaders,
  rawHeaderCells = [],
  headerRow = null,
  layoutBaseline = null,
  sourceRegistryResolver,
  sheetBaseName = 'COMMON',
  maxRowsPerSheet = MAX_DATA_ROWS_PER_SHEET,
  budgets = DEFAULT_STYLE_BUDGETS,
  projectCell = defaultProjectCell,
  outputId = null
}) {
  if (!savePath) throw new ToolboxOutputValidationError('未提供工具箱临时产物路径');
  if (!Array.isArray(normalizedHeaders) || normalizedHeaders.length === 0) {
    throw new ToolboxOutputValidationError('未提供工具箱输出表头');
  }
  const headerCellsByColumn = new Map();
  rawHeaderCells.forEach((sourceCell, index) => {
    if (!sourceCell) return;
    const columnIndex = Number.isInteger(sourceCell.columnIndex) ? sourceCell.columnIndex : index;
    headerCellsByColumn.set(columnIndex, sourceCell);
  });
  const outputHeaders = normalizedHeaders.map((value, columnIndex) => (
    prepareExcelTextValue(value, headerCellsByColumn.get(columnIndex) || {
      ...headerRow,
      rowIndex: Number.isInteger(headerRow && headerRow.rowIndex)
        ? headerRow.rowIndex
        : 1,
      columnIndex
    })
  ));
  fs.mkdirSync(path.dirname(savePath), { recursive: true });

  const warningCollector = createToolboxWarningCollector();
  const outputRegistry = loadOutputRegistry(budgets);
  const registerOutputStyle = (style, context) => registerStyle(outputRegistry, style, context);

  // 先校验首个 Sheet 提交前必需的表头行/表头单元格/列样式预算，再创建文件流；预算失败时 generation path
  // 尚未被触碰，避免构造函数抛错后留下无法由调用方 abort 的半开 stream。
  const headerRowStyleRef = headerRow && (headerRow.rowStyleRef || headerRow.effectiveStyleRef);
  if (headerRow && headerRow.customFormat && headerRowStyleRef) {
    registerOutputStyle(
      resolveSourceStyle(headerRowStyleRef, sourceRegistryResolver),
      headerRow
    );
  }
  for (const sourceCell of rawHeaderCells) {
    if (!sourceCell || !sourceCell.effectiveStyleRef) continue;
    registerOutputStyle(
      resolveSourceStyle(sourceCell.effectiveStyleRef, sourceRegistryResolver),
      sourceCell
    );
  }
  const layoutRanges = layoutBaseline && Array.isArray(layoutBaseline.columnRanges)
    ? layoutBaseline.columnRanges
    : (layoutBaseline && Array.isArray(layoutBaseline.columns) ? layoutBaseline.columns : []);
  for (const range of layoutRanges) {
    if (!range || !range.effectiveStyleRef) continue;
    registerOutputStyle(
      resolveSourceStyle(range.effectiveStyleRef, sourceRegistryResolver),
      range
    );
  }

  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: savePath,
    useStyles: true,
    useSharedStrings: false
  });
  writer.lastModifiedBy = WATERMARK_AUTHOR;

  let sheetIndex = 1;
  let worksheet = createSheetAndHeader({
    writer,
    sheetName: sheetBaseName,
    normalizedHeaders: outputHeaders,
    rawHeaderCells,
    headerRow,
    layoutBaseline,
    sourceRegistryResolver,
    registerOutputStyle
  });
  let currentSheetDataRows = 0;
  let dataRowCount = 0;
  let state = 'open';

  function addPage() {
    worksheet.commit();
    sheetIndex += 1;
    worksheet = createSheetAndHeader({
      writer,
      sheetName: `${sheetBaseName}(${sheetIndex})`,
      normalizedHeaders: outputHeaders,
      rawHeaderCells,
      headerRow,
      layoutBaseline,
      sourceRegistryResolver,
      registerOutputStyle
    });
    currentSheetDataRows = 0;
  }

  function emitRow(sourceRow) {
    if (state !== 'open') throw new Error(`工具箱输出已结束：${savePath}`);
    if (currentSheetDataRows >= maxRowsPerSheet) addPage();

    const sourceCells = sourceRow && Array.isArray(sourceRow.cells) ? sourceRow.cells : [];
    let highestColumnIndex = -1;
    for (let index = 0; index < sourceCells.length; index += 1) {
      const sourceCell = sourceCells[index];
      if (!sourceCell) continue;
      const columnIndex = Number.isInteger(sourceCell.columnIndex) ? sourceCell.columnIndex : index;
      highestColumnIndex = Math.max(highestColumnIndex, columnIndex);
    }
    const width = Math.max(normalizedHeaders.length, highestColumnIndex + 1);
    const values = new Array(width);
    const projections = [];
    for (let index = 0; index < sourceCells.length; index += 1) {
      const cell = sourceCells[index];
      if (!cell) continue;
      const columnIndex = Number.isInteger(cell.columnIndex) ? cell.columnIndex : index;
      const projection = projectCell(cell, warningCollector);
      values[columnIndex] = prepareOutputValue(
        projection ? projection.value : null,
        cell
      );
      projections.push({ columnIndex, cell, projection: projection || {} });
    }

    const outputRow = worksheet.addRow(values);
    applyRowMetadata(outputRow, sourceRow);
    const rowStyleRef = sourceRow && (sourceRow.rowStyleRef || sourceRow.effectiveStyleRef);
    if (sourceRow && sourceRow.customFormat && rowStyleRef) {
      const sourceStyle = resolveSourceStyle(rowStyleRef, sourceRegistryResolver);
      applyExcelJsStyle(outputRow, registerOutputStyle(sourceStyle, sourceRow));
    }
    for (const { columnIndex, cell, projection } of projections) {
      const targetCell = outputRow.getCell(columnIndex + 1);
      let sourceStyle = {};
      if (cell.effectiveStyleRef) {
        sourceStyle = resolveSourceStyle(cell.effectiveStyleRef, sourceRegistryResolver);
      }
      const finalStyle = projection.numFmtOverride
        ? { ...sourceStyle, numFmt: projection.numFmtOverride }
        : sourceStyle;
      applyExcelJsStyle(targetCell, registerOutputStyle(finalStyle, cell));
    }
    outputRow.commit();
    currentSheetDataRows += 1;
    dataRowCount += 1;
  }

  return {
    emitRow,
    get dataRowCount() {
      return dataRowCount;
    },
    get sheetCount() {
      return sheetIndex;
    },
    async commitAndValidate() {
      if (state !== 'open') throw new Error(`工具箱输出已结束：${savePath}`);
      state = 'committing';
      try {
        worksheet.commit();
        await writer.commit();
        const registryStats = typeof outputRegistry.stats === 'function' ? outputRegistry.stats() : {};
        const projectedStyleCounts = registryStats.projectedFinalCounts || registryStats.counts || {};
        const validation = await validateGeneratedWorkbook(
          savePath,
          budgets,
          projectedStyleCounts
        );
        state = 'committed';
        return {
          outputId,
          sourcePath: savePath,
          generationPath: savePath,
          filePath: savePath,
          dataRowCount,
          sheetCount: sheetIndex,
          warningSummary: warningCollector.summary(),
          styleStats: {
            ...registryStats,
            actualCounts: validation.actualStyleCounts
          },
          byteSize: validation.byteSize,
          sha256: validation.sha256
        };
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    async abort() {
      if (state === 'aborted') return;
      const previous = state;
      state = 'aborted';
      if (previous !== 'committed') await closeWorkbookOutputStream(writer);
      await removeFileWithRetry(savePath);
    }
  };
}

async function writeToolboxRows({
  writeRows,
  ...options
}) {
  const output = createToolboxOutputWriter(options);
  try {
    await writeRows(output.emitRow);
    return await output.commitAndValidate();
  } catch (error) {
    try {
      await output.abort();
    } catch (cleanupError) {
      const finalError = error && typeof error === 'object' ? error : new Error(String(error));
      finalError.detailLines = [
        ...(Array.isArray(finalError.detailLines) ? finalError.detailLines : []),
        `清理临时产物失败：${cleanupError.message || cleanupError}`
      ];
      finalError.preserveTemporaryFiles = true;
      throw finalError;
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_STYLE_BUDGETS,
  MAX_DATA_ROWS_PER_SHEET,
  WARNING_SAMPLE_LIMIT,
  ToolboxOutputValidationError,
  applyExcelJsStyle,
  applyRowMetadata,
  applySheetLayout,
  countStyleComponents,
  createFallbackOutputRegistry,
  createToolboxOutputWriter,
  createToolboxWarningCollector,
  defaultProjectCell,
  resolveSourceStyle,
  sanitizeSheetName,
  sheetPropertiesFromLayout,
  sha256File,
  stripNullish,
  validateGeneratedWorkbook,
  writeToolboxRows
};
