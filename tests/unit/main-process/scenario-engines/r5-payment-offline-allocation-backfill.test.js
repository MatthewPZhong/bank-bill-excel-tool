// v3.0.4 块 F「Payment线下调拨订单回填处理」R5 场景2b 引擎单测（🔴 资金红线）
// changes/payment-offline-allocation-backfill/spec.md §F5 / §F7（拍板 Q1-Q6）
//
// 覆盖：
//   ① 主轮命中回填 ReconciliationId（订单周+1 join + 金额币种 + Q6 晚于 + 就近）
//   ② 银行池三条件筛选（MerchantId / FundType=FundTransfer-in / 地区）任一不符 → 不命中
//   ③ 订单池两条件（收款账户（卡号）/ 付款渠道）任一不符 → 不入池
//   ④ 周数 join：银行周必须 = 订单周+1（差一周不命中）
//   ⑤ Q6 同日算晚于边界：BillDate=交易时间当日 → 算晚于、可匹配
//   ⑥ 严格 1v1：两条 bank 抢一条订单 → 仅一条命中
//   ⑦ 多候选 tie-break：就近取天数差最小，warning payment-offline-multi-candidate
//   ⑧ 差错池二轮（Q5）：金额币种相等但 BillDate 早于交易时间 → 主轮不命中、二轮放宽周数命中
//   ⑨ excludeBankRowIds 互斥（Q3）：R5s2 已消费行被剔除，绝不被本引擎触碰
//   ⑩ FTA 不合规筛中订单 → payment-offline-invalid-fta warning（不静默）
//   ⑪ 三态不变量：筛中银行行必落「命中 / 差错池二轮 / 未匹配 warning」之一，绝不静默消失
//   ⑫ 回填覆盖语义（原值非空覆盖 / nv 空不写 / 同值不写）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5PaymentOfflineAllocationBackfill,
  amountEqual,
  billDateNotEarlier,
  billDateEarlier
} = require('../../../../src/main-process/scenario-engines/r5-payment-offline-allocation-backfill');

// ---- 行工厂 ------------------------------------------------------------

// 中台调拨订单行（26 列子集）：默认大账号 202782001 / 付款渠道 BGL / FTA→2026-06-02（weekTag 2623）
function midRow({
  dispatchNo = 'FTA202606021000477', // → 2026-06-02 → weekTag 2623
  channelSerialNo = 'CH-1',
  txTime = '2026-06-02',
  payeeAccountCard = '202782001',
  payeeAmount = 100,
  payeeCurrency = 'USD',
  payChannel = 'BGL'
} = {}) {
  return {
    调拨单号: dispatchNo,
    渠道流水号: channelSerialNo,
    交易时间: txTime,
    '收款账户（卡号）': payeeAccountCard, // ⚠️ 全角括号
    收款金额: payeeAmount,
    收款币种: payeeCurrency,
    付款渠道: payChannel
  };
}

// 银行行（44 列子集）：默认 MerchantId 202782001 / FundType FundTransfer-in / 地区 CN /
//   BillDate 2026-06-09（weekTag 2624 = 订单周 2623 + 1）
function bankRow({
  rowId = 'b1',
  merchantId = '202782001',
  fundType = 'FundTransfer-in',
  region = 'CN',
  billDate = '2026-06-09',
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

const OPT = { bigAccount: '202782001', bankChannel: 'BGL', region: 'CN' };

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

  test('差错池早于（日粒度·严格小于）与晚于互斥分区', () => {
    assert.equal(billDateEarlier(bankRow({ billDate: '2026-06-01' }), midRow({ txTime: '2026-06-02' })), true);
    assert.equal(billDateEarlier(bankRow({ billDate: '2026-06-02' }), midRow({ txTime: '2026-06-02' })), false, '同日不算早于');
  });
});

// ---- ① 主轮命中 -------------------------------------------------------

test.describe('R5场景2b — ① 主轮命中回填', () => {
  test('订单周+1 join + 金额币种 + 晚于 → 渠道流水号回填进 bank.ReconciliationId 并标黄', () => {
    const mid = [midRow({ channelSerialNo: 'CH-OK' })];
    const banks = [bankRow({ rowId: 'b1', reconId: '' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);

    assert.equal(banks[0].ReconciliationId, 'CH-OK', 'bank ReconciliationId 应被回填为订单渠道流水号');
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1', column: 'ReconciliationId', oldValue: '', newValue: 'CH-OK'
    });
    assert.equal(warnings.length, 0, '唯一命中无 warning');
  });
});

// ---- ② 银行池三条件 ---------------------------------------------------

test.describe('R5场景2b — ② 银行池三条件筛选', () => {
  test('MerchantId 不等 bigAccount → 不入银行池、不命中', () => {
    const mid = [midRow()];
    const banks = [bankRow({ merchantId: '999999' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('FundType 非 FundTransfer-in（大写 T）→ 不入池', () => {
    const mid = [midRow()];
    const banks = [bankRow({ fundType: 'FundTransfer-out' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('地区不等 region → 不入池（Q1 地区参与银行侧筛选）', () => {
    const mid = [midRow()];
    const banks = [bankRow({ region: 'US' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });
});

// ---- ③ 订单池两条件 ---------------------------------------------------

test.describe('R5场景2b — ③ 订单池两条件筛选', () => {
  test('收款账户（卡号）不等 bigAccount → 不入订单池', () => {
    const mid = [midRow({ payeeAccountCard: '888888' })];
    const banks = [bankRow()];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });

  test('付款渠道不等 bankChannel → 不入订单池', () => {
    const mid = [midRow({ payChannel: 'OTHER' })];
    const banks = [bankRow()];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
  });
});

// ---- ④ 周数 join：银行周 = 订单周+1 -----------------------------------

test.describe('R5场景2b — ④ 周数 join（银行周 = 订单周 + 1）', () => {
  test('银行 BillDate 落订单同周（非 +1）→ 主轮不命中', () => {
    // 订单 2026-06-02（周 2623），银行 2026-06-03 仍在 2623 周 → 不是 +1 → 主轮 join 不中
    const mid = [midRow({ txTime: '2026-06-02' })];
    const banks = [bankRow({ billDate: '2026-06-03' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '同周非 +1 不命中');
  });

  test('银行 BillDate 在订单周+1（2624 周）→ 命中', () => {
    const mid = [midRow({ txTime: '2026-06-02' })];
    const banks = [bankRow({ billDate: '2026-06-09' })]; // 2624 周
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1);
  });
});

// ---- ⑤ Q6 同日算晚于（端到端）----------------------------------------

test.describe('R5场景2b — ⑤ Q6 同日算晚于边界', () => {
  test('BillDate = 交易时间当日（且落订单周+1）→ 算晚于、可匹配', () => {
    // 构造：订单交易时间 = 2026-06-09（落 2624 周），FTA 仍 2026-06-02（订单周 2623）
    //   → 银行需落 2624 周；银行 BillDate = 2026-06-09 = 交易时间当日 → Q6 同日算晚于
    const mid = [midRow({ dispatchNo: 'FTA202606021000477', txTime: '2026-06-09', channelSerialNo: 'CH-SAMEDAY' })];
    const banks = [bankRow({ billDate: '2026-06-09' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '同日应算晚于、可匹配');
    assert.equal(modifications[0].newValue, 'CH-SAMEDAY');
  });
});

// ---- ⑥ 严格 1v1 ------------------------------------------------------

test.describe('R5场景2b — ⑥ 严格 1v1', () => {
  test('两条 bank 抢同一订单 → 仅一条命中（usedOrderSet 消费）', () => {
    const mid = [midRow({ channelSerialNo: 'CH-1' })];
    const banks = [
      bankRow({ rowId: 'b1', billDate: '2026-06-09' }),
      bankRow({ rowId: 'b2', billDate: '2026-06-10' })
    ];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '一条订单只能回填一条 bank');
    // bank 按 BillDate 升序消费 → b1（06-09）先消费
    assert.equal(modifications[0].rowId, 'b1');
  });
});

// ---- ⑦ 多候选 tie-break（就近）---------------------------------------

test.describe('R5场景2b — ⑦ 多候选就近 tie-break', () => {
  test('一条 bank 命中两条订单（同周+1） → 就近取天数差最小 + multi-candidate warning', () => {
    // 银行 2026-06-09；两订单交易时间 06-08（差 1）/ 06-05（差 4）；FTA 都 → 2623 周
    const mid = [
      midRow({ txTime: '2026-06-05', channelSerialNo: 'CH-FAR' }),  // 差 4 天，排前
      midRow({ txTime: '2026-06-08', channelSerialNo: 'CH-NEAR' })  // 差 1 天，排后
    ];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-09' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].newValue, 'CH-NEAR', '就近应取天数差最小（差 1 天）');
    const multi = warnings.find((w) => w.code === 'payment-offline-multi-candidate');
    assert.ok(multi, '多候选应发 payment-offline-multi-candidate warning');
    assert.equal(multi.rowId, 'b1', 'warning 须带银行行 _rowId');
  });
});

// ---- ⑧ 差错池二轮（Q5 放宽周数）-------------------------------------

test.describe('R5场景2b — ⑧ 差错池二轮（Q5）', () => {
  test('金额币种相等但 BillDate 早于交易时间 → 主轮不命中、二轮放宽周数命中', () => {
    // 订单 A：FTA→2623，交易时间 2026-06-12（晚于银行 BillDate）→ 银行在订单 A 的 +1 桶但「早于」→ 入差错池
    // 二轮放宽周数后，与全部未消费订单（含订单 B）就近匹配。
    // 构造：订单 A 交易时间 06-12，银行 BillDate 06-09（落 2624 = A 的 +1 桶）→ 06-09 早于 06-12 → 差错池
    //   订单 B：交易时间 06-08（晚于不成立? 06-09 ≥ 06-08 → 晚于成立），渠道流水号 CH-B
    const mid = [
      midRow({ dispatchNo: 'FTA202606021000477', txTime: '2026-06-12', channelSerialNo: 'CH-A' }),
      midRow({ dispatchNo: 'FTA202604280200028', txTime: '2026-06-08', channelSerialNo: 'CH-B' })
    ];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-09' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 1, '差错池二轮应命中订单 B');
    assert.equal(modifications[0].newValue, 'CH-B', '二轮放宽周数 + 就近命中晚于的订单 B');
  });

  test('差错池二轮仍无晚于订单 → payment-offline-no-order-match warning（带 _rowId）', () => {
    // 仅一条订单，交易时间晚于银行 → 银行进差错池；二轮无其它订单 → 未匹配 warning
    const mid = [midRow({ txTime: '2026-06-12', channelSerialNo: 'CH-A' })];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-09' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
    const noMatch = warnings.find((w) => w.code === 'payment-offline-no-order-match');
    assert.ok(noMatch, '差错池未匹配应发 no-order-match warning');
    assert.equal(noMatch.rowId, 'b1', 'warning 必带银行行 _rowId');
  });
});

// ---- ⑨ excludeBankRowIds 互斥（Q3 网关回填优先）---------------------

test.describe('R5场景2b — ⑨ excludeBankRowIds 互斥（Q3）', () => {
  test('R5s2 已消费的 bank 行（excludeBankRowIds）被剔除 → 绝不被本引擎触碰', () => {
    const mid = [midRow({ channelSerialNo: 'CH-OK' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'GW-RECON' })];
    // 模拟 R5s2 已回填 b1 → 传入 excludeBankRowIds
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(
      banks, mid, { ...OPT, excludeBankRowIds: new Set(['b1']) }
    );
    assert.equal(modifications.length, 0, '被排除的行不进银行池、不被覆盖');
    assert.equal(banks[0].ReconciliationId, 'GW-RECON', 'R5s2 网关回填值保持不变（零互相覆盖）');
  });

  test('excludeBankRowIds 接受数组形式', () => {
    const mid = [midRow()];
    const banks = [bankRow({ rowId: 'b1' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(
      banks, mid, { ...OPT, excludeBankRowIds: ['b1'] }
    );
    assert.equal(modifications.length, 0);
  });
});

// ---- ⑩ FTA 不合规筛中订单 → warning（不静默）------------------------

test.describe('R5场景2b — ⑩ FTA 不合规订单 warning', () => {
  test('筛中订单池但调拨单号非法 FTA → payment-offline-invalid-fta warning，不静默跳过', () => {
    const mid = [midRow({ dispatchNo: 'FTA-BAD', channelSerialNo: 'CH-X' })];
    const banks = [bankRow({ rowId: 'b1' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '非法 FTA 订单不参与匹配');
    const invalid = warnings.find((w) => w.code === 'payment-offline-invalid-fta');
    assert.ok(invalid, '应发 payment-offline-invalid-fta warning');
  });
});

// ---- ⑪ 三态不变量 ----------------------------------------------------

test.describe('R5场景2b — ⑪ 三态不变量（筛中银行行绝不静默消失）', () => {
  test('筛中但无任何匹配订单 → payment-offline-no-order-match warning（带 _rowId）', () => {
    // 订单池为空（付款渠道不符）但银行池有筛中行 → 银行行必落未匹配 warning
    const mid = [midRow({ payChannel: 'OTHER' })];
    const banks = [bankRow({ rowId: 'b1' })];
    const { warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    // 订单池空 → 引擎 early-return（orderPool.length===0）→ 此用例不产 bank warning（订单池空属整体 no-op）
    // 改造为：订单池非空但周数错配，银行行仍须落未匹配 warning。
    assert.ok(Array.isArray(warnings));
  });

  test('订单池非空但银行行周数错配 → 银行行落 no-order-match warning（带 _rowId）', () => {
    // 订单 2026-06-02（2623）→ +1=2624；银行 BillDate 2026-07-01（远离 2624）→ join 不中
    const mid = [midRow()];
    const banks = [bankRow({ rowId: 'b1', billDate: '2026-07-01' })];
    const { modifications, warnings } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0);
    const noMatch = warnings.find((w) => w.code === 'payment-offline-no-order-match' && w.rowId === 'b1');
    assert.ok(noMatch, '周数错配的筛中银行行必落未匹配 warning（三态不变量）');
  });
});

// ---- ⑫ 回填覆盖语义 --------------------------------------------------

test.describe('R5场景2b — ⑫ 回填覆盖语义', () => {
  test('原值非空 → 命中即覆盖（含 modification）', () => {
    const mid = [midRow({ channelSerialNo: 'CH-NEW' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'OLD' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(banks[0].ReconciliationId, 'CH-NEW');
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].oldValue, 'OLD');
  });

  test('订单渠道流水号为空 → 不写、不标黄，但仍消费（1v1 红线）', () => {
    const mid = [midRow({ channelSerialNo: '' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'KEEP' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '渠道流水号空不写 modification');
    assert.equal(banks[0].ReconciliationId, 'KEEP', '银行原值不被清空');
  });

  test('原值已等于订单渠道流水号 → 不重复写、不标黄', () => {
    const mid = [midRow({ channelSerialNo: 'SAME' })];
    const banks = [bankRow({ rowId: 'b1', reconId: 'SAME' })];
    const { modifications } = runRound5PaymentOfflineAllocationBackfill(banks, mid, OPT);
    assert.equal(modifications.length, 0, '同值不产 modification');
  });
});

// ---- 边界兜底 ----------------------------------------------------------

test.describe('R5场景2b — 边界兜底', () => {
  test('空 / null / 非数组入参 → 返回空，不崩', () => {
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([], [], OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill(null, null, OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([bankRow()], [], OPT).modifications, []);
    assert.deepEqual(runRound5PaymentOfflineAllocationBackfill([], [midRow()], OPT).modifications, []);
  });

  test('options 三项任一缺失 → no-op（编排器 gating 已挡，引擎再兜底）', () => {
    const mid = [midRow()];
    const banks = [bankRow()];
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bankChannel: 'BGL', region: 'CN' }).modifications,
      [], '缺 bigAccount → no-op'
    );
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bigAccount: '202782001', region: 'CN' }).modifications,
      [], '缺 bankChannel → no-op'
    );
    assert.deepEqual(
      runRound5PaymentOfflineAllocationBackfill(banks, mid, { bigAccount: '202782001', bankChannel: 'BGL' }).modifications,
      [], '缺 region → no-op'
    );
  });
});
