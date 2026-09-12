'use strict';

// 使用：node scripts/verify-biz-op-v329-renderer-dom.js [截图输出目录]
// 仅装载 Biz OP controller、项目样式和内存 API fixture；临时 userData 由父进程清理。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

async function verify() {
  const { app, BrowserWindow } = require('electron');
  const { createHarness, rendererCases } = require('../tests/unit/main-process/biz-op-v329-renderer.test');
  app.setPath('userData', process.env.BIZOP_RENDERER_VERIFY_PROFILE);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 760, webPreferences: { sandbox: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  try {
    const styles = ['styles-gemini.css', 'styles-gemini-extra.css', 'styles-vcc-financial-op.css', 'styles-biz-op-v327.css']
      .map((name) => fs.readFileSync(path.join(ROOT, 'src', name), 'utf8')).join('\n');
    const fixturePath = path.join(process.env.BIZOP_RENDERER_VERIFY_PROFILE, 'renderer-fixture.html');
    fs.writeFileSync(fixturePath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}\nbody { margin: 24px; } #bizOpV327ModulePanel { max-width: 900px; margin: 0 auto; }</style><body data-style="clear"></body></html>`);
    await win.loadFile(fixturePath);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT, 'src/renderer-biz-op-v327.js'), 'utf8'));
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
    for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `\n${result.error}` : ''}`);
    if (results.some((item) => !item.passed)) throw new Error('真实 DOM 行为验证未通过');
    const outputDir = process.argv[2] && path.resolve(process.argv[2]);
    async function screenshot(name) {
      if (!outputDir) return;
      await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await win.webContents.executeJavaScript(`Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})))`);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
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
    await screenshot('biz-op-v329-importing.png');
    const reportDisplay = await win.webContents.executeJavaScript(`(async () => {
      const h = window.preview; const relativePath = 'error-reports/2026-09-11/业务OP导入错误报告-20260911-190500-长文件名-12345678-1234-1234-1234-123456789012.xlsx';
      window.pendingImport.resolve({ status: 'error', message: '本次导入未通过校验', code: 'BIZOP_IMPORT_REJECTED', summary: { scannedDataRows: 1032, acceptedRows: 1031 }, errorReport: { status: 'saved', relativePath } }); await h.flush();
      const text = h.panel.querySelector('.status-box-text'); const range = document.createRange(); range.selectNodeContents(text);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      const result = { selectable: getComputedStyle(text).userSelect, selected: window.getSelection().toString().includes(relativePath), fits: text.scrollWidth <= text.clientWidth + 1 };
      window.getSelection().removeAllRanges(); return result;
    })()`);
    if (reportDisplay.selectable !== 'text' || !reportDisplay.selected || !reportDisplay.fits) throw new Error('报告相对路径未完整换行或无法选择复制');
    await screenshot('biz-op-v329-report-saved.png');
    await win.webContents.executeJavaScript("window.preview.reply.importFiles = { status: 'error', message: '本次导入未通过校验', errorReport: { status: 'pending', message: '请完成恢复后查看任务详情' }, cleanupPending: true }; window.preview.reply.status = { mode: 'ACTIVE', recoveryReady: false }; window.preview.click('导入文件');");
    await screenshot('biz-op-v329-report-pending.png');
    console.log(`真实 DOM ${results.length}/${results.length} PASS；按钮位置、空工具栏、长路径换行和文本选择 PASS${outputDir ? `；截图：${outputDir}` : ''}`);
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
