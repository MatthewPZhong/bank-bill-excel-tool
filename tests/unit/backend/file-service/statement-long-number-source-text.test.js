'use strict';

// v3.2.21 B112 网银账单生成：长数字按文件原文读取（spec changes/v3.2.21/fix/statement-long-number-precision/spec.md）
//   - 超出安全整数范围的非负整数在数据行按原文还原：XLSX 取工作表 XML 的 <v> 字面值，文本 / HTML 伪装的 .xls 按文本重读；
//   - 文件里只有近似值（指数写法、二进制 .xls）或是负数时保持原读取结果，生成时对导出为明细的行、写进明细的取值提示
//     long-number-unverified；发生额、余额取值的列不用原文（余额按数值计算，与明细同一个值），照常提示；
//   - 真 CSV 的 ="…"、首尾制表符在数据行还原为 Excel 显示值，表头定位仍按原值；
//   - 不传 exactSourceText 的读取（模板导入表头等）行为不变。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const { buildMappedRows } = require('../../../../src/backend/file-service');
const { extractHeaders, openZipEntriesLazily, readRows, readRowsWithMetadata } = require('../../../../src/backend/file-service/readers');
const { MERCHANT_ID_CURRENCY_ONLY_MARKER, isUnverifiedLongNumber } = require('../../../../src/backend/file-service/common');
const { buildLogicValueFeatureCandidate, buildLogicValueToken } = require('../../../../src/backend/file-service/logic-value');

const SERIAL = '9007199254740993';
const CARD = '6222021234567890123';
const HEADER = ['日期', '币种', '金额', '流水号', '卡号'];
const TARGETS = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo', 'Payee Card No'];
const MAPPING = { BillDate: '日期', Currency: '币种', 'Credit Amount': '金额', ChannelOrderNo: '流水号', 'Payee Card No': '卡号' };

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-long-number-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function map(filePath, options = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: MAPPING,
    expectedSourceHeaders: HEADER,
    ...options
  });
}

function identifiers(mapped) {
  return mapped.slice(1).map((row) => [row[TARGETS.indexOf('ChannelOrderNo')], row[TARGETS.indexOf('Payee Card No')]]);
}

// cells 只比较源字段与位数；写进的目标列（targetFields）另有用例
function longNumberIssues(mapped) {
  return mapped.issues
    .filter((issue) => issue.type === 'long-number-unverified')
    .map((issue) => ({ ...issue, cells: issue.cells.map(({ sourceField, digitCount }) => ({ sourceField, digitCount })) }));
}

// 先用占位数字写出 XLSX，再把工作表 XML 中的 <v> 改成指定字面值（读取库写不出超出精度的数字）
async function writeXlsxWithLiterals(filePath, rows, literals, transformXml = (xml) => xml) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  Object.entries(literals).forEach(([placeholder, literal]) => {
    assert.ok(xml.includes(`<v>${placeholder}</v>`), `占位 ${placeholder} 应在工作表 XML 中`);
    xml = xml.replace(`<v>${placeholder}</v>`, `<v>${literal}</v>`);
  });
  zip.file('xl/worksheets/sheet1.xml', transformXml(xml));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

test('isUnverifiedLongNumber：只认超出安全整数范围的整数', () => {
  assert.equal(isUnverifiedLongNumber(9007199254740992), true);
  assert.equal(isUnverifiedLongNumber(-9007199254740992), true);
  assert.equal(isUnverifiedLongNumber(Number(CARD)), true);
  assert.equal(isUnverifiedLongNumber(9007199254740991), false);
  assert.equal(isUnverifiedLongNumber(1234567890123456), false);
  assert.equal(isUnverifiedLongNumber(0.1234567890123456789), false);
  assert.equal(isUnverifiedLongNumber(SERIAL), false);
  assert.equal(isUnverifiedLongNumber(Infinity), false);
});

test('XLSX：<v> 写的整数按原文输出（含开启重复账单过滤时）；安全整数与金额不变；不提示', async (t) => {
  const dir = createTempDir(t);
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'literal.xlsx'), [
    HEADER,
    ['2026-11-01', 'USD', 100, 1111, 2222],
    ['2026-11-02', 'USD', 200, 3333, 1234567890123456]
  ], { 1111: SERIAL, 2222: CARD, 3333: '0009007199254740995' });

  const mapped = map(filePath);
  assert.deepEqual(identifiers(mapped), [[SERIAL, CARD], ['9007199254740995', '1234567890123456']]);
  assert.deepEqual(mapped.slice(1).map((row) => row[TARGETS.indexOf('Credit Amount')]), ['100', '200']);
  assert.deepEqual(longNumberIssues(mapped), []);

  // 查重读取保留了压缩包原文，直接取其中的工作表 XML；指纹按原文计算，两次读取一致
  const withKeys = map(filePath, { duplicateRowKeys: true });
  assert.deepEqual(identifiers(withKeys), identifiers(mapped));
  const again = map(filePath, { duplicateRowKeys: true });
  assert.deepEqual(again.rowMetas.map((meta) => meta.sourceRowKey), withKeys.rowMetas.map((meta) => meta.sourceRowKey));
  assert.ok(withKeys.rowMetas.every((meta) => meta.sourceRowKey));
});

test('XLSX：指数写法（Excel 另存）无法还原，照常生成并只为进入明细的行、已映射的列提示', async (t) => {
  const dir = createTempDir(t);
  const header = [...HEADER, '备用号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'exponent.xlsx'), [
    header,
    ['2026-11-01', 'USD', 100, 1111, 2222, 5555],
    ['2026-11-02', 'USD', '', 3333, 4444, 6666]
  ], {
    1111: '6.2220212345678899E+18',
    2222: CARD,
    3333: '6.2220212345678899E+18',
    4444: '6.2220212345678899E+18',
    5555: '6.2220212345678899E+18',
    6666: '6.2220212345678899E+18'
  });

  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: MAPPING,
    expectedSourceHeaders: header
  });
  // 第 3 行收支均空（导出明细时过滤）：不提示；未映射的「备用号」不提示
  assert.deepEqual(identifiers(mapped), [['6222021234567890000', CARD], ['6222021234567890000', '6222021234567890000']]);
  assert.deepEqual(longNumberIssues(mapped), [{
    type: 'long-number-unverified',
    fileName: 'exponent.xlsx',
    rowNumber: 2,
    cells: [{ sourceField: '流水号', digitCount: 19 }]
  }]);
});

test('负数不还原（保持读取库的数字并提示）；表头行不还原，按模板导入读到的表头照常匹配；提示口径同明细导出', async (t) => {
  const dir = createTempDir(t);
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'negative.xlsx'), [
    ['日期', '币种', '金额', '流水号', 7777],
    ['2026-11-01', 'USD', 100, 1111, 'A'],
    // 「100.」无法解析为数字，明细导出照常保留该行（isZeroOrBlankAmount），同样提示
    ['2026-11-02', 'USD', '100.', 2222, 'B'],
    ['2026-11-03', 'USD', 0, 3333, 'C']
  ], { 7777: SERIAL, 1111: '-9007199254740995', 2222: '6.2220212345678899E+18', 3333: '6.2220212345678899E+18' });

  // 模板导入读表头不取原文：数字表头存为读取库的值
  const header = extractHeaders(filePath);
  assert.equal(header[4], '9007199254740992');
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { ...MAPPING, 'Payee Card No': header[4] },
    expectedSourceHeaders: header
  });
  assert.deepEqual(identifiers(mapped), [['-9007199254740996', 'A'], ['6222021234567890000', 'B'], ['6222021234567890000', 'C']]);
  // 第 4 行收支为 0（导出明细时过滤）不提示
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [2, [{ sourceField: '流水号', digitCount: 16 }]],
    [3, [{ sourceField: '流水号', digitCount: 19 }]]
  ]);
});

test('拆分 / 合并账单：只提示写进明细的取值，主映射试算、未用到的特征值不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '类型', '币种', '收入', '交易金额', '卡号', '附言'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split.xlsx'), [
    header,
    ['2026-11-01', '普通', 'USD', 100, '', 1111, 2222],
    ['2026-11-02', '拆分', 'USD', '', 200, 3333, 4444]
  ], {
    1111: '6.2220212345678899E+18',
    2222: '6.2220212345678899E+18',
    3333: '6.2220212345678899E+18',
    4444: '6.2220212345678899E+18'
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee Card No', 'Remark'],
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '收入',
      'Payee Card No': '卡号',
      Remark: '__FEATURE_FILTER__:f1'
    },
    expectedSourceHeaders: header,
    featureFilters: { f1: { id: 'f1', name: '单号', sourceField: '附言', separator: '', digitsOnly: true } },
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', Remark: '类型' },
      billSplitRows: [{
        seqNo: 1,
        rowStatus: 'completed',
        currencySourceField: '币种',
        creditSourceField: '交易金额',
        debitSourceField: '',
        amountSourceField: '',
        mergedGroupSeq: null,
        isFeeBill: false
      }],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: [],
      feeAmountFormula: null,
      rowFilterRules: [{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '拆分' }] }]
    }
  });
  // 拆分行（第 3 行）用拆分映射，不取卡号与特征值：不提示；走主映射的第 2 行提示卡号与特征值的源字段
  assert.deepEqual(mapped.slice(1).map((row) => row[5]), ['6222021234567890000', '拆分']);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [2, [{ sourceField: '卡号', digitCount: 19 }, { sourceField: '附言', digitCount: 19 }]]
  ]);
});

test('发生额、余额取值的列保持读取库的数值并提示；「未筛出特征值」不写还原后的完整号码', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '金额', '余额', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'amount.xlsx'), [
    header,
    ['2026-11-01', 'USD', 1111, 2222, 3333]
  ], { 1111: SERIAL, 2222: SERIAL, 3333: CARD });
  const targets = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', 'Payee Card No', 'Remark'];
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: targets,
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '金额',
      Balance: '余额',
      'Payee Card No': '卡号',
      Remark: '__FEATURE_FILTER__:f1'
    },
    expectedSourceHeaders: header,
    // 卡号不满足 8 位特征长度：未筛出，提示里只写位数
    featureFilters: { f1: { id: 'f1', name: '单号', sourceField: '卡号', separator: '', length: 8 } }
  });
  assert.deepEqual(mapped[1].slice(2), ['9007199254740992', '', '9007199254740992', CARD, '']);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells), [[
    { sourceField: '金额', digitCount: 16 },
    { sourceField: '余额', digitCount: 16 }
  ]]);
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'feature-value-unmatched').map((issue) => issue.misses), [[
    { featureName: '单号', sourceField: '卡号', rawValue: '（19位数值）' }
  ]]);
});

test('拆分行复用模块映射：主映射的发生额不写进明细，不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '交易金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split-reuse.xlsx'), [
    header,
    ['2026-11-01', 'USD', 1111, 123]
  ], { 1111: '9.0071992547409952E+15' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入' },
    expectedSourceHeaders: header,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [{
        seqNo: 1,
        rowStatus: 'completed',
        currencySourceField: '币种',
        creditSourceField: '交易金额',
        debitSourceField: '',
        amountSourceField: '',
        mergedGroupSeq: null,
        isFeeBill: false
      }],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: [],
      feeAmountFormula: null,
      rowFilterRules: null
    }
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(1, 3)), [['USD', '123']]);
  assert.deepEqual(longNumberIssues(mapped), []);
});

function splitRow(overrides = {}) {
  return {
    seqNo: 1,
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

function billSplitMerge(overrides = {}) {
  return {
    enabled: true,
    reuseModuleMapping: true,
    billSplitMappingByTargetField: {},
    billSplitRows: [splitRow()],
    billSplitAmountRules: [],
    signedAmountSourceField: '',
    signedAmountTargetSeqNos: [],
    byFieldAmountTargetSeqNos: [],
    feeAmountFormula: null,
    rowFilterRules: null,
    ...overrides
  };
}

test('费用账单启用公式时，仍保存在模板里的支出映射不算发生额列：同一列作标识按原文', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '手续费', '流水号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'fee.xlsx'), [header, ['2026-11-01', 'USD', 20, 1111]], { 1111: SERIAL });
  const targets = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'];
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: targets,
    mappingByField: { BillDate: '日期', Currency: '币种', ChannelOrderNo: '流水号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ isFeeBill: true, debitSourceField: '流水号' })],
      feeAmountFormula: [{ field: '手续费', op: 'end' }]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(2)), [['', '20', SERIAL]]);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('拆分按字段区分发生额：只记命中规则的发生额列；币种诊断中的还原号码只写位数', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '方向', '收入', '支出', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split-rules.xlsx'), [
    header,
    ['2026-11-01', 'USD', '支', 1111, 20, 2222]
  ], { 1111: '9.0071992547409952E+15', 2222: CARD });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    // 卡号误映射到币种：未匹配币种的提示不写完整号码
    mappingByField: { BillDate: '日期', Currency: '卡号' },
    currencyMappings: [{ englishCode: 'USD', aliases: ['美元'] }],
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ currencySourceField: '' })],
      billSplitAmountRules: [
        { conditionField: '方向', conditionValue: '收', mappedField: '收入', targetField: 'Credit Amount' },
        { conditionField: '方向', conditionValue: '支', mappedField: '支出', targetField: 'Debit Amount' }
      ]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(1)), [[CARD, '', '20']]);
  assert.deepEqual(longNumberIssues(mapped), []);
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'currency-unmapped').map((issue) => issue.rawValue), ['（19位数值）']);
});

test('XLSX 单元格没有位置属性时整张表不还原，按无法核对原值提示', async (t) => {
  const dir = createTempDir(t);
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'implicit.xlsx'), [
    HEADER,
    ['2026-11-01', 'USD', 100, 1111, 2222]
  ], { 1111: SERIAL, 2222: CARD }, (xml) => xml.replace(' r="E2"', ''));
  const mapped = map(filePath);
  assert.deepEqual(identifiers(mapped), [['9007199254740992', '6222021234567890000']]);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号', '卡号']]);
});

test('拆分行按实际的发生额分支排除金额列：被按正负号拆分指定的行，保存的收入映射列作标识时按原文', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '有符号金额', '流水号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'signed.xlsx'), [header, ['2026-11-01', 'USD', -20, 1111]], { 1111: SERIAL });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', ChannelOrderNo: '流水号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ creditSourceField: '流水号' })],
      signedAmountSourceField: '有符号金额',
      signedAmountTargetSeqNos: [1]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(2)), [['', '20', SERIAL]]);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('只记实际导出的拆分子行与同一方向首条命中规则的取值', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '卡号', '收入A', '收入B', '方向', '金额1', '金额2'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'entries.xlsx'), [
    header,
    ['2026-11-01', 'USD', 1111, 0, 100, '收', 30, 2222]
  ], { 1111: '6.2220212345678899E+18', 2222: '9.0071992547409952E+15' });
  // 第 1 个子行币种取卡号、收支为 0 被丢弃；第 2 个子行正常导出
  const split = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [
        splitRow({ currencySourceField: '卡号', creditSourceField: '收入A' }),
        splitRow({ seqNo: 2, creditSourceField: '收入B' })
      ]
    })
  });
  assert.deepEqual(split.slice(1).map((row) => row.slice(1, 3)), [['USD', '100']]);
  assert.deepEqual(longNumberIssues(split), []);

  // 主映射按字段区分发生额：两条收入规则都命中，只取第一条（金额1）
  const byField = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: header,
    amountSplitByField: {
      enabled: true,
      rules: [
        { conditionField: '方向', conditionValue: '收', mappedField: '金额1', targetField: 'Credit Amount' },
        { conditionField: '方向', conditionValue: '收', mappedField: '金额2', targetField: 'Credit Amount' }
      ]
    }
  });
  assert.deepEqual(byField.slice(1).map((row) => row[2]), ['30']);
  assert.deepEqual(longNumberIssues(byField), []);
});

test('按币种匹配大账号的阻断错误中，还原的长数字只写位数', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '卡号', '金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'currency-only.xlsx'), [header, ['2026-11-01', 1111, 100]], { 1111: CARD });
  assert.throws(() => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: MERCHANT_ID_CURRENCY_ONLY_MARKER, Currency: '卡号', 'Credit Amount': '金额' },
    expectedSourceHeaders: header,
    currencyBigAccountMapping: { templateName: 'T', pairs: [{ currency: 'USD', merchantId: 'M1' }] }
  }), (error) => {
    const text = JSON.stringify([error.message, error.detailLines, error.context]);
    assert.ok(text.includes('（19位数值）'), text);
    assert.ok(!text.includes(CARD), text);
    return true;
  });
});

test('按收支方向取的账号：该方向不取值时不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '支出', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'directional.xlsx'), [
    header,
    ['2026-11-01', 'USD', '', 50, 1111],
    ['2026-11-02', 'USD', 60, '', 2222]
  ], { 1111: '6.2220212345678899E+18', 2222: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Drawee CardNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入', 'Debit Amount': '支出', 'Drawee CardNo': '卡号' },
    amountMappingRules: { accountSourceField: '卡号' },
    expectedSourceHeaders: header
  });
  // 支出行付款卡号留空、不提示；收入行取卡号并提示
  assert.deepEqual(mapped.slice(1).map((row) => row[4]), ['', '6222021234567890000']);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [3, [{ sourceField: '卡号', digitCount: 19 }]]
  ]);
});

test('按字段区分发生额：按规则取的发生额列同样提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '方向', '金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'by-field.xlsx'), [
    header,
    ['2026-11-01', 'USD', '收', 1111]
  ], { 1111: '9.0071992547409952E+15' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: header,
    amountSplitByField: {
      enabled: true,
      rules: [{ conditionField: '方向', conditionValue: '收', mappedField: '金额', targetField: 'Credit Amount' }]
    }
  });
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [2, [{ sourceField: '金额', digitCount: 16 }]]
  ]);
});

test('逻辑取值的候补列名以固定值前缀开头时仍按金额列：保持读取库的数值并提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '__FIXED__:金额', '备用金额', '流水号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'logic-amount.xlsx'), [
    header,
    ['2026-11-01', 'USD', 1111, '', 2222]
  ], { 1111: SERIAL, 2222: SERIAL });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': buildLogicValueToken(['__FIXED__:金额', '备用金额']),
      ChannelOrderNo: '流水号'
    },
    expectedSourceHeaders: header
  });
  // 金额与余额计算同一个值；同一原文作流水号按原文
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(2)), [['9007199254740992', '', SERIAL]]);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells), [[{ sourceField: '__FIXED__:金额', digitCount: 16 }]]);
});

test('多列拼接的诊断值中，还原的长数字同样只写位数', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '卡号', '后缀', '金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'concat.xlsx'), [header, ['2026-11-01', 1111, 12, 100]], { 1111: CARD });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: ['卡号', '后缀'], 'Credit Amount': '金额' },
    currencyMappings: [{ englishCode: 'USD', aliases: ['美元'] }],
    expectedSourceHeaders: header
  });
  assert.deepEqual(mapped.issues.filter((issue) => issue.type === 'currency-unmapped').map((issue) => issue.rawValue), ['（19位数值）12']);
  assert.ok(!JSON.stringify(mapped.issues).includes(CARD));
});

test('合并行：金额来源汇总组内各子行，户名 / 卡号等其余来源只跟随代表行', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '支出', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'merged.xlsx'), [
    header,
    ['2026-11-01', 'USD', 40, 10, 1111],
    ['2026-11-02', 'USD', 40, 2222, 3333]
  ], {
    1111: '6.2220212345678899E+18',
    2222: '9.0071992547409952E+15',
    3333: '6.2220212345678899E+18'
  });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee CardNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Payee CardNo': '卡号' },
    amountMappingRules: { accountSourceField: '卡号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [
        splitRow({ creditSourceField: '收入', mergedGroupSeq: 1 }),
        splitRow({ seqNo: 2, debitSourceField: '支出', mergedGroupSeq: 1 })
      ]
    })
  });
  // 代表行（收入）不取收款卡号：合并行收款卡号为空，只由支出子行读到的卡号不提示；支出子行的金额参与净额，照常提示
  //   （超出 9×10^15 的净额精度不在本次范围，只看方向）
  assert.deepEqual(mapped.slice(1).map((row) => [row[2], row[3] !== '', row[4]]), [
    ['30', false, ''],
    ['', true, '']
  ]);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [3, [{ sourceField: '支出', digitCount: 16 }]]
  ]);
});

test('拆分子行覆盖币种时，底稿币种读到的长数字不提示；子行沿用底稿币种时提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '卡号', '收入'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'currency-override.xlsx'), [
    header,
    ['2026-11-01', 1111, 100]
  ], { 1111: '6.2220212345678899E+18' });
  const generate = (currencySourceField) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', Currency: '卡号' },
      billSplitRows: [splitRow({ currencySourceField, creditSourceField: '收入' })]
    })
  });
  const overridden = generate('__FIXED__:USD');
  assert.deepEqual(overridden.slice(1).map((row) => row.slice(1, 3)), [['USD', '100']]);
  assert.deepEqual(longNumberIssues(overridden), []);
  const inherited = generate('');
  assert.deepEqual(inherited.slice(1).map((row) => row.slice(1, 3)), [['6222021234567890000', '100']]);
  assert.deepEqual(longNumberIssues(inherited).map((issue) => issue.cells), [[{ sourceField: '卡号', digitCount: 19 }]]);
});

test('特征值未筛出时字段留空：只记未筛出提示，不提示无法核对原值', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '金额', '附言'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'feature-miss.xlsx'), [
    header,
    ['2026-11-01', 'USD', 100, 1111]
  ], { 1111: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Remark'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '金额', Remark: '__FEATURE_FILTER__:f1' },
    expectedSourceHeaders: header,
    featureFilters: { f1: { id: 'f1', name: '单号', sourceField: '附言', separator: '', length: 4 } }
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[4]), ['']);
  assert.equal(mapped.issues.filter((issue) => issue.type === 'feature-value-unmatched').length, 1);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('金额列按各取值点解读表头：按字段区分发生额的规则列、拆分按正负号拆分的列，列名以内部前缀开头时仍是金额列', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '方向', '__FIXED__:金额', '旧金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'rule-prefix.xlsx'), [
    header,
    ['2026-11-01', 'USD', '收', 1111, 2222]
  ], { 1111: SERIAL, 2222: '9.0071992547409952E+15' });
  const byField = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    // 按字段区分发生额生效时，保存在模板里的 Credit 映射不读、不提示
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '旧金额' },
    expectedSourceHeaders: header,
    amountSplitByField: {
      enabled: true,
      rules: [{ conditionField: '方向', conditionValue: '收', mappedField: '__FIXED__:金额', targetField: 'Credit Amount' }]
    }
  });
  assert.deepEqual(byField.slice(1).map((row) => row[2]), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(byField).map((issue) => issue.cells), [[{ sourceField: '__FIXED__:金额', digitCount: 16 }]]);

  const signedHeader = ['日期', '币种', '__FEATURE_FILTER__:金额'];
  const signedPath = await writeXlsxWithLiterals(path.join(dir, 'signed-prefix.xlsx'), [
    signedHeader,
    ['2026-11-01', 'USD', 1111]
  ], { 1111: SERIAL });
  const signed = buildMappedRows({
    inputFilePath: signedPath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', Currency: '币种' },
    expectedSourceHeaders: signedHeader,
    billSplitMerge: billSplitMerge({ signedAmountSourceField: '__FEATURE_FILTER__:金额' })
  });
  assert.deepEqual(signed.slice(1).map((row) => row[2]), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(signed).map((issue) => issue.cells), [[{ sourceField: '__FEATURE_FILTER__:金额', digitCount: 16 }]]);
});

test('费用账单行按规则取发生额时只读支出规则：收入规则的列作流水号时按原文、不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '方向', '手续费', '流水号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'fee-rules.xlsx'), [
    header,
    ['2026-11-01', 'USD', '费', 5, 1111]
  ], { 1111: SERIAL });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', ChannelOrderNo: '流水号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ isFeeBill: true })],
      billSplitAmountRules: [
        { conditionField: '方向', conditionValue: '费', mappedField: '流水号', targetField: 'Credit Amount' },
        { conditionField: '方向', conditionValue: '费', mappedField: '手续费', targetField: 'Debit Amount' }
      ]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(2)), [['', '5', SERIAL]]);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('XLSX：注释里的 <v> 不算单元格的值；一个单元格有多个 <v> 时不还原并提示', async (t) => {
  const dir = createTempDir(t);
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]];
  const commented = await writeXlsxWithLiterals(path.join(dir, 'commented.xlsx'), rows, { 1111: SERIAL, 2222: CARD },
    (xml) => xml.replace(`<v>${SERIAL}</v>`, `<!-- 旧值 <v>9007199254740992</v> --><v>${SERIAL}</v>`));
  const fromComment = map(commented);
  assert.deepEqual(identifiers(fromComment), [[SERIAL, CARD]]);
  assert.deepEqual(longNumberIssues(fromComment), []);

  const doubled = await writeXlsxWithLiterals(path.join(dir, 'doubled.xlsx'), rows, { 1111: SERIAL, 2222: CARD },
    (xml) => xml.replace(`<v>${SERIAL}</v>`, `<v>${SERIAL}</v><v>9007199254740992</v>`));
  const fromDoubled = map(doubled);
  assert.equal(identifiers(fromDoubled)[0][1], CARD);
  assert.deepEqual(longNumberIssues(fromDoubled).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
});

test('币种 / 大账号由所选大账号决定时不读源字段、不提示；提示记下源字段写进的目标列', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '金额'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'selected.xlsx'), [
    header,
    ['2026-11-01', 1111, 100]
  ], { 1111: '6.2220212345678899E+18' });
  const generate = (selectedBigAccount) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { BillDate: '日期', MerchantId: '币种', Currency: '币种', 'Credit Amount': '金额' },
    expectedSourceHeaders: header,
    selectedBigAccount
  });
  const selected = generate({ merchantId: 'M1', currency: 'USD' });
  assert.deepEqual(selected.slice(1).map((row) => row.slice(1, 3)), [['M1', 'USD']]);
  assert.deepEqual(longNumberIssues(selected), []);
  const unselected = generate(null);
  assert.deepEqual(unselected.issues.filter((issue) => issue.type === 'long-number-unverified').map((issue) => issue.cells), [[
    { sourceField: '币种', digitCount: 19, targetFields: ['MerchantId', 'Currency'] }
  ]]);
});

test('合并行只汇总各子行发生额的来源：同一列在非代表子行作卡号时不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '类型', '币种', '收入', '支出', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'merged-card.xlsx'), [
    header,
    ['2026-11-01', '拆分', 'USD', 20, 5, 1111]
  ], { 1111: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee CardNo'],
    // 卡号列同时是主映射（未命中过滤的行）的收入列
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '卡号', 'Payee CardNo': '卡号' },
    amountMappingRules: { accountSourceField: '卡号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [
        splitRow({ creditSourceField: '收入', mergedGroupSeq: 1 }),
        splitRow({ seqNo: 2, debitSourceField: '支出', mergedGroupSeq: 1 })
      ],
      rowFilterRules: [{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '拆分' }] }]
    })
  });
  assert.deepEqual(mapped.slice(1).map((row) => row.slice(2)), [['15', '', '']]);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('二进制 .xls：文件存的是双精度数，无法还原并提示', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'biff.xls');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    HEADER,
    ['2026-11-01', 'USD', 100, Number(SERIAL), 'TEXT-1']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath, { bookType: 'biff8' });

  const mapped = map(filePath);
  assert.deepEqual(identifiers(mapped), [['9007199254740992', 'TEXT-1']]);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => [issue.rowNumber, issue.cells]), [
    [2, [{ sourceField: '流水号', digitCount: 16 }]]
  ]);
});

test('扩展名为 .xls 的 CSV / 制表符文本 / HTML，以及扩展名为 .csv 的 XLSX：长数字按原文', async (t) => {
  const dir = createTempDir(t);
  const files = {
    'csv-as.xls': `\uFEFF${HEADER.join(',')}\r\n20261101,USD,100,${SERIAL},"${CARD}"\r\n`,
    'tsv-as.xls': `\uFEFF${HEADER.join('\t')}\r\n20261101\tUSD\t100\t${SERIAL}\t${CARD}\r\n`,
    'html-as.xls': `<html><head><meta charset="utf-8"></head><body><table>
<tr>${HEADER.map((h) => `<td>${h}</td>`).join('')}</tr>
<tr><td>2026年11月01日</td><td>USD</td><td>100</td><td>${SERIAL}</td><td style='mso-number-format:"\\@"'>${CARD}</td></tr>
</table></body></html>`
  };
  Object.entries(files).forEach(([name, content]) => fs.writeFileSync(path.join(dir, name), content));
  await writeXlsxWithLiterals(path.join(dir, 'xlsx-as.csv'), [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]], { 1111: SERIAL, 2222: CARD });

  for (const name of [...Object.keys(files), 'xlsx-as.csv']) {
    const mapped = map(path.join(dir, name));
    assert.deepEqual(identifiers(mapped), [[SERIAL, CARD]], name);
    assert.deepEqual(longNumberIssues(mapped), [], name);
  }
});

test('真 CSV：="…"（两种写法）与首尾制表符在数据行还原；未加引号的 =公式不还原；旧模板的 ="…" 表头照常匹配', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'excel-text.csv');
  const header = ['="日期"', '币种', '金额', '流水号', '卡号'];
  fs.writeFileSync(filePath, [
    header.join(','),
    `2026-11-01,USD,100,="${SERIAL}","=""${CARD}"""`,
    `2026-11-02,USD,200,"\t${SERIAL}\t",=123`,
    '2026-11-03,USD,300,="A""B",="="'
  ].join('\r\n'));
  // 旧版本从这份文件建的模板，表头按原值存为 =日期
  const templateHeader = ['=日期', '币种', '金额', '流水号', '卡号'];
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: TARGETS,
    mappingByField: { ...MAPPING, BillDate: '=日期' },
    expectedSourceHeaders: templateHeader
  });
  assert.deepEqual(identifiers(mapped), [[SERIAL, CARD], [SERIAL, '=123'], ['A"B', '=']]);

  // 不传选项的读取不变（模板导入表头、其他模块）
  const plain = readRowsWithMetadata(filePath, templateHeader);
  assert.deepEqual(plain.rows[1].slice(3), [`=${SERIAL}`, `="${CARD}"`]);
  assert.deepEqual(plain.rows[2].slice(3), [`\t${SERIAL}\t`, '=123']);
  // 表头行仍是原值
  const exact = readRowsWithMetadata(filePath, templateHeader, { exactSourceText: true });
  assert.deepEqual(exact.rows[0], templateHeader);
});

test('不传 exactSourceText 时读取结果不变（长数字仍为读取库的数字）；readRows 传入时只另附原文', async (t) => {
  const dir = createTempDir(t);
  const xlsxPath = await writeXlsxWithLiterals(path.join(dir, 'plain.xlsx'), [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]], { 1111: SERIAL, 2222: CARD });
  const htmlPath = path.join(dir, 'plain.xls');
  fs.writeFileSync(htmlPath, `<table><tr>${HEADER.map((h) => `<td>${h}</td>`).join('')}</tr><tr><td>20261101</td><td>USD</td><td>100</td><td>${SERIAL}</td><td>${CARD}</td></tr></table>`);
  for (const filePath of [xlsxPath, htmlPath]) {
    const row = readRows(filePath)[1];
    assert.equal(typeof row[3], 'number', filePath);
    assert.equal(isUnverifiedLongNumber(row[3]), true, filePath);
    // 大账号识别的读取：值不变，另附原文（定位表头后由 main.js 用于账户信息行）
    const exactRows = readRows(filePath, { blankrows: true, exactSourceText: true });
    assert.equal(exactRows[1][3], row[3], filePath);
    assert.deepEqual(Array.from(exactRows.sourceText.get(1)), [[3, SERIAL], [4, CARD]], filePath);
  }
});

// v3.2.21 发版合入（fix/statement-long-number-precision × feat/bill-split-fee-field-mapping）
test('费用账单「字段映射特殊处理」：被覆盖的列不提示底稿读到的长数字；覆盖值取自源列时按该源列提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '手续费', '流水号', '备用号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'fee-override.xlsx'), [
    header,
    ['2026-11-01', 'USD', 20, 1111, 2222]
  ], { 1111: '6.2220212345678899E+18', 2222: '6.2220212345678899E+18' });
  const generate = (feeFieldMappings) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', ChannelOrderNo: '流水号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ isFeeBill: true, debitSourceField: '手续费' })],
      feeFieldMappings
    })
  });
  const input = generate([{ templateField: 'ChannelOrderNo', valueType: 'input', value: 'FEE-01' }]);
  assert.deepEqual(input.slice(1).map((row) => row.slice(3)), [['20', 'FEE-01']]);
  assert.deepEqual(longNumberIssues(input), []);
  const field = generate([{ templateField: 'ChannelOrderNo', valueType: 'field', value: '备用号' }]);
  assert.deepEqual(field.slice(1).map((row) => row.slice(3)), [['20', '6222021234567890000']]);
  assert.deepEqual(longNumberIssues(field).map((issue) => issue.cells), [[{ sourceField: '备用号', digitCount: 19 }]]);
  const none = generate([]);
  assert.deepEqual(longNumberIssues(none).map((issue) => issue.cells), [[{ sourceField: '流水号', digitCount: 19 }]]);
});

// ---- v3.2.21 release 审查回归（逻辑取值的特征值候补 × 长数字、费用字段覆盖 × 收支方向卡号）----

test('逻辑取值的特征值候补：发生额按特征值的源列保持读取库的数值（明细与余额同一个值）；采用的候补提示其源列', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '金额', '备用金额', '附言', '备用号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'logic-feature.xlsx'), [
    header,
    ['2026-11-01', 'USD', 1111, '', 2222, '']
  ], { 1111: SERIAL, 2222: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': buildLogicValueToken([buildLogicValueFeatureCandidate('amount'), '备用金额']),
      ChannelOrderNo: buildLogicValueToken([buildLogicValueFeatureCandidate('serial'), '备用号'])
    },
    expectedSourceHeaders: header,
    featureFilters: {
      amount: { id: 'amount', name: '金额', sourceField: '金额', separator: '', length: 16 },
      serial: { id: 'serial', name: '流水号', sourceField: '附言', separator: '', length: 19 }
    }
  });
  // 金额列不按原文还原：特征值取到读取库的数值，与余额计算用的是同一个值
  assert.deepEqual(mapped.slice(1).map((row) => [row[2], row[4]]), [['9007199254740992', '6222021234567890000']]);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells), [[
    { sourceField: '金额', digitCount: 16 },
    { sourceField: '附言', digitCount: 19 }
  ]]);
});

test('逻辑取值的特征值候补未筛出时取下一个候补，不提示该特征值的源列', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '金额', '附言', '备用号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'logic-feature-miss.xlsx'), [
    header,
    ['2026-11-01', 'USD', 100, 1111, 'B-01']
  ], { 1111: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'],
    mappingByField: {
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '金额',
      ChannelOrderNo: buildLogicValueToken([buildLogicValueFeatureCandidate('serial'), '备用号'])
    },
    expectedSourceHeaders: header,
    // 19 位数字不满足 8 位特征长度：未筛出，取「备用号」
    featureFilters: { serial: { id: 'serial', name: '流水号', sourceField: '附言', separator: '', length: 8 } }
  });
  assert.deepEqual(mapped.slice(1).map((row) => row[4]), ['B-01']);
  assert.deepEqual(longNumberIssues(mapped), []);
});

test('费用账单行由「字段映射特殊处理」覆盖按收支方向取值的卡号列时，不提示未写出的源卡号；同一源列写进其他列时照常提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '手续费', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'fee-directional.xlsx'), [
    header,
    ['2026-11-01', 'USD', 20, 1111]
  ], { 1111: '6.2220212345678899E+18' });
  const generate = (mappingByField, feeFieldMappings) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Payee CardNo', 'Remark'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Payee CardNo': '卡号', ...mappingByField },
    amountMappingRules: { accountSourceField: '卡号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ isFeeBill: true, debitSourceField: '手续费' })],
      feeFieldMappings
    })
  });
  const overridden = generate({}, [{ templateField: 'Payee CardNo', valueType: 'input', value: 'FEE' }]);
  assert.deepEqual(overridden.slice(1).map((row) => row.slice(3, 5)), [['20', 'FEE']]);
  assert.deepEqual(longNumberIssues(overridden), []);
  const directional = generate({}, []);
  assert.deepEqual(directional.slice(1).map((row) => String(row[4])), ['6222021234567890000']);
  assert.deepEqual(longNumberIssues(directional).map((issue) => issue.cells), [[{ sourceField: '卡号', digitCount: 19 }]]);
  const alsoRemark = generate({ Remark: '卡号' }, [{ templateField: 'Payee CardNo', valueType: 'input', value: 'FEE' }]);
  assert.deepEqual(alsoRemark.slice(1).map((row) => row.slice(4).map(String)), [['FEE', '6222021234567890000']]);
  assert.deepEqual(longNumberIssues(alsoRemark).map((issue) => issue.cells), [[{ sourceField: '卡号', digitCount: 19 }]]);
});

test('XLSX：一个单元格有一个带内容的 <v> 和一个自闭合的空 <v/> 时同样不还原并提示', async (t) => {
  const dir = createTempDir(t);
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]];
  const selfClosing = await writeXlsxWithLiterals(path.join(dir, 'self-closing-v.xlsx'), rows, { 1111: SERIAL, 2222: CARD },
    (xml) => xml.replace(`<v>${SERIAL}</v>`, `<v>${SERIAL}</v><v/>`));
  const mapped = map(selfClosing);
  assert.equal(identifiers(mapped)[0][1], CARD);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
});

test('拆分不复用模块映射、不按字段值过滤时，主映射的 Balance 不参与计算：其源列作标识时按原文输出', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '余额', '参考号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split-balance.xlsx'), [
    header,
    ['2026-11-01', 'USD', 10, 20, 1111]
  ], { 1111: SERIAL });
  const targets = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', 'ChannelOrderNo'];
  const generate = (overrides) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: targets,
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入', Balance: '参考号', ChannelOrderNo: '参考号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', Currency: '币种', Balance: '余额', ChannelOrderNo: '参考号' },
      billSplitRows: [splitRow({ creditSourceField: '收入' })],
      ...overrides
    })
  });
  const notReused = generate({});
  assert.deepEqual(notReused.slice(1).map((row) => row.slice(4).map(String)), [['20', SERIAL]]);
  assert.deepEqual(longNumberIssues(notReused), []);
  // 复用模块映射时拆分行的余额取主映射：该列是余额列，保持读取库的数值并提示
  const reused = generate({ reuseModuleMapping: true });
  assert.deepEqual(reused.slice(1).map((row) => String(row[5])), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(reused).map((issue) => issue.cells), [[{ sourceField: '参考号', digitCount: 16 }]]);
});

test('拆分子行的长数字提示记下写进的目标列：只写进币种列的来源可在改选大账号后剔除，同时写进其他列的保留全部目标列', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种码', '收入', '卡号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split-targets.xlsx'), [
    header,
    ['2026-11-01', 1111, 10, 2222]
  ], { 1111: '6.2220212345678899E+18', 2222: '6.2220212345678899E+18' });
  const mapped = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Drawee CardNo', 'Remark'],
    mappingByField: { BillDate: '日期', 'Drawee CardNo': '卡号', Remark: '卡号' },
    amountMappingRules: { accountSourceField: '卡号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ currencySourceField: '币种码', creditSourceField: '收入' })]
    })
  });
  const cells = mapped.issues.filter((issue) => issue.type === 'long-number-unverified').flatMap((issue) => issue.cells);
  assert.deepEqual(Object.fromEntries(cells.map((cell) => [cell.sourceField, (cell.targetFields || []).slice().sort()])), {
    卡号: ['Drawee CardNo', 'Remark'],
    币种码: ['Currency']
  });
});

test('余额方式为「无」或「通过发生额计算」时，拆分映射的 Balance 源列不参与计算：作标识时按原文输出', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '参考号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'split-balance-mode.xlsx'), [
    header,
    ['2026-11-01', 'USD', 10, 1111]
  ], { 1111: SERIAL });
  const targets = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo'];
  const generate = (mainBalance) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: targets,
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入', ...(mainBalance ? { Balance: mainBalance } : {}) },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', Currency: '币种', Balance: '参考号', ChannelOrderNo: '参考号' },
      billSplitRows: [splitRow({ creditSourceField: '收入' })]
    })
  });
  // 「无」：生成配置不带主映射 Balance
  for (const [label, mainBalance] of [['无', null], ['通过发生额计算', '通过发生额计算']]) {
    const mapped = generate(mainBalance);
    assert.deepEqual(mapped.slice(1).map((row) => String(row[4])), [SERIAL], label);
    assert.deepEqual(longNumberIssues(mapped), [], label);
  }
  // 取账单余额列：拆分映射的 Balance 是余额列，保持读取库的数值并提示
  const statement = generate('余额');
  assert.deepEqual(statement.slice(1).map((row) => String(row[4])), ['9007199254740992']);
  assert.equal(longNumberIssues(statement).length, 1);
});

test('XLSX：单元格引用的行与所在 <row> 不一致时整张表不还原并提示，不把一笔交易的流水号写到另一笔上', async (t) => {
  const dir = createTempDir(t);
  // 两个流水号舍入为同一数值：数值相同不能证明原文属于该行
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 5], ['2026-11-02', 'USD', 200, 2222, 6]];
  const literals = { 1111: '9007199254740993', 2222: '9007199254740992' };
  const swapped = await writeXlsxWithLiterals(path.join(dir, 'swapped-ref.xlsx'), rows, literals,
    (xml) => xml.replace('r="D2"', 'r="__TMP__"').replace('r="D3"', 'r="D2"').replace('r="__TMP__"', 'r="D3"'));
  const mapped = map(swapped);
  assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), ['9007199254740992', '9007199254740992']);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号'], ['流水号']]);
  // 对照：<row> 不写 r（按前一行顺推）时两层坐标一致，照常按原文
  const implicitRows = await writeXlsxWithLiterals(path.join(dir, 'implicit-row.xlsx'), rows, literals,
    (xml) => xml.replace(/<row r="\d+"/g, '<row'));
  const restored = map(implicitRows);
  assert.deepEqual(identifiers(restored).map(([serial]) => String(serial)), ['9007199254740993', '9007199254740992']);
  assert.deepEqual(longNumberIssues(restored), []);
});

test('余额方式为「无」或「通过发生额计算」时，拆分映射的 Balance 列既不写进明细也不参与计算：只映射到这一列的长数字不提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '收入', '参考号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'unused-balance.xlsx'), [
    header,
    ['2026-11-01', 'USD', 10, 1111]
  ], { 1111: '6.2220212345678899E+18' });
  const generate = (mainBalance, splitMapping) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', 'ChannelOrderNo'],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入', ...(mainBalance ? { Balance: mainBalance } : {}) },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      reuseModuleMapping: false,
      billSplitMappingByTargetField: { BillDate: '日期', Currency: '币种', ...splitMapping },
      billSplitRows: [splitRow({ creditSourceField: '收入' })]
    })
  });
  const issueTargets = (mapped) => mapped.issues.filter((issue) => issue.type === 'long-number-unverified')
    .flatMap((issue) => issue.cells.map((cell) => [cell.sourceField, (cell.targetFields || []).slice().sort()]));
  for (const [label, mainBalance] of [['无', null], ['通过发生额计算', '通过发生额计算']]) {
    assert.deepEqual(issueTargets(generate(mainBalance, { Balance: '参考号' })), [], label);
    // 同一源列还写进流水号时照常提示，只记实际写进的列
    assert.deepEqual(issueTargets(generate(mainBalance, { Balance: '参考号', ChannelOrderNo: '参考号' })), [['参考号', ['ChannelOrderNo']]], label);
  }
  // 取账单余额列：拆分映射的 Balance 参与余额计算，照常提示
  assert.deepEqual(issueTargets(generate('余额', { Balance: '参考号' })), [['参考号', ['Balance']]]);
});

test('XLSX：工作簿关系文件注释里的旧关系不算，不把另一张表的流水号写进当前表；同一关系 Id 有多条有效关系时不还原并提示', async (t) => {
  const dir = createTempDir(t);
  const WORKSHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  // 两张表同一位置的流水号舍入为同一数值（9007199254740996），数值核对发现不了串表
  const build = async (fileName, transformRels) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 100, 1111, 5]]), 'Sheet1');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 999, 2222, 6]]), 'Sheet2');
    const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    for (const [sheetPath, placeholder, literal] of [
      ['xl/worksheets/sheet1.xml', 1111, '9007199254740996'],
      ['xl/worksheets/sheet2.xml', 2222, '9007199254740995']
    ]) {
      const xml = await zip.file(sheetPath).async('string');
      assert.ok(xml.includes(`<v>${placeholder}</v>`), sheetPath);
      zip.file(sheetPath, xml.replace(`<v>${placeholder}</v>`, `<v>${literal}</v>`));
    }
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    assert.match(rels, /<Relationship Id="rId1" [^>]*Target="worksheets\/sheet1\.xml"/);
    zip.file('xl/_rels/workbook.xml.rels', transformRels(rels));
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const staleRelation = `<Relationship Id="rId1" Type="${WORKSHEET_TYPE}" Target="worksheets/sheet2.xml"/>`;
  const commented = await build('commented-rels.xlsx', (rels) => rels.replace('<Relationship ', `<!-- ${staleRelation} --><Relationship `));
  const mapped = map(commented);
  assert.deepEqual(mapped.slice(1).map((row) => row[TARGETS.indexOf('Credit Amount')]), ['100'], '读取库读的是第一张表');
  assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), ['9007199254740996']);
  assert.deepEqual(longNumberIssues(mapped), []);

  const duplicated = await build('duplicated-rels.xlsx', (rels) => rels.replace('<Relationship ', `${staleRelation}<Relationship `));
  const unverified = map(duplicated);
  assert.deepEqual(identifiers(unverified).map(([serial]) => String(serial)), ['9007199254740996']);
  assert.deepEqual(longNumberIssues(unverified).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
});

test('XLSX：公式单元格的 <v> 是计算结果的缓存，不当作原文还原，按无法核对提示（含共享公式）', async (t) => {
  const dir = createTempDir(t);
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 5], ['2026-11-02', 'USD', 200, 2222, 6]];
  const literals = { 1111: '9007199254740992', 2222: '9007199254740992' };
  const withFormula = await writeXlsxWithLiterals(path.join(dir, 'formula.xlsx'), rows, literals, (xml) => xml
    .replace(/(<c r="D2"[^>]*>)<v>/, '$1<f>VALUE(F2)</f><v>')
    .replace(/(<c r="D3"[^>]*>)<v>/, '$1<f t="shared" si="0"/><v>'));
  const mapped = map(withFormula);
  assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), ['9007199254740992', '9007199254740992']);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号'], ['流水号']]);
  // 对照：同样的值不是公式时按原文
  const plain = map(await writeXlsxWithLiterals(path.join(dir, 'plain.xlsx'), rows, literals));
  assert.deepEqual(longNumberIssues(plain), []);
});

test('XLSX：数组公式结果区域内只有缓存 <v> 的后续单元格同样不当作原文，按无法核对提示', async (t) => {
  const dir = createTempDir(t);
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 5], ['2026-11-02', 'USD', 200, 2222, 6]];
  const literals = { 1111: '9007199254740993', 2222: '9007199254740995' };
  // 首格 D2 带区域 D2:D3 的数组公式，D3 只有缓存值
  const arrayFormula = await writeXlsxWithLiterals(path.join(dir, 'array.xlsx'), rows, literals, (xml) => xml
    .replace(/(<c r="D2"[^>]*>)<v>/, '$1<f t="array" ref="D2:D3">VALUE(F2:F3)</f><v>'));
  const mapped = map(arrayFormula);
  assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号'], ['流水号']]);
  assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), [String(Number('9007199254740993')), String(Number('9007199254740995'))]);
  // 区域外的格照常按原文（区域只覆盖 D2:D3 时，E 列卡号不受影响）
  const outside = map(await writeXlsxWithLiterals(path.join(dir, 'outside.xlsx'), rows, literals, (xml) => xml
    .replace(/(<c r="D2"[^>]*>)<v>/, '$1<f t="array" ref="D2:D2">VALUE(F2)</f><v>')));
  assert.deepEqual(longNumberIssues(outside).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
  assert.deepEqual(identifiers(outside).map(([serial]) => String(serial)), [String(Number('9007199254740993')), '9007199254740995']);
});

test('XLSX：公式区域引用写法异常（多区域、显式为空）时整张表不还原；区域重叠时按并集判断', async (t) => {
  const dir = createTempDir(t);
  const rows = [HEADER, ['2026-11-01', 'USD', 100, 1111, 5], ['2026-11-02', 'USD', 200, 2222, 6]];
  const literals = { 1111: '9007199254740993', 2222: '9007199254740995' };
  const issuesOf = async (name, transform) => longNumberIssues(map(await writeXlsxWithLiterals(path.join(dir, name), rows, literals, transform)));
  const bothUnverified = [['流水号'], ['流水号']];
  const sources = (issues) => issues.map((issue) => issue.cells.map((cell) => cell.sourceField));
  // decode_range 能解出 "F2:F3,D3:D8"，但它不是单个矩形；D3 不能因此当作区域外的原文
  assert.deepEqual(sources(await issuesOf('multi.xlsx', (xml) => xml
    .replace(/(<c r="D2"[^>]*>)<v>/, '$1<f>VALUE(F2)</f><v>')
    .replace(/(<c r="E2"[^>]*>)<v>/, '$1<f t="array" ref="F2:F3,D3:D8">1</f><v>'))), bothUnverified);
  assert.deepEqual(sources(await issuesOf('empty.xlsx', (xml) => xml
    .replace(/(<c r="E2"[^>]*>)<v>/, '$1<f t="array" ref="">1</f><v>'))), bothUnverified);
  // 区域互相重叠（有效文件不会出现）：按并集判断——D2:D6 与 D3 重叠时 D5 仍在区域内（只看起始行最近的区域会漏掉），
  //   区域外的 D7 照常按原文；其他列的区域重叠不影响（release 审查）
  const overlapRows = [HEADER, ...[1, 2, 3, 4, 5, 6].map((day) => [`2026-11-0${day}`, 'USD', day * 100, 1110 + day, day])];
  const overlapLiterals = Object.fromEntries([1, 2, 3, 4, 5, 6].map((day) => [1110 + day, String(9007199254740992n + BigInt(day))]));
  const overlap = map(await writeXlsxWithLiterals(path.join(dir, 'overlap.xlsx'), overlapRows, overlapLiterals, (xml) => xml
    .replace(/(<c r="E2"[^>]*>)<v>/, '$1<f t="array" ref="C2:D6">1</f><v>')
    .replace(/(<c r="E3"[^>]*>)<v>/, '$1<f t="array" ref="C3:D3">1</f><v>')
    .replace(/(<c r="E4"[^>]*>)<v>/, '$1<f t="array" ref="E4:F5">1</f><v>')
    .replace(/(<c r="E5"[^>]*>)<v>/, '$1<f t="array" ref="F4:F6">1</f><v>')));
  assert.deepEqual(longNumberIssues(overlap).map((issue) => issue.rowNumber), [2, 3, 4, 5, 6]);
  assert.equal(String(identifiers(overlap)[5][0]), '9007199254740998');
  // 列名写成小写时统一大写后再解码（解码库把小写列名解成别的列）：d2:d3 即 D2:D3，区域外的 D4 起照常按原文
  const lowercase = map(await writeXlsxWithLiterals(path.join(dir, 'lowercase.xlsx'), overlapRows, overlapLiterals, (xml) => xml
    .replace(/(<c r="D2"[^>]*>)<v>/, '$1<f t="array" ref="d2:d3">VALUE(F2:F3)</f><v>')));
  assert.deepEqual(longNumberIssues(lowercase).map((issue) => issue.rowNumber), [2, 3]);
  // 对照：区域不含流水号列（E2:E3）时照常按原文；共享公式首格的 ref 不按区域判断（各格自带 <f>）
  assert.deepEqual(await issuesOf('other-column.xlsx', (xml) => xml
    .replace(/(<c r="E2"[^>]*>)<v>/, '$1<f t="array" ref="E2:E3">1</f><v>')), []);
  assert.deepEqual(await issuesOf('shared-master.xlsx', (xml) => xml
    .replace(/(<c r="E2"[^>]*>)<v>/, '$1<f t="shared" ref="D2:E3" si="0">1</f><v>')), []);
});

test('长数字映射到日期列、规范化后写出为空时不提示（没有近似值写进明细）', async (t) => {
  const dir = createTempDir(t);
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'date.xlsx'), [HEADER, ['2026-11-01', 'USD', 100, 1111, 2222]],
    { 1111: SERIAL, 2222: '9.007199254740992E15' });
  const targets = ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo', 'ValueDate'];
  const asDate = map(filePath, { orderedTargetFields: targets, mappingByField: { ...MAPPING, 'Payee Card No': undefined, ValueDate: '卡号' } });
  assert.equal(asDate[1][targets.indexOf('ValueDate')], '');
  assert.deepEqual(longNumberIssues(asDate), []);
  // 对照：同一列映射到普通列时照常提示
  assert.deepEqual(longNumberIssues(map(filePath)).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['卡号']]);
});

test('费用账单覆盖的 ValueDate 取自长数字源列、规范化后为空时不提示；同一源列还写进其他列时照常提示', async (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种', '手续费', '流水号', '备用号'];
  const filePath = await writeXlsxWithLiterals(path.join(dir, 'fee-value-date.xlsx'), [
    header,
    ['2026-11-01', 'USD', 20, 1111, 2222]
  ], { 1111: SERIAL, 2222: '1E+18' });
  const valueDate = { templateField: 'ValueDate', valueType: 'field', value: '备用号' };
  const generate = (feeFieldMappings, debitSourceField = '手续费') => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'ChannelOrderNo', 'ValueDate'],
    mappingByField: { BillDate: '日期', Currency: '币种', ChannelOrderNo: '流水号' },
    expectedSourceHeaders: header,
    billSplitMerge: billSplitMerge({
      billSplitRows: [splitRow({ isFeeBill: true, debitSourceField })],
      feeFieldMappings
    })
  });
  const dateOnly = generate([valueDate]);
  assert.deepEqual(dateOnly.slice(1).map((row) => [row[3], row[5]]), [['20', '']]);
  assert.deepEqual(longNumberIssues(dateOnly), []);
  // 同一源列还覆盖了另一列、或作为费用的发生额时，近似值仍写进明细：照常提示
  const alsoOrderNo = generate([valueDate, { templateField: 'ChannelOrderNo', valueType: 'field', value: '备用号' }]);
  assert.deepEqual(longNumberIssues(alsoOrderNo).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['备用号']]);
  const asAmount = generate([valueDate], '备用号');
  assert.deepEqual(longNumberIssues(asAmount).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['备用号']]);
});

// release 审查：<sheet> 上另带扩展属性（如 custom:id）时，读取库按属性本地名取后一个 id，无法唯一确认读的是哪张表：
//   不还原并提示（两表同一位置的数值舍入后相等，数值核对发现不了串表）；关系属性换用其他前缀、但绑定到关系命名空间时照常还原
test('XLSX：<sheet> 的关系属性无法唯一确认（另带扩展 :id 属性）时不还原并提示；其他前缀绑定到关系命名空间时照常还原', async (t) => {
  const dir = createTempDir(t);
  const build = async (fileName, transformWorkbook) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 100, 1111, 5]]), 'Sheet1');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 999, 2222, 6]]), 'Sheet2');
    const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    for (const [sheetPath, placeholder, literal] of [
      ['xl/worksheets/sheet1.xml', 1111, '9007199254740992'],
      ['xl/worksheets/sheet2.xml', 2222, '9007199254740993']
    ]) {
      const xml = await zip.file(sheetPath).async('string');
      zip.file(sheetPath, xml.replace(`<v>${placeholder}</v>`, `<v>${literal}</v>`));
    }
    const workbookXml = await zip.file('xl/workbook.xml').async('string');
    assert.match(workbookXml, /<sheet name="Sheet1" sheetId="1" r:id="rId1"\/>/);
    zip.file('xl/workbook.xml', transformWorkbook(workbookXml));
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const extended = map(await build('extension-id.xlsx', (xml) => xml
    .replace('<workbook ', '<workbook xmlns:custom="urn:example:custom" ')
    .replace('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>', '<sheet name="Sheet1" sheetId="1" custom:id="rId2" r:id="rId1"/>')));
  assert.deepEqual(extended.slice(1).map((row) => row[TARGETS.indexOf('Credit Amount')]), ['100'], '读取库读的是第一张表');
  assert.deepEqual(identifiers(extended).map(([serial]) => String(serial)), ['9007199254740992'], '不写进第二张表的流水号');
  assert.deepEqual(longNumberIssues(extended).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);

  const otherPrefix = map(await build('other-prefix.xlsx', (xml) => xml
    .replace('<workbook ', '<workbook xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
    .replace('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>', '<sheet name="Sheet1" sheetId="1" rel:id="rId1"/>')));
  assert.deepEqual(identifiers(otherPrefix).map(([serial]) => String(serial)), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(otherPrefix), []);
  // 前缀没有绑定到关系命名空间：无法确认，按无法核对提示
  const unbound = map(await build('unbound-prefix.xlsx', (xml) => xml
    .replace('<workbook ', '<workbook xmlns:x9="urn:example:other" ')
    .replace('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>', '<sheet name="Sheet1" sheetId="1" x9:id="rId1"/>')));
  assert.deepEqual(longNumberIssues(unbound).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
});

// release 审查：未开查重时核对长数字只解压 workbook.xml、其关系文件与目标工作表，其他工作表与嵌入文件不再解压；
//   压缩包结构不支持按需读取（如条目名重复）时退回整包读取，结果不变
test('XLSX：未开查重时核对长数字只解压用到的条目；不支持按需读取时退回整包读取', async (t) => {
  const zlib = require('node:zlib');
  const dir = createTempDir(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 100, 1111, 5]]), 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 999, 987654321, 6]]), 'Sheet2');
  const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace('<v>1111</v>', `<v>${SERIAL}</v>`));
  zip.file('xl/media/attachment.bin', 'MEDIA-MARKER'.repeat(1000));
  zip.file('extra/a.txt', 'a');
  zip.file('extra/b.txt', 'b');
  const deflated = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const inflated = [];
  const original = zlib.inflateRawSync;
  t.after(() => { zlib.inflateRawSync = original; });
  zlib.inflateRawSync = (...args) => {
    const output = original(...args);
    inflated.push(output.toString('utf8'));
    return output;
  };
  const lazyPath = path.join(dir, 'lazy.xlsx');
  fs.writeFileSync(lazyPath, deflated);
  const mapped = map(lazyPath);
  zlib.inflateRawSync = original;
  assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), [SERIAL]);
  assert.deepEqual(longNumberIssues(mapped), []);
  assert.equal(inflated.length, 3, '只解压 workbook.xml、关系文件与目标工作表');
  assert.ok(inflated.some((text) => text.includes(SERIAL)), '解压了目标工作表');
  assert.ok(!inflated.some((text) => text.includes('987654321') || text.includes('MEDIA-MARKER')), '其他工作表与嵌入文件不解压');

  // 条目名重复（不区分大小写）：不支持按需读取，退回整包读取，结果不变
  const duplicated = Buffer.from(deflated);
  let position = duplicated.indexOf('extra/b.txt');
  assert.ok(position > 0);
  while (position >= 0) {
    duplicated.write('EXTRA/A.TXT', position, 'latin1');
    position = duplicated.indexOf('extra/b.txt', position + 1);
  }
  assert.equal(openZipEntriesLazily(duplicated), null);
  const fallbackPath = path.join(dir, 'fallback.xlsx');
  fs.writeFileSync(fallbackPath, duplicated);
  const fallback = map(fallbackPath);
  assert.deepEqual(identifiers(fallback).map(([serial]) => String(serial)), [SERIAL]);
  assert.deepEqual(longNumberIssues(fallback), []);

  // 条目数据损坏：只影响该条目（content 为 null），其他条目照常读出
  const files = openZipEntriesLazily(deflated);
  assert.ok(files && files['xl/worksheets/sheet1.xml'].content.toString('utf8').includes(SERIAL));
  assert.equal(openZipEntriesLazily(Buffer.from('not a zip')), null);
});

// release 审查：须确认读取库实际读取的工作表。① 另一张表的关系解析不到时，读取库放弃整份关系表、改按物理序号读表，
//   不能再按目标表的关系取 XML；② 读取库按「xl/ + 去掉 xl/ 前缀的 Target」定位，与按关系文件目录解析 Target 落到不同条目时
//   同样无法确认。两种情况都不还原并提示（数值舍入后相等，数值核对发现不了）
test('XLSX：读取库实际读取的工作表与按关系定位的不一致时不还原并提示', async (t) => {
  const dir = createTempDir(t);
  const build = async (fileName, transform) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 100, 1111, 5]]), 'Sheet1');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ['2026-11-01', 'USD', 999, 2222, 6]]), 'Sheet2');
    const zip = await JSZip.loadAsync(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    for (const [sheetPath, placeholder, literal] of [
      ['xl/worksheets/sheet1.xml', 1111, '9007199254740992'],
      ['xl/worksheets/sheet2.xml', 2222, '9007199254740993']
    ]) {
      const xml = await zip.file(sheetPath).async('string');
      zip.file(sheetPath, xml.replace(`<v>${placeholder}</v>`, `<v>${literal}</v>`));
    }
    await transform(zip);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    return filePath;
  };
  const replaceIn = async (zip, entry, from, to) => {
    const text = await zip.file(entry).async('string');
    assert.ok(text.includes(from), `${entry} 应含 ${from}`);
    zip.file(entry, text.replace(from, to));
  };
  const assertUnverified = (mapped, label) => {
    assert.deepEqual(mapped.slice(1).map((row) => row[TARGETS.indexOf('Credit Amount')]), ['100'], `${label}：读取库读的是第一张表`);
    assert.deepEqual(identifiers(mapped).map(([serial]) => String(serial)), ['9007199254740992'], `${label}：不写进另一张表的流水号`);
    assert.deepEqual(longNumberIssues(mapped).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']], label);
  };
  // ① 关系文件中两张表的目标互换，Sheet2 引用不存在的关系：读取库按物理序号读 sheet1.xml
  assertUnverified(map(await build('fallback-order.xlsx', async (zip) => {
    await replaceIn(zip, 'xl/_rels/workbook.xml.rels', 'Target="worksheets/sheet1.xml"', 'Target="worksheets/sheetX.xml"');
    await replaceIn(zip, 'xl/_rels/workbook.xml.rels', 'Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet1.xml"');
    await replaceIn(zip, 'xl/_rels/workbook.xml.rels', 'Target="worksheets/sheetX.xml"', 'Target="worksheets/sheet2.xml"');
    await replaceIn(zip, 'xl/workbook.xml', '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>', '<sheet name="Sheet2" sheetId="2" r:id="rId9"/>');
  })), '关系表被放弃');
  // ② Target 写成 xl/worksheets/sheet1.xml：读取库定位到 xl/worksheets/sheet1.xml，按关系文件目录解析是 xl/xl/worksheets/sheet1.xml
  assertUnverified(map(await build('reader-path.xlsx', async (zip) => {
    await replaceIn(zip, 'xl/_rels/workbook.xml.rels', 'Target="worksheets/sheet1.xml"', 'Target="xl/worksheets/sheet1.xml"');
    zip.file('xl/xl/worksheets/sheet1.xml', await zip.file('xl/worksheets/sheet2.xml').async('string'));
  })), '定位口径不同');
  // ③ 关系标签带命名空间前缀（<pr:Relationship>）、关系顺序与物理顺序相反：读取库不认带前缀的关系，改按物理序号读表
  assertUnverified(map(await build('prefixed-rels.xlsx', async (zip) => {
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    zip.file('xl/_rels/workbook.xml.rels', rels
      .replace('<Relationships xmlns=', '<pr:Relationships xmlns:pr=')
      .replace('</Relationships>', '</pr:Relationships>')
      .replace(/<Relationship /g, '<pr:Relationship ')
      .replace('Target="worksheets/sheet1.xml"', 'Target="worksheets/sheetX.xml"')
      .replace('Target="worksheets/sheet2.xml"', 'Target="worksheets/sheet1.xml"')
      .replace('Target="worksheets/sheetX.xml"', 'Target="worksheets/sheet2.xml"'));
  })), '关系带前缀');
  // ④ 注释里的旧关系在有效关系之后：读取库不跳过注释、同一 Id 取后一条，读的是第二张表；按本模块口径是第一张表，不一致
  const staleAfter = map(await build('stale-after.xlsx', async (zip) => {
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const stale = '<!-- <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/> -->';
    zip.file('xl/_rels/workbook.xml.rels', rels.replace('</Relationships>', `${stale}</Relationships>`));
  }));
  assert.deepEqual(staleAfter.slice(1).map((row) => row[TARGETS.indexOf('Credit Amount')]), ['999'], '读取库按注释里的关系读了第二张表');
  assert.deepEqual(identifiers(staleAfter).map(([serial]) => String(serial)), ['9007199254740992'], '不写进第一张表的流水号');
  assert.deepEqual(longNumberIssues(staleAfter).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']]);
  // ⑤ workbook.xml 的注释里有同名的旧 <sheet>（指向第二张表）：读取库把它也算作工作表，序号错开，无法确认读的是哪张表
  const commentedSheet = map(await build('commented-sheet.xlsx', async (zip) => {
    await replaceIn(zip, 'xl/workbook.xml', '<sheets>', '<sheets><!-- <sheet name="Sheet1" sheetId="9" r:id="rId2"/> -->');
  }));
  assert.deepEqual(identifiers(commentedSheet).map(([serial]) => String(serial)), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(commentedSheet).map((issue) => issue.cells.map((cell) => cell.sourceField)), [['流水号']],
    '注释里有 <sheet> 时不还原并提示');
  // 对照：Target 写成绝对路径 /xl/worksheets/sheet1.xml 时两种口径一致，照常还原
  const absolute = map(await build('absolute-target.xlsx', async (zip) => {
    await replaceIn(zip, 'xl/_rels/workbook.xml.rels', 'Target="worksheets/sheet1.xml"', 'Target="/xl/worksheets/sheet1.xml"');
  }));
  assert.deepEqual(identifiers(absolute).map(([serial]) => String(serial)), ['9007199254740992']);
  assert.deepEqual(longNumberIssues(absolute), []);
});
