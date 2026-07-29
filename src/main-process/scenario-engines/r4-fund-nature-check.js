'use strict';

// v3.0.23：R4 四类资金性质严格匹配。
// 网关原序优先；银行原序次之；四类场景共享银行行 1:1 消费集合。

const {
  ensureRowId,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue
} = require('./engine-utils');
const {
  canonicalizeDecimal,
  absoluteDecimal,
  addCanonicalDecimals
} = require('../financial-decimal');
const {
  BANK_DIRECTION_FIELDS,
  validateBankDirection
} = require('./bank-direction-validator');

const GW_RECON_ID_FIELD = 'reconciliationid';
const GW_TRADE_TYPE_FIELD = 'TradeType';
const GW_MERCHANT_ID_FIELD = 'merchantid';
const GW_CURRENCY_FIELD = 'currency';
const GW_AMOUNT_FIELD = 'amount';
const BANK_RECON_ID_FIELD = 'ReconciliationId';
const BANK_MERCHANT_ID_FIELD = 'MerchantId';
const BANK_CURRENCY_FIELD = 'Currency';
const BANK_FUND_TYPE_FIELD = 'FundType';
const BANK_EXTRA_FEE_FIELD = 'Extra Fee';

const R4_RULES_BY_SUBCATEGORY = Object.freeze({
  'ach-return': Object.freeze({
    subCategory: 'ach-return',
    tradeType: 'AchReturn',
    targetFundType: 'Ach Return',
    amountField: 'Debit Amount',
    oppositeAmountField: 'Credit Amount'
  }),
  'wire-return': Object.freeze({
    subCategory: 'wire-return',
    tradeType: 'WireReturn',
    targetFundType: 'Wire Return',
    amountField: 'Credit Amount',
    oppositeAmountField: 'Debit Amount'
  }),
  'hx-out': Object.freeze({
    subCategory: 'hx-out',
    tradeType: 'HX_OUTBOUND',
    targetFundType: 'HX-out',
    amountField: 'Debit Amount',
    oppositeAmountField: 'Credit Amount'
  }),
  'hx-in': Object.freeze({
    subCategory: 'hx-in',
    tradeType: 'HX_INBOUND',
    targetFundType: 'HX-in',
    amountField: 'Credit Amount',
    oppositeAmountField: 'Debit Amount'
  })
});

function addReason(reasons, reason) {
  if (reason) reasons.add(reason);
}

function canonicalAmount(value, label, options = {}) {
  return canonicalizeDecimal(value, { label, ...options });
}

function r4ExpectedDirection(rule) {
  return rule && rule.amountField === 'Debit Amount' ? 'DEBIT' : 'CREDIT';
}

function addR4DirectionReason(reasons, code, rule) {
  switch (code) {
    case 'expected-empty':
    case 'expected-invalid':
      addReason(reasons, `${rule.amountField}为空或不是合法金额`);
      break;
    case 'expected-zero':
      addReason(reasons, `${rule.amountField}为0`);
      break;
    case 'opposite-invalid':
      addReason(reasons, `${rule.oppositeAmountField}不是合法金额`);
      break;
    case 'opposite-nonzero':
      addReason(reasons, `${rule.oppositeAmountField}非0`);
      break;
    default:
      break;
  }
}

/**
 * 评估一条固定类型网关行与银行行是否完整匹配。错误被折叠为可审计原因，不抛出中断整轮。
 */
function evaluateR4Candidate(gwRow, bankRow, rule) {
  const reasons = new Set();
  const expectedDirection = r4ExpectedDirection(rule);
  const directionResult = validateBankDirection(bankRow, expectedDirection);
  let directionMismatch =
    directionResult.code === 'opposite-invalid' ||
    directionResult.code === 'opposite-nonzero';

  const gwReconId = normalizeCellValue(gwRow && gwRow[GW_RECON_ID_FIELD]);
  const bankReconId = normalizeCellValue(bankRow && bankRow[BANK_RECON_ID_FIELD]);
  if (gwReconId === '' || bankReconId === '') addReason(reasons, '对账ID为空');
  else if (gwReconId !== bankReconId) addReason(reasons, '对账ID不一致');

  const gwMerchantId = normalizeCellValue(gwRow && gwRow[GW_MERCHANT_ID_FIELD]);
  const bankMerchantId = normalizeCellValue(bankRow && bankRow[BANK_MERCHANT_ID_FIELD]);
  if (gwMerchantId === '' || bankMerchantId === '') addReason(reasons, '银行大账号为空');
  else if (gwMerchantId !== bankMerchantId) addReason(reasons, '银行大账号不一致');

  const gwCurrency = normalizeCellValue(gwRow && gwRow[GW_CURRENCY_FIELD]);
  const bankCurrency = normalizeCellValue(bankRow && bankRow[BANK_CURRENCY_FIELD]);
  if (gwCurrency === '' || bankCurrency === '') addReason(reasons, '币种为空');
  else if (gwCurrency !== bankCurrency) addReason(reasons, '币种不一致');

  // R4 既有报告会同时列出“另一侧错误”和“主侧错误”。共享校验器按主侧优先返回单一 code；
  // 当主侧已失败时，用合法主侧探针再次调用同一校验器，仅补出另一侧诊断，保持旧 warning/reason golden。
  const fields = BANK_DIRECTION_FIELDS[expectedDirection];
  const oppositeProbe = validateBankDirection(
    { ...(bankRow || {}), [fields.expectedField]: '1' },
    expectedDirection
  );
  if (oppositeProbe.code === 'opposite-invalid' || oppositeProbe.code === 'opposite-nonzero') {
    directionMismatch = true;
    addR4DirectionReason(reasons, oppositeProbe.code, rule);
  }
  addR4DirectionReason(reasons, directionResult.code, rule);

  let baseAmount = null;
  try {
    baseAmount = absoluteDecimal(bankRow && bankRow[rule.amountField], { label: rule.amountField });
    if (baseAmount === '0') addReason(reasons, `${rule.amountField}为0`);
  } catch (_error) {
    addReason(reasons, `${rule.amountField}为空或不是合法金额`);
  }

  let extraFee = null;
  try {
    extraFee = canonicalAmount(bankRow && bankRow[BANK_EXTRA_FEE_FIELD], BANK_EXTRA_FEE_FIELD, { emptyAsZero: true });
  } catch (_error) {
    addReason(reasons, `${BANK_EXTRA_FEE_FIELD}不是合法金额`);
  }

  let gwAmount = null;
  try {
    gwAmount = canonicalAmount(gwRow && gwRow[GW_AMOUNT_FIELD], '网关 amount');
  } catch (_error) {
    addReason(reasons, '网关 amount 为空或不是合法金额');
  }

  if (baseAmount !== null && baseAmount !== '0' && extraFee !== null && gwAmount !== null) {
    try {
      const bankTotal = addCanonicalDecimals(baseAmount, extraFee, {
        leftLabel: rule.amountField,
        rightLabel: BANK_EXTRA_FEE_FIELD,
        label: '银行方向金额与手续费合计'
      });
      if (bankTotal !== gwAmount) addReason(reasons, '金额与手续费合计不一致');
    } catch (_error) {
      addReason(reasons, '金额与手续费合计无法计算');
    }
  }

  return {
    matched: reasons.size === 0,
    directionMismatch,
    reasons: Array.from(reasons)
  };
}

function enabledR4Rules(r4Scenarios) {
  const enabled = new Map();
  for (const scenario of Array.isArray(r4Scenarios) ? r4Scenarios : []) {
    const subCategory = normalizeCellValue(scenario && scenario.config && scenario.config.subCategory);
    const rule = R4_RULES_BY_SUBCATEGORY[subCategory];
    if (rule) enabled.set(rule.tradeType, rule);
  }
  return enabled;
}

/**
 * @param {Array<Object>} gwRows 本次运行的完整 exactRows，保持链接表 id ASC 原序
 * @param {Array<Object>} bankRows 全量银行行，保持 Excel 原序
 * @param {Array<Object>} r4Scenarios 已启用 R4 场景
 * @returns {{ modifications:Array, warnings:Array, matchedPairs:Array }}
 */
function runRound4FundNatureCheck(gwRows, bankRows, r4Scenarios) {
  const warningCollector = makeWarningCollector('R4', '资金性质校验');
  const modCollector = makeModificationCollector();
  const matchedPairs = [];
  const safeGwRows = Array.isArray(gwRows) ? gwRows : [];
  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const rulesByTradeType = enabledR4Rules(r4Scenarios);

  if (safeGwRows.length === 0 || safeBankRows.length === 0 || rulesByTradeType.size === 0) {
    return {
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list(),
      matchedPairs
    };
  }

  const bankByReconId = new Map();
  safeBankRows.forEach((bankRow, index) => {
    ensureRowId(bankRow, index);
    const reconId = normalizeCellValue(bankRow && bankRow[BANK_RECON_ID_FIELD]);
    if (reconId === '') return;
    if (!bankByReconId.has(reconId)) bankByReconId.set(reconId, []);
    bankByReconId.get(reconId).push(bankRow);
  });

  const consumedBankRows = new Set();

  for (const gwRow of safeGwRows) {
    const tradeType = normalizeCellValue(gwRow && gwRow[GW_TRADE_TYPE_FIELD]);
    const rule = rulesByTradeType.get(tradeType);
    if (!rule) continue;

    const reconId = normalizeCellValue(gwRow && gwRow[GW_RECON_ID_FIELD]);
    if (reconId === '') continue;
    const relatedBankRows = bankByReconId.get(reconId) || [];
    if (relatedBankRows.length === 0) continue;

    const unconsumedRows = relatedBankRows.filter((row) => !consumedBankRows.has(row));
    const evaluated = unconsumedRows.map((bankRow) => ({
      bankRow,
      result: evaluateR4Candidate(gwRow, bankRow, rule)
    }));
    const matched = evaluated.filter((item) => item.result.matched);

    if (matched.length === 0) {
      const reasons = new Set();
      if (unconsumedRows.length === 0) reasons.add('同对账ID候选已被前序网关消费');
      for (const item of evaluated) {
        for (const reason of item.result.reasons) reasons.add(reason);
      }
      const linkedRow = unconsumedRows[0] || relatedBankRows[0];
      warningCollector.push({
        rowId: linkedRow ? linkedRow._rowId : null,
        code: 'r4-fund-match-mismatch',
        reconId,
        message: `R4「${rule.targetFundType}」对账ID「${reconId}」存在银行行，但没有未消费的完整候选（${Array.from(reasons).join('、') || '候选不完整'}）`
      });

      const directionItem = evaluated.find((item) => item.result.directionMismatch);
      if (directionItem) {
        warningCollector.push({
          rowId: directionItem.bankRow._rowId,
          code: 'r4-fund-direction-mismatch',
          reconId,
          message: `R4「${rule.targetFundType}」对账ID「${reconId}」的 ${rule.oppositeAmountField} 非0或不是合法金额，方向不符，跳过改写`
        });
      }
      continue;
    }

    const chosen = matched[0].bankRow;
    if (matched.length > 1) {
      warningCollector.push({
        rowId: chosen._rowId,
        code: 'r4-fund-multi-candidate',
        reconId,
        message: `R4「${rule.targetFundType}」对账ID「${reconId}」匹配到 ${matched.length} 条完整银行候选，按银行原序取第一条`
      });
    }

    consumedBankRows.add(chosen);
    const oldValue = normalizeCellValue(chosen[BANK_FUND_TYPE_FIELD]);
    const changed = oldValue !== rule.targetFundType;
    // v3.0.23 增补：匹配关系与字段修改分离。no-op 也必须向 R5 传递具体 AchReturn 配对，
    // 但不得伪造 modification 或标黄；bankRow/gwRow 保留原对象身份，禁止按 ReconID 扩散。
    matchedPairs.push({
      gwRow,
      bankRow: chosen,
      subCategory: rule.subCategory,
      targetFundType: rule.targetFundType,
      changed
    });
    if (changed) {
      chosen[BANK_FUND_TYPE_FIELD] = rule.targetFundType;
      modCollector.record(chosen._rowId, BANK_FUND_TYPE_FIELD, oldValue, rule.targetFundType);
    }
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list(),
    matchedPairs
  };
}

module.exports = {
  runRound4FundNatureCheck,
  evaluateR4Candidate,
  R4_RULES_BY_SUBCATEGORY,
  GW_RECON_ID_FIELD,
  GW_TRADE_TYPE_FIELD,
  BANK_RECON_ID_FIELD,
  BANK_FUND_TYPE_FIELD
};
