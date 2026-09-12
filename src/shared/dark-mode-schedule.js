(function exposeDarkModeSchedule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DarkModeSchedule = api;
})(typeof globalThis === 'object' ? globalThis : this, function createDarkModeScheduleApi() {
  const DEFAULT_DARK_MODE_SCHEDULE = Object.freeze({
    enabled: false,
    startTime: '18:30',
    endTime: '06:00'
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

  return Object.freeze({
    DEFAULT_DARK_MODE_SCHEDULE,
    normalizeDarkModeSchedule,
    validateDarkModeSchedule,
    resolveEffectiveTheme
  });
});
