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

  // === T5: aggregate 下 run 规则独立 — Codex Finding 1 回归 ===
  // 两个 run 规则不同：run A compareFields=[金额]，run B compareFields=[币种]
  // 并集 = [金额, 币种]
  // 期望：run A 的行 → 币种_before/after/changed_fields 里不出现"币种"；run B 反之
  //       即不能因为并集就越权重新比对
  console.log('[T5] aggregate：run 规则独立 — 不跨 run 重算 compareFields（Codex Finding 1）');
  {
    // 用两组新月份避免污染 T1/T2/T4 状态
    insertRows(db, '2026-05', [sampleRow({ orderNo: 'X001', amount: '100', currency: 'USD', fundType: '提现' })]);
    insertRows(db, '2026-06', [sampleRow({ orderNo: 'X001', amount: '100', currency: 'CNY', fundType: '提现' })]);
    // run A：compareFields=[金额]，金额无变化 → changed=0
    engine.runReconciliation(db, {
      upperMonth: '2026-05', lowerMonth: '2026-06',
      rule: { matchFields: ['order_no'], compareFields: ['金额'] }
    });
    insertRows(db, '2026-07', [sampleRow({ orderNo: 'Y001', amount: '200', currency: 'USD', fundType: '提现' })]);
    // 删除 X001 以避免 Y001 的测试干扰（或用独立数据）
    insertRows(db, '2027-01', [sampleRow({ orderNo: 'Z001', amount: '500', currency: 'USD', fundType: '提现' })]);
    insertRows(db, '2027-02', [sampleRow({ orderNo: 'Z001', amount: '500', currency: 'EUR', fundType: '提现' })]);
    // run B：compareFields=[币种]，币种变 USD→EUR → changed=1
    engine.runReconciliation(db, {
      upperMonth: '2027-01', lowerMonth: '2027-02',
      rule: { matchFields: ['order_no'], compareFields: ['币种'] }
    });

    const out = path.join(TMP, 'aggregate-run-independence.xlsx');
    const r = writer.exportAggregate(db, out);
    check('aggregate status=success', r.status === 'success');

    const wb = XLSX.readFile(out);
    const flat = XLSX.utils.sheet_to_json(wb.Sheets['汇总'], { header: 1, defval: '' });
    const header = flat[0];
    const diffTypeIdx = header.indexOf('diff_type');
    const changedFieldsIdx = header.indexOf('changed_fields');
    const jinE_beforeIdx = header.indexOf('金额_before');
    const jinE_afterIdx = header.indexOf('金额_after');
    const biZhong_beforeIdx = header.indexOf('币种_before');
    const biZhong_afterIdx = header.indexOf('币种_after');

    // 找 Z001 的 changed 行（run B, compareFields=[币种]）
    const dataRows = flat.slice(1);
    const z001Changed = dataRows.filter((r2) => {
      if (r2[diffTypeIdx] !== 'changed') return false;
      const idx = PENDING_COLUMNS.indexOf('order_no');
      return r2[idx] === 'Z001';
    });
    check('Z001 changed 展 2 行', z001Changed.length === 2);
    if (z001Changed.length >= 1) {
      const z = z001Changed[0];
      check('Z001 changed_fields = "币种"（不含金额，即使并集有金额列）',
        z[changedFieldsIdx] === '币种', `got "${z[changedFieldsIdx]}"`);
      // run B 不比对金额 → 金额_before/after 必须为空（即使 run A 用金额，两 run 独立）
      check('Z001 金额_before 留空（run B 没配金额）', z[jinE_beforeIdx] === '', `got "${z[jinE_beforeIdx]}"`);
      check('Z001 金额_after 留空（run B 没配金额）', z[jinE_afterIdx] === '', `got "${z[jinE_afterIdx]}"`);
      // 币种 字段正常填
      check('Z001 币种_before = USD', String(z[biZhong_beforeIdx]) === 'USD');
      check('Z001 币种_after = EUR', String(z[biZhong_afterIdx]) === 'EUR');
    }
  }

  // === T6: Codex Finding 2 — 覆盖导入清理 orphan diff_runs ===
  // deleteMonth 不仅删 pending_rows，还要级联删涉及该月的 diff_runs/diff_rows
  console.log('[T6] deleteMonth 级联清理 diff_runs/diff_rows（Codex Finding 2）');
  {
    const diffRepo = require('../src/backend/pending-db/diff-repository');
    const monthRepoReq = require('../src/backend/pending-db/month-repository');
    // 前置：DB 里 2026-05/2026-06/2027-01/2027-02 的 run 都还在
    const runsBeforeDelete = diffRepo.listAllRuns(db);
    const runsInvolving2026_06 = runsBeforeDelete.filter((rn) =>
      rn.upperMonth === '2026-06' || rn.lowerMonth === '2026-06');
    check('删前：有涉及 2026-06 的 run', runsInvolving2026_06.length >= 1);

    // 删除 2026-06
    monthRepoReq.deleteMonth(db, '2026-06');

    // 验证：pending_rows + pending_months 都清了
    const remainRows = db.prepare('SELECT COUNT(*) AS n FROM pending_rows WHERE year_month = ?').get('2026-06').n;
    check('pending_rows 2026-06 已删', remainRows === 0);
    const remainMeta = monthRepoReq.getMonthMeta(db, '2026-06');
    check('pending_months 2026-06 已删', remainMeta === null);
    // 验证：涉及 2026-06 的 run 也删掉了
    const runsAfter = diffRepo.listAllRuns(db);
    const runsInvolving2026_06_after = runsAfter.filter((rn) =>
      rn.upperMonth === '2026-06' || rn.lowerMonth === '2026-06');
    check('涉及 2026-06 的 run 级联删除', runsInvolving2026_06_after.length === 0);
    // 验证：其他月份的 run 没被误删
    const run27 = runsAfter.find((rn) => rn.lowerMonth === '2027-02');
    check('2027-01/02 的 run 未被误删', !!run27);
    // 验证：orphan diff_rows 也清了（run_id 找不到对应 run）
    const orphanRows = db.prepare(`
      SELECT COUNT(*) AS n FROM diff_rows
      WHERE run_id NOT IN (SELECT id FROM diff_runs)
    `).get().n;
    check('无 orphan diff_rows', orphanRows === 0);
  }

  db.close();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nTotal: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
