'use strict';

const sax = require('sax');
const {
  getBuiltinNumberFormat,
  isBuiltinNumberFormat
} = require('./number-date');
const {
  DRAWINGML_NAMESPACES,
  SPREADSHEETML_NAMESPACES,
  exactSaxLocalName,
  namespaceAllowed,
  normalizedSaxAttributes,
  saxAttributeIdentity
} = require('./ooxml-namespaces');

const TOOLBOX_STYLE_BUDGETS = Object.freeze({
  cellXfs: 50_000,
  fonts: 480,
  fills: 240,
  borders: 10_000,
  customNumFmts: 180
});

// Excel/SheetJS 会在部分低编号范围写入 locale 或用户自定义 FORMAT。
// 这些物理声明是权威值；其余低编号保持规范 built-in，禁止被 styles.xml 覆盖。
function isOoxmlPhysicalNumberFormatId(numFmtId) {
  return (numFmtId >= 5 && numFmtId <= 8) ||
    (numFmtId >= 23 && numFmtId <= 26) ||
    (numFmtId >= 41 && numFmtId <= 44) ||
    numFmtId >= 50;
}

const DEFAULT_THEME_COLORS = Object.freeze({
  dk1: 'FF000000',
  lt1: 'FFFFFFFF',
  dk2: 'FF1F497D',
  lt2: 'FFEEECE1',
  accent1: 'FF4F81BD',
  accent2: 'FFC0504D',
  accent3: 'FF9BBB59',
  accent4: 'FF8064A2',
  accent5: 'FF4BACC6',
  accent6: 'FFF79646',
  hlink: 'FF0000FF',
  folHlink: 'FF800080'
});

const THEME_INDEX_KEYS = Object.freeze([
  // SpreadsheetML ST_ThemeColor 索引：0=Light1、1=Dark1、2=Light2、3=Dark2。
  // theme XML 中 clrScheme 的元素顺序（dk1/lt1/…）与这里的数值枚举顺序不同。
  'lt1', 'dk1', 'lt2', 'dk2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink'
]);
const THEME_KEY_BY_LOCAL_NAME = new Map(
  THEME_INDEX_KEYS.map((key) => [key.toLowerCase(), key])
);
const DRAWINGML_COLOR_TRANSFORM_CANONICAL_NAMES = Object.freeze([
  'tint',
  'shade',
  'comp',
  'inv',
  'gray',
  'alpha',
  'alphaOff',
  'alphaMod',
  'hue',
  'hueOff',
  'hueMod',
  'sat',
  'satOff',
  'satMod',
  'lum',
  'lumOff',
  'lumMod',
  'red',
  'redOff',
  'redMod',
  'green',
  'greenOff',
  'greenMod',
  'blue',
  'blueOff',
  'blueMod',
  'gamma',
  'invGamma'
]);
const THEME_CANONICAL_ELEMENT_NAMES = Object.freeze([
  'theme',
  'themeElements',
  'clrScheme',
  'srgbClr',
  'sysClr',
  'extLst',
  ...THEME_INDEX_KEYS,
  ...DRAWINGML_COLOR_TRANSFORM_CANONICAL_NAMES
]);
const THEME_ELEMENTS_BY_CASEFOLD = new Map(
  THEME_CANONICAL_ELEMENT_NAMES.map((name) => [name.toLowerCase(), name])
);
const THEME_RECOGNIZED_ELEMENT_NAMES = new Set(THEME_ELEMENTS_BY_CASEFOLD.keys());
const STYLE_CANONICAL_ELEMENT_NAMES = Object.freeze([
  'styleSheet',
  'numFmts',
  'fonts',
  'fills',
  'borders',
  'cellStyleXfs',
  'cellXfs',
  'colors',
  'indexedColors',
  'rgbColor',
  'numFmt',
  'font',
  'name',
  'sz',
  'b',
  'i',
  'u',
  'strike',
  'vertAlign',
  'color',
  'fill',
  'patternFill',
  'fgColor',
  'bgColor',
  'border',
  'start',
  'end',
  'left',
  'right',
  'top',
  'bottom',
  'diagonal',
  'vertical',
  'horizontal',
  'xf',
  'alignment'
]);
const STYLE_ELEMENTS_BY_CASEFOLD = new Map(
  STYLE_CANONICAL_ELEMENT_NAMES.map((name) => [name.toLowerCase(), name])
);
const STYLE_RECOGNIZED_ELEMENT_NAMES = new Set(STYLE_ELEMENTS_BY_CASEFOLD.keys());

function canonicalAttributeMap(names) {
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

const COLOR_CONSUMED_ATTRIBUTES = canonicalAttributeMap([
  'rgb',
  'theme',
  'indexed',
  'auto',
  'tint'
]);
const STYLE_CONSUMED_ATTRIBUTES = Object.freeze({
  numFmts: canonicalAttributeMap(['count']),
  fonts: canonicalAttributeMap(['count']),
  fills: canonicalAttributeMap(['count']),
  borders: canonicalAttributeMap(['count']),
  cellStyleXfs: canonicalAttributeMap(['count']),
  cellXfs: canonicalAttributeMap(['count']),
  rgbColor: COLOR_CONSUMED_ATTRIBUTES,
  numFmt: canonicalAttributeMap(['numFmtId', 'formatCode']),
  name: canonicalAttributeMap(['val']),
  sz: canonicalAttributeMap(['val']),
  b: canonicalAttributeMap(['val']),
  i: canonicalAttributeMap(['val']),
  u: canonicalAttributeMap(['val']),
  strike: canonicalAttributeMap(['val']),
  vertAlign: canonicalAttributeMap(['val']),
  color: COLOR_CONSUMED_ATTRIBUTES,
  patternFill: canonicalAttributeMap(['patternType']),
  fgColor: COLOR_CONSUMED_ATTRIBUTES,
  bgColor: COLOR_CONSUMED_ATTRIBUTES,
  start: canonicalAttributeMap(['style']),
  end: canonicalAttributeMap(['style']),
  left: canonicalAttributeMap(['style']),
  right: canonicalAttributeMap(['style']),
  top: canonicalAttributeMap(['style']),
  bottom: canonicalAttributeMap(['style']),
  diagonal: canonicalAttributeMap(['style']),
  vertical: canonicalAttributeMap(['style']),
  horizontal: canonicalAttributeMap(['style']),
  xf: canonicalAttributeMap([
    'numFmtId',
    'fontId',
    'fillId',
    'borderId',
    'xfId',
    'applyNumberFormat',
    'applyFont',
    'applyFill',
    'applyBorder',
    'applyAlignment',
    'applyProtection'
  ]),
  alignment: canonicalAttributeMap([
    'horizontal',
    'vertical',
    'wrapText',
    'textRotation',
    'indent'
  ])
});
const THEME_CONSUMED_ATTRIBUTES = Object.freeze({
  srgbClr: canonicalAttributeMap(['val']),
  sysClr: canonicalAttributeMap(['val', 'lastClr'])
});
const OOXML_UNDERLINE_VALUES = new Set([
  'single',
  'double',
  'singleAccounting',
  'doubleAccounting',
  'none'
]);
const OOXML_VERT_ALIGN_VALUES = new Set(['baseline', 'superscript', 'subscript']);
const OOXML_HORIZONTAL_ALIGNMENT_VALUES = new Set([
  'general',
  'left',
  'center',
  'right',
  'fill',
  'justify',
  'centerContinuous',
  'distributed'
]);
const OOXML_VERTICAL_ALIGNMENT_VALUES = new Set([
  'top',
  'center',
  'bottom',
  'justify',
  'distributed'
]);
const OOXML_PATTERN_TYPE_VALUES = new Set([
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
const OOXML_BORDER_STYLE_VALUES = new Set([
  'none',
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
const OOXML_DECIMAL_LEXICAL_PATTERN =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))$/;
const OOXML_DOUBLE_LEXICAL_PATTERN =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

const DEFAULT_INDEXED_COLORS = Object.freeze([
  'FF000000', 'FFFFFFFF', 'FFFF0000', 'FF00FF00', 'FF0000FF', 'FFFFFF00', 'FFFF00FF', 'FF00FFFF',
  'FF000000', 'FFFFFFFF', 'FFFF0000', 'FF00FF00', 'FF0000FF', 'FFFFFF00', 'FFFF00FF', 'FF00FFFF',
  'FF800000', 'FF008000', 'FF000080', 'FF808000', 'FF800080', 'FF008080', 'FFC0C0C0', 'FF808080',
  'FF9999FF', 'FF993366', 'FFFFFFCC', 'FFCCFFFF', 'FF660066', 'FFFF8080', 'FF0066CC', 'FFCCCCFF',
  'FF000080', 'FFFF00FF', 'FFFFFF00', 'FF00FFFF', 'FF800080', 'FF800000', 'FF008080', 'FF0000FF',
  'FF00CCFF', 'FFCCFFFF', 'FFCCFFCC', 'FFFFFF99', 'FF99CCFF', 'FFFF99CC', 'FFCC99FF', 'FFFFCC99',
  'FF3366FF', 'FF33CCCC', 'FF99CC00', 'FFFFCC00', 'FFFF9900', 'FFFF6600', 'FF666699', 'FF969696',
  'FF003366', 'FF339966', 'FF003300', 'FF333300', 'FF993300', 'FF993366', 'FF333399', 'FF333333',
  'FF000000', 'FFFFFFFF'
]);

const DEFAULT_FONT = Object.freeze({
  name: 'Calibri',
  size: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  vertAlign: null,
  color: Object.freeze({ argb: 'FF000000' })
});
const DEFAULT_FILL = Object.freeze({ type: 'pattern', pattern: 'none' });
const DEFAULT_BORDER = Object.freeze({
  left: Object.freeze({}),
  right: Object.freeze({}),
  top: Object.freeze({}),
  bottom: Object.freeze({})
});
const DEFAULT_ALIGNMENT = Object.freeze({
  horizontal: null,
  vertical: null,
  wrapText: false,
  textRotation: 0,
  indent: 0
});
const DEFAULT_STATIC_STYLE = Object.freeze({
  numFmt: 'General',
  font: DEFAULT_FONT,
  fill: DEFAULT_FILL,
  border: DEFAULT_BORDER,
  alignment: DEFAULT_ALIGNMENT
});

function normalizedAttributes(attributes = {}) {
  return normalizedSaxAttributes(attributes);
}

function validateElementCase(nodeOrName, canonicalNames, xmlPart) {
  const exactName = exactSaxLocalName(nodeOrName);
  const canonicalName = canonicalNames.get(exactName.toLowerCase()) || null;
  if (canonicalName && exactName !== canonicalName) {
    throw styleParseError(
      `${xmlPart} 的元素 ${exactName} 大小写无效；规范名称必须为 ${canonicalName}`,
      {
        xmlPart,
        elementName: exactName,
        canonicalElementName: canonicalName
      }
    );
  }
  return {
    canonicalName,
    normalizedName: exactName.toLowerCase()
  };
}

function validateConsumedAttributeCase(attributes, canonicalNames, context = {}) {
  if (!canonicalNames) return;
  for (const [rawName, rawAttribute] of Object.entries(attributes || {})) {
    const identity = saxAttributeIdentity(rawName, rawAttribute);
    if (identity.namespaceDeclaration || identity.prefix) continue;
    const canonicalName = canonicalNames.get(identity.localName.toLowerCase());
    if (canonicalName && identity.localName !== canonicalName) {
      throw styleParseError(
        `${context.xmlPart || 'OOXML'} 的元素 ${context.elementName || ''} ` +
          `属性 ${identity.localName} 大小写无效；规范名称必须为 ${canonicalName}`,
        {
          ...context,
          attributeName: identity.localName,
          canonicalAttributeName: canonicalName
        }
      );
    }
  }
}

function normalizeArgb(value, fallback = 'FF000000') {
  const raw = String(value == null ? '' : value).replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(raw)) return raw;
  if (/^[0-9A-F]{6}$/.test(raw)) return `FF${raw}`;
  return fallback;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const delta = max - min;
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = (gn - bn) / delta + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
  ];
}

function applyTint(argb, tint) {
  const color = normalizeArgb(argb);
  const amount = typeof tint === 'number' ? tint : Number.NaN;
  if (!Number.isFinite(amount) || amount === 0) return color;
  const alpha = color.slice(0, 2);
  const r = Number.parseInt(color.slice(2, 4), 16);
  const g = Number.parseInt(color.slice(4, 6), 16);
  const b = Number.parseInt(color.slice(6, 8), 16);
  const hsl = rgbToHsl(r, g, b);
  hsl.l = amount < 0
    ? hsl.l * (1 + Math.max(-1, amount))
    : hsl.l * (1 - Math.min(1, amount)) + Math.min(1, amount);
  const tinted = hslToRgb(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l)));
  return alpha + tinted.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function styleParseError(message, context = {}) {
  return new ToolboxStyleParseError(message, context);
}

function assertKnownColorAttributes(attributes, allowed, context) {
  for (const name of Object.keys(attributes)) {
    if (name === 'xmlns' || name.includes(':')) continue;
    if (!allowed.has(name)) {
      throw styleParseError(`OOXML 颜色包含无法解释的属性：${name}`, {
        ...context,
        attribute: name,
        value: attributes[name]
      });
    }
  }
}

function parseStrictBoolean(value, context) {
  if (value === true || value === false) return value;
  const lexical = String(value);
  if (lexical === '1' || lexical === 'true') return true;
  if (lexical === '0' || lexical === 'false') return false;
  throw styleParseError('OOXML 颜色 auto 必须为 0/1/true/false', {
    ...context,
    auto: value
  });
}

function parseStrictInteger(value, { min, max, field, context }) {
  const lexical = String(value == null ? '' : value);
  if (!/^\d+$/.test(lexical)) {
    throw styleParseError(`OOXML 颜色 ${field} 必须是整数`, {
      ...context,
      [field]: value
    });
  }
  const parsed = Number(lexical);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw styleParseError(`OOXML 颜色 ${field} 超出合法范围 ${min}..${max}`, {
      ...context,
      [field]: value
    });
  }
  return parsed;
}

function parseOoxmlBoolean(value, { field, context = {}, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === false) return value;
  const lexical = String(value);
  if (lexical === '1' || lexical === 'true') return true;
  if (lexical === '0' || lexical === 'false') return false;
  throw styleParseError(`OOXML ${field} 必须为 0/1/true/false`, {
    ...context,
    field,
    value
  });
}

function parseDeclaredSectionCount(attributes, sectionName) {
  if (attributes.count === undefined) return null;
  const lexical = String(attributes.count);
  if (!/^\d+$/.test(lexical)) {
    throw styleParseError(`styles.xml 的 ${sectionName}.count 必须是非负整数`, {
      xmlPart: 'styles.xml',
      section: sectionName,
      count: attributes.count
    });
  }
  const count = Number(lexical);
  if (!Number.isSafeInteger(count)) {
    throw styleParseError(`styles.xml 的 ${sectionName}.count 必须是非负整数`, {
      xmlPart: 'styles.xml',
      section: sectionName,
      count: attributes.count
    });
  }
  return count;
}

function parseRequiredText(value, { field, context = {} }) {
  if (value === undefined || value === null || !String(value).trim()) {
    throw styleParseError(`OOXML ${field} 必须是非空文本`, {
      ...context,
      field,
      value
    });
  }
  return String(value);
}

function parseAllowedEnum(value, { field, allowed, context = {}, fallback }) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw styleParseError(`OOXML ${field} 缺少必需枚举值`, {
      ...context,
      field,
      value
    });
  }
  const lexical = String(value);
  if (!allowed.has(lexical)) {
    throw styleParseError(`OOXML ${field} 包含未知枚举值：${lexical}`, {
      ...context,
      field,
      value: lexical
    });
  }
  return lexical;
}

function parseStrictDecimalNumber(
  value,
  { field, context = {}, allowScientific = false }
) {
  const lexical = String(value == null ? '' : value);
  const pattern = allowScientific
    ? OOXML_DOUBLE_LEXICAL_PATTERN
    : OOXML_DECIMAL_LEXICAL_PATTERN;
  if (!pattern.test(lexical)) {
    throw styleParseError(`OOXML ${field} 必须是合法十进制数值`, {
      ...context,
      field,
      value
    });
  }
  const parsed = Number(lexical);
  if (!Number.isFinite(parsed)) {
    throw styleParseError(`OOXML ${field} 必须是有限十进制数值`, {
      ...context,
      field,
      value
    });
  }
  return parsed;
}

function parsePositiveFiniteNumber(value, { field, context = {} }) {
  const parsed = parseStrictDecimalNumber(value, {
    field,
    context,
    allowScientific: true
  });
  if (parsed <= 0) {
    throw styleParseError(`OOXML ${field} 必须是大于 0 的有限数值`, {
      ...context,
      field,
      value
    });
  }
  return parsed;
}

function parseNonNegativeInteger(value, { field, context = {}, fallback = 0 }) {
  if (value === undefined || value === null) return fallback;
  const lexical = String(value);
  if (!/^\d+$/.test(lexical)) {
    throw styleParseError(`OOXML ${field} 必须是非负整数`, {
      ...context,
      field,
      value
    });
  }
  const parsed = Number(lexical);
  if (!Number.isSafeInteger(parsed)) {
    throw styleParseError(`OOXML ${field} 必须是非负整数`, {
      ...context,
      field,
      value
    });
  }
  return parsed;
}

function normalizeExplicitColorSpec(attributes = {}, context = {}) {
  const attrs = normalizedAttributes(attributes);
  const allowed = new Set(['rgb', 'theme', 'indexed', 'auto', 'tint']);
  assertKnownColorAttributes(attrs, allowed, context);
  const selectors = ['rgb', 'theme', 'indexed', 'auto']
    .filter((name) => attrs[name] !== undefined);
  if (selectors.length !== 1) {
    throw styleParseError(
      selectors.length === 0
        ? 'OOXML 显式颜色缺少 rgb/theme/indexed/auto'
        : 'OOXML 显式颜色同时声明了多个颜色来源',
      { ...context, selectors }
    );
  }

  const output = {};
  if (attrs.rgb !== undefined) {
    const rgb = String(attrs.rgb).toUpperCase();
    if (!/^(?:[0-9A-F]{6}|[0-9A-F]{8})$/.test(rgb)) {
      throw styleParseError('OOXML 颜色 rgb 必须是 6 或 8 位十六进制', {
        ...context,
        rgb: attrs.rgb
      });
    }
    output.rgb = rgb;
  } else if (attrs.theme !== undefined) {
    output.theme = parseStrictInteger(attrs.theme, {
      min: 0,
      max: THEME_INDEX_KEYS.length - 1,
      field: 'theme',
      context
    });
  } else if (attrs.indexed !== undefined) {
    output.indexed = parseStrictInteger(attrs.indexed, {
      min: 0,
      max: DEFAULT_INDEXED_COLORS.length - 1,
      field: 'indexed',
      context
    });
  } else {
    output.auto = parseStrictBoolean(attrs.auto, context);
  }

  if (attrs.tint !== undefined) {
    const tint = parseStrictDecimalNumber(attrs.tint, {
      field: '颜色 tint',
      context,
      allowScientific: true
    });
    if (tint < -1 || tint > 1) {
      throw styleParseError('OOXML 颜色 tint 超出合法范围 -1..1', {
        ...context,
        tint: attrs.tint
      });
    }
    output.tint = tint;
  }
  return output;
}

function parseThemeColors(themeXml, options = {}) {
  const xml = String(themeXml || '');
  if (!xml.trim()) {
    if (options.requireXml) throw styleParseError('theme.xml 为空或已损坏');
    return Object.freeze({ ...DEFAULT_THEME_COLORS });
  }

  const colors = {};
  const stack = [];
  const seenThemeKeys = new Set();
  let rootSeen = false;
  let rootClosed = false;
  let themeElementsSeen = false;
  let themeElementsClosed = false;
  let themeElementsDepth = -1;
  let mainSchemeDepth = -1;
  let mainSchemeSeen = false;
  let mainSchemeClosed = false;
  let currentKey = null;
  let currentKeyDepth = -1;
  let currentKeyHasColor = false;
  let currentColorElement = null;
  let currentColorDepth = -1;
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    xmlns: true
  });
  parser.onopentag = (node) => {
    const elementName = validateElementCase(
      node,
      THEME_ELEMENTS_BY_CASEFOLD,
      'theme.xml'
    );
    const name = elementName.normalizedName;
    const attrs = normalizedAttributes(node.attributes);
    const depth = stack.length + 1;
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (THEME_RECOGNIZED_ELEMENT_NAMES.has(name) &&
        !namespaceAllowed(node.uri, DRAWINGML_NAMESPACES)) {
      throw styleParseError(`theme.xml 的 ${name} 使用了不受支持的命名空间`, {
        xmlPart: 'theme.xml',
        element: name,
        namespace: node.uri || ''
      });
    }
    if (currentColorElement && depth > currentColorDepth) {
      throw styleParseError(
        `theme.xml 的 ${currentKey} ${currentColorElement} 包含未实现的颜色 transform：${name}`,
        {
          xmlPart: 'theme.xml',
          themeKey: currentKey,
          colorType: currentColorElement,
          transform: name,
          namespace: node.uri || ''
        }
      );
    }
    if (depth === 1 && name !== 'theme') {
      throw styleParseError('theme.xml 根元素必须为 theme', {
        xmlPart: 'theme.xml',
        rootElement: name
      });
    }
    if (name === 'theme') {
      if (rootSeen || depth !== 1) {
        throw styleParseError('theme.xml 包含重复或嵌套的 theme 根节点');
      }
      rootSeen = true;
    } else if (name === 'themeelements') {
      if (parent !== 'theme' || depth !== 2) {
        throw styleParseError('themeElements 必须是 theme 的直接子元素', {
          xmlPart: 'theme.xml',
          parentElement: parent
        });
      }
      if (themeElementsSeen) {
        throw styleParseError('theme.xml 重复声明 themeElements 节点', {
          xmlPart: 'theme.xml'
        });
      }
      themeElementsSeen = true;
      themeElementsDepth = depth;
    } else if (name === 'clrscheme' && parent === 'themeelements' &&
               depth === themeElementsDepth + 1) {
      if (mainSchemeSeen) {
        throw styleParseError('theme.xml 重复声明主 clrScheme 节点', {
          xmlPart: 'theme.xml'
        });
      }
      mainSchemeSeen = true;
      mainSchemeDepth = depth;
    } else if (name === 'clrscheme' && themeElementsDepth > 0 &&
               depth > themeElementsDepth) {
      throw styleParseError('主 clrScheme 必须是 themeElements 的直接子元素', {
        xmlPart: 'theme.xml',
        parentElement: parent
      });
    } else if (mainSchemeDepth > 0 && depth === mainSchemeDepth + 1 &&
        THEME_KEY_BY_LOCAL_NAME.has(name)) {
      const themeKey = THEME_KEY_BY_LOCAL_NAME.get(name);
      if (seenThemeKeys.has(themeKey)) {
        throw styleParseError(`theme.xml 的 clrScheme 重复声明颜色槽：${themeKey}`, {
          themeKey
        });
      }
      seenThemeKeys.add(themeKey);
      currentKey = themeKey;
      currentKeyDepth = depth;
      currentKeyHasColor = false;
    } else if (mainSchemeDepth > 0 && depth === mainSchemeDepth + 1 &&
        name !== 'extlst') {
      throw styleParseError(`theme.xml 的 clrScheme 包含未知颜色槽：${name}`, {
        xmlPart: 'theme.xml',
        themeKey: name
      });
    } else if (currentKey && depth === currentKeyDepth + 1 &&
        (name === 'srgbclr' || name === 'sysclr')) {
      if (currentKeyHasColor) {
        throw styleParseError(`theme.xml 的 ${currentKey} 同时声明多个颜色值`, {
          themeKey: currentKey
        });
      }
      validateConsumedAttributeCase(
        node.attributes,
        THEME_CONSUMED_ATTRIBUTES[elementName.canonicalName],
        {
          xmlPart: 'theme.xml',
          elementName: elementName.canonicalName,
          themeKey: currentKey
        }
      );
      const allowed = name === 'srgbclr'
        ? new Set(['val'])
        : new Set(['val', 'lastclr']);
      assertKnownColorAttributes(attrs, allowed, {
        xmlPart: 'theme.xml',
        themeKey: currentKey,
        colorType: name
      });
      const candidate = name === 'srgbclr' ? attrs.val : attrs.lastclr;
      if (!candidate || !/^[0-9A-Fa-f]{6}$/.test(String(candidate))) {
        throw styleParseError(
          name === 'srgbclr'
            ? `theme.xml 的 ${currentKey} srgbClr.val 必须是 6 位十六进制`
            : `theme.xml 的 ${currentKey} sysClr.lastClr 必须是 6 位十六进制`,
          {
            xmlPart: 'theme.xml',
            themeKey: currentKey,
            colorType: name,
            value: candidate
          }
        );
      }
      colors[currentKey] = normalizeArgb(candidate);
      currentKeyHasColor = true;
      currentColorElement = name;
      currentColorDepth = depth;
    }
    stack.push(name);
  };
  parser.onclosetag = (rawName) => {
    const name = localName(rawName);
    const depth = stack.length;
    const openName = stack[stack.length - 1];
    if (openName !== name) {
      throw styleParseError('theme.xml 元素闭合顺序无效', {
        xmlPart: 'theme.xml',
        openElement: openName || null,
        closeElement: name
      });
    }
    if (currentKey && name === currentKey.toLowerCase() && depth === currentKeyDepth) {
      if (!currentKeyHasColor) {
        throw styleParseError(`theme.xml 的 ${currentKey} 缺少可解释的 srgbClr/sysClr`, {
          themeKey: currentKey
        });
      }
      currentKey = null;
      currentKeyDepth = -1;
      currentKeyHasColor = false;
    }
    if (currentColorElement && name === currentColorElement && depth === currentColorDepth) {
      currentColorElement = null;
      currentColorDepth = -1;
    }
    if (name === 'clrscheme' && depth === mainSchemeDepth) {
      mainSchemeClosed = true;
      mainSchemeDepth = -1;
    }
    if (name === 'themeelements' && depth === themeElementsDepth) {
      themeElementsClosed = true;
      themeElementsDepth = -1;
    }
    if (name === 'theme' && depth === 1) rootClosed = true;
    stack.pop();
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ToolboxStyleParseError) throw error;
    throw styleParseError(`theme.xml 不是完整有效的 XML：${error.message}`, {
      xmlPart: 'theme.xml',
      cause: error.message
    });
  }
  if (!rootSeen || !rootClosed || !themeElementsSeen || !themeElementsClosed ||
      !mainSchemeSeen || !mainSchemeClosed ||
      stack.length !== 0 || currentKey || currentColorElement) {
    throw styleParseError('theme.xml 根节点或 clrScheme 颜色节点未完整闭合', {
      xmlPart: 'theme.xml'
    });
  }
  const missingThemeKeys = THEME_INDEX_KEYS.filter((key) => !seenThemeKeys.has(key));
  if (missingThemeKeys.length > 0) {
    throw styleParseError(
      `theme.xml 的 clrScheme 缺少必需颜色槽：${missingThemeKeys.join(', ')}`,
      {
        xmlPart: 'theme.xml',
        missingThemeKeys
      }
    );
  }
  return Object.freeze(colors);
}

function resolveColorSpec(spec, options = {}) {
  if (!spec) return null;
  const normalizedSpec = normalizeExplicitColorSpec(spec, options.context || {});
  const themeColors = options.themeColors || DEFAULT_THEME_COLORS;
  const indexedColors = options.indexedColors || DEFAULT_INDEXED_COLORS;
  const fallback = normalizeArgb(options.fallback || 'FF000000');
  let argb = fallback;

  if (normalizedSpec.rgb) {
    argb = normalizeArgb(normalizedSpec.rgb, fallback);
  } else if (normalizedSpec.theme !== undefined && normalizedSpec.theme !== null) {
    const key = THEME_INDEX_KEYS[normalizedSpec.theme];
    argb = key && themeColors[key] ? normalizeArgb(themeColors[key], fallback) : fallback;
  } else if (normalizedSpec.indexed !== undefined && normalizedSpec.indexed !== null) {
    const index = normalizedSpec.indexed;
    argb = indexedColors[index] ? normalizeArgb(indexedColors[index], fallback) : fallback;
  } else if (normalizedSpec.auto !== undefined) {
    argb = fallback;
  }

  return applyTint(argb, normalizedSpec.tint);
}

function rawColorSpec(attributes = {}, context = {}) {
  if (!attributes || typeof attributes !== 'object') return null;
  return normalizeExplicitColorSpec(attributes, context);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeFont(font = {}) {
  const output = {
    name: String(font.name || DEFAULT_FONT.name),
    size: Number.isFinite(Number(font.size)) ? Number(font.size) : DEFAULT_FONT.size,
    bold: !!font.bold,
    italic: !!font.italic,
    underline: font.underline || false,
    strike: !!font.strike,
    vertAlign: font.vertAlign || null,
    color: { argb: normalizeArgb(font.color && font.color.argb, 'FF000000') }
  };
  return deepFreeze(output);
}

function normalizeFill(fill = {}) {
  const pattern = String(fill.pattern || 'none');
  const output = { type: 'pattern', pattern };
  if (fill.fgColor && fill.fgColor.argb) {
    output.fgColor = { argb: normalizeArgb(fill.fgColor.argb, 'FFFFFFFF') };
  }
  if (fill.bgColor && fill.bgColor.argb) {
    output.bgColor = { argb: normalizeArgb(fill.bgColor.argb, 'FFFFFFFF') };
  }
  return deepFreeze(output);
}

function normalizeBorderSide(side = {}) {
  const output = {};
  if (side.style) output.style = String(side.style);
  if (side.color && side.color.argb) {
    output.color = { argb: normalizeArgb(side.color.argb, 'FF000000') };
  }
  return deepFreeze(output);
}

function normalizeBorder(border = {}) {
  return deepFreeze({
    left: normalizeBorderSide(border.left),
    right: normalizeBorderSide(border.right),
    top: normalizeBorderSide(border.top),
    bottom: normalizeBorderSide(border.bottom)
  });
}

function normalizeTextRotation(value) {
  if (value === 'vertical') return 'vertical';
  const numeric = Number(value == null || value === '' ? 0 : value);
  if (!Number.isInteger(numeric) || numeric < -90 || numeric > 90) {
    throw new ToolboxStyleParseError('文本旋转角度超出 ExcelJS 可表示范围', {
      textRotation: value
    });
  }
  return numeric;
}

function parseOoxmlTextRotation(value) {
  if (value === undefined || value === null) return 0;
  const numeric = parseNonNegativeInteger(value, {
    field: 'alignment.textRotation',
    context: { xmlPart: 'styles.xml', component: 'alignment' },
    fallback: 0
  });
  if (numeric === 255) return 'vertical';
  if (numeric >= 0 && numeric <= 90) return numeric;
  if (numeric >= 91 && numeric <= 180) return 90 - numeric;
  throw new ToolboxStyleParseError('OOXML textRotation 超出 0..180/255 范围', {
    textRotation: value
  });
}

function normalizeAlignment(alignment = {}) {
  const textRotation = normalizeTextRotation(alignment.textRotation);
  const vertical = alignment.vertical === 'center'
    ? 'middle'
    : (alignment.vertical || null);
  return deepFreeze({
    horizontal: alignment.horizontal || null,
    vertical,
    wrapText: !!alignment.wrapText,
    textRotation,
    indent: Number.isFinite(Number(alignment.indent)) ? Number(alignment.indent) : 0
  });
}

function normalizeStaticStyle(style = {}) {
  return deepFreeze({
    numFmt: String(style.numFmt == null ? 'General' : style.numFmt),
    font: normalizeFont(style.font || DEFAULT_FONT),
    fill: normalizeFill(style.fill || DEFAULT_FILL),
    border: normalizeBorder(style.border || DEFAULT_BORDER),
    alignment: normalizeAlignment(style.alignment || DEFAULT_ALIGNMENT)
  });
}

function stableSignature(value) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSignature).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSignature(value[key])}`).join(',')}}`;
}

class SourceStyleRegistry {
  constructor(sourceRegistryId, options = {}) {
    if (!sourceRegistryId) throw new TypeError('SourceStyleRegistry 需要 sourceRegistryId');
    this.sourceRegistryId = String(sourceRegistryId);
    this._styles = [];
    this._signatureToRef = new Map();
    this._xfRefs = [];
    this.defaultStyleRef = this.register(options.defaultStyle || DEFAULT_STATIC_STYLE);
  }

  register(style) {
    const normalized = normalizeStaticStyle(style);
    const signature = stableSignature(normalized);
    if (this._signatureToRef.has(signature)) return this._signatureToRef.get(signature);
    const styleRef = this._styles.length;
    this._styles.push(normalized);
    this._signatureToRef.set(signature, styleRef);
    return styleRef;
  }

  bindXf(sourceStyleId, style) {
    const id = Number.parseInt(sourceStyleId, 10);
    if (!Number.isInteger(id) || id < 0) throw new TypeError('sourceStyleId 必须为非负整数');
    const styleRef = this.register(style);
    this._xfRefs[id] = styleRef;
    if (id === 0) this.defaultStyleRef = styleRef;
    return styleRef;
  }

  styleRefForXf(sourceStyleId) {
    const id = Number.parseInt(sourceStyleId, 10);
    return Number.isInteger(id) && this._xfRefs[id] !== undefined
      ? this._xfRefs[id]
      : this.defaultStyleRef;
  }

  hasXf(sourceStyleId) {
    const id = Number.parseInt(sourceStyleId, 10);
    return Number.isInteger(id) && id >= 0 && this._xfRefs[id] !== undefined;
  }

  effectiveStyleRef({ cellStyleId, rowStyleId, rowCustomFormat, columnStyleId } = {}) {
    if (cellStyleId !== null && cellStyleId !== undefined) return this.styleRefForXf(cellStyleId);
    if (rowCustomFormat && rowStyleId !== null && rowStyleId !== undefined) {
      return this.styleRefForXf(rowStyleId);
    }
    if (columnStyleId !== null && columnStyleId !== undefined) {
      return this.styleRefForXf(columnStyleId);
    }
    return this.defaultStyleRef;
  }

  compoundRef(styleRef) {
    return Object.freeze({
      sourceRegistryId: this.sourceRegistryId,
      styleRef
    });
  }

  get(styleRef) {
    const style = this._styles[styleRef];
    if (!style) throw new RangeError(`未知来源样式引用：${styleRef}`);
    return style;
  }

  get size() {
    return this._styles.length;
  }
}

class ToolboxStyleBudgetError extends Error {
  constructor({ component, projectedCount, budget, source }) {
    const sourceLabel = source ? `（来源：${typeof source === 'string' ? source : stableSignature(source)}）` : '';
    super(`工具箱输出样式预算超限：${component} 预计 ${projectedCount}，预算 ${budget}${sourceLabel}`);
    this.name = 'ToolboxStyleBudgetError';
    this.code = 'TOOLBOX_STYLE_BUDGET_EXCEEDED';
    this.component = component;
    this.projectedCount = projectedCount;
    this.budget = budget;
    this.source = source || null;
  }
}

class ToolboxStyleParseError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'ToolboxStyleParseError';
    this.code = 'TOOLBOX_STYLE_PARSE_INVALID';
    this.context = { ...context };
  }
}

class OutputStyleRegistry {
  constructor(options = {}) {
    this.budgets = Object.freeze({ ...TOOLBOX_STYLE_BUDGETS, ...(options.budgets || {}) });
    this._baseCellXfCount = 1;
    this._styles = [];
    this._styleSignatures = new Map();
    this._fonts = new Set();
    this._fills = new Set();
    this._borders = new Set();
    this._customNumFmts = new Set();

    // ExcelJS writer 的初始 workbook 至少带 Normal XF、Calibri、none/gray125 fill 和空 border。
    // 先注册这些基项，使 projectedFinalCounts 从 writer 真实底座起算。
    const defaultStyle = normalizeStaticStyle(options.defaultStyle || DEFAULT_STATIC_STYLE);
    // ExcelJS font0 使用 theme=1 + family/scheme；来源 theme/indexed 色在进入统一模型前已转成
    // ARGB，因此即使可见均为黑色，writer 仍会生成一个不同 font component。用独立 base
    // signature 计数，不能把规范化来源默认字体与 writer font0 错误去重。
    this._fonts.add('__exceljs_writer_default_theme_font__');
    this._fills.add(stableSignature(defaultStyle.fill));
    this._fills.add(stableSignature(normalizeFill({ type: 'pattern', pattern: 'gray125' })));
    this._borders.add(stableSignature(defaultStyle.border));

    for (const component of ['cellXfs', 'fonts', 'fills', 'borders', 'customNumFmts']) {
      const count = this._currentCount(component);
      if (count > this.budgets[component]) {
        throw new ToolboxStyleBudgetError({
          component,
          projectedCount: count,
          budget: this.budgets[component],
          source: 'ExcelJS writer default/base styles'
        });
      }
    }
  }

  _currentCount(component) {
    if (component === 'cellXfs') return this._baseCellXfCount + this._styles.length;
    if (component === 'fonts') return this._fonts.size;
    if (component === 'fills') return this._fills.size;
    if (component === 'borders') return this._borders.size;
    return this._customNumFmts.size;
  }

  register(style, sourceContext = null) {
    const normalized = normalizeStaticStyle(style);
    const styleSignature = stableSignature(normalized);
    if (this._styleSignatures.has(styleSignature)) {
      const styleRef = this._styleSignatures.get(styleSignature);
      return { styleRef, style: this._styles[styleRef] };
    }

    const candidates = [
      ['fonts', this._fonts, stableSignature(normalized.font)],
      ['fills', this._fills, stableSignature(normalized.fill)],
      ['borders', this._borders, stableSignature(normalized.border)]
    ];
    if (!isBuiltinNumberFormat(normalized.numFmt)) {
      candidates.push(['customNumFmts', this._customNumFmts, normalized.numFmt]);
    }

    for (const [component, set, signature] of candidates) {
      const projectedCount = set.size + (set.has(signature) ? 0 : 1);
      if (projectedCount > this.budgets[component]) {
        throw new ToolboxStyleBudgetError({
          component,
          projectedCount,
          budget: this.budgets[component],
          source: sourceContext
        });
      }
    }
    const projectedCellXfs = this._currentCount('cellXfs') + 1;
    if (projectedCellXfs > this.budgets.cellXfs) {
      throw new ToolboxStyleBudgetError({
        component: 'cellXfs',
        projectedCount: projectedCellXfs,
        budget: this.budgets.cellXfs,
        source: sourceContext
      });
    }

    for (const [, set, signature] of candidates) set.add(signature);
    const styleRef = this._styles.length;
    this._styles.push(normalized);
    this._styleSignatures.set(styleSignature, styleRef);
    return { styleRef, style: normalized };
  }

  get(styleRef) {
    const style = this._styles[styleRef];
    if (!style) throw new RangeError(`未知输出样式引用：${styleRef}`);
    return style;
  }

  stats() {
    const counts = {
      cellXfs: this._currentCount('cellXfs'),
      fonts: this._fonts.size,
      fills: this._fills.size,
      borders: this._borders.size,
      customNumFmts: this._customNumFmts.size
    };
    return {
      counts,
      // 与现有 writer fallback 的可观测字段同形，便于集成路径统一日志/复核。
      projectedFinalCounts: { ...counts },
      budgets: { ...this.budgets }
    };
  }
}

function localName(name) {
  return exactSaxLocalName(name).toLowerCase();
}

function parseXfAttributes(attributes, context = {}) {
  const id = (name) => {
    const value = attributes[name];
    if (value === undefined) return undefined;
    const lexical = String(value);
    return /^\d+$/.test(lexical) ? Number(lexical) : Number.NaN;
  };
  const flag = (name) => {
    if (attributes[name] === undefined) return undefined;
    return parseOoxmlBoolean(attributes[name], {
      field: name,
      context,
      fallback: undefined
    });
  };
  return {
    numFmtId: id('numfmtid'),
    fontId: id('fontid'),
    fillId: id('fillid'),
    borderId: id('borderid'),
    xfId: id('xfid'),
    applyNumberFormat: flag('applynumberformat'),
    applyFont: flag('applyfont'),
    applyFill: flag('applyfill'),
    applyBorder: flag('applyborder'),
    applyAlignment: flag('applyalignment'),
    applyProtection: flag('applyprotection'),
    alignment: null,
    alignmentPresent: false
  };
}

function parseOoxmlStyles(stylesXml, options = {}) {
  const xml = String(stylesXml || '');
  if (!xml.trim() && options.requireXml) {
    throw new ToolboxStyleParseError('styles.xml 为空或已损坏', {
      xmlPart: 'styles.xml'
    });
  }
  const themeColors = options.themeColors || DEFAULT_THEME_COLORS;
  const customNumFmts = new Map();
  const rawFonts = [];
  const rawFills = [];
  const rawBorders = [];
  const styleXfs = [];
  const cellXfs = [];
  const customIndexedColors = [];
  let section = '';
  let currentFont = null;
  let currentFontDepth = -1;
  let currentFontElements = null;
  let currentFill = null;
  let currentFillDepth = -1;
  let currentFillElements = null;
  let patternFillDepth = -1;
  let patternFillElements = null;
  let currentBorder = null;
  let currentBorderDepth = -1;
  let currentBorderElements = null;
  let currentBorderSide = null;
  let currentBorderSideDepth = -1;
  let currentBorderSideHasColor = false;
  let currentXf = null;
  let currentXfDepth = -1;
  let rootSeen = false;
  let rootClosed = false;
  let depth = 0;
  let rootDepth = -1;
  let sectionDepth = -1;
  let currentSectionCount = null;
  let indexedColorsSeen = false;
  let indexedColorsOpen = false;
  let indexedColorsDepth = -1;
  const seenSections = new Set();
  const elementStack = [];
  const sectionNames = new Set([
    'numfmts',
    'fonts',
    'fills',
    'borders',
    'cellstylexfs',
    'cellxfs',
    'colors'
  ]);
  const countedSectionChildren = new Map([
    ['numfmts', 'numfmt'],
    ['fonts', 'font'],
    ['fills', 'fill'],
    ['borders', 'border'],
    ['cellstylexfs', 'xf'],
    ['cellxfs', 'xf']
  ]);
  const fontElementNames = new Set([
    'name',
    'sz',
    'b',
    'i',
    'u',
    'strike',
    'vertalign',
    'color'
  ]);
  const borderSideNames = new Set([
    'start',
    'end',
    'left',
    'right',
    'top',
    'bottom',
    'diagonal',
    'vertical',
    'horizontal'
  ]);
  const projectedBorderSideNames = new Set(['left', 'right', 'top', 'bottom']);

  function structureError(message, context = {}) {
    return new ToolboxStyleParseError(message, {
      xmlPart: 'styles.xml',
      ...context
    });
  }

  function assertDirectElement(name, parentName, expectedParent, expectedDepth) {
    if (parentName !== expectedParent || depth !== expectedDepth) {
      throw structureError(`${name} 必须是 ${expectedParent} 的直接子元素`, {
        element: name,
        parentElement: parentName,
        expectedParent
      });
    }
  }

  function countDirectSectionEntry(sectionName, entryName, parentName) {
    assertDirectElement(entryName, parentName, sectionName, sectionDepth + 1);
    if (!currentSectionCount || currentSectionCount.section !== sectionName) {
      throw structureError(`${entryName} 不在合法 ${sectionName} section 内`, {
        element: entryName,
        section: sectionName
      });
    }
    currentSectionCount.actualCount += 1;
  }

  function markComponentElement(seen, name, owner) {
    if (seen.has(name)) {
      throw structureError(`${owner} 重复声明 ${name} 节点`, {
        component: owner,
        element: name
      });
    }
    seen.add(name);
  }

  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    xmlns: true
  });
  parser.onopentag = (node) => {
    const elementName = validateElementCase(
      node,
      STYLE_ELEMENTS_BY_CASEFOLD,
      'styles.xml'
    );
    const name = elementName.normalizedName;
    const attrs = normalizedAttributes(node.attributes);
    const validateAttributes = (context = {}) => validateConsumedAttributeCase(
      node.attributes,
      STYLE_CONSUMED_ATTRIBUTES[elementName.canonicalName],
      {
        xmlPart: 'styles.xml',
        elementName: elementName.canonicalName,
        ...context
      }
    );
    if (STYLE_RECOGNIZED_ELEMENT_NAMES.has(name) &&
        !namespaceAllowed(node.uri, SPREADSHEETML_NAMESPACES)) {
      throw structureError(`styles.xml 的 ${name} 使用了不受支持的命名空间`, {
        element: name,
        namespace: node.uri || ''
      });
    }
    depth += 1;
    const parentName = elementStack.length > 0
      ? elementStack[elementStack.length - 1]
      : null;
    if (depth === 1 && name !== 'stylesheet') {
      throw structureError('styles.xml 根元素必须为 styleSheet', {
        rootElement: name
      });
    }
    if (name === 'stylesheet') {
      if (rootSeen || depth !== 1) {
        throw structureError('styles.xml 包含重复或嵌套的 styleSheet 根节点');
      }
      rootSeen = true;
      rootDepth = depth;
      elementStack.push(name);
      return;
    }
    if (sectionNames.has(name)) {
      if (!rootSeen || rootClosed || parentName !== 'stylesheet' || depth !== rootDepth + 1) {
        throw structureError(`${name} 必须是 styleSheet 的直接子元素`, {
          section: name,
          parentElement: parentName
        });
      }
      if (seenSections.has(name)) {
        throw structureError(`styles.xml 重复声明 ${name} 节点`, {
          section: name
        });
      }
      seenSections.add(name);
      section = name;
      sectionDepth = depth;
      validateAttributes({ section: elementName.canonicalName });
      const childName = countedSectionChildren.get(name) || null;
      currentSectionCount = childName
        ? {
            section: name,
            childName,
            declaredCount: parseDeclaredSectionCount(attrs, name),
            actualCount: 0
          }
        : null;
      elementStack.push(name);
      return;
    }

    if (name === 'indexedcolors') {
      assertDirectElement(name, parentName, 'colors', sectionDepth + 1);
      if (section !== 'colors') {
        throw structureError('indexedColors 不在合法 colors section 内', {
          parentElement: parentName
        });
      }
      if (indexedColorsSeen) {
        throw structureError('colors 重复声明 indexedColors 节点', {
          section: 'colors'
        });
      }
      indexedColorsSeen = true;
      indexedColorsOpen = true;
      indexedColorsDepth = depth;
      elementStack.push(name);
      return;
    }

    elementStack.push(name);

    if (name === 'rgbcolor') {
      if (!indexedColorsOpen) {
        throw structureError('rgbColor 必须是 indexedColors 的直接子元素', {
          parentElement: parentName
        });
      }
      assertDirectElement(name, parentName, 'indexedcolors', indexedColorsDepth + 1);
      validateAttributes({ component: 'indexedColors' });
      const spec = rawColorSpec(attrs, {
        xmlPart: 'styles.xml',
        component: 'indexedColors',
        colorIndex: customIndexedColors.length
      });
      if (!spec || !spec.rgb) {
        throw new ToolboxStyleParseError('indexedColors.rgbColor 必须声明有效 rgb', {
          xmlPart: 'styles.xml',
          colorIndex: customIndexedColors.length
        });
      }
      customIndexedColors.push(normalizeArgb(spec.rgb));
      return;
    }

    if (section === 'numfmts' && name === 'numfmt') {
      countDirectSectionEntry('numfmts', name, parentName);
      validateAttributes({ section: 'numFmts' });
      const lexicalId = String(attrs.numfmtid == null ? '' : attrs.numfmtid);
      const id = /^\d+$/.test(lexicalId) ? Number(lexicalId) : Number.NaN;
      if (!Number.isSafeInteger(id) || id < 0 || !attrs.formatcode) {
        throw new ToolboxStyleParseError('styles.xml 的 numFmt 缺少有效 numFmtId/formatCode', {
          xmlPart: 'styles.xml',
          numFmtId: attrs.numfmtid,
          formatCode: attrs.formatcode
        });
      }
      if (!isOoxmlPhysicalNumberFormatId(id)) {
        throw new ToolboxStyleParseError(
          `styles.xml 的 numFmtId ${id} 属于受保护 built-in 编号，不允许物理覆盖`,
          {
            xmlPart: 'styles.xml',
            numFmtId: id,
            formatCode: attrs.formatcode,
            allowedPhysicalRanges: ['5..8', '23..26', '41..44', '50+']
          }
        );
      }
      if (customNumFmts.has(id)) {
        throw new ToolboxStyleParseError(`styles.xml 重复声明 numFmtId：${id}`, {
          xmlPart: 'styles.xml',
          numFmtId: id
        });
      }
      customNumFmts.set(id, String(attrs.formatcode));
      return;
    }

    if (section === 'fonts') {
      if (name === 'font') {
        countDirectSectionEntry('fonts', name, parentName);
        currentFont = {};
        currentFontDepth = depth;
        currentFontElements = new Set();
      } else if (fontElementNames.has(name)) {
        if (!currentFont) {
          throw structureError(`${name} 必须是 font 的直接子元素`, {
            element: name,
            parentElement: parentName
          });
        }
        assertDirectElement(name, parentName, 'font', currentFontDepth + 1);
        markComponentElement(currentFontElements, name, 'font');
        validateAttributes({ component: 'font' });
        if (name === 'name') {
          currentFont.name = parseRequiredText(attrs.val, {
            field: 'font.name.val',
            context: { xmlPart: 'styles.xml', component: 'font' }
          });
        } else if (name === 'sz') {
          currentFont.size = parsePositiveFiniteNumber(attrs.val, {
            field: 'font.sz.val',
            context: { xmlPart: 'styles.xml', component: 'font' }
          });
        }
        else if (name === 'b') {
          currentFont.bold = parseOoxmlBoolean(attrs.val, {
            field: 'font.b.val',
            context: { xmlPart: 'styles.xml', component: 'font' },
            fallback: true
          });
        } else if (name === 'i') {
          currentFont.italic = parseOoxmlBoolean(attrs.val, {
            field: 'font.i.val',
            context: { xmlPart: 'styles.xml', component: 'font' },
            fallback: true
          });
        }
        else if (name === 'u') {
          const value = parseAllowedEnum(attrs.val, {
            field: 'font.u.val',
            allowed: OOXML_UNDERLINE_VALUES,
            context: { xmlPart: 'styles.xml', component: 'font' },
            fallback: 'single'
          });
          currentFont.underline = value === 'none' ? false : value;
        } else if (name === 'strike') {
          currentFont.strike = parseOoxmlBoolean(attrs.val, {
            field: 'font.strike.val',
            context: { xmlPart: 'styles.xml', component: 'font' },
            fallback: true
          });
        }
        else if (name === 'vertalign') {
          currentFont.vertAlign = parseAllowedEnum(attrs.val, {
            field: 'font.vertAlign.val',
            allowed: OOXML_VERT_ALIGN_VALUES,
            context: { xmlPart: 'styles.xml', component: 'font' }
          });
        }
        else if (name === 'color') {
          currentFont.colorSpec = rawColorSpec(attrs, {
            xmlPart: 'styles.xml',
            component: 'font',
            componentIndex: rawFonts.length
          });
        }
      }
      return;
    }

    if (section === 'fills') {
      if (name === 'fill') {
        countDirectSectionEntry('fills', name, parentName);
        currentFill = {};
        currentFillDepth = depth;
        currentFillElements = new Set();
      } else if (name === 'patternfill') {
        if (!currentFill) {
          throw structureError('patternFill 必须是 fill 的直接子元素', {
            parentElement: parentName
          });
        }
        assertDirectElement(name, parentName, 'fill', currentFillDepth + 1);
        markComponentElement(currentFillElements, name, 'fill');
        validateAttributes({ component: 'fill' });
        currentFill.pattern = parseAllowedEnum(attrs.patterntype, {
          field: 'fill.patternFill.patternType',
          allowed: OOXML_PATTERN_TYPE_VALUES,
          context: { xmlPart: 'styles.xml', component: 'fill' },
          fallback: 'none'
        });
        patternFillDepth = depth;
        patternFillElements = new Set();
      } else if (name === 'fgcolor' || name === 'bgcolor') {
        if (!currentFill || patternFillDepth < 0) {
          throw structureError(`${name} 必须是 patternFill 的直接子元素`, {
            parentElement: parentName
          });
        }
        assertDirectElement(name, parentName, 'patternfill', patternFillDepth + 1);
        markComponentElement(patternFillElements, name, 'patternFill');
        validateAttributes({ component: 'fill' });
        if (name === 'fgcolor') {
          currentFill.fgColorSpec = rawColorSpec(attrs, {
            xmlPart: 'styles.xml',
            component: 'fill',
            componentIndex: rawFills.length,
            colorRole: 'foreground'
          });
        } else {
          currentFill.bgColorSpec = rawColorSpec(attrs, {
            xmlPart: 'styles.xml',
            component: 'fill',
            componentIndex: rawFills.length,
            colorRole: 'background'
          });
        }
      }
      return;
    }

    if (section === 'borders') {
      if (name === 'border') {
        countDirectSectionEntry('borders', name, parentName);
        currentBorder = {};
        currentBorderDepth = depth;
        currentBorderElements = new Set();
      } else if (borderSideNames.has(name)) {
        if (!currentBorder) {
          throw structureError(`${name} 必须是 border 的直接子元素`, {
            parentElement: parentName
          });
        }
        assertDirectElement(name, parentName, 'border', currentBorderDepth + 1);
        markComponentElement(currentBorderElements, name, 'border');
        currentBorderSide = name;
        currentBorderSideDepth = depth;
        currentBorderSideHasColor = false;
        validateAttributes({ component: 'border', side: name });
        const borderStyle = parseAllowedEnum(attrs.style, {
          field: `border.${name}.style`,
          allowed: OOXML_BORDER_STYLE_VALUES,
          context: { xmlPart: 'styles.xml', component: 'border', side: name },
          fallback: null
        });
        if (projectedBorderSideNames.has(name)) {
          currentBorder[name] = { style: borderStyle };
        }
      } else if (name === 'color') {
        if (!currentBorder || !currentBorderSide) {
          throw structureError('color 必须是 border side 的直接子元素', {
            parentElement: parentName
          });
        }
        assertDirectElement(name, parentName, currentBorderSide, currentBorderSideDepth + 1);
        if (currentBorderSideHasColor) {
          throw structureError(`border.${currentBorderSide} 重复声明 color 节点`, {
            component: 'border',
            side: currentBorderSide
          });
        }
        validateAttributes({ component: 'border', side: currentBorderSide });
        const colorSpec = rawColorSpec(attrs, {
          xmlPart: 'styles.xml',
          component: 'border',
          componentIndex: rawBorders.length,
          side: currentBorderSide
        });
        if (projectedBorderSideNames.has(currentBorderSide)) {
          currentBorder[currentBorderSide].colorSpec = colorSpec;
        }
        currentBorderSideHasColor = true;
      }
      return;
    }

    if ((section === 'cellstylexfs' || section === 'cellxfs') && name === 'xf') {
      countDirectSectionEntry(section, name, parentName);
      validateAttributes({ section });
      currentXf = parseXfAttributes(attrs, {
        xmlPart: 'styles.xml',
        section,
        xfIndex: currentSectionCount.actualCount - 1
      });
      currentXfDepth = depth;
      return;
    }
    if ((section === 'cellstylexfs' || section === 'cellxfs') && name === 'alignment') {
      if (!currentXf) {
        throw structureError('alignment 必须是 xf 的直接子元素', {
          parentElement: parentName
        });
      }
      assertDirectElement(name, parentName, 'xf', currentXfDepth + 1);
      if (currentXf.alignmentPresent) {
        throw structureError('xf 重复声明 alignment 节点', {
          section
        });
      }
      validateAttributes({ section });
      currentXf.alignmentPresent = true;
      currentXf.alignment = {
        horizontal: parseAllowedEnum(attrs.horizontal, {
          field: 'alignment.horizontal',
          allowed: OOXML_HORIZONTAL_ALIGNMENT_VALUES,
          context: { xmlPart: 'styles.xml', section },
          fallback: null
        }),
        vertical: parseAllowedEnum(attrs.vertical, {
          field: 'alignment.vertical',
          allowed: OOXML_VERTICAL_ALIGNMENT_VALUES,
          context: { xmlPart: 'styles.xml', section },
          fallback: null
        }),
        wrapText: parseOoxmlBoolean(attrs.wraptext, {
          field: 'alignment.wrapText',
          context: { xmlPart: 'styles.xml', section },
          fallback: false
        }),
        textRotation: parseOoxmlTextRotation(attrs.textrotation),
        indent: parseNonNegativeInteger(attrs.indent, {
          field: 'alignment.indent',
          context: { xmlPart: 'styles.xml', section },
          fallback: 0
        })
      };
    }
  };

  parser.onclosetag = (rawName) => {
    const name = localName(rawName);
    const openName = elementStack[elementStack.length - 1];
    if (openName !== name) {
      throw structureError('styles.xml 元素闭合顺序无效', {
        openElement: openName || null,
        closeElement: name
      });
    }
    if (section === 'fonts' && name === 'font' && currentFont &&
        depth === currentFontDepth) {
      rawFonts.push(currentFont);
      currentFont = null;
      currentFontDepth = -1;
      currentFontElements = null;
    } else if (section === 'fills' && name === 'patternfill' &&
               depth === patternFillDepth) {
      patternFillDepth = -1;
      patternFillElements = null;
    } else if (section === 'fills' && name === 'fill' && currentFill &&
               depth === currentFillDepth) {
      rawFills.push(currentFill);
      currentFill = null;
      currentFillDepth = -1;
      currentFillElements = null;
      patternFillDepth = -1;
      patternFillElements = null;
    } else if (section === 'borders' && borderSideNames.has(name) &&
               depth === currentBorderSideDepth) {
      currentBorderSide = null;
      currentBorderSideDepth = -1;
      currentBorderSideHasColor = false;
    } else if (section === 'borders' && name === 'border' && currentBorder &&
               depth === currentBorderDepth) {
      rawBorders.push(currentBorder);
      currentBorder = null;
      currentBorderDepth = -1;
      currentBorderElements = null;
      currentBorderSide = null;
      currentBorderSideDepth = -1;
      currentBorderSideHasColor = false;
    } else if ((section === 'cellstylexfs' || section === 'cellxfs') &&
               name === 'xf' && currentXf && depth === currentXfDepth) {
      (section === 'cellstylexfs' ? styleXfs : cellXfs).push(currentXf);
      currentXf = null;
      currentXfDepth = -1;
    }

    if (name === 'indexedcolors' && depth === indexedColorsDepth) {
      indexedColorsOpen = false;
      indexedColorsDepth = -1;
    }

    if (name === section && depth === sectionDepth) {
      if (currentSectionCount &&
          currentSectionCount.declaredCount !== null &&
          currentSectionCount.declaredCount !== currentSectionCount.actualCount) {
        throw structureError(
          `${section}.count 与实际直属 ${currentSectionCount.childName} 数量不一致`,
          {
            section,
            declaredCount: currentSectionCount.declaredCount,
            actualCount: currentSectionCount.actualCount,
            childElement: currentSectionCount.childName
          }
        );
      }
      section = '';
      sectionDepth = -1;
      currentSectionCount = null;
    }
    if (name === 'stylesheet' && depth === rootDepth) rootClosed = true;
    elementStack.pop();
    depth -= 1;
  };
  if (xml.trim()) {
    try {
      parser.write(xml).close();
    } catch (error) {
      if (error instanceof ToolboxStyleParseError) throw error;
      throw new ToolboxStyleParseError(`styles.xml 不是完整有效的 XML：${error.message}`, {
        xmlPart: 'styles.xml',
        cause: error.message
      });
    }
    if (!rootSeen || !rootClosed || depth !== 0 || elementStack.length !== 0 ||
        section || currentSectionCount || indexedColorsOpen ||
        currentFont || currentFill || currentBorder || currentXf) {
      throw new ToolboxStyleParseError('styles.xml 根节点或样式节点未完整闭合', {
        xmlPart: 'styles.xml'
      });
    }
  }

  const indexedColors = customIndexedColors.length > 0
    ? Object.freeze(DEFAULT_INDEXED_COLORS.map((color, index) => customIndexedColors[index] || color))
    : DEFAULT_INDEXED_COLORS;
  const colorOptions = { themeColors, indexedColors };
  const fonts = rawFonts.map((font) => normalizeFont({
    ...font,
    color: {
      argb: resolveColorSpec(font.colorSpec, {
        ...colorOptions,
        fallback: 'FF000000',
        context: { xmlPart: 'styles.xml', component: 'font' }
      }) || 'FF000000'
    }
  }));
  const fills = rawFills.map((fill) => normalizeFill({
    pattern: fill.pattern,
    fgColor: fill.fgColorSpec
      ? {
          argb: resolveColorSpec(fill.fgColorSpec, {
            ...colorOptions,
            fallback: 'FFFFFFFF',
            context: { xmlPart: 'styles.xml', component: 'fill', colorRole: 'foreground' }
          })
        }
      : null,
    bgColor: fill.bgColorSpec
      ? {
          argb: resolveColorSpec(fill.bgColorSpec, {
            ...colorOptions,
            fallback: 'FFFFFFFF',
            context: { xmlPart: 'styles.xml', component: 'fill', colorRole: 'background' }
          })
        }
      : null
  }));
  const borders = rawBorders.map((border) => {
    const output = {};
    for (const sideName of ['left', 'right', 'top', 'bottom']) {
      const side = border[sideName] || {};
      output[sideName] = {
        style: side.style,
        color: side.colorSpec
          ? {
              argb: resolveColorSpec(side.colorSpec, {
                ...colorOptions,
                fallback: 'FF000000',
                context: { xmlPart: 'styles.xml', component: 'border', side: sideName }
              })
            }
          : null
      };
    }
    return normalizeBorder(output);
  });

  const assertComponentReference = (xf, key, items, xfSection, xfIndex) => {
    const value = xf[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0) {
      throw new ToolboxStyleParseError(`OOXML ${xfSection} 的 ${key} 无效`, {
        xfSection,
        xfIndex,
        key,
        value
      });
    }
    // styles.xml 完全缺省 component 列表时允许默认 id=0；一旦声明列表则必须严格落在范围内。
    if ((items.length === 0 && value !== 0) || (items.length > 0 && value >= items.length)) {
      throw new ToolboxStyleParseError(`OOXML ${xfSection} 的 ${key} 越界`, {
        xfSection,
        xfIndex,
        key,
        value,
        componentCount: items.length
      });
    }
  };
  const assertXf = (xf, xfSection, xfIndex) => {
    assertComponentReference(xf, 'fontId', fonts, xfSection, xfIndex);
    assertComponentReference(xf, 'fillId', fills, xfSection, xfIndex);
    assertComponentReference(xf, 'borderId', borders, xfSection, xfIndex);
    if (xf.numFmtId !== undefined &&
        (!Number.isInteger(xf.numFmtId) || xf.numFmtId < 0 ||
          (xf.numFmtId >= 164 && !customNumFmts.has(xf.numFmtId)))) {
      throw new ToolboxStyleParseError(`OOXML ${xfSection} 的 numFmtId 无效或缺少定义`, {
        xfSection,
        xfIndex,
        numFmtId: xf.numFmtId
      });
    }
    if (xfSection === 'cellXfs' && xf.xfId !== undefined &&
        (!Number.isInteger(xf.xfId) || xf.xfId < 0 ||
          (styleXfs.length === 0 ? xf.xfId !== 0 : xf.xfId >= styleXfs.length))) {
      throw new ToolboxStyleParseError('OOXML cellXfs 的 xfId 越界', {
        xfSection,
        xfIndex,
        xfId: xf.xfId,
        styleXfCount: styleXfs.length
      });
    }
  };
  styleXfs.forEach((xf, index) => assertXf(xf, 'cellStyleXfs', index));
  cellXfs.forEach((xf, index) => assertXf(xf, 'cellXfs', index));

  const component = (items, index, fallback) => Number.isInteger(index) && items[index] ? items[index] : fallback;
  const numberFormat = (id, xfSection, xfIndex) => {
    if (id === undefined || id === null) return 'General';
    if (customNumFmts.has(id)) return customNumFmts.get(id);
    const builtin = getBuiltinNumberFormat(id);
    if (builtin !== null) return builtin;
    throw new ToolboxStyleParseError('OOXML XF 引用了不支持的 built-in numFmtId', {
      xfSection,
      xfIndex,
      numFmtId: id
    });
  };
  const applyComponent = (xf, key, applyKey, parentValue, childValue) => {
    if (xf[applyKey] === false) return parentValue;
    if (xf[applyKey] === true) return childValue;
    return xf[key] === undefined ? parentValue : childValue;
  };

  const resolvedStyleXfs = styleXfs.map((xf, index) => normalizeStaticStyle({
    numFmt: numberFormat(xf.numFmtId, 'cellStyleXfs', index),
    font: component(fonts, xf.fontId, DEFAULT_FONT),
    fill: component(fills, xf.fillId, DEFAULT_FILL),
    border: component(borders, xf.borderId, DEFAULT_BORDER),
    alignment: xf.alignmentPresent ? xf.alignment : DEFAULT_ALIGNMENT
  }));
  const parentFallback = resolvedStyleXfs[0] || DEFAULT_STATIC_STYLE;
  const resolvedCellXfs = cellXfs.map((xf, index) => {
    const parent = component(resolvedStyleXfs, xf.xfId, parentFallback);
    const childNumFmt = numberFormat(xf.numFmtId, 'cellXfs', index);
    const childFont = component(fonts, xf.fontId, parent.font);
    const childFill = component(fills, xf.fillId, parent.fill);
    const childBorder = component(borders, xf.borderId, parent.border);
    const childAlignment = xf.alignmentPresent ? normalizeAlignment(xf.alignment) : parent.alignment;
    return normalizeStaticStyle({
      numFmt: applyComponent(xf, 'numFmtId', 'applyNumberFormat', parent.numFmt, childNumFmt),
      font: applyComponent(xf, 'fontId', 'applyFont', parent.font, childFont),
      fill: applyComponent(xf, 'fillId', 'applyFill', parent.fill, childFill),
      border: applyComponent(xf, 'borderId', 'applyBorder', parent.border, childBorder),
      alignment: xf.applyAlignment === false
        ? parent.alignment
        : xf.alignmentPresent
          ? childAlignment
          : parent.alignment
    });
  });

  if (resolvedCellXfs.length === 0) resolvedCellXfs.push(parentFallback);
  return {
    styles: Object.freeze(resolvedCellXfs),
    themeColors: Object.freeze({ ...themeColors }),
    indexedColors,
    customNumFmts: new Map(customNumFmts)
  };
}

function createSourceStyleRegistryFromOoxml({
  sourceRegistryId,
  stylesXml,
  themeXml,
  requireStylesXml = false,
  requireThemeXml = false
}) {
  const themeColors = parseThemeColors(themeXml, { requireXml: requireThemeXml });
  const parsed = parseOoxmlStyles(stylesXml, {
    themeColors,
    requireXml: requireStylesXml
  });
  const registry = new SourceStyleRegistry(sourceRegistryId, {
    defaultStyle: parsed.styles[0] || DEFAULT_STATIC_STYLE
  });
  parsed.styles.forEach((style, index) => registry.bindXf(index, style));
  return {
    registry,
    themeColors,
    indexedColors: parsed.indexedColors,
    customNumFmts: parsed.customNumFmts
  };
}

module.exports = {
  DEFAULT_ALIGNMENT,
  DEFAULT_BORDER,
  DEFAULT_FILL,
  DEFAULT_FONT,
  DEFAULT_INDEXED_COLORS,
  DEFAULT_STATIC_STYLE,
  DEFAULT_THEME_COLORS,
  OutputStyleRegistry,
  SourceStyleRegistry,
  THEME_INDEX_KEYS,
  TOOLBOX_STYLE_BUDGETS,
  ToolboxStyleBudgetError,
  ToolboxStyleParseError,
  applyTint,
  createSourceStyleRegistryFromOoxml,
  normalizeArgb,
  normalizeStaticStyle,
  parseOoxmlStyles,
  parseOoxmlTextRotation,
  parseThemeColors,
  resolveColorSpec,
  stableSignature
};
