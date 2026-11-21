// 网银账单：模板「日期格式」（v3.2.21，templates.date_format）e2e 集成验证
//   覆盖：真实主库（仓储）+ main.js 中真实的取值规范化、生成配置与模板包读写函数 + 真实 xlsx / csv 读取
//   ① 取值：auto / DMY / MDY 以外的值视为无效（界面与主进程同值域）；saveMappings 写入、未传时保持原值，新模板默认 auto
//   ② 模板【更新】（只换表头）后日期格式保留
//   ③ 生成：库内配置 → buildStatementGenerationConfig → buildMappedRowsForFile：月在前模板把文本 09/10/2026 读成
//      2026-09-10，自动 / 日在前仍读成 2026-10-09（BillDate 与 ValueDate，xlsx 文本单元格与 csv）
//   ④ 模板包：只用到日期格式时不升版本（v5）；导出 → 读包 → 导入后日期格式与生成结果一致；包内无效值导入为 auto
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据在整条链路上的结果。
//
// 用法：node scripts/integration/statement-template-date-format.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const {
  buildDetailExportRows,
  buildFeatureFilterToken,
  buildLogicValueToken,
  buildMappedRows,
  extractHeaders,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  loadCurrencyMappings,
  LOGIC_VALUE_MIN_FIELDS,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeBillSplitRowFilterRules,
  normalizeCell,
  normalizeFeatureFilterList,
  normalizeFeeAmountFormula,
  normalizeLogicValueFields,
  normalizeRowFilterRules,
  parseFeatureFilterToken,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  validateBillSplitRowFilterRules,
  validateFeeAmountFormula,
  validateRowFilterRules,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders,
  formatFieldReferenceLines
} = require('../../src/main-process/template-header-update');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '起息日', '账号', '币种', '收入', '支出', '摘要'];
const ORDERED_FIELDS = ['BillDate', 'ValueDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark'];
const ENUM_VALUES = ['BillDate', 'ValueDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Balance'];

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function captureError(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

function loadMainConstants(names) {
  const wanted = new Set(names);
  const sources = MAIN_AST.body
    .filter((node) => node.type === 'VariableDeclaration'
      && node.declarations.some((declarator) => declarator.id && wanted.has(declarator.id.name)))
    .map((node) => MAIN_SOURCE.slice(node.start, node.end));
  return Function(`${sources.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

function loadMainFunctions(names, deps = {}) {
  const sources = names.map((name) => {
    const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  const depNames = Object.keys(deps);
  return Function(...depNames, `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(...depNames.map((key) => deps[key]));
}

const CONSTANTS = loadMainConstants([
  'BALANCE_DISABLED_OPTION', 'BALANCE_CALCULATED_OPTION', 'MERCHANT_ID_SELF_INPUT_OPTION', 'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
  'MERCHANT_ID_CURRENCY_ONLY_OPTION',
  'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'LOGIC_VALUE_MAPPING_FIELD', 'CUSTOM_INPUT_TARGET_FIELDS',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'BILL_SPLIT_ROW_FILTER_MAPPING_FIELD', 'BILL_SPLIT_ROW_FILTER_ENABLED_OPTION',
  'PREPROCESS_ROW_FILTER_MAPPING_FIELD', 'PREPROCESS_ROW_FILTER_ENABLED_OPTION', 'DUPLICATE_ROW_FILTER_MAPPING_FIELD',
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'PREPROCESS_FIELDS',
  'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS', 'FILENAME_MAPPING_TEMPLATE_ID', 'MISSING_ENUM_MESSAGE',
  'LEGACY_ORIENTED_MAPPINGS_MESSAGE',
  'SUPPORTED_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION',
  'TEMPLATE_DATE_FORMAT_LABELS'
]);

function createMain(database) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'validateFeatureFiltersPayload', 'collectFeatureFilterRefs', 'buildExportTargetFields',
    'buildMappingTargetFields', 'buildManagedMappingFields', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled',
    'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'getPrimaryMappedField',
    'getMappingFieldValues', 'normalizeMappedFields', 'resolveCurrentMappings', 'decodeCustomInputMappingValue',
    'normalizeMappingRows', 'normalizeExportMappingRows', 'buildCompatibleBigAccounts', 'isFilenameMappingMode',
    'getTemplateMappingConfig', 'buildMappedFieldLookup', 'normalizeLookupMappingValue', 'buildStatementGenerationConfig',
    'buildPreprocessRowFilterRules', 'resolveStatementFeatureFilters', 'buildBillSplitMergeConfig', 'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile', 'validateBillSplitMappingsPayload', 'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig', 'isCurrencyOnlyMerchantMapping', 'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta', 'isLegacyOrientedTemplateMappings', 'buildTemplateFieldReferenceInput',
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs', 'normalizeTemplateDateFormat'
  ], {
    ...CONSTANTS,
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools(CONSTANTS),
    diffTemplateHeaders,
    extractHeaders,
    database,
    fs,
    path,
    normalizeCell,
    normalizeFeeAmountFormula,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateFeeAmountFormula,
    validateBillSplitRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX,
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    buildFeatureFilterToken,
    buildLogicValueToken,
    normalizeLogicValueFields,
    LOGIC_VALUE_MIN_FIELDS,
    getFeatureFilterRef,
    LEGACY_FEATURE_FILTER_ID,
    normalizeFeatureFilterList,
    parseFeatureFilterToken,
    resolveUsedFeatureFilters,
    upgradeLegacyFeatureFilter,
    buildMappedRows,
    loadCurrencyMappings,
    splitTemplateName,
    resolveStatementOutputName: channelIdentity.resolveStatementOutputName,
    getCurrencyMappingTablePath: () => path.join(ROOT, 'assets', '币种映射表.xlsx'),
    getEnumConfig: () => ({ filePath: 'COMMON枚举.xlsx' }),
    loadEnumValues: () => ENUM_VALUES.slice(),
    expandBigAccountConfigurations: (items) => (Array.isArray(items) ? items : []),
    createStatementWorkbookReadGuard: () => undefined,
    buildBigAccountRecognitionBasis: () => null,
    finalizeBigAccountRecognitionBasis: () => null,
    normalizeBundleAccountMappings: () => []
  });
}

const openedDatabases = [];

function openDatabase(filePath) {
  const database = new AppDatabase(filePath);
  openedDatabases.push(database);
  database.init();
  return database;
}

function closeDatabase(database) {
  database.close();
  const index = openedDatabases.indexOf(database);
  if (index >= 0) openedDatabases.splice(index, 1);
}

// 合成账单：日期都是文本（xlsx 字符串单元格 / csv），第 2 行日 > 12，两种顺序结果相同
const SOURCE_ROWS = [
  ['09/10/2026', '09/11/2026', 'ACC1', 'USD', '100', '', '货款'],
  ['09/13/2026', '09/13/2026', 'ACC1', 'USD', '', '30', '退款'],
  ['10/01/2026', '10/02/2026', 'ACC1', 'USD', '50', '', '利息']
];
const EXPECTED = {
  MDY: [['2026-09-10', '2026-09-11'], ['2026-09-13', '2026-09-13'], ['2026-10-01', '2026-10-02']],
  auto: [['2026-10-09', '2026-11-09'], ['2026-09-13', '2026-09-13'], ['2026-01-10', '2026-02-10']]
};

function writeXlsxSource(filePath) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS, ...SOURCE_ROWS]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function writeCsvSource(filePath) {
  fs.writeFileSync(filePath, [HEADERS, ...SOURCE_ROWS].map((row) => row.join(',')).join('\r\n'), 'utf8');
}

function draftMappings() {
  return Object.entries({
    BillDate: '交易日期',
    ValueDate: '起息日',
    MerchantId: '账号',
    Currency: '币种',
    'Credit Amount': '收入',
    'Debit Amount': '支出',
    Remark: '摘要',
    Balance: CONSTANTS.BALANCE_DISABLED_OPTION
  }).map(([templateField, mappedField]) => ({ templateField, mappedField, mappedFields: [] }));
}

// 按界面【保存】口径：先经 validateTemplateConfiguration 校验，再写库（dateFormat 为 saveMappings 第 5 参）
function saveTemplate(database, main, name, dateFormat) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  const validated = main.validateTemplateConfiguration({
    template: database.getTemplate(template.id),
    mappings: draftMappings(),
    enumValues: ENUM_VALUES
  });
  database.saveMappings(template.id, validated.mappings, [], [], dateFormat, null, {});
  return database.getTemplate(template.id);
}

function generateDates(main, templateId, sourcePath) {
  const config = main.getTemplateMappingConfig(templateId);
  const generationConfig = main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  const mapped = main.buildMappedRowsForFile({ config: generationConfig, inputFilePath: sourcePath });
  const billDateIndex = mapped[0].indexOf('BillDate');
  const valueDateIndex = mapped[0].indexOf('ValueDate');
  return { dateParseOrder: generationConfig.dateParseOrder, dates: mapped.slice(1).map((row) => [row[billDateIndex], row[valueDateIndex]]) };
}

function verifyValues(database, main) {
  assertEq(Object.keys(CONSTANTS.TEMPLATE_DATE_FORMAT_LABELS), ['auto', 'DMY', 'MDY'], '① 主进程值域为 auto / DMY / MDY');
  assertEq(['auto', 'DMY', 'MDY', ' MDY ', 'mdy', 'YMD', '', null, undefined, 1].map((value) => main.normalizeTemplateDateFormat(value)),
    ['auto', 'DMY', 'MDY', 'MDY', '', '', '', '', '', ''], '① 值域外（含大小写不同、空值）视为无效');
  // 界面下拉框只列日在前 / 月在前（不勾选为 auto），取值都在主进程值域内
  const rendererSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'dialogs', 'configuration.js'), 'utf8');
  const optionsBlock = rendererSource.match(/const TEMPLATE_DATE_FORMAT_OPTIONS = \[([\s\S]*?)\];/);
  const rendererValues = optionsBlock ? [...optionsBlock[1].matchAll(/value: '([^']+)'/g)].map((match) => match[1]) : [];
  assertEq(rendererValues, ['DMY', 'MDY'], '① 界面选项与主进程同值域');

  const fresh = database.upsertTemplate({ name: '新模板-日期格式', sourceFileName: 'fresh.xlsx', headers: HEADERS });
  assertEq(database.getTemplate(fresh.id).dateFormat, 'auto', '① 新模板默认 auto');
  const template = saveTemplate(database, main, '月在前模板', 'MDY');
  assertEq(template.dateFormat, 'MDY', '① saveMappings 写入 MDY');
  database.saveMappings(template.id, database.getTemplateMappings(template.id).mappings, [], [], undefined, null, {});
  assertEq(database.getTemplate(template.id).dateFormat, 'MDY', '① 未传日期格式时保持原值');
  return template;
}

function verifyHeaderUpdate(database, template) {
  database.updateTemplateHeaders(template.id, { expectedHeaders: HEADERS, headers: [...HEADERS, '备注'], sourceFileName: '月在前模板-新.xlsx' });
  assertEq(database.getTemplate(template.id).dateFormat, 'MDY', '② 模板【更新】后日期格式保留');
  database.updateTemplateHeaders(template.id, { expectedHeaders: [...HEADERS, '备注'], headers: HEADERS, sourceFileName: '月在前模板.xlsx' });
}

function verifyGeneration(dir, database, main, mdyTemplate) {
  const xlsxPath = path.join(dir, 'source.xlsx');
  const csvPath = path.join(dir, 'source.csv');
  writeXlsxSource(xlsxPath);
  writeCsvSource(csvPath);
  const autoTemplate = saveTemplate(database, main, '自动模板', 'auto');
  const dmyTemplate = saveTemplate(database, main, '日在前模板', 'DMY');
  for (const [label, sourcePath] of [['xlsx', xlsxPath], ['csv', csvPath]]) {
    assertEq(generateDates(main, mdyTemplate.id, sourcePath), { dateParseOrder: 'MDY', dates: EXPECTED.MDY },
      `③ 月在前（${label}）：09/10/2026 → 2026-09-10，BillDate 与 ValueDate 同口径`);
    assertEq(generateDates(main, autoTemplate.id, sourcePath), { dateParseOrder: 'auto', dates: EXPECTED.auto },
      `③ 自动（${label}）：结果不变，日在前`);
    assertEq(generateDates(main, dmyTemplate.id, sourcePath).dates, EXPECTED.auto, `③ 日在前（${label}）：与自动相同`);
  }
}

function verifyBundle(dir, database, main, template) {
  const entry = database.listTemplateBundleEntries().find((item) => item.name === template.name);
  assertEq(entry && entry.dateFormat, 'MDY', '④ 模板包条目带 dateFormat');
  assertEq(main.resolveTemplateBundleVersion([entry]), CONSTANTS.BASE_BUNDLE_VERSION, '④ 只用到日期格式时不升模板包版本（v5）');

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.dateFormat, 'MDY', '④ 读包保留月在前');

  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  // 按导入口径：读包映射经 normalizeMappingRows → validateTemplateConfiguration 后保存，dateFormat 规范化后为第 5 参
  const normalized = targetMain.normalizeMappingRows({ template: target.getTemplate(imported.id), mappings: readEntry.mappings, enumValues: ENUM_VALUES });
  const validated = targetMain.validateTemplateConfiguration({ template: target.getTemplate(imported.id), mappings: normalized, enumValues: ENUM_VALUES });
  target.saveMappings(imported.id, validated.mappings, [], [], importDateFormat(targetMain, readEntry), null, { preserveOwn: false });
  assertEq(target.getTemplate(imported.id).dateFormat, 'MDY', '④ 导入后日期格式为月在前');
  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(generateDates(targetMain, imported.id, sourcePath), generateDates(main, template.id, sourcePath), '④ 模板包往返后生成结果一致');
  closeDatabase(target);

  const variants = ['DMY', 'auto', 'XYZ', '', undefined];
  fs.writeFileSync(bundlePath, JSON.stringify({
    bundleVersion: CONSTANTS.BASE_BUNDLE_VERSION,
    channels: [],
    templates: variants.map((dateFormat, index) => ({ ...entry, templateKey: `variant-${index}`, name: `变体-${index}`, dateFormat }))
  }), 'utf8');
  assertEq(main.readTemplateBundleFile(bundlePath).templates.map((item) => importDateFormat(main, item)), ['DMY', 'auto', 'auto', 'auto', 'auto'],
    '④ 导入：日在前原样保留，无效值与缺省按 auto');
  // 导入处理器（IPC，不在本脚本加载范围）须按同一口径写库
  assertEq(MAIN_SOURCE.includes("normalizeTemplateDateFormat(entry.dateFormat) || 'auto',"), true, '④ 导入模板包时按同一口径规范化日期格式');
}

// 与 main.js 导入模板包处理器同口径
function importDateFormat(main, entry) {
  return main.normalizeTemplateDateFormat(entry.dateFormat) || 'auto';
}

async function run() {
  console.log('==== 网银账单 · 模板日期格式 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-template-date-format-'));
  try {
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    const template = verifyValues(database, main);
    verifyHeaderUpdate(database, template);
    verifyGeneration(dir, database, main, template);
    verifyBundle(dir, database, main, template);
  } finally {
    openedDatabases.splice(0).forEach((database) => {
      try { database.close(); } catch (_error) { /* 已关闭 */ }
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((failure) => {
      console.error(`  - ${failure.label}\n      actual:   ${JSON.stringify(failure.actual)}\n      expected: ${JSON.stringify(failure.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
