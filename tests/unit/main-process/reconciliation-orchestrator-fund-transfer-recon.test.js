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
