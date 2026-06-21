// 资金红线·方向不敏感单测：锁定 R3.5 DBS-Charge 资金校验「不校验银行单借贷方向」的设计不变量。
//   设计前提（用户拍板）：银行单的 Credit/Debit 出入方向本身可能录错（如把一笔付款错录成收款），
//   故 R3.5 匹配走金额绝对值 |Credit-Debit|，真实方向以对手方「调拨对账单」fund_type 为准
//   （dbs-charge-fund-check.js:30,228 注释「大账号方向已在需求1派生固化，引擎零方向分支」）。
//   ⚠️ 本测试是「活文档」：若有人给链路加「FundType 必须与 Credit/Debit 方向一致」的校验，
//      下面用例会变红 —— 提醒：那会把银行端错误方向当成真理、拒绝本应被纠正的行，是资金 bug。
//
// 运行：node --test tests/unit/dbs-charge-fund-check-direction.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runDbsChargeFundCheck
} = require('../../src/main-process/scenario-engines/dbs-charge-fund-check');

// 最小字段银行行（真实驼峰表头；与 dbs-charge-fund-check-symmetry.test.js 同范式）
function bankRow(rowId, overrides = {}) {
  return {
    _rowId: rowId,
    Channel: 'DBS',
    MerchantId: 'NET001',
    Currency: 'USD',
    'Credit Amount': '',
    'Debit Amount': '',
    FundType: '',
    ReconciliationId: '',
    ...overrides
  };
}

// 调拨对账单派生行（字段经 FT_RECON_FIELD_MAP.recon.* 实际值）
function dispRow(overrides = {}) {
  return {
    付款渠道: '',
    收款渠道: '',
    big_account: 'NET001',
    币种: 'USD',
    金额: 0,
    ReconID: '',
    fund_type: '',
    ...overrides
  };
}

test('方向不敏感·out：Credit(银行录反) 与 Debit(方向正确) 被同一 FundTransfer-out 调拨纠正为相同 FundType', () => {
  // out 方向门控判「付款渠道===DBS」(dbs-charge-fund-check.js:208-209)
  const disp = [dispRow({ 付款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-OUT', fund_type: 'FundTransfer-out' })];

  // A：方向录反 —— 银行把这笔出金错录成 Credit 入金
  const aRows = [bankRow('a', { 'Credit Amount': 100 })];
  const aRes = runDbsChargeFundCheck([], aRows, disp);
  assert.equal(aRows[0].FundType, 'FundTransfer-out'); // 被对手方纠正，不因「Credit 却标 out」拒绝
  assert.equal(aRows[0].ReconciliationId, 'RID-OUT');
  assert.equal(aRes.warnings.length, 0); // 无方向矛盾类告警

  // B：方向本来就对 —— Debit 出金
  const bRows = [bankRow('b', { 'Debit Amount': 100 })];
  runDbsChargeFundCheck([], bRows, disp);

  // 灵魂断言：A===B → 结果只取决于对手方，与银行借贷方向无关
  assert.equal(aRows[0].FundType, bRows[0].FundType);
});

test('方向不敏感·in：Debit(银行录反) 被 FundTransfer-in 调拨纠正为 in', () => {
  // in 方向门控判「收款渠道===DBS」(dbs-charge-fund-check.js:205-206)
  const disp = [dispRow({ 收款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-IN', fund_type: 'FundTransfer-in' })];

  // 银行把这笔入金错录成 Debit 出金 —— 仍应被纠正为 FundTransfer-in
  const rows = [bankRow('a', { 'Debit Amount': 100 })];
  runDbsChargeFundCheck([], rows, disp);
  assert.equal(rows[0].FundType, 'FundTransfer-in');
  assert.equal(rows[0].ReconciliationId, 'RID-IN');
});

test('绝对值命中是纠正前提：金额对不上的录反行不被纠正（modifications 不含它）', () => {
  const disp = [dispRow({ 付款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-OUT', fund_type: 'FundTransfer-out' })];

  // 录反方向(Credit) 但金额 99 ≠ 100 → 绝对值不命中 → 不改写、不留痕
  const rows = [bankRow('a', { 'Credit Amount': 99 })];
  const res = runDbsChargeFundCheck([], rows, disp);
  assert.equal(rows[0].FundType, ''); // 保持原值，未被纠正
  assert.equal(res.modifications.length, 0);
});
