// v2.1.16-beta.4 ③ 退款回填跨表常量单测（🔴 资金红线 —— 防常量漂移）
// PRD-中台退款订单回填-v2.1.16-beta.3 §5.1.5/§5.2/§5.5/§九；TECH §3.3.1
//
// 覆盖：
//   ① REFUND_BANK_COLUMNS 9 列全部 ∈ BANK_STATEMENT_FIELDS（防漂移）
//   ② 9 列含 Debit Amount、不含 Credit Amount（✅Q4：金额列只放 Debit Amount）
//   ③ REFUND_TEMPLATE_HEADERS 14 列顺序（A~E 固定 + F~N = REFUND_BANK_COLUMNS）
//   ④ 常量 Object.freeze（含嵌套）
//   ⑤ 提取参数 MTX_FEATURE / T54SWIC_FEATURE 值
//   ⑥ 字段映射常量关键映射值（唯一值/回填/S1~S4/JPM/筛选）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REFUND_BACKFILL_FIELD_MAP,
  REFUND_BANK_COLUMNS,
  REFUND_TEMPLATE_HEADERS,
  MTX_FEATURE,
  T54SWIC_FEATURE
} = require('../../../src/constants/refund-backfill-fields');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');

test.describe('REFUND_BANK_COLUMNS — F 起银行 9 字段', () => {
  test('恰好 9 列', () => {
    assert.equal(REFUND_BANK_COLUMNS.length, 9);
  });

  test('9 列全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移）', () => {
    const bankSet = new Set(BANK_STATEMENT_FIELDS);
    for (const f of REFUND_BANK_COLUMNS) {
      assert.ok(bankSet.has(f), `${f} 不在 BANK_STATEMENT_FIELDS 中`);
    }
  });

  test('含 Debit Amount，不含 Credit Amount（✅Q4：金额列只放 Debit Amount）', () => {
    assert.ok(REFUND_BANK_COLUMNS.includes('Debit Amount'), '必须含 Debit Amount');
    assert.ok(!REFUND_BANK_COLUMNS.includes('Credit Amount'), '🔴 绝不能含 Credit Amount');
  });

  test('精确顺序 = BillDate/Channel/地区/MerchantId/Currency/Debit Amount/ReconciliationId/ChannelOrderNo/CustomerRef', () => {
    assert.deepEqual(REFUND_BANK_COLUMNS, [
      'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
      'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef'
    ]);
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(REFUND_BANK_COLUMNS));
  });
});

test.describe('REFUND_TEMPLATE_HEADERS — sheet1 14 列', () => {
  test('恰好 14 列', () => {
    assert.equal(REFUND_TEMPLATE_HEADERS.length, 14);
  });

  test('A~E 固定列顺序：退款单号/状态/渠道流水号/渠道退款时间/匹配命中详情', () => {
    assert.deepEqual(REFUND_TEMPLATE_HEADERS.slice(0, 5), [
      '退款单号', '状态', '渠道流水号', '渠道退款时间', '匹配命中详情'
    ]);
  });

  test('F~N（第 6 列起）= REFUND_BANK_COLUMNS', () => {
    assert.deepEqual(REFUND_TEMPLATE_HEADERS.slice(5), [...REFUND_BANK_COLUMNS]);
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(REFUND_TEMPLATE_HEADERS));
  });

  test('列名无重复', () => {
    const set = new Set(REFUND_TEMPLATE_HEADERS);
    assert.equal(set.size, REFUND_TEMPLATE_HEADERS.length);
  });
});

test.describe('REFUND_BACKFILL_FIELD_MAP — 跨表映射单一真相', () => {
  test('Object.freeze 锁死（含嵌套 uniqueKey/backfill/s1/s2/s4/jpm/filter）', () => {
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.uniqueKey));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.backfill));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s1));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s2));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s3));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s4));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.jpm));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.filter));
  });

  test('唯一值映射（✅Q1）：bankAccount=MerchantId / roAccount=银行大账号 / roAmount=退款金额', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.uniqueKey.bankAccount, 'MerchantId');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.uniqueKey.roAccount, '银行大账号');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.uniqueKey.bankCurrency, 'Currency');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.uniqueKey.roCurrency, '币种');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.uniqueKey.roAmount, '退款金额');
  });

  test('回填动作映射（§5.1.3）', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.backfill.fromBankReconId, 'ReconciliationId');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.backfill.fromBankBillDate, 'BillDate');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.backfill.fromRoSerialNo, '流水号');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.backfill.statusSuccess, 'SUCCESS');
  });

  test('S1：roKey=银行打款流水号，bankFields=[ChannelOrderNo, CustomerRef]', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s1.roKey, '银行打款流水号');
    assert.deepEqual([...REFUND_BACKFILL_FIELD_MAP.s1.bankFields], ['ChannelOrderNo', 'CustomerRef']);
  });

  test('S2：bankExtract=Extra Information，roField=附言', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s2.bankExtract, 'Extra Information');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s2.roField, '附言');
  });

  test('S3 按位映射（✅Q8b）：付款人名称↔Drawee Name / 付款卡号↔Drawee CardNo / 虚拟卡号↔Payee CardNo', () => {
    assert.deepEqual(
      REFUND_BACKFILL_FIELD_MAP.s3.map((p) => [p.roKey, p.bankField]),
      [['付款人名称', 'Drawee Name'], ['付款卡号', 'Drawee CardNo'], ['虚拟卡号', 'Payee CardNo']]
    );
  });

  test('S4：bankDate=BillDate / roDate=valueDate / toleranceDays=10', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.bankDate, 'BillDate');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.roDate, 'valueDate');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.toleranceDays, 10);
  });

  test('JPM 映射（✅Q7/Q8）：HK 单字段=银行打款流水号 / US 二跳键 OR + CustomerRef', () => {
    const jpm = REFUND_BACKFILL_FIELD_MAP.jpm;
    assert.equal(jpm.channelValue, 'JPM');
    assert.equal(jpm.regionField, '地区');
    assert.equal(jpm.hkRegion, 'HK');
    assert.equal(jpm.usRegion, 'US');
    assert.deepEqual([...jpm.hkCleanFields], ['Extra Information', 'Payment Detail']);
    assert.equal(jpm.hkRoKey, '银行打款流水号');
    assert.equal(jpm.usRoKey, '银行打款流水号');
    assert.deepEqual([...jpm.usDepositKeys], ['ReconciliationId', 'ChannelOrderNo']);
    assert.equal(jpm.usDepositTake, 'CustomerRef');
    assert.equal(jpm.usBankCompare, 'CustomerRef');
  });

  test('筛选映射（§5.1.2）：SUBMITTED / Ach Return', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.filter.roStatusField, '状态');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.filter.roSubmitted, 'SUBMITTED');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.filter.bankFundType, 'FundType');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.filter.achReturn, 'Ach Return');
  });
});

test.describe('提取参数', () => {
  test('MTX_FEATURE = {MTX, 19, 22} → /MTX\\d{19}/', () => {
    assert.deepEqual({ ...MTX_FEATURE }, { featureCode: 'MTX', digitCount: 19, totalLength: 22 });
    assert.ok(Object.isFrozen(MTX_FEATURE));
  });

  test('T54SWIC_FEATURE = {T54SWIC, 6, 13} → /T54SWIC\\d{6}/', () => {
    assert.deepEqual({ ...T54SWIC_FEATURE }, { featureCode: 'T54SWIC', digitCount: 6, totalLength: 13 });
    assert.ok(Object.isFrozen(T54SWIC_FEATURE));
  });
});
