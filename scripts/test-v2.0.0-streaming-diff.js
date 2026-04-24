#!/usr/bin/env node
/* eslint-disable no-console */
// 流式 xlsx reader 与 ExcelJS readFile 输出一致性测试
// 资金敏感：任一 cell 字符串不一致都会导致行级 hash 不同 + changed 误判
//
// 用小样本（2.8MB / 1.8万行）做 byte-level diff；不用大样本（ExcelJS 会 OOM）
//
// 运行：node scripts/test-v2.0.0-streaming-diff.js

const ExcelJS = require('exceljs');
const PENDING_COLUMNS = require('../src/backend/pending-db/columns');
const { readXlsxStreamed } = require('../src/backend/pending-import/streaming-xlsx-reader');

// 双样本：inline-string 路径（2602/_5 小）+ shared-string 路径（2603/_5 小）
const SAMPLES = [
  { label: 'inline-string (2602/_5)', path: '/Users/pzhong/Downloads/正常归档Pending账单-2602/1374968354575550468_5.xlsx' },
  { label: 'shared-string (2603/_5)', path: '/Users/pzhong/Downloads/正常归档Pending账单-2603/1387268479479711748_5.xlsx' }
];

function normalizeXlsxCell(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    if ('result' in value && value.result !== undefined) return normalizeXlsxCell(value.result);
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text || '').join('');
    }
    if ('hyperlink' in value && 'text' in value) return String(value.text || '');
  }
  return String(value);
}

async function readWithExcelJS(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const rows = [];
  const colCount = PENDING_COLUMNS.length;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      cells[c] = normalizeXlsxCell(row.getCell(c + 1).value);
    }
    rows.push(cells);
  });
  return rows;
}

async function readWithStreaming(file) {
  const rows = [];
  await readXlsxStreamed(file, (cells) => { rows.push(cells); });
  return rows;
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓', name); pass += 1; }
  else { console.log('  ✗', name, detail ? `— ${detail}` : ''); fail += 1; }
}

(async () => {
  for (const sample of SAMPLES) {
    console.log('=====================', sample.label, '=====================');
    console.log('读 ExcelJS ...');
    const t0 = Date.now();
    const rowsA = await readWithExcelJS(sample.path);
    console.log('  ExcelJS 读完', rowsA.length, '行，耗时', Date.now() - t0, 'ms');

    console.log('读 Streaming ...');
    const t1 = Date.now();
    const rowsB = await readWithStreaming(sample.path);
    console.log('  Streaming 读完', rowsB.length, '行，耗时', Date.now() - t1, 'ms');

    check(`[${sample.label}] 两种读法行数相同`, rowsA.length === rowsB.length, `A=${rowsA.length} B=${rowsB.length}`);
    if (rowsA.length !== rowsB.length) {
      console.log('  跳过 cell diff');
      continue;
    }

    let firstDiffRowIdx = -1;
    let diffCount = 0;
    for (let r = 0; r < rowsA.length; r++) {
      const aRow = rowsA[r];
      const bRow = rowsB[r];
      for (let c = 0; c < PENDING_COLUMNS.length; c++) {
        if (aRow[c] !== bRow[c]) {
          diffCount += 1;
          if (firstDiffRowIdx < 0) {
            firstDiffRowIdx = r;
            console.log(`  第一处差异: 行 ${r + 1} 列 ${PENDING_COLUMNS[c]} (idx ${c})`);
            console.log(`    ExcelJS: ${JSON.stringify(aRow[c])}`);
            console.log(`    Stream : ${JSON.stringify(bRow[c])}`);
          }
        }
      }
    }
    check(`[${sample.label}] 全部 cell 字符串一致`, diffCount === 0, `diff ${diffCount} 处`);
    console.log('');
  }

  console.log(`Total: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
