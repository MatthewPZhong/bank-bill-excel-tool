(function initDarkModeUI(root, factory) {
  const shared = typeof module === 'object' && module.exports
    ? require('./shared/dark-mode-schedule') : root.DarkModeSchedule;
  const ui = factory(shared);
  if (typeof module === 'object' && module.exports) module.exports = ui;
  if (root && root.document) {
    root.DarkModeUI = ui;
    // Main 在建窗前已设置 nativeTheme 并经 preload 传入深浅度；外部同步脚本在 CSS 前确定首屏颜色。
    ui.paint(root.document, root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      root.desktopApi?.settings?.initialDarkModeLightness);
  }
})(typeof window === 'object' ? window : null, function buildDarkModeUI(shared) {
  'use strict';

  function paint(document, theme, lightness = shared.DEFAULT_DARK_MODE_LIGHTNESS) {
    const element = document.documentElement;
    element.dataset.theme = theme;
    element.style.colorScheme = theme;
    // 浅色与深浅度 0 完全沿用 CSS 变量；只有深色且调浅时写内联变量，默认外观不变。
    const level = shared.normalizeDarkModeLightness(lightness);
    const palette = theme === 'dark' && level > 0 ? shared.resolveDarkModePalette(level) : null;
    for (const [name] of shared.DARK_MODE_LIGHTNESS_PALETTE) {
      if (palette) element.style.setProperty(name, palette[name]);
      else element.style.removeProperty(name);
    }
  }

  function createController({ api, document, onChange = () => {} }) {
    let snapshot = {
      darkModeSchedule: { ...shared.DEFAULT_DARK_MODE_SCHEDULE },
      darkModeLightness: shared.DEFAULT_DARK_MODE_LIGHTNESS,
      // 调节页预览值；非 null 时强制深色，不改变已保存快照。
      previewLightness: null,
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
    function repaint() {
      const previewing = snapshot.previewLightness !== null;
      if (document) {
        paint(document, previewing ? 'dark' : snapshot.effectiveTheme,
          previewing ? snapshot.previewLightness : snapshot.darkModeLightness);
      }
      onChange(copy());
      notify();
    }
    function accept(next) {
      if (disposed || !next || !Number.isSafeInteger(next.themeRevision)
        || next.themeRevision < snapshot.themeRevision
        || !['light', 'dark'].includes(next.effectiveTheme)) return false;
      let schedule;
      let lightness;
      try {
        schedule = shared.validateDarkModeSchedule(next.darkModeSchedule);
        // 未携带深浅度的快照保留当前值；携带时必须合法，不能把坏值拼进主题。
        lightness = next.darkModeLightness === undefined
          ? snapshot.darkModeLightness : shared.validateDarkModeLightness(next.darkModeLightness);
      } catch (_error) { return false; }
      if (!schedule.enabled && next.effectiveTheme !== 'light') return false;
      snapshot = {
        ...snapshot,
        darkModeSchedule: schedule,
        darkModeLightness: lightness,
        effectiveTheme: next.effectiveTheme,
        themeRevision: next.themeRevision,
        ready: true
      };
      // 预览期间只更新快照，页面保持预览；退出预览时按最新快照重绘。
      repaint();
      return true;
    }
    async function persist(method, payload, failureMessage) {
      if (!snapshot.ready || typeof api?.[method] !== 'function') throw new Error('外观设置尚未加载完成');
      snapshot.saving = true;
      notify();
      try {
        const result = await api[method](payload);
        if (result?.status !== 'ok') throw new Error(result?.message || failureMessage);
        if (!accept(result) && !disposed && !(Number.isSafeInteger(result.themeRevision)
          && result.themeRevision < snapshot.themeRevision)) {
          throw new Error('外观设置返回了无效状态');
        }
        return copy();
      } finally {
        snapshot.saving = false;
        notify();
      }
    }
    function setPreview(previewLightness) {
      if (disposed || snapshot.previewLightness === previewLightness) return copy();
      snapshot = { ...snapshot, previewLightness };
      repaint();
      return copy();
    }
    // 先订阅再接收 app:get-info，版本号避免较晚到达的旧快照覆盖新状态。
    const unsubscribe = api?.onDarkModeScheduleChanged?.(accept);
    return {
      accept,
      getSnapshot: copy,
      subscribe(listener) { listeners.add(listener); listener(copy()); return () => listeners.delete(listener); },
      async save(config) {
        if (disposed || snapshot.saving) throw new Error('设置正在保存，请稍后再试');
        return persist('setDarkModeSchedule', shared.validateDarkModeSchedule(config), '定时深色模式保存失败');
      },
      async saveLightness(lightness) {
        if (disposed || snapshot.saving) throw new Error('设置正在保存，请稍后再试');
        return persist('setDarkModeLightness', shared.validateDarkModeLightness(lightness), '深浅度保存失败');
      },
      startPreview() {
        if (!snapshot.ready) throw new Error('外观设置尚未加载完成');
        return setPreview(snapshot.previewLightness ?? snapshot.darkModeLightness);
      },
      setPreviewLightness(lightness) {
        const level = shared.validateDarkModeLightness(lightness);
        return snapshot.previewLightness === null ? copy() : setPreview(level);
      },
      stopPreview() { return setPreview(null); },
      dispose() { disposed = true; if (typeof unsubscribe === 'function') unsubscribe(); listeners.clear(); }
    };
  }

  function mountSettings(host, controller, { openLayer } = {}) {
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
          <div class="appearance-lightness-row">
            <span class="appearance-lightness-label">深浅度调节</span>
            <button class="secondary-btn small" data-role="dark-mode-lightness-adjust" type="button">调节</button>
          </div>
        </fieldset>
        <p class="appearance-feedback" data-role="dark-mode-feedback" role="alert" hidden></p>
      </div>`;
    const enabled = host.querySelector('[data-role="dark-mode-enabled"]');
    const start = host.querySelector('[data-role="dark-mode-start"]');
    const end = host.querySelector('[data-role="dark-mode-end"]');
    const feedback = host.querySelector('[data-role="dark-mode-feedback"]');
    const adjust = host.querySelector('[data-role="dark-mode-lightness-adjust"]');
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
      // 调节页由设置弹窗叠层打开；无宿主或保存中不可打开。
      adjust.disabled = typeof openLayer !== 'function' || snapshot.saving;
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
    adjust.addEventListener('click', () => {
      const snapshot = controller.getSnapshot();
      if (destroyed || adjust.disabled || !snapshot.ready || snapshot.saving) return;
      openLayer(createLightnessAdjuster({ document: host.ownerDocument, controller }));
    });
    return { destroy() { destroyed = true; unsubscribe(); } };
  }

  // 深浅度调节页：透明全屏层露出真实主界面并以深色预览，底部居中调节条。
  // 返回 modal-bridge 的 { overlay, ...descriptor }；预览随层挂载开始、随层释放结束。
  function createLightnessAdjuster({ document, controller }) {
    const max = shared.MAX_DARK_MODE_LIGHTNESS;
    const overlay = document.createElement('div');
    overlay.className = 'dark-lightness-overlay';
    overlay.innerHTML = `
      <div class="dark-lightness-dock" role="dialog" aria-modal="true" aria-label="深浅度调节">
        <p class="dark-lightness-feedback" data-role="dark-lightness-feedback" role="alert" hidden></p>
        <div class="dark-lightness-bar">
          <button class="secondary-btn small" data-role="dark-lightness-cancel" type="button">取消</button>
          <span class="dark-lightness-end" aria-hidden="true">深</span>
          <input class="dark-lightness-range" data-role="dark-lightness-range" type="range" min="${shared.DEFAULT_DARK_MODE_LIGHTNESS}" max="${max}" step="1" aria-label="深色模式深浅度" />
          <span class="dark-lightness-end" aria-hidden="true">浅</span>
          <output class="dark-lightness-value" data-role="dark-lightness-value"></output>
          <button class="primary-btn small" data-role="dark-lightness-save" type="button">保存</button>
        </div>
      </div>`;
    const dialog = overlay.querySelector('.dark-lightness-dock');
    const feedback = overlay.querySelector('[data-role="dark-lightness-feedback"]');
    const range = overlay.querySelector('[data-role="dark-lightness-range"]');
    const value = overlay.querySelector('[data-role="dark-lightness-value"]');
    const cancel = overlay.querySelector('[data-role="dark-lightness-cancel"]');
    const save = overlay.querySelector('[data-role="dark-lightness-save"]');
    let handle = null;
    let saving = false;
    const current = () => shared.normalizeDarkModeLightness(Number(range.value));
    function show(level) {
      range.value = String(level);
      value.textContent = String(level);
    }
    function setSaving(next) {
      saving = next;
      for (const control of [range, cancel, save]) control.disabled = next;
      save.textContent = next ? '保存中…' : '保存';
    }
    show(controller.getSnapshot().darkModeLightness);
    range.addEventListener('input', () => {
      const level = current();
      value.textContent = String(level);
      if (handle) controller.setPreviewLightness(level);
    });
    cancel.addEventListener('click', () => {
      if (!saving) handle?.close({ status: 'cancelled', reason: 'cancel' });
    });
    save.addEventListener('click', async () => {
      if (saving || !handle?.isOpen()) return;
      const level = current();
      feedback.hidden = true;
      setSaving(true);
      try {
        await controller.saveLightness(level);
        setSaving(false);
        handle?.close({ status: 'submitted', value: level });
      } catch (error) {
        setSaving(false);
        // 失败保留调节页与拖动值，已保存值和主题由控制器保持不变。
        feedback.textContent = error?.message || '深浅度保存失败';
        feedback.hidden = false;
      }
    });
    return {
      overlay,
      dialog,
      dismiss: { escape: true, backdrop: false },
      initialFocus: range,
      canClose: () => !saving,
      onMount(mountedHandle, scope) {
        handle = mountedHandle;
        show(controller.startPreview().previewLightness);
        scope.onDispose(() => {
          handle = null;
          controller.stopPreview();
        });
      }
    };
  }

  return { paint, createController, mountSettings, createLightnessAdjuster };
});
