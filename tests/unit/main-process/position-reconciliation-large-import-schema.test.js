'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  stableHash
} = require('../../../src/main-process/position-reconciliation/common');
const {
  createPositionReconciliationStore,
  runRowIntegrityHash,
  serializeJson
} = require('../../../src/main-process/position-reconciliation/store');
const {
  listPositionCommittedOperationInputs,
  runPositionSideDbMutation
} = require('../../../src/main-process/position-reconciliation/side-db-mutation');
const {
  assertPositionLargeImportSchema,
  ensurePositionLargeImportSchema,
  ensurePositionLargeImportSchemaAtPath,
  positionLargeImportSchemaFingerprint
} = require('../../../src/main-process/position-reconciliation/large-import-schema');
const {
  recoverPositionImportWorkerExit,
  rebuildOrdinarySourceResult
} = require('../../../src/main-process/position-reconciliation/import-recovery');
const {
  sourceSnapshotFromStat
} = require('../../../src/main-process/archive-center/source-snapshot');

const INITIAL_CHECKPOINT = Object.freeze({
  identity: 'position-large-import-test',
  generation: 0,
  token: 'position-large-import-generation-0'
});
const ENOUGH_DISK = () => 10n ** 15n;

function tempStore(t, prefix) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const store = createPositionReconciliationStore(userDataDir, {
    initialCheckpoint: INITIAL_CHECKPOINT
  });
  return { userDataDir, store };
}

function inputEvidence(filePath, sourceType = SOURCE_TYPES.GATEWAY_OUTBOUND) {
  const stat = fs.statSync(filePath);
  return {
    filePath,
    originalName: path.basename(filePath),
    role: 'input',
    sourceType,
    sourceSnapshot: sourceSnapshotFromStat(stat),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    sizeBytes: stat.size
  };
}

function insertSource(db, {
  sourceType,
  businessKey,
  rowHash,
  rawJson,
  sourceRowNumber
}) {
  return Number(db.prepare(`
    INSERT INTO position_source_rows(
      source_type, business_key, event_date, month_key,
      source_file_path, source_file_name, source_sheet, source_row_number,
      row_hash, raw_json
    ) VALUES (?, ?, '2026-01-01', '2026-01', ?, 'source.xlsx', 'Sheet1', ?, ?, ?)
  `).run(
    sourceType,
    businessKey,
    `/tmp/${businessKey}.xlsx`,
    sourceRowNumber,
    rowHash,
    rawJson
  ).lastInsertRowid);
}

function insertLink(db, {
  sourceId,
  sourceType,
  businessKey,
  sourceRowNumber,
  ordinal,
  linkedJson
}) {
  return Number(db.prepare(`
    INSERT INTO position_link_rows(
      source_type, business_key, source_row_id, source_row_number,
      ordinal, leg_index, visible, linked_json
    ) VALUES (?, ?, ?, ?, ?, 0, 1, ?)
  `).run(
    sourceType,
    businessKey,
    sourceId,
    sourceRowNumber,
    ordinal,
    linkedJson
  ).lastInsertRowid);
}

function insertMatchedRun(db, {
  runUuid,
  bizId,
  sourceType,
  businessKey,
  sourceLinkRowId,
  sourceRowNumber,
  consumesSource
}) {
  const runId = Number(db.prepare(`
    INSERT INTO position_runs(
      run_uuid, status, scope_json, snapshot_json, summary_json, confirmed_at
    ) VALUES (?, 'confirmed', '{}', '{}', '{}', CURRENT_TIMESTAMP)
  `).run(runUuid).lastInsertRowid);
  const originalRow = {};
  const resultRow = {};
  const lineage = {
    pairKey: `pair-${bizId}`,
    sourceType,
    sourceIndex: 0,
    sourceLinkRowId,
    sourceBusinessKey: businessKey,
    sourceRowNumber,
    sourceLegIndex: 0,
    identifiers: []
  };
  const integrityHash = runRowIntegrityHash({
    runId,
    bizId,
    channel: 'TEST',
    monthKey: '2026-01',
    sourceOrder: 1,
    originalFundType: 'Others',
    resultFundType: 'Others&FX',
    hitSummary: 'Others → Others&FX',
    hitType: '精准命中',
    matchDetail: 'test',
    outcome: 'matched',
    changed: true,
    manualModified: false,
    consumesSource,
    originalRow,
    resultRow,
    lineage
  });
  db.prepare(`
    INSERT INTO position_run_rows(
      run_id, biz_id, channel, month_key, source_order,
      original_fund_type, result_fund_type, hit_summary, hit_type, match_detail,
      outcome, changed, manual_modified, consumes_source,
      original_json, result_json, lineage_json, integrity_hash
    ) VALUES (?, ?, 'TEST', '2026-01', 1, 'Others', 'Others&FX',
              'Others → Others&FX', '精准命中', 'test', 'matched', 1, 0, ?,
              ?, ?, ?, ?)
  `).run(
    runId,
    bizId,
    consumesSource ? 1 : 0,
    serializeJson(originalRow),
    serializeJson(resultRow),
    serializeJson(lineage),
    integrityHash
  );
  return runId;
}

test('共享 mutation helper 在同一事务写业务、input proof 与 checkpoint', (t) => {
  const { store, userDataDir } = tempStore(t, 'position-mutation-helper-');
  t.after(() => store.close());
  const filePath = path.join(userDataDir, 'input.xlsx');
  fs.writeFileSync(filePath, 'position-input-proof');
  const evidence = inputEvidence(filePath);

  const committed = runPositionSideDbMutation({
    db: store.db,
    expectedCheckpoint: store.persistenceCheckpoint(),
    operationToken: 'external-operation-token',
    requireExternalOperationToken: true,
    inputEvidence: [evidence],
    mutate: ({ db }) => {
      db.prepare(`
        INSERT INTO position_revisions(kind, scope_key, revision)
        VALUES ('test', 'mutation', 1)
      `).run();
      return { changed: 1 };
    }
  });
  assert.deepEqual(committed.result, { changed: 1 });
  assert.equal(committed.nextCheckpoint.generation, 1);
  assert.equal(
    store.db.prepare(
      'SELECT operation_token FROM position_checkpoint_history WHERE generation = 1'
    ).get().operation_token,
    'external-operation-token'
  );
  assert.equal(
    listPositionCommittedOperationInputs(store.db, 'external-operation-token').length,
    1
  );

  store.db.exec(`
    CREATE TRIGGER reject_position_input_proof
    BEFORE INSERT ON position_operation_inputs
    BEGIN
      SELECT RAISE(ABORT, 'blocked input proof');
    END;
  `);
  const checkpointBeforeFailure = store.persistenceCheckpoint();
  assert.throws(
    () => runPositionSideDbMutation({
      db: store.db,
      expectedCheckpoint: checkpointBeforeFailure,
      operationToken: 'rollback-operation-token',
      requireExternalOperationToken: true,
      inputEvidence: [{
        ...evidence,
        filePath: path.join(userDataDir, 'other.xlsx')
      }],
      mutate: ({ db }) => {
        db.prepare(`
          INSERT INTO position_revisions(kind, scope_key, revision)
          VALUES ('test', 'rollback', 1)
        `).run();
      }
    }),
    /blocked input proof/
  );
  assert.deepEqual(store.persistenceCheckpoint(), checkpointBeforeFailure);
  assert.equal(
    store.db.prepare(
      "SELECT COUNT(*) AS count FROM position_revisions WHERE scope_key = 'rollback'"
    ).get().count,
    0
  );
});

test('来源身份迁移折叠完全相同行并回填链接、运行和消费血缘', (t) => {
  const { store } = tempStore(t, 'position-source-identity-migration-');
  const dbPath = store.dbPath;
  const duplicatePayload = serializeJson({ account: 'same-account', currency: 'USD' });
  const duplicateHash = stableHash({ account: 'same-account', currency: 'USD' });
  const firstSourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    rowHash: duplicateHash,
    rawJson: duplicatePayload,
    sourceRowNumber: 2
  });
  const secondSourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    rowHash: duplicateHash,
    rawJson: duplicatePayload,
    sourceRowNumber: 3
  });
  const firstLinkId = insertLink(store.db, {
    sourceId: firstSourceId,
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    sourceRowNumber: 2,
    ordinal: 0,
    linkedJson: serializeJson({ account: 'same-account' })
  });
  const secondLinkId = insertLink(store.db, {
    sourceId: secondSourceId,
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    sourceRowNumber: 3,
    ordinal: 1,
    linkedJson: serializeJson({ account: 'same-account' })
  });
  insertMatchedRun(store.db, {
    runUuid: 'run-account-duplicate',
    bizId: 'BANK-ACCOUNT-DUPLICATE',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    sourceLinkRowId: secondLinkId,
    sourceRowNumber: 3,
    consumesSource: false
  });

  const gatewayPayload = serializeJson({ '业务单号': 'ORDER-1', '渠道名称': 'Yeepay' });
  const gatewayHash = stableHash({ '业务单号': 'ORDER-1', '渠道名称': 'Yeepay' });
  const gatewaySourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-1',
    rowHash: gatewayHash,
    rawJson: gatewayPayload,
    sourceRowNumber: 10
  });
  const gatewayLinkId = insertLink(store.db, {
    sourceId: gatewaySourceId,
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-1',
    sourceRowNumber: 10,
    ordinal: 2,
    linkedJson: serializeJson({ ReconID: 'RECON-1' })
  });
  const gatewayRunId = insertMatchedRun(store.db, {
    runUuid: 'run-gateway-consumed',
    bizId: 'BANK-GATEWAY-1',
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-1',
    sourceLinkRowId: gatewayLinkId,
    sourceRowNumber: 10,
    consumesSource: true
  });
  store.db.prepare(`
    INSERT INTO position_consumed_sources(
      run_id, source_type, business_key, leg_index, bank_biz_id
    ) VALUES (?, ?, 'ORDER-1', 0, 'BANK-GATEWAY-1')
  `).run(gatewayRunId, SOURCE_TYPES.GATEWAY_OUTBOUND);
  store.close();

  const migrated = ensurePositionLargeImportSchemaAtPath({
    sideDbPath: dbPath,
    expectedCheckpoint: INITIAL_CHECKPOINT,
    availableBytesProvider: ENOUGH_DISK
  });
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.checkpoint, INITIAL_CHECKPOINT);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => db.close());
  assertPositionLargeImportSchema(db);
  assert.equal(positionLargeImportSchemaFingerprint(db), migrated.fingerprint);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
    2
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
    2
  );
  const accountLineage = JSON.parse(db.prepare(`
    SELECT lineage_json AS lineageJson
    FROM position_run_rows
    WHERE biz_id = 'BANK-ACCOUNT-DUPLICATE'
  `).get().lineageJson);
  assert.equal(accountLineage.sourceLinkRowId, firstLinkId);
  assert.equal(accountLineage.sourceBusinessKey, 'snapshot-row-2');
  assert.equal(accountLineage.sourceRecordKey, duplicateHash);
  const consumed = db.prepare(`
    SELECT business_key AS businessKey, source_record_key AS sourceRecordKey
    FROM position_consumed_sources
    WHERE bank_biz_id = 'BANK-GATEWAY-1'
  `).get();
  assert.equal(consumed.businessKey, 'ORDER-1');
  assert.equal(consumed.sourceRecordKey, gatewayHash);
});

test('来源腿冲突或磁盘空间不足时身份迁移整体回滚', (t) => {
  const { store } = tempStore(t, 'position-source-migration-rollback-');
  const dbPath = store.dbPath;
  const payload = serializeJson({ '业务单号': 'ORDER-DUP' });
  const sourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-DUP',
    rowHash: stableHash({ '业务单号': 'ORDER-DUP' }),
    rawJson: payload,
    sourceRowNumber: 2
  });
  insertLink(store.db, {
    sourceId,
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-DUP',
    sourceRowNumber: 2,
    ordinal: 0,
    linkedJson: serializeJson({ ReconID: 'A' })
  });
  insertLink(store.db, {
    sourceId,
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    businessKey: 'ORDER-DUP',
    sourceRowNumber: 2,
    ordinal: 1,
    linkedJson: serializeJson({ ReconID: 'B' })
  });
  store.close();

  assert.throws(
    () => ensurePositionLargeImportSchemaAtPath({
      sideDbPath: dbPath,
      expectedCheckpoint: INITIAL_CHECKPOINT,
      availableBytesProvider: ENOUGH_DISK
    }),
    (error) => error && error.code === 'position-link-source-leg-duplicate'
  );
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  assert.equal(
    db.prepare('PRAGMA table_info(position_link_rows)').all()
      .some((column) => column.name === 'source_record_key'),
    false
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
    2
  );

  assert.throws(
    () => ensurePositionLargeImportSchemaAtPath({
      sideDbPath: dbPath,
      expectedCheckpoint: INITIAL_CHECKPOINT,
      availableBytesProvider: () => 0n
    }),
    (error) => error && error.code === 'position-side-db-migration-disk-insufficient'
  );
});

test('schema 迁移取得写锁后重新核对 checkpoint', (t) => {
  const { store } = tempStore(t, 'position-schema-checkpoint-race-');
  t.after(() => store.close());
  const staleCheckpoint = store.persistenceCheckpoint();
  store.saveMappings([{
    midAccountId: 'MID-ACCOUNT',
    clearingAccountId: 'CLEARING-ACCOUNT'
  }]);

  assert.throws(
    () => ensurePositionLargeImportSchema({
      db: store.db,
      dbPath: store.dbPath,
      expectedCheckpoint: staleCheckpoint,
      availableBytesProvider: ENOUGH_DISK
    }),
    (error) => error && error.code === 'position-side-db-mismatch'
  );
  assert.equal(
    store.db.prepare('PRAGMA table_info(position_link_rows)').all()
      .some((column) => column.name === 'source_record_key'),
    false
  );
});

test('完全重复来源行派生业务字段不一致时禁止折叠迁移', (t) => {
  const { store } = tempStore(t, 'position-source-link-collision-');
  const dbPath = store.dbPath;
  const payload = { account: 'same-account', currency: 'USD' };
  const rowHash = stableHash(payload);
  const firstSourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    rowHash,
    rawJson: serializeJson(payload),
    sourceRowNumber: 2
  });
  const secondSourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    rowHash,
    rawJson: serializeJson(payload),
    sourceRowNumber: 3
  });
  insertLink(store.db, {
    sourceId: firstSourceId,
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    sourceRowNumber: 2,
    ordinal: 0,
    linkedJson: serializeJson({ ReconID: 'RECON-A' })
  });
  insertLink(store.db, {
    sourceId: secondSourceId,
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    sourceRowNumber: 3,
    ordinal: 1,
    linkedJson: serializeJson({ ReconID: 'RECON-B' })
  });
  store.close();

  assert.throws(
    () => ensurePositionLargeImportSchemaAtPath({
      sideDbPath: dbPath,
      expectedCheckpoint: INITIAL_CHECKPOINT,
      availableBytesProvider: ENOUGH_DISK
    }),
    (error) => error && error.code === 'position-source-record-hash-collision'
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => db.close());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
    2
  );
  assert.equal(
    db.prepare('PRAGMA table_info(position_link_rows)').all()
      .some((column) => column.name === 'source_record_key'),
    false
  );
});

test('完全重复来源行的派生腿集合不一致时禁止折叠迁移', (t) => {
  const { store } = tempStore(t, 'position-source-leg-set-collision-');
  const dbPath = store.dbPath;
  const payload = { account: 'same-account', currency: 'USD' };
  const rowHash = stableHash(payload);
  const firstSourceId = insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    rowHash,
    rawJson: serializeJson(payload),
    sourceRowNumber: 2
  });
  insertSource(store.db, {
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-3',
    rowHash,
    rawJson: serializeJson(payload),
    sourceRowNumber: 3
  });
  insertLink(store.db, {
    sourceId: firstSourceId,
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    businessKey: 'snapshot-row-2',
    sourceRowNumber: 2,
    ordinal: 0,
    linkedJson: serializeJson({ ReconID: 'RECON-A' })
  });
  store.close();

  assert.throws(
    () => ensurePositionLargeImportSchemaAtPath({
      sideDbPath: dbPath,
      expectedCheckpoint: INITIAL_CHECKPOINT,
      availableBytesProvider: ENOUGH_DISK
    }),
    (error) => error && error.code === 'position-source-record-hash-collision'
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => db.close());
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count,
    2
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count,
    1
  );
});

test('worker 退出后按 checkpoint 历史和 input proof 恢复已提交文件', (t) => {
  const { store, userDataDir } = tempStore(t, 'position-worker-recovery-');
  t.after(() => store.close());
  const files = ['A', 'B', 'C'].map((suffix) => {
    const filePath = path.join(userDataDir, `${suffix}.xlsx`);
    fs.writeFileSync(filePath, `file-${suffix}`);
    return {
      ...inputEvidence(filePath),
      archivePath: filePath,
      stagingDir: path.join(userDataDir, `stage-${suffix}`),
      status: 'ok',
      fileName: `${suffix}.xlsx`
    };
  });
  let checkpoint = store.persistenceCheckpoint();
  for (const [index, file] of files.slice(0, 2).entries()) {
    const mutation = runPositionSideDbMutation({
      db: store.db,
      expectedCheckpoint: checkpoint,
      operationToken: 'worker-exit-operation',
      requireExternalOperationToken: true,
      inputEvidence: [file],
      mutate: ({ db }) => {
        db.prepare(`
          INSERT INTO position_revisions(kind, scope_key, revision)
          VALUES ('recovery', ?, 1)
        `).run(`file-${index}`);
      }
    });
    checkpoint = mutation.nextCheckpoint;
  }

  const recovery = recoverPositionImportWorkerExit({
    sideDbPath: store.dbPath,
    baseCheckpoint: INITIAL_CHECKPOINT,
    operationToken: 'worker-exit-operation',
    preflightReady: {
      acceptedOrdinaryInputFiles: files.map((file) => ({
        status: 'ok',
        archivePath: file.archivePath,
        sourceType: file.sourceType,
        stagedSnapshot: file.sourceSnapshot,
        stagedSha256: file.sha256,
        stagedSizeBytes: file.sizeBytes
      })),
      orderedFileResults: files.map((file, fileIndex) => ({
        status: 'ok',
        fileIndex,
        archivePath: file.archivePath,
        stagingDir: file.stagingDir,
        sourceType: file.sourceType,
        fileName: file.fileName
      }))
    },
    workerError: {
      code: 'position-import-worker-exited'
    }
  });
  assert.equal(recovery.status, 'ok');
  assert.equal(recovery.successCount, 2);
  assert.equal(recovery.failedCount, 1);
  assert.deepEqual(
    recovery.results.map((item) => item.status),
    ['ok', 'ok', 'failed']
  );
  assert.equal(recovery.inputFiles.length, 2);
  assert.equal(recovery.committedMutations, 2);
  assert.deepEqual(recovery.checkpoint, checkpoint);
});

test('银行批次不得套用普通来源的逐文件恢复算法', () => {
  assert.throws(
    () => rebuildOrdinarySourceResult({
      kind: 'bank',
      acceptedBankFiles: [{ archivePath: '/tmp/bank.xlsx' }],
      acceptedOrdinaryInputFiles: [],
      orderedFileResults: []
    }, {
      committedInputs: [],
      committedMutations: 0
    }, null),
    (error) => error && error.code === 'position-recovery-required'
  );
});
