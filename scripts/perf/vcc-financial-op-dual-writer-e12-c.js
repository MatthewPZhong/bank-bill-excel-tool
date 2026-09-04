'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../src/backend/vcc-financial-op-db/migrations');
const {
  REQUIRED_DATASET_TYPES
} = require('../../src/backend/vcc-financial-op/calculator');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../src/backend/vcc-financial-op/definitions');
const {
  normalizeFilePlanV1
} = require('../../src/main-process/archive-center/file-plan');
const {
  readVccExportSnapshot
} = require('../../src/main-process/vcc-financial-op-output/authority');
const {
  createGenerationInput
} = require('../../src/main-process/vcc-financial-op-output/dispatch');
const {
  VCC_EXPORT_SUBJECTS_ACTION,
  validateVccExportSubjectsResult
} = require('../../src/main-process/vcc-financial-op-output/policies');
const {
  executeVccExportWriterGraph
} = require('../../src/main-process/vcc-financial-op-output/writer-coordinator');

const ASSETS_DIR = path.resolve(__dirname, '../../assets');

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function seedArchivedRun(db, subjectCount) {
  const targetMonth = '2026-06';
  const archivedAt = '2026-08-01 09:00:00';
  const revisions = Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]));
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, input_fingerprint,
      created_at, updated_at, archived_at
    ) VALUES (?, 'archived', ?, ?, '2026-08-01 08:00:00', ?, ?)
  `).run(targetMonth, JSON.stringify(revisions), 'a'.repeat(64), archivedAt, archivedAt).lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, 'movement', ?, 'VCC_discharge', 'B2B', 'USD', '10')
  `);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, '0')
  `);
  for (let index = 0; index < subjectCount; index += 1) {
    const subject = `SUBJECT_${String(index).padStart(3, '0')}`;
    insertRow.run(runId, subject, SOURCE_TYPES.RECHARGE);
    const balances = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      const period = currency === 'USD' ? '10' : '0';
      const closing = currency === 'USD' ? '110' : '100';
      insertBalance.run(runId, subject, currency, period, closing, closing);
      balances[currency] = closing;
    }
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (
        target_month, subject, balances_json, run_id, archived_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(targetMonth, subject, JSON.stringify(balances), runId, archivedAt);
  }
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, 1, '2026-08-01 08:00:00', ?)
  `);
  for (const type of REQUIRED_DATASET_TYPES) insertDataset.run(targetMonth, type, runId, archivedAt);
  return { runId, targetMonth };
}

async function runCase(childCount, subjectCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-c-perf-'));
  let db;
  try {
    const dbPath = path.join(root, 'tool-data.sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
    ensureVccFinancialOpTablesSupport(db);
    const run = seedArchivedRun(db, subjectCount);
    const snapshot = readVccExportSnapshot(db, run);
    const targetDirectory = path.join(root, 'targets');
    const stagingDirectory = path.join(root, 'staging');
    fs.mkdirSync(targetDirectory);
    fs.mkdirSync(stagingDirectory);
    const filePlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: Array.from({ length: subjectCount }, (_unused, index) => ({
        filePath: path.join(targetDirectory, `${index}.xlsx`),
        role: 'output',
        sourceOperation: 'vccFinancialOp:export:result'
      }))
    });
    const generation = createGenerationInput({
      actionKey: VCC_EXPORT_SUBJECTS_ACTION,
      authority: snapshot.authority,
      filePlan,
      operationKey: `vcc-e12-c-perf-${childCount}-${subjectCount}`,
      selectedSubjectIndexes: Array.from({ length: subjectCount }, (_unused, index) => index),
      stagingDirectory,
      taskAuthority: {
        action: 'export-result',
        taskGeneration: 1,
        taskRunId: `vcc-e12-c-perf-${childCount}-${subjectCount}`
      }
    });
    const input = {
      contractVersion: generation.contractVersion,
      databasePath: dbPath,
      assetsDir: ASSETS_DIR,
      authority: generation.authority,
      task: generation.task,
      generations: generation.generations,
      stagingIdentity: generation.stagingIdentity
    };
    if (typeof global.gc === 'function') global.gc();
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    const startedAt = performance.now();
    const result = await executeVccExportWriterGraph(input, null, {
      admittedTopology: {
        topologyKey: 'topology.vcc-financial-op:export-subjects',
        effectiveChildCount: childCount
      }
    });
    const durationMs = performance.now() - startedAt;
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.equal(validateVccExportSubjectsResult(result), true);
    assert.equal(result.artifacts.length, subjectCount);
    return {
      durationMs,
      rssBeforeMiB: rssBefore / 1024 ** 2,
      peakRssMiB: peakRss / 1024 ** 2,
      rssDeltaMiB: (peakRss - rssBefore) / 1024 ** 2,
      maxRssMiB: process.resourceUsage().maxRSS / 1024
    };
  } finally {
    if (db) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function childCase(childCount, subjectCount) {
  const child = spawnSync(process.execPath, [
    '--expose-gc', __filename, '--case', String(childCount), String(subjectCount)
  ], { encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024 });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function summarize(single, dual) {
  const singleMedianMs = median(single.map((item) => item.durationMs));
  const dualMedianMs = median(dual.map((item) => item.durationMs));
  return {
    single,
    dual,
    medianMs: { single: singleMedianMs, dual: dualMedianMs },
    dualImprovementPercent: ((singleMedianMs - dualMedianMs) / singleMedianMs) * 100,
    peakRssMiB: {
      single: Math.max(...single.map((item) => item.peakRssMiB)),
      dual: Math.max(...dual.map((item) => item.peakRssMiB))
    },
    peakRssDeltaMiB: {
      single: Math.max(...single.map((item) => item.rssDeltaMiB)),
      dual: Math.max(...dual.map((item) => item.rssDeltaMiB))
    }
  };
}

async function main() {
  if (process.argv[2] === '--case') {
    const result = await runCase(Number(process.argv[3]), Number(process.argv[4]));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const runs = Number(process.env.VCC_E12_C_PERF_RUNS || 5);
  const largeSubjectCount = Number(process.env.VCC_E12_C_PERF_LARGE_SUBJECTS || 16);
  const smallSubjectCount = Number(process.env.VCC_E12_C_PERF_SMALL_SUBJECTS || 4);
  assert.ok(Number.isSafeInteger(runs) && runs >= 3);
  assert.ok(Number.isSafeInteger(largeSubjectCount) && largeSubjectCount >= 4);
  assert.ok(Number.isSafeInteger(smallSubjectCount) && smallSubjectCount >= 2);
  const samples = {
    large: { single: [], dual: [] },
    small: { single: [], dual: [] }
  };
  for (let index = 0; index < runs; index += 1) {
    const order = index % 2 === 0 ? [1, 2] : [2, 1];
    for (const childCount of order) {
      samples.large[childCount === 1 ? 'single' : 'dual'].push(
        childCase(childCount, largeSubjectCount)
      );
      samples.small[childCount === 1 ? 'single' : 'dual'].push(
        childCase(childCount, smallSubjectCount)
      );
    }
  }
  const large = summarize(samples.large.single, samples.large.dual);
  const small = summarize(samples.small.single, samples.small.dual);
  const output = {
    contractVersion: 1,
    runs,
    subjectCounts: { large: largeSubjectCount, small: smallSubjectCount },
    large,
    small,
    frozenGates: {
      largeDualImprovementPercentMinimum: 15,
      smallDualRegressionPercentMaximum: 5
    },
    gateObservations: {
      largeImprovementPass: large.dualImprovementPercent >= 15,
      smallRegressionPass: small.dualImprovementPercent >= -5
    },
    conclusion: 'synthetic-child-process-benchmark-only-production-remains-disabled'
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
