// v2.1.8 N3 Sheet 3「命中场景行」端到端集成验证脚本
//   目标：scenarios（带 priority + displayIndex）→ dispatcher → writer(includeHitScenarioSheet=true)
//        → readback xlsx → 验证 Sheet 3 结构 + 列名 + 行格式 `[displayIndex] name`
//   覆盖：N3-1（displayIndex 派发）+ N3-2（Sheet 3 写入）+ INTERNAL_FIELDS 白名单
//
// 用法：node scripts/test-v2.1.8-n3-sheet3.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

const { runAllScenarios } = require('../src/main-process/scenario-dispatcher');
const { writeBankStatementOutput } = require('../src/main-process/exceljs-writer');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

async function run() {
  console.log('==== v2.1.8 N3 Sheet 3 集成验证 ====');

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'n3-sheet3-'));
  const savePath = path.join(tmpdir, 'bank-result.xlsx');

  try {
    // ============================================================
    // Step 1：构造 2 个 C1 场景，priority 不同 → displayIndex 1 / 2（按 priority desc + id asc 排序）
    // ============================================================
    const scenarios = [
      {
        id: 101,
        name: '提取业务订单号',
        category: 'extract-recon-id',
        priority: 200,         // 高 priority → displayIndex=1
        displayIndex: 1,       // 模拟 repository.listScenarios 已附
        enabled: true,
        config: {
          conditionsLogic: 'AND',
          conditions: [{ field: 'BillType', op: '等于', value: 'TYPE_A' }],
          extractByOtherField: { field: 'BizOrderId' }
        }
      },
      {
        id: 102,
        name: '提取客户 ReconId',
        category: 'extract-recon-id',
        priority: 100,         // 低 priority → displayIndex=2
        displayIndex: 2,
        enabled: true,
        config: {
          conditionsLogic: 'AND',
          conditions: [{ field: 'BillType', op: '等于', value: 'TYPE_B' }],
          extractByOtherField: { field: 'CustomerRef' }
        }
      }
    ];

    // ============================================================
    // Step 2：构造 5 行 bank rows（_rowId 唯一）
    //   行 1 → 命中场景 101（TYPE_A）→ ReconciliationId 写 BIZ-001
    //   行 2 → 命中场景 102（TYPE_B）→ ReconciliationId 写 CUST-002
    //   行 3 → 命中场景 101 → ReconciliationId 写 BIZ-003
    //   行 4 → 未命中（TYPE_X）
    //   行 5 → 未命中（无 BizOrderId / 无 CustomerRef）
    // ============================================================
    const headers = ['Date', 'Amount', 'BillType', 'BizOrderId', 'CustomerRef', 'ReconciliationId', 'Description'];
    const bankRows = [
      { _rowId: 'R1', Date: '2026-04-01', Amount: 100, BillType: 'TYPE_A', BizOrderId: 'BIZ-001', CustomerRef: '', ReconciliationId: '', Description: 'row 1' },
      { _rowId: 'R2', Date: '2026-04-02', Amount: 200, BillType: 'TYPE_B', BizOrderId: '', CustomerRef: 'CUST-002', ReconciliationId: '', Description: 'row 2' },
      { _rowId: 'R3', Date: '2026-04-03', Amount: 300, BillType: 'TYPE_A', BizOrderId: 'BIZ-003', CustomerRef: '', ReconciliationId: '', Description: 'row 3' },
      { _rowId: 'R4', Date: '2026-04-04', Amount: 400, BillType: 'TYPE_X', BizOrderId: '', CustomerRef: '', ReconciliationId: '', Description: 'row 4' },
      { _rowId: 'R5', Date: '2026-04-05', Amount: 500, BillType: 'TYPE_A', BizOrderId: '', CustomerRef: '', ReconciliationId: '', Description: 'row 5' }
    ];

    // ============================================================
    // Step 3：跑 dispatcher
    // ============================================================
    const dispatchResult = runAllScenarios(bankRows, null, scenarios);

    // 验证 hitScenarios 结构
    assertEq(dispatchResult.stats.hitScenarios.length, 2, 'Step3.hitScenarios.length=2');
    // 第一个命中场景 = 101（先按 priority desc 跑）
    assertEq(dispatchResult.stats.hitScenarios[0].id, 101, 'Step3.hitScenarios[0].id=101');
    assertEq(dispatchResult.stats.hitScenarios[0].displayIndex, 1, 'Step3.hitScenarios[0].displayIndex=1');
    assertEq(dispatchResult.stats.hitScenarios[0].name, '提取业务订单号', 'Step3.hitScenarios[0].name');
    assertEq(dispatchResult.stats.hitScenarios[1].id, 102, 'Step3.hitScenarios[1].id=102');
    assertEq(dispatchResult.stats.hitScenarios[1].displayIndex, 2, 'Step3.hitScenarios[1].displayIndex=2');

    // modifiedRows 数量 = 3（R1 / R2 / R3）
    assertEq(dispatchResult.modifiedRows.length, 3, 'Step3.modifiedRows.length=3');
    // unmatchedRows 数量 = 2（R4 / R5）
    assertEq(dispatchResult.unmatchedRows.length, 2, 'Step3.unmatchedRows.length=2');
    // 完整性：modifiedRows + unmatchedRows == bankRows
    assertEq(dispatchResult.modifiedRows.length + dispatchResult.unmatchedRows.length, bankRows.length, 'Step3.完整性 mod+unmatched=total');

    // modifiedRows 每行带 _hitScenarioDisplayIndex + _hitScenarioName
    dispatchResult.modifiedRows.forEach((r) => {
      assertTrue(Number.isFinite(r._hitScenarioDisplayIndex), `Step3.${r._rowId} _hitScenarioDisplayIndex 已注入`);
      assertTrue(typeof r._hitScenarioName === 'string' && r._hitScenarioName, `Step3.${r._rowId} _hitScenarioName 已注入`);
    });

    // ============================================================
    // Step 4：调 writer(includeHitScenarioSheet=true)
    // ============================================================
    await writeBankStatementOutput(
      dispatchResult.modifiedRows,
      headers,
      savePath,
      dispatchResult.unmatchedRows,
      true  // includeHitScenarioSheet
    );
    assertTrue(fs.existsSync(savePath), 'Step4.xlsx 写入成功');

    // ============================================================
    // Step 5：readback xlsx 验证 3 sheet 结构
    // ============================================================
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(savePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    console.log('  sheets:', sheetNames);
    assertEq(wb.worksheets.length, 3, 'Step5.总共 3 个 sheet');
    // Sheet 3 名 = '命中场景行'
    assertTrue(sheetNames.includes('命中场景行'), 'Step5.Sheet 3 名包含「命中场景行」');

    // ============================================================
    // Step 6：验证 Sheet 3 列结构
    // ============================================================
    const sheet3 = wb.getWorksheet('命中场景行');
    assertEq(sheet3.columnCount, headers.length + 1, `Step6.Sheet 3 列数 = ${headers.length} + 1`);
    // 第 1 列 = Date（原 headers 第 1 列）
    assertEq(sheet3.getRow(1).getCell(1).value, 'Date', 'Step6.Sheet 3 列 1=Date');
    // 末列 = '命中场景'
    assertEq(sheet3.getRow(1).getCell(headers.length + 1).value, '命中场景', 'Step6.Sheet 3 末列=命中场景');

    // ============================================================
    // Step 7：验证 Sheet 3 行格式 — 「命中场景」列 = `[displayIndex] name`
    // ============================================================
    // 行 2 = 第一条 modifiedRow（R1，命中场景 101 displayIndex=1 name='提取业务订单号'）
    const row2Hit = sheet3.getRow(2).getCell(headers.length + 1).value;
    assertEq(row2Hit, '[1] 提取业务订单号', 'Step7.R1 命中场景列 = [1] 提取业务订单号');

    // 找到 R2 行（CustomerRef=CUST-002 列定位）
    // sheet 行从 1 开始（第 1 行表头），第 2-4 行是 3 条 modifiedRow
    // 验证所有 3 行都有正确的 hitLabel
    const allHitLabels = [];
    for (let i = 2; i <= 4; i++) {
      const label = sheet3.getRow(i).getCell(headers.length + 1).value;
      allHitLabels.push(label);
    }
    // 应该包含 [1] 提取业务订单号 × 2（R1, R3）+ [2] 提取客户 ReconId × 1（R2）
    assertEq(allHitLabels.filter((l) => l === '[1] 提取业务订单号').length, 2, 'Step7.[1] 提取业务订单号 出现 2 次');
    assertEq(allHitLabels.filter((l) => l === '[2] 提取客户 ReconId').length, 1, 'Step7.[2] 提取客户 ReconId 出现 1 次');

    // ============================================================
    // Step 8：内部字段不应泄漏到 xlsx（INTERNAL_FIELDS 过滤）
    //   不应出现 _rowId / _hitScenarioId / _hitScenarioName / _hitScenarioDisplayIndex / _modifiedColumns 列
    // ============================================================
    const headerRow = sheet3.getRow(1).values.slice(1); // ExcelJS values 第 0 索引是 undefined
    const internalLeaks = headerRow.filter((h) => typeof h === 'string' && h.startsWith('_'));
    assertEq(internalLeaks.length, 0, 'Step8.Sheet 3 无 _ 前缀内部字段泄漏');

    // ============================================================
    // Step 9：向后兼容验证 — 不传 includeHitScenarioSheet 默认 false（不输出 Sheet 3）
    // ============================================================
    const savePath2 = path.join(tmpdir, 'bank-result-legacy.xlsx');
    await writeBankStatementOutput(
      dispatchResult.modifiedRows,
      headers,
      savePath2,
      dispatchResult.unmatchedRows
      // 不传第 5 参数 = 默认 false
    );
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(savePath2);
    const sheetNames2 = wb2.worksheets.map((s) => s.name);
    assertTrue(!sheetNames2.includes('命中场景行'), 'Step9.向后兼容：不传 includeHitScenarioSheet → 无 Sheet 3');
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
