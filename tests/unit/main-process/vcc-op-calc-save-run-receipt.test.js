'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const { ensureVccOpCalcTablesSupport } = require('../../../src/backend/database/migrations');
const { AppDatabase } = require('../../../src/backend/database');
const { computeAmounts } = require('../../../src/main-process/vcc-op-calc-session');
const {
  VCC_OP_SAVE_RUN_ACTION_KEY,
  VCC_OP_SAVE_RUN_MODULE_ID,
  VCC_OP_SAVE_RUN_TASK_KEY,
  VccOpSaveRunContractError,
  hashVccOpComputeSnapshot,
  inspectVccOpSaveRunEvidence,
  saveVccOpRunWithReceipt
} = require('../../../src/main-process/vcc-op-calc/save-run-contract');
const {
  VCC_OP_SAVE_RUN_INSPECTOR_KEY,
  createVccOpSaveRunInspector,
  inspectVccOpSaveRunOutcome
} = require('../../../src/main-process/vcc-op-calc/save-run-inspector');
const {
  createInspectorRegistry
} = require('../../../src/main-process/background-execution/inspector-registry');
const {
  normalizeRecoveryInspectionResult
} = require('../../../src/main-process/background-execution/recovery-source');

function flowRow(direction, amount, billDate = '2026-03-15', currency = 'CNY') {
  return { direction, recon_amount: amount, bill_date_raw: billDate, currency };
}

function snapshotFor(options = {}) {
  const month = options.month || '2026-03';
  const currency = options.currency || 'CNY';
  const files = options.files || [
    {
      fileName: 'vcc-a.xlsx',
      rows: [
        flowRow('入', '100.10', `${month}-15`, currency),
        flowRow('出', '20.05', `${month}-16`, currency)
      ]
    },
    {
      fileName: 'vcc-b.xlsx',
      rows: [flowRow('入', '0.20', `${month}-17`, currency)]
    }
  ];
  const result = computeAmounts(files);
  assert.equal(result.ok, true);
  return {
    yearMonth: result.yearMonth,
    totals: result.totals,
    perFile: result.perFile
  };
}

function operationOwner(label = 'default', overrides = {}) {
  return {
    taskRunId: `vcc-save-task-${label}`,
    taskKey: VCC_OP_SAVE_RUN_TASK_KEY,
    moduleId: VCC_OP_SAVE_RUN_MODULE_ID,
    parentRunId: `vcc-parent-${label}`,
    operationKey: `vcc-save-operation-${label}`,
    ...overrides
  };
}

function openDb(dbPath = ':memory:', options = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (options.migrate !== false) ensureVccOpCalcTablesSupport(db);
  return db;
}

function counts(db) {
  return {
    runs: db.prepare('SELECT COUNT(*) AS count FROM vcc_op_calc_runs').get().count,
    files: db.prepare('SELECT COUNT(*) AS count FROM vcc_op_calc_run_files').get().count,
    receipts: db.prepare('SELECT COUNT(*) AS count FROM vcc_op_operation_receipts').get().count
  };
}

function expectedIdentity(snapshot, owner, beginOp = '1000.00', overrides = {}) {
  const hashed = hashVccOpComputeSnapshot(snapshot);
  return {
    actionKey: VCC_OP_SAVE_RUN_ACTION_KEY,
    operationKey: owner.operationKey,
    taskRunId: owner.taskRunId,
    computeSnapshotHash: hashed.computeSnapshotHash,
    yearMonth: hashed.yearMonth,
    inputFileCount: hashed.inputFileCount,
    beginOp,
    ...overrides
  };
}

function recoverySource(snapshot, owner, beginOp = '1000.00', overrides = {}) {
  const expected = expectedIdentity(snapshot, owner, beginOp);
  const source = {
    contractVersion: 1,
    sourceKind: 'critical-intent',
    sourceRef: `vcc-save-intent-${owner.operationKey}`,
    actionKey: VCC_OP_SAVE_RUN_ACTION_KEY,
    operationKey: owner.operationKey,
    taskRunId: owner.taskRunId,
    conflictScopeKey: `vcc-op:month:${expected.yearMonth}`,
    inspectorKey: VCC_OP_SAVE_RUN_INSPECTOR_KEY,
    settlementKey: null,
    intentId: `vcc-save-intent-${owner.operationKey}`,
    evidenceVersion: 1,
    boundedEvidence: {
      computeSnapshotHash: expected.computeSnapshotHash,
      yearMonth: expected.yearMonth,
      inputFileCount: expected.inputFileCount,
      beginOp: expected.beginOp
    },
    ...overrides
  };
  return source;
}

function save(db, snapshot, owner, options = {}) {
  return saveVccOpRunWithReceipt({
    db,
    computeSnapshot: snapshot,
    beginOp: options.beginOp || '1000.00',
    operationOwner: owner,
    injectFault: options.injectFault
  });
}

function withTempDb(t, prefix = 'vcc-save-receipt-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dbPath;
}

test('migration 对旧 VCC DB 加法升级，FK 指向真实 run 表且可重复启动', (t) => {
  const dbPath = withTempDb(t, 'vcc-save-migration-');
  const legacyDb = openDb(dbPath, { migrate: false });
  legacyDb.exec(`
    CREATE TABLE vcc_op_calc_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year_month TEXT NOT NULL,
      run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      file_count INTEGER NOT NULL,
      total_amount_out TEXT NOT NULL,
      total_amount_in TEXT NOT NULL,
      total_amount TEXT NOT NULL,
      begin_op TEXT NOT NULL,
      end_op TEXT NOT NULL,
      currency TEXT
    );
    CREATE TABLE vcc_op_calc_run_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      amount_out TEXT NOT NULL,
      amount_in TEXT NOT NULL,
      amount TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES vcc_op_calc_runs(id)
    );
    INSERT INTO vcc_op_calc_runs (
      year_month, file_count, total_amount_out, total_amount_in,
      total_amount, begin_op, end_op, currency
    ) VALUES ('2025-12', 1, '0.00', '1.00', '1.00', '9.00', '10.00', 'CNY');
    INSERT INTO vcc_op_calc_run_files (
      run_id, file_name, row_count, amount_out, amount_in, amount
    ) VALUES (1, 'legacy.xlsx', 1, '0.00', '1.00', '1.00');
  `);
  legacyDb.close();

  const firstStartup = new AppDatabase(dbPath);
  try {
    firstStartup.init();
  } finally {
    firstStartup.close();
  }
  const restarted = new AppDatabase(dbPath);
  try {
    restarted.init();
    const db = restarted.db;

    assert.equal(db.prepare('SELECT file_name FROM vcc_op_calc_run_files WHERE run_id = 1').get().file_name, 'legacy.xlsx');
    const columns = db.prepare("PRAGMA table_info('vcc_op_operation_receipts')").all();
    assert.deepEqual(columns.map((column) => column.name), [
      'id',
      'action_key',
      'operation_key',
      'producer_task_run_id',
      'run_id',
      'year_month',
      'compute_snapshot_hash',
      'input_file_count',
      'committed_at'
    ]);
    assert.equal(db.prepare("PRAGMA foreign_key_list('vcc_op_operation_receipts')").get().table, 'vcc_op_calc_runs');
    const uniqueIndex = db.prepare("PRAGMA index_list('vcc_op_operation_receipts')").all()
      .find((index) => index.unique === 1);
    assert.ok(uniqueIndex);
    assert.deepEqual(
      db.prepare(`PRAGMA index_info('${uniqueIndex.name}')`).all().map((column) => column.name),
      ['action_key', 'operation_key']
    );
    const runIdIndex = db.prepare("PRAGMA index_list('vcc_op_operation_receipts')").all()
      .find((index) => index.name === 'idx_vcc_op_operation_receipts_run_id');
    assert.ok(runIdIndex);
    assert.equal(runIdIndex.unique, 0, 'run_id 只优化 Inspector 反查，不升级为唯一合同');
    assert.deepEqual(
      db.prepare(`PRAGMA index_info('${runIdIndex.name}')`).all().map((column) => column.name),
      ['run_id']
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    restarted.close();
  }
});

test('3.2.0 TechDoc Receipt FK 使用真实物理 run 表名', () => {
  const techdoc = fs.readFileSync(path.resolve(
    __dirname,
    '../../../changes/background-execution-v3.2.x-contract-baseline/changes/3.2.0/techdoc.md'
  ), 'utf8');
  assert.match(
    techdoc,
    /FOREIGN KEY\s*\(\s*run_id\s*\)\s+REFERENCES\s+vcc_op_calc_runs\s*\(\s*id\s*\)/
  );
  assert.doesNotMatch(techdoc, /REFERENCES\s+vcc_op_runs\s*\(/);
});

test('save 只接受 exact Main Task owner，缺失或 Renderer 式扩展字段均 fail closed', () => {
  const db = openDb();
  const snapshot = snapshotFor();
  assert.throws(
    () => save(db, snapshot, null),
    (error) => error instanceof VccOpSaveRunContractError
      && error.code === 'VCC_OP_SAVE_RUN_OWNER_INVALID'
  );
  assert.throws(
    () => save(db, snapshot, { ...operationOwner('renderer'), actionKey: VCC_OP_SAVE_RUN_ACTION_KEY }),
    (error) => error instanceof VccOpSaveRunContractError
      && error.code === 'VCC_OP_SAVE_RUN_OWNER_INVALID'
  );
  assert.deepEqual(counts(db), { runs: 0, files: 0, receipts: 0 });
  db.close();
});

test('run/files/receipt 同事务 golden 保留资金口径，receipt 不泄露 snapshot 或路径', () => {
  const db = openDb();
  const snapshot = snapshotFor();
  const owner = operationOwner('golden');
  const result = save(db, snapshot, owner);

  assert.deepEqual(result, {
    runId: 1,
    endOp: '1080.25',
    beginOp: '1000.00',
    yearMonth: '2026-03',
    outcome: 'committed'
  });
  const run = db.prepare('SELECT * FROM vcc_op_calc_runs WHERE id = 1').get();
  assert.equal(run.file_count, 2);
  assert.equal(run.total_amount_out, '20.05');
  assert.equal(run.total_amount_in, '100.30');
  assert.equal(run.total_amount, '80.25');
  assert.equal(run.begin_op, '1000.00');
  assert.equal(run.end_op, '1080.25');
  assert.equal(run.currency, 'CNY');
  const files = db.prepare('SELECT * FROM vcc_op_calc_run_files ORDER BY id').all();
  assert.deepEqual(files.map((file) => ({
    name: file.file_name,
    rows: file.row_count,
    out: file.amount_out,
    in: file.amount_in,
    amount: file.amount
  })), [
    { name: 'vcc-a.xlsx', rows: 2, out: '20.05', in: '100.10', amount: '80.05' },
    { name: 'vcc-b.xlsx', rows: 1, out: '0.00', in: '0.20', amount: '0.20' }
  ]);
  const receipt = db.prepare('SELECT * FROM vcc_op_operation_receipts').get();
  assert.equal(receipt.action_key, VCC_OP_SAVE_RUN_ACTION_KEY);
  assert.equal(receipt.operation_key, owner.operationKey);
  assert.equal(receipt.producer_task_run_id, owner.taskRunId);
  assert.equal(receipt.run_id, result.runId);
  assert.equal(receipt.year_month, snapshot.yearMonth);
  assert.equal(receipt.input_file_count, snapshot.perFile.length);
  assert.match(receipt.compute_snapshot_hash, /^[a-f0-9]{64}$/);
  assert.match(receipt.committed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(JSON.stringify(receipt).includes('vcc-a.xlsx'), false);
  assert.equal(JSON.stringify(result).includes('computeSnapshotHash'), false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('receipt INSERT 失败会回滚 run 和全部资金明细', () => {
  const db = openDb();
  db.exec(`
    CREATE TRIGGER reject_vcc_receipt
    BEFORE INSERT ON vcc_op_operation_receipts
    BEGIN
      SELECT RAISE(ABORT, 'receipt write rejected');
    END;
  `);
  assert.throws(
    () => save(db, snapshotFor(), operationOwner('receipt-failure')),
    /receipt write rejected/
  );
  assert.deepEqual(counts(db), { runs: 0, files: 0, receipts: 0 });
  db.close();
});

for (const faultStage of ['after-begin', 'after-run-insert', 'before-receipt-insert', 'after-receipt-insert']) {
  test(`fault ${faultStage} 在 COMMIT 前完整回滚`, () => {
    const db = openDb();
    assert.throws(
      () => save(db, snapshotFor(), operationOwner(faultStage), {
        injectFault(stage) {
          if (stage === faultStage) throw new Error(`fault:${stage}`);
        }
      }),
      new RegExp(`fault:${faultStage}`)
    );
    assert.deepEqual(counts(db), { runs: 0, files: 0, receipts: 0 });
    db.close();
  });
}

test('同 operation 重启 replay 返回相同 runId 且 exactly-one run/receipt', (t) => {
  const dbPath = withTempDb(t, 'vcc-save-replay-');
  const snapshot = snapshotFor();
  const owner = operationOwner('restart');
  const firstDb = openDb(dbPath);
  const first = save(firstDb, snapshot, owner);
  firstDb.close();

  const restartedDb = openDb(dbPath);
  const replay = save(restartedDb, snapshot, owner);
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.outcome, 'recovered-existing-commit');
  assert.deepEqual(counts(restartedDb), { runs: 1, files: 2, receipts: 1 });
  restartedDb.close();
});

test('同 operation 的 hash/task/month/fileCount/opening balance 冲突全部 unknown，且不新增资金行', async (t) => {
  const cases = [
    {
      label: 'snapshot-hash',
      mutate: ({ owner }) => ({
        owner,
        snapshot: snapshotFor({
          files: [{ fileName: 'changed.xlsx', rows: [flowRow('入', '1.00')] }]
        })
      })
    },
    {
      label: 'task-run-id',
      mutate: ({ snapshot, owner }) => ({
        snapshot,
        owner: { ...owner, taskRunId: 'another-task-run' }
      })
    },
    {
      label: 'year-month',
      mutate: ({ owner }) => ({ snapshot: snapshotFor({ month: '2026-04' }), owner })
    },
    {
      label: 'file-count',
      mutate: ({ owner }) => ({
        owner,
        snapshot: snapshotFor({
          files: [{ fileName: 'single.xlsx', rows: [flowRow('入', '80.25')] }]
        })
      })
    },
    {
      label: 'begin-op',
      beginOp: '999.00',
      mutate: ({ snapshot, owner }) => ({ snapshot, owner })
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, () => {
      const db = openDb();
      const snapshot = snapshotFor();
      const owner = operationOwner(`conflict-${scenario.label}`);
      save(db, snapshot, owner);
      const changed = scenario.mutate({ snapshot, owner });
      assert.throws(
        () => save(db, changed.snapshot, changed.owner, { beginOp: scenario.beginOp || '1000.00' }),
        (error) => error instanceof VccOpSaveRunContractError
          && error.code === 'VCC_OP_SAVE_RUN_OUTCOME_UNKNOWN'
          && error.outcome === 'unknown'
          && error.recoveryRequired === true
          && error.preserveArchiveTaskRun === true
      );
      assert.deepEqual(counts(db), { runs: 1, files: 2, receipts: 1 });
      db.close();
    });
  }
});

test('无 receipt 时不按同月旧 run 猜测，Inspector 返回 exact not-committed 且只读', () => {
  const db = openDb();
  db.prepare(`
    INSERT INTO vcc_op_calc_runs (
      year_month, file_count, total_amount_out, total_amount_in,
      total_amount, begin_op, end_op, currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('2026-03', 1, '0.00', '1.00', '1.00', '9.00', '10.00', 'CNY');
  db.prepare(`
    INSERT INTO vcc_op_calc_run_files (
      run_id, file_name, row_count, amount_out, amount_in, amount
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(1, 'legacy.xlsx', 1, '0.00', '1.00', '1.00');
  const source = recoverySource(snapshotFor(), operationOwner('not-committed'));
  const before = db.prepare('SELECT total_changes() AS value').get().value;
  db.exec('PRAGMA query_only = ON');
  const result = inspectVccOpSaveRunOutcome({ db, ...source });
  const normalized = normalizeRecoveryInspectionResult(source, result);
  const after = db.prepare('SELECT total_changes() AS value').get().value;
  assert.equal(normalized.outcome, 'not-committed');
  assert.equal(normalized.boundedEvidence.receiptCount, 0);
  assert.equal(normalized.boundedEvidence.operationEvidencePresent, false);
  assert.equal(before, after);
  assert.equal(counts(db).runs, 1);
  db.close();
});

test('Inspector 仅在 receipt/run/files/hash/task/month/fileCount/opening balance 全一致时 committed', async (t) => {
  const snapshot = snapshotFor();
  const owner = operationOwner('inspect-committed');
  const db = openDb();
  const saved = save(db, snapshot, owner);
  const source = recoverySource(snapshot, owner);
  const committed = inspectVccOpSaveRunOutcome({ db, ...source });
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.boundedEvidence.runId, saved.runId);

  const conflicts = [
    { label: 'task', source: { ...source, taskRunId: 'wrong-task' } },
    {
      label: 'hash',
      source: {
        ...source,
        boundedEvidence: { ...source.boundedEvidence, computeSnapshotHash: 'f'.repeat(64) }
      }
    },
    {
      label: 'month',
      source: {
        ...source,
        boundedEvidence: { ...source.boundedEvidence, yearMonth: '2026-04' }
      }
    },
    {
      label: 'file-count',
      source: {
        ...source,
        boundedEvidence: { ...source.boundedEvidence, inputFileCount: 1 }
      }
    },
    {
      label: 'begin-op',
      source: {
        ...source,
        boundedEvidence: { ...source.boundedEvidence, beginOp: '999.00' }
      }
    }
  ];
  for (const conflict of conflicts) {
    await t.test(conflict.label, () => {
      assert.equal(inspectVccOpSaveRunOutcome({ db, ...conflict.source }).outcome, 'unknown');
    });
  }
  assert.throws(
    () => inspectVccOpSaveRunOutcome({ db, ...source, evidenceVersion: 2 }),
    (error) => error && error.code === 'VCC_OP_SAVE_RUN_INSPECTOR_SOURCE_MISMATCH'
  );
  assert.deepEqual(counts(db), { runs: 1, files: 2, receipts: 1 });
  db.close();
});

test('receipt 孤儿、同 run 多 receipt、缺文件和金额破坏均 fail closed 为 unknown', async (t) => {
  const scenarios = [
    {
      label: 'orphan-receipt',
      corrupt(db, saved) {
        db.exec('PRAGMA foreign_keys = OFF');
        db.prepare('DELETE FROM vcc_op_calc_runs WHERE id = ?').run(saved.runId);
        db.exec('PRAGMA foreign_keys = ON');
      }
    },
    {
      label: 'multiple-receipts-for-run',
      corrupt(db, saved) {
        db.prepare(`
          INSERT INTO vcc_op_operation_receipts (
            action_key, operation_key, producer_task_run_id, run_id,
            year_month, compute_snapshot_hash, input_file_count, committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          VCC_OP_SAVE_RUN_ACTION_KEY,
          'another-operation-on-same-run',
          'another-task',
          saved.runId,
          '2026-03',
          'a'.repeat(64),
          2,
          '2026-03-01T00:00:00.000Z'
        );
      }
    },
    {
      label: 'missing-run-file',
      corrupt(db, saved) {
        db.prepare('DELETE FROM vcc_op_calc_run_files WHERE run_id = ? AND id = (SELECT MAX(id) FROM vcc_op_calc_run_files WHERE run_id = ?)').run(saved.runId, saved.runId);
      }
    },
    {
      label: 'amount-corruption',
      corrupt(db, saved) {
        db.prepare(`
          UPDATE vcc_op_calc_run_files
          SET amount = '999.00'
          WHERE id = (
            SELECT MIN(id) FROM vcc_op_calc_run_files WHERE run_id = ?
          )
        `).run(saved.runId);
      }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.label, () => {
      const db = openDb();
      const snapshot = snapshotFor();
      const owner = operationOwner(`corrupt-${scenario.label}`);
      const saved = save(db, snapshot, owner);
      scenario.corrupt(db, saved);
      const inspected = inspectVccOpSaveRunOutcome({
        db,
        ...recoverySource(snapshot, owner)
      });
      assert.equal(inspected.outcome, 'unknown');
      assert.notEqual(inspected.boundedEvidence.reasonCode, null);
      db.close();
    });
  }
});

test('COMMIT 后响应丢失：新连接 Inspector 查到同一 runId，随后重放不再插入', (t) => {
  const dbPath = withTempDb(t, 'vcc-save-after-commit-');
  const snapshot = snapshotFor();
  const owner = operationOwner('lost-response');
  const writingDb = openDb(dbPath);
  assert.throws(
    () => save(writingDb, snapshot, owner, {
      injectFault(stage) {
        if (stage === 'after-commit') throw new Error('response channel lost');
      }
    }),
    /response channel lost/
  );
  writingDb.close();

  const inspectorDb = openDb(dbPath);
  const source = recoverySource(snapshot, owner);
  const inspection = inspectVccOpSaveRunOutcome({ db: inspectorDb, ...source });
  assert.equal(inspection.outcome, 'committed');
  const committedRunId = inspection.boundedEvidence.runId;
  const replay = save(inspectorDb, snapshot, owner);
  assert.equal(replay.runId, committedRunId);
  assert.equal(replay.outcome, 'recovered-existing-commit');
  assert.deepEqual(counts(inspectorDb), { runs: 1, files: 2, receipts: 1 });
  inspectorDb.close();
});

test('事务中 Worker 硬退出由 SQLite 回滚；新连接 Inspector 为 not-committed', async (t) => {
  const dbPath = withTempDb(t, 'vcc-save-hard-crash-');
  const setupDb = openDb(dbPath);
  setupDb.close();
  const snapshot = snapshotFor();
  const owner = operationOwner('hard-crash');
  const source = `
    'use strict';
    const { workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { saveVccOpRunWithReceipt } = require(workerData.contractPath);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    saveVccOpRunWithReceipt({
      db,
      computeSnapshot: workerData.snapshot,
      beginOp: '1000.00',
      operationOwner: workerData.owner,
      injectFault(stage) {
        if (stage === 'after-receipt-insert') process.exit(79);
      }
    });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      dbPath,
      contractPath: require.resolve('../../../src/main-process/vcc-op-calc/save-run-contract'),
      snapshot,
      owner
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  assert.equal(exitCode, 79);

  const inspectorDb = openDb(dbPath);
  const inspection = inspectVccOpSaveRunOutcome({
    db: inspectorDb,
    ...recoverySource(snapshot, owner)
  });
  assert.equal(inspection.outcome, 'not-committed');
  assert.deepEqual(counts(inspectorDb), { runs: 0, files: 0, receipts: 0 });
  inspectorDb.close();
});

function runConcurrentWorker(workerData) {
  const source = `
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { saveVccOpRunWithReceipt } = require(workerData.contractPath);
    const gate = new Int32Array(workerData.gate);
    Atomics.wait(gate, 0, 0);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    try {
      const result = saveVccOpRunWithReceipt({
        db,
        computeSnapshot: workerData.snapshot,
        beginOp: workerData.beginOp,
        operationOwner: workerData.owner
      });
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({ ok: false, code: error && error.code, message: error && error.message });
    } finally {
      db.close();
    }
  `;
  const worker = new Worker(source, { eval: true, workerData });
  const online = new Promise((resolve, reject) => {
    worker.once('online', resolve);
    worker.once('error', reject);
  });
  const result = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`并发 save worker 异常退出：${code}`));
    });
  });
  return { online, result };
}

test('两个真实 SQLite 连接并发同 operation exactly-one run + receipt', async (t) => {
  const dbPath = withTempDb(t, 'vcc-save-concurrency-');
  const setupDb = openDb(dbPath);
  setupDb.exec('PRAGMA journal_mode = WAL');
  setupDb.close();
  const snapshot = snapshotFor();
  const owner = operationOwner('concurrent');
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const shared = {
    dbPath,
    contractPath: require.resolve('../../../src/main-process/vcc-op-calc/save-run-contract'),
    snapshot,
    owner,
    beginOp: '1000.00',
    gate
  };
  const first = runConcurrentWorker(shared);
  const second = runConcurrentWorker(shared);
  await Promise.all([first.online, second.online]);
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, 2);
  const results = await Promise.all([first.result, second.result]);

  assert.deepEqual(results.map((item) => item.ok), [true, true]);
  assert.deepEqual(
    results.map((item) => item.result.outcome).sort(),
    ['committed', 'recovered-existing-commit']
  );
  assert.equal(results[0].result.runId, results[1].result.runId);
  const verifyDb = openDb(dbPath);
  assert.deepEqual(counts(verifyDb), { runs: 1, files: 2, receipts: 1 });
  assert.deepEqual(verifyDb.prepare('PRAGMA foreign_key_check').all(), []);
  verifyDb.close();
});

test('canonical snapshot hash 跨 key insertion order 稳定且内容变化可辨识', () => {
  const snapshot = snapshotFor();
  const reordered = {
    perFile: snapshot.perFile.map((file) => ({
      amount: file.amount,
      amountIn: file.amountIn,
      amountOut: file.amountOut,
      amountCents: file.amountCents,
      amountInCents: file.amountInCents,
      amountOutCents: file.amountOutCents,
      rowCount: file.rowCount,
      fileName: file.fileName
    })),
    totals: {
      currency: snapshot.totals.currency,
      totalAmount: snapshot.totals.totalAmount,
      totalIn: snapshot.totals.totalIn,
      totalOut: snapshot.totals.totalOut,
      totalAmountCents: snapshot.totals.totalAmountCents,
      totalInCents: snapshot.totals.totalInCents,
      totalOutCents: snapshot.totals.totalOutCents
    },
    yearMonth: snapshot.yearMonth
  };
  assert.equal(
    hashVccOpComputeSnapshot(snapshot).computeSnapshotHash,
    hashVccOpComputeSnapshot(reordered).computeSnapshotHash
  );
  const changed = snapshotFor({
    files: [{ fileName: 'vcc-a.xlsx', rows: [flowRow('入', '80.25')] }]
  });
  assert.notEqual(
    hashVccOpComputeSnapshot(snapshot).computeSnapshotHash,
    hashVccOpComputeSnapshot(changed).computeSnapshotHash
  );
  const pipelineSnapshot = {
    computeSnapshotContractVersion: 1,
    inputEvidenceHash: 'b'.repeat(64),
    totalRows: snapshot.perFile.reduce((sum, file) => sum + file.rowCount, 0),
    ...snapshot
  };
  const pipelineHash = hashVccOpComputeSnapshot(pipelineSnapshot).computeSnapshotHash;
  assert.match(pipelineHash, /^[a-f0-9]{64}$/);
  assert.equal(
    pipelineHash,
    hashVccOpComputeSnapshot({ ...pipelineSnapshot }).computeSnapshotHash
  );
  assert.notEqual(
    pipelineHash,
    hashVccOpComputeSnapshot({
      ...pipelineSnapshot,
      inputEvidenceHash: 'c'.repeat(64)
    }).computeSnapshotHash
  );
});

test('Inspector factory 可通过 registry exact key freeze，但不要求产品 startup 注册', async () => {
  const db = openDb();
  const snapshot = snapshotFor();
  const owner = operationOwner('registry');
  save(db, snapshot, owner);
  const source = recoverySource(snapshot, owner);
  const registry = createInspectorRegistry({ expectedKeys: [VCC_OP_SAVE_RUN_INSPECTOR_KEY] });
  registry.register(VCC_OP_SAVE_RUN_INSPECTOR_KEY, createVccOpSaveRunInspector({ getDb: () => db }));
  registry.freeze();
  const result = await registry.get(VCC_OP_SAVE_RUN_INSPECTOR_KEY)(source);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.boundedEvidence.runId, 1);
  db.close();
});

test('底层 evidence API 对完整 commit 与 no-receipt 使用相同严格 identity', () => {
  const db = openDb();
  const snapshot = snapshotFor();
  const owner = operationOwner('evidence');
  const expected = expectedIdentity(snapshot, owner);
  assert.equal(inspectVccOpSaveRunEvidence(db, expected).outcome, 'not-committed');
  save(db, snapshot, owner);
  assert.equal(inspectVccOpSaveRunEvidence(db, expected).outcome, 'committed');
  db.close();
});
