// v3.0.5 中台退款订单回填 codex 资金红线对抗审查复审修复单测（Fix#1~#6）
// 来源：codex exec 对抗审查（2026-06-15）发现 1 Critical + 4 Important + 1 Minor，team-lead 逐条核验属实后修复。
// 性质：🔴 资金红线（退款回填误配比漏配危险），本文件覆盖「修复前会误配/误报、修复后不再」的复现场景。
// 用导出的内部子函数精确覆盖（与 r5-refund-order-backfill.test.js 同风格）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupDepositByKeys,
  buildDepIndex,
  matchMemoContainsDepositRef,
  matchMemoDateAmount,
  parseDtdDateToken,
  classifyS4Window,
  runRound5RefundOrderBackfill,
  RESULT_ERROR,
  RESULT_NOTICE
} = require('../../../../src/main-process/scenario-engines/r5-refund-order-backfill');

// ── 简化夹具（JPM 二跳路径专用）──
const jpmBank = (memo, extra = {}) => ({ Channel: 'JPM', 'Payment Detail': memo, 'Extra Information': '', ...extra });
const ro = (payNo) => ({ '银行打款流水号': payNo }); // usRoKey = 银行打款流水号
// 入金行：二跳键（ReconciliationId/ChannelOrderNo）== payNo，depositTake = CustomerRef
const depRef = (payNo, ref) => ({ ReconciliationId: payNo, ChannelOrderNo: '', CustomerRef: ref, BizId: 'bz1' });
const depR6 = (payNo, valueDate, credit, cur = 'USD') => ({
  ReconciliationId: payNo, ChannelOrderNo: '', CustomerRef: 'x',
  ValueDate: valueDate, 'Credit Amount': credit, Currency: cur, BizId: 'bz1'
});

// ============================================================================
// Fix#1 🔴Critical：depIndex 索引版与线性版「按入金行顺序首条命中」严格一致（交叉键冲突）
// ============================================================================
test.describe('Fix#1 depIndex 交叉键行序一致', () => {
  test('交叉键冲突：索引版与线性版都取行序首条 deps[0]（修复前键优先误取 deps[1]）', () => {
    const deps = [
      { ChannelOrderNo: 'PAYNO', ReconciliationId: 'X0', CustomerRef: 'NO_MATCH', BizId: 'b0' },
      { ReconciliationId: 'PAYNO', ChannelOrderNo: 'X1', CustomerRef: 'CR_MATCH', BizId: 'b1' }
    ];
    const idx = buildDepIndex(deps);
    const viaIndex = lookupDepositByKeys('PAYNO', deps, idx);
    const viaLinear = lookupDepositByKeys('PAYNO', deps, null);
    assert.equal(viaLinear, deps[0], '线性版行优先取 deps[0]');
    assert.equal(viaIndex, deps[0], 'Fix#1：索引版取行序最小 deps[0]（修复前键优先误取 deps[1]）');
    assert.equal(viaIndex, viaLinear, '索引版 === 线性版（byte 级一致）');
  });

  test('反向交叉：deps[0].ReconId==deps[1].ChannelOrderNo==payNo → 仍取 deps[0]', () => {
    const deps = [
      { ReconciliationId: 'KEY', CustomerRef: 'first', BizId: 'b0' },
      { ChannelOrderNo: 'KEY', CustomerRef: 'second', BizId: 'b1' }
    ];
    const idx = buildDepIndex(deps);
    assert.equal(lookupDepositByKeys('KEY', deps, idx), deps[0]);
    assert.equal(lookupDepositByKeys('KEY', deps, idx), lookupDepositByKeys('KEY', deps, null));
  });

  test('单键命中 / 未命中：两版一致', () => {
    const deps = [{ ReconciliationId: 'A', CustomerRef: 'ra' }, { ChannelOrderNo: 'B', CustomerRef: 'rb' }];
    const idx = buildDepIndex(deps);
    assert.equal(lookupDepositByKeys('B', deps, idx), lookupDepositByKeys('B', deps, null));
    assert.equal(lookupDepositByKeys('A', deps, idx), deps[0]);
    assert.equal(lookupDepositByKeys('Z', deps, idx), null);
    assert.equal(lookupDepositByKeys('Z', deps, null), null);
  });
});

// ============================================================================
// Fix#2 🟠Important：R2 子串无 token 边界误配 + 占位符黑名单变体漏拦
// ============================================================================
test.describe('Fix#2 R2 子串边界 + 黑名单归一', () => {
  test('短 ref 作为更长无关串子串 → 不命中（ABC123 ≠ XABC1234Y）', () => {
    const deps = [depRef('PAY', 'ABC123')];
    const hits = matchMemoContainsDepositRef(jpmBank('WIRE XABC1234Y'), [ro('PAY')], deps, buildDepIndex(deps));
    assert.equal(hits.length, 0, 'Fix#2：边界保护，ABC123 不命中 XABC1234Y');
  });

  test('ref 有 token 边界 → 正常命中', () => {
    const deps = [depRef('PAY', 'ABC123')];
    const hits = matchMemoContainsDepositRef(jpmBank('REF ABC123 END'), [ro('PAY')], deps, buildDepIndex(deps));
    assert.equal(hits.length, 1, '有边界应命中');
  });

  test('占位符变体 NOT PROVIDED / NON-REF（含大小写）→ 归一后黑名单拦截', () => {
    for (const ph of ['NOT PROVIDED', 'NON-REF', 'not provided', 'Non-Ref']) {
      const deps = [depRef('PAY', ph)];
      const hits = matchMemoContainsDepositRef(jpmBank(`X ${ph} Y`), [ro('PAY')], deps, buildDepIndex(deps));
      assert.equal(hits.length, 0, `Fix#2：${ph} 应被归一黑名单拦截`);
    }
  });

  test('depRef 含正则元字符（A.C123）→ escapeRegExp 字面匹配，不通配 AXC123', () => {
    const deps = [depRef('PAY', 'A.C123')];
    const hits = matchMemoContainsDepositRef(jpmBank('REF AXC123 END'), [ro('PAY')], deps, buildDepIndex(deps));
    assert.equal(hits.length, 0, 'Fix#2：. 须字面匹配，不得通配任意字符');
    const hits2 = matchMemoContainsDepositRef(jpmBank('REF A.C123 END'), [ro('PAY')], deps, buildDepIndex(deps));
    assert.equal(hits2.length, 1, '字面 A.C123 应命中');
  });
});

// ============================================================================
// Fix#3 🟠Important：R6 金额千分位逗号截断（FOR USD5,043.00 误配成 5.00）
// ============================================================================
test.describe('Fix#3 R6 金额千分位逗号', () => {
  test('FOR USD5,043.00 → 按 5043.00 比对，不误配 Credit Amount=5.00', () => {
    const memo = 'DTD05/21/2026 FOR USD5,043.00'; // MDY = 2026-05-21
    const deps5043 = [depR6('PAY', '2026-05-21', 5043.00)];
    const hit1 = matchMemoDateAmount(jpmBank(memo), [ro('PAY')], deps5043, buildDepIndex(deps5043));
    assert.equal(hit1.length, 1, '应命中 Credit Amount=5043.00');

    const deps5 = [depR6('PAY', '2026-05-21', 5.00)];
    const hit2 = matchMemoDateAmount(jpmBank(memo), [ro('PAY')], deps5, buildDepIndex(deps5));
    assert.equal(hit2.length, 0, 'Fix#3：不得误配 Credit Amount=5.00（修复前正则截断成 5）');
  });

  test('无逗号金额 FOR AMT100.00 仍正常', () => {
    const memo = 'DTD05/21/2026 FOR AMT100.00'; // MDY = 2026-05-21
    const deps = [depR6('PAY', '2026-05-21', 100.00)];
    const hit = matchMemoDateAmount(jpmBank(memo), [ro('PAY')], deps, buildDepIndex(deps));
    assert.equal(hit.length, 1);
  });
});

// ============================================================================
// Fix#4 🟠Important：R6 DTD 日期 D/M/Y 歧义（05/06/2026 误配）
// ============================================================================
test.describe('Fix#4 R6 DTD 按 DMY 明确解析', () => {
  test('parseDtdDateToken：MDY（美式 mm/dd/yyyy）解析 + 非法返回 null', () => {
    assert.equal(parseDtdDateToken('05/06/2026'), '2026-05-06', 'mm/dd/yyyy → 2026-05-06（美式 MDY，非 DMY 的 2026-06-05）');
    assert.equal(parseDtdDateToken('05/21/2026'), '2026-05-21', '21 只能为日 → 月在前 MDY');
    assert.equal(parseDtdDateToken('13/13/2026'), null, '非法 mm=13 → null');
    assert.equal(parseDtdDateToken('1/2/2026'), null, '非两位格式 → null');
    assert.equal(parseDtdDateToken(''), null);
    assert.equal(parseDtdDateToken('abc'), null);
  });

  test('matchMemoDateAmount 用 MDY：05/06/2026 命中 2026-05-06、不误配 2026-06-05', () => {
    const memo = 'DTD05/06/2026 FOR USD100.00'; // MDY = 2026-05-06
    const depsHit = [depR6('PAY', '2026-05-06', 100.00)];
    const h1 = matchMemoDateAmount(jpmBank(memo), [ro('PAY')], depsHit, buildDepIndex(depsHit));
    assert.equal(h1.length, 1, 'MDY=2026-05-06 命中');

    const depsDmy = [depR6('PAY', '2026-06-05', 100.00)];
    const h2 = matchMemoDateAmount(jpmBank(memo), [ro('PAY')], depsDmy, buildDepIndex(depsDmy));
    assert.equal(h2.length, 0, 'Fix#4：不按 DMY 误配到 2026-06-05');
  });

  test('非法 DTD（无效日期）→ 整层不命中、不抛', () => {
    const memo = 'DTD13/13/2026 FOR USD100.00';
    const deps = [depR6('PAY', '2026-06-05', 100.00)];
    assert.doesNotThrow(() => matchMemoDateAmount(jpmBank(memo), [ro('PAY')], deps, buildDepIndex(deps)));
    assert.equal(matchMemoDateAmount(jpmBank(memo), [ro('PAY')], deps, buildDepIndex(deps)).length, 0);
  });
});

// ============================================================================
// Fix#5 🟠Important：R4 不可解析日期被误报「时序矛盾」错误（应提示）
// ============================================================================
test.describe('Fix#5 R4 三态：不可解析日期 → 提示非报错', () => {
  test('classifyS4Window 三态', () => {
    const bank = { BillDate: '2026-06-10' };
    assert.deepEqual(classifyS4Window(bank, [{ valueDate: '2026-06-05' }]),
      { hasComparablePair: true, hasInWindowCandidate: true }, '窗内（diff=+5）');
    assert.deepEqual(classifyS4Window(bank, [{ valueDate: '2026-01-01' }]),
      { hasComparablePair: true, hasInWindowCandidate: false }, '超容差（diff>21）');
    assert.deepEqual(classifyS4Window(bank, [{ valueDate: '2026-06-20' }]),
      { hasComparablePair: true, hasInWindowCandidate: false }, '负 diff（bank 早于 ro）= 时序矛盾');
    assert.deepEqual(classifyS4Window(bank, [{ valueDate: 'bad' }]),
      { hasComparablePair: false, hasInWindowCandidate: false }, 'ro 日期不可解析');
    assert.deepEqual(classifyS4Window({ BillDate: 'bad' }, [{ valueDate: '2026-06-05' }]),
      { hasComparablePair: false, hasInWindowCandidate: false }, 'bank 日期不可解析');
  });

  test('引擎入口：唯一值已关联 + 日期不可解析 → RESULT_NOTICE（非 RESULT_ERROR）', () => {
    const bankRows = [{
      _rowId: 'b1', FundType: 'Ach Return', MerchantId: 'M1', Currency: 'USD',
      'Credit Amount': 0, 'Debit Amount': 100, Channel: 'CH',
      BillDate: 'bad', ReconciliationId: 'R1', ChannelOrderNo: '', CustomerRef: ''
    }];
    const refundRows = [{
      '流水号': 'SN1', '状态': 'SUBMITTED', '银行大账号': 'M1', '币种': 'USD',
      '退款金额': 100, '银行打款流水号': '', '附言': '', '付款人名称': '', '付款卡号': '', '虚拟卡号': '',
      'valueDate': '2026-06-01'
    }];
    const res = runRound5RefundOrderBackfill(bankRows, refundRows, []);
    assert.ok(res.unmatchedRows.length > 0, '应产 unmatched 行');
    const hasError = res.unmatchedRows.some((r) => r['结果类型'] === RESULT_ERROR);
    assert.equal(hasError, false, 'Fix#5：bad 日期不应报 RESULT_ERROR（时序矛盾误判）');
    const hasNotice = res.unmatchedRows.some((r) => r['结果类型'] === RESULT_NOTICE);
    assert.equal(hasNotice, true, '应产 RESULT_NOTICE 提示');
  });

  test('引擎入口：真·超容差日期 → 仍 RESULT_ERROR（不被 Fix#5 误降级）', () => {
    const bankRows = [{
      _rowId: 'b1', FundType: 'Ach Return', MerchantId: 'M1', Currency: 'USD',
      'Credit Amount': 0, 'Debit Amount': 100, Channel: 'CH',
      BillDate: '2026-12-31', ReconciliationId: 'R1', ChannelOrderNo: '', CustomerRef: ''
    }];
    const refundRows = [{
      '流水号': 'SN1', '状态': 'SUBMITTED', '银行大账号': 'M1', '币种': 'USD',
      '退款金额': 100, '银行打款流水号': '', '附言': '', '付款人名称': '', '付款卡号': '', '虚拟卡号': '',
      'valueDate': '2026-06-01'
    }];
    const res = runRound5RefundOrderBackfill(bankRows, refundRows, []);
    const hasError = res.unmatchedRows.some((r) => r['结果类型'] === RESULT_ERROR);
    assert.equal(hasError, true, '真·超 21 天容差仍应报 RESULT_ERROR');
  });
});

// ============================================================================
// Fix#6 🟢Minor：depIndex 空批早退前构建（性能）—— 行为正确性回归
// ============================================================================
test.describe('Fix#6 depIndex 空批早退', () => {
  test('全空入参 → 返回空、不抛', () => {
    const res = runRound5RefundOrderBackfill([], [], []);
    assert.deepEqual(res.backfillRows, []);
    assert.deepEqual(res.hitDepositBizIds, []);
  });

  test('无 SUBMITTED refund（早退）+ 大入金表 → 返回空、不抛（早退在 buildDepIndex 前）', () => {
    const bankRows = [{ _rowId: 'b', FundType: 'Ach Return', MerchantId: 'M1', Currency: 'USD', 'Credit Amount': 0, 'Debit Amount': 100 }];
    const refundRows = [{ '状态': 'DRAFT', '银行大账号': 'M1', '币种': 'USD', '退款金额': 100 }];
    const big = Array.from({ length: 50 }, (_, i) => ({ ReconciliationId: `r${i}`, CustomerRef: `c${i}` }));
    const res = runRound5RefundOrderBackfill(bankRows, refundRows, big);
    assert.deepEqual(res.backfillRows, []);
    assert.deepEqual(res.hitDepositBizIds, []);
  });
});
