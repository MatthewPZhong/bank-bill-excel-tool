'use strict';

const CANONICAL_FUND_TRANSFER_DIRECTIONS = Object.freeze([
  Object.freeze({
    gwTradeType: 'FundTransfer-out',
    bankFundType: 'FundTransfer-out',
    expectedBankDirection: 'DEBIT'
  }),
  Object.freeze({
    gwTradeType: 'FundTransfer-in',
    bankFundType: 'FundTransfer-in',
    expectedBankDirection: 'CREDIT'
  })
]);

const DEFAULT_FUND_TRANSFER_DATE_POLICY = Object.freeze({
  enabled: true,
  toleranceDays: 1
});

function normalizeFundTransferDatePolicy(options = {}) {
  const nested = options && options.fundTransferDatePolicy;
  const hasNested = nested && typeof nested === 'object' && !Array.isArray(nested);
  const enabledRaw = hasNested ? nested.enabled : options.dateMatchEnabled;
  const toleranceRaw = hasNested ? nested.toleranceDays : options.dateToleranceDays;

  const enabled = typeof enabledRaw === 'boolean'
    ? enabledRaw
    : DEFAULT_FUND_TRANSFER_DATE_POLICY.enabled;
  const toleranceDays = Number.isFinite(toleranceRaw)
    ? toleranceRaw
    : DEFAULT_FUND_TRANSFER_DATE_POLICY.toleranceDays;

  return Object.freeze({ enabled, toleranceDays });
}

function validateFundTransferDirections(directions, options = {}) {
  // 旧的纯引擎调用未显式传 config 时仍使用代码级安全常量；一旦显式传入，
  // 必须完整且唯一地包含 canonical 两对，不能部分执行或降级成“不要求方向”。
  if (directions === undefined && options.allowDefault === true) {
    return { ok: true, directions: CANONICAL_FUND_TRANSFER_DIRECTIONS };
  }
  if (!Array.isArray(directions) || directions.length !== CANONICAL_FUND_TRANSFER_DIRECTIONS.length) {
    return { ok: false, directions: [], reason: 'directions 必须且只能包含 FundTransfer-out/in 两个唯一配对' };
  }

  const expectedByPair = new Map(
    CANONICAL_FUND_TRANSFER_DIRECTIONS.map((item) => [
      `${item.gwTradeType}\u0000${item.bankFundType}`,
      item
    ])
  );
  const seen = new Set();
  const normalized = [];
  for (const item of directions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, directions: [], reason: 'directions 含非对象项' };
    }
    const key = `${String(item.gwTradeType ?? '')}\u0000${String(item.bankFundType ?? '')}`;
    const canonical = expectedByPair.get(key);
    if (!canonical || seen.has(key)) {
      return { ok: false, directions: [], reason: 'directions 含重复、未知或 FundTransfer-in/out 错配项' };
    }
    seen.add(key);
    normalized.push(canonical);
  }

  if (seen.size !== expectedByPair.size) {
    return { ok: false, directions: [], reason: 'directions 缺少 FundTransfer-out 或 FundTransfer-in 配对' };
  }
  return { ok: true, directions: normalized };
}

module.exports = {
  CANONICAL_FUND_TRANSFER_DIRECTIONS,
  DEFAULT_FUND_TRANSFER_DATE_POLICY,
  normalizeFundTransferDatePolicy,
  validateFundTransferDirections
};
