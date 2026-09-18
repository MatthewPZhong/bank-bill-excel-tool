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
let sourceRows = 0, sourceNextCalls = 0, sourceCursors = 0, pendingCommits = 0, maxPendingCommits = 0;
let currentCommit, resumeCandidate, outputPaused = false, sourceRowsAtCancel = null;
const flow = { nextWhileCommitPending: 0, blockedWaits: 0, resumed: 0, cursorReturns: 0 };
function flowSnapshot() { return { ...flow, sourceRows, sourceNextCalls, sourceCursors, pendingCommits, maxPendingCommits, sourceRowsAtCancel }; }
function observeDrainWait() {
  const active = currentCommit;
  if (!outputPaused || !active || active.done || !active.actualDrainWait || !active.stream.writableNeedDrain
      || !active.waitRefs.some((ref) => active.stream.rawListeners('drain').includes(ref))) return;
  if (!active.blockedAt) { active.blockedAt = Date.now(); active.blockedSourceRows = sourceRows; return; }
  if (active.proven || Date.now() - active.blockedAt < 100) return;
  active.proven = true; flow.blockedWaits++;
  emit('sheet-drain-blocked', { since: active.blockedAt, sourceRowsStart: active.blockedSourceRows, sourceRowsEnd: sourceRows,
    pendingCommits, writableNeedDrain: active.stream.writableNeedDrain, originalDrainListeners: active.waitRefs.length,
    sheet: active.sheet, row: active.row, outputPaused });
  if (settings.cancelOnDrain) emit('cancel-point', { requestedPhase: 'writing-real-drain', sourceRows });
}
const flowTimer = setInterval(observeDrainWait, 20); flowTimer.unref();
const nativeDbClose = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function () {
  const files = this.prepare('PRAGMA database_list').all().map((item) => item.file);
  const result = nativeDbClose.call(this); emit('database-closed', { files }); return result;
};
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
parentPort.on('message', (message) => { if (message?.type === 'cancel') { sourceRowsAtCancel = sourceRows; emit('cancel-received', { rows, readRows, sourceRows }); } });
const closePort = parentPort.close.bind(parentPort);
parentPort.close = () => {
  sample(); emit('summary', { stages, sst, scans, rows, readRows, queuePeak, flow: flowSnapshot(), elapsedMs: Date.now() - started });
  clearInterval(timer); clearInterval(flowTimer); closePort();
};
function throttledOutput(name) {
  const fd = fs.openSync(name, 'wx', 0o600); let closed = false, pendingTimer, bytes = 0, paused = false;
  const close = (cb) => { if (closed) return cb(); closed = true; fs.close(fd, cb); };
  const stream = new Writable({ highWaterMark: 65536,
    write(chunk, encoding, cb) {
      let delay = Math.ceil(chunk.length * 1000 / settings.bytesPerSecond);
      if (!paused && bytes >= 65536) {
        paused = true; outputPaused = true; delay += settings.pauseMs; emit('output-paused', { bytes, rows, readRows, pauseMs: settings.pauseMs });
      }
      pendingTimer = setTimeout(() => { pendingTimer = null;
        if (outputPaused) {
          outputPaused = false;
          if (currentCommit?.proven && !currentCommit.done && currentCommit.stream.writableNeedDrain) {
            currentCommit.outputResumedAt = Date.now();
            emit('output-resumed-during-sheet-drain', { sourceRows, sheet: currentCommit.sheet, row: currentCommit.row });
          }
          emit('output-resumed', { sourceRows, rows, readRows });
        }
        fs.write(fd, chunk, 0, chunk.length, null, (error, count) => {
        bytes += count || 0; cb(error || (count !== chunk.length ? new Error('Short performance fixture write') : null));
      }); }, delay);
    }, final(cb) { close(cb); }, destroy(error, cb) { if (pendingTimer) clearTimeout(pendingTimer); close((closeError) => cb(error || closeError)); }
  });
  stream.on('drain', () => emit('output-drain', { bytes, rows, readRows }));
  stream.once('close', () => emit('output-closed', { outputPaused, sourceRows })); return stream;
}
const bounded = require('../../src/main-process/bounded-xlsx-writer');
const originalBounded = bounded.withBoundedWorkbook;
bounded.withBoundedWorkbook = (options, callback) => originalBounded({ ...options,
  createOutput: (name) => { output = settings.bytesPerSecond ? throttledOutput(name) : fs.createWriteStream(name, { flags: 'wx', mode: 0o600 }); return output; }
}, async (session) => {
  writerSession = session;
  const commit = session.commitRow.bind(session);
  session.commitRow = async (row) => {
    const stream = row.worksheet.stream, priorRefs = stream.rawListeners('drain'), priorWaits = session.metrics.drainWaits;
    const active = { stream, sheet: row.worksheet.name, row: row.number, done: false };
    pendingCommits++; maxPendingCommits = Math.max(maxPendingCommits, pendingCommits);
    let drainObserver;
    try {
      const pending = commit(row); rows++; queues();
      active.actualDrainWait = session.metrics.drainWaits > priorWaits;
      active.waitRefs = stream.rawListeners('drain').filter((ref) => !priorRefs.includes(ref));
      currentCommit = active;
      if (active.actualDrainWait) {
        drainObserver = () => { active.drainedAt = Date.now(); };
        stream.once('drain', drainObserver);
      }
      await pending; queues();
      if (active.proven && active.outputResumedAt && active.drainedAt >= active.outputResumedAt) resumeCandidate = active;
    } finally {
      active.done = true; pendingCommits--;
      if (drainObserver) stream.off('drain', drainObserver);
      if (active.proven) emit('sheet-drain-settled', { sheet: active.sheet, row: active.row,
        sourceRowsStart: active.blockedSourceRows, sourceRowsEnd: sourceRows,
        outputResumedAt: active.outputResumedAt ?? null, drainedAt: active.drainedAt ?? null,
        aborted: !!options.signal?.aborted, originalDrainListenersRemoved: active.waitRefs.every((ref) => !stream.rawListeners('drain').includes(ref)) });
      if (currentCommit === active) currentCommit = null;
    }
  };
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
const plan = require('../../src/backend/vcc-financial-op/review-export-plan');
const originalPageRows = plan.pageRows;
plan.pageRows = (db, page) => {
  const iterator = originalPageRows(db, page);
  if (phase !== 'write') return iterator;
  sourceCursors++; let closed = false;
  const finish = (reason) => { if (!closed) { closed = true; sourceCursors--; emit('source-cursor-closed', { reason, sourceRows, pageId: page.id }); } };
  return {
    [Symbol.iterator]() { return this; },
    next(...args) {
      sourceNextCalls++;
      if (pendingCommits) flow.nextWhileCommitPending++;
      const next = iterator.next(...args);
      if (next.done) finish('exhausted');
      else {
        sourceRows++;
        if (resumeCandidate) { flow.resumed++; emit('source-resumed', { sourceRows, priorSourceRows: resumeCandidate.blockedSourceRows,
          outputResumedAt: resumeCandidate.outputResumedAt, drainedAt: resumeCandidate.drainedAt }); resumeCandidate = null; }
      }
      return next;
    },
    return(...args) { try { return iterator.return(...args); } finally { flow.cursorReturns++; finish('return'); } },
    throw(...args) { try { return iterator.throw(...args); } finally { finish('throw'); } }
  };
};
wrap('../../src/backend/vcc-financial-op/review-export-plan', 'prepareReviewManifest', 'prepare');
wrap('../../src/backend/vcc-financial-op/review-export-plan', 'extractReviewSources', 'extract');
wrap('../../src/main-process/vcc-financial-op-review-writer', 'writeReviewWorkbook', 'write');
wrap('../../src/main-process/vcc-financial-op-review-validator', 'validateReviewWorkbook', 'readback');
require(workerData.productionWorkerPath);
