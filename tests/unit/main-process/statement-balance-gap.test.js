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
const { isDetailExportAmountRow } = require('../../../src/backend/file-service/normalizers');
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

// 嵌套在注册函数里的同名变量声明（如 IPC handler 用到的局部函数）：按源码求值，依赖由 deps 给出
function loadNestedMainDeclaration(name, deps = {}) {
  let declarator = null;
  (function visit(node) {
    if (!node || typeof node !== 'object' || declarator) return;
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === name) {
      declarator = node.init;
      return;
    }
    Object.values(node).forEach((value) => (Array.isArray(value) ? value.forEach(visit) : visit(value)));
  })(MAIN_AST);
  if (!declarator) throw new Error(`未找到 main.js 声明：${name}`);
  return Function(...Object.keys(deps), `return (${MAIN_SOURCE.slice(declarator.start, declarator.end)});`)(...Object.values(deps));
}

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

// 各组改为两个子模板组成的渠道组：渠道余额错误只可能来自余额方式不同的渠道组（整批失败后单模板组不再校验）
function asChannelGroups(grouping) {
  return (entries) => grouping(entries).map((group) => ({ ...group, templateIds: [...group.templateIds, group.templateIds[0] + 100] }));
}

// 普通模板组不做渠道余额方式校验，使用真实函数确认其对非渠道组直接放行。
function loadBalanceModeConflictFunction(getTemplateMappingConfig) {
  const identity = require('../../../src/main-process/statement-channel-identity');
  const { resolveAccountBalanceModes } = require('../../../src/main-process/statement-generation-business');
  const resolveGenerationGroupEntryBalanceModes = loadMainFunction(
    'resolveGenerationGroupEntryBalanceModes',
    ['getTemplateMappingConfig', 'resolveTemplateBalanceMode'],
    [getTemplateMappingConfig, identity.resolveTemplateBalanceMode]
  );
  const findGenerationGroupBalanceModeConflictGroup = loadMainFunction(
    'findGenerationGroupBalanceModeConflictGroup',
    ['resolveGenerationGroupEntryBalanceModes', 'resolveAccountBalanceModes', 'buildBalanceModeConflictGroup', 'resolveGenerationGroupChannelName'],
    [resolveGenerationGroupEntryBalanceModes, resolveAccountBalanceModes, () => null, () => '']
  );
  return loadMainFunction(
    'collectGenerationGroupBalanceModeConflicts',
    ['findGenerationGroupBalanceModeConflictGroup'],
    [findGenerationGroupBalanceModeConflictGroup]
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

// 补录重算拆为“规划 + 实际文件名核对 + 生成”：按同一套依赖装配真实的规划与核对函数。
function regenerationPlanDeps({
  getStatementSessionEntries,
  groupStatementEntriesForGeneration,
  buildStatementGenerationConfig,
  buildPreparedStatementBatchFromEntries,
  statementGenerationHelpers,
  database
}) {
  const pathFunctions = loadOutputPathConflictFunctions(database);
  // 写出前的只读校验：带真实生成辅助函数时用真实校验，桩批次（不含明细行）时不校验
  const assertStatementBatchWritable = statementGenerationHelpers
    ? statementGenerationHelpers.assertStatementBatchWritable
    : () => {};
  return {
    planVirtualTemplateBalanceRegeneration: loadMainFunction(
      'planVirtualTemplateBalanceRegeneration',
      ['getStatementSessionEntries', 'groupStatementEntriesForGeneration', 'buildStatementGenerationConfig', 'buildPreparedStatementBatchFromEntries', 'assertStatementBatchWritable', 'FileValidationError'],
      [getStatementSessionEntries, groupStatementEntriesForGeneration, buildStatementGenerationConfig, buildPreparedStatementBatchFromEntries, assertStatementBatchWritable, FileValidationError]
    ),
    assertVirtualTemplateBalanceOutputPaths: loadMainFunction(
      'assertVirtualTemplateBalanceOutputPaths',
      ['findGenerationGroupOutputPathConflicts', 'buildStatementOutputPathConflictError'],
      [pathFunctions.findGenerationGroupOutputPathConflicts, pathFunctions.buildStatementOutputPathConflictError]
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

// v3.2.16 起账单里的余额逐日校验：断档不单独确认，缺的日期无净发生额时余额对得上即通过。
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
    resolvePreviousBalanceSeed: () => seed('M001', 'USD', '2026-08-25', 1000)
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

// 导出全部余额带出已接受风险：真实 withAcceptedBalanceRiskWarnings + 真实告警明细，createWarningResult 记下载荷。
function acceptedRiskExportDeps(warningPayloads = []) {
  const formatBalanceAmount = loadMainFunction('formatBalanceAmount');
  const formatters = {
    formatBalanceGapLine: loadMainFunction('formatBalanceGapLine'),
    formatBalanceMismatchLine: loadMainFunction('formatBalanceMismatchLine', ['formatBalanceAmount'], [formatBalanceAmount]),
    formatBalanceSeedReplaceLine: loadMainFunction('formatBalanceSeedReplaceLine', ['formatBalanceAmount'], [formatBalanceAmount])
  };
  const buildImportWarningDetailLines = loadMainFunction(
    'buildImportWarningDetailLines', Object.keys(formatters), Object.values(formatters)
  );
  const createWarningResult = (payload) => {
    warningPayloads.push(payload);
    return { status: 'warning', message: payload.message, balanceReady: payload.balanceReady, errorReportReady: true };
  };
  return {
    withAcceptedBalanceRiskWarnings: loadMainFunction(
      'withAcceptedBalanceRiskWarnings',
      ['createWarningResult', 'buildImportWarningDetailLines'],
      [createWarningResult, buildImportWarningDetailLines]
    )
  };
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
    collectGenerationGroupBalanceModeConflicts: loadBalanceModeConflictFunction(exportTemplateConfig),
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
    // v3.2.21：导出全部执行时先逐组校验渠道余额（这里的组都不是余额方式不同的渠道）与写出前的检查（桩条目不含明细行）
    resolveEntryBalancePlan: () => null,
    assertStatementEntriesWritable: () => {},
    FileValidationError,
    // 生成配置失败的组按会话明细校验渠道余额（这里的组都没有问题）
    collectGroupBalanceIssuesWithoutConfig: () => {},
    rememberLastFileImportContext: (context) => remembered.push(context),
    createGenerationContext: (context) => context,
    generateStatementFiles: ({ preparedBatch }) => generated[preparedBatch.tid],
    parseRequiredBillDates: () => [],
    extractManualBalancePromptWarning: gapGeneration.extractManualBalancePromptWarning,
    statementGenerationHelpers: gapGeneration,
    buildManualBalanceRequiredResult: (prompt) => ({ status: 'manual-balance-required', manualBalancePrompt: prompt }),
    buildBalanceGapConfirmResult: (gaps) => ({ status: 'manual-balance-required', manualBalancePrompt: { reason: 'gap', gaps } }),
    buildBalanceMismatchConfirmResult: (mismatches) => ({
      status: 'manual-balance-required',
      manualBalancePrompt: { reason: 'mismatch', mismatches }
    }),
    buildBalanceSeedReplaceConfirmResult: (replacements) => ({
      status: 'manual-balance-required',
      manualBalancePrompt: { reason: 'seed-replace', replacements }
    }),
    ...acceptedRiskExportDeps()
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
  const mismatch = { key: 'mismatch|模板1|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00', merchantId: 'M001', currency: 'USD' };
  const cases = [
    { label: '断档', warnings: [{ type: 'balance-gap-confirm', gaps: [gap] }], reason: 'gap' },
    { label: '首次补录', warnings: [{ type: 'balance-seed-required', prompt: { merchantId: 'M001', currency: 'USD' } }] },
    // v3.2.16：账单里的余额不一致与断档同一通道。
    { label: '余额不一致', warnings: [{ type: 'balance-mismatch-confirm', mismatches: [mismatch] }], reason: 'mismatch' },
    {
      label: '人工补录替换',
      warnings: [{ type: 'balance-seed-replace-confirm', replacements: [{ key: 'seed-replace|模板1|M001|USD|2026-09-01|5000.00|1100.00' }] }],
      reason: 'seed-replace'
    }
  ];
  for (const { label, warnings, reason } of cases) {
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
    if (reason) assert.equal(result.manualBalancePrompt.reason, reason, label);
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
  // 重算的告警随“全部”余额一起缓存，再次导出全部命中缓存时带出（v3.2.16 D12）。
  const regenWarnings = [{ type: 'balance-gap-skipped', gaps: [gap] }];
  for (const scope of ['all', 'current']) {
    const calls = { regenerate: [], cacheAll: [] };
    const lastGeneratedExports = { detail: { filePath: '/tmp/detail.xlsx' }, balance: { filePath: '/tmp/current-balance.xlsx' } };
    const execute = loadSaveBalanceSeedExecute({
      FILENAME_MAPPING_TEMPLATE_ID,
      FileValidationError,
      isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
      ...seedSaveGroupingDeps(),
      // v3.2.19：补录后重算的提示附去重行数，按会话条目统计（真实生成辅助函数）
      statementGenerationHelpers: createStatementGenerationHelpers({}),
      rememberAcknowledgedBalanceGaps: () => true,
      appendActivityLogEntry: () => {},
      formatBalanceGapLine: () => '',
      regenerateVirtualTemplateBalanceFromSession: (target, regenerateScope, regenerationPlan) => {
        calls.regenerate.push([target, regenerateScope]);
        // 补录前已按同一份规划核对过实际文件名，重新生成直接复用。
        assert.equal(regenerationPlan.scope, regenerateScope);
        assert.equal(regenerationPlan.groupPlans.length, 2);
        return { needsSeed: false, generatedFiles: { detail: null, balance: merged, warnings: regenWarnings } };
      },
      lastGeneratedExports,
      cacheAllStatementExport: (kind, file, warnings) => calls.cacheAll.push([kind, file, warnings]),
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
      assert.deepEqual(calls.cacheAll, [['balance', merged, regenWarnings]]);
      assert.equal(lastGeneratedExports.balance.filePath, '/tmp/current-balance.xlsx');
    } else {
      assert.deepEqual(calls.cacheAll, []);
      assert.equal(lastGeneratedExports.balance, merged);
    }
  }
});

// v3.2.16：余额不一致“确认继续”、人工补录“确认替换”与断档“不补录”同一通道：登记确认键、写警告日志、按全部模板组重算。
test('主进程：余额不一致确认继续、人工补录确认替换后登记确认键并重算；重算仍待确认时返回下一次确认', async () => {
  const kinds = [
    {
      label: '余额不一致',
      item: { key: 'mismatch|模板1|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00', templateName: '模板1', merchantId: 'M001', currency: 'USD', billDate: '2026-09-01' },
      payload: (item) => ({ confirmBalanceMismatchKeys: [item.key], confirmedBalanceMismatches: [item] }),
      reason: 'mismatch',
      itemsField: 'mismatches',
      logMessage: '余额校验不一致，已确认按账单余额生成'
    },
    {
      label: '人工补录替换',
      item: { key: 'seed-replace|模板1|M001|USD|2026-09-01|5000.00|1100.00', templateName: '模板1', merchantId: 'M001', currency: 'USD', billDate: '2026-09-01' },
      payload: (item) => ({ confirmBalanceSeedReplaceKeys: [item.key], confirmedBalanceSeedReplacements: [item] }),
      reason: 'seed-replace',
      itemsField: 'replacements',
      logMessage: '人工补录的期末余额与本次余额不一致，已确认替换'
    }
  ];
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2' };
  const merged = { filePath: '/tmp/2-BALANCE.xlsx' };
  for (const kind of kinds) {
    for (const regenOutcome of ['success', 'pending']) {
      const label = `${kind.label}/${regenOutcome}`;
      const calls = { remembered: [], logs: [], results: [] };
      const lastGeneratedExports = { detail: { filePath: '/tmp/detail.xlsx' }, balance: null };
      const capture = (reason) => (items, pendingFiles) => {
        calls.results.push({ reason, items, pendingFiles });
        return { status: 'manual-balance-required', manualBalancePrompt: { reason, [kind.itemsField]: items } };
      };
      const execute = loadSaveBalanceSeedExecute({
        FILENAME_MAPPING_TEMPLATE_ID,
        FileValidationError,
        isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
        ...seedSaveGroupingDeps(),
        // v3.2.19：补录后重算的提示附去重行数，按会话条目统计（真实生成辅助函数）
        statementGenerationHelpers: createStatementGenerationHelpers({}),
        rememberAcknowledgedBalanceGaps: (input) => {
          calls.remembered.push(input.gapKeys);
          return true;
        },
        appendActivityLogEntry: (entry) => calls.logs.push(entry),
        formatBalanceGapLine: () => '',
        formatBalanceMismatchLine: (item) => `不一致 ${item.merchantId} ${item.billDate}`,
        formatBalanceSeedReplaceLine: (item) => `替换 ${item.merchantId} ${item.billDate}`,
        regenerateVirtualTemplateBalanceFromSession: () => (regenOutcome === 'success'
          ? { needsSeed: false, generatedFiles: { detail: null, balance: merged, warnings: [] } }
          : { needsSeed: true, [kind.itemsField]: [{ ...kind.item, billDate: '2026-09-02' }], warnings: [] }),
        buildBalanceGapConfirmResult: () => {
          throw new Error('不应进入断档确认');
        },
        buildBalanceMismatchConfirmResult: capture('mismatch'),
        buildBalanceSeedReplaceConfirmResult: capture('seed-replace'),
        buildManualBalanceRequiredResult: () => {
          throw new Error('不应进入首次补录');
        },
        writeManualBalanceSeedPlan: () => {
          throw new Error('确认不写人工种子');
        },
        lastGeneratedExports,
        cacheAllStatementExport: () => {},
        buildImportResultFromGeneratedFiles: ({ generatedFiles }) => ({ status: 'success', balance: generatedFiles.balance })
      });
      const result = await execute(null, {
        plan: null,
        ...kind.payload(kind.item),
        pendingPrompt: { reason: kind.reason, templateName: '模板1', [kind.itemsField]: [kind.item] },
        session,
        importContext: { templateId: FILENAME_MAPPING_TEMPLATE_ID, scope: 'current', template: { name: '模板2' } }
      }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });

      assert.deepEqual(calls.remembered, [[kind.item.key]], label);
      assert.equal(calls.logs[0].level, 'warn', label);
      assert.equal(calls.logs[0].message, kind.logMessage, label);
      assert.equal(calls.logs[0].details.length, 2, label);
      if (regenOutcome === 'success') {
        assert.equal(result.status, 'success', label);
        assert.equal(lastGeneratedExports.balance, merged, label);
      } else {
        assert.equal(result.manualBalancePrompt.reason, kind.reason, label);
        assert.equal(calls.results[0].reason, kind.reason, label);
        assert.equal(calls.results[0].items[0].billDate, '2026-09-02', label);
      }
    }
  }
});

// 补录后按会话全部分组重新生成前的输出名称与实际文件名核对：默认模板 1、模板 2 两组普通模板，各一个账号。
//   entries 的 merchantId 为该文件的账号，各组账号唯一时文件名拼上账号（同真实 preparedBatch.selectedMerchantId）。
function seedSaveGroupingDeps(database, {
  entries = [{ matchedTemplateId: 1, merchantId: 'M001' }, { matchedTemplateId: 2, merchantId: 'M002' }],
  templateNames = {}
} = {}) {
  const templateConfig = (tid) => ({
    template: { id: tid, name: templateNames[tid] || `模板${tid}` },
    exportMappings: [],
    exportTargetFields: []
  });
  const groupStatementEntriesForGeneration = loadGroupingFunction(templateConfig);
  const getStatementSessionEntries = () => entries;
  return {
    groupStatementEntriesForGeneration,
    getStatementSessionEntries,
    ...loadOutputNameConflictFunctions(database),
    ...regenerationPlanDeps({
      getStatementSessionEntries,
      groupStatementEntriesForGeneration,
      buildStatementGenerationConfig: ({ template }) => ({ template }),
      buildPreparedStatementBatchFromEntries: ({ fileEntries }) => {
        const merchantIds = Array.from(new Set(fileEntries.map((entry) => entry.merchantId)));
        return { detailRows: [], selectedMerchantId: merchantIds.length === 1 ? merchantIds[0] : '' };
      }
    })
  };
}

test('主进程：按文件名映射补录时，各组输出名称拼上账号后文件名相同，先阻断，不写入种子、不登记断档、不重新生成（release 复审）', async () => {
  // 导入后、补录前模板 2 被改名为「BANK-SG-1001」：模板 1「BANK-SG」只有账号 1001，模板 2 有两个账号，文件名都是 BANK-SG-1001-…。
  const grouping = seedSaveGroupingDeps(undefined, {
    entries: [
      { matchedTemplateId: 1, merchantId: '1001' },
      { matchedTemplateId: 2, merchantId: '2001' },
      { matchedTemplateId: 2, merchantId: '2002' }
    ],
    templateNames: { 1: 'BANK-SG', 2: 'BANK-SG-1001' }
  });
  const gap = { key: 'BANK-SG|1001|USD|2026-09-01|2026-09-04', merchantId: '1001', currency: 'USD' };
  for (const label of ['补录', '不补录']) {
    const calls = { seed: 0, acknowledged: 0, regenerate: 0, cleared: 0 };
    const execute = loadSaveBalanceSeedExecute({
      FILENAME_MAPPING_TEMPLATE_ID,
      FileValidationError,
      isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
      ...grouping,
      writeManualBalanceSeedPlan: () => { calls.seed += 1; },
      rememberAcknowledgedBalanceGaps: () => { calls.acknowledged += 1; return true; },
      formatBalanceGapLine: () => '',
      regenerateVirtualTemplateBalanceFromSession: () => { calls.regenerate += 1; return { needsSeed: false, generatedFiles: {} }; },
      appendActivityLogEntry: () => {},
      clearPendingManualBalancePrompt: () => { calls.cleared += 1; },
      createErrorResult: (payload) => ({ status: 'error', ...payload })
    });
    const skip = label === '不补录';
    const result = await execute(null, {
      plan: skip ? null : { record: { templateName: 'BANK-SG', merchantId: '1001', currency: 'USD', billDate: '2026-08-31', endBalance: '1000' } },
      skipBalanceGapKeys: skip ? [gap.key] : null,
      skippedBalanceGaps: skip ? [gap] : [],
      pendingPrompt: { templateName: 'BANK-SG' },
      session: { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID },
      importContext: { templateId: FILENAME_MAPPING_TEMPLATE_ID, scope: 'current', template: { name: '按文件名映射模板' } }
    }, { fileEvidence: { filePlan: { inputs: [{ filePath: '/tmp/a.xlsx' }] } } });
    assert.equal(result.status, 'error', label);
    assert.equal(result.errorCode, 'STATEMENT_OUTPUT_NAME_CONFLICT', label);
    assert.deepEqual(result.detailLines, ['文件名「BANK-SG-1001」：模板「BANK-SG」（账号 1001）、模板「BANK-SG-1001」'], label);
    assert.deepEqual(calls, { seed: 0, acknowledged: 0, regenerate: 0, cleared: 1 }, label);
  }
});

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
      // v3.2.19：执行阶段清除待确认的重复账单；业务入口的配置核对（本用例的 prepared 没有核对函数，放行）
      statementDuplicateReview: { clear: () => {} },
      checkImportConfigGuard: () => null,
      IMPORT_CONFIG_CHANGED_MESSAGE: '导入期间模板、渠道或账户映射已修改，请重新导入文件',
      DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE: '等待确认期间模板、渠道或账户映射已修改，请重新导入文件',
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
      // 余额汇总文件按各组余额记录的日期命名（generateStatementFiles 的 balance.billDates）
      1: { balance: { filePath: '/tmp/group-1__all.xlsx', billDates: ['2026-09-01'] }, warnings: [] },
      2: { balance: { filePath: '/tmp/group-2__all.xlsx', billDates: ['2026-09-02'] }, warnings: [] }
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

// v3.2.16（Codex 第二轮审查）：导出全部余额会重新生成；本次重算里已接受的风险随导出结果告警并可导出报错文件。
const ACCEPTED_RISK_GAP = {
  key: '模板1|M001|USD|2026-09-01|2026-09-04', merchantId: 'M001', currency: 'USD',
  anchorDate: '2026-09-01', targetBillDate: '2026-09-04', missingFrom: '2026-09-02', missingTo: '2026-09-03'
};
const ACCEPTED_RISK_MISMATCH = {
  key: 'mismatch|模板1|M001|USD|2026-09-01|2026-08-31|1000.00|100.00|0.00|9999.00', merchantId: 'M001', currency: 'USD',
  billDate: '2026-09-01', anchorDate: '2026-08-31', anchorSource: 'seed', anchorBalance: 1000, creditAmount: 100, debitAmount: 0,
  expectedBalance: 1100, statementBalance: 9999, difference: 8899, missingFrom: '', missingTo: ''
};
const ACCEPTED_RISK_REPLACEMENT = {
  key: 'seed-replace|模板2|M002|USD|2026-09-02|5000.00|1100.00', merchantId: 'M002', currency: 'USD', billDate: '2026-09-02',
  balanceSource: 'statement', manualBalance: 5000, balance: 1100, difference: -3900, adjustment: 0, writtenBalance: 1100
};
const ACCEPTED_RISK_MESSAGE = '1处账单日期不连续未补录，余额可能不准确，1处余额校验不一致，已按账单余额生成，1处人工补录余额已按本次余额替换，请点击状态框导出报错文件';

test('主进程：按文件名映射导出全部余额，本次重算含已接受的风险时导出结果带告警与报错明细', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2', templateName: '按文件名映射模板' };
  const run = async (generated, overrides = {}) => {
    const warningPayloads = [];
    const { deps } = virtualExportAllDeps({ session, groups: Object.keys(generated).map(Number), generated });
    const result = await loadExportStatementByScope({
      ...deps,
      ...acceptedRiskExportDeps(warningPayloads),
      parseRequiredBillDates: () => ['2026-09-01'],
      buildDateRangeLabel,
      getToday: () => '2026-11-08',
      path,
      buildOutputFilePath: ({ outputFileName }) => ({ outputFilePath: `/tmp/${outputFileName}` }),
      scopedMergedOutputFileName: (name) => name,
      mergeGeneratedXlsxFiles: () => {},
      exportGeneratedFile: async () => ({ status: 'success', message: '文件导出成功', filePath: '/tmp/saved.xlsx' }),
      ...overrides
    })(overrides.kind || 'balance', 'all');
    return { result, warningPayloads };
  };

  const { result, warningPayloads } = await run({
    1: { balance: { filePath: '/tmp/group-1__all.xlsx' }, warnings: [
      { type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] },
      { type: 'balance-gap-skipped', gaps: [ACCEPTED_RISK_GAP] }
    ] },
    2: { balance: { filePath: '/tmp/group-2__all.xlsx' }, warnings: [
      { type: 'balance-seed-replace-confirmed', replacements: [ACCEPTED_RISK_REPLACEMENT] },
      { type: 'detail-row-skipped', rowNumber: 3 }
    ] }
  });
  assert.equal(result.status, 'warning');
  assert.equal(result.errorReportReady, true);
  assert.equal(result.filePath, '/tmp/saved.xlsx');
  assert.equal(result.message, `文件导出成功，${ACCEPTED_RISK_MESSAGE}`);
  assert.equal(warningPayloads[0].step, '导出余额账单');
  assert.equal(warningPayloads[0].errorCode, 'EXPORT_BALANCE_WARNING');
  const detail = warningPayloads[0].detailLines.join('\n');
  assert.match(detail, /以下账单日期不连续且未补录期末余额/);
  assert.match(detail, /预期余额：1,100\.00，账单余额：9,999\.00/);
  assert.match(detail, /人工补录余额：5,000\.00，账单余额：1,100\.00/);
  assert.doesNotMatch(detail, /Credit Amount 和 Debit Amount 同时为 0/, '与已接受风险无关的告警不带入');

  const plain = await run({ 1: { balance: { filePath: '/tmp/group-1__all.xlsx' }, warnings: [] } });
  assert.deepEqual(plain.result, { status: 'success', message: '文件导出成功', filePath: '/tmp/saved.xlsx' }, '没有已接受风险时保持成功');

  const failedExport = await run({ 1: { balance: { filePath: '/tmp/group-1__all.xlsx' }, warnings: [
    { type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] }
  ] } }, { exportGeneratedFile: async () => ({ status: 'error', message: '文件导出失败' }) });
  assert.equal(failedExport.result.status, 'error', '导出失败时保留原错误');
  assert.deepEqual(failedExport.warningPayloads, []);
});

test('主进程：指定模板会话导出全部余额，本次重算含已确认的余额不一致时导出结果带告警（Codex 复现场景）', async () => {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  const warningPayloads = [];
  const cached = [];
  const result = await loadExportStatementByScope({
    ...loadOutputNameConflictFunctions(NAME_CONFLICT_DATABASE),
    ...acceptedRiskExportDeps(warningPayloads),
    resolveGenerationGroupKey,
    getCurrentStatementSession: () => ({ key: 'session-1', templateId: 6, templateName: '模板6' }),
    isFilenameMappingMode: () => false,
    getGeneratedStatementExport: () => null,
    getTemplateMappingConfig: singleTemplateConfig,
    getStatementSessionEntries: () => [{ matchedTemplateId: 6 }],
    resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    buildStatementSessionGenerationContext: () => ({ config: {}, preparedBatch: { detailRows: [] } }),
    rememberLastFileImportContext: () => {},
    createGenerationContext: (context) => context,
    // 第一批的差异已确认，导入第二批后导出全部：确认键复用，重算返回已确认告警。
    generateStatementFiles: () => ({
      balance: { filePath: '/tmp/all-balance.xlsx', templateName: '模板6' },
      warnings: [{ type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] }]
    }),
    extractManualBalancePromptWarning: () => null,
    statementGenerationHelpers: createStatementGenerationHelpers({}),
    cacheAllStatementExport: (kind, file) => cached.push([kind, file.filePath]),
    exportGeneratedFile: async () => ({ status: 'success', message: '文件导出成功', filePath: '/tmp/saved.xlsx' })
  })('balance', 'all');
  assert.deepEqual(cached, [['balance', '/tmp/all-balance.xlsx']]);
  assert.equal(result.status, 'warning');
  assert.equal(result.message, '文件导出成功，1处余额校验不一致，已按账单余额生成，请点击状态框导出报错文件');
  assert.equal(warningPayloads[0].templateName, '模板6');
  assert.match(warningPayloads[0].detailLines.join('\n'), /差额：\+8,899\.00/);
});

// v3.2.16（提交后 Codex 审查 P2）：“全部”余额缓存只存文件时，再次导出全部、或确认后重算写入缓存再导出，
//   都会只显示“文件导出成功”。告警随文件缓存，命中缓存时带出。用真实缓存读写函数连续调用。
test('主进程：导出全部余额命中缓存时仍带出该文件已接受的风险（再次导出、确认后重算再导出）', async () => {
  const { resolveGenerationGroupKey } = require('../../../src/main-process/statement-channel-identity');
  const cacheHelpers = createStatementGenerationHelpers({});
  const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };
  let generateCount = 0;
  const warningPayloads = [];
  const exportAll = loadExportStatementByScope({
    ...loadOutputNameConflictFunctions(NAME_CONFLICT_DATABASE),
    ...acceptedRiskExportDeps(warningPayloads),
    resolveGenerationGroupKey,
    getCurrentStatementSession: () => ({ key: 'session-1', templateId: 6, templateName: '模板6' }),
    isFilenameMappingMode: () => false,
    getGeneratedStatementExport: (kind, scope) => cacheHelpers.getGeneratedStatementExport(lastGeneratedExports, kind, scope),
    cacheAllStatementExport: (kind, file, warnings) => cacheHelpers.cacheAllStatementExport(lastGeneratedExports, kind, file, warnings),
    getTemplateMappingConfig: singleTemplateConfig,
    getStatementSessionEntries: () => [{ matchedTemplateId: 6 }],
    resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    buildStatementSessionGenerationContext: () => ({ config: {}, preparedBatch: { detailRows: [] } }),
    rememberLastFileImportContext: () => {},
    createGenerationContext: (context) => context,
    generateStatementFiles: () => {
      generateCount += 1;
      return {
        balance: { filePath: '/tmp/all-balance.xlsx', templateName: '模板6' },
        warnings: [{ type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] }, { type: 'detail-row-skipped', rowNumber: 3 }]
      };
    },
    extractManualBalancePromptWarning: () => null,
    statementGenerationHelpers: cacheHelpers,
    exportGeneratedFile: async (file) => ({ status: 'success', message: '文件导出成功', filePath: `/saved/${path.basename(file.filePath)}` })
  });
  const mismatchMessage = '文件导出成功，1处余额校验不一致，已按账单余额生成，请点击状态框导出报错文件';

  const first = await exportAll('balance', 'all');
  const second = await exportAll('balance', 'all');
  assert.equal(generateCount, 1, '第二次导出命中缓存，不重算');
  assert.equal(first.message, mismatchMessage);
  assert.equal(second.status, 'warning', '命中缓存仍为告警');
  assert.equal(second.message, mismatchMessage);
  assert.equal(second.errorReportReady, true);
  assert.equal(second.filePath, '/saved/all-balance.xlsx');
  assert.deepEqual(warningPayloads[1].detailLines, warningPayloads[0].detailLines, '报错明细与首次导出一致');

  // 补录 IPC 确认后重算写入“全部”缓存（文件 + 本次重算告警），之后实际导出也带告警。
  cacheHelpers.cacheAllStatementExport(lastGeneratedExports, 'balance', { filePath: '/tmp/all-balance-2.xlsx', templateName: '模板6' }, [
    { type: 'balance-seed-replace-confirmed', replacements: [ACCEPTED_RISK_REPLACEMENT] }
  ]);
  const afterConfirm = await exportAll('balance', 'all');
  assert.equal(generateCount, 1);
  assert.equal(afterConfirm.status, 'warning');
  assert.equal(afterConfirm.message, '文件导出成功，1处人工补录余额已按本次余额替换，请点击状态框导出报错文件');
  assert.match(warningPayloads[2].detailLines.join('\n'), /人工补录余额：5,000\.00，账单余额：1,100\.00/);

  // 没有已接受风险的缓存文件、导出当前批次：保持“文件导出成功”。
  cacheHelpers.cacheAllStatementExport(lastGeneratedExports, 'balance', { filePath: '/tmp/all-balance-3.xlsx', templateName: '模板6' }, []);
  assert.deepEqual(await exportAll('balance', 'all'), { status: 'success', message: '文件导出成功', filePath: '/saved/all-balance-3.xlsx' });
  lastGeneratedExports.balance = { filePath: '/tmp/current-balance.xlsx', balanceWarnings: [{ type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] }] };
  assert.equal((await exportAll('balance', 'current')).status, 'success', '当前批次的告警在导入时已显示，导出不再带');
  assert.equal(warningPayloads.length, 3);
});

test('主进程：导出全部余额时部分模板已删除且含已接受的风险，提示同时说明数据不完整与风险', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-2', templateName: '按文件名映射模板' };
  const warningPayloads = [];
  const { deps } = virtualExportAllDeps({
    session,
    groups: [1, 2],
    generated: { 1: { balance: { filePath: '/tmp/group-1__all.xlsx' }, warnings: [
      { type: 'balance-mismatch-confirmed', mismatches: [ACCEPTED_RISK_MISMATCH] }
    ] } }
  });
  const result = await loadExportStatementByScope({
    ...deps,
    ...acceptedRiskExportDeps(warningPayloads),
    // 模板 2 已删除：分组时拿不到模板配置。
    groupStatementEntriesForGeneration: () => [
      { entries: [{ matchedTemplateId: 1 }], templateIds: [1], templateConfig: { template: { id: 1, name: '模板1' }, exportMappings: [], exportTargetFields: [] } },
      { entries: [{ matchedTemplateId: 2 }], templateIds: [2], templateConfig: null }
    ],
    appendActivityLogEntry: () => {},
    parseRequiredBillDates: () => ['2026-09-01'],
    path,
    exportGeneratedFile: async () => ({ status: 'success', message: '文件导出成功', filePath: '/tmp/saved.xlsx' })
  })('balance', 'all');
  assert.equal(result.status, 'warning');
  assert.equal(
    result.message,
    '文件已导出，但数据不完整：模板ID=2（1个文件） 的模板已被删除，对应文件未包含在导出中，1处余额校验不一致，已按账单余额生成，请点击状态框导出报错文件'
  );
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
  const regenerateDeps = {
    getStatementSessionEntries: (_session, scope) => (scope === 'all' ? [history, current] : [current]),
    groupStatementEntriesForGeneration: loadGroupingFunction(singleTemplateConfig),
    getTemplateMappingConfig: singleTemplateConfig,
    appendActivityLogEntry: () => {},
    buildStatementGenerationConfig: ({ template }) => ({
      template,
      mappingByTargetField: { MerchantId: 'Account' },
      balanceRequested: true,
      balanceMode: 'calculated'
    }),
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    extractManualBalancePromptWarning: generation.extractManualBalancePromptWarning,
    statementGenerationHelpers: generation,
    path
  };
  Object.assign(regenerateDeps, regenerationPlanDeps(regenerateDeps));
  const regenerate = loadMainFunction(
    'regenerateVirtualTemplateBalanceFromSession',
    Object.keys(regenerateDeps),
    Object.values(regenerateDeps)
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

// v3.2.21（T10）：写出前的只读校验与 generateStatementFiles 写出前会抛出的检查同口径（错误码、提示、逐行明细一致），
//   已构建的批次与尚未构建批次的条目两种入口结果相同
test('写出前的只读校验与生成时的检查同口径：收支同时有值、账单日期、出余额须映射 MerchantId', (t) => {
  const root = createTempRoot(t);
  const generation = createGenerationSeam(path.join(root, 'storage'));
  const baseConfig = {
    template: { id: 1, name: TEMPLATE_NAME },
    mappingByTargetField: { MerchantId: 'Account' },
    balanceRequested: true,
    balanceMode: 'calculated'
  };
  const errorOf = (run) => {
    try {
      run();
    } catch (error) {
      return { code: error.code, message: error.message, detailLines: error.detailLines };
    }
    return null;
  };
  const cases = [
    { label: '正常', files: [[['2026-09-01', 'M001', 'USD', '100', '']]] },
    { label: '收支同时有值（跨文件按合并后的行号）', files: [
      [['2026-09-01', 'M001', 'USD', '100', ''], ['2026-09-02', 'M001', 'USD', '', '3']],
      [['2026-09-03', 'M001', 'USD', '7', '8'], ['2026-09-04', 'M001', 'USD', '1', '2']]
    ] },
    { label: '交易行都没有账单日期', files: [[['', 'M001', 'USD', '100', ''], ['2026-09-01', 'M001', 'USD', '0', '0']]] },
    // 映射时已拒绝无效日期，这里直接给出映射后的行，覆盖生成层的同一检查
    { label: '账单日期无效', rawFiles: [{ rows: [['abc', 'M001', 'USD', '100', '']] }] },
    // 前一段没有行元数据：合并后的元数据按各段依次拼接，行号与生成时一致
    { label: '收支同时有值（前一段无行元数据）', rawFiles: [
      { rows: [['2026-09-01', 'M001', 'USD', '1', ''], ['2026-09-02', 'M001', 'USD', '2', '']], noMetas: true },
      { rows: [['2026-09-03', 'M001', 'USD', '5', '6'], ['2026-09-04', 'M001', 'USD', '7', '8']], metaBase: 10 }
    ] },
    { label: '只有收支都为 0 的行、日期有效', files: [[['2026-09-01', 'M001', 'USD', '0', '']]] },
    { label: '只有收支都为 0 的行、没有日期', files: [[['', 'M001', 'USD', '0', '']]] },
    { label: '出余额未映射 MerchantId', files: [[['2026-09-01', 'M001', 'USD', '100', '']]], config: { mappingByTargetField: {} } },
    { label: '不出余额时不要求 MerchantId', files: [[['2026-09-01', 'M001', 'USD', '100', '']]], config: { mappingByTargetField: {}, balanceRequested: false } }
  ];
  const rejected = [];
  cases.forEach(({ label, files, rawFiles, config: overrides = {} }, caseIndex) => {
    const config = { ...baseConfig, ...overrides };
    const fileEntries = rawFiles
      ? rawFiles.map(({ rows, noMetas, metaBase = 2 }, fileIndex) => ({
        filePath: `/tmp/raw-${fileIndex}.xlsx`,
        detailRows: noMetas
          ? detailRows(rows)
          : Object.assign(detailRows(rows), { rowMetas: rows.map((_row, index) => ({ sourceRowNumber: index + metaBase })) })
      }))
      : files.map((rows, fileIndex) => mappedSourceEntry(root, `writable-${caseIndex}-${fileIndex}.xlsx`, rows));
    const preparedBatch = generation.buildPreparedStatementBatchFromEntries({ config, fileEntries });
    const generated = errorOf(() => generation.generateStatementFiles({ config, preparedBatch, scope: 'current' }));
    if (generated) rejected.push([label, generated.message, generated.detailLines]);
    assert.deepEqual(errorOf(() => generation.assertStatementBatchWritable({ config, preparedBatch })), generated, label);
    assert.deepEqual(errorOf(() => generation.assertStatementEntriesWritable({ config, fileEntries, balancePlan: null })), generated, label);
  });
  assert.deepEqual(rejected, [
    ['收支同时有值（跨文件按合并后的行号）', '存在2条明细的 Credit Amount 与 Debit Amount 同时有值',
      ['第2行，Credit Amount="7"，Debit Amount="8"', '第3行，Credit Amount="1"，Debit Amount="2"']],
    ['交易行都没有账单日期', '导入文件中未找到有效的 BillDate', []],
    ['账单日期无效', '账单日期存在无效值：abc', []],
    ['收支同时有值（前一段无行元数据）', '存在2条明细的 Credit Amount 与 Debit Amount 同时有值',
      ['第4行，Credit Amount="5"，Debit Amount="6"', '第5行，Credit Amount="7"，Debit Amount="8"']],
    ['只有收支都为 0 的行、没有日期', '导入文件中未找到有效的 BillDate', []],
    ['出余额未映射 MerchantId', '当前模板启用 Balance 时必须映射 MerchantId 字段', []]
  ]);
  // 只出明细（「导出全部」导出明细）时不检查 MerchantId 映射
  const fileEntries = [mappedSourceEntry(root, 'writable-detail.xlsx', [['2026-09-01', 'M001', 'USD', '100', '']])];
  const config = { ...baseConfig, mappingByTargetField: {} };
  assert.equal(errorOf(() => generation.assertStatementEntriesWritable({ config, fileEntries, includeBalance: false })), null);
  assert.match(errorOf(() => generation.assertStatementEntriesWritable({ config, fileEntries, includeBalance: true })).message, /必须映射 MerchantId/);
});

function findFileNames(root, pattern) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map((name) => path.basename(String(name)))
    .filter((name) => pattern.test(name));
}

test('主进程：按文件名映射多模板导入，任一模板组需补录或确认断档时不合并、不缓存部分余额', (t) => {
  for (const scenario of ['gap', 'seed-required', 'bulk-warnings', 'invalid-date', 'merged-dates']) {
    const root = createTempRoot(t);
    const storageRoot = path.join(root, 'storage');
    const generation = createGenerationSeam(storageRoot);
    const { buildOutputFilePath, mergeGeneratedXlsxFiles } = loadOutputPathHelpers(storageRoot, '2026-10-29');
    // 三个模板各一个账号；第三组断档（9-02、9-03 缺失）或没有首次种子，其余两组可以算出余额。
    const groups = [
      { id: 1, templateName: '中行-上海', merchantId: 'M001', dates: ['2026-09-01', '2026-09-02'] },
      { id: 2, templateName: '中行-北京', merchantId: 'M002', dates: ['2026-09-01', '2026-09-02'] },
      { id: 3, templateName: '中行-深圳', merchantId: 'M003', dates: scenario === 'gap'
        ? ['2026-09-01', '2026-09-04']
        : scenario === 'invalid-date' ? ['', ''] : ['2026-09-01', '2026-09-02'] }
    ];
    for (const group of groups) {
      if (scenario === 'seed-required' && group.id === 3) continue;
      upsertBalanceSeedRecord(storageRoot, {
        templateName: group.templateName, merchantId: group.merchantId, currency: 'USD',
        billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
      });
    }
    const fileEntries = groups.map((group) => ({
      ...mappedSourceEntry(root, `${scenario}-${group.id}.xlsx`, group.dates.map((date) => [date, group.merchantId, 'USD', '100', ''])
        // 只有一条零金额行的日期：生成时跳过，不进明细与余额文件，也不进汇总文件名
        .concat(scenario === 'merged-dates' && group.id === 1 ? [['2026-08-30', group.merchantId, 'USD', '0', '']] : [])),
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
      assertStatementBatchWritable: generation.assertStatementBatchWritable,
      FileValidationError,
      removeStatementSessionEntriesByFilePath: () => {},
      generateStatementFiles: (options) => {
        const result = generation.generateStatementFiles(options);
        // 大批量零金额行：每个跳过行一条告警（只在第一组附加，模拟 15 万行）
        if (scenario === 'bulk-warnings' && options.config.template.name === '中行-上海') {
          return { ...result, warnings: result.warnings.concat(new Array(150000).fill({ type: 'detail-row-skipped', rowNumber: 2 })) };
        }
        // 模拟渠道组内只有不出余额的子模板在 9-01 有交易：各组余额记录都不含 9-01（明细照常含）
        if (scenario === 'merged-dates' && result.balance) {
          return { ...result, balance: { ...result.balance, billDates: result.balance.billDates.filter((date) => date !== '2026-09-01') } };
        }
        return result;
      },
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

    if (scenario === 'invalid-date') {
      // v3.2.21：最后一组有交易却没有有效账单日期时，在任何组写出之前拦下：前两组不写出明细、余额，也不写当日种子
      assert.throws(() => generateGroups({
        fileEntries,
        fallbackTemplateConfig: {},
        selectedBigAccount: null,
        session: { key: 'session-1' },
        inputFilePaths: fileEntries.map((entry) => entry.filePath)
      }), /未找到有效的 BillDate/);
      assert.deepEqual([imported, findFileNames(storageRoot, /COMMON|BALANCE/)], [[], []], scenario);
      assert.deepEqual(readBalanceSeedRecords(storageRoot, '中行').filter((record) => record.billDate === '2026-09-02'), [], scenario);
      continue;
    }
    generateGroups({
      fileEntries,
      fallbackTemplateConfig: {},
      selectedBigAccount: null,
      session: { key: 'session-1' },
      inputFilePaths: fileEntries.map((entry) => entry.filePath)
    });

    const [generatedFiles] = imported;
    if (scenario === 'merged-dates') {
      // release 审查：余额汇总文件按各组实际写出的余额记录日期命名，明细汇总按各组写出的明细日期（跳过的零金额行不算）
      assert.deepEqual([generatedFiles.detail.fileName, generatedFiles.balance.fileName],
        ['3-COMMON-2026-09-01~2026-09-02.xlsx', '3-BALANCE-2026-09-02.xlsx'], scenario);
      continue;
    }
    if (scenario === 'bulk-warnings') {
      // v3.2.21：汇总各组告警逐个追加，15 万条跳过行告警不会在写出之后才超出调用栈
      assert.equal(generatedFiles.warnings.filter((warning) => warning.type === 'detail-row-skipped').length, 150000, scenario);
      assert.ok(generatedFiles.balance, scenario);
      continue;
    }
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
    // v3.2.19：补录后重算的提示附去重行数，按会话条目统计（真实生成辅助函数）
    statementGenerationHelpers: createStatementGenerationHelpers({}),
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

// v3.2.21（D3）：执行时先规划全部组；后一组出余额的交易缺字段、或渠道余额方式冲突时整批阻断（冲突优先），
//   任何组都不记上下文、不写出余额与种子
test('主进程：导出全部余额先规划全部组，后一组渠道余额校验失败时整批阻断，前一组不写出、不记上下文', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const ok = (tid) => ({ balance: { filePath: `/tmp/group-${tid}__all.xlsx` }, warnings: [] });
  const buildChannelBalanceModeMismatchError = loadMainFunction('buildChannelBalanceModeMismatchError', ['FileValidationError', 'maskAccountLikeTextForLog'], [FileValidationError, loadMainFunction('maskAccountLikeTextForLog', [], [])]);
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', ['FileValidationError'], [FileValidationError]);
  const buildChannelBalancePlanningError = loadMainFunction(
    'buildChannelBalancePlanningError',
    ['buildChannelBalanceModeMismatchError', 'buildChannelBalanceRowsIncompleteError'],
    [buildChannelBalanceModeMismatchError, buildChannelBalanceRowsIncompleteError]
  );
  const rowsError = () => buildChannelBalanceRowsIncompleteError([{
    channelName: '渠道B',
    lines: ['文件「b.xlsx」（子模板「B2」）第2行：缺少 MerchantId（账单日期：2026-09-01）'],
    persistedLines: ['本组第2个文件（子模板「B2」）第2行：缺少 MerchantId（账单日期：2026-09-01）']
  }]);
  const mismatchError = () => buildChannelBalanceModeMismatchError([{
    channelName: '渠道C', lines: ['账户 M3（USD）：C1（不出余额）、C2（取账单余额列）'], accountCount: 1, templateNames: ['C1', 'C2']
  }]);
  const cases = [
    { label: '后一组缺字段', failures: { 2: rowsError }, code: 'CHANNEL_BALANCE_ROWS_INCOMPLETE',
      lines: ['文件「b.xlsx」（子模板「B2」）第2行：缺少 MerchantId（账单日期：2026-09-01）'],
      persisted: ['本组第2个文件（子模板「B2」）第2行：缺少 MerchantId（账单日期：2026-09-01）'] },
    { label: '缺字段与冲突并存', failures: { 2: rowsError, 3: mismatchError }, code: 'CHANNEL_BALANCE_MODE_MISMATCH',
      lines: ['账户 M3（USD）：C1（不出余额）、C2（取账单余额列）'],
      persisted: ['渠道「渠道C」：1 个账户命中余额方式不同的子模板（C1、C2）'] },
    // 前一组映射缺字段（生成配置报错）不遮住后面渠道的冲突
    { label: '其他组配置错误在前', failures: { 3: mismatchError }, configFailures: { 1: true }, code: 'CHANNEL_BALANCE_MODE_MISMATCH',
      lines: ['账户 M3（USD）：C1（不出余额）、C2（取账单余额列）'],
      persisted: ['渠道「渠道C」：1 个账户命中余额方式不同的子模板（C1、C2）'] },
    // 生成配置报错的渠道自身也有账户冲突：按会话明细判断，与其他渠道一并列出
    { label: '配置报错的渠道也有冲突', failures: { 3: mismatchError }, configFailures: { 1: true }, configConflicts: { 1: true }, code: 'CHANNEL_BALANCE_MODE_MISMATCH',
      lines: ['渠道「渠道A」账户 M1（USD）：A1（不出余额）、A2（取账单余额列）', '渠道「渠道C」账户 M3（USD）：C1（不出余额）、C2（取账单余额列）'],
      persisted: ['渠道「渠道A」：1 个账户命中余额方式不同的子模板（A1、A2）', '渠道「渠道C」：1 个账户命中余额方式不同的子模板（C1、C2）'] }
  ];
  for (const { label, failures, configFailures = {}, configConflicts = {}, code, lines, persisted } of cases) {
    const generatedTids = [];
    const builtTids = [];
    const exported = [];
    const { deps, remembered } = virtualExportAllDeps({ session, groups: [1, 2, 3], generated: { 1: ok(1), 2: ok(2), 3: ok(3) } });
    const result = await loadExportStatementByScope({
      ...deps,
      groupStatementEntriesForGeneration: asChannelGroups(deps.groupStatementEntriesForGeneration),
      buildStatementGenerationConfig: ({ template }) => {
        if (configFailures[template.id]) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
        return { template };
      },
      collectGroupBalanceIssuesWithoutConfig: (group, { conflictGroups }) => {
        if (configConflicts[group.entries[0].matchedTemplateId]) {
          conflictGroups.push({ channelName: '渠道A', lines: ['账户 M1（USD）：A1（不出余额）、A2（取账单余额列）'], accountCount: 1, templateNames: ['A1', 'A2'] });
        }
      },
      resolveEntryBalancePlan: ({ config }) => {
        const failure = failures[config.template.id];
        if (failure) throw failure();
        return null;
      },
      buildPreparedStatementBatchFromEntries: ({ config }) => {
        builtTids.push(config.template.id);
        return { detailRows: [], tid: config.template.id };
      },
      generateStatementFiles: ({ preparedBatch }) => {
        generatedTids.push(preparedBatch.tid);
        return ok(preparedBatch.tid);
      },
      buildChannelBalancePlanningError,
      createDetailedErrorResult: (payload) => ({ status: 'error', ...payload }),
      exportGeneratedFile: async (generatedFile) => {
        exported.push(generatedFile);
        return { status: 'success' };
      }
    })('balance', 'all');
    assert.deepEqual([result.status, result.step, result.errorCode, result.detailLines, result.persistedDetailLines],
      ['error', '导出余额账单', code, lines, persisted], label);
    assert.deepEqual(generatedTids, [], `${label}：任何组都不写出`);
    assert.deepEqual(builtTids, [], `${label}：校验阶段不构建批次（不复制明细）`);
    assert.deepEqual(remembered, [], `${label}：不记上下文`);
    assert.deepEqual(exported, [], label);
  }
});

// v3.2.21：导出全部执行时没有渠道余额错误，其他组的配置错误照常抛出（不被吞掉）
test('主进程：导出全部余额时只有其他组配置错误则照常抛出，任何组都不写出', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const generatedTids = [];
  const { deps } = virtualExportAllDeps({ session, groups: [1, 2], generated: {} });
  await assert.rejects(loadExportStatementByScope({
    ...deps,
    buildStatementGenerationConfig: ({ template }) => {
      if (template.id === 2) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
      return { template };
    },
    generateStatementFiles: ({ preparedBatch }) => {
      generatedTids.push(preparedBatch.tid);
      return { balance: null, warnings: [] };
    }
  })('balance', 'all'), /必须映射 BillDate/);
  assert.deepEqual(generatedTids, []);
});

// v3.2.21（T10）：导出全部执行时，写出前的检查（如后一组没有有效账单日期）在校验阶段对全部组做完，任何组都不写出
test('主进程：导出全部时后一组写出前检查失败，任何组都不写出', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const generatedTids = [];
  const checked = [];
  const resolvedTids = [];
  const { deps, remembered } = virtualExportAllDeps({ session, groups: [1, 2, 3], generated: {} });
  await assert.rejects(loadExportStatementByScope({
    ...deps,
    groupStatementEntriesForGeneration: asChannelGroups(deps.groupStatementEntriesForGeneration),
    resolveEntryBalancePlan: ({ config }) => {
      resolvedTids.push(config.template.id);
      return null;
    },
    assertStatementEntriesWritable: ({ config, balancePlan, includeBalance }) => {
      checked.push([config.template.id, balancePlan, includeBalance]);
      if (config.template.id === 2) throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
    },
    generateStatementFiles: ({ preparedBatch }) => {
      generatedTids.push(preparedBatch.tid);
      return { balance: null, warnings: [] };
    }
  })('balance', 'all'), /未找到有效的 BillDate/);
  // 第二组已确定本批不会写出：第三组（渠道组）只校验渠道余额，不再做写出检查
  assert.deepEqual([checked, resolvedTids], [[[1, null, true], [2, null, true]], [1, 2, 3]]);
  // 单模板组在整批失败后不再读取配置、校验
  const configuredTids = [];
  const { deps: plainDeps } = virtualExportAllDeps({ session, groups: [1, 2, 3], generated: {} });
  await assert.rejects(loadExportStatementByScope({
    ...plainDeps,
    buildStatementGenerationConfig: ({ template }) => {
      configuredTids.push(template.id);
      return { template };
    },
    assertStatementEntriesWritable: ({ config }) => {
      if (config.template.id === 1) throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
    }
  })('balance', 'all'), /未找到有效的 BillDate/);
  assert.deepEqual(configuredTids, [1]);
  assert.deepEqual([generatedTids, remembered], [[], []]);
});

// v3.2.21：导出全部执行时每组只校验一次，写出时复用该组的方案
test('主进程：导出全部余额写出时复用同一阶段校验得到的渠道余额方案，不重复解析', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-3', templateName: '按文件名映射模板' };
  const ok = (tid) => ({ balance: { filePath: `/tmp/group-${tid}__all.xlsx` }, warnings: [] });
  // 第二组余额失败：在合并之前结束，只核对校验与构建批次的调用
  const failed = { balance: null, warnings: [{ type: 'balance-generate-failed', message: '2026-11-01 未找到期末余额' }] };
  const { deps } = virtualExportAllDeps({ session, groups: [1, 2], generated: { 1: ok(1), 2: failed } });
  const resolved = [];
  const built = [];
  await loadExportStatementByScope({
    ...deps,
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    resolveEntryBalancePlan: ({ config }) => {
      resolved.push(config.template.id);
      return config.template.id === 2 ? { planOf: 2 } : null;
    },
    buildPreparedStatementBatchFromEntries: ({ config, balancePlan }) => {
      built.push([config.template.id, balancePlan]);
      return { detailRows: [], tid: config.template.id };
    },
    mergeGeneratedXlsxFiles: () => {},
    exportGeneratedFile: async () => ({ status: 'success' })
  })('balance', 'all');
  assert.deepEqual(resolved, [1, 2]);
  assert.deepEqual(built, [[1, null], [2, { planOf: 2 }]]);
});

// v3.2.21（D3）：「导出全部」另存为之前的预检同样汇总各渠道出余额的交易缺字段，不在第一个渠道处停下
test('主进程：导出全部预检汇总各渠道出余额的交易缺字段，不弹另存为', () => {
  const buildChannelBalanceModeMismatchError = loadMainFunction('buildChannelBalanceModeMismatchError', ['FileValidationError', 'maskAccountLikeTextForLog'], [FileValidationError, loadMainFunction('maskAccountLikeTextForLog', [], [])]);
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', ['FileValidationError'], [FileValidationError]);
  const buildChannelBalancePlanningError = loadMainFunction(
    'buildChannelBalancePlanningError',
    ['buildChannelBalanceModeMismatchError', 'buildChannelBalanceRowsIncompleteError'],
    [buildChannelBalanceModeMismatchError, buildChannelBalanceRowsIncompleteError]
  );
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID };
  const groups = [1, 2, 3].map((tid) => ({ entries: [{ matchedTemplateId: tid }], templateIds: [tid, tid + 100], templateConfig: { template: { id: tid, name: `渠道${tid}` } } }));
  const builtGroups = [];
  const validatedGroups = [];
  const rowsErrorOf = (config) => buildChannelBalanceRowsIncompleteError([{
    channelName: config.template.name,
    lines: [`文件「${config.template.id}.xlsx」（子模板「子${config.template.id}」）第2行：缺少账单日期`],
    persistedLines: [`本组第1个文件（子模板「子${config.template.id}」）第2行：缺少账单日期`],
    issueCount: 1
  }]);
  const deps = {
    getCurrentStatementSession: () => session,
    shouldPromptForExportScope: () => false,
    getGeneratedStatementExport: () => null,
    fs: { existsSync: () => false },
    isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
    groupStatementEntriesForGeneration: () => groups,
    getStatementSessionEntries: () => [],
    collectGenerationGroupBalanceModeConflicts: () => null,
    buildChannelBalanceModeMismatchError,
    buildChannelBalancePlanningError,
    createPreflightErrorResult: (payload) => ({ status: 'error', ...payload }),
    FileValidationError,
    collectGroupBalanceIssuesWithoutConfig: () => {},
    buildStatementGenerationConfig: ({ template }) => ({ template, outputName: template.name }),
    buildPreparedStatementBatchFromEntries: ({ config }) => {
      builtGroups.push(config.template.id);
      throw rowsErrorOf(config);
    },
    // 已有错误后，后面的组只校验、不构建批次：渠道2 通过，渠道3 缺字段
    resolveEntryBalancePlan: ({ config }) => {
      validatedGroups.push(config.template.id);
      if (config.template.id === 3) throw rowsErrorOf(config);
      return null;
    },
    parseRequiredBillDates: () => [],
    buildScopeSelectionResult: () => ({ status: 'select-export-scope' }),
    buildDateRangeLabel: () => '',
    normalizeCell,
    isDetailExportAmountRow,
    getToday: () => '2026-11-20'
  };
  const parsedGroups = [];
  deps.parseRequiredBillDates = (rows) => {
    parsedGroups.push(rows.length);
    return [];
  };
  const plan = loadMainFunction('buildStatementExportPlan', Object.keys(deps), Object.values(deps))('balance', 'all');
  assert.deepEqual(parsedGroups, [], '已有渠道余额错误时不再算导出文件名用的日期');
  assert.deepEqual([builtGroups, validatedGroups], [[1], [2, 3]], '已有渠道余额错误后，后面的组只校验、不构建批次');
  assert.deepEqual([plan.stopResult.errorCode, plan.stopResult.detailLines], ['CHANNEL_BALANCE_ROWS_INCOMPLETE', [
    '渠道「渠道1」文件「1.xlsx」（子模板「子1」）第2行：缺少账单日期',
    '渠道「渠道3」文件「3.xlsx」（子模板「子3」）第2行：缺少账单日期'
  ]]);
  assert.match(plan.stopResult.message, /^渠道「渠道1」、「渠道3」出余额的子模板有交易缺少账单日期或 MerchantId/);

  // 前一组映射缺字段（生成配置报错）不遮住后面渠道的错误；只有这类错误时照常抛出
  const configErrorDeps = {
    ...deps,
    buildStatementGenerationConfig: ({ template }) => {
      if (template.id === 1) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
      return { template, outputName: template.name };
    }
  };
  const configErrorPlan = loadMainFunction('buildStatementExportPlan', Object.keys(configErrorDeps), Object.values(configErrorDeps))('balance', 'all');
  assert.deepEqual(configErrorPlan.stopResult.detailLines, ['文件「3.xlsx」（子模板「子3」）第2行：缺少账单日期']);
  // 生成配置报错的渠道按会话明细校验：自身有账户冲突时冲突优先；只有缺字段的交易时与其他渠道一并列出（共用逐行额度）
  const withoutConfigCalls = [];
  const configConflictPlan = loadMainFunction('buildStatementExportPlan', Object.keys(configErrorDeps), Object.values({
    ...configErrorDeps,
    collectGroupBalanceIssuesWithoutConfig: (group, { conflictGroups, issueLineBudget }) => {
      withoutConfigCalls.push([group.templateConfig.template.id, issueLineBudget.remaining]);
      conflictGroups.push({ channelName: '渠道1', lines: ['账户 M1（USD）：A1（不出余额）、A2（取账单余额列）'], accountCount: 1, templateNames: ['A1', 'A2'] });
    }
  }))('balance', 'all');
  assert.deepEqual([configConflictPlan.stopResult.errorCode, configConflictPlan.stopResult.detailLines, withoutConfigCalls],
    ['CHANNEL_BALANCE_MODE_MISMATCH', ['账户 M1（USD）：A1（不出余额）、A2（取账单余额列）'], [[1, 200]]]);
  const configRowsPlan = loadMainFunction('buildStatementExportPlan', Object.keys(configErrorDeps), Object.values({
    ...configErrorDeps,
    collectGroupBalanceIssuesWithoutConfig: (group, { rowIssueGroups, issueLineBudget }) => {
      issueLineBudget.remaining -= 1;
      rowIssueGroups.push({ channelName: '渠道1', lines: ['文件「1.xlsx」（子模板「子1」）第2行：缺少 MerchantId（账单日期：2026-09-01）'],
        persistedLines: ['本组第1个文件（子模板「子1」）第2行：缺少 MerchantId（账单日期：2026-09-01）'], issueCount: 1 });
    }
  }))('balance', 'all');
  assert.deepEqual([configRowsPlan.stopResult.errorCode, configRowsPlan.stopResult.detailLines], ['CHANNEL_BALANCE_ROWS_INCOMPLETE', [
    '渠道「渠道1」文件「1.xlsx」（子模板「子1」）第2行：缺少 MerchantId（账单日期：2026-09-01）',
    '渠道「渠道3」文件「3.xlsx」（子模板「子3」）第2行：缺少账单日期'
  ]]);
  const onlyConfigErrorDeps = { ...configErrorDeps, resolveEntryBalancePlan: () => null, buildPreparedStatementBatchFromEntries: () => ({ detailRows: [] }) };
  assert.throws(() => loadMainFunction('buildStatementExportPlan', Object.keys(onlyConfigErrorDeps), Object.values(onlyConfigErrorDeps))('balance', 'all'), /必须映射 BillDate/);

  // 单独成组的文件没有有效账单日期（日期解析报错）同样暂存，不遮住后面渠道的错误；只有这类错误时照常抛出
  const dateErrorDeps = {
    ...deps,
    buildPreparedStatementBatchFromEntries: ({ config }) => ({ detailRows: [config.template.id] }),
    parseRequiredBillDates: (rows) => {
      if (rows[0] === 1) throw new FileValidationError('FILE_READ', '账单日期不能为空');
      return [];
    }
  };
  const dateErrorPlan = loadMainFunction('buildStatementExportPlan', Object.keys(dateErrorDeps), Object.values(dateErrorDeps))('balance', 'all');
  assert.deepEqual([dateErrorPlan.stopResult.errorCode, dateErrorPlan.stopResult.detailLines],
    ['CHANNEL_BALANCE_ROWS_INCOMPLETE', ['文件「3.xlsx」（子模板「子3」）第2行：缺少账单日期']]);
  const onlyDateErrorDeps = { ...dateErrorDeps, resolveEntryBalancePlan: () => null };
  assert.throws(() => loadMainFunction('buildStatementExportPlan', Object.keys(onlyDateErrorDeps), Object.values(onlyDateErrorDeps))('balance', 'all'), /账单日期不能为空/);

  // 没有错误时，大批量交易的日期逐个累计，不展开成参数（15 万笔同日交易）
  const bulkDates = new Array(150000).fill('2026-11-01');
  const okPlan = loadMainFunction('buildStatementExportPlan', Object.keys(deps), Object.values({
    ...deps,
    buildPreparedStatementBatchFromEntries: () => ({ detailRows: [['BillDate', 'Credit Amount', 'Debit Amount'], ['2026-11-01', '1', '']] }),
    parseRequiredBillDates: () => bulkDates,
    buildDateRangeLabel: (dates) => `${dates.length}`
  }))('balance', 'all');
  assert.deepEqual([okPlan.stopResult, okPlan.defaultFileName], [undefined, '3-BALANCE-450000.xlsx']);

  // release 审查：另存为默认文件名的日期与生成时的文件名同口径：剔除收支都为空或 0 的行（生成时跳过）；
  //   余额文件只取出余额的条目的行（balanceDetailRows），组内都不出余额或没有出余额的交易时不计；明细没有其他行时按全部明细行
  const H = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
  const batches = {
    mixed: {
      detailRows: [H, ['2026-01-15', 'M1', 'USD', '0', ''], ['2026-02-01', 'M1', 'USD', '5', ''], ['2026-03-01', 'M2', 'USD', '7', '']],
      balanceDetailRows: [H, ['2026-01-15', 'M2', 'USD', '0', ''], ['2026-03-01', 'M2', 'USD', '7', '']],
      balanceRequested: true
    },
    // 整组模板不出余额（批次不带 balanceDetailRows，与 buildPreparedStatementBatch 按组配置得到的形态相同）
    noBalance: { detailRows: [H, ['2026-02-01', 'M1', 'USD', '5', '']], balanceRequested: false },
    zeroOnly: { detailRows: [H, ['2026-01-15', 'M1', 'USD', '0', '0']] },
    single: { detailRows: [H, ['2026-01-20', 'M1', 'USD', '0', ''], ['2026-02-10', 'M1', 'USD', '', '3']] }
  };
  const namingPlan = (batchKeys) => {
    const namingDeps = {
      ...deps,
      groupStatementEntriesForGeneration: () => groups.slice(0, batchKeys.length),
      buildPreparedStatementBatchFromEntries: ({ config }) => batches[batchKeys[config.template.id - 1]],
      parseRequiredBillDates,
      buildDateRangeLabel
    };
    return loadMainFunction('buildStatementExportPlan', Object.keys(namingDeps), Object.values(namingDeps));
  };
  const names = (batchKeys) => ['balance', 'detail'].map((kind) => namingPlan(batchKeys)(kind, 'all').defaultFileName);
  assert.deepEqual(names(['mixed']), ['渠道1-BALANCE-2026-03-01.xlsx', '渠道1-COMMON-2026-02-01~2026-03-01.xlsx']);
  assert.deepEqual(names(['noBalance']), ['渠道1-BALANCE-2026-11-20.xlsx', '渠道1-COMMON-2026-02-01.xlsx']);
  assert.deepEqual(names(['zeroOnly']), ['渠道1-BALANCE-2026-11-20.xlsx', '渠道1-COMMON-2026-01-15.xlsx']);
  assert.deepEqual(names(['single']), ['渠道1-BALANCE-2026-02-10.xlsx', '渠道1-COMMON-2026-02-10.xlsx']);
  assert.deepEqual(names(['mixed', 'noBalance', 'single']),
    ['3-BALANCE-2026-02-10~2026-03-01.xlsx', '3-COMMON-2026-02-01~2026-03-01.xlsx']);
  // 原有校验不变：明细没有有效账单日期时照常报错
  const noDate = { detailRows: [H, ['', 'M1', 'USD', '5', '']], balanceRequested: false };
  const noDateDeps = { ...deps, groupStatementEntriesForGeneration: () => groups.slice(0, 1), buildPreparedStatementBatchFromEntries: () => noDate, parseRequiredBillDates, buildDateRangeLabel };
  assert.throws(() => loadMainFunction('buildStatementExportPlan', Object.keys(noDateDeps), Object.values(noDateDeps))('balance', 'all'), /BillDate/);
});

// v3.2.21（D3）：导入多组生成与补录重算同样先校验全部组：其他组的业务校验错误（如映射失效、写出前的日期检查）暂存、
//   不遮住渠道余额错误，其他错误（如源文件在确认期间变化）立即抛出；已确定整批失败后，后面的组只校验
//   （resolveEntryBalancePlan，只扫描不复制），不再构建、保留批次；写出前的检查在任何组写出之前对全部组做完
test('主进程：导入多组生成与补录重算中，其他组错误不遮住渠道余额错误，失败后其余组只校验不构建批次', () => {
  const buildChannelBalanceModeMismatchError = loadMainFunction('buildChannelBalanceModeMismatchError', ['FileValidationError', 'maskAccountLikeTextForLog'], [FileValidationError, loadMainFunction('maskAccountLikeTextForLog', [], [])]);
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', ['FileValidationError'], [FileValidationError]);
  const buildChannelBalancePlanningError = loadMainFunction(
    'buildChannelBalancePlanningError',
    ['buildChannelBalanceModeMismatchError', 'buildChannelBalanceRowsIncompleteError'],
    [buildChannelBalanceModeMismatchError, buildChannelBalanceRowsIncompleteError]
  );
  const rowsError = (tid) => buildChannelBalanceRowsIncompleteError([{
    channelName: `渠道${tid}`,
    lines: [`文件「${tid}.xlsx」（子模板「子${tid}」）第2行：缺少账单日期`],
    persistedLines: [`本组第1个文件（子模板「子${tid}」）第2行：缺少账单日期`],
    issueCount: 1
  }]);
  const mismatchError = (tid) => buildChannelBalanceModeMismatchError([{
    channelName: `渠道${tid}`, lines: [`账户 M${tid}（USD）：A${tid}（不出余额）、B${tid}（取账单余额列）`], accountCount: 1, templateNames: [`A${tid}`, `B${tid}`]
  }]);
  const sourceChangedError = () => Object.assign(
    new Error('网银明细源文件在确认期间已变化，请重新选择'),
    { code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION' }
  );
  const ROWS = 'CHANNEL_BALANCE_ROWS_INCOMPLETE';
  const MISMATCH = 'CHANNEL_BALANCE_MODE_MISMATCH';
  const cases = [
    // 第一组缺字段：后面的组只校验，不构建批次
    { label: '首组缺字段', failures: { 1: rowsError }, code: ROWS,
      lines: ['文件「1.xlsx」（子模板「子1」）第2行：缺少账单日期'], built: [1], resolved: [2, 3], checked: [] },
    // 前一组映射失效（生成配置报错）不遮住后面渠道的冲突
    { label: '其他组配置错误在前', configFailures: { 1: true }, failures: { 3: mismatchError }, code: MISMATCH,
      lines: ['账户 M3（USD）：A3（不出余额）、B3（取账单余额列）'], built: [], resolved: [2, 3], checked: [] },
    // 已识别的冲突不被后一组的配置错误遮住
    { label: '冲突在前、配置错误在后', configFailures: { 2: true }, failures: { 1: mismatchError }, code: MISMATCH,
      lines: ['账户 M1（USD）：A1（不出余额）、B1（取账单余额列）'], built: [1], resolved: [3], checked: [] },
    // 只有其他组错误时照常抛出
    { label: '只有配置错误', configFailures: { 2: true }, failures: {}, message: /必须映射 BillDate/, built: [1], resolved: [3], checked: [1] },
    // 写出前的检查（如后一组没有有效账单日期）在任何组写出之前做完
    { label: '后一组写出前检查失败', writableFailures: { 2: true }, failures: {}, message: /未找到有效的 BillDate/, built: [1, 2], resolved: [3], checked: [1, 2] },
    { label: '写出前检查失败在前、冲突在后', writableFailures: { 1: true }, failures: { 3: mismatchError }, code: MISMATCH,
      lines: ['账户 M3（USD）：A3（不出余额）、B3（取账单余额列）'], built: [1], resolved: [2, 3], checked: [1] },
    // 源文件在确认期间变化等非业务校验错误立即抛出，不被渠道余额错误覆盖
    { label: '源文件变化立即抛出', failures: { 1: rowsError, 2: sourceChangedError }, message: /源文件在确认期间已变化/, built: [1], resolved: [2], checked: [] }
  ];
  // 每组两个子模板、余额方式不同（mixedTids 之外的组方式相同）
  const groupsOf = (mixedTids = [1, 2, 3]) => [1, 2, 3].map((tid) => ({
    entries: [
      { matchedTemplateId: tid, filePath: `/tmp/${tid}.xlsx`, mode: 'calculated' },
      // 第二个子模板的 MerchantId 取所选大账号（需要注入），第一个取自原列
      { matchedTemplateId: tid + 100, filePath: `/tmp/${tid}-b.xlsx`, mode: mixedTids.includes(tid) ? 'statement' : 'calculated', usesBigAccount: true }
    ],
    templateIds: [tid, tid + 100],
    templateConfig: { template: { id: tid } }
  }));
  const harness = (planner, { configFailures = {}, configConflicts = {}, failures = {}, writableFailures = {}, groups = groupsOf() } = {}) => {
    const calls = { configReads: [], configured: [], built: [], resolved: [], resolvedEntries: [], checked: [], rebuilt: [], generated: [] };
    const deps = {
      groupStatementEntriesForGeneration: () => groups,
      getStatementSessionEntries: () => groups.flatMap((group) => group.entries),
      // 与真实实现一样按模板缓存：同一模板只读取一次配置
      getEntryTemplateConfig: ({ entry, cache = new Map() }) => {
        const id = entry.matchedTemplateId;
        if (!cache.has(id)) {
          calls.configReads.push(id);
          // 各子模板都是多大账号模板：判断是否全是多大账号模板时会逐个文件查看
          cache.set(id, { template: { id }, exportMappings: [{ templateField: 'MerchantId', mappedField: '__FIXED__:__MULTI__' }], exportTargetFields: [] });
        }
        return cache.get(id);
      },
      resolveEntryBalanceMode: (entry) => ({ templateName: `子${entry.matchedTemplateId}`, balanceMode: entry.mode }),
      collectGroupBalanceIssuesWithoutConfig: (group, { conflictGroups }) => {
        const tid = group.entries[0].matchedTemplateId;
        if (configConflicts[tid]) conflictGroups.push(mismatchError(tid).conflictGroups[0]);
      },
      normalizeCell,
      FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
      MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI__',
      FileValidationError,
      path,
      buildStatementGenerationConfig: ({ template }) => {
        calls.configured.push(template.id);
        if (configFailures[template.id]) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
        return { template };
      },
      entryUsesSelectedBigAccount: (entry) => Boolean(entry.usesBigAccount),
      rebuildMatchedTemplateFileEntries: ({ fileEntries }) => {
        calls.rebuilt.push(fileEntries.map((entry) => entry.matchedTemplateId));
        return fileEntries.map((entry) => ({ ...entry, rebuilt: true }));
      },
      buildPreparedStatementBatchFromEntries: ({ config }) => {
        calls.built.push(config.template.id);
        const failure = failures[config.template.id];
        if (failure) throw failure(config.template.id);
        return { detailRows: [], tid: config.template.id };
      },
      resolveEntryBalancePlan: ({ config, fileEntries }) => {
        calls.resolved.push(config.template.id);
        calls.resolvedEntries.push(fileEntries.map((entry) => [entry.matchedTemplateId, Boolean(entry.rebuilt)]));
        const failure = failures[config.template.id];
        if (failure) throw failure(config.template.id);
        return null;
      },
      assertStatementBatchWritable: ({ preparedBatch }) => {
        calls.checked.push(preparedBatch.tid);
        if (writableFailures[preparedBatch.tid]) throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
      },
      buildChannelBalancePlanningError,
      assertGenerationOutputNameUnique: () => {},
      findGenerationGroupOutputPathConflicts: () => null,
      removeStatementSessionEntriesByFilePath: () => {},
      generateStatementFiles: ({ preparedBatch }) => {
        calls.generated.push(preparedBatch.tid);
        return { warnings: [] };
      }
    };
    const run = loadMainFunction(planner, Object.keys(deps), Object.values(deps));
    let caught = null;
    try {
      if (planner === 'generateMultiTemplateGroupFiles') {
        run({ fileEntries: groups.flatMap((group) => group.entries), fallbackTemplateConfig: {}, selectedBigAccount: 'BIG', session: { key: 's' } });
      } else {
        run({ key: 's' }, 'current');
      }
    } catch (error) {
      caught = error;
    }
    return { caught, calls };
  };
  for (const planner of ['generateMultiTemplateGroupFiles', 'planVirtualTemplateBalanceRegeneration']) {
    for (const { label, code, lines, message, built, resolved, checked, ...options } of cases) {
      const { caught, calls } = harness(planner, options);
      const tag = `${planner}：${label}`;
      assert.ok(caught, tag);
      if (message) {
        assert.match(caught.message, message, tag);
      } else {
        assert.deepEqual([caught.code, caught.detailLines], [code, lines], tag);
      }
      assert.deepEqual([calls.built, calls.resolved, calls.checked], [built, resolved, checked], `${tag}：失败后其余组只校验、不构建批次`);
      assert.deepEqual(calls.generated, [], `${tag}：任何组都不写出`);
    }
  }
  // 补录重算：生成配置报错的渠道自身也有账户冲突时，按会话明细判断，与其他渠道一并列出（导入多组生成由导入预检的渠道组校验覆盖）
  const configConflict = harness('planVirtualTemplateBalanceRegeneration', { configFailures: { 1: true }, configConflicts: { 1: true }, failures: { 3: mismatchError } });
  assert.deepEqual([configConflict.caught.code, configConflict.caught.detailLines], [MISMATCH, [
    '渠道「渠道1」账户 M1（USD）：A1（不出余额）、B1（取账单余额列）',
    '渠道「渠道3」账户 M3（USD）：A3（不出余额）、B3（取账单余额列）'
  ]]);
  // 导入多组生成：同组多份文件命中同一子模板时只读取一次配置；整批已失败后不再为输出文件名判断是否全是多大账号模板
  const repeated = groupsOf().map((group) => ({ ...group, entries: [...group.entries, { ...group.entries[1], filePath: '/tmp/again.xlsx' }] }));
  const reads = harness('generateMultiTemplateGroupFiles', { failures: { 1: rowsError }, groups: repeated });
  assert.equal(reads.caught && reads.caught.code, ROWS);
  assert.deepEqual(reads.calls.configReads, [1, 101, 2, 3]);
  // 整批失败后单模板组不可能补充渠道余额诊断：不再读取配置
  const singleTemplateGroups = groupsOf().map((group) => (group.templateIds[0] === 2
    ? { ...group, entries: [group.entries[0]], templateIds: [2] }
    : group));
  for (const planner of ['generateMultiTemplateGroupFiles', 'planVirtualTemplateBalanceRegeneration']) {
    const single = harness(planner, { failures: { 1: rowsError }, groups: singleTemplateGroups });
    assert.equal(single.caught && single.caught.code, ROWS, planner);
    assert.deepEqual([single.calls.configured, single.calls.resolved], [[1, 3], [3]], `${planner}：单模板组不再读取配置`);
  }
  // 导入多组生成整批失败后，余额方式相同的组（含单模板组）不再为校验重建条目；余额方式不同的组只重建账号取自所选大账号
  //   的条目，其余沿用原条目（不复制明细），保持原文件顺序
  const { caught, calls } = harness('generateMultiTemplateGroupFiles', { failures: { 1: rowsError }, groups: groupsOf([1, 3]) });
  assert.equal(caught && caught.code, ROWS);
  assert.deepEqual([calls.rebuilt, calls.resolved, calls.resolvedEntries[0]], [[[1, 101], [103]], [3], [[3, false], [103, true]]]);
});

// v3.2.21（D3）：注入大账号后的复核只涉及含待注入条目的渠道（同渠道未变的条目留作比对对象），其余渠道的账号都来自原列，
//   导入预检已按原行判断过，不再读配置、扫描交易行
test('主进程：注入大账号后的复核只涉及含待注入条目的渠道', () => {
  const entries = [
    { matchedTemplateId: 1, name: 'A1', big: true },
    { matchedTemplateId: 2, name: 'A2' },
    { matchedTemplateId: 3, name: 'B1' },
    { matchedTemplateId: 4, name: 'B2' }
  ];
  const channelOf = { 1: 'A', 2: 'A', 3: 'B', 4: 'B' };
  const resolved = [];
  const groupedInputs = [];
  let checkedGroups = null;
  const deps = {
    database: { getTemplate: (id) => ({ id, channelId: channelOf[id] }) },
    resolveGenerationGroupKey: (template) => `channel:${template.channelId}`,
    // 只为含待注入条目的渠道分组、读取配置
    groupStatementEntriesForGeneration: (input) => {
      groupedInputs.push(input.map((entry) => entry.name));
      return [{ key: 'channel:A', entries: input, templateIds: [1, 2] }];
    },
    collectGenerationGroupBalanceModeConflicts: (input) => {
      checkedGroups = input;
      return null;
    }
  };
  const find = loadMainFunction('findResolvedEntriesBalanceModeConflicts', Object.keys(deps), Object.values(deps));
  const result = find(entries, (pending) => {
    resolved.push(pending.map((entry) => entry.name));
    return pending.map((entry) => ({ ...entry, resolved: true }));
  }, (entry) => Boolean(entry.big));
  assert.equal(result, null);
  assert.deepEqual([resolved, groupedInputs], [[['A1']], [['A1', 'A2']]]);
  assert.deepEqual(checkedGroups.map((group) => [group.key, group.entries.map((entry) => [entry.name, Boolean(entry.resolved)])]),
    [['channel:A', [['A1', true], ['A2', false]]]]);
  // 没有待注入的条目时不分组、不注入
  assert.equal(find(entries, () => {
    throw new Error('不应注入');
  }, () => false), null);

  // 同次预检已记下各条目所属渠道与余额方式时直接复用：不再分组、读取模板配置，只替换注入后的明细行再判断
  const identity = require('../../../src/main-process/statement-channel-identity');
  const { resolveAccountBalanceModes } = require('../../../src/main-process/statement-generation-business');
  const formatBalanceModeConflictLines = loadMainFunction('formatBalanceModeConflictLines', ['describeBalanceMode'], [identity.describeBalanceMode]);
  const buildBalanceModeConflictGroup = loadMainFunction('buildBalanceModeConflictGroup', ['formatBalanceModeConflictLines'], [formatBalanceModeConflictLines]);
  const recordedDeps = {
    groupStatementEntriesForGeneration: () => {
      throw new Error('不应重新分组');
    },
    resolveAccountBalanceModes,
    buildBalanceModeConflictGroup
  };
  const findRecorded = loadMainFunction('findResolvedEntriesBalanceModeConflicts', Object.keys(recordedDeps), Object.values(recordedDeps));
  const rowsOf = (merchantId) => detailRows([['2026-09-01', merchantId, 'USD', '1', '']]);
  const owner = { name: 'A1', detailRows: rowsOf('M1') };
  const child = { name: 'A2', big: true, detailRows: rowsOf('') };
  const other = { name: 'B1', detailRows: rowsOf('M9') };
  const recordedModes = new Map([
    [owner, { groupKey: 'channel:A', channelName: '渠道A', mode: { templateName: 'A1', balanceMode: 'none' } }],
    [child, { groupKey: 'channel:A', channelName: '渠道A', mode: { templateName: 'A2', balanceMode: 'statement' } }],
    [other, { groupKey: 'channel:B', channelName: '渠道B', mode: { templateName: 'B1', balanceMode: 'calculated' } }]
  ]);
  const injected = [];
  const recordedConflicts = findRecorded([owner, child, other], (pending) => {
    injected.push(pending.map((entry) => entry.name));
    return pending.map(() => ({ detailRows: rowsOf('M1') }));
  }, (entry) => Boolean(entry.big), recordedModes);
  assert.deepEqual([injected, recordedConflicts && recordedConflicts.map((group) => [group.channelName, group.lines])], [
    [['A2']],
    [['渠道A', ['账户 M1（USD）：A1（不出余额）、A2（取账单余额列）']]]
  ]);
});

// v3.2.21（D3）：「导出全部」另存为框打开期间映射变化、渠道余额校验不通过时，确认后在开始任务之前带逐行明细拒绝
//   （不预留输出、不进入执行）；其他变化照常交给 beforeStart 按“会话已变化”拒绝
test('主进程：导出另存为确认后复检遇到渠道余额错误时在开始任务前带明细拒绝', async () => {
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID };
  const okPlan = { normalizedScope: 'all', session, generatedFile: null, needsGeneration: true, defaultFileName: '2-BALANCE-x.xlsx' };
  const channelStop = { status: 'error', errorCode: 'CHANNEL_BALANCE_MODE_MISMATCH', detailLines: ['账户 M1（USD）：A（不出余额）、B（取账单余额列）'] };
  const prepareWith = ({ recheck, laterPlan = okPlan }) => {
    let calls = 0;
    const deps = {
      buildStatementExportPlan: () => (calls++ === 0 ? okPlan : laterPlan),
      recheckStatementExportChannelBalance: (kind, plan) => {
        assert.deepEqual([kind, plan], ['balance', okPlan]);
        if (recheck instanceof Error) throw recheck;
        return recheck;
      },
      createPreflightErrorResult: (payload) => ({ status: 'error', ...payload }),
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/out.xlsx' }) },
      mainWindow: null
    };
    return loadNestedMainDeclaration('prepareStatementExport', deps);
  };
  const rejected = await prepareWith({ recheck: channelStop })('balance', 'all');
  assert.deepEqual([rejected.proceed, rejected.result, rejected.filePlan], [false, channelStop, undefined]);
  const passed = await prepareWith({ recheck: null })('balance', 'all');
  assert.equal(passed.proceed, true);
  assert.doesNotThrow(() => passed.beforeStart());
  // 复检报错时交给 beforeStart；确认之后到任务开始之间才出现的停下原因（含渠道余额错误）照常按会话已变化拒绝
  const recheckError = await prepareWith({ recheck: new Error('映射缺字段') })('balance', 'all');
  assert.equal(recheckError.proceed, true);
  const late = await prepareWith({ recheck: null, laterPlan: { stopResult: channelStop, normalizedScope: 'all', session } })('balance', 'all');
  assert.throws(() => late.beforeStart(), /保存确认期间已变化/);
});

// 复检只在需要重新生成的按文件名映射会话中进行，只看多个子模板的渠道组，只扫描不复制（不构建批次、不解析日期）
test('主进程：导出另存为确认后的渠道余额复检只看可能冲突的渠道组', () => {
  const buildChannelBalanceModeMismatchError = loadMainFunction('buildChannelBalanceModeMismatchError', ['FileValidationError', 'maskAccountLikeTextForLog'], [FileValidationError, loadMainFunction('maskAccountLikeTextForLog', [], [])]);
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', ['FileValidationError'], [FileValidationError]);
  const buildChannelBalancePlanningError = loadMainFunction(
    'buildChannelBalancePlanningError',
    ['buildChannelBalanceModeMismatchError', 'buildChannelBalanceRowsIncompleteError'],
    [buildChannelBalanceModeMismatchError, buildChannelBalanceRowsIncompleteError]
  );
  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID };
  const plan = { normalizedScope: 'all', session, needsGeneration: true };
  const groups = [
    { key: 'channel:1', entries: [{ matchedTemplateId: 1 }, { matchedTemplateId: 101 }], templateIds: [1, 101], templateConfig: { template: { id: 1 } } },
    { key: 'template:2', entries: [{ matchedTemplateId: 2 }], templateIds: [2], templateConfig: { template: { id: 2 } } },
    { key: 'channel:3', entries: [{ matchedTemplateId: 3 }, { matchedTemplateId: 103 }], templateIds: [3, 103], templateConfig: { template: { id: 3 } } }
  ];
  const run = ({ currentSession = session, cached = null, configFailures = {}, failures = {}, fallbackConflict = false, inputPlan = plan } = {}) => {
    const calls = { grouped: 0, configured: [], resolved: [], withoutConfig: [] };
    const deps = {
      getCurrentStatementSession: () => currentSession,
      isFilenameMappingMode: (templateId) => templateId === FILENAME_MAPPING_TEMPLATE_ID,
      getGeneratedStatementExport: () => cached,
      fs: { existsSync: () => true },
      getStatementSessionEntries: () => groups.flatMap((group) => group.entries),
      groupStatementEntriesForGeneration: () => {
        calls.grouped += 1;
        return groups;
      },
      FileValidationError,
      buildStatementGenerationConfig: ({ template }) => {
        calls.configured.push(template.id);
        if (configFailures[template.id]) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
        return { template };
      },
      resolveEntryBalancePlan: ({ config }) => {
        calls.resolved.push(config.template.id);
        const failure = failures[config.template.id];
        if (failure) throw failure();
        return null;
      },
      collectGroupBalanceIssuesWithoutConfig: (group, { conflictGroups }) => {
        calls.withoutConfig.push(group.key);
        if (fallbackConflict) conflictGroups.push({ channelName: '渠道1', lines: ['账户 M1（USD）：A1（不出余额）、B1（取账单余额列）'], accountCount: 1, templateNames: ['A1', 'B1'] });
      },
      buildChannelBalancePlanningError,
      createPreflightErrorResult: (payload) => ({ status: 'error', ...payload })
    };
    const result = loadMainFunction('recheckStatementExportChannelBalance', Object.keys(deps), Object.values(deps))('balance', inputPlan);
    return { result, calls };
  };
  // 不需要复检：无需生成、指定模板会话、会话已变化、已有缓存
  for (const [label, options] of [
    ['无需生成', { inputPlan: { ...plan, needsGeneration: false } }],
    ['指定模板会话', { currentSession: { ...session, templateId: 7 }, inputPlan: { ...plan, session: { ...session, templateId: 7 } } }],
    ['会话已变化', { currentSession: { key: 'session-2', templateId: FILENAME_MAPPING_TEMPLATE_ID } }],
    ['已有缓存', { cached: { filePath: '/tmp/all.xlsx' } }]
  ]) {
    const { result, calls } = run(options);
    assert.deepEqual([result, calls.grouped], [null, 0], label);
  }
  // 只为多个子模板的渠道组构建配置并扫描；冲突带明细返回
  const mismatch = () => buildChannelBalanceModeMismatchError([{ channelName: '渠道3', lines: ['账户 M3（USD）：A3（不出余额）、B3（取账单余额列）'], accountCount: 1, templateNames: ['A3', 'B3'] }]);
  const conflict = run({ failures: { 3: mismatch } });
  assert.deepEqual([conflict.result.errorCode, conflict.result.detailLines, conflict.calls.configured, conflict.calls.resolved],
    ['CHANNEL_BALANCE_MODE_MISMATCH', ['账户 M3（USD）：A3（不出余额）、B3（取账单余额列）'], [1, 3], [1, 3]]);
  // 生成配置报错的渠道按会话明细校验
  const fallback = run({ configFailures: { 1: true }, fallbackConflict: true });
  assert.deepEqual([fallback.result.errorCode, fallback.calls.withoutConfig, fallback.calls.resolved], ['CHANNEL_BALANCE_MODE_MISMATCH', ['channel:1'], [3]]);
  // 没有渠道余额问题时返回 null（映射缺字段等由 beforeStart 处理）
  assert.equal(run({ configFailures: { 1: true } }).result, null);
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

// v3.2.17：补录余额「导入余额文件」所需的待补录账号清单
test('scanBalanceSeedStatus 返回待补录账号清单：按账号、币种排序（与逐个提示顺序一致），已有更早种子的账号不在内', (t) => {
  const root = createTempRoot(t);
  upsertBalanceSeedRecord(root, {
    templateName: TEMPLATE_NAME,
    merchantId: 'M002',
    currency: 'USD',
    billDate: '2026-09-29',
    endBalance: 10
  });
  const status = scanStatementBalanceSeedStatus({
    templateName: TEMPLATE_NAME,
    detailRows: detailRows([
      ['2026-10-02', 'M003', 'USD', '1', ''],
      ['2026-10-01', 'M002', 'USD', '1', ''],
      ['2026-10-03', 'M001', 'USD', '1', ''],
      ['2026-10-01', 'M001', 'EUR', '1', ''],
      ['2026-10-02', 'M001', 'USD', '1', '']
    ])
  }, root);
  assert.equal(status.missing, 3);
  assert.deepEqual(status.missingAccounts, [
    { merchantId: 'M001', currency: 'EUR', targetBillDate: '2026-10-01' },
    { merchantId: 'M001', currency: 'USD', targetBillDate: '2026-10-02' },
    { merchantId: 'M003', currency: 'USD', targetBillDate: '2026-10-02' }
  ]);
});

// v3.2.17：导入余额文件后逐个保存时请求带目标账号，与当前待补录账号不一致即拒绝（不写到别的账号）
test('补录请求带的账号与当前待补录账号不一致时拒绝，不生成写入计划；一致或不带账号照常', (t) => {
  const storageRoot = createTempRoot(t);
  const pendingPrompt = { templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD', targetBillDate: '2026-09-02' };
  const prepare = (payload) => prepareManualBalanceSeedSubmission({
    payload,
    pendingPrompt,
    importContext: { scope: 'current', template: { name: TEMPLATE_NAME } },
    storageRoot,
    session: null,
    createContextId: () => 'unused',
    createFreshnessGuard: () => ({ inputFilePaths: ['/tmp/source.xlsx'], assertFresh() {} })
  }).prepared;

  for (const account of [
    { merchantId: 'M002', currency: 'USD' },
    { merchantId: 'M001', currency: 'EUR' },
    { merchantId: 'M001' },
    { merchantId: 'M001', currency: 'USD', templateName: '工行-北京' },
    { templateName: '工行-北京' }
  ]) {
    const rejected = prepare({ billDate: '2026-09-01', endBalance: '100', ...account });
    assert.equal(rejected.proceed, false);
    assert.equal(rejected.result.errorCode, 'BALANCE_SEED_ACCOUNT_CHANGED');
    assert.equal(rejected.plan, undefined);
    // 带回当前待补录提示，渲染层按当前账号重新打开补录
    assert.equal(rejected.result.status, 'manual-balance-invalid');
    assert.equal(rejected.result.manualBalancePromptReady, true);
    assert.deepEqual(rejected.result.manualBalancePrompt, pendingPrompt);
  }
  const sameGroup = prepare({ billDate: '2026-09-01', endBalance: '100', merchantId: 'M001', currency: 'USD', templateName: TEMPLATE_NAME });
  assert.equal(sameGroup.proceed, true);
  const matched = prepare({ billDate: '2026-09-01', endBalance: '100', merchantId: ' M001 ', currency: 'USD' });
  assert.equal(matched.proceed, true);
  assert.deepEqual([matched.plan.record.merchantId, matched.plan.record.currency, matched.plan.record.endBalance], ['M001', 'USD', 100]);
  const manual = prepare({ billDate: '2026-09-01', endBalance: '100' });
  assert.equal(manual.proceed, true);
  assert.equal(manual.plan.record.merchantId, 'M001');
});

// release 审查：补录重算与导出全部的多组余额汇总文件同样按各组实际写出的余额记录日期命名（与单组余额文件、导入多组生成同口径），
//   不按全部明细日期：渠道组内不出余额的子模板的交易不进余额文件
test('主进程：补录重算与导出全部的余额汇总文件按各组余额记录的日期命名，明细汇总按全部明细日期', async () => {
  const detailDatesByGroup = { 1: ['2026-10-05', '2026-11-01'], 2: ['2026-11-02'] };
  const balanceDatesByGroup = { 1: ['2026-11-01'], 2: ['2026-11-02'] };
  // 生成结果带各自文件名用的日期：明细剔除了跳过的零金额行（批次明细里另有 9-30 的零金额行，不进汇总文件名）
  const generatedOf = (tid) => ({
    detail: { filePath: `/tmp/detail-${tid}.xlsx`, billDates: detailDatesByGroup[tid] },
    balance: { filePath: `/tmp/balance-${tid}.xlsx`, billDates: balanceDatesByGroup[tid] },
    warnings: []
  });
  const outputDeps = {
    buildDateRangeLabel,
    getToday: () => '2026-11-22',
    buildOutputFilePath: ({ outputFileName }) => ({ outputFilePath: `/tmp/out/${outputFileName}` }),
    scopedMergedOutputFileName: (name) => name,
    mergeGeneratedXlsxFiles: () => {}
  };

  const gapGeneration = createStatementGenerationHelpers({});
  const regenerateDeps = {
    ...outputDeps,
    appendActivityLogEntry: () => {},
    assertVirtualTemplateBalanceOutputPaths: () => {},
    generateStatementFiles: ({ preparedBatch }) => generatedOf(preparedBatch.tid),
    parseRequiredBillDates: (rows) => rows.slice(),
    extractManualBalancePromptWarning: gapGeneration.extractManualBalancePromptWarning,
    statementGenerationHelpers: gapGeneration,
    path
  };
  const regenerate = loadMainFunction('regenerateVirtualTemplateBalanceFromSession', Object.keys(regenerateDeps), Object.values(regenerateDeps));
  const regenerated = regenerate({ key: 'session-1' }, 'all', {
    scope: 'all',
    generationGroups: [{}, {}],
    groupPlans: [1, 2].map((tid) => ({ config: { template: { id: tid } }, preparedBatch: { tid, detailRows: detailDatesByGroup[tid] } })),
    skippedGroups: []
  });
  assert.equal(regenerated.generatedFiles.balance.fileName, '2-BALANCE-2026-11-01~2026-11-02.xlsx');

  const session = { key: 'session-1', templateId: FILENAME_MAPPING_TEMPLATE_ID, currentBatchId: 'batch-1', templateName: '按文件名映射模板' };
  for (const [kind, expected] of [['balance', '2-BALANCE-2026-11-01~2026-11-02.xlsx'], ['detail', '2-COMMON-2026-10-05~2026-11-02.xlsx']]) {
    const exported = [];
    const { deps } = virtualExportAllDeps({ session, groups: [1, 2], generated: { 1: generatedOf(1), 2: generatedOf(2) } });
    const result = await loadExportStatementByScope({
      ...deps,
      ...outputDeps,
      buildPreparedStatementBatchFromEntries: ({ config }) => ({ detailRows: [...detailDatesByGroup[config.template.id], '2026-09-30'], tid: config.template.id }),
      parseRequiredBillDates: (rows) => rows.slice(),
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      exportGeneratedFile: async (generatedFile) => {
        exported.push(generatedFile.fileName);
        return { status: 'success' };
      }
    })(kind, 'all');
    assert.equal(result.status, 'success', `${kind}：${JSON.stringify(result)}`);
    assert.deepEqual(exported, [expected], kind);
  }
});

// release 审查：生成结果只带文件名用的首末日期（明细：写出的行；余额：余额记录），不缓存逐笔日期
test('generateStatementFiles：明细与余额结果的 billDates 只有首末日期，跳过的零金额行不算', (t) => {
  const root = createTempRoot(t);
  const storageRoot = path.join(root, 'storage');
  const generation = createGenerationSeam(storageRoot);
  upsertBalanceSeedRecord(storageRoot, {
    templateName: TEMPLATE_NAME, merchantId: 'M001', currency: 'USD',
    billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入'
  });
  const entry = mappedSourceEntry(root, 'bounds.xlsx', [
    ['2026-09-01', 'M001', 'USD', '1', ''],
    ['2026-09-02', 'M001', 'USD', '2', ''],
    ['2026-09-01', 'M001', 'USD', '3', ''],
    ['2026-09-03', 'M001', 'USD', '0', '']
  ]);
  const config = { template: { id: 1, name: TEMPLATE_NAME }, mappingByTargetField: { MerchantId: 'Account' }, balanceRequested: true, balanceMode: 'calculated' };
  const preparedBatch = generation.buildPreparedStatementBatchFromEntries({ config, fileEntries: [entry] });
  const result = generation.generateStatementFiles({ config, preparedBatch, scope: 'current' });
  assert.deepEqual([result.detail.billDates, result.balance.billDates], [['2026-09-01', '2026-09-02'], ['2026-09-01', '2026-09-02']]);
});
