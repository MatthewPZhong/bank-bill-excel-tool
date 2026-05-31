// v2.1.12 需求1 T-vcc-2 — VCC业务OP计算：表头 + 行校验
// 范式蓝本：src/backend/bank-bu-recon-import/validator.js + biz-op-recon-import/validator.js
// 纯函数，不依赖 SheetJS / SQLite，便于单测。
//
// 返回值：{ ok: true } 或 { ok: false, error?: string, reason?: string, detailLines?: string[] }
// 不抛异常；调用方（reader.js / session）决定是否升级为 FileValidationError / 错误报告。
//
// 资金红线 ⚠️（spec §0.2 / Q8）：
//   - 出入方向必须严格 ∈ {「入」,「出」}，非法值 → 行校验失败 → session 整批拒绝（不静默跳过）
//   - 对账金额空 → 视为 0（计入但不报错，spec Q5：空值跳过/计 0）；非数值 → 整批拒绝

const { FLOW_HEADERS, VALID_DIRECTION_IN, VALID_DIRECTION_OUT } = require('../vcc-op-calc-db/columns');

function normalizeHeaderCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// 流水对账单表头校验（28 列，列数 + 顺序 + 内容三段式，仿 bank-bu-recon validator buildHeaderValidator）
function validateFlowHeaders(actualHeaders) {
  const templateLabel = '流水对账单';
  if (!Array.isArray(actualHeaders)) {
    return { ok: false, error: `${templateLabel} 表头不可读：不是数组`, detailLines: [] };
  }

  const actualLen = actualHeaders.length;
  const expectedLen = FLOW_HEADERS.length;

  if (actualLen !== expectedLen) {
    return {
      ok: false,
      error: `${templateLabel} 表头列数不匹配：模板 ${expectedLen} 列，文件 ${actualLen} 列`,
      detailLines: [
        `模板表头：${FLOW_HEADERS.join(' | ')}`,
        `文件表头：${actualHeaders.map(normalizeHeaderCell).join(' | ')}`
      ]
    };
  }

  const mismatches = [];
  for (let i = 0; i < expectedLen; i++) {
    const actual = normalizeHeaderCell(actualHeaders[i]);
    const expected = FLOW_HEADERS[i];
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
}

// 注：行级校验（出入方向 / 对账金额 / 账单日期月份 / 币种）统一在
//   src/main-process/vcc-op-calc-session.js 的 validateAndExtractRow 实现——它额外要解析月份
//   (extractYearMonth) 与币种、并直接产出整数分 cents（与求和同口径）。故本模块**不**单独提供
//   行校验函数，避免「两套方向/金额校验口径」并存漂移（资金红线单一口径，v2.1.12 self-review 修正）。
//   本模块只负责表头校验（validateFlowHeaders，被 reader 调用）。

module.exports = {
  validateFlowHeaders,
  normalizeHeaderCell,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
};
