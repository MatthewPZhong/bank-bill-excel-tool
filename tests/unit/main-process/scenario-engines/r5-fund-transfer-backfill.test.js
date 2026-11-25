// v2.1.16-beta.2 R5 场景2「中台调拨订单对账ID回填」引擎单测（🔴 资金红线）
// PRD §四 需求 2（R2.1~R2.6） / TECH_DESIGN §5.3 / §4
//
// 覆盖：
//   ① 同日命中回填 ReconciliationId（断言写入网关 reconciliationid + modification + 银行行原地改写）
//   ② 同日无候选、±1day 命中
//   ③ 同日与 ±1day 都有候选 → 同日优先（Phase 分离）
//   ④ 严格 1v1（两条 gw 抢一条 bank → 第二条不命中）
//   ⑤ 金额 = |Credit-Debit| + signed Extra Fee，先加总再按分精度比较，合计后不再 abs
//   ⑥ 借贷方向：FundTransfer-out 用 Debit 侧、FundTransfer-in 用 Credit 侧的行通过 |credit-debit| 命中（双方向造数据）
//   ⑦ ReconciliationId 原值非空被覆盖 → 不发 warning 但仍写入（reconid-overwrite-backfill 已移除）
//   ⑧ 多候选 tie-break 取 bankPool 原序最前 + multi-bank-match-backfill warning
//
// 日期一律用纯字符串（与 engine-date-utils.test.js 同口径，复用 normalizeDateExportValue 解析）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5FundTransferBackfill,
  readR5MappedChannelDiagnosticRows,
  buildR5ChannelMissingDiagnosticPrefilter,
  createR5ChannelMissingDiagnosticSource,
  channelMissingDiagnosticKeyDigest,
  gwChannelMissingDiagnosticKey,
  amountEqual,
  bankAmountAbs,
  bankAmountEqualWithoutExtraFee,
  bankAmountWithExtraFee,
  gwAmountAbs
} = require('../../../../src/main-process/scenario-engines/r5-fund-transfer-backfill');

// ---- 测试夹具 ----------------------------------------------------------

// 网关行（真实小写表头）：TradeType / merchantid / currency / amount(单列) / Billdate / reconciliationid
function gwRow({
  tradeType = 'FundTransfer-out',
  merchantId = 'M001',
  currency = 'USD',
  amount = 100,
  billdate = '2026-06-07',
  reconId = 'GW-RECON-1'
} = {}) {
  return {
    TradeType: tradeType,
    merchantid: merchantId,
    currency,
    amount,
    Billdate: billdate,
    reconciliationid: reconId
  };
}

// 银行行（驼峰）：_rowId / FundType / MerchantId / Currency / Credit Amount + Debit Amount(双列) /
//                BillDate / ReconciliationId
//   方向语义：FundTransfer-out 一般出账走 Debit 侧；FundTransfer-in 一般入账走 Credit 侧。
//   金额匹配只看 |credit - debit|，故造数据时把发生额放在对应侧即可。
function bankRow({
  rowId = 'b1',
  fundType = 'FundTransfer-out',
  merchantId = 'M001',
  currency = 'USD',
  credit = 0,
  debit = 100,
  extraFee = '',
  billDate = '2026-06-07',
  reconId = ''
} = {}) {
  return {
    _rowId: rowId,
    FundType: fundType,
    MerchantId: merchantId,
    Currency: currency,
    'Credit Amount': credit,
    'Debit Amount': debit,
    'Extra Fee': extraFee,
    BillDate: billDate,
    ReconciliationId: reconId
  };
}

// ---- 金额口径单元（旧 bankAmountAbs / R5 含手续费金额 / amountEqual）----

test.describe('R5场景2 — Extra Fee 金额口径', () => {
  test('旧 bankAmountAbs 继续只算 |credit-debit|，不纳入 Extra Fee（DBS-Charge 兼容锁）', () => {
    assert.equal(bankAmountAbs({ 'Credit Amount': 0, 'Debit Amount': 100 }), 100); // 出账
    assert.equal(bankAmountAbs({ 'Credit Amount': 100, 'Debit Amount': 0 }), 100); // 入账
    assert.equal(bankAmountAbs({ 'Credit Amount': 30, 'Debit Amount': 80 }), 50);  // 混合 → |30-80|
    assert.equal(
      bankAmountAbs({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 25 }),
      100,
      '旧 helper 不得因 R5 Extra Fee 改造而改变'
    );
  });

  test('credit/debit 任一空/非数值按 0 计', () => {
    assert.equal(bankAmountAbs({ 'Credit Amount': '', 'Debit Amount': 100 }), 100);
    assert.equal(bankAmountAbs({ 'Debit Amount': 100 }), 100); // 缺 credit
    assert.equal(bankAmountAbs({}), 0); // 都缺 → 0（非 NaN）
  });

  test('DBS 旧口径比较器只比两侧绝对值到分，显式忽略 Extra Fee', () => {
    const bank = { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 25 };
    assert.equal(bankAmountEqualWithoutExtraFee({ amount: -100 }, bank), true);
    assert.equal(
      bankAmountEqualWithoutExtraFee({ amount: 125 }, bank),
      false,
      '不得因 Extra Fee=25 把 DBS 银行金额从 100 改成 125'
    );
  });

  test('bankAmountWithExtraFee = |credit-debit| + signed fee；空 fee=0，正负号原样参与', () => {
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': '5' }),
      105
    );
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': '-5' }),
      95
    );
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': '   ' }),
      100
    );
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': null }),
      100
    );
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100 }),
      100
    );
    assert.equal(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': '5e-1' }),
      100.5,
      '科学计数法手续费按数值参与'
    );
    assert.ok(Number.isNaN(
      bankAmountWithExtraFee({ 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 'bad-fee' })
    ));
  });

  test('gwAmountAbs = |amount|；非数值 → NaN', () => {
    assert.equal(gwAmountAbs({ amount: -100 }), 100);
    assert.equal(gwAmountAbs({ amount: 100 }), 100);
    assert.ok(Number.isNaN(gwAmountAbs({ amount: 'abc' })));
    assert.ok(Number.isNaN(gwAmountAbs({})));
  });

  test('amountEqual 精确到分：相等 true、差 1 分 false', () => {
    assert.equal(amountEqual({ amount: 100.5 }, { 'Credit Amount': 0, 'Debit Amount': 100.5 }), true);
    assert.equal(amountEqual({ amount: 100.5 }, { 'Credit Amount': 0, 'Debit Amount': 100.51 }), false);
    // 浮点漂移防御：0.1+0.2 类场景归分后仍相等
    assert.equal(amountEqual({ amount: 0.3 }, { 'Credit Amount': 0.1, 'Debit Amount': -0.2 }), true);
  });

  test('amountEqual 先加总再按分精度比较，不分别归分', () => {
    const bank = {
      'Credit Amount': 0,
      'Debit Amount': '100.004',
      'Extra Fee': '0.004'
    };
    assert.equal(amountEqual({ amount: '100.01' }, bank), true, '100.004+0.004=100.008 → 合计归分 100.01');
    assert.equal(amountEqual({ amount: '100.00' }, bank), false, '不得先把两项分别归分后再相加');
  });

  test('合计后不再 abs：银行合计 -50 时，对手金额正负都不命中', () => {
    const bank = { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': -150 };
    assert.equal(amountEqual({ amount: 50 }, bank), false);
    assert.equal(amountEqual({ amount: -50 }, bank), false, '对手仍取绝对值，负数也不得命中银行 -50');
  });

  test('主金额与负手续费抵消为 0 时按合计值匹配', () => {
    assert.equal(
      amountEqual(
        { amount: 0 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': -100 }
      ),
      true
    );
  });

  test('amountEqual 两侧任一非有限数 → false（不误判相等）', () => {
    assert.equal(amountEqual({ amount: 'x' }, { 'Credit Amount': 0, 'Debit Amount': 100 }), false);
    assert.equal(
      amountEqual(
        { amount: 100 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 'bad-fee' }
      ),
      false
    );
  });
});

// ---- v3.0.26 Extra Fee 端到端 -----------------------------------------

test.describe('R5场景2 — Extra Fee 端到端匹配与非法值退出', () => {
  test('正/负/空 fee 分别按 105/95/100 匹配', () => {
    const cases = [
      { rowId: 'positive', extraFee: 5, gwAmount: 105, reconId: 'GW-POS' },
      { rowId: 'negative', extraFee: -5, gwAmount: 95, reconId: 'GW-NEG' },
      { rowId: 'empty', extraFee: ' ', gwAmount: 100, reconId: 'GW-EMPTY' }
    ];

    for (const item of cases) {
      const banks = [bankRow({ rowId: item.rowId, debit: 100, extraFee: item.extraFee })];
      const result = runRound5FundTransferBackfill(
        [gwRow({ amount: item.gwAmount, reconId: item.reconId })],
        banks
      );
      assert.equal(result.modifications.length, 1, `${item.rowId} fee 应命中`);
      assert.equal(banks[0].ReconciliationId, item.reconId);
      assert.deepEqual(result.warnings, []);
    }
  });

  test('非空非法 fee 的银行行退出 R5、不占候选，并且一行只产生一次可见 warning', () => {
    const gws = [
      gwRow({ amount: 100, reconId: 'GW-FIRST' }),
      gwRow({ amount: 100, reconId: 'GW-SECOND' })
    ];
    const banks = [
      bankRow({ rowId: 'bad-fee', debit: 100, extraFee: 'oops' }),
      bankRow({ rowId: 'valid', debit: 100, extraFee: '' })
    ];

    const result = runRound5FundTransferBackfill(gws, banks);

    assert.equal(banks[0].ReconciliationId, '', '非法 fee 行退出 R5，不得被回填');
    assert.equal(banks[1].ReconciliationId, 'GW-FIRST', '非法行不占用候选，后续合法行仍可命中');
    assert.deepEqual(result.modifications.map((m) => m.rowId), ['valid']);
    assert.ok(!result.usedBankRowIds.has('bad-fee'), '非法 fee 行不得进入消费集');
    const feeWarnings = result.warnings.filter((warning) => warning.code === 'r5-invalid-extra-fee');
    assert.equal(feeWarnings.length, 1, '同一银行行面对多条网关行也只告警一次');
    assert.equal(feeWarnings[0].rowId, 'bad-fee');
    assert.equal(feeWarnings[0].field, 'Extra Fee');
    assert.equal(feeWarnings[0].rawValue, 'oops', 'warning 顶层保留原始手续费值');
    assert.deepEqual(
      feeWarnings[0].context,
      { rowId: 'bad-fee', field: 'Extra Fee', rawValue: 'oops' },
      'warning context 带银行行血缘、字段与原始手续费值'
    );
    assert.match(feeWarnings[0].message, /原始值「oops」/, '可见 message 必须展示原始手续费值');
    assert.match(feeWarnings[0].message, /退出 R5/);
  });

  test('对手池为空也不吞非法 fee warning', () => {
    const result = runRound5FundTransferBackfill(
      [],
      [bankRow({ rowId: 'bad-without-gateway', extraFee: 'oops' })]
    );
    assert.deepEqual(result.modifications, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'r5-invalid-extra-fee');
    assert.equal(result.warnings[0].rowId, 'bad-without-gateway');
  });

  test('非法 fee warning 按稳定 _rowId 优先去重；无 _rowId 才按对象身份', () => {
    const sameIdFirst = bankRow({ rowId: 'same-id', extraFee: 'first-bad' });
    const sameIdClone = bankRow({ rowId: 'same-id', extraFee: 'second-bad' });
    const anonymousShared = bankRow({ rowId: 'remove-me-1', extraFee: 'anonymous-shared' });
    const anonymousDistinct = bankRow({ rowId: 'remove-me-2', extraFee: 'anonymous-distinct' });
    delete anonymousShared._rowId;
    delete anonymousDistinct._rowId;

    const result = runRound5FundTransferBackfill(
      [],
      [sameIdFirst, sameIdClone, anonymousShared, anonymousShared, anonymousDistinct]
    );
    const feeWarnings = result.warnings.filter((warning) => warning.code === 'r5-invalid-extra-fee');

    assert.deepEqual(
      feeWarnings.map((warning) => warning.rawValue),
      ['first-bad', 'anonymous-shared', 'anonymous-distinct'],
      '同 _rowId 的不同对象只告警一次；无 _rowId 的同对象去重、不同对象分别告警'
    );
  });
});

// ---- ① 同日命中回填 ----------------------------------------------------

test.describe('R5场景2 — ① 同日命中回填 ReconciliationId', () => {
  test('out 方向同日 + 字段全等 + 金额绝对值相等 → 银行 ReconciliationId 写为网关 reconciliationid', () => {
    const gws = [gwRow({ reconId: 'GW-1', amount: 100, billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, warnings } = runRound5FundTransferBackfill(gws, banks);

    // 银行行被原地改写
    assert.equal(banks[0].ReconciliationId, 'GW-1', '银行 ReconciliationId 应被回填为网关 reconciliationid');
    // 产 1 条 modification（标黄 ReconciliationId 列）
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1',
      column: 'ReconciliationId',
      oldValue: '',
      newValue: 'GW-1'
    });
    // 原值为空覆盖 → 不发 overwrite warning
    assert.deepEqual(warnings, []);
  });

  test('字段不等（merchantid 不同）→ 不命中、不改写', () => {
    const gws = [gwRow({ merchantId: 'M001', reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'M999', debit: 100, reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0);
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('币种不等 → 不命中', () => {
    const gws = [gwRow({ currency: 'USD', reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', currency: 'HKD', debit: 100, reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0);
  });
});

// ---- ② 同日无候选、±1day 命中 -----------------------------------------

test.describe('R5场景2 — ② 同日无候选 → ±1day 命中', () => {
  test('网关 06-07、银行 06-08（差 1 天）、同日无候选 → ±1day 命中回填', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-08', reconId: '' })];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, '差 1 天应在 Phase2 命中');
    assert.equal(banks[0].ReconciliationId, 'GW-1');
  });

  test('差 2 天 → 超出 ±1day，不命中', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-09', reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, '差 2 天超出 ±1day 不命中');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('dateToleranceDays 可 config 化：差 2 天 + tolerance=2 → 命中', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-09', reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks, { dateToleranceDays: 2 });
    assert.equal(modifications.length, 1);
  });
});

// ---- ③ 同日优先（Phase 分离）-----------------------------------------

test.describe('R5场景2 — ③ 同日与 ±1day 都有候选时同日优先', () => {
  test('一条 gw（06-07），两条候选银行：b_diff(06-08) + b_same(06-07) → 消费同日那条', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    // 注意 bankPool 原序：差 1 天的排在前、同日的排在后；若无 Phase 分离会先选差 1 天的
    const banks = [
      bankRow({ rowId: 'b_diff', debit: 100, billDate: '2026-06-08', reconId: '' }),
      bankRow({ rowId: 'b_same', debit: 100, billDate: '2026-06-07', reconId: '' })
    ];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].rowId, 'b_same', '应优先消费同日银行行（Phase1 先于 Phase2）');
    assert.equal(banks[1].ReconciliationId, 'GW-1'); // b_same 被回填
    assert.equal(banks[0].ReconciliationId, '');      // b_diff 未被回填
  });

  test('同日优先是硬约束（即使同日候选在数组更后位）+ 第二条 gw 才用 ±1day 那条', () => {
    // 两条 gw 同 reconid 来源不同：gw1→消费同日 b_same，gw2→只剩 b_diff 走 ±1day
    const gws = [
      gwRow({ reconId: 'GW-1', billdate: '2026-06-07' }),
      gwRow({ reconId: 'GW-2', billdate: '2026-06-07' })
    ];
    const banks = [
      bankRow({ rowId: 'b_diff', debit: 100, billDate: '2026-06-08', reconId: '' }),
      bankRow({ rowId: 'b_same', debit: 100, billDate: '2026-06-07', reconId: '' })
    ];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 2);
    // GW-1 应落到同日 b_same；GW-2 落到 b_diff（±1day）
    const byRow = Object.fromEntries(modifications.map((m) => [m.rowId, m.newValue]));
    assert.equal(byRow['b_same'], 'GW-1', 'Phase1 同日：第一条 gw 消费同日行');
    assert.equal(byRow['b_diff'], 'GW-2', 'Phase2 ±1day：第二条 gw 消费剩余行');
  });

  test('全局 Phase1：前序 gw 的 +1 候选必须先留给后序 gw 的同日匹配', () => {
    const gws = [
      gwRow({ reconId: 'GW-FIRST', billdate: '2026-07-10' }),
      gwRow({ reconId: 'GW-SAME-DAY', billdate: '2026-07-11' })
    ];
    const banks = [
      bankRow({ rowId: 'b-0711', debit: 100, billDate: '2026-07-11', reconId: '' }),
      bankRow({ rowId: 'b-0709', debit: 100, billDate: '2026-07-09', reconId: '' })
    ];

    const result = runRound5FundTransferBackfill(gws, banks, {
      fundTransferDatePolicy: { enabled: true, toleranceDays: 1 }
    });

    assert.equal(banks[0].ReconciliationId, 'GW-SAME-DAY');
    assert.equal(banks[1].ReconciliationId, 'GW-FIRST');
    assert.deepEqual(
      result.modifications.map((item) => [item.rowId, item.newValue]),
      [['b-0711', 'GW-SAME-DAY'], ['b-0709', 'GW-FIRST']]
    );
  });
});

// ---- ④ 严格 1v1 -------------------------------------------------------

test.describe('R5场景2 — ④ 严格 1v1 单向消费', () => {
  test('两条 gw 抢同一条 bank（同字段同日）→ 仅第一条命中，第二条不命中', () => {
    const gws = [
      gwRow({ reconId: 'GW-1', billdate: '2026-06-07' }),
      gwRow({ reconId: 'GW-2', billdate: '2026-06-07' })
    ];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, '一条 bank 只能被一条 gw 消费');
    assert.equal(modifications[0].newValue, 'GW-1', '应是第一条 gw 命中');
    assert.equal(banks[0].ReconciliationId, 'GW-1');
  });
});

// ---- F1 空 reconid 网关行不得占用银行候选 -----------------------------

test.describe('R5场景2 — F1 空 reconciliationid 网关行不占用银行候选', () => {
  test('空 reconid gw 不消费银行行 → 后续有效 reconid gw 仍能回填该行', () => {
    // 两条同 direction 网关行：第 1 条 reconid 空、第 2 条有效；均同字段/同日匹配同一条银行行
    const gws = [
      gwRow({ reconId: '', billdate: '2026-06-07', amount: 100 }),
      gwRow({ reconId: 'GW-VALID', billdate: '2026-06-07', amount: 100 })
    ];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    // 空 reconid 行不进 gwPool、不占用 b1 → 有效行成功回填 b1
    assert.equal(modifications.length, 1, '空 reconid 行不应占用银行行，有效行应回填');
    assert.equal(modifications[0].rowId, 'b1');
    assert.equal(modifications[0].newValue, 'GW-VALID');
    assert.equal(banks[0].ReconciliationId, 'GW-VALID', '银行行被有效 reconid 回填');
  });
});

// ---- F2 Phase2 多候选按 |Δday| 最小优先 --------------------------------

test.describe('R5场景2 — F2 Phase2 多候选按绝对天数差最小优先', () => {
  test('tolerance=2、bankPool 中差 2 天候选排在差 1 天前面 → 选中差 1 天那条', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    // 都非同日（Phase1 不命中）、字段/金额都匹配；原序故意把差 2 天放前面
    const banks = [
      bankRow({ rowId: 'b_diff2', debit: 100, billDate: '2026-06-09', reconId: '' }), // 差 2 天，排前
      bankRow({ rowId: 'b_diff1', debit: 100, billDate: '2026-06-08', reconId: '' })  // 差 1 天，排后
    ];

    const { modifications } = runRound5FundTransferBackfill(gws, banks, { dateToleranceDays: 2 });
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].rowId, 'b_diff1', 'Phase2 应优先选绝对天数差最小（差 1 天）的候选');
    assert.equal(banks[1].ReconciliationId, 'GW-1');
    assert.equal(banks[0].ReconciliationId, '', '差 2 天候选未被消费');
  });
});

// ---- ⑤ 金额发生额绝对值精确到分（端到端）-----------------------------

test.describe('R5场景2 — ⑤ 金额精确到分匹配（端到端）', () => {
  test('相差 1 分（0.01）→ 不命中', () => {
    const gws = [gwRow({ amount: 100.00, reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100.01, reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, '相差 1 分不命中');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('金额相等（含分位）→ 命中', () => {
    const gws = [gwRow({ amount: 100.01, reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100.01, reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, '分位完全相等应命中');
    assert.equal(banks[0].ReconciliationId, 'GW-1');
  });

  test('网关金额带负号、银行走 debit → |amount| 与 |credit-debit| 相等命中', () => {
    const gws = [gwRow({ amount: -250.75, reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', credit: 0, debit: 250.75, reconId: '' })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1);
  });
});

// ---- ⑥ 借贷方向（双方向）---------------------------------------------

test.describe('R5场景2 — ⑥ 借贷方向：out 用 Debit 侧、in 用 Credit 侧', () => {
  test('FundTransfer-out：银行发生额在 Debit 侧 → 通过 |credit-debit| 命中', () => {
    const gws = [gwRow({ tradeType: 'FundTransfer-out', amount: 500, reconId: 'GW-OUT' })];
    const banks = [
      bankRow({ rowId: 'b1', fundType: 'FundTransfer-out', credit: 0, debit: 500, reconId: '' })
    ];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, 'out 方向 Debit 侧应命中');
    assert.equal(banks[0].ReconciliationId, 'GW-OUT');
  });

  test('FundTransfer-in：银行发生额在 Credit 侧 → 通过 |credit-debit| 命中', () => {
    const gws = [gwRow({ tradeType: 'FundTransfer-in', amount: 600, reconId: 'GW-IN' })];
    const banks = [
      bankRow({ rowId: 'b1', fundType: 'FundTransfer-in', credit: 600, debit: 0, reconId: '' })
    ];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, 'in 方向 Credit 侧应命中');
    assert.equal(banks[0].ReconciliationId, 'GW-IN');
  });

  test('两方向独立跑：out 网关不会命中 in 银行行（FundType 过滤隔离池子）', () => {
    const gws = [gwRow({ tradeType: 'FundTransfer-out', amount: 700, reconId: 'GW-OUT' })];
    // 银行行是 in 方向（FundType=FundTransfer-in）、金额/字段都对得上，但方向不同
    const banks = [
      bankRow({ rowId: 'b1', fundType: 'FundTransfer-in', credit: 700, debit: 0, reconId: '' })
    ];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, 'out 网关不应命中 in 银行行（池子隔离）');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('out + in 各一对，混在一起 → 各自命中各自方向', () => {
    const gws = [
      gwRow({ tradeType: 'FundTransfer-out', amount: 500, reconId: 'GW-OUT' }),
      gwRow({ tradeType: 'FundTransfer-in', amount: 600, reconId: 'GW-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: 'FundTransfer-out', credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: 'FundTransfer-in', credit: 600, debit: 0, reconId: '' })
    ];
    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 2);
    const byRow = Object.fromEntries(modifications.map((m) => [m.rowId, m.newValue]));
    assert.equal(byRow['bo'], 'GW-OUT');
    assert.equal(byRow['bi'], 'GW-IN');
  });
});

// ---- ⑦ 原值非空被覆盖 -------------------------------------------------

test.describe('R5场景2 — ⑦ ReconciliationId 原值非空被覆盖', () => {
  test('银行 ReconciliationId 原值非空 → 不发 overwrite warning 但仍写入', () => {
    const gws = [gwRow({ reconId: 'GW-NEW' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, reconId: 'OLD-RECON' })];

    const { modifications, warnings } = runRound5FundTransferBackfill(gws, banks);
    // 仍写入新值
    assert.equal(banks[0].ReconciliationId, 'GW-NEW', '原值非空仍被覆盖写入');
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1',
      column: 'ReconciliationId',
      oldValue: 'OLD-RECON',
      newValue: 'GW-NEW'
    });
    // 该告警已移除：覆盖非空原值不再产生 reconid-overwrite-backfill warning
    const overwriteWarn = warnings.find((w) => w.code === 'reconid-overwrite-backfill');
    assert.ok(!overwriteWarn, '覆盖非空原值不应再发 reconid-overwrite-backfill warning');
  });

  test('原值已等于网关 reconid → 不重复写、不发 overwrite warning（同值不标黄）', () => {
    const gws = [gwRow({ reconId: 'SAME-RECON' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, reconId: 'SAME-RECON' })];

    const { modifications, warnings } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, '原值已相等不产 modification');
    assert.deepEqual(warnings, []);
  });

  test('网关 reconciliationid 为空 → 不写（不会把银行原值清空）', () => {
    const gws = [gwRow({ reconId: '' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, reconId: 'KEEP-ME' })];

    const { modifications } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, '网关 reconid 为空不写');
    assert.equal(banks[0].ReconciliationId, 'KEEP-ME', '银行原值不被清空');
  });
});

// ---- usedBankRowIds 返回字段（🔴 v3.0.4 块 F：含同值未写行）---------------

test.describe('R5场景2 — usedBankRowIds 完整消费集（含同值未写行）', () => {
  test('实写命中行 → usedBankRowIds 含该 _rowId（与 modification 一致）', () => {
    const gws = [gwRow({ reconId: 'GW-1', amount: 100, billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1);
    assert.ok(usedBankRowIds instanceof Set, 'usedBankRowIds 应为 Set');
    assert.ok(usedBankRowIds.has('b1'), '实写命中行进消费集');
    assert.equal(usedBankRowIds.size, 1);
  });

  test('🔴 同值未写命中行 → 不产 modification 但 usedBankRowIds 仍含该 _rowId（窄缺口闭合核心断言）', () => {
    // 银行原值已等于网关 reconid → backfill 内 old===nv 不 record（modifications 空），
    //   但 usedBankRowId.add(chosen._rowId) 已消费 → 必须出现在 usedBankRowIds。
    const gws = [gwRow({ reconId: 'SAME-RECON', billdate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b_same', debit: 100, billDate: '2026-06-07', reconId: 'SAME-RECON' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 0, '同值不产 modification');
    assert.ok(usedBankRowIds instanceof Set);
    assert.ok(
      usedBankRowIds.has('b_same'),
      '同值未写行虽不在 modifications，但已被 1v1 消费 → 必须出现在 usedBankRowIds（供 R5s2b 剔除）'
    );
    assert.equal(usedBankRowIds.size, 1);
  });

  test('双方向各消费一行 → usedBankRowIds 聚合两方向（跨 direction union）', () => {
    const gws = [
      gwRow({ tradeType: 'FundTransfer-out', amount: 500, reconId: 'GW-OUT' }),
      gwRow({ tradeType: 'FundTransfer-in', amount: 600, reconId: 'GW-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: 'FundTransfer-out', credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: 'FundTransfer-in', credit: 600, debit: 0, reconId: '' })
    ];
    const { usedBankRowIds } = runRound5FundTransferBackfill(gws, banks);
    assert.ok(usedBankRowIds.has('bo') && usedBankRowIds.has('bi'), '两方向消费行都进聚合集');
    assert.equal(usedBankRowIds.size, 2);
  });

  test('未命中 / 空入参 → usedBankRowIds 为空 Set（不为 undefined）', () => {
    // 字段不等 → 不消费
    const r1 = runRound5FundTransferBackfill(
      [gwRow({ merchantId: 'M001', reconId: 'GW-1' })],
      [bankRow({ rowId: 'b1', merchantId: 'M999', debit: 100 })]
    );
    assert.ok(r1.usedBankRowIds instanceof Set && r1.usedBankRowIds.size === 0, '未命中 → 空 Set');
    // 空入参
    assert.ok(runRound5FundTransferBackfill([], []).usedBankRowIds instanceof Set);
    assert.equal(runRound5FundTransferBackfill([], []).usedBankRowIds.size, 0);
    assert.ok(runRound5FundTransferBackfill(null, null).usedBankRowIds instanceof Set);
  });
});

// ---- ⑧ 多候选 tie-break -----------------------------------------------

test.describe('R5场景2 — ⑧ 多候选 tie-break 取 bankPool 原序最前', () => {
  test('一条 gw 同日命中两条银行行 → 取原序最前 + multi-bank-match-backfill warning', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    const banks = [
      bankRow({ rowId: 'b_first', debit: 100, billDate: '2026-06-07', reconId: '' }),
      bankRow({ rowId: 'b_second', debit: 100, billDate: '2026-06-07', reconId: '' })
    ];

    const { modifications, warnings } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1, '1v1：只回填一条');
    assert.equal(modifications[0].rowId, 'b_first', 'tie-break 取 bankPool 原序最前');
    assert.equal(banks[0].ReconciliationId, 'GW-1');
    assert.equal(banks[1].ReconciliationId, '', '第二条候选不被回填');

    const multiWarn = warnings.find((w) => w.code === 'multi-bank-match-backfill');
    assert.ok(multiWarn, '多候选应发 multi-bank-match-backfill warning');
    assert.equal(multiWarn.phase, 'same-day');
  });

  test('Phase2（±1day）多候选同样取原序最前 + warning（phase 标 ±1day）', () => {
    const gws = [gwRow({ reconId: 'GW-1', billdate: '2026-06-07' })];
    const banks = [
      bankRow({ rowId: 'b_first', debit: 100, billDate: '2026-06-08', reconId: '' }),
      bankRow({ rowId: 'b_second', debit: 100, billDate: '2026-06-06', reconId: '' })
    ];

    const { modifications, warnings } = runRound5FundTransferBackfill(gws, banks);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].rowId, 'b_first', 'Phase2 tie-break 取原序最前');
    const multiWarn = warnings.find((w) => w.code === 'multi-bank-match-backfill');
    assert.ok(multiWarn);
    assert.equal(multiWarn.phase, '±1day');
  });
});

test.describe('R5场景2 v3.1.1 — 严格真实方向与 eligibleCandidates', () => {
  test('FundType 路由相同但真实方向相反：不计入 multi、不消费；后置正确方向行被选中', () => {
    const gws = [gwRow({ tradeType: 'FundTransfer-out', amount: 100, reconId: 'GW-STRICT' })];
    const wrong = bankRow({
      rowId: 'wrong-credit',
      fundType: 'FundTransfer-out',
      credit: 100,
      debit: 0,
      reconId: ''
    });
    const correct = bankRow({
      rowId: 'correct-debit',
      fundType: 'FundTransfer-out',
      credit: 0,
      debit: 100,
      reconId: ''
    });

    const result = runRound5FundTransferBackfill(gws, [wrong, correct]);

    assert.deepEqual(result.modifications.map((item) => item.rowId), ['correct-debit']);
    assert.deepEqual(Array.from(result.usedBankRowIds), ['correct-debit']);
    assert.equal(wrong.ReconciliationId, '');
    assert.equal(result.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 0);
    const directionWarning = result.warnings.find((item) => item.code === 'fund-transfer-direction-mismatch');
    assert.ok(directionWarning);
    assert.equal(directionWarning.rowId, 'wrong-credit');
    assert.equal(directionWarning.expectedDirection, 'DEBIT');
    assert.equal(directionWarning.reason, 'expected-zero');
  });

  test('只有方向失败近似候选时零消费、零改写，且告警不泄露账号', () => {
    const result = runRound5FundTransferBackfill(
      [gwRow({ tradeType: 'FundTransfer-in', amount: 100, reconId: 'GW-IN' })],
      [bankRow({
        rowId: 'wrong-debit',
        fundType: 'FundTransfer-in',
        credit: 0,
        debit: 100,
        reconId: ''
      })]
    );

    assert.deepEqual(result.modifications, []);
    assert.equal(result.usedBankRowIds.size, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'fund-transfer-direction-mismatch');
    assert.equal(result.warnings[0].expectedDirection, 'CREDIT');
    assert.ok(!result.warnings[0].message.includes('M001'));
  });
});

test.describe('R5场景2 v3.1.1 — 日期策略启停与稳定排序', () => {
  test('日期关闭完全跳过日期：来源/银行日期非法仍按其它严格条件命中', () => {
    const gws = [gwRow({ reconId: 'GW-NO-DATE', billdate: 'not-a-date' })];
    const banks = [bankRow({ rowId: 'b-no-date', debit: 100, billDate: '', reconId: '' })];
    const result = runRound5FundTransferBackfill(gws, banks, {
      fundTransferDatePolicy: { enabled: false, toleranceDays: 7 }
    });

    assert.deepEqual(result.modifications.map((item) => item.rowId), ['b-no-date']);
    assert.deepEqual(result.warnings, []);
  });

  test('日期开启但近似候选日期非法：不降级、零消费并产可审计日期告警', () => {
    const result = runRound5FundTransferBackfill(
      [gwRow({ tradeType: 'FundTransfer-in', reconId: 'GW-BAD-DATE', billdate: 'not-a-date' })],
      [bankRow({
        rowId: 'b-date',
        fundType: 'FundTransfer-in',
        credit: 100,
        debit: 0,
        billDate: '2026-07-10',
        reconId: ''
      })],
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 7 } }
    );

    assert.deepEqual(result.modifications, []);
    assert.equal(result.usedBankRowIds.size, 0);
    const dateWarnings = result.warnings.filter((item) => item.code === 'fund-transfer-date-mismatch');
    assert.equal(dateWarnings.length, 1, 'Phase1/Phase2 对同一失败候选只告警一次');
    const warning = dateWarnings[0];
    assert.equal(warning.rowId, 'b-date');
    assert.equal(warning.expectedDirection, 'CREDIT');
    assert.equal(warning.reason, 'counterpart-date-invalid');
    assert.ok(!JSON.stringify(warning).includes('M001'));
  });

  test('同一来源已有同日合法候选时，日期非法 near-candidate 仍告警且不进入 multi/消费/改写', () => {
    const valid = bankRow({
      rowId: 'same-day-valid',
      debit: 100,
      billDate: '2026-07-10',
      reconId: ''
    });
    const invalid = bankRow({
      rowId: 'invalid-date-near',
      debit: 100,
      billDate: 'not-a-date',
      reconId: ''
    });
    const outside = bankRow({
      rowId: 'outside-date-near',
      debit: 100,
      billDate: '2026-07-12',
      reconId: ''
    });
    const result = runRound5FundTransferBackfill(
      [gwRow({ reconId: 'GW-AUDIT', billdate: '2026-07-10' })],
      [valid, invalid, outside],
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 1 } }
    );

    assert.equal(valid.ReconciliationId, 'GW-AUDIT');
    assert.equal(invalid.ReconciliationId, '');
    assert.equal(outside.ReconciliationId, '');
    assert.deepEqual(result.modifications.map((item) => item.rowId), ['same-day-valid']);
    assert.deepEqual(Array.from(result.usedBankRowIds), ['same-day-valid']);
    assert.equal(result.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 0);
    const dateWarnings = result.warnings.filter((item) => item.code === 'fund-transfer-date-mismatch');
    assert.deepEqual(
      dateWarnings.map((item) => [item.rowId, item.reason]),
      [
        ['invalid-date-near', 'bank-date-invalid'],
        ['outside-date-near', 'outside-tolerance']
      ]
    );
    assert.ok(!JSON.stringify(dateWarnings).includes('M001'));
  });

  test('25×25 日期失败密集组按银行行/方向/原因去重，Phase1/2 不放大为 625 条', () => {
    const secretAccount = 'DENSE-SECRET-ACCOUNT';
    const gateways = Array.from({ length: 25 }, (_, index) => gwRow({
      merchantId: secretAccount,
      reconId: `DENSE-GW-${index}`,
      billdate: '2026-07-01'
    }));
    const banks = Array.from({ length: 25 }, (_, index) => bankRow({
      rowId: `dense-bank-${index}`,
      merchantId: secretAccount,
      debit: 100,
      reconId: '',
      billDate: '2026-08-01'
    }));
    // 无稳定 _rowId 时仍必须按银行原始行序区分，不能把两条真实银行行误并成一条 warning。
    delete banks[23]._rowId;
    delete banks[24]._rowId;
    const sourceBefore = structuredClone(gateways);
    const banksBefore = structuredClone(banks);

    const result = runRound5FundTransferBackfill(gateways, banks, {
      fundTransferDatePolicy: { enabled: true, toleranceDays: 1 }
    });
    const dateWarnings = result.warnings.filter(
      (warning) => warning.code === 'fund-transfer-date-mismatch'
    );

    assert.equal(dateWarnings.length, 25, '25×25 失败边应收敛为每条银行行 1 条，而非 625 条');
    assert.ok(dateWarnings.every((warning) => warning.expectedDirection === 'DEBIT'));
    assert.ok(dateWarnings.every((warning) => warning.reason === 'outside-tolerance'));
    assert.equal(dateWarnings.filter((warning) => warning.rowId === undefined).length, 2);
    assert.equal(JSON.stringify(dateWarnings).includes(secretAccount), false, '告警不得泄露完整账号');
    assert.deepEqual(result.modifications, [], '日期失败不得产生改写');
    assert.equal(result.usedBankRowIds.size, 0, '日期失败不得消费银行行');
    assert.deepEqual(gateways, sourceBefore, '网关来源行保持只读');
    assert.deepEqual(banks, banksBefore, '银行行保持未消费、未改写');
  });

  test('同一银行行的不同日期失败原因分别保留', () => {
    const bank = bankRow({
      rowId: 'multi-reason-bank',
      merchantId: 'M001',
      debit: 100,
      billDate: '2026-08-01'
    });
    const result = runRound5FundTransferBackfill(
      [
        gwRow({ reconId: 'INVALID-SOURCE', billdate: 'not-a-date' }),
        gwRow({ reconId: 'OUTSIDE-SOURCE', billdate: '2026-07-01' })
      ],
      [bank],
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 1 } }
    );

    assert.deepEqual(
      result.warnings
        .filter((warning) => warning.code === 'fund-transfer-date-mismatch')
        .map((warning) => warning.reason)
        .sort(),
      ['counterpart-date-invalid', 'outside-tolerance']
    );
    assert.deepEqual(result.modifications, []);
    assert.equal(result.usedBankRowIds.size, 0);
  });

  test('±7 边界包含、+8 排除', () => {
    const gws = [gwRow({ reconId: 'GW-N7', billdate: '2026-07-01' })];
    const banks = [
      bankRow({ rowId: 'plus-8', debit: 100, billDate: '2026-07-09', reconId: '' }),
      bankRow({ rowId: 'plus-7', debit: 100, billDate: '2026-07-08', reconId: '' })
    ];
    const result = runRound5FundTransferBackfill(gws, banks, {
      fundTransferDatePolicy: { enabled: true, toleranceDays: 7 }
    });

    assert.deepEqual(result.modifications.map((item) => item.rowId), ['plus-7']);
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('绝对日期差相等时按银行原序；反转原序后选择随之反转，均保留多候选告警', () => {
    const run = (ids) => {
      const rowsById = {
        past: bankRow({ rowId: 'past', debit: 100, billDate: '2026-07-09', reconId: '' }),
        future: bankRow({ rowId: 'future', debit: 100, billDate: '2026-07-11', reconId: '' })
      };
      return runRound5FundTransferBackfill(
        [gwRow({ reconId: 'GW-TIE', billdate: '2026-07-10' })],
        ids.map((id) => rowsById[id]),
        { fundTransferDatePolicy: { enabled: true, toleranceDays: 1 } }
      );
    };

    const futureFirst = run(['future', 'past']);
    const pastFirst = run(['past', 'future']);
    assert.deepEqual(futureFirst.modifications.map((item) => item.rowId), ['future']);
    assert.deepEqual(pastFirst.modifications.map((item) => item.rowId), ['past']);
    assert.equal(futureFirst.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 1);
    assert.equal(pastFirst.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 1);
  });
});

test.describe('R5场景2 v3.1.1 — directions 配置整体失败关闭', () => {
  const canonical = [
    { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
    { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
  ];

  test('重复、缺项、额外、错配、未知与显式缺失都只告警一次且不启动消费集', () => {
    const invalidConfigs = [
      undefined,
      [canonical[0]],
      [canonical[0], canonical[0]],
      [...canonical, { gwTradeType: 'extra', bankFundType: 'extra' }],
      [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-in' },
        canonical[1]
      ],
      [canonical[0], { gwTradeType: 'UNKNOWN', bankFundType: 'UNKNOWN' }]
    ];

    for (const directions of invalidConfigs) {
      const bank = bankRow({ rowId: 'b-config', debit: 100, reconId: '' });
      const result = runRound5FundTransferBackfill([gwRow({ reconId: 'GW-CONFIG' })], [bank], {
        directions
      });
      assert.deepEqual(result.modifications, []);
      assert.equal(result.usedBankRowIds.size, 0);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'r5-fund-transfer-directions-invalid');
      assert.equal(bank.ReconciliationId, '');
    }
  });

  test('两个 canonical 配对顺序反转仍完整执行', () => {
    const result = runRound5FundTransferBackfill(
      [gwRow({ tradeType: 'FundTransfer-out', reconId: 'GW-VALID' })],
      [bankRow({ rowId: 'b-valid', fundType: 'FundTransfer-out', debit: 100, reconId: '' })],
      { directions: [canonical[1], canonical[0]] }
    );
    assert.deepEqual(result.modifications.map((item) => item.rowId), ['b-valid']);
    assert.equal(result.warnings.length, 0);
  });
});

// ---- 边界兜底 ----------------------------------------------------------

test.describe('R5场景2 — 边界兜底', () => {
  test('空 gwRows / 空 bankRows / 非数组入参 不崩，返回空 modifications', () => {
    assert.deepEqual(runRound5FundTransferBackfill([], []).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill(null, null).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill(undefined, undefined).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill([gwRow()], []).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill([], [bankRow()]).modifications, []);
  });

  test('directions 缺少一个方向时整轮失败关闭：零改写、零消费、只告警一次', () => {
    const gws = [
      gwRow({ tradeType: 'FundTransfer-out', amount: 500, reconId: 'GW-OUT' }),
      gwRow({ tradeType: 'FundTransfer-in', amount: 600, reconId: 'GW-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: 'FundTransfer-out', credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: 'FundTransfer-in', credit: 600, debit: 0, reconId: '' })
    ];
    const { modifications, warnings, usedBankRowIds } = runRound5FundTransferBackfill(gws, banks, {
      directions: [{ gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' }]
    });
    assert.deepEqual(modifications, []);
    assert.equal(usedBankRowIds.size, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'r5-fund-transfer-directions-invalid');
    assert.equal(warnings[0].rowId, null);
    assert.equal(banks[0].ReconciliationId, '');
    assert.equal(banks[1].ReconciliationId, '');
  });
});

// ---- v3.2.22 账户映射：网关 merchantid 先映射再匹配（🔴 资金红线）----------------

test.describe('R5场景2 — v3.2.22 网关 merchantid 按账户映射取值', () => {
  const mapping = () => new Map([['GW-ACC-1', 'CLR-ACC-1']]);

  test('网关账户号与银行 MerchantId 不同：无映射不命中，有映射后 in/out 两方向都回填', () => {
    const makeRows = () => ({
      gws: [
        { ...gwRow({ tradeType: 'FundTransfer-out', merchantId: 'GW-ACC-1', amount: 500, reconId: 'GW-OUT' }), Channel: 'JPM' },
        { ...gwRow({ tradeType: 'FundTransfer-in', merchantId: ' GW-ACC-1 ', amount: 600, reconId: 'GW-IN' }), Channel: 'JPM' }
      ],
      banks: [
        { ...bankRow({ rowId: 'bo', fundType: 'FundTransfer-out', merchantId: 'CLR-ACC-1', credit: 0, debit: 500 }), Channel: 'JPM' },
        { ...bankRow({ rowId: 'bi', fundType: 'FundTransfer-in', merchantId: 'CLR-ACC-1', credit: 600, debit: 0 }), Channel: 'JPM' }
      ]
    });

    const before = makeRows();
    const unmapped = runRound5FundTransferBackfill(before.gws, before.banks);
    assert.deepEqual(unmapped.modifications, []);
    assert.equal(unmapped.usedBankRowIds.size, 0);

    const after = makeRows();
    const mapped = runRound5FundTransferBackfill(after.gws, after.banks, { accountMappingMap: mapping() });
    assert.deepEqual(
      mapped.modifications.map((m) => [m.rowId, m.newValue]).sort(),
      [['bi', 'GW-IN'], ['bo', 'GW-OUT']]
    );
    assert.equal(after.banks[0].ReconciliationId, 'GW-OUT');
    assert.equal(after.banks[1].ReconciliationId, 'GW-IN');
    // 网关行本身不被改写（映射只用于匹配取值）
    assert.equal(after.gws[0].merchantid, 'GW-ACC-1');
  });

  test('映射命中但银行 MerchantId 仍是网关原账户号 → 不命中（与调拨来源「替换」语义一致）', () => {
    const gws = [gwRow({ merchantId: 'GW-ACC-1', reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'GW-ACC-1', debit: 100 })];
    const { modifications, usedBankRowIds } = runRound5FundTransferBackfill(gws, banks, {
      accountMappingMap: mapping()
    });
    assert.deepEqual(modifications, []);
    assert.equal(usedBankRowIds.size, 0);
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('网关账户号不在映射表 → 按原值匹配（未命中原样）', () => {
    const gws = [gwRow({ merchantId: 'M001', reconId: 'GW-1' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'M001', debit: 100 })];
    const { modifications } = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: mapping() });
    assert.deepEqual(modifications.map((m) => m.newValue), ['GW-1']);
  });

  test('空映射 / 非 Map 与不传完全一致（零变化）', () => {
    const run = (options) => {
      const gws = [gwRow({ merchantId: 'M001', reconId: 'GW-1' }), gwRow({ merchantId: 'GW-ACC-1', reconId: 'GW-2' })];
      const banks = [
        bankRow({ rowId: 'b1', merchantId: 'M001', debit: 100 }),
        bankRow({ rowId: 'b2', merchantId: 'CLR-ACC-1', debit: 100 })
      ];
      const result = runRound5FundTransferBackfill(gws, banks, options);
      return { modifications: result.modifications, warnings: result.warnings, used: [...result.usedBankRowIds], banks };
    };
    const baseline = run(undefined);
    assert.deepEqual(run({ accountMappingMap: new Map() }), baseline);
    assert.deepEqual(run({ accountMappingMap: { 'GW-ACC-1': 'CLR-ACC-1' } }), baseline);
    assert.deepEqual(baseline.used, ['b1']);
  });

  test('映射命中的网关行只与同 Channel 银行行配对：不串到另一渠道的同账号银行行', () => {
    const map = new Map([['ALIAS', 'CLR']]);
    const jpmGw = () => ({ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-JPM' }), Channel: 'JPM' });
    const dbsBank = () => ({ ...bankRow({ rowId: 'b-dbs', merchantId: 'CLR' }), Channel: 'DBS' });
    const jpmBank = () => ({ ...bankRow({ rowId: 'b-jpm', merchantId: 'CLR' }), Channel: ' JPM ' });

    // 只有另一渠道的同账号银行行 → 不回填、不消费
    const onlyDbs = [dbsBank()];
    const crossChannel = runRound5FundTransferBackfill([jpmGw()], onlyDbs, { accountMappingMap: map });
    assert.deepEqual(crossChannel.modifications, []);
    assert.equal(crossChannel.usedBankRowIds.size, 0);
    assert.equal(onlyDbs[0].ReconciliationId, '');

    // 同时有本渠道银行行（原序靠后）→ 跳过 DBS 行，回填 JPM 行（Channel 按 trim 比较）
    const both = [dbsBank(), jpmBank()];
    const sameChannel = runRound5FundTransferBackfill([jpmGw()], both, { accountMappingMap: map });
    assert.deepEqual(sameChannel.modifications.map((m) => [m.rowId, m.newValue]), [['b-jpm', 'GW-JPM']]);
    assert.equal(both[0].ReconciliationId, '');
    assert.equal(sameChannel.warnings.filter((w) => w.code === 'multi-bank-match-backfill').length, 0);
  });

  test('与映射命中行争用同一目标账号的原账号行也只回填同渠道银行行', () => {
    const jpmGws = () => [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-CLR' }), Channel: 'JPM' }
    ];
    const banks = () => [
      { ...bankRow({ rowId: 'b-jpm', merchantId: 'CLR' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-dbs', merchantId: 'CLR', billDate: '2026-06-08' }), Channel: 'DBS' }
    ];

    const before = banks();
    runRound5FundTransferBackfill(jpmGws(), before);
    assert.deepEqual(before.map((b) => b.ReconciliationId), ['GW-CLR', ''], '不配映射：只有 JPM 银行行被回填');

    const after = banks();
    const result = runRound5FundTransferBackfill(jpmGws(), after, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(after.map((b) => b.ReconciliationId), ['GW-ALIAS', ''], '配映射后 DBS 银行行仍不被 JPM 网关行回填');
    assert.deepEqual([...result.usedBankRowIds], ['b-jpm']);
  });

  test('同值映射（CLR → CLR）也算映射命中，同样只回填同渠道银行行', () => {
    const gws = () => [{ ...gwRow({ merchantId: 'CLR', reconId: 'GW-JPM' }), Channel: 'JPM' }];
    const banks = () => [
      { ...bankRow({ rowId: 'b-dbs', merchantId: 'CLR' }), Channel: 'DBS' },
      { ...bankRow({ rowId: 'b-jpm', merchantId: 'CLR', billDate: '2026-06-08' }), Channel: 'JPM' }
    ];
    const unmapped = banks();
    runRound5FundTransferBackfill(gws(), unmapped);
    assert.deepEqual(unmapped.map((b) => b.ReconciliationId), ['GW-JPM', ''], '不配映射：保持改动前（同日优先）');

    const mapped = banks();
    runRound5FundTransferBackfill(gws(), mapped, { accountMappingMap: new Map([['CLR', 'CLR']]) });
    assert.deepEqual(mapped.map((b) => b.ReconciliationId), ['', 'GW-JPM'], '同值映射后跳过 DBS 行，回填同渠道次日行');
  });

  test('映射后多条网关行争用一条银行行 → 先到先得不变，并对该银行行告警被挤掉的网关对账ID', () => {
    const gws = () => [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-CLR' }), Channel: 'JPM' }
    ];
    const banks = () => [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];

    const baselineBanks = banks();
    const baseline = runRound5FundTransferBackfill(gws(), baselineBanks);
    assert.equal(baselineBanks[0].ReconciliationId, 'GW-CLR');
    assert.equal(baseline.warnings.filter((w) => w.code === 'r5-mapped-account-contention').length, 0);

    const mappedBanks = banks();
    const mapped = runRound5FundTransferBackfill(gws(), mappedBanks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(mappedBanks[0].ReconciliationId, 'GW-ALIAS', '同日同阶段按网关原序先到先得');
    const contention = mapped.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    assert.equal(contention.length, 1);
    assert.equal(contention[0].rowId, 'b1');
    assert.match(contention[0].message, /网关记录 （无业务键）（对账ID GW-CLR）未匹配，其可用银行行\(b1\)已被网关记录 （无业务键）（对账ID GW-ALIAS）匹配并占用；已按同日优先/);
  });

  test('争用告警写明双方业务键 ReconBillBizId（对账ID 相同时仍可区分）', () => {
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'R42' }), Channel: 'JPM', ReconBillBizId: 'BIZ-A' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'R42' }), Channel: 'JPM', ReconBillBizId: 'BIZ-B' }
    ];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    const [warning] = result.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    assert.match(warning.message, /网关记录 BIZ-B（对账ID R42）未匹配，其可用银行行\(b1\)已被网关记录 BIZ-A（对账ID R42）匹配并占用/);
  });

  test('密集争用：告警按未回填网关行各一条，线性增长（不按网关 × 银行逐对枚举）', () => {
    const gws = [];
    const banks = [];
    for (let i = 0; i < 80; i += 1) {
      gws.push({ ...gwRow({ merchantId: i % 2 === 0 ? 'ALIAS' : 'CLR', reconId: `GW-${i}` }), Channel: 'JPM' });
    }
    for (let i = 0; i < 40; i += 1) {
      banks.push({ ...bankRow({ rowId: `b${i}`, merchantId: 'CLR' }), Channel: 'JPM' });
    }
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(result.usedBankRowIds.size, 40);
    assert.equal(result.warnings.filter((w) => w.code === 'r5-mapped-account-contention').length, 40, '40 条未回填网关行各一条');
  });

  test('争用时同日优先于网关原序：靠前的映射行差一天，靠后的原账号行同日 → 回填后者并告警前者', () => {
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS', billdate: '2026-06-06' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-CLR' }), Channel: 'JPM' }
    ];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(banks[0].ReconciliationId, 'GW-CLR');
    const contention = result.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    assert.deepEqual(contention.map((w) => w.rowId), ['b1']);
    assert.match(contention[0].message, /对账ID GW-ALIAS）未匹配，其可用银行行\(b1\)已被网关记录 （无业务键）（对账ID GW-CLR）匹配并占用/);
  });

  test('映射目标账号上两侧渠道都为空 → 不能视为同渠道：不回填、不覆盖原值，并告警', () => {
    const gws = [{ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), ReconBillBizId: 'BIZ-1' }];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR', reconId: 'OLD-ID' }), Channel: '' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(result.modifications, []);
    assert.equal(result.usedBankRowIds.size, 0);
    assert.equal(banks[0].ReconciliationId, 'OLD-ID');
    const missing = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].rowId, 'b1');
    assert.match(missing[0].message, /网关记录 BIZ-1（对账ID GW-ALIAS）与银行行\(b1\)账号、币种、金额相符，但网关渠道为空/);
  });

  test('关闭日期匹配时争用告警不声称同日优先；同值未写时写「匹配并占用」而非回填', () => {
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS', billdate: '2026-06-01' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-CLR' }), Channel: 'JPM' }
    ];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR', reconId: 'GW-ALIAS' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, {
      accountMappingMap: new Map([['ALIAS', 'CLR']]),
      fundTransferDatePolicy: { enabled: false, toleranceDays: 1 }
    });
    assert.deepEqual(result.modifications, [], '银行行原值已是胜出方对账ID，同值不改写');
    assert.deepEqual([...result.usedBankRowIds], ['b1']);
    const [warning] = result.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    assert.match(warning.message, /已被网关记录 （无业务键）（对账ID GW-ALIAS）匹配并占用；日期匹配已关闭，已按网关原序只匹配其一/);
    assert.doesNotMatch(warning.message, /同日优先|回填/);
  });

  test('争用检查不随过期网关行逐行扫描银行池：日期容差外的未匹配行不告警', () => {
    const gws = [{ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), Channel: 'JPM' }];
    for (let i = 0; i < 50; i += 1) {
      gws.push({ ...gwRow({ merchantId: 'CLR', reconId: `GW-OLD-${i}`, billdate: '2026-05-01' }), Channel: 'JPM' });
    }
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(banks[0].ReconciliationId, 'GW-ALIAS');
    assert.equal(result.warnings.filter((w) => w.code === 'r5-mapped-account-contention').length, 0);
  });

  test('缺渠道告警不受网关行顺序影响：唯一银行行先被有渠道的行占用，空渠道行仍告警', () => {
    const makeGws = () => [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-JPM' }), Channel: 'JPM', ReconBillBizId: 'BIZ-JPM' },
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-EMPTY' }), Channel: '', ReconBillBizId: 'BIZ-EMPTY' }
    ];
    for (const order of ['空渠道行在后', '空渠道行在前']) {
      const gws = order === '空渠道行在后' ? makeGws() : makeGws().reverse();
      const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];
      const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
      assert.equal(banks[0].ReconciliationId, 'GW-JPM', `${order}：只回填同渠道行`);
      assert.deepEqual([...result.usedBankRowIds], ['b1'], `${order}：严格 1:1`);
      const missing = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing');
      assert.equal(missing.length, 1, `${order}：缺渠道告警恰好一条`);
      assert.equal(missing[0].rowId, 'b1');
      assert.match(missing[0].message, /网关记录 BIZ-EMPTY（对账ID GW-EMPTY）与银行行\(b1\)账号、币种、金额相符，但网关渠道为空/);
    }
  });

  test('争用告警按日期容差区间取原序最前的已占用银行行；区间外不告警', () => {
    const dates = { b1: '2026-06-01', b2: '2026-06-05', b3: '2026-06-04', b4: '2026-06-10' };
    const banks = Object.entries(dates).map(([rowId, billDate]) => (
      { ...bankRow({ rowId, merchantId: 'CLR', billDate }), Channel: 'JPM' }
    ));
    const gws = Object.entries(dates).map(([rowId, billdate]) => (
      { ...gwRow({ merchantId: 'ALIAS', reconId: `W-${rowId}`, billdate }), Channel: 'JPM' }
    ));
    gws.push(
      { ...gwRow({ merchantId: 'CLR', reconId: 'L-0605', billdate: '2026-06-05' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'L-0603', billdate: '2026-06-03' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'L-0608', billdate: '2026-06-08' }), Channel: 'JPM' }
    );
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(banks.map((b) => b.ReconciliationId), ['W-b1', 'W-b2', 'W-b3', 'W-b4'], '映射行同日各占一条');
    const contention = result.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    // 06-05 的区间 [06-04, 06-06] 含 b3（日期更早）与 b2（原序更前）→ 取 b2；06-03 只覆盖 b3；06-08 区间内无已占用行。
    assert.deepEqual(contention.map((w) => w.rowId), ['b2', 'b3']);
    assert.match(contention[0].message, /对账ID L-0605）未匹配，其可用银行行\(b2\)已被网关记录 （无业务键）（对账ID W-b2）/);
    assert.match(contention[1].message, /对账ID L-0603）未匹配，其可用银行行\(b3\)已被网关记录 （无业务键）（对账ID W-b3）/);
  });

  test('池外空渠道诊断行只告警不匹配：映射命中或原账号即本方向映射目标的行告警，其余忽略', () => {
    const makeBanks = () => [
      { ...bankRow({ rowId: 'b1', merchantId: 'CLR', reconId: 'OLD-ID' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b2', merchantId: 'OTHER' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b3', merchantId: 'CLR', debit: 200 }), Channel: 'JPM' }
    ];
    const diagnostics = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-MAPPED' }), ReconBillBizId: 'BIZ-MAPPED' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-TARGET' }), Channel: '  ', ReconBillBizId: 'BIZ-TARGET' },
      { ...gwRow({ merchantId: 'OTHER', reconId: 'GW-UNMAPPED' }), ReconBillBizId: 'BIZ-UNMAPPED' },
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-AMOUNT', amount: 999 }), ReconBillBizId: 'BIZ-AMOUNT' },
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-HAS-CHANNEL' }), Channel: 'DBS' }
    ];
    const options = { accountMappingMap: new Map([['ALIAS', 'CLR']]), channelMissingDiagnosticGwRows: diagnostics };

    // 池内有映射命中行 → CLR 是本方向映射目标，原账号 CLR 的空渠道行也要告警。
    const banks = makeBanks();
    const pool = [{ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-POOL', amount: 200 }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(pool, banks, options);
    assert.deepEqual(result.modifications.map((m) => [m.rowId, m.newValue]), [['b3', 'GW-POOL']], '诊断行不参与匹配');
    assert.deepEqual([...result.usedBankRowIds], ['b3']);
    assert.equal(banks[0].ReconciliationId, 'OLD-ID');
    const missing = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing');
    assert.deepEqual(missing.map((w) => w.rowId), ['b1', 'b1']);
    assert.match(missing[0].message, /网关记录 BIZ-MAPPED（对账ID GW-MAPPED）与银行行\(b1\)账号、币种、金额相符，但网关渠道为空/);
    assert.match(missing[1].message, /网关记录 BIZ-TARGET（对账ID GW-TARGET）/);

    // 池内无映射命中行 → 原账号 CLR 的行与改动前一样不需要渠道，只告警映射命中的诊断行。
    const noPool = runRound5FundTransferBackfill([], makeBanks(), options);
    assert.deepEqual(noPool.modifications, []);
    assert.deepEqual(
      noPool.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing').map((w) => w.message.match(/BIZ-\w+/)[0]),
      ['BIZ-MAPPED']
    );
  });

  test('池外诊断行与池内行同一对象时不重复告警', () => {
    const gw = { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), ReconBillBizId: 'BIZ-1' };
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: '' }];
    const result = runRound5FundTransferBackfill([gw], banks, {
      accountMappingMap: new Map([['ALIAS', 'CLR']]),
      channelMissingDiagnosticGwRows: [gw]
    });
    assert.equal(result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing').length, 1);
  });

  test('池外有渠道的映射行：只与空渠道银行行告警（银行渠道为空），与有渠道银行行不告警', () => {
    const diagnostics = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-DBS' }), Channel: 'DBS', ReconBillBizId: 'BIZ-DBS' }
    ];
    const options = { accountMappingMap: new Map([['ALIAS', 'CLR']]), channelMissingDiagnosticGwRows: diagnostics };
    const banks = [
      { ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b2', merchantId: 'CLR' }), Channel: '' }
    ];
    const result = runRound5FundTransferBackfill([], banks, options);
    assert.deepEqual(result.modifications, []);
    const missing = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing');
    assert.deepEqual(missing.map((w) => w.rowId), ['b2']);
    assert.match(missing[0].message, /网关记录 BIZ-DBS（对账ID GW-DBS）与银行行\(b2\)账号、币种、金额相符，但银行渠道为空/);

    const onlyChannelled = runRound5FundTransferBackfill([], [banks[0]], options);
    assert.deepEqual(onlyChannelled.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing'), [], '渠道不同不是缺渠道');
  });

  test('组合键无歧义：账号、币种含 NUL 时不会把不同账号的银行行当作候选', () => {
    const gw = { ...gwRow({ merchantId: 'ALIAS', currency: 'C', reconId: 'GW-NUL' }), Channel: 'JPM' };
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'A', currency: 'B\u0000C' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill([gw], banks, { accountMappingMap: new Map([['ALIAS', 'A\u0000B']]) });
    assert.deepEqual(result.modifications, []);
    assert.equal(banks[0].ReconciliationId, '');
    assert.deepEqual([...result.usedBankRowIds], []);
  });

  test('readR5MappedChannelDiagnosticRows：无映射 / 无可对上的调拨银行行不读；按方向 + 账号 + 币种 + 金额逐行预筛', () => {
    const calls = [];
    const rows = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'R1' }), Channel: '\t' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'R2' }), Channel: '\u3000' },
      gwRow({ merchantId: 'ALIAS', reconId: 'R3', amount: 999 }),
      gwRow({ merchantId: 'OTHER', reconId: 'R4' }),
      gwRow({ merchantId: 'ALIAS', reconId: '' }),
      gwRow({ merchantId: 'ALIAS', reconId: 'R6', tradeType: 'Payment' }),
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'R7' }), Channel: 'JPM' },
      gwRow({ merchantId: 'ALIAS', reconId: 'R8', currency: 'HKD' }),
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'R9', amount: 300 }), Channel: 'DBS' },
      gwRow({ merchantId: 'ALIAS', reconId: 'R10', amount: 500 }),
      gwRow({ merchantId: 'ALIAS', reconId: 'R11', tradeType: 'FundTransfer-in' }),
      gwRow({ merchantId: 'ALIAS', reconId: 'R12', amount: 400 })
    ];
    const reader = (options) => {
      calls.push(options);
      return rows.map(options.select).filter((row) => row != null);
    };
    const mapping = new Map([['ALIAS', 'CLR']]);
    const banks = [
      { ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b2', merchantId: 'CLR', debit: 300 }), Channel: '' },
      { ...bankRow({ rowId: 'b3', merchantId: 'CLR', debit: 500, fundType: 'Payment' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b4', merchantId: 'OTHER', debit: 400 }), Channel: 'JPM' }
    ];
    const read = (context) => readR5MappedChannelDiagnosticRows(reader, context);
    assert.deepEqual(read({ accountMappingMap: new Map(), bankChannels: ['JPM'], bankRows: banks }), []);
    assert.deepEqual(read({ accountMappingMap: mapping, bankChannels: [], bankRows: banks }), []);
    assert.deepEqual(read({ accountMappingMap: mapping, bankChannels: ['JPM'], bankRows: [] }), []);
    assert.deepEqual(read({ accountMappingMap: mapping, bankChannels: ['JPM'], bankRows: [banks[2], banks[3]] }), [],
      '只有非调拨或非映射目标账号的银行行');
    assert.equal(calls.length, 0, '上述情形都不触发读取');
    const picked = read({ accountMappingMap: mapping, bankChannels: ['', 'JPM'], bankRows: banks });
    assert.deepEqual(
      picked.map((row) => row.reconciliationid),
      ['R1', 'R2', 'R9'],
      '空渠道网关行对上任一渠道银行行；有渠道网关行只对上空渠道银行行；方向、金额、币种对不上的不保留'
    );
    assert.deepEqual(calls[0].channels, ['', 'JPM'], '按读池用的渠道取补集');
    assert.deepEqual(calls[0].tradeTypes.slice().sort(), ['FundTransfer-in', 'FundTransfer-out']);
  });

  test('v3.2.22 转义歧义：网关账号原样与解码后映射到不同清结算账号 → 不回填，每条网关行告警一次', () => {
    const map = new Map([['A_x0000_B', 'CLR-LIT'], ['A\u0000B', 'CLR-NUL']]);
    const gws = [
      { ...gwRow({ merchantId: 'A_x0000_B', reconId: 'GW-AMB' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'A\u0000B', reconId: 'GW-NUL', amount: 200 }), Channel: 'JPM' }
    ];
    const banks = [
      { ...bankRow({ rowId: 'b-lit', merchantId: 'CLR-LIT' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-nul', merchantId: 'CLR-NUL' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-nul-200', merchantId: 'CLR-NUL', debit: 200 }), Channel: 'JPM' }
    ];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.deepEqual(banks.map((b) => [b._rowId, b.ReconciliationId]), [['b-lit', ''], ['b-nul', ''], ['b-nul-200', 'GW-NUL']],
      '🔴 歧义行不回填到任何一个候选账号；含真实 NUL 的网关账号照常映射回填');
    const ambiguous = result.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous');
    assert.deepEqual(ambiguous.map((w) => w.reconId), ['GW-AMB']);
    assert.match(ambiguous[0].message, /共 9 个字符）含 Excel 转义写法（_xHHHH_ 形式）：⟨U\+0000⟩，无法确定真实账户号/);
    assert.ok(!/_x[0-9A-Fa-f]{4}_/i.test(ambiguous[0].message), '转义片段按 ⟨U+HHHH⟩ 显示，错误报告读回不被解码');
    assert.ok(!ambiguous[0].message.includes('A_x0000_B'), '告警不写完整账户号');
    const longAccount = { ...gwRow({ merchantId: '6222020200112233_x0000_', reconId: 'GW-LONG' }), Channel: 'JPM' };
    const longWarning = runRound5FundTransferBackfill([longAccount], [{ ...bankRow({ rowId: 'b-long', merchantId: 'CLR-LIT' }), Channel: 'JPM' }], {
      accountMappingMap: new Map([['6222020200112233_x0000_', 'CLR-LIT'], ['6222020200112233\u0000', 'CLR-NUL']])
    }).warnings.find((w) => w.code === 'r5-mapped-account-escape-ambiguous');
    assert.ok(longWarning);
    assert.match(longWarning.message, /尾号「000_」，共 23 个字符/);
    assert.ok(!longWarning.message.includes('6222020200112233'), '长账号只写尾号');
    const noMap = runRound5FundTransferBackfill([gws[0]], [{ ...bankRow({ rowId: 'raw', merchantId: 'A_x0000_B' }), Channel: 'JPM' }]);
    assert.deepEqual(noMap.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous'), [], '没有映射时不判歧义');
    assert.equal(noMap.modifications.length, 1, '没有映射时按原账号照常回填（与改动前一致）');
  });

  test('v3.2.22（🔴）银行 MerchantId 按数值读入已被舍入、与映射目标账号按数值相同：不进映射回填候选并告警；文本同形账号照常', () => {
    // 银行源单元格 <v>9007199254740993</v> 经 readBankStatement 读成数 9007199254740992，字符串与映射目标账号相同。
    const map = new Map([['GW-ACC', '9007199254740992']]);
    const gws = [{ ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-1' }), Channel: 'JPM' }];
    const banks = [{ ...bankRow({ rowId: 'b-num' }), MerchantId: 9007199254740993, Channel: 'JPM' }];
    for (const enabled of [false, true]) {
      const rows = banks.map((b) => ({ ...b }));
      const result = runRound5FundTransferBackfill(gws, rows, {
        accountMappingMap: map, fundTransferDatePolicy: { enabled, toleranceDays: 1 }
      });
      assert.equal(rows[0].ReconciliationId, '', `🔴 不回填到可能是另一账号的银行行（日期匹配 ${enabled}）`);
      const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
      assert.deepEqual(warned.map((w) => w.rowId), ['b-num']);
      assert.match(warned[0].message, /尾号「0992」，共 16 个字符）是按数值读入的数字，可能已丢失前导零或精度（Excel 数值不保留前导零、只保留 15 位有效数字/);
    }
    // 文本单元格的同形账号原文可信，照常回填；目标账号按数值对得上但字符串不同的数值银行行同样告警（不静默漏掉）。
    const textRows = [{ ...bankRow({ rowId: 'b-text', merchantId: '9007199254740992' }), Channel: 'JPM' }];
    const text = runRound5FundTransferBackfill(gws, textRows, { accountMappingMap: map });
    assert.equal(textRows[0].ReconciliationId, 'GW-1');
    assert.deepEqual(text.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous'), []);
    const cardRows = [{ ...bankRow({ rowId: 'b-card' }), MerchantId: 6222020200112233000, Channel: 'JPM' }];
    const card = runRound5FundTransferBackfill(gws, cardRows,
      { accountMappingMap: new Map([['GW-ACC', '6222020200112233445']]) });
    assert.equal(cardRows[0].ReconciliationId, '');
    assert.deepEqual(card.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous').map((w) => w.rowId), ['b-card']);
    // 没有映射时不判（原口径，与改动前一致）。
    const plainRows = [{ ...bankRow({ rowId: 'b-plain' }), MerchantId: 9007199254740993 }];
    runRound5FundTransferBackfill([gwRow({ merchantId: '9007199254740992', reconId: 'GW-P' })], plainRows);
    assert.equal(plainRows[0].ReconciliationId, 'GW-P');
    // 池外诊断：这类银行行按它可能代表的映射目标建键，读回对得上的池外网关行，由引擎建桶时为银行行告警；
    //   引擎不按它判缺渠道（不进候选桶）。
    const blankGw = [{ ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-BLANK' }), Channel: '' }];
    const reader = ({ select }) => blankGw.map(select).filter((row) => row != null);
    const picked = readR5MappedChannelDiagnosticRows(reader, { accountMappingMap: map, bankChannels: ['JPM'], bankRows: banks });
    assert.deepEqual(picked.map((row) => row.reconciliationid), ['GW-BLANK']);
    const oopRows = banks.map((b) => ({ ...b }));
    const oop = runRound5FundTransferBackfill([], oopRows, {
      accountMappingMap: map,
      channelMissingDiagnosticSource: (context) =>
        readR5MappedChannelDiagnosticRows(reader, { ...context, accountMappingMap: map, bankChannels: ['JPM'] })
    });
    assert.equal(oopRows[0].ReconciliationId, '');
    assert.deepEqual(
      oop.warnings.map((w) => [w.code, w.rowId]),
      [['r5-mapped-account-bank-precision-ambiguous', 'b-num']],
      '🔴 只有池外网关行时也为无法确认账号的银行行告警，不另报缺渠道'
    );
  });

  test('v3.2.22（🔴）未命中映射的原账号按数值读入、与映射目标对得上 → 不参与匹配、不占用银行行，映射行照常回填', () => {
    // 网关原账号 <v>9007199254740993</v> 按数值读入落库为 '9007199254740992'，恰好是映射 G → 9007199254740992 的目标。
    const map = new Map([['G', '9007199254740992']]);
    for (const enabled of [false, true]) {
      const gws = [
        { ...gwRow({ merchantId: '9007199254740992', reconId: 'GW-RAW' }), Channel: 'JPM' },
        { ...gwRow({ merchantId: 'G', reconId: 'GW-G' }), Channel: 'JPM' }
      ];
      const banks = [{ ...bankRow({ rowId: 'b1', merchantId: '9007199254740992' }), Channel: 'JPM' }];
      const result = runRound5FundTransferBackfill(gws, banks, {
        accountMappingMap: map, fundTransferDatePolicy: { enabled, toleranceDays: 1 }
      });
      assert.equal(banks[0].ReconciliationId, 'GW-G', `🔴 原值可能是另一账号的行不抢占映射目标（日期匹配 ${enabled}）`);
      const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous');
      assert.deepEqual(warned.map((w) => w.reconId), ['GW-RAW']);
      assert.match(warned[0].message, /账户号（尾号「0992」，共 16 个字符）是按数值读入的数字.*与账户映射后的清结算账号对得上/);
      assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-contention'), [], '不算争用');
    }
    // 前导 0：映射目标 `00123`，未命中映射的原账号 `123` 可能就是它。
    const zeroBanks = [{ ...bankRow({ rowId: 'b-123', merchantId: '123' }), Channel: 'JPM' }];
    const zero = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: '123', reconId: 'GW-123' }), Channel: 'JPM' }, { ...gwRow({ merchantId: 'G', reconId: 'GW-G', amount: 300 }), Channel: 'JPM' }],
      zeroBanks, { accountMappingMap: new Map([['G', '00123']]) }
    );
    assert.equal(zeroBanks[0].ReconciliationId, '', '🔴 不按原值匹配其他银行行');
    assert.deepEqual(zero.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous').map((w) => w.reconId), ['GW-123']);
    // 本方向没有映射目标（映射行不在本方向）或原账号是文本写法：照常。
    const otherDir = [{ ...bankRow({ rowId: 'b1', merchantId: '9007199254740992' }), Channel: 'JPM' }];
    runRound5FundTransferBackfill([{ ...gwRow({ merchantId: '9007199254740992', reconId: 'GW-RAW' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'G', reconId: 'GW-IN', tradeType: 'FundTransfer-in' }), Channel: 'JPM' }], otherDir, { accountMappingMap: map });
    assert.equal(otherDir[0].ReconciliationId, 'GW-RAW');
    const textBanks = [{ ...bankRow({ rowId: 'b-clr', merchantId: 'CLR' }), Channel: 'JPM' }];
    runRound5FundTransferBackfill([{ ...gwRow({ merchantId: 'CLR', reconId: 'GW-CLR' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS', amount: 300 }), Channel: 'JPM' }], textBanks,
    { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(textBanks[0].ReconciliationId, 'GW-CLR', '原账号文本即目标：照常争用');
    // 池外诊断行同口径：告警账号对不清，不报缺渠道。
    const oop = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: 'G', reconId: 'GW-G', amount: 300 }), Channel: 'JPM' }],
      [{ ...bankRow({ rowId: 'b1', merchantId: '9007199254740992' }), Channel: '' }],
      { accountMappingMap: map, channelMissingDiagnosticGwRows: [gwRow({ merchantId: '9007199254740992', reconId: 'GW-OOP' })] }
    );
    assert.deepEqual(oop.warnings.map((w) => [w.code, w.reconId || w.rowId]),
      [['r5-mapped-account-precision-ambiguous', 'GW-OOP']]);
  });

  test('v3.2.22（🔴）命中映射键的原账号按数值读入、与本方向另一映射目标对得上 → 不按映射回填、不占用银行行并告警', () => {
    // 映射 `123 → CLR-A` 与 `G → 00123` 并存且本批有 G 行：按数值存放、显示为 `00123` 的网关账号读入为 '123'，
    //   可能是映射键 `123`（应回填 CLR-A），也可能就是清结算账号 `00123`。
    const map = new Map([['123', 'CLR-A'], ['G', '00123']]);
    for (const enabled of [false, true]) {
      const banks = [
        { ...bankRow({ rowId: 'b-a', merchantId: 'CLR-A' }), Channel: 'JPM' },
        { ...bankRow({ rowId: 'b-0', merchantId: '00123', debit: 300 }), Channel: 'JPM' }
      ];
      const gws = [
        { ...gwRow({ merchantId: '123', reconId: 'GW-123' }), Channel: 'JPM' },
        { ...gwRow({ merchantId: 'G', reconId: 'GW-G', amount: 300 }), Channel: 'JPM' }
      ];
      const result = runRound5FundTransferBackfill(gws, banks, {
        accountMappingMap: map, fundTransferDatePolicy: { enabled, toleranceDays: 1 }
      });
      assert.deepEqual(banks.map((b) => b.ReconciliationId), ['', 'GW-G'], `🔴 不回填到 CLR-A，映射行照常（日期匹配 ${enabled}）`);
      const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous');
      assert.deepEqual(warned.map((w) => w.reconId), ['GW-123']);
      assert.match(warned[0].message, /账户号（共 3 个字符）是按数值读入的数字，可能已丢失前导零或精度.*与账户映射后的清结算账号对得上/);
    }
    // 本批没有 G 行（`00123` 不是本方向的映射目标）、或对得上的目标就是它自己的映射结果：照常按映射回填、不告警。
    for (const [caseMap, gws, target] of [
      [map, [{ ...gwRow({ merchantId: '123', reconId: 'GW-123' }), Channel: 'JPM' }], 'CLR-A'],
      [new Map([['123', '00123']]), [{ ...gwRow({ merchantId: '123', reconId: 'GW-123' }), Channel: 'JPM' }], '00123']
    ]) {
      const banks = [{ ...bankRow({ rowId: 'b1', merchantId: target }), Channel: 'JPM' }];
      const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: caseMap });
      assert.equal(banks[0].ReconciliationId, 'GW-123', `映射到 ${target}：照常回填`);
      assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous'), []);
    }
    // 池外诊断行同口径：告警账号对不清，不报缺渠道。
    const oop = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: 'G', reconId: 'GW-G', amount: 300 }), Channel: 'JPM' }],
      [{ ...bankRow({ rowId: 'b-a', merchantId: 'CLR-A' }), Channel: '' }],
      { accountMappingMap: map, channelMissingDiagnosticGwRows: [gwRow({ merchantId: '123', reconId: 'GW-OOP' })] }
    );
    assert.deepEqual(oop.warnings.map((w) => [w.code, w.reconId || w.rowId]),
      [['r5-mapped-account-precision-ambiguous', 'GW-OOP']]);
  });

  test('v3.2.22（🔴）前导 0：带前导 0 的映射键按数值读入后丢了 0，与另一映射键或目标同值 → 不回填并告警', () => {
    // 网关表单元格按数值存放、显示格式为 00000 的 `00123` 读入即为 '123'；映射里 `00123` 与 `123` 各指向不同的清结算账号。
    const map = new Map([['00123', 'CLR-A'], ['123', 'CLR-B']]);
    const banks = [
      { ...bankRow({ rowId: 'b-a', merchantId: 'CLR-A' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-b', merchantId: 'CLR-B' }), Channel: 'JPM' }
    ];
    const gws = [{ ...gwRow({ merchantId: '123', reconId: 'GW-123' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.deepEqual(banks.map((b) => b.ReconciliationId), ['', ''], '🔴 `123` 可能是丢了前导 0 的 `00123`，不回填到 CLR-B');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous');
    assert.deepEqual(warned.map((w) => w.reconId), ['GW-123']);
    assert.match(warned[0].message, /账户号（共 3 个字符）是按数值读入的数字，可能已丢失前导零或精度/);
    // 带前导 0 的写法只能来自文本单元格，原文可信，照常按映射回填；没有 `00123` 这类键时 `123` 不受影响。
    const textBanks = [{ ...bankRow({ rowId: 'b-a', merchantId: 'CLR-A' }), Channel: 'JPM' }];
    runRound5FundTransferBackfill([{ ...gwRow({ merchantId: '00123', reconId: 'GW-00123' }), Channel: 'JPM' }], textBanks,
      { accountMappingMap: map });
    assert.equal(textBanks[0].ReconciliationId, 'GW-00123');
    const plainBanks = [{ ...bankRow({ rowId: 'b-b', merchantId: 'CLR-B' }), Channel: 'JPM' }];
    const plain = runRound5FundTransferBackfill(gws, plainBanks, { accountMappingMap: new Map([['123', 'CLR-B']]) });
    assert.equal(plainBanks[0].ReconciliationId, 'GW-123');
    assert.deepEqual(plain.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous'), []);
  });

  test('v3.2.22（🔴）前导 0：银行 MerchantId 按数值读入、与带前导 0 的映射目标同值 → 不进映射回填候选并告警；文本照常', () => {
    // 映射目标 `00123` 与 `123` 都在用：银行对账单里按数值存放的 123 可能是 `00123`，也可能是 `123`。
    const map = new Map([['GW-A', '00123'], ['GW-B', '123']]);
    const gws = [{ ...gwRow({ merchantId: 'GW-B', reconId: 'GW-B1' }), Channel: 'JPM' }];
    const rows = [{ ...bankRow({ rowId: 'b-num' }), MerchantId: 123, Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: map });
    assert.equal(rows[0].ReconciliationId, '', '🔴 不按文字 `123` 回填');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b-num']);
    assert.match(warned[0].message, /MerchantId（共 3 个字符）是按数值读入的数字，可能已丢失前导零或精度.*银行对账单里的账号宜按文本存放/);
    const textRows = [{ ...bankRow({ rowId: 'b-text', merchantId: '123' }), Channel: 'JPM' }];
    const text = runRound5FundTransferBackfill(gws, textRows, { accountMappingMap: map });
    assert.equal(textRows[0].ReconciliationId, 'GW-B1', '文本单元格的 `123` 原文可信');
    assert.deepEqual(text.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous'), []);
    // 映射到 `123` 的网关行只在池外（空渠道）：诊断按文字相同的目标建键读回，引擎为银行行告警，不报缺渠道。
    const oopGw = [{ ...gwRow({ merchantId: 'GW-B', reconId: 'GW-OOP' }), Channel: '' }];
    const reader = ({ select }) => oopGw.map(select).filter((row) => row != null);
    const oopRows = [{ ...bankRow({ rowId: 'b-num' }), MerchantId: 123, Channel: 'JPM' }];
    const oop = runRound5FundTransferBackfill([], oopRows, {
      accountMappingMap: map,
      channelMissingDiagnosticSource: (context) =>
        readR5MappedChannelDiagnosticRows(reader, { ...context, accountMappingMap: map, bankChannels: ['JPM'] })
    });
    assert.deepEqual(oop.warnings.map((w) => [w.code, w.rowId]), [['r5-mapped-account-bank-precision-ambiguous', 'b-num']]);
    // 只有 `123` 一个目标时数值 123 没有歧义，照常回填。
    const onlyRows = [{ ...bankRow({ rowId: 'b-only' }), MerchantId: 123, Channel: 'JPM' }];
    runRound5FundTransferBackfill(gws, onlyRows, { accountMappingMap: new Map([['GW-B', '123']]) });
    assert.equal(onlyRows[0].ReconciliationId, 'GW-B1');
  });

  test('v3.2.22（🔴）银行 MerchantId 被前序场景按链接表原文改写成数值写法、与映射目标对得上 → 不回填并告警；银行原值照常', () => {
    // C3 把网关字段（链接表按数值存放的 9007199254740993，落库为 '9007199254740992'）写进银行 MerchantId。
    const map = new Map([['GW-ACC', '9007199254740992']]);
    const gws = [{ ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-1' }), Channel: 'JPM' }];
    const rawRewritten = (row, column) => row._rowId === 'b-raw' && column === 'MerchantId';
    const rows = [{ ...bankRow({ rowId: 'b-raw', merchantId: '9007199254740992' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: map, isRawRewrittenBankValue: rawRewritten });
    assert.equal(rows[0].ReconciliationId, '', '🔴 改写值可能是舍入后的另一账号');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b-raw']);
    assert.match(warned[0].message, /被前序场景按链接表原文改写，是按数值读入的数字.*链接表里的账号宜按文本存放/);
    // 前导 0 同理：C3 写入的 '123' 可能是 `00123`。
    const zeroRows = [{ ...bankRow({ rowId: 'b-raw', merchantId: '123' }), Channel: 'JPM' }];
    runRound5FundTransferBackfill([{ ...gwRow({ merchantId: 'GW-B', reconId: 'GW-B1' }), Channel: 'JPM' }], zeroRows, {
      accountMappingMap: new Map([['GW-A', '00123'], ['GW-B', '123']]), isRawRewrittenBankValue: rawRewritten
    });
    assert.equal(zeroRows[0].ReconciliationId, '');
    // 银行账单原值（文本）与未提供判据的直接调用：照常回填。
    for (const options of [{ isRawRewrittenBankValue: () => false }, {}]) {
      const plainRows = [{ ...bankRow({ rowId: 'b-orig', merchantId: '9007199254740992' }), Channel: 'JPM' }];
      const plain = runRound5FundTransferBackfill(gws, plainRows, { accountMappingMap: map, ...options });
      assert.equal(plainRows[0].ReconciliationId, 'GW-1');
      assert.deepEqual(plain.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous'), []);
    }
  });

  test('v3.2.22（🔴）网关对账ID 含转义写法、与银行当前值文字相同：按相同处理不改写，另告警无法确认是否同一个值', () => {
    const gws = [{ ...gwRow({ merchantId: 'M001', reconId: 'RID_x000D_X' }) }];
    const banks = [bankRow({ rowId: 'b1', reconId: 'RID_x000D_X' })];
    const result = runRound5FundTransferBackfill(gws, banks);
    assert.equal(result.modifications.length, 0, '文字相同：不改写、不标黄');
    assert.ok(result.usedBankRowIds.has('b1'), '仍消费该银行行（1v1 不变）');
    const warned = result.warnings.filter((w) => w.code === 'linked-value-escape-same-value-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b1']);
    assert.match(warned[0].message, /网关对账ID（尾号「0D_X」，共 11 个字符，含 Excel 转义写法：⟨U\+000D⟩）与银行行\(b1\)「ReconciliationId」/);
    assert.ok(!warned[0].message.includes('RID'), '告警不写完整值（只写尾号、字符数与转义片段）');
    const plain = runRound5FundTransferBackfill([gwRow({ reconId: 'RID-SAME' })], [bankRow({ rowId: 'b2', reconId: 'RID-SAME' })]);
    assert.deepEqual(plain.warnings.filter((w) => w.code === 'linked-value-escape-same-value-ambiguous'), [], '不含转义写法的同值不告警');
  });

  test('v3.2.22（🔴）网关长账号按数值读入已被舍入、舍入值正好是映射键：不回填并告警舍入歧义', () => {
    // 网关表单元格 `<v>9007199254740993</v>` 按数值读入落库为 '9007199254740992'，映射键恰好是另一个账号 9007199254740992。
    const map = new Map([['9007199254740992', 'CLR-B'], ['GW-ACC', 'CLR-OK']]);
    const gws = [
      { ...gwRow({ merchantId: 9007199254740993, reconId: 'GW-ROUND' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-OK', amount: 200 }), Channel: 'JPM' }
    ];
    const banks = [
      { ...bankRow({ rowId: 'b-b', merchantId: 'CLR-B' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-ok', merchantId: 'CLR-OK', debit: 200 }), Channel: 'JPM' }
    ];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.deepEqual(banks.map((b) => b.ReconciliationId), ['', 'GW-OK'], '🔴 舍入账号不回填；其余映射行照常');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous');
    assert.deepEqual(warned.map((w) => w.reconId), ['GW-ROUND']);
    assert.match(warned[0].message, /尾号「0992」，共 16 个字符）是按数值读入的数字，可能已丢失前导零或精度.*链接表账户号对得上/);
    assert.ok(!warned[0].message.includes('9007199254740992'), '告警不写完整账户号');
    assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous'), []);
    const noMap = runRound5FundTransferBackfill([gws[0]], [{ ...bankRow({ rowId: 'raw', merchantId: '9007199254740992' }), Channel: 'JPM' }]);
    assert.equal(noMap.modifications.length, 1, '没有映射时按原口径（与改动前一致）');
    assert.deepEqual(noMap.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous'), []);
  });

  test('v3.2.22（🔴）Excel 数值只存 15 位有效数字：16 位账号按数值读入（第 16 位起为 0）与映射目标位数、前 15 位相同 → 不回填并告警', () => {
    // 银行对账单里按数值录入的 1234567890123456 被 Excel 存成 1234567890123450，在精确范围内、JS 读入不再变化。
    const gws = [{ ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-1' }), Channel: 'JPM' }];
    for (const target of ['1234567890123456', '1234567890123450']) {
      const rows = [{ ...bankRow({ rowId: 'b-xl' }), MerchantId: 1234567890123450, Channel: 'JPM' }];
      const result = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: new Map([['GW-ACC', target]]) });
      assert.equal(rows[0].ReconciliationId, '', `🔴 不回填（映射目标 ${target}）`);
      const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
      assert.deepEqual(warned.map((w) => w.rowId), ['b-xl'], target);
      assert.ok(!warned[0].message.includes('1234567890123450'), '告警不写完整账号');
    }
    // 第 16 位不是 0：不是 Excel 截断的结果（JS 精确读入），按原值比较照常回填；位数不同、前 15 位不同的不受影响。
    for (const [value, target] of [
      [1234567890123456, '1234567890123456'],
      [1234567890123450, '12345678901234500'],
      [1234567890123450, '1234567890123460']
    ]) {
      const rows = [{ ...bankRow({ rowId: 'b-ok', merchantId: target }), Channel: 'JPM' }, { ...bankRow({ rowId: 'b-num', debit: 300 }), MerchantId: value, Channel: 'JPM' }];
      const result = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: new Map([['GW-ACC', target]]) });
      assert.equal(rows[0].ReconciliationId, 'GW-1', `${value} vs ${target}`);
      assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous'), [], `${value} vs ${target}`);
    }
  });

  test('v3.2.22（🔴）Excel 15 位截断的网关长账号（文本落库、第 16 位起为 0）与映射键位数、前 15 位相同 → 不回填并告警', () => {
    const map = new Map([['1234567890123456', 'CLR-A']]);
    const gws = [{ ...gwRow({ merchantId: '1234567890123450', reconId: 'GW-XL' }), Channel: 'JPM' }];
    const banks = [{ ...bankRow({ rowId: 'b-a', merchantId: 'CLR-A' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.equal(banks[0].ReconciliationId, '');
    assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-precision-ambiguous').map((w) => w.reconId), ['GW-XL']);
    const exact = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: '1234567890123456', reconId: 'GW-EXACT' }), Channel: 'JPM' }],
      [{ ...bankRow({ rowId: 'b-e', merchantId: 'CLR-A' }), Channel: 'JPM' }],
      { accountMappingMap: map }
    );
    assert.equal(exact.modifications.length, 1, '第 16 位不是 0 的长账号没有经过截断，照常按映射回填');
  });

  test('v3.2.22（🔴）银行 MerchantId 被前序场景按链接表原文改写、含转义写法且文字是映射目标 → 不回填并告警；银行原值照常', () => {
    const map = new Map([['GW-ACC', 'A_x0041_B']]);
    const gws = [{ ...gwRow({ merchantId: 'GW-ACC', reconId: 'GW-ESC' }), Channel: 'JPM' }];
    const rawRewritten = (row, column) => row._rowId === 'b-raw' && column === 'MerchantId';
    const banks = [{ ...bankRow({ rowId: 'b-raw', merchantId: 'A_x0041_B' }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map, isRawRewrittenBankValue: rawRewritten });
    assert.equal(banks[0].ReconciliationId, '', '🔴 原文 A_x0041_B 可能代表 AAB，不按映射目标回填');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-bank-escape-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b-raw']);
    assert.match(warned[0].message, /被前序场景按链接表原文改写.*⟨U\+0041⟩/);
    assert.ok(!warned[0].message.includes('A_x0041_B'), '告警不写完整账号');
    // 银行账单原值（已解码，文字即真实值）与未提供判据的直接调用：照常回填。
    for (const options of [{ isRawRewrittenBankValue: () => false }, {}]) {
      const rows = [{ ...bankRow({ rowId: 'b-orig', merchantId: 'A_x0041_B' }), Channel: 'JPM' }];
      const plain = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: map, ...options });
      assert.equal(rows[0].ReconciliationId, 'GW-ESC');
      assert.deepEqual(plain.warnings.filter((w) => w.code === 'r5-mapped-account-bank-escape-ambiguous'), []);
    }
  });

  test('v3.2.22（🔴）映射非空时网关账号含转义写法：即使只有解码后写法是映射键，也不回填任何渠道并告警', () => {
    // 单工作表流式导入把含 NUL 的 `A\0B` 存成字面 `A_x0000_B`，也可能是富文本片段拼出来的写法：真实账户号无法确定。
    const map = new Map([['A\u0000B', 'A_x0000_B']]);
    const gws = [{ ...gwRow({ merchantId: 'A_x0000_B', reconId: 'GW-JPM' }), Channel: 'JPM' }];
    const banks = [
      { ...bankRow({ rowId: 'b-citi', merchantId: 'A_x0000_B' }), Channel: 'CITI' },
      { ...bankRow({ rowId: 'b-jpm', merchantId: 'A_x0000_B' }), Channel: 'JPM' }
    ];
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.deepEqual(banks.map((b) => b.ReconciliationId), ['', ''], '🔴 不回填到任何渠道的银行行');
    assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous').map((w) => w.reconId), ['GW-JPM']);

    // 富文本片段 `MID_x00` + `41__x0042_` 逐段解码为 `MID_x0041_B`，流式导入落库为 `MID_x0041__x0042_`；映射这个落库串时，
    //   原样映射与整串解码碰巧一致（都是 MIDAB），也不回填。
    const richBanks = [{ ...bankRow({ rowId: 'b-ab', merchantId: 'MIDAB' }), Channel: 'JPM' }];
    const rich = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: 'MID_x0041__x0042_', reconId: 'GW-RICH' }), Channel: 'JPM' }],
      richBanks,
      { accountMappingMap: new Map([['MID_x0041__x0042_', 'MIDAB']]) }
    );
    assert.equal(richBanks[0].ReconciliationId, '', '🔴 片段边界已丢失的账号不按映射回填');
    assert.deepEqual(rich.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous').map((w) => w.reconId), ['GW-RICH']);

    // 池外诊断同一判据：转义写法的账号不算映射命中，不读、不另报缺渠道。
    const blankGw = [{ ...gwRow({ merchantId: 'A_x0000_B', reconId: 'GW-BLANK' }), Channel: '' }];
    const picked = readR5MappedChannelDiagnosticRows(({ select }) => blankGw.map(select).filter((row) => row != null), {
      accountMappingMap: map,
      bankChannels: ['JPM'],
      bankRows: [{ ...bankRow({ rowId: 'b1', merchantId: 'A_x0000_B' }), Channel: 'JPM' }],
      targetAccountsByTradeType: new Map([['FundTransfer-out', new Set()], ['FundTransfer-in', new Set()]])
    });
    assert.deepEqual(picked, []);
  });

  test('v3.2.22（🔴）映射行渠道含 _xHHHH_ 写法：无法确认真实渠道 → 不回填（不任选一行），每条告警一次', () => {
    // 单工作表流式导入的网关表保留转义原文：网关渠道 `BANK\rUS` 落库为 `BANK_x000D_US`；银行账单经 SheetJS 读取已解码。
    const map = new Map([['ALIAS', 'CLR']]);
    const gws = [{ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ESC' }), Channel: 'BANK_x000D_US' }];
    const banks = [
      { ...bankRow({ rowId: 'b-cr', merchantId: 'CLR' }), Channel: 'BANK\rUS' },
      { ...bankRow({ rowId: 'b-lit', merchantId: 'CLR' }), Channel: 'BANK_x000D_US' }
    ];
    for (const dateMatchEnabled of [true, false]) {
      const rows = banks.map((b) => ({ ...b }));
      const result = runRound5FundTransferBackfill(gws, rows, { accountMappingMap: map, dateMatchEnabled });
      assert.deepEqual(rows.map((b) => b.ReconciliationId), ['', ''], `🔴 两行都不回填（dateMatchEnabled=${dateMatchEnabled}）`);
      const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous');
      assert.deepEqual(warned.map((w) => w.reconId), ['GW-ESC']);
      assert.match(warned[0].message, /渠道「BANK⟨U\+000D⟩US」（⟨U\+HHHH⟩ 处落库为 Excel 转义写法 _xHHHH_）/);
      assert.ok(!/_x[0-9A-Fa-f]{4}_/i.test(warned[0].message), '渠道里的转义写法不原样写进告警');
      assert.deepEqual(result.warnings.filter((w) => /contention|channel-missing/.test(w.code)), [], '不另报争用 / 缺渠道');
    }
    // 未命中映射的行不做渠道校验（旧口径），渠道含转义写法也照常按原账号回填。
    const plain = [{ ...bankRow({ rowId: 'b-plain', merchantId: 'RAW' }), Channel: 'BANK_x000D_US' }];
    const plainResult = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: 'RAW', reconId: 'GW-RAW' }), Channel: 'BANK_x000D_US' }], plain, { accountMappingMap: map }
    );
    assert.equal(plain[0].ReconciliationId, 'GW-RAW');
    assert.deepEqual(plainResult.warnings.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous'), []);
  });

  test('v3.2.22 性能：转义歧义（匹配账号为空）的网关行不再逐阶段扫描整个银行池', () => {
    const map = new Map([['A_x0000_B', 'CLR-LIT'], ['A\u0000B', 'CLR-NUL']]);
    const gws = Array.from({ length: 800 }, (_v, i) => ({
      ...gwRow({ merchantId: 'A_x0000_B', reconId: `GW-${i}` }), Channel: 'JPM'
    }));
    let merchantIdReads = 0;
    const banks = Array.from({ length: 800 }, (_v, i) => {
      const row = { ...bankRow({ rowId: `b${i}`, merchantId: 'CLR-LIT' }), Channel: 'JPM' };
      delete row.MerchantId;
      Object.defineProperty(row, 'MerchantId', { enumerable: true, get: () => { merchantIdReads += 1; return 'CLR-LIT'; } });
      return row;
    });
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.deepEqual(result.modifications, []);
    assert.equal(result.warnings.filter((w) => w.code === 'r5-mapped-account-escape-ambiguous').length, 800);
    assert.ok(merchantIdReads < 10000, `银行 MerchantId 读取次数应与行数同阶，实际 ${merchantIdReads}`);
  });

  test('金额乘 100 后溢出时不入候选桶：负合计银行行不会被映射网关行回填', () => {
    const gw = { ...gwRow({ merchantId: 'ALIAS', amount: 1e307, reconId: 'GW-OVERFLOW' }), Channel: 'JPM' };
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR', debit: 1, extraFee: -1e307 }), Channel: 'JPM' }];
    const result = runRound5FundTransferBackfill([gw], banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(result.modifications, []);
    assert.equal(banks[0].ReconciliationId, '');
    assert.deepEqual([...result.usedBankRowIds], []);
  });

  test('池外诊断读取器惰性调用：方向非法 / 无银行行 / 无映射时不调用；否则调用一次并传入按方向的映射目标', () => {
    const calls = [];
    const source = (context) => {
      calls.push(context);
      return [];
    };
    const mapping = new Map([['ALIAS', 'CLR']]);
    const banks = () => [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' }];
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'OUT-MAPPED' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'IN-RAW', tradeType: 'FundTransfer-in' }), Channel: 'JPM' }
    ];
    const invalid = runRound5FundTransferBackfill(gws, banks(), {
      accountMappingMap: mapping,
      directions: [{ gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-in' }],
      channelMissingDiagnosticSource: () => { throw new Error('不应读取'); }
    });
    assert.equal(invalid.directionsValid, false);
    runRound5FundTransferBackfill(gws, [], { accountMappingMap: mapping, channelMissingDiagnosticSource: source });
    runRound5FundTransferBackfill(gws, banks(), { accountMappingMap: new Map(), channelMissingDiagnosticSource: source });
    assert.equal(calls.length, 0);

    const bankRows = banks();
    runRound5FundTransferBackfill(gws, bankRows, { accountMappingMap: mapping, channelMissingDiagnosticSource: source });
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].bankRows, bankRows);
    assert.deepEqual([...calls[0].targetAccountsByTradeType.get('FundTransfer-out')], ['CLR'], 'out 方向有映射命中行');
    assert.deepEqual([...calls[0].targetAccountsByTradeType.get('FundTransfer-in')], [], 'in 方向只有原账号行，无映射目标');
  });

  test('readR5MappedChannelDiagnosticRows：原账号即目标的行只在本方向实际命中映射时保留；无空渠道银行键时只读空渠道', () => {
    const calls = [];
    const rows = [
      gwRow({ merchantId: 'CLR', reconId: 'RAW-OUT' }),
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'MAPPED-OUT' }), Memo: 'x'.repeat(1024) },
      gwRow({ merchantId: 'CLR', reconId: 'RAW-IN', tradeType: 'FundTransfer-in' })
    ];
    const reader = (options) => {
      calls.push(options);
      return rows.map(options.select).filter((row) => row != null);
    };
    const banks = [
      { ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b2', merchantId: 'CLR', fundType: 'FundTransfer-in', credit: 100, debit: 0 }), Channel: 'JPM' }
    ];
    const picked = readR5MappedChannelDiagnosticRows(reader, {
      accountMappingMap: new Map([['ALIAS', 'CLR']]),
      bankChannels: ['JPM'],
      bankRows: banks,
      targetAccountsByTradeType: new Map([['FundTransfer-out', new Set()], ['FundTransfer-in', new Set(['CLR'])]])
    });
    assert.deepEqual(picked.map((row) => row.reconciliationid), ['MAPPED-OUT', 'RAW-IN'],
      'out 方向无映射命中 → 原账号 CLR 的行不保留；映射键行与 in 方向目标行保留');
    assert.deepEqual(Object.keys(picked[0]).sort(), ['TradeType', 'amount', 'currency', 'merchantid', 'reconciliationid'],
      '只保留生成告警所需字段（不含 Billdate 等其余字段）');
    assert.equal(calls[0].unverifiableChannelOnly, true, '本批没有空渠道银行行');
  });

  // 读池暂存 + 按 id 回读的测试桩：rowsById 模拟同一运行快照里的网关表。
  const stageRows = (prefilter, rows) => {
    const rowsById = new Map();
    rows.forEach((row, index) => {
      rowsById.set(index + 1, row);
      prefilter.collect(row, index + 1);
    });
    return rowsById;
  };
  const idReader = (rowsById, calls) => (ids, onRow) => {
    calls.push(Array.from(ids));
    for (const id of ids) if (rowsById.has(id)) onRow(rowsById.get(id), id);
  };

  test('读池粗筛 + 紧凑暂存：只存 id、键摘要与渠道为空位，不保留网关记录；R5 运行时按银行行精确裁决', () => {
    assert.equal(buildR5ChannelMissingDiagnosticPrefilter(new Map()), null, '映射为空不收集');
    assert.equal(buildR5ChannelMissingDiagnosticPrefilter(null), null);
    const mapping = new Map([['ALIAS', 'CLR']]);
    const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
    assert.deepEqual(prefilter.tradeTypes.slice().sort(), ['FundTransfer-in', 'FundTransfer-out']);
    assert.deepEqual(prefilter.accounts.slice().sort(), ['ALIAS', 'CLR'], '映射键与映射值都可能告警');
    const raw = [
      { ...gwRow({ merchantId: ' ALIAS ', reconId: 'KEEP-KEY' }), Channel: '', Memo: 'x' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'KEEP-VALUE', tradeType: 'FundTransfer-in' }), Channel: 'DBS' },
      gwRow({ merchantId: 'OTHER', reconId: 'DROP-ACCOUNT' }),
      gwRow({ merchantId: 'ALIAS', reconId: ' ' }),
      gwRow({ merchantId: 'ALIAS', reconId: 'DROP-TYPE', tradeType: 'Payment' }),
      gwRow({ merchantId: 'ALIAS', reconId: 'DROP-AMOUNT', amount: 'x' })
    ];
    const rowsById = stageRows(prefilter, raw);
    const staged = prefilter.stagedCandidates();
    assert.equal(staged.count, 2, '账号、方向、对账ID、诊断键不满足的行不暂存');
    assert.ok(staged.ids instanceof Float64Array && staged.keyDigests instanceof Uint32Array &&
      staged.unverifiableChannel instanceof Uint8Array, '暂存为类型化数组，不含网关记录');
    assert.deepEqual(Array.from(staged.ids), [1, 2]);
    assert.deepEqual(Array.from(staged.unverifiableChannel), [1, 0]);
    assert.deepEqual(Array.from(staged.keyDigests), [
      channelMissingDiagnosticKeyDigest(gwChannelMissingDiagnosticKey(mapping, raw[0])),
      channelMissingDiagnosticKeyDigest(gwChannelMissingDiagnosticKey(mapping, raw[1]))
    ]);
    assert.throws(() => prefilter.collect(raw[0], 1.5), TypeError, 'id 非安全整数时抛错');

    const calls = [];
    const source = createR5ChannelMissingDiagnosticSource({
      accountMappingMap: mapping, bankChannels: ['', 'JPM'], prefilter, readRowsByIds: idReader(rowsById, calls)
    });
    const outBank = { ...bankRow({ rowId: 'b1', merchantId: 'CLR' }), Channel: 'JPM' };
    const inBlankBank = { ...bankRow({ rowId: 'b2', merchantId: 'CLR', fundType: 'FundTransfer-in', credit: 100, debit: 0 }), Channel: '' };
    const picked = source({ bankRows: [outBank] });
    assert.deepEqual(picked.map((row) => row.reconciliationid), ['KEEP-KEY'], '没有空渠道银行行：有渠道的候选不保留');
    assert.ok(!('Memo' in picked[0]) && !('Billdate' in picked[0]), '只保留告警所需字段');
    assert.deepEqual(calls, [[1]], '只回读摘要对得上的候选');
    assert.deepEqual(source({ bankRows: [outBank, inBlankBank] }).map((row) => row.reconciliationid), ['KEEP-KEY', 'KEEP-VALUE'],
      '有渠道的候选只对上空渠道银行行');
    calls.length = 0;
    assert.deepEqual(source({ bankRows: [] }), []);
    assert.deepEqual(source({ bankRows: [{ ...outBank, 'Debit Amount': 999 }] }), []);
    assert.deepEqual(calls, [], '没有可对上的银行键 / 摘要都对不上时不回读');
    const empty = buildR5ChannelMissingDiagnosticPrefilter(mapping);
    assert.deepEqual(createR5ChannelMissingDiagnosticSource({
      accountMappingMap: mapping, bankChannels: ['JPM'], prefilter: empty, readRowsByIds: () => { throw new Error('不应回读'); }
    })({ bankRows: [outBank] }), [], '没有候选时为空');
    // 没有暂存候选时不遍历银行行、不建键（主进程同步执行，大批银行行时省下整轮建键）。
    const untouchedBanks = new Proxy([], { get() { throw new Error('没有候选时不应访问银行行'); } });
    assert.deepEqual(createR5ChannelMissingDiagnosticSource({
      accountMappingMap: mapping, bankChannels: ['JPM'], prefilter: empty, readRowsByIds: () => { throw new Error('不应回读'); }
    })({ bankRows: untouchedBanks }), []);
  });

  test('暂存容量按需翻倍：大量候选逐条保留，id 与摘要不串位', () => {
    const mapping = new Map([['ALIAS', 'CLR']]);
    const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
    const total = 5000;
    for (let i = 0; i < total; i += 1) {
      prefilter.collect({ ...gwRow({ merchantId: 'ALIAS', reconId: `G${i}`, amount: i + 1 }), Channel: i % 3 === 0 ? '' : 'DBS' }, 10 + i * 7);
    }
    const staged = prefilter.stagedCandidates();
    assert.equal(staged.count, total);
    for (const i of [0, 1023, 1024, 2047, 2048, total - 1]) {
      const gw = { ...gwRow({ merchantId: 'ALIAS', reconId: `G${i}`, amount: i + 1 }), Channel: '' };
      assert.equal(staged.ids[i], 10 + i * 7);
      assert.equal(staged.keyDigests[i], channelMissingDiagnosticKeyDigest(gwChannelMissingDiagnosticKey(mapping, gw)));
      assert.equal(staged.unverifiableChannel[i], i % 3 === 0 ? 1 : 0);
    }
  });

  test('v3.2.22（🔴）池外网关行渠道含转义写法、只在解码后与银行渠道相符：按渠道转义告警，不回填', () => {
    // 银行批次只有 `BANK\rUS`；单工作表网关落库渠道为 `BANK_x000D_US`，按银行渠道读池时落在池外。
    const map = new Map([['ALIAS', 'CLR']]);
    const outOfPool = { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-OOP' }), Channel: 'BANK_x000D_US' };
    const banks = [{ ...bankRow({ rowId: 'b-cr', merchantId: 'CLR' }), Channel: 'BANK\rUS' }];
    const calls = [];
    const picked = readR5MappedChannelDiagnosticRows((options) => {
      calls.push(options);
      return [outOfPool].map(options.select).filter((row) => row != null);
    }, { accountMappingMap: map, bankChannels: ['BANK\rUS'], bankRows: banks });
    assert.deepEqual(picked.map((row) => row.reconciliationid), ['GW-OOP'], '渠道不可核实：对上任一渠道的银行行');
    assert.equal(calls[0].unverifiableChannelOnly, true, '本批没有空渠道银行行时仍读渠道含转义写法的行');

    const prefilter = buildR5ChannelMissingDiagnosticPrefilter(map);
    const rowsById = stageRows(prefilter, [outOfPool]);
    assert.deepEqual(Array.from(prefilter.stagedCandidates().unverifiableChannel), [1]);
    const source = createR5ChannelMissingDiagnosticSource({
      accountMappingMap: map, bankChannels: ['BANK\rUS'], prefilter, readRowsByIds: idReader(rowsById, [])
    });
    const result = runRound5FundTransferBackfill([], banks, { accountMappingMap: map, channelMissingDiagnosticSource: source });
    assert.equal(banks[0].ReconciliationId, '', '池外行只读诊断，不回填');
    const warned = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-escape-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b-cr']);
    assert.match(warned[0].message, /与银行行\(b-cr\)账号、币种、金额相符，但网关渠道「BANK⟨U\+000D⟩US」/);
    assert.ok(!/_x[0-9A-Fa-f]{4}_/i.test(warned[0].message));
    assert.deepEqual(result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing'), [], '不另报缺渠道');
  });

  test('转义歧义的网关账号不暂存（换出空账号，诊断键为空），与 R5 不参与匹配一致', () => {
    const mapping = new Map([['A\u0000B', 'CLR-NUL'], ['A_x0000_B', 'CLR-LIT']]);
    const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
    prefilter.collect({ ...gwRow({ merchantId: 'A_x0000_B', reconId: 'AMBIGUOUS' }), Channel: '' }, 1);
    prefilter.collect({ ...gwRow({ merchantId: 'A\u0000B', reconId: 'NUL' }), Channel: '' }, 2);
    assert.deepEqual(Array.from(prefilter.stagedCandidates().ids), [2]);
  });

  test('回读后的精确裁决抛错向上传，不当作坏行吞掉；暂存时抛错同样上传', () => {
    const mapping = new Map([['ALIAS', 'CLR']]);
    const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
    const clean = { ...gwRow({ merchantId: 'ALIAS', reconId: 'POISON' }), Channel: '' };
    prefilter.collect(clean, 1);
    const poisoned = { ...clean, currency: { toString: 1 } };
    const source = createR5ChannelMissingDiagnosticSource({
      accountMappingMap: mapping, bankChannels: ['JPM'], prefilter, readRowsByIds: (_ids, onRow) => onRow(poisoned, 1)
    });
    assert.throws(() => source({ bankRows: [{ ...bankRow({ merchantId: 'CLR' }), Channel: 'JPM' }] }), TypeError);
    assert.throws(() => prefilter.collect(poisoned, 2), TypeError);
    const noReader = createR5ChannelMissingDiagnosticSource({ accountMappingMap: mapping, bankChannels: ['JPM'], prefilter });
    assert.throws(() => noReader({ bankRows: [{ ...bankRow({ merchantId: 'CLR' }), Channel: 'JPM' }] }), /按 id 回读/,
      '有候选要回读却没有读取器时报错，不静默少告警');
  });

  test('随机对照：暂存 + 按 id 回读的结果 = 在全部池外行上逐行精确裁决（含映射键值、转义歧义、渠道与金额组合）', () => {
    let state = 424242;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const mappings = [
      new Map([['ALIAS', 'CLR'], ['ALIAS-2', 'CLR-2']]),
      new Map([['A\u0000B', 'CLR'], ['A_x0000_B', 'CLR-2'], ['X_x0041_', 'CLR']]),
      new Map([['ALIAS', 'CLR'], ['CLR', 'CLR-2']])
    ];
    const gwAccounts = ['ALIAS', ' ALIAS', 'ALIAS-2', 'CLR', 'CLR-2', 'A\u0000B', 'A_x0000_B', 'X_x0041_', 'XA', 'OTHER', 123, null];
    const bankAccounts = ['CLR', 'CLR-2', 'OTHER', 'XA'];
    const channels = ['', ' ', 'JPM', 'DBS', null];
    const currencies = ['USD', 'usd', 'HKD', ''];
    const amounts = [100, 200, '100.004', -100, 'x', 1e307];
    const fundTypes = ['FundTransfer-out', 'FundTransfer-in', 'Payment'];
    let nonEmptyRounds = 0;
    let skippedByDigest = 0;
    for (let round = 0; round < 300; round += 1) {
      const mapping = pick(mappings);
      const gws = Array.from({ length: 25 }, (_v, i) => ({
        ...gwRow({
          merchantId: pick(gwAccounts),
          reconId: rand() < 0.1 ? '' : `G${round}-${i}`,
          tradeType: pick(['FundTransfer-out', 'FundTransfer-in', 'Payment']),
          currency: pick(currencies),
          amount: pick(amounts)
        }),
        Channel: pick(channels)
      }));
      const banks = Array.from({ length: 6 }, (_v, i) => ({
        ...bankRow({
          rowId: `b${i}`,
          merchantId: pick(bankAccounts),
          fundType: pick(fundTypes),
          currency: pick(currencies),
          debit: pick([100, 200, 0]),
          credit: pick([0, 100])
        }),
        Channel: pick(channels)
      }));
      const targetAccountsByTradeType = rand() < 0.5
        ? undefined
        : new Map([['FundTransfer-out', new Set([pick(bankAccounts)])], ['FundTransfer-in', new Set([pick(bankAccounts)])]]);
      const bankChannels = ['JPM'];
      const expected = readR5MappedChannelDiagnosticRows(
        ({ select }) => gws.map(select).filter((row) => row != null),
        { accountMappingMap: mapping, bankChannels, bankRows: banks, targetAccountsByTradeType }
      );
      const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
      const rowsById = stageRows(prefilter, gws);
      const calls = [];
      const actual = createR5ChannelMissingDiagnosticSource({
        accountMappingMap: mapping, bankChannels, prefilter, readRowsByIds: idReader(rowsById, calls)
      })({ bankRows: banks, targetAccountsByTradeType });
      assert.deepEqual(actual, expected, `round ${round}`);
      const stagedIds = new Set(prefilter.stagedCandidates().ids);
      for (const id of calls.flat()) assert.ok(stagedIds.has(id), `round ${round} 只回读暂存过的 id`);
      if (expected.length > 0) nonEmptyRounds += 1;
      skippedByDigest += stagedIds.size - calls.flat().length;
    }
    assert.ok(nonEmptyRounds >= 20, `随机样本须覆盖有告警的情形：${nonEmptyRounds}`);
    assert.ok(skippedByDigest > 0, '随机样本须覆盖摘要对不上、不回读的候选');
  });

  test('关闭日期的密集映射桶：每条银行行金额只解析常数次，候选数仍逐条正确', () => {
    let debitReads = 0;
    const size = 1000;
    const banks = [];
    for (let i = 0; i < size; i += 1) {
      const row = { ...bankRow({ rowId: `b${i}`, merchantId: 'CLR' }), Channel: 'JPM' };
      delete row['Debit Amount'];
      Object.defineProperty(row, 'Debit Amount', { enumerable: true, get() { debitReads += 1; return 100; } });
      banks.push(row);
    }
    const gws = Array.from({ length: size }, (_v, i) => ({ ...gwRow({ merchantId: 'ALIAS', reconId: `G${i}` }), Channel: 'JPM' }));
    const result = runRound5FundTransferBackfill(gws, banks, {
      accountMappingMap: new Map([['ALIAS', 'CLR']]),
      fundTransferDatePolicy: { enabled: false, toleranceDays: 1 }
    });
    assert.equal(result.modifications.length, size);
    assert.equal(banks[0].ReconciliationId, 'G0');
    assert.equal(banks[size - 1].ReconciliationId, `G${size - 1}`);
    const multi = result.warnings.filter((w) => w.code === 'multi-bank-match-backfill');
    assert.equal(multi.length, size - 1);
    assert.match(multi[0].message, new RegExp(`匹配到 ${size} 行可用候选`));
    assert.match(multi[size - 2].message, /匹配到 2 行可用候选/);
    assert.ok(debitReads < size * 5, `Debit Amount 读取 ${debitReads} 次`);
  });

  test('映射目标账号候选组与逐行比较等价：方向未通过行、_rowId 重复、日期开关下回填与告警一致', () => {
    const build = (gwMerchantId) => {
      const banks = [];
      for (let i = 0; i < 12; i += 1) {
        const failsDirection = i % 4 === 1;
        const rowId = i === 7 ? 'b6' : `b${i}`; // b6 重复（两行都通过方向）
        const row = { ...bankRow({ rowId, merchantId: 'CLR', billDate: i % 3 === 0 ? '2026-06-08' : '2026-06-07' }), Channel: 'JPM' };
        if (failsDirection) { row['Debit Amount'] = 0; row['Credit Amount'] = 100; }
        banks.push(row);
      }
      const gws = Array.from({ length: 10 }, (_v, i) => (
        { ...gwRow({ merchantId: gwMerchantId, reconId: `G${i}`, billdate: i % 2 ? '2026-06-07' : '2026-06-08' }), Channel: 'JPM' }
      ));
      return { banks, gws };
    };
    const comparable = (result) => ({
      modifications: result.modifications,
      warnings: result.warnings.filter((w) => w.code !== 'r5-mapped-account-contention'),
      used: [...result.usedBankRowIds]
    });
    for (const fundTransferDatePolicy of [{ enabled: false, toleranceDays: 1 }, { enabled: true, toleranceDays: 1 }]) {
      const mapped = build('ALIAS');
      const plain = build('CLR');
      const mappedResult = runRound5FundTransferBackfill(mapped.gws, mapped.banks, {
        accountMappingMap: new Map([['ALIAS', 'CLR']]), fundTransferDatePolicy
      });
      const plainResult = runRound5FundTransferBackfill(plain.gws, plain.banks, { fundTransferDatePolicy });
      assert.deepEqual(comparable(mappedResult), comparable(plainResult), JSON.stringify(fundTransferDatePolicy));
      assert.deepEqual(mapped.banks.map((b) => b.ReconciliationId), plain.banks.map((b) => b.ReconciliationId));
    }
  });

  test('开启日期时映射目标账号按日期分段与逐行比较等价：随机日期、无效日期、容差、_rowId 重复与方向未通过', () => {
    let seed = 20261124;
    const random = () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (values) => values[Math.floor(random() * values.length)];
    const dates = ['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-12', 'bad-date', ''];
    const build = (shape, gwMerchantId) => {
      const banks = shape.banks.map((spec) => {
        const row = { ...bankRow({ rowId: spec.rowId, merchantId: 'CLR', billDate: spec.date, debit: spec.amount }), Channel: 'JPM' };
        if (spec.failsDirection) { row['Debit Amount'] = 0; row['Credit Amount'] = spec.amount; }
        return row;
      });
      if (shape.duplicateObjectAt !== null && banks.length > 0) banks.push(banks[shape.duplicateObjectAt]);
      const gws = shape.gws.map((spec) => ({
        ...gwRow({ merchantId: gwMerchantId, reconId: spec.reconId, billdate: spec.date, amount: spec.amount }),
        Channel: 'JPM'
      }));
      return { banks, gws };
    };
    const comparable = (result) => ({
      modifications: result.modifications,
      warnings: result.warnings.filter((w) => w.code !== 'r5-mapped-account-contention'),
      used: [...result.usedBankRowIds]
    });
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const bankCount = Math.floor(random() * 14);
      const shape = {
        banks: Array.from({ length: bankCount }, (_v, i) => ({
          rowId: random() < 0.15 && i > 0 ? `b${Math.floor(random() * i)}` : `b${i}`,
          date: pick(dates),
          amount: pick([100, 100, 100, 200]),
          failsDirection: random() < 0.15
        })),
        gws: Array.from({ length: Math.floor(random() * 12) }, (_v, i) => ({
          reconId: random() < 0.1 ? '' : `G${i}`,
          date: pick(dates),
          amount: pick([100, 100, 100, 200])
        })),
        duplicateObjectAt: bankCount > 0 && random() < 0.1 ? Math.floor(random() * bankCount) : null
      };
      const fundTransferDatePolicy = { enabled: true, toleranceDays: pick([0, 1, 1, 2, 3, 0.5, -1]) };
      const mapped = build(shape, 'ALIAS');
      const plain = build(shape, 'CLR');
      const mappedResult = runRound5FundTransferBackfill(mapped.gws, mapped.banks, {
        accountMappingMap: new Map([['ALIAS', 'CLR']]), fundTransferDatePolicy
      });
      const plainResult = runRound5FundTransferBackfill(plain.gws, plain.banks, { fundTransferDatePolicy });
      const label = JSON.stringify({ iteration, shape, fundTransferDatePolicy });
      assert.deepEqual(comparable(mappedResult), comparable(plainResult), label);
      assert.deepEqual(mapped.banks.map((b) => b.ReconciliationId), plain.banks.map((b) => b.ReconciliationId), label);
    }
  });

  test('开启日期的同日密集映射桶：每条银行行日期只解析常数次，候选数仍逐条正确', () => {
    let billDateReads = 0;
    const size = 1000;
    const banks = [];
    for (let i = 0; i < size; i += 1) {
      const row = { ...bankRow({ rowId: `b${i}`, merchantId: 'CLR' }), Channel: 'JPM' };
      delete row.BillDate;
      Object.defineProperty(row, 'BillDate', { enumerable: true, get() { billDateReads += 1; return '2026-06-07'; } });
      banks.push(row);
    }
    // 另有一半网关行落在容差阶段（前一天），验证容差阶段同样按段取数。
    const gws = Array.from({ length: size }, (_v, i) => (
      { ...gwRow({ merchantId: 'ALIAS', reconId: `G${i}`, billdate: i % 2 ? '2026-06-06' : '2026-06-07' }), Channel: 'JPM' }
    ));
    const result = runRound5FundTransferBackfill(gws, banks, {
      accountMappingMap: new Map([['ALIAS', 'CLR']]),
      fundTransferDatePolicy: { enabled: true, toleranceDays: 1 }
    });
    assert.equal(result.modifications.length, size);
    assert.equal(banks[0].ReconciliationId, 'G0', '同日阶段先跑完：偶数网关行依次取原序最前的银行行');
    assert.equal(banks[size / 2].ReconciliationId, 'G1', '容差阶段的网关行接着取剩余行');
    const multi = result.warnings.filter((w) => w.code === 'multi-bank-match-backfill');
    assert.equal(multi.length, size - 1);
    assert.match(multi[0].message, new RegExp(`匹配到 ${size} 行可用候选（same-day）`));
    assert.match(multi[size - 2].message, /匹配到 2 行可用候选（±1day）/);
    assert.ok(billDateReads < size * 5, `BillDate 读取 ${billDateReads} 次`);
  });

  test('候选桶只为本方向会查询的账号建立：其余账号的银行行不解析金额', () => {
    let otherDebitReads = 0;
    const banks = [{ ...bankRow({ rowId: 'b-clr', merchantId: 'CLR' }), Channel: 'JPM' }];
    for (let i = 0; i < 500; i += 1) {
      const row = { ...bankRow({ rowId: `b-other-${i}`, merchantId: `OTHER-${i}` }), Channel: 'JPM' };
      delete row['Debit Amount'];
      Object.defineProperty(row, 'Debit Amount', { enumerable: true, get() { otherDebitReads += 1; return 100; } });
      banks.push(row);
    }
    banks.push({ ...bankRow({ rowId: 'b-diag', merchantId: 'DIAG-CLR' }) });
    const result = runRound5FundTransferBackfill(
      [{ ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), Channel: 'JPM' }],
      banks,
      {
        accountMappingMap: new Map([['ALIAS', 'CLR'], ['DIAG-ALIAS', 'DIAG-CLR']]),
        channelMissingDiagnosticGwRows: [gwRow({ merchantId: 'DIAG-ALIAS', reconId: 'GW-DIAG' })]
      }
    );
    assert.equal(banks[0].ReconciliationId, 'GW-ALIAS');
    assert.equal(otherDebitReads, 0, '非查询账号的银行行不进候选桶');
    const missing = result.warnings.filter((w) => w.code === 'r5-mapped-account-channel-missing');
    assert.deepEqual(missing.map((w) => w.rowId), ['b-diag'], '池外诊断行映射后的账号仍建桶并告警');
  });

  test('争用索引只收映射目标账号的已占用银行行：其余账号的成功匹配不解析渠道与金额', () => {
    let otherChannelReads = 0;
    const banks = [{ ...bankRow({ rowId: 'b-clr', merchantId: 'CLR' }), Channel: 'JPM' }];
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-WIN' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'CLR', reconId: 'GW-LOSE' }), Channel: 'JPM' }
    ];
    for (let i = 0; i < 300; i += 1) {
      const row = bankRow({ rowId: `b-other-${i}`, merchantId: `OTHER-${i}` });
      Object.defineProperty(row, 'Channel', { enumerable: true, get() { otherChannelReads += 1; return 'JPM'; } });
      banks.push(row);
      gws.push(gwRow({ merchantId: `OTHER-${i}`, reconId: `GW-OTHER-${i}` }));
    }
    const result = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.equal(banks[0].ReconciliationId, 'GW-WIN');
    assert.equal(banks[1].ReconciliationId, 'GW-OTHER-0', '其余账号照常回填');
    const contention = result.warnings.filter((w) => w.code === 'r5-mapped-account-contention');
    assert.deepEqual(contention.map((w) => w.rowId), ['b-clr'], '映射目标账号的争用告警不变');
    assert.equal(otherChannelReads, 0, '其余账号的已占用银行行不进争用索引');
  });

  test('多渠道同账号同金额：桶内按渠道一次分组，银行渠道读取次数与行数线性（不为每个新渠道重扫整桶）', () => {
    const N = 2000;
    for (const enabled of [false, true]) {
      let channelReads = 0;
      const banks = [];
      const gws = [];
      for (let i = 0; i < N; i += 1) {
        const row = bankRow({ rowId: `b${i}`, merchantId: 'CLR' });
        Object.defineProperty(row, 'Channel', { enumerable: true, get() { channelReads += 1; return `CH-${i}`; } });
        banks.push(row);
        gws.push({ ...gwRow({ merchantId: 'ALIAS', reconId: `GW-${i}` }), Channel: `CH-${N - 1 - i}` });
      }
      const result = runRound5FundTransferBackfill(gws, banks, {
        accountMappingMap: new Map([['ALIAS', 'CLR']]),
        fundTransferDatePolicy: { enabled, toleranceDays: 1 }
      });
      assert.equal(result.modifications.length, N, `每个渠道各回填一对（日期匹配 ${enabled}）`);
      assert.equal(banks[0].ReconciliationId, `GW-${N - 1}`, '按渠道配对，不跨渠道');
      // 按渠道逐个重扫整桶约 N² = 400 万次；一次分组后只剩建索引、分组与告警的常数次。
      assert.ok(channelReads < 10 * N, `银行 Channel 读取 ${channelReads} 次（日期匹配 ${enabled}）`);
    }
  });

  test('密集争用时每条银行行的金额只解析常数次（映射目标账号走桶索引，不随网关行数重复解析）', () => {
    let debitReads = 0;
    const banks = [];
    for (let i = 0; i < 100; i += 1) {
      const row = { ...bankRow({ rowId: `b${i}`, merchantId: 'CLR' }), Channel: 'JPM' };
      delete row['Debit Amount'];
      Object.defineProperty(row, 'Debit Amount', { enumerable: true, get() { debitReads += 1; return 100; } });
      banks.push(row);
    }
    const gws = [];
    for (let i = 0; i < 1100; i += 1) {
      gws.push({ ...gwRow({ merchantId: 'CLR', reconId: `GW-${i}` }), Channel: 'JPM' });
    }
    const result = runRound5FundTransferBackfill(gws, banks, {
      accountMappingMap: new Map([['CLR', 'CLR']]),
      fundTransferDatePolicy: { enabled: false, toleranceDays: 1 }
    });
    assert.equal(result.usedBankRowIds.size, 100);
    assert.equal(result.warnings.filter((w) => w.code === 'r5-mapped-account-contention').length, 1000);
    // 逐行比较需约 1100 × 100 次金额解析；桶索引下只剩建索引、方向校验与争用索引的开销（实测约 5 千次，
    //   不超过同一批数据不配映射时旧路径的约 1 万次）。
    assert.ok(debitReads < 12000, `Debit Amount 读取 ${debitReads} 次`);
  });

  test('本批有映射命中时，其他账号的网关行仍不加 Channel 校验', () => {
    const gws = [
      { ...gwRow({ merchantId: 'ALIAS', reconId: 'GW-ALIAS' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'M001', reconId: 'GW-M001' }), Channel: 'JPM' }
    ];
    const banks = [
      { ...bankRow({ rowId: 'b-clr', merchantId: 'CLR' }), Channel: 'JPM' },
      { ...bankRow({ rowId: 'b-m001', merchantId: 'M001' }), Channel: 'DBS' }
    ];
    runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(banks.map((b) => b.ReconciliationId), ['GW-ALIAS', 'GW-M001']);
  });

  test('directionsValid：方向配置合法为 true，非法整轮跳过为 false', () => {
    assert.equal(runRound5FundTransferBackfill([gwRow()], [bankRow()]).directionsValid, true);
    assert.equal(runRound5FundTransferBackfill([gwRow()], [], { directions: undefined }).directionsValid, false);
    assert.equal(runRound5FundTransferBackfill([gwRow()], [bankRow()], { directions: [] }).directionsValid, false);
  });

  test('未命中映射的网关行不加 Channel 校验（与改动前一致）', () => {
    const gws = [{ ...gwRow({ merchantId: 'M001', reconId: 'GW-1' }), Channel: 'JPM' }];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'M001' }), Channel: 'DBS' }];
    const baseline = runRound5FundTransferBackfill(structuredClone(gws), structuredClone(banks));
    const withMap = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: new Map([['ALIAS', 'CLR']]) });
    assert.deepEqual(withMap.modifications, baseline.modifications);
    assert.deepEqual(withMap.modifications.map((m) => m.newValue), ['GW-1']);
  });

  test('映射后仍严格 1:1：两条网关行映射到同一账号只消费一条银行行', () => {
    const map = new Map([['GW-A', 'CLR-1'], ['GW-B', 'CLR-1']]);
    const gws = [
      { ...gwRow({ merchantId: 'GW-A', reconId: 'GW-1' }), Channel: 'JPM' },
      { ...gwRow({ merchantId: 'GW-B', reconId: 'GW-2' }), Channel: 'JPM' }
    ];
    const banks = [{ ...bankRow({ rowId: 'b1', merchantId: 'CLR-1', debit: 100 }), Channel: 'JPM' }];
    const { modifications, usedBankRowIds } = runRound5FundTransferBackfill(gws, banks, { accountMappingMap: map });
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].newValue, 'GW-1', '按网关原序先到先得');
    assert.deepEqual([...usedBankRowIds], ['b1']);
  });
});
