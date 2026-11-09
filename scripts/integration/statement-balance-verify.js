// 网银账单：账单里的余额逐日校验 e2e 集成验证（v3.2.16）
//   覆盖：真实 xlsx 读取 → 首日缺种子要求补录 → 人工补录（真实种子文件写入）
//         → 逐日校验：跨周末无净发生额直接通过，单一余额不符一次列全（含缺的日期）
//         → 确认继续：按账单余额写出余额 xlsx 并回读、种子回写、导入告警摘要与明细（主进程真实函数）
//         → 下一次导入以回写的种子为起点接着校验
//         → 按文件名映射多模板导入：一组不一致时不出部分余额汇总，确认后重算出含全部模板的汇总
//         → 同一账单日已有人工补录且与本次余额不一致：账单里的余额与发生额计算都先提醒（列出两个值），确认后才替换
//         → 上一账单日余额补错（首日多个余额都对不上）：补录提示写明对不上的明细，改对后覆盖种子并正常生成
//   UI 弹窗与 IPC 由单测和 GUI 检查覆盖；本脚本验证金额与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-balance-verify.js

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
const { resolveGenerationGroupKey, resolveStatementOutputName } = require('../../src/main-process/statement-channel-identity');
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
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
const MAPPING = {
  BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
  'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
};
const SOURCE_HEADER = ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'];

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
    readBalanceSeedRecords,
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

// 本脚本的模板都不属于渠道，按模板各自成组。
function loadGroupingFunction(getTemplateMappingConfig) {
  return loadMainFunction('groupStatementEntriesForGeneration', {
    database: { getTemplate: (id) => ({ id, channelId: null }) },
    resolveGenerationGroupKey,
    getTemplateMappingConfig
  });
}

// 多模板生成进入副作用前核对各组输出名称；本脚本的模板各不同名、库里没有渠道，用真实函数确认直接放行。
function loadOutputNameConflictFunctions(templateNames) {
  const owners = { templates: Object.entries(templateNames).map(([id, name]) => ({ id: Number(id), name })), channels: [] };
  const database = {
    listStatementOutputOwners: () => owners,
    getTemplate: (id) => ({ id: Number(id), name: templateNames[id], channelId: null })
  };
  const findGenerationGroupOutputNameConflicts = loadMainFunction('findGenerationGroupOutputNameConflicts', {
    database,
    resolveStatementOutputName,
    normalizeCell,
    sanitizeFileName: loadMainFunction('sanitizeFileName')
  });
  const buildStatementOutputNameConflictError = loadMainFunction('buildStatementOutputNameConflictError', { FileValidationError });
  return {
    assertGenerationOutputNameUnique: loadMainFunction('assertGenerationOutputNameUnique', {
      database,
      resolveGenerationGroupKey,
      findGenerationGroupOutputNameConflicts,
      buildStatementOutputNameConflictError
    }),
    findGenerationGroupOutputPathConflicts: loadMainFunction('findGenerationGroupOutputPathConflicts', {
      database,
      normalizeCell,
      sanitizeFileName: loadMainFunction('sanitizeFileName'),
      resolveGenerationGroupKey
    }),
    buildStatementOutputPathConflictError: loadMainFunction('buildStatementOutputPathConflictError', { FileValidationError })
  };
}

function loadRegenerateFunction(deps) {
  const planVirtualTemplateBalanceRegeneration = loadMainFunction('planVirtualTemplateBalanceRegeneration', {
    getStatementSessionEntries: deps.getStatementSessionEntries,
    groupStatementEntriesForGeneration: deps.groupStatementEntriesForGeneration,
    buildStatementGenerationConfig: deps.buildStatementGenerationConfig,
    buildPreparedStatementBatchFromEntries: deps.buildPreparedStatementBatchFromEntries
  });
  const assertVirtualTemplateBalanceOutputPaths = loadMainFunction('assertVirtualTemplateBalanceOutputPaths', {
    findGenerationGroupOutputPathConflicts: deps.findGenerationGroupOutputPathConflicts,
    buildStatementOutputPathConflictError: deps.buildStatementOutputPathConflictError
  });
  return loadMainFunction('regenerateVirtualTemplateBalanceFromSession', {
    ...deps,
    planVirtualTemplateBalanceRegeneration,
    assertVirtualTemplateBalanceOutputPaths
  });
}

function writeSource(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([SOURCE_HEADER, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function mapSource(filePath) {
  return buildMappedRows({ inputFilePath: filePath, orderedTargetFields: ORDERED_FIELDS, mappingByField: MAPPING });
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

const STATEMENT_CONFIG = {
  template: { name: TEMPLATE_NAME },
  mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
  balanceRequested: true,
  balanceMode: 'statement'
};

// Step 6：按文件名映射三套模板一次导入，只有第三组余额不一致；
//         导入时不合并、不缓存只含两组的余额汇总，确认后重算的汇总含三组账号。
async function verifyMultiTemplateImportHoldsPartialBalance(dir) {
  const storageRoot = path.join(dir, 'storage-import');
  const outputDir = path.join(dir, 'exports-import');
  fs.mkdirSync(outputDir, { recursive: true });
  const today = '2026-11-08';
  const groups = [
    { tid: 1, templateName: '中行-上海', merchantId: 'M301', balances: ['1010', '1020'] },
    { tid: 2, templateName: '工行-北京', merchantId: 'M302', balances: ['1010', '1020'] },
    { tid: 3, templateName: '建行-深圳', merchantId: 'M303', balances: ['1010', '1500'] }
  ];
  const templates = Object.fromEntries(groups.map((group) => [group.tid, group.templateName]));
  const fileEntries = groups.map((group) => {
    upsertBalanceSeedRecord(storageRoot, {
      templateName: group.templateName, merchantId: group.merchantId, currency: 'USD',
      billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
    });
    const sourcePath = path.join(dir, `import-${group.merchantId}.xlsx`);
    writeSource(sourcePath, [
      ['2026-09-01', group.merchantId, 'USD', '10', '', group.balances[0]],
      ['2026-09-02', group.merchantId, 'USD', '10', '', group.balances[1]]
    ]);
    return { matchedTemplateId: group.tid, filePath: sourcePath, detailRows: mapSource(sourcePath) };
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
  const buildGenerationConfig = ({ template }) => ({ ...STATEMENT_CONFIG, template });
  const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };
  const imported = [];
  const templateConfig = (tid) => ({ template: { id: tid, name: templates[tid] }, exportMappings: [], exportTargetFields: [] });
  const generateGroups = loadMainFunction('generateMultiTemplateGroupFiles', {
    groupStatementEntriesForGeneration: loadGroupingFunction(templateConfig),
    ...loadOutputNameConflictFunctions(templates),
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
  const mismatches = generation.extractBalanceMismatchConfirmItems(importedFiles.warnings);
  const balanceFolder = path.join(storageRoot, 'exports', today, 'balance');
  const summaryFiles = () => (fs.existsSync(balanceFolder) ? fs.readdirSync(balanceFolder) : [])
    .filter((name) => name.startsWith('3-BALANCE-'));
  assertEq(mismatches.map((item) => [item.merchantId, item.billDate, item.expectedBalance, item.statementBalance]), [
    ['M303', '2026-09-02', 1020, 1500]
  ], 'Step6.只有第三组余额不一致');
  assertEq(importedFiles.balance, null, 'Step6.导入结果不带余额汇总');
  assertEq(importedFiles.balanceRequested, true, 'Step6.仍标记请求了余额');
  assertEq(lastGeneratedExports.balance, null, 'Step6.不缓存部分余额汇总');
  assertEq(summaryFiles(), [], 'Step6.导出目录没有只含两组的余额汇总');
  assertTrue(Boolean(importedFiles.detail && fs.existsSync(importedFiles.detail.filePath)), 'Step6.明细汇总照常生成');
  // 种子回写（资金红线）：各模板组独立生成，通过校验的两组照常回写，待确认的第三组一条都不写。
  const seedsOf = (bankName) => readBalanceSeedRecords(storageRoot, bankName)
    .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]);
  assertEq(seedsOf('中行'), [
    ['M301', '2026-08-31', 1000, '人工录入'], ['M301', '2026-09-01', 1010, '账单里的余额'], ['M301', '2026-09-02', 1020, '账单里的余额']
  ], 'Step6.通过校验的模板组照常回写种子');
  assertEq(seedsOf('建行'), [['M303', '2026-08-31', 1000, '人工录入']], 'Step6.待确认的模板组不回写种子');

  // 先不确认：重算仍返回待确认的不一致，不出汇总。
  const regenerate = loadRegenerateFunction({
    getStatementSessionEntries: () => fileEntries,
    groupStatementEntriesForGeneration: loadGroupingFunction(templateConfig),
    ...loadOutputNameConflictFunctions(templates),
    getTemplateMappingConfig: templateConfig,
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
  const pending = regenerate({ key: 'import-session' }, 'current');
  assertEq(pending.needsSeed, true, 'Step6.未确认时重算仍待处理');
  assertEq((pending.mismatches || []).map((item) => item.key), mismatches.map((item) => item.key), 'Step6.重算返回同一处不一致');

  // 确认继续后按全部模板组重算当前批次余额。
  acknowledgedKeys.add(mismatches[0].key);
  const regenerated = regenerate({ key: 'import-session' }, 'current');
  assertEq(regenerated.needsSeed, false, 'Step6.确认后可以重算');
  const summary = regenerated.generatedFiles?.balance;
  assertEq(summaryFiles(), summary ? [summary.fileName] : [], 'Step6.重算后只有一份余额汇总');
  assertEq(summary ? readBalanceSheet(summary.filePath).map((row) => [row[0], row[2], row[3]]) : [], [
    ['M301', '2026-09-01', 1010],
    ['M301', '2026-09-02', 1020],
    ['M302', '2026-09-01', 1010],
    ['M302', '2026-09-02', 1020],
    ['M303', '2026-09-01', 1010],
    ['M303', '2026-09-02', 1500]
  ], 'Step6.回读余额汇总：三组账号齐全，M303 按账单余额');
  assertEq(seedsOf('建行'), [
    ['M303', '2026-08-31', 1000, '人工录入'], ['M303', '2026-09-01', 1010, '账单里的余额'], ['M303', '2026-09-02', 1500, '账单里的余额']
  ], 'Step6.确认后第三组按账单余额回写种子');
  assertEq(seedsOf('工行'), [
    ['M302', '2026-08-31', 1000, '人工录入'], ['M302', '2026-09-01', 1010, '账单里的余额'], ['M302', '2026-09-02', 1020, '账单里的余额']
  ], 'Step6.重算后其他模板组种子不变');
}

// Step 7：同一账单日已有人工补录，且与本次余额不一致 → 先提醒（列出人工补录值与本次余额），确认替换后才覆盖。
async function verifyManualSeedReplacement(dir) {
  const storageRoot = path.join(dir, 'storage-replace');
  const outputDir = path.join(dir, 'exports-replace');
  fs.mkdirSync(outputDir, { recursive: true });
  const acknowledgedKeys = new Set();
  const generation = createGeneration(storageRoot, outputDir, acknowledgedKeys);
  const seedsOf = () => readBalanceSeedRecords(storageRoot, '中行')
    .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]);
  const manual = (merchantId, currency, billDate, endBalance) => upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId, currency, billDate, endBalance, generationMethod: '人工录入', overwrite: true
  });
  const generateWith = (config, filePath, rows) => generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath, detailRows: rows }] })
  });
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatBalanceSeedReplaceLine = loadMainFunction('formatBalanceSeedReplaceLine', { formatBalanceAmount });

  // 账单里的余额：M401 09-04 人工补录 5000，账单 1100（与 09-03 种子 1000 + 收入 100 相符）。
  manual('M401', 'USD', '2026-09-03', 1000);
  manual('M401', 'USD', '2026-09-04', 5000);
  const statementPath = path.join(dir, 'replace-statement.xlsx');
  writeSource(statementPath, [['2026-09-04', 'M401', 'USD', '100', '', '1100']]);
  const statementRows = mapSource(statementPath);
  const pending = generateWith(STATEMENT_CONFIG, statementPath, statementRows);
  const replacements = generation.extractBalanceSeedReplaceConfirmItems(pending.warnings);
  assertEq(pending.balance, null, 'Step7.未确认替换时不生成余额账单');
  assertEq(replacements.map(formatBalanceSeedReplaceLine), [
    '银行账号：M401，币种：USD，账单日期：2026-09-04，人工补录余额：5,000.00，账单余额：1,100.00，差额：-3,900.00'
  ], 'Step7.提醒列出人工补录值与账单值');
  assertEq(seedsOf(), [['M401', '2026-09-03', 1000, '人工录入'], ['M401', '2026-09-04', 5000, '人工录入']], 'Step7.未确认时人工补录不被覆盖');
  replacements.forEach((item) => acknowledgedKeys.add(item.key));
  const replaced = generateWith(STATEMENT_CONFIG, statementPath, statementRows);
  assertEq(readBalanceSheet(replaced.balance.filePath), [['M401', 'USD', '2026-09-04', 1100]], 'Step7.确认后按账单余额生成');
  assertEq(seedsOf().find((row) => row[1] === '2026-09-04'), ['M401', '2026-09-04', 1100, '账单里的余额'], 'Step7.确认后替换人工补录');

  // 通过发生额计算：M402 09-02 人工补录 999，计算结果 1000 + 100 − 30 = 1070。
  manual('M402', 'USD', '2026-08-31', 1000);
  manual('M402', 'USD', '2026-09-02', 999);
  const calculatedConfig = { ...STATEMENT_CONFIG, balanceMode: 'calculated', mappingByTargetField: { MerchantId: 'Account' } };
  const calculatedPath = path.join(dir, 'replace-calculated.xlsx');
  writeSource(calculatedPath, [
    ['2026-09-01', 'M402', 'USD', '100', '', ''],
    ['2026-09-02', 'M402', 'USD', '', '30', '']
  ]);
  const calculatedRows = mapSource(calculatedPath);
  const calculatedPending = generateWith(calculatedConfig, calculatedPath, calculatedRows);
  const calculatedReplacements = generation.extractBalanceSeedReplaceConfirmItems(calculatedPending.warnings);
  assertEq(calculatedReplacements.map(formatBalanceSeedReplaceLine), [
    '银行账号：M402，币种：USD，账单日期：2026-09-02，人工补录余额：999.00，计算余额：1,070.00，差额：+71.00'
  ], 'Step7.发生额计算同样提醒，列出人工补录值与计算值');
  assertEq(seedsOf().filter((row) => row[0] === 'M402'), [
    ['M402', '2026-08-31', 1000, '人工录入'], ['M402', '2026-09-02', 999, '人工录入']
  ], 'Step7.发生额计算未确认时不写种子');
  calculatedReplacements.forEach((item) => acknowledgedKeys.add(item.key));
  const calculated = generateWith(calculatedConfig, calculatedPath, calculatedRows);
  assertEq(readBalanceSheet(calculated.balance.filePath).map((row) => [row[2], row[3]]), [['2026-09-01', 1100], ['2026-09-02', 1070]],
    'Step7.发生额计算确认后照常生成');
  assertEq(seedsOf().filter((row) => row[0] === 'M402'), [
    ['M402', '2026-08-31', 1000, '人工录入'], ['M402', '2026-09-01', 1100, '通过发生额计算'], ['M402', '2026-09-02', 1070, '通过发生额计算']
  ], 'Step7.发生额计算确认后替换人工补录');
}

// Step 8：用户反馈 KBANK-VN（v3.2.15）：首日两笔余额，上一账单日余额误补 0 → 原来回到同一个补录提示且错的种子已落盘。
//         现在补录提示写明已有余额对不上（主进程真实文案）；按账单期初余额重新补录（覆盖同日种子）后正常生成并回写。
//         金额为合成数据，只保留反馈账单的结构。
async function verifyWrongManualSeedPrompt(dir) {
  const storageRoot = path.join(dir, 'storage-seed-mismatch');
  const outputDir = path.join(dir, 'exports-seed-mismatch');
  fs.mkdirSync(outputDir, { recursive: true });
  const generation = createGeneration(storageRoot, outputDir, new Set());
  const sourcePath = path.join(dir, 'seed-mismatch.xlsx');
  writeSource(sourcePath, [
    ['2026-10-01', 'M801', 'VND', '0', '200000', '800000'],
    ['2026-10-01', 'M801', 'VND', '0', '1500', '798500'],
    ['2026-10-12', 'M801', 'VND', '300000', '0', '1098500']
  ]);
  const rows = mapSource(sourcePath);
  const generate = () => generation.generateStatementFiles({
    config: STATEMENT_CONFIG,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config: STATEMENT_CONFIG, fileEntries: [{ filePath: sourcePath, detailRows: rows }] })
  });
  const seedsOf = () => readBalanceSeedRecords(storageRoot, '中行')
    .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]);
  const submitSeed = (prompt, endBalance) => {
    const planResult = buildManualBalanceSeedPlan({
      payload: { billDate: '2026-09-30', endBalance },
      pendingPrompt: prompt,
      importContext: { template: { name: TEMPLATE_NAME } },
      storageRoot
    });
    assertEq(planResult.stopResult, undefined, `Step8.补录 ${endBalance} 的计划有效`);
    writeManualBalanceSeedPlan(planResult.plan);
    return planResult.plan;
  };

  const missing = generation.extractManualBalancePromptWarning(generate().warnings);
  assertEq(missing && missing.prompt.seedMismatch, undefined, 'Step8.缺种子时的补录提示不带对不上明细');
  submitSeed(missing.prompt, '0');

  const wrong = generate();
  const wrongWarning = generation.extractManualBalancePromptWarning(wrong.warnings);
  assertEq(wrong.balance, null, 'Step8.余额补错时不生成余额账单');
  assertEq(wrongWarning && wrongWarning.prompt.seedMismatch, {
    seedDate: '2026-09-30',
    seedBalance: 0,
    seedGenerationMethod: '人工录入',
    anchorBalance: 0,
    billDate: '2026-10-01',
    creditAmount: 0,
    debitAmount: 201500,
    expectedBalance: -201500,
    statementBalances: [800000, 798500]
  }, 'Step8.补录提示带上已有余额、当日收支与账单当日余额');
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatBalanceSeedMismatchLine = loadMainFunction('formatBalanceSeedMismatchLine', { formatBalanceAmount });
  const logs = [];
  const result = loadMainFunction('buildManualBalanceRequiredResult', {
    clearLastErrorReport: () => {},
    lastPendingBalanceSeedConfirmation: null,
    lastManualBalancePrompt: null,
    appendActivityLogEntry: (entry) => logs.push(entry),
    formatBalanceSeedMismatchLine
  })(wrongWarning.prompt, wrong);
  assertEq([result.status, result.message, result.manualBalancePromptReady],
    ['manual-balance-required', '上一账单日余额与账单对不上，请核对后重新补录', true], 'Step8.状态提示写明已有余额对不上');
  assertEq(logs[0].details.at(-1),
    '已有 2026-09-30 余额 0.00（人工录入）；2026-10-01：上一日余额 0.00 + 收入 0.00 − 支出 201,500.00'
      + ' = 预期 -201,500.00，账单当日余额 800,000.00、798,500.00 都对不上',
    'Step8.活动日志写明对不上的明细');
  assertEq(seedsOf(), [['M801', '2026-09-30', 0, '人工录入']], 'Step8.对不上时只有补录的种子，不回写生成种子');

  const correctedPlan = submitSeed(wrongWarning.prompt, '1000000');
  assertEq(correctedPlan.existingIndex, 0, 'Step8.重新补录覆盖同日种子（界面先确认覆盖）');
  const corrected = generate();
  assertEq(corrected.warnings, [], 'Step8.改对后无提示');
  assertEq(readBalanceSheet(corrected.balance.filePath), [
    ['M801', 'VND', '2026-10-01', 798500],
    ['M801', 'VND', '2026-10-12', 1098500]
  ], 'Step8.回读余额：首日选中账单最后一笔余额');
  assertEq(seedsOf(), [
    ['M801', '2026-09-30', 1000000, '人工录入'],
    ['M801', '2026-10-01', 798500, '账单里的余额'],
    ['M801', '2026-10-12', 1098500, '账单里的余额']
  ], 'Step8.种子：补录值已改对，生成种子回写');
}

async function run() {
  console.log('==== 网银账单「账单里的余额」逐日校验 e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-balance-verify-'));
  const storageRoot = path.join(dir, 'storage');
  const outputDir = path.join(dir, 'exports');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    // M001：09-04（周五）→ 09-07（周一）跨周末无交易，应直接通过；09-08 账单余额多了 50（漏单）。
    // M002：首日与种子对不上（种子 2000，收入 50，账单 2100）。
    const sourcePath = path.join(dir, 'statement-source.xlsx');
    writeSource(sourcePath, [
      ['2026-09-04', 'M001', 'USD', '100.10', '', '1100.10'],
      ['2026-09-07', 'M001', 'USD', '', '20.05', '1080.05'],
      ['2026-09-08', 'M001', 'USD', '30', '', '1160.05'],
      ['2026-09-04', 'M002', 'EUR', '50', '', '2100']
    ]);
    const detailRows = mapSource(sourcePath);
    const acknowledgedKeys = new Set();
    const generation = createGeneration(storageRoot, outputDir, acknowledgedKeys);
    const generate = (filePath = sourcePath, rows = detailRows) => generation.generateStatementFiles({
      config: STATEMENT_CONFIG,
      preparedBatch: generation.buildPreparedStatementBatchFromEntries({
        config: STATEMENT_CONFIG,
        fileEntries: [{ filePath, detailRows: rows }]
      })
    });

    // Step 1：没有种子 → 要求补录首日之前的余额，不出余额表、不写种子
    upsertBalanceSeedRecord(storageRoot, {
      templateName: TEMPLATE_NAME, merchantId: 'M002', currency: 'EUR',
      billDate: '2026-09-03', endBalance: 2000, generationMethod: '人工录入'
    });
    const first = generate();
    const seedWarning = generation.extractManualBalancePromptWarning(first.warnings);
    assertTrue(Boolean(first.detail && fs.existsSync(first.detail.filePath)), 'Step1.明细账单照常生成');
    assertEq(first.balance, null, 'Step1.缺种子时不生成余额账单');
    assertEq(seedWarning && [seedWarning.prompt.merchantId, seedWarning.prompt.targetBillDate], ['M001', '2026-09-04'], 'Step1.要求补录 M001 首日之前的余额');
    assertEq(readBalanceSeedRecords(storageRoot, '中行').length, 1, 'Step1.未写入生成种子');

    // Step 2：补录 M001 09-03 余额 1000（真实种子文件写入）→ 逐日校验，一次列全两处不一致
    const planResult = buildManualBalanceSeedPlan({
      payload: { billDate: '2026-09-03', endBalance: '1000' },
      pendingPrompt: seedWarning.prompt,
      importContext: { template: { name: TEMPLATE_NAME } },
      storageRoot
    });
    assertEq(planResult.stopResult, undefined, 'Step2.补录计划有效');
    writeManualBalanceSeedPlan(planResult.plan);
    const second = generate();
    const mismatches = generation.extractBalanceMismatchConfirmItems(second.warnings);
    assertEq(second.balance, null, 'Step2.未确认不一致时不生成余额账单');
    assertEq(mismatches.map((item) => [
      item.merchantId, item.billDate, item.anchorSource, item.anchorDate,
      item.expectedBalance, item.statementBalance, item.difference, item.missingFrom, item.missingTo
    ]), [
      ['M001', '2026-09-08', 'statement', '2026-09-07', 1110.05, 1160.05, 50, '', ''],
      ['M002', '2026-09-04', 'seed', '2026-09-03', 2050, 2100, 50, '', '']
    ], 'Step2.两处不一致（跨周末的 09-07 已通过）');
    assertEq(readBalanceSeedRecords(storageRoot, '中行').length, 2, 'Step2.未写入生成种子');

    // Step 3：确认继续 → 按账单余额生成并回读，种子回写
    mismatches.forEach((item) => acknowledgedKeys.add(item.key));
    const third = generate();
    assertTrue(Boolean(third.balance && fs.existsSync(third.balance.filePath)), 'Step3.余额账单生成');
    assertEq(third.warnings.map((warning) => warning.type), ['balance-mismatch-confirmed'], 'Step3.带已确认告警');
    assertEq(readBalanceSheet(third.balance.filePath), [
      ['M001', 'USD', '2026-09-04', 1100.1],
      ['M001', 'USD', '2026-09-07', 1080.05],
      ['M001', 'USD', '2026-09-08', 1160.05],
      ['M002', 'EUR', '2026-09-04', 2100]
    ], 'Step3.回读余额：全部按账单余额');
    assertEq(readBalanceSeedRecords(storageRoot, '中行')
      .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]), [
      ['M001', '2026-09-03', 1000, '人工录入'],
      ['M001', '2026-09-04', 1100.1, '账单里的余额'],
      ['M001', '2026-09-07', 1080.05, '账单里的余额'],
      ['M001', '2026-09-08', 1160.05, '账单里的余额'],
      ['M002', '2026-09-03', 2000, '人工录入'],
      ['M002', '2026-09-04', 2100, '账单里的余额']
    ], 'Step3.种子文件内容');

    // Step 4：导入告警（主进程真实函数）
    const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
    const formatBalanceMismatchLine = loadMainFunction('formatBalanceMismatchLine', { formatBalanceAmount });
    const message = loadMainFunction('buildImportWarningMessage')({
      warnings: third.warnings, balanceReady: true, balanceRequested: true
    });
    assertEq(message, '明细账单可导出，余额账单可导出，2处余额校验不一致，已按账单余额生成，请点击状态框导出报错文件', 'Step4.导入提示摘要');
    const detailLines = loadMainFunction('buildImportWarningDetailLines', {
      formatBalanceGapLine: () => '', formatBalanceMismatchLine
    })(third.warnings);
    assertEq(detailLines.slice(1), [
      '银行账号：M001，币种：USD，账单日期：2026-09-08，上一日余额：1,080.05（上一账单日 2026-09-07），收入：30.00，支出：0.00，预期余额：1,110.05，账单余额：1,160.05，差额：+50.00',
      '银行账号：M002，币种：EUR，账单日期：2026-09-04，上一日余额：2,000.00（余额种子 2026-09-03），收入：50.00，支出：0.00，预期余额：2,050.00，账单余额：2,100.00，差额：+50.00'
    ], 'Step4.报错文件逐条列出差异');

    // Step 5：下一次导入以回写的种子为起点：M001 09-09 支出 60 → 1100.05 相符；09-11 缺 09-10 的交易 → 不一致并写明缺的日期
    const nextPath = path.join(dir, 'statement-next.xlsx');
    writeSource(nextPath, [
      ['2026-09-09', 'M001', 'USD', '', '60', '1100.05'],
      ['2026-09-11', 'M001', 'USD', '5', '', '1200']
    ]);
    const next = generate(nextPath, mapSource(nextPath));
    const nextMismatches = generation.extractBalanceMismatchConfirmItems(next.warnings);
    assertEq(nextMismatches.map((item) => [item.billDate, item.anchorDate, item.expectedBalance, item.missingFrom, item.missingTo]), [
      ['2026-09-11', '2026-09-09', 1105.05, '2026-09-10', '2026-09-10']
    ], 'Step5.下一次导入接着校验，缺失交易写明缺的日期');

    await verifyMultiTemplateImportHoldsPartialBalance(dir);
    await verifyManualSeedReplacement(dir);
    await verifyWrongManualSeedPrompt(dir);
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
