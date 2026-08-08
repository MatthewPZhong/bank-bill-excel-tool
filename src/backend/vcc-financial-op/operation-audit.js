'use strict';

const { getEffectiveRunResult } = require('./result-adjustments');

function collectRunEvidence(db, runId) {
  const effective = getEffectiveRunResult(db, Number(runId));
  if (!effective) throw new Error(`财务OP计算记录不存在：${runId}`);
  const pendingSummaryRows = db.prepare(`
    SELECT id, run_id, subject, channel_name, currency_mismatch,
           flow_currency, pending_currency, recon_type, flow_amount, pending_amount
    FROM vcc_fin_op_pending_summary_rows
    WHERE run_id = ?
    ORDER BY id
  `).all(Number(runId));
  const pendingCurrencyTotals = db.prepare(`
    SELECT run_id, subject, currency, amount
    FROM vcc_fin_op_pending_currency_totals
    WHERE run_id = ?
    ORDER BY subject, currency
  `).all(Number(runId));
  return {
    ...effective,
    pendingSummaryRows,
    pendingCurrencyTotals
  };
}

function insertOperationAudit(db, {
  targetMonth,
  operationType,
  runId = null,
  status,
  previewToken = null,
  evidence,
  errorMessage = null,
  appVersion = null,
  buildSha = null
}) {
  const result = db.prepare(`
    INSERT INTO vcc_fin_op_operation_audit (
      target_month, operation_type, run_id, status, preview_token,
      evidence_json, error_message, app_version, build_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    targetMonth,
    operationType,
    runId === null ? null : Number(runId),
    status,
    previewToken,
    JSON.stringify(evidence),
    errorMessage,
    appVersion,
    buildSha
  );
  return Number(result.lastInsertRowid);
}

function errorEvidence(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    code: error && error.code ? error.code : null,
    message: error && error.message ? error.message : String(error)
  };
}

function persistRolledBackAudit(db, {
  targetMonth,
  operationType,
  runId = null,
  previewToken = null,
  evidence = {},
  error,
  appVersion = null,
  buildSha = null
}) {
  try {
    return insertOperationAudit(db, {
      targetMonth,
      operationType,
      runId,
      status: 'rolled_back',
      previewToken,
      evidence: { ...evidence, failure: errorEvidence(error) },
      errorMessage: error && error.message ? error.message : String(error),
      appVersion,
      buildSha
    });
  } catch (auditError) {
    if (error && typeof error === 'object') {
      error.auditFailure = {
        name: auditError && auditError.name ? auditError.name : 'Error',
        code: auditError && auditError.code ? auditError.code : null,
        message: auditError && auditError.message ? auditError.message : String(auditError)
      };
    }
    return null;
  }
}

module.exports = {
  collectRunEvidence,
  insertOperationAudit,
  persistRolledBackAudit
};
