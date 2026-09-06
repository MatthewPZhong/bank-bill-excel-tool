'use strict';

// 独立临时库和合成 XLSX 的资源试验，不读取应用 userData 或用户账单。
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../../tests/helpers/biz-op-v327-host');
const { writeXlsx, flowRow, opRow } = require('../../tests/helpers/biz-op-v327-xlsx');

async function main() {
  const rows = Number(process.argv[2] || 100000);
  const kind = process.argv[3] || 'FLOW';
  const interleaved = process.argv.includes('--interleaved');
  const keep = process.argv.includes('--keep');
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1048575 || !['OP', 'FLOW'].includes(kind)) throw new Error('参数：行数 1..1048575、OP/FLOW、--interleaved、--keep');
  const cleanups = [];
  const host = await createHost({ after(work) { cleanups.push(work); } }, { keep });
  let interval;
  try {
    const file = path.join(host.root, 'synthetic.xlsx');
    const generatedAt = Date.now();
    await writeXlsx(file, { kind, rowCount: rows,
      sharedStrings: { count: rows, at: (i) => `000${i}-` + '中😀'.repeat(64) },
      row: (i) => kind === 'OP' ? opRow({ account: { t: 's', v: String(i) } })
        : flowRow({ account: { t: 's', v: String(i) }, number: '同一流水号不去重',
          date: interleaved && i % 2 ? '2026-09-03' : '2026-09-02' }) });
    let peakRss = process.memoryUsage().rss;
    let maxMainDelayMs = 0;
    let expected = Date.now() + 20;
    interval = setInterval(() => {
      maxMainDelayMs = Math.max(maxMainDelayMs, Date.now() - expected);
      expected = Date.now() + 20;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const started = Date.now();
    const result = await host.run([file]);
    if (result.status !== 'ok' || result.summary.acceptedRows !== rows) throw new Error(JSON.stringify(result));
    const op = host.module.catalog.operation(result.receipt.taskRunId);
    const intent = host.module.payloadStore.readDocument(op.intent_rel_path).value;
    const imported = host.module.payloadStore.readDocument(`operations/${op.task_run_id}/${intent.candidateRef}.json`).value;
    const report = { rows, kind, interleaved, generatedMs: started - generatedAt,
      elapsedMs: Date.now() - started, sourceBytes: fs.statSync(file).size, mainSampledPeakRss: peakRss,
      maxMainDelayMs, worker: imported.metrics, candidates: imported.references.length,
      carrierClosed: host.module.protection.closed(op.task_run_id), root: keep ? host.root : '(removed)',
      runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, arch: process.arch } };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    clearInterval(interval);
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
