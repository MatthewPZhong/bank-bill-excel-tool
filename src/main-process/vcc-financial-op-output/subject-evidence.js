'use strict';

const crypto = require('node:crypto');

const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');

function subjectDigest(subject) {
  return crypto.createHash('sha256').update(String(subject), 'utf8').digest('hex');
}

function compareVccSubjects(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function pendingSummaryProjection(rows, subject) {
  return rows.filter((row) => row.subject === subject).map((row) => ({
    channelName: row.channel_name || '',
    currencyMismatch: Boolean(row.currency_mismatch),
    flowCurrency: row.flow_currency || '',
    pendingCurrency: row.pending_currency || '',
    reconType: row.recon_type || '',
    flowAmount: String(row.flow_amount),
    pendingAmount: String(row.pending_amount)
  }));
}

function pendingTotalsProjection(rows, subject) {
  return rows.filter((row) => row.subject === subject).map((row) => ({
    currency: String(row.currency),
    amount: String(row.amount)
  }));
}

function buildVccSubjectAuthority({ data, plan, subject, subjectIndex }) {
  const canonicalPlan = canonicalJsonSnapshot(plan);
  const pendingSummary = canonicalJsonSnapshot(
    pendingSummaryProjection(data.pendingSummary, subject)
  );
  const pendingTotals = canonicalJsonSnapshot(
    pendingTotalsProjection(data.pendingTotals, subject)
  );
  return Object.freeze({
    subjectIndex,
    subjectDigest: subjectDigest(subject),
    businessDigest: canonicalSha256({ plan: canonicalPlan, pendingSummary, pendingTotals }),
    resultRowCount: canonicalPlan.rows.length + 1,
    pendingRowCount: Math.max(pendingSummary.length, pendingTotals.length, 1) + 1
  });
}

module.exports = {
  buildVccSubjectAuthority,
  compareVccSubjects,
  pendingSummaryProjection,
  pendingTotalsProjection,
  subjectDigest
};
