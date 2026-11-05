// 网银账单：发生额计算余额的日期断档 e2e 集成验证
//   覆盖：真实 xlsx 读取 → 生成层断档判定 → 补录一处（真实种子文件写入）→ 不补录另一处
//         → 余额 xlsx 写出与回读 → 计算种子落盘
//         → 按文件名映射多模板：全部范围重算余额不覆盖同名的当前批次汇总文件（主进程真实合并函数）
//         → 按文件名映射多模板导入：一组断档时不出部分余额汇总，不补录后重算出含全部模板的汇总
//   UI 弹窗与 IPC 由单测和 GUI 检查覆盖；本脚本验证金额与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-balance-gap.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

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
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
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

// 取 src/main.js 中的真实函数，依赖按名注入。
function loadMainFunction(name, deps = {}) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  if (!node) throw new Error(`未找到 main.js 函数：${name}`);
  const names = Object.keys(deps);
  return Function(...names, `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(...names.map((key) => deps[key]));
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

// Step 5：按文件名映射两套模板，当前批次与历史批次日期范围相同；
//         先生成当前批次汇总余额，再按全部范围重算，回读确认当前批次文件不变。
async function verifyMergedScopeIsolation(dir) {
  const storageRoot = path.join(dir, 'storage-merge');
  const outputDir = path.join(dir, 'exports-merge');
  fs.mkdirSync(outputDir, { recursive: true });
  const today = '2026-10-28';
  const templates = { 1: '中行-上海', 2: '工行-北京' };
  const accounts = { 1: ['M101', 'M102'], 2: ['M201', 'M202'] };
  const entriesByScope = { current: [], all: [] };
  for (const tid of [1, 2]) {
    accounts[tid].forEach((merchantId, index) => {
      upsertBalanceSeedRecord(storageRoot, {
        templateName: templates[tid], merchantId, currency: 'USD',
        billDate: '2026-08-31', endBalance: 100 * (index + 1), generationMethod: '人工录入'
      });
      const sourcePath = path.join(dir, `merge-${merchantId}.xlsx`);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
        ['2026-09-01', merchantId, 'USD', '10', ''],
        ['2026-09-02', merchantId, 'USD', '', '1']
      ]), 'Sheet1');
      XLSX.writeFile(workbook, sourcePath);
      const entry = {
        matchedTemplateId: tid,
        filePath: sourcePath,
        detailRows: buildMappedRows({
          inputFilePath: sourcePath,
          orderedTargetFields: ORDERED_FIELDS,
          mappingByField: {
            BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
            'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
          }
        })
      };
      // 每个模板的第二个账号属于历史批次。
      if (index === 0) entriesByScope.current.push(entry);
      entriesByScope.all.push(entry);
    });
  }

  const generation = createGeneration(storageRoot, outputDir, new Set());
  const sanitizeFileName = loadMainFunction('sanitizeFileName');
  const buildOutputFilePath = loadMainFunction('buildOutputFilePath', {
    getToday: () => today, path, ensureStorageRoot: () => storageRoot, sanitizeFileName
  });
  const regenerate = loadMainFunction('regenerateVirtualTemplateBalanceFromSession', {
    getStatementSessionEntries: (_session, scope) => entriesByScope[scope],
    getTemplateMappingConfig: (tid) => ({ template: { id: tid, name: templates[tid] }, exportMappings: [], exportTargetFields: [] }),
    appendActivityLogEntry: () => {},
    buildStatementGenerationConfig: ({ template }) => ({
      template,
      mappingByTargetField: { MerchantId: 'Account' },
      balanceRequested: true,
      balanceMode: 'calculated'
    }),
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    extractManualBalancePromptWarning: generation.extractManualBalancePromptWarning,
    statementGenerationHelpers: generation,
    buildDateRangeLabel,
    buildOutputFilePath,
    mergeGeneratedXlsxFiles: loadMainFunction('mergeGeneratedXlsxFiles', {
      require, fs, path, applyWatermark: () => {}
    }),
    getToday: () => today,
    path,
    scopedMergedOutputFileName: loadMainFunction('scopedMergedOutputFileName')
  });
  const accountsIn = (filePath) => [...new Set(readBalanceSheet(filePath).map((row) => row[0]))].sort();

  const current = regenerate({ key: 'merge-session' }, 'current').generatedFiles.balance;
  assertEq(accountsIn(current.filePath), ['M101', 'M201'], 'Step5.当前批次汇总只含当前账号');
  const all = regenerate({ key: 'merge-session' }, 'all').generatedFiles.balance;
  assertTrue(all.filePath !== current.filePath, 'Step5.全部范围汇总文件与当前批次隔离');
  assertEq(all.fileName, current.fileName, 'Step5.对外文件名不变');
  assertEq(accountsIn(current.filePath), ['M101', 'M201'], 'Step5.回读当前批次汇总未被全部范围覆盖');
  assertEq(accountsIn(all.filePath), ['M101', 'M102', 'M201', 'M202'], 'Step5.全部范围汇总含全部账号');
}

// Step 6：按文件名映射三套模板一次导入，只有第三组断档；
//         导入时不合并、不缓存只含两组的余额汇总，不补录后重算的汇总含三组账号。
async function verifyMultiTemplateImportHoldsPartialBalance(dir) {
  const storageRoot = path.join(dir, 'storage-import');
  const outputDir = path.join(dir, 'exports-import');
  fs.mkdirSync(outputDir, { recursive: true });
  const today = '2026-10-29';
  const groups = [
    { tid: 1, templateName: '中行-上海', merchantId: 'M301', dates: ['2026-09-01', '2026-09-02'] },
    { tid: 2, templateName: '工行-北京', merchantId: 'M302', dates: ['2026-09-01', '2026-09-02'] },
    { tid: 3, templateName: '建行-深圳', merchantId: 'M303', dates: ['2026-09-01', '2026-09-04'] }
  ];
  const templates = Object.fromEntries(groups.map((group) => [group.tid, group.templateName]));
  const fileEntries = groups.map((group) => {
    upsertBalanceSeedRecord(storageRoot, {
      templateName: group.templateName, merchantId: group.merchantId, currency: 'USD',
      billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
    });
    const sourcePath = path.join(dir, `import-${group.merchantId}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ...group.dates.map((date) => [date, group.merchantId, 'USD', '10', ''])
    ]), 'Sheet1');
    XLSX.writeFile(workbook, sourcePath);
    return {
      matchedTemplateId: group.tid,
      filePath: sourcePath,
      detailRows: buildMappedRows({
        inputFilePath: sourcePath,
        orderedTargetFields: ORDERED_FIELDS,
        mappingByField: {
          BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
          'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
        }
      })
    };
  });

  const acknowledgedKeys = new Set();
  const generation = createGeneration(storageRoot, outputDir, acknowledgedKeys);
  const sanitizeFileName = loadMainFunction('sanitizeFileName');
  const buildOutputFilePath = loadMainFunction('buildOutputFilePath', {
    getToday: () => today, path, ensureStorageRoot: () => storageRoot, sanitizeFileName
  });
  const mergeGeneratedXlsxFiles = loadMainFunction('mergeGeneratedXlsxFiles', {
    require, fs, path, applyWatermark: () => {}
  });
  const buildGenerationConfig = ({ template }) => ({
    template,
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: true,
    balanceMode: 'calculated'
  });
  const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };
  const imported = [];
  const generateGroups = loadMainFunction('generateMultiTemplateGroupFiles', {
    getEntryTemplateConfig: ({ entry }) => ({
      template: { id: entry.matchedTemplateId, name: templates[entry.matchedTemplateId] },
      exportMappings: [{ templateField: 'MerchantId', mappedField: 'Account' }],
      exportTargetFields: ORDERED_FIELDS
    }),
    normalizeCell,
    FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI__',
    buildStatementGenerationConfig: buildGenerationConfig,
    rebuildMatchedTemplateFileEntries: ({ fileEntries: entries }) => entries,
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
    removeStatementSessionEntriesByFilePath: () => {},
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    buildDateRangeLabel,
    getToday: () => today,
    buildOutputFilePath,
    mergeGeneratedXlsxFiles,
    path,
    buildStatementFileEntry: (entry) => entry,
    buildStatementFileEntryId: () => 'entry',
    appendStatementSessionImport: () => 'import-batch',
    buildStatementBatchId: () => 'import-batch',
    lastGeneratedExports,
    updateStatementSessionCache: (session, batchId, generatedFiles) => {
      generation.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
    },
    buildImportResultFromGeneratedFiles: ({ generatedFiles }) => {
      imported.push(generatedFiles);
      return { status: 'captured' };
    },
    FILENAME_MAPPING_TEMPLATE_ID: '__FILENAME_MAPPING__'
  });
  generateGroups({
    fileEntries,
    fallbackTemplateConfig: {},
    selectedBigAccount: null,
    session: { key: 'import-session' },
    inputFilePaths: fileEntries.map((entry) => entry.filePath)
  });

  const [importedFiles] = imported;
  const gaps = importedFiles.warnings.find((warning) => warning.type === 'balance-gap-confirm')?.gaps || [];
  const balanceFolder = path.join(storageRoot, 'exports', today, 'balance');
  const summaryFiles = () => (fs.existsSync(balanceFolder) ? fs.readdirSync(balanceFolder) : [])
    .filter((name) => name.startsWith('3-BALANCE-'));
  assertEq(gaps.map((gap) => [gap.merchantId, gap.anchorDate, gap.targetBillDate]), [
    ['M303', '2026-09-01', '2026-09-04']
  ], 'Step6.只有第三组断档');
  assertEq(importedFiles.balance, null, 'Step6.导入结果不带余额汇总');
  assertEq(lastGeneratedExports.balance, null, 'Step6.不缓存部分余额汇总');
  assertEq(summaryFiles(), [], 'Step6.导出目录没有只含两组的余额汇总');
  assertTrue(Boolean(importedFiles.detail && fs.existsSync(importedFiles.detail.filePath)), 'Step6.明细汇总照常生成');

  // 第三组选择不补录后，按全部模板组重算当前批次余额。
  acknowledgedKeys.add(gaps[0].key);
  const regenerate = loadMainFunction('regenerateVirtualTemplateBalanceFromSession', {
    getStatementSessionEntries: () => fileEntries,
    getTemplateMappingConfig: (tid) => ({ template: { id: tid, name: templates[tid] }, exportMappings: [], exportTargetFields: [] }),
    appendActivityLogEntry: () => {},
    buildStatementGenerationConfig: buildGenerationConfig,
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    extractManualBalancePromptWarning: generation.extractManualBalancePromptWarning,
    statementGenerationHelpers: generation,
    buildDateRangeLabel,
    buildOutputFilePath,
    mergeGeneratedXlsxFiles,
    getToday: () => today,
    path,
    scopedMergedOutputFileName: loadMainFunction('scopedMergedOutputFileName')
  });
  const regenerated = regenerate({ key: 'import-session' }, 'current');
  assertEq(regenerated.needsSeed, false, 'Step6.不补录后可以重算');
  const summary = regenerated.generatedFiles?.balance;
  assertEq(summaryFiles(), summary ? [summary.fileName] : [], 'Step6.重算后只有一份余额汇总');
  assertEq(summary ? readBalanceSheet(summary.filePath).map((row) => [row[0], row[2], row[3]]) : [], [
    ['M301', '2026-09-01', 1010],
    ['M301', '2026-09-02', 1020],
    ['M302', '2026-09-01', 1010],
    ['M302', '2026-09-02', 1020],
    ['M303', '2026-09-01', 1010],
    ['M303', '2026-09-04', 1020]
  ], 'Step6.回读余额汇总：三组账号齐全，M303 接着断档前余额');
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

    await verifyMergedScopeIsolation(dir);
    await verifyMultiTemplateImportHoldsPartialBalance(dir);
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
