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
  REFUND_RO_COLUMNS,
  REFUND_TEMPLATE_HEADERS,
  MTX_FEATURE,
  T54_REFUND_RE
} = require('../../../src/constants/refund-backfill-fields');
const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const { ZHONGTAI_REFUND_ORDER_SIGNATURE } = require('../../../src/constants/table-signatures');

test.describe('REFUND_BANK_COLUMNS — 银行 10 字段（O3：9→10 加 Payment Detail）', () => {
  test('恰好 10 列', () => {
    assert.equal(REFUND_BANK_COLUMNS.length, 10);
  });

  test('10 列全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移）', () => {
    const bankSet = new Set(BANK_STATEMENT_FIELDS);
    for (const f of REFUND_BANK_COLUMNS) {
      assert.ok(bankSet.has(f), `${f} 不在 BANK_STATEMENT_FIELDS 中`);
    }
  });

  test('含 Debit Amount，不含 Credit Amount（✅Q4：金额列只放 Debit Amount）', () => {
    assert.ok(REFUND_BANK_COLUMNS.includes('Debit Amount'), '必须含 Debit Amount');
    assert.ok(!REFUND_BANK_COLUMNS.includes('Credit Amount'), '🔴 绝不能含 Credit Amount');
  });

  test('O3：第 10 列为 Payment Detail，紧随 CustomerRef', () => {
    assert.equal(REFUND_BANK_COLUMNS[9], 'Payment Detail', '第 10 列应为 Payment Detail');
    assert.equal(REFUND_BANK_COLUMNS[8], 'CustomerRef', 'Payment Detail 应紧随 CustomerRef');
  });

  test('精确顺序 = BillDate/Channel/地区/MerchantId/Currency/Debit Amount/ReconciliationId/ChannelOrderNo/CustomerRef/Payment Detail', () => {
    assert.deepEqual(REFUND_BANK_COLUMNS, [
      'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
      'Debit Amount', 'ReconciliationId', 'ChannelOrderNo', 'CustomerRef', 'Payment Detail'
    ]);
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(REFUND_BANK_COLUMNS));
  });
});

test.describe('REFUND_RO_COLUMNS — 中台退款订单 15 字段（O4 新增）', () => {
  test('恰好 15 列', () => {
    assert.equal(REFUND_RO_COLUMNS.length, 15);
  });

  test('精确顺序（按用户列序）', () => {
    assert.deepEqual(REFUND_RO_COLUMNS, [
      '流水号', '加款单号', '渠道名称', '银行大账号', '虚拟卡号',
      '原加款金额', '退款金额', '币种', '付款人名称', '付款卡号',
      '附言', '客户号', '账户号', '银行打款流水号', 'valueDate'
    ]);
  });

  test('15 列全部 ∈ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders（防常量漂移）', () => {
    const sigSet = new Set(ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders);
    for (const f of REFUND_RO_COLUMNS) {
      assert.ok(sigSet.has(f), `${f} 不在中台退款订单 25 列签名中`);
    }
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(REFUND_RO_COLUMNS));
  });
});

test.describe('REFUND_TEMPLATE_HEADERS — sheet1 31 列（O1/O3/O4：14→31）', () => {
  test('恰好 31 列（6 + 10 + 15）', () => {
    assert.equal(REFUND_TEMPLATE_HEADERS.length, 31);
    assert.equal(6 + REFUND_BANK_COLUMNS.length + REFUND_RO_COLUMNS.length, 31);
  });

  test('A~F 固定列顺序：退款单号/状态/渠道流水号/渠道退款时间/命中类型/匹配命中详情（O1 加命中类型列）', () => {
    assert.deepEqual(REFUND_TEMPLATE_HEADERS.slice(0, 6), [
      '退款单号', '状态', '渠道流水号', '渠道退款时间', '命中类型', '匹配命中详情'
    ]);
  });

  test('E 列（第 5 列）= 命中类型；F 列（第 6 列）= 匹配命中详情', () => {
    assert.equal(REFUND_TEMPLATE_HEADERS[4], '命中类型');
    assert.equal(REFUND_TEMPLATE_HEADERS[5], '匹配命中详情');
  });

  test('第 7 列起 10 列 = REFUND_BANK_COLUMNS', () => {
    assert.deepEqual(REFUND_TEMPLATE_HEADERS.slice(6, 16), [...REFUND_BANK_COLUMNS]);
  });

  test('第 17 列起 15 列 = REFUND_RO_COLUMNS', () => {
    assert.deepEqual(REFUND_TEMPLATE_HEADERS.slice(16), [...REFUND_RO_COLUMNS]);
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(REFUND_TEMPLATE_HEADERS));
  });

  test('表头列名无重复（「流水号」≠「退款单号」，内容重复但表头互异）', () => {
    const set = new Set(REFUND_TEMPLATE_HEADERS);
    assert.equal(set.size, REFUND_TEMPLATE_HEADERS.length);
    // 显式：流水号 与 退款单号 同时存在且为两列
    assert.ok(REFUND_TEMPLATE_HEADERS.includes('流水号'));
    assert.ok(REFUND_TEMPLATE_HEADERS.includes('退款单号'));
  });
});

test.describe('REFUND_BACKFILL_FIELD_MAP — 跨表映射单一真相', () => {
  test('Object.freeze 锁死（含嵌套 uniqueKey/backfill/s1/s2/s2b/s3/s4/jpm/filter）', () => {
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.uniqueKey));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.backfill));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s1));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s2));
    assert.ok(Object.isFrozen(REFUND_BACKFILL_FIELD_MAP.s2b));
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

  test('S2b（R2 守卫，D6/D7）：memoFields / blacklist / minRefLength', () => {
    const s2b = REFUND_BACKFILL_FIELD_MAP.s2b;
    assert.deepEqual([...s2b.memoFields], ['Payment Detail', 'Extra Information']);
    assert.deepEqual([...s2b.blacklist], ['NOTPROVIDED', 'NONREF']);
    assert.equal(s2b.minRefLength, 6);
    assert.ok(Object.isFrozen(s2b));
    assert.ok(Object.isFrozen(s2b.memoFields));
    assert.ok(Object.isFrozen(s2b.blacklist));
  });

  test('S3 按位映射（✅Q8b）：付款人名称↔Drawee Name / 付款卡号↔Drawee CardNo / 虚拟卡号↔Payee CardNo', () => {
    assert.deepEqual(
      REFUND_BACKFILL_FIELD_MAP.s3.map((p) => [p.roKey, p.bankField]),
      [['付款人名称', 'Drawee Name'], ['付款卡号', 'Drawee CardNo'], ['虚拟卡号', 'Payee CardNo']]
    );
  });

  test('S4（R4）：bankDate=BillDate / roDate=valueDate / toleranceDays=21', () => {
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.bankDate, 'BillDate');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.roDate, 'valueDate');
    assert.equal(REFUND_BACKFILL_FIELD_MAP.s4.toleranceDays, 21);
  });

  test('S3b（R5）：draweeNameField / DESC DATE 正则 / depositDateField=ValueDate', () => {
    const s3b = REFUND_BACKFILL_FIELD_MAP.s3b;
    assert.equal(s3b.draweeNameField, 'Drawee Name');
    assert.deepEqual([...s3b.memoFields], ['Payment Detail', 'Extra Information']);
    assert.equal(s3b.datePattern.source, 'DESC\\s*DATE\\s*=\\s*(\\d{6})');
    assert.equal(s3b.depositDateField, 'ValueDate');
    assert.ok(Object.isFrozen(s3b));
  });

  test('S3c（R6）：DTD/FOR 正则 + currency=USD + 入金日期/金额/币种列', () => {
    const s3c = REFUND_BACKFILL_FIELD_MAP.s3c;
    assert.equal(s3c.datePattern.source, 'DTD\\s*(\\d{2}\\/\\d{2}\\/\\d{4})');
    assert.equal(s3c.amountPattern.source, 'FOR\\s*(?:USD|AMT)\\s*([0-9][0-9,]*(?:\\.\\d+)?)(?![\\d,.])'); // Fix#3 codex: 捕获千分位逗号金额
    assert.equal(s3c.currency, 'USD');
    assert.equal(s3c.depositDateField, 'ValueDate');
    assert.equal(s3c.depositAmountField, 'Credit Amount');
    assert.equal(s3c.depositCurrencyField, 'Currency');
    assert.ok(Object.isFrozen(s3c));
  });

  test('JPM 映射（✅Q7/Q8 + D8 中性命名）：HK 单字段=银行打款流水号 / 二跳键 OR + CustomerRef', () => {
    const jpm = REFUND_BACKFILL_FIELD_MAP.jpm;
    assert.equal(jpm.channelValue, 'JPM');
    assert.equal(jpm.regionField, '地区');
    assert.equal(jpm.hkRegion, 'HK');
    assert.equal(jpm.usRegion, 'US');
    assert.deepEqual([...jpm.hkCleanFields], ['Extra Information', 'Payment Detail']);
    assert.equal(jpm.hkRoKey, '银行打款流水号');
    assert.equal(jpm.usRoKey, '银行打款流水号');
    // D8：us 前缀名改中性名（HK R3 复用同一套二跳）
    assert.deepEqual([...jpm.depositKeys], ['ReconciliationId', 'ChannelOrderNo']);
    assert.equal(jpm.depositTake, 'CustomerRef');
    assert.equal(jpm.bankCompare, 'CustomerRef');
    // 旧名应已移除
    assert.equal(jpm.usDepositKeys, undefined);
    assert.equal(jpm.usDepositTake, undefined);
    assert.equal(jpm.usBankCompare, undefined);
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

  test('R1：T54_REFUND_RE 形态 = /T54[A-Z]{4}\\d{6}/g（替代旧 T54SWIC_FEATURE）', () => {
    assert.equal(T54_REFUND_RE.source, 'T54[A-Z]{4}\\d{6}');
    assert.ok(T54_REFUND_RE.global, '应为 global 正则（matchAll 用）');
  });

  test('R1：旧值 T54SWIC494867 仍被新正则匹配（存量零漏配 / 真子集）', () => {
    const re = new RegExp(T54_REFUND_RE.source, 'g');
    assert.deepEqual('xx T54SWIC494867 yy'.match(re), ['T54SWIC494867']);
  });

  test('R1：T54LCIC/T54CCBT 新前缀也命中（实测三前缀 SW/LC/CC）', () => {
    const re1 = new RegExp(T54_REFUND_RE.source, 'g');
    assert.deepEqual('//T54LCIC123456//'.match(re1), ['T54LCIC123456']);
    const re2 = new RegExp(T54_REFUND_RE.source, 'g');
    assert.deepEqual('T54CCBT654321 tail'.match(re2), ['T54CCBT654321']);
  });

  test('R1：T54 + 3 字母（位数不足）不匹配（形态严格 4 字母 6 数字）', () => {
    const re = new RegExp(T54_REFUND_RE.source, 'g');
    assert.equal('T54SWI494867'.match(re), null); // SWI = 3 字母 → 不命中
  });
});
