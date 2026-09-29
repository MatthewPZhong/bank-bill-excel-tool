'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { openVccReadDatabase } = require('../backend/vcc-financial-op/read-schema');
const { listArchiveMonthsSnapshot } = require('../backend/vcc-financial-op/read-snapshot');
const { archivedResultSnapshot, assertSameArchivedResult } = require('./vcc-financial-op-result-export-contract');
const { writeResultWorkbook } = require('./vcc-financial-op-result-workbook-writer');
const { serializeError } = require('./serialize-error');

async function run() {
  const startedAt = performance.now();
  const db = openVccReadDatabase(workerData.dbPath);
  try {
    db.exec('BEGIN DEFERRED');
    const snapshot = workerData.expectedSnapshot;
    const target = listArchiveMonthsSnapshot(db, { targetMonth: snapshot.targetMonth }).months[0];
    assertSameArchivedResult(archivedResultSnapshot(db, target), snapshot);
    const result = await writeResultWorkbook({ ...workerData, db });
    db.exec('COMMIT');
    return { ...result, resultRevision: snapshot.resultRevision,
      inputFingerprint: snapshot.inputFingerprint,
      workerMetrics: { wallMs: Math.round(performance.now() - startedAt),
        maxRssKiB: process.resourceUsage().maxRSS } };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

run().then((result) => parentPort.postMessage({ type: 'result', result }),
  (error) => parentPort.postMessage({ type: 'error', error: serializeError(error) }))
  .finally(() => parentPort.close());
