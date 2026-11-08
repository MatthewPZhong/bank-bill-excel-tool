// v3.2.15 网银账单深审修复 e2e 集成验证（账单里的余额）
//   覆盖：真实 CSV / 文本 xlsx / 数值 xlsx 读取 → 映射 → 生成层余额推导 → 余额 xlsx 写出与回读 → 种子落盘
//     F01 负余额保号（正负跨日）；F07 直接映射余额保留原精度；
//     F05 余额附加值从生效日起每天叠加，一次导入与分次导入结果一致；
//     F03 有金额的行账单日期无效时整份拒绝，不产生明细与余额文件。
//   大账号续跑覆盖身份（F02）与导出全部阻断（F04）在主进程单测中执行真实函数验证。
//
// 用法：node scripts/integration/statement-balance-review-fixes.js

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
const { readBalanceAdjustments, writeBalanceAdjustments } = require('../../src/backend/balance-adjustment-store');
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus
} = require('../../src/main-process/statement-generation-business');
const {
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');

const ROOT = path.join(__dirname, '..', '..');
const TEMPLATE_NAME = '中行-上海';
const SOURCE_HEADER = ['日期', '账号', '收入', '支出', '余额'];
const MAPPING = {
  BillDate: '日期',
  MerchantId: '账号',
  Currency: '__FIXED__:USD',
  'Credit Amount': '收入',
  'Debit Amount': '支出',
  Balance: '余额'
};

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
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SOURCE_HEADER, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function writeCsv(filePath, rows) {
  fs.writeFileSync(filePath, [SOURCE_HEADER, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n'));
  return filePath;
}

function mapFile(filePath) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: Object.keys(MAPPING),
    mappingByField: MAPPING,
    expectedSourceHeaders: SOURCE_HEADER
  });
}

const CONFIG = {
  template: { name: TEMPLATE_NAME },
  mappingByTargetField: MAPPING,
  balanceRequested: true,
  balanceMode: 'statement'
};

function generate(generation, filePaths) {
  return generation.generateStatementFiles({
    config: CONFIG,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({
      config: CONFIG,
      fileEntries: filePaths.map((filePath) => ({ filePath, detailRows: mapFile(filePath) }))
    })
  });
}

// 回读余额表单元格原值（cell.v），不经数字格式。
function readEndBalances(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const header = rows[0];
  return rows.slice(1).map((row) => {
    const { y, m, d } = XLSX.SSF.parse_date_code(row[header.indexOf('账单日期')]);
    return [`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, row[header.indexOf('期末余额')]];
  });
}

function readSeedBalances(storageRoot) {
  return readBalanceSeedRecords(storageRoot, '中行')
    .map((record) => [record.billDate, record.endBalance])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function freshRoots(dir, name) {
  const storageRoot = path.join(dir, `storage-${name}`);
  const outputDir = path.join(dir, `exports-${name}`);
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  return { storageRoot, outputDir };
}

async function run() {
  console.log('==== 网银账单余额深审修复 e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-balance-review-'));

  try {
    // Step 1：负余额与高精度余额经三种来源完整生成，回读余额表与种子
    const textRows = [
      ['2026-09-01', 'M1', '', '1', '-100.25'],
      ['2026-09-02', 'M1', '200', '', '99.75'],
      ['2026-09-03', 'M1', '900.373456', '', '1000.123456']
    ];
    const numericRows = textRows.map(([date, account, credit, debit, balance]) => [
      date, account, credit === '' ? '' : Number(credit), debit === '' ? '' : Number(debit), Number(balance)
    ]);
    const expected = [['2026-09-01', -100.25], ['2026-09-02', 99.75], ['2026-09-03', 1000.123456]];
    const sources = [
      ['CSV', writeCsv(path.join(dir, 'sign.csv'), textRows)],
      ['文本xlsx', writeXlsx(path.join(dir, 'sign-text.xlsx'), textRows)],
      ['数值xlsx', writeXlsx(path.join(dir, 'sign-number.xlsx'), numericRows)]
    ];
    for (const [label, filePath] of sources) {
      const { storageRoot, outputDir } = freshRoots(dir, label);
      const result = generate(createGeneration(storageRoot, outputDir), [filePath]);
      assertTrue(Boolean(result.balance && fs.existsSync(result.balance.filePath)), `Step1.${label}.余额账单生成`);
      assertEq(result.warnings, [], `Step1.${label}.无告警`);
      assertEq(readEndBalances(result.balance.filePath), expected, `Step1.${label}.余额表期末余额保号且保留原精度`);
      assertEq(readSeedBalances(storageRoot), expected, `Step1.${label}.种子保号且保留原精度`);
    }

    // Step 2：余额附加值（09-01 起 +10，09-03 起再 -3.5）每天叠加；一次导入与分次导入一致
    const adjustmentRows = [
      ['2026-09-01', 'M1', '1', '', '1000'],
      ['2026-09-02', 'M1', '1', '', '1001'],
      ['2026-09-03', 'M1', '1', '', '1002']
    ];
    const adjustments = [
      { merchantId: 'M1', currency: 'USD', effectiveDate: '2026-09-01', adjustmentValue: 10, templateName: TEMPLATE_NAME },
      { merchantId: 'M1', currency: 'USD', effectiveDate: '2026-09-03', adjustmentValue: -3.5, templateName: TEMPLATE_NAME }
    ];
    const adjustedExpected = [['2026-09-01', 1010], ['2026-09-02', 1011], ['2026-09-03', 1008.5]];

    const once = freshRoots(dir, 'adjust-once');
    writeBalanceAdjustments(once.storageRoot, '中行', adjustments);
    const onceResult = generate(createGeneration(once.storageRoot, once.outputDir), [
      writeXlsx(path.join(dir, 'adjust-all.xlsx'), adjustmentRows)
    ]);
    assertEq(readEndBalances(onceResult.balance.filePath), adjustedExpected, 'Step2.一次导入三天：附加值每天生效');
    assertEq(readSeedBalances(once.storageRoot), adjustedExpected, 'Step2.一次导入种子');

    const split = freshRoots(dir, 'adjust-split');
    writeBalanceAdjustments(split.storageRoot, '中行', adjustments);
    const splitGeneration = createGeneration(split.storageRoot, split.outputDir);
    const firstSplit = generate(splitGeneration, [writeXlsx(path.join(dir, 'adjust-1.xlsx'), adjustmentRows.slice(0, 2))]);
    const secondSplit = generate(splitGeneration, [writeXlsx(path.join(dir, 'adjust-2.xlsx'), adjustmentRows.slice(2))]);
    assertEq(
      [...readEndBalances(firstSplit.balance.filePath), ...readEndBalances(secondSplit.balance.filePath)],
      adjustedExpected,
      'Step2.分两次导入与一次导入结果一致'
    );
    assertEq(readSeedBalances(split.storageRoot), adjustedExpected, 'Step2.分次导入种子与一次导入一致');

    // Step 3：有金额的行账单日期无效（2026-09-31）→ 整份拒绝，列出行号与原值，不产生文件
    const invalid = freshRoots(dir, 'invalid-date');
    const invalidPath = writeXlsx(path.join(dir, 'invalid-date.xlsx'), [
      ['2026-09-01', 'M1', '1', '', '1001'],
      ['2026-09-31', 'M1', '200', '', '1201']
    ]);
    let invalidError = null;
    try {
      generate(createGeneration(invalid.storageRoot, invalid.outputDir), [invalidPath]);
    } catch (error) {
      invalidError = error;
    }
    assertTrue(invalidError instanceof FileValidationError, 'Step3.无效账单日期抛出 FileValidationError');
    assertEq(invalidError && invalidError.message, '账单日期存在无效值：第 3 行「2026-09-31」，请修正后重新导入', 'Step3.错误信息含行号与原值');
    assertEq(invalidError && invalidError.detailLines, ['第 3 行：2026-09-31'], 'Step3.错误明细');
    assertEq(fs.readdirSync(invalid.outputDir), [], 'Step3.不产生明细与余额文件');
    assertEq(readBalanceSeedRecords(invalid.storageRoot, '中行'), [], 'Step3.不写种子');
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
