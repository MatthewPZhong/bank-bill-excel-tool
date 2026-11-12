(function exposeDarkModeSchedule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkModeSchedule = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDarkModeScheduleApi() {
  const DEFAULT_DARK_MODE_SCHEDULE = Object.freeze({
    enabled: true,
    startTime: '17:30',
    endTime: '07:00'
  });
  const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  function validateDarkModeSchedule(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || typeof config.enabled !== 'boolean') {
      throw new Error('定时深色模式的启用状态必须是布尔值');
    }
    if (typeof config.startTime !== 'string' || config.startTime.length !== 5 || !TIME_PATTERN.test(config.startTime)
        || typeof config.endTime !== 'string' || config.endTime.length !== 5 || !TIME_PATTERN.test(config.endTime)) {
      throw new Error('开始时间和结束时间必须使用 24 小时制 HH:mm 格式');
    }
    if (config.startTime === config.endTime) {
      throw new Error('开始时间和结束时间不能相同');
    }
    return { enabled: config.enabled, startTime: config.startTime, endTime: config.endTime };
  }

  function normalizeDarkModeSchedule(rawObject) {
    try {
      return validateDarkModeSchedule(rawObject);
    } catch (_error) {
      return { ...DEFAULT_DARK_MODE_SCHEDULE };
    }
  }

  function toMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  function resolveEffectiveTheme(config, date = new Date()) {
    const schedule = normalizeDarkModeSchedule(config);
    if (!schedule.enabled || !(date instanceof Date) || !Number.isFinite(date.getTime())) return 'light';
    const current = date.getHours() * 60 + date.getMinutes();
    const start = toMinutes(schedule.startTime);
    const end = toMinutes(schedule.endTime);
    const active = start < end
      ? current >= start && current < end
      : current >= start || current < end;
    return active ? 'dark' : 'light';
  }

  // 深浅度只作用于深色主题：0 为 styles-dark-mode.css 的原深色，100 最浅。
  const DEFAULT_DARK_MODE_LIGHTNESS = 0;
  const MAX_DARK_MODE_LIGHTNESS = 100;
  // [变量, 最深（须与 CSS 深色块一致）, 最浅, 透明度]；正文、主色与状态文字颜色不随深浅度变化。
  const DARK_MODE_LIGHTNESS_PALETTE = Object.freeze([
    ['--bg', '#111419', '#383d46'],
    ['--bg-soft', '#1a1e25', '#40454f'],
    ['--panel', '#1c2027', '#434953'],
    ['--panel-strong', '#232830', '#4a505b'],
    ['--input', '#191d24', '#3d424c'],
    ['--line', '#373e49', '#5b6370'],
    ['--line-soft', '#2c323b', '#505762'],
    ['--line-strong', '#515e71', '#717d90'],
    ['--muted', '#a6afbf', '#c3cad6'],
    ['--dim', '#778295', '#9aa4b5'],
    ['--primary-soft', '#24354f', '#3a4f72'],
    ['--chip-bg', '#252b35', '#4b525e'],
    ['--chip-active-bg', '#24344d', '#3b4e70'],
    ['--danger-soft', '#36252c', '#5a454d'],
    ['--danger-border', '#65404b', '#85606b'],
    ['--success-soft', '#20342a', '#3f5649'],
    ['--success-border', '#385446', '#587866'],
    ['--warning-soft', '#332d22', '#565040'],
    ['--warning-border', '#5d4e32', '#7d6e52'],
    ['--header', '#111419', '#383d46', 0.88],
    ['--row-hover', '#252c37', '#4c5462']
  ].map((entry) => Object.freeze(entry)));

  function validateDarkModeLightness(value) {
    if (!Number.isInteger(value) || value < DEFAULT_DARK_MODE_LIGHTNESS || value > MAX_DARK_MODE_LIGHTNESS) {
      throw new Error(`深浅度必须是 ${DEFAULT_DARK_MODE_LIGHTNESS} 到 ${MAX_DARK_MODE_LIGHTNESS} 的整数`);
    }
    return value;
  }

  function normalizeDarkModeLightness(value) {
    try {
      return validateDarkModeLightness(value);
    } catch (_error) {
      return DEFAULT_DARK_MODE_LIGHTNESS;
    }
  }

  function parseHex(hex) {
    return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  }

  function mixChannels(from, to, lightness) {
    const ratio = lightness / MAX_DARK_MODE_LIGHTNESS;
    const fromChannels = parseHex(from);
    const toChannels = parseHex(to);
    return fromChannels.map((channel, index) => Math.round(channel + (toChannels[index] - channel) * ratio));
  }

  // sRGB 逐通道线性插值并取整；非法深浅度按 0 处理，与读取默认化一致。
  function resolveDarkModePalette(lightness) {
    const level = normalizeDarkModeLightness(lightness);
    const palette = {};
    for (const [name, from, to, alpha] of DARK_MODE_LIGHTNESS_PALETTE) {
      const channels = mixChannels(from, to, level);
      palette[name] = alpha === undefined
        ? `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
        : `rgba(${channels.join(', ')}, ${alpha})`;
    }
    return palette;
  }

  function resolveDarkBackgroundColor(lightness) {
    return resolveDarkModePalette(lightness)['--bg'];
  }

  return Object.freeze({
    DEFAULT_DARK_MODE_SCHEDULE,
    normalizeDarkModeSchedule,
    validateDarkModeSchedule,
    resolveEffectiveTheme,
    DEFAULT_DARK_MODE_LIGHTNESS,
    MAX_DARK_MODE_LIGHTNESS,
    DARK_MODE_LIGHTNESS_PALETTE,
    validateDarkModeLightness,
    normalizeDarkModeLightness,
    resolveDarkModePalette,
    resolveDarkBackgroundColor
  });
});
