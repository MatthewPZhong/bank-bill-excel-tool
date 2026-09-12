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

test('默认关闭，归一化返回独立副本且不回写输入', () => {
  assert.deepEqual(DEFAULT_DARK_MODE_SCHEDULE, { enabled: false, startTime: '18:30', endTime: '06:00' });
  const first = normalizeDarkModeSchedule(null);
  first.enabled = true;
  assert.equal(normalizeDarkModeSchedule(null).enabled, false);
  assert.equal(resolveEffectiveTheme(DEFAULT_DARK_MODE_SCHEDULE, at(23, 59)), 'light');
  assert.deepEqual(validateDarkModeSchedule({ ...enabled, unrelated: 1 }), enabled);
});

test('默认跨午夜时段包含开始分钟、不包含结束分钟', () => {
  for (const [hours, minutes, expected] of [
    [18, 29, 'light'], [18, 30, 'dark'], [23, 59, 'dark'],
    [0, 0, 'dark'], [5, 59, 'dark'], [6, 0, 'light']
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

test('坏配置写入被拒绝，读取安全关闭；相同时刻不解释为全天', () => {
  const invalid = [
    null, undefined, [], '18:30', {}, { ...enabled, enabled: 1 },
    { ...enabled, startTime: '8:30' }, { ...enabled, startTime: '24:00' },
    { ...enabled, endTime: '06:60' }, { ...enabled, startTime: '18:30:00' },
    { ...enabled, startTime: ' 18:30' }, { ...enabled, startTime: '18:30\n' },
    { ...enabled, endTime: '06:00\n' }, { ...enabled, endTime: '18:30' }
  ];
  for (const config of invalid) {
    assert.throws(() => validateDarkModeSchedule(config), /启用状态|时间/);
    assert.deepEqual(normalizeDarkModeSchedule(config), DEFAULT_DARK_MODE_SCHEDULE);
    assert.equal(resolveEffectiveTheme(config, at(20, 0)), 'light');
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
  assert.equal(context.DarkModeSchedule.resolveEffectiveTheme(enabled, at(6, 0)), 'light');
});
