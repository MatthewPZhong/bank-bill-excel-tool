// v2.1.9 N5 Phase 6 T25 + T26 集成验证脚本（原 v2.1.8 N3 Sheet 3 → 改 v2.1.9 独立报表）
//
// 🔴 对外契约破坏性变更（spec §5.4）：
//   v2.1.8 PR #52 N3-2 引入主输出 xlsx Sheet 3「命中场景行」
//   v2.1.9 撤除 Sheet 3 → 改独立报表 writer（scenario-hit-rows-writer.js）
//   落位 error-reports/{date}/命中场景行-{basename}-{ts}.xlsx
//   列结构原 N 列 headers + 末尾 3 列「匹配渠道 / 匹配状态 / 命中场景」（D17=b 序）
//
// 覆盖：
//   N5-T24（writeScenarioHitRows 独立 writer）
//   N5-T25（主输出 xlsx 不再含 Sheet 3 — 仅 Sheet 1「渠道对账单」+ Sheet 2「未命中场景行」）
//   N5-T26（main.js bank-statement:export 接入独立报表 — 集成由手测 / smoke 覆盖，本脚本仅
//           直查 writer/dispatcher 端到端验证 4 种行结果矩阵 spec §2.2）
//   dispatcher 单维路径（无 deps）下旧行为：_hitChannelKey / _matchStatus 在单维路径未注入 →
//           独立报表「匹配渠道 / 匹配状态」列 = ''（不抛错）
//
// 用法：node scripts/integration/bank-statement-hit-scenario-report.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

const { runAllScenarios } = require('../../src/main-process/scenario-dispatcher');
const { writeBankStatementOutput } = require('../../src/main-process/exceljs-writer');
const { writeScenarioHitRows, REPORT_SHEET_NAME, SUFFIX_HEADERS } = require('../../src/main-process/scenario-hit-rows-writer');

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
  console.log('==== v2.1.9 N5 独立报表 + Sheet 3 撤除 集成验证 ====');

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-hit-rows-report-'));
  const savePath = path.join(tmpdir, 'bank-result.xlsx');

  try {
    // ============================================================
    // Step 1：构造 2 个 C1 场景，priority 不同 → displayIndex 1 / 2
    // ============================================================
    const scenarios = [
      {
        id: 101,
        name: '提取业务订单号',
        category: 'extract-recon-id',
        priority: 200,
        displayIndex: 1,
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
        priority: 100,
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
    //   行 1 / 3 → 命中场景 101（TYPE_A）
    //   行 2 → 命中场景 102（TYPE_B）
    //   行 4 / 5 → 未命中
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
    // Step 3：跑 dispatcher（v2.1.8 单维路径 — 不传 deps）
    // ============================================================
    const dispatchResult = runAllScenarios(bankRows, null, scenarios);

    assertEq(dispatchResult.stats.hitScenarios.length, 2, 'Step3.hitScenarios.length=2');
    assertEq(dispatchResult.stats.hitScenarios[0].id, 101, 'Step3.hitScenarios[0].id=101');
    assertEq(dispatchResult.stats.hitScenarios[0].displayIndex, 1, 'Step3.hitScenarios[0].displayIndex=1');
    assertEq(dispatchResult.modifiedRows.length, 3, 'Step3.modifiedRows.length=3');
    assertEq(dispatchResult.unmatchedRows.length, 2, 'Step3.unmatchedRows.length=2');
    assertEq(dispatchResult.modifiedRows.length + dispatchResult.unmatchedRows.length, bankRows.length, 'Step3.完整性 mod+unmatched=total');
    dispatchResult.modifiedRows.forEach((r) => {
      assertTrue(Number.isFinite(r._hitScenarioDisplayIndex), `Step3.${r._rowId} _hitScenarioDisplayIndex 已注入`);
      assertTrue(typeof r._hitScenarioName === 'string' && r._hitScenarioName, `Step3.${r._rowId} _hitScenarioName 已注入`);
    });

    // ============================================================
    // Step 4：调主输出 writer（v2.1.9 — 仅 Sheet 1 + Sheet 2，不再有 Sheet 3）
    // ============================================================
    await writeBankStatementOutput(
      dispatchResult.modifiedRows,
      headers,
      savePath,
      dispatchResult.unmatchedRows
      // v2.1.9 N5 T25：includeHitScenarioSheet 参数已移除（破坏性变更）
    );
    assertTrue(fs.existsSync(savePath), 'Step4.主输出 xlsx 写入成功');

    // ============================================================
    // Step 5：readback 主输出 — 验证仅 2 sheet（Sheet 3 已撤除）
    // ============================================================
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(savePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    console.log('  主输出 sheets:', sheetNames);
    assertEq(wb.worksheets.length, 2, 'Step5.主输出仅 2 sheet（T25 Sheet 3 已撤除）');
    assertTrue(sheetNames.includes('渠道对账单'), 'Step5.Sheet 1「渠道对账单」存在');
    assertTrue(sheetNames.includes('未命中场景行'), 'Step5.Sheet 2「未命中场景行」存在');
    assertTrue(!sheetNames.includes('命中场景行'), 'Step5.Sheet 3「命中场景行」已撤除');

    // ============================================================
    // Step 6：调独立报表 writer（v2.1.9 N5 T24）
    //   场景：单维路径下 _hitChannelKey / _matchStatus 未注入 → 列为空但 writer 不抛错
    // ============================================================
    const reportResult = await writeScenarioHitRows(
      dispatchResult.modifiedRows,
      '/tmp/工商-上海-2026-04.xlsx',
      {
        exportRoot: tmpdir,
        timestamp: '20260427T143022',
        headers
      }
    );
    assertEq(reportResult.status, 'ok', 'Step6.writer 返回 status=ok');
    assertEq(reportResult.rowCount, 3, 'Step6.writer rowCount=3');
    assertEq(reportResult.fileName, '命中场景行-工商-上海-2026-04-20260427T143022.xlsx', 'Step6.文件名 spec §5.1 D15=a 规范');
    assertTrue(fs.existsSync(reportResult.filePath), 'Step6.独立报表 xlsx 写入成功');

    // ============================================================
    // Step 7：readback 独立报表 — 验证列结构（spec §5.2 D17=b 列序）
    // ============================================================
    const reportWb = new ExcelJS.Workbook();
    await reportWb.xlsx.readFile(reportResult.filePath);
    const reportSheets = reportWb.worksheets.map((s) => s.name);
    assertEq(reportSheets, [REPORT_SHEET_NAME], 'Step7.独立报表 sheet 名 = 「命中场景行」');

    const reportSheet = reportWb.getWorksheet(REPORT_SHEET_NAME);
    // 列数 = headers + 3
    assertEq(reportSheet.columnCount, headers.length + 3, `Step7.列数 = ${headers.length} + 3`);
    // 表头最后 3 列序
    const lastBaseIdx = headers.length;  // 末尾 3 列起始（1-based 加 1 = lastBaseIdx + 1）
    assertEq(reportSheet.getRow(1).getCell(lastBaseIdx + 1).value, '匹配渠道', 'Step7.列 N+1 = 匹配渠道');
    assertEq(reportSheet.getRow(1).getCell(lastBaseIdx + 2).value, '匹配状态', 'Step7.列 N+2 = 匹配状态');
    assertEq(reportSheet.getRow(1).getCell(lastBaseIdx + 3).value, '命中场景', 'Step7.列 N+3 = 命中场景');
    // 第 1 列仍是 Date（headers 第 1 列）
    assertEq(reportSheet.getRow(1).getCell(1).value, 'Date', 'Step7.列 1 = Date');

    // ============================================================
    // Step 8：「命中场景」列值格式 `[displayIndex] name`（spec §5.2 D16=a）
    // ============================================================
    // R1 (模 = modifiedRows[0]) 命中场景 101 displayIndex=1
    const r1Hit = reportSheet.getRow(2).getCell(lastBaseIdx + 3).value;
    assertEq(r1Hit, '[1] 提取业务订单号', 'Step8.R1 命中场景列 = [1] 提取业务订单号');

    // 收集所有 3 行的「命中场景」列
    const allHitLabels = [];
    for (let i = 2; i <= 4; i++) {
      allHitLabels.push(reportSheet.getRow(i).getCell(lastBaseIdx + 3).value);
    }
    assertEq(allHitLabels.filter((l) => l === '[1] 提取业务订单号').length, 2, 'Step8.[1] 提取业务订单号 出现 2 次');
    assertEq(allHitLabels.filter((l) => l === '[2] 提取客户 ReconId').length, 1, 'Step8.[2] 提取客户 ReconId 出现 1 次');

    // ============================================================
    // Step 9：单维路径下「匹配渠道 / 匹配状态」列空字符串（dispatcher 单维未注入）
    //   双维路径下这两列会有值（详 unit test scenario-dispatcher.test.js）
    // ============================================================
    for (let i = 2; i <= 4; i++) {
      const channelKey = reportSheet.getRow(i).getCell(lastBaseIdx + 1).value;
      const matchStatus = reportSheet.getRow(i).getCell(lastBaseIdx + 2).value;
      assertTrue(channelKey === '' || channelKey === null, `Step9.行 ${i} 匹配渠道列为空（单维路径）`);
      assertTrue(matchStatus === '' || matchStatus === null, `Step9.行 ${i} 匹配状态列为空（单维路径）`);
    }

    // ============================================================
    // Step 10：内部 _ 前缀字段不应泄漏到独立报表
    // ============================================================
    const reportHeaderVals = reportSheet.getRow(1).values.slice(1);  // ExcelJS values 第 0 索引是 undefined
    const reportLeaks = reportHeaderVals.filter((h) => typeof h === 'string' && h.startsWith('_'));
    assertEq(reportLeaks.length, 0, 'Step10.独立报表无 _ 前缀内部字段泄漏');

    // ============================================================
    // Step 11：tmp 文件原子写无残留
    // ============================================================
    assertTrue(!fs.existsSync(`${reportResult.filePath}.tmp`), 'Step11.atomic write — .tmp 文件已清理');

    // ============================================================
    // Step 12：空 modifiedRows graceful（独立报表仍输出含表头空 sheet）
    // ============================================================
    const emptyResult = await writeScenarioHitRows([], '/tmp/empty.xlsx', {
      exportRoot: tmpdir,
      timestamp: '20260427T143033',
      headers
    });
    assertEq(emptyResult.status, 'ok', 'Step12.空 modifiedRows 仍 status=ok');
    assertEq(emptyResult.rowCount, 0, 'Step12.空 modifiedRows rowCount=0');
    assertTrue(fs.existsSync(emptyResult.filePath), 'Step12.空 modifiedRows 仍生成文件');

    const emptyWb = new ExcelJS.Workbook();
    await emptyWb.xlsx.readFile(emptyResult.filePath);
    const emptySheet = emptyWb.getWorksheet(REPORT_SHEET_NAME);
    assertEq(emptySheet.rowCount, 1, 'Step12.空数据仅 1 行表头');
    assertEq(emptySheet.columnCount, headers.length + 3, 'Step12.列数仍正确');

    // ============================================================
    // Step 13：SUFFIX_HEADERS 常量保护（D17=b 列序固定不可变）
    // ============================================================
    assertEq(SUFFIX_HEADERS, ['匹配渠道', '匹配状态', '命中场景'], 'Step13.SUFFIX_HEADERS spec §5.2 D17=b 序');

    // ============================================================
    // Step 14：v2.1.9 D16=b 集成 — 显式传 opts.channels + row 带 _hitChannelId
    //   验证 writer 用 _hitChannelId 反查 channels.label 写「匹配渠道」列
    //   单维路径 dispatcher 不注 _hitChannelId（仅双维注），这里手工构造行模拟双维 dispatcher 输出
    // ============================================================
    const d16Rows = [
      {
        _rowId: 'D1', Date: '2026-04-10', Amount: 999, BillType: 'TYPE_A', BizOrderId: 'BIZ-D1',
        CustomerRef: '', ReconciliationId: '', Description: 'd16-test',
        _hitChannelKey: 'BOSH-CN',  // 原始 Channel-地区
        _matchStatus: '兜底',
        _hitChannelId: 1,  // D16=b：实际命中通用
        _hitScenarioId: 999,
        _hitScenarioDisplayIndex: 5,
        _hitScenarioName: '通用场景'
      },
      {
        _rowId: 'D2', Date: '2026-04-11', Amount: 888, BillType: 'TYPE_B', BizOrderId: '',
        CustomerRef: 'CUST-D2', ReconciliationId: '', Description: 'd16-test',
        _hitChannelKey: '工商-上海',
        _matchStatus: '命中',
        _hitChannelId: 2,  // D16=b：实际命中专属
        _hitScenarioId: 998,
        _hitScenarioDisplayIndex: 6,
        _hitScenarioName: '工商专属'
      }
    ];
    const d16Channels = [
      { id: 1, label: '通用' },
      { id: 2, label: '工商-上海' }
    ];
    const d16Result = await writeScenarioHitRows(d16Rows, '/tmp/d16-test.xlsx', {
      exportRoot: tmpdir,
      timestamp: '20260427T143044',
      headers,
      channels: d16Channels
    });
    assertEq(d16Result.status, 'ok', 'Step14.D16=b writer status=ok');

    const d16Wb = new ExcelJS.Workbook();
    await d16Wb.xlsx.readFile(d16Result.filePath);
    const d16Sheet = d16Wb.getWorksheet(REPORT_SHEET_NAME);
    const d16LastBase = headers.length;
    // 行 D1（兜底命中通用）：匹配渠道 = '通用'（不是原始 'BOSH-CN'）
    assertEq(
      d16Sheet.getRow(2).getCell(d16LastBase + 1).value,
      '通用',
      'Step14.D1 匹配渠道=通用（D16=b 兜底命中通用 label）'
    );
    // 行 D2（专属命中）：匹配渠道 = '工商-上海'
    assertEq(
      d16Sheet.getRow(3).getCell(d16LastBase + 1).value,
      '工商-上海',
      'Step14.D2 匹配渠道=工商-上海（D16=b 专属命中 label）'
    );
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
