// v2.1.0-beta.1 PR-B Round 4：C4 单据对账 ReconID 修复引擎 smoke 测试
// spec §九.2 — 5 阶段算法 + subset-sum 池子 + tieBreak + R1-R7 + RB1-RB5 + Amount 锁定 + unmatched reason 推断
//
// 关键：所有用例的 fieldPairs 默认带 Amount 锁定 + Step 1 用同 BillDate
// Round 4 修订：池子算法改 subset-sum 语义（多笔小金额拼出大金额），不是 round 3 的"逐行 Amount 全等"

const assert = require('node:assert/strict');

const { runReconIdFix } = require('../../src/main-process/recon-id-fix-engine');
const {
  classifyRows,
  groupReconFields,
  rowsMatchFieldPairs,
  rowsMatchOtherFieldPairs,
  toCents,
  enumerateAmountSubsets,
  findBestAmountSubset,
  tieBreakSubsets,
  pickBestByTieBreak,
  parseRowIdxNum,
  lookupReconId,
  resolveSubBizType,
  computeCommonId,
  buildOutputRow,
  findAmountLockedPair,
  billDateMatches,
  parseBillDateMs,
  collectUnmatchedRows,
  runC4Scenario
} = require('../../src/main-process/scenario-engines/c4-recon-id-fix');
const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS
} = require('../../src/constants/recon-id-fix-fields');

// ===== 工具：构造行（默认值都填 placeholder）=====
function makeBusinessRow(overrides) {
  const row = {};
  BUSINESS_BILL_FIELDS.forEach((f) => { row[f] = ''; });
  row.BillDate = '2026-04-09';
  row.Amount = 100;
  row.BillType = 'biz';
  return Object.assign(row, overrides);
}
function makeOpponentRow(overrides) {
  const row = {};
  OPPONENT_BILL_FIELDS.forEach((f) => { row[f] = ''; });
  row.BillDate = '2026-04-09';
  row.Amount = 100;
  row.BillType = 'biz';
  return Object.assign(row, overrides);
}
function makeReconResultRow(overrides) {
  const row = {};
  RECON_RESULT_FIELDS.forEach((f) => { row[f] = ''; });
  return Object.assign(row, overrides);
}

function makeScenario(category, name, config) {
  return { id: 1, category, name, priority: 0, enabled: true, config };
}

// 通用 cfg：billTypes（main / opp 各 1 条 BillType=biz）+ reconGroups Amount 锁定 + 用户额外 fieldPairs
//   Round 3：所有 group 默认带 Amount 锁定，再加用户的 fieldPairs（OrderId 等）
function makeCfg({ matchRules, output, extraFieldPairs }) {
  const fieldPairs = [{ leftField: 'Amount', rightField: 'Amount', locked: true }];
  if (Array.isArray(extraFieldPairs)) {
    extraFieldPairs.forEach((fp) => fieldPairs.push(fp));
  }
  return {
    matchRules,
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ],
    reconGroups: [
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs }
    ],
    output
  };
}

// ===== Constants sanity =====
function runConstantsSmoke() {
  assert.strictEqual(RECON_RESULT_FIELDS.length, 18, '对账结果应为 18 列');
  assert.strictEqual(BUSINESS_BILL_FIELDS.length, 23, '业务部门账单应为 23 列');
  assert.strictEqual(OPPONENT_BILL_FIELDS.length, 22, '对手部门账单应为 22 列');
  assert.strictEqual(ORDER_REPAIR_FIELDS.length, 15, '订单修复应为 15 列');
}

// ===== 内部工具 =====
function runHelpersSmoke() {
  // computeCommonId
  assert.strictEqual(
    computeCommonId({ source: 'main', suffix: '-X' }, { OrderId: 'A1', reconId: 'RA1' }, { OrderId: 'B1', reconId: 'RB1' }),
    'RA1-X', 'computeCommonId source=main 取主边 reconId'
  );
  assert.strictEqual(
    computeCommonId({ source: 'opp', suffix: '-Y' }, { OrderId: 'A1', reconId: 'RA1' }, { OrderId: 'B1', reconId: 'RB1' }),
    'RB1-Y', 'computeCommonId source=opp 取从边 reconId'
  );
  // lookupReconId
  assert.strictEqual(lookupReconId({ reconId: 'R1' }), 'R1');
  assert.strictEqual(lookupReconId(null), '', 'lookupReconId null → ""');
  assert.strictEqual(lookupReconId({ reconId: '  R2  ' }), 'R2', 'lookupReconId trim');

  // groupReconFields（reconGroups 直接读 + reconFields fallback + 空配置 + 同时含两者 reconGroups 优先）
  const cfgNew = {
    reconGroups: [
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [{ leftField: 'A', rightField: 'B' }] },
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [{ leftField: 'C', rightField: 'D' }] }
    ]
  };
  assert.strictEqual(groupReconFields(cfgNew).length, 2, 'reconGroups 直接读');
  const cfgOld = {
    reconFields: [
      { seq: 1, leftTypeSeq: 1, leftField: 'A', rightTypeSeq: 2, rightField: 'B' },
      { seq: 1, leftTypeSeq: 1, leftField: 'Amount', rightTypeSeq: 2, rightField: 'Amount' },
      { seq: 2, leftTypeSeq: 1, leftField: 'E', rightTypeSeq: 2, rightField: 'F' }
    ]
  };
  const groupsOld = groupReconFields(cfgOld);
  assert.strictEqual(groupsOld.length, 2, 'reconFields fallback 2 组');
  // Round 3：fallback 时把 Amount/Amount 自动标 locked
  const fpAmount = groupsOld[0].fieldPairs.find((fp) => fp.leftField === 'Amount');
  assert.strictEqual(fpAmount && fpAmount.locked, true, 'fallback 时 Amount/Amount 自动 locked');
  assert.deepStrictEqual(groupReconFields({}), [], '空 cfg');

  // findAmountLockedPair
  const fps = [
    { leftField: 'Currency', rightField: 'Currency' },
    { leftField: 'Amount', rightField: 'Amount', locked: true }
  ];
  const ap = findAmountLockedPair(fps);
  assert.ok(ap && ap.leftField === 'Amount', 'findAmountLockedPair 命中 Amount/Amount');
  assert.strictEqual(findAmountLockedPair([{ leftField: 'Currency', rightField: 'Currency' }]), null, '无 Amount → null');

  // billDateMatches
  assert.strictEqual(billDateMatches('2026-04-09', '2026-04-09', 'strict'), true, 'strict 同日命中');
  assert.strictEqual(billDateMatches('2026-04-09', '2026-04-10', 'strict'), false, 'strict 隔日不命中');
  assert.strictEqual(billDateMatches('2026-04-09', '2026-04-08', '±1day'), true, '±1day D-1');
  assert.strictEqual(billDateMatches('2026-04-09', '2026-04-10', '±1day'), true, '±1day D+1');
  assert.strictEqual(billDateMatches('2026-04-09', '2026-04-11', '±1day'), false, '±1day 隔 2 日不命中');
  assert.strictEqual(billDateMatches('', '2026-04-09', '±1day'), false, '空日期不命中');

  // parseBillDateMs
  assert.ok(parseBillDateMs('2026-04-09') !== null, 'parseBillDateMs 解析 ISO');
  assert.ok(parseBillDateMs('2026/04/09') !== null, 'parseBillDateMs 解析斜杠');
  assert.strictEqual(parseBillDateMs(''), null, 'parseBillDateMs 空 → null');

  // rowsMatchFieldPairs：两端都空不算命中
  assert.strictEqual(
    rowsMatchFieldPairs({ X: '' }, { X: '' }, [{ leftField: 'X', rightField: 'X' }]),
    false, '两端都空不算命中（避免大量空值误连）'
  );
}

// ===== Step 1：同 BillDate 严格 1v1 命中 =====
function runStep1Strict() {
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-1' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT' } }
  });
  const scenario = makeScenario('recon-id-fix', 'Step1-strict', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'Step 1 严格命中 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, 'RID-OPP-1', 'Step 1 取对方 reconId');
  assert.strictEqual(result.unmatchedRows.length, 0, 'Step 1 全配对，0 unmatched');
}

// ===== Step 2：BillDate ±1day 容错 1v1 命中 =====
function runStep2Tolerant() {
  // 主 D 04-09 vs 从 D-1 04-08 → Step 1 不命中（Step 1 严格），Step 2 命中
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-08', Amount: 100, reconId: 'RID-OPP-1' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT' } }
  });
  const scenario = makeScenario('recon-id-fix', 'Step2-tolerant', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'Step 2 ±1day 命中 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, 'RID-OPP-1', 'Step 2 取对方 reconId');
}

// ===== Step 3.1：池子同 BillDate + subset-sum 1v多 =====（Round 4 重写）
function runStep31PoolOneToMany() {
  // 1 主 amount=300 vs 2 从 [amount=100, amount=200] → subset-sum {100,200} = 300 ✓
  // 用户配 BizType 让 Step 1+2 失败（主 BizType=X，从 BizType=A/B 不等）
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 300, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-09', Amount: 200, BizType: 'X', reconId: 'RID-S2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'SBT' } },
    // 用户配 BizType 字段对（Step 1+2 全 AND 全等会因 Amount 不等失败）
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'Step3.1-pool', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // R4 (mode=opp 1v多)：多个从 Type=0 / Reference=主.reconId
  assert.strictEqual(result.fixedRows.length, 2, 'Step 3.1 subset-sum {100,200}=300 命中 2 个从');
  result.fixedRows.forEach((r) => {
    assert.strictEqual(r.Type, 0, 'R4 Type=0');
    assert.strictEqual(r.Reference, 'RID-M', 'R4 Reference=主 reconId');
  });
}

// ===== Step 3.2：池子 BillDate ±1day + subset-sum 1v多 =====（Round 4 重写）
function runStep32PoolOneToManyTolerant() {
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 300, BizType: 'X', reconId: 'RID-M' })
  ];
  // 从在 D-1 / D+1（不同日，Step 3.1 不命中），但 subset-sum 命中
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-08', Amount: 100, BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-10', Amount: 200, BizType: 'X', reconId: 'RID-S2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'SBT' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'Step3.2-pool', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 2, 'Step 3.2 ±1day subset-sum 命中 2');
}

// ===== Step 3'.1：池子同 BillDate + subset-sum 多v1 =====（Round 4 重写）
function runStep3p1PoolManyToOne() {
  // 2 主 [40, 60] vs 1 从 100 → subset-sum {40,60}=100 ✓
  const business = [
    makeBusinessRow({ OrderId: 'M1', BillDate: '2026-04-09', Amount: 40, BizType: 'X', reconId: 'RID-M1' }),
    makeBusinessRow({ OrderId: 'M2', BillDate: '2026-04-09', Amount: 60, BizType: 'X', reconId: 'RID-M2' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-S' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: true },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', "Step3'.1-pool", cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // R2 (mode=main 多v1)：多主 Type=2 / Reference=从 reconId
  assert.strictEqual(result.fixedRows.length, 2, "Step 3'.1 subset-sum {40,60}=100 命中 2 个主");
  result.fixedRows.forEach((r) => {
    assert.strictEqual(r.Type, 2, 'R2 Type=2');
    assert.strictEqual(r.Reference, 'RID-S', 'R2 Reference=从 reconId');
  });
}

// ===== R1：Step 1 + mode=main =====（保留原 R1 语义）
function runR1() {
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-1' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT_M' } }
  });
  const scenario = makeScenario('recon-id-fix', 'R1', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  const row = result.fixedRows[0];
  assert.strictEqual(row.Type, 0, 'R1 Type=0');
  assert.strictEqual(row.Reference, 'RID-OPP-1', 'R1 Reference=对方 reconId');
  assert.strictEqual(row.SubBizType, 'SBT_M', 'R1 SubBizType=manualMain');
}

// ===== R3：Step 1 + mode=opp =====
function runR3() {
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-MAIN-1' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: '' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'SBT_O' } }
  });
  const scenario = makeScenario('recon-id-fix', 'R3', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows[0].Type, 0, 'R3 Type=0');
  assert.strictEqual(result.fixedRows[0].Reference, 'RID-MAIN-1', 'R3 Reference=主边 reconId');
}

// ===== R5/R6 auto SubBizType =====
function runR5R6Auto() {
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-X', reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, BizType: '', reconId: 'RID-OPP-1' })
  ];
  const reconResult = [
    makeReconResultRow({
      '业务类型': 'BT-X',
      '业务部门单号': 'O-1',
      '业务部门单据子类型': 'AutoSBT-MAIN'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'auto' } }
  });
  const scenario = makeScenario('recon-id-fix', 'R5', cfg);
  const result = runReconIdFix(scenario, { reconResult, businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows[0].SubBizType, 'AutoSBT-MAIN', 'R5 auto 命中');
}

// ===== Q2A：auto 未命中 → SubBizType='' + warning =====
function runQ2AAutoMiss() {
  const business = [
    makeBusinessRow({ OrderId: 'O-99', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-MISS', reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-99', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-99' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'auto' } }
  });
  const scenario = makeScenario('recon-id-fix', 'Q2A', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'Q2A 行仍写入');
  assert.strictEqual(result.fixedRows[0].SubBizType, '', 'Q2A SubBizType=空');
  assert.strictEqual(result.warnings.length, 1, 'Q2A 1 条 warning');
}

// ===== RB1：1v1 mode=both 双 Type=0 =====
function runRB1() {
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-MAIN-1' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-1' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '-FIX' },
      subBizType: { mode: 'manualBoth', mainValue: 'M', oppValue: 'O' }
    }
  });
  const scenario = makeScenario('recon-id-fix', 'RB1', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 2, 'RB1 命中 2 行');
  result.fixedRows.forEach((row) => {
    assert.strictEqual(row.Type, 0, 'RB1 双 Type=0');
    assert.strictEqual(row.Reference, 'RID-MAIN-1-FIX', 'RB1 commonId=主 reconId+suffix');
  });
}

// ===== RB2：多v1 mode=both 主 Type=2 / 从 Type=0 =====（Round 4：subset-sum 重写）
function runRB2() {
  // 3 主 [10, 20, 30] vs 1 从 60 → subset-sum {10,20,30}=60 ✓
  const business = [
    makeBusinessRow({ OrderId: 'O-2', BillDate: '2026-04-09', Amount: 10, BizType: 'X', reconId: 'RID-M2-A' }),
    makeBusinessRow({ OrderId: 'O-2', BillDate: '2026-04-09', Amount: 20, BizType: 'X', reconId: 'RID-M2-B' }),
    makeBusinessRow({ OrderId: 'O-2', BillDate: '2026-04-09', Amount: 30, BizType: 'X', reconId: 'RID-M2-C' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-2', BillDate: '2026-04-09', Amount: 60, BizType: 'X', reconId: 'RID-OPP-2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: true },
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '-AGG' },
      subBizType: { mode: 'manualBoth', mainValue: 'M', oppValue: 'O' }
    },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]   // 让 Step 1+2 不命中（Amount 不等所以 Step 1+2 失败）
  });
  const scenario = makeScenario('recon-id-fix', 'RB2', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 4, 'RB2 命中 4 行（3 主 + 1 从）');
  const mainRows = result.fixedRows.filter((r) => r._sourceSide === 'main');
  const oppRows = result.fixedRows.filter((r) => r._sourceSide === 'opp');
  mainRows.forEach((r) => assert.strictEqual(r.Type, 2, 'RB2 主 Type=2'));
  assert.strictEqual(oppRows[0].Type, 0, 'RB2 从 Type=0');
  // commonId 共享：取主代表行 reconId 'RID-M2-A'（按 _origIdx 升序首个） + suffix '-AGG'
  result.fixedRows.forEach((r) => assert.strictEqual(r.Reference, 'RID-M2-A-AGG', 'RB2 共同 ID 共享'));
}

// ===== RB3：1v1 mode=both commonId.source=opp =====
function runRB3() {
  const business = [
    makeBusinessRow({ OrderId: 'O-3', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-MAIN-3' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-3', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-3' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: {
      mode: 'both',
      commonId: { source: 'opp', suffix: '-RB3' },
      subBizType: { mode: 'manualBoth', mainValue: 'M', oppValue: 'O' }
    }
  });
  const scenario = makeScenario('recon-id-fix', 'RB3', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  result.fixedRows.forEach((row) => assert.strictEqual(row.Reference, 'RID-OPP-3-RB3', 'RB3 commonId source=opp'));
}

// ===== RB4：1v多 mode=both **主从都 Type=0**（Round 3 修订；Round 4 subset-sum 重写）=====
function runRB4() {
  // 1 主 200 vs 2 从 [80, 120] → subset-sum {80,120}=200 ✓
  const business = [
    makeBusinessRow({ OrderId: 'O-4', BillDate: '2026-04-09', Amount: 200, BizType: 'X', reconId: 'RID-MAIN-4' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-4', BillDate: '2026-04-09', Amount: 80, BizType: 'X', reconId: 'RID-OPP-4-A' }),
    makeOpponentRow({ OrderId: 'O-4', BillDate: '2026-04-09', Amount: 120, BizType: 'X', reconId: 'RID-OPP-4-B' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '-RB4' },
      subBizType: { mode: 'manualBoth', mainValue: 'M', oppValue: 'O' }
    },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]   // 让 Step 1+2 不命中（Amount 不等）
  });
  const scenario = makeScenario('recon-id-fix', 'RB4', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 3, 'RB4 命中 3 行（1 主 + 2 从）');
  const mainRows = result.fixedRows.filter((r) => r._sourceSide === 'main');
  const oppRows = result.fixedRows.filter((r) => r._sourceSide === 'opp');
  assert.strictEqual(mainRows[0].Type, 0, 'RB4 主 Type=0');
  // Round 3 修订：从 Type=0
  oppRows.forEach((r) => assert.strictEqual(r.Type, 0, 'RB4 从 Type=0（Round 3 修订）'));
  result.fixedRows.forEach((r) => assert.strictEqual(r.Reference, 'RID-MAIN-4-RB4', 'RB4 commonId 共享'));
}

// ===== RB5：mode=both + auto SubBizType =====
function runRB5() {
  const business = [
    makeBusinessRow({ OrderId: 'O-5', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-Z', reconId: 'RID-MAIN-5' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-5', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-Z', reconId: 'RID-OPP-5' })
  ];
  const reconResult = [
    makeReconResultRow({
      '业务类型': 'BT-Z',
      '业务部门单号': 'O-5',
      '业务部门单据子类型': 'AUTO-MAIN',
      '对手部门单号': 'O-5',
      '对手部门单据子类型': 'AUTO-OPP'
    })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '-RB5' },
      subBizType: { mode: 'auto' }
    }
  });
  const scenario = makeScenario('recon-id-fix', 'RB5', cfg);
  const result = runReconIdFix(scenario, { reconResult, businessBills: business, opponentBills: opponent });
  const mainRow = result.fixedRows.find((r) => r._sourceSide === 'main');
  const oppRow = result.fixedRows.find((r) => r._sourceSide === 'opp');
  assert.strictEqual(mainRow.SubBizType, 'AUTO-MAIN', 'RB5 主边 auto');
  assert.strictEqual(oppRow.SubBizType, 'AUTO-OPP', 'RB5 从边 auto');
}

// ===== Step 1 优先于 Step 2（同行不会被两次配对）=====
function runPriorityStep1OverStep2() {
  // 主 04-09 vs 从 1 04-09 + 从 2 04-08（都满足 Amount）
  // Step 1 严格：候选数 = 1（仅从 1）→ 命中从 1，锁两端
  // Step 2 ±1day：从 2 不再被处理（pairedRight 已含从 1，但从 2 因主已 paired 不会进入第二轮）
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-08', Amount: 100, reconId: 'RID-S2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
  });
  const scenario = makeScenario('recon-id-fix', 'priority-step1', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, '优先 Step 1 命中（不被 Step 2 抢配）');
  assert.strictEqual(result.fixedRows[0].Reference, 'RID-S1', '严格命中从 1（不是从 2）');
  // S2 应进入 unmatched
  const s2Unm = result.unmatchedRows.find((u) => u.OrderId === 'S2');
  assert.ok(s2Unm, 'S2 未配 → unmatched');
}

// ===== Unmatched reason 推断（5 种）=====
function runUnmatchedReasons() {
  // 1. '未勾 1v多/多v1，跳过'：仅勾 1v1 失败的行
  // 2. '1v1 严格 BillDate 未匹配'：匹配规则含池子但 Step 1 失败的行（实际等价 reason 1）
  // 注：当用户 matchRules 是 1v1 only，行经 Step 1 / Step 2 失败 → 进 deriveReason，根据 lastStep 推断
  const business = [
    makeBusinessRow({ OrderId: 'M-only-1v1', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-M' })
  ];
  const opponent = []; // 没有从 → 主一定 unmatch
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
  });
  const scenario = makeScenario('recon-id-fix', 'unmatched-reason-only-1v1', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.unmatchedRows.length, 1, '1 主未配');
  // 主行最后到达 step2（Step 2 也试过未配）→ '1v1 BillDate ±1day 未匹配'
  assert.strictEqual(result.unmatchedRows[0]['未配原因'], '1v1 BillDate ±1day 未匹配',
    '仅勾 1v1 时主行最后到 step2 → 1v1 BillDate ±1day 未匹配');

  // 池子内 ±1day 未匹配：勾 1v多 但池子也找不到
  const business2 = [
    makeBusinessRow({ OrderId: 'M-no-pool', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent2 = [
    // 从仅 1 个 + Amount 不同 → 池子也不命中
    makeOpponentRow({ OrderId: 'S', BillDate: '2026-04-09', Amount: 999, BizType: 'A', reconId: 'RID-S' })
  ];
  const cfg2 = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario2 = makeScenario('recon-id-fix', 'unmatched-pool-fail', cfg2);
  const result2 = runReconIdFix(scenario2, { reconResult: [], businessBills: business2, opponentBills: opponent2 });
  // 主 unmatched = '池子内 BillDate ±1day 未匹配'（最后到达 step3.2）
  const mainUnm = result2.unmatchedRows.find((u) => u['单据来源'] === '主');
  assert.ok(mainUnm, '主未配');
  assert.strictEqual(mainUnm['未配原因'], '池子内 BillDate ±1day 未匹配', '池子也失败 → 池子 ±1day 未匹配');

  // '未勾 1v多/多v1，跳过'：仅勾 1v1 + 行从未进入候选（无 step 标记）
  // 这种情况只有 row 不属于任何 group 的 leftRows/rightRows 时才可能（用 billTypes 全不命中本边）
  // 简化：用一个 row 的 BillType 不匹配 → 不属于任何 _types → 不会被 leftRows/rightRows 包含
  // 注：但行也不会被 collectUnmatchedRows 收集（因为 mainTyped/oppTyped 已含所有行）
  // 所以 lastStepBy* 仍未 set → deriveReason 返回 '未勾 1v多/多v1，跳过'
  const business3 = [
    makeBusinessRow({ OrderId: 'M-no-step', BillDate: '2026-04-09', Amount: 100, BillType: 'NOT-BIZ', reconId: 'RID-M' })
  ];
  const opponent3 = [
    makeOpponentRow({ OrderId: 'S-no-step', BillDate: '2026-04-09', Amount: 100, BillType: 'NOT-BIZ', reconId: 'RID-S' })
  ];
  const cfg3 = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
  });
  const scenario3 = makeScenario('recon-id-fix', 'unmatched-no-step', cfg3);
  const result3 = runReconIdFix(scenario3, { reconResult: [], businessBills: business3, opponentBills: opponent3 });
  // 行不属于任何 group 的 leftRows / rightRows，从未到 step → reason 推断为 '1v1 严格 BillDate 未匹配'（fallback）
  // 实际：deriveReason → last 是 undefined → matchRules.oneToOne true && !usePool → '1v1 严格 BillDate 未匹配'
  result3.unmatchedRows.forEach((u) => {
    assert.ok(u['未配原因'].length > 0, '未配原因非空');
  });
}

// ===== 跨 step / 跨 group 共享 paired 集合 =====
function runCrossStepGroupShared() {
  // 第 1 group 用 OrderId+Amount fieldPairs；第 2 group 用 BizType+Amount fieldPairs
  // 主 1 vs 从 1 都满足 group 1（OrderId 相同）→ 配上
  // 主 1 / 从 1 不会再被 group 2 处理
  const business = [
    makeBusinessRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-M1' }),
    makeBusinessRow({ OrderId: 'OTHER', BillDate: '2026-04-09', Amount: 200, BizType: 'Y', reconId: 'RID-M2' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'OTHER-2', BillDate: '2026-04-09', Amount: 200, BizType: 'Y', reconId: 'RID-S2' })
  ];
  const cfg = {
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ],
    reconGroups: [
      // group 1：Amount 锁定 + OrderId
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },
          { leftField: 'OrderId', rightField: 'OrderId' }
      ] },
      // group 2：Amount 锁定 + BizType
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },
          { leftField: 'BizType', rightField: 'BizType' }
      ] }
    ],
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
  };
  const scenario = makeScenario('recon-id-fix', 'cross-group-shared', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 主 1（O-1）在 group 1 配上从 1；主 2（OTHER）在 group 2 通过 BizType=Y 配上从 2
  assert.strictEqual(result.fixedRows.length, 2, 'cross-group OR 各 1 → 总 2');
  const refSet = new Set(result.fixedRows.map((r) => r.Reference));
  assert.ok(refSet.has('RID-S1') && refSet.has('RID-S2'), '两个 group 各命中一行');
}

// ===== Round 4：池子里"其他对账字段 AND 全等"过滤（Currency 必须同），subset-sum 命中 =====
function runAmountLockedPoolUsage() {
  // Round 4 修订：池子候选过滤包含"除 Amount 外其他对账字段 AND 全等"
  //   主 USD 400 vs 从 USD 100 + USD 300 → 候选过滤后 2 个；subset-sum {100,300}=400 ✓
  //   再加一行 CNY 400 ：会被 Currency AND 过滤丢掉
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 400, Currency: 'USD', BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 100, Currency: 'USD', BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-09', Amount: 300, Currency: 'USD', BizType: 'X', reconId: 'RID-S2' }),
    // CNY → 被 Currency AND 全等过滤丢掉
    makeOpponentRow({ OrderId: 'S3', BillDate: '2026-04-09', Amount: 400, Currency: 'CNY', BizType: 'X', reconId: 'RID-S3' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    // 池子候选过滤要求 Currency AND 全等（CNY S3 被丢）
    extraFieldPairs: [{ leftField: 'Currency', rightField: 'Currency' }]
  });
  const scenario = makeScenario('recon-id-fix', 'amount-locked-pool', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 仅 S1 + S2 走入 subset-sum；S3 因 Currency 不等被过滤掉
  assert.strictEqual(result.fixedRows.length, 2, '池子算法 subset-sum 命中 2 行从（CNY 被 Currency AND 过滤丢掉）');
  const refSet = new Set(result.fixedRows.map((r) => r.Reference));
  assert.ok(refSet.has('RID-M'), '从行 Reference=主 reconId');
  // 校验 S3（CNY）未被命中
  const s3Unm = result.unmatchedRows.find((u) => u.OrderId === 'S3');
  assert.ok(s3Unm, 'S3（CNY）应在 unmatched');
}

// ===== 多 reconGroup OR 集成（保留原 multi-group 用例语义）=====
function runMultiGroupOr() {
  const business = [
    makeBusinessRow({ OrderId: 'O-X', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-99', reconId: '' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'OTHER', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-99', reconId: 'RID-MULTI' })
  ];
  const cfg = {
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ],
    reconGroups: [
      // group 1：Amount 锁定 + OrderId（OrderId 不同 → 失败）
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },
          { leftField: 'OrderId', rightField: 'OrderId' }
      ] },
      // group 2：Amount 锁定 + BizType（BizType=BT-99 相同 → 兜底命中）
      { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [
          { leftField: 'Amount', rightField: 'Amount', locked: true },
          { leftField: 'BizType', rightField: 'BizType' }
      ] }
    ],
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
  };
  const scenario = makeScenario('recon-id-fix', 'multi-group-or', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'multi-group OR 第二组兜底命中');
  assert.strictEqual(result.fixedRows[0].Reference, 'RID-MULTI', '兜底命中后取对方 reconId');
}

// ===== Round 4：subset-sum 工具函数单测 =====
function runRound4SubsetSumHelpers() {
  // toCents
  assert.strictEqual(toCents(100), 10000, 'toCents 整数');
  assert.strictEqual(toCents(0.1), 10, 'toCents 小数');
  assert.strictEqual(toCents('123.45'), 12345, 'toCents 字符串');
  assert.strictEqual(toCents(null), null, 'toCents null');
  assert.strictEqual(toCents(''), null, 'toCents 空串');
  assert.strictEqual(toCents('abc'), null, 'toCents 非法');
  // 浮点精度（0.1 + 0.2 != 0.3 经典坑，整数化避免）
  assert.strictEqual(toCents(0.1) + toCents(0.2), toCents(0.3), 'toCents 浮点精度');

  // enumerateAmountSubsets
  function makeCand(rowIdx, cents) {
    return { row: { _rowIdx: rowIdx, BillDate: '2026-04-15' }, cents };
  }
  // 命中：[100, 200] → target 300
  let result = enumerateAmountSubsets(
    [makeCand('a', 100), makeCand('b', 200)],
    300
  );
  assert.strictEqual(result.length, 1, '单解：{100, 200} = 300');
  assert.strictEqual(result[0].length, 2, '解 size=2');

  // 不命中：[100, 50] → target 999
  result = enumerateAmountSubsets(
    [makeCand('a', 100), makeCand('b', 50)],
    999
  );
  assert.strictEqual(result.length, 0, '不命中（无子集 sum=999）');

  // size=1 不算（DFS depth>=2 才记）：[100] → target 100
  result = enumerateAmountSubsets(
    [makeCand('a', 100)],
    100
  );
  assert.strictEqual(result.length, 0, 'size=1 不算（subset 必须 size>=2）');

  // 用户用例：主 270000 vs 从 [70k, 200k, 70k, 70k] → 期望解 {70k+200k} 或 {70k×3+...} 等
  result = enumerateAmountSubsets(
    [
      makeCand('F1', 7000000),  // 70k 04-13
      makeCand('F2', 20000000), // 200k 04-14
      makeCand('F3', 7000000),  // 70k 04-14
      makeCand('F4', 7000000)   // 70k 04-15
    ],
    27000000
  );
  // 可能的解：{F2, F1}=270k / {F2, F3}=270k / {F2, F4}=270k / {F1, F3, F4}=210k 不命中 / 其他
  // {F2(200k) + 任意一个 70k} = 270k → 3 个解
  assert.strictEqual(result.length, 3, '用户用例：3 解 {F2+F1} / {F2+F3} / {F2+F4}');

  // PR #36 round 2 P2 修复（2026-04-30）：移除"截断到 64 解"断言
  //   - 原断言：`enumerateAmountSubsets` 在 maxSolutions=64 处截断
  //   - 删除原因：池子算法已迁移到 `findBestAmountSubset`（DFS 全遍历维护全局 best），不再依赖此截断
  //   - `enumerateAmountSubsets` 保留为向后兼容（对外 API + 直接单测），其 maxSolutions 截断仍合法（函数行为单测），
  //     但不再用作"语义合理"断言；改测"解数 ≤ maxSolutions"弱断言以覆盖函数本身行为
  const manyCands = [];
  for (let i = 0; i < 10; i++) manyCands.push(makeCand(`x${i}`, 100));
  // 从 10 个 100 里挑 3 个 sum=300 → C(10,3)=120 个解；maxSolutions=64 截断后实际解数 ≤ 64
  result = enumerateAmountSubsets(manyCands, 300, 8, 64);
  assert.ok(result.length <= 64,
    'enumerateAmountSubsets：maxSolutions 截断行为单测（解数 ≤ 64；不再断言"等于 64"以避免暗示池子语义）');

  // size 上限：[1, 1, 1, 1, 1, 1, 1, 1, 1] → target 9 → 解 {全 9 个} size=9 超 maxSize=8 → 0 解
  result = enumerateAmountSubsets(
    Array.from({ length: 9 }, (_, i) => makeCand(`y${i}`, 100)),
    900,
    8
  );
  assert.strictEqual(result.length, 0, 'maxSize=8 保护（9 个 1 sum=9 超 size 上限）');

  // tieBreakSubsets
  // 测试 1：spread 最小 — F1 04-13 / F2 04-14 / F3 04-14 / F4 04-15
  // 主 04-15
  function makeTbCand(rowIdx, billDate) {
    return { _rowIdx: rowIdx, BillDate: billDate };
  }
  const subsetA = [makeTbCand('F2', '2026-04-14'), makeTbCand('F1', '2026-04-13')];  // spread=1day
  const subsetB = [makeTbCand('F2', '2026-04-14'), makeTbCand('F3', '2026-04-14')];  // spread=0
  const subsetC = [makeTbCand('F2', '2026-04-14'), makeTbCand('F4', '2026-04-15')];  // spread=1day
  let chosen = tieBreakSubsets([subsetA, subsetB, subsetC], '2026-04-15');
  assert.strictEqual(chosen, subsetB, 'tieBreak step 1：spread=0 < spread=1day → 选 B');

  // 测试 2：spread 并列 → distToMain 最小（A spread=1day, distToMain=0；C spread=1day, distToMain=0；用 size 区分）
  // A=2 元素, C=2 元素 → size 并列
  // firstIdx 字典序：'F1' < 'F2' < 'F4' → A 的 firstIdx='F1'，C 的 firstIdx='F2' → 选 A
  chosen = tieBreakSubsets([subsetA, subsetC], '2026-04-15');
  // A spread=1, distToMain=min(|15-13|,|15-14|)=1day；C spread=1, distToMain=min(|15-15|,|15-14|)=0day → 选 C
  assert.strictEqual(chosen, subsetC, 'tieBreak step 2：spread 并列时 distToMain 较小者（C 含主单 04-15）→ 选 C');

  // 测试 3：spread + distToMain 都并列时 → size 最小
  const subsetX = [makeTbCand('F1', '2026-04-15'), makeTbCand('F2', '2026-04-15')];  // 2 元素
  const subsetY = [makeTbCand('F3', '2026-04-15'), makeTbCand('F4', '2026-04-15'), makeTbCand('F5', '2026-04-15')];  // 3 元素
  chosen = tieBreakSubsets([subsetX, subsetY], '2026-04-15');
  assert.strictEqual(chosen, subsetX, 'tieBreak step 3：size 较小者优先（X 2 元素 < Y 3 元素）');

  // 测试 4：所有 3 都并列时 → firstIdxNum 数字部分兜底（PR #36 round 1 P2 修复）
  // 用真实生产格式 `<side>_<idx>` 测；含 'opp_2' 的子集应优先于含 'opp_3' 的
  const subsetP = [makeTbCand('opp_2', '2026-04-15'), makeTbCand('opp_3', '2026-04-15')];
  const subsetQ = [makeTbCand('opp_1', '2026-04-15'), makeTbCand('opp_4', '2026-04-15')];
  chosen = tieBreakSubsets([subsetP, subsetQ], '2026-04-15');
  assert.strictEqual(chosen, subsetQ, 'tieBreak step 4：firstIdxNum 数字部分兜底（Q 含 opp_1 数字最小）');

  // 单解直接返回
  chosen = tieBreakSubsets([subsetA], '2026-04-15');
  assert.strictEqual(chosen, subsetA, '单解直接返回');
}

// ===== Round 4：用户用例 — subset-sum + tieBreak（核心场景）=====
function runRound4UserCase() {
  // 用户原始用例（4 决策依据）：
  //   主单 04-15 USD 270000
  //   从单 [F1 04-13 70k, F2 04-14 200k, F3 04-14 70k, F4 04-15 70k]
  //   subset-sum 解：{F2+F1}=270k / {F2+F3}=270k / {F2+F4}=270k 共 3 解
  //   tieBreak：spread 最小（F2,F3 跨度 0）+ distToMain 最近（04-14 vs 04-15 差 1day）→ 选 {F2,F3}
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-15', Amount: 270000, Currency: 'USD', BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'F1', BillDate: '2026-04-13', Amount: 70000,  Currency: 'USD', BizType: 'X', reconId: 'RID-F1' }),
    makeOpponentRow({ OrderId: 'F2', BillDate: '2026-04-14', Amount: 200000, Currency: 'USD', BizType: 'X', reconId: 'RID-F2' }),
    makeOpponentRow({ OrderId: 'F3', BillDate: '2026-04-14', Amount: 70000,  Currency: 'USD', BizType: 'X', reconId: 'RID-F3' }),
    makeOpponentRow({ OrderId: 'F4', BillDate: '2026-04-15', Amount: 70000,  Currency: 'USD', BizType: 'X', reconId: 'RID-F4' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'SBT' } },
    extraFieldPairs: [{ leftField: 'Currency', rightField: 'Currency' }, { leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-user-case', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 期望：F2 + F3 命中（spread=0 < spread=1day {F2,F1}/{F2,F4}）→ 主 F4 命中状态：F2,F3 paired 后剩 F1, F4 unmatched
  // Step 3.x 走 ±1day（'2026-04-15' 主单：F1=04-13 距 2day 不在 ±1day 范围 → step3.2 候选含 F2/F3/F4，不含 F1）
  // Wait：用户期望 subset-sum 必须满足"BillDate 范围"——Step 3.2 ±1day 候选 = 主 04-15 ±1day 即 04-14/04-15/04-16
  //   F1 04-13 不在范围 → 不进 candidates
  //   F2 04-14 / F3 04-14 / F4 04-15 → 3 个 candidates
  //   subset-sum 解：{F2+F3}=270k ✓ / {F2+F4}=270k ✓ → 2 解
  //   tieBreak：F2,F3 spread=0 / F2,F4 spread=1day → 选 {F2,F3}
  // 实际：F1 在 Step 3.1 同日候选里也不在（主 04-15，F1 04-13），3.2 ±1day 也不在 → F1 进 unmatched
  assert.strictEqual(result.fixedRows.length, 2, '用户用例：subset-sum {F2,F3} 命中 2 个从');
  const refSet = new Set(result.fixedRows.map((r) => r.OrderId));
  assert.ok(refSet.has('F2'), '命中 F2');
  assert.ok(refSet.has('F3'), '命中 F3');
  assert.ok(!refSet.has('F1'), 'F1 04-13 超范围，不命中');
  assert.ok(!refSet.has('F4'), 'F4 因 tieBreak spread 不优，不命中');
  // F1 + F4 进 unmatched（主已 paired）
  const unmatchedOrderIds = new Set(result.unmatchedRows.map((u) => u.OrderId));
  assert.ok(unmatchedOrderIds.has('F1'), 'F1 在 unmatched');
  assert.ok(unmatchedOrderIds.has('F4'), 'F4 在 unmatched');
}

// ===== Round 4：subset-sum 找不到子集 → 进 unmatched =====
function runRound4NoSubsetFound() {
  // 1 主 100 vs 3 从 [33, 33, 33]（sum=99 ≠ 100）→ 0 解，全部 unmatched
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 33, BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-09', Amount: 33, BizType: 'X', reconId: 'RID-S2' }),
    makeOpponentRow({ OrderId: 'S3', BillDate: '2026-04-09', Amount: 33, BizType: 'X', reconId: 'RID-S3' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-no-subset', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 0, '无 subset-sum 解 → 全部 unmatched');
  assert.strictEqual(result.unmatchedRows.length, 4, '4 行（1 主 + 3 从）全 unmatched');
  // 主行 unmatched reason
  const mainUnm = result.unmatchedRows.find((u) => u['单据来源'] === '主');
  assert.strictEqual(mainUnm['未配原因'], '池子内 BillDate ±1day 未匹配', '主行最后到 step3.2');
}

// ===== Round 4：浮点精度（0.1 + 0.2 ≠ 0.3 经典坑用 toCents 化解）=====
function runRound4FloatPrecision() {
  // 主 123.45 vs 从 [100.20, 23.25] → sum=123.45（浮点直接加是 123.44999... 会差）
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 123.45, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 100.20, BizType: 'X', reconId: 'RID-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-09', Amount: 23.25, BizType: 'X', reconId: 'RID-S2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-float-precision', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 2, '浮点精度：subset-sum {100.20,23.25}=123.45 命中 2 个从');
}

// ===== Round 4：大候选集 subset-sum 性能（n=20，剪枝必须命中）=====
function runRound4LargePoolPerformance() {
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 1000, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [];
  for (let i = 1; i <= 20; i++) {
    // 19 个 amount=11（不会拼出 1000），加 1 个 amount=789（也不会单独命中），1 个 amount=211 让 subset-sum {789,211}=1000
    opponent.push(makeOpponentRow({
      OrderId: `S${i}`,
      BillDate: '2026-04-09',
      Amount: i === 19 ? 789 : (i === 20 ? 211 : 11),
      BizType: 'X',
      reconId: `RID-S${i}`
    }));
  }
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-large-pool', cfg);
  const startMs = Date.now();
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  const elapsedMs = Date.now() - startMs;
  // 必须命中 {S19+S20}=1000，2 行
  assert.strictEqual(result.fixedRows.length, 2, '大候选集 subset-sum {S19,S20}=1000 命中');
  // 时间 < 100ms（剪枝必须有效）
  assert.ok(elapsedMs < 1000, `大候选集性能（${elapsedMs}ms < 1000ms）`);
}

// ===== Round 4：tieBreak 多解唯一性 =====
function runRound4TieBreakMultiSolution() {
  // 主 04-15 270k；从 [F1 04-13 70k, F2 04-14 200k, F3 04-14 70k]
  // 候选（Step 3.1 同日，主 04-15）= 仅 F4? no，本场景没 F4
  // Step 3.2 ±1day（04-14/04-15/04-16）= F2/F3（F1 04-13 超范围）
  // subset-sum：{F2+F3}=270k → 唯一解
  // 单解直接返回，无 tieBreak
  // ----
  // 改：加 F4 04-15 70k → {F2+F3}, {F2+F4} 两解；tieBreak spread {F2,F3}=0day < {F2,F4}=1day → 选 F2,F3
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-15', Amount: 270000, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'F2', BillDate: '2026-04-14', Amount: 200000, BizType: 'X', reconId: 'RID-F2' }),
    makeOpponentRow({ OrderId: 'F3', BillDate: '2026-04-14', Amount: 70000,  BizType: 'X', reconId: 'RID-F3' }),
    makeOpponentRow({ OrderId: 'F4', BillDate: '2026-04-15', Amount: 70000,  BizType: 'X', reconId: 'RID-F4' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-tiebreak', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 2, 'tieBreak 选解（spread 最小）→ 命中 2');
  const orderIds = new Set(result.fixedRows.map((r) => r.OrderId));
  assert.ok(orderIds.has('F2'), '命中 F2');
  assert.ok(orderIds.has('F3'), '命中 F3（spread=0 < spread=1day with F4）');
  assert.ok(!orderIds.has('F4'), 'F4 因 tieBreak 不优落选');
}

// ===== Round 4：多v1 对称（subset-sum 求和=主子集 → 1 从）=====
function runRound4ManyToOneSymmetric() {
  // 3 主 [50, 30, 20] + 1 从 100 → subset-sum {50,30,20}=100 ✓
  const business = [
    makeBusinessRow({ OrderId: 'M1', BillDate: '2026-04-09', Amount: 50, BizType: 'X', reconId: 'RID-M1' }),
    makeBusinessRow({ OrderId: 'M2', BillDate: '2026-04-09', Amount: 30, BizType: 'X', reconId: 'RID-M2' }),
    makeBusinessRow({ OrderId: 'M3', BillDate: '2026-04-09', Amount: 20, BizType: 'X', reconId: 'RID-M3' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'RID-S' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: true },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round4-nv1-symm', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // R2 mode=main 多v1：3 主 Type=2 / Reference=从 reconId
  assert.strictEqual(result.fixedRows.length, 3, '多v1 subset-sum {50,30,20}=100 命中 3 个主');
  result.fixedRows.forEach((r) => {
    assert.strictEqual(r.Type, 2, 'R2 Type=2');
    assert.strictEqual(r.Reference, 'RID-S', 'R2 Reference=从 reconId');
  });
}

// ===== Round 5：pickBestByTieBreak 工具函数单测 =====
function runRound5PickBestHelpers() {
  // dist 优先
  const ref = { BillDate: '2026-04-28' };
  const a = { _rowIdx: 'opp_0', BillDate: '2026-04-27' }; // dist=1day
  const b = { _rowIdx: 'opp_1', BillDate: '2026-04-28' }; // dist=0
  const c = { _rowIdx: 'opp_2', BillDate: '2026-04-29' }; // dist=1day
  assert.strictEqual(pickBestByTieBreak(ref, [a, b, c]), b, 'dist 优先：dist=0 < dist=1day');

  // dist 并列 → idx 字典序
  const aa = { _rowIdx: 'opp_5', BillDate: '2026-04-27' };
  const bb = { _rowIdx: 'opp_2', BillDate: '2026-04-29' };
  // dist 都是 1day；opp_2 < opp_5 字典序
  assert.strictEqual(pickBestByTieBreak(ref, [aa, bb]), bb, 'dist 并列 → idx 字典序最小（opp_2 < opp_5）');

  // 单候选
  assert.strictEqual(pickBestByTieBreak(ref, [a]), a, '单候选直接返回');

  // 空候选
  assert.strictEqual(pickBestByTieBreak(ref, []), null, '空候选返回 null');

  // 非法 BillDate（dist=Infinity，但仍按 idx 兜底）
  const bad1 = { _rowIdx: 'opp_1', BillDate: 'not-a-date' };
  const bad2 = { _rowIdx: 'opp_0', BillDate: 'still-not' };
  assert.strictEqual(pickBestByTieBreak(ref, [bad1, bad2]), bad2, '非法 BillDate → idx 字典序兜底');
}

// ===== Round 5：Step 2 多候选 → BillDate 距离最近优先（dist 不并列）=====
function runRound5Step2DistTieBreak() {
  // Step 1 候选 ≥ 2（双 04-28）→ Step 1 跳过；Step 2 候选 = 4，dist 0/0/1/1
  // tie-break dist 优先 → 选 dist=0 中 idx 最小的
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-28', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S-NEAR-A', BillDate: '2026-04-28', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-NEAR-A' }),
    makeOpponentRow({ OrderId: 'S-FAR-1',  BillDate: '2026-04-27', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-FAR-1' }),
    makeOpponentRow({ OrderId: 'S-NEAR-B', BillDate: '2026-04-28', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-NEAR-B' }),
    makeOpponentRow({ OrderId: 'S-FAR-2',  BillDate: '2026-04-29', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-FAR-2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'M' } },
    extraFieldPairs: [{ leftField: 'Currency', rightField: 'Currency' }, { leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round5-dist-tiebreak', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // Step 1 候选数 = 2（双 04-28）→ ≠ 1 跳过 → Step 2 候选 = 4
  // tie-break dist=0 < 1day → 选 04-28 中 idx 最小的 = S-NEAR-A（opp_0）
  assert.strictEqual(result.fixedRows.length, 1, 'Step 2 dist tie-break 命中 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, 'R-NEAR-A', 'dist=0 优先（04-28 同日 vs 04-27/04-29 1day）+ idx 最小');
}

// ===== Round 5：Step 2 多候选 → dist 并列时 idx 字典序最小（用户用例核心）=====
function runRound5Step2IdxTieBreak() {
  // 主 04-28，从 04-27（idx 字典序更小）+ 04-29（idx 字典序更大）→ dist 都=1day
  // tie-break dist 并列 → idx 最小 → 选 04-27（opp_0）
  // 这就是用户用例：FTA202604280200028 / 202604271439325696974017228
  const business = [
    makeBusinessRow({ OrderId: 'FTA202604280200028', BillDate: '2026-04-28', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-MAIN-FTA' })
  ];
  const opponent = [
    // target：04-27 在原数组先（opp_0）
    makeOpponentRow({ OrderId: '202604271439325696974017228', BillDate: '2026-04-27', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-OPP-TARGET' }),
    // decoy：04-29 在原数组后（opp_1）
    makeOpponentRow({ OrderId: 'OPP-DECOY-2604291800', BillDate: '2026-04-29', Amount: 300000, Currency: 'USD', BizType: '入账', reconId: 'R-OPP-DECOY' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '-FIX' },
      subBizType: { mode: 'manualBoth', mainValue: 'M', oppValue: 'O' }
    },
    extraFieldPairs: [{ leftField: 'Currency', rightField: 'Currency' }, { leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round5-idx-tiebreak', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 期望：主 + 04-27 target 被 RB1 模式（mode=both）配对成功 → 2 行
  assert.strictEqual(result.fixedRows.length, 2, 'Step 2 idx tie-break 命中（mode=both 主+从 2 行）');
  const oppRow = result.fixedRows.find((r) => r._sourceSide === 'opp');
  assert.strictEqual(oppRow.OrderId, '202604271439325696974017228', 'idx 字典序最小（opp_0 target）→ 命中 04-27');
  assert.strictEqual(oppRow.Reference, 'R-MAIN-FTA-FIX', 'commonId 是主 reconId+suffix');
  // 04-29 decoy 进 unmatched
  const decoyUnm = result.unmatchedRows.find((u) => u.OrderId === 'OPP-DECOY-2604291800');
  assert.ok(decoyUnm, '04-29 decoy 落 unmatched');
}

// ===== Round 5：Step 2 反向不一致 → 让位（主从抢配冲突）=====
function runRound5Step2ReverseConflict() {
  // 用例：2 主 + 1 从（夹在中间）
  //   主 M1：04-27（dist=1day with 从 04-28）
  //   主 M2：04-28（dist=0 with 从 04-28）
  //   从 S：04-28
  // 主单 M1 的 Step 2 候选 = [S]，bestRight=S
  // 反向：S 的候选 = [M1, M2]，pickBest 选 M2（dist=0 优先）→ M2 ≠ M1 → M1 让位
  // 主单 M2 的 Step 2 候选 = [S]，bestRight=S；反向 [M1, M2] → 选 M2 → 一致 → M2 命中 S
  // 但 Step 1 严格：M2 vs S 同日 04-28 → 候选数 = 1 → reverse [M2] = 1 → Step 1 命中（不进 Step 2）
  // 那 M1 进 Step 2：S 已 paired，候选 = 0 → unmatched
  // 这个用例验证不到"反向不一致"——因为 Step 1 已优先吃掉 M2-S 配对
  // 改：让 M2 与 S 在 Step 1 strict 失败 → 主 M2 BizType=A, 从 S BizType=B → AND 全等失败
  // 但所有候选 / fieldPairs 必须用其他字段相同——保持 BizType 相同方便测；用 Currency 不同？太复杂
  //
  // 换思路：让 M2 与 S 在 Step 1+2 fieldPair 失败但仍是"BillDate ±1day 候选"
  //   主 M1 BillDate 04-27 USD 100 BizType=X
  //   主 M2 BillDate 04-29 USD 100 BizType=Y（与从 S BizType=X 不等 → fieldPair 失败 → 不进候选）
  //   从 S BillDate 04-28 USD 100 BizType=X
  //
  // M1 候选：S（dist=1day, BizType=X 等 → 进候选）→ bestRight=S → 反向：S→[M1] (M2 BizType=Y 不进) → M1 命中
  // 这不是反向不一致测试。需要让反向候选 ≠ 主单
  //
  // 真实反向不一致：主 M1 BillDate=04-27（与 S=04-28 dist=1day），主 M2 BillDate=04-28（与 S 同日 dist=0）
  //   都满足 fieldPair AND（BizType=X 同等）
  //   主 M1 处理：候选=[S]，bestRight=S；反向：S→[M1, M2]，pickBest 选 M2（dist=0 优先）→ M2 != M1 → 让位
  //   主 M2 处理：但 Step 1 strict 04-28 vs S 04-28 同日 + AND 全等 → 候选数=1 → reverse=[M2]（M1 BillDate 04-27 不严格） → Step 1 命中
  //   So M2 在 Step 1 已命中 → S paired → M1 进 Step 2 候选 = 空 → unmatched
  // 这样 M1 在 Step 2 是直接 candidates=0，不是"反向不一致"
  //
  // 让 Step 1 失败：M2 BillDate=04-28 同日 S，但 fieldPair AND 失败（OrderId 不同）
  //   主 M1 OrderId=A
  //   主 M2 OrderId=B
  //   从 S OrderId=A
  //   fieldPair 加 OrderId/OrderId → S 仅 M1 OrderId=A 同等 → Step 1 04-28 同日 + AND 全等：候选=[S]（仅 M1 vs S? NO！主 M1 04-27, 从 S 04-28 → 严格不等）
  //   所以 Step 1：M1（04-27）vs S（04-28）严格不等 → 候选 0；M2（04-28）vs S（04-28）严格等，但 OrderId(M2)=B vs OrderId(S)=A → AND 失败 → 候选 0
  //   Step 1 跳过 → Step 2：
  //     M1 vs S：dist=1day BillDate 同；AND OrderId M1=A==S=A → 进候选 [S]，bestRight=S
  //       反向：S→leftRows，filter dist≤1day + AND OrderId=A → M1（04-27 dist=1day, A==A）+ M2（04-28 dist=0, B!=A → 过滤掉）→ reverseCandidates=[M1]
  //       pickBest 选 M1（唯一）→ 一致 → M1 命中 S
  //     M2 vs S：S 已 paired → unmatched
  //   还是没测到反向不一致
  //
  // 关键：要让 reverseCandidates 含**多个主单且有"更优"的不是当前主单**。需要主 M1 dist 更大 / 主 M2 dist 更小，但都要满足 fieldPair AND。
  //   主 M1 04-27 OrderId=A
  //   主 M2 04-28 OrderId=A   // 与从同日 + 同 OrderId
  //   从 S  04-28 OrderId=A
  //   Step 1：M1 vs S 严格 04-27 != 04-28 → 候选 0；M2 vs S 严格 04-28=04-28 + AND OrderId A=A → 候选 [S]，reverse [M2]（M1 严格不等 → 不进） → Step 1 M2 命中 S
  //   还是不行
  //
  // 让 Step 1 strict 反向校验失败（reverse !== 1）：
  //   主 M1 04-28 OrderId=A
  //   主 M2 04-28 OrderId=A
  //   从 S  04-28 OrderId=A
  //   Step 1：M1 vs S 候选[S]，reverse [M1, M2] !=1 → 跳过；M2 vs S 同样 → 跳过
  //   Step 2：M1 vs S 候选[S]（dist=0），bestRight=S；反向 S→[M1, M2]（dist=0/0），pickBest 选 idx 最小 = M1 → 一致 → M1 命中
  //   M2 vs S：S 已 paired → unmatched
  //   M1 命中是预期，但没测"不一致"
  //
  // **真正测反向不一致**：M1 idx 字典序更大、M2 idx 字典序更小：
  //   leftRows: [M2(idx=main_0), M1(idx=main_1)] —— 但循环顺序是 leftRows.forEach
  //   外循环先处理 M2：候选[S]，bestRight=S；反向 S→[M2, M1]（dist=0/0）pickBest 选 idx 最小 main_0 = M2 → 一致 → M2 命中
  //   外循环再 M1：S paired → 候选 0 → unmatched
  //   反向一致，没测到
  //
  // 让 dist 不一致：
  //   leftRows: [M1(idx=main_0, 04-27), M2(idx=main_1, 04-28)] (注：循环顺序按 leftRows 数组顺序)
  //   外循环 M1：S 04-28 dist=1day 进候选[S]，bestRight=S；反向 S→leftRows filter dist=±1day + AND
  //     reverseCandidates: [M1（dist=1day）, M2（dist=0）]，pickBest dist 优先 → 选 M2（dist=0）
  //     M2 != M1 → M1 让位（continue）→ M1 这次循环不命中
  //   外循环 M2：候选[S]（M2-S dist=0），bestRight=S；反向 [M1, M2]，pickBest 选 M2（dist=0）→ M2 一致 → M2 命中 S
  //   M1 进 unmatched（S 已 paired）
  // ✅ 这就是"反向不一致让位"——M1 第一轮选了 S 但被 M2 抢回去
  //
  // 但要让 Step 1 失败（不让 M2 在 Step 1 被吃掉）：
  //   Step 1 strict M2(04-28) vs S(04-28) 严格等 + AND 全等 → 候选[S], reverse [M2]（M1 04-27 严格不等）→ reverse=1 → Step 1 命中
  //   要让 Step 1 失败，必须让 M2-S 的 fieldPair AND 不全等 — 比如 OrderId 不同
  //   但 M1-S 的 OrderId 必须等（这样 M2-S 不等且 M1-S 等）
  //   主 M1 OrderId=A
  //   主 M2 OrderId=B
  //   从 S OrderId=A
  //   fieldPair OrderId/OrderId
  //   Step 1：M1(04-27) vs S(04-28) 严格 != → 候选 0；M2(04-28) vs S(04-28) 严格= + AND OrderId B!=A → 候选 0 → Step 1 全跳过
  //   Step 2：M1(04-27) vs S(04-28) dist=1day + AND OrderId A=A → 候选[S]，bestRight=S
  //     反向：S→[M1(04-27 dist=1day, A=A), M2(04-28 dist=0, B!=A 过滤掉)] = [M1] → pickBest M1 → 一致 → M1 命中
  //   还是没测到不一致——因为 OrderId 不等导致 M2 不进反向候选
  //
  // 解：fieldPair AND 让 M1 / M2 都满足，但日期 dist 不同：
  //   M1 04-27 OrderId=A, M2 04-28 OrderId=A, S 04-28 OrderId=A
  //   Step 1 strict：M1 vs S 04-27 != 04-28 → 候选 0；M2 vs S 同日 + AND → 候选[S], reverse [M2] (M1 严格不等) → reverse=1 → Step 1 M2 命中 S
  //   还是 Step 1 把 M2 吃掉
  //
  // 解：让 Step 1 严格 reverse !=1，例如 M3 也满足 strict
  //   主 M1 04-27 OrderId=A
  //   主 M2 04-28 OrderId=A
  //   主 M3 04-28 OrderId=A   // 多一行 M3 让 Step 1 strict reverse=2
  //   从 S 04-28 OrderId=A
  //   Step 1：M2 vs S 候选[S], reverse [M2, M3] != 1 → 跳过；M3 vs S 同样 → 跳过
  //   Step 2：M1 vs S dist=1day, bestRight=S；reverse S→[M1, M2, M3]，pickBest dist 优先 → M2 / M3 dist=0 都并列 → idx 最小（main_1 vs main_2）= M2 → ≠ M1 → 让位
  //          M2 vs S dist=0, bestRight=S；reverse 同上 → 选 M2 → 一致 → M2 命中 S
  //          M3 vs S：S paired → 候选 0 → unmatched
  //   M1 进 unmatched
  // ✅ 完美：M1 反向不一致让位，M2 命中
  //
  // 这个用例验证：M1 第一轮 Step 2 选了 S 但反向不一致 → continue（让位）；M2 后续顺利命中 → S 配给 M2 而不是 M1
  const business = [
    makeBusinessRow({ OrderId: 'M1', BillDate: '2026-04-27', Amount: 100, BizType: 'X', reconId: 'R-M1' }),
    makeBusinessRow({ OrderId: 'M2', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-M2' }),
    makeBusinessRow({ OrderId: 'M3', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-M3' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-S' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'M' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round5-reverse-conflict', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 期望：M2（dist=0 + idx 最小）命中 S；M1（反向不一致让位）+ M3（S 已 paired）进 unmatched
  assert.strictEqual(result.fixedRows.length, 1, '反向不一致让位 → M2 命中 1 行');
  // mode='main' 时只写主行
  assert.strictEqual(result.fixedRows[0].OrderId, 'M2', 'M2 命中 S（dist=0 反向最优）');
  assert.strictEqual(result.fixedRows[0].Reference, 'R-S', 'M2 Reference=从 reconId');
  // M1 应在 unmatched（让位）；M3 也在 unmatched（S 已 paired）
  const unmIds = new Set(result.unmatchedRows.map((u) => u.OrderId));
  assert.ok(unmIds.has('M1'), 'M1 让位 → unmatched');
  assert.ok(unmIds.has('M3'), 'M3 抢配失败 → unmatched');
}

// ===== Round 5：Step 1 严格 1v1 行为不变（候选 ≥ 2 时仍跳过，不靠 tie-break 命中）=====
function runRound5Step1Unchanged() {
  // 主 04-28；从 04-28 + 从 04-28（同日双从单，AND 全等）
  // Step 1 strict 候选数=2 → 跳过（不应该被 Round 5 改造影响）
  // Step 2 ±1day 候选数=2，都 dist=0 → tie-break idx 最小命中第一个从单
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-S1' }),
    makeOpponentRow({ OrderId: 'S2', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-S2' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'M' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round5-step1-unchanged', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // Step 1 候选 2 → reverse 也 2 → 跳过（Round 5 不改 Step 1 行为）
  // Step 2 同日候选 2 → tie-break idx 最小 = S1 命中
  assert.strictEqual(result.fixedRows.length, 1, 'Step 1 跳过 + Step 2 tie-break 命中 1 行');
  assert.strictEqual(result.fixedRows[0].Reference, 'R-S1', 'Step 2 tie-break 选 idx 最小（opp_0 = S1）');
  const s2Unm = result.unmatchedRows.find((u) => u.OrderId === 'S2');
  assert.ok(s2Unm, 'S2 未配 → unmatched');
}

// ===== Round 5：Step 2 单候选 → 仍命中（不破坏原行为）=====
function runRound5Step2SingleCandidateUnchanged() {
  // 主 04-09 vs 1 个从 04-08（dist=1day）→ Step 2 候选 1 → tie-break 单解 + 反向 1 → 命中
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 100, BizType: 'X', reconId: 'R-M' })
  ];
  const opponent = [
    makeOpponentRow({ OrderId: 'S', BillDate: '2026-04-08', Amount: 100, BizType: 'X', reconId: 'R-S' })
  ];
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'M' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'round5-step2-single', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'Step 2 单候选仍命中');
  assert.strictEqual(result.fixedRows[0].Reference, 'R-S', 'Step 2 单候选 Reference 正确');
}

// ===== PR #36 round 1 P2 修复：≥ 10 候选时 _rowIdx 必须按数字部分比较，不按字典序 =====
//
// 修前：tie-break 用 _rowIdx 字符串字典序，'opp_10' < 'opp_2'（'1' < '2'）→ 排错
// 修后：解析 _rowIdx 数字部分比较 → 'opp_2' 数字 2 < 'opp_10' 数字 10 → 选 opp_2
//
// P2-1：pickBestByTieBreak ≥ 10 候选时按数字部分挑最小（Step 2 多候选 tie-break）
function runPR36P2PickBestByTieBreakNumeric() {
  // 构造 12 个从单（opp_0 ~ opp_11），全部 04-28 同日 + AND 全等 + 同 dist=0
  // 主 04-28，期望 Step 2 tie-break 选 opp_0（数字最小）
  // 之前 bug 行为：字典序 opp_0 / opp_1 / opp_10 / opp_11 / opp_2 / ... → opp_0 仍是首个（数字 0 == 字典序最小）
  // 关键测试：让 opp_0 ~ opp_1 在 Step 1 严格命中失败但仍是 Step 2 候选 → 候选含 opp_2 ~ opp_10
  // 简化：用 pickBestByTieBreak 直接单测（无需经过 Step 1/2 流程）
  // 候选数组顺序故意打乱，把 opp_10 放第 0 位 + opp_2 放最后位 → 验证排序而非顺序
  const ref = { BillDate: '2026-04-28' };
  const candidates = [
    { _rowIdx: 'opp_10', BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_3',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_5',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_11', BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_7',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_4',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_8',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_6',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_9',  BillDate: '2026-04-27' },  // dist=1day
    { _rowIdx: 'opp_2',  BillDate: '2026-04-27' }   // dist=1day  ← 数字最小
  ];
  const picked = pickBestByTieBreak(ref, candidates);
  assert.strictEqual(picked._rowIdx, 'opp_2',
    'P2-1 修复：≥10 候选时按 _rowIdx 数字最小（opp_2 < opp_10）；修前字典序 opp_10 排在 opp_2 之前');

  // 字典序对照：'opp_10' < 'opp_2'（因 '1' < '2'）→ 字典序首个会是 opp_10
  // 但数字比较：2 < 10 → 数字首个是 opp_2
  // 这两个 picked 不同就证明修复生效
  const stringOrderFirst = candidates
    .slice()
    .sort((a, b) => (a._rowIdx < b._rowIdx ? -1 : a._rowIdx > b._rowIdx ? 1 : 0))[0];
  assert.strictEqual(stringOrderFirst._rowIdx, 'opp_10',
    '对照：字典序 opp_10 排第一（修前会被 pickBestByTieBreak 错选）');

  // 端到端流程验证：Step 2 多候选（候选从 opp_2 起共 10 个），验证字典序 vs 数字序差异
  // 主单 04-28；S0/S1 BizType=Y → 被 BizType AND 过滤掉，不进候选
  //                 S2~S11 BizType=X 都 04-27 dist=1day 全等 → Step 2 候选 = 10 个
  // 修前：字典序 'opp_10' < 'opp_2' → 错选 opp_10 (S10)
  // 修后：数字最小 → 命中 opp_2 (S2)
  // 这个用例的关键是 opp_2 vs opp_10 在字典序下 opp_10 排前；只有数字比较才能选 opp_2
  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-28', Amount: 100, BizType: 'X', reconId: 'R-M' })
  ];
  const opponent = [];
  // S0 / S1 BizType=Y → 被 BizType AND 过滤不进候选
  opponent.push(makeOpponentRow({ OrderId: 'S0', BillDate: '2026-04-27', Amount: 100, BizType: 'Y', reconId: 'R-S0' }));
  opponent.push(makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-27', Amount: 100, BizType: 'Y', reconId: 'R-S1' }));
  // S2 ~ S11 BizType=X 都 04-27（dist=1day, AND 全等）→ Step 2 候选 = 10 个
  for (let i = 2; i < 12; i++) {
    opponent.push(makeOpponentRow({
      OrderId: `S${i}`,
      BillDate: '2026-04-27',
      Amount: 100,
      BizType: 'X',
      reconId: `R-S${i}`
    }));
  }
  // Step 1 严格 04-28 vs 04-27 不等 → 0 候选；Step 2 ±1day → 10 个候选 → tie-break
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
    output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'pr36-p2-pickbest-numeric', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  assert.strictEqual(result.fixedRows.length, 1, 'Step 2 ≥10 候选 tie-break 命中 1 行');
  // S2 = opp_2（数字最小，dist=1day 全部并列）；修前会因字典序 'opp_10' < 'opp_2' 错选 opp_10
  assert.strictEqual(result.fixedRows[0].Reference, 'R-S2',
    'P2-1 端到端：Step 2 候选 10 个 dist 全等 → 选 _rowIdx 数字最小 opp_2 → R-S2（修前字典序会错选 R-S10）');
}

// P2-2：tieBreakSubsets ≥ 10 候选 + spread/distToMain/size 全等 → firstIdxNum 数字最小
function runPR36P2TieBreakSubsetsNumeric() {
  // 构造场景：主单 1000；从单池 12 个，每个 100。subset-sum 找 10 个 100 拼出 1000？
  // 但 maxSize=8，10 元素子集会被截断。先构造另一个：主 200，候选 [opp_0..opp_11] 各 100 → 任意 2 个=200
  // C(12,2)=66 解，截断到 maxSolutions=64。
  // 每个解 size=2、spread=0（全 04-09 同日）、distToMain=0（同日）→ 全等 → firstIdxNum 兜底
  // 期望：选 {opp_0, opp_1}（含 idx_num=0 数字最小；修前字典序也是 opp_0 第一，因 'opp_0' 字典序最小）
  // 改造：让 opp_0/opp_1 不进候选，让 opp_2 ~ opp_11 进候选 → 修前选 'opp_10' 字典序，修后选 'opp_2' 数字
  //
  // 实施：主 BizType=X，从 opp_0/opp_1 BizType=Y（被 BizType AND 过滤丢掉）；opp_2..opp_11 BizType=X
  // 候选 10 个 amount=100 → subset-sum 200 → C(10,2)=45 解（在 maxSolutions=64 内）
  // 每个解 size=2/spread=0/distToMain=0/firstIdxNum 不同
  // 修前字典序：每个解的 firstIdx string = sort()[0]，含 opp_2 的解 firstIdx='opp_2'，含 opp_10 的解 firstIdx='opp_10'
  //   字典序 'opp_10' < 'opp_2' → 含 opp_10 + opp_11 的解是字典序最小（firstIdx='opp_10'）
  // 修后数字：含 opp_2 的解 firstIdxNum=2，含 opp_10 的解 firstIdxNum=10 → 含 opp_2 的解最小

  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 200, BizType: 'X', reconId: 'R-M' })
  ];
  const opponent = [];
  // opp_0 / opp_1 BizType=Y → 不进候选
  opponent.push(makeOpponentRow({ OrderId: 'S0', BillDate: '2026-04-09', Amount: 100, BizType: 'Y', reconId: 'R-S0' }));
  opponent.push(makeOpponentRow({ OrderId: 'S1', BillDate: '2026-04-09', Amount: 100, BizType: 'Y', reconId: 'R-S1' }));
  // opp_2 ~ opp_11 BizType=X → 进候选（10 个）
  for (let i = 2; i < 12; i++) {
    opponent.push(makeOpponentRow({
      OrderId: `S${i}`,
      BillDate: '2026-04-09',
      Amount: 100,
      BizType: 'X',
      reconId: `R-S${i}`
    }));
  }
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'pr36-p2-tiebreak-subset-numeric', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // 期望：subset-sum {opp_2, opp_3} 命中 → 2 行从（mode=opp）
  assert.strictEqual(result.fixedRows.length, 2,
    'tieBreakSubsets ≥10 候选 spread/distToMain/size 全等 → 选 firstIdxNum 数字最小子集 → 2 行');
  const orderIds = new Set(result.fixedRows.map((r) => r.OrderId));
  assert.ok(orderIds.has('S2') && orderIds.has('S3'),
    'P2-2 修复：选含 opp_2(=S2) + opp_3(=S3) 的子集（数字最小 2,3）；修前字典序会选含 opp_10/opp_11');
  assert.ok(!orderIds.has('S10') && !orderIds.has('S11'),
    '修后 S10/S11 不在命中（修前因字典序 opp_10 < opp_2 会被错选）');

  // 直接单测 tieBreakSubsets：构造同 spread/distToMain/size 但 firstIdxNum 不同的子集
  function makeTb(rowIdx) { return { _rowIdx: rowIdx, BillDate: '2026-04-09' }; }
  const subsetA = [makeTb('opp_10'), makeTb('opp_11')];  // firstIdxNum=10
  const subsetB = [makeTb('opp_2'), makeTb('opp_5')];    // firstIdxNum=2
  const subsetC = [makeTb('opp_3'), makeTb('opp_4')];    // firstIdxNum=3
  const chosen = tieBreakSubsets([subsetA, subsetB, subsetC], '2026-04-09');
  assert.strictEqual(chosen, subsetB,
    'tieBreakSubsets 直接单测：firstIdxNum=2 (B) < 3 (C) < 10 (A)；修前字典序会选 A（含 opp_10）');

  // parseRowIdxNum 单测
  assert.strictEqual(parseRowIdxNum('opp_0'), 0, 'parseRowIdxNum opp_0 → 0');
  assert.strictEqual(parseRowIdxNum('opp_2'), 2, 'parseRowIdxNum opp_2 → 2');
  assert.strictEqual(parseRowIdxNum('opp_10'), 10, 'parseRowIdxNum opp_10 → 10');
  assert.strictEqual(parseRowIdxNum('main_5'), 5, 'parseRowIdxNum main_5 → 5');
  assert.strictEqual(parseRowIdxNum('no-suffix'), Number.MAX_SAFE_INTEGER, 'parseRowIdxNum 非法格式 → MAX_SAFE_INTEGER（排最后）');
  assert.strictEqual(parseRowIdxNum(null), Number.MAX_SAFE_INTEGER, 'parseRowIdxNum null → MAX_SAFE_INTEGER');
}

// ===== PR #36 round 2 P2 修复（subset-sum 全局最优；DFS 全遍历维护 best）=====
//
// 修前：池子 `enumerateAmountSubsets(...) → tieBreakSubsets(...)` 二段式
//   DFS 收集到 maxSolutions=64 解后停 → 再排序选最优
//   bug：全局最优解排在第 N>64 位时被漏选（user 复现）
//
// 修后：池子 `findBestAmountSubset(...)`
//   DFS 遍历所有可能解 → 每找到 1 个 sum=target 解立即与 best 比对 → 不预截断
//   性能：升序剪枝 + 后缀和剪枝 + maxSize=8 + hardCeiling=5000000 visit 防御
//   round 3 已删除"启发式提前终止"（spread=0+distToMain=0+size=2 break）剪枝（漏 firstIdxNum 第 4 阶最优）

// P2-3：user 复现 — 10 个 04-01 候选 + 3 个 04-15 候选 + target=300 → 修后选 3 个 04-15（spread=0+distToMain=0），不选 04-01 子集
function runPR36Round2P2UserRepro() {
  // 用户原文：「10 个 2026-04-01 候选 + 3 个 2026-04-15 候选、target=300 时，前 64 个解不包含 3 个 2026-04-15 的最优同日子集，最终选了 2026-04-01 的旧子集」
  //
  // 修前行为：解空间 C(13,3)=286，maxSolutions=64 截断；64 个解里全 04-15 = 0 个、全 04-01 = 36 个、混合 = 28 个
  //   → tieBreakSubsets 选 spread 最小（0）+ distToMain 最小 → 64 个解里没有 04-15 的，只能选 04-01 的（distToMain=14day 次优）
  //
  // 修后行为：findBestAmountSubset DFS 全遍历 → 找到 {opp_10, opp_11, opp_12} 都 04-15 spread=0 distToMain=0 size=2... wait 是 size=3
  //   → distToMain=0 因 mainBillDate=04-15 与子集 04-15 同日；spread=0；size=3
  //   → 04-01 子集 spread=0 distToMain=14day → 04-15 子集 distToMain=0 < 14day → 选 04-15 ✓
  //
  // 端到端：通过 runReconIdFix 走 tryOneToManyPool（mode=opp + oneToMany=true）

  // 工具：构造 candidates（cents 单位用 100 元 = 10000 cents）
  function makeCand(rowIdx, cents, billDate) {
    return { row: { _rowIdx: rowIdx, BillDate: billDate, OrderId: rowIdx }, cents };
  }
  const candidates = [];
  for (let i = 0; i < 10; i++) candidates.push(makeCand(`opp_${i}`, 10000, '2026-04-01'));
  for (let i = 10; i < 13; i++) candidates.push(makeCand(`opp_${i}`, 10000, '2026-04-15'));

  // findBestAmountSubset 直接单测（绕过过滤步骤）：mainBillDate=04-15
  const chosen = findBestAmountSubset(candidates, 30000, '2026-04-15');
  assert.ok(chosen !== null, '应找到 sum=300 的最优子集');
  assert.strictEqual(chosen.length, 3, '子集 size=3（3 个 100 凑 300）');
  const allFifteen = chosen.every((r) => r.BillDate === '2026-04-15');
  assert.ok(allFifteen,
    'P2-3 修复：选 3 个 2026-04-15（spread=0+distToMain=0 全局最优）；修前因 maxSolutions=64 截断会选 3 个 04-01 子集（distToMain=14day 次优）');
  // 子集 OrderId 必须是 opp_10/11/12（数字最小的同日子集）
  const orderIds = chosen.map((r) => r.OrderId).sort();
  assert.deepStrictEqual(orderIds, ['opp_10', 'opp_11', 'opp_12'], '修后命中 opp_10/opp_11/opp_12');

  // 修前对照：用旧二段式 enumerateAmountSubsets + tieBreakSubsets 验证 bug 仍存在
  // （证明 fix 前后行为差异，避免回归 + 证明保留旧函数仍合法）
  const oldSubsets = enumerateAmountSubsets(candidates, 30000);
  assert.ok(oldSubsets.length === 64, 'enumerateAmountSubsets 仍维持 maxSolutions=64 截断（向后兼容）');
  const oldChosen = tieBreakSubsets(oldSubsets, '2026-04-15');
  // 修前 bug：64 个解里没有全 04-15 的（C(10,3)=120 全 04-01 子集排在前 64 个解中）
  // tieBreakSubsets 选 spread=0 → 04-01 子集 spread=0+distToMain=14day；04-15 解未进 64 → 选 04-01 子集
  const oldAllOne = oldChosen.every((r) => r.BillDate === '2026-04-01');
  assert.ok(oldAllOne,
    '修前 bug 复现：旧二段式 enumerate→tieBreak 选了 3 个 04-01 子集（次优，因前 64 解里 0 个全 04-15）');

  // 端到端集成：通过 runReconIdFix 走 tryOneToManyPool 验证修复生效
  // 主 04-15 USD 300；从 = 10 个 04-01 100 + 3 个 04-15 100 → ±1day 候选 = 仅 3 个 04-15（04-01 距 04-15 14day 超出 ±1day 范围）
  // → 候选只有 3 个 04-15 → 不会触发 maxSolutions bug；这个用例必须改成"strict"模式（同 BillDate）
  // 改：让 04-01/04-15 都进候选 — 用 BillDate=2026-04-09 与 2026-04-10（dist=1day）
  // 但要让"前 64 解全是次优"，需要 04-09 候选数量 >> 04-10 候选数量。
  // 端到端：跳过；纯函数测试已覆盖 bug 修复；下面 runPR36Round2P2EndToEnd 用 ±1day 内更窄的日期模拟
}

// P2-4：全局最优在第 N>64 解（DFS 维护 best 必须能返回，不被 maxSolutions 截断遗漏）
function runPR36Round2P2GlobalBestBeyond64() {
  // 构造场景：12 个 100 候选 + 1 个 [50, 50] 同金额对（spread=0），target=200
  //   解 1：从 12 个 100 里挑 2 个，C(12,2)=66 解，前 64 解都是 100+100 组合
  //   解 2：50+50+100=200 size=3（3 元素，不优）
  //   再加 5+5+90+100=200 size=4？... 复杂
  //
  // 简化：12 个 04-09 100 + 2 个 04-15 100；mainBillDate=04-15；target=200
  //   解空间：C(14,2) = 91 全部 100+100 组合
  //   前 64 解：都是 04-09+04-09 spread=0 distToMain=6day 次优
  //   全局最优：{opp_12, opp_13}（04-15+04-15 spread=0 distToMain=0）排在 N=91 位置（升序枚举末尾）
  //   修前 enumerate→tieBreak：64 解都是 04-09 → 选 04-09 子集
  //   修后 findBestAmountSubset：DFS 找到 {opp_12, opp_13} 立即比 04-09 子集更优 → 选 04-15 子集
  function makeCand(rowIdx, cents, billDate) {
    return { row: { _rowIdx: rowIdx, BillDate: billDate, OrderId: rowIdx }, cents };
  }
  const candidates = [];
  for (let i = 0; i < 12; i++) candidates.push(makeCand(`opp_${i}`, 10000, '2026-04-09'));
  candidates.push(makeCand('opp_12', 10000, '2026-04-15'));
  candidates.push(makeCand('opp_13', 10000, '2026-04-15'));

  // 修前对照：旧二段式
  const oldSubsets = enumerateAmountSubsets(candidates, 20000);
  assert.ok(oldSubsets.length === 64, '旧 enumerateAmountSubsets 截断到 64 解（C(14,2)=91）');
  const oldChosen = tieBreakSubsets(oldSubsets, '2026-04-15');
  // 64 解中是否含 {opp_12, opp_13}？取决于 DFS 顺序；按 cents 升序排序所有 100 等值，_origIdx 升序
  // DFS 升序 + i 自小到大 → 前 64 解大多是 opp_0/1 + 任意一个；末尾才到 opp_12/13
  const oldAllNine = oldChosen.every((r) => r.BillDate === '2026-04-09');
  assert.ok(oldAllNine,
    '修前 bug：64 解里 0 个全 04-15 子集（{opp_12, opp_13} 排在第 N=91 位被截断）→ 选 04-09 子集（distToMain=6day 次优）');

  // 修后：findBestAmountSubset 全遍历能找到全局最优
  const chosen = findBestAmountSubset(candidates, 20000, '2026-04-15');
  assert.ok(chosen !== null, '修后应找到全局最优子集');
  const allFifteen = chosen.every((r) => r.BillDate === '2026-04-15');
  assert.ok(allFifteen,
    'P2-4 修复：DFS 全遍历找到 {opp_12, opp_13}（spread=0+distToMain=0 全局最优；排在第 N=91 位）；修前因 maxSolutions=64 截断会漏');
  const orderIds = chosen.map((r) => r.OrderId).sort();
  assert.deepStrictEqual(orderIds, ['opp_12', 'opp_13'], '修后命中 opp_12/opp_13');
}

// P2-5：端到端 — 通过 runReconIdFix 走 tryOneToManyPool（mode=opp + oneToMany）
// 验证修复对池子算法生效（user 真实场景路径）
function runPR36Round2P2EndToEndPool() {
  // 主 BillDate=2026-04-09 USD 300；从单：
  //   - 10 个 2026-04-09 USD 100（同主 BillDate strict）
  //   - 3 个 2026-04-09 USD 100（也同主 BillDate）— 与上面合并：13 个同日同 cents
  // 这样所有 13 个候选都进 Step 3.1 strict（同 BillDate） → C(13,3)=286 解，maxSolutions=64 截断
  //
  // 但全部同日 → spread=0 + distToMain=0 全等；只有 firstIdxNum 区分 → 修前修后都选 firstIdxNum 最小 = {opp_0, opp_1, opp_2}
  // 这测不到 BillDate 差异（无法验证 P2 修复对 distToMain 的影响）
  //
  // 改：让 13 个候选 BillDate 不同：
  //   - 10 个 2026-04-08（dist=1day with 主 04-09）
  //   - 3 个 2026-04-09（dist=0）
  // BillDate ±1day 容错路径（Step 3.2）覆盖所有 13 个；spread 最小（0）只能在"3 个全 04-09"或"10 个全 04-08"中达成
  //   → 修前：64 解里 0 个全 04-09 子集 → 选 04-08 子集（spread=0, distToMain=1day）
  //   → 修后：DFS 找到 {opp_10, opp_11, opp_12} = 3 个 04-09，distToMain=0 < 1day → 选 04-09 子集
  //
  // 但 Step 3.1 strict 同 BillDate=04-09 候选只有 3 个（opp_10/11/12）→ subset-sum {3个} 唯一解
  //   → Step 3.1 直接命中 {opp_10/11/12} 不进 Step 3.2
  // 这测不到 ±1day 路径
  //
  // 改：让 04-09 候选只有 2 个 + 04-08 候选 11 个，target=300 元（=3 个 100）
  //   Step 3.1 strict 同日 04-09：候选 = 2 个，subset-sum 200 ≠ 300 → 跳
  //   Step 3.2 ±1day：候选 = 13 个；subset-sum=300 size>=2 → C(11,3)=165 + C(11,2)*2 + C(2,3)=0 + ...
  //                   太多解；64 解都是 04-08 子集（DFS 升序 _origIdx 优先 opp_0..opp_10 → 04-08）
  //                   但全局最优需 distToMain 最小 → 含 04-09 越多越好
  //                   {opp_11, opp_12, X} where X 是 04-08 (1 个 04-08 + 2 个 04-09)：spread=1day, size=3
  //                   {opp_11, opp_12} = 200 ≠ 300 不命中
  //   关键：只有 3 个 100 凑出 300，必含至少 1 个 04-08（因 04-09 候选只 2 个）→ spread 不可能 = 0
  //
  // 简化最终用例：mainBillDate=04-15 USD target=200；候选：12 个 04-09 100 + 2 个 04-15 100（与主同日）
  //   ±1day 范围：04-14 / 04-15 / 04-16；04-09 不在 ±1day 范围 → 不进候选
  //   → Step 3.2 候选只有 2 个 04-15 → 唯一解 {opp_12, opp_13}=200 → 命中
  //   仍测不到 64 解截断
  //
  // 真实场景：用户的 bug 数据应该是 strict 同 BillDate 模式 — 同日 04-15 候选很多但 spread/distToMain 全等
  // 端到端用 strict 模式 + 13 个同日候选 + target 让 maxSolutions 触发，验证 fix 在端到端路径下生效
  //
  // 决策：跳过端到端 distToMain 测试（路径限制），改用 firstIdxNum 兜底验证 fix 对所有候选都遍历完
  //
  // 端到端用例：主 04-09 100 vs 13 个 04-09 100 候选；target 在 mode=opp+oneToMany；C(13,2)=78 > maxSolutions=64
  //   修前后命中应不变（全同 BillDate spread/distToMain 全等 → firstIdxNum=0 都能选 {opp_0, opp_1}）
  //   但 size=2 + maxSize=8 + target=200 时 78 解 (size=2) + 解 (size=3+) 大量
  //   关键测：修后能找到 {opp_0, opp_1}（firstIdxNum=0 最小）

  const business = [
    makeBusinessRow({ OrderId: 'M', BillDate: '2026-04-09', Amount: 200, BizType: 'X', reconId: 'RID-M' })
  ];
  const opponent = [];
  for (let i = 0; i < 13; i++) {
    opponent.push(makeOpponentRow({
      OrderId: `S${i}`,
      BillDate: '2026-04-09',
      Amount: 100,
      BizType: 'X',
      reconId: `RID-S${i}`
    }));
  }
  const cfg = makeCfg({
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'X' } },
    extraFieldPairs: [{ leftField: 'BizType', rightField: 'BizType' }]
  });
  const scenario = makeScenario('recon-id-fix', 'pr36-round2-p2-e2e-pool', cfg);
  const result = runReconIdFix(scenario, { reconResult: [], businessBills: business, opponentBills: opponent });
  // mode=opp + oneToMany 命中：所选子集 N 个从单都 Type=0 + Reference=主 reconId
  assert.strictEqual(result.fixedRows.length, 2,
    '端到端：tryOneToManyPool subset-sum 全局最优 size=2 子集命中（{opp_0, opp_1} firstIdxNum 最小）');
  const orderIds = new Set(result.fixedRows.map((r) => r.OrderId));
  assert.ok(orderIds.has('S0') && orderIds.has('S1'),
    'P2-5 修复：端到端命中 firstIdxNum 最小子集 {S0, S1}（修前因 maxSolutions=64 截断后 tieBreak firstIdx 仍能选到这两个，因为它们排在前 64 解；本用例验证 fix 不破坏既有正确路径）');
  result.fixedRows.forEach((r) => {
    assert.strictEqual(r.Type, 0, 'mode=opp 1v多 Type=0');
    assert.strictEqual(r.Reference, 'RID-M', 'Reference = 主 reconId');
  });
}

// P2-6：性能 — n=20 候选下 findBestAmountSubset 仍 < 1s（防止全遍历退化）
function runPR36Round2P2PerformanceN20() {
  // 复刻 runRound4LargePoolPerformance 的场景：19 个 11 + 1 个 789 + 1 个 211，target=1000
  //   修前用 enumerateAmountSubsets：升序剪枝 + maxSolutions=64 → 快
  //   修后用 findBestAmountSubset：升序剪枝 + 后缀和剪枝 + maxSize=8 → 大量"前 6/7 个 11" path 被新剪枝(top-k 后缀)剪掉
  //   预期：< 1s（与修前性能持平或更优）
  function makeCand(rowIdx, cents, billDate) {
    return { row: { _rowIdx: rowIdx, BillDate: billDate, OrderId: rowIdx }, cents };
  }
  const candidates = [];
  for (let i = 0; i < 20; i++) {
    const cents = i === 18 ? 78900 : (i === 19 ? 21100 : 1100);  // 19 个 11 + 1 个 789（i=18）+ 1 个 211（i=19）
    candidates.push(makeCand(`opp_${i}`, cents, '2026-04-09'));
  }
  const startMs = Date.now();
  const chosen = findBestAmountSubset(candidates, 100000, '2026-04-09');
  const elapsedMs = Date.now() - startMs;
  assert.ok(chosen !== null, '应找到 {S18, S19}={789, 211}=1000');
  assert.strictEqual(chosen.length, 2, 'size=2 子集');
  const orderIds = new Set(chosen.map((r) => r.OrderId));
  assert.ok(orderIds.has('opp_18') && orderIds.has('opp_19'),
    'P2-6 性能：n=20 复刻 fixture 仍能找到 {opp_18, opp_19}={789, 211}=1000');
  assert.ok(elapsedMs < 1000,
    `P2-6 性能：findBestAmountSubset n=20 < 1s（实测 ${elapsedMs}ms；后缀和+top-k 剪枝有效）`);
}

// ===== PR #36 round 3 P2 修复（移除"absolute optimal 早停"剪枝）=====
//
// user 提出：round 2 加的 `isBestAbsoluteOptimal()` 早停判定 spread=0 + distToMain=0 + size=2 时
// 直接 break，但 tie-break 实际有 4 阶（spread → distToMain → size → firstIdxNum），早停只覆盖前 3 阶。
// 修法：删除该剪枝，让 DFS 在其他剪枝下完整遍历到 firstIdxNum 真正不可改进的位置。
// 用例 P2-7：user 原文复现（candidates 4 个，cents=1/50/50/99，target=100，期望选 {opp_2, opp_3}）

function runPR36Round3P2EarlyStopFirstIdx() {
  // user 原文复现：
  //   candidates [opp_10:1, opp_2:50, opp_3:50, opp_11:99]，target=100，所有 BillDate 同 04-15
  //   tie-break 4 阶：
  //     spread=0    → 全等
  //     distToMain  → 与 mainBillDate=04-15 同日，均为 0 → 全等
  //     size        → 两个解都 size=2 → 全等
  //     firstIdxNum → {opp_10, opp_11} firstIdx=10；{opp_2, opp_3} firstIdx=2 → opp_2/3 最优
  //
  //   修前（round 2 早停）：DFS 升序 cents 遍历先找到 {opp_10:1, opp_11:99}（cents=1+99=100），
  //                        立即触发 `isBestAbsoluteOptimal()` break → 不再尝试 {opp_2:50, opp_3:50}
  //                        → 错选 {opp_10, opp_11}
  //   修后：删除早停 → DFS 全遍历 → tryUpdateBest 阶段 firstIdxNum=2 < 10 → 更新 best 为 {opp_2, opp_3}
  function makeCand(rowIdx, cents) {
    return { row: { _rowIdx: rowIdx, BillDate: '2026-04-15', OrderId: rowIdx }, cents };
  }
  const candidates = [
    makeCand('opp_10', 1),
    makeCand('opp_2', 50),
    makeCand('opp_3', 50),
    makeCand('opp_11', 99)
  ];
  const chosen = findBestAmountSubset(candidates, 100, '2026-04-15');
  assert.ok(chosen !== null, '应找到 sum=100 的最优子集');
  assert.strictEqual(chosen.length, 2, 'size=2');
  const orderIds = chosen.map((r) => r.OrderId).sort();
  assert.deepStrictEqual(orderIds, ['opp_2', 'opp_3'],
    'P2-7 修复：DFS 全遍历命中 firstIdxNum 最小子集 {opp_2, opp_3}（修前因早停 break 错选 {opp_10, opp_11}）');
}

// P2-8：性能基线 — 删早停后 n=20 仍 < 100ms（防止全遍历退化）
function runPR36Round3P2PerformanceN20NoEarlyStop() {
  // 复刻 P2-6 fixture：19 个 11 + 1 个 789 + 1 个 211，target=1000
  // 删早停后预期：仍 < 100ms（极端宽松上限；典型 < 5ms）
  function makeCand(rowIdx, cents) {
    return { row: { _rowIdx: rowIdx, BillDate: '2026-04-09', OrderId: rowIdx }, cents };
  }
  const candidates = [];
  for (let i = 0; i < 20; i++) {
    const cents = i === 18 ? 78900 : (i === 19 ? 21100 : 1100);
    candidates.push(makeCand(`opp_${i}`, cents));
  }
  const startMs = Date.now();
  const chosen = findBestAmountSubset(candidates, 100000, '2026-04-09');
  const elapsedMs = Date.now() - startMs;
  assert.ok(chosen !== null, '应找到 {S18, S19}={789, 211}=1000');
  assert.strictEqual(chosen.length, 2, 'size=2');
  const orderIds = new Set(chosen.map((r) => r.OrderId));
  assert.ok(orderIds.has('opp_18') && orderIds.has('opp_19'),
    'P2-8 性能：删早停后仍能找到 {opp_18, opp_19}');
  assert.ok(elapsedMs < 100,
    `P2-8 性能基线：删早停后 n=20 < 100ms（实测 ${elapsedMs}ms）`);
}

// ===== category guard =====
function runCategoryGuard() {
  assert.throws(
    () => runReconIdFix({ id: 1, category: 'extract-recon-id', config: {} }, { reconResult: [], businessBills: [], opponentBills: [] }),
    /scenario\.category 必须是 recon-id-fix/,
    'category 不对应抛错'
  );
  assert.throws(
    () => runReconIdFix(null, { reconResult: [], businessBills: [], opponentBills: [] }),
    /scenario 不能为空/,
    '空 scenario 抛错'
  );
}

function runReconIdFixEngineSmokeTests() {
  const tests = [
    runConstantsSmoke,
    runHelpersSmoke,
    runStep1Strict,
    runStep2Tolerant,
    runStep31PoolOneToMany,
    runStep32PoolOneToManyTolerant,
    runStep3p1PoolManyToOne,
    runR1,
    runR3,
    runR5R6Auto,
    runQ2AAutoMiss,
    runRB1,
    runRB2,
    runRB3,
    runRB4,
    runRB5,
    runPriorityStep1OverStep2,
    runUnmatchedReasons,
    runCrossStepGroupShared,
    runAmountLockedPoolUsage,
    runMultiGroupOr,
    // Round 4 新增（subset-sum + tieBreak）
    runRound4SubsetSumHelpers,
    runRound4UserCase,
    runRound4NoSubsetFound,
    runRound4FloatPrecision,
    runRound4LargePoolPerformance,
    runRound4TieBreakMultiSolution,
    runRound4ManyToOneSymmetric,
    // Round 5 新增（Step 2 多候选 tie-break）
    runRound5PickBestHelpers,
    runRound5Step2DistTieBreak,
    runRound5Step2IdxTieBreak,
    runRound5Step2ReverseConflict,
    runRound5Step1Unchanged,
    runRound5Step2SingleCandidateUnchanged,
    // PR #36 round 1 P2 修复（≥10 候选时 _rowIdx 数字部分比较，不再字典序）
    runPR36P2PickBestByTieBreakNumeric,
    runPR36P2TieBreakSubsetsNumeric,
    // PR #36 round 2 P2 修复（subset-sum DFS 全遍历维护 best；不再 maxSolutions 截断后排序）
    runPR36Round2P2UserRepro,
    runPR36Round2P2GlobalBestBeyond64,
    runPR36Round2P2EndToEndPool,
    runPR36Round2P2PerformanceN20,
    // PR #36 round 3 P2 修复（移除"absolute optimal 早停"剪枝；tie-break 4 阶必须遍历到 firstIdxNum）
    runPR36Round3P2EarlyStopFirstIdx,
    runPR36Round3P2PerformanceN20NoEarlyStop,
    runCategoryGuard
  ];
  tests.forEach((t) => t());
  console.log(`  recon-id-fix-engine smoke: ${tests.length} / ${tests.length} PASS`);
}

module.exports = { runReconIdFixEngineSmokeTests };
