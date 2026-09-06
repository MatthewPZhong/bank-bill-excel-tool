'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createArchiveRepository, withWriteTransaction } = require('../../backend/database/archive-repository');
const { ACTIONS, MODULE_ID, fail, opaque, digest, count, hash, snapshot } = require('./contracts');
const { readVerifiedManifest } = require('./payload-store');

function createBizOpCatalog(db, { assertCommitReady }) {
  const archive = createArchiveRepository(db);
  archive.ensureSchema();
  withWriteTransaction(db, () => db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')));
  if (db.prepare('SELECT schema_version FROM biz_op_v327_control WHERE singleton=1').get().schema_version !== 1) {
    fail('BIZOP_SCHEMA_UNSUPPORTED');
  }
  const transaction = (fn) => withWriteTransaction(db, fn);
  const now = () => new Date().toISOString();
  const control = () => db.prepare('SELECT * FROM biz_op_v327_control WHERE singleton=1').get();
  const operation = (taskRunId) => db.prepare(`SELECT p.*,s.action_key,s.task_key,s.operation_key,
    s.source_ref,s.source_kind,s.input_obligation,s.state AS settlement_state FROM biz_op_v327_prepared_ops p
    JOIN biz_op_v327_settlement_progress s USING(task_run_id) WHERE p.task_run_id=?`).get(taskRunId) || null;
  function task(taskRunId) {
    return archive.getTaskRun(opaque(taskRunId));
  }
  function assertTask(op) {
    const row = task(op.task_run_id || op.taskRunId);
    const key = op.action_key || op.actionKey;
    if (!row || !ACTIONS[key] || row.taskKey !== ACTIONS[key].taskKey
        || row.operationKey !== (op.operation_key || op.operationKey) || row.moduleId !== MODULE_ID) {
      fail('BIZOP_TASK_IDENTITY_MISMATCH');
    }
    return row;
  }
  function receipt(taskRunId, intentDigest) {
    const row = db.prepare('SELECT * FROM biz_op_v327_receipts WHERE task_run_id=?').get(taskRunId);
    if (!row) return null;
    if (intentDigest !== undefined && row.intent_digest !== intentDigest) fail('BIZOP_INTENT_CONFLICT');
    return snapshot({ taskRunId: row.task_run_id, action: row.action, intentDigest: row.intent_digest,
      generation: row.generation_after, outcome: JSON.parse(row.outcome_json), committedAt: row.committed_at });
  }
  function receiptState(taskRunId, intentDigest) {
    const saved = receipt(taskRunId, intentDigest);
    if (!saved) return null;
    const datasets = saved.outcome.datasets?.map((item) => item.datasetId) || saved.outcome.datasetIds || [];
    const runs = saved.outcome.runId ? [saved.outcome.runId] : saved.outcome.runIds || [];
    const currentObjects = [
      ...datasets.map((id) => ({ objectKind: 'DATASET', objectId: id,
        state: db.prepare('SELECT state FROM biz_op_v327_datasets WHERE dataset_id=?').get(id)?.state || 'MISSING' })),
      ...runs.map((id) => ({ objectKind: 'RESULT', objectId: id,
        state: db.prepare('SELECT state FROM biz_op_v327_runs WHERE run_id=?').get(id)?.state || 'MISSING' }))
    ].map((item) => ({ ...item, availability: item.state === 'DELETED' ? 'deleted'
      : item.state === 'RETIRED' ? 'retired' : item.state === 'MISSING' ? 'missing' : 'available' }));
    return snapshot({ receipt: saved, currentObjects });
  }
  function committed(taskRunId, intentDigest, action) {
    const saved = receipt(taskRunId, intentDigest);
    if (!saved) return null;
    const op = operation(taskRunId);
    if (!op || op.action !== action || saved.action !== action || op.intent_digest !== intentDigest) {
      fail('BIZOP_RECEIPT_ACTION_MISMATCH');
    }
    assertTask(op);
    return saved;
  }
  function prepare(input) {
    const { taskRunId, actionKey, operationKey, intent, intentRelPath, expectedGeneration } = input;
    opaque(taskRunId); opaque(operationKey); count(expectedGeneration);
    const action = ACTIONS[actionKey];
    if (!action) fail('BIZOP_ACTION_UNKNOWN');
    const intentDigest = hash(intent);
    assertTask({ taskRunId, actionKey, operationKey });
    if (intentRelPath !== `operations/${taskRunId}/intent.json`) fail('BIZOP_INTENT_PATH_INVALID');
    return transaction(() => {
      const existing = operation(taskRunId);
      if (existing) {
        if (existing.intent_digest !== intentDigest || existing.action_key !== actionKey
            || existing.operation_key !== operationKey) fail('BIZOP_INTENT_CONFLICT');
        return existing;
      }
      if (receipt(taskRunId)) fail('BIZOP_PREPARED_RECORD_MISSING');
      const timestamp = now();
      db.prepare(`INSERT INTO biz_op_v327_prepared_ops
        (task_run_id,action,phase,expected_generation,intent_digest,intent_rel_path,created_at,updated_at)
        VALUES (?,?,'PREPARING',?,?,?,?,?)`)
        .run(taskRunId, action.kind, expectedGeneration, intentDigest, intentRelPath, timestamp, timestamp);
      db.prepare(`INSERT INTO biz_op_v327_settlement_progress
        (task_run_id,action_key,task_key,operation_key,source_kind,source_ref,intent_digest,business_fact,state,updated_at)
        VALUES (?,?,?,?,?,?,?,'UNKNOWN','OPEN',?)`).run(taskRunId, actionKey, action.taskKey, operationKey,
        action.kind === 'EXPORT' ? 'publisher-journal' : 'module-recovery',
        `biz-op-v327:operation:${taskRunId}`, intentDigest, timestamp);
      return operation(taskRunId);
    });
  }
  function readyHold(completed, repository) {
    if (repository.db !== db) fail('BIZOP_ARCHIVE_CONNECTION_MISMATCH');
    const { artifact, batch } = completed;
    if (!batch || !String(batch.taskKey).startsWith('bizOpReconV327:') || artifact.direction !== 'input') return;
    const op = operation(batch.taskRunId);
    if (!op || op.action !== 'IMPORT' || op.phase !== 'PREPARING') fail('BIZOP_PREPARE_HOLD_REQUIRED');
    assertTask(op);
    repository.addArtifactHold(artifact.id, { ownerModule: MODULE_ID, ownerType: 'v327-prepare',
      ownerId: op.task_run_id, reason: '候选构建所需原件' });
  }
  function original(artifactId, taskRunId) {
    const file = archive.getArtifact(artifactId);
    if (!file || file.status !== 'ready' || !file.blob || !file.blob.sha256) fail('BIZOP_ORIGINAL_NOT_READY');
    const holds = archive.listArtifactHolds(artifactId);
    if (!holds.some((hold) => hold.ownerModule === MODULE_ID && hold.ownerType === 'v327-prepare'
        && hold.ownerId === taskRunId)) fail('BIZOP_ORIGINAL_UNPROTECTED');
    return { ...file, sha256: file.blob.sha256 };
  }
  function releaseOwnedHolds(type, ownerId) {
    for (const hold of db.prepare(`SELECT artifact_id FROM archive_artifact_holds
      WHERE owner_module=? AND owner_type=? AND owner_id=?`).iterate(MODULE_ID, type, ownerId)) {
      archive.releaseArtifactHold({ artifactId: hold.artifact_id, ownerModule: MODULE_ID, ownerType: type, ownerId });
    }
  }
  function version(scope, key1, key2 = '') {
    return db.prepare(`INSERT INTO biz_op_v327_version_counters(scope,key1,key2,last_version) VALUES (?,?,?,1)
      ON CONFLICT(scope,key1,key2) DO UPDATE SET last_version=last_version+1 RETURNING last_version`)
      .get(scope, key1, key2).last_version;
  }
  function addReceipt(op, generation, outcome) {
    if (db.prepare('SELECT 1 FROM biz_op_v327_abort_finalizations WHERE source_kind=? AND source_ref=?')
      .get(op.source_kind, op.source_ref)) fail('BIZOP_OPERATION_ALREADY_ABORTED');
    db.prepare(`INSERT INTO biz_op_v327_receipts
      (task_run_id,action,intent_digest,generation_after,outcome_json,committed_at) VALUES (?,?,?,?,?,?)`)
      .run(op.task_run_id, op.action, op.intent_digest, generation, JSON.stringify(snapshot(outcome)), now());
    db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='SETTLING',updated_at=? WHERE task_run_id=?")
      .run(now(), op.task_run_id);
    db.prepare("UPDATE biz_op_v327_settlement_progress SET business_fact='COMMITTED',updated_at=? WHERE task_run_id=?")
      .run(now(), op.task_run_id);
    db.prepare('UPDATE biz_op_v327_control SET generation=? WHERE singleton=1').run(generation);
    return receipt(op.task_run_id, op.intent_digest);
  }
  function enqueueReclaim({ ownerTaskRunId, payloadKind, objectId, manifestDigest, planRelPath, receiptTaskRunId = null }) {
    opaque(ownerTaskRunId); opaque(objectId); digest(manifestDigest);
    const existing = db.prepare('SELECT * FROM biz_op_v327_reclaim_queue WHERE payload_kind=? AND object_id=?')
      .get(payloadKind, objectId);
    if (existing) {
      if (existing.manifest_digest !== manifestDigest || existing.plan_rel_path !== planRelPath
          || existing.receipt_task_run_id !== receiptTaskRunId) {
        fail('BIZOP_RECLAIM_PLAN_CONFLICT');
      }
      return existing.reclaim_id;
    }
    const id = `reclaim-${randomUUID()}`;
    const maintenanceTaskId = `reclaim-task-${randomUUID()}`;
    const operationKey = `biz-op-v327:reclaim:${id}`;
    const owner = task(ownerTaskRunId);
    if (!owner) fail('BIZOP_RECLAIM_OWNER_MISSING');
    archive.beginTaskRun({ taskRunId: maintenanceTaskId, moduleId: MODULE_ID,
      taskKey: ACTIONS['biz-op-v327:reclaim'].taskKey, operationKey, parentRunId: owner.parentRunId,
      metadata: { requestedByTaskRunId: ownerTaskRunId } });
    const planDigest = hash({ payloadKind, objectId, manifestDigest, planRelPath });
    db.prepare(`INSERT INTO biz_op_v327_prepared_ops
      (task_run_id,action,phase,expected_generation,intent_digest,intent_rel_path,created_at,updated_at)
      VALUES (?,'RECLAIM','SEALED',?,?,?,?,?)`).run(maintenanceTaskId, control().generation,
      planDigest, planRelPath, now(), now());
    db.prepare(`INSERT INTO biz_op_v327_settlement_progress
      (task_run_id,action_key,task_key,operation_key,source_kind,source_ref,intent_digest,business_fact,state,input_obligation,updated_at)
      VALUES (?,'biz-op-v327:reclaim',?,?,'module-recovery',?,?,'UNKNOWN','OPEN','COMPLETE',?)`)
      .run(maintenanceTaskId, ACTIONS['biz-op-v327:reclaim'].taskKey, operationKey,
        `biz-op-v327:reclaim:${id}`, planDigest, now());
    db.prepare(`INSERT INTO biz_op_v327_reclaim_queue
      (reclaim_id,owner_task_run_id,payload_kind,object_id,manifest_digest,plan_rel_path,receipt_task_run_id,state,created_at)
        VALUES (?,?,?,?,?,?,?,'PENDING',?)`).run(id, maintenanceTaskId, payloadKind, objectId, manifestDigest, planRelPath, receiptTaskRunId, now());
    return id;
  }
  function unusedCandidate(sealed) {
    enqueueReclaim({ ownerTaskRunId: sealed.taskRunId, receiptTaskRunId: sealed.taskRunId, payloadKind: 'UNUSED_CANDIDATE',
      objectId: sealed.objectId, manifestDigest: sealed.digest, planRelPath: sealed.relativePath });
    return { objectId: sealed.objectId, objectKind: sealed.objectKind, manifestDigest: sealed.digest, manifestPath: sealed.relativePath };
  }
  function commitImport({ taskRunId, intentDigest, candidates }) {
    // 幂等先读收据，已删除的原产物及旧 generation 都不能重建一个新业务版本。
    const saved = committed(taskRunId, intentDigest, 'IMPORT');
    if (saved) return saved;
    const verified = candidates.map(readVerifiedManifest);
    return transaction(() => {
      const repeated = committed(taskRunId, intentDigest, 'IMPORT');
      if (repeated) return repeated;
      const op = operation(taskRunId);
      if (!op || op.action !== 'IMPORT' || op.intent_digest !== intentDigest) fail('BIZOP_INTENT_CONFLICT');
      assertTask(op);
      assertCommitReady(op);
      if (control().generation !== op.expected_generation) fail('BIZOP_GENERATION_CHANGED');
      if (db.prepare('SELECT 1 FROM biz_op_v327_abort_finalizations WHERE task_run_id=?').get(taskRunId)) {
        fail('BIZOP_OPERATION_ALREADY_ABORTED');
      }
      if (!verified.length || new Set(verified.map((item) => `${item.catalog.kind}/${item.catalog.dataDate}`)).size
          !== verified.length) fail('BIZOP_CANDIDATE_SET_INVALID');
      const generation = control().generation + 1;
      const published = [];
      const unusedCandidates = [];
      for (const sealed of verified) {
        const entry = sealed.catalog;
        if (sealed.objectKind !== 'DATASET' || sealed.taskRunId !== taskRunId
            || sealed.intentDigest !== intentDigest || !['OP', 'FLOW'].includes(entry.kind)) fail('BIZOP_CANDIDATE_IDENTITY');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.dataDate)) fail('BIZOP_DATE_INVALID');
        const old = db.prepare(`SELECT d.* FROM biz_op_v327_input_heads h JOIN biz_op_v327_datasets d USING(dataset_id)
          WHERE h.kind=? AND h.data_date=?`).get(entry.kind, entry.dataDate);
        if (old && old.input_fingerprint === digest(entry.inputFingerprint)) {
          published.push({ datasetId: old.dataset_id, kind: old.kind, dataDate: old.data_date,
            version: old.public_version, reused: true });
          unusedCandidates.push(unusedCandidate(sealed));
          continue;
        }
        const nextVersion = version(entry.kind, entry.dataDate);
        db.prepare(`INSERT INTO biz_op_v327_datasets
          (dataset_id,kind,data_date,public_version,state,input_fingerprint,source_manifest_digest,
           payload_manifest_rel_path,payload_manifest_digest,row_count,producer_task_id,activated_at)
          VALUES (?,?,?,?,'ACTIVE',?,?,?,?,?,?,?)`).run(sealed.objectId, entry.kind, entry.dataDate, nextVersion,
          digest(entry.inputFingerprint), digest(entry.sourceManifestDigest), sealed.relativePath, sealed.digest,
          count(sealed.rowCount), taskRunId, now());
        if (!Array.isArray(entry.sources) || !entry.sources.length) fail('BIZOP_ORIGINAL_SET_EMPTY');
        for (const source of entry.sources) {
          const file = original(source.artifactId, taskRunId);
          if (file.sha256 !== source.sha256) fail('BIZOP_ORIGINAL_DIGEST_MISMATCH');
          archive.addArtifactHold(file.id, { ownerModule: MODULE_ID, ownerType: 'v327-input',
            ownerId: sealed.objectId, reason: '当前输入版本原件' });
          db.prepare(`INSERT INTO biz_op_v327_dataset_sources
            (dataset_id,artifact_id,source_sha256,source_file_name,source_file_order,source_sheet_name,slice_date,normalized_bu,row_count)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(sealed.objectId, file.id, file.sha256, file.originalName,
            count(source.order), source.sheetName, entry.dataDate, source.bu, count(source.rowCount));
        }
        db.prepare(`INSERT INTO biz_op_v327_input_heads(kind,data_date,dataset_id,published_generation) VALUES (?,?,?,?)
          ON CONFLICT(kind,data_date) DO UPDATE SET dataset_id=excluded.dataset_id,published_generation=excluded.published_generation`)
          .run(entry.kind, entry.dataDate, sealed.objectId, generation);
        if (old) {
          db.prepare("UPDATE biz_op_v327_datasets SET state='RETIRED',retired_at=? WHERE dataset_id=?")
            .run(now(), old.dataset_id);
          releaseOwnedHolds('v327-input', old.dataset_id);
          db.prepare('DELETE FROM biz_op_v327_dataset_sources WHERE dataset_id=?').run(old.dataset_id);
          enqueueReclaim({ ownerTaskRunId: taskRunId, payloadKind: 'DATASET', objectId: old.dataset_id,
            manifestDigest: old.payload_manifest_digest, planRelPath: old.payload_manifest_rel_path });
        }
        published.push({ datasetId: sealed.objectId, kind: entry.kind, dataDate: entry.dataDate,
          version: nextVersion, reused: false });
      }
      releaseOwnedHolds('v327-prepare', taskRunId);
      return addReceipt(op, generation, { datasets: published, unusedCandidates });
    });
  }
  function commitRun({ taskRunId, intentDigest, candidate }) {
    const saved = committed(taskRunId, intentDigest, 'RUN');
    if (saved) return saved;
    const sealed = readVerifiedManifest(candidate);
    return transaction(() => {
      const repeated = committed(taskRunId, intentDigest, 'RUN');
      if (repeated) return repeated;
      const op = operation(taskRunId);
      if (!op || op.action !== 'RUN' || op.intent_digest !== intentDigest || sealed.intentDigest !== intentDigest
          || sealed.taskRunId !== taskRunId || sealed.objectKind !== 'RESULT') fail('BIZOP_RUN_IDENTITY_MISMATCH');
      assertTask(op);
      assertCommitReady(op);
      if (control().generation !== op.expected_generation) fail('BIZOP_GENERATION_CHANGED');
      const info = sealed.catalog;
      if (!Array.isArray(info.inputs) || !info.inputs.length || count(info.fullRowCount) !== sealed.rowCount
          || count(info.diffRowCount) > info.fullRowCount || !/^\d{4}-\d{2}-\d{2}$/.test(info.startDate)
          || !/^\d{4}-\d{2}-\d{2}$/.test(info.endDate) || info.startDate >= info.endDate
          || new Set(info.inputs.map((item) => `${item.role}/${item.dataDate}`)).size !== info.inputs.length) fail('BIZOP_RUN_INPUTS_INVALID');
      const heldArtifacts = new Set();
      const inputs = info.inputs.map((item) => {
        if (item.role === 'START_OP' ? item.dataDate !== info.startDate
          : item.role === 'END_OP' ? item.dataDate !== info.endDate
            : item.role === 'FLOW' ? item.dataDate <= info.startDate || item.dataDate > info.endDate : true) {
          fail('BIZOP_RUN_INPUT_ROLE_INVALID');
        }
        const input = db.prepare(`SELECT d.* FROM biz_op_v327_input_heads h JOIN biz_op_v327_datasets d USING(dataset_id)
          WHERE h.data_date=? AND d.dataset_id=? AND h.kind=?`).get(item.dataDate, item.datasetId, item.role === 'FLOW' ? 'FLOW' : 'OP');
        if (!input || input.public_version !== item.inputVersion || input.source_manifest_digest !== item.sourceManifestDigest) {
          fail('BIZOP_RUN_INPUT_CHANGED');
        }
        return item;
      });
      const existing = db.prepare("SELECT * FROM biz_op_v327_runs WHERE input_fingerprint=? AND state='PUBLISHED'")
        .get(digest(info.inputFingerprint));
      if (existing) return addReceipt(op, control().generation, { runId: existing.run_id, version: existing.result_version,
        reused: true, unusedCandidates: [unusedCandidate(sealed)] });
      const number = version('RESULT', info.startDate, info.endDate);
      db.prepare(`INSERT INTO biz_op_v327_runs
        (run_id,start_date,end_date,result_version,input_fingerprint,rule_version,state,payload_manifest_rel_path,
         payload_manifest_digest,full_row_count,diff_row_count,producer_task_id,operation_month,published_at)
        VALUES (?,?,?,?,?,?,'PUBLISHED',?,?,?,?,?,?,?)`).run(sealed.objectId, info.startDate, info.endDate, number,
        info.inputFingerprint, info.ruleVersion, sealed.relativePath, sealed.digest, info.fullRowCount, info.diffRowCount,
        taskRunId, now().slice(0, 7), now());
      for (const input of inputs) {
        db.prepare(`INSERT INTO biz_op_v327_run_inputs(run_id,role,data_date,dataset_id,input_version,source_manifest_digest)
          VALUES (?,?,?,?,?,?)`).run(sealed.objectId, input.role, input.dataDate, input.datasetId, input.inputVersion, input.sourceManifestDigest);
        for (const source of db.prepare('SELECT * FROM biz_op_v327_dataset_sources WHERE dataset_id=?').iterate(input.datasetId)) {
          if (heldArtifacts.has(source.artifact_id)) continue;
          archive.addArtifactHold(source.artifact_id, { ownerModule: MODULE_ID, ownerType: 'v327-result',
            ownerId: sealed.objectId, reason: '历史结果独立原件引用' });
          db.prepare('INSERT INTO biz_op_v327_run_artifacts(run_id,artifact_id,source_sha256,source_file_name) VALUES (?,?,?,?)')
            .run(sealed.objectId, source.artifact_id, source.source_sha256, source.source_file_name);
          heldArtifacts.add(source.artifact_id);
        }
      }
      return addReceipt(op, control().generation + 1, { runId: sealed.objectId, version: number, reused: false });
    });
  }
  function deleteIntent({ datasetIds, runIds = [], deleteMode, expectedGeneration }) {
    if (!Array.isArray(datasetIds) || !Array.isArray(runIds)) fail('BIZOP_DELETE_SELECTION_INVALID');
    const selectedDatasets = [...new Set(datasetIds.map((id) => opaque(id)))].sort();
    const selectedRuns = [...new Set(runIds.map((id) => opaque(id)))].sort();
    if ((!selectedDatasets.length && !selectedRuns.length) || selectedDatasets.length + selectedRuns.length > 4096
        || !['KEEP_RESULTS', 'DELETE_ASSOCIATED'].includes(deleteMode)
        || deleteMode === 'KEEP_RESULTS' && selectedRuns.length) fail('BIZOP_DELETE_SELECTION_INVALID');
    return snapshot({ action: 'DELETE', datasetIds: selectedDatasets, runIds: selectedRuns, deleteMode,
      expectedGeneration: count(expectedGeneration) });
  }
  function commitDelete({ taskRunId, intentDigest, intent }) {
    const saved = committed(taskRunId, intentDigest, 'DELETE');
    if (saved) return saved;
    const selected = deleteIntent(intent);
    if (hash(selected) !== intentDigest) fail('BIZOP_DELETE_INTENT_MISMATCH');
    return transaction(() => {
      const repeated = committed(taskRunId, intentDigest, 'DELETE');
      if (repeated) return repeated;
      const op = operation(taskRunId);
      if (!op || op.action !== 'DELETE' || op.intent_digest !== intentDigest) fail('BIZOP_DELETE_INTENT_MISMATCH');
      assertTask(op);
      assertCommitReady(op);
      if (control().generation !== selected.expectedGeneration || op.expected_generation !== selected.expectedGeneration) {
        fail('BIZOP_GENERATION_CHANGED');
      }
      const selectedRuns = new Set(selected.runIds);
      if (selected.deleteMode === 'DELETE_ASSOCIATED') {
        for (const datasetId of selected.datasetIds) {
          for (const run of db.prepare(`SELECT DISTINCT r.run_id FROM biz_op_v327_runs r
            JOIN biz_op_v327_run_inputs i USING(run_id) WHERE i.dataset_id=? AND r.state='PUBLISHED'`).iterate(datasetId)) {
            if (!selectedRuns.has(run.run_id)) fail('BIZOP_DELETE_PREVIEW_INCOMPLETE');
          }
        }
      }
      for (const datasetId of selected.datasetIds) {
        const row = db.prepare('SELECT * FROM biz_op_v327_datasets WHERE dataset_id=?').get(datasetId);
        if (!row) fail('BIZOP_DELETE_DATASET_MISSING');
        db.prepare('DELETE FROM biz_op_v327_input_heads WHERE dataset_id=?').run(datasetId);
        db.prepare("UPDATE biz_op_v327_datasets SET state='DELETED',retired_at=COALESCE(retired_at,?) WHERE dataset_id=?")
          .run(now(), datasetId);
        releaseOwnedHolds('v327-input', datasetId);
        db.prepare('DELETE FROM biz_op_v327_dataset_sources WHERE dataset_id=?').run(datasetId);
        enqueueReclaim({ ownerTaskRunId: taskRunId, payloadKind: 'DATASET', objectId: datasetId,
          manifestDigest: row.payload_manifest_digest, planRelPath: row.payload_manifest_rel_path });
      }
      for (const runId of selected.runIds) {
        const row = db.prepare('SELECT * FROM biz_op_v327_runs WHERE run_id=?').get(runId);
        if (!row) fail('BIZOP_DELETE_RUN_MISSING');
        db.prepare("UPDATE biz_op_v327_runs SET state='DELETED',deleted_at=COALESCE(deleted_at,?) WHERE run_id=?").run(now(), runId);
        releaseOwnedHolds('v327-result', runId);
        db.prepare('DELETE FROM biz_op_v327_run_artifacts WHERE run_id=?').run(runId);
        enqueueReclaim({ ownerTaskRunId: taskRunId, payloadKind: 'RESULT', objectId: runId,
          manifestDigest: row.payload_manifest_digest, planRelPath: row.payload_manifest_rel_path });
      }
      return addReceipt(op, control().generation + 1, { datasetIds: selected.datasetIds, runIds: selected.runIds, deleteMode: selected.deleteMode });
    });
  }
  return Object.freeze({ db, archive, transaction, now, control, operation, task, assertTask, prepare,
    receipt, receiptState, readyHold, original, releaseOwnedHolds, version, enqueueReclaim, commitImport,
    commitRun, deleteIntent, commitDelete });
}

module.exports = { createBizOpCatalog };
