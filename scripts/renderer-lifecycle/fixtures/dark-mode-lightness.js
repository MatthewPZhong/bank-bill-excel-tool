'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');

// v3.2.17 深浅度调节：真实主界面静态结构、生产样式、设置弹窗、DarkModeUI 与模态宿主；
// 外观 API 为受控替身（内存），不加载 Main、不读写用户数据。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const root = path.resolve(__dirname, '../../..');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const program = acorn.parse(renderer, { ecmaVersion: 'latest' }).body;
  const escapeHtmlNode = program.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'escapeHtml');
  const modulesNode = program.find((node) => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'MODULES');
  assert.ok(escapeHtmlNode && modulesNode, '生产 escapeHtml 与 MODULES 应存在');
  const escapeHtmlSource = renderer.slice(escapeHtmlNode.start, escapeHtmlNode.end);
  const modulesSource = renderer.slice(modulesNode.declarations[0].init.start, modulesNode.declarations[0].init.end);
  // 主界面使用 index.html 的静态结构（去掉脚本），相对资源改为仓库内绝对地址。
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const body = index.match(/<body[^>]*>([\s\S]*)<\/body>/)[1]
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/(src|href)="\.\/([^"]+)"/g, (_match, attribute, file) => `${attribute}="${pathToFileURL(path.join(root, file)).href}"`);

  async function setup({ theme = 'light', lightness = 0, width = 1240, height = 860, zoom = 1, open = true } = {}) {
    await reset(body, { layout: { width, height, theme, zoom } });
    await js(escapeHtmlSource + '\n;void 0;');
    await load('src/shared/dark-mode-schedule.js');
    await load('src/renderer-dark-mode.js');
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer/dialogs/app-settings.js');
    await js(`
      window.FIXTURE_MODULES = ${modulesSource};
      window.dm = { calls: [], revision: 1, lightness: ${lightness}, theme: ${JSON.stringify(theme)}, mode: 'ok', hold: null };
      dm.defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
      dm.snapshot = () => ({ darkModeSchedule: { enabled: true, startTime: '17:30', endTime: '07:00' },
        darkModeLightness: dm.lightness, effectiveTheme: dm.theme, themeRevision: dm.revision });
      dm.api = {
        onDarkModeScheduleChanged(listener) { dm.listener = listener; return () => { dm.listener = null; }; },
        async setDarkModeSchedule() { return { status: 'ok', ...dm.snapshot() }; },
        async setDarkModeLightness(value) {
          dm.calls.push(value);
          if (dm.hold) await dm.hold.promise;
          if (dm.mode === 'fail') return { status: 'failed', message: '模拟数据库写入失败' };
          dm.lightness = value;
          dm.revision += 1;
          return { status: 'ok', ...dm.snapshot() };
        }
      };
      dm.controller = DarkModeUI.createController({ api: dm.api, document });
      dm.controller.accept(dm.snapshot());
      dm.bridge = window.__rendererModalBridge;
      dm.dialogs = window.__createTestRendererDialogs({ modalBridge: dm.bridge, state: {}, elements: {}, desktopApi: {}, appConstants: {} });
      dm.settings = window.__appSettingsDialogs.createAppSettingsDialogs({
        api: {}, modalBridge: dm.bridge, modules: FIXTURE_MODULES,
        ui: { escapeHtml, createConfirmDialog: dm.dialogs.createConfirmDialog,
          getDarkModeController: () => dm.controller,
          mountAppearanceSettings: (panel, controller, options) => DarkModeUI.mountSettings(panel, controller, options),
          applyAppUpdateActionResult() {}, applyAppUpdateStatus() {}, getAppUpdateStatus: () => ({}),
          refreshOpenAppUpdateDialog() {}, restartAndInstallAppUpdate() {} } });
      dm.open = () => {
        dm.handle = dm.bridge.openModal(() => (dm.overlay = dm.settings.createAppUpdateSettingsDialog())).handle;
        dm.overlay.querySelector('[data-tab="appearance"]').click();
      };
      dm.modalRoot = document.getElementById('modalRoot');
      dm.layer = () => document.querySelector('.dark-lightness-overlay');
      dm.q = (selector) => document.querySelector(selector);
      dm.range = () => dm.q('[data-role="dark-lightness-range"]');
      dm.slide = (value) => { const range = dm.range(); range.value = String(value); range.dispatchEvent(new Event('input', { bubbles: true })); };
      dm.bg = () => getComputedStyle(document.body).backgroundColor;
      dm.inlineBg = () => document.documentElement.style.getPropertyValue('--bg');
      dm.visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      };
      void 0;`);
    if (open) await js('dm.open(); void 0;');
    await layout.settle();
  }

  async function openAdjuster() {
    await js(`dm.overlay.querySelector('[data-role="dark-mode-lightness-adjust"]').click(); void 0;`);
    await layout.settle();
  }

  await test('外观设置开始时间下方显示「深浅度调节」与【调节】', async () => {
    await setup();
    const geometry = await js(`(() => {
      const start = dm.overlay.querySelector('[data-role="dark-mode-start"]').getBoundingClientRect();
      const row = dm.overlay.querySelector('.appearance-lightness-row');
      const label = row.querySelector('.appearance-lightness-label');
      const button = row.querySelector('[data-role="dark-mode-lightness-adjust"]');
      const labelRect = label.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return { label: label.textContent, button: button.textContent, enabled: !button.disabled,
        belowStart: labelRect.top >= start.bottom, alignedWithStart: Math.abs(labelRect.left - start.left) <= 1,
        buttonRightOfLabel: buttonRect.left > labelRect.right, visible: dm.visible(label) && dm.visible(button) };
    })()`);
    assert.deepEqual(geometry, { label: '深浅度调节', button: '调节', enabled: true,
      belowStart: true, alignedWithStart: true, buttonRightOfLabel: true, visible: true });
    await layout.evidence('dark-lightness-settings-light', { geometry });
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('浅色时点【调节】隐藏设置弹窗，以已保存深浅度深色预览真实主界面，底部居中调节条', async () => {
    await setup({ lightness: 30 });
    assert.equal(await js('dm.bg()'), 'rgb(249, 250, 252)');
    await openAdjuster();
    const state = await js(`(() => {
      const dock = dm.q('.dark-lightness-dock').getBoundingClientRect();
      const bar = dm.q('.dark-lightness-bar');
      const order = [...bar.children].map((element) => element.textContent || element.getAttribute('aria-label'));
      return { layers: dm.modalRoot.children.length, settingsHidden: getComputedStyle(dm.overlay).visibility,
        settingsInert: dm.overlay.inert, theme: document.documentElement.dataset.theme, range: dm.range().value,
        value: dm.q('[data-role="dark-lightness-value"]').textContent, inlineBg: dm.inlineBg(), bg: dm.bg(),
        centered: Math.abs((dock.left + dock.right) / 2 - innerWidth / 2) <= 1, nearBottom: innerHeight - dock.bottom <= 40,
        order, focused: document.activeElement === dm.range(), visible: dm.visible(bar),
        shellVisible: dm.visible(document.querySelector('.app-shell') || document.body) };
    })()`);
    assert.deepEqual(state, { layers: 2, settingsHidden: 'hidden', settingsInert: true, theme: 'dark', range: '30',
      value: '30', inlineBg: '#1d2027', bg: 'rgb(29, 32, 39)', centered: true, nearBottom: true,
      order: ['取消', '深', '深色模式深浅度', '浅', '30', '保存'], focused: true, visible: true, shellVisible: true });
  });

  await test('拖动实时变色，【取消】与 Esc 恢复原深浅度和浅色并回到设置', async () => {
    for (const exit of ['cancel', 'escape']) {
      await setup({ lightness: 30 });
      await openAdjuster();
      await js('dm.slide(100); void 0;');
      assert.deepEqual(await js(`({ value: dm.q('[data-role="dark-lightness-value"]').textContent, bg: dm.bg(),
        panel: document.documentElement.style.getPropertyValue('--panel') })`),
      { value: '100', bg: 'rgb(56, 61, 70)', panel: '#434953' });
      await js('dm.slide(0); void 0;');
      assert.deepEqual(await js('({ inlineBg: dm.inlineBg(), bg: dm.bg() })'), { inlineBg: '', bg: 'rgb(17, 20, 25)' });
      if (exit === 'cancel') await layout.click('[data-role="dark-lightness-cancel"]');
      else await layout.key('Escape');
      assert.deepEqual(await js(`({ layers: dm.modalRoot.children.length, theme: document.documentElement.dataset.theme,
        inlineBg: dm.inlineBg(), settingsVisible: getComputedStyle(dm.overlay).visibility, calls: dm.calls,
        saved: dm.controller.getSnapshot().darkModeLightness, preview: dm.controller.getSnapshot().previewLightness })`),
      { layers: 1, theme: 'light', inlineBg: '', settingsVisible: 'visible', calls: [], saved: 30, preview: null });
    }
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('深色时段【保存】写入后回到设置并立即生效，再次打开显示新值', async () => {
    await setup({ theme: 'dark', lightness: 0 });
    assert.equal(await js('dm.bg()'), 'rgb(17, 20, 25)');
    await openAdjuster();
    await js('dm.slide(60); void 0;');
    await layout.click('[data-role="dark-lightness-save"]');
    await js('new Promise((resolve) => setTimeout(resolve, 20))');
    assert.deepEqual(await js(`({ calls: dm.calls, layers: dm.modalRoot.children.length, theme: document.documentElement.dataset.theme,
      saved: dm.controller.getSnapshot().darkModeLightness, bg: dm.bg(), settingsOpen: dm.handle.isOpen() })`),
    { calls: [60], layers: 1, theme: 'dark', saved: 60, bg: 'rgb(40, 45, 52)', settingsOpen: true });
    await openAdjuster();
    assert.equal(await js('dm.range().value'), '60');
    await layout.key('Escape');
    assert.equal(await js('dm.bg()'), 'rgb(40, 45, 52)');
  });

  await test('保存中不能取消或关闭；失败保留调节页、拖动值与提示，已保存值不变', async () => {
    await setup({ lightness: 20 });
    await openAdjuster();
    await js(`dm.slide(80); dm.mode = 'fail'; dm.hold = dm.defer(); dm.q('[data-role="dark-lightness-save"]').click(); void 0;`);
    await layout.settle();
    assert.deepEqual(await js(`({ saveText: dm.q('[data-role="dark-lightness-save"]').textContent,
      disabled: ['cancel', 'range', 'save'].map((role) => dm.q('[data-role="dark-lightness-' + role + '"]').disabled),
      closeSettings: dm.handle.close().status })`),
    { saveText: '保存中…', disabled: [true, true, true], closeSettings: 'blocked' });
    await layout.key('Escape');
    assert.equal(await js('dm.modalRoot.children.length'), 2);
    await js('dm.hold.resolve(); new Promise((resolve) => setTimeout(resolve, 20))');
    const failed = await js(`({ layers: dm.modalRoot.children.length, feedback: dm.q('[data-role="dark-lightness-feedback"]').textContent,
      feedbackVisible: dm.visible(dm.q('[data-role="dark-lightness-feedback"]')), range: dm.range().value,
      disabled: dm.q('[data-role="dark-lightness-save"]').disabled, saved: dm.controller.getSnapshot().darkModeLightness,
      inlineBg: dm.inlineBg() })`);
    assert.deepEqual(failed, { layers: 2, feedback: '模拟数据库写入失败', feedbackVisible: true, range: '80',
      disabled: false, saved: 20, inlineBg: '#30353d' });
    await js('new Promise((resolve) => setTimeout(resolve, 250))');
    await layout.evidence('dark-lightness-save-failed', { failed });
    await js(`dm.mode = 'ok'; dm.hold = null; void 0;`);
    await layout.click('[data-role="dark-lightness-save"]');
    await js('new Promise((resolve) => setTimeout(resolve, 20))');
    assert.deepEqual(await js(`({ calls: dm.calls, layers: dm.modalRoot.children.length, saved: dm.controller.getSnapshot().darkModeLightness,
      theme: document.documentElement.dataset.theme, inlineBg: dm.inlineBg() })`),
    { calls: [80, 80], layers: 1, saved: 80, theme: 'light', inlineBg: '' });
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('预览期间到点切换浅色只更新快照，退出后按最新主题重绘', async () => {
    await setup({ theme: 'dark', lightness: 40 });
    await openAdjuster();
    await js(`dm.theme = 'light'; dm.revision += 1; dm.listener(dm.snapshot()); void 0;`);
    assert.deepEqual(await js(`({ theme: document.documentElement.dataset.theme, inlineBg: dm.inlineBg() })`),
      { theme: 'dark', inlineBg: '#21242b' });
    await layout.key('Escape');
    assert.deepEqual(await js(`({ theme: document.documentElement.dataset.theme, inlineBg: dm.inlineBg() })`),
      { theme: 'light', inlineBg: '' });
  });

  for (const [name, lightness, width, height, zoom = 1] of [
    ['dark-lightness-preview-0', 0, 1240, 860],
    ['dark-lightness-preview-50', 50, 1240, 860],
    ['dark-lightness-preview-100', 100, 1240, 860],
    ['dark-lightness-preview-min-window', 100, 1080, 760],
    // 既有深色模式验收范围含 125%/150% 缩放；最小窗口缩放后 CSS 视口仅约 864/720px。
    ['dark-lightness-preview-min-window-zoom-125', 100, 1080, 760, 1.25],
    ['dark-lightness-preview-min-window-zoom-150', 100, 1080, 760, 1.5]
  ]) {
    await test(`${width}×${height}${zoom === 1 ? '' : ` @${zoom * 100}%`} 深浅度 ${lightness} 预览：调节条完整可见、主界面露出`, async () => {
      await setup({ lightness, width, height, zoom });
      await openAdjuster();
      const geometry = await js(`(() => {
        const bar = dm.q('.dark-lightness-bar');
        const barRect = bar.getBoundingClientRect();
        const tools = document.querySelector('.background-tool-actions').getBoundingClientRect();
        const range = dm.range().getBoundingClientRect();
        return { barVisible: dm.visible(bar), rangeWidth: Math.round(range.width),
          clearOfTools: barRect.left >= tools.right || barRect.bottom <= tools.top,
          controls: [...bar.querySelectorAll('button, input, output')].every((element) => dm.visible(element)),
          bg: dm.bg() };
      })()`);
      assert.equal(geometry.barVisible && geometry.clearOfTools && geometry.controls, true, JSON.stringify(geometry));
      assert.ok(geometry.rangeWidth >= 240, `调节条过窄：${geometry.rangeWidth}px`);
      await layout.settle();
      await js('new Promise((resolve) => setTimeout(resolve, 250))');
      await layout.evidence(name, { geometry });
    });
  }

  await test('深色设置页显示调节入口（深浅度 100）', async () => {
    await setup({ theme: 'dark', lightness: 100 });
    await js('dm.controller.accept({ ...dm.snapshot(), themeRevision: dm.revision + 1 }); void 0;');
    await layout.settle();
    await js('new Promise((resolve) => setTimeout(resolve, 250))');
    assert.equal(await js('dm.inlineBg()'), '#383d46');
    await layout.evidence('dark-lightness-settings-dark-100', {});
  });
};
