'use strict';

// 规模夹具仅以一次真实 IPC 成功导出为模板，合成旧版已完成的独立 owner/发布记录。
// 不宣称对每个合成条目运行了 Worker；每条 completion 仍由生产完整事实校验生成。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../src/main-process/biz-op-v327/contracts');

function seedHistoricalOwnerCopies(f, taskRunId, count, { includeOriginal = true } = {}) {
  const { db } = f;
  const owner = f.owner(taskRunId);
  const batchId = owner.batchContext.batchId;
  const tableSelectors = {
    archive_task_runs: ['task_run_id', taskRunId], archive_batches: ['id', batchId],
    biz_op_v327_prepared_ops: ['task_run_id', taskRunId], biz_op_v327_settlement_progress: ['task_run_id', taskRunId],
    biz_op_v327_publications: ['task_run_id', taskRunId], archive_artifacts: ['batch_id', batchId],
    archive_operation_issuances: ['batch_id', batchId]
  };
  const templates = Object.fromEntries(Object.entries(tableSelectors).map(([table, [key, value]]) =>
    [table, db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value)]));
  const inserts = Object.fromEntries(Object.entries(templates).map(([table, row]) =>
    [table, db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)]));
  const publication = templates.biz_op_v327_publications;
  assert.equal(publication.acknowledged, 1);
  assert.equal(publication.cleanup_completed, 1);
  const bound = f.module.publication.binding(taskRunId);
  const nextBatchId = db.prepare('SELECT MAX(id) n FROM archive_batches').get().n;
  const nextArtifactId = db.prepare('SELECT MAX(id) n FROM archive_artifacts').get().n;
  const nextDaily = db.prepare('SELECT MAX(daily_sequence) n FROM archive_batches').get().n;
  const nextGlobal = db.prepare('SELECT MAX(global_daily_sequence) n FROM archive_batches').get().n;
  const owners = includeOriginal ? [owner] : [];
  const writeDocument = (relative, value) => {
    const bytes = JSON.stringify(value);
    const filePath = f.module.payloadStore.resolve(relative, { mustExist: false });
    fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes);
    return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  };
  f.module.catalog.transaction(() => {
    if (includeOriginal) db.prepare('DELETE FROM archive_owner_terminal_completions WHERE batch_id=?').run(batchId);
    for (let i = 1; i <= count - Number(includeOriginal); i += 1) {
      const id = `${taskRunId}-history-${String(i).padStart(5, '0')}`;
      const context = { ...owner.batchContext, batchId: nextBatchId + i,
        batchNumber: `history-${nextBatchId + i}`, taskRunId: id, operationKey: `history:${id}` };
      const binding = { ...structuredClone(bound), taskRunId: id, batchContext: context,
        publisherTaskId: `biz-op-v327-export-${id}` };
      delete binding.archiveOwnerCompletion;
      const bindingPath = `operations/${id}/publication-binding.json`;
      const bindingDigest = writeDocument(bindingPath, binding);
      const proof = JSON.parse(publication.commit_proof_json);
      proof.bindingDigest = bindingDigest;
      proof.closure.taskRunId = id;
      proof.outcome.taskId = binding.publisherTaskId;
      proof.outcome.batchContext = context;
      const closure = JSON.parse(publication.closure_json); closure.taskRunId = id;
      for (const [table, template] of Object.entries(templates)) {
        const row = { ...template };
        if ('task_run_id' in row) row.task_run_id = id;
        if ('operation_key' in row) row.operation_key = context.operationKey;
        if ('batch_id' in row) row.batch_id = context.batchId;
        if ('batch_number' in row) row.batch_number = context.batchNumber;
        if ('source_ref' in row) row.source_ref = `biz-op-v327:operation:${id}`;
        if (table === 'archive_batches') {
          Object.assign(row, { id: context.batchId, daily_sequence: nextDaily + i, global_daily_sequence: nextGlobal + i });
        } else if (table === 'archive_artifacts') {
          row.id = nextArtifactId + i;
          // 每批历史目录副本有独立布局位置；本夹具只核验原 Blob 发布事实，不创建目录副本。
          row.storage_relative_path = row.storage_relative_path.replace(/\/[^/]+\/([^/]+)$/, `/history-${context.batchId}/$1`);
          row.storage_fingerprint_ino = null;
        } else if (table === 'biz_op_v327_prepared_ops') row.phase = 'CLOSED';
        else if (table === 'biz_op_v327_settlement_progress') row.state = 'COMPLETE';
        else if (table === 'biz_op_v327_publications') Object.assign(row, {
          binding_rel_path: bindingPath, binding_digest: bindingDigest,
          closure_json: JSON.stringify(closure), closure_digest: hash(closure),
          outcome_json: JSON.stringify(proof.outcome), outcome_digest: hash(proof.outcome),
          commit_proof_json: JSON.stringify(proof), commit_proof_digest: hash(proof)
        });
        inserts[table].run(...Object.values(row));
      }
      owners.push({ version: 1, kind: 'file-batch', batchContext: context });
    }
  });
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  return owners;
}

function ownerProofCount(f, owners) {
  return owners.filter((owner) => f.service.repository.getOwnerTerminalCompletion(owner) !== null).length;
}

module.exports = { seedHistoricalOwnerCopies, ownerProofCount };
