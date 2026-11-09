'use strict';

// v3.2.16：MerchantId「原始账单仅有币种无账户号」— 按每条输出行的最终币种回填大账号（spec §4.3、D1）。
//   - 命中行 MerchantId = 配置的大账号，Currency 写成大写代码；与 MerchantId / Currency 的字段顺序无关；
//   - 会输出的明细行币种为空或未维护时整批阻断，列出模板 / 文件 / 币种 / 行号；零金额行与合计行不计入；
//   - 多份文件的问题汇总成一次报错；拿不到配置时直接拒绝，不让 MerchantId 留空输出。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  buildMappedRows,
  loadCurrencyMappings,
  mapEachCollectingCurrencyBigAccountIssues
} = require('../../../../src/backend/file-service');
const {
  CURRENCY_BIG_ACCOUNT_CONFIG_MISSING,
  CURRENCY_BIG_ACCOUNT_UNMAPPED,
  appendCurrencyBigAccountIssues,
  applyCurrencyBigAccountMapping,
  buildCurrencyBigAccountUnmappedError
} = require('../../../../src/backend/file-service/currency-big-account');

const CURRENCY_MAPPINGS = loadCurrencyMappings(path.join(__dirname, '..', '..', '..', '..', 'assets', '币种映射表.xlsx'));
const HEADER = ['日期', '币种', '收入', '支出'];
const PAIRS = [
  { currency: 'USD', merchantId: 'NET-USD' },
  { currency: 'EUR', merchantId: 'NET-EUR' },
  { currency: 'HKD', merchantId: 'NET-USD' }
];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-big-account-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeXlsx(dir, fileName, rows) {
  const filePath = path.join(dir, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function mapFile(filePath, overrides = {}) {
  return buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['MerchantId', 'BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: {
      MerchantId: MERCHANT_ID_CURRENCY_ONLY_MARKER,
      BillDate: '日期',
      Currency: '币种',
      'Credit Amount': '收入',
      'Debit Amount': '支出'
    },
    expectedSourceHeaders: HEADER,
    currencyMappings: CURRENCY_MAPPINGS,
    currencyBigAccountMapping: { templateName: '招商银行-上海', pairs: PAIRS },
    ...overrides
  });
}

test('按每行币种回填大账号：大小写不敏感、中文币种名经币种映射表换算，Currency 写成大写代码', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'a.xlsx', [
    HEADER,
    ['2026-11-01', 'usd', '100', ''],
    ['2026-11-01', 'EUR', '', '40'],
    ['2026-11-02', '美元', '5', ''],
    ['2026-11-02', 'Hkd', '7', '']
  ]);

  const mapped = mapFile(filePath);

  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2]]), [
    ['NET-USD', 'USD'],
    ['NET-EUR', 'EUR'],
    ['NET-USD', 'USD'],
    ['NET-USD', 'HKD']
  ]);
});

test('币种只认代码与精确名称：包含式模糊命中（人民币离岸、美元结算）按未维护整批阻断', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'fuzzy.xlsx', [
    HEADER,
    ['2026-11-01', '美元', '1', ''],
    ['2026-11-01', '人民币离岸', '2', ''],
    ['2026-11-02', '美元结算', '3', '']
  ]);

  assert.throws(() => mapFile(filePath, {
    currencyBigAccountMapping: { templateName: '招商银行-上海', pairs: [...PAIRS, { currency: 'CNY', merchantId: 'NET-CNY' }] }
  }), (error) => {
    assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
    assert.deepEqual(error.detailLines, [
      '模板「招商银行-上海」文件「fuzzy.xlsx」币种「人民币离岸」：第 3 行',
      '模板「招商银行-上海」文件「fuzzy.xlsx」币种「美元结算」：第 4 行'
    ]);
    return true;
  });
});

test('MerchantId 排在 Currency 之后时同样按最终币种回填', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'a.xlsx', [HEADER, ['2026-11-01', 'eur', '1', '']]);

  const mapped = mapFile(filePath, {
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount', 'MerchantId']
  });

  assert.deepEqual(mapped.slice(1).map((row) => [row[1], row[4]]), [['EUR', 'NET-EUR']]);
});

test('会输出的行币种为空或未维护时整批阻断，列出模板、文件、币种和行号；零金额行与合计行不计入', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'kbank.xlsx', [
    HEADER,
    ['2026-11-01', 'USD', '100', ''],
    ['2026-11-01', 'JPY', '0', ''],
    ['2026-11-02', '', '5', ''],
    ['2026-11-02', 'GBP', '3', ''],
    ['2026-11-03', 'gbp', '', '9'],
    ['合计', 'CNY', '108', '9']
  ]);

  assert.throws(() => mapFile(filePath), (error) => {
    assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
    assert.match(error.message, /有 3 行明细的币种为空或未在【映射管理】中维护大账号/);
    assert.match(error.message, /未生成任何文件/);
    assert.deepEqual(error.detailLines, [
      '模板「招商银行-上海」文件「kbank.xlsx」币种「（空）」：第 4 行',
      '模板「招商银行-上海」文件「kbank.xlsx」币种「GBP」：第 5、6 行'
    ]);
    return true;
  });
});

test('拆分 / 合并明细账单：按每条拆分行的币种回填，同一源行只记一次行号', (t) => {
  const dir = createTempDir(t);
  const header = ['日期', '币种1', '收入1', '币种2', '收入2'];
  const filePath = writeXlsx(dir, 'split.xlsx', [
    header,
    ['2026-11-01', 'USD', '10', 'EUR', '20'],
    ['2026-11-02', 'GBP', '1', 'GBP', '2']
  ]);
  const options = {
    orderedTargetFields: ['MerchantId', 'BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    mappingByField: { MerchantId: MERCHANT_ID_CURRENCY_ONLY_MARKER, BillDate: '日期' },
    expectedSourceHeaders: header,
    billSplitMerge: {
      enabled: true,
      reuseModuleMapping: true,
      billSplitMappingByTargetField: {},
      billSplitRows: [
        { seqNo: 1, rowStatus: 'completed', currencySourceField: '币种1', creditSourceField: '收入1', debitSourceField: '', mergedGroupSeq: null },
        { seqNo: 2, rowStatus: 'completed', currencySourceField: '币种2', creditSourceField: '收入2', debitSourceField: '', mergedGroupSeq: null }
      ],
      billSplitAmountRules: [],
      signedAmountSourceField: '',
      signedAmountTargetSeqNos: [],
      byFieldAmountTargetSeqNos: []
    }
  };

  assert.throws(() => mapFile(filePath, options), (error) => {
    assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
    assert.deepEqual(error.detailLines, ['模板「招商银行-上海」文件「split.xlsx」币种「GBP」：第 3 行']);
    return true;
  });

  const okPath = writeXlsx(dir, 'split-ok.xlsx', [header, ['2026-11-01', 'USD', '10', 'eur', '20']]);
  const mapped = mapFile(okPath, options);
  assert.deepEqual(mapped.slice(1).map((row) => [row[0], row[2], row[3]]), [
    ['NET-USD', 'USD', '10'],
    ['NET-EUR', 'EUR', '20']
  ]);
});

test('拿不到 币种 → 大账号 配置时拒绝生成，不让 MerchantId 留空输出', (t) => {
  const dir = createTempDir(t);
  const filePath = writeXlsx(dir, 'a.xlsx', [HEADER, ['2026-11-01', 'USD', '1', '']]);

  for (const currencyBigAccountMapping of [null, { templateName: 'T', pairs: [] }]) {
    assert.throws(
      () => mapFile(filePath, { currencyBigAccountMapping }),
      (error) => error.code === CURRENCY_BIG_ACCOUNT_CONFIG_MISSING
    );
  }
});

test('多份文件的问题汇总成一次报错，其他错误照常立即抛出', (t) => {
  const dir = createTempDir(t);
  const fileA = writeXlsx(dir, 'a.xlsx', [HEADER, ['2026-11-01', 'GBP', '1', '']]);
  const fileB = writeXlsx(dir, 'b.xlsx', [HEADER, ['2026-11-01', 'USD', '1', '']]);
  const fileC = writeXlsx(dir, 'c.xlsx', [HEADER, ['2026-11-01', 'JPY', '1', ''], ['2026-11-02', '', '2', '']]);

  assert.throws(
    () => mapEachCollectingCurrencyBigAccountIssues([fileA, fileB, fileC], (filePath) => mapFile(filePath)),
    (error) => {
      assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
      assert.match(error.message, /有 3 行明细.*（涉及 2 个文件）/);
      assert.deepEqual(error.detailLines, [
        '模板「招商银行-上海」文件「a.xlsx」币种「GBP」：第 2 行',
        '模板「招商银行-上海」文件「c.xlsx」币种「JPY」：第 2 行',
        '模板「招商银行-上海」文件「c.xlsx」币种「（空）」：第 3 行'
      ]);
      return true;
    }
  );

  assert.throws(
    () => mapEachCollectingCurrencyBigAccountIssues([fileB], () => { throw new Error('其他错误'); }),
    /其他错误/
  );
  assert.deepEqual(mapEachCollectingCurrencyBigAccountIssues([1, 2], (value) => value * 2), [2, 4]);
});

test('报错明细限量：每组最多 10 个行号、最多 20 组', () => {
  const issues = Array.from({ length: 22 }, (_item, index) => ({
    templateName: 'T',
    fileName: 'a.xlsx',
    currency: `C${index}`,
    rowNumbers: index === 0 ? Array.from({ length: 12 }, (_row, row) => row + 2) : [index + 2]
  }));

  const error = buildCurrencyBigAccountUnmappedError(issues);

  assert.equal(error.detailLines.length, 21);
  assert.equal(error.detailLines[0], '模板「T」文件「a.xlsx」币种「C0」：第 2、3、4、5、6、7、8、9、10、11 行…等 12 行');
  assert.equal(error.detailLines[20], '另有 2 组未列出');
  assert.match(error.message, /有 33 行明细/);
});

// Codex 审查（2026-11-09）：错误路径在大文件下不得退化——同一未维护币种的行号去重须线性，
// 分组数很大（Currency 误映射到流水号列）时合并不得超过函数参数上限而盖掉业务错误。
test('大文件整列币种未维护：行号线性去重，报错仍列出总行数', () => {
  const ROWS = 200000;
  const fields = ['MerchantId', 'BillDate', 'Currency', 'Credit Amount', 'Debit Amount'];
  const mappedRows = [fields];
  const rowMetas = [];
  for (let index = 0; index < ROWS; index += 1) {
    mappedRows.push(['', '2026-11-01', 'GBP', '1', '']);
    rowMetas.push({ sourceRowNumber: index + 2 });
  }

  const startedAt = Date.now();
  assert.throws(() => applyCurrencyBigAccountMapping({
    mappedRows,
    rowMetas,
    orderedTargetFields: fields,
    mapping: { templateName: 'T', pairs: PAIRS },
    inputFilePath: '/x/big.xlsx'
  }), (error) => {
    assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
    assert.match(error.message, new RegExp(`有 ${ROWS} 行明细`));
    assert.match(error.detailLines[0], new RegExp(`…等 ${ROWS} 行$`));
    return true;
  });
  assert.ok(Date.now() - startedAt < 2000, `20 万行耗时 ${Date.now() - startedAt}ms`);
});

test('分组数超过函数参数上限时仍逐项合并，保留币种未维护的业务错误', () => {
  const GROUPS = 150000;
  const huge = buildCurrencyBigAccountUnmappedError(Array.from({ length: GROUPS }, (_item, index) => ({
    templateName: 'T', fileName: 'a.xlsx', currency: `X${index}`, rowNumbers: [index + 2]
  })));

  const target = [];
  appendCurrencyBigAccountIssues(target, huge);
  assert.equal(target.length, GROUPS);

  assert.throws(
    () => mapEachCollectingCurrencyBigAccountIssues([1, 2], () => { throw huge; }),
    (error) => {
      assert.equal(error.code, CURRENCY_BIG_ACCOUNT_UNMAPPED);
      assert.equal(error.detailLines.length, 21);
      assert.equal(error.detailLines[20], `另有 ${GROUPS * 2 - 20} 组未列出`);
      return true;
    }
  );
});
