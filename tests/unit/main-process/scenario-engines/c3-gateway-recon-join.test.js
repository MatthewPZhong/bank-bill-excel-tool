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
//   还把差额(fee)写入银行行 'Extra Fee'；原值已等于写盘值则只锁定不标黄。
//   assign 与 Extra Fee 写盘解耦：各自 old!==new 才 record（标黄），最后统一 lock + 消费 gw。
// v3.0.4 F1 🔴（spec bank-recon-output-fixes §4 F1）：写盘取输入框值的【相反数】
//   （normalizeCellValue(-fee)）。匹配语义不变，仅写盘值取反 → 故下列 Extra Fee 写盘断言
//   期望 = 输入框值的相反数：fee=5 → '-5'；fee=-5 → '5'；fee=0 → '0'（不出 '-0'）；fee=0.5 → '-0.5'。
// ========================================================================
test.describe('runC3Scenario — W2 Extra Fee 写盘（v2.1.15 资金红线 / v3.0.4 F1 取反）', () => {
  // 用例 1：fee 启用 + 匹配成功 + Extra Fee 原值空 → 写入差额相反数且进 modifications（会标黄）
  test('W2-1 fee 启用 + 命中 + Extra Fee 原值空 → 写入差额相反数并标黄', () => {
    const banks = [feeBankRow(105)]; // feeBankRow 不含 'Extra Fee' 字段 → 原值空
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    // assign 命中
    assert.equal(narrativeMods(r), 1);
    assert.equal(banks[0].Narrative, 'GW-REF');
    // v3.0.4 F1：Extra Fee 写入差额相反数 '-5'（normalizeCellValue(-5)），写回 bankRow，且进 modifications（标黄）
    assert.equal(banks[0]['Extra Fee'], '-5');
    const ef = extraFeeMod(r);
    assert.ok(ef, 'Extra Fee 应进 modifications（会标黄）');
    assert.equal(ef.oldValue, '');
    assert.equal(ef.newValue, '-5');
    // 行 lock + gw 被消费（1v1 红线）
    assert.equal(r.lockedRowIds.size, 1);
  });

  // 用例 2：fee 启用 + 匹配成功 + Extra Fee 原值已等于写盘值（取反后） → 不进 modifications（不标黄），但行仍 lock + gw 被消费
  test('W2-2 fee 启用 + 命中 + Extra Fee 原值=写盘相反数 → 不 record 不标黄，但 lock + gw 消费', () => {
    // v3.0.4 F1：fee=5 写盘值为 '-5'；银行行 Extra Fee 原值已是 '-5'（同值平移）；assign 也让 Narrative 已等于 gw 值
    //   → 两段都不 record，但仍命中锁定
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF', 'Extra Fee': '-5' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    assert.equal(r.modifications.length, 0, 'assign 同值 + Extra Fee 同值 → 零 record（不标黄）');
    assert.equal(banks[0]['Extra Fee'], '-5', '原值保持不变');
    assert.equal(r.lockedRowIds.size, 1, '仍 lock（first-match-wins 红线）');
    // gw 被消费验证：再放一条同额 bank，应找不到候选（gw 已用尽）
    const banks2 = [
      { 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF', 'Extra Fee': '-5' },
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
    // Extra Fee 正确 record（v3.0.4 F1：fee=5 写盘相反数 '-5'）
    const ef = extraFeeMod(r);
    assert.ok(ef, 'Extra Fee 应正确 record（解耦后不被 assign 同值跳过）');
    assert.equal(ef.oldValue, '');
    assert.equal(ef.newValue, '-5');
    assert.equal(banks[0]['Extra Fee'], '-5');
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
    assert.equal(ef.newValue, '-5', 'v3.0.4 F1：fee=5 写盘相反数 -5（与 mode 无关，只看 fee）');
    assert.equal(banks[0]['Extra Fee'], '-5');
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

test.describe('runC3Scenario — v3.0.13 多候选优先同值赋值候选', () => {
  function makeReconIdScenario(overrides = {}) {
    return {
      id: 301,
      name: 'C3-多候选同值优先',
      config: {
        reconFields: [
          { seq: 1, gwField: 'currency', bankField: 'Currency' },
          { seq: 2, gwField: 'amount', bankField: BANK_STATEMENT_VIRTUAL_AMOUNT_ABS }
        ],
        assign: { gwField: 'reconciliationid', bankField: 'ReconciliationId', mode: 'direct' },
        ...overrides
      }
    };
  }

  function bankReconRow(rowId, oldReconId, amount = 100) {
    return {
      _rowId: rowId,
      Currency: 'USD',
      'Credit Amount': 0,
      'Debit Amount': amount,
      ReconciliationId: oldReconId
    };
  }

  function gwReconRow(reconId, amount = 100) {
    return { currency: 'USD', amount, reconciliationid: reconId };
  }

  test('同值候选在后时仍优先选择同值候选：不覆盖已有 ReconciliationId，仍 warning + lock', () => {
    const bankRows = [bankReconRow('b1', 'RC-SAME')];
    const gwRows = [gwReconRow('RC-OTHER'), gwReconRow('RC-SAME')];

    const result = runC3Scenario(makeReconIdScenario(), bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-SAME');
    assert.equal(result.modifications.length, 0, '同值候选不产生 ReconciliationId modification');
    assert.ok(result.lockedRowIds.has('b1'), '匹配成功仍 lock');
    assert.ok(result.warnings.some((w) => w.code === 'multi-gateway-match'), '多候选 warning 仍保留');
  });

  test('同值候选在前时行为不变：消费第一条候选且不改值', () => {
    const bankRows = [bankReconRow('b1', 'RC-SAME'), bankReconRow('b2', '')];
    const gwRows = [gwReconRow('RC-SAME'), gwReconRow('RC-OTHER')];

    const result = runC3Scenario(makeReconIdScenario(), bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-SAME');
    assert.equal(bankRows[1].ReconciliationId, 'RC-OTHER', '第一行消费 gwSame 后，第二行只能消费剩余 gwOther');
    assert.deepEqual(result.modifications.map((m) => m.rowId), ['b2']);
  });

  test('没有同值候选时沿用第一条候选并产生 modification', () => {
    const bankRows = [bankReconRow('b1', 'RC-OLD')];
    const gwRows = [gwReconRow('RC-1'), gwReconRow('RC-2')];

    const result = runC3Scenario(makeReconIdScenario(), bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-1');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].oldValue, 'RC-OLD');
    assert.equal(result.modifications[0].newValue, 'RC-1');
  });

  test('银行旧值为空时沿用第一条候选', () => {
    const bankRows = [bankReconRow('b1', '')];
    const gwRows = [gwReconRow('RC-1'), gwReconRow('RC-2')];

    const result = runC3Scenario(makeReconIdScenario(), bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-1');
    assert.equal(result.modifications[0].newValue, 'RC-1');
  });

  test('custom mode 不走同值候选优先，仍写入 customValue', () => {
    const scenario = makeReconIdScenario({
      assign: { gwField: '__CUSTOM__', bankField: 'ReconciliationId', mode: 'custom', customValue: 'CUSTOM-RC' }
    });
    const bankRows = [bankReconRow('b1', 'RC-SAME')];
    const gwRows = [gwReconRow('RC-OTHER'), gwReconRow('RC-SAME')];

    const result = runC3Scenario(scenario, bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'CUSTOM-RC');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].newValue, 'CUSTOM-RC');
  });

  test('Extra Fee 回归：同值候选在后，assign 不改值，Extra Fee 仍写入相反数并 lock', () => {
    const scenario = makeReconIdScenario({ extraFee: { enabled: true, amount: 5 } });
    const bankRows = [bankReconRow('b1', 'RC-SAME', 105)];
    const gwRows = [gwReconRow('RC-OTHER', 100), gwReconRow('RC-SAME', 100)];

    const result = runC3Scenario(scenario, bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-SAME');
    assert.equal(bankRows[0]['Extra Fee'], '-5');
    assert.equal(result.modifications.length, 1, '仅 Extra Fee 产生 modification');
    assert.equal(result.modifications[0].column, 'Extra Fee');
    assert.ok(result.lockedRowIds.has('b1'));
  });

  test('1v1 消费回归：第一条银行行因同值优先消费 gwSame，第二条只能消费剩余 gwOther', () => {
    const bankRows = [
      bankReconRow('b1', 'RC-SAME'),
      bankReconRow('b2', '')
    ];
    const gwRows = [gwReconRow('RC-OTHER'), gwReconRow('RC-SAME')];

    const result = runC3Scenario(makeReconIdScenario(), bankRows, gwRows);

    assert.equal(bankRows[0].ReconciliationId, 'RC-SAME', 'b1 消费后置同值候选');
    assert.equal(bankRows[1].ReconciliationId, 'RC-OTHER', 'b2 只能消费剩余第一条候选');
    assert.equal(result.modifications.length, 1);
    assert.equal(result.modifications[0].rowId, 'b2');
    assert.equal(result.modifications[0].newValue, 'RC-OTHER');
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
//   但差额值几乎都用 fee=5。本块集中验证不同差额（0 / 负 / 小数 / 浮点 / 覆盖非空原值）的写入值正确。
// v3.0.4 F1 🔴（spec bank-recon-output-fixes §4 F1）：写盘取输入框值的【相反数】（normalizeCellValue(-fee)）。
//   匹配语义不变（gwMatchesBank 仍用原值 fee），仅写盘值取反。本块逐条锁定取反后的写盘值：
//   fee=0 → '0'（-0 边界：String(-0)==='0'，不出 '-0'）；fee=-5 → '5'（负输入对称取反核心）；
//   fee=0.5 → '-0.5'；fee=0.1 → '-0.1'（写配置原值取反，非浮点漂移）；fee=5 覆盖原值 → '-5'。
// ========================================================================
test.describe('runC3Scenario — W2 Extra Fee 写入值资金正确性（v2.1.15 补强 / v3.0.4 F1 取反）', () => {
  test('W2-V1 fee=0：写盘相反数 -0 → Extra Fee 写 "0"（-0 边界 String(-0)==="0"，绝不出 "-0"）', () => {
    const banks = [feeBankRow(100)]; // gw100 + 0 = bank100 命中
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1, 'gw=bank=100 命中');
    // v3.0.4 F1 -0 显式锁定：normalizeCellValue(-0) 走 String(-0)==='0' → 写 '0'，不出现 '-0'
    assert.equal(banks[0]['Extra Fee'], '0', 'fee=0 取反为 -0，但写入字符串 "0"（绝不出现 "-0"）');
    const ef = extraFeeMod(r);
    assert.ok(ef && ef.oldValue === '' && ef.newValue === '0', 'Extra Fee modification "" → "0"（会标黄）');
  });

  test('W2-V2 负 fee=-5（负输入对称取反核心）：gw100 + (-5) = bank95 命中 → Extra Fee 写 "5"', () => {
    const banks = [feeBankRow(95)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: -5 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1, 'gw100 + (-5) = 95 命中（匹配用原值 -5，语义不变）');
    // v3.0.4 F1：负输入对称取反 —— 输入 -5 → -(-5)=5 → 写 '5'
    assert.equal(banks[0]['Extra Fee'], '5', '负输入对称取反：输入 -5 写盘 5');
    assert.equal(extraFeeMod(r).newValue, '5');
  });

  test('W2-V3 小数 fee=0.5：gw100 + 0.5 = bank100.5 命中 → Extra Fee 写 "-0.5"', () => {
    const banks = [feeBankRow(100.5)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.5 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1);
    // v3.0.4 F1：小数差额取反写入
    assert.equal(banks[0]['Extra Fee'], '-0.5', '小数差额取反写入：输入 0.5 写盘 -0.5');
  });

  test('W2-V4 浮点边界 fee=0.1（gw0.2+0.1=bank0.3 归一到分命中）→ Extra Fee 写配置原值取反 "-0.1"（非浮点漂移）', () => {
    const banks = [feeBankRow(0.3)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 0.1 }), banks, [feeGwRow(0.2)]);
    assert.equal(narrativeMods(r), 1, '0.2+0.1=0.3 归一到分命中');
    // v3.0.4 F1：写入的是配置差额 0.1 取反（-0.1）本身，不是浮点运算残值
    assert.equal(banks[0]['Extra Fee'], '-0.1', '写入配置差额取反 -0.1 本身，非 0.1 的浮点运算残值');
  });

  test('W2-V5 覆盖既有非空 Extra Fee：原值 "9" ≠ 写盘相反数 "-5" → 覆盖为 "-5" 并标黄（oldValue 记原值）', () => {
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: '', 'Extra Fee': '9' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    const ef = extraFeeMod(r);
    assert.ok(ef, '原值≠写盘相反数 → record（标黄）');
    assert.equal(ef.oldValue, '9', 'oldValue 记录被覆盖的原值（审计可追溯）');
    assert.equal(ef.newValue, '-5');
    assert.equal(banks[0]['Extra Fee'], '-5', '覆盖为新差额取反值');
  });
});

// ========================================================================
// v3.0.4 F1 迁移边界（spec bank-recon-output-fixes §4 F1 / §9.1）：
//   写盘取反落地后，「存量已配 extraFee 场景」同一输入产出符号相反的迁移行为锁定。
//   包含 spec §9.1 矩阵的 fee=-3→'3' 精确点 + 2 条迁移边界用例（存量正值被覆盖取反 / 取反终态仅 lock 不 record）。
// ========================================================================
test.describe('runC3Scenario — F1 取反迁移边界（v3.0.4 资金红线）', () => {
  test('F1-M0 fee=-3（spec §9.1 精确矩阵点）：负输入对称取反 → Extra Fee 写 "3"', () => {
    // gw100 + (-3) = bank97 命中（匹配用原值 -3）；写盘取反 -(-3)=3 → '3'
    const banks = [feeBankRow(97)];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: -3 }), banks, [feeGwRow(100)]);
    assert.equal(narrativeMods(r), 1, 'gw100 + (-3) = 97 命中（匹配语义不变）');
    assert.equal(banks[0]['Extra Fee'], '3', '负输入 -3 对称取反写盘 3');
    assert.equal(extraFeeMod(r).newValue, '3');
  });

  test('F1-M1 存量旧正值被覆盖取反：原 Extra Fee="5"（旧版正符号存量）+ fee=5 → 新写 "-5" 标黄', () => {
    // 旧版（≤v3.0.3）写盘不取反，存量 Extra Fee 为正值 '5'；升级后 fee=5 写盘相反数 '-5' ≠ 旧 '5'
    //   → record 标黄，证明存量同输入产出符号相反（迁移翻符号，资金红线声明项）。
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: '', 'Extra Fee': '5' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    const ef = extraFeeMod(r);
    assert.ok(ef, '旧正值 "5" ≠ 新取反值 "-5" → record（标黄）');
    assert.equal(ef.oldValue, '5', 'oldValue 记录被覆盖的旧正值（审计可追溯迁移翻符号）');
    assert.equal(ef.newValue, '-5');
    assert.equal(banks[0]['Extra Fee'], '-5', '存量正值被覆盖为取反终态');
  });

  test('F1-M2 取反终态原值幂等：原 Extra Fee="-5"（已是取反终态）+ fee=5 → newFee="-5" 同值仅 lock 不 record', () => {
    // 已迁移过的行（Extra Fee 已是 '-5'）再次运行：newFee=normalizeCellValue(-5)='-5' === old → 不 record（不标黄），仅 lock
    const banks = [{ 'Credit Amount': 105, 'Debit Amount': 0, Narrative: 'GW-REF', 'Extra Fee': '-5' }];
    const r = runC3Scenario(makeC3FeeScenario({ enabled: true, amount: 5 }), banks, [feeGwRow(100)]);
    assert.ok(!extraFeeMod(r), '取反终态原值=写盘值 → 不 record（不重复标黄，幂等）');
    assert.equal(banks[0]['Extra Fee'], '-5', '原取反终态值保持不变');
    assert.equal(r.lockedRowIds.size, 1, '仍 lock（first-match-wins 红线，匹配成功必锁定）');
  });
});
