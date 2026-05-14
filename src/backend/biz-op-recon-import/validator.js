// v2.1.3 T2 — 业务OP数据核对：表头 + 行校验
// spec §2.3（表头精确匹配）、§5.3（业务OP 双重校验 + 流水出入方向枚举）
// 纯函数，不依赖 SheetJS / SQLite，便于单测
//
// 返回值：{ ok: true } 或 { ok: false, error?: string, reason?: string, detailLines?: string[] }
// 不抛异常；调用方决定是否升级为 FileValidationError

const {
  BIZ_OP_HEADERS,
  FLOW_HEADERS,
  AMOUNT_EPSILON
} = require('../biz-op-recon-db/columns');

// 资金红线 ⚠️ ：epsilon = 1e-2（1 分钱）固化在双重校验
// #1 拍板 B + #6 拍板 A 共用同一精度门槛；v2.1.3-fix7-M2 单一真理来源在 columns.js

// 出入方向枚举（#3 拍板）：仅允许中文「入」/「出」
const VALID_DIRECTION_IN = '入';
const VALID_DIRECTION_OUT = '出';

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

const validateBizOpHeaders = buildHeaderValidator(BIZ_OP_HEADERS, '业务OP账单');
const validateFlowHeaders = buildHeaderValidator(FLOW_HEADERS, '流水对账单');

// 数值解析（容忍千分位 `,` + 首尾空白 + 空字符串）
// 与 src/main-process/biz-op-recon-session.js 的 parseAmount 保持一致，但这里独立实现避免循环依赖
function parseAmount(v) {
  if (v == null || v === '') return NaN;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// 业务 OP 行双重校验（#1 拍板 B，资金红线 ⚠️）
// 校验 (1): 发生额 == 发生额（入） - 发生额（出）  容差 epsilon
// 校验 (2): 期末余额 == 期初余额 + 发生额         容差 epsilon
// 任一不过 → ok=false，reason 含具体公式与差额
function validateBizOpRow(row) {
  const begin = parseAmount(row.begin_balance);
  const amt = parseAmount(row.amount);
  const amtIn = parseAmount(row.amount_in);
  const amtOut = parseAmount(row.amount_out);
  const end = parseAmount(row.end_balance);

  if ([begin, amt, amtIn, amtOut, end].some(Number.isNaN)) {
    return {
      ok: false,
      reason: `字段非数值：期初=${row.begin_balance} 发生额=${row.amount} 入=${row.amount_in} 出=${row.amount_out} 期末=${row.end_balance}`
    };
  }

  // 校验 (1)：发生额 == 入 - 出
  const diff1 = Math.abs(amt - (amtIn - amtOut));
  if (diff1 > AMOUNT_EPSILON) {
    return {
      ok: false,
      reason: `双重校验失败：发生额 ${amt} ≠ 发生额(入) ${amtIn} - 发生额(出) ${amtOut}，差额 ${diff1.toFixed(4)}`
    };
  }

  // 校验 (2)：期末 == 期初 + 发生额
  const diff2 = Math.abs(end - (begin + amt));
  if (diff2 > AMOUNT_EPSILON) {
    return {
      ok: false,
      reason: `双重校验失败：期末余额 ${end} ≠ 期初余额 ${begin} + 发生额 ${amt}，差额 ${diff2.toFixed(4)}`
    };
  }

  return { ok: true };
}

// 流水对账单行校验（#3 拍板，资金红线 ⚠️）
// 1) 出入方向必须严格 ∈ {「入」, 「出」}（trim 后比较；不做大小写归一）
// 2) 对账金额必须可解析为数值
// 3) 账户编号非空
function validateFlowRow(row) {
  const dir = String(row.direction == null ? '' : row.direction).trim();
  if (dir !== VALID_DIRECTION_IN && dir !== VALID_DIRECTION_OUT) {
    return {
      ok: false,
      reason: `出入方向非法：实际值 "${row.direction == null ? '' : row.direction}"，仅允许 "入" 或 "出"`
    };
  }

  const amt = parseAmount(row.recon_amount);
  if (Number.isNaN(amt)) {
    return { ok: false, reason: `对账金额非数值：${row.recon_amount}` };
  }

  if (!String(row.account_no == null ? '' : row.account_no).trim()) {
    return { ok: false, reason: `账户编号为空` };
  }

  return { ok: true };
}

module.exports = {
  AMOUNT_EPSILON,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT,
  validateBizOpHeaders,
  validateFlowHeaders,
  validateBizOpRow,
  validateFlowRow,
  parseAmount,
  normalizeHeaderCell
};
