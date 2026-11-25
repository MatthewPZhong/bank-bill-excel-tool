// 网银账单：补录余额「导入余额文件」e2e 集成验证（v3.2.17；v3.2.22 改为识别「银行原始日终余额信息」）
//   覆盖：真实 xlsx 读取 → 生成层缺种子提示带待补录清单 → 真实余额文件（xlsx，表头取随包模板）读取、按列名解析，
//         按 银行账户号 + 币种 + 银行名 / 开户地（本组输出名称拆出）匹配；同日多个不同余额待用户选择
//         → 按确认结果逐个账号走现行补录预检与种子写入（请求带账号，错位即拒绝）→ 每次重算
//         → 余额 xlsx 写出与回读 → 种子按人工录入原值落盘；
//         「核对上一账单日余额」（已有种子但首日对不上）同样可导入，覆盖同日种子后正常生成。
//   UI 弹窗由 renderer-lifecycle 覆盖；本脚本验证文件、金额与种子在整条链路上的结果。
//
// 用法：node scripts/integration/statement-balance-file-import.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  FileValidationError,
  normalizeCell,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord
} = require('../../src/backend/balance-seed-store');
const { readBalanceAdjustments } = require('../../src/backend/balance-adjustment-store');
const {
  balanceImportAccountsForPrompt,
  matchBalanceSeedImport,
  parseBalanceSeedImportRows,
  readBalanceSeedImportFile
} = require('../../src/backend/balance-seed-import');
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus
} = require('../../src/main-process/statement-generation-business');
const {
  prepareManualBalanceSeedSubmission,
  writeManualBalanceSeedPlan
} = require('../../src/main-process/manual-balance-seed-preflight');
const {
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');

const ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_NAME = '中行-上海';
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
// 余额文件表头取随包模板「银行原始日终余额信息」第一行，模板与识别列名漂移时本脚本即失败
const EOD_TEMPLATE_PATH = path.join(ROOT, 'assets', '银行原始日终余额信息.xlsx');
const EOD_HEADER = (() => {
  const workbook = XLSX.readFile(EOD_TEMPLATE_PATH);
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false })[0].map(String);
})();

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

function createGeneration(storageRoot, outputDir) {
  let sequence = 0;
  return createStatementGenerationHelpers({
    appendLog: (_root, error) => { throw error; },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath: ({ kind }) => {
      sequence += 1;
      const outputFileName = `${kind}-${sequence}.xlsx`;
      return { outputFilePath: path.join(outputDir, outputFileName), outputFileName };
    },
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot: () => storageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    getAcknowledgedBalanceGapKeys: () => new Set(),
    getBalanceTemplatePath: () => path.join(ROOT, 'assets', '余额账单模版.xlsx'),
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    parseRequiredBillDates,
    readBalanceAdjustments,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanBalanceSeedStatus(input, storageRoot),
    splitTemplateName,
    storeGeneratedBalanceSeeds: ({ templateName, seedRecords }) => {
      seedRecords.forEach((record) => upsertBalanceSeedRecord(storageRoot, {
        templateName, ...record, overwrite: true
      }));
    },
    writeBalanceWorkbook,
    writeWorkbookRows
  });
}

function writeXlsx(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function readBalanceSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const header = rows[0];
  const index = (name) => header.indexOf(name);
  return rows.slice(1).map((row) => {
    const { y, m, d } = XLSX.SSF.parse_date_code(row[index('账单日期')]);
    return [
      row[index('银行账号')],
      row[index('币种')],
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      row[index('期末余额')]
    ];
  });
}

// 按列名填一行「银行原始日终余额信息」，其余列留空
function eodRow(values) {
  return EOD_HEADER.map((name) => (Object.hasOwn(values, name) ? values[name] : ''));
}

function importBalanceFile(filePath, prompt, storageRoot = '') {
  const { rows, displayRows, date1904, rowNumbers, unreadableCells } = readBalanceSeedImportFile(filePath);
  const parsed = parseBalanceSeedImportRows(rows, { displayRows, date1904, rowNumbers, unreadableCells });
  // 与 file:import-balance-seed-file 同口径：待匹配账号取自当前提示，本组银行名 / 开户地取自输出名称；
  //   给了种子目录时，核对账号的日期下限按当前种子记录取
  const group = splitTemplateName(prompt.templateName);
  const accounts = balanceImportAccountsForPrompt(prompt, storageRoot ? {
    previousSeedDate: ({ merchantId, currency, targetBillDate }) => {
      const seed = findPreviousBalanceSeed(storageRoot, { bankName: group.bankName, merchantId, currency, beforeBillDate: targetBillDate });
      return seed ? seed.billDate : '';
    }
  } : {});
  return { ...parsed, ...matchBalanceSeedImport(parsed.records, accounts, group) };
}

function seedPrompt(result) {
  const warning = (result.warnings || []).find((item) => item.type === 'balance-seed-required');
  return warning ? warning.prompt : null;
}

// 与 file:save-balance-seed 的 prepare 同一入口：请求带账号时由主进程核对，种子账号取自 pendingPrompt。
function prepareSave(storageRoot, pendingPrompt, payload) {
  return prepareManualBalanceSeedSubmission({
    payload,
    pendingPrompt,
    importContext: { scope: 'current', template: { name: TEMPLATE_NAME } },
    storageRoot,
    session: null,
    createContextId: () => 'unused',
    createFreshnessGuard: () => ({ inputFilePaths: ['source.xlsx'], assertFresh() {} })
  }).prepared;
}

// Step 5：「核对上一账单日余额」（账单里的余额模式下，已有种子但首日对不上）同样导入余额文件：
//   待匹配账号为当前核对账号，按文件余额覆盖同日种子后正常生成余额账单。
function verifySeedMismatchImport(dir) {
  const storageRoot = path.join(dir, 'storage-seed-mismatch');
  const outputDir = path.join(dir, 'exports-seed-mismatch');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const sourcePath = path.join(dir, 'statement-with-balance.xlsx');
  writeXlsx(sourcePath, [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'],
    ['2026-10-01', 'M801', 'VND', '0', '200000', '800000'],
    ['2026-10-01', 'M801', 'VND', '0', '1500', '798500'],
    ['2026-10-12', 'M801', 'VND', '300000', '0', '1098500']
  ]);
  const orderedFields = [...ORDERED_FIELDS, 'Balance'];
  const detailRows = buildMappedRows({
    inputFilePath: sourcePath,
    orderedTargetFields: orderedFields,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
    }
  });
  const config = {
    template: { name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  const generation = createGeneration(storageRoot, outputDir);
  const generate = () => generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath: sourcePath, detailRows }] })
  });
  // 先误补 0：首日余额对不上，提示「核对上一账单日余额」
  const missingPrompt = seedPrompt(generate());
  const wrongPlan = prepareSave(storageRoot, missingPrompt, {
    billDate: '2026-09-30', endBalance: '0', merchantId: 'M801', currency: 'VND', templateName: missingPrompt.templateName
  });
  writeManualBalanceSeedPlan(wrongPlan.plan);
  const mismatchPrompt = seedPrompt(generate());
  assertTrue(Boolean(mismatchPrompt && mismatchPrompt.seedMismatch), 'Step5.首日对不上时为核对提示');
  assertEq(balanceImportAccountsForPrompt(mismatchPrompt),
    [{ merchantId: 'M801', currency: 'VND', targetBillDate: '2026-10-01', minBillDate: '2026-09-30' }],
    'Step5.核对提示的待匹配账号为当前核对账号，带已有种子日期');

  // 文件里该账号最近的余额（09-29）早于已有种子（09-30）：写入后重算仍取 09-30 的种子，修正不了本次核对 → 需手工录入
  const stalePath = path.join(dir, '核对-日终余额-更早.xlsx');
  writeXlsx(stalePath, [
    EOD_HEADER,
    eodRow({ 账单日期: '2026-09-29', 银行名: '中行', 开户地: '上海', 币种: 'VND', 银行账户号: 'M801', 期末余额: '1000000', 余额来源: '网银' })
  ]);
  const stale = importBalanceFile(stalePath, mismatchPrompt, storageRoot);
  assertEq(stale.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance, account.reason]), [
    ['M801', 'manual', '', null, '文件中该账号最近的余额在 2026-09-29，早于已有的 2026-09-30 余额，导入后仍按已有余额核对，请手工填写']
  ], 'Step5.文件余额早于已有种子日期时不当作来自文件');
  // 确认页或核对弹窗手工改成早于已有种子的日期：保存前预检拒绝，不写入无效的历史余额
  const seedCount = readBalanceSeedRecords(storageRoot, '中行').length;
  const staleSave = prepareSave(storageRoot, mismatchPrompt, {
    billDate: '2026-09-29', endBalance: '1000000', merchantId: 'M801', currency: 'VND', templateName: mismatchPrompt.templateName
  });
  assertEq([staleSave.proceed, staleSave.result.status, staleSave.result.message],
    [false, 'manual-balance-invalid', '上一账单日日期不能早于已有余额的日期 2026-09-30（更早的余额不会用于本次核对）'],
    'Step5.早于已有种子日期的补录被预检拒绝');
  assertEq(readBalanceSeedRecords(storageRoot, '中行').length, seedCount, 'Step5.被拒绝的补录不写种子');

  const filePath = path.join(dir, '核对-日终余额.xlsx');
  writeXlsx(filePath, [
    EOD_HEADER,
    eodRow({ 账单日期: '2026-09-30', 银行名: ' 中行 ', 开户地: '上海', 币种: 'vnd', 银行账户号: 'M801', 期末余额: '1000000', 余额来源: '网银' }),
    eodRow({ 账单日期: '2026-09-30', 银行名: '中行', 开户地: '上海', 币种: 'VND', 银行账户号: 'M801', 期末余额: '1,000,000.00', 余额来源: '人工' })
  ]);
  const matched = importBalanceFile(filePath, mismatchPrompt, storageRoot);
  assertEq(matched.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance]),
    [['M801', 'file', '2026-09-30', 1000000]], 'Step5.同日多条相同余额不弹选择，直接取');

  const account = matched.accounts[0];
  const submit = (payload, confirmation = null) => prepareManualBalanceSeedSubmission({
    payload,
    pendingPrompt: mismatchPrompt,
    confirmation,
    importContext: { scope: 'current', template: { name: TEMPLATE_NAME } },
    storageRoot,
    session: null,
    createContextId: () => 'overwrite-context',
    createFreshnessGuard: () => ({ inputFilePaths: ['source.xlsx'], assertFresh() {} })
  });
  const first = submit({
    billDate: account.billDate, endBalance: String(account.endBalance),
    merchantId: account.merchantId, currency: account.currency, templateName: mismatchPrompt.templateName
  });
  assertEq([first.prepared.proceed, first.prepared.result.status], [false, 'confirm-overwrite'], 'Step5.同日已有种子时先确认覆盖');
  const confirmed = submit({ confirmOverwrite: true, contextId: 'overwrite-context' }, first.nextConfirmation);
  assertEq([confirmed.prepared.proceed, confirmed.prepared.plan.existingIndex], [true, 0], 'Step5.确认后覆盖同日种子');
  writeManualBalanceSeedPlan(confirmed.prepared.plan);
  const corrected = generate();
  assertEq(corrected.warnings, [], 'Step5.导入后无提示');
  assertEq(readBalanceSheet(corrected.balance.filePath), [
    ['M801', 'VND', '2026-10-01', 798500],
    ['M801', 'VND', '2026-10-12', 1098500]
  ], 'Step5.回读余额');
  assertEq(readBalanceSeedRecords(storageRoot, '中行')
    .filter((record) => record.generationMethod === '人工录入')
    .map((record) => [record.merchantId, record.billDate, record.endBalance]),
  [['M801', '2026-09-30', 1000000]], 'Step5.种子按文件余额覆盖');
}

// Step 6：文件读取口径——「选择余额」的行号为原表物理行号（xlsx 有效范围不从第 1 行起、中间有空行）；
//   余额文件只接受 xlsx（W1）：CSV 等其他格式不读取，提示在 Excel 中另存为 xlsx。
function verifyFileRowNumbersAndXlsxOnly(dir) {
  const prompt = {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD', targetBillDate: '2026-10-01',
    pendingAccounts: [{ merchantId: 'M001', currency: 'USD', targetBillDate: '2026-10-01' }]
  };
  const row = (balance, source, method) => eodRow({
    账单日期: '2026-09-30', 银行名: '中行', 开户地: '上海', 币种: 'USD', 银行账户号: 'M001', 期末余额: balance, 余额来源: source, 余额获取方式: method
  });
  const xlsxPath = path.join(dir, '行号-日终余额.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([[], ['银行原始日终余额信息'], EOD_HEADER, [], row('100', '网银账单', '手工导入'), [], row('120', '银行直连', 'API')]);
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 1, c: 0 }, e: { r: 6, c: EOD_HEADER.length - 1 } });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Balance');
  XLSX.writeFile(workbook, xlsxPath);
  const xlsx = importBalanceFile(xlsxPath, prompt);
  assertEq(xlsx.accounts[0].choices.map((choice) => [choice.rowNumber, choice.endBalance, choice.balanceSource]),
    [[5, 100, '网银账单'], [7, 120, '银行直连']], 'Step6.xlsx 候选行号为工作表物理行号');

  // 同样内容的 CSV、以 .xlsx 为扩展名的 CSV：都不读取
  const csvText = [EOD_HEADER, row('100', '网银账单', '手工导入'), row('120', '银行直连', '自动获取')].map((values) => values.join(',')).join('\n') + '\n';
  for (const [name, code] of [['日终余额.csv', 'FILE_TYPE'], ['日终余额-实为CSV.xlsx', 'FILE_READ']]) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, csvText, 'utf8');
    let error = null;
    try {
      importBalanceFile(filePath, prompt);
    } catch (caught) {
      error = caught;
    }
    assertTrue(error && error.code === code && /余额文件须为 xlsx 格式/.test(error.message) && /另存为 xlsx/.test(error.message),
      `Step6.${name} 不读取，提示另存为 xlsx`);
  }
}

async function run() {
  console.log('==== 网银账单补录余额「导入余额文件」e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-balance-file-import-'));
  const storageRoot = path.join(dir, 'storage');
  const outputDir = path.join(dir, 'exports');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const sourcePath = path.join(dir, 'statement.xlsx');
    writeXlsx(sourcePath, [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-10-01', 'M002', 'EUR', '', '50'],
      ['2026-10-01', 'M001', 'USD', '100.10', ''],
      ['2026-10-02', 'M001', 'USD', '', '20.05']
    ]);
    const detailRows = buildMappedRows({
      inputFilePath: sourcePath,
      orderedTargetFields: ORDERED_FIELDS,
      mappingByField: {
        BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
        'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
      }
    });
    const config = {
      template: { name: TEMPLATE_NAME },
      mappingByTargetField: { MerchantId: 'Account' },
      balanceRequested: true,
      balanceMode: 'calculated'
    };
    const generation = createGeneration(storageRoot, outputDir);
    const generate = () => generation.generateStatementFiles({
      config,
      preparedBatch: generation.buildPreparedStatementBatchFromEntries({
        config,
        fileEntries: [{ filePath: sourcePath, detailRows }]
      })
    });

    // Step 1：首次生成缺种子，补录提示带本组全部待补录账号（按逐个提示的顺序）
    const first = generate();
    const firstPrompt = seedPrompt(first);
    assertEq(first.balance, null, 'Step1.缺种子时不生成余额账单');
    assertEq([firstPrompt.merchantId, firstPrompt.currency, firstPrompt.queueTotal], ['M001', 'USD', 2], 'Step1.先提示 M001');
    assertEq(firstPrompt.pendingAccounts, [
      { merchantId: 'M001', currency: 'USD', targetBillDate: '2026-10-01' },
      { merchantId: 'M002', currency: 'EUR', targetBillDate: '2026-10-01' }
    ], 'Step1.待补录清单');

    // Step 2：真实余额文件（清结算导出的「银行原始日终余额信息」，前有标题行）
    //   M001：早于 10-01 的最近一天（09-30）有两条不同余额 → 待选择；10-01 当日及之后的行不取
    //   M002：账号、币种对得上但开户地是北京 → 不匹配，需手工录入并写明原因
    const balanceFilePath = path.join(dir, '银行原始日终余额信息-导出.xlsx');
    const bank = (values) => eodRow({ 银行名: '中行', 开户地: '上海', 币种: 'USD', 银行账户号: 'M001', ...values });
    writeXlsx(balanceFilePath, [
      ['银行原始日终余额信息'],
      EOD_HEADER,
      bank({ 账单日期: '2026-09-29', 期末余额: '500', 余额来源: '网银', 余额获取方式: '自动' }),
      bank({ 账单日期: '2026/09/30', 期末余额: '1,000.50', 余额来源: '网银', 余额获取方式: '自动' }),
      bank({ 币种: 'usd', 账单日期: '2026-09-30', 期末余额: '1200', 余额来源: '人工调整', 余额获取方式: '手工' }),
      bank({ 账单日期: '2026-10-01', 期末余额: '9999', 余额来源: '网银', 余额获取方式: '自动' }),
      bank({ 银行账户号: 'M002', 币种: 'EUR', 开户地: '北京', 账单日期: '2026-09-30', 期末余额: '200' }),
      bank({ 银行账户号: 'M009', 账单日期: '2026-09-30', 期末余额: '1' }),
      bank({ 银行账户号: '', 账单日期: '2026-09-30', 期末余额: '1' })
    ]);
    const matched = importBalanceFile(balanceFilePath, firstPrompt);
    assertEq(matched.skippedRowCount, 1, 'Step2.账号为空的行跳过');
    assertEq([matched.matchedCount, matched.choiceCount, matched.manualCount], [0, 1, 1], 'Step2.计数');
    assertEq(matched.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance, account.reason]), [
      ['M001', 'choice', '2026-09-30', null, '文件中 2026-09-30 有 2 个不同余额，请选择'],
      ['M002', 'manual', '', null, '文件中该账号的银行名 / 开户地为 中行 / 北京，与本组 中行 / 上海 不一致']
    ], 'Step2.同日多个不同余额待选择，银行名 / 开户地对不上的需手工录入');
    const choices = matched.accounts[0].choices;
    assertEq(choices.map((choice) => [choice.billDate, choice.bankName, choice.location, choice.currency, choice.merchantId,
      choice.endBalance, choice.balanceSource, choice.balanceMethod]), [
      ['2026-09-30', '中行', '上海', 'USD', 'M001', 1000.5, '网银', '自动'],
      ['2026-09-30', '中行', '上海', 'USD', 'M001', 1200, '人工调整', '手工']
    ], 'Step2.待选择行带取值字段与余额来源 / 余额获取方式');
    // 用户在「选择余额」里选第一行（网银 1,000.50），确认页按所选行预填
    const chosen = choices[0];

    // Step 3：用户在确认页补全 M002 后确认；逐个账号按当前提示保存，每次重算
    const confirmed = new Map([
      ['M001@@USD', { merchantId: 'M001', currency: 'USD', billDate: chosen.billDate, endBalance: String(chosen.endBalance) }],
      ['M002@@EUR', { merchantId: 'M002', currency: 'EUR', billDate: '2026-09-30', endBalance: '200' }]
    ]);
    let prompt = firstPrompt;
    let latest = first;
    const savedOrder = [];
    while (prompt && confirmed.has(`${prompt.merchantId}@@${prompt.currency}`)) {
      const entry = confirmed.get(`${prompt.merchantId}@@${prompt.currency}`);
      confirmed.delete(`${prompt.merchantId}@@${prompt.currency}`);
      // 错位保护：带别的账号或别的分组（输出名称）提交会被拒绝，不写种子，并带回当前提示
      const other = prompt.merchantId === 'M001' ? { merchantId: 'M002', currency: 'EUR' } : { merchantId: 'M001', currency: 'USD' };
      const before = readBalanceSeedRecords(storageRoot, '中行').length;
      for (const [label, binding] of [['账号', { ...other, templateName: prompt.templateName }], ['分组', { merchantId: prompt.merchantId, currency: prompt.currency, templateName: '工行-北京' }]]) {
        const rejected = prepareSave(storageRoot, prompt, { billDate: entry.billDate, endBalance: entry.endBalance, ...binding });
        assertEq([rejected.proceed, rejected.result.errorCode, rejected.result.manualBalancePrompt.merchantId],
          [false, 'BALANCE_SEED_ACCOUNT_CHANGED', prompt.merchantId], `Step3.${prompt.merchantId} ${label}错位提交被拒绝并带回当前提示`);
      }
      assertEq(readBalanceSeedRecords(storageRoot, '中行').length, before, `Step3.${prompt.merchantId} 错位提交不写种子`);

      const prepared = prepareSave(storageRoot, prompt, {
        billDate: entry.billDate,
        endBalance: entry.endBalance,
        merchantId: prompt.merchantId,
        currency: prompt.currency,
        templateName: prompt.templateName
      });
      assertTrue(prepared.proceed === true, `Step3.${prompt.merchantId} 预检通过`);
      writeManualBalanceSeedPlan(prepared.plan);
      savedOrder.push(prompt.merchantId);
      latest = generate();
      prompt = seedPrompt(latest);
    }
    assertEq(savedOrder, ['M001', 'M002'], 'Step3.按主进程提示顺序逐个保存');
    assertEq(prompt, null, 'Step3.全部补录后不再提示');
    assertTrue(Boolean(latest.balance && fs.existsSync(latest.balance.filePath)), 'Step3.生成余额账单');

    // Step 4：余额回读与种子落盘
    assertEq(readBalanceSheet(latest.balance.filePath), [
      ['M001', 'USD', '2026-10-01', 1100.6],
      ['M001', 'USD', '2026-10-02', 1080.55],
      ['M002', 'EUR', '2026-10-01', 150]
    ], 'Step4.以导入余额为起点推导的期末余额');
    const manualSeeds = readBalanceSeedRecords(storageRoot, '中行')
      .filter((record) => record.generationMethod === '人工录入')
      .map((record) => [record.merchantId, record.currency, record.billDate, record.endBalance]);
    assertEq(manualSeeds, [
      ['M001', 'USD', '2026-09-30', 1000.5],
      ['M002', 'EUR', '2026-09-30', 200]
    ], 'Step4.种子按人工录入原值落盘');

    verifySeedMismatchImport(dir);
    verifyFileRowNumbersAndXlsxOnly(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
