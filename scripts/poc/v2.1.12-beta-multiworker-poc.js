/*
 * v2.1.12 β「A3-multi-worker」Phase 0 POC — 主 runner（编排 P0-1..P0-5）
 *
 * 验证核心假设（spec §5）：多 worker write-splitting 能否 ≥2x 加速 + 与单 worker byte-for-byte 一致。
 *
 * 三条路径：
 *   - baseline（单 worker）：lib.runBaselineSingleWorker — 逐 chunk INSERT...SELECT JOIN（生产 stage 4' 同 SQL）
 *   - 方案(a)：M worker 并行 SELECT chunk → 行 message 回主 → 主进程单 writer 按 chunkIndex 升序 INSERT
 *   - 方案(b)：M worker 各写自己 temp db（diff_part）→ 主进程按 chunkIndex 升序 ATTACH + INSERT...SELECT 汇总
 *
 * 🔴 byte-for-byte 不变量（资金红线）：
 *   diff_rows 物理插入顺序 = baseline 顺序 = chunk 0,1,2... 升序 + 每 chunk 内 ORDER BY b.id ASC。
 *   多 worker 路径主进程必须按 chunkIndex 升序汇总插入，chunk 内保持 worker SELECT 返回顺序。
 *
 * 用法：
 *   node scripts/poc/v2.1.12-beta-multiworker-poc.js              # 默认全套（5w + 50w）
 *   node scripts/poc/v2.1.12-beta-multiworker-poc.js --rows=50000 --quick   # 快速单档
 *   node scripts/poc/v2.1.12-beta-multiworker-poc.js --rows=500000          # 含 500w 需配大档
 */

'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const lib = require('./v2.1.12-beta-multiworker-lib.js');

const WORKER_SCRIPT = path.join(__dirname, 'v2.1.12-beta-multiworker-worker.js');
const CHUNK_SIZE = 100000; // 与生产 spec §3.2 默认一致

// ─────────────────────────────────────────────────────────────────
// worker 池辅助：启动 M worker + init（指向只读主源 dbPath）
// ─────────────────────────────────────────────────────────────────
function startWorker(dbPath) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SCRIPT);
    let settled = false;
    const onMsg = (msg) => {
      if (msg && msg.type === 'init-done') { settled = true; w.off('message', onMsg); resolve(w); }
      else if (msg && msg.type === 'init-error') { settled = true; w.off('message', onMsg); reject(new Error('worker init-error: ' + JSON.stringify(msg.error))); }
    };
    w.on('message', onMsg);
    w.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    w.on('exit', (c) => { if (!settled) { settled = true; reject(new Error('worker exit ' + c)); } });
    w.postMessage({ type: 'init', dbPath });
  });
}

async function startPool(dbPath, m) {
  const ws = [];
  for (let i = 0; i < m; i++) ws.push(await startWorker(dbPath));
  return ws;
}

async function closePool(ws) {
  await Promise.all(ws.map((w) => new Promise((resolve) => {
    w.on('exit', () => resolve());
    try { w.postMessage({ type: 'close' }); } catch (_e) { resolve(); }
  })));
}

// 把一个 worker 的下一条 chunk 任务包成 Promise（方案 a）
function dispatchSelectChunk(w, { jobId, monthKey, limit, offset }) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (!msg || msg.jobId !== jobId) return;
      if (msg.type === 'chunk-done') { w.off('message', onMsg); resolve(msg); }
      else if (msg.type === 'error') { w.off('message', onMsg); reject(new Error('worker error: ' + JSON.stringify(msg.error))); }
    };
    w.on('message', onMsg);
    w.postMessage({ type: 'select-chunk', jobId, monthKey, limit, offset });
  });
}

// 方案 b：worker 写自己的 temp db
function dispatchSelectChunkToTemp(w, { jobId, monthKey, limit, offset, tempDbPath }) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (!msg || msg.jobId !== jobId) return;
      if (msg.type === 'temp-done') { w.off('message', onMsg); resolve(msg); }
      else if (msg.type === 'error') { w.off('message', onMsg); reject(new Error('worker error: ' + JSON.stringify(msg.error))); }
    };
    w.on('message', onMsg);
    w.postMessage({ type: 'select-chunk-to-temp', jobId, monthKey, limit, offset, tempDbPath });
  });
}

// ─────────────────────────────────────────────────────────────────
// 方案(a)：M worker 并行 SELECT → 主进程单 writer 按 chunkIndex 升序 INSERT
//   chunk 分发：worker i 领 chunk i, i+M, i+2M ...（round-robin），但主进程汇总按 chunkIndex 升序
//   为保证 reader 并行：先把所有 chunk 并发派出去（每 worker 同时只跑 1 个，靠队列调度）
//   收集所有 chunk 的 rows → 按 chunkIndex 升序 → 主进程单 writer INSERT
// 返回 { runId, insertedDiffRows, totalChunks, ms, breakdown }
// ─────────────────────────────────────────────────────────────────
async function runPlanA(db, dbPath, { monthKey, m, chunkSize = CHUNK_SIZE, rssSampler = null }) {
  const totalBillRows = lib.countBillRows(db, monthKey);
  const runId = lib.insertRun(db, { monthKey, totalBillRows });
  const totalChunks = totalBillRows === 0 ? 0 : Math.ceil(totalBillRows / chunkSize);

  const tStart = performance.now();
  const ws = await startPool(dbPath, m);
  const tPoolReady = performance.now();

  // chunk 任务队列（按 chunkIndex 升序），worker 空闲就领下一个
  let nextChunk = 0;
  const chunkRows = new Array(totalChunks); // chunkRows[ci] = rows[]（保 chunkIndex 升序汇总）
  let selectMsTotal = 0;

  async function workerLoop(w) {
    while (true) {
      const ci = nextChunk++;
      if (ci >= totalChunks) break;
      if (rssSampler) rssSampler();
      const res = await dispatchSelectChunk(w, {
        jobId: `a-${ci}`, monthKey, limit: chunkSize, offset: ci * chunkSize,
      });
      chunkRows[ci] = res.rows;
      selectMsTotal += res.selectMs;
      if (rssSampler) rssSampler();
    }
  }
  await Promise.all(ws.map((w) => workerLoop(w)));
  const tSelectDone = performance.now();

  // 主进程单 writer — 按 chunkIndex 升序 INSERT（与 baseline 物理顺序一致）
  const insStmt = db.prepare(`
    INSERT INTO ${lib.DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (let ci = 0; ci < totalChunks; ci++) {
    const rows = chunkRows[ci] || [];
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        insStmt.run(runId, r.bill_import_id, r.flow_currency, r.flow_amount_abs, r.diff_type);
        inserted++;
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_e) {}
      throw e;
    }
    if (rssSampler) rssSampler();
  }
  const tInsertDone = performance.now();
  await closePool(ws);

  return {
    runId,
    insertedDiffRows: inserted,
    totalChunks,
    ms: tInsertDone - tStart,
    breakdown: {
      poolStartMs: +(tPoolReady - tStart).toFixed(1),
      parallelSelectMs: +(tSelectDone - tPoolReady).toFixed(1),
      writerInsertMs: +(tInsertDone - tSelectDone).toFixed(1),
      sumWorkerSelectMs: +selectMsTotal.toFixed(1),
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 方案(b)：M worker 各写自己 temp db（diff_part）→ 主进程按 chunkIndex 升序 ATTACH + INSERT...SELECT 汇总
//   每 chunk 一个 temp db 文件（worker 写自己的库，零跨 worker 写竞争）
//   主进程汇总：按 chunkIndex 升序逐个 ATTACH → INSERT INTO diff_rows SELECT ... FROM tmp.diff_part ORDER BY seq → DETACH
// ─────────────────────────────────────────────────────────────────
async function runPlanB(db, dbPath, tempDir, { monthKey, m, chunkSize = CHUNK_SIZE, rssSampler = null }) {
  const totalBillRows = lib.countBillRows(db, monthKey);
  const runId = lib.insertRun(db, { monthKey, totalBillRows });
  const totalChunks = totalBillRows === 0 ? 0 : Math.ceil(totalBillRows / chunkSize);

  const tStart = performance.now();
  const ws = await startPool(dbPath, m);
  const tPoolReady = performance.now();

  let nextChunk = 0;
  const tempPaths = new Array(totalChunks); // tempPaths[ci] = temp db 路径

  async function workerLoop(w) {
    while (true) {
      const ci = nextChunk++;
      if (ci >= totalChunks) break;
      if (rssSampler) rssSampler();
      const tempDbPath = path.join(tempDir, `part-${ci}.sqlite`);
      const res = await dispatchSelectChunkToTemp(w, {
        jobId: `b-${ci}`, monthKey, limit: chunkSize, offset: ci * chunkSize, tempDbPath,
      });
      tempPaths[ci] = res.tempDbPath;
      if (rssSampler) rssSampler();
    }
  }
  await Promise.all(ws.map((w) => workerLoop(w)));
  const tSelectDone = performance.now();

  // 主进程汇总：按 chunkIndex 升序 ATTACH + INSERT...SELECT（diff_part.seq ASC = worker 内 b.id ASC 顺序）
  let inserted = 0;
  for (let ci = 0; ci < totalChunks; ci++) {
    const tp = tempPaths[ci];
    if (!tp) continue;
    db.exec(`ATTACH DATABASE '${tp.replace(/'/g, "''")}' AS tmp`);
    db.exec('BEGIN');
    try {
      const r = db.prepare(`
        INSERT INTO ${lib.DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
        SELECT ?, bill_import_id, flow_currency, flow_amount_abs, diff_type
        FROM tmp.diff_part
        ORDER BY seq ASC
      `).run(runId);
      inserted += Number(r.changes);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_e) {}
      throw e;
    }
    db.exec('DETACH DATABASE tmp');
    if (rssSampler) rssSampler();
  }
  const tInsertDone = performance.now();
  await closePool(ws);

  return {
    runId,
    insertedDiffRows: inserted,
    totalChunks,
    ms: tInsertDone - tStart,
    breakdown: {
      poolStartMs: +(tPoolReady - tStart).toFixed(1),
      parallelSelectToTempMs: +(tSelectDone - tPoolReady).toFixed(1),
      attachMergeMs: +(tInsertDone - tSelectDone).toFixed(1),
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 单档完整测试：在一个临时 DB 上跑 baseline + 方案(a) M=2/4/8 + 方案(b) M=2/4/8
//   每条路径用独立 runId（同一个 DB，diff_rows 按 run_id 区分）
//   byte-for-byte：每条多 worker 路径都与 baseline 逐行 diff
// ─────────────────────────────────────────────────────────────────
async function runOneScale({ rows, monthKey = '2026-03', mList = [2, 4, 8], chunkSize = CHUNK_SIZE }) {
  const dir = lib.makeTempDir();
  const dbPath = path.join(dir, 'poc.sqlite');
  const result = { rows, chunkSize, baseline: null, planA: {}, planB: {}, byteForByte: {}, busy: {} };
  try {
    const db = lib.openDb(dbPath);
    process.stdout.write(`\n[scale ${rows} 行] 造数中 ...\n`);
    const seedT0 = Date.now();
    lib.seedData(db, { rows, monthKey });
    result.seedMs = Date.now() - seedT0;
    process.stdout.write(`[scale ${rows} 行] 造数完成（${result.seedMs}ms），bill=${lib.countBillRows(db, monthKey)}\n`);

    // ── baseline（单 worker INSERT...SELECT）──
    const base = lib.runBaselineSingleWorker(db, { monthKey, chunkSize });
    result.baseline = { ms: base.ms, insertedDiffRows: base.insertedDiffRows, totalChunks: base.totalChunks };
    const baseRows = lib.dumpDiffRowsOrdered(db, base.runId);
    const baseFp = lib.fingerprint(baseRows);
    process.stdout.write(`[baseline] ${base.ms}ms, diff=${base.insertedDiffRows}, chunks=${base.totalChunks}, fp=${baseFp.slice(0, 12)}\n`);

    // RSS 采样器
    let peakRss = process.memoryUsage().rss;
    const rssSampler = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; };

    // ── 方案(a) M=2/4/8 ──
    for (const m of mList) {
      let busyHit = false;
      let r;
      try {
        r = await runPlanA(db, dbPath, { monthKey, m, chunkSize, rssSampler });
      } catch (e) {
        if (/SQLITE_BUSY|database is locked/i.test(e.message)) { busyHit = true; }
        throw e;
      }
      const aRows = lib.dumpDiffRowsOrdered(db, r.runId);
      const cmp = lib.compareDiffRows(baseRows, aRows);
      const fpMatch = lib.fingerprint(aRows) === baseFp;
      result.planA[m] = { ms: +r.ms.toFixed(1), insertedDiffRows: r.insertedDiffRows, breakdown: r.breakdown, speedup: +(base.ms / r.ms).toFixed(2) };
      result.byteForByte[`a-m${m}`] = { equal: cmp.equal && fpMatch, countBase: cmp.countA, countMulti: cmp.countB, firstDiffAt: cmp.firstDiffAt, firstDiffDetail: cmp.firstDiffDetail };
      result.busy[`a-m${m}`] = busyHit;
      process.stdout.write(`[plan-a M=${m}] ${r.ms.toFixed(0)}ms, diff=${r.insertedDiffRows}, speedup=${(base.ms / r.ms).toFixed(2)}x, byteForByte=${cmp.equal && fpMatch}, busy=${busyHit}  | ${JSON.stringify(r.breakdown)}\n`);
    }

    // ── 方案(b) M=2/4/8 ──
    for (const m of mList) {
      const tempDir = lib.makeTempDir();
      let busyHit = false;
      let r;
      try {
        r = await runPlanB(db, dbPath, tempDir, { monthKey, m, chunkSize, rssSampler });
      } catch (e) {
        if (/SQLITE_BUSY|database is locked/i.test(e.message)) { busyHit = true; }
        lib.cleanupDir(tempDir);
        throw e;
      }
      const bRows = lib.dumpDiffRowsOrdered(db, r.runId);
      const cmp = lib.compareDiffRows(baseRows, bRows);
      const fpMatch = lib.fingerprint(bRows) === baseFp;
      result.planB[m] = { ms: +r.ms.toFixed(1), insertedDiffRows: r.insertedDiffRows, breakdown: r.breakdown, speedup: +(base.ms / r.ms).toFixed(2) };
      result.byteForByte[`b-m${m}`] = { equal: cmp.equal && fpMatch, countBase: cmp.countA, countMulti: cmp.countB, firstDiffAt: cmp.firstDiffAt, firstDiffDetail: cmp.firstDiffDetail };
      result.busy[`b-m${m}`] = busyHit;
      lib.cleanupDir(tempDir);
      process.stdout.write(`[plan-b M=${m}] ${r.ms.toFixed(0)}ms, diff=${r.insertedDiffRows}, speedup=${(base.ms / r.ms).toFixed(2)}x, byteForByte=${cmp.equal && fpMatch}, busy=${busyHit}  | ${JSON.stringify(r.breakdown)}\n`);
    }

    result.peakRssMB = +(peakRss / 1024 / 1024).toFixed(1);
    process.stdout.write(`[scale ${rows} 行] peak RSS=${result.peakRssMB}MB\n`);

    db.close();
  } finally {
    lib.cleanupDir(dir);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { rowsList: null, quick: false, mList: [2, 4, 8], chunkSize: CHUNK_SIZE };
  for (const a of args) {
    if (a.startsWith('--rows=')) out.rowsList = a.slice(7).split(',').map(Number);
    else if (a === '--quick') out.quick = true;
    else if (a.startsWith('--m=')) out.mList = a.slice(4).split(',').map(Number);
    else if (a.startsWith('--chunk=')) out.chunkSize = Number(a.slice(8));
  }
  return out;
}

(async function main() {
  const opt = parseArgs();
  const os = require('node:os');
  console.log('# v2.1.12 β「A3-multi-worker」Phase 0 POC');
  console.log('# script:', __filename);
  console.log('# node:', process.version, '| cpus:', os.cpus().length, '| totalmem GB:', (os.totalmem() / 1024 / 1024 / 1024).toFixed(1));
  console.log('# chunkSize:', opt.chunkSize, '| mList:', opt.mList.join(','));

  // 默认档：5w + 50w（500w 需 --rows=5000000 显式跑，造数慢）
  const rowsList = opt.rowsList || (opt.quick ? [50000] : [50000, 500000]);
  const results = [];
  for (const rows of rowsList) {
    const r = await runOneScale({ rows, mList: opt.mList, chunkSize: opt.chunkSize });
    results.push(r);
  }

  // ── 汇总 ──
  console.log('\n\n# ════════════ 汇总 ════════════');
  console.log('\n## P0-2 加速基线 + P0-4 方案对比（baseline = 单 worker INSERT...SELECT）');
  console.log('| 行数 | baseline ms | 方案 | M=2 | M=4 | M=8 |');
  console.log('|---:|---:|---|---:|---:|---:|');
  for (const r of results) {
    const aRow = r.mList ? '' : '';
    console.log(`| ${r.rows} | ${r.baseline.ms} | plan-a speedup | ${r.planA[2] ? r.planA[2].speedup + 'x' : '—'} | ${r.planA[4] ? r.planA[4].speedup + 'x' : '—'} | ${r.planA[8] ? r.planA[8].speedup + 'x' : '—'} |`);
    console.log(`| ${r.rows} | ${r.baseline.ms} | plan-b speedup | ${r.planB[2] ? r.planB[2].speedup + 'x' : '—'} | ${r.planB[4] ? r.planB[4].speedup + 'x' : '—'} | ${r.planB[8] ? r.planB[8].speedup + 'x' : '—'} |`);
  }

  console.log('\n## P0-3 byte-for-byte（🔴 资金红线 · 必须全 true）');
  console.log('| 行数 | a-m2 | a-m4 | a-m8 | b-m2 | b-m4 | b-m8 |');
  console.log('|---:|---|---|---|---|---|---|');
  let allByteForByte = true;
  for (const r of results) {
    const cells = ['a-m2', 'a-m4', 'a-m8', 'b-m2', 'b-m4', 'b-m8'].map((k) => {
      const v = r.byteForByte[k];
      if (!v) return '—';
      if (!v.equal) allByteForByte = false;
      return v.equal ? 'OK' : `FAIL@${v.firstDiffAt}`;
    });
    console.log(`| ${r.rows} | ${cells.join(' | ')} |`);
  }

  console.log('\n## P0-1 无 SQLITE_BUSY（必须全 false）');
  console.log('| 行数 | a-m2 | a-m4 | a-m8 | b-m2 | b-m4 | b-m8 |');
  console.log('|---:|---|---|---|---|---|---|');
  for (const r of results) {
    const cells = ['a-m2', 'a-m4', 'a-m8', 'b-m2', 'b-m4', 'b-m8'].map((k) => (r.busy[k] ? 'BUSY!' : 'no'));
    console.log(`| ${r.rows} | ${cells.join(' | ')} |`);
  }

  console.log('\n## P0-5 内存峰值');
  console.log('| 行数 | peak RSS MB |');
  console.log('|---:|---:|');
  for (const r of results) console.log(`| ${r.rows} | ${r.peakRssMB} |`);

  console.log('\n# JSON');
  console.log(JSON.stringify(results, null, 2));

  console.log(allByteForByte ? '\n🔴 byte-for-byte: ALL OK' : '\n🔴 byte-for-byte: SOME FAIL — POC NOT PASS');
})().catch((e) => {
  console.error('main fatal:', e);
  process.exit(1);
});
