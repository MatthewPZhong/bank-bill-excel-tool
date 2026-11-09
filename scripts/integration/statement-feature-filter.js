// 网银账单：映射值「字段筛选特征值」（v3.2.16）e2e 集成验证
//   覆盖：真实主库（迁移、模板级规则读写）+ 真实 xlsx 读取与写出 + main.js 中的真实保存校验、生成配置与导入提示函数
//   ① 迁移：旧库无 feature_filter_json 列 → 启动补列，已有模板规则为 null；重复启动无副作用
//   ② 保存 → 读回 → 生成：两个目标字段共用一套规则、取第一个命中段；未命中留空，提示与报错文件列出该行；
//      收支均为空的行不重复提示；回读导出明细
//   ③ 拒绝：缺规则、筛选字段不存在、Currency / MerchantId / Balance 选该值、直接写库缺规则后生成被拒
//   ④ 模板包：导出条目带规则 → 读包 → 导入新库后规则与映射一致；覆盖表头重建模板时规则清空；
//      用到该值（含只在拆分映射中用到）时包写 v6，旧版读包整包拒绝，未用到时仍写 v5
//   ⑤ 拆分/合并「不复用」映射：只有拆分映射用该值时，规则随拆分映射保存并在展开行生效；
//      规则缺失时保存主映射被拒；主映射残留该值但拆分映射未用时不要求规则、不记未命中
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
  buildMappedRows,
  FEATURE_FILTER_FIELD_TOKEN,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  normalizeCell,
  normalizeFeatureFilterRule,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const { splitTemplateName } = require('../../src/backend/balance-seed-store');
const channelIdentity = require('../../src/main-process/statement-channel-identity');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '附言', '币种', '收入', '支出', '账号'];
const ENUM_VALUES = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference', 'Balance'];
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark', 'Reference'];
const RULE_INPUT = { sourceField: '附言', separator: 'space', length: '10', letterPrefixCount: '2', digitsOnly: true, sample: 'FT24123456' };

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
  'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'CUSTOM_INPUT_TARGET_FIELDS',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'SUPPORTED_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION', 'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS'
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
    'validateTemplateConfiguration',
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
    'buildStatementGenerationConfig',
    'resolveStatementFeatureFilter',
    'buildBillSplitMergeConfig',
    'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile',
    'buildImportWarningDetailLines',
    'buildImportWarningMessage',
    'validateBillSplitMappingsPayload',
    'normalizeBundleTemplateHeaders',
    'readTemplateBundleFile',
    'resolveTemplateBundleVersion'
  ], {
    ...CONSTANTS,
    ...constantOverrides,
    database,
    fs,
    normalizeCell,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX,
    FEATURE_FILTER_FIELD_TOKEN,
    normalizeFeatureFilterRule,
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

function mappingsFor(overrides = {}) {
  const base = {
    BillDate: '交易日期',
    MerchantId: '账号',
    Currency: '币种',
    'Credit Amount': '收入',
    'Debit Amount': '支出',
    Remark: FEATURE,
    Reference: FEATURE,
    Balance: CONSTANTS.BALANCE_DISABLED_OPTION,
    ...overrides
  };
  return Object.entries(base).map(([templateField, mappedField]) => ({ templateField, mappedField, mappedFields: [], customValue: '' }));
}

function generate(main, database, templateId, inputFilePath) {
  const template = database.getTemplate(templateId);
  const payload = database.getTemplateMappings(templateId);
  const exportMappings = main.normalizeExportMappingRows({ template, mappings: payload.mappings, enumValues: ENUM_VALUES });
  const config = main.buildStatementGenerationConfig({
    template,
    mappings: exportMappings,
    orderedTargetFields: ORDERED_FIELDS,
    allowManagedMerchantWithoutSelection: true
  });
  return main.buildMappedRowsForFile({ config, inputFilePath });
}

// ① 旧库补列、重复启动幂等
function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  let database = openDatabase(dbPath);
  const template = database.upsertTemplate({ name: '旧模板', sourceFileName: '旧模板.xlsx', headers: HEADERS });
  database.db.exec('ALTER TABLE templates DROP COLUMN feature_filter_json');
  assertEq(hasColumn(database.db, 'templates', 'feature_filter_json'), false, '① 模拟旧库：删除列');
  closeDatabase(database);

  database = openDatabase(dbPath);
  assertEq(hasColumn(database.db, 'templates', 'feature_filter_json'), true, '① 启动迁移补列');
  assertEq(database.getTemplate(template.id).featureFilter, null, '① 旧模板规则为 null');
  closeDatabase(database);

  database = openDatabase(dbPath);
  assertEq(hasColumn(database.db, 'templates', 'feature_filter_json'), true, '① 重复启动后列仍在');
  assertEq(database.getTemplate(template.id).name, '旧模板', '① 重复启动不影响已有模板');
  closeDatabase(database);
}

// ② 保存 → 读回 → 生成 → 回读导出
function verifySaveAndGenerate(dir) {
  const database = openDatabase(path.join(dir, 'main.sqlite'));
  const main = createMain(database);
  const template = database.upsertTemplate({ name: 'BANKA-测试', sourceFileName: 'a.xlsx', headers: HEADERS });

  const validated = main.validateTemplateConfiguration({
    template, mappings: mappingsFor(), enumValues: ENUM_VALUES, featureFilter: RULE_INPUT
  });
  const expectedRule = { sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT24123456' };
  assertEq(validated.featureFilter, expectedRule, '② 保存校验返回规范化规则');
  assertEq(
    validated.mappings.filter((m) => m.mappedField === FEATURE).map((m) => [m.templateField, m.mappedFields]),
    [['Remark', []], ['Reference', []]],
    '② 两个目标字段保存为字段筛选特征值、不带源字段'
  );
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, { featureFilter: validated.featureFilter });

  const saved = database.getTemplate(template.id);
  assertEq(saved.featureFilter, expectedRule, '② 读回模板级规则');
  const uiRows = main.normalizeMappingRows({ template: saved, mappings: database.getTemplateMappings(template.id).mappings, enumValues: ENUM_VALUES });
  assertEq(uiRows.filter((m) => m.mappedField === FEATURE).map((m) => m.templateField), ['Remark', 'Reference'], '② 映射弹窗回显');

  const sourcePath = path.join(dir, 'source-a.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', '转账 FT24123456 附言', 'USD', '100', '', 'ACC1'],
    ['2026-11-02', 'PAY/FT24999999  ZZ12345678 AB87654321', 'USD', '', '50', 'ACC1'],
    ['2026-11-03', '无编号', 'USD', '20', '', 'ACC1'],
    ['2026-11-04', '无编号 FT0', 'USD', '', '', 'ACC1']
  ]);
  const detailRows = generate(main, database, template.id, sourcePath);
  assertEq(pickColumns(detailRows, ['Remark', 'Reference']), [
    ['FT24123456', 'FT24123456'],
    ['ZZ12345678', 'ZZ12345678'],
    ['', ''],
    ['', '']
  ], '② 两字段共用同一值、取第一个命中段、未命中留空');

  const missIssues = detailRows.issues.filter((issue) => issue.type === 'feature-value-unmatched');
  assertEq(missIssues.map((issue) => [issue.rowNumber, issue.sourceField, issue.rawValue]), [[4, '附言', '无编号']], '② 只为有收支的未命中行记提示');
  const detailLines = main.buildImportWarningDetailLines(detailRows.issues);
  assertTrue(detailLines.includes('第4行，源字段“附言”，原值“无编号”'), '② 报错文件逐行列出未命中行');
  assertTrue(
    main.buildImportWarningMessage({ warnings: detailRows.issues, balanceReady: false, balanceRequested: false })
      .includes('1行未筛出特征值，相关字段已留空'),
    '② 导入提示汇总未命中行数'
  );

  const outputPath = path.join(dir, 'detail-a.xlsx');
  writeWorkbookRows({ rows: buildDetailExportRows(detailRows), outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  assertEq(
    exported.rows.map((row) => [row[exported.header.indexOf('Remark')], row[exported.header.indexOf('Reference')]]),
    [['FT24123456', 'FT24123456'], ['ZZ12345678', 'ZZ12345678'], ['', '']],
    '② 回读导出明细（收支均空的行已过滤）'
  );
  return { database, main, template };
}

// ③ 各类拒绝
function verifyRejections(dir, { database, main, template }) {
  assertThrows(() => main.validateTemplateConfiguration({
    template, mappings: mappingsFor(), enumValues: ENUM_VALUES, featureFilter: null
  }), /尚未设置筛选条件/, '③ 用到该值但缺规则：保存被拒');
  assertThrows(() => main.validateTemplateConfiguration({
    template, mappings: mappingsFor(), enumValues: ENUM_VALUES, featureFilter: { ...RULE_INPUT, sourceField: '备注' }
  }), /筛选字段不存在：备注/, '③ 筛选字段不在模板表头：保存被拒');
  ['Currency', 'MerchantId', 'Balance'].forEach((field) => {
    assertThrows(() => main.validateTemplateConfiguration({
      template, mappings: mappingsFor({ [field]: FEATURE }), enumValues: ENUM_VALUES, featureFilter: RULE_INPUT
    }), new RegExp(`${field} 不支持使用`), `③ ${field} 选该值被拒`);
  });
  const unused = main.validateTemplateConfiguration({
    template, mappings: mappingsFor({ Remark: '附言', Reference: '' }), enumValues: ENUM_VALUES, featureFilter: { sourceField: '附言' }
  });
  assertEq(unused.featureFilter, null, '③ 未使用时无效规则不写入');

  const bare = database.upsertTemplate({ name: 'BANKB-缺规则', sourceFileName: 'b.xlsx', headers: HEADERS });
  database.saveMappings(bare.id, mappingsFor().map((m) => ({ templateField: m.templateField, mappedField: m.mappedField, mappedFields: [] })), [], [], undefined, null, {});
  const sourcePath = path.join(dir, 'source-b.xlsx');
  writeSource(sourcePath, [['2026-11-01', 'FT24123456', 'USD', '1', '', 'ACC1']]);
  assertThrows(() => generate(main, database, bare.id, sourcePath), /尚未设置筛选条件/, '③ 直接写库缺规则：生成被拒');

  assertThrows(() => main.validateBillSplitMappingsPayload([{ templateField: 'Balance', mappedField: FEATURE }], template),
    /Balance 不支持使用/, '③ 拆分映射 Balance 选该值被拒');
  assertEq(
    main.validateBillSplitMappingsPayload([{ templateField: 'Remark', mappedField: FEATURE, mappedFields: ['附言'] }], template)
      .map((m) => [m.templateField, m.mappedField, m.mappedFields]),
    [['Remark', FEATURE, []]],
    '③ 拆分映射该值不带源字段、不报字段不存在'
  );
}

// ④ 模板包导出 → 读包 → 导入新库；覆盖表头重建时规则清空
function verifyBundleRoundTrip(dir, { database, main, template }) {
  const entry = database.listTemplateBundleEntries().find((item) => item.name === template.name);
  assertEq(entry.featureFilter && entry.featureFilter.sourceField, '附言', '④ 导出条目带规则');
  const plainEntry = { mappings: [{ templateField: 'Remark', mappedField: '附言' }], billSplitMappings: [] };
  const splitOnlyEntry = { mappings: plainEntry.mappings, billSplitMappings: [{ templateField: 'Reference', mappedField: FEATURE }] };
  assertEq(
    [main.resolveTemplateBundleVersion([plainEntry]), main.resolveTemplateBundleVersion([entry]), main.resolveTemplateBundleVersion([plainEntry, splitOnlyEntry])],
    [5, 6, 6],
    '④ 用到该值（含只在拆分映射中用到）时包写 v6，未用到时写 v5'
  );
  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.featureFilter, entry.featureFilter, '④ 读包保留规则');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 5 });
  assertThrows(() => legacyReader.readTemplateBundleFile(bundlePath), /模板文件版本（6）高于当前应用支持的版本（5）/, '④ 旧版（支持到 v5）读 v6 包整包拒绝');

  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const draftTemplate = { id: null, templateKey: readEntry.templateKey, name: readEntry.name, sourceFileName: readEntry.sourceFileName, headers: readEntry.headers, createdAt: '', updatedAt: '' };
  const validated = targetMain.validateTemplateConfiguration({
    template: draftTemplate,
    mappings: targetMain.normalizeMappingRows({ template: draftTemplate, mappings: readEntry.mappings, enumValues: ENUM_VALUES }),
    enumValues: ENUM_VALUES,
    featureFilter: readEntry.featureFilter
  });
  const imported = target.upsertTemplate({ templateKey: readEntry.templateKey, name: readEntry.name, sourceFileName: readEntry.sourceFileName, headers: readEntry.headers });
  target.saveMappings(imported.id, validated.mappings, [], [], readEntry.dateFormat, [], { preserveOwn: false, featureFilter: validated.featureFilter });
  assertEq(target.getTemplate(imported.id).featureFilter, database.getTemplate(template.id).featureFilter, '④ 导入后规则一致');
  assertEq(
    target.getTemplateMappings(imported.id).mappings.filter((m) => m.mappedField === FEATURE).map((m) => m.templateField),
    ['Remark', 'Reference'],
    '④ 导入后映射一致'
  );

  target.upsertTemplate({ templateKey: readEntry.templateKey, name: readEntry.name, sourceFileName: 'new.xlsx', headers: ['日期', '摘要'] });
  assertEq(target.getTemplate(imported.id).featureFilter, null, '④ 覆盖表头重建模板：规则清空');
  assertEq(target.getTemplateMappings(imported.id).mappings.length, 0, '④ 覆盖表头重建模板：映射清空');
}

// ⑤ 拆分/合并「不复用」：只有拆分映射用该值
function verifyBillSplitNotReuse(dir, { database, main }) {
  const template = database.upsertTemplate({ name: 'BANKC-拆分', sourceFileName: 'c.xlsx', headers: HEADERS });
  const validated = main.validateTemplateConfiguration({
    template,
    mappings: mappingsFor({
      Currency: '',
      'Credit Amount': '',
      'Debit Amount': '',
      Remark: '附言',
      Reference: '',
      [CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD]: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION,
      [CONSTANTS.REUSE_MODULE_MAPPING_FIELD]: '否'
    }),
    enumValues: ENUM_VALUES,
    featureFilter: null
  });
  database.saveMappings(template.id, validated.mappings, [], [], undefined, null, { featureFilter: validated.featureFilter });
  assertEq(database.getTemplate(template.id).featureFilter, null, '⑤ 主映射未用该值：不写规则');

  const billSplitMappings = main.validateBillSplitMappingsPayload([
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Reference', mappedField: FEATURE, mappedFields: [] }
  ], template);
  const rule = normalizeFeatureFilterRule({ sourceField: '附言', separator: 'slash', digitsOnly: true, length: 6 }, { headers: template.headers });
  database.saveBillSplitMappings(template.id, billSplitMappings, { featureFilter: rule });
  assertEq(database.getTemplate(template.id).featureFilter, rule, '⑤ 规则随拆分映射写入');

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
  ], '⑤ 不复用时展开行按拆分映射取特征值');
  assertEq(
    detailRows.issues.filter((issue) => issue.type === 'feature-value-unmatched').map((issue) => issue.rowNumber),
    [3],
    '⑤ 拆分路径未命中行记提示'
  );

  const splitMainMappings = mappingsFor({
    Currency: '',
    'Credit Amount': '',
    'Debit Amount': '',
    Remark: '附言',
    Reference: '',
    [CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD]: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION,
    [CONSTANTS.REUSE_MODULE_MAPPING_FIELD]: '否'
  });
  const storedBillSplit = database.getBillSplitMappings(template.id);
  assertThrows(() => main.validateTemplateConfiguration({
    template, mappings: splitMainMappings, enumValues: ENUM_VALUES, featureFilter: null, billSplitMappings: storedBillSplit
  }), /拆分\/合并账单映射关系设置中有字段使用了"字段筛选特征值"/, '⑤ 不复用的拆分映射用到该值而缺规则：保存主映射被拒');
  assertThrows(() => main.validateTemplateConfiguration({
    template, mappings: splitMainMappings, enumValues: ENUM_VALUES, featureFilter: { sourceField: '附言' }, billSplitMappings: storedBillSplit
  }), /至少设置一项/, '⑤ 不复用的拆分映射用到该值而规则无效：保存主映射被拒');
  assertEq(
    main.validateTemplateConfiguration({
      template, mappings: splitMainMappings, enumValues: ENUM_VALUES, featureFilter: rule, billSplitMappings: storedBillSplit
    }).featureFilter,
    rule,
    '⑤ 规则有效时保存主映射通过并带回规则'
  );
  assertEq(
    main.validateTemplateConfiguration({
      template,
      mappings: mappingsFor({ ...Object.fromEntries(splitMainMappings.map((m) => [m.templateField, m.mappedField])), [CONSTANTS.REUSE_MODULE_MAPPING_FIELD]: '是' }),
      enumValues: ENUM_VALUES,
      featureFilter: null,
      billSplitMappings: storedBillSplit
    }).featureFilter,
    null,
    '⑤ 复用模块映射时拆分映射不生效，不要求规则'
  );

  // 主映射残留该值、拆分映射（不复用）未用：不要求规则、不记未命中
  const residual = database.upsertTemplate({ name: 'BANKD-残留', sourceFileName: 'd.xlsx', headers: HEADERS });
  database.saveMappings(residual.id, splitMainMappings.map((m) => (
    m.templateField === 'Remark' ? { ...m, mappedField: FEATURE } : m
  )).map((m) => ({ templateField: m.templateField, mappedField: m.mappedField, mappedFields: [] })), [], [], undefined, null, {});
  database.saveBillSplitMappings(residual.id, [
    { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
    { templateField: 'MerchantId', mappedField: '账号', mappedFields: [] },
    { templateField: 'Remark', mappedField: '附言', mappedFields: [] }
  ]);
  database.saveBillSplitRowCount(residual.id, 1);
  database.saveBillSplitRow(residual.id, { seqNo: 1, currencySourceField: '币种', creditSourceField: '收入', debitSourceField: '支出', amountSourceField: '', rowStatus: 'completed' });
  const residualRows = generate(main, database, residual.id, sourcePath);
  assertEq(pickColumns(residualRows, ['Remark']), [['INV/123456/备注'], ['INV/12345']], '⑤ 不复用时按拆分映射直接取列');
  assertEq(residualRows.issues.filter((issue) => issue.type === 'feature-value-unmatched').length, 0, '⑤ 主映射残留该值不记未命中提示');
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-feature-filter-'));
  try {
    verifyMigration(dir);
    const context = verifySaveAndGenerate(dir);
    verifyRejections(dir, context);
    verifyBundleRoundTrip(dir, context);
    verifyBillSplitNotReuse(dir, context);
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
