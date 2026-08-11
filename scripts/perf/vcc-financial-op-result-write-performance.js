#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const READ_WORKER_PATH = path.resolve(
  __dirname,
  '../../src/main-process/vcc-financial-op-read-worker.js'
);
const WRITE_WORKER_PATH = path.resolve(
  __dirname,
  '../../src/main-process/vcc-financial-op-write-worker.js'
);
const RESULT_WRITE_SOURCE_PATH = path.resolve(
  __dirname,
  '../../src/backend/vcc-financial-op/result-write.js'
);
const SERVICE_SOURCE_PATH = path.resolve(
  __dirname,
  '../../src/main-process/vcc-financial-op-service.js'
);

function parseArgs(argv) {
  const options = { dbPath: '', runId: null, iterations: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') options.dbPath = path.resolve(argv[++index] || '');
    else if (value === '--run-id') options.runId = Number(argv[++index]);
    else if (value === '--iterations') options.iterations = Number(argv[++index]);
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.dbPath || !fs.existsSync(options.dbPath)) {
    throw new Error('请使用 --db <sqlite-path> 指定离线数据库副本。');
  }
  if (!Number.isSafeInteger(options.runId) || options.runId < 1) {
    throw new Error('--run-id 必须是 calculated run 的正安全整数。');
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 100) {
    throw new Error('--iterations 必须是 1 到 100 的整数。');
  }
  const walPath = `${options.dbPath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error('输入副本存在非空 WAL；请先离线安全 checkpoint 后再运行，禁止复制不一致快照。');
  }
  return options;
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function fileSize(filename) {
  try { return fs.statSync(filename).size; } catch (_error) { return 0; }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function assertNoLegacyFullFactFingerprintPath() {
  const resultWriteSource = fs.readFileSync(RESULT_WRITE_SOURCE_PATH, 'utf8');
  const serviceSource = fs.readFileSync(SERVICE_SOURCE_PATH, 'utf8');
  if (/snapshotResultMutationState|assertResultMutationStateUnchanged/.test(resultWriteSource)) {
    throw new Error('C1 result-write 热路径仍引用旧全事实表 fingerprint helper。');
  }
  if (/archiveRun\(|addRunAdjustmentToDb\(/.test(serviceSource)) {
    throw new Error('Service 生产入口仍存在旧同步 adjustment/archive DML 旁路。');
  }
}

function runWorker(filename, workerData, onMessage = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(filename, { workerData });
    let settled = false;
    worker.on('message', (message) => {
      if (typeof onMessage === 'function') onMessage(worker, message);
      if (!message || !['result', 'error'].includes(message.type) || settled) return;
      settled = true;
      if (message.type === 'result') resolve(message.result);
      else {
        const error = new Error(message.error && message.error.message || 'worker 失败');
        error.code = message.error && message.error.code;
        reject(error);
      }
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`worker exit ${code}`));
    });
  });
}

async function readPreview(dbPath, runId) {
  return runWorker(READ_WORKER_PATH, {
    action: 'get-run-result',
    payload: { runId, taskGeneration: 0, taskActive: false },
    dbPath
  });
}

async function measureArchive(dbPath, runId) {
  const preview = await readPreview(dbPath, runId);
  if (!preview.effective || preview.effective.run.status !== 'calculated') {
    throw new Error(`run ${runId} 不是 calculated 状态。`);
  }
  const phases = [];
  const lags = [];
  let expectedTick = performance.now() + 10;
  const interval = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expectedTick));
    expectedTick = now + 10;
  }, 10);
  const startedAt = performance.now();
  const walBefore = fileSize(`${dbPath}-wal`);
  try {
    const result = await runWorker(WRITE_WORKER_PATH, {
      action: 'archive-result',
      payload: {
        runId,
        expectedResultRevision: preview.effective.run.resultRevision,
        expectedPreviewToken: preview.previewTokens.archive,
        taskGeneration: 0,
        appVersion: 'performance-probe',
        buildSha: 'performance-probe',
        batchContext: null
      },
      dbPath
    }, (worker, message) => {
      if (message && message.type === 'critical-ready') {
        worker.postMessage({ type: 'critical-ack' });
      } else if (message && message.type === 'progress' && message.progress) {
        phases.push(String(message.progress.phase || ''));
      }
    });
    if (!result || result.status !== 'archived') throw new Error('archive worker 未返回 archived。');
    for (const phase of ['validating', 'applying', 'verifying']) {
      if (!phases.includes(phase)) throw new Error(`archive worker 缺少 ${phase} progress。`);
    }
    return {
      workerWallMs: performance.now() - startedAt,
      maxMainLagMs: lags.length > 0 ? Math.max(...lags) : 0,
      walBytes: { before: walBefore, after: fileSize(`${dbPath}-wal`) },
      phases
    };
  } finally {
    clearInterval(interval);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertNoLegacyFullFactFingerprintPath();
  const sourceHashBefore = sha256File(options.dbPath);
  const samples = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-result-write-perf-'));
    const sampleDbPath = path.join(tempRoot, 'tool-data.sqlite');
    fs.copyFileSync(options.dbPath, sampleDbPath);
    try {
      samples.push(await measureArchive(sampleDbPath, options.runId));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  const report = {
    workerWallMs: {
      p50: percentile(samples.map((sample) => sample.workerWallMs), 0.5),
      p95: percentile(samples.map((sample) => sample.workerWallMs), 0.95)
    },
    mainLagMs: {
      p95: percentile(samples.map((sample) => sample.maxMainLagMs), 0.95),
      max: Math.max(...samples.map((sample) => sample.maxMainLagMs))
    },
    walBytes: samples.map((sample) => sample.walBytes),
    progressPhases: [...new Set(samples.flatMap((sample) => sample.phases))]
  };
  if (report.workerWallMs.p95 > 2000) {
    throw new Error(`archive worker P95 ${report.workerWallMs.p95.toFixed(3)}ms 超过 2000ms。`);
  }
  if (report.mainLagMs.p95 >= 100) {
    throw new Error(`archive main event-loop lag P95 ${report.mainLagMs.p95.toFixed(3)}ms 未满足 <100ms。`);
  }
  if (sha256File(options.dbPath) !== sourceHashBefore) {
    throw new Error('性能脚本修改了输入数据库副本。');
  }
  process.stdout.write(`${JSON.stringify({
    dbPath: options.dbPath,
    runId: options.runId,
    iterations: options.iterations,
    sourceUnchanged: true,
    fullFactFingerprintHotPath: false,
    report,
    qualification: '当前结果仅为所给离线副本/运行时观测；非约16GB Windows installer/portable副本时，不构成发布验收。'
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
