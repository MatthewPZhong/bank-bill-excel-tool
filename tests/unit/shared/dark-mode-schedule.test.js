const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_DARK_MODE_SCHEDULE,
  normalizeDarkModeSchedule,
  validateDarkModeSchedule,
  resolveEffectiveTheme
} = require('../../../src/shared/dark-mode-schedule');

const enabled = { ...DEFAULT_DARK_MODE_SCHEDULE, enabled: true };
const at = (hours, minutes, seconds = 0) => new Date(2026, 8, 12, hours, minutes, seconds);

test('默认开启 17:30–07:00，归一化返回独立副本且不回写输入', () => {
  assert.deepEqual(DEFAULT_DARK_MODE_SCHEDULE, { enabled: true, startTime: '17:30', endTime: '07:00' });
  const first = normalizeDarkModeSchedule(null);
  first.enabled = false;
  assert.equal(normalizeDarkModeSchedule(null).enabled, true);
  assert.equal(resolveEffectiveTheme(DEFAULT_DARK_MODE_SCHEDULE, at(23, 59)), 'dark');
  assert.deepEqual(validateDarkModeSchedule({ ...enabled, unrelated: 1 }), enabled);
});

test('默认跨午夜时段包含开始分钟、不包含结束分钟', () => {
  for (const [hours, minutes, expected] of [
    [17, 29, 'light'], [17, 30, 'dark'], [23, 59, 'dark'],
    [0, 0, 'dark'], [6, 59, 'dark'], [7, 0, 'light']
  ]) {
    assert.equal(resolveEffectiveTheme(enabled, at(hours, minutes)), expected, `${hours}:${minutes}`);
    assert.equal(resolveEffectiveTheme(enabled, at(hours, minutes, 59)), expected);
  }
});

test('自定义当天时段和跨午夜时段覆盖一天内每个分钟', () => {
  const sameDay = { enabled: true, startTime: '08:15', endTime: '16:45' };
  const overnight = { enabled: true, startTime: '22:00', endTime: '00:01' };
  for (let minute = 0; minute < 1440; minute += 1) {
    const current = at(Math.floor(minute / 60), minute % 60);
    assert.equal(resolveEffectiveTheme(sameDay, current), minute >= 495 && minute < 1005 ? 'dark' : 'light');
    assert.equal(resolveEffectiveTheme(overnight, current), minute >= 1320 || minute < 1 ? 'dark' : 'light');
  }
});

test('坏配置写入被拒绝，读取使用新默认；相同时刻不解释为全天', () => {
  const invalid = [
    null, undefined, [], '18:30', {}, { ...enabled, enabled: 1 },
    { ...enabled, startTime: '8:30' }, { ...enabled, startTime: '24:00' },
    { ...enabled, endTime: '06:60' }, { ...enabled, startTime: '18:30:00' },
    { ...enabled, startTime: ' 18:30' }, { ...enabled, startTime: '18:30\n' },
    { ...enabled, endTime: '06:00\n' }, { ...enabled, endTime: enabled.startTime }
  ];
  for (const config of invalid) {
    assert.throws(() => validateDarkModeSchedule(config), /启用状态|时间/);
    assert.deepEqual(normalizeDarkModeSchedule(config), DEFAULT_DARK_MODE_SCHEDULE);
    assert.equal(resolveEffectiveTheme(config, at(20, 0)), 'dark');
  }
  assert.equal(resolveEffectiveTheme(enabled, new Date(NaN)), 'light');
});

test('同一时刻按本机时区判断，而非按 UTC 判断', () => {
  const modulePath = require.resolve('../../../src/shared/dark-mode-schedule');
  const code = `const {resolveEffectiveTheme}=require(${JSON.stringify(modulePath)}); process.stdout.write(resolveEffectiveTheme(${JSON.stringify(enabled)},new Date('2026-09-12T11:00:00Z')));`;
  for (const [tz, expected] of [['Asia/Shanghai', 'dark'], ['UTC', 'light']]) {
    const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('独立浏览器脚本与 Node 共用同一时间规则', () => {
  const context = vm.createContext({ Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../src/shared/dark-mode-schedule.js'), 'utf8'), context);
  assert.equal(context.DarkModeSchedule.resolveEffectiveTheme(enabled, at(18, 30)), 'dark');
  assert.equal(context.DarkModeSchedule.resolveEffectiveTheme(enabled, at(7, 0)), 'light');
});


test('完整旧配置和用户关闭状态保留，不按旧默认值推断缺失', () => {
  for (const config of [
    { enabled: false, startTime: '18:30', endTime: '06:00' },
    { enabled: true, startTime: '18:30', endTime: '06:00' },
    { enabled: false, startTime: '17:30', endTime: '07:00' }
  ]) {
    assert.deepEqual(normalizeDarkModeSchedule(config), config);
    assert.equal(resolveEffectiveTheme(config, at(23, 0)), config.enabled ? 'dark' : 'light');
  }
});

// v3.2.17 深浅度：0 档必须等于 CSS 深色块，各档关键文字保持可读对比度。
const {
  DEFAULT_DARK_MODE_LIGHTNESS,
  MAX_DARK_MODE_LIGHTNESS,
  DARK_MODE_LIGHTNESS_PALETTE,
  validateDarkModeLightness,
  normalizeDarkModeLightness,
  resolveDarkModePalette,
  resolveDarkBackgroundColor
} = require('../../../src/shared/dark-mode-schedule');

function readDarkCssVariables() {
  const css = fs.readFileSync(path.join(__dirname, '../../../src/styles-dark-mode.css'), 'utf8');
  const block = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1];
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function toRgba(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex[1].slice(index, index + 2), 16)).concat(1);
  const rgba = color.match(/^rgba\(([^)]+)\)$/);
  assert.ok(rgba, `无法解析颜色 ${color}`);
  return rgba[1].split(',').map(Number);
}

function contrast(foreground, background) {
  const luminance = (color) => {
    const [r, g, b] = toRgba(color).slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('深浅度只接受 0–100 整数，读取默认化为 0', () => {
  assert.equal(DEFAULT_DARK_MODE_LIGHTNESS, 0);
  assert.equal(MAX_DARK_MODE_LIGHTNESS, 100);
  for (const value of [0, 1, 50, 100]) assert.equal(validateDarkModeLightness(value), value);
  for (const value of [-1, 101, 1.5, NaN, Infinity, '50', null, undefined, true, [50]]) {
    assert.throws(() => validateDarkModeLightness(value), /0 到 100 的整数/);
    assert.equal(normalizeDarkModeLightness(value), 0);
  }
});

test('0 档与 CSS 深色块逐项一致，100 档取最浅端，中间逐通道插值取整', () => {
  const css = readDarkCssVariables();
  const darkest = resolveDarkModePalette(0);
  assert.equal(Object.keys(darkest).length, DARK_MODE_LIGHTNESS_PALETTE.length);
  for (const [name, from, to, alpha] of DARK_MODE_LIGHTNESS_PALETTE) {
    assert.ok(css[name], `CSS 深色块缺少 ${name}`);
    assert.deepEqual(toRgba(darkest[name]), toRgba(css[name]), name);
    assert.deepEqual(toRgba(resolveDarkModePalette(100)[name]), toRgba(to).slice(0, 3).concat(alpha ?? 1), name);
    assert.deepEqual(toRgba(from).slice(0, 3), toRgba(css[name]).slice(0, 3), name);
  }
  assert.equal(resolveDarkBackgroundColor(0), '#111419');
  assert.equal(resolveDarkBackgroundColor(100), '#383d46');
  // (0x11 + (0x38 - 0x11) * 0.5) = 36.5 → 37 (0x25)
  assert.equal(resolveDarkBackgroundColor(50), '#252930');
  assert.deepEqual(resolveDarkModePalette(1.5), darkest);
  assert.equal(resolveDarkModePalette(50)['--header'], 'rgba(37, 41, 48, 0.88)');
});

test('各档正文、次要文字、主色与状态文字在对应底色上保持可读对比度', () => {
  const css = readDarkCssVariables();
  const pairs = [
    ['--text', '--bg', 4.5], ['--text', '--panel', 4.5], ['--text', '--panel-strong', 4.5],
    ['--muted', '--panel', 4.5], ['--muted', '--bg-soft', 4.5],
    ['--primary', '--panel', 4.5], ['--primary', '--primary-soft', 4.5],
    ['--chip-active-text', '--chip-active-bg', 4.5],
    ['--danger', '--danger-soft', 4.5], ['--success', '--success-soft', 4.5], ['--warning', '--warning-soft', 4.5],
    ['--bg', '--danger', 4.5],
    ['--dim', '--panel', 3], ['--dim', '--input', 3]
  ];
  for (let level = 0; level <= 100; level += 5) {
    const palette = { ...css, ...resolveDarkModePalette(level) };
    for (const [foreground, background, minimum] of pairs) {
      const ratio = contrast(palette[foreground], palette[background]);
      assert.ok(ratio >= minimum, `${level} 档 ${foreground}/${background} 对比度 ${ratio.toFixed(2)} < ${minimum}`);
    }
  }
});
