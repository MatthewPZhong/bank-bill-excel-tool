// linked-fx OPEN-7 / T5b-1 引擎侧单测（🔴 资金红线 · 跨期重复命中提醒，引擎纯函数部分）
// spec: changes/linked-fx-bank-deposit-merge-import/spec.md §3.6
//
// 覆盖（仅引擎侧纯函数行为；DB/接线在 T5b-2，本批不测）：
//   ① matchJpmUs 命中 → hit 带 _depositBizId（归一）；对应 backfillRow 带 _bridgeDepositBizId
//   ② runRound5 hitDepositBizIds：仅「回填成功的桥接 BizId」入集；去重；
//      无 JPM-US 命中 → []；其他策略层（S4 模糊 / S1）命中不污染集合；空入参早退 → []
//   ③ buildStaleHitReminder 文案精确（含 bizId + lastHitAt）
//   ④ pickStaleHits：last_hit_run 非空且≠runId → 入选；==runId → 不入（同批不误报）；
//      空 last_hit_run → 不入（首次）；空/无 markerMap → 空数组；runId 跨类型按字符串比较

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../../../../src/main-process/scenario-engines/r5-refund-order-backfill');
const {
  runRound5RefundOrderBackfill,
  matchJpmUs,
  buildStaleHitReminder,
  pickStaleHits,
  normalizeBizIdKey
} = E;

// ---- 夹具（与 r5-refund-order-backfill.test.js 同款；默认唯一值键 = M1||USD||10000 分）----
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

// 入金表行（JPM-US 桥接）；BizId = BANK_DEPOSIT_FIELDS[0]
function deposit(overrides = {}) {
  return {
    BizId: '',
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
// ① matchJpmUs hit 带 _depositBizId + 回填行带 _bridgeDepositBizId
// ======================================================================
test.describe('① 命中入金表行携带 BizId', () => {
  test('matchJpmUs 命中 → hit._depositBizId = 入金表行 BizId（归一）', () => {
    const b = bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' });
    const r = refund({ '银行打款流水号': 'PAYNO-1' });
    const dep = [deposit({ BizId: '  BIZ-A  ', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })];
    const hits = matchJpmUs(b, [r], dep);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._depositBizId, 'BIZ-A'); // 已 trim
  });

  test('matchJpmUs 命中但入金表行 BizId 缺失 → _depositBizId = ""（空键）', () => {
    const b = bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' });
    const r = refund({ '银行打款流水号': 'PAYNO-1' });
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })]; // 无 BizId
    const hits = matchJpmUs(b, [r], dep);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._depositBizId, '');
  });

  test('JPM-US 回填成功 → 对应 backfillRow 含 _bridgeDepositBizId', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' })];
    const r = [refund({ '流水号': 'SN-A', '银行打款流水号': 'PAYNO-1' })];
    const dep = [deposit({ BizId: 'BIZ-A', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(res.backfillRows[0]._bridgeDepositBizId, 'BIZ-A');
  });

  test('非桥接回填行（S1 命中）→ backfillRow 不含 _bridgeDepositBizId 键', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [refund({ '银行打款流水号': 'PAY1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(res.backfillRows[0], '_bridgeDepositBizId'), false);
  });
});

// ======================================================================
// ② runRound5 hitDepositBizIds 集合
// ======================================================================
test.describe('② hitDepositBizIds 收集', () => {
  test('单条 JPM-US 桥接回填 → hitDepositBizIds = [BizId]', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-1' })];
    const dep = [deposit({ BizId: 'BIZ-A', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })];
    const res = run(b, r, dep);
    assert.deepEqual(res.hitDepositBizIds, ['BIZ-A']);
  });

  test('两条 JPM-US 桥接命中同一 BizId → 去重为 1 个', () => {
    // 两个独立唯一值分组（金额不同）各自经同一入金表 BizId 桥接命中 → 集合去重。
    const b = [
      bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1', 'Debit Amount': 100 }),
      bank({ _rowId: 'b2', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-2', 'Debit Amount': 200 })
    ];
    const r = [
      refund({ '流水号': 'SN-1', '银行打款流水号': 'PAYNO-1', '退款金额': 100 }),
      refund({ '流水号': 'SN-2', '银行打款流水号': 'PAYNO-2', '退款金额': 200 })
    ];
    const dep = [
      deposit({ BizId: 'BIZ-DUP', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' }),
      deposit({ BizId: 'BIZ-DUP', ReconciliationId: 'PAYNO-2', CustomerRef: 'CR-2' })
    ];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 2);
    assert.deepEqual(res.hitDepositBizIds, ['BIZ-DUP']); // 去重
  });

  test('无 JPM-US 命中（纯 S1 回填）→ hitDepositBizIds = []', () => {
    const b = [bank({ _rowId: 'b1', ChannelOrderNo: 'PAY1' })];
    const r = [refund({ '银行打款流水号': 'PAY1' })];
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.deepEqual(res.hitDepositBizIds, []);
  });

  test('S4 模糊（日期容差）命中不污染集合 → hitDepositBizIds = []', () => {
    // S4 命中的 hit 无 _depositBizId（非入金表来源）。
    const b = [bank({ _rowId: 'b1', BillDate: '2026-06-01' })];
    const r = [refund({ 'valueDate': '2026-06-02' })]; // 容差内、S1~S3 全不命中 → 落 S4
    const res = run(b, r);
    assert.equal(res.backfillRows.length, 1);
    assert.match(res.backfillRows[0]['匹配命中详情'], /valueDate/); // 确认走 S4
    assert.deepEqual(res.hitDepositBizIds, []);
  });

  test('混合：JPM-US 桥接 + S1 普通命中并存 → 集合仅含桥接 BizId', () => {
    const b = [
      bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1', 'Debit Amount': 100 }),
      bank({ _rowId: 'b2', ChannelOrderNo: 'PAY2', 'Debit Amount': 200 })
    ];
    const r = [
      refund({ '流水号': 'SN-1', '银行打款流水号': 'PAYNO-1', '退款金额': 100 }),
      refund({ '流水号': 'SN-2', '银行打款流水号': 'PAY2', '退款金额': 200 })
    ];
    const dep = [deposit({ BizId: 'BIZ-A', ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })];
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 2); // 一条桥接 + 一条 S1
    assert.deepEqual(res.hitDepositBizIds, ['BIZ-A']); // 仅桥接入集
  });

  test('JPM-US 命中但入金表 BizId 为空 → 不入集合（空键不收集）', () => {
    const b = [bank({ _rowId: 'b1', Channel: 'JPM', '地区': 'US', CustomerRef: 'CR-1' })];
    const r = [refund({ '银行打款流水号': 'PAYNO-1' })];
    const dep = [deposit({ ReconciliationId: 'PAYNO-1', CustomerRef: 'CR-1' })]; // 无 BizId
    const res = run(b, r, dep);
    assert.equal(res.backfillRows.length, 1); // 仍回填成功
    assert.deepEqual(res.hitDepositBizIds, []); // 但空 BizId 不收集
  });

  test('空入参早退路径 → hitDepositBizIds = []', () => {
    const res = run([], []);
    assert.deepEqual(res.hitDepositBizIds, []);
  });
});

// ======================================================================
// ③ buildStaleHitReminder 文案
// ======================================================================
test.describe('③ buildStaleHitReminder 文案', () => {
  test('含 bizId + lastHitAt，与 spec §3.6-5 对齐', () => {
    const txt = buildStaleHitReminder('BIZ-X', '2026-05-01T08:00:00Z');
    assert.equal(txt, '⚠️ 桥接入金表行 BizId=BIZ-X 此前于 [2026-05-01T08:00:00Z] 已被命中，疑似历史残留');
  });
});

// ======================================================================
// ④ pickStaleHits 判定
// ======================================================================
test.describe('④ pickStaleHits 判定', () => {
  test('last_hit_run 非空且 ≠ runId → 入选（含 lastHitAt）', () => {
    const m = new Map([['BIZ-1', { last_hit_run: 'RUN-OLD', last_hit_at: '2026-05-01' }]]);
    assert.deepEqual(pickStaleHits(['BIZ-1'], m, 'RUN-NEW'), [{ bizId: 'BIZ-1', lastHitAt: '2026-05-01' }]);
  });

  test('last_hit_run == runId → 不入（同批不误报）', () => {
    const m = new Map([['BIZ-1', { last_hit_run: 'RUN-NEW', last_hit_at: 'x' }]]);
    assert.deepEqual(pickStaleHits(['BIZ-1'], m, 'RUN-NEW'), []);
  });

  test('空 last_hit_run（""/null/undefined）→ 不入（首次命中）', () => {
    const m = new Map([
      ['BIZ-1', { last_hit_run: '', last_hit_at: 'a' }],
      ['BIZ-2', { last_hit_run: null, last_hit_at: 'b' }],
      ['BIZ-3', { last_hit_run: undefined, last_hit_at: 'c' }]
    ]);
    assert.deepEqual(pickStaleHits(['BIZ-1', 'BIZ-2', 'BIZ-3'], m, 'RUN-NEW'), []);
  });

  test('markerMap 未命中该 bizId → 不入（首次命中）', () => {
    const m = new Map([['BIZ-OTHER', { last_hit_run: 'RUN-OLD', last_hit_at: 'x' }]]);
    assert.deepEqual(pickStaleHits(['BIZ-1'], m, 'RUN-NEW'), []);
  });

  test('空 markerMap / 非 Map → 空数组', () => {
    assert.deepEqual(pickStaleHits(['BIZ-1'], new Map(), 'RUN-NEW'), []);
    assert.deepEqual(pickStaleHits(['BIZ-1'], null, 'RUN-NEW'), []);
    assert.deepEqual(pickStaleHits(['BIZ-1'], {}, 'RUN-NEW'), []);
  });

  test('hitBizIds 非数组 / 空 → 空数组', () => {
    const m = new Map([['BIZ-1', { last_hit_run: 'RUN-OLD', last_hit_at: 'x' }]]);
    assert.deepEqual(pickStaleHits([], m, 'RUN-NEW'), []);
    assert.deepEqual(pickStaleHits(null, m, 'RUN-NEW'), []);
  });

  test('runId 跨类型按字符串比较（number runId vs 字符串 last_hit_run）', () => {
    // last_hit_run 存的是 '123'，runId 传 number 123 → String 化后相等 → 同批不入。
    const m = new Map([['BIZ-1', { last_hit_run: '123', last_hit_at: 'x' }]]);
    assert.deepEqual(pickStaleHits(['BIZ-1'], m, 123), []);
    // last_hit_run '123' vs runId 456 → 不等 → 入选。
    assert.deepEqual(pickStaleHits(['BIZ-1'], m, 456), [{ bizId: 'BIZ-1', lastHitAt: 'x' }]);
  });

  test('混合集合：仅跨期项入选（同批 + 首次 + 缺标记均排除）', () => {
    const m = new Map([
      ['BIZ-STALE', { last_hit_run: 'RUN-OLD', last_hit_at: '2026-05-01' }],
      ['BIZ-SAME', { last_hit_run: 'RUN-NEW', last_hit_at: 'y' }],
      ['BIZ-FIRST', { last_hit_run: '', last_hit_at: 'z' }]
    ]);
    const got = pickStaleHits(['BIZ-STALE', 'BIZ-SAME', 'BIZ-FIRST', 'BIZ-MISS'], m, 'RUN-NEW');
    assert.deepEqual(got, [{ bizId: 'BIZ-STALE', lastHitAt: '2026-05-01' }]);
  });
});

// ======================================================================
// ⑤ normalizeBizIdKey 归一（与仓储 normalizeKey = String().trim() 字节一致）
// ======================================================================
test.describe('⑤ normalizeBizIdKey', () => {
  test('trim 空白 / 非空字符串', () => {
    assert.equal(normalizeBizIdKey('  BIZ-A  '), 'BIZ-A');
    assert.equal(normalizeBizIdKey('BIZ-B'), 'BIZ-B');
  });
  test('null/undefined/空 → ""', () => {
    assert.equal(normalizeBizIdKey(null), '');
    assert.equal(normalizeBizIdKey(undefined), '');
    assert.equal(normalizeBizIdKey('   '), '');
  });
  test('number BizId → String 化', () => {
    assert.equal(normalizeBizIdKey(123456), '123456');
  });
});
