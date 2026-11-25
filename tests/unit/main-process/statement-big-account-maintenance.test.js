'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const XLSX = require('xlsx');
const { buildMappedRows } = require('../../../src/backend/file-service');
const { buildExpectedHeaderCandidates, normalizeCell } = require('../../../src/backend/file-service/common');
const { matchMerchantIds, normalizeMaintainedBigAccounts } = require('../../../src/main-process/big-account-recognition');
const source = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const deps = {
  path,
  buildExpectedHeaderCandidates,
  normalizeCell,
  matchMerchantIds,
  expandBigAccountConfigurations: normalizeMaintainedBigAccounts
};
function load(name) {
  const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name);
  return Function(...Object.keys(deps), `return (${source.slice(node.start, node.end)});`)(...Object.values(deps));
}
for (const name of ['findBigAccountMatchInRows', 'identifyAccountsFromRecognitionBasis',
  'findSelfInputBigAccountBridge', 'selectPendingBigAccountRows', 'isHeaderOnlyDetailRows', 'identifyAccountBlocks',
  'findHeaderRowNumbersInRawRows', 'buildBigAccountRecognitionBasis',
  'finalizeBigAccountRecognitionBasis', 'buildBigAccountSelectionRows']) deps[name] = load(name);
const build = load('buildBigAccountOrderEvidence');
const extract = load('extractBigAccountOrderFromEvidence');

function fixture(ids = ['M001', 'M002'], options = {}) {
  const filePath = path.resolve('/synthetic/账单.xlsx');
  const rows = ids.map((_id, index) => ({ index, filePath, fileName: '账单.xlsx', fileBlockOrdinal: index, sourceRowNumber: 3 + index * 4 }));
  const detailRows = [['Credit Amount', 'Debit Amount'], ['1', '']];
  detailRows.bigAccountRecognitionBasis = {
    version: 1,
    headerWindows: ids.map((_id, index) => ({ headerRowNumber: 2 + index * 4, candidateRows: [] })),
    bridgeClearingIdsByBlock: ids
  };
  const context = {
    statementSelectionSessionId: 'selection-1',
    bigAccounts: options.bigAccounts || [{ merchantId: 'M001', currencies: ['USD'] }],
    fileEntries: [{ filePath, detailRows, selfInputMerchant: options.selfInputMerchant !== false, skipDirectMerchantLookup: true }],
    rows: options.emptyLast ? rows.slice(0, -1) : rows,
    rowsWithEmptyBlocks: rows
  };
  context.bigAccountOrderEvidence = build(context);
  return context;
}

for (const [emptyBlockOrdinal, label] of ['首段', '中间段', '末尾段'].entries()) {
  test(`空分段定位：实际 XLSX ${label}为空时使用本段冻结表头`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-maintenance-location-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, '空分段.xlsx');
    const headers = ['Credit Amount', 'Debit Amount', 'Currency'];
    const accountIds = ['CLEAR1001', 'CLEAR2002', 'CLEAR3003'];
    const accountMappingByBankId = {};
    const workbookRows = [];
    const headerRowNumbers = [];
    const transactionRowNumbers = [];
    accountIds.forEach((merchantId, blockOrdinal) => {
      const bankId = `BANK${blockOrdinal + 1}001`;
      accountMappingByBankId[bankId] = { clearingAccountId: merchantId };
      // 账号说明在 A 列，交易表在 B:D；reader 应跳过交易列范围全空的说明行。
      workbookRows.push([bankId]);
      workbookRows.push(['', ...headers]);
      headerRowNumbers.push(workbookRows.length);
      if (blockOrdinal !== emptyBlockOrdinal) {
        workbookRows.push(['', 10, '', 'USD']);
        transactionRowNumbers.push(workbookRows.length);
      }
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(workbookRows), '账单');
    XLSX.writeFile(workbook, filePath);
    let recognitionBasis;
    const detailRows = buildMappedRows({
      inputFilePath: filePath,
      orderedTargetFields: headers,
      mappingByField: Object.fromEntries(headers.map((header) => [header, header])),
      expectedSourceHeaders: headers,
      readOptions: {
        onWorkbookRows: (rawRows) => {
          recognitionBasis = deps.buildBigAccountRecognitionBasis({
            rawRows, expectedSourceHeaders: headers, accountMappingByBankId
          });
        }
      }
    });
    detailRows.bigAccountRecognitionBasis = deps.finalizeBigAccountRecognitionBasis(recognitionBasis, detailRows);
    assert.deepEqual(detailRows.headerBreaks, headerRowNumbers.slice(1));
    assert.deepEqual(detailRows.rowMetas.map((row) => row.sourceRowNumber), transactionRowNumbers);
    assert.deepEqual(detailRows.bigAccountRecognitionBasis.bridgeClearingIdsByBlock, accountIds);
    const fileEntries = [{ filePath, detailRows, selfInputMerchant: true, skipDirectMerchantLookup: true }];
    const context = {
      statementSelectionSessionId: `empty-block-${emptyBlockOrdinal}`,
      bigAccounts: accountIds.filter((_id, index) => index !== emptyBlockOrdinal)
        .map((merchantId) => ({ merchantId, currencies: ['USD'] })),
      fileEntries,
      rows: deps.buildBigAccountSelectionRows(fileEntries),
      rowsWithEmptyBlocks: deps.buildBigAccountSelectionRows(fileEntries, { includeEmptyBlocks: true })
    };
    const emptyRow = context.rowsWithEmptyBlocks[emptyBlockOrdinal];
    assert.ok(emptyRow.blockStartIndex > emptyRow.blockEndIndex, '实际分段必须为空');
    assert.equal(context.rows.length, 2);
    assert.equal(context.rowsWithEmptyBlocks.length, 3);
    context.bigAccountOrderEvidence = build(context);
    assert.ok(Object.isFrozen(context.bigAccountOrderEvidence.files[0].maintenanceChecks[emptyBlockOrdinal]));
    // 提取只消费冻结证据；删除本测试的源文件后仍应能定位，不发生二次读取。
    fs.unlinkSync(filePath);
    const before = JSON.stringify(context);
    const result = extract(context, []);
    assert.equal(result.errorCode, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.deepEqual(result.unmaintainedAccounts, [{
      merchantId: accountIds[emptyBlockOrdinal], fileName: '空分段.xlsx', fileOrdinal: 0,
      blockOrdinal: emptyBlockOrdinal, sourceRowNumber: headerRowNumbers[emptyBlockOrdinal]
    }]);
    assert.equal(result.accounts, undefined);
    assert.equal(JSON.stringify(context), before, '定位提示不得修改导入上下文');
  });
}

test('自己输入模式的账号桥接：完整 ID 精确命中优先于维护列表中排在前面的较短后缀', () => {
  const options = normalizeMaintainedBigAccounts([
    { merchantId: 'ACC-1', currencies: ['USD'] },
    { merchantId: 'ACC-100', currencies: ['EUR'] }
  ]);
  const bridge = deps.findSelfInputBigAccountBridge({ bridgeClearingIdsByBlock: ['ACC-100', 'ACC-10'] }, options, 0);
  assert.equal(bridge.merchantId, 'ACC-100');
  // 没有精确命中时仍按维护顺序取第一个模糊命中（与修改前一致）
  assert.equal(deps.findSelfInputBigAccountBridge({ bridgeClearingIdsByBlock: ['ACC-100', 'ACC-10'] }, options, 1).merchantId, 'ACC-1');
});

test('空分段定位：缺少冻结表头时保留预览行回退', () => {
  const context = fixture(['M002']);
  delete context.fileEntries[0].detailRows.bigAccountRecognitionBasis.headerWindows[0].headerRowNumber;
  context.rowsWithEmptyBlocks[0].sourceRowNumber = 23;
  context.bigAccountOrderEvidence = build(context);
  assert.equal(extract(context, []).unmaintainedAccounts[0].sourceRowNumber, 23);
});

test('空分段定位：冻结表头和预览行号均缺失时保留零值', () => {
  const context = fixture(['M002']);
  delete context.fileEntries[0].detailRows.bigAccountRecognitionBasis.headerWindows[0].headerRowNumber;
  delete context.rowsWithEmptyBlocks[0].sourceRowNumber;
  context.bigAccountOrderEvidence = build(context);
  assert.equal(extract(context, []).unmaintainedAccounts[0].sourceRowNumber, 0);
});

test('全批检查不受选中行、已手动绑定和空 rowIndexes 限制，保留未维护原值', () => {
  const context = fixture();
  for (const rowIndexes of [[0], [], [0, 1]]) {
    const result = extract(context, rowIndexes);
    assert.equal(result.errorCode, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.deepEqual(result.unmaintainedAccounts, [{
      merchantId: 'M002', fileName: '账单.xlsx', fileOrdinal: 0, blockOrdinal: 1, sourceRowNumber: 6
    }]);
    assert.equal(result.accounts, undefined);
  }
});

test('选择只列有交易的段时也检查空交易分段；子串及前导零账号不得被维护表替换', () => {
  for (const id of ['M0011', '0M001', ' M002 ']) {
    const result = extract(fixture(['M001', id], { emptyLast: true }), [0]);
    assert.equal(result.errorCode, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.equal(result.unmaintainedAccounts[0].merchantId, id.trim());
  }
});

test('多文件同名与同账号跨段保留来源顺序；提取和证据检查均只读', () => {
  const context = fixture(['M002', 'M002']);
  const second = fixture(['M003']);
  second.fileEntries[0].filePath = path.resolve('/synthetic/other/账单.xlsx');
  context.fileEntries.push(second.fileEntries[0]);
  context.rowsWithEmptyBlocks.push({ ...second.rows[0], index: 2, filePath: second.fileEntries[0].filePath });
  context.bigAccountOrderEvidence = build(context);
  const before = JSON.stringify(context);
  const result = extract(context, [0]);
  assert.deepEqual(result.unmaintainedAccounts.map((r) => [r.merchantId, r.fileOrdinal, r.blockOrdinal]), [
    ['M002', 0, 0], ['M002', 0, 1], ['M003', 1, 0]
  ]);
  assert.equal(JSON.stringify(context), before);
});

test('完全未识别继续普通失败；非自己输入模板不扩大维护检查', () => {
  const unknown = extract(fixture(['']), [0]);
  assert.equal(unknown.status, 'error');
  assert.equal(unknown.errorCode, undefined);
  assert.deepEqual(unknown.failedRows, [{ index: 0, fileName: '账单.xlsx' }]);
  const other = extract(fixture(['M002'], { selfInputMerchant: false }), [0]);
  assert.equal(other.errorCode, undefined);
});

test('维护后重新预检可提取；多币种不是未维护；失效证据优先拒绝', () => {
  const context = fixture([' M002 '], { bigAccounts: [{ merchantId: 'M002', currencies: ['USD', 'EUR'] }] });
  const result = extract(context, [0]);
  assert.equal(result.status, 'ok');
  assert.equal(result.accounts[0].merchantId, 'M002');
  assert.deepEqual(result.ambiguousCurrencyFiles, ['账单.xlsx']);
  context.statementSelectionSessionId = 'different';
  const stale = extract(context, [0]);
  assert.equal(stale.status, 'error');
  assert.match(stale.message, /失效/);
});

test('真实取消接口仅清理当前上下文；已准备的完成请求失效且历史结果保留', async () => {
  const all = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type) all.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  const cancel = all.find((n) => n.type === 'CallExpression'
    && n.callee.object?.name === 'ipcMain' && n.callee.property?.name === 'handle'
    && n.arguments[0]?.value === 'file:cancel-big-account-selection').arguments[1];
  const complete = all.find((n) => n.type === 'VariableDeclarator'
    && n.id.name === 'completeBigAccountSelectionHandler').init;
  const declarations = ['clearPendingBigAccountSelection', 'requirePendingBigAccountSelection']
    .map((name) => {
      const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
      return source.slice(node.start, node.end);
    }).join('\n');
  const pending = { contextId: 'current-context', sourceSelections: [] };
  const history = {
    exports: [{ batchId: 'previous', detailPath: '/synthetic/previous.xlsx' }],
    sessions: new Map([['previous', { rows: ['previous-row'] }]]),
    importContext: { currentBatchId: 'previous' }
  };
  const h = Function('normalizeCell', 'pending', 'history', `
    let lastPendingBigAccountSelection = pending;
    let lastGeneratedExports = history.exports;
    let statementImportSessions = history.sessions;
    let lastFileImportContext = history.importContext;
    const createPreflightErrorResult = (result) => result;
    const createErrorResult = (result) => result;
    const normalizePendingBigAccountSelection = () => ({ isFixedMode: false });
    const buildStatementInputFilePlanItems = () => [];
    // v3.2.19：重复账单过滤（本用例无重复账单待确认）
    const statementDuplicateReview = { cancel: () => null, requireContext: () => null, clear: () => {} };
    const hasDuplicateRowKeys = () => false;
    // 业务入口的配置核对（本用例不涉及配置变化）
    const checkImportConfigGuard = () => null;
    const IMPORT_CONFIG_CHANGED_MESSAGE = '';
    const DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE = '';
    // v3.2.21：渠道余额方式冲突预检（本用例不是按文件名映射模板）
    const isFilenameMappingMode = () => false;
    const findResolvedEntriesBalanceModeConflicts = () => null;
    ${declarations}
    return {
      cancel: ${source.slice(cancel.start, cancel.end)},
      complete: ${source.slice(complete.start, complete.end)},
      getPending: () => lastPendingBigAccountSelection,
      getHistory: () => ({ exports: lastGeneratedExports, sessions: statementImportSessions, importContext: lastFileImportContext })
    };
  `)(normalizeCell, pending, history);
  assert.deepEqual(h.cancel(null, 'old-context'), { status: 'not-active' });
  assert.equal(h.getPending(), pending, '旧窗口不能取消新上下文');
  const prepared = h.complete.prepare(null, { contextId: 'current-context' });
  assert.equal(prepared.proceed, true);
  assert.deepEqual(h.cancel(null, 'current-context'), { status: 'success' });
  assert.equal(h.getPending(), null);
  assert.throws(prepared.beforeStart, /上下文已失效/);
  assert.equal(h.complete.prepare(null, { contextId: 'current-context' }).result.errorCode, 'BIG_ACCOUNT_SELECTION_MISSING');
  assert.equal((await h.complete.execute(null, prepared, {})).errorCode, 'BIG_ACCOUNT_SELECTION_MISSING');
  assert.deepEqual(h.getHistory(), history);
  assert.deepEqual(h.cancel(null, 'current-context'), { status: 'not-active' });
});

// v3.2.21（D3）：完成大账号选择的预检只分配余额方式不同的渠道组的条目（onlyEntries），账号块序号仍按整批累计。
test('分配大账号可只返回指定条目：其余条目只计入账号块序号，注入结果与整批分配一致', () => {
  const { cloneRowsWithMetadata } = require('../../../src/main-process/statement-session');
  deps.cloneRowsWithMetadata = cloneRowsWithMetadata;
  deps.buildFieldIndexMap = load('buildFieldIndexMap');
  const assign = load('applyBigAccountAssignmentsToFileEntries');
  const entry = (name) => ({
    filePath: `/synthetic/${name}.xlsx`,
    matchedTemplateId: 1,
    detailRows: Object.assign([['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'], ['2026-09-01', '', '', '1', '']], {
      rowMetas: [{ sourceRowNumber: 2 }]
    })
  });
  const entries = [entry('a'), entry('b'), entry('c')];
  const assignments = ['M1', 'M2', 'M3'].map((merchantId, rowIndex) => ({ merchantId, currency: 'USD', rowIndex }));
  const full = assign(entries, assignments);
  const subset = assign(entries, assignments, { onlyEntries: new Set([entries[2], entries[0]]) });
  assert.deepEqual(subset.map((item) => [item.filePath, item.detailRows[1][1]]), [['/synthetic/a.xlsx', 'M1'], ['/synthetic/c.xlsx', 'M3']]);
  assert.deepEqual(subset.map((item) => item.detailRows), [full[0].detailRows, full[2].detailRows]);
  assert.equal(entries[2].detailRows[1][1], '', '不改原条目');

  // 不参与复核的文件按选择窗口已识别的账号块计数（countSelectionRowsByFile），结果与逐个识别相同
  const countSelectionRowsByFile = load('countSelectionRowsByFile');
  const selectionRows = deps.buildBigAccountSelectionRows(entries);
  const blockCounts = countSelectionRowsByFile(selectionRows, entries);
  assert.deepEqual([...blockCounts.entries()], entries.map((item) => [item.filePath, 1]));
  const counted = assign(entries, assignments, { onlyEntries: new Set([entries[2]]), blockCounts });
  assert.deepEqual(counted.map((item) => item.detailRows[1][1]), ['M3']);
  // 行的文件对不上条目时不用计数（调用方退回逐个识别）
  assert.equal(countSelectionRowsByFile([{ filePath: '/synthetic/other.xlsx' }], entries), null);
  assert.equal(countSelectionRowsByFile(undefined, entries), null);
});

test('v3.2.22 只有表头的文件不占分配位置：选择窗口、分配执行与按文件计数编号一致；只有余额行的文件仍占一个', () => {
  const { cloneRowsWithMetadata } = require('../../../src/main-process/statement-session');
  deps.cloneRowsWithMetadata = cloneRowsWithMetadata;
  deps.buildFieldIndexMap = load('buildFieldIndexMap');
  const assign = load('applyBigAccountAssignmentsToFileEntries');
  const countSelectionRowsByFile = load('countSelectionRowsByFile');
  const header = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
  // sourceDataRowCount 同 buildMappedRows：原表表头以下读到的数据行数（不可枚举）
  const entry = (name, dataRows, sourceDataRowCount = dataRows.length) => {
    const detailRows = Object.assign([header.slice(), ...dataRows], {
      rowMetas: dataRows.map((_row, index) => ({ sourceRowNumber: index + 2 }))
    });
    Object.defineProperty(detailRows, 'sourceDataRowCount', { value: sourceDataRowCount, enumerable: false });
    return { filePath: `/synthetic/${name}.xlsx`, matchedTemplateId: 1, detailRows };
  };
  const headerOnly = entry('header-only', []);
  const withTransactions = entry('with-transactions', [['2026-09-01', '', '', '5', '', '']]);
  const balanceOnly = entry('balance-only', [['2026-09-01', '', '', '', '', '100']]);
  const entries = [headerOnly, withTransactions, balanceOnly];

  const selectionRows = deps.buildBigAccountSelectionRows(entries);
  assert.deepEqual(selectionRows.map((row) => [row.index, row.fileName]), [
    [0, 'with-transactions.xlsx'],
    [1, 'balance-only.xlsx']
  ]);
  // 维护检查 / 证据用的含空段口径仍给只有表头的文件留一个块
  assert.equal(deps.buildBigAccountSelectionRows(entries, { includeEmptyBlocks: true }).length, 3);

  const assignments = [
    { merchantId: 'M1', currency: 'USD', rowIndex: 0 },
    { merchantId: 'M2', currency: 'EUR', rowIndex: 1 }
  ];
  const assigned = assign(entries, assignments);
  assert.deepEqual(assigned.map((item) => item.detailRows.length), [1, 2, 2]);
  assert.deepEqual(assigned[1].detailRows[1].slice(1, 3), ['M1', 'USD'], '第一个分配位置给有交易的文件');
  assert.deepEqual(assigned[2].detailRows[1].slice(1, 3), ['M2', 'EUR'], '只有余额行的文件按第二个位置分配，余额行保留');

  const blockCounts = countSelectionRowsByFile(selectionRows, entries);
  assert.equal(blockCounts.get(headerOnly.filePath) || 0, 0);
  const counted = assign(entries, assignments, { onlyEntries: new Set([balanceOnly]), blockCounts });
  assert.deepEqual(counted.map((item) => item.detailRows[1].slice(1, 3)), [['M2', 'EUR']]);
  const scanned = assign(entries, assignments, { onlyEntries: new Set([balanceOnly]) });
  assert.deepEqual(scanned.map((item) => item.detailRows), counted.map((item) => item.detailRows));

  // 全部只有表头：没有可分配的位置（调用方据此报「导入文件中没有账号存在交易数据」）
  assert.deepEqual(deps.buildBigAccountSelectionRows([headerOnly, entry('header-only-2', [])]), []);
  assert.deepEqual(deps.identifyAccountBlocks(headerOnly.detailRows), []);
  const allEntriesHeaderOnly = load('allEntriesHeaderOnly');
  assert.equal(allEntriesHeaderOnly([headerOnly, entry('header-only-2', [])]), true);
  assert.equal(allEntriesHeaderOnly([headerOnly, withTransactions]), false);

  // 原表有数据、处理后没有输出（过滤账单全部过滤、拆分合并零输出等）：不算只有表头，沿用原口径（仍占一个位置，生成后照常提示）
  const processedEmpty = entry('processed-empty', [], 3);
  assert.equal(deps.identifyAccountBlocks(processedEmpty.detailRows).length, 1);
  assert.equal(allEntriesHeaderOnly([processedEmpty]), false);
  // 没有记下原表行数（未经 buildMappedRows）：不按只有表头处理
  assert.equal(allEntriesHeaderOnly([{ filePath: '/synthetic/unknown.xlsx', detailRows: [header.slice()] }]), false);
  // 克隆（会话缓存、分配执行）保留原表行数
  assert.equal(cloneRowsWithMetadata(headerOnly.detailRows).sourceDataRowCount, 0);
  assert.equal(cloneRowsWithMetadata(processedEmpty.detailRows).sourceDataRowCount, 3);
  // 重复表头下只有余额行（没有借贷）：有数据行，不按只有表头拦截（直接识别照旧）
  const repeatedHeaderBalanceOnly = entry('repeated-header-balance', [
    ['2026-09-01', '', '', '', '', '100'],
    ['2026-09-02', '', '', '', '', '100']
  ]);
  repeatedHeaderBalanceOnly.detailRows.headerBreaks = [3];
  assert.equal(allEntriesHeaderOnly([repeatedHeaderBalanceOnly]), false);
});

test('v3.2.22 只有表头按原表数据行数判断：真实读取的纯表头文件、拆分合并零输出、过滤账单全部过滤', (t) => {
  const isHeaderOnly = load('isHeaderOnlyDetailRows');
  const allEntriesHeaderOnly = load('allEntriesHeaderOnly');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'header-only-source-rows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const HEADER = ['日期', '类型', '币种', '收入', '支出', '交易金额', '手续费'];
  const write = (name, rows) => {
    const filePath = path.join(dir, `${name}.xlsx`);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Sheet1');
    XLSX.writeFile(workbook, filePath);
    return filePath;
  };
  const splitRow = (seqNo, overrides) => ({ seqNo, rowStatus: 'completed', currencySourceField: '币种', creditSourceField: '', debitSourceField: '',
    amountSourceField: '', mergedGroupSeq: null, isFeeBill: false, ...overrides });
  const map = (filePath, extra = {}) => buildMappedRows({
    inputFilePath: filePath,
    orderedTargetFields: ['BillDate', 'Currency', 'Credit Amount', 'Debit Amount'],
    currencyMappings: [],
    mappingByField: { BillDate: '日期', Currency: '币种', 'Credit Amount': '收入', 'Debit Amount': '支出' },
    expectedSourceHeaders: HEADER,
    featureFilters: {},
    ...extra
  });
  const headerOnly = map(write('header-only', []));
  assert.deepEqual([headerOnly.length, headerOnly.sourceDataRowCount, isHeaderOnly(headerOnly)], [1, 0, true]);
  assert.deepEqual(deps.identifyAccountBlocks(headerOnly), []);
  assert.equal(Object.keys(headerOnly).includes('sourceDataRowCount'), false, '不可枚举，不进入导出与快照');

  // 收入、支出各 100 合并后净额为零：映射后只剩表头，但原表有 1 行数据 → 沿用原流程（拆分零输出提示）
  const netZero = map(write('net-zero', [['2026-11-02', '拆分', 'USD', '', '', '100', '100']]), {
    billSplitMerge: {
      enabled: true, reuseModuleMapping: true, billSplitMappingByTargetField: {},
      billSplitRows: [splitRow(1, { creditSourceField: '交易金额', mergedGroupSeq: 1 }), splitRow(2, { debitSourceField: '手续费', mergedGroupSeq: 1 })],
      billSplitAmountRules: [], signedAmountSourceField: '', signedAmountTargetSeqNos: [], byFieldAmountTargetSeqNos: [], feeAmountFormula: null, rowFilterRules: null
    }
  });
  assert.deepEqual([netZero.length, netZero.sourceDataRowCount, netZero.billSplitMatchStats.outputRows, isHeaderOnly(netZero)], [1, 1, 0, false]);
  assert.equal(deps.identifyAccountBlocks(netZero).length, 1);

  // 过滤账单把数据行全部过滤：原表有数据 → 沿用原流程（提示检查过滤规则）
  const filtered = map(write('filtered', [['2026-11-02', '普通', 'USD', '5', '', '', '']]), {
    preprocessRowFilterRules: [{ seq: 1, conditions: [{ field: '类型', op: '等于', value: '不存在' }] }]
  });
  assert.deepEqual([filtered.length, filtered.sourceDataRowCount, filtered.preprocessRowFilterStats.keptRows, isHeaderOnly(filtered)], [1, 1, 0, false]);

  // 表头下一行就是汇总行（读取时在此截断）、只有模板表头范围以外的列有值（读取时截掉）：原表有内容 → 不算只有表头
  const summaryOnly = map(write('summary-only', [['总收入笔数', '1']]));
  assert.deepEqual([summaryOnly.length, summaryOnly.sourceDataRowCount, isHeaderOnly(summaryOnly)], [1, 1, false]);
  const outsideOnly = map(write('outside-only', [['', '', '', '', '', '', '', '余额 100']]));
  assert.deepEqual([outsideOnly.length, outsideOnly.sourceDataRowCount, isHeaderOnly(outsideOnly)], [1, 1, false]);
  // 表头下的行只有 Excel 错误值（读取库读成空串）：原表有内容 → 不算只有表头；表头之上的错误值不计入
  const errorOnly = map(write('error-only', [[{ t: 'e', v: 0x2A }, '', '', { t: 'e', v: 0x07 }]]));
  assert.deepEqual([errorOnly.length, errorOnly.sourceDataRowCount, isHeaderOnly(errorOnly)], [1, 1, false]);
  const errorAboveHeaderPath = path.join(dir, 'error-above-header.xlsx');
  const errorAboveHeader = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(errorAboveHeader, XLSX.utils.aoa_to_sheet([['说明', { t: 'e', v: 0x2A }], HEADER]), 'Sheet1');
  XLSX.writeFile(errorAboveHeader, errorAboveHeaderPath);
  const errorAbove = map(errorAboveHeaderPath);
  assert.deepEqual([errorAbove.length, errorAbove.sourceDataRowCount, isHeaderOnly(errorAbove)], [1, 0, true]);

  const entry = (detailRows) => ({ filePath: path.join(dir, 'x.xlsx'), detailRows });
  assert.equal(allEntriesHeaderOnly([entry(headerOnly), entry(headerOnly)]), true);
  assert.equal(allEntriesHeaderOnly([entry(headerOnly), entry(netZero)]), false);
  assert.equal(allEntriesHeaderOnly([entry(filtered)]), false);
});

test('完成大账号选择：分配后渠道同一账户命中不同余额方式时未开始即拒绝，释放本次选择、历史结果保留', () => {
  const { FileValidationError } = require('../../../src/backend/file-service');
  const all = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type) all.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  })(ast);
  const complete = all.find((n) => n.type === 'VariableDeclarator' && n.id.name === 'completeBigAccountSelectionHandler').init;
  const declarations = ['clearPendingBigAccountSelection', 'requirePendingBigAccountSelection', 'buildChannelBalanceModeMismatchError', 'maskAccountLikeTextForLog', 'countSelectionRowsByFile']
    .map((name) => {
      const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
      return source.slice(node.start, node.end);
    }).join('\n');
  const pending = {
    contextId: 'current-context',
    templateId: '__FILENAME_MAPPING__',
    sourceSelections: [],
    fileEntries: [{ id: 'plain' }, { id: 'mixed-1' }, { id: 'mixed-2' }],
    // 导入预检时记下的余额方式不同的渠道组的条目位置
    balanceModeMixedEntryIndexes: [1, 2]
  };
  const history = { exports: [{ batchId: 'previous' }], importContext: { currentBatchId: 'previous' } };
  const conflictGroups = [{
    channelName: '招商银行-上海',
    lines: ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）'],
    accountCount: 1,
    templateNames: ['招商银行-上海', 'CMB-SH']
  }];
  const resolvedSubsets = [];
  const h = Function('normalizeCell', 'FileValidationError', 'pending', 'history', 'conflictGroups', 'resolvedSubsets', `
    let lastPendingBigAccountSelection = pending;
    let lastGeneratedExports = history.exports;
    let lastFileImportContext = history.importContext;
    const createPreflightErrorResult = (result) => ({ status: 'error', ...result });
    const normalizePendingBigAccountSelection = () => ({ isFixedMode: false, normalizedAssignments: [] });
    const buildStatementInputFilePlanItems = () => [];
    const statementDuplicateReview = { cancel: () => null, requireContext: () => null, clear: () => {} };
    const hasDuplicateRowKeys = () => false;
    const IMPORT_CONFIG_CHANGED_MESSAGE = '';
    const DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE = '';
    const isFilenameMappingMode = (templateId) => templateId === '__FILENAME_MAPPING__';
    const applyBigAccountAssignmentsToFileEntries = (_entries, _assignments, options) => {
      resolvedSubsets.push(options && options.onlyEntries ? options.onlyEntries.size : 'all');
      return [];
    };
    const pickResolvedEntries = () => { throw new Error('未查重时不应整批分配'); };
    const findResolvedEntriesBalanceModeConflicts = (mixedEntries, resolveEntries) => {
      resolvedSubsets.push(mixedEntries.map((entry) => entry.id));
      resolveEntries(mixedEntries);
      return conflictGroups;
    };
    ${declarations}
    return {
      complete: ${source.slice(complete.start, complete.end)},
      getPending: () => lastPendingBigAccountSelection,
      getHistory: () => ({ exports: lastGeneratedExports, importContext: lastFileImportContext })
    };
  `)(normalizeCell, FileValidationError, pending, history, conflictGroups, resolvedSubsets);
  const prepared = h.complete.prepare(null, { contextId: 'current-context' });
  assert.equal(prepared.proceed, false);
  assert.deepEqual([prepared.result.errorCode, prepared.result.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', conflictGroups[0].lines]);
  assert.match(prepared.result.message, /^渠道「招商银行-上海」下同一账户命中了余额方式不同的子模板/);
  assert.deepEqual(resolvedSubsets, [['mixed-1', 'mixed-2'], 2], '只取导入时记下位置的条目，只分配这些条目');
  assert.equal(h.getPending(), null, '释放本次大账号选择');
  assert.deepEqual(h.getHistory(), history, '上一批的导出与会话不变');
});

// v3.2.21（D3）：导入预检记下的余额方式不同的渠道组的条目位置经真实的暂存→取回保留（含空数组），完成选择时按位置复核
test('暂存大账号选择上下文时保留余额方式不同的渠道组的条目位置', () => {
  const { cloneRowsWithMetadata } = require('../../../src/main-process/statement-session');
  const store = Function('normalizeCell', 'randomUUID', 'normalizeInputFilePaths', 'cloneRowsWithMetadata', 'path', `
    let lastPendingBigAccountSelection = null;
    ${['rememberPendingBigAccountSelection', 'requirePendingBigAccountSelection']
      .map((name) => {
        const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
        return source.slice(node.start, node.end);
      }).join('\n')}
    return { rememberPendingBigAccountSelection, requirePendingBigAccountSelection };
  `)(normalizeCell, () => 'ctx-1', (paths) => [].concat(paths || []), cloneRowsWithMetadata, path);
  const entry = (name) => ({ filePath: `/synthetic/${name}.xlsx`, matchedTemplateId: 1, detailRows: [['BillDate'], ['2026-09-01']] });
  for (const indexes of [[1, 2], [], undefined]) {
    const contextId = store.rememberPendingBigAccountSelection({
      templateId: '__FILENAME_MAPPING__',
      fileEntries: [entry('a'), entry('b'), entry('c')],
      ...(indexes ? { balanceModeMixedEntryIndexes: indexes } : {})
    });
    const stored = store.requirePendingBigAccountSelection(contextId);
    assert.deepEqual(stored.balanceModeMixedEntryIndexes, indexes === undefined ? null : indexes);
    if (indexes) assert.notEqual(stored.balanceModeMixedEntryIndexes, indexes, '复制一份，不与导入时的数组共用');
  }
});

// v3.2.21 release 审查：手动分配大账号与自动选定同一口径，长数字提示中只写进被覆盖列（MerchantId / Currency）的源字段不再提示
test('手动分配大账号：被分配的行中只写进大账号 / 币种列的长数字提示去掉，写进其他列的与未分配行的照常保留', () => {
  const { cloneRowsWithMetadata } = require('../../../src/main-process/statement-session');
  deps.cloneRowsWithMetadata = cloneRowsWithMetadata;
  deps.buildFieldIndexMap = load('buildFieldIndexMap');
  deps.dropIssuesOverriddenBySelectedBigAccount = load('dropIssuesOverriddenBySelectedBigAccount');
  const assign = load('applyBigAccountAssignmentsToFileEntries');
  const longNumber = (rowNumber, cells) => ({ type: 'long-number-unverified', fileName: 'a.xlsx', rowNumber, cells });
  const issues = [
    longNumber(2, [{ sourceField: '币种码', digitCount: 19, targetFields: ['Currency'] }]),
    longNumber(3, [
      { sourceField: '币种码', digitCount: 19, targetFields: ['Currency'] },
      { sourceField: '卡号', digitCount: 19, targetFields: ['Payee CardNo', 'Currency'] }
    ]),
    { type: 'currency-unmapped', fileName: 'a.xlsx', rowNumber: 2 }
  ];
  const entry = {
    filePath: '/synthetic/a.xlsx',
    matchedTemplateId: 1,
    detailRows: Object.assign([
      ['BillDate', 'MerchantId', 'Currency', 'Payee CardNo', 'Credit Amount', 'Debit Amount'],
      ['2026-09-01', '', 'X', '', '1', ''],
      ['2026-09-02', '', 'X', 'C', '2', '']
    ], { rowMetas: [{ sourceRowNumber: 2 }, { sourceRowNumber: 3 }], issues })
  };
  const [assigned] = assign([entry], [{ merchantId: 'M1', currency: 'USD', rowIndex: 0 }]);
  assert.deepEqual(assigned.detailRows.slice(1).map((row) => [row[1], row[2]]), [['M1', 'USD'], ['M1', 'USD']]);
  assert.deepEqual(assigned.detailRows.issues, [
    longNumber(3, [{ sourceField: '卡号', digitCount: 19, targetFields: ['Payee CardNo', 'Currency'] }]),
    { type: 'currency-unmapped', fileName: 'a.xlsx', rowNumber: 2 }
  ]);
  assert.equal(entry.detailRows.issues.length, 3, '不改原条目');
  // 没有分配的账号块：行与提示都不变
  const [unassigned] = assign([entry], []);
  assert.deepEqual(unassigned.detailRows.issues, issues);
});
