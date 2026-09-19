(function initDarkModeUI(root, factory) {
  const shared = typeof module === 'object' && module.exports
    ? require('./shared/dark-mode-schedule') : root.DarkModeSchedule;
  const ui = factory(shared);
  if (typeof module === 'object' && module.exports) module.exports = ui;
  if (root && root.document) {
    root.DarkModeUI = ui;
    // Main 在建窗前已设置 nativeTheme；外部同步脚本在 CSS 前确定首屏颜色。
    ui.paint(root.document, root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
})(typeof window === 'object' ? window : null, function buildDarkModeUI(shared) {
  'use strict';

  function paint(document, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }

  function createController({ api, document, onChange = () => {} }) {
    let snapshot = {
      darkModeSchedule: { ...shared.DEFAULT_DARK_MODE_SCHEDULE },
      effectiveTheme: document?.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      themeRevision: -1,
      ready: false,
      saving: false
    };
    let disposed = false;
    const listeners = new Set();
    const copy = () => ({ ...snapshot, darkModeSchedule: { ...snapshot.darkModeSchedule } });
    function notify() {
      if (disposed) return;
      for (const listener of listeners) listener(copy());
    }
    function accept(next) {
      if (disposed || !next || !Number.isSafeInteger(next.themeRevision)
        || next.themeRevision < snapshot.themeRevision
        || !['light', 'dark'].includes(next.effectiveTheme)) return false;
      let schedule;
      try { schedule = shared.validateDarkModeSchedule(next.darkModeSchedule); }
      catch (_error) { return false; }
      if (!schedule.enabled && next.effectiveTheme !== 'light') return false;
      snapshot = {
        ...snapshot,
        darkModeSchedule: schedule,
        effectiveTheme: next.effectiveTheme,
        themeRevision: next.themeRevision,
        ready: true
      };
      if (document) paint(document, snapshot.effectiveTheme);
      onChange(copy());
      notify();
      return true;
    }
    // 先订阅再接收 app:get-info，版本号避免较晚到达的旧快照覆盖新状态。
    const unsubscribe = api?.onDarkModeScheduleChanged?.(accept);
    return {
      accept,
      getSnapshot: copy,
      subscribe(listener) { listeners.add(listener); listener(copy()); return () => listeners.delete(listener); },
      async save(config) {
        if (disposed || snapshot.saving) throw new Error('设置正在保存，请稍后再试');
        const valid = shared.validateDarkModeSchedule(config);
        if (!snapshot.ready || typeof api?.setDarkModeSchedule !== 'function') throw new Error('外观设置尚未加载完成');
        snapshot.saving = true;
        notify();
        try {
          const result = await api.setDarkModeSchedule(valid);
          if (result?.status !== 'ok') throw new Error(result?.message || '定时深色模式保存失败');
          if (!accept(result) && !disposed && !(Number.isSafeInteger(result.themeRevision)
            && result.themeRevision < snapshot.themeRevision)) {
            throw new Error('外观设置返回了无效状态');
          }
          return copy();
        } finally {
          snapshot.saving = false;
          notify();
        }
      },
      dispose() { disposed = true; if (typeof unsubscribe === 'function') unsubscribe(); listeners.clear(); }
    };
  }

  function mountSettings(host, controller) {
    host.innerHTML = `
      <div class="appearance-pane-scroll">
        <h3 class="app-settings-pane-heading">外观设置</h3>
        <fieldset class="appearance-fields">
          <div class="appearance-enable-row">
            <label for="darkModeEnabled"><strong>启用定时深色模式</strong></label>
            <input id="darkModeEnabled" data-role="dark-mode-enabled" type="checkbox" role="switch" aria-label="启用定时深色模式" />
          </div>
          <div class="appearance-time-grid">
            <label>开始时间<input data-role="dark-mode-start" type="time" step="60" required aria-label="深色开始时间" /></label>
            <span class="appearance-time-separator" aria-hidden="true">—</span>
            <label>结束时间<input data-role="dark-mode-end" type="time" step="60" required aria-label="深色结束时间" /></label>
          </div>
        </fieldset>
        <p class="appearance-feedback" data-role="dark-mode-feedback" role="alert" hidden></p>
      </div>`;
    const enabled = host.querySelector('[data-role="dark-mode-enabled"]');
    const start = host.querySelector('[data-role="dark-mode-start"]');
    const end = host.querySelector('[data-role="dark-mode-end"]');
    const feedback = host.querySelector('[data-role="dark-mode-feedback"]');
    const fields = host.querySelector('fieldset');
    const inputs = new Map([[enabled, 'enabled'], [start, 'startTime'], [end, 'endTime']]);
    const dirty = new Map();
    let editRevision = 0;
    let saveRequested = false;
    let saveLoop = null;
    let destroyed = false;
    function render(snapshot) {
      if (destroyed) return;
      // 原生 time 每输入一位就可能触发 change；禁用或重写活动框会丢失分段输入状态。
      fields.disabled = !snapshot.ready;
      if (!dirty.has('enabled')) enabled.checked = snapshot.darkModeSchedule.enabled;
      for (const input of [start, end]) {
        const field = inputs.get(input);
        if (!dirty.has(field) && host.ownerDocument.activeElement !== input
          && input.value !== snapshot.darkModeSchedule[field]) input.value = snapshot.darkModeSchedule[field];
      }
    }
    const unsubscribe = controller.subscribe(render);
    function showError(error) {
      if (feedback.hidden) feedback.textContent = error.message;
      else if (!feedback.textContent.includes(error.message)) feedback.textContent += `；${error.message}`;
      feedback.hidden = false;
    }
    async function drainSaves() {
      while (saveRequested && !destroyed) {
        saveRequested = false;
        const submitted = new Map(dirty);
        const next = { ...controller.getSnapshot().darkModeSchedule };
        // 关闭始终可用；在途保存完成后取最新已保存时段，非法草稿不能阻止恢复浅色。
        if (dirty.has('enabled') && !enabled.checked) {
          next.enabled = false;
          // 关闭后的新时间编辑不属于关闭时丢弃的旧草稿，留给后续请求保存或校验。
          for (const field of ['startTime', 'endTime']) {
            if (submitted.get(field) > submitted.get('enabled')) {
              submitted.delete(field);
              saveRequested = true;
            }
          }
        } else {
          // 合并仍未保存的字段，其他字段保留最新快照，连续编辑只排队保存最终值。
          if (dirty.has('enabled')) next.enabled = enabled.checked;
          if (dirty.has('startTime')) next.startTime = start.value;
          if (dirty.has('endTime')) next.endTime = end.value;
        }
        try {
          shared.validateDarkModeSchedule(next);
        } catch (error) {
          showError(error);
          return;
        }
        try {
          await controller.save(next);
        } catch (error) {
          if (!destroyed) showError(error);
        } finally {
          // 回包只能结算本次捕获的编辑；保存期间的新输入仍由下一次请求处理。
          for (const [field, revision] of submitted) {
            if (dirty.get(field) === revision) dirty.delete(field);
          }
          render(controller.getSnapshot());
        }
      }
    }
    function markDirty(input) { dirty.set(inputs.get(input), ++editRevision); }
    function submit(event) {
      if (destroyed) return;
      // 仅用户新提交清除旧错误；内部续存成功或校验失败不能掩盖先前的保存失败。
      feedback.hidden = true;
      markDirty(event.currentTarget);
      saveRequested = true;
      if (!saveLoop) saveLoop = drainSaves().finally(() => { saveLoop = null; });
      return saveLoop;
    }
    for (const input of [enabled, start, end]) {
      input.addEventListener('input', () => { if (!destroyed) markDirty(input); });
      input.addEventListener('change', submit);
    }
    for (const input of [start, end]) input.addEventListener('blur', () => render(controller.getSnapshot()));
    return { destroy() { destroyed = true; unsubscribe(); } };
  }

  return { paint, createController, mountSettings };
});
