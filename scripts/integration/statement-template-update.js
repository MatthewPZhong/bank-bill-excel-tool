// 网银账单：模板管理【更新】（v3.2.18）e2e 集成验证
//   覆盖：真实主库 + 真实 xlsx 读取与写出 + main.js 中的真实预览、确认更新、保存校验与生成配置函数
//   ① 现有有效模板生成不受新拦截影响（no-op）
//   ② 预览：读新模板文件表头，分组汇总新增/删除/顺序，列出受影响的映射（含未启用标注）；预览不写库
//   ③ 拒绝：与其他模板表头重复、字段无变化、期望表头不一致（确认期间被修改）、重复提交、模板已删除——均不写库
//   ④ 确认更新：只替换表头与源文件名，映射与其余配置保留；同步模板库文件、写活动日志；返回失效映射
//   ⑤ 生成前拦截：失效映射未修改前生成报 TEMPLATE_MAPPING_FIELD_MISSING 并列出字段；未启用的失效配置不拦截
//   ⑥ 修改映射后按新字段生成，回读导出明细金额取自新列；旧格式账单文件不再匹配该模板
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
  FEATURE_FILTER_FIELD_TOKEN,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  loadCurrencyMappings,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell,
  normalizeFeatureFilterRule,
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
  'CONCAT_FIELDS_MAPPING_FIELD', 'FEATURE_FILTER_MAPPING_FIELD', 'CUSTOM_INPUT_TARGET_FIELDS',
  'SIGNED_AMOUNT_MAPPING_FIELD', 'AMOUNT_BASED_NAME_MAPPING_FIELD', 'AMOUNT_BASED_ACCOUNT_MAPPING_FIELD',
  'AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD', 'AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION',
  'BILL_SPLIT_MERGE_MAPPING_FIELD', 'BILL_SPLIT_MERGE_ENABLED_OPTION', 'REUSE_MODULE_MAPPING_FIELD', 'REUSE_MODULE_DEFAULT_OPTION',
  'ADVANCED_MAPPING_FIELDS', 'BILL_SPLIT_GROUP_FIELDS', 'FILENAME_MAPPING_TEMPLATE_ID', 'MISSING_ENUM_MESSAGE'
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
    'validateTemplateConfiguration',
    'resolveSavedFeatureFilter',
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
    'buildStatementGenerationConfig',
    'resolveStatementFeatureFilter',
    'buildBillSplitMergeConfig',
    'buildAmountSplitByFieldConfig',
    'buildMappedRowsForFile',
    'validateBillSplitMappingsPayload',
    'validateCurrencyBigAccountConfiguration',
    'buildCurrencyBigAccountMappingConfig',
    'isCurrencyOnlyMerchantMapping',
    'normalizeBundleTemplateHeaders',
    'findConflictingTemplateByHeaders',
    'buildTemplateFieldReferenceInput',
    'collectStaleTemplateFieldReferences',
    'prepareTemplateHeaderUpdate',
    'applyTemplateHeaderUpdate'
  ], {
    ...CONSTANTS,
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools(CONSTANTS),
    diffTemplateHeaders,
    extractHeaders,
    database,
    fs,
    path,
    normalizeCell,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX,
    FEATURE_FILTER_FIELD_TOKEN,
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    normalizeFeatureFilterRule,
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
    syncTemplateLibraryFile: () => { spies.librarySyncs += 1; },
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
