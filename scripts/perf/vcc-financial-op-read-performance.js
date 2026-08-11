#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.resolve(
  __dirname,
  '../../src/main-process/vcc-financial-op-read-worker.js'
);
const QUERY_BUDGETS = Object.freeze({
  'list-archive-months': 10,
  'preview-unarchive': 13,
  'list-active-months': 1,
  'list-delete-targets': 9
});
const WORKER_WALL_BUDGETS_MS = Object.freeze({
  'list-archive-months': 500,
  'preview-unarchive': 500,
  'list-active-months': 2000,
  'list-delete-targets': 2000
});

function parseArgs(argv) {
  const options = { dbPath: '', iterations: 5, targetMonth: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--db') options.dbPath = path.resolve(argv[++index] || '');
    else if (value === '--iterations') options.iterations = Number(argv[++index]);
    else if (value === '--target-month') options.targetMonth = String(argv[++index] || '');
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.dbPath || !fs.existsSync(options.dbPath)) {
    throw new Error('请使用 --db <sqlite-path> 指定现存数据库副本。');
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 100) {
    throw new Error('--iterations 必须是 1 到 100 的整数。');
  }
  if (options.targetMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(options.targetMonth)) {
    throw new Error('--target-month 必须是 YYYY-MM。');
  }
  return options;
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function fileSize(filename) {
  try { return fs.statSync(filename).size; } catch (_error) { return 0; }
}

function runReadWorker(dbPath, action, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        action,
        payload: { ...payload, includeSqlTrace: true },
        dbPath
      }
    });
    let settled = false;
    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      if (message && message.type === 'result') resolve(message.result);
      else {
        const error = new Error(message && message.error && message.error.message || 'read worker 失败');
        error.code = message && message.error && message.error.code;
        reject(error);
      }
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`read worker exit ${code}`));
    });
  });
}

async function measureAction(dbPath, action, payload) {
  const lags = [];
  let expectedTick = performance.now() + 10;
  const interval = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expectedTick));
    expectedTick = now + 10;
  }, 10);
  const startedAt = performance.now();
  try {
    const result = await runReadWorker(dbPath, action, payload);
    return {
      result,
      mainWallMs: performance.now() - startedAt,
      maxMainLagMs: lags.length > 0 ? Math.max(...lags) : 0
    };
  } finally {
    clearInterval(interval);
  }
}

function assertStructuralBudget(action, result) {
  const metrics = result.readMetrics || {};
  if (metrics.queryCount !== QUERY_BUDGETS[action]) {
    throw new Error(`${action} SQL 数量 ${metrics.queryCount}，预期 ${QUERY_BUDGETS[action]}`);
  }
  if (['list-archive-months', 'preview-unarchive'].includes(action)) {
    const sql = (metrics.sqlTrace || []).map((entry) => entry.sql).join('\n');
    if (/vcc_fin_op_import_rows|vcc_fin_op_opening_balances/i.test(sql)) {
      throw new Error(`${action} 读取了 archive 禁表`);
    }
  }
}

function summarize(samples) {
  const remaining = samples.slice(1);
  return {
    count: samples.length,
    firstWorkerSampleMs: samples[0].result.readMetrics.workerWallMs,
    subsequentWorkerSamplesMs: remaining.length > 0 ? {
      p50: percentile(remaining.map((item) => item.result.readMetrics.workerWallMs), 0.5),
      p95: percentile(remaining.map((item) => item.result.readMetrics.workerWallMs), 0.95)
    } : null,
    workerWallMs: {
      p50: percentile(samples.map((item) => item.result.readMetrics.workerWallMs), 0.5),
      p95: percentile(samples.map((item) => item.result.readMetrics.workerWallMs), 0.95)
    },
    mainWallMs: {
      p50: percentile(samples.map((item) => item.mainWallMs), 0.5),
      p95: percentile(samples.map((item) => item.mainWallMs), 0.95)
    },
    mainLagMs: {
      p95: percentile(samples.map((item) => item.maxMainLagMs), 0.95),
      max: Math.max(...samples.map((item) => item.maxMainLagMs))
    },
    queryCounts: [...new Set(samples.map((item) => item.result.readMetrics.queryCount))]
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const walPath = `${options.dbPath}-wal`;
  const walBefore = fileSize(walPath);
  const actions = [
    { action: 'list-archive-months', payload: { taskGeneration: 0, taskActive: false } },
    { action: 'list-active-months', payload: { taskGeneration: 0, taskActive: false } }
  ];
  const discovery = {};
  const firstSamples = {};
  for (const entry of actions) {
    const sample = await measureAction(options.dbPath, entry.action, entry.payload);
    assertStructuralBudget(entry.action, sample.result);
    discovery[entry.action] = sample.result;
    firstSamples[entry.action] = sample;
  }
  const targetMonth = options.targetMonth
    || (discovery['list-archive-months'].months[0]
      && discovery['list-archive-months'].months[0].targetMonth)
    || discovery['list-active-months'].months[0]
    || '';
  if (targetMonth) {
    actions.push({
      action: 'preview-unarchive',
      payload: { targetMonth, taskGeneration: 0, taskActive: false }
    });
    actions.push({
      action: 'list-delete-targets',
      payload: { targetMonth, taskGeneration: 0, taskActive: false }
    });
  }

  const report = {};
  for (const entry of actions) {
    const samples = firstSamples[entry.action] ? [firstSamples[entry.action]] : [];
    while (samples.length < options.iterations) {
      const sample = await measureAction(options.dbPath, entry.action, entry.payload);
      assertStructuralBudget(entry.action, sample.result);
      samples.push(sample);
    }
    report[entry.action] = summarize(samples);
    if (report[entry.action].mainLagMs.max >= 100) {
      throw new Error(`${entry.action} main lag ${report[entry.action].mainLagMs.max}ms 未满足 <100ms`);
    }
    if (report[entry.action].workerWallMs.p95 > WORKER_WALL_BUDGETS_MS[entry.action]) {
      throw new Error(
        `${entry.action} worker P95 ${report[entry.action].workerWallMs.p95}ms `
        + `超过 ${WORKER_WALL_BUDGETS_MS[entry.action]}ms`
      );
    }
  }
  const walAfter = fileSize(walPath);
  if (walAfter !== walBefore) throw new Error(`只读基准产生 WAL 增量：${walBefore} → ${walAfter}`);
  process.stdout.write(`${JSON.stringify({
    dbPath: options.dbPath,
    targetMonth: targetMonth || null,
    iterations: options.iterations,
    walBytes: { before: walBefore, after: walAfter },
    report,
    qualification: '本报告仅为当前数据库/运行时观测；未指定真实约16GB Windows packaged副本时，不构成发布验收。'
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
