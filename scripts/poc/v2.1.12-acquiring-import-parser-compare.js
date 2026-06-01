// v2.1.12-beta POC(收单导入提速) —— 解析器 make-or-break 对比：sax 库 vs 手写字节扫描
//
// 背景：clean-timing 实测 50万行导入 122s，insert-bench 实测 insert+raw_json 仅 7.25s(~6%)
//   → 瓶颈 = 解析 ~94%(~115s)。收单现状解析器用 `sax` 库（reader.js），pending/VCC 用手写
//   字节扫描器（streaming-xlsx-reader.js readXlsxStreamed）。本 POC 在同一真实 fixture 上比纯解析耗时，
//   确认换解析器能砍掉那 94% 的多少、值不值得做。
//
// 三档（都是 100% 真实 prod 代码，不 replicate，避免上次 profile-run 的测量 bug）：
//   A   = reader.importFlowFile（真实 sax：yauzl+sax+streamSheetRows），monkeypatch insert→no-op，
//         纯解析 + per-row extractMonthKey（剥掉 insert/rawjson）
//   B   = readXlsxStreamed（手写扫描，colCount=48），纯解析（count-only）
//   Bmk = B + per-row extractMonthKey（与 A 公平 apples-to-apples）
//   equal = 正确性闸：抓两条路径前 N 行 cells 逐格比对，证手写扫描 byte-level 等于 sax（不算错账）
//
// 用法：node scripts/poc/v2.1.12-acquiring-import-parser-compare.js <fixture> <A|B|Bmk|equal> [equalRows=3000]
'use strict';
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const fixture = process.argv[2];
const mode = process.argv[3];
if (!fixture || !fs.existsSync(fixture) || !mode) {
  console.error('用法：node v2.1.12-acquiring-import-parser-compare.js <fixture> <A|B|Bmk|equal> [equalRows]');
  process.exit(1);
}
const sizeMB = (fs.statSync(fixture).size / 1024 / 1024).toFixed(1);

// ---- 峰值 RSS 采样（解析是流式 async，event loop 频繁让出 → 50ms 采样可捕获峰值）----
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  const r = process.memoryUsage().rss;
  if (r > peakRss) peakRss = r;
}, 50);

function emit(label, ms, rows) {
  clearInterval(sampler);
  const peakMB = (peakRss / 1024 / 1024).toFixed(0);
  console.log(`[${label}] fixture=${sizeMB}MB  耗时=${(ms / 1000).toFixed(2)}s  行数=${rows}  吞吐=${Math.round(rows / (ms / 1000))}行/秒  峰值RSS=${peakMB}MB`);
  console.log(`RESULT|${label}|ms=${ms.toFixed(1)}|rows=${rows}|peakRssMB=${peakMB}|sizeMB=${sizeMB}`);
}

// =================== A：真实 prod sax 解析（monkeypatch 掉 insert）===================
async function runA() {
  const importRepo = require('../../src/backend/acquiring-bill-currency-db/import-repository');
  const reader = require('../../src/backend/acquiring-bill-currency-import/reader');
  // stub：prepareFlowInsert 返回假 stmt（无需 DB），insertFlowRow no-op（跳过 raw_json stringify + SQL）
  importRepo.prepareFlowInsert = () => ({ run: () => {} });
  importRepo.insertFlowRow = () => {};

  const t0 = performance.now();
  const r = await reader.importFlowFile({
    db: {}, filePath: fixture, importedAt: '2026-03-01T00:00:00Z',
    expectedMonthKey: '2026-03', onProgress: () => {}
  });
  const ms = performance.now() - t0;
  emit('A-sax真实prod解析', ms, r.importedCount);
}

// =================== B / Bmk：手写字节扫描 ===================
async function runB(withMonthKey) {
  const { readXlsxStreamed } = require('../../src/backend/pending-import/streaming-xlsx-reader');
  const { FLOW_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../../src/backend/acquiring-bill-currency-db/columns');
  const { extractMonthKey } = require('../../src/backend/acquiring-bill-currency-import/validator');
  const billCol = FLOW_KEY_COLUMN_INDICES.billDate;

  let count = 0;
  const t0 = performance.now();
  const r = await readXlsxStreamed(fixture, (cells, idx) => {
    if (withMonthKey) {
      if (idx === 1) return;              // 表头行
      const mk = extractMonthKey(cells[billCol]);
      if (mk) count += 1;
    }
  }, { colCount: FLOW_HEADERS.length });
  const ms = performance.now() - t0;
  emit(withMonthKey ? 'Bmk-手写扫描+monthKey' : 'B-手写扫描纯解析', ms, withMonthKey ? count : r.rowCount);
}

// =================== 共享 helper：yauzl（流式解压）+ 手写扫描，逐行回调 ===================
// 收单 reader 本就用 yauzl 解压（无 JSZip 的大 entry 上限 + 低内存 + ZIP64/data descriptor），
// 仅把 sax 换成手写 indexOf+parseRowXml 扫描。这是 B（JSZip 在 1M 崩）的修正架构。
// onRow(cells, idx)：idx 从 1 起（含表头）。
async function yauzlHandRolledScan(filePath, colCount, onRow) {
  const yauzl = require('yauzl');
  const { StringDecoder } = require('node:string_decoder');
  const { parseRowXml } = require('../../src/backend/pending-import/streaming-xlsx-reader');
  const sharedStrings = [];   // 本 fixture 全 inlineStr 无 sharedStrings；真实如有需先用 yauzl 读 sst（同 sax reader）

  await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      let sheetEntry = null;
      zip.on('entry', (e) => { if (e.fileName === 'xl/worksheets/sheet1.xml') sheetEntry = e; });
      zip.on('error', reject);
      zip.on('end', () => {
        if (!sheetEntry) return reject(new Error('no sheet1.xml'));
        zip.openReadStream(sheetEntry, (e2, stream) => {
          if (e2) return reject(e2);
          const decoder = new StringDecoder('utf8');
          let pending = '';
          let inSheetData = false;
          let rowIdx = 0;
          const drain = () => {
            while (true) {
              if (!inSheetData) {
                const sd = pending.indexOf('<sheetData>');
                if (sd < 0) {
                  const sc = pending.indexOf('<sheetData/>');
                  if (sc >= 0) { inSheetData = true; pending = pending.slice(sc + 12); return; }
                  if (pending.length > 16) pending = pending.slice(-16);
                  return;
                }
                inSheetData = true; pending = pending.slice(sd + 11); continue;
              }
              const ra = pending.indexOf('<row ');
              const rb = pending.indexOf('<row>');
              const rowStart = ra < 0 ? rb : (rb < 0 ? ra : Math.min(ra, rb));
              if (rowStart < 0) { if (pending.length > 16) pending = pending.slice(-16); return; }
              const rowEnd = pending.indexOf('</row>', rowStart);
              if (rowEnd < 0) { if (rowStart > 0) pending = pending.slice(rowStart); return; }
              const rowXml = pending.slice(rowStart, rowEnd + 6);
              pending = pending.slice(rowEnd + 6);
              rowIdx += 1;
              onRow(parseRowXml(rowXml, colCount, sharedStrings), rowIdx);
            }
          };
          stream.on('data', (chunk) => {
            try { pending += decoder.write(chunk); drain(); }
            catch (er) { try { stream.destroy(); } catch (_) {} reject(er); }
          });
          stream.on('end', () => {
            try { pending += decoder.end(); drain(); try { zip.close(); } catch (_) {} resolve(); }
            catch (er) { reject(er); }
          });
          stream.on('error', reject);
        });
      });
    });
  });
}

// =================== C：yauzl + 手写扫描（纯解析）===================
async function runC(withMonthKey) {
  const { FLOW_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../../src/backend/acquiring-bill-currency-db/columns');
  const { extractMonthKey } = require('../../src/backend/acquiring-bill-currency-import/validator');
  const billCol = FLOW_KEY_COLUMN_INDICES.billDate;
  let totalRows = 0;
  let mkCount = 0;
  const t0 = performance.now();
  await yauzlHandRolledScan(fixture, FLOW_HEADERS.length, (cells, idx) => {
    totalRows += 1;
    if (withMonthKey) { if (idx === 1) return; if (extractMonthKey(cells[billCol])) mkCount += 1; }
  });
  const ms = performance.now() - t0;
  emit(withMonthKey ? 'C-yauzl+手写扫描+monthKey' : 'C-yauzl+手写扫描', ms, withMonthKey ? mkCount : totalRows);
}

// =================== Cins：yauzl+手写解析 + 真实 insertFlowRow（含 raw_json+SQL）端到端 ===================
// 实测「换解析器后的完整导入」：与 clean-timing 现状（sax 路径 ~122s/50万）同口径（含 raw_json + SQL insert），
// 唯一变量 = 解析器 sax→手写。证 ROI 是实测不是推算。临时库，POC 不碰 prod reader.js。
async function runCins() {
  const os = require('node:os');
  const path = require('node:path');
  const { AppDatabase } = require('../../src/backend/database');
  const importRepo = require('../../src/backend/acquiring-bill-currency-db/import-repository');
  const { FLOW_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../../src/backend/acquiring-bill-currency-db/columns');
  const { extractMonthKey } = require('../../src/backend/acquiring-bill-currency-import/validator');
  const billCol = FLOW_KEY_COLUMN_INDICES.billDate;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cins-'));
  const app = new AppDatabase(path.join(dir, 't.sqlite'));
  app.init();
  const db = app.db;
  const stmt = importRepo.prepareFlowInsert(db);

  let imported = 0;
  const t0 = performance.now();
  db.exec('BEGIN');
  await yauzlHandRolledScan(fixture, FLOW_HEADERS.length, (cells, idx) => {
    if (idx === 1) return;                       // 表头
    const mk = extractMonthKey(cells[billCol]);
    if (!mk) return;
    importRepo.insertFlowRow(stmt, { monthKey: mk, sourceFile: 'fx.xlsx', row: { rowIndex: idx, values: cells }, importedAt: '2026-03-01T00:00:00Z' });
    imported += 1;
  });
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  emit('Cins-yauzl+手写+真实insert(端到端)', ms, imported);
  try { db.close(); } catch (_e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// =================== scalediff：真实大文件全行 byte-for-byte（sax vs 手写，O(1) 内存滚动哈希）===================
// contract test 用小 fixture；本模式在真实 50万/100万行上跑 reader.js(sax) vs reader-handrolled，
// 每行把 rowIndex + values 串起来喂 SHA1，比对最终摘要 + importedCount + monthKey → 证规模下逐行逐列一致
// （覆盖小 fixture 测不到的 stream chunk 跨行边界）。kind=flow。
async function runScaleDiff() {
  const crypto = require('node:crypto');
  const importRepo = require('../../src/backend/acquiring-bill-currency-db/import-repository');
  const saxReader = require('../../src/backend/acquiring-bill-currency-import/reader');
  const handReader = require('../../src/backend/acquiring-bill-currency-import/reader-handrolled');

  importRepo.prepareFlowInsert = () => ({ run: () => {} });

  async function digestVia(reader, label) {
    const h = crypto.createHash('sha1');
    let rows = 0;
    importRepo.insertFlowRow = (_stmt, { row }) => {
      h.update(String(row.rowIndex));
      h.update('\x1e');
      const v = row.values;
      for (let i = 0; i < v.length; i++) { h.update(v[i] == null ? '' : String(v[i])); h.update('\x1f'); }
      h.update('\n');
      rows += 1;
    };
    const t0 = performance.now();
    const r = await reader.importFlowFile({ db: {}, filePath: fixture, importedAt: 'x', expectedMonthKey: '2026-03', onProgress: () => {} });
    const ms = ((performance.now() - t0) / 1000).toFixed(1);
    return { digest: h.digest('hex'), rows, importedCount: r.importedCount, monthKey: r.monthKey, ms };
  }

  const A = await digestVia(saxReader, 'sax');
  const B = await digestVia(handReader, 'hand');
  clearInterval(sampler);
  console.log(`[scalediff] fixture=${sizeMB}MB`);
  console.log(`  sax : digest=${A.digest}  rows=${A.rows}  importedCount=${A.importedCount}  monthKey=${A.monthKey}  (${A.ms}s)`);
  console.log(`  hand: digest=${B.digest}  rows=${B.rows}  importedCount=${B.importedCount}  monthKey=${B.monthKey}  (${B.ms}s)`);
  const ok = A.digest === B.digest && A.importedCount === B.importedCount && A.monthKey === B.monthKey;
  console.log(ok
    ? `[scalediff] ✅ ${A.rows} 行全行 SHA1 + importedCount + monthKey 完全一致 —— 真实规模 byte-for-byte 通过`
    : `[scalediff] ❌ 不一致！digest ${A.digest === B.digest} / count ${A.importedCount}vs${B.importedCount} / mk ${A.monthKey}vs${B.monthKey}`);
  console.log('RESULT|scalediff|equal=' + ok + '|rows=' + A.rows);
}

// =================== equal：正确性闸（前 N 行 cells 逐格比对）===================
async function runEqual() {
  clearInterval(sampler);
  const N = parseInt(process.argv[4] || '3000', 10);
  const importRepo = require('../../src/backend/acquiring-bill-currency-db/import-repository');
  const reader = require('../../src/backend/acquiring-bill-currency-import/reader');
  const { readXlsxStreamed } = require('../../src/backend/pending-import/streaming-xlsx-reader');
  const { FLOW_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

  // sax 路径：monkeypatch insert 捕获前 N 行 row.values
  const saxRows = [];
  importRepo.prepareFlowInsert = () => ({ run: () => {} });
  importRepo.insertFlowRow = (_stmt, payload) => {
    if (saxRows.length < N) saxRows.push(payload.row.values.slice());
  };
  await reader.importFlowFile({
    db: {}, filePath: fixture, importedAt: 'x', expectedMonthKey: '2026-03', onProgress: () => {}
  });

  // 手写扫描路径：收集前 N 数据行
  const handRows = [];
  await readXlsxStreamed(fixture, (cells, idx) => {
    if (idx === 1) return;               // 表头
    if (handRows.length < N) handRows.push(cells.slice());
  }, { colCount: FLOW_HEADERS.length });

  // 逐格比对
  const cmp = Math.min(saxRows.length, handRows.length);
  let mismatch = 0;
  let firstMismatch = null;
  for (let i = 0; i < cmp; i++) {
    const a = saxRows[i];
    const b = handRows[i];
    for (let c = 0; c < FLOW_HEADERS.length; c++) {
      const av = a[c] == null ? '' : String(a[c]);
      const bv = b[c] == null ? '' : String(b[c]);
      if (av !== bv) {
        mismatch += 1;
        if (!firstMismatch) firstMismatch = { row: i, col: c, header: FLOW_HEADERS[c], sax: av, hand: bv };
      }
    }
  }
  console.log(`[equal] 比对前 ${cmp} 数据行 × ${FLOW_HEADERS.length} 列：sax 捕获 ${saxRows.length} 行 / 手写 ${handRows.length} 行`);
  if (mismatch === 0) {
    console.log(`[equal] ✅ 0 差异 —— 手写扫描与 sax 在真实 48 列 inlineStr 数据上 byte-level 一致`);
    console.log('RESULT|equal|mismatch=0|comparedRows=' + cmp);
  } else {
    console.log(`[equal] ❌ ${mismatch} 处差异；首例：行${firstMismatch.row} 列${firstMismatch.col}(${firstMismatch.header}) sax="${firstMismatch.sax}" 手写="${firstMismatch.hand}"`);
    console.log('RESULT|equal|mismatch=' + mismatch + '|comparedRows=' + cmp);
  }
}

(async () => {
  if (mode === 'A') await runA();
  else if (mode === 'B') await runB(false);
  else if (mode === 'Bmk') await runB(true);
  else if (mode === 'C') await runC(false);
  else if (mode === 'Cmk') await runC(true);
  else if (mode === 'Cins') await runCins();
  else if (mode === 'scalediff') await runScaleDiff();
  else if (mode === 'equal') await runEqual();
  else { console.error('未知 mode：' + mode); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
