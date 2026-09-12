'use strict';

// 使用：node scripts/verify-biz-op-v329-renderer-dom.js [证据输出目录]
// 仅装载 Biz OP controller、项目样式和内存 API fixture；临时 userData 由父进程清理。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');

// 在 Chromium 中读取最终文本颜色并合成祖先背景，避免把透明背景误作白色。
function inspectStatus(expected) {
  const h = window.preview; const status = h.status(); const text = status.querySelector('.status-box-text');
  const parseColor = (value) => { const values = value.match(/[\d.]+/g).map(Number); return [values[0], values[1], values[2], values[3] ?? 1]; };
  const composite = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
  const ancestry = []; for (let node = text; node; node = node.parentElement) ancestry.unshift(node);
  const background = ancestry.reduce((color, node) => composite(parseColor(getComputedStyle(node).backgroundColor), color), [255, 255, 255]);
  const foreground = composite(parseColor(getComputedStyle(text).color), background);
  const luminance = (color) => color.map((value) => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const [lo, hi] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  const contrast = (hi + 0.05) / (lo + 0.05);
  const token = expected.tone === 'error' ? 'danger' : expected.tone;
  const probe = document.createElement('span'); probe.style.color = `var(--${token})`; document.body.append(probe);
  const expectedColor = getComputedStyle(probe).color;
  probe.style.color = `var(--${token}-soft)`; const softColor = getComputedStyle(probe).color; probe.remove();
  const style = getComputedStyle(status);
  if (status.dataset.tone !== expected.tone) throw new Error(`状态语义错误：${status.dataset.tone} / ${expected.tone}`);
  if (getComputedStyle(text).color !== expectedColor) throw new Error(`状态文本没有使用 ${token} 语义色：${getComputedStyle(text).color} / ${expectedColor}`);
  if (contrast < 4.5) throw new Error(`状态文本对比度不足 4.5:1：${contrast}`);
  if ((document.documentElement.dataset.theme === 'dark' || expected.tone !== 'warning') && style.backgroundColor !== softColor) throw new Error(`状态卡背景没有使用 ${token}-soft 语义色`);
  for (const message of expected.messages) if (!h.text().includes(message)) throw new Error(`状态文本缺少：${message}`);
  if (expected.noPath && h.text().includes('error-reports/')) throw new Error('未确认的报告路径不应展示');
  return { tone: status.dataset.tone, color: getComputedStyle(text).color, background: style.backgroundColor, border: style.borderColor,
    composedBackground: background, contrast, text: h.text() };
}

async function verify() {
  const { app, BrowserWindow } = require('electron');
  const { createHarness, rendererCases } = require('../tests/unit/main-process/biz-op-v329-renderer.test');
  app.setPath('userData', process.env.BIZOP_RENDERER_VERIFY_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 760, webPreferences: { sandbox: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  try {
    // 直接复用 index 的样式顺序，包含夜间模式与设置样式；字体 URL 仍相对真实 CSS 解析。
    const stylePaths = [...fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)].map((match) => match[1]);
    if (!stylePaths.some((file) => file.endsWith('/styles-dark-mode.css')) || !stylePaths.some((file) => file.endsWith('/styles-dark-mode-settings.css'))) throw new Error('index 缺少夜间模式样式');
    const links = stylePaths.map((file) => `<link rel="stylesheet" href="${pathToFileURL(path.join(ROOT, file)).href}">`).join('\n');
    const fixturePath = path.join(process.env.BIZOP_RENDERER_VERIFY_PROFILE, 'renderer-fixture.html');
    fs.writeFileSync(fixturePath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${links}<style>body { margin: 24px; } #bizOpV327ModulePanel { max-width: 900px; margin: 0 auto; }</style><body data-style="clear"></body></html>`);
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'src/renderer-biz-op-v327.js'), 'utf8'));
    const allResults = []; const visualResults = [];
    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
      const results = await win.webContents.executeJavaScript(`(async () => {
        window.makeHarness = ${createHarness.toString()};
        const queue = []; const assert = {
          equal(a, b, message) { if (!Object.is(a, b)) throw new Error(message || ('实际值与预期值不一致：' + String(a) + ' / ' + String(b)));  },
          notEqual(a, b) { if (Object.is(a, b)) throw new Error('实际值不应与预期值相同'); },
          deepEqual(a, b) { if (a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))) throw new Error('数组元素不一致'); },
          ok(value, message) { if (!value) throw new Error(message || '断言失败'); }
        };
        (${rendererCases.toString()})((name, work) => queue.push({ name, work }), assert, () => window.makeHarness(window));
        const results = [];
        for (const entry of queue) {
          try { await entry.work(); results.push({ name: entry.name, passed: true }); }
          catch (error) { results.push({ name: entry.name, passed: false, error: error.stack }); }
        }
        return results;
      })()`);
      allResults.push(...results.map((result) => ({ theme, ...result })));
      for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} [${theme}] ${result.name}${result.error ? `\n${result.error}` : ''}`);
      if (results.length !== 10 || results.some((item) => !item.passed)) throw new Error('真实 DOM 行为验证未通过');
      const outputDir = process.argv[2] && path.resolve(process.argv[2]);
      async function screenshot(name) {
        if (!outputDir) return;
        await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await win.webContents.executeJavaScript(`Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))`);
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, name.replace('biz-op-v329-', `biz-op-v329-${theme}-`)), (await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript('window.preview = window.makeHarness(window); window.preview.controller.setSelected(true);');
      await screenshot('biz-op-v329-initial.png');
      const layout = await win.webContents.executeJavaScript(`(async () => {
        const h = window.preview; const button = h.find('导入文件');
        const before = button.getBoundingClientRect().toJSON();
        window.pendingImport = h.deferred(); h.reply.importFiles = () => window.pendingImport.promise;
        await h.click('导入文件');
        return { before, during: button.getBoundingClientRect().toJSON(), footerDisplay: getComputedStyle(h.panel.querySelector('.bizop-secondary')).display };
      })()`);
      if (JSON.stringify(layout.before) !== JSON.stringify(layout.during) || layout.footerDisplay !== 'none') throw new Error('导入按钮位置或空工具栏布局不符合约定');
      visualResults.push({ theme, name: '导入按钮原位与空工具栏隐藏', passed: true, ...layout });
      await screenshot('biz-op-v329-importing.png');
      const reportDisplay = await win.webContents.executeJavaScript(`(async () => {
        const h = window.preview; const relativePath = 'error-reports/2026-09-12/' + '业务OP导入错误报告长文件名'.repeat(12) + '-12345678-1234-1234-1234-123456789012.xlsx';
        window.pendingImport.resolve({ status: 'error', message: '本次导入未通过校验', code: 'BIZOP_IMPORT_REJECTED', summary: { scannedDataRows: 1032, acceptedRows: 1031 }, errorReport: { status: 'saved', relativePath } }); await h.flush();
        const text = h.panel.querySelector('.status-box-text'); const range = document.createRange(); range.selectNodeContents(text);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        const result = { selectable: getComputedStyle(text).userSelect, selected: window.getSelection().toString().includes(relativePath), fits: text.scrollWidth <= text.clientWidth + 1, whiteSpace: getComputedStyle(text).whiteSpace };
        window.getSelection().removeAllRanges(); return result;
      })()`);
      if (reportDisplay.selectable !== 'text' || !reportDisplay.selected || !reportDisplay.fits || reportDisplay.whiteSpace !== 'pre-wrap') throw new Error('报告相对路径未完整换行或无法选择复制');
      visualResults.push({ theme, name: '长报告路径换行与文本选择', passed: true, ...reportDisplay });
      await win.webContents.executeJavaScript(`void (window.inspectStatus = ${inspectStatus.toString()});`);
      const scenarios = [
        { name: 'report-saved', tone: 'error', messages: ['本次导入未通过校验', '错误报告已保存：', 'error-reports/'] },
        { name: 'report-failed', result: { status: 'error', message: '原始校验失败', errorReport: { status: 'failed', message: '目标目录暂时不可写', relativePath: 'error-reports/unconfirmed.xlsx' } }, tone: 'error', messages: ['原始校验失败', '错误报告保存失败'], noPath: true },
        { name: 'report-pending', result: { status: 'error', message: '原始校验失败', errorReport: { status: 'pending', message: '请完成恢复后查看任务详情', relativePath: 'error-reports/unconfirmed.xlsx' }, cleanupPending: true }, tone: 'error', messages: ['原始校验失败', '错误报告发布状态待核验', '仍有收尾未决'], noPath: true },
        { name: 'cleanup-warning', result: { status: 'ok', cleanupPending: true }, tone: 'warning', messages: ['导入文件完成', '仍有收尾未决'] },
        { name: 'success', result: { status: 'ok', summary: { scannedDataRows: 1032, acceptedRows: 1032 } }, tone: 'success', messages: ['导入文件完成', '扫描 1032 行，接受 1032 行'] }
      ];
      for (const scenario of scenarios) {
        if (scenario.result) await win.webContents.executeJavaScript(`(async () => { window.preview.reply.importFiles = ${JSON.stringify(scenario.result)}; await window.preview.click('导入文件'); })()`);
        await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        await win.webContents.executeJavaScript('Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))');
        const appearance = await win.webContents.executeJavaScript(`window.inspectStatus(${JSON.stringify(scenario)})`);
        visualResults.push({ theme, name: scenario.name, passed: true, ...appearance });
        await screenshot(`biz-op-v329-${scenario.name}.png`);
        console.log(`PASS [${theme}] ${scenario.name} ${appearance.tone} 对比度 ${appearance.contrast.toFixed(3)}:1`);
      }
      await win.webContents.executeJavaScript('window.preview.close();');
    }
    const outputDir = process.argv[2] && path.resolve(process.argv[2]);
    const sourceFiles = ['index.html', 'src/renderer-biz-op-v327.js', 'tests/unit/main-process/biz-op-v329-renderer.test.js', 'scripts/verify-biz-op-v329-renderer-dom.js', ...stylePaths.map((file) => file.replace(/^\.\//, ''))];
    const viewport = await win.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, devicePixelRatio })');
    const evidence = { generatedAt: new Date().toISOString(), scope: '隔离 Electron 真实 DOM 与 Controller，API fixture；未启动 Main、未接触业务数据', windowSize: win.getSize(), viewport, webZoom: win.webContents.getZoomFactor(),
      sourceFiles: sourceFiles.map((file) => ({ path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex') })), rendererCases: allResults, visualChecks: visualResults };
    if (outputDir) fs.writeFileSync(path.join(outputDir, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`真实 DOM ${allResults.length}/${allResults.length} PASS；双主题布局、长路径与状态语义色 ${visualResults.length}/${visualResults.length} PASS${outputDir ? `；证据：${outputDir}` : ''}`);
  } finally { win.destroy(); app.quit(); }
}

if (process.versions.electron && process.type === 'browser') {
  verify().catch((error) => { console.error(error.stack); require('electron').app.exit(1); });
} else {
  const { spawnSync } = require('node:child_process');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-v329-dom-'));
  const env = { ...process.env, BIZOP_RENDERER_VERIFY_PROFILE: userData }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.signal) console.error(`隔离 Electron DOM 验证进程被 ${result.signal} 终止。`);
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(userData, { recursive: true, force: true }); }
}
