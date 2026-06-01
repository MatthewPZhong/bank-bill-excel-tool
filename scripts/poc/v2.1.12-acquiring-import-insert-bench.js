// v2.1.12-beta POC(收单导入) — INSERT 段干净 bench：用真实 insertFlowRow + 合成行(on-the-fly,不解析不OOM)
// 隔离「insert+raw_json」段（排除 parse），实测 raw_json 成本 + 批量 INSERT 收益。
// 用法：node scripts/poc/v2.1.12-acquiring-import-insert-bench.js [rows=500000]
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { AppDatabase } = require('../../src/backend/database');
const repo = require('../../src/backend/acquiring-bill-currency-db/import-repository');
const { FLOW_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');
const { normalizeBillDate } = require('../../src/backend/acquiring-bill-currency-import/validator');

const ROWS = parseInt(process.argv[2] || '500000', 10);
const BATCH = 1000;
const COLS = 10; // month_key,source_file,source_row_index,recon_main_id,settle_amount,settle_amount_abs,settle_currency,settle_currency_norm,raw_json,imported_at

// 合成一行 48 列（真实关键列：6=对账主Id 28=通道清算金额 29=通道清算币种 + 填充）
function makeValues(i) {
  const v = new Array(48).fill('');
  v[0] = `2026-03-${String((i % 28) + 1).padStart(2, '0')}`;
  v[6] = `RM${i}`;
  v[28] = (1000 + (i % 9000)) + '.55';
  v[29] = (i % 3 === 0) ? 'USD' : 'CNY';
  for (let c = 1; c < 28; c++) if (v[c] === '') v[c] = `c${c}_${i}`;
  return v;
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-ins-'));
  const db = new AppDatabase(path.join(dir, 't.sqlite'));
  db.init();
  return { db: db.db, dir };
}
function clean(ctx) { try { ctx.db.close(); } catch (_e) {} try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch (_e) {} }

const INSERT_HEAD = `INSERT INTO acquiring_bill_currency_flow_imports
  (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at) VALUES `;

// 组一行的 10 个参数（withRawJson=false 时 raw_json 传空串，隔离 stringify 成本）
function rowParams(i, withRawJson) {
  const values = makeValues(i);
  const reconMainId = String(values[6]).trim();
  const settleAmount = String(values[28]).trim();
  const settleAmountAbs = Math.abs(Number(settleAmount.replace(/,/g, ''))).toString();
  const settleCurrency = String(values[29]).trim();
  const settleCurrencyNorm = settleCurrency.toLowerCase();
  let rawJson = '';
  if (withRawJson) {
    const o = {};
    for (let k = 0; k < FLOW_HEADERS.length; k++) o[FLOW_HEADERS[k]] = values[k] === undefined ? '' : String(values[k]);
    o[FLOW_HEADERS[0]] = normalizeBillDate(o[FLOW_HEADERS[0]]);
    rawJson = JSON.stringify(o);
  }
  return [ '2026-03', 'bench.xlsx', i, reconMainId, settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm, rawJson, '2026-03-01T00:00:00Z' ];
}

function benchPerRow(label, useRealInsertFlowRow, withRawJson) {
  const ctx = freshDb();
  const t0 = performance.now();
  ctx.db.exec('BEGIN');
  if (useRealInsertFlowRow) {
    const stmt = repo.prepareFlowInsert(ctx.db);
    for (let i = 1; i <= ROWS; i++) {
      repo.insertFlowRow(stmt, { monthKey: '2026-03', sourceFile: 'bench.xlsx', row: { rowIndex: i, values: makeValues(i) }, importedAt: '2026-03-01T00:00:00Z' });
    }
  } else {
    const stmt = ctx.db.prepare(INSERT_HEAD + `(${Array(COLS).fill('?').join(',')})`);
    for (let i = 1; i <= ROWS; i++) stmt.run(...rowParams(i, withRawJson));
  }
  ctx.db.exec('COMMIT');
  const ms = performance.now() - t0;
  clean(ctx);
  console.log(`${label.padEnd(34)}: ${(ms / 1000).toFixed(2)} s  (${Math.round(ROWS / (ms / 1000))} 行/秒)`);
  return ms;
}

function benchBatch(label, withRawJson) {
  const ctx = freshDb();
  const t0 = performance.now();
  ctx.db.exec('BEGIN');
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const placeholders = buf.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params = [];
    for (const p of buf) params.push(...p);
    ctx.db.prepare(INSERT_HEAD + placeholders).run(...params);
    buf = [];
  };
  for (let i = 1; i <= ROWS; i++) { buf.push(rowParams(i, withRawJson)); if (buf.length >= BATCH) flush(); }
  flush();
  ctx.db.exec('COMMIT');
  const ms = performance.now() - t0;
  clean(ctx);
  console.log(`${label.padEnd(34)}: ${(ms / 1000).toFixed(2)} s  (${Math.round(ROWS / (ms / 1000))} 行/秒)`);
  return ms;
}

console.log(`\n=== 收单 INSERT 段 bench（${ROWS} 行，排除 parse）===`);
const A = benchPerRow('A 逐行+raw_json(真实insertFlowRow)', true, true);
const B = benchPerRow('B 逐行+无raw_json', false, false);
const C = benchBatch(`C 批量${BATCH}+raw_json`, true);
const D = benchBatch(`D 批量${BATCH}+无raw_json`, false);
console.log('\n--- 拆解 ---');
console.log(`raw_json stringify 成本  ≈ A−(逐行无rawjson) = ${((A - B) / 1000).toFixed(2)} s  (占A ${(((A - B) / A) * 100).toFixed(0)}%)`);
console.log(`批量 INSERT 省(含rawjson) ≈ A−C = ${((A - C) / 1000).toFixed(2)} s  (省 ${(((A - C) / A) * 100).toFixed(0)}%)`);
console.log(`批量+去rawjson 省        ≈ A−D = ${((A - D) / 1000).toFixed(2)} s  (省 ${(((A - D) / A) * 100).toFixed(0)}%)`);
console.log(`\n外推 500万行：A现状≈${(A / 1000 * (5000000 / ROWS)).toFixed(0)}s  C批量≈${(C / 1000 * (5000000 / ROWS)).toFixed(0)}s  D批量去rawjson≈${(D / 1000 * (5000000 / ROWS)).toFixed(0)}s`);
