/*
 * v2.1.10 Phase 0 POC — utilityProcess 路径子进程脚本
 *
 * 由 scripts/poc/v2.1.10-a3-utility-process.js 主脚本 fork 出来
 * 通过 process.parentPort 与主进程通讯（与 worker_threads 的 parentPort 概念一致）
 */

'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');

function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null,
    code: err.code || null,
  };
}

let workerDb = null;
let cancelFlag = false;
let dbRequireOk = false;
let dbInstantiateOk = false;
let dbRequireErr = null;
let dbInstantiateErr = null;
let pragmaValues = null;

// 关键测试：utilityProcess 内 require node:sqlite + new DatabaseSync
let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
  dbRequireOk = true;
} catch (e) {
  dbRequireErr = serializeError(e);
}

function initWorkerDb(dbPath) {
  if (workerDb) return workerDb;
  if (!DatabaseSync) throw new Error('node:sqlite DatabaseSync unavailable in utilityProcess');
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
      const key = Object.keys(row)[0];
      out[name] = row[key];
    } catch (e) {
      out[name] = `<error:${e.message}>`;
    }
  }
  return out;
}

// utilityProcess 在 child 端用 process.parentPort 通讯（Electron 文档约定）
const parentPort = process.parentPort;
if (!parentPort) {
  // 不在 utilityProcess 上下文 — 直接退出
  console.error('[child] process.parentPort 不可用 — 必须由 Electron utilityProcess.fork 启动');
  process.exit(2);
}

parentPort.on('message', (rawEvent) => {
  // utilityProcess message event 形态：{ data: <payload> }（与 MessagePort 一致）
  const msg = rawEvent && rawEvent.data !== undefined ? rawEvent.data : rawEvent;
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
      function deepFn() {
        throw new Error('test stack from utilityProcess child');
      }
      try {
        deepFn();
      } catch (e) {
        parentPort.postMessage({ type: 'throw-result', error: serializeError(e) });
      }
      return;
    }

    if (msg.type === 'start-long') {
      cancelFlag = false;
      (async () => {
        const startedAt = Date.now();
        const totalMs = 5000;
        const chunkMs = 50;
        let cancelledAt = null;
        while (Date.now() - startedAt < totalMs) {
          if (cancelFlag) {
            cancelledAt = Date.now();
            break;
          }
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

// 子进程就绪后主动 ping 主进程一次（让主进程知道 child 已 spawn）— 但 init 阶段 main 也会主动发 init，所以这里不强求
