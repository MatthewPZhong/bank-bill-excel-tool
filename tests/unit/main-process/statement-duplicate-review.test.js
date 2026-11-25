'use strict';

// v3.2.19 原始账单预处理「重复账单过滤」的导入暂停 / 确认 / 取消（spec §8.3）：
//   - 没有指纹（未勾选）或没有重复时放行；预检发现重复时暂停；
//   - 执行阶段须带与扫描一致的确认摘要才删除重复行，否则拒绝生成（返回值，不抛出）；
//   - 待确认上下文单槽保存：remember / requireContext / clear / cancel，取消写活动日志；
//   - 主进程：预检暂停在导入的 prepare 中返回、续跑分支在文件选择之前、各执行路径在组批之前经过复核。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DUPLICATE_REVIEW_STATUS,
  DUPLICATE_ROWS_REVIEW_STALE,
  createStatementDuplicateReview,
  hasSourceRowKeys
} = require('../../../src/main-process/statement-duplicate-review');
const {
  dropDuplicateSourceRows,
  scanDuplicateSourceRows
} = require('../../../src/backend/file-service/duplicate-source-rows');

const HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];

function entry(filePath, rows) {
  const detailRows = [HEADER.slice()].concat(rows.map((row) => row.slice(2)));
  detailRows.rowMetas = rows.map(([sourceRowNumber, key]) => (key ? { sourceRowNumber, sourceRowKey: key } : { sourceRowNumber }));
  return { filePath, detailRows };
}

const DUPLICATED = [entry('/in/a.xlsx', [
  [2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''],
  [3, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''],
  [4, 'K2', '2026-11-02', 'ACC1', 'USD', '', '5']
])];

function createService() {
  const logs = [];
  let seq = 0;
  const service = createStatementDuplicateReview({
    randomUUID: () => `ctx-${++seq}`,
    appendActivityLogEntry: (item) => logs.push(item),
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    scanDuplicateSourceRows,
    dropDuplicateSourceRows
  });
  return { service, logs };
}

test('放行：没有指纹（未勾选）或没有重复时原样返回', () => {
  const { service } = createService();
  const plain = [entry('/in/a.xlsx', [[2, '', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, '', '2026-11-01', 'ACC1', 'USD', '100', '']])];
  assert.equal(hasSourceRowKeys(plain), false);
  assert.deepEqual(service.review({ entries: plain, phase: 'preview' }), { status: 'pass', entries: plain });
  const unique = [entry('/in/a.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']])];
  assert.equal(service.review({ entries: unique, phase: 'execute', prepared: {} }).status, 'pass');
});

test('预检暂停 → 记下上下文 → 复核结果按组列出文件、行号、账户号、账期与保留 / 去除', () => {
  const { service, logs } = createService();
  const outcome = service.review({ entries: DUPLICATED, phase: 'preview', templateName: '模板A' });
  assert.equal(outcome.status, 'pause');
  const context = service.remember({ kind: 'file-import', templateId: 7, prepared: { marker: true }, scan: outcome.scan, templateName: '模板A' });
  assert.equal(context.contextId, 'ctx-1');
  assert.equal(context.digest, outcome.scan.digest);
  assert.equal(service.requireContext('ctx-1'), context);
  assert.equal(service.requireContext('other'), null);
  assert.equal(logs.at(-1).message, '发现重复账单，等待确认');
  assert.deepEqual(logs.at(-1).details.slice(2), [
    '去除行号 · 第 1 个文件：第 3 行（1 行）',
    // 持久化的活动日志里不写文件名、账户号只留末 4 位（4 位及以下全部隐去）；弹窗显示原值
    '重复组 #1：第 1 个文件 第 2 行，账户号：****（USD），账期：2026-11-01，保留',
    '重复组 #1：第 1 个文件 第 3 行，账户号：****（USD），账期：2026-11-01，去除'
  ]);
  const result = service.buildReviewResult(outcome.scan, { contextId: 'ctx-1', reviewKind: 'file-import', templateName: '模板A' });
  assert.equal(result.status, DUPLICATE_REVIEW_STATUS);
  assert.deepEqual({ ...result, message: undefined }, {
    status: 'duplicate-review',
    contextId: 'ctx-1',
    reviewKind: 'file-import',
    templateName: '模板A',
    message: undefined,
    totalGroups: 1,
    totalRowCount: 2,
    displayedRowCount: 2,
    droppedRowCount: 1,
    truncated: false,
    dropPlanLines: [],
    groups: [{
      seq: 1,
      accountLabel: 'ACC1（USD）',
      billDate: '2026-11-01',
      hiddenRowCount: 0,
      rows: [{ fileName: 'a.xlsx', sourceRowNumber: 2, kept: true }, { fileName: 'a.xlsx', sourceRowNumber: 3, kept: false }]
    }]
  });
});

test('执行：确认摘要一致才删除重复行并写日志；未确认或摘要不符时返回拒绝结果', () => {
  const { service, logs } = createService();
  const { scan } = service.review({ entries: DUPLICATED, phase: 'preview' });
  for (const prepared of [null, {}, { duplicateReviewConfirmation: { contextId: 'x', digest: 'stale' } }]) {
    const stale = service.review({ entries: DUPLICATED, phase: 'execute', prepared, templateName: '模板A' });
    assert.equal(stale.status, 'stale');
    assert.deepEqual([stale.result.status, stale.result.errorCode, stale.result.message],
      ['error', DUPLICATE_ROWS_REVIEW_STALE, '重复账单与确认时不一致，请重新导入文件']);
  }
  const dropped = service.review({
    entries: DUPLICATED,
    phase: 'execute',
    prepared: { duplicateReviewConfirmation: { contextId: 'ctx-1', digest: scan.digest } },
    templateName: '模板A'
  });
  assert.equal(dropped.status, 'dropped');
  assert.equal(dropped.droppedRowCount, 1);
  assert.deepEqual(dropped.entries[0].detailRows.rowMetas.map((meta) => meta.sourceRowNumber), [2, 4]);
  assert.equal(logs.at(-1).message, '已确认过滤重复账单');
  assert.deepEqual(DUPLICATED[0].detailRows.rowMetas.map((meta) => meta.sourceRowNumber), [2, 3, 4], '原条目不变');
});

test('执行：确认续跑时重新扫描须仍与确认一致——指纹缺失或重复消失也拒绝，不静默放行（按告警级别记日志）', () => {
  const { service, logs } = createService();
  const { scan } = service.review({ entries: DUPLICATED, phase: 'preview' });
  const prepared = { duplicateReviewConfirmation: { contextId: 'ctx-1', digest: scan.digest } };
  const noKeys = [entry('/in/a.xlsx', [[2, '', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, '', '2026-11-01', 'ACC1', 'USD', '100', '']])];
  const noDuplicates = [entry('/in/a.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']])];
  for (const entries of [noKeys, noDuplicates]) {
    const outcome = service.review({ entries, phase: 'execute', prepared, templateName: '模板A' });
    assert.deepEqual([outcome.status, outcome.result && outcome.result.errorCode], ['stale', DUPLICATE_ROWS_REVIEW_STALE]);
    assert.deepEqual([logs.at(-1).level, logs.at(-1).message], ['warning', '重复账单与确认时不一致，已拒绝生成']);
  }
  // 预检阶段带着旧确认也只按扫描结果判断
  assert.equal(service.review({ entries: noDuplicates, phase: 'preview', prepared }).status, 'pass');
});

test('上下文：单槽保存；clear 只清匹配的上下文；cancel 清除并写日志，重复取消返回 null', () => {
  const { service, logs } = createService();
  const { scan } = service.review({ entries: DUPLICATED, phase: 'preview' });
  service.remember({ kind: 'file-import', templateId: 7, scan, templateName: '模板A' });
  const second = service.remember({ kind: 'big-account', templateId: 7, bigAccountContextId: 'big-1', scan, templateName: '模板A' });
  assert.equal(service.requireContext('ctx-1'), null, '新的待确认覆盖旧的');
  assert.equal(service.clear('ctx-1'), false);
  assert.equal(service.requireContext('ctx-2'), second);
  assert.equal(service.cancel('ctx-2'), second);
  assert.equal(logs.at(-1).message, '已取消导入（重复账单）');
  assert.equal(service.cancel('ctx-2'), null);
  service.remember({ kind: 'file-import', templateId: 7, scan, templateName: '模板A' });
  assert.equal(service.clear(), true);
  assert.equal(service.requireContext('ctx-3'), null);
});

test('复核结果：按行数封顶（每次最多 1000 行），超出的组只列出前面的行并标记', () => {
  const { service } = createService();
  const rows = [];
  for (let index = 0; index < 501; index += 1) {
    rows.push([2 + index * 2, `K${index}`, '2026-11-01', 'ACC1', 'USD', '1', '']);
    rows.push([3 + index * 2, `K${index}`, '2026-11-01', 'ACC1', 'USD', '1', '']);
  }
  const { scan } = service.review({ entries: [entry('/in/big.xlsx', rows)], phase: 'preview' });
  const result = service.buildReviewResult(scan, { contextId: 'c', reviewKind: 'file-import' });
  assert.deepEqual([result.groups.length, result.totalGroups, result.totalRowCount, result.displayedRowCount, result.droppedRowCount, result.truncated],
    [500, 501, 1002, 1000, 501, true]);
  // 超出显示上限时复核结果自带完整的去除行号（不依赖活动日志写入成功）
  assert.deepEqual(result.dropPlanLines, [`第 1 个文件 big.xlsx：第 ${Array.from({ length: 501 }, (_value, index) => 3 + index * 2).join('、')} 行（501 行）`]);

  // 一组里有上万行：只发前 1000 行，标出该组未列出的行数
  const oneGroup = Array.from({ length: 1500 }, (_value, index) => [2 + index, 'K', '2026-11-01', 'ACC1', 'USD', '1', '']);
  const single = service.buildReviewResult(service.review({ entries: [entry('/in/one.xlsx', oneGroup)], phase: 'preview' }).scan, { contextId: 'c', reviewKind: 'file-import' });
  assert.deepEqual([single.groups.length, single.groups[0].rows.length, single.groups[0].hiddenRowCount, single.displayedRowCount, single.truncated],
    [1, 1000, 500, 1000, true]);
});

function assertBefore(body, first, second, message) {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  assert.ok(firstIndex >= 0, `${message}：未找到 ${first}`);
  assert.ok(secondIndex >= 0, `${message}：未找到 ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

// 主进程接入点按源码形状核对：漏接任一导入路径会让重复行静默进入明细，这里锁定位置与顺序。
test('主进程：预检暂停与续跑接在导入 prepare 中，执行路径在组批前经过复核', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const prepareStart = source.indexOf('const fileImportHandler = {');
  const prepareBody = source.slice(prepareStart, source.indexOf('async execute(_event, prepared, taskContext, templateId) {', prepareStart));
  assertBefore(prepareBody, 'duplicateReviewContextId', 'prepareStatementImportFiles(', '续跑分支须在文件选择之前');
  assert.match(prepareBody, /previewResult\.status === DUPLICATE_REVIEW_STATUS[\s\S]*statementDuplicateReview\.remember\(/);

  // 指定模板导入：复用条目的生成分支在组批前复核（v3.2.22 起去掉「记住顺序自动套用」分支）
  const reusedBranch = source.slice(source.indexOf('const reviewedEntries = applyConfirmedDuplicateRowFilter('), source.indexOf('} else {\n        generatedFiles = prepareGeneratedFiles({'));
  assert.ok(source.indexOf('const reviewedEntries = applyConfirmedDuplicateRowFilter(') >= 0);
  assertBefore(reusedBranch, 'if (reviewedEntries.result) return reviewedEntries.result;', 'buildPreparedStatementBatchFromEntries(', '复用条目分支先复核再组批');
  // 查重范围：预检与执行都按生成组标注后再查重（不同生成组的相同行不互判重复）
  assert.match(source, /review\(\{ entries: scopeDuplicateEntries\(entries\), prepared, phase: 'preview'/);
  assert.match(source, /review\(\{ entries: scopeDuplicateEntries\(entries\), prepared, phase: 'execute'[\s\S]{0,200}unscopeDuplicateEntries\(outcome\.entries\)/);
  // v3.2.22：记住顺序自动套用整段下线，不再存在绕过手动选择的组批路径
  assert.equal(source.indexOf('reviewedAutoEntries'), -1);
  assert.equal(source.indexOf('autoMatchError'), -1);
  // 勾选时普通路径改走复用条目分支（不再直接 prepareGeneratedFiles 映射并生成）
  assert.match(source, /isDuplicateRowFilterEnabled\(templateConfig\.exportMappings\) && !selectionResult\.parentProvisionalEntries/);

  // 按文件名映射：预检在最终条目上查重暂停（执行计划的实际行为见下方真实调用测试）
  const handleBody = source.slice(source.indexOf('async function handleFilenameMappingImport(prepared) {'));
  // v3.2.21：最终条目在预检内只构建一次，余额方式冲突与重复账单两项检查共用（resolveFinalEntries）
  assert.match(handleBody, /const resolveFinalEntries = \(\) => finalEntries \|\| \(finalEntries = resolveFilenameMappingFinalEntries\(statementImportPlan\)\);/);
  assertBefore(handleBody, 'previewDuplicateRows(\n          resolveFinalEntries()', 'return statementImportPreviewReady();',
    '按文件名映射预检先查重再放行');

  // 大账号选择完成：prepare 在分配后预检，execute 在分叉前复核
  const completeBody = source.slice(source.indexOf('const completeBigAccountSelectionHandler = {'), source.indexOf("'file:complete-big-account-selection',\n    '生成账单'"));
  // v3.2.21：分配后的条目在预检内只构建一次，余额方式冲突与重复账单两项检查共用（resolveAssignedEntries）
  assert.match(completeBody, /const resolveAssignedEntries = \(\) => assignedEntries \|\| \(assignedEntries = applyBigAccountAssignmentsToFileEntries\(/);
  assert.match(completeBody, /previewDuplicateRows\(\s*resolveAssignedEntries\(\)/);
  const executeBody = completeBody.slice(completeBody.indexOf('async execute(_event, prepared, taskContext) {'));
  assertBefore(executeBody, 'applyConfirmedDuplicateRowFilter(', 'generateMultiTemplateGroupFiles(', '大账号完成先复核再分组生成');
  // 普通选择（不经重复账单确认）在任务开始前同样核对暂存的配置指纹
  const beforeStartBody = completeBody.slice(completeBody.indexOf('beforeStart() {'), completeBody.indexOf('async execute(_event, prepared, taskContext) {'));
  assert.match(beforeStartBody, /!review && mappingConfig && !isImportConfigStampCurrent\(mappingConfig\)[\s\S]*DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE/);

  // 会话覆盖：选择文件后、放行前核对单独覆盖保留方文件的情况
  const selectionBody = source.slice(source.indexOf('async function prepareStatementImportFiles(templateId, templateName) {'));
  assert.match(selectionBody, /describeDuplicateKeeperReplacementConflicts\(keeperConflicts\)/, '覆盖提示按整组文件生成');
  assertBefore(selectionBody, 'findDuplicateKeeperReplacementConflicts(previewSession.fileEntries, selectionResult.replacePaths)',
    'proceed: true,', '单独覆盖保留方文件在放行前拦下');
  // 大账号选择：暂存选择上下文时记下映射条目时的配置指纹；完成选择时先核对，再查重，并把这份指纹交给复核
  const previewHandlerBody = source.slice(source.indexOf('const fileImportHandler = {'), source.indexOf('const completeBigAccountSelectionHandler = {'));
  assertBefore(previewHandlerBody, 'pendingContext.duplicateReviewConfig = {', 'const contextId = rememberPendingBigAccountSelection(pendingContext);',
    '暂存大账号选择前记下映射时的配置指纹');
  assertBefore(completeBody, '!isImportConfigStampCurrent(mappingConfig)', 'const paused = previewDuplicateRows(',
    '完成大账号选择时先核对映射时的配置，再查重');
  assert.match(completeBody, /configStamp: mappingConfig \? mappingConfig\.stamp :/);
  // 大账号完成的确认续跑：先核对等待期间模板配置未变，再重新预检
  assertBefore(completeBody, 'if (!isDuplicateReviewConfigCurrent(review)) {', 'return prepareCompletion(review.bigAccountPayload', '大账号完成续跑前核对模板配置');

  // 取消复用大账号取消通道
  const cancelBody = source.slice(source.indexOf("ipcMain.handle('file:cancel-big-account-selection'"), source.indexOf('const completeBigAccountSelectionHandler = {'));
  assert.match(cancelBody, /statementDuplicateReview\.cancel\(contextId\)/);
});

// 指定模板导入（无大账号）的真实 fileImportHandler：预检暂停 → 确认续跑（不再选文件）→ 去重后组批；未确认拒绝。
function loadPlainImportHandler({ entries, calls, overrides = {} }) {
  const acorn = require('acorn');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const functionSource = (name) => {
    const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return source.slice(node.start, node.end);
  };
  const scope = new Map();
  const proxy = new Proxy({}, {
    has: (_target, key) => scope.has(key),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : scope.get(key)),
    set: (_target, key, value) => { scope.set(key, value); return true; }
  });
  const evaluate = (code) => Function('scope', `with (scope) { return (${code}); }`)(proxy);
  const { service } = createService();
  const templateConfig = {
    template: { id: 7, name: '查重模板', headers: ['日期'], channelId: null },
    exportMappings: [{ templateField: '重复账单过滤', mappedField: '是' }],
    exportTargetFields: [],
    bigAccounts: []
  };
  const cloneEntries = (list) => list.map((item) => {
    const detailRows = item.detailRows.map((row) => row.slice());
    detailRows.rowMetas = item.detailRows.rowMetas.map((meta) => ({ ...meta }));
    return { ...item, detailRows };
  });
  Object.entries({
    DUPLICATE_REVIEW_STATUS,
    DUPLICATE_ROW_FILTER_MAPPING_FIELD: '重复账单过滤',
    DUPLICATE_ROW_FILTER_ENABLED_OPTION: '是',
    STATEMENT_IMPORT_PREVIEW_READY: 'statement-import-preview-ready',
    MERCHANT_ID_SELF_INPUT_OPTION: '自己输入',
    FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI_BIG_ACCOUNT__',
    STATEMENT_SOURCE_FRESHNESS_FAILURE: Object.freeze({ code: 'STATEMENT_SOURCE_FRESHNESS_FAILURE', message: '源文件已变化' }),
    FileValidationError: require('../../../src/backend/file-service').FileValidationError,
    normalizeCell: (value) => String(value == null ? '' : value).trim(),
    statementDuplicateReview: service,
    hasDuplicateRowKeys: hasSourceRowKeys,
    fileImportInProgress: false,
    getEnumConfig: () => ({}),
    database: { getSetting: () => null, listEffectiveAccountMappings: () => [], listStatementChannelTemplates: () => [], getBillSplitMeta: () => ({}), getTemplate: () => null },
    getStatementChannelMigrationPendingMessage: () => '',
    isFilenameMappingMode: () => false,
    prepareStatementImportFiles: async () => {
      calls.picker += 1;
      return { proceed: true, args: [7], inputFilePaths: ['/sel/a.xlsx'], selectionResult: { filePaths: ['/sel/a.xlsx'], replacePaths: [] } };
    },
    bindStatementImportPreparedToFileEvidence: (prepared) => prepared,
    clearPendingManualBalancePrompt: () => {},
    clearPendingBigAccountSelection: () => {},
    clearGeneratedExports: () => {},
    getTemplateMappingConfig: (id) => {
      if (calls.configVersion === 'deleted') throw new Error('模板不存在');
      return { ...templateConfig, template: { ...templateConfig.template, id, updatedAt: calls.configVersion || 'v1' } };
    },
    createHash: require('node:crypto').createHash,
    DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE: '等待确认期间模板、渠道或账户映射已修改，请重新导入文件',
    IMPORT_CONFIG_CHANGED_MESSAGE: '导入期间模板、渠道或账户映射已修改，请重新导入文件',
    findGenerationGroupOutputNameConflicts: () => null,
    resolveGenerationGroupKey: () => 'template:7',
    statementImportSessionForInvocation: () => ({ key: 'session' }),
    expandBigAccountConfigurations: () => [],
    buildPendingBigAccountFileEntries: () => { calls.mapped += 1; return cloneEntries(entries); },
    rebuildMatchedTemplateFileEntries: ({ fileEntries }) => cloneEntries(fileEntries),
    resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
    buildStatementGenerationConfig: () => ({}),
    buildPreparedStatementBatchFromEntries: ({ fileEntries }) => {
      calls.batches.push(fileEntries.map((item) => item.detailRows.rowMetas.map((meta) => meta.sourceRowNumber)));
      return { detailRows: [] };
    },
    generateStatementFiles: () => ({ warnings: [] }),
    removeStatementSessionEntriesByFilePath: () => {},
    appendStatementSessionImport: () => 'batch-1',
    buildStatementBatchId: () => 'batch-1',
    buildStatementFileEntry: (item) => item,
    buildStatementFileEntryId: () => 'entry',
    lastGeneratedExports: {},
    rememberLastFileImportContext: () => {},
    updateStatementSessionCache: () => {},
    buildImportResultFromGeneratedFiles: () => ({ status: 'success' }),
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    createPreflightErrorResult: (payload) => ({ status: 'error', ...payload }),
    appendLog: (_root, error) => { throw error; },
    ensureStorageRoot: () => '/storage'
  }).forEach(([name, value]) => scope.set(name, value));
  Object.entries(overrides).forEach(([name, value]) => scope.set(name, value));
  ['statementImportPreviewReady', 'isDuplicateRowFilterEnabled', 'previewDuplicateRows', 'applyConfirmedDuplicateRowFilter',
    'scopeDuplicateEntries', 'unscopeDuplicateEntries', 'buildTemplateCatalogStamp', 'isImportConfigStampCurrent', 'checkImportConfigGuard',
    'resolveReusedSingleTemplateEntries', 'buildDuplicateReviewConfigStamp', 'isDuplicateReviewConfigCurrent',
    // v3.2.22：需要识别或分配大账号且全部文件只有表头时的拦截
    'isMultiBigAccountMapping', 'usesBigAccountMerchantMapping', 'isHeaderOnlyDetailRows', 'allEntriesHeaderOnly', 'createNoTransactionDataResult']
    .forEach((name) => scope.set(name, evaluate(functionSource(name))));
  let handlerNode = null;
  (function visit(node) {
    if (!node || typeof node !== 'object' || handlerNode) return;
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === 'fileImportHandler') {
      handlerNode = node.init;
      return;
    }
    Object.values(node).forEach((value) => (Array.isArray(value) ? value.forEach(visit) : visit(value)));
  })(ast);
  const handler = evaluate(source.slice(handlerNode.start, handlerNode.end));
  scope.set('fileImportHandler', handler);
  return { handler, service };
}

test('指定模板导入：预检发现重复先暂停；确认后续跑不再选文件，只把去重后的条目组批；未确认的执行被拒绝', async () => {
  const calls = { picker: 0, mapped: 0, batches: [] };
  const { handler, service } = loadPlainImportHandler({ entries: DUPLICATED, calls });

  const paused = await handler.prepare(null, 7);
  assert.equal(paused.proceed, false);
  assert.deepEqual([paused.result.status, paused.result.reviewKind, paused.result.droppedRowCount], ['duplicate-review', 'file-import', 1]);
  assert.deepEqual([calls.picker, calls.mapped, calls.batches], [1, 1, []], '预检只映射一次，未组批');

  // 未确认的执行（如绕过复核直接执行预检结果）被拒绝
  const context = service.requireContext(paused.result.contextId);
  const rejected = await handler.execute(null, { ...context.prepared, previewOnly: false }, { fileEvidence: { filePlan: { inputs: [] } } }, 7);
  assert.equal(rejected.errorCode, 'DUPLICATE_ROWS_REVIEW_STALE');
  assert.deepEqual(calls.batches, []);

  const second = await handler.prepare(null, 7);
  const continued = await handler.prepare(null, { duplicateReviewContextId: second.result.contextId });
  assert.equal(continued.proceed, true);
  assert.deepEqual(continued.args, [7]);
  assert.equal(calls.picker, 2, '续跑不再弹文件选择');
  assert.doesNotThrow(() => continued.beforeStart());
  const result = await handler.execute(null, continued, { fileEvidence: { filePlan: { inputs: [] } } }, 7);
  assert.equal(result.status, 'success');
  assert.deepEqual(calls.batches, [[[2, 4]]], '组批只含每组首行与不重复的行');
  assert.equal(service.requireContext(second.result.contextId), null, '执行后清除待确认上下文');
  assert.throws(() => continued.beforeStart(), /重复账单确认已失效/);

  const missing = await handler.prepare(null, { duplicateReviewContextId: 'gone' });
  assert.deepEqual([missing.proceed, missing.result.errorCode], [false, 'DUPLICATE_REVIEW_MISSING']);
});

test('指定模板导入：查重预映射失败时预检不拦截，执行阶段按原路径报错（含逐行明细）；受管大账号未选定时照常拒绝', async () => {
  const { FileValidationError } = require('../../../src/backend/file-service');
  const execution = { fileEvidence: { filePlan: { inputs: [] } } };

  const calls = { picker: 0, mapped: 0, batches: [] };
  const failure = new FileValidationError('FILE_READ', '账单日期无效：第 3 行', { detailLines: ['第 3 行：2026-11-31', '第 5 行：2026-02-30'] });
  const { handler } = loadPlainImportHandler({
    entries: DUPLICATED,
    calls,
    overrides: { buildPendingBigAccountFileEntries: () => { calls.mapped += 1; throw failure; } }
  });
  const prepared = await handler.prepare(null, 7);
  assert.equal(prepared.proceed, true, '预检不在映射失败处拦截');
  const result = await handler.execute(null, prepared, execution, 7);
  assert.deepEqual([result.status, result.message, result.detailLines], ['error', '账单日期无效：第 3 行', ['第 3 行：2026-11-31', '第 5 行：2026-02-30']]);
  assert.deepEqual([calls.mapped, calls.batches], [2, []]);

  // 多大账号模板未选定大账号：与未勾选查重时同一口径拒绝，不生成账户为空的明细
  const guardCalls = { picker: 0, mapped: 0, batches: [] };
  const { handler: guarded } = loadPlainImportHandler({
    entries: DUPLICATED,
    calls: guardCalls,
    overrides: {
      buildStatementGenerationConfig: (args) => {
        guardCalls.configs = (guardCalls.configs || 0) + 1;
        if (Object.prototype.hasOwnProperty.call(args, 'selectedBigAccount') && !args.selectedBigAccount && !args.allowManagedMerchantWithoutSelection) {
          throw new FileValidationError('FILE_READ', '当前模板存在多个大账号，请先选择本次使用的大账号');
        }
        return {};
      }
    }
  });
  const guardedPrepared = await guarded.prepare(null, 7);
  assert.equal(guardedPrepared.proceed, true, JSON.stringify(guardedPrepared.result || null));
  const rejected = await guarded.execute(null, guardedPrepared, execution, 7);
  assert.deepEqual([rejected.status, rejected.message], ['error', '当前模板存在多个大账号，请先选择本次使用的大账号']);
  assert.deepEqual([guardCalls.mapped, guardCalls.batches], [0, []]);
});

test('指定模板导入：等待确认期间模板配置变化（或模板被删）时拒绝续跑并清除待确认，提示重新导入', async () => {
  for (const changed of ['v2', 'deleted']) {
    const calls = { picker: 0, mapped: 0, batches: [] };
    const { handler, service } = loadPlainImportHandler({ entries: DUPLICATED, calls });
    const paused = await handler.prepare(null, 7);
    calls.configVersion = changed;
    const continued = await handler.prepare(null, { duplicateReviewContextId: paused.result.contextId });
    assert.deepEqual([continued.proceed, continued.result.errorCode, continued.result.message],
      [false, 'DUPLICATE_REVIEW_CONFIG_CHANGED', '等待确认期间模板、渠道或账户映射已修改，请重新导入文件'], changed);
    assert.equal(service.requireContext(paused.result.contextId), null, '已清除待确认');
    assert.deepEqual(calls.batches, []);
  }
  // 继续前（prepare 之后、开始执行前）才变化：beforeStart 拦下
  const calls = { picker: 0, mapped: 0, batches: [] };
  const { handler } = loadPlainImportHandler({ entries: DUPLICATED, calls });
  const paused = await handler.prepare(null, 7);
  const continued = await handler.prepare(null, { duplicateReviewContextId: paused.result.contextId });
  calls.configVersion = 'v3';
  assert.throws(() => continued.beforeStart(), /等待确认期间模板、渠道或账户映射已修改/);
  // beforeStart 之后、业务入口之前才变化：执行入口使用条目前再核对，按未开始返回（不组批、界面保留上一批状态）
  const lateCalls = { picker: 0, mapped: 0, batches: [] };
  const { handler: lateHandler } = loadPlainImportHandler({ entries: DUPLICATED, calls: lateCalls });
  const latePaused = await lateHandler.prepare(null, 7);
  const lateContinued = await lateHandler.prepare(null, { duplicateReviewContextId: latePaused.result.contextId });
  assert.doesNotThrow(() => lateContinued.beforeStart());
  lateCalls.configVersion = 'v4';
  const lateRejected = await lateHandler.execute(null, lateContinued, { fileEvidence: { filePlan: { inputs: [] } } }, 7);
  assert.deepEqual([lateRejected.status, lateRejected.errorCode, lateRejected.preservesSession, lateRejected.message],
    ['error', 'IMPORT_CONFIG_CHANGED', true, '等待确认期间模板、渠道或账户映射已修改，请重新导入文件']);
  assert.deepEqual(lateCalls.batches, []);

  // 预检放行（如勾选查重但没有重复）：预映射的条目随预检直接进入任务，业务入口使用前核对映射前记下的配置（期间改了金额映射或渠道时拒绝）
  const unique = [entry('/in/u.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, 'K2', '2026-11-02', 'ACC1', 'USD', '', '5']])];
  const plainCalls = { picker: 0, mapped: 0, batches: [] };
  const { handler: plainHandler } = loadPlainImportHandler({ entries: unique, calls: plainCalls });
  const ready = await plainHandler.prepare(null, 7);
  assert.equal(ready.proceed, true, JSON.stringify(ready.result || null));
  assert.equal(ready.importConfigGuard(), true);
  plainCalls.configVersion = 'v2';
  const rejected = await plainHandler.execute(null, ready, { fileEvidence: { filePlan: { inputs: [] } } }, 7);
  assert.deepEqual([rejected.status, rejected.errorCode, rejected.preservesSession, rejected.message],
    ['error', 'IMPORT_CONFIG_CHANGED', true, '导入期间模板、渠道或账户映射已修改，请重新导入文件']);
  assert.deepEqual(plainCalls.batches, [], '未组批');
});

test('活动日志：明细样例只构造前 200 行另记总数、账户号脱敏；完整的去除行号按文件压缩成区间，待确认与确认去除时都写', () => {
  const { service, logs } = createService();
  const rows = [];
  for (let index = 0; index < 150; index += 1) {
    rows.push([2 + index * 2, `K${index}`, '2026-11-01', 'ACC1', 'USD', '1', '']);
    rows.push([3 + index * 2, `K${index}`, '2026-11-01', 'ACC1', 'USD', '1', '']);
  }
  // 第 400-402 行与第 2 行相同：连续行号压成区间
  [400, 401, 402].forEach((rowNumber) => rows.push([rowNumber, 'K0', '2026-11-01', 'ACC1', 'USD', '1', '']));
  const entries = [entry('/in/big.xlsx', rows), entry('/in/copy.xlsx', [[9, 'K0', '2026-11-01', 'ACC1', 'USD', '1', '']])];
  const { scan } = service.review({ entries, phase: 'preview' });
  service.remember({ kind: 'file-import', templateId: 7, scan, templateName: '模板A' });
  const dropLines = [
    `去除行号 · 第 1 个文件：第 ${Array.from({ length: 150 }, (_value, index) => 3 + index * 2).join('、')}、400-402 行（153 行）`,
    '去除行号 · 第 2 个文件：第 9 行（1 行）'
  ];
  const pendingLog = logs.at(-1);
  assert.deepEqual(pendingLog.details.slice(2, 4), dropLines);
  assert.equal(pendingLog.details.length, 2 + 2 + 200 + 1);
  assert.match(pendingLog.details.at(-1), /明细共 304 行，其余未列出/);
  assert.ok(pendingLog.details.every((line) => !line.includes('ACC1')), '日志不含完整账户号');
  service.review({ entries, phase: 'execute', prepared: { duplicateReviewConfirmation: { digest: scan.digest } } });
  const confirmedLog = logs.at(-1);
  assert.equal(confirmedLog.message, '已确认过滤重复账单');
  assert.deepEqual(confirmedLog.details.slice(2, 4), dropLines);
  assert.equal(confirmedLog.details.length, 2 + 2 + 200 + 1, '确认去除时样例同样封顶');
});

// 按文件名映射的真实执行计划（executeFilenameMappingImportPlan）：确认后只把去重后的条目交给生成；
//   未确认拒绝；未勾选时沿用原条目、不预先重建（多模板按组重建）。
function loadFilenameMappingPlanExecutor(calls) {
  const acorn = require('acorn');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const functionSource = (name) => {
    const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return source.slice(node.start, node.end);
  };
  const scope = new Map();
  const proxy = new Proxy({}, {
    has: (_target, key) => scope.has(key),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : scope.get(key)),
    set: (_target, key, value) => { scope.set(key, value); return true; }
  });
  const evaluate = (code) => Function('scope', `with (scope) { return (${code}); }`)(proxy);
  const { service } = createService();
  const rowNumbersOf = (entries) => entries.map((item) => item.detailRows.rowMetas.map((meta) => meta.sourceRowNumber));
  const templateConfig = { template: { id: 0, name: '按文件名映射模板' }, exportMappings: [], exportTargetFields: [] };
  Object.entries({
    FILENAME_MAPPING_TEMPLATE_ID: -1,
    FIXED_FIELD_VALUE_PREFIX: '__FIXED__:',
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI_BIG_ACCOUNT__',
    normalizeCell: (value) => String(value == null ? '' : value).trim(),
    statementDuplicateReview: service,
    hasDuplicateRowKeys: hasSourceRowKeys,
    statementImportSessions: new Map(),
    lastGeneratedExports: {},
    getOrCreateStatementImportSession: () => ({ key: 'session' }),
    rebuildMatchedTemplateFileEntries: ({ fileEntries }) => {
      calls.rebuilds += 1;
      return fileEntries.map((item) => ({ ...item, detailRows: Object.assign(item.detailRows.slice(), { rowMetas: item.detailRows.rowMetas.slice() }) }));
    },
    generateMultiTemplateGroupFiles: ({ fileEntries, entriesResolved }) => {
      calls.generated.push({ kind: 'multi', rows: rowNumbersOf(fileEntries), entriesResolved });
      return { lastResult: { status: 'success' }, lastBatchId: 'batch', lastGenerationTemplateConfig: templateConfig };
    },
    resolveGenerationTemplateConfig: ({ fallbackTemplateConfig }) => fallbackTemplateConfig,
    buildStatementGenerationConfig: () => ({}),
    buildPreparedStatementBatchFromEntries: ({ fileEntries }) => {
      calls.generated.push({ kind: 'single', rows: rowNumbersOf(fileEntries) });
      return { detailRows: [] };
    },
    generateStatementFiles: () => ({ warnings: [] }),
    removeStatementSessionEntriesByFilePath: () => {},
    appendStatementSessionImport: () => 'batch',
    buildStatementBatchId: () => 'batch',
    buildStatementFileEntry: (item) => item,
    buildStatementFileEntryId: () => 'entry',
    rememberLastFileImportContext: () => {},
    updateStatementSessionCache: () => {},
    buildImportResultFromGeneratedFiles: () => ({ status: 'success' }),
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    // 查重范围按生成组：本测试的模板 1、2 同属一个渠道（同一生成组），跨文件重复照常去除
    database: { getTemplate: (id) => ({ id }) },
    resolveGenerationGroupKey: () => 'channel:9'
  }).forEach(([name, value]) => scope.set(name, value));
  ['applyConfirmedDuplicateRowFilter', 'scopeDuplicateEntries', 'unscopeDuplicateEntries',
    'resolveFilenameMappingFinalEntries', 'executeFilenameMappingImportPlan']
    .forEach((name) => scope.set(name, evaluate(functionSource(name))));
  return { execute: scope.get('executeFilenameMappingImportPlan'), service, templateConfig };
}

test('按文件名映射执行计划：确认后单 / 多模板都只用去重后的条目生成；未确认拒绝；未勾选沿用原条目不预先重建', () => {
  const crossFile = [
    { ...entry('/in/a.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', ''], [3, 'K2', '2026-11-01', 'ACC1', 'USD', '', '5']]), matchedTemplateId: 1 },
    { ...entry('/in/b.xlsx', [[2, 'K1', '2026-11-01', 'ACC1', 'USD', '100', '']]), matchedTemplateId: 2 }
  ];
  const plain = crossFile.map((item) => ({
    ...item,
    detailRows: Object.assign(item.detailRows.slice(), { rowMetas: item.detailRows.rowMetas.map((meta) => ({ sourceRowNumber: meta.sourceRowNumber })) })
  }));
  for (const perTemplateConfigCount of [2, 1]) {
    const calls = { rebuilds: 0, generated: [] };
    const { execute, service, templateConfig } = loadFilenameMappingPlanExecutor(calls);
    const plan = {
      perTemplateConfigCount,
      trimmedProvisionalEntries: crossFile,
      syntheticTemplateConfig: templateConfig,
      selectedBigAccount: null,
      selectionResult: { filePaths: ['/in/a.xlsx', '/in/b.xlsx'], replacePaths: [] }
    };
    const { scan } = service.review({ entries: crossFile, phase: 'preview' });
    assert.equal(execute(plan, {}).errorCode, DUPLICATE_ROWS_REVIEW_STALE, '未确认拒绝');
    assert.deepEqual(calls.generated, []);
    assert.equal(execute(plan, { duplicateReviewConfirmation: { contextId: 'c', digest: scan.digest } }).status, 'success');
    const expected = perTemplateConfigCount > 1
      ? [{ kind: 'multi', rows: [[2, 3], []], entriesResolved: true }]
      : [{ kind: 'single', rows: [[2, 3], []] }];
    assert.deepEqual(calls.generated, expected, `去重后生成（${perTemplateConfigCount} 个模板）`);

    calls.generated = [];
    calls.rebuilds = 0;
    assert.equal(execute({ ...plan, trimmedProvisionalEntries: plain }, {}).status, 'success');
    assert.deepEqual(calls.generated, perTemplateConfigCount > 1
      ? [{ kind: 'multi', rows: [[2, 3], [2]], entriesResolved: false }]
      : [{ kind: 'single', rows: [[2, 3], [2]] }]);
    assert.equal(calls.rebuilds, perTemplateConfigCount > 1 ? 0 : 1, '未勾选时多模板不预先重建（单模板同原流程重建一次）');
  }
});

test('活动日志：不写文件名（可能含账户号），以文件序号定位；弹窗中的文件名、账户号保持原样', () => {
  const { service, logs } = createService();
  const entries = [entry('/in/账单-ACC 1234 5678.xlsx', [
    [2, 'K1', '2026-11-01', '6222000012345678', 'USD', '100', ''],
    [3, 'K1', '2026-11-01', '6222000012345678', 'USD', '100', '']
  ])];
  const { scan } = service.review({ entries, phase: 'preview' });
  service.remember({ kind: 'file-import', templateId: 7, scan, templateName: '模板A' });
  assert.deepEqual(logs.at(-1).details.slice(2), [
    '去除行号 · 第 1 个文件：第 3 行（1 行）',
    '重复组 #1：第 1 个文件 第 2 行，账户号：****5678（USD），账期：2026-11-01，保留',
    '重复组 #1：第 1 个文件 第 3 行，账户号：****5678（USD），账期：2026-11-01，去除'
  ]);
  assert.ok(logs.every((item) => !JSON.stringify(item).includes('1234 5678')), '日志不含文件名里的账号');
  const result = service.buildReviewResult(scan, { contextId: 'c', reviewKind: 'file-import' });
  assert.deepEqual([result.groups[0].accountLabel, result.groups[0].rows[0].fileName], ['6222000012345678（USD）', '账单-ACC 1234 5678.xlsx']);
});

test('活动日志：币种只写 3 位字母的币种代码，其他值（可能是误映射的账号、姓名）记为「未识别币种」；弹窗显示原值', () => {
  const { service, logs } = createService();
  const entries = [entry('/in/a.xlsx', [
    [2, 'K1', '2026-11-01', 'ACC1', '6222000012345678', '100', ''],
    [3, 'K1', '2026-11-01', 'ACC1', '6222000012345678', '100', ''],
    [4, 'K2', '2026-11-01', 'ACC1', 'usd', '', '5'],
    [5, 'K2', '2026-11-01', 'ACC1', 'usd', '', '5']
  ])];
  const { scan } = service.review({ entries, phase: 'preview' });
  service.remember({ kind: 'file-import', templateId: 7, scan, templateName: '模板A' });
  const details = logs.at(-1).details;
  assert.ok(details.every((line) => !line.includes('6222000012345678')), '日志不含误映射到币种列的账号');
  assert.ok(details.some((line) => line.includes('账户号：****（未识别币种）')));
  assert.ok(details.some((line) => line.includes('账户号：****（USD）')));
  const result = service.buildReviewResult(scan, { contextId: 'c', reviewKind: 'file-import' });
  assert.equal(result.groups[0].accountLabel, 'ACC1（6222000012345678）');
});

test('执行：复核失效的返回值带 DUPLICATE_ROWS_REVIEW_STALE（生产的 createErrorResult 不回填 errorCode）', () => {
  const service = createStatementDuplicateReview({
    randomUUID: () => 'ctx',
    createErrorResult: ({ message }) => ({ status: 'error', message, errorReportReady: true }),
    scanDuplicateSourceRows,
    dropDuplicateSourceRows
  });
  const outcome = service.review({ entries: DUPLICATED, phase: 'execute', prepared: {} });
  assert.deepEqual([outcome.result.status, outcome.result.errorCode, outcome.result.errorReportReady], ['error', DUPLICATE_ROWS_REVIEW_STALE, true]);
});

test('续跑预检被拒绝（如枚举文件不可用）即未开始：标记 preservesSession；完成大账号选择时选择无效仍保留窗口重选', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const start = source.indexOf('function markContinuationPrepareRejection(');
  const end = source.indexOf('\n}\n', start) + 2;
  const markContinuationPrepareRejection = Function(`return (${source.slice(start, end)});`)();
  const rejected = (errorCode) => ({ proceed: false, result: { status: 'error', message: 'x', errorCode } });
  assert.equal(markContinuationPrepareRejection(rejected('ENUM_MISSING')).result.preservesSession, true);
  assert.equal(markContinuationPrepareRejection(rejected('BIG_ACCOUNT_SELECTION_INVALID'), { keepErrorCodes: ['BIG_ACCOUNT_SELECTION_INVALID'] })
    .result.preservesSession, undefined);
  const proceeding = { proceed: true, args: [] };
  assert.equal(markContinuationPrepareRejection(proceeding), proceeding, '放行的预检原样返回');
  // 两个续跑通道在注册前都包上该标记
  assertBefore(source, 'fileImportHandler.prepare = async (event, templateId) => {', "'file:import',\n    '生成网银账单'", '导入通道注册前包装');
  assert.match(source, /isContinuation \? markContinuationPrepareRejection\(outcome\) : outcome/);
  assertBefore(source, 'completeBigAccountSelectionHandler.prepare = async (event, requestPayload) => markContinuationPrepareRejection(',
    "'file:complete-big-account-selection',\n    '生成账单'", '完成大账号选择通道注册前包装');
});

test('按文件名映射：模板目录快照在新增、删除模板或改表头、映射时变化（命中结果可能不同）；配置与快照都一致才算未变化', () => {
  const acorn = require('acorn');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const functionSource = (name) => {
    const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    return source.slice(node.start, node.end);
  };
  const templates = [{ id: 1, name: 'A', headers: ['日期', '金额'] }];
  const mappings = new Map([[1, { mappings: [{ templateField: 'Credit Amount', mappedField: '金额' }] }]]);
  const stampFor = { value: 's1' };
  const deps = {
    createHash: require('node:crypto').createHash,
    database: { listTemplates: () => templates.map((item) => ({ ...item })), getTemplateMappings: (id) => mappings.get(id) || null },
    buildDuplicateReviewConfigStamp: () => stampFor.value
  };
  const scope = { ...deps };
  const compile = (name) => Function(...Object.keys(scope), `return (${functionSource(name)});`)(...Object.values(scope));
  scope.buildTemplateCatalogStamp = compile('buildTemplateCatalogStamp');
  const isImportConfigStampCurrent = compile('isImportConfigStampCurrent');
  const config = { templateIds: [1], stamp: 's1', catalogStamp: scope.buildTemplateCatalogStamp() };
  assert.equal(isImportConfigStampCurrent(config), true);
  templates.push({ id: 2, name: 'B', headers: ['日期', '金额', '流水号'] });
  assert.equal(isImportConfigStampCurrent(config), false, '新增的模板可能更精确地命中同一文件');
  templates.pop();
  mappings.set(1, { mappings: [{ templateField: 'Credit Amount', mappedField: '日期' }] });
  assert.equal(isImportConfigStampCurrent(config), false, '映射变化');
  mappings.set(1, { mappings: [{ templateField: 'Credit Amount', mappedField: '金额' }] });
  assert.equal(isImportConfigStampCurrent(config), true);
  stampFor.value = 's2';
  assert.equal(isImportConfigStampCurrent(config), false, '命中模板的生成配置变化');
  assert.equal(isImportConfigStampCurrent({ templateIds: [1], stamp: 's2', catalogStamp: null }), true, '指定模板导入不记目录快照');
});

test('同一重复账单确认的两个请求都通过 beforeStart：业务入口按 ID 消费确认，只有第一个生成，第二个按未开始返回', async () => {
  const calls = { picker: 0, mapped: 0, batches: [] };
  const { handler } = loadPlainImportHandler({ entries: DUPLICATED, calls });
  const paused = await handler.prepare(null, 7);
  const first = await handler.prepare(null, { duplicateReviewContextId: paused.result.contextId });
  const second = await handler.prepare(null, { duplicateReviewContextId: paused.result.contextId });
  assert.deepEqual([first.proceed, second.proceed], [true, true]);
  assert.doesNotThrow(() => first.beforeStart());
  assert.doesNotThrow(() => second.beforeStart());
  const taskContext = { fileEvidence: { filePlan: { inputs: [] } } };
  const firstResult = await handler.execute(null, first, taskContext, 7);
  assert.equal(firstResult.status, 'success', JSON.stringify(firstResult));
  const secondResult = await handler.execute(null, second, taskContext, 7);
  assert.deepEqual([secondResult.status, secondResult.errorCode, secondResult.preservesSession], ['error', 'DUPLICATE_REVIEW_MISSING', true]);
  assert.equal(calls.batches.length, 1, '只组批一次');
});

