'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../../src/backend/pending-db/migrations');
const monthRepository = require('../../../src/backend/pending-db/month-repository');
const removedRepository = require('../../../src/backend/pending-db/removed-repository');
const diffRepository = require('../../../src/backend/pending-db/diff-repository');
const reconcileEngine = require('../../../src/backend/pending-reconcile/engine');
const {
  createPendingDatasetSeed,
  identityFromPendingDatasetSeed
} = require('../../../src/backend/pending-db/dataset-identity');
const pendingExportWriter = require('../../../src/backend/pending-export/writer');
const PENDING_COLUMNS = require('../../../src/backend/pending-db/columns');
const {
  createArchiveRepository
} = require('../../../src/backend/database/archive-repository');
const {
  normalizeLineageIntentsV1
} = require('../../../src/main-process/archive-center/task-lineage');
const {
  finalizePendingTerminalIntent,
  pendingAggregateRunSelection,
  pendingRunLineagePlan,
  publicPendingRun,
  recoverPendingRunReceipts
} = require('../../../src/main-process/pending-archive-lineage');

function openPendingMemory() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

function identity(datasetId, producerTaskRunId, datasetVersion = 1) {
  return { datasetId, producerTaskRunId, datasetVersion, archiveContractVersion: 1 };
}

function writeMonth(db, yearMonth, datasetId, producerTaskRunId, version = 1) {
  monthRepository.upsertMonthMeta(db, {
    yearMonth,
    rowCount: 0,
    sourceFiles: [`${yearMonth}.xlsx`],
    datasetIdentity: identity(datasetId, producerTaskRunId, version)
  });
}

function archiveTaskPayload(taskRunId, taskKey = 'pending:reconcile:run') {
  return {
    taskRunId,
    moduleId: 'pending-reconciliation',
    taskKey,
    operationKey: `operation:${taskRunId}`,
    parentRunId: `parent:${taskRunId}`
  };
}

function createArchiveService(repository, { failDirectBind = false } = {}) {
  return {
    repository,
    async bindFlowAnchor(payload) {
      if (failDirectBind) return { ok: false, message: 'injected bind failure' };
      const result = repository.bindFlowAnchor(payload);
      return { ok: true, ...result };
    },
    async persistTaskFlowBindIntent(payload) {
      const result = repository.persistTaskFlowBindIntent(payload);
      return { ok: true, ...result };
    },
    async beginTaskRunRecovery(taskRunId) {
      const result = repository.transitionTaskRun(taskRunId, 'running', { recovery: true });
      return { ok: result.status === 'updated' || result.status === 'unchanged', ...result };
    },
    async finishTaskRun(taskRunId, outcome) {
      const result = repository.transitionTaskRun(taskRunId, outcome.taskStatus, {
        expectedStatuses: ['prepared', 'running'],
        metadata: outcome.metadata
      });
      return { ok: result.status === 'updated' || result.status === 'unchanged', ...result };
    }
  };
}

test('Pending additive migration 为历史 ordinary/removed head 写 v0 UUID，不伪造 producer', () => {
  const db = openPendingMemory();
  try {
    db.prepare(`
      INSERT INTO pending_months (
        year_month, imported_at, row_count, source_files, archive_path,
        dataset_id, producer_task_run_id, dataset_version, archive_contract_version
      ) VALUES ('2026-01', '2026-02-01T00:00:00.000Z', 0, '[]', NULL, NULL, NULL, 0, 0)
    `).run();
    db.prepare(`
      INSERT INTO removed_pending_rows (
        year_month, source_file, raw_json, created_at
      ) VALUES ('2026-01', 'removed.xlsx', '{}', '2026-02-01T00:00:00.000Z')
    `).run();
    runMigrations(db);
    const ordinary = monthRepository.getMonthMeta(db, '2026-01');
    const removed = removedRepository.getMonthHead(db, '2026-01');
    assert.match(ordinary.datasetId, /^[0-9a-f-]{36}$/);
    assert.equal(ordinary.producerTaskRunId, null);
    assert.equal(ordinary.archiveContractVersion, 0);
    assert.match(removed.datasetId, /^[0-9a-f-]{36}$/);
    assert.equal(removed.producerTaskRunId, null);
    assert.equal(removed.archiveContractVersion, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM diff_runs').get().count, 0);
  } finally {
    db.close();
  }
});

test('旧 binary SQL 覆盖 v1 ordinary/removed 后 identity 失效，前滚只回填 v0/null producer', () => {
  const db = openPendingMemory();
  try {
    writeMonth(db, '2026-02', 'ordinary-v1', 'ordinary-task');
    removedRepository.replaceByMonth(
      db,
      '2026-02',
      [{ raw: { order_no: 'old' }, order_no: 'old' }],
      'old.xlsx',
      identity('removed-v1', 'removed-task')
    );
    db.prepare(`
      UPDATE pending_months
      SET imported_at = '2026-03-01T00:00:00.000Z', row_count = 1,
          source_files = '["rollback.xlsx"]'
      WHERE year_month = '2026-02'
    `).run();
    db.prepare("DELETE FROM removed_pending_rows WHERE year_month = '2026-02'").run();
    db.prepare(`
      INSERT INTO removed_pending_rows (year_month, source_file, raw_json, created_at)
      VALUES ('2026-02', 'rollback.xlsx', '{}', '2026-03-01T00:00:00.000Z')
    `).run();
    assert.equal(monthRepository.getMonthMeta(db, '2026-02').datasetId, null);
    assert.equal(removedRepository.getMonthHead(db, '2026-02'), null);
    runMigrations(db);
    const ordinary = monthRepository.getMonthMeta(db, '2026-02');
    const removed = removedRepository.getMonthHead(db, '2026-02');
    assert.notEqual(ordinary.datasetId, 'ordinary-v1');
    assert.equal(ordinary.archiveContractVersion, 0);
    assert.equal(ordinary.producerTaskRunId, null);
    assert.notEqual(removed.datasetId, 'removed-v1');
    assert.equal(removed.archiveContractVersion, 0);
    assert.equal(removed.producerTaskRunId, null);
  } finally {
    db.close();
  }
});

test('ordinary/removed 正常覆盖同事务换 dataset UUID 并递增 version', () => {
  const db = openPendingMemory();
  try {
    writeMonth(db, '2026-03', 'ordinary-1', 'ordinary-task-1');
    const ordinaryHead = monthRepository.getMonthMeta(db, '2026-03');
    const next = identityFromPendingDatasetSeed(
      ordinaryHead,
      createPendingDatasetSeed(ordinaryHead, 'ordinary-task-2', () => 'ordinary-2')
    );
    monthRepository.upsertMonthMeta(db, {
      yearMonth: '2026-03',
      rowCount: 0,
      sourceFiles: [],
      datasetIdentity: next
    });
    assert.equal(monthRepository.getMonthMeta(db, '2026-03').datasetVersion, 2);
    removedRepository.replaceByMonth(
      db, '2026-03', [], 'removed.xlsx', identity('removed-1', 'removed-task-1')
    );
    const removedHead = removedRepository.getMonthHead(db, '2026-03');
    const nextRemoved = identityFromPendingDatasetSeed(
      removedHead,
      createPendingDatasetSeed(removedHead, 'removed-task-2', () => 'removed-2')
    );
    removedRepository.replaceByMonth(db, '2026-03', [], 'removed-2.xlsx', nextRemoved);
    assert.deepEqual(
      {
        datasetId: removedRepository.getMonthHead(db, '2026-03').datasetId,
        version: removedRepository.getMonthHead(db, '2026-03').datasetVersion
      },
      { datasetId: 'removed-2', version: 2 }
    );
    assert.throws(() => createPendingDatasetSeed(null, ''), /producerTaskRunId/);
  } finally {
    db.close();
  }
});

test('normal reconcile API 拒绝 missing/v0 receipt，不进入 legacy 写入', () => {
  const db = openPendingMemory();
  try {
    writeMonth(db, '2026-03', 'upper', 'upper-task');
    writeMonth(db, '2026-04', 'lower', 'lower-task');
    const base = {
      upperMonth: '2026-03',
      lowerMonth: '2026-04',
      rule: { matchFields: ['order_no'], compareFields: [] },
      expectedDatasets: pendingRunLineagePlan(db, {
        upperMonth: '2026-03', lowerMonth: '2026-04'
      }).expectedDatasets
    };
    assert.throws(() => reconcileEngine.runReconciliation(db, base), /v1 Archive receipt/);
    assert.throws(() => reconcileEngine.runReconciliation(db, {
      ...base,
      archiveReceipt: { archiveContractVersion: 0, archiveTaskRunId: null }
    }), /v1 Archive receipt/);
    assert.equal(diffRepository.listAllRuns(db).length, 0);
  } finally {
    db.close();
  }
});

test('Pending run 在同一业务事务核 frozen dataset head 并写未 ack receipt', () => {
  const db = openPendingMemory();
  try {
    writeMonth(db, '2026-04', 'upper-1', 'upper-task');
    writeMonth(db, '2026-05', 'lower-1', 'lower-task');
    const plan = pendingRunLineagePlan(db, {
      upperMonth: '2026-04', lowerMonth: '2026-05'
    });
    writeMonth(db, '2026-04', 'upper-2', 'upper-task-2', 2);
    assert.throws(() => reconcileEngine.runReconciliation(db, {
      upperMonth: '2026-04',
      lowerMonth: '2026-05',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'run-task' },
      expectedDatasets: plan.expectedDatasets
    }), /dataset.*已变化/);
    assert.equal(diffRepository.listAllRuns(db).length, 0);

    const currentPlan = pendingRunLineagePlan(db, {
      upperMonth: '2026-04', lowerMonth: '2026-05'
    });
    const result = reconcileEngine.runReconciliation(db, {
      upperMonth: '2026-04',
      lowerMonth: '2026-05',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'run-task' },
      expectedDatasets: currentPlan.expectedDatasets
    });
    const receipt = diffRepository.getRunById(db, result.runId);
    assert.equal(receipt.archiveTaskRunId, 'run-task');
    assert.equal(receipt.archiveTerminalAckAt, null);
    assert.throws(() => diffRepository.createRun(db, {
      upperMonth: '2026-04',
      lowerMonth: '2026-05',
      ruleSnapshot: {},
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'run-task' }
    }), /UNIQUE/);
  } finally {
    db.close();
  }
});

test('未 ack success receipt 阻止月份覆盖；ack 后保留既有删除语义', () => {
  const db = openPendingMemory();
  try {
    writeMonth(db, '2026-06', 'upper', 'upper-task');
    writeMonth(db, '2026-07', 'lower', 'lower-task');
    const plan = pendingRunLineagePlan(db, { upperMonth: '2026-06', lowerMonth: '2026-07' });
    const { runId } = reconcileEngine.runReconciliation(db, {
      upperMonth: '2026-06',
      lowerMonth: '2026-07',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'unacked-task' },
      expectedDatasets: plan.expectedDatasets
    });
    assert.throws(() => monthRepository.deleteMonth(db, '2026-06'), /尚未确认/);
    assert.ok(monthRepository.getMonthMeta(db, '2026-06'));
    diffRepository.acknowledgeArchiveTerminal(db, runId, 'unacked-task');
    monthRepository.deleteMonth(db, '2026-06');
    assert.equal(monthRepository.getMonthMeta(db, '2026-06'), null);
  } finally {
    db.close();
  }
});

test('Pending owner 在通用 sweep 前按 exact receipt 提交 TaskRun lineage 并 ack', async () => {
  const pendingDb = openPendingMemory();
  const archiveDb = new DatabaseSync(':memory:');
  const archiveRepository = createArchiveRepository(archiveDb, {
    now: () => new Date('2026-08-18T00:00:00.000Z')
  });
  archiveRepository.ensureSchema();
  try {
    for (const producerTaskRunId of ['upper-task', 'lower-task']) {
      archiveRepository.beginTaskRun({
        ...archiveTaskPayload(producerTaskRunId, 'pending:import:start')
      });
      archiveRepository.transitionTaskRun(producerTaskRunId, 'running');
      archiveRepository.transitionTaskRun(producerTaskRunId, 'succeeded');
    }
    writeMonth(pendingDb, '2026-08', 'upper', 'upper-task');
    writeMonth(pendingDb, '2026-09', 'lower', 'lower-task');
    const plan = pendingRunLineagePlan(pendingDb, {
      upperMonth: '2026-08', lowerMonth: '2026-09'
    });
    const task = archiveRepository.beginTaskRun({
      ...archiveTaskPayload('pending-run-task'),
      lineageIntents: normalizeLineageIntentsV1(plan.lineageIntents)
    }).taskRun;
    archiveRepository.transitionTaskRun(task.taskRunId, 'running');
    const result = reconcileEngine.runReconciliation(pendingDb, {
      upperMonth: '2026-08',
      lowerMonth: '2026-09',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: task.taskRunId },
      expectedDatasets: plan.expectedDatasets
    });
    const recovered = await recoverPendingRunReceipts({
      db: pendingDb,
      archiveService: createArchiveService(archiveRepository)
    });
    assert.equal(recovered.recovered, 1);
    assert.equal(archiveRepository.getTaskRun(task.taskRunId).status, 'succeeded');
    assert.deepEqual(
      archiveRepository.listTaskLineageForConsumer(task.taskRunId).map((row) => row.state),
      ['committed', 'committed']
    );
    assert.ok(diffRepository.getRunById(pendingDb, result.runId).archiveTerminalAckAt);
    assert.equal(
      archiveRepository.findFlowAnchor({
        moduleId: 'pending-reconciliation',
        identityType: 'business-run-id',
        identityValue: String(result.runId)
      }).parentRunId,
      task.parentRunId
    );
    archiveRepository.markInterruptedTasks();
    assert.equal(archiveRepository.getTaskRun(task.taskRunId).status, 'succeeded');
  } finally {
    pendingDb.close();
    archiveDb.close();
  }
});

test('Pending receipt 指向不存在或错误 TaskRun 时 fail-closed 并保留 receipt/lineage', async () => {
  const pendingDb = openPendingMemory();
  const archiveDb = new DatabaseSync(':memory:');
  const archiveRepository = createArchiveRepository(archiveDb);
  archiveRepository.ensureSchema();
  try {
    for (const producerTaskRunId of ['upper-task', 'lower-task']) {
      archiveRepository.beginTaskRun({
        ...archiveTaskPayload(producerTaskRunId, 'pending:import:start')
      });
      archiveRepository.transitionTaskRun(producerTaskRunId, 'running');
      archiveRepository.transitionTaskRun(producerTaskRunId, 'succeeded');
    }
    writeMonth(pendingDb, '2026-08', 'upper', 'upper-task');
    writeMonth(pendingDb, '2026-09', 'lower', 'lower-task');
    const plan = pendingRunLineagePlan(pendingDb, {
      upperMonth: '2026-08', lowerMonth: '2026-09'
    });
    const result = reconcileEngine.runReconciliation(pendingDb, {
      upperMonth: '2026-08',
      lowerMonth: '2026-09',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: 'mismatched-task' },
      expectedDatasets: plan.expectedDatasets
    });
    await assert.rejects(
      recoverPendingRunReceipts({
        db: pendingDb,
        archiveService: createArchiveService(archiveRepository)
      }),
      (error) => error.blocksArchiveStartup === true
        && error.code === 'ARCHIVE_PENDING_RUN_RECOVERY_CONFLICT'
    );
    archiveRepository.beginTaskRun({
      ...archiveTaskPayload('mismatched-task', 'pending:wrong-task'),
      moduleId: 'wrong-module'
    });
    await assert.rejects(
      recoverPendingRunReceipts({
        db: pendingDb,
        archiveService: createArchiveService(archiveRepository)
      }),
      (error) => error.blocksArchiveStartup === true
    );
    assert.equal(
      diffRepository.getRunById(pendingDb, result.runId).archiveTerminalAckAt,
      null
    );
    assert.equal(archiveRepository.getTaskRun('mismatched-task').status, 'prepared');
    assert.deepEqual(archiveRepository.listTaskLineageForConsumer('mismatched-task'), []);
  } finally {
    pendingDb.close();
    archiveDb.close();
  }
});

test('Pending owner 在 result flow bind 崩溃窗口持久 task-owned intent 后才 terminal/ack', async () => {
  const pendingDb = openPendingMemory();
  const archiveDb = new DatabaseSync(':memory:');
  const archiveRepository = createArchiveRepository(archiveDb);
  archiveRepository.ensureSchema();
  try {
    for (const producerTaskRunId of ['upper-task', 'lower-task']) {
      archiveRepository.beginTaskRun({
        ...archiveTaskPayload(producerTaskRunId, 'pending:import:start')
      });
      archiveRepository.transitionTaskRun(producerTaskRunId, 'running');
      archiveRepository.transitionTaskRun(producerTaskRunId, 'succeeded');
    }
    writeMonth(pendingDb, '2026-08', 'upper', 'upper-task');
    writeMonth(pendingDb, '2026-09', 'lower', 'lower-task');
    const plan = pendingRunLineagePlan(pendingDb, {
      upperMonth: '2026-08', lowerMonth: '2026-09'
    });
    const task = archiveRepository.beginTaskRun({
      ...archiveTaskPayload('pending-bind-crash-task'),
      lineageIntents: normalizeLineageIntentsV1(plan.lineageIntents)
    }).taskRun;
    archiveRepository.transitionTaskRun(task.taskRunId, 'running');
    const result = reconcileEngine.runReconciliation(pendingDb, {
      upperMonth: '2026-08', lowerMonth: '2026-09',
      rule: { matchFields: ['order_no'], compareFields: [] },
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: task.taskRunId },
      expectedDatasets: plan.expectedDatasets
    });

    await recoverPendingRunReceipts({
      db: pendingDb,
      archiveService: createArchiveService(archiveRepository, { failDirectBind: true })
    });
    const intent = archiveRepository.listTaskFlowBindIntents({
      moduleId: 'pending-reconciliation',
      identityType: 'business-run-id',
      identityValue: String(result.runId)
    })[0];
    assert.equal(intent.parentRunId, task.parentRunId);
    assert.equal(archiveRepository.getTaskRun(task.taskRunId).status, 'succeeded');
    assert.ok(diffRepository.getRunById(pendingDb, result.runId).archiveTerminalAckAt);
  } finally {
    pendingDb.close();
    archiveDb.close();
  }
});

test('single export 的所有 DB 读取固定在同一 SQLite snapshot，释放后才写文件', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-export-snapshot-'));
  const dbPath = path.join(directory, 'pending.sqlite');
  const db = new DatabaseSync(dbPath);
  const concurrent = new DatabaseSync(dbPath);
  t.after(() => {
    concurrent.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  runMigrations(db);
  db.exec('PRAGMA journal_mode = WAL');
  concurrent.exec('PRAGMA journal_mode = WAL');
  const cells = new Array(PENDING_COLUMNS.length).fill('');
  cells[PENDING_COLUMNS.indexOf('order_no')] = 'O-1';
  const upperId = Number(monthRepository.createRowInserter(db)('2026-10', 'upper-hash', cells).lastInsertRowid);
  const runId = diffRepository.createLegacyRun(db, {
    upperMonth: '2026-10', lowerMonth: '2026-11', ruleSnapshot: { compareFields: [] }
  });
  db.prepare(`
    INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id)
    VALUES (?, 'missing', ?, NULL)
  `).run(runId, upperId);

  const originalList = diffRepository.listDiffRows;
  let mutated = false;
  diffRepository.listDiffRows = (...args) => {
    if (!mutated) {
      mutated = true;
      concurrent.prepare('DELETE FROM diff_rows WHERE run_id = ?').run(runId);
      concurrent.prepare('DELETE FROM diff_runs WHERE id = ?').run(runId);
    }
    return originalList(...args);
  };
  t.after(() => { diffRepository.listDiffRows = originalList; });
  const result = pendingExportWriter.exportSingleRun(
    db,
    runId,
    path.join(directory, 'snapshot.xlsx')
  );
  assert.equal(result.rowCount, 1);
  assert.equal(mutated, true);
  assert.equal(diffRepository.getRunById(db, runId), null);
});

test('aggregate prepare 冻结实际 runIds/locators，execute API 不查询 latest', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-aggregate-frozen-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openPendingMemory();
  try {
    const first = diffRepository.createLegacyRun(db, {
      upperMonth: '2026-01', lowerMonth: '2026-02', ruleSnapshot: {}
    });
    const second = diffRepository.createLegacyRun(db, {
      upperMonth: '2026-01', lowerMonth: '2026-02', ruleSnapshot: {}
    });
    const selection = pendingAggregateRunSelection(db);
    assert.deepEqual(selection.runIds, [second]);
    assert.deepEqual(selection.lineageIntents.map((intent) => intent.lineageKey), [
      `pending:${second}`
    ]);
    assert.notEqual(first, second);
    const originalLatest = diffRepository.listLatestRunsByMonthPair;
    diffRepository.listLatestRunsByMonthPair = () => {
      throw new Error('execute 不得重查 latest');
    };
    try {
      const exported = pendingExportWriter.exportAggregateRuns(
        db,
        selection.runIds,
        path.join(directory, 'aggregate.xlsx')
      );
      assert.equal(exported.runsCount, 1);
    } finally {
      diffRepository.listLatestRunsByMonthPair = originalLatest;
    }
  } finally {
    db.close();
  }
});

test('Pending renderer run DTO 不泄露 Archive receipt identity', () => {
  const publicRun = publicPendingRun({
    id: 7,
    upperMonth: '2026-01',
    lowerMonth: '2026-02',
    ruleSnapshot: { matchFields: ['order_no'] },
    createdAt: '2026-02-01T00:00:00.000Z',
    statNew: 1,
    statMissing: 2,
    statChanged: 3,
    archiveContractVersion: 1,
    archiveTaskRunId: 'private-task-run',
    archiveTerminalAckAt: '2026-02-01T00:01:00.000Z'
  });
  assert.deepEqual(Object.keys(publicRun), [
    'id', 'upperMonth', 'lowerMonth', 'ruleSnapshot', 'createdAt',
    'statNew', 'statMissing', 'statChanged'
  ]);
  assert.equal(publicRun.archiveTaskRunId, undefined);
});

test('Pending failed terminal outbox 无成功 receipt 时 finalizer no-op', () => {
  assert.equal(finalizePendingTerminalIntent({
    route: { route: 'pending-run', taskRunId: 'pending-failed-task' },
    record: { payload: {} },
    terminalOutcome: { taskStatus: 'failed' },
    terminalResult: { taskRun: { status: 'failed' } },
    db: null
  }), null);
});

test('Pending main seam 贯穿 dataset/run identity、frozen export selection 与 terminal route', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  assert.match(mainSource,
    /datasetSeed:\s*createPendingDatasetSeed\([\s\S]*?taskContext\.batchContext\.taskRunId/);
  assert.match(mainSource,
    /pendingRemovedRepo\.replaceByMonthWithSeed\([\s\S]*?createPendingDatasetSeed\([\s\S]*?taskContext\.batchContext\.taskRunId/);
  assert.match(mainSource,
    /pendingRunLineagePlan\(pendingDb, payload\)[\s\S]*?expectedDatasets:\s*lineagePlan\.expectedDatasets/);
  assert.match(mainSource,
    /archiveTaskRunId:\s*taskContext\.operationContext\.taskRunId[\s\S]*?expectedDatasets:\s*prepared\.expectedDatasets/);
  assert.match(mainSource,
    /lineageIntents:\s*\[runOutputLineageIntent\(run\)\]/);
  assert.match(mainSource,
    /pendingAggregateRunSelection\(pendingDb\)[\s\S]*?runIds:\s*selection\.runIds[\s\S]*?lineageIntents:\s*selection\.lineageIntents/);
  assert.match(mainSource,
    /exportAggregateRuns\([\s\S]*?prepared\.runIds[\s\S]*?taskContext\.fileEvidence\.filePlan\.outputs\[0\]\.filePath/);
  assert.match(mainSource,
    /typeof prepared\.afterTerminal === 'function' \? prepared\.afterTerminal : null/);
  assert.match(mainSource,
    /prepared\.afterTerminalIntent \|\| null/);
  assert.equal((mainSource.match(/\.map\(publicPendingRun\)/g) || []).length, 2);
  assert.match(mainSource,
    /pending:diff:latest-run-for[\s\S]*?return publicPendingRun\(/);
});
