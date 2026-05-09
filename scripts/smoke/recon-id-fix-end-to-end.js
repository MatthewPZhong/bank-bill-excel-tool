// v2.1.0-beta.1 PR-B Round 3：单据对账 ReconID 修复模块端到端 smoke 测试
// spec §九.2 — Round 3 重写：5 阶段算法 + RB4 Type=0 + unmatched 报告 + "基金"真实 fixture 回归

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');

const {
  readReconIdFixFile,
  writeReconIdFixOutput,
  writeUnmatchedReport,
  buildMainOutputFileName,
  buildUnmatchedReportFileName,
  UNMATCHED_REPORT_SHEET_NAME
} = require('../../src/main-process/recon-id-fix-io');
const { runReconIdFix } = require('../../src/main-process/recon-id-fix-engine');
const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME
} = require('../../src/constants/recon-id-fix-fields');

// ===== 工具：4 sheet 写盘 =====
function writeFourSheetXlsx({ reconRows, businessRows, opponentRows, savePath }) {
  const wb = XLSX.utils.book_new();
  const sheets = [
    { name: RECON_RESULT_SHEET_NAME, headers: RECON_RESULT_FIELDS.slice(), rows: reconRows },
    { name: BUSINESS_BILL_SHEET_NAME, headers: BUSINESS_BILL_FIELDS.slice(), rows: businessRows },
    { name: OPPONENT_BILL_SHEET_NAME, headers: OPPONENT_BILL_FIELDS.slice(), rows: opponentRows },
    { name: ORDER_REPAIR_SHEET_NAME, headers: ORDER_REPAIR_FIELDS.slice(), rows: [] }
  ];
  sheets.forEach(({ name, headers, rows }) => {
    const aoa = [headers, ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, sheet, name);
  });
  XLSX.writeFile(wb, savePath);
}

function rowToBusinessAoa(obj) {
  return BUSINESS_BILL_FIELDS.map((f) => obj[f] ?? '');
}
function rowToOpponentAoa(obj) {
  return OPPONENT_BILL_FIELDS.map((f) => obj[f] ?? '');
}
function rowToReconAoa(obj) {
  return RECON_RESULT_FIELDS.map((f) => obj[f] ?? '');
}

function makeScenario(name, config) {
  return { id: 1, category: 'recon-id-fix', name, priority: 0, enabled: true, config };
}

// 通用 cfg（Round 3：reconGroups 含 Amount 锁定 + 用户额外 fieldPairs）
function makeCfg({ matchRules, output, extraFieldPairs }) {
  const fieldPairs = [{ leftField: 'Amount', rightField: 'Amount', locked: true }];
  if (Array.isArray(extraFieldPairs)) extraFieldPairs.forEach((fp) => fieldPairs.push(fp));
  return {
    matchRules,
    billTypes: [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ],
    reconGroups: [{ leftTypeSeq: 1, rightTypeSeq: 2, fieldPairs }],
    output
  };
}

async function runReconIdFixEndToEndSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke-recon-id-fix-e2e');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // ===== E1：mode=main 全链路（Step 1 严格命中）=====
  {
    const filePath = path.join(tmpDir, 'e2e-main.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        rowToBusinessAoa({ OrderId: 'M-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, Bank: '工行', Currency: 'CNY', reconId: '' })
      ],
      opponentRows: [
        rowToOpponentAoa({ OrderId: 'M-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, Bank: '工行', Currency: 'CNY', reconId: 'RID-OPP-M1' })
      ],
      savePath: filePath
    });
    const session = readReconIdFixFile(filePath);
    const scenario = makeScenario('e2e-main', makeCfg({
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'SBT-MAIN' } }
    }));
    const result = runReconIdFix(scenario, session.sheets);
    assert.strictEqual(result.fixedRows.length, 1, 'E1 1 行');
    assert.strictEqual(result.unmatchedRows.length, 0, 'E1 0 unmatched');
    const outPath = path.join(tmpDir, buildMainOutputFileName('e2e-main', '202604301230'));
    await writeReconIdFixOutput({ fixedRows: result.fixedRows, savePath: outPath });
    const wb = XLSX.readFile(outPath);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[ORDER_REPAIR_SHEET_NAME], { header: 1, raw: true });
    const refCol = ORDER_REPAIR_FIELDS.indexOf('Reference');
    assert.strictEqual(aoa[1][refCol], 'RID-OPP-M1', 'E1 Reference 持久化');
  }

  // ===== E2：mode=opp 全链路（Step 1）=====
  {
    const filePath = path.join(tmpDir, 'e2e-opp.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        rowToBusinessAoa({ OrderId: 'O-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-MAIN-O1' })
      ],
      opponentRows: [
        rowToOpponentAoa({ OrderId: 'O-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, reconId: '' })
      ],
      savePath: filePath
    });
    const session = readReconIdFixFile(filePath);
    const scenario = makeScenario('e2e-opp', makeCfg({
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      output: { mode: 'opp', subBizType: { mode: 'manualOpp', oppValue: 'SBT-OPP' } }
    }));
    const result = runReconIdFix(scenario, session.sheets);
    assert.strictEqual(result.fixedRows.length, 1, 'E2 1 行');
    const outPath = path.join(tmpDir, buildMainOutputFileName('e2e-opp', '202604301230'));
    await writeReconIdFixOutput({ fixedRows: result.fixedRows, savePath: outPath });
    const wb = XLSX.readFile(outPath);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[ORDER_REPAIR_SHEET_NAME], { header: 1, raw: true });
    const refCol = ORDER_REPAIR_FIELDS.indexOf('Reference');
    assert.strictEqual(aoa[1][refCol], 'RID-MAIN-O1', 'E2 Reference=主边 reconId');
  }

  // ===== E3：mode=both 全链路（RB1 Step 1 + commonId reconId 校验）=====
  {
    const filePath = path.join(tmpDir, 'e2e-both.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        rowToBusinessAoa({ OrderId: 'B-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-MAIN-B1' })
      ],
      opponentRows: [
        rowToOpponentAoa({ OrderId: 'B-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, reconId: 'RID-OPP-B1' })
      ],
      savePath: filePath
    });
    const session = readReconIdFixFile(filePath);
    const scenario = makeScenario('e2e-both', makeCfg({
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      output: {
        mode: 'both',
        commonId: { source: 'main', suffix: '-FIX' },
        subBizType: { mode: 'manualBoth', mainValue: 'SBT-M', oppValue: 'SBT-O' }
      }
    }));
    const result = runReconIdFix(scenario, session.sheets);
    assert.strictEqual(result.fixedRows.length, 2, 'E3 主从 2 行');
    const outPath = path.join(tmpDir, buildMainOutputFileName('e2e-both', '202604301230'));
    await writeReconIdFixOutput({ fixedRows: result.fixedRows, savePath: outPath });
    const wb = XLSX.readFile(outPath);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[ORDER_REPAIR_SHEET_NAME], { header: 1, raw: true });
    const refCol = ORDER_REPAIR_FIELDS.indexOf('Reference');
    assert.strictEqual(aoa[1][refCol], 'RID-MAIN-B1-FIX', 'E3 commonId = 主 reconId + suffix');
    assert.strictEqual(aoa[2][refCol], 'RID-MAIN-B1-FIX', 'E3 commonId 共享');
  }

  // ===== E4：SubBizType auto 命中 全链路 =====
  {
    const filePath = path.join(tmpDir, 'e2e-auto-sbt.xlsx');
    writeFourSheetXlsx({
      reconRows: [
        rowToReconAoa({
          '业务类型': 'BT-AUTO',
          '业务部门单号': 'A-1',
          '业务部门单据子类型': 'SBT-AUTO-MAIN',
          '对手部门单号': 'A-1',
          '对手部门单据子类型': 'SBT-AUTO-OPP'
        })
      ],
      businessRows: [
        rowToBusinessAoa({ OrderId: 'A-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-AUTO', reconId: '' })
      ],
      opponentRows: [
        rowToOpponentAoa({ OrderId: 'A-1', BillType: 'biz', BillDate: '2026-04-09', Amount: 100, BizType: 'BT-AUTO', reconId: 'RID-OPP-A1' })
      ],
      savePath: filePath
    });
    const session = readReconIdFixFile(filePath);
    const scenario = makeScenario('e2e-auto', makeCfg({
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      output: { mode: 'main', subBizType: { mode: 'auto' } }
    }));
    const result = runReconIdFix(scenario, session.sheets);
    assert.strictEqual(result.fixedRows.length, 1, 'E4 1 行');
    assert.strictEqual(result.warnings.length, 0, 'E4 0 warning');
    assert.strictEqual(result.fixedRows[0].SubBizType, 'SBT-AUTO-MAIN', 'E4 auto SubBizType');
  }

  // ===== E5（Round 3）：unmatched.xlsx round-trip =====
  {
    // 主 1 vs 从 0 → 主 1 行进 unmatched
    const filePath = path.join(tmpDir, 'e2e-unmatched.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        rowToBusinessAoa({ OrderId: 'M-LONELY', BillType: 'biz', BillDate: '2026-04-09', Amount: 999, reconId: 'RID-LONELY' })
      ],
      opponentRows: [],
      savePath: filePath
    });
    const session = readReconIdFixFile(filePath);
    const scenario = makeScenario('e2e-unmatched', makeCfg({
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'X' } }
    }));
    const result = runReconIdFix(scenario, session.sheets);
    assert.strictEqual(result.fixedRows.length, 0, 'E5 0 fixedRows');
    assert.strictEqual(result.unmatchedRows.length, 1, 'E5 1 unmatched');
    const outPath = path.join(tmpDir, buildUnmatchedReportFileName('e2e-unmatched', '202605091230'));
    await writeUnmatchedReport({ unmatchedRows: result.unmatchedRows, savePath: outPath });
    const wb = XLSX.readFile(outPath);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[UNMATCHED_REPORT_SHEET_NAME], { header: 1, raw: true });
    assert.strictEqual(aoa.length, 2, 'E5 表头 + 1 行');
    assert.strictEqual(aoa[1][2], 'M-LONELY', 'E5 OrderId 持久化');
    assert.strictEqual(aoa[1][1], '主', 'E5 单据来源=主');
  }

  // ===== E6：fixture 真实文件 readReconIdFixFile 通过 =====
  {
    const fixturePath = path.join(__dirname, '..', '..', 'samples', '单据对账导出不平.xlsx');
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`E6 fixture 缺失：${fixturePath}`);
    }
    const session = readReconIdFixFile(fixturePath);
    assert.strictEqual(session.fileName, '单据对账导出不平.xlsx', 'E6 fixture 文件名');
    assert.deepStrictEqual(session.sheets.fixTemplate.headers, ORDER_REPAIR_FIELDS.slice(), 'E6 fix 表头与常量一致');
  }

  console.log('  recon-id-fix-end-to-end smoke: 6 / 6 PASS');
}

module.exports = { runReconIdFixEndToEndSmokeTests };
