// 差异 xlsx 导出 writer
// - exportSingleRun: 按 runId 导出（Sheet1 汇总 + Sheet2~N 按 pending资金类型 分组）
// - exportAggregate: 每 (upper, lower) 对取最新 run → Sheet1 按月分段 + Sheet2 总汇总
// 表头行字体写死 Courier New（沿用 v1.5.3 R3 决策，OT-3）

const XLSX = require('xlsx-js-style');
const PENDING_COLUMNS = require('../pending-db/columns');
const diffRepo = require('../pending-db/diff-repository');

const FUND_TYPE_COLUMN = 'pending资金类型';
const DIFF_TYPE_COLUMN = 'diff_type';
const SHEET_SUMMARY_NAME = '汇总';
const SHEET_MONTHLY_BREAKDOWN_NAME = '按月维度区别汇总';

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
  const headers = [...PENDING_COLUMNS, DIFF_TYPE_COLUMN];
  for (const f of compareFields) {
    headers.push(`${f}_before`);
    headers.push(`${f}_after`);
  }
  return headers;
}

function readPendingRow(db, rowId) {
  if (rowId == null) return null;
  const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
  const row = db.prepare(`SELECT id, ${colList} FROM pending_rows WHERE id = ?`).get(rowId);
  return row || null;
}

function buildExportRow(db, diffRow, compareFields) {
  let mainRow = null;
  if (diffRow.type === 'new') mainRow = readPendingRow(db, diffRow.lowerRowId);
  else if (diffRow.type === 'missing') mainRow = readPendingRow(db, diffRow.upperRowId);
  else if (diffRow.type === 'changed') mainRow = readPendingRow(db, diffRow.lowerRowId);

  const row = PENDING_COLUMNS.map((c) => {
    if (!mainRow) return '';
    return mainRow[c] == null ? '' : mainRow[c];
  });
  row.push(diffRow.type);

  if (diffRow.type === 'changed') {
    const upperRow = readPendingRow(db, diffRow.upperRowId) || {};
    const lowerRow = readPendingRow(db, diffRow.lowerRowId) || {};
    for (const f of compareFields) {
      row.push(upperRow[f] == null ? '' : upperRow[f]);
      row.push(lowerRow[f] == null ? '' : lowerRow[f]);
    }
  } else {
    for (let i = 0; i < compareFields.length * 2; i += 1) row.push('');
  }
  return row;
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

// ========== 单月（by runId）==========

function exportSingleRun(db, runId, savePath) {
  const run = diffRepo.getRunById(db, runId);
  if (!run) throw new Error(`run #${runId} 不存在`);

  const compareFields = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
    ? run.ruleSnapshot.compareFields
    : [];
  const headers = buildHeaders(compareFields);
  const diffRows = diffRepo.listDiffRows(db, runId);
  const fundTypeIdx = PENDING_COLUMNS.indexOf(FUND_TYPE_COLUMN);

  const allRows = diffRows.map((d) => buildExportRow(db, d, compareFields));

  const wb = XLSX.utils.book_new();
  appendSheetWithHeaderFont(wb, SHEET_SUMMARY_NAME, headers, allRows);

  // 按 pending资金类型 分组（空值聚为 "(空)"）
  const groupsByType = new Map();
  for (const r of allRows) {
    const rawType = r[fundTypeIdx];
    const type = rawType == null || rawType === '' ? '(空)' : String(rawType);
    if (!groupsByType.has(type)) groupsByType.set(type, []);
    groupsByType.get(type).push(r);
  }
  for (const [type, rows] of groupsByType) {
    appendSheetWithHeaderFont(wb, type, headers, rows);
  }

  XLSX.writeFile(wb, savePath);
  return {
    status: 'success',
    path: savePath,
    runId,
    upperMonth: run.upperMonth,
    lowerMonth: run.lowerMonth,
    rowCount: allRows.length,
    sheetCount: 1 + groupsByType.size
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

  const wb = XLSX.utils.book_new();

  // Sheet1: 按月维度区别汇总
  const breakdownRows = [];
  const monthSeparator = new Array(headers.length).fill('');
  for (const run of sortedLatest) {
    const label = new Array(headers.length).fill('');
    label[0] = `【${run.lowerMonth}（vs ${run.upperMonth}）最新 run - ${run.createdAt}】`;
    breakdownRows.push(label);

    const rows = diffRepo.listDiffRows(db, run.id).map((d) => {
      const base = buildExportRow(db, d, compareUnion);
      // 注意：buildExportRow 的 compareFields 传 compareUnion → _before/_after 对齐；但 run 规则可能只有部分 compareFields
      // 对 run 不含的 compareUnion 项：buildExportRow 会填 lower/upper 相应列（即使规则未配置也不伤）
      return base;
    });
    for (const r of rows) breakdownRows.push(r);
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
    const rows = diffRepo.listDiffRows(db, run.id).map((d) => buildExportRow(db, d, compareUnion));
    for (const r of rows) flatRows.push(r);
  }
  appendSheetWithHeaderFont(wb, SHEET_SUMMARY_NAME, headers, flatRows);

  XLSX.writeFile(wb, savePath);
  return {
    status: 'success',
    path: savePath,
    runsCount: sortedLatest.length,
    rowCount: flatRows.length
  };
}

module.exports = {
  exportSingleRun,
  exportAggregate,
  // 给测试用
  __internal: { buildHeaders, buildExportRow, sanitizeSheetName }
};
