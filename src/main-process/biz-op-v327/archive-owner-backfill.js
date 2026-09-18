'use strict';

const { setImmediate: yieldMain } = require('node:timers/promises');
const { HISTORICAL_OWNER_SQL } = require('./recovery-alignment');
const { recordExportOwnerCompletion } = require('./archive-owner-completion');

const PAGE_SIZE = 64;
const HISTORICAL_FROM = `FROM archive_batches b
  JOIN biz_op_v327_prepared_ops p ON p.task_run_id=b.task_run_id
  JOIN biz_op_v327_settlement_progress s ON s.task_run_id=p.task_run_id
  JOIN archive_task_runs t ON t.task_run_id=p.task_run_id`;
const safeCode = (error) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
  ? error.code : 'BIZOP_ARCHIVE_OWNER_EVIDENCE_UNAVAILABLE';

function createArchiveOwnerBackfill({ catalog, getArchiveService, payloadStore, protection, operationSource, getPublication }) {
  const { db, now } = catalog;
  const exists = () => Boolean(db.prepare(`SELECT 1 ${HISTORICAL_FROM} WHERE ${HISTORICAL_OWNER_SQL} LIMIT 1`).get());
  async function run() {
    const result = { processed: 0, completed: 0, deferred: 0, pageSize: PAGE_SIZE, errorCode: null };
    try {
      const service = getArchiveService();
      const archiveInstanceId = service?.repository.getArchiveInstanceId();
      if (!archiveInstanceId || service.repository.db !== db) throw Object.assign(new Error('历史凭证需要原存档实例'), { code: 'BIZOP_ARCHIVE_CONNECTION_MISMATCH' });
      const cursor = db.prepare('SELECT last_batch_id FROM biz_op_v327_archive_owner_backfill_cursor WHERE archive_instance_id=?')
        .get(archiveInstanceId)?.last_batch_id || 0;
      const page = db.prepare(`SELECT b.id,b.task_run_id ${HISTORICAL_FROM}
        WHERE b.id>? AND (${HISTORICAL_OWNER_SQL}) ORDER BY b.id LIMIT ?`);
      let candidates = page.all(cursor, PAGE_SIZE);
      // 一轮末尾回到最早缺证项；不会让低 ID 坏项永久饿死后续批次，也不永久遗忘坏项。
      if (!candidates.length && cursor > 0) candidates = page.all(0, PAGE_SIZE);
      for (const candidate of candidates) {
        const outcome = catalog.transaction(() => {
          const current = db.prepare(`SELECT 1 ${HISTORICAL_FROM} WHERE b.id=? AND (${HISTORICAL_OWNER_SQL})`).get(candidate.id);
          let completed = false;
          let errorCode = null;
          if (current) {
            try {
              const proof = recordExportOwnerCompletion({ catalog, service, payloadStore, protection,
                publication: getPublication(), source: operationSource(candidate.task_run_id) });
              completed = proof.completed === true;
              if (!completed) errorCode = 'BIZOP_ARCHIVE_OWNER_COMPENSATION_INCOMPLETE';
            } catch (error) {
              // 任何 SQLite 写故障都回滚本批 proof 和游标；下次必须从原重试点继续。
              if (String(error?.code).startsWith('ERR_SQLITE')) throw error;
              errorCode = safeCode(error);
            }
          }
          if (errorCode) {
            db.prepare(`INSERT INTO biz_op_v327_archive_owner_backfill_failures
              (archive_instance_id,batch_id,task_run_id,error_code,updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(archive_instance_id,batch_id) DO UPDATE SET task_run_id=excluded.task_run_id,
                error_code=excluded.error_code,updated_at=excluded.updated_at`)
              .run(archiveInstanceId, candidate.id, candidate.task_run_id, errorCode, now());
          } else {
            db.prepare('DELETE FROM biz_op_v327_archive_owner_backfill_failures WHERE archive_instance_id=? AND batch_id=?')
              .run(archiveInstanceId, candidate.id);
          }
          db.prepare(`INSERT INTO biz_op_v327_archive_owner_backfill_cursor (archive_instance_id,last_batch_id,updated_at)
            VALUES (?,?,?) ON CONFLICT(archive_instance_id) DO UPDATE SET last_batch_id=excluded.last_batch_id,updated_at=excluded.updated_at`)
            .run(archiveInstanceId, candidate.id, now());
          return { completed, errorCode };
        });
        result.processed += 1;
        if (outcome.completed) result.completed += 1;
        if (outcome.errorCode) result.deferred += 1;
        if (result.processed % 8 === 0) await yieldMain();
      }
    } catch (error) { result.errorCode = safeCode(error); }
    return Object.freeze(result);
  }
  return Object.freeze({ exists, run });
}

module.exports = { createArchiveOwnerBackfill, PAGE_SIZE };
