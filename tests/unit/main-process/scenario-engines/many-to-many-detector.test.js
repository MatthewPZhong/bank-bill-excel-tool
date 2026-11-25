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

// 银行行（驼峰；金额 = |Credit-Debit| + signed Extra Fee，默认 Credit=amount / Debit=0 / fee 空）。默认带渠道 JPM：
//   R5s2 映射补跑剔除空渠道银行行（映射目标账号上要求同渠道，见 isR5MappedBankRowUnverifiable）；原口径不看渠道。
function bankRow({
  merchantId = 'M1',
  currency = 'USD',
  amount = 100,
  extraFee = '',
  billDate = '2026-06-07',
  fundType = 'FundTransfer-out',
  channel = 'JPM',
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
    Channel: channel,
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

test('dateMatchEnabled=false：完全跳过日期，非法/空/跨年日期的宽方向 2×2 组仍直接命中', () => {
  const banks = [
    bankRow({ rowId: 'b1', billDate: 'not-a-date', fundType: 'Charge' }),
    bankRow({ rowId: 'b2', billDate: '', fundType: '' })
  ];
  const gws = [
    gwRow({ billdate: '2025-01-01', tradeType: 'SomethingElse' }),
    gwRow({ billdate: 'invalid', tradeType: '' })
  ];
  const before = JSON.stringify(banks);
  const result = detectFundTransferManyToMany(banks, gws, [], {
    fundTransferDatePolicy: { enabled: false, toleranceDays: 999 }
  });

  assert.deepEqual(hitRowIds(result), ['b1', 'b2']);
  assert.ok(result.reviewRows.every((item) => /银行 2 行 × 网关 2 行/.test(item.note)));
  assert.equal(JSON.stringify(banks), before, '日期关闭分支仍保持纯只读');
});

test('dateMatchEnabled=true：同一非法日期 2×2 组仍不成边', () => {
  const banks = [
    bankRow({ rowId: 'b1', billDate: 'not-a-date' }),
    bankRow({ rowId: 'b2', billDate: '' })
  ];
  const gws = [gwRow({ billdate: 'invalid' }), gwRow({ billdate: null })];
  const result = detectFundTransferManyToMany(banks, gws, [], {
    fundTransferDatePolicy: { enabled: true, toleranceDays: 999 }
  });
  assert.deepEqual(result.reviewRows, []);
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

  // v3.2.22：账户映射非空时，映射补跑同样先过银行门控，不预先扫描网关池。
  const mapped = detectFundTransferManyToMany(banks, [tripwire, tripwire], [], {
    accountMappingMap: new Map([['ALIAS', 'M1']])
  });
  assert.equal(mapped.reviewRows.length, 0, '映射补跑门控短路 → 命中为空、对手行未被触碰');
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

// ---- v3.2.22：网关侧原账号检测 + R5s2 网关池按映射后账号补跑 -----------------

// R5s2 网关池行（FundTransfer-in/out 且 reconciliationid 非空），映射补跑只看这类行。映射目标账号上的行 R5s2 要求渠道
//   非空且相同，默认带渠道 JPM（空渠道行 R5s2 一定不回填，补跑剔除，见下方专项用例）。
function r5GwRow(overrides = {}) {
  return { ...gwRow(overrides), reconciliationid: overrides.reconciliationid || 'GW-RECON', Channel: overrides.Channel ?? 'JPM' };
}

test('v3.2.22：R5s2 网关池经账户映射后与银行 MerchantId 成组 → NvM 命中（note 标映射后）；不传映射则不成组', () => {
  const banks = [
    bankRow({ rowId: 'b1', merchantId: 'CLR-1' }),
    bankRow({ rowId: 'b2', merchantId: 'CLR-1' })
  ];
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: ' GW-1 ' })];
  const before = structuredClone(banks);

  assert.equal(detectFundTransferManyToMany(banks, gws, []).reviewRows.length, 0, '未映射：账号不同不成组');

  const { reviewRows } = detectFundTransferManyToMany(banks, gws, [], {
    accountMappingMap: new Map([['GW-1', 'CLR-1']])
  });
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
  assert.ok(reviewRows.every((r) => /^银行↔网关（账户映射后）多对多：账号 CLR-1 /.test(r.note)), 'note 标映射后、账号为清结算账号');
  assert.deepEqual(banks, before, '🔴 纯只读：映射只影响分组键，不改银行行');
  assert.equal(gws[0].merchantid, 'GW-1', '网关行不被改写');
});

test('v3.2.22：转义歧义的网关账号（映射后为空）不进映射补跑分组，与 R5 不参与匹配一致', () => {
  const map = new Map([['A_x0000_B', 'CLR-LIT'], ['A\u0000B', 'CLR-NUL']]);
  for (const target of ['CLR-LIT', 'CLR-NUL']) {
    const banks = [bankRow({ rowId: 'b1', merchantId: target }), bankRow({ rowId: 'b2', merchantId: target })];
    const gws = [r5GwRow({ merchantid: 'A_x0000_B' }), r5GwRow({ merchantid: 'A_x0000_B' })];
    assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map }).reviewRows.length, 0, target);
  }
});

test('v3.2.22：需同渠道校验而渠道含转义写法的网关行 R5s2 不参与匹配，映射补跑同口径剔除、不报「自动回填仅取其一」', () => {
  const map = new Map([['GW-1', 'CLR-1']]);
  const banks = [bankRow({ rowId: 'b1', merchantId: 'CLR-1' }), bankRow({ rowId: 'b2', merchantId: 'CLR-1' })];
  const escaped = [
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'BANK_x000D_US' },
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'BANK_x000D_US' }
  ];
  assert.equal(detectFundTransferManyToMany(banks, escaped, [], { accountMappingMap: map }).reviewRows.length, 0,
    '两条都被 R5s2 排除：没有实际可回填的候选');
  // 原账号恰为映射目标、与映射命中行争用同一目标账号的行同样需同渠道校验，渠道含转义写法时同样剔除。
  const contender = [
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'JPM' },
    { ...r5GwRow({ merchantid: 'CLR-1' }), Channel: 'JPM_x0041_' }
  ];
  assert.equal(detectFundTransferManyToMany(banks, contender, [], { accountMappingMap: map }).reviewRows.length, 0,
    '只剩一条可参与的网关行：2×1 不构成多对多');
  // 目标集合按方向收集：争用行在另一方向（该方向没有映射命中行）时不需同渠道校验，渠道含转义写法也照常计入。
  const otherDirection = [
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'JPM' },
    { ...r5GwRow({ merchantid: 'CLR-1', tradeType: 'FundTransfer-in' }), Channel: 'JPM_x0041_' }
  ];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, otherDirection, [], { accountMappingMap: map })), ['b1', 'b2']);
  const plain = [
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'JPM' },
    { ...r5GwRow({ merchantid: 'GW-1' }), Channel: 'JPM' }
  ];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, plain, [], { accountMappingMap: map })), ['b1', 'b2'],
    '渠道不含转义写法时照常报告');
});

test('v3.2.22：需同渠道校验而渠道为空的网关行 R5s2 一定不回填，映射补跑剔除；原账号检测不变', () => {
  const map = new Map([['GW-1', 'CLR-1']]);
  const banks = [bankRow({ rowId: 'b1', merchantId: 'CLR-1' }), bankRow({ rowId: 'b2', merchantId: 'CLR-1' })];
  const blank = [r5GwRow({ merchantid: 'GW-1', Channel: '' }), r5GwRow({ merchantid: 'GW-1', Channel: '  ' })];
  assert.equal(detectFundTransferManyToMany(banks, blank, [], { accountMappingMap: map }).reviewRows.length, 0,
    '两条都缺渠道：R5s2 一条也不回填，不报「自动回填仅取其一」');
  const rawSide = [r5GwRow({ merchantid: 'CLR-1', Channel: '' }), r5GwRow({ merchantid: 'CLR-1', Channel: '' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, rawSide, [])), ['b1', 'b2'], '不传映射：原账号检测照常（不看渠道）');
});

test('v3.2.22：银行 MerchantId 按数值读入、可能已被舍入且按数值与映射目标账号相同 → R5s2 不用于映射回填，补跑剔除', () => {
  // 银行源单元格 <v>9007199254740993</v> 读入为 9007199254740992，字符串与映射目标账号 9007199254740992 相同。
  const map = new Map([['GW-1', '9007199254740992']]);
  const banks = [
    { ...bankRow({ rowId: 'b1' }), MerchantId: 9007199254740993 },
    { ...bankRow({ rowId: 'b2' }), MerchantId: 9007199254740993 }
  ];
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const textBanks = [bankRow({ rowId: 't1', merchantId: '9007199254740992' }), bankRow({ rowId: 't2', merchantId: '9007199254740992' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(textBanks, gws, [], { accountMappingMap: map })), ['t1', 't2'],
    '文本单元格的同形账号照常成组');
});

test('v3.2.22：按原账号匹配的轮次（如 R4 AchReturn）多对多不被映射覆盖', () => {
  const banks = [
    bankRow({ rowId: 'b1', merchantId: 'ALIAS', fundType: 'AchReturn' }),
    bankRow({ rowId: 'b2', merchantId: 'ALIAS', fundType: 'AchReturn' })
  ];
  const gws = [gwRow({ merchantid: 'ALIAS', tradeType: 'AchReturn' }), gwRow({ merchantid: 'ALIAS', tradeType: 'AchReturn' })];
  const map = new Map([['ALIAS', 'CLR']]);
  const baseline = detectFundTransferManyToMany(banks, gws, []);
  const withMap = detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map });
  assert.deepEqual(hitRowIds(withMap), ['b1', 'b2']);
  assert.deepEqual(withMap, baseline, '原账号检测结果与不传映射逐项一致');

  // 非 R5s2 网关池行即使映射后能与银行成组，也不补跑（R4 等不按映射匹配）
  const clrBanks = [
    bankRow({ rowId: 'c1', merchantId: 'CLR', fundType: 'AchReturn' }),
    bankRow({ rowId: 'c2', merchantId: 'CLR', fundType: 'AchReturn' })
  ];
  assert.equal(detectFundTransferManyToMany(clrBanks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
});

test('v3.2.22：映射补跑只报告含映射命中行的分量，未受映射影响的组不重复出说明', () => {
  const banks = [
    bankRow({ rowId: 'b1', merchantId: 'CLR' }),
    bankRow({ rowId: 'b2', merchantId: 'CLR' })
  ];
  const map = new Map([['ALIAS', 'CLR']]);

  // 两条原账号即 CLR 的网关行：原口径命中一次，补跑不重复
  const rawOnly = detectFundTransferManyToMany(banks, [r5GwRow({ merchantid: 'CLR' }), r5GwRow({ merchantid: 'CLR' })], [], {
    accountMappingMap: map
  });
  assert.deepEqual(hitRowIds(rawOnly), ['b1', 'b2']);
  assert.ok(rawOnly.reviewRows.every((r) => /^银行↔网关多对多/.test(r.note) && !/账户映射后/.test(r.note)));

  // 一条映射命中 + 一条原账号：原口径 Nv1 不报，补跑成 2×2 报出
  const mixed = detectFundTransferManyToMany(banks, [r5GwRow({ merchantid: 'ALIAS' }), r5GwRow({ merchantid: 'CLR' })], [], {
    accountMappingMap: map
  });
  assert.deepEqual(hitRowIds(mixed), ['b1', 'b2']);
  assert.ok(mixed.reviewRows.every((r) => /^银行↔网关（账户映射后）多对多/.test(r.note) && /银行 2 行 × 网关（账户映射后） 2 行/.test(r.note)));

  // 空 reconciliationid 的网关行不进 R5s2 网关池，补跑不计入
  const blankRecon = detectFundTransferManyToMany(banks, [{ ...gwRow({ merchantid: 'ALIAS' }), reconciliationid: '' }, r5GwRow({ merchantid: 'CLR' })], [], {
    accountMappingMap: map
  });
  assert.equal(blankRecon.reviewRows.length, 0);
});

test('v3.2.22：映射命中判据与 R5s2 一致——同值映射 `C → C` 也算命中、转义写法账号不算，补跑的 R5s2 网关池结论与原口径并列报告', () => {
  const banks = [bankRow({ rowId: 'b1', merchantId: 'C' }), bankRow({ rowId: 'b2', merchantId: 'C' })];
  const gws = [r5GwRow({ merchantid: 'C' }), r5GwRow({ merchantid: 'C' }), { ...gwRow({ merchantid: 'C', tradeType: 'Other' }), reconciliationid: 'G3' }];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: new Map([['C', 'C']]) });
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
  for (const row of reviewRows) {
    assert.match(row.note, /银行↔网关多对多：账号 C .*银行 2 行 × 网关 3 行/, '原口径含非调拨交易类型的网关行');
    assert.match(row.note, /银行↔网关（账户映射后）多对多：账号 C .*银行 2 行 × 网关（账户映射后） 2 行/, '补跑只看 R5s2 网关池');
  }
  // 映射非空时含 `_xHHHH_` 写法的账号不算命中映射（R5s2 不参与匹配），只按原口径报告，不补跑。
  const decoded = detectFundTransferManyToMany(
    [bankRow({ rowId: 'd1', merchantId: 'A_x0000_B' }), bankRow({ rowId: 'd2', merchantId: 'A_x0000_B' })],
    [r5GwRow({ merchantid: 'A_x0000_B' }), r5GwRow({ merchantid: 'A_x0000_B' }),
      { ...gwRow({ merchantid: 'A_x0000_B', tradeType: 'Other' }), reconciliationid: 'G9' }],
    [],
    { accountMappingMap: new Map([['A\u0000B', 'A_x0000_B']]) }
  );
  assert.deepEqual(hitRowIds(decoded), ['d1', 'd2']);
  assert.ok(decoded.reviewRows.every((r) => /银行 2 行 × 网关 3 行/.test(r.note) && !/账户映射后/.test(r.note)),
    '转义写法的账号不按映射补跑');
});

test('v3.2.22：调拨侧不受网关映射影响（big_account 已在派生时映射）', () => {
  const banks = [
    bankRow({ rowId: 'b1', merchantId: 'GW-1' }),
    bankRow({ rowId: 'b2', merchantId: 'GW-1' })
  ];
  const recons = [reconRow({ bigAccount: 'GW-1' }), reconRow({ bigAccount: 'GW-1' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, [], recons, {
    accountMappingMap: new Map([['GW-1', 'CLR-1']])
  });
  assert.deepEqual(hitRowIds({ reviewRows }), ['b1', 'b2']);
  assert.ok(reviewRows.every((r) => /调拨/.test(r.note)));
});

test('v3.2.22：分组键区分账号与币种边界，映射后 (A B, USD) 与 (A, B USD) 不并成一组', () => {
  const banks = [
    bankRow({ rowId: 'b1', merchantId: 'A B', currency: 'USD' }),
    bankRow({ rowId: 'b2', merchantId: 'A', currency: 'B USD' })
  ];
  const gws = [
    r5GwRow({ merchantid: 'X1', currency: 'USD', reconciliationid: 'R1' }),
    r5GwRow({ merchantid: 'X2', currency: 'B USD', reconciliationid: 'R2' })
  ];
  const result = detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: new Map([['X1', 'A B'], ['X2', 'A']]) });
  assert.deepEqual(result.reviewRows, []);
});

test('v3.2.22：金额乘 100 后溢出的行不形成金额分组', () => {
  const banks = [
    bankRow({ rowId: 'b1', amount: 1, extraFee: -1e307 }),
    bankRow({ rowId: 'b2', amount: 1, extraFee: -1e307 })
  ];
  const gws = [gwRow({ amount: 1e307 }), gwRow({ amount: 1e307 })];
  assert.deepEqual(detectFundTransferManyToMany(banks, gws, []).reviewRows, []);
});

test('v3.2.22：正向溢出 2×2 时 R5 两条写入路径与审计一致：都不回填、不出说明', () => {
  const { runRound5FundTransferBackfill } = require('../../../../src/main-process/scenario-engines/r5-fund-transfer-backfill');
  const { runRound5FundTransferReconBackfill } = require('../../../../src/main-process/scenario-engines/r5-fund-transfer-recon-backfill');
  const banks = () => [
    { ...bankRow({ rowId: 'b1', amount: 0 }), 'Debit Amount': 1e307 },
    { ...bankRow({ rowId: 'b2', amount: 0 }), 'Debit Amount': 1e307 }
  ];
  const gws = [
    { ...gwRow({ amount: 2e307 }), reconciliationid: 'G1' },
    { ...gwRow({ amount: 2e307 }), reconciliationid: 'G2' }
  ];
  const gatewayBanks = banks();
  const gateway = runRound5FundTransferBackfill(gws, gatewayBanks);
  assert.deepEqual(gateway.modifications, [], '网关来源不回填');
  const recons = [
    { ...reconRow({ amount: 2e307 }), [RECON.reconId]: 'R1' },
    { ...reconRow({ amount: 2e307 }), [RECON.reconId]: 'R2' }
  ];
  const recon = runRound5FundTransferReconBackfill(recons, banks());
  assert.deepEqual(recon.modifications, [], '调拨来源不回填');
  assert.deepEqual(detectFundTransferManyToMany(banks(), gws, recons).reviewRows, [], '审计不出说明');
});

test('v3.2.22：映射补跑剔除空渠道银行行（映射目标账号上 R5s2 要求同渠道，空渠道银行行一定不回填）；原口径不看渠道', () => {
  const map = new Map([['GW-1', 'CLR-1']]);
  const banks = [bankRow({ rowId: 'b1', merchantId: 'CLR-1', channel: '' }), bankRow({ rowId: 'b2', merchantId: 'CLR-1', channel: ' ' })];
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const plainGws = [r5GwRow({ merchantid: 'CLR-1' }), r5GwRow({ merchantid: 'CLR-1' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, plainGws, [])), ['b1', 'b2'], '原账号检测照常');
});

test('v3.2.22：Excel 15 位截断的数值银行账号（第 16 位起为 0）补跑剔除；文本单元格同形账号照常成组', () => {
  const map = new Map([['GW-1', '1234567890123450']]);
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  const numericBanks = [{ ...bankRow({ rowId: 'b1' }), MerchantId: 1234567890123450 }, { ...bankRow({ rowId: 'b2' }), MerchantId: 1234567890123450 }];
  assert.equal(detectFundTransferManyToMany(numericBanks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const textBanks = [bankRow({ rowId: 't1', merchantId: '1234567890123450' }), bankRow({ rowId: 't2', merchantId: '1234567890123450' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(textBanks, gws, [], { accountMappingMap: map })), ['t1', 't2']);
});

test('v3.2.22：被前序场景按链接表原文改写、含转义写法的银行账号补跑剔除（与 R5s2 同一判据）', () => {
  const map = new Map([['GW-1', 'A_x0041_B']]);
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  const banks = [bankRow({ rowId: 'b1', merchantId: 'A_x0041_B' }), bankRow({ rowId: 'b2', merchantId: 'A_x0041_B' })];
  const rawRewritten = (row, column) => column === 'MerchantId';
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map, isRawRewrittenBankValue: rawRewritten }).reviewRows.length, 0);
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map })), ['b1', 'b2'], '银行原值照常');
});

test('v3.2.22：前导 0——数值银行账号与带前导 0 的映射值同值时补跑剔除（与 R5s2 同一判据）；文本照常', () => {
  const map = new Map([['GW-A', '00123'], ['GW-B', '123']]);
  const gws = [r5GwRow({ merchantid: 'GW-B' }), r5GwRow({ merchantid: 'GW-B' })];
  const numericBanks = [{ ...bankRow({ rowId: 'b1' }), MerchantId: 123 }, { ...bankRow({ rowId: 'b2' }), MerchantId: 123 }];
  assert.equal(detectFundTransferManyToMany(numericBanks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const textBanks = [bankRow({ rowId: 't1', merchantId: '123' }), bankRow({ rowId: 't2', merchantId: '123' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(textBanks, gws, [], { accountMappingMap: map })), ['t1', 't2']);
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(numericBanks, gws, [], { accountMappingMap: new Map([['GW-B', '123']]) })),
    ['b1', 'b2'], '没有带前导 0 的映射值：数值 123 没有歧义');
});

test('v3.2.22：未命中映射、原值按数值读入且与映射目标对得上的网关行，R5s2 不参与匹配，补跑同口径剔除', () => {
  const map = new Map([['G', '9007199254740992']]);
  const banks = [bankRow({ rowId: 'b1', merchantId: '9007199254740992' }), bankRow({ rowId: 'b2', merchantId: '9007199254740992' })];
  const gws = [r5GwRow({ merchantid: 'G' }), r5GwRow({ merchantid: '9007199254740992' })];
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const textGws = [r5GwRow({ merchantid: 'G' }), r5GwRow({ merchantid: '9007199254740992' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, textGws, [], { accountMappingMap: new Map([['G', '9007199254740992X']]) })),
    [], '目标不同：不成组');
  const plain = [r5GwRow({ merchantid: 'G' }), r5GwRow({ merchantid: 'CLR' })];
  const clrBanks = [bankRow({ rowId: 'c1', merchantId: 'CLR' }), bankRow({ rowId: 'c2', merchantId: 'CLR' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(clrBanks, plain, [], { accountMappingMap: new Map([['G', 'CLR']]) })),
    ['c1', 'c2'], '原账号文本即目标：照常计入');
});

test('v3.2.22：命中映射键、原值按数值读入且与本方向另一映射目标对得上的网关行，R5s2 不按映射回填，补跑同口径剔除', () => {
  const map = new Map([['123', 'CLR-A'], ['G', '00123']]);
  const banks = [bankRow({ rowId: 'b1', merchantId: 'CLR-A' }), bankRow({ rowId: 'b2', merchantId: 'CLR-A' })];
  const gws = [r5GwRow({ merchantid: '123' }), r5GwRow({ merchantid: '123' }), r5GwRow({ merchantid: 'G' })];
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map }).reviewRows.length, 0);
  const noTarget = [r5GwRow({ merchantid: '123' }), r5GwRow({ merchantid: '123' })];
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, noTarget, [], { accountMappingMap: map })), ['b1', 'b2'],
    '本批没有 G 行：`00123` 不是映射目标，照常计入');
});

test('v3.2.22：被前序场景按链接表原文改写成数值写法、与映射值对得上的银行账号补跑剔除', () => {
  const map = new Map([['GW-1', '9007199254740992']]);
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  const banks = [bankRow({ rowId: 'b1', merchantId: '9007199254740992' }), bankRow({ rowId: 'b2', merchantId: '9007199254740992' })];
  const rawRewritten = (row, column) => column === 'MerchantId';
  assert.equal(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map, isRawRewrittenBankValue: rawRewritten }).reviewRows.length, 0);
  assert.deepEqual(hitRowIds(detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: map })), ['b1', 'b2'], '银行原值照常');
});

test('v3.2.22：映射补跑剔除银行行按行判断，不为此遍历网关池（银行门控短路时对手行不被触碰）', () => {
  const tripwire = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`门控短路失效：cpRow 被触碰（访问了属性 ${String(prop)}）`);
    }
  });
  const banks = [
    { ...bankRow({ rowId: 'b1' }), MerchantId: 9007199254740993 },
    { ...bankRow({ rowId: 'b2', merchantId: 'M2' }), Channel: '' }
  ];
  const { reviewRows } = detectFundTransferManyToMany(banks, [tripwire, tripwire], [], { accountMappingMap: new Map([['ALIAS', 'M2']]) });
  assert.equal(reviewRows.length, 0);
});

test('v3.2.22：说明分段 noteParts 与 note 逐字一致，账号、币种段标明取自哪一列', () => {
  const banks = [bankRow({ rowId: 'b1', merchantId: 'CLR-1' }), bankRow({ rowId: 'b2', merchantId: 'CLR-1' })];
  const gws = [r5GwRow({ merchantid: 'GW-1' }), r5GwRow({ merchantid: 'GW-1' })];
  const { reviewRows } = detectFundTransferManyToMany(banks, gws, [], { accountMappingMap: new Map([['GW-1', 'CLR-1']]) });
  assert.equal(reviewRows.length, 2);
  assert.equal(reviewRows[0].noteParts, reviewRows[1].noteParts, '同组各行共用同一分段，不按行复制');
  assert.equal(reviewRows[0].note, reviewRows[1].note);
  for (const r of reviewRows) {
    assert.equal(r.noteParts.map((part) => (typeof part === 'string' ? part : part.value)).join(''), r.note);
    assert.deepEqual(r.noteParts.filter((part) => typeof part !== 'string'),
      [{ column: 'MerchantId', value: 'CLR-1' }, { column: 'Currency', value: 'USD' }]);
  }
});
