'use strict';

// v3.2.19 拆分/合并账单「根据字段值过滤账单」的主进程保存校验与生成配置：
//   - 开启拆分且勾选过滤时，主映射的发生额配置不再与拆分互斥（三者仍只能选一种），且必须有一种（供未命中的行使用）；
//   - 未开启拆分时勾选值保留但不生效；MerchantId 按币种取大账号时，过滤开启后 Currency 照不拆分时的要求校验；
//   - 生成时过滤开启且不复用模块映射，主映射与拆分映射所选特征值都须有效。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const {
  buildFeatureFilterToken,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  normalizeCell,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  validateRowFilterRules,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS
} = require('../../../src/backend/file-service');
const { normalizeMaintainedBigAccounts } = require('../../../src/main-process/big-account-recognition');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const SPLIT = '是否拆分/合并明细账单';
const REUSE = '复用模块字段的映射关系';
const ROW_FILTER = '根据字段值过滤账单';
const PREPROCESS = '过滤账单';
const TARGET_FIELDS = [
  'BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Name', 'Balance',
  PREPROCESS, '按正负号拆分的发生额', '按字段区分发生额', SPLIT, REUSE, ROW_FILTER
];

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
const fns = loadMainFunctions([
  'validateTemplateConfiguration',
  'isLegacyLogicValueDirectReference',
  'validateCurrencyBigAccountConfiguration',
  'collectFeatureFilterRefs',
  'getPrimaryMappedField',
  'getMappingFieldValues',
  'normalizeMappedFields',
  'expandBigAccountConfigurations',
  'decodeCustomInputMappingValue',
  'extractFixedMappingValue',
  'resolveStatementFeatureFilters',
  'isPreprocessRowFilterEnabled',
  'isDuplicateRowFilterEnabled',
  'isCrossSheetBackfillEnabled',
  'buildPreprocessRowFilterRules'
], {
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  validateRowFilterRules,
  ...CONSTANTS,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  buildFeatureFilterToken,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  ADVANCED_MAPPING_FIELDS: [],
  CUSTOM_INPUT_TARGET_FIELDS: new Set(['MerchantId']),
  FileValidationError,
  normalizeCell,
  normalizeMaintainedBigAccounts,
  buildManagedMappingFields: () => TARGET_FIELDS.slice()
});

const TEMPLATE = { id: 9, name: '过滤模板', headers: ['日期', '账号', '币种', '收入', '支出', '金额', '类型', '附言'] };

function mappingsWith(overrides = {}) {
  const base = {
    BillDate: '日期',
    MerchantId: '账号',
    Currency: '',
    'Credit Amount': '',
    'Debit Amount': '',
    Balance: '无',
    [SPLIT]: '是'
  };
  return Object.entries({ ...base, ...overrides }).map(([templateField, value]) => ({
    templateField,
    mappedField: Array.isArray(value) ? value[0] : value,
    mappedFields: Array.isArray(value) ? value.slice(1) : []
  }));
}

function validate(overrides, extra = {}) {
  return fns.validateTemplateConfiguration({
    template: TEMPLATE,
    mappings: mappingsWith(overrides),
    enumValues: [],
    availableCurrencyCodes: ['USD', 'HKD'],
    ...extra
  });
}

function valueOf(result, field) {
  return result.mappings.find((mapping) => mapping.templateField === field)?.mappedField;
}

test('未勾选过滤：拆分与主映射直接映射仍四方互斥', () => {
  assert.throws(() => validate({ 'Credit Amount': '收入' }), /四者只能启用其中一种/);
  const result = validate({});
  assert.equal(result.usesBillSplitRowFilter, false);
});

test('开启拆分并勾选过滤：主映射可配发生额（三选一），开关存为「是」', () => {
  const direct = validate({ [ROW_FILTER]: '是', Currency: '币种', 'Credit Amount': '收入', 'Debit Amount': '支出' });
  assert.equal(direct.usesBillSplitRowFilter, true);
  assert.equal(valueOf(direct, ROW_FILTER), '是');
  assert.equal(valueOf(direct, 'Credit Amount'), '收入');
  assert.equal(valueOf(direct, 'Currency'), '币种');

  assert.equal(validate({ [ROW_FILTER]: '是', '按正负号拆分的发生额': '金额' }).usesBillSplitRowFilter, true);
  assert.equal(validate({ [ROW_FILTER]: '是', '按字段区分发生额': '是' }).usesBillSplitRowFilter, true);

  assert.throws(
    () => validate({ [ROW_FILTER]: '是', 'Credit Amount': '收入', '按正负号拆分的发生额': '金额' }),
    /直接映射、按正负号拆分的发生额、按字段区分发生额 三者只能启用其中一种/
  );
});

test('开启拆分并勾选过滤但主映射没有发生额配置时拒绝保存', () => {
  assert.throws(
    () => validate({ [ROW_FILTER]: '是' }),
    /已勾选「根据字段值过滤账单」：未命中过滤规则的账单按主映射生成，请设置/
  );
});

test('未开启拆分时勾选过滤保留但不生效', () => {
  const result = validate({ [SPLIT]: '', [ROW_FILTER]: '是', 'Credit Amount': '收入' });
  assert.equal(result.usesBillSplitRowFilter, false);
  assert.equal(valueOf(result, ROW_FILTER), '是');
  assert.equal(valueOf(validate({ [ROW_FILTER]: '否' }), ROW_FILTER), '');
});

test('MerchantId 按币种取大账号：开启过滤后 Currency 必须映射币种列', () => {
  const pairs = [{ currency: 'USD', merchantId: 'NET1' }];
  const currencyOnly = CONSTANTS.MERCHANT_ID_CURRENCY_ONLY_OPTION;
  assert.ok(currencyOnly);
  // 未开过滤：币种取自拆分行，Currency 可为空
  assert.deepEqual(validate({ MerchantId: currencyOnly }, { currencyBigAccounts: pairs }).currencyBigAccounts, pairs);
  assert.throws(
    () => validate({ MerchantId: currencyOnly, [ROW_FILTER]: '是', 'Credit Amount': '收入' }, { currencyBigAccounts: pairs }),
    /Currency 必须映射到原始账单中的币种列/
  );
  const filtered = validate(
    { MerchantId: currencyOnly, [ROW_FILTER]: '是', Currency: '币种', 'Credit Amount': '收入' },
    { currencyBigAccounts: pairs }
  );
  assert.deepEqual(filtered.currencyBigAccounts, pairs);
});

test('不复用模块映射时：勾选过滤后主映射所选特征值也须有效（保存与生成同口径）', () => {
  const featureFilters = [{ id: 'f1', name: '单号', sourceField: '附言', separator: '', digitsOnly: true }];
  const mainUsesMissingFeature = {
    [REUSE]: '否',
    'Credit Amount': '收入',
    'Payee Name': [CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, 'missing']
  };
  // 未勾选过滤：主映射不生效，残留的特征值选择不校验（Credit 也不能配，这里只验证特征值口径）
  assert.doesNotThrow(() => validate({ [REUSE]: '否', 'Payee Name': [CONSTANTS.FEATURE_FILTER_MAPPING_FIELD, 'missing'] }, { featureFilters }));
  assert.throws(() => validate({ ...mainUsesMissingFeature, [ROW_FILTER]: '是' }, { featureFilters }), /特征值/);

  const token = buildFeatureFilterToken('f1');
  const template = { headers: TEMPLATE.headers, featureFilters };
  const splitConfig = (rowFilterRules) => ({
    enabled: true,
    reuseModuleMapping: false,
    billSplitMappingByTargetField: { BillDate: '日期' },
    rowFilterRules
  });
  assert.deepEqual(Object.keys(fns.resolveStatementFeatureFilters(template, { 'Payee Name': token }, splitConfig(null))), []);
  assert.deepEqual(
    Object.keys(fns.resolveStatementFeatureFilters(template, { 'Payee Name': token }, splitConfig([{ seq: 1, conditions: [] }]))),
    ['f1']
  );
});

test('原始账单预处理「过滤账单」：开关规范为 是 / 空，与拆分/合并无关', () => {
  const on = validate({ [SPLIT]: '', 'Credit Amount': '收入', [PREPROCESS]: '是' });
  assert.equal(on.usesPreprocessRowFilter, true);
  assert.equal(valueOf(on, PREPROCESS), '是');
  const off = validate({ [SPLIT]: '', 'Credit Amount': '收入', [PREPROCESS]: '否' });
  assert.equal(off.usesPreprocessRowFilter, false);
  assert.equal(valueOf(off, PREPROCESS), '');
  assert.equal(validate({ [PREPROCESS]: '是' }).usesPreprocessRowFilter, true);
});

test('原始账单预处理生成配置：勾选时下发有效规则，规则缺失或无效拒绝生成，未勾选为 null', () => {
  const template = { name: '过滤模板', preprocessRowFilterRules: [{ seq: 1, conditions: [{ field: '类型', op: '等于（字段）', value: '附言' }] }] };
  const enabled = [{ templateField: PREPROCESS, mappedField: '是' }];
  assert.deepEqual(fns.buildPreprocessRowFilterRules(template, enabled), template.preprocessRowFilterRules);
  assert.equal(fns.buildPreprocessRowFilterRules(template, [{ templateField: PREPROCESS, mappedField: '' }]), null);
  assert.throws(
    () => fns.buildPreprocessRowFilterRules({ name: '过滤模板', preprocessRowFilterRules: [] }, enabled),
    (error) => error.code === 'PREPROCESS_ROW_FILTER_MISSING' && /已勾选原始账单预处理「过滤账单」，但过滤规则未设置完整/.test(error.message)
  );
  assert.throws(
    () => fns.buildPreprocessRowFilterRules({ name: '过滤模板', preprocessRowFilterRules: [{ conditions: [{ field: '类型', op: '包含（字段）', value: '' }] }] }, enabled),
    /请选择比较字段/
  );
});
