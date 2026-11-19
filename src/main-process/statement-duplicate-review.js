'use strict';

// v3.2.19：原始账单预处理「重复账单过滤」的导入暂停 / 确认 / 取消（spec §8.3）。
// 与大账号选择相同：只在导入的预检（preview / prepare）阶段暂停，返回 duplicate-review，不开后台任务、不归档；
// 用户【确认】后用原导入通道续跑，执行阶段按同一口径重新扫描，摘要一致才删除重复行，否则拒绝生成。
// 单槽保存待确认上下文（同一时间只有一次导入在等待确认）。
const DUPLICATE_REVIEW_STATUS = 'duplicate-review';
const DUPLICATE_ROWS_REVIEW_STALE = 'DUPLICATE_ROWS_REVIEW_STALE';
// 弹窗最多列出的账单行数（按行封顶，限制单次 IPC 与渲染量）、活动日志最多列出的明细样例行数；超出时另给总数。
// 完整的去除行号按文件压缩成区间：超出显示上限时随复核结果在弹窗中列出，并写入活动日志（待确认与确认去除时都写）。
const DUPLICATE_REVIEW_DISPLAY_ROW_LIMIT = 1000;
const DUPLICATE_REVIEW_LOG_LINE_LIMIT = 200;

function hasSourceRowKeys(entries) {
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const metas = entry && entry.detailRows && Array.isArray(entry.detailRows.rowMetas) ? entry.detailRows.rowMetas : [];
    return metas.some((meta) => meta && typeof meta.sourceRowKey === 'string' && meta.sourceRowKey !== '');
  });
}

function formatAccount(account) {
  const merchantId = String(account && account.merchantId || '') || '（空）';
  const currency = String(account && account.currency || '');
  return currency ? `${merchantId}（${currency}）` : merchantId;
}

function formatAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).map(formatAccount).join('、');
}

// 活动日志持久化在磁盘：账户号只留末 4 位（弹窗核对时显示原值）；定位靠文件、行号与组号。
function maskAccountNumber(value) {
  const text = String(value || '');
  if (!text) return '（空）';
  return text.length > 4 ? `****${text.slice(-4)}` : '****';
}

// 日志里的币种只写形如 3 位字母的币种代码；其他值（可能是误映射的账号、姓名等）记为「未识别币种」，弹窗仍显示原值
function formatLoggedCurrency(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : '未识别币种';
}

function formatMaskedAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const currency = formatLoggedCurrency(account && account.currency);
    const masked = maskAccountNumber(account && account.merchantId);
    return currency ? `${masked}（${currency}）` : masked;
  }).join('、');
}

function countScanRows(scan) {
  return (scan && Array.isArray(scan.groups) ? scan.groups : [])
    .reduce((sum, group) => sum + (Array.isArray(group.rows) ? group.rows.length : 0), 0);
}

// 活动日志明细样例：每个被去掉 / 保留的源行一行，只构造前 limit 行，另记总行数。持久化日志不写文件名（文件名可能含账户号），
//   以文件序号（本次导入时的文件顺序）、行号与组号定位；账户号只留末 4 位。
function buildDuplicateLogLines(scan, limit = DUPLICATE_REVIEW_LOG_LINE_LIMIT) {
  const lines = [];
  const groups = scan && Array.isArray(scan.groups) ? scan.groups : [];
  for (let groupIndex = 0; groupIndex < groups.length && lines.length < limit; groupIndex += 1) {
    const group = groups[groupIndex];
    for (let rowIndex = 0; rowIndex < group.rows.length && lines.length < limit; rowIndex += 1) {
      const row = group.rows[rowIndex];
      lines.push(`重复组 #${groupIndex + 1}：第 ${row.fileIndex + 1} 个文件 第 ${row.sourceRowNumber} 行，`
        + `账户号：${formatMaskedAccounts(group.accounts)}，账期：${group.billDate || '（空）'}，${row.kept ? '保留' : '去除'}`);
    }
  }
  const total = countScanRows(scan);
  if (total > lines.length) lines.push(`……明细共 ${total} 行，其余未列出；去除的行号见下方完整清单`);
  return lines;
}

// 升序行号压缩成区间：[2, 3, 4, 7] → 「2-4、7」
function formatRowRanges(rowNumbers) {
  const ranges = [];
  let start = null;
  let previous = null;
  rowNumbers.forEach((rowNumber) => {
    if (start !== null && rowNumber === previous + 1) {
      previous = rowNumber;
      return;
    }
    if (start !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = rowNumber;
    previous = rowNumber;
  });
  if (start !== null) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join('、');
}

// 完整的去除行号清单：每个文件一项（文件顺序），行号压缩成区间。弹窗（超出显示上限时）与活动日志共用，去向可审计；
//   日志不写文件名（includeFileName=false），只写文件序号。
function buildDropPlanSummary(scan, { includeFileName = true } = {}) {
  const fileNames = new Map();
  (scan && Array.isArray(scan.groups) ? scan.groups : []).forEach((group) => {
    group.rows.forEach((row) => { if (!fileNames.has(row.fileIndex)) fileNames.set(row.fileIndex, row.fileName); });
  });
  return (scan && Array.isArray(scan.dropPlan) ? scan.dropPlan : [])
    .map((rowNumbers, fileIndex) => (rowNumbers.length
      ? `第 ${fileIndex + 1} 个文件${includeFileName ? ` ${fileNames.get(fileIndex) || ''}` : ''}：第 ${formatRowRanges(rowNumbers)} 行（${rowNumbers.length} 行）`
      : ''))
    .filter(Boolean);
}

function buildDropPlanLogLines(scan) {
  return buildDropPlanSummary(scan, { includeFileName: false }).map((line) => `去除行号 · ${line}`);
}

function createStatementDuplicateReview({
  randomUUID,
  appendActivityLogEntry = () => {},
  createErrorResult,
  scanDuplicateSourceRows,
  dropDuplicateSourceRows
}) {
  let pending = null;

  function log(level, message, details) {
    try {
      appendActivityLogEntry({ level, message, details });
    } catch (_error) {
      // 日志失败不影响导入
    }
  }

  // 给界面的复核结果：按重复组列出文件、行号、账户号、账期，标出保留 / 去除。按行封顶，超出的组只列出前面的行。
  function buildReviewResult(scan, { contextId, reviewKind, templateName = '' }) {
    const groups = [];
    let displayedRowCount = 0;
    for (let index = 0; index < scan.groups.length && displayedRowCount < DUPLICATE_REVIEW_DISPLAY_ROW_LIMIT; index += 1) {
      const group = scan.groups[index];
      const rows = group.rows.slice(0, DUPLICATE_REVIEW_DISPLAY_ROW_LIMIT - displayedRowCount);
      displayedRowCount += rows.length;
      groups.push({
        seq: index + 1,
        accountLabel: formatAccounts(group.accounts),
        billDate: group.billDate || '',
        hiddenRowCount: group.rows.length - rows.length,
        rows: rows.map((row) => ({
          fileName: row.fileName,
          sourceRowNumber: row.sourceRowNumber,
          kept: Boolean(row.kept)
        }))
      });
    }
    const totalRowCount = countScanRows(scan);
    return {
      status: DUPLICATE_REVIEW_STATUS,
      contextId,
      reviewKind,
      templateName,
      message: `发现 ${scan.groups.length} 组重复账单（共 ${scan.droppedRowCount} 行将被去除），请确认后生成`,
      totalGroups: scan.groups.length,
      totalRowCount,
      displayedRowCount,
      droppedRowCount: scan.droppedRowCount,
      truncated: displayedRowCount < totalRowCount,
      // 超出显示上限时附完整的去除行号（按文件压缩成区间），确认前在弹窗内即可核对任意一行，不依赖活动日志写入
      dropPlanLines: displayedRowCount < totalRowCount ? buildDropPlanSummary(scan) : [],
      groups
    };
  }

  // phase：'preview' 发现重复时暂停；'execute' 须带与扫描一致的确认摘要（prepared.duplicateReviewConfirmation.digest）。
  //   确认续跑（带确认摘要）时重新扫描必须仍与确认时一致：指纹缺失或重复消失也按不一致拒绝，不静默放行。
  // 返回 { status: 'pass' | 'pause' | 'dropped' | 'stale', entries?, scan?, result?, droppedRowCount? }。
  function review({ entries, prepared = null, phase, templateName = '' }) {
    const confirmation = phase === 'execute' && prepared ? prepared.duplicateReviewConfirmation || null : null;
    const hasKeys = hasSourceRowKeys(entries);
    if (!hasKeys && !confirmation) return { status: 'pass', entries };
    const scan = hasKeys
      ? scanDuplicateSourceRows(entries)
      : { groups: [], dropPlan: [], droppedRowCount: 0, digest: '' };
    if (!scan.groups.length && !confirmation) return { status: 'pass', entries };
    if (phase === 'preview') {
      return { status: 'pause', scan };
    }
    if (!confirmation || !scan.digest || confirmation.digest !== scan.digest) {
      log('warning', '重复账单与确认时不一致，已拒绝生成', [`模板名：${templateName || 'N/A'}`]);
      return {
        status: 'stale',
        scan,
        // createErrorResult 不把 errorCode 放进返回值：这里显式带上，调用方据此识别复核失效
        result: {
          ...createErrorResult({
            step: '导入网银明细文件',
            message: '重复账单与确认时不一致，请重新导入文件',
            errorCode: DUPLICATE_ROWS_REVIEW_STALE,
            templateName
          }),
          errorCode: DUPLICATE_ROWS_REVIEW_STALE
        }
      };
    }
    const droppedEntries = dropDuplicateSourceRows(entries, scan);
    log('info', '已确认过滤重复账单', [
      `模板名：${templateName || 'N/A'}`,
      `重复组：${scan.groups.length}，去除行数：${scan.droppedRowCount}`,
      ...buildDropPlanLogLines(scan),
      ...buildDuplicateLogLines(scan)
    ]);
    return { status: 'dropped', entries: droppedEntries, scan, droppedRowCount: scan.droppedRowCount };
  }

  // context：{ kind: 'file-import' | 'big-account', templateId, prepared?, bigAccountContextId?, bigAccountPayload?, scan, templateName }
  function remember(context) {
    const contextId = randomUUID();
    // 续跑只核对摘要（执行时重新扫描）：待确认上下文不保存完整的扫描结果，等待确认期间不占用这部分内存
    const { scan: _scan, ...rest } = context;
    pending = { ...rest, contextId, digest: context.scan.digest };
    log('info', '发现重复账单，等待确认', [
      `模板名：${context.templateName || 'N/A'}`,
      `重复组：${context.scan.groups.length}，待去除行数：${context.scan.droppedRowCount}`,
      ...buildDropPlanLogLines(context.scan),
      ...buildDuplicateLogLines(context.scan)
    ]);
    return pending;
  }

  function requireContext(contextId) {
    const normalized = String(contextId || '').trim();
    if (!normalized || !pending || pending.contextId !== normalized) return null;
    return pending;
  }

  // 不传 contextId 时无条件清除；传入时只清除匹配的上下文。
  function clear(contextId = '') {
    const normalized = String(contextId || '').trim();
    if (normalized && (!pending || pending.contextId !== normalized)) return false;
    pending = null;
    return true;
  }

  function cancel(contextId) {
    const context = requireContext(contextId);
    if (!context) return null;
    pending = null;
    log('info', '已取消导入（重复账单）', [`模板名：${context.templateName || 'N/A'}`]);
    return context;
  }

  return Object.freeze({ buildReviewResult, cancel, clear, remember, requireContext, review });
}

module.exports = {
  DUPLICATE_REVIEW_STATUS,
  DUPLICATE_ROWS_REVIEW_STALE,
  createStatementDuplicateReview,
  hasSourceRowKeys
};
