// v3.0.6 需求3「R3.5 DBS-Charge 资金校验」编排器接线单测（node:test，合成数据）
// 目标文件：src/main-process/reconciliation-orchestrator.js（R3.5 落点 + dispatchReconContext 注入管道）
// plan「需求3」/ 资金红线 review 点 1~3、8。
//
// ⚠️ 范围边界：只测【编排器分桶（不漂 R2/R4）/ R3.5 gating / dispatchReconContext 注入管道 / _round 标记 /
//   stats.dbsChargeChangedCount / rounds.r35.changed / R3.5→R4 跨轮次序 / 行数守恒 / 缺省 no-op】，
//   不重测引擎匹配矩阵（那是 dbs-charge-fund-check 引擎单测职责）。
//
// 覆盖：
//   1. bucketScenarios：funcCategory='dbs-charge-fund-check' 落新桶 dbsChargeFundCheck，不漂 R2/R4
//   2. 注入 dispatchReconContext + DBS-Charge 场景 → R3.5 改写流出 modifiedRows + stats.dbsChargeChangedCount + rounds.r35.changed
//   3. 缺省 / 空 dispatchReconContext / 无 DBS-Charge 场景 → R3.5 no-op 不抛
//   4. R3.5 在 R4 前（跨轮链）：R3.5 置 outbound 后 R4 的 hx-out 续改 outbound→HX-out
//   5. 行数守恒：modifiedRows + unmatchedRows === bankRows.length

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation,
  bucketScenarios
} = require('../../../src/main-process/reconciliation-orchestrator');

// ---- 合成数据 ----------------------------------------------------------

// 银行行（含 DBS-Charge 引擎所需列：Channel/MerchantId/Currency/Credit·Debit Amount/FundType/ReconciliationId/_rowId）
function makeBankRow(o = {}) {
  return {
    _rowId: o._rowId,
    Channel: o.Channel ?? 'DBS',
    MerchantId: o.MerchantId ?? 'M-DBS-001',
    Currency: o.Currency ?? 'USD',
    'Credit Amount': o['Credit Amount'] ?? '',
    'Debit Amount': o['Debit Amount'] ?? '',
    FundType: o.FundType ?? 'Charge',
    ReconciliationId: o.ReconciliationId ?? '',
    BillDate: o.BillDate ?? '2026-06-01'
  };
}

// 调拨对账单派生行（linked_fund_transfer_recon；字段名 = FT_RECON_FIELD_MAP.recon 真实列）
//   付款渠道/收款渠道（步骤1 门控=DBS）、big_account ↔ MerchantId、币种 ↔ Currency、
//   金额（绝对值精确到分）、BillDate（v3.1.1 日期门禁）、ReconID（赋值来源）
function makeDispRow(o = {}) {
  return {
    付款渠道: o['付款渠道'] ?? 'DBS',
    收款渠道: o['收款渠道'] ?? 'DBS',
    big_account: o.big_account ?? 'M-DBS-001',
    币种: o['币种'] ?? 'USD',
    金额: o['金额'] ?? 100,
    BillDate: o.BillDate ?? '2026-06-01',
    ReconID: o.ReconID ?? 'DISP-RECON-1',
    fund_type: o.fund_type ?? 'FundTransfer-out'
  };
}

// 网关行（gateway-bill 真实表头，小写）：步骤2 amount/currency 判 outbound
function makeGwRow(o = {}) {
  return {
    reconciliationid: o.reconciliationid ?? 'DISP-RECON-1',
    amount: o.amount ?? 100,
    currency: o.currency ?? 'USD',
    merchantid: o.merchantid ?? 'M-DBS-001',
    TradeType: o.TradeType ?? 'PUBLIC_PAY'
  };
}

// DBS-Charge 场景（builtin-fixed + funcCategory='dbs-charge-fund-check' → R3.5 桶）
function makeDbsChargeScenario(configOverrides = {}) {
  return {
    id: 350,
    name: 'DBS-Charge资金校验',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'dbs-charge-fund-check',
      subCategory: 'dbs-charge-fund-check',
      bankChannel: 'DBS',
      dispatchChannelValue: 'DBS',
      setFundTypeCharge: 'Charge',
      setFundTypeOutbound: 'outbound',
      chargeSiblingsScope: 'all',
      ...configOverrides
    }
  };
}

// R4：HX-out 子场景（gwTradeType='HX_OUTBOUND'，setFundType='HX-out'）—— 跨轮链测试用
function makeR4HxOutScenario() {
  return {
    id: 402,
    name: 'R4-HX-out',
    category: 'builtin-fixed',
    priority: 3,
    enabled: true,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'hx-out',
      priority: 3,
      gwTradeType: 'HX_OUTBOUND',
      setFundType: 'HX-out'
    }
  };
}

// ---- 1. bucketScenarios：DBS-Charge 落新桶，不漂 R2/R4 -------------------

test.describe('bucketScenarios —— DBS-Charge 落 dbsChargeFundCheck 桶（不漂 R2/R4）', () => {
  test('funcCategory=dbs-charge-fund-check → dbsChargeFundCheck 桶；fund-nature-check → r4；其余 → r2', async () => {
    const buckets = bucketScenarios([
      makeDbsChargeScenario(),                                                   // → dbsChargeFundCheck
      makeR4HxOutScenario(),                                                     // → r4
      { id: 1, category: 'builtin-fixed', config: { extractByFeature: {} } },    // 无 funcCategory builtin-fixed → r2
      { id: 2, category: 'extract-recon-id', config: {} }                        // C1 → r2
    ]);
    assert.equal(buckets.dbsChargeFundCheck.length, 1, 'DBS-Charge 落新桶');
    assert.equal(buckets.dbsChargeFundCheck[0].config.funcCategory, 'dbs-charge-fund-check');
    assert.equal(buckets.r4.length, 1, 'fund-nature-check 落 r4');
    assert.equal(buckets.r2.length, 2, '无 funcCategory builtin-fixed + C1 落 r2');
    // 🔴 关键：DBS-Charge 不漏进 r2/r4（if/else 顺序正确）
    assert.ok(!buckets.r2.some((s) => s.config && s.config.funcCategory === 'dbs-charge-fund-check'),
      'DBS-Charge 不应落 r2 兜底桶');
    assert.ok(!buckets.r4.some((s) => s.config && s.config.funcCategory === 'dbs-charge-fund-check'),
      'DBS-Charge 不应落 r4 桶');
  });

  test('返回对象含 dbsChargeFundCheck 键（空入参也有该键）', async () => {
    const buckets = bucketScenarios([]);
    assert.ok(Array.isArray(buckets.dbsChargeFundCheck), 'dbsChargeFundCheck 键存在且为数组');
    assert.equal(buckets.dbsChargeFundCheck.length, 0);
  });
});

// ---- 2. 注入 dispatchReconContext + DBS-Charge 场景 → R3.5 改写流出 -------

test.describe('runReconciliation R3.5 —— DBS-Charge 改写流出（modifiedRows + stats + rounds）', () => {
  test('步骤1 赋 ReconciliationId + 标 FundTransfer-out + 步骤2 兄弟行转 outbound → 进 modifiedRows、_round=R3.5、stats/rounds 计数', async () => {
    // 对称模型（用户最终拍板）：调拨命中行标 FundTransfer-out（非 outbound）；网关确认的 outbound 落在同桶兄弟行。
    //   b1：DBS、FundType=Charge、ReconciliationId 空 → 步骤1 调拨命中赋 DISP-RECON-1 + 标 FundTransfer-out（makeDispRow.fund_type）。
    //       命中行受两阶段保护，步骤2 不碰（FundTransfer-out ∉ 候选 {Charge,outbound}）。→ 2 列改写。
    //   b2：DBS、FundType=Charge、预置 ReconciliationId=DISP-RECON-1（同桶）、金额 100 → 步骤2 网关 amount=100 命中 → Charge→outbound。→ 1 列改写。
    const bankRows = [
      makeBankRow({ _rowId: 'b1', FundType: 'Charge', ReconciliationId: '', 'Debit Amount': 500 }),
      makeBankRow({ _rowId: 'b2', FundType: 'Charge', ReconciliationId: 'DISP-RECON-1', 'Debit Amount': 100 })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'DISP-RECON-1', amount: 100, currency: 'USD' })],
      scenarios: [makeDbsChargeScenario()],
      // 调拨行金额 500 ↔ b1（Debit 500）；fund_type=FundTransfer-out（makeDispRow 默认）。
      dispatchReconContext: { dispatchReconRows: [makeDispRow({ ReconID: 'DISP-RECON-1', 金额: 500 })] }
    });

    // b1：步骤1 赋 ReconciliationId + 标 FundTransfer-out（受保护，步骤2 不碰）。
    assert.equal(bankRows[0].ReconciliationId, 'DISP-RECON-1', '步骤1 赋 ReconciliationId');
    assert.equal(bankRows[0].FundType, 'FundTransfer-out', '步骤1 命中行标 FundTransfer-out（非 outbound）');
    // b2：步骤2 网关命中 → outbound。
    assert.equal(bankRows[1].FundType, 'outbound', '步骤2 兄弟行 Charge→outbound');

    // 三条 modification 都标 _round=R3.5（b1: ReconciliationId + FundType；b2: FundType）
    const reconMod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    const b1FtMod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'FundType');
    const b2FtMod = result.modifications.find((m) => m.rowId === 'b2' && m.column === 'FundType');
    assert.ok(reconMod, 'b1 应产 ReconciliationId modification');
    assert.ok(b1FtMod, 'b1 应产 FundType modification（标 FundTransfer-out）');
    assert.ok(b2FtMod, 'b2 应产 FundType modification（转 outbound）');
    assert.equal(reconMod._round, 'R3.5');
    assert.equal(b1FtMod._round, 'R3.5');
    assert.equal(b1FtMod.newValue, 'FundTransfer-out');
    assert.equal(b2FtMod._round, 'R3.5');
    assert.equal(b2FtMod.newValue, 'outbound');

    // stats / rounds 计数（3 条改写：b1 两列 + b2 一列）
    assert.equal(result.stats.dbsChargeChangedCount, 3, 'stats.dbsChargeChangedCount=3');
    assert.equal(result.rounds.r35.changed, 3, 'rounds.r35.changed=3');

    // 命中行进 modifiedRows + 标黄列
    const out1 = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(out1, 'b1 进 modifiedRows');
    assert.ok(out1._modifiedColumns.has('ReconciliationId'), 'b1 _modifiedColumns 含 ReconciliationId');
    assert.ok(out1._modifiedColumns.has('FundType'), 'b1 _modifiedColumns 含 FundType');
    const out2 = result.modifiedRows.find((r) => r._rowId === 'b2');
    assert.ok(out2._modifiedColumns.has('FundType'), 'b2 _modifiedColumns 含 FundType');

    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('步骤1 归并同 reconId 兄弟行为 Charge（assignChargeToSiblings 接线流出）', async () => {
    // b1：命中行（步骤1 赋 DISP-RECON-1）；b2：同 reconId 已就位但 FundType≠Charge → 步骤1 末归并为 Charge。
    //   网关侧无对应 amount → 步骤2 不触发 outbound（保持 Charge）。
    const bankRows = [
      makeBankRow({ _rowId: 'b1', FundType: 'Charge', ReconciliationId: '', 'Debit Amount': 100 }),
      makeBankRow({
        _rowId: 'b2',
        FundType: 'SomeOther',
        ReconciliationId: 'DISP-RECON-1',
        'Credit Amount': 0,
        'Debit Amount': 999
      })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [], // 步骤2 无网关 → 不转 outbound
      scenarios: [makeDbsChargeScenario()],
      dispatchReconContext: { dispatchReconRows: [makeDispRow({ ReconID: 'DISP-RECON-1', 金额: 100 })] }
    });

    assert.equal(bankRows[1].FundType, 'Charge', 'b2 同 reconId 非 Charge 行被归并为 Charge');
    const b2Mod = result.modifications.find((m) => m.rowId === 'b2' && m.column === 'FundType');
    assert.ok(b2Mod, 'b2 应产 FundType→Charge modification');
    assert.equal(b2Mod._round, 'R3.5');
    assert.equal(b2Mod.newValue, 'Charge');
    assert.ok(result.stats.dbsChargeChangedCount >= 1);
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('步骤2 Credit 方向不符 warning 汇总进 errorReport，银行行保持原值且不进 modifiedRows', async () => {
    const bankRows = [makeBankRow({
      _rowId: 'direction-bad',
      FundType: 'Charge',
      ReconciliationId: 'RID-DIRECTION',
      'Credit Amount': 100,
      'Debit Amount': 0
    })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'RID-DIRECTION', TradeType: 'PUBLIC_PAY', amount: 100 })],
      scenarios: [makeDbsChargeScenario()],
      dispatchReconContext: { dispatchReconRows: [] }
    });

    assert.equal(bankRows[0].FundType, 'Charge');
    assert.equal(result.stats.dbsChargeChangedCount, 0);
    assert.equal(result.modifiedRows.length, 0);
    assert.equal(result.unmatchedRows.length, 1);
    assert.equal(result.errorReport.length, 1);
    assert.equal(result.errorReport[0].code, 'dbs-charge-fund-direction-mismatch');
    assert.equal(result.stats.warningCount, 1);
  });
});

// ---- 3. 缺省 / 空 / 无场景 → R3.5 no-op 不抛 -----------------------------

test.describe('runReconciliation R3.5 —— 缺省/空/无场景 no-op（不抛、行数守恒）', () => {
  test('无 DBS-Charge 场景（桶空）→ R3.5 不跑、stats/rounds 计数 0', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Charge', 'Debit Amount': 100 })];
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [makeGwRow()],
        scenarios: [], // 无任何 DBS-Charge 场景
        dispatchReconContext: { dispatchReconRows: [makeDispRow()] }
      });
    });
    assert.equal(result.stats.dbsChargeChangedCount, 0, '桶空 → 0 改写');
    assert.equal(result.rounds.r35.changed, 0);
    assert.equal(bankRows[0].FundType, 'Charge', '银行行未被改写');
    assert.equal(bankRows[0].ReconciliationId, '');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('有 DBS-Charge 场景但缺省 dispatchReconContext → 空入参 no-op、不抛', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Charge', 'Debit Amount': 100 })];
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [makeGwRow()],
        scenarios: [makeDbsChargeScenario()]
        // 不传 dispatchReconContext
      });
    });
    assert.equal(result.stats.dbsChargeChangedCount, 0, '空 dispatchReconRows → 0 改写');
    assert.equal(result.rounds.r35.changed, 0);
    assert.equal(bankRows[0].FundType, 'Charge');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('dispatchReconContext.dispatchReconRows=[] 显式空数组 → no-op、不抛', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Charge', 'Debit Amount': 100 })];
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [makeGwRow()],
        scenarios: [makeDbsChargeScenario()],
        dispatchReconContext: { dispatchReconRows: [] }
      });
    });
    assert.equal(result.stats.dbsChargeChangedCount, 0);
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---- 4. R3.5 在 R4 前（跨轮链）：R3.5 置 outbound → R4 hx-out 续改 outbound→HX-out ----

test.describe('runReconciliation —— R3.5 先于 R4（跨轮链 outbound→HX-out）', () => {
  test('🔴 R3.5 把 DBS 行 Charge→outbound（步骤2 网关确认）后，R4 hx-out 续改 outbound→HX-out（次序正确）', async () => {
    // 对称模型：R3.5 步骤2 网关确认的 outbound 落在「未被调拨命中」的桶内行（调拨命中行会被标 FundTransfer 且步骤2 不碰）。
    // v3.0.23 起 R4 读取完整 exactRows；b1 仍预置 ReconciliationId 以同时覆盖 R1 统计。
    // b1：DBS 银行行，FundType=Charge、ReconciliationId=DISP-RECON-1（导入时已带，供 R1 匹配；不被调拨命中——调拨 big_account 另设）。
    //   R3.5 步骤1：调拨行 big_account=OTHER-CARD 不匹配 b1（MerchantId=M-DBS-001）→ b1 不被标 FundTransfer、不被赋值；
    //              步骤2 网关 amount/currency 命中 → b1（候选 Charge）Charge→outbound（1 条 FundType modification）。
    //   R4 hx-out：网关 TradeType=HX_OUTBOUND；此刻 b1.FundType=outbound≠HX-out → 续改 outbound→HX-out
    //     （叠加链跨轮保留：R3.5 第二跳 + R4 第三跳，证明 R3.5 先于 R4）。
    const bankRows = [makeBankRow({
      _rowId: 'b1',
      FundType: 'Charge',
      ReconciliationId: 'DISP-RECON-1', // 导入时已带 → R1 可 1v1 匹配网关 → R4 hx-out 有料；步骤2 桶键
      'Debit Amount': 100
    })];
    // 第一条 HX_OUTBOUND 供 R4；第二条白名单 PUBLIC_PAY 供 R3.5 步骤2。
    const gwRows = [
      makeGwRow({
        reconciliationid: 'DISP-RECON-1', amount: 100, currency: 'USD', TradeType: 'HX_OUTBOUND'
      }),
      makeGwRow({
        reconciliationid: 'DISP-RECON-1', amount: 100, currency: 'USD', TradeType: 'PUBLIC_PAY'
      })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows,
      scenarios: [makeDbsChargeScenario(), makeR4HxOutScenario()],
      // 调拨 big_account=OTHER-CARD ≠ b1.MerchantId（M-DBS-001）→ 步骤1 不命中 b1（b1 仅经步骤2 转 outbound）。
      dispatchReconContext: { dispatchReconRows: [makeDispRow({ big_account: 'OTHER-CARD', ReconID: 'DISP-RECON-1', 金额: 100 })] }
    });

    // 最终值 = HX-out（R3.5 步骤2 Charge→outbound 第一跳 + R4 outbound→HX-out 第二跳）
    assert.equal(bankRows[0].FundType, 'HX-out', '跨轮叠加链：R3.5→R4 最终为 HX-out');
    assert.equal(bankRows[0].ReconciliationId, 'DISP-RECON-1', 'ReconciliationId 保持（未被调拨命中重写）');

    // R3.5 产 Charge→outbound（_round=R3.5）；R4 产 outbound→HX-out（_round=R4）
    const ftMods = result.modifications.filter((m) => m.rowId === 'b1' && m.column === 'FundType');
    const r35Ft = ftMods.find((m) => m._round === 'R3.5');
    const r4Ft = ftMods.find((m) => m._round === 'R4');
    assert.ok(r35Ft, 'R3.5 应产 FundType modification');
    assert.equal(r35Ft.oldValue, 'Charge');
    assert.equal(r35Ft.newValue, 'outbound', 'R3.5 步骤2：Charge→outbound');
    assert.ok(r4Ft, 'R4 应产 FundType modification');
    assert.equal(r4Ft.oldValue, 'outbound', 'R4 续改的旧值 = R3.5 改后的 outbound（证明 R3.5 先于 R4）');
    assert.equal(r4Ft.newValue, 'HX-out', 'R4：outbound→HX-out');

    // R3.5 b1 未被调拨命中 → 不写 ReconciliationId；仅步骤2 改 1 条 FundType
    assert.ok(!result.modifications.some((m) => m._round === 'R3.5' && m.column === 'ReconciliationId'),
      'R3.5 b1 未被调拨命中 → 不重写 ReconciliationId');
    assert.equal(result.stats.dbsChargeChangedCount, 1, 'R3.5 仅改写 FundType（步骤2 一列）');
    assert.equal(result.rounds.r35.changed, 1);
    assert.equal(result.rounds.r4.changed, 1, 'R4 hx-out 改写 1 列');

    // 命中行标黄列含 FundType（跨 R3.5+R4 合并）
    const out = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(out._modifiedColumns.has('FundType'));

    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---- 5. 行数守恒（混合：命中 + 未命中 + 非 DBS 渠道行）---------------------

test.describe('runReconciliation R3.5 —— 行数守恒（混合行）', () => {
  test('命中行 + 未命中 DBS 行 + 非 DBS 行 → modifiedRows + unmatchedRows === bankRows.length', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', Channel: 'DBS', FundType: 'Charge', ReconciliationId: '', 'Debit Amount': 100 }), // 命中
      makeBankRow({ _rowId: 'b2', Channel: 'DBS', FundType: 'Charge', ReconciliationId: '', 'Debit Amount': 777 }), // DBS 但金额不匹配 → 未命中
      makeBankRow({ _rowId: 'b3', Channel: 'CITI', FundType: 'Charge', ReconciliationId: '', 'Debit Amount': 100 })  // 非 DBS → 门控外
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'DISP-RECON-1', amount: 100, currency: 'USD' })],
      scenarios: [makeDbsChargeScenario()],
      dispatchReconContext: { dispatchReconRows: [makeDispRow({ ReconID: 'DISP-RECON-1', 金额: 100 })] }
    });

    // b1 命中改写；b2/b3 不改
    assert.equal(bankRows[0].ReconciliationId, 'DISP-RECON-1');
    assert.equal(bankRows[1].ReconciliationId, '', 'b2 金额不匹配未命中');
    assert.equal(bankRows[2].FundType, 'Charge', 'b3 非 DBS 渠道不参与');
    // 行数守恒（全覆盖、互斥）
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
    assert.equal(bankRows.length, 3);
  });
});

// ---- 6. R5 关闭时，R3.5 调拨副本仍进入独立只读 M2M 审计 ------------------

test.describe('runReconciliation R3.5 —— 独立调拨 M2M 审计 context', () => {
  test('R5 关闭、R3.5 开启、N=7 的 2×2：R3.5 正常改写，R5 零改写，实际修改行均进入调拨审计且行数守恒', async () => {
    const bankRows = [
      makeBankRow({
        _rowId: 'm2m-b1',
        FundType: 'Charge',
        ReconciliationId: '',
        'Debit Amount': 100,
        BillDate: '2026-06-08'
      }),
      makeBankRow({
        _rowId: 'm2m-b2',
        FundType: 'Charge',
        ReconciliationId: '',
        'Debit Amount': 100,
        BillDate: '2026-06-08'
      })
    ];
    const dispatchRows = [
      makeDispRow({ ReconID: 'M2M-DISP-1', 金额: 100, BillDate: '2026-06-01' }),
      makeDispRow({ ReconID: 'M2M-DISP-2', 金额: 100, BillDate: '2026-06-01' })
    ];
    const dispatchRowsBefore = structuredClone(dispatchRows);

    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      // 只有 R3.5 场景，明确表示 R5s2 关闭。
      scenarios: [makeDbsChargeScenario()],
      dispatchReconContext: { dispatchReconRows: dispatchRows },
      // R5 写入 context 保持空；审计数据只能从独立只读 context 获取。
      fundTransferReconContext: { reconRows: [] },
      fundTransferAuditContext: { reconRows: dispatchRows },
      // 银行日与调拨日相差 7 天：若静默回退默认 N=1，R3.5 和 M2M 都无法命中。
      fundTransferDatePolicy: {
        enabled: true,
        toleranceDays: 7,
        ownerScenarioId: 999,
        signature: 'test-r35-m2m-n7'
      }
    });

    assert.deepEqual(
      bankRows.map((row) => row.ReconciliationId).sort(),
      ['M2M-DISP-1', 'M2M-DISP-2'],
      'R3.5 应按 N=7 完成两条 1:1 调拨匹配'
    );
    assert.ok(
      bankRows.every((row) => row.FundType === 'FundTransfer-out'),
      'R3.5 两条实际修改行均应改为 FundTransfer-out'
    );
    assert.equal(result.stats.dbsChargeChangedCount, 4, 'R3.5 两行各改 ReconciliationId + FundType');

    assert.equal(result.stats.r5s2BackfilledCount, 0, 'R5 场景关闭，R5s2 必须零改写');
    assert.equal(result.rounds.r5s2.backfilled, 0, 'R5 轮次统计保持 0');
    assert.ok(
      result.modifications.every((mod) => mod._round === 'R3.5'),
      '独立审计数组不得进入 R5 写入路径'
    );

    assert.deepEqual(
      result.manyToManyReviewRows.map((entry) => entry.row._rowId),
      ['m2m-b1', 'm2m-b2'],
      '两条实际修改银行行都应进入调拨多对多审计'
    );
    assert.ok(
      result.manyToManyReviewRows.every((entry) => (
        entry.note.includes('银行↔调拨多对多')
        && entry.note.includes('银行 2 行 × 调拨 2 行')
      )),
      '每条审计说明应明确记录 2×2 调拨多对多关系'
    );
    assert.equal(result.stats.manyToManyReviewCount, 2);

    assert.deepEqual(dispatchRows, dispatchRowsBefore, '独立审计与 R3.5 均不得修改调拨源行');
    assert.equal(result.modifiedRows.length, 2);
    assert.equal(result.unmatchedRows.length, 0);
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      bankRows.length,
      'modifiedRows + unmatchedRows 必须保持输入行数守恒'
    );
  });

  test('未提供独立审计 context 时，兼容回退 fundTransferReconContext.reconRows', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'fallback-b1', 'Debit Amount': 100 }),
      makeBankRow({ _rowId: 'fallback-b2', 'Debit Amount': 100 })
    ];
    const dispatchRows = [
      makeDispRow({ ReconID: 'FALLBACK-DISP-1' }),
      makeDispRow({ ReconID: 'FALLBACK-DISP-2' })
    ];

    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeDbsChargeScenario()],
      dispatchReconContext: { dispatchReconRows: dispatchRows },
      fundTransferReconContext: { reconRows: dispatchRows }
      // 不传 fundTransferAuditContext，锁定旧调用兼容回退。
    });

    assert.deepEqual(
      result.manyToManyReviewRows.map((entry) => entry.row._rowId),
      ['fallback-b1', 'fallback-b2']
    );
    assert.equal(result.stats.manyToManyReviewCount, 2);
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});
