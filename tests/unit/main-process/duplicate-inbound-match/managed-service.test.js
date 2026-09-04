'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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

function exportStagingPlan(stagingRoot, options = {}) {
  return {
    version: 1,
    stagingRoot,
    outputs: [{
      artifactKey: options.artifactKey || `output-${'a'.repeat(64)}`,
      stagingPath: options.stagingPath || path.join(stagingRoot, 'result.xlsx')
    }]
  };
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
  const stagingRoot = path.join(dir, 'task-private');
  const savePath = path.join(stagingRoot, 'result.xlsx');
  fs.mkdirSync(stagingRoot, { recursive: true });
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
    runtime: runtime(), stagingPlan: exportStagingPlan(stagingRoot, {
      artifactKey: `output-${'b'.repeat(64)}`
    })
  }, {});
  assert.equal(constructed, 1);
  assert.deepEqual(adopted.map((entry) => entry.adoption.candidateRevision), [2, 4]);
  assert.equal(imported.stateRevision, 2);
  assert.equal(ran.stateRevision, 4);
  assert.equal(ran.runId, 12);
  assert.equal(exported.stateRevision, 4);
  assert.equal(exported.artifacts.length, 1);
  assert.equal(exported.artifacts[0].artifactKey, `output-${'b'.repeat(64)}`);
  assert.equal(exported.artifacts[0].stagingPath, savePath);
  assert.equal(exported.artifacts[0].byteSize, Buffer.byteLength('real-export-bytes'));
  assert.match(exported.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(service.status()).sort(), [
    'active', 'closed', 'stableSummary', 'stateRevision'
  ]);
});

test('managed export只接受task-private stagingPlan并拒绝覆盖既有target', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-managed-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stagingRoot = path.join(dir, 'task-private');
  const outsidePath = path.join(dir, 'formal-output.xlsx');
  let exportCalls = 0;
  const legacy = withStatus({
    bankSession: { rowCount: 1 },
    documentSession: { rowCount: 1 },
    lastRun: { summary: { mailRowCount: 1, manualRowCount: 0 } },
    async export({ savePath }) {
      exportCalls += 1;
      fs.writeFileSync(savePath, 'unexpected');
    }
  });
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => legacy
  });

  await assert.rejects(
    () => service.execute('duplicate:export', { runtime: runtime(), savePath: outsidePath }),
    (error) => error.code === 'DUPLICATE_EXPORT_FILE_PLAN_INVALID'
  );
  await assert.rejects(
    () => service.execute('duplicate:export', {
      runtime: runtime(),
      stagingPlan: exportStagingPlan(stagingRoot, { artifactKey: 'not-a-file-plan-key' })
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_FILE_PLAN_INVALID'
  );
  await assert.rejects(
    () => service.execute('duplicate:export', {
      runtime: runtime(),
      stagingPlan: exportStagingPlan(stagingRoot, { stagingPath: outsidePath })
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_STAGING_ESCAPE'
  );
  fs.mkdirSync(stagingRoot, { recursive: true });
  const existingPath = path.join(stagingRoot, 'existing.xlsx');
  fs.writeFileSync(existingPath, 'do-not-overwrite');
  await assert.rejects(
    () => service.execute('duplicate:export', {
      runtime: runtime(),
      stagingPlan: exportStagingPlan(stagingRoot, { stagingPath: existingPath })
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_STAGING_TARGET_EXISTS'
  );
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'do-not-overwrite');
  assert.equal(fs.existsSync(outsidePath), false);
  assert.equal(exportCalls, 0);
});

test('managed export拒绝task-private目录的物理符号链接逃逸', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-managed-symlink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stagingRoot = path.join(dir, 'task-private');
  const outsideDir = path.join(dir, 'outside');
  const linkedParent = path.join(stagingRoot, 'linked-parent');
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  let exportCalls = 0;
  const service = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => withStatus({
      bankSession: { rowCount: 1 },
      documentSession: { rowCount: 1 },
      lastRun: { summary: { mailRowCount: 1, manualRowCount: 0 } },
      async export() { exportCalls += 1; }
    })
  });
  await assert.rejects(
    () => service.execute('duplicate:export', {
      runtime: runtime(),
      stagingPlan: exportStagingPlan(stagingRoot, {
        stagingPath: path.join(linkedParent, 'result.xlsx')
      })
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_STAGING_SYMLINK_ESCAPE'
  );
  assert.equal(exportCalls, 0);
  assert.equal(fs.existsSync(path.join(outsideDir, 'result.xlsx')), false);

  const nestedOutsideDir = path.join(outsideDir, 'must-not-be-created');
  await assert.rejects(
    () => service.execute('duplicate:export', {
      runtime: runtime(),
      stagingPlan: exportStagingPlan(stagingRoot, {
        stagingPath: path.join(linkedParent, 'must-not-be-created', 'result.xlsx')
      })
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_STAGING_PARENT_INVALID'
  );
  assert.equal(exportCalls, 0);
  assert.equal(fs.existsSync(nestedOutsideDir), false);
});

test('managed export失败清理已生成staging，清理失败保留双重错误', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-managed-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firstRoot = path.join(dir, 'first-task');
  const firstPath = path.join(firstRoot, 'result.xlsx');
  fs.mkdirSync(firstRoot, { recursive: true });
  const firstFailure = Object.assign(new Error('writer failed after output'), { code: 'WRITER_FAILED' });
  const firstService = createDuplicateManagedService({
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => withStatus({
      bankSession: { rowCount: 1 },
      documentSession: { rowCount: 1 },
      lastRun: { summary: { mailRowCount: 1, manualRowCount: 0 } },
      async export({ savePath }) {
        fs.writeFileSync(savePath, 'partial');
        throw firstFailure;
      }
    })
  });
  await assert.rejects(
    () => firstService.execute('duplicate:export', {
      runtime: runtime(), stagingPlan: exportStagingPlan(firstRoot)
    }),
    (error) => error === firstFailure
  );
  assert.equal(fs.existsSync(firstPath), false);

  const hashFailure = Object.assign(new Error('hash stream failed'), { code: 'HASH_FAILED' });
  const hashFs = Object.create(fs);
  hashFs.createReadStream = () => new Readable({
    read() { this.destroy(hashFailure); }
  });
  const hashRoot = path.join(dir, 'hash-task');
  const hashPath = path.join(hashRoot, 'result.xlsx');
  fs.mkdirSync(hashRoot, { recursive: true });
  const hashService = createDuplicateManagedService({
    fsImpl: hashFs,
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => withStatus({
      bankSession: { rowCount: 1 },
      documentSession: { rowCount: 1 },
      lastRun: { summary: { mailRowCount: 1, manualRowCount: 0 } },
      async export({ savePath }) { fs.writeFileSync(savePath, 'complete-before-hash'); }
    })
  });
  await assert.rejects(
    () => hashService.execute('duplicate:export', {
      runtime: runtime(), stagingPlan: exportStagingPlan(hashRoot)
    }),
    (error) => error === hashFailure
  );
  assert.equal(fs.existsSync(hashPath), false);

  const cleanupFailure = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
  const fsImpl = Object.create(fs);
  fsImpl.rmSync = () => { throw cleanupFailure; };
  const secondRoot = path.join(dir, 'second-task');
  const secondPath = path.join(secondRoot, 'result.xlsx');
  fs.mkdirSync(secondRoot, { recursive: true });
  const secondFailure = Object.assign(new Error('writer failed again'), { code: 'WRITER_FAILED' });
  const secondService = createDuplicateManagedService({
    fsImpl,
    startupGate: allowStartupGate(),
    createMirrorDatabase: () => ({ close() {} }),
    createLegacyService: () => withStatus({
      bankSession: { rowCount: 1 },
      documentSession: { rowCount: 1 },
      lastRun: { summary: { mailRowCount: 1, manualRowCount: 0 } },
      async export({ savePath }) {
        fs.writeFileSync(savePath, 'partial');
        throw secondFailure;
      }
    })
  });
  await assert.rejects(
    () => secondService.execute('duplicate:export', {
      runtime: runtime(), stagingPlan: exportStagingPlan(secondRoot)
    }),
    (error) => error.code === 'DUPLICATE_EXPORT_STAGING_CLEANUP_FAILED' &&
      error.cause === secondFailure && error.cleanupError === cleanupFailure
  );
  assert.equal(fs.readFileSync(secondPath, 'utf8'), 'partial');
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
  const exportRoot = path.join(dir, 'real-export-task');
  const exportPath = path.join(exportRoot, 'result.xlsx');
  fs.mkdirSync(exportRoot, { recursive: true });
  const exported = await service.execute('duplicate:export', {
    runtime: workerRuntime,
    stagingPlan: exportStagingPlan(exportRoot, { artifactKey: `output-${'c'.repeat(64)}` })
  });
  assert.equal(exported.artifacts[0].artifactKey, `output-${'c'.repeat(64)}`);
  assert.equal(exported.artifacts[0].stagingPath, exportPath);
  assert.equal(exported.artifacts[0].byteSize, fs.statSync(exportPath).size);
  assert.equal(fs.lstatSync(exportPath).isFile(), true);

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
