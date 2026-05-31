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

// 数值解析（容忍千分位 `,` + 首尾空白；空字符串 → NaN，由调用方区分空值/非法）
// 与 biz-op-recon validator parseAmount 一致；独立实现避免循环依赖。
function parseAmount(v) {
  if (v == null || v === '') return NaN;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// 流水行校验（资金红线 ⚠️，spec §0.2 / Q8）：
//   1) 出入方向必须严格 ∈ {「入」,「出」}（trim 后比较；不做大小写归一）→ 非法 → 整批拒绝
//   2) 对账金额：空字符串视为合法（计 0，spec Q5）；非空且非数值 → 整批拒绝
// 注意：本模块不校验账户编号（与第 5 模块对账不同，本模块只按方向求和，不做账户匹配）。
function validateFlowRow(row) {
  const dirRaw = row.direction == null ? '' : row.direction;
  const dir = String(dirRaw).trim();
  if (dir !== VALID_DIRECTION_IN && dir !== VALID_DIRECTION_OUT) {
    return {
      ok: false,
      reason: `出入方向非法：实际值 "${dirRaw}"，仅允许 "入" 或 "出"`
    };
  }

  const amtRaw = row.recon_amount;
  const amtTrimmed = String(amtRaw == null ? '' : amtRaw).trim();
  if (amtTrimmed !== '') {
    const amt = parseAmount(amtRaw);
    if (Number.isNaN(amt)) {
      return { ok: false, reason: `对账金额非数值：${amtRaw}` };
    }
  }

  return { ok: true };
}

module.exports = {
  validateFlowHeaders,
  validateFlowRow,
  parseAmount,
  normalizeHeaderCell,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
};
