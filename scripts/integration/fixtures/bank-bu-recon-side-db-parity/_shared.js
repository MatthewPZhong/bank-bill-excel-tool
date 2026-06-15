// bank-bu-recon per-month 侧库迁移 — parity 共享模块（fixture 造法 + 确定性 dump）🔴🔴 资金红线
//
// 设计：golden 采集脚本（改造前）与 parity 集成脚本（改造后）共用同一 fixture 与同一 dump 逻辑。
//   bank-bu runReconciliation 在「侧库 db 句柄」上运行 = 在主库上运行（同库自洽）；本模块 dump
//   对账产出的确定性业务数据（matchedPending/matchedBank 行的 reconciliation key + buDiff 命中 + N:M 异常）
//   + 导出 diff.xlsx 数据 sheet（剥水印/字体非确定字段）。
//
// fixture 覆盖（spec §3.6 四路分类）：
//   月1 2026-03：1:1 一致 + 1:1 buDiff + 1:N（银行侧逐一比 BU）+ N:1（pending 侧逐一比 BU）+ N:M 异常
//   月2 2026-04：跨月汇总用（另一组 1:1 buDiff）
//
// dump 口径：
//   - runSummary：{ pendingTotal, bankTotal, matchedCount, buDiffCount, pendingUnmatched, bankUnmatched, nmAnomalyCount, status }
//   - matchedPendingKeys / matchedBankKeys：matched 行的 reconciliation key（确定性、与自增 id 无关），按 key 排序
//   - buDiffPendingKeys / buDiffBankKeys：buDiff 命中行的 key（id→key 映射后排序）
//   - nmAnomalies：N:M 异常组（key + 数量 + row_index 列表）
//   - diffSheetData：导出 diff.xlsx 各数据 sheet 逐行 cell（剥首列水印影响——本 writer 无水印 sheet，但有 applyWatermark 叠加，逐 cell 取值即可）

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS,
  PENDING_MATCH_KEY_DB_COLUMN,
  BANK_MATCH_KEY_DB_COLUMN
} = require('../../../../src/backend/bank-bu-recon-db/columns');

// Pending 行（20 列）：recon_id(列9 索引8) + finance_bu(列6 索引5) 是对账关键列；其余留底。
function makePending(reconId, financeBu, extra = {}) {
  const r = new Array(20).fill('');
  r[8] = reconId;     // 主对账单号 → recon_id（匹配 key）
  r[5] = financeBu;   // 财务BU → finance_bu（差异字段）
  r[11] = extra.amount != null ? String(extra.amount) : '';  // 金额
  r[12] = extra.currency || '';                              // 币种
  return r;
}

// Bank 行（44 列）：reconciliation_id(列12 索引11) + remark_bu(列29 索引28) 是对账关键列。
function makeBank(reconId, remarkBu, extra = {}) {
  const r = new Array(44).fill('');
  r[11] = reconId;    // ReconciliationId → reconciliation_id（匹配 key）
  r[28] = remarkBu;   // Remark-BU → remark_bu（差异字段）
  r[9] = extra.credit != null ? String(extra.credit) : '';  // Credit Amount
  return r;
}

// reader 输出形态：{ _rowIndex, <dbColumn>: value }。fixture 直接构造 reader 风格 rows（绕过 xlsx 读，
//   因 parity 锁的是「相同 rows 在主库 vs 侧库对账产出一致」，reader 本身不在改造范围）。
function pendingArrayToRow(arr, rowIndex) {
  const { PENDING_GUANLI_DB_COLUMNS } = require('../../../../src/backend/bank-bu-recon-db/columns');
  const row = { _rowIndex: rowIndex };
  PENDING_GUANLI_DB_COLUMNS.forEach((col, i) => { row[col] = arr[i] == null ? '' : String(arr[i]); });
  return row;
}
function bankArrayToRow(arr, rowIndex) {
  const { BANK_DB_COLUMNS } = require('../../../../src/backend/bank-bu-recon-db/columns');
  const row = { _rowIndex: rowIndex };
  BANK_DB_COLUMNS.forEach((col, i) => { row[col] = arr[i] == null ? '' : String(arr[i]); });
  return row;
}

// 造两月 fixture 的 reader 风格 rows。
function buildFixtureRows() {
  // ── 月1 2026-03 ──
  const m1Pending = [
    makePending('R1', 'BU-A', { amount: 100, currency: 'USD' }),   // 1:1 一致
    makePending('R2', 'BU-A', { amount: 200, currency: 'USD' }),   // 1:1 buDiff（银行侧 BU-B）
    makePending('R3', 'BU-A', { amount: 300, currency: 'EUR' }),   // 1:N（银行 2 行）
    makePending('R4', 'BU-X', { amount: 400, currency: 'CNY' }),   // N:1（pending 2 行）→ 第 1 行
    makePending('R4', 'BU-Y', { amount: 401, currency: 'CNY' }),   // N:1 → 第 2 行（与银行 BU 不同 → 标黄）
    makePending('R5', 'bu-a', { amount: 500, currency: 'USD' }),   // N:M（pending 2 + bank 2）→ 异常
    makePending('R5', 'BU-A', { amount: 501, currency: 'USD' })    // N:M
  ].map((arr, i) => pendingArrayToRow(arr, i + 2));
  const m1Bank = [
    makeBank('R1', 'bu-a', { credit: 100 }),    // 1:1 一致（大小写归一 → 不标黄）
    makeBank('R2', 'BU-B', { credit: 200 }),    // 1:1 buDiff（BU-A vs BU-B → 标黄）
    makeBank('R3', 'BU-A', { credit: 150 }),    // 1:N 第 1 行（与 pending BU-A 一致）
    makeBank('R3', 'BU-Z', { credit: 150 }),    // 1:N 第 2 行（BU-Z ≠ BU-A → 标黄）
    makeBank('R4', 'BU-X', { credit: 400 }),    // N:1（pending R4 两行比 BU-X：BU-X 一致 / BU-Y 不一致标黄）
    makeBank('R5', 'BU-A', { credit: 500 }),    // N:M
    makeBank('R5', 'BU-A', { credit: 501 })     // N:M
  ].map((arr, i) => bankArrayToRow(arr, i + 2));

  // ── 月2 2026-04（跨月汇总用）──
  const m2Pending = [
    makePending('S1', 'BU-M', { amount: 10, currency: 'USD' }),
    makePending('S2', 'BU-M', { amount: 20, currency: 'USD' })
  ].map((arr, i) => pendingArrayToRow(arr, i + 2));
  const m2Bank = [
    makeBank('S1', 'BU-M', { credit: 10 }),     // 一致
    makeBank('S2', 'BU-N', { credit: 20 })      // buDiff
  ].map((arr, i) => bankArrayToRow(arr, i + 2));

  return {
    m1: { yearMonth: '2026-03', pending: m1Pending, bank: m1Bank },
    m2: { yearMonth: '2026-04', pending: m2Pending, bank: m2Bank }
  };
}

// 确定性 dump 一次对账结果（runReconciliation 返回值）——key 化规避自增 id。
function dumpReconResult(result) {
  const pKey = (row) => String(row[PENDING_MATCH_KEY_DB_COLUMN] || '');
  const bKey = (row) => String(row[BANK_MATCH_KEY_DB_COLUMN] || '');
  // id → key 映射（buDiff 集合是 id，转 key 后排序）
  const pById = new Map(result.matchedPending.map((r) => [r.id, pKey(r)]));
  const bById = new Map(result.matchedBank.map((r) => [r.id, bKey(r)]));
  const sortedKeys = (arr) => arr.slice().sort();
  return {
    status: result.status,
    runSummary: {
      pendingTotal: result.stats.pendingTotal,
      bankTotal: result.stats.bankTotal,
      matchedCount: result.stats.matchedCount,
      buDiffCount: result.stats.buDiffCount,
      pendingUnmatched: result.stats.pendingUnmatched,
      bankUnmatched: result.stats.bankUnmatched,
      nmAnomalyCount: result.stats.nmAnomalyCount
    },
    matchedPendingKeys: sortedKeys(result.matchedPending.map(pKey)),
    matchedBankKeys: sortedKeys(result.matchedBank.map(bKey)),
    buDiffPendingKeys: sortedKeys([...result.buDiffPendingIds].map((id) => pById.get(id) || `?${id}`)),
    buDiffBankKeys: sortedKeys([...result.buDiffBankIds].map((id) => bById.get(id) || `?${id}`)),
    nmAnomalies: (result.nmAnomalies || []).slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((a) => ({
      key: a.key,
      pendingCount: a.pendingCount,
      bankCount: a.bankCount,
      pendingRowIndices: a.pendingRowIndices.slice().sort((x, y) => x - y),
      bankRowIndices: a.bankRowIndices.slice().sort((x, y) => x - y)
    }))
  };
}

// 解析导出 diff.xlsx，dump 各 sheet 逐行 cell 值（含黄底标记——黄底由 buDiff 决定，
//   为确定性比对，dump 每 cell 的 { v, hl }（hl=是否黄底））。
async function dumpDiffXlsx(diffFilePath) {
  if (!diffFilePath || !fs.existsSync(diffFilePath)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(diffFilePath);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        const cell = row.getCell(i + 1);
        const hl = !!(cell && cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb === 'FFFFFF00');
        cells.push({ v: v == null ? '' : String(v), hl });
      }
      rows.push(cells);
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

module.exports = {
  makePending,
  makeBank,
  pendingArrayToRow,
  bankArrayToRow,
  buildFixtureRows,
  dumpReconResult,
  dumpDiffXlsx,
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
};
