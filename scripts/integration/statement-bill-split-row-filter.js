// 网银账单：拆分/合并账单「根据字段值过滤账单」（v3.2.19）e2e 集成验证
//   覆盖：真实主库（迁移、仓储）+ main.js 中真实的生成配置、模板包读写与导入函数 + 真实 xlsx 读取与写出
//   ① 迁移：旧库无 row_filter_rules_json 列 → 启动补列，原有拆分配置保留、规则为空；重复启动无副作用
//   ② 存储：过滤规则随映射保存（同一事务）落库并规范化；未带规则的映射保存、拆分配置的部分保存都不覆盖规则
//   ③ 生成：库内配置 → buildBillSplitMergeConfig → 读 xlsx → 写出回读：命中规则的行走拆分、未命中的走主映射，
//      按源行顺序合并；未勾选过滤时全部走拆分；勾选了却没有有效规则时拒绝生成；
//      模板表头删掉规则字段后，生成前的失效引用拦截列出规则位置，未勾选时标为未启用
//   ④ 模板包：导出条目带规则 → 用到过滤时写 v8 → 读包 → 导入后规则与生成结果一致；旧版（支持到 v7）整包拒绝
//   ⑤ 币种：main.js 真实生成配置（buildStatementGenerationConfig）在主映射未配 Currency 时也加载 assets 币种映射表，
//      命中行拆分出的币种按映射表规范化（人民币 → CNY），无法识别的保留原值并记提示；未勾选过滤时拆分行保持原值
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-bill-split-row-filter.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const { hasColumn } = require('../../src/backend/database/migrations');
const {
  buildDetailExportRows,
  buildFeatureFilterToken,
  buildLogicValueToken,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  buildMappedRows,
  FileValidationError,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell,
  normalizeFeeAmountFormula,
  normalizeBillSplitRowFilterRules,
  normalizeRowFilterRules,
  validateRowFilterRules,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  upgradeLegacyFeatureFilter,
  validateFeeAmountFormula,
  validateBillSplitRowFilterRules,
  writeWorkbookRows,
  extractHeaders,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  normalizeFeatureFilterList,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  resolveUsedFeatureFilters
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
const HEADERS = ['交易日期', '交易类型', '币种', '收入', '支出', '交易金额', '手续费'];
const ORDERED_FIELDS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'];
const RULES = [
  { seq: 1, conditions: [{ field: '交易类型', op: '等于', value: '代收' }, { field: '手续费', op: '非空值', value: '' }] },
  { seq: 2, conditions: [{ field: '交易类型', op: '开头为', value: '代付' }] }
];

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
function assertThrows(fn, pattern, label) {
  try {
    fn();
  } catch (error) {
    if (error instanceof FileValidationError && pattern.test(error.message)) { passed++; return; }
    failed++; failures.push({ label, actual: error.message, expected: String(pattern) });
    return;
  }
  failed++; failures.push({ label, actual: '未抛错', expected: String(pattern) });
}

// main.js 顶层常量按源码求值（与生产同值），函数在同一作用域求值后可互相调用，其余依赖按名注入。
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
  'BALANCE_DISABLED_OPTION', 'BALANCE_CALCULATED_OPTION', 'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'LOGIC_VALUE_MAPPING_FIELD',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'BILL_SPLIT_ROW_FILTER_MAPPING_FIELD', 'BILL_SPLIT_ROW_FILTER_ENABLED_OPTION',
  'PREPROCESS_ROW_FILTER_MAPPING_FIELD', 'PREPROCESS_ROW_FILTER_ENABLED_OPTION', 'DUPLICATE_ROW_FILTER_MAPPING_FIELD',
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'PREPROCESS_FIELDS',
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION'
]);

function createMain(database, constantOverrides = {}) {
  return loadMainFunctions([
    'getPrimaryMappedField',
    'getMappingFieldValues',
    'normalizeMappedFields',
    'buildMappedFieldLookup',
    'buildBillSplitMergeConfig',
    'applyBundleBillSplitConfig',
    'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta',
    'upgradeLegacyBundleFeatureFilterRefs',
    'readTemplateBundleFile',
    'resolveTemplateBundleVersion', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    'isCurrencyOnlyMerchantMapping'
  ], {
    ...CONSTANTS,
    ...constantOverrides,
    database,
    fs,
    normalizeCell,
    normalizeFeeAmountFormula,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    validateFeeAmountFormula,
    validateBillSplitRowFilterRules,
    FileValidationError,
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    buildFeatureFilterToken,
    buildLogicValueToken,
    normalizeLogicValueFields,
    LOGIC_VALUE_MIN_FIELDS,
    getFeatureFilterRef,
    LEGACY_FEATURE_FILTER_ID,
    upgradeLegacyFeatureFilter,
    normalizeBundleAccountMappings: () => []
  });
}

// main.js 真实生成配置链路（与 statement-template-update.js 同一组函数与依赖）
const GENERATION_CONSTANTS = loadMainConstants([
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
  'LEGACY_ORIENTED_MAPPINGS_MESSAGE'
]);
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Balance'];

function createGenerationMain(database) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'validateFeatureFiltersPayload', 'collectFeatureFilterRefs', 'buildExportTargetFields',
    'buildMappingTargetFields', 'buildManagedMappingFields', 'getPrimaryMappedField', 'getMappingFieldValues',
    'normalizeMappedFields', 'resolveCurrentMappings', 'decodeCustomInputMappingValue', 'normalizeMappingRows',
    'normalizeExportMappingRows', 'buildCompatibleBigAccounts', 'isFilenameMappingMode', 'getTemplateMappingConfig',
    'buildMappedFieldLookup', 'normalizeLookupMappingValue', 'buildStatementGenerationConfig', 'buildPreprocessRowFilterRules', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'resolveStatementFeatureFilters',
    'buildBillSplitMergeConfig', 'buildAmountSplitByFieldConfig', 'buildMappedRowsForFile', 'validateBillSplitMappingsPayload',
    'validateCurrencyBigAccountConfiguration', 'buildCurrencyBigAccountMappingConfig', 'isCurrencyOnlyMerchantMapping',
    'normalizeBundleTemplateHeaders', 'normalizeBundleBillSplitMeta', 'isLegacyOrientedTemplateMappings'
  ], {
    ...GENERATION_CONSTANTS,
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools(GENERATION_CONSTANTS),
    diffTemplateHeaders,
    extractHeaders,
    database,
    fs,
    path,
    normalizeCell,
    normalizeFeeAmountFormula,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    validateFeeAmountFormula,
    validateBillSplitRowFilterRules,
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
    parseLogicValueToken,
    parseLogicValueFeatureFilterRef,
    buildLogicValueFeatureCandidate,
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
    finalizeBigAccountRecognitionBasis: () => null
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

function writeSource(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function readSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return { header: rows[0], rows: rows.slice(1) };
}

// 主映射：日期、币种、收入/支出直接映射；开启拆分并根据字段值过滤账单
function mappingsWith({ rowFilter = true } = {}) {
  return [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'Currency', mappedField: '币种', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: '收入', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: '支出', mappedFields: [] },
    { templateField: CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD, mappedField: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION, mappedFields: [] },
    {
      templateField: CONSTANTS.BILL_SPLIT_ROW_FILTER_MAPPING_FIELD,
      mappedField: rowFilter ? CONSTANTS.BILL_SPLIT_ROW_FILTER_ENABLED_OPTION : '',
      mappedFields: []
    }
  ];
}

// 两份拆分：1 = 交易金额记收入，2 = 手续费记支出
function defineSplitTemplate(database, name, { rules = RULES } = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, { billSplitRowFilterRules: rules });
  database.saveBillSplitRowCount(template.id, 2);
  database.saveBillSplitRow(template.id, {
    seqNo: 1, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  });
  database.saveBillSplitRow(template.id, {
    seqNo: 2, currencySourceField: '币种', creditSourceField: '', debitSourceField: '手续费', amountSourceField: '', rowStatus: 'completed'
  });
  return database.getTemplate(template.id);
}

function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  const seed = openDatabase(dbPath);
  const template = seed.upsertTemplate({ name: '旧库模板', sourceFileName: 'legacy.xlsx', headers: HEADERS });
  seed.saveBillSplitMeta(template.id, { signedAmountSourceField: '交易金额', signedAmountTargetSeqNos: [1] });
  // 回退成没有过滤规则列的表结构
  seed.db.exec('ALTER TABLE template_bill_split_meta DROP COLUMN row_filter_rules_json;');
  assertTrue(!hasColumn(seed.db, 'template_bill_split_meta', 'row_filter_rules_json'), '① 构造旧库：无 row_filter_rules_json 列');
  closeDatabase(seed);

  const upgraded = openDatabase(dbPath);
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_meta', 'row_filter_rules_json'), '① 启动补 row_filter_rules_json 列');
  const meta = upgraded.getBillSplitMeta(template.id);
  assertEq([meta.signedAmountSourceField, meta.signedAmountTargetSeqNos, meta.rowFilterRules], ['交易金额', [1], []],
    '① 原有拆分配置保留，过滤规则为空');
  closeDatabase(upgraded);

  const again = openDatabase(dbPath);
  assertEq(again.getBillSplitMeta(template.id).rowFilterRules, [], '① 重复启动无副作用');
  closeDatabase(again);
}

function verifyStorage(database) {
  const template = defineSplitTemplate(database, '存储模板', {
    rules: [
      { conditions: [{ field: ' 交易类型 ', op: '等于', value: ' 代收 ' }, { field: '', op: '等于', value: '' }] },
      { conditions: [{ field: '', op: '包含', value: '' }] }
    ]
  });
  const normalized = [{ seq: 1, conditions: [{ field: '交易类型', op: '等于', value: '代收' }] }];
  assertEq(database.getBillSplitMeta(template.id).rowFilterRules, normalized, '② 随映射保存：规则规范化后落库（空白条件与空规则忽略）');
  assertTrue(
    database.getTemplateMappings(template.id).mappings.some((mapping) => (
      mapping.templateField === CONSTANTS.BILL_SPLIT_ROW_FILTER_MAPPING_FIELD && mapping.mappedField === '是'
    )),
    '② 「根据字段值过滤账单」开关存为映射行'
  );
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, {});
  assertEq(database.getBillSplitMeta(template.id).rowFilterRules, normalized, '② 未带规则的映射保存不改已存规则');
  database.saveBillSplitMeta(template.id, { signedAmountSourceField: '交易金额' });
  assertEq(database.getBillSplitMeta(template.id).rowFilterRules, normalized, '② 拆分配置部分保存不覆盖规则');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, { billSplitRowFilterRules: [] });
  assertEq(database.getBillSplitMeta(template.id).rowFilterRules, [], '② 传空数组时清空规则');
}

function generate(main, template, mappings, sourcePath, outputPath) {
  const billSplitMerge = main.buildBillSplitMergeConfig(template, mappings);
  const mapped = buildMappedRows({
    inputFilePath: sourcePath,
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: { BillDate: '交易日期', Currency: '币种', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: HEADERS,
    billSplitMerge
  });
  writeWorkbookRows({ rows: buildDetailExportRows(mapped), outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  const index = (name) => exported.header.indexOf(name);
  return exported.rows.map((row) => [
    row[index('Currency')],
    row[index('Credit Amount')] === '' ? '' : Number(row[index('Credit Amount')]),
    row[index('Debit Amount')] === '' ? '' : Number(row[index('Debit Amount')])
  ]);
}

const SOURCE_ROWS = [
  ['2026-11-01', '转账', 'USD', '100', '', '', ''],
  ['2026-11-02', '代收', 'USD', '', '', '1,000.00', '2.5'],
  ['2026-11-03', '代收', 'USD', '300', '', '', ''],
  ['2026-11-04', '代付-批量', 'HKD', '', '', '500', '1'],
  ['2026-11-05', '转账', 'HKD', '', '40', '', '']
];

function verifyGeneration(dir, database, main) {
  const sourcePath = path.join(dir, 'source.xlsx');
  writeSource(sourcePath, SOURCE_ROWS);
  const template = defineSplitTemplate(database, '过滤模板');

  const config = main.buildBillSplitMergeConfig(template, mappingsWith());
  assertEq(config.rowFilterRules, RULES, '③ 勾选过滤时生成配置下发规则');
  // 第 2 行命中规则 #1、第 4 行命中规则 #2 → 拆分；第 3 行「代收」但手续费为空不满足规则 #1 → 主映射
  assertEq(generate(main, template, mappingsWith(), sourcePath, path.join(dir, 'out-1.xlsx')), [
    ['USD', 100, ''],
    ['USD', 1000, ''],
    ['USD', '', 2.5],
    ['USD', 300, ''],
    ['HKD', 500, ''],
    ['HKD', '', 1],
    ['HKD', '', 40]
  ], '③ 回读导出：命中规则的行拆分、未命中的行按主映射，按源行顺序合并');

  const unfiltered = mappingsWith({ rowFilter: false });
  assertEq(main.buildBillSplitMergeConfig(template, unfiltered).rowFilterRules, null, '③ 未勾选过滤时不下发规则');
  assertEq(generate(main, template, unfiltered, sourcePath, path.join(dir, 'out-2.xlsx')), [
    ['USD', 1000, ''],
    ['USD', '', 2.5],
    ['HKD', 500, ''],
    ['HKD', '', 1]
  ], '③ 未勾选过滤：全部源行走拆分（原行为），主映射金额不读取');

  const emptyTemplate = defineSplitTemplate(database, '无规则模板', { rules: [] });
  assertThrows(() => main.buildBillSplitMergeConfig(emptyTemplate, mappingsWith()), /根据字段值过滤账单.*至少设置一条过滤规则/,
    '③ 勾选过滤但没有规则时拒绝生成');

  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const referenceInput = (mappings) => ({
    mappings,
    billSplitRows: config.billSplitRows,
    billSplitRowFilterRules: RULES
  });
  let staleError = null;
  try {
    tools.assertTemplateFieldReferencesAvailable(
      { name: '过滤模板', headers: HEADERS.filter((header) => header !== '交易类型') },
      referenceInput(mappingsWith())
    );
  } catch (error) { staleError = error; }
  assertEq(staleError && staleError.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '③ 规则字段被删时生成前拦截');
  assertTrue(Boolean(staleError)
    && staleError.detailLines.includes('根据字段值过滤账单 · 过滤规则 #1 第 1 个条件 ← 交易类型')
    && staleError.detailLines.includes('根据字段值过滤账单 · 过滤规则 #2 第 1 个条件 ← 交易类型'),
  '③ 拦截明细列出规则位置');
  const inactive = tools.collectTemplateFieldReferences(referenceInput(unfiltered))
    .filter((reference) => reference.area === 'bill-split-row-filter');
  assertEq(formatFieldReferenceLines(inactive.slice(0, 1)), ['根据字段值过滤账单 · 过滤规则 #1 第 1 个条件 ← 交易类型（未启用）'],
    '③ 未勾选过滤时规则引用标为未启用');
}

function verifyBundle(dir, database, main) {
  const template = database.getTemplateByName('过滤模板');
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '过滤模板');
  assertEq(entry.billSplitMeta.rowFilterRules, RULES, '④ 导出条目带过滤规则');

  const plainEntry = { mappings: [], billSplitRows: [], billSplitMeta: {} };
  const toggleOnlyEntry = { mappings: mappingsWith(), billSplitRows: [], billSplitMeta: {} };
  const rulesOnlyEntry = { mappings: [], billSplitRows: [], billSplitMeta: { rowFilterRules: RULES } };
  assertEq(
    [plainEntry, entry, toggleOnlyEntry, rulesOnlyEntry].map((item) => main.resolveTemplateBundleVersion([item])),
    [CONSTANTS.BASE_BUNDLE_VERSION, 8, 8, 8],
    '④ 用到过滤（勾选或有规则）时写 v8，未用到时版本不变'
  );

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.billSplitMeta.rowFilterRules, RULES, '④ 读包保留过滤规则');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 7 });
  assertThrows(() => legacyReader.readTemplateBundleFile(bundlePath), /模板文件版本（8）高于当前应用支持的版本（7）/,
    '④ 旧版（支持到 v7）读 v8 包整包拒绝');

  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const existing = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: 'old.xlsx', headers: HEADERS });
  target.saveMappings(existing.id, readEntry.mappings, [], [], 'auto', null, {});
  targetMain.applyBundleBillSplitConfig(existing.id, readEntry);
  assertEq(target.getBillSplitMeta(existing.id).rowFilterRules, RULES, '④ 导入后过滤规则一致');

  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(
    generate(targetMain, target.getTemplate(existing.id), mappingsWith(), sourcePath, path.join(dir, 'out-imported.xlsx')),
    generate(main, template, mappingsWith(), sourcePath, path.join(dir, 'out-origin.xlsx')),
    '④ 导入后的模板生成结果与原模板一致'
  );
  closeDatabase(target);
}

function verifyCurrencyNormalization(dir, database) {
  const generationMain = createGenerationMain(database);
  const sourcePath = path.join(dir, 'currency.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', '转账', '人民币', '100', '', '', ''],
    ['2026-11-02', '代收', '人民币', '', '', '1000', '2.5'],
    ['2026-11-03', '代付', '某币', '', '', '300', '']
  ]);
  // 主映射不配 Currency：未命中行没有币种，命中行币种只来自拆分行配置
  const template = defineSplitTemplate(database, '币种规范化模板');
  const noMainCurrency = mappingsWith().filter((mapping) => mapping.templateField !== 'Currency');
  const run = (mappings) => {
    database.saveMappings(template.id, mappings, [], [], 'auto', null, {});
    const config = generationMain.getTemplateMappingConfig(template.id);
    const generationConfig = generationMain.buildStatementGenerationConfig({
      template: config.template,
      mappings: config.exportMappings,
      orderedTargetFields: ORDERED_FIELDS,
      allowManagedMerchantWithoutSelection: true
    });
    const mapped = generationMain.buildMappedRowsForFile({ config: generationConfig, inputFilePath: sourcePath });
    return {
      tableLoaded: generationConfig.currencyMappings.length > 0,
      rows: buildDetailExportRows(mapped).slice(1).map((row) => [row[1], row[2], row[3]]),
      unmapped: mapped.issues.filter((issue) => issue.type === 'currency-unmapped').map((issue) => [issue.rowNumber, issue.rawValue])
    };
  };

  assertEq(run(noMainCurrency), {
    tableLoaded: true,
    rows: [['', '100', ''], ['CNY', '1000', ''], ['CNY', '', '2.5'], ['某币', '300', '']],
    unmapped: [[4, '某币']]
  }, '⑤ 主映射未配 Currency 时仍加载币种表：命中行币种按映射表规范化，无法识别的保留原值并记提示');

  const unfiltered = run(noMainCurrency.map((mapping) => (
    mapping.templateField === CONSTANTS.BILL_SPLIT_ROW_FILTER_MAPPING_FIELD ? { ...mapping, mappedField: '' } : mapping
  )).filter((mapping) => !['Credit Amount', 'Debit Amount'].includes(mapping.templateField)));
  assertEq(unfiltered, {
    tableLoaded: false,
    rows: [['人民币', '1000', ''], ['人民币', '', '2.5'], ['某币', '300', '']],
    unmapped: []
  }, '⑤ 未勾选过滤：拆分行币种保持原值，不加载币种表');
}

async function run() {
  console.log('==== 网银账单 · 拆分/合并账单根据字段值过滤账单 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-bill-split-row-filter-'));
  try {
    verifyMigration(dir);
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    verifyStorage(database);
    verifyGeneration(dir, database, main);
    verifyBundle(dir, database, main);
    verifyCurrencyNormalization(dir, database);
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
