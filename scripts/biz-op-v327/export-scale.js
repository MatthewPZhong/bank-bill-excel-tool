'use strict';

// 只创建临时合成流水、主库和输出目录；不连接应用数据。
const fs = require('node:fs');
const path = require('node:path');
const { createExportHost, request } = require('../../tests/helpers/biz-op-v327-export');
const { writeXlsx, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');

async function main() {
  const rows = Number(process.argv[2] || 100000); const keep = process.argv.includes('--keep');
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 1048575) throw new Error('行数范围：2..1048575');
  const cleanups = []; let timer;
  const f = await createExportHost({ after(fn) { cleanups.push(fn); } }, { keep });
  try {
    const file = path.join(f.root, 'FLOW.xlsx'); const started = Date.now();
    await writeXlsx(file, { rowCount: rows, row(i) {
      const row = flowRow({ account: `000${String(i).padStart(8, '0')}`, number: '重复单号不去重', amount: '0.1234567890123456789' });
      row[27] = '2026-09-02'; row[3] = `主体😀-${i}`; return row;
    } });
    const generatedMs = Date.now() - started; const importStart = Date.now();
    const imported = await f.run([file]);
    if (imported.status !== 'ok') throw new Error(JSON.stringify(imported));
    const importMs = Date.now() - importStart;
    const id = f.db.prepare("SELECT dataset_id FROM biz_op_v327_datasets WHERE kind='FLOW'").get().dataset_id;
    let peakRss = process.memoryUsage().rss; let maxMainDelayMs = 0; let expected = Date.now() + 20;
    timer = setInterval(() => {
      maxMainDelayMs = Math.max(maxMainDelayMs, Date.now() - expected); expected = Date.now() + 20;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const exportStart = Date.now(); const result = await request(f, 'FLOW_RAW', id);
    if (result.status !== 'ok' || result.dataRowCount !== rows || result.pendingArchiveHandoff
        || f.module.catalog.task(result.taskRunId).status !== 'succeeded') throw new Error(JSON.stringify(result));
    process.stdout.write(`${JSON.stringify({ rows, generatedMs, importMs, exportMs: Date.now() - exportStart,
      outputBytes: fs.statSync(result.filePath).size, outputRows: result.dataRowCount, noteRows: result.noteRowCount,
      sheets: result.sheetCount, worker: result.metrics, sampledProcessPeakRssBytes: peakRss, maxMainDelayMs,
      nativeClosed: f.module.protection.closed(result.taskRunId), publisherClosed: f.module.publication.closed(result.taskRunId),
      leaseCount: f.runtime.resourceGovernor.snapshot().activeLeaseCount,
      root: keep ? f.root : '(removed)', outputRoot: keep ? f.outputRoot : '(removed)',
      runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, arch: process.arch } })}\n`);
  } finally { clearInterval(timer); for (const cleanup of cleanups.reverse()) await cleanup(); }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
