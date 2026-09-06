'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createExportSpool } = require('./export-spool');
const { buildExportSource } = require('./export-source');
const { writeExportWorkbook } = require('./export-writer');
const { validateExportWorkbook } = require('./export-validator');
const { fail, hash } = require('./contracts');

async function runExportPipeline({ payloadStore, taskRunId, intentDigest, candidateRef, source,
  cancelToken = { cancelled: false }, options = {}, afterWrite }) {
  const directory = payloadStore.prepareCandidate(taskRunId, candidateRef).directory;
  const spoolPath = path.join(directory, 'export-spool.sqlite');
  const filePath = path.join(directory, 'output.xlsx');
  let ticks = 0;
  const metrics = { expectedMs: 0, writerMs: 0, actualMs: 0, peakRss: process.memoryUsage().rss };
  const safePoint = () => {
    if (cancelToken.cancelled) fail('BIZOP_CANCELLED');
    if (++ticks % 1024 === 0) {
      metrics.peakRss = Math.max(metrics.peakRss, process.memoryUsage().rss);
      const stat = fs.statfsSync(directory);
      if (stat.bavail * stat.bsize < 16 * 1024 * 1024) fail('BIZOP_OUTPUT_DISK_FULL');
    }
  };
  const spool = createExportSpool({ filename: spoolPath, source, maxRowsPerSheet: options.maxRowsPerSheet, safePoint });
  let expected; let actual;
  try {
    let started = Date.now();
    await buildExportSource({ payloadStore, source, spool, tempDirectory: directory, cancelToken, safePoint });
    expected = await spool.finish(); metrics.expectedMs = Date.now() - started;
    started = Date.now();
    Object.assign(metrics, await writeExportWorkbook({ filePath, spool, expected, safePoint }));
    metrics.writerMs = Date.now() - started;
    if (afterWrite) await afterWrite(filePath, expected);
    started = Date.now();
    actual = await validateExportWorkbook({ filePath, source, expected, tempDirectory: directory, cancelToken, safePoint });
    metrics.actualMs = Date.now() - started;
  } finally { spool.close(); }
  fs.unlinkSync(spoolPath);
  safePoint();
  const result = { schemaVersion: 1, taskRunId, intentDigest, candidateRef, sourceDigest: hash(source),
    identity: expected.identity, expectedDigest: expected.expectedDigest, ...actual, metrics };
  const document = payloadStore.writeDocument(`operations/${taskRunId}/${candidateRef}.json`, result);
  return { contractVersion: 1, candidateRef, rowCount: actual.dataRowCount, sha256: document.digest };
}
module.exports = { runExportPipeline };
