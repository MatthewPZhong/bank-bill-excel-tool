'use strict';

// 工具箱🧰「合表 / 拆表」大文件生产链路端到端验证（v3.1.2）。
//
// 目标：
//   1. 直接调用主进程生产共用入口，不再复刻旧 toolbox-stream-io 拼装链路；
//   2. 在 30 万行/源文件规模下验证合并与拆分的行数守恒、筛选内容和格式保真；
//   3. 验证长纯数字编号仍为文本，不会被科学计数法改写；
//   4. 峰值 RSS < 800MB。
//
// 注意：scripts/integration-runner.js 会无条件自动发现并执行本文件。
//
// 用法：node scripts/integration/toolbox-large-file-stream.js
// 可调行数：TOOLBOX_LARGE_ROWS=300000 node scripts/integration/toolbox-large-file-stream.js
// 缺省规模必须保持 30 万行。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const ExcelJS = require('exceljs');

const {
  findToolboxCell,
  openToolboxXlsxPass
} = require('../../src/backend/toolbox-format');
const {
  locateSheets,
  openZipWithEntries
} = require('../../src/backend/big-table-import/zip-reader');
const {
  exportToolboxFilter,
  scanToolboxSplitFields
} = require('../../src/main-process/toolbox-format-operations');
const {
  mergeToolboxFilesToXlsx
} = require('../../src/main-process/toolbox-merge-io');

const ROWS = Number(process.env.TOOLBOX_LARGE_ROWS || 300000);
const HEADERS = [
  'MerchantId',
  'Channel',
  'Currency',
  'BillDate',
  'Credit Amount',
  'Debit Amount',
  'Balance',
  'OrderNo'
];
const CHANNELS = ['ALIPAY', 'WECHAT', 'UNION'];
const SOURCE_DATE = new Date(Date.UTC(2026, 0, 2));

if (!Number.isSafeInteger(ROWS) || ROWS <= 0) {
  throw new Error(`TOOLBOX_LARGE_ROWS 必须为正整数，收到：${process.env.TOOLBOX_LARGE_ROWS}`);
}

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(condition, label) {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label });
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, actual, expected });
}

function longOrderNo(index) {
  return String(index + 1).padStart(21, '0');
}

// 用 ExcelJS streaming writer 生成带少量稳定样式的大 xlsx。
// 样式种类保持常数，避免由测试数据本身制造样式爆炸。
async function genLargeXlsx(
  filePath,
  rowCount,
  { channelCycle = CHANNELS, trackMemory = () => {} } = {}
) {
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: false
  });
  const sheet = writer.addWorksheet('COMMON');
  const columnSpecs = [
    { width: 16, numFmt: '@' },
    { width: 14, numFmt: '@' },
    { width: 12, numFmt: '@' },
    { width: 15, numFmt: 'yyyy-mm-dd' },
    { width: 18, numFmt: '#,##0.00' },
    { width: 18, numFmt: '#,##0.00' },
    { width: 18, numFmt: '#,##0.00' },
    { width: 25, numFmt: '@' }
  ];
  for (let index = 0; index < columnSpecs.length; index += 1) {
    const column = sheet.getColumn(index + 1);
    column.width = columnSpecs[index].width;
    column.numFmt = columnSpecs[index].numFmt;
  }

  const header = sheet.addRow(HEADERS.slice());
  header.height = 24;
  header.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = {
      name: 'Courier New',
      size: 11,
      bold: true,
      color: { argb: 'FF1F4E78' }
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAF7' }
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  header.commit();

  const counts = {};
  for (let index = 0; index < rowCount; index += 1) {
    const channel = channelCycle[index % channelCycle.length];
    counts[channel] = (counts[channel] || 0) + 1;
    const row = sheet.addRow([
      `M${index % 5000}`,
      channel,
      index % 2 === 0 ? 'USD' : 'CNY',
      SOURCE_DATE,
      index % 3 === 0 ? 100.5 : null,
      index % 3 === 0 ? null : 12.34,
      1000 + index,
      longOrderNo(index)
    ]);
    if (index === 0) row.height = 19;
    row.commit();
    if (index % 5000 === 0) trackMemory();
  }
  sheet.commit();
  await writer.commit();
  trackMemory();
  return { counts };
}

function countRowsStreamed(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }
      const decoder = new StringDecoder('utf8');
      const matcher = /<row\b/g;
      let pending = '';
      let count = 0;

      const countMatches = (text) => {
        matcher.lastIndex = 0;
        while (matcher.exec(text)) count += 1;
      };

      stream.on('data', (chunk) => {
        const text = pending + decoder.write(chunk);
        countMatches(text);
        // "<row" 长 4 字符；保留末尾 3 字符即可覆盖跨 chunk 的未完成标签，
        // 且不会把已经完整计数的标签带到下一轮重复计算。
        pending = text.slice(-3);
      });
      stream.on('end', () => {
        countMatches(pending + decoder.end());
        resolve(count);
      });
      stream.on('error', reject);
    });
  });
}

// 直接用 yauzl 对输出 worksheet XML 增量计数，不把整张 sheet XML 物化到内存。
async function readbackStreamed(filePath) {
  const { zip, entries } = await openZipWithEntries(path.basename(filePath), filePath);
  try {
    const declaredSheets = await locateSheets(zip, entries);
    let sheetEntries = declaredSheets
      .map((sheet) => sheet.entryPath && entries.get(sheet.entryPath))
      .filter(Boolean);
    if (sheetEntries.length === 0) {
      sheetEntries = [...entries.entries()]
        .filter(([entryName]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entryName))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, entry]) => entry);
    }

    let totalDataRows = 0;
    const sheetDataCounts = [];
    for (const entry of sheetEntries) {
      const rowCount = await countRowsStreamed(zip, entry);
      const dataRows = Math.max(rowCount - 1, 0);
      sheetDataCounts.push(dataRows);
      totalDataRows += dataRows;
    }
    return { totalDataRows, sheetDataCounts };
  } finally {
    try { zip.close(); } catch (_error) { /* ignore */ }
  }
}

function resolveCellStyle(pass, cell) {
  if (!cell || !cell.effectiveStyleRef) return null;
  return pass.sourceRegistry.get(cell.effectiveStyleRef.styleRef);
}

function columnMetadataAt(sheetMeta, columnIndex) {
  const columns = sheetMeta && Array.isArray(sheetMeta.columns) ? sheetMeta.columns : [];
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const column = columns[index];
    if (columnIndex >= column.minColumnIndex && columnIndex <= column.maxColumnIndex) {
      return column;
    }
  }
  return null;
}

// 通过 3.1.2 同一格式模型重新打开输出，只读到首条数据行即取消。
// 行数守恒另由 readbackStreamed 的原始 XML 计数独立验证。
async function inspectFirstOutputDataRow(filePath) {
  const pass = await openToolboxXlsxPass(filePath);
  const cancelToken = { cancelled: false };
  let sheetMeta = null;
  let headerRow = null;
  let dataRow = null;
  try {
    try {
      await pass.scanSheet(0, {
        cancelToken,
        onSheetMeta: (meta) => { sheetMeta = meta; },
        onRow: (row) => {
          if (row.rowIndex === 1) headerRow = row;
          if (row.rowIndex === 2) {
            dataRow = row;
            cancelToken.cancelled = true;
          }
        }
      });
    } catch (error) {
      if (!error || error.code !== 'TOOLBOX_XLSX_CANCELLED') throw error;
    }

    const headerCell = findToolboxCell(headerRow, 0);
    const merchantCell = findToolboxCell(dataRow, 0);
    const channelCell = findToolboxCell(dataRow, 1);
    const billDateCell = findToolboxCell(dataRow, 3);
    const creditCell = findToolboxCell(dataRow, 4);
    const balanceCell = findToolboxCell(dataRow, 6);
    const orderCell = findToolboxCell(dataRow, 7);
    const headerStyle = resolveCellStyle(pass, headerCell);
    const merchantStyle = resolveCellStyle(pass, merchantCell);
    const billDateStyle = resolveCellStyle(pass, billDateCell);
    const balanceStyle = resolveCellStyle(pass, balanceCell);
    const orderStyle = resolveCellStyle(pass, orderCell);

    return {
      headerText: headerCell && headerCell.decodedSemanticValue,
      merchant: merchantCell && merchantCell.decodedSemanticValue,
      channel: channelCell && channelCell.decodedSemanticValue,
      billDateSerial: billDateCell && Number(billDateCell.rawLexicalValue),
      credit: creditCell && Number(creditCell.rawLexicalValue),
      balance: balanceCell && Number(balanceCell.rawLexicalValue),
      orderNo: orderCell && orderCell.decodedSemanticValue,
      headerFontName: headerStyle && headerStyle.font && headerStyle.font.name,
      headerBold: !!(headerStyle && headerStyle.font && headerStyle.font.bold),
      headerFontColor: headerStyle && headerStyle.font &&
        headerStyle.font.color && headerStyle.font.color.argb,
      headerFillColor: headerStyle && headerStyle.fill &&
        headerStyle.fill.fgColor && headerStyle.fill.fgColor.argb,
      merchantNumFmt: merchantStyle && merchantStyle.numFmt,
      billDateNumFmt: billDateStyle && billDateStyle.numFmt,
      balanceNumFmt: balanceStyle && balanceStyle.numFmt,
      orderNumFmt: orderStyle && orderStyle.numFmt,
      merchantColumnWidth: columnMetadataAt(sheetMeta, 0) &&
        columnMetadataAt(sheetMeta, 0).width,
      orderColumnWidth: columnMetadataAt(sheetMeta, 7) &&
        columnMetadataAt(sheetMeta, 7).width,
      headerRowHeight: headerRow && headerRow.height,
      firstDataRowHeight: dataRow && dataRow.height
    };
  } finally {
    pass.close();
  }
}

function assertFirstRowContentAndFormat(sample, label) {
  assertEq(sample.headerText, HEADERS[0], `${label}：表头内容保持`);
  assertEq(sample.merchant, 'M0', `${label}：首行 MerchantId 内容保持`);
  assertEq(sample.channel, 'ALIPAY', `${label}：首行 Channel 内容保持`);
  assertEq(sample.credit, 100.5, `${label}：首行 Credit 数值保持`);
  assertEq(sample.balance, 1000, `${label}：首行 Balance 数值保持`);
  assertEq(sample.orderNo, longOrderNo(0), `${label}：21 位纯数字 OrderNo 原样保持`);
  assertTrue(Number.isFinite(sample.billDateSerial), `${label}：BillDate 保持 Excel 日期序列`);
  assertEq(sample.headerFontName, 'Courier New', `${label}：表头字体保持 Courier New`);
  assertEq(sample.headerBold, true, `${label}：表头粗体保持`);
  assertEq(sample.headerFontColor, 'FF1F4E78', `${label}：表头字体颜色保持`);
  assertEq(sample.headerFillColor, 'FFD9EAF7', `${label}：表头填充色保持`);
  assertEq(sample.merchantNumFmt, '@', `${label}：MerchantId 文本格式保持`);
  assertEq(sample.billDateNumFmt, 'yyyy-mm-dd', `${label}：BillDate 日期格式保持`);
  assertEq(sample.balanceNumFmt, '#,##0.00', `${label}：Balance 数字格式保持`);
  assertEq(sample.orderNumFmt, '@', `${label}：OrderNo 文本格式保持且不科学计数`);
  assertEq(sample.merchantColumnWidth, 16, `${label}：MerchantId 列宽保持`);
  assertEq(sample.orderColumnWidth, 25, `${label}：OrderNo 列宽保持`);
  assertEq(sample.headerRowHeight, 24, `${label}：表头行高保持`);
  assertEq(sample.firstDataRowHeight, 19, `${label}：首条数据行高保持`);
}

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

async function run() {
  console.log(`==== 工具箱🧰 3.1.2 大文件生产链路验证（${ROWS.toLocaleString()} 行/文件）====`);
  console.log('集成 runner：scripts/integration-runner.js 会无条件执行本脚本（默认规模未下调）');
  const startedAt = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-'));
  let peakRss = rssMB();
  const phaseTimings = [];
  const track = () => {
    peakRss = Math.max(peakRss, rssMB());
  };
  const memoryTimer = setInterval(track, 50);
  memoryTimer.unref();

  const phase = async (label, task) => {
    const phaseStartedAt = Date.now();
    const result = await task();
    track();
    const elapsedMs = Date.now() - phaseStartedAt;
    phaseTimings.push({ label, elapsedMs });
    console.log(`  ${label}：${formatSeconds(elapsedMs)}，当前 RSS=${rssMB()}MB`);
    return result;
  };

  try {
    const fileA = path.join(tmpDir, 'large-a.xlsx');
    const fileB = path.join(tmpDir, 'large-b.xlsx');
    console.log(`生成源文件 A/B（各 ${ROWS.toLocaleString()} 行，带日期/文本/金额/表头样式）...`);
    const genA = await phase('生成源文件 A', () => (
      genLargeXlsx(fileA, ROWS, { trackMemory: track })
    ));
    const genB = await phase('生成源文件 B', () => (
      genLargeXlsx(fileB, ROWS, { trackMemory: track })
    ));
    console.log(
      `  源文件大小：A=${(fs.statSync(fileA).size / 1024 / 1024).toFixed(1)}MB ` +
      `B=${(fs.statSync(fileB).size / 1024 / 1024).toFixed(1)}MB`
    );

    console.log('① 合表：mergeToolboxFilesToXlsx(A+B) ...');
    const mergeOut = path.join(tmpDir, 'merged.xlsx');
    const mergeResult = await phase('生产合表入口', () => mergeToolboxFilesToXlsx({
      filePaths: [fileA, fileB],
      savePath: mergeOut
    }));
    assertEq(JSON.stringify(mergeResult.baseHeaders), JSON.stringify(HEADERS), '①合表基准表头 = 原表头');
    assertEq(mergeResult.dataRowCount, ROWS * 2, '①合表返回数据行数 = A+B');
    assertEq(
      JSON.stringify(mergeResult.fileSummaries.map((item) => item.dataRowCount)),
      JSON.stringify([ROWS, ROWS]),
      '①两个输入文件的数据行统计分别守恒'
    );
    assertEq(genA.counts.ALIPAY, genB.counts.ALIPAY, '①A/B 渠道分布一致');

    const mergeReadback = await phase('合表 XML 流式 readback', () => readbackStreamed(mergeOut));
    assertEq(mergeReadback.totalDataRows, ROWS * 2, '①合表产物 readback 数据行数 = 2×ROWS');
    const mergeSample = await phase('合表首行内容/格式检查', () => (
      inspectFirstOutputDataRow(mergeOut)
    ));
    assertFirstRowContentAndFormat(mergeSample, '①合表产物');
    console.log(
      `  合表输出：${mergeReadback.totalDataRows.toLocaleString()} 数据行，` +
      `${mergeReadback.sheetDataCounts.length} sheet，` +
      `${(fs.statSync(mergeOut).size / 1024 / 1024).toFixed(1)}MB`
    );

    console.log('② 拆表第一步：scanToolboxSplitFields(A) ...');
    const scanResult = await phase('生产拆表字段扫描入口', () => (
      scanToolboxSplitFields(fileA)
    ));
    assertEq(JSON.stringify(scanResult.headers), JSON.stringify(HEADERS), '②拆表扫描表头 = 原表头');
    assertEq(
      scanResult.valuesByField.Channel.slice().sort().join(','),
      'ALIPAY,UNION,WECHAT',
      '②Channel 去重值 = 3 个渠道'
    );
    assertEq(
      scanResult.valuesByField.Currency.slice().sort().join(','),
      'CNY,USD',
      '②Currency 去重值 = USD/CNY'
    );

    console.log('③ 拆表第二步：exportToolboxFilter(Channel=ALIPAY) ...');
    const splitOut = path.join(tmpDir, 'split-alipay.xlsx');
    const splitResult = await phase('生产单文件拆表入口', () => exportToolboxFilter({
      filePath: fileA,
      field: 'Channel',
      values: ['ALIPAY'],
      savePath: splitOut
    }));
    assertEq(splitResult.matchedCount, genA.counts.ALIPAY, '③拆表命中行数 = 源文件 ALIPAY 行数');
    assertEq(splitResult.warningSummary.warningCount, 0, '③安全日期没有产生文本回退提示');

    const splitReadback = await phase('拆表 XML 流式 readback', () => readbackStreamed(splitOut));
    assertEq(
      splitReadback.totalDataRows,
      genA.counts.ALIPAY,
      '③拆表产物 readback 行数 = ALIPAY 行数'
    );
    const splitSample = await phase('拆表首行内容/格式检查', () => (
      inspectFirstOutputDataRow(splitOut)
    ));
    assertFirstRowContentAndFormat(splitSample, '③拆表产物');
    console.log(
      `  拆表输出：${splitReadback.totalDataRows.toLocaleString()} 数据行，` +
      `${(fs.statSync(splitOut).size / 1024 / 1024).toFixed(1)}MB`
    );

    track();
    const totalElapsedMs = Date.now() - startedAt;
    console.log('\n阶段耗时：');
    for (const timing of phaseTimings) {
      console.log(`  - ${timing.label}: ${formatSeconds(timing.elapsedMs)}`);
    }
    console.log(`总耗时：${formatSeconds(totalElapsedMs)}`);
    console.log(`内存 RSS 峰值：${peakRss}MB`);
    assertTrue(
      peakRss < 800,
      `④内存峰值 ${peakRss}MB < 800MB（30 万行生产链路无 OOM）`
    );

    const total = passed + failed;
    console.log(`\n==== ${passed}/${total} PASS ====`);
    if (failed > 0) {
      console.error('\nFAILURES:');
      for (const failure of failures) {
        console.error(`  - ${failure.label}`);
        if (Object.prototype.hasOwnProperty.call(failure, 'actual')) {
          console.error(`      actual:   ${JSON.stringify(failure.actual)}`);
          console.error(`      expected: ${JSON.stringify(failure.expected)}`);
        }
      }
      process.exitCode = 1;
    }
  } finally {
    clearInterval(memoryTimer);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  }
}

run().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
