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
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../src/backend/vcc-financial-op/definitions');
const {
  buildRunRowKey
} = require('../../src/backend/vcc-financial-op/result-adjustments');
const {
  loadEffectiveRunDataForSubject
} = require('../../src/main-process/vcc-financial-op-writer');

const TARGET = 'AA_TARGET';
const NOISE = 'ZZ_NOISE';

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function seedDatabase(dbPath, noiseCount) {
  const db = new DatabaseSync(dbPath);
  ensureVccFinancialOpTablesSupport(db);
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision, input_fingerprint
    ) VALUES ('2026-06', 'archived', '{}', ?, ?)
  `).run(noiseCount + 1, 'a'.repeat(64)).lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, 'movement', ?, 'VCC_discharge', ?, 'USD', '1')
  `);
  const insertAdjustment = db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence
    ) VALUES (?, ?, ?, ?, 'VCC_discharge', ?, 'USD', '0.5', 'E12-B benchmark', ?)
  `);
  let sequence = 1;
  const addRow = (subject, categoryMinor) => {
    insertRow.run(runId, subject, SOURCE_TYPES.RECHARGE, categoryMinor);
    const rowKey = buildRunRowKey({
      rowKind: 'movement', subject, sourceType: SOURCE_TYPES.RECHARGE,
      categoryMajor: 'VCC_discharge', categoryMinor
    });
    insertAdjustment.run(
      runId, rowKey, subject, SOURCE_TYPES.RECHARGE, categoryMinor, sequence
    );
    sequence += 1;
  };
  db.exec('BEGIN');
  addRow(TARGET, 'target');
  for (let index = 0; index < noiseCount; index += 1) {
    addRow(NOISE, `noise-${String(index).padStart(7, '0')}`);
  }
  db.exec('COMMIT');

  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, ?)
  `);
  for (const [subject, count] of [[TARGET, 1], [NOISE, noiseCount]]) {
    for (const currency of SUPPORTED_CURRENCIES) {
      const basePeriod = currency === 'USD' ? count : 0;
      const effectivePeriod = currency === 'USD' ? count * 1.5 : 0;
      insertBalance.run(
        runId, subject, currency, String(basePeriod), String(100 + basePeriod),
        String(100 + effectivePeriod), String(effectivePeriod - basePeriod)
      );
    }
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, ?, 'CITI', 1, 'USD', 'EUR', 'VCC_clearing_credit', '10', '3')
  `).run(runId, TARGET);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, ?, 'EUR', '3')
  `).run(runId, TARGET);
  db.close();
  return runId;
}

function readCase(dbPath, runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  if (typeof global.gc === 'function') global.gc();
  const rssBefore = process.memoryUsage().rss;
  const samples = [];
  let result;
  for (let index = 0; index < 31; index += 1) {
    const startedAt = performance.now();
    result = loadEffectiveRunDataForSubject(db, runId, TARGET);
    samples.push(performance.now() - startedAt);
  }
  if (typeof global.gc === 'function') global.gc();
  const rssAfter = process.memoryUsage().rss;
  const output = {
    readCounts: result.readCounts,
    medianMs: median(samples.slice(1)),
    rssBeforeMiB: rssBefore / 1024 ** 2,
    rssAfterMiB: rssAfter / 1024 ** 2,
    rssDeltaMiB: (rssAfter - rssBefore) / 1024 ** 2,
    maxRssMiB: process.resourceUsage().maxRSS / 1024
  };
  db.close();
  return output;
}

function childCase(dbPath, runId) {
  const child = spawnSync(process.execPath, [
    '--expose-gc', __filename, '--read-case', dbPath, String(runId)
  ], { encoding: 'utf8', env: process.env });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function queryPlan(db, table, orderBy) {
  return db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM ${table}
    WHERE run_id = ? AND subject = ? ${orderBy}
  `).all(1, TARGET).map((row) => String(row.detail));
}

function adjustmentReadSteps(dbPath) {
  const sqliteCli = process.env.SQLITE3_CLI || 'sqlite3';
  const result = spawnSync(sqliteCli, [
    dbPath,
    '.stats stmt',
    `SELECT id, run_id, row_key, subject, sequence
     FROM vcc_fin_op_run_adjustments
     WHERE run_id = 1 AND subject = '${TARGET}'
     ORDER BY sequence, id;`
  ], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') {
    return { available: false, reason: 'sqlite3-cli-unavailable' };
  }
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`;
  const vmSteps = [...output.matchAll(/Virtual Machine Steps:\s+(\d+)/g)];
  const fullscanSteps = [...output.matchAll(/Fullscan Steps:\s+(\d+)/g)];
  if (vmSteps.length < 1 || fullscanSteps.length < 1) {
    throw new Error('sqlite3 statement step evidence 缺失');
  }
  return {
    available: true,
    virtualMachineSteps: Number(vmSteps.at(-1)[1]),
    fullscanSteps: Number(fullscanSteps.at(-1)[1])
  };
}

function main() {
  if (process.argv[2] === '--read-case') {
    process.stdout.write(JSON.stringify(readCase(process.argv[3], Number(process.argv[4]))));
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-b-benchmark-'));
  try {
    const smallPath = path.join(root, 'small.sqlite');
    const largePath = path.join(root, 'large.sqlite');
    const smallRunId = seedDatabase(smallPath, 1);
    const largeRunId = seedDatabase(largePath, 20000);
    const small = childCase(smallPath, smallRunId);
    const large = childCase(largePath, largeRunId);
    const readSteps = {
      small: adjustmentReadSteps(smallPath),
      large: adjustmentReadSteps(largePath)
    };
    const db = new DatabaseSync(largePath, { readOnly: true });
    const plans = {
      rows: queryPlan(db, 'vcc_fin_op_run_rows', 'ORDER BY id'),
      adjustments: queryPlan(db, 'vcc_fin_op_run_adjustments', 'ORDER BY sequence, id'),
      pendingSummary: queryPlan(
        db, 'vcc_fin_op_pending_summary_rows',
        'ORDER BY channel_name, currency_mismatch, flow_currency, pending_currency, recon_type'
      )
    };
    db.close();
    assert.deepEqual(large.readCounts, small.readCounts);
    assert.match(plans.rows.join('\n'), /idx_vcc_fin_op_run_rows_run_subject/);
    assert.match(plans.adjustments.join('\n'), /idx_vcc_fin_op_adjustments_run_subject/);
    assert.match(plans.pendingSummary.join('\n'), /idx_vcc_fin_op_pending_summary_run_subject/);
    const latencyUpperMs = Math.max(small.medianMs * 3, 1);
    assert.ok(large.medianMs <= latencyUpperMs,
      `large subject latency ${large.medianMs}ms > gate ${latencyUpperMs}ms`);
    assert.ok(Math.abs(small.rssDeltaMiB) <= 8 && Math.abs(large.rssDeltaMiB) <= 8,
      'subject read RSS delta 超过 8 MiB');
    assert.ok(small.maxRssMiB <= 160 && large.maxRssMiB <= 160,
      'subject read maxRSS 超过 160 MiB');
    assert.ok(Math.abs(large.maxRssMiB - small.maxRssMiB) <= 8,
      '20k 非目标 adjustments 使 maxRSS 增长超过 8 MiB');
    if (readSteps.small.available && readSteps.large.available) {
      assert.equal(readSteps.small.fullscanSteps, 0);
      assert.equal(readSteps.large.fullscanSteps, 0);
      assert.equal(readSteps.large.virtualMachineSteps, readSteps.small.virtualMachineSteps);
    }
    process.stdout.write(`${JSON.stringify({
      contractVersion: 1,
      targetSubject: TARGET,
      nonTargetAdjustmentCounts: { small: 1, large: 20000 },
      small,
      large,
      ratios: {
        materializedAdjustmentRows: large.readCounts.adjustments / small.readCounts.adjustments,
        medianLatency: large.medianMs / small.medianMs
      },
      gates: {
        latencyUpperMs,
        rssDeltaAbsoluteMaxMiB: 8,
        maxRssMiB: 160,
        maxRssGrowthMiB: 8
      },
      adjustmentReadSteps: readSteps,
      queryPlans: plans,
      conclusion: 'subject-indexed-read-scale-independent-of-non-target-adjustments'
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
