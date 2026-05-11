#!/usr/bin/env node
// v2.1.0-beta.1 PR-D：P0-5d 真实 fixture 回归脚本（「基金」+ 「FX 中台入金」双 fixture）
//
// 「基金」：PRD §12 P0-5d / log.md round 4/5 baseline
//   - PP-only legacy = 80/30/50/0/0（round 4 算法核心）
//   - PP+PR 当前 SQLite scenario id=5 = 92/36/56/0/0
//
// 「FX 中台入金」：log.md 468 / PRD §16 PR-B Round 5 baseline
//   - PP-only suffix='_001' = 96/36/60/18/0
//
// 用法：
//   node scripts/test-v2.1.0-fund-fixture.js
//
// 输入：硬编码 fixture 路径（用户本机 Debug 目录）；缺失时跳过对应 case 但不算 FAIL
// 输出：stdout 打 stats 对照表；与 baseline 不符则退出码 1

const fs = require('node:fs');
const path = require('node:path');

const { readReconIdFixFile } = require('../src/main-process/recon-id-fix-io');
const { runReconIdFix } = require('../src/main-process/recon-id-fix-engine');

const DEFAULT_FIXTURE = '/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx';
const FX_FIXTURE = '/Users/pzhong/Desktop/小助手-Debug/2.1.0/FX中台入金-初始.xlsx';

// 两套 scenario 与对应 baseline
//
// 1) PP-only — Round 4 历史 baseline（PRD §12 P0-5d / log.md 186）
//    PRD 明确写「subset-sum 命中所有 PP 主从」= 80（PP 主 30 + PP 从 50）
//    用于：验证 round 4 subset-sum 算法核心（区别于 round 3 漏配 28/14/14/52）
const SCENARIO_PP_ONLY = {
  id: 5,
  name: '基金 (PP-only legacy)',
  category: 'recon-id-fix',
  priority: 0,
  enabled: 1,
  config: {
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] },
      { seq: 2, side: 'opp',  conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] }
    ],
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '_001' },
      subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
    },
    reconGroups: [
      {
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [
          { leftField: 'Currency', rightField: 'Currency' },
          { leftField: 'Amount',   rightField: 'Amount', locked: true },
          { leftField: 'BizType',  rightField: 'BizType' }
        ]
      }
    ]
  }
};
const EXPECTED_PP_ONLY = {
  fixedRowCount: 80,
  mainRowsTouched: 30,
  oppRowsTouched: 50,
  unmatchedRowCount: 0,
  warningCount: 0
};

// 2) PP+PR — 当前用户 SQLite scenarios.id=5 实际配置（2026-05-11 dump）
//    fixture 含 PR 主 6 + PR 从 6，全命中 → +12 行
//    用于：验证当前用户实际配置回归（PR 一组也跑通）
const SCENARIO_PP_PR = {
  id: 5,
  name: '基金 (PP+PR 当前)',
  category: 'recon-id-fix',
  priority: 0,
  enabled: 1,
  config: {
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] },
      { seq: 2, side: 'opp',  conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] },
      { seq: 3, side: 'main', conditions: [{ field: 'reconId', op: '包含', value: 'PR' }] },
      { seq: 4, side: 'opp',  conditions: [{ field: 'reconId', op: '包含', value: 'PR' }] }
    ],
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '_001' },
      subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
    },
    reconGroups: [
      {
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [
          { leftField: 'Currency', rightField: 'Currency' },
          { leftField: 'Amount',   rightField: 'Amount', locked: true },
          { leftField: 'BizType',  rightField: 'BizType' }
        ]
      },
      {
        leftTypeSeq: 3, rightTypeSeq: 4,
        fieldPairs: [
          { leftField: 'Amount',   rightField: 'Amount', locked: true },
          { leftField: 'Currency', rightField: 'Currency' },
          { leftField: 'BizType',  rightField: 'BizType' }
        ]
      }
    ]
  }
};
const EXPECTED_PP_PR = {
  fixedRowCount: 92,
  mainRowsTouched: 36,
  oppRowsTouched: 50 + 6,
  unmatchedRowCount: 0,
  warningCount: 0
};

// 3) FX 入账 scenario — Round 5 baseline 推断：PP-only + suffix='_001'
//    log.md 467 行 Reference=`PP_20260428020000_USD_HK0000720752_001` 反推 suffix='_001'
//    fixture 全 BizType='入账' / reconId 全以 'PP_' 开头
const SCENARIO_FX = {
  id: 99,
  name: 'FX 入账',
  category: 'recon-id-fix',
  priority: 0,
  enabled: 1,
  config: {
    matchRules: { oneToOne: true, oneToMany: true, manyToOne: false },
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] },
      { seq: 2, side: 'opp',  conditions: [{ field: 'reconId', op: '包含', value: 'PP' }] }
    ],
    output: {
      mode: 'both',
      commonId: { source: 'main', suffix: '_001' },
      subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
    },
    reconGroups: [
      {
        leftTypeSeq: 1, rightTypeSeq: 2,
        fieldPairs: [
          { leftField: 'Currency', rightField: 'Currency' },
          { leftField: 'Amount',   rightField: 'Amount', locked: true },
          { leftField: 'BizType',  rightField: 'BizType' }
        ]
      }
    ]
  }
};
const EXPECTED_FX = {
  fixedRowCount: 96,
  mainRowsTouched: 36,
  oppRowsTouched: 60,
  unmatchedRowCount: 18,
  warningCount: 0
};

function runOne(label, scenario, expected, sheets) {
  const startRun = Date.now();
  const result = runReconIdFix(scenario, sheets);
  const runMs = Date.now() - startRun;
  console.log(`\n=== ${label} ===  runReconIdFix 用时 ${runMs}ms`);

  const stats = result.stats;
  const rows = [
    ['fixedRowCount',     stats.fixedRowCount,     expected.fixedRowCount],
    ['mainRowsTouched',   stats.mainRowsTouched,   expected.mainRowsTouched],
    ['oppRowsTouched',    stats.oppRowsTouched,    expected.oppRowsTouched],
    ['unmatchedRowCount', stats.unmatchedRowCount, expected.unmatchedRowCount],
    ['warningCount',      stats.warningCount,      expected.warningCount]
  ];

  console.log('  字段                  实际    期望    判定');
  console.log('  --------------------- ------- ------- ----');
  let pass = true;
  for (const [name, actual, exp] of rows) {
    const ok = actual === exp;
    if (!ok) pass = false;
    console.log(`  ${name.padEnd(21)} ${String(actual).padEnd(7)} ${String(exp).padEnd(7)} ${ok ? 'PASS' : 'FAIL'}`);
  }

  if (!pass) {
    if (result.warnings.length > 0) {
      console.error(`  warnings (${result.warnings.length}):`);
      result.warnings.slice(0, 5).forEach((w, i) => console.error(`    [${i + 1}] ${JSON.stringify(w)}`));
    }
    if (result.unmatchedRows.length > 0) {
      console.error(`  unmatchedRows (${result.unmatchedRows.length}, 前 5):`);
      result.unmatchedRows.slice(0, 5).forEach((u, i) => console.error(`    [${i + 1}] ${JSON.stringify(u)}`));
    }
  }
  return pass;
}

function loadFixture(label, fixturePath) {
  console.log(`\n>>> ${label}: ${fixturePath}`);
  if (!fs.existsSync(fixturePath)) {
    console.warn(`!! fixture 不存在，跳过 ${label}`);
    return null;
  }
  const t = Date.now();
  const parsed = readReconIdFixFile(fixturePath);
  const ms = Date.now() - t;
  const { sheets } = parsed;
  console.log(`    读 4 sheet ${ms}ms — reconResult=${sheets.reconResult.length} / businessBills=${sheets.businessBills.length} / opponentBills=${sheets.opponentBills.length}`);
  return sheets;
}

function main() {
  let allPass = true;
  let totalRan = 0;

  // 「基金」fixture（PRD §12 P0-5d）
  const fundSheets = loadFixture('基金 fixture', DEFAULT_FIXTURE);
  if (fundSheets) {
    const r1 = runOne('Case A: 基金 PP-only legacy（Round 4 算法核心 baseline）', SCENARIO_PP_ONLY, EXPECTED_PP_ONLY, fundSheets);
    const r2 = runOne('Case B: 基金 PP+PR 当前用户 scenario（实际配置回归）',     SCENARIO_PP_PR,   EXPECTED_PP_PR,   fundSheets);
    if (!r1 || !r2) allPass = false;
    totalRan += 2;
  }

  // 「FX 中台入金」fixture（log.md 468 / PRD §16 PR-B Round 5 baseline）
  const fxSheets = loadFixture('FX 中台入金 fixture', FX_FIXTURE);
  if (fxSheets) {
    const r3 = runOne('Case C: FX 入账 PP-only suffix=_001（Round 5 baseline）', SCENARIO_FX, EXPECTED_FX, fxSheets);
    if (!r3) allPass = false;
    totalRan += 1;
  }

  console.log('');
  if (totalRan === 0) {
    console.error('✗ 没有 fixture 可跑');
    process.exit(2);
  }
  if (allPass) {
    console.log(`✓ P0-5d 真实 fixture 回归全部 PASS（共 ${totalRan} case）`);
  } else {
    console.error('✗ P0-5d 真实 fixture 回归 FAIL');
    process.exit(1);
  }
}

main();
