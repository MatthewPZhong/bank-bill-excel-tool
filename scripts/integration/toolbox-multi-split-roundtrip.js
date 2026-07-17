'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const { readRows } = require('../../src/backend/file-service');
const { normalizeCell, trimTrailingEmptyCells } = require('../../src/backend/file-service/common');
const {
  isStreamableXlsx,
  readHeaderRowStreamed,
  streamDataRows,
  writeRowsToMultipleFilesStreamed
} = require('../../src/main-process/toolbox-stream-io');
const {
  normalizeMultiSplitGroups,
  createMultipleRowFilters,
  publishPreparedSplitFiles
} = require('../../src/main-process/toolbox-multi-split');
const { dispatchLargeSplit } = require('../../src/main-process/toolbox-large-split-dispatch');

let passed = 0;
let failed = 0;
const failures = [];
function check(condition, label, actual = null, expected = true) {
  if (condition) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
}
function equal(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, actual, expected);
}

function writeSource(filePath, rows, bookType) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'COMMON');
  if (bookType === 'csv') {
    fs.writeFileSync(filePath, XLSX.utils.sheet_to_csv(workbook.Sheets.COMMON), 'utf8');
  } else {
    XLSX.writeFile(workbook, filePath, bookType ? { bookType } : undefined);
  }
}

async function runOrdinaryMultiSplit(sourceFilePath, outputDirectory) {
  const groups = normalizeMultiSplitGroups([
    { fileName: '渠道A', field: 'Channel', values: ['A'] },
    { fileName: '美元', field: 'Currency', values: ['USD'] },
    { fileName: '零命中', field: 'Channel', values: ['NONE'] }
  ]);
  const tempDir = fs.mkdtempSync(path.join(outputDirectory, '.toolbox-split-'));
  try {
    let normalizedHeaders;
    let writeDataRows;
    let scanCount = 0;
    if (await isStreamableXlsx(sourceFilePath)) {
      normalizedHeaders = await readHeaderRowStreamed(sourceFilePath);
      writeDataRows = async (emit) => {
        scanCount += 1;
        await streamDataRows(sourceFilePath, emit);
      };
    } else {
      scanCount += 1;
      const sourceRows = readRows(sourceFilePath);
      normalizedHeaders = trimTrailingEmptyCells(sourceRows[0]).map(normalizeCell);
      writeDataRows = async (emit) => {
        for (const row of sourceRows.slice(1)) emit(row);
      };
    }

    const plans = groups.map((group, index) => ({
      ...group,
      temporaryPath: path.join(tempDir, `${index + 1}.xlsx`),
      targetPath: path.join(outputDirectory, group.fileName)
    }));
    const filters = createMultipleRowFilters(normalizedHeaders, plans);
    const results = await writeRowsToMultipleFilesStreamed({
      normalizedHeaders,
      outputs: filters.map((filter, index) => ({
        savePath: plans[index].temporaryPath,
        matches: filter.matches
      })),
      writeDataRows
    });
    results.forEach((result, index) => { plans[index].matchedCount = result.dataRowCount; });
    return { scanCount, files: publishPreparedSplitFiles(plans) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function writeTwoSheetSource(filePath) {
  const workbook = new ExcelJS.Workbook();
  const headers = ['OrderId', 'Channel', 'Currency'];
  const first = workbook.addWorksheet('S1');
  first.addRow(headers);
  first.addRow(['o1', 'A', 'USD']);
  first.addRow(['o2', 'A', 'CNY']);
  const second = workbook.addWorksheet('S2');
  second.addRow(headers);
  second.addRow(['o3', 'B', 'USD']);
  await workbook.xlsx.writeFile(filePath);
}

async function run() {
  console.log('==== 工具箱多文件拆分跨格式回放 ====');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-multi-roundtrip-'));
  const sourceRows = [
    ['OrderId', 'Channel', 'Currency'],
    ['o1', 'A', 'USD'],
    ['o2', 'A', 'CNY'],
    ['o3', 'B', 'USD']
  ];

  try {
    for (const format of [
      { extension: 'xlsx', bookType: null },
      { extension: 'csv', bookType: 'csv' },
      { extension: 'xls', bookType: 'biff8' }
    ]) {
      const formatRoot = path.join(root, format.extension);
      fs.mkdirSync(formatRoot);
      const source = path.join(formatRoot, `source.${format.extension}`);
      writeSource(source, sourceRows, format.bookType);
      const result = await runOrdinaryMultiSplit(source, formatRoot);
      equal(result.scanCount, 1, `${format.extension}：数据区只遍历一次`);
      equal(result.files.map((file) => file.matchedCount), [2, 2, 0], `${format.extension}：命中数含交叉和零命中`);
      equal(readRows(result.files[0].filePath).slice(1).map((row) => String(row[0])), ['o1', 'o2'], `${format.extension}：渠道子集顺序`);
      equal(readRows(result.files[1].filePath).slice(1).map((row) => String(row[0])), ['o1', 'o3'], `${format.extension}：币种子集顺序`);
      equal(readRows(result.files[2].filePath).map((row) => row.map(String)), [sourceRows[0]], `${format.extension}：零命中仍有表头`);
    }

    const workerRoot = path.join(root, 'worker');
    fs.mkdirSync(workerRoot);
    const workerSource = path.join(workerRoot, 'multi-sheet.xlsx');
    await writeTwoSheetSource(workerSource);
    const workerTargets = ['worker-a.xlsx', 'worker-usd.xlsx', 'worker-empty.xlsx'].map((name) => path.join(workerRoot, name));
    const workerResult = await dispatchLargeSplit({
      op: 'exportMultiFilters',
      filePath: workerSource,
      groups: [
        { fileName: 'worker-a.xlsx', field: 'Channel', values: ['A'], savePath: workerTargets[0] },
        { fileName: 'worker-usd.xlsx', field: 'Currency', values: ['USD'], savePath: workerTargets[1] },
        { fileName: 'worker-empty.xlsx', field: 'Channel', values: ['NONE'], savePath: workerTargets[2] }
      ]
    }).promise;
    equal(workerResult.files.map((file) => file.matchedCount), [2, 2, 0], '多 sheet worker：三组命中数');
    check(workerTargets.every((filePath) => fs.existsSync(filePath)), '多 sheet worker：全部文件生成');

    const total = passed + failed;
    console.log(`==== ${passed}/${total} PASS ====`);
    if (failed > 0) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
