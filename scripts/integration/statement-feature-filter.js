// 网银账单：映射值「字段筛选特征值」e2e 集成验证（v3.2.16 引入；v3.2.18 起一个模板可有多个特征值）
//   覆盖：真实主库（迁移、特征值与映射读写）+ 真实 xlsx 读取与写出 + main.js 中的真实保存校验、生成配置与导入提示函数
//   ① 迁移：旧库无 feature_filter_json 列 → 启动补列；v3.2.16/3.2.17 的单套规则升级为「特征值1」，
//      主映射与拆分映射中选该值的行自动引用它，输出与升级前口径一致；重复启动幂等
//   ② 保存 → 读回 → 生成：两个字段分别选两个特征值各取各的值；未命中留空，提示按行计、报错文件逐个特征值列出；
//      收支均为空的行不重复提示；回读导出明细
//   ③ 【特征值管理】保存载荷：分配 id、改名不变 id、名称必填/不重复、未知 id 拒绝；
//      已保存的主映射或拆分映射仍在使用的特征值拒绝删除，未使用的可删除且 id 不复用
//   ④ 拒绝：未选特征值、所选特征值不存在、Currency / MerchantId / Balance 选该值、直接写库引用缺失后生成被拒
//   ⑤ 模板包：导出条目带特征值与各字段选择 → 读包 → 导入新库一致；用到该值时写 v7、旧版整包拒绝；
//      v6 旧包导入时单套规则升级为「特征值1」并补上引用；覆盖表头重建模板时特征值清空
//   ⑥ 拆分/合并「不复用」映射：拆分映射所选特征值在展开行生效；拆分映射引用缺失时保存主映射被拒；
//      主映射残留该值但不生效时不要求选特征值、不记未命中
//   ⑦ BillDate 取该值时，所选特征值源列里的“合计”标签仍按合计行跳过，合计金额不作为交易导出（资金红线回归）
//   ⑧ v3.2.22 新增分隔符 - _ $：保存 → 读回保留键名 → 生成按所选分隔符取值 → 回读导出明细
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-feature-filter.js

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
  FIXED_FIELD_VALUE_PREFIX,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
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
  validateFeeAmountFormula,
  validateBillSplitRowFilterRules,
  normalizeFeatureFilterList,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const { createTemplateHeaderUpdateTools } = require('../../src/main-process/template-header-update');
const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '附言', '币种', '收入', '支出', '账号'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference', 'Balance'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference'];
const SERIAL_RULE = { sourceField: '附言', separator: 'space', length: '10', letterPrefixCount: '2', digitsOnly: true, sample: 'FT24123456' };
const ORDER_RULE = { sourceField: '附言', separator: 'space', length: '', letterPrefixCount: '3', digitsOnly: true, sample: 'INV123456' };
const NORMALIZED_SERIAL = { sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT24123456' };

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
  'BALANCE_DISABLED_OPTION', 'BALANCE_CALCULATED_OPTION', 'MERCHANT_ID_SELF_INPUT_OPTION', 'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
  'MERCHANT_ID_CURRENCY_ONLY_OPTION',
  'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'LOGIC_VALUE_MAPPING_FIELD', 'CUSTOM_INPUT_TARGET_FIELDS',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'BILL_SPLIT_ROW_FILTER_MAPPING_FIELD', 'BILL_SPLIT_ROW_FILTER_ENABLED_OPTION',
  'PREPROCESS_ROW_FILTER_MAPPING_FIELD', 'PREPROCESS_ROW_FILTER_ENABLED_OPTION', 'DUPLICATE_ROW_FILTER_MAPPING_FIELD',
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'PREPROCESS_FIELDS',
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION', 'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS'
]);
const FEATURE = CONSTANTS.FEATURE_FILTER_MAPPING_FIELD;

function writeSource(filePath, rows, headers = HEADERS) {
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

function createMain(database, constantOverrides = {}) {
  return loadMainFunctions([
    'validateTemplateConfiguration', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
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
    'buildMappedFieldLookup',
    'normalizeLookupMappingValue',
    'buildStatementGenerationConfig', 'buildPreprocessRowFilterRules', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    'resolveStatementFeatureFilters',
    'buildBillSplitMergeConfig',
    'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile',
    'buildImportWarningDetailLines',
    'buildImportWarningMessage',
    'validateBillSplitMappingsPayload',
    'normalizeBundleTemplateHeaders',
    'normalizeBundleBillSplitMeta',
    'readTemplateBundleFile',
    'upgradeLegacyBundleFeatureFilterRefs',
    'resolveTemplateBundleVersion', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    // v3.2.16 同轮合入的「原始账单仅有币种无账户号」：校验、生成配置与模板包版本会引用
    'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig',
    'isCurrencyOnlyMerchantMapping'
  ], {
    ...CONSTANTS,
    ...constantOverrides,
    // v3.2.18：生成配置的失效映射拦截
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools({ ...CONSTANTS, ...constantOverrides }),
    database,
    fs,
    normalizeCell,
    // v3.2.19：拆分配置的费用账单公式（模板包读取、生成配置）
    normalizeFeeAmountFormula,
    normalizeFeeFieldMappings,
    validateFeeFieldMappings,
    isFeeFieldMappingTemplateFieldExcluded,
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
    expandBigAccountConfigurations: (items) => (Array.isArray(items) ? items : []),
    createStatementWorkbookReadGuard: () => undefined,
    buildBigAccountRecognitionBasis: () => null,
    finalizeBigAccountRecognitionBasis: () => null,
    formatBalanceGapLine: () => '',
    normalizeBundleAccountMappings: () => []
  });
}

// overrides 的值：字符串为映射值；{ feature: id } 表示选「字段筛选特征值」并选该特征值（id 为 '' 表示未选）。
function mappingsFor(overrides = {}) {
  const base = {
    BillDate: '交易日期',
    MerchantId: '账号',
    Currency: '币种',
    'Credit Amount': '收入',
    'Debit Amount': '支出',
    Remark: { feature: '1' },
    Reference: { feature: '2' },
    Balance: CONSTANTS.BALANCE_DISABLED_OPTION,
    ...overrides
  };
  return Object.entries(base).map(([templateField, value]) => (value && typeof value === 'object'
    ? { templateField, mappedField: FEATURE, mappedFields: value.feature ? [value.feature] : [], customValue: '' }
    : { templateField, mappedField: value, mappedFields: [], customValue: '' }));
}

function featureRefs(mappings) {
  return mappings.filter((m) => m.mappedField === FEATURE).map((m) => [m.templateField, m.mappedFields]);
}

// 与生产同一链路：getTemplateMappingConfig 的 exportMappings（normalizeExportMappingRows）→ buildStatementGenerationConfig
function generate(main, database, templateId, inputFilePath) {
  const template = database.getTemplate(templateId);
  const payload = database.getTemplateMappings(templateId);
  const config = main.buildStatementGenerationConfig({
    template,
    mappings: main.normalizeExportMappingRows({ template, mappings: payload.mappings, enumValues: ENUM_VALUES }),
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  return main.buildMappedRowsForFile({ config, inputFilePath });
}

function saveFeatureFilters(main, database, templateId, list) {
  const featureFilters = main.validateFeatureFiltersPayload(list, database.getTemplate(templateId));
  database.saveTemplateFeatureFilters(templateId, featureFilters);
  return featureFilters;
}

// ① 旧库补列；v3.2.16/3.2.17 单套规则升级；重复启动幂等
function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  let database = openDatabase(dbPath);
  const blank = database.upsertTemplate({ name: '旧模板', sourceFileName: '旧模板.xlsx', headers: HEADERS });
  const legacy = database.upsertTemplate({ name: 'BANKL-旧规则', sourceFileName: 'l.xlsx', headers: HEADERS });
  database.db.exec('ALTER TABLE templates DROP COLUMN feature_filter_json');
  assertEq(hasColumn(database.db, 'templates', 'feature_filter_json'), false, '① 模拟旧库：删除列');
  closeDatabase(database);

  database = openDatabase(dbPath);
  assertEq(hasColumn(database.db, 'templates', 'feature_filter_json'), true, '① 启动迁移补列');
  assertEq(database.getTemplate(blank.id).featureFilters, [], '① 无规则模板的特征值为空列表');

  // 按 v3.2.16/3.2.17 的存储形状写入：模板级单对象规则，映射行不带特征值 id
  database.db.prepare('UPDATE templates SET feature_filter_json = ? WHERE id = ?').run(JSON.stringify(NORMALIZED_SERIAL), legacy.id);
  const legacyMappings = mappingsFor({ Remark: { feature: '' }, Reference: { feature: '' } });
  database.saveMappings(legacy.id, legacyMappings, [], [], undefined, null, {});
  database.saveBillSplitMappings(legacy.id, [{ templateField: 'Remark', mappedField: FEATURE, mappedFields: [] }]);
  assertEq(featureRefs(database.getTemplateMappings(legacy.id).mappings), [['Remark', []], ['Reference', []]], '① 旧形状：映射行不带特征值');
  closeDatabase(database);

  database = openDatabase(dbPath);
  const expectedList = [{ id: '1', name: '特征值1', ...NORMALIZED_SERIAL }];
  assertEq(database.getTemplate(legacy.id).featureFilters, expectedList, '① 单套规则升级为「特征值1」');
  assertEq(featureRefs(database.getTemplateMappings(legacy.id).mappings), [['Remark', ['1']], ['Reference', ['1']]], '① 主映射行引用「特征值1」');
  assertEq(featureRefs(database.getBillSplitMappings(legacy.id)), [['Remark', ['1']]], '① 拆分映射行引用「特征值1」');

  const main = createMain(database);
  const sourcePath = path.join(dir, 'source-legacy.xlsx');
  writeSource(sourcePath, [['2026-11-01', '转账 FT24123456 附言', 'USD', '100', '', 'ACC1']]);
  assertEq(pickColumns(generate(main, database, legacy.id, sourcePath), ['Remark', 'Reference']), [['FT24123456', 'FT24123456']],
    '① 升级后两字段仍取同一个值（与升级前口径一致）');
  closeDatabase(database);

  database = openDatabase(dbPath);
  assertEq(database.getTemplate(legacy.id).featureFilters, expectedList, '① 重复启动：特征值不变');
  assertEq(featureRefs(database.getTemplateMappings(legacy.id).mappings), [['Remark', ['1']], ['Reference', ['1']]], '① 重复启动：引用不变');
  assertEq(database.getTemplate(blank.id).name, '旧模板', '① 重复启动不影响已有模板');
  closeDatabase(database);
}

// ② 两个特征值：保存 → 读回 → 生成 → 回读导出
function verifySaveAndGenerate(dir) {
  const database = openDatabase(path.join(dir, 'main.sqlite'));
  const main = createMain(database);
  const template = database.upsertTemplate({ name: 'BANKA-测试', sourceFileName: 'a.xlsx', headers: HEADERS });

  const saved = saveFeatureFilters(main, database, template.id, [{ name: '流水号', ...SERIAL_RULE }, { name: '订单号', ...ORDER_RULE }]);
  assertEq(saved.map((item) => [item.id, item.name, item.length, item.letterPrefixCount]), [['1', '流水号', 10, 2], ['2', '订单号', null, 3]],
    '② 特征值分配 id 并规范化条件');

  const validated = main.validateTemplateConfiguration({
    template: database.getTemplate(template.id), mappings: mappingsFor(), enumValues: ENUM_VALUES,
    featureFilters: database.getTemplate(template.id).featureFilters
  });
  assertEq(featureRefs(validated.mappings), [['Remark', ['1']], ['Reference', ['2']]], '② 保存校验保留各字段所选特征值');
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, {});
  assertEq(database.getTemplate(template.id).featureFilters.map((item) => item.name), ['流水号', '订单号'], '② 保存映射不改特征值');

  const uiRows = main.normalizeMappingRows({ template, mappings: database.getTemplateMappings(template.id).mappings, enumValues: ENUM_VALUES });
  assertEq(featureRefs(uiRows), [['Remark', ['1']], ['Reference', ['2']]], '② 映射弹窗回显所选特征值');
  const exportRows = main.normalizeExportMappingRows({ template, mappings: database.getTemplateMappings(template.id).mappings, enumValues: ENUM_VALUES });
  assertEq(featureRefs(exportRows), [['Remark', ['1']], ['Reference', ['2']]], '② 生成用映射（exportMappings）保留所选特征值');

  const sourcePath = path.join(dir, 'source-a.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', '转账 FT24123456 INV123456', 'USD', '100', '', 'ACC1'],
    ['2026-11-02', 'PAY/FT24999999  ZZ12345678 ABC987', 'USD', '', '50', 'ACC1'],
    ['2026-11-03', '无编号', 'USD', '20', '', 'ACC1'],
    ['2026-11-04', '无编号 FT0', 'USD', '', '', 'ACC1']
  ]);
  const detailRows = generate(main, database, template.id, sourcePath);
  assertEq(pickColumns(detailRows, ['Remark', 'Reference']), [
    ['FT24123456', 'INV123456'],
    ['ZZ12345678', 'ABC987'],
    ['', ''],
    ['', '']
  ], '② 两字段按各自特征值取值、取第一个命中段、未命中留空');

  const missIssues = detailRows.issues.filter((issue) => issue.type === 'feature-value-unmatched');
  assertEq(missIssues.map((issue) => [issue.rowNumber, issue.misses.map((miss) => [miss.featureName, miss.sourceField, miss.rawValue])]),
    [[4, [['流水号', '附言', '无编号'], ['订单号', '附言', '无编号']]]],
    '② 只为有收支的未命中行记提示，逐个特征值列出');
  const detailLines = main.buildImportWarningDetailLines(detailRows.issues);
  assertTrue(detailLines.includes('第4行，特征值“流水号”，源字段“附言”，原值“无编号”')
    && detailLines.includes('第4行，特征值“订单号”，源字段“附言”，原值“无编号”'), '② 报错文件逐个特征值列出');
  assertTrue(
    main.buildImportWarningMessage({ warnings: detailRows.issues, balanceReady: false, balanceRequested: false })
      .includes('1行未筛出特征值，相关字段已留空'),
    '② 导入提示按行汇总未命中'
  );

  const outputPath = path.join(dir, 'detail-a.xlsx');
  writeWorkbookRows({ rows: buildDetailExportRows(detailRows), outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  assertEq(
    exported.rows.map((row) => [row[exported.header.indexOf('Remark')], row[exported.header.indexOf('Reference')]]),
    [['FT24123456', 'INV123456'], ['ZZ12345678', 'ABC987'], ['', '']],
    '② 回读导出明细（收支均空的行已过滤）'
  );
  return { database, main, template };
}

// ③ 【特征值管理】保存载荷：改名、校验、删除守卫
function verifyFeatureFilterManagement(dir, { database, main, template }) {
  const current = database.getTemplate(template.id).featureFilters;
  const renamed = saveFeatureFilters(main, database, template.id, current.map((item) => (item.id === '2' ? { ...item, name: '订单编号' } : item)));
  assertEq(renamed.map((item) => [item.id, item.name]), [['1', '流水号'], ['2', '订单编号']], '③ 改名不变 id');
  const sourcePath = path.join(dir, 'source-a2.xlsx');
  writeSource(sourcePath, [['2026-11-05', 'FT24123456 无订单', 'USD', '1', '', 'ACC1']]);
  const rows = generate(main, database, template.id, sourcePath);
  assertEq(rows.issues.filter((issue) => issue.type === 'feature-value-unmatched')[0].misses.map((miss) => miss.featureName), ['订单编号'],
    '③ 改名后映射沿用、提示用新名');

  const latest = () => database.getTemplate(template.id);
  assertThrows(() => main.validateFeatureFiltersPayload(renamed.concat([{ name: '流水号', ...SERIAL_RULE }]), latest()),
    /特征值名「流水号」已存在/, '③ 名称重复被拒');
  assertThrows(() => main.validateFeatureFiltersPayload(renamed.concat([{ name: ' ', ...SERIAL_RULE }]), latest()),
    /请输入特征值名/, '③ 名称为空被拒');
  assertThrows(() => main.validateFeatureFiltersPayload(renamed.concat([{ id: '99', name: '幽灵', ...SERIAL_RULE }]), latest()),
    /特征值「幽灵」不存在或已被删除/, '③ 未知 id 被拒');
  assertThrows(() => main.validateFeatureFiltersPayload(renamed.concat([{ name: '坏', ...SERIAL_RULE, sourceField: '备注' }]), latest()),
    /特征值「坏」：筛选字段不存在：备注/, '③ 筛选字段不在表头被拒');

  assertThrows(() => main.validateFeatureFiltersPayload(renamed.filter((item) => item.id !== '1'), latest()),
    /特征值「流水号」正被 Remark 使用，请先改选其他特征值后再删除/, '③ 已保存主映射在用：拒绝删除');
  database.saveBillSplitMappings(template.id, [{ templateField: 'Remark', mappedField: FEATURE, mappedFields: ['2'] }]);
  assertThrows(() => main.validateFeatureFiltersPayload(renamed.filter((item) => item.id !== '2'), latest()),
    /特征值「订单编号」正被 Reference、Remark（拆分\/合并映射） 使用/, '③ 主映射与拆分映射在用：拒绝删除并列出字段');
  assertEq(latest().featureFilters.length, 2, '③ 拒绝删除时库中不变');

  const added = saveFeatureFilters(main, database, template.id, renamed.concat([{ name: '临时', ...SERIAL_RULE, length: '6', letterPrefixCount: '', sample: '' }]));
  assertEq(added.map((item) => item.id), ['1', '2', '3'], '③ 新增特征值 id 递增');
  const afterDelete = saveFeatureFilters(main, database, template.id, added.filter((item) => item.id !== '3'));
  assertEq(afterDelete.map((item) => item.id), ['1', '2'], '③ 未被使用的特征值可删除');
  const readded = saveFeatureFilters(main, database, template.id, afterDelete.concat([{ name: '再加', ...SERIAL_RULE }]));
  assertEq(readded.map((item) => item.id), ['1', '2', '3'], '③ 删除后再新增按当前最大 id 递增');
  saveFeatureFilters(main, database, template.id, readded.filter((item) => item.id !== '3'));
  database.saveBillSplitMappings(template.id, []);
}

// ④ 映射保存与生成的拒绝
function verifyRejections(dir, { database, main, template }) {
  const featureFilters = database.getTemplate(template.id).featureFilters;
  const validate = (mappings, extra = {}) => main.validateTemplateConfiguration({
    template, mappings, enumValues: ENUM_VALUES, featureFilters, ...extra
  });
  assertThrows(() => validate(mappingsFor({ Reference: { feature: '' } })), /Reference 选择了「字段筛选特征值」，请选择特征值/, '④ 未选特征值：保存被拒');
  assertThrows(() => validate(mappingsFor({ Reference: { feature: '9' } })), /Reference 选择的特征值不存在，请重新选择/, '④ 所选特征值不存在：保存被拒');
  ['Currency', 'MerchantId', 'Balance'].forEach((field) => {
    assertThrows(() => validate(mappingsFor({ [field]: { feature: '1' } })), new RegExp(`${field} 不支持使用`), `④ ${field} 选该值被拒`);
  });
  assertEq(featureRefs(validate(mappingsFor({ Remark: '附言', Reference: '' })).mappings), [], '④ 未使用时无需特征值');

  const stale = database.upsertTemplate({ name: 'BANKB-引用缺失', sourceFileName: 'b.xlsx', headers: HEADERS });
  database.saveMappings(stale.id, mappingsFor({ Reference: { feature: '7' } }), [], [], undefined, null, {});
  const sourcePath = path.join(dir, 'source-b.xlsx');
  writeSource(sourcePath, [['2026-11-01', 'FT24123456', 'USD', '1', '', 'ACC1']]);
  assertThrows(() => generate(main, database, stale.id, sourcePath), /Remark 选择的特征值不存在/, '④ 直接写库引用缺失：生成被拒');

  assertThrows(() => main.validateBillSplitMappingsPayload([{ templateField: 'Balance', mappedField: FEATURE }], template),
    /Balance 不支持使用/, '④ 拆分映射 Balance 选该值被拒');
  const splitValidated = main.validateBillSplitMappingsPayload([
    { templateField: 'Remark', mappedField: FEATURE, mappedFields: ['1', '附言'] },
    { templateField: 'Reference', mappedField: FEATURE, mappedFields: [] }
  ], template);
  assertEq(featureRefs(splitValidated), [['Remark', ['1']], ['Reference', []]], '④ 拆分映射只保留所选特征值 id、不报字段不存在');
  assertThrows(() => resolveUsedFeatureFilters(featureFilters, main.collectFeatureFilterRefs(splitValidated), { headers: HEADERS }),
    /Reference 选择了「字段筛选特征值」，请选择特征值/, '④ 拆分映射保存：未选特征值被拒');
}

// ⑤ 模板包导出 → 读包 → 导入新库；v6 旧包升级；覆盖表头重建时特征值清空
function verifyBundleRoundTrip(dir, { database, main, template }) {
  const entry = database.listTemplateBundleEntries().find((item) => item.name === template.name);
  assertEq(entry.featureFilters.map((item) => [item.id, item.name]), [['1', '流水号'], ['2', '订单编号']], '⑤ 导出条目带特征值');
  assertEq(featureRefs(entry.mappings), [['Remark', ['1']], ['Reference', ['2']]], '⑤ 导出条目映射带所选特征值');
  const plainEntry = { mappings: [{ templateField: 'Remark', mappedField: '附言' }], billSplitMappings: [] };
  const splitOnlyEntry = { mappings: plainEntry.mappings, billSplitMappings: [{ templateField: 'Reference', mappedField: FEATURE, mappedFields: ['1'] }] };
  assertEq(
    [main.resolveTemplateBundleVersion([plainEntry]), main.resolveTemplateBundleVersion([entry]), main.resolveTemplateBundleVersion([plainEntry, splitOnlyEntry])],
    [5, 7, 7],
    '⑤ 用到该值（含只在拆分映射中用到）时包写 v7，未用到时写 v5'
  );
  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.featureFilters, entry.featureFilters, '⑤ 读包保留特征值');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 6, FEATURE_FILTER_BUNDLE_VERSION: 6 });
  assertThrows(() => legacyReader.readTemplateBundleFile(bundlePath), /模板文件版本（7）高于当前应用支持的版本（6）/, '⑤ 旧版（支持到 v6）读 v7 包整包拒绝');

  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const importEntry = (readTarget) => {
    const draftTemplate = { id: null, templateKey: readTarget.templateKey, name: readTarget.name, sourceFileName: readTarget.sourceFileName, headers: readTarget.headers, createdAt: '', updatedAt: '' };
    // 与 template:import-bundle 一致：包内特征值不按表头校验，生效映射所选的由 validateTemplateConfiguration 按表头校验
    const bundleFeatureFilters = normalizeFeatureFilterList(readTarget.featureFilters || []);
    const validated = targetMain.validateTemplateConfiguration({
      template: draftTemplate,
      mappings: targetMain.normalizeMappingRows({ template: draftTemplate, mappings: readTarget.mappings, enumValues: ENUM_VALUES }),
      enumValues: ENUM_VALUES,
      featureFilters: bundleFeatureFilters,
      billSplitMappings: readTarget.billSplitMappings
    });
    const imported = target.upsertTemplate({ templateKey: readTarget.templateKey, name: readTarget.name, sourceFileName: readTarget.sourceFileName, headers: readTarget.headers });
    target.saveMappings(imported.id, validated.mappings, [], [], readTarget.dateFormat, [], { preserveOwn: false, featureFilters: bundleFeatureFilters });
    return imported;
  };
  const imported = importEntry(readEntry);
  assertEq(target.getTemplate(imported.id).featureFilters, database.getTemplate(template.id).featureFilters, '⑤ 导入后特征值一致（含 id）');
  assertEq(featureRefs(target.getTemplateMappings(imported.id).mappings), [['Remark', ['1']], ['Reference', ['2']]], '⑤ 导入后各字段选择一致');

  // 映射都没选用特征值的模板仍写 v5，但须带上全部特征值（spec §3.5）
  const unusedEntry = {
    ...entry,
    templateKey: 'unused-template',
    name: 'BANKU-未选用',
    mappings: entry.mappings.map((m) => (m.mappedField === FEATURE ? { ...m, mappedField: '附言', mappedFields: [] } : m)),
    billSplitMappings: []
  };
  const unusedPath = path.join(dir, 'bundle-unused.json');
  fs.writeFileSync(unusedPath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([unusedEntry]), channels: [], templates: [unusedEntry] }), 'utf8');
  assertEq(JSON.parse(fs.readFileSync(unusedPath, 'utf8')).bundleVersion, 5, '⑤ 未选用特征值的包仍写 v5');
  const unusedRead = main.readTemplateBundleFile(unusedPath).templates[0];
  assertEq(unusedRead.featureFilters, entry.featureFilters, '⑤ v5 包读回未选用的特征值');
  const importedUnused = importEntry(unusedRead);
  assertEq(target.getTemplate(importedUnused.id).featureFilters, database.getTemplate(template.id).featureFilters, '⑤ 导入 v5 包保留未选用的特征值');

  // 模板【更新】后带「未被选用、筛选字段已不在表头」的特征值：照常导入；主映射选用了它则被拒（该模板跳过）
  const staleFilters = entry.featureFilters.map((item) => (item.id === '1' ? { ...item, sourceField: '已删除列' } : item));
  const staleUnusedEntry = { ...unusedEntry, templateKey: 'stale-unused', name: 'BANKS-失效未用', featureFilters: staleFilters };
  const importedStale = importEntry(staleUnusedEntry);
  assertEq(target.getTemplate(importedStale.id).featureFilters.map((item) => [item.id, item.sourceField]),
    [['1', '已删除列'], ['2', entry.featureFilters[1].sourceField]], '⑤ 未选用的失效特征值不阻止导入，原样保留');
  assertThrows(() => importEntry({ ...entry, templateKey: 'stale-used', name: 'BANKS-失效已用', featureFilters: staleFilters }),
    /特征值「流水号」：筛选字段不存在：已删除列/, '⑤ 主映射选用了失效特征值时导入被拒');

  // v3.2.16/3.2.17 导出的 v6 包：单套 featureFilter，映射行不带 id
  const v6Path = path.join(dir, 'bundle-v6.json');
  fs.writeFileSync(v6Path, JSON.stringify({
    bundleVersion: 6,
    channels: [],
    templates: [{
      ...entry,
      templateKey: 'v6-template',
      name: 'BANKV6-旧包',
      featureFilters: undefined,
      featureFilter: NORMALIZED_SERIAL,
      mappings: entry.mappings.map((m) => (m.mappedField === FEATURE ? { ...m, mappedFields: [] } : m)),
      billSplitMappings: [{ templateField: 'Remark', mappedField: FEATURE, mappedFields: [] }]
    }]
  }), 'utf8');
  const v6Entry = main.readTemplateBundleFile(v6Path).templates[0];
  assertEq(v6Entry.featureFilters, [{ id: '1', name: '特征值1', ...NORMALIZED_SERIAL }], '⑤ v6 包：单套规则升级为「特征值1」');
  assertEq([featureRefs(v6Entry.mappings), featureRefs(v6Entry.billSplitMappings)],
    [[['Remark', ['1']], ['Reference', ['1']]], [['Remark', ['1']]]], '⑤ v6 包：主映射与拆分映射补上引用');
  const importedV6 = importEntry(v6Entry);
  const v6Source = path.join(dir, 'source-v6.xlsx');
  writeSource(v6Source, [['2026-11-01', 'FT24123456 INV123456', 'USD', '9', '', 'ACC1']]);
  assertEq(pickColumns(generate(targetMain, target, importedV6.id, v6Source), ['Remark', 'Reference']), [['FT24123456', 'FT24123456']],
    '⑤ v6 包导入后两字段仍取同一个值');

  target.upsertTemplate({ templateKey: readEntry.templateKey, name: readEntry.name, sourceFileName: 'new.xlsx', headers: ['日期', '摘要'] });
  assertEq(target.getTemplate(imported.id).featureFilters, [], '⑤ 覆盖表头重建模板：特征值清空');
  assertEq(target.getTemplateMappings(imported.id).mappings.length, 0, '⑤ 覆盖表头重建模板：映射清空');
}

// ⑥ 拆分/合并「不复用」：拆分映射所选特征值生效
function verifyBillSplitNotReuse(dir, { database, main }) {
  const template = database.upsertTemplate({ name: 'BANKC-拆分', sourceFileName: 'c.xlsx', headers: HEADERS });
  saveFeatureFilters(main, database, template.id, [{ name: '编号', sourceField: '附言', separator: 'slash', digitsOnly: true, length: '6' }]);
  const splitMainOverrides = {
    Currency: '',
    'Credit Amount': '',
    'Debit Amount': '',
    Remark: '附言',
    Reference: '',
    [CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD]: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION,
    [CONSTANTS.REUSE_MODULE_MAPPING_FIELD]: '否'
  };
  const featureFilters = () => database.getTemplate(template.id).featureFilters;
  const validated = main.validateTemplateConfiguration({
    template, mappings: mappingsFor(splitMainOverrides), enumValues: ENUM_VALUES, featureFilters: featureFilters()
  });
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, {});

  const billSplitMappings = main.validateBillSplitMappingsPayload([
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Reference', mappedField: FEATURE, mappedFields: ['1'] }
  ], template);
  resolveUsedFeatureFilters(featureFilters(), main.collectFeatureFilterRefs(billSplitMappings), { headers: HEADERS });
  database.saveBillSplitMappings(template.id, billSplitMappings);
  assertEq(featureRefs(database.getBillSplitMappings(template.id)), [['Reference', ['1']]], '⑥ 拆分映射保存所选特征值');

  database.saveBillSplitRowCount(template.id, 1);
  database.saveBillSplitRow(template.id, { seqNo: 1, currencySourceField: '币种', creditSourceField: '收入', debitSourceField: '支出', amountSourceField: '', rowStatus: 'completed' });

  const sourcePath = path.join(dir, 'source-c.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', 'INV/123456/备注', 'USD', '10', '', 'ACC9'],
    ['2026-11-02', 'INV/12345', 'USD', '', '5', 'ACC9']
  ]);
  const detailRows = generate(main, database, template.id, sourcePath);
  assertEq(pickColumns(detailRows, ['Reference', 'Remark', 'Credit Amount', 'Debit Amount']), [
    ['123456', '', '10', ''],
    ['', '', '', '5']
  ], '⑥ 不复用时展开行按拆分映射所选特征值取值');
  assertEq(
    detailRows.issues.filter((issue) => issue.type === 'feature-value-unmatched').map((issue) => [issue.rowNumber, issue.misses[0].featureName]),
    [[3, '编号']],
    '⑥ 拆分路径未命中行记提示'
  );

  const staleSplit = [{ templateField: 'Reference', mappedField: FEATURE, mappedFields: ['5'] }];
  assertThrows(() => main.validateTemplateConfiguration({
    template, mappings: mappingsFor(splitMainOverrides), enumValues: ENUM_VALUES, featureFilters: featureFilters(), billSplitMappings: staleSplit
  }), /拆分\/合并账单映射关系设置中的 Reference 选择的特征值不存在/, '⑥ 不复用的拆分映射引用缺失：保存主映射被拒');
  assertEq(
    featureRefs(main.validateTemplateConfiguration({
      template,
      mappings: mappingsFor({ ...splitMainOverrides, [CONSTANTS.REUSE_MODULE_MAPPING_FIELD]: '是' }),
      enumValues: ENUM_VALUES,
      featureFilters: featureFilters(),
      billSplitMappings: staleSplit
    }).mappings),
    [],
    '⑥ 复用模块映射时拆分映射不生效，不校验其特征值'
  );

  // 主映射残留该值（未选特征值）、拆分映射（不复用）未用：可保存、不记未命中
  const residual = database.upsertTemplate({ name: 'BANKD-残留', sourceFileName: 'd.xlsx', headers: HEADERS });
  const residualMappings = mappingsFor({ ...splitMainOverrides, Remark: { feature: '' } });
  assertEq(
    featureRefs(main.validateTemplateConfiguration({
      template: residual, mappings: residualMappings, enumValues: ENUM_VALUES, featureFilters: [], billSplitMappings: []
    }).mappings),
    [['Remark', []]],
    '⑥ 主映射残留该值但不生效：未选特征值也可保存（与生成口径一致）'
  );
  database.saveMappings(residual.id, residualMappings, [], [], undefined, null, {});
  database.saveBillSplitMappings(residual.id, [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Remark', mappedField: '附言', mappedFields: [] }
  ]);
  database.saveBillSplitRowCount(residual.id, 1);
  database.saveBillSplitRow(residual.id, { seqNo: 1, currencySourceField: '币种', creditSourceField: '收入', debitSourceField: '支出', amountSourceField: '', rowStatus: 'completed' });
  const residualRows = generate(main, database, residual.id, sourcePath);
  assertEq(pickColumns(residualRows, ['Remark']), [['INV/123456/备注'], ['INV/12345']], '⑥ 不复用时按拆分映射直接取列');
  assertEq(residualRows.issues.filter((issue) => issue.type === 'feature-value-unmatched').length, 0, '⑥ 主映射残留该值不记未命中提示');
}

// ⑦ BillDate 取该值且所选特征值源列含合计标签：按合计行跳过，不导出合计金额
function verifySummaryRowWithFeatureBillDate(dir, { database, main }) {
  const template = database.upsertTemplate({ name: 'BANKE-合计', sourceFileName: 'e.xlsx', headers: HEADERS });
  saveFeatureFilters(main, database, template.id, [
    { name: '账号尾号', sourceField: '账号', separator: '', digitsOnly: true },
    { name: '日期', sourceField: '附言', separator: 'space', length: '10' }
  ]);
  const validated = main.validateTemplateConfiguration({
    template,
    mappings: mappingsFor({ BillDate: { feature: '2' }, Remark: '附言', Reference: { feature: '1' } }),
    enumValues: ENUM_VALUES,
    featureFilters: database.getTemplate(template.id).featureFilters
  });
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, {});
  const sourcePath = path.join(dir, 'source-e.xlsx');
  writeSource(sourcePath, [
    ['', '转账 2026-11-01', 'USD', '100', '', '6222'],
    ['', '合计', 'USD', '100', '', '6222']
  ]);
  const detailRows = generate(main, database, template.id, sourcePath);
  assertEq(pickColumns(detailRows, ['BillDate', 'Credit Amount', 'Remark', 'Reference']), [['2026-11-01', '100', '转账 2026-11-01', '6222']],
    '⑦ 合计行不作为交易导出（按 BillDate 所选特征值的源列识别）');
  assertEq(
    detailRows.issues.map((issue) => [issue.type, issue.rowNumber, issue.rawValue]),
    [['summary-row-skipped', 3, '合计']],
    '⑦ 记为跳过的合计行，不记未命中'
  );
}

// ⑧ v3.2.22 新增分隔符：保存 → 读回 → 生成 → 回读导出
function verifyNewSeparators(dir, { database, main }) {
  const template = database.upsertTemplate({ name: 'BANKF-分隔符', sourceFileName: 'f.xlsx', headers: HEADERS });
  saveFeatureFilters(main, database, template.id, [
    { name: '流水号', sourceField: '附言', separator: 'dollar', length: '10', letterPrefixCount: '2', digitsOnly: true, sample: 'FT24123456' },
    { name: '订单号', sourceField: '附言', separator: 'hyphen', length: '6', digitsOnly: true, sample: '123456' },
    { name: '批次号', sourceField: '附言', separator: 'underscore', letterPrefixCount: '1', length: '4' }
  ]);
  assertEq(database.getTemplate(template.id).featureFilters.map((item) => [item.id, item.name, item.separator]),
    [['1', '流水号', 'dollar'], ['2', '订单号', 'hyphen'], ['3', '批次号', 'underscore']], '⑧ 新分隔符保存后读回保留键名');
  const validated = main.validateTemplateConfiguration({
    template,
    mappings: mappingsFor({ Remark: { feature: '1' }, Reference: { feature: '2' } }),
    enumValues: ENUM_VALUES,
    featureFilters: database.getTemplate(template.id).featureFilters
  });
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, {});
  const sourcePath = path.join(dir, 'source-f.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', 'PAY$FT24123456$X-123456-Y', 'USD', '100', '', 'ACC1'],
    ['2026-11-02', 'FT24999999-654321', 'USD', '', '30', 'ACC1']
  ]);
  const detailRows = generate(main, database, template.id, sourcePath);
  assertEq(pickColumns(detailRows, ['Remark', 'Reference']), [['FT24123456', '123456'], ['', '654321']],
    '⑧ 按 $ / - 拆段取值；未出现 $ 时整格不满足条件留空');
  const outputPath = path.join(dir, 'detail-f.xlsx');
  writeWorkbookRows({ rows: buildDetailExportRows(detailRows), outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  assertEq(
    exported.rows.map((row) => [row[exported.header.indexOf('Remark')], row[exported.header.indexOf('Reference')]]),
    [['FT24123456', '123456'], ['', '654321']],
    '⑧ 回读导出明细'
  );
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-feature-filter-'));
  try {
    verifyMigration(dir);
    const context = verifySaveAndGenerate(dir);
    verifyFeatureFilterManagement(dir, context);
    verifyRejections(dir, context);
    verifyBundleRoundTrip(dir, context);
    verifyBillSplitNotReuse(dir, context);
    verifySummaryRowWithFeatureBillDate(dir, context);
    verifyNewSeparators(dir, context);
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
