// 网银账单：补录余额「导入余额文件」e2e 集成验证（v3.2.17）
//   覆盖：真实 xlsx 读取 → 生成层缺种子提示带待补录清单 → 真实余额文件（xlsx）读取、按列名解析与按账号匹配
//         → 按确认结果逐个账号走现行补录预检与种子写入（请求带账号，错位即拒绝）→ 每次重算
//         → 余额 xlsx 写出与回读 → 种子按人工录入原值落盘
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
const BALANCE_FIELDS = ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'];

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

    // Step 2：真实余额文件（本工具余额账单格式，前有标题行）：M001 取早于 10-01 的最近一天，M002 文件中没有
    const balanceFilePath = path.join(dir, '余额.xlsx');
    writeXlsx(balanceFilePath, [
      ['上月余额'],
      BALANCE_FIELDS,
      ['中行', '上海', 'usd', 'M001', '2026-09-29', '', '', '500', ''],
      ['中行', '上海', 'USD', 'M001', '2026/09/30', '', '', '1,000.50', ''],
      ['中行', '上海', 'USD', 'M001', '2026-10-01', '', '', '9999', ''],
      ['中行', '上海', 'USD', 'M009', '2026-09-30', '', '', '1', ''],
      ['中行', '上海', 'USD', '', '2026-09-30', '', '', '1', '']
    ]);
    const { rows: balanceRows, displayRows, date1904 } = readBalanceSeedImportFile(balanceFilePath);
    const { records, skippedRowCount } = parseBalanceSeedImportRows(balanceRows, { displayRows, date1904 });
    const matched = matchBalanceSeedImport(records, firstPrompt.pendingAccounts);
    assertEq(skippedRowCount, 1, 'Step2.账号为空的行跳过');
    assertEq(matched.accounts.map((account) => [account.merchantId, account.source, account.billDate, account.endBalance, account.reason]), [
      ['M001', 'file', '2026-09-30', 1000.5, ''],
      ['M002', 'manual', '', null, '文件中没有该账号']
    ], 'Step2.按账号与币种提取，提取不到的需手工录入');

    // Step 3：用户在确认页补全 M002 后确认；逐个账号按当前提示保存，每次重算
    const confirmed = new Map([
      ['M001@@USD', { merchantId: 'M001', currency: 'USD', billDate: '2026-09-30', endBalance: '1000.5' }],
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
