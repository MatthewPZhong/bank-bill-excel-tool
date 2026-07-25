// v3.0.6 需求3「DBS-Charge 资金校验」引擎单测（🔴🔴 资金红线核心，最严）
// plan「需求3」全段 / 资金红线 review 点 1~3、7~8。对称模型（用户最终拍板）。
//
// 覆盖（任务清单逐条 + 对称模型新语义）：
//   ① 步骤1 匹配赋值：大账号 in 用收款卡号、out 用付款卡号（派生固化 big_account），取反不命中
//   ② 步骤1 金额差 1 分 / 币种不等 → 不命中
//   ③ 步骤1 命中行标 FundType=FundTransfer-in/out（in 调拨行→FundTransfer-in、out→FundTransfer-out）；赋 ReconciliationId 不变
//   ③' 🔴 in/out 同 ReconID 交互：一笔调拨单 in+out 两行（同 ReconID）各自匹配两条银行行 → 两条命中行各保留
//       FundTransfer-in/out 不被对方归并；同 ReconID 第三条非命中行 → Charge（两阶段防覆盖）
//   ③'' 步骤1 末归并：同 reconId 非命中行 Inbound→Charge、命中行不动、已 Charge no-op
//   ④ 步骤1 ReconciliationId 命中即覆盖（含非空原值）+ 严格 1v1（两调拨行抢一银行行）
//   ⑤ 步骤2 命中转 outbound（amount + currency 精确）
//   ⑥ 步骤2 未命中 → Charge（语义翻转）：候选 outbound 行网关未命中 → 变 Charge；候选 Charge 未命中 → 仍 Charge(no-op)
//   ⑦ 步骤2 用步骤1改后的【新 ReconciliationId】匹配网关
//   ⑧ 端到端：同 ReconID 桶 = FundTransfer(步1命中) + outbound(步2网关命中) + Charge(其余)
//   ⑨ Channel 门控：无 DBS 行整体 no-op；空入参 no-op
//
// 字段名一律经常量取（FT_RECON_FIELD_MAP.recon.*），绝不手敲。
// 方向固定值经 FT_RECON_FIELD_MAP.FUND_TYPE_IN/OUT 取（'FundTransfer-in'/'-out'）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runDbsChargeFundCheck,
  dispatchBankAmountEqual,
  dispatchAmountAbs
} = require('../../../../src/main-process/scenario-engines/dbs-charge-fund-check');

const { FT_RECON_FIELD_MAP } = require('../../../../src/constants/fund-transfer-recon-fields');

const R = FT_RECON_FIELD_MAP.recon; // 调拨对账单字段（经常量取）
const FT_IN = FT_RECON_FIELD_MAP.FUND_TYPE_IN;   // 'FundTransfer-in'（步骤1 in 命中行标记值，经常量取）
const FT_OUT = FT_RECON_FIELD_MAP.FUND_TYPE_OUT; // 'FundTransfer-out'（步骤1 out 命中行标记值，经常量取）

// 单测自造 config（全 config 化；用与默认不同的字面值以验证零硬编码——除 DBS 渠道值外）。
const CONFIG = {
  bankChannel: 'DBS',
  dispatchChannelValue: 'DBS',
  setFundTypeCharge: 'Charge',
  setFundTypeOutbound: 'outbound'
};
const OPTIONS = { config: CONFIG };

// ---- 测试夹具 ----------------------------------------------------------

// 银行行（驼峰真实表头）。金额放 Credit/Debit 双列，匹配只看 |credit-debit|。
function bankRow({
  rowId = 'b1',
  channel = 'DBS',
  merchantId = 'CARD-IN-001',
  currency = 'USD',
  credit = 0,
  debit = 100,
  extraFee = '',
  fundType = 'Inbound',
  reconId = ''
} = {}) {
  return {
    _rowId: rowId,
    Channel: channel,
    MerchantId: merchantId,
    Currency: currency,
    'Credit Amount': credit,
    'Debit Amount': debit,
    'Extra Fee': extraFee,
    FundType: fundType,
    ReconciliationId: reconId
  };
}

// 网关行：reconciliationid / amount / currency 为真实小写表头，TradeType 用步骤2固定白名单默认值。
function gwRow({ reconId = 'RC-1', amount = 100, currency = 'USD', tradeType = 'PUBLIC_PAY' } = {}) {
  return {
    reconciliationid: reconId,
    amount,
    currency,
    TradeType: tradeType
  };
}

// 调拨对账单行（字段经 FT_RECON_FIELD_MAP.recon.* 构造，绝不手敲）。
//   big_account 已按方向固化（in=收款卡号 / out=付款卡号）；本引擎零方向分支，仅比 big_account。
//   🔴 v3.0.6 codex-pr74-fix P1（方向感知门控）：fund_type 默认 FT_IN（必须有有效方向才进 dispRows）；
//     默认 in 行只判 收款渠道===DBS（receiveChannel 默认 'DBS'），payChannel 由 builder 留空（这里默认 'DBS'
//     不参与 in 行判定，仅为兼容旧夹具显式传 payChannel 的少数用例）。隔离验证「不写 FundType」的用例已不复存在
//     —— 匹配必带方向，命中行必被标 FundTransfer-in/out；需隔离 FundType 的用例改用与目标方向相同的初始 FundType
//     使其 no-op（old===new 不 record）。out 方向用例显式传 fundType: FT_OUT。
function dispRow({
  payChannel = 'DBS',
  receiveChannel = 'DBS',
  bigAccount = 'CARD-IN-001',
  currency = 'USD',
  amount = 100,
  reconId = 'RC-1',
  fundType = FT_IN
} = {}) {
  return {
    [R.payChannel]: payChannel,
    [R.receiveChannel]: receiveChannel,
    [R.bigAccount]: bigAccount,
    [R.currency]: currency,
    [R.amount]: amount,
    [R.reconId]: reconId,
    [R.fundType]: fundType
  };
}

// 断言辅助：按 (rowId, column) 找一条 modification。
function findMod(mods, rowId, column) {
  return mods.find((m) => m.rowId === rowId && m.column === column);
}

// ========================================================================
// 金额口径单元（dispatchAmountAbs / dispatchBankAmountEqual）
// ========================================================================

test.describe('DBS-Charge — 步骤1 金额口径', () => {
  test('dispatchAmountAbs = |金额|（单列，读 recon.amount）；非数值 → NaN', () => {
    assert.equal(dispatchAmountAbs({ [R.amount]: 100 }), 100);
    assert.equal(dispatchAmountAbs({ [R.amount]: -100 }), 100);
    assert.equal(dispatchAmountAbs({ [R.amount]: '100' }), 100);
    assert.ok(Number.isNaN(dispatchAmountAbs({ [R.amount]: 'abc' })));
    assert.ok(Number.isNaN(dispatchAmountAbs({})));
  });

  test('dispatchBankAmountEqual：调拨单列金额 ↔ 银行 |credit-debit|，精确到分', () => {
    // 银行 |0-100|=100 ↔ 调拨 100
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 100 }, { 'Credit Amount': 0, 'Debit Amount': 100 }), true);
    // 银行 |100-0|=100 ↔ 调拨 100（入账侧）
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 100 }, { 'Credit Amount': 100, 'Debit Amount': 0 }), true);
    // 差 1 分 → false
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 100 }, { 'Credit Amount': 0, 'Debit Amount': 100.01 }), false);
    // 调拨金额非数值 → false（防 NaN 误判相等）
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 'x' }, { 'Credit Amount': 0, 'Debit Amount': 100 }), false);
  });

  test('步骤1 金额比较完全忽略非零 Extra Fee', () => {
    const bank = { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 25 };
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 100 }, bank), true);
    assert.equal(dispatchBankAmountEqual({ [R.amount]: 125 }, bank), false);
  });
});

// ========================================================================
// 步骤1：匹配赋值（大账号方向 / 金额 / 币种）
// ========================================================================

test.describe('DBS-Charge — 步骤1 匹配赋值', () => {
  test('① in 行：big_account=收款卡号，银行 MerchantId=收款卡号 → 命中赋 ReconciliationId', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-IN-001', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-IN-001', amount: 100, reconId: 'RC-IN' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod, '应回填 ReconciliationId');
    assert.equal(mod.oldValue, '');
    assert.equal(mod.newValue, 'RC-IN');
    assert.equal(bank.ReconciliationId, 'RC-IN'); // 原地改写
  });

  test('步骤1 端到端：非零 Extra Fee 不改变调拨金额命中', () => {
    const bank = bankRow({
      rowId: 'step1-fee',
      merchantId: 'CARD-FEE',
      credit: 0,
      debit: 100,
      extraFee: 25,
      fundType: FT_IN
    });
    const disp = dispRow({ bigAccount: 'CARD-FEE', amount: 100, reconId: 'RC-FEE', fundType: FT_IN });

    const result = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    assert.equal(bank.ReconciliationId, 'RC-FEE');
    assert.ok(findMod(result.modifications, 'step1-fee', 'ReconciliationId'));
  });

  test('① 取反：big_account 与银行 MerchantId 不等 → 不命中（零改动）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-OTHER', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-IN-001', reconId: 'RC-IN' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);
    assert.equal(modifications.length, 0);
    assert.equal(bank.ReconciliationId, '');
  });

  test('② 金额差 1 分 → 不命中', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100.01, reconId: '' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-1' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);
    assert.equal(modifications.length, 0);
  });

  test('② 币种不等 → 不命中', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'HKD', credit: 0, debit: 100, reconId: '' });
    const disp = dispRow({ bigAccount: 'C1', currency: 'USD', amount: 100, reconId: 'RC-1' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);
    assert.equal(modifications.length, 0);
  });

  test('out 行：big_account=付款卡号，银行 MerchantId=付款卡号 → 命中（方向零分支，仅比 big_account）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-OUT-002', credit: 0, debit: 50, fundType: 'Outbound', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-OUT-002', amount: 50, reconId: 'RC-OUT' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);
    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod);
    assert.equal(mod.newValue, 'RC-OUT');
  });
});

// ========================================================================
// 步骤1（对称模型）：命中行标 FundType=FundTransfer-in/out（按调拨方向）
// ========================================================================

test.describe('DBS-Charge — 步骤1 命中行标 FundTransfer-in/out', () => {
  test('③ in 调拨行（fund_type=FundTransfer-in）命中 → 命中行 FundType 标 FundTransfer-in；ReconciliationId 仍赋值', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-IN-001', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-IN-001', amount: 100, reconId: 'RC-IN', fundType: FT_IN });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    // FundType 标为 FundTransfer-in（旧 Inbound → FT_IN，record）。
    const ftMod = findMod(modifications, 'b1', 'FundType');
    assert.ok(ftMod, '命中行应标 FundType=FundTransfer-in');
    assert.equal(ftMod.oldValue, 'Inbound');
    assert.equal(ftMod.newValue, FT_IN);
    assert.equal(bank.FundType, FT_IN);
    // ReconciliationId 赋值不变（与标记并存）。
    const reconMod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(reconMod, '命中行 ReconciliationId 仍赋值');
    assert.equal(reconMod.newValue, 'RC-IN');
    assert.equal(bank.ReconciliationId, 'RC-IN');
  });

  test('③ out 调拨行（fund_type=FundTransfer-out）命中 → 命中行 FundType 标 FundTransfer-out', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-OUT-002', credit: 0, debit: 50, fundType: 'Outbound', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-OUT-002', amount: 50, reconId: 'RC-OUT', fundType: FT_OUT });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    const ftMod = findMod(modifications, 'b1', 'FundType');
    assert.ok(ftMod, '命中行应标 FundType=FundTransfer-out');
    assert.equal(ftMod.oldValue, 'Outbound');
    assert.equal(ftMod.newValue, FT_OUT);
    assert.equal(bank.FundType, FT_OUT);
  });

  test('③ 命中行原 FundType 已等于目标 fund_type → no-op（不 record）', () => {
    // 银行行 FundType 已是 FundTransfer-in，调拨 fund_type 也 FundTransfer-in → 旧===新，不写不 record。
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-IN-001', credit: 100, debit: 0, fundType: FT_IN, reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-IN-001', amount: 100, reconId: 'RC-IN', fundType: FT_IN });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined, '旧===新 → FundType 不 record');
    assert.equal(bank.FundType, FT_IN);
    // ReconciliationId 仍赋（原空）。
    assert.ok(findMod(modifications, 'b1', 'ReconciliationId'));
  });

  test('③ 调拨 fund_type 为空（未知方向）→ 不进 dispRows、不匹配、不赋值（方向感知门控）', () => {
    // 🔴 v3.0.6 codex-pr74-fix P1：方向感知门控下空 fund_type=未知方向 → 既不判收款也不判付款渠道 →
    //   该调拨行不进 dispRows，零改动（原「空 fund_type 仍匹配但不写 FundType」的隔离语义已不复存在）。
    const bank = bankRow({ rowId: 'b1', merchantId: 'CARD-IN-001', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    const disp = dispRow({ bigAccount: 'CARD-IN-001', amount: 100, reconId: 'RC-IN', fundType: '' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    assert.equal(modifications.length, 0, '空 fund_type 调拨行不参与 → 零改动');
    assert.equal(bank.FundType, 'Inbound', '银行行 FundType 不动');
    assert.equal(bank.ReconciliationId, '', '银行行 ReconciliationId 未被赋值');
  });
});

// ========================================================================
// 🔴 步骤1 两阶段：in/out 同 ReconID 交互（命中行互不归并覆盖）
// ========================================================================

test.describe('DBS-Charge — 步骤1 in/out 同 ReconID 交互（两阶段防覆盖，🔴 红线核心）', () => {
  test("③' 一笔调拨单 in+out 两行（同 ReconID）各匹配两银行行 → 两命中行各保留 FundTransfer-in/out，不被对方归并；同 ReconID 第三非命中行→Charge", () => {
    // 一笔调拨单拆 in+out：ReconID 相同（=渠道流水号 'SER-1'），方向不同（big_account 各异）。
    //   bIn：MerchantId=CARD-IN（收款卡号），金额 100 → 被 in 调拨行命中 → 标 FundTransfer-in。
    //   bOut：MerchantId=CARD-OUT（付款卡号），金额 200 → 被 out 调拨行命中 → 标 FundTransfer-out。
    //   bOther：同 ReconID 已就位、非命中、Inbound → 阶段B 归并为 Charge。
    const bIn = bankRow({ rowId: 'bIn', merchantId: 'CARD-IN', currency: 'USD', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'CARD-OUT', currency: 'USD', credit: 0, debit: 200, fundType: 'Outbound', reconId: '' });
    const bOther = bankRow({ rowId: 'bOther', merchantId: 'CARD-X', currency: 'USD', credit: 0, debit: 5, fundType: 'Inbound', reconId: 'SER-1' });

    const dispIn = dispRow({ bigAccount: 'CARD-IN', currency: 'USD', amount: 100, reconId: 'SER-1', fundType: FT_IN });
    const dispOut = dispRow({ bigAccount: 'CARD-OUT', currency: 'USD', amount: 200, reconId: 'SER-1', fundType: FT_OUT });

    // 无网关 → 步骤2 不触发（仅验证步骤1 两阶段交互）。
    const { modifications } = runDbsChargeFundCheck([], [bIn, bOut, bOther], [dispIn, dispOut], OPTIONS);

    // 🔴 两命中行各保留方向值，绝不被对方同 ReconID 归并覆盖成 Charge。
    assert.equal(bIn.FundType, FT_IN, 'in 命中行保留 FundTransfer-in（未被 out 行归并覆盖）');
    assert.equal(bOut.FundType, FT_OUT, 'out 命中行保留 FundTransfer-out（未被 in 行归并覆盖）');
    assert.equal(bIn.ReconciliationId, 'SER-1');
    assert.equal(bOut.ReconciliationId, 'SER-1');
    // 两命中行各产 FundType modification（最终值即方向值，无被 Charge 覆盖的二次 record）。
    const bInFtMods = modifications.filter((m) => m.rowId === 'bIn' && m.column === 'FundType');
    const bOutFtMods = modifications.filter((m) => m.rowId === 'bOut' && m.column === 'FundType');
    assert.equal(bInFtMods.length, 1, 'in 命中行 FundType 只改一次（标 FT_IN，无 Charge 覆盖）');
    assert.equal(bInFtMods[0].newValue, FT_IN);
    assert.equal(bOutFtMods.length, 1, 'out 命中行 FundType 只改一次（标 FT_OUT，无 Charge 覆盖）');
    assert.equal(bOutFtMods[0].newValue, FT_OUT);
    // 同 ReconID 第三非命中行 → Charge。
    const otherMod = findMod(modifications, 'bOther', 'FundType');
    assert.ok(otherMod, '同 ReconID 非命中行应归并 Charge');
    assert.equal(otherMod.oldValue, 'Inbound');
    assert.equal(otherMod.newValue, 'Charge');
    assert.equal(bOther.FundType, 'Charge');
  });
});

// ========================================================================
// 步骤1 阶段B：归并同 reconId 非命中行为 Charge（🔴 最大红线，两阶段排除命中行 Set）
// ========================================================================

test.describe('DBS-Charge — 步骤1 阶段B 归并 Charge', () => {
  test("③'' 同 reconId 非命中行 Inbound → Charge；命中行不动（初始 FundType=目标方向时 no-op）；已 Charge no-op", () => {
    // 🔴 方向感知门控：disp 须带方向。chosen 为 out 腿（debit），用 out 调拨行（fund_type=FT_OUT）匹配；
    //   chosen 初始 FundType 预置为 FT_OUT，使命中行标记 old===new → no-op（隔离验证 ReconciliationId/归并，不掺 FundType record）。
    const chosen = bankRow({ rowId: 'chosen', merchantId: 'C1', credit: 0, debit: 100, fundType: FT_OUT, reconId: '' });
    // sibling1：预置 ReconciliationId=RC-1（同 reconId），FundType=Inbound → 应被置 Charge。
    const sib1 = bankRow({ rowId: 'sib1', merchantId: 'OTHER', fundType: 'Inbound', reconId: 'RC-1' });
    // sibling2：同 reconId 但已是 Charge → no-op（不 record）。
    const sib2 = bankRow({ rowId: 'sib2', merchantId: 'OTHER', fundType: 'Charge', reconId: 'RC-1' });
    // 无关行：reconId 不同 → 不动。
    const other = bankRow({ rowId: 'other', merchantId: 'OTHER', fundType: 'Inbound', reconId: 'RC-9' });

    const disp = dispRow({ payChannel: 'DBS', receiveChannel: '', bigAccount: 'C1', amount: 100, reconId: 'RC-1', fundType: FT_OUT });
    const { modifications } = runDbsChargeFundCheck([], [chosen, sib1, sib2, other], [disp], OPTIONS);

    // chosen 赋 ReconciliationId（原空→RC-1）。
    assert.ok(findMod(modifications, 'chosen', 'ReconciliationId'));
    // 命中行 chosen 自身 FundType 不动（初始即 FT_OUT，标记 no-op），无 FundType modification。
    assert.equal(chosen.FundType, FT_OUT);
    assert.equal(findMod(modifications, 'chosen', 'FundType'), undefined);
    // sib1 被置 Charge + record。
    const sib1Mod = findMod(modifications, 'sib1', 'FundType');
    assert.ok(sib1Mod);
    assert.equal(sib1Mod.oldValue, 'Inbound');
    assert.equal(sib1Mod.newValue, 'Charge');
    assert.equal(sib1.FundType, 'Charge');
    // sib2 已 Charge → no-op（无 modification，值不变）。
    assert.equal(findMod(modifications, 'sib2', 'FundType'), undefined);
    assert.equal(sib2.FundType, 'Charge');
    // other（reconId 不同）→ 不动。
    assert.equal(other.FundType, 'Inbound');
    assert.equal(findMod(modifications, 'other', 'FundType'), undefined);
  });

  test("③ 显式 scope='all'：批量置 Charge 搜【全量 bankRows】（含非 DBS 渠道行同 reconId 也被波及——忠于原文，red-line 点1）", () => {
    const chosen = bankRow({ rowId: 'chosen', channel: 'DBS', merchantId: 'C1', credit: 0, debit: 100, fundType: 'Outbound', reconId: '' });
    // 非 DBS 渠道行，但同 reconId（显式 scope='all' 时步骤1末批量置 Charge 忠于「全量银行单」→ 会被波及）。
    const nonDbs = bankRow({ rowId: 'nonDbs', channel: 'CITI', merchantId: 'X', fundType: 'Inbound', reconId: 'RC-1' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-1' });
    // 默认已改 'dbs-only'（防跨渠道误伤）；要验证「全量银行单」全渠道波及须显式传 scope='all'。
    const cfgAll = { config: { ...CONFIG, chargeSiblingsScope: 'all' } };
    const { modifications } = runDbsChargeFundCheck([], [chosen, nonDbs], [disp], cfgAll);

    const mod = findMod(modifications, 'nonDbs', 'FundType');
    assert.ok(mod, "scope='all'：非 DBS 同 reconId 行也被置 Charge（忠于原文全量银行单）");
    assert.equal(mod.newValue, 'Charge');
    assert.equal(nonDbs.FundType, 'Charge');
  });
});

// ========================================================================
// 步骤1：ReconciliationId 覆盖 + 严格 1v1
// ========================================================================

test.describe('DBS-Charge — 步骤1 ReconciliationId 覆盖 + 1v1', () => {
  test('④ 命中即覆盖（含非空原值）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: 'OLD-RECON' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-NEW' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod);
    assert.equal(mod.oldValue, 'OLD-RECON');
    assert.equal(mod.newValue, 'RC-NEW');
    assert.equal(bank.ReconciliationId, 'RC-NEW');
  });

  test('④ 调拨 ReconID 为空 → 不写 ReconciliationId（且空键不触发批量置 Charge）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: 'KEEP' });
    const sib = bankRow({ rowId: 'sib', merchantId: 'X', fundType: 'Inbound', reconId: '' }); // 空 reconId 不应被空键归并
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: '' });
    const { modifications } = runDbsChargeFundCheck([], [bank, sib], [disp], OPTIONS);

    // ReconID 空 → 不覆盖（原值保留），且无 ReconciliationId modification。
    assert.equal(findMod(modifications, 'b1', 'ReconciliationId'), undefined);
    assert.equal(bank.ReconciliationId, 'KEEP');
    // sib（reconId 空）不应被「空键」误归并为 Charge。
    assert.equal(findMod(modifications, 'sib', 'FundType'), undefined);
    assert.equal(sib.FundType, 'Inbound');
  });

  test('④ 严格 1v1：两条调拨行抢一条银行行 → 第二条无候选不命中', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: '' });
    const disp1 = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-A' });
    const disp2 = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-B' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp1, disp2], OPTIONS);

    // 仅一条 ReconciliationId 写入（被 disp1 消费），最终值 = RC-A（disp2 抢不到）。
    const reconMods = modifications.filter((m) => m.column === 'ReconciliationId');
    assert.equal(reconMods.length, 1);
    assert.equal(bank.ReconciliationId, 'RC-A');
  });

  test('④ 多候选 tie → 取原序首行 + warning', () => {
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: '' });
    const b2 = bankRow({ rowId: 'b2', merchantId: 'C1', credit: 0, debit: 100, reconId: '' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-1' });
    const { modifications, warnings } = runDbsChargeFundCheck([], [b1, b2], [disp], OPTIONS);

    // 取原序首行 b1。
    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod);
    assert.equal(b1.ReconciliationId, 'RC-1');
    assert.equal(b2.ReconciliationId, ''); // b2 未被赋值
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'multi-bank-match-dispatch');
  });
});

// ========================================================================
// 步骤2（对称模型）：网关 amount/currency 命中→outbound、未命中→Charge（语义翻转）
// ========================================================================

test.describe('DBS-Charge — 步骤2 命中→outbound / 未命中→Charge', () => {
  test('⑤ Charge 行：网关 amount+currency 命中 → 转 outbound', () => {
    // 🔴 方向感知门控：被调拨命中的行会标 FundTransfer-in/out（→ 不入步骤2 候选）。本用例验证步骤2 候选转 outbound，
    //   故预置 b1 reconId=RC-1 + 初始 Charge、不传调拨行（步骤1 no-op），隔离验证步骤2 桶逻辑（与 ⑥ 系列同范式）。
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    // 网关：reconciliationid=RC-1 + amount 100 + currency USD → 命中。
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [bank], [], OPTIONS);

    const ftMod = findMod(modifications, 'b1', 'FundType');
    assert.ok(ftMod, '应转 outbound');
    assert.equal(ftMod.oldValue, 'Charge');
    assert.equal(ftMod.newValue, 'outbound');
    assert.equal(bank.FundType, 'outbound');
  });

  test('步骤2 端到端：非零 Extra Fee 不污染网关金额命中', () => {
    const bank = bankRow({
      rowId: 'step2-fee',
      credit: 0,
      debit: 100,
      extraFee: 25,
      fundType: 'Charge',
      reconId: 'RC-FEE'
    });
    const gw = gwRow({ reconId: 'RC-FEE', amount: 100, currency: 'USD' });

    const result = runDbsChargeFundCheck([gw], [bank], [], OPTIONS);

    assert.equal(bank.FundType, 'outbound', 'DBS step2 必须按基础金额 100 命中，忽略 fee=25');
    assert.ok(findMod(result.modifications, 'step2-fee', 'FundType'));
  });

  test('⑤ 网关币种不等 → 未命中 → Charge（候选已是 Charge，no-op 不 record）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'HKD' }); // 币种不等
    const { modifications } = runDbsChargeFundCheck([gw], [bank], [], OPTIONS);

    // 未命中 → 置 Charge；候选已是 Charge → no-op（不 record）。
    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined);
    assert.equal(bank.FundType, 'Charge');
  });

  test('⑤ 网关金额差 1 分 → 未命中 → Charge（候选已是 Charge，no-op）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100.01, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [bank], [], OPTIONS);
    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined);
    assert.equal(bank.FundType, 'Charge');
  });

  test("⑥ 🔴 语义翻转：候选 outbound 行网关未命中 → 变 Charge（原『保持 outbound』断言翻转）", () => {
    // 候选 ∈ {Charge,outbound}：b1 初始 outbound（上游/历史带入），同 reconId 网关侧有行但 b1 金额不在网关 →
    //   b1 未命中 → 新语义置 Charge（旧语义保持 outbound）。
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 200, fundType: 'outbound', reconId: 'RC-1' });
    // 网关只有 amount=100（与 b1 的 200 不等）→ b1 未命中。桶非空（reconId 有网关行）确保进入候选遍历。
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [b1], [], OPTIONS);

    const mod = findMod(modifications, 'b1', 'FundType');
    assert.ok(mod, '候选 outbound 未命中应翻转为 Charge');
    assert.equal(mod.oldValue, 'outbound');
    assert.equal(mod.newValue, 'Charge');
    assert.equal(b1.FundType, 'Charge', '未命中 outbound 候选 → Charge（语义翻转）');
  });

  test("⑥ 同桶混合：命中行 outbound 留 outbound、未命中行 outbound 翻 Charge", () => {
    // 同 reconId 桶两行：b1=100 命中（留 outbound）、b2=200 未命中（outbound→Charge）。
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'outbound', reconId: 'RC-1' });
    const b2 = bankRow({ rowId: 'b2', merchantId: 'C1', currency: 'USD', credit: 0, debit: 200, fundType: 'outbound', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [b1, b2], [], OPTIONS);

    // b1 命中 → 已 outbound → no-op（不 record）。
    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined, 'b1 命中已 outbound → no-op');
    assert.equal(b1.FundType, 'outbound');
    // b2 未命中 → outbound 翻 Charge + record。
    const b2Mod = findMod(modifications, 'b2', 'FundType');
    assert.ok(b2Mod, 'b2 未命中 outbound 应翻 Charge');
    assert.equal(b2Mod.oldValue, 'outbound');
    assert.equal(b2Mod.newValue, 'Charge');
    assert.equal(b2.FundType, 'Charge');
  });

  test('⑥ 多笔：同 reconId 桶内命中行转 outbound、未命中 Charge 行留 Charge（no-op）', () => {
    // 两行同 MerchantId+reconId，金额不同：b1=100（网关有）、b2=200（网关无）。
    // 注意：步骤1 调拨严格 1v1 只能赋一行 ReconciliationId；为构造「同 reconId 桶含两行」，
    //   预置两行 ReconciliationId=RC-1 + 两行已是 Charge（步骤1对已 Charge no-op、对已有 reconId 行 1v1 仅消费匹配金额的那行）。
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    const b2 = bankRow({ rowId: 'b2', merchantId: 'C1', currency: 'USD', credit: 0, debit: 200, fundType: 'Charge', reconId: 'RC-1' });
    // 网关只有 amount=100 的行 → 仅 b1 命中。
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    // 不传调拨行（步骤1 no-op），直接验证步骤2 桶逻辑。
    const { modifications } = runDbsChargeFundCheck([gw], [b1, b2], [], OPTIONS);

    const b1Mod = findMod(modifications, 'b1', 'FundType');
    assert.ok(b1Mod);
    assert.equal(b1Mod.newValue, 'outbound');
    assert.equal(b1.FundType, 'outbound');
    // b2 金额 200 网关无 → 未命中 → 置 Charge；b2 已是 Charge → no-op（不 record）。
    assert.equal(findMod(modifications, 'b2', 'FundType'), undefined);
    assert.equal(b2.FundType, 'Charge');
  });

  test('⑥ 幂等：已是 outbound 的行命中 → no-op（不 record、不回退）', () => {
    // candidates ∈ {Charge, outbound}：outbound 行命中也参与，但 old===目标 → 不 record。
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'outbound', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [b1], [], OPTIONS);

    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined); // no-op
    assert.equal(b1.FundType, 'outbound');
  });

  test('⑥ candidates 仅 {Charge, outbound}：其他 FundType 值（如 Inbound）即便金额命中也不转', () => {
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Inbound', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [b1], [], OPTIONS);

    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined);
    assert.equal(b1.FundType, 'Inbound'); // 非 {Charge,outbound} 候选 → 不参与步骤2
  });

  test('⑦ 步骤2 用步骤1改后的【新 ReconciliationId】匹配网关（非银行原 reconId）', () => {
    // 🔴 方向感知门控：被调拨命中的行标 FundTransfer-out（不入步骤2 候选），故拆两行验证「步骤2 用新 reconId」：
    //   bankFt：原 ReconciliationId=OLD，被 out 调拨行覆盖为 RC-NEW（标 FundTransfer-out）—— 证明步骤1 写新值。
    //   bankChg：同桶另一行，预置 reconId=RC-NEW + Charge（候选）—— 步骤2 用 RC-NEW 关联 gwNew → 转 outbound；
    //     干扰 gwOld(reconId=OLD) 即便 amount 对，因桶键=RC-NEW 不应命中，证明步骤2 keyed on 新值非 OLD。
    const bankFt = bankRow({ rowId: 'bFt', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'OLD' });
    const bankChg = bankRow({ rowId: 'bChg', merchantId: 'M-OTHER', currency: 'USD', credit: 0, debit: 200, fundType: 'Charge', reconId: 'RC-NEW' });
    // out 调拨行：付款渠道=DBS、收款渠道留空（builder D1 单向固化口径），big_account=C1、金额 100、覆盖 reconId=RC-NEW。
    const disp = dispRow({ payChannel: 'DBS', receiveChannel: '', bigAccount: 'C1', currency: 'USD', amount: 100, reconId: 'RC-NEW', fundType: FT_OUT });
    // 网关 reconciliationid=RC-NEW（步骤1 改后的新值）amount=200 → 命中 bankChg 转 outbound。
    const gwNew = gwRow({ reconId: 'RC-NEW', amount: 200, currency: 'USD' });
    // 干扰：网关 reconciliationid=OLD（bankFt 原值）amount=200 也对，但桶用新 reconId 不应被它命中。
    const gwOld = gwRow({ reconId: 'OLD', amount: 200, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gwOld, gwNew], [bankFt, bankChg], [disp], OPTIONS);

    // bankFt：ReconciliationId 已覆盖为 RC-NEW，标 FundTransfer-out（步骤1 命中行，不入步骤2）。
    assert.equal(bankFt.ReconciliationId, 'RC-NEW');
    assert.equal(bankFt.FundType, FT_OUT, '步骤1 命中行标 FundTransfer-out，步骤2 不碰');
    // bankChg：步骤2 用 RC-NEW（步骤1 写的新值）关联到 gwNew → 转 outbound（gwOld 用 OLD 键不命中）。
    const ftMod = findMod(modifications, 'bChg', 'FundType');
    assert.ok(ftMod, '应用新 ReconciliationId 命中网关并转 outbound');
    assert.equal(ftMod.newValue, 'outbound');
    assert.equal(bankChg.FundType, 'outbound');
  });

  test('步骤2：reconId 桶网关侧无行 → 整桶不动（保持步骤1 的 FundType；不触发未命中→Charge）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    // 网关行 reconId 对不上 → gwForKey 空 → continue（整桶跳过，不进候选遍历、不翻 Charge）。
    const gw = gwRow({ reconId: 'RC-OTHER', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [bank], [], OPTIONS);
    assert.equal(findMod(modifications, 'b1', 'FundType'), undefined);
    assert.equal(bank.FundType, 'Charge');
  });
});

// ========================================================================
// v3.0.21：步骤2 固定网关白名单 + outbound Credit 方向守卫
// ========================================================================

test.describe('DBS-Charge — 步骤2 网关白名单', () => {
  const whitelist = [
    'AchReturn',
    'ACQ_WITHDRAW',
    'B2B_FLOW_GOLD',
    'B2B_FLOW_GOLD_SUPPLIER',
    'B2B_SUPPLIER',
    'B2B_WITHDRAW',
    'CUR_PAY',
    'FX_WITHDRAW',
    'HX_WITHDRAW',
    'MPT_SUPPLIER',
    'MPT_WITHDRAW',
    'PUBLIC_PAY'
  ];

  test('固定 12 类 TradeType 均可进入步骤2索引并命中 outbound', () => {
    for (const [index, tradeType] of whitelist.entries()) {
      const reconId = `RC-WL-${index}`;
      const bank = bankRow({ rowId: `b-${index}`, fundType: 'Charge', reconId, credit: 0, debit: 100 });
      const result = runDbsChargeFundCheck(
        [gwRow({ reconId, tradeType, amount: 100, currency: 'USD' })],
        [bank],
        [],
        OPTIONS
      );
      assert.equal(bank.FundType, 'outbound', `${tradeType} 应命中 outbound`);
      assert.ok(findMod(result.modifications, `b-${index}`, 'FundType'), `${tradeType} 应记录 FundType modification`);
    }
  });

  test('TradeType 先 trim 再严格匹配：外侧空白接受，大小写不同拒绝', () => {
    const trimmed = bankRow({ rowId: 'trimmed', fundType: 'Charge', reconId: 'RC-TRIM', credit: 0, debit: 100 });
    runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-TRIM', tradeType: '  PUBLIC_PAY  ' })],
      [trimmed],
      [],
      OPTIONS
    );
    assert.equal(trimmed.FundType, 'outbound', 'trim 后白名单值应进入索引');

    const wrongCase = bankRow({ rowId: 'wrong-case', fundType: 'Charge', reconId: 'RC-CASE', credit: 0, debit: 100 });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-CASE', tradeType: 'public_pay' })],
      [wrongCase],
      [],
      OPTIONS
    );
    assert.equal(wrongCase.FundType, 'Charge', '大小写不同不是白名单值');
    assert.equal(result.modifications.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  test('非白名单-only 桶保持原 FundType，不触发 outbound→Charge，也不告警', () => {
    const bank = bankRow({ rowId: 'non-white', fundType: 'outbound', reconId: 'RC-NON-WHITE', credit: 0, debit: 200 });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-NON-WHITE', tradeType: 'NOT_ALLOWED', amount: 100 })],
      [bank],
      [],
      OPTIONS
    );

    assert.equal(bank.FundType, 'outbound', '只有非白名单行时整个桶不处理');
    assert.equal(result.modifications.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  test('混合桶只看白名单候选：非白名单金额命中不算 hit，既有 outbound 按现有规则回落 Charge', () => {
    const bank = bankRow({ rowId: 'mixed', fundType: 'outbound', reconId: 'RC-MIXED', credit: 0, debit: 100 });
    const result = runDbsChargeFundCheck(
      [
        gwRow({ reconId: 'RC-MIXED', tradeType: 'NOT_ALLOWED', amount: 100 }),
        gwRow({ reconId: 'RC-MIXED', tradeType: 'PUBLIC_PAY', amount: 999 })
      ],
      [bank],
      [],
      OPTIONS
    );

    assert.equal(bank.FundType, 'Charge');
    const mod = findMod(result.modifications, 'mixed', 'FundType');
    assert.ok(mod);
    assert.equal(mod.oldValue, 'outbound');
    assert.equal(mod.newValue, 'Charge');
    assert.equal(result.warnings.length, 0);
  });
});

test.describe('DBS-Charge — 步骤2 outbound Credit 方向守卫', () => {
  test('白名单金额币种命中但 Credit Amount 非0：Charge 保持原值、不 modification、新增 warning', () => {
    const bank = bankRow({ rowId: 'credit-bad', fundType: 'Charge', reconId: 'RC-CREDIT', credit: 100, debit: 0 });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-CREDIT', tradeType: 'PUBLIC_PAY', amount: 100 })],
      [bank],
      [],
      OPTIONS
    );

    assert.equal(bank.FundType, 'Charge', '方向不符保持进入步骤2前的原值');
    assert.equal(findMod(result.modifications, 'credit-bad', 'FundType'), undefined);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'dbs-charge-fund-direction-mismatch');
    assert.equal(result.warnings[0].rowId, 'credit-bad');
    assert.match(result.warnings[0].message, /Credit Amount 非0/);
  });

  test('方向不符时既有 outbound 也保持原值，但仍产生 warning', () => {
    const bank = bankRow({ rowId: 'outbound-bad', fundType: 'outbound', reconId: 'RC-OUT-BAD', credit: -100, debit: 0 });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-OUT-BAD', tradeType: 'AchReturn', amount: 100 })],
      [bank],
      [],
      OPTIONS
    );

    assert.equal(bank.FundType, 'outbound');
    assert.equal(findMod(result.modifications, 'outbound-bad', 'FundType'), undefined);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'dbs-charge-fund-direction-mismatch');
  });

  test('方向守卫先于金额币种：白名单金额不匹配时，非0 Credit 的 outbound 仍保持原值', () => {
    const bank = bankRow({ rowId: 'direction-before-amount', fundType: 'outbound', reconId: 'RC-DIR-FIRST', credit: 5, debit: 100 });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-DIR-FIRST', tradeType: 'PUBLIC_PAY', amount: 999, currency: 'USD' })],
      [bank],
      [],
      OPTIONS
    );

    assert.equal(bank.FundType, 'outbound', '方向不符不得继续执行既有 outbound→Charge 回落');
    assert.equal(findMod(result.modifications, 'direction-before-amount', 'FundType'), undefined);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'dbs-charge-fund-direction-mismatch');
  });

  test('步骤1既有改写保留：sibling 先归 Charge 后方向不符，步骤2不新增 modification', () => {
    const transfer = bankRow({
      rowId: 'step1-transfer', merchantId: 'CARD-OUT', credit: 0, debit: 500,
      fundType: 'Outbound', reconId: ''
    });
    const sibling = bankRow({
      rowId: 'step1-sibling', merchantId: 'OTHER', credit: 100, debit: 0,
      fundType: 'outbound', reconId: 'RC-STEP1-DIRECTION'
    });
    const result = runDbsChargeFundCheck(
      [gwRow({ reconId: 'RC-STEP1-DIRECTION', tradeType: 'PUBLIC_PAY', amount: 100 })],
      [transfer, sibling],
      [dispRow({
        bigAccount: 'CARD-OUT', amount: 500, reconId: 'RC-STEP1-DIRECTION', fundType: FT_OUT
      })],
      OPTIONS
    );

    assert.equal(sibling.FundType, 'Charge', '步骤1 sibling 归并结果必须保留');
    const siblingMods = result.modifications.filter(
      (modification) => modification.rowId === 'step1-sibling' && modification.column === 'FundType'
    );
    assert.deepEqual(siblingMods.map(({ oldValue, newValue }) => ({ oldValue, newValue })), [
      { oldValue: 'outbound', newValue: 'Charge' }
    ]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'dbs-charge-fund-direction-mismatch');
  });

  test('Credit Amount 为0、空或非法均按0：允许 Charge→outbound 且不告警', () => {
    for (const [index, credit] of [0, '0.00', '', null, 'not-a-number'].entries()) {
      const reconId = `RC-CREDIT-ZERO-${index}`;
      const bank = bankRow({ rowId: `credit-zero-${index}`, fundType: 'Charge', reconId, credit, debit: 100 });
      const result = runDbsChargeFundCheck(
        [gwRow({ reconId, tradeType: 'MPT_WITHDRAW', amount: 100 })],
        [bank],
        [],
        OPTIONS
      );

      assert.equal(bank.FundType, 'outbound', `Credit=${String(credit)} 应按0放行`);
      assert.equal(result.warnings.length, 0);
      assert.ok(findMod(result.modifications, `credit-zero-${index}`, 'FundType'));
    }
  });
});

// ========================================================================
// ⑧ 端到端走查（对称模型）：同 ReconID 桶 = FundTransfer(步1命中) + outbound(步2网关命中) + Charge(其余)
// ========================================================================

test.describe('DBS-Charge — 端到端走查（同 ReconID 桶三类终态）', () => {
  test('⑧ 一笔调拨 out 命中 + 网关确认一条 outbound + 其余归 Charge → 三类终态各断言', () => {
    // 构造同 ReconID='SER-9' 的 DBS 桶四行（金额各异）：
    //   bFt ：MerchantId=CARD-OUT、金额 500 → 步骤1 out 调拨命中 → 标 FundTransfer-out（受保护，步骤2 不碰）。
    //   bOut：金额 300、初始 Charge、预置 reconId=SER-9 → 步骤2 网关 amount=300 命中 → outbound。
    //   bChg：金额 700、初始 Inbound、预置 reconId=SER-9 → 步骤1 阶段B 归并 Charge；步骤2 网关无 700 → 未命中留 Charge。
    //   bChg2：金额 900、初始 outbound（历史带入）、预置 reconId=SER-9 → 步骤2 网关无 900 → 未命中翻 Charge。
    const bFt = bankRow({ rowId: 'bFt', merchantId: 'CARD-OUT', currency: 'USD', credit: 0, debit: 500, fundType: 'Outbound', reconId: '' });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'M-OTHER', currency: 'USD', credit: 0, debit: 300, fundType: 'Charge', reconId: 'SER-9' });
    const bChg = bankRow({ rowId: 'bChg', merchantId: 'M-OTHER', currency: 'USD', credit: 0, debit: 700, fundType: 'Inbound', reconId: 'SER-9' });
    const bChg2 = bankRow({ rowId: 'bChg2', merchantId: 'M-OTHER', currency: 'USD', credit: 0, debit: 900, fundType: 'outbound', reconId: 'SER-9' });

    // out 调拨行：big_account=CARD-OUT、金额 500、ReconID=SER-9、fund_type=FundTransfer-out。
    const dispOut = dispRow({ bigAccount: 'CARD-OUT', currency: 'USD', amount: 500, reconId: 'SER-9', fundType: FT_OUT });
    // 网关只确认 amount=300 一条（→ bOut 转 outbound）。
    const gw = gwRow({ reconId: 'SER-9', amount: 300, currency: 'USD' });

    const { modifications } = runDbsChargeFundCheck([gw], [bFt, bOut, bChg, bChg2], [dispOut], OPTIONS);

    // 终态①：FundTransfer-out（步骤1 命中，受两阶段保护，步骤2 不碰）。
    assert.equal(bFt.FundType, FT_OUT, '步骤1 命中行终态 FundTransfer-out');
    assert.equal(bFt.ReconciliationId, 'SER-9');
    // 终态②：outbound（步骤2 网关确认）。
    assert.equal(bOut.FundType, 'outbound', '步骤2 网关命中行终态 outbound');
    const bOutMod = findMod(modifications, 'bOut', 'FundType');
    assert.ok(bOutMod);
    assert.equal(bOutMod.newValue, 'outbound');
    // 终态③a：Charge（步骤1 归并 Inbound→Charge，步骤2 未命中留 Charge）。
    assert.equal(bChg.FundType, 'Charge', '步骤1 归并 + 步骤2 未命中 → Charge');
    // 终态③b：Charge（步骤2 未命中 outbound 翻 Charge）。
    assert.equal(bChg2.FundType, 'Charge', '步骤2 未命中 outbound 翻 Charge');
    const bChg2Mod = findMod(modifications, 'bChg2', 'FundType');
    assert.ok(bChg2Mod, 'bChg2 outbound→Charge 应 record');
    assert.equal(bChg2Mod.oldValue, 'outbound');
    assert.equal(bChg2Mod.newValue, 'Charge');

    // 整桶三类终态齐全：1×FundTransfer-out + 1×outbound + 2×Charge。
    const finals = [bFt, bOut, bChg, bChg2].map((r) => r.FundType);
    assert.equal(finals.filter((f) => f === FT_OUT).length, 1, '桶内 1 条 FundTransfer-out');
    assert.equal(finals.filter((f) => f === 'outbound').length, 1, '桶内 1 条 outbound');
    assert.equal(finals.filter((f) => f === 'Charge').length, 2, '桶内 2 条 Charge');
  });
});

// ========================================================================
// 步骤1：空 big_account 调拨行不进 dispRows（🔴 资金红线护栏，与 r5 line162 同口径）
// ========================================================================

test.describe('DBS-Charge — 步骤1 空 big_account 调拨行不赋值/不归并（负向护栏）', () => {
  test('调拨 big_account 为空 → 不命中 MerchantId 也为空的银行行（valuesEqual("","")===true 的误命中被护栏拦截）+ 不触发归并', () => {
    // 命中目标候选：MerchantId 为空的 DBS 行 b1（无护栏时空 big_account 会 valuesEqual('','')===true 误命中）。
    const b1 = bankRow({ rowId: 'b1', merchantId: '', credit: 0, debit: 100, fundType: 'Inbound', reconId: '' });
    // 同 reconId 的归并目标 sib：若空 big_account 误命中 b1 并赋 RC-1，会连带把 sib 归并为 Charge。
    const sib = bankRow({ rowId: 'sib', merchantId: 'Y', fundType: 'Inbound', reconId: 'RC-1' });
    const disp = dispRow({ bigAccount: '', amount: 100, reconId: 'RC-1' });

    const { modifications } = runDbsChargeFundCheck([], [b1, sib], [disp], OPTIONS);
    assert.equal(modifications.length, 0, '空 big_account 调拨行不进 dispRows → 零改动');
    assert.equal(b1.ReconciliationId, '', '空 MerchantId 银行行未被误赋值');
    assert.equal(b1.FundType, 'Inbound');
    assert.equal(sib.FundType, 'Inbound', '空键未触发归并 → sib 不被置 Charge');
  });

  test('空 big_account 行不占池：同一 DBS 银行行仍可被后续有效 big_account 调拨行命中', () => {
    const b1 = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: '' });
    const dispEmpty = dispRow({ bigAccount: '', amount: 100, reconId: 'RC-EMPTY' });
    const dispValid = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-VALID' });
    const { modifications } = runDbsChargeFundCheck([], [b1], [dispEmpty, dispValid], OPTIONS);

    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod, '有效 big_account 行应命中（空 big_account 行未抢占）');
    assert.equal(mod.newValue, 'RC-VALID');
    assert.equal(b1.ReconciliationId, 'RC-VALID');
  });
});

// ========================================================================
// 跨渠道置 Charge 单向性 + chargeSiblingsScope 开关
// ========================================================================

test.describe('DBS-Charge — 跨渠道置 Charge 单向性（步骤2 不恢复）', () => {
  test('非 DBS 同 reconId 行步骤1 被置 Charge 后，步骤2 不恢复（非 dbsBankRows 不进步骤2 桶，即便网关金额匹配）', () => {
    // chosen：DBS、out 腿（debit）、命中 out 调拨行 → 赋 ReconciliationId=RC-1、标 FundTransfer-out。
    //   初始 FundType 预置 FT_OUT 使标记 no-op（隔离验证跨渠道归并单向性，不掺 chosen 的 FundType record）。
    const chosen = bankRow({ rowId: 'chosen', channel: 'DBS', merchantId: 'C1', credit: 0, debit: 100, fundType: FT_OUT, reconId: '' });
    // nonDbs：CITI、同 reconId、Inbound → 步骤1末批量置 Charge（显式 scope='all' 全量银行单，构造步骤2 前置）。
    const nonDbs = bankRow({ rowId: 'nonDbs', channel: 'CITI', merchantId: 'X', credit: 0, debit: 100, fundType: 'Inbound', reconId: 'RC-1' });
    const disp = dispRow({ payChannel: 'DBS', receiveChannel: '', bigAccount: 'C1', amount: 100, reconId: 'RC-1', fundType: FT_OUT });
    // 网关 amount=100 命中 nonDbs 金额；但 nonDbs 非 DBS → 不进步骤2 桶 → 不会被恢复/改写。
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    // 默认已改 'dbs-only'；本用例要让 nonDbs 在步骤1 被置 Charge 作前置，须显式 scope='all'。
    const cfgAll = { config: { ...CONFIG, chargeSiblingsScope: 'all' } };
    const { modifications } = runDbsChargeFundCheck([gw], [chosen, nonDbs], [disp], cfgAll);

    // nonDbs：步骤1 置 Charge（单向，步骤2 不回退/不转 outbound）。
    const nonDbsMod = findMod(modifications, 'nonDbs', 'FundType');
    assert.ok(nonDbsMod, '步骤1 应把非 DBS 同 reconId 行置 Charge');
    assert.equal(nonDbsMod.oldValue, 'Inbound');
    assert.equal(nonDbsMod.newValue, 'Charge');
    assert.equal(nonDbs.FundType, 'Charge', '非 DBS 行最终保持 Charge（步骤2 未恢复其原 Inbound）');
    // 仅一条 FundType modification（nonDbs 那条）；nonDbs 不应再产生第二条（无转 outbound）。
    const nonDbsFtMods = modifications.filter((m) => m.rowId === 'nonDbs' && m.column === 'FundType');
    assert.equal(nonDbsFtMods.length, 1, '非 DBS 行 FundType 只被改一次（步骤1），步骤2 不二次改写');
    // chosen 自身 FundType 不动（初始即 FT_OUT，命中标记 no-op）。
    assert.equal(chosen.FundType, FT_OUT);
    assert.equal(findMod(modifications, 'chosen', 'FundType'), undefined, 'chosen 标记 no-op，无 FundType record');
  });

  test("chargeSiblingsScope='dbs-only'：非 DBS 同 reconId 行不被置 Charge；DBS 同 reconId 行仍被置 Charge", () => {
    const chosen = bankRow({ rowId: 'chosen', channel: 'DBS', merchantId: 'C1', credit: 0, debit: 100, fundType: 'Outbound', reconId: '' });
    const nonDbs = bankRow({ rowId: 'nonDbs', channel: 'CITI', merchantId: 'X', fundType: 'Inbound', reconId: 'RC-1' });
    const dbsSib = bankRow({ rowId: 'dbsSib', channel: 'DBS', merchantId: 'Y', fundType: 'Inbound', reconId: 'RC-1' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-1' });
    const cfg = { config: { bankChannel: 'DBS', dispatchChannelValue: 'DBS', setFundTypeCharge: 'Charge', setFundTypeOutbound: 'outbound', chargeSiblingsScope: 'dbs-only' } };
    const { modifications } = runDbsChargeFundCheck([], [chosen, nonDbs, dbsSib], [disp], cfg);

    // 非 DBS 行不被波及（dbs-only 仅 Channel===bankChannel 行参与归并）。
    assert.equal(findMod(modifications, 'nonDbs', 'FundType'), undefined, 'dbs-only：非 DBS 同 reconId 行不被置 Charge');
    assert.equal(nonDbs.FundType, 'Inbound', '非 DBS 行保持原 Inbound');
    // DBS 渠道的同 reconId 行仍被置 Charge（dbs-only 不影响 DBS 行）。
    const dbsSibMod = findMod(modifications, 'dbsSib', 'FundType');
    assert.ok(dbsSibMod, 'dbs-only：DBS 渠道同 reconId 行仍被置 Charge');
    assert.equal(dbsSibMod.newValue, 'Charge');
    assert.equal(dbsSib.FundType, 'Charge');
  });

  test("默认 scope='dbs-only'：不传 chargeSiblingsScope → 非 DBS 同 reconId 行不被置 Charge；DBS 同 reconId 行仍被置 Charge", () => {
    // 🔴 默认值改动核心断言：默认 'dbs-only'（防跨渠道误伤），非 DBS 行不波及。
    const chosen = bankRow({ rowId: 'chosen', channel: 'DBS', merchantId: 'C1', credit: 0, debit: 100, fundType: 'Outbound', reconId: '' });
    const nonDbs = bankRow({ rowId: 'nonDbs', channel: 'CITI', merchantId: 'X', fundType: 'Inbound', reconId: 'RC-1' });
    const dbsSib = bankRow({ rowId: 'dbsSib', channel: 'DBS', merchantId: 'Y', fundType: 'Inbound', reconId: 'RC-1' });
    const disp = dispRow({ bigAccount: 'C1', amount: 100, reconId: 'RC-1' });
    // 不传 chargeSiblingsScope → 默认 'dbs-only'。
    const { modifications } = runDbsChargeFundCheck([], [chosen, nonDbs, dbsSib], [disp], OPTIONS);
    // 非 DBS 行默认不被波及（与显式 scope='all' 用例对照，证明默认值已改 'dbs-only'）。
    assert.equal(findMod(modifications, 'nonDbs', 'FundType'), undefined, "默认 'dbs-only'：非 DBS 同 reconId 行不被置 Charge");
    assert.equal(nonDbs.FundType, 'Inbound', '非 DBS 行保持原 Inbound');
    // DBS 渠道同 reconId 行仍被置 Charge（默认 dbs-only 不影响 DBS 行）。
    const dbsSibMod = findMod(modifications, 'dbsSib', 'FundType');
    assert.ok(dbsSibMod, "默认 'dbs-only'：DBS 渠道同 reconId 行仍被置 Charge");
    assert.equal(dbsSibMod.newValue, 'Charge');
    assert.equal(dbsSib.FundType, 'Charge');
  });
});

// ========================================================================
// 零额行固化（构造银行零额行记录当前行为，不改零额逻辑）
// ========================================================================

test.describe('DBS-Charge — 零额行当前行为固化（不改零额逻辑）', () => {
  test('零额调拨行（金额 0）匹配零额 DBS 银行行（|credit-debit|=0）→ 当前行为：0===0 视为相等并赋 ReconciliationId', () => {
    // ⚠️ 固化「当前行为」：dispatchBankAmountEqual 对 0 与 0 → Math.round(0)===Math.round(0) → true。
    //   故零额调拨行会命中零额银行行（big_account/币种相等且 big_account 非空时）。本测试仅记录现状，不改零额逻辑。
    // 🔴 方向感知门控：disp 须带方向（默认 in 行判收款渠道=DBS）；bank 初始 FundType 预置 FT_IN 使命中标记 no-op，
    //   隔离验证零额匹配行为（命中行 FundType 不掺二次改动）。
    const bank = bankRow({ rowId: 'bz', merchantId: 'C1', currency: 'USD', credit: 0, debit: 0, fundType: FT_IN, reconId: '' });
    const disp = dispRow({ bigAccount: 'C1', currency: 'USD', amount: 0, reconId: 'RC-Z', fundType: FT_IN });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);

    const mod = findMod(modifications, 'bz', 'ReconciliationId');
    assert.ok(mod, '当前行为：零额↔零额视为金额相等 → 命中赋值（固化现状）');
    assert.equal(mod.newValue, 'RC-Z');
    assert.equal(bank.ReconciliationId, 'RC-Z');
    // 命中行自身 FundType 不动（初始即 FT_IN，标记 no-op）。
    assert.equal(bank.FundType, FT_IN);
  });

  test('零额调拨行 不命中 非零额银行行（0 ≠ 100，金额精确到分仍生效）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, reconId: '' });
    const disp = dispRow({ bigAccount: 'C1', currency: 'USD', amount: 0, reconId: 'RC-Z' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [disp], OPTIONS);
    assert.equal(modifications.length, 0, '零额调拨行不应命中非零额银行行');
    assert.equal(bank.ReconciliationId, '');
  });
});

// ========================================================================
// 门控 + 空入参
// ========================================================================

test.describe('DBS-Charge — Channel 门控 + 空入参', () => {
  test('⑧ 无 DBS 行 → 整体 no-op（即便调拨 + 网关都能配上）', () => {
    // 银行行全是非 DBS 渠道。
    const bank = bankRow({ rowId: 'b1', channel: 'CITI', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    const disp = dispRow({ bigAccount: 'C1', currency: 'USD', amount: 100, reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications, warnings } = runDbsChargeFundCheck([gw], [bank], [disp], OPTIONS);

    assert.equal(modifications.length, 0);
    assert.equal(warnings.length, 0);
    assert.equal(bank.FundType, 'Charge');
    assert.equal(bank.ReconciliationId, 'RC-1');
  });

  test('⑨ 空入参 no-op：bankRows 空 / 全空 / 缺省', () => {
    assert.deepEqual(runDbsChargeFundCheck([], [], [], OPTIONS).modifications, []);
    assert.deepEqual(runDbsChargeFundCheck(null, null, null, OPTIONS).modifications, []);
    assert.deepEqual(runDbsChargeFundCheck().modifications, []);
    // 有 DBS 银行行但调拨 + 网关都空 → 无可改（步骤1 无 dispRows、步骤2 无网关桶命中）。
    const bank = bankRow({ rowId: 'b1', fundType: 'Charge', reconId: 'RC-1' });
    assert.deepEqual(runDbsChargeFundCheck([], [bank], [], OPTIONS).modifications, []);
  });

  test('dispatchChannelValue 方向感知门控：fund_type 空（未知方向）→ 该调拨行不参与步骤1', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 100, reconId: '' });
    // fund_type 空 → 未知方向 → 既不判收款渠道也不判付款渠道 → 不进 dispRows（哪怕渠道列填了 DBS）。
    const dispNoDir = dispRow({ payChannel: 'DBS', receiveChannel: 'DBS', bigAccount: 'C1', amount: 100, reconId: 'RC-1', fundType: '' });
    const { modifications } = runDbsChargeFundCheck([], [bank], [dispNoDir], OPTIONS);
    assert.equal(modifications.length, 0);
    assert.equal(bank.ReconciliationId, '');
  });

  test('方向感知门控：in 行判收款渠道===DBS（付款渠道留空也命中，builder D1 单向固化口径）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    // in 行：付款渠道留空（builder 实际输出）、收款渠道=DBS → 命中通道。
    const dispIn = dispRow({ payChannel: '', receiveChannel: 'DBS', bigAccount: 'C1', amount: 100, reconId: 'RC-IN', fundType: FT_IN });
    const { modifications } = runDbsChargeFundCheck([], [bank], [dispIn], OPTIONS);
    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod, 'in 行收款渠道=DBS（付款渠道空）应命中通道');
    assert.equal(mod.newValue, 'RC-IN');
    assert.equal(bank.ReconciliationId, 'RC-IN');
  });

  test('方向感知门控：in 行收款渠道≠DBS → 跳过（即便付款渠道恰为 DBS 也不判付款列）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 100, debit: 0, fundType: 'Inbound', reconId: '' });
    // in 行只判收款渠道：收款=CITI → 不进 dispRows（付款列=DBS 对 in 行无意义、不参与判定）。
    const dispIn = dispRow({ payChannel: 'DBS', receiveChannel: 'CITI', bigAccount: 'C1', amount: 100, reconId: 'RC-IN', fundType: FT_IN });
    const { modifications } = runDbsChargeFundCheck([], [bank], [dispIn], OPTIONS);
    assert.equal(modifications.length, 0);
    assert.equal(bank.ReconciliationId, '');
  });

  test('方向感知门控：out 行判付款渠道===DBS（收款渠道留空也命中，builder D1 单向固化口径）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 50, fundType: 'Outbound', reconId: '' });
    // out 行：收款渠道留空（builder 实际输出）、付款渠道=DBS → 命中通道。
    const dispOut = dispRow({ payChannel: 'DBS', receiveChannel: '', bigAccount: 'C1', amount: 50, reconId: 'RC-OUT', fundType: FT_OUT });
    const { modifications } = runDbsChargeFundCheck([], [bank], [dispOut], OPTIONS);
    const mod = findMod(modifications, 'b1', 'ReconciliationId');
    assert.ok(mod, 'out 行付款渠道=DBS（收款渠道空）应命中通道');
    assert.equal(mod.newValue, 'RC-OUT');
    assert.equal(bank.ReconciliationId, 'RC-OUT');
  });

  test('方向感知门控：out 行付款渠道≠DBS → 跳过（即便收款渠道恰为 DBS 也不判收款列）', () => {
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', credit: 0, debit: 50, fundType: 'Outbound', reconId: '' });
    // out 行只判付款渠道：付款=CITI → 不进 dispRows（收款列=DBS 对 out 行无意义、不参与判定）。
    const dispOut = dispRow({ payChannel: 'CITI', receiveChannel: 'DBS', bigAccount: 'C1', amount: 50, reconId: 'RC-OUT', fundType: FT_OUT });
    const { modifications } = runDbsChargeFundCheck([], [bank], [dispOut], OPTIONS);
    assert.equal(modifications.length, 0);
    assert.equal(bank.ReconciliationId, '');
  });

  test('config 化：自定义 setFundTypeOutbound 字面值生效（零硬编码验证）', () => {
    const cfg = { config: { bankChannel: 'DBS', dispatchChannelValue: 'DBS', setFundTypeCharge: 'Charge', setFundTypeOutbound: 'OUT-X' } };
    const bank = bankRow({ rowId: 'b1', merchantId: 'C1', currency: 'USD', credit: 0, debit: 100, fundType: 'Charge', reconId: 'RC-1' });
    const gw = gwRow({ reconId: 'RC-1', amount: 100, currency: 'USD' });
    const { modifications } = runDbsChargeFundCheck([gw], [bank], [], cfg);
    const ftMod = findMod(modifications, 'b1', 'FundType');
    assert.ok(ftMod);
    assert.equal(ftMod.newValue, 'OUT-X');
    assert.equal(bank.FundType, 'OUT-X');
  });
});
