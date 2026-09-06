'use strict';

const { fail, opaque, digest, hash, snapshot } = require('./contracts');

const IDENTITY_FIELDS = {
  taskRunId: 'task_run_id', sessionId: 'session_id', jobId: 'job_id', actionKey: 'action_key',
  taskKey: 'task_key', operationKey: 'operation_key', workerInstanceId: 'worker_instance_id',
  runtimeInstanceId: 'runtime_instance_id', processInstanceId: 'process_instance_id',
  dispatchNonce: 'dispatch_nonce', carrierKind: 'carrier_kind'
};

function createBizOpReadProtection({ catalog, payloadStore }) {
  const { db, transaction, now } = catalog;
  const controls = new Map();
  function dispatch(identity) {
    return db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND session_id=? AND job_id=?')
      .get(identity.taskRunId, identity.sessionId, identity.jobId) || null;
  }
  function assertIdentity(row, identity) {
    if (!row || Object.entries(IDENTITY_FIELDS).some(([key, column]) => row[column] !== identity[key])) {
      fail('BIZOP_CARRIER_IDENTITY_MISMATCH');
    }
  }
  function assertReadable({ objectKind, objectId, manifestDigest }) {
    opaque(objectId); digest(manifestDigest);
    const target = objectKind === 'DATASET'
      ? db.prepare("SELECT payload_manifest_digest AS digest FROM biz_op_v327_datasets WHERE dataset_id=? AND state='ACTIVE'").get(objectId)
      : objectKind === 'RESULT'
        ? db.prepare("SELECT payload_manifest_digest AS digest FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(objectId)
        : objectKind === 'DIAGNOSTIC'
          ? db.prepare("SELECT manifest_digest AS digest FROM biz_op_v327_diagnostic_reports WHERE report_ref=? AND state='READY'").get(objectId)
          : null;
    if (!target || target.digest !== manifestDigest) fail('BIZOP_READ_OBJECT_UNAVAILABLE');
  }
  function beforeDispatch(identity, planDigest, reads = []) {
    const op = catalog.operation(identity.taskRunId);
    if (!op || op.action_key !== identity.actionKey || op.operation_key !== identity.operationKey
        || !['PREPARING', 'SEALED'].includes(op.phase) || identity.carrierKind !== 'thread-single'
        || db.prepare('SELECT 1 FROM biz_op_v327_abort_finalizations WHERE task_run_id=?').get(identity.taskRunId)) {
      fail('BIZOP_DISPATCH_NOT_PREPARED');
    }
    catalog.assertTask(op); digest(planDigest);
    return transaction(() => {
      const old = dispatch(identity);
      if (old) {
        assertIdentity(old, identity);
        if (old.plan_digest !== planDigest) fail('BIZOP_DISPATCH_PLAN_CONFLICT');
        return;
      }
      const timestamp = now();
      db.prepare(`INSERT INTO biz_op_v327_dispatches
        (task_run_id,session_id,job_id,action_key,task_key,operation_key,worker_instance_id,
         runtime_instance_id,process_instance_id,owner_pid,dispatch_nonce,carrier_kind,plan_digest,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'STARTING',?,?)`).run(
        ...Object.keys(IDENTITY_FIELDS).slice(0, 9).map((key) => opaque(identity[key])), process.pid,
        opaque(identity.dispatchNonce), identity.carrierKind, planDigest, timestamp, timestamp);
      for (const read of reads) {
        assertReadable(read);
        db.prepare(`INSERT INTO biz_op_v327_read_pins
          (task_run_id,session_id,object_kind,object_id,manifest_digest,read_plan_digest,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'ACTIVE',?,?) ON CONFLICT(task_run_id,session_id,object_kind,object_id) DO NOTHING`)
          .run(identity.taskRunId, identity.sessionId, read.objectKind, read.objectId, read.manifestDigest,
            planDigest, timestamp, timestamp);
        const pin = db.prepare(`SELECT * FROM biz_op_v327_read_pins
          WHERE task_run_id=? AND session_id=? AND object_kind=? AND object_id=?`)
          .get(identity.taskRunId, identity.sessionId, read.objectKind, read.objectId);
        if (pin.read_plan_digest !== planDigest || pin.manifest_digest !== read.manifestDigest) fail('BIZOP_READ_PIN_CONFLICT');
        db.prepare(`INSERT INTO biz_op_v327_pin_dispatches(task_run_id,session_id,object_kind,object_id,job_id)
          VALUES (?,?,?,?,?)`).run(identity.taskRunId, identity.sessionId, read.objectKind, read.objectId, identity.jobId);
      }
    });
  }
  function persistObservation(observation) {
    const row = dispatch(observation);
    assertIdentity(row, observation);
    const { evidenceDigest, ...body } = observation;
    if (hash(body) !== digest(evidenceDigest) || observation.contractVersion !== 1
        || observation.noUndeclaredChildren !== true) fail('BIZOP_CLOSURE_EVIDENCE_INVALID');
    if (observation.observationSequence < row.closure_observation_seq) return false;
    if (observation.observationSequence === row.closure_observation_seq) {
      if (row.closure_evidence_digest !== evidenceDigest) fail('BIZOP_CLOSURE_SEQUENCE_CONFLICT');
      return false;
    }
    const closed = observation.disposition === 'NOT_CREATED' || (observation.disposition === 'EXITED'
      && (observation.exitObserved || observation.terminateSettled) && observation.closeSettled);
    if (['EXITED', 'NOT_CREATED'].includes(row.closure_disposition) && !closed) fail('BIZOP_CLOSURE_REGRESSION');
    db.prepare(`UPDATE biz_op_v327_dispatches SET state=?,closure_observation_seq=?,closure_disposition=?,
      closure_evidence_digest=?,closure_evidence_json=?,updated_at=? WHERE task_run_id=? AND session_id=? AND job_id=?`)
      .run(closed ? 'CLOSED' : 'RECOVERY_BLOCKED', observation.observationSequence, observation.disposition,
        evidenceDigest, JSON.stringify(snapshot(observation)), now(), row.task_run_id, row.session_id, row.job_id);
    return true;
  }
  function attachControl(control) {
    const identity = control.carrierIdentity;
    if (!identity || typeof control.getCarrierObservation !== 'function') fail('BIZOP_CLOSURE_CONTROL_REQUIRED');
    // start() 可能尚在等待 beforeCarrierDispatch；首次持久观察由该 hook 完成后刷新。
    controls.set(identity.dispatchNonce, control);
  }
  function refresh(taskRunId) {
    for (const [nonce, control] of controls) {
      if (control.carrierIdentity.taskRunId === taskRunId && !dispatch(control.carrierIdentity)
          && control.getCarrierObservation().disposition === 'NOT_CREATED') controls.delete(nonce);
    }
    for (const row of db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=?').iterate(taskRunId)) {
      const control = controls.get(row.dispatch_nonce);
      if (control) {
        const observed = control.getCarrierObservation();
        persistObservation(observed);
        if (['NOT_CREATED', 'EXITED'].includes(observed.disposition)) controls.delete(row.dispatch_nonce);
      }
      else if (row.state !== 'CLOSED' && row.owner_pid !== process.pid) {
        // 进程标识变化不等于旧线程退出。只有 OS 明确证明原 Main PID 不存在才收口。
        let absent = false;
        try { process.kill(row.owner_pid, 0); } catch (error) { absent = error.code === 'ESRCH'; }
        if (absent) {
          const evidence = { contractVersion: 1, ownerPid: row.owner_pid, processInstanceId: row.process_instance_id,
            dispatchNonce: row.dispatch_nonce, nativeThreadsEndedWithProcess: true };
          db.prepare('UPDATE biz_op_v327_dispatches SET process_exit_evidence_json=?,updated_at=? WHERE dispatch_nonce=?')
            .run(JSON.stringify(evidence), now(), row.dispatch_nonce);
        }
      }
    }
  }
  function rowClosed(row) {
    if (row.state === 'CLOSED' && ['NOT_CREATED', 'EXITED'].includes(row.closure_disposition)
        && row.closure_evidence_digest && row.closure_evidence_json) {
      const observation = JSON.parse(row.closure_evidence_json);
      assertIdentity(row, observation);
      const { evidenceDigest, ...body } = observation;
      if (hash(body) !== evidenceDigest || evidenceDigest !== row.closure_evidence_digest
          || observation.disposition !== row.closure_disposition || observation.noUndeclaredChildren !== true) return false;
      return observation.disposition === 'NOT_CREATED' || Boolean(observation.closeSettled
        && (observation.exitObserved || observation.terminateSettled));
    }
    if (!row.process_exit_evidence_json) return false;
    const evidence = JSON.parse(row.process_exit_evidence_json);
    return evidence.ownerPid === row.owner_pid && evidence.processInstanceId === row.process_instance_id
      && evidence.dispatchNonce === row.dispatch_nonce && evidence.nativeThreadsEndedWithProcess === true;
  }
  function closed(taskRunId) {
    const rows = db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=?').all(taskRunId);
    // 没有派发表意味着 Main 的 before-dispatch 事务从未完成，不能已有载体。
    return rows.every(rowClosed);
  }
  function closureDigest(taskRunId) {
    const facts = db.prepare(`SELECT dispatch_nonce,closure_evidence_digest,process_exit_evidence_json
      FROM biz_op_v327_dispatches WHERE task_run_id=? ORDER BY dispatch_nonce`).all(taskRunId);
    return hash(facts);
  }
  function completeInputObligation(taskRunId) {
    if (!closed(taskRunId)) fail('BIZOP_CARRIER_STILL_OPEN');
    const op = catalog.operation(taskRunId);
    if (!op || op.action === 'EXPORT') fail('BIZOP_PUBLISHER_AUTHORITY_REQUIRED');
    db.prepare("UPDATE biz_op_v327_settlement_progress SET input_obligation='COMPLETE',updated_at=? WHERE task_run_id=?")
      .run(now(), taskRunId);
  }
  function canRelease(taskRunId) {
    const op = catalog.operation(taskRunId);
    return Boolean(op && op.input_obligation === 'COMPLETE' && closed(taskRunId));
  }
  function releasePins(taskRunId) {
    return transaction(() => {
      if (!canRelease(taskRunId)) fail('BIZOP_READER_OBLIGATION_PENDING');
      db.prepare('DELETE FROM biz_op_v327_pin_dispatches WHERE task_run_id=?').run(taskRunId);
      return db.prepare('DELETE FROM biz_op_v327_read_pins WHERE task_run_id=?').run(taskRunId).changes;
    });
  }
  function registerDiagnostic({ taskRunId, jobId, sessionId, token, sampleCount, sampleBytes, scanComplete, errorCountExact }) {
    const { readVerifiedManifest } = require('./payload-store');
    const manifest = readVerifiedManifest(token);
    const carrier = db.prepare(`SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND job_id=? AND session_id=?`)
      .get(taskRunId, jobId, sessionId);
    if (!carrier || manifest.taskRunId !== taskRunId || manifest.objectKind !== 'DIAGNOSTIC') fail('BIZOP_REPORT_OWNER_MISMATCH');
    if (manifest.intentDigest !== catalog.operation(taskRunId).intent_digest || manifest.rowCount !== sampleCount
        || manifest.parts.length !== 1 || manifest.parts[0].byteSize !== sampleBytes) fail('BIZOP_REPORT_SUMMARY_MISMATCH');
    return transaction(() => {
      db.prepare(`INSERT INTO biz_op_v327_diagnostic_reports
        (report_ref,task_run_id,producer_job_id,producer_session_id,manifest_digest,report_rel_path,
         sample_count,sample_bytes,scan_complete,error_count_exact,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'READY',?)`).run(manifest.objectId, taskRunId, jobId, sessionId, manifest.digest,
        pathOfReport(manifest), sampleCount, sampleBytes, scanComplete ? 1 : 0, errorCountExact ? 1 : 0, now());
      db.prepare(`INSERT INTO biz_op_v327_diagnostic_lifecycle(report_ref,sealed_manifest_rel_path,updated_at)
        VALUES (?,?,?)`).run(manifest.objectId, manifest.relativePath, now());
      return manifest.objectId;
    });
  }
  function retireDiagnostic(reportRef, ownerTaskRunId) {
    return transaction(() => {
      const row = db.prepare(`SELECT d.*,l.sealed_manifest_rel_path FROM biz_op_v327_diagnostic_reports d
        JOIN biz_op_v327_diagnostic_lifecycle l USING(report_ref) WHERE report_ref=?`).get(reportRef);
      if (!row || row.state === 'DELETED') return null;
      db.prepare("UPDATE biz_op_v327_diagnostic_reports SET state='RETIRED' WHERE report_ref=?").run(reportRef);
      db.prepare('UPDATE biz_op_v327_diagnostic_lifecycle SET retired_at=COALESCE(retired_at,?),updated_at=? WHERE report_ref=?')
        .run(now(), now(), reportRef);
      return catalog.enqueueReclaim({ ownerTaskRunId, payloadKind: 'DIAGNOSTIC', objectId: reportRef,
        manifestDigest: row.manifest_digest, planRelPath: row.sealed_manifest_rel_path });
    });
  }
  function pathOfReport(manifest) {
    if (manifest.parts.length !== 1 || !manifest.parts[0].name.endsWith('.jsonl')) fail('BIZOP_REPORT_SCHEMA_INVALID');
    const relative = `diagnostics/${manifest.objectId}/${manifest.parts[0].name}`;
    payloadStore.resolve(relative);
    return relative;
  }
  return Object.freeze({ beforeDispatch, attachControl, refresh, closed, closureDigest, completeInputObligation,
    canRelease, releasePins, assertReadable, registerDiagnostic, retireDiagnostic });
}

module.exports = { createBizOpReadProtection };
