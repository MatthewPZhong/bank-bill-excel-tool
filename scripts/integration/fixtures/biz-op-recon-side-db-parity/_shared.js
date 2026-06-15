// biz-op-recon per-month 侧库迁移 — parity 共享模块（fixture 造法 + 确定性 dump）🔴🔴 资金红线
//
// 设计：golden 采集脚本（改造前）与 parity 集成脚本（改造后）共用同一 fixture 与同一 dump 逻辑。
//   biz-op runReconciliation 在「侧库 db 句柄」上运行 = 在主库上运行（4 步算法同库自洽）；本模块 dump
//   对账产出的确定性差异行（diff_rows 逐行，按 source_table+account_no 排序规避自增 id）+ 导出 xlsx 数据 sheet。
//
// 覆盖（spec §5.2 4 步算法）：
//   - 1:1 一致（不进 diff）/ 金额差异（进 diff cmp_amount='不相等'）
//   - T-1 有 T-2 无（cmp_t2='T-1有T-2无'）/ T-2 有 T-1 无（cmp_t2='T-2有T-1无'）
//   - 同账户号多 OP（multi_op_flag='是'，相等行也进 diff）
//   - T-2 end_balance NaN silent drop（t2AnomalyAccountCount > 0）
//
// dump 口径：
//   - runSummary：insertRun 落库的 stats（t1OpTotal/t2OpTotal/flowTotal/amountDiffCount/multiOpAccountCount/
//     t2AnomalyAccountCount/t1NotT2Count/t2NotT1Count）
//   - diffRows：getDiffRowsByRun → 每行 { source_table, account_no(经 getRowById), cmp_t2, multi_op_flag, cmp_amount, amount_diff }
//     按 (source_table, account_no, cmp_t2) 排序（确定性，与自增 id / run_at 无关）
//   - diffSheetData：导出单日 diff.xlsx 数据 sheet 逐行 cell（剥水印；行序由 writer 决定）

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { BIZ_OP_DB_COLUMNS, FLOW_DB_COLUMNS } = require('../../../../src/backend/biz-op-recon-db/columns');

// 业务OP reader 风格行（满足双重校验：amount=in-out, end=begin+amount）。
function makeBizOp({ rowIndex, bu, account, begin, amtIn, amtOut, end, billDate }) {
  const amount = amtIn - amtOut;
  const row = { _rowIndex: rowIndex };
  for (const c of BIZ_OP_DB_COLUMNS) row[c] = '';
  row.bu_name = bu;
  row.account_no = account;
  row.begin_balance = String(begin);
  row.amount = String(amount);
  row.amount_in = String(amtIn);
  row.amount_out = String(amtOut);
  row.end_balance = end === null ? '' : String(end);  // null → 空 → NaN（silent drop 场景）
  row.bill_date_raw = billDate || '';
  return row;
}

// 流水 reader 风格行（direction ∈ 入/出；recon_amount 数值；account_no 非空）。
function makeFlow({ rowIndex, bu, account, direction, amount }) {
  const row = { _rowIndex: rowIndex };
  for (const c of FLOW_DB_COLUMNS) row[c] = '';
  row.bu_dept = bu;
  row.account_no = account;
  row.direction = direction;          // 入 / 出
  row.recon_amount = String(amount);
  return row;
}

// 单 BU 同日核对 fixture（date=T-1，t2Date=T-2）。
//   场景：
//     ACC1：T-2 期末 1000 + flow 入 100 = 计算 1100；T-1 实际 1100 → 一致（不进 diff）
//     ACC2：T-2 期末 2000 + flow 出 50 = 计算 1950；T-1 实际 1900 → 金额差异 50（进 diff '不相等'）
//     ACC3：T-1 有（实际 300）、T-2 无 → cmp_t2='T-1有T-2无'
//     ACC4：T-2 有、T-1 无 → cmp_t2='T-2有T-1无'
//     ACC5：T-1 同账户号 2 行（multi_op_flag='是'，相等行也进 diff）；T-2 期末 500 + flow 入 0 = 500
//     ACC6：T-2 期末 NaN（end_balance 空）→ silent drop（t2AnomalyAccountCount+1）
function buildSingleDayFixture(date, t2Date, bu) {
  // T-1 业务OP（data_date=date）
  const t1 = [
    makeBizOp({ rowIndex: 2, bu, account: 'ACC1', begin: 1000, amtIn: 100, amtOut: 0, end: 1100, billDate: date }),
    makeBizOp({ rowIndex: 3, bu, account: 'ACC2', begin: 1950, amtIn: 0, amtOut: 50, end: 1900, billDate: date }),
    makeBizOp({ rowIndex: 4, bu, account: 'ACC3', begin: 0, amtIn: 300, amtOut: 0, end: 300, billDate: date }),
    makeBizOp({ rowIndex: 5, bu, account: 'ACC5', begin: 500, amtIn: 0, amtOut: 0, end: 500, billDate: date }),
    makeBizOp({ rowIndex: 6, bu, account: 'ACC5', begin: 500, amtIn: 0, amtOut: 0, end: 500, billDate: date }),  // 多 OP
    makeBizOp({ rowIndex: 7, bu, account: 'ACC6', begin: 0, amtIn: 700, amtOut: 0, end: 700, billDate: date })   // T-1 有（T-2 NaN）
  ];
  // T-2 业务OP（data_date=t2Date）
  const t2 = [
    makeBizOp({ rowIndex: 2, bu, account: 'ACC1', begin: 900, amtIn: 100, amtOut: 0, end: 1000, billDate: t2Date }),
    makeBizOp({ rowIndex: 3, bu, account: 'ACC2', begin: 1800, amtIn: 200, amtOut: 0, end: 2000, billDate: t2Date }),
    makeBizOp({ rowIndex: 4, bu, account: 'ACC4', begin: 0, amtIn: 400, amtOut: 0, end: 400, billDate: t2Date }),  // T-2 有 T-1 无
    makeBizOp({ rowIndex: 5, bu, account: 'ACC5', begin: 0, amtIn: 500, amtOut: 0, end: 500, billDate: t2Date }),
    makeBizOp({ rowIndex: 6, bu, account: 'ACC6', begin: 0, amtIn: 0, amtOut: 0, end: null, billDate: t2Date })   // T-2 NaN → silent drop
  ];
  // flow（data_date=date）
  const flow = [
    makeFlow({ rowIndex: 2, bu, account: 'ACC1', direction: '入', amount: 100 }),
    makeFlow({ rowIndex: 3, bu, account: 'ACC2', direction: '出', amount: 50 }),
    makeFlow({ rowIndex: 4, bu, account: 'ACC5', direction: '入', amount: 0 })
  ];
  return { date, t2Date, bu, t1, t2, flow };
}

// 确定性 dump 一个 run 的差异数据（侧库或主库 db + runRepo + importsRepo）。
function dumpRunDiff(db, runRepo, importsRepo, runId) {
  const run = runRepo.getRunById(db, runId);
  const runSummary = run ? {
    status: run.status,
    t1OpTotal: run.t1_op_total,
    t2OpTotal: run.t2_op_total,
    flowTotal: run.flow_total,
    amountDiffCount: run.amount_diff_count,
    multiOpAccountCount: run.multi_op_account_count,
    t2AnomalyAccountCount: run.t2_anomaly_account_count,
    t1NotT2Count: run.t1_not_t2_count,
    t2NotT1Count: run.t2_not_t1_count
  } : null;
  const rawDiff = runRepo.getDiffRowsByRun(db, runId);
  const diffRows = rawDiff.map((dr) => {
    const src = importsRepo.getRowById(db, dr.source_row_id);
    return {
      source_table: dr.source_table,
      account_no: src ? String(src.account_no || '') : `?${dr.source_row_id}`,
      cmp_t2: dr.cmp_t2,
      multi_op_flag: dr.multi_op_flag,
      cmp_amount: dr.cmp_amount,
      amount_diff: dr.amount_diff
    };
  });
  // 确定性排序（规避自增 id / 插入序）
  diffRows.sort((a, b) => {
    if (a.source_table !== b.source_table) return a.source_table < b.source_table ? -1 : 1;
    if (a.account_no !== b.account_no) return a.account_no < b.account_no ? -1 : 1;
    if (a.cmp_t2 !== b.cmp_t2) return a.cmp_t2 < b.cmp_t2 ? -1 : 1;
    return a.amount_diff < b.amount_diff ? -1 : a.amount_diff > b.amount_diff ? 1 : 0;
  });
  return { runSummary, diffRows, diffRowCount: diffRows.length };
}

// 解析导出 diff.xlsx，dump 各数据 sheet 逐行 cell（writer 行序由 account_no 排序，确定性）。
async function dumpDiffXlsx(diffFilePath) {
  if (!diffFilePath || !fs.existsSync(diffFilePath)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(diffFilePath);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(vals.map((v) => (v == null ? '' : String(v))));
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

module.exports = {
  makeBizOp,
  makeFlow,
  buildSingleDayFixture,
  dumpRunDiff,
  dumpDiffXlsx
};
