'use strict';

function changed() {
  return Object.assign(new Error('归档结果在导出确认后已变化，请重新选择'), { code: 'state-changed' });
}

function archivedResultSnapshot(db, target) {
  if (!target) throw changed();
  const run = db.prepare(`
    SELECT target_month, status, result_revision, input_fingerprint, archived_at
    FROM vcc_fin_op_runs WHERE id = ?
  `).get(target.runId);
  if (!run || run.status !== 'archived' || run.target_month !== target.targetMonth
      || Number(run.result_revision) !== Number(target.resultRevision)) throw changed();
  return Object.freeze({
    targetMonth: target.targetMonth,
    runId: Number(target.runId),
    subjects: Object.freeze(target.subjects.slice()),
    resultRevision: Number(run.result_revision),
    inputFingerprint: run.input_fingerprint || null,
    archivedAt: run.archived_at || null
  });
}

function assertSameArchivedResult(actual, expected) {
  for (const key of ['targetMonth', 'runId', 'resultRevision', 'inputFingerprint', 'archivedAt']) {
    if (actual[key] !== expected[key]) throw changed();
  }
  if (JSON.stringify(actual.subjects) !== JSON.stringify(expected.subjects)) throw changed();
}

module.exports = { archivedResultSnapshot, assertSameArchivedResult };
