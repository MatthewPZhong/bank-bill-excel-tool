/*
 * v2.1.10 Phase 0 POC — worker_threads 路径实测
 *
 * 实测 4 项目标（spec §2.6 + tasks T03）：
 *   1. 启动延迟（cold-start）：main perf.now() → worker init-done；10 次取均值；通过 < 200ms
 *   2. IPC 延迟：main send ping → worker reply pong；1000 次平均 round-trip；通过 < 10ms
 *   3. 错误堆栈完整度：worker throw Error → main 接收序列化错误 → 重建 err.stack 含 worker 路径 + 行号
 *   4. cancel 响应延迟：worker 执行 5s 模拟 SQL → main 1s 时发 cancel → worker exit；通过 < 1s
 *
 * 关键 DatabaseSync 验证：worker_threads 内能否 require('node:sqlite') 实例化 — D24 = (a) 独立 connection 基石
 *
 * 单文件结构（用 isMainThread 分支）— 避免新建额外 worker 脚本
 * 临时 sqlite 路径：os.tmpdir()/poc-v2.1.10.sqlite；用完清理
 *
 * 用法：node scripts/poc/v2.1.10-a3-worker-threads.js
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// ─────────────────────────────────────────────────────────────────
// 共用：serializeError / 临时 DB 创建
// ─────────────────────────────────────────────────────────────────

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
  return path.join(os.tmpdir(), 'poc-v2.1.10-worker-threads.sqlite');
}

function prepareTempDb(dbPath) {
  // 主进程创建 + 装数据，让 worker 共享读
  // 清理旧文件 + 旁文件（WAL/SHM）
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

// ─────────────────────────────────────────────────────────────────
// worker 分支：在 worker_threads 内运行
// ─────────────────────────────────────────────────────────────────

if (!isMainThread) {
  let workerDb = null;
  let cancelFlag = false;
  let dbRequireOk = false;
  let dbInstantiateOk = false;
  let dbRequireErr = null;
  let dbInstantiateErr = null;
  let pragmaValues = null;

  // 关键测试：worker_threads 内 require node:sqlite + new DatabaseSync
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
    dbRequireOk = true;
  } catch (e) {
    dbRequireErr = serializeError(e);
  }

  function initWorkerDb(dbPath) {
    if (workerDb) return workerDb;
    if (!DatabaseSync) throw new Error('node:sqlite DatabaseSync unavailable in worker_threads');
    workerDb = new DatabaseSync(dbPath);
    // 与主进程 src/backend/database.js:42 一致的 5 条 PRAGMA + busy_timeout（spec §2.5）
    workerDb.exec('PRAGMA foreign_keys = ON;');
    workerDb.exec('PRAGMA journal_mode = WAL;');
    workerDb.exec('PRAGMA synchronous = NORMAL;');
    workerDb.exec('PRAGMA cache_size = -65536;');
    workerDb.exec('PRAGMA mmap_size = 268435456;');
    workerDb.exec('PRAGMA busy_timeout = 30000;');
    return workerDb;
  }

  function readPragmas(db) {
    const items = ['foreign_keys', 'journal_mode', 'synchronous', 'cache_size', 'mmap_size', 'busy_timeout'];
    const out = {};
    for (const name of items) {
      try {
        const row = db.prepare(`PRAGMA ${name}`).get();
        // PRAGMA 返回值结构：{ <pragma_name>: value }
        const key = Object.keys(row)[0];
        out[name] = row[key];
      } catch (e) {
        out[name] = `<error:${e.message}>`;
      }
    }
    return out;
  }

  parentPort.on('message', (msg) => {
    try {
      if (msg.type === 'init') {
        if (dbRequireErr) {
          parentPort.postMessage({ type: 'init-error', error: dbRequireErr, dbRequireOk: false });
          return;
        }
        try {
          initWorkerDb(msg.dbPath);
          dbInstantiateOk = true;
          pragmaValues = readPragmas(workerDb);
        } catch (e) {
          dbInstantiateErr = serializeError(e);
          parentPort.postMessage({
            type: 'init-error',
            error: dbInstantiateErr,
            dbRequireOk,
            dbInstantiateOk: false,
          });
          return;
        }
        // 测一条 SELECT 验证 DB 实际可用
        let selectOk = false;
        let selectCount = null;
        try {
          const row = workerDb.prepare('SELECT COUNT(*) AS c FROM poc_rows').get();
          selectCount = row.c;
          selectOk = true;
        } catch (e) {
          selectOk = false;
        }
        parentPort.postMessage({
          type: 'init-done',
          dbRequireOk,
          dbInstantiateOk,
          pragmaValues,
          selectOk,
          selectCount,
        });
        return;
      }

      if (msg.type === 'ping') {
        parentPort.postMessage({ type: 'pong', n: msg.n });
        return;
      }

      if (msg.type === 'throw') {
        // 测试 3：错误堆栈
        function deepFn() {
          throw new Error('test stack from worker');
        }
        try {
          deepFn();
        } catch (e) {
          parentPort.postMessage({ type: 'throw-result', error: serializeError(e) });
        }
        return;
      }

      if (msg.type === 'start-long') {
        // 测试 4：5s 模拟 SQL + 周期检查 cancelFlag
        cancelFlag = false;
        (async () => {
          const startedAt = Date.now();
          const totalMs = 5000;
          const chunkMs = 50; // 每 50ms 检查一次 cancelFlag
          let cancelledAt = null;
          while (Date.now() - startedAt < totalMs) {
            if (cancelFlag) {
              cancelledAt = Date.now();
              break;
            }
            // 模拟一小批 SQL（不真跑 SQL 以免影响测时；这里仅 sleep 50ms）
            await new Promise((r) => setTimeout(r, chunkMs));
          }
          parentPort.postMessage({
            type: 'long-done',
            cancelled: cancelledAt !== null,
            startedAt,
            cancelledAt,
            elapsedFromStart: (cancelledAt || Date.now()) - startedAt,
          });
        })();
        return;
      }

      if (msg.type === 'cancel') {
        cancelFlag = true;
        return;
      }

      if (msg.type === 'close') {
        if (workerDb) {
          try { workerDb.close(); } catch (e) {}
        }
        process.exit(0);
      }
    } catch (e) {
      parentPort.postMessage({ type: 'handler-error', error: serializeError(e) });
    }
  });

  return;
}

// ─────────────────────────────────────────────────────────────────
// 主进程：编排 4 项测试
// ─────────────────────────────────────────────────────────────────

(async function main() {
  const dbPath = getTempDbPath();
  const results = [];

  console.log('# v2.1.10 Phase 0 POC — worker_threads 路径');
  console.log('# script:', __filename);
  console.log('# node:', process.version);
  console.log('# dbPath:', dbPath);
  console.log('');

  // 准备临时 DB
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
    let initInfo = null;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const w = new Worker(__filename, { workerData: {} });
      const initRes = await new Promise((resolve, reject) => {
        let settled = false;
        const onMsg = (msg) => {
          if (msg.type === 'init-done' || msg.type === 'init-error') {
            settled = true;
            resolve(msg);
          }
        };
        w.on('message', onMsg);
        w.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
        w.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('worker exit ' + code)); } });
        w.postMessage({ type: 'init', dbPath });
      });
      const t1 = performance.now();
      startupTimes.push(t1 - t0);
      if (i === 0) initInfo = initRes; // 第 1 次保留 init 详情
      // 清理
      w.postMessage({ type: 'close' });
      await new Promise((r) => w.on('exit', r));
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
    console.log('  init result（第 1 次）:', JSON.stringify(initInfo, null, 2));
    console.log('  startup avg:', startupAvg.toFixed(2), 'ms / min:', startupMin.toFixed(2), '/ max:', startupMax.toFixed(2));
    console.log('  pass(< 200ms):', startupPass);
    console.log('');

    // ─────────────────────────────────────
    // 测试 2：IPC 延迟（1000 次 ping/pong）
    // ─────────────────────────────────────
    console.log('# 测试 2：IPC 延迟（1000 次 round-trip）');
    const w2 = new Worker(__filename, { workerData: {} });
    await new Promise((resolve, reject) => {
      let settled = false;
      const onMsg = (msg) => {
        if (msg.type === 'init-done') { settled = true; w2.off('message', onMsg); resolve(); }
        if (msg.type === 'init-error') { settled = true; w2.off('message', onMsg); reject(deserializeError(msg.error)); }
      };
      w2.on('message', onMsg);
      w2.postMessage({ type: 'init', dbPath });
    });
    const pingTimes = [];
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await new Promise((resolve) => {
        const onMsg = (msg) => {
          if (msg.type === 'pong' && msg.n === i) {
            w2.off('message', onMsg);
            resolve();
          }
        };
        w2.on('message', onMsg);
        w2.postMessage({ type: 'ping', n: i });
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
        if (msg.type === 'throw-result') {
          w2.off('message', onMsg);
          resolve(msg);
        }
      };
      w2.on('message', onMsg);
      w2.postMessage({ type: 'throw' });
    });
    const recoveredErr = deserializeError(throwResult.error);
    const scriptBasename = path.basename(__filename);
    const stackHasWorkerPath = recoveredErr.stack && recoveredErr.stack.includes(scriptBasename);
    const stackHasDeepFn = recoveredErr.stack && recoveredErr.stack.includes('deepFn');
    const stackHasLineNum = recoveredErr.stack && /:\d+:\d+/.test(recoveredErr.stack);
    const stackPass = !!(stackHasWorkerPath && stackHasDeepFn && stackHasLineNum);
    results.push({
      test: '错误堆栈完整度',
      metric: 'stack 含 worker 文件 + 函数名 + 行号',
      hasWorkerPath: !!stackHasWorkerPath,
      hasDeepFn: !!stackHasDeepFn,
      hasLineNum: !!stackHasLineNum,
      threshold: 'all true',
      pass: stackPass,
      messagePreview: recoveredErr.message,
    });
    console.log('  message:', recoveredErr.message);
    console.log('  stack preview:');
    console.log(String(recoveredErr.stack).split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));
    console.log('  hasWorkerPath:', stackHasWorkerPath, '/ hasDeepFn:', stackHasDeepFn, '/ hasLineNum:', stackHasLineNum);
    console.log('  pass:', stackPass);
    console.log('');

    // ─────────────────────────────────────
    // 测试 4：cancel 响应延迟
    // ─────────────────────────────────────
    console.log('# 测试 4：cancel 响应延迟（5s 任务 + 1s 时 cancel）');
    const longStart = performance.now();
    let longDone = null;
    const longDonePromise = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg.type === 'long-done') {
          w2.off('message', onMsg);
          resolve(msg);
        }
      };
      w2.on('message', onMsg);
    });
    w2.postMessage({ type: 'start-long' });
    // 1s 后发 cancel
    await new Promise((r) => setTimeout(r, 1000));
    const cancelSentAt = performance.now();
    w2.postMessage({ type: 'cancel' });
    longDone = await longDonePromise;
    const cancelRespMs = longDone.cancelledAt ? (longDone.cancelledAt - (longStart + (cancelSentAt - longStart))) : null;
    // 更精确：cancelSentAt → worker 报 long-done 的时差
    const longDoneTime = performance.now();
    const actualCancelLatency = longDoneTime - cancelSentAt;
    const cancelPass = !!longDone.cancelled && actualCancelLatency < 1000;
    results.push({
      test: 'cancel 响应延迟',
      metric: 'cancel 发出 → worker long-done 间 ms',
      value: Number(actualCancelLatency.toFixed(2)),
      cancelled: longDone.cancelled,
      threshold: '< 1000ms + cancelled=true',
      pass: cancelPass,
    });
    console.log('  long-done:', longDone);
    console.log('  actual cancel latency:', actualCancelLatency.toFixed(2), 'ms');
    console.log('  pass(< 1000ms + cancelled=true):', cancelPass);
    console.log('');

    // 关闭 w2
    w2.postMessage({ type: 'close' });
    await new Promise((r) => w2.on('exit', r));
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
    else if (r.hasWorkerPath !== undefined) v = `worker=${r.hasWorkerPath} fn=${r.hasDeepFn} line=${r.hasLineNum}`;
    else v = '—';
    console.log(`| ${r.test} | ${r.metric} | ${v} | ${r.threshold} | ${r.pass ? '✅' : '❌'} |`);
  }
  console.log('');

  // DatabaseSync 验证总结（关键检查点）
  console.log('# DatabaseSync 验证（D24=a 独立 connection 方案基石）');
  console.log('  - require("node:sqlite") in worker_threads: passed if test 1 init-done not init-error');
  console.log('  - new DatabaseSync(dbPath) in worker_threads: passed if init result shows pragmaValues + selectOk=true');
  console.log('  - 6 条 PRAGMA 重设：见 init result.pragmaValues');

  const allPass = results.every((r) => r.pass);
  console.log('');
  console.log(allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('main fatal:', e);
  process.exit(1);
});
