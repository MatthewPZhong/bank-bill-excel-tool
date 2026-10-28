// 网银账单：发生额计算余额的日期断档 e2e 集成验证
//   覆盖：真实 xlsx 读取 → 生成层断档判定 → 补录一处（真实种子文件写入）→ 不补录另一处
//         → 余额 xlsx 写出与回读 → 计算种子落盘
//   UI 弹窗与 IPC 由单测和 GUI 检查覆盖；本脚本验证金额与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-balance-gap.js

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
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus
} = require('../../src/main-process/statement-generation-business');
const {
  buildManualBalanceSeedPlan,
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

function createGeneration(storageRoot, outputDir, acknowledgedKeys) {
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
    getAcknowledgedBalanceGapKeys: () => acknowledgedKeys,
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

function writeSource(filePath) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
    ['2026-09-01', 'M001', 'USD', '100.10', ''],
    ['2026-09-02', 'M001', 'USD', '', '20.05'],
    ['2026-09-05', 'M001', 'USD', '30', ''],
    ['2026-09-01', 'M002', 'EUR', '50', ''],
    ['2026-09-03', 'M002', 'EUR', '', '10']
  ]), 'Sheet1');
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

async function run() {
  console.log('==== 网银账单发生额余额断档 e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-balance-gap-'));
  const storageRoot = path.join(dir, 'storage');
  const outputDir = path.join(dir, 'exports');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const sourcePath = path.join(dir, 'gap-source.xlsx');
    writeSource(sourcePath);
    ['M001@@USD', 'M002@@EUR'].forEach((key, index) => {
      const [merchantId, currency] = key.split('@@');
      upsertBalanceSeedRecord(storageRoot, {
        templateName: TEMPLATE_NAME, merchantId, currency,
        billDate: '2026-08-31', endBalance: index === 0 ? 1000 : 2000, generationMethod: '人工录入'
      });
    });
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
    const acknowledgedKeys = new Set();
    const generation = createGeneration(storageRoot, outputDir, acknowledgedKeys);
    const generate = () => generation.generateStatementFiles({
      config,
      preparedBatch: generation.buildPreparedStatementBatchFromEntries({
        config,
        fileEntries: [{ filePath: sourcePath, detailRows }]
      })
    });

    // Step 1：首次生成发现两处断档，不出余额表、不写计算种子
    const first = generate();
    const gaps = first.warnings.find((warning) => warning.type === 'balance-gap-confirm')?.gaps || [];
    assertTrue(Boolean(first.detail && fs.existsSync(first.detail.filePath)), 'Step1.明细账单照常生成');
    assertEq(first.balance, null, 'Step1.未确认断档时不生成余额账单');
    assertEq(gaps.map((gap) => [gap.merchantId, gap.anchorDate, gap.targetBillDate, gap.suggestedSeedDate]), [
      ['M001', '2026-09-02', '2026-09-05', '2026-09-04'],
      ['M002', '2026-09-01', '2026-09-03', '2026-09-02']
    ], 'Step1.两处断档信息');
    assertEq(readBalanceSeedRecords(storageRoot, '中行').length, 2, 'Step1.未写入计算种子');

    // Step 2：为 M001 补录断档前一日（09-04）余额，写入真实种子文件
    const m001Gap = gaps[0];
    const planResult = buildManualBalanceSeedPlan({
      payload: { billDate: m001Gap.suggestedSeedDate, endBalance: '5000.25' },
      pendingPrompt: { reason: 'gap', ...m001Gap, gapKey: m001Gap.key, gaps },
      importContext: { template: { name: TEMPLATE_NAME } },
      storageRoot
    });
    assertEq(planResult.stopResult, undefined, 'Step2.补录计划有效');
    writeManualBalanceSeedPlan(planResult.plan);
    const second = generate();
    const remaining = second.warnings.find((warning) => warning.type === 'balance-gap-confirm')?.gaps || [];
    assertEq(second.balance, null, 'Step2.仍有断档时不生成余额账单');
    assertEq(remaining.map((gap) => gap.key), [gaps[1].key], 'Step2.只剩 M002 的断档');

    // Step 3：M002 选择不补录，照常生成
    acknowledgedKeys.add(remaining[0].key);
    const third = generate();
    assertTrue(Boolean(third.balance && fs.existsSync(third.balance.filePath)), 'Step3.余额账单生成');
    assertEq(third.warnings.map((warning) => warning.type), ['balance-gap-skipped'], 'Step3.带不补录告警');
    assertEq(readBalanceSheet(third.balance.filePath), [
      ['M001', 'USD', '2026-09-01', 1100.1],
      ['M001', 'USD', '2026-09-02', 1080.05],
      ['M001', 'USD', '2026-09-05', 5030.25],
      ['M002', 'EUR', '2026-09-01', 2050],
      ['M002', 'EUR', '2026-09-03', 2040]
    ], 'Step3.回读余额：M001 断档后按补录余额，M002 接着断档前余额');

    // Step 4：种子文件保留人工补录，并写入本次计算种子
    const seeds = readBalanceSeedRecords(storageRoot, '中行')
      .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]);
    assertEq(seeds, [
      ['M001', '2026-08-31', 1000, '人工录入'],
      ['M001', '2026-09-01', 1100.1, '通过发生额计算'],
      ['M001', '2026-09-02', 1080.05, '通过发生额计算'],
      ['M001', '2026-09-04', 5000.25, '人工录入'],
      ['M001', '2026-09-05', 5030.25, '通过发生额计算'],
      ['M002', '2026-08-31', 2000, '人工录入'],
      ['M002', '2026-09-01', 2050, '通过发生额计算'],
      ['M002', '2026-09-03', 2040, '通过发生额计算']
    ], 'Step4.种子文件内容');
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
