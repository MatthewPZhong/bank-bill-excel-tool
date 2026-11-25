// 网银账单：原始账单预处理「跨 Sheet 回填」（v3.2.21）e2e 集成验证
//   覆盖：真实主库（迁移、仓储）+ main.js 中真实的映射配置、生成配置、失效引用输入、模板包读写、导入提示
//        与「导出明细时附带写出回填后的原始账单」函数 + 真实 xlsx 读取与写出 + 真实会话缓存
//   合成工作簿：主表 NGN（表格从 B 列开始）换汇卖出行无日期、币种与渠道，描述含买入金额；来源表 USD（首行为标题）
//   只有买入方向，日期为真 Excel 日期。数据全部为合成数据。
//   ① 迁移：旧库无 templates.cross_sheet_backfill_rule_json 列 → 启动补列，模板保留、规则为空；重复启动无副作用
//   ② 存储：规则随映射保存（同一事务）并规范化；未带规则的保存不改；传 {} 清空；模板包覆盖导入（表头被覆盖）时清空
//   ③ 生成：库内配置 → buildStatementGenerationConfig → buildMappedRowsForFile → 写出回读：待回填行按金额一对一配对
//      （同金额按顺序）、只填空单元格、币种补本表币种、配不上的行跳过；日期不在相邻交易之间时提示不拦截；
//      重复生成结果一致；未勾选时不下发；勾选但规则不完整、来源 Sheet / 字段缺失、回填目标为发生额或 MerchantId 所用的列时拒绝；
//      没有待回填行时不读来源 Sheet
//   ④ 导出回填后的原始账单：会话条目按文件去重 → 命名不覆盖 → 只改主表被回填的单元格（日期写真日期 dd/mm/yyyy）、
//      保留 USD sheet → 用同一模板再导入，明细与本次一致、只剩配不上的行；源文件导入后变化时不写出并提示重新导入
//   ⑤ 失效引用：模板【更新】删掉本表配对字段与回填目标字段时列出「原始账单预处理 · 跨 Sheet 回填 …」并拦截；
//      未勾选时标为未启用；保存校验口径：回填目标不能是发生额 / 币种 / MerchantId 所用的源列
//   ⑥ 模板包：导出条目带规则 → 用到回填时写 v10 → 读包保留 → 按导入口径保存后生成结果一致
//   UI 由 renderer lifecycle 覆盖；【导出明细】的 IPC 编排（filePlan 登记 outputs、执行时再核对）由 GUI 实测覆盖。
//
// 用法：node scripts/integration/statement-cross-sheet-backfill.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const { hasColumn } = require('../../src/backend/database/migrations');
const { readRowsWithMetadata } = require('../../src/backend/file-service/readers');
const {
  allocateCrossSheetBackfillOutputPaths,
  buildDetailExportRows,
  hasDetailExportRow,
  buildFeatureFilterToken,
  buildLogicValueToken,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  buildMappedRows,
  computeFileFingerprint,
  readFingerprintedFile,
  extractHeaders,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  loadCurrencyMappings,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeBillSplitRowFilterRules,
  normalizeCell,
  normalizeFeatureFilterList,
  normalizeFeeAmountFormula,
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  normalizeRowFilterRules,
  parseFeatureFilterToken,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  hasCrossSheetBackfillSettings,
  normalizeCrossSheetBackfillRule,
  validateCrossSheetBackfillRule,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  validateBillSplitRowFilterRules,
  validateFeeAmountFormula,
  validateRowFilterRules,
  writeCrossSheetBackfillWorkbook,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders,
  formatFieldReferenceLines
} = require('../../src/main-process/template-header-update');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const { buildFieldIndexMap, parseRequiredBillDates } = require('../../src/main-process/statement-generation-business');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['ValueDate', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Account', 'Currency', 'Channel', 'Channel OrderNo'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Balance'];
// 主表 NGN（B1 起）：第 3、5、7、8 行是换汇卖出行（无日期、币种、渠道）；第 7 行在来源表中没有对应买入
const MAIN_ROWS = [
  ['21/09/2026', 'Transfer in', '', 1000, 'NGN001', 'NGN', 'NIP', 'N-1'],
  ['', 'Trade - $65.45', 90000, '', 'NGN001', '', '', ''],
  ['27/09/2026', 'Fee', 50, '', 'NGN001', 'NGN', 'POS', 'N-2'],
  ['', 'Trade - $10', 15000, '', 'NGN001', '', '', ''],
  ['28/09/2026', 'Transfer in', '', 500, 'NGN001', 'NGN', 'NIP', 'N-3'],
  ['', 'Trade - $99', 148500, '', 'NGN001', '', '', ''],
  ['', 'Trade - $65.45', 90000, '', 'NGN001', '', '', '']
];
// 来源表 USD：第 1 行为标题，第 2 行为表头；日期为真 Excel 日期（46291 = 2026-09-26）
const USD_HEADERS = ['ValueDate', 'Credit Amount', 'Channel', 'Channel OrderNo'];
const USD_ROWS = [
  [46291, 65.45, 'FX-01', 'O-1'],
  [46300, 10, 'FX-02', 'O-2'],
  [46294, 65.45, 'FX-03', 'O-3']
];
const RULE = {
  sourceSheetName: 'USD',
  rowRules: [{ seq: 1, conditions: [{ field: 'ValueDate', op: '空值', value: '' }] }],
  matchMode: 'amount',
  matchField: 'Transaction Description',
  sourceMatchField: 'Credit Amount',
  sourceDateOrder: 'auto',
  backfillFields: [
    { targetField: 'ValueDate', sourceField: 'ValueDate' },
    { targetField: 'Channel', sourceField: 'Channel' },
    { targetField: 'Channel OrderNo', sourceField: 'Channel OrderNo' }
  ]
};
// 预期明细：[BillDate, MerchantId, Currency, Credit, Debit, Remark]；第 7 行跳过
const EXPECTED_DETAIL = [
  ['2026-09-21', 'NGN001', 'NGN', 1000, '', 'NIP'],
  ['2026-09-26', 'NGN001', 'NGN', '', 90000, 'FX-01'],
  ['2026-09-27', 'NGN001', 'NGN', '', 50, 'POS'],
  ['2026-10-05', 'NGN001', 'NGN', '', 15000, 'FX-02'],
  ['2026-09-28', 'NGN001', 'NGN', 500, '', 'NIP'],
  ['2026-09-29', 'NGN001', 'NGN', '', 90000, 'FX-03']
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
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'CROSS_SHEET_BACKFILL_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION',
  'CROSS_SHEET_BACKFILL_PROTECTED_MAPPING_TARGETS', 'CROSS_SHEET_BACKFILL_PROTECTED_AREAS'
]);
const TOGGLE = CONSTANTS.CROSS_SHEET_BACKFILL_MAPPING_FIELD;
const activityLog = [];

function createMain(database) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'validateFeatureFiltersPayload', 'collectFeatureFilterRefs', 'buildExportTargetFields',
    'buildMappingTargetFields', 'buildManagedMappingFields', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled',
    'isCrossSheetBackfillEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference', 'getPrimaryMappedField',
    'getMappingFieldValues', 'normalizeMappedFields', 'resolveCurrentMappings', 'decodeCustomInputMappingValue',
    'normalizeMappingRows', 'normalizeExportMappingRows', 'buildCompatibleBigAccounts', 'isFilenameMappingMode',
    'getTemplateMappingConfig', 'buildMappedFieldLookup', 'normalizeLookupMappingValue', 'buildStatementGenerationConfig',
    'buildPreprocessRowFilterRules', 'buildCrossSheetBackfillRule', 'resolveStatementFeatureFilters', 'buildBillSplitMergeConfig',
    'buildAmountSplitByFieldConfig', 'buildMappedRowsForFile', 'validateBillSplitMappingsPayload', 'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig', 'isCurrencyOnlyMerchantMapping', 'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta', 'isLegacyOrientedTemplateMappings', 'buildTemplateFieldReferenceInput',
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs',
    'collectCrossSheetBackfillExcludedTargets', 'buildImportWarningDetailLines', 'buildImportWarningMessage',
    'collectCrossSheetBackfillExportItems', 'isCrossSheetBackfillSourceUnchanged', 'exportCrossSheetBackfillWorkbooks',
    'extractStatementTemplateHeaders', 'matchFileToTemplate', 'matchesTemplateHeaders'
  ], {
    ...CONSTANTS,
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools(CONSTANTS),
    diffTemplateHeaders,
    extractHeaders,
    readRowsWithMetadata,
    database,
    fs,
    path,
    normalizeCell,
    normalizeFeeAmountFormula,
    normalizeFeeFieldMappings,
    validateFeeFieldMappings,
    isFeeFieldMappingTemplateFieldExcluded,
    parseLogicValueToken,
    parseLogicValueFeatureFilterRef,
    buildLogicValueFeatureCandidate,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateFeeAmountFormula,
    validateBillSplitRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    hasCrossSheetBackfillSettings,
    normalizeCrossSheetBackfillRule,
    validateCrossSheetBackfillRule,
    computeFileFingerprint,
    readFingerprintedFile,
    writeCrossSheetBackfillWorkbook,
    getStatementSessionEntries,
    appendActivityLogEntry: (entry) => activityLog.push(entry),
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
    hasDetailExportRow,
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

function writeSource(filePath, { mainRows = MAIN_ROWS, usdRows = USD_ROWS, withUsd = true } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS, ...mainRows], { origin: 'B1' }), 'NGN');
  if (withUsd) {
    const usd = XLSX.utils.aoa_to_sheet([['USD 账户流水（合成数据）'], USD_HEADERS, ...usdRows]);
    usdRows.forEach((_row, index) => { usd[`A${index + 3}`].z = 'm/d/yyyy'; });
    XLSX.utils.book_append_sheet(workbook, usd, 'USD');
  }
  XLSX.writeFile(workbook, filePath);
}

function readSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return { header: rows[0], rows: rows.slice(1) };
}

function mappingsWith({ enabled = true } = {}) {
  return [
    { templateField: 'BillDate', mappedField: 'ValueDate', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: 'Account', mappedFields: [] },
    { templateField: 'Currency', mappedField: 'Currency', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: 'Credit Amount', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: 'Debit Amount', mappedFields: [] },
    { templateField: 'Remark', mappedField: 'Channel', mappedFields: [] },
    { templateField: TOGGLE, mappedField: enabled ? CONSTANTS.CROSS_SHEET_BACKFILL_ENABLED_OPTION : '', mappedFields: [] }
  ];
}

function defineTemplate(database, name, { rule = RULE, enabled = true } = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  database.saveMappings(template.id, mappingsWith({ enabled }), [], [], 'auto', null, { crossSheetBackfillRule: rule });
  return database.getTemplate(template.id);
}

function buildGenerationConfig(main, templateId) {
  const config = main.getTemplateMappingConfig(templateId);
  return main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
}

function generate(main, templateId, sourcePath, outputPath) {
  const generationConfig = buildGenerationConfig(main, templateId);
  const mapped = main.buildMappedRowsForFile({ config: generationConfig, inputFilePath: sourcePath });
  const exportRows = buildDetailExportRows(mapped);
  writeWorkbookRows({ rows: exportRows, outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  const index = (name) => exported.header.indexOf(name);
  const amount = (value) => (value === '' ? '' : Number(value));
  // 回读的日期为 Excel 序列值，日期取写出前的导出行，其余取回读值
  const dateIndex = exportRows[0].indexOf('BillDate');
  return {
    mapped,
    result: {
      rule: generationConfig.crossSheetBackfillRule,
      detail: exported.rows.map((row, rowIndex) => [
        exportRows[rowIndex + 1][dateIndex],
        row[index('MerchantId')],
        row[index('Currency')],
        amount(row[index('Credit Amount')]),
        amount(row[index('Debit Amount')]),
        row[index('Remark')]
      ]),
      sourceRows: mapped.rowMetas.map((meta) => meta.sourceRowNumber),
      stats: mapped.crossSheetBackfillStats || null,
      issues: (mapped.issues || [])
        .filter((issue) => String(issue.type).startsWith('cross-sheet-backfill'))
        .map((issue) => (issue.type === 'cross-sheet-backfill-skipped'
          ? [issue.type, issue.rowNumber, issue.reason, issue.matchValue, issue.matchKey || '']
          : [issue.type, issue.rowNumber, issue.date, issue.prevDate, issue.nextDate]))
    }
  };
}

function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  const seed = openDatabase(dbPath);
  const template = seed.upsertTemplate({ name: '旧库模板', sourceFileName: 'legacy.xlsx', headers: HEADERS });
  seed.db.exec('ALTER TABLE templates DROP COLUMN cross_sheet_backfill_rule_json;');
  assertTrue(!hasColumn(seed.db, 'templates', 'cross_sheet_backfill_rule_json'), '① 构造旧库：无 cross_sheet_backfill_rule_json 列');
  closeDatabase(seed);

  const upgraded = openDatabase(dbPath);
  assertTrue(hasColumn(upgraded.db, 'templates', 'cross_sheet_backfill_rule_json'), '① 启动补 cross_sheet_backfill_rule_json 列');
  const loaded = upgraded.getTemplate(template.id);
  assertEq([loaded.name, loaded.headers, loaded.crossSheetBackfillRule], ['旧库模板', HEADERS, null], '① 模板保留，回填规则为空');
  closeDatabase(upgraded);

  const again = openDatabase(dbPath);
  assertEq(again.getTemplate(template.id).crossSheetBackfillRule, null, '① 重复启动无副作用');
  closeDatabase(again);
}

function verifyStorage(database) {
  const template = defineTemplate(database, '存储模板', {
    rule: {
      ...RULE,
      // Sheet 名按原文保存（工作簿可同时有「USD」与「USD 」两张表），其他字段去首尾空白
      sourceSheetName: 'USD ',
      matchMode: 'unknown',
      sourceDateOrder: 'YMD',
      matchField: ' Transaction Description ',
      rowRules: [
        { conditions: [{ field: ' ValueDate ', op: '空值', value: '' }, { field: '', op: '等于', value: '' }] },
        { conditions: [{ field: '', op: '包含', value: '' }] }
      ],
      backfillFields: [...RULE.backfillFields, { targetField: '', sourceField: '' }]
    }
  });
  const STORED_RULE = { ...RULE, sourceSheetName: 'USD ' };
  assertEq(template.crossSheetBackfillRule, STORED_RULE,
    '② 随映射保存：规则规范化后落库（字段去空白、Sheet 名保留原文、空条件与空回填行忽略、未知配对方式 / 日期格式取默认）');
  assertTrue(
    database.getTemplateMappings(template.id).mappings.some((mapping) => mapping.templateField === TOGGLE && mapping.mappedField === '是'),
    '② 「跨 Sheet 回填」开关存为映射行'
  );
  assertEq(database.listTemplates().find((item) => item.id === template.id).crossSheetBackfillRule, STORED_RULE, '② 模板列表带规则');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, {});
  assertEq(database.getTemplate(template.id).crossSheetBackfillRule, STORED_RULE, '② 未带规则的映射保存不改已存规则');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, { crossSheetBackfillRule: {} });
  assertEq(database.getTemplate(template.id).crossSheetBackfillRule, null, '② 传 {} 时清空规则');

  const overwritten = defineTemplate(database, '覆盖模板');
  database.upsertTemplate({ name: '覆盖模板', sourceFileName: 'new.xlsx', headers: ['日期', '金额'] });
  assertEq(database.getTemplate(overwritten.id).crossSheetBackfillRule, null, '② 模板包覆盖导入（表头被覆盖）时清空规则');
}

function verifyGeneration(dir, database, main) {
  const sourcePath = path.join(dir, 'ngn-usd.xlsx');
  writeSource(sourcePath);
  const template = defineTemplate(database, '回填模板');

  // 按金额识别用的币种代码取自币种映射表，与输出 Currency 是否经映射表无关（固定币种时同样加载，含 USDT 等非三字母代码）
  const fixedCurrencyTemplate = database.upsertTemplate({ name: '固定币种回填模板', sourceFileName: 'fixed.xlsx', headers: HEADERS });
  database.saveMappings(fixedCurrencyTemplate.id, mappingsWith().map((mapping) => (mapping.templateField === 'Currency'
    ? { templateField: 'Currency', mappedField: `${FIXED_FIELD_VALUE_PREFIX}NGN`, mappedFields: [] }
    : mapping)), [], [], 'auto', null, { crossSheetBackfillRule: RULE });
  const fixedConfig = buildGenerationConfig(main, fixedCurrencyTemplate.id);
  assertEq([fixedConfig.currencyMappings.length, ['USD', 'MOP', 'USDT'].map((code) => fixedConfig.crossSheetBackfillCurrencyCodes.includes(code))],
    [0, [true, true, true]], '② 固定币种时输出不加载币种映射表，按金额识别的币种代码仍取自映射表');

  const first = generate(main, template.id, sourcePath, path.join(dir, 'out-1.xlsx'));
  assertEq(first.result, {
    rule: RULE,
    detail: EXPECTED_DETAIL,
    sourceRows: [2, 3, 4, 5, 6, 8],
    stats: { targetRows: 4, backfilledRows: 3, skippedRows: 1, sourceSheetName: 'USD', skippedTransactionRowNumbers: [7] },
    issues: [
      ['cross-sheet-backfill-skipped', 7, 'no-source-row', 'Trade - $99', '99.00'],
      ['cross-sheet-backfill-date-out-of-range', 5, '2026-10-05', '2026-09-27', '2026-09-28']
    ]
  }, '③ 回读导出：同金额按顺序一对一配对，日期 / 渠道回填，币种补 NGN，配不上的第 7 行跳过，第 5 行日期越界只提示');
  assertEq(first.mapped.crossSheetBackfillPatches.map((patch) => [
    patch.rowNumber,
    patch.sourceRowNumber,
    patch.cells.map((cell) => `${cell.field}@${cell.columnIndex}=${cell.value}(${cell.kind})`)
  ]), [
    [3, 3, ['Currency@5=NGN(value)', 'ValueDate@0=2026-09-26(date)', 'Channel@6=FX-01(value)', 'Channel OrderNo@7=O-1(value)']],
    [5, 4, ['Currency@5=NGN(value)', 'ValueDate@0=2026-10-05(date)', 'Channel@6=FX-02(value)', 'Channel OrderNo@7=O-2(value)']],
    [8, 5, ['Currency@5=NGN(value)', 'ValueDate@0=2026-09-29(date)', 'Channel@6=FX-03(value)', 'Channel OrderNo@7=O-3(value)']]
  ], '③ 补丁：主表物理行号 ← 来源表物理行号（标题行之后），列下标按模板表头，币种补值也进补丁');
  const fingerprint = computeFileFingerprint(sourcePath);
  const source = first.mapped.crossSheetBackfillSource;
  assertEq([source.mainSheetName, source.columnOffset, source.size, source.sha256],
    ['NGN', 1, fingerprint.size, fingerprint.sha256], '③ 源文件信息：主表名、物理列偏移（表格从 B 列开始）与导入时指纹');

  const detailLines = first.mapped.issues.length ? main.buildImportWarningDetailLines(first.mapped.issues) : [];
  assertEq(detailLines, [
    '以下行命中「跨 Sheet 回填」的待回填行条件但未能回填，已跳过，未写入导出的明细账单：',
    '「ngn-usd.xlsx」第7行，Transaction Description="Trade - $99"，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有「Credit Amount」为 99.00 且未被使用的行）',
    '以下行「跨 Sheet 回填」的账单日期不在前后相邻交易的日期之间，未因此拦截（是否写入明细仍按「过滤账单」等后续处理），请人工核对配对是否正确：',
    '「ngn-usd.xlsx」第5行，回填日期 2026-10-05，前一笔 2026-09-27，后一笔 2026-09-28'
  ], '③ 错误报告逐行列出跳过原因与日期越界');
  const message = main.buildImportWarningMessage({ warnings: first.mapped.issues, balanceReady: false, balanceRequested: false });
  assertTrue(message.includes('跨 Sheet 回填：1行未配上，已跳过') && message.includes('跨 Sheet 回填：1行回填日期不在相邻交易日期之间，请核对'),
    '③ 导入结果提示条数');

  const second = generate(main, template.id, sourcePath, path.join(dir, 'out-1b.xlsx'));
  assertEq(second.result, first.result, '③ 重复生成结果一致（「已使用」只在单次运行内有效）');

  database.saveMappings(template.id, mappingsWith({ enabled: false }), [], [], 'auto', null, {});
  const disabledConfig = buildGenerationConfig(main, template.id);
  const disabled = main.buildMappedRowsForFile({ config: disabledConfig, inputFilePath: sourcePath });
  assertEq([disabledConfig.crossSheetBackfillRule, disabled.crossSheetBackfillStats || null, disabled.rowMetas.map((meta) => meta.sourceRowNumber)],
    [null, null, [2, 3, 4, 5, 6, 7, 8]], '③ 未勾选：不下发规则、不回填，待回填行照常进入映射');
  assertEq(database.getTemplate(template.id).crossSheetBackfillRule, RULE, '③ 未勾选时已存规则保留');
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, {});

  const reject = (name, rule, filePath = sourcePath) => {
    const rejected = defineTemplate(database, name, { rule });
    const error = captureError(() => main.buildMappedRowsForFile({ config: buildGenerationConfig(main, rejected.id), inputFilePath: filePath }));
    return [error && error.code, error && error.message];
  };
  const [missingCode, missingMessage] = reject('无规则模板', {});
  assertEq([missingCode, /已勾选原始账单预处理「跨 Sheet 回填」，但规则未设置完整/.test(missingMessage)],
    ['CROSS_SHEET_BACKFILL_MISSING', true], '③ 勾选但规则不完整时拒绝生成');
  assertEq(reject('缺来源表模板', { ...RULE, sourceSheetName: 'EUR' }),
    ['FILE_READ', '跨 Sheet 回填：原始账单中没有名为「EUR」的 Sheet'], '③ 有待回填行但来源 Sheet 不存在时拒绝');
  assertEq(reject('缺来源字段模板', { ...RULE, sourceMatchField: 'Credit Amt' }),
    ['FILE_READ', '跨 Sheet 回填：来源 Sheet「USD」中没有同时包含「Credit Amt」「ValueDate」「Channel」「Channel OrderNo」的表头行'],
    '③ 来源 Sheet 缺字段时拒绝');
  // 保存时会拦（见 ⑤），这里绕过保存校验直接落库，验证生成时按实际生效映射再校验
  assertEq(reject('回填金额列模板', { ...RULE, backfillFields: [...RULE.backfillFields, { targetField: 'Debit Amount', sourceField: 'Credit Amount' }] }),
    ['FILE_READ', '跨 Sheet 回填：「Debit Amount」用于发生额、余额、币种或账户映射，不能作为回填字段'], '③ 回填目标为发生额所用的源列时拒绝生成');
  assertEq(reject('回填账户列模板', { ...RULE, backfillFields: [...RULE.backfillFields, { targetField: 'Account', sourceField: 'Channel' }] }),
    ['FILE_READ', '跨 Sheet 回填：「Account」用于发生额、余额、币种或账户映射，不能作为回填字段'], '③ 回填目标为 MerchantId 所用的源列时拒绝生成');

  const noTargetPath = path.join(dir, 'no-target.xlsx');
  writeSource(noTargetPath, { mainRows: [MAIN_ROWS[0], MAIN_ROWS[2]], withUsd: false });
  const noTarget = generate(main, defineTemplate(database, '无待回填行模板').id, noTargetPath, path.join(dir, 'out-2.xlsx'));
  assertEq([noTarget.result.stats, noTarget.result.sourceRows, noTarget.mapped.crossSheetBackfillSource || null],
    [{ targetRows: 0, backfilledRows: 0, skippedRows: 0, sourceSheetName: '', skippedTransactionRowNumbers: [] }, [2, 3], null],
    '③ 没有待回填行时不读来源 Sheet（工作簿中没有 USD 也照常生成）');
  return { template, sourcePath, first };
}

async function readBackfilledWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ngn = workbook.getWorksheet('NGN');
  const usd = workbook.getWorksheet('USD');
  const dateCell = (address) => {
    const cell = ngn.getCell(address);
    return cell.value instanceof Date ? [cell.value.toISOString().slice(0, 10), cell.numFmt] : [cell.value, cell.numFmt || ''];
  };
  return {
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
    row3: [dateCell('B3'), ngn.getCell('G3').value, ngn.getCell('H3').value, ngn.getCell('I3').value],
    row5: [dateCell('B5'), ngn.getCell('G5').value, ngn.getCell('H5').value, ngn.getCell('I5').value],
    row7: [ngn.getCell('B7').value, ngn.getCell('G7').value, ngn.getCell('H7').value],
    row8: [dateCell('B8'), ngn.getCell('G8').value, ngn.getCell('H8').value, ngn.getCell('I8').value],
    untouched: [ngn.getCell('B2').value, ngn.getCell('C3').value, ngn.getCell('D3').value],
    usd: [usd.getCell('A1').value, usd.getCell('B3').value, usd.getCell('C5').value]
  };
}

async function verifyBackfillExport(dir, database, main, { template, sourcePath, first }) {
  // 同一文件按大账号分段成多个会话条目时只导出一份；没有补丁的条目不导出
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir);
  const plainPath = path.join(dir, 'plain.xlsx');
  writeSource(plainPath, { mainRows: [MAIN_ROWS[0]], withUsd: false });
  const plain = main.buildMappedRowsForFile({ config: buildGenerationConfig(main, defineTemplate(database, '无补丁模板').id), inputFilePath: plainPath });
  const session = createStatementImportSession({ templateId: template.id, templateName: '回填模板' });
  let entrySeq = 0;
  const buildEntryId = () => `entry-${++entrySeq}`;
  appendStatementSessionImport({
    buildBatchId: () => 'batch-1',
    lastGeneratedExports: new Map(),
    session,
    fileEntries: [
      buildStatementFileEntry({ buildEntryId, detailRows: first.mapped, filePath: sourcePath }),
      buildStatementFileEntry({ buildEntryId, detailRows: first.mapped, filePath: sourcePath }),
      buildStatementFileEntry({ buildEntryId, detailRows: plain, filePath: plainPath })
    ]
  });
  const items = main.collectCrossSheetBackfillExportItems(session, 'current');
  assertEq(items.map((item) => [item.sourceFilePath, item.patches.length, item.source.sha256]),
    [[path.resolve(sourcePath), 3, first.mapped.crossSheetBackfillSource.sha256]], '④ 会话条目按文件去重，只取有补丁的文件（补丁随会话缓存）');

  const detailPath = path.join(exportDir, '明细.xlsx');
  fs.writeFileSync(path.join(exportDir, 'ngn-usd_回填.xlsx'), 'occupied');
  const outputPaths = allocateCrossSheetBackfillOutputPaths({ directory: exportDir, sourceFilePaths: [sourcePath], reservedPaths: [detailPath] });
  assertEq(outputPaths.map((item) => path.basename(item)), ['ngn-usd_回填(1).xlsx'], '④ 同名文件已存在时追加序号，不覆盖');

  activityLog.length = 0;
  const exported = await main.exportCrossSheetBackfillWorkbooks(items, outputPaths);
  assertEq([exported.lines, exported.results.map((item) => [item.status, item.cellCount, item.converted])],
    [['回填后的原始账单已导出：ngn-usd_回填(1).xlsx'], [['success', 12, false]]], '④ 写出回填后的原始账单并提示文件名');
  assertEq(activityLog.map((entry) => [entry.level, entry.message]), [['info', '导出回填后的原始账单']], '④ 写入活动日志');

  const backfilled = await readBackfilledWorkbook(outputPaths[0]);
  assertEq(backfilled, {
    sheetNames: ['NGN', 'USD'],
    row3: [['2026-09-26', 'dd/mm/yyyy'], 'NGN', 'FX-01', 'O-1'],
    row5: [['2026-10-05', 'dd/mm/yyyy'], 'NGN', 'FX-02', 'O-2'],
    row7: [null, null, null],
    row8: [['2026-09-29', 'dd/mm/yyyy'], 'NGN', 'FX-03', 'O-3'],
    untouched: ['21/09/2026', 'Trade - $65.45', 90000],
    usd: ['USD 账户流水（合成数据）', 65.45, 'FX-03']
  }, '④ 回读回填后的工作簿：只改主表被回填的单元格（日期为真日期 dd/mm/yyyy），配不上的行不动，USD sheet 保留');

  const reimported = generate(main, template.id, outputPaths[0], path.join(dir, 'out-reimport.xlsx'));
  assertEq([reimported.result.detail, reimported.result.sourceRows, reimported.result.stats, reimported.result.issues,
    reimported.mapped.crossSheetBackfillPatches, reimported.mapped.crossSheetBackfillSource || null], [
    EXPECTED_DETAIL,
    [2, 3, 4, 5, 6, 8],
    { targetRows: 1, backfilledRows: 0, skippedRows: 1, sourceSheetName: 'USD', skippedTransactionRowNumbers: [7] },
    [['cross-sheet-backfill-skipped', 7, 'no-source-row', 'Trade - $99', '99.00']],
    [],
    null
  ], '④ 回填后的文件用同一模板再导入：本例来源行充足，明细与首次相同，只剩配不上的第 7 行仍是待回填行');

  // 源文件在导入后变化：不写出并提示重新导入；明细不受影响（由调用方照常导出）
  const changedPath = path.join(dir, 'ngn-usd-changed.xlsx');
  writeSource(changedPath);
  const changedMapped = main.buildMappedRowsForFile({ config: buildGenerationConfig(main, template.id), inputFilePath: changedPath });
  const changedItem = { sourceFilePath: changedPath, patches: changedMapped.crossSheetBackfillPatches, source: changedMapped.crossSheetBackfillSource };
  assertTrue(main.isCrossSheetBackfillSourceUnchanged(changedItem), '④ 未变化时指纹一致');
  writeSource(changedPath, { mainRows: [...MAIN_ROWS, ['30/09/2026', 'Transfer in', '', 1, 'NGN001', 'NGN', 'NIP', 'N-4']] });
  assertTrue(!main.isCrossSheetBackfillSourceUnchanged(changedItem), '④ 追加行后指纹不一致');
  const changedOutput = path.join(exportDir, 'ngn-usd-changed_回填.xlsx');
  activityLog.length = 0;
  const changedExport = await main.exportCrossSheetBackfillWorkbooks([changedItem], [changedOutput]);
  assertEq([changedExport.lines, fs.existsSync(changedOutput), activityLog.map((entry) => entry.level)], [
    ['原始账单在导入后已变化，请重新导入：ngn-usd-changed.xlsx（未导出回填后的原始账单）'], false, ['warning']
  ], '④ 执行时源文件已变化：不写出，提示重新导入（部分失败写入 warning 日志）');
  const preparedChanged = await main.exportCrossSheetBackfillWorkbooks([], [], [changedItem]);
  assertEq(preparedChanged.lines, ['原始账单在导入后已变化，请重新导入：ngn-usd-changed.xlsx（未导出回填后的原始账单）'],
    '④ 准备阶段已排除的变化文件同样提示');
  fs.rmSync(changedPath);
  assertTrue(!main.isCrossSheetBackfillSourceUnchanged(changedItem), '④ 源文件已删除时视为已变化');
}

function verifyStaleReferences(database, main) {
  const template = defineTemplate(database, '更新模板');
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const shrunk = HEADERS.filter((header) => header !== 'Transaction Description' && header !== 'Channel OrderNo');
  const input = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(formatFieldReferenceLines(tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(input), shrunk)), [
    '原始账单预处理 · 跨 Sheet 回填 · 本表配对字段 ← Transaction Description',
    '原始账单预处理 · 跨 Sheet 回填 · 回填字段第 3 行 ← Channel OrderNo'
  ], '⑤ 删掉本表配对字段与回填目标字段：真实映射配置收集到的失效引用');
  const blocked = captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '更新模板', headers: shrunk }, input));
  assertEq(blocked && blocked.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '⑤ 生成前拦截');

  database.saveMappings(template.id, mappingsWith({ enabled: false }), [], [], 'auto', null, {});
  const inactiveInput = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(formatFieldReferenceLines(tools.findStaleFieldReferences(tools.collectTemplateFieldReferences(inactiveInput), shrunk)), [
    '原始账单预处理 · 跨 Sheet 回填 · 本表配对字段 ← Transaction Description（未启用）',
    '原始账单预处理 · 跨 Sheet 回填 · 回填字段第 3 行 ← Channel OrderNo（未启用）'
  ], '⑤ 未勾选时标为未启用');
  assertEq(captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: '更新模板', headers: shrunk }, inactiveInput)), null,
    '⑤ 未勾选时不拦截生成');

  // 保存校验口径（映射弹窗【保存】调用同一组函数）：回填目标不能是发生额 / 币种 / MerchantId 所用的源列
  const excludedTargetFields = main.collectCrossSheetBackfillExcludedTargets(template.id, mappingsWith(), HEADERS);
  assertEq(excludedTargetFields.slice().sort(), ['Account', 'Credit Amount', 'Currency', 'Debit Amount'], '⑤ 保存时排除的回填目标列（含 MerchantId 所用的 Account）');
  const saveError = captureError(() => validateCrossSheetBackfillRule(
    { ...RULE, backfillFields: [...RULE.backfillFields, { targetField: 'Currency', sourceField: 'Channel' }] },
    HEADERS,
    { excludedTargetFields }
  ));
  assertEq(saveError && saveError.message, '跨 Sheet 回填：「Currency」用于发生额、余额、币种或账户映射，不能作为回填字段', '⑤ 保存时拒绝回填币种列');
  const accountError = captureError(() => validateCrossSheetBackfillRule(
    { ...RULE, backfillFields: [...RULE.backfillFields, { targetField: 'Account', sourceField: 'Channel' }] },
    HEADERS,
    { excludedTargetFields }
  ));
  assertEq(accountError && accountError.message, '跨 Sheet 回填：「Account」用于发生额、余额、币种或账户映射，不能作为回填字段', '⑤ 保存时拒绝回填账户列');
  // 拆分 / 合并明细账单启用时，已保存的拆分行读取的收支、币种列同样不能回填（拆分行在其弹窗中保存，映射保存时一并校验）
  database.saveBillSplitRowCount(template.id, 1);
  database.saveBillSplitRow(template.id, {
    seqNo: 1, currencySourceField: 'Channel OrderNo', creditSourceField: 'Channel', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  });
  const splitMappings = mappingsWith().concat([
    { templateField: CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD, mappedField: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION, mappedFields: [] }
  ]);
  assertEq(main.collectCrossSheetBackfillExcludedTargets(template.id, splitMappings, HEADERS).slice().sort(),
    ['Account', 'Channel', 'Channel OrderNo', 'Credit Amount', 'Currency', 'Debit Amount'], '⑤ 启用拆分时排除已保存拆分行的收支 / 币种列');
  assertEq(main.collectCrossSheetBackfillExcludedTargets(template.id, mappingsWith(), HEADERS).slice().sort(),
    ['Account', 'Credit Amount', 'Currency', 'Debit Amount'], '⑤ 未启用拆分时拆分行不生效，不排除');
  database.saveBillSplitRowCount(template.id, 0);
  // 受保护的目标字段选「字段筛选特征值」时，实际读取的是特征值的筛选字段，同样不能回填（与生成时同口径）
  database.saveTemplateFeatureFilters(template.id, normalizeFeatureFilterList([
    { name: '渠道单号', sourceField: 'Channel OrderNo', separator: 'space', length: 3, letterPrefixCount: 1, digitsOnly: false, sample: 'O-1' }
  ], { headers: HEADERS }));
  const featureId = String(database.getTemplate(template.id).featureFilters[0].id);
  const featureMappings = mappingsWith().map((mapping) => (mapping.templateField === 'Credit Amount'
    ? { templateField: 'Credit Amount', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: [featureId] }
    : mapping));
  assertEq(main.collectCrossSheetBackfillExcludedTargets(template.id, featureMappings, HEADERS).slice().sort(),
    ['Account', 'Channel OrderNo', 'Currency', 'Debit Amount'], '⑤ 发生额选特征值时排除特征值的筛选字段');
  database.saveTemplateFeatureFilters(template.id, []);
}

// 报错文件保留配对值；活动日志不写配对值（可能是账号、订单号或带客户信息的描述）；多个文件时各行标明所属文件
function verifyWarningDetailLines(main) {
  const warnings = [
    { type: 'cross-sheet-backfill-skipped', rowNumber: 7, reason: 'no-source-row', reasonText: '来源 Sheet 中没有可配对的行',
      matchField: 'Transaction Description', matchValue: 'Trade - $99 ACCT 0123456789', matchKey: '99.00', sourceSheetName: 'USD',
      sourceMatchField: 'Credit Amount', sourceFileName: 'A.xlsx' },
    { type: 'cross-sheet-backfill-skipped', rowNumber: 7, reason: 'source-date-invalid', reasonText: '来源日期无法识别',
      matchField: 'Transaction Description', matchValue: 'Trade - $5', sourceSheetName: 'USD', sourceMatchField: 'Credit Amount',
      sourceRowNumber: 3, sourceFileName: 'B.xlsx' }
  ];
  const reportLines = main.buildImportWarningDetailLines(warnings);
  assertEq(reportLines.slice(1), [
    '「A.xlsx」第7行，Transaction Description="Trade - $99 ACCT 0123456789"，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有「Credit Amount」为 99.00 且未被使用的行）',
    '「B.xlsx」第7行，Transaction Description="Trade - $5"，原因：来源日期无法识别（来源 Sheet「USD」第3行）'
  ], '⑦ 报错文件：各行标明所属文件，保留配对值');
  const logLines = main.buildImportWarningDetailLines(warnings, { forLog: true });
  assertEq(logLines.slice(1), [
    '「A.xlsx」第7行，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有可配对且未被使用的行）',
    '「B.xlsx」第7行，原因：来源日期无法识别（来源 Sheet「USD」第3行）'
  ], '⑦ 活动日志：不写配对值');
  assertTrue(!logLines.join('\n').includes('0123456789'), '⑦ 活动日志不含配对原值');
  assertEq(main.buildImportWarningDetailLines([warnings[0]]).slice(1), [
    '「A.xlsx」第7行，Transaction Description="Trade - $99 ACCT 0123456789"，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有「Credit Amount」为 99.00 且未被使用的行）'
  ], '⑦ 只有一个文件产生告警时同样标明文件（同批可能还有别的文件）');
  // 第三十轮审查：会话中先后导入不同目录下的同名账单，按路径末尾足以区分的几级标明（不写完整路径），唯一的文件名照旧只写文件名
  const sameName = (folder, amount) => ({
    type: 'cross-sheet-backfill-skipped', rowNumber: 8, reason: 'no-source-row', reasonText: '来源 Sheet 中没有可配对的行',
    matchField: 'Transaction Description', matchValue: `Trade - $${amount}`, matchKey: `${amount}.00`, sourceSheetName: 'USD',
    sourceMatchField: 'Credit Amount', sourceFileName: 'Statement.xlsx', sourceFilePath: path.join(os.tmpdir(), 'statements', folder, 'Statement.xlsx')
  });
  const labelled = main.buildImportWarningDetailLines([
    sameName('九月', 1), sameName('十月', 2), { ...warnings[0], sourceFilePath: path.join(os.tmpdir(), 'statements', '九月', 'A.xlsx') }
  ], { forLog: true }).slice(1);
  assertEq(labelled.map((line) => line.slice(0, line.indexOf('第'))), ['「九月/Statement.xlsx」', '「十月/Statement.xlsx」', '「A.xlsx」'],
    '⑦ 同名账单按路径末尾足以区分的几级标明，日志不写完整路径');
  assertTrue(!labelled.join(' ').includes(os.tmpdir()), '⑦ 告警与日志不含完整路径');
}

// 全部交易都未能回填（审查回归）：生成因没有有效账单日期失败，失败报告仍逐行列出回填跳过；活动日志不写配对值
function verifyAllSkippedReport(dir, main, template) {
  const sourcePath = path.join(dir, 'all-skipped.xlsx');
  writeSource(sourcePath, { mainRows: [MAIN_ROWS[5]] });
  const config = buildGenerationConfig(main, template.id);
  const mapped = main.buildMappedRowsForFile({ config, inputFilePath: sourcePath });
  const generation = createStatementGenerationHelpers({
    appendActivityLogEntry: () => {},
    buildDetailExportRows,
    buildFieldIndexMap,
    buildImportWarningDetailLines: main.buildImportWarningDetailLines,
    buildMappedRowsForFile: main.buildMappedRowsForFile,
    buildStatementGenerationConfig: main.buildStatementGenerationConfig,
    cloneRowsWithMetadata,
    FileValidationError,
    mergeMappedDetailRows,
    normalizeCell: (value) => String(value == null ? '' : value).trim(),
    normalizeInputFilePaths,
    parseRequiredBillDates,
    resolveSinglePreparedFieldValue
  });
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: [buildStatementFileEntry({ buildEntryId: () => 'entry-all-skipped', detailRows: mapped, filePath: sourcePath })]
  });
  let caught = null;
  try {
    generation.generateStatementFiles({ config, preparedBatch });
  } catch (error) {
    caught = error;
  }
  assertEq(caught && [caught.message, caught.detailLines, caught.logDetailLines], [
    '导入文件中没有账号存在交易数据（「跨 Sheet 回填」跳过了1行，请导出报错文件核对）',
    [
      '以下行命中「跨 Sheet 回填」的待回填行条件但未能回填，已跳过，未写入导出的明细账单：',
      '「all-skipped.xlsx」第2行，Transaction Description="Trade - $99"，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有「Credit Amount」为 99.00 且未被使用的行）'
    ],
    [
      '以下行命中「跨 Sheet 回填」的待回填行条件但未能回填，已跳过，未写入导出的明细账单：',
      '「all-skipped.xlsx」第2行，原因：来源 Sheet 中没有可配对的行（来源 Sheet「USD」中没有可配对且未被使用的行）'
    ]
  ], '⑨ 全部交易未能回填：失败报告逐行列出跳过原因（报错文件带配对值，活动日志不带）');
}

// 不承诺再导入一致（用户决定，2026-11-21）：两笔同金额换汇只有一笔买入，首次导入回填第一笔、跳过第二笔；
//   导出回填后的原始账单再导入时，第一笔已有日期按普通行处理、不消耗那笔买入，第二笔配上它——结果与首次不同，
//   用户指南提示再导入应使用银行原始账单。本用例固定这一已知边界，避免误以为往返一致。
async function verifySameAmountRoundTrip(dir, main, template) {
  const sourcePath = path.join(dir, 'same-amount.xlsx');
  writeSource(sourcePath, { mainRows: [MAIN_ROWS[0], MAIN_ROWS[1], MAIN_ROWS[2], MAIN_ROWS[6]], usdRows: [USD_ROWS[0]] });
  const first = generate(main, template.id, sourcePath, path.join(dir, 'out-same-amount.xlsx'));
  assertEq([first.result.detail, first.result.issues], [[
    ['2026-09-21', 'NGN001', 'NGN', 1000, '', 'NIP'],
    ['2026-09-26', 'NGN001', 'NGN', '', 90000, 'FX-01'],
    ['2026-09-27', 'NGN001', 'NGN', '', 50, 'POS']
  ], [['cross-sheet-backfill-skipped', 5, 'no-source-row', 'Trade - $65.45', '65.45']]], '⑧ 同额来源不足：首次导入回填第一笔、跳过第二笔');
  const item = { sourceFilePath: sourcePath, patches: first.mapped.crossSheetBackfillPatches, source: first.mapped.crossSheetBackfillSource };
  const outputPath = path.join(dir, 'same-amount_回填.xlsx');
  const exported = await main.exportCrossSheetBackfillWorkbooks([item], [outputPath]);
  assertEq(exported.results.map((result) => result.status), ['success'], '⑧ 写出回填后的原始账单');
  const second = generate(main, template.id, outputPath, path.join(dir, 'out-same-amount-reimport.xlsx'));
  assertEq([second.result.detail, second.result.issues, second.mapped.crossSheetBackfillPatches.map((patch) => patch.rowNumber)], [[
    ['2026-09-21', 'NGN001', 'NGN', 1000, '', 'NIP'],
    ['2026-09-26', 'NGN001', 'NGN', '', 90000, 'FX-01'],
    ['2026-09-27', 'NGN001', 'NGN', '', 50, 'POS'],
    ['2026-09-26', 'NGN001', 'NGN', '', 90000, 'FX-01']
  ], [['cross-sheet-backfill-date-out-of-range', 5, '2026-09-26', '2026-09-27', '']], [5]],
  '⑧ 再导入回填后的文件：已回填的第一笔按普通行处理，第二笔配上同一笔买入（不承诺与首次一致），日期提示提醒核对');
}

function verifyBundle(dir, database, main, sourcePath) {
  const template = defineTemplate(database, '模板包模板');
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '模板包模板');
  assertEq(entry.crossSheetBackfillRule, RULE, '⑥ 导出条目带回填规则');
  assertEq([
    { mappings: [] },
    { mappings: [], crossSheetBackfillRule: {} },
    entry,
    { mappings: mappingsWith() },
    { mappings: [], crossSheetBackfillRule: RULE }
  ].map((item) => main.resolveTemplateBundleVersion([item])),
  [CONSTANTS.BASE_BUNDLE_VERSION, CONSTANTS.BASE_BUNDLE_VERSION, 10, 10, 10], '⑥ 用到回填（勾选或有规则）时写 v10，未用到时版本不变');
  assertEq(CONSTANTS.SUPPORTED_BUNDLE_VERSION, 10, '⑥ 当前支持读取 v10');

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.crossSheetBackfillRule, RULE, '⑥ 读包保留回填规则');

  // 按导入口径保存（覆盖同名模板 → 保存映射时带入规则；包内没有规则时传 {} 清空）
  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: entry.sourceFileName, headers: entry.headers });
  target.saveMappings(imported.id, readEntry.mappings, [], [], 'auto', null, {
    preserveOwn: false,
    crossSheetBackfillRule: readEntry.crossSheetBackfillRule || {}
  });
  assertEq(target.getTemplate(imported.id).crossSheetBackfillRule, RULE, '⑥ 导入后回填规则一致');
  assertEq(
    generate(targetMain, imported.id, sourcePath, path.join(dir, 'out-imported.xlsx')).result,
    generate(main, template.id, sourcePath, path.join(dir, 'out-origin.xlsx')).result,
    '⑥ 导入后的模板生成结果与原模板一致'
  );
  closeDatabase(target);
}

// v3.2.21 第二十九轮审查：内容为 ODS 的账单从建模板到导入同一文件——表头只写在属性上（开闭标签之间没有文字）的列，模板保存的表头、
//   按文件名匹配的两个预检与正式映射同一取值规则；来源表名含需转义字符（Cash & Bank）时按实际名称选中，生成结果与 xlsx 一致
function verifyOdsTemplateRoundTrip(dir, database, main) {
  const workbook = XLSX.utils.book_new();
  const odsHeaders = HEADERS.map((header) => (header === 'Channel OrderNo' ? 'ORDER_HEADER' : header));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([odsHeaders, ...MAIN_ROWS], { origin: 'B1' }), 'NGN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['USD 账户流水（合成数据）'], USD_HEADERS, ...USD_ROWS]), 'Cash & Bank');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const original = '<table:table-cell office:value-type="string"><text:p>ORDER_HEADER</text:p></table:table-cell>';
  const xml = Buffer.from(content.content).toString('utf8');
  assertTrue(xml.includes(original), '⑦ 合成 ODS 含待改写的表头单元格');
  content.content = Buffer.from(xml.replace(original,
    '<table:table-cell office:value-type="string" office:string-value="Channel OrderNo"></table:table-cell>'), 'utf8');
  const odsPath = path.join(dir, 'ngn-usd-ods.xls');
  fs.writeFileSync(odsPath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));

  const headers = main.extractStatementTemplateHeaders(odsPath);
  assertEq(headers, HEADERS, '⑦ 从 ODS 建模板：只写在属性上的表头按原值保存');
  const template = database.upsertTemplate({ name: 'ODS 回填模板', sourceFileName: 'ngn-usd-ods.xls', headers });
  database.saveMappings(template.id, mappingsWith(), [], [], 'auto', null, { crossSheetBackfillRule: { ...RULE, sourceSheetName: 'Cash & Bank' } });
  const saved = database.getTemplate(template.id);
  assertEq([main.matchFileToTemplate(odsPath, [saved]).map((item) => item.name), main.matchesTemplateHeaders(odsPath, saved)],
    [['ODS 回填模板'], true], '⑦ 按文件名匹配的两个预检都能匹配建模板所用的文件自身');
  const generated = generate(main, template.id, odsPath, path.join(dir, 'out-ods.xlsx')).result;
  assertEq([generated.detail, generated.stats && generated.stats.backfilledRows], [EXPECTED_DETAIL, 3],
    '⑦ 按实际表名 Cash & Bank 选中来源表，生成结果与 xlsx 账单一致');
}

async function run() {
  console.log('==== 网银账单 · 原始账单预处理跨 Sheet 回填 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-cross-sheet-backfill-'));
  try {
    verifyMigration(dir);
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    verifyStorage(database);
    const generated = verifyGeneration(dir, database, main);
    await verifyBackfillExport(dir, database, main, generated);
    await verifySameAmountRoundTrip(dir, main, generated.template);
    verifyAllSkippedReport(dir, main, generated.template);
    verifyWarningDetailLines(main);
    verifyStaleReferences(database, main);
    verifyBundle(dir, database, main, generated.sourcePath);
    verifyOdsTemplateRoundTrip(dir, database, main);
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
