/*
 * v2.1.10 Phase 0 POC — utilityProcess 路径主脚本
 *
 * 用 Electron 启动（utilityProcess.fork 必须在 app.whenReady 后）：
 *   electron scripts/poc/v2.1.10-a3-utility-process.js
 *
 * 实测 4 项目标与 worker_threads POC 一致（spec §2.6）：
 *   1. 启动延迟（cold-start）：10 次取均值；通过 < 200ms
 *   2. IPC 延迟：1000 次 round-trip；通过 < 10ms
 *   3. 错误堆栈完整度：child throw → main 接收序列化错误 → stack 含 child 路径 + 行号
 *   4. cancel 响应延迟：child 5s 任务 + 1s cancel → < 1s
 *
 * 关键 DatabaseSync 验证：utilityProcess 内能否 require + 实例化
 *
 * 注意：
 *   - utilityProcess 在 Electron 上下文下 console.log 可能不到 stdout；
 *     所以本脚本主进程内部 console.log 由 Electron 命令行显示；子进程内部用 postMessage 上报。
 *   - 跑完不依赖窗口（headless）— 取得测试结果后 app.exit()
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { app, utilityProcess } = require('electron');

const CHILD_SCRIPT = path.join(__dirname, 'v2.1.10-a3-utility-process-child.js');

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null,
    code: err.code || null,
  };
}

function deserializeError(serialized) {
  if (!serialized) return new Error('unknown error');
  const err = new Error(serialized.message);
  err.name = serialized.name;
  err.stack = serialized.stack || err.stack;
  if (serialized.code) err.code = serialized.code;
  return err;
}

function getTempDbPath() {
  return path.join(os.tmpdir(), 'poc-v2.1.10-utility-process.sqlite');
}

function prepareTempDb(dbPath) {
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suf, { force: true }); } catch (e) {}
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS poc_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      n INTEGER NOT NULL,
      tag TEXT
    );
  `);
  db.exec('BEGIN');
  const stmt = db.prepare('INSERT INTO poc_rows (n, tag) VALUES (?, ?)');
  for (let i = 0; i < 10000; i++) {
    stmt.run(i, 'poc-' + (i % 10));
  }
  db.exec('COMMIT');
  db.close();
}

function cleanupTempDb(dbPath) {
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suf, { force: true }); } catch (e) {}
  }
}

// utilityProcess 的 message 事件 payload 直接是数据（不是 { data }）— 实测 Electron 36 在主进程侧
// 但 child 侧 process.parentPort.on('message', e => e.data) 需要解包；child 侧已处理
function forkChild() {
  // stdio: pipe stdout/stderr 便于 debug；默认是 'inherit' 但 utilityProcess 默认 inherit 也行
  const proc = utilityProcess.fork(CHILD_SCRIPT, [], {
    serviceName: 'poc-v2.1.10-utility-process',
    stdio: 'pipe',
  });
  if (proc.stdout) proc.stdout.on('data', (d) => process.stdout.write('[child-stdout] ' + d));
  if (proc.stderr) proc.stderr.on('data', (d) => process.stderr.write('[child-stderr] ' + d));
  return proc;
}

function waitForSpawn(proc) {
  // utilityProcess 没有显式的 'ready'/'spawn' 事件；fork 同步返回，但 pid 在 spawn 后才有
  // 主端 postMessage 在 spawn 前发也会被缓冲（与 Node IPC 一致），所以可直接发 init
  // 这里返回一个 promise，仅在主端 message 到时 resolve
  return Promise.resolve();
}

async function runOneInitRound(dbPath) {
  const proc = forkChild();
  const t0 = performance.now();
  const initRes = await new Promise((resolve, reject) => {
    let settled = false;
    const onMsg = (msg) => {
      if (msg && (msg.type === 'init-done' || msg.type === 'init-error')) {
        settled = true;
        proc.off('message', onMsg);
        resolve(msg);
      }
    };
    proc.on('message', onMsg);
    proc.on('error', (...args) => { if (!settled) { settled = true; reject(new Error('child error: ' + JSON.stringify(args))); } });
    proc.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('child exit ' + code)); } });
    proc.postMessage({ type: 'init', dbPath });
  });
  const t1 = performance.now();
  // 关闭子进程
  const exitPromise = new Promise((r) => proc.once('exit', r));
  proc.postMessage({ type: 'close' });
  // 兜底 timeout
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1000))]);
  if (proc.pid) {
    try { proc.kill(); } catch (e) {}
  }
  return { startupMs: t1 - t0, initRes };
}

async function runAllTests() {
  const dbPath = getTempDbPath();
  const results = [];

  console.log('# v2.1.10 Phase 0 POC — utilityProcess 路径');
  console.log('# main script:', __filename);
  console.log('# child script:', CHILD_SCRIPT);
  console.log('# electron:', process.versions.electron);
  console.log('# node:', process.versions.node);
  console.log('# dbPath:', dbPath);
  console.log('');

  console.log('[main] preparing temp sqlite db ...');
  prepareTempDb(dbPath);
  console.log('[main] temp db ready (10000 rows).');
  console.log('');

  try {
    // ─────────────────────────────────────
    // 测试 1：启动延迟（cold-start × 10）
    // ─────────────────────────────────────
    console.log('# 测试 1：启动延迟（cold-start × 10）');
    const startupTimes = [];
    let firstInitRes = null;
    for (let i = 0; i < 10; i++) {
      const { startupMs, initRes } = await runOneInitRound(dbPath);
      startupTimes.push(startupMs);
      if (i === 0) firstInitRes = initRes;
    }
    const startupAvg = startupTimes.reduce((a, b) => a + b, 0) / startupTimes.length;
    const startupMin = Math.min(...startupTimes);
    const startupMax = Math.max(...startupTimes);
    const startupPass = startupAvg < 200;
    results.push({
      test: '启动延迟（cold-start）',
      metric: 'avg ms (10 次)',
      value: Number(startupAvg.toFixed(2)),
      min: Number(startupMin.toFixed(2)),
      max: Number(startupMax.toFixed(2)),
      threshold: '< 200ms',
      pass: startupPass,
    });
    console.log('  init result（第 1 次）:', JSON.stringify(firstInitRes, null, 2));
    console.log('  startup avg:', startupAvg.toFixed(2), 'ms / min:', startupMin.toFixed(2), '/ max:', startupMax.toFixed(2));
    console.log('  pass(< 200ms):', startupPass);
    console.log('');

    // ─────────────────────────────────────
    // 持久 child 跑测试 2-4
    // ─────────────────────────────────────
    const proc = forkChild();
    await new Promise((resolve, reject) => {
      let settled = false;
      const onMsg = (msg) => {
        if (msg && msg.type === 'init-done') { settled = true; proc.off('message', onMsg); resolve(); }
        if (msg && msg.type === 'init-error') { settled = true; proc.off('message', onMsg); reject(deserializeError(msg.error)); }
      };
      proc.on('message', onMsg);
      proc.postMessage({ type: 'init', dbPath });
    });

    // ─────────────────────────────────────
    // 测试 2：IPC 延迟（1000 次 ping/pong）
    // ─────────────────────────────────────
    console.log('# 测试 2：IPC 延迟（1000 次 round-trip）');
    const pingTimes = [];
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await new Promise((resolve) => {
        const onMsg = (msg) => {
          if (msg && msg.type === 'pong' && msg.n === i) {
            proc.off('message', onMsg);
            resolve();
          }
        };
        proc.on('message', onMsg);
        proc.postMessage({ type: 'ping', n: i });
      });
      pingTimes.push(performance.now() - t0);
    }
    const ipcAvg = pingTimes.reduce((a, b) => a + b, 0) / pingTimes.length;
    const ipcMin = Math.min(...pingTimes);
    const ipcMax = Math.max(...pingTimes);
    const ipcP95 = pingTimes.slice().sort((a, b) => a - b)[Math.floor(N * 0.95)];
    const ipcPass = ipcAvg < 10;
    results.push({
      test: 'IPC 延迟（round-trip）',
      metric: 'avg ms (1000 次)',
      value: Number(ipcAvg.toFixed(3)),
      min: Number(ipcMin.toFixed(3)),
      max: Number(ipcMax.toFixed(3)),
      p95: Number(ipcP95.toFixed(3)),
      threshold: '< 10ms',
      pass: ipcPass,
    });
    console.log('  ipc avg:', ipcAvg.toFixed(3), 'ms / min:', ipcMin.toFixed(3), '/ max:', ipcMax.toFixed(3), '/ p95:', ipcP95.toFixed(3));
    console.log('  pass(< 10ms):', ipcPass);
    console.log('');

    // ─────────────────────────────────────
    // 测试 3：错误堆栈完整度
    // ─────────────────────────────────────
    console.log('# 测试 3：错误堆栈完整度');
    const throwResult = await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg && msg.type === 'throw-result') {
          proc.off('message', onMsg);
          resolve(msg);
        }
      };
      proc.on('message', onMsg);
      proc.postMessage({ type: 'throw' });
    });
    const recoveredErr = deserializeError(throwResult.error);
    const scriptBasename = path.basename(CHILD_SCRIPT);
    const stackHasChildPath = recoveredErr.stack && recoveredErr.stack.includes(scriptBasename);
    const stackHasDeepFn = recoveredErr.stack && recoveredErr.stack.includes('deepFn');
    const stackHasLineNum = recoveredErr.stack && /:\d+:\d+/.test(recoveredErr.stack);
    const stackPass = !!(stackHasChildPath && stackHasDeepFn && stackHasLineNum);
    results.push({
      test: '错误堆栈完整度',
      metric: 'stack 含 child 文件 + 函数名 + 行号',
      hasChildPath: !!stackHasChildPath,
      hasDeepFn: !!stackHasDeepFn,
      hasLineNum: !!stackHasLineNum,
      threshold: 'all true',
      pass: stackPass,
      messagePreview: recoveredErr.message,
    });
    console.log('  message:', recoveredErr.message);
    console.log('  stack preview:');
    console.log(String(recoveredErr.stack).split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));
    console.log('  hasChildPath:', stackHasChildPath, '/ hasDeepFn:', stackHasDeepFn, '/ hasLineNum:', stackHasLineNum);
    console.log('  pass:', stackPass);
    console.log('');

    // ─────────────────────────────────────
    // 测试 4：cancel 响应延迟
    // ─────────────────────────────────────
    console.log('# 测试 4：cancel 响应延迟（5s 任务 + 1s 时 cancel）');
    const longDonePromise = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg && msg.type === 'long-done') {
          proc.off('message', onMsg);
          resolve(msg);
        }
      };
      proc.on('message', onMsg);
    });
    proc.postMessage({ type: 'start-long' });
    await new Promise((r) => setTimeout(r, 1000));
    const cancelSentAt = performance.now();
    proc.postMessage({ type: 'cancel' });
    const longDone = await longDonePromise;
    const longDoneTime = performance.now();
    const actualCancelLatency = longDoneTime - cancelSentAt;
    const cancelPass = !!longDone.cancelled && actualCancelLatency < 1000;
    results.push({
      test: 'cancel 响应延迟',
      metric: 'cancel 发出 → child long-done 间 ms',
      value: Number(actualCancelLatency.toFixed(2)),
      cancelled: longDone.cancelled,
      threshold: '< 1000ms + cancelled=true',
      pass: cancelPass,
    });
    console.log('  long-done:', longDone);
    console.log('  actual cancel latency:', actualCancelLatency.toFixed(2), 'ms');
    console.log('  pass(< 1000ms + cancelled=true):', cancelPass);
    console.log('');

    // 关闭 proc
    const exitPromise = new Promise((r) => proc.once('exit', r));
    proc.postMessage({ type: 'close' });
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1500))]);
    if (proc.pid) {
      try { proc.kill(); } catch (e) {}
    }
  } finally {
    cleanupTempDb(dbPath);
  }

  // ─────────────────────────────────────────────────────────────────
  // 输出 JSON 列表 + markdown 汇总
  // ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log('# JSON 实测结果');
  console.log(JSON.stringify(results, null, 2));
  console.log('');
  console.log('# Markdown 汇总表');
  console.log('| 项 | 指标 | 实测值 | 通过标准 | 通过 |');
  console.log('|---|---|---:|---|---|');
  for (const r of results) {
    let v = '';
    if ('value' in r) v = String(r.value);
    else if (r.hasChildPath !== undefined) v = `child=${r.hasChildPath} fn=${r.hasDeepFn} line=${r.hasLineNum}`;
    else v = '—';
    console.log(`| ${r.test} | ${r.metric} | ${v} | ${r.threshold} | ${r.pass ? '✅' : '❌'} |`);
  }
  console.log('');

  console.log('# DatabaseSync 验证（D24=a 独立 connection 方案基石）');
  console.log('  - require("node:sqlite") in utilityProcess child: passed if test 1 init-done not init-error');
  console.log('  - new DatabaseSync(dbPath) in utilityProcess child: passed if init result shows pragmaValues + selectOk=true');
  console.log('  - 6 条 PRAGMA 重设：见 init result.pragmaValues');

  const allPass = results.every((r) => r.pass);
  console.log('');
  console.log(allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');
  return allPass;
}

// Electron 主进程入口：必须 app.whenReady 后才能 utilityProcess.fork
app.on('window-all-closed', () => {
  // 不创建窗口 — 任由事件触发；最终 app.exit 由 runAllTests 后调用
});

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const ok = await runAllTests();
    exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error('main fatal:', e);
    exitCode = 1;
  } finally {
    app.exit(exitCode);
  }
});
