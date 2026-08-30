'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const { BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');
const {
  createPreFundReconciliationStore
} = require('../../../../src/backend/pre-fund-reconciliation-store');
const {
  ensureDuplicateInboundMatchRunMetadataSupport
} = require('../../../../src/backend/database/migrations');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../../../../src/main-process/pre-fund-reconciliation/mpt-schema');

const {
  createDuplicateManagedService
} = require('../../../../src/main-process/duplicate-inbound-match/managed-service');

const ROOT = path.resolve(__dirname, '../../../..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function runtime() {
  return {
    userDataDir: '/tmp/duplicate-managed',
    databasePath: '/tmp/duplicate-managed/tool-data.sqlite',
    mailTemplatePath: '/tmp/duplicate-managed/mail.xlsx',
    bankTemplatePath: '/tmp/duplicate-managed/bank.xlsx'
  };
}

function allowStartupGate() {
  return Object.freeze({ assertOperationAllowed() { return true; } });
}

function withStatus(legacy) {
  legacy.status = function status() {
    const summary = this.lastRun && this.lastRun.summary;
    const resultCount = summary
      ? Number(summary.mailRowCount || 0) + Number(summary.manualRowCount || 0)
      : 0;
    return {
      bank: this.bankSession ? { rowCount: this.bankSession.rowCount } : null,
      document: this.documentSession ? { rowCount: this.documentSession.rowCount } : null,
      canRun: Boolean(this.bankSession && this.documentSession),
      canExport: Boolean(this.lastRun && resultCount > 0)
    };
  };
  return legacy;
}

function writeWorkbook(filePath, headers, sheetName, rows = []) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    sheetName
  );
  XLSX.writeFile(workbook, filePath);
}

function bankRow(values = {}) {
  return BANK_STATEMENT_FIELDS.map((field) => values[field] ?? '');
}

function writeMptChange(filePath) {
  const values = {
    batchNo: 'MPT_INBOUND_20260715', billDate: '2026-07-15', channel: 'CIT',
    merchantId: 'M-1', business: 'BUSINESS', oppBu: 'OPP-BU', tradeType: 'Inbound-VA',
    orderId: 'ORDER-NEW', reconId: 'RECON-NEW', billReconId: 'BILL-NEW',
    clientId: 'CLIENT', accId: 'ACCOUNT', cardNo: 'CARD', currency: 'USD',
    originAmount: '1', fee: '0', amount: '1', payerName: 'PAYER', payerAccount: 'PAYER-1',
    valueDate: '2026-07-15', bookDate: '2026-07-15', created: '2026-07-15 01:00:00',
    tradeScope: 'INBOUND', businessDate: '2026-07-15', realChannel: 'CIT',
    clearingNetwork: 'SWIFT', batchSeq: '1'
  };
  const row = INBOUND_FIELDS.map((field) => values[field] ?? '');
  fs.writeFileSync(
    filePath,
    `${[['20260715', 'MPT_INBOUND_20260715', '1'], row]
      .map((item) => item.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
}

test('缺少显式startup gate时首构fail closed且不构造legacy Service', async () => {
  let constructed = 0;
  const service = createDuplicateManagedService({
    createLegacyService: () => { constructed += 1; return withStatus({}); }
  });
  await assert.rejects(
    () => service.execute('duplicate:import', {
      runtime: runtime(), filePaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx']
    }, { adoptCandidate: async () => {} }),
    (error) => error.code === 'DUPLICATE_STARTUP_GATE_UNAVAILABLE'
  );
  assert.equal(constructed, 0);
});

test('单Service busy拒绝且candidate仅在adopt ACK后发布revision/status', async () => {
  const importGate = deferred();
  const adoptGate = deferred();
  const calls = { invalidated: 0, closed: 0 };
  const legacy = withStatus({
    bankSession: null,
    documentSession: null,
    lastRun: null,
    async importFiles() {
      await importGate.promise;
      this.bankSession = { rowCount: 2 };
      this.documentSession = { rowCount: 3 };
      return { status: 'ok' };
    },
    invalidateForNewImport() {
      calls.invalidated += 1;
      this.bankSession = null;
      this.documentSession = null;
      this.lastRun = null;
    }
  });
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() { calls.closed += 1; } }),
    createLegacyService: () => legacy,
    estimateFootprint: () => ({ estimatedBytes: 4096 })
  });
  const first = service.execute('duplicate:import', {
    runtime: runtime(), filePaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx']
  }, {
    adoptCandidate: async () => adoptGate.promise
  });
  await assert.rejects(
    () => service.execute('duplicate:run', { runtime: runtime() }, {}),
    (error) => error.code === 'SERVICE_BUSY'
  );
  assert.equal(service.status().active, true);
  importGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().stateRevision, 1, 'new import acceptance先发布显式失效revision');
  assert.equal(service.status().stableSummary.canRun, false, 'adopt ACK前不得发布candidate');
  adoptGate.resolve();
  const result = await first;
  assert.equal(result.stateRevision, 2);
  assert.deepEqual(result.summary, {
    bankRowCount: 2, documentRowCount: 3, canRun: true, canExport: false
  });
  assert.equal(service.status().active, false);
  service.close();
  assert.equal(service.status().closed, true);
  assert.equal(calls.invalidated, 0, 'normal close不得物理失效持久恢复证据');
  assert.equal(calls.closed, 1);
});

test('adoption拒绝不发布candidate并执行导入失效回收', async () => {
  let invalidated = 0;
  const legacy = withStatus({
    bankSession: null,
    documentSession: null,
    lastRun: null,
    async importFiles() {
      this.bankSession = { rowCount: 9 };
      this.documentSession = { rowCount: 8 };
    },
    invalidateForNewImport() {
      invalidated += 1;
      this.bankSession = null;
      this.documentSession = null;
      this.lastRun = null;
    }
  });
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => legacy,
    estimateFootprint: () => ({ estimatedBytes: 4096 })
  });
  await assert.rejects(
    () => service.execute('duplicate:import', {
      runtime: runtime(), filePaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx']
    }, {
      adoptCandidate: async () => { throw Object.assign(new Error('reject'), { code: 'REJECTED' }); }
    }),
    (error) => error.code === 'REJECTED'
  );
  assert.equal(invalidated, 1);
  assert.equal(service.status().stableSummary.canRun, false);
});

test('legacy导入或运行自身失败时不重复执行destructive cleanup', async () => {
  let invalidated = 0;
  let clearedRuns = 0;
  const importFailure = Object.assign(new Error('import failed'), { code: 'IMPORT_FAILED' });
  const runFailure = Object.assign(new Error('run failed'), { code: 'RUN_FAILED' });
  const legacy = withStatus({
    bankSession: { rowCount: 1 },
    documentSession: { rowCount: 1 },
    lastRun: null,
    async importFiles() { throw importFailure; },
    async run() { throw runFailure; },
    invalidateForNewImport() { invalidated += 1; },
    clearPreviousRun() { clearedRuns += 1; }
  });
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => legacy,
    estimateFootprint: () => ({ estimatedBytes: 4096 })
  });
  await assert.rejects(
    () => service.execute('duplicate:import', {
      runtime: runtime(), filePaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx']
    }, { adoptCandidate: async () => {} }),
    (error) => error.code === 'IMPORT_FAILED'
  );
  await assert.rejects(
    () => service.execute('duplicate:run', { runtime: runtime() }, {
      adoptCandidate: async () => {}
    }),
    (error) => error.code === 'RUN_FAILED'
  );
  assert.equal(invalidated, 0);
  assert.equal(clearedRuns, 0);
});

test('import/run/export复用同一Service并返回有界状态与真实artifact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-managed-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const savePath = path.join(dir, 'result.xlsx');
  let constructed = 0;
  const adopted = [];
  const legacy = withStatus({
    bankSession: null,
    documentSession: null,
    lastRun: null,
    async importFiles() {
      this.bankSession = { rowCount: 5 };
      this.documentSession = { rowCount: 7 };
    },
    async run() {
      this.lastRun = { summary: { mailRowCount: 2, manualRowCount: 1 } };
      return { runId: 12, summary: { mailRowCount: 2, manualRowCount: 1 } };
    },
    async export({ savePath: destination }) {
      fs.writeFileSync(destination, Buffer.from('real-export-bytes'));
    },
    invalidateForNewImport() {
      this.bankSession = null;
      this.documentSession = null;
      this.lastRun = null;
    },
    clearPreviousRun() { this.lastRun = null; }
  });
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => { constructed += 1; return legacy; },
    estimateFootprint: () => ({ estimatedBytes: 4096 })
  });
  const jobContext = {
    async adoptCandidate(candidate, adoption) { adopted.push({ candidate, adoption }); }
  };
  const imported = await service.execute('duplicate:import', {
    runtime: runtime(), filePaths: ['/tmp/bank.xlsx', '/tmp/document.xlsx']
  }, jobContext);
  const ran = await service.execute('duplicate:run', { runtime: runtime() }, jobContext);
  const exported = await service.execute('duplicate:export', {
    runtime: runtime(), savePath
  }, {});
  assert.equal(constructed, 1);
  assert.deepEqual(adopted.map((entry) => entry.adoption.candidateRevision), [2, 4]);
  assert.equal(imported.stateRevision, 2);
  assert.equal(ran.stateRevision, 4);
  assert.equal(ran.runId, 12);
  assert.equal(exported.stateRevision, 4);
  assert.equal(exported.artifacts.length, 1);
  assert.equal(exported.artifacts[0].stagingPath, savePath);
  assert.equal(exported.artifacts[0].byteSize, Buffer.byteLength('real-export-bytes'));
  assert.match(exported.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(service.status()).sort(), [
    'active', 'closed', 'stableSummary', 'stateRevision'
  ]);
});

test('真实managed status对纯Inbound、MPT stale与side unavailable保持canExport单一真值', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-managed-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(databasePath);
  ensureDuplicateInboundMatchRunMetadataSupport(db);
  db.close();
  const bankPath = path.join(dir, 'bank.xlsx');
  const documentPath = path.join(dir, 'document.xlsx');
  writeWorkbook(documentPath, BILL_HEADERS, '单据对账单');
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate()
  });
  const workerRuntime = {
    userDataDir: dir,
    databasePath,
    mailTemplatePath: path.join(ROOT, 'assets', '重复入金召回邮件模板.xlsx'),
    bankTemplatePath: path.join(ROOT, 'assets', '银行对账单.xlsx')
  };
  const jobContext = { adoptCandidate: async () => {} };

  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [bankRow({
    BizId: 'PURE-I', BillDate: '2026-07-14', FundType: 'Inbound',
    'Credit Amount': '10', Channel: 'CIT', MerchantId: 'M-1', Currency: 'USD',
    'Payee Name': 'PURE', 'Payee CardNo': 'P-PURE',
    'Drawee Name': 'D-PURE', 'Drawee CardNo': 'D-PURE'
  })]);
  await service.execute('duplicate:import', {
    runtime: workerRuntime, filePaths: [bankPath, documentPath]
  }, jobContext);
  const pureInbound = await service.execute('duplicate:run', {
    runtime: workerRuntime
  }, jobContext);
  assert.equal(pureInbound.summary.canExport, false);
  assert.equal(service.status().stableSummary.canExport, false);

  const common = {
    BillDate: '2026-07-14', Channel: 'CIT', MerchantId: 'M-1', Currency: 'USD',
    'Payee Name': 'MANUAL', 'Payee CardNo': 'P-MANUAL',
    'Drawee Name': 'D-MANUAL', 'Drawee CardNo': 'D-MANUAL'
  };
  writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', [
    bankRow({ ...common, BizId: 'MANUAL-R', FundType: 'Reversal', 'Debit Amount': '20' }),
    bankRow({ ...common, BizId: 'MANUAL-I', FundType: 'Inbound', 'Credit Amount': '20' })
  ]);
  await service.execute('duplicate:import', {
    runtime: workerRuntime, filePaths: [bankPath, documentPath]
  }, jobContext);
  const exportable = await service.execute('duplicate:run', {
    runtime: workerRuntime
  }, jobContext);
  assert.equal(exportable.summary.canExport, true);

  const mptPath = path.join(dir, 'MPT_INBOUND_GATEWAY_20260715001.txt');
  writeMptChange(mptPath);
  await createPreFundReconciliationStore(dir).importLegacyFile(mptPath);
  assert.equal(service.status().stableSummary.canExport, false, 'MPT变化后立即stale');

  const rerun = await service.execute('duplicate:run', { runtime: workerRuntime }, jobContext);
  assert.equal(rerun.summary.canExport, true);
  const sideDirectory = path.join(dir, 'run-data', 'duplicate-inbound-match');
  for (const name of fs.readdirSync(sideDirectory)) {
    if (name.endsWith('.sqlite')) {
      fs.rmSync(path.join(sideDirectory, name), { force: true });
    }
  }
  assert.equal(service.status().stableSummary.canExport, false, 'side缺失后立即unavailable');
  service.close();
});
