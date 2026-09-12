/* 单文件预览的浏览器适配器：复用正式时间规则、背景与设置组件，仅使用本地示例数据。 */
const previewStorageKey = 'bank-bill-night-mode-preview-v329';
let schedule;
let revision = 0;
let themeController;
let settingsView = null;
let previousFocus = null;
const rootNode = document.getElementById('modalRoot');
try { schedule = DarkModeSchedule.normalizeDarkModeSchedule(JSON.parse(localStorage.getItem(previewStorageKey))); }
catch (_error) { schedule = { ...DarkModeSchedule.DEFAULT_DARK_MODE_SCHEDULE }; }
function makeSnapshot() {
  return { darkModeSchedule: schedule, effectiveTheme: DarkModeSchedule.resolveEffectiveTheme(schedule, new Date()), themeRevision: ++revision };
}
const previewApi = {
  onDarkModeScheduleChanged() { return () => {}; },
  async setDarkModeSchedule(config) {
    const valid = DarkModeSchedule.validateDarkModeSchedule(config);
    try { localStorage.setItem(previewStorageKey, JSON.stringify(valid)); }
    catch (_error) { return { status: 'failed', message: '浏览器不允许保存设置，请启用本地存储后重试' }; }
    schedule = valid;
    return { status: 'ok', ...makeSnapshot() };
  }
};
function paintBackground() {
  const style = buildBackgroundStyle(DEFAULT_BACKGROUND_SETTINGS);
  Object.assign(document.getElementById('appShell').style, style);
  document.body.style.backgroundColor = document.documentElement.dataset.theme === 'dark' ? '#111419' : '#f9fafc';
}
themeController = DarkModeUI.createController({ api: previewApi, document, onChange: paintBackground });
themeController.accept(makeSnapshot());
function closePreviewModal() {
  if (themeController.getSnapshot().saving) return;
  settingsView?.destroy();
  settingsView = null;
  rootNode.replaceChildren();
  previousFocus?.focus();
}
function openModalShell(title, content, className = '') {
  closePreviewModal();
  previousFocus = document.activeElement;
  rootNode.innerHTML = `<div class="modal-overlay"><section class="modal-card ${className}" role="dialog" aria-modal="true" aria-label="${title}"><div class="dialog-header"><div class="dialog-title">${title}</div><button class="icon-close" data-preview-close aria-label="关闭">×</button></div>${content}<div class="dialog-actions"><button class="primary-btn small" data-preview-close>完成</button></div></section></div>`;
  rootNode.querySelectorAll('[data-preview-close]').forEach((button) => button.addEventListener('click', closePreviewModal));
  rootNode.querySelector('[data-preview-close]').focus();
}
function openPreviewSettings() {
  openModalShell('设置', '<div class="app-settings-layout"><nav class="app-settings-nav" aria-label="设置导航"><button class="app-settings-nav-item is-active" aria-current="page">☾　外观</button></nav><div class="app-settings-main"><section id="previewAppearancePane" class="app-settings-pane appearance-pane" aria-label="外观设置"></section></div></div>', 'preview-settings-card');
  settingsView = DarkModeUI.mountSettings(document.getElementById('previewAppearancePane'), themeController);
}
function openPreviewTable() {
  openModalShell('账户映射 · 示例', '<div class="preview-table-scroll"><table class="data-table"><thead><tr><th>商户</th><th>币种</th><th>大账号</th><th>状态</th></tr></thead><tbody><tr><td>示例商户 A</td><td>USD</td><td><input class="mapping-text-input" aria-label="示例账号" value="DEMO-001" /></td><td style="color:var(--success)">已匹配</td></tr><tr><td>示例商户 B</td><td>HKD</td><td><select class="mapping-select" aria-label="示例账户选择"><option>DEMO-002</option><option>DEMO-003</option></select></td><td style="color:var(--warning)">待确认</td></tr><tr class="migration-empty-row"><td>示例商户 C</td><td>EUR</td><td><input class="mapping-text-input" aria-label="禁用示例账号" value="尚未配置" disabled /></td><td style="color:var(--danger)">缺少映射</td></tr></tbody></table></div>', 'preview-table-dialog');
}
document.getElementById('settingsBtn').addEventListener('click', openPreviewSettings);
document.getElementById('accountMappingBtn').addEventListener('click', openPreviewTable);
const modules = [['statementModulePanel', '网银账单生成'], ['bankStatementModulePanel', '资金对账数据处理'], ['positionReconciliationModulePanel', '平盘对账数据处理']];
const moduleMenu = document.getElementById('moduleSwitcherMenu');
const moduleTrigger = document.getElementById('moduleSwitcherBtn');
moduleMenu.innerHTML = modules.map(([id, name]) => `<button class="module-option" data-panel="${id}">${name}</button>`).join('');
moduleTrigger.addEventListener('click', () => { moduleMenu.hidden = !moduleMenu.hidden; moduleTrigger.setAttribute('aria-expanded', String(!moduleMenu.hidden)); });
moduleMenu.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-panel]');
  if (!choice) return;
  document.querySelectorAll('.module-panel,.new-account-panel').forEach((panel) => { panel.hidden = panel.id !== choice.dataset.panel; });
  document.getElementById('currentModuleName').textContent = choice.textContent;
  moduleMenu.hidden = true;
  moduleTrigger.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePreviewModal();
  if (event.key !== 'Tab' || !rootNode.firstElementChild) return;
  const focusable = [...rootNode.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
document.getElementById('appVersion').textContent = '3.2.9 · 外观预览';
let clockTimer;
function refreshClock() {
  themeController.accept(makeSnapshot());
  const now = new Date();
  clockTimer = setTimeout(refreshClock, 60000 - now.getSeconds() * 1000 - now.getMilliseconds());
}
refreshClock();
window.addEventListener('focus', () => { clearTimeout(clockTimer); refreshClock(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(clockTimer); refreshClock(); } });
window.addEventListener('unload', () => { clearTimeout(clockTimer); themeController.dispose(); });
