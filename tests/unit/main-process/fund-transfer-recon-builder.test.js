// v3.0.6 需求1：调拨对账单派生纯函数单测（🔴 资金红线）
//
// 覆盖 buildFundTransferReconRows（一行中台调拨订单 → FundTransfer-in + FundTransfer-out 两行）：
//   ① 一行 → 恰好 2 行（total=2）。
//   ② in 行 fund_type='FundTransfer-in'，5 项方向映射全对（渠道=收款渠道 / 金额=收款金额 /
//      币种=收款币种 / big_account=收款账户（卡号）= D1）+ 公共字段（BillDate←交易时间、ReconID←渠道流水号、
//      付款账号←付款卡号、收款账号←收款卡号）。
//   ③ out 行 fund_type='FundTransfer-out'（币种=付款币种【纠原文笔误】、big_account=付款账户（卡号）= D1）。
//   ④ 全角括号「收款账户（卡号）」「付款账户（卡号）」正确读取（半角化即取空 → 大账号全空 → 下游全不命中，资金红线）。
//   ⑤ 空 / 非对象行跳过不崩。
//   ⑥ 多行输入 total = 行数 × 2。
//
// 🔴 不变量（绝不能回退）：
//   · 大账号方向取卡号（D1）：in=收款卡号、out=付款卡号；取反不命中（双向各断言一行）。
//   · out 行币种取「付款币种」（纠原文笔误，原文误写 in 行币种）。
//   · 全角括号字段名逐字（常量 FT_RECON_FIELD_MAP.mid，收口自 ZHONGTAI_DISPATCH_ORDER_SIGNATURE）。
//
// 字段名一律经 FT_RECON_FIELD_MAP 常量取，绝不手敲（与源文件同一真相，防全角括号/列名漂移）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFundTransferReconRows } = require('../../../src/main-process/fund-transfer-recon-builder');
const {
  FT_RECON_FIELD_MAP,
  MID_ALLOCATION_SUCCESS_STATUS
} = require('../../../src/constants/fund-transfer-recon-fields');

const M = FT_RECON_FIELD_MAP.mid; // 中台源列名（含全角括号）
const R = FT_RECON_FIELD_MAP.recon; // 调拨对账单派生列名

// 造一行中台调拨订单（中文真实表头，字段名一律经常量取）。
// 默认收 / 付各字段值刻意区分，便于断言「方向取对了哪一侧」。
function midRow(overrides = {}) {
  return Object.assign({
    [M.allocationNo]: 'AL1', // 调拨单号
    [M.status]: MID_ALLOCATION_SUCCESS_STATUS, // 调拨状态：仅付款成功派生
    [M.txTime]: '2026-05-04', // 交易时间 → BillDate
    [M.channelSerial]: 'SER1', // 渠道流水号 → ReconID
    [M.payCard]: 'PAY-CARD-1', // 付款账户（卡号）
    [M.payeeCard]: 'RECV-CARD-1', // 收款账户（卡号）
    [M.receiveChannel]: 'DBS', // 收款渠道
    [M.receiveAmount]: '100.00', // 收款金额
    [M.receiveCurrency]: 'USD', // 收款币种
    [M.payChannel]: 'BANK', // 付款渠道
    [M.payAmount]: '90.00', // 付款金额
    [M.payCurrency]: 'CNY' // 付款币种
  }, overrides);
}

function inRowOf(out) {
  return out.rows.find((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_IN);
}
function outRowOf(out) {
  return out.rows.find((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
}

test.describe('buildFundTransferReconRows - 一行拆 in+out 两行（行数守恒）', () => {
  test('① 一行 → 恰好 2 行，total=2', () => {
    const out = buildFundTransferReconRows([midRow()]);
    assert.equal(out.rows.length, 2);
    assert.equal(out.total, 2);
  });

  test('顺序为「先 in 行后 out 行」', () => {
    const out = buildFundTransferReconRows([midRow()]);
    assert.equal(out.rows[0][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_IN);
    assert.equal(out.rows[1][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
  });

  test('两行共用公共字段（BillDate←交易时间、ReconID←渠道流水号、付款账号、收款账号）', () => {
    const out = buildFundTransferReconRows([midRow()]);
    for (const r of out.rows) {
      assert.equal(r[R.allocationNo], 'AL1');
      assert.equal(r[R.billDate], '2026-05-04'); // 交易时间 → BillDate
      assert.equal(r[R.reconId], 'SER1'); // 渠道流水号 → ReconID
      assert.equal(r[R.payAccount], 'PAY-CARD-1'); // 付款账号 ← 付款卡号
      assert.equal(r[R.payeeAccount], 'RECV-CARD-1'); // 收款账号 ← 收款卡号
    }
  });
});

test.describe('buildFundTransferReconRows - in 行映射（收款侧 + D1 big_account=收款卡号）', () => {
  test('② in 行 fund_type=FundTransfer-in，且 5 项映射全对（渠道/金额/币种/big_account + 标记）', () => {
    const inRow = inRowOf(buildFundTransferReconRows([midRow()]));
    assert.ok(inRow, '应存在 in 行');
    // 标记
    assert.equal(inRow[R.fundType], 'FundTransfer-in');
    assert.equal(inRow[R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_IN);
    // 方向 4 项：渠道=收款渠道、金额=收款金额、币种=收款币种、big_account=收款账户（卡号）
    assert.equal(inRow[R.receiveChannel], 'DBS'); // 渠道 ← 收款渠道
    assert.equal(inRow[R.amount], '100.00'); // 金额 ← 收款金额
    assert.equal(inRow[R.currency], 'USD'); // 币种 ← 收款币种
    assert.equal(inRow[R.bigAccount], 'RECV-CARD-1'); // 🔴 D1：big_account = 收款账户（卡号）
  });

  test('in 行 big_account 取的是收款卡号（不是付款卡号）—— 取反不命中', () => {
    const inRow = inRowOf(buildFundTransferReconRows([midRow({ [M.payCard]: 'PAY-X', [M.payeeCard]: 'RECV-Y' })]));
    assert.equal(inRow[R.bigAccount], 'RECV-Y');
    assert.notEqual(inRow[R.bigAccount], 'PAY-X');
  });

  test('in 行付款渠道留空（需求3 步骤1 仅按收款渠道判 DBS）', () => {
    const inRow = inRowOf(buildFundTransferReconRows([midRow()]));
    assert.equal(inRow[R.payChannel], '');
  });
});

test.describe('buildFundTransferReconRows - out 行映射（付款侧 + 币种纠笔误 + D1 big_account=付款卡号）', () => {
  test('③ out 行 fund_type=FundTransfer-out，且币种=付款币种、big_account=付款账户（卡号）', () => {
    const outRow = outRowOf(buildFundTransferReconRows([midRow()]));
    assert.ok(outRow, '应存在 out 行');
    // 标记
    assert.equal(outRow[R.fundType], 'FundTransfer-out');
    assert.equal(outRow[R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
    // 方向 4 项：渠道=付款渠道、金额=付款金额、币种=付款币种（🔴 纠原文笔误）、big_account=付款账户（卡号）
    assert.equal(outRow[R.payChannel], 'BANK'); // 渠道 ← 付款渠道
    assert.equal(outRow[R.amount], '90.00'); // 金额 ← 付款金额
    assert.equal(outRow[R.currency], 'CNY'); // 🔴 币种 ← 付款币种（非收款币种 USD）
    assert.equal(outRow[R.bigAccount], 'PAY-CARD-1'); // 🔴 D1：big_account = 付款账户（卡号）
  });

  test('out 行币种取付款币种（不是收款币种）—— 纠原文笔误，取反不命中', () => {
    const outRow = outRowOf(buildFundTransferReconRows([midRow({ [M.receiveCurrency]: 'USD', [M.payCurrency]: 'JPY' })]));
    assert.equal(outRow[R.currency], 'JPY'); // 付款币种
    assert.notEqual(outRow[R.currency], 'USD'); // 收款币种不能串到 out 行
  });

  test('out 行 big_account 取的是付款卡号（不是收款卡号）—— 取反不命中', () => {
    const outRow = outRowOf(buildFundTransferReconRows([midRow({ [M.payCard]: 'PAY-X', [M.payeeCard]: 'RECV-Y' })]));
    assert.equal(outRow[R.bigAccount], 'PAY-X');
    assert.notEqual(outRow[R.bigAccount], 'RECV-Y');
  });

  test('out 行收款渠道留空', () => {
    const outRow = outRowOf(buildFundTransferReconRows([midRow()]));
    assert.equal(outRow[R.receiveChannel], '');
  });
});

test.describe('buildFundTransferReconRows - 全角括号字段名读取（资金红线）', () => {
  test('④ 含全角括号 key「收款账户（卡号）」「付款账户（卡号）」的输入对象正确读取', () => {
    // 显式用全角括号字面量构造 key（不经常量），验证常量取的就是全角括号那一列。
    // 全角括号「（）」(U+FF08/U+FF09)，半角括号「()」(U+0028/U+0029) —— 若 builder 误用半角则取空。
    const fullWidthKeyRow = {
      调拨单号: 'AL-FW',
      调拨状态: MID_ALLOCATION_SUCCESS_STATUS,
      交易时间: '2026-06-01',
      渠道流水号: 'SER-FW',
      '付款账户（卡号）': 'PAY-FULLWIDTH', // 全角括号
      '收款账户（卡号）': 'RECV-FULLWIDTH', // 全角括号
      收款渠道: 'DBS',
      收款金额: '8.00',
      收款币种: 'EUR',
      付款渠道: 'WIRE',
      付款金额: '7.00',
      付款币种: 'GBP'
    };
    const out = buildFundTransferReconRows([fullWidthKeyRow]);
    const inRow = inRowOf(out);
    const outRow = outRowOf(out);
    // 公共：付款账号 / 收款账号 读到全角括号列的值（非空 = 读对了）
    assert.equal(inRow[R.payAccount], 'PAY-FULLWIDTH');
    assert.equal(inRow[R.payeeAccount], 'RECV-FULLWIDTH');
    // D1 big_account 来源于全角括号卡号列
    assert.equal(inRow[R.bigAccount], 'RECV-FULLWIDTH'); // in = 收款账户（卡号）
    assert.equal(outRow[R.bigAccount], 'PAY-FULLWIDTH'); // out = 付款账户（卡号）
  });

  test('常量 mid.payeeCard / mid.payCard 用的就是全角括号（U+FF08/U+FF09）', () => {
    // 防回归：若有人把常量改成半角括号，这两条断言会失败。
    assert.equal(M.payeeCard, '收款账户（卡号）');
    assert.equal(M.payCard, '付款账户（卡号）');
    assert.ok(M.payeeCard.includes('（') && M.payeeCard.includes('）'), '收款卡号应含全角括号');
    assert.ok(M.payCard.includes('（') && M.payCard.includes('）'), '付款卡号应含全角括号');
  });

  test('半角括号 key 不命中（取空）—— 反证 builder 读的是全角列', () => {
    const halfWidthKeyRow = {
      调拨单号: 'AL-HW',
      调拨状态: MID_ALLOCATION_SUCCESS_STATUS,
      交易时间: '2026-06-02',
      渠道流水号: 'SER-HW',
      '付款账户(卡号)': 'PAY-HALFWIDTH', // 半角括号 ()
      '收款账户(卡号)': 'RECV-HALFWIDTH', // 半角括号 ()
      收款渠道: 'DBS',
      收款金额: '1',
      收款币种: 'USD',
      付款渠道: 'BANK',
      付款金额: '1',
      付款币种: 'USD'
    };
    const out = buildFundTransferReconRows([halfWidthKeyRow]);
    const inRow = inRowOf(out);
    const outRow = outRowOf(out);
    // 半角括号列读不到 → 卡号 / big_account 全空（证明 builder 取的是全角列）
    assert.equal(inRow[R.payAccount], '');
    assert.equal(inRow[R.payeeAccount], '');
    assert.equal(inRow[R.bigAccount], '');
    assert.equal(outRow[R.bigAccount], '');
  });
});

test.describe('buildFundTransferReconRows - 空 / 非对象行跳过 + 多行守恒', () => {
  test('⑤ 空 / 非对象行（null / 字符串 / 数字 / undefined）跳过不崩', () => {
    const out = buildFundTransferReconRows([null, 'x', 123, undefined, midRow()]);
    // 仅 1 个合法对象 → 2 行
    assert.equal(out.rows.length, 2);
    assert.equal(out.total, 2);
  });

  test('入参非数组（null / undefined / 对象）→ 防御为空，不崩', () => {
    const empty = { rows: [], total: 0, sourceTotal: 0, skippedStatusCount: 0 };
    assert.deepEqual(buildFundTransferReconRows(null), empty);
    assert.deepEqual(buildFundTransferReconRows(undefined), empty);
    assert.deepEqual(buildFundTransferReconRows({}), empty);
  });

  test('空数组 → 空结果', () => {
    assert.deepEqual(buildFundTransferReconRows([]), { rows: [], total: 0, sourceTotal: 0, skippedStatusCount: 0 });
  });

  test('⑥ 多行输入：total = 行数 × 2', () => {
    const out3 = buildFundTransferReconRows([midRow(), midRow(), midRow()]);
    assert.equal(out3.rows.length, 6);
    assert.equal(out3.total, 6);
    // in / out 各 3 行
    assert.equal(out3.rows.filter((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_IN).length, 3);
    assert.equal(out3.rows.filter((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_OUT).length, 3);
  });

  test('多行 + 混入非法行：total = 合法行数 × 2', () => {
    const out = buildFundTransferReconRows([midRow(), null, midRow(), 'bad', midRow()]);
    // 3 个合法行 → 6 行
    assert.equal(out.total, 6);
    assert.equal(out.rows.length, 6);
  });

  test('数值入参经 normalizeCellValue String 化（金额 number → 字符串）', () => {
    const out = buildFundTransferReconRows([midRow({ [M.receiveAmount]: 100, [M.payAmount]: 90 })]);
    const inRow = inRowOf(out);
    const outRow = outRowOf(out);
    assert.equal(inRow[R.amount], '100'); // number 100 → '100'
    assert.equal(outRow[R.amount], '90');
  });
});

test.describe('buildFundTransferReconRows - 调拨状态过滤（v3.0.13）', () => {
  test('调拨状态=付款成功 的一行生成 2 行', () => {
    const out = buildFundTransferReconRows([midRow({ [M.status]: '付款成功' })]);
    assert.equal(out.total, 2);
    assert.equal(out.sourceTotal, 1);
    assert.equal(out.skippedStatusCount, 0);
    assert.equal(out.rows.length, 2);
  });

  test('处理中 / 失败 / 成功 / 空值 不生成', () => {
    const out = buildFundTransferReconRows([
      midRow({ [M.status]: '处理中' }),
      midRow({ [M.status]: '失败' }),
      midRow({ [M.status]: '成功' }),
      midRow({ [M.status]: '' })
    ]);
    assert.equal(out.total, 0);
    assert.equal(out.rows.length, 0);
    assert.equal(out.sourceTotal, 4);
    assert.equal(out.skippedStatusCount, 4);
  });

  test('混合 3 行，其中 2 行付款成功，输出 4 行', () => {
    const out = buildFundTransferReconRows([
      midRow({ [M.allocationNo]: 'AL-OK-1', [M.status]: '付款成功' }),
      midRow({ [M.allocationNo]: 'AL-SKIP', [M.status]: '失败' }),
      midRow({ [M.allocationNo]: 'AL-OK-2', [M.status]: '付款成功' })
    ]);
    assert.equal(out.total, 4);
    assert.equal(out.rows.length, 4);
    assert.equal(out.sourceTotal, 3);
    assert.equal(out.skippedStatusCount, 1);
    assert.deepEqual(out.rows.map((r) => r[R.allocationNo]), ['AL-OK-1', 'AL-OK-1', 'AL-OK-2', 'AL-OK-2']);
  });

  test('状态值前后空格 trim 后识别成功', () => {
    const out = buildFundTransferReconRows([midRow({ [M.status]: '  付款成功  ' })]);
    assert.equal(out.total, 2);
    assert.equal(out.skippedStatusCount, 0);
  });

  test('原字段映射不变：in 行 big_account 来自收款账户，out 行来自付款账户', () => {
    const out = buildFundTransferReconRows([
      midRow({
        [M.status]: '付款成功',
        [M.payCard]: 'PAY-UNCHANGED',
        [M.payeeCard]: 'RECV-UNCHANGED'
      })
    ]);
    assert.equal(inRowOf(out)[R.bigAccount], 'RECV-UNCHANGED');
    assert.equal(outRowOf(out)[R.bigAccount], 'PAY-UNCHANGED');
  });
});

// v3.0.12 功能2（批B，🔴 资金红线）：账户映射应用（big_account 命中替换清结算账号 / 未命中原样保留）。
//   口径：map 键值均经 normalizeCellValue；builder 内 payeeAccount/payAccount 也已 normalizeCellValue → map.get 口径一致。
//   🔴 不变量（绝不能回退）：
//     ① 仅 big_account 被翻译；payAccount/payeeAccount（展示字段）绝不翻译。
//     ② 空 Map / 不传 options → 全 passthrough（映射表为空＝字节级零变化，向后兼容旧签名）。
//     ③ in 用收款卡号查 map、out 用付款卡号查 map，两方向独立（单侧命中不影响另一侧）。
test.describe('buildFundTransferReconRows - 账户映射应用（big_account 映射回流，🔴 资金红线）', () => {
  test('① 命中：in/out big_account 均被替换成清结算账号', () => {
    const map = new Map([
      ['RECV-CARD-1', 'CLR-RECV-999'], // in 侧（收款卡号）→ 清结算账号
      ['PAY-CARD-1', 'CLR-PAY-888'] // out 侧（付款卡号）→ 清结算账号
    ]);
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: map });
    assert.equal(inRowOf(out)[R.bigAccount], 'CLR-RECV-999', '🔴 in big_account 命中替换清结算账号');
    assert.equal(outRowOf(out)[R.bigAccount], 'CLR-PAY-888', '🔴 out big_account 命中替换清结算账号');
  });

  test('② 未命中：big_account 原样保留（map 无该键）—— in/out 两方向', () => {
    const map = new Map([['SOME-OTHER-ACCT', 'CLR-X']]);
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: map });
    assert.equal(inRowOf(out)[R.bigAccount], 'RECV-CARD-1', 'in 未命中 → 原样保留收款卡号');
    assert.equal(outRowOf(out)[R.bigAccount], 'PAY-CARD-1', 'out 未命中 → 原样保留付款卡号');
  });

  test('②b 单侧命中：in 命中替换、out 未命中原样（同一行两方向独立查 map）', () => {
    const map = new Map([['RECV-CARD-1', 'CLR-RECV-ONLY']]); // 只配收款侧
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: map });
    assert.equal(inRowOf(out)[R.bigAccount], 'CLR-RECV-ONLY', 'in 命中 → 替换');
    assert.equal(outRowOf(out)[R.bigAccount], 'PAY-CARD-1', 'out 未命中 → 原样保留');
  });

  test('③ 空 Map → 全 passthrough（in/out big_account 原样）', () => {
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: new Map() });
    assert.equal(inRowOf(out)[R.bigAccount], 'RECV-CARD-1');
    assert.equal(outRowOf(out)[R.bigAccount], 'PAY-CARD-1');
  });

  test('③b 不传 options（向后兼容）→ 与「传空 Map」字节一致（映射表空＝零变化）', () => {
    const withoutOpts = buildFundTransferReconRows([midRow()]);
    const withEmptyMap = buildFundTransferReconRows([midRow()], { accountMappingMap: new Map() });
    assert.deepEqual(withoutOpts, withEmptyMap, '🔴 不传 options ≡ 空 Map');
    assert.equal(inRowOf(withoutOpts)[R.bigAccount], 'RECV-CARD-1');
    assert.equal(outRowOf(withoutOpts)[R.bigAccount], 'PAY-CARD-1');
  });

  test('③c options.accountMappingMap 非 Map（误传普通对象 / undefined）→ 退空 Map passthrough，不崩', () => {
    const asObj = buildFundTransferReconRows([midRow()], { accountMappingMap: { 'RECV-CARD-1': 'X' } });
    assert.equal(inRowOf(asObj)[R.bigAccount], 'RECV-CARD-1', '普通对象非 Map → 不当映射用，passthrough');
    const asUndef = buildFundTransferReconRows([midRow()], { accountMappingMap: undefined });
    assert.equal(inRowOf(asUndef)[R.bigAccount], 'RECV-CARD-1');
  });

  test('④ 🔴 只翻译 big_account：payAccount/payeeAccount（展示字段）即使在 map 中也不翻译', () => {
    const map = new Map([
      ['RECV-CARD-1', 'CLR-RECV-999'],
      ['PAY-CARD-1', 'CLR-PAY-888']
    ]);
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: map });
    for (const r of out.rows) {
      assert.equal(r[R.payAccount], 'PAY-CARD-1', '🔴 付款账号（展示字段）保持原值，不被映射翻译');
      assert.equal(r[R.payeeAccount], 'RECV-CARD-1', '🔴 收款账号（展示字段）保持原值，不被映射翻译');
    }
    // 对照：big_account 确已翻译（排除「map 根本没生效」的假阴性）。
    assert.equal(inRowOf(out)[R.bigAccount], 'CLR-RECV-999');
    assert.equal(outRowOf(out)[R.bigAccount], 'CLR-PAY-888');
  });

  test('⑤ 映射值为「假值但非空」（如 "0"）也按命中替换（用 ?? 而非 ||，只在键缺失时回退）', () => {
    // map 命中但值为 '0'：?? 仅在 undefined 时回退 → '0' 应被采纳（不回退成原账号）。
    const map = new Map([['RECV-CARD-1', '0']]);
    const out = buildFundTransferReconRows([midRow()], { accountMappingMap: map });
    assert.equal(inRowOf(out)[R.bigAccount], '0', '🔴 命中即替换（?? 不因假值回退；与 getMappingMap 非空值保证一致）');
  });

  test('⑥ 多行：每行 in/out 各自按 big_account 命中映射（行间不串）', () => {
    const map = new Map([['RECV-CARD-1', 'CLR-RECV-999'], ['PAY-CARD-1', 'CLR-PAY-888']]);
    const out = buildFundTransferReconRows([midRow(), midRow()], { accountMappingMap: map });
    const ins = out.rows.filter((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_IN);
    const outs = out.rows.filter((r) => r[R.fundType] === FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
    assert.equal(ins.length, 2);
    assert.equal(outs.length, 2);
    for (const r of ins) assert.equal(r[R.bigAccount], 'CLR-RECV-999');
    for (const r of outs) assert.equal(r[R.bigAccount], 'CLR-PAY-888');
  });
});
