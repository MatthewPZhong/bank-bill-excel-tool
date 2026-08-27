'use strict';

const crypto = require('node:crypto');

const DUPLICATE_RESULT_DIGEST_VERSION = 1;

function parseJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    const error = new Error(`重复入金 ${label} JSON 已损坏`);
    error.code = 'duplicate-inbound-result-digest-json-invalid';
    throw error;
  }
  return parsed;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const error = new Error(`重复入金 ${label} JSON 必须是对象`);
    error.code = 'duplicate-inbound-result-digest-json-invalid';
    throw error;
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    const error = new Error(`重复入金 ${label} JSON 必须是数组`);
    error.code = 'duplicate-inbound-result-digest-json-invalid';
    throw error;
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' ||
      typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('Duplicate result digest不接受非有限数值');
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Duplicate result digest含非法JSON scalar');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Duplicate result digest只接受plain JSON');
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function addFrame(hash, label, value) {
  const labelBytes = Buffer.from(label, 'utf8');
  const valueBytes = Buffer.from(canonicalJson(value), 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(labelBytes.length, 0);
  header.writeUInt32BE(valueBytes.length, 4);
  hash.update(header);
  hash.update(labelBytes);
  hash.update(valueBytes);
}

function expectedCounts(summary) {
  return Object.freeze({
    mailRowCount: Number(summary.mailRowCount),
    manualRowCount: Number(summary.manualRowCount),
    auditGroupCount: Number(summary.auditGroupCount),
    successAuditCount: Number(summary.finalSuccessGroupCount),
    manualAuditCount: Number(summary.manualGroupCount)
  });
}

function conservationFor(summary, counts) {
  const expected = expectedCounts(summary);
  const invalidExpected = Object.values(expected).some(
    (value) => !Number.isSafeInteger(value) || value < 0
  );
  const invalidSummary = expected.mailRowCount !== expected.successAuditCount ||
    expected.auditGroupCount !== expected.successAuditCount + expected.manualAuditCount;
  const mismatchKeys = Object.keys(expected).filter((key) => expected[key] !== counts[key]);
  return Object.freeze({
    expected,
    actual: Object.freeze({ ...counts }),
    isBalanced: !invalidExpected && !invalidSummary && mismatchKeys.length === 0,
    mismatchKeys: Object.freeze(mismatchKeys)
  });
}

function assertDuplicateResultConservation(postImage) {
  if (postImage && postImage.conservation && postImage.conservation.isBalanced === true) return;
  const expected = postImage && postImage.conservation ? postImage.conservation.expected : {};
  const actual = postImage && postImage.conservation ? postImage.conservation.actual : {};
  const error = new Error(
    `重复入金运行结果行数不守恒：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  );
  error.code = 'duplicate-inbound-side-result-count-mismatch';
  throw error;
}

function computeDuplicateResultPostImage(db, runId) {
  const id = Number(runId);
  const run = db.prepare(`
    SELECT id, import_id, snapshot_json, snapshot_hash, status, summary_json
    FROM duplicate_inbound_match_runs WHERE id = ?
  `).get(id);
  if (!run) return null;
  const snapshot = requireObject(parseJson(run.snapshot_json, '运行快照'), '运行快照');
  const summary = requireObject(parseJson(run.summary_json, '运行汇总'), '运行汇总');
  const hash = crypto.createHash('sha256');
  addFrame(hash, 'contract', {
    digestVersion: DUPLICATE_RESULT_DIGEST_VERSION,
    module: 'duplicate-inbound-match'
  });
  addFrame(hash, 'run', {
    sideRunId: Number(run.id),
    importBundleId: Number(run.import_id),
    snapshot,
    snapshotHash: run.snapshot_hash,
    status: run.status,
    summary
  });

  const counts = {
    mailRowCount: 0,
    manualRowCount: 0,
    auditGroupCount: 0,
    successAuditCount: 0,
    manualAuditCount: 0
  };
  for (const row of db.prepare(`
    SELECT source_ordinal, output_json
    FROM duplicate_inbound_match_mail_rows
    WHERE run_id = ?
    ORDER BY source_ordinal ASC, id ASC
  `).iterate(id)) {
    addFrame(hash, 'mail-row', {
      sourceOrdinal: Number(row.source_ordinal),
      output: requireObject(parseJson(row.output_json, '邮件结果行'), '邮件结果行')
    });
    counts.mailRowCount += 1;
  }
  for (const row of db.prepare(`
    SELECT group_order, row_order, reason, raw_json
    FROM duplicate_inbound_match_manual_rows
    WHERE run_id = ?
    ORDER BY group_order ASC, row_order ASC, id ASC
  `).iterate(id)) {
    addFrame(hash, 'manual-row', {
      groupOrder: Number(row.group_order),
      rowOrder: Number(row.row_order),
      reason: row.reason,
      raw: requireObject(parseJson(row.raw_json, '人工结果行'), '人工结果行')
    });
    counts.manualRowCount += 1;
  }
  for (const row of db.prepare(`
    SELECT group_order, disposition, reason_codes_json, bank_lineage_json,
           mpt_lineage_json, document_lineage_json
    FROM duplicate_inbound_match_group_audits
    WHERE run_id = ?
    ORDER BY group_order ASC, id ASC
  `).iterate(id)) {
    addFrame(hash, 'audit-group', {
      groupOrder: Number(row.group_order),
      disposition: row.disposition,
      reasonCodes: requireArray(
        parseJson(row.reason_codes_json, 'audit reason codes'), 'audit reason codes'
      ),
      bankLineage: requireArray(
        parseJson(row.bank_lineage_json, 'audit bank lineage'), 'audit bank lineage'
      ),
      mptLineage: requireArray(
        parseJson(row.mpt_lineage_json, 'audit MPT lineage'), 'audit MPT lineage'
      ),
      documentLineage: requireArray(
        parseJson(row.document_lineage_json, 'audit document lineage'), 'audit document lineage'
      )
    });
    counts.auditGroupCount += 1;
    if (row.disposition === 'success') counts.successAuditCount += 1;
    if (row.disposition === 'manual') counts.manualAuditCount += 1;
  }
  const conservation = conservationFor(summary, counts);
  addFrame(hash, 'conservation', conservation);
  return Object.freeze({
    digestVersion: DUPLICATE_RESULT_DIGEST_VERSION,
    digest: hash.digest('hex'),
    counts: conservation.actual,
    conservation
  });
}

module.exports = {
  DUPLICATE_RESULT_DIGEST_VERSION,
  assertDuplicateResultConservation,
  computeDuplicateResultPostImage
};
