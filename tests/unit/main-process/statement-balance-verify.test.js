'use strict';

// v3.2.16 网银账单「账单里的余额」逐日余额校验：
// 预期 = 上一日余额 + 当日收入 − 当日支出；首日必须有种子；单一余额不符可确认后按账单余额生成；
// 多候选都不符维持现状报错；断档并入校验；不再接受“+支出”。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const XLSX = require('xlsx');

const {
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  FileValidationError,
  normalizeCell,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../../src/backend/file-service');
const { verifyStatementEndingBalance } = require('../../../src/backend/file-service/normalizers');
const {
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName,
  getBalanceSeedFileIdentity,
  getBalanceSeedFilePath,
  upsertBalanceSeedRecord,
  writeBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');
const { readBalanceAdjustments, writeBalanceAdjustments } = require('../../../src/backend/balance-adjustment-store');
const { createStatementGenerationHelpers } = require('../../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus: scanStatementBalanceSeedStatus
} = require('../../../src/main-process/statement-generation-business');
const { prepareManualBalanceSeedSubmission } = require('../../../src/main-process/manual-balance-seed-preflight');
const {
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  resolveSinglePreparedFieldValue
} = require('../../../src/main-process/statement-session');

const ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const TEMPLATE_NAME = '中行-上海';
const HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
const BALANCE_FIELDS = ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'];

function loadMainFunction(name, dependencyNames = [], dependencyValues = []) {
  const node = MAIN_AST.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到production函数：${name}`);
  return Function(
    ...dependencyNames,
    `return (${MAIN_SOURCE.slice(node.start, node.end)});`
  )(...dependencyValues);
}

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-balance-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const seed = (merchantId, currency, billDate, endBalance, generationMethod = '人工录入') => ({
  merchantId, currency, billDate, endBalance, generationMethod
});

// 与 findPreviousBalanceSeed 同口径：目标日之前最近的一条。
function seedResolver(seeds) {
  const calls = [];
  const resolve = ({ merchantId, currency, targetBillDate, generationMethod }) => {
    calls.push(`${merchantId}@${currency}@${targetBillDate}`);
    const matches = seeds
      .filter((item) => item.merchantId === merchantId && item.currency === currency
        && item.billDate < targetBillDate
        && (!generationMethod || item.generationMethod === generationMethod))
      .sort((left, right) => left.billDate.localeCompare(right.billDate));
    return matches.length ? matches[matches.length - 1] : null;
  };
  return { resolve, calls };
}

function derive(rows, seeds, options = {}) {
  const resolver = seedResolver(seeds);
  const result = deriveBalanceRecords({
    detailRows: [HEADER.slice(), ...rows.map((row) => row.slice())],
    templateName: TEMPLATE_NAME,
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'statement',
    resolvePreviousBalanceSeed: resolver.resolve,
    ...options
  });
  return { result, calls: resolver.calls };
}

function balances(result) {
  return result.records.map((row) => [row[3], row[2], row[4], row[7]]);
}

function deriveError(fn) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FileValidationError, '应抛出 FileValidationError');
  return caught;
}

test('校验函数：相符、单一候选不符、多候选都不符；不再接受“+支出”', () => {
  const entries = (balance, credit, debit) => [{ balanceValue: balance, creditAmount: credit, debitAmount: debit }];
  assert.deepEqual(verifyStatementEndingBalance({ anchorBalance: 1000, dateLabel: 'd', entries: entries(1100, 100, 0) }), {
    status: 'match', endBalance: 1100, creditAmountSum: 100, debitAmountSum: 0, expectedBalance: 1100
  });
  assert.deepEqual(verifyStatementEndingBalance({ anchorBalance: 1000, dateLabel: 'd', entries: entries(9999, 100, 0) }), {
    status: 'mismatch', endBalance: 9999, creditAmountSum: 100, debitAmountSum: 0, expectedBalance: 1100, difference: 8899
  });
  // 只有支出 100：1000 + 100 不再算匹配。
  assert.equal(verifyStatementEndingBalance({ anchorBalance: 1000, dateLabel: 'd', entries: entries(1100, 0, 100) }).status, 'mismatch');
  const unresolved = verifyStatementEndingBalance({
    anchorBalance: 1000,
    dateLabel: 'd',
    entries: [
      { balanceValue: 1050, creditAmount: 0, debitAmount: 100 },
      { balanceValue: 1100, creditAmount: 0, debitAmount: 0.01 }
    ]
  });
  assert.equal(unresolved.status, 'unresolved');
  assert.equal(unresolved.endBalance, null);
  assert.deepEqual(unresolved.candidateBalances, [1050, 1100]);
  assert.equal(unresolved.expectedBalance, 899.99);
  assert.throws(
    () => verifyStatementEndingBalance({ anchorBalance: 1000, dateLabel: '2026-09-01', entries: entries(null, 1, 0) }),
    /2026-09-01 未找到期末余额/
  );
});

test('容差：四舍五入到分后相等即通过（差 0.004 通过，差 0.006 提示）', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  assert.deepEqual(balances(derive([['2026-09-01', 'M001', 'USD', '100', '', '1100.004']], seeds).result), [
    ['M001', 'USD', '2026-09-01', 1100.004]
  ]);
  const error = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '1100.006']], seeds));
  assert.equal(error.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  assert.equal(error.context.mismatches[0].difference, 0.006);
});

test('单一余额相符：首日取种子，之后取上一日账单余额，逐日通过', () => {
  const { result, calls } = derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-02', 'M001', 'USD', '', '30', '1070'],
    ['2026-09-03', 'M001', 'USD', '5', '', '1075']
  ], [seed('M001', 'USD', '2026-08-31', 1000)]);
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1100],
    ['M001', 'USD', '2026-09-02', 1070],
    ['M001', 'USD', '2026-09-03', 1075]
  ]);
  assert.deepEqual(calls, ['M001@USD@2026-09-01'], '只在每组首日查种子');
  assert.deepEqual(result.confirmedBalanceMismatches, []);
});

test('首日没有种子时要求补录，当天只有一个余额也一样', () => {
  const error = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '9999']], []));
  assert.equal(error.code, 'BALANCE_SEED_REQUIRED');
  assert.equal(error.message, '因首次导入余额，请导入上一个账单日余额用于余额校验');
  assert.equal(error.context.targetBillDate, '2026-09-01');
  assert.equal(error.context.seedMismatch, undefined, '缺种子不是“已有余额对不上”');
});

test('当天没有任何余额：先报未找到期末余额，不要求补录', () => {
  const error = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '']], []));
  assert.equal(error.code, 'FILE_READ');
  assert.equal(error.message, '2026-09-01 未找到期末余额');
});

test('单一余额不符：多组多日一次列全；不一致日以账单余额作为下一日起点', () => {
  const error = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '9999'],
    ['2026-09-02', 'M001', 'USD', '1', '', '10000'],
    ['2026-09-03', 'M001', 'USD', '1', '', '10005'],
    ['2026-09-01', 'M002', 'EUR', '', '20', '480']
  ], [
    seed('M001', 'USD', '2026-08-31', 1000),
    seed('M002', 'EUR', '2026-08-28', 500, '账单里的余额')
  ]));
  assert.equal(error.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  const summary = error.context.mismatches.map((item) => [
    item.merchantId, item.billDate, item.anchorSource, item.anchorDate, item.anchorBalance,
    item.expectedBalance, item.statementBalance, item.difference
  ]);
  // M001：09-01 与种子不符；09-02 以 9999 为起点相符；09-03 以 10000 为起点不符。M002 相符（480 = 500 − 20）。
  assert.deepEqual(summary, [
    ['M001', '2026-09-01', 'seed', '2026-08-31', 1000, 1100, 9999, 8899],
    ['M001', '2026-09-03', 'statement', '2026-09-02', 10000, 10001, 10005, 4]
  ]);
  assert.equal(error.context.mismatches[0].key, 'mismatch|中行-上海|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00');
  assert.equal(error.context.mismatches[0].missingFrom, '');
  assert.equal(error.context.mismatches[0].creditAmount, 100);
  assert.equal(error.context.mismatches[0].debitAmount, 0);
});

test('确认后：按账单余额输出与回写种子，并返回已确认清单；未确认的差异仍要确认', () => {
  const rows = [
    ['2026-09-01', 'M001', 'USD', '100', '', '9999'],
    ['2026-09-02', 'M001', 'USD', '1', '', '10000'],
    ['2026-09-03', 'M001', 'USD', '1', '', '10005']
  ];
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const pending = deriveError(() => derive(rows, seeds)).context.mismatches;

  const partial = deriveError(() => derive(rows, seeds, {
    acknowledgedBalanceMismatchKeys: new Set([pending[0].key])
  }));
  assert.deepEqual(partial.context.mismatches.map((item) => item.billDate), ['2026-09-03']);

  const { result } = derive(rows, seeds, {
    acknowledgedBalanceMismatchKeys: new Set(pending.map((item) => item.key))
  });
  assert.deepEqual(balances(result).map((row) => row[3]), [9999, 10000, 10005]);
  assert.deepEqual(result.seedRecords.map((record) => [record.billDate, record.endBalance, record.generationMethod]), [
    ['2026-09-01', 9999, '账单里的余额'],
    ['2026-09-02', 10000, '账单里的余额'],
    ['2026-09-03', 10005, '账单里的余额']
  ]);
  assert.deepEqual(result.confirmedBalanceMismatches.map((item) => item.billDate), ['2026-09-01', '2026-09-03']);
});

test('确认键随金额变化失效：账单余额改了要重新确认', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const first = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '9999']], seeds)).context.mismatches;
  const changed = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '9998']], seeds, {
    acknowledgedBalanceMismatchKeys: new Set(first.map((item) => item.key))
  }));
  assert.equal(changed.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  assert.equal(changed.context.mismatches[0].statementBalance, 9998);
});

// Codex 审查（2026-11-08）：确认键须绑定上一日余额金额与当日收支合计，明细改了但净额、余额不变时也要重新确认。
test('确认键随收支明细与上一日余额变化失效：净额与账单余额不变也要重新确认', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const first = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '9999']], seeds)).context.mismatches;
  const acknowledged = new Set(first.map((item) => item.key));

  const changedDetail = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '200', '', '9999'],
    ['2026-09-01', 'M001', 'USD', '', '100', '9999']
  ], seeds, { acknowledgedBalanceMismatchKeys: acknowledged }));
  assert.equal(changedDetail.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  assert.deepEqual(
    [changedDetail.context.mismatches[0].creditAmount, changedDetail.context.mismatches[0].debitAmount],
    [200, 100]
  );
  assert.notEqual(changedDetail.context.mismatches[0].key, first[0].key);

  // 种子换成同日不同金额、收入同步调整使预期仍为 1100：上一日余额变了，同样要重新确认。
  const changedSeed = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '50', '', '9999']], [
    seed('M001', 'USD', '2026-08-31', 1050)
  ], { acknowledgedBalanceMismatchKeys: acknowledged }));
  assert.equal(changedSeed.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  assert.equal(changedSeed.context.mismatches[0].expectedBalance, 1100);

  // 完全相同的差异：确认仍然有效。
  const { result } = derive([['2026-09-01', 'M001', 'USD', '100', '', '9999']], seeds, {
    acknowledgedBalanceMismatchKeys: acknowledged
  });
  assert.deepEqual(result.confirmedBalanceMismatches.map((item) => item.key), [first[0].key]);
});

test('断档并入校验：缺的日期无净发生额时直接通过；有缺失交易时进入不一致并写明缺的日期', () => {
  const seeds = [seed('M001', 'USD', '2026-08-28', 1000)];
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-04', 'M001', 'USD', '10', '', '1110']
  ], seeds);
  assert.deepEqual(balances(result).map((row) => row[3]), [1100, 1110]);
  assert.deepEqual(result.skippedBalanceGaps, []);

  const error = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-04', 'M001', 'USD', '10', '', '1500']
  ], seeds));
  assert.equal(error.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  assert.deepEqual(
    error.context.mismatches.map((item) => [item.billDate, item.anchorDate, item.missingFrom, item.missingTo]),
    [['2026-09-04', '2026-09-01', '2026-09-02', '2026-09-03']]
  );
  // 种子到首日之间缺日期且对不上，同样写明缺的日期。
  const seedGap = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '1300']], seeds));
  assert.deepEqual(
    [seedGap.context.mismatches[0].missingFrom, seedGap.context.mismatches[0].missingTo],
    ['2026-08-29', '2026-08-31']
  );
});

test('多候选：相符时选中；首日都不符要求补录；之后的日期都不符报无法推导，均不提供确认', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '50', '', '1050'],
    ['2026-09-01', 'M001', 'USD', '50', '', '1100']
  ], seeds);
  assert.deepEqual(balances(result).map((row) => row[3]), [1100]);

  const firstDay = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '50', '', '1050'],
    ['2026-09-01', 'M001', 'USD', '50', '', '1300']
  ], seeds));
  assert.equal(firstDay.code, 'BALANCE_SEED_REQUIRED');

  const laterDay = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-02', 'M001', 'USD', '50', '', '7777'],
    ['2026-09-02', 'M001', 'USD', '50', '', '8888']
  ], seeds));
  assert.equal(laterDay.code, 'FILE_READ');
  assert.equal(laterDay.message, '银行账号 M001（USD）2026-09-02 的期末余额无法根据收支金额推导');
});

test('之后的日期多个余额都对不上且与上一账单日之间缺日期时，报错写明缺的日期（D13）', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const severalDays = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-04', 'M001', 'USD', '10', '', '1490'],
    ['2026-09-04', 'M001', 'USD', '10', '', '1500']
  ], seeds));
  assert.equal(severalDays.code, 'FILE_READ');
  assert.equal(
    severalDays.message,
    '银行账号 M001（USD）2026-09-04 的期末余额无法根据收支金额推导：上一账单日是 2026-09-01，'
      + '中间缺 2026-09-02 ~ 2026-09-03，请核对导入的账单是否漏了这几天的交易'
  );

  const oneDay = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-03', 'M001', 'USD', '10', '', '1490'],
    ['2026-09-03', 'M001', 'USD', '10', '', '1500']
  ], seeds));
  assert.equal(
    oneDay.message,
    '银行账号 M001（USD）2026-09-03 的期末余额无法根据收支金额推导：上一账单日是 2026-09-01，'
      + '中间缺 2026-09-02，请核对导入的账单是否漏了这天的交易'
  );

  const noCurrency = deriveError(() => derive([
    ['2026-09-01', 'M001', '', '100', '', '1100'],
    ['2026-09-02', 'M001', '', '10', '', '1490'],
    ['2026-09-02', 'M001', '', '10', '', '1500']
  ], [seed('M001', '', '2026-08-31', 1000)]));
  assert.equal(noCurrency.message, '银行账号 M001 2026-09-02 的期末余额无法根据收支金额推导');
});

test('多候选只有支出、按“+支出”才能对上时不再匹配', () => {
  const error = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '', '100', '999'],
    ['2026-09-01', 'M001', 'USD', '', '0.01', '1100.01']
  ], [seed('M001', 'USD', '2026-08-31', 1000)]));
  assert.equal(error.code, 'BALANCE_SEED_REQUIRED');
});

// 用户反馈（KBANK-VN，v3.2.15）：上一账单日余额误填 0 后，首日两笔余额都对不上，原来只回到同一个补录提示，
// 用户看不出是填错了（弹窗像关不掉），且错的种子已落盘，重启后仍反复提示。D7 调整：提示写明已有余额对不上。
// 金额为合成数据，只保留反馈账单的结构（首日两笔支出、两个余额，次日一笔收入）。
const KBANK_ROWS = [
  ['2026-10-01', 'M001', 'VND', '0', '200000', '800000'],
  ['2026-10-01', 'M001', 'VND', '0', '1500', '798500'],
  ['2026-10-12', 'M001', 'VND', '300000', '0', '1098500']
];

test('多候选首日都对不上且已有种子：仍要求补录，但写明已有余额、当日收支与账单当日余额；填对后正常生成', () => {
  const wrong = deriveError(() => derive(KBANK_ROWS, [seed('M001', 'VND', '2026-09-30', 0)]));
  assert.equal(wrong.code, 'BALANCE_SEED_REQUIRED');
  assert.equal(wrong.message, '上一账单日余额与账单对不上，请核对后重新补录');
  assert.equal(wrong.context.targetBillDate, '2026-10-01');
  assert.equal(wrong.context.merchantId, 'M001');
  assert.equal(wrong.context.currency, 'VND');
  assert.deepEqual(wrong.context.seedMismatch, {
    seedDate: '2026-09-30',
    seedBalance: 0,
    seedGenerationMethod: '人工录入',
    anchorBalance: 0,
    billDate: '2026-10-01',
    creditAmount: 0,
    debitAmount: 201500,
    expectedBalance: -201500,
    statementBalances: [800000, 798500]
  });

  // 填账单上的期初余额后：首日选中 798,500，次日接着校验通过。
  const { result } = derive(KBANK_ROWS, [seed('M001', 'VND', '2026-09-30', 1000000)]);
  assert.deepEqual(balances(result), [
    ['M001', 'VND', '2026-10-01', 798500],
    ['M001', 'VND', '2026-10-12', 1098500]
  ]);

  // 生成的种子含余额附加值：列出种子原值与扣回附加值后的计算起点。
  const adjusted = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '50', '', '1050'],
    ['2026-09-01', 'M001', 'USD', '50', '', '1300']
  ], [seed('M001', 'USD', '2026-08-31', 1010, '账单里的余额')], {
    balanceAdjustments: [{ merchantId: 'M001', currency: 'USD', effectiveDate: '2026-08-01', adjustmentValue: 10 }]
  }));
  assert.equal(adjusted.code, 'BALANCE_SEED_REQUIRED');
  assert.deepEqual(
    [adjusted.context.seedMismatch.seedBalance, adjusted.context.seedMismatch.anchorBalance,
      adjusted.context.seedMismatch.seedGenerationMethod, adjusted.context.seedMismatch.expectedBalance,
      adjusted.context.seedMismatch.statementBalances],
    [1010, 1000, '账单里的余额', 1100, [1050, 1300]]
  );
});

test('余额附加值：校验按账单原值链，生成种子先扣回附加值；输出仍叠加附加值', () => {
  const adjustment = { merchantId: 'M001', currency: 'USD', effectiveDate: '2026-08-01', adjustmentValue: 10 };
  // 上次导入回写的“账单里的余额”种子 1010 = 原值 1000 + 附加值 10。
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
    ['2026-09-02', 'M001', 'USD', '', '50', '1050']
  ], [seed('M001', 'USD', '2026-08-31', 1010, '账单里的余额')], { balanceAdjustments: [adjustment] });
  assert.deepEqual(balances(result).map((row) => row[3]), [1110, 1060]);

  const error = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '1110']], [
    seed('M001', 'USD', '2026-08-31', 1010, '账单里的余额')
  ], { balanceAdjustments: [adjustment] }));
  assert.equal(error.context.mismatches[0].anchorBalance, 1000);
  assert.equal(error.context.mismatches[0].expectedBalance, 1100);
  assert.equal(error.context.mismatches[0].statementBalance, 1110);
});

test('通过发生额计算：不读账单余额，输出与提示不变', () => {
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '100', '', '9999']
  ], [seed('M001', 'USD', '2026-08-31', 1000)], { mode: 'calculated' });
  assert.deepEqual(balances(result).map((row) => row[3]), [1100]);
  assert.deepEqual(result.confirmedBalanceMismatches, []);
});

function mismatchPrompt() {
  return {
    reason: 'mismatch',
    templateName: TEMPLATE_NAME,
    merchantId: 'M001',
    currency: 'USD',
    targetBillDate: '2026-09-01',
    mismatches: [
      { key: 'mismatch|中行-上海|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00', merchantId: 'M001', billDate: '2026-09-01' },
      { key: 'mismatch|中行-上海|M002|EUR|2026-09-01|2026-08-31|500.00|0.00|20.00|470.00', merchantId: 'M002', billDate: '2026-09-01' }
    ]
  };
}

function prepare(payload, pendingPrompt = mismatchPrompt()) {
  const guardCalls = [];
  const resolution = prepareManualBalanceSeedSubmission({
    payload,
    pendingPrompt,
    importContext: { scope: 'current' },
    session: null,
    createContextId: () => 'unused',
    createFreshnessGuard: (input) => {
      guardCalls.push(input);
      return { inputFilePaths: ['/tmp/source.xlsx'], assertFresh() {} };
    }
  });
  return { resolution, guardCalls };
}

test('确认继续：只接受当前 prompt 列出的不一致，不生成种子写入计划；不一致 prompt 不接受人工补录', () => {
  const keys = mismatchPrompt().mismatches.map((item) => item.key);
  const { resolution, guardCalls } = prepare({ confirmBalanceMismatchKeys: [keys[1], keys[0], keys[1]] });
  assert.equal(resolution.prepared.proceed, true);
  assert.equal(resolution.prepared.plan, null);
  assert.deepEqual(resolution.prepared.confirmBalanceMismatchKeys, [keys[1], keys[0]]);
  assert.deepEqual(resolution.prepared.confirmedBalanceMismatches.map((item) => item.merchantId), ['M002', 'M001']);
  assert.deepEqual(resolution.prepared.inputPaths, ['/tmp/source.xlsx']);
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].plan, null);

  for (const payload of [
    { confirmBalanceMismatchKeys: [] },
    { confirmBalanceMismatchKeys: ['mismatch|中行-上海|M009|USD|2026-09-01|2026-08-31|1.00|0.00|0.00|2.00'] },
    { confirmBalanceMismatchKeys: 'not-array' }
  ]) {
    const invalid = prepare(payload).resolution.prepared;
    assert.equal(invalid.proceed, false);
    assert.equal(invalid.result.errorCode, 'BALANCE_MISMATCH_CONFIRMATION_INVALID');
  }
  const gapPrompt = prepare(
    { confirmBalanceMismatchKeys: [keys[0]] },
    { reason: 'gap', templateName: TEMPLATE_NAME, gaps: [{ key: keys[0] }] }
  ).resolution.prepared;
  assert.equal(gapPrompt.proceed, false);
  assert.equal(gapPrompt.result.errorCode, 'BALANCE_MISMATCH_CONFIRMATION_INVALID');

  const manual = prepare({ billDate: '2026-08-31', endBalance: '1000' }).resolution.prepared;
  assert.equal(manual.proceed, false);
  assert.equal(manual.result.errorCode, 'BALANCE_MISMATCH_CONFIRMATION_INVALID');
});

const SAMPLE_MISMATCH = {
  key: 'mismatch|中行-上海|M001|USD|2026-09-04|2026-09-01|1100.00|10.00|0.00|1500.00',
  templateName: TEMPLATE_NAME,
  bankName: '中行',
  merchantId: 'M001',
  currency: 'USD',
  billDate: '2026-09-04',
  anchorDate: '2026-09-01',
  anchorSource: 'statement',
  anchorBalance: 1100,
  creditAmount: 10,
  debitAmount: 0,
  expectedBalance: 1110,
  statementBalance: 1500,
  difference: 390,
  missingFrom: '2026-09-02',
  missingTo: '2026-09-03'
};
const SAMPLE_LINE = '银行账号：M001，币种：USD，账单日期：2026-09-04，上一日余额：1,100.00（上一账单日 2026-09-01），'
  + '收入：10.00，支出：0.00，预期余额：1,110.00，账单余额：1,500.00，差额：+390.00，中间缺 2026-09-02 ~ 2026-09-03';

test('主进程：不一致确认结果、确认后的告警摘要与明细', () => {
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatBalanceMismatchLine = loadMainFunction(
    'formatBalanceMismatchLine', ['formatBalanceAmount'], [formatBalanceAmount]
  );
  assert.equal(formatBalanceMismatchLine(SAMPLE_MISMATCH), SAMPLE_LINE);
  assert.equal(
    formatBalanceMismatchLine({ ...SAMPLE_MISMATCH, anchorSource: 'seed', anchorDate: '2026-08-31', difference: -0.5, missingFrom: '', missingTo: '' }),
    '银行账号：M001，币种：USD，账单日期：2026-09-04，上一日余额：1,100.00（余额种子 2026-08-31），'
      + '收入：10.00，支出：0.00，预期余额：1,110.00，账单余额：1,500.00，差额：-0.50'
  );

  const logs = [];
  const buildBalanceMismatchConfirmResult = loadMainFunction(
    'buildBalanceMismatchConfirmResult',
    ['clearLastErrorReport', 'lastPendingBalanceSeedConfirmation', 'lastManualBalancePrompt', 'appendActivityLogEntry', 'formatBalanceMismatchLine'],
    [() => {}, null, null, (entry) => logs.push(entry), formatBalanceMismatchLine]
  );
  const result = buildBalanceMismatchConfirmResult([SAMPLE_MISMATCH], { detail: { filePath: '/tmp/detail.xlsx' } });
  assert.equal(result.status, 'manual-balance-required');
  assert.equal(result.message, '账单余额校验不一致（1 处），请核查或确认按账单余额生成');
  assert.equal(result.detailReady, true);
  assert.equal(result.balanceReady, false);
  assert.equal(result.manualBalancePromptReady, true);
  assert.equal(result.manualBalancePrompt.reason, 'mismatch');
  assert.equal(result.manualBalancePrompt.targetBillDate, '2026-09-04');
  assert.deepEqual(result.manualBalancePrompt.mismatches, [SAMPLE_MISMATCH]);
  assert.deepEqual(logs[0].details, [`模板名：${TEMPLATE_NAME}`, SAMPLE_LINE]);

  const buildImportWarningMessage = loadMainFunction('buildImportWarningMessage');
  const buildImportWarningDetailLines = loadMainFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine', 'formatBalanceMismatchLine'],
    [() => '', formatBalanceMismatchLine]
  );
  const warnings = [{ type: 'balance-mismatch-confirmed', mismatches: [SAMPLE_MISMATCH, SAMPLE_MISMATCH] }];
  assert.equal(
    buildImportWarningMessage({ warnings, balanceReady: true, balanceRequested: true }),
    '明细账单可导出，余额账单可导出，2处余额校验不一致，已按账单余额生成，请点击状态框导出报错文件'
  );
  assert.deepEqual(buildImportWarningDetailLines(warnings), [
    '以下账单余额与「上一日余额 + 当日收入 − 当日支出」不一致，已确认按账单余额生成，请核查是否漏单、重复或种子有误：',
    SAMPLE_LINE,
    SAMPLE_LINE
  ]);
});

function writeSourceWorkbook(root, fileName, rows) {
  const filePath = path.join(root, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function createGenerationSeam(storageRoot, { acknowledgedKeys = new Set(), mismatchResults = [], replaceResults = [], overrides = {} } = {}) {
  const ensureStorageRoot = () => {
    fs.mkdirSync(storageRoot, { recursive: true });
    return storageRoot;
  };
  const pad = loadMainFunction('pad');
  const getToday = loadMainFunction('getToday', ['pad'], [pad]);
  const sanitizeFileName = loadMainFunction('sanitizeFileName');
  const storeGeneratedBalanceSeeds = loadMainFunction(
    'storeGeneratedBalanceSeeds',
    ['ensureStorageRoot', 'upsertBalanceSeedRecord'],
    [ensureStorageRoot, upsertBalanceSeedRecord]
  );
  const buildOutputFilePath = loadMainFunction(
    'buildOutputFilePath',
    ['getToday', 'path', 'ensureStorageRoot', 'sanitizeFileName'],
    [getToday, path, ensureStorageRoot, sanitizeFileName]
  );
  const buildStatementOutputFilePath = loadMainFunction(
    'buildStatementOutputFilePath',
    ['getToday', 'buildOutputFilePath'],
    [getToday, buildOutputFilePath]
  );
  return createStatementGenerationHelpers({
    appendLog: () => {
      throw new Error('余额校验用例不应进入系统异常日志分支');
    },
    buildBalanceGapConfirmResult: () => {
      throw new Error('账单里的余额不应进入断档确认');
    },
    buildBalanceMismatchConfirmResult: (mismatches, generatedFiles) => {
      mismatchResults.push({ mismatches, generatedFiles });
      return { status: 'manual-balance-required', mismatchCount: mismatches.length };
    },
    buildBalanceSeedReplaceConfirmResult: (replacements, generatedFiles) => {
      replaceResults.push({ replacements, generatedFiles });
      return { status: 'manual-balance-required', replaceCount: replacements.length };
    },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath,
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    getAcknowledgedBalanceGapKeys: () => acknowledgedKeys,
    getBalanceTemplatePath: () => path.join(ROOT, 'assets', '余额账单模版.xlsx'),
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    parseRequiredBillDates,
    readBalanceAdjustments,
    readBalanceSeedRecords,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanStatementBalanceSeedStatus(input, ensureStorageRoot()),
    splitTemplateName,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows,
    ...overrides
  });
}

function prepareStatementBatch(root, generation) {
  const filePath = writeSourceWorkbook(root, 'statement.xlsx', [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'],
    ['2026-09-01', 'M001', 'USD', '100', '', '9999'],
    ['2026-09-02', 'M001', 'USD', '1', '', '10000']
  ]);
  const rows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit',
      Balance: 'Balance'
    }
  });
  const config = {
    template: { name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: [{ filePath, detailRows: rows }]
  });
  return { config, preparedBatch, filePath };
}

function seedManual(storageRoot) {
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD',
    billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
  });
}

test('生成层：未确认时只出明细，不写余额表和种子，结果交给余额不一致确认', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const mismatchResults = [];
  const generation = createGenerationSeam(storageRoot, { mismatchResults });
  seedManual(storageRoot);
  const { config, preparedBatch, filePath } = prepareStatementBatch(root, generation);
  const generated = generation.generateStatementFiles({ config, preparedBatch });
  assert.ok(generated.detail && fs.existsSync(generated.detail.filePath));
  assert.equal(generated.balance, null);
  assert.deepEqual(generated.warnings.map((warning) => warning.type), ['balance-mismatch-confirm']);
  assert.equal(generated.warnings[0].mismatches[0].key, 'mismatch|中行-上海|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00');
  assert.deepEqual(readBalanceSeedRecords(storageRoot, '中行').map((record) => record.billDate), ['2026-08-31']);

  const importResult = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: generated,
    templateId: 1,
    templateName: TEMPLATE_NAME,
    inputFilePaths: [filePath]
  });
  assert.deepEqual(importResult, { status: 'manual-balance-required', mismatchCount: 1 });
  assert.equal(mismatchResults[0].mismatches[0].billDate, '2026-09-01');
});

test('生成层：确认后按账单余额生成余额表、回写种子，并带上已确认告警', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const generation = createGenerationSeam(storageRoot, {
    acknowledgedKeys: new Set(['mismatch|中行-上海|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00'])
  });
  seedManual(storageRoot);
  const { config, preparedBatch } = prepareStatementBatch(root, generation);
  const generated = generation.generateStatementFiles({ config, preparedBatch });
  assert.ok(generated.balance && fs.existsSync(generated.balance.filePath));
  assert.deepEqual(generated.warnings.map((warning) => warning.type), ['balance-mismatch-confirmed']);
  assert.equal(generated.warnings[0].mismatches.length, 1);
  const workbook = XLSX.readFile(generated.balance.filePath, { raw: true });
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const balanceIndex = sheetRows[0].indexOf('期末余额');
  assert.deepEqual(sheetRows.slice(1).map((row) => row[balanceIndex]), [9999, 10000]);
  assert.deepEqual(
    readBalanceSeedRecords(storageRoot, '中行').map((record) => [record.billDate, record.endBalance, record.generationMethod]),
    [['2026-08-31', 1000, '人工录入'], ['2026-09-01', 9999, '账单里的余额'], ['2026-09-02', 10000, '账单里的余额']]
  );
});

const KBANK_SEED_MISMATCH = {
  seedDate: '2026-09-30',
  seedBalance: 0,
  seedGenerationMethod: '人工录入',
  anchorBalance: 0,
  billDate: '2026-10-01',
  creditAmount: 0,
  debitAmount: 201500,
  expectedBalance: -201500,
  statementBalances: [800000, 798500]
};

test('生成层：已有种子但首日对不上时只出明细，补录提示带上对不上的明细；不写余额表和种子', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const generation = createGenerationSeam(storageRoot);
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'VND',
    billDate: '2026-09-30', endBalance: 0, generationMethod: '人工录入'
  });
  const filePath = writeSourceWorkbook(root, 'kbank.xlsx', [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'],
    ...KBANK_ROWS
  ]);
  const detailRows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
    }
  });
  const config = {
    template: { name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  const generated = generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath, detailRows }] })
  });
  assert.ok(generated.detail && fs.existsSync(generated.detail.filePath));
  assert.equal(generated.balance, null);
  assert.deepEqual(generated.warnings.map((warning) => warning.type), ['balance-seed-required']);
  assert.equal(generated.warnings[0].message, '上一账单日余额与账单对不上，请核对后重新补录');
  assert.deepEqual(generated.warnings[0].prompt, {
    templateName: TEMPLATE_NAME,
    bankName: '中行',
    merchantId: 'M001',
    currency: 'VND',
    targetBillDate: '2026-10-01',
    queueIndex: 1,
    queueTotal: 1,
    seedMismatch: KBANK_SEED_MISMATCH
  });
  assert.deepEqual(
    readBalanceSeedRecords(storageRoot, '中行').map((record) => [record.billDate, record.endBalance]),
    [['2026-09-30', 0]],
    '对不上时不回写生成种子'
  );

  // 改成账单期初余额后重新生成：余额表与回写种子按账单余额。
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'VND',
    billDate: '2026-09-30', endBalance: 1000000, generationMethod: '人工录入', overwrite: true
  });
  const regenerated = generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath, detailRows }] })
  });
  assert.deepEqual(regenerated.warnings, []);
  const workbook = XLSX.readFile(regenerated.balance.filePath, { raw: true });
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const balanceIndex = sheetRows[0].indexOf('期末余额');
  assert.deepEqual(sheetRows.slice(1).map((row) => row[balanceIndex]), [798500, 1098500]);
});

test('主进程：已有余额对不上时补录提示与日志写明原因；缺种子时文案不变', () => {
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatBalanceSeedMismatchLine = loadMainFunction(
    'formatBalanceSeedMismatchLine', ['formatBalanceAmount'], [formatBalanceAmount]
  );
  const expectedLine = '已有 2026-09-30 余额 0.00（人工录入）；2026-10-01：上一日余额 0.00 + 收入 0.00 − 支出 201,500.00'
    + ' = 预期 -201,500.00，账单当日余额 800,000.00、798,500.00 都对不上';
  assert.equal(formatBalanceSeedMismatchLine(KBANK_SEED_MISMATCH), expectedLine);

  const logs = [];
  const buildManualBalanceRequiredResult = loadMainFunction(
    'buildManualBalanceRequiredResult',
    ['clearLastErrorReport', 'lastPendingBalanceSeedConfirmation', 'lastManualBalancePrompt', 'appendActivityLogEntry', 'formatBalanceSeedMismatchLine'],
    [() => {}, null, null, (entry) => logs.push(entry), formatBalanceSeedMismatchLine]
  );
  const basePrompt = {
    templateName: TEMPLATE_NAME, bankName: '中行', merchantId: 'M001', currency: 'VND',
    targetBillDate: '2026-10-01', queueIndex: 1, queueTotal: 1
  };
  const mismatchResult = buildManualBalanceRequiredResult(
    { ...basePrompt, seedMismatch: KBANK_SEED_MISMATCH },
    { detail: { filePath: '/tmp/detail.xlsx' } }
  );
  assert.equal(mismatchResult.status, 'manual-balance-required');
  assert.equal(mismatchResult.message, '上一账单日余额与账单对不上，请核对后重新补录');
  assert.equal(mismatchResult.manualBalancePromptReady, true);
  assert.deepEqual(mismatchResult.manualBalancePrompt.seedMismatch, KBANK_SEED_MISMATCH);
  assert.equal(logs[0].message, '上一账单日余额与账单对不上，等待重新补录');
  assert.equal(logs[0].details.at(-1), expectedLine);

  const missingResult = buildManualBalanceRequiredResult(basePrompt, {});
  assert.equal(missingResult.message, '因首次导入余额，请导入上一个账单日余额用于余额校验');
  assert.equal(missingResult.manualBalancePrompt.seedMismatch, undefined);
  assert.equal(logs[1].message, '等待补录上一账单日余额');
  assert.equal(logs[1].details.length, 4);
});

// ---------------------------------------------------------------------------
// ⚠️ 资金红线：确认继续后按账单余额回写种子（spec D6、§6）。
// 以下用例走真实生成链路：真实 xlsx 映射 → 生成层 → 真实余额表写出 → 主进程真实 storeGeneratedBalanceSeeds
// → 真实种子文件（balance-seeds/中行.json），逐项证明回写的口径与边界。
// ---------------------------------------------------------------------------

function generateRows(generation, root, fileName, rows) {
  const filePath = writeSourceWorkbook(root, fileName, [['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'], ...rows]);
  const detailRows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
    }
  });
  const config = {
    template: { name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  return generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath, detailRows }] })
  });
}

function writeManualSeed(storageRoot, merchantId, currency, billDate, endBalance) {
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId, currency, billDate, endBalance, generationMethod: '人工录入', overwrite: true
  });
}

function seedRows(storageRoot) {
  return readBalanceSeedRecords(storageRoot, '中行')
    .map((record) => [record.merchantId, record.currency, record.billDate, record.endBalance, record.generationMethod]);
}

function balanceSheetRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const header = rows[0];
  const index = (name) => header.indexOf(name);
  return rows.slice(1).map((row) => {
    const { y, m, d } = XLSX.SSF.parse_date_code(row[index('账单日期')]);
    return [
      row[index('银行账号')],
      row[index('币种')],
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      row[index('期末余额')]
    ];
  });
}

function pendingMismatches(generated) {
  return generated.warnings
    .filter((warning) => warning.type === 'balance-mismatch-confirm')
    .flatMap((warning) => warning.mismatches);
}

function writebackFixture(t, options = {}) {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const acknowledgedKeys = new Set();
  const generation = createGenerationSeam(storageRoot, { acknowledgedKeys, ...options });
  return { root, storageRoot, acknowledgedKeys, generation };
}

test('红线-回写1：确认前一条种子都不写（同模板里校验通过的账户也不写）；确认后余额表与回写种子逐日一致，均为账单余额，人工种子保留', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeManualSeed(storageRoot, 'M002', 'EUR', '2026-08-31', 500);
  const rows = [
    ['2026-09-01', 'M001', 'USD', '100', '', '9999'],
    ['2026-09-02', 'M001', 'USD', '1', '', '10000'],
    ['2026-09-01', 'M002', 'EUR', '', '20', '480']
  ];
  const manualOnly = [
    ['M001', 'USD', '2026-08-31', 1000, '人工录入'],
    ['M002', 'EUR', '2026-08-31', 500, '人工录入']
  ];

  const before = generateRows(generation, root, 'writeback.xlsx', rows);
  assert.equal(before.balance, null, '未确认时不出余额表');
  assert.deepEqual(pendingMismatches(before).map((item) => [item.merchantId, item.billDate]), [['M001', '2026-09-01']]);
  assert.deepEqual(seedRows(storageRoot), manualOnly, '未确认时一条生成种子都不写，M002 校验通过也不写');

  pendingMismatches(before).forEach((item) => acknowledgedKeys.add(item.key));
  const after = generateRows(generation, root, 'writeback.xlsx', rows);
  const output = balanceSheetRows(after.balance.filePath);
  assert.deepEqual(output, [
    ['M001', 'USD', '2026-09-01', 9999],
    ['M001', 'USD', '2026-09-02', 10000],
    ['M002', 'EUR', '2026-09-01', 480]
  ], '余额表按账单余额输出');
  assert.deepEqual(seedRows(storageRoot), [
    ['M001', 'USD', '2026-08-31', 1000, '人工录入'],
    ['M001', 'USD', '2026-09-01', 9999, '账单里的余额'],
    ['M001', 'USD', '2026-09-02', 10000, '账单里的余额'],
    ['M002', 'EUR', '2026-08-31', 500, '人工录入'],
    ['M002', 'EUR', '2026-09-01', 480, '账单里的余额']
  ], '回写种子 = 账单余额，人工种子不动');
  assert.deepEqual(
    seedRows(storageRoot).filter((row) => row[4] === '账单里的余额').map((row) => row.slice(0, 4)),
    output,
    '回写种子与余额表逐行一致，不多不少'
  );
  assert.deepEqual(after.warnings.map((warning) => [warning.type, warning.mismatches.length]), [['balance-mismatch-confirmed', 1]],
    '确认后的回写带告警留痕');
});

test('红线-回写2：只确认了部分差异时，余额表与种子都不写', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeManualSeed(storageRoot, 'M002', 'EUR', '2026-08-31', 500);
  const rows = [
    ['2026-09-01', 'M001', 'USD', '100', '', '9999'],
    ['2026-09-01', 'M002', 'EUR', '', '20', '470']
  ];
  const first = pendingMismatches(generateRows(generation, root, 'partial.xlsx', rows));
  assert.equal(first.length, 2);
  acknowledgedKeys.add(first.find((item) => item.merchantId === 'M001').key);

  const partial = generateRows(generation, root, 'partial.xlsx', rows);
  assert.equal(partial.balance, null);
  assert.deepEqual(pendingMismatches(partial).map((item) => item.merchantId), ['M002']);
  assert.deepEqual(seedRows(storageRoot).map((row) => row[4]), ['人工录入', '人工录入'], '仍有未确认差异时不回写任何种子');
});

test('红线-回写3：下一次导入以确认后回写的账单余额为起点；新的差异照常提示，旧确认不外溢', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  const firstRows = [['2026-09-01', 'M001', 'USD', '100', '', '9999']];
  pendingMismatches(generateRows(generation, root, 'first.xlsx', firstRows)).forEach((item) => acknowledgedKeys.add(item.key));
  assert.ok(generateRows(generation, root, 'first.xlsx', firstRows).balance);

  // 09-02 收入 1：以回写的 9999 为起点，10000 相符，无提示。
  const second = generateRows(generation, root, 'second.xlsx', [['2026-09-02', 'M001', 'USD', '1', '', '10000']]);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(balanceSheetRows(second.balance.filePath), [['M001', 'USD', '2026-09-02', 10000]]);

  // 09-03 余额多了 499：确认集合里仍有 09-01 的旧键，但新的差异照常提示，不写种子。
  const third = generateRows(generation, root, 'third.xlsx', [['2026-09-03', 'M001', 'USD', '1', '', '10500']]);
  assert.equal(third.balance, null);
  assert.deepEqual(pendingMismatches(third).map((item) => [item.billDate, item.anchorSource, item.anchorDate, item.anchorBalance, item.expectedBalance]), [
    ['2026-09-03', 'seed', '2026-09-02', 10000, 10001]
  ]);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3]]), [
    ['2026-08-31', 1000], ['2026-09-01', 9999], ['2026-09-02', 10000]
  ]);
});

test('红线-回写4：修正账单后重新导入同一天，以更早的种子为起点校验，不拿本日已回写的值自证；通过后覆盖回写', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  const wrongRows = [['2026-09-01', 'M001', 'USD', '100', '', '9999']];
  pendingMismatches(generateRows(generation, root, 'wrong.xlsx', wrongRows)).forEach((item) => acknowledgedKeys.add(item.key));
  generateRows(generation, root, 'wrong.xlsx', wrongRows);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3]]), [['2026-08-31', 1000], ['2026-09-01', 9999]]);

  // 原账单余额 9999 是错的，修正为 1100 后重新导入：起点仍是 08-31 的 1000，不是 09-01 自己回写的 9999。
  const corrected = generateRows(generation, root, 'corrected.xlsx', [['2026-09-01', 'M001', 'USD', '100', '', '1100']]);
  assert.deepEqual(corrected.warnings, []);
  assert.deepEqual(balanceSheetRows(corrected.balance.filePath), [['M001', 'USD', '2026-09-01', 1100]]);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3], row[4]]), [
    ['2026-08-31', 1000, '人工录入'], ['2026-09-01', 1100, '账单里的余额']
  ], '修正后覆盖之前确认回写的 9999');
});

test('红线-回写5：带余额附加值时，回写种子含附加值；下一次导入先扣回再校验，附加值不重复叠加', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeBalanceAdjustments(storageRoot, '中行', [
    { merchantId: 'M001', currency: 'USD', effectiveDate: '2026-09-01', adjustmentValue: 10, templateName: TEMPLATE_NAME }
  ]);
  const firstRows = [['2026-09-01', 'M001', 'USD', '100', '', '9999']];
  const pending = pendingMismatches(generateRows(generation, root, 'adjust-1.xlsx', firstRows));
  // 弹窗展示的是账单原值口径（不含附加值）。
  assert.deepEqual(pending.map((item) => [item.anchorBalance, item.expectedBalance, item.statementBalance]), [[1000, 1100, 9999]]);
  pending.forEach((item) => acknowledgedKeys.add(item.key));
  const first = generateRows(generation, root, 'adjust-1.xlsx', firstRows);
  assert.deepEqual(balanceSheetRows(first.balance.filePath), [['M001', 'USD', '2026-09-01', 10009]], '输出 = 账单余额 + 附加值');

  const second = generateRows(generation, root, 'adjust-2.xlsx', [['2026-09-02', 'M001', 'USD', '1', '', '10000']]);
  assert.deepEqual(second.warnings, [], '起点 10009 扣回附加值 10 = 9999，+1 = 10000 相符');
  assert.deepEqual(balanceSheetRows(second.balance.filePath), [['M001', 'USD', '2026-09-02', 10010]]);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3]]), [
    ['2026-08-31', 1000], ['2026-09-01', 10009], ['2026-09-02', 10010]
  ]);
});

test('红线-回写6：负余额与高精度余额确认后，余额表与种子保持符号和原精度', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', -50);
  const rows = [['2026-09-01', 'M001', 'USD', '10', '', '-100.123456']];
  const pending = pendingMismatches(generateRows(generation, root, 'negative.xlsx', rows));
  assert.deepEqual(pending.map((item) => [item.expectedBalance, item.statementBalance, item.difference]), [[-40, -100.123456, -60.123456]]);
  pending.forEach((item) => acknowledgedKeys.add(item.key));
  const generated = generateRows(generation, root, 'negative.xlsx', rows);
  assert.deepEqual(balanceSheetRows(generated.balance.filePath), [['M001', 'USD', '2026-09-01', -100.123456]]);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3]]), [['2026-08-31', -50], ['2026-09-01', -100.123456]]);
});

function pendingReplacements(generated) {
  return generated.warnings
    .filter((warning) => warning.type === 'balance-seed-replace-confirm')
    .flatMap((warning) => warning.replacements);
}

// v3.2.16（用户 2026-11-08）：同一账单日已有人工补录种子、且与账单日终余额不一致时，替换前须确认；提醒列出两个值。
test('红线-回写7：同一账单日人工补录与账单余额不一致时先提醒（列出两个值）；返回核查不写，确认替换后才覆盖', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 5000);
  const rows = [['2026-09-01', 'M001', 'USD', '100', '', '1100']];
  const manualOnly = [['2026-08-31', 1000, '人工录入'], ['2026-09-01', 5000, '人工录入']];

  // 账单 1100 与上一日余额相符（校验以 08-31 为起点，不拿 09-01 的人工补录比对），但与 09-01 人工补录 5000 不一致。
  const first = generateRows(generation, root, 'replace.xlsx', rows);
  assert.equal(first.balance, null, '未确认替换时不出余额表');
  assert.deepEqual(pendingReplacements(first).map((item) => [
    item.merchantId, item.billDate, item.balanceSource, item.manualBalance, item.balance, item.difference
  ]), [['M001', '2026-09-01', 'statement', 5000, 1100, -3900]]);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3], row[4]]), manualOnly, '返回核查（不确认）时人工补录不被覆盖');

  pendingReplacements(first).forEach((item) => acknowledgedKeys.add(item.key));
  const replaced = generateRows(generation, root, 'replace.xlsx', rows);
  assert.deepEqual(balanceSheetRows(replaced.balance.filePath), [['M001', 'USD', '2026-09-01', 1100]]);
  assert.deepEqual(replaced.warnings.map((warning) => warning.type), ['balance-seed-replace-confirmed']);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3], row[4]]), [
    ['2026-08-31', 1000, '人工录入'], ['2026-09-01', 1100, '账单里的余额']
  ], '确认替换后按账单余额覆盖人工补录');
});

test('红线-回写8：余额不一致与人工补录替换先后确认，两步都确认后才回写', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 5000);
  const rows = [['2026-09-01', 'M001', 'USD', '100', '', '9999']];

  const first = generateRows(generation, root, 'both.xlsx', rows);
  assert.deepEqual(first.warnings.map((warning) => warning.type), ['balance-mismatch-confirm'], '先确认余额不一致');
  pendingMismatches(first).forEach((item) => acknowledgedKeys.add(item.key));

  const second = generateRows(generation, root, 'both.xlsx', rows);
  assert.equal(second.balance, null);
  assert.deepEqual(pendingReplacements(second).map((item) => [item.manualBalance, item.balance]), [[5000, 9999]], '再确认替换人工补录');
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3]]), [['2026-08-31', 1000], ['2026-09-01', 5000]]);

  pendingReplacements(second).forEach((item) => acknowledgedKeys.add(item.key));
  const third = generateRows(generation, root, 'both.xlsx', rows);
  assert.deepEqual(third.warnings.map((warning) => warning.type), ['balance-mismatch-confirmed', 'balance-seed-replace-confirmed']);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3], row[4]]), [
    ['2026-08-31', 1000, '人工录入'], ['2026-09-01', 9999, '账单里的余额']
  ]);
});

test('红线-回写9：同日人工补录与账单余额相符（按分）时不提醒，直接按账单余额回写', (t) => {
  const { root, storageRoot, generation } = writebackFixture(t);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 1100.004);
  const generated = generateRows(generation, root, 'same.xlsx', [['2026-09-01', 'M001', 'USD', '100', '', '1100']]);
  assert.deepEqual(generated.warnings, []);
  assert.deepEqual(seedRows(storageRoot).map((row) => [row[2], row[3], row[4]]), [
    ['2026-08-31', 1000, '人工录入'], ['2026-09-01', 1100, '账单里的余额']
  ]);
});

// v3.2.16 Codex 审查 P1（两轮）：同一银行前缀的模板（中行-A、中行-B、中行-C）共用余额种子。工具按同值回写会把
// 人工补录改成工具生成；之后不论处理顺序、同批还是分批、补录或改值发生在何时，与该日余额不同的回写都要先确认替换。
// 生成层记下本次运行里见过的人工补录（同一个 helpers 实例 = 同一次运行），替换检查按它比对。
function generateTemplateRows(generation, root, templateName, rows) {
  // 源文件名去掉 Windows 不允许的字符（模板名可含 “:” 等，见红线-回写14）。
  const sourceFileName = `${templateName.replace(/[<>:"/\\|?*\s]/g, '_')}.xlsx`;
  const filePath = writeSourceWorkbook(root, sourceFileName, [['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'], ...rows]);
  const detailRows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
    }
  });
  const config = {
    template: { name: templateName },
    mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
    balanceRequested: true,
    balanceMode: 'statement'
  };
  return generation.generateStatementFiles({
    config,
    preparedBatch: generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [{ filePath, detailRows }] })
  });
}

function sharedSeedFixture(t, { manualSeeds = [['2026-08-31', 1000], ['2026-09-01', 5000]] } = {}) {
  const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
  manualSeeds.forEach(([billDate, endBalance]) => writeManualSeed(storageRoot, 'M001', 'USD', billDate, endBalance));
  const rowsByTemplate = {
    '中行-A': [['2026-09-01', 'M001', 'USD', '4000', '', '5000']],
    '中行-B': [['2026-09-01', 'M001', 'USD', '100', '', '1100']],
    '中行-C': [['2026-09-02', 'M001', 'USD', '100', '', '5100']]
  };
  // 依次生成各模板组：同批的多组与分批导入在生成层都是先后调用。
  const runBatch = (order, gen = generation) => Object.fromEntries(order.map((templateName) => [
    templateName,
    generateTemplateRows(gen, root, templateName, rowsByTemplate[templateName])
  ]));
  const seedOn = (billDate) => seedRows(storageRoot).find((row) => row[2] === billDate);
  return { root, storageRoot, acknowledgedKeys, generation, rowsByTemplate, runBatch, seedOn };
}

const warningTypes = (generated) => generated.warnings.map((warning) => warning.type);

for (const order of [['中行-A', '中行-B'], ['中行-B', '中行-A']]) {
  test(`红线-回写10：两个模板共用种子（${order.join(' → ')}，同批或分批）：B 与同日人工补录不一致时先提醒；返回核查后重算仍提醒，确认后才替换并留痕`, (t) => {
    const { acknowledgedKeys, runBatch, seedOn } = sharedSeedFixture(t);

    const first = runBatch(order);
    assert.deepEqual(first['中行-A'].warnings, [], 'A 与人工补录相符，不提醒');
    assert.ok(first['中行-A'].balance, 'A 校验通过，独立生成余额表');
    assert.equal(first['中行-B'].balance, null, 'B 未确认替换时不出余额表');
    assert.deepEqual(pendingReplacements(first['中行-B']).map((item) => [
      item.templateName, item.merchantId, item.billDate, item.manualBalance, item.balance
    ]), [['中行-B', 'M001', '2026-09-01', 5000, 1100]], 'B 的替换提醒列出人工补录 5000 与账单余额 1100');
    assert.deepEqual(seedOn('2026-09-01').slice(3), [5000, '账单里的余额'], 'A 同值回写：金额不变，生成方式变为工具生成');

    // 返回核查后再重算（补录其他组、导出全部、再导入一批）：B 仍按人工补录 5000 提醒，不直接覆盖。
    const again = runBatch(order);
    assert.deepEqual(pendingReplacements(again['中行-B']).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]]);
    assert.equal(seedOn('2026-09-01')[3], 5000, '未确认前 09-01 不被 B 覆盖');

    // 确认替换后重算：B 按账单余额生成，提示带“已确认替换”（列出人工补录 5000）。
    pendingReplacements(first['中行-B']).forEach((item) => acknowledgedKeys.add(item.key));
    const confirmed = runBatch(order);
    assert.deepEqual(balanceSheetRows(confirmed['中行-B'].balance.filePath), [['M001', 'USD', '2026-09-01', 1100]]);
    assert.deepEqual(warningTypes(confirmed['中行-B']), ['balance-seed-replace-confirmed']);
    assert.deepEqual(confirmed['中行-B'].warnings[0].replacements.map((item) => [item.manualBalance, item.balance]), [[5000, 1100]]);
    assert.deepEqual(confirmed['中行-A'].warnings, []);
    assert.deepEqual(seedOn('2026-08-31').slice(3), [1000, '人工录入']);
  });
}

for (const order of [['中行-C', '中行-A', '中行-B'], ['中行-C', '中行-B', '中行-A']]) {
  test(`红线-回写11：先导入、后补录（${order.join(' → ')}）：之后补录的人工余额同样受保护，B 先提醒`, (t) => {
    const { storageRoot, runBatch, seedOn } = sharedSeedFixture(t, { manualSeeds: [] });
    const first = runBatch(order);
    order.forEach((name) => assert.deepEqual(warningTypes(first[name]), ['balance-seed-required'], `${name} 缺种子先补录`));

    // 按 C 的提示补录 09-01=5000：C 可以生成，A、B 仍缺更早的种子。
    writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 5000);
    const second = runBatch(order);
    assert.deepEqual(second['中行-C'].warnings, []);
    assert.deepEqual(warningTypes(second['中行-A']), ['balance-seed-required']);
    assert.deepEqual(warningTypes(second['中行-B']), ['balance-seed-required']);

    // 再补录 08-31=1000 后重算：A 同值回写；B 不论先后都要确认替换人工补录 5000。
    writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
    const third = runBatch(order);
    assert.deepEqual(third['中行-A'].warnings, []);
    assert.deepEqual(pendingReplacements(third['中行-B']).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]]);
    const fourth = runBatch(order);
    assert.deepEqual(pendingReplacements(fourth['中行-B']).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]],
      '返回核查后重算仍提醒');
    assert.equal(seedOn('2026-09-01')[3], 5000);
  });
}

test('红线-回写12：确认替换后又把同日人工补录改成别的值：旧确认失效，按新的人工值重新提醒', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation, runBatch, seedOn } = sharedSeedFixture(t);
  const first = runBatch(['中行-A', '中行-B']);
  pendingReplacements(first['中行-B']).forEach((item) => acknowledgedKeys.add(item.key));
  runBatch(['中行-A', '中行-B']);
  assert.deepEqual(seedOn('2026-09-01').slice(3), [1100, '账单里的余额'], '确认后 B 替换为 1100');

  // 用户核对后把 09-01 改为人工 6000（如 D7“核对上一账单日余额”覆盖）；A 的新账单余额也是 6000。
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 6000);
  const groupA = generateTemplateRows(generation, root, '中行-A', [['2026-09-01', 'M001', 'USD', '5000', '', '6000']]);
  assert.deepEqual(groupA.warnings, []);
  assert.deepEqual(seedOn('2026-09-01').slice(3), [6000, '账单里的余额']);
  const groupB = generateTemplateRows(generation, root, '中行-B', [['2026-09-01', 'M001', 'USD', '100', '', '1100']]);
  assert.equal(groupB.balance, null, '6000 → 1100 从未确认，不得复用 5000 → 1100 的确认');
  assert.deepEqual(warningTypes(groupB), ['balance-seed-replace-confirm']);
  assert.deepEqual(pendingReplacements(groupB).map((item) => [item.manualBalance, item.balance]), [[6000, 1100]]);
  assert.equal(seedOn('2026-09-01')[3], 6000);
});

test('红线-回写13 边界：同一模板自己按同值回写后更正金额也要确认；确认替换写入后、或用户删掉该日种子后不再按旧人工值比对；重启后按 D10 只认人工补录', (t) => {
  const { root, storageRoot, acknowledgedKeys, generation, runBatch, seedOn } = sharedSeedFixture(t);
  runBatch(['中行-A']);
  assert.deepEqual(seedOn('2026-09-01').slice(3), [5000, '账单里的余额']);

  // 同一模板同值回写后又改成 5100：与人工补录 5000 不同，同样要确认（与人工补录未被改写时一致）。
  const correctedRows = [['2026-09-01', 'M001', 'USD', '4100', '', '5100']];
  const corrected = generateTemplateRows(generation, root, '中行-A', correctedRows);
  assert.deepEqual(pendingReplacements(corrected).map((item) => [item.manualBalance, item.balance]), [[5000, 5100]]);
  pendingReplacements(corrected).forEach((item) => acknowledgedKeys.add(item.key));
  const replaced = generateTemplateRows(generation, root, '中行-A', correctedRows);
  assert.deepEqual(warningTypes(replaced), ['balance-seed-replace-confirmed']);
  assert.deepEqual(seedOn('2026-09-01').slice(3), [5100, '账单里的余额']);
  // 确认替换已写入：之后不再按人工 5000 比对（用户已同意替换）。
  assert.deepEqual(generateTemplateRows(generation, root, '中行-B', [['2026-09-01', 'M001', 'USD', '100', '', '1100']]).warnings, []);

  // 用户删掉该日种子后，A 重新回写、B 再生成：不按已删掉的人工补录误报替换。
  const other = sharedSeedFixture(t);
  other.runBatch(['中行-A']);
  writeBalanceSeedRecords(other.storageRoot, '中行', readBalanceSeedRecords(other.storageRoot, '中行').filter((record) => record.billDate !== '2026-09-01'));
  assert.deepEqual(other.runBatch(['中行-A', '中行-B'])['中行-B'].warnings, []);
  assert.deepEqual(other.seedOn('2026-09-01').slice(3), [1100, '账单里的余额']);

  // 重启（新的生成层实例）：此前工具回写的种子按 D10 不比对（见 spec §3.4、B70）。
  const restarted = sharedSeedFixture(t);
  restarted.runBatch(['中行-A']);
  const afterRestart = createGenerationSeam(restarted.storageRoot);
  assert.deepEqual(restarted.runBatch(['中行-B'], afterRestart)['中行-B'].warnings, []);
});

// v3.2.16 Codex 审查（第三、四轮）：“见过的人工补录”按磁盘上的实际种子文件分组。同一个文件的不同写法（空白、
// 特殊字符；文件系统不区分时的大小写、NFC/NFD）共用一份记录；不同文件互不影响。真实磁盘先探测文件系统，再按结果
// 断言共享或隔离；区分大小写的隔离另用注入的独立目录模拟。
const NFC_E = 'é';
const NFD_E = 'é';

// 同一个种子文件能否用两种银行名访问到（按真实路径解析与文件系统）。
function seedFileShared(storageRoot, bankA, bankB) {
  const fileA = getBalanceSeedFilePath(storageRoot, bankA);
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.writeFileSync(fileA, '[]\n');
  try {
    return getBalanceSeedFileIdentity(storageRoot, bankB) === getBalanceSeedFileIdentity(storageRoot, bankA);
  } finally {
    fs.rmSync(fileA, { force: true });
  }
}

test('种子文件身份：同一文件同一身份（写法别名、原地覆盖后不变），不同文件不同，文件不存在为 null', (t) => {
  const storageRoot = path.join(createTempRoot(t), 'storage');
  assert.equal(getBalanceSeedFileIdentity(storageRoot, '中行'), null);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-08-31', 1000);
  const identity = getBalanceSeedFileIdentity(storageRoot, '中行');
  assert.match(identity, /^(file:\d+:\d+|path:.+)$/);
  writeManualSeed(storageRoot, 'M001', 'USD', '2026-09-01', 5000);
  assert.equal(getBalanceSeedFileIdentity(storageRoot, '中行'), identity, '种子原地覆盖写入后身份不变');
  upsertBalanceSeedRecord(storageRoot, {
    templateName: '中行  总行-A', merchantId: 'M001', currency: 'USD', billDate: '2026-08-31', endBalance: 1, generationMethod: '人工录入'
  });
  assert.equal(getBalanceSeedFileIdentity(storageRoot, '中行:总行'), getBalanceSeedFileIdentity(storageRoot, ' 中行 总行 '),
    '空白、特殊字符写法解析到同一个文件');
  assert.notEqual(getBalanceSeedFileIdentity(storageRoot, '中行 总行'), identity, '不同文件身份不同');
});

const SEED_ALIAS_CASES = [
  { label: '空白数量不同', a: '中行  总行-A', b: '中行 总行-B' },
  { label: '特殊字符', a: '中行 总行-A', b: '中行:总行-B' },
  { label: '大小写', a: 'HSBC-SG', b: 'hsbc-HK' },
  { label: 'Unicode NFC/NFD', a: `Cr${NFC_E}dit-A`, b: `Cr${NFD_E}dit-B` }
];

for (const aliasCase of SEED_ALIAS_CASES) {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    test(`红线-回写14：银行名写法不同（${aliasCase.label}，${order.join(' → ')}）：同一个种子文件时共用保护，不同文件时互不影响`, (t) => {
      const { root, storageRoot, acknowledgedKeys, generation } = writebackFixture(t);
      const names = { a: aliasCase.a, b: aliasCase.b };
      const bankOf = (key) => splitTemplateName(names[key]).bankName;
      const shared = seedFileShared(storageRoot, bankOf('a'), bankOf('b'));
      if (aliasCase.label === '空白数量不同' || aliasCase.label === '特殊字符') assert.equal(shared, true, '路径解析后为同一个文件');
      const manual = (key, billDate, endBalance) => upsertBalanceSeedRecord(storageRoot, {
        templateName: names[key], merchantId: 'M001', currency: 'USD', billDate, endBalance, generationMethod: '人工录入', overwrite: true
      });
      const seed0901 = (key) => readBalanceSeedRecords(storageRoot, bankOf(key)).find((record) => record.billDate === '2026-09-01');
      const rows = { a: [['2026-09-01', 'M001', 'USD', '4000', '', '5000']], b: [['2026-09-01', 'M001', 'USD', '100', '', '1100']] };
      const run = (key, rowsOverride) => generateTemplateRows(generation, root, names[key], rowsOverride || rows[key]);
      const runOrder = () => Object.fromEntries(order.map((key) => [key, run(key)]));
      manual('a', '2026-08-31', 1000);
      manual('a', '2026-09-01', 5000);

      if (!shared) {
        // 不同文件：B 读不到 A 的种子，按缺种子要求补录；A 的保护不受 B 影响。
        const isolated = runOrder();
        assert.deepEqual(isolated.a.warnings, []);
        assert.deepEqual(warningTypes(isolated.b), ['balance-seed-required'], 'B 是另一个文件，没有种子');
        const correctedA = run('a', [['2026-09-01', 'M001', 'USD', '100', '', '1100']]);
        assert.deepEqual(pendingReplacements(correctedA).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]]);
        return;
      }

      const first = runOrder();
      assert.deepEqual(first.a.warnings, []);
      assert.deepEqual(pendingReplacements(first.b).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]], 'B 先提醒');
      assert.equal(seed0901('b').endBalance, 5000);
      const again = runOrder();
      assert.deepEqual(pendingReplacements(again.b).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]], '返回核查后重算仍提醒');

      // 确认写入后清理：之后 A 以 5500 回写不再按人工 5000 提醒（先于再次改人工值断言）。
      pendingReplacements(first.b).forEach((item) => acknowledgedKeys.add(item.key));
      const confirmed = runOrder();
      assert.deepEqual(warningTypes(confirmed.b), ['balance-seed-replace-confirmed']);
      assert.deepEqual(run('a', [['2026-09-01', 'M001', 'USD', '4500', '', '5500']]).warnings, [], '确认替换写入后不再按旧人工值比对');
      assert.equal(seed0901('a').endBalance, 5500);

      // 人工值改为 6000、A 同值回写后，B 按 6000 → 1100 重新提醒。
      manual('b', '2026-09-01', 6000);
      assert.deepEqual(run('a', [['2026-09-01', 'M001', 'USD', '5000', '', '6000']]).warnings, []);
      assert.deepEqual([seed0901('b').endBalance, seed0901('b').generationMethod], [6000, '账单里的余额']);
      const afterChange = run('b');
      assert.deepEqual(pendingReplacements(afterChange).map((item) => [item.manualBalance, item.balance]), [[6000, 1100]]);
      assert.equal(seed0901('a').endBalance, 6000);
    });
  }
}

// 区分大小写的文件系统上 HSBC.json 与 hsbc.json 是两个文件：用每个银行名各自的目录模拟，身份解析走真实 stat。
function caseSensitiveFixture(t) {
  const root = createTempRoot(t);
  const base = path.join(root, 'storage');
  const acknowledgedKeys = new Set();
  const rootFor = (bankName) => path.join(base, Buffer.from(String(bankName)).toString('hex'));
  const bankOfTemplate = (templateName) => splitTemplateName(templateName).bankName;
  const generation = createGenerationSeam(base, {
    acknowledgedKeys,
    overrides: {
      readBalanceSeedRecords: (_root, bankName) => readBalanceSeedRecords(rootFor(bankName), bankName),
      findPreviousBalanceSeed: (_root, query) => findPreviousBalanceSeed(rootFor(query.bankName), query),
      resolveBalanceSeedFileIdentity: (_root, bankName) => getBalanceSeedFileIdentity(rootFor(bankName), bankName),
      scanBalanceSeedStatus: (input) => scanStatementBalanceSeedStatus(input, rootFor(bankOfTemplate(input.templateName))),
      storeGeneratedBalanceSeeds: ({ templateName, seedRecords }) => seedRecords.forEach((record) => upsertBalanceSeedRecord(
        rootFor(bankOfTemplate(templateName)), { templateName, ...record, overwrite: true }
      ))
    }
  });
  const manual = (templateName, billDate, endBalance) => upsertBalanceSeedRecord(rootFor(bankOfTemplate(templateName)), {
    templateName, merchantId: 'M001', currency: 'USD', billDate, endBalance, generationMethod: '人工录入', overwrite: true
  });
  const run = (templateName, credit, balance) => generateTemplateRows(generation, root, templateName, [
    ['2026-09-01', 'M001', 'USD', String(credit), '', String(balance)]
  ]);
  return { acknowledgedKeys, manual, run };
}

test('红线-回写15：区分大小写时 HSBC 与 hsbc 是两个种子文件，记录互不影响：对方缺该日不清除、对方人工值不覆盖、确认后清理互不影响', (t) => {
  // (a) B 的文件里没有 09-01：处理 B 不清除 A 的记录，A 之后改金额仍要确认。
  {
    const { manual, run } = caseSensitiveFixture(t);
    manual('HSBC-SG', '2026-08-31', 1000);
    manual('HSBC-SG', '2026-09-01', 5000);
    manual('hsbc-HK', '2026-08-31', 1000);
    assert.deepEqual(run('HSBC-SG', 4000, 5000).warnings, []);
    assert.deepEqual(run('hsbc-HK', 100, 1100).warnings, [], 'B 自己的文件没有 09-01 人工补录');
    assert.deepEqual(pendingReplacements(run('HSBC-SG', 100, 1100)).map((item) => [item.manualBalance, item.balance]), [[5000, 1100]],
      'A 的人工 5000 仍受保护');
  }
  // (b) B 的文件里 09-01 人工为 6000：不覆盖 A 记下的 5000，A 改成 6000 仍要确认。
  {
    const { manual, run } = caseSensitiveFixture(t);
    manual('HSBC-SG', '2026-08-31', 1000);
    manual('HSBC-SG', '2026-09-01', 5000);
    manual('hsbc-HK', '2026-08-31', 1000);
    manual('hsbc-HK', '2026-09-01', 6000);
    assert.deepEqual(run('HSBC-SG', 4000, 5000).warnings, []);
    assert.deepEqual(run('hsbc-HK', 5000, 6000).warnings, []);
    assert.deepEqual(pendingReplacements(run('HSBC-SG', 5000, 6000)).map((item) => [item.manualBalance, item.balance]), [[5000, 6000]],
      '按 A 自己的人工 5000 比对');
  }
  // (c) A 确认替换写入后只清理 A 的记录；B 的人工 7000 仍受保护。
  {
    const { acknowledgedKeys, manual, run } = caseSensitiveFixture(t);
    manual('HSBC-SG', '2026-08-31', 1000);
    manual('HSBC-SG', '2026-09-01', 5000);
    manual('hsbc-HK', '2026-08-31', 1000);
    manual('hsbc-HK', '2026-09-01', 7000);
    assert.deepEqual(run('HSBC-SG', 4000, 5000).warnings, []);
    assert.deepEqual(run('hsbc-HK', 6000, 7000).warnings, []);
    pendingReplacements(run('HSBC-SG', 100, 1100)).forEach((item) => acknowledgedKeys.add(item.key));
    assert.deepEqual(warningTypes(run('HSBC-SG', 100, 1100)), ['balance-seed-replace-confirmed']);
    assert.deepEqual(pendingReplacements(run('hsbc-HK', 200, 1200)).map((item) => [item.manualBalance, item.balance]), [[7000, 1200]],
      'B 的人工 7000 仍受保护');
  }
});

// ---------------------------------------------------------------------------
// 同一账单日人工补录与本次余额不一致时替换前确认（v3.2.16，用户 2026-11-08：两种模板都提醒，不替换则返回核查）。
// ---------------------------------------------------------------------------

const manualOn = (merchantId, currency, billDate, endBalance, generationMethod = '人工录入') => ({
  merchantId, currency, billDate, endBalance, generationMethod
});

test('替换提醒：账单里的余额与发生额计算都比对同日人工补录；只认人工补录，生成的种子不提醒', () => {
  const statementError = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '1100']],
    [seed('M001', 'USD', '2026-08-31', 1000)],
    { existingBalanceSeeds: [manualOn('M001', 'USD', '2026-09-01', 5000)] }));
  assert.equal(statementError.code, 'BALANCE_SEED_REPLACE_CONFIRM_REQUIRED');
  assert.deepEqual(statementError.context.replacements.map((item) => [
    item.billDate, item.balanceSource, item.manualBalance, item.balance, item.difference, item.writtenBalance, item.key
  ]), [['2026-09-01', 'statement', 5000, 1100, -3900, 1100, 'seed-replace|中行-上海|M001|USD|2026-09-01|5000.00|1100.00']]);

  const calculatedError = deriveError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '', ''],
    ['2026-09-02', 'M001', 'USD', '', '30', '']
  ], [seed('M001', 'USD', '2026-08-31', 1000)], {
    mode: 'calculated',
    existingBalanceSeeds: [manualOn('M001', 'USD', '2026-09-02', 1000)]
  }));
  assert.deepEqual(calculatedError.context.replacements.map((item) => [item.billDate, item.balanceSource, item.manualBalance, item.balance]), [
    ['2026-09-02', 'calculated', 1000, 1070]
  ]);

  const { result } = derive([['2026-09-01', 'M001', 'USD', '100', '', '1100']], [seed('M001', 'USD', '2026-08-31', 1000)], {
    existingBalanceSeeds: [
      manualOn('M001', 'USD', '2026-09-01', 5000, '账单里的余额'),
      manualOn('M001', 'USD', '2026-09-01', 5000, '通过发生额计算'),
      manualOn('M001', 'EUR', '2026-09-01', 5000),
      manualOn('M002', 'USD', '2026-09-01', 5000)
    ]
  });
  assert.deepEqual(result.confirmedBalanceSeedReplacements, [], '生成的种子、其他币种或账号的人工补录不提醒');
});

test('替换提醒：按原值比对（人工补录不含附加值）；附加值只影响写入值', () => {
  const adjustment = { merchantId: 'M001', currency: 'USD', effectiveDate: '2026-08-01', adjustmentValue: 10 };
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const { result } = derive([['2026-09-01', 'M001', 'USD', '100', '', '1100']], seeds, {
    balanceAdjustments: [adjustment],
    existingBalanceSeeds: [manualOn('M001', 'USD', '2026-09-01', 1100)]
  });
  assert.deepEqual(balances(result).map((row) => row[3]), [1110], '原值相同不提醒，写入值含附加值');

  const error = deriveError(() => derive([['2026-09-01', 'M001', 'USD', '100', '', '1100']], seeds, {
    balanceAdjustments: [adjustment],
    existingBalanceSeeds: [manualOn('M001', 'USD', '2026-09-01', 1110)]
  }));
  assert.deepEqual(error.context.replacements.map((item) => [item.manualBalance, item.balance, item.adjustment, item.writtenBalance]), [
    [1110, 1100, 10, 1110]
  ]);
});

test('替换提醒：顺序排在余额不一致之后；确认键随人工补录值或本次余额变化失效', () => {
  const seeds = [seed('M001', 'USD', '2026-08-31', 1000)];
  const existing = [manualOn('M001', 'USD', '2026-09-01', 5000)];
  const rows = [['2026-09-01', 'M001', 'USD', '100', '', '9999']];
  const mismatch = deriveError(() => derive(rows, seeds, { existingBalanceSeeds: existing }));
  assert.equal(mismatch.code, 'BALANCE_MISMATCH_CONFIRM_REQUIRED');
  const acknowledged = new Set(mismatch.context.mismatches.map((item) => item.key));

  const replace = deriveError(() => derive(rows, seeds, {
    existingBalanceSeeds: existing, acknowledgedBalanceMismatchKeys: acknowledged
  }));
  assert.equal(replace.code, 'BALANCE_SEED_REPLACE_CONFIRM_REQUIRED');
  replace.context.replacements.forEach((item) => acknowledged.add(item.key));

  const { result } = derive(rows, seeds, {
    existingBalanceSeeds: existing,
    acknowledgedBalanceMismatchKeys: acknowledged,
    acknowledgedBalanceSeedReplaceKeys: acknowledged
  });
  assert.deepEqual(result.confirmedBalanceSeedReplacements.map((item) => item.key), [replace.context.replacements[0].key]);

  const changedManual = deriveError(() => derive(rows, seeds, {
    existingBalanceSeeds: [manualOn('M001', 'USD', '2026-09-01', 5001)],
    acknowledgedBalanceMismatchKeys: acknowledged,
    acknowledgedBalanceSeedReplaceKeys: acknowledged
  }));
  assert.equal(changedManual.code, 'BALANCE_SEED_REPLACE_CONFIRM_REQUIRED', '人工补录值变了要重新确认');
});

function seedReplacePrompt() {
  return {
    reason: 'seed-replace',
    templateName: TEMPLATE_NAME,
    merchantId: 'M001',
    currency: 'USD',
    targetBillDate: '2026-09-01',
    replacements: [
      { key: 'seed-replace|中行-上海|M001|USD|2026-09-01|5000.00|1100.00', merchantId: 'M001', billDate: '2026-09-01' }
    ]
  };
}

test('确认替换：只接受当前 prompt 列出的替换项，不生成人工种子写入计划；替换 prompt 不接受人工补录', () => {
  const key = seedReplacePrompt().replacements[0].key;
  const { resolution, guardCalls } = prepare({ confirmBalanceSeedReplaceKeys: [key] }, seedReplacePrompt());
  assert.equal(resolution.prepared.proceed, true);
  assert.equal(resolution.prepared.plan, null);
  assert.deepEqual(resolution.prepared.confirmBalanceSeedReplaceKeys, [key]);
  assert.deepEqual(resolution.prepared.confirmedBalanceSeedReplacements.map((item) => item.merchantId), ['M001']);
  assert.equal(guardCalls[0].plan, null);

  for (const payload of [
    { confirmBalanceSeedReplaceKeys: [] },
    { confirmBalanceSeedReplaceKeys: ['seed-replace|中行-上海|M009|USD|2026-09-01|1.00|2.00'] }
  ]) {
    const invalid = prepare(payload, seedReplacePrompt()).resolution.prepared;
    assert.equal(invalid.proceed, false);
    assert.equal(invalid.result.errorCode, 'BALANCE_SEED_REPLACE_CONFIRMATION_INVALID');
  }
  // 不一致的键不能拿来确认替换，反之亦然。
  const crossed = prepare({ confirmBalanceSeedReplaceKeys: [key] }, mismatchPrompt()).resolution.prepared;
  assert.equal(crossed.result.errorCode, 'BALANCE_SEED_REPLACE_CONFIRMATION_INVALID');
  const manual = prepare({ billDate: '2026-08-31', endBalance: '1000' }, seedReplacePrompt()).resolution.prepared;
  assert.equal(manual.proceed, false);
  assert.equal(manual.result.errorCode, 'BALANCE_SEED_REPLACE_CONFIRMATION_INVALID');
});

const SAMPLE_REPLACEMENT = {
  key: 'seed-replace|中行-上海|M001|USD|2026-09-01|5000.00|1100.00',
  templateName: TEMPLATE_NAME,
  bankName: '中行',
  merchantId: 'M001',
  currency: 'USD',
  billDate: '2026-09-01',
  balanceSource: 'statement',
  manualBalance: 5000,
  balance: 1100,
  difference: -3900,
  adjustment: 0,
  writtenBalance: 1100
};
const SAMPLE_REPLACE_LINE = '银行账号：M001，币种：USD，账单日期：2026-09-01，人工补录余额：5,000.00，账单余额：1,100.00，差额：-3,900.00';

test('主进程：人工补录替换确认结果、确认后的告警摘要与明细（列出人工补录值与账单值）', () => {
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatBalanceSeedReplaceLine = loadMainFunction(
    'formatBalanceSeedReplaceLine', ['formatBalanceAmount'], [formatBalanceAmount]
  );
  assert.equal(formatBalanceSeedReplaceLine(SAMPLE_REPLACEMENT), SAMPLE_REPLACE_LINE);
  assert.equal(
    formatBalanceSeedReplaceLine({ ...SAMPLE_REPLACEMENT, balanceSource: 'calculated', adjustment: 10, writtenBalance: 1110, difference: 2.5 }),
    '银行账号：M001，币种：USD，账单日期：2026-09-01，人工补录余额：5,000.00，计算余额：1,100.00，差额：+2.50，另加余额附加值 10.00 后写入 1,110.00'
  );

  const logs = [];
  const buildBalanceSeedReplaceConfirmResult = loadMainFunction(
    'buildBalanceSeedReplaceConfirmResult',
    ['clearLastErrorReport', 'lastPendingBalanceSeedConfirmation', 'lastManualBalancePrompt', 'appendActivityLogEntry', 'formatBalanceSeedReplaceLine'],
    [() => {}, null, null, (entry) => logs.push(entry), formatBalanceSeedReplaceLine]
  );
  const result = buildBalanceSeedReplaceConfirmResult([SAMPLE_REPLACEMENT], { detail: { filePath: '/tmp/detail.xlsx' } });
  assert.equal(result.message, '人工补录的期末余额与本次余额不一致（1 处），请核查或确认替换');
  assert.equal(result.balanceReady, false);
  assert.equal(result.manualBalancePrompt.reason, 'seed-replace');
  assert.deepEqual(result.manualBalancePrompt.replacements, [SAMPLE_REPLACEMENT]);
  assert.deepEqual(logs[0].details, [`模板名：${TEMPLATE_NAME}`, SAMPLE_REPLACE_LINE]);

  const buildImportWarningMessage = loadMainFunction('buildImportWarningMessage');
  const buildImportWarningDetailLines = loadMainFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine', 'formatBalanceMismatchLine', 'formatBalanceSeedReplaceLine'],
    [() => '', () => '', formatBalanceSeedReplaceLine]
  );
  const warnings = [{ type: 'balance-seed-replace-confirmed', replacements: [SAMPLE_REPLACEMENT] }];
  assert.equal(
    buildImportWarningMessage({ warnings, balanceReady: true, balanceRequested: true }),
    '明细账单可导出，余额账单可导出，1处人工补录余额已按本次余额替换，请点击状态框导出报错文件'
  );
  assert.deepEqual(buildImportWarningDetailLines(warnings), [
    '以下账单日的人工补录期末余额与本次余额不一致，已确认按本次余额生成并替换人工补录：',
    SAMPLE_REPLACE_LINE
  ]);
});

test('主进程装配：生成层拿到读取种子与替换确认的依赖（缺了会静默跳过替换提醒）', () => {
  let call = null;
  const visit = (node) => {
    if (call || !node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee && node.callee.name === 'createStatementGenerationHelpers') {
      call = node;
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(MAIN_AST);
  assert.ok(call, '未找到 main.js 的 createStatementGenerationHelpers 调用');
  const names = call.arguments[0].properties.map((property) => property.key.name);
  for (const name of ['readBalanceSeedRecords', 'buildBalanceSeedReplaceConfirmResult', 'buildBalanceMismatchConfirmResult']) {
    assert.ok(names.includes(name), `缺少依赖 ${name}`);
  }
});
