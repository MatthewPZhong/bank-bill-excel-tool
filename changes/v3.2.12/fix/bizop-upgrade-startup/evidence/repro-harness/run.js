'use strict';
// 启动器：隔离 userData / documents，加载 hook.js，拉起真实 Electron 主进程（开发模式）。
// 用法：node run.js <label> [userDataDir]
//   BIZOP_APP_DIR           被测应用源码根目录（默认：本仓库根目录）
//   BIZOP_REPRO_OUT         输出根目录（默认：系统临时目录/bizop-upgrade-repro）
//   BIZOP_SIMULATE_WIN_X64  1=模拟 Windows x64 资格与 16/5 GB 内存；默认非 Windows 为 1、Windows 为 0
//   BIZOP_REPRO_TIMEOUT_MS  硬超时（默认 150000）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.resolve(process.env.BIZOP_APP_DIR || path.join(__dirname, '../../../../../..'));
const label = process.argv[2] || 'run';
const out = path.join(process.env.BIZOP_REPRO_OUT || path.join(os.tmpdir(), 'bizop-upgrade-repro'), label);
const userData = path.resolve(process.argv[3] || path.join(out, 'userData'));
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const trace = path.join(out, 'trace.jsonl');
fs.rmSync(trace, { force: true });

const simulate = process.env.BIZOP_SIMULATE_WIN_X64 ?? (process.platform === 'win32' ? '0' : '1');
const electron = require(path.join(APP, 'node_modules/electron'));
// 不设置 APP_CAPTURE_PATH / APP_STARTUP_MEASURE_AUTO_QUIT：两者会跳过单实例锁，
// 而首次升级的 assertStartAllowed 要求持有单实例锁。
const child = spawn(electron, [APP], {
  cwd: APP,
  env: { ...process.env, NODE_OPTIONS: `--require "${path.join(__dirname, 'hook.js')}"`, BIZOP_TRACE_FILE: trace,
    BIZOP_SIMULATE_WIN_X64: simulate, APP_USER_DATA_DIR: userData, APP_DOCUMENTS_DIR: path.join(out, 'Documents'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logFile = fs.createWriteStream(path.join(out, 'electron-output.log'));
child.stdout.pipe(logFile); child.stderr.pipe(logFile);
const timeoutMs = Number(process.env.BIZOP_REPRO_TIMEOUT_MS || 150000);
const timer = setTimeout(() => {
  fs.appendFileSync(trace, JSON.stringify({ ev: 'HARNESS-TIMEOUT-KILL' }) + '\n');
  child.kill('SIGKILL');
}, timeoutMs);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  console.log(`electron exited code=${code} signal=${signal}`);
  console.log(`trace: ${trace}`);
});
