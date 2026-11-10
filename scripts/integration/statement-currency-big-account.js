// 网银账单：MerchantId「原始账单仅有币种无账户号」（v3.2.16）e2e 集成验证
//   覆盖：真实主库（template_currency_big_accounts）+ 真实 xlsx 读取与写出 + 真实币种映射表 +
//         main.js 中的真实保存校验、生成配置、分组生成与模板包读取函数
//   ① 一份账单含 USD / EUR，分别映射到两个大账号：明细 MerchantId 逐行回填，两条余额链各自接上种子，文件名不带账号
//   ② usd / 美元 都按 USD 处理，明细 Currency 写成 USD
//   ③ 币种为空或未维护：整批阻断，列出模板 / 文件 / 币种 / 行号，导出目录没有文件；零金额行不阻断
//   ④ 两份文件的问题汇总成一次报错
//   ⑤ 渠道：「自己输入」子模板（选定一个大账号）与本模式子模板同批生成，所选大账号只注入「自己输入」的文件
//   ⑥ 保存 → 读回 → 模板包 v6 导出导入往返一致；改成其他 MerchantId 映射后配置清空
//   ⑦ 月度余额导出不包含本模式的模板（spec D3）
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据、金额与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-currency-big-account.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const {
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  FEATURE_FILTER_FIELD_TOKEN,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  mapEachCollectingCurrencyBigAccountIssues,
  normalizeCell,
  normalizeFeatureFilterRule,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  findPreviousBalanceSeed,
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
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');
const channelIdentity = require('../../src/main-process/statement-channel-identity');
const { normalizeMaintainedBigAccounts } = require('../../src/main-process/big-account-recognition');
const { ALL_BANKS_TEMPLATE_SCOPE, assembleMonthlyBalance } = require('../../src/main-process/monthly-balance');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const CURRENCY_MAPPING_TABLE = path.join(ROOT, 'assets', '币种映射表.xlsx');
const CURRENCY_MAPPINGS = loadCurrencyMappings(CURRENCY_MAPPING_TABLE);
const CURRENCY_CODES = Array.from(new Set(CURRENCY_MAPPINGS.map((mapping) => mapping.englishCode)));
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Channel'];
const TARGET_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
const TODAY = '2026-11-09';
const MULTI = '__MULTI_BIG_ACCOUNT__';
const OPTION = '原始账单仅有币种无账户号';
const HEADERS = ['日期', '币种', '收入', '支出'];

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
function captureError(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

// main.js 顶层的字符串 / 数字常量按源码取值
function readTopLevelLiteralConstants() {
  const constants = {};
  MAIN_AST.body.forEach((node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    node.declarations.forEach((declaration) => {
      if (declaration.id.type === 'Identifier' && declaration.init && declaration.init.type === 'Literal') {
        constants[declaration.id.name] = declaration.init.value;
      }
    });
  });
  return constants;
}
const MAIN_CONSTANTS = readTopLevelLiteralConstants();

// 在同一作用域内求值 main.js 的若干顶层函数（可互相调用），其余依赖按名注入。
function loadMainFunctions(names, deps = {}) {
  const sources = names.map((name) => {
    const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  const depNames = Object.keys(deps);
  return Function(...depNames, `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(...depNames.map((key) => deps[key]));
}

function writeSource(filePath, rows, headers = HEADERS) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function readSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  return { header: rows[0], rows: rows.slice(1).filter((row) => row.some((cell) => cell !== undefined && cell !== '')) };
}

function excelDate(value) {
  if (typeof value !== 'number') return String(value);
  const { y, m, d } = XLSX.SSF.parse_date_code(value);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function readDetailColumns(filePath, names) {
  const { header, rows } = readSheet(filePath);
  return rows.map((row) => names.map((name) => row[header.indexOf(name)]));
}

function readBalanceRows(filePath) {
  const { header, rows } = readSheet(filePath);
  const at = (name) => header.indexOf(name);
  return rows.map((row) => [row[at('银行账号')], row[at('币种')], excelDate(row[at('账单日期')]), row[at('期末余额')]]);
}

// ===== 环境：真实主库 + main.js 真实函数 =====

const openedDatabases = [];

function createEnvironment(dir, label) {
  const storageRoot = path.join(dir, `storage-${label}`);
  fs.mkdirSync(storageRoot, { recursive: true });
  const database = new AppDatabase(path.join(dir, `${label}.sqlite`));
  openedDatabases.push(database);
  database.init();
  const exportMappingsByTemplateId = new Map();
  const imported = [];
  const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };

  const getTemplateMappingConfig = (templateId) => {
    const template = database.getTemplate(templateId);
    if (!template) return null;
    return {
      template,
      exportMappings: exportMappingsByTemplateId.get(Number(templateId)) || [],
      exportTargetFields: ORDERED_FIELDS,
      bigAccounts: []
    };
  };

  const fns = {};
  const sanitizeFileName = loadMainFunctions(['sanitizeFileName']).sanitizeFileName;
  Object.assign(fns, loadMainFunctions(['buildOutputFilePath', 'buildStatementOutputFilePath', 'scopedMergedOutputFileName'], {
    getToday: () => TODAY, path, ensureStorageRoot: () => storageRoot, sanitizeFileName
  }));
  const generation = createStatementGenerationHelpers({
    appendLog: (_root, error) => { throw error; },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    // 生成辅助函数按文件路径解析时调用 main.js 的真实 buildMappedRowsForFile（下方加载后才可用）
    buildMappedRowsForFile: (args) => fns.buildMappedRowsForFile(args),
    buildStatementOutputFilePath: fns.buildStatementOutputFilePath,
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
      seedRecords.forEach((record) => upsertBalanceSeedRecord(storageRoot, { templateName, ...record, overwrite: true }));
    },
    writeBalanceWorkbook,
    writeWorkbookRows
  });

  const mainDeps = {
    ...MAIN_CONSTANTS,
    database,
    getTemplateMappingConfig,
    getStatementSessionEntries,
    normalizeCell,
    sanitizeFileName,
    splitTemplateName,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX,
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    mapEachCollectingCurrencyBigAccountIssues,
    // 同轮合入的「字段筛选特征值」：校验与生成配置会引用
    FEATURE_FILTER_FIELD_TOKEN,
    normalizeFeatureFilterRule,
    ADVANCED_MAPPING_FIELDS: [],
    CUSTOM_INPUT_TARGET_FIELDS: new Set(['MerchantId']),
    getCurrencyMappingTablePath: () => CURRENCY_MAPPING_TABLE,
    loadCurrencyMappings: () => CURRENCY_MAPPINGS,
    fs,
    path,
    buildAmountSplitByFieldConfig: () => ({ enabled: false }),
    buildBillSplitMergeConfig: () => ({ enabled: false }),
    buildMappedRows,
    createStatementWorkbookReadGuard: () => undefined,
    buildBigAccountRecognitionBasis: () => null,
    finalizeBigAccountRecognitionBasis: () => null,
    cloneRowsWithMetadata,
    buildFieldIndexMap,
    buildManagedMerchantLookupFlags: () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
    buildManagedMappingFields: () => TARGET_FIELDS.slice(),
    normalizeMaintainedBigAccounts,
    resolveGenerationGroupKey: channelIdentity.resolveGenerationGroupKey,
    resolveStatementOutputName: channelIdentity.resolveStatementOutputName,
    resolveTemplateBalanceMode: channelIdentity.resolveTemplateBalanceMode,
    findBalanceModeMismatch: channelIdentity.findBalanceModeMismatch,
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
    removeStatementSessionEntriesByFilePath: () => {},
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    buildDateRangeLabel,
    getToday: () => TODAY,
    buildOutputFilePath: fns.buildOutputFilePath,
    mergeGeneratedXlsxFiles: loadMainFunctions(['mergeGeneratedXlsxFiles'], { require, fs, path, applyWatermark: () => {} }).mergeGeneratedXlsxFiles,
    buildStatementFileEntry: (entry) => entry,
    buildStatementFileEntryId: () => 'entry',
    appendStatementSessionImport: () => 'batch',
    buildStatementBatchId: () => 'batch',
    lastGeneratedExports,
    updateStatementSessionCache: (session, batchId, generatedFiles) => {
      generation.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
    },
    buildImportResultFromGeneratedFiles: ({ generatedFiles }) => {
      imported.push(generatedFiles);
      return { status: 'captured' };
    },
    FILENAME_MAPPING_TEMPLATE_ID: '__FILENAME_MAPPING__',
    appendActivityLogEntry: () => {},
    extractManualBalancePromptWarning: generation.extractManualBalancePromptWarning,
    statementGenerationHelpers: generation,
    scopedMergedOutputFileName: fns.scopedMergedOutputFileName,
    normalizeBundleTemplateHeaders: (headers) => headers.map((header) => normalizeCell(header)),
    normalizeBundleAccountMappings: () => []
  };
  Object.assign(fns, loadMainFunctions([
    'buildMappedFieldLookup',
    'normalizeLookupMappingValue',
    'normalizeMappedFields',
    'getMappingFieldValues',
    'getPrimaryMappedField',
    'buildStatementGenerationConfig',
    'buildCurrencyBigAccountMappingConfig',
    'buildMappedRowsForFile',
    'getEntryTemplateConfig',
    'rebuildMatchedTemplateFileEntries',
    'groupStatementEntriesForGeneration',
    'findGenerationGroupBalanceModeMismatch',
    'buildChannelBalanceModeMismatchError',
    'generateMultiTemplateGroupFiles',
    'planVirtualTemplateBalanceRegeneration',
    'assertVirtualTemplateBalanceOutputPaths',
    'regenerateVirtualTemplateBalanceFromSession',
    'assertGenerationOutputNameUnique',
    'findGenerationGroupOutputNameConflicts',
    'buildStatementOutputNameConflictError',
    'findGenerationGroupOutputPathConflicts',
    'buildStatementOutputPathConflictError',
    'validateTemplateConfiguration',
    'validateCurrencyBigAccountConfiguration',
    'resolveSavedFeatureFilter',
    'resolveStatementFeatureFilter',
    'expandBigAccountConfigurations',
    'decodeCustomInputMappingValue',
    'extractFixedMappingValue',
    'buildCompatibleBigAccounts',
    'normalizeMappingRows',
    'resolveCurrentMappings',
    'readTemplateBundleFile',
    'resolveTemplateBundleVersion',
    'isCurrencyOnlyMerchantMapping'
  ], mainDeps));

  // 按界面口径保存：映射经 validateTemplateConfiguration 校验后写库，生成时用库里的存储值
  function defineTemplate(name, { headers = HEADERS, mappings, currencyBigAccounts = [], channelAssignment = null }) {
    const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers });
    const validated = fns.validateTemplateConfiguration({
      template: database.getTemplate(template.id),
      mappings,
      enumValues: [],
      currencyBigAccounts,
      availableCurrencyCodes: CURRENCY_CODES
    });
    const saveResult = database.saveMappings(template.id, validated.mappings, validated.bigAccounts, validated.fixedAssignments, 'auto', null, {
      currencyBigAccounts: validated.currencyBigAccounts,
      channelAssignment
    });
    exportMappingsByTemplateId.set(template.id, validated.mappings.filter((mapping) => TARGET_FIELDS.includes(mapping.templateField)));
    return { template: database.getTemplate(template.id), channelAssignment: saveResult.channelAssignment };
  }

  function configFor(template) {
    const config = getTemplateMappingConfig(template.id);
    return fns.buildStatementGenerationConfig({
      template: config.template,
      mappings: config.exportMappings,
      orderedTargetFields: config.exportTargetFields,
      allowManagedMerchantWithoutSelection: true
    });
  }

  function entryFor(template, filePath) {
    return { filePath, matchedTemplateId: template.id, detailRows: fns.buildMappedRowsForFile({ config: configFor(template), inputFilePath: filePath }) };
  }

  function generate(fileEntries, selectedBigAccount = null) {
    imported.length = 0;
    fns.generateMultiTemplateGroupFiles({
      fileEntries,
      fallbackTemplateConfig: getTemplateMappingConfig(fileEntries[0].matchedTemplateId),
      selectedBigAccount,
      reuseMappedRows: true,
      session: { key: 'session' },
      inputFilePaths: fileEntries.map((entry) => entry.filePath)
    });
    return imported[0];
  }

  return {
    database,
    storageRoot,
    fns,
    generation,
    // 直接写库的子模板（如「自己输入」）登记生成时使用的映射
    registerExportMappings: (templateId, mappings) => exportMappingsByTemplateId.set(Number(templateId), mappings),
    defineTemplate,
    configFor,
    entryFor,
    generate,
    exportFiles: () => {
      const base = path.join(storageRoot, 'exports', TODAY);
      return ['detail', 'balance'].flatMap((kind) => {
        const folder = path.join(base, kind);
        return fs.existsSync(folder) ? fs.readdirSync(folder).map((name) => `${kind}/${name}`) : [];
      }).sort();
    }
  };
}

function seed(env, bankTemplateName, merchantId, currency, billDate, endBalance) {
  upsertBalanceSeedRecord(env.storageRoot, {
    templateName: bankTemplateName, merchantId, currency, billDate, endBalance, generationMethod: '人工录入'
  });
}

function currencyOnlyMappings(balance = '通过发生额计算') {
  return [
    { templateField: 'BillDate', mappedField: '日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: OPTION, mappedFields: [] },
    { templateField: 'Currency', mappedField: '币种', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: '收入', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: '支出', mappedFields: [] },
    { templateField: 'Balance', mappedField: balance, mappedFields: [] }
  ];
}

const PAIRS = [
  { currency: 'USD', merchantId: 'NET-USD' },
  { currency: 'EUR', merchantId: 'NET-EUR' }
];

// ① + ②
function verifyCurrencyRowsAndBalances(dir) {
  const env = createEnvironment(dir, 'step1');
  const { template } = env.defineTemplate('招商银行-上海', { mappings: currencyOnlyMappings(), currencyBigAccounts: PAIRS });
  seed(env, '招商银行-上海', 'NET-USD', 'USD', '2026-10-31', 1000);
  seed(env, '招商银行-上海', 'NET-EUR', 'EUR', '2026-10-31', 500);
  const filePath = path.join(dir, 'step1.xlsx');
  writeSource(filePath, [
    ['2026-11-01', 'usd', '100', ''],
    ['2026-11-01', 'EUR', '', '40'],
    ['2026-11-02', '美元', '', '30'],
    ['2026-11-02', 'Eur', '5', '']
  ]);

  const result = env.generate([env.entryFor(template, filePath)]);
  assertEq(readDetailColumns(result.detail.filePath, ['MerchantId', 'Currency']), [
    ['NET-USD', 'USD'], ['NET-EUR', 'EUR'], ['NET-USD', 'USD'], ['NET-EUR', 'EUR']
  ], 'Step1.明细 MerchantId 按币种逐行回填，usd / 美元 都写成 USD');
  assertEq(readBalanceRows(result.balance.filePath).sort(), [
    ['NET-EUR', 'EUR', '2026-11-01', 460],
    ['NET-EUR', 'EUR', '2026-11-02', 465],
    ['NET-USD', 'USD', '2026-11-01', 1100],
    ['NET-USD', 'USD', '2026-11-02', 1070]
  ], 'Step1.两个大账号各一条余额链，分别接上种子');
  assertEq([result.detail.fileName, result.balance.fileName], ['招商银行-上海-COMMON-2026-11-01~2026-11-02.xlsx', '招商银行-上海-BALANCE-2026-11-01~2026-11-02.xlsx'],
    'Step1.多个大账号时文件名不带账号');
  assertEq(env.database.getTemplateBigAccounts(template.id, { includeOwn: true }), [], 'Step1.不写入维护大账号的大账号表');
}

// ③ + ④
function verifyUnmappedCurrencyBlocks(dir) {
  const env = createEnvironment(dir, 'step3');
  const { template } = env.defineTemplate('招商银行-上海', { mappings: currencyOnlyMappings(), currencyBigAccounts: PAIRS });
  seed(env, '招商银行-上海', 'NET-USD', 'USD', '2026-10-31', 1000);
  const fileA = path.join(dir, 'step3-a.xlsx');
  const fileB = path.join(dir, 'step3-b.xlsx');
  const fileOk = path.join(dir, 'step3-ok.xlsx');
  writeSource(fileA, [
    ['2026-11-01', 'USD', '100', ''],
    ['2026-11-01', 'GBP', '7', ''],
    ['2026-11-02', '', '', '3'],
    ['2026-11-02', 'GBP', '', '1']
  ]);
  writeSource(fileB, [['2026-11-01', 'JPY', '9', '']]);
  writeSource(fileOk, [['2026-11-01', 'USD', '1', ''], ['2026-11-01', 'JPY', '0', '0']]);

  const config = env.configFor(template);
  // 指定模板导入的同一入口：先解析全部文件（prepareGeneratedFiles → buildPreparedStatementBatchFromFilePaths），再写文件
  const generateFromPaths = (inputFilePaths) => {
    const prepared = env.generation.buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths });
    return env.generation.generateStatementFiles({ config, preparedBatch: prepared.preparedBatch });
  };
  const error = captureError(() => generateFromPaths([fileA, fileB]));
  assertEq(error && error.code, 'CURRENCY_BIG_ACCOUNT_UNMAPPED', 'Step3.未维护币种整批阻断');
  assertTrue(Boolean(error) && /有 4 行明细.*（涉及 2 个文件）.*未生成任何文件/.test(error.message), `Step3.提示行数、文件数与未生成文件：${error && error.message}`);
  assertEq(error && error.detailLines, [
    '模板「招商银行-上海」文件「step3-a.xlsx」币种「GBP」：第 3、5 行',
    '模板「招商银行-上海」文件「step3-a.xlsx」币种「（空）」：第 4 行',
    '模板「招商银行-上海」文件「step3-b.xlsx」币种「JPY」：第 2 行'
  ], 'Step3/4.两份文件的问题汇总列出模板、文件、币种和行号');
  assertEq(env.exportFiles(), [], 'Step3.导出目录没有文件');

  const ok = generateFromPaths([fileOk]);
  assertTrue(Boolean(ok && ok.detail), 'Step3.零金额行的币种未维护不阻断');
}

// ⑤
function verifyChannelWithSelfInputSibling(dir) {
  const env = createEnvironment(dir, 'step5');
  const { template: owner, channelAssignment } = env.defineTemplate('招商银行-上海', {
    mappings: currencyOnlyMappings(),
    currencyBigAccounts: PAIRS,
    channelAssignment: { mode: 'create' }
  });
  const childHeaders = ['TxnDate', 'In', 'Out'];
  const child = env.database.upsertTemplate({ name: 'CMB-SH', sourceFileName: 'CMB-SH.xlsx', headers: childHeaders });
  const childMappings = [
    { templateField: 'BillDate', mappedField: 'TxnDate', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: `${FIXED_FIELD_VALUE_PREFIX}${MULTI}`, mappedFields: [] },
    { templateField: 'Currency', mappedField: '', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: 'In', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: 'Out', mappedFields: [] },
    { templateField: 'Balance', mappedField: '通过发生额计算', mappedFields: [] }
  ];
  env.database.saveMappings(child.id, childMappings, [{ merchantId: 'M777', currency: 'HKD' }], [], 'auto', null, {
    channelAssignment: { mode: 'join', channelId: channelAssignment.channelId }
  });
  const childConfig = env.fns.buildStatementGenerationConfig({
    template: env.database.getTemplate(child.id), mappings: childMappings, orderedTargetFields: ORDERED_FIELDS, allowManagedMerchantWithoutSelection: true
  });
  seed(env, '招商银行-上海', 'NET-USD', 'USD', '2026-10-31', 100);
  seed(env, '招商银行-上海', 'M777', 'HKD', '2026-10-31', 700);
  const fileA = path.join(dir, 'step5-a.xlsx');
  const fileB = path.join(dir, 'step5-b.xlsx');
  writeSource(fileA, [['2026-11-01', 'USD', '1', '']]);
  writeSource(fileB, [['2026-11-01', '7', '']], childHeaders);

  env.registerExportMappings(child.id, childMappings);
  const childEntry = { filePath: fileB, matchedTemplateId: child.id, detailRows: env.fns.buildMappedRowsForFile({ config: childConfig, inputFilePath: fileB }) };
  const result = env.generate([env.entryFor(owner, fileA), childEntry], { merchantId: 'M777', currency: 'HKD' });
  assertEq(readDetailColumns(result.detail.filePath, ['MerchantId', 'Currency']).sort(), [['M777', 'HKD'], ['NET-USD', 'USD']],
    'Step5.所选大账号只注入「自己输入」子模板的文件，本模式文件按币种回填');
  assertEq(readBalanceRows(result.balance.filePath).map((row) => [row[0], row[3]]).sort(), [['M777', 707], ['NET-USD', 101]], 'Step5.两个账号各自接上种子');
}

// ⑥
function verifySaveReadBundleRoundTrip(dir) {
  const env = createEnvironment(dir, 'step6');
  const { template } = env.defineTemplate('招商银行-上海', {
    mappings: currencyOnlyMappings('无'),
    currencyBigAccounts: [{ currency: 'usd', merchantId: 'NET-USD' }, { currency: 'HKD', merchantId: 'NET-USD' }, { currency: 'EUR', merchantId: 'NET-EUR' }]
  });
  const stored = env.database.getTemplateMappings(template.id);
  const rows = env.fns.normalizeMappingRows({ template: stored.template, mappings: stored.mappings, enumValues: [], bigAccounts: [] });
  assertEq(rows.find((row) => row.templateField === 'MerchantId').mappedField, OPTION, 'Step6.读回 MerchantId 显示为选项文字');
  assertEq(rows.find((row) => row.templateField === 'Currency').mappedField, '币种', 'Step6.读回 Currency 保留币种列');
  assertEq(env.database.getTemplate(template.id).bigAccountSummary, '按币种（2个大账号）', 'Step6.模板管理大账号列显示按币种');

  const bundlePath = path.join(dir, 'step6-bundle.json');
  const bundleEntries = env.database.listTemplateBundleEntries();
  assertEq(env.fns.resolveTemplateBundleVersion(bundleEntries), 6, 'Step6.用到本模式的模板包写 v6（旧版整包拒绝）');
  assertEq(env.fns.resolveTemplateBundleVersion(bundleEntries.map((entry) => ({
    ...entry,
    mappings: entry.mappings.map((mapping) => (mapping.templateField === 'MerchantId' ? { ...mapping, mappedField: '币种' } : mapping))
  }))), 5, 'Step6.不用本模式（也不用字段筛选特征值）时仍写 v5');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: env.fns.resolveTemplateBundleVersion(bundleEntries), templates: bundleEntries }));
  const bundle = env.fns.readTemplateBundleFile(bundlePath);
  assertEq(bundle.bundleVersion, 6, 'Step6.模板包版本为 6');

  const target = createEnvironment(dir, 'step6-target');
  const entry = bundle.templates[0];
  const imported = target.database.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  const validated = target.fns.validateTemplateConfiguration({
    template: imported,
    mappings: target.fns.normalizeMappingRows({ template: imported, mappings: entry.mappings, enumValues: [] }),
    enumValues: [],
    bigAccounts: entry.bigAccounts,
    fixedAssignments: entry.fixedAssignments,
    currencyBigAccounts: entry.currencyBigAccounts,
    availableCurrencyCodes: CURRENCY_CODES
  });
  target.database.saveMappings(imported.id, validated.mappings, validated.bigAccounts, validated.fixedAssignments, 'auto', null, {
    preserveOwn: false, currencyBigAccounts: validated.currencyBigAccounts
  });
  assertEq(target.database.getTemplateCurrencyBigAccounts(imported.id).map(({ currency, merchantId }) => [currency, merchantId]), [
    ['USD', 'NET-USD'], ['HKD', 'NET-USD'], ['EUR', 'NET-EUR']
  ], 'Step6.模板包导出导入往返后配置一致');

  const switched = env.fns.validateTemplateConfiguration({
    template: env.database.getTemplate(template.id),
    mappings: currencyOnlyMappings('无').map((mapping) => (mapping.templateField === 'MerchantId' ? { ...mapping, mappedField: '币种' } : mapping)),
    enumValues: [],
    currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET-USD' }],
    availableCurrencyCodes: CURRENCY_CODES
  });
  env.database.saveMappings(template.id, switched.mappings, switched.bigAccounts, switched.fixedAssignments, 'auto', null, {
    currencyBigAccounts: switched.currencyBigAccounts
  });
  assertEq(env.database.getTemplateCurrencyBigAccounts(template.id), [], 'Step6.改成其他 MerchantId 映射后配置清空');
}

// ⑦
function verifyMonthlyBalanceSkips(dir) {
  const env = createEnvironment(dir, 'step7');
  env.defineTemplate('招商银行-上海', { mappings: currencyOnlyMappings(), currencyBigAccounts: PAIRS });
  seed(env, '招商银行-上海', 'NET-USD', 'USD', '2026-10-31', 1000);
  const assembled = assembleMonthlyBalance({
    db: env.database,
    storageRoot: env.storageRoot,
    year: 2026,
    month: 10,
    templateScope: ALL_BANKS_TEMPLATE_SCOPE
  });
  assertEq(assembled.records.length, 0, 'Step7.月度余额导出不包含本模式的模板');
  assertEq(assembled.stats.skippedTemplates.map((item) => [item.templateName, item.reason]), [['招商银行-上海', 'no-big-accounts']],
    'Step7.按无大账号跳过（D3，见 backlog）');
}

async function run() {
  console.log('==== 网银账单「原始账单仅有币种无账户号」e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-currency-big-account-'));
  try {
    verifyCurrencyRowsAndBalances(dir);
    verifyUnmappedCurrencyBlocks(dir);
    verifyChannelWithSelfInputSibling(dir);
    verifySaveReadBundleRoundTrip(dir);
    verifyMonthlyBalanceSkips(dir);
  } finally {
    openedDatabases.splice(0).forEach((database) => {
      try { database.close(); } catch (error) { console.error('关闭测试主库失败', error); }
    });
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
