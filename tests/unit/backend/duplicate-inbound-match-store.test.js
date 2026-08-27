'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runDataStore = require('../../../src/backend/run-data-store');
const {
  createDuplicateInboundMatchStore
} = require('../../../src/backend/duplicate-inbound-match-store');
const operationReceipts = require(
  '../../../src/main-process/duplicate-inbound-match/operation-receipt-repository'
);

async function createImportBundle(store, { bankRows, documentRows = [] }) {
  return store.createImportBundle({
    monthKey: '2026-07',
    bank: {
      fileName: 'bank.xlsx',
      contentHash: 'bank-hash',
      rows: bankRows
    },
    document: {
      fileName: 'document.xlsx',
      contentHash: 'document-hash'
    },
    writeDocumentRows: async (insertRow) => {
      for (const row of documentRows) insertRow(row);
      const matchableRowCount = documentRows.filter((row) => row.businessOrderKey !== '').length;
      return {
        rowCount: documentRows.length,
        matchableRowCount,
        emptyBusinessOrderCount: documentRows.length - matchableRowCount
      };
    }
  });
}

test('重复入金侧库保存双文件导入与结果，保持稳定顺序并可文件级回收', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    const imported = await createImportBundle(store, {
      bankRows: [
        { sourceOrdinal: 1, excelRowNumber: 3, bizId: 'B2', fundType: 'Inbound', raw: { BizId: 'B2' } },
        { sourceOrdinal: 0, excelRowNumber: 2, bizId: 'B1', fundType: 'Reversal', raw: { BizId: 'B1' } }
      ],
      documentRows: [
        {
          sourceOrdinal: 0, excelRowNumber: 2, businessOrderNo: ' O-1 ', businessOrderKey: 'O-1',
          userNo: 'U-1', accountNo: 'A-1', businessDepartment: 'BU-1'
        },
        {
          sourceOrdinal: 1, excelRowNumber: 3, businessOrderNo: 'O-1', businessOrderKey: 'O-1',
          userNo: 'U-2', accountNo: 'A-2', businessDepartment: 'BU-2'
        },
        {
          sourceOrdinal: 2, excelRowNumber: 4, businessOrderNo: '', businessOrderKey: '',
          userNo: 'U-3', accountNo: 'A-3', businessDepartment: 'BU-3'
        }
      ]
    });

    assert.equal(imported.bank.rowCount, 2);
    assert.deepEqual(imported.document, {
      fileName: 'document.xlsx',
      contentHash: 'document-hash',
      rowCount: 3,
      matchableRowCount: 2,
      emptyBusinessOrderCount: 1
    });
    assert.deepEqual(
      store.readBankRows('2026-07', imported.id).map((row) => [row.BizId, row._excelRowNumber]),
      [['B1', 2], ['B2', 3]]
    );
    assert.deepEqual(
      store.readDocumentRows('2026-07', imported.id).map((row) => [
        row.businessOrderNo,
        row.businessOrderKey,
        row.excelRowNumber
      ]),
      [[' O-1 ', 'O-1', 2], ['O-1', 'O-1', 3], ['', '', 4]]
    );
    const candidates = store.lookupDocumentRows('2026-07', imported.id, [' O-1 ', 'NOT-FOUND']);
    assert.equal(candidates.get('O-1').candidateCount, 2);
    assert.equal(candidates.get('O-1').candidates.length, 2);
    assert.deepEqual(candidates.get('NOT-FOUND'), { candidateCount: 0, candidates: [] });

    const runId = store.createRun({
      monthKey: '2026-07',
      importId: imported.id,
      snapshot: { batches: [] },
      snapshotHash: 'snapshot-1'
    });
    store.finishRun({
      monthKey: '2026-07',
      runId,
      summary: {
        mailRowCount: 1,
        manualRowCount: 2,
        auditGroupCount: 3,
        finalSuccessGroupCount: 1,
        manualGroupCount: 2
      },
      mailRows: [{ sourceOrdinal: 0, output: { BillDate: '2026-07-01' } }],
      manualRows: [
        { groupOrder: 1, rowOrder: 1, reason: 'R2', raw: { BizId: 'B2' } },
        { groupOrder: 0, rowOrder: 0, reason: 'R1', raw: { BizId: 'B1' } }
      ],
      auditRows: [
        {
          groupOrder: 0, disposition: 'success', reasonCodes: [],
          bankLineage: [], mptLineage: [], documentLineage: []
        },
        {
          groupOrder: 1, disposition: 'manual', reasonCodes: ['R1'],
          bankLineage: [], mptLineage: [], documentLineage: []
        },
        {
          groupOrder: 2, disposition: 'manual', reasonCodes: ['R2'],
          bankLineage: [], mptLineage: [], documentLineage: []
        }
      ]
    });

    const result = store.readResult('2026-07', runId);
    assert.equal(result.run.status, 'success');
    assert.match(result.run.resultDigest, /^[a-f0-9]{64}$/);
    assert.equal(store.readCommittedResult('2026-07', runId).run.resultDigest, result.run.resultDigest);
    assert.deepEqual(result.mailRows, [{ BillDate: '2026-07-01' }]);
    assert.deepEqual(result.manualRows.map((row) => row.row.BizId), ['B1', 'B2']);
    assert.equal(runDataStore.listSideDbFiles(userDataDir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH).length, 1);

    assert.deepEqual(store.clearAll(), { deletedFiles: 1 });
    assert.equal(runDataStore.listSideDbFiles(userDataDir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH).length, 0);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('finishRun在事务内物化返回值且receipt-owned run拒绝cleanup删除', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  try {
    const store = createDuplicateInboundMatchStore(userDataDir, { operationReceipts });
    const imported = await createImportBundle(store, { bankRows: [], documentRows: [] });
    const summary = {
      mailRowCount: 0,
      manualRowCount: 0,
      auditGroupCount: 0,
      finalSuccessGroupCount: 0,
      manualGroupCount: 0
    };
    const runId = store.createRun({
      monthKey: '2026-07',
      importId: imported.id,
      snapshot: { batches: [] },
      snapshotHash: 'snapshot-transaction-materialization'
    });
    const originalGetRun = store.getRun.bind(store);
    let materializedInsideTransaction = false;
    store.getRun = (monthKey, candidateRunId, openDb) => {
      materializedInsideTransaction = Boolean(openDb && openDb.isTransaction);
      return originalGetRun(monthKey, candidateRunId, openDb);
    };
    const finished = store.finishRun({
      monthKey: '2026-07',
      runId,
      summary,
      mailRows: [],
      manualRows: [],
      auditRows: [],
      operationReceipt: {
        actionKey: 'duplicate:run',
        operationKey: 'duplicate/run/receipt-owned-delete-guard',
        producerTaskRunId: 'task-duplicate-run-receipt-owned-delete-guard',
        phase: 'run-side-committed',
        importBundleId: imported.id,
        inputEvidenceHash: 'a'.repeat(64)
      }
    });
    assert.equal(materializedInsideTransaction, true);
    assert.equal(finished.status, 'success');
    assert.match(finished.resultDigest, /^[a-f0-9]{64}$/);
    assert.throws(
      () => store.deleteRun('2026-07', runId),
      (error) => error.code === 'DUPLICATE_RECEIPT_OWNED_RUN_DELETE_FORBIDDEN'
    );
    assert.equal(store.readCommittedResult('2026-07', runId).run.id, runId);

    const rollbackRunId = store.createRun({
      monthKey: '2026-07',
      importId: imported.id,
      snapshot: { batches: [] },
      snapshotHash: 'snapshot-map-fault'
    });
    store.getRun = (_monthKey, _candidateRunId, openDb) => {
      assert.equal(openDb.isTransaction, true, '可失败map必须发生在COMMIT之前');
      throw Object.assign(new Error('injected in-transaction map fault'), {
        code: 'INJECTED_RUN_MAP_FAULT'
      });
    };
    assert.throws(() => store.finishRun({
      monthKey: '2026-07',
      runId: rollbackRunId,
      summary,
      mailRows: [],
      manualRows: [],
      auditRows: [],
      operationReceipt: {
        actionKey: 'duplicate:run',
        operationKey: 'duplicate/run/map-fault-before-commit',
        producerTaskRunId: 'task-duplicate-run-map-fault-before-commit',
        phase: 'run-side-committed',
        importBundleId: imported.id,
        inputEvidenceHash: 'b'.repeat(64)
      }
    }), (error) => error.code === 'INJECTED_RUN_MAP_FAULT');
    store.getRun = originalGetRun;
    const rolledBack = store.getRun('2026-07', rollbackRunId);
    assert.equal(rolledBack.status, 'running');
    assert.equal(rolledBack.resultDigest, null);
    assert.equal(store.findOperationReceipt(
      'duplicate:run', 'duplicate/run/map-fault-before-commit'
    ), null);
    assert.equal(store.deleteRun('2026-07', rollbackRunId), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('重复入金导入违反 BizId 唯一约束时双文件事务整体回滚', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    await assert.rejects(() => createImportBundle(store, {
      bankRows: [
        { sourceOrdinal: 0, excelRowNumber: 2, bizId: 'DUP', fundType: 'Reversal', raw: {} },
        { sourceOrdinal: 1, excelRowNumber: 3, bizId: 'DUP', fundType: 'Inbound', raw: {} }
      ],
      documentRows: [{
        sourceOrdinal: 0, excelRowNumber: 2, businessOrderNo: 'O-1', businessOrderKey: 'O-1',
        userNo: 'U-1', accountNo: 'A-1', businessDepartment: 'BU-1'
      }]
    }), /UNIQUE/);
    const file = runDataStore.listSideDbFiles(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    )[0];
    const db = runDataStore.openExistingSideDb(file.path);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_imports').get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_bank_rows').get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM duplicate_inbound_match_document_rows').get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('单据流式写入中途失败时银行、单据和导入记录全部回滚', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    await assert.rejects(() => store.createImportBundle({
      monthKey: '2026-07',
      bank: {
        fileName: 'bank.xlsx',
        contentHash: 'bank-hash',
        rows: [{
          sourceOrdinal: 0,
          excelRowNumber: 2,
          bizId: 'B1',
          fundType: 'Reversal',
          raw: { BizId: 'B1' }
        }]
      },
      document: {
        fileName: 'document.xlsx',
        contentHash: 'document-hash'
      },
      writeDocumentRows: async (insertRow) => {
        insertRow({
          sourceOrdinal: 0,
          excelRowNumber: 2,
          businessOrderNo: 'O-1',
          businessOrderKey: 'O-1',
          userNo: 'U-1',
          accountNo: 'A-1',
          businessDepartment: 'BU-1'
        });
        throw new Error('injected document stream failure');
      }
    }), /injected document stream failure/);

    const file = runDataStore.listSideDbFiles(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    )[0];
    const db = runDataStore.openExistingSideDb(file.path);
    try {
      for (const table of [
        'duplicate_inbound_match_imports',
        'duplicate_inbound_match_bank_rows',
        'duplicate_inbound_match_document_rows'
      ]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('重复入金侧库删除失败时显式阻断清理', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  const originalDeleteSideDbByPath = runDataStore.deleteSideDbByPath;
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    await createImportBundle(store, {
      bankRows: [{
        sourceOrdinal: 0,
        excelRowNumber: 2,
        bizId: 'B1',
        fundType: 'Reversal',
        raw: { BizId: 'B1' }
      }],
      documentRows: []
    });
    runDataStore.deleteSideDbByPath = (filePath) => ({ deleted: false, path: filePath });
    assert.throws(() => store.clearAll(), /重复入金侧库回收失败/);
    assert.equal(
      runDataStore.listSideDbFiles(
        userDataDir,
        runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
      ).length,
      1
    );
  } finally {
    runDataStore.deleteSideDbByPath = originalDeleteSideDbByPath;
    for (const file of runDataStore.listSideDbFiles(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    )) {
      runDataStore.deleteSideDbByPath(file.path);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('重复入金侧库删除后无法校验文件状态时显式阻断清理', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  const originalLstatSync = fs.lstatSync;
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    await createImportBundle(store, {
      bankRows: [{
        sourceOrdinal: 0,
        excelRowNumber: 2,
        bizId: 'B1',
        fundType: 'Reversal',
        raw: { BizId: 'B1' }
      }],
      documentRows: []
    });
    const sideDbPath = runDataStore.listSideDbFiles(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    )[0].path;
    fs.lstatSync = (target, ...args) => {
      if (path.resolve(target) === path.resolve(sideDbPath)) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalLstatSync(target, ...args);
    };

    assert.throws(() => store.clearAll(), /重复入金侧库回收校验失败.*permission denied/);
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('重复入金启动回收会删除失去主库文件的 WAL/SHM 旁文件', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    const dir = runDataStore.moduleDir(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    );
    fs.mkdirSync(dir, { recursive: true });
    const basePath = path.join(dir, 'month-2026-07.sqlite');
    fs.writeFileSync(`${basePath}-wal`, 'orphan wal');
    fs.writeFileSync(`${basePath}-shm`, 'orphan shm');

    assert.deepEqual(store.clearAll(), { deletedFiles: 1 });
    assert.equal(fs.existsSync(`${basePath}-wal`), false);
    assert.equal(fs.existsSync(`${basePath}-shm`), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('重复入金启动回收遇到侧库目录读取失败时显式阻断', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-store-'));
  const originalReaddirSync = fs.readdirSync;
  try {
    const store = createDuplicateInboundMatchStore(userDataDir);
    const dir = runDataStore.moduleDir(
      userDataDir,
      runDataStore.MODULE_DUPLICATE_INBOUND_MATCH
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.readdirSync = (target, ...args) => {
      if (path.resolve(target) === path.resolve(dir)) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddirSync(target, ...args);
    };

    assert.throws(() => store.clearAll(), /重复入金侧库目录扫描失败.*permission denied/);
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
