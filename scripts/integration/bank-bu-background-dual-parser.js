// BankBU E08-B optional dual parser集成验证
// 覆盖：真实XLSX→两只只读worker_threads role spool→固定Pending→Bank single Writer、
//       E08-A dataset/receipt/Inspector复用、后续matching保持既有语义、task-private cleanup。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('xlsx');

const runDataStore = require('../../src/backend/run-data-store');
const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
} = require('../../src/backend/bank-bu-recon-db/columns');
const {
  executeManagedBankBuDualImport
} = require('../../src/main-process/bank-bu-worker/dual-parser-dispatch');
const { executeImportMonth } = require('../../src/main-process/bank-bu-worker/import-operation');
const { inspectImportOutcome } = require('../../src/main-process/bank-bu-worker/outcome-inspector');
const { executeRun } = require('../../src/main-process/bank-bu-worker/run-operation');

let passed = 0;
const failures = [];

function check(condition, label) {
  try {
    assert.ok(condition, label);
    passed += 1;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function row(headers, values) {
  return headers.map((header) => values[header] || '');
}

function workbook(filePath, headers, rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Sheet1');
  XLSX.writeFile(book, filePath);
}

function makeFiles(root) {
  const pendingPath = path.join(root, 'pending.xlsx');
  const bankPath = path.join(root, 'bank.xlsx');
  workbook(pendingPath, PENDING_GUANLI_HEADERS, [
    row(PENDING_GUANLI_HEADERS, {
      PendingBizId: 'P-1', 主对账单号: 'R-1', 财务BU: 'BU-A', 大账号: 'ACC-1',
      金额: '10.01', 币种: 'USD'
    }),
    [],
    row(PENDING_GUANLI_HEADERS, {
      PendingBizId: 'P-2', 主对账单号: 'R-2', 财务BU: 'BU-B', 大账号: 'ACC-2',
      金额: '20.02', 币种: 'CNY'
    })
  ]);
  workbook(bankPath, BANK_HEADERS, [
    row(BANK_HEADERS, {
      BizId: 'B-1', ReconciliationId: 'R-1', 'Remark-BU': 'bu-a',
      MerchantId: 'ACC-1', Currency: 'USD', 'Credit Amount': '10.01'
    }),
    [],
    row(BANK_HEADERS, {
      BizId: 'B-2', ReconciliationId: 'R-2', 'Remark-BU': 'BU-X',
      MerchantId: 'ACC-2', Currency: 'CNY', 'Debit Amount': '20.02'
    })
  ]);
  return { pendingPath, bankPath };
}

function runtime(criticalLog) {
  return {
    start(request) {
      const promise = executeImportMonth(request.units[0].input, {
        operationIdentity: {
          actionKey: request.actionKey,
          operationKey: request.operationKey,
          producerTaskRunId: request.context.value.taskRunId
        },
        async awaitCritical(evidence) { criticalLog.push(evidence); }
      }).then(
        (result) => ({ outcome: 'completed', result }),
        (error) => ({ outcome: 'failed', error: {
          code: error.code || 'BANK_BU_IMPORT_FAILED', message: error.message
        } })
      );
      return {
        ready: Promise.resolve(),
        promise,
        snapshot() { return { state: 'running', topology: { effectiveChildCount: 2 } }; }
      };
    },
    execute() { throw new Error('本集成必须走dual parser'); }
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-integration-'));
  const userDataDir = path.join(root, 'user-data');
  const staging = path.join(root, 'staging');
  try {
    const files = makeFiles(root);
    const operationKey = 'bank-bu/import/e08-b-integration';
    const producerTaskRunId = 'task-bank-bu-e08-b-integration';
    const criticalLog = [];
    const execution = await executeManagedBankBuDualImport({
      runtime: runtime(criticalLog),
      workerRuntime: {},
      taskStagingDir: staging,
      userDataDir,
      yearMonth: '2026-08',
      ...files,
      operationContext: {
        taskRunId: producerTaskRunId,
        taskKey: 'bankBuRecon:import:run',
        moduleId: 'bank-bu-recon',
        parentRunId: 'parent-e08-b-integration',
        operationKey
      }
    });
    check(execution.outcome === 'completed' &&
      execution.dualParser.effectiveWorkerCount === 2,
    '真实两只Parser由实际topology并行槽执行');
    check(criticalLog.length === 1 && criticalLog[0].pendingCount === 2 &&
      criticalLog[0].bankCount === 2,
    '两侧均success且source authority复核后才进入一次critical');
    check(execution.result.pendingCount === 2 && execution.result.bankCount === 2,
      'single Writer单事务采用2+2行');
    check(inspectImportOutcome({
      userDataDir,
      yearMonth: '2026-08',
      operationKey,
      producerTaskRunId,
      inputEvidenceHash: execution.result.inputEvidenceHash
    }).outcome === 'committed', 'E08-A import Inspector继续判定committed');

    const db = runDataStore.openSideDb(userDataDir, runDataStore.MODULE_BANK_BU, '2026-08');
    try {
      check(JSON.stringify(db.prepare(`
        SELECT row_index FROM bank_bu_recon_pending_imports ORDER BY id
      `).all().map((item) => Number(item.row_index))) === JSON.stringify([2, 4]),
      'Pending source row index与原始顺序保持');
      check(JSON.stringify(db.prepare(`
        SELECT row_index FROM bank_bu_recon_bank_imports ORDER BY id
      `).all().map((item) => Number(item.row_index))) === JSON.stringify([2, 4]),
      'Bank source row index与原始顺序保持');
      check(db.prepare(`
        SELECT COUNT(*) AS count FROM bank_bu_operation_receipts
        WHERE action_key='bank-bu:import-month' AND operation_key=?
      `).get(operationKey).count === 1, '只由single Writer写一条E08-A operation receipt');
    } finally { db.close(); }

    const reconciled = await executeRun({ userDataDir, yearMonth: '2026-08' }, {
      operationIdentity: {
        actionKey: 'bank-bu:run', operationKey: 'bank-bu/run/e08-b-integration',
        producerTaskRunId: 'task-bank-bu-run-e08-b-integration'
      },
      async awaitCritical() {}
    });
    check(reconciled.stats.matchedCount === 4 && reconciled.stats.buDiffCount === 2,
      '后续1:1 matching与BU差异语义保持既有实现');
    check(!fs.existsSync(staging), '成功终态清理全部task-private role spool');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const total = passed + failures.length;
  console.log(`==== ${passed}/${total} PASS ====`);
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('BankBU E08-B integration fatal:', error);
  process.exit(1);
});
