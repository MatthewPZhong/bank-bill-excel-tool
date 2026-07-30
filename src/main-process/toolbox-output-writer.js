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
  OFFICE_RELATIONSHIP_NAMESPACES,
  PACKAGE_RELATIONSHIP_NAMESPACES,
  SPREADSHEETML_NAMESPACES,
  namespaceAllowed,
  saxAttributeValue
} = require('../backend/toolbox-format/ooxml-namespaces');
const {
  normalizeCell: normalizeOutputHeaderCell
} = require('../backend/toolbox-format/model');
const {
  openToolboxXlsxPass
} = require('../backend/toolbox-format/xlsx-pass');
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
const PACKAGE_CONTENT_TYPES_NAMESPACES = Object.freeze(new Set([
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://purl.oclc.org/ooxml/package/content-types'
]));
const PACKAGE_RELATIONSHIPS_ENTRY_NAME = '_rels/.rels';
const PACKAGE_RELATIONSHIPS_CONTENT_TYPE =
  'application/vnd.openxmlformats-package.relationships+xml';
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = Object.freeze(new Set(
  [...OFFICE_RELATIONSHIP_NAMESPACES]
    .map((namespace) => `${namespace}/officeDocument`)
));
const GENERATED_WORKBOOK_CONTENT_TYPES = Object.freeze({
  workbook: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  worksheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
});
const EXCELJS_ZERO_HEIGHT_PATCH = Symbol.for(
  'bank-bill-excel-tool.toolbox.exceljs-zero-height'
);

class ToolboxOutputValidationError extends Error {
  constructor(message, detailLines = []) {
    super(message);
    this.name = 'ToolboxOutputValidationError';
    this.detailLines = Array.isArray(detailLines) ? detailLines.slice() : [];
  }
}

function installExcelJsZeroHeightSupport() {
  // ExcelJS 4.4 的 streaming writer 没有透传 sheetFormatPr.zeroHeight。
  // 只在本工具确实需要输出 BIFF8 默认隐藏行时补这一条属性；普通工作簿继续走原实现。
  // package-lock 锁定了该内部入口，若后续升级 ExcelJS 改掉私有契约，应明确失败并由测试暴露。
  let WorksheetWriter;
  let XmlStream;
  try {
    // eslint-disable-next-line global-require
    WorksheetWriter = require('exceljs/lib/stream/xlsx/worksheet-writer');
    // eslint-disable-next-line global-require
    XmlStream = require('exceljs/lib/utils/xml-stream');
  } catch (cause) {
    const error = new ToolboxOutputValidationError(
      '当前 Excel 写入组件无法保留默认隐藏行，请升级后重试'
    );
    error.cause = cause;
    throw error;
  }
  const prototype = WorksheetWriter && WorksheetWriter.prototype;
  if (!prototype || typeof prototype._writeSheetFormatProperties !== 'function') {
    throw new ToolboxOutputValidationError(
      '当前 Excel 写入组件无法保留默认隐藏行，请升级后重试'
    );
  }
  if (prototype[EXCELJS_ZERO_HEIGHT_PATCH]) return;

  const original = prototype._writeSheetFormatProperties;
  Object.defineProperty(prototype, EXCELJS_ZERO_HEIGHT_PATCH, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  prototype._writeSheetFormatProperties = function writeToolboxSheetFormat(
    xmlBuffer,
    properties
  ) {
    if (!properties || properties.zeroHeight !== true) {
      return original.call(this, xmlBuffer, properties);
    }
    const model = {
      defaultRowHeight: properties.defaultRowHeight,
      dyDescent: properties.dyDescent,
      outlineLevelCol: properties.outlineLevelCol,
      outlineLevelRow: properties.outlineLevelRow
    };
    if (properties.defaultColWidth) model.defaultColWidth = properties.defaultColWidth;

    const attributes = {
      defaultRowHeight: model.defaultRowHeight,
      outlineLevelRow: model.outlineLevelRow,
      outlineLevelCol: model.outlineLevelCol,
      'x14ac:dyDescent': model.dyDescent,
      zeroHeight: '1'
    };
    if (model.defaultColWidth) attributes.defaultColWidth = model.defaultColWidth;
    if (!model.defaultRowHeight || model.defaultRowHeight !== 15) {
      attributes.customHeight = '1';
    }
    const xmlStream = new XmlStream();
    xmlStream.leafNode('sheetFormatPr', attributes);
    xmlBuffer.addText(xmlStream.xml);
    return undefined;
  };
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
  const hasDefaultRowHeight = meta.defaultRowHeight !== null
    && meta.defaultRowHeight !== undefined
    && meta.defaultRowHeight !== ''
    && Number.isFinite(Number(meta.defaultRowHeight));
  if (meta.defaultRowHidden === true) {
    const sourceHeight = hasDefaultRowHeight ? Number(meta.defaultRowHeight) : null;
    const defaultRowHeight = sourceHeight !== null && sourceHeight > 0 ? sourceHeight : 15;
    properties.defaultRowHeight = meta.customHeight === true && defaultRowHeight === 15
      ? '15'
      : defaultRowHeight;
    properties.zeroHeight = true;
  } else if (hasDefaultRowHeight && Number(meta.defaultRowHeight) > 0) {
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
      column.hidden = range.hidden === true
        || (Number.isFinite(range.width) && Number(range.width) === 0);
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

function parseGeneratedContentTypes(
  contentTypesXml,
  worksheetEntryNames,
  zipEntryNames
) {
  const xml = String(contentTypesXml || '');
  const expectedWorksheets = new Set(worksheetEntryNames || []);
  const packagedEntries = new Set(zipEntryNames || []);
  const defaults = new Map();
  const overrides = new Map();
  const recognizedElements = new Map([
    ['types', 'Types'],
    ['default', 'Default'],
    ['override', 'Override']
  ]);
  const recognizedAttributes = Object.freeze({
    Default: new Map([
      ['extension', 'Extension'],
      ['contenttype', 'ContentType']
    ]),
    Override: new Map([
      ['partname', 'PartName'],
      ['contenttype', 'ContentType']
    ])
  });
  let rootSeen = false;
  let rootClosed = false;
  let depth = 0;

  const fail = (message, detailLines = []) => {
    throw new ToolboxOutputValidationError(message, detailLines);
  };
  const exactAttributes = (node, elementName) => {
    const output = {};
    const expected = recognizedAttributes[elementName];
    for (const [rawName, attribute] of Object.entries(node.attributes || {})) {
      const qualifiedName = attribute && attribute.name ? attribute.name : rawName;
      if (qualifiedName === 'xmlns' || String(qualifiedName).startsWith('xmlns:')) continue;
      const local = attribute && typeof attribute.local === 'string'
        ? attribute.local
        : String(qualifiedName).split(':').pop();
      const canonical = expected.get(String(local).toLowerCase());
      if (!canonical || local !== canonical) {
        fail(
          `工具箱临时产物的 [Content_Types].xml 中 ${elementName}.${local} 无效`
        );
      }
      if (Object.prototype.hasOwnProperty.call(output, canonical)) {
        fail(
          `工具箱临时产物的 [Content_Types].xml 中 ${elementName}.${canonical} 重复`
        );
      }
      output[canonical] = String(saxAttributeValue(attribute) || '');
    }
    for (const required of expected.values()) {
      if (!output[required]) {
        fail(
          `工具箱临时产物的 [Content_Types].xml 中 ${elementName} 缺少 ${required}`
        );
      }
    }
    return output;
  };

  if (!xml.trim()) fail('工具箱临时产物的 [Content_Types].xml 为空');
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    depth += 1;
    const local = node && node.local
      ? String(node.local)
      : String(node && node.name ? node.name : '').split(':').pop();
    const canonical = recognizedElements.get(local.toLowerCase());
    if (!canonical || local !== canonical) {
      fail(`工具箱临时产物的 [Content_Types].xml 元素 ${local} 无效`);
    }
    if (!namespaceAllowed(node.uri, PACKAGE_CONTENT_TYPES_NAMESPACES)) {
      fail(`工具箱临时产物的 [Content_Types].xml 元素 ${local} 命名空间无效`);
    }
    if (depth === 1) {
      if (rootSeen || canonical !== 'Types') {
        fail('工具箱临时产物的 [Content_Types].xml 根节点无效');
      }
      rootSeen = true;
      return;
    }
    if (!rootSeen || rootClosed || depth !== 2 || canonical === 'Types') {
      fail(`工具箱临时产物的 [Content_Types].xml 元素 ${local} 层级无效`);
    }
    const attributes = exactAttributes(node, canonical);
    if (canonical === 'Default') {
      const extension = String(attributes.Extension || '').toLowerCase();
      if (defaults.has(extension)) {
        fail(
          '工具箱临时产物的 [Content_Types].xml 重复声明 Extension',
          [`Extension：${attributes.Extension}`]
        );
      }
      defaults.set(extension, attributes.ContentType);
      return;
    }
    if (canonical !== 'Override') return;
    const partName = attributes.PartName;
    if (!partName.startsWith('/') || partName.includes('\\')) {
      fail(
        '工具箱临时产物的 [Content_Types].xml PartName 无效',
        [`PartName：${partName}`]
      );
    }
    const entryName = partName.slice(1);
    if (overrides.has(entryName)) {
      fail(
        '工具箱临时产物的 [Content_Types].xml 重复声明 PartName',
        [`PartName：${partName}`]
      );
    }
    overrides.set(entryName, attributes.ContentType);
  };
  parser.onclosetag = (rawName) => {
    const local = String(rawName || '').split(':').pop();
    if (local === 'Types' && depth === 1) rootClosed = true;
    depth -= 1;
  };

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxOutputValidationError) throw error;
    fail(
      '工具箱临时产物的 [Content_Types].xml 不是完整有效的 XML',
      [error && error.message ? error.message : String(error)]
    );
  }
  if (!rootSeen || !rootClosed || depth !== 0) {
    fail('工具箱临时产物的 [Content_Types].xml 未完整闭合');
  }
  const relationshipsContentType = defaults.get('rels');
  if (relationshipsContentType !== PACKAGE_RELATIONSHIPS_CONTENT_TYPE) {
    fail(
      '工具箱临时产物的 [Content_Types].xml 缺少有效的 rels Default',
      [
        `预计类型：${PACKAGE_RELATIONSHIPS_CONTENT_TYPE}`,
        `实际类型：${relationshipsContentType || '（缺失）'}`
      ]
    );
  }

  const requiredOverrides = new Map([
    ['xl/workbook.xml', GENERATED_WORKBOOK_CONTENT_TYPES.workbook],
    ['xl/styles.xml', GENERATED_WORKBOOK_CONTENT_TYPES.styles],
    ...[...expectedWorksheets].map((entryName) => [
      entryName,
      GENERATED_WORKBOOK_CONTENT_TYPES.worksheet
    ])
  ]);
  for (const [entryName, expectedContentType] of requiredOverrides) {
    const actualContentType = overrides.get(entryName);
    if (actualContentType !== expectedContentType) {
      fail(
        '工具箱临时产物的 [Content_Types].xml 声明与产物结构不一致',
        [
          `PartName：/${entryName}`,
          `预计类型：${expectedContentType}`,
          `实际类型：${actualContentType || '（缺失）'}`
        ]
      );
    }
  }
  const worksheetOverrides = new Set(
    [...overrides.entries()]
      .filter(([, contentType]) => (
        contentType === GENERATED_WORKBOOK_CONTENT_TYPES.worksheet
      ))
      .map(([entryName]) => entryName)
  );
  const missingOrExtraWorksheetOverrides = [
    ...[...expectedWorksheets]
      .filter((entryName) => !worksheetOverrides.has(entryName))
      .map((entryName) => `缺少 worksheet Override：/${entryName}`),
    ...[...worksheetOverrides]
      .filter((entryName) => !expectedWorksheets.has(entryName))
      .map((entryName) => `游离 worksheet Override：/${entryName}`)
  ];
  const missingOverrideParts = [...overrides.keys()]
    .filter((entryName) => !packagedEntries.has(entryName))
    .map((entryName) => `Override 指向不存在的 Part：/${entryName}`);
  if (missingOrExtraWorksheetOverrides.length > 0 || missingOverrideParts.length > 0) {
    fail(
      '工具箱临时产物的 [Content_Types].xml 包含悬空或不一致声明',
      [...missingOrExtraWorksheetOverrides, ...missingOverrideParts]
    );
  }
  return overrides;
}

function normalizePackageRootRelationshipTarget(target) {
  const value = String(target || '').trim();
  if (!value || value.includes('\\') || value.includes('\0')) return null;
  const packageRelative = value.startsWith('/') ? value.slice(1) : value;
  if (!packageRelative) return null;
  const normalized = path.posix.normalize(packageRelative);
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseGeneratedPackageRelationships(relationshipsXml, zipEntryNames) {
  const xml = String(relationshipsXml || '');
  const packagedEntries = new Set(zipEntryNames || []);
  const relationships = new Map();
  const recognizedElements = new Map([
    ['relationships', 'Relationships'],
    ['relationship', 'Relationship']
  ]);
  const recognizedAttributes = new Map([
    ['id', 'Id'],
    ['type', 'Type'],
    ['target', 'Target'],
    ['targetmode', 'TargetMode']
  ]);
  let rootSeen = false;
  let rootClosed = false;
  let depth = 0;

  const fail = (message, detailLines = []) => {
    throw new ToolboxOutputValidationError(message, detailLines);
  };
  const exactRelationshipAttributes = (node) => {
    const output = {};
    for (const [rawName, attribute] of Object.entries(node.attributes || {})) {
      const qualifiedName = attribute && attribute.name ? attribute.name : rawName;
      if (qualifiedName === 'xmlns' || String(qualifiedName).startsWith('xmlns:')) continue;
      const prefix = attribute && typeof attribute.prefix === 'string'
        ? attribute.prefix
        : String(qualifiedName).includes(':')
          ? String(qualifiedName).split(':')[0]
          : '';
      const local = attribute && typeof attribute.local === 'string'
        ? attribute.local
        : String(qualifiedName).split(':').pop();
      const canonical = recognizedAttributes.get(String(local).toLowerCase());
      if (prefix || !canonical || local !== canonical) {
        fail(
          `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 中 ` +
            `Relationship.${qualifiedName} 无效`
        );
      }
      if (Object.prototype.hasOwnProperty.call(output, canonical)) {
        fail(
          `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 中 ` +
            `Relationship.${canonical} 重复`
        );
      }
      output[canonical] = String(saxAttributeValue(attribute) || '').trim();
    }
    for (const required of ['Id', 'Type', 'Target']) {
      if (!output[required]) {
        fail(
          `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 中 ` +
            `Relationship 缺少 ${required}`
        );
      }
    }
    return output;
  };

  if (!xml.trim()) {
    fail(`工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 为空`);
  }
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: true });
  parser.onopentag = (node) => {
    depth += 1;
    const local = node && node.local
      ? String(node.local)
      : String(node && node.name ? node.name : '').split(':').pop();
    const canonical = recognizedElements.get(local.toLowerCase());
    if (!canonical || local !== canonical) {
      fail(`工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 元素 ${local} 无效`);
    }
    if (!namespaceAllowed(node.uri, PACKAGE_RELATIONSHIP_NAMESPACES)) {
      fail(
        `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} ` +
          `元素 ${local} 命名空间无效`
      );
    }
    if (depth === 1) {
      if (rootSeen || canonical !== 'Relationships') {
        fail(`工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 根节点无效`);
      }
      rootSeen = true;
      return;
    }
    if (!rootSeen || rootClosed || depth !== 2 || canonical !== 'Relationship') {
      fail(
        `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 元素 ${local} 层级无效`
      );
    }
    const attributes = exactRelationshipAttributes(node);
    if (relationships.has(attributes.Id)) {
      fail(
        `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 包含重复关系 Id`,
        [`Id：${attributes.Id}`]
      );
    }
    const targetMode = attributes.TargetMode || 'Internal';
    if (targetMode !== 'Internal' && targetMode !== 'External') {
      fail(
        `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} TargetMode 无效`,
        [`Id：${attributes.Id}`, `TargetMode：${targetMode}`]
      );
    }
    const target = targetMode === 'External'
      ? attributes.Target
      : normalizePackageRootRelationshipTarget(attributes.Target);
    if (!target) {
      fail(
        `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 关系目标越界或无效`,
        [`Id：${attributes.Id}`, `Target：${attributes.Target}`]
      );
    }
    relationships.set(attributes.Id, {
      id: attributes.Id,
      type: attributes.Type,
      target,
      targetMode
    });
  };
  parser.onclosetag = (rawName) => {
    const local = String(rawName || '').split(':').pop();
    if (local === 'Relationships' && depth === 1) rootClosed = true;
    depth -= 1;
  };

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxOutputValidationError) throw error;
    fail(
      `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 不是完整有效的 XML`,
      [error && error.message ? error.message : String(error)]
    );
  }
  if (!rootSeen || !rootClosed || depth !== 0) {
    fail(`工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 未完整闭合`);
  }

  const internalRelationships = [...relationships.values()]
    .filter((relationship) => relationship.targetMode !== 'External');
  const danglingRelationships = internalRelationships
    .filter((relationship) => !packagedEntries.has(relationship.target));
  if (danglingRelationships.length > 0) {
    fail(
      `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} 包含悬空内部关系`,
      danglingRelationships.map((relationship) => (
        `${relationship.id}：${relationship.target}`
      ))
    );
  }

  const officeDocumentRelationships = [...relationships.values()]
    .filter((relationship) => OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type));
  if (
    officeDocumentRelationships.length !== 1
    || officeDocumentRelationships[0].targetMode === 'External'
    || officeDocumentRelationships[0].target !== 'xl/workbook.xml'
  ) {
    fail(
      `工具箱临时产物的 ${PACKAGE_RELATIONSHIPS_ENTRY_NAME} ` +
        '必须唯一指向 xl/workbook.xml',
      officeDocumentRelationships.length === 0
        ? ['缺少 officeDocument relationship']
        : officeDocumentRelationships.map((relationship) => (
          `${relationship.id}：${relationship.targetMode} → ${relationship.target}`
        ))
    );
  }
  return relationships;
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

function normalizeExpectedWorkbookStructure(expectedStructure) {
  if (expectedStructure == null) return null;
  if (!expectedStructure || typeof expectedStructure !== 'object' || Array.isArray(expectedStructure)) {
    throw new ToolboxOutputValidationError('工具箱输出结构预计值无效');
  }
  const sheetCount = Number(expectedStructure.sheetCount);
  const dataRowCount = Number(expectedStructure.dataRowCount);
  const normalizedHeaders = expectedStructure.normalizedHeaders;
  if (!Number.isSafeInteger(sheetCount) || sheetCount < 1) {
    throw new ToolboxOutputValidationError(
      '工具箱输出预计 Sheet 数无效',
      [`预计数量：${expectedStructure.sheetCount}`]
    );
  }
  if (!Number.isSafeInteger(dataRowCount) || dataRowCount < 0) {
    throw new ToolboxOutputValidationError(
      '工具箱输出预计数据行数无效',
      [`预计数量：${expectedStructure.dataRowCount}`]
    );
  }
  if (
    !Array.isArray(normalizedHeaders)
    || normalizedHeaders.length === 0
    || normalizedHeaders.some((header) => typeof header !== 'string')
  ) {
    throw new ToolboxOutputValidationError('工具箱输出预计表头无效');
  }
  return Object.freeze({
    sheetCount,
    dataRowCount,
    normalizedHeaders: Object.freeze(normalizedHeaders.slice())
  });
}

function normalizedHeadersFromOutputRow(row) {
  const cells = row && Array.isArray(row.cells) ? row.cells : [];
  const highestColumnIndex = cells.reduce(
    (highest, cell) => (
      cell && Number.isInteger(cell.columnIndex)
        ? Math.max(highest, cell.columnIndex)
        : highest
    ),
    -1
  );
  const headers = new Array(highestColumnIndex + 1).fill('');
  for (const cell of cells) {
    if (!cell || !Number.isInteger(cell.columnIndex)) continue;
    headers[cell.columnIndex] = normalizeOutputHeaderCell(cell.matchProjectionValue);
  }
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
  return headers;
}

function formatHeadersForDetail(headers) {
  return headers.length > 0 ? headers.join(' | ') : '（空）';
}

async function validateGeneratedWorkbookStructure(filePath, expectedStructure = null) {
  const expected = normalizeExpectedWorkbookStructure(expectedStructure);
  let pass = null;
  try {
    pass = await openToolboxXlsxPass(filePath);
    const actualSheetCount = pass.sheets.length;
    const declaredWorksheetEntries = new Set(pass.sheets.map((sheet) => sheet.entryPath));
    const packagedWorksheetEntries = [...pass.entries.keys()]
      .filter((entryName) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entryName));
    const orphanWorksheetEntries = packagedWorksheetEntries
      .filter((entryName) => !declaredWorksheetEntries.has(entryName));
    if (
      declaredWorksheetEntries.size !== packagedWorksheetEntries.length
      || orphanWorksheetEntries.length > 0
    ) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物包含未声明的 worksheet',
        [
          ...orphanWorksheetEntries.map((entryName) => `孤立 worksheet：${entryName}`),
          `workbook 声明数量：${declaredWorksheetEntries.size}`,
          `ZIP worksheet 数量：${packagedWorksheetEntries.length}`,
          `临时产物：${filePath}`
        ]
      );
    }
    const declaredRelationshipIds = new Set(
      pass.sheets.map((sheet) => sheet.relationshipId)
    );
    const worksheetRelationshipTypes = new Set(
      [...OFFICE_RELATIONSHIP_NAMESPACES]
        .map((namespace) => `${namespace}/worksheet`)
    );
    const worksheetRelationships = pass.workbookRelationships.filter((relationship) => (
      worksheetRelationshipTypes.has(relationship.type)
      || /^xl\/worksheets\/[^/]+\.xml$/i.test(relationship.target)
    ));
    const invalidWorksheetRelationships = worksheetRelationships.filter((relationship) => (
      !worksheetRelationshipTypes.has(relationship.type)
      || String(relationship.targetMode || '').toLowerCase() === 'external'
      || !declaredRelationshipIds.has(relationship.id)
      || !declaredWorksheetEntries.has(relationship.target)
      || !pass.entries.has(relationship.target)
    ));
    if (
      worksheetRelationships.length !== pass.sheets.length
      || invalidWorksheetRelationships.length > 0
    ) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物包含未被 workbook Sheet 使用的 worksheet relationship',
        [
          ...invalidWorksheetRelationships.map((relationship) => (
            `游离 relationship：${relationship.id} → ${relationship.target}`
          )),
          `workbook Sheet 数量：${pass.sheets.length}`,
          `worksheet relationship 数量：${worksheetRelationships.length}`,
          `临时产物：${filePath}`
        ]
      );
    }
    const danglingInternalRelationships = pass.workbookRelationships.filter((relationship) => (
      String(relationship.targetMode || '').toLowerCase() !== 'external'
      && (!relationship.target || !pass.entries.has(relationship.target))
    ));
    if (danglingInternalRelationships.length > 0) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物的 workbook relationships 包含悬空内部关系',
        danglingInternalRelationships.map((relationship) => (
          `${relationship.id}：${relationship.target || '（无效目标）'}`
        ))
      );
    }
    let actualPhysicalRowCount = 0;
    let actualDataRowCount = 0;

    for (const sheet of pass.sheets) {
      let headerSeen = false;
      let actualHeaders = null;
      // 严格 opener 只解析 workbook/rels 和工作簿级元数据；必须逐个 scan，
      // 才会严格解析并完整闭合验证每个已声明 worksheet。
      // eslint-disable-next-line no-await-in-loop
      const summary = await pass.scanSheet(sheet, {
        onRow: (row) => {
          if (!headerSeen) {
            headerSeen = true;
            if (expected) actualHeaders = normalizedHeadersFromOutputRow(row);
          }
        }
      });
      if (!headerSeen || summary.rowCount < 1) {
        throw new ToolboxOutputValidationError(
          '工具箱临时产物缺少分页表头',
          [`Sheet：${sheet.name}`, `临时产物：${filePath}`]
        );
      }
      if (
        expected
        && (
          actualHeaders.length !== expected.normalizedHeaders.length
          || actualHeaders.some((header, index) => header !== expected.normalizedHeaders[index])
        )
      ) {
        throw new ToolboxOutputValidationError(
          '工具箱临时产物表头与预计不一致',
          [
            `Sheet：${sheet.name}`,
            `预计表头：${formatHeadersForDetail(expected.normalizedHeaders)}`,
            `实际表头：${formatHeadersForDetail(actualHeaders)}`,
            `临时产物：${filePath}`
          ]
        );
      }
      actualPhysicalRowCount += summary.rowCount;
      actualDataRowCount += summary.rowCount - 1;
    }

    if (expected && actualSheetCount !== expected.sheetCount) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物 Sheet 数与预计不一致',
        [
          `预计数量：${expected.sheetCount}`,
          `实际数量：${actualSheetCount}`,
          `临时产物：${filePath}`
        ]
      );
    }
    if (expected && actualDataRowCount !== expected.dataRowCount) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物数据行数与预计不一致',
        [
          `预计数据行数：${expected.dataRowCount}`,
          `实际数据行数：${actualDataRowCount}`,
          `实际物理行数：${actualPhysicalRowCount}`,
          `临时产物：${filePath}`
        ]
      );
    }
    return {
      actualSheetCount,
      actualDataRowCount,
      actualPhysicalRowCount
    };
  } catch (error) {
    if (error instanceof ToolboxOutputValidationError) throw error;
    const validationError = new ToolboxOutputValidationError(
      '工具箱临时产物结构复核失败',
      [
        `原因：${error && error.message ? error.message : String(error)}`,
        `临时产物：${filePath}`
      ]
    );
    validationError.cause = error;
    throw validationError;
  } finally {
    if (pass) pass.close();
  }
}

async function validateGeneratedWorkbook(
  filePath,
  budgets = DEFAULT_STYLE_BUDGETS,
  projectedStyleCounts = null,
  expectedStructure = null
) {
  const initialStat = await fs.promises.stat(filePath);
  if (!initialStat.isFile() || initialStat.size <= 0) {
    throw new ToolboxOutputValidationError('工具箱临时产物为空或不是普通文件');
  }
  // 结构/样式解析会按 part 多次打开同一路径；先记录整文件身份，最终再取一次，
  // 防止校验期间被同大小换内容后为新内容重新背书。
  const initialSha256 = await sha256File(filePath);

  const { zip, entries } = await openZipWithEntries(path.basename(filePath), filePath, {
    rejectDuplicateEntries: true
  });
  let actualCounts;
  try {
    const required = [
      '[Content_Types].xml',
      PACKAGE_RELATIONSHIPS_ENTRY_NAME,
      'xl/workbook.xml',
      'xl/styles.xml'
    ];
    const missing = required.filter((entryName) => !entries.has(entryName));
    const worksheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name));
    if (missing.length > 0 || worksheets.length === 0) {
      throw new ToolboxOutputValidationError(
        '工具箱临时产物结构不完整',
        [...missing.map((name) => `缺少：${name}`), ...(worksheets.length === 0 ? ['缺少 worksheet'] : [])]
      );
    }
    const contentTypesXml = await readEntryAsString(
      zip,
      entries.get('[Content_Types].xml')
    );
    parseGeneratedContentTypes(contentTypesXml, worksheets, entries.keys());
    const packageRelationshipsXml = await readEntryAsString(
      zip,
      entries.get(PACKAGE_RELATIONSHIPS_ENTRY_NAME)
    );
    parseGeneratedPackageRelationships(packageRelationshipsXml, entries.keys());
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

  const structure = await validateGeneratedWorkbookStructure(filePath, expectedStructure);
  const finalStat = await fs.promises.stat(filePath);
  const finalSha256 = await sha256File(filePath);
  if (
    !finalStat.isFile()
    || finalStat.size !== initialStat.size
    || finalSha256 !== initialSha256
  ) {
    throw new ToolboxOutputValidationError(
      '工具箱临时产物在写后复核期间发生变化，已阻止发布',
      [
        `复核前大小：${initialStat.size}`,
        `复核后大小：${finalStat.size}`,
        `复核前 SHA-256：${initialSha256}`,
        `复核后 SHA-256：${finalSha256}`,
        `临时产物：${filePath}`
      ]
    );
  }
  return {
    byteSize: finalStat.size,
    sha256: finalSha256,
    actualStyleCounts: actualCounts,
    ...structure
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

  // 私有兼容契约必须在创建文件流前完成；安装失败时不得留下半文件或打开句柄。
  if (layoutBaseline && layoutBaseline.defaultRowHidden === true) {
    installExcelJsZeroHeightSupport();
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
          projectedStyleCounts,
          {
            sheetCount: sheetIndex,
            dataRowCount,
            normalizedHeaders
          }
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
