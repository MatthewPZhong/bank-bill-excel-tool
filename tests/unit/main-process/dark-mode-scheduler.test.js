const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDarkModeScheduler } = require('../../../src/main-process/dark-mode-scheduler');

const enabled = { enabled: true, startTime: '18:30', endTime: '06:00' };
const at = (hour, minute, second = 0, ms = 0) => new Date(2026, 8, 12, hour, minute, second, ms);

function makeHarness({ config = enabled, date = at(18, 29, 59, 500), lightness } = {}) {
  let current = date;
  let stored = { ...config };
  let storedLightness = lightness;
  let lightnessWrites = 0;
  let writeError = null;
  let nextTimerId = 0;
  let writes = 0;
  const timers = new Map();
  const changes = [];
  const colors = [];
  const focusSource = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const nativeTheme = { themeSource: 'system' };
  const scheduler = createDarkModeScheduler({
    readSchedule: () => stored,
    writeSchedule: (value) => {
      writes += 1;
      if (writeError) throw writeError;
      stored = { ...value };
    },
    readLightness: () => storedLightness,
    writeLightness: (value) => {
      lightnessWrites += 1;
      if (writeError) throw writeError;
      storedLightness = value;
    },
    nativeTheme,
    focusSource,
    powerMonitor,
    now: () => current,
    getWindows: () => [
      { isDestroyed: () => true, setBackgroundColor: () => assert.fail('不应写入已销毁窗口') },
      { isDestroyed: () => false, setBackgroundColor: (color) => colors.push(color) }
    ],
    onChanged: (snapshot) => changes.push(snapshot),
    setTimeoutFn: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id)
  });
  return {
    scheduler, timers, changes, colors, focusSource, powerMonitor, nativeTheme,
    setNow: (dateValue) => { current = dateValue; },
    failWrite: (error) => { writeError = error; },
    writes: () => writes,
    lightnessWrites: () => lightnessWrites,
    storedLightness: () => storedLightness,
    tick(dateValue) {
      current = dateValue;
      assert.equal(timers.size, 1);
      const [id, { callback }] = [...timers][0];
      timers.delete(id);
      callback();
    }
  };
}

test('启动先计算主题并对齐分钟边界，到点切换、未变化不重复广播', () => {
  const h = makeHarness();
  assert.equal(h.scheduler.start().effectiveTheme, 'light');
  assert.equal(h.nativeTheme.themeSource, 'light');
  assert.deepEqual(h.colors, ['#f9fafc']);
  assert.equal([...h.timers.values()][0].delay, 500);
  h.tick(at(18, 30));
  assert.equal(h.nativeTheme.themeSource, 'dark');
  assert.equal(h.colors.at(-1), '#111419');
  assert.equal(h.scheduler.getSnapshot().themeRevision, 2);
  h.tick(at(18, 31));
  assert.equal(h.changes.length, 2);
  assert.equal([...h.timers.values()][0].delay, 60000);
  h.tick(new Date(2026, 8, 13, 6, 0));
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'light');
  assert.equal(h.scheduler.getSnapshot().themeRevision, 3);
  h.scheduler.stop();
});

test('深色时段冷启动立即为深色，已保存关闭冷启动仍为浅色', () => {
  const active = makeHarness({ date: at(23, 0) });
  active.scheduler.start();
  assert.equal(active.nativeTheme.themeSource, 'dark');
  active.scheduler.stop();
  const inactive = makeHarness({ date: at(23, 0), config: { ...enabled, enabled: false } });
  inactive.scheduler.start();
  assert.equal(inactive.nativeTheme.themeSource, 'light');
  inactive.scheduler.stop();
});

test('聚焦、唤醒和时钟跳变重读实际时间，单次跳过多个边界不翻转旧值', () => {
  const h = makeHarness({ date: at(19, 0) });
  h.scheduler.start();
  h.setNow(new Date(2026, 8, 14, 12, 0));
  h.powerMonitor.emit('resume');
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'light');
  h.setNow(at(3, 0));
  h.focusSource.emit('browser-window-focus');
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'dark');
  h.tick(at(12, 0));
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'light');
  assert.equal(h.timers.size, 1);
  h.scheduler.stop();
});

test('合法配置持久化后立即生效，禁用保留时间；失败和非法输入保持快照不变', () => {
  const h = makeHarness({ date: at(19, 0) });
  h.scheduler.start();
  const initial = h.scheduler.getSnapshot();
  h.failWrite(new Error('模拟数据库写入失败'));
  assert.throws(() => h.scheduler.setSchedule({ ...enabled, enabled: false }), /写入失败/);
  assert.deepEqual(h.scheduler.getSnapshot(), initial);
  assert.equal(h.nativeTheme.themeSource, 'dark');
  assert.equal(h.changes.length, 1);
  const priorWrites = h.writes();
  assert.throws(() => h.scheduler.setSchedule({ ...enabled, startTime: '06:00' }), /不能相同/);
  assert.equal(h.writes(), priorWrites);
  h.failWrite(null);
  const off = h.scheduler.setSchedule({ ...enabled, enabled: false });
  assert.equal(off.effectiveTheme, 'light');
  assert.equal(off.darkModeSchedule.startTime, '18:30');
  const changed = h.scheduler.setSchedule({ enabled: false, startTime: '20:00', endTime: '07:00' });
  assert.equal(changed.themeRevision, off.themeRevision + 1);
  assert.equal(changed.effectiveTheme, 'light');
  assert.equal(h.scheduler.setSchedule(changed.darkModeSchedule).themeRevision, changed.themeRevision);
  h.scheduler.stop();
});

test('start 幂等，stop 清理计时器与事件；快照副本不可改写调度配置', () => {
  const h = makeHarness();
  h.scheduler.start();
  h.scheduler.start();
  assert.equal(h.focusSource.listenerCount('browser-window-focus'), 1);
  assert.equal(h.powerMonitor.listenerCount('resume'), 1);
  assert.equal(h.timers.size, 1);
  const copy = h.scheduler.getSnapshot();
  copy.darkModeSchedule.enabled = false;
  assert.equal(h.scheduler.getSnapshot().darkModeSchedule.enabled, true);
  h.scheduler.stop();
  h.scheduler.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.focusSource.listenerCount('browser-window-focus'), 0);
  assert.equal(h.powerMonitor.listenerCount('resume'), 0);
  h.setNow(at(20, 0));
  h.focusSource.emit('browser-window-focus');
  assert.equal(h.changes.length, 1);
  h.scheduler.start();
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'dark');
  h.scheduler.stop();
});


test('缺失配置按新默认冷启动，分钟、聚焦与恢复跨边界且不写设置', () => {
  const h = makeHarness({ config: null, date: at(17, 29) });
  const initial = h.scheduler.start();
  assert.deepEqual(initial.darkModeSchedule, { enabled: true, startTime: '17:30', endTime: '07:00' });
  assert.equal(initial.effectiveTheme, 'light');
  h.tick(at(17, 30));
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'dark');
  h.setNow(at(6, 59));
  h.powerMonitor.emit('resume');
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'dark');
  h.setNow(at(7, 0));
  h.focusSource.emit('browser-window-focus');
  assert.equal(h.scheduler.getSnapshot().effectiveTheme, 'light');
  assert.equal(h.timers.size, 1);
  assert.equal(h.writes(), 0);
  h.scheduler.stop();
});

test('深浅度随启动读取，缺失或损坏按 0；深色窗口底色按深浅度插值', () => {
  for (const lightness of [undefined, null, '40', 101, 2.5]) {
    const h = makeHarness({ date: at(23, 0), lightness });
    assert.equal(h.scheduler.start().darkModeLightness, 0);
    assert.deepEqual(h.colors, ['#111419']);
    h.scheduler.stop();
  }
  const h = makeHarness({ date: at(23, 0), lightness: 100 });
  assert.equal(h.scheduler.start().darkModeLightness, 100);
  assert.deepEqual(h.colors, ['#383d46']);
  h.setNow(at(12, 0));
  h.focusSource.emit('browser-window-focus');
  assert.equal(h.colors.at(-1), '#f9fafc');
  assert.equal(h.scheduler.getSnapshot().darkModeLightness, 100);
  h.scheduler.stop();
});

test('setLightness 写库成功后才发布；失败与非法值保持快照、主题和窗口底色', () => {
  const h = makeHarness({ date: at(23, 0), lightness: 0 });
  h.scheduler.start();
  const initial = h.scheduler.getSnapshot();
  for (const value of [-1, 101, 1.5, '50']) {
    assert.throws(() => h.scheduler.setLightness(value), /0 到 100 的整数/);
  }
  assert.equal(h.lightnessWrites(), 0);
  h.failWrite(new Error('模拟数据库写入失败'));
  assert.throws(() => h.scheduler.setLightness(60), /写入失败/);
  assert.deepEqual(h.scheduler.getSnapshot(), initial);
  assert.deepEqual(h.colors, ['#111419']);
  assert.equal(h.changes.length, 1);
  h.failWrite(null);
  const saved = h.scheduler.setLightness(100);
  assert.equal(h.storedLightness(), 100);
  assert.equal(saved.darkModeLightness, 100);
  assert.equal(saved.themeRevision, initial.themeRevision + 1);
  assert.deepEqual(saved.darkModeSchedule, initial.darkModeSchedule);
  assert.equal(h.colors.at(-1), '#383d46');
  assert.equal(h.changes.at(-1).darkModeLightness, 100);
  assert.equal(h.scheduler.setLightness(100).themeRevision, saved.themeRevision);
  // 修改定时配置保留已保存深浅度。
  assert.equal(h.scheduler.setSchedule({ ...enabled, enabled: false }).darkModeLightness, 100);
  assert.equal(h.colors.at(-1), '#f9fafc');
  h.scheduler.stop();
});

test('浅色时保存深浅度只更新快照，窗口保持浅色底色', () => {
  const h = makeHarness({ date: at(12, 0), lightness: 0 });
  h.scheduler.start();
  const saved = h.scheduler.setLightness(40);
  assert.equal(saved.effectiveTheme, 'light');
  assert.equal(saved.darkModeLightness, 40);
  assert.equal(h.nativeTheme.themeSource, 'light');
  assert.ok(h.colors.every((color) => color === '#f9fafc'));
  h.tick(at(18, 30));
  assert.equal(h.colors.at(-1), '#21242b');
  h.scheduler.stop();
});
