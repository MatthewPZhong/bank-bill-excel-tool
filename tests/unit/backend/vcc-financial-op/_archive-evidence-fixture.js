'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureVccFinancialOpTablesSupport
} = require('../../../../src/backend/vcc-financial-op-db/migrations');
const {
  buildArchiveEvidenceV2
} = require('../../../../src/backend/vcc-financial-op/archive-evidence');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  buildRunRowKey
} = require('../../../../src/backend/vcc-financial-op/result-adjustments');

const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'vcc-financial-op'
);
const LEGACY_FIXTURE_PATH = path.join(FIXTURE_DIR, 'v3.1.7-four-dataset.sqlite');
const LEGACY_MANIFEST_PATH = path.join(FIXTURE_DIR, 'v3.1.7-four-dataset.manifest.json');
const GENERATOR_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'generate-vcc-financial-op-v3.1.7-fixture.js'
);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixedBalances(value = '100') {
  return Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, value]));
}

function createCurrentRawEvidence() {
  const runId = 7;
  const targetMonth = '2026-07';
  const metadata = {
    rowKind: 'movement',
    subject: 'PPHK',
    sourceType: SOURCE_TYPES.RECHARGE,
    categoryMajor: '充值',
    categoryMinor: 'OPS'
  };
  const rowKey = buildRunRowKey(metadata);
  const datasetTypes = [
    SOURCE_TYPES.RECHARGE,
    SOURCE_TYPES.FEE_FX,
    SOURCE_TYPES.CHANNEL,
    SOURCE_TYPES.PENDING,
    SOURCE_TYPES.SYSTEM_OP
  ];
  const storedRunBalances = SUPPORTED_CURRENCIES.map((currency) => {
    const periodAmount = currency === 'USD' ? '10' : '0';
    const calculatedBalance = currency === 'USD' ? '110' : '100';
    return {
      runId,
      subject: 'PPHK',
      currency,
      openingBalance: '100',
      periodAmount,
      calculatedBalance,
      systemBalance: calculatedBalance,
      difference: '0'
    };
  });
  const archiveBalances = fixedBalances('100');
  archiveBalances.USD = '110';
  archiveBalances.EUR = '105';
  return {
    targetMonth,
    runs: [{
      id: runId,
      targetMonth,
      status: 'archived',
      resultRevision: 1,
      inputFingerprint: 'a'.repeat(64),
      inputRevisions: Object.fromEntries(datasetTypes.map((type) => [type, 1])),
      inputRevisionsParseError: false,
      createdAt: '2026-08-01 10:00:00',
      updatedAt: '2026-08-01 10:05:00',
      archivedAt: '2026-08-01 10:05:00'
    }],
    datasets: datasetTypes.map((datasetType) => ({
      datasetType,
      dataStatus: 'archived',
      revision: 1,
      archivedRunId: runId,
      generatedAt: '2026-08-01 09:00:00',
      updatedAt: '2026-08-01 10:05:00'
    })),
    archives: [{
      subject: 'PPHK',
      runId,
      archivedAt: '2026-08-01 10:05:00',
      balances: archiveBalances,
      balancesParseError: false,
      balancesHash: sha256(JSON.stringify(archiveBalances))
    }],
    runRows: [{
      id: 11,
      runId,
      ...metadata,
      currency: 'USD',
      amount: '10'
    }],
    runAdjustments: [{
      id: 21,
      runId,
      rowKey,
      subject: metadata.subject,
      sourceType: metadata.sourceType,
      categoryMajor: metadata.categoryMajor,
      categoryMinor: metadata.categoryMinor,
      currency: 'EUR',
      adjustmentAmount: '5',
      reason: '月末财务复核调整',
      sequence: 1,
      createdAt: '2026-08-01 10:03:00',
      createdAppVersion: '3.1.8',
      createdBuildSha: 'fixture-build'
    }],
    storedRunBalances,
    pendingEffectiveFactCount: 0,
    pendingRunRowCount: 0,
    pendingSummaryCount: 0,
    pendingCurrencyTotalCount: 0
  };
}

function parsedRevisions(value) {
  try {
    const parsed = JSON.parse(value);
    return {
      inputRevisions: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null,
      inputRevisionsParseError: !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    };
  } catch (_error) {
    return { inputRevisions: null, inputRevisionsParseError: true };
  }
}

function parseArchiveBalances(value) {
  try {
    const parsed = JSON.parse(value);
    return {
      balances: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null,
      balancesParseError: !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    };
  } catch (_error) {
    return { balances: null, balancesParseError: true };
  }
}

function readLegacyRawEvidence(db) {
  const targetMonth = '2026-06';
  const runs = db.prepare(`
    SELECT id, target_month, status, result_revision, input_fingerprint,
           input_revisions_json, created_at, updated_at, archived_at
    FROM vcc_fin_op_runs
    WHERE target_month = ?
    ORDER BY id
  `).all(targetMonth).map((run) => ({
    id: Number(run.id),
    targetMonth: run.target_month,
    status: run.status,
    resultRevision: Number(run.result_revision),
    inputFingerprint: run.input_fingerprint,
    ...parsedRevisions(run.input_revisions_json),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    archivedAt: run.archived_at
  }));
  const runIds = runs.map((run) => run.id);
  const archives = db.prepare(`
    SELECT subject, run_id, archived_at, balances_json
    FROM vcc_fin_op_archives
    WHERE target_month = ?
    ORDER BY subject
  `).all(targetMonth).map((archive) => ({
    subject: archive.subject,
    runId: Number(archive.run_id),
    archivedAt: archive.archived_at,
    ...parseArchiveBalances(archive.balances_json),
    balancesHash: sha256(archive.balances_json)
  }));
  const runRows = runIds.length === 0 ? [] : db.prepare(`
    SELECT id, run_id, subject, row_kind, source_type,
           category_major, category_minor, currency, amount
    FROM vcc_fin_op_run_rows
    WHERE run_id = ?
    ORDER BY id
  `).all(runIds[0]).map((row) => ({
    id: Number(row.id),
    runId: Number(row.run_id),
    subject: String(row.subject),
    rowKind: String(row.row_kind),
    sourceType: String(row.source_type),
    categoryMajor: String(row.category_major || ''),
    categoryMinor: String(row.category_minor || ''),
    currency: String(row.currency),
    amount: String(row.amount)
  }));
  const runAdjustments = runIds.length === 0 ? [] : db.prepare(`
    SELECT id, run_id, row_key, subject, source_type, category_major,
           category_minor, currency, adjustment_amount, reason, sequence,
           created_at, created_app_version, created_build_sha
    FROM vcc_fin_op_run_adjustments
    WHERE run_id = ?
    ORDER BY sequence, id
  `).all(runIds[0]).map((row) => ({
    id: Number(row.id),
    runId: Number(row.run_id),
    rowKey: String(row.row_key),
    subject: String(row.subject),
    sourceType: String(row.source_type),
    categoryMajor: String(row.category_major),
    categoryMinor: String(row.category_minor || ''),
    currency: String(row.currency),
    adjustmentAmount: String(row.adjustment_amount),
    reason: String(row.reason),
    sequence: Number(row.sequence),
    createdAt: row.created_at,
    createdAppVersion: row.created_app_version,
    createdBuildSha: row.created_build_sha
  }));
  const storedRunBalances = runIds.length === 0 ? [] : db.prepare(`
    SELECT run_id, subject, currency, opening_balance, period_amount,
           calculated_balance, system_balance, difference
    FROM vcc_fin_op_run_balances
    WHERE run_id = ?
    ORDER BY subject, currency
  `).all(runIds[0]).map((row) => ({
    runId: Number(row.run_id),
    subject: String(row.subject),
    currency: String(row.currency),
    openingBalance: String(row.opening_balance),
    periodAmount: String(row.period_amount),
    calculatedBalance: String(row.calculated_balance),
    systemBalance: String(row.system_balance),
    difference: String(row.difference)
  }));
  const scalarCount = (sql, ...params) => Number(db.prepare(sql).get(...params).count) || 0;
  const runId = runIds[0] || -1;
  return {
    targetMonth,
    runs,
    datasets: db.prepare(`
      SELECT dataset_type, data_status, revision, archived_run_id,
             generated_at, updated_at
      FROM vcc_fin_op_datasets
      WHERE target_month = ?
      ORDER BY dataset_type
    `).all(targetMonth).map((dataset) => ({
      datasetType: String(dataset.dataset_type),
      dataStatus: String(dataset.data_status),
      revision: Number(dataset.revision),
      archivedRunId: dataset.archived_run_id == null ? null : Number(dataset.archived_run_id),
      generatedAt: dataset.generated_at,
      updatedAt: dataset.updated_at
    })),
    archives,
    runRows,
    runAdjustments,
    storedRunBalances,
    pendingEffectiveFactCount: scalarCount(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_effective_rows
      WHERE target_month = ? AND source_type = 'pending_archive_removal'
    `, targetMonth),
    pendingRunRowCount: scalarCount(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_run_rows
      WHERE run_id = ? AND (row_kind = 'pending' OR source_type = 'pending_archive_removal')
    `, runId),
    pendingSummaryCount: scalarCount(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_pending_summary_rows WHERE run_id = ?
    `, runId),
    pendingCurrencyTotalCount: scalarCount(`
      SELECT COUNT(*) AS count FROM vcc_fin_op_pending_currency_totals WHERE run_id = ?
    `, runId)
  };
}

function loadLegacyRawEvidence({ pendingResidual = false } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-legacy-fixture-test-'));
  const dbPath = path.join(tempRoot, 'legacy.sqlite');
  fs.copyFileSync(LEGACY_FIXTURE_PATH, dbPath);
  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    ensureVccFinancialOpTablesSupport(db);
    if (pendingResidual) {
      db.prepare(`
        UPDATE vcc_fin_op_effective_rows
        SET source_type = 'pending_archive_removal'
        WHERE id = (SELECT MIN(id) FROM vcc_fin_op_effective_rows)
      `).run();
    }
    db.close();
    db = new DatabaseSync(dbPath, { readOnly: true });
    return readLegacyRawEvidence(db);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function loadLegacyEvidence(options) {
  return buildArchiveEvidenceV2(loadLegacyRawEvidence(options));
}

function readLegacyManifest() {
  return JSON.parse(fs.readFileSync(LEGACY_MANIFEST_PATH, 'utf8'));
}

function legacyFixtureSha256() {
  return sha256(fs.readFileSync(LEGACY_FIXTURE_PATH));
}

function currentGeneratorSha256() {
  // manifest 记录 Git/LF 规范内容；Windows autocrlf checkout 不能改变 provenance。
  const canonicalText = fs.readFileSync(GENERATOR_PATH, 'utf8').replace(/\r\n/g, '\n');
  return sha256(Buffer.from(canonicalText, 'utf8'));
}

module.exports = {
  LEGACY_FIXTURE_PATH,
  createCurrentRawEvidence,
  currentGeneratorSha256,
  loadLegacyRawEvidence,
  loadLegacyEvidence,
  readLegacyManifest,
  legacyFixtureSha256
};
