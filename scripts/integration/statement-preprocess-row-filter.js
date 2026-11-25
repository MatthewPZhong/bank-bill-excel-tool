// 网银账单：原始账单预处理「过滤账单」与字段运算（v3.2.19）e2e 集成验证
//   覆盖：真实主库（迁移、仓储）+ main.js 中真实的映射配置、生成配置、失效引用输入与模板包读写函数
//        + 真实 xlsx 读取与写出 + 真实生成辅助（多文件批次、导入结果）
//   ① 迁移：旧库无 templates.preprocess_row_filter_rules_json 列 → 启动补列，模板保留、规则为空；重复启动无副作用
//   ② 存储：过滤规则随映射保存（同一事务）落库并规范化；未带规则的保存不改；传空数组清空；模板包覆盖导入时清空
//   ③ 生成：库内配置 → buildStatementGenerationConfig → buildMappedRowsForFile → 写出回读：只保留命中规则的行
//      （含字段运算 包含（字段）），行号为源文件物理行号；按发生额计算的余额只计保留的行；未勾选时全部输出；
//      勾选了却没有有效规则时拒绝生成
//   ④ 失效引用：模板【更新】删掉比较字段后，按真实映射配置收集的引用列出「原始账单预处理 · 过滤规则 … （比较字段）」，
//      生成前拦截；未勾选时标为未启用
//   ⑤ 模板包：导出条目带规则 → 用到预处理过滤时写 v8 → 读包保留 → 按导入口径保存后生成结果一致
//   ⑥ 提示：多文件批次中全部行被过滤的文件进入 emptyPreprocessedFiles，并随导入结果返回
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-preprocess-row-filter.js

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
  extractHeaders,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  loadCurrencyMappings,
  mapEachCollectingCurrencyBigAccountIssues,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeBillSplitRowFilterRules,
  normalizeCell,
  normalizeFeatureFilterList,
  normalizeFeeAmountFormula,
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeRowFilterRules,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  hasCrossSheetBackfillSettings,
  normalizeCrossSheetBackfillRule,
  validateCrossSheetBackfillRule,
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
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const { buildFieldIndexMap, deriveBalanceRecords } = require('../../src/main-process/statement-generation-business');
const {
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '账号', '交易类型', '币种', '收入', '支出', '摘要', '对方户名'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Balance'];
// 规则 #1：交易类型 等于 交易；规则 #2：摘要 包含（字段） 对方户名
const RULES = [
  { seq: 1, conditions: [{ field: '交易类型', op: '等于', value: '交易' }] },
  { seq: 2, conditions: [{ field: '摘要', op: '包含（字段）', value: '对方户名' }] }
];
const SOURCE_ROWS = [
  ['2026-11-01', 'ACC1', '交易', 'USD', '100', '', '货款', '甲'],
  ['2026-11-01', 'ACC1', '冻结', 'USD', '', '50', '冻结', ''],
  ['2026-11-02', 'ACC1', '退汇', 'USD', '20', '', '退汇-乙', '乙'],
  ['2026-11-02', 'ACC1', '解冻', 'USD', '60', '', '解冻', '丙'],
  ['2026-11-02', 'ACC1', '交易', 'USD', '', '30', '', '']
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
function captureError(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
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
  'BALANCE_DISABLED_OPTION', 'BALANCE_CALCULATED_OPTION', 'MERCHANT_ID_SELF_INPUT_OPTION', 'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
  'MERCHANT_ID_CURRENCY_ONLY_OPTION',
  'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'LOGIC_VALUE_MAPPING_FIELD', 'CUSTOM_INPUT_TARGET_FIELDS',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'BILL_SPLIT_ROW_FILTER_MAPPING_FIELD', 'BILL_SPLIT_ROW_FILTER_ENABLED_OPTION',
  'PREPROCESS_ROW_FILTER_MAPPING_FIELD', 'PREPROCESS_ROW_FILTER_ENABLED_OPTION', 'DUPLICATE_ROW_FILTER_MAPPING_FIELD',
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'CROSS_SHEET_BACKFILL_MAPPING_FIELD', 'CROSS_SHEET_BACKFILL_ENABLED_OPTION', 'PREPROCESS_FIELDS',
  'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS', 'FILENAME_MAPPING_TEMPLATE_ID', 'MISSING_ENUM_MESSAGE',
  'LEGACY_ORIENTED_MAPPINGS_MESSAGE',
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'CROSS_SHEET_BACKFILL_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION'
]);
const TOGGLE = CONSTANTS.PREPROCESS_ROW_FILTER_MAPPING_FIELD;

function createMain(database) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'validateFeatureFiltersPayload', 'collectFeatureFilterRefs', 'buildExportTargetFields',
    'buildMappingTargetFields', 'buildManagedMappingFields', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'isCrossSheetBackfillEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'getPrimaryMappedField',
    'getMappingFieldValues', 'normalizeMappedFields', 'resolveCurrentMappings', 'decodeCustomInputMappingValue',
    'normalizeMappingRows', 'normalizeExportMappingRows', 'buildCompatibleBigAccounts', 'isFilenameMappingMode',
    'getTemplateMappingConfig', 'buildMappedFieldLookup', 'normalizeLookupMappingValue', 'buildStatementGenerationConfig',
    'buildPreprocessRowFilterRules', 'buildCrossSheetBackfillRule', 'resolveStatementFeatureFilters', 'buildBillSplitMergeConfig', 'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile', 'validateBillSplitMappingsPayload', 'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig', 'isCurrencyOnlyMerchantMapping', 'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta', 'isLegacyOrientedTemplateMappings', 'buildTemplateFieldReferenceInput',
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs'
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
    normalizeFeeFieldMappings,
    validateFeeFieldMappings,
    isFeeFieldMappingTemplateFieldExcluded,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateFeeAmountFormula,
    validateBillSplitRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    hasCrossSheetBackfillSettings,
    normalizeCrossSheetBackfillRule,
    validateCrossSheetBackfillRule,
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

function mappingsWith({ preprocess = true } = {}) {
  return [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Currency', mappedField: '币种', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: '收入', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: '支出', mappedFields: [] },
    { templateField: TOGGLE, mappedField: preprocess ? CONSTANTS.PREPROCESS_ROW_FILTER_ENABLED_OPTION : '', mappedFields: [] }
  ];
}

function defineTemplate(database, name, { rules = RULES, preprocess = true } = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  database.saveMappings(template.id, mappingsWith({ preprocess }), [], [], 'auto', null, { preprocessRowFilterRules: rules });
  return database.getTemplate(template.id);
}

function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  const seed = openDatabase(dbPath);
  const template = seed.upsertTemplate({ name: '旧库模板', sourceFileName: 'legacy.xlsx', headers: HEADERS });
  seed.db.exec('ALTER TABLE templates DROP COLUMN preprocess_row_filter_rules_json;');
  assertTrue(!hasColumn(seed.db, 'templates', 'preprocess_row_filter_rules_json'), '① 构造旧库：无 preprocess_row_filter_rules_json 列');
  closeDatabase(seed);

  const upgraded = openDatabase(dbPath);
  assertTrue(hasColumn(upgraded.db, 'templates', 'preprocess_row_filter_rules_json'), '① 启动补 preprocess_row_filter_rules_json 列');
  const loaded = upgraded.getTemplate(template.id);
  assertEq([loaded.name, loaded.headers, loaded.preprocessRowFilterRules], ['旧库模板', HEADERS, []], '① 模板保留，过滤规则为空');
  closeDatabase(upgraded);

  const again = openDatabase(dbPath);
  assertEq(again.getTemplate(template.id).preprocessRowFilterRules, [], '① 重复启动无副作用');
  closeDatabase(again);
}

function verifyStorage(database) {
  const template = defineTemplate(database, '存储模板', {
    rules: [
      { conditions: [{ field: ' 交易类型 ', op: '等于', value: ' 交易 ' }, { field: '', op: '等于', value: '' }] },
      { conditions: [{ field: '摘要', op: '不包含（字段）', value: ' 对方户名 ' }] },
      { conditions: [{ field: '', op: '包含', value: '' }] }
    ]
  });
  const normalized = [
    { seq: 1, conditions: [{ field: '交易类型', op: '等于', value: '交易' }] },
    { seq: 2, conditions: [{ field: '摘要', op: '不包含（字段）', value: '对方户名' }] }
  ];
  assertEq(template.preprocessRowFilterRules, normalized, '② 随映射保存：规则规范化后落库（空白条件与空规则忽略，比较字段去空白）');
  assertTrue(
    database.getTemplateMappings(template.id).mappings.some((mapping) => mapping.templateField === TOGGLE && mapping.mappedField === '是'),
    '② 「过滤账单」开关存为映射行'
  );
  assertEq(database.listTemplates().find((item) => item.id === template.id).preprocessRowFilterRules, normalized, '② 模板列表带规则');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, {});
  assertEq(database.getTemplate(template.id).preprocessRowFilterRules, normalized, '② 未带规则的映射保存不改已存规则');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, { preprocessRowFilterRules: [] });
  assertEq(database.getTemplate(template.id).preprocessRowFilterRules, [], '② 传空数组时清空规则');

  const overwritten = defineTemplate(database, '覆盖模板');
  database.upsertTemplate({ name: '覆盖模板', sourceFileName: 'new.xlsx', headers: ['日期', '金额'] });
  assertEq(database.getTemplate(overwritten.id).preprocessRowFilterRules, [], '② 模板包覆盖导入（表头被覆盖）时清空规则');
}

function generate(main, templateId, sourcePath, outputPath) {
  const config = main.getTemplateMappingConfig(templateId);
  const generationConfig = main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  const mapped = main.buildMappedRowsForFile({ config: generationConfig, inputFilePath: sourcePath });
  const exportRows = buildDetailExportRows(mapped);
  writeWorkbookRows({ rows: exportRows, outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  const index = (name) => exported.header.indexOf(name);
  const amount = (value) => (value === '' ? '' : Number(value));
  // 回读的日期为 Excel 序列值，日期取写出前的导出行，金额取回读值
  const dateIndex = exportRows[0].indexOf('BillDate');
  const balance = deriveBalanceRecords({
    detailRows: mapped,
    templateName: '预处理模板',
    balanceTemplateFields: ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'],
    mode: 'calculated',
    resolvePreviousBalanceSeed: () => ({ merchantId: 'ACC1', currency: 'USD', billDate: '2026-10-31', endBalance: 1000 })
  });
  return {
    rules: generationConfig.preprocessRowFilterRules,
    detail: exported.rows.map((row, rowIndex) => [
      exportRows[rowIndex + 1][dateIndex],
      amount(row[index('Credit Amount')]),
      amount(row[index('Debit Amount')])
    ]),
    sourceRows: mapped.rowMetas.map((meta) => meta.sourceRowNumber),
    stats: mapped.preprocessRowFilterStats || null,
    balances: balance.records.map((row) => [row[4], Number(row[7])])
  };
}

function verifyGeneration(dir, database, main) {
  const sourcePath = path.join(dir, 'source.xlsx');
  writeSource(sourcePath, SOURCE_ROWS);
  const template = defineTemplate(database, '预处理模板');

  // 第 2 行命中规则 #1；第 3 行对方户名为空 → 包含（字段）不命中；第 4 行摘要含对方户名 → 命中规则 #2；
  // 第 5 行都不命中；第 6 行命中规则 #1
  assertEq(generate(main, template.id, sourcePath, path.join(dir, 'out-1.xlsx')), {
    rules: RULES,
    detail: [['2026-11-01', 100, ''], ['2026-11-02', 20, ''], ['2026-11-02', '', 30]],
    sourceRows: [2, 4, 6],
    // v3.2.21：droppedAmountRowNumbers 为其中带发生额的行（多账户分段的直接匹配窗口只以这些行为界）
    stats: { enabled: true, totalRows: 5, keptRows: 3, droppedTransactionRowNumbers: [3, 5], droppedAmountRowNumbers: [3, 5] },
    balances: [['2026-11-01', 1100], ['2026-11-02', 1090]]
  }, '③ 回读导出：只保留命中规则的行，行号为物理行号，按发生额计算的余额只计保留的行');

  database.saveMappings(template.id, mappingsWith({ preprocess: false }), [], [], 'auto', null, {});
  assertEq(generate(main, template.id, sourcePath, path.join(dir, 'out-2.xlsx')), {
    rules: null,
    detail: [['2026-11-01', 100, ''], ['2026-11-01', '', 50], ['2026-11-02', 20, ''], ['2026-11-02', 60, ''], ['2026-11-02', '', 30]],
    sourceRows: [2, 3, 4, 5, 6],
    stats: null,
    balances: [['2026-11-01', 1050], ['2026-11-02', 1100]]
  }, '③ 未勾选「过滤账单」：全部行照常生成，规则保留但不下发');
  assertEq(database.getTemplate(template.id).preprocessRowFilterRules, RULES, '③ 未勾选时已存规则保留');

  const empty = defineTemplate(database, '无规则模板', { rules: [] });
  const error = captureError(() => generate(main, empty.id, sourcePath, path.join(dir, 'out-3.xlsx')));
  assertEq([error && error.code, Boolean(error) && /已勾选原始账单预处理「过滤账单」，但过滤规则未设置完整/.test(error.message)],
    ['PREPROCESS_ROW_FILTER_MISSING', true], '③ 勾选但没有规则时拒绝生成');
}

function verifyStaleReferences(database, main) {
  const template = defineTemplate(database, '更新模板');
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const shrunk = HEADERS.filter((header) => header !== '对方户名');
  const input = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  const stale = tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(input), shrunk);
  assertEq(formatFieldReferenceLines(stale), ['原始账单预处理 · 过滤规则 #2 第 1 个条件（比较字段） ← 对方户名'],
    '④ 删掉比较字段：真实映射配置收集到的失效引用');
  const blocked = captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '更新模板', headers: shrunk }, input));
  assertEq(blocked && blocked.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '④ 生成前拦截');

  database.saveMappings(template.id, mappingsWith({ preprocess: false }), [], [], 'auto', null, {});
  const inactiveInput = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(formatFieldReferenceLines(tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(inactiveInput), shrunk)),
    ['原始账单预处理 · 过滤规则 #2 第 1 个条件（比较字段） ← 对方户名（未启用）'], '④ 未勾选时标为未启用');
  assertEq(captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '更新模板', headers: shrunk }, inactiveInput)), null,
    '④ 未勾选时不拦截生成');
}

function verifyBundle(dir, database, main) {
  const template = defineTemplate(database, '模板包模板');
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '模板包模板');
  assertEq(entry.preprocessRowFilterRules, RULES, '⑤ 导出条目带过滤规则');
  assertEq([
    { mappings: [] },
    entry,
    { mappings: mappingsWith() },
    { mappings: [], preprocessRowFilterRules: RULES }
  ].map((item) => main.resolveTemplateBundleVersion([item])), [CONSTANTS.BASE_BUNDLE_VERSION, 8, 8, 8],
  '⑤ 用到预处理过滤（勾选或有规则）时写 v8，未用到时版本不变');

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.preprocessRowFilterRules, RULES, '⑤ 读包保留过滤规则');

  // 按导入口径保存（覆盖同名模板 → 保存映射时带入规则）
  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  target.saveMappings(imported.id, readEntry.mappings, [], [], 'auto', null, {
    preserveOwn: false,
    preprocessRowFilterRules: readEntry.preprocessRowFilterRules
  });
  assertEq(target.getTemplate(imported.id).preprocessRowFilterRules, RULES, '⑤ 导入后过滤规则一致');
  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(
    generate(targetMain, imported.id, sourcePath, path.join(dir, 'out-imported.xlsx')),
    generate(main, template.id, sourcePath, path.join(dir, 'out-origin.xlsx')),
    '⑤ 导入后的模板生成结果与原模板一致'
  );
  closeDatabase(target);
}

function verifyEmptyFileHint(dir, database, main) {
  const template = defineTemplate(database, '提示模板');
  const keptPath = path.join(dir, 'kept.xlsx');
  const emptyPath = path.join(dir, 'all-filtered.xlsx');
  writeSource(keptPath, SOURCE_ROWS);
  writeSource(emptyPath, [['2026-11-03', 'ACC1', '冻结', 'USD', '', '10', '冻结', '']]);
  const config = main.getTemplateMappingConfig(template.id);
  const generationConfig = main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  const generation = createStatementGenerationHelpers({
    appendActivityLogEntry: () => {},
    buildFieldIndexMap,
    buildMappedRowsForFile: main.buildMappedRowsForFile,
    mapEachCollectingCurrencyBigAccountIssues,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    resolveSinglePreparedFieldValue
  });
  const { preparedBatch } = generation.buildPreparedStatementBatchFromFilePaths({ config: generationConfig, inputFilePaths: [keptPath, emptyPath] });
  assertEq(preparedBatch.emptyPreprocessedFiles, ['all-filtered.xlsx'], '⑥ 全部行被过滤的文件进入 emptyPreprocessedFiles');
  assertEq(preparedBatch.detailRows.length - 1, 3, '⑥ 多文件合并后只含保留的行');
  const result = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: { warnings: [], detail: { filePath: 'detail.xlsx' }, balance: null, emptyPreprocessedFiles: preparedBatch.emptyPreprocessedFiles },
    templateId: template.id,
    templateName: '提示模板',
    inputFilePaths: [keptPath, emptyPath]
  });
  assertEq([result.status, result.emptyPreprocessedFiles], ['success', ['all-filtered.xlsx']], '⑥ 导入结果带回提示文件');
}

async function run() {
  console.log('==== 网银账单 · 原始账单预处理过滤账单 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-preprocess-row-filter-'));
  try {
    verifyMigration(dir);
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    verifyStorage(database);
    verifyGeneration(dir, database, main);
    verifyStaleReferences(database, main);
    verifyBundle(dir, database, main);
    verifyEmptyFileHint(dir, database, main);
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
