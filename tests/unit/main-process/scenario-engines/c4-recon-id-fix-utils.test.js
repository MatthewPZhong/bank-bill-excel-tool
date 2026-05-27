// v2.1.9 G1-cont 补充：c4 模块剩余纯工具函数（lookupReconId / computeCommonId /
//   buildOutputRow / computeReferenceGateway / parseRowIdxNum / billDateMatches /
//   parseBillDateMs / toCents / rowsMatchFieldPairs / rowsMatchOtherFieldPairs /
//   groupReconFields / findAmountLockedPair / classifyRows / enumerateAmountSubsets）
// v2.1.8 已覆盖：normalizeBillDateValue / findBestAmountSubset / sortRightRowsForManyToOne / currencyMatches
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupReconId,
  computeCommonId,
  buildOutputRow,
  parseRowIdxNum,
  billDateMatches,
  parseBillDateMs,
  toCents,
  rowsMatchFieldPairs,
  rowsMatchOtherFieldPairs,
  groupReconFields,
  findAmountLockedPair,
  classifyRows,
  enumerateAmountSubsets,
  tieBreakSubsets
} = require('../../../../src/main-process/scenario-engines/c4-recon-id-fix');

// ========================================================================
// lookupReconId
// ========================================================================

test.describe('lookupReconId', () => {
  test('返回行 reconId（trim）', () => {
    assert.equal(lookupReconId({ reconId: '  RID-001  ' }), 'RID-001');
  });

  test('reconId 为空 → 空串', () => {
    assert.equal(lookupReconId({ reconId: '' }), '');
    assert.equal(lookupReconId({ reconId: null }), '');
    assert.equal(lookupReconId({ reconId: undefined }), '');
  });

  test('行为 null → 空串', () => {
    assert.equal(lookupReconId(null), '');
    assert.equal(lookupReconId(undefined), '');
  });

  test('reconId 是数字 → 字符串', () => {
    assert.equal(lookupReconId({ reconId: 12345 }), '12345');
  });
});

// ========================================================================
// computeCommonId
// ========================================================================

test.describe('computeCommonId', () => {
  test('source = left（默认 — source 非 opp 都走 left）→ leftRow.reconId + suffix', () => {
    const r = computeCommonId({ source: 'left', suffix: '-X' }, { reconId: 'RID-001' }, { reconId: 'RID-002' });
    assert.equal(r, 'RID-001-X');
  });

  test('source = opp → rightRow.reconId + suffix', () => {
    const r = computeCommonId({ source: 'opp', suffix: '-Y' }, { reconId: 'RID-001' }, { reconId: 'RID-002' });
    assert.equal(r, 'RID-002-Y');
  });

  test('cfg 为 null → 空串', () => {
    assert.equal(computeCommonId(null, {}, {}), '');
  });

  test('suffix 为 null → 空串拼接', () => {
    const r = computeCommonId({ source: 'main', suffix: null }, { reconId: 'X' }, { reconId: 'Y' });
    assert.equal(r, 'X');
  });

  test('source = opp 但 rightRow 缺 reconId → 仅 suffix', () => {
    const r = computeCommonId({ source: 'opp', suffix: '-Y' }, { reconId: 'X' }, {});
    assert.equal(r, '-Y');
  });
});

// ========================================================================
// parseRowIdxNum
// ========================================================================

test.describe('parseRowIdxNum — _rowIdx 末尾数字解析（PR #36 round 1 P2 修复）', () => {
  test('main_5 → 5', () => {
    assert.equal(parseRowIdxNum('main_5'), 5);
  });

  test('opp_10 → 10（不要字典序）', () => {
    assert.equal(parseRowIdxNum('opp_10'), 10);
    assert.equal(parseRowIdxNum('opp_2'), 2);
    // 验证 opp_2 < opp_10 数值上而非字符串字典序
    assert.ok(parseRowIdxNum('opp_2') < parseRowIdxNum('opp_10'));
  });

  test('null / undefined → MAX_SAFE_INTEGER（排最后）', () => {
    assert.equal(parseRowIdxNum(null), Number.MAX_SAFE_INTEGER);
    assert.equal(parseRowIdxNum(undefined), Number.MAX_SAFE_INTEGER);
  });

  test('非法格式 → MAX_SAFE_INTEGER', () => {
    assert.equal(parseRowIdxNum('no-digits'), Number.MAX_SAFE_INTEGER);
    assert.equal(parseRowIdxNum('main_'), Number.MAX_SAFE_INTEGER);
  });

  test('纯数字字符串 → 仍尝试匹配末尾', () => {
    // _123 才会匹配；'123' 不匹配（前置无下划线）
    assert.equal(parseRowIdxNum('123'), Number.MAX_SAFE_INTEGER);
  });
});

// ========================================================================
// parseBillDateMs / billDateMatches
// ========================================================================

test.describe('parseBillDateMs', () => {
  test('YYYY-MM-DD → UTC ms', () => {
    assert.equal(parseBillDateMs('2026-05-22'), Date.UTC(2026, 4, 22));
  });

  test('YYYY/MM/DD → UTC ms', () => {
    assert.equal(parseBillDateMs('2026/05/22'), Date.UTC(2026, 4, 22));
  });

  test('单位月份补 0：YYYY-M-D', () => {
    assert.equal(parseBillDateMs('2026-5-2'), Date.UTC(2026, 4, 2));
  });

  test('带时间后缀 → 仅取日期段', () => {
    assert.equal(parseBillDateMs('2026-05-22 14:30'), Date.UTC(2026, 4, 22));
  });

  test('null / 空 → null', () => {
    assert.equal(parseBillDateMs(null), null);
    assert.equal(parseBillDateMs(''), null);
    assert.equal(parseBillDateMs(undefined), null);
  });

  test('非法字符串 → null', () => {
    assert.equal(parseBillDateMs('not-a-date'), null);
    assert.equal(parseBillDateMs('abc'), null);
  });

  test('Excel 序列号（number）→ null（必须先经 normalizeBillDateValue）', () => {
    assert.equal(parseBillDateMs(46164), null);
  });
});

test.describe('billDateMatches', () => {
  test('strict 模式：字符串相等 → true', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-22', 'strict'), true);
  });

  test('strict 模式：字符串不等 → false（即使 ±1day 内）', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-23', 'strict'), false);
  });

  test('strict 模式：trim 后比较', () => {
    assert.equal(billDateMatches('  2026-05-22  ', '2026-05-22', 'strict'), true);
  });

  test('±1day 模式：差 1 天 → true', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-23', '±1day'), true);
    assert.equal(billDateMatches('2026-05-23', '2026-05-22', '±1day'), true);
  });

  test('±1day 模式：差 2 天 → false', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-24', '±1day'), false);
  });

  test('±1day 模式 + days=2：差 2 天 → true', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-24', '±1day', 2), true);
  });

  test('空值 → false', () => {
    assert.equal(billDateMatches('', '2026-05-22', 'strict'), false);
    assert.equal(billDateMatches('2026-05-22', null, 'strict'), false);
  });

  test('其它 mode 串：当 strict 处理', () => {
    assert.equal(billDateMatches('2026-05-22', '2026-05-23', 'whatever'), false);
  });
});

// ========================================================================
// toCents
// ========================================================================

test.describe('toCents', () => {
  test('数字 × 100 + 四舍五入', () => {
    assert.equal(toCents(1.23), 123);
    assert.equal(toCents(100), 10000);
    assert.equal(toCents(0), 0);
  });

  test('字符串数字', () => {
    assert.equal(toCents('1.23'), 123);
    assert.equal(toCents('  100  '), 10000);
  });

  test('浮点四舍五入：1.235 → 124（避免 0.1+0.2 浮点坑）', () => {
    assert.equal(toCents(1.235), 124);
  });

  test('null / undefined → null', () => {
    assert.equal(toCents(null), null);
    assert.equal(toCents(undefined), null);
  });

  test('空字符串 → null（避免 Number("") = 0）', () => {
    assert.equal(toCents(''), null);
    assert.equal(toCents('   '), null);
  });

  test('非法字符串 → null', () => {
    assert.equal(toCents('abc'), null);
    assert.equal(toCents('1.2.3'), null);
  });

  test('NaN / Infinity → null', () => {
    assert.equal(toCents(NaN), null);
    assert.equal(toCents(Infinity), null);
    assert.equal(toCents(-Infinity), null);
  });

  test('对象 / 数组 / boolean → null', () => {
    assert.equal(toCents({}), null);
    assert.equal(toCents([]), null);
    assert.equal(toCents(true), null);
  });
});

// ========================================================================
// rowsMatchFieldPairs / rowsMatchOtherFieldPairs
// ========================================================================

test.describe('rowsMatchFieldPairs', () => {
  test('全部字段相等 → true', () => {
    const r = rowsMatchFieldPairs(
      { Amount: '100', OrderId: 'X' },
      { Amount: '100', OrderId: 'X' },
      [{ leftField: 'Amount', rightField: 'Amount' }, { leftField: 'OrderId', rightField: 'OrderId' }]
    );
    assert.equal(r, true);
  });

  test('一字段不等 → false', () => {
    const r = rowsMatchFieldPairs(
      { Amount: '100' },
      { Amount: '200' },
      [{ leftField: 'Amount', rightField: 'Amount' }]
    );
    assert.equal(r, false);
  });

  test('双方都为空 → false（不算匹配）', () => {
    const r = rowsMatchFieldPairs(
      { OrderId: '' },
      { OrderId: '' },
      [{ leftField: 'OrderId', rightField: 'OrderId' }]
    );
    assert.equal(r, false);
  });

  test('空 fieldPairs → false', () => {
    assert.equal(rowsMatchFieldPairs({}, {}, []), false);
    assert.equal(rowsMatchFieldPairs({}, {}, null), false);
  });
});

test.describe('rowsMatchOtherFieldPairs', () => {
  test('空 otherFieldPairs → true（无其他约束）', () => {
    assert.equal(rowsMatchOtherFieldPairs({}, {}, []), true);
    assert.equal(rowsMatchOtherFieldPairs({}, {}, null), true);
  });

  test('全字段相等 → true', () => {
    const r = rowsMatchOtherFieldPairs(
      { OrderId: 'X', Channel: 'A' },
      { OrderId: 'X', Channel: 'A' },
      [{ leftField: 'OrderId', rightField: 'OrderId' }, { leftField: 'Channel', rightField: 'Channel' }]
    );
    assert.equal(r, true);
  });

  test('双方都空 → false', () => {
    const r = rowsMatchOtherFieldPairs(
      { X: '' },
      { X: '' },
      [{ leftField: 'X', rightField: 'X' }]
    );
    assert.equal(r, false);
  });
});

// ========================================================================
// groupReconFields
// ========================================================================

test.describe('groupReconFields', () => {
  test('已有 reconGroups → 直接使用', () => {
    const cfg = {
      reconGroups: [
        {
          leftTypeSeq: 1,
          rightTypeSeq: 2,
          fieldPairs: [{ leftField: 'Amount', rightField: 'Amount', locked: true }]
        }
      ]
    };
    const r = groupReconFields(cfg);
    assert.equal(r.length, 1);
    assert.equal(r[0].leftTypeSeq, 1);
    assert.equal(r[0].fieldPairs[0].locked, true);
  });

  test('fallback 兼容老 reconFields[]', () => {
    const cfg = {
      reconFields: [
        { seq: 1, leftTypeSeq: 1, rightTypeSeq: 2, leftField: 'Amount', rightField: 'Amount' },
        { seq: 1, leftTypeSeq: 1, rightTypeSeq: 2, leftField: 'OrderId', rightField: 'OrderId' }
      ]
    };
    const r = groupReconFields(cfg);
    assert.equal(r.length, 1);
    assert.equal(r[0].fieldPairs.length, 2);
    // Amount/Amount 自动 lock
    assert.equal(r[0].fieldPairs[0].locked, true);
    assert.equal(r[0].fieldPairs[1].locked, false);
  });

  test('cfg 为 null → 空数组', () => {
    assert.deepEqual(groupReconFields(null), []);
    assert.deepEqual(groupReconFields(undefined), []);
  });

  test('reconGroups 与 reconFields 都缺 → 空数组', () => {
    assert.deepEqual(groupReconFields({}), []);
  });
});

// ========================================================================
// findAmountLockedPair
// ========================================================================

test.describe('findAmountLockedPair', () => {
  test('locked = true 优先', () => {
    const pairs = [
      { leftField: 'OrderId', rightField: 'OrderId' },
      { leftField: 'X', rightField: 'Y', locked: true }
    ];
    const r = findAmountLockedPair(pairs);
    assert.equal(r.leftField, 'X');
  });

  test('无 locked，按字段名 Amount/Amount 兼容识别', () => {
    const pairs = [
      { leftField: 'OrderId', rightField: 'OrderId' },
      { leftField: 'Amount', rightField: 'Amount' }
    ];
    const r = findAmountLockedPair(pairs);
    assert.equal(r.leftField, 'Amount');
  });

  test('无 locked + 无 Amount/Amount → null', () => {
    const pairs = [{ leftField: 'OrderId', rightField: 'OrderId' }];
    assert.equal(findAmountLockedPair(pairs), null);
  });

  test('空数组 / null → null', () => {
    assert.equal(findAmountLockedPair([]), null);
    assert.equal(findAmountLockedPair(null), null);
  });
});

// ========================================================================
// classifyRows
// ========================================================================

test.describe('classifyRows', () => {
  test('按 side 过滤 billTypes，行 _types 反映命中 seq', () => {
    const rows = [{ Type: 'A' }, { Type: 'B' }];
    const billTypes = [
      { side: 'main', seq: 1, conditions: [{ field: 'Type', op: '等于', value: 'A' }] },
      { side: 'main', seq: 2, conditions: [{ field: 'Type', op: '等于', value: 'B' }] },
      { side: 'opp', seq: 1, conditions: [{ field: 'Type', op: '等于', value: 'X' }] } // 不该被 main 用
    ];
    const r = classifyRows(rows, billTypes, 'main');
    assert.equal(r[0]._types instanceof Set, true);
    assert.ok(r[0]._types.has(1));
    assert.ok(r[1]._types.has(2));
    assert.equal(r[0]._rowIdx, 'main_0');
    assert.equal(r[1]._rowIdx, 'main_1');
  });

  test('无 conditions 的 type → 不命中（保守）', () => {
    const rows = [{ X: 'Y' }];
    const billTypes = [{ side: 'main', seq: 1, conditions: [] }];
    const r = classifyRows(rows, billTypes, 'main');
    assert.equal(r[0]._types.size, 0);
  });

  test('返回新对象（不污染入参）', () => {
    const rows = [{ X: 'Y' }];
    const r = classifyRows(rows, [], 'main');
    assert.notEqual(r[0], rows[0]);
    assert.equal(rows[0]._types, undefined);
  });
});

// ========================================================================
// buildOutputRow
// ========================================================================

test.describe('buildOutputRow', () => {
  test('business 子模式 — 15 列含 SubBizType', () => {
    const src = { BillDate: '2026-05-22', Bank: 'ICBC', Amount: '100', SubBizType: 'X' };
    const out = buildOutputRow(src, { OrderId: 'O-001' }, 'business');
    assert.equal(out.BillDate, '2026-05-22');
    assert.equal(out.Bank, 'ICBC');
    assert.equal(out.Amount, '100');
    assert.equal(out.OrderId, 'O-001'); // override 生效
    assert.equal(out.SubBizType, 'X'); // 15 列含
  });

  test('gateway 子模式 — 14 列不含 SubBizType', () => {
    const src = { BillDate: '2026-05-22', Bank: 'ICBC', SubBizType: 'X' };
    const out = buildOutputRow(src, {}, 'gateway');
    assert.equal(out.BillDate, '2026-05-22');
    assert.equal('SubBizType' in out, false, 'gateway 模式不含 SubBizType 列');
  });

  test('缺失字段 → 空串（不是 undefined）', () => {
    const out = buildOutputRow({}, {}, 'business');
    assert.equal(out.BillDate, '');
    assert.equal(out.Amount, '');
  });

  test('overrides 覆盖 srcRow', () => {
    const out = buildOutputRow({ Reference: 'SRC' }, { Reference: 'OVR' }, 'business');
    assert.equal(out.Reference, 'OVR');
  });

  test('_sourceSide 在 enumerable=false', () => {
    const out = buildOutputRow({}, { _sourceSide: 'main' }, 'business');
    const enumerable = Object.keys(out);
    assert.equal(enumerable.includes('_sourceSide'), false);
    // 但仍可直接访问
    assert.equal(out._sourceSide, 'main');
  });
});

// ========================================================================
// enumerateAmountSubsets
// ========================================================================

test.describe('enumerateAmountSubsets', () => {
  test('正常路径：找出和 = target 的 2 元子集', () => {
    const candidates = [
      { row: { id: 'a' }, cents: 100 },
      { row: { id: 'b' }, cents: 200 },
      { row: { id: 'c' }, cents: 300 }
    ];
    const r = enumerateAmountSubsets(candidates, 300);
    // 期望：[a,b] sum 300（不算 [c] 自己，depth >= 2）
    assert.ok(r.some((s) => s.length === 2 && s.map((x) => x.id).sort().join(',') === 'a,b'));
  });

  test('depth < 2 不算解（单元素不返回）', () => {
    const candidates = [{ row: { id: 'a' }, cents: 100 }];
    const r = enumerateAmountSubsets(candidates, 100);
    assert.equal(r.length, 0);
  });

  test('无解 → 空数组', () => {
    const candidates = [
      { row: { id: 'a' }, cents: 50 },
      { row: { id: 'b' }, cents: 70 }
    ];
    const r = enumerateAmountSubsets(candidates, 200);
    assert.equal(r.length, 0);
  });

  test('candidates 太少 → 空数组', () => {
    assert.deepEqual(enumerateAmountSubsets([], 100), []);
    assert.deepEqual(enumerateAmountSubsets(null, 100), []);
    assert.deepEqual(enumerateAmountSubsets([{ row: {}, cents: 50 }], 100), []);
  });

  test('targetCents ≤ 0 → 空数组', () => {
    const c = [{ row: { id: 'a' }, cents: 50 }, { row: { id: 'b' }, cents: 50 }];
    assert.deepEqual(enumerateAmountSubsets(c, 0), []);
    assert.deepEqual(enumerateAmountSubsets(c, -100), []);
  });

  test('maxSize 限制 subset 大小', () => {
    const c = Array.from({ length: 5 }, (_, i) => ({ row: { id: `r${i}` }, cents: 20 }));
    const r = enumerateAmountSubsets(c, 100, 5); // 全部 5 个 sum=100
    assert.ok(r.some((s) => s.length === 5));
  });
});
