// v3.0.12 功能1「异常-人工判断 sheet」检测器单测（🔴 资金红线·纯只读）
// plan「功能 1」§1.1 单测清单。
//
// 覆盖：
//   ① NvM 命中（网关）：2 银行 × 2 网关 同账号同币种同金额同日 → 两条银行行均命中
//   ② 1v1 / 1vN / Nv1 不命中
//   ③ 非 FundTransfer 银行行也能命中（验证不限 FundType）
//   ④ 空账号 / 空币种 / 非有限金额 / 非法 Extra Fee 被空值护栏排除（不误并大组）
//   ⑤ 日期：±1 边界成边（命中）、差 2 天不成边（不命中）
//   ⑥ 网关 + 调拨同一银行行命中 → 去重为一条、note 合并两侧
//   ⑦ 调拨侧单独命中（网关空）
//   ⑧ 空入参 no-op（[] / null / 仅银行行）
//   ⑨ 🔴 纯只读：检测前后 bankRows 深度不变（不写任何字段）
//   ⑩ 性能·门控短路（v3.0.12）：无任何 banks≥2 键 → 直接 []，且 cpRows 完全未被触碰（探针：一访问即抛）
//   ⑪ 性能·大组封顶（v3.0.12）：单组 nb×nc 超 MAX_BIPARTITE_EDGES → 不建图、整组银行行全部命中、note 含「规模过大」
//
// 银行/网关/调拨字段一律按引擎真实表头构造（驼峰 / 小写 / RECON 常量），绝不假设同名。
// 日期用纯字符串（复用 normalizeDateExportValue 解析，与 engine-date-utils 同口径）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectFundTransferManyToMany
} = require('../../../../src/main-process/scenario-engines/many-to-many-detector');

const { FT_RECON_FIELD_MAP } = require('../../../../src/constants/fund-transfer-recon-fields');

const RECON = FT_RECON_FIELD_MAP.recon;
const FUND_OUT = FT_RECON_FIELD_MAP.FUND_TYPE_OUT;

// ---- 夹具 --------------------------------------------------------------

let rowCounter = 0;

// 银行行（驼峰；金额 = |Credit-Debit| + signed Extra Fee，默认 Credit=amount / Debit=0 / fee 空）
function bankRow({
  merchantId = 'M1',
  currency = 'USD',
  amount = 100,
  extraFee = '',
  billDate = '2026-06-07',
  fundType = 'FundTransfer-out',
  rowId
} = {}) {
  rowCounter += 1;
  return {
    MerchantId: merchantId,
    Currency: currency,
    'Credit Amount': amount,
    'Debit Amount': 0,
    'Extra Fee': extraFee,
    BillDate: billDate,
    FundType: fundType,
    ReconciliationId: '',
    _rowId: rowId || `b${rowCounter}`
  };
}

// 网关行（小写；金额 = gwAmountAbs = |amount|）
function gwRow({ merchantid = 'M1', currency = 'USD', amount = 100, billdate = '2026-06-07', tradeType = 'FundTransfer-out' } = {}) {
  return { merchantid, currency, amount, Billdate: billdate, TradeType: tradeType };
}

// 调拨对账单行（RECON 常量；金额 = reconAmountAbs = |金额|）
function reconRow({ bigAccount = 'M1', currency = 'USD', amount = 100, billDate = '2026-06-07', fundType = FUND_OUT } = {}) {
  return {
    [RECON.bigAccount]: bigAccount,
    [RECON.currency]: currency,
    [RECON.amount]: amount,
    [RECON.billDate]: billDate,
    [RECON.fundType]: fundType
  };
}

function hitRowIds(result) {
  return result.reviewRows.map((r) => r.row._rowId).sort();
}

// ---- ① NvM 命中（网关）------------------------------------------------

test('NvM：2 银行 × 2 网关 同账号同币种同金额同日 → 两条银行行均命中', () => {
  const banks = [bankRow({ rowId: 'b1' }), bankRow({ rowId: 'b2' })];
  const gws = [gwRow(), gwRow()];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.deepEqual(reviewRows.map((r) => r.row._rowId), ['b1', 'b2']);
  assert.ok(reviewRows.every((r) => /网关/.test(r.note)), 'note 应标注对手方=网关');
  assert.ok(reviewRows.every((r) => /银行 2 行 × 网关 2 行/.test(r.note)), 'note 应含 银行2×网关2');
});

// ---- ② 1v1 / 1vN / Nv1 不命中 ----------------------------------------

test('1v1 不命中', () => {
  const { reviewRows } = detectFundTransferManyToMany([bankRow()], [gwRow()], []);
  assert.equal(reviewRows.length, 0);
});

test('1vN 不命中（银行侧仅 1 行）', () => {
  const { reviewRows } = detectFundTransferManyToMany([bankRow()], [gwRow(), gwRow()], []);
  assert.equal(reviewRows.length, 0);
});

test('Nv1 不命中（对手侧仅 1 行）', () => {
  const { reviewRows } = detectFundTransferManyToMany([bankRow(), bankRow()], [gwRow()], []);
  assert.equal(reviewRows.length, 0);
});

// ---- ③ 非 FundTransfer 银行行也命中（不限 FundType）-------------------

test('非 FundTransfer 银行行也能命中（检测不按 FundType 过滤）', () => {
  const banks = [
    bankRow({ rowId: 'b1', fundType: 'Charge' }),
    bankRow({ rowId: 'b2', fundType: '' })
  ];
  const gws = [gwRow({ tradeType: 'SomethingElse' }), gwRow({ tradeType: '' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
});

// ---- ④ 空值护栏 -------------------------------------------------------

test('空账号被护栏排除（不误并大组）', () => {
  const banks = [bankRow({ merchantId: '' }), bankRow({ merchantId: '' })];
  const gws = [gwRow({ merchantid: '' }), gwRow({ merchantid: '' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0);
});

test('空币种被护栏排除', () => {
  const banks = [bankRow({ currency: '' }), bankRow({ currency: '' })];
  const gws = [gwRow({ currency: '' }), gwRow({ currency: '' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0);
});

test('非有限金额被护栏排除（网关 amount 非数值 → NaN 不进池）', () => {
  // 银行金额有限（Credit=100），但网关 amount='abc' → gwAmountAbs=NaN → 网关行不进池 → 对手侧空 → 不命中
  const banks = [bankRow(), bankRow()];
  const gws = [gwRow({ amount: 'abc' }), gwRow({ amount: 'abc' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0);
});

test('非空非法 Extra Fee 使银行行退出多对多审计池', () => {
  const banks = [
    bankRow({ rowId: 'b1', extraFee: 'bad-fee' }),
    bankRow({ rowId: 'b2', extraFee: 'bad-fee' })
  ];
  const gws = [gwRow({ amount: 100 }), gwRow({ amount: 100 })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0, '非法 fee 返回 NaN，经非有限金额护栏排除');
});

// ---- ⑤ 日期边界 ------------------------------------------------------

test('±1 边界成边 → NvM 命中', () => {
  const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-07' }), bankRow({ rowId: 'b2', billDate: '2026-06-07' })];
  // 两网关都在 +1 日 → 与两银行均成边 → 一个连通分量 2×2 → 命中
  const gws = [gwRow({ billdate: '2026-06-08' }), gwRow({ billdate: '2026-06-08' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
});

test('差 2 天不成边 → 该分量对手不足 2，不命中', () => {
  // 2 银行同日；网关 g1 同日、g2 差 2 天。g2 与银行不成边 →
  //   连通分量 {b1,b2,g1} 仅 1 个对手 → 不命中；g2 孤立。
  const banks = [bankRow({ billDate: '2026-06-07' }), bankRow({ billDate: '2026-06-07' })];
  const gws = [gwRow({ billdate: '2026-06-07' }), gwRow({ billdate: '2026-06-09' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0);
});

// ---- ⑤b options.dateToleranceDays 透传契约（v3.0.12 PR#82 codex-P2-1）--------
//   编排器以 R5s2 场景 config.dateToleranceDays 传入检测器（须与回填引擎实际用值一致）；下面锁死检测器契约：
//   容差≠1 时命中集随容差走（默认容差路径见 ⑤，逐字节不变）。

test('dateToleranceDays=0：隔 1 天的 2×2 组不成边 → 不命中（默认容差 1 下本应命中）', () => {
  const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-07' }), bankRow({ rowId: 'b2', billDate: '2026-06-07' })];
  const gws = [gwRow({ billdate: '2026-06-08' }), gwRow({ billdate: '2026-06-08' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, [], { dateToleranceDays: 0 });
  assert.equal(reviewRows.length, 0, '容差 0 下隔 1 天的 2×2 组不进 reviewRows');
});

test('dateToleranceDays=3：隔 2 天的 2×2 组成边 → 命中（默认容差 1 下本应漏）', () => {
  const banks = [bankRow({ rowId: 'b1', billDate: '2026-06-07' }), bankRow({ rowId: 'b2', billDate: '2026-06-07' })];
  const gws = [gwRow({ billdate: '2026-06-09' }), gwRow({ billdate: '2026-06-09' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, [], { dateToleranceDays: 3 });
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2'], '容差 3 下隔 2 天的 2×2 组进 reviewRows');
});

// ---- ⑥ 网关 + 调拨同行去重 -------------------------------------------

test('网关 + 调拨同一银行行命中 → 去重为一条、note 合并两侧', () => {
  const banks = [bankRow({ rowId: 'b1' }), bankRow({ rowId: 'b2' })];
  const gws = [gwRow(), gwRow()];
  const recons = [reconRow(), reconRow()];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, recons);
  assert.deepEqual(reviewRows.map((r) => r.row._rowId), ['b1', 'b2']);
  // 每条 note 同时含「网关」与「调拨」两侧说明（以 '; ' 合并）
  assert.ok(reviewRows.every((r) => /网关/.test(r.note) && /调拨/.test(r.note)), 'note 应合并网关+调拨两侧');
});

// ---- ⑦ 调拨侧单独命中 ------------------------------------------------

test('调拨 NvM 命中（网关空）', () => {
  const banks = [bankRow({ rowId: 'b1' }), bankRow({ rowId: 'b2' })];
  const recons = [reconRow(), reconRow()];
  const { reviewRows } = detectFundTransferManyToMany(banks, [], recons);
  assert.deepEqual(reviewRows.map((r) => r.row._rowId), ['b1', 'b2']);
  assert.ok(reviewRows.every((r) => /调拨/.test(r.note)));
});

test('调拨 big_account ≠ 银行 MerchantId → 不同组 → 不命中', () => {
  const banks = [bankRow({ merchantId: 'M1' }), bankRow({ merchantId: 'M1' })];
  const recons = [reconRow({ bigAccount: 'OTHER' }), reconRow({ bigAccount: 'OTHER' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, [], recons);
  assert.equal(reviewRows.length, 0);
});

// ---- ⑧ 空入参 no-op --------------------------------------------------

test('空入参 no-op（[] / null / 仅银行行）', () => {
  assert.deepEqual(detectFundTransferManyToMany([], [], []), { reviewRows: [] });
  assert.deepEqual(detectFundTransferManyToMany(null, null, null), { reviewRows: [] });
  assert.deepEqual(detectFundTransferManyToMany([bankRow(), bankRow()], [], []), { reviewRows: [] });
});

// ---- ⑨ 纯只读：检测前后 bankRows 深度不变 ----------------------------

test('🔴 纯只读：检测不改写任何 bankRow 字段（深度快照不变）', () => {
  const banks = [bankRow({ rowId: 'b1' }), bankRow({ rowId: 'b2' })];
  const gws = [gwRow(), gwRow()];
  const recons = [reconRow(), reconRow()];
  const snapshot = JSON.stringify(banks);
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, recons);
  // 命中行返回的是**原对象引用**（非拷贝）
  assert.equal(reviewRows[0].row, banks[0]);
  // 但检测器全程未写任何字段 → 深度快照逐字节不变
  assert.equal(JSON.stringify(banks), snapshot);
});

// ---- 金额精确到分边界 ------------------------------------------------

test('金额相差 1 分（0.01）→ 不同组 → 不命中', () => {
  const banks = [bankRow({ amount: 100 }), bankRow({ amount: 100 })];
  const gws = [gwRow({ amount: 100.01 }), gwRow({ amount: 100.01 })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.equal(reviewRows.length, 0);
});

test('Extra Fee 先加总再按分分组：100.004+0.004 与对手 100.01 同组命中', () => {
  const banks = [
    bankRow({ rowId: 'b1', amount: '100.004', extraFee: '0.004' }),
    bankRow({ rowId: 'b2', amount: '100.004', extraFee: '0.004' })
  ];
  const gws = [gwRow({ amount: '100.01' }), gwRow({ amount: '100.01' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
});

test('signed Extra Fee 在网关与调拨两侧统一参与多对多分组', () => {
  const positiveBanks = [
    bankRow({ rowId: 'bp1', amount: 100, extraFee: 5 }),
    bankRow({ rowId: 'bp2', amount: 100, extraFee: 5 })
  ];
  const negativeBanks = [
    bankRow({ rowId: 'bn1', amount: 100, extraFee: -5 }),
    bankRow({ rowId: 'bn2', amount: 100, extraFee: -5 })
  ];

  const gatewayResult = detectFundTransferManyToMany(
    positiveBanks,
    [gwRow({ amount: 105 }), gwRow({ amount: 105 })],
    []
  );
  assert.deepEqual(hitRowIds(gatewayResult), ['bp1', 'bp2'], '网关侧按 100+5=105 分组');

  const reconResult = detectFundTransferManyToMany(
    negativeBanks,
    [],
    [reconRow({ amount: 95 }), reconRow({ amount: 95 })]
  );
  assert.deepEqual(hitRowIds(reconResult), ['bn1', 'bn2'], '调拨侧按 100-5=95 分组');
});

test('科学计数法与合计为 0 在多对多审计中沿用同一含手续费金额口径', () => {
  const scientificBanks = [
    bankRow({ rowId: 'bs1', amount: 100, extraFee: '5e-1' }),
    bankRow({ rowId: 'bs2', amount: 100, extraFee: '5e-1' })
  ];
  const scientificResult = detectFundTransferManyToMany(
    scientificBanks,
    [gwRow({ amount: 100.5 }), gwRow({ amount: 100.5 })],
    []
  );
  assert.deepEqual(hitRowIds(scientificResult), ['bs1', 'bs2']);

  const zeroBanks = [
    bankRow({ rowId: 'bz1', amount: 100, extraFee: -100 }),
    bankRow({ rowId: 'bz2', amount: 100, extraFee: -100 })
  ];
  const zeroResult = detectFundTransferManyToMany(
    zeroBanks,
    [],
    [reconRow({ amount: 0 }), reconRow({ amount: 0 })]
  );
  assert.deepEqual(hitRowIds(zeroResult), ['bz1', 'bz2']);
});

test('合计后不再 abs：100+(-150)=-50，不得与绝对值为 50 的对手并组', () => {
  const banks = [
    bankRow({ rowId: 'b1', amount: 100, extraFee: -150 }),
    bankRow({ rowId: 'b2', amount: 100, extraFee: -150 })
  ];
  const gws = [gwRow({ amount: 50 }), gwRow({ amount: -50 })];
  const recons = [reconRow({ amount: 50 }), reconRow({ amount: -50 })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, recons);
  assert.equal(reviewRows.length, 0, '银行 -50 键不得被重新 abs 成 50');
});

test('金额取绝对值：银行 Debit 行（负方向）与网关正金额同 |金额| 并组命中', () => {
  // 银行行 Debit=100（Credit=0）→ bankAmountAbs=100；网关 amount=-100 → gwAmountAbs=100 → 同组
  const banks = [
    { MerchantId: 'M1', Currency: 'USD', 'Credit Amount': 0, 'Debit Amount': 100, BillDate: '2026-06-07', FundType: 'X', _rowId: 'b1' },
    { MerchantId: 'M1', Currency: 'USD', 'Credit Amount': 0, 'Debit Amount': 100, BillDate: '2026-06-07', FundType: 'X', _rowId: 'b2' }
  ];
  const gws = [gwRow({ amount: -100 }), gwRow({ amount: -100 })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
});

// ---- ⑩ 性能·门控短路：无 banks≥2 键 → 直接 []，且 cpRows 未被触碰 ----------

test('门控短路：无任何 banks≥2 键 → 直接 []，且 cpRows 完全未被遍历', () => {
  // 两银行行键各异（账号 M1 / M2）→ 任一 group 仅 banks=1 → 无组满足 banks≥2 → 门控短路。
  const banks = [bankRow({ rowId: 'b1', merchantId: 'M1' }), bankRow({ rowId: 'b2', merchantId: 'M2' })];
  // 对手行用「一访问即抛」探针：若门控失效、对手 loop 被执行 → 访问 .merchantid 抛错使测试爆红。
  const tripwire = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`门控短路失效：cpRow 被触碰（访问了属性 ${String(prop)}）`);
      }
    }
  );
  const { reviewRows } = detectFundTransferManyToMany(banks, [tripwire, tripwire], []);
  assert.equal(reviewRows.length, 0, '无 banks≥2 键 → 命中为空');
});

// ---- ⑪ 性能·大组封顶：nb×nc 超阈值 → 整组银行行命中、note 含「规模过大」-----

test('大组封顶：nb×nc 超 MAX_BIPARTITE_EDGES → 不建图、整组银行行全部命中、note 含「规模过大」（用户可见非静默信号）', () => {
  // 448 × 448 = 200704 > 200000(MAX_BIPARTITE_EDGES)；全部默认键（M1/USD/100）落同一组 → 触发封顶。
  const N = 448;
  const banks = [];
  const gws = [];
  for (let i = 0; i < N; i += 1) {
    banks.push(bankRow({ rowId: `bb${i}` }));
    gws.push(gwRow());
  }

  const { reviewRows } = detectFundTransferManyToMany(banks, gws, []);

  // 🔴 封顶不静默不漏报：整组银行行全部命中，且每条 note 含「规模过大」区别于普通命中——该 note 进
  //   「异常-人工判断」sheet 即用户可见的非静默信号（src/main-process 禁 raw 终端告警，故不以终端日志为信号，见 SR-log-1）。
  assert.equal(reviewRows.length, N, '封顶路径：该组所有银行行全部命中（宁可过报，绝不漏报）');
  assert.ok(reviewRows.every((r) => /规模过大/.test(r.note)), 'note 含「规模过大」（区别于普通命中文案）');
  assert.ok(reviewRows.every((r) => /银行 448 × 对手 448/.test(r.note)), 'note 含 银行N×对手M 规模');
});
