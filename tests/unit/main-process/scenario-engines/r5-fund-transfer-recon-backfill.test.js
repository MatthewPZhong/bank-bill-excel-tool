// v3.0.6 需求2「中台调拨订单对账ID回填（数据来源=调拨对账单）」引擎单测（🔴 资金红线）
// plan「需求2」/ 资金红线 review 点 2、4（大账号已派生固化，引擎零方向分支）、7。
//
// 覆盖（task 清单）：
//   ① 同日命中回填 ReconciliationId（断言写入调拨 ReconID + modification + 银行行原地改写）
//   ② 同日无候选 → ±1day 兜底命中；差 2 天不命中
//   ③ 金额 = |Credit-Debit| + signed Extra Fee，先加总再按分精度比较，合计后不再 abs
//   ④ 币种不等不命中
//   ⑤ big_account ≠ MerchantId 不命中（大账号方向已固化，引擎零分支）
//   ⑥ in/out 方向隔离（out 调拨不命中 in 银行行）
//   ⑦ 严格 1v1（两条 recon 抢一条 bank → 仅一回填 + warning）
//   ⑧ 空 ReconID 不进池（不占用银行候选）
//   ⑨ usedBankRowIds 完整消费集（含同值未写命中行）
//   ⑩ 空入参 no-op
//
// 调拨对账单行字段一律经 RECON 常量构造 key（绝不手敲列名 —— 铁律）。
// 日期一律用纯字符串（与 engine-date-utils.test.js 同口径，复用 normalizeDateExportValue 解析）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRound5FundTransferReconBackfill,
  amountEqual,
  reconAmountAbs
} = require('../../../../src/main-process/scenario-engines/r5-fund-transfer-recon-backfill');

const { FT_RECON_FIELD_MAP } = require('../../../../src/constants/fund-transfer-recon-fields');

const RECON = FT_RECON_FIELD_MAP.recon;
const FUND_IN = FT_RECON_FIELD_MAP.FUND_TYPE_IN;   // 'FundTransfer-in'
const FUND_OUT = FT_RECON_FIELD_MAP.FUND_TYPE_OUT; // 'FundTransfer-out'

// ---- 测试夹具 ----------------------------------------------------------

// 调拨对账单派生行：key 全部用 RECON 常量（big_account / 币种 / 金额 / BillDate / ReconID / fund_type）。
//   默认 out 方向、big_account=M001、USD、金额 100、ReconID=RC-1、BillDate=2026-06-07。
function reconRow({
  fundType = FUND_OUT,
  bigAccount = 'M001',
  currency = 'USD',
  amount = 100,
  billDate = '2026-06-07',
  reconId = 'RC-1',
  used = ''
} = {}) {
  return {
    [RECON.fundType]: fundType,
    [RECON.bigAccount]: bigAccount,
    [RECON.currency]: currency,
    [RECON.amount]: amount,
    [RECON.billDate]: billDate,
    [RECON.reconId]: reconId,
    [RECON.used]: used
  };
}

// 银行行（驼峰，与 R5s2 完全一致）：_rowId / FundType / MerchantId / Currency / Credit+Debit 双列 /
//   BillDate / ReconciliationId。金额匹配只看 |credit - debit|。
function bankRow({
  rowId = 'b1',
  fundType = FUND_OUT,
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

// ---- 金额口径单元（amountEqual / reconAmountAbs）-----------------------

test.describe('R5场景2(调拨对账单) — 金额发生额绝对值口径', () => {
  test('reconAmountAbs = |金额单列|；非数值 → NaN', () => {
    assert.equal(reconAmountAbs({ [RECON.amount]: -100 }), 100);
    assert.equal(reconAmountAbs({ [RECON.amount]: 100 }), 100);
    assert.ok(Number.isNaN(reconAmountAbs({ [RECON.amount]: 'abc' })));
    assert.ok(Number.isNaN(reconAmountAbs({})));
  });

  test('amountEqual 精确到分：相等 true、差 1 分 false', () => {
    assert.equal(amountEqual({ [RECON.amount]: 100.5 }, { 'Credit Amount': 0, 'Debit Amount': 100.5 }), true);
    assert.equal(amountEqual({ [RECON.amount]: 100.5 }, { 'Credit Amount': 0, 'Debit Amount': 100.51 }), false);
    // 浮点漂移防御
    assert.equal(amountEqual({ [RECON.amount]: 0.3 }, { 'Credit Amount': 0.1, 'Debit Amount': -0.2 }), true);
  });

  test('amountEqual 纳入 signed Extra Fee：正/负/空值分别按 105/95/100 比较', () => {
    assert.equal(
      amountEqual(
        { [RECON.amount]: 105 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 5 }
      ),
      true
    );
    assert.equal(
      amountEqual(
        { [RECON.amount]: 95 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': -5 }
      ),
      true
    );
    assert.equal(
      amountEqual(
        { [RECON.amount]: 100 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': ' ' }
      ),
      true
    );
  });

  test('先加总再归分，且合计后不再 abs', () => {
    const sumBeforeRounding = {
      'Credit Amount': 0,
      'Debit Amount': '100.004',
      'Extra Fee': '0.004'
    };
    assert.equal(amountEqual({ [RECON.amount]: '100.01' }, sumBeforeRounding), true);
    assert.equal(amountEqual({ [RECON.amount]: '100.00' }, sumBeforeRounding), false);
    const negativeTotal = { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': -150 };
    assert.equal(amountEqual({ [RECON.amount]: 50 }, negativeTotal), false);
    assert.equal(
      amountEqual({ [RECON.amount]: -50 }, negativeTotal),
      false,
      '对手仍取绝对值，正负 50 都不得命中银行合计 -50'
    );
  });

  test('科学计数法手续费参与计算，主金额与负手续费抵消为 0 时按合计值匹配', () => {
    assert.equal(
      amountEqual(
        { [RECON.amount]: 100.5 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': '5e-1' }
      ),
      true
    );
    assert.equal(
      amountEqual(
        { [RECON.amount]: 0 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': -100 }
      ),
      true
    );
  });

  test('amountEqual 两侧任一非有限数 → false（不误判相等）', () => {
    assert.equal(amountEqual({ [RECON.amount]: 'x' }, { 'Credit Amount': 0, 'Debit Amount': 100 }), false);
    assert.equal(
      amountEqual(
        { [RECON.amount]: 100 },
        { 'Credit Amount': 0, 'Debit Amount': 100, 'Extra Fee': 'bad-fee' }
      ),
      false
    );
  });
});

// ---- v3.0.26 Extra Fee 端到端 -----------------------------------------

test.describe('R5场景2(调拨对账单) — Extra Fee 端到端匹配与非法值退出', () => {
  test('正/负/空 fee 分别按 105/95/100 匹配调拨金额', () => {
    const cases = [
      { rowId: 'positive', extraFee: 5, reconAmount: 105, reconId: 'RC-POS' },
      { rowId: 'negative', extraFee: -5, reconAmount: 95, reconId: 'RC-NEG' },
      { rowId: 'empty', extraFee: ' ', reconAmount: 100, reconId: 'RC-EMPTY' }
    ];

    for (const item of cases) {
      const banks = [bankRow({ rowId: item.rowId, debit: 100, extraFee: item.extraFee })];
      const result = runRound5FundTransferReconBackfill(
        [reconRow({ amount: item.reconAmount, reconId: item.reconId })],
        banks
      );
      assert.equal(result.modifications.length, 1, `${item.rowId} fee 应命中`);
      assert.equal(banks[0].ReconciliationId, item.reconId);
      assert.deepEqual(result.warnings, []);
    }
  });

  test('非空非法 fee 的银行行退出 R5、不占候选，并且一行只产生一次可见 warning', () => {
    const recons = [
      reconRow({ amount: 100, reconId: 'RC-FIRST' }),
      reconRow({ amount: 100, reconId: 'RC-SECOND' })
    ];
    const banks = [
      bankRow({ rowId: 'bad-fee', debit: 100, extraFee: 'oops' }),
      bankRow({ rowId: 'valid', debit: 100, extraFee: '' })
    ];

    const result = runRound5FundTransferReconBackfill(recons, banks);

    assert.equal(banks[0].ReconciliationId, '', '非法 fee 行退出 R5，不得被回填');
    assert.equal(banks[1].ReconciliationId, 'RC-FIRST', '非法行不占用候选，后续合法行仍可命中');
    assert.deepEqual(result.modifications.map((m) => m.rowId), ['valid']);
    assert.ok(!result.usedBankRowIds.has('bad-fee'), '非法 fee 行不得进入消费集');
    const feeWarnings = result.warnings.filter((warning) => warning.code === 'r5-invalid-extra-fee');
    assert.equal(feeWarnings.length, 1, '同一银行行面对多条调拨行也只告警一次');
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
    const result = runRound5FundTransferReconBackfill(
      [],
      [bankRow({ rowId: 'bad-without-recon', extraFee: 'oops' })]
    );
    assert.deepEqual(result.modifications, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'r5-invalid-extra-fee');
    assert.equal(result.warnings[0].rowId, 'bad-without-recon');
  });

  test('非法 fee warning 在调拨来源同样按稳定 _rowId 去重', () => {
    const result = runRound5FundTransferReconBackfill(
      [],
      [
        bankRow({ rowId: 'same-id', extraFee: 'first-bad' }),
        bankRow({ rowId: 'same-id', extraFee: 'second-bad' })
      ]
    );
    const feeWarnings = result.warnings.filter((warning) => warning.code === 'r5-invalid-extra-fee');
    assert.equal(feeWarnings.length, 1);
    assert.equal(feeWarnings[0].rowId, 'same-id');
    assert.equal(feeWarnings[0].rawValue, 'first-bad');
  });
});

// ---- ① 同日命中回填 ----------------------------------------------------

test.describe('R5场景2(调拨对账单) — ① 同日命中回填 ReconciliationId', () => {
  test('out 方向同日 + 字段全等 + 金额绝对值相等 → 银行 ReconciliationId 写为调拨 ReconID', () => {
    const recons = [reconRow({ reconId: 'RC-1', amount: 100, billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, warnings } = runRound5FundTransferReconBackfill(recons, banks);

    assert.equal(banks[0].ReconciliationId, 'RC-1', '银行 ReconciliationId 应被回填为调拨 ReconID');
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1',
      column: 'ReconciliationId',
      oldValue: '',
      newValue: 'RC-1'
    });
    assert.deepEqual(warnings, []);
  });

  test('in 方向同日命中（Credit 侧发生额）→ 回填', () => {
    const recons = [reconRow({ fundType: FUND_IN, reconId: 'RC-IN', amount: 600 })];
    const banks = [bankRow({ rowId: 'bi', fundType: FUND_IN, credit: 600, debit: 0, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, 'in 方向 Credit 侧应命中');
    assert.equal(banks[0].ReconciliationId, 'RC-IN');
  });
});

// ---- ② ±1day 兜底 -----------------------------------------------------

test.describe('R5场景2(调拨对账单) — ② 同日无候选 → ±1day 兜底', () => {
  test('调拨 06-07、银行 06-08（差 1 天）、同日无候选 → ±1day 命中回填', () => {
    const recons = [reconRow({ reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-08', reconId: '' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '差 1 天应在 Phase2 命中');
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });

  test('差 2 天 → 超出 ±1day（默认），不命中', () => {
    const recons = [reconRow({ reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-09', reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, '差 2 天超出 ±1day 不命中');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('dateToleranceDays 可 config 化：差 2 天 + tolerance=2 → 命中', () => {
    const recons = [reconRow({ reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-09', reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks, { dateToleranceDays: 2 });
    assert.equal(modifications.length, 1);
  });

  test('同日优先：一条 recon 同时有同日 + 差 1 天候选 → 消费同日那条（Phase 分离）', () => {
    const recons = [reconRow({ reconId: 'RC-1', billDate: '2026-06-07' })];
    // 原序故意把差 1 天放前面：若无 Phase 分离会先选差 1 天的
    const banks = [
      bankRow({ rowId: 'b_diff', debit: 100, billDate: '2026-06-08', reconId: '' }),
      bankRow({ rowId: 'b_same', debit: 100, billDate: '2026-06-07', reconId: '' })
    ];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1);
    assert.equal(modifications[0].rowId, 'b_same', '应优先消费同日银行行（Phase1 先于 Phase2）');
    assert.equal(banks[0].ReconciliationId, '', 'b_diff 未被回填');
  });

  test('全局 Phase1：前序 recon 的 +1 候选必须先留给后序 recon 的同日匹配', () => {
    const recons = [
      reconRow({ reconId: 'RC-FIRST', billDate: '2026-07-10' }),
      reconRow({ reconId: 'RC-SAME-DAY', billDate: '2026-07-11' })
    ];
    const banks = [
      bankRow({ rowId: 'b-0711', debit: 100, billDate: '2026-07-11', reconId: '' }),
      bankRow({ rowId: 'b-0709', debit: 100, billDate: '2026-07-09', reconId: '' })
    ];

    const result = runRound5FundTransferReconBackfill(recons, banks, {
      fundTransferDatePolicy: { enabled: true, toleranceDays: 1 }
    });

    assert.equal(banks[0].ReconciliationId, 'RC-SAME-DAY');
    assert.equal(banks[1].ReconciliationId, 'RC-FIRST');
    assert.deepEqual(
      result.modifications.map((item) => [item.rowId, item.newValue]),
      [
        ['b-0711', 'RC-SAME-DAY'],
        ['b-0709', 'RC-FIRST']
      ]
    );
  });
});

// ---- ③ 金额差 1 分不命中 ----------------------------------------------

test.describe('R5场景2(调拨对账单) — ③ 金额精确到分（端到端）', () => {
  test('相差 1 分（0.01）→ 不命中', () => {
    const recons = [reconRow({ amount: 100.0, reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100.01, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, '相差 1 分不命中');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('金额相等（含分位）→ 命中', () => {
    const recons = [reconRow({ amount: 100.01, reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100.01, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '分位完全相等应命中');
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });

  test('调拨金额带负号、银行走 debit → |金额| 与 |credit-debit| 相等命中', () => {
    const recons = [reconRow({ amount: -250.75, reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', credit: 0, debit: 250.75, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1);
  });
});

// ---- ④ 币种不等不命中 -------------------------------------------------

test.describe('R5场景2(调拨对账单) — ④ 币种不等不命中', () => {
  test('调拨 USD vs 银行 HKD → 不命中、不改写', () => {
    const recons = [reconRow({ currency: 'USD', reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', currency: 'HKD', debit: 100, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0);
    assert.equal(banks[0].ReconciliationId, '');
  });
});

// ---- ⑤ big_account ≠ MerchantId 不命中 --------------------------------

test.describe('R5场景2(调拨对账单) — ⑤ big_account ≠ MerchantId 不命中（大账号方向已固化，引擎零分支）', () => {
  test('调拨 big_account=M001 vs 银行 MerchantId=M999 → 不命中', () => {
    const recons = [reconRow({ bigAccount: 'M001', reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'M999', debit: 100, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, 'big_account 与 MerchantId 不等不命中');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('big_account=MerchantId 才命中（正向对照）', () => {
    const recons = [reconRow({ bigAccount: 'ACC-777', reconId: 'RC-1' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'ACC-777', debit: 100, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, 'big_account 等于 MerchantId 命中');
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });
});

// ---- ⑥ in/out 方向隔离 -------------------------------------------------

test.describe('R5场景2(调拨对账单) — ⑥ in/out 方向独立池隔离', () => {
  test('out 调拨不会命中 in 银行行（fund_type / FundType 过滤隔离）', () => {
    const recons = [reconRow({ fundType: FUND_OUT, amount: 700, reconId: 'RC-OUT' })];
    // 银行行是 in 方向、金额/big_account/币种都对得上，但方向不同
    const banks = [bankRow({ rowId: 'b1', fundType: FUND_IN, credit: 700, debit: 0, reconId: '' })];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, 'out 调拨不应命中 in 银行行（池子隔离）');
    assert.equal(banks[0].ReconciliationId, '');
  });

  test('out + in 各一对混在一起 → 各自命中各自方向', () => {
    const recons = [
      reconRow({ fundType: FUND_OUT, amount: 500, reconId: 'RC-OUT' }),
      reconRow({ fundType: FUND_IN, amount: 600, reconId: 'RC-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: FUND_OUT, credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: FUND_IN, credit: 600, debit: 0, reconId: '' })
    ];
    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 2);
    const byRow = Object.fromEntries(modifications.map((m) => [m.rowId, m.newValue]));
    assert.equal(byRow['bo'], 'RC-OUT');
    assert.equal(byRow['bi'], 'RC-IN');
  });
});

// ---- ⑦ 严格 1v1（两 recon 争一 bank）----------------------------------

test.describe('R5场景2(调拨对账单) — ⑦ 严格 1v1：两条 recon 争一条 bank', () => {
  test('两条同字段同日 recon 抢同一条 bank → 仅第一条回填 + multi-bank-match 不发（候选只 1 行）', () => {
    // 两条 recon 抢 1 条 bank：第一条消费后第二条候选为空 → 第二条不命中、不报 multi（multi 是"一 recon 多 bank"）
    const recons = [
      reconRow({ reconId: 'RC-1', billDate: '2026-06-07' }),
      reconRow({ reconId: 'RC-2', billDate: '2026-06-07' })
    ];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '一条 bank 只能被一条 recon 消费');
    assert.equal(modifications[0].newValue, 'RC-1', '应是第一条 recon 命中');
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });

  test('一条 recon 同日命中两条 bank → 取原序最前 + multi-bank-match-backfill warning', () => {
    const recons = [reconRow({ reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [
      bankRow({ rowId: 'b_first', debit: 100, billDate: '2026-06-07', reconId: '' }),
      bankRow({ rowId: 'b_second', debit: 100, billDate: '2026-06-07', reconId: '' })
    ];

    const { modifications, warnings } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '1v1：只回填一条');
    assert.equal(modifications[0].rowId, 'b_first', 'tie-break 取 bankPool 原序最前');
    assert.equal(banks[1].ReconciliationId, '', '第二条候选不被回填');

    const multiWarn = warnings.find((w) => w.code === 'multi-bank-match-backfill');
    assert.ok(multiWarn, '多候选应发 multi-bank-match-backfill warning');
    assert.equal(multiWarn.phase, 'same-day');
  });
});

// ---- ⑧ 空 ReconID 不进池 ----------------------------------------------

test.describe('R5场景2(调拨对账单) — ⑧ 空 ReconID 调拨行不进池', () => {
  test('空 ReconID recon 不消费银行行 → 后续有效 ReconID recon 仍能回填该行', () => {
    // 两条同方向 recon：第 1 条 ReconID 空、第 2 条有效；均同字段/同日匹配同一条银行行
    const recons = [
      reconRow({ reconId: '', billDate: '2026-06-07', amount: 100 }),
      reconRow({ reconId: 'RC-VALID', billDate: '2026-06-07', amount: 100 })
    ];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '空 ReconID 行不应占用银行行，有效行应回填');
    assert.equal(modifications[0].rowId, 'b1');
    assert.equal(modifications[0].newValue, 'RC-VALID');
    assert.equal(banks[0].ReconciliationId, 'RC-VALID');
    // 空 ReconID 行未进池 → 未消费任何行；最终消费集只含被有效行回填的 b1
    assert.equal(usedBankRowIds.size, 1);
    assert.ok(usedBankRowIds.has('b1'));
  });
});

// ---- ⑨ usedBankRowIds 完整消费集（含同值未写命中行）--------------------

test.describe('R5场景2(调拨对账单) — ⑨ usedBankRowIds 含「消费但未写」行', () => {
  test('实写命中行 → usedBankRowIds 含该 _rowId（与 modification 一致）', () => {
    const recons = [reconRow({ reconId: 'RC-1', amount: 100, billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1);
    assert.ok(usedBankRowIds instanceof Set, 'usedBankRowIds 应为 Set');
    assert.ok(usedBankRowIds.has('b1'));
    assert.equal(usedBankRowIds.size, 1);
  });

  test('🔴 同值未写命中行 → 不产 modification 但 usedBankRowIds 仍含该 _rowId（红线核心断言）', () => {
    // 银行原值已等于调拨 ReconID → backfill 内 old===nv 不 record（modifications 空），
    //   但 usedBankRowId.add(chosen._rowId) 已消费 → 必须出现在 usedBankRowIds（供 R5s2b 剔除）。
    const recons = [reconRow({ reconId: 'SAME-RC', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b_same', debit: 100, billDate: '2026-06-07', reconId: 'SAME-RC' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, '同值不产 modification');
    assert.ok(usedBankRowIds instanceof Set);
    assert.ok(
      usedBankRowIds.has('b_same'),
      '同值未写行虽不在 modifications，但已被 1v1 消费 → 必须出现在 usedBankRowIds'
    );
    assert.equal(usedBankRowIds.size, 1);
  });

  test('双方向各消费一行 → usedBankRowIds 聚合两方向（跨 direction union）', () => {
    const recons = [
      reconRow({ fundType: FUND_OUT, amount: 500, reconId: 'RC-OUT' }),
      reconRow({ fundType: FUND_IN, amount: 600, reconId: 'RC-IN' })
    ];
    const banks = [
      bankRow({ rowId: 'bo', fundType: FUND_OUT, credit: 0, debit: 500, reconId: '' }),
      bankRow({ rowId: 'bi', fundType: FUND_IN, credit: 600, debit: 0, reconId: '' })
    ];
    const { usedBankRowIds } = runRound5FundTransferReconBackfill(recons, banks);
    assert.ok(usedBankRowIds.has('bo') && usedBankRowIds.has('bi'), '两方向消费行都进聚合集');
    assert.equal(usedBankRowIds.size, 2);
  });
});

// ---- ⑩ 原值非空被覆盖 / 网关空不清空 ----------------------------------

test.describe('R5场景2(调拨对账单) — 原值非空被覆盖 / 调拨空不清空', () => {
  test('银行 ReconciliationId 原值非空 → 仍被覆盖写入（命中即覆盖，无 overwrite warning）', () => {
    const recons = [reconRow({ reconId: 'RC-NEW' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, reconId: 'OLD-RC' })];

    const { modifications, warnings } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(banks[0].ReconciliationId, 'RC-NEW', '原值非空仍被覆盖写入');
    assert.equal(modifications.length, 1);
    assert.deepEqual(modifications[0], {
      rowId: 'b1',
      column: 'ReconciliationId',
      oldValue: 'OLD-RC',
      newValue: 'RC-NEW'
    });
    assert.ok(!warnings.find((w) => w.code === 'reconid-overwrite-backfill'));
  });

  test('调拨 ReconID 为空 → 不写（不会把银行原值清空）', () => {
    const recons = [reconRow({ reconId: '' })];
    const banks = [bankRow({ rowId: 'b1', debit: 100, reconId: 'KEEP-ME' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, '调拨 ReconID 为空不写');
    assert.equal(banks[0].ReconciliationId, 'KEEP-ME', '银行原值不被清空');
  });
});

// ---- ⑫ 空 big_account 调拨行不命中（🔴 资金红线护栏，line162）---------

test.describe('R5场景2(调拨对账单) — ⑫ 空 big_account 调拨行不进池（负向护栏）', () => {
  test('调拨 big_account 为空 → 不命中 MerchantId 也为空的银行行（valuesEqual("","")===true 的误命中被护栏拦截）', () => {
    // 银行行 MerchantId 也为空：无护栏时 valuesEqual('','')===true 会误命中并写错 ReconciliationId。
    const recons = [reconRow({ bigAccount: '', reconId: 'RC-1', amount: 100, billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', merchantId: '', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications, usedBankRowIds } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 0, '空 big_account 调拨行不应命中空 MerchantId 银行行');
    assert.equal(banks[0].ReconciliationId, '', '银行行未被回填');
    assert.equal(usedBankRowIds.size, 0, '空 big_account 行未进池 → 未消费任何银行行');
  });

  test('空 big_account 行不占池：同方向后续有效 big_account 行仍能回填同一银行行', () => {
    // 第 1 条 big_account 空（不进池）、第 2 条有效；两条若都按空 MerchantId 误配会抢同一行。
    const recons = [
      reconRow({ bigAccount: '', reconId: 'RC-EMPTY', amount: 100, billDate: '2026-06-07' }),
      reconRow({ bigAccount: 'M001', reconId: 'RC-VALID', amount: 100, billDate: '2026-06-07' })
    ];
    const banks = [bankRow({ rowId: 'b1', merchantId: 'M001', debit: 100, billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, '仅有效 big_account 行回填');
    assert.equal(modifications[0].newValue, 'RC-VALID');
    assert.equal(banks[0].ReconciliationId, 'RC-VALID');
  });
});

// ---- ⑬ Phase2 多候选按天数差升序排序 ----------------------------------

test.describe('R5场景2(调拨对账单) — ⑬ Phase2 多候选按绝对天数差升序（差小优先）', () => {
  test('tolerance=2：差 1 天候选优先于差 2 天候选（即便差 2 天在原序最前）', () => {
    // 调拨 06-07；候选 b_diff2(06-09 差2天) 原序在前、b_diff1(06-08 差1天) 在后。
    //   无同日候选 → 进 Phase2；按 dayDiffAbs 升序 → 应选差 1 天的 b_diff1（不是原序首行）。
    const recons = [reconRow({ reconId: 'RC-1', amount: 100, billDate: '2026-06-07' })];
    const banks = [
      bankRow({ rowId: 'b_diff2', debit: 100, billDate: '2026-06-09', reconId: '' }),
      bankRow({ rowId: 'b_diff1', debit: 100, billDate: '2026-06-08', reconId: '' })
    ];

    const { modifications, warnings } = runRound5FundTransferReconBackfill(recons, banks, { dateToleranceDays: 2 });
    assert.equal(modifications.length, 1, '1v1：只回填一条');
    assert.equal(modifications[0].rowId, 'b_diff1', 'Phase2 多候选按天数差升序 → 取差 1 天那条');
    assert.equal(banks[0].ReconciliationId, '', '差 2 天候选未被回填');

    // 多候选 → multi-bank-match-backfill warning，phase 含 ±2day（tolerance=2 → `±${tolerance}day`）。
    const multiWarn = warnings.find((w) => w.code === 'multi-bank-match-backfill');
    assert.ok(multiWarn, 'Phase2 多候选应发 multi-bank-match-backfill warning');
    assert.equal(multiWarn.phase, '±2day', 'warning phase 应为 ±2day（容差天数入模板）');
    assert.ok(multiWarn.message.includes('±2day'), 'warning message 含 phase 标记 ±2day');
  });
});

// ---- ⑭ 金额字符串入参（parseNumber 千分位）-----------------------------

test.describe('R5场景2(调拨对账单) — ⑭ 金额字符串入参（含千分位）命中', () => {
  test("调拨金额 '1,000'（字符串带千分位）↔ 银行 1000 → 命中", () => {
    const recons = [reconRow({ amount: '1,000', reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', debit: 1000, billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, "字符串 '1,000' 经 parseNumber 应等于银行 1000");
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });

  test("银行发生额字符串 '1,000.00' ↔ 调拨数值 1000 → 命中（双侧字符串均解析）", () => {
    const recons = [reconRow({ amount: 1000, reconId: 'RC-1', billDate: '2026-06-07' })];
    const banks = [bankRow({ rowId: 'b1', credit: 0, debit: '1,000.00', billDate: '2026-06-07', reconId: '' })];

    const { modifications } = runRound5FundTransferReconBackfill(recons, banks);
    assert.equal(modifications.length, 1, "银行侧字符串 '1,000.00' 经 parseNumber 应等于调拨 1000");
    assert.equal(banks[0].ReconciliationId, 'RC-1');
  });
});

test.describe('R5场景2(调拨对账单) v3.1.1 — 严格方向与日期策略', () => {
  test('FundType 路由相同但真实方向相反：不计 multi、不消费；正确方向行才可回填', () => {
    const wrong = bankRow({
      rowId: 'wrong-credit',
      fundType: FUND_OUT,
      credit: 100,
      debit: 0,
      reconId: ''
    });
    const correct = bankRow({
      rowId: 'correct-debit',
      fundType: FUND_OUT,
      credit: 0,
      debit: 100,
      reconId: ''
    });
    const result = runRound5FundTransferReconBackfill(
      [reconRow({ fundType: FUND_OUT, reconId: 'RC-STRICT' })],
      [wrong, correct]
    );

    assert.deepEqual(result.modifications.map((item) => item.rowId), ['correct-debit']);
    assert.deepEqual(Array.from(result.usedBankRowIds), ['correct-debit']);
    assert.equal(wrong.ReconciliationId, '');
    assert.equal(result.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 0);
    const warning = result.warnings.find((item) => item.code === 'fund-transfer-direction-mismatch');
    assert.ok(warning);
    assert.equal(warning.rowId, 'wrong-credit');
    assert.equal(warning.expectedDirection, 'DEBIT');
    assert.equal(warning.reason, 'expected-zero');
  });

  test('日期关闭完全跳过非法日期；日期开启时同一数据失败关闭并告警', () => {
    const makeRows = () => ({
      recons: [reconRow({ reconId: 'RC-NO-DATE', billDate: 'not-a-date' })],
      banks: [bankRow({ rowId: 'b-no-date', debit: 100, billDate: '', reconId: '' })]
    });

    const disabledRows = makeRows();
    const disabled = runRound5FundTransferReconBackfill(disabledRows.recons, disabledRows.banks, {
      fundTransferDatePolicy: { enabled: false, toleranceDays: 7 }
    });
    assert.deepEqual(disabled.modifications.map((item) => item.rowId), ['b-no-date']);
    assert.deepEqual(disabled.warnings, []);

    const enabledRows = makeRows();
    const enabled = runRound5FundTransferReconBackfill(enabledRows.recons, enabledRows.banks, {
      fundTransferDatePolicy: { enabled: true, toleranceDays: 7 }
    });
    assert.deepEqual(enabled.modifications, []);
    assert.equal(enabled.usedBankRowIds.size, 0);
    const dateWarnings = enabled.warnings.filter((item) => item.code === 'fund-transfer-date-mismatch');
    assert.equal(dateWarnings.length, 1, 'Phase1/Phase2 对同一失败候选只告警一次');
    const warning = dateWarnings[0];
    assert.equal(warning.rowId, 'b-no-date');
    assert.equal(warning.expectedDirection, 'DEBIT');
    assert.equal(warning.reason, 'counterpart-date-invalid');
    assert.ok(!JSON.stringify(warning).includes('M001'));
  });

  test('同一来源已有同日合法候选时，日期非法 near-candidate 仍告警且不进入 multi/消费/改写', () => {
    const banks = [
      bankRow({ rowId: 'same-day-valid', debit: 100, billDate: '2026-06-07', reconId: '' }),
      bankRow({ rowId: 'invalid-date', debit: 100, billDate: '', reconId: '' }),
      bankRow({ rowId: 'outside-date', debit: 100, billDate: '2026-06-09', reconId: '' })
    ];

    const result = runRound5FundTransferReconBackfill(
      [reconRow({ reconId: 'RC-AUDIT', billDate: '2026-06-07' })],
      banks,
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 1 } }
    );

    assert.equal(banks[0].ReconciliationId, 'RC-AUDIT');
    assert.equal(banks[1].ReconciliationId, '');
    assert.equal(banks[2].ReconciliationId, '');
    assert.deepEqual(result.modifications.map((item) => item.rowId), ['same-day-valid']);
    assert.deepEqual(Array.from(result.usedBankRowIds), ['same-day-valid']);
    assert.equal(
      result.warnings.filter((warning) => warning.code === 'multi-bank-match-backfill').length,
      0
    );

    const dateWarnings = result.warnings.filter(
      (warning) => warning.code === 'fund-transfer-date-mismatch'
    );
    assert.deepEqual(
      dateWarnings.map((warning) => [warning.rowId, warning.reason]),
      [
        ['invalid-date', 'bank-date-invalid'],
        ['outside-date', 'outside-tolerance']
      ]
    );
    assert.equal(JSON.stringify(dateWarnings).includes('M001'), false);
  });

  test('25×25 日期失败密集组按银行行/方向/原因去重，Phase1/2 不放大为 625 条', () => {
    const secretAccount = 'DENSE-SECRET-ACCOUNT';
    const recons = Array.from({ length: 25 }, (_, index) => reconRow({
      bigAccount: secretAccount,
      reconId: `DENSE-RECON-${index}`,
      billDate: '2026-07-01'
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
    const sourceBefore = structuredClone(recons);
    const banksBefore = structuredClone(banks);

    const result = runRound5FundTransferReconBackfill(recons, banks, {
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
    assert.deepEqual(recons, sourceBefore, '调拨来源行保持只读');
    assert.deepEqual(banks, banksBefore, '银行行保持未消费、未改写');
  });

  test('同一银行行的不同日期失败原因分别保留', () => {
    const bank = bankRow({
      rowId: 'multi-reason-bank',
      merchantId: 'M001',
      debit: 100,
      billDate: '2026-08-01'
    });
    const result = runRound5FundTransferReconBackfill(
      [
        reconRow({ reconId: 'INVALID-SOURCE', billDate: 'not-a-date' }),
        reconRow({ reconId: 'OUTSIDE-SOURCE', billDate: '2026-07-01' })
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

  test('±7 边界包含，+8 排除；等绝对差继续按银行原序', () => {
    const boundary = runRound5FundTransferReconBackfill(
      [reconRow({ reconId: 'RC-N7', billDate: '2026-07-01' })],
      [
        bankRow({ rowId: 'plus-8', debit: 100, billDate: '2026-07-09', reconId: '' }),
        bankRow({ rowId: 'plus-7', debit: 100, billDate: '2026-07-08', reconId: '' })
      ],
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 7 } }
    );
    assert.deepEqual(boundary.modifications.map((item) => item.rowId), ['plus-7']);

    const tie = runRound5FundTransferReconBackfill(
      [reconRow({ reconId: 'RC-TIE', billDate: '2026-07-10' })],
      [
        bankRow({ rowId: 'future', debit: 100, billDate: '2026-07-11', reconId: '' }),
        bankRow({ rowId: 'past', debit: 100, billDate: '2026-07-09', reconId: '' })
      ],
      { fundTransferDatePolicy: { enabled: true, toleranceDays: 1 } }
    );
    assert.deepEqual(tie.modifications.map((item) => item.rowId), ['future']);
    assert.equal(tie.warnings.filter((item) => item.code === 'multi-bank-match-backfill').length, 1);
  });
});

test.describe('R5场景2(调拨对账单) v3.1.1 — directions 整体校验', () => {
  const canonical = [
    { gwTradeType: FUND_OUT, bankFundType: FUND_OUT },
    { gwTradeType: FUND_IN, bankFundType: FUND_IN }
  ];

  test('缺项、重复、额外、错配、未知及显式缺失均整轮零消费，只产生一次配置告警', () => {
    const invalidConfigs = [
      undefined,
      [canonical[0]],
      [canonical[0], canonical[0]],
      [...canonical, { gwTradeType: 'extra', bankFundType: 'extra' }],
      [{ gwTradeType: FUND_OUT, bankFundType: FUND_IN }, canonical[1]],
      [canonical[0], { gwTradeType: 'UNKNOWN', bankFundType: 'UNKNOWN' }]
    ];
    for (const directions of invalidConfigs) {
      const bank = bankRow({ rowId: 'b-config', reconId: '' });
      const result = runRound5FundTransferReconBackfill(
        [reconRow({ reconId: 'RC-CONFIG' })],
        [bank],
        { directions }
      );
      assert.deepEqual(result.modifications, []);
      assert.equal(result.usedBankRowIds.size, 0);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'r5-fund-transfer-directions-invalid');
      assert.equal(bank.ReconciliationId, '');
    }
  });

  test('canonical 两对顺序反转仍可执行', () => {
    const result = runRound5FundTransferReconBackfill(
      [reconRow({ fundType: FUND_OUT, reconId: 'RC-VALID' })],
      [bankRow({ rowId: 'b-valid', fundType: FUND_OUT, debit: 100, reconId: '' })],
      { directions: [canonical[1], canonical[0]] }
    );
    assert.deepEqual(result.modifications.map((item) => item.rowId), ['b-valid']);
    assert.equal(result.warnings.length, 0);
  });
});

// ---- ⑪ 空入参 no-op ---------------------------------------------------

test.describe('R5场景2(调拨对账单) — 空入参 no-op', () => {
  test('空 reconRows / 空 bankRows / 非数组入参 不崩，返回空 modifications + 空 Set', () => {
    for (const r of [
      runRound5FundTransferReconBackfill([], []),
      runRound5FundTransferReconBackfill(null, null),
      runRound5FundTransferReconBackfill(undefined, undefined),
      runRound5FundTransferReconBackfill([reconRow()], []),
      runRound5FundTransferReconBackfill([], [bankRow()])
    ]) {
      assert.deepEqual(r.modifications, []);
      assert.deepEqual(r.warnings, []);
      assert.ok(r.usedBankRowIds instanceof Set);
      assert.equal(r.usedBankRowIds.size, 0);
    }
  });
});

test.describe('R5场景2(调拨对账单) v3.1.7 — 与 Payment 共享消费状态', () => {
  test('是否被使用=1 的派生行必须跳过', () => {
    const source = reconRow({ reconId: 'USED', used: '1' });
    const bank = bankRow({ reconId: '' });
    const result = runRound5FundTransferReconBackfill([source], [bank]);

    assert.deepEqual(result.modifications, []);
    assert.equal(bank.ReconciliationId, '');
    assert.equal(source[RECON.used], '1');
  });

  test('excludeBankRowIds 中的 Payment 银行行必须跳过', () => {
    const source = reconRow({ reconId: 'R5-MUST-NOT-WRITE' });
    const bank = bankRow({ rowId: 'payment-bank', reconId: '' });
    const result = runRound5FundTransferReconBackfill([source], [bank], {
      excludeBankRowIds: new Set(['payment-bank'])
    });

    assert.deepEqual(result.modifications, []);
    assert.equal(bank.ReconciliationId, '');
    assert.equal(source[RECON.used], '');
  });

  test('R5 命中后标记派生行；同值命中也标记并消费银行行', () => {
    const changed = reconRow({ reconId: 'CHANGED' });
    const changedBank = bankRow({ rowId: 'changed', reconId: '' });
    const changedResult = runRound5FundTransferReconBackfill([changed], [changedBank]);
    assert.equal(changed[RECON.used], '1');
    assert.deepEqual([...changedResult.usedBankRowIds], ['changed']);

    const same = reconRow({ reconId: 'SAME' });
    const sameBank = bankRow({ rowId: 'same', reconId: 'SAME' });
    const sameResult = runRound5FundTransferReconBackfill([same], [sameBank]);
    assert.equal(same[RECON.used], '1');
    assert.deepEqual(sameResult.modifications, []);
    assert.deepEqual([...sameResult.usedBankRowIds], ['same']);
  });
});
