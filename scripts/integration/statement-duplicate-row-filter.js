// 网银账单：原始账单预处理「重复账单过滤」（v3.2.19）e2e 集成验证
//   覆盖：真实主库（仓储）+ main.js 中真实的映射校验、生成配置、模板包读写与失效引用函数
//        + 真实 xlsx 读取与写出 + 真实查重 / 确认去重服务与生成辅助（多文件批次、导入结果、重新生成防护）
//   ① 保存：开关存为映射行（勾选 是、未勾 ''），生成配置随之开启；未勾选时不为源行算指纹
//   ② 查重：一次导入的多个文件——同文件内、跨文件的重复（账户相同）列出；账户不同、被「过滤账单」去掉的行不列出；
//      预检暂停，复核结果按组列出文件、行号、账户号、账期与保留 / 去除
//   ③ 确认去重：未确认或摘要不符拒绝生成；确认后每组只保留首行，回读导出的明细与按发生额计算的余额只计保留的行
//   ④ 未勾选：重复行照常全部输出（与改动前一致）
//   ⑤ 导入结果：提示附「已去除重复账单行 N 行」；勾选后不能从源文件重新映射（防止已去除的行回来）
//   ⑥ 模板包：勾选时写 v8，读包保留开关；模板【更新】不把开关值当作源字段引用
//   导入 IPC 的暂停 / 续跑接入点由 tests/unit/main-process/statement-duplicate-review.test.js 覆盖；
//   UI 由 renderer lifecycle 覆盖。
//
// 用法：node scripts/integration/statement-duplicate-row-filter.js

const fs = require('node:fs');
const { readBigAccountMode, writeBigAccountMode } = require('../../src/backend/big-account-mode-store');
const { readBigAccountOrder } = require('../../src/backend/big-account-order-store');
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
  dropDuplicateSourceRows,
  extractHeaders,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  loadCurrencyMappings,
  LOGIC_VALUE_MIN_FIELDS,
  mapEachCollectingCurrencyBigAccountIssues,
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
  scanDuplicateSourceRows,
  upgradeLegacyFeatureFilter,
  validateBillSplitRowFilterRules,
  validateFeeAmountFormula,
  validateRowFilterRules,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders
} = require('../../src/main-process/template-header-update');
const { createStatementDuplicateReview } = require('../../src/main-process/statement-duplicate-review');
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const { buildFieldIndexMap, deriveBalanceRecords } = require('../../src/main-process/statement-generation-business');
const {
  cloneRowsWithMetadata,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '账号', '交易类型', '币种', '收入', '支出', '摘要'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Balance'];
// 过滤账单：只保留交易类型 = 交易 的行
const KEEP_REAL = [{ seq: 1, conditions: [{ field: '交易类型', op: '等于', value: '交易' }] }];

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
  'SUPPORTED_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION'
]);
const TOGGLE = CONSTANTS.DUPLICATE_ROW_FILTER_MAPPING_FIELD;
const PREPROCESS = CONSTANTS.PREPROCESS_ROW_FILTER_MAPPING_FIELD;

function createMain(database, overrides = {}) {
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
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs',
    'buildDuplicateReviewConfigStamp'
  ], {
    ...CONSTANTS,
    createHash: require('node:crypto').createHash,
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
    normalizeBundleAccountMappings: () => [],
    // 复核指纹计入大账号固定模式与记住的顺序（真实存储，存放在临时目录）
    readBigAccountMode,
    readBigAccountOrder,
    ensureStorageRoot: () => BIG_ACCOUNT_STORAGE_ROOT,
    ...overrides
  });
}

const BIG_ACCOUNT_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-duplicate-row-filter-storage-'));
process.on('exit', () => fs.rmSync(BIG_ACCOUNT_STORAGE_ROOT, { recursive: true, force: true }));

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

function draftMappings({ duplicate = '是', preprocess = '是' } = {}) {
  return [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Currency', mappedField: '币种', mappedFields: [] },
    { templateField: 'Credit Amount', mappedField: '收入', mappedFields: [] },
    { templateField: 'Debit Amount', mappedField: '支出', mappedFields: [] },
    { templateField: PREPROCESS, mappedField: preprocess, mappedFields: [] },
    { templateField: TOGGLE, mappedField: duplicate, mappedFields: [] }
  ];
}

// 按界面【保存】口径：先经 validateTemplateConfiguration 校验，再写库
function saveTemplate(database, main, name, options = {}) {
  const existing = database.listTemplates().find((item) => item.name === name);
  const template = existing || database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  const validated = main.validateTemplateConfiguration({
    template: database.getTemplate(template.id),
    mappings: draftMappings(options),
    enumValues: ENUM_VALUES
  });
  database.saveMappings(template.id, validated.mappings, [], [], 'auto', null, { preprocessRowFilterRules: KEEP_REAL });
  return { template: database.getTemplate(template.id), validated };
}

function generationConfigOf(main, templateId) {
  const config = main.getTemplateMappingConfig(templateId);
  return main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
}

function mapFiles(main, templateId, filePaths) {
  const config = generationConfigOf(main, templateId);
  return filePaths.map((filePath) => ({ filePath, detailRows: main.buildMappedRowsForFile({ config, inputFilePath: filePath }) }));
}

function createReviewService(logs) {
  let seq = 0;
  return createStatementDuplicateReview({
    randomUUID: () => `review-${++seq}`,
    appendActivityLogEntry: (entry) => logs.push(entry),
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    scanDuplicateSourceRows,
    dropDuplicateSourceRows
  });
}

function createGeneration(main, overrides = {}) {
  return createStatementGenerationHelpers({
    ...overrides,
    appendActivityLogEntry: () => {},
    buildFieldIndexMap,
    buildMappedRowsForFile: main.buildMappedRowsForFile,
    buildStatementGenerationConfig: main.buildStatementGenerationConfig,
    cloneRowsWithMetadata,
    FileValidationError,
    mapEachCollectingCurrencyBigAccountIssues,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    resolveSinglePreparedFieldValue
  });
}

// 组批后写出明细并回读；余额按发生额计算（上一日余额 1000）
function exportBatch(generation, config, entries, outputPath) {
  const { detailRows } = generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: entries });
  const exportRows = buildDetailExportRows(detailRows);
  writeWorkbookRows({ rows: exportRows, outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  const index = (name) => exported.header.indexOf(name);
  const amount = (value) => (value === '' ? '' : Number(value));
  const dateIndex = exportRows[0].indexOf('BillDate');
  const balance = deriveBalanceRecords({
    detailRows,
    templateName: '查重模板',
    balanceTemplateFields: ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'],
    mode: 'calculated',
    resolvePreviousBalanceSeed: ({ merchantId, currency }) => ({ merchantId, currency, billDate: '2026-10-31', endBalance: 1000 })
  });
  return {
    detail: exported.rows.map((row, rowIndex) => [
      exportRows[rowIndex + 1][dateIndex],
      row[index('MerchantId')],
      amount(row[index('Credit Amount')]),
      amount(row[index('Debit Amount')])
    ]),
    balances: balance.records.map((row) => [row[3], row[4], Number(row[7])])
  };
}

function verifySave(database, main) {
  const { template, validated } = saveTemplate(database, main, '查重模板');
  const toggleRow = database.getTemplateMappings(template.id).mappings.find((mapping) => mapping.templateField === TOGGLE);
  assertEq([toggleRow && toggleRow.mappedField, validated.usesDuplicateRowFilter, generationConfigOf(main, template.id).duplicateRowFilterEnabled],
    ['是', true, true], '① 勾选：开关存为映射行，生成配置开启');
  const { validated: unknownValue } = saveTemplate(database, main, '查重模板', { duplicate: '随便' });
  assertEq([unknownValue.mappings.find((mapping) => mapping.templateField === TOGGLE).mappedField, unknownValue.usesDuplicateRowFilter],
    ['', false], '① 非「是」的值规范为未勾选');
  saveTemplate(database, main, '查重模板');
  return template;
}

// 文件 A：第 2、4 行重复（同文件）；第 3、5 行内容相同但被「过滤账单」去掉；第 6 行是另一笔
// 文件 B：第 2 行与 A 第 6 行相同（跨文件）；第 3 行内容与 A 第 2 行相同但账户不同（ACC2）
const FILE_A = [
  ['2026-11-01', 'ACC1', '交易', 'USD', '100', '', '货款'],
  ['2026-11-01', 'ACC1', '冻结', 'USD', '', '40', '冻结'],
  ['2026-11-01', 'ACC1', '交易', 'USD', '100', '', '货款'],
  ['2026-11-01', 'ACC1', '冻结', 'USD', '', '40', '冻结'],
  ['2026-11-02', 'ACC1', '交易', 'USD', '', '30', '手续费']
];
const FILE_B = [
  ['2026-11-02', 'ACC1', '交易', 'USD', '', '30', '手续费'],
  ['2026-11-01', 'ACC2', '交易', 'USD', '100', '', '货款']
];

function verifyReviewAndDrop(dir, main, template) {
  const pathA = path.join(dir, 'a.xlsx');
  const pathB = path.join(dir, 'b.xlsx');
  writeSource(pathA, FILE_A);
  writeSource(pathB, FILE_B);
  const logs = [];
  const service = createReviewService(logs);
  const entries = mapFiles(main, template.id, [pathA, pathB]);

  const preview = service.review({ entries, phase: 'preview', templateName: '查重模板' });
  assertEq(preview.status, 'pause', '② 预检发现重复时暂停');
  const context = service.remember({ kind: 'file-import', templateId: template.id, prepared: {}, scan: preview.scan, templateName: '查重模板' });
  const result = service.buildReviewResult(preview.scan, { contextId: context.contextId, reviewKind: 'file-import', templateName: '查重模板' });
  assertEq([result.status, result.totalGroups, result.droppedRowCount], ['duplicate-review', 2, 2], '② 复核结果：2 组、2 行将被去除');
  assertEq(result.groups.map((group) => [group.accountLabel, group.billDate, group.rows.map((row) => [row.fileName, row.sourceRowNumber, row.kept])]), [
    ['ACC1（USD）', '2026-11-01', [['a.xlsx', 2, true], ['a.xlsx', 4, false]]],
    ['ACC1（USD）', '2026-11-02', [['a.xlsx', 6, true], ['b.xlsx', 2, false]]]
  ], '② 同文件内与跨文件的重复列出；账户不同、被过滤账单去掉的行不列出');
  assertEq(logs.at(-1).message, '发现重复账单，等待确认', '② 活动日志记录待确认的重复账单');

  const stale = service.review({ entries, phase: 'execute', prepared: {}, templateName: '查重模板' });
  assertEq([stale.status, stale.result.errorCode], ['stale', 'DUPLICATE_ROWS_REVIEW_STALE'], '③ 未确认时拒绝生成');

  // 续跑时文件路径会重绑为冻结路径：摘要不含路径，仍然一致
  const rebound = entries.map((entry, index) => ({ ...entry, filePath: path.join(dir, `frozen-${index}.xlsx`) }));
  const dropped = service.review({
    entries: rebound,
    phase: 'execute',
    prepared: { duplicateReviewConfirmation: { contextId: context.contextId, digest: context.digest } },
    templateName: '查重模板'
  });
  assertEq([dropped.status, dropped.droppedRowCount], ['dropped', 2], '③ 确认后去除 2 行');
  assertEq(logs.at(-1).message, '已确认过滤重复账单', '③ 活动日志记录确认去除');

  const generation = createGeneration(main);
  const config = generationConfigOf(main, template.id);
  assertEq(exportBatch(generation, config, dropped.entries, path.join(dir, 'out-dropped.xlsx')), {
    detail: [['2026-11-01', 'ACC1', 100, ''], ['2026-11-02', 'ACC1', '', 30], ['2026-11-01', 'ACC2', 100, '']],
    balances: [['ACC1', '2026-11-01', 1100], ['ACC1', '2026-11-02', 1070], ['ACC2', '2026-11-01', 1100]]
  }, '③ 回读导出：每组只保留首行，余额只计保留的行');

  const importResult = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: { warnings: [], detail: { filePath: 'detail.xlsx' }, balance: null, message: '明细账单可导出', fileEntries: dropped.entries },
    templateId: template.id,
    templateName: '查重模板',
    inputFilePaths: [pathA, pathB]
  });
  assertEq([importResult.status, importResult.message, importResult.duplicateDroppedRowCount],
    ['success', '明细账单可导出；已去除重复账单行 2 行', 2], '⑤ 导入结果提示去除的行数');
  // 同批还需处理余额（补录 / 断档等）时，结果同样带上去重行数，原余额提示保留
  const balanceGeneration = createGeneration(main, {
    buildManualBalanceRequiredResult: () => ({ status: 'error', message: '请补录上一账单日余额', manualBalancePromptReady: true }),
    buildBalanceGapConfirmResult: () => ({ status: 'warning', message: '账单日期断档，请确认' })
  });
  assertEq([
    { type: 'balance-seed-required', prompt: {} },
    { type: 'balance-gap-confirm', gaps: [{}] }
  ].map((warning) => {
    const pending = balanceGeneration.buildImportResultFromGeneratedFiles({
      generatedFiles: { warnings: [warning], message: '明细账单可导出', fileEntries: dropped.entries },
      templateId: template.id,
      templateName: '查重模板',
      inputFilePaths: [pathA, pathB]
    });
    return [pending.message, pending.duplicateDroppedRowCount];
  }), [
    ['请补录上一账单日余额；已去除重复账单行 2 行', 2],
    ['账单日期断档，请确认；已去除重复账单行 2 行', 2]
  ], '⑤ 等待补录 / 断档确认的结果也提示去除的行数');
  // 补录后重新生成：generatedFiles 不带 fileEntries，按会话条目算出的去除行数照常附在提示中
  const regenerated = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: { warnings: [], detail: { filePath: 'detail.xlsx' }, balance: { filePath: 'balance.xlsx' }, message: '余额账单已生成',
      duplicateDroppedRowCount: generation.countDuplicateDroppedRows(dropped.entries) },
    templateId: template.id,
    templateName: '查重模板',
    inputFilePaths: [pathA, pathB]
  });
  assertEq([regenerated.message, regenerated.duplicateDroppedRowCount], ['余额账单已生成；已去除重复账单行 2 行', 2],
    '⑤ 补录余额后重新生成的提示仍附去除的行数');

  // 无法核对原文的行（如含公式）保留且不参与查重：生成提示说明有多少行未参与，避免误以为已全部查重
  const formulaPath = path.join(dir, 'formula.xlsx');
  {
    const row = ['2026-11-05', 'ACC1', '交易', 'USD', '10', '', '备注'];
    const sheet = XLSX.utils.aoa_to_sheet([HEADERS, row, row]);
    // 第 2 行另有一列公式（模板表头范围以外）：该行无法核对原文
    sheet.H2 = { t: 'n', f: 'ROW()', v: 2 };
    sheet['!ref'] = 'A1:H3';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    XLSX.writeFile(workbook, formulaPath);
  }
  const formulaEntries = mapFiles(main, template.id, [formulaPath]);
  assertEq(generation.countDuplicateUncheckedRows(formulaEntries), 1, '⑤ 含公式的行无法核对原文，记为未参与查重');
  const uncheckedResult = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: { warnings: [], detail: { filePath: 'detail.xlsx' }, balance: null, message: '明细账单可导出', fileEntries: formulaEntries },
    templateId: template.id,
    templateName: '查重模板',
    inputFilePaths: [formulaPath]
  });
  assertEq([uncheckedResult.message, uncheckedResult.duplicateUncheckedRowCount],
    ['明细账单可导出；1 行无法核对原文，未参与重复账单过滤', 1], '⑤ 生成提示说明未参与查重的行数');

  const regenerate = captureError(() => generation.generateFilesFromRememberedContext({
    template: config.template,
    mappings: main.getTemplateMappingConfig(template.id).exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    selectedBigAccount: null,
    preparedDetailRows: null,
    inputFilePaths: [pathA, pathB]
  }));
  assertEq(regenerate && /无法从源文件重新生成/.test(regenerate.message), true, '⑤ 勾选后不从源文件重新映射（防止去除的行回来）');
  return { pathA, pathB };
}

function verifyToggleOff(dir, database, main, template, { pathA, pathB }) {
  saveTemplate(database, main, '查重模板', { duplicate: '' });
  const entries = mapFiles(main, template.id, [pathA, pathB]);
  assertEq(entries.every((entry) => entry.detailRows.rowMetas.every((meta) => !('sourceRowKey' in meta))), true,
    '④ 未勾选：不为源行算指纹');
  const service = createReviewService([]);
  assertEq(service.review({ entries, phase: 'preview' }).status, 'pass', '④ 未勾选：不暂停');
  assertEq(exportBatch(createGeneration(main), generationConfigOf(main, template.id), entries, path.join(dir, 'out-off.xlsx')).detail, [
    ['2026-11-01', 'ACC1', 100, ''], ['2026-11-01', 'ACC1', 100, ''], ['2026-11-02', 'ACC1', '', 30],
    ['2026-11-02', 'ACC1', '', 30], ['2026-11-01', 'ACC2', 100, '']
  ], '④ 未勾选：重复行照常全部输出');
  saveTemplate(database, main, '查重模板');
}

function verifyBundleAndReferences(dir, database, main, template) {
  const entry = database.listTemplateBundleEntries().find((item) => item.name === template.name);
  assertEq([
    main.resolveTemplateBundleVersion([{ mappings: [] }]),
    main.resolveTemplateBundleVersion([{ mappings: [{ templateField: TOGGLE, mappedField: '是' }] }])
  ], [CONSTANTS.BASE_BUNDLE_VERSION, CONSTANTS.SUPPORTED_BUNDLE_VERSION], '⑥ 勾选时写 v8，未用到时版本不变');
  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.mappings.find((mapping) => mapping.templateField === TOGGLE).mappedField, '是', '⑥ 读包保留开关');

  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const input = main.buildTemplateFieldReferenceInput(main.getTemplateMappingConfig(template.id));
  assertEq(tools.collectTemplateFieldReferences(input).some((reference) => reference.field === '是' || reference.target === TOGGLE), false,
    '⑥ 模板【更新】不把开关值当作源字段引用');
  assertEq(captureError(() => tools.assertTemplateFieldReferencesAvailable({ name: template.name, headers: HEADERS }, input)), null,
    '⑥ 勾选开关不会被生成前的失效引用拦截');
}

// 等待确认期间配置变化须使复核失效：指纹在配置不变时稳定，生成实际使用的配置（如拆分发生额的指定账单序号）变化即不同
function verifyReviewConfigStamp(database, main, template) {
  const first = main.buildDuplicateReviewConfigStamp([template.id]);
  assertEq(main.buildDuplicateReviewConfigStamp([template.id, template.id, 0, 'x']), first, '⑥ 配置不变时复核指纹稳定（去重、忽略无效 ID）');
  const before = database.getBillSplitMeta(template.id);
  database.saveBillSplitMeta(template.id, { signedAmountTargetSeqNos: [2] });
  const changed = main.buildDuplicateReviewConfigStamp([template.id]);
  database.saveBillSplitMeta(template.id, { signedAmountTargetSeqNos: before.signedAmountTargetSeqNos || [] });
  assertEq(changed !== first, true, '⑥ 拆分发生额的指定账单序号变化时复核指纹不同');
  assertEq(main.buildDuplicateReviewConfigStamp([template.id]), first, '⑥ 改回原配置后指纹恢复');
  assertEq(main.buildDuplicateReviewConfigStamp([987654]) !== main.buildDuplicateReviewConfigStamp([]), true, '⑥ 模板不存在记为 missing');
  // 大账号固定模式（按记住的顺序自动分配）变化时指纹不同
  writeBigAccountMode(BIG_ACCOUNT_STORAGE_ROOT, template.id, 'fixed');
  assertEq(main.buildDuplicateReviewConfigStamp([template.id]) !== first, true, '⑥ 大账号固定模式变化时复核指纹不同');
  writeBigAccountMode(BIG_ACCOUNT_STORAGE_ROOT, template.id, 'unfixed');
  assertEq(main.buildDuplicateReviewConfigStamp([template.id]), first, '⑥ 改回原模式后指纹恢复');

  // 一次指纹计算只解析一次枚举表与币种表（模板多时不在主进程反复同步读文件）
  const second = saveTemplate(database, main, '查重模板-2').template;
  const loads = { enum: 0, currency: 0 };
  const counting = createMain(database, {
    loadEnumValues: () => { loads.enum += 1; return ENUM_VALUES.slice(); },
    loadCurrencyMappings: (tablePath) => { loads.currency += 1; return loadCurrencyMappings(tablePath); }
  });
  assertEq(counting.buildDuplicateReviewConfigStamp([template.id, second.id]), main.buildDuplicateReviewConfigStamp([template.id, second.id]),
    '⑥ 共用缓存不改变指纹');
  assertEq([loads.enum, loads.currency <= 1], [1, true], '⑥ 两个模板的指纹只解析一次枚举表、至多一次币种表');
  database.deleteTemplate(second.id);
}

async function run() {
  console.log('==== 网银账单 · 原始账单预处理重复账单过滤 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-duplicate-row-filter-'));
  try {
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    const template = verifySave(database, main);
    const files = verifyReviewAndDrop(dir, main, template);
    verifyToggleOff(dir, database, main, template, files);
    verifyBundleAndReferences(dir, database, main, template);
    verifyReviewConfigStamp(database, main, template);
    closeDatabase(database);
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
