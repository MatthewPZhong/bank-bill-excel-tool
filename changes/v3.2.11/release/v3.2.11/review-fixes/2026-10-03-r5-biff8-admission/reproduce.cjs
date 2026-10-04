'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../../../..');
const req = createRequire(path.join(root, 'package.json'));
const XLSX = req('xlsx');
const { withRowsCsv } = req('./tests/helpers/toolbox-rows-csv');
const results = [];
const createSource = (file) => {
  const book = XLSX.utils.book_new();
  const data = [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']];
  for (let n = 0; n < 20000; n++) data.push([1, 2, 3, 4, 5, 6, 7, 8]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '数据');
  XLSX.writeFile(book, file, { bookType: 'biff8' });
};
(async () => {
  for (const availableMiB of [512, 2048]) {
    await withRowsCsv({ createSource, availableMiB }, async (h) => {
      const started = Date.now(), sourceHash = h.hash(h.source);
      const result = await h.scan();
      if (result.sourceFilePath) result.sourceFilePath = path.basename(result.sourceFilePath);
      if (result.splitReadToken) result.splitReadToken = '[runtime token omitted]';
      results.push({ availableMiB, sizeBytes: fs.statSync(h.source).size, sourceSha256: sourceHash,
        result, workerLimits: h.workerLimits, elapsedMs: Date.now() - started,
        sourceUnchanged: sourceHash === h.hash(h.source), workersClosed: h.workers.every((worker) => worker.threadId === -1) });
    });
  }
  const output = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    platform: process.platform, arch: process.arch, node: process.version,
    fixture: '生产策略、Main handler、Governor、真实 Node Worker；Windows/Electron 身份及可用内存注入', results };
  fs.writeFileSync(path.join(__dirname, process.argv[2] || 'probe-result.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
