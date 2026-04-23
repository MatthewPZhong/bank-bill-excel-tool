// Pending 导入校验：表头 / 资金类型枚举 / 行级 hash
// 纯函数；可在 worker / 主进程共用

const crypto = require('node:crypto');
const PENDING_COLUMNS = require('../pending-db/columns');

const FUND_TYPE_COLUMN = 'pending资金类型';
const ALLOWED_FUND_TYPES = Object.freeze(new Set(['提现', '退票', '充值']));
// SOH 作为拼串分隔符；列值里几乎不会出现 \u0001，避免 "AB"+"CD" 和 "A"+"BCD" 算同 hash
const HASH_SEPARATOR = '\u0001';

function validateHeaders(headerRow) {
  if (!Array.isArray(headerRow)) {
    return { ok: false, error: '表头不可读：不是数组' };
  }
  if (headerRow.length !== PENDING_COLUMNS.length) {
    return {
      ok: false,
      error: `表头列数不匹配：模板 ${PENDING_COLUMNS.length} 列，文件 ${headerRow.length} 列`
    };
  }
  for (let i = 0; i < PENDING_COLUMNS.length; i++) {
    if (headerRow[i] !== PENDING_COLUMNS[i]) {
      return {
        ok: false,
        error: `表头第 ${i + 1} 列不匹配：模板 "${PENDING_COLUMNS[i]}"，文件 "${headerRow[i]}"`
      };
    }
  }
  return { ok: true };
}

function validateFundType(value) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  return ALLOWED_FUND_TYPES.has(v);
}

function computeRowHash(cells) {
  const parts = cells.map((v) => (v === undefined || v === null ? '' : String(v)));
  return crypto.createHash('sha1').update(parts.join(HASH_SEPARATOR)).digest('hex');
}

module.exports = {
  FUND_TYPE_COLUMN,
  ALLOWED_FUND_TYPES,
  validateHeaders,
  validateFundType,
  computeRowHash
};
