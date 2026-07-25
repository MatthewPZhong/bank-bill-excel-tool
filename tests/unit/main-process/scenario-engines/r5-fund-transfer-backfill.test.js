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

// ---- 边界兜底 ----------------------------------------------------------

test.describe('R5场景2 — 边界兜底', () => {
  test('空 gwRows / 空 bankRows / 非数组入参 不崩，返回空 modifications', () => {
    assert.deepEqual(runRound5FundTransferBackfill([], []).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill(null, null).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill(undefined, undefined).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill([gwRow()], []).modifications, []);
    assert.deepEqual(runRound5FundTransferBackfill([], [bankRow()]).modifications, []);
  });

  test('directions 可 config 化：自定义单方向只跑该方向', () => {
    const gws = [
      gwRow({ tradeType: 'FundTransfer-out', amount: 500, reconId: 'GW-OUT' }),
      gwRow({ tradeType: 'FundTransfer-in', amount: 600, reconId: 'GW-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: 'FundTransfer-out', credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: 'FundTransfer-in', credit: 600, debit: 0, reconId: '' })
    ];
    // 只配 out 方向 → in 那对不参与
    const { modifications } = runRound5FundTransferBackfill(gws, banks, {
      directions: [{ gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' }]
    });
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].rowId, 'bo');
  });
});
