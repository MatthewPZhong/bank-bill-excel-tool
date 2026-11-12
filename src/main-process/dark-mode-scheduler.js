const {
  normalizeDarkModeSchedule,
  validateDarkModeSchedule,
  resolveEffectiveTheme,
  DEFAULT_DARK_MODE_LIGHTNESS,
  normalizeDarkModeLightness,
  validateDarkModeLightness,
  resolveDarkBackgroundColor
} = require('../shared/dark-mode-schedule');

const THEME_BACKGROUND_COLORS = Object.freeze({ light: '#f9fafc', dark: '#111419' });

// 原生窗口底色与页面 --bg 一致：深色按深浅度插值，浅色不受影响。
function resolveWindowBackgroundColor(theme, lightness = DEFAULT_DARK_MODE_LIGHTNESS) {
  return theme === 'dark' ? resolveDarkBackgroundColor(lightness) : THEME_BACKGROUND_COLORS.light;
}

function createDarkModeScheduler({
  readSchedule,
  writeSchedule,
  readLightness = () => DEFAULT_DARK_MODE_LIGHTNESS,
  writeLightness = () => { throw new Error('深浅度不可保存'); },
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

  function applySchedule(schedule, lightness = snapshot ? snapshot.darkModeLightness : DEFAULT_DARK_MODE_LIGHTNESS) {
    const effectiveTheme = resolveEffectiveTheme(schedule, now());
    const previous = snapshot;
    const changed = !previous
      || previous.effectiveTheme !== effectiveTheme
      || previous.darkModeLightness !== lightness
      || previous.darkModeSchedule.enabled !== schedule.enabled
      || previous.darkModeSchedule.startTime !== schedule.startTime
      || previous.darkModeSchedule.endTime !== schedule.endTime;
    if (!changed) return getSnapshot();

    // 始终显式指定主题；操作系统的外观偏好不参与定时时段判断。
    nativeTheme.themeSource = effectiveTheme;
    const backgroundColor = resolveWindowBackgroundColor(effectiveTheme, lightness);
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor);
    }
    snapshot = {
      darkModeSchedule: { ...schedule },
      darkModeLightness: lightness,
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
    applySchedule(normalizeDarkModeSchedule(readSchedule()), normalizeDarkModeLightness(readLightness()));
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

  function setLightness(lightness) {
    const valid = validateDarkModeLightness(lightness);
    if (!snapshot) throw new Error('定时深色模式尚未初始化');
    // 与 setSchedule 相同：持久化成功后才发布，失败不触碰主题、窗口底色或快照。
    writeLightness(valid);
    return applySchedule(snapshot.darkModeSchedule, valid);
  }

  function stop() {
    running = false;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    if (focusSource) focusSource.removeListener('browser-window-focus', refresh);
    if (powerMonitor) powerMonitor.removeListener('resume', refresh);
  }

  return { start, stop, refresh, getSnapshot, setSchedule, setLightness };
}

module.exports = { createDarkModeScheduler, THEME_BACKGROUND_COLORS, resolveWindowBackgroundColor };
