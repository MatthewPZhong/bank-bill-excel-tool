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

// v3.0.8 迭代2-B（🔴资金对账红线）— buildHeaderValidator 增加 options.allowSupersetColumns：
//   - allowSupersetColumns=false（默认，Pending 用）：列数必须相等 + 逐列名相等（行为完全不变，零回归）
//   - allowSupersetColumns=true（Bank 用）：兼容新版 46 列银行对账单（'Transaction Description' 后插入
//     「合并单号」「合并状态」两列）。不要求列数相等；要求 expectedHeaders 每个列名都出现在 actualHeaders 中，
//     且 expectedHeaders 是 actualHeaders 的"有序子序列"（按模板顺序逐个在文件表头里能依次往后找到，
//     保持相对顺序、防乱序文件）；多出的列（合并单号/合并状态）忽略、不落库。
function buildHeaderValidator(expectedHeaders, templateLabel, options = {}) {
  const allowSupersetColumns = options.allowSupersetColumns === true;

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

    if (allowSupersetColumns) {
      // 宽容超集模式：模板列必须全部命中，且保持相对顺序（有序子序列），多余列忽略。
      const normalizedActual = actualHeaders.map(normalizeHeaderCell);

      const missing = [];
      let cursor = 0;             // 在 actualHeaders 中的扫描游标（只前进，保证相对顺序）
      let orderBroken = false;
      for (let i = 0; i < expectedLen; i++) {
        const expected = expectedHeaders[i];
        const foundAt = normalizedActual.indexOf(expected, cursor);
        if (foundAt === -1) {
          // 从当前游标往后找不到：可能整体缺失，或顺序错乱（出现在游标之前）
          const earlierAt = normalizedActual.indexOf(expected);
          if (earlierAt === -1) {
            missing.push(expected);
          } else {
            orderBroken = true;
            missing.push(expected);
          }
        } else {
          cursor = foundAt + 1;
        }
      }

      if (missing.length > 0) {
        return {
          ok: false,
          error: orderBroken
            ? `${templateLabel} 表头顺序错乱或缺失模板列：${missing.join('、')}`
            : `${templateLabel} 表头缺失模板列：${missing.join('、')}`,
          detailLines: [
            `模板表头（${expectedLen} 列，须按此相对顺序出现）：${expectedHeaders.join(' | ')}`,
            `文件表头（${actualLen} 列）：${normalizedActual.join(' | ')}`,
            `缺失/错序列：${missing.join('、')}`
          ]
        };
      }

      return { ok: true };
    }

    // 严格模式（Pending 用）：列数必须相等 + 逐列名相等。
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

// Pending：保持原严格校验（列数 + 顺序 + 内容三段式），零回归
const validatePendingGuanliHeaders = buildHeaderValidator(PENDING_GUANLI_HEADERS, 'Pending 数据管理');
// Bank：宽容超集模式，兼容新版 46 列文件（忽略多出的「合并单号」「合并状态」）
const validateBankHeaders = buildHeaderValidator(BANK_HEADERS, '银行对账单', { allowSupersetColumns: true });

module.exports = {
  validatePendingGuanliHeaders,
  validateBankHeaders,
  normalizeHeaderCell
};
