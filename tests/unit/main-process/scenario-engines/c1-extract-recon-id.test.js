const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECONCILIATION_ID_COLUMN,
  buildFeatureRegex,
  runC1Scenario
} = require('../../../../src/main-process/scenario-engines/c1-extract-recon-id');

// ========================================================================
// 常量
// ========================================================================

test.describe('RECONCILIATION_ID_COLUMN', () => {
  test('= ReconciliationId', () => {
    assert.equal(RECONCILIATION_ID_COLUMN, 'ReconciliationId');
  });
});

// ========================================================================
// buildFeatureRegex
// ========================================================================

test.describe('buildFeatureRegex', () => {
  test('totalLength = featureCode.length + digitCount → 无 [A-Z] 前缀', () => {
    const r = buildFeatureRegex({ featureCode: 'AB', digitCount: 5, totalLength: 7 });
    assert.equal(r.source, 'AB\\d{5}');
    assert.equal(r.flags, 'g');
  });

  test('totalLength > featureCode + digitCount → 有 [A-Z]{N} 前缀', () => {
    const r = buildFeatureRegex({ featureCode: 'AB', digitCount: 5, totalLength: 10 });
    assert.equal(r.source, '[A-Z]{3}AB\\d{5}'); // 10 - 2 - 5 = 3
  });

  test('参数总长 < featureCode + digit → 抛错', () => {
    assert.throws(() => buildFeatureRegex({ featureCode: 'ABCDE', digitCount: 5, totalLength: 7 }), /非法特征参数/);
  });

  test('regex 真实匹配 — 全 5 位数字', () => {
    const r = buildFeatureRegex({ featureCode: 'AB', digitCount: 5, totalLength: 7 });
    const result = 'foo AB12345 bar'.match(r);
    assert.deepEqual(result, ['AB12345']);
  });

  test('regex 真实匹配 — 带英文前缀', () => {
    const r = buildFeatureRegex({ featureCode: 'X', digitCount: 3, totalLength: 7 });
    // pattern [A-Z]{3}X\d{3} → 'ABCX123'
    const result = 'pre ABCX123 post'.match(r);
    assert.deepEqual(result, ['ABCX123']);
  });

  test('featureCode 缺失（空串） + totalLength = digitCount → 仅 \\d{N}', () => {
    const r = buildFeatureRegex({ featureCode: '', digitCount: 5, totalLength: 5 });
    assert.equal(r.source, '\\d{5}');
  });
});

// ========================================================================
// runC1Scenario — extractByOtherField
// ========================================================================

test.describe('runC1Scenario — extractByOtherField 模式', () => {
  function makeScenario(conditions, extractField) {
    return {
      id: 1,
      name: 'C1-extract-other',
      config: {
        conditions,
        extractByOtherField: { field: extractField }
      }
    };
  }

  test('正常路径：条件命中 + 取字段值 → 写入 ReconciliationId', () => {
    const scenario = makeScenario(
      [{ field: 'channel', op: '等于', value: '通道A' }],
      'OrderId'
    );
    const rows = [
      { channel: '通道A', OrderId: 'ORDER-001', ReconciliationId: '' }
    ];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 1);
    assert.equal(rows[0].ReconciliationId, 'ORDER-001');
  });

  test('条件不命中 → 不修改', () => {
    const scenario = makeScenario(
      [{ field: 'channel', op: '等于', value: '通道A' }],
      'OrderId'
    );
    const rows = [
      { channel: '通道B', OrderId: 'ORDER-001', ReconciliationId: '' }
    ];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('取字段空 → 不修改', () => {
    const scenario = makeScenario(
      [{ field: 'channel', op: '等于', value: '通道A' }],
      'OrderId'
    );
    const rows = [{ channel: '通道A', OrderId: '', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('原值 = 新值 → 不算修改（first-match-wins 不锁定）', () => {
    const scenario = makeScenario(
      [{ field: 'channel', op: '等于', value: '通道A' }],
      'OrderId'
    );
    const rows = [{ channel: '通道A', OrderId: 'X', ReconciliationId: 'X' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
    assert.equal(r.lockedRowIds.size, 0);
  });

  test('空 conditions → 任意行都不命中', () => {
    const scenario = makeScenario([], 'OrderId');
    const rows = [{ OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });
});

// ========================================================================
// runC1Scenario — extractByFeature
// ========================================================================

test.describe('runC1Scenario — extractByFeature 模式', () => {
  function makeFeatureScenario(featureCfg, conditions = [{ field: 'channel', op: '等于', value: '通道A' }]) {
    return {
      id: 2,
      name: 'C1-feature',
      config: {
        conditions,
        extractByFeature: { enabled: true, ...featureCfg }
      }
    };
  }

  test('单字段提取 → 命中 + 写值', () => {
    const scenario = makeFeatureScenario({
      featureCode: 'AB',
      digitCount: 5,
      totalLength: 7,
      searchFields: ['Description']
    });
    const rows = [{
      channel: '通道A',
      Description: 'pay AB12345 ok',
      ReconciliationId: ''
    }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 1);
    assert.equal(rows[0].ReconciliationId, 'AB12345');
  });

  test('多字段提取 + 值一致 → 写值', () => {
    const scenario = makeFeatureScenario({
      featureCode: 'AB',
      digitCount: 5,
      totalLength: 7,
      searchFields: ['Field1', 'Field2']
    });
    const rows = [{
      channel: '通道A',
      Field1: 'foo AB12345',
      Field2: 'bar AB12345',
      ReconciliationId: ''
    }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(rows[0].ReconciliationId, 'AB12345');
  });

  test('多字段值不一致 → warn + 不写值', () => {
    const scenario = makeFeatureScenario({
      featureCode: 'AB',
      digitCount: 5,
      totalLength: 7,
      searchFields: ['Field1', 'Field2']
    });
    const rows = [{
      channel: '通道A',
      Field1: 'foo AB12345',
      Field2: 'bar AB99999',
      ReconciliationId: ''
    }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
    assert.equal(rows[0].ReconciliationId, '');
    assert.ok(r.warnings.some((w) => w.code === 'inconsistent-recon-id-values'));
  });

  test('无字段值匹配 → 不修改', () => {
    const scenario = makeFeatureScenario({
      featureCode: 'AB',
      digitCount: 5,
      totalLength: 7,
      searchFields: ['Description']
    });
    const rows = [{ channel: '通道A', Description: 'no match', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('字段空 → 跳过', () => {
    const scenario = makeFeatureScenario({
      featureCode: 'AB',
      digitCount: 5,
      totalLength: 7,
      searchFields: ['Description']
    });
    const rows = [{ channel: '通道A', Description: '', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });
});

// ========================================================================
// runC1Scenario — conditionsLogic AND/OR (v2.1.7 F1)
// ========================================================================

test.describe('runC1Scenario — conditionsLogic AND/OR', () => {
  function makeMultiCondScenario(logic) {
    return {
      id: 3,
      name: 'C1-multi-cond',
      config: {
        conditions: [
          { field: 'channel', op: '等于', value: '通道A' },
          { field: 'currency', op: '等于', value: 'CNY' }
        ],
        conditionsLogic: logic,
        extractByOtherField: { field: 'OrderId' }
      }
    };
  }

  test('AND：两个条件都满足 → 命中', () => {
    const scenario = makeMultiCondScenario('AND');
    const rows = [{ channel: '通道A', currency: 'CNY', OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(rows[0].ReconciliationId, 'X');
  });

  test('AND：仅一个满足 → 不命中', () => {
    const scenario = makeMultiCondScenario('AND');
    const rows = [{ channel: '通道A', currency: 'USD', OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('OR：仅一个满足 → 命中', () => {
    const scenario = makeMultiCondScenario('OR');
    const rows = [{ channel: '通道A', currency: 'USD', OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(rows[0].ReconciliationId, 'X');
  });

  test('OR：全不满足 → 不命中', () => {
    const scenario = makeMultiCondScenario('OR');
    const rows = [{ channel: '其它', currency: 'USD', OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('未指定 logic → fallback OR（向下兼容）', () => {
    const scenario = {
      id: 4,
      name: 'C1-no-logic',
      config: {
        conditions: [
          { field: 'channel', op: '等于', value: '通道A' },
          { field: 'currency', op: '等于', value: 'CNY' }
        ],
        extractByOtherField: { field: 'OrderId' }
      }
    };
    const rows = [{ channel: '通道A', currency: 'USD', OrderId: 'X', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(rows[0].ReconciliationId, 'X', 'OR fallback：仅 channel 命中即可');
  });
});

// ========================================================================
// runC1Scenario — 边界
// ========================================================================

test.describe('runC1Scenario — 边界', () => {
  test('空 bankRows → 空结果', () => {
    const scenario = {
      id: 1,
      name: 'C1',
      config: {
        conditions: [{ field: 'a', op: '等于', value: 'X' }],
        extractByOtherField: { field: 'b' }
      }
    };
    const r = runC1Scenario(scenario, []);
    assert.equal(r.modifications.length, 0);
    assert.equal(r.lockedRowIds.size, 0);
  });

  test('config 缺失 → 不抛错', () => {
    const scenario = { id: 1, name: 'C1' };
    const rows = [{ a: 'X' }];
    assert.doesNotThrow(() => runC1Scenario(scenario, rows));
  });

  test('配置 extractByOtherField + extractByFeature 同存：feature 优先', () => {
    const scenario = {
      id: 1,
      name: 'C1',
      config: {
        conditions: [{ field: 'channel', op: '等于', value: '通道A' }],
        extractByFeature: { enabled: true, featureCode: 'AB', digitCount: 5, totalLength: 7, searchFields: ['Desc'] },
        extractByOtherField: { field: 'OrderId' }
      }
    };
    const rows = [{ channel: '通道A', Desc: 'AB12345', OrderId: 'OTHER', ReconciliationId: '' }];
    const r = runC1Scenario(scenario, rows);
    assert.equal(rows[0].ReconciliationId, 'AB12345', 'feature 模式优先');
  });
});
