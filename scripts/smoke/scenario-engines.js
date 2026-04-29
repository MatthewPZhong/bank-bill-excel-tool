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

  // C1-8：原值非空 + 不同 → warn + 覆盖
  {
    const rows = [{ _rowId: 'r6', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: 'OLD' }];
    const result = runC1Scenario(makeC1Scenario(), rows);
    assert.strictEqual(rows[0].ReconciliationId, 'AFT123456789012', 'C1-8 应覆盖');
    assert(result.warnings.some(w => w.code === 'overwrite-existing-recon-id'), 'C1-8 应有覆盖 warn');
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

  // C3-4：原值非空 + 不同 → warn + 覆盖
  {
    const bankRows = [{ _rowId: 'b4', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: 'OLD' }];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'NEW' }];
    const result = runC3Scenario(makeC3Scenario(), bankRows, gwRows);
    assert.strictEqual(bankRows[0].ReconciliationId, 'NEW', 'C3-4 应覆盖');
    assert(result.warnings.some(w => w.code === 'overwrite-existing-value'), 'C3-4 应有覆盖 warn');
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

  console.log('  scenario-engines: 23/23 PASS');
}

module.exports = {
  runScenarioEngineSmokeTests
};
