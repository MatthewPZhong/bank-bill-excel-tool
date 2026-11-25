'use strict';

// v3.2.21 原始账单预处理「跨 Sheet 回填」接入映射（buildMappedRows）的口径（spec：changes/v3.2.21/feat/cross-sheet-backfill/spec.md §3.1、§3.2）：
//   - 拆分配置实际读取的金额、币种、费用公式等源列不能作为回填目标；
//   - 每行按实际走的映射（主映射 / 拆分映射）判断是否补主映射币种、按哪一列做日期区间提示；
//   - 1904 日期系统工作簿的日期序号（来源与主表）按 1904 换算；
//   - 读成空值的 Excel 错误值不按空单元格回填；
//   - 跳过的行中带发生额的才计入分段边界用的交易行；按金额识别时币种代码取自币种映射表。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { buildMappedRows } = require('../../../../src/backend/file-service');
const readers = require('../../../../src/backend/file-service/readers');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sheet-backfill-mapping-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeWorkbook(filePath, { main, source, date1904 = false, merges = null }) {
  const workbook = XLSX.utils.book_new();
  const mainSheet = XLSX.utils.aoa_to_sheet(main);
  if (merges) mainSheet['!merges'] = merges.map((range) => XLSX.utils.decode_range(range));
  XLSX.utils.book_append_sheet(workbook, mainSheet, 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(source), 'SRC');
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } };
  XLSX.writeFile(workbook, filePath);
}

function rule(overrides = {}) {
  return {
    sourceSheetName: 'SRC',
    rowRules: [{ conditions: [{ field: 'Date', op: '空值', value: '' }] }],
    matchMode: 'amount',
    matchField: 'Desc',
    sourceMatchField: 'Credit',
    sourceDateOrder: 'auto',
    backfillFields: [{ targetField: 'Date', sourceField: 'Date' }],
    ...overrides
  };
}

function splitRow(seqNo, overrides = {}) {
  return {
    seqNo,
    currencySourceField: '',
    creditSourceField: '',
    debitSourceField: '',
    amountSourceField: '',
    rowStatus: 'completed',
    mergedGroupSeq: null,
    isFeeBill: false,
    ...overrides
  };
}

function billSplit(overrides = {}) {
  return {
    enabled: true,
    reuseModuleMapping: true,
    billSplitMappingByTargetField: {},
    billSplitRows: [],
    billSplitAmountRules: [],
    signedAmountSourceField: '',
    signedAmountTargetSeqNos: [],
    byFieldAmountTargetSeqNos: [],
    feeAmountFormula: null,
    rowFilterRules: null,
    ...overrides
  };
}

const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'];

test('拆分配置实际读取的收支、币种、按字段区分发生额、费用公式字段不能作为回填目标（生成时拒绝）', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Ccy', 'In', 'Out', 'Fee', 'Kind', 'Rate', 'Desc'];
  const filePath = path.join(dir, 'split.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-01', 'USD', 1, '', '', 'A', 1, 'x'], ['', 'USD', '', 2, '', 'A', 1, 'Trade - $2.00']],
    source: [['Date', 'Credit', 'Fee', 'Kind', 'Rate', 'Ccy2'], ['2026-09-02', 2, 5, 'B', 2, 'EUR']]
  });
  const base = {
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', Currency: 'Ccy', 'Credit Amount': 'In', 'Debit Amount': 'Out' },
    expectedSourceHeaders: headers
  };
  const cases = [
    ['Fee', { billSplitRows: [splitRow(1, { creditSourceField: 'In', currencySourceField: 'Ccy' }), splitRow(2, { debitSourceField: 'Fee' })] }],
    ['Kind', {
      billSplitRows: [splitRow(1, { creditSourceField: 'In' })],
      billSplitAmountRules: [{ targetField: 'Credit Amount', conditionField: 'Kind', conditionValue: 'A', mappedField: 'In' }]
    }],
    ['Rate', {
      billSplitRows: [splitRow(1, { creditSourceField: 'In' }), splitRow(2, { isFeeBill: true, debitSourceField: 'Out' })],
      feeAmountFormula: [{ field: 'Out' }, { op: '*' }, { field: 'Rate' }]
    }]
  ];
  cases.forEach(([field, splitConfig]) => {
    assert.throws(
      () => buildMappedRows({
        ...base,
        billSplitMerge: billSplit(splitConfig),
        crossSheetBackfillRule: rule({ backfillFields: [{ targetField: 'Date', sourceField: 'Date' }, { targetField: field, sourceField: field }] })
      }),
      new RegExp(`「${field}」用于发生额、余额、币种或账户映射，不能作为回填字段`),
      field
    );
  });
  // 主映射「按字段区分发生额」的条件字段同样不能回填
  assert.throws(
    () => buildMappedRows({
      ...base,
      amountSplitByField: { enabled: true, rules: [{ targetField: 'Credit Amount', conditionField: 'Kind', conditionValue: 'A', mappedField: 'In' }] },
      crossSheetBackfillRule: rule({ backfillFields: [{ targetField: 'Date', sourceField: 'Date' }, { targetField: 'Kind', sourceField: 'Kind' }] })
    }),
    /「Kind」用于发生额/
  );
});

test('走拆分映射的行：币种取自拆分行，不因主映射币种列不唯一而跳过；日期区间提示按拆分映射的 BillDate', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'SplitDate', 'Ccy', 'SplitCcy', 'In', 'Desc'];
  const filePath = path.join(dir, 'split-context.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-01', '2026-09-01', 'USD', 'GBP', 100, 'x'],
      ['2026-09-02', '', '', 'GBP', 50, 'Trade - $65.45'],
      ['2026-09-03', '2026-09-03', 'EUR', 'GBP', 10, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-12-01', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', Currency: 'Ccy', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    billSplitMerge: billSplit({
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: 'SplitDate' },
      billSplitRows: [splitRow(1, { creditSourceField: 'In', currencySourceField: 'SplitCcy' })]
    }),
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'SplitDate', op: '空值', value: '' }] }],
      backfillFields: [{ targetField: 'SplitDate', sourceField: 'Date' }]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 3)), [
    ['2026-09-01', 'GBP', '100'],
    ['2026-12-01', 'GBP', '50'],
    ['2026-09-03', 'GBP', '10']
  ]);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')).map((issue) => [issue.type, issue.rowNumber, issue.date]), [
    ['cross-sheet-backfill-date-out-of-range', 3, '2026-12-01']
  ]);
});

test('1904 日期系统工作簿：来源日期与主表日期序号都按 1904 换算', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'mac-1904.xlsx');
  const dateCell = (serial) => ({ t: 'n', v: serial, z: 'dd/mm/yyyy' });
  writeWorkbook(filePath, {
    date1904: true,
    // 1904 序号：44828 = 2026-09-25，44829 = 2026-09-26，44830 = 2026-09-27
    main: [headers, [dateCell(44828), 1, 'x'], ['', 2, 'Trade - $65.45'], [dateCell(44830), 3, 'x']],
    source: [['Date', 'Credit'], [dateCell(44829), 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26', '2026-09-27']);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
});

test('目标单元格是读成空值的 Excel 错误值：不按空单元格回填，跳过该行并说明原因', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'error-cell.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x'], [{ t: 'e', v: 0x07 }, 2, 'Trade - $65.45'], ['', 3, 'Trade - $1.00'], ['2026-09-27', 4, 'x']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45], ['2026-09-26', 1]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2]]), [['2026-09-25', '1'], ['2026-09-26', '3'], ['2026-09-27', '4']]);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')).map((issue) => [issue.rowNumber, issue.reason, issue.sourceFileName]), [
    [3, 'target-cell-unreadable', 'error-cell.xlsx']
  ]);
  assert.deepEqual(mapped.crossSheetBackfillPatches.map((patch) => patch.rowNumber), [4]);
});

test('跳过的行中带发生额的才计入分段边界用的交易行；按金额识别时币种代码取自币种映射表', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'skipped.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 1, 'x'],
      ['', 2, 'Trade - $9.00'],
      ['', '', 'Account 0123456789'],
      ['', 3, 'REF 12 - 65.45 XYZ'],
      ['2026-09-27', 4, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const options = {
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  };
  const withCodes = buildMappedRows({ ...options, currencyMappings: [{ englishCode: 'XYZ', aliases: [] }] });
  assert.deepEqual(withCodes.crossSheetBackfillStats.skippedTransactionRowNumbers, [3], '第 4 行没有发生额（账号说明行），不计入');
  assert.deepEqual(withCodes.crossSheetBackfillPatches.map((patch) => patch.rowNumber), [5]);
  const withoutCodes = buildMappedRows({ ...options, currencyMappings: [{ englishCode: 'USD', aliases: [] }] });
  assert.deepEqual(withoutCodes.crossSheetBackfillStats.skippedTransactionRowNumbers, [3, 5], 'XYZ 不在币种映射表中，两个数字有歧义');
});

// ---- v3.2.21 审查回归（第二轮）----

test('行内有数组公式时：整行级标记不按下标落到行尾的空列上，真正为空的目标单元格照常回填', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Calc', 'Channel'];
  const filePath = path.join(dir, 'array-formula.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 1, 'x', 1, 'A'],
      ['', 2, 'Trade - $65.45', { t: 'n', v: 4, f: 'B3*2', F: 'D3:D3' }, ''],
      ['2026-09-27', 3, 'x', 1, 'B']
    ],
    source: [['Date', 'Credit', 'Channel'], ['2026-09-26', 65.45, 'FX-01']]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({ backfillFields: [{ targetField: 'Date', sourceField: 'Date' }, { targetField: 'Channel', sourceField: 'Channel' }] })
  });
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2]]), [['2026-09-25', 'A'], ['2026-09-26', 'FX-01'], ['2026-09-27', 'B']]);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
});

test('费用账单行：费用公式生效时不读的 Debit 列、费用行不读的 Credit 列可以回填；只有费用公式字段有值的跳过行仍算交易行', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Old', 'Fee', 'Note', 'Desc'];
  const filePath = path.join(dir, 'fee.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 10, '', 1, '', 'x'],
      ['', '', '', 30, '', 'Trade - $9.00'],
      ['2026-09-27', 20, '', 2, '', 'x']
    ],
    source: [['Date', 'Credit', 'Note'], ['2026-09-26', 65.45, 'n']]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    billSplitMerge: billSplit({
      billSplitRows: [
        splitRow(1, { creditSourceField: 'In' }),
        splitRow(2, { isFeeBill: true, creditSourceField: 'Note', debitSourceField: 'Old' })
      ],
      feeAmountFormula: [{ field: 'Fee' }]
    }),
    crossSheetBackfillRule: rule({ backfillFields: [
      { targetField: 'Date', sourceField: 'Date' },
      { targetField: 'Old', sourceField: 'Note' },
      { targetField: 'Note', sourceField: 'Note' }
    ] })
  });
  assert.deepEqual(mapped.crossSheetBackfillStats.skippedTransactionRowNumbers, [3], '第 3 行只有费用公式字段 Fee 有值，按拆分路径算一笔交易');
});

test('目标单元格是合并单元格或数组公式中左上角以外的位置时，该行跳过并说明原因，不把常量写进去', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Calc', 'Channel'];
  const filePath = path.join(dir, 'blocked.xlsx');
  // 第 2、3 行日期合并（A2:A3，显示 9 月 24 日）；第 4 行 D4:E4 是数组公式（公式只在 D4）
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-24', 1, 'x', 1, 'A'],
      ['', 2, 'Trade - $65.45', 1, 'B'],
      ['2026-09-26', 3, 'Trade - $70.00', { t: 'n', v: 4, f: 'B4*2', F: 'D4:E4' }],
      ['2026-09-28', 4, 'x', 1, 'C']
    ],
    merges: ['A2:A3'],
    source: [['Date', 'Credit', 'Channel'], ['2026-09-27', 65.45, 'FX-01'], ['2026-09-26', 70, 'FX-02']]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Desc', op: '包含', value: 'Trade' }] }],
      backfillFields: [{ targetField: 'Date', sourceField: 'Date' }, { targetField: 'Channel', sourceField: 'Channel' }]
    })
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable'], [4, 'target-cell-unwritable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-24', '2026-09-28']);
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
});

test('跳过行是否带发生额按实际映射求值：按字段区分发生额的条件不成立时，金额列里的数字（如账号）不算发生额', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Type', 'Amt', 'Desc'];
  const filePath = path.join(dir, 'conditional.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', '交易', 10, 'x'],
      ['', '账号说明', 1234567890, 'Trade - $9'],
      ['', '交易', 9, 'Trade - $9'],
      ['2026-09-27', '交易', 20, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date' },
    expectedSourceHeaders: headers,
    amountSplitByField: {
      enabled: true,
      rules: [{ conditionField: 'Type', conditionValue: '交易', mappedField: 'Amt', targetField: 'Credit Amount' }]
    },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => issue.rowNumber), [3, 4]);
  assert.deepEqual(mapped.crossSheetBackfillStats.skippedTransactionRowNumbers, [4], '第 3 行类型不是「交易」，映射不取金额，不算交易行');
});

test('来源 Sheet 存在但整张为空时，按来源表头校验报出表名与所需字段（不报「文件为空或不可读」）', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'empty-source.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $9.00']],
    source: []
  });
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  }), (error) => /来源 Sheet「SRC」中没有同时包含「Credit」「Date」的表头行/.test(error.message));
});

test('1904 日期系统工作簿中的 ISO 日期单元格（t="d"）与日期序号同口径：主表与来源日期都不错移四年', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'mac-1904-iso.xlsx');
  const dateCell = (serial) => ({ t: 'n', v: serial, z: 'dd/mm/yyyy' });
  writeWorkbook(filePath, {
    date1904: true,
    main: [headers, ['ISO-MAIN', 1, 'x'], ['', 2, 'Trade - $65.45'], [dateCell(44830), 3, 'x']],
    source: [['Date', 'Credit'], ['ISO-SRC', 65.45]]
  });
  // 把占位文本改成 ISO 日期单元格（部分工具按 t="d" 写日期）
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const replaceCell = async (sheetPath, reference, iso) => {
    const xml = await zip.file(sheetPath).async('string');
    const next = xml.replace(new RegExp(`<c r="${reference}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), `<c r="${reference}" t="d"><v>${iso}</v></c>`);
    assert.notEqual(next, xml);
    zip.file(sheetPath, next);
  };
  await replaceCell('xl/worksheets/sheet1.xml', 'A2', '2026-09-25T00:00:00Z');
  await replaceCell('xl/worksheets/sheet2.xml', 'A2', '2026-09-26T00:00:00Z');
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26', '2026-09-27']);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
});

test('1904 ISO 日期单元格只在账单映射（按工作簿日期系统换算）中改口径：省略 r 的单元格同样识别；其他读取入口与查重整行保持原值', async (t) => {
  const JSZip = require('jszip');
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'mac-1904-no-ref.xlsx');
  writeWorkbook(filePath, {
    date1904: true,
    main: [headers, ['ISO', 1, 'x'], ['ISO', 2, 'y']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(sheetPath).async('string');
  // 第 2 行 A2 带 r；第 3 行整行省略 r（行与单元格都按前一个推出）
  const next = xml
    .replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A2" t="d"><v>2026-09-25T00:00:00Z</v></c>')
    .replace(/<row r="3"([^>]*)>([\s\S]*?)<\/row>/, (_whole, attributes, body) => `<row${attributes}>${body
      .replace(/<c r="A3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c t="d"><v>2026-09-27T00:00:00Z</v></c>')
      .replace(/ r="[A-Z]+3"/g, '')}</row>`);
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-27']);

  // 其他读取入口（不按工作簿日期系统换算）保持读取库原值：1900 序号（读取库按本机时区换算，部分时区带秒级偏差，可正可负）
  const plain = readRowsWithMetadata(filePath, headers);
  const libraryValues = plain.rows.slice(1).map((row) => row[0]);
  assert.deepEqual(libraryValues.map(Math.round), [46290, 46292]);
  // 账单映射读取：映射值按原文 ISO 换算成 1904 序号（不受本机时区影响），查重用的整行保持读取库原值（指纹与升级前一致）
  const full = readRowsWithMetadata(filePath, headers, { includeFullRows: true, exactIsoDates: true });
  assert.deepEqual(full.rows.slice(1).map((row) => row[0]), [46290 - 1462, 46292 - 1462]);
  assert.deepEqual(full.fullRows.slice(1).map((row) => row[0]), libraryValues);
});

test('ISO 日期按原文换算：按字面的年月日时分秒（时区后缀不参与），两种日期系统；日期不存在、写法无法识别为 NaN（第二十四轮起，不交给读取库），空原文为 null', () => {
  const { isoTextToSerial } = require('../../../../src/backend/file-service/readers');
  assert.equal(isoTextToSerial('2026-09-25', true), 44828);
  assert.equal(isoTextToSerial('2026-09-25T12:00:00Z', true), 44828.5);
  assert.equal(isoTextToSerial('2026-09-26T06:00:00+08:00', true), 44829.25);
  assert.equal(isoTextToSerial('2026-09-25'), 46290);
  assert.equal(isoTextToSerial('2026-09-26T15:00:00Z'), 46291.625);
  assert.equal(isoTextToSerial('1900-01-01'), 1, '1900-03-01 之前沿用 Excel 的 1900 序号');
  assert.equal(isoTextToSerial('1900-03-01'), 61);
  assert.ok(Number.isNaN(isoTextToSerial('2026-02-30T00:00:00Z', true)));
  assert.ok(Number.isNaN(isoTextToSerial('2026-09-25T25:00:00Z')));
  assert.ok(Number.isNaN(isoTextToSerial('25/09/2026')));
  assert.equal(isoTextToSerial('2026/9/25'), 46290);
  assert.equal(isoTextToSerial('  '), null);
  assert.equal(Math.floor(isoTextToSerial('2026-09-25T23:59:59.999999Z')), 46290, '小数秒截到毫秒，不进位到次日');
});



test('没有缓存结果的数组公式（锚点读成占位单元格）同样识别为不能单独填写的区域', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Calc', 'Channel'];
  const filePath = path.join(dir, 'array-no-cache.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 1, 'x', 1, 'A'],
      ['2026-09-26', 2, 'Trade - $65.45', 'ANCHOR'],
      ['2026-09-28', 4, 'x', 1, 'C']
    ],
    source: [['Date', 'Credit', 'Channel'], ['2026-09-26', 65.45, 'FX-01']]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(sheetPath).async('string');
  const next = xml.replace(/<c r="D3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="D3"><f t="array" ref="D3:E3">B3*2</f></c>');
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Desc', op: '包含', value: 'Trade' }] }],
      backfillFields: [{ targetField: 'Channel', sourceField: 'Channel' }]
    })
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable']]);
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
});

test('没有缓存结果的共享公式从属格（读取库读成空白）在配对阶段按原文识别为公式，该行跳过，不进入明细也不留到写出时', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Channel'];
  const filePath = path.join(dir, 'shared-no-cache.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 1, 'x', 'MASTER'],
      ['2026-09-26', 2, 'Trade - $65.45', 'DEPENDENT'],
      ['2026-09-28', 4, 'Trade - $10', '']
    ],
    source: [['Date', 'Credit', 'Channel'], ['2026-09-26', 65.45, 'FX-01'], ['2026-09-28', 10, 'FX-02']]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const xml = await zip.file(sheetPath).async('string');
  const next = xml
    .replace(/<c r="D2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="D2" t="str"><f t="shared" ref="D2:D3" si="0">C2</f><v>x</v></c>')
    .replace(/<c r="D3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="D3"><f t="shared" si="0"></f></c>');
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Desc', op: '包含', value: 'Trade' }] }],
      backfillFields: [{ targetField: 'Channel', sourceField: 'Channel' }]
    })
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
  assert.deepEqual(mapped.crossSheetBackfillPatches.map((patch) => patch.rowNumber), [4]);
  assert.deepEqual(mapped.slice(1).map((row) => row[2]), ['x', 'FX-02'], '第 3 行跳过，不进入明细');
});

test('来源 Sheet 就是模板读取的主表时（有待回填行）明确报错，不在同一张表内配对', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Credit', 'Channel'];
  const filePath = path.join(dir, 'self-source.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x', 65.45, 'A'], ['', 2, 'Trade - $65.45', '', '']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const build = (sourceSheetName) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({ sourceSheetName })
  });
  assert.throws(() => build('MAIN'), /来源 Sheet「MAIN」就是模板读取的主表（第一个 Sheet），不能从主表自身回填/);
  assert.deepEqual(build('SRC').slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26']);
});

// 把来源表 A2 改成 ISO 日期单元格（t="d"）
async function setSourceIsoDate(filePath, isoText) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sheetPath = 'xl/worksheets/sheet2.xml';
  const xml = await zip.file(sheetPath).async('string');
  const next = xml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, `<c r="A2" t="d"><v>${isoText}</v></c>`);
  assert.notEqual(next, xml);
  zip.file(sheetPath, next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function buildIsoSourceMapped(filePath) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
}

test('1900 工作簿的 ISO 来源日期按原文年月日回填，不受本机时区影响（圣保罗时区读取库读成前一天的序号）', async (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'iso-1900.xlsx');
  writeWorkbook(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45'], ['2026-09-28', 3, 'y']],
    source: [['Date', 'Credit'], ['ISO', 65.45]]
  });
  await setSourceIsoDate(filePath, '2026-09-26T00:00:00Z');
  const mapped = buildIsoSourceMapped(filePath);
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26', '2026-09-28']);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
});

test('ISO 来源日期不存在（2026-02-30）时按「来源日期无法识别」跳过该行，不取读取库滚入下月的日期', async (t) => {
  const dir = makeTempDir(t);
  for (const date1904 of [false, true]) {
    const filePath = path.join(dir, `iso-invalid-${date1904 ? '1904' : '1900'}.xlsx`);
    writeWorkbook(filePath, {
      date1904,
      main: [['Date', 'In', 'Desc'], ['2026-02-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
      source: [['Date', 'Credit'], ['ISO', 65.45]]
    });
    await setSourceIsoDate(filePath, '2026-02-30T00:00:00Z');
    const mapped = buildIsoSourceMapped(filePath);
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'source-date-invalid']], `date1904=${date1904}`);
    assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-02-25']);
  }
});

test('SpreadsheetML 2003 的 .xls 声明 1904 时，DateTime 单元格按原文、数值日期按 1904 换算：同表两种表示都是原日期', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xml2003-1904.xls');
  fs.writeFileSync(filePath, `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel"><Date1904/></ExcelWorkbook>
 <Styles><Style ss:ID="d"><NumberFormat ss:Format="Short Date"/></Style></Styles>
 <Worksheet ss:Name="MAIN"><Table>
  <Row><Cell><Data ss:Type="String">Date</Data></Cell><Cell><Data ss:Type="String">In</Data></Cell><Cell><Data ss:Type="String">Desc</Data></Cell></Row>
  <Row><Cell ss:StyleID="d"><Data ss:Type="DateTime">2026-09-25T00:00:00.000</Data></Cell><Cell><Data ss:Type="Number">1</Data></Cell><Cell><Data ss:Type="String">x</Data></Cell></Row>
  <Row><Cell ss:StyleID="d"><Data ss:Type="Number">44829</Data></Cell><Cell><Data ss:Type="Number">2</Data></Cell><Cell><Data ss:Type="String">x</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="Number">3</Data></Cell><Cell><Data ss:Type="String">Trade - $65.45</Data></Cell></Row>
 </Table></Worksheet>
 <Worksheet ss:Name="SRC"><Table>
  <Row><Cell><Data ss:Type="String">Date</Data></Cell><Cell><Data ss:Type="String">Credit</Data></Cell></Row>
  <Row><Cell ss:StyleID="d"><Data ss:Type="Number">44830</Data></Cell><Cell><Data ss:Type="Number">65.45</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  // 44829、44830 在 1904 工作簿中是 2026-09-26、2026-09-27（按 1900 会读成 2022 年）
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26', '2026-09-27']);
});

test('读取结果带工作簿全部 sheet 名；只解析指定 sheet 时 sheet 名仍为全部、读到的是指定 sheet', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'names.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In'], ['2026-09-25', 1]], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  assert.deepEqual(readRowsWithMetadata(filePath, ['Date', 'In']).sheetNames, ['MAIN', 'SRC']);
  const source = readRowsWithMetadata(filePath, [], { sheetName: 'SRC', onlyTargetSheet: true, allowEmpty: true });
  assert.deepEqual(source.sheetNames, ['MAIN', 'SRC']);
  assert.deepEqual(source.rows, [['Date', 'Credit'], ['2026-09-26', 65.45]]);
});

test('按原值配对的 ISO 日期时间保留时分秒：同一天 09:00、15:00 两笔来源，主表 15:00 配到 15:00 那笔', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Time', 'Channel'];
  const filePath = path.join(dir, 'iso-time-exact.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'T', '']],
    source: [['Time', 'Channel'], ['T1', 'AM'], ['T2', 'PM']]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const setIso = (xml, reference, isoText) => {
    const next = xml.replace(new RegExp(`<c r="${reference}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), `<c r="${reference}" t="d"><v>${isoText}</v></c>`);
    assert.notEqual(next, xml);
    return next;
  };
  const mainXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', setIso(mainXml, 'C2', '2026-09-26T15:00:00Z'));
  const sourceXml = await zip.file('xl/worksheets/sheet2.xml').async('string');
  zip.file('xl/worksheets/sheet2.xml', setIso(setIso(sourceXml, 'A2', '2026-09-26T09:00:00Z'), 'A3', '2026-09-26T15:00:00Z'));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Channel', op: '空值', value: '' }] }],
      matchMode: 'exact',
      matchField: 'Time',
      sourceMatchField: 'Time',
      backfillFields: [{ targetField: 'Channel', sourceField: 'Channel' }]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[2]), ['PM']);
  assert.deepEqual(mapped.crossSheetBackfillPatches.map((patch) => patch.sourceRowNumber), [3]);
});

test('账单日期单列映射到带时分的 Excel 日期序号时取日期部分（原先拼成字符串后按无效日期拒绝整份）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'datetime.xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Date', 'In'], [46290.5, 1], [46291.25, 2]]);
  sheet.A2.z = 'yyyy-mm-dd hh:mm';
  sheet.A3.z = 'yyyy-mm-dd hh:mm';
  XLSX.utils.book_append_sheet(workbook, sheet, 'MAIN');
  XLSX.writeFile(workbook, filePath);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In']
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26']);
});

// ---- v3.2.21 审查回归（第八轮）----

test('币种列同时是「按字段区分发生额」的条件：补币种会把支出翻成收入时按冲突跳过，不改变银行原始交易方向', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Ccy', 'Amt', 'Desc'];
  const filePath = path.join(dir, 'currency-direction.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 'NGN', 10, 'x'],
      ['', '', 90000, 'Trade - $65.45'],
      ['2026-09-27', 'NGN', 20, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', Currency: 'Ccy' },
    expectedSourceHeaders: headers,
    amountSplitByField: {
      enabled: true,
      rules: [
        { targetField: 'Debit Amount', conditionField: 'Ccy', conditionValue: '/^$/', mappedField: 'Amt' },
        { targetField: 'Credit Amount', conditionField: 'Ccy', conditionValue: 'NGN', mappedField: 'Amt' }
      ]
    },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'amount-changed']]);
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2], row[3]]), [['2026-09-25', '10', ''], ['2026-09-27', '20', '']]);
});

test('带小数的数值日期只在 Excel 序号范围内取日期部分：260925.5、20260925.5 不截成六位 / 八位日期写法', (t) => {
  const dir = makeTempDir(t);
  for (const value of [260925.5, 20260925.5]) {
    const filePath = path.join(dir, `fraction-${value}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'In'], [value, 1]]), 'MAIN');
    XLSX.writeFile(workbook, filePath);
    assert.throws(() => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: TARGETS,
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In']
    }), /账单日期/, String(value));
  }
});

test('账户号在账户管理中维护了「无币种时的币种」且与本表推断的币种不一致：不补币种、按冲突跳过，不静默改变余额分组', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Acct', 'Ccy', 'In', 'Desc'];
  const filePath = path.join(dir, 'account-currency.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 'A', 'USD', 10, 'x'],
      ['', 'B', '', 2, 'Trade - $65.45'],
      ['', 'C', '', 3, 'Trade - $10.00'],
      ['2026-09-27', 'A', 'USD', 20, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45], ['2026-09-26', 10]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: 'Acct', Currency: 'Ccy', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    currencyMappings: [{ englishCode: 'USD', aliases: [] }, { englishCode: 'EUR', aliases: [] }],
    accountMappingByBankId: {
      A: { clearingAccountId: 'CA' },
      B: { clearingAccountId: 'CB', noCurrency: true, currency: 'EUR' },
      C: { clearingAccountId: 'CC', noCurrency: true, currency: 'USD' }
    },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'currency-conflicts-account']]);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 3)), [
    ['2026-09-25', 'CA', 'USD'],
    ['2026-09-26', 'CC', 'USD'],
    ['2026-09-27', 'CA', 'USD']
  ], '维护币种与推断一致（C）照常回填');
});

test('来源日期为数字形式的日历日期（260926、20260926）与主映射同口径识别；Excel 序号照常换算', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  for (const [mainDate, sourceDate, expected] of [
    [260925, 260926, ['2026-09-25', '2026-09-26']],
    // 主表八位日期按原写法输出（主映射既有行为），回填写入 yyyy-mm-dd
    [20260925, 20260926, ['20260925', '2026-09-26']],
    [46290, 46291, ['2026-09-25', '2026-09-26']]
  ]) {
    const filePath = path.join(dir, `numeric-${sourceDate}.xlsx`);
    writeWorkbook(filePath, {
      main: [headers, [mainDate, 1, 'x'], ['', 2, 'Trade - $65.45']],
      source: [['Date', 'Credit'], [sourceDate, 65.45]]
    });
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: headers,
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.slice(1).map((row) => row[0]), expected, String(sourceDate));
  }
});

test('启用回填时读主表只解析主表（来源表找到待回填行后再单独读）；返回全部 Sheet 名', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'only-main.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In'], ['2026-09-25', 1]], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  const originalReadFile = XLSX.readFile;
  const optionsSeen = [];
  t.mock.method(XLSX, 'readFile', (file, options) => {
    optionsSeen.push(options);
    return originalReadFile(file, options);
  });
  const result = readRowsWithMetadata(filePath, [], { onlyTargetSheet: true, allowEmpty: true });
  assert.deepEqual(result.sheetNames, ['MAIN', 'SRC']);
  assert.deepEqual(result.rows, [['Date', 'In'], ['2026-09-25', 1]]);
  assert.equal(optionsSeen[0].sheets, 0);
});

// ---- v3.2.21 审查回归（第十轮）----

test('账户冲突检查按 MerchantId 的账户键（去掉内部空白）：`12 34` 对应账户管理的 `1234`', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Acct', 'Ccy', 'In', 'Desc'];
  const filePath = path.join(dir, 'account-key.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 'A', 'USD', 10, 'x'], ['', '12 34', '', 2, 'Trade - $65.45']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: 'Acct', Currency: 'Ccy', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    currencyMappings: [{ englishCode: 'USD', aliases: [] }, { englishCode: 'EUR', aliases: [] }],
    accountMappingByBankId: { A: { clearingAccountId: 'CA' }, 1234: { clearingAccountId: 'CB', noCurrency: true, currency: 'EUR' } },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'currency-conflicts-account']]);
});

test('没有缓存结果的布尔公式按空值读取：命中待回填条件，按「没有结果的公式」跳过，不输出 false', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'uncached-bool.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x'], ['x', 2, 'Trade - $65.45'], ['2026-09-27', 3, 'x']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const next = xml.replace(/<c r="A3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A3" t="b"><f>1=1</f></c>');
  assert.notEqual(next, xml);
  zip.file('xl/worksheets/sheet1.xml', next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-27']);
});

// ---- v3.2.21 审查回归（第十一轮）----

test('账户维护的兜底币种与本表推断只差大小写（USD / usd）：不补本表写法，由账户兜底给出同一币种值，余额分组不拆开', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Acct', 'Ccy', 'In', 'Desc'];
  const filePath = path.join(dir, 'account-case.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 'A', 'usd', 10, 'x'],
      ['', 'B', '', 2, 'Trade - $65.45'],
      ['2026-09-27', 'B', '', 5, 'y']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: 'Acct', Currency: 'Ccy', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    accountMappingByBankId: { A: { clearingAccountId: 'CA' }, B: { clearingAccountId: 'CB', noCurrency: true, currency: 'USD' } },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(2).map((row) => row.slice(0, 3)), [['2026-09-26', 'CB', 'USD'], ['2026-09-27', 'CB', 'USD']]);
  assert.deepEqual(mapped.crossSheetBackfillPatches.map((patch) => patch.cells.map((cell) => cell.field)), [['Date']], '不补币种列');
});

test('来源表没有缓存结果的布尔公式按空值读取，不提供配对键；确实缓存的 FALSE 照常配对', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'Key', 'In'];
  const filePath = path.join(dir, 'source-uncached.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 'x', 1], ['', 'false', 2]],
    source: [['Date', 'Key'], ['2026-09-26', 'a'], ['2026-09-27', 'b']]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const xml = await zip.file('xl/worksheets/sheet2.xml').async('string');
  const next = xml
    .replace(/<c r="B2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B2" t="b"><f>1=1</f></c>')
    .replace(/<c r="B3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="B3" t="b"><f>1=2</f><v>0</v></c>');
  assert.notEqual(next, xml);
  zip.file('xl/worksheets/sheet2.xml', next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({ matchMode: 'exact', matchField: 'Key', sourceMatchField: 'Key' })
  });
  assert.deepEqual(mapped.crossSheetBackfillPatches.map((patch) => patch.sourceRowNumber), [3]);
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-27']);
});

test('主表布尔公式的缓存为空元素（<v></v>、<v/>）同样视为没有结果：按空值读取并跳过', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  for (const [index, cellXml] of ['<c r="A3" t="b"><f>1=1</f><v></v></c>', '<c r="A3" t="b"><f>1=1</f><v/></c>'].entries()) {
    const filePath = path.join(dir, `empty-cache-${index}.xlsx`);
    writeWorkbook(filePath, {
      main: [headers, ['2026-09-25', 1, 'x'], ['x', 2, 'Trade - $65.45']],
      source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
    });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', xml.replace(/<c r="A3"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, cellXml));
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: headers,
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']], cellXml);
  }
});

// ---- v3.2.21 审查回归（第十二轮）----

test('账单日期取「Date，其次 Remarks」时 Remarks 为「合计」的行按未修改的源行判为合计行：不参与回填、不消耗来源记录、不导出', (t) => {
  const { buildLogicValueToken } = require('../../../../src/backend/file-service');
  const dir = makeTempDir(t);
  const headers = ['Date', 'Remarks', 'In', 'Desc'];
  const filePath = path.join(dir, 'summary-row.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', '', 10, 'x'], ['', '合计', 10, 'Total 10.00']],
    source: [['Date', 'Credit'], ['2026-09-26', 10]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: buildLogicValueToken(['Date', 'Remarks']), 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '10']]);
  assert.deepEqual(mapped.issues.map((issue) => [issue.type, issue.rowNumber]), [['summary-row-skipped', 3]]);
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
});

test('MerchantId 拼接「账号 + 币种」时补上本表币种会改变账户号：按账户改变跳过，不把交易移到另一个清算账号', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'Acct', 'Ccy', 'In', 'Desc'];
  const filePath = path.join(dir, 'account-changed.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['2026-09-25', 'A', 'USD', 10, 'x'],
      ['', 'A', '', 2, 'Trade - $65.45'],
      ['2026-09-27', 'A', 'USD', 20, 'x']
    ],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: ['Acct', 'Ccy'], Currency: 'Ccy', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    currencyMappings: [{ englishCode: 'USD', aliases: [] }],
    accountMappingByBankId: { A: { clearingAccountId: 'CA' }, AUSD: { clearingAccountId: 'CB' } },
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'account-changed']]);
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 3)), [['2026-09-25', 'CB', 'USD'], ['2026-09-27', 'CB', 'USD']]);
});

test('SpreadsheetML 2003（XML 格式的 .xls）中没有缓存结果的公式：读取库会丢弃该格，按原文识别后主表该行跳过，不当成空格回填', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-uncached.xls');
  const cell = (type, value) => `<Cell><Data ss:Type="${type}">${value}</Data></Cell>`;
  fs.writeFileSync(filePath, [
    '<?xml version="1.0"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Worksheet ss:Name="MAIN"><Table>',
    `<Row>${cell('String', 'Date')}${cell('String', 'In')}${cell('String', 'Desc')}</Row>`,
    `<Row>${cell('String', '2026-09-25')}${cell('Number', 1)}${cell('String', 'x')}</Row>`,
    `<Row><Cell ss:Formula="=TODAY()"/>${cell('Number', 2)}${cell('String', 'Trade - $65.45')}</Row>`,
    `<Row><Cell ss:Formula="=TODAY()"><Data ss:Type="String"></Data></Cell>${cell('Number', 3)}${cell('String', 'Trade - $10.00')}</Row>`,
    `<Row>${cell('String', '')}${cell('Number', 4)}${cell('String', 'Trade - $7.00')}</Row>`,
    '</Table></Worksheet>',
    '<Worksheet ss:Name="SRC"><Table>',
    `<Row>${cell('String', 'Date')}${cell('String', 'Credit')}</Row>`,
    `<Row>${cell('String', '2026-09-26')}${cell('Number', 65.45)}</Row>`,
    `<Row>${cell('String', '2026-09-26')}${cell('Number', 10)}</Row>`,
    `<Row>${cell('String', '2026-09-27')}${cell('Number', 7)}</Row>`,
    '</Table></Worksheet>',
    '</Workbook>'
  ].join('\n'));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable'], [4, 'target-cell-unreadable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-27', '4']], '真正为空的格照常回填');
});

test('ISO 小数秒超过九位时按完整小数截到毫秒：.12345678901 与同秒 .000 不混为同一时刻，按原值配对到对应那笔', async (t) => {
  const { isoTextToSerial } = require('../../../../src/backend/file-service/readers');
  assert.equal(isoTextToSerial('2026-09-25T15:01:02.12345678901Z'), isoTextToSerial('2026-09-25T15:01:02.123Z'));
  assert.notEqual(isoTextToSerial('2026-09-25T15:01:02.12345678901Z'), isoTextToSerial('2026-09-25T15:01:02Z'));
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Time', 'Channel'];
  const filePath = path.join(dir, 'iso-long-fraction.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'T', '']],
    source: [['Time', 'Channel'], ['T1', 'ZERO'], ['T2', 'MILLI']]
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const setIso = (xml, reference, isoText) => {
    const next = xml.replace(new RegExp(`<c r="${reference}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), `<c r="${reference}" t="d"><v>${isoText}</v></c>`);
    assert.notEqual(next, xml);
    return next;
  };
  const mainXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', setIso(mainXml, 'C2', '2026-09-26T15:01:02.12345678901Z'));
  const sourceXml = await zip.file('xl/worksheets/sheet2.xml').async('string');
  zip.file('xl/worksheets/sheet2.xml', setIso(setIso(sourceXml, 'A2', '2026-09-26T15:01:02Z'), 'A3', '2026-09-26T15:01:02.123Z'));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: 'Channel' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Channel', op: '空值', value: '' }] }],
      matchMode: 'exact',
      matchField: 'Time',
      sourceMatchField: 'Time',
      backfillFields: [{ targetField: 'Channel', sourceField: 'Channel' }]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[2]), ['MILLI']);
});

test('不能单独填写的区域按行建索引后仍按坐标判定：跨多行的合并区域覆盖其中各行，区域外的格照常回填', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'Note'];
  const filePath = path.join(dir, 'merge-index.xlsx');
  writeWorkbook(filePath, {
    main: [
      headers,
      ['', 1, 'Trade - $1.00', 'n'],
      ['', 2, 'Trade - $2.00', ''],
      ['', 3, 'Trade - $3.00', ''],
      ['', 4, 'Trade - $4.00', 'n']
    ],
    source: [['Date', 'Credit'], ['2026-09-21', 1], ['2026-09-22', 2], ['2026-09-23', 3], ['2026-09-24', 4]],
    merges: ['D2:D4', 'A3:A4']
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[4, 'target-cell-unwritable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-21', '2026-09-22', '2026-09-24']);
});

// ---- v3.2.21 审查回归（第十三轮）----

test('UTF-16 编码的 SpreadsheetML 2003：没有缓存结果的公式按原文编码识别，主表该行跳过；DateTime 单元格同样按原文换算', (t) => {
  const dir = makeTempDir(t);
  const cell = (type, value) => `<Cell><Data ss:Type="${type}">${value}</Data></Cell>`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Worksheet ss:Name="MAIN"><Table>',
    `<Row>${cell('String', 'Date')}${cell('String', 'In')}${cell('String', 'Desc')}</Row>`,
    `<Row>${cell('DateTime', '2026-09-25T00:00:00.000')}${cell('Number', 1)}${cell('String', 'x')}</Row>`,
    `<Row><Cell ss:Formula="=TODAY()"/>${cell('Number', 2)}${cell('String', 'Trade - $65.45')}</Row>`,
    `<Row>${cell('String', '')}${cell('Number', 4)}${cell('String', 'Trade - $7.00')}</Row>`,
    '</Table></Worksheet>',
    '<Worksheet ss:Name="SRC"><Table>',
    `<Row>${cell('String', 'Date')}${cell('String', 'Credit')}</Row>`,
    `<Row>${cell('String', '2026-09-26')}${cell('Number', 65.45)}</Row>`,
    `<Row>${cell('String', '2026-09-27')}${cell('Number', 7)}</Row>`,
    '</Table></Worksheet>',
    '</Workbook>'
  ].join('\n');
  const filePath = path.join(dir, 'xlml-utf16.xls');
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-27', '4']]);
});

// ---- v3.2.21 审查回归（第十四轮）----

// 内容为 ODS 的账单（扩展名可以是 .xls）：按读取库写出 ODS 后把占位文本替换成 ODS 原生的日期单元格 / 没有缓存结果的公式
function writeOdsStatement(filePath, {
  main, source, replacements, nullDate = null, flat = false, mainName = 'MAIN', sourceName = 'SRC', extraSheets = []
}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(main), mainName);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(source), sourceName);
  extraSheets.forEach(([name, rows]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name));
  // flat：平面 OpenDocument（FODS，单个 XML 文件）
  const container = flat ? null : XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = flat ? null : XLSX.CFB.find(container, 'content.xml');
  let xml = flat ? XLSX.write(workbook, { type: 'string', bookType: 'fods' }) : Buffer.from(content.content).toString('utf8');
  Object.entries(replacements).forEach(([placeholder, cellXml]) => {
    const original = `<table:table-cell office:value-type="string"><text:p>${placeholder}</text:p></table:table-cell>`;
    assert.ok(xml.includes(original), placeholder);
    xml = xml.replace(original, cellXml);
  });
  if (nullDate) {
    const next = xml.replace('<office:spreadsheet>',
      `<office:spreadsheet><table:calculation-settings><table:null-date table:date-value="${nullDate}"/></table:calculation-settings>`);
    assert.notEqual(next, xml);
    xml = next;
  }
  if (flat) {
    fs.writeFileSync(filePath, xml, 'utf8');
    return;
  }
  content.content = Buffer.from(xml, 'utf8');
  fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
}

const odsDateCell = (isoDate) => `<table:table-cell office:value-type="date" office:date-value="${isoDate}" calcext:value-type="date"><text:p>${isoDate}</text:p></table:table-cell>`;

test('内容为 ODS 的账单（西半球时区）：日期单元格按 office:date-value 原文换算，主表与来源都不早一天；没有缓存结果的公式按原文识别，该行跳过', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-content.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x'], ['MAIN_FORMULA', 2, 'Trade - $65.45'], ['', 3, 'Trade - $7.00']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45], ['SRC_DATE', 7]],
    replacements: {
      MAIN_DATE: odsDateCell('2026-09-25'),
      MAIN_FORMULA: '<table:table-cell table:formula="of:=TODAY()"/>',
      SRC_DATE: odsDateCell('2026-09-27')
    }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-27', '3']]);
});

// ---- v3.2.21 审查回归（第十五轮）----

test('内容为 ODS 的账单声明日期基准 1904-01-01：主表与来源表的数值日期按 1904 换算，日期单元格按原文；不支持的基准报错，不按 1900 猜测', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-1904.xls');
  const build = (nullDate) => {
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x'], ['', 2, 'Trade - $65.45'], [44831, 3, 'y']],
      source: [['Date', 'Credit'], [44829, 65.45]],
      replacements: { MAIN_DATE: odsDateCell('2026-09-25') },
      nullDate
    });
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc'],
      crossSheetBackfillRule: rule()
    });
  };
  const mapped = build('1904-01-01');
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26', '2026-09-28']);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
  const defaultBase = build('1899-12-30');
  assert.deepEqual([defaultBase[1][0], defaultBase[3][0]], ['2026-09-25', '2022-09-27'], '1899-12-30（ODF 缺省）按 1900');
  assert.throws(() => build('1900-01-01'), /日期基准/);
});

test('ODS 按原文扫描只标记并重新解析指定的工作表：主表没有要标记的单元格时不重新解析，其他表不进入重新解析的工作簿', (t) => {
  const { scanOdsWorkbookCells } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'scoped.xls');
  const reads = [];
  const originalRead = XLSX.read;
  XLSX.read = function patchedRead(...args) {
    const workbook = originalRead.apply(this, args);
    reads.push(workbook.SheetNames.slice());
    return workbook;
  };
  t.after(() => { XLSX.read = originalRead; });
  const write = (mainDate) => writeOdsStatement(filePath, {
    main: [['Date', 'In'], [mainDate ? 'MAIN_DATE' : 'text', 1]],
    source: [['Date', 'Credit'], ['SRC_DATE', 7]],
    replacements: { ...(mainDate ? { MAIN_DATE: odsDateCell('2026-09-25') } : {}), SRC_DATE: odsDateCell('2026-09-27') }
  });
  write(false);
  assert.deepEqual([...scanOdsWorkbookCells(filePath, { sheetNames: ['MAIN'], isoDates: true }).keys()], []);
  assert.deepEqual(reads, [], '主表没有日期单元格：不重新解析');
  write(true);
  const found = scanOdsWorkbookCells(filePath, { sheetNames: ['MAIN'], isoDates: true });
  assert.deepEqual(reads, [['MAIN']], '重新解析的工作簿只含主表');
  assert.deepEqual(found.get('MAIN').isoDateCells.map(({ r, c, text }) => [r, c, text]), [[1, 0, '2026-09-25']]);
  assert.deepEqual(scanOdsWorkbookCells(filePath, { isoDates: true }).get('SRC').isoDateCells.map(({ text }) => text), ['2026-09-27'],
    '不指定工作表时扫描全部');
});

// ---- v3.2.21 审查回归（第十六轮）----

test('规则引用的列按主表整行表头核对重名：模板只取 Date/In/Desc 段、段外还有一列 Date 时报错列出两列，不把来源日期写进第一列', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'duplicate-date.xlsx');
  writeWorkbook(filePath, {
    main: [['Date', 'In', 'Desc', 'Date'], ['2026-09-25', 1, 'x', ''], ['', 2, 'Trade - $65.45', '2026-09-26'], ['2026-09-28', 3, 'y', '']],
    source: [['Date', 'Credit'], ['2026-09-27', 65.45]]
  });
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  }), /主表表头中「Date」出现多次（第 A、D 列）/);
});

// ---- v3.2.21 审查回归（第十七轮）----

test('币种与余额取自同一列「余额及币种」：补币种会把整格原文（含上一笔的余额）带进待回填行，余额随之改变，按收支或余额改变跳过', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc', 'BalCcy'];
  const filePath = path.join(dir, 'balance-currency.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x', '美元 800.00'], ['', 2, 'Trade - $65.45', ''], ['2026-09-28', 3, 'y', '']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Currency', 'Balance'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Currency: 'BalCcy', Balance: 'BalCcy' },
    expectedSourceHeaders: headers,
    currencyMappings: [{ englishCode: 'USD', aliases: ['美元'] }],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'amount-changed']]);
  assert.deepEqual(mapped.slice(1), [['2026-09-25', '1', 'USD', '800.00'], ['2026-09-28', '3', '', '']]);
});

test('表名按 ST_Xstring 转义存储（ABC_x005F_x0041_）的 1904 工作簿：主表的 ISO 日期单元格照常按原文换算，不把 1900 序号当成 1904 序号', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'escaped-sheet-name.xlsx');
  writeWorkbook(filePath, {
    main: [['Date', 'In', 'Desc'], ['ISO', 1, 'x'], ['2026-09-28', 2, 'y']],
    source: [['Date', 'Credit']],
    date1904: true
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const renamed = workbookXml.replace(/(<sheet\b[^>]*?name=")[^"]*(")/, '$1ABC_x005F_x0041_$2');
  assert.notEqual(renamed, workbookXml);
  zip.file('xl/workbook.xml', renamed);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const next = sheetXml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A2" t="d"><v>2026-09-25T00:00:00Z</v></c>');
  assert.notEqual(next, sheetXml);
  zip.file('xl/worksheets/sheet1.xml', next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-28']);
});

test('ISO 日期单元格的 24:00:00 是当日结束、即次日零点：月末 2026-09-30T24:00:00Z 记到 10 月 1 日；其他超出范围的时间按无效日期处理', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const build = async (isoText) => {
    const filePath = path.join(dir, `end-of-day-${isoText.replace(/\W/g, '')}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['ISO', 1, 'x']], source: [['Date', 'Credit']] });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const next = sheetXml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, `<c r="A2" t="d"><v>${isoText}</v></c>`);
    assert.notEqual(next, sheetXml);
    zip.file('xl/worksheets/sheet1.xml', next);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
  };
  assert.equal((await build('2026-09-30T24:00:00Z'))[1][0], '2026-10-01');
  assert.equal((await build('2026-12-31T24:00:00.000'))[1][0], '2027-01-01');
  await assert.rejects(build('2026-09-30T24:00:01Z'), /账单日期|BillDate|无效/);
});

// ---- v3.2.21 审查回归（第十八轮）----

test('跳过的行是否带发生额按明细导出的零值 / 空值判定：收入文本 `100.` 无法按数值解析，但明细照常导出，算作带发生额的交易', (t) => {
  const dir = makeTempDir(t);
  const headers = ['Date', 'In', 'Desc'];
  const filePath = path.join(dir, 'trailing-dot.xlsx');
  writeWorkbook(filePath, {
    main: [headers, ['2026-09-25', 1, 'x'], ['', '100.', 'Trade - $99'], ['', '', 'Account 123'], ['2026-09-27', 4, 'y']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: headers,
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.crossSheetBackfillStats.skippedTransactionRowNumbers, [3], '第 4 行收支都为空（说明行），不计入');
});

test('表名含字面 `>`（A > B，属性值中合法）的 1904 工作簿：按属性引号边界定位工作表，ISO 日期单元格照常按原文换算', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'gt-sheet-name.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['ISO', 1, 'x']], source: [['Date', 'Credit']], date1904: true });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const renamed = workbookXml.replace(/(<sheet\b[^>]*?name=")[^"]*(")/, '$1A > B$2');
  assert.notEqual(renamed, workbookXml);
  zip.file('xl/workbook.xml', renamed);
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A2" t="d"><v>2026-09-26T00:00:00Z</v></c>'));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.equal(mapped[1][0], '2026-09-26');
});

test('内容为 ODS 的账单：来源格是公式错误（office:value-type="string" 加 calcext:value-type="error"）时不提供配对键，不从 #DIV/0! 中识别出 0 与零金额交易配对', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-error.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $0.00'], ['2026-09-28', 3, 'y']],
    source: [['Date', 'Credit'], ['2026-09-26', 'SRC_ERROR']],
    replacements: {
      SRC_ERROR: '<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>#DIV/0!</text:p></table:table-cell>'
    }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'no-source-row']]);
});

// ---- v3.2.21 审查回归（第十九轮）----

test('平面 OpenDocument（FODS，以 .xls 命名）声明日期基准 1904-01-01：与 ZIP 格式的 ODS 同样按 1904 换算数值日期、按原文换算日期单元格（西半球时区不早一天）；不支持的基准报错', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'fods-1904.xls');
  const build = (nullDate) => {
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x'], ['', 2, 'Trade - $65.45'], [44831, 3, 'y']],
      source: [['Date', 'Credit'], [44828, 65.45]],
      replacements: { MAIN_DATE: odsDateCell('2026-09-24') },
      nullDate,
      flat: true
    });
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc'],
      crossSheetBackfillRule: rule()
    });
  };
  const mapped = build('1904-01-01');
  assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-24', '2026-09-25', '2026-09-28']);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')), []);
  assert.throws(() => build('1900-01-01'), /日期基准/);
});

test('ODS 声明的日期基准带等价的 UTC 后缀（1899-12-30Z、1904-01-01T00:00:00+00:00）时按同一基准，不整份拒绝', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-utc-base.xls');
  const build = (nullDate) => {
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], [44831, 3, 'y']],
      source: [['Date', 'Credit']],
      replacements: {},
      nullDate
    });
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
  };
  assert.equal(build('1899-12-30Z')[2][0], '2022-09-27');
  assert.equal(build('1904-01-01T00:00:00+00:00')[2][0], '2026-09-28');
  assert.throws(() => build('1900-01-01Z'), /日期基准/);
});

test('网页（HTML）格式的 .xls 账单（每个表格读成一张表）：确有待回填行时明确拒绝跨 Sheet 回填，不按丢失原文的值配对；没有待回填行时照常导入', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'two-tables.xls');
  const table = (rows) => `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
  const write = (mainRows) => fs.writeFileSync(filePath, `<html><body>${table(mainRows)}${table([['Date', 'Credit'], ['09/10/2026', '00123']])}</body></html>`);
  const build = () => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule({ sourceSheetName: 'Sheet2', matchMode: 'exact' })
  });
  // 主表日期用整数序号：网页表格中的日期文本由读取库按本机时区推断，西半球时区会按无效值拒绝（见第二十轮）
  write([['Date', 'In', 'Desc'], [46290, 1, 'x'], ['', 2, '00123']]);
  assert.throws(build, /网页（HTML）格式的表格.*另存为 xlsx/);
  write([['Date', 'In', 'Desc'], [46290, 1, 'x']]);
  assert.equal(build().length, 2);
});

// ---- v3.2.21 审查回归（第二十轮）----

function withTimeZone(t, timeZone) {
  const previousTz = process.env.TZ;
  process.env.TZ = timeZone;
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
}

test('网页（HTML）格式的 .xls 中由显示文本推断出的带小数日期序号不按「取日期部分」处理：西半球时区照旧按无效值拒绝，不把交易记到前一天', (t) => {
  withTimeZone(t, 'America/Los_Angeles');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'html-date.xls');
  fs.writeFileSync(filePath, '<html><body><table><tr><td>Date</td><td>In</td><td>Desc</td></tr><tr><td>2026-09-25</td><td>1</td><td>x</td></tr></table></body></html>');
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  }), /账单日期存在无效值/);
});

test('UTF-16 编码（带 BOM）的网页（HTML）格式 .xls：同样识别为网页表格，确有待回填行时拒绝跨 Sheet 回填', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'utf16-html.xls');
  const table = (rows) => `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
  const html = `<html><body>${table([['Date', 'In', 'Desc'], [46290, 1, 'x'], ['', 2, '123']])}${table([['Date', 'Credit'], ['2026-09-26', '00123']])}</body></html>`;
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(html, 'utf16le')]));
  assert.deepEqual(XLSX.readFile(filePath).SheetNames, ['Sheet1', 'Sheet2'], '读取库能读出两张表');
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule({ sourceSheetName: 'Sheet2', matchMode: 'exact' })
  }), /网页（HTML）格式的表格/);
});

test('ODF 日期带时区（office:date-value="2026-09-25+00:00"，读取库读成 NaN）：映射与按原值配对都取按原文换算的日期，不同日期不因同为 NaN 而配对', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-tz-date.xls');
  const tzDateCell = (isoDate) => `<table:table-cell office:value-type="date" office:date-value="${isoDate}+00:00"><text:p>${isoDate}</text:p></table:table-cell>`;
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Ref'], ['MAIN_DATE', 1, 'x'], ['', 2, 'MAIN_REF'], ['2026-09-29', 3, 'y']],
    source: [['Date', 'Credit', 'Ref'], ['2026-09-26', 2, 'SRC_REF']],
    replacements: { MAIN_DATE: tzDateCell('2026-09-25'), MAIN_REF: tzDateCell('2026-09-25'), SRC_REF: tzDateCell('2026-09-28') }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Ref'],
    crossSheetBackfillRule: rule({ matchMode: 'exact', matchField: 'Ref', sourceMatchField: 'Ref' })
  });
  assert.equal(mapped[1][0], '2026-09-25');
  assert.deepEqual(mapped.crossSheetBackfillPatches, []);
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'no-source-row']]);
});

test('平面 OpenDocument 的识别不受根元素属性含 ODS MIME 字符串、UTF-16 编码、根开始标签很长影响：都按声明的 1904 基准换算', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'fods-variants.xls');
  const build = (transform) => {
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], [44831, 3, 'y']],
      source: [['Date', 'Credit']],
      replacements: {},
      nullDate: '1904-01-01',
      flat: true
    });
    fs.writeFileSync(filePath, transform(fs.readFileSync(filePath, 'utf8')));
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    })[1][0];
  };
  const addRootAttribute = (xml, attribute) => xml.replace('<office:document ', `<office:document ${attribute} `);
  assert.equal(build((xml) => addRootAttribute(xml, 'office:mimetype="application/vnd.oasis.opendocument.spreadsheet"')), '2026-09-28');
  assert.equal(build((xml) => Buffer.concat([Buffer.from([0xFF, 0xFE]),
    Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')])), '2026-09-28');
  assert.equal(build((xml) => addRootAttribute(xml, `xmlns:pad="urn:${'p'.repeat(70000)}"`)), '2026-09-28');
});

test('CSV 只启用跨 Sheet 回填（逐格标记）时不为整表逐行计算整行原文摘要；启用重复账单过滤时照旧带整行摘要', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'marks.csv');
  fs.writeFileSync(filePath, 'Date,In,Desc\n2026-09-25,1,x\n2026-09-26,2,=1+1\n');
  const rowLevelMarks = (options) => {
    let marks = null;
    readRowsWithMetadata(filePath, [], { ...options, onWorkbookRows: (rows) => { marks = rows.excelErrorCells; } });
    return [...marks.entries()].map(([rowIndex, rowMarks]) => [rowIndex, [...rowMarks.keys()]]);
  };
  assert.deepEqual(rowLevelMarks({ includeCellMarks: true }), [[2, [2]]], '只留落在单元格上的标记（公式）');
  assert.deepEqual(rowLevelMarks({ includeFullRows: true }), [[0, [-2]], [1, [-2]], [2, [-2, 2]]]);
});

// ---- v3.2.21 审查回归（第二十一轮）----

test('xlsx 的 ISO 日期单元格（t="d"）按整串校验：日期后另有内容时按无效日期拒绝（未启用回填同样如此），合法的时区后缀照常读取', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const build = async (isoText) => {
    const filePath = path.join(dir, `iso-${Buffer.from(isoText).toString('hex')}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['ISO', 1, 'x']], source: [['Date', 'Credit']] });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', xml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, `<c r="A2" t="d"><v>${isoText}</v></c>`));
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return () => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
  };
  // 第二十二轮：时间之后另有内容（文本日期解析会去掉时间及其后内容）、时区超出范围同样无效；报错显示单元格原文
  for (const broken of ['2026-09-25Tbroken', '2026-09-25T12:30:00oops', '2026-09-25 12:30:00 (garbage)',
    '2026-09-25T12:30:00+02:60', '2026-09-25T12:30:00+99:99', '2026-09-25T12:30:00+24:00']) {
    assert.throws(await build(broken), (error) => /账单日期存在无效值/.test(error.message) && error.message.includes(`「${broken}」`), broken);
  }
  for (const valid of ['2026-09-25T12:30:00Z', '2026-09-25T12:30:00+08:00', '2026-09-25', '2026-09-25T12:30:00-0830',
    '2026-09-25T12:30:00+23:59', '2026-09-25T23:59:59-12']) {
    assert.equal((await build(valid))()[1][0], '2026-09-25', valid);
  }
});

test('不在 OLE2 容器中的二进制工作簿（BIFF2/3/4）与根开始标签很长的平面 OpenDocument：带时分的原生日期序号同样取日期部分', (t) => {
  const dir = makeTempDir(t);
  const map = (filePath) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  })[1][0];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'In', 'Desc'], [46290.5, 1, 'x']]), 'Sheet1');
  for (const bookType of ['biff2', 'biff3', 'biff4', 'biff8']) {
    const filePath = path.join(dir, `native-${bookType}.xls`);
    fs.writeFileSync(filePath, XLSX.write(workbook, { type: 'buffer', bookType }));
    assert.equal(map(filePath), '2026-09-25', bookType);
  }
  const fodsPath = path.join(dir, 'long-root.xls');
  writeOdsStatement(fodsPath, { main: [['Date', 'In', 'Desc'], [46290.5, 1, 'x']], source: [['Date', 'Credit']], replacements: {}, flat: true });
  fs.writeFileSync(fodsPath, fs.readFileSync(fodsPath, 'utf8')
    .replace('<office:document ', `<office:document xmlns:pad="urn:${'p'.repeat(70000)}" `));
  assert.equal(map(fodsPath), '2026-09-25');
});

test('只启用重复账单过滤时不构造跨 Sheet 回填用的逐格标记与不可写区域；启用回填时照常提供', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'marks.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['2026-09-26', 2, 'y']], source: [['Date', 'Credit']],
    merges: ['C2:C3'] });
  const duplicateOnly = readRowsWithMetadata(filePath, [], { includeFullRows: true, blankUncachedFormulas: true });
  assert.equal(duplicateOnly.cellMarks, undefined);
  assert.equal(duplicateOnly.unwritableRanges, undefined);
  assert.ok(Array.isArray(duplicateOnly.fullRows));
  // 读取层：只为重复账单过滤标记时不扫描合并单元格等不可写区域
  const rawRangesOf = (options) => {
    let ranges = null;
    readRowsWithMetadata(filePath, [], { ...options, onWorkbookRows: (rows) => { ranges = rows.unwritableRanges; } });
    return ranges;
  };
  assert.deepEqual(rawRangesOf({ includeFullRows: true }), []);
  assert.equal(rawRangesOf({ includeCellMarks: true }).length, 1);
  const backfill = readRowsWithMetadata(filePath, [], { includeCellMarks: true });
  assert.ok(backfill.cellMarks instanceof Map);
  assert.deepEqual(backfill.unwritableRanges.map((range) => [range.s.r, range.s.c, range.e.r, range.e.c]), [[1, 2, 2, 2]]);
});

// ---- v3.2.21 审查回归（第二十二轮）----

test('首行是标题、不含分隔符的分隔符文本 .xls：读取库按本机时区推断的带小数序号不取日期部分，按无效值拒绝，不把交易记到前一天', (t) => {
  withTimeZone(t, 'America/Los_Angeles');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'title-row.xls');
  fs.writeFileSync(filePath, 'Statement\nDate,In,Desc\n2026-09-25,1,x\n');
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  }), /账单日期存在无效值/);
});

test('ISO 来源日期带多余内容或时区超出范围时同样按「来源日期无法识别」跳过该行，不按日期前缀回填', async (t) => {
  const dir = makeTempDir(t);
  for (const isoText of ['2026-09-26 12:30:00 (garbage)', '2026-09-26T00:00:00+02:60', '2026-09-26T00:00:00+99:99']) {
    const filePath = path.join(dir, `iso-garbage-${Buffer.from(isoText).toString('hex')}.xlsx`);
    writeWorkbook(filePath, {
      main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
      source: [['Date', 'Credit'], ['ISO', 65.45]]
    });
    await setSourceIsoDate(filePath, isoText);
    const mapped = buildIsoSourceMapped(filePath);
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'source-date-invalid']], isoText);
    assert.deepEqual(mapped.slice(1).map((row) => row[0]), ['2026-09-25'], isoText);
  }
});

// ---- v3.2.21 审查回归（第二十三轮）----

test('xlsx 工作表原文中注释里的旧单元格（同坐标的 ISO 日期）不算：普通导入的收入仍是读取库读到的银行原值', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'commented-cell.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['ISO', 100, 'x']], source: [['Date', 'Credit']] });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const stale = '<row r="2"><c r="B2" t="d"><v>2026-09-25</v></c></row>';
  const next = xml
    .replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, '<c r="A2" t="d"><v>2026-09-24</v></c>')
    .replace(/(<sheetData>)/, `$1<!-- ${stale} -->`)
    .replace('</sheetData>', `</sheetData><!-- ${stale} -->`);
  assert.equal((next.match(/<!-- <row/g) || []).length, 2);
  zip.file('xl/worksheets/sheet1.xml', next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-24', '100']]);
});

test('ODS 自闭合单元格（日期只写在 office:date-value、金额只写在 office:value）按原值读取：不当成空单元格，跨 Sheet 回填不改写已有日期、不占用来源行', (t) => {
  withTimeZone(t, 'America/Los_Angeles');
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-self-closing-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 'MAIN_IN', 'Trade - $65.45'], ['', 3, 'Trade - $65.45']],
      source: [['Date', 'Credit'], ['2026-09-28', 65.45]],
      replacements: {
        MAIN_DATE: '<table:table-cell office:value-type="date" office:date-value="2026-09-22"/>',
        MAIN_IN: '<table:table-cell office:value-type="float" office:value="65.45"/>'
      },
      flat
    });
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc'],
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-22', '65.45'], ['2026-09-28', '3']], `flat=${flat}`);
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet-backfill-skipped')), [], `flat=${flat}`);
  }
});

test('ODS 日期基准只取生效的 table:calculation-settings：注释中的旧设置、其他命名空间的同名元素不算', (t) => {
  const dir = makeTempDir(t);
  const injections = {
    comment: '<!-- <table:calculation-settings><table:null-date table:date-value="1904-01-01"/></table:calculation-settings> -->',
    foreign: '<x:calculation-settings xmlns:x="urn:example:other"><x:null-date x:date-value="1904-01-01"/></x:calculation-settings>'
  };
  for (const flat of [false, true]) {
    Object.entries(injections).forEach(([label, injection]) => {
      const filePath = path.join(dir, `ods-null-date-${label}-${flat ? 'flat' : 'zip'}.xls`);
      writeOdsStatement(filePath, { main: [['Date', 'In', 'Desc'], [46290, 1, 'x']], source: [['Date', 'Credit']], replacements: {}, flat });
      const zipped = !flat;
      if (zipped) {
        const container = XLSX.CFB.read(fs.readFileSync(filePath), { type: 'buffer' });
        const content = XLSX.CFB.find(container, 'content.xml');
        content.content = Buffer.from(Buffer.from(content.content).toString('utf8')
          .replace('<office:spreadsheet>', `<office:spreadsheet>${injection}`), 'utf8');
        fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
      } else {
        fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('<office:spreadsheet>', `<office:spreadsheet>${injection}`));
      }
      const mapped = buildMappedRows({
        inputFilePath: filePath,
        orderedTargetFields: ['BillDate', 'Credit Amount'],
        mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
        expectedSourceHeaders: ['Date', 'In', 'Desc']
      });
      assert.equal(mapped[1][0], '2026-09-25', `${label} flat=${flat}`);
    });
  }
});

test('文本推断判断复用读取时已知的格式：普通 CSV 导入只读一次文件；读取结果带出是否为推断值', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const csvPath = path.join(dir, 'plain.csv');
  fs.writeFileSync(csvPath, 'Date,In,Desc\n2026-09-25,1,x\n');
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function countedRead(target, ...rest) {
    if (String(target) === csvPath) reads += 1;
    return originalRead.call(this, target, ...rest);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const mapped = buildMappedRows({
    inputFilePath: csvPath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  fs.readFileSync = originalRead;
  assert.equal(reads, 1);
  assert.equal(mapped[1][0], '2026-09-25');
  assert.equal(readRowsWithMetadata(csvPath, ['Date', 'In', 'Desc'], { exactIsoDates: true }).textInferredValues, true);
  const xlsxPath = path.join(dir, 'native.xlsx');
  writeWorkbook(xlsxPath, { main: [['Date', 'In', 'Desc'], [46290.5, 1, 'x']], source: [['Date', 'Credit']] });
  assert.equal(readRowsWithMetadata(xlsxPath, ['Date', 'In', 'Desc'], { exactIsoDates: true }).textInferredValues, false);
});

// ---- v3.2.21 审查回归（第二十四轮）----

test('原生日期单元格（t="d"）的原文不是存在的日期时（2026/02/30、2026-2-30）按无效日期处理，不用读取库滚入下月的序号；一位数月日与 / 分隔的合法写法按原文换算', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const build = async (dateText) => {
    const filePath = path.join(dir, `native-${Buffer.from(dateText).toString('hex')}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['ISO', 1, 'x']], source: [['Date', 'Credit']] });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const next = sheetXml.replace(/<c r="A2"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/, `<c r="A2" t="d"><v>${dateText}</v></c>`);
    assert.notEqual(next, sheetXml);
    zip.file('xl/worksheets/sheet1.xml', next);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
  };
  for (const invalid of ['2026/02/30', '2026-2-30', '2026/02-28', 'Sep 25 2026']) {
    await assert.rejects(build(invalid), /账单日期|BillDate|无效/, invalid);
  }
  assert.equal((await build('2026/9/25'))[1][0], '2026-09-25');
  assert.equal((await build('2026-9-5 13:30:00'))[1][0], '2026-09-05');
});

test('来源表原生日期单元格（t="d"）的原文不是存在的日期时按「来源日期无法识别」跳过，不按滚入下月的日期回填', async (t) => {
  const dir = makeTempDir(t);
  for (const dateText of ['2026/02/30', '2026-2-30']) {
    const filePath = path.join(dir, `native-source-${Buffer.from(dateText).toString('hex')}.xlsx`);
    writeWorkbook(filePath, {
      main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
      source: [['Date', 'Credit'], ['ISO', 65.45]]
    });
    await setSourceIsoDate(filePath, dateText);
    const mapped = buildIsoSourceMapped(filePath);
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'source-date-invalid']], dateText);
  }
});

test('ODS 日期基准属性按命名空间识别：其他命名空间的 date-value 写在前面也不算；表格命名空间的前缀被局部重绑定时报错，不按任一绑定猜测', (t) => {
  const dir = makeTempDir(t);
  const settings = {
    foreignFirst: '<table:calculation-settings xmlns:x="urn:example:other"><table:null-date x:date-value="1904-01-01" table:date-value="1899-12-30"/></table:calculation-settings>',
    rebound: '<table:calculation-settings><table:null-date xmlns:table="urn:example:other" table:date-value="1904-01-01"/></table:calculation-settings>'
  };
  for (const flat of [false, true]) {
    const build = (label) => {
      const filePath = path.join(dir, `ods-null-date-attr-${label}-${flat ? 'flat' : 'zip'}.xls`);
      writeOdsStatement(filePath, { main: [['Date', 'In', 'Desc'], [46290, 1, 'x']], source: [['Date', 'Credit']], replacements: {}, flat });
      const inject = (xml) => xml.replace('<office:spreadsheet>', `<office:spreadsheet>${settings[label]}`);
      if (flat) {
        fs.writeFileSync(filePath, inject(fs.readFileSync(filePath, 'utf8')));
      } else {
        const container = XLSX.CFB.read(fs.readFileSync(filePath), { type: 'buffer' });
        const content = XLSX.CFB.find(container, 'content.xml');
        content.content = Buffer.from(inject(Buffer.from(content.content).toString('utf8')), 'utf8');
        fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
      }
      return buildMappedRows({
        inputFilePath: filePath,
        orderedTargetFields: ['BillDate', 'Credit Amount'],
        mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
        expectedSourceHeaders: ['Date', 'In', 'Desc']
      });
    };
    assert.equal(build('foreignFirst')[1][0], '2026-09-25', `flat=${flat}`);
    assert.throws(() => build('rebound'), /日期基准/, `flat=${flat}`);
  }
});

test('ODS 值只在属性上的单元格：重复列（table:number-columns-repeated）的每个位置、开闭标签之间没有文字的单元格都按原值读取；布尔 1 / 0 与带天数的时长按值类型还原', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-attribute-values-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'Ref', 'Ref2', 'Flag', 'Span'], ['2026-09-25', 'REPEATED', 'Y', 'FLAG', 'SPAN'], ['2026-09-26', 'EMPTY_BODY', 'z', 'z', 'z']],
      source: [['Date', 'Credit']],
      replacements: {
        REPEATED: '<table:table-cell office:value-type="string" office:string-value="00123" table:number-columns-repeated="2"/>',
        FLAG: '<table:table-cell office:value-type="boolean" office:boolean-value="1"/>',
        SPAN: '<table:table-cell office:value-type="time" office:time-value="P1DT2H"/>',
        EMPTY_BODY: '<table:table-cell office:value-type="string" office:string-value="00456"></table:table-cell>'
      },
      flat
    });
    const xml = flat ? fs.readFileSync(filePath, 'utf8') : null;
    if (flat) {
      // 重复列占了两格：去掉被占位的 Y 单元格，使后面的列对齐
      fs.writeFileSync(filePath, xml.replace('<table:table-cell office:value-type="string"><text:p>Y</text:p></table:table-cell>', ''));
    } else {
      const container = XLSX.CFB.read(fs.readFileSync(filePath), { type: 'buffer' });
      const content = XLSX.CFB.find(container, 'content.xml');
      content.content = Buffer.from(Buffer.from(content.content).toString('utf8')
        .replace('<table:table-cell office:value-type="string"><text:p>Y</text:p></table:table-cell>', ''), 'utf8');
      fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
    }
    const { rows } = readRowsWithMetadata(filePath, ['Date', 'Ref', 'Ref2', 'Flag', 'Span'], { exactIsoDates: true });
    assert.deepEqual(rows[1].slice(1, 4), ['00123', '00123', true], `flat=${flat}`);
    assert.ok(Math.abs(rows[1][4] - 26 / 24) < 1e-9, `flat=${flat}`);
    assert.equal(rows[2][1], '00456', `flat=${flat}`);
  }
});

// ---- v3.2.21 审查回归（第二十五轮）----

test('ODS 单元格的金额按 office 命名空间的属性读取：扩展属性 x:value 不论写在前后都不算，自闭合与带显示文本的单元格都读出标准值', (t) => {
  const dir = makeTempDir(t);
  const cells = {
    selfForeignFirst: '<table:table-cell xmlns:x="urn:example:other" office:value-type="float" x:value="99" office:value="100"/>',
    selfOfficeFirst: '<table:table-cell xmlns:x="urn:example:other" office:value-type="float" office:value="100" x:value="99"/>',
    textOfficeFirst: '<table:table-cell xmlns:x="urn:example:other" office:value-type="float" office:value="100" x:value="99"><text:p>100</text:p></table:table-cell>',
    textForeignType: '<table:table-cell xmlns:x="urn:example:other" office:value-type="float" office:value="100" x:value-type="string"><text:p>100</text:p></table:table-cell>'
  };
  for (const flat of [false, true]) {
    Object.entries(cells).forEach(([label, cellXml]) => {
      const filePath = path.join(dir, `ods-foreign-${label}-${flat ? 'flat' : 'zip'}.xls`);
      writeOdsStatement(filePath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 'AMOUNT', 'x']], source: [['Date', 'Credit']], replacements: { AMOUNT: cellXml }, flat });
      const mapped = buildMappedRows({
        inputFilePath: filePath,
        orderedTargetFields: ['BillDate', 'Credit Amount'],
        mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
        expectedSourceHeaders: ['Date', 'In', 'Desc']
      });
      assert.deepEqual(mapped[1].slice(0, 2), ['2026-09-25', '100'], `${label} flat=${flat}`);
    });
  }
});

test('ODS 表尾整行都是只写在属性上的文本格时，读取库没有计入范围的行同样读出，不只返回表头', (t) => {
  const { readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  const stringCell = (text) => `<table:table-cell office:value-type="string" office:string-value="${text}"/>`;
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-tail-rows-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['R1A', 'R1B', 'R1C'], ['R2A', 'R2B', 'R2C']],
      source: [['Date', 'Credit']],
      replacements: {
        R1A: stringCell('2026-09-25'), R1B: stringCell('100'), R1C: stringCell('x'),
        R2A: stringCell('2026-09-26'), R2B: stringCell('200'), R2C: stringCell('y')
      },
      flat
    });
    const { rows } = readRowsWithMetadata(filePath, ['Date', 'In', 'Desc'], { exactIsoDates: true });
    assert.deepEqual(rows.slice(1), [['2026-09-25', '100', 'x'], ['2026-09-26', '200', 'y']], `flat=${flat}`);
  }
});

test('xlsx 的日期系统按工作簿根元素下实际生效的 workbookPr：注释中的旧配置、扩展区中其他命名空间的同名元素不算', async (t) => {
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const variants = {
    commented: (xml) => xml.replace(/<workbookPr\b[^>]*\/>/, '<!-- <workbookPr date1904="1"/> --><workbookPr/>'),
    extension: (xml) => xml.replace(/<workbookPr\b[^>]*\/>/, '<workbookPr/>').replace('</workbook>',
      '<extLst><ext uri="urn:example"><x15:workbookPr xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" date1904="1"/></ext></extLst></workbook>')
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const filePath = path.join(dir, `workbook-pr-${label}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], [46290, 1, 'x']], source: [['Date', 'Credit']] });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    const next = mutate(workbookXml);
    assert.notEqual(next, workbookXml, label);
    zip.file('xl/workbook.xml', next);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
    assert.equal(mapped[1][0], '2026-09-25', label);
  }
});

// ---- v3.2.21 审查回归（第二十六轮）----

async function rewriteZipEntry(filePath, entryName, mutate) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const original = await zip.file(entryName).async('string');
  const next = mutate(original);
  assert.notEqual(next, original, entryName);
  zip.file(entryName, next);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

test('xlsx 工作簿关系中有被注释的旧关系（同一 Id 指向另一张表，写在生效关系之前或之后）时拒绝导入，不按读到的另一张表改写收入', async (t) => {
  const dir = makeTempDir(t);
  const stale = '<!-- <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/> -->';
  for (const position of ['before', 'after']) {
    const filePath = path.join(dir, `stale-relationship-${position}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 20, 'x']], source: [['Date', 'Credit'], ['2026-09-10', 1]] });
    await rewriteZipEntry(filePath, 'xl/_rels/workbook.xml.rels', (xml) => (position === 'before'
      ? xml.replace('<Relationship ', `${stale}<Relationship `)
      : xml.replace('</Relationships>', `${stale}</Relationships>`)));
    assert.throws(() => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    }), /工作簿结构/, position);
  }
});

test('ODS 文本格只写在 office:string-value 上的连续空格原样保留（REF  123 不折成 REF 123）；行尾重复的空文本不展开成数据列', (t) => {
  const { readRowsWithMetadata, scanOdsWorkbookCells } = require('../../../../src/backend/file-service/readers');
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-spaces-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'REF']],
      source: [['Date', 'Credit']],
      replacements: {
        REF: '<table:table-cell office:value-type="string" office:string-value="REF  123"/>'
          + '<table:table-cell office:value-type="string" office:string-value="" table:number-columns-repeated="1000"/>'
      },
      flat
    });
    const { rows } = readRowsWithMetadata(filePath, ['Date', 'In', 'Desc'], { exactIsoDates: true });
    assert.equal(rows[1][2], 'REF  123', `flat=${flat}`);
    const scanned = scanOdsWorkbookCells(filePath, { sheetNames: ['MAIN'], isoDates: true }).get('MAIN');
    assert.equal(scanned.valueCells.length, 1, `flat=${flat}`);
  }
});

test('ODS 日期单元格被扩展命名空间的 value-type="string" 误读成显示文本时，按标准日期属性取原日期', (t) => {
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-date-foreign-type-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x']],
      source: [['Date', 'Credit']],
      replacements: {
        MAIN_DATE: '<table:table-cell xmlns:other="urn:example:other" office:value-type="date" office:date-value="2026-09-10" other:value-type="string"><text:p>09/10/2026</text:p></table:table-cell>'
      },
      flat
    });
    for (const dateOrder of ['DMY', 'MDY']) {
      const mapped = buildMappedRows({
        inputFilePath: filePath,
        orderedTargetFields: ['BillDate', 'Credit Amount'],
        mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
        expectedSourceHeaders: ['Date', 'In', 'Desc'],
        dateParseOrder: dateOrder
      });
      assert.equal(mapped[1][0], '2026-09-10', `${dateOrder} flat=${flat}`);
    }
  }
});

test('mimetype 条目被压缩（开头没有明文 MIME）的 ODS 同样按 ODS 原文换算日期（西半球时区不早一天）', async (t) => {
  withTimeZone(t, 'America/Los_Angeles');
  const JSZip = require('jszip');
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-compressed-mimetype.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x']],
    source: [['Date', 'Credit']],
    replacements: { MAIN_DATE: odsDateCell('2026-09-10') }
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const recompressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.equal(recompressed.subarray(0, 512).toString('latin1').includes('application/vnd.oasis.opendocument.spreadsheet'), false);
  fs.writeFileSync(filePath, recompressed);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.equal(mapped[1][0], '2026-09-10');
});

// ---- v3.2.21 审查回归（第二十七轮）----

test('xlsx 日期系统按根元素及其直接子元素的命名空间解析：扩展区局部声明其他默认命名空间时，注释中的旧 date1904="1" 仍不生效；根元素命名空间无法识别时整份拒绝', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'local-namespace.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], [46290, 1, 'x']], source: [['Date', 'Credit']] });
  await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => xml
    .replace(/<workbookPr\b[^>]*\/>/, '<!-- <workbookPr date1904="1"/> --><workbookPr/>')
    .replace('</workbook>', '<extLst><ext uri="urn:example" xmlns="urn:example:other"><workbookPr date1904="1"/></ext></extLst></workbook>'));
  const map = (inputFilePath) => buildMappedRows({
    inputFilePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.equal(map(filePath)[1][0], '2026-09-25');
  const unknownPath = path.join(dir, 'unknown-namespace.xlsx');
  writeWorkbook(unknownPath, { main: [['Date', 'In', 'Desc'], [46290, 1, 'x']], source: [['Date', 'Credit']] });
  await rewriteZipEntry(unknownPath, 'xl/workbook.xml', (xml) => xml
    .replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns="urn:example:unknown"'));
  // 根元素命名空间无法识别时读取库先拒绝；读取侧的日期系统校验是兜底，两者都按整份拒绝处理
  assert.throws(() => map(unknownPath), /日期系统|不可读/);
});

test('ODS 自闭合单元格声明的合并范围（读取库不记入合并）中被覆盖的待回填格不能单独填写：该行跳过，不占用来源行', (t) => {
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-self-closing-merge-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Desc', 'In', 'Date'], ['x', 1, '2026-09-25'], ['Trade - $65.45', 'ANCHOR', 'COVERED']],
      source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
      replacements: {
        ANCHOR: '<table:table-cell office:value-type="float" office:value="2" table:number-columns-spanned="2"/>',
        COVERED: '<table:covered-table-cell/>'
      },
      flat
    });
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Desc', 'In', 'Date'],
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable']], `flat=${flat}`);
  }
});

// ---- v3.2.21 审查回归（第二十八轮）----

test('内容为 ODS、主表名含需转义字符（Cash & Bank）的账单（西半球时区，未启用回填的普通导入）：日期按原文不早一天，只写在属性上的日期不读成空', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-escaped-name-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      mainName: 'Cash & Bank',
      main: [['Date', 'In', 'Desc'], ['DATE_TEXT', 1, 'x'], ['DATE_ATTR', 2, 'y']],
      source: [['Date', 'Credit']],
      replacements: {
        DATE_TEXT: odsDateCell('2026-09-25'),
        DATE_ATTR: '<table:table-cell office:value-type="date" office:date-value="2026-09-26"/>'
      },
      flat
    });
    const rows = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc']
    });
    assert.deepEqual(rows.slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26'], `flat=${flat}`);
  }
});

test('ODS 自闭合数组公式（number-matrix-*-spanned）覆盖的从属格、以及锚点是无缓存公式的合并范围中被覆盖的格不能单独填写：该行跳过', (t) => {
  const dir = makeTempDir(t);
  const cases = [
    ['matrix', '<table:table-cell table:formula="of:=1+1" office:value-type="float" office:value="2" table:number-matrix-columns-spanned="2" table:number-matrix-rows-spanned="1"/>', '<table:table-cell/>'],
    ['matrix-columns-only', '<table:table-cell table:formula="of:=1+1" office:value-type="float" office:value="2" table:number-matrix-columns-spanned="2"><text:p>2</text:p></table:table-cell>', '<table:table-cell/>'],
    ['uncached-merge', '<table:table-cell table:formula="of:=1+1" table:number-columns-spanned="2"/>', '<table:covered-table-cell/>']
  ];
  for (const [label, anchor, covered] of cases) {
    for (const flat of [false, true]) {
      const filePath = path.join(dir, `ods-${label}-${flat ? 'flat' : 'zip'}.xls`);
      writeOdsStatement(filePath, {
        main: [['Desc', 'In', 'Note', 'Date'], ['x', 1, '', '2026-09-25'], ['Trade - $65.45', 3, 'ANCHOR', 'COVERED']],
        source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
        replacements: { ANCHOR: anchor, COVERED: covered },
        flat
      });
      const mapped = buildMappedRows({
        inputFilePath: filePath,
        orderedTargetFields: ['BillDate', 'Credit Amount'],
        mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
        expectedSourceHeaders: ['Desc', 'In', 'Note', 'Date'],
        crossSheetBackfillRule: rule()
      });
      assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
        .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable']], `${label} flat=${flat}`);
    }
  }
});

test('ODS 带合并范围的锚点本身是无缓存公式或公式错误、且在待回填列时，仍按公式识别：该行跳过，不当成空格回填', (t) => {
  const dir = makeTempDir(t);
  const anchors = {
    uncached: '<table:table-cell table:formula="of:=1+1" table:number-columns-spanned="2"/>',
    error: '<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="#DIV/0!" calcext:value-type="error" table:number-columns-spanned="2"/>'
  };
  for (const [label, anchor] of Object.entries(anchors)) {
    const filePath = path.join(dir, `ods-merged-formula-anchor-${label}.xls`);
    writeOdsStatement(filePath, {
      main: [['Desc', 'In', 'Date', 'Note'], ['x', 1, '2026-09-25', ''], ['Trade - $65.45', 3, 'ANCHOR', 'COVERED']],
      source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
      replacements: { ANCHOR: anchor, COVERED: '<table:covered-table-cell/>' }
    });
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Desc', 'In', 'Date', 'Note'],
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']], label);
  }
});

// ---- v3.2.21 审查回归（第二十九轮）----

test('内容为 ODS 的账单按工作簿中的实际表名选择来源 Sheet：Cash & Bank 能选中，另有字面名为 Cash &amp; Bank 的表时不会互相顶替', (t) => {
  const dir = makeTempDir(t);
  for (const flat of [false, true]) {
    const filePath = path.join(dir, `ods-source-name-${flat ? 'flat' : 'zip'}.xls`);
    writeOdsStatement(filePath, {
      main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
      sourceName: 'Cash & Bank',
      source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
      extraSheets: [['Cash &amp; Bank', [['Date', 'Credit'], ['2026-09-28', 65.45]]]],
      replacements: {},
      flat
    });
    const map = (sourceSheetName) => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In', 'Desc'],
      crossSheetBackfillRule: rule({ sourceSheetName })
    });
    assert.deepEqual(map('Cash & Bank').slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-26'], `flat=${flat}`);
    assert.deepEqual(map('Cash &amp; Bank').slice(1).map((row) => row[0]), ['2026-09-25', '2026-09-28'], `flat=${flat}`);
    assert.throws(() => map('Cash &amp;amp; Bank'), /没有名为「Cash &amp;amp; Bank」的 Sheet/, `flat=${flat}`);
  }
});

// ---- v3.2.21 审查回归（第三十轮）----

function writeXlmlStatement(filePath, { mainRows, sourceRows, utf16 = false }) {
  const xml = [
    `<?xml version="1.0" encoding="${utf16 ? 'UTF-16' : 'UTF-8'}"?>`,
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Worksheet ss:Name="MAIN"><Table>', ...mainRows.map((row) => `<Row>${row}</Row>`), '</Table></Worksheet>',
    '<Worksheet ss:Name="SRC"><Table>', ...sourceRows.map((row) => `<Row>${row}</Row>`), '</Table></Worksheet>',
    '</Workbook>'
  ].join('\n');
  fs.writeFileSync(filePath, utf16 ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]) : Buffer.from(xml, 'utf8'));
}
const xlmlCell = (type, value) => `<Cell><Data ss:Type="${type}">${value}</Data></Cell>`;
const XLML_SOURCE_ROWS = [
  `${xlmlCell('String', 'Date')}${xlmlCell('String', 'Credit')}`,
  `${xlmlCell('String', '2026-09-26')}${xlmlCell('Number', 65.45)}`
];

test('SpreadsheetML 2003 自闭合的合并单元格（读取库不按跨度定位、不记合并）：普通导入后面的单元格不左移；被覆盖的待回填格不能单独填写', (t) => {
  const dir = makeTempDir(t);
  for (const utf16 of [false, true]) {
    const alignedPath = path.join(dir, `xlml-merge-aligned-${utf16 ? 'utf16' : 'utf8'}.xls`);
    writeXlmlStatement(alignedPath, {
      utf16,
      mainRows: [
        `${xlmlCell('String', 'Date')}${xlmlCell('String', 'Note')}${xlmlCell('String', 'Extra')}${xlmlCell('String', 'In')}`,
        `${xlmlCell('String', '2026-09-25')}<Cell ss:MergeAcross="1"/>${xlmlCell('Number', 5)}`
      ],
      sourceRows: XLML_SOURCE_ROWS
    });
    const rows = buildMappedRows({
      inputFilePath: alignedPath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'Note', 'Extra', 'In']
    });
    assert.deepEqual(rows.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '5']], `utf16=${utf16}`);

    const mergedPath = path.join(dir, `xlml-merge-target-${utf16 ? 'utf16' : 'utf8'}.xls`);
    writeXlmlStatement(mergedPath, {
      utf16,
      mainRows: [
        `${xlmlCell('String', 'Desc')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Note')}${xlmlCell('String', 'Date')}`,
        `${xlmlCell('String', 'x')}${xlmlCell('Number', 1)}${xlmlCell('String', '')}${xlmlCell('String', '2026-09-25')}`,
        `${xlmlCell('String', 'Trade - $65.45')}${xlmlCell('Number', 2)}<Cell ss:MergeAcross="1"/>`
      ],
      sourceRows: XLML_SOURCE_ROWS
    });
    const mapped = buildMappedRows({
      inputFilePath: mergedPath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Desc', 'In', 'Note', 'Date'],
      crossSheetBackfillRule: rule()
    });
    assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
      .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable']], `utf16=${utf16}`);
  }
});

test('SpreadsheetML 2003 没有缓存结果的公式带批注（Comment 中的 Data）时仍按无缓存公式识别：该行跳过，不当成可填的空格', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-formula-comment.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Desc')}`,
      `${xlmlCell('String', '2026-09-25')}${xlmlCell('Number', 1)}${xlmlCell('String', 'x')}`,
      '<Cell ss:Formula="=TODAY()"><Comment ss:Author="ops"><ss:Data xmlns="http://www.w3.org/TR/REC-html40"><B>check</B></ss:Data></Comment></Cell>'
        + `${xlmlCell('Number', 2)}${xlmlCell('String', 'Trade - $65.45')}`
    ],
    sourceRows: XLML_SOURCE_ROWS
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
});

test('模板表头取自正式导入同一读取结果：1904 日期系统的 xlsx 表头含原生 ISO 日期时，建模板读到的表头与正式导入一致，能导入该文件自身', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'iso-header-1904.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'ISO_HEADER', 'In'], ['2026-09-25', 'x', 1]], source: [['Date', 'Credit']] });
  await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => (/<workbookPr\b/.test(xml)
    ? xml.replace(/<workbookPr\b/, '<workbookPr date1904="1"')
    : xml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>')));
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="B1"[^>]*>[\s\S]*?<\/c>/, '<c r="B1" t="d"><v>2026-09-25T00:00:00</v></c>'));
  const headers = readers.extractHeaders(filePath, { exactIsoDates: true });
  assert.equal(headers[1], String(readers.readRowsWithMetadata(filePath, [], { exactIsoDates: true }).rows[0][1]));
  assert.notEqual(headers[1], String(readers.extractHeaders(filePath)[1]), '前置：读取库原值与按工作簿日期系统换算的值不同');
  assert.doesNotThrow(() => readers.readRowsWithMetadata(filePath, headers, { exactIsoDates: true }));
});

test('内容为 ODS、只启用跨 Sheet 回填时读取主表不保留占位单元格（行尾重复空列会展开成大量占位）；xlsx 与启用查重时照旧保留', (t) => {
  const dir = makeTempDir(t);
  const odsPath = path.join(dir, 'ods-stubs.xls');
  writeOdsStatement(odsPath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
    replacements: {}
  });
  const xlsxPath = path.join(dir, 'xlsx-stubs.xlsx');
  writeWorkbook(xlsxPath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  const seen = [];
  const record = (options) => { if (options && options.bookFiles) seen.push(Boolean(options.sheetStubs)); };
  const originalRead = XLSX.read;
  const originalReadFile = XLSX.readFile;
  t.mock.method(XLSX, 'read', function read(data, options) { record(options); return originalRead.call(this, data, options); });
  t.mock.method(XLSX, 'readFile', function readFile(file, options) { record(options); return originalReadFile.call(this, file, options); });
  const mainOptions = (sourcePath) => {
    seen.length = 0;
    readers.readRowsWithMetadata(sourcePath, ['Date', 'In', 'Desc'], { exactIsoDates: true, includeCellMarks: true, onlyTargetSheet: true });
    return seen[0];
  };
  assert.equal(mainOptions(odsPath), false);
  assert.equal(mainOptions(xlsxPath), true);
  seen.length = 0;
  readers.readRowsWithMetadata(odsPath, ['Date', 'In', 'Desc'], { exactIsoDates: true, includeCellMarks: true, includeFullRows: true });
  assert.equal(seen[0], true, '启用查重时保留（查重按占位单元格核对公式，原有行为）');
});

test('回填告警带源文件路径（会话内区分不同目录下的同名账单）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'Statement.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $99.00']], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'cross-sheet-backfill-skipped')
    .map((issue) => [issue.sourceFileName, issue.sourceFilePath]), [['Statement.xlsx', filePath]]);
});

test('SpreadsheetML 2003 自闭合合并单元格后面的无缓存公式：原文扫描与主读取同一坐标，公式格按公式识别（该行跳过），不当成空格回填', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-merge-then-formula.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Desc')}${xlmlCell('String', 'Note')}${xlmlCell('String', 'Extra')}${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}`,
      `${xlmlCell('String', 'x')}${xlmlCell('String', '')}${xlmlCell('String', '')}${xlmlCell('String', '2026-09-25')}${xlmlCell('Number', 1)}`,
      `${xlmlCell('String', 'Trade - $65.45')}<Cell ss:MergeAcross="1"/><Cell ss:Formula="=TODAY()"/>${xlmlCell('Number', 2)}`
    ],
    sourceRows: XLML_SOURCE_ROWS
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Desc', 'Note', 'Extra', 'Date', 'In'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
});

// ---- v3.2.21 审查回归（第三十一轮）----

test('xlsx 公式的缓存结果写在 CDATA 中（<v><![CDATA[2]]></v>，读取库读出 2）：启用回填时按有缓存处理，不清空不需回填的交易金额', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'cdata-cached.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 3, 'Trade - $65.45']], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="B2"[^>]*>[\s\S]*?<\/c>/, '<c r="B2"><f>1+1</f><v><![CDATA[2]]></v></c>'));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '2'], ['2026-09-26', '3']]);
});

test('SpreadsheetML 2003 带时区偏移的 DateTime（读取库读成原文末尾加 Z 的文本）：主表与来源表的日期都按原文换算（时区不参与，24:00 为次日零点），不因读成文本跳过或错日', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-datetime-offset.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Desc')}`,
      `${xlmlCell('DateTime', '2026-09-25T24:00:00+00:00')}${xlmlCell('Number', 1)}${xlmlCell('String', 'x')}`,
      `${xlmlCell('String', '')}${xlmlCell('Number', 2)}${xlmlCell('String', 'Trade - $65.45')}`
    ],
    sourceRows: [
      `${xlmlCell('String', 'Date')}${xlmlCell('String', 'Credit')}`,
      `${xlmlCell('DateTime', '2026-09-27T12:00:00+02:00')}${xlmlCell('Number', 65.45)}`
    ]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet')).map((issue) => issue.reason), []);
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-26', '1'], ['2026-09-27', '2']]);
});

test('SpreadsheetML 2003 没有缓存结果的数组公式（ss:ArrayRange，读取库丢弃锚点、不记范围）：范围内的待回填格不能单独填写，该行跳过', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-array-uncached.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Note')}${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Desc')}`,
      `${xlmlCell('String', 'n')}${xlmlCell('String', '2026-09-25')}${xlmlCell('Number', 1)}${xlmlCell('String', 'x')}`,
      `<Cell ss:ArrayRange="RC:RC[1]" ss:Formula="=TODAY()"/><Cell ss:Index="3"><Data ss:Type="Number">2</Data></Cell>${xlmlCell('String', 'Trade - $65.45')}`
    ],
    sourceRows: XLML_SOURCE_ROWS
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Note', 'Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unwritable']]);
});

test('升级前保存的模板（表头含原生日期，当时按读取库原值保存）：1904 工作簿按原值定位表头仍能导入，表头行取原值（字段按表头名绑定），数据行照常', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'legacy-iso-header-1904.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'ISO_HEADER', 'In'], ['2026-09-25', 'x', 1], ['Date', 'ISO_HEADER', 'In'], ['2026-09-26', 'y', 2]], source: [['Date', 'Credit']] });
  await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => (/<workbookPr\b/.test(xml)
    ? xml.replace(/<workbookPr\b/, '<workbookPr date1904="1"')
    : xml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>')));
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml
    .replace(/<c r="B1"[^>]*>[\s\S]*?<\/c>/, '<c r="B1" t="d"><v>2026-09-25T00:00:00</v></c>')
    .replace(/<c r="B3"[^>]*>[\s\S]*?<\/c>/, '<c r="B3" t="d"><v>2026-09-25T00:00:00</v></c>'));
  const legacyHeaders = readers.extractHeaders(filePath);
  assert.notDeepEqual(legacyHeaders, readers.extractHeaders(filePath, { exactIsoDates: true }), '前置：原值与换算后的值不同');
  const headerRowNumbers = [];
  const read = readers.readRowsWithMetadata(filePath, legacyHeaders, {
    exactIsoDates: true, onWorkbookRows: (_rawRows, facts) => headerRowNumbers.push(...facts.headerRowNumbers)
  });
  assert.deepEqual(read.rows.map((row) => row.map((cell) => String(cell))), [legacyHeaders, ['2026-09-25', 'x', '1'], ['2026-09-26', 'y', '2']]);
  assert.deepEqual(read.headerBreaks, [3]);
  assert.deepEqual(headerRowNumbers, [1, 3], '正式映射命中的各分段表头行号交给大账号识别');
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Remark'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', Remark: legacyHeaders[1] },
    expectedSourceHeaders: legacyHeaders
  });
  assert.deepEqual(mapped.slice(1), [['2026-09-25', '1', 'x'], ['2026-09-26', '2', 'y']]);
});

test('跨 Sheet 回填核对来源 Sheet 时复用主表读取的格式判断：普通 xlsx 不为判断是否 ODS 再整份读取文件；ODS 的表名照常核对', (t) => {
  const dir = makeTempDir(t);
  const xlsxPath = path.join(dir, 'plain.xlsx');
  writeWorkbook(xlsxPath, { main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']], source: [['Date', 'Credit'], ['2026-09-26', 65.45]] });
  const odsPath = path.join(dir, 'plain-ods.xls');
  writeOdsStatement(odsPath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'Trade - $65.45']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
    replacements: {}
  });
  const originalReadFileSync = fs.readFileSync;
  const odsLoads = [];
  t.mock.method(fs, 'readFileSync', function readFileSync(...args) {
    if (/\bloadOdsContent\b/.test(String(new Error().stack))) odsLoads.push(path.basename(String(args[0])));
    return originalReadFileSync.apply(this, args);
  });
  const mappedOf = (inputFilePath) => buildMappedRows({
    inputFilePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mappedOf(xlsxPath).slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-26', '2']]);
  assert.deepEqual(odsLoads, []);
  assert.deepEqual(mappedOf(odsPath).slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-26', '2']]);
  assert.deepEqual(odsLoads, ['plain-ods.xls', 'plain-ods.xls'], 'ODS 只在读主表、读来源表时各载入一次，核对来源 Sheet 的表名时复用主表读取的结果');
});

// ---- v3.2.21 审查回归（第三十二轮）----

const set1904 = (xml) => (/<workbookPr\b/.test(xml)
  ? xml.replace(/<workbookPr\b/, '<workbookPr date1904="1"')
  : xml.replace(/(<workbook\b[^>]*>)/, '$1<workbookPr date1904="1"/>'));

test('升级前保存的模板：首段表头只按原值命中、后一段表头按数值直接存了同一原值时，按物理行序取首段，两段交易都不漏', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'legacy-mixed-headers.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'ISO_HEADER', 'In'], ['2026-09-25', 'x', 1], ['Date', 'LATER', 'In'], ['2026-09-26', 'y', 2]], source: [['Date', 'Credit']] });
  await rewriteZipEntry(filePath, 'xl/workbook.xml', set1904);
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="B1"[^>]*>[\s\S]*?<\/c>/, '<c r="B1" t="d"><v>2026-09-25T00:00:00</v></c>'));
  const legacyHeaders = readers.extractHeaders(filePath);
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="B3"[^>]*>[\s\S]*?<\/c>/, `<c r="B3"><v>${legacyHeaders[1]}</v></c>`));
  assert.notEqual(String(readers.readRowsWithMetadata(filePath, [], { exactIsoDates: true }).rows[0][1]), legacyHeaders[1], '前置：首段表头按原文换算后与原值不同');
  const headerRowNumbers = [];
  const read = readers.readRowsWithMetadata(filePath, legacyHeaders, {
    exactIsoDates: true, onWorkbookRows: (_rawRows, facts) => headerRowNumbers.push(...facts.headerRowNumbers)
  });
  assert.deepEqual(read.rowNumbers, [1, 2, 4]);
  assert.deepEqual(read.headerBreaks, [3]);
  assert.deepEqual(headerRowNumbers, [1, 3]);
  assert.deepEqual(read.rows.map((row) => row.map((cell) => String(cell))), [legacyHeaders, ['2026-09-25', 'x', '1'], ['2026-09-26', 'y', '2']]);
});

test('内容为 ODS 的账单：单元格前的 XML 注释中写有 <table:table-cell> 时，逐格扫描不从注释开始匹配，紧随其后的日期格照常按原文换算（西半球时区不早一天）', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-comment-cell.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['MAIN_DATE', 1, 'x']],
    source: [['Date', 'Credit']],
    replacements: { MAIN_DATE: `<!-- e.g. <table:table-cell> -->${odsDateCell('2026-09-25')}` }
  });
  const rows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc']
  });
  assert.deepEqual(rows.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1']]);
});

test('SpreadsheetML 2003：单元格前的 XML 注释中写有 <Cell> 时，逐格扫描不从注释开始匹配，紧随其后的无缓存公式照常识别（该行跳过）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-comment-cell.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Desc')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Date')}`,
      `${xlmlCell('String', 'x')}${xlmlCell('Number', 1)}${xlmlCell('String', '2026-09-25')}`,
      `${xlmlCell('String', 'Trade - $65.45')}${xlmlCell('Number', 2)}<!-- e.g. <Cell> --><Cell ss:Formula="=TODAY()"/>`
    ],
    sourceRows: XLML_SOURCE_ROWS
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Desc', 'In', 'Date'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
});

test('xlsx 的 date1904 按 XML Schema 布尔值解析：首尾空白不改变含义；无法识别的取值拒绝导入，不静默按 1900', async (t) => {
  const dir = makeTempDir(t);
  const read = async (value) => {
    const filePath = path.join(dir, `date1904-${encodeURIComponent(value)}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'In'], [44828, 1]], source: [['Date', 'Credit']] });
    await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => set1904(xml).replace('date1904="1"', `date1904="${value}"`));
    return () => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
      expectedSourceHeaders: ['Date', 'In']
    }).slice(1).map((row) => row.slice(0, 2));
  };
  for (const value of ['1', 'true', ' true ', '\n1\t']) {
    assert.deepEqual((await read(value))(), [['2026-09-25', '1']], JSON.stringify(value));
  }
  for (const value of [' 0 ', 'false']) {
    assert.deepEqual((await read(value))(), [['2022-09-24', '1']], JSON.stringify(value));
  }
  assert.throws(await read('yes'), /无法确定日期系统/);
});

test('ODS 只写在属性上的文本：属性值中的字面 CRLF 按 XML 规范化为一个空格（PO 123），不读成两个空格', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-crlf-attribute.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'MAIN_DESC']],
    source: [['Date', 'Credit']],
    replacements: { MAIN_DESC: '<table:table-cell office:value-type="string" office:string-value="PO\r\n123\rA\tB&#10;C"/>' }
  });
  const read = readers.readRowsWithMetadata(filePath, ['Date', 'In', 'Desc'], { exactIsoDates: true });
  assert.equal(read.rows[1][2], 'PO 123 A B\nC');
});

test('Workbook 根元素前有很长的 XML 注释的 SpreadsheetML 2003 不按网页表格（HTML）拒绝', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-long-comment.xls');
  writeXlmlStatement(filePath, {
    mainRows: [`${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}`, `${xlmlCell('String', '2026-09-25')}${xlmlCell('Number', 1)}`],
    sourceRows: XLML_SOURCE_ROWS
  });
  const text = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, text.replace('<Workbook', `<!-- ${'x'.repeat(8000)} -->\n<Workbook`));
  assert.equal(readers.isHtmlWorkbookFile(filePath), false);
  const htmlPath = path.join(dir, 'page.xls');
  fs.writeFileSync(htmlPath, `<!-- ${'x'.repeat(8000)} -->\n<html><body><table><tr><td>Date</td></tr></table></body></html>`);
  assert.equal(readers.isHtmlWorkbookFile(htmlPath), true);
});

// ---- v3.2.21 审查回归（第三十三轮）----

function rewriteOdsContent(filePath, mutate) {
  const container = XLSX.CFB.read(fs.readFileSync(filePath), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const xml = Buffer.from(content.content).toString('utf8');
  const next = mutate(xml);
  assert.notEqual(next, xml);
  content.content = Buffer.from(next, 'utf8');
  fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
}

test('查重指纹按映射实际采用的日期系统：同一序号在 date1904="0" 与 date1904=" true " 的两份账单中是不同日期，不互判重复', async (t) => {
  const dir = makeTempDir(t);
  const keyOf = async (value) => {
    const filePath = path.join(dir, `dup-date1904-${encodeURIComponent(value)}.xlsx`);
    writeWorkbook(filePath, { main: [['Date', 'ValueDate', 'In'], ['2026-09-25', 44800, 1]], source: [['Date', 'Credit']] });
    await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => set1904(xml).replace('date1904="1"', `date1904="${value}"`));
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Credit Amount', 'ValueDate'],
      mappingByField: { BillDate: 'Date', 'Credit Amount': 'In', ValueDate: 'ValueDate' },
      expectedSourceHeaders: ['Date', 'ValueDate', 'In'],
      duplicateRowKeys: true
    });
    assert.ok(mapped.rowMetas[0].sourceRowKey, value);
    return mapped.rowMetas[0].sourceRowKey;
  };
  const key1900 = await keyOf('0');
  assert.notEqual(await keyOf(' true '), key1900);
  assert.equal(await keyOf(' true '), await keyOf('1'));
});

test('内容为 ODS 的账单：文本中形似 Excel 转义码的 _x0041_ 按 ODF 原文读取（字面文字），按原值配对时不与 RefA 配成一对', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-escape-like-text.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'RefA']],
    source: [['Date', 'Ref'], ['2026-09-26', 'SRC_ESCAPED'], ['2026-09-27', 'RefA']],
    replacements: { SRC_ESCAPED: '<table:table-cell office:value-type="string"><text:p>Ref_x0041_</text:p></table:table-cell>' }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule({ matchMode: 'exact', sourceMatchField: 'Ref' })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-27', '2']]);
  const source = readers.readRowsWithMetadata(filePath, [], { sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true });
  assert.deepEqual(source.rows.map((row) => row[1]), ['Ref', 'Ref_x0041_', 'RefA']);
});

test('内容为 ODS 的账单：被合并覆盖的单元格带重复计数、自闭合的重复空行时，后面的单元格与行按实际坐标读取（不左移、不上移）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-covered-repeated.xls');
  writeOdsStatement(filePath, {
    main: [['A', 'B', 'C', 'D', 'E'], ['P1', 'X1', 'Y1', 65.45, 'e'], ['P2']],
    source: [['Date', 'Credit']],
    replacements: {
      P1: '<table:table-cell office:value-type="string" table:number-columns-spanned="3"><text:p>P1</text:p></table:table-cell>',
      X1: '<table:covered-table-cell table:number-columns-repeated="2"/>',
      Y1: ''
    }
  });
  rewriteOdsContent(filePath, (xml) => {
    const at = xml.lastIndexOf('<table:table-row', xml.indexOf('<text:p>P2</text:p>'));
    return `${xml.slice(0, at)}<table:table-row table:number-rows-repeated="3"/>${xml.slice(at)}`;
  });
  const read = readers.readRowsWithMetadata(filePath, ['A', 'B', 'C', 'D', 'E'], { exactIsoDates: true });
  assert.deepEqual(read.rowNumbers, [1, 2, 6]);
  assert.deepEqual(read.rows.slice(1).map((row) => row.slice(0, 5)), [['P1', '', '', 65.45, 'e'], ['P2', '', '', '', '']]);
});

test('内容为 ODS 的账单：待回填格是结果为空文本的公式（value-type="string"、空的 string-value、没有显示段落，读取库整格丢弃）时按没有结果的公式跳过，不覆盖银行公式', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-empty-string-formula.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['MAIN_FORMULA', 2, 'Trade - $65.45']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
    replacements: { MAIN_FORMULA: '<table:table-cell table:formula="of:=&quot;&quot;" office:value-type="string" office:string-value=""></table:table-cell>' }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
});

test('内容为 ODS 的账单：覆盖格带重复计数时，原文扫描与主读取同一改写，其后没有缓存结果的公式按实际坐标识别（该行跳过），不错标到前一列', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-covered-then-formula.xls');
  writeOdsStatement(filePath, {
    main: [['A', 'B', 'C', 'Date', 'In', 'Desc'], ['P1', 'n', 'm', '2026-09-25', 1, 'x'], ['P2', 'X2', 'Y2', 'MAIN_FORMULA', 2, 'Trade - $65.45']],
    source: [['Date', 'Credit'], ['2026-09-26', 65.45]],
    replacements: {
      P2: '<table:table-cell office:value-type="string" table:number-columns-spanned="3"><text:p>P2</text:p></table:table-cell>',
      X2: '<table:covered-table-cell table:number-columns-repeated="2"/>',
      Y2: '',
      MAIN_FORMULA: '<table:table-cell table:formula="of:=TODAY()"/>'
    }
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['A', 'B', 'C', 'Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
});

// ---- v3.2.21 审查回归（第三十四轮）----

test('1904 日期系统的 xlsx：表名中的字符引用只解码一次（A&#38;amp;B 即表名 A&amp;B），按原文找到工作表，t="d" 的日期不差四年', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'sheet-name-char-ref-1904.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In'], ['ISO', 1]], source: [['Date', 'Credit']] });
  await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => set1904(xml).replace('name="MAIN"', 'name="A&#38;amp;B"'));
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="A2"[^>]*>[\s\S]*?<\/c>/, '<c r="A2" t="d"><v>2026-09-25T00:00:00</v></c>'));
  assert.deepEqual(XLSX.readFile(filePath).SheetNames, ['A&amp;B', 'SRC']);
  const rows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In']
  });
  assert.deepEqual(rows.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1']]);
});

test('xlsx 中按原文核对日期与公式却找不到工作表原文时拒绝导入（不当成没有日期单元格继续）', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'sheet-name-unlocatable.xlsx');
  writeWorkbook(filePath, { main: [['Date', 'In'], ['2026-09-25', 1]], source: [['Date', 'Credit']] });
  // 读取库按 UTF-16 码元截断超出基本平面的字符引用（读成 U+F600），与按 XML 规范解码的表名对不上，无法确认是哪张表的原文
  await rewriteZipEntry(filePath, 'xl/workbook.xml', (xml) => xml.replace('name="MAIN"', 'name="A&#x1F600;B"'));
  assert.throws(() => readers.readRowsWithMetadata(filePath, ['Date', 'In'], { exactIsoDates: true }),
    (error) => error.code === 'FILE_READ' && /无法定位工作表/.test(error.message));
  assert.equal(readers.readRowsWithMetadata(filePath, ['Date', 'In']).rows.length, 2, '不按原文核对的读取不受影响');
});

test('内容为 ODS 的账单：单元格的值不含批注（office:annotation）中的文字，批注中写有 _x0041_ 也不改变读到的值与配对键', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-annotation-escape-like.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x'], ['', 2, 'REF-7']],
    source: [['Date', 'Ref'], ['2026-09-26', 'SRC_NOTED']],
    replacements: {
      SRC_NOTED: '<table:table-cell office:value-type="string"><office:annotation><text:p>private note_x0041_</text:p></office:annotation><text:p>REF-7</text:p></table:table-cell>'
    }
  });
  const source = readers.readRowsWithMetadata(filePath, [], { sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true });
  assert.deepEqual(source.rows.map((row) => row[1]), ['Ref', 'REF-7']);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule({ matchMode: 'exact', sourceMatchField: 'Ref' })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(0, 2)), [['2026-09-25', '1'], ['2026-09-26', '2']]);
});

test('内容为 ODS 的账单：按原文读取的文本与读取库同一空白口径，text:s 的空格按 text:c 原样展开（不截短），超过 Excel 单元格上限时拒绝导入', (t) => {
  const dir = makeTempDir(t);
  const textCell = (body) => `<table:table-cell office:value-type="string"><text:p>${body}</text:p></table:table-cell>`;
  const filePath = path.join(dir, 'ods-escape-like-spaces.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x']],
    source: [['Date', 'Ref'], ['2026-09-26', 'S1'], ['2026-09-27', 'S2'], ['2026-09-28', 'S3']],
    replacements: {
      S1: textCell('Ref_x0041_<text:s text:c="1000"/>123'),
      S2: textCell('Ref_x0041_<text:s text:c="1001"/>123'),
      S3: textCell('  Ref_x0041_ \n  B  ')
    }
  });
  const source = readers.readRowsWithMetadata(filePath, [], { sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true });
  assert.deepEqual(source.rows.slice(1).map((row) => row[1]),
    [`Ref_x0041_${' '.repeat(1000)}123`, `Ref_x0041_${' '.repeat(1001)}123`, 'Ref_x0041_ B']);

  const oversizedPath = path.join(dir, 'ods-escape-like-oversized.xls');
  writeOdsStatement(oversizedPath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x']],
    source: [['Date', 'Ref'], ['2026-09-26', 'S1']],
    replacements: { S1: textCell('Ref_x0041_<text:s text:c="20000"/>1<text:s text:c="20000"/>2') }
  });
  assert.throws(() => readers.readRowsWithMetadata(oversizedPath, [], { sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true }),
    (error) => error.code === 'FILE_READ' && /空格超过 32767 个/.test(error.message));
});

test('SpreadsheetML 2003 公式的缓存只有 XML 注释（<Data><!-- none --></Data>）时按没有缓存结果处理：主表该行跳过，来源表读成空值（不是 0 / false）；真正缓存的 0、false 照常保留', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'xlml-comment-only-cache.xls');
  writeXlmlStatement(filePath, {
    mainRows: [
      `${xlmlCell('String', 'Date')}${xlmlCell('String', 'In')}${xlmlCell('String', 'Desc')}`,
      `${xlmlCell('String', '2026-09-25')}${xlmlCell('Number', 1)}${xlmlCell('String', 'x')}`,
      `<Cell ss:Formula="=TODAY()"><Data ss:Type="DateTime"><!-- none --></Data></Cell>${xlmlCell('Number', 2)}${xlmlCell('String', 'Trade - $65.45')}`
    ],
    sourceRows: [
      `${xlmlCell('String', 'Date')}${xlmlCell('String', 'Credit')}${xlmlCell('String', 'Flag')}`,
      `${xlmlCell('String', '2026-09-26')}<Cell ss:Formula="=0"><Data ss:Type="Number"><!-- none --></Data></Cell>`
        + '<Cell ss:Formula="=FALSE()"><Data ss:Type="Boolean"><!-- none --></Data></Cell>',
      `${xlmlCell('String', '2026-09-27')}<Cell ss:Formula="=0"><Data ss:Type="Number">0</Data></Cell>`
        + '<Cell ss:Formula="=FALSE()"><Data ss:Type="Boolean">0</Data></Cell>',
      `${xlmlCell('String', '2026-09-28')}${xlmlCell('Number', 65.45)}`
    ]
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc'],
    crossSheetBackfillRule: rule()
  });
  assert.deepEqual(mapped.issues.filter((issue) => String(issue.type).startsWith('cross-sheet'))
    .map((issue) => [issue.rowNumber, issue.reason]), [[3, 'target-cell-unreadable']]);
  const source = readers.readRowsWithMetadata(filePath, [], {
    sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true, allowEmpty: true, blankUncachedFormulas: true
  });
  assert.deepEqual(source.rows.slice(1, 3).map((row) => [row[1] ?? '', row[2] ?? '']), [['', ''], [0, false]]);
});

// ---- v3.2.21 审查回归（第三十五轮）----

test('xlsx 共享字符串表的注释中有旧条目时按实际生效的条目读取（不错位）：原有文本不会被读成注释中的空白、当成空格回填覆盖', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'sst-comment.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'In', 'Desc', 'Note'], ['2026-09-25', 1, 'x', 'n1'], ['2026-09-26', 2, 'Trade - $65.45', 'ORIGINAL']
  ]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit', 'Ref'], ['2026-09-26', 65.45, 'R-1']]), 'SRC');
  XLSX.writeFile(workbook, filePath, { bookSST: true });
  await rewriteZipEntry(filePath, 'xl/sharedStrings.xml', (xml) => xml.replace('<si><t>ORIGINAL</t></si>', '<!--<si><t> </t></si>--><si><t>ORIGINAL</t></si>'));
  const read = readers.readRowsWithMetadata(filePath, ['Date', 'In', 'Desc', 'Note'], { exactIsoDates: true });
  assert.deepEqual(read.rows.map((row) => row[3]), ['Note', 'n1', 'ORIGINAL']);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount'],
    mappingByField: { BillDate: 'Date', 'Credit Amount': 'In' },
    expectedSourceHeaders: ['Date', 'In', 'Desc', 'Note'],
    crossSheetBackfillRule: rule({
      rowRules: [{ conditions: [{ field: 'Note', op: '空值', value: '' }] }],
      backfillFields: [{ targetField: 'Note', sourceField: 'Ref' }]
    })
  });
  assert.deepEqual(mapped.crossSheetBackfillPatches || [], []);
});

test('网银模板读取表头：有效范围因空样式格延伸到第 1048576 行时只展开到表头行，不为其后的空行逐行构造', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'sparse-range-header.xlsx');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[], ['Date', 'In'], ['2026-09-25', 1]]);
  sheet['!ref'] = 'A1:B1048576';
  XLSX.utils.book_append_sheet(workbook, sheet, 'MAIN');
  XLSX.writeFile(workbook, filePath);
  assert.equal(XLSX.readFile(filePath).Sheets.MAIN['!ref'], 'A1:B1048576', '前置：有效范围延伸到最后一行');
  const original = XLSX.utils.sheet_to_json;
  let largest = 0;
  XLSX.utils.sheet_to_json = function patched(...args) {
    const result = original.apply(this, args);
    largest = Math.max(largest, result.length);
    return result;
  };
  t.after(() => {
    XLSX.utils.sheet_to_json = original;
  });
  assert.deepEqual(readers.extractHeaders(filePath, { exactIsoDates: true }), ['Date', 'In']);
  assert.ok(largest <= 2, `展开了 ${largest} 行`);
});

// ---- v3.2.21 审查回归（第三十六轮）----

const shiftSharedStringIndexes = (xml) => xml.replace(/(<c\b[^>]*\bt="s"[^>]*>\s*<v>)(\d+)(<\/v>)/g, (_whole, open, index, close) => `${open}${Number(index) + 1}${close}`);

test('xlsx 共享字符串表含自闭合的空条目（<si/>）时按实际条目读取：其后的文本与日期不错位成下一项', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'sst-self-closing.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'In', 'Ref'], ['2026-09-10', 1, '42'], ['2026-09-20', 2, '43']
  ]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit']]), 'SRC');
  XLSX.writeFile(workbook, filePath, { bookSST: true });
  await rewriteZipEntry(filePath, 'xl/sharedStrings.xml', (xml) => xml.replace(/(<sst\b[^>]*>)/, '$1<si/>'));
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet1.xml', shiftSharedStringIndexes);
  await rewriteZipEntry(filePath, 'xl/worksheets/sheet2.xml', shiftSharedStringIndexes);
  assert.notEqual(XLSX.readFile(filePath).Sheets.MAIN.A2.v, '2026-09-10', '前置：读取库按 </si> 切分，读成下一项');
  const read = readers.readRowsWithMetadata(filePath, ['Date', 'In', 'Ref'], { exactIsoDates: true });
  assert.deepEqual(read.rows.map((row) => [row[0], row[2]]), [['Date', 'Ref'], ['2026-09-10', '42'], ['2026-09-20', '43']]);
});

test('内容为 ODS 的账单：段落中的 CDATA 按字符数据保留（REF<![CDATA[-A]]>_x0041_ 与 REF_x0041_ 是不同的编号，REF<![CDATA[-B]]> 不读成 REF）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-cdata.xls');
  const textCell = (body) => `<table:table-cell office:value-type="string"><text:p>${body}</text:p></table:table-cell>`;
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x']],
    source: [['Date', 'Ref'], ['2026-09-10', 'S1'], ['2026-09-20', 'S2'], ['2026-09-21', 'S3']],
    replacements: { S1: textCell('REF<![CDATA[-A]]>_x0041_'), S2: textCell('REF_x0041_'), S3: textCell('REF<![CDATA[-B & <C>]]>') }
  });
  const source = readers.readRowsWithMetadata(filePath, [], { sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true });
  assert.deepEqual(source.rows.slice(1).map((row) => row[1]), ['REF-A_x0041_', 'REF_x0041_', 'REF-B & <C>']);
});

test('内容为 ODS 的账单：公式声明了值类型却没有该类型的取值属性（of:=TRUE() 没有 office:boolean-value）时按没有缓存结果读成空值；显式缓存的 false、0 照常保留', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'ods-typed-uncached.xls');
  writeOdsStatement(filePath, {
    main: [['Date', 'In', 'Desc'], ['2026-09-25', 1, 'x']],
    source: [['Date', 'Flag', 'Credit'], ['2026-09-10', 'B1', 'N1'], ['2026-09-20', 'B2', 'N2']],
    replacements: {
      B1: '<table:table-cell table:formula="of:=TRUE()" office:value-type="boolean"><text:p>TRUE</text:p></table:table-cell>',
      N1: '<table:table-cell table:formula="of:=1+1" office:value-type="float"><text:p>2</text:p></table:table-cell>',
      B2: '<table:table-cell table:formula="of:=FALSE()" office:value-type="boolean" office:boolean-value="false"><text:p>FALSE</text:p></table:table-cell>',
      N2: '<table:table-cell table:formula="of:=0" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>'
    }
  });
  const source = readers.readRowsWithMetadata(filePath, [], {
    sheetName: 'SRC', exactIsoDates: true, onlyTargetSheet: true, allowEmpty: true, blankUncachedFormulas: true
  });
  assert.deepEqual(source.rows.slice(1).map((row) => [row[1] ?? '', row[2] ?? '']), [['', ''], [false, 0]]);
});
