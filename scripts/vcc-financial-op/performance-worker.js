'use strict';
// Validation-only wrapper: production Worker entry and algorithms remain unchanged.
const fs = require('node:fs');
const { Writable } = require('node:stream');
const { parentPort, workerData, threadId } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const settings = workerData.performanceProbe;
const started = Date.now();
let phase = 'starting', rows = 0, readRows = 0, queuePeak = 0, writerSession, output;
const stages = [], sst = [], scans = [];
const emit = (kind, data) => parentPort.postMessage({ type: 'performance-probe', kind, at: Date.now(), threadId, phase, ...data });
function queues() {
  const writer = writerSession?.writer;
  const value = (stream) => stream ? (stream.readableLength || 0) + (stream.writableLength || 0) : 0;
  const q = { sheet: [...(writer?._boundedStreams || [])].reduce((n, s) => n + value(s), 0),
    zip: value(writer?.zip), zipEngine: value(writer?.zip?._module?.engine), output: value(output) };
  q.total = Object.values(q).reduce((a, b) => a + b, 0); queuePeak = Math.max(queuePeak, q.total); return q;
}
function sample() { emit('sample', { memory: process.memoryUsage(), pid: process.pid, rows, readRows, queues: queues() }); }
const timer = setInterval(sample, 500); timer.unref(); sample();
parentPort.on('message', (message) => { if (message?.type === 'cancel') emit('cancel-received', { rows, readRows }); });
const closePort = parentPort.close.bind(parentPort);
parentPort.close = () => {
  sample(); emit('summary', { stages, sst, scans, rows, readRows, queuePeak, elapsedMs: Date.now() - started });
  clearInterval(timer); closePort();
};
function throttledOutput(name) {
  const fd = fs.openSync(name, 'wx', 0o600); let closed = false, pendingTimer, bytes = 0, paused = false;
  const close = (cb) => { if (closed) return cb(); closed = true; fs.close(fd, cb); };
  const stream = new Writable({ highWaterMark: 65536,
    write(chunk, encoding, cb) {
      let delay = Math.ceil(chunk.length * 1000 / settings.bytesPerSecond);
      if (!paused && bytes >= 65536) {
        paused = true; delay += settings.pauseMs; emit('output-paused', { bytes, rows, readRows, pauseMs: settings.pauseMs });
        if (settings.cancelOnPause) emit('cancel-point', { requestedPhase: 'writing-drain' });
      }
      pendingTimer = setTimeout(() => { pendingTimer = null; fs.write(fd, chunk, 0, chunk.length, null, (error, count) => {
        bytes += count || 0; cb(error || (count !== chunk.length ? new Error('Short performance fixture write') : null));
      }); }, delay);
    }, final(cb) { close(cb); }, destroy(error, cb) { if (pendingTimer) clearTimeout(pendingTimer); close((closeError) => cb(error || closeError)); }
  });
  stream.on('drain', () => emit('output-drain', { bytes, rows, readRows })); return stream;
}
const bounded = require('../../src/main-process/bounded-xlsx-writer');
const originalBounded = bounded.withBoundedWorkbook;
bounded.withBoundedWorkbook = (options, callback) => originalBounded({ ...options,
  createOutput: (name) => { output = settings.bytesPerSecond ? throttledOutput(name) : fs.createWriteStream(name, { flags: 'wx', mode: 0o600 }); return output; }
}, async (session) => {
  writerSession = session;
  const commit = session.commitRow.bind(session);
  session.commitRow = async (row) => { const pending = commit(row); rows += 1; queues(); await pending; queues(); };
  try { return await callback(session); } finally { queues(); }
});
const rich = require('../../src/backend/xlsx-rich-reader');
const originalOpen = rich.openRichWorkbook;
rich.openRichWorkbook = async (...args) => {
  const book = await originalOpen(...args); const record = { file: args[0], mode: book.sharedStrings.mode, count: book.sharedStrings.count };
  sst.push(record);
  return { ...book, async scanSheet(index, onRow, ...rest) {
    const scan = { file: args[0], sheetIndex: index, rows: 0 }; scans.push(scan);
    return book.scanSheet(index, (row) => { readRows += 1; scan.rows += 1; return onRow(row); }, ...rest);
  }, async close() {
    Object.assign(record, { mode: book.sharedStrings.mode, peakMemoryBytes: book.sharedStrings.peakMemoryBytes ?? null,
      peakCacheBytes: book.sharedStrings.peakCacheBytes ?? null }); await book.close();
  } };
};
function wrap(modulePath, exportName, stage) {
  const mod = require(modulePath), original = mod[exportName];
  mod[exportName] = async (options) => {
    phase = stage; const began = Date.now(); emit('stage-start', {});
    // Cancellation is sent by Main only after the real Worker entered this stage.
    if (settings.cancelPhase === stage) emit('cancel-point', { requestedPhase: stage });
    try {
      const result = await original(options);
      if (stage === 'prepare') {
        const db = new DatabaseSync(options.manifestPath, { readOnly: true });
        try { emit('manifest', { facts: db.prepare('SELECT COUNT(*) n FROM facts').get().n,
          expected: db.prepare('SELECT COUNT(*) n FROM expected').get().n,
          pages: db.prepare('SELECT p.*,g.descriptor FROM pages p JOIN groups g USING(group_key) ORDER BY p.id').all(),
          projection: JSON.parse(db.prepare("SELECT value FROM meta WHERE key='projection'").get().value).rows.map((r) => ({ kind: r.kind, rowNumber: r.rowNumber })) });
        } finally { db.close(); }
      }
      emit('stage-result', { result }); return result;
    } finally { stages.push({ stage, started: began, finished: Date.now() }); emit('stage-end', {}); }
  };
}
wrap('../../src/backend/vcc-financial-op/review-export-plan', 'prepareReviewManifest', 'prepare');
wrap('../../src/backend/vcc-financial-op/review-export-plan', 'extractReviewSources', 'extract');
wrap('../../src/main-process/vcc-financial-op-review-writer', 'writeReviewWorkbook', 'write');
wrap('../../src/main-process/vcc-financial-op-review-validator', 'validateReviewWorkbook', 'readback');
require(workerData.productionWorkerPath);
