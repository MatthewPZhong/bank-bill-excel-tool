'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('xlsx');

const runDataStore = require('../../../src/backend/run-data-store');
const {
  PENDING_GUANLI_HEADERS,
  PENDING_GUANLI_DB_COLUMNS,
  BANK_HEADERS,
  BANK_DB_COLUMNS
} = require('../../../src/backend/bank-bu-recon-db/columns');
const { executeImportMonth } = require('../../../src/main-process/bank-bu-worker/import-operation');
const {
  MIN_DUAL_IMPROVEMENT_RATIO,
  executeBankBuImportWithOptionalDualParser,
  executeManagedBankBuDualImport,
  isDualParserGateApproved,
  runBankBuParserWorker
} = require('../../../src/main-process/bank-bu-worker/dual-parser-dispatch');
const {
  BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
  BANK_BU_INPUT_ROLES,
  bankBuSpoolPaths,
  normalizeDualImportDescriptor
} = require('../../../src/main-process/bank-bu-worker/spool-contract');
const {
  readBankBuSpoolPair
} = require('../../../src/main-process/bank-bu-worker/spool-reader');
const { writeBankBuInputSpool } = require(
  '../../../src/main-process/bank-bu-worker/spool-writer'
);
const {
  writeBankBuParserSuccess
} = require('../../../src/main-process/bank-bu-worker/parser-outcome');
const {
  createBankBuDualTopologyPlanner
} = require('../../../src/main-process/bank-bu-worker/topology');
const {
  BANK_BU_SINGLETON_UNIT_ID
} = require('../../../src/main-process/bank-bu-worker/singleton-unit');

function writeWorkbook(filePath, headers, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function valueRow(headers, values) {
  return headers.map((header) => values[header] || '');
}

function fixture(root) {
  const pendingPath = path.join(root, 'pending.xlsx');
  const bankPath = path.join(root, 'bank.xlsx');
  writeWorkbook(pendingPath, PENDING_GUANLI_HEADERS, [
    valueRow(PENDING_GUANLI_HEADERS, {
      PendingBizId: 'P-1', 财务BU: 'BU-A', 主对账单号: 'R-1', 大账号: 'ACC-P-1',
      金额: '100.01', 币种: 'USD'
    }),
    [],
    valueRow(PENDING_GUANLI_HEADERS, {
      PendingBizId: 'P-2', 财务BU: 'BU-B', 主对账单号: 'R-2', 大账号: 'ACC-P-2',
      金额: '200.02', 币种: 'CNY'
    })
  ]);
  writeWorkbook(bankPath, BANK_HEADERS, [
    valueRow(BANK_HEADERS, {
      BizId: 'B-1', ReconciliationId: 'R-1', 'Remark-BU': 'bu-a',
      MerchantId: 'ACC-B-1', Currency: 'USD', 'Credit Amount': '100.01'
    }),
    [],
    valueRow(BANK_HEADERS, {
      BizId: 'B-2', ReconciliationId: 'R-2', 'Remark-BU': 'BU-X',
      MerchantId: 'ACC-B-2', Currency: 'CNY', 'Debit Amount': '200.02'
    })
  ]);
  return { pendingPath, bankPath };
}

function context(operationKey = 'bank-bu/import/e08-b') {
  return Object.freeze({
    taskRunId: `task-${operationKey}`,
    taskKey: 'bankBuRecon:import:run',
    moduleId: 'bank-bu-recon',
    parentRunId: 'parent-e08-b',
    operationKey
  });
}

function spools(root, files, operationContext = context()) {
  const common = {
    taskStagingDir: path.join(root, 'staging'),
    jobId: 'bank-bu-dual-test',
    operationKey: operationContext.operationKey,
    producerTaskRunId: operationContext.taskRunId,
    yearMonth: '2026-08'
  };
  return Object.freeze([
    Object.freeze({
      ...common, role: BANK_BU_INPUT_ROLES.PENDING,
      source: Object.freeze({ filePath: files.pendingPath })
    }),
    Object.freeze({
      ...common, role: BANK_BU_INPUT_ROLES.BANK,
      source: Object.freeze({ filePath: files.bankPath })
    })
  ]);
}

function dualDescriptor(spoolList) {
  return normalizeDualImportDescriptor({
    contractVersion: BANK_BU_DUAL_IMPORT_CONTRACT_VERSION,
    spools: spoolList
  });
}

function fakeRuntime({ critical, parserCount = 2 } = {}) {
  return {
    start(request) {
      assert.equal(request.units.length, 1);
      assert.equal(request.units[0].unitId, BANK_BU_SINGLETON_UNIT_ID);
      assert.equal(request.units[0].input.dualParserImport, request.input.dualParserImport);
      const promise = executeImportMonth(request.units[0].input, {
        signal: new AbortController().signal,
        operationIdentity: {
          actionKey: request.actionKey,
          operationKey: request.operationKey,
          producerTaskRunId: request.context.value.taskRunId
        },
        async awaitCritical(evidence) {
          if (critical) await critical(evidence);
        }
      }).then(
        (result) => Object.freeze({ outcome: 'completed', result }),
        (error) => Object.freeze({ outcome: 'failed', error: {
          code: error.code || 'BANK_BU_IMPORT_FAILED', message: error.message
        } })
      );
      return {
        ready: Promise.resolve(),
        promise,
        snapshot() {
          return Object.freeze({
            state: 'running', topology: Object.freeze({ effectiveChildCount: parserCount })
          });
        }
      };
    },
    execute(request) { return Promise.resolve(Object.freeze({ outcome: 'direct', request })); }
  };
}

const approvedGate = Object.freeze({
  enabled: true,
  measuredImprovementRatio: MIN_DUAL_IMPROVEMENT_RATIO,
  peakRssBytes: 100,
  rssBudgetBytes: 101
});

function dispatchOptions(root, files, overrides = {}) {
  return {
    runtime: fakeRuntime(overrides.runtimeOptions),
    workerRuntime: {},
    taskStagingDir: path.join(root, 'staging'),
    userDataDir: path.join(root, 'user-data'),
    yearMonth: '2026-08',
    pendingPath: files.pendingPath,
    bankPath: files.bankPath,
    operationContext: context(overrides.operationKey),
    dualParserGate: approvedGate,
    ...overrides
  };
}

test('BankBU role spool保留month、source row index、BU、账号、金额币种与原始顺序', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-spool-'));
  try {
    const files = fixture(root);
    const list = spools(root, files);
    // 故意Bank先完成；Writer读取仍固定Pending→Bank。
    const bankResult = await writeBankBuInputSpool(list[1]);
    const pendingResult = await writeBankBuInputSpool(list[0]);
    writeBankBuParserSuccess(list[1], bankResult);
    writeBankBuParserSuccess(list[0], pendingResult);
    const pair = await readBankBuSpoolPair(dualDescriptor(list));
    assert.equal(pair.pending.manifest.yearMonth, '2026-08');
    assert.deepEqual(pair.pending.rows.map((row) => row._rowIndex), [2, 4]);
    assert.deepEqual(pair.bank.rows.map((row) => row._rowIndex), [2, 4]);
    assert.equal(pair.pending.rows[0].finance_bu, 'BU-A');
    assert.equal(pair.pending.rows[0].account_no, 'ACC-P-1');
    assert.equal(pair.pending.rows[0].amount, '100.01');
    assert.equal(pair.pending.rows[0].currency, 'USD');
    assert.equal(pair.bank.rows[0].remark_bu, 'bu-a');
    assert.equal(pair.bank.rows[0].merchant_id, 'ACC-B-1');
    assert.equal(pair.bank.rows[1].debit_amount, '200.02');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实worker_threads Parser只返回bounded role manifest并在clean exit后结算', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-worker-'));
  try {
    const files = fixture(root);
    const list = spools(root, files);
    const states = [];
    const result = await runBankBuParserWorker(list[0], {
      onWorkerState(state) { states.push(state); }
    });
    assert.equal(result.role, BANK_BU_INPUT_ROLES.PENDING);
    assert.equal(result.rowCount, 2);
    assert.equal(Number.isSafeInteger(result.rssBytes), true);
    assert.deepEqual(Object.keys(result).sort(), [
      'elapsedMs', 'fileName', 'jobId', 'role', 'rowCount', 'rssBytes',
      'schemaVersion', 'yearMonth'
    ]);
    assert.equal(states.length, 1);
    assert.equal(states[0].exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dual Writer与single形成相同dataset evidence、role行序和side receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-parity-'));
  try {
    const files = fixture(root);
    const singleDir = path.join(root, 'single');
    const dualDir = path.join(root, 'dual');
    let singleCritical = 0;
    const single = await executeImportMonth({
      userDataDir: singleDir,
      yearMonth: '2026-08',
      pendingPath: files.pendingPath,
      bankPath: files.bankPath
    }, {
      operationIdentity: {
        actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/single',
        producerTaskRunId: 'task-single'
      },
      async awaitCritical() { singleCritical += 1; }
    });
    let dualCritical = 0;
    const execution = await executeManagedBankBuDualImport(dispatchOptions(root, files, {
      operationKey: 'bank-bu/import/dual',
      runtime: fakeRuntime({ critical() { dualCritical += 1; } }),
      userDataDir: dualDir,
      parserRunner: async (spool) => {
        if (spool.role === BANK_BU_INPUT_ROLES.PENDING) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return { ...(await writeBankBuInputSpool(spool)), rssBytes: 10, elapsedMs: 1 };
      }
    }));
    assert.equal(singleCritical, 1);
    assert.equal(dualCritical, 1);
    assert.equal(execution.outcome, 'completed');
    assert.equal(execution.dualParser.completionOrderIndependent, true);
    assert.equal(execution.result.inputEvidenceHash, single.inputEvidenceHash);

    const read = (userDataDir, table, columns) => {
      const db = runDataStore.openSideDb(userDataDir, runDataStore.MODULE_BANK_BU, '2026-08');
      try {
        return db.prepare(`SELECT row_index, ${columns.join(', ')} FROM ${table} ORDER BY id`).all();
      } finally { db.close(); }
    };
    assert.deepEqual(
      read(dualDir, 'bank_bu_recon_pending_imports', PENDING_GUANLI_DB_COLUMNS),
      read(singleDir, 'bank_bu_recon_pending_imports', PENDING_GUANLI_DB_COLUMNS)
    );
    assert.deepEqual(
      read(dualDir, 'bank_bu_recon_bank_imports', BANK_DB_COLUMNS),
      read(singleDir, 'bank_bu_recon_bank_imports', BANK_DB_COLUMNS)
    );
    assert.equal(fs.existsSync(path.join(root, 'staging')), false, '成功后必须清理spool owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source在Parser成功后变化会在critical前失败且保持零side mutation并清理spool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-source-'));
  try {
    const files = fixture(root);
    let criticalCount = 0;
    await assert.rejects(executeManagedBankBuDualImport(dispatchOptions(root, files, {
      runtime: fakeRuntime({ critical() { criticalCount += 1; } }),
      parserRunner: async (spool) => {
        const result = await writeBankBuInputSpool(spool);
        if (spool.role === BANK_BU_INPUT_ROLES.BANK) fs.appendFileSync(files.bankPath, 'changed');
        return { ...result, rssBytes: 10, elapsedMs: 1 };
      }
    })), (error) => error.code === 'BANK_BU_SPOOL_SOURCE_CHANGED');
    assert.equal(criticalCount, 0);
    assert.equal(fs.existsSync(path.join(root, 'user-data')), false);
    assert.equal(fs.existsSync(path.join(root, 'staging')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('任一Parser失败或取消时等待sibling终态，critical前失败并清理spool', async () => {
  for (const mode of ['failure', 'cancel']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `bank-bu-e08-b-${mode}-`));
    try {
      const files = fixture(root);
      let criticalCount = 0;
      const controller = new AbortController();
      let siblingObservedAbort = false;
      const promise = executeManagedBankBuDualImport(dispatchOptions(root, files, {
        signal: controller.signal,
        runtime: fakeRuntime({ critical() { criticalCount += 1; } }),
        parserRunner: (spool, options) => {
          if (spool.role === BANK_BU_INPUT_ROLES.PENDING && mode === 'failure') {
            return Promise.reject(Object.assign(new Error('bad pending'), {
              code: 'BANK_BU_TEST_PARSE_FAILED'
            }));
          }
          return new Promise((resolve, reject) => {
            const abort = () => {
              siblingObservedAbort = true;
              reject(Object.assign(new Error('cancelled'), { code: 'BANK_BU_PARSER_CANCELLED' }));
            };
            if (options.signal.aborted) abort();
            else options.signal.addEventListener('abort', abort, { once: true });
          });
        }
      }));
      if (mode === 'cancel') setImmediate(() => controller.abort());
      await assert.rejects(promise, (error) => [
        'BANK_BU_TEST_PARSE_FAILED', 'BANK_BU_PARSER_CANCELLED'
      ].includes(error.code));
      assert.equal(siblingObservedAbort, true);
      assert.equal(criticalCount, 0);
      assert.equal(fs.existsSync(path.join(root, 'user-data')), false);
      assert.equal(fs.existsSync(path.join(root, 'staging')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('optional gate在低内存、非双输入、性能或RSS不合格时回退E08-A single', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-gate-'));
  try {
    const files = fixture(root);
    assert.equal(isDualParserGateApproved(approvedGate), true);
    assert.equal(isDualParserGateApproved({ ...approvedGate, measuredImprovementRatio: 0.149 }), false);
    assert.equal(isDualParserGateApproved({ ...approvedGate, peakRssBytes: 102 }), false);
    for (const overrides of [
      { lowMemory: true },
      { bankPath: undefined, taskStagingDir: undefined, workerRuntime: undefined },
      { dualParserGate: { ...approvedGate, measuredImprovementRatio: 0.149 } },
      { dualParserGate: { ...approvedGate, peakRssBytes: 102 } }
    ]) {
      let startCount = 0;
      let executeCount = 0;
      const runtime = {
        start() { startCount += 1; throw new Error('dual不应启动'); },
        execute(request) {
          executeCount += 1;
          return Promise.resolve({ outcome: 'direct', request });
        }
      };
      const result = await executeBankBuImportWithOptionalDualParser(
        dispatchOptions(root, files, { runtime, ...overrides })
      );
      assert.equal(result.outcome, 'direct');
      assert.equal(startCount, 0);
      assert.equal(executeCount, 1);
      assert.equal(result.request.production, false);
      assert.equal(result.request.input.dualParserImport, undefined);
      assert.equal(result.request.units.length, 1);
      assert.equal(result.request.units[0].unitId, BANK_BU_SINGLETON_UNIT_ID);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('topology只对合法dual descriptor且并行度充足返回2，否则single=1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-topology-'));
  try {
    const files = fixture(root);
    const descriptor = dualDescriptor(spools(root, files));
    const request = {
      actionKey: 'bank-bu:import-month',
      input: { dualParserImport: descriptor }
    };
    assert.deepEqual(createBankBuDualTopologyPlanner({ availableParallelism: 8 })(request), {
      effectiveChildCount: 2
    });
    assert.deepEqual(createBankBuDualTopologyPlanner({ availableParallelism: 2 })(request), {
      effectiveChildCount: 1
    });
    assert.deepEqual(createBankBuDualTopologyPlanner({ availableParallelism: 8 })({
      actionKey: 'bank-bu:import-month', input: {}
    }), { effectiveChildCount: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Parser模块静态依赖不含业务DB、matching、receipt、mirror或Inspector', () => {
  const workerDir = path.resolve(__dirname, '../../../src/main-process/bank-bu-worker');
  const sources = ['parser-worker-entry.js', 'spool-writer.js']
    .map((file) => fs.readFileSync(path.join(workerDir, file), 'utf8'))
    .join('\n');
  for (const forbidden of [
    'run-data-store', 'side-database', 'main-coordinator', 'mirror-repository',
    'operation-receipt-repository', 'outcome-inspector', 'run-operation'
  ]) {
    assert.equal(sources.includes(forbidden), false, `Parser不得依赖${forbidden}`);
  }
  assert.equal(sources.includes('runReconciliation'), false);
  assert.equal(sources.includes('DatabaseSync'), false);
});

test('spool descriptor拒绝角色缺失、同源文件与月份漂移', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-contract-'));
  try {
    const files = fixture(root);
    const list = spools(root, files);
    assert.throws(() => dualDescriptor([list[0], list[0]]), /角色必须精确/);
    assert.throws(() => dualDescriptor([
      list[0], { ...list[1], source: list[0].source }
    ]), /parent\/source identity非法/);
    assert.throws(() => dualDescriptor([
      list[0], { ...list[1], yearMonth: '2026-09' }
    ]), /parent\/source identity非法/);
    assert.equal(bankBuSpoolPaths(list[0]).roleDir.includes('role-pending'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Writer在critical前拒绝manifest role篡改与rows内容篡改', async () => {
  for (const tamper of ['manifest-role', 'rows']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `bank-bu-e08-b-${tamper}-`));
    try {
      const files = fixture(root);
      const list = spools(root, files);
      for (const spool of list) {
        const result = await writeBankBuInputSpool(spool);
        writeBankBuParserSuccess(spool, result);
      }
      const paths = bankBuSpoolPaths(list[0]);
      if (tamper === 'manifest-role') {
        const manifest = JSON.parse(fs.readFileSync(paths.manifestReady, 'utf8'));
        manifest.role = BANK_BU_INPUT_ROLES.BANK;
        fs.writeFileSync(paths.manifestReady, `${JSON.stringify(manifest)}\n`);
      } else {
        fs.appendFileSync(paths.rowsReady, '{"tampered":true}\n');
      }
      await assert.rejects(readBankBuSpoolPair(dualDescriptor(list)), (error) => [
        'BANK_BU_SPOOL_IDENTITY_MISMATCH', 'BANK_BU_SPOOL_ROWS_INVALID'
      ].includes(error.code));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
