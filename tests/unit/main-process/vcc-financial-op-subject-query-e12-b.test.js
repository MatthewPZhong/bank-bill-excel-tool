'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  REQUIRED_DATASET_TYPES
} = require('../../../src/backend/vcc-financial-op/calculator');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../src/backend/vcc-financial-op/definitions');
const {
  buildRunRowKey
} = require('../../../src/backend/vcc-financial-op/result-adjustments');
const {
  assertVccExportWorkerSnapshotEqual,
  readVccExportSnapshot,
  readVccExportWorkerSnapshot
} = require('../../../src/main-process/vcc-financial-op-output/authority');
const {
  buildSubjectRowPlan,
  loadEffectiveRunData,
  loadEffectiveRunDataForSubject
} = require('../../../src/main-process/vcc-financial-op-writer');
const {
  buildVccSubjectAuthority
} = require('../../../src/main-process/vcc-financial-op-output/subject-evidence');
const {
  executeVccExportWriter
} = require('../../../src/main-process/vcc-financial-op-output/writer-core');
const {
  createTaskStagingIdentity
} = require('../../../src/main-process/vcc-financial-op-output/staging-identity');
const {
  VCC_EXPORT_SINGLE_ACTION,
  validateVccExportSingleResult
} = require('../../../src/main-process/vcc-financial-op-output/policies');

const TARGET = 'AA_TARGET';
const NOISE = 'ZZ_NOISE';
const ASSETS_DIR = path.resolve(__dirname, '../../../assets');
const LEGACY_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../fixtures/vcc-financial-op/v3.1.7-four-dataset.sqlite'
);

function addRunRow(db, runId, subject, categoryMinor, amount = '1') {
  const metadata = {
    rowKind: 'movement',
    subject,
    sourceType: SOURCE_TYPES.RECHARGE,
    categoryMajor: 'VCC_discharge',
    categoryMinor
  };
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?)
  `).run(
    runId, subject, metadata.rowKind, metadata.sourceType,
    metadata.categoryMajor, metadata.categoryMinor, amount
  );
  return { ...metadata, rowKey: buildRunRowKey(metadata) };
}

function addPendingFacts(db, runId, subject) {
  db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, 'pending', ?, '当月移除pending', '', 'EUR', '3')
  `).run(runId, subject, SOURCE_TYPES.PENDING);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_summary_rows (
      run_id, subject, channel_name, currency_mismatch,
      flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    ) VALUES (?, ?, 'CITI', 1, 'USD', 'EUR', 'VCC_clearing_credit', '10', '3')
  `).run(runId, subject);
  db.prepare(`
    INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
    VALUES (?, ?, 'EUR', '3')
  `).run(runId, subject);
}

function addBalancesAndArchive(
  db,
  runId,
  targetMonth,
  archivedAt,
  subject,
  usdBasePeriod,
  usdEffectivePeriod,
  hasPending = true
) {
  const archivedBalances = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    const periodAmount = currency === 'USD'
      ? usdBasePeriod
      : (currency === 'EUR' && hasPending ? '3' : '0');
    const effectivePeriod = currency === 'USD' ? usdEffectivePeriod : periodAmount;
    const baseCalculatedBalance = String(100 + Number(periodAmount));
    const systemBalance = String(100 + Number(effectivePeriod));
    const baseDifference = String(Number(effectivePeriod) - Number(periodAmount));
    db.prepare(`
      INSERT INTO vcc_fin_op_run_balances (
        run_id, subject, currency, opening_balance, period_amount,
        calculated_balance, system_balance, difference
      ) VALUES (?, ?, ?, '100', ?, ?, ?, ?)
    `).run(
      runId, subject, currency, periodAmount,
      baseCalculatedBalance, systemBalance, baseDifference
    );
    archivedBalances[currency] = systemBalance;
  }
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (
      target_month, subject, balances_json, run_id, archived_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(targetMonth, subject, JSON.stringify(archivedBalances), runId, archivedAt);
}

function seed(noiseAdjustmentCount = 0, {
  targetHasRows = true,
  dbPath = ':memory:',
  targetSubject = TARGET,
  noiseSubject = NOISE,
  archiveArchivedAt = '2026-08-01 09:00:00'
} = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  const targetMonth = '2026-06';
  const archivedAt = '2026-08-01 09:00:00';
  const revisions = Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]));
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, result_revision,
      input_fingerprint, created_at, updated_at, archived_at
    ) VALUES (?, 'archived', ?, ?, ?, '2026-08-01 08:00:00', ?, ?)
  `).run(
    targetMonth, JSON.stringify(revisions), noiseAdjustmentCount + (targetHasRows ? 1 : 0),
    'a'.repeat(64), archivedAt, archivedAt
  ).lastInsertRowid);

  const target = targetHasRows ? addRunRow(db, runId, targetSubject, 'target') : null;
  if (targetHasRows) addPendingFacts(db, runId, targetSubject);
  const noiseRows = [];
  for (let index = 0; index < noiseAdjustmentCount; index += 1) {
    noiseRows.push(addRunRow(
      db,
      runId,
      noiseSubject,
      `noise-${String(index).padStart(6, '0')}`
    ));
  }
  addPendingFacts(db, runId, noiseSubject);

  const insertAdjustment = db.prepare(`
    INSERT INTO vcc_fin_op_run_adjustments (
      run_id, row_key, subject, source_type, category_major, category_minor,
      currency, adjustment_amount, reason, sequence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'USD', '0.5', 'E12-B fixture', ?, ?)
  `);
  let sequence = 1;
  for (const row of [...(target ? [target] : []), ...noiseRows]) {
    insertAdjustment.run(
      runId, row.rowKey, row.subject, row.sourceType,
      row.categoryMajor, row.categoryMinor, sequence, archivedAt
    );
    sequence += 1;
  }

  addBalancesAndArchive(
    db, runId, targetMonth, archiveArchivedAt, targetSubject,
    targetHasRows ? '1' : '0', targetHasRows ? '1.5' : '0', targetHasRows
  );
  addBalancesAndArchive(
    db, runId, targetMonth, archiveArchivedAt, noiseSubject,
    String(noiseAdjustmentCount),
    String(noiseAdjustmentCount * 1.5)
  );
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, 1, '2026-08-01 08:00:00', ?)
  `);
  for (const datasetType of REQUIRED_DATASET_TYPES) {
    insertDataset.run(targetMonth, datasetType, runId, archivedAt);
  }
  return { db, runId, targetMonth, targetSubject, noiseSubject };
}

function explain(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, TARGET)
    .map((row) => String(row.detail)).join('\n');
}

function median(samples) {
  const values = [...samples].sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function loadLatency(db, runId, iterations = 9) {
  loadEffectiveRunDataForSubject(db, runId, TARGET);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    loadEffectiveRunDataForSubject(db, runId, TARGET);
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

test('E12-B 三类 subject 查询都使用 (run_id,subject) range index', () => {
  const fixture = seed(1);
  try {
    assert.match(explain(fixture.db, `
      SELECT id FROM vcc_fin_op_run_rows
      WHERE run_id = ? AND subject = ? ORDER BY id
    `), /idx_vcc_fin_op_run_rows_run_subject/);
    assert.match(explain(fixture.db, `
      SELECT id FROM vcc_fin_op_run_adjustments
      WHERE run_id = ? AND subject = ? ORDER BY sequence, id
    `), /idx_vcc_fin_op_adjustments_run_subject/);
    assert.match(explain(fixture.db, `
      SELECT id FROM vcc_fin_op_pending_summary_rows
      WHERE run_id = ? AND subject = ?
      ORDER BY channel_name, currency_mismatch, flow_currency, pending_currency, recon_type
    `), /idx_vcc_fin_op_pending_summary_run_subject/);
  } finally {
    fixture.db.close();
  }
});

test('subject API 与 full E12-A 目标投影完整等价，且 readCounts 不含非目标资金事实', () => {
  const fixture = seed(37);
  try {
    const full = loadEffectiveRunData(fixture.db, fixture.runId);
    const scoped = loadEffectiveRunDataForSubject(fixture.db, fixture.runId, TARGET);
    assert.deepEqual(scoped.effective.baseRows,
      full.effective.baseRows.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.effective.adjustments,
      full.effective.adjustments.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.effective.effectiveRows,
      full.effective.effectiveRows.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.effective.balances,
      full.effective.balances.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.pendingSummary,
      full.pendingSummary.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.pendingTotals,
      full.pendingTotals.filter((row) => row.subject === TARGET));
    assert.deepEqual(scoped.readCounts, {
      baseRows: 2,
      adjustments: 1,
      effectiveRows: 2,
      balances: SUPPORTED_CURRENCIES.length,
      pendingSummary: 1,
      pendingTotals: 1
    });
    assert.doesNotMatch(JSON.stringify(scoped), new RegExp(NOISE));
  } finally {
    fixture.db.close();
  }
});

test('合法 balance-only subject 仍由局部 balances 建立主体，不触发全 run materialize', () => {
  const fixture = seed(1, { targetHasRows: false });
  try {
    const full = loadEffectiveRunData(fixture.db, fixture.runId);
    const fullAuthority = readVccExportSnapshot(fixture.db, fixture);
    assert.ok(full.subjects.includes(TARGET));
    assert.equal(full.effective.adjustments[0].sequence, 1);
    const scoped = loadEffectiveRunDataForSubject(fixture.db, fixture.runId, TARGET);
    assert.deepEqual(scoped.readCounts, {
      baseRows: 0,
      adjustments: 0,
      effectiveRows: 0,
      balances: SUPPORTED_CURRENCIES.length,
      pendingSummary: 0,
      pendingTotals: 0
    });
    assert.deepEqual(scoped.subjects, [TARGET]);
    const targetIndex = fullAuthority.data.subjects.indexOf(TARGET);
    assert.deepEqual(readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: fullAuthority.authority,
      subjectIndexes: [targetIndex]
    }).subjects, [{ subjectIndex: targetIndex, subject: TARGET }]);
  } finally {
    fixture.db.close();
  }
});

test('Worker scoped authority + subject business digest 保持 E12-A authority 且不全读 finance facts', () => {
  const fixture = seed(23);
  try {
    const full = readVccExportSnapshot(fixture.db, fixture);
    const targetIndex = full.data.subjects.indexOf(TARGET);
    const scopedAuthority = readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: full.authority,
      subjectIndexes: [targetIndex]
    });
    assert.deepEqual(scopedAuthority.subjects, [{ subjectIndex: targetIndex, subject: TARGET }]);
    const data = loadEffectiveRunDataForSubject(fixture.db, fixture.runId, TARGET);
    assert.deepEqual(buildVccSubjectAuthority({
      data,
      plan: buildSubjectRowPlan(data, TARGET),
      subject: TARGET,
      subjectIndex: targetIndex
    }), full.authority.subjects[targetIndex]);
  } finally {
    fixture.db.close();
  }
});

test('archive 时间可与 run 跨秒，subjectIndex 严格沿用 Main UTF-16 排序', () => {
  const astralSubject = '𠀀主体';
  const fullWidthSubject = 'Ａ主体';
  const fixture = seed(1, {
    targetSubject: astralSubject,
    noiseSubject: fullWidthSubject,
    archiveArchivedAt: '2026-08-01 09:00:07'
  });
  try {
    const full = readVccExportSnapshot(fixture.db, fixture);
    assert.deepEqual(full.data.subjects, [astralSubject, fullWidthSubject]);
    assert.notEqual(
      fixture.db.prepare(`
        SELECT archived_at FROM vcc_fin_op_archives WHERE target_month = ? LIMIT 1
      `).get(fixture.targetMonth).archived_at,
      full.data.run.archivedAt
    );
    const scoped = readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: full.authority,
      subjectIndexes: [0, 1]
    });
    assert.deepEqual(scoped.subjects, [
      { subjectIndex: 0, subject: astralSubject },
      { subjectIndex: 1, subject: fullWidthSubject }
    ]);
  } finally {
    fixture.db.close();
  }
});

test('bounded archive metadata 拒绝重复/错 digest，并由 scoped A/B 绑定未分配主体漂移', () => {
  const fixture = seed(1);
  try {
    const full = readVccExportSnapshot(fixture.db, fixture);
    for (const inputFingerprint of ['', 'A'.repeat(64), 'g'.repeat(64)]) {
      assert.throws(() => readVccExportWorkerSnapshot(fixture.db, {
        expectedAuthority: { ...full.authority, inputFingerprint },
        subjectIndexes: [0]
      }), /scoped authority 非法/);
    }
    const duplicateDigest = {
      ...full.authority,
      subjects: [
        full.authority.subjects[0],
        {
          ...full.authority.subjects[1],
          subjectDigest: full.authority.subjects[0].subjectDigest
        }
      ]
    };
    assert.throws(() => readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: duplicateDigest,
      subjectIndexes: [0]
    }), /archive subject/);
    const wrongDigest = {
      ...full.authority,
      subjects: full.authority.subjects.map((subject, index) => (
        index === 0 ? { ...subject, subjectDigest: 'f'.repeat(64) } : subject
      ))
    };
    assert.throws(() => readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: wrongDigest,
      subjectIndexes: [0]
    }), /archive subject/);

    const start = readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: full.authority,
      subjectIndexes: [0]
    });
    fixture.db.prepare(`
      UPDATE vcc_fin_op_archives SET archived_at = ?
      WHERE target_month = ? AND subject = ?
    `).run('2026-08-01 09:00:09', fixture.targetMonth, NOISE);
    const end = readVccExportWorkerSnapshot(fixture.db, {
      expectedAuthority: full.authority,
      subjectIndexes: [0]
    });
    assert.notEqual(start.archiveMetadataDigest, end.archiveMetadataDigest);
    assert.throws(() => assertVccExportWorkerSnapshotEqual(start, end), /scoped authority/);
  } finally {
    fixture.db.close();
  }
});

test('固定目标主体增加大量非目标 adjustments 后 read count 不变且 latency 不线性增长', () => {
  const small = seed(1);
  const large = seed(2500);
  try {
    const smallData = loadEffectiveRunDataForSubject(small.db, small.runId, TARGET);
    const largeData = loadEffectiveRunDataForSubject(large.db, large.runId, TARGET);
    assert.deepEqual(largeData.readCounts, smallData.readCounts);
    const smallMedianMs = loadLatency(small.db, small.runId);
    const largeMedianMs = loadLatency(large.db, large.runId);
    assert.ok(
      largeMedianMs < Math.max(smallMedianMs * 4, 1.5),
      `subject latency 随非目标 adjustments 异常增长：small=${smallMedianMs}ms large=${largeMedianMs}ms`
    );
  } finally {
    small.db.close();
    large.db.close();
  }
});

test('真实文件 DB 的 executeVccExportWriter 端到端走 scoped A/B 与 businessDigest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-b-writer-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const fixture = seed(31, { dbPath });
  try {
    const full = readVccExportSnapshot(fixture.db, fixture);
    const subjectIndex = full.data.subjects.indexOf(TARGET);
    fixture.db.close();
    const taskStaging = path.join(root, 'task-staging');
    fs.mkdirSync(taskStaging);
    const generationPath = path.join(taskStaging, 'target.xlsx');
    const result = await executeVccExportWriter({
      contractVersion: 1,
      databasePath: dbPath,
      assetsDir: ASSETS_DIR,
      authority: full.authority,
      task: { action: 'export-result', taskGeneration: 1, taskRunId: 'e12-b-scoped-writer' },
      stagingIdentity: createTaskStagingIdentity({
        resolvedPath: taskStaging,
        realPath: fs.realpathSync(taskStaging)
      }),
      generations: [{
        generationPath,
        outputArtifactKey: `output-${'b'.repeat(64)}`,
        subjectIndex
      }]
    }, null, VCC_EXPORT_SINGLE_ACTION);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].businessDigest,
      full.authority.subjects[subjectIndex].businessDigest);
    assert.ok(fs.statSync(generationPath).size > 0);
  } finally {
    try { fixture.db.close(); } catch (_error) { /* closed before Writer */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实 v3.1.7 four-dataset migrate 后 null fingerprint 可经 Main authority 与 Writer 出 artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-b-legacy-writer-'));
  const dbPath = path.join(root, 'legacy.sqlite');
  fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    ensureVccFinancialOpTablesSupport(db);
    const full = readVccExportSnapshot(db, { runId: 1, targetMonth: '2026-06' });
    assert.equal(full.authority.inputFingerprint, null);
    assert.equal(full.data.run.inputFingerprint, null);
    db.close();

    const taskStaging = path.join(root, 'task-staging');
    fs.mkdirSync(taskStaging);
    const generationPath = path.join(taskStaging, 'legacy.xlsx');
    const result = await executeVccExportWriter({
      contractVersion: 1,
      databasePath: dbPath,
      assetsDir: ASSETS_DIR,
      authority: full.authority,
      task: { action: 'export-result', taskGeneration: 1, taskRunId: 'e12-b-legacy-writer' },
      stagingIdentity: createTaskStagingIdentity({
        resolvedPath: taskStaging,
        realPath: fs.realpathSync(taskStaging)
      }),
      generations: [{
        generationPath,
        outputArtifactKey: `output-${'c'.repeat(64)}`,
        subjectIndex: 0
      }]
    }, null, VCC_EXPORT_SINGLE_ACTION);
    assert.equal(result.inputFingerprint, null);
    assert.equal(result.authorityDigest, full.authority.authorityDigest);
    assert.equal(validateVccExportSingleResult(result), true);
    assert.ok(fs.statSync(generationPath).size > 0);
  } finally {
    try { db.close(); } catch (_error) { /* closed before Writer */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
