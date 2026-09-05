'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const XLSX = require('xlsx');
const { buildMappedRows } = require('../../../src/backend/file-service');
const { normalizeCell } = require('../../../src/backend/file-service/common');
const { matchMerchantIds, normalizeMaintainedBigAccounts } = require('../../../src/main-process/big-account-recognition');
const source = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const deps = { path, normalizeCell, matchMerchantIds, expandBigAccountConfigurations: normalizeMaintainedBigAccounts };
function load(name) {
  const node = ast.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name);
  return Function(...Object.keys(deps), `return (${source.slice(node.start, node.end)});`)(...Object.values(deps));
}
for (const name of ['findBigAccountMatchInRows', 'identifyAccountsFromRecognitionBasis',
  'findSelfInputBigAccountBridge', 'selectPendingBigAccountRows', 'identifyAccountBlocks',
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
    const result = extract(context, 'unfixed', []);
    assert.equal(result.errorCode, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.deepEqual(result.unmaintainedAccounts, [{
      merchantId: accountIds[emptyBlockOrdinal], fileName: '空分段.xlsx', fileOrdinal: 0,
      blockOrdinal: emptyBlockOrdinal, sourceRowNumber: headerRowNumbers[emptyBlockOrdinal]
    }]);
    assert.equal(result.accounts, undefined);
    assert.equal(JSON.stringify(context), before, '定位提示不得修改导入上下文');
  });
}

test('空分段定位：缺少冻结表头时保留预览行回退', () => {
  const context = fixture(['M002']);
  delete context.fileEntries[0].detailRows.bigAccountRecognitionBasis.headerWindows[0].headerRowNumber;
  context.rowsWithEmptyBlocks[0].sourceRowNumber = 23;
  context.bigAccountOrderEvidence = build(context);
  assert.equal(extract(context, 'unfixed', []).unmaintainedAccounts[0].sourceRowNumber, 23);
});

test('空分段定位：冻结表头和预览行号均缺失时保留零值', () => {
  const context = fixture(['M002']);
  delete context.fileEntries[0].detailRows.bigAccountRecognitionBasis.headerWindows[0].headerRowNumber;
  delete context.rowsWithEmptyBlocks[0].sourceRowNumber;
  context.bigAccountOrderEvidence = build(context);
  assert.equal(extract(context, 'unfixed', []).unmaintainedAccounts[0].sourceRowNumber, 0);
});

test('全批检查不受选中行、已手动绑定和空 rowIndexes 限制，保留未维护原值', () => {
  const context = fixture();
  for (const rowIndexes of [[0], [], [0, 1]]) {
    const result = extract(context, 'unfixed', rowIndexes);
    assert.equal(result.errorCode, 'BIG_ACCOUNT_NOT_MAINTAINED');
    assert.deepEqual(result.unmaintainedAccounts, [{
      merchantId: 'M002', fileName: '账单.xlsx', fileOrdinal: 0, blockOrdinal: 1, sourceRowNumber: 6
    }]);
    assert.equal(result.accounts, undefined);
  }
});

test('不固定模式也检查空交易分段；子串及前导零账号不得被维护表替换', () => {
  for (const id of ['M0011', '0M001', ' M002 ']) {
    const result = extract(fixture(['M001', id], { emptyLast: true }), 'unfixed', [0]);
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
  const result = extract(context, 'fixed', [0]);
  assert.deepEqual(result.unmaintainedAccounts.map((r) => [r.merchantId, r.fileOrdinal, r.blockOrdinal]), [
    ['M002', 0, 0], ['M002', 0, 1], ['M003', 1, 0]
  ]);
  assert.equal(JSON.stringify(context), before);
});

test('完全未识别继续普通失败；非自己输入模板不扩大维护检查', () => {
  const unknown = extract(fixture(['']), 'unfixed', [0]);
  assert.equal(unknown.status, 'error');
  assert.equal(unknown.errorCode, undefined);
  assert.deepEqual(unknown.failedRows, [{ index: 0, fileName: '账单.xlsx' }]);
  const other = extract(fixture(['M002'], { selfInputMerchant: false }), 'unfixed', [0]);
  assert.equal(other.errorCode, undefined);
});

test('维护后重新预检可提取；多币种不是未维护；失效证据优先拒绝', () => {
  const context = fixture([' M002 '], { bigAccounts: [{ merchantId: 'M002', currencies: ['USD', 'EUR'] }] });
  const result = extract(context, 'unfixed', [0]);
  assert.equal(result.status, 'ok');
  assert.equal(result.accounts[0].merchantId, 'M002');
  assert.deepEqual(result.ambiguousCurrencyFiles, ['账单.xlsx']);
  context.statementSelectionSessionId = 'different';
  const stale = extract(context, 'unfixed', [0]);
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
