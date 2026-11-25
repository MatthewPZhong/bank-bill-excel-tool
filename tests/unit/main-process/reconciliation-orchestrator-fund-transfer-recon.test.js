// v3.0.6 需求2「R5s2 数据来源二选一（中台调拨单表 / 网关）」编排器接线单测（node:test，合成数据）
// 目标文件：src/main-process/reconciliation-orchestrator.js（R5s2 二选一 gating 落点）
// plan「需求2」/ 资金红线 review 点 7。
//
// ⚠️ 范围边界：只测【编排器二选一 gating / context 注入管道 / _round 标记 / 行数守恒 / 取消路 parity】，
//   不重测引擎匹配矩阵（那是 r5-fund-transfer-recon-backfill / r5-fund-transfer-backfill 引擎单测职责）。
//
// 覆盖：
//   1. 勾选（reconSourceMid 缺省/true）→ 走新引擎，fundTransferReconContext.reconRows 命中 →
//      ReconciliationId 回填进 modifiedRows、_round='R5s2-recon'、stats.r5s2BackfilledCount=1
//   2. 取消（reconSourceMid:false）→ 走旧网关 runRound5FundTransferBackfill，与现状一致（_round='R5s2'，parity）
//   3. 行数守恒：modifiedRows + unmatchedRows === bankRows.length

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation
} = require('../../../src/main-process/reconciliation-orchestrator');

// ---- 合成数据 ----------------------------------------------------------

// 银行行（含 R5s2 / R5s2b 所需列；默认 FundTransfer-in、MerchantId/Currency/金额/日期对齐下方 recon/gw/mid）
function makeBankRow(o = {}) {
  return {
    _rowId: o._rowId,
    ReconciliationId: o.ReconciliationId ?? '',
    FundType: o.FundType ?? 'FundTransfer-in',
    MerchantId: o.MerchantId ?? '202782001',
    地区: o['地区'] ?? 'LU',
    Currency: o.Currency ?? 'USD',
    'Credit Amount': o['Credit Amount'] ?? '',
    'Debit Amount': o['Debit Amount'] ?? '',
    'Extra Fee': o['Extra Fee'] ?? '',
    BillDate: o.BillDate ?? '2026-05-26',
    'Drawee CardNo': o['Drawee CardNo'] ?? 'PAY-CARD-1'
  };
}

// 调拨对账单派生行（linked_fund_transfer_recon；字段名 = FT_RECON_FIELD_MAP.recon 真实列）
//   big_account ↔ MerchantId、币种 ↔ Currency、金额（绝对值精确到分）、BillDate、ReconID（回填来源）、fund_type 方向
function makeReconRow(o = {}) {
  return {
    调拨单号: o['调拨单号'] ?? 'FTA-1',
    BillDate: o.BillDate ?? '2026-05-26',
    ReconID: o.ReconID ?? 'RECON-MID',
    付款方式: o['付款方式'] ?? '线上',
    付款账号: o['付款账号'] ?? 'PAY-CARD-1',
    收款账号: o['收款账号'] ?? '202782001',
    付款渠道: o['付款渠道'] ?? '',
    收款渠道: o['收款渠道'] ?? 'CITI',
    big_account: o.big_account ?? '202782001',
    币种: o['币种'] ?? 'USD',
    金额: o['金额'] ?? 100,
    fund_type: o.fund_type ?? 'FundTransfer-in',
    是否被使用: o['是否被使用'] ?? ''
  };
}

// 网关行（gateway-bill 真实表头，小写）：取消路 / R5s2b 互斥测试用
function makeGwRow(o = {}) {
  return {
    TradeType: o.TradeType ?? 'FundTransfer-in',
    merchantid: o.merchantid ?? '202782001',
    currency: o.currency ?? 'USD',
    amount: o.amount ?? 100,
    Billdate: o.Billdate ?? '2026-05-26',
    reconciliationid: o.reconciliationid ?? 'GW-RECON'
  };
}

// R5s2 场景（fund-transfer-backfill）；reconSourceMid 控制二选一，paymentOfflineBackfill 挂 R5s2b
function makeR5s2Scenario({ reconSourceMid, paymentOfflineBackfill } = {}) {
  const config = {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateToleranceDays: 1
  };
  if (reconSourceMid !== undefined) config.reconSourceMid = reconSourceMid;
  if (paymentOfflineBackfill) config.paymentOfflineBackfill = paymentOfflineBackfill;
  return { id: 502, name: '中台调拨订单对账ID回填', category: 'builtin-fixed', priority: 0, enabled: true, config };
}

// ---- 1. 勾选路（默认 / true）→ 走新引擎，命中回填 ----------------------

test.describe('runReconciliation R5s2 二选一 —— 勾选路（reconSourceMid 缺省/true → 调拨对账单回填）', () => {
  test('reconSourceMid 缺省（默认勾选）→ 新引擎命中 → ReconciliationId 回填、_round=R5s2-recon', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-SHOULD-NOT-WIN' })], // 取消路才会用；勾选路不读 gw
      scenarios: [makeR5s2Scenario()], // 不设 reconSourceMid → 缺省默认勾选
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID', '勾选路回填来源=调拨对账单 ReconID（非网关）');
    assert.equal(result.stats.r5s2BackfilledCount, 1, 'stats.r5s2BackfilledCount=1');
    assert.ok(result.modifiedRows.some((r) => r._rowId === 'b1'), 'b1 进 modifiedRows');
    const mod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    assert.ok(mod, '应产 ReconciliationId modification');
    assert.equal(mod._round, 'R5s2-recon', '勾选路 modification 标 _round=R5s2-recon');
    assert.equal(mod.newValue, 'RECON-MID');
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('reconSourceMid:true（显式勾选）→ 同上走新引擎', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID' })] }
    });
    assert.equal(bankRows[0].ReconciliationId, 'RECON-MID');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.ok(result.modifications.some((m) => m._round === 'R5s2-recon'));
    assert.ok(!result.modifications.some((m) => m._round === 'R5s2'), '勾选路不产 _round=R5s2（旧网关路）');
  });

  test('v3.0.26 勾选路按含 Extra Fee 的银行金额匹配', async () => {
    const bankRows = [makeBankRow({
      _rowId: 'fee-recon',
      'Credit Amount': 100,
      'Extra Fee': 5
    })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: {
        reconRows: [makeReconRow({ 金额: 105, ReconID: 'RECON-WITH-FEE' })]
      }
    });

    assert.equal(bankRows[0].ReconciliationId, 'RECON-WITH-FEE');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.ok(result.modifications.some((m) => m._round === 'R5s2-recon'));
  });

  test('勾选路 fundTransferReconContext 缺省 → 新引擎空入参 no-op、不抛、行数守恒', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5s2Scenario({ reconSourceMid: true })]
        // 不传 fundTransferReconContext
      });
    });
    assert.equal(result.stats.r5s2BackfilledCount, 0, '空 reconRows → 0 回填');
    assert.equal(bankRows[0].ReconciliationId, '');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---- 2. 取消路（reconSourceMid:false）→ 旧网关引擎 parity ----------------

test.describe('runReconciliation R5s2 二选一 —— 取消路（reconSourceMid:false → 网关回填，现状 parity）', () => {
  test('reconSourceMid:false → 走旧网关 runRound5FundTransferBackfill、_round=R5s2、来源=网关', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ reconciliationid: 'GW-RECON' })],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      // 即便注入了调拨对账单，取消路也不读它（断言来源仍是网关）
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'RECON-MID-IGNORED' })] }
    });

    assert.equal(bankRows[0].ReconciliationId, 'GW-RECON', '取消路回填来源=网关 reconciliationid（非调拨对账单）');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    const mod = result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    assert.ok(mod, '应产 ReconciliationId modification');
    assert.equal(mod._round, 'R5s2', '取消路 modification 标 _round=R5s2（现状不变）');
    assert.equal(mod.newValue, 'GW-RECON');
    assert.ok(!result.modifications.some((m) => m._round === 'R5s2-recon'), '取消路不产 _round=R5s2-recon');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });

  test('reconSourceMid:false + 空网关 → no-op（现状一致）', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferReconContext: { reconRows: [makeReconRow()] }
    });
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.equal(bankRows[0].ReconciliationId, '');
  });

  test('v3.0.26 取消路按含 Extra Fee 的银行金额匹配', async () => {
    const bankRows = [makeBankRow({
      _rowId: 'fee-gateway',
      'Credit Amount': 100,
      'Extra Fee': -5
    })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [makeGwRow({ amount: 95, reconciliationid: 'GW-WITH-FEE' })],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })]
    });

    assert.equal(bankRows[0].ReconciliationId, 'GW-WITH-FEE');
    assert.equal(result.stats.r5s2BackfilledCount, 1);
    assert.ok(result.modifications.some((m) => m._round === 'R5s2'));
  });
});

test.describe('v3.1.1 resolved policy 接线（两来源共用，配置失败关闭）', () => {
  test('日期关闭时调拨来源跨期仍可匹配；启用 ±1 时同一输入不匹配', async () => {
    const disabledBankRows = [makeBankRow({
      _rowId: 'date-disabled',
      'Credit Amount': 100,
      BillDate: '2026-06-20'
    })];
    const disabled = await runReconciliation({
      bankRows: disabledBankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: {
        reconRows: [makeReconRow({ BillDate: '2026-05-26', ReconID: 'DATE-DISABLED-HIT' })]
      },
      fundTransferDatePolicy: {
        enabled: false,
        toleranceDays: 1,
        ownerScenarioId: 502,
        signature: 'date-disabled'
      }
    });
    assert.equal(disabledBankRows[0].ReconciliationId, 'DATE-DISABLED-HIT');
    assert.equal(disabled.stats.r5s2BackfilledCount, 1);
    assert.equal(disabled.modifiedRows.length + disabled.unmatchedRows.length, disabledBankRows.length);

    const enabledBankRows = [makeBankRow({
      _rowId: 'date-enabled',
      'Credit Amount': 100,
      BillDate: '2026-06-20'
    })];
    const enabled = await runReconciliation({
      bankRows: enabledBankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: {
        reconRows: [makeReconRow({ BillDate: '2026-05-26', ReconID: 'OUTSIDE-WINDOW' })]
      },
      fundTransferDatePolicy: {
        enabled: true,
        toleranceDays: 1,
        ownerScenarioId: 502,
        signature: 'date-enabled'
      }
    });
    assert.equal(enabledBankRows[0].ReconciliationId, '');
    assert.equal(enabled.stats.r5s2BackfilledCount, 0);
    assert.ok(enabled.errorReport.some((warning) => warning.code === 'fund-transfer-date-mismatch'));
    assert.equal(enabled.modifiedRows.length + enabled.unmatchedRows.length, enabledBankRows.length);

    const partialPolicyBankRows = [makeBankRow({
      _rowId: 'date-policy-missing-enabled',
      'Credit Amount': 100,
      BillDate: '2026-06-20'
    })];
    const partialPolicy = await runReconciliation({
      bankRows: partialPolicyBankRows,
      gwRows: [],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: {
        reconRows: [makeReconRow({ BillDate: '2026-05-26', ReconID: 'MUST-NOT-DISABLE-DATE' })]
      },
      fundTransferDatePolicy: {
        toleranceDays: 1,
        ownerScenarioId: 502,
        signature: 'missing-enabled'
      }
    });
    assert.equal(
      partialPolicyBankRows[0].ReconciliationId,
      '',
      '部分 policy 缺少 enabled 时必须按安全默认启用日期，不能静默放宽成关闭'
    );
    assert.equal(partialPolicy.stats.r5s2BackfilledCount, 0);
  });

  test('调拨来源 directions 缺项时整轮失败关闭，不产生消费或改写', async () => {
    const scenario = makeR5s2Scenario({ reconSourceMid: true });
    scenario.config.directions = [scenario.config.directions[0]];
    const bankRows = [makeBankRow({ _rowId: 'invalid-directions', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [scenario],
      fundTransferReconContext: { reconRows: [makeReconRow({ ReconID: 'MUST-NOT-WRITE' })] },
      fundTransferDatePolicy: {
        enabled: false,
        toleranceDays: 1,
        ownerScenarioId: 502,
        signature: 'invalid-directions'
      }
    });

    assert.equal(bankRows[0].ReconciliationId, '');
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.equal(result.modifications.length, 0);
    assert.equal(
      result.errorReport.filter((warning) => warning.code === 'r5-fund-transfer-directions-invalid').length,
      1
    );
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---- v3.2.22：账户映射透传（网关来源生效、调拨来源不重复映射）-------------------

test.describe('runReconciliation R5s2 —— v3.2.22 fundTransferAccountMappingMap 透传', () => {
  const mapping = () => new Map([['GW-ACC-1', '202782001']]);
  // 映射目标账号上的网关行须与银行行同渠道（两侧非空）才可配对。
  const jpmBank = (o) => ({ ...makeBankRow(o), Channel: 'JPM' });
  const jpmGw = (o) => ({ ...makeGwRow(o), Channel: 'JPM' });

  test('取消路（网关来源）：网关账户号经映射对上银行 MerchantId → 回填、_round=R5s2；不传映射则不命中', async () => {
    const run = (fundTransferAccountMappingMap) => {
      const bankRows = [jpmBank({ _rowId: 'b1', 'Credit Amount': 100 })];
      return runReconciliation({
        bankRows,
        gwRows: [jpmGw({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-RECON-MAPPED' })],
        scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
        fundTransferAccountMappingMap
      }).then((result) => ({ result, bankRows }));
    };

    const unmapped = await run(undefined);
    assert.equal(unmapped.bankRows[0].ReconciliationId, '', '未传映射：账号不同不回填');
    assert.equal(unmapped.result.stats.r5s2BackfilledCount, 0);

    const mapped = await run(mapping());
    assert.equal(mapped.bankRows[0].ReconciliationId, 'GW-RECON-MAPPED');
    const mod = mapped.result.modifications.find((m) => m.rowId === 'b1' && m.column === 'ReconciliationId');
    assert.equal(mod && mod._round, 'R5s2');
    assert.equal(mapped.result.modifiedRows.length + mapped.result.unmatchedRows.length, 1);
  });

  test('取消路：R5s2 引擎以当时的银行行与按方向映射目标读取池外诊断行，只产生缺渠道告警、不回填；勾选路不读取', async () => {
    const run = (reconSourceMid) => {
      const bankRows = [jpmBank({ _rowId: 'b1', 'Credit Amount': 100 })];
      const sourceCalls = [];
      return runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5s2Scenario({ reconSourceMid })],
        fundTransferReconContext: { reconRows: [] },
        fundTransferAccountMappingMap: mapping(),
        fundTransferChannelMissingDiagnosticSource: (context) => {
          sourceCalls.push(context);
          return [{ ...makeGwRow({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-BLANK' }), Channel: '' }];
        }
      }).then((result) => ({ result, bankRows, sourceCalls }));
    };
    const missingOf = (result) => result.errorReport.filter((w) => w.code === 'r5-mapped-account-channel-missing');

    const gateway = await run(false);
    assert.equal(gateway.sourceCalls.length, 1);
    assert.strictEqual(gateway.sourceCalls[0].bankRows, gateway.bankRows, '传入 R5 当时的银行行');
    assert.ok(gateway.sourceCalls[0].targetAccountsByTradeType instanceof Map, '传入按方向的映射目标账号');
    assert.deepEqual([...gateway.sourceCalls[0].targetAccountsByTradeType.keys()].sort(), ['FundTransfer-in', 'FundTransfer-out']);
    assert.equal(gateway.bankRows[0].ReconciliationId, '');
    assert.equal(gateway.result.stats.r5s2BackfilledCount, 0);
    assert.deepEqual(missingOf(gateway.result).map((w) => w.rowId), ['b1']);

    const recon = await run(true);
    assert.equal(recon.sourceCalls.length, 0, '调拨来源不读取网关诊断行');
    assert.equal(missingOf(recon.result).length, 0);
  });

  test('取消路：方向配置非法时不读取池外诊断行，只返回方向配置告警', async () => {
    const scenario = makeR5s2Scenario({ reconSourceMid: false });
    scenario.config.directions = [{ gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-in' }];
    const bankRows = [jpmBank({ _rowId: 'b1', 'Credit Amount': 100 })];
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      scenarios: [scenario],
      fundTransferReconContext: { reconRows: [] },
      fundTransferAccountMappingMap: mapping(),
      fundTransferChannelMissingDiagnosticSource: () => { throw new Error('不应读取'); }
    });
    assert.ok(result.errorReport.some((w) => w.code === 'r5-fund-transfer-directions-invalid'), '返回方向配置告警');
    assert.equal(result.stats.r5s2BackfilledCount, 0);
  });

  test('勾选路（调拨来源）：映射不再作用于已派生的 big_account，结果与不传映射一致', async () => {
    const run = (fundTransferAccountMappingMap) => {
      const bankRows = [jpmBank({ _rowId: 'b1', MerchantId: 'GW-ACC-1', 'Credit Amount': 100 })];
      return runReconciliation({
        bankRows,
        gwRows: [],
        scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
        fundTransferReconContext: { reconRows: [makeReconRow({ big_account: 'GW-ACC-1', ReconID: 'RECON-MID' })] },
        fundTransferAccountMappingMap
      }).then((result) => ({ modifications: result.modifications, bankRows }));
    };
    const baseline = await run(undefined);
    assert.equal(baseline.bankRows[0].ReconciliationId, 'RECON-MID');
    assert.deepEqual(await run(mapping()), baseline);
  });

  test('取消路：多对多检测器网关侧用同一映射（2 银行 × 2 网关映射后同账号 → 异常说明命中）', async () => {
    const bankRows = [
      jpmBank({ _rowId: 'b1', 'Credit Amount': 100 }),
      jpmBank({ _rowId: 'b2', 'Credit Amount': 100 })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [
        jpmGw({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-1' }),
        jpmGw({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-2' })
      ],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferAccountMappingMap: mapping()
    });
    assert.deepEqual(bankRows.map((r) => r.ReconciliationId), ['GW-1', 'GW-2']);
    assert.deepEqual(result.manyToManyReviewRows.map((r) => r.row._rowId), ['b1', 'b2']);
    assert.ok(result.manyToManyReviewRows.every((r) => /^银行↔网关（账户映射后）多对多/.test(r.note)));
  });

  test('勾选路（调拨来源）：检测器网关侧不按映射补跑，只保留原账号与调拨侧口径', async () => {
    const bankRows = [
      jpmBank({ _rowId: 'b1', 'Credit Amount': 100 }),
      jpmBank({ _rowId: 'b2', 'Credit Amount': 100 })
    ];
    const result = await runReconciliation({
      bankRows,
      gwRows: [
        jpmGw({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-1' }),
        jpmGw({ merchantid: 'GW-ACC-1', reconciliationid: 'GW-2' })
      ],
      scenarios: [makeR5s2Scenario({ reconSourceMid: true })],
      fundTransferReconContext: {
        reconRows: [makeReconRow({ ReconID: 'RECON-1' }), makeReconRow({ ReconID: 'RECON-2' })]
      },
      fundTransferAccountMappingMap: mapping()
    });
    assert.deepEqual(bankRows.map((r) => r.ReconciliationId), ['RECON-1', 'RECON-2']);
    assert.deepEqual(result.manyToManyReviewRows.map((r) => r.row._rowId), ['b1', 'b2']);
    assert.ok(result.manyToManyReviewRows.every((r) => /银行↔调拨多对多/.test(r.note) && !/账户映射后/.test(r.note)));
  });

  test('R4 按原账号改值的多对多说明保留；R5s2 方向配置非法时不按映射补跑', async () => {
    const r4AchReturn = {
      id: 401, name: 'R4-Ach Return', category: 'builtin-fixed', priority: 3, enabled: true,
      config: { funcCategory: 'fund-nature-check', subCategory: 'ach-return', priority: 3 }
    };
    const run = async (directions) => {
      const scenario = makeR5s2Scenario({ reconSourceMid: false });
      scenario.config.directions = directions;
      const bankRows = ['R-1', 'R-2'].map((rid, i) => jpmBank({
        _rowId: `b${i + 1}`, ReconciliationId: rid, FundType: '', MerchantId: 'CLR', 'Debit Amount': 100
      }));
      const gwRows = [
        jpmGw({ TradeType: 'AchReturn', merchantid: 'CLR', reconciliationid: 'R-1' }),
        jpmGw({ TradeType: 'AchReturn', merchantid: 'CLR', reconciliationid: 'R-2' }),
        jpmGw({ TradeType: 'FundTransfer-out', merchantid: 'ALIAS', reconciliationid: 'FT-1' }),
        jpmGw({ TradeType: 'FundTransfer-out', merchantid: 'ALIAS', reconciliationid: 'FT-2' })
      ];
      const result = await runReconciliation({
        bankRows,
        gwRows,
        scenarios: [r4AchReturn, scenario],
        fundTransferAccountMappingMap: new Map([['ALIAS', 'CLR']])
      });
      assert.deepEqual(bankRows.map((r) => r.FundType), ['Ach Return', 'Ach Return'], 'R4 按原账号改值');
      return result.manyToManyReviewRows.map((r) => r.note);
    };

    const valid = await run(makeR5s2Scenario().config.directions);
    assert.equal(valid.length, 2);
    assert.ok(valid.every((n) => /^银行↔网关多对多/.test(n)), '原账号审计保留');
    assert.ok(valid.every((n) => /网关（账户映射后）/.test(n)), 'R5s2 网关来源有效时补跑映射后账号');

    const invalid = await run([]);
    assert.equal(invalid.length, 2);
    assert.ok(invalid.every((n) => /^银行↔网关多对多/.test(n) && !/账户映射后/.test(n)), '方向非法整轮跳过 → 不补跑');
  });

  test('密集映射争用（800 网关 × 400 银行）整轮正常完成，争用告警线性', async () => {
    const bankRows = [];
    for (let i = 0; i < 400; i += 1) bankRows.push(jpmBank({ _rowId: `b${i}`, MerchantId: 'CLR', 'Credit Amount': 100 }));
    const gwRows = [];
    for (let i = 0; i < 800; i += 1) {
      gwRows.push(jpmGw({ merchantid: i % 2 === 0 ? 'ALIAS' : 'CLR', reconciliationid: `GW-${i}` }));
    }
    const result = await runReconciliation({
      bankRows,
      gwRows,
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferAccountMappingMap: new Map([['ALIAS', 'CLR']])
    });
    assert.equal(result.stats.r5s2BackfilledCount, 400);
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, 400);
    const contentionCount = result.errorReport.filter((r) => r.code === 'r5-mapped-account-contention').length;
    assert.ok(contentionCount > 0 && contentionCount <= 400, `争用告警按未回填网关行计（实际 ${contentionCount}）`);
  });

  test('非 Map 映射入参按不映射处理（不崩）', async () => {
    const bankRows = [jpmBank({ _rowId: 'b1', 'Credit Amount': 100 })];
    await runReconciliation({
      bankRows,
      gwRows: [jpmGw({ merchantid: 'GW-ACC-1' })],
      scenarios: [makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferAccountMappingMap: { 'GW-ACC-1': '202782001' }
    });
    assert.equal(bankRows[0].ReconciliationId, '');
  });

  // v3.2.22（🔴 资金红线）：C3 在 R2 改写银行 MerchantId。按网关字段赋值时值来自链接表单元格原文（流式导入保留 `_xHHHH_`），
  //   含这种写法且文字是映射目标时 R5s2 无法确认真实账号 → 不回填并告警；自定义值是配置文字（已解码）→ 照常回填。
  const c3AssignMerchantId = (assign) => ({
    id: 301, name: 'C3 改写账号', category: 'gateway-recon-join', priority: 1, enabled: true,
    config: { reconFields: [{ seq: 1, gwField: 'OrderId', bankField: 'OrderId' }], assign: { bankField: 'MerchantId', ...assign } }
  });
  const runC3ThenR5s2 = (assign, account = 'A_x0041_B') => {
    const bankRows = [{ ...jpmBank({ _rowId: 'b1', MerchantId: 'ORIG', 'Credit Amount': 100 }), OrderId: 'O1' }];
    return runReconciliation({
      bankRows,
      gwRows: [jpmGw({ merchantid: 'ALIAS', reconciliationid: 'GW-R' })],
      c3GwRows: [{ OrderId: 'O1', Acct: account }],
      scenarios: [c3AssignMerchantId(assign), makeR5s2Scenario({ reconSourceMid: false })],
      fundTransferAccountMappingMap: new Map([['ALIAS', account]])
    }).then((result) => ({ result, bankRows }));
  };

  test('🔴 C3 按网关字段把 MerchantId 改写成数值写法（链接表按数值存放的长账号）、与映射目标对得上 → R5s2 不回填并告警', async () => {
    // 网关表单元格 <v>9007199254740993</v> 按数值读入落库为 '9007199254740992'，C3 原样写进银行 MerchantId。
    const { result, bankRows } = await runC3ThenR5s2({ gwField: 'Acct', mode: 'direct' }, '9007199254740992');
    assert.equal(bankRows[0].MerchantId, '9007199254740992', 'C3 已改写');
    assert.equal(bankRows[0].ReconciliationId, '', '🔴 改写值可能是舍入后的另一账号，不按映射目标回填');
    const warned = result.errorReport.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b1']);
    assert.match(warned[0].message, /被前序场景按链接表原文改写/);
    // 自定义值是配置文字，原文可信：同样的文字照常回填。
    const custom = await runC3ThenR5s2({ gwField: '__CUSTOM__', mode: 'custom', customValue: '9007199254740992' }, '9007199254740992');
    assert.equal(custom.bankRows[0].ReconciliationId, 'GW-R');
    assert.deepEqual(custom.result.errorReport.filter((w) => w.code === 'r5-mapped-account-bank-precision-ambiguous'), []);
  });

  test('🔴 C3 按网关字段把 MerchantId 改写成含转义写法的原文、文字是映射目标 → R5s2 不回填并告警', async () => {
    const { result, bankRows } = await runC3ThenR5s2({ gwField: 'Acct', mode: 'direct' });
    assert.equal(bankRows[0].MerchantId, 'A_x0041_B', 'C3 已改写');
    assert.equal(bankRows[0].ReconciliationId, '', '🔴 原文 A_x0041_B 可能代表 AAB，不按映射目标回填');
    const warned = result.errorReport.filter((w) => w.code === 'r5-mapped-account-bank-escape-ambiguous');
    assert.deepEqual(warned.map((w) => w.rowId), ['b1']);
    const row = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(row._modifiedColumns.has('MerchantId'));
    assert.equal(row._decodedModifiedColumns, undefined, '链接表原文改写：不标已解码');
    assert.equal(result.modifications.find((m) => m.column === 'MerchantId')._valueDecoded, undefined);
  });

  test('C3 自定义值把 MerchantId 改成同样文字（已解码配置文字）→ R5s2 照常按映射回填，导出按已解码文本', async () => {
    const { result, bankRows } = await runC3ThenR5s2({ gwField: '__CUSTOM__', mode: 'custom', customValue: 'A_x0041_B' });
    assert.equal(bankRows[0].MerchantId, 'A_x0041_B');
    assert.equal(bankRows[0].ReconciliationId, 'GW-R');
    assert.deepEqual(result.errorReport.filter((w) => w.code === 'r5-mapped-account-bank-escape-ambiguous'), []);
    const row = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.deepEqual(Array.from(row._decodedModifiedColumns), ['MerchantId'], 'R5s2 写的对账ID 仍是链接表原文');
    assert.equal(result.modifications.find((m) => m.column === 'MerchantId')._valueDecoded, true);
    assert.equal(result.modifications.find((m) => m.column === 'ReconciliationId')._valueDecoded, undefined);
  });

  test('告警逐条追加：单轮告警数超过函数参数上限也不抛错', async () => {
    // C3 自定义值为空 → 每条银行行一条 invalid-custom-value 告警。
    const bankRows = [];
    for (let i = 0; i < 130000; i += 1) bankRows.push({ _rowId: `b${i}`, OrderId: 'O1', MerchantId: 'M', ReconciliationId: '' });
    const result = await runReconciliation({
      bankRows,
      gwRows: [],
      c3GwRows: [{ OrderId: 'O1' }],
      scenarios: [c3AssignMerchantId({ gwField: '__CUSTOM__', mode: 'custom', customValue: '' })]
    });
    assert.equal(result.errorReport.filter((w) => w.code === 'invalid-custom-value').length, 130000);
  });
});
