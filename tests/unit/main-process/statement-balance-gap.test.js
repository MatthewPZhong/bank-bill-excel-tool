'use strict';

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
const {
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord
} = require('../../../src/backend/balance-seed-store');
const { readBalanceAdjustments } = require('../../../src/backend/balance-adjustment-store');
const { createStatementGenerationHelpers } = require('../../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus: scanStatementBalanceSeedStatus
} = require('../../../src/main-process/statement-generation-business');
const {
  buildManualBalanceSeedPlan,
  prepareManualBalanceSeedSubmission
} = require('../../../src/main-process/manual-balance-seed-preflight');
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
const HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
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

// v3.2.15：生成分组改为按渠道 / 模板；这里的模板都不属于渠道，按模板各自成组。
function loadGroupingFunction(getTemplateMappingConfig) {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  return loadMainFunction(
    'groupStatementEntriesForGeneration',
    ['database', 'resolveGenerationGroupKey', 'getTemplateMappingConfig'],
    [{ getTemplate: (id) => ({ id, channelId: null }) }, resolveGenerationGroupKey, getTemplateMappingConfig]
  );
}

// 普通模板组不做渠道余额方式校验，使用真实函数确认其对非渠道组直接放行。
function loadBalanceModeMismatchFunction(getTemplateMappingConfig) {
  const identity = require('../../../src/main-process/statement-channel-identity');
  return loadMainFunction(
    'findGenerationGroupBalanceModeMismatch',
    ['getTemplateMappingConfig', 'resolveTemplateBalanceMode', 'findBalanceModeMismatch'],
    [getTemplateMappingConfig, identity.resolveTemplateBalanceMode, identity.findBalanceModeMismatch]
  );
}

// v3.2.15（PR #246 审查）：导出全部前核对各组输出名称不重复；这里的普通模板各不同名、库里没有同名渠道，
//   使用真实函数确认直接放行。
function loadOutputNameConflictFunctions(database = { listStatementOutputOwners: () => ({ templates: [], channels: [] }) }) {
  const identity = require('../../../src/main-process/statement-channel-identity');
  const { normalizeCell, FileValidationError } = require('../../../src/backend/file-service');
  return {
    findGenerationGroupOutputNameConflicts: loadMainFunction(
      'findGenerationGroupOutputNameConflicts',
      ['database', 'resolveStatementOutputName', 'normalizeCell', 'sanitizeFileName'],
      [database, identity.resolveStatementOutputName, normalizeCell, loadMainFunction('sanitizeFileName')]
    ),
    buildStatementOutputNameConflictError: loadMainFunction(
      'buildStatementOutputNameConflictError',
      ['FileValidationError'],
      [FileValidationError]
    )
  };
}

// 多组生成前核对各组实际输出文件名（输出名称拼上账号）不重复；这里的模板都不属于渠道。
function loadOutputPathConflictFunctions(database = { getTemplate: () => null }) {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  return {
    findGenerationGroupOutputPathConflicts: loadMainFunction(
      'findGenerationGroupOutputPathConflicts',
      ['database', 'normalizeCell', 'sanitizeFileName', 'resolveGenerationGroupKey'],
      [database, normalizeCell, loadMainFunction('sanitizeFileName'), resolveGenerationGroupKey]
    ),
    buildStatementOutputPathConflictError: loadMainFunction(
      'buildStatementOutputPathConflictError',
      ['FileValidationError'],
      [FileValidationError]
    )
  };
}

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-balance-gap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function detailRows(rows) {
  return [HEADER.slice(), ...rows.map((row) => row.slice())];
}

// 与 findPreviousBalanceSeed 同口径：目标日之前最近的一条。
function seedResolver(seeds) {
  const calls = [];
  const resolve = ({ merchantId, currency, targetBillDate, generationMethod }) => {
    calls.push(targetBillDate);
    const matches = seeds
      .filter((seed) => seed.merchantId === merchantId && seed.currency === currency
        && seed.billDate < targetBillDate
        && (!generationMethod || (seed.generationMethod || '人工录入') === generationMethod))
      .sort((left, right) => left.billDate.localeCompare(right.billDate));
    return matches.length ? matches[matches.length - 1] : null;
  };
  return { resolve, calls };
}

function derive(rows, seeds, options = {}) {
  const resolver = seedResolver(seeds);
  const result = deriveBalanceRecords({
    detailRows: detailRows(rows),
    templateName: TEMPLATE_NAME,
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'calculated',
    resolvePreviousBalanceSeed: resolver.resolve,
    ...options
  });
  return { result, calls: resolver.calls };
}

function balances(result) {
  return result.records.map((row) => [row[3], row[2], row[4], row[7]]);
}

function gapError(fn) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FileValidationError, '应抛出 FileValidationError');
  return caught;
}

const seed = (merchantId, currency, billDate, endBalance) => ({ merchantId, currency, billDate, endBalance });

test('日期连续时不提示，结果与逐日累加一致且中间日期不额外查种子', () => {
  const { result, calls } = derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-02', 'M001', 'USD', '', '40'],
    ['2026-09-03', 'M001', 'USD', '5', '6']
  ], [seed('M001', 'USD', '2026-08-31', 1000)]);
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1100],
    ['M001', 'USD', '2026-09-02', 1060],
    ['M001', 'USD', '2026-09-03', 1059]
  ]);
  assert.deepEqual(result.skippedBalanceGaps, []);
  assert.deepEqual(calls, ['2026-09-01']);
});

test('文件内断档：列出断档信息，且不返回余额记录', () => {
  const error = gapError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-04', 'M001', 'USD', '10', '']
  ], [seed('M001', 'USD', '2026-08-31', 1000)]));
  assert.equal(error.code, 'BALANCE_GAP_CONFIRM_REQUIRED');
  assert.equal(error.message, '账单日期不连续，请确认是否补录断档前一日的期末余额');
  assert.deepEqual(error.context.gaps, [{
    templateName: TEMPLATE_NAME,
    bankName: '中行',
    merchantId: 'M001',
    currency: 'USD',
    anchorDate: '2026-09-01',
    anchorSource: 'file',
    targetBillDate: '2026-09-04',
    missingFrom: '2026-09-02',
    missingTo: '2026-09-03',
    suggestedSeedDate: '2026-09-03',
    key: '中行-上海|M001|USD|2026-09-01|2026-09-04'
  }]);
});

test('上次余额与本次首日之间断档：锚点来自种子', () => {
  const error = gapError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', '']
  ], [seed('M001', 'USD', '2026-08-28', 1000)]));
  assert.equal(error.code, 'BALANCE_GAP_CONFIRM_REQUIRED');
  const [gap] = error.context.gaps;
  assert.equal(gap.anchorDate, '2026-08-28');
  assert.equal(gap.anchorSource, 'seed');
  assert.equal(gap.missingFrom, '2026-08-29');
  assert.equal(gap.missingTo, '2026-08-31');
  assert.equal(gap.suggestedSeedDate, '2026-08-31');
});

test('补录断档前一日余额后不再提示，断档后首日按补录余额计算并叠加附加值', () => {
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-04', 'M001', 'USD', '10', '']
  ], [
    seed('M001', 'USD', '2026-08-31', 1000),
    seed('M001', 'USD', '2026-09-03', 500)
  ], {
    balanceAdjustments: [{ merchantId: 'M001', currency: 'USD', effectiveDate: '2026-09-01', adjustmentValue: 5 }]
  });
  // 种子锚点与首日口径一致：附加值从 0 起累计。
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1105],
    ['M001', 'USD', '2026-09-04', 515]
  ]);
  assert.deepEqual(result.skippedBalanceGaps, []);
});

test('补录日期早于断档前一日时仍提示，锚点改为补录日期', () => {
  const error = gapError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-05', 'M001', 'USD', '10', '']
  ], [
    seed('M001', 'USD', '2026-08-31', 1000),
    seed('M001', 'USD', '2026-09-02', 700)
  ]));
  const [gap] = error.context.gaps;
  assert.equal(gap.anchorDate, '2026-09-02');
  assert.equal(gap.anchorSource, 'seed');
  assert.equal(gap.missingFrom, '2026-09-03');
  assert.equal(gap.missingTo, '2026-09-04');
});

test('断档内只有早于文件上一日期的种子时不改用种子', () => {
  const error = gapError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-04', 'M001', 'USD', '10', '']
  ], [
    seed('M001', 'USD', '2026-08-31', 900),
    seed('M001', 'USD', '2026-09-01', 1)
  ]));
  // 同一天以文件内本次计算为准，旧的计算种子不覆盖。
  const [gap] = error.context.gaps;
  assert.equal(gap.anchorSource, 'file');
  assert.equal(gap.anchorDate, '2026-09-01');
});

test('断档内的计算种子不作锚点，仍然提示；人工补录优先于更晚的计算种子', () => {
  const calculated = (billDate, endBalance) => ({ ...seed('M001', 'USD', billDate, endBalance), generationMethod: '通过发生额计算' });
  const rows = [
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-05', 'M001', 'USD', '10', '']
  ];
  const adjustments = [{ merchantId: 'M001', currency: 'USD', effectiveDate: '2026-09-01', adjustmentValue: 5 }];
  // 只有计算种子：已含附加值，用作锚点会让附加值重复叠加，所以不采用。
  const error = gapError(() => derive(rows, [
    seed('M001', 'USD', '2026-08-31', 1000),
    calculated('2026-09-04', 777)
  ], { balanceAdjustments: adjustments }));
  assert.equal(error.context.gaps[0].anchorSource, 'file');
  assert.equal(error.context.gaps[0].anchorDate, '2026-09-01');

  // 人工补录较早、计算种子较晚：锚点取人工补录，计算种子不参与。
  const partial = gapError(() => derive(rows, [
    seed('M001', 'USD', '2026-08-31', 1000),
    seed('M001', 'USD', '2026-09-03', 600),
    calculated('2026-09-04', 777)
  ], { balanceAdjustments: adjustments }));
  assert.equal(partial.context.gaps[0].anchorSource, 'seed');
  assert.equal(partial.context.gaps[0].anchorDate, '2026-09-03');

  const { result } = derive(rows, [
    seed('M001', 'USD', '2026-08-31', 1000),
    calculated('2026-09-02', 777),
    seed('M001', 'USD', '2026-09-04', 600)
  ], { balanceAdjustments: adjustments });
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1105],
    ['M001', 'USD', '2026-09-05', 615]
  ]);
});

test('确认不补录后按断档前余额接着算，并返回跳过的断档', () => {
  const key = '中行-上海|M001|USD|2026-09-01|2026-09-04';
  const { result } = derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-04', 'M001', 'USD', '10', '']
  ], [seed('M001', 'USD', '2026-08-31', 1000)], {
    acknowledgedBalanceGapKeys: new Set([key])
  });
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1100],
    ['M001', 'USD', '2026-09-04', 1110]
  ]);
  assert.deepEqual(result.skippedBalanceGaps.map((gap) => gap.key), [key]);
});

test('确认键只覆盖同一断档：锚点变化后需要重新确认', () => {
  const error = gapError(() => derive([
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-05', 'M001', 'USD', '10', '']
  ], [seed('M001', 'USD', '2026-08-31', 1000)], {
    acknowledgedBalanceGapKeys: new Set(['中行-上海|M001|USD|2026-09-01|2026-09-04'])
  }));
  assert.equal(error.code, 'BALANCE_GAP_CONFIRM_REQUIRED');
  assert.equal(error.context.gaps[0].key, '中行-上海|M001|USD|2026-09-01|2026-09-05');
});

test('多账号多币种的断档一次列全；同时缺首次种子时先走首次补录', () => {
  const rows = [
    ['2026-09-01', 'M001', 'USD', '1', ''],
    ['2026-09-03', 'M001', 'USD', '1', ''],
    ['2026-09-01', 'M002', 'EUR', '1', ''],
    ['2026-09-05', 'M002', 'EUR', '1', '']
  ];
  const seeds = [seed('M001', 'USD', '2026-08-31', 10), seed('M002', 'EUR', '2026-08-31', 20)];
  const error = gapError(() => derive(rows, seeds));
  assert.equal(error.code, 'BALANCE_GAP_CONFIRM_REQUIRED');
  assert.deepEqual(error.context.gaps.map((gap) => [gap.merchantId, gap.currency, gap.missingFrom, gap.missingTo]), [
    ['M001', 'USD', '2026-09-02', '2026-09-02'],
    ['M002', 'EUR', '2026-09-02', '2026-09-04']
  ]);

  const seedError = gapError(() => derive(rows, [seeds[0]]));
  assert.equal(seedError.code, 'BALANCE_SEED_REQUIRED');
  assert.equal(seedError.context.merchantId, 'M002');
});

test('日期按自然日计算：跨年、非闰年二月连续，闰年二月缺 29 日', () => {
  assert.doesNotThrow(() => derive([
    ['2026-12-31', 'M001', 'USD', '1', ''],
    ['2027-01-01', 'M001', 'USD', '1', '']
  ], [seed('M001', 'USD', '2026-12-30', 0)]));
  assert.doesNotThrow(() => derive([
    ['2027-02-28', 'M001', 'USD', '1', ''],
    ['2027-03-01', 'M001', 'USD', '1', '']
  ], [seed('M001', 'USD', '2027-02-27', 0)]));
  const error = gapError(() => derive([
    ['2028-02-28', 'M001', 'USD', '1', ''],
    ['2028-03-01', 'M001', 'USD', '1', '']
  ], [seed('M001', 'USD', '2028-02-27', 0)]));
  assert.equal(error.context.gaps[0].missingFrom, '2028-02-29');
  assert.equal(error.context.gaps[0].missingTo, '2028-02-29');
});

test('账单里的余额模式不做断档判定', () => {
  const result = deriveBalanceRecords({
    detailRows: [
      [...HEADER, 'Balance'],
      ['2026-09-01', 'M001', 'USD', '100', '', '1100'],
      ['2026-09-04', 'M001', 'USD', '10', '', '1110']
    ],
    templateName: TEMPLATE_NAME,
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'statement',
    resolvePreviousBalanceSeed: () => null
  });
  assert.deepEqual(balances(result), [
    ['M001', 'USD', '2026-09-01', 1100],
    ['M001', 'USD', '2026-09-04', 1110]
  ]);
  assert.deepEqual(result.skippedBalanceGaps, []);
});

function gapPrompt() {
  return {
    reason: 'gap',
    templateName: TEMPLATE_NAME,
    bankName: '中行',
    merchantId: 'M001',
    currency: 'USD',
    anchorDate: '2026-09-01',
    targetBillDate: '2026-09-04',
    missingFrom: '2026-09-02',
    missingTo: '2026-09-03',
    suggestedSeedDate: '2026-09-03',
    gapKey: '中行-上海|M001|USD|2026-09-01|2026-09-04',
    gaps: [
      { key: '中行-上海|M001|USD|2026-09-01|2026-09-04', merchantId: 'M001', currency: 'USD' },
      { key: '中行-上海|M002|EUR|2026-09-01|2026-09-05', merchantId: 'M002', currency: 'EUR' }
    ]
  };
}

function prepareSkip(payload, pendingPrompt = gapPrompt()) {
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

test('不补录：只接受当前 prompt 列出的断档，并且不生成种子写入计划', () => {
  const { resolution, guardCalls } = prepareSkip({
    skipBalanceGapKeys: ['中行-上海|M002|EUR|2026-09-01|2026-09-05', '中行-上海|M001|USD|2026-09-01|2026-09-04']
  });
  assert.equal(resolution.prepared.proceed, true);
  assert.equal(resolution.prepared.plan, null);
  assert.deepEqual(resolution.prepared.skipBalanceGapKeys, [
    '中行-上海|M002|EUR|2026-09-01|2026-09-05',
    '中行-上海|M001|USD|2026-09-01|2026-09-04'
  ]);
  assert.deepEqual(resolution.prepared.skippedBalanceGaps.map((gap) => gap.merchantId), ['M002', 'M001']);
  assert.deepEqual(resolution.prepared.inputPaths, ['/tmp/source.xlsx']);
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].plan, null);

  for (const payload of [
    { skipBalanceGapKeys: [] },
    { skipBalanceGapKeys: ['中行-上海|M009|USD|2026-09-01|2026-09-04'] },
    { skipBalanceGapKeys: 'not-array' }
  ]) {
    const invalid = prepareSkip(payload).resolution.prepared;
    assert.equal(invalid.proceed, false);
    assert.equal(invalid.result.errorCode, 'BALANCE_GAP_CONFIRMATION_INVALID');
  }
  const nonGap = prepareSkip(
    { skipBalanceGapKeys: ['中行-上海|M001|USD|2026-09-01|2026-09-04'] },
    { templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD', targetBillDate: '2026-09-01' }
  ).resolution.prepared;
  assert.equal(nonGap.proceed, false);
  assert.equal(nonGap.result.errorCode, 'BALANCE_GAP_CONFIRMATION_INVALID');
});

test('断档补录日期必须晚于断档前最后一个账单日', (t) => {
  const storageRoot = createTempRoot(t);
  const build = (billDate) => buildManualBalanceSeedPlan({
    payload: { billDate, endBalance: '500' },
    pendingPrompt: gapPrompt(),
    importContext: { template: { name: TEMPLATE_NAME } },
    storageRoot
  });
  const rejected = build('2026-09-01');
  assert.equal(rejected.stopResult.status, 'manual-balance-invalid');
  assert.equal(rejected.stopResult.message, '补录日期必须晚于断档前最后一个账单日 2026-09-01');
  const accepted = build('2026-09-03');
  assert.equal(accepted.stopResult, undefined);
  assert.equal(accepted.plan.record.billDate, '2026-09-03');
  assert.equal(accepted.plan.record.merchantId, 'M001');
});

function writeSourceWorkbook(root, fileName, rows) {
  const filePath = path.join(root, fileName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function createGenerationSeam(storageRoot, { acknowledgedKeys = new Set(), gapResults = [] } = {}) {
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
      throw new Error('断档用例不应进入系统异常日志分支');
    },
    buildBalanceGapConfirmResult: (gaps, generatedFiles) => {
      gapResults.push({ gaps, generatedFiles });
      return { status: 'manual-balance-required', gapCount: gaps.length };
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
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanStatementBalanceSeedStatus(input, ensureStorageRoot()),
    splitTemplateName,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows
  });
}

function prepareGapBatch(root, generation) {
  const filePath = writeSourceWorkbook(root, 'gap.xlsx', [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
    ['2026-09-01', 'M001', 'USD', '100', ''],
    ['2026-09-04', 'M001', 'USD', '10', '']
  ]);
  const rows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
  const config = {
    template: { name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: true,
    balanceMode: 'calculated'
  };
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({
    config,
    fileEntries: [{ filePath, detailRows: rows }]
  });
  return { config, preparedBatch, filePath };
}

test('生成层：未确认断档时只出明细，不写余额表和计算种子，结果交给断档确认', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const gapResults = [];
  const generation = createGenerationSeam(storageRoot, { gapResults });
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD',
    billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
  });
  const { config, preparedBatch, filePath } = prepareGapBatch(root, generation);
  const generated = generation.generateStatementFiles({ config, preparedBatch });
  assert.ok(generated.detail && fs.existsSync(generated.detail.filePath));
  assert.equal(generated.balance, null);
  assert.deepEqual(generated.warnings.map((warning) => warning.type), ['balance-gap-confirm']);
  assert.equal(generated.warnings[0].gaps[0].key, '中行-上海|M001|USD|2026-09-01|2026-09-04');
  assert.deepEqual(readBalanceSeedRecords(storageRoot, '中行').map((record) => record.billDate), ['2026-08-31']);

  const importResult = generation.buildImportResultFromGeneratedFiles({
    generatedFiles: generated,
    templateId: 1,
    templateName: TEMPLATE_NAME,
    inputFilePaths: [filePath]
  });
  assert.deepEqual(importResult, { status: 'manual-balance-required', gapCount: 1 });
  assert.equal(gapResults.length, 1);
  assert.equal(gapResults[0].gaps[0].targetBillDate, '2026-09-04');
});

test('生成层：确认不补录后照常生成余额表与计算种子，并带上跳过告警', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const generation = createGenerationSeam(storageRoot, {
    acknowledgedKeys: new Set(['中行-上海|M001|USD|2026-09-01|2026-09-04'])
  });
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD',
    billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
  });
  const { config, preparedBatch } = prepareGapBatch(root, generation);
  const generated = generation.generateStatementFiles({ config, preparedBatch });
  assert.ok(generated.balance && fs.existsSync(generated.balance.filePath));
  assert.deepEqual(generated.warnings.map((warning) => warning.type), ['balance-gap-skipped']);
  const workbook = XLSX.readFile(generated.balance.filePath, { raw: true });
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const header = sheetRows[0];
  const dateIndex = header.indexOf('账单日期');
  const balanceIndex = header.indexOf('期末余额');
  // 余额表的账单日期是 Excel 日期单元格，按序列号还原后核对。
  const dateLabel = (serial) => {
    const { y, m, d } = XLSX.SSF.parse_date_code(serial);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  assert.deepEqual(sheetRows.slice(1).map((row) => [dateLabel(row[dateIndex]), row[balanceIndex]]), [
    ['2026-09-01', 1100],
    ['2026-09-04', 1110]
  ]);
  assert.deepEqual(
    readBalanceSeedRecords(storageRoot, '中行').map((record) => [record.billDate, record.endBalance]),
    [['2026-08-31', 1000], ['2026-09-01', 1100], ['2026-09-04', 1110]]
  );
});

test('主进程：断档确认结果与不补录告警文案', () => {
  const formatBalanceGapLine = loadMainFunction('formatBalanceGapLine');
  const gap = {
    key: '中行-上海|M001|USD|2026-09-01|2026-09-04',
    templateName: TEMPLATE_NAME,
    bankName: '中行',
    merchantId: 'M001',
    currency: 'USD',
    anchorDate: '2026-09-01',
    anchorSource: 'file',
    targetBillDate: '2026-09-04',
    missingFrom: '2026-09-02',
    missingTo: '2026-09-03',
    suggestedSeedDate: '2026-09-03'
  };
  const logs = [];
  const buildBalanceGapConfirmResult = loadMainFunction(
    'buildBalanceGapConfirmResult',
    ['clearLastErrorReport', 'lastPendingBalanceSeedConfirmation', 'lastManualBalancePrompt', 'appendActivityLogEntry', 'formatBalanceGapLine'],
    [() => {}, null, null, (entry) => logs.push(entry), formatBalanceGapLine]
  );
  const result = buildBalanceGapConfirmResult([gap], { detail: { filePath: '/tmp/detail.xlsx' } });
  assert.equal(result.status, 'manual-balance-required');
  assert.equal(result.message, '账单日期不连续（1 处），请确认是否补录断档前一日的期末余额');
  assert.equal(result.detailReady, true);
  assert.equal(result.balanceReady, false);
  assert.equal(result.manualBalancePromptReady, true);
  assert.equal(result.manualBalancePrompt.reason, 'gap');
  assert.equal(result.manualBalancePrompt.targetBillDate, '2026-09-04');
  assert.equal(result.manualBalancePrompt.suggestedSeedDate, '2026-09-03');
  assert.equal(result.manualBalancePrompt.gapKey, gap.key);
  assert.equal(result.manualBalancePrompt.gaps.length, 1);
  assert.equal(logs[0].details[1], '银行账号：M001，币种：USD，2026-09-01 之后下一个账单日是 2026-09-04，缺 2026-09-02 ~ 2026-09-03');

  const buildImportWarningMessage = loadMainFunction('buildImportWarningMessage');
  const buildImportWarningDetailLines = loadMainFunction(
    'buildImportWarningDetailLines',
    ['formatBalanceGapLine'],
    [formatBalanceGapLine]
  );
  const warnings = [{ type: 'balance-gap-skipped', gaps: [gap, { ...gap, missingFrom: '2026-09-03', missingTo: '2026-09-03' }] }];
  assert.equal(
    buildImportWarningMessage({ warnings, balanceReady: true, balanceRequested: true }),
    '明细账单可导出，余额账单可导出，2处账单日期不连续未补录，余额可能不准确，请点击状态框导出报错文件'
  );
  assert.deepEqual(buildImportWarningDetailLines(warnings), [
    '以下账单日期不连续且未补录期末余额，断档后的余额按断档前的余额接着计算，可能不准确：',
    '银行账号：M001，币种：USD，2026-09-01 之后下一个账单日是 2026-09-04，缺 2026-09-02 ~ 2026-09-03',
    '银行账号：M001，币种：USD，2026-09-01 之后下一个账单日是 2026-09-04，缺 2026-09-03'
  ]);
});

const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';

function findMainNode(predicate) {
  let found = null;
  const visit = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (predicate(node)) {
      found = node;
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(MAIN_AST);
  return found;
}

// 取真实 file:save-balance-seed 的 execute，只替换它依赖的主进程函数。
function loadSaveBalanceSeedExecute(deps) {
  const call = findMainNode((node) => (
    node.type === 'CallExpression'
    && node.callee.name === 'businessIpcHandle'
    && node.arguments[0]
    && node.arguments[0].value === 'file:save-balance-seed'
  ));
  const executeNode = call.arguments[2].properties.find((prop) => prop.key.name === 'execute');
  const names = Object.keys(deps);
  return Function(
    ...names,
    `return ({ ${MAIN_SOURCE.slice(executeNode.start, executeNode.end)} }).execute;`
  )(...names.map((name) => deps[name]));
}

function virtualExportAllDeps({ session, groups, generated }) {
  const remembered = [];
  const gapGeneration = createStatementGenerationHelpers({});
  const exportTemplateConfig = (tid) => ({
    template: { id: tid, name: `模板${tid}` },
    exportMappings: [],
    exportTargetFields: []
  });
  const deps = {
    groupStatementEntriesForGeneration: loadGroupingFunction(exportTemplateConfig),
    findGenerationGroupBalanceModeMismatch: loadBalanceModeMismatchFunction(exportTemplateConfig),
    ...loadOutputNameConflictFunctions(),
    FILENAME_MAPPING_TEMPLATE_ID,
    getCurrentStatementSession: () => session,
    isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
    getGeneratedStatementExport: () => null,
    getStatementSessionEntries: () => groups.map((tid) => ({ matchedTemplateId: tid })),
    getTemplateMappingConfig: (tid) => ({
      template: { id: tid, name: `模板${tid}` },
      exportMappings: [],
      exportTargetFields: []
    }),
    appendActivityLogEntry: () => {},
    buildStatementGenerationConfig: ({ template }) => ({ template }),
    buildPreparedStatementBatchFromEntries: ({ config }) => ({ detailRows: [], tid: config.template.id }),
    rememberLastFileImportContext: (context) => remembered.push(context),
    createGenerationContext: (context) => context,
    generateStatementFiles: ({ preparedBatch }) => generated[preparedBatch.tid],
    parseRequiredBillDates: () => [],
    extractManualBalancePromptWarning: gapGeneration.extractManualBalancePromptWarning,
    statementGenerationHelpers: gapGeneration,
    buildManualBalanceRequiredResult: (prompt) => ({ status: 'manual-balance-required', manualBalancePrompt: prompt }),
    buildBalanceGapConfirmResult: (gaps) => ({ status: 'manual-balance-required', manualBalancePrompt: { reason: 'gap', gaps } })
  };
  return { deps, remembered };
}

function loadExportStatementByScope(deps) {
  const names = Object.keys(deps);
  return loadMainFunction('exportStatementByScope', names, names.map((name) => deps[name]));
}

test('主进程：按文件名映射导出全部余额遇到断档或首次补录时，记下按全部模板组重算的上下文', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2' };
  const gap = { key: '模板1|M001|USD|2026-09-01|2026-09-04', merchantId: 'M001', currency: 'USD' };
  const cases = [
    { label: '断档', warnings: [{ type: 'balance-gap-confirm', gaps: [gap] }] },
    { label: '首次补录', warnings: [{ type: 'balance-seed-required', prompt: { merchantId: 'M001', currency: 'USD' } }] }
  ];
  for (const { label, warnings } of cases) {
    // 模板 1 待处理，模板 2 正常；循环最后记下的是模板 2 的单模板上下文。
    const { deps, remembered } = virtualExportAllDeps({
      session,
      groups: [1, 2],
      generated: {
        1: { balance: null, warnings },
        2: { balance: { filePath: '/tmp/balance-2.xlsx' }, warnings: [] }
      }
    });
    const result = await loadExportStatementByScope(deps)('balance', 'all');
    assert.equal(result.status, 'manual-balance-required', label);
    const finalContext = remembered[remembered.length - 1];
    assert.equal(finalContext.templateId, FILENAME_MAPPING_TEMPLATE_ID, label);
    assert.equal(finalContext.scope, 'all', label);
    assert.equal(finalContext.statementSessionKey, 'session-1', label);
  }
});

test('主进程：按文件名映射全部范围补录或不补录后，按全部模板组重算并只更新全部余额缓存', async () => {
  const gap = { key: '模板1|M001|USD|2026-09-01|2026-09-04', merchantId: 'M001', currency: 'USD' };
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2' };
  const merged = { filePath: '/tmp/2-BALANCE.xlsx' };
  for (const scope of ['all', 'current']) {
    const calls = { regenerate: [], cacheAll: [] };
    const lastGeneratedExports = { detail: { filePath: '/tmp/detail.xlsx' }, balance: { filePath: '/tmp/current-balance.xlsx' } };
    const execute = loadSaveBalanceSeedExecute({
      FILENAME_MAPPING_TEMPLATE_ID,
      FileValidationError,
      isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
      ...seedSaveGroupingDeps(),
      rememberAcknowledgedBalanceGaps: () => true,
      appendActivityLogEntry: () => {},
      formatBalanceGapLine: () => '',
      regenerateVirtualTemplateBalanceFromSession: (target, regenerateScope) => {
        calls.regenerate.push([target, regenerateScope]);
        return { needsSeed: false, generatedFiles: { detail: null, balance: merged, warnings: [] } };
      },
      lastGeneratedExports,
      cacheAllStatementExport: (kind, file) => calls.cacheAll.push([kind, file]),
      buildImportResultFromGeneratedFiles: ({ generatedFiles }) => ({ status: 'success', balance: generatedFiles.balance })
    });
    const result = await execute(null, {
      plan: null,
      skipBalanceGapKeys: [gap.key],
      skippedBalanceGaps: [gap],
      pendingPrompt: { reason: 'gap', templateName: '模板1', gaps: [gap] },
      session,
      importContext: { templateId: FILENAME_MAPPING_TEMPLATE_ID, scope, template: { name: '模板2' } }
    }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });

    assert.equal(result.status, 'success', scope);
    assert.deepEqual(calls.regenerate, [[session, scope]], scope);
    if (scope === 'all') {
      assert.deepEqual(calls.cacheAll, [['balance', merged]]);
      assert.equal(lastGeneratedExports.balance.filePath, '/tmp/current-balance.xlsx');
    } else {
      assert.deepEqual(calls.cacheAll, []);
      assert.equal(lastGeneratedExports.balance, merged);
    }
  }
});

// 补录后按会话全部分组重新生成前的输出名称核对：模板 1、模板 2 两组普通模板。
function seedSaveGroupingDeps(database) {
  const templateConfig = (tid) => ({ template: { id: tid, name: `模板${tid}` }, exportMappings: [], exportTargetFields: [] });
  return {
    groupStatementEntriesForGeneration: loadGroupingFunction(templateConfig),
    getStatementSessionEntries: () => [{ matchedTemplateId: 1 }, { matchedTemplateId: 2 }],
    ...loadOutputNameConflictFunctions(database)
  };
}

test('主进程：按文件名映射补录时，会话里的模板与库里的渠道同名则先阻断，不写入种子也不重新生成（release/v3.2.15 审查）', async () => {
  const calls = { seed: 0, regenerate: 0, cleared: 0 };
  const execute = loadSaveBalanceSeedExecute({
    FILENAME_MAPPING_TEMPLATE_ID,
    FileValidationError,
    isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
    ...seedSaveGroupingDeps({ listStatementOutputOwners: () => ({ templates: [], channels: [{ id: 9, name: ' 模板1 ' }] }) }),
    writeManualBalanceSeedPlan: () => { calls.seed += 1; },
    regenerateVirtualTemplateBalanceFromSession: () => { calls.regenerate += 1; return { needsSeed: false, generatedFiles: {} }; },
    appendActivityLogEntry: () => {},
    clearPendingManualBalancePrompt: () => { calls.cleared += 1; },
    createErrorResult: (payload) => ({ status: 'error', ...payload })
  });
  const result = await execute(null, {
    plan: { record: { templateName: '模板1', merchantId: 'M001', currency: 'USD', billDate: '2026-08-31', endBalance: '1000' } },
    skipBalanceGapKeys: null,
    pendingPrompt: { templateName: '模板1' },
    session: { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID },
    importContext: { templateId: FILENAME_MAPPING_TEMPLATE_ID, scope: 'current', template: { name: '按文件名映射模板' } }
  }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'STATEMENT_OUTPUT_NAME_CONFLICT');
  assert.deepEqual(result.detailLines, ['输出名称「模板1」：模板「模板1」、渠道「模板1」']);
  assert.deepEqual(calls, { seed: 0, regenerate: 0, cleared: 1 });
});

// 指定模板（非虚拟 ID）的会话：库里有输出名称只差大小写的渠道。
const NAME_CONFLICT_DATABASE = {
  listStatementOutputOwners: () => ({ templates: [{ id: 5, name: 'bank-sg' }, { id: 6, name: '模板6' }], channels: [{ id: 9, name: 'BANK-SG' }] }),
  getTemplate: (id) => ({ id, name: id === 5 ? 'bank-sg' : `模板${id}`, channelId: null }),
  countStatementChannelAccountMappingConflicts: () => 0
};
const singleTemplateConfig = (tid) => ({
  template: { id: tid, name: tid === 5 ? 'bank-sg' : `模板${tid}`, channelId: null },
  exportMappings: [],
  exportTargetFields: []
});

test('主进程：指定模板会话导出全部重新生成前，模板与库里渠道的输出名称相同则阻断，不记上下文也不生成（release/v3.2.15 复审）', async () => {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  for (const [label, templateId, expected] of [
    ['同名', 5, ['输出名称「bank-sg」：模板「bank-sg」、渠道「BANK-SG」']],
    ['不同名', 6, null]
  ]) {
    const calls = { context: 0, remembered: 0, generate: 0 };
    const exportAll = loadExportStatementByScope({
      ...loadOutputNameConflictFunctions(NAME_CONFLICT_DATABASE),
      resolveGenerationGroupKey,
      getCurrentStatementSession: () => ({ key: 'session-1', templateId, templateName: `模板${templateId}` }),
      isFilenameMappingMode: () => false,
      getGeneratedStatementExport: () => null,
      getTemplateMappingConfig: singleTemplateConfig,
      getStatementSessionEntries: () => [{ matchedTemplateId: templateId }],
      resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      buildStatementSessionGenerationContext: () => { calls.context += 1; return { config: {}, preparedBatch: { detailRows: [] } }; },
      rememberLastFileImportContext: () => { calls.remembered += 1; },
      createGenerationContext: (context) => context,
      generateStatementFiles: () => { calls.generate += 1; throw new Error('reached-generation'); }
    });
    if (expected) {
      const result = await exportAll('balance', 'all');
      assert.equal(result.errorCode, 'STATEMENT_OUTPUT_NAME_CONFLICT', label);
      assert.deepEqual(result.detailLines, expected, label);
      assert.deepEqual(calls, { context: 0, remembered: 0, generate: 0 }, label);
    } else {
      await assert.rejects(exportAll('balance', 'all'), /reached-generation/, label);
      assert.deepEqual(calls, { context: 1, remembered: 1, generate: 1 }, label);
    }
  }
});

// 生成入口的统一核对：按本次实际使用的模板配置，身份取库里模板当前的归属。
function loadGenerationWrappers(database, calls) {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  const assertGenerationOutputNameUnique = loadMainFunction(
    'assertGenerationOutputNameUnique',
    ['database', 'resolveGenerationGroupKey', 'findGenerationGroupOutputNameConflicts', 'buildStatementOutputNameConflictError'],
    [database, resolveGenerationGroupKey, ...Object.values(loadOutputNameConflictFunctions(database))]
  );
  const statementGenerationHelpers = {
    generateStatementFiles: () => { calls.generate += 1; return {}; },
    generateFilesFromRememberedContext: () => { calls.remembered += 1; return {}; }
  };
  const deps = [['assertGenerationOutputNameUnique', 'statementGenerationHelpers'], [assertGenerationOutputNameUnique, statementGenerationHelpers]];
  return {
    assertGenerationOutputNameUnique,
    generateStatementFiles: loadMainFunction('generateStatementFiles', ...deps),
    generateFilesFromRememberedContext: loadMainFunction('generateFilesFromRememberedContext', ...deps)
  };
}

test('主进程：生成入口按本次使用的模板配置核对输出名称，等待期间改名造成同名时阻断（release/v3.2.15 复审）', () => {
  const calls = { generate: 0, remembered: 0 };
  // 库里：渠道 BANK-SG（id 9）；模板 7 导入后已移入同名渠道 11「CMB-SH」。
  const database = {
    listStatementOutputOwners: () => ({ templates: [{ id: 5, name: 'other' }], channels: [{ id: 9, name: 'BANK-SG' }, { id: 11, name: 'CMB-SH' }] }),
    getTemplate: (id) => (id === 7 ? { id: 7, name: 'CMB-SH', channelId: 11, channelName: 'CMB-SH' } : { id, name: 'renamed', channelId: null })
  };
  const wrappers = loadGenerationWrappers(database, calls);
  const stale = { id: 5, name: 'bank-sg', channelId: null };
  for (const [label, run] of [
    ['生成文件', () => wrappers.generateStatementFiles({ config: { template: stale } })],
    ['按记下的上下文生成', () => wrappers.generateFilesFromRememberedContext({ template: stale })]
  ]) {
    assert.throws(run, (error) => error.code === 'STATEMENT_OUTPUT_NAME_CONFLICT'
      && error.detailLines[0] === '输出名称「bank-sg」：模板「bank-sg」、渠道「BANK-SG」', label);
  }
  assert.deepEqual(calls, { generate: 0, remembered: 0 });
  // 导入后移入同名渠道的模板：身份按当前归属，与自己的渠道不冲突；按文件名映射的虚拟模板跳过。
  wrappers.generateStatementFiles({ config: { template: { id: 7, name: 'CMB-SH', channelId: null } } });
  wrappers.generateFilesFromRememberedContext({ template: { id: '__FILENAME_MAPPING__', name: 'BANK-SG' } });
  assert.deepEqual(calls, { generate: 1, remembered: 1 });
});

test('主进程：指定模板补录时记下的模板与库里渠道的输出名称相同，先阻断，不写入种子也不重新生成（release/v3.2.15 复审）', async () => {
  for (const scope of ['current', 'all']) {
    const calls = { seed: 0, generate: 0 };
    const wrappers = loadGenerationWrappers(NAME_CONFLICT_DATABASE, { generate: 0, remembered: 0 });
    const execute = loadSaveBalanceSeedExecute({
      FILENAME_MAPPING_TEMPLATE_ID,
      FileValidationError,
      isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
      assertGenerationOutputNameUnique: wrappers.assertGenerationOutputNameUnique,
      writeManualBalanceSeedPlan: () => { calls.seed += 1; },
      generateFilesFromRememberedContext: () => { calls.generate += 1; return {}; },
      appendActivityLogEntry: () => {},
      clearPendingManualBalancePrompt: () => {},
      createErrorResult: (payload) => ({ status: 'error', ...payload })
    });
    const result = await execute(null, {
      plan: { record: { templateName: 'bank-sg', merchantId: 'M001', currency: 'USD', billDate: '2026-08-31', endBalance: '1000' } },
      skipBalanceGapKeys: null,
      pendingPrompt: { templateName: 'bank-sg' },
      session: null,
      importContext: { templateId: 5, scope, template: { id: 5, name: 'bank-sg', channelId: null } }
    }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });
    assert.equal(result.errorCode, 'STATEMENT_OUTPUT_NAME_CONFLICT', scope);
    assert.deepEqual(result.detailLines, ['输出名称「bank-sg」：模板「bank-sg」、渠道「BANK-SG」'], scope);
    assert.deepEqual(calls, { seed: 0, generate: 0 }, scope);
  }
});

// 指定模板导入的 execute 是 registerFileHandlers 里任务对象的方法，按 AST 取出单独运行。
function loadSingleTemplateImportExecute(deps) {
  const register = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'registerFileHandlers');
  const hits = [];
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Property' && node.key && node.key.name === 'execute'
      && node.value.params.length === 4 && node.value.params[3].name === 'templateId') hits.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  })(register);
  assert.equal(hits.length, 1, '指定模板导入的 execute 应唯一');
  const method = hits[0].value;
  const source = `async function execute${MAIN_SOURCE.slice(method.params[0].start - 1, method.end)}`;
  const names = Object.keys(deps);
  return Function(...names, `return (${source});`)(...names.map((name) => deps[name]));
}

test('主进程：指定模板导入时模板与库里渠道的输出名称相同，在建立会话前阻断（release/v3.2.15 复审）', async () => {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  for (const [label, templateId, expected] of [
    ['同名', 5, ['输出名称「bank-sg」：模板「bank-sg」、渠道「BANK-SG」']],
    ['不同名', 6, null]
  ]) {
    const calls = { session: 0 };
    const execute = loadSingleTemplateImportExecute({
      ...loadOutputNameConflictFunctions(NAME_CONFLICT_DATABASE),
      resolveGenerationGroupKey,
      database: NAME_CONFLICT_DATABASE,
      fileImportInProgress: false,
      bindStatementImportPreparedToFileEvidence: (prepared) => prepared,
      isFilenameMappingMode: () => false,
      clearPendingManualBalancePrompt: () => {},
      clearPendingBigAccountSelection: () => {},
      clearGeneratedExports: () => {},
      getTemplateMappingConfig: singleTemplateConfig,
      STATEMENT_SOURCE_FRESHNESS_FAILURE: { code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE' },
      FileValidationError,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      statementImportSessionForInvocation: () => { calls.session += 1; throw new FileValidationError('REACHED_SESSION', '已进入建立会话'); }
    });
    const prepared = { previewOnly: false, inputFilePaths: ['/tmp/a.xlsx'] };
    const taskContext = { fileEvidence: { filePlan: { inputs: [] } } };
    const result = await execute(null, prepared, taskContext, templateId);
    if (expected) {
      assert.equal(result.errorCode, 'STATEMENT_OUTPUT_NAME_CONFLICT', label);
      assert.deepEqual(result.detailLines, expected, label);
      assert.equal(calls.session, 0, label);
    } else {
      assert.equal(result.errorCode, 'REACHED_SESSION', label);
      assert.equal(calls.session, 1, label);
    }
  }
});

function loadOutputPathHelpers(storageRoot, today) {
  const sanitizeFileName = loadMainFunction('sanitizeFileName');
  const buildOutputFilePath = loadMainFunction(
    'buildOutputFilePath',
    ['getToday', 'path', 'ensureStorageRoot', 'sanitizeFileName'],
    [() => today, path, () => storageRoot, sanitizeFileName]
  );
  const mergeGeneratedXlsxFiles = loadMainFunction(
    'mergeGeneratedXlsxFiles',
    ['require', 'fs', 'path', 'applyWatermark'],
    [require, fs, path, () => {}]
  );
  return {
    buildOutputFilePath,
    mergeGeneratedXlsxFiles,
    scopedMergedOutputFileName: loadMainFunction('scopedMergedOutputFileName')
  };
}

test('主进程：按文件名映射导出全部的汇总文件与当前批次汇总文件路径隔离，对外文件名不变', async (t) => {
  const root = createTempRoot(t);
  const { buildOutputFilePath, scopedMergedOutputFileName } = loadOutputPathHelpers(root, '2026-10-28');
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2' };
  const merged = [];
  const { deps } = virtualExportAllDeps({
    session,
    groups: [1, 2],
    generated: {
      1: { balance: { filePath: '/tmp/group-1__all.xlsx' }, warnings: [] },
      2: { balance: { filePath: '/tmp/group-2__all.xlsx' }, warnings: [] }
    }
  });
  const result = await loadExportStatementByScope({
    ...deps,
    parseRequiredBillDates: () => ['2026-09-01', '2026-09-02'],
    buildDateRangeLabel,
    getToday: () => '2026-10-28',
    path,
    buildOutputFilePath,
    scopedMergedOutputFileName,
    mergeGeneratedXlsxFiles: (paths, mergedPath) => merged.push(mergedPath),
    exportGeneratedFile: async (generatedFile) => ({ status: 'success', generatedFile })
  })('balance', 'all');

  const currentBatchPath = buildOutputFilePath({ kind: 'balance', outputFileName: '2-BALANCE-2026-09-01~2026-09-02.xlsx' }).outputFilePath;
  assert.equal(result.status, 'success');
  assert.equal(result.generatedFile.fileName, '2-BALANCE-2026-09-01~2026-09-02.xlsx');
  assert.deepEqual(merged, [result.generatedFile.filePath]);
  assert.notEqual(result.generatedFile.filePath, currentBatchPath);
});

function mappedSourceEntry(root, fileName, rows) {
  const filePath = writeSourceWorkbook(root, fileName, [['Date', 'Account', 'Curr', 'Credit', 'Debit'], ...rows]);
  const detailRows = buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: HEADER,
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
  return { filePath, detailRows, matchedTemplateId: 1 };
}

function balanceMerchantIds(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  const index = rows[0].indexOf('银行账号');
  return [...new Set(rows.slice(1).map((row) => row[index]))].sort();
}

test('主进程：按文件名映射单模板组补录或不补录后重算，当前批次余额不被“导出全部”的同名文件覆盖', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const generation = createGenerationSeam(storageRoot);
  for (const merchantId of ['M001', 'M002']) {
    upsertBalanceSeedRecord(storageRoot, {
      templateName: TEMPLATE_NAME, merchantId, currency: 'USD',
      billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
    });
  }
  // 历史批次只有 M001，当前批次只有 M002，同一模板、同一日期范围。
  const history = mappedSourceEntry(root, 'history.xlsx', [['2026-09-01', 'M001', 'USD', '100', ''], ['2026-09-02', 'M001', 'USD', '5', '']]);
  const current = mappedSourceEntry(root, 'current.xlsx', [['2026-09-01', 'M002', 'USD', '100', ''], ['2026-09-02', 'M002', 'USD', '5', '']]);
  const singleTemplateConfig = () => ({ template: { name: TEMPLATE_NAME }, exportMappings: [], exportTargetFields: [] });
  const regenerate = loadMainFunction(
    'regenerateVirtualTemplateBalanceFromSession',
    ['getStatementSessionEntries', 'groupStatementEntriesForGeneration', 'getTemplateMappingConfig', 'appendActivityLogEntry', 'buildStatementGenerationConfig',
      'buildPreparedStatementBatchFromEntries', 'generateStatementFiles', 'parseRequiredBillDates',
      'extractManualBalancePromptWarning', 'statementGenerationHelpers', 'path',
      'findGenerationGroupOutputPathConflicts', 'buildStatementOutputPathConflictError'],
    [
      (_session, scope) => (scope === 'all' ? [history, current] : [current]),
      loadGroupingFunction(singleTemplateConfig),
      singleTemplateConfig,
      () => {},
      ({ template }) => ({
        template,
        mappingByTargetField: { MerchantId: 'Account' },
        balanceRequested: true,
        balanceMode: 'calculated'
      }),
      generation.buildPreparedStatementBatchFromEntries,
      generation.generateStatementFiles,
      parseRequiredBillDates,
      generation.extractManualBalancePromptWarning,
      generation,
      path,
      ...Object.values(loadOutputPathConflictFunctions())
    ]
  );

  const currentResult = regenerate({ key: 'session-1' }, 'current');
  assert.equal(currentResult.needsSeed, false);
  const currentPath = currentResult.generatedFiles.balance.filePath;
  assert.deepEqual(balanceMerchantIds(currentPath), ['M002']);

  const allResult = regenerate({ key: 'session-1' }, 'all');
  assert.equal(allResult.needsSeed, false);
  assert.notEqual(allResult.generatedFiles.balance.filePath, currentPath);
  assert.deepEqual(balanceMerchantIds(allResult.generatedFiles.balance.filePath), ['M001', 'M002']);
  assert.deepEqual(balanceMerchantIds(currentPath), ['M002']);
});

function findFileNames(root, pattern) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map((name) => path.basename(String(name)))
    .filter((name) => pattern.test(name));
}

test('主进程：按文件名映射多模板导入，任一模板组需补录或确认断档时不合并、不缓存部分余额', (t) => {
  for (const scenario of ['gap', 'seed-required']) {
    const root = createTempRoot(t);
    const storageRoot = path.join(root, 'storage');
    const generation = createGenerationSeam(storageRoot);
    const { buildOutputFilePath, mergeGeneratedXlsxFiles } = loadOutputPathHelpers(storageRoot, '2026-10-29');
    // 三个模板各一个账号；第三组断档（9-02、9-03 缺失）或没有首次种子，其余两组可以算出余额。
    const groups = [
      { id: 1, templateName: '中行-上海', merchantId: 'M001', dates: ['2026-09-01', '2026-09-02'] },
      { id: 2, templateName: '中行-北京', merchantId: 'M002', dates: ['2026-09-01', '2026-09-02'] },
      { id: 3, templateName: '中行-深圳', merchantId: 'M003', dates: scenario === 'gap' ? ['2026-09-01', '2026-09-04'] : ['2026-09-01', '2026-09-02'] }
    ];
    for (const group of groups) {
      if (scenario === 'seed-required' && group.id === 3) continue;
      upsertBalanceSeedRecord(storageRoot, {
        templateName: group.templateName, merchantId: group.merchantId, currency: 'USD',
        billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
      });
    }
    const fileEntries = groups.map((group) => ({
      ...mappedSourceEntry(root, `${scenario}-${group.id}.xlsx`, group.dates.map((date) => [date, group.merchantId, 'USD', '100', ''])),
      matchedTemplateId: group.id
    }));
    const templateNameById = new Map(groups.map((group) => [group.id, group.templateName]));
    const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };
    const imported = [];
    const dependencies = {
      groupStatementEntriesForGeneration: loadGroupingFunction((tid) => ({ template: { id: tid, name: templateNameById.get(tid) } })),
      assertGenerationOutputNameUnique: () => {},
      ...loadOutputPathConflictFunctions(),
      getEntryTemplateConfig: ({ entry }) => ({
        template: { name: templateNameById.get(entry.matchedTemplateId) },
        exportMappings: [{ templateField: 'MerchantId', mappedField: 'Account' }],
        exportTargetFields: HEADER
      }),
      normalizeCell,
      FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
      MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI__',
      buildStatementGenerationConfig: ({ template }) => ({
        template,
        mappingByTargetField: { MerchantId: 'Account' },
        balanceRequested: true,
        balanceMode: 'calculated'
      }),
      rebuildMatchedTemplateFileEntries: () => {
        throw new Error('未选择大账号时不应重建');
      },
      buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
      removeStatementSessionEntriesByFilePath: () => {},
      generateStatementFiles: generation.generateStatementFiles,
      parseRequiredBillDates,
      buildDateRangeLabel,
      getToday: () => '2026-10-29',
      buildOutputFilePath,
      mergeGeneratedXlsxFiles,
      path,
      buildStatementFileEntry: (entry) => entry,
      buildStatementFileEntryId: () => 'entry',
      appendStatementSessionImport: () => 'batch-1',
      buildStatementBatchId: () => 'batch-1',
      lastGeneratedExports,
      updateStatementSessionCache: (session, batchId, generatedFiles) => {
        generation.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
      },
      buildImportResultFromGeneratedFiles: ({ generatedFiles }) => {
        imported.push(generatedFiles);
        return { status: 'captured' };
      },
      FILENAME_MAPPING_TEMPLATE_ID
    };
    const generateGroups = loadMainFunction(
      'generateMultiTemplateGroupFiles',
      Object.keys(dependencies),
      Object.values(dependencies)
    );

    generateGroups({
      fileEntries,
      fallbackTemplateConfig: {},
      selectedBigAccount: null,
      session: { key: 'session-1' },
      inputFilePaths: fileEntries.map((entry) => entry.filePath)
    });

    const [generatedFiles] = imported;
    const pendingType = scenario === 'gap' ? 'balance-gap-confirm' : 'balance-seed-required';
    assert.deepEqual(generatedFiles.warnings.map((warning) => warning.type), [pendingType], scenario);
    assert.equal(generatedFiles.balance, null, scenario);
    assert.equal(generatedFiles.balanceRequested, true, scenario);
    assert.equal(lastGeneratedExports.balance, null, scenario);
    assert.deepEqual(findFileNames(storageRoot, /^3-BALANCE-/), [], scenario);
    // 明细照常合并；已算出的两组照常写出计算种子，待处理的一组不写。
    assert.match(generatedFiles.detail.fileName, /^3-COMMON-/, scenario);
    assert.ok(fs.existsSync(generatedFiles.detail.filePath), scenario);
    const computedSeeds = readBalanceSeedRecords(storageRoot, '中行')
      .filter((record) => record.billDate === '2026-09-02')
      .map((record) => record.merchantId)
      .sort();
    assert.deepEqual(computedSeeds, ['M001', 'M002'], scenario);
  }
});

test('主进程：按文件名映射导出全部余额时任一模板组余额生成失败即阻断，列出失败组，不合并、不导出', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const ok = (tid) => ({ balance: { filePath: `/tmp/group-${tid}__all.xlsx` }, warnings: [] });
  const failed = { balance: null, warnings: [{ type: 'balance-generate-failed', message: '2026-11-01 未找到期末余额' }] };
  const cases = [
    { label: '第一组失败', generated: { 1: failed, 2: ok(2), 3: ok(3) }, failedNames: ['模板1'] },
    { label: '中间组失败', generated: { 1: ok(1), 2: failed, 3: ok(3) }, failedNames: ['模板2'] },
    { label: '最后一组失败', generated: { 1: ok(1), 2: ok(2), 3: failed }, failedNames: ['模板3'] },
    { label: '全部失败', generated: { 1: failed, 2: failed, 3: failed }, failedNames: ['模板1', '模板2', '模板3'] }
  ];
  for (const { label, generated, failedNames } of cases) {
    const merged = [];
    const exported = [];
    const { deps } = virtualExportAllDeps({ session, groups: [1, 2, 3], generated });
    const result = await loadExportStatementByScope({
      ...deps,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      mergeGeneratedXlsxFiles: (paths) => merged.push(paths),
      exportGeneratedFile: async (generatedFile) => {
        exported.push(generatedFile);
        return { status: 'success' };
      }
    })('balance', 'all');

    assert.equal(result.status, 'error', label);
    assert.equal(result.step, '导出余额账单', label);
    assert.equal(result.errorCode, 'EXPORT_EMPTY', label);
    assert.equal(
      result.message,
      `余额账单未导出：${failedNames.length} 个模板组的余额生成失败，导出全部会缺少这些组的账户余额，请处理后重新导出`,
      label
    );
    assert.deepEqual(result.detailLines, failedNames.map((name) => `${name}：2026-11-01 未找到期末余额`), label);
    assert.deepEqual(merged, [], label);
    assert.deepEqual(exported, [], label);
  }
});

test('主进程：按文件名映射全部范围补录后重算，任一模板组余额生成失败时不缓存缺组的全部余额', async () => {
  const gap = { key: '模板1|M001|USD|2026-09-01|2026-09-04', merchantId: 'M001', currency: 'USD' };
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2' };
  const partial = { filePath: '/tmp/1-BALANCE.xlsx' };
  const cacheAll = [];
  const execute = loadSaveBalanceSeedExecute({
    FILENAME_MAPPING_TEMPLATE_ID,
    FileValidationError,
    isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
    ...seedSaveGroupingDeps(),
    rememberAcknowledgedBalanceGaps: () => true,
    appendActivityLogEntry: () => {},
    formatBalanceGapLine: () => '',
    regenerateVirtualTemplateBalanceFromSession: () => ({
      needsSeed: false,
      generatedFiles: {
        detail: null,
        balance: partial,
        warnings: [{ type: 'balance-generate-failed', message: '2026-09-02 未找到期末余额' }]
      }
    }),
    lastGeneratedExports: { detail: null, balance: null },
    cacheAllStatementExport: (kind, file) => cacheAll.push([kind, file]),
    buildImportResultFromGeneratedFiles: ({ generatedFiles }) => ({ status: 'success', warnings: generatedFiles.warnings })
  });
  const result = await execute(null, {
    plan: null,
    skipBalanceGapKeys: [gap.key],
    skippedBalanceGaps: [gap],
    pendingPrompt: { reason: 'gap', templateName: '模板1', gaps: [gap] },
    session,
    importContext: { templateId: FILENAME_MAPPING_TEMPLATE_ID, scope: 'all', template: { name: '模板2' } }
  }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });

  assert.equal(result.warnings[0].type, 'balance-generate-failed');
  // 缓存清空：再次“导出全部”时重新生成并由导出层按失败组阻断，不直接导出缺组文件。
  assert.deepEqual(cacheAll, [['balance', null]]);
});

test('主进程：导出全部余额阻断时渠道组按渠道名列出失败组', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const { deps } = virtualExportAllDeps({
    session,
    groups: [1, 2],
    generated: {
      1: { balance: null, warnings: [{ type: 'balance-generate-failed', message: '2026-11-01 未找到期末余额' }] },
      2: { balance: { filePath: '/tmp/group-2__all.xlsx' }, warnings: [] }
    }
  });
  const result = await loadExportStatementByScope({
    ...deps,
    // 生成配置的 outputName：属于渠道的模板为渠道名。
    buildStatementGenerationConfig: ({ template }) => ({ template, outputName: template.id === 1 ? '中行渠道-上海' : template.name }),
    createErrorResult: (payload) => ({ status: 'error', ...payload })
  })('balance', 'all');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.detailLines, ['中行渠道-上海：2026-11-01 未找到期末余额']);
});
