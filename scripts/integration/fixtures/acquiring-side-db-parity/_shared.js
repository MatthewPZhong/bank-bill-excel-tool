// 收单 per-month 侧库迁移 — parity 共享模块（fixture 造法 + 确定性 dump）🔴🔴 资金红线
//
// 设计：golden 采集脚本（改造前 HEAD）与 parity 集成脚本（改造后）共用同一 fixture 与同一 dump 逻辑，
//   保证「同输入 → 同 dump」逐字段可比。golden 一旦在干净工作树采得即冻结（golden.json），
//   改造完成后集成脚本跑同 fixture 与 golden byte-for-byte 断言（AC3-1 放行闸）。
//
// 三类 case（PRD §5.3.1 / spec §B.8.1 要求）：
//   case1 多币种 + 差异行（含负数/小写/带空格币种归一/流水空币种 mismatch）
//   case2 全一致（零差异行边界 — diff_rows 应为空）
//   case3 空流水边界（flow 表为空 → runCheck 应抛「流水表尚未导入」，不产 run）
//
// dump 口径（业务数据层 byte-for-byte，规避 xlsx 时间戳/水印非确定字段）：
//   - runsSummary：{ totalBillRows, matchedRows, mismatchRows, unmatchedRows, status }
//   - diffRows：writer 真正消费的数据源 listAllDiffRowsByRun（含 bill raw_json / source_file /
//               source_row_index / flow_currency / flow_amount_abs / diff_type），逐行 ORDER BY source_file,source_row_index
//   - diffRowCount：diff_rows 行数
//   - diffSheetData：解析生成的 diff.xlsx 各「数据 sheet」逐行 cell 值（剥末尾「运行结果汇总」sheet —
//                    汇总 sheet 含运行时间/耗时/水印等非确定字段，不纳入 byte-for-byte）

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { FLOW_HEADERS, BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');

// flow 行：48 列；订单视角列(12/13)留底，通道清算列(28/29)对账用
function makeFlow(reconMainId, billDate, settleAmount, settleCurrency) {
  const r = new Array(48).fill('');
  r[0] = billDate;
  r[6] = reconMainId;
  r[12] = String(settleAmount);
  r[13] = settleCurrency;
  r[28] = String(settleAmount);
  r[29] = settleCurrency;
  return r;
}

// bill 行：26 列；主对账Id(14) / 对账金额(18) / 对账币种(19)
function makeBill(reconMainId, billDate, amount, currency) {
  const r = new Array(26).fill('');
  r[0] = billDate;
  r[14] = reconMainId;
  r[18] = String(amount);
  r[19] = currency;
  return r;
}

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers.slice());
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

// 在 tmpdir 内生成三类 case 的 xlsx 文件，返回各 case 的文件路径与 monthKey。
async function buildFixtures(tmpdir) {
  const d1 = '2026-03-01';
  const d2 = '2026-03-15';

  // ── case1：多币种 + 差异行 ──
  const c1FlowA = path.join(tmpdir, 'c1-flowA.xlsx');
  const c1FlowB = path.join(tmpdir, 'c1-flowB.xlsx');
  const c1BillA = path.join(tmpdir, 'c1-billA.xlsx');
  await writeXlsx(c1FlowA, FLOW_HEADERS, [
    makeFlow('M1', d1, '10.50', 'USD'),
    makeFlow('M2', d1, '-20', 'usd'),    // 负数 + 小写币种
    makeFlow('M3', d2, '30', ' EUR ')    // 带空格币种（归一后 eur）
  ]);
  await writeXlsx(c1FlowB, FLOW_HEADERS, [
    makeFlow('M4', d1, '', ''),          // 空金额空币种（非清算流水子类型）
    makeFlow('M5', d2, '50.00', 'CNY')
  ]);
  await writeXlsx(c1BillA, BILL_HEADERS, [
    makeBill('M1', d1, '10.50', 'usd'),  // 币种一致（归一） → 非差异
    makeBill('M2', d1, '20', 'EUR'),     // 币种差异 → currency_mismatch
    makeBill('M3', d2, '30', 'EUR'),     // 一致（归一） → 非差异
    makeBill('M4', d1, '10', 'CNY'),     // 流水空币种 vs 单据有 → currency_mismatch
    makeBill('M5', d2, '50', 'CNY')      // 一致 → 非差异
  ]);

  // ── case2：全一致（零差异行边界） ──
  const c2Flow = path.join(tmpdir, 'c2-flow.xlsx');
  const c2Bill = path.join(tmpdir, 'c2-bill.xlsx');
  await writeXlsx(c2Flow, FLOW_HEADERS, [
    makeFlow('A1', d1, '100', 'USD'),
    makeFlow('A2', d1, '200', 'EUR')
  ]);
  await writeXlsx(c2Bill, BILL_HEADERS, [
    makeBill('A1', d1, '100', 'usd'),    // 归一一致
    makeBill('A2', d1, '200', 'eur')     // 归一一致
  ]);

  // ── case3：空流水边界（仅导入 bill，不导 flow） ──
  const c3Bill = path.join(tmpdir, 'c3-bill.xlsx');
  await writeXlsx(c3Bill, BILL_HEADERS, [
    makeBill('B1', d1, '100', 'USD')
  ]);

  return {
    case1: { monthKey: '2026-03', flow: [c1FlowA, c1FlowB], bill: [c1BillA] },
    case2: { monthKey: '2026-03', flow: [c2Flow], bill: [c2Bill] },
    case3: { monthKey: '2026-03', bill: [c3Bill] } // 无 flow
  };
}

// 确定性 dump 一个 run 的业务数据（侧库或主库的 db 实例 + runRepo）。
//   runId 为 null（case3 无 run）时返回 { runsSummary:null, diffRows:[], diffRowCount:0 }
function dumpRunBusinessData(db, runRepo, runId) {
  if (runId === null || runId === undefined) {
    return { runsSummary: null, diffRows: [], diffRowCount: 0 };
  }
  const run = runRepo.getRunById(db, runId);
  const runsSummary = run ? {
    totalBillRows: run.total_bill_rows,
    matchedRows: run.matched_rows,
    mismatchRows: run.mismatch_rows,
    unmatchedRows: run.unmatched_rows,
    status: run.status
  } : null;
  // writer 真正消费的数据源（含 bill raw_json）— byte-for-byte 差异表内容基准
  const diffRows = runRepo.listAllDiffRowsByRun(db, { runId });
  return { runsSummary, diffRows, diffRowCount: diffRows.length };
}

// 解析生成的 diff.xlsx，dump 各「数据 sheet」逐行 cell 值（剥末尾「运行结果汇总」sheet）。
//   汇总 sheet 含运行时间/耗时/水印 commit/version 等非确定字段，不纳入 byte-for-byte。
async function dumpDiffXlsxDataSheets(diffFilePath) {
  if (!diffFilePath || !fs.existsSync(diffFilePath)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(diffFilePath);
  const sheets = [];
  wb.eachSheet((ws) => {
    // 「运行结果汇总」sheet 名固定（writer fix13）；跳过
    if (ws.name === '运行结果汇总') return;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      // row.values 是 1-based 稀疏数组；归一为字符串数组（剥首位 undefined）
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (const v of vals) cells.push(v === null || v === undefined ? '' : String(v));
      rows.push(cells);
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

module.exports = {
  makeFlow,
  makeBill,
  writeXlsx,
  buildFixtures,
  dumpRunBusinessData,
  dumpDiffXlsxDataSheets,
};
