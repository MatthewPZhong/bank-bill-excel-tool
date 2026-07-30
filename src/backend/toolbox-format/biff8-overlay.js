'use strict';

const fs = require('node:fs');
const JSZip = require('jszip');
const sax = require('sax');
const XLSX = require('xlsx');

const {
  Biff8RecordError,
  DEFAULT_BUILTIN_FORMATS,
  scanBiff8WorkbookStream
} = require('./biff8-records');
const {
  THEME_COLOR_NAMES,
  normalizeRgb,
  createPalette,
  resolveIndexedColor,
  resolveFullColor
} = require('./biff8-colors');

const OLE_CFB_MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const MAX_THEME_ZIP_ENTRIES = 128;
const MAX_THEME_XML_BYTES = 2 * 1024 * 1024;

const DEFAULT_OFFICE_THEME_COLORS = Object.freeze([
  'FFFFFF',
  '000000',
  'EEECE1',
  '1F497D',
  '4F81BD',
  'C0504D',
  '9BBB59',
  '8064A2',
  '4BACC6',
  'F79646',
  '0000FF',
  '800080'
]);

const FILL_PATTERNS = Object.freeze([
  'none',
  'solid',
  'mediumGray',
  'darkGray',
  'lightGray',
  'darkHorizontal',
  'darkVertical',
  'darkDown',
  'darkUp',
  'darkGrid',
  'darkTrellis',
  'lightHorizontal',
  'lightVertical',
  'lightDown',
  'lightUp',
  'lightGrid',
  'lightTrellis',
  'gray125',
  'gray0625'
]);

const BORDER_STYLES = Object.freeze([
  null,
  'thin',
  'medium',
  'dashed',
  'dotted',
  'thick',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot'
]);

const HORIZONTAL_ALIGNMENTS = Object.freeze([
  'general',
  'left',
  'center',
  'right',
  'fill',
  'justify',
  'centerContinuous',
  'distributed'
]);

const VERTICAL_ALIGNMENTS = Object.freeze([
  'top',
  'center',
  'bottom',
  'justify',
  'distributed'
]);

class Biff8OverlayError extends Error {
  constructor(code, message, detail = {}, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'Biff8OverlayError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail, cause) {
  throw new Biff8OverlayError(code, message, detail, cause);
}

function normalizeInputBuffer(input) {
  if (typeof input === 'string') return fs.readFileSync(input);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

function streamLeafName(fullPath) {
  return String(fullPath || '')
    .replace(/\u0000/g, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();
}

function extractWorkbookStream(input) {
  let cfb;
  let sourcePath = null;
  const inputBuffer = normalizeInputBuffer(input);
  if (inputBuffer) {
    sourcePath = typeof input === 'string' ? input : null;
    if (inputBuffer.length < OLE_CFB_MAGIC.length || !inputBuffer.subarray(0, 8).equals(OLE_CFB_MAGIC)) {
      fail(
        'BIFF8_NOT_OLE_CFB',
        '输入不是标准 OLE/CFB Excel 97–2003 工作簿，请另存为标准 .xls 或 .xlsx',
        { sourcePath, magic: inputBuffer.subarray(0, 8).toString('hex') }
      );
    }
    try {
      cfb = XLSX.CFB.read(inputBuffer, { type: 'buffer' });
    } catch (error) {
      fail('BIFF8_INVALID_CFB', `无法读取 OLE/CFB 容器：${error.message}`, { sourcePath }, error);
    }
  } else if (input && Array.isArray(input.FullPaths) && Array.isArray(input.FileIndex)) {
    cfb = input;
  } else {
    fail('BIFF8_INVALID_INPUT', 'BIFF8 overlay 输入必须是路径、Buffer、Uint8Array 或 CFB 对象');
  }

  const candidates = [];
  for (let index = 0; index < cfb.FullPaths.length; index += 1) {
    const leaf = streamLeafName(cfb.FullPaths[index]);
    if (leaf !== 'Workbook' && leaf !== 'Book') continue;
    const entry = cfb.FileIndex[index];
    if (entry && entry.content) {
      candidates.push({
        name: leaf,
        fullPath: cfb.FullPaths[index],
        content: Buffer.from(entry.content)
      });
    }
  }
  if (candidates.length !== 1) {
    fail(
      'BIFF8_WORKBOOK_STREAM_AMBIGUOUS',
      candidates.length === 0
        ? 'OLE/CFB 中找不到 Workbook/Book stream'
        : 'OLE/CFB 中存在多个 Workbook/Book stream，无法安全选择',
      { sourcePath, candidates: candidates.map((entry) => entry.fullPath) }
    );
  }
  return {
    sourcePath,
    cfb,
    streamName: candidates[0].name,
    streamPath: candidates[0].fullPath,
    stream: candidates[0].content
  };
}

function localXmlName(name) {
  return String(name || '').split(':').pop();
}

async function parseThemeColors(theme) {
  if (!theme) return null;
  if (theme.defaultTheme) return DEFAULT_OFFICE_THEME_COLORS.slice();
  if (!theme.packageBytes) {
    fail(
      'BIFF8_MISSING_THEME_PACKAGE',
      `BIFF8 Theme version ${theme.version} 没有可解析的默认标记或 ZIP package`,
      { version: theme.version }
    );
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(theme.packageBytes);
  } catch (error) {
    fail('BIFF8_INVALID_THEME_PACKAGE', `无法解压 BIFF8 Theme package：${error.message}`, {}, error);
  }
  const themeEntries = Object.keys(zip.files).filter((name) => /(^|\/)theme1\.xml$/i.test(name));
  if (Object.keys(zip.files).length > MAX_THEME_ZIP_ENTRIES) {
    fail(
      'BIFF8_THEME_PACKAGE_TOO_LARGE',
      `BIFF8 Theme package entry 数量超过 ${MAX_THEME_ZIP_ENTRIES}`,
      { entryCount: Object.keys(zip.files).length }
    );
  }
  if (themeEntries.length !== 1) {
    fail(
      'BIFF8_THEME_XML_AMBIGUOUS',
      `BIFF8 Theme package 应包含一个 theme1.xml，实际 ${themeEntries.length}`,
      { entries: themeEntries }
    );
  }
  const themeEntry = zip.files[themeEntries[0]];
  const uncompressedSize = themeEntry
    && themeEntry._data
    && Number(themeEntry._data.uncompressedSize);
  if (Number.isFinite(uncompressedSize) && uncompressedSize > MAX_THEME_XML_BYTES) {
    fail(
      'BIFF8_THEME_XML_TOO_LARGE',
      `BIFF8 theme1.xml 超过 ${MAX_THEME_XML_BYTES} 字节`,
      { uncompressedSize }
    );
  }
  const xml = await themeEntry.async('string');
  if (Buffer.byteLength(xml, 'utf8') > MAX_THEME_XML_BYTES) {
    fail(
      'BIFF8_THEME_XML_TOO_LARGE',
      `BIFF8 theme1.xml 超过 ${MAX_THEME_XML_BYTES} 字节`,
      { actualBytes: Buffer.byteLength(xml, 'utf8') }
    );
  }
  const colorsByName = new Map();
  let activeColorName = null;
  let parserError = null;
  const parser = sax.parser(true, { trim: false, normalize: false });
  parser.onerror = (error) => {
    parserError = error;
  };
  parser.onopentag = (node) => {
    const name = localXmlName(node.name);
    if (THEME_COLOR_NAMES.includes(name)) {
      activeColorName = name;
      return;
    }
    if (!activeColorName || (name !== 'srgbClr' && name !== 'sysClr')) return;
    const attributes = node.attributes || {};
    const rgb = name === 'srgbClr'
      ? (attributes.val && attributes.val.value != null ? attributes.val.value : attributes.val)
      : (
          attributes.lastClr && attributes.lastClr.value != null
            ? attributes.lastClr.value
            : (attributes.lastClr || attributes.val)
        );
    if (rgb != null) colorsByName.set(activeColorName, String(rgb).toUpperCase());
  };
  parser.onclosetag = (name) => {
    if (localXmlName(name) === activeColorName) activeColorName = null;
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    parserError = parserError || error;
  }
  if (parserError) {
    fail('BIFF8_INVALID_THEME_XML', `无法解析 BIFF8 theme1.xml：${parserError.message}`, {}, parserError);
  }
  const colors = THEME_COLOR_NAMES.map((name) => colorsByName.get(name) || null);
  const missing = THEME_COLOR_NAMES.filter((name, index) => !colors[index]);
  if (missing.length) {
    fail(
      'BIFF8_INCOMPLETE_THEME_COLORS',
      `BIFF8 theme1.xml 缺少主题色：${missing.join(', ')}`,
      { missing }
    );
  }
  return colors.map((rgb) => normalizeRgb(rgb));
}

function normalizeFont(font, palette) {
  return {
    name: font.name,
    size: font.sizePoints,
    bold: font.bold,
    italic: font.italic,
    underline: font.underline,
    strike: font.strike,
    outline: font.outline,
    shadow: font.shadow,
    vertAlign: font.vertAlign,
    familyCode: font.familyCode,
    charset: font.charset,
    colorArgb: resolveIndexedColor(font.indexedColor, palette, 'font'),
    raw: font
  };
}

function normalizeBorderSide(styleCode, colorIndex, palette, sideName) {
  if (!Number.isInteger(styleCode) || styleCode < 0 || styleCode >= BORDER_STYLES.length) {
    fail(
      'BIFF8_UNKNOWN_BORDER_STYLE',
      `XF ${sideName} border style code 无法解析：${styleCode}`,
      { sideName, styleCode }
    );
  }
  if (styleCode === 0) return null;
  if (colorIndex === 0) {
    fail(
      'BIFF8_MISSING_BORDER_COLOR',
      `XF ${sideName} border 有线型但没有颜色`,
      { sideName, styleCode, colorIndex }
    );
  }
  return {
    style: BORDER_STYLES[styleCode],
    colorArgb: resolveIndexedColor(colorIndex, palette, 'border')
  };
}

function normalizeRotation(rotationCode) {
  if (rotationCode === 255) return 'vertical';
  if (rotationCode >= 0 && rotationCode <= 90) return rotationCode;
  if (rotationCode >= 91 && rotationCode <= 180) return 90 - rotationCode;
  fail('BIFF8_UNKNOWN_TEXT_ROTATION', `XF text rotation code 无法解析：${rotationCode}`, { rotationCode });
}

function normalizeAlignment(alignment) {
  if (
    alignment.horizontalCode >= HORIZONTAL_ALIGNMENTS.length
    || alignment.verticalCode >= VERTICAL_ALIGNMENTS.length
    || alignment.readingOrderCode > 2
  ) {
    fail('BIFF8_UNKNOWN_ALIGNMENT', 'XF alignment code 无法解析', { alignment });
  }
  return {
    horizontal: HORIZONTAL_ALIGNMENTS[alignment.horizontalCode],
    vertical: VERTICAL_ALIGNMENTS[alignment.verticalCode],
    wrapText: alignment.wrapText,
    justifyLastLine: alignment.justifyLastLine,
    textRotation: normalizeRotation(alignment.rotationCode),
    indent: alignment.indent,
    shrinkToFit: alignment.shrinkToFit,
    readingOrder: ['context', 'leftToRight', 'rightToLeft'][alignment.readingOrderCode]
  };
}

function normalizeFill(fill, palette) {
  if (!Number.isInteger(fill.patternCode) || fill.patternCode < 0 || fill.patternCode >= FILL_PATTERNS.length) {
    fail('BIFF8_UNKNOWN_FILL_PATTERN', `XF fill pattern code 无法解析：${fill.patternCode}`, {
      patternCode: fill.patternCode
    });
  }
  return {
    type: 'pattern',
    pattern: FILL_PATTERNS[fill.patternCode],
    foregroundArgb: resolveIndexedColor(fill.foregroundColorIndex, palette, 'fillForeground'),
    backgroundArgb: resolveIndexedColor(fill.backgroundColorIndex, palette, 'fillBackground')
  };
}

function cloneStyleComponent(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toToolboxStaticStyle(style) {
  const borderSide = (side) => {
    if (!side) return {};
    const output = {};
    if (side.style) output.style = side.style;
    if (side.colorArgb) output.color = { argb: side.colorArgb };
    return output;
  };
  return {
    numFmt: style.numFmt,
    font: {
      name: style.font.name,
      size: style.font.size,
      bold: style.font.bold,
      italic: style.font.italic,
      underline: style.font.underline || false,
      strike: style.font.strike,
      vertAlign: style.font.vertAlign,
      color: { argb: style.font.colorArgb }
    },
    fill: {
      type: 'pattern',
      pattern: style.fill.pattern,
      fgColor: { argb: style.fill.foregroundArgb },
      bgColor: { argb: style.fill.backgroundArgb }
    },
    border: {
      left: borderSide(style.border.left),
      right: borderSide(style.border.right),
      top: borderSide(style.border.top),
      bottom: borderSide(style.border.bottom)
    },
    alignment: {
      horizontal: style.alignment.horizontal === 'general' ? null : style.alignment.horizontal,
      vertical: style.alignment.vertical,
      wrapText: style.alignment.wrapText,
      textRotation: style.alignment.textRotation,
      indent: style.alignment.indent
    }
  };
}

function applyXfExtensions(style, extension, colorOptions) {
  if (!extension) return style;
  const seenTypes = new Set();
  for (const property of extension.properties) {
    if (seenTypes.has(property.extType)) {
      fail(
        'BIFF8_DUPLICATE_XFEXT_PROPERTY',
        `XF ${extension.xfIndex} 的 XFExt property ${property.extType} 重复`,
        { xfIndex: extension.xfIndex, extType: property.extType }
      );
    }
    seenTypes.add(property.extType);
    const color = (context) => resolveFullColor(property.value, { ...colorOptions, context });
    switch (property.extType) {
      case 0x04: {
        const value = color('fillForeground');
        if (value) style.fill.foregroundArgb = value;
        break;
      }
      case 0x05: {
        const value = color('fillBackground');
        if (value) style.fill.backgroundArgb = value;
        break;
      }
      case 0x07:
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b: {
        const side = {
          0x07: 'top',
          0x08: 'bottom',
          0x09: 'left',
          0x0a: 'right',
          0x0b: 'diagonal'
        }[property.extType];
        const value = color('border');
        if (value && style.border[side]) style.border[side].colorArgb = value;
        break;
      }
      case 0x0d: {
        const value = color('font');
        if (value) style.font.colorArgb = value;
        break;
      }
      case 0x0e:
        if (![0, 1, 2].includes(property.value)) {
          fail(
            'BIFF8_UNKNOWN_FONT_SCHEME',
            `XF ${extension.xfIndex} 的 font scheme 无法解析：${property.value}`,
            { xfIndex: extension.xfIndex, value: property.value }
          );
        }
        style.font.scheme = [null, 'major', 'minor'][property.value];
        break;
      case 0x0f:
        if (!Number.isInteger(property.value) || property.value < 0 || property.value > 15) {
          fail(
            'BIFF8_INVALID_XFEXT_INDENT',
            `XF ${extension.xfIndex} 的 extended indent 非法：${property.value}`,
            { xfIndex: extension.xfIndex, value: property.value }
          );
        }
        style.alignment.indent = property.value;
        break;
      case 0x06:
        fail(
          'BIFF8_UNSUPPORTED_XFEXT_GRADIENT',
          `XF ${extension.xfIndex} 使用不在本版保真范围的 gradient fill`,
          { xfIndex: extension.xfIndex }
        );
        break;
      default:
        fail(
          'BIFF8_UNKNOWN_REQUIRED_XFEXT',
          `XF ${extension.xfIndex} 使用未知 XFExt property 0x${property.extType.toString(16).toUpperCase()}`,
          { xfIndex: extension.xfIndex, extType: property.extType }
        );
    }
  }
  return style;
}

function normalizeXfs(raw, palette, themeColors) {
  const extensions = new Map(raw.xfExts.map((entry) => [entry.xfIndex, entry]));
  return raw.xfs.map((xf) => {
    const font = normalizeFont(raw.fonts[xf.fontRecordIndex], palette);
    const diagonal = normalizeBorderSide(
      xf.border.diagonalStyleCode,
      xf.border.diagonalColorIndex,
      palette,
      'diagonal'
    );
    const style = {
      index: xf.index,
      kind: xf.isStyle ? 'style' : 'cell',
      parentXfIndex: xf.parentXfIndex,
      lineageOnly: true,
      usedAttributes: xf.usedAttributes,
      numFmtId: xf.numFmtId,
      numFmt: raw.formats.get(xf.numFmtId),
      font,
      fill: normalizeFill(xf.fill, palette),
      border: {
        left: normalizeBorderSide(xf.border.leftStyleCode, xf.border.leftColorIndex, palette, 'left'),
        right: normalizeBorderSide(xf.border.rightStyleCode, xf.border.rightColorIndex, palette, 'right'),
        top: normalizeBorderSide(xf.border.topStyleCode, xf.border.topColorIndex, palette, 'top'),
        bottom: normalizeBorderSide(xf.border.bottomStyleCode, xf.border.bottomColorIndex, palette, 'bottom'),
        diagonal: diagonal
          ? {
              ...diagonal,
              up: (xf.border.diagonalFlags & 0x02) !== 0,
              down: (xf.border.diagonalFlags & 0x01) !== 0
            }
          : null
      },
      alignment: normalizeAlignment(xf.alignment),
      protection: cloneStyleComponent(xf.protection),
      quotePrefix: xf.quotePrefix,
      pivotButton: xf.pivotButton,
      raw: xf,
      xfExtension: extensions.get(xf.index) || null
    };
    const extendedStyle = applyXfExtensions(style, extensions.get(xf.index), { palette, themeColors });
    extendedStyle.staticStyle = toToolboxStaticStyle(extendedStyle);
    return extendedStyle;
  });
}

function makeNumberFormatTable(raw) {
  return Array.from(raw.formats.entries())
    .map(([id, code]) => ({ id, code }))
    .sort((left, right) => left.id - right.id);
}

async function readBiff8Overlay(input, options = {}) {
  const extracted = extractWorkbookStream(input);
  let raw;
  try {
    raw = scanBiff8WorkbookStream(extracted.stream, {
      builtinFormats: { ...DEFAULT_BUILTIN_FORMATS, ...(options.builtinFormats || {}) }
    });
  } catch (error) {
    if (error instanceof Biff8RecordError) throw error;
    throw error;
  }
  const themeColors = await parseThemeColors(raw.theme);
  const palette = createPalette(raw.palette || []);
  const styles = normalizeXfs(raw, palette, themeColors);

  return {
    format: 'biff8',
    sourcePath: extracted.sourcePath,
    streamName: extracted.streamName,
    streamPath: extracted.streamPath,
    streamLength: raw.streamLength,
    codePage: raw.codePage,
    date1904: raw.date1904,
    workbookDefaultXfIndex: raw.workbookDefaultCellXfIndex,
    numberFormats: makeNumberFormatTable(raw),
    recordDefinedNumberFormatIds: raw.customFormats.map((format) => format.id),
    paletteArgb: palette.map((rgb) => `FF${rgb}`),
    themeColorsArgb: themeColors ? themeColors.map((rgb) => `FF${rgb}`) : null,
    fonts: raw.fonts.map((font) => normalizeFont(font, palette)),
    styles,
    xfCrc: raw.xfCrc,
    sheets: raw.sheets,
    sheetOrder: raw.boundSheets.map((sheet) => ({
      name: sheet.name,
      state: sheet.state,
      type: sheet.type,
      streamOffset: sheet.streamOffset
    }))
  };
}

function sheetLookup(overlay, sheetReference) {
  if (Number.isInteger(sheetReference)) {
    const sheet = overlay.sheets[sheetReference];
    if (!sheet) fail('BIFF8_UNKNOWN_SHEET', `找不到 BIFF8 sheet index ${sheetReference}`);
    return sheet;
  }
  const matches = overlay.sheets.filter((sheet) => sheet.name === sheetReference);
  if (matches.length !== 1) fail('BIFF8_UNKNOWN_SHEET', `找不到 BIFF8 sheet ${String(sheetReference)}`);
  return matches[0];
}

function createBiff8GridResolver(overlay) {
  const styleByIndex = new Map(overlay.styles.map((style) => [style.index, style]));
  const sheetIndexes = overlay.sheets.map((sheet) => ({
    sheet,
    cellByCoordinate: new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])),
    rowByIndex: new Map(sheet.rows.map((row) => [row.row, row]))
  }));
  const indexBySheet = new Map(sheetIndexes.map((entry, index) => [overlay.sheets[index], entry]));

  return {
    resolve(sheetReference, row, column) {
      if (!Number.isInteger(row) || row < 0 || row > 65535 || !Number.isInteger(column) || column < 0 || column > 255) {
        fail('BIFF8_INVALID_GRID_COORDINATE', `BIFF8 grid coordinate 非法：${row},${column}`, { row, column });
      }
      const sheet = sheetLookup(overlay, sheetReference);
      const index = indexBySheet.get(sheet);
      const cell = index.cellByCoordinate.get(`${row}:${column}`);
      let xfIndex;
      let source;
      if (cell) {
        xfIndex = cell.xfIndex;
        source = 'cell';
      } else {
        const rowInfo = index.rowByIndex.get(row);
        if (rowInfo && rowInfo.formatted) {
          xfIndex = rowInfo.xfIndex;
          source = 'row';
        } else {
          const columnInfo = sheet.columns.find(
            (entry) => column >= entry.firstColumn && column <= entry.lastColumn
          );
          if (columnInfo) {
            xfIndex = columnInfo.xfIndex;
            source = 'column';
          } else {
            xfIndex = overlay.workbookDefaultXfIndex;
            source = 'workbookDefault';
          }
        }
      }
      const style = styleByIndex.get(xfIndex);
      if (!style) {
        fail('BIFF8_GRID_XF_OUT_OF_RANGE', `Grid resolver 得到不存在的 XF ${xfIndex}`, {
          sheetName: sheet.name,
          row,
          column,
          source,
          xfIndex
        });
      }
      return { xfIndex, source, style, cell: cell || null };
    }
  };
}

function assertBiff8OverlayMatchesProjection(overlay, projection) {
  if (!projection || !Array.isArray(projection.sheets)) {
    fail('BIFF8_INVALID_PROJECTION', 'BIFF8 overlay projection 必须包含 sheets 数组');
  }
  if (projection.sheets.length !== overlay.sheets.length) {
    fail(
      'BIFF8_OVERLAY_SHEET_COUNT_MISMATCH',
      `BIFF8 overlay sheet 数量 ${overlay.sheets.length} 与值层 ${projection.sheets.length} 不一致`,
      { overlayCount: overlay.sheets.length, projectionCount: projection.sheets.length }
    );
  }
  overlay.sheets.forEach((overlaySheet, sheetIndex) => {
    const projectedSheet = projection.sheets[sheetIndex];
    if (!projectedSheet || projectedSheet.name !== overlaySheet.name) {
      fail(
        'BIFF8_OVERLAY_SHEET_NAME_MISMATCH',
        `BIFF8 sheet ${sheetIndex + 1} 名称与值层不一致`,
        {
          sheetIndex,
          overlayName: overlaySheet.name,
          projectionName: projectedSheet && projectedSheet.name
        }
      );
    }
    if (!Array.isArray(projectedSheet.cells)) {
      fail('BIFF8_INVALID_PROJECTION', `值层 sheet ${overlaySheet.name} 缺少 cells 数组`);
    }
    const overlayCells = new Map(
      overlaySheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])
    );
    const projectedKeys = new Set();
    for (const projectedCell of projectedSheet.cells) {
      const key = `${projectedCell.row}:${projectedCell.column}`;
      if (projectedKeys.has(key)) {
        fail(
          'BIFF8_PROJECTION_DUPLICATE_CELL',
          `值层 ${overlaySheet.name}!${key} 坐标重复`,
          { sheetName: overlaySheet.name, key }
        );
      }
      projectedKeys.add(key);
      const overlayCell = overlayCells.get(key);
      if (!overlayCell) {
        fail(
          'BIFF8_OVERLAY_COORDINATE_MISMATCH',
          `值层 ${overlaySheet.name}!R${projectedCell.row + 1}C${projectedCell.column + 1} 没有 BIFF8 cell record`,
          { sheetName: overlaySheet.name, row: projectedCell.row, column: projectedCell.column }
        );
      }
      if (projectedCell.xfIndex != null && projectedCell.xfIndex !== overlayCell.xfIndex) {
        fail(
          'BIFF8_OVERLAY_XF_MISMATCH',
          `值层与 BIFF8 overlay 的 XF 不一致：${overlaySheet.name}!R${projectedCell.row + 1}C${projectedCell.column + 1}`,
          {
            sheetName: overlaySheet.name,
            row: projectedCell.row,
            column: projectedCell.column,
            overlayXfIndex: overlayCell.xfIndex,
            projectionXfIndex: projectedCell.xfIndex
          }
        );
      }
    }
    if (projectedKeys.size !== overlayCells.size) {
      const missingFromProjection = Array.from(overlayCells.keys()).filter((key) => !projectedKeys.has(key));
      fail(
        'BIFF8_OVERLAY_COORDINATE_MISMATCH',
        `BIFF8 overlay 的 ${overlaySheet.name} 有 ${missingFromProjection.length} 个 cell 未出现在值层`,
        { sheetName: overlaySheet.name, missingFromProjection: missingFromProjection.slice(0, 20) }
      );
    }
  });
  return true;
}

module.exports = {
  OLE_CFB_MAGIC,
  MAX_THEME_ZIP_ENTRIES,
  MAX_THEME_XML_BYTES,
  DEFAULT_OFFICE_THEME_COLORS,
  FILL_PATTERNS,
  BORDER_STYLES,
  HORIZONTAL_ALIGNMENTS,
  VERTICAL_ALIGNMENTS,
  Biff8OverlayError,
  extractWorkbookStream,
  parseThemeColors,
  toToolboxStaticStyle,
  readBiff8Overlay,
  createBiff8GridResolver,
  assertBiff8OverlayMatchesProjection
};
