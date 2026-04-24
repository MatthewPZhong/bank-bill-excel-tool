#!/usr/bin/env node
/* eslint-disable no-console */
// 导出 writer 端到端：single + aggregate，验证新 sheet/列/行结构
// v2.0.0-beta.2 changed 展开：每 pair → 2 行（before/after），新增 pair_id/change_side/changed_fields；
// compareFields 含"金额"→ 末列 金额_diff；含"pending资金类型"→ 新 sheet "pending资金类型差异"

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

  // 基础数据集
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

  // === T1: 单月导出基础 ===
  console.log('[T1] exportSingleRun — changed 双行展开 + 新列 + 金额_diff');
  {
    const out = path.join(TMP, 'single.xlsx');
    const r = writer.exportSingleRun(db, reconcileResult.runId, out);
    check('status=success', r.status === 'success');
    // changed 展成 2 行 → 总行 = new(1) + missing(1) + changed(1×2) = 4
    check('rowCount = 4 (new 1 + missing 1 + changed 2 行)', r.rowCount === 4, `got ${r.rowCount}`);
    check('file 存在', fs.existsSync(out));

    const wb = XLSX.readFile(out);
    check('有 汇总 sheet', wb.SheetNames.includes('汇总'));
    // A005(new/充值), A003(missing/充值), A002×2(changed/退票) → 充值 2 行 / 退票 2 行
    check('有 充值 sheet', wb.SheetNames.includes('充值'));
    check('有 退票 sheet', wb.SheetNames.includes('退票'));
    // 无 pending资金类型差异 sheet（compareFields 不含）
    check('无 pending资金类型差异 sheet', !wb.SheetNames.includes('pending资金类型差异'));
    check('共 3 sheet (汇总 + 充值 + 退票)', wb.SheetNames.length === 3, `got ${wb.SheetNames.length}: ${wb.SheetNames.join(',')}`);

    // 汇总 sheet header 列数 = 31 + diff_type + pair_id + change_side + changed_fields + 金额_before + 金额_after + 金额_diff = 38
    const summarySheet = wb.Sheets['汇总'];
    const aoa = XLSX.utils.sheet_to_json(summarySheet, { header: 1, defval: '' });
    check('汇总 header 列数 = 38', aoa[0].length === 38, `got ${aoa[0].length}`);
    check('汇总有 5 行（header+4）', aoa.length === 5, `got ${aoa.length}`);
    check('header[31] = diff_type', aoa[0][31] === 'diff_type');
    check('header[32] = pair_id', aoa[0][32] === 'pair_id');
    check('header[33] = change_side', aoa[0][33] === 'change_side');
    check('header[34] = changed_fields', aoa[0][34] === 'changed_fields');
    check('header[35] = 金额_before', aoa[0][35] === '金额_before');
    check('header[36] = 金额_after', aoa[0][36] === '金额_after');
    // 金额 也进了 diff 末尾列
    check('含 金额_diff 列', aoa[0].includes('金额_diff'));
    const diffColIdx = aoa[0].indexOf('金额_diff');

    // changed 两行：A002 upper(200) + A002 lower(250)
    const changedRows = aoa.slice(1).filter((r2) => r2[31] === 'changed');
    check('changed 展开为 2 行', changedRows.length === 2, `got ${changedRows.length}`);
    const beforeRow = changedRows.find((r2) => r2[33] === 'before');
    const afterRow = changedRows.find((r2) => r2[33] === 'after');
    check('有 before 行', !!beforeRow);
    check('有 after 行', !!afterRow);
    if (beforeRow && afterRow) {
      check('两行共享 pair_id', beforeRow[32] === afterRow[32] && /^\d+_\d+$/.test(beforeRow[32]));
      check('两行共享 changed_fields = 金额', beforeRow[34] === '金额' && afterRow[34] === '金额');
      check('before 金额_before=200 / 金额_after=250', String(beforeRow[35]) === '200' && String(beforeRow[36]) === '250');
      check('after 金额_before=200 / 金额_after=250', String(afterRow[35]) === '200' && String(afterRow[36]) === '250');
      check('before 金额_diff = 50', Number(beforeRow[diffColIdx]) === 50, `got ${beforeRow[diffColIdx]}`);
      check('after 金额_diff = 50', Number(afterRow[diffColIdx]) === 50);
      // 主行快照差异：before = upper(200)；after = lower(250)
      const amountIdx = PENDING_COLUMNS.indexOf('金额');
      check('before 主行 金额=200（upper 快照）', String(beforeRow[amountIdx]) === '200');
      check('after 主行 金额=250（lower 快照）', String(afterRow[amountIdx]) === '250');
    }

    // new / missing 行：pair_id / change_side / changed_fields / 金额_diff 全空
    const newRow = aoa.slice(1).find((r2) => r2[31] === 'new');
    const missingRow = aoa.slice(1).find((r2) => r2[31] === 'missing');
    check('new 行 pair_id 为空', !!newRow && newRow[32] === '');
    check('new 行 change_side 为空', !!newRow && newRow[33] === '');
    check('new 行 changed_fields 为空', !!newRow && newRow[34] === '');
    check('new 行 金额_before / 金额_after / 金额_diff 全空',
      !!newRow && newRow[35] === '' && newRow[36] === '' && newRow[diffColIdx] === '');
    check('missing 行 pair_id 为空', !!missingRow && missingRow[32] === '');
    check('missing 行 金额_diff 为空', !!missingRow && missingRow[diffColIdx] === '');
  }

  // === T2: exportAggregate 多 run + 并集 ===
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
    check('runsCount = 2', r.runsCount === 2, `got ${r.runsCount}`);

    const wb = XLSX.readFile(out);
    check('有 按月维度区别汇总 sheet', wb.SheetNames.includes('按月维度区别汇总'));
    check('有 汇总 sheet', wb.SheetNames.includes('汇总'));
    check('无 pending资金类型差异 sheet（并集不含）', !wb.SheetNames.includes('pending资金类型差异'));
    check('共 2 sheet', wb.SheetNames.length === 2);
  }

  // === T3: compareFields 含 pending资金类型 → 资金类型差异 sheet（空） ===
  console.log('[T3] compareFields 含 pending资金类型 → 专门 sheet（无变更时空表）');
  {
    const out = path.join(TMP, 'single-with-fundtype-cf-empty.xlsx');
    const res = engine.runReconciliation(db, {
      upperMonth: '2026-09',
      lowerMonth: '2026-10',
      rule: { matchFields: ['order_no'], compareFields: ['金额', 'pending资金类型'] }
    });
    const r = writer.exportSingleRun(db, res.runId, out);
    check('status=success', r.status === 'success');
    check('fundTypeDiffRowCount = 0（A002 资金类型未变）', r.fundTypeDiffRowCount === 0);
    const wb = XLSX.readFile(out);
    check('有 pending资金类型差异 sheet', wb.SheetNames.includes('pending资金类型差异'));
    const ws = wb.Sheets['pending资金类型差异'];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    check('空表（仅 header）', aoa.length === 1);
  }

  // === T4: pending资金类型差异 sheet 有内容 ===
  console.log('[T4] changed pair 的资金类型不同 → 资金类型差异 sheet 收录');
  {
    // 新建两月，A002 资金类型从 提现 → 退票
    insertRows(db, '2026-11', [
      sampleRow({ orderNo: 'A002', amount: '200', currency: 'USD', fundType: '提现' })
    ]);
    insertRows(db, '2026-12', [
      sampleRow({ orderNo: 'A002', amount: '200', currency: 'USD', fundType: '退票' })
    ]);
    const res = engine.runReconciliation(db, {
      upperMonth: '2026-11',
      lowerMonth: '2026-12',
      rule: { matchFields: ['order_no'], compareFields: ['pending资金类型'] }
    });
    const out = path.join(TMP, 'single-fundtype-diff.xlsx');
    const r = writer.exportSingleRun(db, res.runId, out);
    check('status=success', r.status === 'success');
    check('fundTypeDiffRowCount = 2（一对 changed 展成两行）', r.fundTypeDiffRowCount === 2, `got ${r.fundTypeDiffRowCount}`);
    const wb = XLSX.readFile(out);
    check('有 pending资金类型差异 sheet', wb.SheetNames.includes('pending资金类型差异'));
    const ws = wb.Sheets['pending资金类型差异'];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    check('表体 = 1 header + 2 data', aoa.length === 3, `got ${aoa.length}`);
    // before 行主行资金类型=提现；after 行主行资金类型=退票（PENDING_COLUMNS.indexOf pending资金类型 位置）
    const fundIdx = PENDING_COLUMNS.indexOf('pending资金类型');
    const rows = aoa.slice(1);
    const beforeR = rows.find((r2) => r2[33] === 'before');
    const afterR = rows.find((r2) => r2[33] === 'after');
    check('before 行主行资金类型 = 提现', !!beforeR && String(beforeR[fundIdx]) === '提现');
    check('after 行主行资金类型 = 退票', !!afterR && String(afterR[fundIdx]) === '退票');
  }

  db.close();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nTotal: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
