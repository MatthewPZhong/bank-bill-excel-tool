'use strict';

// 仿 KBANK-VN 结构的网银账单（表头含合并单元格占位的中间空列、账单日期列放「Tổng / Total」的合计行）：
//   - 带金额的合计行按合计行跳过并记入 issues，不再整份拒绝；明细只含真实交易，借贷合计与合计行一致；
//   - 合计标签只做整格比较，包含字样或其他无效日期仍整份拒绝；无金额的合计标签行保持原有的收支为空过滤；
//   - 账号识别的表头定位与读取同口径，表头前的账号可精确识别；导入提示列出被跳过的合计行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const XLSX = require('xlsx');

const {
  buildDetailExportRows,
  buildExpectedHeaderCandidates,
  buildMappedRows,
  FileValidationError,
  normalizeCell
} = require('../../../src/backend/file-service');
const { matchMerchantIds, resolveRecognizedBigAccount } = require('../../../src/main-process/big-account-recognition');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const MAIN_DEPS = {
  buildExpectedHeaderCandidates,
  normalizeCell,
  matchMerchantIds,
  fs,
  FileValidationError,
  SUPPORTED_BUNDLE_VERSION: 5,
  normalizeBundleAccountMappings: () => []
};

function loadMainFunction(name) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  if (!node) throw new Error(`未找到函数：${name}`);
  return Function(...Object.keys(MAIN_DEPS), `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(
    ...Object.values(MAIN_DEPS)
  );
}

for (const name of [
  'findHeaderRowNumbersInRawRows',
  'findBigAccountMatchInRows',
  'buildBigAccountRecognitionBasis',
  'normalizeBundleTemplateHeaders',
  'readTemplateBundleFile'
]) {
  MAIN_DEPS[name] = loadMainFunction(name);
}

const HEADER = [
  'STT\nNo.', 'Ngày giao dịch\nTransaction Date', 'Thời gian giao dịch\nTransaction Time', '',
  'Số tiền ghi nợ\nDebit Amount', '', '', 'Số tiền ghi có\nCredit Amount', 'Số dư\nBalance',
  '', '', '', '', 'Diễn giải\nDescription'
];
const MAPPING = {
  BillDate: HEADER[1],
  'Debit Amount': HEADER[4],
  'Credit Amount': HEADER[7],
  Balance: HEADER[8],
  'Transaction Description': HEADER[13],
  MerchantId: '__FIXED__:__MULTI_BIG_ACCOUNT__',
  Currency: ''
};
const ORDERED_FIELDS = Object.keys(MAPPING);
const ACCOUNT = '900000000001';
const OFFSET = 2;

function relativeRow(values) {
  const cells = new Array(HEADER.length).fill('');
  Object.entries(values).forEach(([index, value]) => {
    cells[Number(index)] = value;
  });
  return [...new Array(OFFSET).fill(''), ...cells];
}

// 返回 { rows, totalRowNumber }：账户信息区 → 表头 → 期初余额 → 3 笔交易 → 合计 → 期末余额 → 页脚。
function statementRows({ totalLabel = 'Tổng / Total', totalDebit = '120', totalCredit = '50' } = {}) {
  const rows = [
    ['', '', '', '', '', '', '', 'LỊCH SỬ TÀI KHOẢN / ACCOUNT HISTORY'],
    ['', 'Tên tài khoản / Account name', '', '', '', 'Công ty mẫu'],
    ['', 'Số tài khoản / Account number', '', '', '', ACCOUNT, '', '', 'Loại tiền / Currency', '', '', '', '', 'VND'],
    [],
    ['', '', ...HEADER],
    relativeRow({ 0: 'Số dư ban đầu / Previous Balance', 8: '1,000' }),
    relativeRow({ 0: 1, 1: '01/10/2026', 2: '09:00:00', 4: '100', 7: '0', 8: '900' }),
    relativeRow({ 0: 2, 1: '15/10/2026', 2: '10:00:00', 4: '0', 7: '50', 8: '950' }),
    relativeRow({ 0: 3, 1: '31/10/2026', 2: '11:00:00', 4: '20', 7: '0', 8: '930' }),
    relativeRow({ 1: totalLabel, 4: totalDebit, 7: totalCredit }),
    relativeRow({ 0: 'Số dư hiện tại / Current Balance', 8: '930' }),
    [],
    ['', 'The document had been exported via KBank Connect', '', '', '', '', '', '', '', '', '', '', '', '', 'Page 1']
  ];
  return { rows, totalRowNumber: 10 };
}

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-summary-row-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, fileName, rows) {
  const filePath = path.join(dir, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'LichSuTaiKhoan');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function mapStatement(filePath, extra = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: MAPPING,
    expectedSourceHeaders: HEADER,
    selectedBigAccount: { merchantId: ACCOUNT, currency: 'VND' },
    ...extra
  });
}

function summaryIssues(mappedRows) {
  return (mappedRows.issues || []).filter((issue) => issue.type === 'summary-row-skipped');
}

test('带金额的合计行按合计行跳过并记录；明细只含 3 笔交易，日期按日/月/年，借贷合计与合计行一致', (t) => {
  const dir = createTempDir(t);
  const { rows, totalRowNumber } = statementRows();
  const mapped = mapStatement(writeXlsx(dir, 'AccountHistory.xlsx', rows));

  assert.deepEqual(summaryIssues(mapped), [
    { type: 'summary-row-skipped', rowNumber: totalRowNumber, rawValue: 'Tổng / Total' }
  ]);
  assert.ok(!mapped.rowMetas.some((meta) => meta.sourceRowNumber === totalRowNumber));

  const detail = buildDetailExportRows(mapped);
  const field = (name) => detail.sourceRows[0].indexOf(name);
  const transactions = detail.sourceRows.slice(1);
  assert.deepEqual(transactions.map((row) => row[field('BillDate')]), ['2026-10-01', '2026-10-15', '2026-10-31']);
  assert.deepEqual(transactions.map((row) => row[field('Currency')]), ['VND', 'VND', 'VND']);
  assert.deepEqual(transactions.map((row) => row[field('MerchantId')]), [ACCOUNT, ACCOUNT, ACCOUNT]);
  const sum = (name) => transactions.reduce((total, row) => total + Number(row[field(name)] || 0), 0);
  assert.equal(sum('Debit Amount'), 120);
  assert.equal(sum('Credit Amount'), 50);
  // 期初/期末余额行与页脚收支为空，仍按原规则过滤。
  assert.deepEqual(detail.skippedRows.map((row) => row.sourceRowNumber), [6, 11, 13]);
});

test('合计标签整格比较：忽略大小写、斜杠两侧空格与组合字符差异', (t) => {
  const dir = createTempDir(t);
  const labels = ['TỔNG / TOTAL', 'Tổng/Total', 'Tổng / Total'.normalize('NFD'), 'Total', '合计'];

  labels.forEach((label, index) => {
    const { rows, totalRowNumber } = statementRows({ totalLabel: label });
    const mapped = mapStatement(writeXlsx(dir, `label-${index}.xlsx`, rows));
    assert.deepEqual(summaryIssues(mapped).map((issue) => issue.rowNumber), [totalRowNumber], label);
  });
});

test('只包含合计字样或不是合计标签的无效日期仍整份拒绝', (t) => {
  const dir = createTempDir(t);

  ['Total payment', 'Tổng số dư', '2026-10-32'].forEach((label, index) => {
    const { rows, totalRowNumber } = statementRows({ totalLabel: label });
    assert.throws(() => mapStatement(writeXlsx(dir, `invalid-${index}.xlsx`, rows)), (error) => {
      assert.ok(error instanceof FileValidationError);
      assert.equal(error.code, 'FILE_READ');
      assert.deepEqual(error.detailLines, [`第 ${totalRowNumber} 行：${label}`]);
      return true;
    });
  });
});

test('无金额的合计标签行保持原路径：不记合计行，按收支为空过滤', (t) => {
  const dir = createTempDir(t);
  const { rows, totalRowNumber } = statementRows({ totalDebit: '0', totalCredit: '' });
  const mapped = mapStatement(writeXlsx(dir, 'zero-total.xlsx', rows));

  assert.deepEqual(summaryIssues(mapped), []);
  assert.ok(buildDetailExportRows(mapped).skippedRows.some((row) => row.sourceRowNumber === totalRowNumber));
});

test('收支按条件拆分时，被跳过的合计行不计入命中统计', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '方向', '金额', '余额'];
  const filePath = writeXlsx(dir, 'split.xlsx', [
    header,
    ['2026-10-01', '收', '100', '100'],
    ['2026-10-02', '支', '30', '70'],
    ['合计', '收', '100', '']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Debit Amount', 'Balance'],
    mappingByField: { BillDate: '日期', Balance: '余额' },
    expectedSourceHeaders: header,
    amountSplitByField: {
      enabled: true,
      rules: [
        { conditionField: '方向', conditionValue: '收', mappedField: '金额', targetField: 'Credit Amount' },
        { conditionField: '方向', conditionValue: '支', mappedField: '金额', targetField: 'Debit Amount' }
      ]
    }
  });

  assert.equal(mapped.length, 3);
  assert.deepEqual(summaryIssues(mapped).map((issue) => issue.rowNumber), [4]);
  assert.equal(mapped.amountSplitMatchStats.hitCredit, 1);
  assert.equal(mapped.amountSplitMatchStats.hitDebit, 1);
});

test('账单拆分不复用主映射时，按实际生效的拆分日期列判定合计行', (t) => {
  const dir = createTempDir(t);
  const header = ['主日期', '拆分日期', 'Curr', '收入', '支出'];
  const filePath = writeXlsx(dir, 'bill-split.xlsx', [
    header,
    ['Total', '2026-10-02', 'USD', '200', ''],
    ['2026-10-03', 'Total', 'USD', '999', '']
  ]);
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '主日期', Currency: 'Curr', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: header,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '拆分日期', Currency: 'Curr' },
      billSplitRows: [
        { seqNo: 1, rowStatus: 'completed', currencySourceField: 'Curr', creditSourceField: '收入', debitSourceField: '支出', mergedGroupSeq: 1 }
      ],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: []
    }
  });

  // 主日期列是 Total 但拆分日期有效：真实交易保留；拆分日期列是 Total：按合计行跳过。
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2]]), [['2026-10-02', '200']]);
  assert.deepEqual(summaryIssues(mapped).map((issue) => issue.rowNumber), [3]);
});

test('账单拆分的金额只配在拆分行时，按拆分后的金额判定合计行（复用与不复用主映射）', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', 'Curr', '收入1', '支出1', '收入2', '支出2'];
  const filePath = writeXlsx(dir, 'bill-split-amounts.xlsx', [
    header,
    ['2026-10-01', '某币', '100', '', '', '40'],
    ['Tổng / Total', '某币', '100', '', '', '40']
  ]);
  const billSplitRows = [
    { seqNo: 1, rowStatus: 'completed', currencySourceField: 'Curr', creditSourceField: '收入1', debitSourceField: '支出1', mergedGroupSeq: 1 },
    { seqNo: 2, rowStatus: 'completed', currencySourceField: 'Curr', creditSourceField: '收入2', debitSourceField: '支出2', mergedGroupSeq: 2 }
  ];

  for (const reuseModuleMapping of [true, false]) {
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
      mappingByField: { BillDate: '日期', Currency: 'Curr' },
      expectedSourceHeaders: header,
      billSplitMerge: {
        enabled: true,
        reuseModuleMapping,
        billSplitMappingByTargetField: { BillDate: '日期', Currency: 'Curr' },
        billSplitRows,
        billSplitAmountRules: [],
        signedAmountSourceField: '',
        signedAmountTargetSeqNos: [],
        byFieldAmountTargetSeqNos: []
      }
    });

    const label = `reuseModuleMapping=${reuseModuleMapping}`;
    assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 2], label);
    assert.deepEqual(summaryIssues(mapped).map((issue) => issue.rowNumber), [3], label);
    // 合计行映射时产生的币种未匹配提示一并撤回，只留真实交易行的。
    const currencyIssueRows = mapped.issues
      .filter((issue) => issue.type === 'currency-unmapped')
      .map((issue) => issue.rowNumber);
    assert.ok(currencyIssueRows.includes(2), label);
    assert.ok(!currencyIssueRows.includes(3), label);
    assert.equal(mapped.billSplitMatchStats.outputRows, 2, label);
  }
});

test('账单拆分合并组：合计行在合并前判定，不因组内币种不一致报错，也不因净额为 0 被吞掉', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', 'Curr1', 'Curr2', '收入1', '支出1', '收入2', '支出2'];
  const billSplitMerge = {
    enabled: true,
    reuseModuleMapping: true,
    billSplitRows: [
      { seqNo: 1, rowStatus: 'completed', currencySourceField: 'Curr1', creditSourceField: '收入1', debitSourceField: '支出1', mergedGroupSeq: 1 },
      { seqNo: 2, rowStatus: 'completed', currencySourceField: 'Curr2', creditSourceField: '收入2', debitSourceField: '支出2', mergedGroupSeq: 1 }
    ],
    billSplitAmountRules: [],
    signedAmountSourceField: '',
    signedAmountTargetSeqNos: [],
    byFieldAmountTargetSeqNos: []
  };
  const cases = [
    ['currency-mismatch', ['Total', 'USD', 'EUR', '100', '', '', '40']],
    ['net-zero', ['Total', 'USD', 'USD', '100', '', '', '100']]
  ];

  for (const [name, totalRow] of cases) {
    const filePath = writeXlsx(dir, `${name}.xlsx`, [
      header,
      ['2026-10-01', 'USD', 'EUR', '100', '', '', ''],
      ['2026-10-02', 'USD', 'EUR', '', '', '', '40'],
      totalRow
    ]);
    const mapped = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
      mappingByField: { BillDate: '日期' },
      expectedSourceHeaders: header,
      billSplitMerge
    });

    assert.deepEqual(mapped.rowMetas.map((meta) => meta.sourceRowNumber), [2, 3], name);
    assert.deepEqual(summaryIssues(mapped).map((issue) => issue.rowNumber), [4], name);
  }
});

test('模板包导入保留表头空项位置，导入后的模板仍能定位合并单元格表头', (t) => {
  const dir = createTempDir(t);
  const bundlePath = path.join(dir, 'template-library.json');
  fs.writeFileSync(bundlePath, JSON.stringify({
    bundleVersion: 5,
    templates: [
      { templateKey: 'kbank-vn', name: 'KBANK-VN', headers: [...HEADER, '', ''] },
      { templateKey: 'blank', name: '空表头', headers: ['', ' '] }
    ]
  }));

  const [kbank, blank] = MAIN_DEPS.readTemplateBundleFile(bundlePath).templates;

  assert.deepEqual(kbank.headers, HEADER);
  assert.deepEqual(blank.headers, []);
  const { rows } = statementRows();
  const statementPath = writeXlsx(dir, 'AccountHistory.xlsx', rows);
  const detail = buildDetailExportRows(mapStatement(statementPath, { expectedSourceHeaders: kbank.headers }));
  assert.equal(detail.sourceRows.length - 1, 3);
});

test('账号识别的表头定位与读取同口径：定位含中间空列的表头并精确识别表头前的账号', () => {
  const { rows } = statementRows();
  const findHeaderRows = MAIN_DEPS.findHeaderRowNumbersInRawRows;

  assert.deepEqual(findHeaderRows(rows, HEADER), [5]);
  assert.deepEqual(findHeaderRows(rows, ['', '', ...HEADER, '']), [5]);
  // 兼容：模板有中间空项而账单没有这些空列时退回去空口径。
  assert.deepEqual(findHeaderRows([[], HEADER.filter(Boolean)], HEADER), [2]);
  assert.deepEqual(findHeaderRows(rows, []), []);

  const basis = MAIN_DEPS.buildBigAccountRecognitionBasis({ rawRows: rows, expectedSourceHeaders: HEADER });
  assert.deepEqual(basis.headerWindows.map((window) => window.headerRowNumber), [5]);
  const candidates = basis.headerWindows[0].candidateRows;
  const match = MAIN_DEPS.findBigAccountMatchInRows(candidates, 0, candidates.length - 1, [ACCOUNT]);
  assert.deepEqual(match, { merchantId: ACCOUNT, matchType: 'exact' });

  const resolved = resolveRecognizedBigAccount({
    extractedMerchantId: match.merchantId,
    maintainedBigAccounts: [{ merchantId: ACCOUNT, currency: 'VND' }],
    sourceFileName: 'AccountHistory.xlsx',
    templateName: 'KBANK-VN'
  });
  assert.equal(resolved.status, 'ok');
  assert.deepEqual(
    [resolved.selectedBigAccount.merchantId, resolved.selectedBigAccount.currency],
    [ACCOUNT, 'VND']
  );
});

test('导入提示列出被跳过的合计行', () => {
  const buildImportWarningMessage = loadMainFunction('buildImportWarningMessage');
  const buildImportWarningDetailLines = loadMainFunction('buildImportWarningDetailLines');
  const warnings = [
    { type: 'summary-row-skipped', rowNumber: 73, rawValue: 'Tổng / Total' },
    { type: 'detail-row-skipped', rowNumber: 74, creditAmount: '', debitAmount: '' }
  ];

  assert.equal(
    buildImportWarningMessage({ warnings, balanceReady: false, balanceRequested: false }),
    '明细账单可导出，已跳过1条账单自带的合计行，已过滤1条收支均为0或空值的明细，请点击状态框导出报错文件'
  );
  assert.deepEqual(buildImportWarningDetailLines(warnings), [
    '以下行的账单日期列是账单自带的合计标签，按合计行处理，未写入导出的明细账单：',
    '第73行，账单日期列="Tổng / Total"',
    '以下明细记录因 Credit Amount 和 Debit Amount 同时为 0 或空值，未写入导出的明细账单：',
    '第74行，Credit Amount="(空)"，Debit Amount="(空)"'
  ]);
});
