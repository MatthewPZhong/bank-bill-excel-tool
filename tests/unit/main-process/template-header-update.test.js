'use strict';

// v3.2.18 模板管理【更新】：新旧表头对比、引用源字段位置收集（含启用口径）、失效引用格式化与生成前拦截。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders,
  findStaleFieldReferences,
  formatFieldReferenceLines
} = require('../../../src/main-process/template-header-update');
const { MERCHANT_ID_CURRENCY_ONLY_MARKER } = require('../../../src/backend/file-service/common');

// 与 main.js 中的映射标记常量一致
const CONSTANTS = Object.freeze({
  BALANCE_DISABLED_OPTION: '无',
  BALANCE_CALCULATED_OPTION: '通过发生额计算',
  MERCHANT_ID_SELF_INPUT_OPTION: '自己输入',
  MERCHANT_ID_CURRENCY_ONLY_OPTION: '原始账单仅有币种无账户号',
  CONCAT_FIELDS_MAPPING_FIELD: '需要拼接字段',
  FEATURE_FILTER_MAPPING_FIELD: '字段筛选特征值',
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD: '按字段区分发生额',
  AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION: '是',
  BILL_SPLIT_MERGE_MAPPING_FIELD: '是否拆分/合并明细账单',
  BILL_SPLIT_MERGE_ENABLED_OPTION: '是',
  REUSE_MODULE_MAPPING_FIELD: '复用模块字段的映射关系'
});
const tools = createTemplateHeaderUpdateTools(CONSTANTS);
const mapping = (templateField, mappedField, mappedFields = []) => ({ templateField, mappedField, mappedFields });

test('diffTemplateHeaders：新增、删除、顺序与完全相同', () => {
  assert.deepEqual(diffTemplateHeaders(['日期', '金额', '摘要'], ['日期', '金额', '摘要']), {
    identical: true, added: [], removed: [], orderChanged: false
  });
  assert.deepEqual(diffTemplateHeaders(['日期', '金额', '摘要'], ['日期', '金额(元)', '摘要', '附言']), {
    identical: false, added: ['金额(元)', '附言'], removed: ['金额'], orderChanged: false
  });
  assert.deepEqual(diffTemplateHeaders(['日期', '金额', '摘要'], ['金额', '日期', '摘要']), {
    identical: false, added: [], removed: [], orderChanged: true
  });
  // 插入列不算顺序调整
  assert.equal(diffTemplateHeaders(['A', 'B', 'C'], ['A', 'X', 'B', 'C']).orderChanged, false);
  // 仅空白占位位置变化：字段集合相同但整组不同，视为顺序调整
  assert.deepEqual(diffTemplateHeaders(['A', '', 'B'], ['A', 'B', '']), {
    identical: false, added: [], removed: [], orderChanged: true
  });
  // 规范化：首尾空白不算变化；重名只列一次
  assert.equal(diffTemplateHeaders([' 日期 ', '金额'], ['日期', '金额']).identical, true);
  assert.deepEqual(diffTemplateHeaders(['A'], ['A', 'B', 'B']).added, ['B']);
});

test('collect：主映射与拼接字段为源字段引用，内部标记与开关字段排除', () => {
  const references = tools.collectTemplateFieldReferences({
    mappings: [
      mapping('BillDate', '交易日期'),
      mapping('Remark', '需要拼接字段', ['摘要', '对方户名', '__FIXED__:-']),
      mapping('Balance', '通过发生额计算'),
      mapping('MerchantId', '__FIXED__:__MULTI_BIG_ACCOUNT__'),
      mapping('Description', '字段筛选特征值'),
      mapping('按字段区分发生额', '是'),
      mapping('是否拆分/合并明细账单', ''),
      mapping('复用模块字段的映射关系', '是'),
      mapping('按正负号拆分的发生额', '交易金额'),
      mapping('Empty', '')
    ]
  });
  assert.deepEqual(references.map((item) => `${item.target}<-${item.field}:${item.active}`), [
    'BillDate<-交易日期:true',
    'Remark<-摘要:true',
    'Remark<-对方户名:true',
    '按正负号拆分的发生额<-交易金额:true'
  ]);
  // 按币种取大账号的存储标记只在 MerchantId 上是内部值；Balance 的「无」同理只在 Balance 上是选项
  assert.deepEqual(tools.collectTemplateFieldReferences({
    mappings: [mapping('MerchantId', MERCHANT_ID_CURRENCY_ONLY_MARKER), mapping('Balance', '无')]
  }), []);
});

// 回归（review P1）：与选项同名的真实列名可以合法保存，生成器按源字段读取，必须同样计入引用。
test('collect：与选项同名的真实列名在非对应目标字段上按源字段计入，失效时拦截', () => {
  const mappings = [
    mapping('BillDate', '交易日期'),
    mapping('Credit Amount', '自己输入'),
    mapping('Debit Amount', '通过发生额计算'),
    mapping('Fee', '无'),
    mapping('Name', '原始账单仅有币种无账户号')
  ];
  assert.deepEqual(tools.collectTemplateFieldReferences({ mappings }).map((item) => `${item.target}<-${item.field}`), [
    'BillDate<-交易日期',
    'Credit Amount<-自己输入',
    'Debit Amount<-通过发生额计算',
    'Fee<-无',
    'Name<-原始账单仅有币种无账户号'
  ]);
  assert.throws(
    () => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['交易日期', '通过发生额计算', '无', '原始账单仅有币种无账户号'] }, { mappings }),
    (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /映射字段不存在：自己输入，/.test(error.message)
  );
});

// 回归（第二轮 review P1）：模式只由外层 mappedField 决定；拼接展开后的字段即使与模式名称同名，生成器也按源列读取。
test('collect：拼接字段中与模式名称同名的真实列按源字段计入，失效时拦截', () => {
  const mappings = [mapping('Credit Amount', '需要拼接字段', ['字段筛选特征值', '需要拼接字段'])];
  assert.deepEqual(tools.collectTemplateFieldReferences({ mappings }).map((item) => item.field), ['字段筛选特征值', '需要拼接字段']);
  assert.throws(() => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['需要拼接字段'] }, { mappings }),
    (error) => /映射字段不存在：字段筛选特征值，/.test(error.message));
  // 外层为字段筛选特征值时不读源列（规则的筛选字段另行计入）
  assert.deepEqual(tools.collectTemplateFieldReferences({ mappings: [mapping('Remark', '字段筛选特征值', ['附言'])] }), []);
});

// 回归（第三轮 review P1）：MerchantId 只在首个 token 为按币种标记时走回填，Balance 只在单个选项值时为选项。
test('collect：MerchantId 标记与 Balance 选项只在生成器视为特殊的位置排除', () => {
  const fields = (mappings) => tools.collectTemplateFieldReferences({ mappings }).map((item) => `${item.target}<-${item.field}`);
  assert.deepEqual(fields([mapping('MerchantId', '需要拼接字段', ['账号前缀', MERCHANT_ID_CURRENCY_ONLY_MARKER])]),
    ['MerchantId<-账号前缀', `MerchantId<-${MERCHANT_ID_CURRENCY_ONLY_MARKER}`]);
  assert.deepEqual(fields([mapping('MerchantId', '需要拼接字段', [MERCHANT_ID_CURRENCY_ONLY_MARKER, '账号前缀'])]), []);
  assert.deepEqual(fields([mapping('Balance', '需要拼接字段', ['余额A', '通过发生额计算', '无'])]),
    ['Balance<-余额A', 'Balance<-通过发生额计算', 'Balance<-无']);
  assert.deepEqual(fields([mapping('Balance', '通过发生额计算')]), []);
  // 拆分映射同口径
  assert.deepEqual(tools.collectTemplateFieldReferences({
    mappings: [mapping('是否拆分/合并明细账单', '是'), mapping('复用模块字段的映射关系', '否')],
    billSplitMappings: [mapping('MerchantId', '需要拼接字段', ['账号前缀', MERCHANT_ID_CURRENCY_ONLY_MARKER])]
  }).map((item) => `${item.area}:${item.field}`), ['bill-split-mapping:账号前缀', `bill-split-mapping:${MERCHANT_ID_CURRENCY_ONLY_MARKER}`]);
});

// 回归（review P2）：与生成器 normalizeMappedFields 一致，单元素 mappedFields 优先于 mappedField。
test('collect：单元素 mappedFields 优先于 mappedField（与生成器取值一致）', () => {
  const input = {
    mappings: [mapping('是否拆分/合并明细账单', '是'), mapping('复用模块字段的映射关系', '否')],
    billSplitMappings: [mapping('MerchantId', '账号A', ['账号B'])]
  };
  assert.deepEqual(tools.collectTemplateFieldReferences(input).map((item) => `${item.area}:${item.field}:${item.active}`), ['bill-split-mapping:账号B:true']);
  assert.throws(() => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['账号A'] }, input),
    (error) => /映射字段不存在：账号B，/.test(error.message));
  assert.doesNotThrow(() => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['账号B'] }, input));
  // 主映射同理；mappedFields 全为空白时回退到 mappedField
  assert.deepEqual(tools.collectTemplateFieldReferences({ mappings: [mapping('Remark', '附言', [' '])] }).map((item) => item.field), ['附言']);
});

test('collect：按字段区分发生额规则仅在开启且规则完整时启用', () => {
  const rules = [
    { targetField: 'Credit Amount', conditionField: '借贷', conditionValue: '贷', mappedField: '金额' },
    { targetField: 'Debit Amount', conditionField: '借贷', conditionValue: '借', mappedField: '' }
  ];
  const off = tools.collectTemplateFieldReferences({ mappings: [], amountSplitRules: rules });
  assert.ok(off.every((item) => item.active === false));
  const on = tools.collectTemplateFieldReferences({
    mappings: [mapping('按字段区分发生额', '是')],
    amountSplitRules: rules
  });
  assert.deepEqual(on.map((item) => `${item.target}/${item.role}/${item.field}:${item.active}`), [
    'Credit Amount/condition/借贷:true',
    'Credit Amount/mapped/金额:true',
    'Debit Amount/condition/借贷:false'
  ]);
});

test('collect：拆分/合并按开关、复用与行状态判定启用；字段筛选按实际生效的映射判定', () => {
  const input = (switches) => ({
    mappings: [mapping('Description', '摘要'), ...switches],
    billSplitMappings: [mapping('Remark', '附言'), mapping('Description', '字段筛选特征值')],
    billSplitRows: [
      { seqNo: 1, currencySourceField: '__FIXED__:CNY', creditSourceField: '收入', debitSourceField: '', amountSourceField: '', rowStatus: 'completed' },
      { seqNo: 2, currencySourceField: '', creditSourceField: '', debitSourceField: '支出', amountSourceField: '', rowStatus: 'draft' }
    ],
    billSplitAmountRules: [{ targetField: 'Debit Amount', conditionField: '方向', mappedField: '金额' }],
    billSplitSignedAmountSourceField: '有符号金额',
    featureFilter: { sourceField: '附言' }
  });
  const activeOf = (references) => Object.fromEntries(references.map((item) => [`${item.area}:${item.field}`, item.active]));

  const disabled = activeOf(tools.collectTemplateFieldReferences(input([])));
  assert.equal(disabled['mapping:摘要'], true);
  assert.equal(disabled['bill-split-mapping:附言'], false);
  assert.equal(disabled['bill-split-row:收入'], false);
  assert.equal(disabled['bill-split-amount:方向'], false);
  assert.equal(disabled['bill-split-signed:有符号金额'], false);
  assert.equal(disabled['feature-filter:附言'], false);

  const reused = activeOf(tools.collectTemplateFieldReferences(input([mapping('是否拆分/合并明细账单', '是')])));
  assert.equal(reused['bill-split-mapping:附言'], false);
  assert.equal(reused['bill-split-row:收入'], true);
  assert.equal(reused['bill-split-row:支出'], false);
  assert.equal(reused['bill-split-amount:金额'], true);
  assert.equal(reused['bill-split-signed:有符号金额'], true);
  assert.equal(reused['feature-filter:附言'], false);

  const notReused = activeOf(tools.collectTemplateFieldReferences(input([
    mapping('是否拆分/合并明细账单', '是'),
    mapping('复用模块字段的映射关系', '否')
  ])));
  assert.equal(notReused['bill-split-mapping:附言'], true);
  assert.equal(notReused['feature-filter:附言'], true);

  const mainFilter = activeOf(tools.collectTemplateFieldReferences({
    mappings: [mapping('Description', '字段筛选特征值')],
    featureFilter: { sourceField: '附言' }
  }));
  assert.equal(mainFilter['feature-filter:附言'], true);
});

test('findStale / format：按表头找出失效引用；无表头信息时不判定', () => {
  const references = tools.collectTemplateFieldReferences({
    mappings: [mapping('BillDate', '交易日期'), mapping('Credit Amount', '交易金额'), mapping('Remark', '需要拼接字段', ['摘要', '附言'])],
    amountSplitRules: [{ targetField: 'Debit Amount', conditionField: '借贷', mappedField: '交易金额' }]
  });
  const stale = findStaleFieldReferences(references, ['交易日期', '交易金额(元)', '摘要']);
  assert.deepEqual(formatFieldReferenceLines(stale), [
    'Credit Amount ← 交易金额',
    'Remark ← 附言',
    '按字段区分发生额 · Debit Amount 判断字段 ← 借贷（未启用）',
    '按字段区分发生额 · Debit Amount 取值字段 ← 交易金额（未启用）'
  ]);
  assert.deepEqual(findStaleFieldReferences(references, null), []);
});

test('assert：启用的失效引用拒绝生成并列出字段；未启用或有效时不拦截', () => {
  const template = { name: '招商银行-上海', headers: ['交易日期', '交易金额(元)'] };
  assert.throws(() => tools.assertTemplateFieldReferencesAvailable(template, {
    mappings: [mapping('BillDate', '交易日期'), mapping('Credit Amount', '交易金额'), mapping('Debit Amount', '交易金额')]
  }), (error) => {
    assert.equal(error.name, 'FileValidationError');
    assert.equal(error.code, 'TEMPLATE_MAPPING_FIELD_MISSING');
    assert.equal(error.message, '模板「招商银行-上海」的映射字段不存在：交易金额，请在模板管理中修改映射关系后重新导入');
    assert.deepEqual(error.detailLines, [
      '以下映射引用的字段已不在模板表头中：',
      'Credit Amount ← 交易金额',
      'Debit Amount ← 交易金额'
    ]);
    assert.deepEqual(error.context.missingFields, ['交易金额']);
    return true;
  });
  // 未启用的按字段区分发生额规则不拦截
  assert.doesNotThrow(() => tools.assertTemplateFieldReferencesAvailable(template, {
    mappings: [mapping('BillDate', '交易日期')],
    amountSplitRules: [{ targetField: 'Credit Amount', conditionField: '借贷', mappedField: '交易金额' }]
  }));
  // 有效模板与无表头信息时为 no-op
  assert.doesNotThrow(() => tools.assertTemplateFieldReferencesAvailable(template, {
    mappings: [mapping('BillDate', '交易日期'), mapping('Credit Amount', '交易金额(元)')]
  }));
  assert.doesNotThrow(() => tools.assertTemplateFieldReferencesAvailable({ name: 'X' }, {
    mappings: [mapping('Credit Amount', '不存在')]
  }));
});
