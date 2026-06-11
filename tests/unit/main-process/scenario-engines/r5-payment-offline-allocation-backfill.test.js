// v3.0.4 块 F「Payment线下调拨订单回填处理」R5 场景2b 引擎单测（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F5 / §F7 + 修订 R2（Q9-Q14）
//
// 修订 R2 关键变化：
//   - 方向翻转：银行周 + 1 = 订单周（订单按 weekTag(FTA) 分桶，银行用 weekTagPlusOne(BillDate) 查桶）。
//   - 订单池三条件：收款账户（卡号）===bigAccount ∧ 付款方式==='线下' ∧ 收款渠道===bankChannel。
//   - 三轮阶梯取代「主轮+差错池」：R1 主轮 / R2 容差轮(−2 天) / R3 兜底轮(±7 天不限周)。
//
// 覆盖：
//   ① 主轮命中回填 ReconciliationId（银行周+1=订单周 join + 金额币种 + Q6 晚于 + 就近）
//   ② 银行池三条件筛选（MerchantId / FundType=FundTransfer-in / 地区）任一不符 → 不命中
//   ③ 订单池三条件（收款账户（卡号）/ 付款方式=线下 / 收款渠道）任一不符 → 不入池（含线上单剔除）
//   ④ 周数 join：银行 BillDate +1 周必须 = 订单周（差一周不命中）；跨年边界
//   ⑤ Q6 同日算晚于边界：BillDate=交易时间当日 → 算晚于、可匹配
//   ⑥ 严格 1v1：两条 bank 抢一条订单 → 仅一条命中
//   ⑦ 多候选 tie-break：就近取天数差最小，warning payment-offline-multi-candidate
//   ⑧ 三轮阶梯（R2 容差轮 / R3 兜底轮 / 共享 usedSet）
//   ⑨ excludeBankRowIds 互斥（Q3）：R5s2 已消费行被剔除，绝不被本引擎触碰
//   ⑩ FTA 不合规筛中订单 → payment-offline-invalid-fta warning（不静默）
//   ⑪ 三态不变量：筛中银行行必落「命中 / 未匹配 warning」之一，绝不静默消失
//   ⑫ 回填覆盖语义（原值非空覆盖 / nv 空不写 / 同值不写）
//   ⑬ matchedPairs 形状（round / oldReconciliationId / dayDiff）+ 4.5M 不平衡桶（2 单抢 1 行）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5PaymentOfflineAllocationBackfill,
  amountEqual,
  billDateNotEarlier,
  billDateWithinLag,
  billDateWithinWindow
} = require('../../../../src/main-process/scenario-engines/r5-payment-offline-allocation-backfill');

// ---- 行工厂 ------------------------------------------------------------

// 中台调拨订单行（26 列子集）：默认大账号 202782001 / 付款方式 线下 / 收款渠道 CITI / 付款渠道 BGL（出款行，不参与筛选）
//   FTA→2026-06-02（weekTag 2623）；银行 BillDate 落 +1 周（2624）即命中。
function midRow({
  dispatchNo = 'FTA202606021000477', // → 2026-06-02 → weekTag 2623
  payMethod = '线下',
  channelSerialNo = 'CH-1',
  txTime = '2026-06-02',
  payeeAccountCard = '202782001',
  payeeAmount = 100,
  payeeCurrency = 'USD',
  payChannel = 'BGL',          // 付款渠道（出款行）—— 修订 R2：不参与订单池筛选，仅核对展示
  receiveChannel = 'CITI'      // 收款渠道（账单所属渠道）—— 修订 R2：订单池筛选 === bankChannel
} = {}) {
  return {
    调拨单号: dispatchNo,
    付款方式: payMethod,
    渠道流水号: channelSerialNo,
    交易时间: txTime,
    '收款账户（卡号）': payeeAccountCard, // ⚠️ 全角括号
    收款金额: payeeAmount,
    收款币种: payeeCurrency,
    付款渠道: payChannel,
    收款渠道: receiveChannel
  };
}

// 银行行（44 列子集）：默认 MerchantId 202782001 / FundType FundTransfer-in / 地区 LU。
//   修订 R2 方向：银行 +1 周 = 订单周（订单按 weekTag(FTA) 分桶，银行用 weekTagPlusOne(BillDate) 查桶）。
//   默认订单 FTA 06-02 → 订单周 2623；银行需 weekTagPlusOne(BillDate)===2623，即 BillDate ∈ 05-25~05-31。
//   故默认 billDate=2026-05-26（weekTagPlusOne(05-26)=2623=订单周）；各案按需显式覆盖 billDate/txTime。
function bankRow({
  rowId = 'b1',
  merchantId = '202782001',
  fundType = 'FundTransfer-in',
  region = 'LU',
  billDate = '2026-05-26', // weekTagPlusOne(05-26) → weekTag(06-02) = 2623 = 订单周；BillDate≥交易时间? 见各案显式覆盖
  creditAmount = 100,
  currency = 'USD',
  reconId = ''
} = {}) {
  return {
    _rowId: rowId,
    MerchantId: merchantId,
    FundType: fundType,
    地区: region,
    BillDate: billDate,
    'Credit Amount': creditAmount, // ⚠️ 含空格
    Currency: currency,
    ReconciliationId: reconId
  };
}

const OPT = { bigAccount: '202782001', bankChannel: 'CITI', region: 'LU' };

// ---- 口径单元 ----------------------------------------------------------

test.describe('R5场景2b — 口径单元', () => {
  test('amountEqual 精确到分（Credit Amount ↔ 收款金额）', () => {
    assert.equal(amountEqual(midRow({ payeeAmount: 100.5 }), bankRow({ creditAmount: 100.5 })), true);
    assert.equal(amountEqual(midRow({ payeeAmount: 100.5 }), bankRow({ creditAmount: 100.51 })), false);
  });

  test('Q6 晚于（日粒度·同日算晚于）：BillDate 取日 ≥ 交易时间取日', () => {
    // 同日 → 算晚于
    assert.equal(billDateNotEarlier(bankRow({ billDate: '2026-06-02' }), midRow({ txTime: '2026-06-02' })), true);
    // 晚一天 → 晚于
    assert.equal(billDateNotEarlier(bankRow({ billDate: '2026-06-03' }), midRow({ txTime: '2026-06-02' })), true);
    // 早一天 → 非晚于
    assert.equal(billDateNotEarlier(bankRow({ billDate: '2026-06-01' }), midRow({ txTime: '2026-06-02' })), false);
  });

  test('R2 容差判据 billDateWithinLag（BillDate ≥ 交易时间 − N 天）', () => {
    // 晚 2 天容差：BillDate 早交易时间 1/2 天 → true；早 3 天 → false
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-06-01' }), midRow({ txTime: '2026-06-02' }), 2), true, '早 1 天 ∈ 容差');
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-05-31' }), midRow({ txTime: '2026-06-02' }), 2), true, '早 2 天 ∈ 容差');
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-05-30' }), midRow({ txTime: '2026-06-02' }), 2), false, '早 3 天 ∉ 容差');
    assert.equal(billDateWithinLag(bankRow({ billDate: '2026-06-05' }), midRow({ txTime: '2026-06-02' }), 2), true, '晚于恒 ∈ 容差');
  });

  test('R3 兜底判据 billDateWithinWindow（|BillDate − 交易时间| ≤ N 天，双向）', () => {
    assert.equal(billDateWithinWindow(bankRow({ billDate: '2026-06-09' }), midRow({ txTime: '2026-06-02' }), 7), true, '差 7 天 ∈ 窗口');
    assert.equal(billDateWithinWindow(bankRow({ billDate: '2026-05-26' }), midRow({ txTime: '2026-06-02' }), 7), true, '早 7 天 ∈ 窗口');
    assert.equal(billDateWithinWindow(bankRow({ billDate: '2026-06-10' }), midRow({ txTime: '2026-06-02' }), 7), false, '差 8 天 ∉ 窗口');
  });
});

// ---- ① 主轮命中 -------------------------------------------------------

test.describe('R5场景2b — ① 主轮命中回填', () => {
  test('银行周+1=订单周 join + 金额币种 + 晚于 → 渠道流水号回填进 bank.ReconciliationId 并标黄', () => {
    // 订单 FTA 06-02（订单周 2623），交易时间 05-26；银行 BillDate 05-26（weekTagPlusOne→2623=订单周）+ 同日晚于
    const mid = [midRow({ channelSerialNo: 'CH-OK', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: '' })];
    const { modifications, warnings, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);

    assert.equal(banks[0].ReconciliationId, 'CH-OK', 'bank ReconciliationId 应被回填为订单渠道流水号');
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1', column: 'ReconciliationId', oldValue: '', newValue: 'CH-OK'
    });
    assert.equal(warnings.length, 0, '唯一命中无 warning');
    assert.equal(matchedPairs.length, 1);
    assert.equal(matchedPairs[0].round, 'main', '主轮匹配 round=main');
  });
});

// ---- ② 银行池三条件 ---------------------------------------------------

test.describe('R5场景2b — ② 银行池三条件筛选', () => {
  test('MerchantId 不等 bigAccount → 不入银行池、不命中', () => {
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ merchantId: '999999' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('FundType 非 FundTransfer-in（大写 T）→ 不入池', () => {
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ fundType: 'FundTransfer-out' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('地区不等 region → 不入池（Q1 地区参与银行侧筛选）', () => {
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ region: 'US' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });
});

// ---- ③ 订单池三条件（修订 R2 Q10）-----------------------------------

test.describe('R5场景2b — ③ 订单池三条件筛选（修订 R2）', () => {
  test('收款账户（卡号）不等 bigAccount → 不入订单池', () => {
    const mid = [midRow({ payeeAccountCard: '888888', txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('收款渠道不等 bankChannel → 不入订单池', () => {
    const mid = [midRow({ receiveChannel: 'OTHER', txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('付款方式非「线下」（线上 CFT 单）→ 不入订单池（修订 R2 剔线上单）', () => {
    // 线上单：付款方式=线上、收款渠道=CITI、收款账户匹配 —— 旧逻辑会误命中，新逻辑因付款方式≠线下剔除
    const mid = [midRow({ payMethod: '线上', txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '线上单不参与线下回填引擎');
    assert.equal(matchedPairs.length, 0);
  });

  test('付款渠道（出款行）不参与订单池筛选（修订 R2：仅收款渠道参与）', () => {
    // 付款渠道改成与 bankChannel 同值 CITI 也不影响——筛选只看收款渠道；此处收款渠道仍 CITI 故应命中
    const mid = [midRow({ payChannel: 'ZZZ', txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '付款渠道任意值不影响命中（不参与筛选）');
  });
});

// ---- ④ 周数 join：银行 +1 周 = 订单周 ---------------------------------

test.describe('R5场景2b — ④ 周数 join（银行 +1 周 = 订单周）', () => {
  test('银行 BillDate +1 周落订单周（2623）→ 命中', () => {
    // 订单 FTA 06-02（2623）；银行 05-26（weekTagPlusOne→2623）→ join 中
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '银行 +1 周 = 订单周 → 命中');
  });

  test('银行 BillDate +1 周不等订单周 → 主轮 join 不命中', () => {
    // 订单 FTA 06-02（2623）；银行 06-09（weekTagPlusOne(06-09)=weekTag(06-16)=2625 ≠ 2623）→ join 不中
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ billDate: '2026-06-09' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '周数错配主轮不命中');
    // 但仍可能落 R3 兜底（差 14 天 > 7 → 不命中）→ no-order-match warning
    assert.ok(warnings.some((w) => w.code === 'payment-offline-no-order-match'));
  });

  test('跨年边界：订单 FTA 2027-01-01（订单周 2653）；银行 2026-12-25（+1 周 → 2653）→ 命中', () => {
    // 2027-01-01 ISO week-year 仍是 2026-W53 → weekTag 2653。
    // 银行 BillDate 2026-12-25：weekTagPlusOne(12-25)=weekTag(2027-01-01)=2653 → join 中。
    const mid = [midRow({ dispatchNo: 'FTA202701011000001', txTime: '2026-12-25', channelSerialNo: 'CH-NY' })];
    const banks = [bankRow({ billDate: '2026-12-25' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '跨年边界 +1 周日期语义命中');
    assert.equal(modifications[0].newValue, 'CH-NY');
  });
});

// ---- ⑤ Q6 同日算晚于（端到端）----------------------------------------

test.describe('R5场景2b — ⑤ Q6 同日算晚于边界', () => {
  test('BillDate = 交易时间当日（且 +1 周落订单周）→ 算晚于、可匹配', () => {
    // 订单 FTA 06-02（订单周 2623），交易时间 05-26；银行 BillDate 05-26 = 交易时间当日，weekTagPlusOne→2623
    const mid = [midRow({ txTime: '2026-05-26', channelSerialNo: 'CH-SAMEDAY' })];
    const banks = [bankRow({ billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '同日应算晚于、可匹配');
    assert.equal(modifications[0].newValue, 'CH-SAMEDAY');
  });
});

// ---- ⑥ 严格 1v1 ------------------------------------------------------

test.describe('R5场景2b — ⑥ 严格 1v1', () => {
  test('两条 bank 抢同一订单 → 仅一条命中（usedOrderSet 消费）', () => {
    // 两条银行行同周桶（+1 周=2623），都晚于交易时间 05-26
    const mid = [midRow({ channelSerialNo: 'CH-1', txTime: '2026-05-26' })];
    const banks = [
      bankRow({ rowId: 'b1', billDate: '2026-05-27' }), // weekTagPlusOne(05-27)=2623=订单周
      bankRow({ rowId: 'b2', billDate: '2026-05-28' })  // weekTagPlusOne(05-28)=2623=订单周
    ];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '一条订单只能回填一条 bank');
    // bank 按 BillDate 升序消费 → b1（05-27）先消费
    assert.equal(modifications[0].rowId, 'b1');
  });
});

// ---- ⑦ 多候选 tie-break（就近）---------------------------------------

test.describe('R5场景2b — ⑦ 多候选就近 tie-break', () => {
  test('一条 bank 命中两条订单（同周桶） → 就近取天数差最小 + multi-candidate warning', () => {
    // 银行 BillDate 06-01（weekTagPlusOne(06-01)=weekTag(06-08)=2624）
    // 两订单 FTA→2624 周（FTA 06-08），交易时间 05-31（差 1）/ 05-28（差 4），均 ≤ 银行
    const mid = [
      midRow({ dispatchNo: 'FTA202606081000001', txTime: '2026-05-28', channelSerialNo: 'CH-FAR' }),  // 差 4 天
      midRow({ dispatchNo: 'FTA202606081000002', txTime: '2026-05-31', channelSerialNo: 'CH-NEAR' })   // 差 1 天
    ];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-01' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].newValue, 'CH-NEAR', '就近应取天数差最小（差 1 天）');
    const multi = warnings.find((w) => w.code === 'payment-offline-multi-candidate');
    assert.ok(multi, '多候选应发 payment-offline-multi-candidate warning');
    assert.equal(multi.rowId, 'b1', 'warning 须带银行行 _rowId');
    assert.equal(multi.phase, 'main', '多候选发生在主轮');
  });
});

// ---- ⑧ 三轮阶梯（修订 R2 取代差错池）---------------------------------

test.describe('R5场景2b — ⑧ 三轮阶梯（R2 容差轮 / R3 兜底轮）', () => {
  test('主轮不中、早 1 天 → R2 容差轮命中（phase=date-tolerance）', () => {
    // 订单 FTA 06-02（订单周 2623），交易时间 05-28；银行 BillDate 05-27（weekTagPlusOne→2623=订单周，同桶）
    //   05-27 < 05-28（早 1 天）→ 主轮「晚于」不中；R2 容差(−2 天)：05-27 ≥ 05-28−2 → 命中
    const mid = [midRow({ txTime: '2026-05-28', channelSerialNo: 'CH-R2' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-27' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, 'R2 容差轮应命中');
    assert.equal(modifications[0].newValue, 'CH-R2');
    assert.equal(matchedPairs[0].round, 'date-tolerance');
    // dayDiff 带符号：BillDate 05-27 − 交易时间 05-28 = −1（R2 救回的倒挂行，方向可见）
    assert.equal(matchedPairs[0].dayDiff, -1, 'R2 早 1 天 dayDiff=-1（带符号）');
  });

  test('主轮不中、早 2 天 → R2 容差轮命中', () => {
    // 银行 BillDate 05-26 早交易时间 05-28 共 2 天 → R2 命中（同桶：weekTagPlusOne(05-26)=2623=订单周）
    const mid = [midRow({ txTime: '2026-05-28', channelSerialNo: 'CH-R2B' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '早 2 天 R2 命中');
    assert.equal(matchedPairs[0].round, 'date-tolerance');
    // dayDiff 带符号：05-26 − 05-28 = −2
    assert.equal(matchedPairs[0].dayDiff, -2, 'R2 早 2 天 dayDiff=-2（带符号）');
  });

  test('主轮不中、早 3 天 → R2 不命中、落 R3 兜底窗口', () => {
    // 银行 BillDate 05-25 早交易时间 05-28 共 3 天（> 2 容差）→ R2 不中。
    //   weekTagPlusOne(05-25)=2623=订单周（同桶），但 R2 容差判据不过。
    //   R3 兜底（不限周，|差|≤7）：|05-25 − 05-28|=3 ≤ 7 → R3 命中（phase=relaxed-week）。
    const mid = [midRow({ txTime: '2026-05-28', channelSerialNo: 'CH-R3' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-25' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '早 3 天落 R3 兜底窗口命中');
    assert.equal(matchedPairs[0].round, 'relaxed-week', 'R3 兜底轮');
    // dayDiff 带符号：05-25 − 05-28 = −3（R3 倒挂方向可见）
    assert.equal(matchedPairs[0].dayDiff, -3, 'R3 早 3 天 dayDiff=-3（带符号）');
  });

  test('R3 兜底：跨周界 ±7 内命中、>7 不命中', () => {
    // 订单 FTA 06-02（订单周 2623），交易时间 06-02。
    //   银行 BillDate 06-09（weekTagPlusOne→2625 ≠ 订单周 → 主轮/R2 同桶不中）。
    //   |06-09 − 06-02| = 7 ≤ 7 → R3 命中。
    const midIn = [midRow({ txTime: '2026-06-02', channelSerialNo: 'CH-W7' })];
    const banksIn = [bankRow({ rowId: 'b1', billDate: '2026-06-09' })];
    const r1 = runRound5PaymentOfflineAllocationBackfill(banksIn, midIn, OPT);
    assert.equal(r1.modifications.length, 1, '差 7 天 R3 命中');
    assert.equal(r1.matchedPairs[0].round, 'relaxed-week');

    // 差 8 天 → R3 窗口外 → no-order-match
    const midOut = [midRow({ txTime: '2026-06-02', channelSerialNo: 'CH-W8' })];
    const banksOut = [bankRow({ rowId: 'b1', billDate: '2026-06-10' })];
    const r2 = runRound5PaymentOfflineAllocationBackfill(banksOut, midOut, OPT);
    assert.equal(r2.modifications.length, 0, '差 8 天 R3 窗口外');
    assert.ok(r2.warnings.some((w) => w.code === 'payment-offline-no-order-match' && w.rowId === 'b1'));
  });

  test('三轮共享 usedSet：R1 已消费的订单不被 R2/R3 重复消费', () => {
    // 订单 A：FTA 06-02（2623），交易时间 05-26，CH-A。
    // 银行 b1 BillDate 05-26（weekTagPlusOne→2623，同日晚于）→ R1 命中订单 A。
    // 银行 b2 BillDate 05-25（weekTagPlusOne(05-25)=2623=订单周，早交易时间 1 天）→ R1 不中；
    //   R2 容差(−2)：05-25 ≥ 05-26−2 → 候选含订单 A，但 A 已被 R1 消费 → 跳过 → R3 也无其它订单 → no-match。
    const mid = [midRow({ txTime: '2026-05-26', channelSerialNo: 'CH-A' })];
    const banks = [
      bankRow({ rowId: 'b1', billDate: '2026-05-26' }),
      bankRow({ rowId: 'b2', billDate: '2026-05-25' })
    ];
    const { modifications, warnings, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '订单 A 仅被消费一次');
    assert.equal(matchedPairs.length, 1);
    assert.equal(matchedPairs[0].bankRow._rowId, 'b1', 'R1 主轮 b1 先消费订单 A');
    assert.ok(warnings.some((w) => w.code === 'payment-offline-no-order-match' && w.rowId === 'b2'), 'b2 无可用订单（A 已消费）→ no-match');
  });
});

// ---- ⑨ excludeBankRowIds 互斥（Q3 网关回填优先）---------------------

test.describe('R5场景2b — ⑨ excludeBankRowIds 互斥（Q3）', () => {
  test('R5s2 已消费的 bank 行（excludeBankRowIds）被剔除 → 绝不被本引擎触碰', () => {
    const mid = [midRow({ channelSerialNo: 'CH-OK', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: 'GW-RECON' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(
      banks, mid, { ...OPT, excludeBankRowIds: new Set(['b1']) }
    );
    assert.equal(modifications.length, 0, '被排除的行不进银行池、不被覆盖');
    assert.equal(banks[0].ReconciliationId, 'GW-RECON', 'R5s2 网关回填值保持不变（零互相覆盖）');
  });

  test('excludeBankRowIds 接受数组形式', () => {
    const mid = [midRow({ txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(
      banks, mid, { ...OPT, excludeBankRowIds: ['b1'] }
    );
    assert.equal(modifications.length, 0);
  });
});

// ---- ⑩ FTA 不合规筛中订单 → warning（不静默）------------------------

test.describe('R5场景2b — ⑩ FTA 不合规订单 warning', () => {
  test('筛中订单池但调拨单号非法 FTA → payment-offline-invalid-fta warning，不静默跳过', () => {
    const mid = [midRow({ dispatchNo: 'FTA-BAD', channelSerialNo: 'CH-X', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '非法 FTA 订单不参与匹配');
    const invalid = warnings.find((w) => w.code === 'payment-offline-invalid-fta');
    assert.ok(invalid, '应发 payment-offline-invalid-fta warning');
  });
});

// ---- ⑪ 三态不变量 ----------------------------------------------------

test.describe('R5场景2b — ⑪ 三态不变量（筛中银行行绝不静默消失）', () => {
  test('订单池非空但银行行三轮全错配 → 银行行落 no-order-match warning（带 _rowId）', () => {
    // 订单 FTA 06-02（2623）→ +1 周不等；且远超 R3 窗口（差 30 天）→ 三轮全不中
    const mid = [midRow({ txTime: '2026-06-02' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-07-01' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
    const noMatch = warnings.find((w) => w.code === 'payment-offline-no-order-match' && w.rowId === 'b1');
    assert.ok(noMatch, '三轮全错配的筛中银行行必落未匹配 warning（三态不变量）');
    assert.equal(noMatch.phase, 'relaxed-week', '收尾 warning phase 标 relaxed-week');
  });
});

// ---- ⑫ 回填覆盖语义 --------------------------------------------------

test.describe('R5场景2b — ⑫ 回填覆盖语义', () => {
  test('原值非空 → 命中即覆盖（含 modification）', () => {
    const mid = [midRow({ channelSerialNo: 'CH-NEW', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: 'OLD' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(banks[0].ReconciliationId, 'CH-NEW');
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].oldValue, 'OLD');
  });

  test('订单渠道流水号为空 → 不写、不标黄，但仍消费（1v1 红线）', () => {
    const mid = [midRow({ channelSerialNo: '', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: 'KEEP' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '渠道流水号空不写 modification');
    assert.equal(banks[0].ReconciliationId, 'KEEP', '银行原值不被清空');
    assert.equal(matchedPairs.length, 1, 'nv 空仍消费、仍记 matchedPairs');
    assert.equal(matchedPairs[0].oldReconciliationId, 'KEEP', 'matchedPairs 记覆盖前原值');
  });

  test('原值已等于订单渠道流水号 → 不重复写、不标黄', () => {
    const mid = [midRow({ channelSerialNo: 'SAME', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: 'SAME' })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '同值不产 modification');
    assert.equal(matchedPairs.length, 1, '同值仍消费、仍记 matchedPairs');
  });
});

// ---- ⑬ matchedPairs 形状 + 4.5M 不平衡桶 ------------------------------

test.describe('R5场景2b — ⑬ matchedPairs 形状 + 不平衡桶（2 单抢 1 行）', () => {
  test('matchedPairs 项含 { bankRow, orderRow, round, oldReconciliationId, dayDiff }', () => {
    const mid = [midRow({ channelSerialNo: 'CH-OK', txTime: '2026-05-26' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', reconId: 'OLD' })];
    const { matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(matchedPairs.length, 1);
    const p = matchedPairs[0];
    assert.equal(p.bankRow._rowId, 'b1');
    assert.equal(p.orderRow['渠道流水号'], 'CH-OK');
    assert.equal(p.round, 'main');
    assert.equal(p.oldReconciliationId, 'OLD', 'oldReconciliationId 为覆盖前原值');
    assert.equal(p.dayDiff, 0, '同日 dayDiff=0');
  });

  test('4.5M 不平衡桶：2 订单抢 1 银行行 → 1 订单无对应、银行行命中、另一订单不出现在 matchedPairs', () => {
    // 复刻真实数据缺口形态：同金额同币种两张订单落同周桶，但只有一条银行行可消费。
    const mid = [
      midRow({ dispatchNo: 'FTA202606021000477', txTime: '2026-05-26', payeeAmount: 4500000, channelSerialNo: 'CH-A' }),
      midRow({ dispatchNo: 'FTA202606021000465', txTime: '2026-05-26', payeeAmount: 4500000, channelSerialNo: 'CH-B' })
    ];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-05-26', creditAmount: 4500000 })];
    const { modifications, matchedPairs } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    // 仅一条银行行 → 仅一条订单被消费（1v1）
    assert.equal(modifications.length, 1, '一条银行行只能消费一条订单');
    assert.equal(matchedPairs.length, 1);
    // 被消费的订单（按周桶内原序，CH-A 在前 → 就近 tie 取原序 first-wins）
    const consumed = matchedPairs[0].orderRow['渠道流水号'];
    assert.equal(consumed, 'CH-A', 'tie=原序 first-wins，CH-A 先消费');
    // 另一订单 CH-B 无对应银行行 → 不出现在 matchedPairs（属真实数据缺口形态）
    assert.ok(!matchedPairs.some((p) => p.orderRow['渠道流水号'] === 'CH-B'), 'CH-B 无对应银行行');
  });
});

// ---- 边界兜底 ----------------------------------------------------------

test.describe('R5场景2b — 边界兜底', () => {
  test('空 / null / 非数组入参 → 返回空，不崩', () => {
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([], [], OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill(null, null, OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([bankRow()], [], OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([], [midRow()], OPT).modifications, []);
    // matchedPairs 在所有早退出口均为数组
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([], [], OPT).matchedPairs, []);
  });

  test('options 三项任一缺失 → no-op（编排器 gating 已挡，引擎再兜底）', () => {
    const mid = [midRow()];
    const banks = [bankRow()];
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bankChannel: 'CITI', region: 'LU' }).modifications,
      [], '缺 bigAccount → no-op'
    );
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bigAccount: '202782001', region: 'LU' }).modifications,
      [], '缺 bankChannel → no-op'
    );
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bigAccount: '202782001', bankChannel: 'CITI' }).modifications,
      [], '缺 region → no-op'
    );
  });
});
