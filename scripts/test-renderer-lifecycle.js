'use strict';

// 真实 Electron DOM + production factories；API 由 fixture 替身控制，不加载 main 或用户数据。
// 用法：node scripts/test-renderer-lifecycle.js [fixture 名称 ...]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-lifecycle-'));
const env = { ...process.env, RENDERER_LIFECYCLE_TEMP: temporary };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const result = spawnSync(require('electron'), [path.join(__dirname, 'renderer-lifecycle/electron-main.cjs'), ...process.argv.slice(2)], {
    cwd: root, env, encoding: 'utf8', stdio: 'inherit', timeout: 120000
  });
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error('Electron test terminated:', result.signal);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
