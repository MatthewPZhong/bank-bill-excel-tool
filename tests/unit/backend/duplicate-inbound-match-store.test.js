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
      summary: { mailRowCount: 1, manualRowCount: 2 },
      mailRows: [{ sourceOrdinal: 0, output: { BillDate: '2026-07-01' } }],
      manualRows: [
        { groupOrder: 1, rowOrder: 1, reason: 'R2', raw: { BizId: 'B2' } },
        { groupOrder: 0, rowOrder: 0, reason: 'R1', raw: { BizId: 'B1' } }
      ]
    });

    const result = store.readResult('2026-07', runId);
    assert.equal(result.run.status, 'success');
    assert.deepEqual(result.mailRows, [{ BillDate: '2026-07-01' }]);
    assert.deepEqual(result.manualRows.map((row) => row.row.BizId), ['B1', 'B2']);
    assert.equal(runDataStore.listSideDbFiles(userDataDir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH).length, 1);

    assert.deepEqual(store.clearAll(), { deletedFiles: 1 });
    assert.equal(runDataStore.listSideDbFiles(userDataDir, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH).length, 0);
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
