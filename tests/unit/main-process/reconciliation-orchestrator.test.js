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
  buildOutputRows
} = require('../../../src/main-process/reconciliation-orchestrator');
const { runAllScenarios } = require('../../../src/main-process/scenario-dispatcher');
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
    // C2 reconFields≥1 配对键（PR#62 P1 fixture 用；默认空不影响其它用例配对）
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

// R2：C2 配对（reconFields≥1）「锁定双方但不改值」场景 —— 🔴 PR#62 P1 fixture
//   leftType=1（BillTag 含 'L'）× rightType=2（BillTag 含 'R'），配对键 PairKey 相等。
//   markValue 写 rightType 行的 'Transaction Description'='已对账'。
//   当 rightRow 的该字段**已等于** '已对账' 时：c2 引擎配对成功后无条件 lock 双方
//   （c2-offset-bill-mark.js:221-222），但 oldValue===newValue → 不 record（同文件 :238）。
//   → 两行进 dispatcher.modifiedRows（锁定 + 带 _hitScenario* 元数据 + _modifiedColumns 空 Set），
//     但 modifications 为空 → 编排器 modColsByRowId 收不到它们（验「锁定未改值」分区判定）。
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

// R4：五子场景之一 Charge→outbound（requireBankFundType='Charge'，setFundType='outbound'，无 gwTradeType）
function makeR4ChargeScenario({ priority = 1 } = {}) {
  return {
    id: 401,
    name: 'R4-Charge转outbound',
    category: 'builtin-fixed',
    priority,
    enabled: true,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'charge-to-outbound',
      priority,
      requireBankFundType: 'Charge',
      setFundType: 'outbound'
    }
  };
}

// R4：HX-out（gwTradeType='HX_OUTBOUND'，setFundType='HX-out'，priority 高于 charge 用于验证叠加链）
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
  test('builtin-fixed + funcCategory 正确落 R4 / R5s2 / R5s3；其余落 R2', () => {
    const scenarios = [
      makeR2OffsetScenario(),                 // 普通 C2 → R2
      { id: 1, category: 'builtin-fixed', config: { extractByFeature: { enabled: true } } }, // 无 funcCategory builtin-fixed → R2
      { id: 2, category: 'extract-recon-id', config: {} },                                   // C1 → R2
      { id: 3, category: 'gateway-recon-join', config: {} },                                 // C3 → R2
      makeR4ChargeScenario(),                 // R4
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

  test('platform-order 但缺 subCategory → 落 R2（不误入 R5）', () => {
    const s = { id: 9, category: 'builtin-fixed', config: { funcCategory: 'platform-order' } };
    const { r2, r5s2, r5s3 } = bucketScenarios([s]);
    assert.equal(r2.length, 1);
    assert.equal(r5s2.length, 0);
    assert.equal(r5s3.length, 0);
  });

  test('空 / null 入参 → 四桶皆空，不抛错', () => {
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
// 断言 1 / 2 / 3 / 4 / 5：全链路
// ---------------------------------------------------------------------------
test.describe('runReconciliation 全链路 R1→R5', () => {
  // 构造一份覆盖 R2/R4/R5s2/R5s3 的银行 + 网关数据。
  function buildFullScenarioData() {
    const bankRows = [
      // b1：R2 命中（BillTag 含 OFFSET）+ R4 改 FundType（FundType=Charge → outbound，reconid 与 R1 匹配）
      //     → 验断言 3「跨轮合并 _modifiedColumns = {Transaction Description, FundType}」
      makeBankRow({ _rowId: 'b1', ReconciliationId: 'RC-CHG', FundType: 'Charge', BillTag: 'OFFSET-A' }),
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
      // g1：reconid=RC-CHG → R1 匹配 b1 → R4 Charge→outbound 命中（无 gwTradeType 要求）
      makeGwRow({ reconciliationid: 'RC-CHG', TradeType: 'Charge', orderid: 'ORD-CHG' }),
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
      makeR4ChargeScenario(),
      makeR5BackfillScenario(),
      makeR5CleanupScenario()
    ];
    return { bankRows, gwRows, scenarios };
  }

  test('断言1+2：返回结构完整 + 行数守恒', () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const total = bankRows.length;
    const result = runReconciliation({ bankRows, gwRows, scenarios });

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
    // 互斥：同一 _rowId 不可能同时出现在两个集合
    const modIds = new Set(result.modifiedRows.map((r) => r._rowId));
    for (const u of result.unmatchedRows) {
      assert.ok(!modIds.has(u._rowId), `行 ${u._rowId} 不应同时在 modified 与 unmatched`);
    }
    // b4 完全不命中 → 进 unmatched
    assert.ok(result.unmatchedRows.some((r) => r._rowId === 'b4'), 'b4 应在 unmatchedRows');
  });

  test('断言3：R4 改写 R2 已命中行 FundType → _modifiedColumns 跨轮合并 + 仍带 R2 命中元数据', () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = runReconciliation({ bankRows, gwRows, scenarios });

    const b1 = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(b1, 'b1 应在 modifiedRows（既被 R2 命中又被 R4 改）');

    // FundType 被 R4 从 Charge 改成 outbound（当前最新值，非 dispatcher 过时浅拷贝）
    assert.equal(b1.FundType, 'outbound', 'b1.FundType 应为 R4 改写后的 outbound');
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
    assert.ok(b1Mods.some((m) => m.column === 'FundType' && m._round === 'R4' && m.newValue === 'outbound'), 'b1 有 R4 改 FundType→outbound');
  });

  test('断言4：R5 场景2 回填 → 对应行 _modifiedColumns 含 ReconciliationId', () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = runReconciliation({ bankRows, gwRows, scenarios });

    const b2 = result.modifiedRows.find((r) => r._rowId === 'b2');
    assert.ok(b2, 'b2 应在 modifiedRows（R5s2 回填）');
    assert.equal(b2.ReconciliationId, 'RC-FT', 'b2.ReconciliationId 应被回填为网关 RC-FT');
    assert.ok(b2._modifiedColumns instanceof Set);
    assert.ok(b2._modifiedColumns.has('ReconciliationId'), 'b2 _modifiedColumns 含 ReconciliationId');
    // b2 非 R2 命中 → 不带 R2 命中元数据（不进 N5 报表）
    assert.equal(b2._hitScenarioName, undefined, 'R4/R5 改的非 R2 命中行不带 R2 命中元数据');
    assert.equal(result.stats.r5s2BackfilledCount, 1, 'R5s2 回填计数为 1');
  });

  test('断言5：R5 场景3 → platformCleanupRows 含预期剔除行（A/B/C-O 正确）', () => {
    const { bankRows, gwRows, scenarios } = buildFullScenarioData();
    const result = runReconciliation({ bankRows, gwRows, scenarios });

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

  test('叠加链：R4 多 handler 顺序（HX-out priority 高于 charge）对同一行二次改 FundType', () => {
    // b1 reconid=RC-HX，网关 g 同 reconid + TradeType=HX_OUTBOUND；FundType 初始=Charge
    //   两个 R4 子场景：charge(priority1, requireBankFundType=Charge→outbound) + HX-out(priority3, gwTradeType=HX_OUTBOUND→HX-out)
    //   priority 高先跑：先 HX-out（Charge→HX-out），再 charge（requireBankFundType=Charge 已不满足 → 不再改）
    //   → 最终 FundType=HX-out，_modifiedColumns 含 FundType
    const bankRows = [makeBankRow({ _rowId: 'b1', ReconciliationId: 'RC-HX', FundType: 'Charge' })];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-HX', TradeType: 'HX_OUTBOUND' })];
    const scenarios = [makeR4ChargeScenario({ priority: 1 }), makeR4HxOutScenario({ priority: 3 })];
    const result = runReconciliation({ bankRows, gwRows, scenarios });

    const b1 = result.modifiedRows.find((r) => r._rowId === 'b1');
    assert.ok(b1);
    assert.equal(b1.FundType, 'HX-out', '高优先级 HX-out 先跑改成 HX-out，charge 不再满足 Charge 条件');
    assert.ok(b1._modifiedColumns.has('FundType'));
  });
});

// ---------------------------------------------------------------------------
// 🔴 PR#62 P1：保留 R2 锁定但未改值的命中行
//   先用 dispatcher 直证 fixture「锁定双方但 modifications 为空」，再断编排器把它们留在 modifiedRows。
// ---------------------------------------------------------------------------
test.describe('R2 锁定但未改值的命中行（PR#62 P1）', () => {
  // 银行行：一对配对行（L1/R1），R1 的 Transaction Description 已等于目标值 '已对账'
  //   + 一行完全不命中（b0）做行数守恒对照。
  const mkRows = () => [
    // 对照行：BillTag 用中文 '普通'，绝不含字母 L/R（'包含' 匹配大小写敏感、按子串）→ 不入 type1/type2
    makeBankRow({ _rowId: 'b0', BillTag: '普通' }),                   // 不含 L/R → 不命中
    makeBankRow({ _rowId: 'L1', BillTag: 'L', PairKey: 'K1', 'Transaction Description': '' }),
    // R1 的标记字段已等于 markValue.value → 配对锁定但不 record
    makeBankRow({ _rowId: 'R1', BillTag: 'R', PairKey: 'K1', 'Transaction Description': '已对账' })
  ];

  test('前置：dispatcher 确认 L1/R1 被锁定进 modifiedRows 但 modifications 为空（_modifiedColumns 空 Set）', () => {
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

  test('编排器：R2 锁定未改值行进 modifiedRows（带 R2 元数据 + 空 Set）、不在 unmatchedRows、行数守恒', () => {
    const bankRows = mkRows();
    const total = bankRows.length;
    const result = runReconciliation({ bankRows, gwRows: [], scenarios: [makeR2PairLockNoChangeScenario()] });

    const modIds = result.modifiedRows.map((r) => r._rowId).sort();
    // ① L1/R1 在 modifiedRows（旧逻辑只看 modColsByRowId.has 会漏掉它们 → 掉进 unmatched）
    assert.deepEqual(modIds, ['L1', 'R1'], 'R2 锁定未改值的 L1/R1 应保留在 modifiedRows');

    for (const id of ['L1', 'R1']) {
      const row = result.modifiedRows.find((r) => r._rowId === id);
      assert.ok(row, `${id} 应在 modifiedRows`);
      // 带 R2 命中元数据（命中场景行报表依赖）
      assert.equal(row._hitScenarioId, 210, `${id} 应保留 R2 命中场景 id`);
      assert.equal(row._hitScenarioName, 'R2-配对锁定不改值', `${id} 应保留 R2 命中场景名`);
      // _modifiedColumns 是空 Set（不标黄，但仍为命中）
      assert.ok(row._modifiedColumns instanceof Set, `${id} _modifiedColumns 必须是 Set`);
      assert.equal(row._modifiedColumns.size, 0, `${id} 锁定未改值 → _modifiedColumns 为空 Set（不标黄）`);
    }

    // ② 不在 unmatchedRows（只剩完全不命中的 b0）
    const unmatchedIds = result.unmatchedRows.map((r) => r._rowId).sort();
    assert.deepEqual(unmatchedIds, ['b0'], 'L1/R1 不应在 unmatchedRows（已被 R2 消费），仅 b0 未命中');

    // ③ 行数守恒
    assert.equal(
      result.modifiedRows.length + result.unmatchedRows.length,
      total,
      'modifiedRows + unmatchedRows === bankRows.length'
    );
  });
});

// ---------------------------------------------------------------------------
// 断言 6：R2 零回归（与直接调 dispatcher 一致）
// ---------------------------------------------------------------------------
test.describe('R2 零回归', () => {
  test('只给一个普通 C2 → 落 R2，modifiedRows 与直接调 dispatcher 行为一致（命中元数据在）', () => {
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
    const orch = runReconciliation({ bankRows: orchRows, gwRows: [], scenarios: [scenario] });

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
  test('scenarios 为空数组 → 全部轮 no-op，不报错，行数守恒，无修改', () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', FundType: 'Charge' }),
      makeBankRow({ _rowId: 'b2', FundType: 'Refund' })
    ];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-X', TradeType: 'Charge' })];
    const result = runReconciliation({ bankRows, gwRows, scenarios: [] });

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

  test('只启用 R5 场景3（其它 bucket 空）→ 仅产剔除文件，R2/R4/R5s2 no-op', () => {
    const bankRows = [
      makeBankRow({ _rowId: 'b1', ReconciliationId: 'RC-INB', FundType: 'Refund', MerchantId: 'M003' }),
      makeBankRow({ _rowId: 'b2', FundType: 'Charge', BillTag: 'OFFSET-A' }) // 无 R2 场景启用 → 不应被改
    ];
    const gwRows = [makeGwRow({ reconciliationid: 'RC-INB', TradeType: 'Inbound-VA', orderid: 'ORD-INB' })];
    const result = runReconciliation({ bankRows, gwRows, scenarios: [makeR5CleanupScenario()] });

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
  test('_modifiedColumns 是新建 Set（与累积 Map 解耦）+ 嫁接 R2 元数据排除 _rowId/_modifiedColumns', () => {
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
