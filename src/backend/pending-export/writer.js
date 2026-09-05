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
const { applyWatermark } = require('../../main-process/workbook-watermark');
const PENDING_COLUMNS = require('../pending-db/columns');
const diffRepo = require('../pending-db/diff-repository');
// v2.1.11 T2 移除核对：导出 2 张新 sheet（仅 single run）
const removedRepo = require('../pending-db/removed-repository');
const removalMatch = require('../pending-reconcile/removal-match');
const { REMOVED_PENDING_COLUMNS } = require('../pending-import/removed-reader');

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
// v2.1.11 T2 移除核对（D-T2-6 状态列 / D-T2-7 sheet 名）
const SHEET_MISSING_REMOVAL_NAME = 'missing核对移除';      // sheetA：missing 行 + 移除核对状态列
const SHEET_REMOVAL_ONLY_NAME = '移除有_missing无';        // sheetB：未匹配 removed 行（条件生成）
const REMOVAL_STATUS_COLUMN = '移除核对状态';
// v2.1.11 T2 手测增强：状态列两态 → 三态（配对成功后用 compareFields 共用对账规则做内容核对）
//   - 核对无误        ：matchFields 配上 + compareFields 全部归一化一致
//   - 核对有差异:...   ：matchFields 配上但 compareFields 有不一致（前缀 + 差异文字，仅状态列写明）
//   - missing有_移除无 ：matchFields 没配上（不变；移除行仍进 sheetB）
const REMOVAL_STATUS_VERIFIED = '核对无误';
const REMOVAL_STATUS_DIFF_PREFIX = '核对有差异：';
const REMOVAL_STATUS_MISSING_ONLY = 'missing有_移除无';

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
    // v2.0.0 GA：所有导出表头统一字号 10
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, name: 'Courier New', sz: 10 }
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

// 构造一行导出：mainRow 提供 PENDING 31 列数据；pairId/changeSide/changedFieldsStr 元数据
// headerCompareFields 决定 _before/_after 列的位置（用并集对齐 aggregate 表头）；
// runCompareFields 决定值是否填入（该 run 规则不含的字段在 _before/_after/_diff 上留空，
// 符合 PRD §5.6.4 "某 run 不含的列留空"）
function buildSingleExportRow({
  mainRow,
  diffType,
  pairId,
  changeSide,
  changedFieldsStr,
  runCompareFields,
  headerCompareFields,
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

  for (const f of headerCompareFields) {
    // 非本 run 参与比对的字段：在 _before/_after 留空（PRD 约束）
    if (upperRow && lowerRow && runCompareFields.includes(f)) {
      row.push(upperRow[f] == null ? '' : upperRow[f]);
      row.push(lowerRow[f] == null ? '' : lowerRow[f]);
    } else {
      row.push('');
      row.push('');
    }
  }
  // _diff：列由 headerCompareFields 决定位置；值由 runCompareFields 决定是否计算
  if (headerCompareFields.includes('金额')) {
    row.push(
      diffType === 'changed' && runCompareFields.includes('金额')
        ? computeAmountDiff(upperRow, lowerRow, '金额')
        : ''
    );
  }
  if (headerCompareFields.includes('计算金额')) {
    row.push(
      diffType === 'changed' && runCompareFields.includes('计算金额')
        ? computeAmountDiff(upperRow, lowerRow, '计算金额')
        : ''
    );
  }
  return row;
}

// 从 diffRow 展开 1 或 2 行
// runCompareFields：本 run 的规则（决定 changed_fields + _before/_after/_diff 是否有值）
// headerCompareFields：导出 xlsx 表头的并集（single 时与 run 同；aggregate 时 = 并集）
function buildExportRowsForDiff(db, diffRow, runCompareFields, headerCompareFields) {
  const hdr = headerCompareFields || runCompareFields;
  const upperRow = readPendingRow(db, diffRow.upperRowId);
  const lowerRow = readPendingRow(db, diffRow.lowerRowId);

  if (diffRow.type === 'new') {
    return [buildSingleExportRow({
      mainRow: lowerRow,
      diffType: 'new',
      pairId: '',
      changeSide: '',
      changedFieldsStr: '',
      runCompareFields,
      headerCompareFields: hdr,
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
      runCompareFields,
      headerCompareFields: hdr,
      upperRow: null,
      lowerRow: null
    })];
  }
  // changed
  const pairId = `${diffRow.upperRowId}_${diffRow.lowerRowId}`;
  // changed_fields 基于本 run 规则计算（不会"越权"使用并集）
  const changedFields = computeChangedFields(upperRow, lowerRow, runCompareFields);
  const changedFieldsStr = changedFields.join(', ');
  const beforeRow = buildSingleExportRow({
    mainRow: upperRow,
    diffType: 'changed',
    pairId,
    changeSide: 'before',
    changedFieldsStr,
    runCompareFields,
    headerCompareFields: hdr,
    upperRow,
    lowerRow
  });
  const afterRow = buildSingleExportRow({
    mainRow: lowerRow,
    diffType: 'changed',
    pairId,
    changeSide: 'after',
    changedFieldsStr,
    runCompareFields,
    headerCompareFields: hdr,
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

// v2.1.11 T2 手测增强：算 missing diff 行的状态列三态文字
//   - 不在 matchedDiffIds（matchFields 没配上）→ missing有_移除无
//   - 配上且内容核对无差异 → 核对无误
//   - 配上但内容有差异 → 核对有差异：<diffText>
//   兜底：配上但 contentResults 无该行（理论不应发生，compareMatchedContent 覆盖全部配对行）→ 核对无误
function resolveRemovalStatus(diffRowId, matchedDiffIds, contentResults) {
  if (!matchedDiffIds.has(diffRowId)) return REMOVAL_STATUS_MISSING_ONLY;
  const content = contentResults.get(Number(diffRowId));
  if (content && content.status === '有差异') {
    return `${REMOVAL_STATUS_DIFF_PREFIX}${content.diffText}`;
  }
  return REMOVAL_STATUS_VERIFIED;
}

// ========== v2.1.11 T2 移除核对：2 张新 sheet（仅 single run）==========
// 位置：在现有 sheet（汇总 / 资金类型分组 / pending资金类型差异）之后追加 → 天然最右。
//
// sheetA「missing核对移除」（无条件生成）：该 run 全部 missing diff 行（复用 buildExportRowsForDiff
//   的 missing 展开，列结构 = buildHeaders(compareFields)）+ 末列「移除核对状态」（三态，手测增强）：
//     - 核对无误        （matchFields 配上 + compareFields 共用对账规则全部归一化一致）
//     - 核对有差异：字段A(missing原值≠移除原值); …（配上但 compareFields 有不一致，仅状态列写明）
//     - missing有_移除无（matchFields 没配上）
//   ⚠️ compareFields 一致性判定复用 C1 数值归一化（removal-match.compareMatchedContent），
//      "100" vs "100.00" 判一致不误报；差异文字显示原始值。
// sheetB「移除有_missing无」（条件：存在未匹配 removed 行才建）：removed_pending_rows(upperMonth)
//   中 id 不在 pending_removal_matches 的行，按 raw_json 还原 46 列（REMOVED_PENDING_COLUMNS）。
//
// 仅在该 run 的 upperMonth 有移除数据（countByMonth > 0）时才追加（无移除数据 → 行为零变化）。
// 返回 { appended, missingReconRowCount, removalOnlyRowCount }；appended=false 表示无移除数据未追加。
function appendRemovalReconcileSheets(wb, db, run, runId, compareFields) {
  const upperMonth = run && run.upperMonth ? run.upperMonth : null;
  if (!upperMonth) {
    return { appended: false, missingReconRowCount: 0, removalOnlyRowCount: 0 };
  }

  // 该 upperMonth 无移除数据 → 不追加（选"否"路径 / 未导入移除文件场景，行为零变化）
  if (removedRepo.countByMonth(db, upperMonth) === 0) {
    return { appended: false, missingReconRowCount: 0, removalOnlyRowCount: 0 };
  }

  const matchedDiffIds = removalMatch.listMatchedDiffRowIds(db, runId);
  const matchedRemovedIds = removalMatch.listMatchedRemovedRowIds(db, runId);
  // 配对成功行的内容核对结果（compareFields 共用对账规则）：diff_row_id → { status, diffText }
  const contentResults = removalMatch.compareMatchedContent(db, runId, compareFields);

  // ===== sheetA「missing核对移除」=====
  const headersA = [...buildHeaders(compareFields), REMOVAL_STATUS_COLUMN];
  const missingDiffRows = diffRepo.listDiffRows(db, runId, 'missing');
  const rowsA = [];
  for (const d of missingDiffRows) {
    // missing 展开恒为 1 行（buildExportRowsForDiff 对 type='missing' 返回单行）
    const expanded = buildExportRowsForDiff(db, d, compareFields, compareFields);
    const status = resolveRemovalStatus(d.id, matchedDiffIds, contentResults);
    for (const r of expanded) {
      rowsA.push([...r, status]);
    }
  }
  appendSheetWithHeaderFont(wb, SHEET_MISSING_REMOVAL_NAME, headersA, rowsA);

  // ===== sheetB「移除有_missing无」（条件：存在未匹配 removed 行才建）=====
  const allRemoved = removedRepo.listByMonth(db, upperMonth);
  const removalOnly = allRemoved.filter((r) => !matchedRemovedIds.has(r.id));
  let removalOnlyRowCount = 0;
  if (removalOnly.length > 0) {
    const headersB = REMOVED_PENDING_COLUMNS.slice();
    const rowsB = removalOnly.map((r) => {
      const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
      return REMOVED_PENDING_COLUMNS.map((c) => (raw[c] == null ? '' : raw[c]));
    });
    appendSheetWithHeaderFont(wb, SHEET_REMOVAL_ONLY_NAME, headersB, rowsB);
    removalOnlyRowCount = rowsB.length;
  }

  return { appended: true, missingReconRowCount: rowsA.length, removalOnlyRowCount };
}

// ========== 单月（by runId）==========

function buildPendingExportReadSnapshot(db, build, beforeBuild) {
  db.exec('BEGIN');
  try {
    if (typeof beforeBuild === 'function') beforeBuild(db);
    const snapshot = build();
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* preserve original */ }
    throw error;
  }
}

function exportSingleRun(db, runId, savePath, options = {}) {
  const built = buildPendingExportReadSnapshot(db, () => {
  const run = diffRepo.getRunById(db, runId);
  if (!run) throw new Error(`run #${runId} 不存在`);

  const compareFields = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
    ? run.ruleSnapshot.compareFields
    : [];
  const headers = buildHeaders(compareFields);
  const diffRows = diffRepo.listDiffRows(db, runId);
  const meta = getMetaColIndices(compareFields);

  // 每个 diffRow 展开 1/2 行；保持 listDiffRows 的 id 升序 → changed 对天然连续
  // single run 模式：runCompareFields == headerCompareFields（两者同一）
  const allRows = [];
  for (const d of diffRows) {
    const rows = buildExportRowsForDiff(db, d, compareFields, compareFields);
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

  // v2.1.11 T2：追加移除核对 2 sheet（仅当 upperMonth 有移除数据；否则零变化）
  const removalReconcile = appendRemovalReconcileSheets(wb, db, run, runId, compareFields);

  applyWatermark(wb);
  return { wb, result: {
    status: 'success',
    path: savePath,
    filePath: savePath,
    runId,
    upperMonth: run.upperMonth,
    lowerMonth: run.lowerMonth,
    rowCount: allRows.length,
    sheetCount: 1 + groupsByType.size
      + (compareFields.includes(FUND_TYPE_COLUMN) ? 1 : 0)
      + (removalReconcile.appended ? 1 : 0)
      + (removalReconcile.appended && removalReconcile.removalOnlyRowCount > 0 ? 1 : 0),
    fundTypeDiffRowCount,
    // 移除核对结果（无移除数据时 appended=false，其余 0）
    removalReconcileAppended: removalReconcile.appended,
    missingReconRowCount: removalReconcile.missingReconRowCount,
    removalOnlyRowCount: removalReconcile.removalOnlyRowCount
  } };
  }, options.beforeBuild);
  XLSX.writeFile(built.wb, savePath);
  return built.result;
}

// ========== 汇总（每月对取最新 run）==========

function exportAggregateRuns(db, runIds, savePath, options = {}) {
  const built = buildPendingExportReadSnapshot(db, () => {
  const sortedLatest = runIds.map((runId) => {
    const run = diffRepo.getRunById(db, runId);
    if (!run) throw new Error(`run #${runId} 不存在`);
    return run;
  });
  if (sortedLatest.length === 0) {
    return { wb: null, result: { status: 'error', message: '暂无运算 record' } };
  }

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

    // aggregate 模式：runCompareFields = 本 run 规则；headerCompareFields = 并集（对齐表头）
    // 非本 run 参与的列在该行 _before/_after/_diff 留空（PRD §5.6.4 "某 run 不含的列留空"）
    const runCompareFields = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
      ? run.ruleSnapshot.compareFields : [];
    const runRows = diffRepo.listDiffRows(db, run.id);
    for (const d of runRows) {
      const rows = buildExportRowsForDiff(db, d, runCompareFields, compareUnion);
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
    const runCompareFields = (run.ruleSnapshot && Array.isArray(run.ruleSnapshot.compareFields))
      ? run.ruleSnapshot.compareFields : [];
    const runRows = diffRepo.listDiffRows(db, run.id);
    for (const d of runRows) {
      const rows = buildExportRowsForDiff(db, d, runCompareFields, compareUnion);
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

  // I3（v2.1.11 SR-FIX Round 1）：聚合导出不含移除核对 2 sheet（仅 exportSingleRun 含）。
  //   若涉及的任一 upperMonth 有移除归档数据 → 标记 removalDataOmitted，renderer 提示用户改用「导出指定月份」查看。
  let removalDataOmitted = false;
  for (const run of sortedLatest) {
    if (run.upperMonth && removedRepo.countByMonth(db, run.upperMonth) > 0) {
      removalDataOmitted = true;
      break;
    }
  }

  applyWatermark(wb);
  return { wb, result: {
    status: 'success',
    path: savePath,
    filePath: savePath,
    runsCount: sortedLatest.length,
    rowCount: flatRows.length,
    fundTypeDiffRowCount,
    // 聚合导出省略了移除核对 sheet 且确有移除数据 → renderer 据此追加提示
    removalDataOmitted
  } };
  }, options.beforeBuild);
  if (built.wb) XLSX.writeFile(built.wb, savePath);
  return built.result;
}

function exportAggregateLegacy(db, savePath) {
  return exportAggregateRuns(
    db,
    diffRepo.listLatestRunsByMonthPair(db).map((run) => run.id),
    savePath
  );
}

module.exports = {
  exportSingleRun,
  exportAggregateLegacy,
  exportAggregateRuns,
  // v2.1.11 T2 移除核对常量（供 integration 校验 sheet 名/状态值文案）
  SHEET_MISSING_REMOVAL_NAME,
  SHEET_REMOVAL_ONLY_NAME,
  REMOVAL_STATUS_COLUMN,
  // 状态列三态（手测增强：核对无误 / 核对有差异：<diffText> / missing有_移除无）
  REMOVAL_STATUS_VERIFIED,
  REMOVAL_STATUS_DIFF_PREFIX,
  REMOVAL_STATUS_MISSING_ONLY,
  // 给测试用
  __internal: {
    buildHeaders,
    buildExportRowsForDiff,
    buildSingleExportRow,
    sanitizeSheetName,
    computeChangedFields,
    computeAmountDiff,
    appendRemovalReconcileSheets,
    resolveRemovalStatus,
    buildPendingExportReadSnapshot
  }
};
