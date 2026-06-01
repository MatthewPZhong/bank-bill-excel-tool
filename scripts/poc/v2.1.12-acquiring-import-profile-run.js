// v2.1.12-beta POC（收单导入 profile）—— 三段耗时拆解 + 优化候选实测
//
// 唯一目的：用实测数据找出收单导入慢在哪一段、验证优化值不值得（不 profile 就优化 = 白干）。
//
// 三段（同一份 fixture，performance.now() 打点）：
//   P1 解析       ：yauzl+sax 流式读完所有行、组 cells、提取关键字段 + 校验，不组 raw_json、不 insert
//   P2 解析+rawjson：P1 + 每行组 rawObj(48 key) + JSON.stringify，不 insert  → raw_json 成本 = P2 - P1
//   P3 全量(现状) ：P2 + prepared 逐行 stmt.run INSERT（临时 sqlite，事务内）→ insert 成本 = P3 - P2
//
// 优化候选：
//   Opt-A raw_json 精简：flow 只存关键列 / 完全不存 raw_json → 测 P3 delta（上界）
//   Opt-B 批量多行 INSERT：逐行 .run() 改 INSERT...VALUES(...),(...)（500 行/批）→ 测 insert 段 delta
//   Opt-C：A + B 叠加
//
// 🔴 raw_json 精简属功能敏感（writer 重导出依赖）；本 POC 只测收益，不下"就这么改"结论。
//
// ⚠️ 重要：解析逻辑（openZip / loadSharedStrings / streamSheetRows）原样 replicate 自
//   src/backend/acquiring-bill-currency-import/reader.js；insert 逻辑 replicate 自
//   src/backend/acquiring-bill-currency-db/import-repository.js insertFlowRow。
//   不 import prod 执行路径（prod 的 streamSheetRows 内直接 insert，不可切分），故复制以加 mode 打点。
//   smoke 已验证：同一 fixture 走真实 prod reader 与本 replicate 解析结果一致（importedCount/关键列）。
//
// 用法：
//   node scripts/poc/v2.1.12-acquiring-import-profile-run.js [fixturePath] [--rounds=1]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const yauzl = require('yauzl');
const sax = require('sax');

// ---- replicate columns.js ----
const FLOW_HEADERS = [
  '账单日期', 'originBizId', '主体大账号', '公司主体', '流水类型', '业务部门',
  '对账主Id', '出入方向', '流水单号', '用户编号', '账户编号', '拆分类型',
  '对账金额', '币种', '账户类型', '流水开始时间', '流水完成时间', '渠道',
  'MerchantId', 'valueDate', 'BankRef', 'Pending标识', '流水BizId', '穿透ID',
  '操作人', '系统创建时间', '系统修改时间', 'MID', '通道清算金额', '通道清算币种',
  '交易订单号', '关联渠道', '关联MID', '关联通道清算币种', '关联通道清算金额', '抵扣资金方向',
  '抵扣手续费合计', '抵扣金额', '抵扣本金', '本金-循环保证金', '交易手续费', '退款手续费',
  '拒付手续费', '提现手续费', '一次性费用', '其他手续费', '常规入账资金', '客资账户余额'
];
const FLOW_KEY_COLUMN_INDICES = {
  billDate: FLOW_HEADERS.indexOf('账单日期'),
  reconMainId: FLOW_HEADERS.indexOf('对账主Id'),
  settleAmount: FLOW_HEADERS.indexOf('通道清算金额'),
  settleCurrency: FLOW_HEADERS.indexOf('通道清算币种')
};
// Opt-A 候选：writer 重导出真正可能需要的精简列集（从 columns/run-repository/writer 分析得出）
//   分析结论：当前 prod 中 flow_imports.raw_json 没有任何下游消费（run-repository 全走结构化列
//   f.settle_*；writer 输出取 diff_rows.flow_currency/flow_amount_abs）。
//   故"精简"上界 = 完全不存；这里另给一个"保守精简集"（关键 4 列 + 几个常见明细列）作对比。
const FLOW_RAWJSON_SLIM_KEYS = ['账单日期', '对账主Id', '通道清算金额', '通道清算币种', 'MerchantId', '流水单号', '对账金额', '币种'];

const SHEET_ENTRY_NAME = 'xl/worksheets/sheet1.xml';
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';

// ---------------- replicate reader.js 解析函数（纯解析，不碰 insert） ----------------
function columnLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}
function parseColumnFromCellRef(cellRef) {
  if (!cellRef) return -1;
  const m = cellRef.match(/^([A-Z]+)/);
  return m ? columnLetterToIndex(m[1]) : -1;
}
function openZipWithEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      let settled = false;
      zip.on('entry', (entry) => { if (!entries.has(entry.fileName)) entries.set(entry.fileName, entry); });
      zip.on('end', () => { if (!settled) { settled = true; resolve({ zip, entries }); } });
      zip.on('error', (e) => { if (!settled) { settled = true; try { zip.close(); } catch (_) {} reject(e); } });
    });
  });
}
function loadSharedStrings(zip, sstEntry) {
  if (!sstEntry) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    zip.openReadStream(sstEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      const arr = [];
      let inSi = false, inT = false, currentVal = '';
      parser.on('opentag', (n) => {
        if (n.name === 'si') { inSi = true; currentVal = ''; }
        else if (n.name === 't' && inSi) inT = true;
      });
      parser.on('text', (t) => { if (inT) currentVal += t; });
      parser.on('cdata', (t) => { if (inT) currentVal += t; });
      parser.on('closetag', (tag) => {
        if (tag === 't') inT = false;
        else if (tag === 'si') { arr.push(currentVal); currentVal = ''; inSi = false; }
      });
      parser.on('end', () => resolve(arr));
      parser.on('error', reject);
      stream.on('error', reject);
      stream.pipe(parser);
    });
  });
}
function streamSheetRows({ zip, sheetEntry, expectedHeaders, sharedStrings, onRow }) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      let stopped = false;
      let currentRowR = null, currentRowValues = null, currentCellCol = -1, currentCellType = '';
      let inIs = false, inT = false, inV = false, currentText = '';
      parser.on('opentag', (n) => {
        if (stopped) return;
        const tag = n.name;
        if (tag === 'row') {
          const r = parseInt(n.attributes.r, 10) || 0;
          currentRowR = r;
          currentRowValues = r === 1 ? [] : new Array(expectedHeaders.length).fill('');
        } else if (tag === 'c') {
          currentCellCol = parseColumnFromCellRef(n.attributes.r || '');
          currentCellType = n.attributes.t || '';
        } else if (tag === 'is') inIs = true;
        else if (tag === 't') { if (inIs || currentCellType === 'str') { inT = true; currentText = ''; } }
        else if (tag === 'v') { inV = true; currentText = ''; }
      });
      parser.on('text', (t) => { if (!stopped && (inT || inV)) currentText += t; });
      parser.on('cdata', (t) => { if (!stopped && (inT || inV)) currentText += t; });
      parser.on('closetag', (tag) => {
        if (stopped) return;
        if (tag === 't') inT = false;
        else if (tag === 'is') inIs = false;
        else if (tag === 'v') inV = false;
        else if (tag === 'c') {
          const allowWrite = currentRowValues && currentCellCol >= 0
            && (currentRowR === 1 || currentCellCol < currentRowValues.length);
          if (allowWrite) {
            let val = '';
            if (currentCellType === 'inlineStr' || currentCellType === 'str') val = currentText;
            else if (currentCellType === 's') {
              const idx = parseInt(currentText, 10);
              val = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
            } else val = currentText;
            currentRowValues[currentCellCol] = val;
          }
          currentCellCol = -1; currentCellType = ''; currentText = '';
        } else if (tag === 'row') {
          if (currentRowValues) {
            const rowR = currentRowR, values = currentRowValues;
            currentRowValues = null; currentRowR = null;
            try { onRow({ rowR, values }); }
            catch (rowErr) { if (!stopped) { stopped = true; try { stream.destroy(); } catch (_) {} reject(rowErr); } }
          }
        }
      });
      parser.on('end', () => { if (!stopped) { stopped = true; resolve(); } });
      parser.on('error', (e) => { if (!stopped) { stopped = true; reject(e); } });
      stream.on('error', (e) => { if (!stopped) { stopped = true; reject(e); } });
      stream.pipe(parser);
    });
  });
}

// ---------------- replicate import-repository.js insertFlowRow 的字段提取 ----------------
function extractMonthKey(billDateRaw) {
  if (billDateRaw == null) return null;
  const str = String(billDateRaw).trim();
  if (!str) return null;
  const match = str.match(/^(\d{4})[-/](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${String(match[2]).padStart(2, '0')}`;
}
function normalizeBillDate(v) {
  if (v == null) return '';
  const str = String(v).trim();
  if (!str) return '';
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return str;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function normalizeCurrency(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}
function parseAmountAbs(value) {
  if (value == null || value === '') throw new Error('通道清算金额为空');
  const num = Number(String(value).trim().replace(/,/g, ''));
  if (!Number.isFinite(num)) throw new Error('通道清算金额无法解析');
  return Math.abs(num).toString();
}

// 提取关键字段（P1 解析阶段就要做 — 与 prod insertFlowRow 一致：reconMainId/settleAmount/abs/currency/norm）
function extractKeyFields(values) {
  const reconMainId = String(values[6] || '').trim();
  const settleAmountRaw = values[28];
  const settleAmount = String(settleAmountRaw || '').trim();
  const settleAmountAbs = settleAmount === '' ? '' : parseAmountAbs(settleAmountRaw);
  const settleCurrency = String(values[29] || '').trim();
  const settleCurrencyNorm = normalizeCurrency(values[29]);
  return { reconMainId, settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm };
}

// 组 rawObj + stringify（P2 阶段）。keys 控制精简（Opt-A）
function buildRawJson(values, keys) {
  const rawObj = {};
  if (keys === null) return null; // 完全不存
  if (keys === FLOW_HEADERS) {
    for (let i = 0; i < FLOW_HEADERS.length; i++) {
      rawObj[FLOW_HEADERS[i]] = values[i] === undefined ? '' : String(values[i]);
    }
    rawObj[FLOW_HEADERS[0]] = normalizeBillDate(rawObj[FLOW_HEADERS[0]]);
  } else {
    for (const k of keys) {
      const idx = FLOW_HEADERS.indexOf(k);
      rawObj[k] = (idx < 0 || values[idx] === undefined) ? '' : String(values[idx]);
    }
    if ('账单日期' in rawObj) rawObj['账单日期'] = normalizeBillDate(rawObj['账单日期']);
  }
  return JSON.stringify(rawObj);
}

// ---------------- SQLite schema（replicate migrations.js:1816 + 索引） ----------------
function createFlowSchema(db) {
  db.exec(`
    CREATE TABLE acquiring_bill_currency_flow_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL, source_file TEXT NOT NULL, source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL, settle_amount TEXT NOT NULL, settle_amount_abs TEXT NOT NULL,
      settle_currency TEXT, settle_currency_norm TEXT, raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (month_key, recon_main_id));
    CREATE INDEX idx_acquiring_bill_currency_flow_month ON acquiring_bill_currency_flow_imports(month_key);
    CREATE INDEX idx_acquiring_bill_currency_flow_join ON acquiring_bill_currency_flow_imports(month_key, recon_main_id);
  `);
}
const FLOW_INSERT_SQL = `INSERT INTO acquiring_bill_currency_flow_imports
  (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const FLOW_COLS_PER_ROW = 10;

function memMB() { return process.memoryUsage().rss / 1024 / 1024; }

// ============================================================
// 一次完整 pass。mode 决定做到哪一步 / 用哪种 insert 策略。
//   mode.parse      : 总是 true（流式解析 + 提取关键字段）
//   mode.rawJsonKeys: null=不组 / FLOW_HEADERS=全48列 / 数组=精简集 / undefined=不组
//   mode.insert     : 'none' | 'row'（逐行）| 'batch'（多行 VALUES）
//   mode.batchSize  : batch 模式每批行数
// 返回 { elapsedMs, importedCount, peakRssMB }
// ============================================================
async function runPass(filePath, mode) {
  const importedAt = new Date().toISOString();
  const sourceFile = path.basename(filePath);
  let db = null, insertStmt = null;
  let batchBuf = [];           // batch 模式累积的 param 数组
  const batchSize = mode.batchSize || 500;
  const batchStmtCache = new Map(); // rows→prepared stmt

  if (mode.insert && mode.insert !== 'none') {
    db = new DatabaseSync(':memory:');
    createFlowSchema(db);
    db.exec('BEGIN');
    if (mode.insert === 'row') insertStmt = db.prepare(FLOW_INSERT_SQL);
  }

  function getBatchStmt(nRows) {
    let s = batchStmtCache.get(nRows);
    if (!s) {
      const oneRow = '(' + new Array(FLOW_COLS_PER_ROW).fill('?').join(',') + ')';
      const sql = `INSERT INTO acquiring_bill_currency_flow_imports
        (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
        VALUES ${new Array(nRows).fill(oneRow).join(',')}`;
      s = db.prepare(sql);
      batchStmtCache.set(nRows, s);
    }
    return s;
  }
  function flushBatch() {
    if (batchBuf.length === 0) return;
    const nRows = batchBuf.length;
    const params = new Array(nRows * FLOW_COLS_PER_ROW);
    let p = 0;
    for (const row of batchBuf) for (let k = 0; k < FLOW_COLS_PER_ROW; k++) params[p++] = row[k];
    getBatchStmt(nRows).run(...params);
    batchBuf = [];
  }

  const { zip, entries } = await openZipWithEntries(filePath);
  let importedCount = 0;
  let peakRss = memMB();
  let rowCounter = 0;
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    const sstEntry = entries.get(SHARED_STRINGS_ENTRY_NAME);
    let sharedStrings = [];
    try { sharedStrings = await loadSharedStrings(zip, sstEntry); } catch (_) { sharedStrings = []; }

    let detectedMonthKey = mode.expectedMonthKey || null;
    let headerValidated = false;

    await streamSheetRows({
      zip, sheetEntry, expectedHeaders: FLOW_HEADERS, sharedStrings,
      onRow: ({ rowR, values }) => {
        if (rowR === 1) { headerValidated = true; return; }
        const allEmpty = values.every((v) => v === '' || v == null);
        if (allEmpty) return;

        // ---- P1 解析：提取关键字段 + 月份校验（与 prod insertFlowRow 前半段一致） ----
        const billDateRaw = values[FLOW_KEY_COLUMN_INDICES.billDate];
        const monthKey = extractMonthKey(billDateRaw);
        if (!monthKey) return;
        if (!detectedMonthKey) detectedMonthKey = monthKey;
        const kf = extractKeyFields(values);

        // ---- P2：组 raw_json ----
        let rawJson = '';
        if (mode.rawJsonKeys !== undefined) {
          rawJson = buildRawJson(values, mode.rawJsonKeys);
        }

        // ---- P3：insert ----
        if (mode.insert === 'row') {
          insertStmt.run(monthKey, sourceFile, rowR, kf.reconMainId, kf.settleAmount,
            kf.settleAmountAbs, kf.settleCurrency, kf.settleCurrencyNorm,
            rawJson === null ? '' : rawJson, importedAt);
          importedCount++;
        } else if (mode.insert === 'batch') {
          batchBuf.push([monthKey, sourceFile, rowR, kf.reconMainId, kf.settleAmount,
            kf.settleAmountAbs, kf.settleCurrency, kf.settleCurrencyNorm,
            rawJson === null ? '' : rawJson, importedAt]);
          importedCount++;
          if (batchBuf.length >= batchSize) flushBatch();
        } else {
          importedCount++;
        }

        rowCounter++;
        if (rowCounter % 50000 === 0) {
          const r = memMB();
          if (r > peakRss) peakRss = r;
        }
      }
    });

    if (mode.insert === 'batch') flushBatch();
    if (db) { db.exec('COMMIT'); }
  } finally {
    try { zip.close(); } catch (_) {}
    const r = memMB();
    if (r > peakRss) peakRss = r;
    if (db) { try { db.close(); } catch (_) {} }
  }
  return { importedCount, peakRssMB: peakRss };
}

async function timed(label, filePath, mode) {
  if (global.gc) global.gc();
  const rssBefore = memMB();
  const t0 = performance.now();
  const r = await runPass(filePath, mode);
  const elapsedMs = performance.now() - t0;
  return { label, elapsedMs, importedCount: r.importedCount, peakRssMB: Math.max(r.peakRssMB, rssBefore) };
}

function fmtMs(ms) { return (ms).toFixed(0).padStart(8) + ' ms'; }
function pct(part, total) { return ((part / total) * 100).toFixed(1) + '%'; }

async function profileFixture(filePath) {
  const stat = fs.statSync(filePath);
  console.log(`\n========================================================`);
  console.log(`Fixture: ${path.basename(filePath)}  (${(stat.size / 1024 / 1024).toFixed(1)} MB on disk)`);
  console.log(`========================================================`);

  // 三段（注意：用整链累计 — P1/P2/P3 都从头解析同一文件，差值即各段成本）
  const p1 = await timed('P1 解析', filePath, { insert: 'none' }); // rawJsonKeys undefined → 不组
  const p2 = await timed('P2 解析+raw_json(全48列)', filePath, { insert: 'none', rawJsonKeys: FLOW_HEADERS });
  const p3 = await timed('P3 全量(现状：全48列 raw_json + 逐行 insert)', filePath, { insert: 'row', rawJsonKeys: FLOW_HEADERS });

  const rows = p3.importedCount;
  const total = p3.elapsedMs;
  const parseCost = p1.elapsedMs;
  const rawJsonCost = p2.elapsedMs - p1.elapsedMs;
  const insertCost = p3.elapsedMs - p2.elapsedMs;

  console.log(`\n--- 三段耗时拆解（${rows} 行）---`);
  console.log(`P1 解析            : ${fmtMs(parseCost)}   (${pct(parseCost, total)})`);
  console.log(`P2-P1 raw_json     : ${fmtMs(rawJsonCost)}   (${pct(rawJsonCost, total)})`);
  console.log(`P3-P2 insert       : ${fmtMs(insertCost)}   (${pct(insertCost, total)})`);
  console.log(`P3 总耗时(现状)    : ${fmtMs(total)}   (100%)`);
  console.log(`峰值 RSS           : P1=${p1.peakRssMB.toFixed(0)}MB  P2=${p2.peakRssMB.toFixed(0)}MB  P3=${p3.peakRssMB.toFixed(0)}MB`);
  console.log(`吞吐(现状)         : ${(rows / (total / 1000)).toFixed(0)} 行/秒`);

  // --- 优化候选 ---
  console.log(`\n--- 优化候选实测 ---`);
  // Opt-A1：完全不存 raw_json（上界）+ 逐行 insert
  const optA1 = await timed('Opt-A1 不存raw_json + 逐行insert', filePath, { insert: 'row', rawJsonKeys: null });
  // Opt-A2：精简 raw_json（8 列）+ 逐行 insert
  const optA2 = await timed('Opt-A2 精简raw_json(8列) + 逐行insert', filePath, { insert: 'row', rawJsonKeys: FLOW_RAWJSON_SLIM_KEYS });
  // Opt-B：全48列 raw_json + 批量 insert(500)
  const optB = await timed('Opt-B 全48列raw_json + 批量insert(500)', filePath, { insert: 'batch', rawJsonKeys: FLOW_HEADERS, batchSize: 500 });
  // Opt-C：不存 raw_json + 批量 insert(500)
  const optC = await timed('Opt-C 不存raw_json + 批量insert(500)', filePath, { insert: 'batch', rawJsonKeys: null, batchSize: 500 });

  const save = (opt) => `${fmtMs(opt.elapsedMs)}   省 ${((1 - opt.elapsedMs / total) * 100).toFixed(1)}%   (${(rows / (opt.elapsedMs / 1000)).toFixed(0)} 行/秒)`;
  console.log(`现状(P3)                         : ${fmtMs(total)}`);
  console.log(`Opt-A1 不存raw_json(逐行)        : ${save(optA1)}`);
  console.log(`Opt-A2 精简raw_json 8列(逐行)    : ${save(optA2)}`);
  console.log(`Opt-B  全raw_json+批量500        : ${save(optB)}`);
  console.log(`Opt-C  不存raw_json+批量500      : ${save(optC)}`);

  return {
    rows, total, parseCost, rawJsonCost, insertCost,
    peak: { p1: p1.peakRssMB, p2: p2.peakRssMB, p3: p3.peakRssMB },
    opt: { A1: optA1.elapsedMs, A2: optA2.elapsedMs, B: optB.elapsedMs, C: optC.elapsedMs }
  };
}

async function main() {
  const fixtureArg = process.argv[2];
  let fixtures;
  if (fixtureArg && !fixtureArg.startsWith('--')) {
    fixtures = [path.resolve(fixtureArg)];
  } else {
    // 默认跑 tmp 下的 50万 + 100万 两档（若存在）
    const tmp = path.resolve(__dirname, '..', '..', 'tmp');
    fixtures = [
      path.join(tmp, 'poc-acquiring-flow-500000.xlsx'),
      path.join(tmp, 'poc-acquiring-flow-1000000.xlsx')
    ].filter((f) => fs.existsSync(f));
  }
  if (fixtures.length === 0) {
    console.error('未找到 fixture。先运行 gen-fixture 生成，或传入路径。');
    process.exit(1);
  }
  console.log(`Node ${process.version}  gc=${global.gc ? 'on' : 'off(建议 --expose-gc)'}`);

  const results = [];
  for (const f of fixtures) results.push({ file: path.basename(f), ...(await profileFixture(f)) });

  // 外推 500 万行
  console.log(`\n\n================ 外推 500 万行（按最大档线性外推）================`);
  const base = results[results.length - 1];
  const scale = 5000000 / base.rows;
  const sec = (ms) => (ms * scale / 1000).toFixed(1);
  console.log(`基准档：${base.file}（${base.rows} 行）→ ×${scale.toFixed(1)} 外推`);
  console.log(`现状(P3)            ≈ ${sec(base.total)} s`);
  console.log(`  其中 解析         ≈ ${sec(base.parseCost)} s`);
  console.log(`  其中 raw_json     ≈ ${sec(base.rawJsonCost)} s`);
  console.log(`  其中 insert       ≈ ${sec(base.insertCost)} s`);
  console.log(`Opt-A1 不存raw_json ≈ ${sec(base.opt.A1)} s`);
  console.log(`Opt-A2 精简raw_json ≈ ${sec(base.opt.A2)} s`);
  console.log(`Opt-B  批量insert   ≈ ${sec(base.opt.B)} s`);
  console.log(`Opt-C  叠加         ≈ ${sec(base.opt.C)} s`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runPass, profileFixture };
