// v3.0.6 codex-pr74-fix P1（🔴🔴 资金红线）：builder ↔ DBS-Charge 引擎端到端联测（堵集成缺口）
//
// 背景（本测试存在的理由）：
//   需求1 builder（fund-transfer-recon-builder.buildFundTransferReconRows）按决策 D1 把一行中台调拨订单
//   派生成两行调拨对账单 —— in 行只填【收款渠道】（付款渠道留空）、out 行只填【付款渠道】（收款渠道留空）。
//   需求3 引擎（dbs-charge-fund-check.runDbsChargeFundCheck）步骤1 原门控要求「付款渠道===收款渠道===DBS」
//   （两列同时非空=DBS），但 builder 每行只有一列渠道非空 → 门控对真实派生行恒不成立 → dispRows 恒空 →
//   需求3 整体在真实数据上失效。原引擎单测用 helper 把两列都硬编码成 DBS，从不走真实 builder 输出，故抓不到。
//
//   本联测【用真实 builder 产物喂真实引擎】，正是能抓住该 P1 的端到端验证：
//   方向感知门控修复后 —— in 行判收款渠道===DBS、out 行判付款渠道===DBS（另一列留空不判）。
//
// 覆盖 4 种中台行渠道组合（付款渠道→收款渠道，即资金流向）：
//   ① DBS→DBS：付款渠道=DBS、收款渠道=DBS → in+out 两腿都含 DBS → 两腿都命中并标 FundTransfer-in/out。
//   ② DBS→外部(ICBC)：付款渠道=DBS、收款渠道=ICBC → 仅出腿（付款侧 DBS）命中标 FundTransfer-out；入腿不命中。
//   ③ 外部(ICBC)→DBS：付款渠道=ICBC、收款渠道=DBS → 仅入腿（收款侧 DBS）命中标 FundTransfer-in；出腿不命中。
//   ④ 外部→外部(ICBC→CITI)：付款渠道=ICBC、收款渠道=CITI → 两腿都不含 DBS → 完全不命中。
//
// 字段名一律经 FT_RECON_FIELD_MAP 常量取（与 builder / 引擎同一真相，含全角括号）；绝不手敲。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFundTransferReconRows } = require('../../../../src/main-process/fund-transfer-recon-builder');
const { runDbsChargeFundCheck } = require('../../../../src/main-process/scenario-engines/dbs-charge-fund-check');
const { FT_RECON_FIELD_MAP } = require('../../../../src/constants/fund-transfer-recon-fields');

const M = FT_RECON_FIELD_MAP.mid;   // 中台调拨订单源列（含全角括号）
const FT_IN = FT_RECON_FIELD_MAP.FUND_TYPE_IN;   // 'FundTransfer-in'
const FT_OUT = FT_RECON_FIELD_MAP.FUND_TYPE_OUT; // 'FundTransfer-out'

const OPTIONS = { config: { bankChannel: 'DBS', dispatchChannelValue: 'DBS', setFundTypeCharge: 'Charge', setFundTypeOutbound: 'outbound' } };

// 一行中台调拨订单（中文真实表头，字段名一律经常量取，含全角括号「付款账户（卡号）」「收款账户（卡号）」）。
//   付/收各字段刻意区分，便于断言方向取对侧。
function midRow(overrides = {}) {
  return Object.assign({
    [M.allocationNo]: 'AL1',
    [M.txTime]: '2026-06-10',
    [M.channelSerial]: 'SER1',     // 渠道流水号 → ReconID（in/out 两行同值）
    [M.payCard]: 'PAY-CARD',       // 付款账户（卡号）→ out 行 big_account
    [M.payeeCard]: 'RECV-CARD',    // 收款账户（卡号）→ in 行 big_account
    [M.receiveChannel]: 'DBS',     // 收款渠道 → in 行渠道（判 in 腿是否含 DBS）
    [M.receiveAmount]: '100.00',   // 收款金额 → in 行金额
    [M.receiveCurrency]: 'USD',    // 收款币种 → in 行币种
    [M.payChannel]: 'DBS',         // 付款渠道 → out 行渠道（判 out 腿是否含 DBS）
    [M.payAmount]: '90.00',        // 付款金额 → out 行金额
    [M.payCurrency]: 'USD'         // 付款币种 → out 行币种
  }, overrides);
}

// DBS 银行行（驼峰真实表头）。金额放 Debit 单边，匹配看 |credit-debit|。
function bankRow({ rowId, merchantId, currency = 'USD', amount, fundType = 'Inbound', reconId = '' }) {
  return {
    _rowId: rowId,
    Channel: 'DBS',
    MerchantId: merchantId,
    Currency: currency,
    'Credit Amount': 0,
    'Debit Amount': amount,
    FundType: fundType,
    ReconciliationId: reconId
  };
}

function findMod(mods, rowId, column) {
  return mods.find((m) => m.rowId === rowId && m.column === column);
}

test.describe('builder↔DBS-Charge 端到端联测（方向感知门控，🔴 抓 codex-pr74 P1）', () => {
  test('① DBS→DBS：真实 builder 派生 in+out 两腿都含 DBS → 两腿都命中并标 FundTransfer-in/out', () => {
    // 真实 builder 派生：in 行（收款渠道=DBS，big_account=RECV-CARD，金额 100）+ out 行（付款渠道=DBS，big_account=PAY-CARD，金额 90）。
    const { rows: dispRows } = buildFundTransferReconRows([midRow()]);
    // 前置自检：builder 输出每行确实只有一列渠道非空（in 付款渠道空 / out 收款渠道空）—— 正是 P1 的根因形状。
    const inDisp = dispRows.find((r) => r[FT_RECON_FIELD_MAP.recon.fundType] === FT_IN);
    const outDisp = dispRows.find((r) => r[FT_RECON_FIELD_MAP.recon.fundType] === FT_OUT);
    assert.equal(inDisp[FT_RECON_FIELD_MAP.recon.payChannel], '', 'builder in 行付款渠道留空（P1 根因形状）');
    assert.equal(inDisp[FT_RECON_FIELD_MAP.recon.receiveChannel], 'DBS');
    assert.equal(outDisp[FT_RECON_FIELD_MAP.recon.receiveChannel], '', 'builder out 行收款渠道留空（P1 根因形状）');
    assert.equal(outDisp[FT_RECON_FIELD_MAP.recon.payChannel], 'DBS');

    // 配套 DBS 银行行：bIn 对齐 in 腿（MerchantId=RECV-CARD、100）、bOut 对齐 out 腿（MerchantId=PAY-CARD、90）。
    const bIn = bankRow({ rowId: 'bIn', merchantId: 'RECV-CARD', amount: 100 });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'PAY-CARD', amount: 90 });

    const { modifications } = runDbsChargeFundCheck([], [bIn, bOut], dispRows, OPTIONS);

    // 🔴 两腿都命中（修复前 dispRows 恒空 → 此处零改动，断言全挂 → 正好抓住 P1）。
    assert.equal(bIn.ReconciliationId, 'SER1', 'in 腿命中赋 ReconciliationId');
    assert.equal(bIn.FundType, FT_IN, 'in 腿标 FundTransfer-in');
    assert.equal(bOut.ReconciliationId, 'SER1', 'out 腿命中赋 ReconciliationId');
    assert.equal(bOut.FundType, FT_OUT, 'out 腿标 FundTransfer-out');
    assert.ok(findMod(modifications, 'bIn', 'ReconciliationId'));
    assert.ok(findMod(modifications, 'bOut', 'ReconciliationId'));
    assert.ok(findMod(modifications, 'bIn', 'FundType'));
    assert.ok(findMod(modifications, 'bOut', 'FundType'));
  });

  test('② DBS→外部(ICBC)：付款渠道=DBS、收款渠道=ICBC → 仅出腿命中（标 FundTransfer-out）；入腿不命中', () => {
    // 资金流向 DBS→外部：付款侧=DBS（out 腿含 DBS）、收款侧=ICBC（in 腿不含 DBS）。
    const { rows: dispRows } = buildFundTransferReconRows([
      midRow({ [M.receiveChannel]: 'ICBC' }) // 收款渠道=ICBC（in 腿渠道）；付款渠道仍 DBS（out 腿渠道）
    ]);
    const bIn = bankRow({ rowId: 'bIn', merchantId: 'RECV-CARD', amount: 100, fundType: 'Inbound' });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'PAY-CARD', amount: 90, fundType: 'Outbound' });

    const { modifications } = runDbsChargeFundCheck([], [bIn, bOut], dispRows, OPTIONS);

    // 出腿命中（付款渠道=DBS）。
    assert.equal(bOut.ReconciliationId, 'SER1', '出腿命中赋 ReconciliationId');
    assert.equal(bOut.FundType, FT_OUT, '出腿标 FundTransfer-out');
    // 入腿不命中（收款渠道=ICBC，in 腿不进 dispRows）—— 即便 bIn 金额/卡号都齐，也不应被赋值/改写。
    assert.equal(bIn.ReconciliationId, '', '入腿不命中（收款渠道≠DBS）→ ReconciliationId 不赋');
    assert.equal(bIn.FundType, 'Inbound', '入腿不命中 → FundType 不动');
    assert.equal(findMod(modifications, 'bIn', 'ReconciliationId'), undefined);
    assert.equal(findMod(modifications, 'bIn', 'FundType'), undefined);
  });

  test('③ 外部(ICBC)→DBS：付款渠道=ICBC、收款渠道=DBS → 仅入腿命中（标 FundTransfer-in）；出腿不命中', () => {
    // 资金流向 外部→DBS：付款侧=ICBC（out 腿不含 DBS）、收款侧=DBS（in 腿含 DBS）。
    const { rows: dispRows } = buildFundTransferReconRows([
      midRow({ [M.payChannel]: 'ICBC' }) // 付款渠道=ICBC（out 腿渠道）；收款渠道仍 DBS（in 腿渠道）
    ]);
    const bIn = bankRow({ rowId: 'bIn', merchantId: 'RECV-CARD', amount: 100, fundType: 'Inbound' });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'PAY-CARD', amount: 90, fundType: 'Outbound' });

    const { modifications } = runDbsChargeFundCheck([], [bIn, bOut], dispRows, OPTIONS);

    // 入腿命中（收款渠道=DBS）。
    assert.equal(bIn.ReconciliationId, 'SER1', '入腿命中赋 ReconciliationId');
    assert.equal(bIn.FundType, FT_IN, '入腿标 FundTransfer-in');
    // 出腿不命中（付款渠道=ICBC，out 腿不进 dispRows）。
    assert.equal(bOut.ReconciliationId, '', '出腿不命中（付款渠道≠DBS）→ ReconciliationId 不赋');
    assert.equal(bOut.FundType, 'Outbound', '出腿不命中 → FundType 不动');
    assert.equal(findMod(modifications, 'bOut', 'ReconciliationId'), undefined);
    assert.equal(findMod(modifications, 'bOut', 'FundType'), undefined);
  });

  test('④ 外部→外部(ICBC→CITI)：付款渠道=ICBC、收款渠道=CITI → 两腿都不含 DBS → 完全不命中（零改动）', () => {
    const { rows: dispRows } = buildFundTransferReconRows([
      midRow({ [M.payChannel]: 'ICBC', [M.receiveChannel]: 'CITI' })
    ]);
    const bIn = bankRow({ rowId: 'bIn', merchantId: 'RECV-CARD', amount: 100, fundType: 'Inbound' });
    const bOut = bankRow({ rowId: 'bOut', merchantId: 'PAY-CARD', amount: 90, fundType: 'Outbound' });

    const { modifications } = runDbsChargeFundCheck([], [bIn, bOut], dispRows, OPTIONS);

    assert.equal(modifications.length, 0, '两腿都不含 DBS → 完全不命中、零改动');
    assert.equal(bIn.ReconciliationId, '');
    assert.equal(bOut.ReconciliationId, '');
    assert.equal(bIn.FundType, 'Inbound');
    assert.equal(bOut.FundType, 'Outbound');
  });

  test('混合四单一把跑：各组合命中范围互不串台（DBS→DBS 两腿 / DBS→外部 仅出 / 外部→DBS 仅入 / 外部→外部 全不）', () => {
    // 四单各用独立卡号 + 独立渠道流水号（ReconID），构造各自的 in/out 两腿与配套 DBS 银行行，一次性喂引擎。
    const mids = [
      // ① DBS→DBS
      midRow({ [M.channelSerial]: 'S1', [M.payCard]: 'P1', [M.payeeCard]: 'R1', [M.payChannel]: 'DBS', [M.receiveChannel]: 'DBS' }),
      // ② DBS→外部
      midRow({ [M.channelSerial]: 'S2', [M.payCard]: 'P2', [M.payeeCard]: 'R2', [M.payChannel]: 'DBS', [M.receiveChannel]: 'ICBC' }),
      // ③ 外部→DBS
      midRow({ [M.channelSerial]: 'S3', [M.payCard]: 'P3', [M.payeeCard]: 'R3', [M.payChannel]: 'ICBC', [M.receiveChannel]: 'DBS' }),
      // ④ 外部→外部
      midRow({ [M.channelSerial]: 'S4', [M.payCard]: 'P4', [M.payeeCard]: 'R4', [M.payChannel]: 'ICBC', [M.receiveChannel]: 'CITI' })
    ];
    const { rows: dispRows } = buildFundTransferReconRows(mids);

    // 每单两条配套 DBS 银行行（in 腿 MerchantId=收款卡号、金额 100；out 腿 MerchantId=付款卡号、金额 90）。
    const banks = [];
    for (const n of [1, 2, 3, 4]) {
      banks.push(bankRow({ rowId: `in${n}`, merchantId: `R${n}`, amount: 100, fundType: 'Inbound' }));
      banks.push(bankRow({ rowId: `out${n}`, merchantId: `P${n}`, amount: 90, fundType: 'Outbound' }));
    }

    runDbsChargeFundCheck([], banks, dispRows, OPTIONS);

    const byId = Object.fromEntries(banks.map((b) => [b._rowId, b]));
    // ① DBS→DBS：两腿都命中。
    assert.equal(byId.in1.FundType, FT_IN, '① in 腿标 FundTransfer-in');
    assert.equal(byId.in1.ReconciliationId, 'S1');
    assert.equal(byId.out1.FundType, FT_OUT, '① out 腿标 FundTransfer-out');
    assert.equal(byId.out1.ReconciliationId, 'S1');
    // ② DBS→外部：仅出腿命中。
    assert.equal(byId.in2.FundType, 'Inbound', '② 入腿不命中（收款 ICBC）');
    assert.equal(byId.in2.ReconciliationId, '');
    assert.equal(byId.out2.FundType, FT_OUT, '② 出腿命中（付款 DBS）');
    assert.equal(byId.out2.ReconciliationId, 'S2');
    // ③ 外部→DBS：仅入腿命中。
    assert.equal(byId.in3.FundType, FT_IN, '③ 入腿命中（收款 DBS）');
    assert.equal(byId.in3.ReconciliationId, 'S3');
    assert.equal(byId.out3.FundType, 'Outbound', '③ 出腿不命中（付款 ICBC）');
    assert.equal(byId.out3.ReconciliationId, '');
    // ④ 外部→外部：全不命中。
    assert.equal(byId.in4.FundType, 'Inbound', '④ 入腿不命中');
    assert.equal(byId.in4.ReconciliationId, '');
    assert.equal(byId.out4.FundType, 'Outbound', '④ 出腿不命中');
    assert.equal(byId.out4.ReconciliationId, '');
  });
});
