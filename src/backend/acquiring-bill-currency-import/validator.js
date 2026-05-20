// v2.1.6 T5 — 收单单据币种校验：表头 + 月份归属校验
// 纯函数，不依赖 SheetJS/ExcelJS/SQLite，便于单测
//
// 返回 { ok: true } 或 { ok: false, error, detailLines }
// 主对账Id 唯一性由 SQLite UNIQUE(month_key, recon_main_id) 触发，本文件不做预校验

const { FLOW_HEADERS, BILL_HEADERS } = require('../acquiring-bill-currency-db/columns');

function normalizeHeaderCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildHeaderValidator(expectedHeaders, templateLabel) {
  return function validateHeaders(actualHeaders) {
    if (!Array.isArray(actualHeaders)) {
      return {
        ok: false,
        error: `${templateLabel} 表头不可读：不是数组`,
        detailLines: []
      };
    }

    const actualLen = actualHeaders.length;
    const expectedLen = expectedHeaders.length;

    if (actualLen !== expectedLen) {
      return {
        ok: false,
        error: `${templateLabel} 表头列数不匹配：模板 ${expectedLen} 列，文件 ${actualLen} 列`,
        detailLines: [
          `模板表头：${expectedHeaders.join(' | ')}`,
          `文件表头：${actualHeaders.map(normalizeHeaderCell).join(' | ')}`
        ]
      };
    }

    const mismatches = [];
    for (let i = 0; i < expectedLen; i++) {
      const actual = normalizeHeaderCell(actualHeaders[i]);
      const expected = expectedHeaders[i];
      if (actual !== expected) {
        mismatches.push({ index: i, actual, expected });
      }
    }

    if (mismatches.length > 0) {
      return {
        ok: false,
        error: `${templateLabel} 表头内容不匹配：${mismatches.length} 处差异`,
        detailLines: mismatches.map(
          (m) => `第 ${m.index + 1} 列：期望 "${m.expected}"，实际 "${m.actual}"`
        )
      };
    }

    return { ok: true };
  };
}

const validateFlowHeaders = buildHeaderValidator(FLOW_HEADERS, '收单流水表');
const validateBillHeaders = buildHeaderValidator(BILL_HEADERS, '收单流水单据表');

// 从"账单日期"原值（如 '2026-03-10' / '2026/3/10' / '2026-03-10 03:45:56'）抽取月份 'YYYY-MM'
// 失败 → 返回 null（调用方按"日期格式错误"处理）
function extractMonthKey(billDateRaw) {
  if (billDateRaw === null || billDateRaw === undefined) return null;
  const str = String(billDateRaw).trim();
  if (!str) return null;
  // 匹配 YYYY-MM / YYYY/MM 开头
  const match = str.match(/^(\d{4})[-/](\d{1,2})/);
  if (!match) return null;
  const year = match[1];
  const month = String(match[2]).padStart(2, '0');
  return `${year}-${month}`;
}

// PR #50 reviewer finding F2：reader 允许 `YYYY/MM/DD` 但 writer fmtSheetName 仅识别 `YYYY-MM-DD`
// 入库时把账单日期统一标准化为 `YYYY-MM-DD`（去掉时间部分），避免 writer sheet 名出现非法字符 `/`
// 同时让 SQL `GROUP BY json_extract($."账单日期")` 按规整后日期分组，不再因 `/` vs `-` 拆成两组
// 失败（不能解析年月日）→ 返回原值（reader 已通过 extractMonthKey 校验，正常路径不应进到 fallback）
function normalizeBillDate(billDateRaw) {
  if (billDateRaw === null || billDateRaw === undefined) return '';
  const str = String(billDateRaw).trim();
  if (!str) return '';
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return str;
  const y = m[1];
  const mo = String(m[2]).padStart(2, '0');
  const d = String(m[3]).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// 校验同一批导入的所有行属于同一月份（spec §3.3）
// rows: Array<{ billDateRaw, sourceFile, sourceRowIndex }>
// 返回 { ok, monthKey?, error?, detailLines? }
function validateMonthConsistency(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: '导入数据为空', detailLines: [] };
  }

  const monthCounts = new Map();
  const badRows = [];

  for (const row of rows) {
    const monthKey = extractMonthKey(row.billDateRaw);
    if (!monthKey) {
      badRows.push(row);
      if (badRows.length <= 5) continue;
      else break;
    }
    monthCounts.set(monthKey, (monthCounts.get(monthKey) || 0) + 1);
  }

  if (badRows.length > 0) {
    return {
      ok: false,
      error: `账单日期格式无法解析：${badRows.length} 行（仅列前 5 行）`,
      detailLines: badRows.slice(0, 5).map(
        (r) => `文件 ${r.sourceFile} 第 ${r.sourceRowIndex} 行：账单日期 = "${r.billDateRaw}"`
      )
    };
  }

  if (monthCounts.size > 1) {
    const months = Array.from(monthCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m}（${c} 行）`);
    return {
      ok: false,
      error: `同一批导入跨多个月份：${monthCounts.size} 个月份`,
      detailLines: months
    };
  }

  return { ok: true, monthKey: Array.from(monthCounts.keys())[0] };
}

module.exports = {
  validateFlowHeaders,
  validateBillHeaders,
  extractMonthKey,
  normalizeBillDate,
  validateMonthConsistency
};
