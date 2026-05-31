// v2.1.12-beta POC（收单导入 profile）—— insert 段隔离对比
//
// 补充诊断：全链 profile 里解析占 85%，会把 raw_json/insert 优化稀释成噪声。
// 本脚本【隔离解析】：先把 fixture 解析成内存行数组（一次性），再【只计时 insert 段】
// 对比不同写入策略，给出"insert 段内部"的干净 delta —— 避免"分母太大掩盖收益"的质疑。
//
// 对比策略（同一批内存行、同一份临时 sqlite schema 含 UNIQUE + 2 索引、事务内）：
//   S0 逐行 prepared .run()        ← 现状
//   S1 逐行 prepared，raw_json=''   ← Opt-A 上界（不存 raw_json 对 insert 段的影响）
//   S2 批量多行 VALUES 500/批
//   S3 批量多行 VALUES 1000/批
//   S4 批量 500 + raw_json=''
//
// 结论用途：回答 team-lead "batch insert 到底值不值得做" —— 哪怕在 insert 段内部。
//
// 解析逻辑 replicate 自 reader.js（同 profile-run.js）。不 import / 不改 prod。
//
// 用法：node --expose-gc scripts/poc/v2.1.12-acquiring-import-profile-insert-isolated.js [fixturePath]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const yauzl = require('yauzl');
const sax = require('sax');

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
const SHEET_ENTRY_NAME = 'xl/worksheets/sheet1.xml';
const SHARED_STRINGS_ENTRY_NAME = 'xl/sharedStrings.xml';
const COLS = 10;

function columnLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}
function parseColumnFromCellRef(ref) {
  if (!ref) return -1;
  const m = ref.match(/^([A-Z]+)/);
  return m ? columnLetterToIndex(m[1]) : -1;
}
function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: false, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      let settled = false;
      zip.on('entry', (e) => { if (!entries.has(e.fileName)) entries.set(e.fileName, e); });
      zip.on('end', () => { if (!settled) { settled = true; resolve({ zip, entries }); } });
      zip.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    });
  });
}
function streamRows({ zip, sheetEntry, onRow }) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(sheetEntry, (err, stream) => {
      if (err) return reject(err);
      const parser = sax.createStream(false, { lowercase: true });
      let currentRowR = null, vals = null, col = -1, type = '';
      let inIs = false, inT = false, inV = false, txt = '';
      parser.on('opentag', (n) => {
        const tag = n.name;
        if (tag === 'row') { currentRowR = parseInt(n.attributes.r, 10) || 0; vals = currentRowR === 1 ? [] : new Array(FLOW_HEADERS.length).fill(''); }
        else if (tag === 'c') { col = parseColumnFromCellRef(n.attributes.r || ''); type = n.attributes.t || ''; }
        else if (tag === 'is') inIs = true;
        else if (tag === 't') { if (inIs || type === 'str') { inT = true; txt = ''; } }
        else if (tag === 'v') { inV = true; txt = ''; }
      });
      parser.on('text', (t) => { if (inT || inV) txt += t; });
      parser.on('cdata', (t) => { if (inT || inV) txt += t; });
      parser.on('closetag', (tag) => {
        if (tag === 't') inT = false;
        else if (tag === 'is') inIs = false;
        else if (tag === 'v') inV = false;
        else if (tag === 'c') {
          if (vals && col >= 0 && (currentRowR === 1 || col < vals.length)) vals[col] = txt;
          col = -1; type = ''; txt = '';
        } else if (tag === 'row') {
          if (vals) { const r = currentRowR, v = vals; vals = null; currentRowR = null; onRow(r, v); }
        }
      });
      parser.on('end', resolve);
      parser.on('error', reject);
      stream.on('error', reject);
      stream.pipe(parser);
    });
  });
}

function normalizeBillDate(v) {
  const str = String(v == null ? '' : v).trim();
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : str;
}
function extractMonthKey(v) {
  const str = String(v == null ? '' : v).trim();
  const m = str.match(/^(\d{4})[-/](\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : null;
}

// 解析全文件 → 内存行（每行已是 10 个 insert 参数；raw_json 用全 48 列）。一次性，不计入对比计时。
async function parseToMemory(filePath) {
  const sourceFile = path.basename(filePath);
  const importedAt = new Date().toISOString();
  const { zip, entries } = await openZip(filePath);
  const rows = [];
  try {
    const sheetEntry = entries.get(SHEET_ENTRY_NAME);
    await streamRows({
      zip, sheetEntry,
      onRow: (rowR, values) => {
        if (rowR === 1) return;
        if (values.every((v) => v === '' || v == null)) return;
        const monthKey = extractMonthKey(values[0]);
        if (!monthKey) return;
        const reconMainId = String(values[6] || '').trim();
        const settleAmount = String(values[28] || '').trim();
        const settleAmountAbs = settleAmount === '' ? '' : Math.abs(Number(settleAmount.replace(/,/g, ''))).toString();
        const settleCurrency = String(values[29] || '').trim();
        const settleCurrencyNorm = settleCurrency.toLowerCase();
        const rawObj = {};
        for (let i = 0; i < FLOW_HEADERS.length; i++) rawObj[FLOW_HEADERS[i]] = values[i] === undefined ? '' : String(values[i]);
        rawObj[FLOW_HEADERS[0]] = normalizeBillDate(rawObj[FLOW_HEADERS[0]]);
        rows.push([monthKey, sourceFile, rowR, reconMainId, settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm, JSON.stringify(rawObj), importedAt]);
      }
    });
  } finally { try { zip.close(); } catch (_) {} }
  return rows;
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE acquiring_bill_currency_flow_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, month_key TEXT NOT NULL, source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL, recon_main_id TEXT NOT NULL, settle_amount TEXT NOT NULL,
      settle_amount_abs TEXT NOT NULL, settle_currency TEXT, settle_currency_norm TEXT,
      raw_json TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id));
    CREATE INDEX idx_flow_month ON acquiring_bill_currency_flow_imports(month_key);
    CREATE INDEX idx_flow_join ON acquiring_bill_currency_flow_imports(month_key, recon_main_id);
  `);
  return db;
}
const INSERT_COLS = `(month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)`;
const ONE_ROW_PLACEHOLDER = '(' + new Array(COLS).fill('?').join(',') + ')';

// strategy: { batch:1, blankRawJson:false }
function timeInsert(rows, strategy) {
  if (global.gc) global.gc();
  const db = freshDb();
  db.exec('BEGIN');
  const t0 = performance.now();
  const batch = strategy.batch || 1;
  const blank = !!strategy.blankRawJson;
  const rawJsonIdx = 8;

  if (batch === 1) {
    const stmt = db.prepare(`INSERT INTO acquiring_bill_currency_flow_imports ${INSERT_COLS} VALUES ${ONE_ROW_PLACEHOLDER}`);
    for (const r of rows) {
      if (blank) { const rj = r[rawJsonIdx]; r[rawJsonIdx] = ''; stmt.run(...r); r[rawJsonIdx] = rj; }
      else stmt.run(...r);
    }
  } else {
    const sqlFull = `INSERT INTO acquiring_bill_currency_flow_imports ${INSERT_COLS} VALUES ${new Array(batch).fill(ONE_ROW_PLACEHOLDER).join(',')}`;
    const stmtFull = db.prepare(sqlFull);
    const params = new Array(batch * COLS);
    let i = 0;
    const n = rows.length;
    while (i + batch <= n) {
      let p = 0;
      for (let b = 0; b < batch; b++) {
        const r = rows[i + b];
        for (let k = 0; k < COLS; k++) params[p++] = (blank && k === rawJsonIdx) ? '' : r[k];
      }
      stmtFull.run(...params);
      i += batch;
    }
    // 尾批
    if (i < n) {
      const rem = n - i;
      const stmtRem = db.prepare(`INSERT INTO acquiring_bill_currency_flow_imports ${INSERT_COLS} VALUES ${new Array(rem).fill(ONE_ROW_PLACEHOLDER).join(',')}`);
      const rp = [];
      for (; i < n; i++) { const r = rows[i]; for (let k = 0; k < COLS; k++) rp.push((blank && k === rawJsonIdx) ? '' : r[k]); }
      stmtRem.run(...rp);
    }
  }
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  const cnt = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
  db.close();
  return { ms, cnt };
}

async function main() {
  const fixtureArg = process.argv[2];
  const filePath = fixtureArg
    ? path.resolve(fixtureArg)
    : path.resolve(__dirname, '..', '..', 'tmp', 'poc-acquiring-flow-500000.xlsx');
  if (!fs.existsSync(filePath)) { console.error('fixture 不存在：' + filePath); process.exit(1); }

  console.log(`Node ${process.version}  gc=${global.gc ? 'on' : 'off'}`);
  console.log(`[insert-isolated] 解析 fixture 到内存：${path.basename(filePath)} ...`);
  const tp = performance.now();
  const rows = await parseToMemory(filePath);
  console.log(`[insert-isolated] 解析完成：${rows.length} 行，耗时 ${((performance.now() - tp) / 1000).toFixed(1)}s（此段不计入对比）`);

  const strategies = [
    ['S0 逐行 prepared（现状）', { batch: 1 }],
    ['S1 逐行 prepared + raw_json=空（Opt-A 上界）', { batch: 1, blankRawJson: true }],
    ['S2 批量 500/批', { batch: 500 }],
    ['S3 批量 1000/批', { batch: 1000 }],
    ['S4 批量 500/批 + raw_json=空（Opt-C）', { batch: 500, blankRawJson: true }]
  ];

  // 每策略跑 2 次取较优（抵消首次 JIT / 缓存抖动）
  const results = [];
  for (const [label, st] of strategies) {
    const r1 = timeInsert(rows, st);
    const r2 = timeInsert(rows, st);
    const best = Math.min(r1.ms, r2.ms);
    if (r1.cnt !== rows.length) console.log(`  ⚠️ ${label} 入库数 ${r1.cnt} ≠ ${rows.length}`);
    results.push({ label, ms: best });
  }

  const base = results[0].ms;
  console.log(`\n--- insert 段隔离对比（${rows.length} 行，临时 sqlite 事务内，含 UNIQUE + 2 索引）---`);
  for (const r of results) {
    const delta = ((1 - r.ms / base) * 100);
    const sign = delta >= 0 ? '省' : '慢';
    console.log(`${r.label.padEnd(44)} : ${r.ms.toFixed(0).padStart(7)} ms   ${sign} ${Math.abs(delta).toFixed(1)}%   (${(rows.length / (r.ms / 1000)).toFixed(0)} 行/秒)`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
