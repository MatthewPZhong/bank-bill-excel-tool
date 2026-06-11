// v3.0.4 块 F「Payment线下调拨订单回填处理」R5 场景2b 引擎（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F5（拍板结论 Q1-Q6 已并入）
//
// 业务语义：
//   订单池 = 中台调拨订单中「收款账户（卡号）」===bigAccount ∧「付款渠道」===bankChannel 的行，
//   取调拨单号 FTA+8位日期派生「订单对账周数号」（weekTag）。
//   银行池 = 银行对账单中 MerchantId===bigAccount ∧ FundType==='FundTransfer-in' ∧ 地区===region 的行，
//   按 BillDate 派生「银行对账周数号」。构池前先剔除 excludeBankRowIds（🔴 Q3 网关回填优先不变量）。
//   join：银行周 = 订单周 + 1（weekTagPlusOne 日期语义，禁 YYWW 数字加法）。
//   主轮：'Credit Amount'↔收款金额（Math.round(*100) 分）∧ Currency↔收款币种 ∧ BillDate 晚于交易时间
//         （✅ Q6 同日算晚于·日粒度：BillDate 取日 ≥ 交易时间取日）→ 候选按天数差升序稳定排序贪心
//         （tie=原序）；bank 按 BillDate 升序消费；严格 1v1 usedSet。
//   差错池（✅ Q5）：金额币种相等但 BillDate（日）严格早于交易时间（日）→ 入差错池；主轮后二轮与
//         **全部未消费订单**（放宽周数约束）同条件（含 Q6 晚于口径）+就近再匹配；usedSet 与主轮共享。
//   回填：订单['渠道流水号'] → bank.ReconciliationId（命中即覆盖，含非空原值；nv 空 / 同值不写不标黄）。
//
// 🔒 引擎不变量（✅ Q3 网关回填优先）：编排器先跑 R5s2（既有顺序），其已消费/已回填的 bank _rowId 经
//   options.excludeBankRowIds 传入 → 本引擎构池时剔除 → 两引擎零互相覆盖（单测含互斥断言）。
//
// 跨表字段一律走 payment-offline-allocation-fields.js（显式映射，绝不假设同名）。
// 纯函数：入参 rows 数组，不读 DB/session（由 main.js 注入）；与场景2/3/4 独立 usedSet，不串池。
//
// ⚠️ 资金红线：列名映射 / 周数口径 / FTA 解析 / 就近 tie-break / 晚于口径 任一错位都会写错 ReconciliationId。

const {
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');
const { toDate } = require('./engine-date-utils');
const { weekTag, weekTagPlusOne, weekTagToNumber } = require('./engine-week-utils');
const { parseFtaDate } = require('./engine-week-utils');
const { PAYMENT_OFFLINE_FIELD_MAP: F } = require('../../constants/payment-offline-allocation-fields');

const MS_PER_DAY = 86400000;

// 银行发生额（单列 'Credit Amount'，含空格）；非数值 → null
function bankCreditAmount(bankRow) {
  return parseNumber(bankRow && bankRow[F.bank.creditAmount]);
}

// 订单收款金额；非数值 → null
function midPayeeAmount(midRow) {
  return parseNumber(midRow && midRow[F.mid.payeeAmount]);
}

// 金额精确到分相等（两侧都必须是有限数，否则不命中 —— 沿 r5-fund-transfer-backfill amountEqual 口径）
function amountEqual(midRow, bankRow) {
  const bankAmt = bankCreditAmount(bankRow);
  const midAmt = midPayeeAmount(midRow);
  if (bankAmt === null || midAmt === null) return false;
  if (!Number.isFinite(bankAmt) || !Number.isFinite(midAmt)) return false;
  return Math.round(bankAmt * 100) === Math.round(midAmt * 100);
}

// 金额 + 币种相等（差错池入池与主轮共用的「值相等」判据，不含日期）
function amountCurrencyEqual(midRow, bankRow) {
  return (
    amountEqual(midRow, bankRow) &&
    valuesEqual(midRow && midRow[F.mid.payeeCurrency], bankRow && bankRow[F.bank.currency])
  );
}

// 取「本地午夜」整天毫秒（用于日粒度比较）；无法解析 → null
function dayMs(value) {
  const d = toDate(value);
  return d ? d.getTime() : null;
}

// ✅ Q6 晚于（日粒度·同日算晚于）：bank.BillDate 取日 ≥ mid.交易时间 取日 → true
//   任一无法解析 → false（不命中，防 NaN 误判）
function billDateNotEarlier(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return false;
  return b >= m;
}

// 差错池「早于」（日粒度·严格小于）：bank.BillDate 取日 < mid.交易时间 取日 → true
//   与 billDateNotEarlier 互斥分区完备（两侧均可解析时恰好二选一）。
function billDateEarlier(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return false;
  return b < m;
}

// 银行行与订单的天数差绝对值（就近排序键）；任一无法解析 → +Infinity
function dayDiffAbs(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((b - m) / MS_PER_DAY));
}

/**
 * R5 场景2b：Payment线下调拨订单回填 ReconciliationId。
 *
 * @param {Array<Object>} bankRows          银行对账单行（带 _rowId；R1~R5s2 后的当前值）
 * @param {Array<Object>} midAllocationRows 中台调拨订单行（链接表读回，中文 26 列）
 * @param {Object} [options]
 * @param {string} [options.bigAccount]   大账号（订单池 收款账户（卡号） + 银行池 MerchantId）
 * @param {string} [options.bankChannel]  银行渠道（订单池 付款渠道）
 * @param {string} [options.region]       地区（银行池 地区列）
 * @param {Set|Array} [options.excludeBankRowIds] R5s2 已消费/已回填 bank _rowId（🔴 Q3 剔除）
 * @returns {{ modifications: Array, warnings: Array }}
 */
function runRound5PaymentOfflineAllocationBackfill(bankRows, midAllocationRows, options = {}) {
  const warn = makeWarningCollector('r5-payment-offline-allocation-backfill', 'Payment线下调拨订单回填处理');
  const modCollector = makeModificationCollector();

  const safeBankRows = Array.isArray(bankRows) ? bankRows : [];
  const safeMidRows = Array.isArray(midAllocationRows) ? midAllocationRows : [];

  const bigAccount = normalizeCellValue(options.bigAccount);
  const bankChannel = normalizeCellValue(options.bankChannel);
  const region = normalizeCellValue(options.region);
  const excludeSet = options.excludeBankRowIds instanceof Set
    ? options.excludeBankRowIds
    : new Set(Array.isArray(options.excludeBankRowIds) ? options.excludeBankRowIds : []);

  const emptyResult = () => ({
    modifications: modCollector.listModifications(),
    warnings: warn.list()
  });

  // 配置缺失（三项任一空）→ 无法构池，安全 no-op（编排器 gating 已挡，这里再兜底）
  if (bigAccount === '' || bankChannel === '' || region === '') {
    return emptyResult();
  }
  if (safeBankRows.length === 0 || safeMidRows.length === 0) {
    return emptyResult();
  }

  // ===== ① 订单池：收款账户（卡号）===bigAccount ∧ 付款渠道===bankChannel =====
  //   逐行 parseFtaDate → 订单周数号；FTA 不合规的【筛中行】计 warning（不静默，三态不变量），未筛中行跳过。
  const orderPool = [];
  for (const mid of safeMidRows) {
    if (normalizeCellValue(mid && mid[F.mid.payeeAccountCard]) !== bigAccount) continue;
    if (normalizeCellValue(mid && mid[F.mid.payChannel]) !== bankChannel) continue;
    const ftaDate = parseFtaDate(mid && mid[F.mid.dispatchNo]);
    const orderWeek = ftaDate ? weekTag(ftaDate) : null;
    if (!orderWeek) {
      // D4：筛中订单池但 FTA 不合规 → warning（订单侧未匹配仅对账单侧进 report，故此处 rowId=null）
      warn.push({
        rowId: null,
        code: 'payment-offline-invalid-fta',
        message: `订单「调拨单号」=${normalizeCellValue(mid && mid[F.mid.dispatchNo])} 非法 FTA+8位日期，无法计算订单对账周数号，已跳过`
      });
      continue;
    }
    // 存已解析的 ftaDate（步骤③ weekTagPlusOne 直接复用，免二次 parseFtaDate）；
    //   orderWeek 仅用于上面的合规 gating，订单周数号本身后续无消费方，故不入池。
    orderPool.push({ row: mid, ftaDate });
  }

  // ===== ② 银行池：MerchantId===bigAccount ∧ FundType===FundTransfer-in ∧ 地区===region =====
  //   构池前先剔除 excludeBankRowIds（🔴 Q3 网关回填优先不变量）；BillDate → 银行周数号。
  const bankPool = [];
  for (const bank of safeBankRows) {
    if (excludeSet.has(bank && bank._rowId)) continue;
    if (normalizeCellValue(bank && bank[F.bank.merchantId]) !== bigAccount) continue;
    if (normalizeCellValue(bank && bank[F.bank.fundType]) !== F.FUND_TYPE_IN) continue;
    if (normalizeCellValue(bank && bank[F.bank.region]) !== region) continue;
    const bankWeek = weekTag(bank && bank[F.bank.billDate]);
    bankPool.push({ row: bank, bankWeekNum: weekTagToNumber(bankWeek) });
  }

  if (orderPool.length === 0 || bankPool.length === 0) {
    return emptyResult();
  }

  // ===== ③ 周数 join：订单按周数号 Map 分组；银行行按「其周 = 订单周+1」查桶（weekTagPlusOne 日期语义）=====
  //   订单分桶用「订单周+1 后的 number」做 key（= 银行应落桶），等价于银行直接用 bankWeekNum 命中。
  const ordersByPlusOneWeek = new Map();
  for (const ord of orderPool) {
    const plusOne = weekTagPlusOne(ord.ftaDate); // 复用步骤① 已解析的 ftaDate（不再二次 parseFtaDate）
    const key = weekTagToNumber(plusOne);
    if (key === null) continue;
    if (!ordersByPlusOneWeek.has(key)) ordersByPlusOneWeek.set(key, []);
    ordersByPlusOneWeek.get(key).push(ord);
  }

  const usedBankRowId = new Set();  // 严格 1v1（主轮 + 差错池二轮共享）
  const usedOrderSet = new WeakSet(); // 订单消费标记（跨两轮共享，防重复消费）

  // 回填动作（标准写法：nv=normalizeCellValue、old!==nv 才写 + record；命中即覆盖含非空原值）
  const backfill = (orderRow, bankRow) => {
    usedBankRowId.add(bankRow._rowId);
    usedOrderSet.add(orderRow);
    const nv = normalizeCellValue(orderRow[F.mid.channelSerialNo]);
    const old = normalizeCellValue(bankRow[F.bank.reconciliationId]);
    if (nv !== '' && old !== nv) {
      bankRow[F.bank.reconciliationId] = nv;
      modCollector.record(bankRow._rowId, F.bank.reconciliationId, old, nv);
    }
    // nv 空（订单无渠道流水号）或同值 → 不写不标黄，但仍消费（1v1 红线不变）
  };

  // 银行行按 BillDate 升序消费（沿 R5s4 口径：早→晚；无法解析排最后，保持原序稳定）
  const orderedBank = [...bankPool].sort((a, b) => {
    const da = dayMs(a.row[F.bank.billDate]);
    const db = dayMs(b.row[F.bank.billDate]);
    const ta = da === null ? Number.POSITIVE_INFINITY : da;
    const tb = db === null ? Number.POSITIVE_INFINITY : db;
    return ta - tb;
  });

  const errorPool = []; // 差错池：金额币种相等但 BillDate（日）严格早于交易时间（日）的 bank 行

  // ===== ④ 主轮匹配（周数 join 内）=====
  for (const bankEntry of orderedBank) {
    const bankRow = bankEntry.row;
    if (usedBankRowId.has(bankRow._rowId)) continue;
    const bucket = ordersByPlusOneWeek.get(bankEntry.bankWeekNum) || [];

    // 候选 = 同桶内未消费订单 ∧ 金额币种相等 ∧ Q6 晚于（同日算晚于）
    const cands = bucket.filter(
      (ord) =>
        !usedOrderSet.has(ord.row) &&
        amountCurrencyEqual(ord.row, bankRow) &&
        billDateNotEarlier(bankRow, ord.row)
    );

    // 差错池入池判定（金额币种相等但日期严格早于）—— 与主轮候选互斥分区
    //   只要本桶存在「金额币种相等 ∧ 严格早于」的未消费订单，则该 bank 行进差错池二轮（即便主轮无候选）。
    if (cands.length === 0) {
      const earlierExists = bucket.some(
        (ord) => !usedOrderSet.has(ord.row) && amountCurrencyEqual(ord.row, bankRow) && billDateEarlier(bankRow, ord.row)
      );
      if (earlierExists) errorPool.push(bankRow);
      continue;
    }

    // 就近：按天数差升序稳定排序贪心取最近（tie=原序 first-wins）
    cands.sort((a, b) => dayDiffAbs(bankRow, a.row) - dayDiffAbs(bankRow, b.row));
    if (cands.length > 1) {
      warn.push({
        rowId: bankRow._rowId,
        code: 'payment-offline-multi-candidate',
        phase: 'main',
        message: `银行行匹配到 ${cands.length} 条可用订单候选（主轮·周数+1），按就近取最近一条`
      });
    }
    backfill(cands[0].row, bankRow);
  }

  // ===== ⑤ 差错池二轮（✅ Q5 放宽周数）=====
  //   范围 = 全部未被消费订单（不限「周数+1」）；条件 = 金额币种相等 ∧ Q6 晚于（同日算）；就近；usedSet 共享。
  for (const bankRow of errorPool) {
    if (usedBankRowId.has(bankRow._rowId)) continue; // 主轮可能已被其它逻辑消费（防御）
    const cands = orderPool.filter(
      (ord) =>
        !usedOrderSet.has(ord.row) &&
        amountCurrencyEqual(ord.row, bankRow) &&
        billDateNotEarlier(bankRow, ord.row)
    );
    if (cands.length === 0) {
      // 差错池仍未匹配 → 对账单侧未匹配 warning（带 _rowId，供 bank-recon-output-fixes F3 enrich 反查）
      warn.push({
        rowId: bankRow._rowId,
        code: 'payment-offline-no-order-match',
        phase: 'error-pool',
        message: '银行行（差错池二轮）金额币种相等但未匹配到任何晚于交易时间的订单'
      });
      continue;
    }
    cands.sort((a, b) => dayDiffAbs(bankRow, a.row) - dayDiffAbs(bankRow, b.row));
    if (cands.length > 1) {
      warn.push({
        rowId: bankRow._rowId,
        code: 'payment-offline-multi-candidate',
        phase: 'error-pool',
        message: `银行行匹配到 ${cands.length} 条可用订单候选（差错池二轮·放宽周数），按就近取最近一条`
      });
    }
    backfill(cands[0].row, bankRow);
  }

  // ===== 收尾：主轮无候选且非差错池的银行行 → 对账单侧未匹配 warning（三态不变量，绝不静默消失）=====
  //   排除已回填 / 已进差错池（差错池已在二轮各自落 warning）的行。
  const errorPoolSet = new Set(errorPool.map((b) => b._rowId));
  for (const bankEntry of orderedBank) {
    const bankRow = bankEntry.row;
    if (usedBankRowId.has(bankRow._rowId)) continue;
    if (errorPoolSet.has(bankRow._rowId)) continue;
    warn.push({
      rowId: bankRow._rowId,
      code: 'payment-offline-no-order-match',
      phase: 'main',
      message: '银行行（Payment线下调拨）未匹配到任何符合金额币种且晚于交易时间的订单'
    });
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warn.list()
  };
}

module.exports = {
  runRound5PaymentOfflineAllocationBackfill,
  // 内部子函数导出便于单测精确覆盖
  amountEqual,
  amountCurrencyEqual,
  billDateNotEarlier,
  billDateEarlier,
  bankCreditAmount,
  midPayeeAmount
};
