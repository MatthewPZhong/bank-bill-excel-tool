'use strict';

// v3.2.21 拆分/合并账单费用账单「字段映射特殊处理」（spec §3.2、§3.3）：
//   - 只覆盖已完成的费用账单行：空白输出空、自己输入输出固定值、模板文件字段取该行源单元格；其他行不变；
//   - ValueDate 与主映射同口径规范化（保留可识别的原格式）；映射字段不在源文件表头时拒绝；
//   - 账单日期、账户号、币种、发生额、余额、Channel 不能覆盖（保存校验拒绝，生成时即使下发也忽略）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const { buildMappedRows } = require('../../../../src/backend/file-service');
const {
  assertFeeFieldOutputWritable,
  normalizeFeeFieldMappings,
  resolveFeeFieldMappingValue,
  validateFeeFieldMappings
} = require('../../../../src/backend/file-service/bill-split-fee-field-mappings');

const HEADER = ['日期', '币种', '交易金额', '手续费', '摘要', '对方户名', '记账日期'];
const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Description', 'Payee Name', 'ValueDate'];
const MAPPING = { BillDate: '日期', Currency: '币种', Description: '摘要', 'Payee Name': '对方户名', ValueDate: '日期' };

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-split-fee-field-mapping-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, rows, header = HEADER) {
  const filePath = path.join(dir, 'split.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function splitRow(seqNo, overrides = {}) {
  return {
    seqNo,
    rowStatus: 'completed',
    currencySourceField: '币种',
    creditSourceField: '',
    debitSourceField: '',
    amountSourceField: '',
    mergedGroupSeq: null,
    isFeeBill: false,
    ...overrides
  };
}

const TRANSACTION_AND_FEE_ROWS = [
  splitRow(1, { creditSourceField: '交易金额' }),
  splitRow(2, { isFeeBill: true, debitSourceField: '手续费' })
];

function mapFile(filePath, billSplit = {}, { header = HEADER, mappingByField = MAPPING, featureFilters = null } = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField,
    featureFilters,
    expectedSourceHeaders: header,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: TRANSACTION_AND_FEE_ROWS,
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: [],
      feeAmountFormula: null,
      feeFieldMappings: null,
      ...billSplit
    }
  });
}

test('费用账单行按设置覆盖：自己输入输出固定值、空白输出空、模板文件字段取该行的值（日期照常规范化）；交易行不变', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [
    ['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '2026/11/03'],
    ['2026-11-02', 'USD', '50', '2', '退款', '李四', '2026/11/04']
  ]);
  const mapped = mapFile(filePath, {
    feeFieldMappings: [
      { templateField: 'Description', valueType: 'input', value: '手续费' },
      { templateField: 'Payee Name', valueType: 'blank', value: '' },
      { templateField: 'ValueDate', valueType: 'field', value: '记账日期' }
    ]
  });
  assert.deepEqual(mapped.slice(1), [
    ['2026-11-01', 'USD', '100', '', '货款', '张三', '2026-11-01'],
    ['2026-11-01', 'USD', '', '1.5', '手续费', '', '2026/11/03'],
    ['2026-11-02', 'USD', '50', '', '退款', '李四', '2026-11-02'],
    ['2026-11-02', 'USD', '', '2', '手续费', '', '2026/11/04']
  ]);
});

test('未下发设置（未勾选或没有费用账单行）时费用账单行照原映射输出', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '2026/11/03']]);
  assert.deepEqual(mapFile(filePath).slice(1), [
    ['2026-11-01', 'USD', '100', '', '货款', '张三', '2026-11-01'],
    ['2026-11-01', 'USD', '', '1.5', '货款', '张三', '2026-11-01']
  ]);
  // 有设置但没有费用账单行：不影响任何行
  const noFeeRow = mapFile(filePath, {
    billSplitRows: [splitRow(1, { creditSourceField: '交易金额' })],
    feeFieldMappings: [{ templateField: 'Description', valueType: 'input', value: '手续费' }]
  });
  assert.deepEqual(noFeeRow.slice(1), [['2026-11-01', 'USD', '100', '', '货款', '张三', '2026-11-01']]);
});

test('账单日期、账户号、币种、发生额即使被下发也不覆盖；不在本次导出字段中的项忽略', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '2026/11/03']]);
  const mapped = mapFile(filePath, {
    feeFieldMappings: [
      { templateField: 'BillDate', valueType: 'field', value: '记账日期' },
      { templateField: 'Currency', valueType: 'input', value: 'EUR' },
      { templateField: 'Debit Amount', valueType: 'input', value: '999' },
      { templateField: 'Credit Amount', valueType: 'field', value: '交易金额' },
      { templateField: 'Remark', valueType: 'input', value: '不在导出字段' }
    ]
  });
  assert.deepEqual(mapped.slice(1), [
    ['2026-11-01', 'USD', '100', '', '货款', '张三', '2026-11-01'],
    ['2026-11-01', 'USD', '', '1.5', '货款', '张三', '2026-11-01']
  ]);
});

test('映射字段不在源文件表头时拒绝；覆盖的 ValueDate 无法识别时输出空（同主映射口径）', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '交易金额', '手续费', '摘要', '对方户名'];
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三']], header);
  assert.throws(
    () => mapFile(filePath, {
      feeFieldMappings: [{ templateField: 'ValueDate', valueType: 'field', value: '记账日期' }]
    }, { header }),
    /映射字段不存在：记账日期/
  );
  assert.deepEqual(mapFile(filePath, {
    feeFieldMappings: [{ templateField: 'ValueDate', valueType: 'field', value: '摘要' }]
  }, { header }).slice(1).map((row) => row[6]), ['2026-11-01', '']);
});

test('取自源列的值与主映射同口径按文本输出：长数值流水号不以数值写出', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', 1234567890123456]]);
  const mapped = mapFile(filePath, { feeFieldMappings: [{ templateField: 'Payee Name', valueType: 'field', value: '记账日期' }] });
  assert.equal(mapped.slice(1)[1][5], '1234567890123456');
  assert.equal(typeof mapped.slice(1)[1][5], 'string');
});

test('特征值未命中提示只按最终输出：唯一输出的费用行已覆盖该字段时不提示，交易行仍用该特征值时照常提示', (t) => {
  const dir = createTempDir(t);
  // 摘要与 Debit Amount 用同一个特征值：费用行的支出由拆分规则取值、摘要被覆盖，最终没有字段用到它
  const mappingByField = { ...MAPPING, Description: '__FEATURE_FILTER__:f1', 'Debit Amount': '__FEATURE_FILTER__:f1' };
  const featureFilters = { f1: { id: 'f1', name: '单号', sourceField: '摘要', separator: '', digitsOnly: true } };
  const feeFieldMappings = [{ templateField: 'Description', valueType: 'input', value: 'FEE' }];
  // 交易金额为 0：只输出费用行，其 Description 已被覆盖为 FEE
  const feeOnlyPath = writeXlsx(dir, [['2026-11-01', 'USD', '0', '1.5', '无单号', '张三', '2026/11/03']]);
  const feeOnly = mapFile(feeOnlyPath, { feeFieldMappings }, { mappingByField, featureFilters });
  assert.deepEqual(feeOnly.slice(1).map((row) => row[4]), ['FEE']);
  assert.deepEqual(feeOnly.issues.filter((issue) => issue.type === 'feature-value-unmatched'), []);
  // 交易行也输出：交易行的 Description 确实留空，照常提示
  const bothPath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '无单号', '张三', '2026/11/03']]);
  const both = mapFile(bothPath, { feeFieldMappings }, { mappingByField, featureFilters });
  assert.deepEqual(both.slice(1).map((row) => row[4]), ['', 'FEE']);
  assert.equal(both.issues.filter((issue) => issue.type === 'feature-value-unmatched').length, 1);
});

test('主映射只在 Debit Amount 用特征值时，拆分输出（交易行 + 费用行）的发生额都取自拆分配置，不记未命中', (t) => {
  const dir = createTempDir(t);
  const mappingByField = { ...MAPPING, 'Debit Amount': '__FEATURE_FILTER__:f1' };
  const featureFilters = { f1: { id: 'f1', name: '单号', sourceField: '摘要', separator: '', digitsOnly: true } };
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '无单号', '张三', '2026/11/03']]);
  const mapped = mapFile(filePath, {}, { mappingByField, featureFilters });
  assert.deepEqual(mapped.slice(1).map((row) => [row[2], row[3]]), [['100', ''], ['', '1.5']]);
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'feature-value-unmatched'), []);
});

test('特征值未命中只看本次导出的字段：不复用主映射时，拆分映射里已不导出的字段所用的特征值不记未命中', (t) => {
  const dir = createTempDir(t);
  const featureFilters = { f1: { id: 'f1', name: '单号', sourceField: '摘要', separator: '', digitsOnly: true } };
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '0', '1.5', '无单号', '张三', '2026/11/03']]);
  const mapped = mapFile(filePath, {
    reuseModuleMapping: false,
    billSplitMappingByTargetField: { BillDate: '日期', Description: '__FEATURE_FILTER__:f1', Remark: '__FEATURE_FILTER__:f1' },
    feeFieldMappings: [{ templateField: 'Description', valueType: 'input', value: '手续费' }]
  }, { featureFilters });
  assert.deepEqual(mapped.slice(1).map((row) => row[4]), ['手续费']);
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'feature-value-unmatched'), []);
});

test('模板文件字段按字面列名读取：列名以 __FIXED__: 开头也是真实表头', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '交易金额', '手续费', '摘要', '对方户名', '__FIXED__:bank'];
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', 'REF-001']], header);
  const feeFieldMappings = [{ templateField: 'Description', valueType: 'field', value: '__FIXED__:bank' }];
  assert.deepEqual(mapFile(filePath, { feeFieldMappings }, { header }).slice(1)[1][4], 'REF-001');
  const missingHeader = header.slice(0, -1);
  const missingPath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三']], missingHeader);
  assert.throws(() => mapFile(missingPath, { feeFieldMappings }, { header: missingHeader }), /映射字段不存在：__FIXED__:bank/);
});

test('合并组取最小序号行的非金额字段：费用账单行为该行时覆盖值保留', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '2026/11/03']]);
  const feeFieldMappings = [{ templateField: 'Description', valueType: 'input', value: '手续费' }];
  const feeFirst = mapFile(filePath, {
    billSplitRows: [
      splitRow(1, { isFeeBill: true, debitSourceField: '手续费', mergedGroupSeq: 1 }),
      splitRow(2, { creditSourceField: '交易金额', mergedGroupSeq: 1 })
    ],
    feeFieldMappings
  });
  assert.deepEqual(feeFirst.slice(1), [['2026-11-01', 'USD', '98.5', '', '手续费', '张三', '2026-11-01']]);
  const feeSecond = mapFile(filePath, {
    billSplitRows: [
      splitRow(1, { creditSourceField: '交易金额', mergedGroupSeq: 1 }),
      splitRow(2, { isFeeBill: true, debitSourceField: '手续费', mergedGroupSeq: 1 })
    ],
    feeFieldMappings
  });
  assert.deepEqual(feeSecond.slice(1), [['2026-11-01', 'USD', '98.5', '', '货款', '张三', '2026-11-01']]);
});

test('normalizeFeeFieldMappings：接受数组或 JSON，去首尾空白，空白类型清空值，丢弃全空项，非法项记为无效', () => {
  assert.deepEqual(normalizeFeeFieldMappings(JSON.stringify([
    { templateField: ' Description ', valueType: 'input', value: ' 手续费 ' },
    { templateField: 'Payee Name', valueType: 'blank', value: '残留' },
    { templateField: '', valueType: 'blank', value: '' },
    null,
    []
  ])), [
    { templateField: 'Description', valueType: 'input', value: '手续费' },
    { templateField: 'Payee Name', valueType: 'blank', value: '' }
  ]);
  // 不是对象的非空项（误包一层的数组、字符串、数字、布尔值）记为无效行，校验拒绝，不静默只用其余设置
  const nested = [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    [{ templateField: 'Payee Name', valueType: 'blank', value: '' }],
    'Payee Name',
    0,
    false
  ];
  const invalidEntry = { templateField: '', valueType: 'invalid', value: '' };
  assert.deepEqual(normalizeFeeFieldMappings(nested), [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    invalidEntry, invalidEntry, invalidEntry, invalidEntry
  ]);
  assert.deepEqual(normalizeFeeFieldMappings(normalizeFeeFieldMappings(nested)), normalizeFeeFieldMappings(nested), '再次规范化不变');
  assert.throws(() => validateFeeFieldMappings(nested), /第 2 行：请选择模板字段/);
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Description', valueType: 'input', value: { text: '手续费' } },
    { templateField: 'Payee Name', valueType: ['input'], value: 'x' }
  ]), [
    { templateField: 'Description', valueType: 'invalid', value: '' },
    { templateField: 'Payee Name', valueType: 'invalid', value: 'x' }
  ], '非标量的值或类型记为无效，不按「[object Object]」使用');
  assert.throws(() => validateFeeFieldMappings([{ templateField: 'Description', valueType: 'input', value: { text: '手续费' } }]), /第 1 行：映射字段无效/);
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Payee Name', valueType: 'input', value: false },
    { templateField: 'Description', valueType: 'input', value: 12 },
    { templateField: 'ValueDate', valueType: 'blank', value: true }
  ]), [
    { templateField: 'Payee Name', valueType: 'invalid', value: '' },
    { templateField: 'Description', valueType: 'invalid', value: '' },
    { templateField: 'ValueDate', valueType: 'blank', value: '' }
  ], '布尔值不按文本 false 使用；数字无法确认原文，记为无效；空白类型不看值');
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Payee CardNo', valueType: 'input', value: 9007199254740993 },
    { templateField: 'Drawee CardNo', valueType: 'input', value: '9007199254740993' },
    { templateField: 'Description', valueType: 'input', value: 0.5 }
  ]), [
    { templateField: 'Payee CardNo', valueType: 'invalid', value: '' },
    { templateField: 'Drawee CardNo', valueType: 'input', value: '9007199254740993' },
    { templateField: 'Description', valueType: 'invalid', value: '' }
  ], '数字（含超出安全整数范围、小数）记为无效；文本写的长卡号原样保留');
  // 读包时 JSON 数字已被舍入：20261119.000000001 读成安全整数 20261119、1.10 读成 1.1，规范化无法察觉，故数字一律无效
  assert.deepEqual(normalizeFeeFieldMappings('[{"templateField":"Customer Ref","valueType":"input","value":20261119.000000001},'
    + '{"templateField":"Remark","valueType":"input","value":1.10},{"templateField":"Description","valueType":"input","value":"20261119.000000001"}]'), [
    { templateField: 'Customer Ref', valueType: 'invalid', value: '' },
    { templateField: 'Remark', valueType: 'invalid', value: '' },
    { templateField: 'Description', valueType: 'input', value: '20261119.000000001' }
  ], '原始 JSON 中的数字固定值记为无效，文本原样保留');
  // 未配对代理项写出 XLSX 会被替换成「�」：记为无效；合法代理对（如 emoji）照常
  assert.deepEqual(normalizeFeeFieldMappings('[{"templateField":"Customer Ref","valueType":"input","value":"ref\\ud83d"},'
    + '{"templateField":"Remark","valueType":"input","value":"ref\\ud83d\\ude00"}]'), [
    { templateField: 'Customer Ref', valueType: 'invalid', value: '' },
    { templateField: 'Remark', valueType: 'input', value: 'ref\ud83d\ude00' }
  ], '未配对代理项的固定文本记为无效，合法代理对保留');
  assert.throws(() => validateFeeFieldMappings([{ templateField: 'Description', valueType: 'input', value: 'ref\udc00x' }]), /第 1 行：映射字段无效/);
  // XML 1.0 禁止的 U+FFFE、U+FFFF 写出后工作表无法解析：记为无效；控制字符写出时按 _xHHHH_ 转义，照常接受
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Customer Ref', valueType: 'input', value: 'REF\uFFFE01' },
    { templateField: 'Remark', valueType: 'input', value: 'REF\uFFFF' },
    { templateField: 'Description', valueType: 'input', value: 'A\tB\u0001C' }
  ]), [
    { templateField: 'Customer Ref', valueType: 'invalid', value: '' },
    { templateField: 'Remark', valueType: 'invalid', value: '' },
    { templateField: 'Description', valueType: 'input', value: 'A\tB\u0001C' }
  ], 'XML 禁止字符记为无效，可转义的控制字符保留');
  // 缺少模板字段、但显式选了取值方式的坏行保留下来报错，不当作空白行丢弃
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'input', value: false },
    { templateField: '', valueType: 'blank', value: '' }
  ]), [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'invalid', value: '' }
  ]);
  assert.throws(() => validateFeeFieldMappings([
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'input', value: false }
  ]), /第 2 行：请选择模板字段/);
  // 幂等：模板包导入、落库、读取会多次规范化，坏行（含模板字段不是文本、取值为空白的行）不能在第二次规范化时被当作空白行丢弃
  const badRows = [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'input', value: false },
    { templateField: 12, valueType: 'blank', value: '' },
    { templateField: 'Remark', valueType: 'other', value: '' }
  ];
  const once = normalizeFeeFieldMappings(badRows);
  assert.deepEqual(once, [
    { templateField: 'Transaction Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'invalid', value: '' },
    { templateField: '', valueType: 'invalid', value: '' },
    { templateField: 'Remark', valueType: 'invalid', value: '' }
  ]);
  assert.deepEqual(normalizeFeeFieldMappings(JSON.stringify(once)), once, '再次规范化（落库后读回）结果不变');
  assert.throws(() => validateFeeFieldMappings(normalizeFeeFieldMappings(once)), /第 2 行：请选择模板字段/,
    '规范化后的坏行照常拒绝');
  assert.throws(() => validateFeeFieldMappings([{ templateField: 'Remark', valueType: 'invalid', value: '' }]), /第 1 行：映射字段无效/,
    'invalid 标记不是可用的取值类型');
  // 两个下拉框都为空白的行忽略：取值为空白时不看残留的值
  assert.deepEqual(normalizeFeeFieldMappings([
    { templateField: 'Description', valueType: 'input', value: '手续费' },
    { templateField: '', valueType: 'blank', value: '残留' }
  ]), [{ templateField: 'Description', valueType: 'input', value: '手续费' }]);
  assert.deepEqual(normalizeFeeFieldMappings('not json'), []);
  assert.deepEqual(normalizeFeeFieldMappings(''), []);
  assert.deepEqual(normalizeFeeFieldMappings({}), []);
  assert.deepEqual(normalizeFeeFieldMappings([{ templateField: 'Remark', valueType: 'unknown', value: 'x' }]),
    [{ templateField: 'Remark', valueType: 'invalid', value: 'x' }]);
});

test('validateFeeFieldMappings：至少一行、模板字段必选且可选且不重复、自己输入须填值、模板文件字段须在表头', () => {
  const options = { headers: ['摘要', '对方户名', ''], allowedTemplateFields: ['BillDate', 'Description', 'Payee Name', 'MerchantId'] };
  assert.deepEqual(validateFeeFieldMappings([
    { templateField: 'Description', valueType: 'input', value: '手续费' },
    { templateField: 'Payee Name', valueType: 'field', value: '对方户名' }
  ], options), [
    { templateField: 'Description', valueType: 'input', value: '手续费' },
    { templateField: 'Payee Name', valueType: 'field', value: '对方户名' }
  ]);
  const cases = [
    [[], /请至少新增一个模板字段/],
    [[{ templateField: '', valueType: 'input', value: 'x' }], /第 1 行：请选择模板字段/],
    [[{ templateField: 'MerchantId', valueType: 'input', value: 'x' }], /「MerchantId」不支持字段映射特殊处理/],
    [[{ templateField: 'Balance', valueType: 'blank' }], /「Balance」不支持字段映射特殊处理/],
    [[{ templateField: 'Channel', valueType: 'input', value: '其他银行' }], /「Channel」不支持字段映射特殊处理/],
    [[{ templateField: 'Remark', valueType: 'blank' }], /「Remark」不支持字段映射特殊处理/],
    [[{ templateField: 'Description', valueType: 'blank' }, { templateField: 'Description', valueType: 'input', value: 'x' }], /模板字段「Description」重复/],
    [[{ templateField: 'Description', valueType: 'input', value: '  ' }], /第 1 行：请输入「Description」的映射值/],
    [[{ templateField: 'Description', valueType: 'input', value: 'x'.repeat(32768) }], /映射值超过 32767 个字符/],
    [[{ templateField: 'Description', valueType: 'field', value: '' }], /第 1 行：请选择映射字段/],
    [[{ templateField: 'Description', valueType: 'field', value: '已删除列' }], /映射字段不存在：已删除列/],
    [[{ templateField: 'Description', valueType: 'other', value: 'x' }], /第 1 行：映射字段无效/],
    [[{ templateField: 'BillDate', valueType: 'field', value: '摘要' }], /「BillDate」不支持字段映射特殊处理/]
  ];
  cases.forEach(([raw, pattern]) => assert.throws(() => validateFeeFieldMappings(raw, options), pattern));
  // 不传 headers / allowedTemplateFields 时只做结构校验（生成时用），排除字段仍拒绝
  assert.doesNotThrow(() => validateFeeFieldMappings([{ templateField: 'Remark', valueType: 'field', value: '任意列' }]));
  assert.throws(() => validateFeeFieldMappings([{ templateField: 'Currency', valueType: 'input', value: 'USD' }]), /不支持/);
});

test('resolveFeeFieldMappingValue：按类型取值', () => {
  const read = (field) => ({ 摘要: '货款', 空列: null }[field]);
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'input', value: '手续费' }, read), '手续费');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'field', value: '摘要' }, read), '货款');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'field', value: '空列' }, read), '');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'field', value: '数值' }, (field) => ({ 数值: 12.5 }[field])), '12.5');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'field', value: '空白' }, () => '   '), '');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'blank', value: '' }, read), '');
  assert.equal(resolveFeeFieldMappingValue(null, read), '');
  assert.equal(resolveFeeFieldMappingValue({ valueType: 'field', value: '参考号' }, () => 'ref\ud83d\ude00'), 'ref\ud83d\ude00');
});

test('assertFeeFieldOutputWritable：取自源列的输出值含无法写入 Excel 的字符或超过 32767 个字符时拒绝，列出源行、源列与目标字段', () => {
  const item = { templateField: 'Customer Ref', valueType: 'field', value: '参考号' };
  for (const bad of ['REF\uFFFE01', 'REF\uFFFF', 'ref\ud83d']) {
    assert.throws(() => assertFeeFieldOutputWritable(item, bad, { sourceRowNumber: 5 }), /第 5 行「参考号」列的值含无法写入 Excel 的字符.*Customer Ref/);
  }
  assert.throws(() => assertFeeFieldOutputWritable(item, 'x'.repeat(32768), { sourceRowNumber: 6 }), /第 6 行「参考号」列的值超过 32767 个字符.*Customer Ref/);
  assert.doesNotThrow(() => assertFeeFieldOutputWritable(item, 'x'.repeat(32767), { sourceRowNumber: 6 }));
  assert.doesNotThrow(() => assertFeeFieldOutputWritable(item, 'ref\ud83d\ude00'));
  assert.doesNotThrow(() => assertFeeFieldOutputWritable({ ...item, valueType: 'input' }, 'REF\uFFFE'), '固定值已在规范化时拦截，这里只校验源列取值');
  // 形如 _xHHHH_ 的字面文本写出后会被还原成其他字符：源列取值与固定文本都拒绝（x 与十六进制不分大小写）；不构成转义的照常
  //   与回车等控制字符相连时，控制字符写出编码（如回车为 _x000d_）会补全前面的 _xHHHH，同样被改写
  for (const bad of ['FEE_x0041_', 'a_X00e9_b', 'REF_x0041\r\nB', 'REF_x0041\u0001']) {
    assert.throws(() => assertFeeFieldOutputWritable(item, bad, { sourceRowNumber: 7 }), /第 7 行「参考号」列的值含写入 Excel 后会被改写的文本.*Customer Ref/);
    assert.throws(() => validateFeeFieldMappings([{ templateField: 'Customer Ref', valueType: 'input', value: bad }]),
      /第 1 行：「Customer Ref」的映射值含写入 Excel 后会被改写的文本/);
  }
  for (const ok of ['FEE_x004_', 'FEE_x00G1_', 'FEE_0041_x', 'REF\r\nB']) {
    assert.doesNotThrow(() => assertFeeFieldOutputWritable(item, ok));
    assert.doesNotThrow(() => validateFeeFieldMappings([{ templateField: 'Customer Ref', valueType: 'input', value: ok }]));
  }
});

test('源列取值校验只针对实际写出的费用账单行：合计行、合并时不作代表行的费用行不因其值拒绝整份账单', (t) => {
  const dir = createTempDir(t);
  const writeCsv = (name, rows) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, [HEADER, ...rows].map((row) => row.join(',')).join('\n'), 'utf8');
    return filePath;
  };
  const feeFieldMappings = [{ templateField: 'Payee Name', valueType: 'field', value: '记账日期' }];
  // 合计行（日期列为「合计」且带金额）不产出明细：其中的非法文本不写出
  const summaryCsv = writeCsv('summary.csv', [
    ['2026-11-01', 'USD', '100', '1.5', '货款', '张三', 'REF01'],
    ['合计', 'USD', '100', '1.5', '', '', 'REF\uFFFE']
  ]);
  const summaryRows = mapFile(summaryCsv, { feeFieldMappings });
  assert.deepEqual(summaryRows.slice(1).map((row) => row[5]), ['张三', 'REF01'], '合计行跳过；交易行照主映射、费用行按设置输出');
  // 合并组代表行为交易行：费用行的覆盖值不进入输出，不校验
  const mergedCsv = writeCsv('merged.csv', [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', 'REF\uFFFE']]);
  const mergedRows = mapFile(mergedCsv, {
    billSplitRows: [splitRow(1, { creditSourceField: '交易金额', mergedGroupSeq: 1 }), splitRow(2, { isFeeBill: true, debitSourceField: '手续费', mergedGroupSeq: 1 })],
    feeFieldMappings
  });
  assert.equal(mergedRows.length, 2, '合并为一行照常生成');
  // 单独输出的费用账单行：拒绝并列出源行与列
  assert.throws(() => mapFile(mergedCsv, { feeFieldMappings }), /第 2 行「记账日期」列的值含无法写入 Excel 的字符.*Payee Name/);
  const longCsv = writeCsv('long.csv', [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', 'R'.repeat(32768)]]);
  assert.throws(() => mapFile(longCsv, { feeFieldMappings }), /第 2 行「记账日期」列的值超过 32767 个字符.*Payee Name/);
  // ValueDate 取源列：在实际写出的行上先校验原值（超长值不进入日期解析）再规范化；费用行作合并代表行时同样规范化
  const valueDateMappings = [{ templateField: 'ValueDate', valueType: 'field', value: '记账日期' }];
  const longDateCsv = writeCsv('long-date.csv', [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', `2026-11-03${' '.repeat(32760)}`]]);
  assert.throws(() => mapFile(longDateCsv, { feeFieldMappings: valueDateMappings }), /第 2 行「记账日期」列的值超过 32767 个字符.*ValueDate/);
  const feeRepresentativeCsv = writeCsv('fee-representative.csv', [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '非日期']]);
  const feeRepresentativeRows = mapFile(feeRepresentativeCsv, {
    billSplitRows: [splitRow(1, { isFeeBill: true, debitSourceField: '手续费', mergedGroupSeq: 1 }), splitRow(2, { creditSourceField: '交易金额', mergedGroupSeq: 1 })],
    feeFieldMappings: valueDateMappings
  });
  assert.deepEqual(feeRepresentativeRows.slice(1).map((row) => [row[2], row[6]]), [['98.5', '']], '合并代表行为费用行：ValueDate 无法识别时输出空（同主映射口径）');
  // ValueDate 取源列：日期规范化会丢掉非法字符，须按规范化前的源值校验
  const dateCsv = writeCsv('date.csv', [['2026-11-01', 'USD', '100', '1.5', '货款', '张三', '2026-11-03T10:00:00\uFFFE']]);
  assert.throws(() => mapFile(dateCsv, { feeFieldMappings: [{ templateField: 'ValueDate', valueType: 'field', value: '记账日期' }] }),
    /第 2 行「记账日期」列的值含无法写入 Excel 的字符.*ValueDate/);
});
