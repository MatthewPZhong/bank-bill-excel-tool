'use strict';

// 复用本任务的真实确认工厂回归，捕获产品 CSS 下的浅色/深色子弹窗。
// 仅使用合成批次和受控 API；隔离 userData/Documents，不启动产品 Main。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../../..');

if (!process.versions.electron) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-delete-confirm-preview-'));
  const env = { ...process.env, RENDERER_LIFECYCLE_TEMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(require('electron'), [__filename], {
      cwd: root, env, stdio: 'inherit', timeout: 120000
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else {
  const fixturePath = path.join(root, 'scripts/renderer-lifecycle/fixtures/app-settings.js');
  const fixture = require(fixturePath);
  const captures = [];
  require.cache[fixturePath].exports = async context => {
    await fixture({ ...context, test: async (label, work) => {
      const theme = label.match(/^删除确认在 (light|dark) 主题下/)?.[1];
      if (!theme) return;
      await context.test(label, async () => {
        await work();
        await context.js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const win = require('electron').BrowserWindow.getAllWindows()[0];
        const file = `delete-confirm-${theme}.png`;
        fs.writeFileSync(path.join(__dirname, file), (await win.webContents.capturePage()).toPNG());
        const content = await context.js(`(() => {
          const overlay = document.getElementById('modalRoot').lastElementChild;
          return { text: overlay.querySelector('.alert-message').textContent,
            background: getComputedStyle(overlay.querySelector('.modal-card')).backgroundColor,
            buttons: Array.from(overlay.querySelectorAll('button')).map(button => button.textContent) };
        })()`);
        captures.push({ theme, file, ...content });
        console.log(`CAPTURE ${theme}: ${file}`);
      });
    } });
    const inputs = ['src/renderer/dialogs/app-settings.js', 'src/renderer.js',
      'scripts/renderer-lifecycle/fixtures/app-settings.js', 'src/styles-gemini.css',
      'src/styles-gemini-extra.css', 'src/styles-dark-mode.css'];
    fs.writeFileSync(path.join(__dirname, 'delete-confirm-preview.json'), JSON.stringify({
      boundary: '真实 Electron DOM、生产确认工厂与产品 CSS；合成批次及受控 API，不包含产品 Main、真实文件删除或 Windows 验收。',
      captures,
      inputs: inputs.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }))
    }, null, 2) + '\n');
  };
  process.argv = [process.argv[0], __filename, 'app-settings'];
  require(path.join(root, 'scripts/renderer-lifecycle/electron-main.cjs'));
}
