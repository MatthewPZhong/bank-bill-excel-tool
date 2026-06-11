// v3.0.4 块 F「Payment线下调拨订单回填处理」R5 场景2b 引擎（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F5 + 修订 R2（2026-06-12，Q9-Q14 拍板）
//
// 业务语义（修订 R2：钱先动、单后补 + 三轮阶梯）：
//   线下调拨「钱先动、单后补」——交易时间 ≈ BillDate（多数同日），FTA 单号日期在其后约一周补录，
//   故周数 join 方向为「银行周 + 1 = 订单周」（weekTagPlusOne 挪到银行侧，日期语义，禁 YYWW 数字加法）。
//
//   订单池 = 中台调拨订单中三条件全真的行（修订 R2 Q10）：
//     收款账户（卡号）===bigAccount ∧ 付款方式===OFFLINE_PAY_METHOD('线下') ∧ 收款渠道===bankChannel。
//     （初版筛「付款渠道」===bankChannel 在线下场景命中的全是线上 CFT 单——付款渠道=出款行 BGL，
//      收款渠道才是账单所属渠道 CITI；故翻转为「收款渠道」并加「付款方式=线下」剔线上单。）
//     取调拨单号 FTA+8位日期派生订单判断日期（weekTag）；FTA 不合规的【筛中行】计 warning（不静默，三态不变量）。
//   银行池 = 银行对账单中 MerchantId===bigAccount ∧ FundType==='FundTransfer-in' ∧ 地区===region 的行，
//     按 BillDate 派生「银行对账周数号」。构池前先剔除 excludeBankRowIds（🔴 Q3 网关回填优先不变量）。
//   join：银行周 = 订单周 + 1 —— 订单按 weekTagToNumber(weekTag(ftaDate)) 分桶，
//     银行行用 weekTagToNumber(weekTagPlusOne(BillDate)) 查桶（weekTagPlusOne 在银行侧，日期语义）。
//
//   三轮阶梯匹配（修订 R2 取代「主轮 + 差错池」；三轮共享 usedBankRowId/usedOrderSet，每轮银行行按
//     BillDate 升序消费、候选按天数差升序稳定排序贪心 tie=原序）：
//     R1 主轮（phase 'main'）：周桶 ∧ 金额币种相等 ∧ BillDate ≥ 交易时间
//          （✅ Q6 同日算晚于·日粒度：BillDate 取日 ≥ 交易时间取日）；
//     R2 容差轮（phase 'date-tolerance'）：周桶 ∧ 金额币种相等 ∧ BillDate ≥ 交易时间 − txLagToleranceDays(2) 天
//          （救后台录单滞后：实测晚 1 天 9 笔 / 晚 2 天 1 笔）；
//     R3 兜底轮（phase 'relaxed-week'）：全部未消费订单（不限周）∧ 金额币种相等 ∧
//          |BillDate − 交易时间| ≤ relaxedWindowDays(7) 天就近（救跨周界错位 6 笔）。
//     容差/窗口常量收口 payment-offline-allocation-fields.js MATCH_RULES（不做 UI 配置项）。
//   回填：订单['渠道流水号'] → bank.ReconciliationId（命中即覆盖，含非空原值；nv 空 / 同值不写不标黄但仍消费）。
//   三态不变量：三轮后仍未消费的银行池行 → payment-offline-no-order-match warning（code 不新增，phase 标轮次）。
//
// 🔒 引擎不变量（✅ Q3 网关回填优先）：编排器先跑 R5s2（既有顺序），其已消费/已回填的 bank _rowId 经
//   options.excludeBankRowIds 传入 → 本引擎构池时剔除 → 两引擎零互相覆盖（单测含互斥断言）。
//
// 跨表字段一律走 payment-offline-allocation-fields.js（显式映射，绝不假设同名）。
// 纯函数：入参 rows 数组，不读 DB/session（由 main.js 注入）；与场景2/3/4 独立 usedSet，不串池。
//
// 返回值（修订 R2 Q14）：{ modifications, warnings, matchedPairs }；matchedPairs 每项 =
//   { bankRow, orderRow, round('main'|'date-tolerance'|'relaxed-week'), oldReconciliationId, dayDiff }
//   （oldReconciliationId 在 backfill 覆盖前捕获，无论是否实写都记录；dayDiff = 带符号日粒度差
//    BillDate − 交易时间，负值=BillDate 早于交易时间，R2 救回的倒挂行方向可见）——供导出 3 核对 sheet。
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
const { txLagToleranceDays: TX_LAG_TOLERANCE_DAYS, relaxedWindowDays: RELAXED_WINDOW_DAYS } = F.MATCH_RULES;

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

// 金额 + 币种相等（三轮共用的「值相等」判据，不含日期）
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
//   任一无法解析 → false（不命中，防 NaN 误判）。用于 R1 主轮。
function billDateNotEarlier(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return false;
  return b >= m;
}

// R2 容差轮日期判据（日粒度）：bank.BillDate 取日 ≥ mid.交易时间 取日 − toleranceDays 天 → true
//   即允许 BillDate 比交易时间早至多 toleranceDays 天（救后台录单滞后导致 BillDate < 交易时间）。
//   任一无法解析 → false。
function billDateWithinLag(bankRow, midRow, toleranceDays) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return false;
  return b >= m - toleranceDays * MS_PER_DAY;
}

// R3 兜底轮日期判据（日粒度·双向窗口）：|BillDate − 交易时间| ≤ windowDays 天 → true
//   任一无法解析 → false。
function billDateWithinWindow(bankRow, midRow, windowDays) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return false;
  return Math.abs(b - m) <= windowDays * MS_PER_DAY;
}

// 银行行与订单的天数差绝对值（就近排序键）；任一无法解析 → +Infinity
function dayDiffAbs(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((b - m) / MS_PER_DAY));
}

// 银行行与订单的【带符号】天数差（BillDate − 交易时间，日粒度）—— matchedPairs 展示用（核对 sheet「天数差」列）。
//   负值 = BillDate 早于交易时间（R2 容差轮救回的录单滞后倒挂行 −1/−2）；同日 = 0；任一无法解析 → null。
//   ⚠️ 仅供展示；就近匹配排序键恒用 dayDiffAbs（绝对值），方向不参与贪心排序。
function dayDiffSigned(bankRow, midRow) {
  const b = dayMs(bankRow && bankRow[F.bank.billDate]);
  const m = dayMs(midRow && midRow[F.mid.txTime]);
  if (b === null || m === null) return null;
  return Math.round((b - m) / MS_PER_DAY);
}

/**
 * R5 场景2b：Payment线下调拨订单回填 ReconciliationId（修订 R2：方向翻转 + 三轮阶梯）。
 *
 * @param {Array<Object>} bankRows          银行对账单行（带 _rowId；R1~R5s2 后的当前值）
 * @param {Array<Object>} midAllocationRows 中台调拨订单行（链接表读回，中文 26 列）
 * @param {Object} [options]
 * @param {string} [options.bigAccount]   大账号（订单池 收款账户（卡号） + 银行池 MerchantId）
 * @param {string} [options.bankChannel]  银行渠道 / 账单所属渠道（订单池 收款渠道）
 * @param {string} [options.region]       地区（银行池 地区列）
 * @param {Set|Array} [options.excludeBankRowIds] R5s2 已消费/已回填 bank _rowId（🔴 Q3 剔除）
 * @returns {{ modifications: Array, warnings: Array, matchedPairs: Array }}
 *   matchedPairs 项 = { bankRow, orderRow, round, oldReconciliationId, dayDiff }
 *   （dayDiff 为带符号日粒度差 BillDate − 交易时间：负值=BillDate 早于交易时间，R2 救回的倒挂行可见方向）
 */
function runRound5PaymentOfflineAllocationBackfill(bankRows, midAllocationRows, options = {}) {
  const warn = makeWarningCollector('r5-payment-offline-allocation-backfill', 'Payment线下调拨订单回填处理');
  const modCollector = makeModificationCollector();
  const matchedPairs = [];

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
    warnings: warn.list(),
    matchedPairs
  });

  // 配置缺失（三项任一空）→ 无法构池，安全 no-op（编排器 gating 已挡，这里再兜底）
  if (bigAccount === '' || bankChannel === '' || region === '') {
    return emptyResult();
  }
  if (safeBankRows.length === 0 || safeMidRows.length === 0) {
    return emptyResult();
  }

  // ===== ① 订单池（修订 R2 Q10 三条件）=====
  //   收款账户（卡号）===bigAccount ∧ 付款方式===OFFLINE_PAY_METHOD ∧ 收款渠道===bankChannel。
  //   逐行 parseFtaDate → 订单判断日期；FTA 不合规的【筛中行】计 warning（不静默，三态不变量），未筛中行跳过。
  const orderPool = [];
  for (const mid of safeMidRows) {
    if (normalizeCellValue(mid && mid[F.mid.payeeAccountCard]) !== bigAccount) continue;
    if (normalizeCellValue(mid && mid[F.mid.payMethod]) !== F.OFFLINE_PAY_METHOD) continue;
    if (normalizeCellValue(mid && mid[F.mid.receiveChannel]) !== bankChannel) continue;
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
    // 存已解析的 ftaDate（步骤③ weekTag/weekTagPlusOne 直接复用，免二次 parseFtaDate）。
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
    // 银行周 = weekTagPlusOne(BillDate)（修订 R2：+1 挪到银行侧，日期语义）→ 直接落「订单周 + 1」桶
    const bankWeek = weekTagPlusOne(bank && bank[F.bank.billDate]);
    bankPool.push({ row: bank, bankWeekNum: weekTagToNumber(bankWeek) });
  }

  if (orderPool.length === 0 || bankPool.length === 0) {
    return emptyResult();
  }

  // ===== ③ 周数 join（修订 R2：银行周 + 1 = 订单周）=====
  //   订单按 weekTagToNumber(weekTag(ftaDate)) 分桶（订单本周）；银行行用 weekTagToNumber(weekTagPlusOne(BillDate))
  //   查桶（银行 +1 周 = 订单周）。weekTagPlusOne 在银行侧（②已算入 bankWeekNum）。
  const ordersByWeek = new Map();
  for (const ord of orderPool) {
    const key = weekTagToNumber(weekTag(ord.ftaDate)); // 复用步骤① 已解析的 ftaDate
    if (key === null) continue;
    if (!ordersByWeek.has(key)) ordersByWeek.set(key, []);
    ordersByWeek.get(key).push(ord);
  }

  const usedBankRowId = new Set();  // 严格 1v1（三轮共享）
  const usedOrderSet = new WeakSet(); // 订单消费标记（三轮共享，防重复消费）

  // 回填动作（标准写法：nv=normalizeCellValue、old!==nv 才写 + record；命中即覆盖含非空原值）。
  //   oldReconciliationId 在覆盖前捕获，记入 matchedPairs（无论是否实写）。
  const backfill = (orderRow, bankRow, round) => {
    usedBankRowId.add(bankRow._rowId);
    usedOrderSet.add(orderRow);
    const nv = normalizeCellValue(orderRow[F.mid.channelSerialNo]);
    const old = normalizeCellValue(bankRow[F.bank.reconciliationId]);
    if (nv !== '' && old !== nv) {
      bankRow[F.bank.reconciliationId] = nv;
      modCollector.record(bankRow._rowId, F.bank.reconciliationId, old, nv);
    }
    // nv 空（订单无渠道流水号）或同值 → 不写不标黄，但仍消费（1v1 红线不变）
    //   dayDiff 用带符号差（展示用，方向可见）；就近排序键仍是 dayDiffAbs（见下方 runRound）。
    matchedPairs.push({
      bankRow,
      orderRow,
      round,
      oldReconciliationId: old,
      dayDiff: dayDiffSigned(bankRow, orderRow)
    });
  };

  // 银行行按 BillDate 升序消费（沿 R5s4 口径：早→晚；无法解析排最后，保持原序稳定）
  const orderedBank = [...bankPool].sort((a, b) => {
    const da = dayMs(a.row[F.bank.billDate]);
    const db = dayMs(b.row[F.bank.billDate]);
    const ta = da === null ? Number.POSITIVE_INFINITY : da;
    const tb = db === null ? Number.POSITIVE_INFINITY : db;
    return ta - tb;
  });

  // 通用单轮匹配：对每条未消费银行行，从其候选订单中按天数差升序贪心取最近回填。
  //   candidateOf(bankRow) → 该轮候选订单数组（已剔已消费、已应用本轮条件）。
  //   phase → multi-candidate warning 的轮次标记。
  const runRound = (round, candidateOf) => {
    for (const bankEntry of orderedBank) {
      const bankRow = bankEntry.row;
      if (usedBankRowId.has(bankRow._rowId)) continue;
      const cands = candidateOf(bankEntry).filter((ord) => !usedOrderSet.has(ord.row));
      if (cands.length === 0) continue;
      // 就近：按天数差升序稳定排序贪心取最近（tie=原序 first-wins）
      cands.sort((a, b) => dayDiffAbs(bankRow, a.row) - dayDiffAbs(bankRow, b.row));
      if (cands.length > 1) {
        warn.push({
          rowId: bankRow._rowId,
          code: 'payment-offline-multi-candidate',
          phase: round,
          message: `银行行匹配到 ${cands.length} 条可用订单候选（${round}），按就近取最近一条`
        });
      }
      backfill(cands[0].row, bankRow, round);
    }
  };

  // ===== ④ R1 主轮：周桶 ∧ 金额币种相等 ∧ BillDate ≥ 交易时间（Q6 同日算晚于）=====
  runRound('main', (bankEntry) => {
    const bucket = ordersByWeek.get(bankEntry.bankWeekNum) || [];
    return bucket.filter(
      (ord) => amountCurrencyEqual(ord.row, bankEntry.row) && billDateNotEarlier(bankEntry.row, ord.row)
    );
  });

  // ===== ⑤ R2 容差轮：周桶 ∧ 金额币种相等 ∧ BillDate ≥ 交易时间 − txLagToleranceDays =====
  runRound('date-tolerance', (bankEntry) => {
    const bucket = ordersByWeek.get(bankEntry.bankWeekNum) || [];
    return bucket.filter(
      (ord) => amountCurrencyEqual(ord.row, bankEntry.row)
        && billDateWithinLag(bankEntry.row, ord.row, TX_LAG_TOLERANCE_DAYS)
    );
  });

  // ===== ⑥ R3 兜底轮：全部未消费订单（不限周）∧ 金额币种相等 ∧ |BillDate − 交易时间| ≤ relaxedWindowDays =====
  runRound('relaxed-week', (bankEntry) => orderPool.filter(
    (ord) => amountCurrencyEqual(ord.row, bankEntry.row)
      && billDateWithinWindow(bankEntry.row, ord.row, RELAXED_WINDOW_DAYS)
  ));

  // ===== 收尾：三轮后仍未消费的银行池行 → 未匹配 warning（三态不变量，绝不静默消失）=====
  for (const bankEntry of orderedBank) {
    const bankRow = bankEntry.row;
    if (usedBankRowId.has(bankRow._rowId)) continue;
    warn.push({
      rowId: bankRow._rowId,
      code: 'payment-offline-no-order-match',
      phase: 'relaxed-week',
      message: '银行行（Payment线下调拨）三轮阶梯后未匹配到任何符合金额币种与日期窗口的订单'
    });
  }

  return {
    modifications: modCollector.listModifications(),
    warnings: warn.list(),
    matchedPairs
  };
}

module.exports = {
  runRound5PaymentOfflineAllocationBackfill,
  // 内部子函数导出便于单测精确覆盖
  amountEqual,
  amountCurrencyEqual,
  billDateNotEarlier,
  billDateWithinLag,
  billDateWithinWindow,
  bankCreditAmount,
  midPayeeAmount
};
