// v2.0.0-beta.3：场景算法引擎共享工具
//
// 仅依赖纯 JS（无 Electron / DB / FS），便于单元测试

// 字符串/数字规范化（用于条件判定 + 配对比较）
function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  return String(value).trim();
}

function isEmptyValue(value) {
  return normalizeCellValue(value) === '';
}

// 数值规范化（C3 发生额绝对值 + 数值 join 用）
// 返回 number（Number.isFinite 通过） 或 null
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const cleaned = String(value).replace(/,/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 条件判定（C1 conditions / C2 billTypes 共用）
// op ∈ '等于' / '不等于' / '包含' / '不包含' / '空值' / '非空值' / '开头为'
function evaluateCondition(row, condition) {
  if (!condition || !condition.field) return false;
  const cellValue = normalizeCellValue(row[condition.field]);
  const op = condition.op;
  const expected = condition.value === undefined || condition.value === null
    ? ''
    : String(condition.value);

  switch (op) {
    case '等于':       return cellValue === expected;
    case '不等于':     return cellValue !== expected;
    case '包含':       return expected !== '' && cellValue.indexOf(expected) >= 0;
    case '不包含':     return expected === '' || cellValue.indexOf(expected) < 0;
    case '空值':       return cellValue === '';
    case '非空值':     return cellValue !== '';
    case '开头为':     return expected !== '' && cellValue.startsWith(expected);
    default:
      return false;
  }
}

// 给行打 _rowId（如果还没有），用于 first-match-wins 锁定
// 关键：必须写回 row._rowId，否则 C2 后续 leftRow._rowId / rightRow._rowId 取值会得到 undefined
// （Codex PR #31 F1 P1 修复）
function ensureRowId(row, fallbackIndex) {
  if (row._rowId !== undefined && row._rowId !== null) return row._rowId;
  const generated = `row_${fallbackIndex}`;
  row._rowId = generated;
  return generated;
}

// 简化的 warning 收集器
function makeWarningCollector(scenarioId, scenarioName) {
  const warnings = [];
  return {
    push(payload) {
      warnings.push({
        scenarioId,
        scenarioName,
        ...payload
      });
    },
    list() {
      return warnings;
    }
  };
}

// 修改记录收集器
// - record(rowId, column, oldValue, newValue) — 实际改了字段的行（用于标黄）
// - lock(rowId) — 参与场景命中但未必改字段的行（用于 first-match-wins）
//   每次 record 自动调 lock；C2 配对成功时 leftRow 也要单独 lock
// （Codex PR #31 F2 P1 修复：C2 leftRow 之前没有进入锁集合）
function makeModificationCollector() {
  const modifications = [];
  const lockedRowIds = new Set();
  return {
    record(rowId, column, oldValue, newValue) {
      modifications.push({ rowId, column, oldValue, newValue });
      lockedRowIds.add(rowId);
    },
    lock(rowId) {
      lockedRowIds.add(rowId);
    },
    listModifications() {
      return modifications;
    },
    listLockedRowIds() {
      return lockedRowIds;
    }
  };
}

// 比较两端值是否相等（C2 / C3 配对用）
// 数字字段 → 比较 number；字符串字段 → 比较 normalize 后的字符串
function valuesEqual(left, right, { numeric = false } = {}) {
  if (numeric) {
    const a = parseNumber(left);
    const b = parseNumber(right);
    return a !== null && b !== null && a === b;
  }
  return normalizeCellValue(left) === normalizeCellValue(right);
}

module.exports = {
  ensureRowId,
  evaluateCondition,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
};
