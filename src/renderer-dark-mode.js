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
        <h3 class="app-settings-pane-heading">外观</h3>
        <p class="appearance-description">按本机时间自动切换，夜间也能舒适查看账单。</p>
        <fieldset class="appearance-fields">
          <div class="appearance-enable-row">
            <label for="darkModeEnabled"><strong>启用定时深色模式</strong><span>每天在设定时段使用深色，时段外使用浅色。</span></label>
            <input id="darkModeEnabled" data-role="dark-mode-enabled" type="checkbox" role="switch" aria-label="启用定时深色模式" />
          </div>
          <div class="appearance-time-grid">
            <label>开始时间<input data-role="dark-mode-start" type="time" step="60" required aria-label="深色开始时间" /></label>
            <span class="appearance-time-separator" aria-hidden="true">—</span>
            <label>结束时间<input data-role="dark-mode-end" type="time" step="60" required aria-label="深色结束时间" /></label>
          </div>
        </fieldset>
        <div class="appearance-current" data-role="dark-mode-status" role="status" aria-live="polite"></div>
        <p class="appearance-feedback" data-role="dark-mode-feedback" role="alert" hidden></p>
        <div class="appearance-preview" aria-label="当前组件配色预览">
          <div class="appearance-preview-header"><span>界面预览</span><span class="appearance-preview-badge">已完成</span></div>
          <div class="appearance-preview-body"><span>账户与账单明细</span><span class="appearance-preview-action">查看明细</span></div>
        </div>
        <p class="appearance-description appearance-note">设置自动保存。关闭开关后恢复浅色，并保留时段。深色时保留自定义背景，自动叠加深色遮罩。</p>
      </div>`;
    const enabled = host.querySelector('[data-role="dark-mode-enabled"]');
    const start = host.querySelector('[data-role="dark-mode-start"]');
    const end = host.querySelector('[data-role="dark-mode-end"]');
    const status = host.querySelector('[data-role="dark-mode-status"]');
    const feedback = host.querySelector('[data-role="dark-mode-feedback"]');
    const fields = host.querySelector('fieldset');
    const inputs = new Map([[enabled, 'enabled'], [start, 'startTime'], [end, 'endTime']]);
    const dirty = new Set();
    let destroyed = false;
    function render(snapshot) {
      if (destroyed) return;
      fields.disabled = snapshot.saving || !snapshot.ready;
      if (!dirty.has('enabled')) enabled.checked = snapshot.darkModeSchedule.enabled;
      if (!dirty.has('startTime')) start.value = snapshot.darkModeSchedule.startTime;
      if (!dirty.has('endTime')) end.value = snapshot.darkModeSchedule.endTime;
      const schedule = snapshot.darkModeSchedule;
      const span = schedule.startTime > schedule.endTime ? '次日 ' : '';
      status.textContent = snapshot.saving ? '正在保存…'
        : !snapshot.ready ? '正在读取外观设置…'
          : !schedule.enabled ? '未启用 · 当前为浅色'
            : `当前为${snapshot.effectiveTheme === 'dark' ? '深色' : '浅色'} · 每天 ${schedule.startTime} — ${span}${schedule.endTime}`;
    }
    const unsubscribe = controller.subscribe(render);
    async function submit(event) {
      dirty.add(inputs.get(event.currentTarget));
      feedback.hidden = true;
      const focused = host.ownerDocument.activeElement;
      // 关闭功能始终可用，不让尚未提交的无效时间阻止恢复浅色。
      const next = { ...controller.getSnapshot().darkModeSchedule };
      if (event.currentTarget === enabled && !enabled.checked) next.enabled = false;
      else {
        // 只提交本窗口编辑过的字段，保留其他窗口已更新的开关或时段。
        if (dirty.has('enabled')) next.enabled = enabled.checked;
        if (dirty.has('startTime')) next.startTime = start.value;
        if (dirty.has('endTime')) next.endTime = end.value;
      }
      try {
        shared.validateDarkModeSchedule(next);
      } catch (error) {
        feedback.textContent = error.message;
        feedback.hidden = false;
        return;
      }
      try {
        await controller.save(next);
      } catch (error) {
        feedback.textContent = error.message;
        feedback.hidden = false;
      } finally {
        dirty.clear();
        render(controller.getSnapshot());
        if (!destroyed && host.isConnected && focused?.isConnected) focused.focus();
      }
    }
    for (const input of [enabled, start, end]) {
      input.addEventListener('input', () => { dirty.add(inputs.get(input)); });
      input.addEventListener('change', submit);
    }
    return { destroy() { destroyed = true; unsubscribe(); } };
  }

  return { paint, createController, mountSettings };
});
