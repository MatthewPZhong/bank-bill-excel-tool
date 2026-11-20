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
  REUSE_MODULE_MAPPING_FIELD: '复用模块字段的映射关系',
  SIGNED_AMOUNT_MAPPING_FIELD: '按正负号拆分的发生额',
  AMOUNT_BASED_NAME_MAPPING_FIELD: '根据发生额做映射的户名',
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD: '根据发生额做映射的账户号'
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

// 回归（第四轮 review P1）：按正负号拆分的发生额、根据发生额做映射的户名 / 账户号被生成器整体当作一个列名读取。
test('collect：高级金额字段的多字段配置按生成器读取的拼接列名计入', () => {
  const fields = (mappings) => tools.collectTemplateFieldReferences({ mappings }).map((item) => `${item.target}<-${item.field}`);
  assert.deepEqual(fields([
    mapping('按正负号拆分的发生额', 'A', ['A', 'B']),
    mapping('根据发生额做映射的户名', '户名'),
    mapping('根据发生额做映射的账户号', '需要拼接字段', ['账号1', '账号2'])
  ]), ['按正负号拆分的发生额<-A,B', '根据发生额做映射的户名<-户名', '根据发生额做映射的账户号<-账号1,账号2']);
  assert.throws(
    () => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['A', 'B'] }, { mappings: [mapping('按正负号拆分的发生额', 'A', ['A', 'B'])] }),
    (error) => /映射字段不存在：A,B，/.test(error.message)
  );
  assert.deepEqual(fields([mapping('按正负号拆分的发生额', '__FIXED__:1')]), []);
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
    billSplitMappings: [mapping('Remark', '附言'), mapping('Description', '字段筛选特征值', ['1'])],
    billSplitRows: [
      { seqNo: 1, currencySourceField: '__FIXED__:CNY', creditSourceField: '收入', debitSourceField: '', amountSourceField: '', rowStatus: 'completed' },
      { seqNo: 2, currencySourceField: '', creditSourceField: '', debitSourceField: '支出', amountSourceField: '', rowStatus: 'draft' }
    ],
    billSplitAmountRules: [{ targetField: 'Debit Amount', conditionField: '方向', mappedField: '金额' }],
    billSplitSignedAmountSourceField: '有符号金额',
    featureFilters: [{ id: '1', name: '流水号', sourceField: '附言' }]
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

  // v3.2.18 多特征值：只有生效映射选用的特征值读取其筛选字段；未选用的标为未启用
  const mainFilterRefs = tools.collectTemplateFieldReferences({
    mappings: [mapping('Description', '字段筛选特征值', ['2']), mapping('Remark', '字段筛选特征值', [])],
    featureFilters: [
      { id: '1', name: '流水号', sourceField: '附言' },
      { id: '2', name: '订单号', sourceField: '摘要' }
    ]
  });
  assert.deepEqual(mainFilterRefs.map((item) => `${item.target}<-${item.field}:${item.active}`), [
    '流水号<-附言:false',
    '订单号<-摘要:true'
  ]);
  assert.deepEqual(formatFieldReferenceLines(findStaleFieldReferences(mainFilterRefs, ['附言'])), [
    '特征值「订单号」 · 筛选字段 ← 摘要'
  ]);
  assert.throws(() => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['附言'] }, {
    mappings: [mapping('Description', '字段筛选特征值', ['2'])],
    featureFilters: [{ id: '2', name: '订单号', sourceField: '摘要' }]
  }), (error) => /映射字段不存在：摘要，/.test(error.message));
  assert.doesNotThrow(() => tools.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['附言'] }, {
    mappings: [mapping('Description', '字段筛选特征值', ['1'])],
    featureFilters: [{ id: '1', name: '流水号', sourceField: '附言' }, { id: '2', name: '订单号', sourceField: '摘要' }]
  }));
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

// v3.2.19：逻辑取值的候补字段计为源字段引用（模式名本身不是源列）；「重复账单过滤」开关值不是源字段。
test('collect：逻辑取值的候补字段为源字段引用；重复账单过滤开关排除', () => {
  const v19 = createTemplateHeaderUpdateTools({
    ...CONSTANTS,
    LOGIC_VALUE_MAPPING_FIELD: '逻辑取值',
    PREPROCESS_ROW_FILTER_MAPPING_FIELD: '过滤账单',
    PREPROCESS_ROW_FILTER_ENABLED_OPTION: '是',
    DUPLICATE_ROW_FILTER_MAPPING_FIELD: '重复账单过滤'
  });
  const input = {
    mappings: [
      mapping('BillDate', '交易日期'),
      mapping('Payee Name', '逻辑取值', ['对方户名', '摘要']),
      mapping('Remark', '逻辑取值', []),
      // 候补字段是真实列（生成时按列名读取），以固定值前缀开头的列名也计为源字段引用
      mapping('Reference', '逻辑取值', ['__FIXED__:流水', '交易日期']),
      mapping('重复账单过滤', '是')
    ]
  };
  const references = v19.collectTemplateFieldReferences(input);
  assert.deepEqual(references.map((item) => [item.target, item.field, item.role]), [
    ['BillDate', '交易日期', ''],
    ['Payee Name', '对方户名', 'logic-value'],
    ['Payee Name', '摘要', 'logic-value'],
    ['Remark', '逻辑取值', ''],
    ['Reference', '__FIXED__:流水', 'logic-value'],
    ['Reference', '交易日期', 'logic-value']
  ]);
  const stale = findStaleFieldReferences(references, ['交易日期', '对方户名']);
  // 没有候补字段的旧映射（直接映射名为「逻辑取值」的源列）按该源列引用
  assert.deepEqual(formatFieldReferenceLines(stale), [
    'Payee Name（逻辑取值 · 候补字段） ← 摘要',
    'Remark ← 逻辑取值',
    'Reference（逻辑取值 · 候补字段） ← __FIXED__:流水'
  ]);
  assert.throws(
    () => v19.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['交易日期', '对方户名'] }, input),
    (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /摘要/.test(error.message)
  );
});

// v3.2.21：逻辑取值的特征值候补不是源字段引用；被候补引用的特征值算启用，其筛选字段失效时生成前拦截。
test('collect：逻辑取值的特征值候补不计为源字段，所引用的特征值筛选字段按启用计入', () => {
  const v21 = createTemplateHeaderUpdateTools({ ...CONSTANTS, LOGIC_VALUE_MAPPING_FIELD: '逻辑取值' });
  const input = {
    mappings: [
      mapping('Payee Name', '逻辑取值', ['\u0000__FEATURE_FILTER__:2', '对方户名']),
      mapping('Remark', '逻辑取值', ['\u0000__FEATURE_FILTER__:1', '\u0000__FEATURE_FILTER__:2']),
      // 旧版本的候补都是源列名：形如 `__FEATURE_FILTER__:3` 的列名仍是源字段引用，不算选用特征值 3
      mapping('Reference', '逻辑取值', ['__FEATURE_FILTER__:3', '对方户名'])
    ],
    featureFilters: [
      { id: '1', name: '流水号', sourceField: '附言' },
      { id: '2', name: '订单号', sourceField: '摘要' },
      { id: '3', name: '备用', sourceField: '用途' }
    ]
  };
  const references = v21.collectTemplateFieldReferences(input);
  assert.deepEqual(references.map((item) => `${item.area}:${item.target}<-${item.field}:${item.active}`), [
    'mapping:Payee Name<-对方户名:true',
    'mapping:Reference<-__FEATURE_FILTER__:3:true',
    'mapping:Reference<-对方户名:true',
    'feature-filter:流水号<-附言:true',
    'feature-filter:订单号<-摘要:true',
    'feature-filter:备用<-用途:false'
  ]);
  assert.throws(
    () => v21.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['对方户名', '附言', '__FEATURE_FILTER__:3'] }, input),
    (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING' && /摘要/.test(error.message) && !/__FEATURE_FILTER__/.test(error.message)
  );
  assert.doesNotThrow(() => v21.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['对方户名', '附言', '摘要', '__FEATURE_FILTER__:3'] }, input));
});

// 特征值的筛选字段是列名：以固定值前缀开头的真实列名同样登记，删除后【更新】预览列出、生成前拦截。
test('collect：特征值筛选字段以 __FIXED__: 开头时仍登记为源字段引用', () => {
  const v21 = createTemplateHeaderUpdateTools({ ...CONSTANTS, LOGIC_VALUE_MAPPING_FIELD: '逻辑取值' });
  const input = {
    mappings: [mapping('Remark', '逻辑取值', ['\u0000__FEATURE_FILTER__:1', '摘要'])],
    featureFilters: [{ id: '1', name: '流水号', sourceField: '__FIXED__:流水' }]
  };
  const references = v21.collectTemplateFieldReferences(input);
  assert.deepEqual(references.map((item) => `${item.area}:${item.target}<-${item.field}:${item.active}`), [
    'mapping:Remark<-摘要:true',
    'feature-filter:流水号<-__FIXED__:流水:true'
  ]);
  assert.deepEqual(formatFieldReferenceLines(findStaleFieldReferences(references, ['摘要'])), ['特征值「流水号」 · 筛选字段 ← __FIXED__:流水']);
  assert.throws(() => v21.assertTemplateFieldReferencesAvailable({ name: 'T', headers: ['摘要'] }, input),
    (error) => error.code === 'TEMPLATE_MAPPING_FIELD_MISSING');
});
