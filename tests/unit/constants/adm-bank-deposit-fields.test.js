// v2.1.16-beta.5 需求3/5（PR-1）：ADM 跨表字段映射常量「单一真相」守护单测。
//   🔴 R-1/R-3 资金红线：字段名大小写 + Type 超长缺括号列索引一旦失配，引擎会写错列污染资金对账。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHANNEL_VALUE,
  ADM_FUND_TYPES,
  ADM_EXTRA_FIELDS,
  ADM_MERCHANT_ID,
  FIELD_MAP
} = require('../../../src/constants/adm-bank-deposit-fields');
const { GATEWAY_BILL_FIELDS } = require('../../../src/constants/gateway-bill-recon-fields');

test.describe('adm-bank-deposit-fields 常量（v2.1.16-beta.5 PR-1）', () => {
  test('CHANNEL_VALUE / ADM_MERCHANT_ID 锚定值', () => {
    assert.equal(CHANNEL_VALUE, 'ADM');
    assert.equal(ADM_MERCHANT_ID, '6300156616');
  });

  test('ADM_FUND_TYPES 精确字面值（含 &FX 后缀，大小写敏感）', () => {
    assert.deepEqual(ADM_FUND_TYPES, ['Fundtransfer-out', 'Fundtransfer-out&FX']);
  });

  test('ADM_EXTRA_FIELDS = 6 新字段（顺序 + 字面值）', () => {
    assert.deepEqual(ADM_EXTRA_FIELDS, [
      '批次号', '调拨号', 'Fundtransfer-in金额', '资金对账ID', '是否与渠道账单匹配', '是否与网关账单匹配'
    ]);
    assert.equal(ADM_EXTRA_FIELDS.length, 6);
  });

  test('FIELD_MAP 跨表字段名大小写显式（防同名误用）', () => {
    // 商户号三态：渠道小写 m / 网关驼峰 M
    assert.equal(FIELD_MAP.chMerchantId, 'merchantId');
    assert.equal(FIELD_MAP.gwMerchantId, 'MerchantId');
    // 对账ID：渠道/网关同名 reconciliationId（小写 r）；ADM 表中文「资金对账ID」
    assert.equal(FIELD_MAP.chReconId, 'reconciliationId');
    assert.equal(FIELD_MAP.admReconFundId, '资金对账ID');
    // 金额四态
    assert.equal(FIELD_MAP.chReceiveAmount, 'receiveAmount');
    assert.equal(FIELD_MAP.midReceiveAmount, '收款金额');
    assert.equal(FIELD_MAP.admFundtransferInAmount, 'Fundtransfer-in金额');
    // 订单/调拨号
    assert.equal(FIELD_MAP.gwOrderId, 'OrderId');
    assert.equal(FIELD_MAP.midAllocationNo, '调拨单号');
    assert.equal(FIELD_MAP.admAllocationNo, '调拨号');
    // 客户参考 / 渠道流水号（唯一匹配两侧）
    assert.equal(FIELD_MAP.admCustomerRef, 'CustomerRef');
    assert.equal(FIELD_MAP.midChannelSerial, '渠道流水号');
  });

  test('🔴 gwTypeIndex 指向 GATEWAY_BILL_FIELDS Type 超长缺括号列（R-1/R-3 护栏）', () => {
    assert.equal(FIELD_MAP.gwTypeIndex, 8);
    const typeCol = GATEWAY_BILL_FIELDS[FIELD_MAP.gwTypeIndex];
    assert.equal(typeCol, 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', 'Type 列 byte-for-byte 一致（缺右括号）');
  });
});
