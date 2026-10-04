'use strict';
// 真实导入/计算产生的合成 run，按其生效金额构造既有一致归档状态。
const { createReviewFixture } = require('./vcc-review-export');
const { getEffectiveRunResult, addRunAdjustment } = require('../../src/backend/vcc-financial-op/result-adjustments');

async function createResultExportFixture(t, options = {}) {
  const f = await createReviewFixture(t, options);
  for (const [index, subject] of f.subjects.entries()) {
    const current = getEffectiveRunResult(f.db, f.run.id);
    const row = current.baseRows.find((item) => item.subject === subject && item.sourceType === 'recharge' && item.currency === 'USD')
      || current.baseRows.find((item) => item.subject === subject && item.rowKind === 'movement');
    addRunAdjustment({ db: f.db, runId: f.run.id, rowKey: row.rowKey, currency: row.currency,
      adjustmentAmount: String(index + 1), reason: `${subject} 原因_x000D_，第${index + 1}主体`,
      expectedResultRevision: current.run.resultRevision });
  }
  const effective = getEffectiveRunResult(f.db, f.run.id);
  f.db.prepare("UPDATE vcc_fin_op_runs SET status='archived', archived_at='2026-09-29 12:00:00' WHERE id=?").run(f.run.id);
  for (const subject of f.subjects) {
    const balances = Object.fromEntries(effective.balances.filter((row) => row.subject === subject)
      .map((row) => [row.currency, row.effectiveCalculatedBalance]));
    f.db.prepare('INSERT INTO vcc_fin_op_archives(target_month,subject,balances_json,run_id,archived_at) VALUES (?,?,?,?,?)')
      .run(f.run.target_month, subject, JSON.stringify(balances), f.run.id, '2026-09-29 12:00:00');
  }
  f.db.prepare("UPDATE vcc_fin_op_datasets SET data_status='archived',archived_run_id=? WHERE target_month=?")
    .run(f.run.id, f.run.target_month);
  return { ...f, effective };
}
module.exports = { createResultExportFixture };
