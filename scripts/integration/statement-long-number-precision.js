// 网银账单生成：长数字按文件原文读取 e2e 集成验证（v3.2.21 B112）
//   覆盖：真实文件读取 → 主映射 → 写出明细 xlsx → 回读
//         ① XLSX 工作表 <v> 写的长整数、扩展名为 .csv 的 XLSX：按原文输出，明细中为文本单元格
//         ② 扩展名为 .xls 的 CSV / 制表符文本 / HTML 表格：按原文输出
//         ③ 真 CSV 的 ="…"、首尾制表符：数据行按 Excel 显示值输出，旧模板的 ="…" 表头照常匹配
//         ④ 文件中只有近似值（指数写法的 XLSX、二进制 .xls）：照常生成，导入提示与报错文件列出行号、源字段与位数（主进程真实函数）
//         ⑤ 大账号识别（主进程真实函数）：按读取值定位表头（表头恰为长数字时与模板表头一致），表头上方的长账号按原文精确匹配
//
// 读取库把超出安全整数范围的整数读成数字时会丢失末几位（长卡号、流水号），按这些标识对账会匹配不上或错配；
//   读取、映射、写出、回读整条链路都要保持原文，所以用真实文件端到端验证。
//
// 用法：node scripts/integration/statement-long-number-precision.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const acorn = require('acorn');

const {
  buildDetailExportRows,
  buildMappedRows,
  readRows,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const { buildExpectedHeaderCandidates, normalizeCell } = require('../../src/backend/file-service/common');
const { matchMerchantIds, normalizeMaintainedBigAccounts, resolveRecognizedBigAccount } = require('../../src/main-process/big-account-recognition');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });

function loadMainFunction(name, deps = {}) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  if (!node) throw new Error(`未找到 main.js 函数：${name}`);
  const names = Object.keys(deps);
  return Function(...names, `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(...names.map((key) => deps[key]));
}

let passed = 0;
let total = 0;
const failures = [];
function assertEq(actual, expected, label) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}\n    期望：${JSON.stringify(expected)}\n    实际：${JSON.stringify(actual)}`);
    console.log(`  ✗ ${label}`);
  }
}

const SERIAL = '9007199254740993';
const CARD = '6222021234567890123';
const HEADER = ['日期', '币种', '金额', '流水号', '卡号'];
const TARGETS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo', 'Payee Card No'];
const MAPPING = {
  BillDate: '日期',
  MerchantId: '__FIXED__:ACC001',
  Currency: '币种',
  'Credit Amount': '金额',
  ChannelOrderNo: '流水号',
  'Payee Card No': '卡号'
};

async function writeXlsxWithLiterals(filePath, rows, literals) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  Object.entries(literals).forEach(([placeholder, literal]) => {
    xml = xml.replace(`<v>${placeholder}</v>`, `<v>${literal}</v>`);
  });
  zip.file('xl/worksheets/sheet1.xml', xml);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

// 生成并写出明细，回读流水号、卡号的显示文本与单元格类型
function generateAndReadBack(dir, sourcePath, { mappingByField = MAPPING, expectedSourceHeaders = HEADER } = {}) {
  const mapped = buildMappedRows({
    inputFilePath: sourcePath,
    orderedTargetFields: TARGETS,
    mappingByField,
    expectedSourceHeaders
  });
  const outputPath = path.join(dir, `out-${path.basename(sourcePath)}.xlsx`);
  writeWorkbookRows({ rows: buildDetailExportRows(mapped), outputFilePath: outputPath });
  const sheet = XLSX.readFile(outputPath).Sheets.Sheet1 || XLSX.readFile(outputPath).Sheets[XLSX.readFile(outputPath).SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const header = aoa[0];
  const columns = ['ChannelOrderNo', 'Payee Card No'].map((field) => header.indexOf(field));
  const values = aoa.slice(1).map((row) => columns.map((index) => row[index]));
  const types = aoa.slice(1).map((_row, rowIndex) => columns.map((index) => {
    const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: index })];
    return cell ? cell.t : '';
  }));
  return { mapped, values, types };
}

const longNumberIssues = (mapped) => mapped.issues.filter((issue) => issue.type === 'long-number-unverified');

async function verifyXlsxLiterals(dir) {
  console.log('① XLSX 原文');
  const xlsxPath = await writeXlsxWithLiterals(path.join(dir, 'literal.xlsx'),
    [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]], { 1111: SERIAL, 2222: CARD });
  const xlsx = generateAndReadBack(dir, xlsxPath);
  assertEq(xlsx.values, [[SERIAL, CARD]], '① XLSX <v> 长整数按原文写出明细');
  assertEq(xlsx.types, [['s', 's']], '① 明细中为文本单元格（不会被 Excel 再次舍入）');
  assertEq(longNumberIssues(xlsx.mapped), [], '① 可还原时不提示');
  const disguisedPath = await writeXlsxWithLiterals(path.join(dir, 'xlsx-as.csv'),
    [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]], { 1111: SERIAL, 2222: CARD });
  assertEq(generateAndReadBack(dir, disguisedPath).values, [[SERIAL, CARD]], '① 扩展名为 .csv 的 XLSX 按原文');
}

function verifyTextContainers(dir) {
  console.log('② 伪装成 .xls 的文本 / HTML');
  const files = {
    'csv-as.xls': `﻿${HEADER.join(',')}\r\n20261101,USD,100,${SERIAL},"${CARD}"\r\n`,
    'tsv-as.xls': `﻿${HEADER.join('\t')}\r\n20261101\tUSD\t100\t${SERIAL}\t${CARD}\r\n`,
    'html-as.xls': `<html><head><meta charset="utf-8"></head><body><table>
<tr>${HEADER.map((h) => `<td>${h}</td>`).join('')}</tr>
<tr><td>2026年11月01日</td><td>USD</td><td>100</td><td>${SERIAL}</td><td>${CARD}</td></tr>
</table></body></html>`
  };
  Object.entries(files).forEach(([name, content]) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    assertEq(generateAndReadBack(dir, filePath).values, [[SERIAL, CARD]], `② ${name} 按原文`);
  });
}

function verifyCsvExcelText(dir) {
  console.log('③ CSV 的 ="…" 与制表符');
  const filePath = path.join(dir, 'excel-text.csv');
  fs.writeFileSync(filePath, [
    '="日期",币种,金额,流水号,卡号',
    `2026-11-01,USD,100,="${SERIAL}","=""${CARD}"""`,
    `2026-11-02,USD,200,"\t${SERIAL}",${CARD}\t`
  ].join('\r\n'));
  const result = generateAndReadBack(dir, filePath, {
    mappingByField: { ...MAPPING, BillDate: '=日期' },
    expectedSourceHeaders: ['=日期', '币种', '金额', '流水号', '卡号']
  });
  assertEq(result.values, [[SERIAL, CARD], [SERIAL, CARD]], '③ 数据行按 Excel 显示值写出，旧模板表头照常匹配');
}

function verifyUnverifiedWarnings(dir) {
  console.log('④ 无法还原的提示');
  const biffPath = path.join(dir, 'biff.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    HEADER,
    ['2026-11-01', 'USD', 100, Number(SERIAL), 'TEXT-1'],
    ['2026-11-02', 'USD', 200, 'TEXT-2', Number(CARD)]
  ]), 'Sheet1');
  XLSX.writeFile(workbook, biffPath, { bookType: 'biff8' });
  const biff = generateAndReadBack(dir, biffPath);
  assertEq(biff.values, [['9007199254740992', 'TEXT-1'], ['TEXT-2', '6222021234567890000']], '④ 二进制 .xls 照常生成');
  assertEq(longNumberIssues(biff.mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [2, [{ sourceField: '流水号', digitCount: 16, targetFields: ['ChannelOrderNo'] }]],
    [3, [{ sourceField: '卡号', digitCount: 19, targetFields: ['Payee Card No'] }]]
  ], '④ 按行与源字段记下位数（不记值）及写进的目标列');
  // 改选大账号后复用明细：只写进币种 / 大账号列的源字段随列被覆盖去掉，其余照常
  const dropOverridden = loadMainFunction('dropIssuesOverriddenBySelectedBigAccount');
  assertEq(dropOverridden([
    { type: 'currency-unmapped', rowNumber: 2 },
    { type: 'long-number-unverified', rowNumber: 2, cells: [{ sourceField: '币种', digitCount: 19, targetFields: ['Currency'] }] },
    { type: 'long-number-unverified', rowNumber: 3, cells: [
      { sourceField: '币种', digitCount: 19, targetFields: ['Currency'] },
      { sourceField: '卡号', digitCount: 19, targetFields: ['Currency', 'Payee Card No'] },
      { sourceField: '金额', digitCount: 16 }
    ] }
  ], new Set(['MerchantId', 'Currency'])), [
    { type: 'long-number-unverified', rowNumber: 3, cells: [
      { sourceField: '卡号', digitCount: 19, targetFields: ['Currency', 'Payee Card No'] },
      { sourceField: '金额', digitCount: 16 }
    ] }
  ], '④ 改选大账号后复用明细：只剔除被覆盖列的来源');
  const message = loadMainFunction('buildImportWarningMessage')({
    warnings: biff.mapped.issues, balanceReady: false, balanceRequested: false
  });
  assertEq(message, '明细账单可导出，2行长数字无法核对原值，请点击状态框导出报错文件', '④ 导入提示摘要');
  const detailLines = loadMainFunction('buildImportWarningDetailLines', {
    formatBalanceGapLine: () => '', formatBalanceMismatchLine: () => '', formatBalanceSeedReplaceLine: () => ''
  })(biff.mapped.issues);
  assertEq(detailLines, [
    '以下单元格是超出精度的数值，文件中没有可核对的原值，导出值可能与银行原值不同，请向银行索取该列为文本格式的文件：',
    '文件“biff.xls”第2行，源字段“流水号”，16位数值',
    '文件“biff.xls”第3行，源字段“卡号”，19位数值'
  ], '④ 报错文件逐行列出文件、行与源字段，不写卡号 / 账号的值');

  // 整列都是这类数值时明细最多列 100 处
  const manyWarnings = Array.from({ length: 101 }, (_item, index) => ({
    type: 'long-number-unverified',
    fileName: index === 0 ? 'a.xls' : 'b.xls',
    rowNumber: index + 2,
    cells: [{ sourceField: '卡号', digitCount: 19 }]
  }));
  const manyLines = loadMainFunction('buildImportWarningDetailLines', {
    formatBalanceGapLine: () => '', formatBalanceMismatchLine: () => '', formatBalanceSeedReplaceLine: () => ''
  })(manyWarnings);
  assertEq([manyLines.length, manyLines[1], manyLines[100], manyLines[101]], [
    102,
    '文件“a.xls”第2行，源字段“卡号”，19位数值',
    '文件“b.xls”第101行，源字段“卡号”，19位数值',
    '……等共101处'
  ], '④ 多文件注明文件名，明细最多 100 处');
}

async function verifyExponentXlsx(dir) {
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'exponent.xlsx'),
    [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]], { 1111: '6.2220212345678899E+18', 2222: CARD });
  const result = generateAndReadBack(dir, filePath);
  assertEq(result.values, [['6222021234567890000', CARD]], '④ 指数写法的 XLSX 照常生成，可还原的列按原文');
  assertEq(longNumberIssues(result.mapped).map((issue) => issue.cells), [[{ sourceField: '流水号', digitCount: 19, targetFields: ['ChannelOrderNo'] }]],
    '④ 只提示无法还原的列');
}

async function verifyBigAccountRecognitionRead(dir) {
  console.log('⑤ 大账号识别');
  // 表头最后一列恰为长数字：模板导入读表头得到读取库的值，识别须按同一个值定位表头
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'account.xlsx'), [
    ['账号', 1111],
    [],
    [...HEADER, 7777],
    ['2026-11-01', 'USD', 100, 'R1', 'C1', 'X']
  ], { 1111: CARD, 7777: SERIAL });
  // 模板导入读表头不取原文，长数字表头存为读取库的值
  const templateHeaders = [...HEADER, String(Number(SERIAL))];
  assertEq(readRows(filePath, { blankrows: true })[2][5], Number(SERIAL), '⑤ 表头单元格的读取值即模板中的表头');

  const findHeaderRowNumbersInRawRows = loadMainFunction('findHeaderRowNumbersInRawRows', { buildExpectedHeaderCandidates, normalizeCell });
  const applyBigAccountRecognitionSourceText = loadMainFunction('applyBigAccountRecognitionSourceText');
  const readRowsForBigAccountRecognition = loadMainFunction('readRowsForBigAccountRecognition', {
    readRows,
    createStatementWorkbookReadGuard: () => undefined,
    BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS: 64,
    STATEMENT_SOURCE_FRESHNESS_FAILURE: { code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE' }
  });
  const findBigAccountMatchInRows = loadMainFunction('findBigAccountMatchInRows', { normalizeCell, matchMerchantIds });
  const identifyAccountsFromFile = loadMainFunction('identifyAccountsFromFile', {
    identifyAccountsFromRecognitionBasis: () => { throw new Error('不应走识别依据'); },
    readRowsForBigAccountRecognition,
    findHeaderRowNumbersInRawRows,
    applyBigAccountRecognitionSourceText,
    findBigAccountMatchInRows,
    readRows,
    createStatementWorkbookReadGuard: () => undefined,
    BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS: 64
  });
  const identified = identifyAccountsFromFile({
    filePath,
    expectedSourceHeaders: templateHeaders,
    allMerchantIds: ['6222021234567890000', CARD],
    allowSubstringMatch: true
  });
  assertEq(identified, { accounts: [{ merchantId: CARD, matchType: 'exact' }], isSingleAccount: true, hasUnverifiedLongNumber: false },
    '⑤ 导入识别：表头上方的长账号按原文精确匹配，不再匹配近似值');

  // 生成时按映射读取同一份表构造识别依据（onWorkbookRows）
  const buildBigAccountRecognitionBasis = loadMainFunction('buildBigAccountRecognitionBasis', {
    findHeaderRowNumbersInRawRows,
    normalizeCell,
    matchMerchantIds
  });
  let basis = null;
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: MAPPING,
    expectedSourceHeaders: templateHeaders,
    readOptions: {
      onWorkbookRows(rawRows) {
        basis = buildBigAccountRecognitionBasis({
          rawRows,
          expectedSourceHeaders: templateHeaders,
          // 较短后缀的映射排在前面：完整账号按原文精确命中，须优先于后缀的模糊命中
          accountMappingByBankId: {
            67890123: { clearingAccountId: 'ACC-SUFFIX' },
            [CARD]: { clearingAccountId: 'ACC-CARD' }
          }
        });
      }
    }
  });
  assertEq(mapped.length, 2, '⑤ 映射按读取值定位表头');
  assertEq(basis && basis.headerWindows.map((window) => [window.headerRowNumber, window.candidateRows]),
    [[3, [['账号', CARD], []]]], '⑤ 生成时的识别窗口：表头按读取值定位，账户信息行为原文');
  assertEq(basis && basis.bridgeCandidatesByBlock, [[
    { sourceRow: 1, clearingAccountId: 'ACC-CARD' },
    { sourceRow: 1, clearingAccountId: 'ACC-SUFFIX' }
  ]], '⑤ 账户映射按原文命中，精确命中排在后缀的模糊命中之前');

  // v3.2.22（B133 审查）：工作表原文无法核对（如含注释掉的标签）时不还原，表头上方的长账号只剩近似值（9007199254740993 读成
  //   9007199254740992）。该段无法排除它就是本段的账号：不精确命中近似值相同的另一个账号，也不改用同窗口其他单元格
  //   （分行号 2222）模糊命中别的账号、不按账户映射桥接，整段不自动识别；只维护一个选项时与普通未识别一样报错。
  //   普通注释（不含尖括号）两边读到的结构相同，照常按原文识别（对照）
  const UNVERIFIED_ACCOUNT = '9007199254740993';
  const ROUNDED_ACCOUNT = String(Number(UNVERIFIED_ACCOUNT));
  const writeCommented = async (name, comment, rows = [
    ['账号', 1111, '分行', '2222'],
    [],
    HEADER,
    ['2026-11-01', 'USD', 100, 'R1', 'C1']
  ]) => {
    const filePath = await writeXlsxWithLiterals(path.join(dir, name), rows, { 1111: UNVERIFIED_ACCOUNT });
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    zip.file('xl/worksheets/sheet1.xml', sheetXml.replace('<sheetData>', `${comment}<sheetData>`));
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const plainCommented = await writeCommented('account-plain-comment.xlsx', '<!-- 手工注释 -->');
  assertEq(identifyAccountsFromFile({
    filePath: plainCommented,
    expectedSourceHeaders: HEADER,
    allMerchantIds: [UNVERIFIED_ACCOUNT, ROUNDED_ACCOUNT, '22221111'],
    allowSubstringMatch: true
  }), { accounts: [{ merchantId: UNVERIFIED_ACCOUNT, matchType: 'exact' }], isSingleAccount: true, hasUnverifiedLongNumber: false },
  '⑤ 对照：普通注释照常还原，按原文精确命中');
  const commented = await writeCommented('account-commented.xlsx', '<!-- 旧版本：<legacy/> -->');
  assertEq(readRows(commented, { blankrows: true })[0][1], Number(UNVERIFIED_ACCOUNT), '⑤ 前置：注释含标签时不还原，账号读成近似值');
  const unverifiedIdentified = identifyAccountsFromFile({
    filePath: commented,
    expectedSourceHeaders: HEADER,
    allMerchantIds: [ROUNDED_ACCOUNT, '22221111'],
    allowSubstringMatch: true
  });
  assertEq(unverifiedIdentified, { accounts: [], isSingleAccount: true, hasUnverifiedLongNumber: true },
    '⑤ 导入识别：无法核对原值的长账号所在段不自动识别（不精确命中近似值，也不按分行号模糊命中别的账号）');
  let commentedBasis = null;
  buildMappedRows({
    inputFilePath: commented,
    orderedTargetFields: TARGETS,
    mappingByField: MAPPING,
    expectedSourceHeaders: HEADER,
    readOptions: {
      onWorkbookRows(rawRows) {
        commentedBasis = buildBigAccountRecognitionBasis({
          rawRows,
          expectedSourceHeaders: HEADER,
          accountMappingByBankId: {
            [ROUNDED_ACCOUNT]: { clearingAccountId: 'ACC-ROUNDED' },
            22221111: { clearingAccountId: 'ACC-BRANCH' }
          }
        });
      }
    }
  });
  assertEq(commentedBasis && commentedBasis.headerWindows.map((window) => [window.candidateRows, window.unverifiedLongNumber]),
    [[[['账号', '分行', '2222'], []], true]], '⑤ 生成时的识别窗口不含无法核对原值的长账号，并标记该段');
  assertEq(commentedBasis && commentedBasis.bridgeCandidatesByBlock, [[]], '⑤ 该段不按账户映射桥接（近似值与分行号都不命中）');
  const identifyAccountsFromRecognitionBasis = loadMainFunction('identifyAccountsFromRecognitionBasis', { findBigAccountMatchInRows });
  const basisRecognition = identifyAccountsFromRecognitionBasis({
    basis: commentedBasis,
    allMerchantIds: [ROUNDED_ACCOUNT, '22221111']
  });
  assertEq([basisRecognition.matches, basisRecognition.hasUnverifiedLongNumber], [[null], true],
    '⑤ 按识别依据识别（提取顺序、固定顺序）：该段不视为已识别');

  // 只维护一个大账号 / 币种时（直接识别），无法核对原值的长账号与普通未识别一样报未识别、不自动套用唯一选项，并说明原因；
  //   不另走人工选择（选择窗口会覆盖同批每个文件的账号与币种），与另一份普通未识别的文件同批时不随文件顺序变化
  const loadNamed = (name, deps) => loadMainFunction(name, deps);
  const uniqueNormalizedValues = loadNamed('uniqueNormalizedValues', { normalizeCell });
  const resolveDirect = loadNamed('resolveDirectBigAccountRecognition', {
    expandBigAccountConfigurations: loadNamed('expandBigAccountConfigurations', { normalizeMaintainedBigAccounts }),
    uniqueNormalizedValues,
    getEntryTemplateConfig: () => ({ exportMappings: [], template: { headers: HEADER } }),
    isMultiBigAccountMapping: () => true,
    identifyAccountsFromFile,
    resolveRecognizedBigAccount,
    normalizeCell,
    path
  });
  const directFor = (...filePaths) => resolveDirect({
    fileEntries: filePaths.map((filePath) => ({ filePath, matchedHeaders: HEADER })),
    maintainedBigAccounts: [{ merchantId: '22221111', currencies: ['USD'] }],
    fallbackTemplateConfig: {},
    templateName: '测试模板'
  });
  const plainUnrecognized = await writeXlsxWithLiterals(path.join(dir, 'account-unrecognized.xlsx'), [
    ['账号', '3333'], [], HEADER, ['2026-11-01', 'USD', 100, 'R1', 'C1']
  ], {});
  const plainDecision = directFor(plainUnrecognized);
  assertEq([plainDecision.status, plainDecision.code], ['failed', 'BIG_ACCOUNT_NOT_RECOGNIZED'], '⑤ 对照：普通未识别且只维护一个选项时按未识别报错');
  const unverifiedDecision = directFor(commented);
  assertEq([unverifiedDecision.status, unverifiedDecision.code, /超出精度范围.*无法核对原值/.test(unverifiedDecision.message || '')],
    ['failed', 'BIG_ACCOUNT_NOT_RECOGNIZED', true], '⑤ 无法核对原值的长账号：按未识别报错并说明原因，不套用唯一的维护选项');
  assertEq([directFor(commented, plainUnrecognized).status, directFor(plainUnrecognized, commented).status], ['failed', 'failed'],
    '⑤ 与普通未识别的文件同批：两种文件顺序结果相同');
  // 同一文件两段：一段精确命中唯一维护的账号，另一段的长账号无法核对——整份按未识别报错，不把未核对段的交易归给唯一账号
  const multiBlock = await writeCommented('account-multi-block.xlsx', '<!-- 旧版本：<legacy/> -->', [
    ['账号', '22221111'], [], HEADER, ['2026-11-01', 'USD', 100, 'R1', 'C1'], [],
    ['账号', 1111], [], HEADER, ['2026-11-02', 'USD', 200, 'R2', 'C2']
  ]);
  const multiIdentified = identifyAccountsFromFile({
    filePath: multiBlock, expectedSourceHeaders: HEADER, allMerchantIds: ['22221111'], allowSubstringMatch: false
  });
  assertEq([multiIdentified.accounts.map((account) => account.merchantId), multiIdentified.hasUnverifiedLongNumber], [['22221111'], true],
    '⑤ 前置：一段已识别、另一段长账号无法核对');
  const multiDecision = directFor(multiBlock);
  assertEq([multiDecision.status, multiDecision.code, multiDecision.selectedBigAccount], ['failed', 'BIG_ACCOUNT_NOT_RECOGNIZED', undefined],
    '⑤ 同一文件一段已识别、另一段无法核对：整份按未识别报错，不选中唯一账号');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-long-number-'));
  try {
    await verifyXlsxLiterals(dir);
    verifyTextContainers(dir);
    verifyCsvExcelText(dir);
    verifyUnverifiedWarnings(dir);
    await verifyExponentXlsx(dir);
    await verifyBigAccountRecognitionRead(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failures.length) {
    console.error('FAILURES:');
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
