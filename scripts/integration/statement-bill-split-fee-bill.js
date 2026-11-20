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
  assertTrue(!hasColumn(seed.db, 'template_bill_split_rows', 'is_fee_bill'), '① 构造旧库：无 is_fee_bill 列');
  closeDatabase(seed);

  const upgraded = openDatabase(dbPath);
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_rows', 'is_fee_bill'), '① 启动补 is_fee_bill 列');
  assertTrue(hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_amount_formula_enabled')
    && hasColumn(upgraded.db, 'template_bill_split_meta', 'fee_amount_formula_json'), '① 启动补费用账单公式列');
  assertEq(upgraded.getBillSplitRows(template.id).map((row) => row.isFeeBill), [false, false], '① 原有拆分行不是费用账单');
  assertEq(upgraded.getBillSplitMeta(template.id), {
    signedAmountSourceField: '交易金额',
    signedAmountTargetSeqNos: [1],
    byFieldAmountTargetSeqNos: [],
    feeAmountFormulaEnabled: false,
    feeAmountFormula: [],
    rowFilterRules: []
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
    rowFilterRules: []
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
  assertThrows(() => main.buildBillSplitMergeConfig(template, SPLIT_MAPPINGS), /费用账单发生额特殊取值逻辑.*请至少新增一组运算字段/,
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
    signedAmountSourceField: '', feeAmountFormulaEnabled: true, feeAmountFormula: FEE_FORMULA, rowFilterRules: []
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
