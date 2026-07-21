// v2.1.16-beta.4 ③ R5 场景4「中台退款订单回填」引擎单测（🔴 资金红线）
// PRD-中台退款订单回填-v2.1.16-beta.3 §5.1~§5.5 + §九（决策矩阵 16 格 = 验收基线）
// TECH §3.3
//
// 覆盖：
//   ① 数据筛选：非 SUBMITTED 剔除 / 非 Ach Return 剔除 / isFundTypeChanged 剔除
//   ② 16 格矩阵逐格（基数1~4 × S1~S4，命中/报错/提示三态）
//   ③ JPM-HK（清洗 // → 提 T54SWIC → 单字段等值「银行打款流水号」）
//   ④ JPM-US（二跳 OR ReconId/ChannelOrderNo → CustomerRef 比对 + 入金表两句式详情）
//   ⑤ 1v1 双向消费（bank/refund 各只用一次）
//   ⑥ 命中详情两句式文案
//   ⑦ 空入参防御
//   ⑧ 回填行结构（E 列详情 + F~N 9 字段、含 Debit 不含 Credit）
//   ⑪b R4 AchReturn matchedPairs 前置过滤（包含同值 no-op，按具体对象身份）

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../src/main-process/scenario-engines/r5-refund-order-backfill');
const {
  runRound5RefundOrderBackfill,
  classifyCardinality,
  bankAmountAbs,
  extractFeature,
  matchS1,
  matchS3,
  resolveHits,
  RESULT_ERROR,
  RESULT_NOTICE,
  HIT_TYPE_PRECISE,
  HIT_TYPE_FUZZY,
  S4_DETAIL_TEXT
} = E;
const { MTX_FEATURE, T54_REFUND_RE, REFUND_TEMPLATE_HEADERS } = require('../../../../src/constants/refund-backfill-fields');
const { buildFeatureRegex } = require('../../../../src/main-process/scenario-engines/c1-extract-recon-id');

const MTX_RE = buildFeatureRegex(MTX_FEATURE);
const T54_RE = T54_REFUND_RE; // R1：直写正则常量（替代旧 buildFeatureRegex(T54SWIC_FEATURE)）

// ---- 夹具 --------------------------------------------------------------

// 银行行（驼峰）。默认值令唯一值键 = M1||USD||10000 分；Debit 100。
let bankSeq = 0;
function bank(overrides = {}) {
  return {
    _rowId: overrides._rowId || `b${bankSeq++}`,
    FundType: 'Ach Return',
    MerchantId: 'M1',
    Currency: 'USD',
    'Credit Amount': 0,
    'Debit Amount': 100,
    Channel: 'CH',
    '地区': 'HK',
    BillDate: '2026-06-01',
    ReconciliationId: 'RECON-1',
    ChannelOrderNo: '',
    CustomerRef: '',
    'Extra Information': '',
    'Payment Detail': '',
    'Drawee Name': '',
    'Drawee CardNo': '',
    'Payee CardNo': '',
    ...overrides
  };
}

// refund order 行（中文）。默认令唯一值键 = M1||USD||10000 分（退款金额 100）。
function refund(overrides = {}) {
  return {
    '流水号': 'SN-1',
    '状态': 'SUBMITTED',
    '银行大账号': 'M1',
    '币种': 'USD',
    '退款金额': 100,
    '银行打款流水号': '',
    '附言': '',
    '付款人名称': '',
    '付款卡号': '',
    '虚拟卡号': '',
    'valueDate': '2026-06-01',
    ...overrides
  };
}

// 入金表行（驼峰，JPM-US）
function deposit(overrides = {}) {
  return {
    ReconciliationId: '',
    ChannelOrderNo: '',
    CustomerRef: '',
    ...overrides
  };
}

function run(bankRows, refundRows, depositRows, options) {
  return runRound5RefundOrderBackfill(bankRows, refundRows, depositRows || [], options || {});
}

// ======================================================================
// ① 数据筛选
// ======================================================================
test.describe('① 数据筛选', () => {
  test('refund 非 SUBMITTED 被剔除（不进池 → 无对账）', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'C1' })];
    const r = [refund({ '状态': 'SUCCESS', '银行打款流水号': 'C1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    // bank 侧无任何 refund 候选 → 不入分组（refundGroup 为空，该组 continue）
    assert.equal(res.unmatchedRows.length, 0);
  });

  test('bank 非 Ach Return 被剔除', () => {
    const b = [bank({ _rowId: 'b1', FundType: 'Charge', ChannelOrderNo: 'C1' })];
    const r = [refund({ '银行打款流水号': 'C1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
  });

  test('isFundTypeChanged 命中的行被剔除（FundType 被 R4 改写）', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'C1' })];
    const r = [refund({ '银行打款流水号': 'C1' })];
    const res = run(b, r, [], { isFundTypeChanged: (id) => id === 'b1' });
    assert.equal(res.backfillRows.length, 0);
  });

  test('未被改写的 Ach Return 行正常参与', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'C1' })];
    const r = [refund({ '银行打款流水号': 'C1' })];
    const res = run(b, r, [], { isFundTypeChanged: (id) => id === 'bX' });
    assert.equal(res.backfillRows.length, 1);
  });
});

// ======================================================================
// ② 16 格矩阵：基数1（1:1）× S1~S4
// ======================================================================
test.describe('② 基数1（1:1）', () => {
  test('S1 命中 ChannelOrderNo → 回填', () => {
    const res = run([bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.unmatchedRows.length, 0);
  });

  test('S1 命中 CustomerRef → 回填（被查第二字段）', () => {
    const res = run([bank({ _rowId: 'b1', CustomerRef: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.equal(res.backfillRows.length, 1);
  });

  test('S2 命中（MTX 附言包含）→ 回填，S1 不命中时进 S2', () => {
    const mtx = 'MTX1234567890123456789';
    const res = run(
      [bank({ _rowId: 'b1', Channel: 'CH', 'Extra Information': `付款 ${mtx} 备注` })],
      [refund({ '附言': `本笔 ${mtx} 退款` })]
    );
    assert.equal(res.backfillRows.length, 1);
    assert.match(res.backfillRows[0]['匹配命中详情'], /Extra Information.*附言/);
  });

  test('S3 命中（付款人名称↔Drawee Name 按位）→ 回填', () => {
    const res = run(
      [bank({ _rowId: 'b1', 'Drawee Name': '张三' })],
      [refund({ '付款人名称': '张三' })]
    );
    assert.equal(res.backfillRows.length, 1);
    assert.match(res.backfillRows[0]['匹配命中详情'], /Drawee Name.*付款人名称/);
  });

  test('S4 命中（R4 单向窗内：0≤BillDate−valueDate≤21）→ 回填（无任何 S1~S3 关联兜底）', () => {
    const res = run(
      [bank({ _rowId: 'b1', BillDate: '2026-06-05' })],
      [refund({ 'valueDate': '2026-06-01' })] // diff +4 天（bank 晚于 valueDate）
    );
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.unmatchedRows.length, 0);
  });

  test('S4 差 >21 天 → 报错人工介入（R4 容差 21）', () => {
    const res = run(
      [bank({ _rowId: 'b1', BillDate: '2026-06-25' })],
      [refund({ 'valueDate': '2026-06-01' })] // diff +24 天 >21
    );
    assert.equal(res.backfillRows.length, 0);
    const err = res.unmatchedRows.find((x) => x['结果类型'] === RESULT_ERROR);
    assert.ok(err, '应有报错-人工介入行');
  });
});

// ======================================================================
// ② 16 格矩阵：基数2（1:N）银行 1 + refund N
// ======================================================================
test.describe('② 基数2（1:N）', () => {
  test('S1 银行打款流水号只一笔命中 → 回填（v3.0.10：同组未消费 refund 不再产 notice）', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'OTHER' })
    ];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    // v3.0.10 需求3.2：SN-B 同组未消费 refund 不再产「未匹配-提示」notice 行（完全静默删除 per-group 收尾循环）。
    const notice = res.unmatchedRows.find((x) => x['退款单号'] === 'SN-B');
    assert.ok(!notice, 'v3.0.10：SN-B 不再产 notice（refund-only 静默）');
  });

  test('S1 多笔 refund 同时命中同一 bank → 报错人工介入（关联到多笔）', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY1' })
    ];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    const err = res.unmatchedRows.find((x) => x['结果类型'] === RESULT_ERROR);
    assert.ok(err, '关联到 2 笔 → 报错');
  });

  test('S3 多笔 refund 命中 → 报错（✅Q9：多笔报错、一笔回填）', () => {
    const b = [bank({ _rowId: 'b1', 'Drawee Name': '张三' })];
    const r = [
      refund({ '流水号': 'SN-A', '付款人名称': '张三' }),
      refund({ '流水号': 'SN-B', '付款人名称': '张三' })
    ];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    assert.ok(res.unmatchedRows.some((x) => x['结果类型'] === RESULT_ERROR));
  });
});

// ======================================================================
// ② 16 格矩阵：基数3（N:1）银行 N + refund 1
// ======================================================================
test.describe('② 基数3（N:1）', () => {
  test('S1 仅一条银行行关联到 → 回填，另一条银行行提示', () => {
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'NOPE' })
    ];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    // b2 关联不到 → 提示
    assert.ok(res.unmatchedRows.some((x) => x['结果类型'] === RESULT_NOTICE));
  });

  test('S4 N:1 按 BillDate 早→晚取最近回填，多出银行行提示', () => {
    const b = [
      bank({ _rowId: 'bLate', BillDate: '2026-06-10' }),
      bank({ _rowId: 'bEarly', BillDate: '2026-06-02' })
    ];
    const r = [refund({ '流水号': 'SN-A', 'valueDate': '2026-06-01' })]; // 离 bEarly 1 天、离 bLate 9 天
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    // 早→晚：bEarly（差1天）先匹配并消费 refund；bLate 无 refund 可用 → 提示
    assert.match(res.backfillRows[0]['渠道流水号'], /RECON/);
    assert.ok(res.unmatchedRows.length >= 1);
  });
});

// ======================================================================
// ② 16 格矩阵：基数4（N:N）银行 N + refund N
// ======================================================================
test.describe('② 基数4（N:N）', () => {
  test('S1 各自唯一命中 → 两条回填（banks 1v1）', () => {
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY2' })
    ];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY2' })
    ];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 2);
    const sn = res.backfillRows.map((x) => x['退款单号']).sort();
    assert.deepEqual(sn, ['SN-A', 'SN-B']);
  });

  test('S1 一条 bank 命中多笔 refund → 报错（关联到多笔）', () => {
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY2' })
    ];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY1' })
    ];
    const res = run(b, r);
    // b1 关联到 SN-A/SN-B 两笔 → 报错；b2 的 PAY2 关联不到
    assert.ok(res.unmatchedRows.some((x) => x['结果类型'] === RESULT_ERROR));
  });

  test('S4 N:N 条数相等按 BillDate 早→晚 1v1（✅Q10；R4 单向：bank 均晚于各自 valueDate）', () => {
    const b = [
      bank({ _rowId: 'bLate', BillDate: '2026-06-11' }),
      bank({ _rowId: 'bEarly', BillDate: '2026-06-02' })
    ];
    const r = [
      refund({ '流水号': 'SN-early', 'valueDate': '2026-06-01' }), // bEarly diff +1（窗内）；bLate diff +10
      refund({ '流水号': 'SN-late', 'valueDate': '2026-06-10' })   // bEarly diff -8（窗外）；bLate diff +1
    ];
    const res = run(b, r);
    // 早→晚：bEarly 先取窗内最近（仅 SN-early 窗内）→ SN-early；bLate 取剩余 SN-late（diff+1）
    assert.equal(res.backfillRows.length, 2);
    const byRecon = {};
    for (const row of res.backfillRows) byRecon[row['BillDate']] = row['退款单号'];
    assert.equal(byRecon['2026-06-02'], 'SN-early');
    assert.equal(byRecon['2026-06-11'], 'SN-late');
  });
});

// ======================================================================
// ③ JPM-HK
// ======================================================================
test.describe('③ JPM-HK', () => {
  test('清洗 // → 提 T54SWIC → 单字段等值「银行打款流水号」→ 回填', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      'Extra Information': '//T54SWIC494447//ABC'
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'T54SWIC494447' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    assert.match(res.backfillRows[0]['匹配命中详情'], /银行打款流水号/);
  });

  test('JPM-HK 脏形态 // 切断流水号清洗后拼回命中（T54SWI//C494447）', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      'Payment Detail': 'T54SWI//C494447 trailing'
    })];
    const r = [refund({ '银行打款流水号': 'T54SWIC494447' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
  });

  test('JPM-HK 未命中 → 回落常规 MTX（同 bank 行 Extra 含 MTX）', () => {
    const mtx = 'MTX1234567890123456789';
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      'Extra Information': `${mtx} 无 swic`
    })];
    const r = [refund({ '附言': `含 ${mtx}` })]; // 银行打款流水号空 → JPM-HK 不命中，回落 MTX
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
  });
});

// ======================================================================
// ④ JPM-US
// ======================================================================
test.describe('④ JPM-US', () => {
  test('二跳 OR（入金表 ReconciliationId==payNo）→ CustomerRef 比对 → 回填 + 入金表两句式详情', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-999'
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-999' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
    assert.match(res.backfillRows[0]['匹配命中详情'], /银行对账单入金表/);
    assert.match(res.backfillRows[0]['匹配命中详情'], /CustomerRef/);
  });

  test('二跳 OR（入金表 ChannelOrderNo==payNo）→ 回填（OR 第二支）', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-2' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-2' })];
    const dep = [deposit({ ChannelOrderNo: 'PAYNO-2', CustomerRef: 'CR-2' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
  });

  test('JPM-US CustomerRef 不等 → 不命中（回落 MTX，本例 MTX 也无 → 落 sheet2）', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-X' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-3', 'valueDate': '2030-01-01' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-3', CustomerRef: 'CR-DIFF' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0);
  });

  test('JPM-US 入金表无命中（payNo 找不到）→ 不命中', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-4' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-4', 'valueDate': '2030-01-01' })];
    const dep = [deposit({ ReconciliationId: 'OTHER', CustomerRef: 'CR-4' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0);
  });
});

// ======================================================================
// R1 JPM-HK 提取正则放宽（T54SWIC → T54[A-Z]{4}）
// ======================================================================
test.describe('R1：JPM-HK 三前缀 T54SWIC/T54LCIC/T54CCBT 各回放命中 + 旧值回归 + 收口', () => {
  function hkBank(extra) {
    return bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'HK', 'Extra Information': extra });
  }
  test('T54SWIC（旧前缀，回归）→ 命中', () => {
    const res = run([hkBank('//T54SWIC494447//')], [refund({ '银行打款流水号': 'T54SWIC494447' })]);
    assert.equal(res.backfillRows.length, 1);
  });
  test('T54LCIC（新前缀 LC）→ 命中（原 T54SWIC 锁死时会漏）', () => {
    const res = run([hkBank('//T54LCIC222333//')], [refund({ '银行打款流水号': 'T54LCIC222333' })]);
    assert.equal(res.backfillRows.length, 1);
  });
  test('T54CCBT（新前缀 CC）→ 命中', () => {
    const res = run([hkBank('//T54CCBT444555//')], [refund({ '银行打款流水号': 'T54CCBT444555' })]);
    assert.equal(res.backfillRows.length, 1);
  });
  test('提取到 T54LCIC 但 ro 无等值 → 不命中（等值收口；本例无 S4 日期容差兜底）', () => {
    const res = run(
      [hkBank('//T54LCIC222333//')],
      [refund({ '银行打款流水号': 'T54LCIC999999', 'valueDate': '2030-01-01' })] // 日期超容差 + 流水号不等
    );
    assert.equal(res.backfillRows.length, 0);
  });
});

// ======================================================================
// R3 JPM-HK CustomerRef 二跳回落（T54 未中 → 复用 US 二跳）
// ======================================================================
test.describe('R3：HK 分支 CustomerRef 二跳回落', () => {
  test('HK FPS 形态：T54 未提到 → CustomerRef 二跳（dep.ReconId==ro 打款流水号 ∧ dep.CustomerRef==bank.CustomerRef）→ 回填', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      CustomerRef: 'J-CR-1', 'Extra Information': 'no t54 token here'
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-HK1' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-HK1', CustomerRef: 'J-CR-1' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    assert.match(res.backfillRows[0]['匹配命中详情'], /银行对账单入金表/);
  });

  test('HK 二跳 ChannelOrderNo 第二键（OR 第二支）→ 回填', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'HK', CustomerRef: 'J-CR-2' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-HK2' })];
    const dep = [deposit({ ChannelOrderNo: 'PAYNO-HK2', CustomerRef: 'J-CR-2' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
  });

  test('HK 链顺序：T54 命中优先于二跳（同 bank 既有 T54 又能二跳命中不同 ro → 走 T54）', () => {
    // bank 提取到 T54SWIC494447 → 命中 ro-A（银行打款流水号=T54SWIC494447）；
    //   同时 CustomerRef 二跳本可命中 ro-B，但 T54 等值优先 → 命中 ro-A。
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      CustomerRef: 'J-CR-3', 'Extra Information': '//T54SWIC494447//'
    })];
    const r = [
      refund({ '流水号': 'SN-T54', '银行打款流水号': 'T54SWIC494447' }),
      refund({ '流水号': 'SN-2HOP', '银行打款流水号': 'PAYNO-HK3' })
    ];
    const dep = [deposit({ ReconciliationId: 'PAYNO-HK3', CustomerRef: 'J-CR-3' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-T54', 'T54 等值优先于 CustomerRef 二跳');
  });

  test('matchCustomerRefTwoHop 子函数：直接调用命中 + _depositBizId 携带', () => {
    const b = bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'HK', CustomerRef: 'CR-Z' });
    const r = refund({ '银行打款流水号': 'PAYNO-Z' });
    const dep = [deposit({ BizId: 'BIZ-Z', ReconciliationId: 'PAYNO-Z', CustomerRef: 'CR-Z' })];
    const hits = E.matchCustomerRefTwoHop(b, [r], dep);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._depositBizId, 'BIZ-Z');
  });
});

// ======================================================================
// R2 S2b：附言包含入金 CustomerRef（限 JPM，等值层之后）
// ======================================================================
test.describe('R2：S2b 附言包含入金 CustomerRef', () => {
  test('US 11 例同构：bank Payment Detail 含入金 CustomerRef（非等值）→ S2b 命中回填', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'US',
      CustomerRef: 'OTHER-REF',                 // 等值层（CustomerRef==dep.CustomerRef）不命中
      'Payment Detail': 'memo ... CR-INBOUND-9 ... tail' // 但附言含入金 CustomerRef
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-INBOUND-9' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
    assert.match(res.backfillRows[0]['匹配命中详情'], /银行对账单入金表/);
  });

  test('HK 1 例同构：Extra Information 含入金 CustomerRef → S2b 命中', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'HK',
      CustomerRef: 'NOPE', 'Extra Information': 'xx CR-HK-INBOUND yy'
    })];
    const r = [refund({ '银行打款流水号': 'PAYNO-HK' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-HK', CustomerRef: 'CR-HK-INBOUND' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
  });

  test('黑名单守卫：入金 CustomerRef=NOTPROVIDED → S2b 不触发（即使附言含该串）', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'US',
      CustomerRef: 'X', 'Payment Detail': 'has NOTPROVIDED inside', 'valueDate': undefined
    })];
    const r = [refund({ '银行打款流水号': 'PAYNO-1', 'valueDate': '2030-01-01' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'NOTPROVIDED' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0, 'NOTPROVIDED 占位不应命中');
  });

  test('短 ref 守卫：入金 CustomerRef 长度 <6 → S2b 不触发', () => {
    const b = [bank({
      _rowId: 'b1', Channel: 'JPM', '地区': 'US',
      CustomerRef: 'X', 'Payment Detail': 'contains AB12 short'
    })];
    const r = [refund({ '银行打款流水号': 'PAYNO-1', 'valueDate': '2030-01-01' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'AB12' })]; // 4 < 6
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0, '短 ref 不应命中');
  });

  test('限 Channel=JPM：非 JPM 渠道附言含入金 ref → S2b 不触发', () => {
    const hits = E.matchMemoContainsDepositRef(
      bank({ Channel: 'CITI', 'Payment Detail': 'has CR-INBOUND-9' }),
      [refund({ '银行打款流水号': 'PAYNO-1' })],
      [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-INBOUND-9' })]
    );
    assert.equal(hits.length, 0);
  });

  test('🔴 分层保护：bankA 等值命中 X、bankB 附言含同 ref → bankA 回填、bankB 不在 S2b 复抢 X', () => {
    // bankA：CustomerRef==dep.CustomerRef 等值（L2 命中 X）；bankB：附言含同一 dep.CustomerRef（本可 S2b 命中 X）。
    //   等值层先结清消费 X → S2b 层 X 已不可用，bankB 抢不到 → 落 S4/提示，绝不复抢已被等值消费的 X。
    const b = [
      bank({ _rowId: 'bA', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-INBOUND-9', BillDate: '2026-06-01' }),
      bank({ _rowId: 'bB', Channel: 'JPM', '地区': 'US', CustomerRef: 'NOMATCH',
        'Payment Detail': 'memo CR-INBOUND-9 tail', BillDate: '2026-06-02', 'valueDate': undefined })
    ];
    const r = [refund({ '流水号': 'SN-X', '银行打款流水号': 'PAYNO-1', 'valueDate': '2030-01-01' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-INBOUND-9' })];
    const res = run(b, r, dep);
    // 仅 1 条回填（X 被 bankA 等值层消费），且是 bankA
    assert.equal(res.backfillRows.length, 1, 'X 只被等值层 bankA 消费一次');
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-X');
    assert.equal(res.backfillRows[0]['渠道退款时间'], '2026-06-01', '回填来自 bankA（等值层）');
    // bankB 抢不到 X（S4 日期超容差）→ 落报错/提示，绝不复抢
    assert.ok(!res.backfillRows.some((x) => x['渠道退款时间'] === '2026-06-02'), 'bankB 不得复抢已消费的 X');
  });
});

// ======================================================================
// R4 S4 单向容差边界：0 ≤ bank.BillDate − ro.valueDate ≤ 21
// ======================================================================
test.describe('R4：S4 单向容差边界 diff=0/21/22/−1', () => {
  test('diff=0（同日）→ 命中回填', () => {
    const res = run([bank({ _rowId: 'b1', BillDate: '2026-06-10' })], [refund({ 'valueDate': '2026-06-10' })]);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_FUZZY);
  });

  test('diff=21（上界）→ 命中回填', () => {
    const res = run([bank({ _rowId: 'b1', BillDate: '2026-07-01' })], [refund({ 'valueDate': '2026-06-10' })]); // +21
    assert.equal(res.backfillRows.length, 1);
  });

  test('diff=22（越界）→ 报错（>21）', () => {
    const res = run([bank({ _rowId: 'b1', BillDate: '2026-07-02' })], [refund({ 'valueDate': '2026-06-10' })]); // +22
    assert.equal(res.backfillRows.length, 0);
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 1, 'diff=22 超容差 → 报错');
  });

  test('diff=−1（bank 早于 valueDate，方向收紧）→ 报错（时序矛盾，旧 ±abs 会误命中）', () => {
    const res = run([bank({ _rowId: 'b1', BillDate: '2026-06-09' })], [refund({ 'valueDate': '2026-06-10' })]); // −1
    assert.equal(res.backfillRows.length, 0, 'bank 早于 valueDate 不得命中');
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 1, 'diff=−1 时序矛盾 → 报错');
  });

  test('matchS4 子函数：窗内升序、窗外/负 diff 不入', () => {
    const b = bank({ _rowId: 'b1', BillDate: '2026-06-10' });
    const hits = E.matchS4(b, [
      refund({ '流水号': 'r0', 'valueDate': '2026-06-10' }),  // diff 0（窗内）
      refund({ '流水号': 'r5', 'valueDate': '2026-06-05' }),  // diff +5（窗内）
      refund({ '流水号': 'rNeg', 'valueDate': '2026-06-12' }), // diff −2（窗外，方向收紧）
      refund({ '流水号': 'rFar', 'valueDate': '2026-05-01' })  // diff +40（窗外）
    ]);
    assert.deepEqual(hits.map((h) => h.refundRow['流水号']), ['r0', 'r5'], '仅窗内、升序');
  });
});

// ======================================================================
// R5 S3b：Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate 二跳
// ======================================================================
test.describe('R5：S3b Drawee Name + DESC DATE 二跳', () => {
  // bank：Drawee Name 非空（启用条件）+ 附言含 DESC DATE token；ro payNo；dep ReconId==payNo ∧ ValueDate==token 日。
  //   令 S1~S3 全不命中：ChannelOrderNo/CustomerRef 空、非 JPM（跳 S2b）、Drawee Name 与 ro 付款人名称不等、附言无 MTX。
  function s3bCase(overrides = {}) {
    const b = [bank({
      _rowId: 'b1', Channel: 'CH', '地区': 'US',
      'Drawee Name': 'DON MAHESH',
      'Payment Detail': '["DESC DATE=260513;ENTRY DATE=260529;IND NAME=don mahesh"]',
      BillDate: '2030-01-01', // 远离 valueDate，避免 S4 兜底
      ...overrides.bank
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1', 'valueDate': '2099-01-01', ...overrides.ro })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', ValueDate: '2026-05-13', ...overrides.dep })];
    return run(b, r, dep);
  }

  test('DESC DATE token=260513 ↔ 入金 ValueDate=2026-05-13 同日 → S3b 命中回填（精准）', () => {
    const res = s3bCase();
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
    assert.match(res.backfillRows[0]['匹配命中详情'], /银行对账单入金表/);
  });

  test('Drawee Name 为空 → S3b 不启用（不命中）', () => {
    const res = s3bCase({ bank: { 'Drawee Name': '' } });
    assert.equal(res.backfillRows.length, 0);
  });

  test('入金 ValueDate 与 DESC DATE 不同日 → S3b 不命中', () => {
    const res = s3bCase({ dep: { ValueDate: '2026-05-20' } });
    assert.equal(res.backfillRows.length, 0);
  });

  test('no-op 防御：datePattern=null（模拟未配置）→ matchDraweeNameDate 整层跳过（直接子函数验证）', () => {
    // 不便改 frozen 常量；改为构造「附言无 DESC DATE token」等效验证整层无产出（token 提取为 null → 跳过）。
    const b = bank({ _rowId: 'b1', 'Drawee Name': 'X', 'Payment Detail': 'no desc date token here' });
    const hits = E.matchDraweeNameDate(b, [refund({ '银行打款流水号': 'PAYNO-1' })], [deposit({ ReconciliationId: 'PAYNO-1', ValueDate: '2026-05-13' })]);
    assert.equal(hits.length, 0, '无 DESC DATE token → 不命中');
  });
});

// ======================================================================
// R6 S3c：附言原单日期(DTD)+金额(FOR)+币种 ↔ 入金表二跳（模糊层）
// ======================================================================
test.describe('R6：S3c DTD+FOR+币种 二跳（模糊）', () => {
  function s3cCase(overrides = {}) {
    const b = [bank({
      _rowId: 'b1', Channel: 'CH', '地区': 'US',
      'Payment Detail': 'REMARK=/BNF/OUR REF JPM260529-011513 RTN DTD05/21/2026 FOR USD2285.00',
      BillDate: '2030-01-01',
      ...overrides.bank
    })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1', 'valueDate': '2099-01-01', ...overrides.ro })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', ValueDate: '2026-05-21', 'Credit Amount': 2285.00, Currency: 'USD', ...overrides.dep })];
    return run(b, r, dep);
  }

  test('DTD+FOR+币种 三 token 与入金行日期/金额(分)/币种全等 → S3c 命中回填（模糊）', () => {
    const res = s3cCase();
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_FUZZY);
  });

  test('入金金额不等（分比对）→ S3c 不命中', () => {
    const res = s3cCase({ dep: { 'Credit Amount': 2285.01 } });
    assert.equal(res.backfillRows.length, 0);
  });

  test('入金币种不等 → S3c 不命中', () => {
    const res = s3cCase({ dep: { Currency: 'EUR' } });
    assert.equal(res.backfillRows.length, 0);
  });

  test('入金 ValueDate 与 DTD 不同日 → S3c 不命中', () => {
    const res = s3cCase({ dep: { ValueDate: '2026-05-22' } });
    assert.equal(res.backfillRows.length, 0);
  });

  test('R6 多笔报错：一条 bank 经 S3c 命中 2 条 refund（同入金行二跳）→ 报错、不回填', () => {
    // 两条 ro 各自 payNo 二跳到「日期/金额/币种全等」的入金行 → bank 命中 2 条 → 正向多笔报错。
    const b = [bank({
      _rowId: 'b1', Channel: 'CH', '地区': 'US',
      'Payment Detail': 'RTN DTD05/21/2026 FOR USD2285.00', BillDate: '2030-01-01'
    })];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-A', 'valueDate': '2099-01-01' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAYNO-B', 'valueDate': '2099-01-01' })
    ];
    const dep = [
      deposit({ ReconciliationId: 'PAYNO-A', ValueDate: '2026-05-21', 'Credit Amount': 2285.00, Currency: 'USD' }),
      deposit({ ReconciliationId: 'PAYNO-B', ValueDate: '2026-05-21', 'Credit Amount': 2285.00, Currency: 'USD' })
    ];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0, 'R6 多笔即报错（宁报错勿误配）');
    assert.ok(res.unmatchedRows.some((x) => x['结果类型'] === RESULT_ERROR));
  });

  test('R6 锁定退出 S4：S3c 反向多笔卷入的 refund 锁定 → 不被 S4 复用', () => {
    // b1/b2 经 S3c 命中同一 ro（反向多笔）→ 报错锁定 SN-A；b3 日期容差内本可 S4 命中 SN-A，但已锁定。
    const b = [
      bank({ _rowId: 'b1', Channel: 'CH', '地区': 'US', 'Payment Detail': 'DTD05/21/2026 FOR USD2285.00', BillDate: '2030-01-01' }),
      bank({ _rowId: 'b2', Channel: 'CH', '地区': 'US', 'Payment Detail': 'DTD05/21/2026 FOR USD2285.00', BillDate: '2030-01-01' }),
      bank({ _rowId: 'b3', BillDate: '2026-05-22' }) // diff +1 到 valueDate 2026-05-21（窗内），本可 S4 命中
    ];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1', 'valueDate': '2026-05-21' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', ValueDate: '2026-05-21', 'Credit Amount': 2285.00, Currency: 'USD' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 0, '锁定的 SN-A 不被 b3 经 S4 复用');
    assert.ok(!res.backfillRows.some((x) => x['退款单号'] === 'SN-A'));
  });
});

// ======================================================================
// F-PERF depIndex：入金表双 Map 索引与线性版结果一致
// ======================================================================
test.describe('F-PERF：depIndex 双 Map 索引 vs 线性扫一致', () => {
  test('buildDepIndex：双键索引、空键不入、同键多值保留插入序', () => {
    const deps = [
      deposit({ BizId: 'D1', ReconciliationId: 'R1', ChannelOrderNo: 'C1' }),
      deposit({ BizId: 'D2', ReconciliationId: 'R1', ChannelOrderNo: '' }), // 同 ReconId R1（多值）；ChannelOrderNo 空（不入）
      deposit({ BizId: 'D3', ReconciliationId: '', ChannelOrderNo: 'C3' })  // ReconId 空（不入）
    ];
    const idx = E.buildDepIndex(deps);
    assert.equal(idx.byReconId.get('R1').length, 2, 'R1 同键两值');
    assert.equal(idx.byReconId.get('R1')[0].BizId, 'D1', '保留插入序');
    assert.equal(idx.byReconId.has(''), false, '空 ReconId 不入索引');
    assert.equal(idx.byChannelOrderNo.has(''), false, '空 ChannelOrderNo 不入索引');
    assert.equal(idx.byChannelOrderNo.get('C3')[0].BizId, 'D3');
  });

  test('lookupDepositByKeys：索引版 == 线性版（ReconId 命中 / ChannelOrderNo 命中 / 未命中）', () => {
    const deps = [
      deposit({ BizId: 'D1', ReconciliationId: 'R1', CustomerRef: 'X' }),
      deposit({ BizId: 'D2', ChannelOrderNo: 'C2', CustomerRef: 'Y' })
    ];
    const idx = E.buildDepIndex(deps);
    for (const key of ['R1', 'C2', 'NOPE']) {
      const lin = E.lookupDepositByKeys(key, deps, undefined);
      const indexed = E.lookupDepositByKeys(key, deps, idx);
      assert.deepEqual(indexed, lin, `key=${key} 索引版与线性版应一致`);
    }
  });

  test('matchCustomerRefTwoHop：索引版 hits == 线性版 hits（byte 级）', () => {
    const b = bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' });
    const ros = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAYNO-2' })
    ];
    const deps = [
      deposit({ BizId: 'D1', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' }),
      deposit({ BizId: 'D2', ChannelOrderNo: 'PAYNO-2', CustomerRef: 'CR-1' })
    ];
    const lin = E.matchCustomerRefTwoHop(b, ros, deps, undefined);
    const indexed = E.matchCustomerRefTwoHop(b, ros, deps, E.buildDepIndex(deps));
    assert.deepEqual(indexed, lin);
    assert.equal(indexed.length, 2);
  });

  test('全链路：索引（引擎默认）命中结果与显式线性二跳一致（JPM-US 回填）', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-9' })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-9' })];
    const dep = [deposit({ BizId: 'BIZ-9', ReconciliationId: 'PAYNO-9', CustomerRef: 'CR-9' })];
    const res = run(b, r, dep); // 引擎内部已用 depIndex
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.hitDepositBizIds[0], 'BIZ-9');
    // 线性二跳子函数对照
    const lin = E.matchCustomerRefTwoHop(b[0], r, dep, undefined);
    assert.equal(lin.length, 1);
    assert.equal(lin[0]._depositBizId, 'BIZ-9');
  });
});

// ======================================================================
// ⑤ 1v1 双向消费
// ======================================================================
test.describe('⑤ 1v1 双向消费', () => {
  test('一条 refund 只回填一次（各 bank 唯一互配 → 两条独立 refund 各回填一次）', () => {
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY2' })
    ];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY2' })
    ];
    // 严格 1↔1 互配：b1↔SN-A、b2↔SN-B 各回填一次，无重复
    const res = run(b, r);
    assert.equal(res.backfillRows.filter((x) => x['退款单号'] === 'SN-A').length, 1);
    assert.equal(res.backfillRows.filter((x) => x['退款单号'] === 'SN-B').length, 1);
  });

  test('一条 bank 只被回填一次（命中即停，后续策略不再处理已消费 bank）', () => {
    // bank 同时满足 S1(ChannelOrderNo) 与 S3(Drawee Name)，命中 S1 即停，不应产生 2 行
    const res = run(
      [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1', 'Drawee Name': '张三' })],
      [refund({ '银行打款流水号': 'PAY1', '付款人名称': '张三' })]
    );
    assert.equal(res.backfillRows.length, 1);
  });
});

// ======================================================================
// ⑥ 命中详情两句式文案
// ======================================================================
test.describe('⑥ 命中详情两句式文案', () => {
  test('bank↔refund 句式精确（O2：无「匹配成功:」前缀）', () => {
    const res = run([bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.equal(
      res.backfillRows[0]['匹配命中详情'],
      '"银行对账单ChannelOrderNo里的PAY1"匹配上了"refund order银行打款流水号的PAY1"'
    );
  });

  test('bank↔入金表（JPM-US）句式精确（O2：无「匹配成功:」前缀）', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-9' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-9' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-9', CustomerRef: 'CR-9' })];
    const res = run(b, r, dep);
    assert.equal(
      res.backfillRows[0]['匹配命中详情'],
      '"银行对账单CustomerRef里的CR-9"匹配上了"银行对账单入金表CustomerRef的CR-9"'
    );
  });
});

// ======================================================================
// O1/O2 命中类型 + 文案（refund-backfill-rules-v2）
// ======================================================================
test.describe('O1 命中类型：精准层（S1/S2/S3）= 精准命中、S4 = 模糊命中', () => {
  test('S1 命中 → 命中类型 = 精准命中', () => {
    const res = run([bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
  });

  test('S2（MTX 附言包含）命中 → 命中类型 = 精准命中', () => {
    const mtx = 'MTX1234567890123456789';
    const res = run(
      [bank({ _rowId: 'b1', Channel: 'CH', 'Extra Information': `付款 ${mtx}` })],
      [refund({ '附言': `本笔 ${mtx} 退款` })]
    );
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
  });

  test('S3（按位）命中 → 命中类型 = 精准命中', () => {
    const res = run([bank({ _rowId: 'b1', 'Drawee Name': '张三' })], [refund({ '付款人名称': '张三' })]);
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
  });

  test('JPM-US 二跳命中 → 命中类型 = 精准命中', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-9' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-9' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-9', CustomerRef: 'CR-9' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_PRECISE);
  });

  test('S4（日期容差）命中 → 命中类型 = 模糊命中', () => {
    const res = run(
      [bank({ _rowId: 'b1', BillDate: '2026-06-05' })],
      [refund({ 'valueDate': '2026-06-01' })] // diff +4 天 → S4
    );
    assert.equal(res.backfillRows[0]['命中类型'], HIT_TYPE_FUZZY);
  });
});

test.describe('O2 命中详情文案：去前缀 + S4 固定串', () => {
  test('S1 命中详情无「匹配成功:」前缀', () => {
    const res = run([bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.ok(!res.backfillRows[0]['匹配命中详情'].startsWith('匹配成功:'), '不应含「匹配成功:」前缀');
    assert.ok(res.backfillRows[0]['匹配命中详情'].startsWith('"银行对账单'), '应以引号开头');
  });

  test('S4 命中详情 == 固定串「命中唯一值:退款提交日期+大账号+金额+币种」', () => {
    const res = run(
      [bank({ _rowId: 'b1', BillDate: '2026-06-05' })],
      [refund({ 'valueDate': '2026-06-01' })]
    );
    assert.equal(res.backfillRows[0]['匹配命中详情'], S4_DETAIL_TEXT);
    assert.equal(res.backfillRows[0]['匹配命中详情'], '命中唯一值:退款提交日期+大账号+金额+币种');
  });
});

// ======================================================================
// ⑦ 空入参 / 边界
// ======================================================================
test.describe('⑦ 空入参 / 边界', () => {
  test('refundOrderRows 空 → 空 backfill 不抛', () => {
    const res = run([bank({ _rowId: 'b1' })], []);
    assert.deepEqual(res.backfillRows, []);
    assert.deepEqual(res.unmatchedRows, []);
    assert.deepEqual(res.modifications, []);
  });

  test('无 Ach Return 银行行 → 空 backfill 不抛', () => {
    const res = run([bank({ _rowId: 'b1', FundType: 'Charge' })], [refund()]);
    assert.deepEqual(res.backfillRows, []);
  });

  test('全 undefined 入参 → 空结果不抛', () => {
    const res = runRound5RefundOrderBackfill(undefined, undefined, undefined);
    assert.deepEqual(res.backfillRows, []);
    assert.deepEqual(res.unmatchedRows, []);
    assert.deepEqual(res.modifications, []);
    assert.ok(Array.isArray(res.warnings));
  });

  test('refund 退款金额非数值 → 不入组、不误命中', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [refund({ '退款金额': 'abc', '银行打款流水号': 'PAY1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
  });
});

// ======================================================================
// ⑧ 回填行结构
// ======================================================================
test.describe('⑧ 回填行结构', () => {
  test('回填行含固定 6 列 + 银行 12 字段，含 Debit Amount 不含 Credit Amount；v3.0.10 银行段含 Extra Information / Drawee Name', () => {
    const res = run(
      [bank({
        _rowId: 'b1', ChannelOrderNo: 'PAY1', 'Debit Amount': 100, 'Credit Amount': 0,
        'Extra Information': 'EI-X', 'Drawee Name': 'DN-X', 'Payment Detail': 'PD-X'
      })],
      [refund({ '银行打款流水号': 'PAY1' })]
    );
    const row = res.backfillRows[0];
    // 固定列
    assert.equal(row['退款单号'], 'SN-1');
    assert.equal(row['状态'], 'SUCCESS');
    assert.equal(row['渠道流水号'], 'RECON-1');
    assert.equal(row['渠道退款时间'], '2026-06-01');
    assert.ok(row['匹配命中详情']);
    // 银行段（buildBackfillRow 遍历 REFUND_BANK_COLUMNS 12 列取原值）
    assert.equal(row['BillDate'], '2026-06-01');
    assert.equal(row['MerchantId'], 'M1');
    assert.equal(row['Currency'], 'USD');
    assert.equal(row['Debit Amount'], 100);
    // v3.0.10：银行段新增两列原值随 REFUND_BANK_COLUMNS 自动落入回填行
    assert.equal(row['Extra Information'], 'EI-X', 'v3.0.10：回填行银行段应含 Extra Information 原值');
    assert.equal(row['Payment Detail'], 'PD-X');
    assert.equal(row['Drawee Name'], 'DN-X', 'v3.0.10：回填行银行段应含 Drawee Name 原值');
    assert.ok(!('Credit Amount' in row), '🔴 回填行不得含 Credit Amount');
  });
});

// ======================================================================
// 子函数单测
// ======================================================================
test.describe('子函数', () => {
  test('classifyCardinality 四态', () => {
    assert.equal(classifyCardinality(1, 1), '1:1');
    assert.equal(classifyCardinality(1, 3), '1:N');
    assert.equal(classifyCardinality(3, 1), 'N:1');
    assert.equal(classifyCardinality(2, 2), 'N:N');
  });

  test('bankAmountAbs = |credit - debit|，非数值按 0', () => {
    assert.equal(bankAmountAbs({ 'Credit Amount': 0, 'Debit Amount': 100 }), 100);
    assert.equal(bankAmountAbs({ 'Credit Amount': 50, 'Debit Amount': 0 }), 50);
    assert.equal(bankAmountAbs({ 'Credit Amount': 'x', 'Debit Amount': 100 }), 100);
  });

  test('extractFeature 去重 + lastIndex 安全（连续两次结果一致）', () => {
    const txt = 'MTX1234567890123456789 / MTX1234567890123456789';
    assert.deepEqual(extractFeature(txt, MTX_RE), ['MTX1234567890123456789']);
    // 再调一次确认 regex 模板未被 lastIndex 污染
    assert.deepEqual(extractFeature(txt, MTX_RE), ['MTX1234567890123456789']);
  });

  test('extractFeature T54SWIC 含 // 直接命中（R1 宽正则）', () => {
    assert.deepEqual(extractFeature('//T54SWIC494447//ABC', T54_RE), ['T54SWIC494447']);
  });

  test('extractFeature R1 三前缀 T54SWIC/T54LCIC/T54CCBT 均命中', () => {
    assert.deepEqual(extractFeature('T54SWIC494447', T54_RE), ['T54SWIC494447']);
    assert.deepEqual(extractFeature('//T54LCIC100200//', T54_RE), ['T54LCIC100200']);
    assert.deepEqual(extractFeature('x T54CCBT300400 y', T54_RE), ['T54CCBT300400']);
  });

  test('resolveHits：0→continue / 1→backfill / >1→error-manual', () => {
    assert.equal(resolveHits([]), 'continue');
    assert.equal(resolveHits([{}]), 'backfill');
    assert.equal(resolveHits([{}, {}]), 'error-manual');
  });

  test('matchS1 空字段不误命中（payNo 与 bankVal 皆空不匹配）', () => {
    const hits = matchS1(bank({ ChannelOrderNo: '', CustomerRef: '' }), [refund({ '银行打款流水号': '' })]);
    assert.equal(hits.length, 0);
  });

  test('matchS3 按位：付款卡号 ↔ Drawee CardNo（不与 Drawee Name 交叉）', () => {
    // refund 付款卡号='C9'，bank Drawee Name='C9' 但 Drawee CardNo 空 → 不命中（无交叉）
    const hits = matchS3(bank({ 'Drawee Name': 'C9', 'Drawee CardNo': '' }), [refund({ '付款卡号': 'C9' })]);
    assert.equal(hits.length, 0);
    // bank Drawee CardNo='C9' → 命中
    const hits2 = matchS3(bank({ 'Drawee CardNo': 'C9' }), [refund({ '付款卡号': 'C9' })]);
    assert.equal(hits2.length, 1);
  });
});

// ======================================================================
// ⑨ SPEC §7 引擎修复（Q13/Q14/Q15）—— 批量解析双向冲突 + S4 冻结快照
// ======================================================================
test.describe('⑨ 反向多笔（Q14）：N bank 命中同 1 refund → 全部报错-人工介入、不回填、refund 不被 S4 复用', () => {
  test('S1 反向多笔：b1/b2 同 ChannelOrderNo → 全报错、backfill=0、SN-A 不在回填', () => {
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY-SAME', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY-SAME', BillDate: '2026-12-10' })
    ];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY-SAME', 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0, '反向多笔不得回填');
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 2, 'b1/b2 各一行报错-人工介入');
    assert.ok(!res.backfillRows.some((x) => x['退款单号'] === 'SN-A'), 'SN-A 不得出现在回填');
    // Q15：被卷入报错的 refund 锁定，不应被 S4 复用（即使日期容差内也不回填）
    assert.ok(!res.backfillRows.some((x) => x['退款单号'] === 'SN-A'));
  });

  test('S2 反向多笔（MTX）：b1/b2 提同一 MTX 命中同 1 refund 附言 → 全报错、backfill=0', () => {
    const mtx = 'MTX1234567890123456789';
    const b = [
      bank({ _rowId: 'b1', Channel: 'CH', 'Extra Information': `付款 ${mtx}`, BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', Channel: 'CH', 'Extra Information': `退款 ${mtx}`, BillDate: '2026-12-10' })
    ];
    const r = [refund({ '流水号': 'SN-A', '附言': `本笔 ${mtx} 退款`, 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    assert.equal(res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR).length, 2);
  });

  test('S3 反向多笔：b1/b2 同 Drawee Name 命中同 1 refund 付款人名称 → 全报错、backfill=0', () => {
    const b = [
      bank({ _rowId: 'b1', 'Drawee Name': '张三', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', 'Drawee Name': '张三', BillDate: '2026-12-10' })
    ];
    const r = [refund({ '流水号': 'SN-A', '付款人名称': '张三', 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    assert.equal(res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR).length, 2);
  });

  test('S1 反向多笔卷入的 refund 不被 S4 复用（Q15）：另有 bank 日期容差内仍不回填', () => {
    // b1/b2 反向多笔报错卷入 SN-A；b3 无 S1~S3 关联，valueDate 在容差内本可 S4 命中 SN-A，但 SN-A 已锁定
    const b = [
      bank({ _rowId: 'b1', ChannelOrderNo: 'PAY-SAME', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY-SAME', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b3', BillDate: '2026-12-11' })
    ];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY-SAME', 'valueDate': '2026-12-11' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0, '锁定的 SN-A 不被 b3 经 S4 复用');
    assert.ok(!res.backfillRows.some((x) => x['退款单号'] === 'SN-A'));
  });
});

test.describe('⑨ S4 顺序无关（Q13；R4 单向窗判据）：判据按冻结候选集 + 窗内候选，不随输入顺序变', () => {
  // refund.valueDate=12-10；b1=12-10(diff0命中)、b2=2027-01-05(diff+26>21)、b3=2027-01-10(diff+31>21)
  function makeS4OrderCase(order) {
    const all = {
      b1: bank({ _rowId: 'b1', BillDate: '2026-12-10' }),
      b2: bank({ _rowId: 'b2', BillDate: '2027-01-05' }),
      b3: bank({ _rowId: 'b3', BillDate: '2027-01-10' })
    };
    const b = order.map((k) => all[k]);
    const r = [refund({ '流水号': 'SN-A', 'valueDate': '2026-12-10' })];
    return run(b, r);
  }

  test('原序 [b1,b2,b3]：b1 回填、b2/b3 各一行报错（非提示）', () => {
    const res = makeS4OrderCase(['b1', 'b2', 'b3']);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['BillDate'], '2026-12-10');
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 2, 'b2/b3 超 21 天容差 → 报错');
    assert.deepEqual(errs.map((x) => x['BillDate']).sort(), ['2027-01-05', '2027-01-10']);
  });

  test('打乱序 [b3,b1,b2]：结论一致（b1 回填、b2/b3 报错）', () => {
    const res = makeS4OrderCase(['b3', 'b1', 'b2']);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['BillDate'], '2026-12-10');
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 2);
    assert.deepEqual(errs.map((x) => x['BillDate']).sort(), ['2027-01-05', '2027-01-10']);
  });

  test('再打乱 [b2,b3,b1]：结论仍一致', () => {
    const res = makeS4OrderCase(['b2', 'b3', 'b1']);
    assert.equal(res.backfillRows.length, 1);
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 2);
  });
});

test.describe('⑨ S4「在容差但被抢光→提示」vs「超容差→报错」', () => {
  test('5 bank 全在容差 + 1 refund → 1 回填 + 4 提示（非报错）', () => {
    const b = [
      bank({ _rowId: 'b1', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', BillDate: '2026-12-11' }),
      bank({ _rowId: 'b3', BillDate: '2026-12-12' }),
      bank({ _rowId: 'b4', BillDate: '2026-12-13' }),
      bank({ _rowId: 'b5', BillDate: '2026-12-14' })
    ];
    const r = [refund({ '流水号': 'SN-A', 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1, '仅最近 1 条回填');
    const notices = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_NOTICE);
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 0, '被抢光的 bank 不应报错');
    // 4 个抢不到的 bank → 提示（均在窗内 0≤diff≤21，被抢光非脏数据）
    const bankNotices = notices.filter((x) => 'BillDate' in x);
    assert.equal(bankNotices.length, 4, '4 个被抢光 bank → 未匹配-提示');
  });

  test('超容差 bank → 报错（与被抢光提示区分）：2 bank（1 在容差 1 超容差）+ 1 refund', () => {
    const b = [
      bank({ _rowId: 'b1', BillDate: '2026-12-10' }),    // diff 0 容差内 → 回填
      bank({ _rowId: 'b2', BillDate: '2027-01-05' })     // diff +26 >21 → 报错
    ];
    const r = [refund({ '流水号': 'SN-A', 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    const errs = res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR);
    assert.equal(errs.length, 1, 'b2 超 21 天容差 → 报错');
    assert.equal(errs[0]['BillDate'], '2027-01-05');
  });
});

test.describe('⑨ JPM 反向多笔（Q14 同源）：多 bank 提同一 T54SWIC + 1 refund → 全报错', () => {
  test('JPM-HK 反向多笔：b1/b2 同 T54SWIC 命中同 1 refund 银行打款流水号 → 全报错、backfill=0', () => {
    const b = [
      bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'HK', 'Extra Information': '//T54SWIC494447//', BillDate: '2026-12-10' }),
      bank({ _rowId: 'b2', Channel: 'JPM', '地区': 'HK', 'Payment Detail': 'T54SWIC494447 xx', BillDate: '2026-12-10' })
    ];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'T54SWIC494447', 'valueDate': '2026-12-10' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0, 'JPM 反向多笔不得回填');
    assert.equal(res.unmatchedRows.filter((x) => x['结果类型'] === RESULT_ERROR).length, 2);
    assert.ok(!res.backfillRows.some((x) => x['退款单号'] === 'SN-A'));
  });
});

// ======================================================================
// ⑩ PR#64 Finding 1：单侧唯一值组不得静默丢弃（审计完整性不变量）
// ======================================================================
// 工具：判断一条 unmatched 行属于 bank 侧（含 REFUND_BANK_COLUMNS 字段）还是 refund 侧（仅退款单号）
const isBankUnmatched = (x) => Object.prototype.hasOwnProperty.call(x, 'MerchantId');
const isRefundUnmatched = (x) => !isBankUnmatched(x) && Object.prototype.hasOwnProperty.call(x, '退款单号');

test.describe('⑩ 审计不变量（v3.0.10 需求3.2 收窄：银行侧全覆盖；refund-only 静默不产行）', () => {
  test('bank 仅 M1 + refund 仅 M2（无交集）→ 仅 1 条 bank 提示，refund-only 不再产行', () => {
    const b = [bank({ _rowId: 'b1', MerchantId: 'M1' })];
    const r = [refund({ '流水号': 'SN-A', '银行大账号': 'M2' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    // bank-only 组（M1）→ 银行行未匹配-提示（带【提示】前缀，保留 结果类型 key）
    const bankNotice = res.unmatchedRows.filter((x) => isBankUnmatched(x) && x['MerchantId'] === 'M1');
    assert.equal(bankNotice.length, 1, 'M1 银行行应落未匹配-提示');
    assert.equal(bankNotice[0]['结果类型'], RESULT_NOTICE);
    assert.equal(bankNotice[0]['报错/提示信息'], '【提示】未能关联到任何退款订单', 'v3.0.10：信息列带【提示】前缀');
    // v3.0.10 需求3.2：refund-only 组（M2）不再产任何 refund 形状提示行
    const refNotice = res.unmatchedRows.filter(isRefundUnmatched);
    assert.equal(refNotice.length, 0, 'v3.0.10：refund-only 不再产 notice 行（完全静默）');
    // 总计仅 1 条（仅 bank-only 提示）
    assert.equal(res.unmatchedRows.length, 1);
  });

  test('bank-only 多行：3 条银行行无对应 refund → 各产 1 条提示（银行侧全覆盖不变）', () => {
    const b = [
      bank({ _rowId: 'b1', MerchantId: 'M1' }),
      bank({ _rowId: 'b2', MerchantId: 'M1' }),
      bank({ _rowId: 'b3', MerchantId: 'M1' })
    ];
    const r = [refund({ '银行大账号': 'OTHER' })]; // 不同大账号 → 不与 bank 同组
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 0);
    const bankNotices = res.unmatchedRows.filter(isBankUnmatched);
    assert.equal(bankNotices.length, 3, '3 条银行行各 1 提示');
    assert.ok(bankNotices.every((x) => x['结果类型'] === RESULT_NOTICE));
    assert.ok(bankNotices.every((x) => x['报错/提示信息'].startsWith('【提示】')), 'v3.0.10：均带【提示】前缀');
  });

  test('v3.0.10 需求3.2：2 条 refund-only（无对应 bank）→ 完全静默，不产任何行', () => {
    const b = [bank({ _rowId: 'b1', MerchantId: 'OTHER' })];
    const r = [
      refund({ '流水号': 'SN-A', '银行大账号': 'M9' }),
      refund({ '流水号': 'SN-B', '银行大账号': 'M9' })
    ];
    const res = run(b, r);
    const refNotices = res.unmatchedRows.filter(isRefundUnmatched);
    assert.equal(refNotices.length, 0, 'refund-only 完全静默，不产行');
    // 不应误删 bank-only 覆盖：b1（OTHER 组）仍产 1 条银行提示
    const bankNotices = res.unmatchedRows.filter(isBankUnmatched);
    assert.equal(bankNotices.length, 1, 'bank-only（OTHER）仍产 1 条提示（银行侧覆盖不动）');
  });

  test('v3.0.10 需求3.2：同组内未消费 refund（SN-B）静默，bank 命中行正常回填', () => {
    // 同唯一值组 M1/USD/100：bank b1 经 S1 命中 SN-A 回填；SN-B 同组未消费 → 不再产 notice（删 per-group 收尾）。
    const b = [bank({ _rowId: 'b1', MerchantId: 'M1', ChannelOrderNo: 'PAY1' })];
    const r = [
      refund({ '流水号': 'SN-A', '银行大账号': 'M1', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行大账号': 'M1' })
    ];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
    const snbNotices = res.unmatchedRows.filter((x) => x['退款单号'] === 'SN-B');
    assert.equal(snbNotices.length, 0, 'v3.0.10：SN-B 静默，不产提示行');
  });

  test('银行侧全覆盖不变量：每条筛后 Ach Return 银行行仍恰落 backfill/error/notice 之一（refund 侧不再全覆盖）', () => {
    const b = [
      // 组 G1 (M1/USD/100)：b1 S1 命中 SN-A → backfill；b2/b3 反向多笔同 PAY-X → error
      bank({ _rowId: 'b1', MerchantId: 'M1', ChannelOrderNo: 'PAYA' }),
      bank({ _rowId: 'b2', MerchantId: 'M1', ChannelOrderNo: 'PAY-X' }),
      bank({ _rowId: 'b3', MerchantId: 'M1', ChannelOrderNo: 'PAY-X' }),
      // bank-only 组 G2 (M7/USD/100)：b4 无对应 refund → notice
      bank({ _rowId: 'b4', MerchantId: 'M7' })
    ];
    const r = [
      refund({ '流水号': 'SN-A', '银行大账号': 'M1', '银行打款流水号': 'PAYA' }), // → backfill
      refund({ '流水号': 'SN-X', '银行大账号': 'M1', '银行打款流水号': 'PAY-X' }), // → 反向多笔锁定（error 行体现）
      refund({ '流水号': 'SN-R', '银行大账号': 'M9' })                            // refund-only → v3.0.10 静默，不产行
    ];
    const res = run(b, r);

    // 🔴 银行侧全覆盖：4 条银行行去向并集 = backfill（b1）+ error/notice（b2/b3/b4），恰各一次
    const bankInBackfill = res.backfillRows.length; // b1
    const bankInUnmatched = res.unmatchedRows.filter(isBankUnmatched).length; // b2/b3/b4
    assert.equal(bankInBackfill + bankInUnmatched, 4, '4 条银行行恰各出现一次（银行侧全覆盖不变）');

    // refund 侧：SN-A→backfill；SN-X→error 锁定（不产收尾行）；SN-R→refund-only 静默（不产行）
    const refundInBackfill = res.backfillRows.map((x) => x['退款单号']);
    assert.deepEqual(refundInBackfill.sort(), ['SN-A']);
    // v3.0.10：refund 形状提示行一律不产（SN-R refund-only 静默、SN-X 锁定不产）
    assert.equal(res.unmatchedRows.filter(isRefundUnmatched).length, 0, 'v3.0.10：无任何 refund 形状提示行');
  });
});

// ======================================================================
// ⑪ v3.0.21：R1 AchReturn pair 前置过滤（只移出 pair.bankRow，不按 reconid 扩散）
// ======================================================================
test.describe('⑪ v3.0.21：R1 AchReturn pair 前置过滤', () => {
  const r1Pair = (bankRow, tradeType = 'AchReturn') => ({
    gwRow: { TradeType: tradeType },
    bankRow
  });

  test('R1 pair 的 TradeType=AchReturn → 只将该银行行静默移出退款池', () => {
    const pairedBank = bank({ _rowId: 'b1', ReconciliationId: 'RECON-HIT', ChannelOrderNo: 'PAY1' });
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' })];
    const res = run([pairedBank], r, [], { r1Pairs: [r1Pair(pairedBank)] });
    assert.equal(res.backfillRows.length, 0, 'AchReturn pair 的 bankRow 不回填');
    assert.equal(res.unmatchedRows.filter(isBankUnmatched).length, 0, '被 drop 的行不进任何输出（静默）');
    assert.equal(res.unmatchedRows.length, 0, '完全静默：无任何输出行');
  });

  test('未传 r1Pairs → 不拦，即使仍传旧 gwRows 也正常参与退款回填', () => {
    const b = [bank({ _rowId: 'b1', ReconciliationId: 'RECON-HIT', ChannelOrderNo: 'PAY1' })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' })];
    const res = run(b, r, [], { gwRows: [{ reconciliationid: 'RECON-HIT', TradeType: 'AchReturn' }] });
    assert.equal(res.backfillRows.length, 1, '没有 r1Pairs → 不做前置过滤');
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-A');
  });

  test('r1Pairs 非数组、空数组或含畸形 pair → 安全跳过且不前置过滤', () => {
    const variants = [
      null,
      'not-an-array',
      [],
      [null, {}, { bankRow: null }, { gwRow: { TradeType: 'AchReturn' } }]
    ];

    for (const [index, r1Pairs] of variants.entries()) {
      const b = bank({ _rowId: `malformed-${index}`, ChannelOrderNo: `PAY-${index}` });
      const res = run(
        [b],
        [refund({ '流水号': `SN-${index}`, '银行打款流水号': `PAY-${index}` })],
        [],
        { r1Pairs }
      );
      assert.equal(res.backfillRows.length, 1, `variant ${index} 不得阻断退款回填`);
      assert.equal(res.backfillRows[0]['退款单号'], `SN-${index}`);
    }
  });

  test('pair.bankRow 有效但 gwRow 缺失 → 安全跳过且不前置过滤', () => {
    const b = bank({ _rowId: 'missing-gw', ChannelOrderNo: 'PAY-MISSING-GW' });
    const res = run(
      [b],
      [refund({ '流水号': 'SN-MISSING-GW', '银行打款流水号': 'PAY-MISSING-GW' })],
      [],
      { r1Pairs: [{ bankRow: b }] }
    );

    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-MISSING-GW');
  });

  test('对象身份守卫：pair.bankRow 克隆即使 rowId 和 reconid 相同，也不得过滤实际银行行', () => {
    const actualBank = bank({
      _rowId: 'same-row-id',
      ReconciliationId: 'RECON-SAME-IDENTITY',
      ChannelOrderNo: 'PAY-ACTUAL'
    });
    const clonedBank = { ...actualBank };
    const res = run(
      [actualBank],
      [refund({ '流水号': 'SN-ACTUAL', '银行打款流水号': 'PAY-ACTUAL' })],
      [],
      { r1Pairs: [r1Pair(clonedBank)] }
    );

    assert.equal(res.backfillRows.length, 1, '不同对象引用不得按 rowId 或 reconid 扩散过滤');
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-ACTUAL');
  });

  test('TradeType trim 后严格匹配：两侧空白可命中，大小写或字面不同不命中', () => {
    const makeResult = (tradeType) => {
      const b = bank({ _rowId: `b-${tradeType}`, ChannelOrderNo: 'PAY1' });
      return run(
        [b],
        [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' })],
        [],
        { r1Pairs: [r1Pair(b, tradeType)] }
      );
    };

    assert.equal(makeResult('  AchReturn  ').backfillRows.length, 0, 'trim 后 AchReturn → 拦截');
    assert.equal(makeResult('Inbound-VA').backfillRows.length, 1, '无关网关类型 → 不拦截');
    assert.equal(makeResult('').backfillRows.length, 1, '空网关类型 → 不拦截');
    assert.equal(makeResult('achreturn').backfillRows.length, 1, '大小写不同 → 不拦截');
    assert.equal(makeResult('Ach Return').backfillRows.length, 1, '字面不同 → 不拦截');
  });

  test('同 reconid 不扩散：只拦 pair.bankRow，另一条同 ID 银行行仍可回填', () => {
    const pairedBank = bank({ _rowId: 'b1', ReconciliationId: 'RECON-SAME', ChannelOrderNo: 'PAY1' });
    const unpairedBank = bank({ _rowId: 'b2', ReconciliationId: 'RECON-SAME', ChannelOrderNo: 'PAY2' });
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' })];
    r.push(refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY2' }));

    const res = run([pairedBank, unpairedBank], r, [], { r1Pairs: [r1Pair(pairedBank)] });
    assert.equal(res.backfillRows.length, 1, '同 reconid 的未配对银行行仍参与');
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-B');
    assert.equal(res.backfillRows[0].ChannelOrderNo, 'PAY2');
  });
});

// ======================================================================
// ⑪b v3.0.23 增补：R4 AchReturn matchedPairs 前置过滤（含 no-op）
// ======================================================================
test.describe('⑪b v3.0.23：R4 AchReturn matchedPairs 前置过滤', () => {
  const r4Pair = (bankRow, overrides = {}) => ({
    gwRow: { TradeType: 'AchReturn' },
    bankRow,
    subCategory: 'ach-return',
    targetFundType: 'Ach Return',
    changed: false,
    ...overrides
  });

  test('R4 AchReturn no-op pair 仍将具体银行行静默移出退款池', () => {
    const pairedBank = bank({ _rowId: 'r4-noop', ChannelOrderNo: 'PAY-R4' });
    const res = run(
      [pairedBank],
      [refund({ '流水号': 'SN-R4', '银行打款流水号': 'PAY-R4' })],
      [],
      { r4MatchedPairs: [r4Pair(pairedBank)] }
    );

    assert.equal(res.backfillRows.length, 0);
    assert.equal(res.unmatchedRows.length, 0, '被 R4 确认的行保持现有静默排除语义');
  });

  test('对象身份守卫：同 rowId/ReconID 的克隆对象不得过滤实际银行行', () => {
    const actualBank = bank({
      _rowId: 'r4-same-row',
      ReconciliationId: 'R4-SAME-RECON',
      ChannelOrderNo: 'PAY-ACTUAL'
    });
    const clonedBank = { ...actualBank };
    const res = run(
      [actualBank],
      [refund({ '流水号': 'SN-ACTUAL', '银行打款流水号': 'PAY-ACTUAL' })],
      [],
      { r4MatchedPairs: [r4Pair(clonedBank)] }
    );

    assert.equal(res.backfillRows.length, 1, 'R4 过滤不得按 rowId 或 ReconID 扩散');
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-ACTUAL');
  });

  test('同 ReconID 两条银行行只过滤 pair.bankRow，另一条继续参与退款匹配', () => {
    const pairedBank = bank({ _rowId: 'r4-paired', ReconciliationId: 'R4-DUP', ChannelOrderNo: 'PAY-1' });
    const otherBank = bank({ _rowId: 'r4-other', ReconciliationId: 'R4-DUP', ChannelOrderNo: 'PAY-2' });
    const res = run(
      [pairedBank, otherBank],
      [
        refund({ '流水号': 'SN-1', '银行打款流水号': 'PAY-1' }),
        refund({ '流水号': 'SN-2', '银行打款流水号': 'PAY-2' })
      ],
      [],
      { r4MatchedPairs: [r4Pair(pairedBank)] }
    );

    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]['退款单号'], 'SN-2');
    assert.equal(res.backfillRows[0].ChannelOrderNo, 'PAY-2');
  });

  test('非 AchReturn、缺失或畸形 R4 关系不触发前置过滤', () => {
    const variants = [
      undefined,
      null,
      'bad',
      [null, {}, { bankRow: null }, r4Pair(bank({ _rowId: 'wire-clone' }), { subCategory: 'wire-return' })]
    ];

    for (const [index, r4MatchedPairs] of variants.entries()) {
      const bankRow = bank({ _rowId: `r4-malformed-${index}`, ChannelOrderNo: `PAY-${index}` });
      const res = run(
        [bankRow],
        [refund({ '流水号': `SN-${index}`, '银行打款流水号': `PAY-${index}` })],
        [],
        { r4MatchedPairs }
      );
      assert.equal(res.backfillRows.length, 1, `variant ${index} 不得误过滤`);
    }
  });

  test('R1 与 R4 同时指向同一银行行时仍只静默排除一次', () => {
    const bankRow = bank({ _rowId: 'r1-r4-overlap', ChannelOrderNo: 'PAY-OVERLAP' });
    const res = run(
      [bankRow],
      [refund({ '流水号': 'SN-OVERLAP', '银行打款流水号': 'PAY-OVERLAP' })],
      [],
      {
        r1Pairs: [{ gwRow: { TradeType: 'AchReturn' }, bankRow }],
        r4MatchedPairs: [r4Pair(bankRow)]
      }
    );
    assert.deepEqual(res.backfillRows, []);
    assert.deepEqual(res.unmatchedRows, []);
  });
});

// ======================================================================
// ⑫ v3.0.10 需求3.1：逐策略 _matchedColumns 链断言（matcher 记候选 → buildBackfillRow 单点过滤 → row._matchedColumns ⊆ sheet1）
//   只标「既参与匹配、又在 sheet1 列」的字段（交集标黄）；★ 列（不在 sheet1）被过滤丢弃；命中即停 → 单行单一来源。
//   v3.0.10 银行段 10→12（加 Extra Information + Drawee Name）：S2-MTX/JPM-HK 的 Extra Information、S3 的 Drawee Name、
//     S3b/S3c 的 Extra Information 之前被过滤、现入 sheet1 → 命中即保留标黄；Payee CardNo 未纳入 → S3 虚拟卡号侧仍只剩 ro 列。
//   v3.0.10 S4（Change B）：_matchedColumns 由 [BillDate,valueDate] 扩为按固定文案口径的 8 列（bank 4 + ro 4，全∈sheet1）。
// ======================================================================
test.describe('⑫ v3.0.10 需求3.1：逐策略 _matchedColumns', () => {
  const dep = (o = {}) => ({ BizId: 'bz', ReconciliationId: '', ChannelOrderNo: '', CustomerRef: '', ...o });
  const mc = (res) => res.backfillRows[0] && res.backfillRows[0]._matchedColumns;

  test('S1：命中 ChannelOrderNo → [ChannelOrderNo, 银行打款流水号]（两者∈sheet1）', () => {
    const res = run([bank({ ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]);
    assert.deepEqual(mc(res), ['ChannelOrderNo', '银行打款流水号']);
  });

  test('S1：命中 CustomerRef → [CustomerRef, 银行打款流水号]', () => {
    const res = run([bank({ CustomerRef: 'CR1' })], [refund({ '银行打款流水号': 'CR1' })]);
    assert.deepEqual(mc(res), ['CustomerRef', '银行打款流水号']);
  });

  test('S2-MTX：[Extra Information, 附言]（v3.0.10：Extra Information 入 sheet1 → 不再被过滤）', () => {
    const memo = 'x MTX1234567890123456789 y';
    const res = run([bank({ Channel: 'X', 'Extra Information': 'MTX1234567890123456789' })], [refund({ '附言': memo })]);
    assert.deepEqual(mc(res), ['Extra Information', '附言'], 'v3.0.10：Extra Information ∈ sheet1 → 命中标黄');
  });

  test('JPM-HK：[Extra Information, Payment Detail, 银行打款流水号]（v3.0.10：Extra Information 不再被过滤）', () => {
    const res = run(
      [bank({ Channel: 'JPM', '地区': 'HK', 'Payment Detail': 'T54SWIC123456' })],
      [refund({ '银行打款流水号': 'T54SWIC123456' })]
    );
    // 候选 = [...hkCleanFields(=Extra Information,Payment Detail), 银行打款流水号]；v3.0.10 后三者全∈sheet1。
    assert.deepEqual(mc(res), ['Extra Information', 'Payment Detail', '银行打款流水号']);
  });

  test('JPM-US 二跳：[CustomerRef]（入金侧同名 CustomerRef 去重；入金取值★概念上不重复标）', () => {
    const res = run(
      [bank({ Channel: 'JPM', '地区': 'US', CustomerRef: 'CR1' })],
      [refund({ '银行打款流水号': 'PN1' })],
      [dep({ ReconciliationId: 'PN1', CustomerRef: 'CR1' })]
    );
    assert.deepEqual(mc(res), ['CustomerRef'], '银行 CustomerRef∈sheet1；去重后仅一列');
  });

  test('S2b：[Payment Detail]（入金 CustomerRef★ 不列入候选——本行 CustomerRef 未参与本次比对）', () => {
    const res = run(
      [bank({ Channel: 'JPM', 'Payment Detail': 'REF ABCDEF END' })],
      [refund({ '银行打款流水号': 'PN1' })],
      [dep({ ReconciliationId: 'PN1', CustomerRef: 'ABCDEF' })]
    );
    assert.deepEqual(mc(res), ['Payment Detail'], 'S2b 仅标命中的附言字段，不误标本行 CustomerRef');
  });

  test('S3：命中 付款人名称 → [Drawee Name, 付款人名称]（v3.0.10：Drawee Name 入 sheet1 → 不再被过滤）', () => {
    const res = run([bank({ 'Drawee Name': '张三' })], [refund({ '付款人名称': '张三' })]);
    // 候选 = [pair.bankField(=Drawee Name), pair.roKey(=付款人名称)]；v3.0.10 后 Drawee Name ∈ sheet1。
    assert.deepEqual(mc(res), ['Drawee Name', '付款人名称']);
  });

  test('S3：命中 虚拟卡号 → [虚拟卡号]（Payee CardNo★ 仍∉sheet1 → 被过滤）', () => {
    // Payee CardNo 未纳入 v3.0.10 银行段 → 仍被交集过滤，只剩 ro 侧虚拟卡号。
    const res = run([bank({ 'Payee CardNo': 'VC9' })], [refund({ '虚拟卡号': 'VC9' })]);
    assert.deepEqual(mc(res), ['虚拟卡号']);
  });

  test('S3b：[Drawee Name, Payment Detail, Extra Information]（v3.0.10：门控 Drawee Name + 附言两列入 sheet1；入金 ValueDate★ 仍被过滤）', () => {
    const res = run(
      [bank({ Channel: 'JPM', 'Drawee Name': '张三', 'Payment Detail': 'DESC DATE=260601' })],
      [refund({ '银行打款流水号': 'PN1' })],
      [dep({ ReconciliationId: 'PN1', ValueDate: '2026-06-01' })]
    );
    // 候选 = [draweeNameField(=Drawee Name), ...memoFields(=Payment Detail,Extra Information), depositDateField(=ValueDate)]；
    //   v3.0.10 后前三者∈sheet1（含门控 Drawee Name 与两附言列），入金 ValueDate∉sheet1 被过滤。
    assert.deepEqual(mc(res), ['Drawee Name', 'Payment Detail', 'Extra Information']);
  });

  test('S3c：[Payment Detail, Extra Information]（v3.0.10：附言两列入 sheet1；入金 ValueDate★/Credit Amount★/Currency★ 仍被过滤、不误标本行 Currency）', () => {
    const res = run(
      [bank({ Channel: 'JPM', 'Payment Detail': 'DTD06/01/2026 FOR USD100.00' })],
      [refund({ '银行打款流水号': 'PN1' })],
      [dep({ ReconciliationId: 'PN1', ValueDate: '2026-06-01', 'Credit Amount': 100, Currency: 'USD' })]
    );
    // 候选 = [...memoFields(=Payment Detail,Extra Information)]；v3.0.10 后两者∈sheet1；入金侧同名 Currency 不列入候选 → 不误标本行 Currency。
    assert.deepEqual(mc(res), ['Payment Detail', 'Extra Information'], '入金侧同名 Currency 不列入候选 → 不误标本行 Currency');
  });

  test('S4：8 列 [BillDate,MerchantId,Debit Amount,Currency,valueDate,银行大账号,退款金额,币种]（v3.0.10：按固定文案口径展开，全∈sheet1）', () => {
    const res = run([bank({ BillDate: '2026-06-03' })], [refund({ 'valueDate': '2026-06-02' })]);
    // v3.0.10：S4 命中详情固定文案「退款提交日期+大账号+金额+币种」→ 标黄 bank 4 列 + ro 4 列（全∈sheet1）。
    //   Debit Amount 仅作 sheet1 银行金额展示列（实际匹配口径是 |Credit−Debit| 绝对值，见 bankAmountAbs）。
    assert.deepEqual(mc(res), [
      'BillDate', 'MerchantId', 'Debit Amount', 'Currency',
      'valueDate', '银行大账号', '退款金额', '币种'
    ]);
    assert.match(res.backfillRows[0]['匹配命中详情'], /命中唯一值:退款提交日期/, '确认走 S4');
  });

  test('_matchedColumns 全部 ⊆ REFUND_TEMPLATE_HEADERS（无 ★ 列泄漏）', () => {
    const headers = new Set(REFUND_TEMPLATE_HEADERS);
    const samples = [
      run([bank({ ChannelOrderNo: 'PAY1' })], [refund({ '银行打款流水号': 'PAY1' })]),
      run([bank({ Channel: 'JPM', '地区': 'HK', 'Payment Detail': 'T54SWIC123456' })], [refund({ '银行打款流水号': 'T54SWIC123456' })]),
      run([bank({ 'Drawee Name': '张三' })], [refund({ '付款人名称': '张三' })]),
      run([bank({ BillDate: '2026-06-03' })], [refund({ 'valueDate': '2026-06-02' })])
    ];
    for (const res of samples) {
      const m = res.backfillRows[0]._matchedColumns;
      assert.ok(Array.isArray(m) && m.length > 0, '命中行应有非空 _matchedColumns');
      for (const c of m) assert.ok(headers.has(c), `_matchedColumns 列「${c}」必须 ∈ REFUND_TEMPLATE_HEADERS`);
    }
  });
});

// ======================================================================
// ⑬ v3.0.10 需求3.2：报错/提示信息前缀（【报错】/【提示】，单点加在 buildUnmatchedBankRow；保留 结果类型 key）
// ======================================================================
test.describe('⑬ v3.0.10 需求3.2：报错/提示前缀', () => {
  test('【报错】前缀：S1 关联到多笔 → 报错行信息列以【报错】开头，保留 结果类型 key', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [
      refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }),
      refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY1' })
    ];
    const res = run(b, r);
    const err = res.unmatchedRows.find((x) => x['结果类型'] === RESULT_ERROR);
    assert.ok(err, '应有报错行（结果类型 key 保留）');
    assert.ok(err['报错/提示信息'].startsWith('【报错】'), '报错信息以【报错】开头');
  });

  test('【提示】前缀：bank-only → 提示行信息列以【提示】开头', () => {
    const res = run([bank({ _rowId: 'b1', MerchantId: 'M1' })], [refund({ '银行大账号': 'OTHER' })]);
    const notice = res.unmatchedRows.find((x) => x['结果类型'] === RESULT_NOTICE);
    assert.ok(notice, '应有提示行');
    assert.equal(notice['报错/提示信息'], '【提示】未能关联到任何退款订单');
  });

  test('保留 结果类型 key：filter(x=>x[结果类型]===RESULT_ERROR) 仍可用（兼容引擎内部/核兼容测试）', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAY1' }), refund({ '流水号': 'SN-B', '银行打款流水号': 'PAY1' })];
    const res = run(b, r);
    assert.ok(res.unmatchedRows.every((x) => Object.prototype.hasOwnProperty.call(x, '结果类型')), '每条 unmatched 仍带 结果类型 key');
  });
});
