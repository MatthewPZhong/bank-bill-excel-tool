// v2.1.0-beta.3 T10：网关对账 ReconID 修复引擎 fixture 化 smoke 测试（gateway 子模式）
// spec §4.2 / PRD §6.2 — 基线 6 用例（1v1×3 选项 / 1v多 拆账 / 多v1 保 Amount / 全局约束）+
//   PR #39 review 扩展 3 用例（Case 7: mode='both' + suffix 拼接 / Case 8: source='' 空值仅 suffix /
//   Case 8.5: UI 默认 config 进引擎匹配） + constants sanity
// v2.1.1 T2-2 扩展 3 用例（Case 9/10/11: BillDate ±N 默认/勾 N=5/勾 N=1 + 跨 3 天）
// 总计 = 13/13 PASS（constants + Case 1-8 + Case 8.5 + Case 9-11）
//
// 关键差异（与 business 子模式 smoke 对照）：
//   - scenario.category = 'gateway-recon-id-fix'（不是 'recon-id-fix'）
//   - main 边账单字段 = GATEWAY_BILL_FIELDS（31 列）；opp 边 = CHANNEL_BILL_FIELDS（16 列）
//   - 1v多 拆账：输入 1 笔丢弃，输出 n 笔（Type=1，Amount=对应渠道.receiveAmount，Reference 按选项）
//   - 多v1：输出 n 笔保持原 Amount（Type=2，Reference 按选项）
//   - 输出列模板 ORDER_REPAIR_FIELDS_GATEWAY（14 列，无 SubBizType）
//   - Reference 取值：取 reconciliationId（network 字段），不是 reconId

const assert = require('node:assert/strict');

const { runReconIdFix } = require('../../src/main-process/recon-id-fix-engine');
const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY
} = require('../../src/constants/gateway-bill-recon-fields');

// ===== 工具：构造行 =====
function makeGatewayRow(overrides) {
  const row = {};
  GATEWAY_BILL_FIELDS.forEach((f) => { row[f] = ''; });
  row.BillDate = '2026-04-09';
  row.Amount = 100;
  row.BillType = 'gw';
  return Object.assign(row, overrides);
}

function makeChannelRow(overrides) {
  const row = {};
  CHANNEL_BILL_FIELDS.forEach((f) => { row[f] = ''; });
  row.createTime = '2026-04-09';
  row.requestAmount = 100;
  row.receiveAmount = 100;
  row.channelName = 'ch';
  return Object.assign(row, overrides);
}

function makeScenario(name, config) {
  return { id: 1, category: 'gateway-recon-id-fix', name, priority: 0, enabled: true, config };
}

// 通用 cfg：billTypes（main 边按 BillType=gw，opp 边按 channelName=ch）+ reconGroups Amount 锁定
// fieldPairs Amount/receiveAmount → BillDate/createTime（用于跨 sheet 列名映射）
function makeCfg({ matchRules, output, extraFieldPairs }) {
  const fieldPairs = [{ leftField: 'Amount', rightField: 'receiveAmount', locked: true }];
  if (Array.isArray(extraFieldPairs)) {
    extraFieldPairs.forEach((fp) => fieldPairs.push(fp));
  }
  return {
    matchRules,
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'gw' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'channelName', op: '等于', value: 'ch' }] }
    ],
    reconGroups: [
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs }
    ],
    output
  };
}

// ===== Constants sanity =====
function runConstantsSmoke() {
  assert.strictEqual(GATEWAY_BILL_FIELDS.length, 31, '网关账单应为 31 列');
  assert.strictEqual(CHANNEL_BILL_FIELDS.length, 16, '渠道账单应为 16 列');
  assert.strictEqual(ORDER_REPAIR_FIELDS_GATEWAY.length, 14, '订单修复(gateway) 应为 14 列');
  assert.ok(!ORDER_REPAIR_FIELDS_GATEWAY.includes('SubBizType'), 'gateway 订单修复 sheet 不应含 SubBizType 列');
  console.log('PASS  Constants sanity（31/16/14 列 + 无 SubBizType）');
}

// ===== 用例 1：1v1 × Reference 取网关账单（output.mode='main'）=====
function runCase1_1v1_RefMain() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 100, BillType: 'gw',
      OrderId: 'GW001', reconciliationId: 'GW-RECON-001'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      channelOrderNo: 'CH001', reconciliationId: 'CH-RECON-001'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', commonId: { source: 'main', suffix: '' } }
  });
  const result = runReconIdFix(makeScenario('Case1-1v1-RefMain', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1, 'Case1 应输出 1 行');
  assert.strictEqual(result.fixedRows[0].Type, 0, 'Case1 Type=0');
  assert.strictEqual(result.fixedRows[0].Reference, 'GW-RECON-001',
    'Case1 Reference 应取网关账单 reconciliationId');
  console.log('PASS  Case 1：1v1 Reference 取网关账单');
}

// ===== 用例 2：1v1 × Reference 取渠道账单（output.mode='opp'）=====
function runCase2_1v1_RefOpp() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 200, BillType: 'gw',
      reconciliationId: 'GW-RECON-002'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 200, channelName: 'ch',
      reconciliationId: 'CH-RECON-002'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'opp', commonId: { source: 'main', suffix: '' } }
  });
  const result = runReconIdFix(makeScenario('Case2-1v1-RefOpp', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1, 'Case2 应输出 1 行');
  assert.strictEqual(result.fixedRows[0].Type, 0, 'Case2 Type=0');
  assert.strictEqual(result.fixedRows[0].Reference, 'CH-RECON-002',
    'Case2 Reference 应取渠道账单 reconciliationId');
  console.log('PASS  Case 2：1v1 Reference 取渠道账单');
}

// ===== 用例 3：1v1 × Reference 取自取值-网关 ReconID（output.mode='both' + commonId.source='main'）=====
function runCase3_1v1_RefBothMain() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 300, BillType: 'gw',
      reconciliationId: 'GW-RECON-003'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 300, channelName: 'ch',
      reconciliationId: 'CH-RECON-003'
    })
  ];
  // 自取值-网关 ReconID：output.mode='both' + commonId.source='main'
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'both', commonId: { source: 'main', suffix: '' } }
  });
  const result = runReconIdFix(makeScenario('Case3-1v1-RefBothMain', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  // gateway 1v1 始终输出 1 行（基于 mainRow），无论 output.mode 是哪个
  assert.strictEqual(result.fixedRows.length, 1, 'Case3 应输出 1 行（gateway 1v1 仅基于 mainRow）');
  assert.strictEqual(result.fixedRows[0].Type, 0, 'Case3 Type=0');
  assert.strictEqual(result.fixedRows[0].Reference, 'GW-RECON-003',
    'Case3 Reference 应取网关账单 reconciliationId（commonId.source=main）');
  console.log('PASS  Case 3：1v1 Reference 取自取值-网关 ReconID（commonId.source=main）');
}

// ===== 用例 4：1v多 拆账（1 笔网关 300 ↔ 3 笔渠道 100/100/100）=====
function runCase4_1vN_Split() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 300, BillType: 'gw',
      OrderId: 'GW004', reconciliationId: 'GW-RECON-004',
      Bank: 'BANK_A', MerchantId: 'MERCH_A'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-004A'
    }),
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-004B'
    }),
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-004C'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: false, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', commonId: { source: 'main', suffix: '' } } // 取渠道 ReconID
  });
  const result = runReconIdFix(makeScenario('Case4-1vN-Split', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  // 1v多：输入 1 笔网关 丢弃 → 输出 3 笔（基于 mainRow + Type=1 + Amount=各渠道 receiveAmount）
  assert.strictEqual(result.fixedRows.length, 3, 'Case4 拆出 3 笔（输入网关丢弃）');
  result.fixedRows.forEach((row, idx) => {
    assert.strictEqual(row.Type, 1, `Case4 第${idx + 1}笔 Type=1`);
    assert.strictEqual(row.Amount, 100, `Case4 第${idx + 1}笔 Amount=对应渠道 receiveAmount=100`);
    assert.strictEqual(row.Bank, 'BANK_A', `Case4 第${idx + 1}笔 Bank 沿用网关账单数据`);
    assert.strictEqual(row.MerchantId, 'MERCH_A', `Case4 第${idx + 1}笔 MerchantId 沿用网关账单`);
  });
  // 3 笔 Reference 应分别取 3 笔渠道 reconciliationId（一一对应）
  const refs = result.fixedRows.map((r) => r.Reference).sort();
  assert.deepStrictEqual(refs, ['CH-RECON-004A', 'CH-RECON-004B', 'CH-RECON-004C'],
    'Case4 3 笔 Reference 各取一笔渠道 reconciliationId（一一对应，无重复）');
  console.log('PASS  Case 4：1v多 拆账 — 输出 3 笔 / Type=1 / Amount=渠道 receiveAmount / 一一对应');
}

// ===== 用例 5：多v1 保 Amount（3 笔网关 100/100/100 ↔ 1 笔渠道 300）=====
function runCase5_Nv1_KeepAmount() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 100, BillType: 'gw',
      OrderId: 'GW005A', reconciliationId: 'GW-RECON-005A'
    }),
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 100, BillType: 'gw',
      OrderId: 'GW005B', reconciliationId: 'GW-RECON-005B'
    }),
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 100, BillType: 'gw',
      OrderId: 'GW005C', reconciliationId: 'GW-RECON-005C'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 300, channelName: 'ch',
      reconciliationId: 'CH-RECON-005'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: false, oneToMany: false, manyToOne: true },
    output: { mode: 'opp', commonId: { source: 'main', suffix: '' } } // 取渠道 ReconID
  });
  const result = runReconIdFix(makeScenario('Case5-Nv1-KeepAmount', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  // 多v1：输出 3 笔（每笔基于对应网关 mainRow + Type=2 + Amount 保持原值 + Reference=渠道.reconciliationId）
  assert.strictEqual(result.fixedRows.length, 3, 'Case5 输出 3 笔（每笔基于对应网关）');
  result.fixedRows.forEach((row, idx) => {
    assert.strictEqual(row.Type, 2, `Case5 第${idx + 1}笔 Type=2`);
    assert.strictEqual(row.Amount, 100, `Case5 第${idx + 1}笔 Amount 保持原值=100`);
    assert.strictEqual(row.Reference, 'CH-RECON-005',
      `Case5 第${idx + 1}笔 Reference=渠道.reconciliationId`);
  });
  // 3 笔 OrderId 各不同（一一对应原 3 笔网关）
  const orderIds = result.fixedRows.map((r) => r.OrderId).sort();
  assert.deepStrictEqual(orderIds, ['GW005A', 'GW005B', 'GW005C'],
    'Case5 3 笔 OrderId 沿用原 3 笔网关账单（一一对应）');
  console.log('PASS  Case 5：多v1 保 Amount — Type=2 / Amount 原值 / OrderId 一一对应');
}

// ===== 用例 6：全局约束（同一渠道账单不能被两组复用）=====
// 场景：2 笔网关 + 3 笔渠道，且 sum 可以匹配两套 1v多 组合（但渠道有限只能消费一次）
// 网关 A=200 / 网关 B=100；渠道 X=100 / Y=100 / Z=100
// 1v多 应该让一个网关消费 2 笔渠道、另一个消费 1 笔；3 笔渠道总共被 3 次消费但不重复
function runCase6_GlobalConstraint() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 200, BillType: 'gw',
      OrderId: 'GW006A', reconciliationId: 'GW-RECON-006A'
    }),
    // 与上面同金额会被 1v1 直接消费（A=B 同金额），改为 100 与 1v多 不冲突
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 100, BillType: 'gw',
      OrderId: 'GW006B', reconciliationId: 'GW-RECON-006B'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-006X'
    }),
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-006Y'
    }),
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 100, channelName: 'ch',
      reconciliationId: 'CH-RECON-006Z'
    })
  ];
  // 同时开 1v1 + 1v多（让算法先消费 1v1 GW-B↔渠道 单一，剩下 GW-A=200 与 2 笔渠道做 1v多）
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', commonId: { source: 'main', suffix: '' } }
  });
  const result = runReconIdFix(makeScenario('Case6-Global', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  // 3 笔渠道全部被消费 → 输出共 3 笔（1 笔 1v1 + 2 笔 1v多 拆出，或类似分布）
  // 关键断言：每笔渠道 reconciliationId 只出现一次（全局唯一）
  const allRefs = result.fixedRows.map((r) => r.Reference);
  const usedChannels = allRefs.filter((r) => r && r.startsWith('CH-RECON-006'));
  const uniqueUsed = new Set(usedChannels);
  assert.strictEqual(usedChannels.length, uniqueUsed.size,
    `Case6 每笔渠道 reconciliationId 全局只能被消费一次（实际 used=${usedChannels.length} / unique=${uniqueUsed.size}）`);
  // 总输出 = 全部 3 笔渠道被消费完
  assert.ok(result.fixedRows.length >= 3, `Case6 输出至少 3 行（实际 ${result.fixedRows.length}）`);
  console.log(`PASS  Case 6：全局约束 — 3 笔渠道全局唯一消费（输出 ${result.fixedRows.length} 行）`);
}

// ===== 用例 7：mode='both' + commonId.source='main' + suffix 拼接（P0-1 回归保护）=====
function runCase7_Both_MainWithSuffix() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 700, BillType: 'gw',
      reconciliationId: 'GW-RECON-007'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 700, channelName: 'ch',
      reconciliationId: 'CH-RECON-007'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    // 自取值 + source=main + suffix → Reference 应 = 'GW-RECON-007' + '-FIX'
    output: { mode: 'both', commonId: { source: 'main', suffix: '-FIX' } }
  });
  const result = runReconIdFix(makeScenario('Case7-Both-MainWithSuffix', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1, 'Case7 应输出 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, 'GW-RECON-007-FIX',
    'Case7 mode=both + source=main + suffix=-FIX → Reference 应拼接为 GW-RECON-007-FIX');
  console.log('PASS  Case 7：mode=both + source=main + suffix 拼接');
}

// ===== 用例 8.5：UI 默认 config 进引擎应匹配成功（PR #39 review-round-2 Finding 1 P1 回归保护）=====
// 模拟 createDefaultScenarioConfig('gateway-recon-id-fix') 返回的 config + 用户填好 billTypes 后，
// 引擎应能用 Amount/receiveAmount locked pair 正常匹配（之前是 Amount/Amount → 0 命中）
function runCase8_5_DefaultUiConfig() {
  const main = [makeGatewayRow({ Amount: 555, BillType: 'gw', reconciliationId: 'GW-RECON-855' })];
  const opp = [makeChannelRow({ receiveAmount: 555, channelName: 'ch', reconciliationId: 'CH-RECON-855' })];
  // 模拟从 createDefaultScenarioConfig('gateway-recon-id-fix') 出来的 config（fixedLockedRight='receiveAmount'）
  const cfg = {
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'gw' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'channelName', op: '等于', value: 'ch' }] }
    ],
    reconGroups: [
      { leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'receiveAmount', locked: true }] }
    ],
    output: { mode: 'main', commonId: { source: 'main', suffix: '' } }
  };
  const result = runReconIdFix(makeScenario('Case8.5-DefaultUI', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1,
    'Case8.5 UI 默认 config (Amount/receiveAmount locked) 应正确匹配 → 1 行；如果是 Amount/Amount 则 0 行（PR #39 bug）');
  console.log('PASS  Case 8.5：UI 默认 config (Amount/receiveAmount locked) 引擎匹配成功');
}

// ===== 用例 8：mode='both' + commonId.source='' (空值) + suffix 仅 suffix（P0-2 回归保护）=====
function runCase8_Both_EmptySourceWithSuffix() {
  const main = [
    makeGatewayRow({
      BillDate: '2026-04-09', Amount: 800, BillType: 'gw',
      reconciliationId: 'GW-RECON-008'
    })
  ];
  const opp = [
    makeChannelRow({
      createTime: '2026-04-09', receiveAmount: 800, channelName: 'ch',
      reconciliationId: 'CH-RECON-008'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    // 自取值 + source='' (空值) + suffix → Reference 应 = '' + '-ONLY-SUFFIX' = '-ONLY-SUFFIX'
    output: { mode: 'both', commonId: { source: '', suffix: '-ONLY-SUFFIX' } }
  });
  const result = runReconIdFix(makeScenario('Case8-Both-EmptySrc', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1, 'Case8 应输出 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, '-ONLY-SUFFIX',
    'Case8 mode=both + source="" + suffix="-ONLY-SUFFIX" → Reference 应仅含 suffix（base 为空）');
  console.log('PASS  Case 8：mode=both + source=空值 + suffix → 仅 suffix');
}

// ===== v2.1.1 T2-2：BillDate ±N（取代硬编码 ±1day）=====
// 网关账单 BillDate vs 渠道账单 createTime（gateway 引擎自动映射）
//   gateway 子模式：opponentBills[*].BillDate 由 createTime 派生（c4 引擎 line 1031-1038）
function runCase9_BillDateRange_Default() {
  // BD-1：不勾选（默认 ±1day）+ 跨 3 天 → 不命中
  const main = [
    makeGatewayRow({ BillDate: '2026-04-09', Amount: 100, BillType: 'gw', reconciliationId: 'GW-BD-1' })
  ];
  const opp = [
    makeChannelRow({ createTime: '2026-04-12', receiveAmount: 100, channelName: 'ch', reconciliationId: 'CH-BD-1' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', commonId: { source: 'main', suffix: '' } }
  });
  const result = runReconIdFix(makeScenario('Case9-BD-default', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 0, 'Case9 BD-1 不勾选 + 跨 3 天 → 不命中');
  console.log('PASS  Case 9：BillDate ±N 不勾选 默认 ±1day + 跨 3 天 不命中');
}

function runCase10_BillDateRange_N5() {
  // BD-2：勾选 days=5 + 跨 3 天 → 命中
  const main = [
    makeGatewayRow({ BillDate: '2026-04-09', Amount: 100, BillType: 'gw', reconciliationId: 'GW-BD-2' })
  ];
  const opp = [
    makeChannelRow({ createTime: '2026-04-12', receiveAmount: 100, channelName: 'ch', reconciliationId: 'CH-BD-2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', commonId: { source: 'main', suffix: '' } }
  });
  cfg.billDateRange = { enabled: true, days: 5 };
  const result = runReconIdFix(makeScenario('Case10-BD-N5', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 1, 'Case10 BD-2 days=5 + 跨 3 天 → 命中');
  assert.strictEqual(result.fixedRows[0].Reference, 'GW-BD-2', 'Case10 取主边 reconciliationId');
  console.log('PASS  Case 10：BillDate ±N 勾选 days=5 + 跨 3 天 命中');
}

function runCase11_BillDateRange_N1() {
  // BD-3：勾选 days=1 + 跨 3 天 → 不命中
  const main = [
    makeGatewayRow({ BillDate: '2026-04-09', Amount: 100, BillType: 'gw', reconciliationId: 'GW-BD-3' })
  ];
  const opp = [
    makeChannelRow({ createTime: '2026-04-12', receiveAmount: 100, channelName: 'ch', reconciliationId: 'CH-BD-3' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', commonId: { source: 'main', suffix: '' } }
  });
  cfg.billDateRange = { enabled: true, days: 1 };
  const result = runReconIdFix(makeScenario('Case11-BD-N1', cfg), {
    reconResult: [], businessBills: main, opponentBills: opp
  });
  assert.strictEqual(result.fixedRows.length, 0, 'Case11 BD-3 days=1 + 跨 3 天 → 不命中');
  console.log('PASS  Case 11：BillDate ±N 勾选 days=1 + 跨 3 天 不命中');
}

// ===== 主入口 =====
function runReconIdFixEngineGatewaySmokeTests() {
  runConstantsSmoke();
  runCase1_1v1_RefMain();
  runCase2_1v1_RefOpp();
  runCase3_1v1_RefBothMain();
  runCase4_1vN_Split();
  runCase5_Nv1_KeepAmount();
  runCase6_GlobalConstraint();
  runCase7_Both_MainWithSuffix();
  runCase8_Both_EmptySourceWithSuffix();
  runCase8_5_DefaultUiConfig();
  // v2.1.1 T2-2：BillDate ±N（基线 10 + 新增 3 = 13）
  runCase9_BillDateRange_Default();
  runCase10_BillDateRange_N5();
  runCase11_BillDateRange_N1();
  console.log('  recon-id-fix-engine-gateway smoke: 13 / 13 PASS');
}

module.exports = { runReconIdFixEngineGatewaySmokeTests };

// 顶层直接调用（独立 node scripts/smoke/recon-id-fix-engine-gateway.js 时跑）
if (require.main === module) {
  console.log('====== gateway recon-id-fix smoke (T10) ======');
  runReconIdFixEngineGatewaySmokeTests();
  console.log('====== ALL 10 CASES PASS ======');
}
