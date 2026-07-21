// v2.1.16-beta.4 ③：R5 场景4「中台退款订单回填」编排器集成单测（node:test，合成数据）
// 目标文件：src/main-process/reconciliation-orchestrator.js（runReconciliation / bucketScenarios 集成落点）
//
// ⚠️ 范围边界：本文件只测【编排器编排 / 数据隔离 / 字段管道】，**不重测引擎 16 格矩阵决策**
//   （那是 r5-refund-order-backfill 引擎单测的职责，避免与后续引擎修复耦合）。
//   因此 refundContext 只构造「最小可命中」一笔 S1 用例，验证 backfillRows 能从引擎流出到编排器返回对象即可。
//
// 覆盖：
//   1. bucketScenarios 把 refund-order-backfill 正确分桶进 r5s4
//   2. refundContext.refundOrderRows / depositRows 正确传参到引擎（一笔 S1 命中 → refundBackfillRows 有 1 行）
//   3. 返回对象含 refundBackfillRows / refundUnmatchedRows + stats.r5s4BackfilledCount + rounds.r5s4
//   4. 🔴 数据隔离：场景4 不改 bankRows（FundType/ReconciliationId 不变）、不进 modifiedRows、
//      行数守恒 modifiedRows + unmatchedRows === bankRows.length 不变
//   5. 空 bucket（未启用退款场景）→ 退款回填 no-op、返回空数组、字段仍在
//   6. 启用退款场景但 refundContext 缺省 → 引擎空入参返回空，不抛、不改既有行为

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation,
  bucketScenarios
} = require('../../../src/main-process/reconciliation-orchestrator');

// ---------------------------------------------------------------------------
// 合成数据
// ---------------------------------------------------------------------------

// 银行行：含退款回填引擎筛选/分组/S1 所需列（FundType=Ach Return / MerchantId / Currency / 金额 / ChannelOrderNo）
function makeBankRow(overrides = {}) {
  return {
    _rowId: overrides._rowId,
    ReconciliationId: overrides.ReconciliationId ?? '',
    FundType: overrides.FundType ?? '',
    MerchantId: overrides.MerchantId ?? 'M001',
    Currency: overrides.Currency ?? 'USD',
    'Credit Amount': overrides['Credit Amount'] ?? '',
    'Debit Amount': overrides['Debit Amount'] ?? '',
    BillDate: overrides.BillDate ?? '2026-06-01',
    Channel: overrides.Channel ?? '工商',
    地区: overrides['地区'] ?? '上海',
    ChannelOrderNo: overrides.ChannelOrderNo ?? '',
    CustomerRef: overrides.CustomerRef ?? '',
    'Extra Information': overrides['Extra Information'] ?? '',
    'Payment Detail': overrides['Payment Detail'] ?? ''
  };
}

// 退款订单行（中文 25 列子集；本测只填 S1 命中 + 唯一值分组所需字段）
function makeRefundRow(overrides = {}) {
  return {
    流水号: overrides.流水号 ?? 'REF-0001',
    银行大账号: overrides.银行大账号 ?? 'M001',
    退款金额: overrides.退款金额 ?? 100,
    币种: overrides.币种 ?? 'USD',
    状态: overrides.状态 ?? 'SUBMITTED',
    银行打款流水号: overrides.银行打款流水号 ?? '',
    附言: overrides.附言 ?? '',
    valueDate: overrides.valueDate ?? '2026-06-01'
  };
}

// R5 场景4 退款回填场景（默认休眠，但单测里手动 enabled=true 强制启用以测编排管道）
function makeR5RefundScenario({ enabled = true, fuzzyEnabled = false } = {}) {
  return {
    id: 504,
    name: '中台退款订单回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'refund-order-backfill',
      roundPhase: 5,
      bankPaymentSerialFuzzyMatchEnabled: fuzzyEnabled
    }
  };
}

// 构造一份「最小可命中」数据：1 条 Ach Return 银行行 + 1 条 SUBMITTED 退款订单，S1 命中（ChannelOrderNo ↔ 银行打款流水号）。
function buildRefundHitData() {
  const bankRows = [
    makeBankRow({
      _rowId: 'rb1',
      FundType: 'Ach Return',
      MerchantId: 'M001', Currency: 'USD',
      'Debit Amount': 100, 'Credit Amount': 0,
      ChannelOrderNo: 'PAY-9001'
    }),
    // 普通行：不参与退款回填（FundType 非 Ach Return）→ 也不命中任何其它轮 → 进 unmatched
    makeBankRow({ _rowId: 'rb2', FundType: 'Settlement', MerchantId: 'M002' })
  ];
  const refundOrderRows = [
    makeRefundRow({
      流水号: 'REF-9001',
      银行大账号: 'M001', 退款金额: 100, 币种: 'USD',
      状态: 'SUBMITTED',
      银行打款流水号: 'PAY-9001' // S1 ↔ bank ChannelOrderNo
    })
  ];
  return { bankRows, refundOrderRows };
}

// ---------------------------------------------------------------------------
// 1. 分桶
// ---------------------------------------------------------------------------
test.describe('bucketScenarios：refund-order-backfill 落 r5s4', () => {
  test('refund-order-backfill → r5s4，不误入 R2/R5s2/R5s3', async () => {
    const { r2, r4, r5s2, r5s3, r5s4 } = bucketScenarios([makeR5RefundScenario()]);
    assert.equal(r5s4.length, 1, 'r5s4 应含退款场景');
    assert.equal(r5s4[0].config.subCategory, 'refund-order-backfill');
    assert.equal(r2.length, 0);
    assert.equal(r4.length, 0);
    assert.equal(r5s2.length, 0);
    assert.equal(r5s3.length, 0);
  });

  test('platform-order 但 subCategory 缺失 → 落 R2（不误入 r5s4）', async () => {
    const s = { id: 9, category: 'builtin-fixed', config: { funcCategory: 'platform-order' } };
    const { r2, r5s4 } = bucketScenarios([s]);
    assert.equal(r2.length, 1);
    assert.equal(r5s4.length, 0);
  });

  test('空 / null 入参 → r5s4 桶空，不抛', async () => {
    for (const input of [[], null, undefined]) {
      assert.equal(bucketScenarios(input).r5s4.length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 + 4：refundContext 传参 / 返回字段 / 数据隔离 + 行数守恒
// ---------------------------------------------------------------------------
test.describe('runReconciliation R5 场景4 集成', () => {
  test('refundContext 传参到引擎 → backfillRows 流出到返回对象（S1 一笔命中）', async () => {
    const { bankRows, refundOrderRows } = buildRefundHitData();
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5RefundScenario()],
      refundContext: { refundOrderRows, depositRows: [] }
    });

    assert.ok(Array.isArray(result.refundBackfillRows), 'refundBackfillRows 数组');
    assert.ok(Array.isArray(result.refundUnmatchedRows), 'refundUnmatchedRows 数组');
    assert.equal(result.refundBackfillRows.length, 1, 'S1 命中 → 应有 1 行回填');

    // 回填行携带退款单号（来自 refund order 流水号）+ 渠道流水号（来自 bank ReconciliationId）
    const row = result.refundBackfillRows[0];
    assert.equal(row['退款单号'], 'REF-9001', '退款单号取自 refund order 流水号');
    assert.equal(row['状态'], 'SUCCESS', '回填状态 SUCCESS');

    // stats / rounds 字段
    assert.equal(result.stats.r5s4BackfilledCount, 1, 'stats.r5s4BackfilledCount = 回填行数');
    // v3.0.7 需求A：场景4 启用 → stats.r5s4Enabled=true（供 renderer 状态框显示该行）；与 backfillRows 计数一致。
    assert.equal(result.stats.r5s4Enabled, true, 'stats.r5s4Enabled=true（场景4 启用）');
    assert.equal(
      result.stats.r5s4BackfilledCount,
      result.refundBackfillRows.length,
      'stats.r5s4BackfilledCount 与 refundBackfillRows.length 一致'
    );
    assert.ok(result.rounds.r5s4 && typeof result.rounds.r5s4 === 'object', 'rounds.r5s4 存在');
    assert.equal(result.rounds.r5s4.backfilled, 1, 'rounds.r5s4.backfilled = 回填行数');
  });

  test('编排器传 r1.pairs：同 reconid 仅 R1 选中的 AchReturn 银行行被拦，未配对行仍回填', async () => {
    const pairedBank = makeBankRow({
      _rowId: 'paired', ReconciliationId: 'RID-SAME', FundType: 'Ach Return',
      'Debit Amount': 100, 'Credit Amount': 0, ChannelOrderNo: 'PAY-PAIRED'
    });
    const unpairedBank = makeBankRow({
      _rowId: 'unpaired', ReconciliationId: 'RID-SAME', FundType: 'Ach Return',
      'Debit Amount': 100, 'Credit Amount': 0, ChannelOrderNo: 'PAY-UNPAIRED'
    });
    const result = await runReconciliation({
      bankRows: [pairedBank, unpairedBank],
      gwRows: [{ reconciliationid: 'RID-SAME', TradeType: '  AchReturn  ' }],
      scenarios: [makeR5RefundScenario()],
      refundContext: {
        refundOrderRows: [
          makeRefundRow({ 流水号: 'REF-PAIRED', 银行打款流水号: 'PAY-PAIRED' }),
          makeRefundRow({ 流水号: 'REF-UNPAIRED', 银行打款流水号: 'PAY-UNPAIRED' })
        ],
        depositRows: []
      }
    });

    assert.equal(result.stats.r1Matched, 1, 'R1 只建立一组 1v1 pair');
    assert.equal(result.refundBackfillRows.length, 1, '只拦 R1 具体 pair.bankRow');
    assert.equal(result.refundBackfillRows[0]['退款单号'], 'REF-UNPAIRED');
    assert.equal(result.refundBackfillRows[0].ChannelOrderNo, 'PAY-UNPAIRED');
  });

  test('合成最小回归：Inbound-VA 配对不阻断精准退款命中', async () => {
    const bankRows = [makeBankRow({
      _rowId: 'synthetic-refund-bank',
      ReconciliationId: 'SYNTH-REFUND-RECON-001',
      FundType: 'Ach Return',
      MerchantId: 'SYNTH-MERCHANT-001',
      Currency: 'USD',
      'Credit Amount': 0,
      'Debit Amount': 11000,
      CustomerRef: 'SYNTH-REFUND-RECON-001',
      ChannelOrderNo: 'SYNTH-CHANNEL-ORDER-001',
      Channel: 'DBS'
    })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [{
        reconciliationid: 'SYNTH-REFUND-RECON-001',
        TradeType: 'Inbound-VA',
        merchantid: 'SYNTH-MERCHANT-001',
        currency: 'USD',
        amount: 11000
      }],
      scenarios: [makeR5RefundScenario()],
      refundContext: {
        refundOrderRows: [makeRefundRow({
          流水号: 'SYNTH-REFUND-ORDER-001',
          银行大账号: 'SYNTH-MERCHANT-001',
          退款金额: 11000,
          币种: 'USD',
          银行打款流水号: 'SYNTH-REFUND-RECON-001'
        })],
        depositRows: []
      }
    });

    assert.equal(result.refundBackfillRows.length, 1);
    assert.equal(result.refundBackfillRows[0]['退款单号'], 'SYNTH-REFUND-ORDER-001');
    assert.equal(result.refundBackfillRows[0]['命中类型'], '精准命中');
    assert.match(result.refundBackfillRows[0]['匹配命中详情'], /CustomerRef/);
  });

  test('场景开关透传到引擎：关闭保持未命中，开启救回差额小于10的流水号候选', async () => {
    const buildInput = () => ({
      bankRows: [makeBankRow({
        _rowId: 'fuzzy-bank',
        FundType: 'Ach Return',
        MerchantId: 'M001',
        Currency: 'USD',
        'Debit Amount': '109.99',
        'Credit Amount': '0',
        ChannelOrderNo: 'FUZZY-PAY',
        BillDate: '2026-07-16'
      })],
      refundContext: {
        refundOrderRows: [makeRefundRow({
          流水号: 'FUZZY-REFUND',
          银行大账号: 'M001',
          退款金额: '100',
          币种: 'USD',
          银行打款流水号: 'FUZZY-PAY',
          valueDate: '2026-01-01'
        })],
        depositRows: []
      }
    });

    const disabledInput = buildInput();
    const disabled = await runReconciliation({
      ...disabledInput,
      gwRows: [],
      scenarios: [makeR5RefundScenario({ fuzzyEnabled: false })]
    });
    assert.equal(disabled.refundBackfillRows.length, 0);

    const enabledInput = buildInput();
    const enabled = await runReconciliation({
      ...enabledInput,
      gwRows: [],
      scenarios: [makeR5RefundScenario({ fuzzyEnabled: true })]
    });
    assert.equal(enabled.refundBackfillRows.length, 1);
    assert.equal(enabled.refundBackfillRows[0]['命中类型'], '模糊命中');
  });

  test('🔴 数据隔离：场景4 不改 bankRows、不进 modifiedRows、行数守恒不变', async () => {
    const { bankRows, refundOrderRows } = buildRefundHitData();
    const total = bankRows.length;
    // 快照命中行的关键字段（应保持不变）
    const before = bankRows.map((r) => ({
      _rowId: r._rowId, FundType: r.FundType, ReconciliationId: r.ReconciliationId
    }));

    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5RefundScenario()],
      refundContext: { refundOrderRows, depositRows: [] }
    });

    // 行数守恒不变（退款回填不进 modifiedRows/unmatchedRows 分区，仅旁路产模板行）
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      total,
      'modifiedRows + unmatchedRows === bankRows.length 不变'
    );
    // 场景4 不改银行行字段（FundType / ReconciliationId 原样）
    for (const snap of before) {
      const cur = bankRows.find((r) => r._rowId === snap._rowId);
      assert.equal(cur.FundType, snap.FundType, `${snap._rowId}.FundType 不被退款回填改写`);
      assert.equal(cur.ReconciliationId, snap.ReconciliationId, `${snap._rowId}.ReconciliationId 不被退款回填改写`);
    }
    // 命中退款的银行行（rb1）没有被拉进 modifiedRows（退款回填不算「改写银行行」命中）
    assert.ok(
      !result.modifiedRows.some((r) => r._rowId === 'rb1'),
      'rb1 不应进 modifiedRows（退款回填只产模板、不改银行行）'
    );
    // rb1 仍在 unmatchedRows（它没被任何改写轮命中）
    assert.ok(result.unmatchedRows.some((r) => r._rowId === 'rb1'), 'rb1 应在 unmatchedRows');
    // 退款回填不产 modifications
    assert.ok(
      !result.modifications.some((m) => m._round === 'R5s4'),
      '退款回填不应产 R5s4 modifications'
    );
  });
});

// ---------------------------------------------------------------------------
// 5 + 6：空 bucket / 缺 refundContext 守卫
// ---------------------------------------------------------------------------
test.describe('runReconciliation R5 场景4 守卫', () => {
  test('空 bucket（未启用退款场景）→ no-op、返回空数组、字段仍在', async () => {
    const { bankRows, refundOrderRows } = buildRefundHitData();
    const total = bankRows.length;
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [], // 无退款场景 → r5s4 桶空
      refundContext: { refundOrderRows, depositRows: [] } // 即便给了 context，bucket 空也不跑
    });

    assert.deepEqual(result.refundBackfillRows, [], '无退款场景 → refundBackfillRows 空');
    assert.deepEqual(result.refundUnmatchedRows, [], '无退款场景 → refundUnmatchedRows 空');
    assert.equal(result.stats.r5s4BackfilledCount, 0);
    // v3.0.7 需求A：r5s4 桶空（场景未启用）→ r5s4Enabled=false（renderer 不显示该行）。
    assert.equal(result.stats.r5s4Enabled, false, 'r5s4 桶空 → r5s4Enabled=false');
    assert.equal(result.rounds.r5s4.backfilled, 0);
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      total,
      '行数守恒不变'
    );
  });

  test('启用退款场景但 refundContext 缺省 → 引擎空入参返回空、不抛', async () => {
    const { bankRows } = buildRefundHitData();
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5RefundScenario()]
        // 不传 refundContext
      });
    });
    assert.deepEqual(result.refundBackfillRows, [], '缺 refundContext → 空 refundOrderRows → 无回填');
    assert.equal(result.stats.r5s4BackfilledCount, 0);
    // v3.0.7 需求A 核心：场景【启用】但 0 条命中 → r5s4Enabled 仍为 true（状态框照样显示「0 条命中」，
    //   作为运行时自检信号——见 spec.md §二：跑了但没命中 = 退款没进）。
    assert.equal(result.stats.r5s4Enabled, true, '场景启用但 0 命中 → r5s4Enabled 仍 true');
  });
});

// ---------------------------------------------------------------------------
// v3.0.7 需求6（🔴 资金红线）：bank-statement:run 的 bank-deposit「消费方门控」谓词同源钉死。
//   main.js 在读 bank-deposit 入金表（65.7万行~1.2GB 尖峰）前加 refundBackfillEnabled 门控：
//   仅退款场景启用时才整表读 + structuredClone，否则注入 []（编排器 r5s4Bucket 空 → no-op）。
//   本测试把门控谓词（main.js 逐字镜像）与 bucketScenarios(...).r5s4.length>0 钉死同源——
//   防分桶条件（reconciliation-orchestrator.js:173）将来改了、门控谓词漏更新 → 退款场景启用却漏读入金表
//   → 漏退款回填（静默资金事故）。
// ---------------------------------------------------------------------------
test.describe('v3.0.7 需求6：bank-deposit 门控谓词与 r5s4 分桶同源', () => {
  // main.js bank-statement:run 内门控谓词逐字镜像（src/main.js refundBackfillEnabled）。
  //   入参 dispatchScenarios 已是 enabled 过滤后集合 → 与生产同范式。
  const refundBackfillEnabledPredicate = (dispatchScenarios) => dispatchScenarios.some(
    (s) => s && s.category === 'builtin-fixed'
      && s.config && s.config.funcCategory === 'platform-order'
      && s.config.subCategory === 'refund-order-backfill'
  );

  // 各组「dispatchScenarios」与期望门控值；同时断言 == bucketScenarios(...).r5s4.length>0
  const cases = [
    { label: '含 refund-order-backfill → 门控 true', scenarios: [makeR5RefundScenario()], expected: true },
    {
      label: '不含 refund（仅其它 builtin/C 类）→ 门控 false',
      scenarios: [
        { id: 1, category: 'builtin-fixed', config: { funcCategory: 'fund-nature-check', subCategory: 'hx-out' } },
        { id: 2, category: 'builtin-fixed', config: { funcCategory: 'platform-order', subCategory: 'fund-transfer-backfill' } },
        { id: 3, category: 'gateway-recon-join', config: {} }
      ],
      expected: false
    },
    {
      label: 'platform-order 但缺 subCategory → 门控 false（不误判，与分桶落 R2 一致）',
      scenarios: [{ id: 9, category: 'builtin-fixed', config: { funcCategory: 'platform-order' } }],
      expected: false
    },
    {
      label: 'subCategory=refund-order-backfill 但 category 非 builtin-fixed → 门控 false（category 收紧一致）',
      scenarios: [{ id: 10, category: 'extract-recon-id', config: { funcCategory: 'platform-order', subCategory: 'refund-order-backfill' } }],
      expected: false
    },
    { label: '空集 → 门控 false', scenarios: [], expected: false },
    {
      label: '退款 + 其它场景混合 → 门控 true',
      scenarios: [
        { id: 1, category: 'builtin-fixed', config: { funcCategory: 'fund-nature-check', subCategory: 'hx-out' } },
        makeR5RefundScenario()
      ],
      expected: true
    }
  ];

  for (const c of cases) {
    test(c.label, () => {
      const gate = refundBackfillEnabledPredicate(c.scenarios);
      assert.equal(gate, c.expected, `门控谓词期望 ${c.expected}`);
      // 🔴 钉死同源：门控 ⟺ bucketScenarios r5s4 桶非空（编排器真正消费 depositRows 的条件）
      const r5s4NonEmpty = bucketScenarios(c.scenarios).r5s4.length > 0;
      assert.equal(gate, r5s4NonEmpty, '门控谓词必须与 bucketScenarios(...).r5s4.length>0 完全一致（同源）');
    });
  }
});
