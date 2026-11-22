// 网银账单：拆分/合并账单「发生额取值设置」与费用账单（v3.2.19）e2e 集成验证
//   覆盖：真实主库（迁移、仓储）+ main.js 中真实的生成配置、模板包读写与导入函数 + 真实 xlsx 读取与写出
//   ① 迁移：旧库无 is_fee_bill / fee_amount_formula_* 列 → 启动补列，原有拆分行不是费用账单；重复启动无副作用
//   ② 存储：费用账单标记唯一，勾选与保存都不清该行已存的 Credit / Debit 映射（取消后恢复；与 Debit 同列的 Credit 取消时清空）；
//      行保存的同列校验只比实际生效的映射；删行后标记随行移动、减份数时随行删除；
//      拆分配置按字段部分保存，不覆盖未带的字段
//   ③ 生成：库内配置 → buildBillSplitMergeConfig → 读 xlsx → 写出回读：费用账单行 Debit = 公式结果（先乘除后加减、
//      取绝对值、2 位小数）、Credit 为空，交易行不变；勾选特殊取值但公式缺失时拒绝；费用行为草稿时不生效；
//      模板表头删掉公式字段后，生成前的失效引用拦截列出公式位置
//   ④ 模板包：导出条目带费用标记与公式 → 写 v8 → 读包 → 导入覆盖已有模板后一致（旧费用标记不残留、不误清 Credit）；
//      旧版（支持到 v7）整包拒绝；未用到费用账单时版本号不变
//   ⑤ v3.2.21 字段映射特殊处理：旧库补列；按字段部分保存；生成配置只在勾选且费用行已完成时下发、勾选但无效时拒绝；
//      写出回读：费用账单行按设置覆盖（自己输入 / 空白 / 模板文件字段，日期规范化），交易行不变；
//      模板表头删掉映射字段后生成前拦截列出位置；模板包写 v9 → 读包 → 导入后配置与生成结果一致，旧版（支持到 v8）整包拒绝
//   ⑥ v3.2.21 拆分/合并账单映射关系管理【返回】：经主进程撤销逻辑，只接受读取时签发令牌的原样快照（改动过、缺令牌、
//      模板代次变化都被拒且库不变、不同步模板库），通过后在一个事务内恢复拆分行、合并组、发生额规则与拆分配置，
//      不动「根据字段值过滤账单」规则
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-bill-split-fee-bill.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const { hasColumn } = require('../../src/backend/database/migrations');
const { appendActivityRecord, getLogFilePath } = require('../../src/backend/logger');
const {
  buildDetailExportRows,
  buildFeatureFilterToken,
  buildLogicValueToken,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  buildMappedRows,
  compileRegexLiteral,
  isRegexLiteral,
  FileValidationError,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
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
  upgradeLegacyFeatureFilter,
  validateFeeAmountFormula,
  validateBillSplitRowFilterRules,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  createTemplateHeaderUpdateTools,
  formatFieldReferenceLines
} = require('../../src/main-process/template-header-update');

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const HEADERS = ['交易日期', '币种', '交易金额', '手续费', '邮电费', '笔数'];
const ORDERED_FIELDS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'];
const FEE_FORMULA = [
  { field: '手续费', op: '+' },
  { field: '邮电费', op: '*' },
  { field: '笔数', op: 'end' }
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
  'DUPLICATE_ROW_FILTER_ENABLED_OPTION', 'PREPROCESS_FIELDS', 'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS',
  'SUPPORTED_BUNDLE_VERSION', 'LOGIC_VALUE_FEATURE_BUNDLE_VERSION', 'FEE_FIELD_MAPPING_BUNDLE_VERSION', 'LOGIC_VALUE_BUNDLE_VERSION', 'FEATURE_FILTER_BUNDLE_VERSION', 'CURRENCY_ONLY_BUNDLE_VERSION', 'BASE_BUNDLE_VERSION'
]);

function createMain(database, constantOverrides = {}) {
  return loadMainFunctions([
    'getPrimaryMappedField',
    'getMappingFieldValues',
    'normalizeMappedFields',
    'buildMappedFieldLookup',
    'buildBillSplitMergeConfig',
    'filterFeeFieldMappingTemplateFields',
    'applyBundleBillSplitConfig',
    'validateBillSplitRowPayload',
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
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    buildFeatureFilterToken,
    buildLogicValueToken,
    parseFeatureFilterToken,
    parseLogicValueToken,
    parseLogicValueFeatureFilterRef,
    buildLogicValueFeatureCandidate,
    normalizeLogicValueFields,
    LOGIC_VALUE_MIN_FIELDS,
    getFeatureFilterRef,
    LEGACY_FEATURE_FILTER_ID,
    upgradeLegacyFeatureFilter,
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

const SPLIT_MAPPINGS = [
  { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
  { templateField: CONSTANTS.BILL_SPLIT_MERGE_MAPPING_FIELD, mappedField: CONSTANTS.BILL_SPLIT_MERGE_ENABLED_OPTION, mappedFields: [] }
];

function rowFields(database, templateId) {
  return database.getBillSplitRows(templateId).map((row) => [row.seqNo, row.creditSourceField, row.debitSourceField, row.isFeeBill]);
}

// 两份拆分：1 = 交易（Credit ← 交易金额），2 = 费用账单
function defineSplitTemplate(database, name, { feeRowStatus = 'completed' } = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: HEADERS });
  database.saveBillSplitRowCount(template.id, 2);
  database.saveBillSplitRow(template.id, {
    seqNo: 1, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  });
  database.saveBillSplitRow(template.id, {
    seqNo: 2, currencySourceField: '币种', creditSourceField: '', debitSourceField: '手续费', amountSourceField: '', rowStatus: feeRowStatus
  });
  database.setBillSplitFeeBillRow(template.id, 2);
  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: true, feeAmountFormula: FEE_FORMULA });
  return database.getTemplate(template.id);
}

function verifyMigration(dir) {
  const dbPath = path.join(dir, 'legacy.sqlite');
  const seed = openDatabase(dbPath);
  const template = seed.upsertTemplate({ name: '旧库模板', sourceFileName: 'legacy.xlsx', headers: HEADERS });
  seed.saveBillSplitRowCount(template.id, 2);
  seed.saveBillSplitMeta(template.id, { signedAmountSourceField: '交易金额', signedAmountTargetSeqNos: [1], byFieldAmountTargetSeqNos: [] });
  // 回退成 v3.2.18 的表结构
  seed.db.exec('ALTER TABLE template_bill_split_rows DROP COLUMN is_fee_bill;');
  seed.db.exec('ALTER TABLE template_bill_split_meta DROP COLUMN fee_amount_formula_enabled;');
  seed.db.exec('ALTER TABLE template_bill_split_meta DROP COLUMN fee_amount_formula_json;');
  // v3.2.21 的字段映射特殊处理列一并去掉
  seed.db.exec('ALTER TABLE template_bill_split_meta DROP COLUMN fee_field_mapping_enabled;');
  seed.db.exec('ALTER TABLE template_bill_split_meta DROP COLUMN fee_field_mappings_json;');
  assertTrue(!hasColumn(seed.db, 'template_bill_split_rows', 'is_fee_bill'), '① 构造旧库：无 is_fee_bill 列');
  closeDatabase(seed);

  const upgraded = openDatabase(dbPath);
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_rows', 'is_fee_bill'), '① 启动补 is_fee_bill 列');
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_amount_formula_enabled')
    && hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_amount_formula_json'), '① 启动补费用账单公式列');
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_field_mapping_enabled')
    && hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_field_mappings_json'), '⑤ 启动补字段映射特殊处理列');
  assertEq(upgraded.getBillSplitRows(template.id).map((row) => row.isFeeBill), [false, false], '① 原有拆分行不是费用账单');
  assertEq(upgraded.getBillSplitMeta(template.id), {
    signedAmountSourceField: '交易金额',
    signedAmountTargetSeqNos: [1],
    byFieldAmountTargetSeqNos: [],
    feeAmountFormulaEnabled: false,
    feeAmountFormula: [],
    rowFilterRules: [],
    feeFieldMappingEnabled: false,
    feeFieldMappings: []
  }, '① 原有拆分配置保留，费用账单默认未启用');
  closeDatabase(upgraded);
  const again = openDatabase(dbPath);
  assertEq(again.getBillSplitRows(template.id).length, 2, '① 重复启动无副作用');
  closeDatabase(again);
}

function verifyStorage(database) {
  const template = database.upsertTemplate({ name: '存储模板', sourceFileName: 'storage.xlsx', headers: HEADERS });
  database.saveBillSplitRowCount(template.id, 3);
  [1, 2, 3].forEach((seqNo) => database.saveBillSplitRow(template.id, {
    seqNo, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  }));

  database.setBillSplitFeeBillRow(template.id, 2);
  assertEq(rowFields(database, template.id), [[1, '交易金额', '', false], [2, '交易金额', '', true], [3, '交易金额', '', false]],
    '② 勾选费用账单只改标记，不清已存的 Credit 映射');
  database.setBillSplitFeeBillRow(template.id, 3);
  assertEq(rowFields(database, template.id).map((row) => [row[1], row[3]]), [['交易金额', false], ['交易金额', false], ['交易金额', true]],
    '② 费用账单唯一，误勾后取消原 Credit 映射仍在');
  database.saveBillSplitRow(template.id, {
    seqNo: 3, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '手续费', amountSourceField: '', rowStatus: 'completed'
  });
  assertEq(rowFields(database, template.id)[2], [3, '交易金额', '手续费', true], '② 费用账单行保存时照存映射（生成时不读 Credit）');

  let missingError = null;
  try { database.setBillSplitFeeBillRow(template.id, 9); } catch (error) { missingError = error; }
  assertEq(missingError && missingError.code, 'BILL_SPLIT_ROW_NOT_FOUND', '② 指定不存在的行时拒绝');
  assertEq(database.getBillSplitRows(template.id).map((row) => row.isFeeBill), [false, false, true], '② 拒绝时原标记不变');

  // 费用行的 Debit 可与停用的 Credit 同列；离开费用账单时清空同列的 Credit
  const main = createMain(database);
  const sameColumnRow = { seqNo: 3, creditSourceField: '交易金额', debitSourceField: '交易金额', rowStatus: 'completed' };
  assertThrows(() => main.validateBillSplitRowPayload(sameColumnRow), /不能是同一列/, '② 普通行 Credit / Debit 同列被拒');
  let sameColumnError = null;
  try { main.validateBillSplitRowPayload(sameColumnRow, { creditIgnored: true }); } catch (error) { sameColumnError = error; }
  assertEq(sameColumnError, null, '② 费用行停用的 Credit 不参与同列校验');
  database.saveBillSplitRow(template.id, { ...sameColumnRow, amountSourceField: '', currencySourceField: '币种' });
  database.setBillSplitFeeBillRow(template.id, 2);
  assertEq(rowFields(database, template.id).map((row) => [row[1], row[2], row[3]]), [['交易金额', '', false], ['交易金额', '', true], ['', '交易金额', false]],
    '② 离开费用账单时清空与 Debit 同列的 Credit，其他行不动');
  database.setBillSplitFeeBillRow(template.id, 3);

  database.deleteBillSplitRow(template.id, 1);
  assertEq(database.getBillSplitRows(template.id).map((row) => [row.seqNo, row.isFeeBill]), [[1, false], [2, true]],
    '② 删行后费用标记随行移动');
  database.saveBillSplitRowCount(template.id, 1);
  assertEq(database.getBillSplitRows(template.id).map((row) => row.isFeeBill), [false], '② 减少份数时费用标记随行删除');
  database.setBillSplitFeeBillRow(template.id, 1);
  database.setBillSplitFeeBillRow(template.id, null);
  assertEq(database.getBillSplitRows(template.id).map((row) => row.isFeeBill), [false], '② 取消费用账单');

  database.saveBillSplitMeta(template.id, { signedAmountSourceField: '交易金额', signedAmountTargetSeqNos: [1], byFieldAmountTargetSeqNos: [] });
  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: true });
  database.saveBillSplitMeta(template.id, { feeAmountFormula: [...FEE_FORMULA, { field: '', op: '' }] });
  assertEq(database.getBillSplitMeta(template.id), {
    signedAmountSourceField: '交易金额',
    signedAmountTargetSeqNos: [1],
    byFieldAmountTargetSeqNos: [],
    feeAmountFormulaEnabled: true,
    feeAmountFormula: FEE_FORMULA,
    rowFilterRules: [],
    feeFieldMappingEnabled: false,
    feeFieldMappings: []
  }, '② 拆分配置按字段部分保存，空白组不落库');
  database.saveBillSplitMeta(template.id, { signedAmountSourceField: '', signedAmountTargetSeqNos: [], byFieldAmountTargetSeqNos: [] });
  assertEq(database.getBillSplitMeta(template.id).feeAmountFormula, FEE_FORMULA, '② 保存正负号配置不覆盖费用账单公式');
}

function generate(main, template, sourcePath, outputPath) {
  const billSplitMerge = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  const mapped = buildMappedRows({
    inputFilePath: sourcePath,
    orderedTargetFields: ORDERED_FIELDS,
    mappingByField: { BillDate: '交易日期', Currency: '币种' },
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

function verifyGeneration(dir, database, main) {
  const sourcePath = path.join(dir, 'source.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', 'USD', '1,000.00', '-5', '0.335', '3'],
    ['2026-11-02', 'USD', '200', '', '', ''],
    ['2026-11-03', 'USD', '50', '2', '1.5', '2']
  ]);

  const template = defineSplitTemplate(database, '费用账单模板');
  const config = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  assertEq(config.feeAmountFormula, FEE_FORMULA, '③ 生成配置下发费用账单公式');
  assertEq(config.billSplitRows.map((row) => row.isFeeBill), [false, true], '③ 生成配置的拆分行带费用标记');
  // 第 1 行：|-5 + 0.335 × 3| = 3.995 → 4；第 3 行：2 + 1.5 × 2 = 5；第 2 行公式为 0 不输出
  assertEq(generate(main, template, sourcePath, path.join(dir, 'out-1.xlsx')), [
    ['USD', 1000, ''],
    ['USD', '', 4],
    ['USD', 200, ''],
    ['USD', 50, ''],
    ['USD', '', 5]
  ], '③ 回读导出：费用账单行 Debit = 公式结果，Credit 为空，交易行不变');

  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: false });
  assertEq(generate(main, template, sourcePath, path.join(dir, 'out-2.xlsx')), [
    ['USD', 1000, ''],
    ['USD', '', 5],
    ['USD', 200, ''],
    ['USD', 50, ''],
    ['USD', '', 2]
  ], '③ 未勾选特殊取值：费用账单行 Debit 走行级映射');

  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: true, feeAmountFormula: [] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /发生额取值特殊处理.*请至少新增一组运算字段/,
    '③ 勾选特殊取值但公式缺失时拒绝生成');

  const draftTemplate = defineSplitTemplate(database, '费用行草稿模板', { feeRowStatus: 'draft' });
  assertEq(main.buildBillSplitMergeConfig(draftTemplate, SPLIT_MAPPINGS).feeAmountFormula, null, '③ 费用账单行为草稿时公式不生效');

  // 模板表头删掉「笔数」后：生成前拦截列出公式位置
  database.saveBillSplitMeta(template.id, { feeAmountFormula: FEE_FORMULA });
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const latestConfig = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  const referenceInput = {
    mappings: SPLIT_MAPPINGS,
    billSplitRows: latestConfig.billSplitRows,
    billSplitFeeAmountFormula: latestConfig.feeAmountFormula,
    billSplitFeeAmountFormulaEnabled: Boolean(latestConfig.feeAmountFormula)
  };
  let staleError = null;
  try {
    tools.assertTemplateFieldReferencesAvailable({ name: '费用账单模板', headers: HEADERS.filter((header) => header !== '笔数') }, referenceInput);
  } catch (error) { staleError = error; }
  assertEq(staleError && staleError.code, 'TEMPLATE_MAPPING_FIELD_MISSING', '③ 公式字段被删时生成前拦截');
  assertTrue(Boolean(staleError) && staleError.detailLines.includes('拆分账单 · 费用账单发生额公式第 3 组 ← 笔数'),
    '③ 拦截明细列出公式位置');
  const inactive = tools.collectTemplateFieldReferences({ ...referenceInput, billSplitFeeAmountFormulaEnabled: false })
    .filter((reference) => reference.area === 'bill-split-fee-formula');
  assertEq(formatFieldReferenceLines(inactive.slice(0, 1)), ['拆分账单 · 费用账单发生额公式第 1 组 ← 手续费（未启用）'],
    '③ 未勾选特殊取值时公式引用标为未启用');
  // 费用行保留的 Debit 映射（手续费）被公式取代：删掉该列不拦截生成，只要公式字段都在
  const feeRowReferences = tools.collectTemplateFieldReferences(referenceInput)
    .filter((reference) => reference.area === 'bill-split-row' && reference.role === '2' && reference.target !== 'Currency');
  assertEq(feeRowReferences.map((reference) => [reference.target, reference.field, reference.active]), [['Debit Amount', '手续费', false]],
    '③ 费用行被取代的 Debit 映射标为未启用');
}

function verifyBundle(dir, database, main) {
  const template = database.getTemplateByName('费用账单模板');
  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: true, feeAmountFormula: FEE_FORMULA });
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '费用账单模板');
  assertEq(entry.billSplitRows.map((row) => row.isFeeBill), [false, true], '④ 导出条目带费用账单标记');
  assertEq(entry.billSplitMeta, {
    signedAmountSourceField: '', feeAmountFormulaEnabled: true, feeAmountFormula: FEE_FORMULA, rowFilterRules: [],
    feeFieldMappingEnabled: false, feeFieldMappings: []
  }, '④ 导出条目带费用账单公式');

  const plainEntry = { mappings: [], billSplitRows: [{ seqNo: 1, isFeeBill: false }], billSplitMeta: { feeAmountFormulaEnabled: false } };
  const formulaOnlyEntry = { mappings: [], billSplitRows: [], billSplitMeta: { feeAmountFormulaEnabled: true } };
  assertEq(
    [main.resolveTemplateBundleVersion([plainEntry]), main.resolveTemplateBundleVersion([entry]), main.resolveTemplateBundleVersion([formulaOnlyEntry])],
    [CONSTANTS.BASE_BUNDLE_VERSION, 8, 8],
    '④ 用到费用账单时写 v8，未用到时版本不变'
  );

  const bundlePath = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.billSplitMeta, entry.billSplitMeta, '④ 读包保留费用账单公式');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 7 });
  assertThrows(() => legacyReader.readTemplateBundleFile(bundlePath), /模板文件版本（8）高于当前应用支持的版本（7）/,
    '④ 旧版（支持到 v7）读 v8 包整包拒绝');

  // 导入覆盖已有同名模板：目标库里第 1 份原是费用账单
  const target = openDatabase(path.join(dir, 'import.sqlite'));
  const targetMain = createMain(target);
  const existing = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: 'old.xlsx', headers: HEADERS });
  target.saveBillSplitRowCount(existing.id, 2);
  target.setBillSplitFeeBillRow(existing.id, 1);
  targetMain.applyBundleBillSplitConfig(existing.id, readEntry);
  assertEq(rowFields(target, existing.id), rowFields(database, template.id), '④ 导入后拆分行与费用标记一致，旧标记不残留、交易行 Credit 未被误清');
  assertEq(target.getBillSplitMeta(existing.id), database.getBillSplitMeta(template.id), '④ 导入后费用账单公式一致');

  const sourcePath = path.join(dir, 'source.xlsx');
  assertEq(
    generate(targetMain, target.getTemplate(existing.id), sourcePath, path.join(dir, 'out-imported.xlsx')),
    generate(main, template, sourcePath, path.join(dir, 'out-origin.xlsx')),
    '④ 导入后的模板生成结果与原模板一致'
  );
  closeDatabase(target);
}


// ==================== ⑤ v3.2.21 字段映射特殊处理 ====================
const FM_HEADERS = ['交易日期', '币种', '交易金额', '手续费', '摘要', '记账日期'];
// 目标字段取自随应用提供的 COMMON枚举.xlsx（Transaction Description、ValueDate）
const FM_FIELDS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Transaction Description', 'ValueDate'];
const FM_MAPPING = { BillDate: '交易日期', Currency: '币种', 'Transaction Description': '摘要', ValueDate: '交易日期' };
const FEE_FIELD_MAPPINGS = [
  { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
  { templateField: 'ValueDate', valueType: 'field', value: '记账日期' }
];

function defineFieldMappingTemplate(database, name, { feeRowStatus = 'completed' } = {}) {
  const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: FM_HEADERS });
  database.saveBillSplitRowCount(template.id, 2);
  database.saveBillSplitRow(template.id, {
    seqNo: 1, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed'
  });
  database.saveBillSplitRow(template.id, {
    seqNo: 2, currencySourceField: '币种', creditSourceField: '', debitSourceField: '手续费', amountSourceField: '', rowStatus: feeRowStatus
  });
  database.setBillSplitFeeBillRow(template.id, 2);
  database.saveBillSplitMeta(template.id, { feeFieldMappingEnabled: true, feeFieldMappings: FEE_FIELD_MAPPINGS });
  return database.getTemplate(template.id);
}

function generateFieldMapping(main, template, sourcePath, outputPath) {
  const billSplitMerge = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  const mapped = buildMappedRows({
    inputFilePath: sourcePath,
    orderedTargetFields: FM_FIELDS,
    mappingByField: FM_MAPPING,
    expectedSourceHeaders: FM_HEADERS,
    billSplitMerge
  });
  writeWorkbookRows({ rows: buildDetailExportRows(mapped), outputFilePath: outputPath });
  const exported = readSheet(outputPath);
  // 日期列写出为 Excel 日期单元格（序号），回读时转成 yyyy-mm-dd 便于比较
  const toDateText = (serial) => {
    const parts = XLSX.SSF.parse_date_code(Number(serial));
    return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  };
  return exported.rows.map((row) => FM_FIELDS.map((field) => {
    const value = row[exported.header.indexOf(field)];
    if (value === '') return '';
    if (field.endsWith('Amount')) return Number(value);
    return field.endsWith('Date') && typeof value === 'number' ? toDateText(value) : String(value);
  }));
}

function verifyFeeFieldMapping(dir, database, main) {
  const sourcePath = path.join(dir, 'field-mapping-source.xlsx');
  writeSource(sourcePath, [
    ['2026-11-01', 'USD', '100', '1.5', '货款', '2026-11-03'],
    ['2026-11-02', 'USD', '50', '2', '退款', '2026-11-04']
  ], FM_HEADERS);
  const template = defineFieldMappingTemplate(database, '字段映射模板');

  // 存储：按字段部分保存，保存公式 / 正负号配置不覆盖
  database.saveBillSplitMeta(template.id, { feeAmountFormulaEnabled: false, signedAmountSourceField: '', signedAmountTargetSeqNos: [], byFieldAmountTargetSeqNos: [] });
  assertEq([database.getBillSplitMeta(template.id).feeFieldMappingEnabled, database.getBillSplitMeta(template.id).feeFieldMappings],
    [true, FEE_FIELD_MAPPINGS], '⑤ 保存其他拆分配置不覆盖字段映射特殊处理');

  const config = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  assertEq(config.feeFieldMappings, FEE_FIELD_MAPPINGS, '⑤ 生成配置下发字段映射特殊处理');
  assertEq(generateFieldMapping(main, template, sourcePath, path.join(dir, 'fm-out-1.xlsx')), [
    ['2026-11-01', 'USD', 100, '', '货款', '2026-11-01'],
    ['2026-11-01', 'USD', '', 1.5, '手续费', '2026-11-03'],
    ['2026-11-02', 'USD', 50, '', '退款', '2026-11-02'],
    ['2026-11-02', 'USD', '', 2, '手续费', '2026-11-04']
  ], '⑤ 回读导出：费用账单行按设置覆盖摘要与起息日，交易行不变');

  database.saveBillSplitMeta(template.id, { feeFieldMappingEnabled: false });
  assertEq(main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS).feeFieldMappings, null, '⑤ 未勾选时不下发');
  assertEq(generateFieldMapping(main, template, sourcePath, path.join(dir, 'fm-out-2.xlsx')).map((row) => row[4]),
    ['货款', '货款', '退款', '退款'], '⑤ 未勾选时费用账单行照原映射输出');

  database.saveBillSplitMeta(template.id, { feeFieldMappingEnabled: true, feeFieldMappings: [] });
  let missingError = null;
  try { main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS); } catch (error) { missingError = error; }
  assertEq(missingError && missingError.code, 'BILL_SPLIT_FEE_FIELD_MAPPING_MISSING', '⑤ 勾选但设置缺失时拒绝生成');
  assertTrue(Boolean(missingError) && /字段映射特殊处理.*请至少新增一个模板字段/.test(missingError.message), '⑤ 拒绝提示在【设置】中保存');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'MerchantId', valueType: 'input', value: 'X' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /字段映射特殊处理.*「MerchantId」不支持/, '⑤ 账户号等不可覆盖的字段在生成时拒绝');

  // 目标字段已不导出的旧设置（取值类型也无效）先排除再校验，不连累有效设置；受保护字段是导出字段，照样拒绝
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '已退役字段', valueType: 'bogus', value: 'x' }
  ] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /字段映射特殊处理/, '⑤ 不给导出字段时整份校验');
  assertEq(main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }).feeFieldMappings,
    [{ templateField: 'Transaction Description', valueType: 'input', value: '手续费' }], '⑤ 已不导出的旧设置先排除，有效设置照常下发');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: '已退役字段', valueType: 'input', value: 'x' }] });
  assertEq(main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }).feeFieldMappings, [],
    '⑤ 已有设置但目标全部不再导出：不覆盖任何字段、照常生成');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'field', value: '摘要' }
  ] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }), /第 2 行：请选择模板字段/,
    '⑤ 缺少模板字段的项不当作已退役，照常拒绝');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'BillDate', valueType: 'field', value: '记账日期' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }), /「BillDate」不支持/,
    '⑤ 受保护的 BillDate 不因导出字段过滤被放过');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'Channel', valueType: 'input', value: '其他银行' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }), /「Channel」不支持/,
    '⑤ 本次枚举表不导出的受保护字段（Channel）仍拒绝，不当作已退役字段忽略');
  // 枚举里恰有与映射控制项同名的导出字段（如「过滤账单」）：界面不能选，模板包带入的覆盖在生成时同样拒绝，不写入该列
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: '过滤账单', valueType: 'input', value: 'x' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS, { exportTargetFields: [...FM_FIELDS, '过滤账单'] }), /「过滤账单」不支持/,
    '⑤ 与映射控制项同名的导出字段在生成时拒绝');
  assertEq(main.filterFeeFieldMappingTemplateFields(['Transaction Description', 'Channel', '过滤账单', '重复账单过滤', '根据字段值过滤账单']),
    ['Transaction Description'], '⑤ 保存与生成共用的可选范围排除 Channel 与映射控制项');

  const draftTemplate = defineFieldMappingTemplate(database, '字段映射草稿模板', { feeRowStatus: 'draft' });
  assertEq(main.buildBillSplitMergeConfig(draftTemplate, SPLIT_MAPPINGS).feeFieldMappings, null, '⑤ 费用账单行为草稿时不生效');

  // 取源列的值含 XML 禁止字符（U+FFFE）：真实 CSV 源文件，未映射该列时照常生成；映射到费用行时拒绝并列出源行与列，
  //   不交付工作表无法解析的明细（主映射同一写出边界见 backlog B113）
  const xmlIllegalCsv = path.join(dir, 'field-mapping-xml-illegal.csv');
  fs.writeFileSync(xmlIllegalCsv, [FM_HEADERS.join(','), '2026-11-01,USD,100,1.5,货款,REF\uFFFE01'].join('\n'), 'utf8');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'Transaction Description', valueType: 'input', value: '手续费' }] });
  assertEq(generateFieldMapping(main, template, xmlIllegalCsv, path.join(dir, 'fm-xml-unmapped.xlsx')).map((row) => row[4]), ['货款', '手续费'],
    '⑤ 含禁止字符的列未映射到费用行时照常生成');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'Transaction Description', valueType: 'field', value: '记账日期' }] });
  const xmlIllegalOut = path.join(dir, 'fm-xml-illegal.xlsx');
  assertThrows(() => generateFieldMapping(main, template, xmlIllegalCsv, xmlIllegalOut),
    /第 2 行「记账日期」列的值含无法写入 Excel 的字符.*Transaction Description/, '⑤ 取源列的值含禁止字符时拒绝生成并列出源行与列');
  assertTrue(!fs.existsSync(xmlIllegalOut), '⑤ 拒绝时不写出明细');

  // 形如 _xHHHH_ 的字面参考号：XLSX 写出后读回会被还原成其他字符（写出器问题见 backlog B113）。真实 CSV 与写出回读：
  //   正常参考号原样往返；含 _x0041_ 的源列值或固定文本映射到费用行时拒绝，不交付被改写的标识
  const escapeLikeCsv = path.join(dir, 'field-mapping-escape-like.csv');
  fs.writeFileSync(escapeLikeCsv, [FM_HEADERS.join(','), '2026-11-01,USD,100,1.5,货款,FEE_x0041_', '2026-11-02,USD,50,2,退款,FEE_0041'].join('\n'), 'utf8');
  const escapeLikeOut = path.join(dir, 'fm-escape-like.xlsx');
  assertThrows(() => generateFieldMapping(main, template, escapeLikeCsv, escapeLikeOut),
    /第 2 行「记账日期」列的值含写入 Excel 后会被改写的文本.*Transaction Description/, '⑤ 源列值含 _xHHHH_ 时拒绝生成并列出源行与列');
  assertTrue(!fs.existsSync(escapeLikeOut), '⑤ 拒绝时不写出明细');
  // 源列值（CSV 引号内含真实 CRLF）中 _x0041 与回车的写出编码 _x000d_ 拼成转义：同样拒绝；只含 CRLF 的参考号写出回读原样保留
  const crlfEscapeCsv = path.join(dir, 'field-mapping-crlf-escape.csv');
  fs.writeFileSync(crlfEscapeCsv, [FM_HEADERS.join(','), '2026-11-01,USD,100,1.5,货款,"REF_x0041\r\nB"'].join('\n'), 'utf8');
  const crlfEscapeOut = path.join(dir, 'fm-crlf-escape.xlsx');
  assertThrows(() => generateFieldMapping(main, template, crlfEscapeCsv, crlfEscapeOut),
    /第 2 行「记账日期」列的值含写入 Excel 后会被改写的文本.*Transaction Description/, '⑤ 与回车相连构成转义的源列值拒绝生成');
  assertTrue(!fs.existsSync(crlfEscapeOut), '⑤ 拒绝时不写出明细');
  const crlfPlainCsv = path.join(dir, 'field-mapping-crlf-plain.csv');
  fs.writeFileSync(crlfPlainCsv, [FM_HEADERS.join(','), '2026-11-01,USD,100,1.5,货款,"REF\r\nB"'].join('\n'), 'utf8');
  assertEq(generateFieldMapping(main, template, crlfPlainCsv, path.join(dir, 'fm-crlf-plain.xlsx')).map((row) => row[4]), ['货款', 'REF\r\nB'],
    '⑤ 只含 CRLF 的参考号写出回读原样保留');
  const plainRefCsv = path.join(dir, 'field-mapping-plain-ref.csv');
  fs.writeFileSync(plainRefCsv, [FM_HEADERS.join(','), '2026-11-02,USD,50,2,退款,FEE_0041_x12'].join('\n'), 'utf8');
  assertEq(generateFieldMapping(main, template, plainRefCsv, path.join(dir, 'fm-plain-ref.xlsx')).map((row) => row[4]), ['退款', 'FEE_0041_x12'],
    '⑤ 不构成转义序列的参考号写出回读原样保留');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'Transaction Description', valueType: 'input', value: 'FEE_X0041_' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /映射值含写入 Excel 后会被改写的文本/,
    '⑤ 固定文本含 _xHHHH_（不分大小写）时生成前拒绝');
  database.saveBillSplitMeta(template.id, { feeFieldMappings: [{ templateField: 'Transaction Description', valueType: 'input', value: 'REF_x0041\r\nB' }] });
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /映射值含写入 Excel 后会被改写的文本/,
    '⑤ 固定文本中 _xHHHH 与回车相连时生成前拒绝');

  // 模板表头删掉「记账日期」：生成前拦截列出位置；未勾选时标为未启用
  database.saveBillSplitMeta(template.id, { feeFieldMappings: FEE_FIELD_MAPPINGS });
  const tools = createTemplateHeaderUpdateTools(CONSTANTS);
  const latestConfig = main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS);
  const referenceInput = {
    mappings: SPLIT_MAPPINGS,
    billSplitRows: latestConfig.billSplitRows,
    billSplitFeeFieldMappings: latestConfig.feeFieldMappings,
    billSplitFeeFieldMappingEnabled: Boolean(latestConfig.feeFieldMappings)
  };
  let staleError = null;
  try {
    tools.assertTemplateFieldReferencesAvailable({ name: '字段映射模板', headers: FM_HEADERS.filter((header) => header !== '记账日期') }, referenceInput);
  } catch (error) { staleError = error; }
  assertTrue(Boolean(staleError) && staleError.detailLines.includes('拆分账单 · 字段映射特殊处理 ValueDate ← 记账日期'),
    '⑤ 映射字段被删时生成前拦截并列出位置');
  const inactive = tools.collectTemplateFieldReferences({ ...referenceInput, billSplitFeeFieldMappingEnabled: false })
    .filter((reference) => reference.area === 'bill-split-fee-field-mapping');
  assertEq(formatFieldReferenceLines(inactive), ['拆分账单 · 字段映射特殊处理 ValueDate ← 记账日期（未启用）'], '⑤ 未勾选时引用标为未启用（自己输入不算源字段引用）');
  const notExported = tools.collectTemplateFieldReferences({ ...referenceInput, billSplitFeeFieldMappingTargetFields: ['BillDate', 'Transaction Description'] })
    .filter((reference) => reference.area === 'bill-split-fee-field-mapping');
  assertEq(notExported.map((reference) => reference.active), [false], '⑤ 目标字段已不导出时（模板【更新】检查）引用标为未启用');

  // 模板包：写 v9 → 读包 → 导入后配置与生成结果一致；旧版（支持到 v8）整包拒绝
  const entry = database.listTemplateBundleEntries().find((item) => item.name === '字段映射模板');
  assertEq([entry.billSplitMeta.feeFieldMappingEnabled, entry.billSplitMeta.feeFieldMappings], [true, FEE_FIELD_MAPPINGS], '⑤ 导出条目带字段映射特殊处理');
  const savedOnly = { mappings: [], billSplitRows: [], billSplitMeta: { feeFieldMappingEnabled: false, feeFieldMappings: FEE_FIELD_MAPPINGS } };
  assertEq([main.resolveTemplateBundleVersion([entry]), main.resolveTemplateBundleVersion([savedOnly]),
    main.resolveTemplateBundleVersion([entry, { mappings: [], billSplitRows: [{ seqNo: 1, isFeeBill: true }], billSplitMeta: {} }])],
  [9, 9, 9], '⑤ 勾选或存有字段映射特殊处理时写 v9');
  const bundlePath = path.join(dir, 'field-mapping-bundle.json');
  fs.writeFileSync(bundlePath, JSON.stringify({ bundleVersion: main.resolveTemplateBundleVersion([entry]), channels: [], templates: [entry] }), 'utf8');
  const readEntry = main.readTemplateBundleFile(bundlePath).templates[0];
  assertEq(readEntry.billSplitMeta, entry.billSplitMeta, '⑤ 读包保留字段映射特殊处理');
  const legacyReader = createMain(database, { SUPPORTED_BUNDLE_VERSION: 8 });
  assertThrows(() => legacyReader.readTemplateBundleFile(bundlePath), /模板文件版本（9）高于当前应用支持的版本（8）/,
    '⑤ 旧版（支持到 v8）读 v9 包整包拒绝');
  const target = openDatabase(path.join(dir, 'field-mapping-import.sqlite'));
  const targetMain = createMain(target);
  const imported = target.upsertTemplate({ templateKey: entry.templateKey, name: entry.name, sourceFileName: 'old.xlsx', headers: FM_HEADERS });
  targetMain.applyBundleBillSplitConfig(imported.id, readEntry);
  assertEq(target.getBillSplitMeta(imported.id), database.getBillSplitMeta(template.id), '⑤ 导入后字段映射特殊处理一致');
  assertEq(
    generateFieldMapping(targetMain, target.getTemplate(imported.id), sourcePath, path.join(dir, 'fm-out-imported.xlsx')),
    generateFieldMapping(main, template, sourcePath, path.join(dir, 'fm-out-origin.xlsx')),
    '⑤ 导入后的模板生成结果与原模板一致'
  );

  // 模板包带坏行（缺模板字段且固定值为布尔值、误包一层数组的项）：读包、导入、落库多次规范化后坏行仍保留，生成时拒绝，不静默只用有效行
  const badEntry = JSON.parse(JSON.stringify(entry));
  badEntry.billSplitMeta.feeFieldMappings = [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { valueType: 'input', value: false },
    [{ templateField: 'Payee Name', valueType: 'blank', value: '' }]
  ];
  const badBundlePath = path.join(dir, 'field-mapping-bad-bundle.json');
  fs.writeFileSync(badBundlePath, JSON.stringify({ bundleVersion: 9, channels: [], templates: [badEntry] }), 'utf8');
  const badRead = targetMain.readTemplateBundleFile(badBundlePath).templates[0];
  targetMain.applyBundleBillSplitConfig(imported.id, badRead);
  assertEq(target.getBillSplitMeta(imported.id).feeFieldMappings, [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'invalid', value: '' },
    { templateField: '', valueType: 'invalid', value: '' }
  ], '⑤ 模板包坏行导入后保留为无效行（不被当作空白行丢弃）');
  assertThrows(() => targetMain.buildBillSplitMergeConfig(target.getTemplate(imported.id), SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }),
    /字段映射特殊处理.*第 2 行：请选择模板字段/, '⑤ 带坏行的模板包导入后生成时拒绝');

  // 原始 JSON 中写成数字的固定值（读包时已被舍入：20261119.000000001 读成 20261119）：导入后记为无效，生成时拒绝，不按舍入后的值输出
  const numericEntry = JSON.parse(JSON.stringify(entry));
  numericEntry.billSplitMeta.feeFieldMappings = [{ templateField: 'Transaction Description', valueType: 'input', value: '__NUMERIC_FIXED_VALUE__' }];
  const numericBundlePath = path.join(dir, 'field-mapping-numeric-bundle.json');
  fs.writeFileSync(numericBundlePath, JSON.stringify({ bundleVersion: 9, channels: [], templates: [numericEntry] })
    .replace('"__NUMERIC_FIXED_VALUE__"', '20261119.000000001'), 'utf8');
  targetMain.applyBundleBillSplitConfig(imported.id, targetMain.readTemplateBundleFile(numericBundlePath).templates[0]);
  assertEq(target.getBillSplitMeta(imported.id).feeFieldMappings, [{ templateField: 'Transaction Description', valueType: 'invalid', value: '' }],
    '⑤ 模板包中数字固定值导入后记为无效（不保存舍入后的 20261119）');
  assertThrows(() => targetMain.buildBillSplitMergeConfig(target.getTemplate(imported.id), SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }),
    /字段映射特殊处理.*第 1 行：映射字段无效/, '⑤ 数字固定值的模板包导入后生成时拒绝');

  // 固定文本含 XML 1.0 禁止的 U+FFFE（写出后工作表无法解析）：导入后记为无效，生成时拒绝，不导出损坏的明细
  const xmlIllegalEntry = JSON.parse(JSON.stringify(entry));
  xmlIllegalEntry.billSplitMeta.feeFieldMappings = [{ templateField: 'Transaction Description', valueType: 'input', value: 'REF\uFFFE01' }];
  const xmlIllegalPath = path.join(dir, 'field-mapping-xml-illegal-bundle.json');
  fs.writeFileSync(xmlIllegalPath, JSON.stringify({ bundleVersion: 9, channels: [], templates: [xmlIllegalEntry] }), 'utf8');
  targetMain.applyBundleBillSplitConfig(imported.id, targetMain.readTemplateBundleFile(xmlIllegalPath).templates[0]);
  assertEq(target.getBillSplitMeta(imported.id).feeFieldMappings, [{ templateField: 'Transaction Description', valueType: 'invalid', value: '' }],
    '⑤ 含 U+FFFE 的固定文本导入后记为无效');
  assertThrows(() => targetMain.buildBillSplitMergeConfig(target.getTemplate(imported.id), SPLIT_MAPPINGS, { exportTargetFields: FM_FIELDS }),
    /字段映射特殊处理.*第 1 行：映射字段无效/, '⑤ 含 XML 禁止字符的固定文本生成时拒绝');
  closeDatabase(target);
}

// ==================== ⑥ v3.2.21 【返回】按打开时的快照恢复 ====================
function verifyRestore(dir, database) {
  // 主进程的撤销逻辑（读取时签发令牌、撤销时先核对令牌再写库），模板库同步与错误结果按名注入替身；
  //   活动日志用真实结构化日志写入临时目录，验证实际落到哪个级别的日志文件
  let librarySyncs = 0;
  let failLibrarySync = false;
  const logRoot = path.join(dir, 'restore-logs');
  fs.mkdirSync(logRoot, { recursive: true });
  const restoreFns = loadMainFunctions([
    'normalizeBillSplitRestoreSnapshot', 'buildBillSplitRestoreToken', 'issueBillSplitRestoreToken', 'restoreBillSplitConfigFromPayload',
    'endBillSplitRestoreSession', 'endBillSplitRestoreSessionsForOwner', 'findBillSplitRestoreSessionId', 'activateBillSplitRestoreSession',
    'syncTemplateLibraryAfterBillSplitWrite'
  ], {
    database, normalizeCell, normalizeFeeAmountFormula, normalizeFeeFieldMappings, FileValidationError,
    createHmac: require('node:crypto').createHmac, BILL_SPLIT_RESTORE_TOKEN_SECRET: require('node:crypto').randomBytes(32),
    randomUUID: require('node:crypto').randomUUID, BILL_SPLIT_RESTORE_SESSIONS: new Map(), BILL_SPLIT_RESTORE_SESSION_LIMIT: 8,
    syncTemplateLibraryFile: () => { librarySyncs += 1; if (failLibrarySync) throw new Error('磁盘空间不足'); },
    appendActivityLogEntry: (entry) => appendActivityRecord(path.join(logRoot, 'app_activity_log.txt'), entry),
    createErrorResult: ({ message }) => ({ status: 'error', message })
  });
  const readStored = (id) => ({
    billSplitRows: database.getBillSplitRows(id),
    billSplitAmountRules: database.getBillSplitAmountRules(id),
    billSplitMeta: database.getBillSplitMeta(id)
  });
  // 模拟行管理打开（template:get-bill-split-config + openRestoreSession）：开启新会话并签发令牌
  const readConfig = (id) => {
    const config = readStored(id);
    return JSON.parse(JSON.stringify({ ...config, restoreToken: restoreFns.issueBillSplitRestoreToken(database.getTemplate(id), config) }));
  };
  // 模拟行管理窗口打开并挂载：读取签发令牌后激活本会话（只有已激活的会话能撤销）
  const openWindow = (id) => {
    const opening = readConfig(id);
    restoreFns.activateBillSplitRestoreSession(id, opening.restoreToken);
    return opening;
  };
  const dbState = (id) => JSON.stringify(readStored(id));
  const restore = (id, snapshot, restoreToken) => restoreFns.restoreBillSplitConfigFromPayload(id, { restoreSnapshot: snapshot, restoreToken }, '撤销拆分账单修改');

  const template = defineFieldMappingTemplate(database, '返回恢复模板');
  database.saveBillSplitAmountRules(template.id, [{ targetField: 'Debit Amount', conditionField: '摘要', conditionValue: '费', mappedField: '手续费', rowIndex: 0 }]);
  database.saveBillSplitMeta(template.id, {
    signedAmountTargetSeqNos: [5], feeAmountFormulaEnabled: true, feeAmountFormula: [{ field: '手续费', op: 'end' }]
  });
  // 打开弹窗时读到的配置与令牌（同 template:get-bill-split-config），渲染进程原样带回快照（含 templateId）
  const opening = openWindow(template.id);
  const snapshot = { templateId: template.id, billSplitRows: opening.billSplitRows, billSplitAmountRules: opening.billSplitAmountRules, billSplitMeta: opening.billSplitMeta };
  assertTrue(typeof opening.restoreToken === 'string' && opening.restoreToken.length === 64, '⑥ 读取配置时签发恢复令牌');

  // 本次打开后的修改：份数、合并组、费用行、规则、拆分配置；另由映射关系管理【保存】写入过滤规则
  database.saveBillSplitRowCount(template.id, 3);
  database.saveBillSplitRow(template.id, { seqNo: 3, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed' });
  database.saveBillSplitMergeGroup(template.id, [1, 3]);
  database.setBillSplitFeeBillRow(template.id, 3);
  database.saveBillSplitAmountRules(template.id, []);
  database.saveBillSplitMeta(template.id, {
    signedAmountSourceField: '交易金额', signedAmountTargetSeqNos: [1], byFieldAmountTargetSeqNos: [],
    feeAmountFormulaEnabled: false, feeFieldMappingEnabled: false, feeFieldMappings: [{ templateField: 'Transaction Description', valueType: 'blank', value: '' }]
  });
  const rowFilterRules = [{ seq: 1, conditions: [{ field: '摘要', op: '等于', value: '货款' }] }];
  database.saveBillSplitMeta(template.id, { rowFilterRules });

  // 经撤销处理逻辑提交的无效请求：结构无效抛错、令牌不符返回 BILL_SPLIT_RESTORE_TOKEN_STALE，都不写库、不同步模板库
  const edited = dbState(template.id);
  assertThrows(() => restore(template.id, { ...snapshot, billSplitRows: snapshot.billSplitRows.map((row) => ({ ...row, seqNo: row.seqNo + 1 })) }, opening.restoreToken),
    /打开时记下的配置无效/, '⑥ 序号不连续的快照拒绝');
  assertThrows(() => restore(template.id, { templateId: template.id, billSplitRows: [] }, opening.restoreToken), /打开时记下的配置无效/, '⑥ 结构不完整的快照拒绝');
  assertThrows(() => restore(template.id, { ...snapshot, templateId: template.id + 1 }, opening.restoreToken), /打开时记下的配置无效/, '⑥ 其他模板的快照拒绝');
  assertThrows(() => restore(template.id, { ...snapshot, billSplitMeta: { ...snapshot.billSplitMeta, byFieldAmountTargetSeqNos: ['abc'] } }, opening.restoreToken),
    /打开时记下的配置无效/, '⑥ 无法按数字往返的指定序号整体拒绝');
  const tampered = [
    ['普通行 Credit / Debit 同列', { ...snapshot, billSplitRows: snapshot.billSplitRows.map((row) => (row.isFeeBill ? row : { ...row, debitSourceField: row.creditSourceField })) }],
    ['两种取额模式同时启用', { ...snapshot, billSplitMeta: { ...snapshot.billSplitMeta, signedAmountSourceField: '交易金额' } }],
    ['无效发生额规则', { ...snapshot, billSplitAmountRules: [{ ...snapshot.billSplitAmountRules[0], targetField: 'Balance' }] }],
    ['受保护字段覆盖', { ...snapshot, billSplitMeta: { ...snapshot.billSplitMeta, feeFieldMappings: [{ templateField: 'BillDate', valueType: 'blank', value: '' }] } }]
  ];
  tampered.forEach(([label, item]) => {
    assertEq(restore(template.id, item, opening.restoreToken).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', `⑥ 改动过的快照（${label}）签名不符被拒`);
  });
  assertEq(restore(template.id, snapshot, undefined).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', '⑥ 缺少令牌被拒');
  assertEq([dbState(template.id), librarySyncs], [edited, 0], '⑥ 拒绝时库不变、不同步模板库');

  // 模板在打开后被改动（改名改了代次）：旧令牌失效
  database.renameTemplate(template.id, '返回恢复模板-改名');
  assertEq(restore(template.id, snapshot, opening.restoreToken).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', '⑥ 模板被修改后旧令牌失效');
  assertEq(dbState(template.id), edited, '⑥ 旧令牌被拒时库不变');

  // 原样快照 + 当前会话签发的令牌：恢复为打开时（含非空发生额规则与合并组），过滤规则保留映射关系管理保存的值
  const reopened = defineFieldMappingTemplate(database, '返回恢复模板二');
  database.saveBillSplitRowCount(reopened.id, 3);
  database.saveBillSplitRow(reopened.id, { seqNo: 3, currencySourceField: '币种', creditSourceField: '交易金额', debitSourceField: '', amountSourceField: '', rowStatus: 'completed' });
  database.saveBillSplitMergeGroup(reopened.id, [1, 3]);
  database.saveBillSplitAmountRules(reopened.id, [{ targetField: 'Credit Amount', conditionField: '摘要', conditionValue: '货款', mappedField: '交易金额', rowIndex: 0 }]);
  database.saveBillSplitMeta(reopened.id, { byFieldAmountTargetSeqNos: [1.5, 9] });
  const reopenedOpening = openWindow(reopened.id);
  const reopenedSnapshot = { templateId: reopened.id, billSplitRows: reopenedOpening.billSplitRows,
    billSplitAmountRules: reopenedOpening.billSplitAmountRules, billSplitMeta: reopenedOpening.billSplitMeta };
  assertEq(reopenedSnapshot.billSplitRows.map((row) => [row.seqNo, row.mergedGroupSeq, row.isFeeBill]), [[1, 1, false], [2, null, true], [3, 1, false]],
    '⑥ 打开时有合并组与费用行');
  database.deleteBillSplitRow(reopened.id, 1);
  database.saveBillSplitAmountRules(reopened.id, []);
  database.saveBillSplitMeta(reopened.id, { feeFieldMappingEnabled: false, byFieldAmountTargetSeqNos: [], rowFilterRules });
  assertEq(restore(reopened.id, JSON.parse(JSON.stringify(reopenedSnapshot)), reopenedOpening.restoreToken), { status: 'success', restored: true },
    '⑥ 原样快照与令牌撤销成功');
  assertEq(librarySyncs, 1, '⑥ 撤销成功后同步模板库');
  assertEq(database.getBillSplitRows(reopened.id), reopenedSnapshot.billSplitRows, '⑥ 拆分行（映射、完成状态、合并组、费用标记）恢复为打开时');
  assertEq(database.getBillSplitAmountRules(reopened.id), reopenedSnapshot.billSplitAmountRules, '⑥ 非空发生额规则恢复为打开时');
  assertEq(database.getBillSplitMeta(reopened.id), { ...reopenedSnapshot.billSplitMeta, rowFilterRules },
    '⑥ 拆分配置恢复为打开时（非整数、已不存在的指定序号原样保留），过滤规则保留映射关系管理保存的值');
  assertEq(restore(reopened.id, JSON.parse(JSON.stringify(reopenedSnapshot)), reopenedOpening.restoreToken), { status: 'success', restored: true },
    '⑥ 同一会话内可重试撤销');

  // 主库已恢复后模板库文件同步失败：按撤销成功返回并单独提示（启动和下次修改时会重新同步），不报「未能撤销」
  database.saveBillSplitAmountRules(reopened.id, []);
  failLibrarySync = true;
  const syncFailed = restore(reopened.id, JSON.parse(JSON.stringify(reopenedSnapshot)), reopenedOpening.restoreToken);
  failLibrarySync = false;
  assertEq([syncFailed.status, syncFailed.restored, syncFailed.librarySyncFailed], ['success', true, true], '⑥ 撤销后模板库同步失败仍按撤销成功返回');
  assertTrue(/已撤销本次修改；模板库文件同步失败/.test(syncFailed.message), '⑥ 提示配置已撤销、模板库文件未同步');
  assertEq(database.getBillSplitAmountRules(reopened.id), reopenedSnapshot.billSplitAmountRules, '⑥ 同步失败时主库已恢复为打开时');
  const warningLog = getLogFilePath(logRoot, 'warning');
  assertTrue(fs.existsSync(warningLog) && /撤销拆分账单修改后同步模板库文件失败/.test(fs.readFileSync(warningLog, 'utf8')),
    '⑥ 同步失败写入 warning 级活动日志（logs/…/warning.log）');
  const infoLog = getLogFilePath(logRoot, 'info');
  assertTrue(!fs.existsSync(infoLog) || !/同步模板库文件失败/.test(fs.readFileSync(infoLog, 'utf8')), '⑥ 同步失败不落到 info.log');
  // 普通保存（save-bill-split-meta）共用同一同步处理：主库已提交后同步失败返回 false 并记 warning 日志，调用方按「已保存，文件未同步」提示
  failLibrarySync = true;
  assertEq(restoreFns.syncTemplateLibraryAfterBillSplitWrite(database.getTemplate(reopened.id), '保存拆分账单配置后同步模板库文件失败'), false,
    '⑥ 保存后同步失败返回 false（不抛出）');
  failLibrarySync = false;
  assertTrue(/保存拆分账单配置后同步模板库文件失败/.test(fs.readFileSync(warningLog, 'utf8')), '⑥ 保存后同步失败写入 warning 级活动日志');
  assertEq(restoreFns.syncTemplateLibraryAfterBillSplitWrite(database.getTemplate(reopened.id), '保存拆分账单配置后同步模板库文件失败'), true,
    '⑥ 同步成功返回 true');

  // 会话归属：签发给某个渲染页面的令牌只接受同一页面的恢复请求；页面销毁或渲染进程退出时主进程清理其会话
  const ownerOpening = JSON.parse(JSON.stringify({ ...readStored(reopened.id),
    restoreToken: restoreFns.issueBillSplitRestoreToken(database.getTemplate(reopened.id), readStored(reopened.id), 41) }));
  const ownerSnapshot = { templateId: reopened.id, billSplitRows: ownerOpening.billSplitRows,
    billSplitAmountRules: ownerOpening.billSplitAmountRules, billSplitMeta: ownerOpening.billSplitMeta };
  assertEq(restoreFns.activateBillSplitRestoreSession(reopened.id, ownerOpening.restoreToken), true, '⑥ 页面 41 的窗口挂载激活');
  const restoreAs = (ownerId) => restoreFns.restoreBillSplitConfigFromPayload(reopened.id,
    { restoreSnapshot: JSON.parse(JSON.stringify(ownerSnapshot)), restoreToken: ownerOpening.restoreToken }, '撤销拆分账单修改', ownerId);
  assertEq(restoreAs(42).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', '⑥ 其他渲染页面带同一令牌的恢复被拒');
  assertEq(restoreAs(41), { status: 'success', restored: true }, '⑥ 签发页面的恢复照常成功');
  restoreFns.endBillSplitRestoreSessionsForOwner(42);
  assertEq(restoreAs(41), { status: 'success', restored: true }, '⑥ 清理其他页面的会话不影响本页面');
  restoreFns.endBillSplitRestoreSessionsForOwner(41);
  assertEq(restoreAs(41).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', '⑥ 页面销毁 / 渲染进程退出后其会话令牌失效');

  // 会话：每次打开签发独立会话。打开请求因低内存屏障乱序执行时（当前窗口的请求先签发，迟到的旧请求后签发），
  //   旧请求的会话不取代当前窗口的会话；渲染层识别出旧回包后按其令牌释放，当前窗口仍能撤销
  const toSnapshot = (id, opening) => ({ templateId: id, billSplitRows: opening.billSplitRows,
    billSplitAmountRules: opening.billSplitAmountRules, billSplitMeta: opening.billSplitMeta });
  const sessionOpening = readConfig(reopened.id);
  const sessionSnapshot = toSnapshot(reopened.id, sessionOpening);
  assertEq(restoreFns.activateBillSplitRestoreSession(reopened.id, sessionOpening.restoreToken), true, '⑥ 当前窗口挂载时激活会话');
  const lateOpening = readConfig(reopened.id);
  // 同一页面有已激活会话与未挂载激活的会话（迟到的旧打开请求，尚未释放）：后者撤销被拒，库不变
  database.saveBillSplitAmountRules(reopened.id, []);
  const beforeLateRestore = dbState(reopened.id);
  assertEq(restore(reopened.id, toSnapshot(reopened.id, lateOpening), lateOpening.restoreToken).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE',
    '⑥ 未挂载激活的会话撤销被拒');
  assertEq(dbState(reopened.id), beforeLateRestore, '⑥ 未激活会话的撤销不改库（不覆盖当前窗口之后的修改）');
  restoreFns.endBillSplitRestoreSession(reopened.id, lateOpening.restoreToken);
  assertEq(restoreFns.findBillSplitRestoreSessionId(reopened.id, lateOpening.restoreToken), '', '⑥ 放弃打开的旧请求按令牌释放');
  assertEq(restore(reopened.id, sessionSnapshot, sessionOpening.restoreToken), { status: 'success', restored: true },
    '⑥ 迟到的旧打开请求签发并释放后，当前窗口仍能撤销');
  assertEq(database.getBillSplitAmountRules(reopened.id), sessionSnapshot.billSplitAmountRules, '⑥ 当前窗口撤销恢复为其打开时');
  // 窗口释放只结束本窗口令牌所属的会话：旧窗口迟到的释放（旧令牌）、缺令牌的请求都不结束当前会话
  restoreFns.endBillSplitRestoreSession(reopened.id, reopenedOpening.restoreToken);
  restoreFns.endBillSplitRestoreSession(reopened.id, true);
  restoreFns.endBillSplitRestoreSession(reopened.id);
  assertEq(restore(reopened.id, sessionSnapshot, sessionOpening.restoreToken), { status: 'success', restored: true },
    '⑥ 旧窗口迟到的释放不结束新窗口的会话');
  restoreFns.endBillSplitRestoreSession(reopened.id, sessionOpening.restoreToken);
  assertEq(restore(reopened.id, sessionSnapshot, sessionOpening.restoreToken).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE', '⑥ 会话结束（行管理窗口释放）后令牌失效');

  // 两个窗口交叠打开同一模板（A 先挂载并修改，B 后挂载并新增拆分行后确认）：B 挂载时激活本会话、作废 A 的会话，
  //   A 再点【返回】被拒，不把 B 已确认的第三行撤销掉（拆分写入不改模板代次，仅靠签名无法区分）
  const overlap = defineFieldMappingTemplate(database, '返回恢复交叠模板');
  const openingA = readConfig(overlap.id);
  restoreFns.activateBillSplitRestoreSession(overlap.id, openingA.restoreToken);
  database.saveBillSplitMeta(overlap.id, { feeFieldMappingEnabled: false });
  const openingB = readConfig(overlap.id);
  restoreFns.activateBillSplitRestoreSession(overlap.id, openingB.restoreToken);
  database.saveBillSplitRowCount(overlap.id, 3);
  restoreFns.endBillSplitRestoreSession(overlap.id, openingB.restoreToken);
  const afterB = dbState(overlap.id);
  assertEq(restore(overlap.id, toSnapshot(overlap.id, openingA), openingA.restoreToken).errorCode, 'BILL_SPLIT_RESTORE_TOKEN_STALE',
    '⑥ 被后挂载窗口取代的会话撤销被拒');
  assertEq([dbState(overlap.id), database.getBillSplitRows(overlap.id).length], [afterB, 3], '⑥ 后挂载窗口已确认的第三行保留');
  assertEq(restoreFns.activateBillSplitRestoreSession(overlap.id, openingA.restoreToken), false, '⑥ 已作废的会话不能再激活');

  // 释放失败时会话不无限累积：每个模板最多保留最近 8 个，超出时丢弃最早签发的会话
  const firstKept = readConfig(reopened.id);
  const burst = Array.from({ length: 8 }, () => readConfig(reopened.id));
  assertEq(restoreFns.findBillSplitRestoreSessionId(reopened.id, firstKept.restoreToken), '', '⑥ 超出上限时最早的会话被丢弃');
  const latestBurst = burst[burst.length - 1];
  assertEq(restoreFns.activateBillSplitRestoreSession(reopened.id, latestBurst.restoreToken), true, '⑥ 最近签发的会话保留，可挂载激活');
  assertEq(restore(reopened.id, toSnapshot(reopened.id, latestBurst), latestBurst.restoreToken), { status: 'success', restored: true },
    '⑥ 最近签发的会话保留');
  burst.forEach((opening) => restoreFns.endBillSplitRestoreSession(reopened.id, opening.restoreToken));
  assertEq(burst.map((opening) => restoreFns.findBillSplitRestoreSessionId(reopened.id, opening.restoreToken)), burst.map(() => ''),
    '⑥ 按令牌释放后会话清空');

  // 单窗口下重复点击入口：最后一次点击先挂载并激活，此前的 9 个读取在屏障解除后才签发令牌（尚未释放）。
  //   超出上限时只淘汰未激活的会话，当前窗口的撤销点保留；当前窗口修改后点【返回】照常撤销
  const activeOpening = readConfig(reopened.id);
  assertEq(restoreFns.activateBillSplitRestoreSession(reopened.id, activeOpening.restoreToken), true, '⑥ 当前窗口挂载时激活会话');
  const lateBurst = Array.from({ length: 9 }, () => readConfig(reopened.id));
  assertEq(restoreFns.findBillSplitRestoreSessionId(reopened.id, lateBurst[0].restoreToken), '', '⑥ 超出上限时淘汰最早的未激活会话');
  const beforeActiveEdit = dbState(reopened.id);
  database.saveBillSplitRowCount(reopened.id, database.getBillSplitRows(reopened.id).length + 1);
  assertEq(restore(reopened.id, toSnapshot(reopened.id, activeOpening), activeOpening.restoreToken), { status: 'success', restored: true },
    '⑥ 迟到的旧请求挤满上限后，已激活的当前窗口仍可撤销');
  assertEq(dbState(reopened.id), beforeActiveEdit, '⑥ 撤销后恢复到当前窗口打开时的状态');
  lateBurst.forEach((opening) => restoreFns.endBillSplitRestoreSession(reopened.id, opening.restoreToken));
}

async function run() {
  console.log('==== 网银账单 · 拆分/合并账单费用账单 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-bill-split-fee-bill-'));
  try {
    verifyMigration(dir);
    const database = openDatabase(path.join(dir, 'main.sqlite'));
    const main = createMain(database);
    verifyStorage(database);
    verifyGeneration(dir, database, main);
    verifyBundle(dir, database, main);
    verifyFeeFieldMapping(dir, database, main);
    verifyRestore(dir, database);
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
