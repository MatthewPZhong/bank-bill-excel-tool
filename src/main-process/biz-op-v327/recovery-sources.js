'use strict';

const { normalizeRecoverySource } = require('../background-execution/recovery-source');
const { ACTIONS, CATALOG_SCOPE, identity, sameSource, sourceKey, registryKeys, fail, hash, snapshot } = require('./contracts');

function createBizOpRecoverySources({ catalog, protection, payloadStore, readRepository, getArchiveService }) {
  const { db, now } = catalog;
  let frozenSources = null;
  let budget = null;
  let beforeFinalize = async () => {};
  let beforeCommitted = async () => {};
  let publication = null;
  function installBudget(value) { budget = value; }
  function makeSource(op, category, extra = {}, reference = op.source_ref) {
    return { contractVersion: 1, sourceKind: category === 'OPERATION' ? op.source_kind : 'module-recovery',
      sourceRef: reference, actionKey: op.action_key, operationKey: op.operation_key, taskRunId: op.task_run_id,
      conflictScopeKey: CATALOG_SCOPE, ...registryKeys(category === 'RECLAIM' ? 'RECLAIM' : op.action),
      intentId: null, evidenceVersion: 1,
      boundedEvidence: { category, intentDigest: op.intent_digest, ...extra } };
  }
  function collect() {
    budget.begin('enumerations');
    const sources = new Map();
    let byteSize = 0;
    function add(raw) {
      budget.charge('normalized');
      const serialized = JSON.stringify(raw);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > budget.limits.singleSourceBytes) budget.reject('BIZOP_RECOVERY_SOURCE_TOO_LARGE');
      const source = normalizeRecoverySource(raw);
      const key = sourceKey(source);
      if (sources.has(key)) {
        if (hash(sources.get(key)) !== hash(source)) fail('BIZOP_RECOVERY_SOURCE_CONFLICT');
        return;
      }
      if (sources.size >= budget.limits.sources || byteSize + bytes > budget.limits.sourceBytes) {
        budget.reject('BIZOP_RECOVERY_SNAPSHOT_LIMIT');
      }
      catalog.assertTask(catalog.operation(source.taskRunId));
      sources.set(key, source);
      byteSize += bytes;
    }
    // iterate 限制应用内存；完整性不依赖 settlement 的 COMPLETE 缓存标记。
    for (const row of db.prepare(`SELECT p.task_run_id FROM biz_op_v327_prepared_ops p
      JOIN biz_op_v327_settlement_progress s USING(task_run_id)
      JOIN archive_task_runs t USING(task_run_id)
      WHERE p.action!='RECLAIM' AND (p.phase!='CLOSED' OR s.state!='COMPLETE'
        OR t.status NOT IN ('succeeded','failed','cancelled')) ORDER BY p.task_run_id`).iterate()) {
      add(makeSource(catalog.operation(row.task_run_id), 'OPERATION'));
    }
    for (const row of db.prepare('SELECT * FROM biz_op_v327_read_pins ORDER BY task_run_id,session_id,object_kind,object_id').iterate()) {
      const evidence = { sessionId: row.session_id, objectKind: row.object_kind, objectId: row.object_id,
        manifestDigest: row.manifest_digest, readPlanDigest: row.read_plan_digest };
      add(makeSource(catalog.operation(row.task_run_id), 'READ', evidence,
        `biz-op-v327:read:${hash([row.task_run_id, evidence])}`));
    }
    for (const row of db.prepare(`SELECT * FROM biz_op_v327_dispatches
      WHERE state!='CLOSED' AND process_exit_evidence_json IS NULL ORDER BY task_run_id,dispatch_nonce`).iterate()) {
      add(makeSource(catalog.operation(row.task_run_id), 'CARRIER', { dispatchNonce: row.dispatch_nonce },
        `biz-op-v327:carrier:${row.dispatch_nonce}`));
    }
    for (const row of db.prepare(`SELECT q.* FROM biz_op_v327_reclaim_queue q
      JOIN archive_task_runs t ON t.task_run_id=q.owner_task_run_id
      WHERE q.state!='DONE' OR t.status NOT IN ('succeeded','failed','cancelled') ORDER BY q.reclaim_id`).iterate()) {
      add(makeSource(catalog.operation(row.owner_task_run_id), 'RECLAIM', { reclaimId: row.reclaim_id }));
    }
    for (const row of db.prepare("SELECT source_json FROM biz_op_v327_recovery_followups WHERE state!='COMPLETE'").iterate()) {
      add(JSON.parse(row.source_json));
    }
    for (const hold of readRepository.listActiveRecoveryHolds()) {
      if (!ACTIONS[hold.actionKey]) continue;
      const key = sourceKey(hold);
      if (!sources.has(key)) {
        const followup = db.prepare('SELECT source_json FROM biz_op_v327_recovery_followups WHERE source_kind=? AND source_ref=?')
          .get(hold.sourceKind, hold.sourceRef);
        const op = catalog.operation(hold.taskRunId);
        if (followup) add(JSON.parse(followup.source_json));
        else if (op && hold.sourceRef.startsWith('biz-op-v327:carrier:')) {
          const nonce = hold.sourceRef.slice('biz-op-v327:carrier:'.length);
          const carrier = db.prepare('SELECT 1 FROM biz_op_v327_dispatches WHERE task_run_id=? AND dispatch_nonce=?')
            .get(op.task_run_id, nonce);
          if (!carrier) fail('BIZOP_RECOVERY_CARRIER_SOURCE_MISSING');
          add(makeSource(op, 'CARRIER', { dispatchNonce: nonce }, hold.sourceRef));
        }
        else if (op && op.source_ref === hold.sourceRef) add(makeSource(op, op.action === 'RECLAIM' ? 'RECLAIM' : 'OPERATION',
          op.action === 'RECLAIM' ? { reclaimId: db.prepare('SELECT reclaim_id FROM biz_op_v327_reclaim_queue WHERE owner_task_run_id=?')
            .get(op.task_run_id).reclaim_id } : {}));
        else fail('BIZOP_RECOVERY_HOLD_SOURCE_MISSING');
      }
      if (!sameSource(sources.get(key), hold)) fail('BIZOP_RECOVERY_HOLD_IDENTITY_CONFLICT');
    }
    frozenSources = Object.freeze([...sources.values()]);
    return frozenSources;
  }
  function finalization(source) {
    return db.prepare('SELECT * FROM biz_op_v327_abort_finalizations WHERE source_kind=? AND source_ref=?')
      .get(source.sourceKind, source.sourceRef) || null;
  }
  function facts(source) {
    const op = catalog.operation(source.taskRunId);
    if (!op || op.intent_digest !== source.boundedEvidence.intentDigest || op.action_key !== source.actionKey
        || op.operation_key !== source.operationKey) fail('BIZOP_RECOVERY_IDENTITY_CHANGED');
    catalog.assertTask(op);
    const publisherFact = op.action === 'EXPORT' && publication ? publication.fact(source.taskRunId) : null;
    const receipt = publisherFact?.receipt || catalog.receipt(source.taskRunId, op.intent_digest);
    const abort = finalization(source);
    const closed = protection.closed(source.taskRunId) && (op.action !== 'EXPORT' || publication?.closed(source.taskRunId));
    const category = source.boundedEvidence.category;
    let outcome = 'unknown';
    let reason = 'CARRIER_OR_INPUT_OBLIGATION_PENDING';
    if (category === 'RECLAIM') {
      const queue = db.prepare('SELECT * FROM biz_op_v327_reclaim_queue WHERE reclaim_id=?')
        .get(source.boundedEvidence.reclaimId);
      if (!queue || queue.owner_task_run_id !== source.taskRunId) fail('BIZOP_RECLAIM_IDENTITY_CHANGED');
      const pinned = db.prepare('SELECT 1 FROM biz_op_v327_read_pins WHERE object_kind=? AND object_id=? LIMIT 1')
        .get(queue.payload_kind, queue.object_id);
      outcome = queue.state === 'DONE' ? 'committed' : pinned ? 'unknown' : 'not-committed';
      reason = queue.state;
    } else if (abort) {
      if (receipt && category === 'OPERATION' || abort.intent_digest !== op.intent_digest) fail('BIZOP_TERMINAL_FACT_CONFLICT');
      outcome = 'compensated'; reason = 'FINALIZATION_RECORDED';
    } else if (receipt && (category === 'OPERATION' || op.action === 'EXPORT')) {
      outcome = 'committed'; reason = 'BUSINESS_RECEIPT';
    } else if (op.action === 'UPGRADE') {
      reason = 'ACTIVATION_AUTHORITY_REQUIRED';
    } else if (closed && (op.action !== 'EXPORT' || publisherFact?.state === 'NOT_COMMITTED' || op.input_obligation === 'COMPLETE')) {
      outcome = 'not-committed'; reason = 'MAIN_FINALIZATION_REQUIRED';
    }
    return { op, receipt, abort, outcome, evidence: { category, reason, closed,
      closureDigest: protection.closureDigest(source.taskRunId), inputObligation: op.input_obligation,
      intentDigest: op.intent_digest, receiptPresent: Boolean(receipt), terminalPresent: Boolean(abort) } };
  }
  function inspect(source) {
    budget.charge('inspector');
    protection.refresh(source.taskRunId);
    const current = facts(source);
    // 收据优先；没有收据时仍需证明原始 intent 可读且未被改动。
    if (!current.receipt && current.op.action !== 'RECLAIM') {
      const intent = payloadStore.readDocument(current.op.intent_rel_path).value;
      if (hash(intent) !== current.op.intent_digest) fail('BIZOP_INTENT_FILE_CHANGED');
    }
    return snapshot({ contractVersion: 1, ...identity(source), outcome: current.outcome, evidenceVersion: 1,
      evidenceHash: hash(current.evidence), boundedEvidence: current.evidence });
  }
  async function recoverCommitted(source, inspection) {
    budget.charge('provider');
    const current = facts(source);
    if (inspection.outcome !== 'committed' || current.outcome !== 'committed') fail('BIZOP_PROVIDER_COMMITTED_ONLY');
    await beforeCommitted(source.taskRunId, { admit: budget.admit });
    let completed = false;
    if (source.boundedEvidence.category === 'RECLAIM') completed = true;
    else if (current.op.action === 'EXPORT' && current.evidence.closed) completed = await publication.settle(source.taskRunId);
    else if (current.op.action !== 'EXPORT' && current.evidence.closed && getArchiveService()) {
      const service = getArchiveService();
      const batches = db.prepare('SELECT id FROM archive_batches WHERE task_run_id=? ORDER BY id').all(source.taskRunId);
      completed = true;
      for (const row of batches) {
        const batch = catalog.archive.getBatch(row.id);
        const artifacts = catalog.archive.listArtifacts(row.id);
        if (artifacts.some((file) => file.status !== 'ready')) { completed = false; break; }
        const settled = await service.settleManifestArtifacts({
          batchContext: { ...batch, batchId: batch.id }, files: artifacts.map((file) => ({ artifactKey: file.artifactKey,
            expectedSha256: file.blob.sha256, expectedSizeBytes: file.blob.sizeBytes }))
        });
        if (!settled.ok || !settled.durable) { completed = false; break; }
      }
      if (completed) {
        protection.completeInputObligation(source.taskRunId);
        protection.releasePins(source.taskRunId);
      }
    }
    const boundedResult = { archiveSettled: completed, receiptPreserved: Boolean(current.receipt) };
    return snapshot({ contractVersion: 1, ...identity(source), settlementKey: source.settlementKey,
      inspectionEvidenceHash: inspection.evidenceHash, outcome: completed ? 'completed' : 'incomplete',
      resultVersion: 1, resultHash: hash(boundedResult), boundedResult, safeError: null, retryAfterMs: null });
  }
  function assertCurrentHold(source) {
    const hold = readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey);
    if (hold && !sameSource(hold, source)) fail('BIZOP_HOLD_OWNER_CHANGED');
  }
  async function finalize(source, inspection) {
    budget.charge('main');
    assertCurrentHold(source);
    if (inspection.outcome !== 'not-committed') fail('BIZOP_FRESH_INSPECTION_REQUIRED');
    await beforeFinalize(source.taskRunId);
    const current = facts(source);
    if (current.outcome !== 'not-committed' || hash(current.evidence) !== inspection.evidenceHash) fail('BIZOP_RECOVERY_FACTS_CHANGED');
    if (source.boundedEvidence.category === 'RECLAIM') return reconcileReclaim(source);
    const intent = payloadStore.readDocument(current.op.intent_rel_path).value;
    const inventory = source.boundedEvidence.category === 'OPERATION'
      ? payloadStore.abortInventory(source.taskRunId, intent.candidateRefs || (intent.candidateRef ? [intent.candidateRef] : []), current.op.intent_digest)
      : { files: [], directories: [] };
    const cleanup = { schemaVersion: 1, taskRunId: source.taskRunId, sourceRef: source.sourceRef,
      intentDigest: current.op.intent_digest, ...inventory };
    const relative = `operations/${source.taskRunId}/abort-${hash(sourceKey(source)).slice(0, 24)}.json`;
    const plan = payloadStore.writeDocument(relative, cleanup);
    return catalog.transaction(() => {
      assertCurrentHold(source);
      const latest = facts(source);
      if (latest.outcome !== 'not-committed' || hash(latest.evidence) !== inspection.evidenceHash) fail('BIZOP_RECOVERY_FACTS_CHANGED');
      if (latest.op.action !== 'EXPORT') protection.completeInputObligation(source.taskRunId);
      else publication.completeInput(source.taskRunId);
      protection.releasePins(source.taskRunId);
      if (source.boundedEvidence.category === 'OPERATION') catalog.releaseOwnedHolds('v327-prepare', source.taskRunId);
      const ref = `finalization-${hash(sourceKey(source))}`;
      db.prepare(`INSERT INTO biz_op_v327_recovery_followups
        (source_kind,source_ref,task_run_id,action_key,operation_key,intent_digest,inspection_evidence_digest,
         source_json,state,finalization_ref,updated_at) VALUES (?,?,?,?,?,?,?,?,'CONTROL_PENDING',?,?)
         ON CONFLICT(source_kind,source_ref) DO NOTHING`).run(source.sourceKind, source.sourceRef, source.taskRunId,
        source.actionKey, source.operationKey, latest.op.intent_digest, inspection.evidenceHash, JSON.stringify(source), ref, now());
      db.prepare(`INSERT INTO biz_op_v327_abort_finalizations
        (finalization_ref,source_kind,source_ref,task_run_id,action_key,operation_key,intent_digest,
         inspection_evidence_digest,closure_manifest_digest,terminal_reason,cleanup_plan_digest,cleanup_plan_rel_path,finalized_at)
        VALUES (?,?,?,?,?,?,?,?,?,'FAILED',?,?,?) ON CONFLICT(source_kind,source_ref) DO NOTHING`)
        .run(ref, source.sourceKind, source.sourceRef, source.taskRunId, source.actionKey, source.operationKey,
          latest.op.intent_digest, inspection.evidenceHash, latest.evidence.closureDigest, plan.digest, relative, now());
      if (inventory.directories.length) {
        catalog.enqueueReclaim({ ownerTaskRunId: source.taskRunId, payloadKind: 'ABORTED_STAGE',
          objectId: source.taskRunId, manifestDigest: plan.digest, planRelPath: relative });
      }
      return true;
    });
  }
  async function reconcileReclaim(source) {
    // 已开始回收的目录可能缺少部分文件；此处只确认授权，实际幂等物理回收由专用实现承接。
    if (!reclaimHandler) fail('BIZOP_RECLAIM_HANDLER_REQUIRED');
    return reclaimHandler(source, { admit: budget.admit });
  }
  let reclaimHandler = null;
  function syncCompletion(source) {
    const task = catalog.task(source.taskRunId);
    const hold = readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey);
    if (hold && sameSource(source, hold) || !task || !['succeeded', 'failed', 'cancelled'].includes(task.status)) return false;
    const current = facts(source);
    if (!['compensated', 'committed'].includes(current.outcome) || !protection.closed(source.taskRunId)) return false;
    if (current.op.action === 'EXPORT' && (!publication.closed(source.taskRunId)
        || current.outcome === 'committed' && !publication.record(source.taskRunId)?.cleanup_completed)) return false;
    if (db.prepare('SELECT 1 FROM biz_op_v327_read_pins WHERE task_run_id=? LIMIT 1').get(source.taskRunId)) return false;
    return catalog.transaction(() => {
      let changes = db.prepare(`UPDATE biz_op_v327_recovery_followups SET state='COMPLETE',updated_at=?
        WHERE source_kind=? AND source_ref=? AND state!='COMPLETE'`).run(now(), source.sourceKind, source.sourceRef).changes;
      if (['OPERATION', 'RECLAIM'].includes(source.boundedEvidence.category)) {
        changes += db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='CLOSED',updated_at=? WHERE task_run_id=? AND phase!='CLOSED'")
          .run(now(), source.taskRunId).changes;
        changes += db.prepare(`UPDATE biz_op_v327_settlement_progress SET state='COMPLETE',task_terminal_observed_at=?,
          archive_terminal_observed_at=?,updated_at=? WHERE task_run_id=? AND state!='COMPLETE'`)
          .run(now(), now(), now(), source.taskRunId).changes;
      }
      return changes > 0;
    });
  }
  function register(inspectors, providers) {
    for (const kind of ['IMPORT', 'RECLAIM', 'EXPORT']) {
      const keys = registryKeys(kind);
      inspectors.register(keys.inspectorKey, inspect);
      providers.register(keys.settlementKey, {
        listOpenSources() {
          if (!frozenSources) fail('BIZOP_COMPLETE_ENUMERATION_REQUIRED');
          return frozenSources.filter((source) => source.settlementKey === keys.settlementKey);
        }, recover: recoverCommitted
      });
    }
  }
  return Object.freeze({ collect, register, installBudget, inspect, facts, finalize, syncCompletion,
    setPublication(value) { publication = value; },
    async prepareSource(source) {
      if (catalog.operation(source.taskRunId).action !== 'EXPORT' || !publication) return;
      budget.charge('main'); assertCurrentHold(source);
      protection.refresh(source.taskRunId);
      const op = catalog.operation(source.taskRunId);
      if (hash(payloadStore.readDocument(op.intent_rel_path).value) !== op.intent_digest) fail('BIZOP_INTENT_FILE_CHANGED');
      await publication.reconcile(source.taskRunId);
    },
    async afterSource(source) {
      if (catalog.operation(source.taskRunId).action !== 'EXPORT' || !publication) return;
      budget.charge('main'); assertCurrentHold(source);
      await publication.acknowledge(source.taskRunId);
    },
    setBeforeFinalize(handler) { beforeFinalize = handler; },
    setBeforeCommitted(handler) { beforeCommitted = handler; },
    operationSource(taskRunId) { return makeSource(catalog.operation(taskRunId), 'OPERATION'); },
    setReclaimHandler(handler) { reclaimHandler = handler; },
    current: () => frozenSources, clear() { frozenSources = null; budget = null; } });
}

module.exports = { createBizOpRecoverySources };
