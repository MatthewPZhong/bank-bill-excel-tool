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
// 只在引擎内部使用；调用方传进来的行可能没有 _rowId
function ensureRowId(row, fallbackIndex) {
  if (row._rowId !== undefined && row._rowId !== null) return row._rowId;
  return `row_${fallbackIndex}`;
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

// 简化的修改记录收集器
// 每次 `record(rowId, column, oldValue, newValue)` push 一条
function makeModificationCollector() {
  const modifications = [];
  const modifiedRowIds = new Set();
  return {
    record(rowId, column, oldValue, newValue) {
      modifications.push({ rowId, column, oldValue, newValue });
      modifiedRowIds.add(rowId);
    },
    listModifications() {
      return modifications;
    },
    listModifiedRowIds() {
      return modifiedRowIds;
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
