// 网银账单：模板「日期格式」（v3.2.21，templates.date_format）e2e 集成验证
//   覆盖：真实主库（仓储）+ main.js 中真实的 template:save-mappings / template:import-bundle 处理器（按片段加载，
//   对话框、模板库文件与活动日志替换为桩）、取值规范化、生成配置与模板包读写函数 + 真实 xlsx / csv 读取
//   ① 取值：auto / DMY / MDY 以外的值（含非字符串）视为无效（界面与主进程同值域）；新模板默认 auto
//      保存处理器：写入并在变化时留痕；未传时保持原值；无效值报 TEMPLATE_DATE_FORMAT_INVALID 且不改库；
//      落库后模板库文件同步失败时，变更仍已留痕，重试不重复记录；库内三档以外的旧值改为合法值时按原值留痕
//   ② 模板【更新】（只换表头）后日期格式保留
//   ③ 生成：库内配置 → buildStatementGenerationConfig → buildMappedRowsForFile：月在前模板把文本 09/10/2026 读成
//      2026-09-10，自动 / 日在前仍读成 2026-10-09（BillDate 与 ValueDate，xlsx 文本单元格与 csv）
//   ④ 模板包：只用到日期格式时不升版本（v5）；导出 → 导入处理器后日期格式与生成结果一致；包内无效值（含非字符串）导入为 auto
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
  buildLogicValueFeatureCandidate,
  buildLogicValueToken,
  buildMappedRows,
  extractHeaders,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  isFeeFieldMappingTemplateFieldExcluded,
  LEGACY_FEATURE_FILTER_ID,
  loadCurrencyMappings,
  LOGIC_VALUE_MIN_FIELDS,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeBillSplitRowFilterRules,
  normalizeCell,
  normalizeFeatureFilterList,
  normalizeFeeAmountFormula,
  normalizeFeeFieldMappings,
  normalizeLogicValueFields,
  normalizeRowFilterRules,
  parseFeatureFilterToken,
  parseLogicValueFeatureFilterRef,
  parseLogicValueToken,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  validateBillSplitRowFilterRules,
  validateFeeAmountFormula,
  validateFeeFieldMappings,
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
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION',
  'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION',
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
    'readTemplateBundleFile', 'resolveTemplateBundleVersion', 'upgradeLegacyBundleFeatureFilterRefs', 'collectReferencedFeatureFilterIds',
    'maskAccountLikeTextForLog',
    'normalizeTemplateDateFormat',
    'formatTemplateDateFormatLabel',
    // 保存 / 导入处理器用到的 main.js 函数（渠道、余额方式校验在无渠道时直接返回）
    'normalizeTemplateChannelAssignment', 'buildTemplateSummary', 'getAvailableCurrencyCodes',
    'findConflictingTemplateByHeaders', 'buildBundleImportDraftTemplate', 'applyBundleBillSplitConfig',
    // 生产导出（【导出模板】与模板库文件同步共用）
    'writeTemplateBundleFile', 'buildTemplateLibraryPayload', 'toBundleAccountMapping'
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
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateFeeAmountFormula,
    validateFeeFieldMappings,
    isFeeFieldMappingTemplateFieldExcluded,
    validateBillSplitRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX,
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    buildFeatureFilterToken,
    buildLogicValueToken,
    buildLogicValueFeatureCandidate,
    parseLogicValueToken,
    parseLogicValueFeatureFilterRef,
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
    ensureStorageRoot: () => '',
    readBigAccountOrder: () => null,
    readBigAccountMode: () => 'unset'
  });
}

// main.js 中真实的处理器片段（registerTemplateHandlers 内，按 trackedIpcHandle 起止截取）
function mainSection(startText, endText) {
  const start = MAIN_SOURCE.indexOf(startText);
  const end = MAIN_SOURCE.indexOf(endText, start);
  if (start < 0 || end <= start) throw new Error(`main.js 片段边界缺失：${startText}`);
  return MAIN_SOURCE.slice(start, end);
}
const HANDLER_SOURCE = [
  mainSection("  trackedIpcHandle('template:save-mappings'", "  trackedIpcHandle('template:rename'"),
  mainSection("  trackedIpcHandle('template:import-bundle'", "  ipcMain.handle('template:get-amount-split-rules'")
].join('\n');

// 加载处理器：库、规范化与校验用真实实现；文件对话框、模板库文件、余额顺序文件、渠道还原与活动日志用桩
function loadTemplateHandlers(database, main, { bundlePath = '', syncTemplateLibraryFile = () => {} } = {}) {
  const handlers = new Map();
  const activity = [];
  // 与 main.js createErrorResult 同返回结构：界面只拿到 status / message 与报错文件信息，错误码只进报错文件与日志（从 errorResults 断言）
  const errorResults = [];
  const toErrorResult = (options) => {
    errorResults.push(options);
    return { status: 'error', message: options.message, errorReportReady: true, errorReportFileName: 'stub-error-report.xlsx' };
  };
  const scope = {
    ...CONSTANTS,
    ...main,
    database,
    normalizeCell,
    normalizeFeatureFilterList,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateBillSplitRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    FileValidationError,
    STATEMENT_CHANNEL_BUSINESS_ERROR_CODES: new Set(),
    trackedIpcHandle: (channel, _moduleKey, _functionKey, handler) => handlers.set(channel, handler),
    getEnumConfig: () => ({ filePath: 'COMMON枚举.xlsx' }),
    loadEnumValues: () => ENUM_VALUES.slice(),
    createErrorResult: toErrorResult,
    createDetailedErrorResult: toErrorResult,
    createPreflightErrorResult: toErrorResult,
    createStatementChannelErrorResult: (_step, error) => toErrorResult({ errorCode: error.code, message: error.message }),
    syncTemplateLibraryFile,
    clearLastErrorReport: () => {},
    appendActivityLogEntry: (entry) => activity.push(entry),
    showImportOpenDialog: async () => ({ canceled: false, filePaths: [bundlePath] }),
    createPreviewSourceFreshnessGuard: () => () => {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    mainWindow: null,
    ensureStorageRoot: () => '',
    writeBigAccountOrder: () => {},
    writeBigAccountMode: () => {},
    restoreBundleFollowUpRounds: () => ({
      channelRestore: { assignments: [], channels: [] },
      restoreResult: { channelCount: 0, conflictCount: 0 }
    }),
    collectChannelBalanceModeWarnings: () => []
  };
  Function(...Object.keys(scope), `${HANDLER_SOURCE}\nreturn null;`)(...Object.values(scope));
  return {
    activity,
    errorResults,
    lastErrorCode: () => (errorResults.length ? errorResults[errorResults.length - 1].errorCode : ''),
    saveMappings: (payload) => handlers.get('template:save-mappings')(null, payload),
    async importBundle() {
      const contract = handlers.get('template:import-bundle');
      const prepared = await contract.prepare();
      if (!prepared.proceed) return prepared.result;
      prepared.beforeStart();
      return contract.execute(null, prepared, { fileEvidence: { filePlan: prepared.filePlan } });
    }
  };
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

// 经真实的 template:save-mappings 处理器保存（与映射关系管理【保存】同载荷）
function saveTemplate(database, handlers, name, dateFormat) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  const result = handlers.saveMappings({ templateId: template.id, mappings: draftMappings(), dateFormat });
  if (result.status !== 'success') throw new Error(`保存模板「${name}」失败：${handlers.lastErrorCode()} ${result.message}`);
  return database.getTemplate(template.id);
}

function dateFormatLogLines(handlers) {
  return handlers.activity
    .filter((entry) => entry.message === '模板日期格式已修改')
    .map((entry) => entry.details.join('｜'));
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
  assertEq(['auto', 'DMY', 'MDY', ' MDY ', 'mdy', 'YMD', '', null, undefined, 1, ['MDY'], { toString: () => 'MDY' }]
    .map((value) => main.normalizeTemplateDateFormat(value)),
  ['auto', 'DMY', 'MDY', 'MDY', '', '', '', '', '', '', '', ''], '① 值域外（含大小写不同、空值、非字符串）视为无效');
  // 界面下拉框的实际选项（日在前 / 月在前）由 renderer lifecycle 的「日期格式」用例核对

  const fresh = database.upsertTemplate({ name: '新模板-日期格式', sourceFileName: 'fresh.xlsx', headers: HEADERS });
  assertEq(database.getTemplate(fresh.id).dateFormat, 'auto', '① 新模板默认 auto');
}

// 真实的 template:save-mappings 处理器：写入、留痕、保持原值与拒绝无效值
function verifySaveHandler(database, main) {
  const handlers = loadTemplateHandlers(database, main);
  const template = saveTemplate(database, handlers, '月在前模板', 'MDY');
  assertEq(template.dateFormat, 'MDY', '① 保存处理器写入 MDY');
  assertEq(dateFormatLogLines(handlers), ['模板名：月在前模板｜日期格式：自动 → 月在前（mm/dd/yyyy）'], '① 取值变化时活动日志记录旧值与新值');

  const kept = handlers.saveMappings({ templateId: template.id, mappings: draftMappings() });
  assertEq([kept.status, database.getTemplate(template.id).dateFormat], ['success', 'MDY'], '① 未传日期格式时保持原值');
  handlers.saveMappings({ templateId: template.id, mappings: draftMappings(), dateFormat: 'MDY' });
  assertEq(dateFormatLogLines(handlers).length, 1, '① 取值未变化时不重复记录');

  const invalid = handlers.saveMappings({ templateId: template.id, mappings: draftMappings(), dateFormat: 'XYZ' });
  assertEq([invalid.status, invalid.message, handlers.lastErrorCode(), database.getTemplate(template.id).dateFormat],
    ['error', '日期格式无效，请重新选择', 'TEMPLATE_DATE_FORMAT_INVALID', 'MDY'], '① 无效值拒绝保存且不改库');
  const autoTemplate = database.upsertTemplate({ name: '数组日期格式', sourceFileName: 'array.xlsx', headers: [...HEADERS, '备注'] });
  const arrayValue = handlers.saveMappings({ templateId: autoTemplate.id, mappings: draftMappings(), dateFormat: ['MDY'] });
  assertEq([arrayValue.status, handlers.lastErrorCode(), database.getTemplate(autoTemplate.id).dateFormat], ['error', 'TEMPLATE_DATE_FORMAT_INVALID', 'auto'],
    '① 非字符串（[\'MDY\']）拒绝保存，不会启用月在前');

  // 落库后模板库文件同步失败：界面提示失败，但库内已是新值，变更须已留痕；修复后重试不重复记录
  const failingSync = loadTemplateHandlers(database, main, {
    syncTemplateLibraryFile: () => { throw Object.assign(new Error('EACCES: template-library.json'), { code: 'EACCES' }); }
  });
  const syncFailed = failingSync.saveMappings({ templateId: template.id, mappings: draftMappings(), dateFormat: 'DMY' });
  assertEq([syncFailed.status, syncFailed.message, failingSync.lastErrorCode(), database.getTemplate(template.id).dateFormat],
    ['error', '模板映射保存失败，请导出报错文件查看详情', 'TEMPLATE_MAPPING_SAVE_RUNTIME', 'DMY'], '① 模板库文件同步失败：提示失败，库内已是新值');
  assertEq(dateFormatLogLines(failingSync), ['模板名：月在前模板｜日期格式：月在前（mm/dd/yyyy） → 日在前（dd/mm/yyyy）'],
    '① 模板库文件同步失败时日期格式变更仍已留痕');
  const retried = loadTemplateHandlers(database, main);
  assertEq([retried.saveMappings({ templateId: template.id, mappings: draftMappings(), dateFormat: 'DMY' }).status, dateFormatLogLines(retried)],
    ['success', []], '① 同步恢复后重试成功，不重复记录');

  // 库内三档以外的旧值（旧版导入模板包时可能原样写入，解析按自动）：未传时保持；界面提交 auto 时按原值留痕
  const legacy = database.upsertTemplate({ name: '旧值模板', sourceFileName: 'legacy.xlsx', headers: [...HEADERS, '旧值列'] });
  database.db.prepare('UPDATE templates SET date_format = ? WHERE id = ?').run('XYZ', legacy.id);
  const legacyHandlers = loadTemplateHandlers(database, main);
  legacyHandlers.saveMappings({ templateId: legacy.id, mappings: draftMappings() });
  assertEq([database.getTemplate(legacy.id).dateFormat, dateFormatLogLines(legacyHandlers)], ['XYZ', []], '① 库内旧值：未传日期格式时保持，不留痕');
  legacyHandlers.saveMappings({ templateId: legacy.id, mappings: draftMappings(), dateFormat: 'auto' });
  assertEq([database.getTemplate(legacy.id).dateFormat, dateFormatLogLines(legacyHandlers)],
    ['auto', ['模板名：旧值模板｜日期格式：无效值「XYZ」（按自动解析） → 自动']], '① 库内旧值改为自动时按原值留痕');
  // release 审查：旧值是任意文字（可能含账号），留痕时其中的编号只写位数
  database.db.prepare('UPDATE templates SET date_format = ? WHERE id = ?').run('卡6222021234567890123', legacy.id);
  database.db.prepare('UPDATE templates SET name = ? WHERE id = ?').run('旧值模板6222000011112222', legacy.id);
  const maskedHandlers = loadTemplateHandlers(database, main);
  maskedHandlers.saveMappings({ templateId: legacy.id, mappings: draftMappings(), dateFormat: 'DMY' });
  assertEq(dateFormatLogLines(maskedHandlers), ['模板名：旧值模板（16位数字）｜日期格式：无效值「卡（19位数字）」（按自动解析） → 日在前（dd/mm/yyyy）'],
    '① 库内旧值、模板名含账号时留痕只写编号位数');
  assertEq(maskedHandlers.activity.filter((entry) => entry.message === '保存模板映射成功').map((entry) => entry.details[0]),
    ['模板名：旧值模板（16位数字）'], '① 同次保存的成功日志同样写脱敏的模板名');
  database.db.prepare('UPDATE templates SET name = ? WHERE id = ?').run('旧值模板', legacy.id);

  saveTemplate(database, retried, '月在前模板', 'MDY');
  return database.getTemplate(template.id);
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
  const handlers = loadTemplateHandlers(database, main);
  const autoTemplate = saveTemplate(database, handlers, '自动模板', 'auto');
  const dmyTemplate = saveTemplate(database, handlers, '日在前模板', 'DMY');
  for (const [label, sourcePath] of [['xlsx', xlsxPath], ['csv', csvPath]]) {
    assertEq(generateDates(main, mdyTemplate.id, sourcePath), { dateParseOrder: 'MDY', dates: EXPECTED.MDY },
      `③ 月在前（${label}）：09/10/2026 → 2026-09-10，BillDate 与 ValueDate 同口径`);
    assertEq(generateDates(main, autoTemplate.id, sourcePath), { dateParseOrder: 'auto', dates: EXPECTED.auto },
      `③ 自动（${label}）：结果不变，日在前`);
    assertEq(generateDates(main, dmyTemplate.id, sourcePath).dates, EXPECTED.auto, `③ 日在前（${label}）：与自动相同`);
  }
}

async function verifyBundle(dir, database, main, template) {
  // 只含月在前模板的库经生产导出函数（writeTemplateBundleFile → buildTemplateLibraryPayload）写出模板包
  const source = openDatabase(path.join(dir, 'export.sqlite'));
  const sourceMain = createMain(source);
  saveTemplate(source, loadTemplateHandlers(source, sourceMain), template.name, 'MDY');
  const bundlePath = path.join(dir, 'bundle.json');
  sourceMain.writeTemplateBundleFile(bundlePath);
  const exported = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const entry = exported.templates[0];
  assertEq([exported.bundleVersion, exported.templates.map((item) => item.dateFormat)], [CONSTANTS.BASE_BUNDLE_VERSION, ['MDY']],
    '④ 导出的模板包带 dateFormat，只用到日期格式时不升版本（v5）');
  closeDatabase(source);

  // 经真实的 template:import-bundle 处理器（prepare 读包 → execute 写库）导入另一个库
  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const imported = await loadTemplateHandlers(target, targetMain, { bundlePath }).importBundle();
  const importedTemplate = target.getTemplateByKey(entry.templateKey);
  assertEq([imported.status, importedTemplate && importedTemplate.dateFormat], ['success', 'MDY'], '④ 导入后日期格式为月在前');
  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(generateDates(targetMain, importedTemplate.id, sourcePath), generateDates(main, template.id, sourcePath), '④ 模板包往返后生成结果一致');
  closeDatabase(target);

  // 包内取值：日在前原样保留；无效值、缺省与非字符串（字符串化后等于 MDY）按 auto。各条表头不同，免被表头重复跳过
  const variants = ['DMY', 'auto', 'XYZ', '', undefined, ['MDY'], 1];
  fs.writeFileSync(bundlePath, JSON.stringify({
    bundleVersion: CONSTANTS.BASE_BUNDLE_VERSION,
    channels: [],
    templates: variants.map((dateFormat, index) => ({
      ...entry, templateKey: `variant-${index}`, name: `变体-${index}`, headers: [...entry.headers, `变体列${index}`], dateFormat
    }))
  }), 'utf8');
  const variantTarget = openDatabase(path.join(dir, 'variants.sqlite'));
  const variantResult = await loadTemplateHandlers(variantTarget, createMain(variantTarget), { bundlePath }).importBundle();
  assertEq([variantResult.status, variants.map((_value, index) => {
    const item = variantTarget.getTemplateByKey(`variant-${index}`);
    return item ? item.dateFormat : null;
  })], ['success', ['DMY', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto']], '④ 导入：日在前原样保留，无效值、缺省与非字符串按 auto');
  closeDatabase(variantTarget);
}

async function run() {
  console.log('==== 网银账单 · 模板日期格式 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-template-date-format-'));
  try {
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    verifyValues(database, main);
    const template = verifySaveHandler(database, main);
    verifyHeaderUpdate(database, template);
    verifyGeneration(dir, database, main, template);
    await verifyBundle(dir, database, main, template);
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
