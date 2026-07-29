'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound4FundNatureCheck,
  evaluateR4Candidate,
  R4_RULES_BY_SUBCATEGORY
} = require('../../../../src/main-process/scenario-engines/r4-fund-nature-check');

function scenario(subCategory, overrides = {}) {
  return {
    id: overrides.id || `scene-${subCategory}`,
    name: overrides.name || subCategory,
    priority: overrides.priority ?? 0,
    enabled: true,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory,
      ...overrides.config
    }
  };
}

function gateway(overrides = {}) {
  return {
    reconciliationid: overrides.reconciliationid ?? 'R-001',
    TradeType: overrides.TradeType ?? 'AchReturn',
    merchantid: overrides.merchantid ?? 'M001',
    currency: overrides.currency ?? 'USD',
    amount: overrides.amount ?? '100'
  };
}

function bank(overrides = {}) {
  return {
    _rowId: overrides._rowId ?? 'bank-1',
    ReconciliationId: overrides.ReconciliationId ?? 'R-001',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'USD',
    FundType: overrides.FundType ?? 'Charge',
    'Debit Amount': overrides['Debit Amount'] ?? '100',
    'Credit Amount': overrides['Credit Amount'] ?? '0',
    'Extra Fee': overrides['Extra Fee'] ?? ''
  };
}

function warningCodes(result) {
  return result.warnings.map((warning) => warning.code);
}

test.describe('R4 v3.0.23 — 固定四类规则', () => {
  const cases = [
    ['ach-return', 'AchReturn', 'Debit Amount', 'Credit Amount', 'Ach Return'],
    ['wire-return', 'WireReturn', 'Credit Amount', 'Debit Amount', 'Wire Return'],
    ['hx-out', 'HX_OUTBOUND', 'Debit Amount', 'Credit Amount', 'HX-out'],
    ['hx-in', 'HX_INBOUND', 'Credit Amount', 'Debit Amount', 'HX-in']
  ];

  test('规则表冻结且字段与业务枚举一致', () => {
    assert.ok(Object.isFrozen(R4_RULES_BY_SUBCATEGORY));
    for (const [subCategory, tradeType, amountField, oppositeAmountField, targetFundType] of cases) {
      assert.deepEqual(R4_RULES_BY_SUBCATEGORY[subCategory], {
        subCategory,
        tradeType,
        targetFundType,
        amountField,
        oppositeAmountField
      });
      assert.ok(Object.isFrozen(R4_RULES_BY_SUBCATEGORY[subCategory]));
    }
  });

  for (const [subCategory, tradeType, amountField, oppositeAmountField, targetFundType] of cases) {
    test(`${subCategory}：完整条件命中后写 ${targetFundType}`, () => {
      const bankRow = bank({
        _rowId: subCategory,
        [amountField]: '100',
        [oppositeAmountField]: '0'
      });
      const result = runRound4FundNatureCheck(
        [gateway({ TradeType: tradeType })],
        [bankRow],
        [scenario(subCategory)]
      );

      assert.equal(bankRow.FundType, targetFundType);
      assert.deepEqual(result.modifications, [{
        rowId: subCategory,
        column: 'FundType',
        oldValue: 'Charge',
        newValue: targetFundType
      }]);
      assert.equal(result.matchedPairs.length, 1);
      assert.equal(result.matchedPairs[0].bankRow, bankRow, 'matchedPairs 保留实际银行对象');
      assert.equal(result.matchedPairs[0].subCategory, subCategory);
      assert.equal(result.matchedPairs[0].targetFundType, targetFundType);
      assert.equal(result.matchedPairs[0].changed, true);
      assert.deepEqual(result.warnings, []);
    });
  }

  test('核心口径由 subCategory 固定，不读取漂移的 gwTradeType/setFundType/方向配置', () => {
    const bankRow = bank();
    const drifted = scenario('ach-return', {
      config: {
        gwTradeType: 'WRONG',
        setFundType: 'WRONG',
        requireBankZeroField: 'Debit Amount',
        requireBankFundType: 'Impossible'
      }
    });
    const result = runRound4FundNatureCheck([gateway()], [bankRow], [drifted]);
    assert.equal(bankRow.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 1);
  });

  test('未启用对应 subCategory 或 TradeType 大小写不同均不处理', () => {
    const disabledType = bank({ _rowId: 'disabled' });
    const wrongCase = bank({ _rowId: 'wrong-case' });
    const disabledResult = runRound4FundNatureCheck(
      [gateway({ TradeType: 'AchReturn' })],
      [disabledType],
      [scenario('wire-return')]
    );
    const caseResult = runRound4FundNatureCheck(
      [gateway({ TradeType: 'achreturn' })],
      [wrongCase],
      [scenario('ach-return')]
    );
    assert.equal(disabledType.FundType, 'Charge');
    assert.equal(wrongCase.FundType, 'Charge');
    assert.deepEqual(disabledResult.warnings, []);
    assert.deepEqual(caseResult.warnings, []);
  });
});

test.describe('R4 v3.0.23 — 文本主键与金额', () => {
  test('ReconID、MerchantId、Currency 首尾空格 trim 后精确匹配', () => {
    const bankRow = bank({
      ReconciliationId: ' R-001 ',
      MerchantId: ' M001 ',
      Currency: ' USD '
    });
    const result = runRound4FundNatureCheck(
      [gateway({ reconciliationid: '  R-001', merchantid: 'M001  ', currency: ' USD' })],
      [bankRow],
      [scenario('ach-return')]
    );
    assert.equal(bankRow.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 1);
  });

  for (const [label, bankPatch, gwPatch] of [
    ['账号大小写不同', { MerchantId: 'm001' }, {}],
    ['币种大小写不同', { Currency: 'usd' }, {}],
    ['账号为空', { MerchantId: '' }, {}],
    ['币种为空', { Currency: '' }, {}],
    ['网关账号为空', {}, { merchantid: '' }],
    ['网关币种为空', {}, { currency: '' }]
  ]) {
    test(`${label}：同 ReconID 但不完整，保持原值并告警`, () => {
      const bankRow = bank(bankPatch);
      const result = runRound4FundNatureCheck(
        [gateway(gwPatch)],
        [bankRow],
        [scenario('ach-return')]
      );
      assert.equal(bankRow.FundType, 'Charge');
      assert.ok(warningCodes(result).includes('r4-fund-match-mismatch'));
    });
  }

  test('主金额取绝对值；正/负 Extra Fee 按原符号相加', () => {
    const positiveFeeBank = bank({ _rowId: 'positive-fee', 'Debit Amount': '-95', 'Extra Fee': '5' });
    const negativeFeeBank = bank({ _rowId: 'negative-fee', 'Debit Amount': '105', 'Extra Fee': '-5' });

    const positive = runRound4FundNatureCheck(
      [gateway({ reconciliationid: 'P', amount: '100' })],
      [{ ...positiveFeeBank, ReconciliationId: 'P' }],
      [scenario('ach-return')]
    );
    const negative = runRound4FundNatureCheck(
      [gateway({ reconciliationid: 'N', amount: '100' })],
      [{ ...negativeFeeBank, ReconciliationId: 'N' }],
      [scenario('ach-return')]
    );

    assert.equal(positive.modifications.length, 1);
    assert.equal(negative.modifications.length, 1);
  });

  test('空 Extra Fee 按0；千分位、科学计数法和超分位规范值精确相等', () => {
    const rows = [
      bank({ _rowId: 'blank-fee', ReconciliationId: 'A', 'Debit Amount': '1,000.00', 'Extra Fee': '' }),
      bank({ _rowId: 'scientific', ReconciliationId: 'B', 'Debit Amount': '1e3', 'Extra Fee': '0e9' }),
      bank({ _rowId: 'precision', ReconciliationId: 'C', 'Debit Amount': '0.1234567890123456789' })
    ];
    const result = runRound4FundNatureCheck(
      [
        gateway({ reconciliationid: 'A', amount: '1000' }),
        gateway({ reconciliationid: 'B', amount: '1000.0' }),
        gateway({ reconciliationid: 'C', amount: '0.1234567890123456789' })
      ],
      rows,
      [scenario('ach-return')]
    );
    assert.equal(result.modifications.length, 3);
    assert.deepEqual(result.warnings, []);
  });

  for (const [label, bankPatch, gwPatch] of [
    ['主金额为空', { 'Debit Amount': '' }, {}],
    ['主金额非法', { 'Debit Amount': 'not-money' }, {}],
    ['主金额为0且手续费补足', { 'Debit Amount': '0', 'Extra Fee': '100' }, {}],
    ['手续费非法', { 'Extra Fee': 'bad-fee' }, {}],
    ['网关金额为空', {}, { amount: '' }],
    ['网关金额非法', {}, { amount: 'bad-amount' }],
    ['高精度末位不同', { 'Debit Amount': '100.000000000000000001' }, { amount: '100.000000000000000002' }]
  ]) {
    test(`${label}：不匹配、不改写、有 mismatch`, () => {
      const bankRow = bank(bankPatch);
      const result = runRound4FundNatureCheck(
        [gateway(gwPatch)],
        [bankRow],
        [scenario('ach-return')]
      );
      assert.equal(bankRow.FundType, 'Charge');
      assert.equal(result.modifications.length, 0);
      assert.ok(warningCodes(result).includes('r4-fund-match-mismatch'));
    });
  }
});

test.describe('R4 v3.0.23 — 借贷方向', () => {
  for (const value of ['', '0', '0.00', '0e9']) {
    test(`相反方向金额「${value || '空'}」按0放行`, () => {
      const bankRow = bank({ 'Credit Amount': value });
      const result = runRound4FundNatureCheck([gateway()], [bankRow], [scenario('ach-return')]);
      assert.equal(bankRow.FundType, 'Ach Return');
      assert.deepEqual(result.warnings, []);
    });
  }

  for (const value of ['1', '-0.01', 'invalid']) {
    test(`相反方向金额「${value}」阻断并输出方向告警`, () => {
      const bankRow = bank({ 'Credit Amount': value });
      const result = runRound4FundNatureCheck([gateway()], [bankRow], [scenario('ach-return')]);
      assert.equal(bankRow.FundType, 'Charge');
      assert.equal(result.modifications.length, 0);
      assert.deepEqual(warningCodes(result).sort(), [
        'r4-fund-direction-mismatch',
        'r4-fund-match-mismatch'
      ]);
      assert.equal(result.warnings.filter((w) => w.code === 'r4-fund-direction-mismatch').length, 1);
    });
  }
});

test.describe('R4 v3.0.23 — 严格1:1消费与顺序', () => {
  test('同 ReconID 只有一条完整候选：只改该行，不扩散', () => {
    const wrongAccount = bank({ _rowId: 'wrong', MerchantId: 'OTHER' });
    const complete = bank({ _rowId: 'complete' });
    const wrongCurrency = bank({ _rowId: 'wrong-currency', Currency: 'EUR' });
    const result = runRound4FundNatureCheck(
      [gateway()],
      [wrongAccount, complete, wrongCurrency],
      [scenario('ach-return')]
    );
    assert.equal(wrongAccount.FundType, 'Charge');
    assert.equal(complete.FundType, 'Ach Return');
    assert.equal(wrongCurrency.FundType, 'Charge');
    assert.deepEqual(result.modifications.map((m) => m.rowId), ['complete']);
  });

  test('v3.1.1 同 ReconID 的 AchReturn/WireReturn 只形成 Debit/Credit 两个具体 opposite-direction pair', () => {
    const debitBank = bank({
      _rowId: 'debit-bank',
      ReconciliationId: 'RID001',
      'Debit Amount': '100',
      'Credit Amount': '0'
    });
    const creditBank = bank({
      _rowId: 'credit-bank',
      ReconciliationId: 'RID001',
      'Debit Amount': '0',
      'Credit Amount': '100'
    });
    const achGateway = gateway({ reconciliationid: 'RID001', TradeType: 'AchReturn' });
    const wireGateway = gateway({ reconciliationid: 'RID001', TradeType: 'WireReturn' });

    const result = runRound4FundNatureCheck(
      [achGateway, wireGateway],
      [debitBank, creditBank],
      [scenario('ach-return'), scenario('wire-return')]
    );

    assert.equal(debitBank.FundType, 'Ach Return');
    assert.equal(creditBank.FundType, 'Wire Return');
    assert.equal(result.matchedPairs.length, 2);
    assert.equal(result.matchedPairs[0].gwRow, achGateway);
    assert.equal(result.matchedPairs[0].bankRow, debitBank);
    assert.equal(result.matchedPairs[0].subCategory, 'ach-return');
    assert.equal(result.matchedPairs[1].gwRow, wireGateway);
    assert.equal(result.matchedPairs[1].bankRow, creditBank);
    assert.equal(result.matchedPairs[1].subCategory, 'wire-return');
    assert.deepEqual(result.warnings, []);
  });

  test('多个完整银行候选：取银行原序第一条并告警', () => {
    const first = bank({ _rowId: 'first' });
    const second = bank({ _rowId: 'second' });
    const result = runRound4FundNatureCheck(
      [gateway()],
      [first, second],
      [scenario('ach-return')]
    );
    assert.equal(first.FundType, 'Ach Return');
    assert.equal(second.FundType, 'Charge');
    assert.deepEqual(warningCodes(result), ['r4-fund-multi-candidate']);
    assert.match(result.warnings[0].message, /2 条/);
  });

  test('两个网关争用同一银行行：网关原序优先，跨场景不可复用', () => {
    const bankRow = bank();
    const result = runRound4FundNatureCheck(
      [
        gateway({ TradeType: 'HX_OUTBOUND' }),
        gateway({ TradeType: 'AchReturn' })
      ],
      [bankRow],
      [scenario('ach-return'), scenario('hx-out')]
    );
    assert.equal(bankRow.FundType, 'HX-out', '原序第一条 HX_OUTBOUND 获得银行行');
    assert.equal(result.modifications.length, 1);
    assert.ok(warningCodes(result).includes('r4-fund-match-mismatch'), '后续 AchReturn 不得复用');
  });

  test('两个相同网关、两条完整银行行：按原序分别消费', () => {
    const first = bank({ _rowId: 'first' });
    const second = bank({ _rowId: 'second' });
    const result = runRound4FundNatureCheck(
      [gateway(), gateway()],
      [first, second],
      [scenario('ach-return')]
    );
    assert.equal(first.FundType, 'Ach Return');
    assert.equal(second.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 2);
    assert.deepEqual(warningCodes(result), ['r4-fund-multi-candidate']);
  });

  test('同值 no-op 仍消费：后续网关不能再次命中', () => {
    const bankRow = bank({ FundType: 'Ach Return' });
    const firstGateway = gateway();
    const result = runRound4FundNatureCheck(
      [firstGateway, gateway()],
      [bankRow],
      [scenario('ach-return')]
    );
    assert.equal(result.modifications.length, 0);
    assert.equal(result.matchedPairs.length, 1, 'no-op 仍记录实际消费关系');
    assert.equal(result.matchedPairs[0].gwRow, firstGateway);
    assert.equal(result.matchedPairs[0].bankRow, bankRow);
    assert.equal(result.matchedPairs[0].subCategory, 'ach-return');
    assert.equal(result.matchedPairs[0].targetFundType, 'Ach Return');
    assert.equal(result.matchedPairs[0].changed, false, '同值关系不得伪装为字段修改');
    assert.deepEqual(warningCodes(result), ['r4-fund-match-mismatch']);
  });

  test('无同 ReconID 银行桶静默跳过', () => {
    const bankRow = bank({ ReconciliationId: 'OTHER' });
    const result = runRound4FundNatureCheck([gateway()], [bankRow], [scenario('ach-return')]);
    assert.equal(bankRow.FundType, 'Charge');
    assert.deepEqual(result.warnings, []);
  });

  test('前一条网关账号错误、后一条正确：正确候选仍能命中', () => {
    const bankRow = bank();
    const result = runRound4FundNatureCheck(
      [gateway({ merchantid: 'WRONG' }), gateway({ merchantid: 'M001' })],
      [bankRow],
      [scenario('ach-return')]
    );
    assert.equal(bankRow.FundType, 'Ach Return');
    assert.equal(result.modifications.length, 1);
    assert.deepEqual(warningCodes(result), ['r4-fund-match-mismatch']);
  });
});

test.describe('R4 v3.0.23 — 防御与候选评估', () => {
  test('空/非法入参返回空结果', () => {
    for (const input of [undefined, null, 'bad']) {
      const result = runRound4FundNatureCheck(input, input, input);
      assert.deepEqual(result, { modifications: [], warnings: [], matchedPairs: [] });
    }
  });

  test('完整条件不满足时不产生 matchedPairs', () => {
    const bankRow = bank({ MerchantId: 'OTHER' });
    const result = runRound4FundNatureCheck([gateway()], [bankRow], [scenario('ach-return')]);
    assert.deepEqual(result.matchedPairs, []);
    assert.equal(bankRow.FundType, 'Charge');
  });

  test('缺少 _rowId 时按银行原序补稳定行ID', () => {
    const bankRow = bank({ _rowId: null });
    delete bankRow._rowId;
    const result = runRound4FundNatureCheck([gateway()], [bankRow], [scenario('ach-return')]);
    assert.equal(bankRow._rowId, 'row_0');
    assert.equal(result.modifications[0].rowId, 'row_0');
  });

  test('evaluateR4Candidate 返回去重原因且不泄露账号值', () => {
    const result = evaluateR4Candidate(
      gateway({ merchantid: '', currency: '', amount: 'bad' }),
      bank({ MerchantId: '', Currency: '', 'Debit Amount': 'bad', 'Credit Amount': 'bad' }),
      R4_RULES_BY_SUBCATEGORY['ach-return']
    );
    assert.equal(result.matched, false);
    assert.equal(result.directionMismatch, true);
    assert.ok(result.reasons.includes('银行大账号为空'));
    assert.ok(result.reasons.includes('币种为空'));
    assert.ok(result.reasons.includes('Credit Amount不是合法金额'));
    assert.ok(result.reasons.includes('Debit Amount为空或不是合法金额'));
    assert.ok(result.reasons.includes('网关 amount 为空或不是合法金额'));
    assert.ok(result.reasons.every((reason) => !reason.includes('M001')));
  });
});
