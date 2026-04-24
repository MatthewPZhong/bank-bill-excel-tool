// 差异 xlsx 导出 writer
// - exportSingleRun: 按 runId 导出（Sheet1 汇总 + Sheet2~N 按 pending资金类型 分组 + [可选] pending资金类型差异 sheet）
// - exportAggregate: 每 (upper, lower) 对取最新 run → Sheet1 按月分段 + Sheet2 总汇总 + [可选] pending资金类型差异 sheet
// 表头行字体写死 Courier New（沿用 v1.5.3 R3 决策，OT-3）
//
// v2.0.0-beta.2 changed 展开：每 pair 两行 before(upper) + after(lower)
//  - 新增列：pair_id / change_side / changed_fields（在 diff_type 之后）
//  - 若 compareFields 含"金额" → 末尾加 金额_diff 列 = parseFloat(lower) - parseFloat(upper)
//  - 若 compareFields 含"计算金额" → 末尾加 计算金额_diff 列
//  - 若 compareFields 含"pending资金类型" → 新增一张专门 sheet "pending资金类型差异"

const XLSX = require('xlsx-js-style');
const PENDING_COLUMNS = require('../pending-db/columns');
const diffRepo = require('../pending-db/diff-repository');

const FUND_TYPE_COLUMN = 'pending资金类型';
const DIFF_TYPE_COLUMN = 'diff_type';
const PAIR_ID_COLUMN = 'pair_id';
const CHANGE_SIDE_COLUMN = 'change_side';
const CHANGED_FIELDS_COLUMN = 'changed_fields';
const AMOUNT_DIFF_COLUMN = '金额_diff';
const CALC_AMOUNT_DIFF_COLUMN = '计算金额_diff';
const SHEET_SUMMARY_NAME = '汇总';
const SHEET_MONTHLY_BREAKDOWN_NAME = '按月维度区别汇总';
const SHEET_FUND_TYPE_DIFF_NAME = 'pending资金类型差异';

function applyHeaderRowFont(worksheet, headerRowIndex = 0) {
  if (!worksheet || !worksheet['!ref']) return;
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  if (headerRowIndex < range.s.r || headerRowIndex > range.e.r) return;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c });
    const cell = worksheet[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, name: 'Courier New' }
    };
  }
}

function buildHeaders(compareFields) {
  const headers = [
    ...PENDING_COLUMNS,
    DIFF_TYPE_COLUMN,
    PAIR_ID_COLUMN,
    CHANGE_SIDE_COLUMN,
    CHANGED_FIELDS_COLUMN
  ];
  for (const f of compareFields) {
    headers.push(`${f}_before`);
    headers.push(`${f}_after`);
  }
  if (compareFields.includes('金额')) headers.push(AMOUNT_DIFF_COLUMN);
  if (compareFields.includes('计算金额')) headers.push(CALC_AMOUNT_DIFF_COLUMN);
  return headers;
}

function readPendingRow(db, rowId) {
  if (rowId == null) return null;
  const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
  const row = db.prepare(`SELECT id, ${colList} FROM pending_rows WHERE id = ?`).get(rowId);
  return row || null;
}

// 判定 upper/lower 两行在 compareFields 上哪些字段不等（字符串比较，空值统一当 ''）
function computeChangedFields(upperRow, lowerRow, compareFields) {
  if (!upperRow || !lowerRow) return [];
  const changed = [];
  for (const f of compareFields) {
    const u = upperRow[f] == null ? '' : String(upperRow[f]);
    const l = lowerRow[f] == null ? '' : String(lowerRow[f]);
    if (u !== l) changed.push(f);
  }
  return changed;
}

// 金额差异额：parseFloat(lower) - parseFloat(upper)；任一解析失败返回 ''
function computeAmountDiff(upperRow, lowerRow, field) {
  if (!upperRow || !lowerRow) return '';
  const u = upperRow[field] == null ? '' : String(upperRow[field]);
  const l = lowerRow[field] == null ? '' : String(lowerRow[field]);
  const un = parseFloat(u);
  const ln = parseFloat(l);
  if (!Number.isFinite(un) || !Number.isFinite(ln)) return '';
  return ln - un;
}

// 构造一行导出：mainRow 提供 PENDING 31 列数据；pairId/changeSide/changedFieldsStr 元数据；_before/_after/_diff 值由 upper/lower 双快照计算
function buildSingleExportRow({
  mainRow,
  diffType,
  pairId,
  changeSide,
  changedFieldsStr,
  compareFields,
  upperRow,
  lowerRow
}) {
  const row = PENDING_COLUMNS.map((c) => {
    if (!mainRow) return '';
    return mainRow[c] == null ? '' : mainRow[c];
  });
  row.push(diffType);
  row.push(pairId);
  row.push(changeSide);
  row.push(changedFieldsStr);

  for (const f of compareFields) {
    if (upperRow && lowerRow) {
      row.push(upperRow[f] == null ? '' : upperRow[f]);
      row.push(lowerRow[f] == null ? '' : lowerRow[f]);
    } else {
      row.push('');
      row.push('');
    }
  }
  if (compareFields.includes('金额')) {
    row.push(diffType === 'changed' ? computeAmountDiff(upperRow, lowerRow, '金额') : '');
  }
  if (compareFields.includes('计算金额')) {
    row.push(diffType === 'changed' ? computeAmountDiff(upperRow, lowerRow, '计算金额') : '');
  }
  return row;
}

// 从 diffRow 展开 1 或 2 行：
//   new → 1 行 lower 快照
//   missing → 1 行 upper 快照
//   changed → 2 行 before(upper) + after(lower)，共享 pair_id / changed_fields / _before/_after / _diff
function buildExportRowsForDiff(db, diffRow, compareFields) {
  const upperRow = readPendingRow(db, diffRow.upperRowId);
  const lowerRow = readPendingRow(db, diffRow.lowerRowId);

  if (diffRow.type === 'new') {
    return [buildSingleExportRow({
      mainRow: lowerRow,
      diffType: 'new',
      pairId: '',
      changeSide: '',
      changedFieldsStr: '',
      compareFields,
      upperRow: null,
      lowerRow: null
    })];
  }
  if (diffRow.type === 'missing') {
    return [buildSingleExportRow({
      mainRow: upperRow,
      diffType: 'missing',
      pairId: '',
      changeSide: '',
      changedFieldsStr: '',
      compareFields,
      upperRow: null,
      lowerRow: null
    })];
  }
  // changed
  const pairId = `${diffRow.upperRowId}_${diffRow.lowerRowId}`;
  const changedFields = computeChangedFields(upperRow, lowerRow, compareFields);
  const changedFieldsStr = changedFields.join(', ');
  const beforeRow = buildSingleExportRow({
    mainRow: upperRow,
    diffType: 'changed',
    pairId,
    changeSide: 'before',
    changedFieldsStr,
    compareFields,
    upperRow,
    lowerRow
  });
  const afterRow = buildSingleExportRow({
    mainRow: lowerRow,
    diffType: 'changed',
    pairId,
    changeSide: 'after',
    changedFieldsStr,
    compareFields,
    upperRow,
    lowerRow
  });
  return [beforeRow, afterRow];
}

function sanitizeSheetName(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) s = '(空)';
  // XLSX sheet 名限制：[]:?*/\ 不能用，长度 <= 31
  s = s.replace(/[\\/?*\[\]:]/g, '_');
  if (s.length > 31) s = s.slice(0, 31);
  return s;
}

function appendSheetWithHeaderFont(workbook, sheetName, headers, rows) {
  const aoa = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  applyHeaderRowFont(ws);
  XLSX.utils.book_append_sheet(workbook, ws, sanitizeSheetName(sheetName));
  return ws;
}

// 计算导出行里各元数据列的 index（供 sheet 过滤用）
function getMetaColIndices(compareFields) {
  const diffTypeIdx = PENDING_COLUMNS.length;
  return {
    diffTypeIdx,
    pairIdIdx: diffTypeIdx + 1,
    changeSideIdx: diffTypeIdx + 2,
    changedFieldsIdx: diffTypeIdx + 3,
    fundTypeIdx: PENDING_COLUMNS.indexOf(FUND_TYPE_COLUMN)
  };
}

// ========== 单月（by runId）==========

function exportSingleRun(db, runId, savePath) {
  const run = diffRepo.getRunById(db, runId);
  if (!run) throw new Error(`run #${runId} 不存在`);

  const compareFields = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
    ? run.ruleSnapshot.compareFields
    : [];
  const headers = buildHeaders(compareFields);
  const diffRows = diffRepo.listDiffRows(db, runId);
  const meta = getMetaColIndices(compareFields);

  // 每个 diffRow 展开 1/2 行；保持 listDiffRows 的 id 升序 → changed 对天然连续
  const allRows = [];
  for (const d of diffRows) {
    const rows = buildExportRowsForDiff(db, d, compareFields);
    for (const r of rows) allRows.push(r);
  }

  const wb = XLSX.utils.book_new();
  appendSheetWithHeaderFont(wb, SHEET_SUMMARY_NAME, headers, allRows);

  // 按 pending资金类型 分组（空值聚为 "(空)"）—— 以行自身的资金类型分
  const groupsByType = new Map();
  for (const r of allRows) {
    const rawType = r[meta.fundTypeIdx];
    const type = rawType == null || rawType === '' ? '(空)' : String(rawType);
    if (!groupsByType.has(type)) groupsByType.set(type, []);
    groupsByType.get(type).push(r);
  }
  for (const [type, rows] of groupsByType) {
    appendSheetWithHeaderFont(wb, type, headers, rows);
  }

  // 对账内容含 pending资金类型 → 专门 sheet（空也要建）
  let fundTypeDiffRowCount = 0;
  if (compareFields.includes(FUND_TYPE_COLUMN)) {
    const fundDiffRows = allRows.filter((r) => {
      if (r[meta.diffTypeIdx] !== 'changed') return false;
      const cfs = String(r[meta.changedFieldsIdx] || '').split(',').map((s) => s.trim()).filter(Boolean);
      return cfs.includes(FUND_TYPE_COLUMN);
    });
    fundTypeDiffRowCount = fundDiffRows.length;
    appendSheetWithHeaderFont(wb, SHEET_FUND_TYPE_DIFF_NAME, headers, fundDiffRows);
  }

  XLSX.writeFile(wb, savePath);
  return {
    status: 'success',
    path: savePath,
    runId,
    upperMonth: run.upperMonth,
    lowerMonth: run.lowerMonth,
    rowCount: allRows.length,
    sheetCount: 1 + groupsByType.size + (compareFields.includes(FUND_TYPE_COLUMN) ? 1 : 0),
    fundTypeDiffRowCount
  };
}

// ========== 汇总（每月对取最新 run）==========

function exportAggregate(db, savePath) {
  const allRuns = diffRepo.listAllRuns(db);
  if (!allRuns || allRuns.length === 0) {
    return { status: 'error', message: '暂无运算 record' };
  }

  // 按 (upper, lower) 取最新 run（listAllRuns 已按 created_at desc）
  const latestByPair = new Map();
  for (const r of allRuns) {
    const key = `${r.upperMonth}||${r.lowerMonth}`;
    if (!latestByPair.has(key)) latestByPair.set(key, r);
  }

  // 按 lowerMonth 升序排（最老 → 最新）
  const sortedLatest = Array.from(latestByPair.values()).sort((a, b) => {
    if (a.lowerMonth === b.lowerMonth) return a.upperMonth < b.upperMonth ? -1 : 1;
    return a.lowerMonth < b.lowerMonth ? -1 : 1;
  });

  // compareFields 并集
  const compareUnion = [];
  const seen = new Set();
  for (const run of sortedLatest) {
    const cfs = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
      ? run.ruleSnapshot.compareFields : [];
    for (const f of cfs) {
      if (!seen.has(f)) { seen.add(f); compareUnion.push(f); }
    }
  }
  const headers = buildHeaders(compareUnion);
  const meta = getMetaColIndices(compareUnion);

  const wb = XLSX.utils.book_new();

  // Sheet1: 按月维度区别汇总
  const breakdownRows = [];
  const monthSeparator = new Array(headers.length).fill('');
  for (const run of sortedLatest) {
    const label = new Array(headers.length).fill('');
    label[0] = `【${run.lowerMonth}（vs ${run.upperMonth}）最新 run - ${run.createdAt}】`;
    breakdownRows.push(label);

    const runRows = diffRepo.listDiffRows(db, run.id);
    for (const d of runRows) {
      const rows = buildExportRowsForDiff(db, d, compareUnion);
      for (const r of rows) breakdownRows.push(r);
    }
    breakdownRows.push(monthSeparator.slice());
  }
  // 去掉最后一个 separator
  if (breakdownRows.length > 0 && breakdownRows[breakdownRows.length - 1].every((v) => v === '')) {
    breakdownRows.pop();
  }
  appendSheetWithHeaderFont(wb, SHEET_MONTHLY_BREAKDOWN_NAME, headers, breakdownRows);

  // Sheet2: 汇总（扁平）
  const flatRows = [];
  for (const run of sortedLatest) {
    const runRows = diffRepo.listDiffRows(db, run.id);
    for (const d of runRows) {
      const rows = buildExportRowsForDiff(db, d, compareUnion);
      for (const r of rows) flatRows.push(r);
    }
  }
  appendSheetWithHeaderFont(wb, SHEET_SUMMARY_NAME, headers, flatRows);

  // 并集含 pending资金类型 → 专门 sheet（空也要建）
  let fundTypeDiffRowCount = 0;
  if (compareUnion.includes(FUND_TYPE_COLUMN)) {
    const fundDiffRows = flatRows.filter((r) => {
      if (r[meta.diffTypeIdx] !== 'changed') return false;
      const cfs = String(r[meta.changedFieldsIdx] || '').split(',').map((s) => s.trim()).filter(Boolean);
      return cfs.includes(FUND_TYPE_COLUMN);
    });
    fundTypeDiffRowCount = fundDiffRows.length;
    appendSheetWithHeaderFont(wb, SHEET_FUND_TYPE_DIFF_NAME, headers, fundDiffRows);
  }

  XLSX.writeFile(wb, savePath);
  return {
    status: 'success',
    path: savePath,
    runsCount: sortedLatest.length,
    rowCount: flatRows.length,
    fundTypeDiffRowCount
  };
}

module.exports = {
  exportSingleRun,
  exportAggregate,
  // 给测试用
  __internal: {
    buildHeaders,
    buildExportRowsForDiff,
    buildSingleExportRow,
    sanitizeSheetName,
    computeChangedFields,
    computeAmountDiff
  }
};
