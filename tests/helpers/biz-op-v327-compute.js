'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeXlsx, flowRow, opRow } = require('./biz-op-v327-xlsx');
const { openReadonly } = require('../../src/main-process/biz-op-v327/compute-pipeline');

async function seed(f, { end = '110', flowAmount = '10', count = 1 } = {}) {
  const s = path.join(f.root, 'start.xlsx'); const e = path.join(f.root, 'end.xlsx'); const flows = path.join(f.root, 'flows.xlsx');
  await writeXlsx(s, { kind: 'OP', rowCount: count, row: () => opRow({ amount: '0', incoming: '0', end: '100' }) });
  await writeXlsx(e, { kind: 'OP', rowCount: 1, row: () => opRow({ date: '2026-09-03', begin: end, amount: '0', incoming: '0', end }) });
  await writeXlsx(flows, { rowCount: 2, row: (i) => flowRow({ date: i ? '2026-09-03' : '2026-09-02', amount: i ? '0' : flowAmount, number: '重复单号' }) });
  const imported = await f.run([s, e, flows]); assert.equal(imported.status, 'ok', JSON.stringify(imported));
  return imported;
}
function compute(f, extra = {}) { return f.module.runCompute({ taskLifecycle: f.lifecycle, runtime: f.runtime,
  startDate: '2026-09-01', endDate: '2026-09-03', ...extra }); }
function readResult(f, runId) {
  const run = f.db.prepare('SELECT * FROM biz_op_v327_runs WHERE run_id=?').get(runId);
  const manifest = f.module.payloadStore.readDocument(run.payload_manifest_rel_path, run.payload_manifest_digest).value;
  const rows = []; const notes = [];
  for (const part of manifest.parts) {
    const db = openReadonly(f.module.payloadStore.resolve(`results/${runId}/${part.name}`));
    try {
      if (part.partKind === 'RESULT') rows.push(...db.prepare('SELECT * FROM result_rows ORDER BY row_ordinal').all());
      else notes.push(...db.prepare('SELECT * FROM explanation_records ORDER BY note_ordinal').all());
    } finally { db.close(); }
  }
  return { rows, notes, manifest, run };
}

module.exports = { seed, compute, readResult };
