// v2.1.16-beta.2：5 轮对账编排器单测（node:test，合成数据，不依赖真实 xlsx / DB）
// 目标文件：src/main-process/reconciliation-orchestrator.js
//
// 覆盖（对应任务 8 条断言）：
//   1. 全链路 R1→R5 跑通，返回结构完整
//   2. 行数守恒 modifiedRows + unmatchedRows === bankRows.length
//   3. R4 改写一个「R2 已命中」的行 FundType → 该行 _modifiedColumns 同含 R2 列 + FundType（跨轮合并），且仍带 R2 命中元数据
//   4. R5 场景2 回填 → 对应行 _modifiedColumns 含 ReconciliationId
//   5. R5 场景3 → platformCleanupRows 含预期剔除行
//   6. R2 零回归：单个普通 C2（无 funcCategory）落 R2，行为与直接调 dispatcher 一致（命中元数据在）
//   7. enablement 守卫：某 bucket 为空 → 该轮 no-op 不报错
//   8. bucketScenarios 分桶正确（单元测）
//
// 设计要点（让断言可控）：
//   - R2 用 C2 offset-bill-mark（reconFields=0 无条件赋值）写 'Transaction Description'='已对账'
//     → R2 改的列与 R4(FundType) / R5(ReconciliationId) 互不冲突，便于断言跨轮合并。
//   - deps 不传 → R2 走 dispatcher 单维 first-match-wins（legacy 路径不查 DB，纯内存）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runReconciliation,
  bucketScenarios,
  buildOutputRows,
  buildChannelRegionHits
} = require('../../../src/main-process/reconciliation-orchestrator');
const { runAllScenarios } = require('../../../src/main-process/scenario-dispatcher');
const { extractChannelRegionCombos } = require('../../../src/backend/database/channel-enum-repository');
const { CLEANUP_COPY_HEADERS } = require('../../../src/constants/platform-cleanup-template-fields');

// ---------------------------------------------------------------------------
// 合成数据工厂
// ---------------------------------------------------------------------------

// 银行行：驼峰字段。给齐 R1~R5 关联/比对需要的列。
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
    'Transaction Description': overrides['Transaction Description'] ?? '',
    // C2 命中用的标记字段
    BillTag: overrides.BillTag ?? '',
    // C2 reconFields≥1 配对键（锁定未改值 fixture 用；默认空不影响其它用例配对）
    PairKey: overrides.PairKey ?? '',
    // 剔除模板 C~O 拷贝校验用（给几个非空值便于断言拷贝）
    ValueDate: overrides.ValueDate ?? '2026-06-02',
    Channel: overrides.Channel ?? '工商',
    地区: overrides['地区'] ?? '上海',
    'Transaction Description2': undefined,
    'Extra Information': overrides['Extra Information'] ?? 'extra-x',
    'Payment Detail': overrides['Payment Detail'] ?? 'pay-x'
  };
}

// 网关行：真实小写表头（reconciliationid / TradeType / merchantid / currency / amount / Billdate / orderid）
function makeGwRow(overrides = {}) {
  return {
    reconciliationid: overrides.reconciliationid ?? '',
    TradeType: overrides.TradeType ?? '',
    merchantid: overrides.merchantid ?? 'M001',
    currency: overrides.currency ?? 'USD',
    amount: overrides.amount ?? '',
    Billdate: overrides.Billdate ?? '2026-06-01',
    orderid: overrides.orderid ?? ''
  };
}

// ---- 场景工厂 ----

// R2：C2 offset-bill-mark（reconFields=0 无条件赋值）—— 命中 BillTag 含 'OFFSET' 的行 → 写 Transaction Description='已对账'
function makeR2OffsetScenario({ id = 200 } = {}) {
  return {
    id,
    name: 'R2-冲销打标',
    category: 'offset-bill-mark',
    priority: 5,
    enabled: true,
    displayIndex: 1,
    config: {
      billTypes: [{ seq: 1, conditions: [{ field: 'BillTag', op: '包含', value: 'OFFSET' }] }],
      reconFields: [], // 衍生方案 A：无条件赋值
      markValue: { type: 1, field: 'Transaction Description', value: '已对账' }
    }
  };
}

// R2：C2 配对（reconFields≥1）「锁定双方但不改值」场景
//   leftType=1（BillTag 含 'L'）× rightType=2（BillTag 含 'R'），配对键 PairKey 相等。
//   markValue 写 rightType 行的 'Transaction Description'='已对账'。
//   当 rightRow 的该字段**已等于** '已对账' 时：c2 引擎配对成功后无条件 lock 双方
//   （c2-offset-bill-mark.js:221-222），但 oldValue===newValue → 不 record（同文件 :238）。
//   → 两行进 dispatcher.modifiedRows（锁定 + 带 _hitScenario* 元数据 + _modifiedColumns 空 Set），
//     但 modifications 为空 → 编排器最终导出分区不应把它们放进「命中场景」。
function makeR2PairLockNoChangeScenario({ id = 210 } = {}) {
  return {
    id,
    name: 'R2-配对锁定不改值',
    category: 'offset-bill-mark',
    priority: 5,
    enabled: true,
    displayIndex: 1,
    config: {
      billTypes: [
        { seq: 1, conditions: [{ field: 'BillTag', op: '包含', value: 'L' }] },
        { seq: 2, conditions: [{ field: 'BillTag', op: '包含', value: 'R' }] }
      ],
      // reconFields≥1 → 走笛卡尔配对路径（非衍生方案 A），配对成功即锁定双方
      reconFields: [{ seq: 1, leftType: 1, leftField: 'PairKey', rightType: 2, rightField: 'PairKey' }],
      markValue: { type: 2, field: 'Transaction Description', value: '已对账' }
    }
  };
}

// R4：v3.0.23 固定 Ach Return 场景（严格账号/币种/金额/方向匹配）。
function makeR4AchReturnScenario({ priority = 3 } = {}) {
  return {
    id: 401,
    name: 'R4-Ach Return',
    category: 'builtin-fixed',
    priority,
    enabled: true,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'ach-return',
      priority
    }
  };
}

// R4：v3.0.23 固定 HX-out 场景。
function makeR4HxOutScenario({ priority = 3 } = {}) {
  return {
    id: 402,
    name: 'R4-HX-out',
    category: 'builtin-fixed',
    priority,
    enabled: true,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'hx-out',
      priority,
      gwTradeType: 'HX_OUTBOUND',
      setFundType: 'HX-out'
    }
  };
}

// R5 场景2：FundTransfer 回填
function makeR5BackfillScenario() {
  return {
    id: 501,
    name: 'R5-中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      // v3.0.6 需求2：R5s2 数据来源二选一默认改「勾选=调拨对账单」（决策 D4）。本组用例验证的是**网关回填**
      //   mechanics（gwRows → b2），故显式 reconSourceMid:false 走取消路（旧网关引擎，行为逐字不变 / parity）。
      reconSourceMid: false,
      directions: [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
        { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
      ],
      dateToleranceDays: 1
    }
  };
}

// R5 场景3：Inbound-VA 剔除
function makeR5CleanupScenario() {
  return {
    id: 502,
    name: 'R5-中台加款单脏数据处理',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'platform-inbound-cleanup',
      gwTradeType: 'Inbound-VA',
      excludeFundType: 'Inbound'
    }
  };
}

// ---------------------------------------------------------------------------
// 断言 8：bucketScenarios 分桶正确（单元测）
// ---------------------------------------------------------------------------
test.describe('bucketScenarios 分桶', () => {
  test('builtin-fixed + funcCategory 正确落 R4 / R5s2 / R5s3；其余落 R2', async () => {
    const scenarios = [
      makeR2OffsetScenario(),                 // 普通 C2 → R2
      { id: 1, category: 'builtin-fixed', config: { extractByFeature: { enabled: true } } }, // 无 funcCategory builtin-fixed → R2
      { id: 2, category: 'extract-recon-id', config: {} },                                   // C1 → R2
      { id: 3, category: 'gateway-recon-join', config: {} },                                 // C3 → R2
      makeR4AchReturnScenario(),              // R4
      makeR4HxOutScenario(),                  // R4
      makeR5BackfillScenario(),              // R5s2
      makeR5CleanupScenario()                // R5s3
    ];
    const { r2, r4, r5s2, r5s3 } = bucketScenarios(scenarios);
    assert.equal(r2.length, 4, 'R2 应含普通 C2 + 无 funcCategory builtin-fixed + C1 + C3');
    assert.equal(r4.length, 2);
    assert.equal(r5s2.length, 1);
    assert.equal(r5s3.length, 1);
    assert.equal(r5s2[0].config.subCategory, 'fund-transfer-backfill');
    assert.equal(r5s3[0].config.subCategory, 'platform-inbound-cleanup');
  });

  test('platform-order 但缺 subCategory → 落 R2（不误入 R5）', async () => {
    const s = { id: 9, category: 'builtin-fixed', config: { funcCategory: 'platform-order' } };
    const { r2, r5s2, r5s3 } = bucketScenarios([s]);
    assert.equal(r2.length, 1);
    assert.equal(r5s2.length, 0);
    assert.equal(r5s3.length, 0);
  });

  test('空 / null 入参 → 四桶皆空，不抛错', async () => {
    for (const input of [[], null, undefined]) {
      const r = bucketScenarios(input);
      assert.equal(r.r2.length, 0);
      assert.equal(r.r4.length, 0);
      assert.equal(r.r5s2.length, 0);
      assert.equal(r.r5s3.length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// v3.0.7 需求A：stats.r5s3Enabled / r5s4Enabled —— 供 renderer 状态框判断是否显示该行
//   （启用即显示，含 0 条命中）。bucket 非空 ⟺ 对应 builtin 场景启用。🔴 纯只读标志位。
// ---------------------------------------------------------------------------
// R5 场景4（退款回填）最小启用场景：仅供 bucketScenarios 收纳 → r5s4Bucket 非空；不构造命中数据（不验回填值）。
function makeR5RefundEnabledScenario() {
  return {
    id: 504,
    name: '中台退款订单回填',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    config: { funcCategory: 'platform-order', subCategory: 'refund-order-backfill', roundPhase: 5 }
  };
}

test.describe('runReconciliation stats.r5s3Enabled / r5s4Enabled（需求A）', () => {
  test('两 bucket 皆空（无场景）→ r5s3Enabled / r5s4Enabled 均为 false', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Settlement' })];
    const result = await runReconciliation({ bankRows, gwRows: [], scenarios: [] });
    assert.equal(result.stats.r5s3Enabled, false, 'r5s3 bucket 空 → r5s3Enabled=false');
    assert.equal(result.stats.r5s4Enabled, false, 'r5s4 bucket 空 → r5s4Enabled=false');
  });

  test('仅启用 R5 场景3 → r5s3Enabled=true（即使 0 条命中也为 true）；r5s4Enabled=false', async () => {
    // b1 不构成 Inbound-VA 剔除命中 → r5s3CleanupCount 可能为 0，但场景已启用 → r5s3Enabled 必须 true。
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Settlement', MerchantId: 'M001' })];
    const result = await runReconciliation({ bankRows, gwRows: [], scenarios: [makeR5CleanupScenario()] });
    assert.equal(result.stats.r5s3Enabled, true, '场景3 启用 → r5s3Enabled=true（含 0 命中）');
    assert.equal(result.stats.r5s4Enabled, false, '场景4 未启用 → r5s4Enabled=false');
    assert.equal(typeof result.stats.r5s3CleanupCount, 'number', 'r5s3CleanupCount 仍为数字（命中计数）');
  });

  test('仅启用 R5 场景4 → r5s4Enabled=true（即使 0 条命中也为 true）；r5s3Enabled=false', async () => {
    // 不传 refundContext → 退款池空 → r5s4BackfilledCount=0，但场景已启用 → r5s4Enabled 必须 true。
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Ach Return', MerchantId: 'M001' })];
    const result = await runReconciliation({ bankRows, gwRows: [], scenarios: [makeR5RefundEnabledScenario()] });
    assert.equal(result.stats.r5s4Enabled, true, '场景4 启用 → r5s4Enabled=true（含 0 命中）');
    assert.equal(result.stats.r5s3Enabled, false, '场景3 未启用 → r5s3Enabled=false');
    assert.equal(result.stats.r5s4BackfilledCount, 0, '无 refundContext → 0 条回填（但 enabled 仍 true）');
  });

  test('两场景同时启用 → r5s3Enabled / r5s4Enabled 均为 true', async () => {
    const bankRows = [makeBankRow({ _rowId: 'b1', FundType: 'Settlement' })];
    const result = await runReconciliation({
      bankRows, gwRows: [],
      scenarios: [makeR5CleanupScenario(), makeR5RefundEnabledScenario()]
    });
    assert.equal(result.stats.r5s3Enabled, true);
    assert.equal(result.stats.r5s4Enabled, true);
  });
});

// ---------------------------------------------------------------------------
// 断言 1 / 2 / 3 / 4 / 5：全链路
// ---------------------------------------------------------------------------
test.describe('runReconciliation 全链路 R1→R5', () => {
  // 构造一份覆盖 R2/R4/R5s2/R5s3 的银行 + 网关数据。
  function buildFullScenarioData() {
    const bankRows = [
      // b1：R2 命中（BillTag 含 OFFSET）+ R4 严格 Ach Return 命中
      //     → 验断言 3「跨轮合并 _modifiedColumns = {Transaction Description, FundType}」
      makeBankRow({
        _rowId: 'b1', ReconciliationId: 'RC-CHG', FundType: 'Charge', BillTag: 'OFFSET-A',
        MerchantId: 'M001', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0
      }),
      // b2：R5 场景2 回填目标（FundType=FundTransfer-out，无 reconid，靠 merchant/currency/金额绝对值/同日 匹配网关）
      makeBankRow({
        _rowId: 'b2', ReconciliationId: '', FundType: 'FundTransfer-out',
        MerchantId: 'M002', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0, BillDate: '2026-06-10'
      }),
      // b3：R5 场景3 剔除目标（reconid=RC-INB，FundType≠Inbound → 产剔除行）
      makeBankRow({ _rowId: 'b3', ReconciliationId: 'RC-INB', FundType: 'Refund', MerchantId: 'M003' }),
      // b4：完全不命中任何轮（无 reconid、无 OFFSET、FundType 与任何方向无关）→ 入 unmatchedRows
      makeBankRow({ _rowId: 'b4', ReconciliationId: '', FundType: 'Settlement', BillTag: 'NORMAL' })
    ];

    const gwRows = [
      // g1：R4 按 AchReturn + 账号/币种/金额/方向严格命中 b1
      makeGwRow({ reconciliationid: 'RC-CHG', TradeType: 'AchReturn', merchantid: 'M001', currency: 'USD', amount: 100, orderid: 'ORD-CHG' }),
      // g2：FundTransfer-out，merchant/currency/金额绝对值/同日 与 b2 对上 → R5s2 回填 b2.ReconciliationId='RC-FT'
      makeGwRow({
        reconciliationid: 'RC-FT', TradeType: 'FundTransfer-out',
        merchantid: 'M002', currency: 'USD', amount: -100, Billdate: '2026-06-10'
      }),
      // g3：Inbound-VA，reconid=RC-INB → R5s3 命中 b3，b3.FundType=Refund≠Inbound → 产剔除行（orderid=ORD-INB）
      makeGwRow({ reconciliationid: 'RC-INB', TradeType: 'Inbound-VA', orderid: 'ORD-INB' })
    ];

    const scenarios = [
      makeR2OffsetScenario(),
      makeR4AchReturnScenario(),
      makeR5BackfillScenario(),
      makeR5CleanupScenario()
    ];
    return { bankRows, gwRows, scenarios };
  }

  test('断言1+2：返回结构完整 + 行数守恒', async () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const total = bankRows.length;
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    // 结构完整
    assert.ok(Array.isArray(result.modifiedRows), 'modifiedRows 数组');
    assert.ok(Array.isArray(result.unmatchedRows), 'unmatchedRows 数组');
    assert.ok(Array.isArray(result.modifications), 'modifications 数组');
    assert.ok(Array.isArray(result.errorReport), 'errorReport 数组');
    assert.ok(result.stats && typeof result.stats === 'object', 'stats 对象');
    assert.ok(Array.isArray(result.platformCleanupRows), 'platformCleanupRows 数组');
    assert.ok(result.rounds && typeof result.rounds === 'object', 'rounds 对象');

    // stats 分项存在
    // R1 匹配 2 条：RC-CHG（b1）+ RC-INB（b3）；b2 无 reconid、b4 无 reconid → 不参与 R1
    assert.equal(result.stats.r1Matched, 2, 'R1 匹配 2 条（RC-CHG + RC-INB；b2/b4 无 reconid 不参与）');
    assert.equal(typeof result.stats.r4ChangedCount, 'number');
    assert.equal(typeof result.stats.r5s2BackfilledCount, 'number');
    assert.equal(result.stats.r5s3CleanupCount, result.platformCleanupRows.length);

    // 行数守恒（🔴 不变量）
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      total,
      'modifiedRows + unmatchedRows === bankRows.length'
    );
    // self-review B：stats 顶层计数反映最终 5 轮结果（非 R2 作用域）——renderer 状态框 pr.hitRowCount 据此显示
    assert.equal(result.stats.totalRows, total, 'stats.totalRows = bankRows.length');
    assert.equal(result.stats.hitRowCount, result.modifiedRows.length, 'stats.hitRowCount = 最终 modifiedRows.length（含 R4/R5）');
    assert.equal(result.stats.unmatchedRowCount, result.unmatchedRows.length, 'stats.unmatchedRowCount = 最终 unmatchedRows.length');
    assert.equal(result.stats.warningCount, result.errorReport.length, 'stats.warningCount = 全轮 warnings 总数');
    // 互斥：同一 _rowId 不可能同时出现在两个集合
    const modIds = new Set(result.modifiedRows.map((r) => r._rowId));
    for (const u of result.unmatchedRows) {
      assert.ok(!modIds.has(u._rowId), `行 ${u._rowId} 不应同时在 modified 与 unmatched`);
    }
    // b4 完全不命中 → 进 unmatched
    assert.ok(result.unmatchedRows.some((r) => r._rowId === 'b4'), 'b4 应在 unmatchedRows');
  });

  test('断言3：R4 改写 R2 已命中行 FundType → _modifiedColumns 跨轮合并 + 仍带 R2 命中元数据', async () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    const b1 = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(b1, 'b1 应在 modifiedRows（既被 R2 命中又被 R4 改）');

    // FundType 被 R4 从 Charge 改成 Ach Return（当前最新值，非 dispatcher 过时浅拷贝）
    assert.equal(b1.FundType, 'Ach Return', 'b1.FundType 应为 R4 改写后的 Ach Return');
    // Transaction Description 被 R2 改成 '已对账'
    assert.equal(b1['Transaction Description'], '已对账', 'b1 Transaction Description 应为 R2 写入值');

    // _modifiedColumns 是 Set 且同时含 R2 列 + R4 列（跨轮合并）
    assert.ok(b1._modifiedColumns instanceof Set, '_modifiedColumns 必须是 Set（exceljs-writer 标黄依赖）');
    assert.ok(b1._modifiedColumns.has('Transaction Description'), '_modifiedColumns 含 R2 改的列');
    assert.ok(b1._modifiedColumns.has('FundType'), '_modifiedColumns 含 R4 改的 FundType 列');

    // 仍带 R2 命中元数据（N5 命中场景行报表依赖）
    assert.equal(b1._hitScenarioName, 'R2-冲销打标', 'b1 应保留 R2 命中场景名');
    assert.equal(b1._hitScenarioId, 200, 'b1 应保留 R2 命中场景 id');

    // modifications 同时含 b1 的 R2(Transaction Description) + R4(FundType) 记录
    const b1Mods = result.modifications.filter((m) => m.rowId === 'b1');
    assert.ok(b1Mods.some((m) => m.column === 'Transaction Description' && m._round === 'R2'), 'b1 有 R2 改 Transaction Description');
    assert.ok(b1Mods.some((m) => m.column === 'FundType' && m._round === 'R4' && m.newValue === 'Ach Return'), 'b1 有 R4 改 FundType→Ach Return');
  });

  test('断言4：R5 场景2 回填 → 对应行 _modifiedColumns 含 ReconciliationId', async () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    const b2 = result.modifiedRows.find((r) => r._rowId === 'b2');
    assert.ok(b2, 'b2 应在 modifiedRows（R5s2 回填）');
    assert.equal(b2.ReconciliationId, 'RC-FT', 'b2.ReconciliationId 应被回填为网关 RC-FT');
    assert.ok(b2._modifiedColumns instanceof Set);
    assert.ok(b2._modifiedColumns.has('ReconciliationId'), 'b2 _modifiedColumns 含 ReconciliationId');
    // b2 非 R2 命中 → 不带 R2 命中元数据（不进 N5 报表）
    assert.equal(b2._hitScenarioName, undefined, 'R4/R5 改的非 R2 命中行不带 R2 命中元数据');
    // self-review A：R5-only 行无 _hitScenarioId → 导出端 N5 报表过滤（_hitScenarioId != null）排除它，不污染审计报表
    assert.equal(b2._hitScenarioId, undefined, 'R5-only 行无 _hitScenarioId（A：N5 命中场景行报表据此排除）');
    assert.equal(result.stats.r5s2BackfilledCount, 1, 'R5s2 回填计数为 1');
  });

  test('断言5：R5 场景3 → platformCleanupRows 含预期剔除行（A/B/C-O 正确）', async () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    assert.equal(result.platformCleanupRows.length, 1, '应产 1 条剔除行（b3 FundType=Refund≠Inbound）');
    const cleanup = result.platformCleanupRows[0];
    // A 加款单号 = 网关 orderid
    assert.equal(cleanup['加款单号'], 'ORD-INB');
    // B 附言 = `<银行行当前 FundType>，中台加款单已关闭。`
    assert.equal(cleanup['附言'], 'Refund，中台加款单已关闭。');
    // C~O 拷贝银行行同名字段（抽查 FundType / MerchantId / Extra Information）
    assert.equal(cleanup['FundType'], 'Refund');
    assert.equal(cleanup['MerchantId'], 'M003');
    assert.equal(cleanup['Extra Information'], 'extra-x');
    // C~O 列齐全（CLEANUP_COPY_HEADERS 每列都存在 key）
    for (const h of CLEANUP_COPY_HEADERS) {
      assert.ok(Object.prototype.hasOwnProperty.call(cleanup, h), `剔除行应含 C~O 列 ${h}`);
    }
  });

  test('v3.0.23：R1 先选非目标网关时，R4 仍从完整 exactRows 命中后续正确网关', async () => {
    const bankRows = [makeBankRow({
      _rowId: 'b1', ReconciliationId: 'RC-HX', FundType: 'Charge',
      MerchantId: 'M001', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0
    })];
    const gwRows = [
      makeGwRow({ reconciliationid: 'RC-HX', TradeType: 'Inbound-VA', merchantid: 'M001', currency: 'USD', amount: 100 }),
      makeGwRow({ reconciliationid: 'RC-HX', TradeType: 'HX_OUTBOUND', merchantid: 'M001', currency: 'USD', amount: 100 })
    ];
    const scenarios = [makeR4HxOutScenario({ priority: 3 })];
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    const b1 = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(b1);
    assert.equal(result.stats.r1Matched, 1, 'R1 只配到原序第一条 Inbound-VA');
    assert.equal(b1.FundType, 'HX-out', 'R4 不依赖 R1 matchedGwRows，后续 HX_OUTBOUND 仍命中');
    assert.ok(b1._modifiedColumns.has('FundType'));
  });

  test('v3.0.23 增补：R4 AchReturn no-op 关系传给 R5，关闭重复 ReconID 退款池漏过滤', async () => {
    const bankRow = makeBankRow({
      _rowId: 'r4-r5-noop',
      ReconciliationId: 'RC-R4-R5-NOOP',
      FundType: 'Ach Return',
      MerchantId: 'M001',
      Currency: 'USD',
      'Debit Amount': 100,
      'Credit Amount': 0
    });
    bankRow.ChannelOrderNo = 'PAY-R4-R5';
    bankRow.CustomerRef = '';
    bankRow['Extra Fee'] = '';

    const gwRows = [
      makeGwRow({
        reconciliationid: 'RC-R4-R5-NOOP',
        TradeType: 'Inbound-VA',
        merchantid: 'M001',
        currency: 'USD',
        amount: 100
      }),
      makeGwRow({
        reconciliationid: 'RC-R4-R5-NOOP',
        TradeType: 'AchReturn',
        merchantid: 'M001',
        currency: 'USD',
        amount: 100
      })
    ];
    const refundRows = [{
      '流水号': 'SN-R4-R5',
      '状态': 'SUBMITTED',
      '银行大账号': 'M001',
      '币种': 'USD',
      '退款金额': 100,
      '银行打款流水号': 'PAY-R4-R5',
      '附言': '',
      '付款人名称': '',
      '付款卡号': '',
      '虚拟卡号': '',
      valueDate: '2026-06-01'
    }];

    const result = await runReconciliation({
      bankRows: [bankRow],
      gwRows,
      scenarios: [makeR4AchReturnScenario(), makeR5RefundEnabledScenario()],
      refundContext: { refundOrderRows: refundRows, depositRows: [] }
    });

    assert.equal(result.stats.r1Matched, 1, 'R1 按网关原序先配到 Inbound-VA');
    assert.equal(result.stats.r4ChangedCount, 0, '银行原值已是 Ach Return，R4 不得伪造 modification');
    assert.deepEqual(result.modifications, [], 'no-op 不产生修改或标黄证据');
    assert.deepEqual(result.refundBackfillRows, [], 'R4 AchReturn 具体配对行不得再次进入退款回填');
    assert.deepEqual(result.refundUnmatchedRows, [], '被确认行保持静默排除，不进入退款人工结果');
    assert.deepEqual(result.unmatchedRows.map((row) => row._rowId), ['r4-r5-noop'], '未改值行仍遵守主结果分区口径');
  });
});

// ---------------------------------------------------------------------------
// R2 锁定但未改值的命中行
//   dispatcher 内部仍锁定双方以维护 first-match-wins；编排器导出分区只认实际 modification。
// ---------------------------------------------------------------------------
test.describe('R2 锁定但未改值的命中行', () => {
  // 银行行：一对配对行（L1/R1），R1 的 Transaction Description 已等于目标值 '已对账'
  //   + 一行完全不命中（b0）做行数守恒对照。
  const mkRows = () => [
    // 对照行：BillTag 用中文 '普通'，绝不含字母 L/R（'包含' 匹配大小写敏感、按子串）→ 不入 type1/type2
    makeBankRow({ _rowId: 'b0', BillTag: '普通' }),                   // 不含 L/R → 不命中
    makeBankRow({ _rowId: 'L1', BillTag: 'L', PairKey: 'K1', 'Transaction Description': '', 'Credit Amount': 100, 'Debit Amount': 0 }),
    // R1 的标记字段已等于 markValue.value → 配对锁定但不 record
    makeBankRow({ _rowId: 'R1', BillTag: 'R', PairKey: 'K1', 'Transaction Description': '已对账', 'Credit Amount': 100, 'Debit Amount': 0 })
  ];

  test('前置：dispatcher 确认 L1/R1 被锁定进 modifiedRows 但 modifications 为空（_modifiedColumns 空 Set）', async () => {
    const result = runAllScenarios(mkRows(), [], [makeR2PairLockNoChangeScenario()], undefined);
    // modifications 为空（rightRow 已等于目标值 → 不 record）
    assert.equal(result.modifications.length, 0, 'markValue 已等于现值 → 无 modification 记录');
    // 但 L1/R1 都被锁定 → 进 dispatcher.modifiedRows，且 _modifiedColumns 为空 Set
    const hitIds = result.modifiedRows.map((r) => r._rowId).sort();
    assert.deepEqual(hitIds, ['L1', 'R1'], 'L1/R1 配对成功被锁定 → 在 dispatcher.modifiedRows');
    for (const r of result.modifiedRows) {
      assert.ok(r._modifiedColumns instanceof Set);
      assert.equal(r._modifiedColumns.size, 0, '锁定未改值行 _modifiedColumns 为空 Set');
      assert.equal(r._hitScenarioId, 210, '带 R2 命中元数据');
    }
  });

  test('编排器：R2 锁定未改值行不进 modifiedRows，进入 unmatchedRows，行数守恒', async () => {
    const bankRows = mkRows();
    const total = bankRows.length;
    // L1/R1 与两条网关构成 2×2 多对多候选；旧逻辑会生成异常说明并把它们提升为命中行。
    const gwRows = [
      makeGwRow({ reconciliationid: 'GW-1', merchantid: 'M001', currency: 'USD', amount: 100, Billdate: '2026-06-01' }),
      makeGwRow({ reconciliationid: 'GW-2', merchantid: 'M001', currency: 'USD', amount: 100, Billdate: '2026-06-01' })
    ];
    const result = await runReconciliation({ bankRows, gwRows, scenarios: [makeR2PairLockNoChangeScenario()] });

    const modIds = result.modifiedRows.map((r) => r._rowId).sort();
    // ① 没有实际 modification → 不进入导出「命中场景」
    assert.deepEqual(modIds, [], 'R2 锁定未改值的 L1/R1 不应进入 modifiedRows');

    // ② 未发生字段变更的行进入 unmatchedRows（包含完全不命中的 b0 + 锁定 no-op 的 L1/R1）
    const unmatchedIds = result.unmatchedRows.map((r) => r._rowId).sort();
    assert.deepEqual(unmatchedIds, ['L1', 'R1', 'b0'], '未改字段的行应留在 unmatchedRows');

    // ③ 未实际改值行不传给异常说明检测器，不能靠 note-only 提升为命中。
    assert.deepEqual(result.manyToManyReviewRows, [], '锁定 no-op 行不执行多对多异常说明检测');
    assert.equal(result.stats.manyToManyReviewCount, 0, '锁定 no-op 行不计异常说明');

    // ④ 行数守恒
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      total,
      'modifiedRows + unmatchedRows === bankRows.length'
    );
  });

  test('编排器：实际改值行可继续带多对多异常说明，改值列与行数守恒不变', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', BillTag: 'OFFSET-A', 'Credit Amount': 100, 'Debit Amount': 0 }),
      makeBankRow({ _rowId: 'b2', BillTag: 'OFFSET-B', 'Credit Amount': 100, 'Debit Amount': 0 })
    ];
    const gwRows = [
      makeGwRow({ reconciliationid: 'GW-1', merchantid: 'M001', currency: 'USD', amount: 100, Billdate: '2026-06-01' }),
      makeGwRow({ reconciliationid: 'GW-2', merchantid: 'M001', currency: 'USD', amount: 100, Billdate: '2026-06-01' })
    ];

    const result = await runReconciliation({ bankRows, gwRows, scenarios: [makeR2OffsetScenario()] });

    assert.deepEqual(result.modifiedRows.map((r) => r._rowId), ['b1', 'b2'], '两条实际改值行进入命中结果');
    assert.ok(
      result.modifiedRows.every((r) => r._modifiedColumns.has('Transaction Description')),
      '实际改值列继续保留，供 writer 标黄'
    );
    assert.deepEqual(
      result.manyToManyReviewRows.map((rv) => rv.row._rowId),
      ['b1', 'b2'],
      '实际改值行仍执行多对多检测'
    );
    assert.ok(result.manyToManyReviewRows.every((rv) => rv.note.trim() !== ''), '实际改值行保留非空异常说明');
    assert.equal(result.stats.manyToManyReviewCount, 2, '异常说明统计只计实际改值行');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, '行数守恒');
  });

  test('编排器：C3 匹配成功但 assign 同值时不进 modifiedRows', async () => {
    const scenario = {
      id: 220,
      name: 'R2-C3同值回填',
      category: 'gateway-recon-join',
      priority: 5,
      enabled: true,
      displayIndex: 1,
      config: {
        conditions: [{ side: '银行', field: 'FundType', op: '等于', value: 'outbound' }],
        reconFields: [
          { seq: 1, gwField: 'currency', bankField: 'Currency' },
          { seq: 2, gwField: 'amount', bankField: '发生额绝对值' }
        ],
        assign: { gwField: 'reconciliationid', bankField: 'ReconciliationId', mode: 'direct' }
      }
    };
    const bankRows = [
      makeBankRow({
        _rowId: 'b1',
        FundType: 'outbound',
        ReconciliationId: 'RC-SAME',
        Currency: 'USD',
        'Credit Amount': 0,
        'Debit Amount': 100
      })
    ];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-SAME', currency: 'USD', amount: 100 })];

    const result = await runReconciliation({ bankRows, gwRows, scenarios: [scenario] });

    assert.equal(result.modifications.length, 0, '同值 assign 不产生 modification');
    assert.deepEqual(result.modifiedRows.map((r) => r._rowId), [], '未实际改字段 → 不进 modifiedRows');
    assert.deepEqual(result.unmatchedRows.map((r) => r._rowId), ['b1'], '未实际改字段 → 留在 unmatchedRows');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, 1, '行数守恒');
  });

  test('v3.0.23：C3 使用专用候选池，未传时回退 gwRows', async () => {
    const scenario = {
      id: 223,
      name: 'R2-C3双池隔离',
      category: 'gateway-recon-join',
      priority: 5,
      enabled: true,
      displayIndex: 1,
      config: {
        conditions: [],
        reconFields: [{ seq: 1, gwField: 'currency', bankField: 'Currency' }],
        assign: { gwField: 'reconciliationid', bankField: 'ReconciliationId', mode: 'direct' }
      }
    };
    const c3OnlyGw = makeGwRow({
      reconciliationid: 'C3-UPPER',
      TradeType: 'HX_OUTBOUND',
      merchantid: 'M001',
      currency: 'USD',
      amount: '100'
    });
    const bankWithDedicatedPool = makeBankRow({
      _rowId: 'c3-dedicated',
      ReconciliationId: '',
      FundType: 'outbound',
      Currency: 'USD',
      'Debit Amount': '100',
      'Credit Amount': '0'
    });

    const dedicated = await runReconciliation({
      bankRows: [bankWithDedicatedPool],
      gwRows: [],
      c3GwRows: [c3OnlyGw],
      scenarios: [scenario, makeR4HxOutScenario()]
    });
    assert.equal(bankWithDedicatedPool.ReconciliationId, 'C3-UPPER', 'C3 必须读取 c3GwRows');
    assert.equal(dedicated.rounds.r1.matched, 0, 'R1 仍读取 exact gwRows，不得看到 C3-only 候选');
    assert.equal(bankWithDedicatedPool.FundType, 'outbound', 'R4 仍读取 exact gwRows，不得看到 C3-only 候选');

    const fallbackBank = makeBankRow({ _rowId: 'c3-fallback', ReconciliationId: '', Currency: 'USD' });
    await runReconciliation({ bankRows: [fallbackBank], gwRows: [c3OnlyGw], scenarios: [scenario] });
    assert.equal(fallbackBank.ReconciliationId, 'C3-UPPER', '旧调用未传 c3GwRows 时回退 gwRows');
  });

  test('v3.0.23：C3 网关侧显式 Channel 条件仍区分大小写', async () => {
    const scenario = {
      id: 224,
      name: 'R2-C3内部Channel精确条件',
      category: 'gateway-recon-join',
      priority: 5,
      enabled: true,
      displayIndex: 1,
      config: {
        conditions: [{ side: '网关', field: 'Channel', op: '等于', value: 'Maybank' }],
        reconFields: [{ seq: 1, gwField: 'currency', bankField: 'Currency' }],
        assign: { gwField: 'reconciliationid', bankField: 'ReconciliationId', mode: 'direct' }
      }
    };
    const bankRow = makeBankRow({ _rowId: 'c3-condition', ReconciliationId: '', Currency: 'USD' });
    const result = await runReconciliation({
      bankRows: [bankRow],
      gwRows: [],
      c3GwRows: [{ ...makeGwRow({ reconciliationid: 'SHOULD-NOT-HIT', currency: 'USD' }), Channel: 'MAYBANK' }],
      scenarios: [scenario]
    });

    assert.equal(bankRow.ReconciliationId, '', '预筛放宽不能改变 C3 内部显式条件');
    assert.equal(result.modifications.length, 0);
  });
});

// ---------------------------------------------------------------------------
// v3.0.14：命中场景只认至少一个字段实际变化；异常说明不能提升未改值行。
// ---------------------------------------------------------------------------
test.describe('buildOutputRows — 仅实际改值行进入命中结果', () => {
  test('空修改列集合不算改值，note-only/R2 锁定元数据不能提升为 modifiedRows', () => {
    const bankRows = [
      makeBankRow({ _rowId: 'changed', FundType: 'outbound' }),
      makeBankRow({ _rowId: 'review-only', FundType: 'Charge' }),
      makeBankRow({ _rowId: 'clean', FundType: 'Inbound' })
    ];
    const modColsByRowId = new Map([
      ['changed', new Set(['FundType'])],
      ['review-only', new Set()]
    ]);
    const r2HitByRowId = new Map([
      ['review-only', { _rowId: 'review-only', _hitScenarioId: 9, _hitScenarioName: 'R2命中但未改' }]
    ]);

    const result = buildOutputRows(bankRows, modColsByRowId, r2HitByRowId);

    assert.deepEqual(result.modifiedRows.map((r) => r._rowId), ['changed'], '只有非空修改列集合对应行进入 modifiedRows');
    assert.deepEqual(
      result.unmatchedRows.map((r) => r._rowId),
      ['review-only', 'clean'],
      '空 Set 的锁定/note-only 行与普通未命中行都留在 unmatchedRows'
    );
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, '行数守恒');
  });
});

// ---------------------------------------------------------------------------
// 断言 6：R2 零回归（与直接调 dispatcher 一致）
// ---------------------------------------------------------------------------
test.describe('R2 零回归', () => {
  test('只给一个普通 C2 → 落 R2，modifiedRows 与直接调 dispatcher 行为一致（命中元数据在）', async () => {
    const mkRows = () => [
      makeBankRow({ _rowId: 'b1', BillTag: 'OFFSET-A' }),
      makeBankRow({ _rowId: 'b2', BillTag: 'NORMAL' })
    ];
    const scenario = makeR2OffsetScenario();

    // 直接调 dispatcher（基准）
    const baselineRows = mkRows();
    const baseline = runAllScenarios(baselineRows, [], [scenario], undefined);

    // 编排器（无网关行、无 R1/R4/R5 场景 → 仅 R2 生效）
    const orchRows = mkRows();
    const orch = await runReconciliation({ bankRows: orchRows, gwRows: [], scenarios: [scenario] });

    // 命中行集合一致
    const baseHitIds = baseline.modifiedRows.map((r) => r._rowId).sort();
    const orchHitIds = orch.modifiedRows.map((r) => r._rowId).sort();
    assert.deepEqual(orchHitIds, baseHitIds, '命中行集合应一致');
    assert.deepEqual(orchHitIds, ['b1'], '只有 b1 命中（含 OFFSET）');

    // b1 命中元数据一致
    const baseB1 = baseline.modifiedRows.find((r) => r._rowId === 'b1');
    const orchB1 = orch.modifiedRows.find((r) => r._rowId === 'b1');
    assert.equal(orchB1._hitScenarioId, baseB1._hitScenarioId);
    assert.equal(orchB1._hitScenarioName, baseB1._hitScenarioName);
    assert.equal(orchB1._hitScenarioDisplayIndex, baseB1._hitScenarioDisplayIndex);
    // 改写值一致
    assert.equal(orchB1['Transaction Description'], '已对账');
    assert.equal(baseB1['Transaction Description'], '已对账');
    // _modifiedColumns 都是 Set 且含同列
    assert.ok(orchB1._modifiedColumns instanceof Set);
    assert.ok(orchB1._modifiedColumns.has('Transaction Description'));
    assert.deepEqual(
      Array.from(orchB1._modifiedColumns).sort(),
      Array.from(baseB1._modifiedColumns).sort(),
      '_modifiedColumns 集合一致'
    );

    // 行数守恒
    assert.equal(orch.modifiedRows.length + orch.unmatchedRows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 断言 7：enablement 守卫（某 bucket 为空 → 该轮 no-op 不报错）
// ---------------------------------------------------------------------------
test.describe('enablement 守卫', () => {
  test('scenarios 为空数组 → 全部轮 no-op，不报错，行数守恒，无修改', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', FundType: 'Charge' }),
      makeBankRow({ _rowId: 'b2', FundType: 'Refund' })
    ];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-X', TradeType: 'Charge' })];
    const result = await runReconciliation({ bankRows, gwRows, scenarios: [] });

    assert.equal(result.modifiedRows.length, 0, '无场景 → 无命中行');
    assert.equal(result.unmatchedRows.length, 2, '全部行进 unmatched');
    assert.equal(result.modifications.length, 0);
    assert.equal(result.platformCleanupRows.length, 0);
    // 行数守恒
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
    // stats 分项仍输出（R1 仍跑：RC-X 网关但银行无对应 reconid → r1Matched 0）
    assert.equal(result.stats.r1Matched, 0);
    assert.equal(result.stats.r4ChangedCount, 0);
    assert.equal(result.stats.r5s2BackfilledCount, 0);
    assert.equal(result.stats.r5s3CleanupCount, 0);
  });

  test('只启用 R5 场景3（其它 bucket 空）→ 仅产剔除文件，R2/R4/R5s2 no-op', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', ReconciliationId: 'RC-INB', FundType: 'Refund', MerchantId: 'M003' }),
      makeBankRow({ _rowId: 'b2', FundType: 'Charge', BillTag: 'OFFSET-A' }) // 无 R2 场景启用 → 不应被改
    ];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-INB', TradeType: 'Inbound-VA', orderid: 'ORD-INB' })];
    const result = await runReconciliation({ bankRows, gwRows, scenarios: [makeR5CleanupScenario()] });

    assert.equal(result.platformCleanupRows.length, 1, '场景3 启用 → 产 1 条剔除行');
    // R2 未启用 → b2 不应被打标，仍在 unmatched
    assert.ok(result.unmatchedRows.some((r) => r._rowId === 'b2'), 'R2 未启用，b2 不被改 → 在 unmatched');
    // b1 未被任何轮改字段（场景3 一般不改银行行）→ 也在 unmatched
    assert.ok(result.unmatchedRows.some((r) => r._rowId === 'b1'), '场景3 不改银行行 → b1 在 unmatched');
    assert.equal(result.modifiedRows.length, 0, '场景3 不改银行行 → 无 modifiedRows');
    assert.equal(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length);
  });
});

// ---------------------------------------------------------------------------
// buildOutputRows 直接单测（重建逻辑边界）
// ---------------------------------------------------------------------------
test.describe('buildOutputRows', () => {
  test('_modifiedColumns 是新建 Set（与累积 Map 解耦）+ 嫁接 R2 元数据排除 _rowId/_modifiedColumns', async () => {
    const bankRows = [
      { _rowId: 'b1', FundType: 'outbound', X: 1 },
      { _rowId: 'b2', FundType: 'Charge', X: 2 }
    ];
    const modCols = new Map([['b1', new Set(['FundType'])]]);
    // 模拟 dispatcher 浅拷贝命中行（含将被嫁接的 _ 元数据 + 应被排除的 _rowId/_modifiedColumns）
    const r2Hit = new Map([['b1', {
      _rowId: 'b1', _hitScenarioName: 'R2-x', _hitScenarioId: 7,
      _modifiedColumns: new Set(['SHOULD_NOT_LEAK'])
    }]]);

    const { modifiedRows, unmatchedRows } = buildOutputRows(bankRows, modCols, r2Hit);
    assert.equal(modifiedRows.length, 1);
    assert.equal(unmatchedRows.length, 1);
    const b1 = modifiedRows[0];
    assert.ok(b1._modifiedColumns instanceof Set);
    // 来自累积 Map，不是 r2Hit 的 SHOULD_NOT_LEAK
    assert.deepEqual(Array.from(b1._modifiedColumns), ['FundType']);
    // 嫁接的元数据在
    assert.equal(b1._hitScenarioName, 'R2-x');
    assert.equal(b1._hitScenarioId, 7);
    // _rowId 用 bankRows 本身的（嫁接排除 _rowId，且值一致）
    assert.equal(b1._rowId, 'b1');

    // 修改累积 Map 的 Set 不应影响已产出的 modifiedRows（解耦：new Set 拷贝）
    modCols.get('b1').add('LATE');
    assert.ok(!b1._modifiedColumns.has('LATE'), '产出后修改源 Set 不影响 modifiedRows（已 new Set 拷贝）');
  });
});

// ---------------------------------------------------------------------------
// v3.0.7 需求1a：channelRegionHits 聚合（状态框「已处理」分支数据源）
//   契约 C1 形状：Array<{ channelRegion:string, rowCount:number, scenarioNames:string[] }>
// ---------------------------------------------------------------------------
test.describe('buildChannelRegionHits 直接单测（需求1a）', () => {
  // 命中行夹具：浅拷贝当前最新 bankRow（含 Channel/地区 数据列 + 可选 _hitScenarioName）
  const mkHit = (over = {}) => ({
    _rowId: over._rowId,
    Channel: over.Channel,
    地区: over['地区'],
    _hitScenarioName: over._hitScenarioName
  });

  test('R2 命中行：scenarioNames 取 _hitScenarioName；按 渠道-地区 聚合行数', async () => {
    const modifiedRows = [
      mkHit({ _rowId: 'b1', Channel: 'JPM', 地区: 'US', _hitScenarioName: '冲销打标' }),
      mkHit({ _rowId: 'b2', Channel: 'JPM', 地区: 'US', _hitScenarioName: '提取调拨ID' }),
      mkHit({ _rowId: 'b3', Channel: 'JPM', 地区: 'HK', _hitScenarioName: '冲销打标' })
    ];
    const allMods = [
      { rowId: 'b1', column: 'Transaction Description', _round: 'R2' },
      { rowId: 'b2', column: 'ReconciliationId', _round: 'R2' },
      { rowId: 'b3', column: 'Transaction Description', _round: 'R2' }
    ];
    const hits = buildChannelRegionHits(modifiedRows, allMods);

    // 升序：JPM-HK 在 JPM-US 前
    assert.deepEqual(hits.map((h) => h.channelRegion), ['JPM-HK', 'JPM-US']);
    const us = hits.find((h) => h.channelRegion === 'JPM-US');
    assert.equal(us.rowCount, 2, 'JPM-US 命中 2 行（b1+b2）');
    assert.deepEqual(us.scenarioNames, ['冲销打标', '提取调拨ID'], '去重+升序的 R2 场景名');
    const hk = hits.find((h) => h.channelRegion === 'JPM-HK');
    assert.equal(hk.rowCount, 1);
    assert.deepEqual(hk.scenarioNames, ['冲销打标']);
  });

  test('R4/R5-only 行（无 _hitScenarioName）：scenarioNames 用 allMods 轮次中文标签兜底', async () => {
    const modifiedRows = [
      mkHit({ _rowId: 'b1', Channel: 'ADM', 地区: 'US' }),                       // R4 + R5s2-recon
      mkHit({ _rowId: 'b2', Channel: 'ADM', 地区: 'US' })                        // R5s2
    ];
    const allMods = [
      { rowId: 'b1', column: 'FundType', _round: 'R4' },
      { rowId: 'b1', column: 'ReconciliationId', _round: 'R5s2-recon' },
      { rowId: 'b2', column: 'ReconciliationId', _round: 'R5s2' }
    ];
    const hits = buildChannelRegionHits(modifiedRows, allMods);
    assert.equal(hits.length, 1);
    const adm = hits[0];
    assert.equal(adm.channelRegion, 'ADM-US');
    assert.equal(adm.rowCount, 2);
    // b1 两轮 → 两个中文标签；b2 一轮 → 一个；去重+升序合并
    assert.deepEqual(adm.scenarioNames, ['调拨对账单回填', '资金性质校验', '资金划转回填'].sort());
  });

  test('混合：同一行 R2 命中名优先（不退化为轮次标签），同组兼有 R4 行', async () => {
    const modifiedRows = [
      // b1 既是 R2 命中（带名）又被 R4 改 → 取 _hitScenarioName，不追加 R4 标签
      mkHit({ _rowId: 'b1', Channel: 'BOC', 地区: 'CN', _hitScenarioName: '冲销打标' }),
      // b2 仅 R4 改（无名）→ 轮次标签兜底
      mkHit({ _rowId: 'b2', Channel: 'BOC', 地区: 'CN' })
    ];
    const allMods = [
      { rowId: 'b1', column: 'Transaction Description', _round: 'R2' },
      { rowId: 'b1', column: 'FundType', _round: 'R4' },
      { rowId: 'b2', column: 'FundType', _round: 'R4' }
    ];
    const hits = buildChannelRegionHits(modifiedRows, allMods);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rowCount, 2);
    // b1 用 R2 名（不含「资金性质校验」），b2 用 R4 标签 → 合并去重升序
    assert.deepEqual(hits[0].scenarioNames, ['冲销打标', '资金性质校验'].sort());
  });

  test('地区空 → 只产 裸 Channel 组合；Channel 空 → 跳过整行（口径与枚举一致）', async () => {
    const modifiedRows = [
      mkHit({ _rowId: 'b1', Channel: 'ADM', 地区: '', _hitScenarioName: '冲销打标' }),   // 地区空 → 'ADM'
      mkHit({ _rowId: 'b2', Channel: '  ', 地区: 'US', _hitScenarioName: 'x' }),         // Channel 空 → 跳过
      mkHit({ _rowId: 'b3', Channel: 'ADM', 地区: '   ', _hitScenarioName: '提取调拨ID' }) // 地区纯空格 → 'ADM'
    ];
    const allMods = [];
    const hits = buildChannelRegionHits(modifiedRows, allMods);
    assert.equal(hits.length, 1, 'Channel 空行被跳过，仅 ADM 组合');
    assert.equal(hits[0].channelRegion, 'ADM');
    assert.equal(hits[0].rowCount, 2, 'b1+b3 计入（b2 Channel 空跳过）');
    assert.deepEqual(hits[0].scenarioNames, ['冲销打标', '提取调拨ID'].sort());
  });

  test('Channel 含前后空格 → trim 后聚合（与 extractChannelRegionCombos trim 口径一致）', async () => {
    const modifiedRows = [
      mkHit({ _rowId: 'b1', Channel: ' JPM ', 地区: ' US ', _hitScenarioName: '冲销打标' })
    ];
    const hits = buildChannelRegionHits(modifiedRows, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].channelRegion, 'JPM-US', 'Channel/地区 均 trim 后拼接');
  });

  test('空集 / 全部行 Channel 空 → []（renderer 据此回退旧格式）', async () => {
    assert.deepEqual(buildChannelRegionHits([], []), []);
    assert.deepEqual(buildChannelRegionHits(null, null), []);
    assert.deepEqual(
      buildChannelRegionHits([mkHit({ _rowId: 'b1', Channel: '', 地区: 'US' })], []),
      [],
      '唯一命中行 Channel 空 → 空集'
    );
  });

  test('R4/R5 行 allMods 反查不到（防御）→ scenarioNames 为空数组，不抛错', async () => {
    const modifiedRows = [mkHit({ _rowId: 'bX', Channel: 'ADM', 地区: 'US' })];
    const hits = buildChannelRegionHits(modifiedRows, []); // allMods 空 → 反查不到
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rowCount, 1);
    assert.deepEqual(hits[0].scenarioNames, [], '无 _hitScenarioName 且 allMods 无记录 → 空场景名');
  });

  test('契约形状：每条均含 {channelRegion:string, rowCount:number, scenarioNames:string[]}', async () => {
    const hits = buildChannelRegionHits(
      [mkHit({ _rowId: 'b1', Channel: 'JPM', 地区: 'US', _hitScenarioName: '冲销打标' })],
      [{ rowId: 'b1', column: 'X', _round: 'R2' }]
    );
    assert.equal(hits.length, 1);
    const h = hits[0];
    assert.equal(typeof h.channelRegion, 'string');
    assert.equal(typeof h.rowCount, 'number');
    assert.ok(Array.isArray(h.scenarioNames));
    assert.deepEqual(Object.keys(h).sort(), ['channelRegion', 'rowCount', 'scenarioNames']);
  });
});

// ---------------------------------------------------------------------------
// v3.0.7 需求1a：channelRegionHits 端到端（runReconciliation.stats.channelRegionHits）
//   验证：(a) stats 携带该字段；(b) 口径与 extractChannelRegionCombos 同源；
//        (c) R2 命中名 + R4/R5 轮次标签两条路在真实流水线下都能产出。
// ---------------------------------------------------------------------------
test.describe('runReconciliation stats.channelRegionHits 端到端（需求1a）', () => {
  test('全链路：JPM-US 组（b1=R2+R4 取 R2 名 / b2=R5s2 取轮次标签），口径=extractChannelRegionCombos', async () => {
    // b1：R2 命中（OFFSET）+ R4 改 FundType（reconid RC-CHG）；Channel/地区 默认 → 改成 JPM/US
    // b2：R5s2 网关回填（reconSourceMid:false 取消路）；Channel/地区 → JPM/US
    // b4：完全不命中 → 不进 channelRegionHits
    const bankRows = [
      makeBankRow({
        _rowId: 'b1', ReconciliationId: 'RC-CHG', FundType: 'Charge', BillTag: 'OFFSET-A', Channel: 'JPM', 地区: 'US',
        MerchantId: 'M001', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0
      }),
      makeBankRow({
        _rowId: 'b2', ReconciliationId: '', FundType: 'FundTransfer-out',
        MerchantId: 'M002', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0, BillDate: '2026-06-10',
        Channel: 'JPM', 地区: 'US'
      }),
      makeBankRow({ _rowId: 'b4', ReconciliationId: '', FundType: 'Settlement', BillTag: 'NORMAL', Channel: 'JPM', 地区: 'US' })
    ];
    const gwRows = [
      makeGwRow({ reconciliationid: 'RC-CHG', TradeType: 'AchReturn', merchantid: 'M001', currency: 'USD', amount: 100, orderid: 'ORD-CHG' }),
      makeGwRow({ reconciliationid: 'RC-FT', TradeType: 'FundTransfer-out', merchantid: 'M002', currency: 'USD', amount: -100, Billdate: '2026-06-10' })
    ];
    const scenarios = [makeR2OffsetScenario(), makeR4AchReturnScenario(), makeR5BackfillScenario()];
    const result = await runReconciliation({ bankRows, gwRows, scenarios });

    const hits = result.stats.channelRegionHits;
    assert.ok(Array.isArray(hits), 'stats.channelRegionHits 是数组');
    assert.equal(hits.length, 1, '仅 JPM-US 一组（b1+b2 命中，b4 未命中不计）');
    const us = hits[0];
    assert.equal(us.channelRegion, 'JPM-US');
    assert.equal(us.rowCount, 2, 'b1+b2 两行命中');
    // b1 → R2 名「R2-冲销打标」；b2 → R5s2 轮次标签「资金划转回填」
    assert.deepEqual(us.scenarioNames, ['R2-冲销打标', '资金划转回填'].sort());

    // 口径同源：channelRegion 集合 ⊆ extractChannelRegionCombos(命中行)（命中行 Channel/地区 与枚举口径一致）
    const combosOfHitRows = extractChannelRegionCombos(result.modifiedRows);
    assert.deepEqual(hits.map((h) => h.channelRegion).sort(), combosOfHitRows.sort(), 'channelRegion 口径与 extractChannelRegionCombos 一致');
  });

  test('多渠道-地区：按 channelRegion 升序、rowCount 准确', async () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', BillTag: 'OFFSET-A', Channel: 'JPM', 地区: 'US' }),
      makeBankRow({ _rowId: 'b2', BillTag: 'OFFSET-A', Channel: 'JPM', 地区: 'HK' }),
      makeBankRow({ _rowId: 'b3', BillTag: 'OFFSET-A', Channel: 'ADM', 地区: 'US' }),
      makeBankRow({ _rowId: 'b4', BillTag: 'NORMAL', Channel: 'JPM', 地区: 'US' }) // 不命中
    ];
    const result = await runReconciliation({ bankRows, gwRows: [], scenarios: [makeR2OffsetScenario()] });
    const hits = result.stats.channelRegionHits;
    assert.deepEqual(hits.map((h) => h.channelRegion), ['ADM-US', 'JPM-HK', 'JPM-US'], '按 channelRegion 升序');
    for (const h of hits) {
      assert.equal(h.rowCount, 1);
      assert.deepEqual(h.scenarioNames, ['R2-冲销打标']);
    }
  });

  test('无命中 / 全部行 Channel 空 → channelRegionHits 为 []（回退旧格式）', async () => {
    // 无场景启用 → 无命中行
    const r1 = await runReconciliation({
      bankRows: [makeBankRow({ _rowId: 'b1', Channel: 'JPM', 地区: 'US' })],
      gwRows: [], scenarios: []
    });
    assert.deepEqual(r1.stats.channelRegionHits, [], '无命中 → []');

    // 有命中但命中行 Channel 全空 → []
    const r2 = await runReconciliation({
      bankRows: [makeBankRow({ _rowId: 'b1', BillTag: 'OFFSET-A', Channel: '', 地区: '' })],
      gwRows: [], scenarios: [makeR2OffsetScenario()]
    });
    assert.ok(r2.stats.hitRowCount >= 1, '确有命中行（验证不是因无命中才空）');
    assert.deepEqual(r2.stats.channelRegionHits, [], '命中行 Channel 空 → []');
  });
});

// ---------------------------------------------------------------------------
// v3.0.7 需求6（🔴 资金红线）：gwRows「全程只读」不变量 —— 删 structuredClone 安全性背书。
//   main.js bank-statement:run 把网关数据源改为 readGatewayBillRowsByChannels 并删除了 structuredClone
//   深拷（前提：编排器各轮对 gwRows 只建索引 / 比对，modifications 只写 bankRows，不原地改 gwRows）。
//   本测试在 run 前 structuredClone 快照 gwRows、run 后 deepStrictEqual → 证明全程未改写任一网关行，
//   删深拷不会让「DB 还原对象被污染 / 下次读到脏数据」。覆盖 R1/R2(C3)/R3.5/R4/R5s2/R5s3 多轮同时消费 gwRows。
// ---------------------------------------------------------------------------
test.describe('v3.0.7 需求6：gwRows 全程只读不变量（删 structuredClone 安全）', () => {
  // R3.5 DBS-Charge 场景（消费 gwRows 步骤2 amount/currency 判 outbound）
  function makeDbsChargeScenario() {
    return {
      id: 350, name: 'R3.5-DBS-Charge', category: 'builtin-fixed', priority: 0, enabled: true,
      config: { funcCategory: 'dbs-charge-fund-check', channel: 'DBS', requireBankFundType: 'Charge', setFundType: 'outbound', gwOutboundTradeType: 'HX_OUTBOUND' }
    };
  }

  test('run 前后 gwRows 逐字节不变（structuredClone 快照 deepStrictEqual）', async () => {
    const bankRows = [
      makeBankRow({
        _rowId: 'b1', ReconciliationId: 'RC-CHG', FundType: 'Charge', BillTag: 'OFFSET-A',
        MerchantId: 'M001', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0
      }),
      makeBankRow({ _rowId: 'b2', ReconciliationId: '', FundType: 'FundTransfer-out', MerchantId: 'M002', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0, BillDate: '2026-06-10' }),
      makeBankRow({ _rowId: 'b3', ReconciliationId: 'RC-INB', FundType: 'Refund', MerchantId: 'M003' }),
      makeBankRow({ _rowId: 'b-dbs', Channel: 'DBS', ReconciliationId: '', MerchantId: 'M-DBS', Currency: 'USD', 'Debit Amount': 100, FundType: 'Charge' })
    ];
    const gwRows = [
      makeGwRow({ reconciliationid: 'RC-CHG', TradeType: 'AchReturn', merchantid: 'M001', currency: 'USD', amount: 100, orderid: 'ORD-CHG' }),
      makeGwRow({ reconciliationid: 'RC-FT', TradeType: 'FundTransfer-out', merchantid: 'M002', currency: 'USD', amount: -100, Billdate: '2026-06-10' }),
      makeGwRow({ reconciliationid: 'RC-INB', TradeType: 'Inbound-VA', orderid: 'ORD-INB' }),
      makeGwRow({ reconciliationid: 'DISP-RECON-1', TradeType: 'HX_OUTBOUND', merchantid: 'M-DBS', currency: 'USD', amount: 100 })
    ];
    const dispRows = [{ 付款渠道: 'DBS', 收款渠道: 'DBS', big_account: 'M-DBS', 币种: 'USD', 金额: 100, ReconID: 'DISP-RECON-1', fund_type: 'FundTransfer-out' }];
    const scenarios = [
      makeR2OffsetScenario(),
      makeDbsChargeScenario(),
      makeR4AchReturnScenario(),
      makeR5BackfillScenario(),
      makeR5CleanupScenario()
    ];

    const gwSnapshot = structuredClone(gwRows);
    const result = await runReconciliation({
      bankRows, gwRows, scenarios,
      dispatchReconContext: { dispatchReconRows: dispRows }
    });

    // 🔴 核心不变量：gwRows 全程未被任一轮原地改写
    assert.deepStrictEqual(gwRows, gwSnapshot, 'gwRows 在 run 后必须与 run 前快照逐字节相等（全程只读）');
    // 确保确有命中（否则只读是空对空，无意义）
    assert.ok(result.stats.hitRowCount > 0, '确有命中行（验证 gwRows 确被多轮消费）');
    assert.ok(result.stats.r1Matched > 0, 'R1 确有匹配（gwRows 被 R1 索引）');
  });
});

// ---------------------------------------------------------------------------
// v3.0.8 需求3（🔴 资金红线·只改控制流）：runReconciliation 异步化 + onProgress 轮次边界上报。
//   核心验收：异步化 + 进度回调**绝不改变对账结果**（golden 字节一致）；onProgress 仅在轮次边界被调、
//   顺序固定、异常被吞不影响 run；run 全程不改写 gwRows（与需求6 删深拷安全互证）。
//   覆盖 R1/R2/R3.5/R4/R5s2/R5s3 全轮（驱动各轮真命中，确保 yield 点都过一遍）。
// ---------------------------------------------------------------------------
test.describe('v3.0.8 需求3：runReconciliation async + onProgress 轮次边界（结果 golden 不变）', () => {
  // R3.5 DBS-Charge 场景（与需求6 套件同形；驱动 R3.5 yield 点）
  function makeDbsChargeScenario() {
    return {
      id: 350, name: 'R3.5-DBS-Charge', category: 'builtin-fixed', priority: 0, enabled: true,
      config: { funcCategory: 'dbs-charge-fund-check', channel: 'DBS', requireBankFundType: 'Charge', setFundType: 'outbound', gwOutboundTradeType: 'HX_OUTBOUND' }
    };
  }
  // 构造能驱动 R1/R2/R3.5/R4/R5s2/R5s3 全轮真命中的输入（与需求6 gwRows 只读套件同源数据）。
  function buildFullRoundInput() {
    const bankRows = [
      makeBankRow({
        _rowId: 'b1', ReconciliationId: 'RC-CHG', FundType: 'Charge', BillTag: 'OFFSET-A',
        MerchantId: 'M001', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0
      }),
      makeBankRow({ _rowId: 'b2', ReconciliationId: '', FundType: 'FundTransfer-out', MerchantId: 'M002', Currency: 'USD', 'Debit Amount': 100, 'Credit Amount': 0, BillDate: '2026-06-10' }),
      makeBankRow({ _rowId: 'b3', ReconciliationId: 'RC-INB', FundType: 'Refund', MerchantId: 'M003' }),
      makeBankRow({ _rowId: 'b-dbs', Channel: 'DBS', ReconciliationId: '', MerchantId: 'M-DBS', Currency: 'USD', 'Debit Amount': 100, FundType: 'Charge' })
    ];
    const gwRows = [
      makeGwRow({ reconciliationid: 'RC-CHG', TradeType: 'AchReturn', merchantid: 'M001', currency: 'USD', amount: 100, orderid: 'ORD-CHG' }),
      makeGwRow({ reconciliationid: 'RC-FT', TradeType: 'FundTransfer-out', merchantid: 'M002', currency: 'USD', amount: -100, Billdate: '2026-06-10' }),
      makeGwRow({ reconciliationid: 'RC-INB', TradeType: 'Inbound-VA', orderid: 'ORD-INB' }),
      makeGwRow({ reconciliationid: 'DISP-RECON-1', TradeType: 'HX_OUTBOUND', merchantid: 'M-DBS', currency: 'USD', amount: 100 })
    ];
    const dispRows = [{ 付款渠道: 'DBS', 收款渠道: 'DBS', big_account: 'M-DBS', 币种: 'USD', 金额: 100, ReconID: 'DISP-RECON-1', fund_type: 'FundTransfer-out' }];
    const scenarios = [
      makeR2OffsetScenario(),
      makeDbsChargeScenario(),
      makeR4AchReturnScenario(),
      makeR5BackfillScenario(),
      makeR5CleanupScenario()
    ];
    return { bankRows, gwRows, dispRows, scenarios };
  }

  test('onProgress 仅在轮次边界被调，顺序固定 R1→R2→R3.5→R4→R5s2→R5s2b→R5s3→R5s4→M2M', async () => {
    const { bankRows, gwRows, dispRows, scenarios } = buildFullRoundInput();
    const rounds = [];
    await runReconciliation({
      bankRows, gwRows, scenarios,
      dispatchReconContext: { dispatchReconRows: dispRows },
      onProgress: (ev) => { if (ev && ev.round) rounds.push(ev.round); }
    });
    // 轮次边界顺序钉死（编排器各轮「执行之后」让出一次）。v3.0.12 性能优化：在 R5s4 退款回填后、M2M 异常说明
    //   判断检测后各补一次让出，使「R5s4 + detector + buildOutputRows」不再挤成不让出的同步块；M2M 是末轮，
    //   其后只剩只读输出构造（buildOutputRows），无 yield。
    assert.deepStrictEqual(
      rounds,
      ['R1', 'R2', 'R3.5', 'R4', 'R5s2', 'R5s2b', 'R5s3', 'R5s4', 'M2M'],
      'onProgress round 序列必须严格等于 9 个轮次边界、顺序固定'
    );
  });

  test('🔴 golden 不变：有 onProgress vs 无 onProgress，产物逐字节相等（异步化/进度不改结果）', async () => {
    // 两路各独立深拷 bankRows（引擎原地改）；gwRows 只读可共享，但为干净也各传一份。
    const a = buildFullRoundInput();
    const b = buildFullRoundInput();
    const resNoProgress = await runReconciliation({
      bankRows: a.bankRows, gwRows: a.gwRows, scenarios: a.scenarios,
      dispatchReconContext: { dispatchReconRows: a.dispRows }
    });
    const resWithProgress = await runReconciliation({
      bankRows: b.bankRows, gwRows: b.gwRows, scenarios: b.scenarios,
      dispatchReconContext: { dispatchReconRows: b.dispRows },
      onProgress: () => { /* 上报但不影响结果 */ }
    });
    // _modifiedColumns 是 Set，deepStrictEqual 可比较 Set；两路产物必须逐字节一致。
    assert.deepStrictEqual(resWithProgress, resNoProgress, '有/无 onProgress 的 runReconciliation 产物必须逐字节相等（golden）');
    // 自检：确有多轮命中（否则等价是空对空）。
    assert.ok(resNoProgress.stats.hitRowCount > 0, '确有命中行');
    assert.ok(resNoProgress.stats.r1Matched > 0, 'R1 确有匹配');
    assert.ok(resNoProgress.stats.dbsChargeChangedCount > 0, 'R3.5 确有改写');
    assert.ok(resNoProgress.stats.r4ChangedCount > 0, 'R4 确有改写');
    assert.ok(resNoProgress.stats.r5s2BackfilledCount > 0, 'R5s2 确有回填');
    assert.ok(resNoProgress.stats.r5s3CleanupCount > 0, 'R5s3 确有剔除');
  });

  test('onProgress 抛异常被吞掉，不影响 run（结果与无 onProgress 一致）', async () => {
    const a = buildFullRoundInput();
    const b = buildFullRoundInput();
    const resClean = await runReconciliation({
      bankRows: a.bankRows, gwRows: a.gwRows, scenarios: a.scenarios,
      dispatchReconContext: { dispatchReconRows: a.dispRows }
    });
    let result;
    await assert.doesNotReject(async () => {
      result = await runReconciliation({
        bankRows: b.bankRows, gwRows: b.gwRows, scenarios: b.scenarios,
        dispatchReconContext: { dispatchReconRows: b.dispRows },
        onProgress: () => { throw new Error('boom — 进度回调故意抛'); }
      });
    });
    assert.deepStrictEqual(result, resClean, 'onProgress 抛异常时产物仍与无 onProgress 逐字节相等（异常被吞）');
  });

  test('async 路径下 gwRows 仍全程只读（run 前快照 deepStrictEqual run 后；onProgress 存在）', async () => {
    const { bankRows, gwRows, dispRows, scenarios } = buildFullRoundInput();
    const gwSnapshot = structuredClone(gwRows);
    const result = await runReconciliation({
      bankRows, gwRows, scenarios,
      dispatchReconContext: { dispatchReconRows: dispRows },
      onProgress: () => {}
    });
    assert.deepStrictEqual(gwRows, gwSnapshot, 'async + onProgress 路径下 gwRows 全程未被改写（删深拷安全）');
    assert.ok(result.stats.hitRowCount > 0, '确有命中（验证 gwRows 被多轮消费）');
  });
});
