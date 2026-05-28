// v2.1.10 T06 worker 入口脚本 smoke 验证
//
// 跑：node scripts/poc/v2.1.10-a3-t06-worker-smoke.js
//
// 覆盖：
//   1. worker 启动 + init-done（含 6 条 PRAGMA verify）
//   2. worker run 一个最小 runCheck（导入 2 行流水 + 2 行单据 / 1 行差异）→ done 包正确
//   3. progress 事件回包数 ≥ 1（至少 5 阶段中拿到几个）
//   4. log forwarder 工作（runCheck 内若有 appendModuleLog 调用，主线程能接到 type='log'）
//   5. worker close 后 exit code = 0
//
// 不入 release-check（脚本路径在 scripts/poc/）；T11 集成测试会作正式覆盖。

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const ExcelJS = require('exceljs');

const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'src', 'main-process', 'run-check-worker.js');
const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

async function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-t06-smoke-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  // 准备 1000 行单据 + 流水（1 行币种差异）作为最小 runCheck 数据集
  const date = '2026-04-15';
  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');

  function makeFlow(id, currency) {
    const r = new Array(48).fill('');
    r[0] = date; r[6] = id; r[12] = '100'; r[13] = currency; r[28] = '100'; r[29] = currency;
    return r;
  }
  function makeBill(id, currency) {
    const r = new Array(26).fill('');
    r[0] = date; r[14] = id; r[18] = '100'; r[19] = currency;
    return r;
  }
  await writeXlsx(flowFile, FLOW_HEADERS, [makeFlow('SMOKE-1', 'USD'), makeFlow('SMOKE-2', 'USD')]);
  await writeXlsx(billFile, BILL_HEADERS, [makeBill('SMOKE-1', 'USD'), makeBill('SMOKE-2', 'EUR')]); // SMOKE-2 币种差异

  await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [billFile] });

  // 关掉主进程 DB connection（让 worker 独占 — 简化 smoke 场景；正式 IPC 会有主+worker 并发）
  db.db.close();

  return {
    tmpdir,
    dbPath,
    cleanup() {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

function dispatchWorker(worker, msg, awaitTypes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const collected = [];
    const onMsg = (m) => {
      collected.push(m);
      if (awaitTypes.includes(m.type)) {
        settled = true;
        worker.off('message', onMsg);
        worker.off('error', onErr);
        resolve({ final: m, collected });
      }
    };
    const onErr = (err) => {
      if (settled) return;
      settled = true;
      worker.off('message', onMsg);
      reject(err);
    };
    worker.on('message', onMsg);
    worker.on('error', onErr);
    worker.postMessage(msg);
  });
}

async function main() {
  console.log('==== v2.1.10 A3 T06 worker entry smoke ====');
  const ctx = await setupTmpDb();

  try {
    const w = new Worker(WORKER_SCRIPT);

    // ── 1. init ──
    const initRes = await dispatchWorker(w, { type: 'init', dbPath: ctx.dbPath }, ['init-done', 'init-error']);
    assertEq(initRes.final.type, 'init-done', '1. init 成功');
    const pragmas = initRes.final.pragmaValues || {};
    assertEq(pragmas.foreign_keys, 1, '1.1 PRAGMA foreign_keys=1');
    assertEq(String(pragmas.journal_mode).toLowerCase(), 'wal', '1.2 PRAGMA journal_mode=wal');
    assertEq(pragmas.synchronous, 1, '1.3 PRAGMA synchronous=1 (int)');
    assertEq(pragmas.cache_size, -65536, '1.4 PRAGMA cache_size=-65536');
    assertEq(pragmas.mmap_size, 268435456, '1.5 PRAGMA mmap_size=268435456');
    assertEq(pragmas.busy_timeout, 30000, '1.6 PRAGMA busy_timeout=30000');

    // ── 2. run 一次 runCheck ──
    const jobId = 'smoke-' + Date.now();
    const runRes = await dispatchWorker(w, {
      type: 'run',
      jobId,
      payload: { monthKey: '2026-04', storageRoot: ctx.tmpdir },
    }, ['done', 'error']);
    if (runRes.final.type === 'error') {
      failed++;
      failures.push({ label: '2. run done (got error)', actual: runRes.final.error, expected: 'done' });
    } else {
      assertEq(runRes.final.type, 'done', '2. run done');
      assertTrue(typeof runRes.final.result.runId === 'number', '2.1 runId 是 number');
      assertEq(runRes.final.result.totalBillRows, 2, '2.2 totalBillRows=2');
      assertEq(runRes.final.result.mismatchRows, 1, '2.3 mismatchRows=1（币种差异 SMOKE-2）');
      assertEq(runRes.final.result.matchedRows, 2, '2.4 matchedRows=2（按 reconId 配对全中）');
    }

    // ── 3. progress events ──
    const progressCount = runRes.collected.filter((m) => m.type === 'progress').length;
    assertTrue(progressCount >= 1, '3. progress 事件数 >= 1 (实际=' + progressCount + ')');

    // ── 4. log events (writer/runCheck 内可能没 log，但 message-pipe 可用即 OK；不强断言数) ──
    // log 事件可能有也可能无 — 仅验证不抛错，且 type 字段正确
    const logEvents = runRes.collected.filter((m) => m.type === 'log');
    for (const log of logEvents) {
      assertTrue(log.entry && typeof log.entry === 'object', '4. log entry 是 object');
    }

    // ── 5. close ──
    const exitPromise = new Promise((resolve) => {
      w.on('exit', (code) => resolve(code));
    });
    w.postMessage({ type: 'close' });
    const exitCode = await exitPromise;
    assertEq(exitCode, 0, '5. worker close exit code=0');

  } finally {
    ctx.cleanup();
  }

  console.log('');
  console.log('==== Smoke Result ====');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failures.length) {
    console.log('--- failures ---');
    for (const f of failures) {
      console.log(`  ✗ ${f.label}`);
      console.log(`    actual:   ${JSON.stringify(f.actual)}`);
      console.log(`    expected: ${JSON.stringify(f.expected)}`);
    }
    process.exit(1);
  }
  console.log(`${passed}/${passed + failed} PASS`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
