const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound4FundNatureCheck,
  applyHandler
} = require('../../../../src/main-process/scenario-engines/r4-fund-nature-check');

// ========================================================================
// v2.1.16-beta.2 — R4 资金性质校验引擎（🔴 资金红线，TECH_DESIGN §5.2 / §10；PRD §五）
//
// 关联口径：网关 reconciliationid（小写） === 银行 ReconciliationId（驼峰），大小写敏感。
// R4 重新按 reconid 关联 matchedGwRows × 全量 bankRows（不复用 R1 pairs）。
// 五子场景按 priority 降序跑可插拔 handler 改写银行 FundType；旧≠新才改才 record；
// 允许同一银行行被多次改（叠加链，R4 唯一）。
//
// 五子场景默认 config（TECH_DESIGN §10 / PRD §五，TradeType 真实取值待用户核对，本次按默认实现）：
//   | subCategory      | gwTradeType   | requireBankFundType | setFundType  | priority |
//   | ach-return       | AchReturn     | —                   | Ach Return   | 3        |
//   | wire-return      | WireReturn    | —                   | Wire Return  | 2        |
//   | charge-outbound  | —             | Charge              | outbound     | 1        |
//   | hx-out           | HX_OUTBOUND   | —                   | HX-out       | 1        |
//   | hx-in            | HX_INBOUND    | —                   | HX-in        | 0        |
// ========================================================================

// ---- 五子场景默认 config（与 seed 默认值一致；测试按需挑选/重排）----
const SCENARIO_ACH_RETURN = {
  priority: 3,
  config: { subCategory: 'ach-return', gwTradeType: 'AchReturn', setFundType: 'Ach Return' }
};
const SCENARIO_WIRE_RETURN = {
  priority: 2,
  config: { subCategory: 'wire-return', gwTradeType: 'WireReturn', setFundType: 'Wire Return' }
};
const SCENARIO_CHARGE_OUTBOUND = {
  priority: 1,
  config: { subCategory: 'charge-outbound', requireBankFundType: 'Charge', setFundType: 'outbound' }
};
const SCENARIO_HX_OUT = {
  priority: 1,
  config: { subCategory: 'hx-out', gwTradeType: 'HX_OUTBOUND', setFundType: 'HX-out' }
};
const SCENARIO_HX_IN = {
  priority: 0,
  config: { subCategory: 'hx-in', gwTradeType: 'HX_INBOUND', setFundType: 'HX-in' }
};
const ALL_FIVE = [
  SCENARIO_ACH_RETURN,
  SCENARIO_WIRE_RETURN,
  SCENARIO_CHARGE_OUTBOUND,
  SCENARIO_HX_OUT,
  SCENARIO_HX_IN
];

// 构造网关行（真实表头小写：对账ID = reconciliationid；交易类型 = TradeType）
function gw(reconId, tradeType, extra) {
  return Object.assign({ reconciliationid: reconId, TradeType: tradeType }, extra || {});
}
// 构造银行行（驼峰：对账ID = ReconciliationId；资金性质 = FundType；行唯一键 = _rowId）
function bank(rowId, reconId, fundType, extra) {
  return Object.assign(
    { _rowId: rowId, ReconciliationId: reconId, FundType: fundType },
    extra || {}
  );
}

// 取某 rowId + column 的全部 modification（按记录顺序）
function modsFor(result, rowId, column) {
  return result.modifications.filter((m) => m.rowId === rowId && m.column === column);
}

// ========================================================================
// ① 单子场景命中：改 FundType + record（断言 old/new）
// ========================================================================
test.describe('R4 — ① 单子场景命中改 FundType + record', () => {
  test('ach-return：网关 TradeType=AchReturn 命中 → 银行 FundType 由 Charge 改为 Ach Return，record old/new 正确', () => {
    const g1 = gw('R-001', 'AchReturn');
    const b1 = bank('rid-1', 'R-001', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_ACH_RETURN]);

    // 银行行被原地改写
    assert.equal(b1.FundType, 'Ach Return');
    // 恰好一条 modification，old/new/column/rowId 正确
    assert.equal(result.modifications.length, 1);
    const m = result.modifications[0];
    assert.equal(m.rowId, 'rid-1');
    assert.equal(m.column, 'FundType');
    assert.equal(m.oldValue, 'Charge');
    assert.equal(m.newValue, 'Ach Return');
  });

  test('wire-return：网关 TradeType=WireReturn 命中 → FundType 改为 Wire Return', () => {
    const g1 = gw('R-002', 'WireReturn');
    const b1 = bank('rid-2', 'R-002', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_WIRE_RETURN]);

    assert.equal(b1.FundType, 'Wire Return');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].oldValue, 'Charge');
    assert.equal(result.modifications[0].newValue, 'Wire Return');
  });

  test('charge-outbound：仅凭有 R1 匹配 + 银行 FundType=Charge → 改为 outbound（不看网关 TradeType）', () => {
    // 网关 TradeType 随意（charge-outbound config 无 gwTradeType），仅靠进入关联 + FundType=Charge 命中
    const g1 = gw('R-003', '任意值');
    const b1 = bank('rid-3', 'R-003', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'outbound');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].oldValue, 'Charge');
    assert.equal(result.modifications[0].newValue, 'outbound');
  });

  test('charge-outbound：银行 FundType 非 Charge（requireBankFundType 不满足）→ 不命中、不改、不 record', () => {
    const g1 = gw('R-003', '任意值');
    const b1 = bank('rid-3', 'R-003', 'Inbound'); // 非 Charge

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'Inbound'); // 未改
    assert.equal(result.modifications.length, 0);
  });

  test('hx-out / hx-in：按网关 TradeType 命中 → 分别改为 HX-out / HX-in', () => {
    const gOut = gw('R-OUT', 'HX_OUTBOUND');
    const bOut = bank('rid-out', 'R-OUT', 'Charge');
    const gIn = gw('R-IN', 'HX_INBOUND');
    const bIn = bank('rid-in', 'R-IN', 'Charge');

    const rOut = runRound4FundNatureCheck([gOut], [bOut], [SCENARIO_HX_OUT]);
    assert.equal(bOut.FundType, 'HX-out');
    assert.equal(rOut.modifications.length, 1);
    assert.equal(rOut.modifications[0].newValue, 'HX-out');

    const rIn = runRound4FundNatureCheck([gIn], [bIn], [SCENARIO_HX_IN]);
    assert.equal(bIn.FundType, 'HX-in');
    assert.equal(rIn.modifications.length, 1);
    assert.equal(rIn.modifications[0].newValue, 'HX-in');
  });

  test('网关 TradeType 不匹配（gwTradeType 不满足）→ 不命中、不改', () => {
    const g1 = gw('R-001', 'SomethingElse'); // 非 AchReturn
    const b1 = bank('rid-1', 'R-001', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_ACH_RETURN]);

    assert.equal(b1.FundType, 'Charge'); // 未改
    assert.equal(result.modifications.length, 0);
  });
});

// ========================================================================
// ② 二次改值链：同一银行行先 charge-outbound（Charge→outbound）再 hx-out（outbound→HX-out）
//    断言两条 modification 都在、最终值 = HX-out
// ========================================================================
test.describe('R4 — ② 二次改值链（同一银行行被多次改 FundType）', () => {
  test('网关 TradeType=HX_OUTBOUND + 银行 FundType=Charge：charge-outbound 先把 Charge→outbound，hx-out 再把 outbound→HX-out', () => {
    const g1 = gw('R-CHAIN', 'HX_OUTBOUND'); // 同时满足 hx-out 的 gwTradeType
    const b1 = bank('rid-chain', 'R-CHAIN', 'Charge');

    // charge-outbound 与 hx-out 同 priority(1)；数组顺序：charge-outbound 在前 → 先执行
    // 第一步：charge-outbound 命中（FundType=Charge）→ Charge→outbound
    // 第二步：hx-out 命中（TradeType=HX_OUTBOUND，且此刻 FundType=outbound≠HX-out）→ outbound→HX-out
    const result = runRound4FundNatureCheck(
      [g1],
      [b1],
      [SCENARIO_CHARGE_OUTBOUND, SCENARIO_HX_OUT]
    );

    // 最终值 = HX-out（叠加链生效）
    assert.equal(b1.FundType, 'HX-out');

    // 两条 modification 都在，且顺序 = Charge→outbound、outbound→HX-out
    const chainMods = modsFor(result, 'rid-chain', 'FundType');
    assert.equal(chainMods.length, 2, '应有两条 FundType modification（叠加链）');
    assert.deepEqual(
      chainMods.map((m) => [m.oldValue, m.newValue]),
      [
        ['Charge', 'outbound'],
        ['outbound', 'HX-out']
      ]
    );
  });

  test('叠加链中若某步旧值已等于目标值则跳过该步（charge-outbound 命中改值后，再遇 charge-outbound 不重复 record）', () => {
    // 两条 charge-outbound（模拟重复 config）：第一条把 Charge→outbound；第二条此刻 FundType=outbound≠Charge → 不命中
    const g1 = gw('R-DUP', '任意');
    const b1 = bank('rid-dup', 'R-DUP', 'Charge');

    const result = runRound4FundNatureCheck(
      [g1],
      [b1],
      [SCENARIO_CHARGE_OUTBOUND, SCENARIO_CHARGE_OUTBOUND]
    );

    assert.equal(b1.FundType, 'outbound');
    // 仅一条 modification（第二条因 requireBankFundType=Charge 不再满足 → 不命中）
    assert.equal(modsFor(result, 'rid-dup', 'FundType').length, 1);
  });
});

// ========================================================================
// ③ 旧值 == 目标值 → 不改不 record（no-op）
// ========================================================================
test.describe('R4 — ③ 旧值==目标值 no-op（不改不 record）', () => {
  test('银行 FundType 已是 Ach Return + 网关 AchReturn 命中 → 不产 modification', () => {
    const g1 = gw('R-NOOP', 'AchReturn');
    const b1 = bank('rid-noop', 'R-NOOP', 'Ach Return'); // 已是目标值

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_ACH_RETURN]);

    assert.equal(b1.FundType, 'Ach Return'); // 不变
    assert.equal(result.modifications.length, 0, '旧值==目标值 → 无 modification');
  });

  test('hx-out 命中但银行 FundType 已是 HX-out → no-op', () => {
    const g1 = gw('R-NOOP2', 'HX_OUTBOUND');
    const b1 = bank('rid-noop2', 'R-NOOP2', 'HX-out');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_HX_OUT]);

    assert.equal(b1.FundType, 'HX-out');
    assert.equal(result.modifications.length, 0);
  });
});

// ========================================================================
// ④ 一个 reconid 关联多条 Charge 行（charge-outbound）→ 仅 Debit Amount 最大那行转 outbound
//    （v3.0.4 块 G：由「逐条全转」收紧为「仅转最大行」，G1-G7 口径）
// ========================================================================
test.describe('R4 — ④ charge-outbound 同桶多条 Charge → 仅转 Debit Amount 最大行（v3.0.4 块 G）', () => {
  test('同 reconid 三行（Charge[Debit 10] / Charge[Debit 99] / Inbound）→ 仅 Debit 99 那行转 outbound，1 条 modification', () => {
    const g1 = gw('R-MULTI', '任意');
    const b1 = bank('rid-m1', 'R-MULTI', 'Charge', { 'Debit Amount': 10 });
    const b2 = bank('rid-m2', 'R-MULTI', 'Charge', { 'Debit Amount': 99 }); // Debit 最大
    const b3 = bank('rid-m3', 'R-MULTI', 'Inbound'); // 非 Charge，从不参与候选

    const result = runRound4FundNatureCheck([g1], [b1, b2, b3], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'Charge');    // 非最大，未转
    assert.equal(b2.FundType, 'outbound');  // Debit 最大，转
    assert.equal(b3.FundType, 'Inbound');   // 非 Charge，未改
    // 仅一条 modification（b2）
    assert.equal(result.modifications.length, 1);
    assert.equal(modsFor(result, 'rid-m1', 'FundType').length, 0);
    assert.equal(modsFor(result, 'rid-m2', 'FundType').length, 1);
    assert.equal(modsFor(result, 'rid-m3', 'FundType').length, 0);
    assert.equal(result.modifications[0].oldValue, 'Charge');
    assert.equal(result.modifications[0].newValue, 'outbound');
  });
});

// ========================================================================
// ④b charge-outbound 多行挑选细则（v3.0.4 块 G：G4/G5/G6 + 链式 + G7 + 转分边界）
// ========================================================================
test.describe('R4 — ④b charge-outbound 多行挑选细则（G4/G5/G6/G7 + 链式 + 转分）', () => {
  // (1) G5 并列最大取桶内原序首行（first-wins）
  test('并列最大：两条 Charge 的 Debit Amount 相等 → 取桶内原序首行转，第二条不转', () => {
    const g1 = gw('R-TIE', '任意');
    const b1 = bank('rid-t1', 'R-TIE', 'Charge', { 'Debit Amount': 50 }); // 原序首行
    const b2 = bank('rid-t2', 'R-TIE', 'Charge', { 'Debit Amount': 50 }); // 并列最大，但靠后

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'outbound'); // 原序首行
    assert.equal(b2.FundType, 'Charge');   // 并列但靠后 → 不转
    assert.equal(result.modifications.length, 1);
    assert.equal(modsFor(result, 'rid-t1', 'FundType').length, 1);
    assert.equal(modsFor(result, 'rid-t2', 'FundType').length, 0);
  });

  // (2) G4 Debit Amount 空/非数值 → parseNumber fallback 0
  test('非数值 fallback 0：一行 Debit=非数值(fallback 0) / 一行 Debit=空(fallback 0) / 一行 Debit=0.01 → 取 0.01 那行', () => {
    const g1 = gw('R-NAN', '任意');
    const b1 = bank('rid-n1', 'R-NAN', 'Charge', { 'Debit Amount': 'abc' }); // 非数值 → 0
    const b2 = bank('rid-n2', 'R-NAN', 'Charge', { 'Debit Amount': '' });    // 空 → 0
    const b3 = bank('rid-n3', 'R-NAN', 'Charge', { 'Debit Amount': 0.01 });  // 唯一正值 → 最大

    const result = runRound4FundNatureCheck([g1], [b1, b2, b3], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'Charge');
    assert.equal(b2.FundType, 'Charge');
    assert.equal(b3.FundType, 'outbound'); // 0.01 > 0 > 0
    assert.equal(result.modifications.length, 1);
    assert.equal(modsFor(result, 'rid-n3', 'FundType').length, 1);
  });

  test('全空/非数值并列 0 → 取桶内原序首行（G5 在 fallback 0 上同样成立）', () => {
    const g1 = gw('R-ALLNAN', '任意');
    const b1 = bank('rid-a1', 'R-ALLNAN', 'Charge'); // 无 Debit Amount → 0
    const b2 = bank('rid-a2', 'R-ALLNAN', 'Charge', { 'Debit Amount': 'xx' }); // 非数值 → 0

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'outbound'); // 原序首行
    assert.equal(b2.FundType, 'Charge');
    assert.equal(result.modifications.length, 1);
  });

  // (3) G6 单行桶 → 行为与现状一致（直接转，无需比较）
  test('单行桶：桶内仅一条 Charge（Debit 任意/缺省）→ 直接转 outbound（行为同现状）', () => {
    const g1 = gw('R-SINGLE', '任意');
    const b1 = bank('rid-s1', 'R-SINGLE', 'Charge'); // 单行桶，无 Debit Amount

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'outbound');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].oldValue, 'Charge');
    assert.equal(result.modifications[0].newValue, 'outbound');
  });

  // (4) G1 范围锁：非 charge-outbound 子场景（ach-return）同桶多行仍逐条全转，不受挑选影响
  test('G1 范围锁：ach-return 同桶多条 Charge → 仍逐条全转 Ach Return（不读 Debit、不挑选）', () => {
    const g1 = gw('R-ACH-MULTI', 'AchReturn');
    const b1 = bank('rid-ac1', 'R-ACH-MULTI', 'Charge', { 'Debit Amount': 1 });
    const b2 = bank('rid-ac2', 'R-ACH-MULTI', 'Charge', { 'Debit Amount': 100 });
    const b3 = bank('rid-ac3', 'R-ACH-MULTI', 'Charge', { 'Debit Amount': 5 });

    const result = runRound4FundNatureCheck([g1], [b1, b2, b3], [SCENARIO_ACH_RETURN]);

    // ach-return 维持逐条全转：三条都改为 Ach Return
    assert.equal(b1.FundType, 'Ach Return');
    assert.equal(b2.FundType, 'Ach Return');
    assert.equal(b3.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 3);
  });

  // (5) 链式：target 行 outbound→HX-out 仍成立；未选中 Charge 行不进链（停留 Charge）
  test('链式：同桶 charge-outbound + hx-out → 仅 target 行转 outbound 再续改 HX-out，未选中 Charge 行不进链', () => {
    const g1 = gw('R-CHAIN-MULTI', 'HX_OUTBOUND'); // 同时满足 hx-out 的 gwTradeType
    const b1 = bank('rid-cm1', 'R-CHAIN-MULTI', 'Charge', { 'Debit Amount': 10 }); // 非最大
    const b2 = bank('rid-cm2', 'R-CHAIN-MULTI', 'Charge', { 'Debit Amount': 88 }); // Debit 最大 → target

    const result = runRound4FundNatureCheck(
      [g1],
      [b1, b2],
      [SCENARIO_CHARGE_OUTBOUND, SCENARIO_HX_OUT]
    );

    // target 行 b2 走链 Charge→outbound→HX-out；b1 未选中 → 不进 charge-outbound，
    // 但 hx-out 子场景对 b1（仍 Charge）按 gwTradeType=HX_OUTBOUND 命中 → Charge→HX-out（hx-out 维持逐条全转，G1）。
    assert.equal(b2.FundType, 'HX-out');
    const b2Chain = modsFor(result, 'rid-cm2', 'FundType').map((m) => [m.oldValue, m.newValue]);
    assert.deepEqual(b2Chain, [
      ['Charge', 'outbound'],
      ['outbound', 'HX-out']
    ]);
    // b1 未进 charge-outbound（不产 Charge→outbound），但 hx-out 命中 → 一步 Charge→HX-out
    assert.equal(b1.FundType, 'HX-out');
    const b1Chain = modsFor(result, 'rid-cm1', 'FundType').map((m) => [m.oldValue, m.newValue]);
    assert.deepEqual(b1Chain, [['Charge', 'HX-out']]);
  });

  test('链式（纯 charge-outbound）：未选中 Charge 行停留 Charge，不进任何后续链', () => {
    const g1 = gw('R-CHAIN2', '任意'); // 仅 charge-outbound 场景，无 hx-out
    const b1 = bank('rid-c21', 'R-CHAIN2', 'Charge', { 'Debit Amount': 10 });
    const b2 = bank('rid-c22', 'R-CHAIN2', 'Charge', { 'Debit Amount': 88 }); // target

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b2.FundType, 'outbound');
    assert.equal(b1.FundType, 'Charge'); // 未选中 → 停留 Charge，不进链
    assert.equal(result.modifications.length, 1);
  });

  // (6) G7：同桶被双网关行命中 → 仍只转同一行（第二次 target 已 outbound → no-op）
  test('G7：同桶被两条网关行重复命中 → 仅转同一行（Debit 最大），不会因第一次改写而再转第二行', () => {
    // charge-outbound config 无 gwTradeType，两条网关行都会进入关联并命中
    const g1 = gw('R-DUAL', '任意1');
    const g2 = gw('R-DUAL', '任意2'); // 同 reconid 第二条网关行
    const b1 = bank('rid-d1', 'R-DUAL', 'Charge', { 'Debit Amount': 30 });
    const b2 = bank('rid-d2', 'R-DUAL', 'Charge', { 'Debit Amount': 90 }); // Debit 最大 → target

    const result = runRound4FundNatureCheck([g1, g2], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b2.FundType, 'outbound');
    assert.equal(b1.FundType, 'Charge'); // 第二次命中未误转次大行
    // 仅一条 modification（b2 第一次转；第二次 target 已是 outbound → applyHandler requireBankFundType=Charge 不满足 → no-op）
    assert.equal(result.modifications.length, 1);
    assert.equal(modsFor(result, 'rid-d2', 'FundType').length, 1);
    assert.equal(modsFor(result, 'rid-d1', 'FundType').length, 0);
  });

  // (7) 转分边界：10.005 vs 10.01 → Math.round(*100)=1001 vs 1001 并列 → 取原序首行
  test('转分边界：Debit 10.005(→1001 分) vs 10.01(→1001 分) 并列 → 取桶内原序首行', () => {
    const g1 = gw('R-CENTS', '任意');
    const b1 = bank('rid-ce1', 'R-CENTS', 'Charge', { 'Debit Amount': 10.005 }); // round(*100)=1001
    const b2 = bank('rid-ce2', 'R-CENTS', 'Charge', { 'Debit Amount': 10.01 });  // round(*100)=1001

    // 先核对转分前提：两者转分相等
    assert.equal(Math.round(10.005 * 100), Math.round(10.01 * 100));

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'outbound'); // 转分并列 → 原序首行
    assert.equal(b2.FundType, 'Charge');
    assert.equal(result.modifications.length, 1);
  });

  test('转分边界：Debit 10.01(→1001 分) > 10.004(→1000 分) → 取 10.01 那行（非并列）', () => {
    const g1 = gw('R-CENTS2', '任意');
    const b1 = bank('rid-cf1', 'R-CENTS2', 'Charge', { 'Debit Amount': 10.004 }); // round(*100)=1000
    const b2 = bank('rid-cf2', 'R-CENTS2', 'Charge', { 'Debit Amount': 10.01 });  // round(*100)=1001 → 最大

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_CHARGE_OUTBOUND]);

    assert.equal(b1.FundType, 'Charge');
    assert.equal(b2.FundType, 'outbound');
    assert.equal(result.modifications.length, 1);
  });
});

// ========================================================================
// ⑤ matchedGwRows 里 reconid 在 bank 中无对应 → 跳过无改动
// ========================================================================
test.describe('R4 — ⑤ 网关 reconid 在银行侧无对应 → 跳过无改动', () => {
  test('网关 reconid 在银行索引中不存在 → 不改任何行、无 modification', () => {
    const gMiss = gw('R-404', 'AchReturn'); // 银行侧无此 reconid
    const gOk = gw('R-OK', 'AchReturn');
    const bOk = bank('rid-ok', 'R-OK', 'Charge');

    const result = runRound4FundNatureCheck([gMiss, gOk], [bOk], [SCENARIO_ACH_RETURN]);

    // 只有 R-OK 关联到银行行并改写；R-404 跳过
    assert.equal(bOk.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].rowId, 'rid-ok');
  });

  test('网关行空 reconid → 跳过不参与关联（即便 TradeType 命中也不改）', () => {
    const gEmpty = gw('', 'AchReturn');
    const gBlank = gw('   ', 'AchReturn');
    const bEmpty = bank('rid-e', '', 'Charge');     // 银行空 reconid 不入索引
    const bReal = bank('rid-r', 'R-REAL', 'Charge'); // 与任何空键网关都关联不上

    const result = runRound4FundNatureCheck([gEmpty, gBlank], [bEmpty, bReal], [SCENARIO_ACH_RETURN]);

    assert.equal(bEmpty.FundType, 'Charge'); // 未改
    assert.equal(bReal.FundType, 'Charge');  // 未改
    assert.equal(result.modifications.length, 0);
  });
});

// ========================================================================
// ⑥ 按 priority 顺序执行（高 priority 先）
// ========================================================================
test.describe('R4 — ⑥ 按 priority 降序执行（高 priority 先跑）', () => {
  test('数组乱序传入（低 priority 在前）→ 引擎按 priority 降序排序：ach-return(3) 先于 wire-return(2) 执行', () => {
    // 构造一条网关行同时满足 ach-return 与 wire-return？两者 gwTradeType 互斥，不能同时命中。
    // 改用「叠加链 + 旧值守卫」验证顺序：
    //   - scenA(priority 2)：gwTradeType=T，setFundType=B（把 A→B）
    //   - scenB(priority 3)：gwTradeType=T，setFundType=C（把任意→C，但若先跑则 A→C）
    // 若按 priority 降序，scenB(3) 先跑：A→C，然后 scenA(2)：C→B → 最终 B，链 = [A→C, C→B]
    // 若按数组原序（错误），scenA 先：A→B，scenB：B→C → 最终 C，链 = [A→B, B→C]
    const scenA = { priority: 2, config: { subCategory: 'pa', gwTradeType: 'T', setFundType: 'B' } };
    const scenB = { priority: 3, config: { subCategory: 'pb', gwTradeType: 'T', setFundType: 'C' } };

    const g1 = gw('R-PRI', 'T');
    const b1 = bank('rid-pri', 'R-PRI', 'A');

    // 数组原序故意把低 priority 的 scenA 放前面，验证引擎确实重排
    const result = runRound4FundNatureCheck([g1], [b1], [scenA, scenB]);

    // 按 priority 降序：scenB(3) 先 → A→C，scenA(2) 后 → C→B
    assert.equal(b1.FundType, 'B');
    const chain = modsFor(result, 'rid-pri', 'FundType').map((m) => [m.oldValue, m.newValue]);
    assert.deepEqual(chain, [
      ['A', 'C'],
      ['C', 'B']
    ]);
  });

  test('同 priority 保持数组原序（charge-outbound 在 hx-out 前 → 先 Charge→outbound 再 outbound→HX-out）', () => {
    const g1 = gw('R-TIE', 'HX_OUTBOUND');
    const b1 = bank('rid-tie', 'R-TIE', 'Charge');

    const result = runRound4FundNatureCheck(
      [g1],
      [b1],
      [SCENARIO_CHARGE_OUTBOUND, SCENARIO_HX_OUT] // 同 priority(1)，数组序 charge-outbound 在前
    );

    const chain = modsFor(result, 'rid-tie', 'FundType').map((m) => [m.oldValue, m.newValue]);
    assert.deepEqual(chain, [
      ['Charge', 'outbound'],
      ['outbound', 'HX-out']
    ]);
  });

  test('五子场景全量传入 + 银行行 Charge + 网关 HX_OUTBOUND → 叠加链最终 HX-out（默认顺序回归）', () => {
    const g1 = gw('R-ALL', 'HX_OUTBOUND');
    const b1 = bank('rid-all', 'R-ALL', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], ALL_FIVE);

    // ach-return/wire-return/hx-in 因 gwTradeType 不匹配不命中；
    // charge-outbound(FundType=Charge)→outbound；hx-out(TradeType=HX_OUTBOUND)→HX-out
    assert.equal(b1.FundType, 'HX-out');
    assert.equal(modsFor(result, 'rid-all', 'FundType').length, 2);
  });
});

// ========================================================================
// ⑦ 空入参防御（返回空 modifications，不崩）
// ========================================================================
test.describe('R4 — ⑦ 空入参防御', () => {
  test('matchedGwRows 为空 → 空 modifications', () => {
    const b1 = bank('rid-1', 'R-001', 'Charge');
    const result = runRound4FundNatureCheck([], [b1], ALL_FIVE);
    assert.deepEqual(result.modifications, []);
    assert.equal(b1.FundType, 'Charge'); // 未改
  });

  test('bankRows 为空 → 空 modifications', () => {
    const result = runRound4FundNatureCheck([gw('R-001', 'AchReturn')], [], ALL_FIVE);
    assert.deepEqual(result.modifications, []);
  });

  test('r4Scenarios 为空 → 空 modifications', () => {
    const b1 = bank('rid-1', 'R-001', 'Charge');
    const result = runRound4FundNatureCheck([gw('R-001', 'AchReturn')], [b1], []);
    assert.deepEqual(result.modifications, []);
    assert.equal(b1.FundType, 'Charge'); // 未改
  });

  test('三个入参均 null/undefined → 不崩、空 modifications', () => {
    for (const bad of [null, undefined]) {
      const result = runRound4FundNatureCheck(bad, bad, bad);
      assert.deepEqual(result.modifications, []);
      assert.ok(Array.isArray(result.warnings));
    }
  });
});

// ========================================================================
// 附：applyHandler 单元（config 判定纯函数）
// ========================================================================
test.describe('R4 — applyHandler 纯函数判定', () => {
  test('config 为空 → 返回 null', () => {
    assert.equal(applyHandler(gw('R', 'X'), bank('r', 'R', 'Charge'), null), null);
    assert.equal(applyHandler(gw('R', 'X'), bank('r', 'R', 'Charge'), undefined), null);
  });

  test('gwTradeType 满足 + 无 requireBankFundType → 返回 setFundType', () => {
    const decision = applyHandler(
      gw('R', 'AchReturn'),
      bank('r', 'R', 'Charge'),
      SCENARIO_ACH_RETURN.config
    );
    assert.equal(decision, 'Ach Return');
  });

  test('gwTradeType 不满足 → null', () => {
    const decision = applyHandler(
      gw('R', 'Other'),
      bank('r', 'R', 'Charge'),
      SCENARIO_ACH_RETURN.config
    );
    assert.equal(decision, null);
  });

  test('requireBankFundType 满足才返回（charge-outbound）', () => {
    assert.equal(
      applyHandler(gw('R', '任意'), bank('r', 'R', 'Charge'), SCENARIO_CHARGE_OUTBOUND.config),
      'outbound'
    );
    assert.equal(
      applyHandler(gw('R', '任意'), bank('r', 'R', 'Inbound'), SCENARIO_CHARGE_OUTBOUND.config),
      null
    );
  });

  test('normalizeCellValue 语义：网关 TradeType 带前后空格仍能命中（trim）', () => {
    const decision = applyHandler(
      gw('R', '  AchReturn  '),
      bank('r', 'R', 'Charge'),
      SCENARIO_ACH_RETURN.config
    );
    assert.equal(decision, 'Ach Return');
  });
});
