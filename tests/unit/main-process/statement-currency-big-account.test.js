'use strict';

// v3.2.16：MerchantId「原始账单仅有币种无账户号」的主进程规则（spec §4.1、§4.4、§4.5）。
//   - 保存校验：Currency 必须映射到真实币种列（拆分 / 合并明细账单除外）；至少 1 组；币种必须在币种映射表中、
//     不区分大小写且不能重复，统一存大写；一个大账号可对应多个币种；不写入维护大账号的大账号表；
//   - 选项文字与存储标记往返：存储值不带 __FIXED__: 前缀，读回时不被当成「自己输入」或固定账号；
//   - 生成配置读取模板的 币种 → 大账号，没有配置时拒绝；
//   - 模板包 v6 带 currencyBigAccounts，v5 读为空，v7 拒绝；
//   - 按文件名映射导入时识别本模式文件，用于跳过 / 阻断大账号选择。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const {
  FEATURE_FILTER_FIELD_TOKEN,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell,
  normalizeFeatureFilterRule
} = require('../../../src/backend/file-service');
const { normalizeMaintainedBigAccounts } = require('../../../src/main-process/big-account-recognition');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const OPTION = '原始账单仅有币种无账户号';
const TARGET_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', '是否拆分/合并明细账单'];

// main.js 顶层的字符串 / 数字常量（如 MERCHANT_ID_SELF_INPUT_OPTION、BILL_SPLIT_MERGE_MAPPING_FIELD）按源码取值，避免测试里抄一份。
function readTopLevelLiteralConstants() {
  const constants = {};
  MAIN_AST.body.forEach((node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    node.declarations.forEach((declaration) => {
      if (declaration.id.type === 'Identifier' && declaration.init && declaration.init.type === 'Literal') {
        constants[declaration.id.name] = declaration.init.value;
      }
    });
  });
  return constants;
}

function loadMainFunctions(names, deps) {
  const sources = names.map((name) => {
    const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  const depNames = Object.keys(deps);
  return Function(...depNames, `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(...depNames.map((key) => deps[key]));
}

const CONSTANTS = readTopLevelLiteralConstants();
const currencyBigAccountsByTemplateId = new Map();
const fns = loadMainFunctions([
  'validateTemplateConfiguration',
  'validateCurrencyBigAccountConfiguration',
  'resolveSavedFeatureFilter',
  'getPrimaryMappedField',
  'getMappingFieldValues',
  'normalizeMappedFields',
  'expandBigAccountConfigurations',
  'decodeCustomInputMappingValue',
  'extractFixedMappingValue',
  'buildCompatibleBigAccounts',
  'normalizeMappingRows',
  'resolveCurrentMappings',
  'buildCurrencyBigAccountMappingConfig',
  'readTemplateBundleFile',
  'isCurrencyOnlyMerchantMapping',
  'isMultiBigAccountMapping',
  'classifyCurrencyOnlyEntries'
], {
  ...CONSTANTS,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  // 同轮合入的「字段筛选特征值」：validateTemplateConfiguration 会引用
  FEATURE_FILTER_FIELD_TOKEN,
  normalizeFeatureFilterRule,
  ADVANCED_MAPPING_FIELDS: [],
  CUSTOM_INPUT_TARGET_FIELDS: new Set(['MerchantId']),
  FileValidationError,
  normalizeCell,
  normalizeMaintainedBigAccounts,
  buildManagedMappingFields: () => TARGET_FIELDS.slice(),
  normalizeBundleTemplateHeaders: (headers) => headers.map((header) => normalizeCell(header)),
  normalizeBundleAccountMappings: () => [],
  database: { getTemplateCurrencyBigAccounts: (templateId) => currencyBigAccountsByTemplateId.get(templateId) || [] },
  fs,
  path
});

const TEMPLATE = { id: 7, name: '招商银行-上海', headers: ['日期', '币种', '收入', '支出', '摘要'] };
const CODES = ['CNY', 'USD', 'EUR', 'HKD'];

function mappingsWith(overrides = {}) {
  const base = {
    BillDate: '日期',
    MerchantId: OPTION,
    Currency: '币种',
    'Credit Amount': '收入',
    'Debit Amount': '支出',
    Balance: '无'
  };
  return Object.entries({ ...base, ...overrides }).map(([templateField, mappedField]) => ({
    templateField,
    mappedField,
    mappedFields: []
  }));
}

function validate(options = {}) {
  return fns.validateTemplateConfiguration({
    template: TEMPLATE,
    mappings: mappingsWith(options.mappings),
    enumValues: [],
    bigAccounts: options.bigAccounts || [],
    currencyBigAccounts: options.currencyBigAccounts || [],
    availableCurrencyCodes: options.availableCurrencyCodes === undefined ? CODES : options.availableCurrencyCodes
  });
}

function expectInvalid(options, pattern) {
  assert.throws(() => validate(options), (error) => {
    assert.equal(error.code, 'CURRENCY_BIG_ACCOUNT_INVALID');
    assert.match(error.message, pattern);
    return true;
  });
}

test('保存校验通过时：MerchantId 存不带前缀的标记，Currency 保留币种列，币种存大写，大账号表为空', () => {
  const result = validate({
    currencyBigAccounts: [
      { currency: 'usd', merchantId: ' NET1 ' },
      { currency: '', merchantId: '' },
      { currency: 'Hkd', merchantId: 'NET1' },
      { currency: 'EUR', merchantId: 'NET2' }
    ],
    // 切换前「自己输入」留下的大账号不随本模式保存
    bigAccounts: [{ merchantId: 'OLD', currencies: ['USD'] }]
  });

  const byField = new Map(result.mappings.map((mapping) => [mapping.templateField, mapping.mappedField]));
  assert.equal(byField.get('MerchantId'), MERCHANT_ID_CURRENCY_ONLY_MARKER);
  assert.ok(!MERCHANT_ID_CURRENCY_ONLY_MARKER.startsWith(FIXED_FIELD_VALUE_PREFIX));
  assert.equal(byField.get('Currency'), '币种');
  assert.deepEqual(result.currencyBigAccounts, [
    { currency: 'USD', merchantId: 'NET1' },
    { currency: 'HKD', merchantId: 'NET1' },
    { currency: 'EUR', merchantId: 'NET2' }
  ]);
  assert.deepEqual(result.bigAccounts, []);
});

test('保存校验：Currency 必须映射到原始账单中的单个币种列（拆分 / 合并明细账单除外）', () => {
  const pairs = [{ currency: 'USD', merchantId: 'NET1' }];
  expectInvalid({ mappings: { Currency: '' }, currencyBigAccounts: pairs }, /Currency 必须映射到原始账单中的币种列/);
  expectInvalid({ mappings: { Currency: '__FIXED__:USD' }, currencyBigAccounts: pairs }, /Currency 必须映射到原始账单中的币种列/);

  const withBillSplit = validate({
    mappings: { Currency: '', 'Credit Amount': '', 'Debit Amount': '', '是否拆分/合并明细账单': '是' },
    currencyBigAccounts: pairs
  });
  assert.deepEqual(withBillSplit.currencyBigAccounts, pairs);
});

test('保存校验：至少 1 组、币种与大账号都必填、币种在币种映射表中且不重复', () => {
  expectInvalid({ currencyBigAccounts: [] }, /至少维护 1 组币种与大账号/);
  expectInvalid({ currencyBigAccounts: [{ currency: '', merchantId: '' }] }, /至少维护 1 组币种与大账号/);
  expectInvalid({ currencyBigAccounts: [{ currency: 'USD', merchantId: 'N' }, { currency: '', merchantId: 'N2' }] }, /第 2 行币种为空/);
  expectInvalid({ currencyBigAccounts: [{ currency: 'USD', merchantId: '' }] }, /第 1 行大账号为空/);
  expectInvalid({ currencyBigAccounts: [{ currency: 'XYZ', merchantId: 'N' }] }, /第 1 行币种「XYZ」不在币种映射表中/);
  expectInvalid(
    { currencyBigAccounts: [{ currency: 'USD', merchantId: 'N1' }, { currency: 'usd', merchantId: 'N2' }] },
    /币种「USD」重复（第 1、2 行），一个币种只能对应一个大账号/
  );
  expectInvalid({ currencyBigAccounts: [{ currency: 'USD', merchantId: 'N' }], availableCurrencyCodes: [] }, /未读取到币种映射表/);
});

test('其他 MerchantId 模式不带 币种 → 大账号', () => {
  const result = fns.validateTemplateConfiguration({
    template: TEMPLATE,
    mappings: mappingsWith({ MerchantId: '摘要' }),
    enumValues: [],
    currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }],
    availableCurrencyCodes: CODES
  });
  assert.deepEqual(result.currencyBigAccounts, []);
});

test('读回时存储标记显示为选项文字，不当成「自己输入」或固定账号，Currency 保留', () => {
  assert.deepEqual(fns.decodeCustomInputMappingValue(MERCHANT_ID_CURRENCY_ONLY_MARKER), {
    isCustomInput: false,
    mappedField: OPTION,
    customValue: '',
    isMultiBigAccount: false
  });
  const storedMappings = mappingsWith({ MerchantId: MERCHANT_ID_CURRENCY_ONLY_MARKER });
  assert.deepEqual(fns.buildCompatibleBigAccounts({ mappings: storedMappings, bigAccounts: [] }), []);

  const rows = fns.normalizeMappingRows({ template: TEMPLATE, mappings: storedMappings, enumValues: [], bigAccounts: [] });
  const byField = new Map(rows.map((row) => [row.templateField, row]));
  assert.equal(byField.get('MerchantId').mappedField, OPTION);
  assert.equal(byField.get('MerchantId').isMultiBigAccount, false);
  assert.equal(byField.get('Currency').mappedField, '币种');

  // 读回的映射再保存仍是同一存储值（往返稳定）
  const revalidated = fns.validateTemplateConfiguration({
    template: TEMPLATE,
    mappings: rows,
    enumValues: [],
    currencyBigAccounts: [{ currency: 'USD', merchantId: 'NET1' }],
    availableCurrencyCodes: CODES
  });
  assert.equal(revalidated.mappings.find((mapping) => mapping.templateField === 'MerchantId').mappedField, MERCHANT_ID_CURRENCY_ONLY_MARKER);
});

test('生成配置读取模板的 币种 → 大账号，没有配置时拒绝', () => {
  currencyBigAccountsByTemplateId.set(7, [{ currency: 'USD', merchantId: 'NET1' }, { currency: 'EUR', merchantId: '' }]);
  assert.deepEqual(fns.buildCurrencyBigAccountMappingConfig(TEMPLATE, '招商银行-上海'), {
    templateName: '招商银行-上海',
    pairs: [{ currency: 'USD', merchantId: 'NET1' }]
  });

  currencyBigAccountsByTemplateId.set(7, []);
  assert.throws(
    () => fns.buildCurrencyBigAccountMappingConfig(TEMPLATE, '招商银行-上海'),
    (error) => error.code === 'CURRENCY_BIG_ACCOUNT_CONFIG_MISSING' && /招商银行-上海/.test(error.message)
  );
});

test('模板包：v6 读取 currencyBigAccounts，v5 读为空，高于 v6 拒绝', (t) => {
  assert.equal(CONSTANTS.SUPPORTED_BUNDLE_VERSION, 6);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (bundleVersion, extra = {}) => {
    const filePath = path.join(dir, `v${bundleVersion}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      bundleVersion,
      templates: [{ name: '招商银行-上海', headers: ['日期'], mappings: [], ...extra }]
    }));
    return filePath;
  };
  const readBundle = (filePath) => loadMainFunctions(['readTemplateBundleFile'], {
    SUPPORTED_BUNDLE_VERSION: CONSTANTS.SUPPORTED_BUNDLE_VERSION,
    FileValidationError,
    normalizeCell,
    normalizeBundleTemplateHeaders: (headers) => headers,
    normalizeBundleAccountMappings: () => [],
    fs
  }).readTemplateBundleFile(filePath);

  const v6 = readBundle(write(6, { currencyBigAccounts: [{ currency: ' usd ', merchantId: ' NET1 ' }] }));
  assert.deepEqual(v6.templates[0].currencyBigAccounts, [{ currency: 'usd', merchantId: 'NET1' }]);
  assert.deepEqual(readBundle(write(5)).templates[0].currencyBigAccounts, []);
  assert.throws(() => readBundle(write(7)), /请升级应用后再导入/);
});

test('按文件名映射导入：识别本模式文件，用于跳过或阻断大账号选择', () => {
  const configs = new Map([
    [1, { exportMappings: [{ templateField: 'MerchantId', mappedField: MERCHANT_ID_CURRENCY_ONLY_MARKER }] }],
    [2, { exportMappings: [{ templateField: 'MerchantId', mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__' }] }]
  ]);
  const currencyOnlyEntry = { filePath: '/x/币种账单.xlsx', matchedTemplateId: 1 };
  const multiEntry = { filePath: '/x/自己输入.xlsx', matchedTemplateId: 2 };

  assert.deepEqual(fns.classifyCurrencyOnlyEntries([currencyOnlyEntry, currencyOnlyEntry], configs), {
    currencyOnlyFileNames: ['币种账单.xlsx', '币种账单.xlsx'],
    allCurrencyOnly: true
  });
  assert.deepEqual(fns.classifyCurrencyOnlyEntries([currencyOnlyEntry, multiEntry], configs), {
    currencyOnlyFileNames: ['币种账单.xlsx'],
    allCurrencyOnly: false
  });
  assert.deepEqual(fns.classifyCurrencyOnlyEntries([multiEntry], configs), { currencyOnlyFileNames: [], allCurrencyOnly: false });
  assert.equal(fns.isMultiBigAccountMapping(configs.get(1).exportMappings), false);
});
