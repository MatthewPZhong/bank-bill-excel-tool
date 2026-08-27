'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createDuplicateManagedService
} = require('../../../../src/main-process/duplicate-inbound-match/managed-service');

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

test('单Service busy拒绝且candidate仅在adopt ACK后发布revision/status', async () => {
  const importGate = deferred();
  const adoptGate = deferred();
  const calls = { invalidated: 0, closed: 0 };
  const legacy = {
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
  };
  const service = createDuplicateManagedService({
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
  assert.equal(calls.invalidated, 1);
  assert.equal(calls.closed, 1);
});

test('adoption拒绝不发布candidate并执行导入失效回收', async () => {
  let invalidated = 0;
  const legacy = {
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
  };
  const service = createDuplicateManagedService({
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
  const legacy = {
    bankSession: { rowCount: 1 },
    documentSession: { rowCount: 1 },
    lastRun: null,
    async importFiles() { throw importFailure; },
    async run() { throw runFailure; },
    invalidateForNewImport() { invalidated += 1; },
    clearPreviousRun() { clearedRuns += 1; }
  };
  const service = createDuplicateManagedService({
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
  const legacy = {
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
  };
  const service = createDuplicateManagedService({
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
