// v2.0.0-beta.3 PR #31：场景算法引擎单元测试
// 接入 smoke 流程（runScenarioEngineSmokeTests 由 smoke-test.js 调用）
// 覆盖 Codex F1+F2+F3 修复后的所有边界
//
// 使用 Node 内置 assert（无外部 test framework 依赖，与现有 smoke 风格一致）

const assert = require('node:assert/strict');

const {
  runScenario,
  runC1Scenario,
  runC2Scenario,
  runC3Scenario
} = require('../../src/main-process/scenario-engines');
const { buildFeatureRegex } = require('../../src/main-process/scenario-engines/c1-extract-recon-id');

function makeC1Scenario() {
  return {
    id: 1,
    name: '调拨ReconId自提取',
    category: 'extract-recon-id',
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
      extractByFeature: {
        enabled: true,
        searchFields: ['CustomerRef', 'Extra Information'],
        featureCode: 'FT',
        digitCount: 12,
        totalLength: 15
      },
      extractByOtherField: null
    }
  };
}

function makeC2Scenario() {
  return {
    id: 2,
    name: 'outbound Fail打标',
    category: 'offset-bill-mark',
    config: {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'CustomerRef',   rightType: 2, rightField: 'CustomerRef' },
        { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
      ],
      markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
    }
  };
}

function makeC3Scenario() {
  return {
    id: 3,
    name: '调拨ReconId From网关',
    category: 'gateway-recon-join',
    config: {
      reconFields: [
        { seq: 1, gwField: 'Currency',   bankField: 'Currency' },
        { seq: 2, gwField: 'Amount',     bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank',       bankField: 'Channel' }
      ],
      assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
    }
  };
}

function runScenarioEngineSmokeTests() {
  // ===== C1 =====
  // C1-1：regex 构建
  const re1 = buildFeatureRegex({ featureCode: 'FT', digitCount: 12, totalLength: 15 });
  assert.strictEqual(re1.source, '[A-Z]{1}FT\\d{12}', 'C1-1 regex 构建错误');

  // C1-2：总位数 = 数字 + 特征长度时无前缀
  const re2 = buildFeatureRegex({ featureCode: 'FT', digitCount: 12, totalLength: 14 });
  assert.strictEqual(re2.source, 'FT\\d{12}', 'C1-2 regex 无前缀错误');

  // C1-3：单字段命中 + 写入
  {
    const rows = [{ _rowId: 'r1', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: '' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, 'AFT123456789012', 'C1-3 写入失败');
    assert(result.lockedRowIds.has('r1'), 'C1-3 未锁定 r1');
    assert.strictEqual(result.modifications.length, 1, 'C1-3 modifications 数量');
  }

  // C1-4：多字段值一致 → 写入
  {
    const rows = [{ _rowId: 'r2', CustomerRef: 'BFT222333444555', 'Extra Information': '前缀 BFT222333444555 后缀', ReconciliationId: '' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, 'BFT222333444555', 'C1-4 写入失败');
    assert.strictEqual(result.warnings.length, 0, 'C1-4 一致不应 warn');
  }

  // C1-5：多字段值不一致 → 跳过 + warn
  {
    const rows = [{ _rowId: 'r3', CustomerRef: 'AFT111111111111', 'Extra Information': 'BFT222222222222', ReconciliationId: '' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, '', 'C1-5 不应写入');
    assert(result.warnings.some(w => w.code === 'inconsistent-recon-id-values'), 'C1-5 应有不一致 warn');
  }

  // C1-6：单字段同时含两个不同 ReconId → 跳过 + warn
  {
    const rows = [{ _rowId: 'r4', CustomerRef: 'AFT111111111111 / BFT222222222222', 'Extra Information': '', ReconciliationId: '' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, '', 'C1-6 不应写入');
    assert(result.warnings.length > 0, 'C1-6 应有 warn');
  }

  // C1-7：condition 不满足 → 不命中
  {
    const rows = [{ _rowId: 'r5', CustomerRef: 'no_match', 'Extra Information': '', ReconciliationId: '' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(result.lockedRowIds.size, 0, 'C1-7 不应命中');
  }

  // C1-8：原值非空 + 不同 → 直接覆盖（不再产生 warn，UX 决策 2026-04-29 PR #32b）
  {
    const rows = [{ _rowId: 'r6', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: 'OLD' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, 'AFT123456789012', 'C1-8 应覆盖');
    assert(!result.warnings.some(w => w.code === 'overwrite-existing-recon-id'), 'C1-8 不应再产生 overwrite warn');
  }

  // C1-9：extractByOtherField 模式
  {
    const otherFieldScenario = {
      id: 99, name: 'other-field', category: 'extract-recon-id',
      config: {
        conditions: [{ field: 'Currency', op: '等于', value: 'USD' }],
        extractByFeature: null,
        extractByOtherField: { field: 'CustomerRef' }
      }
    };
    const rows = [{ _rowId: 'r7', Currency: 'USD', CustomerRef: 'CUSTOM_VAL_123', ReconciliationId: '' }];
    runC1Scenario(otherFieldScenario, rows);
    assert.strictEqual(rows[0].ReconciliationId, 'CUSTOM_VAL_123', 'C1-9 应复制 CustomerRef');
  }

  // ===== v2.1.7 F1：C1 conditionsLogic AND/OR 切换 smoke（spec §2.4 Case F1-A/B/C/D）=====
  // 工厂：基于 extractByOtherField 模式（最小依赖；不挑 regex 路径）
  function makeC1ScenarioWithLogic(conditions, conditionsLogic) {
    return {
      id: 100, name: 'c1-logic', category: 'extract-recon-id',
      config: {
        conditions,
        ...(conditionsLogic !== undefined ? { conditionsLogic } : {}),
        extractByFeature: null,
        extractByOtherField: { field: 'A' }
      }
    };
  }

  // F1-A：conditions=[A=true, B=false], logic='OR' → 命中
  // A 字段 = 'X'（条件 A==='X' true）；B 字段 = 'Q'（条件 B==='Y' false）
  {
    const scen = makeC1ScenarioWithLogic([
      { field: 'A', op: '等于', value: 'X' },
      { field: 'B', op: '等于', value: 'Y' }
    ], 'OR');
    const rows = [{ _rowId: 'f1a', A: 'X', B: 'Q', ReconciliationId: '' }];
    runC1Scenario(scen, rows);
    assert.strictEqual(rows[0].ReconciliationId, 'X', 'F1-A OR 一真即命中');
  }

  // F1-B：conditions=[A=true, B=false], logic='AND' → 不命中
  {
    const scen = makeC1ScenarioWithLogic([
      { field: 'A', op: '等于', value: 'X' },
      { field: 'B', op: '等于', value: 'Y' }
    ], 'AND');
    const rows = [{ _rowId: 'f1b', A: 'X', B: 'Q', ReconciliationId: '' }];
    runC1Scenario(scen, rows);
    assert.strictEqual(rows[0].ReconciliationId, '', 'F1-B AND 一假即不命中');
  }

  // F1-C：conditions=[A=true, B=true], logic='AND' → 命中
  {
    const scen = makeC1ScenarioWithLogic([
      { field: 'A', op: '等于', value: 'X' },
      { field: 'B', op: '等于', value: 'Y' }
    ], 'AND');
    const rows = [{ _rowId: 'f1c', A: 'X', B: 'Y', ReconciliationId: '' }];
    runC1Scenario(scen, rows);
    assert.strictEqual(rows[0].ReconciliationId, 'X', 'F1-C AND 全真即命中');
  }

  // F1-D：scenario.config 无 conditionsLogic 字段（模拟 v2.1.6 老数据）
  //   引擎 fallback OR；与原 v2.1.6 OR 行为完全一致
  //   conditions=[A=true, B=false] → OR fallback 命中（如 F1-A）
  {
    const scen = makeC1ScenarioWithLogic([
      { field: 'A', op: '等于', value: 'X' },
      { field: 'B', op: '等于', value: 'Y' }
    ], undefined); // 不传 logic
    assert.strictEqual(scen.config.conditionsLogic, undefined, 'F1-D 前置：fixture 不含 conditionsLogic 字段');
    const rows = [{ _rowId: 'f1d', A: 'X', B: 'Q', ReconciliationId: '' }];
    runC1Scenario(scen, rows);
    assert.strictEqual(rows[0].ReconciliationId, 'X', 'F1-D 老数据 fallback OR 命中（与 v2.1.6 一致）');
  }

  // ===== C2 =====
  // C2-1：一对一配对 → 改 type2 行 + 双方都进 lockedRowIds
  {
    const rows = [
      { _rowId: 'rA', FundType: 'outbound Fail', CustomerRef: 'CUST-A', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'rB', FundType: 'outbound',      CustomerRef: 'CUST-A', 'Credit Amount': 0,   'Debit Amount': 100 }
    ];
    const result = runC2Scenario(makeC2Scenario(), rows);
    assert.strictEqual(rows[1].FundType, 'outbound Fail', 'C2-1 rB 未打标');
    assert(result.lockedRowIds.has('rA'), 'C2-1 leftRow rA 必须进 lockedRowIds（PRD §7.2 + Codex F2 修复）');
    assert(result.lockedRowIds.has('rB'), 'C2-1 rightRow rB 应在 lockedRowIds');
    assert.strictEqual(result.lockedRowIds.size, 2, 'C2-1 lockedRowIds 应含 2 行');
    assert.strictEqual(result.modifications.length, 1, 'C2-1 仅 rightRow 改字段');
  }

  // C2-2：一对多 → 报错 + 不打标
  {
    const rows = [
      { _rowId: 'rA', FundType: 'outbound Fail', CustomerRef: 'CUST-X', 'Credit Amount': 50, 'Debit Amount': 0 },
      { _rowId: 'rB', FundType: 'outbound',      CustomerRef: 'CUST-X', 'Credit Amount': 0, 'Debit Amount': 50 },
      { _rowId: 'rC', FundType: 'outbound',      CustomerRef: 'CUST-X', 'Credit Amount': 0, 'Debit Amount': 50 }
    ];
    const result = runC2Scenario(makeC2Scenario(), rows);
    assert(result.warnings.some(w => w.code === 'one-to-many'), 'C2-2 应 warn one-to-many');
    assert.strictEqual(rows[1].FundType, 'outbound', 'C2-2 rB 不应打标');
    assert.strictEqual(rows[2].FundType, 'outbound', 'C2-2 rC 不应打标');
  }

  // C2-3：多对一 → 报错 + blocked rightRow 不打标
  {
    const rows = [
      { _rowId: 'rA', FundType: 'outbound Fail', CustomerRef: 'CUST-Y', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'rA2', FundType: 'outbound Fail', CustomerRef: 'CUST-Y', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'rB', FundType: 'outbound',      CustomerRef: 'CUST-Y', 'Credit Amount': 0, 'Debit Amount': 100 }
    ];
    const result = runC2Scenario(makeC2Scenario(), rows);
    assert(result.warnings.some(w => w.code === 'many-to-one'), 'C2-3 应 warn many-to-one');
    assert.strictEqual(rows[2].FundType, 'outbound', 'C2-3 多对一 rightRow 不应打标');
  }

  // C2-4：类型不匹配 → 不命中
  {
    const rows = [{ _rowId: 'rA', FundType: 'unrelated', CustomerRef: 'X', 'Credit Amount': 1, 'Debit Amount': 0 }];
    const result = runC2Scenario(makeC2Scenario(), rows);
    assert.strictEqual(result.lockedRowIds.size, 0, 'C2-4 不应命中');
  }

  // C2-5（Codex F1 P1 修复）：bankRows 没有 _rowId → ensureRowId 自动写回
  {
    const rows = [
      { FundType: 'outbound Fail', CustomerRef: 'CUST-Z', 'Credit Amount': 99, 'Debit Amount': 0 },
      { FundType: 'outbound',      CustomerRef: 'CUST-Z', 'Credit Amount': 0, 'Debit Amount': 99 }
    ];
    const result = runC2Scenario(makeC2Scenario(), rows);
    assert(rows[0]._rowId !== undefined && rows[0]._rowId !== null, 'C2-5 ensureRowId 应写回 _rowId');
    assert(rows[1]._rowId !== undefined && rows[1]._rowId !== null, 'C2-5 ensureRowId 应写回 _rowId');
    assert.strictEqual(result.lockedRowIds.size, 2, 'C2-5 lockedRowIds 应含 2 行（不是 undefined）');
    assert(!result.lockedRowIds.has(undefined), 'C2-5 lockedRowIds 不应含 undefined');
    assert(rows[1].FundType === 'outbound Fail', 'C2-5 rightRow 应被打标');
  }

  // ===== C3 =====
  // C3-1：4 字段 AND + 发生额绝对值
  {
    const bankRows = [{ _rowId: 'b1', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_999' }];
    const result = runC3Scenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_999', 'C3-1 应写入 GW_999');
    assert(result.lockedRowIds.has('b1'), 'C3-1 应锁 b1');
  }

  // C3-2：没匹配 → 保留原值
  {
    const bankRows = [{ _rowId: 'b2', Currency: 'USD', 'Credit Amount': 0, 'Debit Amount': 50, MerchantId: 'M002', Channel: 'BankA', ReconciliationId: 'KEEP' }];
    const gwRows = [{ Currency: 'CNY', Amount: 50, MerchantId: 'M999', Bank: 'BankA', reconciliationId: 'NO_MATCH' }];
    runC3Scenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'KEEP', 'C3-2 不匹配应保留原值');
  }

  // C3-3：多行匹配 → 取首 + warn
  {
    const bankRows = [{ _rowId: 'b3', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'FIRST' },
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'SECOND' }
    ];
    const result = runC3Scenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'FIRST', 'C3-3 应取第一条');
    assert(result.warnings.some(w => w.code === 'multi-gateway-match'), 'C3-3 应有 multi-gateway-match warn');
  }

  // C3-4：原值非空 + 不同 → 直接覆盖（不再产生 warn，UX 决策 2026-04-29 PR #32b）
  {
    const bankRows = [{ _rowId: 'b4', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: 'OLD' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'NEW' }];
    const result = runC3Scenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'NEW', 'C3-4 应覆盖');
    assert(!result.warnings.some(w => w.code === 'overwrite-existing-value'), 'C3-4 不应再产生 overwrite warn');
  }

  // C3-5（Codex F3 P1 修复回归）：内置 seed 大写 Currency 字段名能命中
  // 历史 bug：seed 使用小写 'currency'，gwRow['currency'] === undefined → 整行不命中
  // 修复后必须用 'Currency'
  {
    const bankRows = [{ _rowId: 'b5', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'OK_BIG_C' }];
    runScenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'OK_BIG_C', 'C3-5 大写 Currency 必须命中（防 F3 回归）');
  }

  // C3-6 入口分发
  {
    const bankRows = [{ _rowId: 'b6', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'DISPATCH' }];
    runScenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'DISPATCH', 'C3-6 runScenario 入口分发应工作');
  }

  // C3-7（Codex Round 2 F1 P1 回归）：gwRows 为空 → 不抛错 + warn no-gateway-rows
  {
    const bankRows = [{ _rowId: 'b7', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const result = runC3Scenario(makeC3Scenario(), bankRows, []);
    assert(result.warnings.some(w => w.code === 'no-gateway-rows'), 'C3-7 应 warn no-gateway-rows');
    assert.strictEqual(result.lockedRowIds.size, 0, 'C3-7 不应锁任何行');
    assert.strictEqual(result.modifications.length, 0, 'C3-7 不应有 modifications');
  }

  // C3-8（Codex Round 2 F1 P1 回归）：reconFields 为空 → 不抛错 + warn invalid-config
  {
    const bankRows = [{ _rowId: 'b8', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'X' }];
    const emptyReconScenario = {
      id: 8, name: 'empty-recon', category: 'gateway-recon-join',
      config: { reconFields: [], assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' } }
    };
    const result = runC3Scenario(emptyReconScenario, bankRows, gwRows);
    assert(result.warnings.some(w => w.code === 'invalid-config'), 'C3-8 应 warn invalid-config');
    assert.strictEqual(result.lockedRowIds.size, 0, 'C3-8 不应锁任何行');
  }

  // C3-9（Codex Round 2 F1 P1 回归）：assign 缺失 → 不抛错 + warn invalid-config
  {
    const bankRows = [{ _rowId: 'b9', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'X' }];
    const noAssignScenario = {
      id: 9, name: 'no-assign', category: 'gateway-recon-join',
      config: {
        reconFields: [{ seq: 1, gwField: 'Currency', bankField: 'Currency' }],
        assign: {}
      }
    };
    const result = runC3Scenario(noAssignScenario, bankRows, gwRows);
    assert(result.warnings.some(w => w.code === 'invalid-config'), 'C3-9 应 warn invalid-config');
    assert.strictEqual(result.lockedRowIds.size, 0, 'C3-9 不应锁任何行');
  }

  // ===== v2.1.5 N3：C3 conditions 段（spec §6 / §4.5）=====
  // 工厂：基于 makeC3Scenario 注入 conditions（不修改 baseline 行为）
  function makeC3ScenarioWithConditions(conditions) {
    const s = makeC3Scenario();
    s.config.conditions = conditions;
    return s;
  }

  // C3-COND-1：网关单侧 1 条条件 AND 过滤
  // gwRow USD 行通过条件；CNY 行被过滤掉，只有 USD 行参与 join
  // bankRow 配 USD → join 命中 USD gwRow，写入 GW_USD
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Currency', op: '等于', value: 'USD' }
    ]);
    const bankRows = [
      { _rowId: 'b-usd', Currency: 'USD', 'Credit Amount': 200, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const gwRows = [
      { Currency: 'USD', Amount: 200, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_USD' },
      { Currency: 'CNY', Amount: 200, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_CNY' }
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_USD', 'C3-COND-1 应只命中 USD 网关行');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-1 modifications 仅 1 条');
    assert.strictEqual(result.modifications[0].newValue, 'GW_USD', 'C3-COND-1 modification newValue=GW_USD');
    // 防御断言：CNY 行被条件过滤后没机会被命中（即使 reconFields 也匹配）
    assert(!result.warnings.some(w => w.code === 'multi-gateway-match'), 'C3-COND-1 不应有 multi 警告（CNY 已被过滤）');
  }

  // C3-COND-2：双侧 AND（网关 + 银行 各 1 条）
  // 两侧都过滤 USD 行；只有 USD-on-USD 的 join 命中
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Currency', op: '等于', value: 'USD' },
      { side: '银行', field: 'Currency', op: '等于', value: 'USD' }
    ]);
    const bankRows = [
      { _rowId: 'b-usd', Currency: 'USD', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' },
      { _rowId: 'b-cny', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const gwRows = [
      { Currency: 'USD', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_USD' },
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_CNY' }
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_USD', 'C3-COND-2 USD 行应命中 USD 网关');
    assert.strictEqual(bankRows[1].ReconciliationId, '', 'C3-COND-2 CNY 行应被银行侧条件过滤');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-2 modifications 仅 1 条');
    assert(result.lockedRowIds.has('b-usd'), 'C3-COND-2 应锁 b-usd');
    assert(!result.lockedRowIds.has('b-cny'), 'C3-COND-2 不应锁 b-cny');
  }

  // C3-COND-VIRTUAL：银行侧虚拟字段「发生额绝对值」
  // 必须走 getBankRowValueForC3 → Math.abs(Credit - Debit)
  // bankRow 1: Credit=100, Debit=0   → 虚拟值 100 ✅
  // bankRow 2: Credit=0,   Debit=100 → 虚拟值 100 ✅（abs）
  // bankRow 3: Credit=200, Debit=50  → 虚拟值 150 ❌
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '银行', field: '发生额绝对值', op: '等于', value: '100' }
    ]);
    // 注意：scenario.config.reconFields 的 seq=2 也用「发生额绝对值」做 join；
    // 为了让 bankRow 1/2 在 join 阶段都命中相同的 gwRow，让它们 Currency/MerchantId/Channel 一致
    const bankRows = [
      { _rowId: 'b-virt-1', Currency: 'USD', 'Credit Amount': 100, 'Debit Amount': 0,   MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' },
      { _rowId: 'b-virt-2', Currency: 'USD', 'Credit Amount': 0,   'Debit Amount': 100, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' },
      { _rowId: 'b-virt-3', Currency: 'USD', 'Credit Amount': 200, 'Debit Amount': 50,  MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const gwRows = [
      { Currency: 'USD', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_100' }
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_100', 'C3-COND-VIRTUAL b-virt-1 (Credit=100) 应命中虚拟值 100');
    assert.strictEqual(bankRows[1].ReconciliationId, 'GW_100', 'C3-COND-VIRTUAL b-virt-2 (Debit=100) 应命中虚拟值 100');
    assert.strictEqual(bankRows[2].ReconciliationId, '', 'C3-COND-VIRTUAL b-virt-3 (虚拟值 150) 应被过滤');
    assert.strictEqual(result.modifications.length, 2, 'C3-COND-VIRTUAL modifications 应为 2 条');
  }

  // C3-COND-EMPTY：conditions = [] 退化等同 v2.1.4 行为
  // 用 C3-1 的 baseline 数据 + conditions=[] → modifications 应与 baseline 完全一致
  // baseline (C3-1)：bankRow CNY+100 / gwRow CNY+100/M001/BankA → 写入 GW_999
  {
    const scenario = makeC3ScenarioWithConditions([]); // 显式空数组
    const bankRows = [{ _rowId: 'b1', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_999' }];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_999', 'C3-COND-EMPTY 应等同 baseline C3-1 行为');
    assert(result.lockedRowIds.has('b1'), 'C3-COND-EMPTY 应锁 b1（同 baseline）');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-EMPTY modifications 数量同 baseline');
  }

  // C3-COND-LEGACY：旧场景无 conditions 字段
  // scenario.config 不含 conditions key（模拟 v2.1.4 老数据）
  // 引擎应兜底为 [] → 退化为现有行为；与 baseline C3-1 一致
  {
    const scenario = makeC3Scenario(); // 不注入 conditions
    assert.strictEqual(scenario.config.conditions, undefined, 'C3-COND-LEGACY 前置：fixture 不含 conditions 字段');
    const bankRows = [{ _rowId: 'b1-legacy', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_999' }];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_999', 'C3-COND-LEGACY 旧 DB 数据应等同 baseline');
    assert(result.lockedRowIds.has('b1-legacy'), 'C3-COND-LEGACY 应锁 b1-legacy');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-LEGACY modifications 数量同 baseline');
  }

  // C3-COND-OP-EMPTY：op = 空值 / 非空值 各 1 case
  // case A：'空值' → 网关 reconciliationId 为空的行进入 join → 写入空字符串（不写）
  // case B：'非空值' → 网关 reconciliationId 非空的行进入 join → 写入对应 ID
  {
    // case A：空值
    const scenarioA = makeC3ScenarioWithConditions([
      { side: '网关', field: 'reconciliationId', op: '空值' }
    ]);
    const bankRowsA = [{ _rowId: 'bA', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: 'KEEP_A' }];
    const gwRowsA = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: '' },        // 空值 ✅ 通过条件
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'NON_EMPTY' } // 非空 ❌ 被过滤
    ];
    const resultA = runC3Scenario(scenarioA, bankRowsA, gwRowsA);
    // 唯一通过条件的 gwRow.reconciliationId='' → assign chosen[gwField] 是 '' → 引擎跳过写入（normalizeCellValue 后不写）
    assert.strictEqual(bankRowsA[0].ReconciliationId, 'KEEP_A', 'C3-COND-OP-EMPTY-A 网关源字段为空 → 不写入（保留原值）');
    assert.strictEqual(resultA.modifications.length, 0, 'C3-COND-OP-EMPTY-A 不产生 modifications');
    // 关键防御：未抛异常 + 没误命中 NON_EMPTY 行
    assert(!resultA.warnings.some(w => w.code === 'multi-gateway-match'), 'C3-COND-OP-EMPTY-A 不应有 multi 警告（NON_EMPTY 已过滤）');

    // case B：非空值
    const scenarioB = makeC3ScenarioWithConditions([
      { side: '网关', field: 'reconciliationId', op: '非空值' }
    ]);
    const bankRowsB = [{ _rowId: 'bB', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRowsB = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: '' },        // 空 ❌
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'NON_EMPTY' } // 非空 ✅
    ];
    const resultB = runC3Scenario(scenarioB, bankRowsB, gwRowsB);
    assert.strictEqual(bankRowsB[0].ReconciliationId, 'NON_EMPTY', 'C3-COND-OP-EMPTY-B 应命中 NON_EMPTY 网关行');
    assert.strictEqual(resultB.modifications.length, 1, 'C3-COND-OP-EMPTY-B modifications 仅 1 条');
  }

  // C3-COND-OP-ALL：剩下 5 种 op 各 1 case（等于 / 不等于 / 包含 / 不包含 / 开头为）
  // 每个 op：1 行条件 + 2 行 gwRows（一行匹配一行不匹配） + 1 行 bankRow
  function runOpCase(op, value, gw1Currency, gw2Currency, expectedReconId) {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Currency', op, value }
    ]);
    const bankRows = [{ _rowId: `b-${op}`, Currency: gw1Currency, 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [
      { Currency: gw1Currency, Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_OK' },  // 匹配条件 → 通过
      { Currency: gw2Currency, Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_NO' }   // 不匹配 → 被过滤
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    return { reconId: bankRows[0].ReconciliationId, modCount: result.modifications.length };
  }

  // 等于：Currency=USD → USD 行通过，CNY 行过滤
  {
    const r = runOpCase('等于', 'USD', 'USD', 'CNY', 'GW_OK');
    assert.strictEqual(r.reconId, 'GW_OK', 'C3-COND-OP-ALL[等于] 应命中 USD 网关');
    assert.strictEqual(r.modCount, 1, 'C3-COND-OP-ALL[等于] mod 数 1');
  }
  // 不等于：Currency≠USD → USD 行过滤；用 CNY 与 USD 测试
  // 注意 bankRow Currency 必须能在 reconFields 中与 gwRow Currency 匹配
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Currency', op: '不等于', value: 'USD' }
    ]);
    const bankRows = [{ _rowId: 'b-neq', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [
      { Currency: 'USD', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_USD' }, // 等于 USD → 被过滤
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_CNY' }  // 不等于 USD → 通过
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_CNY', 'C3-COND-OP-ALL[不等于] 应命中 CNY 网关');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-OP-ALL[不等于] mod 数 1');
  }
  // 包含：Bank 字段 op=包含 'USD' → "USD-Bank" 通过；"CNY-Bank" 过滤
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Bank', op: '包含', value: 'USD' }
    ]);
    const bankRows = [{ _rowId: 'b-contains', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'USD-Bank', ReconciliationId: '' }];
    const gwRows = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'USD-Bank', reconciliationId: 'GW_OK' }, // 包含 USD ✅
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'CNY-Bank', reconciliationId: 'GW_NO' }  // 不含 USD ❌
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_OK', 'C3-COND-OP-ALL[包含] 应命中 USD-Bank');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-OP-ALL[包含] mod 数 1');
  }
  // 不包含：Bank 字段 op=不包含 'USD' → "CNY-Bank" 通过；"USD-Bank" 过滤
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'Bank', op: '不包含', value: 'USD' }
    ]);
    const bankRows = [{ _rowId: 'b-notcontains', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'CNY-Bank', ReconciliationId: '' }];
    const gwRows = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'USD-Bank', reconciliationId: 'GW_NO' },  // 含 USD ❌
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'CNY-Bank', reconciliationId: 'GW_OK' }   // 不含 ✅
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_OK', 'C3-COND-OP-ALL[不包含] 应命中 CNY-Bank');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-OP-ALL[不包含] mod 数 1');
  }
  // 开头为：reconciliationId 字段 op='开头为' value='REF_' → "REF_001" 通过；"GW_002" 过滤
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: 'reconciliationId', op: '开头为', value: 'REF_' }
    ]);
    const bankRows = [{ _rowId: 'b-startsWith', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'REF_001' }, // 开头 REF_ ✅
      { Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_002' }   // ❌
    ];
    const result = runC3Scenario(scenario, bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'REF_001', 'C3-COND-OP-ALL[开头为] 应命中 REF_001');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-OP-ALL[开头为] mod 数 1');
  }

  // C3-COND-CLEAR：左一切换字段清空后引擎不报错
  // conditions = [{ side: '网关', field: '', op: '等于', value: 'X' }]（field 为空模拟左一切换后未填）
  // 引擎应跳过该条件（spec §4.5.1：!cd.field → return true）→ 退化为不过滤
  // 等同于 baseline C3-1 行为
  {
    const scenario = makeC3ScenarioWithConditions([
      { side: '网关', field: '', op: '等于', value: 'X' }
    ]);
    const bankRows = [{ _rowId: 'b1-clear', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_999' }];
    let result;
    assert.doesNotThrow(() => {
      result = runC3Scenario(scenario, bankRows, gwRows);
    }, 'C3-COND-CLEAR field 为空不应抛异常');
    assert.strictEqual(bankRows[0].ReconciliationId, 'GW_999', 'C3-COND-CLEAR 应等同 baseline（field 空 → 视为无效条件，不过滤）');
    assert.strictEqual(result.modifications.length, 1, 'C3-COND-CLEAR modifications 数量同 baseline');
  }

  console.log('  scenario-engines: 35/35 PASS');
}

module.exports = {
  runScenarioEngineSmokeTests
};
