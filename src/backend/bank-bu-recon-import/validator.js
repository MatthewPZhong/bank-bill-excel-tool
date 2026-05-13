// v2.1.2 T2 — 月度银行对账单BU回填校验：表头校验
// spec §3.11 表头校验逻辑（列数 + 顺序 + 内容三段式）
// 纯函数，不依赖 SheetJS / SQLite，便于单测
//
// 返回值：{ ok: true } 或 { ok: false, error: string, detailLines: string[] }
// 不抛异常；调用方 (reader.js) 决定是否升级为 FileValidationError

const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
} = require('../bank-bu-recon-db/columns');

function normalizeHeaderCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildHeaderValidator(expectedHeaders, templateLabel) {
  return function validate(actualHeaders) {
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
      const first = mismatches[0];
      return {
        ok: false,
        error: `${templateLabel} 表头第 ${first.index + 1} 列不匹配：模板 "${first.expected}"，文件 "${first.actual}"`,
        detailLines: mismatches.map((m) => `第 ${m.index + 1} 列：模板 "${m.expected}" ≠ 文件 "${m.actual}"`)
      };
    }

    return { ok: true };
  };
}

const validatePendingGuanliHeaders = buildHeaderValidator(PENDING_GUANLI_HEADERS, 'Pending 数据管理');
const validateBankHeaders = buildHeaderValidator(BANK_HEADERS, '银行对账单');

module.exports = {
  validatePendingGuanliHeaders,
  validateBankHeaders,
  normalizeHeaderCell
};
