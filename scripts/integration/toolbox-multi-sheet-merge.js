// v3.0.19 工具箱多 Sheet 合并端到端验证。
// 覆盖真实 XLSX/XLS/CSV 输入、可见性、严格表头、分页和多 sheet 流式大文件路径。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { ToolboxHeaderMismatchError } = require('../../src/main-process/toolbox');
const { mergeToolboxFilesToXlsx } = require('../../src/main-process/toolbox-merge-io');

let passed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failures.push({ label, actual, expected });
}

function assertTrue(value, label) {
  if (value) {
    passed += 1;
    return;
  }
  failures.push({ label, actual: value, expected: true });
}

async function writeXlsx(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, { state: spec.state || 'visible' });
    for (const row of spec.rows || []) sheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
}

function writeXls(filePath, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const spec of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(spec.rows || []), spec.name);
  }
  workbook.Workbook = {
    Sheets: sheets.map((spec) => ({
      name: spec.name,
      Hidden: spec.state === 'veryHidden' ? 2 : spec.state === 'hidden' ? 1 : 0
    }))
  };
  XLSX.writeFile(workbook, filePath, { bookType: 'biff8' });
}

async function writeLargeMultiSheetXlsx(filePath, sheetCount, rowsPerSheet) {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: false,
    useSharedStrings: false
  });
  for (let s = 0; s < sheetCount; s += 1) {
    const sheet = writer.addWorksheet(`S${s + 1}`);
    sheet.addRow(['序号', '来源']).commit();
    for (let r = 0; r < rowsPerSheet; r += 1) {
      sheet.addRow([String(s * rowsPerSheet + r), `sheet-${s + 1}`]).commit();
    }
    await sheet.commit();
  }
  await writer.commit();
}

function readWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  return {
    names: workbook.SheetNames.slice(),
    rows: workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: ''
    }))
  };
}

async function run() {
  console.log('==== 工具箱多 Sheet 合并端到端验证 ====');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-multi-sheet-merge-'));
  try {
    const xlsx = path.join(tempDir, 'a.xlsx');
    await writeXlsx(xlsx, [
      { name: '一月', rows: [[], ['订单号', '金额'], ['A1', '10']] },
      { name: '隐藏辅助', state: 'hidden', rows: [['订单号', '金额'], ['SECRET', '99']] },
      { name: '空白', rows: [] },
      { name: '只有表头', rows: [['订单号', '金额']] },
      { name: '二月', rows: [['订单号', '金额'], ['A2', '20']] }
    ]);
    const xls = path.join(tempDir, 'b.xls');
    writeXls(xls, [
      { name: '三月', rows: [['订单号', '金额'], ['B1', '30']] },
      { name: '深藏辅助', state: 'veryHidden', rows: [['订单号', '金额'], ['SECRET2', '98']] }
    ]);
    const csv = path.join(tempDir, 'c.csv');
    fs.writeFileSync(csv, '订单号,金额\nC1,40\n', 'utf8');

    const mixedOutput = path.join(tempDir, 'mixed-output.xlsx');
    const mixedResult = await mergeToolboxFilesToXlsx({
      filePaths: [xlsx, xls, csv],
      savePath: mixedOutput
    });
    const mixedReadback = readWorkbook(mixedOutput);
    assertEq(mixedResult.fileCount, 3, '混合输入文件数=3');
    assertEq(mixedResult.inputSheetCount, 5, '参与 sheet=5（XLSX 3 + XLS 1 + CSV 1）');
    assertEq(mixedResult.skippedHiddenSheetCount, 2, 'hidden/veryHidden 共跳过2');
    assertEq(mixedResult.skippedEmptySheetCount, 1, '空 sheet 跳过1');
    assertEq(mixedReadback.names, ['COMMON'], '普通结果只有 COMMON');
    assertEq(mixedReadback.rows[0], [
      ['订单号', '金额'],
      ['A1', '10'],
      ['A2', '20'],
      ['B1', '30'],
      ['C1', '40']
    ], '文件→sheet→行顺序正确且隐藏数据未进入');

    const mismatch = path.join(tempDir, 'mismatch.xlsx');
    await writeXlsx(mismatch, [
      { name: '正确', rows: [['订单号', '金额'], ['D1', '1']] },
      { name: '错误', rows: [['订单号', '币种'], ['D2', 'CNY']] }
    ]);
    const mismatchOutput = path.join(tempDir, 'mismatch-output.xlsx');
    let mismatchError = null;
    try {
      await mergeToolboxFilesToXlsx({ filePaths: [mismatch], savePath: mismatchOutput });
    } catch (error) {
      mismatchError = error;
    }
    assertTrue(mismatchError instanceof ToolboxHeaderMismatchError, '表头不一致抛专用错误');
    assertTrue(mismatchError && /错误/.test(mismatchError.message), '错误文案含异常 sheet');
    assertTrue(!fs.existsSync(mismatchOutput), '表头失败不留输出');

    const pageSource = path.join(tempDir, 'pages.xlsx');
    await writeXlsx(pageSource, [
      { name: 'P1', rows: [['H'], ['1'], ['2'], ['3']] },
      { name: 'P2', rows: [['H'], ['4'], ['5']] }
    ]);
    const pageOutput = path.join(tempDir, 'pages-output.xlsx');
    const pageResult = await mergeToolboxFilesToXlsx({
      filePaths: [pageSource],
      savePath: pageOutput,
      maxRowsPerSheet: 2
    });
    const pageReadback = readWorkbook(pageOutput);
    assertEq(pageResult.sheetCount, 3, '5行按每页2行分3个sheet');
    assertEq(pageReadback.names, ['COMMON', 'COMMON(2)', 'COMMON(3)'], '分页命名连续');
    assertEq(pageReadback.rows.flatMap((rows) => rows.slice(1).flat()), ['1', '2', '3', '4', '5'], '分页后行序守恒');

    const largeSource = path.join(tempDir, 'large-multi-sheet.xlsx');
    const rowsPerSheet = Number(process.env.TOOLBOX_MULTI_SHEET_MERGE_ROWS_PER_SHEET || 100000);
    await writeLargeMultiSheetXlsx(largeSource, 3, rowsPerSheet);
    const largeOutput = path.join(tempDir, 'large-output.xlsx');
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    let largeResult;
    try {
      largeResult = await mergeToolboxFilesToXlsx({ filePaths: [largeSource], savePath: largeOutput });
    } finally {
      clearInterval(sampler);
    }
    const rssDeltaMb = Math.round((peakRss - baselineRss) / 1024 / 1024);
    assertEq(largeResult.inputSheetCount, 3, '大文件读取3个物理sheet');
    assertEq(largeResult.dataRowCount, rowsPerSheet * 3, '大文件行数守恒');
    assertTrue(rssDeltaMb < 384, `大文件流式合并 RSS 增量受控（实际 ${rssDeltaMb}MB）`);
    assertTrue(fs.statSync(largeOutput).size > 0, '大文件输出有效');

    const total = passed + failures.length;
    console.log(`\n==== ${passed}/${total} PASS ====`);
    if (failures.length > 0) {
      console.error('FAILURES:');
      for (const failure of failures) {
        console.error(`- ${failure.label}`);
        console.error(`  actual: ${JSON.stringify(failure.actual)}`);
        console.error(`  expected: ${JSON.stringify(failure.expected)}`);
      }
      process.exit(1);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
