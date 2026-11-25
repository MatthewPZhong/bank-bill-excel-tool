'use strict';

// v3.2.19 原始账单预处理「重复账单过滤」（spec §8.3）：
//   - buildMappedRows 开启时为经「过滤账单」保留的源行写内容指纹（rowMetas[i].sourceRowKey），不开启时不写；
//   - 查重：内容指纹、账户（MerchantId + 币种）与账期都相同才算重复，同文件内与跨文件都算；
//     只比较产出明细行且有账户号的源行（Credit / Debit 恰有一个非 0）；按（文件顺序, 源行号）保留首行；
//   - 删除：去掉源行的全部输出行（拆分出的多行一起），同步 rowMetas 与提示，保留附加属性；摘要不含文件路径。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  buildSourceRowKey,
  describeDuplicateKeeperReplacementConflicts,
  dropDuplicateSourceRows,
  findDuplicateKeeperReplacementConflicts,
  scanDuplicateSourceRows
} = require('../../../../src/backend/file-service/duplicate-source-rows');
const { buildMappedRows } = require('../../../../src/backend/file-service');

const OUTPUT_HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];

// rows：[sourceRowNumber, key, BillDate, MerchantId, Currency, Credit, Debit]
function entry(filePath, rows, extra = {}) {
  const detailRows = [OUTPUT_HEADER.slice()].concat(rows.map((row) => row.slice(2)));
  detailRows.rowMetas = rows.map(([sourceRowNumber, key]) => (key ? { sourceRowNumber, sourceRowKey: key } : { sourceRowNumber }));
  Object.assign(detailRows, extra);
  return { filePath, detailRows };
}

function rowNumbers(detailRows) {
  return detailRows.rowMetas.map((meta) => meta.sourceRowNumber);
}

test('指纹：整行表头与单元格去首尾空白后整体比较，表头不同或任一单元格不同即不同；行尾空白不影响；不做数值换算', () => {
  const headers = ['日期', '金额', '摘要'];
  assert.equal(buildSourceRowKey(headers, ['2026-11-01', '100', '货款']), buildSourceRowKey([' 日期', '金额 ', '摘要'], [' 2026-11-01 ', 100, '货款']));
  assert.notEqual(buildSourceRowKey(headers, ['2026-11-01', '100', '货款']), buildSourceRowKey(headers, ['2026-11-01', '100', '货款 2']));
  assert.notEqual(buildSourceRowKey(headers, ['2026-11-01', '100', '货款']), buildSourceRowKey(['日期', '金额', '附言'], ['2026-11-01', '100', '货款']));
  assert.notEqual(buildSourceRowKey(headers, ['2026-11-01', '100', '']), buildSourceRowKey(headers, ['2026-11-01', '100.00', '']));
  // 没有表头的列也参与比较（宁可漏判，不误删）；行尾的空白单元格不影响
  assert.notEqual(buildSourceRowKey(headers, ['2026-11-01', '100', '货款', 'TX1']), buildSourceRowKey(headers, ['2026-11-01', '100', '货款', 'TX2']));
  assert.equal(buildSourceRowKey(headers, ['2026-11-01', '100', '货款', '', ' ']), buildSourceRowKey(headers, ['2026-11-01', '100', '货款']));
});

test('查重：同文件内与跨文件都算，账户不同不算；按文件顺序、源行号保留首行', () => {
  const entries = [
    entry('/in/a.xlsx', [
      [2, 'K1', '2026-11-01', 'ACC1', 'USD', '100.00', ''],
      [3, 'K2', '2026-11-01', 'ACC1', 'USD', '', '20.00'],
      [5, 'K1', '2026-11-01', 'ACC1', 'USD', '100.00', ''],
      // 同内容、不同账户：不算重复
      [6, 'K2', '2026-11-01', 'ACC2', 'USD', '', '20.00']
    ]),
    entry('/in/b.xlsx', [
      [2, 'K2', '2026-11-01', 'ACC1', 'USD', '', '20.00'],
      // 同账户不同币种：不算重复
      [3, 'K1', '2026-11-01', 'ACC1', 'HKD', '100.00', '']
    ])
  ];
  const scan = scanDuplicateSourceRows(entries);
  assert.deepEqual(scan.groups.map((group) => ({
    accounts: group.accounts,
    billDate: group.billDate,
    rows: group.rows.map((row) => [row.fileName, row.sourceRowNumber, row.kept])
  })), [
    { accounts: [{ merchantId: 'ACC1', currency: 'USD' }], billDate: '2026-11-01', rows: [['a.xlsx', 2, true], ['a.xlsx', 5, false]] },
    { accounts: [{ merchantId: 'ACC1', currency: 'USD' }], billDate: '2026-11-01', rows: [['a.xlsx', 3, true], ['b.xlsx', 2, false]] }
  ]);
  assert.deepEqual(scan.dropPlan, [[5], [2]]);
  assert.equal(scan.droppedRowCount, 2);
  assert.match(scan.digest, /^[0-9a-f]{64}$/);
});

test('查重：与明细导出同一口径——不能解析的金额（如「100.」）照常导出，也照常参与查重', () => {
  const scan = scanDuplicateSourceRows([entry('/in/a.csv', [
    [2, 'K1', '2026-11-01', 'ACC1', 'USD', '100.', ''],
    [3, 'K1', '2026-11-01', 'ACC1', 'USD', '100.', '']
  ])]);
  assert.deepEqual(scan.dropPlan, [[3]]);
});

test('查重：只比较产出明细行的源行；没有指纹（未开启）时不查重', () => {
  const entries = [entry('/in/a.xlsx', [
    // 收支都为 0、两边都有金额：不产出明细，不参与
    [2, 'K0', '2026-11-01', 'ACC1', 'USD', '', ''],
    [3, 'K0', '2026-11-01', 'ACC1', 'USD', '', ''],
    [4, 'KB', '2026-11-01', 'ACC1', 'USD', '10', '10'],
    [5, 'KB', '2026-11-01', 'ACC1', 'USD', '10', '10'],
    [6, '', '2026-11-01', 'ACC1', 'USD', '10', ''],
    [7, '', '2026-11-01', 'ACC1', 'USD', '10', '']
  ])];
  const scan = scanDuplicateSourceRows(entries);
  assert.deepEqual([scan.groups, scan.dropPlan, scan.droppedRowCount, scan.digest], [[], [[]], 0, '']);
});

test('查重：没有账户号的源行无法证明账户相同，不参与；账户号含竖线时账户与币种原样保留', () => {
  const scan = scanDuplicateSourceRows([
    entry('/in/a.xlsx', [
      [2, 'K1', '2026-11-01', '', 'USD', '100', ''],
      [3, 'K1', '2026-11-01', '', 'USD', '100', ''],
      [4, 'K2', '2026-11-01', 'acct|branch', 'USD', '', '5']
    ]),
    entry('/in/b.xlsx', [
      [2, 'K1', '2026-11-01', '', 'USD', '100', ''],
      [3, 'K2', '2026-11-01', 'acct|branch', 'USD', '', '5'],
      // 账户号「acct」+ 币种「branch|USD」与上面拼起来相同，但不是同一账户
      [4, 'K2', '2026-11-01', 'acct', 'branch|USD', '', '5']
    ])
  ]);
  assert.deepEqual(scan.groups.map((group) => [group.accounts, group.rows.map((row) => [row.fileName, row.sourceRowNumber])]), [
    [[{ merchantId: 'acct|branch', currency: 'USD' }], [['a.xlsx', 4], ['b.xlsx', 3]]]
  ]);
  assert.deepEqual(scan.dropPlan, [[], [3]]);
});

test('查重：账期不同不算同一组；摘要随账期变化（日期解析口径变了须重新确认）', () => {
  const rows = (date) => [[2, 'K1', date, 'ACC1', 'USD', '100', ''], [3, 'K1', date, 'ACC1', 'USD', '100', '']];
  const first = scanDuplicateSourceRows([entry('/in/a.xlsx', rows('2026-01-05'))]);
  const second = scanDuplicateSourceRows([entry('/in/a.xlsx', rows('2026-05-01'))]);
  assert.equal(first.groups[0].billDate, '2026-01-05');
  assert.deepEqual(second.dropPlan, first.dropPlan);
  assert.notEqual(second.digest, first.digest);
  const mixed = scanDuplicateSourceRows([entry('/in/a.xlsx', [[2, 'K1', '2026-01-05', 'ACC1', 'USD', '100', ''], [3, 'K1', '2026-05-01', 'ACC1', 'USD', '100', '']])]);
  assert.deepEqual(mixed.groups, []);
});

test('删除：拆分出的多行随源行一起去掉，rowMetas、提示同步；保留附加属性；不改原条目', () => {
  const basis = Object.freeze({ version: 1 });
  const first = entry('/in/a.xlsx', [
    [2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''],
    [2, 'K1', '2026-11-01', 'ACC1', 'USD', '', '5'],
    [3, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''],
    [3, 'K1', '2026-11-01', 'ACC1', 'USD', '', '5'],
    [4, 'K2', '2026-11-02', 'ACC1', 'USD', '', '7']
  ], {
    issues: [{ type: 'currency-unmatched', rowNumber: 3 }, { type: 'currency-unmatched', rowNumber: 4 }],
    headerBreaks: [9],
    preprocessRowFilterStats: { enabled: true, totalRows: 3, keptRows: 3 }
  });
  Object.defineProperty(first.detailRows, 'bigAccountRecognitionBasis', { value: basis, enumerable: false });
  const scan = scanDuplicateSourceRows([first]);
  assert.deepEqual(scan.groups[0].accounts, [{ merchantId: 'ACC1', currency: 'USD' }]);
  const [dropped] = dropDuplicateSourceRows([first], scan);
  assert.deepEqual(rowNumbers(dropped.detailRows), [2, 2, 4]);
  assert.deepEqual(dropped.detailRows.slice(1).map((row) => [row[3], row[4]]), [['100', ''], ['', '5'], ['', '7']]);
  assert.deepEqual(dropped.detailRows.issues, [{ type: 'currency-unmatched', rowNumber: 4 }]);
  assert.deepEqual(dropped.detailRows.headerBreaks, [9]);
  assert.deepEqual(dropped.detailRows.preprocessRowFilterStats, { enabled: true, totalRows: 3, keptRows: 3 });
  assert.equal(dropped.detailRows.bigAccountRecognitionBasis, basis);
  assert.deepEqual(dropped.detailRows.duplicateRowFilterStats, { droppedRowNumbers: [3], droppedRowCount: 1, keptInFilePaths: [] });
  assert.deepEqual(rowNumbers(first.detailRows), [2, 2, 3, 3, 4], '原条目不变');
  // 没有要删的文件原样返回
  const untouched = entry('/in/b.xlsx', [[2, 'K9', '2026-11-01', 'ACC1', 'USD', '1', '']]);
  assert.equal(dropDuplicateSourceRows([first, untouched], scanDuplicateSourceRows([first, untouched]))[1], untouched);
});

test('摘要：只含文件顺序、行号、指纹、账户与账期，换路径（续跑重绑）不变，内容变化即变化', () => {
  const rows = [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']];
  const original = scanDuplicateSourceRows([entry('/select/a.xlsx', rows)]).digest;
  assert.equal(scanDuplicateSourceRows([entry('/frozen/copy-a.xlsx', rows)]).digest, original);
  const changed = rows.concat([[4, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']]);
  assert.notEqual(scanDuplicateSourceRows([entry('/select/a.xlsx', changed)]).digest, original);
});

// 用给定的自定义数字格式替换样式表的整个 numFmts 段：SheetJS 的数字格式表是全局的，前面用例读过的格式会被写进后面生成的
//   样式表（numFmts 的条数、内容随用例顺序变化），只替换开始标签会与残留的同号格式冲突。
function replaceNumFmts(stylesXml, entries) {
  const count = (entries.match(/<numFmt\b/g) || []).length;
  const block = `<numFmts count="${count}">${entries}</numFmts>`;
  const replaced = stylesXml.replace(/<numFmts\b[^>]*\/>|<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/, block);
  return replaced !== stylesXml ? replaced : stylesXml.replace(/(<styleSheet\b[^>]*>)/, `$1${block}`);
}

function writeXlsx(dir, header, rows, name = 'dup.xlsx') {
  const filePath = path.join(dir, name);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('buildMappedRows：开启时为经「过滤账单」保留的行写指纹，合计行不写；不开启时不写', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = ['日期', '类型', '收入', '支出'];
  const filePath = writeXlsx(dir, header, [
    ['2026-11-01', '交易', '100', ''],
    ['2026-11-01', '冻结', '100', ''],
    ['2026-11-01', '交易', '100', ''],
    ['合计', '交易', '200', '']
  ]);
  const map = (duplicateRowKeys) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: header,
    preprocessRowFilterRules: [{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '交易' }] }],
    duplicateRowKeys
  });
  const mapped = map(true);
  assert.deepEqual(rowNumbers(mapped), [2, 4]);
  // XLSX 行另附工作表原文（见 readers.js markXlsxSourceEvidence），指纹不等于只按读出的文本计算的结果
  assert.match(mapped.rowMetas[0].sourceRowKey, /^[0-9a-f]{64}$/);
  assert.equal(mapped.rowMetas[0].sourceRowKey, mapped.rowMetas[1].sourceRowKey);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[4]], '被过滤的第 3 行不参与，第 2、4 行重复');
  assert.ok(map(false).rowMetas.every((meta) => !('sourceRowKey' in meta)));
});

test('buildMappedRows：指纹含模板表头范围以外的列——模板没取的流水号不同时不算重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-full-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = ['日期', '收入', '支出', '交易流水号'];
  const filePath = writeXlsx(dir, header, [
    ['2026-11-01', '100', '', 'TX1'],
    ['2026-11-01', '100', '', 'TX2'],
    ['2026-11-01', '100', '', 'TX1']
  ], 'serial.xlsx');
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    // 模板只有前三列（与源表头的一段连续列匹配即可导入）
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[4]], '只有流水号也相同的第 4 行与第 2 行重复');
});

test('buildMappedRows：分段文件按各段自己的整行表头算指纹——额外列表头不同的两段不互判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-segments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = writeXlsx(dir, ['日期', '收入', '支出', 'TxnId'], [
    ['2026-11-01', '100', '', '123'],
    ['日期', '收入', '支出', 'BatchId'],
    ['2026-11-01', '100', '', '123'],
    ['2026-11-01', '100', '', '123']
  ], 'segments.xlsx');
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys: true
  });
  assert.deepEqual(rowNumbers(mapped), [2, 4, 5]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], '只有同一分段内的第 4、5 行重复');
});

test('buildMappedRows：Excel 错误值（#N/A）与空白不同，不算重复；两行都是同一错误值时照常算重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'errors.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '参考'],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '50', '', ''],
    ['2026-11-01', '50', '', '']
  ]);
  sheet.D2 = { t: 'e', v: 42, w: '#N/A' };
  sheet.D4 = { t: 'e', v: 42, w: '#N/A' };
  sheet.D5 = { t: 'e', v: 42, w: '#N/A' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], '第 2 行（#N/A）与第 3 行（空）不重复；第 4、5 行都是 #N/A，重复');
});

test('指纹：Excel 错误值与以任何前缀开头的同文字文本都不同（按类型编码）', () => {
  const headers = ['日期', '参考'];
  const errorKey = buildSourceRowKey(headers, ['2026-11-01', { excelError: '#N/A' }]);
  ['#N/A', '\u0000#N/A', '', '{"excelError":"#N/A"}'].forEach((text) => {
    assert.notEqual(errorKey, buildSourceRowKey(headers, ['2026-11-01', text]), JSON.stringify(text));
  });
  assert.equal(errorKey, buildSourceRowKey(headers, ['2026-11-01', { excelError: '#N/A' }]));
});

test('buildMappedRows：两份文件有效范围的起始列不同（一份多一行 A1 标题），同一物理列的相同交易照常判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-columns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, withTitle) => {
    const sheet = XLSX.utils.aoa_to_sheet([['日期', '收入', '支出'], ['2026-11-01', '100', '']], { origin: 'B2' });
    if (withTitle) sheet.A1 = { t: 's', v: '交易明细' };
    sheet['!ref'] = withTitle ? 'A1:D3' : 'B2:D3';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const filePath = path.join(dir, name);
    XLSX.writeFile(workbook, filePath);
    return filePath;
  };
  const entries = [write('a.xlsx', true), write('b.xlsx', false)].map((filePath) => ({
    filePath,
    detailRows: buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
      mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
      expectedSourceHeaders: ['日期', '收入', '支出'],
      duplicateRowKeys: true
    })
  }));
  assert.deepEqual(entries.map((item) => rowNumbers(item.detailRows)), [[3], [3]]);
  assert.deepEqual(scanDuplicateSourceRows(entries).dropPlan, [[], [3]]);
});

test('删除：记下跨文件重复行的保留方文件；去重关系两端须一起覆盖，只覆盖一端（保留方或去除方）都拦下', () => {
  const entries = [
    entry('/in/a.xlsx', [[2, 'X', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, 'Y', '2026-11-01', 'ACC1', 'USD', '', '5']]),
    entry('/in/b.xlsx', [[2, 'X', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, 'Z', '2026-11-02', 'ACC1', 'USD', '7', '']]),
    entry('/in/c.xlsx', [[2, 'Y', '2026-11-01', 'ACC1', 'USD', '', '5'], [3, 'Y', '2026-11-01', 'ACC1', 'USD', '', '5']])
  ];
  const dropped = dropDuplicateSourceRows(entries, scanDuplicateSourceRows(entries));
  assert.deepEqual(dropped.map((item) => item.detailRows.duplicateRowFilterStats && item.detailRows.duplicateRowFilterStats.keptInFilePaths),
    [undefined, ['/in/a.xlsx'], ['/in/a.xlsx']]);
  const session = dropped.map((item) => ({ filePath: item.filePath, detailRows: item.detailRows }));
  const all = { filePaths: ['/in/a.xlsx', '/in/b.xlsx', '/in/c.xlsx'] };
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(session, ['/in/a.xlsx']), [all]);
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(session, ['/in/a.xlsx', '/in/b.xlsx', '/in/c.xlsx']), [], '一起覆盖时放行（会重新查重）');
  // 只覆盖去除方：重新导入会把去除的交易带回来，与仍在会话中的保留行重复入账；按连通的整组提示
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(session, ['/in/b.xlsx']), [all]);
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(session, ['/in/a.xlsx', '/in/b.xlsx']), [all]);
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(session, []), []);
  // 关系链：A 保留了 B 的行、B 又保留了 C 的行——只选 A 时一次列出 A、B、C，按提示一起导入即可放行
  const chain = [
    { filePath: '/in/a.xlsx', detailRows: [[]] },
    { filePath: '/in/b.xlsx', detailRows: Object.assign([[]], { duplicateRowFilterStats: { keptInFilePaths: ['/in/a.xlsx'] } }) },
    { filePath: '/in/c.xlsx', detailRows: Object.assign([[]], { duplicateRowFilterStats: { keptInFilePaths: ['/in/b.xlsx'] } }) },
    { filePath: '/in/d.xlsx', detailRows: [[]] }
  ];
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(chain, ['/in/a.xlsx']), [all]);
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(chain, ['/in/c.xlsx', '/in/d.xlsx']), [all], '不相关的文件不列出');
  assert.deepEqual(findDuplicateKeeperReplacementConflicts(chain, ['/in/a.xlsx', '/in/b.xlsx', '/in/c.xlsx']), []);
  // 覆盖提示按整组文件生成（真实返回结构）
  assert.deepEqual(describeDuplicateKeeperReplacementConflicts(findDuplicateKeeperReplacementConflicts(chain, ['/in/a.xlsx'])), {
    message: '上次导入时「a.xlsx」、「b.xlsx」、「c.xlsx」之间去除过重复账单，只覆盖其中一部分会让交易丢失或重复入账，请把「a.xlsx」、「b.xlsx」、「c.xlsx」一起重新导入',
    detailLines: ['须一起重新导入：「a.xlsx」、「b.xlsx」、「c.xlsx」']
  });
});

test('候选：账期（BillDate）为空的源行不参与查重——两个未知账期不能证明是同一账期', () => {
  const rows = [[2, 'K1', '', 'ACC1', 'USD', '100', ''], [3, 'K1', '', 'ACC1', 'USD', '100', ''], [4, 'K2', '2026-11-01', 'ACC1', 'USD', '5', ''], [5, 'K2', '2026-11-01', 'ACC1', 'USD', '5', '']];
  assert.deepEqual(scanDuplicateSourceRows([entry('/in/a.xlsx', rows)]).dropPlan, [[5]]);
});

test('指纹：按 Excel 物理列对齐，只记首个非空单元格的绝对列号，不展开前导空列', () => {
  const header = ['日期', '收入'];
  const row = ['2026-11-01', '100'];
  // 有效范围从第 10001 列开始与带前导空单元格从 A 列开始的同一行相同
  const offset = 10000;
  assert.equal(
    buildSourceRowKey(header, row, { columnOffset: offset }),
    buildSourceRowKey(new Array(offset).fill('').concat(header), new Array(offset).fill('').concat(row))
  );
  assert.notEqual(buildSourceRowKey(header, row, { columnOffset: 1 }), buildSourceRowKey(header, row));
});

// 把工作表 XML 中的指定单元格改写为没有缓存结果（没有 <v>）的文本公式：<c r="D3" t="str"><f>…</f></c>
function patchUncachedTextFormula(buffer, cellRef, formulaXml) {
  const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  const index = cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'));
  const sheetEntry = cfb.FileIndex[index];
  const xml = Buffer.from(sheetEntry.content).toString('utf8')
    .replace(new RegExp(`<c r="${cellRef}"[^>]*>.*?</c>`), `<c r="${cellRef}" t="str"><f>${formulaXml}</f></c>`);
  sheetEntry.content = Buffer.from(xml, 'utf8');
  sheetEntry.size = sheetEntry.content.length;
  return XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' });
}

test('buildMappedRows：含公式的行（数值、文本、布尔公式，不论是否读到缓存结果）值无法证明，不参与查重（保留）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-formula-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'formula.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '30', '', 'PLACEHOLDER'],
    ['2026-11-01', '30', '', 'PLACEHOLDER'],
    ['2026-11-01', '50', '', 'S1'],
    ['2026-11-01', '50', '', 'S1'],
    ['2026-11-01', '70', '', ''],
    ['2026-11-01', '70', '', ''],
    ['2026-11-01', '90', '', ''],
    ['2026-11-01', '90', '', '']
  ]);
  // 数值公式没有缓存结果：开 sheetStubs 读成 t='z'
  sheet.D2 = { t: 'n', f: 'ROW()' };
  sheet.D3 = { t: 'n', f: 'ROW()' };
  // 布尔公式没有缓存结果：读成 { t: 'b', v: false }，两行实际分别为真、假
  sheet.D8 = { t: 'b', f: 'ROW()=8' };
  sheet.D9 = { t: 'b', f: 'ROW()=8' };
  // 带缓存结果的公式同样不参与（读不出文件里是否真有缓存）
  sheet.D10 = { t: 'n', f: '1+1', v: 2 };
  sheet.D11 = { t: 'n', f: '1+1', v: 2 };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  // 文本公式没有缓存结果：读成 t='s'、v=''（Excel 计算结果分别为 Ref-4、Ref-5）
  let buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  buffer = patchUncachedTextFormula(buffer, 'D4', '"Ref-"&amp;ROW()');
  buffer = patchUncachedTextFormula(buffer, 'D5', '"Ref-"&amp;ROW()');
  fs.writeFileSync(filePath, buffer);
  const map = (duplicateRowKeys) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys
  });
  const mapped = map(true);
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)),
    [false, false, false, false, true, true, false, false, false, false]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[7]], '只有第 6、7 行判为重复');
  // 查重读取不改变映射结果
  assert.deepEqual(mapped.slice(1).map((row) => row.slice()), map(false).slice(1).map((row) => row.slice()));
});

test('buildMappedRows：数组公式范围内没有缓存结果的单元格值未知（只有首格带公式），这些行不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-array-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'array.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', '']
  ]);
  sheet.D2 = { t: 'n', f: 'ROW(A2:A4)', F: 'D2:D4' };
  sheet.D3 = { t: 'n', F: 'D2:D4' };
  sheet.D4 = { t: 'n', F: 'D2:D4' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, false]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[]]);
});

test('buildMappedRows：不传预期表头时同样按带标记的整行算指纹（Excel 错误值与空白不同）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-headerless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'headerless.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '参考'],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', '']
  ]);
  sheet.D2 = { t: 'e', v: 42, w: '#N/A' };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    duplicateRowKeys: true
  });
  assert.deepEqual(rowNumbers(mapped), [2, 3]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[]]);
});

test('buildMappedRows：工作表声明的有效范围小于实际数据时，范围外仍有值的行无法证明相同，不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ref.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    // 表头行在声明范围外没有值（同实测样例）；表头也有范围外的值时整份文件都不参与查重
    ['日期', '收入', '支出', '摘要', ''],
    ['2026-11-01', '100', '', '货款', 'TX1'],
    ['2026-11-01', '100', '', '货款', 'TX2'],
    ['2026-11-01', '50', '', '退款', ''],
    ['2026-11-01', '50', '', '退款', '']
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  // 文件里 E 列有值，但 <dimension> 声明的有效范围只到 D 列
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const sheetEntry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  const xml = Buffer.from(sheetEntry.content).toString('utf8').replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:D5"/>');
  assert.match(xml, /<dimension ref="A1:D5"\/>/);
  sheetEntry.content = Buffer.from(xml, 'utf8');
  sheetEntry.size = sheetEntry.content.length;
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '摘要'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], '只有范围内完整的第 4、5 行判为重复');
});

test('buildMappedRows：CSV 有不能按 UTF-8 解码的字节时，含替换字符的行不参与查重（café、cafè 都会解成 caf�）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-csv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'latin1.csv');
  const lines = [
    Buffer.from('BillDate,Credit,Debit,Note\n', 'latin1'),
    Buffer.from('2026-11-01,100,,café\n', 'latin1'),
    Buffer.from('2026-11-01,100,,cafè\n', 'latin1'),
    Buffer.from('2026-11-01,50,,same\n', 'latin1'),
    Buffer.from('2026-11-01,50,,same\n', 'latin1')
  ];
  fs.writeFileSync(filePath, Buffer.concat(lines));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'BillDate', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['BillDate', 'Credit', 'Debit'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]]);
});

test('buildMappedRows：文本型 .xls（HTML 表格、制表符文本）按单元格原文比较，00001 与 1 不判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-text-xls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cell = (value) => `<td>${value}</td>`;
  const htmlRow = (cells) => `<tr>${cells.map(cell).join('')}</tr>`;
  const htmlPath = path.join(dir, 'html.xls');
  fs.writeFileSync(htmlPath, `<html><body><table>${[
    ['Date', 'Ref', 'Credit', 'Debit'],
    ['20261101', '00001', '100', ''],
    ['20261101', '1', '100', ''],
    ['20261101', 'A9', '1,000', ''],
    ['20261101', 'A9', '1000', ''],
    ['20261101', '00002', '50', ''],
    ['20261101', '00002', '50', '']
  ].map(htmlRow).join('')}</table></body></html>`);
  const tsvPath = path.join(dir, 'text.xls');
  fs.writeFileSync(tsvPath, [
    'Date\tRef\tCredit\tDebit',
    '20261101\t00001\t100\t',
    '20261101\t1\t100\t',
    '20261101\tA9\t100.0\t',
    '20261101\tA9\t100\t',
    '20261101\t00002\t50\t',
    '20261101\t00002\t50\t'
  ].join('\n'));
  for (const filePath of [htmlPath, tsvPath]) {
    const map = (duplicateRowKeys) => buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
      mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
      expectedSourceHeaders: ['Date', 'Ref', 'Credit', 'Debit'],
      duplicateRowKeys
    });
    const mapped = map(true);
    assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, true, true, true, true, true], filePath);
    assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[7]], `${filePath}：只有原文相同的第 6、7 行判为重复`);
    // 查重读取不改变映射结果
    assert.deepEqual(mapped.slice(1).map((row) => row.slice()), map(false).slice(1).map((row) => row.slice()), filePath);
  }
});

test('buildMappedRows：XLSX 共享公式的从属单元格写成空的 <f t="shared"></f> 时 SheetJS 不给公式，按工作表原文排除这些行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-shared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '100', '', ''],
    ['2026-11-01', '50', '', ''],
    ['2026-11-01', '50', '', '']
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  // 第二张表同样位置有共享公式，不影响读取的第一张表
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Other');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patchSheet = (sheetPath, from, to) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(sheetPath))];
    const cellPattern = (n) => new RegExp(`<c r="D${n}"[^>]*/>|<c r="D${n}"[^>]*>.*?</c>`);
    let xml = Buffer.from(entry.content).toString('utf8')
      .replace(cellPattern(from), `<c r="D${from}"><f t="shared" ref="D${from}:D${to}" si="0">ROW()</f></c>`);
    for (let n = from + 1; n <= to; n += 1) xml = xml.replace(cellPattern(n), `<c r="D${n}"><f t="shared" si="0"></f></c>`);
    entry.content = Buffer.from(xml, 'utf8');
    entry.size = entry.content.length;
    return xml;
  };
  const xml = patchSheet('xl/worksheets/sheet1.xml', 2, 4);
  assert.match(xml, /<c r="D3"><f t="shared" si="0"><\/f><\/c>/);
  patchSheet('xl/worksheets/sheet2.xml', 5, 6);
  const filePath = path.join(dir, 'shared.xlsx');
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[6]], '只有不在公式范围内的第 5、6 行判为重复');
});

test('buildMappedRows：XLSX 数值原文超过 15 位有效数字时按 <v> 原文比较（9007199254740992 与 9007199254740993 读成同一个数值）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-precision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 1],
    ['2026-11-01', '100', '', 2],
    ['2026-11-01', '50', '', 3],
    ['2026-11-01', '50', '', 4]
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  const values = { D2: '9007199254740992', D3: '9007199254740993', D4: '12345678901234567890', D5: '12345678901234567890' };
  let xml = Buffer.from(entry.content).toString('utf8');
  Object.entries(values).forEach(([ref, value]) => {
    xml = xml.replace(new RegExp(`(<c r="${ref}"[^>]*>)<v>[^<]*</v>`), `$1<v>${value}</v>`);
  });
  assert.match(xml, /<v>9007199254740993<\/v>/);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const filePath = path.join(dir, 'precision.xlsx');
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, true, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], '只有原文相同的第 4、5 行判为重复');
});

test('buildMappedRows：HTML 表格按每行原始标记比较（REF <b>A</b> 与 REFA 读成同一文本），无效字节不会合并成同一个字符', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-html-markup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const htmlPath = path.join(dir, 'markup.xls');
  const rows = [
    ['Date', 'Ref', 'Credit', 'Debit'],
    ['20261101', 'REF <b>A</b>', '100', ''],
    ['20261101', 'REFA', '100', ''],
    ['20261101', 'X\xE9', '30', ''],
    ['20261101', 'X\xE8', '30', ''],
    ['20261101', 'SAME', '50', ''],
    ['20261101', 'SAME', '50', '']
  ];
  const html = `<html><body><table>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}</table></body></html>`;
  fs.writeFileSync(htmlPath, Buffer.from(html, 'latin1'));
  const mapped = buildMappedRows({
    inputFilePath: htmlPath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Ref', 'Credit', 'Debit'],
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: htmlPath, detailRows: mapped }]).dropPlan, [[7]], '只有原始标记相同的第 6、7 行判为重复');

  // 带 UTF-8 BOM 的制表符文本：无效字节解成替换字符的单元格值未知，该行不参与查重
  const tsvPath = path.join(dir, 'bom.xls');
  fs.writeFileSync(tsvPath, Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from('Date\tRef\tCredit\tDebit\n', 'utf8'),
    Buffer.from('20261101\tX\xE9\t30\t\n', 'latin1'),
    Buffer.from('20261101\tX\xE8\t30\t\n', 'latin1'),
    Buffer.from('20261101\tSAME\t50\t\n20261101\tSAME\t50\t\n', 'utf8')
  ]));
  const mappedTsv = buildMappedRows({
    inputFilePath: tsvPath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Ref', 'Credit', 'Debit'],
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: tsvPath, detailRows: mappedTsv }]).dropPlan, [[5]], '只有第 4、5 行判为重复');
});

test('buildMappedRows：无法核对原文的文本型工作簿（Excel 2003 XML）整张表不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-xml2003-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'xml2003.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Credit', 'Debit'], ['20261101', '50', ''], ['20261101', '50', '']
  ]), 'Sheet1');
  fs.writeFileSync(filePath, XLSX.write(workbook, { type: 'string', bookType: 'xlml' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Credit', 'Debit'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false]);
});

test('buildMappedRows：XLSX 按单元格原始 XML 比较——<v> 带属性的长流水号、字符引用与文字不判重复；共享字符串的相同行跨文件照常判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-xlsx-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 'R1'],
    ['2026-11-01', '100', '', 'R2'],
    ['2026-11-01', '30', '', 'R3'],
    ['2026-11-01', '30', '', 'R4'],
    ['2026-11-01', '50', '', 'SAME'],
    ['2026-11-01', '50', '', 'SAME']
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  // 共享字符串写法（bookSST）：相同文字共用一项
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', bookSST: true }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  const replaceCell = (xml, ref, cellXml) => xml.replace(new RegExp(`<c r="${ref}"[^>]*/>|<c r="${ref}"[^>]*>.*?</c>`), cellXml);
  let xml = Buffer.from(entry.content).toString('utf8');
  xml = replaceCell(xml, 'D2', '<c r="D2"><v>9007199254740992</v></c>');
  xml = replaceCell(xml, 'D3', '<c r="D3"><v xml:space="preserve">9007199254740993</v></c>');
  xml = replaceCell(xml, 'D4', '<c r="D4" t="str"><v>&#x6D41;</v></c>');
  xml = replaceCell(xml, 'D5', '<c r="D5" t="str"><v>A</v></c>');
  assert.match(xml, /xml:space="preserve">9007199254740993/);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const buffer = XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' });
  const fileA = path.join(dir, 'a.xlsx');
  const fileB = path.join(dir, 'b.xlsx');
  fs.writeFileSync(fileA, buffer);
  fs.writeFileSync(fileB, buffer);
  const map = (filePath) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: fileA, detailRows: map(fileA) }]).dropPlan, [[7]], '只有原文相同的第 6、7 行判为重复');
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: fileA, detailRows: map(fileA) }, { filePath: fileB, detailRows: map(fileB) }]).dropPlan,
    [[7], [2, 3, 4, 5, 6, 7]], '整份副本的每一行都与第一份重复');
});

test('buildMappedRows：分隔符文本引号字段内含换行的单元格无法核对原文（读取库把 CRLF 改成 LF），该行不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-newline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'newline.xls');
  fs.writeFileSync(filePath, 'Date\tRef\tCredit\tDebit\r\n20261101\t"REF\r\nA"\t30\t\r\n20261101\t"REF\nA"\t30\t\r\n20261101\tSAME\t50\t\r\n20261101\tSAME\t50\t\r\n');
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Ref', 'Credit', 'Debit'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]]);
});

test('查重范围：只在同一范围（生成组）内判重复；不同范围的相同行各自保留', () => {
  const rows = [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']];
  const a = { ...entry('/in/a.xlsx', rows), duplicateScope: 'template:1' };
  const b = { ...entry('/in/b.xlsx', rows), duplicateScope: 'template:2' };
  const c = { ...entry('/in/c.xlsx', rows), duplicateScope: 'template:1' };
  assert.deepEqual(scanDuplicateSourceRows([a, b]).dropPlan, [[], []]);
  assert.deepEqual(scanDuplicateSourceRows([a, b, c]).dropPlan, [[], [], [2]]);
});

test('候选：拆分出的任一笔收支同时有值时，该源行不参与查重（删除会掩盖生成时的报错，换文件顺序结果也不同）', () => {
  // 源行第 2 行映射为收入 5（文件 a）；同一源行在文件 b 拆成收入 5 与收 5 支 6 的冲突行
  const a = entry('/in/a.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '5', '']]);
  const b = entry('/in/b.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '5', ''], [2, 'K1', '2026-11-01', 'ACC1', 'USD', '5', '6']]);
  assert.deepEqual(scanDuplicateSourceRows([a, b]).dropPlan, [[], []]);
  assert.deepEqual(scanDuplicateSourceRows([b, a]).dropPlan, [[], []]);
});

test('buildMappedRows：XLSX 原文行省略行号（含自闭合空行）时无法核对原文行与读到的行一一对应，整张表不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-rowless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 'R1'],
    ['2026-11-01', '100', '', 'R1']
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  const xml = Buffer.from(entry.content).toString('utf8').replace('<row r="3">', '<row/><row>');
  assert.match(xml, /<row\/><row>/);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const filePath = path.join(dir, 'rowless.xlsx');
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  assert.ok(mapped.rowMetas.length > 0);
  assert.ok(mapped.rowMetas.every((meta) => !meta.sourceRowKey));
});

test('buildMappedRows：只有正向识别为 HTML 表格或分隔符文本的文本型工作簿参与查重（SocialCalc、固定宽度文本不参与）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-text-kind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Credit', 'Debit', 'Ref'], ['20261101', '50', '', 'X'], ['20261101', '50', '', 'X']
  ]), 'Sheet1');
  const socialCalcPath = path.join(dir, 'socialcalc.xls');
  fs.writeFileSync(socialCalcPath, XLSX.write(workbook, { type: 'string', bookType: 'eth' }));
  const fixedWidthPath = path.join(dir, 'fixed.xls');
  fs.writeFileSync(fixedWidthPath, 'Date      Credit    Debit     Ref\n20261101  50                  X\n20261101  50                  X\n');
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const socialCalc = map(socialCalcPath, ['Date', 'Credit', 'Debit', 'Ref']);
  assert.equal(socialCalc.rowMetas.length, 2);
  assert.ok(socialCalc.rowMetas.every((meta) => !meta.sourceRowKey), 'SocialCalc 不参与');
  const fixedWidth = map(fixedWidthPath, []);
  assert.ok(fixedWidth.rowMetas.every((meta) => !meta.sourceRowKey), '固定宽度文本不参与');
});

test('buildMappedRows：XLSX 只有核对到原文的行参与查重——原文写法未识别（如 </row >）的行不参与', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-unverified-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '10', '', 'A'],
    ['2026-11-01', '100', '', 1],
    ['2026-11-01', '20', '', 'B'],
    ['2026-11-01', '100', '', 2],
    ['2026-11-01', '50', '', 'S'],
    ['2026-11-01', '50', '', 'S']
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  // 第 2、4 行以 </row > 结束：原文匹配会把第 3、5 行吞进去，第 3、5 行得不到原文摘要；两行流水号舍入后读成同一个数
  const xml = Buffer.from(entry.content).toString('utf8')
    .replace(/(<c r="D3"[^>]*>)<v>[^<]*<\/v>/, '$1<v>9007199254740992</v>')
    .replace(/(<c r="D5"[^>]*>)<v>[^<]*<\/v>/, '$1<v>9007199254740993</v>')
    .replace(/(<row r="2"[^>]*>[\s\S]*?)<\/row>/, '$1</row >')
    .replace(/(<row r="4"[^>]*>[\s\S]*?)<\/row>/, '$1</row >');
  assert.equal((xml.match(/<\/row >/g) || []).length, 2);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const filePath = path.join(dir, 'unverified.xlsx');
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[7]], '第 5 行不因舍入后与第 3 行相同而进入删除计划');
});

test('buildMappedRows：CSV 按每行原文比较（解析器会吞掉未加引号字段中间的引号）；HTML 中带 Excel 公式属性的行不参与', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-csv-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csvPath = path.join(dir, 'quotes.csv');
  fs.writeFileSync(csvPath, 'BillDate,Credit,Debit,Note\n2026-11-01,100,,SALE 2" X"\n2026-11-01,100,,SALE 2 X\n2026-11-01,50,,SAME\n2026-11-01,50,,SAME\n');
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const csv = map(csvPath, ['BillDate', 'Credit', 'Debit']);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: csvPath, detailRows: csv }]).dropPlan, [[5]], '只有原文相同的第 4、5 行判为重复');

  const htmlPath = path.join(dir, 'fmla.xls');
  const tr = (cells) => `<tr>${cells.join('')}</tr>`;
  fs.writeFileSync(htmlPath, `<html><body><table>${[
    tr(['<td>Date</td>', '<td>Credit</td>', '<td>Debit</td>', '<td>Ref</td>']),
    tr(['<td>20261101</td>', '<td>100</td>', '<td></td>', '<td x:fmla="=ROW()">0</td>']),
    tr(['<td>20261101</td>', '<td>100</td>', '<td></td>', '<td x:fmla="=ROW()">0</td>']),
    tr(['<td>20261101</td>', '<td>50</td>', '<td></td>', '<td>S</td>']),
    tr(['<td>20261101</td>', '<td>50</td>', '<td></td>', '<td>S</td>'])
  ].join('')}</table></body></html>`);
  const html = map(htmlPath, ['Date', 'Credit', 'Debit']);
  assert.deepEqual(html.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: htmlPath, detailRows: html }]).dropPlan, [[5]]);
});

test('buildMappedRows：1904 日期系统的工作簿与 1900 日期系统的不互判重复；纵向合并单元格的从属行不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-date-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  const write = (name, rows, { date1904 = false, merges = [] } = {}) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    if (merges.length) sheet['!merges'] = merges.map((ref) => XLSX.utils.decode_range(ref));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    if (date1904) workbook.Workbook = { ...(workbook.Workbook || {}), WBProps: { date1904: true } };
    const filePath = path.join(dir, name);
    XLSX.writeFile(workbook, filePath);
    return filePath;
  };
  const rows = [['日期', '收入', '支出', '流水号'], [45000, '100', '', 'R1']];
  const file1900 = write('d1900.xlsx', rows);
  const file1904 = write('d1904.xlsx', rows, { date1904: true });
  const file1904Copy = write('d1904-copy.xlsx', rows, { date1904: true });
  const scan = (files) => scanDuplicateSourceRows(files.map((filePath) => ({ filePath, detailRows: map(filePath) }))).dropPlan;
  assert.deepEqual(scan([file1900, file1904]), [[], []], '日期序号相同但日期系统不同：不是同一账期');
  assert.deepEqual(scan([file1904, file1904Copy]), [[], [2]], '同为 1904 日期系统的副本照常判重复');

  const merged = write('merged.xlsx', [
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 'REF-A'],
    ['2026-11-01', '', '5', ''],
    ['2026-11-01', '100', '', 'REF-B'],
    ['2026-11-01', '', '5', ''],
    ['2026-11-01', '50', '', 'S'],
    ['2026-11-01', '50', '', 'S']
  ], { merges: ['D2:D3', 'D4:D5'] });
  const mapped = map(merged);
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, false, true, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: merged, detailRows: mapped }]).dropPlan, [[7]], '第 5 行（REF-B 的费用）不因与第 3 行相同而去除');
});

test('buildMappedRows：XLSX / XLS 按数字格式区分显示文本不同的值；文本型文件以 = 开头的单元格（Excel 按公式计算）不参与查重', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-format-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers = ['日期', '收入', '支出', '流水号']) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers.slice(0, 3),
    duplicateRowKeys: true
  });
  const sheet = XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 123],
    ['2026-11-01', '100', '', 123],
    ['2026-11-01', '50', '', 7],
    ['2026-11-01', '50', '', 7]
  ]);
  sheet.D2.z = '"TX-A-"0000';
  sheet.D3.z = '"TX-B-"0000';
  sheet.D4.z = '"TX-C-"0000';
  sheet.D5.z = '"TX-C-"0000';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  for (const [name, bookType] of [['format.xlsx', 'xlsx'], ['format.xls', 'biff8']]) {
    const filePath = path.join(dir, name);
    XLSX.writeFile(workbook, filePath, { bookType });
    assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: map(filePath) }]).dropPlan, [[5]], `${name}：只有格式也相同的第 4、5 行判为重复`);
  }

  const tsvPath = path.join(dir, 'formula.xls');
  fs.writeFileSync(tsvPath, 'Date\tCredit\tDebit\tRef\n20261101\t100\t\t="TX-"&ROW()&"-A"\n20261101\t100\t\t="TX-"&ROW()&"-A"\n20261101\t50\t\tS\n20261101\t50\t\tS\n');
  const csvPath = path.join(dir, 'formula.csv');
  fs.writeFileSync(csvPath, 'Date,Credit,Debit,Ref\n20261101,100,,"=""TX-""&ROW()"\n20261101,100,,"=""TX-""&ROW()"\n20261101,50,,S\n20261101,50,,S\n');
  for (const filePath of [tsvPath, csvPath]) {
    const mapped = map(filePath, ['Date', 'Credit', 'Debit', 'Ref']);
    assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true], filePath);
    assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], filePath);
  }
});

test('buildMappedRows：HTML 表格声明的字符编码不同时，相同的行字节不跨文件判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-charset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const html = (charset) => Buffer.concat([
    Buffer.from(`<html><head><meta charset="${charset}"></head><body><table><tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr><tr><td>20261101</td><td>100</td><td></td><td>`, 'latin1'),
    Buffer.from([0xC3, 0xA9]),
    Buffer.from('</td></tr></table></body></html>', 'latin1')
  ]);
  const files = [['utf8.xls', 'utf-8'], ['cp1252.xls', 'windows-1252'], ['utf8-copy.xls', 'utf-8']].map(([name, charset]) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, html(charset));
    return filePath;
  });
  const entries = files.map((filePath) => ({ filePath, detailRows: buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Credit', 'Debit'],
    duplicateRowKeys: true
  }) }));
  assert.deepEqual(scanDuplicateSourceRows(entries).dropPlan, [[], [], [2]], '只有同为 UTF-8 的副本判重复');
});

test('buildMappedRows：XLSX 带数字格式的条件格式覆盖的行不参与查重（只改颜色的条件格式不影响）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-cf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'],
    ['2026-11-01', '100', '', 123],
    ['2026-11-01', '100', '', 123],
    ['2026-11-01', '50', '', 7],
    ['2026-11-01', '50', '', 7]
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patch = (suffix, replace) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix))];
    const xml = replace(Buffer.from(entry.content).toString('utf8'));
    entry.content = Buffer.from(xml, 'utf8');
    entry.size = entry.content.length;
    return xml;
  };
  // dxf 0 带数字格式（第 2 行显示为 TX-A-0123），dxf 1 只改填充色（第 4、5 行）
  patch('xl/styles.xml', (xml) => xml.replace('<dxfs count="0"/>',
    '<dxfs count="2"><dxf><numFmt numFmtId="200" formatCode="&quot;TX-A-&quot;0000"/></dxf><dxf><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></dxf></dxfs>'));
  const sheetXml = patch('xl/worksheets/sheet1.xml', (xml) => xml.replace('</sheetData>',
    '</sheetData><conditionalFormatting sqref="D2"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting>'
    + '<conditionalFormatting sqref="D4:D5"><cfRule type="expression" dxfId="1" priority="2"><formula>TRUE</formula></cfRule></conditionalFormatting>'));
  assert.match(sheetXml, /conditionalFormatting sqref="D2"/);
  const filePath = path.join(dir, 'cf.xlsx');
  fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: ['日期', '收入', '支出', '流水号'],
    duplicateRowKeys: true
  });
  assert.deepEqual(mapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, true, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath, detailRows: mapped }]).dropPlan, [[5]], '第 3 行不因与第 2 行底值相同而去除');
});

test('buildMappedRows：XLSX 没有样式表部件（可选部件）时照常查重；条件格式块的结束标签带空白时照常识别覆盖的行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-no-styles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = ['日期', '收入', '支出', '流水号'];
  const build = (name, patches) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ['2026-11-01', '100', '', 123], ['2026-11-01', '100', '', 123]]), 'Sheet1');
    const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    Object.entries(patches).forEach(([suffix, replace]) => {
      const index = cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix));
      if (replace === null) {
        cfb.FileIndex.splice(index, 1);
        cfb.FullPaths.splice(index, 1);
        return;
      }
      const entry = cfb.FileIndex[index];
      entry.content = Buffer.from(replace(Buffer.from(entry.content).toString('utf8')), 'utf8');
      entry.size = entry.content.length;
    });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
    return buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
      mappingByField: { BillDate: '日期', MerchantId: '__FIXED__:ACC1', 'Credit Amount': '收入', 'Debit Amount': '支出' },
      expectedSourceHeaders: header,
      duplicateRowKeys: true
    });
  };
  const noStyles = build('no-styles.xlsx', {
    'xl/styles.xml': null,
    'xl/_rels/workbook.xml.rels': (xml) => xml.replace(/<Relationship [^>]*Type="[^"]*\/styles"[^>]*\/>/, ''),
    '[Content_Types].xml': (xml) => xml.replace(/<Override PartName="\/xl\/styles\.xml"[^>]*\/>/, ''),
    'xl/worksheets/sheet1.xml': (xml) => xml.replace(/ s="\d+"/g, '')
  });
  assert.deepEqual(noStyles.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, true]);
  // 条件格式（dxf 0 把第 2 行的流水号显示为 TX-A-0123）的结束标签带空白
  const spacedClosing = build('cf-spaced.xlsx', {
    'xl/styles.xml': (xml) => xml.replace('<dxfs count="0"/>', '<dxfs count="1"><dxf><numFmt numFmtId="200" formatCode="&quot;TX-A-&quot;0000"/></dxf></dxfs>'),
    'xl/worksheets/sheet1.xml': (xml) => xml.replace('</sheetData>',
      '</sheetData><conditionalFormatting sqref="D2"><cfRule type="expression" dxfId="0" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting >')
  });
  assert.deepEqual(spacedClosing.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, true]);
});

test('buildMappedRows：HTML 样式表（mso-number-format）不同的文件不互判重复；CSV 以 +、-、@ 开头的公式不参与，普通带符号金额照常比较', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-style-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const html = (format) => `<html><head><style>.id{mso-number-format:"\\"${format}\\"0000"}</style></head><body><table>`
    + '<tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr><tr><td>20261101</td><td>100</td><td></td><td class="id">123</td></tr></table></body></html>';
  const files = [['a.xls', 'TX-A-'], ['b.xls', 'TX-B-'], ['a-copy.xls', 'TX-A-']].map(([name, format]) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, html(format));
    return filePath;
  });
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  assert.deepEqual(scanDuplicateSourceRows(files.map((filePath) => ({ filePath, detailRows: map(filePath, ['Date', 'Credit', 'Debit']) }))).dropPlan,
    [[], [], [2]], '只有样式也相同的副本判重复');

  const csvPath = path.join(dir, 'signed.csv');
  fs.writeFileSync(csvPath, 'Date,Credit,Debit,Ref\n20261101,100,,+ROW()\n20261101,100,,+ROW()\n20261101,-50,,-\n20261101,-50,,-\n');
  const csv = map(csvPath, ['Date', 'Credit', 'Debit']);
  assert.deepEqual(csv.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: csvPath, detailRows: csv }]).dropPlan, [[5]]);
});

test('buildMappedRows：HTML 行样式（<tr class>）不同的行不互判重复；带符号科学计数法是数值，照常参与查重；XLSX 行号重复声明（含公式行）时整张表不参与', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r19-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const htmlPath = path.join(dir, 'rows.xls');
  fs.writeFileSync(htmlPath, '<html><body><table><tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr>'
    + '<tr class="a"><td>20261101</td><td>100</td><td></td><td>123</td></tr><tr class="b"><td>20261101</td><td>100</td><td></td><td>123</td></tr>'
    + '<tr class="c"><td>20261101</td><td>50</td><td></td><td>7</td></tr><tr class="c"><td>20261101</td><td>50</td><td></td><td>7</td></tr></table></body></html>');
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: htmlPath, detailRows: map(htmlPath, ['Date', 'Credit', 'Debit']) }]).dropPlan, [[5]]);

  const csvPath = path.join(dir, 'sci.csv');
  fs.writeFileSync(csvPath, 'Date,Credit,Debit,Rate\n20261101,100,,-1.2E-4\n20261101,100,,-1.2E-4\n20261101,50,,-A1\n20261101,50,,-A1\n');
  const csv = map(csvPath, ['Date', 'Credit', 'Debit']);
  assert.deepEqual(csv.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, true, false, false]);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: csvPath, detailRows: csv }]).dropPlan, [[3]]);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出'], ['2026-11-01', '100', ''], ['2026-11-01', '50', ''], ['2026-11-01', '50', '']
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith('xl/worksheets/sheet1.xml'))];
  const xml = Buffer.from(entry.content).toString('utf8')
    .replace('<row r="2">', '<row r="2"><c r="D2"><f>ROW()</f><v>2</v></c></row><row r="2">');
  assert.match(xml, /<row r="2"><c r="D2"><f>/);
  entry.content = Buffer.from(xml, 'utf8');
  entry.size = entry.content.length;
  const xlsxPath = path.join(dir, 'dup-rows.xlsx');
  fs.writeFileSync(xlsxPath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const xlsx = map(xlsxPath, ['日期', '收入', '支出']);
  assert.ok(xlsx.rowMetas.every((meta) => !meta.sourceRowKey), '行号重复声明时整张表不参与');
});

test('buildMappedRows：XLSX 继承行样式的数字格式不同的行不互判重复；HTML 注释里的样式表、根元素声明 SpreadsheetML 命名空间的 HTML、CSV 中原有的替换字符', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r20-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  // XLSX：第 2、3 行流水号底值都是 123，数字格式来自整行样式（单元格自身没有样式）
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'], ['2026-11-01', '100', '', 123], ['2026-11-01', '100', '', 123], ['2026-11-01', '50', '', 7], ['2026-11-01', '50', '', 7]
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patch = (suffix, replace) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix))];
    const xml = replace(Buffer.from(entry.content).toString('utf8'));
    entry.content = Buffer.from(xml, 'utf8');
    entry.size = entry.content.length;
    return xml;
  };
  patch('xl/styles.xml', (xml) => replaceNumFmts(xml, '<numFmt numFmtId="201" formatCode="&quot;TX-A-&quot;0000"/><numFmt numFmtId="202" formatCode="&quot;TX-B-&quot;0000"/>')
    
    .replace(/<cellXfs count="1">(<xf [^>]*\/>)<\/cellXfs>/, '<cellXfs count="3">$1<xf numFmtId="201" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="202" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'));
  const sheetXml = patch('xl/worksheets/sheet1.xml', (xml) => xml
    .replace('<row r="2">', '<row r="2" s="1" customFormat="1">').replace('<row r="3">', '<row r="3" s="2" customFormat="1">'));
  assert.match(sheetXml, /<row r="3" s="2" customFormat="1">/);
  const xlsxPath = path.join(dir, 'row-style.xlsx');
  fs.writeFileSync(xlsxPath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: xlsxPath, detailRows: map(xlsxPath, ['日期', '收入', '支出']) }]).dropPlan, [[5]],
    '第 3 行不因底值与第 2 行相同而去除');

  // HTML：样式表写在注释里，仅流水号格式前缀不同的两份文件不互判重复，完全相同的副本照常判重复
  const html = (prefix) => `<html><head><style><!-- .id{mso-number-format:"\\"${prefix}\\"0000"} --></style></head><body><table>`
    + '<tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr><tr><td>20261101</td><td>100</td><td></td><td class="id">123</td></tr></table></body></html>';
  const htmlFiles = [['a.xls', 'TX-A-'], ['b.xls', 'TX-B-'], ['a-copy.xls', 'TX-A-']].map(([name, prefix]) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, html(prefix));
    return filePath;
  });
  assert.deepEqual(scanDuplicateSourceRows(htmlFiles.map((filePath) => ({ filePath, detailRows: map(filePath, ['Date', 'Credit', 'Debit']) }))).dropPlan,
    [[], [], [2]]);

  // 根元素声明 SpreadsheetML 命名空间的 HTML 表格照常参与查重
  const nsPath = path.join(dir, 'ns.xls');
  fs.writeFileSync(nsPath, '<html xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><body><table><tr><td>Date</td><td>Credit</td><td>Debit</td></tr>'
    + '<tr><td>20261101</td><td>100</td><td></td></tr><tr><td>20261101</td><td>100</td><td></td></tr></table></body></html>');
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: nsPath, detailRows: map(nsPath, ['Date', 'Credit', 'Debit']) }]).dropPlan, [[3]]);

  // CSV 是合法 UTF-8，但单元格里原本就有替换字符（上游解码丢失后写入）：无法证明替换前相同，不参与查重
  const csvPath = path.join(dir, 'replacement.csv');
  fs.writeFileSync(csvPath, 'Date,Credit,Debit,Ref\n20261101,100,,TX�\n20261101,100,,TX�\n20261101,50,,S\n20261101,50,,S\n', 'utf8');
  const csv = map(csvPath, ['Date', 'Credit', 'Debit']);
  assert.deepEqual(csv.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [false, false, true, true]);
});

test('buildMappedRows：XLSX / XLS 含替换字符的文本不参与查重；XLSX 命名样式继承的数字格式不同的行、HTML 不同 <tbody> 分组的行不互判重复', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r21-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const replacement = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(replacement, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'], ['2026-11-01', '100', '', 'TX�'], ['2026-11-01', '100', '', 'TX�']
  ]), 'Sheet1');
  for (const [name, bookType] of [['fffd.xlsx', 'xlsx'], ['fffd.xls', 'biff8']]) {
    const filePath = path.join(dir, name);
    XLSX.writeFile(replacement, filePath, { bookType });
    assert.ok(map(filePath, ['日期', '收入', '支出']).rowMetas.every((meta) => !meta.sourceRowKey), name);
  }

  // 命名样式继承：单元格样式 applyNumberFormat="0"，显示格式取自 cellStyleXfs 中的 A-0000 / B-0000
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'], ['2026-11-01', '100', '', 123], ['2026-11-01', '100', '', 123], ['2026-11-01', '50', '', 7], ['2026-11-01', '50', '', 7]
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patch = (suffix, replace) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix))];
    const xml = replace(Buffer.from(entry.content).toString('utf8'));
    entry.content = Buffer.from(xml, 'utf8');
    entry.size = entry.content.length;
    return xml;
  };
  const stylesXml = patch('xl/styles.xml', (xml) => replaceNumFmts(xml, '<numFmt numFmtId="201" formatCode="&quot;A-&quot;0000"/><numFmt numFmtId="202" formatCode="&quot;B-&quot;0000"/>')
    
    .replace(/<cellStyleXfs count="1">(<xf [^>]*\/>)<\/cellStyleXfs>/, '<cellStyleXfs count="3">$1<xf numFmtId="201" fontId="0" fillId="0" borderId="0"/><xf numFmtId="202" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>')
    .replace(/<cellXfs count="1">(<xf [^>]*\/>)<\/cellXfs>/, '<cellXfs count="3">$1<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="1" applyNumberFormat="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="2" applyNumberFormat="0"/></cellXfs>'));
  assert.match(stylesXml, /<cellStyleXfs count="3">/);
  patch('xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="D2"/, '<c r="D2" s="1"').replace(/<c r="D3"/, '<c r="D3" s="2"'));
  const stylePath = path.join(dir, 'named-style.xlsx');
  fs.writeFileSync(stylePath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: stylePath, detailRows: map(stylePath, ['日期', '收入', '支出']) }]).dropPlan, [[5]]);

  // HTML：两个 <tbody> 的 class 不同（样式表按分组设置流水号格式），相同标记的行不互判重复
  const htmlPath = path.join(dir, 'tbody.xls');
  fs.writeFileSync(htmlPath, '<html><head><style>.a td{mso-number-format:"\\"TX-A-\\"0000"} .b td{mso-number-format:"\\"TX-B-\\"0000"}</style></head><body><table>'
    + '<thead><tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr></thead>'
    + '<tbody class="a"><tr><td>20261101</td><td>100</td><td></td><td>123</td></tr></tbody>'
    + '<tbody class="b"><tr><td>20261101</td><td>100</td><td></td><td>123</td></tr><tr><td>20261101</td><td>50</td><td></td><td>7</td></tr><tr><td>20261101</td><td>50</td><td></td><td>7</td></tr></tbody></table></body></html>');
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: htmlPath, detailRows: map(htmlPath, ['Date', 'Credit', 'Debit']) }]).dropPlan, [[5]]);
});

test('buildMappedRows：分隔符文本按解码方式区分（无 BOM 的 café 与带 BOM 的 cafÃ© 不互判重复）；XLSX applyNumberFormat、XLS 常规格式的类型都计入；列名形如逻辑取值标记时照旧直接读该列', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r22-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers, mapping = null) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: mapping || { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  // 分隔符文本：两份文件读出的文本相同（cafÃ©），原始字节不同
  const plain = path.join(dir, 'plain.xls');
  fs.writeFileSync(plain, Buffer.concat([Buffer.from('Date\tCredit\tDebit\tRef\n20261101\t100\t\t', 'latin1'), Buffer.from('café', 'utf8'), Buffer.from('\n', 'latin1')]));
  const bom = path.join(dir, 'bom.xls');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Date\tCredit\tDebit\tRef\n20261101\t100\t\tcafÃ©\n', 'utf8')]));
  assert.deepEqual(scanDuplicateSourceRows([plain, bom].map((filePath) => ({ filePath, detailRows: map(filePath, ['Date', 'Credit', 'Debit']) }))).dropPlan,
    [[], []]);
  // 无 BOM 文件中原有的替换字符（字节 EF BF BD）同样不参与查重
  const replaced = path.join(dir, 'replaced.xls');
  fs.writeFileSync(replaced, Buffer.concat([Buffer.from('Date\tCredit\tDebit\tRef\n', 'latin1'),
    ...[0, 1].map(() => Buffer.concat([Buffer.from('20261101\t100\t\tTX', 'latin1'), Buffer.from([0xEF, 0xBF, 0xBD]), Buffer.from('\n', 'latin1')]))]));
  assert.ok(map(replaced, ['Date', 'Credit', 'Debit']).rowMetas.every((meta) => !meta.sourceRowKey));

  // XLSX：两个单元格样式的自身格式（TX-B）与命名样式格式（TX-A）都相同，只有 applyNumberFormat 不同
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'], ['2026-11-01', '100', '', 123], ['2026-11-01', '100', '', 123], ['2026-11-01', '50', '', 7], ['2026-11-01', '50', '', 7]
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patch = (suffix, replace) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix))];
    entry.content = Buffer.from(replace(Buffer.from(entry.content).toString('utf8')), 'utf8');
    entry.size = entry.content.length;
  };
  patch('xl/styles.xml', (xml) => replaceNumFmts(xml, '<numFmt numFmtId="201" formatCode="&quot;TX-A-&quot;0000"/><numFmt numFmtId="202" formatCode="&quot;TX-B-&quot;0000"/>')
    
    .replace(/<cellStyleXfs count="1">(<xf [^>]*\/>)<\/cellStyleXfs>/, '<cellStyleXfs count="2">$1<xf numFmtId="201" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>')
    .replace(/<cellXfs count="1">(<xf [^>]*\/>)<\/cellXfs>/, '<cellXfs count="3">$1<xf numFmtId="202" fontId="0" fillId="0" borderId="0" xfId="1" applyNumberFormat="0"/><xf numFmtId="202" fontId="0" fillId="0" borderId="0" xfId="1" applyNumberFormat="1"/></cellXfs>'));
  patch('xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="D2"/, '<c r="D2" s="1"').replace(/<c r="D3"/, '<c r="D3" s="2"'));
  const applyPath = path.join(dir, 'apply.xlsx');
  fs.writeFileSync(applyPath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: applyPath, detailRows: map(applyPath, ['日期', '收入', '支出']) }]).dropPlan, [[5]]);

  // XLS：布尔值 TRUE 与文本 true 不同
  const xlsSheet = XLSX.utils.aoa_to_sheet([['日期', '收入', '支出', '标志'], ['2026-11-01', '100', '', true], ['2026-11-01', '100', '', 'true']]);
  const xlsBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xlsBook, xlsSheet, 'Sheet1');
  const xlsPath = path.join(dir, 'bool.xls');
  XLSX.writeFile(xlsBook, xlsPath, { bookType: 'biff8' });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: xlsPath, detailRows: map(xlsPath, ['日期', '收入', '支出']) }]).dropPlan, [[]]);

  // 旧模板直接映射的列名恰好形如逻辑取值标记：照旧读该列，不当作候补字段
  const tokenColumn = '__LOGIC_VALUE__:["Credit","Backup"]';
  const tokenBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tokenBook, XLSX.utils.aoa_to_sheet([['Date', 'Credit', tokenColumn, 'Debit'], ['2026-11-01', '2', '100', '']]), 'Sheet1');
  const tokenPath = path.join(dir, 'token.xlsx');
  XLSX.writeFile(tokenBook, tokenPath);
  const tokenMapped = buildMappedRows({
    inputFilePath: tokenPath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: 'Date', MerchantId: '__FIXED__:ACC1', 'Credit Amount': tokenColumn, 'Debit Amount': 'Debit' },
    expectedSourceHeaders: ['Date', 'Credit', tokenColumn, 'Debit']
  });
  assert.equal(tokenMapped[1][tokenMapped[0].indexOf('Credit Amount')], '100');
});

test('buildMappedRows：XLSX 格式代码引号内含 > 时按完整属性读取（A-、B- 前缀不互判重复）；HTML 引用外部样式表时整张表不参与', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r23-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['日期', '收入', '支出', '流水号'], ['2026-11-01', '100', '', 123], ['2026-11-01', '100', '', 123], ['2026-11-01', '50', '', 7], ['2026-11-01', '50', '', 7]
  ]), 'Sheet1');
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const patch = (suffix, replace) => {
    const entry = cfb.FileIndex[cfb.FullPaths.findIndex((fullPath) => fullPath.endsWith(suffix))];
    entry.content = Buffer.from(replace(Buffer.from(entry.content).toString('utf8')), 'utf8');
    entry.size = entry.content.length;
  };
  patch('xl/styles.xml', (xml) => replaceNumFmts(xml, '<numFmt numFmtId="201" formatCode="[>0]&quot;A-&quot;000;General"/><numFmt numFmtId="202" formatCode="[>0]&quot;B-&quot;000;General"/>')
    
    .replace(/<cellXfs count="1">(<xf [^>]*\/>)<\/cellXfs>/, '<cellXfs count="3">$1<xf numFmtId="201" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="202" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'));
  patch('xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="D2"/, '<c r="D2" s="1"').replace(/<c r="D3"/, '<c r="D3" s="2"'));
  const formatPath = path.join(dir, 'gt-format.xlsx');
  fs.writeFileSync(formatPath, XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip' }));
  const formatMapped = map(formatPath, ['日期', '收入', '支出']);
  // 读出完整的格式代码：第 2、3 行照常参与查重，且因格式不同不互判重复
  assert.deepEqual(formatMapped.rowMetas.map((meta) => Boolean(meta.sourceRowKey)), [true, true, true, true]);
  assert.notEqual(formatMapped.rowMetas[0].sourceRowKey, formatMapped.rowMetas[1].sourceRowKey);
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: formatPath, detailRows: formatMapped }]).dropPlan, [[5]]);

  const htmlPath = path.join(dir, 'linked.xls');
  fs.writeFileSync(htmlPath, '<html><head><link rel="stylesheet" href="style.css"></head><body><table><tr><td>Date</td><td>Credit</td><td>Debit</td></tr>'
    + '<tr><td>20261101</td><td>100</td><td></td></tr><tr><td>20261101</td><td>100</td><td></td></tr></table></body></html>');
  assert.ok(map(htmlPath, ['Date', 'Credit', 'Debit']).rowMetas.every((meta) => !meta.sourceRowKey));
});

test('buildMappedRows：HTML 表格行内有（条件）注释时整张表不参与；XLS 含 Excel 2007 条件格式记录（CF12）时整张表不参与', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-source-rows-r24-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = (filePath, headers) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: headers[0], MerchantId: '__FIXED__:ACC1', 'Credit Amount': headers[1], 'Debit Amount': headers[2] },
    expectedSourceHeaders: headers,
    duplicateRowKeys: true
  });
  const htmlPath = path.join(dir, 'conditional.xls');
  fs.writeFileSync(htmlPath, '<html><body><table><tr><td>Date</td><td>Credit</td><td>Debit</td><td>Ref</td></tr>'
    + '<tr><td>20261101</td><td>100</td><td></td><td><!--[if gte mso 9]>TX-A<![endif]--></td></tr>'
    + '<tr><td>20261101</td><td>100</td><td></td><td><!--[if gte mso 9]>TX-B<![endif]--></td></tr></table></body></html>');
  assert.ok(map(htmlPath, ['Date', 'Credit', 'Debit']).rowMetas.every((meta) => !meta.sourceRowKey));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['日期', '收入', '支出'], ['2026-11-01', '100', ''], ['2026-11-01', '100', '']]), 'Sheet1');
  const plainPath = path.join(dir, 'plain.xls');
  XLSX.writeFile(workbook, plainPath, { bookType: 'biff8' });
  assert.deepEqual(scanDuplicateSourceRows([{ filePath: plainPath, detailRows: map(plainPath, ['日期', '收入', '支出']) }]).dropPlan, [[3]]);
  // 在工作簿流末尾追加一条 CF12（0x087A）记录
  const cfb = XLSX.CFB.read(fs.readFileSync(plainPath), { type: 'buffer' });
  const entry = XLSX.CFB.find(cfb, 'Workbook');
  entry.content = Buffer.concat([Buffer.from(entry.content), Buffer.from([0x7A, 0x08, 0x00, 0x00])]);
  entry.size = entry.content.length;
  const cfPath = path.join(dir, 'cf12.xls');
  fs.writeFileSync(cfPath, XLSX.CFB.write(cfb, { type: 'buffer' }));
  assert.ok(map(cfPath, ['日期', '收入', '支出']).rowMetas.every((meta) => !meta.sourceRowKey));
});
