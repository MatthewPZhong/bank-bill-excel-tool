'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'changes/v3.2.9/codex/v3.2.9-night-mode/night-mode-3.2.9.html');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let html = read('index.html');
// 只打包本分支审核过的静态界面与主题实现，不运行参考附件的脚本。
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
html = html.replace(/<link\b[^>]*>/g, '');
html = html.replace(/<!--[^]*?-->/g, '');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; script-src &#39;unsafe-inline&#39;; img-src data: blob:; connect-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;" />');
html = html.replace('<title>清结算小助手</title>', '<title>清结算小助手 · 3.2.9 定时深色模式</title>');
html = html.replace(/<img class="corner-gif"[^>]*>/, '<div class="corner-gif-slot" aria-hidden="true">☾</div>');
const cssFiles = ['styles-gemini.css', 'styles-gemini-extra.css', 'styles-vcc-financial-op.css', 'styles-biz-op-v327.css', 'styles-dark-mode.css', 'styles-dark-mode-settings.css'];
const css = cssFiles.map((file) => read(`src/${file}`)).join('\n');
const shared = read('src/shared/dark-mode-schedule.js');
const ui = read('src/renderer-dark-mode.js');
const previewFirstPaint = `(function () {
  let config;
  try { config = DarkModeSchedule.normalizeDarkModeSchedule(JSON.parse(localStorage.getItem('bank-bill-night-mode-preview-v329'))); }
  catch (_) { config = DarkModeSchedule.DEFAULT_DARK_MODE_SCHEDULE; }
  DarkModeUI.paint(document, DarkModeSchedule.resolveEffectiveTheme(config, new Date()));
})();`;
html = html.replace('</head>', `<script>${shared}</script><script>${ui}</script><script>${previewFirstPaint}</script><style>${css}</style><style>
  [hidden] { display:none!important; }
  .preview-toast { position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background:var(--panel-strong); border:1px solid var(--line); padding:12px 20px; border-radius:12px; color:var(--text); box-shadow:var(--shadow-md); z-index:2000; font-size:13px; }
  .preview-table-scroll { overflow:auto; max-height:60vh; }
  .page-body { padding-bottom:100px; }
  .appearance-pane { min-height:0; overflow:hidden; }
  .preview-table-dialog { width:min(900px,95vw); }
  .preview-settings-card { width:min(820px,95vw); }
  .preview-settings-card .app-settings-layout { min-height:0; height:min(580px,70vh); }
</style></head>`);
const renderer = read('src/renderer.js');
const names = ['normalizeColorHex','cloneBackgroundSettings','clampColorChannel','mixRgb','hexToRgb','mixColor','rgbToCss','buildBackgroundStyle','buildLightBackgroundStyle'];
const backgroundFunctions = names.map((name) => {
  const found = renderer.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  if (!found) throw new Error(`缺少背景函数 ${name}`);
  return found[0];
}).join('\n');
const bootstrap = `const DEFAULT_BACKGROUND_SETTINGS = { colorHex: '#ffffff' };\n${backgroundFunctions}\n${read('scripts/fixtures/dark-mode-preview.js')}`;
html = html.replace('</body>', `<script>${bootstrap}</script></body>`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(output);
