#!/usr/bin/env node
/* eslint-disable no-console */
// 导出 writer 端到端：single + aggregate 两种模式，验证 sheet 结构 + 列 + 行

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PENDING_COLUMNS = require('../src/backend/pending-db/columns');
const { openPendingDb } = require('../src/backend/pending-db');
const monthRepo = require('../src/backend/pending-db/month-repository');
const engine = require('../src/backend/pending-reconcile/engine');
const writer = require('../src/backend/pending-export/writer');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-export-test-'));

function sampleRow({ orderNo, amount, currency, fundType = '提现' }) {
  const row = new Array(PENDING_COLUMNS.length).fill('');
  row[PENDING_COLUMNS.indexOf('order_no')] = orderNo;
  row[PENDING_COLUMNS.indexOf('金额')] = amount;
  row[PENDING_COLUMNS.indexOf('币种')] = currency;
  row[PENDING_COLUMNS.indexOf('pending资金类型')] = fundType;
  return row;
}

function insertRows(db, yearMonth, rows) {
  const insertRow = monthRepo.createRowInserter(db);
  db.exec('BEGIN');
  rows.forEach((r, i) => insertRow(yearMonth, `hash-${yearMonth}-${i}`, r));
  monthRepo.upsertMonthMeta(db, { yearMonth, rowCount: rows.length, sourceFiles: [] });
  db.exec('COMMIT');
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓', name); pass += 1; }
  else { console.log('  ✗', name, detail ? `— ${detail}` : ''); fail += 1; }
}

try {
  const db = openPendingDb(TMP);

  // 基础数据集（与 reconcile test 相同样本）
  insertRows(db, '2026-09', [
    sampleRow({ orderNo: 'A001', amount: '100', currency: 'USD', fundType: '提现' }),
    sampleRow({ orderNo: 'A002', amount: '200', currency: 'CNY', fundType: '退票' }),
    sampleRow({ orderNo: 'A003', amount: '300', currency: 'HKD', fundType: '充值' })
  ]);
  insertRows(db, '2026-10', [
    sampleRow({ orderNo: 'A001', amount: '100', currency: 'USD', fundType: '提现' }),
    sampleRow({ orderNo: 'A002', amount: '250', currency: 'CNY', fundType: '退票' }),
    sampleRow({ orderNo: 'A005', amount: '500', currency: 'HKD', fundType: '充值' })
  ]);

  const rule = { matchFields: ['order_no'], compareFields: ['金额'] };
  const reconcileResult = engine.runReconciliation(db, {
    upperMonth: '2026-09',
    lowerMonth: '2026-10',
    rule
  });

  // === T1: 单月导出 ===
  console.log('[T1] exportSingleRun 基础检查');
  {
    const out = path.join(TMP, 'single.xlsx');
    const r = writer.exportSingleRun(db, reconcileResult.runId, out);
    check('status=success', r.status === 'success');
    check('rowCount = 3 (new 1 + missing 1 + changed 1)', r.rowCount === 3);
    check('file 存在', fs.existsSync(out));

    const wb = XLSX.readFile(out);
    // Sheet1 汇总 + 按 fund_type 分组（提现/退票/充值 3 种）
    check('有汇总 sheet', wb.SheetNames.includes('汇总'));
    // 差异 3 行的 fund_type 分布: A005(new/充值), A003(missing/充值), A002(changed/退票)
    // 按 fund_type 分组 → 充值(2) / 退票(1) → 3 个 sheet (汇总 + 充值 + 退票)
    check('有 充值 sheet', wb.SheetNames.includes('充值'));
    check('有 退票 sheet', wb.SheetNames.includes('退票'));
    check('共 3 sheet (汇总 + 充值 + 退票)', wb.SheetNames.length === 3, `got ${wb.SheetNames.length}: ${wb.SheetNames.join(',')}`);

    // 汇总 sheet 列结构：31 原列 + diff_type + 金额_before + 金额_after = 34 列
    const summarySheet = wb.Sheets['汇总'];
    const aoa = XLSX.utils.sheet_to_json(summarySheet, { header: 1, defval: '' });
    check('汇总有 4 行（header+3）', aoa.length === 4);
    check('汇总 header 列数 = 34', aoa[0].length === 34);
    check('汇总 header[31] = diff_type', aoa[0][31] === 'diff_type');
    check('汇总 header[32] = 金额_before', aoa[0][32] === '金额_before');
    check('汇总 header[33] = 金额_after', aoa[0][33] === '金额_after');

    // 找 changed 行：diff_type=changed，before=200，after=250
    const changedRow = aoa.slice(1).find((r2) => r2[31] === 'changed');
    check('changed 行存在', !!changedRow);
    if (changedRow) {
      check('changed 金额_before = 200', String(changedRow[32]) === '200');
      check('changed 金额_after = 250', String(changedRow[33]) === '250');
    }

    // new / missing 行：_before / _after 为空
    const newRow = aoa.slice(1).find((r2) => r2[31] === 'new');
    const missingRow = aoa.slice(1).find((r2) => r2[31] === 'missing');
    check('new row _before/_after 为空', !!newRow && newRow[32] === '' && newRow[33] === '');
    check('missing row _before/_after 为空', !!missingRow && missingRow[32] === '' && missingRow[33] === '');
  }

  // === T2: 汇总导出（再跑一个对 2026-08 vs 2026-09）===
  console.log('[T2] exportAggregate 多 run 聚合');
  {
    insertRows(db, '2026-08', [
      sampleRow({ orderNo: 'B001', amount: '10', currency: 'USD', fundType: '提现' })
    ]);
    engine.runReconciliation(db, {
      upperMonth: '2026-08', lowerMonth: '2026-09',
      rule: { matchFields: ['order_no'], compareFields: ['金额'] }
    });

    const out = path.join(TMP, 'aggregate.xlsx');
    const r = writer.exportAggregate(db, out);
    check('status=success', r.status === 'success');
    check('runsCount = 2 (2026-09 vs 2026-08 + 2026-10 vs 2026-09)', r.runsCount === 2, `got ${r.runsCount}`);

    const wb = XLSX.readFile(out);
    check('有 按月维度区别汇总 sheet', wb.SheetNames.includes('按月维度区别汇总'));
    check('有 汇总 sheet', wb.SheetNames.includes('汇总'));
    check('共 2 sheet', wb.SheetNames.length === 2);
  }

  db.close();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nTotal: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
