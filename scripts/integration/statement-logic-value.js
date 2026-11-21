// 网银账单：映射字段「逻辑取值 → 候补字段取值」（v3.2.19）e2e 集成验证
//   覆盖：真实主库（仓储）+ main.js 中真实的映射校验、读回、生成配置、失效引用输入与模板包读写函数
//        + 真实 xlsx 读取与写出
//   ① 保存：映射行存 mappedField=逻辑取值、mappedFields=有序候补字段；少于 2 个、重复、不在表头、
//      用于 Balance / MerchantId / Currency 时拒绝；拆分/合并账单映射中出现时拒绝
//   ② 读回：映射关系管理与生成用的映射都保持「逻辑取值」+ 有序候补，不被当成需要拼接字段
//   ③ 生成：库内配置 → buildStatementGenerationConfig → buildMappedRowsForFile → 写出回读：
//      逐行取第一个非空候补（日期、金额照常规范化），全部为空输出空
//   ④ 失效引用：模板【更新】删掉候补字段后列出「（逻辑取值 · 候补字段）」并在生成前拦截
//   ⑤ 模板包：用到逻辑取值时写 v8，读包保留，按导入口径保存后生成结果一致
//   ⑦ v3.2.21 候补含特征值：保存存特征值 token 并校验特征值存在；生成取筛出值、未筛出取下一个候补且不记未筛出提示；
//      BillDate 特征值候补把合计标签筛成空时仍按合计行跳过（资金红线）；被候补引用的特征值不能删除；
//      筛选字段失效时生成前拦截；模板包写 v9、旧版（支持到 v8）整包拒绝，往返后生成结果一致
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-logic-value.js

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
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeLogicValueFields,
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
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['记账日', '交易日', '账号', '币种', '收入', '支出', '对方户名', '摘要'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name', 'Remark', 'Balance'];
const SOURCE_ROWS = [
  ['', '2026-11-01', 'ACC1', 'USD', '100', '', '', '货款'],
  ['2026-11-02', '2026-11-03', 'ACC1', 'USD', '', '30', '甲公司', '退款'],
  ['2026-11-04', '', 'ACC1', 'USD', '50', '', '  ', '']
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
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'CROSS_SHEET_BACKFILL_MAPPING_FIELD', 'CROSS_SHEET_BACKFILL_ENABLED_OPTION', 'PREPROCESS_FIELDS',
  'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS', 'FILENAME_MAPPING_TEMPLATE_ID', 'MISSING_ENUM_MESSAGE',
  'LEGACY_ORIENTED_MAPPINGS_MESSAGE',
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'CROSS_SHEET_BACKFILL_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION'
]);
const LOGIC = CONSTANTS.LOGIC_VALUE_MAPPING_FIELD;

function createMain(database, constantOverrides = {}) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'validateFeatureFiltersPayload', 'collectFeatureFilterRefs', 'buildExportTargetFields',
    'buildMappingTargetFields', 'buildManagedMappingFields', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'isCrossSheetBackfillEnabled',
    'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'getPrimaryMappedField',
    'getMappingFieldValues', 'normalizeMappedFields', 'resolveCurrentMappings', 'decodeCustomInputMappingValue',
    'normalizeMappingRows', 'normalizeExportMappingRows', 'buildCompatibleBigAccounts', 'isFilenameMappingMode',
    'getTemplateMappingConfig', 'buildMappedFieldLookup', 'normalizeLookupMappingValue', 'buildStatementGenerationConfig',
    'buildPreprocessRowFilterRules', 'buildCrossSheetBackfillRule', 'resolveStatementFeatureFilters', 'buildBillSplitMergeConfig', 'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile', 'validateBillSplitMappingsPayload', 'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig', 'isCurrencyOnlyMerchantMapping', 'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta', 'isLegacyOrientedTemplateMappings', 'buildTemplateFieldReferenceInput',
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs', 'collectReferencedFeatureFilterIds'
  ], {
    ...CONSTANTS,
    ...constantOverrides,
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

function draftMappings(overrides = {}) {
  const base = {
    BillDate: [LOGIC, '记账日', '交易日'],
    MerchantId: ['账号'],
    Currency: ['币种'],
    'Credit Amount': ['收入'],
    'Debit Amount': ['支出'],
    'Payee Name': [LOGIC, '对方户名', '摘要'],
    Balance: ['无']
  };
  return Object.entries({ ...base, ...overrides }).map(([templateField, [mappedField, ...mappedFields]]) => ({
    templateField,
    mappedField,
    mappedFields
  }));
}

// 按界面【保存】口径：先经 validateTemplateConfiguration 校验，再写库
function saveTemplate(database, main, name, overrides = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  const validated = main.validateTemplateConfiguration({
    template: database.getTemplate(template.id),
    mappings: draftMappings(overrides),
    enumValues: ENUM_VALUES
  });
  database.saveMappings(template.id, validated.mappings, [], [], 'auto', null, {});
  return database.getTemplate(template.id);
}

function verifySave(database, main) {
  const template = saveTemplate(database, main, '逻辑取值模板');
  const stored = database.getTemplateMappings(template.id).mappings
    .filter((mapping) => mapping.mappedField === LOGIC)
    .map((mapping) => [mapping.templateField, mapping.mappedFields]);
  assertEq(stored, [['BillDate', ['记账日', '交易日']], ['Payee Name', ['对方户名', '摘要']]], '① 映射行存「逻辑取值」与有序候补字段');

  const reject = (overrides) => {
    const error = captureError(() => main.validateTemplateConfiguration({
      template: database.getTemplate(template.id),
      mappings: draftMappings(overrides),
      enumValues: ENUM_VALUES
    }));
    return error && error.message;
  };
  assertEq([
    reject({ 'Payee Name': [LOGIC, '对方户名'] }),
    reject({ 'Payee Name': [LOGIC, '对方户名', '对方户名'] }),
    reject({ 'Payee Name': [LOGIC, '对方户名', '附言'] }),
    reject({ Currency: [LOGIC, '币种', '摘要'] }),
    reject({ Balance: [LOGIC, '收入', '支出'] })
  ], [
    'Payee Name 使用"逻辑取值"时请至少选择 2 个候补字段',
    'Payee Name 的「逻辑取值」候补字段不能重复',
    '映射字段不存在：附言',
    'Currency 不支持使用"逻辑取值"',
    'Balance 不支持使用"逻辑取值"'
  ], '① 少于 2 个、重复、不在表头、用于不支持的字段时拒绝保存');

  const billSplitError = captureError(() => main.validateBillSplitMappingsPayload(
    [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: ['对方户名', '摘要'] }],
    database.getTemplate(template.id)
  ));
  assertEq(billSplitError && /不支持使用"逻辑取值"/.test(billSplitError.message), true, '① 拆分/合并账单映射中出现「逻辑取值」时拒绝保存');
  return template;
}

function verifyReadBack(main, template) {
  const config = main.getTemplateMappingConfig(template.id);
  const pick = (rows) => rows.filter((row) => row.mappedField === LOGIC).map((row) => [row.templateField, row.mappedFields]);
  const expected = [['BillDate', ['记账日', '交易日']], ['Payee Name', ['对方户名', '摘要']]];
  assertEq(pick(config.mappings), expected, '② 映射关系管理读回：保持逻辑取值与候补顺序');
  assertEq(pick(config.exportMappings), expected, '② 生成用映射：保持逻辑取值与候补顺序，不当成需要拼接字段');
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
  const dateIndex = exportRows[0].indexOf('BillDate');
  return exported.rows.map((row, rowIndex) => [
    exportRows[rowIndex + 1][dateIndex],
    row[index('Credit Amount')] === '' ? '' : Number(row[index('Credit Amount')]),
    row[index('Debit Amount')] === '' ? '' : Number(row[index('Debit Amount')]),
    row[index('Payee Name')]
  ]);
}

function verifyGeneration(dir, main, template) {
  const sourcePath = path.join(dir, 'source.xlsx');
  writeSource(sourcePath, SOURCE_ROWS);
  // 第 2 行记账日为空 → 取交易日；户名为空 → 取摘要；第 4 行户名只有空白、摘要为空 → 输出空
  assertEq(generate(main, template.id, sourcePath, path.join(dir, 'out-1.xlsx')), [
    ['2026-11-01', 100, '', '货款'],
    ['2026-11-02', '', 30, '甲公司'],
    ['2026-11-04', 50, '', '']
  ], '③ 回读导出：逐行取第一个非空候补，日期规范化，全部为空输出空');
}

// 升级前直接映射名为「逻辑取值」的源列的旧映射（mappedFields 为空）：表头有该列时照旧按源列取值，没有时拒绝生成，
//   不能把发生额静默变成空、整笔交易被跳过。
function verifyLegacyEmptyCandidates(dir, main) {
  const legacyHeaders = ['记账日', '逻辑取值', '支出'];
  const legacyTemplate = { id: 9001, name: '旧模板-逻辑取值列', headers: legacyHeaders, channelId: null };
  const legacyMappings = [
    { templateField: 'BillDate', mappedField: '记账日', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: LOGIC, mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: '支出', mappedFields: [] },
    { templateField: 'Balance', mappedField: '无', mappedFields: [] }
  ];
  const config = main.buildStatementGenerationConfig({
    template: legacyTemplate,
    mappings: legacyMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  const sourcePath = path.join(dir, 'legacy-column.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([legacyHeaders, ['2026-11-01', '88', '']]), 'Sheet1');
  XLSX.writeFile(workbook, sourcePath);
  const mapped = main.buildMappedRowsForFile({ config, inputFilePath: sourcePath });
  const creditIndex = mapped[0].indexOf('Credit Amount');
  assertEq(mapped.slice(1).map((row) => row[creditIndex]), ['88'], '⑥ 旧映射（无候补字段）且表头有「逻辑取值」列：照旧按该列取发生额');

  const missing = captureError(() => main.buildStatementGenerationConfig({
    template: { ...legacyTemplate, headers: ['记账日', '收入', '支出'] },
    mappings: legacyMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  }));
  assertEq(missing && missing.message,
    '「Credit Amount」选择了「逻辑取值」但没有候补字段，请在映射关系管理中点击【设置】重新选择',
    '⑥ 没有候补字段且表头没有该列：拒绝生成并提示重新设置');

  // 旧写法两种：mappedFields 为空或只有该列本身，都按源列名（不是内部 token）读取，按源字段名判断的逻辑与旧版本一致
  assertEq(main.buildMappedFieldLookup([
    { templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [LOGIC] },
    { templateField: 'Drawee Name', mappedField: LOGIC, mappedFields: [] }
  ], { sourceHeaders: legacyHeaders }), { 'Payee Name': LOGIC, 'Drawee Name': LOGIC }, '⑥ 单个同名字段与空候补都按源列名直接读取');

  // 旧模板包恢复：按导入口径规范化后校验，表头有「逻辑取值」列的直接映射原样保留，不当作新功能（模板包版本不升）
  const validated = main.validateTemplateConfiguration({
    template: legacyTemplate,
    mappings: main.normalizeMappingRows({ template: legacyTemplate, mappings: legacyMappings, enumValues: ENUM_VALUES }),
    enumValues: ENUM_VALUES
  });
  assertEq(validated.mappings.filter((item) => item.templateField === 'Credit Amount').map((item) => [item.mappedField, item.mappedFields]),
    [[LOGIC, []]], '⑥ 旧模板包里直接映射「逻辑取值」列的配置导入时原样保留');
  assertEq(main.resolveTemplateBundleVersion([{ mappings: validated.mappings }]), CONSTANTS.BASE_BUNDLE_VERSION,
    '⑥ 直接映射「逻辑取值」列不升模板包版本（旧版本可读）');

  // 拆分/合并映射直接引用名为「逻辑取值」的源列（旧配置，mappedFields 为空或只有该列）：保存与模板包导入都照常接受
  const legacySplit = [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [] }];
  assertEq(main.validateBillSplitMappingsPayload(legacySplit, legacyTemplate).map((item) => [item.templateField, item.mappedField]),
    [['Payee Name', LOGIC]], '⑥ 拆分映射直接引用「逻辑取值」列时照常保存');
  assertEq(captureError(() => main.validateTemplateConfiguration({
    template: legacyTemplate,
    mappings: main.normalizeMappingRows({ template: legacyTemplate, mappings: legacyMappings, enumValues: ENUM_VALUES }),
    enumValues: ENUM_VALUES,
    billSplitMappings: [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [LOGIC] }]
  })), null, '⑥ 模板包内拆分映射直接引用「逻辑取值」列时照常导入');
  const splitWithCandidates = captureError(() => main.validateBillSplitMappingsPayload(
    [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: ['记账日', '支出'] }],
    legacyTemplate
  ));
  assertEq(splitWithCandidates && /不支持使用"逻辑取值"/.test(splitWithCandidates.message), true, '⑥ 拆分映射里带候补字段的逻辑取值仍拒绝');

  // 同名列重复两次：按逻辑取值校验并拒绝（只接受空或单个同名列的旧直接映射）
  const duplicatedSelf = captureError(() => main.validateTemplateConfiguration({
    template: legacyTemplate,
    mappings: main.normalizeMappingRows({
      template: legacyTemplate,
      mappings: legacyMappings.map((item) => (item.templateField === 'Credit Amount' ? { ...item, mappedFields: [LOGIC, LOGIC] } : item)),
      enumValues: ENUM_VALUES
    }),
    enumValues: ENUM_VALUES
  }));
  assertEq(duplicatedSelf && /候补字段不能重复/.test(duplicatedSelf.message), true, '⑥ 候补字段为两个同名列时按重复拒绝');

  // 拆分映射的候补为两个同名列：不是旧版本的直接引用（按去重前的原值判断），保存与模板包导入都拒绝，不被仓储去重后写入
  const splitDuplicatedSelf = [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [LOGIC, LOGIC] }];
  const splitDuplicatedSave = captureError(() => main.validateBillSplitMappingsPayload(splitDuplicatedSelf, legacyTemplate));
  const splitDuplicatedBundle = captureError(() => main.validateTemplateConfiguration({
    template: legacyTemplate,
    mappings: main.normalizeMappingRows({ template: legacyTemplate, mappings: legacyMappings, enumValues: ENUM_VALUES }),
    enumValues: ENUM_VALUES,
    billSplitMappings: splitDuplicatedSelf
  }));
  assertEq([splitDuplicatedSave, splitDuplicatedBundle].map((error) => Boolean(error && /不支持使用"逻辑取值"/.test(error.message))),
    [true, true], '⑥ 拆分映射候补为两个同名列时保存与模板包导入都拒绝');

  // 复用模块字段的映射关系时拆分映射不参与生成：其中直接引用「逻辑取值」列的旧映射在模板删掉该列后不阻断生成
  const splitStore = {
    getBillSplitMappings: () => [{ rowIndex: 0, templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [] }],
    getBillSplitRows: () => [], getBillSplitAmountRules: () => [], getBillSplitMeta: () => ({}), getAmountSplitRules: () => []
  };
  const splitMain = createMain(splitStore);
  const shrunkTemplate = { ...legacyTemplate, headers: ['记账日', '收入', '支出'] };
  const splitEnabled = (reuse) => [
    { templateField: '是否拆分/合并明细账单', mappedField: '是', mappedFields: [] },
    { templateField: '复用模块字段的映射关系', mappedField: reuse ? '是' : '否', mappedFields: [] }
  ];
  assertEq(captureError(() => splitMain.buildBillSplitMergeConfig(shrunkTemplate, splitEnabled(true))), null,
    '⑥ 复用模块映射时不构造拆分映射，失效的旧直接引用不阻断生成');
  const splitEffective = captureError(() => splitMain.buildBillSplitMergeConfig(shrunkTemplate, splitEnabled(false)));
  assertEq(Boolean(splitEffective && /没有候补字段/.test(splitEffective.message)), true, '⑥ 不复用时拆分映射生效，失效的直接引用照常拒绝');

  // v7 及更早的模板包：mappedField 为「逻辑取值」的多字段映射是旧式按序拼接，读包时还原为需要拼接字段；v8 包保持逻辑取值
  const legacyBundlePath = path.join(dir, 'legacy-v7.json');
  const legacyEntry = {
    name: '旧模板-逻辑取值列', sourceFileName: 'legacy.xlsx', headers: ['记账日', '逻辑取值', '后缀', '支出'],
    mappings: [
      { templateField: 'Remark', mappedField: LOGIC, mappedFields: [LOGIC, '后缀'] },
      { templateField: 'Credit Amount', mappedField: LOGIC, mappedFields: [] }
    ],
    billSplitMappings: [{ templateField: 'Remark', mappedField: LOGIC, mappedFields: [LOGIC, '后缀'] }]
  };
  fs.writeFileSync(legacyBundlePath, JSON.stringify({ bundleVersion: 7, channels: [], templates: [legacyEntry] }), 'utf8');
  const legacyRead = main.readTemplateBundleFile(legacyBundlePath).templates[0];
  assertEq([
    legacyRead.mappings.map((item) => [item.templateField, item.mappedField, item.mappedFields]),
    legacyRead.billSplitMappings.map((item) => [item.mappedField, item.mappedFields])
  ], [
    [['Remark', '需要拼接字段', [LOGIC, '后缀']], ['Credit Amount', LOGIC, []]],
    [['需要拼接字段', [LOGIC, '后缀']]]
  ], '⑥ v7 模板包里「逻辑取值」多字段映射按旧语义还原为需要拼接字段，单列直接映射保持原样');
  fs.writeFileSync(legacyBundlePath, JSON.stringify({ bundleVersion: 8, channels: [], templates: [legacyEntry] }), 'utf8');
  assertEq(main.readTemplateBundleFile(legacyBundlePath).templates[0].mappings[0].mappedField, LOGIC, '⑥ v8 模板包保持逻辑取值');
}

function verifyStaleReferences(database, main, template) {
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const shrunk = HEADERS.filter((header) => header !== '摘要');
  const input = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(formatFieldReferenceLines(tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(input), shrunk)),
    ['Payee Name（逻辑取值 · 候补字段） ← 摘要'], '④ 删掉候补字段：失效引用列出逻辑取值的候补字段');
  const blocked = captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '逻辑取值模板', headers: shrunk }, input));
  assertEq(blocked && blocked.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '④ 生成前拦截');
}

function verifyBundle(dir, database, main, template) {
  const entry = database.listTemplateBundleEntries().find((item) => item.name === template.name);
  assertEq([
    main.resolveTemplateBundleVersion([{ mappings: [] }]),
    main.resolveTemplateBundleVersion([entry])
  ], [CONSTANTS.BASE_BUNDLE_VERSION, CONSTANTS.LOGIC_VALUE_BUNDLE_VERSION], '⑤ 用到逻辑取值时写 v8，未用到时版本不变');

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  // 按导入口径：读包映射经 normalizeMappingRows → validateTemplateConfiguration 后保存
  const normalized = targetMain.normalizeMappingRows({ template: target.getTemplate(imported.id), mappings: readEntry.mappings, enumValues: ENUM_VALUES });
  const validated = targetMain.validateTemplateConfiguration({ template: target.getTemplate(imported.id), mappings: normalized, enumValues: ENUM_VALUES });
  target.saveMappings(imported.id, validated.mappings, [], [], 'auto', null, { preserveOwn: false });
  // 模板包导入写库前同一校验：包内拆分映射用了「逻辑取值」时整条模板跳过（界面不能创建这种配置）
  const bundleSplitError = captureError(() => targetMain.validateTemplateConfiguration({
    template: target.getTemplate(imported.id),
    mappings: normalized,
    enumValues: ENUM_VALUES,
    billSplitMappings: [{ templateField: 'Payee Name', mappedField: LOGIC, mappedFields: ['对方户名', '摘要'] }]
  }));
  assertEq(bundleSplitError && bundleSplitError.message,
    '拆分/合并账单映射中的「Payee Name」不支持使用"逻辑取值"，请改选源字段',
    '⑤ 模板包内拆分映射用了逻辑取值时导入前拒绝（该模板跳过）');
  // 模板包内候补字段重复：按导入口径先规范化再校验，规范化不去重，校验照常拒绝（同映射保存入口）
  const duplicatedMappings = readEntry.mappings.map((item) => (item.mappedField === LOGIC
    ? { ...item, mappedFields: [item.mappedFields[0], ` ${item.mappedFields[0]} `, ...item.mappedFields.slice(1)] }
    : item));
  const bundleDuplicateError = captureError(() => targetMain.validateTemplateConfiguration({
    template: target.getTemplate(imported.id),
    mappings: targetMain.normalizeMappingRows({ template: target.getTemplate(imported.id), mappings: duplicatedMappings, enumValues: ENUM_VALUES }),
    enumValues: ENUM_VALUES
  }));
  assertEq(bundleDuplicateError && /候补字段不能重复/.test(bundleDuplicateError.message), true,
    '⑤ 模板包内逻辑取值候补字段重复时导入前拒绝（该模板跳过）');
  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(
    generate(targetMain, imported.id, sourcePath, path.join(dir, 'out-imported.xlsx')),
    generate(main, template.id, sourcePath, path.join(dir, 'out-origin.xlsx')),
    '⑤ 模板包往返后生成结果一致'
  );
  closeDatabase(target);
}


// ⑦ v3.2.21：逻辑取值候补含特征值
const FEATURE_TOKEN = (id) => buildLogicValueFeatureCandidate(id);
const SERIAL_FEATURE = { name: '流水号', sourceField: '摘要', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: '' };
const DAY_FEATURE = { name: '交易日8位', sourceField: '交易日', separator: 'space', length: 8, letterPrefixCount: null, digitsOnly: true, sample: '' };

function generateWithIssues(main, templateId, sourcePath) {
  const config = main.getTemplateMappingConfig(templateId);
  const generationConfig = main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  const mapped = main.buildMappedRowsForFile({ config: generationConfig, inputFilePath: sourcePath });
  const column = (name) => mapped[0].indexOf(name);
  return {
    rows: mapped.slice(1).map((row) => [row[column('BillDate')], row[column('Credit Amount')], row[column('Debit Amount')], row[column('Payee Name')]]),
    issues: (mapped.issues || []).map((issue) => [issue.type, issue.rowNumber])
  };
}

function verifyFeatureCandidates(dir, database, main) {
  const template = database.upsertTemplate({ name: '逻辑取值特征值模板', sourceFileName: 'feature.xlsx', headers: HEADERS });
  const featureFilters = main.validateFeatureFiltersPayload([SERIAL_FEATURE, DAY_FEATURE], database.getTemplate(template.id));
  database.saveTemplateFeatureFilters(template.id, featureFilters);
  const [serialId, dayId] = featureFilters.map((item) => item.id);
  const mappings = draftMappings({
    BillDate: [LOGIC, FEATURE_TOKEN(dayId), '记账日'],
    'Payee Name': [LOGIC, FEATURE_TOKEN(serialId), '对方户名']
  });
  const validate = (rows, list = database.getTemplate(template.id).featureFilters, headers = HEADERS) => main.validateTemplateConfiguration({
    template: { ...database.getTemplate(template.id), headers },
    mappings: rows,
    enumValues: ENUM_VALUES,
    featureFilters: list
  });
  const validated = validate(mappings);
  database.saveMappings(template.id, validated.mappings, [], [], 'auto', null, {});
  assertEq(database.getTemplateMappings(template.id).mappings.filter((item) => item.mappedField === LOGIC).map((item) => [item.templateField, item.mappedFields]),
    [['BillDate', [FEATURE_TOKEN(dayId), '记账日']], ['Payee Name', [FEATURE_TOKEN(serialId), '对方户名']]], '⑦ 保存：候补存特征值 token 与源字段，顺序不变');

  const message = (fn) => { const error = captureError(fn); return error && error.message; };
  assertEq([
    message(() => validate(draftMappings({ 'Payee Name': [LOGIC, FEATURE_TOKEN('99'), '对方户名'] }))),
    message(() => validate(draftMappings({ 'Payee Name': [LOGIC, FEATURE_TOKEN(serialId), FEATURE_TOKEN(serialId)] }))),
    // 同一特征值的不同写法（id 带空白）规范化后算重复
    message(() => validate(draftMappings({ 'Payee Name': [LOGIC, FEATURE_TOKEN(serialId), `${FEATURE_TOKEN(serialId)} `.replace(serialId, ` ${serialId}`)] }))),
    Boolean(message(() => validate(mappings, undefined, HEADERS.filter((header) => header !== '摘要')))),
    // 模板列名与特征值候补内部写法相同（构造的含 NUL 列名）时无法区分，拒绝保存；按原写法检查（id 前带空白的旧列名同样拒绝）
    message(() => validate(mappings, undefined, HEADERS.concat(FEATURE_TOKEN(serialId)))),
    message(() => validate(draftMappings({ 'Payee Name': [LOGIC, FEATURE_TOKEN(` ${serialId}`).replace(`:${serialId}`, `: ${serialId}`), '对方户名'] }),
      undefined, HEADERS.concat(FEATURE_TOKEN(serialId).replace(`:${serialId}`, `: ${serialId}`))))
  ], [
    '特征值：Payee Name（逻辑取值） 选择的特征值不存在，请重新选择',
    'Payee Name 的「逻辑取值」候补字段不能重复',
    'Payee Name 的「逻辑取值」候补字段不能重复',
    true,
    'Payee Name 的「逻辑取值」有特征值候补与模板中一个列名内部写法相同，无法区分，请修改该列名',
    'Payee Name 的「逻辑取值」有特征值候补与模板中一个列名内部写法相同，无法区分，请修改该列名'
  ], '⑦ 保存：特征值不存在、重复（含不同写法）、筛选字段不在表头、与列名写法相同时拒绝');

  // 生成：第 2 行摘要筛出流水号；第 3 行未筛出取对方户名；第 4 行都为空输出空；第 5 行交易日是合计标签（被筛成空）→ 按合计行跳过
  const sourcePath = path.join(dir, 'feature-source.xlsx');
  writeSource(sourcePath, [
    ['2026-11-05', '20261101 0930', 'ACC1', 'USD', '100', '', '甲公司', '付款 FT24123456'],
    ['2026-11-02', '无', 'ACC1', 'USD', '', '30', '乙公司', '退款'],
    ['2026-11-04', '', 'ACC1', 'USD', '50', '', '', ''],
    ['2026-11-30', '合计', 'ACC1', 'USD', '150', '30', '', '']
  ]);
  const generated = generateWithIssues(main, template.id, sourcePath);
  assertEq(generated.rows, [
    ['20261101', '100', '', 'FT24123456'],
    ['2026-11-02', '', '30', '乙公司'],
    ['2026-11-04', '50', '', '']
  ], '⑦ 生成：特征值候补取筛出值，未筛出取下一个候补，全部为空输出空');
  assertEq(generated.issues, [['summary-row-skipped', 5]], '⑦ 生成：不记未筛出特征值提示；BillDate 特征值候补源单元格为合计标签时跳过合计行');

  // 删除保护：被逻辑取值候补引用的特征值不能删
  const deleteError = message(() => main.validateFeatureFiltersPayload(
    database.getTemplate(template.id).featureFilters.filter((item) => item.id !== serialId),
    database.getTemplate(template.id)
  ));
  assertEq(deleteError, '特征值「流水号」正被 Payee Name（逻辑取值） 使用，请先改选其他特征值后再删除', '⑦ 删除被逻辑取值候补引用的特征值时拒绝');

  // 已保存映射仍引用、特征值已不存在的 id（如模板包带入、当前不生效的映射）不分配给新特征值，悬空引用不会被绑定到新规则
  const danglingTemplate = database.upsertTemplate({ name: '悬空引用模板', sourceFileName: 'dangling.xlsx', headers: HEADERS });
  database.saveTemplateFeatureFilters(danglingTemplate.id, [{ id: '1', ...SERIAL_FEATURE }]);
  database.saveMappings(danglingTemplate.id, [
    { templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [FEATURE_TOKEN('2'), '对方户名'] }
  ], [], [], 'auto', null, {});
  const allocated = main.validateFeatureFiltersPayload(
    database.getTemplate(danglingTemplate.id).featureFilters.concat({ ...DAY_FEATURE, name: '新特征值' }),
    database.getTemplate(danglingTemplate.id)
  );
  assertEq(allocated.map((item) => [item.id, item.name]), [['1', '流水号'], ['3', '新特征值']], '⑦ 新特征值 id 避开已保存映射里的悬空引用');
  // 超出安全整数的数字 id 也按精确值避开（不因精度丢失复用保留的 id）
  const bigId = '9007199254740992';
  const bigIdTemplate = database.upsertTemplate({ name: '悬空大数 id 模板', sourceFileName: 'dangling-big.xlsx', headers: HEADERS });
  database.saveTemplateFeatureFilters(bigIdTemplate.id, [{ id: '1', ...SERIAL_FEATURE }]);
  database.saveMappings(bigIdTemplate.id, [
    { templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [FEATURE_TOKEN(bigId), '对方户名'] }
  ], [], [], 'auto', null, {});
  const bigAllocated = main.validateFeatureFiltersPayload(
    database.getTemplate(bigIdTemplate.id).featureFilters.concat({ ...DAY_FEATURE, name: '新特征值' }),
    database.getTemplate(bigIdTemplate.id)
  );
  assertEq(bigAllocated.map((item) => item.id), ['1', '9007199254740993'], '⑦ 大数悬空 id 按精确值避开');

  // 表头更新：特征值筛选字段失效时列出特征值并在生成前拦截，不把 token 当源字段
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const shrunk = HEADERS.filter((header) => header !== '摘要');
  const input = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(formatFieldReferenceLines(tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(input), shrunk)),
    ['特征值「流水号」 · 筛选字段 ← 摘要'], '⑦ 表头更新：失效引用列出被候补引用的特征值筛选字段');
  const blocked = captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '逻辑取值特征值模板', headers: shrunk }, input));
  assertEq(blocked && blocked.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '⑦ 表头更新：生成前拦截');

  // 旧版本（v3.2.19/v3.2.20）的候补都是源列名：列名形如 `__FEATURE_FILTER__:<id>` 时保存、生成、模板包版本都按源列处理，
  //   不被同 id 的特征值替换（资金红线：发生额不能改从另一列取值）
  const legacyColumn = buildFeatureFilterToken(serialId);
  const legacyHeaders = HEADERS.concat(legacyColumn);
  const legacyTemplate = database.upsertTemplate({ name: '旧候补列名模板', sourceFileName: 'legacy-candidate.xlsx', headers: legacyHeaders });
  database.saveTemplateFeatureFilters(legacyTemplate.id, database.getTemplate(template.id).featureFilters);
  const legacyMappings = draftMappings({ 'Credit Amount': [LOGIC, legacyColumn, '收入'] });
  const legacyValidated = main.validateTemplateConfiguration({
    template: database.getTemplate(legacyTemplate.id), mappings: legacyMappings, enumValues: ENUM_VALUES,
    featureFilters: database.getTemplate(legacyTemplate.id).featureFilters
  });
  database.saveMappings(legacyTemplate.id, legacyValidated.mappings, [], [], 'auto', null, {});
  const legacySource = path.join(dir, 'legacy-candidate.xlsx');
  const legacyBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(legacyBook, XLSX.utils.aoa_to_sheet([legacyHeaders,
    ['2026-11-01', '', 'ACC1', 'USD', '7', '', '甲公司', '付款 FT24123456', '100']]), 'Sheet1');
  XLSX.writeFile(legacyBook, legacySource);
  const legacyEntry = database.listTemplateBundleEntries().find((item) => item.name === '旧候补列名模板');
  assertEq([
    generateWithIssues(main, legacyTemplate.id, legacySource).rows.map((row) => row[1]),
    main.resolveTemplateBundleVersion([legacyEntry]),
    message(() => main.validateFeatureFiltersPayload([], database.getTemplate(legacyTemplate.id)))
  ], [['100'], CONSTANTS.LOGIC_VALUE_BUNDLE_VERSION, null],
  '⑦ 旧候补列名形如 __FEATURE_FILTER__:1：按源列取发生额、模板包仍写 v8、不算引用特征值');

  // v8 及更早的模板包不可能含特征值候补：形如特征值候补、表头中又没有的值是失效的旧源列名，导入前拒绝，不改认作特征值
  const legacyBundleError = message(() => main.validateTemplateConfiguration({
    template: { ...database.getTemplate(template.id), headers: HEADERS },
    mappings: mappings,
    enumValues: ENUM_VALUES,
    featureFilters: database.getTemplate(template.id).featureFilters,
    allowLogicValueFeatureCandidates: false
  }));
  assertEq(legacyBundleError, 'BillDate 的「逻辑取值」有候补字段在模板表头中不存在，请在原版本中重新选择候补字段后再导出',
    '⑦ v8 及更早模板包：形如特征值候补的失效源列名拒绝导入');
  // 模板包导入时不分配给新特征值的 id：直选特征值与逻辑取值候补引用的 id（主映射与拆分映射）
  assertEq(main.collectReferencedFeatureFilterIds(
    [{ templateField: 'Remark', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['5'] },
      { templateField: 'Payee Name', mappedField: LOGIC, mappedFields: [FEATURE_TOKEN('6'), '对方户名', buildFeatureFilterToken('7')] }],
    [{ templateField: 'Reference', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['8'] }]
  ), ['5', '6', '8'], '⑦ 模板包导入：收集映射引用的特征值 id（旧写法的源列名不算）');

  // 模板包：写 v9；旧版（支持到 v8）整包拒绝；往返后生成结果一致
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '逻辑取值特征值模板');
  assertEq([main.resolveTemplateBundleVersion([entry]), CONSTANTS.SUPPORTED_BUNDLE_VERSION], [9, 9], '⑦ 模板包：候补含特征值时写 v9');
  const bundlePath = path.join(dir, 'feature-bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 8 });
  assertEq(message(() => legacyReader.readTemplateBundleFile(bundlePath)), '模板文件版本（9）高于当前应用支持的版本（8），请升级应用后再导入',
    '⑦ 模板包：旧版（支持到 v8）整包拒绝');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  const target = openDatabase(path.join(dir, 'feature-import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  target.saveTemplateFeatureFilters(imported.id, readEntry.featureFilters);
  const normalized = targetMain.normalizeMappingRows({ template: target.getTemplate(imported.id), mappings: readEntry.mappings, enumValues: ENUM_VALUES });
  const importedMappings = targetMain.validateTemplateConfiguration({
    template: target.getTemplate(imported.id), mappings: normalized, enumValues: ENUM_VALUES, featureFilters: readEntry.featureFilters
  });
  target.saveMappings(imported.id, importedMappings.mappings, [], [], 'auto', null, { preserveOwn: false });
  assertEq(generateWithIssues(targetMain, imported.id, sourcePath), generated, '⑦ 模板包往返后生成结果一致');
  closeDatabase(target);
}

async function run() {
  console.log('==== 网银账单 · 映射字段逻辑取值 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-logic-value-'));
  try {
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    const template = verifySave(database, main);
    verifyReadBack(main, template);
    verifyGeneration(dir, main, template);
    verifyStaleReferences(database, main, template);
    verifyLegacyEmptyCandidates(dir, main);
    verifyBundle(dir, database, main, template);
    verifyFeatureCandidates(dir, database, main);
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
