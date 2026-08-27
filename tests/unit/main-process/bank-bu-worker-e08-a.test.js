'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const runDataStore = require('../../../src/backend/run-data-store');
const {
  ensureBankBuReconTablesSupport,
  ensureBankBuReconRunsSideDbPath,
  ensureBankBuReconRunIdentitySupport
} = require('../../../src/backend/database/migrations');
const {
  PENDING_GUANLI_DB_COLUMNS,
  BANK_DB_COLUMNS
} = require('../../../src/backend/bank-bu-recon-db/columns');
const { buildImportEvidence } = require('../../../src/main-process/bank-bu-worker/identity');
const { importCommittedDataset } = require('../../../src/main-process/bank-bu-worker/side-database');
const { executeRun } = require('../../../src/main-process/bank-bu-worker/run-operation');
const { executeExportSingle } = require('../../../src/main-process/bank-bu-worker/export-operation');
const {
  captureMirrorPreimage
} = require('../../../src/main-process/bank-bu-worker/mirror-repository');
const {
  completeMirrorFromCommittedSide,
  inspectImportOutcome,
  inspectRunOutcome
} = require('../../../src/main-process/bank-bu-worker/outcome-inspector');
const {
  createBankBuMainCoordinator
} = require('../../../src/main-process/bank-bu-worker/main-coordinator');

function pending(reconId, bu, rowIndex) {
  const row = { _rowIndex: rowIndex };
  for (const column of PENDING_GUANLI_DB_COLUMNS) row[column] = '';
  row.recon_id = reconId;
  row.finance_bu = bu;
  row.amount = '100';
  row.currency = 'USD';
  return row;
}

function bank(reconId, bu, rowIndex) {
  const row = { _rowIndex: rowIndex };
  for (const column of BANK_DB_COLUMNS) row[column] = '';
  row.reconciliation_id = reconId;
  row.remark_bu = bu;
  row.credit_amount = '100';
  return row;
}

function mainDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  ensureBankBuReconTablesSupport(db);
  ensureBankBuReconRunsSideDbPath(db);
  ensureBankBuReconRunIdentitySupport(db);
  return db;
}

function importMonth(userDataDir, yearMonth = '2026-08', operationKey = 'bank-bu/import/1') {
  const pendingRows = [pending('R1', 'BU-A', 2), pending('R2', 'BU-X', 4)];
  const bankRows = [bank('R1', 'bu-a', 3), bank('R2', 'BU-Y', 8)];
  const evidence = buildImportEvidence({
    yearMonth,
    pendingFileSha256: '1'.repeat(64),
    bankFileSha256: '2'.repeat(64),
    pendingRows,
    bankRows
  });
  return importCommittedDataset({
    userDataDir, yearMonth, pendingRows, bankRows, evidence,
    operationIdentity: {
      actionKey: 'bank-bu:import-month', operationKey, producerTaskRunId: `task-${operationKey}`
    }
  });
}

function criticalEvidence(preimage, inputEvidenceHash, operationKey = 'bank-bu/run/1') {
  return Object.freeze({
    yearMonth: '2026-08',
    operationKey,
    producerTaskRunId: `task-${operationKey}`,
    inputEvidenceHash,
    preimage
  });
}

test('旧BankBU side DB additive ensure补齐managed schema且不改旧业务行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-old-'));
  try {
    const filePath = runDataStore.sideDbPath(dir, runDataStore.MODULE_BANK_BU, '2026-08');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const old = new DatabaseSync(filePath);
    old.exec(runDataStore.SIDE_DB_DDL_BANK_BU
      .replace(',\n    operation_key TEXT,\n    producer_task_run_id TEXT,\n    input_evidence_hash TEXT', '')
      .replace(/\n  CREATE TABLE IF NOT EXISTS bank_bu_dataset_evidence \([\s\S]*?\n  \);\n/, '\n'));
    old.prepare(`INSERT INTO bank_bu_recon_runs (
      year_month,status,pending_total,bank_total,matched_count,bu_diff_count,
      pending_unmatched,bank_unmatched,anomaly_count
    ) VALUES ('2026-08','success',1,1,2,0,0,0,0)`).run();
    old.close();

    const upgraded = runDataStore.openSideDb(dir, runDataStore.MODULE_BANK_BU, '2026-08');
    const columns = new Set(upgraded.prepare('PRAGMA table_info(bank_bu_recon_runs)').all()
      .map((column) => column.name));
    assert.ok(columns.has('operation_key'));
    assert.ok(columns.has('producer_task_run_id'));
    assert.ok(columns.has('input_evidence_hash'));
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count, 1);
    assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE name='bank_bu_dataset_evidence'").get());
    upgraded.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dataset evidence绑定source行号、原始顺序、BU、账号、金额与币种血缘', () => {
  const pendingRows = [pending('R1', 'BU-A', 2), pending('R2', 'BU-B', 3)];
  pendingRows[0].account_no = 'ACC-1';
  const bankRows = [bank('R1', 'BU-A', 2), bank('R2', 'BU-B', 3)];
  bankRows[0].currency = 'USD';
  const build = (nextPending = pendingRows, nextBank = bankRows) => buildImportEvidence({
    yearMonth: '2026-08', pendingFileSha256: '1'.repeat(64),
    bankFileSha256: '2'.repeat(64), pendingRows: nextPending, bankRows: nextBank
  }).datasetHash;
  const original = build();
  assert.notEqual(build(pendingRows.slice().reverse()), original, '原始顺序变化必须改变evidence');
  assert.notEqual(build(pendingRows.map((row, index) => ({
    ...row, _rowIndex: index === 0 ? 9 : row._rowIndex
  }))), original, 'source row index变化必须改变evidence');
  assert.notEqual(build(pendingRows.map((row, index) => ({
    ...row, finance_bu: index === 0 ? 'BU-X' : row.finance_bu
  }))), original, 'BU变化必须改变evidence');
  assert.notEqual(build(pendingRows.map((row, index) => ({
    ...row, account_no: index === 0 ? 'ACC-2' : row.account_no
  }))), original, '账号变化必须改变evidence');
  assert.notEqual(build(pendingRows.map((row, index) => ({
    ...row, amount: index === 0 ? '100.01' : row.amount
  }))), original, '金额变化必须改变evidence');
  assert.notEqual(build(pendingRows, bankRows.map((row, index) => ({
    ...row, currency: index === 0 ? 'CNY' : row.currency
  }))), original, '币种变化必须改变evidence');
});

test('import fixed Pending→Bank顺序、dataset evidence与receipt同事务，失败回滚旧dataset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-import-'));
  try {
    const committed = importMonth(dir);
    assert.equal(committed.pendingCount, 2);
    assert.equal(committed.bankCount, 2);
    const db = runDataStore.openSideDb(dir, runDataStore.MODULE_BANK_BU, '2026-08');
    assert.deepEqual(
      db.prepare('SELECT row_index FROM bank_bu_recon_pending_imports ORDER BY id').all()
        .map((row) => Number(row.row_index)),
      [2, 4]
    );
    assert.deepEqual(
      db.prepare('SELECT row_index FROM bank_bu_recon_bank_imports ORDER BY id').all()
        .map((row) => Number(row.row_index)),
      [3, 8]
    );
    const before = db.prepare('SELECT dataset_hash FROM bank_bu_dataset_evidence').get().dataset_hash;
    db.close();

    const pendingRows = [pending('BROKEN', 'BU', 99)];
    const bankRows = [bank('BROKEN', 'BU', 99)];
    assert.throws(() => importCommittedDataset({
      userDataDir: dir,
      yearMonth: '2026-08',
      pendingRows,
      bankRows,
      evidence: {
        pending: { rowCount: 1 }, bank: { rowCount: 1 },
        pendingEvidenceHash: '3'.repeat(64), bankEvidenceHash: '4'.repeat(64),
        datasetHash: 'not-a-hash'
      },
      operationIdentity: {
        actionKey: 'bank-bu:import-month', operationKey: 'bank-bu/import/broken',
        producerTaskRunId: 'task-bank-bu-import-broken'
      }
    }), /SHA-256/);
    const after = runDataStore.openSideDb(dir, runDataStore.MODULE_BANK_BU, '2026-08');
    assert.equal(after.prepare('SELECT dataset_hash FROM bank_bu_dataset_evidence').get().dataset_hash, before);
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_pending_imports').get().count, 2);
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_bank_imports').get().count, 2);
    after.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('import Inspector只接受完整operation identity与input evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-import-inspect-'));
  try {
    const committed = importMonth(dir);
    const identity = {
      userDataDir: dir,
      yearMonth: '2026-08',
      operationKey: 'bank-bu/import/1',
      producerTaskRunId: 'task-bank-bu/import/1',
      inputEvidenceHash: committed.datasetHash
    };
    assert.equal(inspectImportOutcome(identity).outcome, 'committed');
    assert.equal(inspectImportOutcome({
      ...identity, inputEvidenceHash: 'f'.repeat(64)
    }).outcome, 'unknown');
    assert.equal(inspectImportOutcome({
      ...identity, operationKey: 'bank-bu/import/absent'
    }).outcome, 'not-committed');
    const newer = importMonth(dir, '2026-08', 'bank-bu/import/2');
    assert.equal(inspectImportOutcome(identity).outcome, 'unknown',
      '历史receipt不能把已被新import覆盖的dataset误判为当前committed');
    assert.equal(inspectImportOutcome({
      ...identity,
      operationKey: 'bank-bu/import/2',
      producerTaskRunId: 'task-bank-bu/import/2',
      inputEvidenceHash: newer.datasetHash
    }).outcome, 'committed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run side receipt先提交；exact replay不新增side run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-run-'));
  try {
    importMonth(dir);
    const identity = {
      actionKey: 'bank-bu:run', operationKey: 'bank-bu/run/1', producerTaskRunId: 'task-bank-bu/run/1'
    };
    let criticalCount = 0;
    const first = await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
      operationIdentity: identity,
      async awaitCritical(value) { criticalCount += 1; assert.equal(value.yearMonth, '2026-08'); }
    });
    assert.equal(first.replay, false);
    assert.equal(first.stats.matchedCount, 4);
    const replay = await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
      operationIdentity: identity,
      async awaitCritical() { criticalCount += 1; }
    });
    assert.equal(replay.replay, true);
    assert.equal(replay.sideRunId, first.sideRunId);
    assert.equal(criticalCount, 1, 'committed replay不再进入critical/算法路径');
    const side = runDataStore.openSideDb(dir, runDataStore.MODULE_BANK_BU, '2026-08');
    assert.equal(side.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count, 1);
    assert.equal(side.prepare("SELECT COUNT(*) AS count FROM bank_bu_operation_receipts WHERE action_key='bank-bu:run'").get().count, 1);
    side.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Inspector唯一判定not/partial/committed；partial complete-mirror不重跑算法', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-inspect-'));
  const mainPath = path.join(dir, 'tool-data.sqlite');
  const mainDb = mainDatabase(mainPath);
  try {
    const imported = importMonth(dir);
    const preimage = captureMirrorPreimage(mainDb, '2026-08');
    const evidence = criticalEvidence(preimage, imported.datasetHash);
    assert.equal(inspectRunOutcome({ mainDb, userDataDir: dir, criticalEvidence: evidence }).outcome, 'not-committed');
    const run = await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
      operationIdentity: {
        actionKey: 'bank-bu:run', operationKey: evidence.operationKey,
        producerTaskRunId: evidence.producerTaskRunId
      },
      async awaitCritical() {}
    });
    const partial = inspectRunOutcome({ mainDb, userDataDir: dir, criticalEvidence: evidence });
    assert.equal(partial.outcome, 'partially-committed');
    const completed = completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: evidence
    });
    assert.equal(completed.outcome, 'committed');
    assert.equal(completed.mirror.operationKey, evidence.operationKey);
    assert.equal(completed.mirror.sideRunId, run.sideRunId);
    assert.equal(inspectRunOutcome({ mainDb, userDataDir: dir, criticalEvidence: evidence }).outcome, 'committed');
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count, 1);
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('side commit后Main mirror并发变化进入unknown且complete-mirror不覆盖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-cas-'));
  const mainDb = mainDatabase(path.join(dir, 'tool-data.sqlite'));
  try {
    const imported = importMonth(dir);
    const preimage = captureMirrorPreimage(mainDb, '2026-08');
    const evidence = criticalEvidence(preimage, imported.datasetHash, 'bank-bu/run/cas');
    await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
      operationIdentity: {
        actionKey: 'bank-bu:run', operationKey: evidence.operationKey,
        producerTaskRunId: evidence.producerTaskRunId
      },
      async awaitCritical() {}
    });
    mainDb.prepare(`INSERT INTO bank_bu_recon_runs (
      year_month,status,pending_total,bank_total,matched_count,bu_diff_count,
      pending_unmatched,bank_unmatched,anomaly_count,side_db_rel_path
    ) VALUES ('2026-08','success',9,9,0,0,9,9,0,'concurrent.sqlite')`).run();
    const inspected = inspectRunOutcome({ mainDb, userDataDir: dir, criticalEvidence: evidence });
    assert.equal(inspected.outcome, 'unknown');
    const recovered = completeMirrorFromCommittedSide({ mainDb, userDataDir: dir, criticalEvidence: evidence });
    assert.equal(recovered.outcome, 'unknown');
    assert.equal(mainDb.prepare('SELECT side_db_rel_path FROM bank_bu_recon_runs').get().side_db_rel_path, 'concurrent.sqlite');
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('有界old mirror pre-image可由已提交side结果CAS替换且不重跑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-old-mirror-'));
  const mainDb = mainDatabase(path.join(dir, 'tool-data.sqlite'));
  try {
    const imported = importMonth(dir);
    mainDb.prepare(`INSERT INTO bank_bu_recon_runs (
      year_month,status,pending_total,bank_total,matched_count,bu_diff_count,
      pending_unmatched,bank_unmatched,anomaly_count,side_db_rel_path
    ) VALUES ('2026-08','success',1,1,1,0,0,0,0,'legacy.sqlite')`).run();
    const preimage = captureMirrorPreimage(mainDb, '2026-08');
    assert.equal(preimage.expectedPreviousMirror.sideDbRelPath, 'legacy.sqlite');
    const evidence = criticalEvidence(
      preimage, imported.datasetHash, 'bank-bu/run/old-mirror'
    );
    const run = await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
      operationIdentity: {
        actionKey: 'bank-bu:run', operationKey: evidence.operationKey,
        producerTaskRunId: evidence.producerTaskRunId
      },
      async awaitCritical() {}
    });
    assert.equal(inspectRunOutcome({
      mainDb, userDataDir: dir, criticalEvidence: evidence
    }).outcome, 'partially-committed');
    const completed = completeMirrorFromCommittedSide({
      mainDb, userDataDir: dir, criticalEvidence: evidence
    });
    assert.equal(completed.outcome, 'committed');
    assert.equal(completed.mirror.sideRunId, run.sideRunId);
    assert.equal(completed.mirror.operationKey, evidence.operationKey);
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS count FROM bank_bu_recon_runs').get().count, 1);
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export Worker拒绝FilePlan stagingRoot之外的正式路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-staging-'));
  try {
    await assert.rejects(executeExportSingle({
      userDataDir: dir,
      mainDatabasePath: path.join(dir, 'tool-data.sqlite'),
      stagingRoot: path.join(dir, 'staging'),
      stagingPath: path.join(dir, 'exports', 'formal.xlsx'),
      runId: 1
    }), /不属于task-private stagingRoot/);
    assert.equal(fs.existsSync(path.join(dir, 'exports', 'formal.xlsx')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Main coordinator在operation lock内capture并持久化pre-image后才允许critical ACK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-coordinator-'));
  const mainDb = mainDatabase(path.join(dir, 'tool-data.sqlite'));
  let locked = false;
  let persisted = false;
  try {
    const imported = importMonth(dir);
    const coordinator = createBankBuMainCoordinator({
      mainDb,
      async withOperationLock(yearMonth, work) {
        assert.equal(yearMonth, '2026-08');
        assert.equal(locked, false);
        locked = true;
        try { return await work(); } finally { locked = false; }
      },
      async persistCriticalIntent(evidence) {
        assert.equal(locked, true, 'capture+persist必须共享operation lock');
        assert.equal(evidence.preimage.expectedPreviousMirror, null);
        assert.match(evidence.preimage.expectedPreviousMirrorHash, /^[a-f0-9]{64}$/);
        persisted = true;
        return { intentId: 'intent-bank-bu-coordinator' };
      }
    });
    const identity = {
      yearMonth: '2026-08', userDataDir: dir,
      operationKey: 'bank-bu/run/coordinator',
      producerTaskRunId: 'task-bank-bu-run-coordinator'
    };
    const settled = await coordinator.withRunOperationLock(identity, async ({
      prepareCritical, settleRun
    }) => {
      assert.equal(locked, true, 'operation lock应覆盖整个run callback');
      await executeRun({ userDataDir: dir, yearMonth: '2026-08' }, {
        operationIdentity: { actionKey: 'bank-bu:run', ...identity },
        async awaitCritical(critical) {
          const ack = await prepareCritical(critical);
          assert.equal(ack.intentId, 'intent-bank-bu-coordinator');
        }
      });
      assert.equal(locked, true, 'side COMMIT后、Main CAS前仍持有operation lock');
      return settleRun();
    });
    assert.equal(persisted, true);
    assert.equal(settled.replay, false);
    assert.equal(settled.mirror.inputEvidenceHash, imported.datasetHash);
    assert.equal(locked, false);
  } finally {
    mainDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
