'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { withBoundedWorkbook } = require('../../src/main-process/bounded-xlsx-writer');
const { openRichWorkbook } = require('../../src/backend/xlsx-rich-reader');
const { SOURCE_DEFINITIONS, SOURCE_TYPES } = require('../../src/backend/vcc-financial-op/definitions');

async function measure() {
  const count = Number(process.argv[2] || 1048580);
  if (!Number.isSafeInteger(count) || count < 1 || count > 2000000) throw new Error('行数必须在 1..2000000');
  const evidenceDir = path.resolve(process.argv[3] || 'changes/v3.2.9/codex/v3.2.9-vcc-fin-op-multisheet-review-export/evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-writer-perf-'));
  const filePath = path.join(directory, 'million.xlsx');
  const headers = SOURCE_DEFINITIONS[SOURCE_TYPES.RECHARGE].headers;
  const maxData = 1048575; const counts = [];
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  try {
    const started = performance.now();
    const written = await withBoundedWorkbook({ filePath }, async (session) => {
      for (let start = 0, part = 1; start < count; start += maxData, part += 1) {
        const sheet = session.addWorksheet(`甲-USD-充值-p${part}`);
        sheet.addRow(headers); await session.commitRow(sheet.lastRow);
        const size = Math.min(maxData, count - start); counts.push(size);
        for (let index = 0; index < size; index += 1) {
          const row = sheet.addRow(Array.from({ length: 49 }, (_unused, column) => column === 0 ? `000${start + index}`
            : column === 1 ? '=1+1' : column === 2 ? '1234567890123456789.123456789' : ''));
          row.eachCell((cell) => { cell.numFmt = '@'; }); await session.commitRow(row);
          if (index % 100000 === 0) console.log(`write ${start + index}/${count}`);
        }
        await session.commitSheet(sheet);
      }
      return {};
    });
    const writeMs = performance.now() - started; const readStart = performance.now();
    const workbook = await openRichWorkbook(filePath, { memoryBudgetBytes: 64 * 1024 * 1024 });
    const actualCounts = []; let next = 0;
    try {
      for (const sheet of workbook.sheets) {
        let n = 0;
        await workbook.scanSheet(sheet.sheetIndex, (row) => {
          if (row.rowIndex === 1) return;
          assert.equal(row.cells.length, 49);
          assert.equal(row.cells[0].decodedSemanticValue, `000${next++}`);
          assert.equal(row.cells[1].decodedSemanticValue, '=1+1'); assert.equal(row.cells[1].hasFormula, false);
          assert.equal(row.cells[2].decodedSemanticValue, '1234567890123456789.123456789'); n++;
        });
        actualCounts.push(n);
      }
    } finally { await workbook.close(); }
    assert.deepEqual(actualCounts, counts); assert.equal(next, count);
    const report = { date: new Date().toISOString(), scope: 'shared-writer-and-streaming-reader-only',
      fullVccMillionRowAcceptance: 'not-run', platform: process.platform, node: process.version, dataRows: count,
      columns: 49, sheetCounts: counts, actualCounts, writeMs, readMs: performance.now() - readStart,
      peakRss, processMaxRssKiB: process.resourceUsage().maxRSS, outputBytes: fs.statSync(filePath).size, ...written };
    fs.writeFileSync(path.join(evidenceDir, `shared-writer-${count}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally { clearInterval(timer); fs.rmSync(directory, { recursive: true, force: true }); }
}
measure().catch((error) => { console.error(error); process.exitCode = 1; });
