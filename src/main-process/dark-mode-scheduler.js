const {
  normalizeDarkModeSchedule,
  validateDarkModeSchedule,
  resolveEffectiveTheme
} = require('../shared/dark-mode-schedule');

const THEME_BACKGROUND_COLORS = Object.freeze({ light: '#f9fafc', dark: '#111419' });

function createDarkModeScheduler({
  readSchedule,
  writeSchedule,
  nativeTheme,
  getWindows = () => [],
  focusSource,
  powerMonitor,
  onChanged = () => {},
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  let snapshot = null;
  let timer = null;
  let running = false;

  function getSnapshot() {
    if (!snapshot) throw new Error('定时深色模式尚未初始化');
    return { ...snapshot, darkModeSchedule: { ...snapshot.darkModeSchedule } };
  }

  function applySchedule(schedule) {
    const effectiveTheme = resolveEffectiveTheme(schedule, now());
    const previous = snapshot;
    const changed = !previous
      || previous.effectiveTheme !== effectiveTheme
      || previous.darkModeSchedule.enabled !== schedule.enabled
      || previous.darkModeSchedule.startTime !== schedule.startTime
      || previous.darkModeSchedule.endTime !== schedule.endTime;
    if (!changed) return getSnapshot();

    // 始终显式指定主题；操作系统的外观偏好不参与定时时段判断。
    nativeTheme.themeSource = effectiveTheme;
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(THEME_BACKGROUND_COLORS[effectiveTheme]);
    }
    snapshot = {
      darkModeSchedule: { ...schedule },
      effectiveTheme,
      themeRevision: previous ? previous.themeRevision + 1 : 1
    };
    onChanged(getSnapshot());
    return getSnapshot();
  }

  function scheduleNextMinute() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    if (!running) return;
    const current = now();
    const delay = 60000 - (current.getSeconds() * 1000 + current.getMilliseconds());
    timer = setTimeoutFn(() => {
      timer = null;
      refresh();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function refresh() {
    if (!running) return snapshot ? getSnapshot() : null;
    // 每次重读系统时间，覆盖休眠、时钟校准和时区切换；不翻转旧状态。
    const result = applySchedule(snapshot.darkModeSchedule);
    scheduleNextMinute();
    return result;
  }

  function start() {
    if (running) return refresh();
    applySchedule(normalizeDarkModeSchedule(readSchedule()));
    running = true;
    if (focusSource) focusSource.on('browser-window-focus', refresh);
    if (powerMonitor) powerMonitor.on('resume', refresh);
    scheduleNextMinute();
    return getSnapshot();
  }

  function setSchedule(config) {
    const valid = validateDarkModeSchedule(config);
    // 持久化成功后才发布有效状态；失败不触碰主题、计时器或已保存快照。
    writeSchedule(valid);
    const result = applySchedule(valid);
    scheduleNextMinute();
    return result;
  }

  function stop() {
    running = false;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    if (focusSource) focusSource.removeListener('browser-window-focus', refresh);
    if (powerMonitor) powerMonitor.removeListener('resume', refresh);
  }

  return { start, stop, refresh, getSnapshot, setSchedule };
}

module.exports = { createDarkModeScheduler, THEME_BACKGROUND_COLORS };
