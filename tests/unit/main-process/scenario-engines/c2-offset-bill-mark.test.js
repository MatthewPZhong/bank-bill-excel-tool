const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRowsByBillTypes,
  isNumericFieldName,
  pairsMatch,
  runC2Scenario
} = require('../../../../src/main-process/scenario-engines/c2-offset-bill-mark');

// ========================================================================
// isNumericFieldName
// ========================================================================

test.describe('isNumericFieldName — 启发式数值字段判断', () => {
  test('含 Amount → true', () => {
    assert.equal(isNumericFieldName('Credit Amount'), true);
    assert.equal(isNumericFieldName('Debit Amount'), true);
    assert.equal(isNumericFieldName('Recon Amount'), true);
  });

  test('含 Fee → true', () => {
    assert.equal(isNumericFieldName('Extra Fee'), true);
  });

  test('含 金额 / 数额 → true', () => {
    assert.equal(isNumericFieldName('对账金额'), true);
    assert.equal(isNumericFieldName('交易数额'), true);
  });

  test('普通字符串 → false', () => {
    assert.equal(isNumericFieldName('OrderId'), false);
    assert.equal(isNumericFieldName('Channel'), false);
  });

  test('null / undefined / 空 → false', () => {
    assert.equal(isNumericFieldName(null), false);
    assert.equal(isNumericFieldName(undefined), false);
    assert.equal(isNumericFieldName(''), false);
  });
});

// ========================================================================
// classifyRowsByBillTypes
// ========================================================================

test.describe('classifyRowsByBillTypes', () => {
  test('按 billTypes 条件分类 → 每行 _c2Types', () => {
    const rows = [
      { channel: '通道A', amount: '100' },
      { channel: '通道B', amount: '200' }
    ];
    const billTypes = [
      { seq: 1, field: 'channel', op: '等于', value: '通道A' },
      { seq: 2, field: 'channel', op: '等于', value: '通道B' }
    ];
    classifyRowsByBillTypes(rows, billTypes);
    assert.deepEqual(rows[0]._c2Types, [1]);
    assert.deepEqual(rows[1]._c2Types, [2]);
  });

  test('行可命中多 type seq → 数组多元素', () => {
    const rows = [{ a: '收入' }];
    const billTypes = [
      { seq: 1, field: 'a', op: '等于', value: '收入' },
      { seq: 2, field: 'a', op: '包含', value: '收入' }
    ];
    classifyRowsByBillTypes(rows, billTypes);
    assert.deepEqual(rows[0]._c2Types, [1, 2]);
  });

  test('行不命中任何 type → 空数组', () => {
    const rows = [{ a: '其它' }];
    const billTypes = [{ seq: 1, field: 'a', op: '等于', value: '收入' }];
    classifyRowsByBillTypes(rows, billTypes);
    assert.deepEqual(rows[0]._c2Types, []);
  });

  test('自动给每行赋 _rowId', () => {
    const rows = [{ a: '收入' }, { a: '收入' }];
    const billTypes = [{ seq: 1, field: 'a', op: '等于', value: '收入' }];
    classifyRowsByBillTypes(rows, billTypes);
    assert.equal(rows[0]._rowId, 'row_0');
    assert.equal(rows[1]._rowId, 'row_1');
  });
});

// ========================================================================
// pairsMatch
// ========================================================================

test.describe('pairsMatch — 笛卡尔配对字段相等', () => {
  test('单字段相等 → true', () => {
    const left = { OrderId: 'X1' };
    const right = { OrderId: 'X1' };
    const r = pairsMatch(left, right, [{ leftField: 'OrderId', rightField: 'OrderId' }]);
    assert.equal(r, true);
  });

  test('单字段不等 → false', () => {
    const r = pairsMatch({ OrderId: 'X1' }, { OrderId: 'X2' }, [{ leftField: 'OrderId', rightField: 'OrderId' }]);
    assert.equal(r, false);
  });

  test('多字段全等 → true', () => {
    const left = { OrderId: 'X1', Amount: '100' };
    const right = { OrderId: 'X1', Amount: '100' };
    const r = pairsMatch(left, right, [
      { leftField: 'OrderId', rightField: 'OrderId' },
      { leftField: 'Amount', rightField: 'Amount' }
    ]);
    assert.equal(r, true);
  });

  test('一字段不等 → false', () => {
    const r = pairsMatch(
      { OrderId: 'X1', Amount: '100' },
      { OrderId: 'X1', Amount: '200' },
      [
        { leftField: 'OrderId', rightField: 'OrderId' },
        { leftField: 'Amount', rightField: 'Amount' }
      ]
    );
    assert.equal(r, false);
  });

  test('Amount 字段数值比较（字符串 vs 数字）', () => {
    const r = pairsMatch(
      { Amount: '100.0' },
      { Amount: 100 },
      [{ leftField: 'Amount', rightField: 'Amount' }]
    );
    assert.equal(r, true);
  });
});

// ========================================================================
// runC2Scenario — v2.1.7 F4 衍生方案 A（reconFields = 0）
// ========================================================================

test.describe('runC2Scenario — reconFields = 0 无条件赋值', () => {
  test('命中 markValue.type 的行直接写值', () => {
    const scenario = {
      id: 1,
      name: 'C2-uncond',
      config: {
        billTypes: [{ seq: 1, field: 'channel', op: '等于', value: '通道A' }],
        reconFields: [],
        markValue: { type: 1, field: 'Remark-description', value: '已标记' }
      }
    };
    const rows = [
      { channel: '通道A', 'Remark-description': '' },
      { channel: '通道B', 'Remark-description': '' }
    ];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 1);
    assert.equal(rows[0]['Remark-description'], '已标记');
    assert.equal(rows[1]['Remark-description'], '');
  });

  test('原值 = 新值 → 不修改 / 不锁定', () => {
    const scenario = {
      id: 1,
      name: 'C2-uncond',
      config: {
        billTypes: [{ seq: 1, field: 'channel', op: '等于', value: '通道A' }],
        reconFields: [],
        markValue: { type: 1, field: 'Remark-description', value: '已' }
      }
    };
    const rows = [{ channel: '通道A', 'Remark-description': '已' }];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('billTypes 空 → invalid-config warning + 返回空结果', () => {
    const scenario = {
      id: 1,
      name: 'C2',
      config: { billTypes: [], reconFields: [], markValue: { type: 1, field: 'X', value: 'Y' } }
    };
    const r = runC2Scenario(scenario, [{}]);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-config'));
    assert.equal(r.modifications.length, 0);
  });

  test('markValue.type 或 .field 缺失 → invalid-config', () => {
    const scenario = {
      id: 1,
      name: 'C2',
      config: { billTypes: [{ seq: 1, field: 'a', op: '等于', value: 'X' }], reconFields: [], markValue: {} }
    };
    const r = runC2Scenario(scenario, [{}]);
    assert.ok(r.warnings.some((w) => w.code === 'invalid-config'));
  });
});

// ========================================================================
// runC2Scenario — reconFields ≥ 1（笛卡尔配对）
// ========================================================================

test.describe('runC2Scenario — reconFields ≥ 1 配对模式', () => {
  test('一对一配对成功 → 给 rightRow 写值（标准场景）', () => {
    const scenario = {
      id: 1,
      name: 'C2-pair',
      config: {
        billTypes: [
          { seq: 1, field: 'type', op: '等于', value: 'A' },
          { seq: 2, field: 'type', op: '等于', value: 'B' }
        ],
        reconFields: [
          { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
        ],
        markValue: { type: 2, field: 'Remark-description', value: 'PAIRED' }
      }
    };
    const rows = [
      { type: 'A', OrderId: 'O1', 'Remark-description': '' }, // leftRow (seq 1)
      { type: 'B', OrderId: 'O1', 'Remark-description': '' }  // rightRow (seq 2)
    ];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 1);
    assert.equal(rows[1]['Remark-description'], 'PAIRED');
    // 双方都被锁定（F2 P1 修复）
    assert.equal(r.lockedRowIds.size, 2);
  });

  test('一对多 → warn + 终止该 leftRow', () => {
    const scenario = {
      id: 1,
      name: 'C2-1vN',
      config: {
        billTypes: [
          { seq: 1, field: 'type', op: '等于', value: 'A' },
          { seq: 2, field: 'type', op: '等于', value: 'B' }
        ],
        reconFields: [
          { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
        ],
        markValue: { type: 2, field: 'Remark-description', value: 'PAIRED' }
      }
    };
    const rows = [
      { type: 'A', OrderId: 'O1', 'Remark-description': '' },
      { type: 'B', OrderId: 'O1', 'Remark-description': '' },
      { type: 'B', OrderId: 'O1', 'Remark-description': '' }  // 与 leftRow 也匹配
    ];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'one-to-many'));
  });

  test('多对一 → warn + 不写 rightRow', () => {
    const scenario = {
      id: 1,
      name: 'C2-Nv1',
      config: {
        billTypes: [
          { seq: 1, field: 'type', op: '等于', value: 'A' },
          { seq: 2, field: 'type', op: '等于', value: 'B' }
        ],
        reconFields: [
          { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
        ],
        markValue: { type: 2, field: 'Remark-description', value: 'PAIRED' }
      }
    };
    const rows = [
      { type: 'A', OrderId: 'O1', 'Remark-description': '' },
      { type: 'A', OrderId: 'O1', 'Remark-description': '' }, // 第 2 个 leftRow 也匹配
      { type: 'B', OrderId: 'O1', 'Remark-description': '' }
    ];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
    assert.ok(r.warnings.some((w) => w.code === 'many-to-one'));
  });

  test('无 leftRow / rightRow → 无修改', () => {
    const scenario = {
      id: 1,
      name: 'C2',
      config: {
        billTypes: [
          { seq: 1, field: 'type', op: '等于', value: 'A' },
          { seq: 2, field: 'type', op: '等于', value: 'B' }
        ],
        reconFields: [
          { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
        ],
        markValue: { type: 2, field: 'X', value: 'Y' }
      }
    };
    const rows = [{ type: 'A', OrderId: 'O1' }]; // 没 type=B
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 0);
  });

  test('markValue.type = leftType → 改 leftRow', () => {
    const scenario = {
      id: 1,
      name: 'C2-mark-left',
      config: {
        billTypes: [
          { seq: 1, field: 'type', op: '等于', value: 'A' },
          { seq: 2, field: 'type', op: '等于', value: 'B' }
        ],
        reconFields: [
          { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
        ],
        markValue: { type: 1, field: 'Remark-description', value: 'LEFT_PAIRED' }
      }
    };
    const rows = [
      { type: 'A', OrderId: 'O1', 'Remark-description': '' },
      { type: 'B', OrderId: 'O1', 'Remark-description': '' }
    ];
    const r = runC2Scenario(scenario, rows);
    assert.equal(r.modifications.length, 1);
    assert.equal(rows[0]['Remark-description'], 'LEFT_PAIRED');
    assert.equal(rows[1]['Remark-description'], '');
  });
});

// ========================================================================
// runC2Scenario — 边界
// ========================================================================

test.describe('runC2Scenario — 边界', () => {
  test('空 bankRows → 空结果', () => {
    const scenario = {
      id: 1,
      name: 'C2',
      config: {
        billTypes: [{ seq: 1, field: 'a', op: '等于', value: 'X' }],
        reconFields: [],
        markValue: { type: 1, field: 'X', value: 'Y' }
      }
    };
    const r = runC2Scenario(scenario, []);
    assert.equal(r.modifications.length, 0);
  });

  test('配对成功后清理 _c2Types 临时字段', () => {
    const scenario = {
      id: 1,
      name: 'C2',
      config: {
        billTypes: [{ seq: 1, field: 'a', op: '等于', value: 'X' }],
        reconFields: [],
        markValue: { type: 1, field: 'b', value: 'Y' }
      }
    };
    const rows = [{ a: 'X', b: '' }];
    runC2Scenario(scenario, rows);
    assert.equal(rows[0]._c2Types, undefined);
  });
});
