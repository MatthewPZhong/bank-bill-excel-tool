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
// 四子场景默认 config（TECH_DESIGN §10 / PRD §五，TradeType 真实取值待用户核对，本次按默认实现）：
//   v3.0.6：原 charge-outbound 子场景已迁出至 R3.5 DBS-Charge（dbs-charge-fund-check.js），R4 由 5 → 4 子场景。
//   | subCategory      | gwTradeType   | requireBankFundType | setFundType  | priority |
//   | ach-return       | AchReturn     | —                   | Ach Return   | 3        |
//   | wire-return      | WireReturn    | —                   | Wire Return  | 2        |
//   | hx-out           | HX_OUTBOUND   | —                   | HX-out       | 1        |
//   | hx-in            | HX_INBOUND    | —                   | HX-in        | 0        |
// ========================================================================

// ---- 四子场景默认 config（与 seed 默认值一致；测试按需挑选/重排）----
const SCENARIO_ACH_RETURN = {
  priority: 3,
  config: { subCategory: 'ach-return', gwTradeType: 'AchReturn', setFundType: 'Ach Return' }
};
const SCENARIO_WIRE_RETURN = {
  priority: 2,
  config: { subCategory: 'wire-return', gwTradeType: 'WireReturn', setFundType: 'Wire Return' }
};
const SCENARIO_HX_OUT = {
  priority: 1,
  config: { subCategory: 'hx-out', gwTradeType: 'HX_OUTBOUND', setFundType: 'HX-out' }
};
const SCENARIO_HX_IN = {
  priority: 0,
  config: { subCategory: 'hx-in', gwTradeType: 'HX_INBOUND', setFundType: 'HX-in' }
};
const ALL_FOUR = [
  SCENARIO_ACH_RETURN,
  SCENARIO_WIRE_RETURN,
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

  test('requireBankFundType 通配（hx-out 无 requireBankFundType）：仅凭有 R1 匹配 + gwTradeType 命中 → 改值（不看银行原 FundType 具体值）', () => {
    // hx-out config 无 requireBankFundType，仅靠进入关联 + gwTradeType=HX_OUTBOUND 命中（银行原 FundType 任意）
    const g1 = gw('R-003', 'HX_OUTBOUND');
    const b1 = bank('rid-3', 'R-003', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_HX_OUT]);

    assert.equal(b1.FundType, 'HX-out');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].oldValue, 'Charge');
    assert.equal(result.modifications[0].newValue, 'HX-out');
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
// ② 二次改值链：同一银行行被多个 handler 顺序改 FundType（R4 唯一允许二次改）
//    v3.0.6：原用例以 charge-outbound 作首跳，已退役；改用通用双 handler 构造叠加链（不依赖 charge-outbound）。
//    断言两条 modification 都在、最终值 = 最后一跳目标。
// ========================================================================
test.describe('R4 — ② 二次改值链（同一银行行被多次改 FundType）', () => {
  test('同一银行行被两个 gwTradeType 命中的 handler 顺序改：A→outbound→HX-out（叠加链，不 break）', () => {
    // 两个 handler 都凭 gwTradeType=HX_OUTBOUND 命中（无 requireBankFundType，逐条全转）：
    //   handler1：setFundType='outbound'（priority 2，先跑）→ 把初始 A→outbound
    //   handler2：setFundType='HX-out'（priority 1，后跑）→ 把 outbound→HX-out
    const stepOutbound = {
      priority: 2,
      config: { subCategory: 'step-outbound', gwTradeType: 'HX_OUTBOUND', setFundType: 'outbound' }
    };
    const g1 = gw('R-CHAIN', 'HX_OUTBOUND');
    const b1 = bank('rid-chain', 'R-CHAIN', 'A');

    // priority 降序：stepOutbound(2) 先 → A→outbound；hx-out(1) 后 → outbound→HX-out
    const result = runRound4FundNatureCheck([g1], [b1], [stepOutbound, SCENARIO_HX_OUT]);

    // 最终值 = HX-out（叠加链生效）
    assert.equal(b1.FundType, 'HX-out');

    // 两条 modification 都在，且顺序 = A→outbound、outbound→HX-out
    const chainMods = modsFor(result, 'rid-chain', 'FundType');
    assert.equal(chainMods.length, 2, '应有两条 FundType modification（叠加链）');
    assert.deepEqual(
      chainMods.map((m) => [m.oldValue, m.newValue]),
      [
        ['A', 'outbound'],
        ['outbound', 'HX-out']
      ]
    );
  });

  test('叠加链中若某步旧值已等于目标值则跳过该步（同一 handler 重复 → 第二次旧值==目标值不再 record）', () => {
    // 两条同一 hx-out config（模拟重复）：第一条把 Charge→HX-out；第二条此刻 FundType=HX-out==目标值 → no-op 不 record
    const g1 = gw('R-DUP', 'HX_OUTBOUND');
    const b1 = bank('rid-dup', 'R-DUP', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], [SCENARIO_HX_OUT, SCENARIO_HX_OUT]);

    assert.equal(b1.FundType, 'HX-out');
    // 仅一条 modification（第二条 oldValue==目标值 → 不 record）
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
// ④ 一个 reconid 关联多条银行行（同桶逐条全转）
//    v3.0.6：原 charge-outbound「仅转 Debit Amount 最大行（块 G）」已迁出至 R3.5 DBS-Charge；
//    R4 四子场景一律「同桶逐条全转」，本节验 ach-return 同桶多行全转。
// ========================================================================
test.describe('R4 — ④ 同桶多行逐条全转（四子场景统一口径）', () => {
  test('ach-return 同桶三行 Charge → 逐条全转 Ach Return（3 条 modification）', () => {
    const g1 = gw('R-ACH-MULTI', 'AchReturn');
    const b1 = bank('rid-ac1', 'R-ACH-MULTI', 'Charge');
    const b2 = bank('rid-ac2', 'R-ACH-MULTI', 'Charge');
    const b3 = bank('rid-ac3', 'R-ACH-MULTI', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1, b2, b3], [SCENARIO_ACH_RETURN]);

    // 同桶逐条全转：三条都改为 Ach Return
    assert.equal(b1.FundType, 'Ach Return');
    assert.equal(b2.FundType, 'Ach Return');
    assert.equal(b3.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 3);
  });

  test('hx-out 同桶两行 → 逐条全转 HX-out（2 条 modification，桶内无挑选/无最大行收紧）', () => {
    const g1 = gw('R-HX-MULTI', 'HX_OUTBOUND');
    const b1 = bank('rid-hm1', 'R-HX-MULTI', 'Charge');
    const b2 = bank('rid-hm2', 'R-HX-MULTI', 'Inbound'); // 不同原值，hx-out 无 requireBankFundType → 也命中

    const result = runRound4FundNatureCheck([g1], [b1, b2], [SCENARIO_HX_OUT]);

    assert.equal(b1.FundType, 'HX-out');
    assert.equal(b2.FundType, 'HX-out');
    assert.equal(result.modifications.length, 2);
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

  test('同 priority 保持数组原序（同 priority 两 handler 数组序 step1 在前 → 先 Charge→outbound 再 outbound→HX-out）', () => {
    // 两个同 priority(1) handler，均凭 gwTradeType=HX_OUTBOUND 命中；数组序 step1 在前 → 先执行
    const step1 = {
      priority: 1,
      config: { subCategory: 'step1', gwTradeType: 'HX_OUTBOUND', setFundType: 'outbound' }
    };
    const g1 = gw('R-TIE', 'HX_OUTBOUND');
    const b1 = bank('rid-tie', 'R-TIE', 'Charge');

    const result = runRound4FundNatureCheck(
      [g1],
      [b1],
      [step1, SCENARIO_HX_OUT] // 同 priority(1)，数组序 step1 在前
    );

    const chain = modsFor(result, 'rid-tie', 'FundType').map((m) => [m.oldValue, m.newValue]);
    assert.deepEqual(chain, [
      ['Charge', 'outbound'],
      ['outbound', 'HX-out']
    ]);
  });

  test('四子场景全量传入 + 银行行 Charge + 网关 HX_OUTBOUND → hx-out 命中 Charge→HX-out（默认顺序回归）', () => {
    const g1 = gw('R-ALL', 'HX_OUTBOUND');
    const b1 = bank('rid-all', 'R-ALL', 'Charge');

    const result = runRound4FundNatureCheck([g1], [b1], ALL_FOUR);

    // ach-return/wire-return/hx-in 因 gwTradeType 不匹配不命中；hx-out(TradeType=HX_OUTBOUND)→HX-out（一步）
    assert.equal(b1.FundType, 'HX-out');
    assert.equal(modsFor(result, 'rid-all', 'FundType').length, 1);
  });
});

// ========================================================================
// ⑦ 空入参防御（返回空 modifications，不崩）
// ========================================================================
test.describe('R4 — ⑦ 空入参防御', () => {
  test('matchedGwRows 为空 → 空 modifications', () => {
    const b1 = bank('rid-1', 'R-001', 'Charge');
    const result = runRound4FundNatureCheck([], [b1], ALL_FOUR);
    assert.deepEqual(result.modifications, []);
    assert.equal(b1.FundType, 'Charge'); // 未改
  });

  test('bankRows 为空 → 空 modifications', () => {
    const result = runRound4FundNatureCheck([gw('R-001', 'AchReturn')], [], ALL_FOUR);
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
// ⑧ v3.0.10 需求1：银行行借贷方向守卫（🔴 资金红线）
//   命中网关 TradeType 后再判一层方向——config.requireBankZeroField 指定的「应为0」金额列若实际非0
//   （方向录反）→ 不改写 FundType + 记 warning（code='r4-fund-direction-mismatch'）。
//   口径 (parseNumber(x) || 0) === 0：空/garbage/双零 当 0 = 满足、不拦截（与全仓一致）。
//   4 子场景方向规律：出账性质（Ach Return/HX-out）要求 Credit Amount=0；入账性质（Wire Return/HX-in）要求 Debit Amount=0。
// ========================================================================

// 取某 rowId + code 的全部 warning（按记录顺序）
function warnsFor(result, rowId, code) {
  return result.warnings.filter((w) => w.rowId === rowId && w.code === code);
}

// 4 子场景带方向守卫的 config（与 seed/迁移补种值逐字一致）
const SCEN_ACH_GUARD = {
  priority: 3,
  config: { subCategory: 'ach-return', gwTradeType: 'AchReturn', setFundType: 'Ach Return', requireBankZeroField: 'Credit Amount' }
};
const SCEN_WIRE_GUARD = {
  priority: 2,
  config: { subCategory: 'wire-return', gwTradeType: 'WireReturn', setFundType: 'Wire Return', requireBankZeroField: 'Debit Amount' }
};
const SCEN_HXOUT_GUARD = {
  priority: 1,
  config: { subCategory: 'hx-out', gwTradeType: 'HX_OUTBOUND', setFundType: 'HX-out', requireBankZeroField: 'Credit Amount' }
};
const SCEN_HXIN_GUARD = {
  priority: 0,
  config: { subCategory: 'hx-in', gwTradeType: 'HX_INBOUND', setFundType: 'HX-in', requireBankZeroField: 'Debit Amount' }
};

test.describe('R4 — ⑧ 方向守卫：4 子场景方向满足/不满足', () => {
  test('ach-return（要求 Credit=0）：Credit=0 → 满足，正常改写 + 无 warning', () => {
    const g1 = gw('R-A1', 'AchReturn');
    const b1 = bank('rid-a1', 'R-A1', 'Charge', { 'Debit Amount': '100', 'Credit Amount': '0' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '方向满足 → 改写');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.warnings.length, 0, '方向满足不产 warning');
  });

  test('ach-return（要求 Credit=0）：Credit≠0 → 方向录反，不改写 + warning（code/rowId/message）', () => {
    const g1 = gw('R-A2', 'AchReturn');
    const b1 = bank('rid-a2', 'R-A2', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '88' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Charge', '方向不符 → 不改写');
    assert.equal(result.modifications.length, 0, '方向不符不产 modification');
    const w = warnsFor(result, 'rid-a2', 'r4-fund-direction-mismatch');
    assert.equal(w.length, 1, '应恰好一条方向不符 warning');
    assert.equal(w[0].scenarioId, 'R4');
    assert.equal(w[0].scenarioName, '资金性质校验');
    assert.match(w[0].message, /Credit Amount/);
    assert.match(w[0].message, /方向不符/);
    assert.match(w[0].message, /Ach Return/);
  });

  test('wire-return（要求 Debit=0）：Debit=0 → 满足，正常改写', () => {
    const g1 = gw('R-W1', 'WireReturn');
    const b1 = bank('rid-w1', 'R-W1', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '200' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_WIRE_GUARD]);

    assert.equal(b1.FundType, 'Wire Return');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.warnings.length, 0);
  });

  test('wire-return（要求 Debit=0）：Debit≠0 → 方向录反，不改写 + warning', () => {
    const g1 = gw('R-W2', 'WireReturn');
    const b1 = bank('rid-w2', 'R-W2', 'Charge', { 'Debit Amount': '300', 'Credit Amount': '0' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_WIRE_GUARD]);

    assert.equal(b1.FundType, 'Charge');
    assert.equal(result.modifications.length, 0);
    const w = warnsFor(result, 'rid-w2', 'r4-fund-direction-mismatch');
    assert.equal(w.length, 1);
    assert.match(w[0].message, /Debit Amount/);
  });

  test('hx-out（要求 Credit=0）：Credit≠0 → 不改写 + warning；Credit=0 → 改写', () => {
    const gBad = gw('R-HO-BAD', 'HX_OUTBOUND');
    const bBad = bank('rid-ho-bad', 'R-HO-BAD', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '5' });
    const rBad = runRound4FundNatureCheck([gBad], [bBad], [SCEN_HXOUT_GUARD]);
    assert.equal(bBad.FundType, 'Charge');
    assert.equal(warnsFor(rBad, 'rid-ho-bad', 'r4-fund-direction-mismatch').length, 1);

    const gOk = gw('R-HO-OK', 'HX_OUTBOUND');
    const bOk = bank('rid-ho-ok', 'R-HO-OK', 'Charge', { 'Debit Amount': '7', 'Credit Amount': '0' });
    const rOk = runRound4FundNatureCheck([gOk], [bOk], [SCEN_HXOUT_GUARD]);
    assert.equal(bOk.FundType, 'HX-out');
    assert.equal(rOk.warnings.length, 0);
  });

  test('hx-in（要求 Debit=0）：Debit≠0 → 不改写 + warning；Debit=0 → 改写', () => {
    const gBad = gw('R-HI-BAD', 'HX_INBOUND');
    const bBad = bank('rid-hi-bad', 'R-HI-BAD', 'Charge', { 'Debit Amount': '9', 'Credit Amount': '0' });
    const rBad = runRound4FundNatureCheck([gBad], [bBad], [SCEN_HXIN_GUARD]);
    assert.equal(bBad.FundType, 'Charge');
    assert.equal(warnsFor(rBad, 'rid-hi-bad', 'r4-fund-direction-mismatch').length, 1);

    const gOk = gw('R-HI-OK', 'HX_INBOUND');
    const bOk = bank('rid-hi-ok', 'R-HI-OK', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '3' });
    const rOk = runRound4FundNatureCheck([gOk], [bOk], [SCEN_HXIN_GUARD]);
    assert.equal(bOk.FundType, 'HX-in');
    assert.equal(rOk.warnings.length, 0);
  });
});

test.describe('R4 — ⑧ 方向守卫：「应为0」口径边界（garbage/空/双零/负数）', () => {
  test('应为0列为空字符串 → 当 0 = 满足、不拦截（正常改写）', () => {
    const g1 = gw('R-E1', 'AchReturn');
    const b1 = bank('rid-e1', 'R-E1', 'Charge', { 'Debit Amount': '100', 'Credit Amount': '' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '空字符串当 0 → 满足 → 改写');
    assert.equal(result.warnings.length, 0);
  });

  test('应为0列缺失（undefined）→ 当 0 = 满足、不拦截', () => {
    const g1 = gw('R-E2', 'AchReturn');
    const b1 = bank('rid-e2', 'R-E2', 'Charge', { 'Debit Amount': '100' }); // 无 Credit Amount 键

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '缺失列当 0 → 满足');
    assert.equal(result.warnings.length, 0);
  });

  test('应为0列为 garbage（非数字文本）→ parseNumber 解析失败当 0 = 满足、不拦截', () => {
    const g1 = gw('R-E3', 'AchReturn');
    const b1 = bank('rid-e3', 'R-E3', 'Charge', { 'Debit Amount': '100', 'Credit Amount': 'N/A' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', 'garbage 当 0 → 满足（与全仓 parseNumber||0 口径一致）');
    assert.equal(result.warnings.length, 0);
  });

  test('双零（Debit=0 且 Credit=0）→ 满足、不拦截（正常改写）', () => {
    const g1 = gw('R-E4', 'AchReturn');
    const b1 = bank('rid-e4', 'R-E4', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '0' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '双零 → Credit=0 满足 → 改写');
    assert.equal(result.warnings.length, 0);
  });

  test('应为0列为负数（非0）→ 方向不符，不改写 + warning（负数也算非0）', () => {
    const g1 = gw('R-E5', 'AchReturn');
    const b1 = bank('rid-e5', 'R-E5', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '-12.5' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Charge', '负数非0 → 方向不符 → 不改写');
    assert.equal(warnsFor(result, 'rid-e5', 'r4-fund-direction-mismatch').length, 1);
  });

  test('应为0列带千分位（非0）→ parseNumber 解析出非0 → 方向不符拦截', () => {
    const g1 = gw('R-E6', 'AchReturn');
    const b1 = bank('rid-e6', 'R-E6', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '1,234.50' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Charge', '千分位 1,234.50 解析为非0 → 方向不符 → 不改写');
    assert.equal(warnsFor(result, 'rid-e6', 'r4-fund-direction-mismatch').length, 1);
  });
});

test.describe('R4 — ⑧ 方向守卫：叠加链中途不符（停在上一跳）+ no-op 交互', () => {
  test('叠加链：handler1 命中改值，handler2 命中但方向不符 → 停在 handler1 的值 + handler2 push warn', () => {
    // 两个 handler 均凭 gwTradeType=HX_OUTBOUND 命中（同一银行行叠加链）：
    //   step1（priority 2，无方向守卫）：A→step1Value
    //   hx-out（priority 1，要求 Credit=0）：银行行 Credit≠0 → 方向不符 → 不改、push warn
    // 最终值 = step1Value（停在上一跳），warning 来自 hx-out。
    const step1 = {
      priority: 2,
      config: { subCategory: 'step1', gwTradeType: 'HX_OUTBOUND', setFundType: 'step1Value' }
    };
    const g1 = gw('R-CHAIN-BAD', 'HX_OUTBOUND');
    const b1 = bank('rid-chain-bad', 'R-CHAIN-BAD', 'A', { 'Debit Amount': '0', 'Credit Amount': '50' });

    const result = runRound4FundNatureCheck([g1], [b1], [step1, SCEN_HXOUT_GUARD]);

    // step1 改成功（无方向守卫），hx-out 方向不符停下
    assert.equal(b1.FundType, 'step1Value', '停在 handler1 的值（hx-out 这一跳不改）');
    assert.equal(modsFor(result, 'rid-chain-bad', 'FundType').length, 1, '仅 step1 一条 modification');
    assert.equal(result.modifications[0].newValue, 'step1Value');
    assert.equal(warnsFor(result, 'rid-chain-bad', 'r4-fund-direction-mismatch').length, 1, 'hx-out 这一跳 push 一条 warn');
  });

  test('叠加链：前一跳方向不符（不改+warn），后一跳方向满足 → 后一跳基于原值改（各判各的）', () => {
    // step-bad（priority 2，要求 Credit=0）：银行 Credit≠0 → 方向不符 → 不改、warn
    // step-ok（priority 1，要求 Debit=0）：银行 Debit=0 → 满足 → 把原值 A→okValue
    // 结果：最终 okValue（后一跳基于未改的原值 A 改），一条 warn + 一条 modification。
    const stepBad = {
      priority: 2,
      config: { subCategory: 'step-bad', gwTradeType: 'HX_OUTBOUND', setFundType: 'badValue', requireBankZeroField: 'Credit Amount' }
    };
    const stepOk = {
      priority: 1,
      config: { subCategory: 'step-ok', gwTradeType: 'HX_OUTBOUND', setFundType: 'okValue', requireBankZeroField: 'Debit Amount' }
    };
    const g1 = gw('R-CHAIN-MIX', 'HX_OUTBOUND');
    const b1 = bank('rid-chain-mix', 'R-CHAIN-MIX', 'A', { 'Debit Amount': '0', 'Credit Amount': '50' });

    const result = runRound4FundNatureCheck([g1], [b1], [stepBad, stepOk]);

    assert.equal(b1.FundType, 'okValue', 'step-bad 跳过（方向不符），step-ok 基于原值 A 改为 okValue');
    const mods = modsFor(result, 'rid-chain-mix', 'FundType');
    assert.equal(mods.length, 1, '仅 step-ok 一条 modification');
    assert.deepEqual([mods[0].oldValue, mods[0].newValue], ['A', 'okValue'], 'step-ok 基于未被改的原值 A');
    assert.equal(warnsFor(result, 'rid-chain-mix', 'r4-fund-direction-mismatch').length, 1, 'step-bad 一条 warn');
  });

  test('no-op 交互：方向满足但 oldValue==decision（已是目标值）→ 不 warn 不 record（既有语义不变）', () => {
    const g1 = gw('R-NOOP-GUARD', 'AchReturn');
    // 已是目标值 Ach Return + Credit=0（方向满足）→ 走 no-op：不 record；方向守卫只在「确实要改」前拦，不影响 no-op
    const b1 = bank('rid-noop-guard', 'R-NOOP-GUARD', 'Ach Return', { 'Debit Amount': '100', 'Credit Amount': '0' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '不变');
    assert.equal(result.modifications.length, 0, '旧值==目标值 → 无 modification');
    assert.equal(result.warnings.length, 0, 'no-op 不 warn（方向守卫不影响 no-op）');
  });

  test('no-op 交互：方向不符但 oldValue==decision（已是目标值）→ 守卫先拦截 → push warn、不 record', () => {
    // 守卫在改写判定之前执行：即便 oldValue 已等于 decision，方向不符也会先 push warn + continue（不进 no-op 分支）。
    const g1 = gw('R-NOOP-BAD', 'AchReturn');
    const b1 = bank('rid-noop-bad', 'R-NOOP-BAD', 'Ach Return', { 'Debit Amount': '0', 'Credit Amount': '5' });

    const result = runRound4FundNatureCheck([g1], [b1], [SCEN_ACH_GUARD]);

    assert.equal(b1.FundType, 'Ach Return', '不改（守卫拦截，且本来就等于目标值）');
    assert.equal(result.modifications.length, 0, '无 modification');
    assert.equal(warnsFor(result, 'rid-noop-bad', 'r4-fund-direction-mismatch').length, 1, '方向不符即便 no-op 也 push warn（守卫先于 no-op 判定）');
  });

  test('无 requireBankZeroField（老库未迁移/被清空）→ 守卫退化为不生效（走原改写，方向任意都改）', () => {
    // config 无 requireBankZeroField → zf=undefined → 跳过守卫 → 走原改写（即便方向"录反"也照改，等同 v3.0.10 前行为）
    const g1 = gw('R-NOFIELD', 'AchReturn');
    const b1 = bank('rid-nofield', 'R-NOFIELD', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '999' });
    const noFieldScen = { priority: 3, config: { subCategory: 'ach-return', gwTradeType: 'AchReturn', setFundType: 'Ach Return' } };

    const result = runRound4FundNatureCheck([g1], [b1], [noFieldScen]);

    assert.equal(b1.FundType, 'Ach Return', '无守卫字段 → 不拦截 → 照改');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.warnings.length, 0, '无守卫字段 → 不产 warning');
  });

  test('requireBankZeroField 为非法值（非两合法列名）→ 守卫不生效（走原改写）', () => {
    const g1 = gw('R-BADFIELD', 'AchReturn');
    const b1 = bank('rid-badfield', 'R-BADFIELD', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '999' });
    const badFieldScen = {
      priority: 3,
      config: { subCategory: 'ach-return', gwTradeType: 'AchReturn', setFundType: 'Ach Return', requireBankZeroField: 'Some Other Column' }
    };

    const result = runRound4FundNatureCheck([g1], [b1], [badFieldScen]);

    assert.equal(b1.FundType, 'Ach Return', '非法守卫字段值 → 守卫不生效 → 照改');
    assert.equal(result.warnings.length, 0);
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

  test('requireBankFundType 满足才返回（银行 FundType 门控，通用 config 路径）', () => {
    // 通用 config：requireBankFundType='Charge' → 仅银行 FundType=Charge 命中返回 setFundType，否则 null
    const cfg = { subCategory: 'require-bank-fundtype', requireBankFundType: 'Charge', setFundType: 'outbound' };
    assert.equal(
      applyHandler(gw('R', '任意'), bank('r', 'R', 'Charge'), cfg),
      'outbound'
    );
    assert.equal(
      applyHandler(gw('R', '任意'), bank('r', 'R', 'Inbound'), cfg),
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

  // v3.0.10 需求1：职责分离——applyHandler 是纯判定函数，不读金额列、不管方向守卫。
  //   方向守卫由主循环负责（applyHandler 返回非空后再判方向）；故即便方向"录反"，applyHandler 仍照常返回 setFundType。
  test('🔴 职责分离：applyHandler 不读金额列——即便 requireBankZeroField 指定列非0（方向录反）仍返回 setFundType', () => {
    // config 带 requireBankZeroField，但银行行 Credit Amount=999（方向录反）：applyHandler 不看金额 → 仍命中返回 setFundType
    const decisionAch = applyHandler(
      gw('R', 'AchReturn'),
      bank('r', 'R', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '999' }),
      SCEN_ACH_GUARD.config
    );
    assert.equal(decisionAch, 'Ach Return', 'applyHandler 不读金额：方向不符也返回 setFundType（守卫不在此层）');

    // Debit Amount 非0 的 wire-return 同理：applyHandler 仍返回 setFundType
    const decisionWire = applyHandler(
      gw('R', 'WireReturn'),
      bank('r', 'R', 'Charge', { 'Debit Amount': '500', 'Credit Amount': '0' }),
      SCEN_WIRE_GUARD.config
    );
    assert.equal(decisionWire, 'Wire Return', 'applyHandler 不读金额：方向不符也返回 setFundType');

    // 反证：applyHandler 的命中/不命中只取决于 gwTradeType + requireBankFundType，与 requireBankZeroField/金额列无关
    const decisionMiss = applyHandler(
      gw('R', 'NotAchReturn'),
      bank('r', 'R', 'Charge', { 'Debit Amount': '0', 'Credit Amount': '0' }),
      SCEN_ACH_GUARD.config
    );
    assert.equal(decisionMiss, null, 'gwTradeType 不匹配 → null（与金额列无关）');
  });
});
