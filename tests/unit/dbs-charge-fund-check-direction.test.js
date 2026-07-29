// v3.1.1 资金红线：R3.5 Step1 必须把调拨 fund_type 映射为真实银行借贷方向，
// 方向失败行只可进入 near-candidate 诊断，不能被选择、消费、保护或改写。
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
    BillDate: '2026-06-07',
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
    BillDate: '2026-06-07',
    ...overrides
  };
}

test('严格方向·out：Credit 录反行失败关闭，Debit 正确行才可被 FundTransfer-out 命中', () => {
  // out 方向门控判「付款渠道===DBS」(dbs-charge-fund-check.js:208-209)
  const disp = [dispRow({ 付款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-OUT', fund_type: 'FundTransfer-out' })];

  // A：方向录反 —— 银行把这笔出金错录成 Credit 入金，不能写入/消费
  const aRows = [bankRow('a', { 'Credit Amount': 100 })];
  const aRes = runDbsChargeFundCheck([], aRows, disp);
  assert.equal(aRows[0].FundType, '');
  assert.equal(aRows[0].ReconciliationId, '');
  assert.equal(aRes.modifications.length, 0);
  assert.equal(aRes.warnings.length, 1);
  assert.equal(aRes.warnings[0].code, 'fund-transfer-direction-mismatch');
  assert.equal(aRes.warnings[0].rowId, 'a');
  assert.equal(aRes.warnings[0].expectedDirection, 'DEBIT');
  assert.equal(aRes.warnings[0].reason, 'expected-empty');

  // B：方向本来就对 —— Debit 出金
  const bRows = [bankRow('b', { 'Debit Amount': 100 })];
  const bRes = runDbsChargeFundCheck([], bRows, disp);
  assert.equal(bRows[0].FundType, 'FundTransfer-out');
  assert.equal(bRows[0].ReconciliationId, 'RID-OUT');
  assert.equal(bRes.warnings.length, 0);
});

test('严格方向·in：Debit 录反行不能被 FundTransfer-in 命中', () => {
  // in 方向门控判「收款渠道===DBS」(dbs-charge-fund-check.js:205-206)
  const disp = [dispRow({ 收款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-IN', fund_type: 'FundTransfer-in' })];

  // 银行把这笔入金错录成 Debit 出金 —— 失败关闭
  const rows = [bankRow('a', { 'Debit Amount': 100 })];
  const result = runDbsChargeFundCheck([], rows, disp);
  assert.equal(rows[0].FundType, '');
  assert.equal(rows[0].ReconciliationId, '');
  assert.equal(result.modifications.length, 0);
  assert.equal(result.warnings[0].expectedDirection, 'CREDIT');
  assert.equal(result.warnings[0].reason, 'expected-empty');
});

test('只有账号/币种/金额已近似匹配才产生方向告警，金额不等不制造全表噪声', () => {
  const disp = [dispRow({ 付款渠道: 'DBS', big_account: 'NET001', 币种: 'USD', 金额: 100, ReconID: 'RID-OUT', fund_type: 'FundTransfer-out' })];

  // 录反方向(Credit) 但金额 99 ≠ 100 → 绝对值不命中 → 不改写、不留痕
  const rows = [bankRow('a', { 'Credit Amount': 99 })];
  const res = runDbsChargeFundCheck([], rows, disp);
  assert.equal(rows[0].FundType, '');
  assert.equal(res.modifications.length, 0);
  assert.equal(res.warnings.length, 0);
});
