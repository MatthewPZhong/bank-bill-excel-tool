#!/usr/bin/env node

// v3.1.7 Payment + R5s2-recon 固定样本回归生成器。
// 使用生产 reader、派生 builder、编排器和 writer；任一基线漂移都先失败，不输出“看似成功”的工作簿。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  readBankStatement,
  writeBankStatementMainOutput
} = require('../src/main-process/bank-statement-io');
const { streamLinkedRowsToInsert } = require('../src/main-process/linked-table-stream-source');
const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE } = require('../src/constants/table-signatures');
const { buildFundTransferReconRows } = require('../src/main-process/fund-transfer-recon-builder');
const { runReconciliation } = require('../src/main-process/reconciliation-orchestrator');

const DEFAULT_SOURCE_DIR = path.join(os.homedir(), 'Desktop', '小助手-Debug', '3.1.7');
const DEFAULT_BANK_PATH = path.join(
  DEFAULT_SOURCE_DIR,
  'CITILU202510-202607调拨渠道账单_2026-08-03_680437.xlsx'
);
const DEFAULT_TRANSFER_PATH = path.join(DEFAULT_SOURCE_DIR, 'Fund_transfer_apply_1785725872740.xlsx');
const DEFAULT_OUTPUT_PATH = path.join(os.homedir(), 'Desktop', '3.1.7_Payment-R5s2固定样本回归结果.xlsx');

const EXPECTED = Object.freeze({
  bankRows: 1831,
  transferRows: 223,
  derivedRows: 446,
  paymentMatched: 220,
  paymentR1: 218,
  paymentR2: 0,
  paymentR3: 2,
  paymentModified: 190,
  r5Modified: 2,
  hitRows: 192,
  unmatchedRows: 1639,
  manyToManyReviewRows: 166
});

function makeScenario() {
  return {
    id: 502,
    name: '中台调拨订单对账ID回填',
    category: 'builtin-fixed',
    isBuiltin: true,
    priority: 0,
    enabled: true,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'fund-transfer-backfill',
      roundPhase: 5,
      reconSourceMid: true,
      directions: [
        { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
        { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
      ],
      dateMatchEnabled: true,
      dateToleranceDays: 1,
      paymentOfflineBackfill: {
        enabled: true,
        bigAccount: '202782001',
        bankChannel: 'CITI',
        region: 'LU'
      }
    }
  };
}

function countPaymentRounds(pairs) {
  const counts = { main: 0, 'date-tolerance': 0, 'relaxed-week': 0 };
  for (const pair of pairs) {
    if (Object.prototype.hasOwnProperty.call(counts, pair.round)) counts[pair.round] += 1;
  }
  return counts;
}

function monthDistribution(rows, valueOf) {
  const counts = new Map();
  for (const row of rows) {
    const month = String(valueOf(row) ?? '').slice(0, 7);
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertBusinessBaseline({ bankSession, transferRows, reconRows, result }) {
  const pairs = result.paymentOfflineMatchedPairs || [];
  const rounds = countPaymentRounds(pairs);

  assert.equal(bankSession.rows.length, EXPECTED.bankRows, '银行原始行数漂移');
  assert.equal(transferRows.length, EXPECTED.transferRows, '中台调拨订单行数漂移');
  assert.equal(reconRows.length, EXPECTED.derivedRows, '派生调拨对账单行数漂移');
  assert.equal(pairs.length, EXPECTED.paymentMatched, 'Payment 匹配数漂移');
  assert.equal(rounds.main, EXPECTED.paymentR1, 'Payment R1 匹配数漂移');
  assert.equal(rounds['date-tolerance'], EXPECTED.paymentR2, 'Payment R2 匹配数漂移');
  assert.equal(rounds['relaxed-week'], EXPECTED.paymentR3, 'Payment R3 匹配数漂移');
  assert.equal(result.stats.r5s2bBackfilledCount, EXPECTED.paymentModified, 'Payment 实际改写数漂移');
  assert.equal(result.stats.r5s2BackfilledCount, EXPECTED.r5Modified, 'R5s2-recon 后续改写数漂移');
  assert.equal(result.modifiedRows.length, EXPECTED.hitRows, '命中场景行数漂移');
  assert.equal(result.unmatchedRows.length, EXPECTED.unmatchedRows, '未命中场景行数漂移');
  assert.equal(result.stats.manyToManyReviewCount, EXPECTED.manyToManyReviewRows, '既有多对多审计行数漂移');
  assert.equal(
    result.modifiedRows.length + result.unmatchedRows.length,
    bankSession.rows.length,
    '银行行数守恒失败'
  );

  const cardMismatches = pairs.filter((pair) => (
    String(pair.reconRow && pair.reconRow['付款账号'] || '').trim()
      !== String(pair.bankRow && pair.bankRow['Drawee CardNo'] || '').trim()
  ));
  assert.equal(cardMismatches.length, 0, 'Payment 匹配存在付款账号与 Drawee CardNo 不一致');

  return {
    rounds,
    bankMonths: monthDistribution(bankSession.rows, (row) => row.BillDate),
    paymentMatchMonths: monthDistribution(pairs, (pair) => pair.bankRow && pair.bankRow.BillDate)
  };
}

async function assertWorkbookBaseline(outputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ['未命中场景', '命中场景', '匹配对照', '银行行-原始', '调拨对账单行-原始'],
    '固定样本 sheet 名或顺序漂移'
  );

  const expectedRows = {
    未命中场景: EXPECTED.unmatchedRows + 1,
    命中场景: EXPECTED.hitRows + 1,
    匹配对照: EXPECTED.paymentMatched + 1,
    '银行行-原始': EXPECTED.paymentMatched + 1,
    '调拨对账单行-原始': EXPECTED.paymentMatched + 1
  };
  for (const [sheetName, rowCount] of Object.entries(expectedRows)) {
    assert.equal(workbook.getWorksheet(sheetName).rowCount, rowCount, `${sheetName} 行数漂移`);
  }

  const matchSheet = workbook.getWorksheet('匹配对照');
  const matchHeaders = matchSheet.getRow(1).values.slice(1);
  const draweeColumn = matchHeaders.indexOf('Drawee CardNo') + 1;
  const payAccountColumn = matchHeaders.indexOf('付款账号') + 1;
  assert.ok(draweeColumn > 0 && payAccountColumn > 0, '匹配对照缺少付款账户核对列');
  for (let row = 2; row <= matchSheet.rowCount; row += 1) {
    assert.equal(
      String(matchSheet.getRow(row).getCell(draweeColumn).value ?? '').trim(),
      String(matchSheet.getRow(row).getCell(payAccountColumn).value ?? '').trim(),
      `匹配对照第 ${row} 行付款账号不一致`
    );
  }

  const reconSheet = workbook.getWorksheet('调拨对账单行-原始');
  const reconHeaders = reconSheet.getRow(1).values.slice(1);
  const usedColumn = reconHeaders.indexOf('是否被使用') + 1;
  assert.ok(usedColumn > 0, '调拨对账单行-原始缺少是否被使用');
  for (let row = 2; row <= reconSheet.rowCount; row += 1) {
    assert.equal(reconSheet.getRow(row).getCell(usedColumn).value, '1', `第 ${row} 行未标记使用`);
  }

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        assert.ok(
          !String(cell.value ?? '').includes('ReconciliationId重复'),
          `${sheet.name}!${cell.address} 不得包含已取消的重复提示`
        );
      });
    });
  }
}

async function runFixedSampleRegression({
  bankPath = DEFAULT_BANK_PATH,
  transferPath = DEFAULT_TRANSFER_PATH,
  outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
  const bankSession = readBankStatement(bankPath);
  const transferRows = [];
  const streamed = await streamLinkedRowsToInsert(
    transferPath,
    ZHONGTAI_DISPATCH_ORDER_SIGNATURE,
    (row) => transferRows.push(row)
  );
  assert.equal(streamed.matched, true, '中台调拨订单未识别到严格表头');

  const derivation = buildFundTransferReconRows(transferRows);
  const reconRows = derivation.rows;
  const result = await runReconciliation({
    bankRows: bankSession.rows,
    gwRows: [],
    scenarios: [makeScenario()],
    fundTransferReconContext: { reconRows },
    fundTransferAuditContext: { reconRows },
    fundTransferDatePolicy: {
      enabled: true,
      toleranceDays: 1,
      ownerScenarioId: 502,
      signature: 'v3.1.7-fixed-sample'
    }
  });

  const distributions = assertBusinessBaseline({ bankSession, transferRows, reconRows, result });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await writeBankStatementMainOutput({
    modifiedRows: result.modifiedRows,
    headers: bankSession.headers,
    mainFilePath: outputPath,
    unmatchedRows: result.unmatchedRows,
    modifications: result.modifications,
    paymentOfflinePairs: result.paymentOfflineMatchedPairs,
    manyToManyRows: result.manyToManyReviewRows
  });
  await assertWorkbookBaseline(outputPath);

  return {
    outputPath,
    sourceFiles: [bankPath, transferPath],
    ...EXPECTED,
    ...distributions
  };
}

if (require.main === module) {
  const [bankPath, transferPath, outputPath] = process.argv.slice(2);
  runFixedSampleRegression({
    bankPath: bankPath || DEFAULT_BANK_PATH,
    transferPath: transferPath || DEFAULT_TRANSFER_PATH,
    outputPath: outputPath || DEFAULT_OUTPUT_PATH
  }).then((summary) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED,
  assertBusinessBaseline,
  assertWorkbookBaseline,
  runFixedSampleRegression
};
