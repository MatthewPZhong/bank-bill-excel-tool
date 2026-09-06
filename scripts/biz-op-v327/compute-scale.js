'use strict';

// 临时主库、真实合成单页 XLSX 和原生 worker；不连接应用数据。
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../tests/helpers/biz-op-v327-host');
const { writeXlsx, opRow, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');

async function main() {
  const rows = Number(process.argv[2] || 100000); const mode = process.argv[3] || 'overlap';
  const keep = process.argv.includes('--keep');
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 1048575 || !['overlap', 'disjoint', 'skew'].includes(mode)) throw new Error('参数：每端/流水行数 2..1048575，overlap/disjoint/skew，--keep');
  const cleanups = []; let interval;
  const f = await createHost({ after(fn) { cleanups.push(fn); } }, { keep });
  try {
    const files = []; const start = Date.now();
    for (const [role, date] of [['START_OP', '2026-09-01'], ['END_OP', '2026-09-03'], ['FLOW', null]]) {
      const file = path.join(f.root, `${role}.xlsx`); files.push(file);
      await writeXlsx(file, { kind: role === 'FLOW' ? 'FLOW' : 'OP', rowCount: rows, row(i) {
        const account = mode === 'skew' ? '000001' : `${mode === 'disjoint' ? role : ''}000${String(i).padStart(8, '0')}`;
        if (role === 'FLOW') return flowRow({ date: i % 2 ? '2026-09-03' : '2026-09-02', amount: '0', account, number: '重复单号不去重' });
        const row = opRow({ date, account, begin: '9007199254740993.123456', amount: '0', incoming: '0', end: '9007199254740993.123456' });
        row[3] = `主体😀-${mode === 'skew' && role === 'END_OP' ? rows - i - 1 : i}`;
        return row;
      } });
    }
    const generatedMs = Date.now() - start; const importStart = Date.now();
    const imported = await f.run(files);
    if (imported.status !== 'ok') throw new Error(JSON.stringify(imported));
    const importMs = Date.now() - importStart;
    let peakRss = process.memoryUsage().rss; let maxMainDelayMs = 0; let expected = Date.now() + 20;
    interval = setInterval(() => {
      maxMainDelayMs = Math.max(maxMainDelayMs, Date.now() - expected); expected = Date.now() + 20;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const computeStart = Date.now();
    const result = await f.module.runCompute({ taskLifecycle: f.lifecycle, runtime: f.runtime, startDate: '2026-09-01', endDate: '2026-09-03' });
    if (result.status !== 'ok' || result.fullRowCount !== (mode === 'skew' ? 1 : mode === 'disjoint' ? rows * 3 : rows)
        || result.diffRowCount !== (mode === 'skew' ? 1 : mode === 'disjoint' ? rows * 3 : 0)) throw new Error(JSON.stringify(result));
    const run = f.db.prepare('SELECT * FROM biz_op_v327_runs WHERE run_id=?').get(result.runId);
    const manifest = f.module.payloadStore.readDocument(run.payload_manifest_rel_path, run.payload_manifest_digest).value;
    process.stdout.write(`${JSON.stringify({ rowsPerInput: rows, mode, generatedMs, importMs, computeMs: Date.now() - computeStart,
      inputRows: result.metrics.inputRows, resultRows: result.fullRowCount, differenceRows: result.diffRowCount,
      noteRows: manifest.catalog.noteRowCount, resultBytes: manifest.parts.reduce((sum, part) => sum + part.byteSize, 0),
      parts: manifest.parts.length, sampledProcessPeakRssBytes: peakRss, maxMainDelayMs, worker: result.metrics,
      carrierClosed: f.module.protection.closed(result.receipt.taskRunId), root: keep ? f.root : '(removed)',
      runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, arch: process.arch } })}\n`);
  } finally { clearInterval(interval); for (const cleanup of cleanups.reverse()) await cleanup(); }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
