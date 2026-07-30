'use strict';

// BIFF8 的前 64 个颜色索引。0x08..0x3f 可以被 Palette record 覆盖。
// 顺序与 [MS-XLS] Icv 一致；统一输出 8 位 ARGB，避免把 palette/theme index
// 泄漏到使用另一套主题的 XLSX writer。
const DEFAULT_INDEXED_RGB = Object.freeze([
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'
]);

const THEME_COLOR_NAMES = Object.freeze([
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink'
]);

function colorError(code, message, detail = {}) {
  const error = new Error(message);
  error.name = 'Biff8ColorError';
  error.code = code;
  error.detail = detail;
  return error;
}

function normalizeRgb(rgb) {
  const value = String(rgb == null ? '' : rgb).trim().replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(value)) {
    throw colorError('BIFF8_INVALID_RGB', `BIFF8 颜色不是 6 位 RGB：${String(rgb)}`);
  }
  return value;
}

function toArgb(rgb) {
  return `FF${normalizeRgb(rgb)}`;
}

function rgbToHsl(rgb) {
  const value = normalizeRgb(rgb);
  const channels = [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255
  ];
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (lightness > 0.5 ? 2 - max - min : max + min);
  let hue;
  if (max === channels[0]) {
    hue = ((channels[1] - channels[2]) / delta + 6) % 6;
  } else if (max === channels[1]) {
    hue = (channels[2] - channels[0]) / delta + 2;
  } else {
    hue = (channels[0] - channels[1]) / delta + 4;
  }
  return [hue / 6, saturation, lightness];
}

function hslToRgb(hsl) {
  const [hue, saturation, lightness] = hsl;
  const chroma = saturation * 2 * (lightness < 0.5 ? lightness : 1 - lightness);
  const minimum = lightness - chroma / 2;
  const hue6 = hue * 6;
  const rgb = [minimum, minimum, minimum];
  if (saturation !== 0) {
    let x;
    switch (Math.floor(hue6)) {
      case 0:
      case 6:
        x = chroma * hue6;
        rgb[0] += chroma;
        rgb[1] += x;
        break;
      case 1:
        x = chroma * (2 - hue6);
        rgb[0] += x;
        rgb[1] += chroma;
        break;
      case 2:
        x = chroma * (hue6 - 2);
        rgb[1] += chroma;
        rgb[2] += x;
        break;
      case 3:
        x = chroma * (4 - hue6);
        rgb[1] += x;
        rgb[2] += chroma;
        break;
      case 4:
        x = chroma * (hue6 - 4);
        rgb[2] += chroma;
        rgb[0] += x;
        break;
      case 5:
        x = chroma * (6 - hue6);
        rgb[2] += x;
        rgb[0] += chroma;
        break;
      default:
        throw colorError('BIFF8_INVALID_TINT', `BIFF8 tint 计算得到非法 hue：${hue}`);
    }
  }
  return rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255));
}

function applyTint(rgb, tint) {
  const normalized = normalizeRgb(rgb);
  if (!Number.isFinite(tint) || tint < -1 || tint > 1) {
    throw colorError('BIFF8_INVALID_TINT', `BIFF8 tint 超出 -1..1：${String(tint)}`);
  }
  if (tint === 0) return normalized;
  const hsl = rgbToHsl(normalized);
  if (tint < 0) hsl[2] *= 1 + tint;
  else hsl[2] = 1 - (1 - hsl[2]) * (1 - tint);
  return hslToRgb(hsl)
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function createPalette(customEntries = []) {
  if (!Array.isArray(customEntries) || customEntries.length > 56) {
    throw colorError(
      'BIFF8_INVALID_PALETTE',
      `BIFF8 Palette 最多包含 56 个可覆盖颜色，实际 ${Array.isArray(customEntries) ? customEntries.length : '非数组'}`
    );
  }
  const palette = DEFAULT_INDEXED_RGB.slice();
  customEntries.forEach((rgb, index) => {
    palette[index + 8] = normalizeRgb(rgb);
  });
  return palette;
}

function automaticRgb(context) {
  switch (context) {
    case 'fillBackground':
      return 'FFFFFF';
    case 'fillForeground':
    case 'font':
    case 'border':
      return '000000';
    default:
      throw colorError(
        'BIFF8_UNKNOWN_AUTOMATIC_COLOR_CONTEXT',
        `无法解析 BIFF8 automatic color 的使用位置：${String(context)}`
      );
  }
}

function resolveIndexedColor(index, palette, context) {
  if (index === 0x7fff) return toArgb(automaticRgb(context));
  if (index === 0x51) return toArgb('000000');
  if (index === 0x40) return toArgb('000000');
  if (index === 0x41) return toArgb('FFFFFF');
  if (index === 0x48) return toArgb(automaticRgb(context));
  if (!Number.isInteger(index) || index < 0 || index > 0x3f) {
    throw colorError(
      'BIFF8_UNKNOWN_INDEXED_COLOR',
      `无法解析 BIFF8 颜色索引 0x${Number(index).toString(16).toUpperCase()}`,
      { index, context }
    );
  }
  const rgb = palette[index];
  if (!rgb) {
    throw colorError(
      'BIFF8_MISSING_PALETTE_COLOR',
      `BIFF8 颜色索引 ${index} 没有可用 palette 值`,
      { index, context }
    );
  }
  return toArgb(rgb);
}

function resolveFullColor(fullColor, options) {
  const {
    palette,
    themeColors,
    context
  } = options;
  const type = fullColor && fullColor.type;
  const tint = fullColor && fullColor.tint ? fullColor.tint : 0;
  let rgb;
  let alpha = 0xff;

  switch (type) {
    case 'automatic':
      rgb = automaticRgb(context);
      break;
    case 'indexed':
      return tint === 0
        ? resolveIndexedColor(fullColor.index, palette, context)
        : toArgb(applyTint(resolveIndexedColor(fullColor.index, palette, context).slice(2), tint));
    case 'rgb':
      rgb = normalizeRgb(fullColor.rgb);
      if (Number.isInteger(fullColor.alpha) && fullColor.alpha >= 0 && fullColor.alpha <= 0xff) {
        alpha = fullColor.alpha;
      }
      break;
    case 'theme': {
      if (!Number.isInteger(fullColor.theme) || fullColor.theme < 0 || fullColor.theme >= THEME_COLOR_NAMES.length) {
        throw colorError(
          'BIFF8_UNKNOWN_THEME_COLOR',
          `BIFF8 theme color index 越界：${String(fullColor.theme)}`,
          { theme: fullColor.theme, context }
        );
      }
      rgb = themeColors && themeColors[fullColor.theme];
      if (!rgb) {
        throw colorError(
          'BIFF8_MISSING_THEME_COLOR',
          `BIFF8 XFExt 引用了未解析的主题色 ${THEME_COLOR_NAMES[fullColor.theme]}`,
          { theme: fullColor.theme, context }
        );
      }
      rgb = normalizeRgb(rgb);
      break;
    }
    case 'notSet':
      return null;
    default:
      throw colorError(
        'BIFF8_UNKNOWN_XCOLOR_TYPE',
        `无法解析 BIFF8 XFExt 颜色类型：${String(type)}`,
        { type, context }
      );
  }

  return `${alpha.toString(16).padStart(2, '0').toUpperCase()}${applyTint(rgb, tint)}`;
}

module.exports = {
  DEFAULT_INDEXED_RGB,
  THEME_COLOR_NAMES,
  normalizeRgb,
  toArgb,
  applyTint,
  createPalette,
  resolveIndexedColor,
  resolveFullColor
};
