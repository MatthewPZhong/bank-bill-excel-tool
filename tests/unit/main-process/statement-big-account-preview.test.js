'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');

const ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_PATH = path.join(ROOT, 'src', 'main.js');
const RENDERER_DIALOGS_PATH = path.join(ROOT, 'src', 'renderer-dialogs.js');
const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
const mainAst = acorn.parse(mainSource, {
  ecmaVersion: 'latest',
  sourceType: 'script'
});

function functionSource(name) {
  const node = mainAst.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === name
  ));
  if (!node) throw new Error(`未找到函数：${name}`);
  return mainSource.slice(node.start, node.end);
}

function loadFunction(name, names = [], values = []) {
  return Function(...names, `return (${functionSource(name)});`)(...values);
}

test('fixed 提取按服务端 rowsWithEmptyBlocks 选择，保留空 block 行', () => {
  const selectRows = loadFunction('selectPendingBigAccountRows');
  const context = {
    rows: [{ index: 0, fileName: 'A.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 0, fileName: 'A.xlsx' },
      { index: 1, fileName: 'A.xlsx', empty: true }
    ]
  };
  assert.deepEqual(
    selectRows(context, 'fixed', [0, 1]),
    context.rowsWithEmptyBlocks
  );
  assert.deepEqual(selectRows(context, 'unfixed', [0, 1]), context.rows);
});

test('完成选择接受完整乱序 assignments，并拒绝重复 rowIndex', () => {
  class FileValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const normalize = loadFunction(
    'normalizePendingBigAccountSelection',
    ['normalizeCell', 'FileValidationError'],
    [(value) => String(value == null ? '' : value).trim(), FileValidationError]
  );
  const context = {
    rows: [{ index: 0 }, { index: 1 }],
    bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false }]
  };
  assert.deepEqual(normalize(context, {
    assignments: [
      { rowIndex: 1, merchantId: 'M001', currency: 'USD' },
      { rowIndex: 0, merchantId: 'M001', currency: 'USD' }
    ]
  }).normalizedAssignments.map((item) => item.rowIndex), [0, 1]);
  assert.throws(
    () => normalize(context, {
      assignments: [
        { rowIndex: 0, merchantId: 'M001', currency: 'USD' },
        { rowIndex: 0, merchantId: 'M001', currency: 'USD' }
      ]
    }),
    (error) => error.code === 'BIG_ACCOUNT_SELECTION_INVALID'
  );
});

test('大账号 preview DTO 只暴露 contextId 与展示行，不暴露主进程 filePath', () => {
  const normalizeCell = (value) => String(value == null ? '' : value).trim();
  const buildPreview = loadFunction(
    'buildBigAccountPreviewResult',
    ['normalizeCell'],
    [normalizeCell]
  );
  const result = buildPreview({
    status: 'select-big-account',
    rows: [{ index: 3, fileName: 'A.xlsx', filePath: '/private/source.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 3, fileName: 'A.xlsx', filePath: '/private/source.xlsx' },
      { index: 4, fileName: 'A.xlsx', filePath: '/private/source.xlsx' }
    ]
  }, 'opaque-context');
  assert.equal(result.contextId, 'opaque-context');
  assert.equal(Object.hasOwn(result.rows[0], 'filePath'), false);
  assert.equal(Object.hasOwn(result.rowsWithEmptyBlocks[1], 'filePath'), false);
});

test('非 bill-split 缓存行注入大账号且移除 selectedCurrency 已短路的伪告警', () => {
  const config = {
    template: { id: 1, headers: ['原字段'] },
    exportMappings: [{
      templateField: 'MerchantId',
      mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    }],
    exportTargetFields: ['MerchantId', 'Currency']
  };
  const rebuild = loadFunction(
    'rebuildMatchedTemplateFileEntries',
    [
      'getEntryTemplateConfig',
      'normalizeCell',
      'FIXED_FIELD_VALUE_PREFIX',
      'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
      'cloneRowsWithMetadata',
      'buildFieldIndexMap',
      'buildManagedMerchantLookupFlags',
      'buildStatementGenerationConfig',
      'buildMappedRowsForFile'
    ],
    [
      () => config,
      (value) => String(value == null ? '' : value).trim(),
      '__FIXED__:',
      '__MULTI_BIG_ACCOUNT__',
      (rows) => {
        const cloned = rows.map((row) => row.slice());
        if (Array.isArray(rows.issues)) {
          cloned.issues = rows.issues.map((issue) => ({ ...issue }));
        }
        return cloned;
      },
      (header) => new Map(header.map((field, index) => [field, index])),
      () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
      () => ({ billSplitMerge: { enabled: false } }),
      () => { throw new Error('reuseMappedRows 不得重新解析文件'); }
    ]
  );
  const sourceRows = [
    ['MerchantId', 'Currency', 'Amount'],
    ['', '', 10],
    ['', '', 20]
  ];
  sourceRows.issues = [
    { type: 'currency-unmapped', rawValue: '美元' },
    { type: 'date-invalid', rawValue: 'bad-date' }
  ];
  const [entry] = rebuild({
    fileEntries: [{ filePath: '/private/A.xlsx', detailRows: sourceRows }],
    fallbackTemplateConfig: config,
    selectedBigAccount: { merchantId: 'M001', currency: 'USD' },
    reuseMappedRows: true
  });
  assert.deepEqual(entry.detailRows.map((row) => row), [
    ['MerchantId', 'Currency', 'Amount'],
    ['M001', 'USD', 10],
    ['M001', 'USD', 20]
  ]);
  assert.deepEqual(sourceRows[1], ['', '', 10], '不得修改 prepare 缓存原对象');
  assert.deepEqual(entry.detailRows.issues, [
    { type: 'date-invalid', rawValue: 'bad-date' }
  ]);
  assert.equal(sourceRows.issues.length, 2, '不得修改 prepare 缓存告警');
});

test('多大账号 + bill-split 缓存路径回退 raw rebuild，保留原币种拆分算法', () => {
  const config = {
    template: { id: 1, headers: ['原字段'] },
    exportMappings: [{
      templateField: 'MerchantId',
      mappedField: '__FIXED__:__MULTI_BIG_ACCOUNT__'
    }],
    exportTargetFields: ['MerchantId', 'Currency']
  };
  const rawRows = [['MerchantId', 'Currency'], ['M001', 'EUR']];
  let rawRebuildCount = 0;
  const rebuild = loadFunction(
    'rebuildMatchedTemplateFileEntries',
    [
      'getEntryTemplateConfig',
      'normalizeCell',
      'FIXED_FIELD_VALUE_PREFIX',
      'MERCHANT_ID_MULTI_ACCOUNT_MARKER',
      'cloneRowsWithMetadata',
      'buildFieldIndexMap',
      'buildManagedMerchantLookupFlags',
      'buildStatementGenerationConfig',
      'buildMappedRowsForFile'
    ],
    [
      () => config,
      (value) => String(value == null ? '' : value).trim(),
      '__FIXED__:',
      '__MULTI_BIG_ACCOUNT__',
      () => { throw new Error('bill-split 不得复用 preview 映射行'); },
      () => { throw new Error('bill-split 不得走缓存字段覆盖'); },
      () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
      ({ selectedBigAccount }) => {
        assert.deepEqual(selectedBigAccount, { merchantId: 'M001', currency: 'USD' });
        return { billSplitMerge: { enabled: true } };
      },
      ({ config: generationConfig, inputFilePath }) => {
        rawRebuildCount += 1;
        assert.equal(generationConfig.billSplitMerge.enabled, true);
        assert.equal(inputFilePath, '/private/A.xlsx');
        return rawRows;
      }
    ]
  );
  const [entry] = rebuild({
    fileEntries: [{
      filePath: '/private/A.xlsx',
      detailRows: [['MerchantId', 'Currency'], ['', 'preview-currency']]
    }],
    fallbackTemplateConfig: config,
    selectedBigAccount: { merchantId: 'M001', currency: 'USD' },
    reuseMappedRows: true
  });
  assert.equal(rawRebuildCount, 1);
  assert.equal(entry.detailRows, rawRows);
});

test('普通模板 direct recognition 的 preview 决策在 execute 复用，只探测一次', () => {
  let recognitionCount = 0;
  const resolvePrepared = loadFunction(
    'resolvePreparedDirectBigAccountRecognition',
    ['resolveDirectBigAccountRecognition'],
    [() => {
      recognitionCount += 1;
      return {
        status: 'ok',
        selectedBigAccount: { merchantId: 'M001', currency: 'USD' }
      };
    }]
  );
  const prepared = { previewOnly: true };
  const previewDecision = resolvePrepared({ prepared, recognitionArgs: { fileEntries: [{}] } });
  prepared.previewOnly = false;
  const executeDecision = resolvePrepared({ prepared, recognitionArgs: { fileEntries: [{}] } });
  assert.equal(recognitionCount, 1);
  assert.equal(executeDecision, previewDecision);

  const importHandlerSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.match(importHandlerSource, /resolvePreparedDirectBigAccountRecognition\s*\(\{/);
});

test('fixed 顺序自定义输入的 preview auto-match 决策在 execute 复用，只整表读取一次', () => {
  let fullReadCount = 0;
  const resolvePrepared = loadFunction('resolvePreparedFixedBigAccountAutoMatchDecision');
  const prepared = { previewOnly: true };
  const resolveDecision = () => {
    fullReadCount += 1;
    return {
      failedFileNames: [],
      reorderedAssignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }]
    };
  };
  const previewDecision = resolvePrepared(prepared, resolveDecision);
  prepared.previewOnly = false;
  const executeDecision = resolvePrepared(prepared, resolveDecision);
  assert.equal(fullReadCount, 1);
  assert.equal(executeDecision, previewDecision);

  const importHandlerSource = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.match(
    importHandlerSource,
    /resolvePreparedFixedBigAccountAutoMatchDecision\s*\([\s\S]*?const rawRowsFull = readRows\(/
  );
});

test('statement 全量 preview 探测期间源文件变更会在返回前被拒绝', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-preview-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'statement.xlsx');
  fs.writeFileSync(inputPath, 'before', 'utf8');
  const guard = loadFunction(
    'createPreviewSourceFreshnessGuard',
    ['path', 'sourceSnapshotFromStat', 'fs', 'sourceSnapshotMatchesStat'],
    [path, sourceSnapshotFromStat, fs, sourceSnapshotMatchesStat]
  )([inputPath], '网银明细');
  fs.writeFileSync(inputPath, 'after-preview-is-longer', 'utf8');
  assert.throws(guard, /源文件在确认期间已变化/);

  const prepareSource = mainSource.slice(
    mainSource.indexOf('const previewResult = await fileImportHandler.execute'),
    mainSource.indexOf('async execute(_event, prepared, _taskContext, templateId)')
  );
  assert.match(
    prepareSource,
    /const previewResult = await fileImportHandler\.execute[\s\S]*?previewPrepared\.assertFresh\(\);[\s\S]*?if \(previewResult/
  );

  const duplicateResolver = mainSource.slice(
    mainSource.indexOf('async function resolveImportFileSelection'),
    mainSource.indexOf('function buildScopeSelectionResult')
  );
  const confirmationIndex = duplicateResolver.indexOf('await dialog.showMessageBox');
  const freshnessIndex = duplicateResolver.indexOf('assertFreshAfterConfirmation();');
  const responseIndex = duplicateResolver.indexOf('if (result.response === 1)');
  assert.ok(
    confirmationIndex >= 0
      && confirmationIndex < freshnessIndex
      && freshnessIndex < responseIndex,
    'duplicate confirmation 返回后必须先重校原选择，再处理 response/replacePaths'
  );
  const statementPrepare = mainSource.slice(
    mainSource.indexOf('async function prepareStatementImportFiles'),
    mainSource.indexOf('function registerFileHandlers')
  );
  const selectionIndex = statementPrepare.indexOf('const selectionResult = await');
  const selectionFreshIndex = statementPrepare.indexOf('assertSelectionFresh();', selectionIndex);
  const selectionStatusIndex = statementPrepare.indexOf('if (selectionResult.status', selectionIndex);
  const sourceGuardMatch = /createPreviewSourceFreshnessGuard\(\s*selectionResult\.filePaths/
    .exec(statementPrepare.slice(selectionIndex));
  const sourceGuardIndex = sourceGuardMatch
    ? selectionIndex + sourceGuardMatch.index
    : -1;
  assert.ok(
    selectionIndex >= 0
      && selectionIndex < selectionFreshIndex
      && selectionFreshIndex < selectionStatusIndex
      && selectionStatusIndex < sourceGuardIndex,
    'selection resolver 返回后须先复核 picker paths，再处理结果并为最终 accepted paths 建 guard'
  );
});

test('acquiring peek 探测期间源文件变更会在建立覆盖上下文前被拒绝', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-preview-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'acquiring.xlsx');
  fs.writeFileSync(inputPath, 'before', 'utf8');
  const guard = loadFunction(
    'createPreviewSourceFreshnessGuard',
    ['path', 'sourceSnapshotFromStat', 'fs', 'sourceSnapshotMatchesStat'],
    [path, sourceSnapshotFromStat, fs, sourceSnapshotMatchesStat]
  )([inputPath], '收单导入');
  fs.writeFileSync(inputPath, 'after-peek-is-longer', 'utf8');
  assert.throws(guard, /源文件在确认期间已变化/);

  const acquiringPrepareSource = mainSource.slice(
    mainSource.indexOf('async function prepareAcquiringImport'),
    mainSource.indexOf('async function executeAcquiringImport')
  );
  assert.match(
    acquiringPrepareSource,
    /peeked = await acquiringRunData\.peekImportTarget\([\s\S]*?assertSourceFresh\(\);[\s\S]*?if \(peeked\.monthKey/
  );
});

test('顺序持久化失败只追加生成后告警，不覆盖已形成的业务结果', () => {
  let writeCount = 0;
  const activityLogs = [];
  const persist = loadFunction(
    'persistBigAccountOrderAfterGeneration',
    [
      'buildBigAccountOrderData',
      'writeBigAccountOrder',
      'ensureStorageRoot',
      'appendActivityLogEntry'
    ],
    [
      (_pendingContext, assignments) => ({ assignments, fileCount: 1, files: [] }),
      () => {
        writeCount += 1;
        throw new Error('disk full');
      },
      () => '/tmp/storage',
      (entry) => activityLogs.push(entry)
    ]
  );
  const generatedResult = {
    status: 'success',
    message: '文件生成成功',
    detailReady: true,
    balanceReady: true,
    filePath: '/tmp/generated.xlsx'
  };
  const result = persist({
    pendingContext: { templateId: 7 },
    normalizedAssignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'USD' }],
    rememberOrder: true,
    result: generatedResult
  });
  assert.equal(writeCount, 1);
  assert.equal(result.status, 'warning');
  assert.equal(result.detailReady, true);
  assert.equal(result.balanceReady, true);
  assert.equal(result.filePath, '/tmp/generated.xlsx');
  assert.match(result.message, /账单已生成.*本次选择未记住/);
  assert.equal(activityLogs.length, 1);
});

test('选择结果构造不清 lastErrorReport，renderer 只回传 contextId + rowIndexes/assignments', () => {
  assert.doesNotMatch(
    functionSource('buildBigAccountSelectionRequiredResult'),
    /clearLastErrorReport\s*\(/
  );
  const rendererSource = fs.readFileSync(RENDERER_DIALOGS_PATH, 'utf8');
  const extractCall = rendererSource.match(
    /extractBigAccountOrder\s*\(\{([\s\S]*?)\}\)\s*;/
  );
  assert.ok(extractCall, '应存在 extractBigAccountOrder 调用');
  assert.match(extractCall[1], /contextId\s*:/);
  assert.match(extractCall[1], /rowIndexes\s*:/);
  assert.doesNotMatch(extractCall[1], /fileRows\s*:|filePath\s*:/);
  const extractHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'"),
    mainSource.indexOf("businessIpcHandle('file:save-balance-seed'")
  );
  assert.match(extractHandler, /selectPendingBigAccountRows\s*\(/);
  assert.match(extractHandler, /requestedRowIndexes\.has\(serverRowIndex\)/);
  assert.doesNotMatch(extractHandler, /payload(?:\?|)\.fileRows/);
  const activeDialogTail = rendererSource.slice(
    rendererSource.indexOf('let finalAssignments;'),
    rendererSource.indexOf('initializeState();', rendererSource.indexOf('let finalAssignments;'))
  );
  const activeCompleteCall = activeDialogTail.match(
    /completeBigAccountSelection\s*\(\{([\s\S]*?assignments:\s*finalAssignments[\s\S]*?)\}\)\s*;/
  );
  assert.ok(activeCompleteCall, '当前 object 分支应提交 complete payload');
  assert.equal(
    [...activeDialogTail.matchAll(/completeBigAccountSelection\s*\(/g)].length,
    1,
    '当前 object 分支只调用一次 complete'
  );
  assert.match(activeCompleteCall[1], /contextId:\s*payload\.contextId/);
  assert.match(activeCompleteCall[1], /rememberOrder:\s*rememberCheckbox\.checked/);
  assert.doesNotMatch(activeCompleteCall[1], /fileRows\s*:|filePath\s*:/);

  assert.doesNotMatch(activeDialogTail, /bigAccount\.saveOrder/);

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("ipcMain.handle('file:extract-big-account-order'")
  );
  assert.match(completeHandler, /requirePendingBigAccountSelection\(contextId\)/);
  assert.match(
    completeHandler,
    /clearPendingBigAccountSelection\(prepared\.contextId\);[\s\S]*?const \{ isFixedMode/
  );
  assert.match(
    completeHandler,
    /const result = buildImportResultFromGeneratedFiles\([\s\S]*?persistBigAccountOrderAfterGeneration\(\{[\s\S]*?result/
  );
});

test('Statement 五条 eager action 只以冻结 FilePlan 作为业务文件路径权威', () => {
  const importPrepare = functionSource('prepareStatementImportFiles');
  const bindPrepared = functionSource('bindStatementImportPreparedToFileEvidence');
  assert.match(importPrepare, /filePlan:\s*\{[\s\S]*?allocation:\s*'eager'[\s\S]*?sourceOperation:\s*'file:import'/);
  assert.doesNotMatch(importPrepare, /inputPaths\s*:/);
  assert.match(bindPrepared, /filePlan\.inputs\.map\(\(item\) => item\.filePath\)/);

  const importHandler = mainSource.slice(
    mainSource.indexOf('const fileImportHandler ='),
    mainSource.indexOf("trackedIpcHandle(\n    'file:import'")
  );
  assert.match(
    importHandler,
    /bindStatementImportPreparedToFileEvidence\(\s*prepared,\s*taskContext\.fileEvidence\.filePlan\s*\)/
  );

  const completeHandler = mainSource.slice(
    mainSource.indexOf('const completeBigAccountSelectionHandler ='),
    mainSource.indexOf("businessIpcHandle(\n    'file:complete-big-account-selection'")
  );
  assert.match(completeHandler, /sourceOperation:\s*'file:complete-big-account-selection'/);
  assert.match(completeHandler, /taskContext\.fileEvidence\.filePlan\.inputs/);

  const manualBalanceHandler = mainSource.slice(
    mainSource.indexOf("businessIpcHandle('file:save-balance-seed'"),
    mainSource.indexOf('function resolveStatementExportSession', mainSource.indexOf("businessIpcHandle('file:save-balance-seed'"))
  );
  assert.match(manualBalanceHandler, /sourceOperation:\s*'file:save-balance-seed'/);
  assert.match(manualBalanceHandler, /taskContext\.fileEvidence\.filePlan\.inputs\.map/);

  const exportPrepareStart = mainSource.indexOf('const prepareStatementExport =');
  const exportPrepare = mainSource.slice(
    exportPrepareStart,
    mainSource.indexOf("trackedIpcHandle('file:export-detail'", exportPrepareStart)
  );
  assert.match(exportPrepare, /sourceOperation:\s*kind === 'detail' \? 'file:export-detail' : 'file:export-balance'/);
  assert.doesNotMatch(exportPrepare, /outputPaths\s*:|savePath\s*:/);
  for (const channel of ['file:export-detail', 'file:export-balance']) {
    const start = mainSource.indexOf(`trackedIpcHandle('${channel}'`);
    const end = mainSource.indexOf('\n  });', start);
    const handler = mainSource.slice(start, end);
    assert.match(handler, /taskContext\.fileEvidence\.filePlan\.outputs\[0\]\.filePath/, channel);
    assert.match(handler, /taskContext\.settleArtifacts\(/, channel);
  }
});

test('两个 deferred action 仅在非空结果确定具体 output 后 promote，写盘与证据同一路径', () => {
  const deferredManifest = loadFunction(
    'buildStatementDeferredOutputManifest',
    ['fs', 'path', 'artifactManifestFromFilePlan', 'normalizeFilePlanV1'],
    [fs, path, artifactManifestFromFilePlan, normalizeFilePlanV1]
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-deferred-output-'));
  try {
    const outputPath = path.join(root, 'exports', '2026-08-18', 'balance', 'result.xlsx');
    assert.equal(fs.existsSync(path.dirname(outputPath)), false);
    const manifest = deferredManifest(outputPath, 'monthly-balance:assemble');
    assert.equal(fs.existsSync(path.dirname(outputPath)), true);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(manifest.outputs[0].filePath, outputPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const monthlyStart = mainSource.indexOf("trackedIpcHandle('monthly-balance:assemble'");
  const monthlyEnd = mainSource.indexOf("trackedIpcHandle('monthly-balance:export'", monthlyStart);
  const monthly = mainSource.slice(monthlyStart, monthlyEnd);
  assert.match(monthly, /allocation:\s*'deferred'/);
  assert.ok(monthly.indexOf('if (!assembled.records.length)') < monthly.indexOf('buildStatementDeferredOutputManifest('));
  assert.doesNotMatch(
    monthly.slice(0, monthly.indexOf('if (!assembled.records.length)')),
    /ensureStorageRoot\(|mkdirSync\(/
  );
  assert.ok(monthly.indexOf('await taskContext.ensureFileBatch(promotionManifest)') < monthly.indexOf('writeBalanceWorkbook({'));
  assert.match(monthly, /const promotedOutputPath = promotionManifest\.outputs\[0\]\.filePath/);
  assert.doesNotMatch(monthly, /filePath:\s*output\.outputFilePath|临时文件：\$\{output\.outputFilePath\}/);

  const accountStart = mainSource.indexOf("trackedIpcHandle('new-account:generate'");
  const accountEnd = mainSource.indexOf("trackedIpcHandle('new-account:export'", accountStart);
  const account = mainSource.slice(accountStart, accountEnd);
  assert.match(account, /allocation:\s*'deferred'/);
  assert.ok(account.indexOf('buildNewAccountBalanceRecords({') < account.indexOf('buildStatementDeferredOutputManifest('));
  assert.ok(account.indexOf('await taskContext.ensureFileBatch(promotionManifest)') < account.indexOf('writeBalanceWorkbook({'));
  assert.match(account, /filePath:\s*promotedOutputPath/);
  assert.doesNotMatch(account, /filePath:\s*output\.outputFilePath/);

  assert.doesNotMatch(mainSource, /atomicFileLifecycleChannels/);
  assert.match(mainSource, /policy\.allocation === 'deferred'[\s\S]*?runDeferredFileTask/);
  assert.match(mainSource, /archiveTaskLifecycle\.runFileTask/);
});
