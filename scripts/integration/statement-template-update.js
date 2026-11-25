// 网银账单：模板管理【更新】（v3.2.18）e2e 集成验证
//   覆盖：真实主库 + 真实 xlsx 读取与写出 + main.js 中的真实预览、确认更新、保存校验与生成配置函数
//   ① 现有有效模板生成不受新拦截影响（no-op）
//   ② 预览：读新模板文件表头，分组汇总新增/删除/顺序，列出受影响的映射（含未启用标注）；预览不写库
//   ③ 拒绝：与其他模板表头重复、字段无变化、期望表头不一致（确认期间被修改）、重复提交、模板已删除——均不写库
//   ④ 确认更新：只替换表头与源文件名，映射与其余配置保留；同步模板库文件、写活动日志；返回失效映射
//   ⑤ 生成前拦截：失效映射未修改前生成报 TEMPLATE_MAPPING_FIELD_MISSING 并列出字段；未启用的失效配置不拦截
//   ⑥ 修改映射后按新字段生成，回读导出明细金额取自新列；旧格式账单文件不再匹配该模板
//   ⑦ 引用收集与真实生成 lookup（buildMappedFieldLookup）逐目标字段一致：拼接、单元素 mappedFields、与选项同名的列名
//   ⑧ 与选项或模式同名的真实列名（如「自己输入」、拼接中的「字段筛选特征值」）合法保存后被更新删除，生成前同样拦截
//   ⑨ 旧版方向的映射拒绝更新（需先在【修改】中保存一次），不写库
//   ⑩ 行为对照：逐列删除源列，用真实生成结果是否变化判定生成器实际读取的列，与引用收集逐列一致
//      （拼接中与标记 / 选项 / 模式同名的列、单元素 mappedFields、非 Balance 的「无」）；拆分映射保存校验拒绝失效的拼接字段
//   ⑪ 按正负号拆分的发生额多字段配置：生成器读取拼接列名「A,B」，删除该列后生成前拦截；表头写库后模板库同步失败仍报告已更新
//   ⑫ 模板包覆盖已有模板时按包里的表头校验：更新后的模板交接到仍是旧表头的另一台电脑，新字段映射不被误判
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-template-update.js

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
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell,
  normalizeFeeAmountFormula,
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeBillSplitRowFilterRules,
  normalizeRowFilterRules,
  validateRowFilterRules,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  hasCrossSheetBackfillSettings,
  normalizeCrossSheetBackfillRule,
  validateCrossSheetBackfillRule,
  validateFeeAmountFormula,
  validateBillSplitRowFilterRules,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');
const { createTemplateHeaderUpdateTools, diffTemplateHeaders } = require('../../src/main-process/template-header-update');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const OLD_HEADERS = ['交易日期', '附言', '币种', '收入', '支出', '账号'];
// 渠道改版：「收入」改名为「收入金额」，新增「流水号」
const NEW_HEADERS = ['交易日期', '附言', '币种', '收入金额', '支出', '账号', '流水号'];
const OTHER_HEADERS = ['日期', '金额', '币别', '户名'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference', 'Balance'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference'];

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
function assertThrows(fn, check, label) {
  try {
    fn();
  } catch (error) {
    if (error instanceof FileValidationError && check(error)) { passed++; return; }
    failed++; failures.push({ label, actual: `${error.code}: ${error.message}`, expected: '符合条件的 FileValidationError' });
    return;
  }
  failed++; failures.push({ label, actual: '未抛错', expected: '抛出 FileValidationError' });
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
  'SIGNED_AMOUNT_MAPPING_FIELD',
  'LEGACY_ORIENTED_MAPPINGS_MESSAGE'
]);

function writeWorkbook(filePath, headers, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function readSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return { header: rows[0], rows: rows.slice(1) };
}

function pickColumns(rows, names) {
  const header = rows[0];
  return rows.slice(1).map((row) => names.map((name) => row[header.indexOf(name)]));
}

function createMain(database, spies) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'isCrossSheetBackfillEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    'validateFeatureFiltersPayload',
    'collectFeatureFilterRefs',
    'buildExportTargetFields',
    'buildMappingTargetFields',
    'buildManagedMappingFields',
    'getPrimaryMappedField',
    'getMappingFieldValues',
    'normalizeMappedFields',
    'resolveCurrentMappings',
    'decodeCustomInputMappingValue',
    'normalizeMappingRows',
    'normalizeExportMappingRows',
    'buildCompatibleBigAccounts',
    'isFilenameMappingMode',
    'getTemplateMappingConfig',
    'buildMappedFieldLookup',
    'normalizeLookupMappingValue',
    'buildStatementGenerationConfig', 'buildPreprocessRowFilterRules', 'buildCrossSheetBackfillRule', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'isCrossSheetBackfillEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    'resolveStatementFeatureFilters',
    'buildBillSplitMergeConfig',
    'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile',
    'validateBillSplitMappingsPayload',
    'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig',
    'isCurrencyOnlyMerchantMapping',
    'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta',
    'findConflictingTemplateByHeaders',
    'buildTemplateFieldReferenceInput',
    'collectStaleTemplateFieldReferences',
    'extractStatementTemplateHeaders',
    'prepareTemplateHeaderUpdate',
    'applyTemplateHeaderUpdate',
    'hasAmbiguousLogicValueFeatureCandidate',
    'isLegacyOrientedTemplateMappings',
    'buildBundleImportDraftTemplate'
  ], {
    ...CONSTANTS,
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools(CONSTANTS),
    diffTemplateHeaders,
    extractHeaders,
    database,
    fs,
    path,
    normalizeCell,
    // v3.2.19：拆分配置的费用账单公式（映射配置、生成配置）
    normalizeFeeAmountFormula,
    normalizeFeeFieldMappings,
    validateFeeFieldMappings,
    isFeeFieldMappingTemplateFieldExcluded,
    normalizeBillSplitRowFilterRules,
    normalizeRowFilterRules,
    validateRowFilterRules,
    PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
    hasCrossSheetBackfillSettings,
    normalizeCrossSheetBackfillRule,
    validateCrossSheetBackfillRule,
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
    finalizeBigAccountRecognitionBasis: () => null,
    createErrorResult: ({ step, message, errorCode, context }) => ({
      status: 'error', step, message, errorCode, context, errorReportReady: true
    }),
    syncTemplateLibraryFile: () => {
      spies.librarySyncs += 1;
      if (spies.failLibrarySync) throw new Error('EACCES: 模板库文件被占用');
    },
    clearLastErrorReport: () => {},
    appendActivityLogEntry: (entry) => { spies.activity.push(entry); },
    buildTemplateSummary: (template) => template
  });
}

function mappingsFor(overrides = {}) {
  const base = {
    BillDate: '交易日期',
    MerchantId: '账号',
    Currency: '币种',
    'Credit Amount': '收入',
    'Debit Amount': '支出',
    Remark: '附言',
    Balance: CONSTANTS.BALANCE_DISABLED_OPTION,
    ...overrides
  };
  return Object.entries(base).map(([templateField, mappedField]) => ({ templateField, mappedField, mappedFields: [], customValue: '' }));
}

function saveMappings(main, database, templateId, overrides = {}) {
  const template = database.getTemplate(templateId);
  const validated = main.validateTemplateConfiguration({ template, mappings: mappingsFor(overrides), enumValues: ENUM_VALUES });
  database.saveMappings(templateId, validated.mappings, [], [], undefined, null, {});
}

function generate(main, database, templateId, inputFilePath) {
  const config = main.getTemplateMappingConfig(templateId);
  const generationConfig = main.buildStatementGenerationConfig({
    template: config.template,
    mappings: config.exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  return main.buildMappedRowsForFile({ config: generationConfig, inputFilePath });
}

function persistedState(database, templateId) {
  const row = database.db.prepare('SELECT headers_json, source_file_name, updated_at FROM templates WHERE id = ?').get(templateId);
  return {
    template: row ? { ...row } : null,
    mappings: database.db.prepare('SELECT template_field, mapped_field, mapped_fields_json FROM template_mappings WHERE template_id = ? ORDER BY row_index')
      .all(templateId).map((item) => ({ ...item })),
    amountSplitRules: database.db.prepare('SELECT * FROM template_amount_split_rules WHERE template_id = ? ORDER BY rowid')
      .all(templateId).map((item) => ({ ...item }))
  };
}

const SOURCE_ROWS_OLD = [
  ['2026-11-01', '货款', 'USD', '100', '', 'ACC1'],
  ['2026-11-02', '手续费', 'USD', '', '5', 'ACC1']
];
const SOURCE_ROWS_NEW = [
  ['2026-11-03', '货款', 'USD', '200', '', 'ACC1', 'SN001'],
  ['2026-11-04', '退款', 'USD', '', '30', 'ACC1', 'SN002']
];

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-template-update-'));
  const database = new AppDatabase(path.join(dir, 'main.sqlite'));
  database.init();
  const spies = { librarySyncs: 0, activity: [] };
  try {
    const main = createMain(database, spies);
    const template = database.upsertTemplate({ name: '招商银行-上海', sourceFileName: '招商银行-上海.xlsx', headers: OLD_HEADERS });
    saveMappings(main, database, template.id);
    // 未开启「按字段区分发生额」时残留的规则：引用将被删除的字段，属于未启用配置
    database.saveAmountSplitRules(template.id, [
      { targetField: 'Credit Amount', conditionField: '收入', conditionValue: '1', mappedField: '收入', rowIndex: 0 }
    ]);
    const other = database.upsertTemplate({ name: '工商银行-北京', sourceFileName: 'icbc.xlsx', headers: OTHER_HEADERS });

    // ① 现有有效模板生成不受影响
    const oldSource = path.join(dir, 'old-source.xlsx');
    writeWorkbook(oldSource, OLD_HEADERS, SOURCE_ROWS_OLD);
    const beforeRows = generate(main, database, template.id, oldSource);
    assertEq(pickColumns(beforeRows, ['BillDate', 'Credit Amount', 'Debit Amount', 'Remark']), [
      ['2026-11-01', '100', '', '货款'],
      ['2026-11-02', '', '5', '手续费']
    ], '① 有效模板照常生成');

    // ② 预览
    const newTemplateFile = path.join(dir, '招商银行-上海-新版.xlsx');
    writeWorkbook(newTemplateFile, NEW_HEADERS);
    const stateBefore = persistedState(database, template.id);
    const preview = main.prepareTemplateHeaderUpdate({ templateId: template.id, filePath: newTemplateFile });
    assertEq(preview.status, 'success', '② 预览成功');
    assertEq(preview.diff, { identical: false, added: ['收入金额', '流水号'], removed: ['收入'], orderChanged: false }, '② 分组汇总新增/删除/顺序');
    assertEq(preview.affectedMappings, [
      'Credit Amount ← 收入',
      '按字段区分发生额 · Credit Amount 判断字段 ← 收入（未启用）',
      '按字段区分发生额 · Credit Amount 取值字段 ← 收入（未启用）'
    ], '② 受影响的映射（含未启用标注）');
    assertEq(preview.activeStaleCount, 1, '② 需修改后才能生成的失效映射数');
    assertEq([preview.expectedHeaders, preview.headers, preview.sourceFileName], [OLD_HEADERS, NEW_HEADERS, '招商银行-上海-新版.xlsx'], '② 预览回传新旧表头与源文件名');
    assertEq(persistedState(database, template.id), stateBefore, '② 预览不写库');

    // ③ 拒绝
    const duplicateFile = path.join(dir, 'dup.xlsx');
    writeWorkbook(duplicateFile, OTHER_HEADERS);
    const duplicate = main.prepareTemplateHeaderUpdate({ templateId: template.id, filePath: duplicateFile });
    assertEq([duplicate.status, duplicate.errorCode], ['error', 'TEMPLATE_HEADERS_DUPLICATE'], '③ 预览：与其他模板表头重复被拒');
    assertTrue(/工商银行-北京/.test(duplicate.message), '③ 提示重复的模板名');
    const duplicateApply = main.applyTemplateHeaderUpdate({
      templateId: template.id, expectedHeaders: OLD_HEADERS, headers: OTHER_HEADERS, sourceFileName: 'dup.xlsx'
    });
    assertEq(duplicateApply.errorCode, 'TEMPLATE_HEADERS_DUPLICATE', '③ 确认：重复表头再次复核被拒');

    const sameFile = path.join(dir, 'same.xlsx');
    writeWorkbook(sameFile, OLD_HEADERS);
    const same = main.prepareTemplateHeaderUpdate({ templateId: template.id, filePath: sameFile });
    assertEq([same.status, same.diff.identical, same.affectedMappings], ['success', true, []], '③ 预览：字段无变化');
    const sameApply = main.applyTemplateHeaderUpdate({
      templateId: template.id, expectedHeaders: OLD_HEADERS, headers: OLD_HEADERS, sourceFileName: 'same.xlsx'
    });
    assertEq(sameApply.errorCode, 'TEMPLATE_HEADERS_UNCHANGED', '③ 确认：字段无变化被拒');

    const changedApply = main.applyTemplateHeaderUpdate({
      templateId: template.id, expectedHeaders: ['交易日期'], headers: NEW_HEADERS, sourceFileName: 'x.xlsx'
    });
    assertEq(changedApply.errorCode, 'TEMPLATE_HEADERS_CHANGED', '③ 确认：期望表头不一致（期间被修改）被拒');
    const invalidApply = main.applyTemplateHeaderUpdate({ templateId: template.id, expectedHeaders: OLD_HEADERS, headers: ['', ''] });
    assertEq(invalidApply.errorCode, 'TEMPLATE_HEADERS_INVALID', '③ 确认：无有效表头被拒');
    assertEq(persistedState(database, template.id), stateBefore, '③ 拒绝时均不写库');
    assertEq([spies.librarySyncs, spies.activity.length], [0, 0], '③ 拒绝时不同步模板库、不写活动日志');

    // ④ 确认更新
    const payload = {
      templateId: preview.templateId,
      expectedHeaders: preview.expectedHeaders,
      headers: preview.headers,
      sourceFileName: preview.sourceFileName
    };
    const applied = main.applyTemplateHeaderUpdate(payload);
    assertEq(applied.status, 'success', '④ 确认更新成功');
    assertEq(applied.staleMappings, preview.affectedMappings, '④ 返回失效映射与预览一致');
    assertEq(applied.activeStaleCount, 1, '④ 需修改的失效映射数');
    assertTrue(/修改映射关系前无法用该模板生成账单/.test(applied.message), '④ 成功提示说明需修改映射');
    const stateAfter = persistedState(database, template.id);
    assertEq(JSON.parse(stateAfter.template.headers_json), NEW_HEADERS, '④ 表头已替换');
    assertEq(stateAfter.template.source_file_name, '招商银行-上海-新版.xlsx', '④ 源文件名已替换');
    assertEq([stateAfter.mappings, stateAfter.amountSplitRules], [stateBefore.mappings, stateBefore.amountSplitRules], '④ 映射与发生额规则原样保留');
    assertEq(database.getTemplate(template.id).name, '招商银行-上海', '④ 模板名不变');
    assertEq(database.getTemplate(other.id).headers, OTHER_HEADERS, '④ 其他模板不受影响');
    assertEq(spies.librarySyncs, 1, '④ 同步模板库文件一次');
    assertEq(spies.activity.map((entry) => entry.message), ['更新模板表头成功'], '④ 写活动日志');
    assertTrue(spies.activity[0].details.includes('删除字段：收入') && spies.activity[0].details.includes('新增字段：收入金额、流水号'), '④ 活动日志记录字段变更');

    const resubmit = main.applyTemplateHeaderUpdate(payload);
    assertEq(resubmit.errorCode, 'TEMPLATE_HEADERS_CHANGED', '③ 重复提交同一确认被拒（期望表头已不一致）');
    assertEq(spies.librarySyncs, 1, '③ 重复提交不再写入');

    // ⑤ 生成前拦截
    const newSource = path.join(dir, 'new-source.xlsx');
    writeWorkbook(newSource, NEW_HEADERS, SOURCE_ROWS_NEW);
    assertThrows(
      () => generate(main, database, template.id, newSource),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING'
        && error.message === '模板「招商银行-上海」的映射字段不存在：收入，请在模板管理中修改映射关系后重新导入'
        && JSON.stringify(error.detailLines) === JSON.stringify(['以下映射引用的字段已不在模板表头中：', 'Credit Amount ← 收入']),
      '⑤ 失效映射未修改前生成被拦截，列出字段'
    );
    assertThrows(
      () => main.validateTemplateConfiguration({ template: database.getTemplate(template.id), mappings: mappingsFor(), enumValues: ENUM_VALUES }),
      (error) => /映射字段不存在：收入/.test(error.message),
      '⑤ 不修改失效映射直接保存仍被现有校验拒绝'
    );

    // ⑥ 修改映射后按新字段生成；未启用的失效规则不拦截
    saveMappings(main, database, template.id, { 'Credit Amount': '收入金额' });
    const afterRows = generate(main, database, template.id, newSource);
    assertEq(pickColumns(afterRows, ['BillDate', 'Credit Amount', 'Debit Amount', 'Remark']), [
      ['2026-11-03', '200', '', '货款'],
      ['2026-11-04', '', '30', '退款']
    ], '⑥ 修改映射后按新字段生成（未启用的失效规则不拦截）');
    const outputPath = path.join(dir, 'detail.xlsx');
    writeWorkbookRows({ rows: buildDetailExportRows(afterRows), outputFilePath: outputPath });
    const exported = readSheet(outputPath);
    assertEq(
      exported.rows.map((row) => [row[exported.header.indexOf('Credit Amount')], row[exported.header.indexOf('Debit Amount')]]),
      [[200, ''], ['', 30]],
      '⑥ 回读导出明细：收入金额取自新列'
    );
    let oldFileRejected = false;
    try {
      generate(main, database, template.id, oldSource);
    } catch (error) {
      oldFileRejected = error instanceof FileValidationError;
    }
    assertTrue(oldFileRejected, '⑥ 旧格式账单文件不再匹配更新后的模板');

    // ⑦ 引用收集与真实生成 lookup 一致（同一输入）
    const tools = createTemplateHeaderUpdateTools(CONSTANTS);
    const rows = [
      { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
      { templateField: 'Remark', mappedField: CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD, mappedFields: ['附言', `${FIXED_FIELD_VALUE_PREFIX}-`, '流水号'] },
      { templateField: 'Reference', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: [] },
      { templateField: 'MerchantId', mappedField: MERCHANT_ID_CURRENCY_ONLY_MARKER, mappedFields: [] },
      { templateField: 'Currency', mappedField: `${FIXED_FIELD_VALUE_PREFIX}USD`, mappedFields: [] },
      { templateField: 'Balance', mappedField: CONSTANTS.BALANCE_CALCULATED_OPTION, mappedFields: [] },
      { templateField: 'Credit Amount', mappedField: CONSTANTS.MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] },
      { templateField: 'Debit Amount', mappedField: '账号A', mappedFields: ['账号B'] },
      { templateField: 'Fee', mappedField: '无', mappedFields: [] },
      { templateField: 'Name', mappedField: CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD, mappedFields: [CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD] }
    ];
    const lookup = main.buildMappedFieldLookup(rows);
    // 生成器按语义单独处理、不按列读取的取值：固定值、筛选 token、Balance 计算选项、MerchantId 按币种标记
    const generatorFields = Object.fromEntries(Object.entries(lookup).map(([target, value]) => [target,
      (Array.isArray(value) ? value : [value]).map((token) => normalizeCell(token)).filter((token) => token
        && !token.startsWith(FIXED_FIELD_VALUE_PREFIX)
        && parseFeatureFilterToken(token) === null
        && !(target === 'Balance' && token === CONSTANTS.BALANCE_CALCULATED_OPTION)
        && !(target === 'MerchantId' && token === MERCHANT_ID_CURRENCY_ONLY_MARKER))]).filter(([, fields]) => fields.length));
    const collectorFields = {};
    tools.collectTemplateFieldReferences({ mappings: rows }).forEach((reference) => {
      (collectorFields[reference.target] = collectorFields[reference.target] || []).push(reference.field);
    });
    assertEq(collectorFields, generatorFields, '⑦ 引用收集与生成 lookup 逐目标字段一致');
    assertEq(collectorFields['Debit Amount'], ['账号B'], '⑦ 单元素 mappedFields 优先于 mappedField');
    assertEq(collectorFields.Name, [CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD], '⑦ 拼接字段中与模式名称同名的列按源字段计入');

    // ⑧ 与选项同名的真实列名
    const optionHeaders = ['交易日期', '自己输入', '支出', '账号', '币种'];
    const optionTemplate = database.upsertTemplate({ name: '中国银行-广州', sourceFileName: 'boc.xlsx', headers: optionHeaders });
    saveMappings(main, database, optionTemplate.id, { 'Credit Amount': '自己输入', Remark: '' });
    const optionSourceOld = path.join(dir, 'option-old.xlsx');
    writeWorkbook(optionSourceOld, optionHeaders, [['2026-11-05', '100', '', 'ACC2', 'USD'], ['2026-11-06', '', '5', 'ACC2', 'USD']]);
    assertEq(pickColumns(generate(main, database, optionTemplate.id, optionSourceOld), ['Credit Amount', 'Debit Amount']), [['100', ''], ['', '5']],
      '⑧ 列名「自己输入」合法映射并照常生成');
    const optionNewHeaders = ['交易日期', '收入', '支出', '账号', '币种'];
    const optionPreview = main.prepareTemplateHeaderUpdate({
      templateId: optionTemplate.id,
      filePath: (() => { const file = path.join(dir, 'option-new.xlsx'); writeWorkbook(file, optionNewHeaders); return file; })()
    });
    assertEq(optionPreview.affectedMappings, ['Credit Amount ← 自己输入'], '⑧ 预览列出与选项同名的失效映射');
    const optionApplied = main.applyTemplateHeaderUpdate({ templateId: optionTemplate.id, expectedHeaders: optionHeaders, headers: optionNewHeaders, sourceFileName: 'option-new.xlsx' });
    assertEq(optionApplied.status, 'success', '⑧ 更新成功');
    const optionSourceNew = path.join(dir, 'option-new-source.xlsx');
    writeWorkbook(optionSourceNew, optionNewHeaders, [['2026-11-07', '100', '', 'ACC2', 'USD'], ['2026-11-08', '', '5', 'ACC2', 'USD']]);
    assertThrows(() => generate(main, database, optionTemplate.id, optionSourceNew),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /映射字段不存在：自己输入，/.test(error.message),
      '⑧ 更新后生成前拦截，不静默漏掉收入行');

    // ⑧b 拼接字段中与模式名称同名的真实列：合法保存 → 更新删除 → 生成前拦截
    const modeHeaders = ['交易日期', '字段筛选特征值', '支出', '账号', '币种'];
    const modeTemplate = database.upsertTemplate({ name: '农业银行-杭州', sourceFileName: 'abc.xlsx', headers: modeHeaders });
    {
      const template = database.getTemplate(modeTemplate.id);
      const rowsForSave = mappingsFor({ Remark: '' }).map((row) => (row.templateField === 'Credit Amount'
        ? { ...row, mappedField: CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD, mappedFields: [CONSTANTS.FEATURE_FILTER_MAPPING_FIELD] }
        : row));
      const validated = main.validateTemplateConfiguration({ template, mappings: rowsForSave, enumValues: ENUM_VALUES });
      database.saveMappings(modeTemplate.id, validated.mappings, [], [], undefined, null, {});
    }
    const modeSourceOld = path.join(dir, 'mode-old.xlsx');
    writeWorkbook(modeSourceOld, modeHeaders, [['2026-11-09', '100', '', 'ACC3', 'USD']]);
    assertEq(pickColumns(generate(main, database, modeTemplate.id, modeSourceOld), ['Credit Amount']), [['100']], '⑧b 拼接选中名为「字段筛选特征值」的列照常生成');
    const modeNewHeaders = ['交易日期', '收入', '支出', '账号', '币种', '备注'];
    const modeApplied = main.applyTemplateHeaderUpdate({ templateId: modeTemplate.id, expectedHeaders: modeHeaders, headers: modeNewHeaders, sourceFileName: 'mode-new.xlsx' });
    assertEq([modeApplied.status, modeApplied.staleMappings], ['success', ['Credit Amount ← 字段筛选特征值']], '⑧b 更新成功并列出失效映射');
    const modeSourceNew = path.join(dir, 'mode-new-source.xlsx');
    writeWorkbook(modeSourceNew, modeNewHeaders, [['2026-11-10', '100', '', 'ACC3', 'USD', '']]);
    assertThrows(() => generate(main, database, modeTemplate.id, modeSourceNew),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /映射字段不存在：字段筛选特征值，/.test(error.message),
      '⑧b 更新删除该列后生成前拦截');

    // ⑨ 旧版方向的映射拒绝更新
    const legacyTemplate = database.upsertTemplate({ name: '建设银行-深圳', sourceFileName: 'ccb.xlsx', headers: OLD_HEADERS });
    database.saveMappings(legacyTemplate.id, [
      { templateField: '交易日期', mappedField: 'BillDate', mappedFields: [] },
      { templateField: '收入', mappedField: 'Credit Amount', mappedFields: [] },
      { templateField: '支出', mappedField: 'Debit Amount', mappedFields: [] }
    ], [], [], undefined, null, {});
    const legacyBefore = persistedState(database, legacyTemplate.id);
    const legacyFile = path.join(dir, 'legacy-new.xlsx');
    writeWorkbook(legacyFile, ['日期', '收入金额', '支出金额']);
    const legacyPreview = main.prepareTemplateHeaderUpdate({ templateId: legacyTemplate.id, filePath: legacyFile });
    assertEq([legacyPreview.errorCode, legacyPreview.message], ['TEMPLATE_MAPPINGS_LEGACY_ORIENTATION', CONSTANTS.LEGACY_ORIENTED_MAPPINGS_MESSAGE], '⑨ 预览：旧版方向映射被拒');
    const legacyApply = main.applyTemplateHeaderUpdate({
      templateId: legacyTemplate.id, expectedHeaders: OLD_HEADERS, headers: ['日期', '收入金额', '支出金额'], sourceFileName: 'legacy-new.xlsx'
    });
    assertEq(legacyApply.errorCode, 'TEMPLATE_MAPPINGS_LEGACY_ORIENTATION', '⑨ 确认：旧版方向映射被拒');
    assertEq(persistedState(database, legacyTemplate.id), legacyBefore, '⑨ 拒绝时不写库');

    // ⑨b v3.2.21：模板列名与逻辑取值的特征值候补内部写法相同（构造的含 NUL 列名，只可能来自 v3.2.19/v3.2.20 的旧映射）时，
    //   更新表头后无法再判断该候补原是源列，拒绝更新并要求先重选候补
    const ambiguousColumn = buildLogicValueFeatureCandidate('1');
    const ambiguousHeaders = OLD_HEADERS.concat(ambiguousColumn);
    const ambiguousTemplate = database.upsertTemplate({ name: '旧候补列名-更新', sourceFileName: 'ambiguous.xlsx', headers: ambiguousHeaders });
    database.saveMappings(ambiguousTemplate.id, [
      { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
      { templateField: 'Credit Amount', mappedField: CONSTANTS.LOGIC_VALUE_MAPPING_FIELD, mappedFields: [ambiguousColumn, '收入'] }
    ], [], [], 'auto', null, {});
    const ambiguousBefore = persistedState(database, ambiguousTemplate.id);
    const ambiguousApply = main.applyTemplateHeaderUpdate({
      templateId: ambiguousTemplate.id, expectedHeaders: ambiguousHeaders, headers: OLD_HEADERS.concat('新列'), sourceFileName: 'ambiguous-new.xlsx'
    });
    assertEq([ambiguousApply.errorCode, /请先在映射关系管理中重新选择候补字段后再更新/.test(ambiguousApply.message)],
      ['TEMPLATE_LOGIC_VALUE_CANDIDATE_AMBIGUOUS', true], '⑨b 确认：列名与特征值候补写法相同时拒绝更新');
    assertEq(persistedState(database, ambiguousTemplate.id), ambiguousBefore, '⑨b 拒绝时不写库');
    // 有效模板引用特征值 1，新表头新增了与该候补写法相同的列：预览与确认都拒绝，保留原模板
    const featureRefTemplate = database.upsertTemplate({ name: '特征值候补-更新', sourceFileName: 'feature-ref.xlsx', headers: OLD_HEADERS });
    database.saveMappings(featureRefTemplate.id, [
      { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
      { templateField: 'Credit Amount', mappedField: CONSTANTS.LOGIC_VALUE_MAPPING_FIELD, mappedFields: [ambiguousColumn, '收入'] }
    ], [], [], 'auto', null, {});
    const featureRefBefore = persistedState(database, featureRefTemplate.id);
    const addedColumnFile = path.join(dir, 'feature-ref-new.xlsx');
    writeWorkbook(addedColumnFile, OLD_HEADERS.concat(ambiguousColumn));
    const addedPreview = main.prepareTemplateHeaderUpdate({ templateId: featureRefTemplate.id, filePath: addedColumnFile });
    const addedApply = main.applyTemplateHeaderUpdate({
      templateId: featureRefTemplate.id, expectedHeaders: OLD_HEADERS, headers: OLD_HEADERS.concat(ambiguousColumn), sourceFileName: 'feature-ref-new.xlsx'
    });
    assertEq([addedPreview.errorCode, addedApply.errorCode], ['TEMPLATE_LOGIC_VALUE_CANDIDATE_AMBIGUOUS', 'TEMPLATE_LOGIC_VALUE_CANDIDATE_AMBIGUOUS'],
      '⑨b 新表头出现与特征值候补写法相同的列：预览与确认都拒绝');
    assertEq(persistedState(database, featureRefTemplate.id), featureRefBefore, '⑨b 新表头冲突时不写库');

    // ⑩ 行为对照：生成器实际读取的列 = 删除后输出会变化的列
    const oracleHeaders = ['交易日期', '账号前缀', MERCHANT_ID_CURRENCY_ONLY_MARKER, '余额A', CONSTANTS.BALANCE_CALCULATED_OPTION,
      CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD, CONSTANTS.MERCHANT_ID_SELF_INPUT_OPTION, 'A', 'B', '无', '未引用列'];
    const oracleValues = ['2026-11-01', 'ACC', '123', '1', '23', 'R1', 'R2', '100', '8', '7', 'REF', 'unused'];
    const oracleTemplate = database.upsertTemplate({ name: '行为对照-测试', sourceFileName: 'oracle.xlsx', headers: oracleHeaders });
    const concat = (fields) => ({ mappedField: CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD, mappedFields: fields });
    const oracleMappings = [
      { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
      { templateField: 'Currency', mappedField: `${FIXED_FIELD_VALUE_PREFIX}USD`, mappedFields: [] },
      { templateField: 'MerchantId', ...concat(['账号前缀', MERCHANT_ID_CURRENCY_ONLY_MARKER]) },
      { templateField: 'Balance', ...concat(['余额A', CONSTANTS.BALANCE_CALCULATED_OPTION]) },
      { templateField: 'Remark', ...concat([CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD]) },
      { templateField: 'Credit Amount', mappedField: CONSTANTS.MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] },
      { templateField: 'Debit Amount', mappedField: 'A', mappedFields: ['B'] },
      { templateField: 'Reference', mappedField: '无', mappedFields: [] }
    ];
    const oracleConfig = main.buildStatementGenerationConfig({
      template: database.getTemplate(oracleTemplate.id), mappings: oracleMappings, orderedTargetFields: [...ORDERED_FIELDS, 'Balance'], allowManagedMerchantWithoutSelection: true
    });
    const runWithout = (removed) => {
      const keep = oracleHeaders.map((header, index) => [header, index]).filter(([header]) => header !== removed);
      const file = path.join(dir, `oracle-${keep.length}-${oracleHeaders.indexOf(removed)}.xlsx`);
      writeWorkbook(file, keep.map(([header]) => header), [keep.map(([, index]) => oracleValues[index])]);
      const config = { ...oracleConfig, template: { ...oracleConfig.template, headers: keep.map(([header]) => header) } };
      return JSON.stringify(Array.from(main.buildMappedRowsForFile({ config, inputFilePath: file })));
    };
    const fullOutput = runWithout(null);
    const generatorReads = oracleHeaders.filter((header) => header !== '交易日期' && runWithout(header) !== fullOutput);
    const collected = new Set(tools.collectTemplateFieldReferences({ mappings: oracleMappings }).map((reference) => reference.field));
    assertEq(oracleHeaders.filter((header) => header !== '交易日期' && collected.has(header)), generatorReads, '⑩ 引用收集与生成器实际读取的列逐列一致');
    assertEq(generatorReads.includes('A') || generatorReads.includes('未引用列'), false, '⑩ 对照有效：未读取的列删除后输出不变');
    assertThrows(
      () => main.validateBillSplitMappingsPayload([{ templateField: 'Remark', ...concat([CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD]) }], { headers: ['交易日期'] }),
      (error) => error.message === `映射字段不存在：${CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD}`,
      '⑩ 拆分映射保存：拼接中名为「需要拼接字段」的列已删除时拒绝保存'
    );
    assertEq(main.validateBillSplitMappingsPayload([{ templateField: 'Remark', ...concat([CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD]) }],
      { headers: [CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD] }).map((item) => item.mappedFields), [[CONSTANTS.CONCAT_FIELDS_MAPPING_FIELD]],
    '⑩ 拆分映射保存：该列存在时照常保存');

    // ⑪ 按正负号拆分的发生额：多字段配置被生成器当作一个拼接列名读取
    const signedHeaders = ['交易日期', 'A', 'B', 'A,B', '账号', '币种'];
    const signedTemplate = database.upsertTemplate({ name: '交通银行-南京', sourceFileName: 'bocom.xlsx', headers: signedHeaders });
    {
      const rowsForSave = mappingsFor({ 'Credit Amount': '', 'Debit Amount': '', Remark: '' })
        .concat([{ templateField: CONSTANTS.SIGNED_AMOUNT_MAPPING_FIELD, mappedField: 'A', mappedFields: ['A', 'B'], customValue: '' }]);
      const validated = main.validateTemplateConfiguration({ template: database.getTemplate(signedTemplate.id), mappings: rowsForSave, enumValues: ENUM_VALUES });
      database.saveMappings(signedTemplate.id, validated.mappings, [], [], undefined, null, {});
    }
    const signedSourceOld = path.join(dir, 'signed-old.xlsx');
    writeWorkbook(signedSourceOld, signedHeaders, [['2026-11-11', '1', '2', '75', 'ACC4', 'USD']]);
    assertEq(pickColumns(generate(main, database, signedTemplate.id, signedSourceOld), ['Credit Amount', 'Debit Amount']), [['75', '']],
      '⑪ 多字段配置下生成器读取拼接列名「A,B」');
    const signedNewHeaders = ['交易日期', 'A', 'B', '账号', '币种'];
    spies.failLibrarySync = true;
    const signedApplied = main.applyTemplateHeaderUpdate({ templateId: signedTemplate.id, expectedHeaders: signedHeaders, headers: signedNewHeaders, sourceFileName: 'signed-new.xlsx' });
    spies.failLibrarySync = false;
    assertEq([signedApplied.status, signedApplied.librarySyncFailed, signedApplied.staleMappings], ['success', true, [`${CONSTANTS.SIGNED_AMOUNT_MAPPING_FIELD} ← A,B`]],
      '⑪ 模板库同步失败时仍报告已更新，并列出失效映射');
    assertTrue(/模板库文件同步失败/.test(signedApplied.message), '⑪ 成功提示单独说明模板库同步失败');
    assertEq(database.getTemplate(signedTemplate.id).headers, signedNewHeaders, '⑪ 表头已写入主库');
    assertTrue(spies.activity.some((entry) => entry.level === 'warning' && entry.message === '更新模板表头后同步模板库文件失败'), '⑪ 活动日志记录同步失败');
    const signedSourceNew = path.join(dir, 'signed-new-source.xlsx');
    writeWorkbook(signedSourceNew, signedNewHeaders, [['2026-11-12', '1', '2', 'ACC4', 'USD']]);
    assertThrows(() => generate(main, database, signedTemplate.id, signedSourceNew),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /映射字段不存在：A,B，/.test(error.message),
      '⑪ 删除拼接列名后生成前拦截，不静默丢失发生额');

    // ⑫ 模板包覆盖已有模板：按包里的（更新后）表头校验
    const handoffExisting = database.getTemplate(template.id);
    const handoffEntry = { templateKey: handoffExisting.templateKey, name: handoffExisting.name, sourceFileName: 'x.xlsx', headers: OLD_HEADERS.concat(['新列']) };
    const handoffDraft = main.buildBundleImportDraftTemplate(handoffEntry, { ...handoffExisting, headers: OLD_HEADERS });
    assertEq([handoffDraft.id, handoffDraft.headers], [handoffExisting.id, handoffEntry.headers], '⑫ 覆盖已有模板时草稿沿用模板身份、采用包里的表头');
    const handoffValidated = main.validateTemplateConfiguration({
      template: handoffDraft,
      mappings: main.normalizeMappingRows({ template: handoffDraft, mappings: mappingsFor({ Remark: '新列' }), enumValues: ENUM_VALUES }),
      enumValues: ENUM_VALUES
    });
    assertEq(handoffValidated.mappings.find((item) => item.templateField === 'Remark').mappedField, '新列', '⑫ 引用新字段的映射按包里的表头通过校验');
    assertEq(main.buildBundleImportDraftTemplate(handoffEntry, null).headers, handoffEntry.headers, '⑫ 新建模板时草稿采用包里的表头');

    // ⑬ v3.2.18 多特征值：只有映射选用的特征值的筛选字段删除后拦截生成，未选用的标为未启用
    const featureHeaders = ['交易日期', '附言', '币种', '收入', '支出', '账号', '摘要'];
    const featureTemplate = database.upsertTemplate({ name: '浦发银行-上海', sourceFileName: 'spdb.xlsx', headers: featureHeaders });
    database.saveTemplateFeatureFilters(featureTemplate.id, normalizeFeatureFilterList([
      { name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT24123456' },
      { name: '订单号', sourceField: '摘要', separator: 'space', length: 6, letterPrefixCount: null, digitsOnly: true, sample: '123456' }
    ], { headers: featureHeaders }));
    const featureSaved = database.getTemplate(featureTemplate.id);
    const featureValidated = main.validateTemplateConfiguration({
      template: featureSaved,
      mappings: mappingsFor({ Remark: '' }).concat([{ templateField: 'Reference', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['2'], customValue: '' }]),
      enumValues: ENUM_VALUES,
      featureFilters: featureSaved.featureFilters
    });
    database.saveMappings(featureTemplate.id, featureValidated.mappings, [], [], undefined, null, {});
    const featureNewHeaders = ['交易日期', '币种', '收入', '支出', '账号'];
    const featureFile = path.join(dir, '浦发银行-上海-新版.xlsx');
    writeWorkbook(featureFile, featureNewHeaders);
    const featurePreview = main.prepareTemplateHeaderUpdate({ templateId: featureTemplate.id, filePath: featureFile });
    assertEq([featurePreview.affectedMappings, featurePreview.activeStaleCount], [[
      '特征值「流水号」 · 筛选字段 ← 附言（未启用）',
      '特征值「订单号」 · 筛选字段 ← 摘要'
    ], 1], '⑬ 预览按特征值列出筛选字段，未被映射选用的标为未启用');
    assertEq(main.applyTemplateHeaderUpdate({
      templateId: featureTemplate.id, expectedHeaders: featureHeaders, headers: featureNewHeaders, sourceFileName: 'spdb-new.xlsx'
    }).status, 'success', '⑬ 确认更新');
    assertEq(database.getTemplate(featureTemplate.id).featureFilters, featureSaved.featureFilters, '⑬ 更新只改表头，特征值保留');
    const featureSource = path.join(dir, 'spdb-source.xlsx');
    writeWorkbook(featureSource, featureNewHeaders, [['2026-11-05', 'USD', '10', '', 'ACC1']]);
    assertThrows(
      () => generate(main, database, featureTemplate.id, featureSource),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING'
        && JSON.stringify(error.detailLines) === JSON.stringify(['以下映射引用的字段已不在模板表头中：', '特征值「订单号」 · 筛选字段 ← 摘要']),
      '⑬ 所选特征值的筛选字段已删除：生成前拦截并列出特征值'
    );

    // ⑭ 两个已选用的特征值共用的筛选字段被【更新】改名：可逐个修复，修好前生成被拦截，全部修好后照常生成
    const repairHeaders = ['记账日期', '附言', '币种', '收入', '支出', '账号'];
    const repairTemplate = database.upsertTemplate({ name: '中信银行-上海', sourceFileName: 'citic.xlsx', headers: repairHeaders });
    database.saveTemplateFeatureFilters(repairTemplate.id, normalizeFeatureFilterList([
      { name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT24123456' },
      { name: '订单号', sourceField: '附言', separator: 'space', length: 6, letterPrefixCount: null, digitsOnly: true, sample: '123456' }
    ], { headers: repairHeaders }));
    const repairSaved = database.getTemplate(repairTemplate.id);
    const repairMappings = mappingsFor({ BillDate: '记账日期' }).filter((row) => row.templateField !== 'Remark').concat([
      { templateField: 'Remark', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['1'], customValue: '' },
      { templateField: 'Reference', mappedField: CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['2'], customValue: '' }
    ]);
    database.saveMappings(repairTemplate.id, main.validateTemplateConfiguration({
      template: repairSaved, mappings: repairMappings, enumValues: ENUM_VALUES, featureFilters: repairSaved.featureFilters
    }).mappings, [], [], undefined, null, {});
    const renamedHeaders = ['记账日期', '摘要', '币种', '收入', '支出', '账号'];
    assertEq(main.applyTemplateHeaderUpdate({
      templateId: repairTemplate.id, expectedHeaders: repairHeaders, headers: renamedHeaders, sourceFileName: 'citic-new.xlsx'
    }).status, 'success', '⑭ 「附言」改名为「摘要」后更新成功');
    const repairSource = path.join(dir, 'citic-source.xlsx');
    writeWorkbook(repairSource, renamedHeaders, [['2026-11-06', 'FT24123456 123456', 'USD', '10', '', 'ACC1']]);
    const saveFilters = (list) => {
      const validated = main.validateFeatureFiltersPayload(list, database.getTemplate(repairTemplate.id));
      database.saveTemplateFeatureFilters(repairTemplate.id, validated);
      return database.getTemplate(repairTemplate.id).featureFilters;
    };
    const stale = database.getTemplate(repairTemplate.id).featureFilters;
    assertThrows(() => saveFilters([stale[0], { ...stale[1], length: 7 }]), (error) => /特征值「订单号」：筛选字段不存在：附言/.test(error.message),
      '⑭ 改了条件但仍用已删除字段的特征值照常被拒');
    const afterFirst = saveFilters([{ ...stale[0], sourceField: '摘要' }, stale[1]]);
    assertEq(afterFirst.map((item) => [item.id, item.sourceField]), [['1', '摘要'], ['2', '附言']], '⑭ 先修特征值 1：另一个仍用旧字段的特征值原样保留，保存成功');
    assertThrows(
      () => generate(main, database, repairTemplate.id, repairSource),
      (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING'
        && JSON.stringify(error.detailLines) === JSON.stringify(['以下映射引用的字段已不在模板表头中：', '特征值「订单号」 · 筛选字段 ← 附言']),
      '⑭ 尚未修复的特征值仍在生成前拦截'
    );
    saveFilters([afterFirst[0], { ...afterFirst[1], sourceField: '摘要' }]);
    assertEq(pickColumns(generate(main, database, repairTemplate.id, repairSource), ['Remark', 'Reference']), [['FT24123456', '123456']],
      '⑭ 两个特征值都修好后照常生成');

    // 模板已删除
    database.deleteTemplate(other.id);
    const goneApply = main.applyTemplateHeaderUpdate({
      templateId: other.id, expectedHeaders: OTHER_HEADERS, headers: ['日期', '金额'], sourceFileName: 'x.xlsx'
    });
    assertEq(goneApply.errorCode, 'TEMPLATE_NOT_FOUND', '③ 确认：模板已删除被拒');
    const gonePreview = main.prepareTemplateHeaderUpdate({ templateId: other.id, filePath: newTemplateFile });
    assertEq(gonePreview.errorCode, 'TEMPLATE_NOT_FOUND', '③ 预览：模板已删除被拒');
  } finally {
    try { database.close(); } catch (error) { console.error('关闭测试主库失败', error); }
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
