const test = require('node:test');
const assert = require('node:assert/strict');

const { runC3Scenario, countC3BankCandidates } = require('../../../../src/main-process/scenario-engines/c3-gateway-recon-join');
const { BANK_STATEMENT_VIRTUAL_AMOUNT_ABS } = require('../../../../src/constants/bank-statement-fields');

// ========================================================================
// v2.1.8 N2 — C3「对账成立后赋值」新增"自取值"模式（assign-gw）
// spec.md §四 v0.7：mode='custom' + customValue 静态字符串作数据源
// ========================================================================

// 构造最小 c3 scenario
function makeScenario(assignOverrides) {
  return {
    id: 1,
    name: 'N2-test',
    config: {
      reconFields: [{ seq: 1, gwField: 'OrderId', bankField: 'OrderId' }],
      assign: Object.assign(
        { gwField: 'Reference', bankField: 'Narrative', mode: 'direct', customValue: '' },
        assignOverrides || {}
      )
    }
  };
}

test.describe('countC3BankCandidates — v2.1.12 需求6 数据侧预检只读 helper', () => {
  test('无银行 conditions → 兜底所有行皆候选（与引擎 bankRowsFiltered 兜底一致）', () => {
    assert.equal(countC3BankCandidates({ reconFields: [], assign: {} }, [{ OrderId: 'A' }, { OrderId: 'B' }]), 2);
  });

  test('有银行 condition「包含」→ 仅命中行计入', () => {
    const config = { conditions: [{ side: '银行', field: 'BizType', op: '包含', value: 'PAY' }] };
    const bankRows = [{ BizType: 'PAYMENT' }, { BizType: 'REFUND' }, { BizType: 'PAY-X' }];
    assert.equal(countC3BankCandidates(config, bankRows), 2);
  });

  test('银行 condition 全不命中 → 0', () => {
    const config = { conditions: [{ side: '银行', field: 'BizType', op: '包含', value: 'PAY' }] };
    assert.equal(countC3BankCandidates(config, [{ BizType: 'REFUND' }, { BizType: 'FEE' }]), 0);
  });

  test('仅网关侧 conditions → 不影响银行候选（无银行条件视为全候选）', () => {
    const config = { conditions: [{ side: '网关', field: 'Status', op: '等于', value: 'OK' }] };
    assert.equal(countC3BankCandidates(config, [{ OrderId: 'A' }, { OrderId: 'B' }]), 2);
  });

  test('空 bankRows / null config 兜底不崩', () => {
    assert.equal(countC3BankCandidates({ conditions: [] }, []), 0);
    assert.equal(countC3BankCandidates(null, [{ X: 1 }]), 1);
    assert.equal(countC3BankCandidates({}, null), 0);
  });
});

// v2.1.12 需求5：extra fee 匹配 DS1-9（spec-alpha-req5-extrafee §4.1 资金一致性 POC）
//   金额场景：reconFields = Amount(gw) vs 发生额绝对值(bank)；A1 = fee 仅作用「发生额绝对值」字段对
function makeC3FeeScenario(extraFee) {
  return {
    id: 5, name: 'req5-fee',
    config: {
      reconFields: [{ seq: 1, gwField: 'Amount', bankField: BANK_STATEMENT_VIRTUAL_AMOUNT_ABS }],
      assign: { gwField: 'Reference', bankField: 'Narrative', mode: 'direct', customValue: '' },
      ...(extraFee ? { extraFee } : {})
    }
  };
}
function feeBankRow(absAmount, narrative = '') {
  return { 'Credit Amount': absAmount, 'Debit Amount': 0, Narrative: narrative };
}
function feeGwRow(amount, ref = 'GW-REF') {
  return { Amount: amount, Reference: ref };
}
// v2.1.15 W2：assign 列(Narrative)的 modification 计数 —— 表达「赋值命中数」，
//   与新增的 'Extra Fee' modification 解耦，使既有「是否命中 / 1v1 消费」断言不被 Extra Fee 干扰。
function narrativeMods(result) {
  return result.modifications.filter((m) => m.column === 'Narrative').length;
}
// v2.1.15 W2：某行 'Extra Fee' modification（断言写入 + 标黄）；无则 undefined。
function extraFeeMod(result, rowId) {
  return result.modifications.find((m) => m.column === 'Extra Fee' && (rowId === undefined || m.rowId === rowId));
}

test.describe('需求5 extra fee 匹配 — DS1-9（spec-alpha-req5 §4.1 资金 POC）', () => {
  test('DS1 零回归：默认关(无 extraFee) + 金额场景 gw=bank=100 → 命中', () => {
    const banks = [feeBankRow(100)];
    const r = runC3Scenario(makeC3FeeScenario(null), banks, [feeGwRow(100)]);
    assert.equal(r.modifications.length, 1);
    assert.equal(banks[0].Narrative, 'GW-REF');
  });
  test('DS2 加 fee 命中：fee=5, gw=100, bank=105', () => {
    const banks = [feeBankRow(105)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    // v2.1.15 W2：fee 启用且命中 → 除 assign(Narrative) 外还写 Extra Fee，故 modifications=2；
    //   原"是否命中"语义改用 assign 列(Narrative)的 modification 计数表达（不被 Extra Fee 干扰）。
    assert.equal(narrativeMods(r), 1);
    assert.equal(banks[0].Narrative, 'GW-REF');
  });
  test('DS3 加 fee 不命中：fee=5, gw=100, bank=100（105≠100）', () => {
    const banks = [feeBankRow(100)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    assert.equal(r.modifications.length, 0);
    assert.equal(banks[0].Narrative, '');
  });
  test('DS4 fee=0 显式勾选：gw=bank=100 → 命中（等价默认关）', () => {
    // v2.1.15 W2：fee=0 仍是「有限数差额」→ Extra Fee 写入 '0'（assign 命中数仍为 1）
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0 }), [feeBankRow(100)], [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1);
  });
  test('DS5 负 fee：fee=-5, gw=100, bank=95', () => {
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: -5 }), [feeBankRow(95)], [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1);
  });
  test('DS6 小数 fee：fee=0.5, gw=100, bank=100.5', () => {
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.5 }), [feeBankRow(100.5)], [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1);
  });
  test('DS7 A1：多金额字段对时 fee 仅作用「发生额绝对值」对，另一 Fee 字段对需精确相等', () => {
    const s = {
      id: 7, name: 'ds7',
      config: {
        reconFields: [
          { seq: 1, gwField: 'Amount', bankField: BANK_STATEMENT_VIRTUAL_AMOUNT_ABS },
          { seq: 2, gwField: 'ServiceFee', bankField: 'ServiceFee' }
        ],
        assign: { gwField: 'Reference', bankField: 'Narrative', mode: 'direct' },
        extraFee: { enabled: true, amount: 5 }
      }
    };
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, ServiceFee: 2, Narrative: '' }];
    const r = runC3Scenario(s, banks, [{ Amount: 100, ServiceFee: 2, Reference: 'GW-REF' }]);
    // v2.1.15 W2：命中数用 assign 列(Narrative)表达，不被新增 Extra Fee 干扰
    assert.equal(narrativeMods(r), 1, 'Amount 对加 fee(=105) + ServiceFee 精确相等(2) → 命中');
    const banks2 = [{ 'Credit Amount': 105, 'Debit Amount': 0, ServiceFee: 7, Narrative: '' }];
    const r2 = runC3Scenario(s, banks2, [{ Amount: 100, ServiceFee: 2, Reference: 'X' }]);
    assert.equal(r2.modifications.length, 0, 'ServiceFee 未加 fee（2≠7）→ 不命中（证明 A1：fee 只作用发生额绝对值对；不命中时 Extra Fee 也不写）');
  });
  test('DS8 1v1 消费不变：2 bank 同额 + 1 gw(加 fee 命中) → 仅 1 条命中', () => {
    const banks = [feeBankRow(105), feeBankRow(105)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    // v2.1.15 W2：1v1 消费红线 → 仅 1 条 bank 赋值命中（Extra Fee 也只写该 1 行）
    assert.equal(narrativeMods(r), 1, '单 gw 严格 1v1 消费（资金红线不变）');
  });
  test('DS9 浮点边界：fee=0.1, gw=0.2, bank=0.3 → 归一到分命中', () => {
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.1 }), [feeBankRow(0.3)], [feeGwRow(0.2)]);
    assert.equal(narrativeMods(r), 1, 'Math.round 归一到分防 0.1+0.2!==0.3');
  });
});

// ========================================================================
// v2.1.15 W2 — C3 匹配成功后把差额写入银行行 'Extra Fee' 并标黄（🔴 资金红线）
// spec §4 W2：fee !== null（勾选且 amount 有限数）时，匹配成功除 assign 赋值外，
//   还把差额(fee)写入银行行 'Extra Fee'；原值已等于差额则只锁定不标黄。
//   assign 与 Extra Fee 写盘解耦：各自 old!==new 才 record（标黄），最后统一 lock + 消费 gw。
// ========================================================================
test.describe('runC3Scenario — W2 Extra Fee 写盘（v2.1.15 资金红线）', () => {
  // 用例 1：fee 启用 + 匹配成功 + Extra Fee 原值空 → 写入差额且进 modifications（会标黄）
  test('W2-1 fee 启用 + 命中 + Extra Fee 原值空 → 写入差额并标黄', () => {
    const banks = [feeBankRow(105)]; // feeBankRow 不含 'Extra Fee' 字段 → 原值空
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    // assign 命中
    assert.equal(narrativeMods(r), 1);
    assert.equal(banks[0].Narrative, 'GW-REF');
    // Extra Fee 写入差额 '5'（normalizeCellValue(5)），写回到 bankRow，且进 modifications（标黄）
    assert.equal(banks[0]['Extra Fee'], '5');
    const ef = extraFeeMod(r);
    assert.ok(ef, 'Extra Fee 应进 modifications（会标黄）');
    assert.equal(ef.oldValue, '');
    assert.equal(ef.newValue, '5');
    // 行 lock + gw 被消费（1v1 红线）
    assert.equal(r.lockedRowIds.size, 1);
  });

  // 用例 2：fee 启用 + 匹配成功 + Extra Fee 原值已等于差额 → 不进 modifications（不标黄），但行仍 lock + gw 被消费
  test('W2-2 fee 启用 + 命中 + Extra Fee 原值=差额 → 不 record 不标黄，但 lock + gw 消费', () => {
    // 银行行 Extra Fee 原值已是 '5'；assign 也让 Narrative 已等于 gw 值 → 两段都不 record，但仍命中锁定
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF', 'Extra Fee': '5' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    assert.equal(r.modifications.length, 0, 'assign 同值 + Extra Fee 同值 → 零 record（不标黄）');
    assert.equal(banks[0]['Extra Fee'], '5', '原值保持不变');
    assert.equal(r.lockedRowIds.size, 1, '仍 lock（first-match-wins 红线）');
    // gw 被消费验证：再放一条同额 bank，应找不到候选（gw 已用尽）
    const banks2 = [
      { 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF', 'Extra Fee': '5' },
      feeBankRow(105)
    ];
    const r2 = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks2, [feeGwRow(100)]);
    // 第 1 行同值（0 record）消费掉唯一 gw；第 2 行无候选 → 不命中、不写
    assert.equal(narrativeMods(r2), 0, '第 1 行同值不 record，第 2 行因 gw 已消费而不命中');
    assert.equal(banks2[1].Narrative, '', '第 2 行未被赋值（gw 已被第 1 行消费，1v1 红线）');
    assert.equal(banks2[1]['Extra Fee'], undefined, '第 2 行 Extra Fee 未被写入');
  });

  // 用例 3：fee 未启用 → Extra Fee 完全不动（与改动前 byte-for-byte 一致，回归保护）
  test('W2-3 fee 未启用 → Extra Fee 完全不动（byte-for-byte 回归保护）', () => {
    // (a) 无 extraFee 配置
    const banksA = [feeBankRow(100)];
    const rA = runC3Scenario(makeC3FeeScenario(null), banksA, [feeGwRow(100)]);
    assert.equal(rA.modifications.length, 1, '仅 assign(Narrative) record，无 Extra Fee');
    assert.ok(!extraFeeMod(rA), '无任何 Extra Fee modification');
    assert.equal(banksA[0]['Extra Fee'], undefined, 'Extra Fee 字段未被写入（原本就不存在）');
    // (b) enabled:false 显式关
    const banksB = [feeBankRow(100)];
    const rB = runC3Scenario(makeC3FeeScenario({ enabled: false, amount: 5 }), banksB, [feeGwRow(100)]);
    assert.equal(rB.modifications.length, 1);
    assert.ok(!extraFeeMod(rB));
    assert.equal(banksB[0]['Extra Fee'], undefined);
    // (c) enabled:true 但 amount 非有限数（fee=null）→ 同样不动
    const banksC = [feeBankRow(100)];
    const rC = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 'abc' }), banksC, [feeGwRow(100)]);
    assert.equal(rC.modifications.length, 1, 'amount 非数 → fee=null → 不写 Extra Fee（也不影响匹配，gw=bank=100 命中）');
    assert.ok(!extraFeeMod(rC));
    assert.equal(banksC[0]['Extra Fee'], undefined);
    // (d) 含原 Extra Fee 值时，fee 未启用必须保持原值不变（不动 = byte-for-byte）
    const banksD = [{ 'Credit Amount': 100, 'Debit Amount': 0, Narrative: '', 'Extra Fee': 'KEEP-ME' }];
    const rD = runC3Scenario(makeC3FeeScenario(null), banksD, [feeGwRow(100)]);
    assert.ok(!extraFeeMod(rD));
    assert.equal(banksD[0]['Extra Fee'], 'KEEP-ME', 'fee 未启用 → 原 Extra Fee 值原封不动');
  });

  // 用例 4：assign 的 oldValue===newValue（原本会 early-return）但 fee 启用且 Extra Fee 需写
  //   → assign 不 record、Extra Fee 正确 record，且行 lock / gw 消费正确（解耦核心场景）
  test('W2-4 assign 同值(原 early-return) + Extra Fee 需写 → assign 不 record / Extra Fee record / lock+gw 正确', () => {
    // bank 的 Narrative 已等于 gw Reference('GW-REF') → assign oldValue===newValue（旧逻辑此处 early-return 会跳过 Extra Fee）
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF' }]; // 无 Extra Fee 字段 → 原值空
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    // assign 不 record（同值）
    assert.equal(narrativeMods(r), 0, 'assign 同值 → 不 record（去掉 early-return 后不再跳过 Extra Fee）');
    // Extra Fee 正确 record
    const ef = extraFeeMod(r);
    assert.ok(ef, 'Extra Fee 应正确 record（解耦后不被 assign 同值跳过）');
    assert.equal(ef.oldValue, '');
    assert.equal(ef.newValue, '5');
    assert.equal(banks[0]['Extra Fee'], '5');
    // 总 modifications 只有 Extra Fee 这 1 条
    assert.equal(r.modifications.length, 1);
    // 行 lock + gw 消费正确（1v1 红线）：再加一条同额 bank 应无候选
    const banks2 = [
      { 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF' },
      feeBankRow(105)
    ];
    const r2 = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks2, [feeGwRow(100)]);
    assert.equal(r2.lockedRowIds.size, 1, '仅第 1 行 lock（gw 已被消费，第 2 行不命中）');
    assert.equal(banks2[1].Narrative, '', '第 2 行未被赋值（gw 被第 1 行消费）');
    assert.equal(banks2[1]['Extra Fee'], undefined, '第 2 行 Extra Fee 未被写');
  });

  // 补充：mode='custom' 分支兼容 —— Extra Fee 段不受 mode 影响，只看 fee
  test('W2-5 mode=custom + fee 启用 + 命中 → customValue 写 assign + Extra Fee 照常写', () => {
    const scenario = {
      id: 15, name: 'w2-custom',
      config: {
        reconFields: [{ seq: 1, gwField: 'Amount', bankField: BANK_STATEMENT_VIRTUAL_AMOUNT_ABS }],
        assign: { gwField: '__CUSTOM__', bankField: 'Narrative', mode: 'custom', customValue: 'CUSTOM-X' },
        extraFee: { enabled: true, amount: 5 }
      }
    };
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: '' }];
    const r = runC3Scenario(scenario, banks, [{ Amount: 100 }]); // gw 无 Reference 字段（custom 不需要）
    assert.equal(banks[0].Narrative, 'CUSTOM-X', 'custom 赋值正常');
    assert.equal(narrativeMods(r), 1);
    const ef = extraFeeMod(r);
    assert.ok(ef, 'custom 模式下 Extra Fee 段照常执行（只看 fee）');
    assert.equal(ef.newValue, '5');
    assert.equal(banks[0]['Extra Fee'], '5');
  });
});

test.describe('runC3Scenario — mode=direct 行为回归（v2.1.7 baseline）', () => {
  test('mode=direct：从 gw 字段取值写入 bank 字段', () => {
    const scenario = makeScenario({ mode: 'direct' });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: 'GW-REF-001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'GW-REF-001');
  });

  test('mode 字段缺失（老 scenario）→ 走 direct 路径（默认行为）', () => {
    const scenario = makeScenario({});
    delete scenario.config.assign.mode;
    delete scenario.config.assign.customValue;
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: 'GW-REF-001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'GW-REF-001');
  });

  test('mode=direct：gw 字段空 → candidates 过滤掉 → 无修改', () => {
    const scenario = makeScenario({ mode: 'direct' });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: '' }]; // gw Reference 空
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.equal(bankRows[0].Narrative, '');
  });
});

test.describe('runC3Scenario — mode=custom（v2.1.8 N2 新增）', () => {
  test('mode=custom + customValue 非空 → newValue=customValue 写入 bank', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'CUSTOM-VAL-123'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }]; // gw 没 Reference 字段
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'CUSTOM-VAL-123');
  });

  test('mode=custom：跳过 gw 字段非空过滤（gw 行不需要 Reference 字段）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    // gw 行根本没有 Reference 字段（mode=direct 时会被过滤掉，mode=custom 时仍可命中）
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1, 'mode=custom 应忽略 gw 字段是否非空');
    assert.equal(bankRows[0].Narrative, 'STATIC');
  });

  test('mode=custom + customValue 空 → warning + skip（防御性 bundle/手改 DB 兼容）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: ''
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.equal(bankRows[0].Narrative, '');
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('mode=custom + customValue 仅空白字符 → 同 customValue 空（trim 后空）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: '   '
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('mode=custom + reconFields 不匹配 → 无修改（与 mode=direct 一致）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O002' }]; // OrderId 不匹配
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
  });

  test('mode=custom + 多 bank 行 + 单 gw 行 → 严格 1v1 红线（usedGwRowIdx 消费）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [
      { OrderId: 'O001', Narrative: '' },
      { OrderId: 'O001', Narrative: '' }
    ];
    const gwRows = [{ OrderId: 'O001' }]; // 只 1 个 gw 行
    const r = runC3Scenario(scenario, bankRows, gwRows);
    // 第 1 个 bank 命中并消费 gw → 第 2 个 bank 找不到候选
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'STATIC');
    assert.equal(bankRows[1].Narrative, '');
  });

  test('mode=custom + oldValue === newValue → lock 但不 record（沿用 round 9 F2 fix 行为）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'SAME'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: 'SAME' }]; // bank 已是 SAME
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0, '相等不 record');
    // lockedRowIds 是 Set，用 .size（dispatcher 也是 Set）
    assert.equal(r.lockedRowIds.size, 1, '但仍 lock（first-match-wins 红线）');
  });
});

test.describe('runC3Scenario — mode=custom + customValue 类型边界', () => {
  test('customValue 是 null → 视为空 → skip', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: null
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('customValue 是数字 → String() 转换写入', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 12345
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(bankRows[0].Narrative, '12345');
  });
});

// ========================================================================
// v2.1.15 W2 补强（team-lead 审查补充）：Extra Fee 写入【值】的资金正确性
//   现有 W2-1~5 / DS1-9 覆盖「是否写 / 是否标黄 / 解耦 / 1v1 消费 / 匹配命中」；
//   但差额值几乎都用 fee=5。本块集中验证不同差额（0 / 负 / 小数 / 浮点 / 覆盖非空原值）的
//   写入值正确——金额值写错是资金红线最该防的。normalizeCellValue 实测：0→'0' / -5→'-5' / 0.5→'0.5'（非空、不漂移）。
// ========================================================================
test.describe('runC3Scenario — W2 Extra Fee 写入值资金正确性（v2.1.15 资金红线补强）', () => {
  test('W2-V1 fee=0：差额 0 → Extra Fee 写 "0"（非空、不跳过，财务可见 0 成本）', () => {
    const banks = [feeBankRow(100)]; // gw100 + 0 = bank100 命中
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1, 'gw=bank=100 命中');
    assert.equal(banks[0]['Extra Fee'], '0', 'fee=0 写入字符串 "0"（normalizeCellValue(0)="0"，非空、不跳过）');
    const ef = extraFeeMod(r);
    assert.ok(ef && ef.oldValue === '' && ef.newValue === '0', 'Extra Fee modification "" → "0"（会标黄）');
  });

  test('W2-V2 负 fee=-5：gw100 + (-5) = bank95 → Extra Fee 写 "-5"', () => {
    const banks = [feeBankRow(95)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: -5 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1, 'gw100 + (-5) = 95 命中');
    assert.equal(banks[0]['Extra Fee'], '-5', '负差额原样写入');
    assert.equal(extraFeeMod(r).newValue, '-5');
  });

  test('W2-V3 小数 fee=0.5：gw100 + 0.5 = bank100.5 → Extra Fee 写 "0.5"', () => {
    const banks = [feeBankRow(100.5)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.5 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1);
    assert.equal(banks[0]['Extra Fee'], '0.5', '小数差额原样写入');
  });

  test('W2-V4 浮点边界 fee=0.1（gw0.2+0.1=bank0.3 归一到分命中）→ Extra Fee 写配置原值 "0.1"（非浮点漂移）', () => {
    const banks = [feeBankRow(0.3)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.1 }), banks, [feeGwRow(0.2)]);
    assert.equal(narrativeMods(r), 1, '0.2+0.1=0.3 归一到分命中');
    assert.equal(banks[0]['Extra Fee'], '0.1', '写入的是配置差额 0.1 本身，不是 0.1 的浮点运算残值');
  });

  test('W2-V5 覆盖既有非空 Extra Fee：原值 "9" ≠ 差额 "5" → 覆盖为 "5" 并标黄（oldValue 记原值）', () => {
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: '', 'Extra Fee': '9' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    const ef = extraFeeMod(r);
    assert.ok(ef, '原值≠差额 → record（标黄）');
    assert.equal(ef.oldValue, '9', 'oldValue 记录被覆盖的原值（审计可追溯）');
    assert.equal(ef.newValue, '5');
    assert.equal(banks[0]['Extra Fee'], '5', '覆盖为新差额');
  });
});
