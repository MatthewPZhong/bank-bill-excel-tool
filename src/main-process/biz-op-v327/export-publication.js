'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { publishDurableArtifactAsync, recoverToolboxPublicationsAsync } = require('../toolbox-output-publication-dispatch');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const { fsyncDirectory } = require('../background-execution/durable-file');
const { fail, hash, snapshot } = require('./contracts');
const { acquireBizOpPhaseLease } = require('./phase-admission');
const PHASE = Object.freeze({ cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 1073741824 });

function createBizOpPublication({ userDataDir, catalog, payloadStore, protection, getArchiveService, getRuntime }) {
  const { db, now } = catalog;
  const instance = randomUUID(); const live = new Map();
  const record = (id) => db.prepare('SELECT * FROM biz_op_v327_publications WHERE task_run_id=?').get(id);
  function binding(id) {
    const row = record(id); if (!row) return null;
    const value = payloadStore.readDocument(row.binding_rel_path, row.binding_digest).value;
    const op = catalog.operation(id);
    if (value.taskRunId !== id || value.intentDigest !== op?.intent_digest || value.actionKey !== op.action_key
        || value.batchContext.taskRunId !== id || value.batchContext.operationKey !== op.operation_key) fail('BIZOP_PUBLICATION_BINDING_INVALID');
    catalog.assertTask(op);
    return value;
  }
  function register({ context, intentDigest, sourceDigest, candidateRef, output, targetSnapshot }) {
    const id = context.taskRunId;
    const value = { schemaVersion: 1, taskRunId: id, actionKey: catalog.operation(id).action_key, intentDigest, sourceDigest,
      candidateRef, publisherTaskId: `biz-op-v327-export-${id}`, output, targetSnapshot,
      batchContext: freezeWorkerBatchContext(context, { required: true }) };
    const relative = `operations/${id}/publication-binding.json`;
    const document = payloadStore.writeDocument(relative, value);
    db.prepare(`INSERT INTO biz_op_v327_publications(task_run_id,binding_rel_path,binding_digest,state,updated_at)
      VALUES (?,?,?,'NOT_STARTED',?)`).run(id, relative, document.digest, now());
    return value;
  }
  function closure(row) {
    if (!row?.closure_json || !row.closure_digest) return false;
    const value = JSON.parse(row.closure_json);
    return hash(value) === row.closure_digest && value.taskRunId === row.task_run_id
      && value.attemptNonce === row.attempt_nonce && value.dispatcher === 'toolbox-singleton'
      && value.actualExitBarrierCompleted === true;
  }
  function closed(id) {
    const row = record(id);
    if (!row || row.state === 'NOT_STARTED') return true;
    if (row.state !== 'STARTED') return closure(row);
    const active = live.get(row.attempt_nonce);
    if (active) return active.closed;
    if (row.owner_pid === process.pid) return false;
    try { process.kill(row.owner_pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }
  async function io(id, kind, work, runtime = getRuntime(), signal) {
    const bound = binding(id);
    if (!bound || !closed(id) || !protection.closed(id)) fail('BIZOP_PUBLICATION_CLOSURE_PENDING');
    let lease;
    try {
      lease = await acquireBizOpPhaseLease(runtime, { ownerKey: `biz-op-v327:publisher:${id}`,
        actionKey: bound.actionKey, operationKey: bound.batchContext.operationKey, resources: PHASE,
        lowMemoryBehavior: 'queue', signal });
    } catch (error) {
      // 只归一尚未准入 Publisher 的用户取消；已发布结果仍走原事实核验。
      if (kind === 'publish' && signal?.aborted && error.code === 'ADMISSION_CANCELLED') fail('BIZOP_CANCELLED');
      throw error;
    }
    const nonce = randomUUID(); const active = { closed: false }; live.set(nonce, active);
    let started = false;
    try {
      // 排队等容量时仍接受取消；准入后先复查，再登记或调用 Publisher。
      if (signal?.aborted) fail('BIZOP_CANCELLED');
      db.prepare(`UPDATE biz_op_v327_publications SET state='STARTED',attempt_nonce=?,owner_pid=?,owner_instance=?,
        closure_json=NULL,closure_digest=NULL,updated_at=? WHERE task_run_id=?`).run(nonce, process.pid, instance, now(), id);
      started = true;
      // 公共 dispatcher 的 Promise 只有原发布/必要恢复 worker 全部真实 exit 才结算。
      // 不使用超时 race；挂起期间继续持有本次租约和全部输入 pin。
      try { return await work(); }
      finally {
        active.closed = true;
        const observation = { schemaVersion: 1, taskRunId: id, attemptNonce: nonce, dispatcher: 'toolbox-singleton',
          operation: kind, ownerPid: process.pid, ownerInstance: instance, actualExitBarrierCompleted: true };
        db.prepare(`UPDATE biz_op_v327_publications SET state='CLOSED_UNKNOWN',closure_json=?,closure_digest=?,updated_at=?
          WHERE task_run_id=? AND attempt_nonce=?`).run(JSON.stringify(observation), hash(observation), now(), id, nonce);
      }
    } finally {
      if (!started || active.closed) lease.release('publisher-actual-exit');
      if (!started || closure(record(id))) live.delete(nonce);
    }
  }
  function committedOutcome(id, result) {
    const bound = binding(id);
    if (!result || result.taskId !== bound.publisherTaskId || result.committed !== true || result.files?.length !== 1
        || hash(freezeWorkerBatchContext(result.batchContext, { required: true })) !== hash(bound.batchContext)) fail('BIZOP_PUBLICATION_RESULT_INVALID');
    const file = result.files[0];
    if (file.outputId !== bound.output.artifactKey || path.resolve(file.filePath) !== bound.output.filePath
        || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1) fail('BIZOP_PUBLICATION_RESULT_INVALID');
    const output = payloadStore.readDocument(`operations/${id}/${bound.candidateRef}.json`).value;
    if (file.sha256 !== output.sha256 || file.byteSize !== output.byteSize || output.intentDigest !== bound.intentDigest
        || output.sourceDigest !== bound.sourceDigest) fail('BIZOP_PUBLICATION_RESULT_INVALID');
    return snapshot({ taskId: result.taskId, committed: true, batchContext: bound.batchContext,
      files: [{ artifactKey: bound.output.artifactKey, filePath: file.filePath, sha256: file.sha256, byteSize: file.byteSize }],
      inputConsumed: true });
  }
  function saveOutcome(id, state, value) {
    if (!closed(id) || !closure(record(id))) fail('BIZOP_PUBLICATION_CLOSURE_PENDING');
    const old = record(id);
    if (old.commit_proof_json) {
      const prior = JSON.parse(old.commit_proof_json);
      if (state !== 'COMMITTED' || hash(prior) !== old.commit_proof_digest || hash(prior.outcome) !== hash(value)) fail('BIZOP_PUBLICATION_COMMIT_REGRESSION');
    } else if (state === 'COMMITTED') {
      const proof = { outcome: value, closure: JSON.parse(old.closure_json), bindingDigest: old.binding_digest };
      db.prepare('UPDATE biz_op_v327_publications SET commit_proof_json=?,commit_proof_digest=? WHERE task_run_id=?')
        .run(JSON.stringify(proof), hash(proof), id);
    }
    db.prepare(`UPDATE biz_op_v327_publications SET state=?,outcome_json=?,outcome_digest=?,input_consumed=1,updated_at=?
      WHERE task_run_id=?`).run(state, JSON.stringify(value), hash(value), now(), id);
  }
  async function publish(id, evidence, runtime, onProgress, signal) {
    const bound = binding(id);
    if (record(id).state !== 'NOT_STARTED') fail('BIZOP_PUBLICATION_RETRY_REQUIRES_RECOVERY');
    const result = await io(id, 'publish', () => publishDurableArtifactAsync({ userDataDir,
      taskId: bound.publisherTaskId, batchContext: bound.batchContext, archiveInputFiles: [], allowEmptyArchiveInputs: true,
      artifacts: [{ outputId: bound.output.artifactKey,
        sourcePath: payloadStore.resolve(`staging/${id}/${bound.candidateRef}/output.xlsx`),
        fileName: path.basename(bound.output.filePath), byteSize: evidence.byteSize, sha256: evidence.sha256,
        dataRowCount: evidence.dataRowCount, sheetCount: evidence.sheetCount }],
      targets: [{ targetPath: bound.output.filePath, expectedTargetSnapshot: bound.targetSnapshot,
        expectedTargetParentIdentity: bound.output.targetParentIdentity }],
      requireTargetParentIdentity: true, onProgress }), runtime, signal);
    const outcome = committedOutcome(id, result); saveOutcome(id, 'COMMITTED', outcome); return outcome;
  }
  function fact(id) {
    const row = record(id);
    if (!row) {
      // 登记事务先于任何 dispatcher 调用；无登记只能证明未准入 Publisher。
      const op = catalog.operation(id);
      if (op?.action !== 'EXPORT') return null;
      const intent = payloadStore.readDocument(op.intent_rel_path, op.intent_digest).value;
      if (intent.phase !== 'export-workbook-v1') return null;
      const outcome = { taskRunId: id, publisherNeverRegistered: true, inputConsumed: true };
      return { state: 'NOT_COMMITTED', outcome, digest: hash(outcome), receipt: null };
    }
    let value; let state;
    if (row.commit_proof_json) {
      const proof = JSON.parse(row.commit_proof_json);
      if (hash(proof) !== row.commit_proof_digest || proof.bindingDigest !== row.binding_digest
          || proof.closure.taskRunId !== id || !proof.closure.actualExitBarrierCompleted) fail('BIZOP_PUBLICATION_OBSERVATION_CHANGED');
      value = proof.outcome; state = 'COMMITTED';
    } else {
      if (!closure(row) || row.state !== 'NOT_COMMITTED' || !row.input_consumed) return null;
      value = JSON.parse(row.outcome_json); state = row.state;
      if (hash(value) !== row.outcome_digest) fail('BIZOP_PUBLICATION_OBSERVATION_CHANGED');
    }
    const bound = binding(id);
    if (value.taskId !== bound.publisherTaskId || value.inputConsumed !== true) fail('BIZOP_PUBLICATION_OBSERVATION_CHANGED');
    return { state, outcome: value, digest: hash(value),
      receipt: state === 'COMMITTED' ? { taskRunId: id, action: 'EXPORT', intentDigest: bound.intentDigest, outcome: value } : null };
  }
  async function reconcile(id, runtime) {
    if (fact(id)) return;
    const bound = binding(id);
    if (!bound || !closed(id) || !protection.closed(id)) return;
    const neverStarted = record(id).state === 'NOT_STARTED';
    const result = await io(id, 'recover', () => recoverToolboxPublicationsAsync({
      userDataDir, deferCommittedRecovery: true }), runtime || getRuntime());
    const entry = result.recovered.find((value) => value.taskId === bound.publisherTaskId);
    if (result.skippedActive?.includes(bound.publisherTaskId)) fail('BIZOP_PUBLICATION_CLOSURE_PENDING');
    if (entry?.action === 'commit-handoff-pending') {
      const value = committedOutcome(id, { ...entry, committed: true }); saveOutcome(id, 'COMMITTED', value);
    } else {
      if (entry && !['rolled-back', 'cancelled', 'cancelled-preparing', 'cancelled-prepared'].includes(entry.action)) fail('BIZOP_PUBLICATION_RECOVERY_UNKNOWN');
      // 原 dispatcher 从未提交或权威完整恢复后没有该任务的未决 journal；不重新发布。
      saveOutcome(id, 'NOT_COMMITTED', { taskId: bound.publisherTaskId, inputConsumed: true,
        recoveredAction: entry?.action || (neverStarted ? 'not-started' : 'no-open-journal') });
    }
  }
  function completeInput(id) {
    const observed = fact(id);
    if (!observed || !protection.closed(id) || !closed(id)) fail('BIZOP_READER_OBLIGATION_PENDING');
    db.prepare("UPDATE biz_op_v327_settlement_progress SET input_obligation='COMPLETE',updated_at=? WHERE task_run_id=?").run(now(), id);
    protection.releasePins(id);
  }
  async function settle(id, settleArtifacts, runtime = getRuntime()) {
    const observed = fact(id); if (observed?.state !== 'COMMITTED') return false;
    const bound = binding(id);
    const files = observed.outcome.files.map((file) => ({ artifactKey: file.artifactKey, expectedSha256: file.sha256, expectedSizeBytes: file.byteSize }));
    const lease = await acquireBizOpPhaseLease(runtime, { ownerKey: `biz-op-v327:archive-output:${id}`,
      actionKey: bound.actionKey, operationKey: bound.batchContext.operationKey, resources: PHASE, lowMemoryBehavior: 'queue' });
    let result;
    try { result = await (settleArtifacts ? settleArtifacts({ files }) : getArchiveService().settleManifestArtifacts({ batchContext: bound.batchContext, files })); }
    finally { lease.release('archive-output-settled'); }
    if (!result?.ok || !result.durable) return false;
    db.prepare('UPDATE biz_op_v327_publications SET archive_settled=1,updated_at=? WHERE task_run_id=?').run(now(), id);
    completeInput(id); return true;
  }
  async function acknowledge(id, runtime) {
    const row = record(id); const observed = fact(id);
    if (!row) return true;
    if (row.acknowledged) { await cleanupStage(id); return true; }
    if (!observed || !closed(id) || !protection.closed(id)) return false;
    if (observed.state === 'COMMITTED') {
      if (!row.archive_settled || catalog.task(id).status !== 'succeeded') return false;
      const bound = binding(id);
      const result = await io(id, 'acknowledge', () => recoverToolboxPublicationsAsync({ userDataDir,
        deferCommittedRecovery: true, acknowledgedCommittedTaskIds: [bound.publisherTaskId] }), runtime || getRuntime());
      const item = result.recovered.find((entry) => entry.taskId === bound.publisherTaskId);
      if (item && item.action !== 'commit-cleanup' || result.skippedActive?.includes(bound.publisherTaskId)) fail('BIZOP_PUBLICATION_ACK_PENDING');
      saveOutcome(id, 'COMMITTED', observed.outcome);
    }
    db.prepare('UPDATE biz_op_v327_publications SET acknowledged=1,updated_at=? WHERE task_run_id=?').run(now(), id);
    await cleanupStage(id);
    return true;
  }
  async function cleanupStage(id) {
    const row = record(id);
    if (row.cleanup_completed) return;
    if (!row.acknowledged || !closed(id) || !protection.closed(id) || catalog.operation(id).input_obligation !== 'COMPLETE') fail('BIZOP_PUBLICATION_CLEANUP_PENDING');
    if (fact(id).state === 'COMMITTED') {
      const relative = `operations/${id}/export-cleanup.json`;
      let plan;
      if (fs.existsSync(payloadStore.resolve(relative, { mustExist: false }))) plan = payloadStore.readDocument(relative).value;
      else {
        plan = { bindingDigest: row.binding_digest, ...payloadStore.abortInventory(id, []) };
        payloadStore.writeDocument(relative, plan);
      }
      if (plan.bindingDigest !== row.binding_digest || [...plan.files, ...plan.directories]
        .some((name) => name !== `staging/${id}` && !name.startsWith(`staging/${id}/`))) fail('BIZOP_PUBLICATION_CLEANUP_INVALID');
      for (const name of plan.files) {
        try { await fs.promises.unlink(payloadStore.resolve(name, { mustExist: false })); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const name of plan.directories) {
        try { await fs.promises.rmdir(payloadStore.resolve(name, { mustExist: false })); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (fsyncDirectory(payloadStore.resolve('staging')).capability !== 'supported') fail('DURABILITY_BARRIER_UNAVAILABLE');
    }
    db.prepare('UPDATE biz_op_v327_publications SET cleanup_completed=1,updated_at=? WHERE task_run_id=?').run(now(), id);
  }
  async function recoverOtherOwners(options) {
    // 共享 Publisher 仍完整观察同一 journal 根；旧 Archive owner 不得接管 BizOP
    // 的 Task 或确认清理其 receipt，尤其是本模块暂时 blocked 的启动轮次。
    const pending = db.prepare('SELECT 1 FROM biz_op_v327_publications WHERE cleanup_completed=0 LIMIT 1').get();
    const lease = pending ? await acquireBizOpPhaseLease(getRuntime(), {
      ownerKey: 'biz-op-v327:shared-publication-observation', actionKey: 'biz-op-v327:export-result-full',
      operationKey: 'biz-op-v327:shared-publication-observation', resources: PHASE, lowMemoryBehavior: 'queue'
    }) : null;
    try {
      if (options.deferCommittedRecovery !== true
          || options.acknowledgedCommittedTaskIds?.some((id) => String(id).startsWith('biz-op-v327-export-'))) fail('BIZOP_PUBLICATION_OWNER_REQUIRED');
      const result = await recoverToolboxPublicationsAsync(options);
      return { ...result, recovered: result.recovered.filter((item) => !item.taskId.startsWith('biz-op-v327-export-')) };
    } finally { lease?.release('shared-publication-observation-closed'); }
  }
  return { register, publish, reconcile, fact, closed, completeInput, settle, acknowledge, record, binding, recoverOtherOwners };
}
module.exports = { createBizOpPublication, EXPORT_IO_RESOURCES: PHASE };
