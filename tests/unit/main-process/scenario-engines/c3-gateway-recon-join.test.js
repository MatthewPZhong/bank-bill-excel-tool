const test = require('node:test');
const assert = require('node:assert/strict');

const { runC3Scenario } = require('../../../../src/main-process/scenario-engines/c3-gateway-recon-join');

// ========================================================================
// v2.1.8 N2 — C3「对账成立后赋值」新增"自取值"模式（assign-gw）
// spec.md §四 v0.7：mode='custom' + customValue 静态字符串作数据源
// ========================================================================

// 构造最小 c3 scenario
function makeScenario(assignOverrides) {
  return {
    id: 1,
    name: 'N2-test',
    config: {
      reconFields: [{ seq: 1, gwField: 'OrderId', bankField: 'OrderId' }],
      assign: Object.assign(
        { gwField: 'Reference', bankField: 'Narrative', mode: 'direct', customValue: '' },
        assignOverrides || {}
      )
    }
  };
}

test.describe('runC3Scenario — mode=direct 行为回归（v2.1.7 baseline）', () => {
  test('mode=direct：从 gw 字段取值写入 bank 字段', () => {
    const scenario = makeScenario({ mode: 'direct' });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: 'GW-REF-001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'GW-REF-001');
  });

  test('mode 字段缺失（老 scenario）→ 走 direct 路径（默认行为）', () => {
    const scenario = makeScenario({});
    delete scenario.config.assign.mode;
    delete scenario.config.assign.customValue;
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: 'GW-REF-001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'GW-REF-001');
  });

  test('mode=direct：gw 字段空 → candidates 过滤掉 → 无修改', () => {
    const scenario = makeScenario({ mode: 'direct' });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001', Reference: '' }]; // gw Reference 空
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.equal(bankRows[0].Narrative, '');
  });
});

test.describe('runC3Scenario — mode=custom（v2.1.8 N2 新增）', () => {
  test('mode=custom + customValue 非空 → newValue=customValue 写入 bank', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'CUSTOM-VAL-123'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }]; // gw 没 Reference 字段
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'CUSTOM-VAL-123');
  });

  test('mode=custom：跳过 gw 字段非空过滤（gw 行不需要 Reference 字段）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    // gw 行根本没有 Reference 字段（mode=direct 时会被过滤掉，mode=custom 时仍可命中）
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 1, 'mode=custom 应忽略 gw 字段是否非空');
    assert.equal(bankRows[0].Narrative, 'STATIC');
  });

  test('mode=custom + customValue 空 → warning + skip（防御性 bundle/手改 DB 兼容）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: ''
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.equal(bankRows[0].Narrative, '');
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('mode=custom + customValue 仅空白字符 → 同 customValue 空（trim 后空）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: '   '
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('mode=custom + reconFields 不匹配 → 无修改（与 mode=direct 一致）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O002' }]; // OrderId 不匹配
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0);
  });

  test('mode=custom + 多 bank 行 + 单 gw 行 → 严格 1v1 红线（usedGwRowIdx 消费）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'STATIC'
    });
    const bankRows = [
      { OrderId: 'O001', Narrative: '' },
      { OrderId: 'O001', Narrative: '' }
    ];
    const gwRows = [{ OrderId: 'O001' }]; // 只 1 个 gw 行
    const r = runC3Scenario(scenario, bankRows, gwRows);
    // 第 1 个 bank 命中并消费 gw → 第 2 个 bank 找不到候选
    assert.equal(r.modifications.length, 1);
    assert.equal(bankRows[0].Narrative, 'STATIC');
    assert.equal(bankRows[1].Narrative, '');
  });

  test('mode=custom + oldValue === newValue → lock 但不 record（沿用 round 9 F2 fix 行为）', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 'SAME'
    });
    const bankRows = [{ OrderId: 'O001', Narrative: 'SAME' }]; // bank 已是 SAME
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(r.modifications.length, 0, '相等不 record');
    // lockedRowIds 是 Set，用 .size（dispatcher 也是 Set）
    assert.equal(r.lockedRowIds.size, 1, '但仍 lock（first-match-wins 红线）');
  });
});

test.describe('runC3Scenario — mode=custom + customValue 类型边界', () => {
  test('customValue 是 null → 视为空 → skip', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: null
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-custom-value'));
  });

  test('customValue 是数字 → String() 转换写入', () => {
    const scenario = makeScenario({
      gwField: '__CUSTOM__',
      mode: 'custom',
      customValue: 12345
    });
    const bankRows = [{ OrderId: 'O001', Narrative: '' }];
    const gwRows = [{ OrderId: 'O001' }];
    const r = runC3Scenario(scenario, bankRows, gwRows);
    assert.equal(bankRows[0].Narrative, '12345');
  });
});
