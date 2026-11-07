// 主功能 1「生成网银账单」合并单元格表头与账单合计行集成测试
//   覆盖：
//   1. 用表头在首行的模板样本建模板（extractHeaders），表头含合并单元格占位的中间空列，原样保存 14 项；
//   2. 原始账单表头在第 11 行 C 列、前有账户信息区：模板匹配（与 matchFileToTemplate 同一 reader）命中；
//   3. 首次读取的原始行派生账号识别依据（main.js 真实函数），精确识别表头前的本方账号并解析到维护币种；
//   4. 账单日期列为「Tổng / Total」且带全表总额的合计行按合计行跳过并记录，不再整份拒绝；
//   5. 明细导出写盘再读回：只含真实交易，日期按日/月/年，借贷/余额与原始列逐行一致，借贷合计与合计行一致。
//
// 结构仿 KBANK-VN（KBank Connect 导出）：借方占 G:I、余额占 K:O、描述占 P:R 的合并单元格，
// 中间空项必须按位置参与表头比较，取值下标才与物理列一致。数据为合成样本，不含真实账单。
//
// 用法：node scripts/integration/statement-generation-merged-header-summary-row.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const XLSX = require('xlsx');

const fileService = require('../../src/backend/file-service');
const readers = require('../../src/backend/file-service/readers');
const { matchMerchantIds, resolveRecognizedBigAccount } = require('../../src/main-process/big-account-recognition');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
}

function assertTrue(condition, label) {
  if (condition) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual: condition, expected: true });
}

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const MAIN_DEPS = {
  buildExpectedHeaderCandidates: fileService.buildExpectedHeaderCandidates,
  normalizeCell: fileService.normalizeCell,
  matchMerchantIds
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
  'identifyAccountsFromRecognitionBasis'
]) {
  MAIN_DEPS[name] = loadMainFunction(name);
}

const HEADER_CELLS = {
  0: 'STT\nNo.',
  1: 'Ngày giao dịch\nTransaction Date',
  2: 'Thời gian giao dịch\nTransaction Time',
  4: 'Số tiền ghi nợ\nDebit Amount',
  7: 'Số tiền ghi có\nCredit Amount',
  8: 'Số dư\nBalance',
  13: 'Diễn giải\nDescription'
};
const HEADER_WIDTH = 14;
// 相对表头起点的合并区：时间 E:F、借方 G:I、余额 K:O、描述 P:R（以账单 C 列为起点时）。
const MERGES = [[2, 3], [4, 6], [8, 12], [13, 15]];
const ACCOUNT = '900000000001';
const TRANSACTIONS = [
  { no: 1, date: '01/10/2026', debit: '1,000,000', credit: '0', balance: '9,000,000' },
  { no: 2, date: '02/10/2026', debit: '0', credit: '250,000', balance: '9,250,000' },
  { no: 3, date: '13/10/2026', debit: '50,000', credit: '0', balance: '9,200,000' },
  { no: 4, date: '31/10/2026', debit: '200', credit: '0', balance: '9,199,800' }
];

function relativeRow(offset, values) {
  const cells = new Array(HEADER_WIDTH + 2).fill('');
  Object.entries(values).forEach(([index, value]) => { cells[Number(index)] = value; });
  return [...new Array(offset).fill(''), ...cells];
}

function writeWorkbook(filePath, rows, merges) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!merges'] = merges;
  XLSX.utils.book_append_sheet(workbook, worksheet, 'LichSuTaiKhoan');
  XLSX.writeFile(workbook, filePath);
}

function mergesAt(rowIndex, offset) {
  return MERGES.map(([start, end]) => ({ s: { r: rowIndex, c: offset + start }, e: { r: rowIndex, c: offset + end } }));
}

// 模板样本：表头在 A1，第 2 行是期初余额，与用户裁剪后的样本同构。
function writeTemplateSample(filePath) {
  const rows = [
    relativeRow(0, HEADER_CELLS),
    relativeRow(0, { 0: 'Số dư ban đầu / Previous Balance', 8: '10,000,000' })
  ];
  writeWorkbook(filePath, rows, [...mergesAt(0, 0), ...mergesAt(1, 0)]);
}

// 原始账单：账户信息区在第 6 行（F6 账号、N6 币种），表头在 C11，合计行、期末余额与页脚在交易之后。
function writeStatement(filePath) {
  const rows = [
    ['', '', '', '', '', '', '', 'LỊCH SỬ TÀI KHOẢN / ACCOUNT HISTORY'],
    [],
    [],
    [],
    ['', 'Tên tài khoản / Account name', '', '', '', 'Công ty mẫu'],
    ['', 'Số tài khoản / Account number', '', '', '', ACCOUNT, '', '', 'Loại tiền / Currency', '', '', '', '', 'VND'],
    [],
    ['', 'Từ ngày / From', '', '', '', '01/10/2026', '', '', 'Đến ngày / To', '', '', '', '', '31/10/2026'],
    [],
    [],
    relativeRow(2, HEADER_CELLS),
    relativeRow(2, { 0: 'Số dư ban đầu / Previous Balance', 8: '10,000,000' }),
    ...TRANSACTIONS.map((tx) => relativeRow(2, {
      0: tx.no, 1: tx.date, 2: '09:00:00', 4: tx.debit, 7: tx.credit, 8: tx.balance
    })),
    relativeRow(2, { 1: 'Tổng / Total', 4: '1,050,200', 7: '250,000' }),
    relativeRow(2, { 0: 'Số dư hiện tại / Current Balance', 8: '9,199,800' }),
    [],
    [],
    ['', 'Chứng từ được in từ KBank Connect', '', '', '', '', '', '', '', '', '', '', '', '', 'Trang 1']
  ];
  const merges = [];
  for (let rowIndex = 10; rowIndex < 10 + 2 + TRANSACTIONS.length + 2; rowIndex += 1) {
    merges.push(...mergesAt(rowIndex, 2));
  }
  writeWorkbook(filePath, rows, merges);
  return { headerRowNumber: 11, totalRowNumber: 12 + TRANSACTIONS.length + 1 };
}

const numeric = (value) => Number(String(value ?? '').replace(/,/g, '')) || 0;

async function run() {
  console.log('==== 网银账单 合并单元格表头与合计行 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-merged-header-'));

  try {
    // Step 1：模板样本建模板
    const templatePath = path.join(dir, 'KBANK-VN.xlsx');
    writeTemplateSample(templatePath);
    const templateHeaders = readers.extractHeaders(templatePath);
    assertEq(templateHeaders.length, HEADER_WIDTH, 'Step1.模板表头保存 14 项（含中间空项）');
    assertEq(templateHeaders.filter(Boolean).length, 7, 'Step1.非空表头 7 项');
    assertEq(templateHeaders[3], '', 'Step1.第 4 项为合并单元格占位的空项');
    assertTrue(readers.readRowsWithMetadata(templatePath, templateHeaders).rows.length >= 1, 'Step1.模板样本能匹配自己的表头');

    // Step 2：原始账单匹配模板
    const statementPath = path.join(dir, 'AccountHistory_02112026.xlsx');
    const { headerRowNumber, totalRowNumber } = writeStatement(statementPath);
    const matched = readers.readRowsWithMetadata(statementPath, templateHeaders);
    assertEq(matched.rows[0], templateHeaders, 'Step2.账单第 11 行 C 列起的表头与模板逐项一致');
    assertEq(matched.rowNumbers[0], headerRowNumber, 'Step2.表头行号 = 11');

    // Step 3：映射 + 首次读取派生账号识别依据
    const mappingByField = {
      BillDate: HEADER_CELLS[1],
      ValueDate: HEADER_CELLS[1],
      'Debit Amount': HEADER_CELLS[4],
      'Credit Amount': HEADER_CELLS[7],
      Balance: HEADER_CELLS[8],
      ChannelOrderNo: HEADER_CELLS[0],
      'Transaction Description': HEADER_CELLS[13],
      MerchantId: '__FIXED__:__MULTI_BIG_ACCOUNT__',
      Currency: ''
    };
    const orderedTargetFields = Object.keys(mappingByField);
    let recognitionBasis = null;
    const mapped = fileService.buildMappedRows({
      inputFilePath: statementPath,
      orderedTargetFields,
      mappingByField,
      expectedSourceHeaders: templateHeaders,
      selectedBigAccount: { merchantId: ACCOUNT, currency: 'VND' },
      dateParseOrder: 'auto',
      readOptions: {
        onWorkbookRows(rawRows) {
          recognitionBasis = MAIN_DEPS.buildBigAccountRecognitionBasis({ rawRows, expectedSourceHeaders: templateHeaders });
        }
      }
    });
    assertEq(recognitionBasis.headerWindows.map((window) => window.headerRowNumber), [headerRowNumber], 'Step3.账号识别定位到第 11 行表头');
    const identified = MAIN_DEPS.identifyAccountsFromRecognitionBasis({ basis: recognitionBasis, allMerchantIds: [ACCOUNT] });
    assertEq(identified.accounts, [{ merchantId: ACCOUNT, matchType: 'exact' }], 'Step3.表头前窗口精确识别本方账号');
    const resolved = resolveRecognizedBigAccount({
      extractedMerchantId: identified.accounts[0] && identified.accounts[0].merchantId,
      maintainedBigAccounts: [{ merchantId: ACCOUNT, currency: 'VND' }],
      sourceFileName: path.basename(statementPath),
      templateName: 'KBANK-VN'
    });
    assertEq([resolved.status, resolved.selectedBigAccount && resolved.selectedBigAccount.currency], ['ok', 'VND'], 'Step3.解析到维护币种 VND');

    // Step 4：合计行跳过并记录
    const summaryIssues = mapped.issues.filter((issue) => issue.type === 'summary-row-skipped');
    assertEq(summaryIssues, [{ type: 'summary-row-skipped', rowNumber: totalRowNumber, rawValue: 'Tổng / Total' }], 'Step4.合计行按合计行跳过并记录行号与原值');
    assertTrue(!mapped.rowMetas.some((meta) => meta.sourceRowNumber === totalRowNumber), 'Step4.合计行不在映射明细中');

    // Step 5：明细导出写盘再读回
    const detail = fileService.buildDetailExportRows(mapped);
    const outputPath = path.join(dir, 'detail.xlsx');
    fileService.writeWorkbookRows({ rows: detail, outputFilePath: outputPath });
    const readBack = XLSX.utils.sheet_to_json(XLSX.readFile(outputPath).Sheets.COMMON, { header: 1, raw: false, defval: '' });
    const header = readBack[0];
    const body = readBack.slice(1);
    const column = (name) => body.map((row) => row[header.indexOf(name)]);
    assertEq(body.length, TRANSACTIONS.length, 'Step5.明细只含 4 笔真实交易');
    assertEq(column('BillDate'), ['2026-10-01', '2026-10-02', '2026-10-13', '2026-10-31'], 'Step5.日期按日/月/年解析');
    assertEq(column('MerchantId'), new Array(TRANSACTIONS.length).fill(ACCOUNT), 'Step5.MerchantId = 识别账号');
    assertEq(column('Currency'), new Array(TRANSACTIONS.length).fill('VND'), 'Step5.Currency = VND');
    assertEq(column('ChannelOrderNo'), ['1', '2', '3', '4'], 'Step5.STT 列对齐');
    assertEq(column('Debit Amount').map(numeric), TRANSACTIONS.map((tx) => numeric(tx.debit)), 'Step5.借方与原始 G 列逐行一致');
    assertEq(column('Credit Amount').map(numeric), TRANSACTIONS.map((tx) => numeric(tx.credit)), 'Step5.贷方与原始 J 列逐行一致');
    const balances = detail.sourceRows.slice(1).map((row) => numeric(row[detail.sourceRows[0].indexOf('Balance')]));
    assertEq(balances, TRANSACTIONS.map((tx) => numeric(tx.balance)), 'Step5.余额与原始 K 列逐行一致');
    const sum = (values) => values.map(numeric).reduce((total, value) => total + value, 0);
    assertEq([sum(column('Debit Amount')), sum(column('Credit Amount'))], [1050200, 250000], 'Step5.借贷合计 = 合计行总额');
    assertEq(
      detail.skippedRows.map((row) => row.sourceRowNumber),
      [headerRowNumber + 1, totalRowNumber + 1, totalRowNumber + 4],
      'Step5.期初/期末余额行与页脚按收支为空过滤'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((failure) => {
      console.error(`  - ${failure.label}: actual=${JSON.stringify(failure.actual)} expected=${JSON.stringify(failure.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
