// v2.0.0-beta.3 PR #32a：first-match-wins 调度引擎 smoke 测试
// 接入 smoke 流程

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  runAllScenarios,
  sortScenariosByPriority,
  filterScenariosByGwAvailability,
  filterOutReconIdFix
} = require('../../src/main-process/scenario-dispatcher');

const {
  writeBankStatementOutput,
  writeErrorReport
} = require('../../src/main-process/exceljs-writer');

const ExcelJS = require('exceljs');

// ===== 工具：构造场景 =====

function makeC1Scenario(overrides = {}) {
  return {
    id: 1,
    name: 'C1 调拨ReconId自提取',
    category: 'extract-recon-id',
    priority: 3,
    enabled: true,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
      extractByFeature: {
        enabled: true,
        searchFields: ['CustomerRef'],
        featureCode: 'FT',
        digitCount: 12,
        totalLength: 15
      },
      extractByOtherField: null
    },
    ...overrides
  };
}

function makeC2Scenario(overrides = {}) {
  return {
    id: 2,
    name: 'C2 outbound Fail打标',
    category: 'offset-bill-mark',
    priority: 2,
    enabled: true,
    config: {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' },
        { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
      ],
      markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
    },
    ...overrides
  };
}

function makeC3Scenario(overrides = {}) {
  return {
    id: 3,
    name: 'C3 调拨ReconId From网关',
    category: 'gateway-recon-join',
    priority: 1,
    enabled: true,
    config: {
      reconFields: [
        { seq: 1, gwField: 'Currency', bankField: 'Currency' },
        { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank', bankField: 'Channel' }
      ],
      assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
    },
    ...overrides
  };
}

// v2.1.0-beta.1 PR-A round 2 P1：C4 场景（dispatcher 应过滤掉，不喂给 runScenario）
// PR-B Q1=B：reconGroups[]
function makeC4Scenario(overrides = {}) {
  return {
    id: 4,
    name: 'C4 单据对账ReconID修复',
    category: 'recon-id-fix',
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'X' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'Y' }] }
      ],
      reconGroups: [
        { leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs: [{ leftField: 'OrderId', rightField: 'OrderId' }] }
      ],
      output: {
        mode: 'main',
        commonId: null,
        subBizType: { mode: 'auto', mainValue: null, oppValue: null }
      }
    },
    ...overrides
  };
}

async function runScenarioDispatcherSmokeTests() {
  // ===== Dispatcher D1: 单 C1 命中 =====
  {
    const bankRows = [
      { _rowId: 'r1', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: '' },
      { _rowId: 'r2', CustomerRef: 'no_match', 'Extra Information': '', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC1Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 1, 'D1 应有 1 行命中');
    assert.strictEqual(result.modifiedRows[0]._rowId, 'r1', 'D1 应是 r1');
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 1, 'D1 应记 scenarioId');
    assert(result.modifiedRows[0]._modifiedColumns.has('ReconciliationId'), 'D1 应记 column');
    assert.strictEqual(result.stats.hitRowCount, 1, 'D1 stats hitRowCount');
    assert.strictEqual(result.stats.scenarioHitCount, 1, 'D1 scenarioHitCount');
    assert.deepStrictEqual(result.stats.hitScenarios.map((s) => s.id), [1], 'D1 hitScenarioIds 应含命中场景 id');
  }

  // ===== Dispatcher D2: 单 C2 命中（双锁）=====
  {
    const bankRows = [
      { _rowId: 'rA', FundType: 'outbound Fail', CustomerRef: 'CUST-A', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'rB', FundType: 'outbound', CustomerRef: 'CUST-A', 'Credit Amount': 0, 'Debit Amount': 100 }
    ];
    const result = runAllScenarios(bankRows, null, [makeC2Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 2, 'D2 双锁应 2 行');
    const rowIds = result.modifiedRows.map((r) => r._rowId).sort();
    assert.deepStrictEqual(rowIds, ['rA', 'rB'], 'D2 双方都应入 modifiedRows');
    // rA 没改字段，但 _hitScenarioId 也应填上（dispatcher 视 lockedRowIds 全部为命中）
    const rA = result.modifiedRows.find((r) => r._rowId === 'rA');
    assert.strictEqual(rA._hitScenarioName, 'C2 outbound Fail打标', 'D2 leftRow 也记 hitScenario');
    // rB 改了 FundType
    const rB = result.modifiedRows.find((r) => r._rowId === 'rB');
    assert(rB._modifiedColumns.has('FundType'), 'D2 rB 应记 FundType 改动');
  }

  // ===== Dispatcher D3: first-match-wins（C1 优先级 3 + C3 优先级 1 同行）=====
  {
    const bankRows = [
      {
        _rowId: 'rX',
        CustomerRef: 'AFT123456789012',
        'Extra Information': '',
        Currency: 'CNY',
        'Credit Amount': 100,
        'Debit Amount': 0,
        MerchantId: 'M001',
        Channel: 'BankA',
        ReconciliationId: ''
      }
    ];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_FROM_C3' }];
    const result = runAllScenarios(bankRows, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 1, 'D3 应 1 行');
    assert.strictEqual(
      result.modifiedRows[0]._hitScenarioId,
      1,
      'D3 first-match-wins：C1 优先级 3 > C3 优先级 1，应记 C1'
    );
    assert.strictEqual(
      bankRows[0].ReconciliationId,
      'AFT123456789012',
      'D3 ReconciliationId 应被 C1 写入，C3 不再覆盖'
    );
    // PR #32b：hitScenarioIds 仅含命中的 C1（C3 被锁行了无命中）
    assert.deepStrictEqual(result.stats.hitScenarios.map((s) => s.id), [1], 'D3 hitScenarioIds 仅含 C1（C3 已被锁过）');
  }

  // ===== Dispatcher D4: gwRows = null → C3 类被过滤 =====
  {
    const bankRows = [
      { _rowId: 'rY', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC3Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D4 C3 被过滤应 0 行');
    assert.strictEqual(result.stats.skippedC3Count, 1, 'D4 stats.skippedC3Count');
  }

  // ===== Dispatcher D5: 全部 disabled → 无命中 =====
  {
    const bankRows = [{ _rowId: 'rZ', CustomerRef: 'AFT123456789012', ReconciliationId: '' }];
    const c1Disabled = makeC1Scenario({ enabled: false });
    const result = runAllScenarios(bankRows, null, [c1Disabled]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D5 全部 disabled 应 0 行');
    assert.strictEqual(result.stats.scenarioHitCount, 0, 'D5 scenarioHitCount');
    assert.deepStrictEqual(result.stats.hitScenarios.map((s) => s.id), [], 'D5 无命中时 hitScenarioIds 为空');
  }

  // ===== Dispatcher D6（Codex F1 P1 回归）：dispatcher in-place 修改特性 =====
  // 算法引擎会 row[col] = newValue，所以连续两次跑同一份 rows，第二次结果会漂移。
  // main.js IPC 必须每次 run 前 deep clone session 数据，否则 first-match-wins 失效。
  {
    const baseRow = {
      _rowId: 'r1',
      CustomerRef: 'AFT123456789012',
      'Extra Information': '',
      Currency: 'CNY',
      'Credit Amount': 100,
      'Debit Amount': 0,
      MerchantId: 'M001',
      Channel: 'BankA',
      ReconciliationId: ''
    };
    const sharedRows = [baseRow];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_C3' }];
    // 第一次跑：C1 优先级 3 应锁该行，写 ReconciliationId='AFT123456789012'
    const r1 = runAllScenarios(sharedRows, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    assert.strictEqual(r1.modifiedRows[0]._hitScenarioId, 1, 'D6 第一次应 C1 命中');
    assert.strictEqual(sharedRows[0].ReconciliationId, 'AFT123456789012', 'D6 第一次 C1 写入');
    // 第二次跑同一份 sharedRows（已被改）：C1 oldValue 已等于目标值
    // → C1 不再视为修改 → 该行不进 lockedRowIds → C3 可能覆盖
    // 这是 dispatcher 的 in-place 修改特性，必须由调用方 clone 防御
    const r2 = runAllScenarios(sharedRows, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    // 第二次结果 vs 第一次会不一致（具体表现取决于算法判定 oldValue == newValue 时是否仍 lock）
    // 关键断言：dispatcher 不保证幂等；调用方负责 clone
    const r1IsC1 = r1.modifiedRows.length > 0 && r1.modifiedRows[0]._hitScenarioId === 1;
    const r2IsC3 = r2.modifiedRows.length > 0 && r2.modifiedRows[0]._hitScenarioId === 3;
    const driftDetected = r1IsC1 && (r2IsC3 || r2.modifiedRows.length === 0);
    assert(driftDetected, 'D6 连续 in-place 跑应漂移（第二次不再是 C1 命中）');
  }

  // ===== Dispatcher D7（Codex F1 P1 回归）：调用方 clone 后跑 → 结果幂等 =====
  {
    const baseRow = {
      _rowId: 'r1',
      CustomerRef: 'AFT123456789012',
      'Extra Information': '',
      Currency: 'CNY',
      'Credit Amount': 100,
      'Debit Amount': 0,
      MerchantId: 'M001',
      Channel: 'BankA',
      ReconciliationId: ''
    };
    const originalRows = [baseRow];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_C3' }];
    // 每次 clone 后跑 → 应得到一致结果
    const work1 = structuredClone(originalRows);
    const r1 = runAllScenarios(work1, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    const work2 = structuredClone(originalRows);
    const r2 = runAllScenarios(work2, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    assert.strictEqual(r1.modifiedRows[0]._hitScenarioId, r2.modifiedRows[0]._hitScenarioId, 'D7 clone 后两次结果应一致');
    assert.strictEqual(r1.modifiedRows[0]._hitScenarioId, 1, 'D7 应稳定 C1 命中');
    // 原始数据未被改
    assert.strictEqual(originalRows[0].ReconciliationId, '', 'D7 originalRows 保持纯净');
  }

  // ===== Dispatcher D8（Codex Round 2 F1 P1 回归）：warnings-only 场景 =====
  // C1 多字段值不一致 → 不修改 + 产 warning。dispatcher.errorReport 应非空，
  // modifiedRows 应为空。main.js export 必须基于此把 error-report 落盘
  // （即使 modifiedRows.length === 0）。
  {
    const c1 = makeC1Scenario({
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
    });
    // 同行两个字段含不同的 ReconId → 一致性校验失败
    const bankRows = [
      {
        _rowId: 'rIncon',
        CustomerRef: 'AFT111111111111',
        'Extra Information': 'BFT222222222222',
        ReconciliationId: ''
      }
    ];
    const result = runAllScenarios(bankRows, null, [c1]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D8 不一致 → modifiedRows 应空');
    assert(result.errorReport.length > 0, 'D8 不一致 → errorReport 应非空');
    assert(
      result.errorReport.some((w) => w.code === 'inconsistent-recon-id-values'),
      'D8 应有 inconsistent-recon-id-values warning'
    );
    assert(result.errorReport[0].scenarioId, 'D8 errorReport 注入 scenarioId');
  }

  // ===== Helper unit: sortScenariosByPriority =====
  {
    const list = [
      { id: 5, priority: 1 },
      { id: 1, priority: 3 },
      { id: 3, priority: 3 },
      { id: 7, priority: 2 }
    ];
    const sorted = sortScenariosByPriority(list);
    assert.deepStrictEqual(sorted.map((s) => s.id), [1, 3, 7, 5], 'sortScenariosByPriority 应 priority desc, id asc');
  }

  // ===== Helper unit: filterScenariosByGwAvailability =====
  // Codex Round 3 F1 P2：仅 null/undefined 过滤，[] 不过滤（让 C3 产 no-gateway-rows warning）
  {
    const list = [{ category: 'extract-recon-id' }, { category: 'gateway-recon-join' }, { category: 'offset-bill-mark' }];
    assert.strictEqual(filterScenariosByGwAvailability(list, null).length, 2, 'gwRows null → 过滤 C3');
    assert.strictEqual(filterScenariosByGwAvailability(list, undefined).length, 2, 'gwRows undefined → 过滤 C3');
    assert.strictEqual(filterScenariosByGwAvailability(list, []).length, 3, 'gwRows = [] → 不过滤（让 C3 产 warning）');
    assert.strictEqual(filterScenariosByGwAvailability(list, [{}]).length, 3, 'gwRows 非空 → 全保留');
  }

  // ===== Dispatcher D9（Codex Round 3 F1 P2 回归）：gwRows=[] 时 C3 仍跑 + 产 warning =====
  // 用户导入了结构正确但无数据行的网关账单 → C3 应跑出 no-gateway-rows warning
  // dispatcher 不能把 [] 当成 null 而过滤掉 C3，否则 warning 静默丢失
  {
    const bankRows = [
      { _rowId: 'b9', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, [], [makeC3Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D9 modifiedRows 应空');
    assert(
      result.errorReport.some((w) => w.code === 'no-gateway-rows'),
      'D9 应有 no-gateway-rows warning'
    );
    // D4 仍要求：gwRows = null 时 C3 类被过滤
    const r2 = runAllScenarios(bankRows, null, [makeC3Scenario()]);
    assert.strictEqual(r2.stats.skippedC3Count, 1, 'D9 vs D4: gwRows=null 仍按之前过滤');
  }

  // ===== Helper unit: filterOutReconIdFix =====
  // v2.1.0-beta.1 PR-A round 2 P1：C4 (`recon-id-fix`) 走独立流水线，dispatcher 应过滤
  // v2.1.0-beta.3 PR #39 Finding 1（P1）：扩展到所有 C4 category（含 'gateway-recon-id-fix'）
  {
    const list = [
      { category: 'extract-recon-id' },
      { category: 'recon-id-fix' },
      { category: 'offset-bill-mark' },
      { category: 'recon-id-fix' },
      { category: 'gateway-recon-id-fix' }
    ];
    const filtered = filterOutReconIdFix(list);
    assert.strictEqual(filtered.length, 2, 'filterOutReconIdFix 应剔除 3 个 C4（2 个 recon-id-fix + 1 个 gateway-recon-id-fix）');
    assert(filtered.every((s) => s.category !== 'recon-id-fix' && s.category !== 'gateway-recon-id-fix'), '不应保留任何 C4');
    assert(filtered.some((s) => s.category === 'extract-recon-id'), '应保留 C1');
    assert(filtered.some((s) => s.category === 'offset-bill-mark'), '应保留 C2');
    // 防御：null/undefined 元素也应被过滤掉
    assert.strictEqual(filterOutReconIdFix([null, undefined, { category: 'extract-recon-id' }]).length, 1);
    // gateway-recon-id-fix 单独 case
    assert.strictEqual(filterOutReconIdFix([{ category: 'gateway-recon-id-fix' }]).length, 0,
      'gateway-recon-id-fix 也应被剔除');
  }

  // ===== Dispatcher D10（v2.1.0-beta.1 PR-A round 2 P1）：=====
  // 一个 enabled C1 + 一个 enabled C4 → dispatcher 只跑 C1，C4 被剔，
  // runScenario 不会因 C4 default 分支 throw。
  {
    const bankRows = [
      { _rowId: 'rD10', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC1Scenario(), makeC4Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 1, 'D10 应仅 C1 命中 1 行');
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 1, 'D10 应是 C1 (id=1)');
    assert.deepStrictEqual(result.stats.hitScenarios.map((s) => s.id), [1], 'D10 hitScenarioIds 仅含 C1');
    assert.strictEqual(result.stats.skippedC4Count, 1, 'D10 stats.skippedC4Count 应等于 C4 数量');
  }

  // ===== Dispatcher D11（v2.1.0-beta.1 PR-A round 2 P1）：=====
  // 仅 enabled C4 → dispatcher 不该 throw，应静默 skip 并返回空结果
  {
    const bankRows = [
      { _rowId: 'rD11', CustomerRef: 'X', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC4Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D11 modifiedRows 应空');
    assert.strictEqual(result.stats.scenarioHitCount, 0, 'D11 scenarioHitCount=0');
    assert.strictEqual(result.stats.skippedC4Count, 1, 'D11 skippedC4Count=1');
    assert.deepStrictEqual(result.stats.hitScenarios.map((s) => s.id), [], 'D11 hitScenarioIds 空');
  }

  // ===== Dispatcher D12（v2.1.0-beta.1 PR-A round 2 P1）：=====
  // disabled C4 不计入 skippedC4Count（与 disabled 其他类一致：先 enabled 过滤，再 C4 过滤）
  {
    const bankRows = [{ _rowId: 'rD12', CustomerRef: 'X', ReconciliationId: '' }];
    const c4Disabled = makeC4Scenario({ enabled: false });
    const result = runAllScenarios(bankRows, null, [c4Disabled]);
    assert.strictEqual(result.stats.skippedC4Count, 0, 'D12 disabled C4 不计入 skippedC4Count');
  }

  // ===== v2.1.7 round 3 F8 (spec §9.8.7 🚨 资金红线)：unmatchedRows 反向 filter =====

  // F8-1：unmatchedRows = bankRows - modifiedRows（完整性 + 互斥）
  {
    const bankRows = [
      { _rowId: 'F8-r1', CustomerRef: 'FT', ReconciliationId: '', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'F8-r2', CustomerRef: 'NO_MATCH', ReconciliationId: '' },
      { _rowId: 'F8-r3', CustomerRef: 'FT', ReconciliationId: '', 'Credit Amount': 200, 'Debit Amount': 0 }
    ];
    // 仅 C1 场景命中 'FT' 前缀
    const c1 = {
      id: 1, name: 'F8 C1', category: 'extract-recon-id', priority: 1, enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
        conditionsLogic: 'OR',
        extractByFeature: null,
        extractByOtherField: { field: 'CustomerRef' }
      }
    };
    const result = runAllScenarios(bankRows, null, [c1]);
    // 资金红线断言
    assert(Array.isArray(result.unmatchedRows), 'F8-1 unmatchedRows 是数组');
    assert.strictEqual(
      result.modifiedRows.length + result.unmatchedRows.length,
      bankRows.length,
      'F8-1 modifiedRows + unmatchedRows = bankRows (无遗漏)'
    );
    // F8-r1 / F8-r3 命中（CustomerRef 含 FT），F8-r2 未命中
    assert.strictEqual(result.modifiedRows.length, 2, 'F8-1 modifiedRows = 2');
    assert.strictEqual(result.unmatchedRows.length, 1, 'F8-1 unmatchedRows = 1');
    assert.strictEqual(result.unmatchedRows[0]._rowId, 'F8-r2', 'F8-1 unmatchedRows[0] = F8-r2');
    assert.strictEqual(result.stats.unmatchedRowCount, 1, 'F8-1 stats.unmatchedRowCount = 1');
  }

  // F8-2：无重复（first-match-wins 互斥；modifiedIds ∩ unmatchedIds = ∅）
  {
    const bankRows = [
      { _rowId: 'F8-r1', CustomerRef: 'AFT123456789012', ReconciliationId: '' },
      { _rowId: 'F8-r2', CustomerRef: 'NO', ReconciliationId: '' },
      { _rowId: 'F8-r3', CustomerRef: 'BFT222333444555', ReconciliationId: '' }
    ];
    const c1 = {
      id: 1, name: 'F8-2 C1', category: 'extract-recon-id', priority: 1, enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
        conditionsLogic: 'OR',
        extractByFeature: null,
        extractByOtherField: { field: 'CustomerRef' }
      }
    };
    const result = runAllScenarios(bankRows, null, [c1]);
    const modifiedIds = new Set(result.modifiedRows.map((r) => r._rowId));
    const unmatchedIds = new Set(result.unmatchedRows.map((r) => r._rowId));
    const intersection = [...modifiedIds].filter((id) => unmatchedIds.has(id));
    assert.strictEqual(intersection.length, 0, 'F8-2 modifiedRows ∩ unmatchedRows = ∅');
  }

  // F8-3 🚨 资金红线 baseline：modifiedRows 行为完全不动
  //   重跑 baseline 用例（C1 多字段命中 + r5）;modifiedRows.length 必须等于 v2.1.6 baseline 1
  //   spec §9.8.3 关键不变量：rowLockSet.has(r._rowId) 条件完全不动
  {
    const bankRows = [
      { _rowId: 'F8-base-r1', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: '' }
    ];
    const c1 = {
      id: 1, name: 'F8-3 baseline', category: 'extract-recon-id', priority: 1, enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
        conditionsLogic: 'OR',
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
    const result = runAllScenarios(bankRows, null, [c1]);
    // 资金红线核心：modifiedRows.length === 1（与 v2.1.6 baseline 完全一致）
    assert.strictEqual(result.modifiedRows.length, 1, 'F8-3 🚨 modifiedRows.length = 1 (与 v2.1.6 baseline 完全一致)');
    assert.strictEqual(result.modifiedRows[0]._rowId, 'F8-base-r1', 'F8-3 modifiedRows[0] = F8-base-r1');
    assert.strictEqual(bankRows[0].ReconciliationId, 'AFT123456789012', 'F8-3 ReconciliationId 写入正确');
    assert.strictEqual(result.unmatchedRows.length, 0, 'F8-3 unmatchedRows = 0');
  }

  // F8-4：空 bankRows
  {
    const result = runAllScenarios([], null, []);
    assert.strictEqual(result.modifiedRows.length, 0, 'F8-4 空输入 modifiedRows = 0');
    assert.strictEqual(result.unmatchedRows.length, 0, 'F8-4 空输入 unmatchedRows = 0');
    assert.strictEqual(result.stats.unmatchedRowCount, 0, 'F8-4 stats.unmatchedRowCount = 0');
  }

  // F8-5：无场景 enabled → 全部 unmatched
  {
    const bankRows = [
      { _rowId: 'F8-5-r1', CustomerRef: 'X', ReconciliationId: '' },
      { _rowId: 'F8-5-r2', CustomerRef: 'Y', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, []);
    assert.strictEqual(result.modifiedRows.length, 0, 'F8-5 无场景 modifiedRows = 0');
    assert.strictEqual(result.unmatchedRows.length, 2, 'F8-5 无场景 unmatchedRows = 全部');
  }

  // F8-6：unmatchedRows 保留原始字段（不带 _hitScenarioId / _modifiedColumns 等诊断列）
  {
    const bankRows = [{ _rowId: 'F8-6-r1', CustomerRef: 'NO', ReconciliationId: '', 'Credit Amount': 50 }];
    const result = runAllScenarios(bankRows, null, []);
    assert.strictEqual(result.unmatchedRows.length, 1, 'F8-6 unmatchedRows = 1');
    const unmatched = result.unmatchedRows[0];
    assert.strictEqual(unmatched._rowId, 'F8-6-r1', 'F8-6 _rowId 保留（内部字段）');
    assert.strictEqual(unmatched.CustomerRef, 'NO', 'F8-6 原始 CustomerRef 保留');
    assert.strictEqual(unmatched['Credit Amount'], 50, 'F8-6 原始 Credit Amount 保留');
    // 不带诊断列
    assert.strictEqual(unmatched._hitScenarioId, undefined, 'F8-6 不带 _hitScenarioId 诊断列');
    assert.strictEqual(unmatched._hitScenarioName, undefined, 'F8-6 不带 _hitScenarioName 诊断列');
    assert.strictEqual(unmatched._modifiedColumns, undefined, 'F8-6 不带 _modifiedColumns 诊断列');
  }

  console.log('  scenario-dispatcher: 21/21 PASS');
}

// ===== exceljs-writer round-trip =====

async function runExceljsWriterSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // I1: 主输出标黄 round-trip
  {
    const headers = ['col1', 'col2', 'col3'];
    const rows = [
      { col1: 'a', col2: 'b', col3: 'c', _rowId: 'r1', _modifiedColumns: new Set(['col2']) },
      { col1: 'x', col2: 'y', col3: 'z', _rowId: 'r2', _modifiedColumns: new Set(['col1', 'col3']) }
    ];
    const out = path.join(tmpDir, 'main-output.xlsx');
    await writeBankStatementOutput(rows, headers, out);
    assert(fs.existsSync(out), 'I1 文件应被创建');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    // v2.1.16-beta.6 需求B：命中行在「命中场景」sheet；第1列「命中明细」，原数据列右移1（colIdx+2）
    const sheet = wb.getWorksheet('命中场景');
    assert.strictEqual(sheet.getCell(1, 1).value, '命中明细', 'I1 表头第1列=命中明细');
    assert.strictEqual(sheet.getCell(1, 2).value, 'col1', 'I1 表头 col1（右移1）');
    assert.strictEqual(sheet.getCell(2, 3).value, 'b', 'I1 数据 r1.col2（右移1）');
    // r1.col2 被标黄（col2 在第3列）
    const r1c2Fill = sheet.getCell(2, 3).fill;
    assert(r1c2Fill && r1c2Fill.fgColor && r1c2Fill.fgColor.argb === 'FFFFFF00', 'I1 r1.col2 应黄底');
    // r1.col1 未标黄（col1 在第2列）
    const r1c1Fill = sheet.getCell(2, 2).fill;
    assert(!r1c1Fill || !r1c1Fill.fgColor, 'I1 r1.col1 不应黄底');
    // r2.col1 被标黄（col1 在第2列）
    const r2c1Fill = sheet.getCell(3, 2).fill;
    assert(r2c1Fill && r2c1Fill.fgColor && r2c1Fill.fgColor.argb === 'FFFFFF00', 'I1 r2.col1 应黄底');
  }

  // I2: error-report 5 列（v3.0.4 F3：第 3 列「行号」→「对账ID」+ 三级回退）
  {
    const warnings = [
      // 第 1 条：enrich 注入 reconciliationId → 第 3 列显示对账ID（非 rowId）
      { scenarioId: 1, scenarioName: 'C1 提取', rowId: 'r5', reconciliationId: 'AFT123456789012', code: 'inconsistent-recon-id-values', message: '多字段值不一致' },
      // 第 2 条：无 reconciliationId/reconId → 回退 rowId（旧 shape 兼容）
      { scenarioId: 2, scenarioName: 'C2 打标', rowId: 'r10', code: 'one-to-many', message: '一对多匹配' }
    ];
    const out = path.join(tmpDir, 'error-report.xlsx');
    await writeErrorReport(warnings, out);
    assert(fs.existsSync(out), 'I2 文件应被创建');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet('error-report');
    assert.strictEqual(sheet.getCell(1, 1).value, '时间戳', 'I2 表头 1');
    assert.strictEqual(sheet.getCell(1, 2).value, '场景名', 'I2 表头 2');
    assert.strictEqual(sheet.getCell(1, 3).value, '对账ID', 'I2 表头 3（F3：行号→对账ID）');
    assert.strictEqual(sheet.getCell(1, 4).value, '原因', 'I2 表头 4');
    assert.strictEqual(sheet.getCell(2, 2).value, 'C1 提取', 'I2 r2 场景名');
    assert.strictEqual(sheet.getCell(2, 3).value, 'AFT123456789012', 'I2 r2 对账ID（reconciliationId 非空优先）');
    assert.strictEqual(sheet.getCell(2, 4).value, '多字段值不一致', 'I2 r2 原因');
    assert.strictEqual(sheet.getCell(3, 3).value, 'r10', 'I2 r3 对账ID（无 reconid → 回退 rowId）');
  }

  // I3: 空 modifiedRows 也能写表头
  {
    const headers = ['col1', 'col2'];
    const out = path.join(tmpDir, 'empty.xlsx');
    await writeBankStatementOutput([], headers, out);
    assert(fs.existsSync(out), 'I3 空数据也应能写文件');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    // v2.1.16-beta.6 需求B：空 modifiedRows → 「命中场景」sheet 仅表头（命中明细 + 原列）
    const sheet = wb.getWorksheet('命中场景');
    assert.strictEqual(sheet.getCell(1, 1).value, '命中明细', 'I3 表头第1列=命中明细');
    assert.strictEqual(sheet.getCell(1, 2).value, 'col1', 'I3 表头 col1（右移1）');
    assert.strictEqual(sheet.actualRowCount, 1, 'I3 仅表头 1 行');
  }

  // ===== v2.1.16-beta.6 需求B：双 sheet「未命中场景 / 命中场景」（替换旧「渠道对账单 / 未命中场景行」）=====

  // F8-W1：caller 不传 unmatchedRows → 仅「命中场景」1 sheet
  {
    const headers = ['col1', 'col2'];
    const rows = [{ col1: 'a', col2: 'b', _rowId: 'r1', _modifiedColumns: new Set() }];
    const out = path.join(tmpDir, 'f8-w1.xlsx');
    await writeBankStatementOutput(rows, headers, out);
    // 不传 unmatchedRows → 仅「命中场景」1 sheet
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    assert.strictEqual(wb.worksheets.length, 1, 'F8-W1 不传 unmatchedRows 仅 1 sheet');
    assert.strictEqual(wb.worksheets[0].name, '命中场景', 'F8-W1 sheet 1 = "命中场景"');
  }

  // F8-W2：传 unmatchedRows = [] → 2 sheet（sheet1 未命中场景、sheet2 命中场景）
  {
    const headers = ['col1', 'col2'];
    const rows = [{ col1: 'a', col2: 'b', _rowId: 'r1', _modifiedColumns: new Set() }];
    const out = path.join(tmpDir, 'f8-w2.xlsx');
    await writeBankStatementOutput(rows, headers, out, []);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    assert.strictEqual(wb.worksheets.length, 2, 'F8-W2 传 unmatchedRows 即使空也 2 sheet');
    // sheet 顺序对调：sheet1 未命中场景、sheet2 命中场景
    assert.strictEqual(wb.worksheets[0].name, '未命中场景', 'F8-W2 sheet 1 = "未命中场景"');
    assert.strictEqual(wb.worksheets[1].name, '命中场景', 'F8-W2 sheet 2 = "命中场景"');
    // 未命中场景：第1行 A1 提示、第2行表头（空数据）
    const s1 = wb.worksheets[0];
    assert.strictEqual(s1.getCell(1, 1).value, '请检查，导入前请删除该sheet', 'F8-W2 未命中场景 A1 提示');
    assert.strictEqual(s1.getCell(2, 1).value, 'col1', 'F8-W2 未命中场景第2行表头 col1');
    assert.strictEqual(s1.getCell(2, 2).value, 'col2', 'F8-W2 未命中场景第2行表头 col2');
  }

  // F8-W3：传 unmatchedRows = N 行 → 未命中场景 sheet 含 A1 + 表头 + N 行数据
  {
    const headers = ['col1', 'col2', 'col3'];
    const rows = [{ col1: 'mod1', col2: 'mod2', col3: 'mod3', _rowId: 'r-mod', _modifiedColumns: new Set(['col1']) }];
    const unmatched = [
      { col1: 'um1-a', col2: 'um1-b', col3: 'um1-c', _rowId: 'r-um1', _modifiedColumns: new Set() },
      { col1: 'um2-a', col2: 'um2-b', col3: 'um2-c', _rowId: 'r-um2', _modifiedColumns: new Set() }
    ];
    const out = path.join(tmpDir, 'f8-w3.xlsx');
    await writeBankStatementOutput(rows, headers, out, unmatched);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    assert.strictEqual(wb.worksheets.length, 2, 'F8-W3 2 sheet');
    const s1 = wb.worksheets[0];  // 未命中场景（sheet1）
    assert.strictEqual(s1.name, '未命中场景', 'F8-W3 sheet 1 名');
    // A1 提示(第1行) + 表头(第2行) + 2 数据行(第3-4行) = 4 行
    assert.strictEqual(s1.actualRowCount, 4, 'F8-W3 未命中场景行数 = A1 + 表头 + 2 数据');
    // 表头在第 2 行
    assert.strictEqual(s1.getCell(2, 1).value, 'col1', 'F8-W3 表头 col1');
    assert.strictEqual(s1.getCell(2, 2).value, 'col2', 'F8-W3 表头 col2');
    assert.strictEqual(s1.getCell(2, 3).value, 'col3', 'F8-W3 表头 col3');
    // 数据从第 3 行起
    assert.strictEqual(s1.getCell(3, 1).value, 'um1-a', 'F8-W3 r1.col1 = um1-a');
    assert.strictEqual(s1.getCell(3, 3).value, 'um1-c', 'F8-W3 r1.col3 = um1-c');
    assert.strictEqual(s1.getCell(4, 1).value, 'um2-a', 'F8-W3 r2.col1 = um2-a');
    // 防泄漏：表头（第2行）不含 _ 前缀字段（headers 投影自动过滤）
    for (let c = 1; c <= 3; c++) {
      const cellHeader = String(s1.getCell(2, c).value || '');
      assert.ok(!cellHeader.startsWith('_'), `F8-W3 未命中场景表头不含 _ 前缀字段（实际 ${cellHeader}）`);
    }
  }

  // F8-W4：stripInternalFields helper 单测
  {
    const { stripInternalFields } = require('../../src/main-process/exceljs-writer');
    const cleaned = stripInternalFields({
      col1: 'a',
      _rowId: 'r1',
      col2: 'b',
      _hitScenarioId: 99,
      _modifiedColumns: new Set(['col1']),
      _hitScenarioName: 'X'
    });
    assert.deepStrictEqual(Object.keys(cleaned).sort(), ['col1', 'col2'], 'F8-W4 stripInternalFields 仅保留非 _ 前缀字段');
    assert.strictEqual(cleaned.col1, 'a', 'F8-W4 col1 保留');
    assert.strictEqual(cleaned.col2, 'b', 'F8-W4 col2 保留');
  }

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('  exceljs-writer: 7/7 PASS');
}

module.exports = {
  runScenarioDispatcherSmokeTests,
  runExceljsWriterSmokeTests
};
