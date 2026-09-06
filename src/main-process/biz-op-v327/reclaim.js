'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fsyncDirectory } = require('../background-execution/durable-file');
const { fail, hash } = require('./contracts');

function createBizOpReclaimer({ catalog, payloadStore, protection, admission }) {
  const { db } = catalog;
  const queueDigest = (queue) => hash([queue.reclaim_id, queue.owner_task_run_id, queue.payload_kind,
    queue.object_id, queue.manifest_digest, queue.plan_rel_path, queue.receipt_task_run_id]);
  function authorize(queue) {
    if (db.prepare('SELECT 1 FROM biz_op_v327_read_pins WHERE object_kind=? AND object_id=? LIMIT 1')
      .get(queue.payload_kind, queue.object_id)) fail('BIZOP_RECLAIM_READER_PENDING');
    if (queue.payload_kind === 'DATASET') {
      const row = db.prepare('SELECT * FROM biz_op_v327_datasets WHERE dataset_id=?').get(queue.object_id);
      if (!row || !['RETIRED', 'DELETED'].includes(row.state) || row.payload_manifest_digest !== queue.manifest_digest
          || db.prepare('SELECT 1 FROM biz_op_v327_input_heads WHERE dataset_id=?').get(queue.object_id)) fail('BIZOP_RECLAIM_LIVE_DATASET');
    } else if (queue.payload_kind === 'DIAGNOSTIC') {
      const row = db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get(queue.object_id);
      if (!row || !['RETIRED', 'DELETED'].includes(row.state) || row.manifest_digest !== queue.manifest_digest
          || !protection.closed(row.task_run_id)) fail('BIZOP_RECLAIM_REPORT_PENDING');
    } else if (queue.payload_kind === 'RESULT') {
      const row = db.prepare('SELECT * FROM biz_op_v327_runs WHERE run_id=?').get(queue.object_id);
      if (!row || row.state !== 'DELETED' || row.payload_manifest_digest !== queue.manifest_digest) fail('BIZOP_RECLAIM_LIVE_RESULT');
    } else if (queue.payload_kind === 'ABORTED_STAGE') {
      if (!protection.closed(queue.object_id)
          || catalog.receipt(queue.object_id)
          || !db.prepare('SELECT 1 FROM biz_op_v327_abort_finalizations WHERE task_run_id=?').get(queue.object_id)) {
        fail('BIZOP_RECLAIM_ABORT_NOT_PROVEN');
      }
    } else if (queue.payload_kind === 'UNUSED_CANDIDATE') {
      const receipt = catalog.receipt(queue.receipt_task_run_id);
      const unused = receipt?.outcome.unusedCandidates?.find((item) => item.objectId === queue.object_id);
      if (!unused || unused.manifestDigest !== queue.manifest_digest || unused.manifestPath !== queue.plan_rel_path
          || !['DATASET', 'RESULT'].includes(unused.objectKind) || !protection.closed(queue.receipt_task_run_id)
          || db.prepare('SELECT 1 FROM biz_op_v327_datasets WHERE dataset_id=?').get(queue.object_id)
          || db.prepare('SELECT 1 FROM biz_op_v327_runs WHERE run_id=?').get(queue.object_id)
          || db.prepare('SELECT 1 FROM biz_op_v327_read_pins WHERE object_id=? LIMIT 1').get(queue.object_id)) {
        fail('BIZOP_UNUSED_CANDIDATE_NOT_PROVEN');
      }
    } else fail('BIZOP_LEGACY_RECLAIM_NOT_ENABLED');
  }
  return async function reclaim(source, { admit = () => {} } = {}) {
    admission.assertExclusive();
    admit();
    const queue = db.prepare('SELECT * FROM biz_op_v327_reclaim_queue WHERE reclaim_id=?')
      .get(source.boundedEvidence.reclaimId);
    if (!queue || queue.owner_task_run_id !== source.taskRunId) fail('BIZOP_RECLAIM_OWNER_CHANGED');
    if (queue.state === 'DONE') return false;
    if (!['PENDING', 'RECLAIMING'].includes(queue.state)) fail('BIZOP_RECLAIM_HELD');
    authorize(queue);
    const authorizationRef = `operations/${source.taskRunId}/reclaim-plan.json`;
    let authorization;
    if (queue.state === 'RECLAIMING') {
      if (!queue.authorization_digest) fail('BIZOP_RECLAIM_AUTHORIZATION_MISSING');
      authorization = payloadStore.readDocument(authorizationRef, queue.authorization_digest).value;
    } else {
      const manifest = payloadStore.readDocument(queue.plan_rel_path, queue.manifest_digest).value;
      if (queue.payload_kind === 'ABORTED_STAGE') {
        if (manifest.taskRunId !== queue.object_id || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
          fail('BIZOP_STAGE_RECLAIM_PLAN_INVALID');
        }
        authorization = { queueDigest: queueDigest(queue),
          stageFiles: manifest.files, stageDirectories: manifest.directories };
      } else {
        const kind = queue.payload_kind === 'UNUSED_CANDIDATE' ? manifest.objectKind : queue.payload_kind;
        const folder = { DATASET: 'inputs', RESULT: 'results', DIAGNOSTIC: 'diagnostics' }[kind];
        const directory = `${folder}/${queue.object_id}`;
        if (manifest.objectId !== queue.object_id || queue.plan_rel_path !== `${directory}/manifest.json`
            || !Array.isArray(manifest.parts)) fail('BIZOP_RECLAIM_MANIFEST_MISMATCH');
        authorization = { queueDigest: queueDigest(queue),
          directory, files: [...manifest.parts.map((part) => part.name), 'manifest.json'] };
        if (authorization.files.some((name) => name !== 'manifest.json' && !/^part-\d{6}\.(sqlite|jsonl)$/.test(name))) {
          fail('BIZOP_RECLAIM_PART_INVALID');
        }
      }
      const sealedAuthorization = payloadStore.writeDocument(authorizationRef, authorization);
      catalog.transaction(() => {
        authorize(queue);
        const changed = db.prepare("UPDATE biz_op_v327_reclaim_queue SET state='RECLAIMING',authorization_digest=? WHERE reclaim_id=? AND state='PENDING'")
          .run(sealedAuthorization.digest, queue.reclaim_id);
        if (changed.changes !== 1) fail('BIZOP_RECLAIM_STATE_CHANGED');
      });
    }
    if (authorization.queueDigest !== queueDigest(queue)) {
      fail('BIZOP_RECLAIM_AUTHORIZATION_CHANGED');
    }
    if (authorization.stageFiles) {
      const ownedRoots = new Set([`staging/${queue.object_id}`]);
      for (const relative of authorization.stageDirectories) {
        if (/^(inputs|results)\/[a-zA-Z0-9_.-]+$/.test(relative)) {
          const objectId = relative.split('/')[1];
          if (db.prepare('SELECT 1 FROM biz_op_v327_datasets WHERE dataset_id=?').get(objectId)
              || db.prepare('SELECT 1 FROM biz_op_v327_runs WHERE run_id=?').get(objectId)) fail('BIZOP_RECLAIM_PUBLISHED_CANDIDATE');
          ownedRoots.add(relative);
        }
      }
      for (const relative of [...authorization.stageFiles, ...authorization.stageDirectories]) {
        if (![...ownedRoots].some((root) => relative === root || relative.startsWith(`${root}/`))) fail('BIZOP_RECLAIM_ROOT_FORBIDDEN');
        authorize(queue);
        payloadStore.resolve(relative, { mustExist: false });
      }
      for (const relative of authorization.stageFiles) {
        admit();
        authorize(queue);
        try { await fs.promises.unlink(payloadStore.resolve(relative, { mustExist: false })); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const relative of authorization.stageDirectories) {
        admit();
        authorize(queue);
        try { await fs.promises.rmdir(payloadStore.resolve(relative, { mustExist: false })); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const root of ownedRoots) {
        if (fsyncDirectory(path.dirname(payloadStore.resolve(root, { mustExist: false }))).capability !== 'supported') {
          fail('DURABILITY_BARRIER_UNAVAILABLE');
        }
      }
      catalog.transaction(() => {
        authorize(queue);
        db.prepare("UPDATE biz_op_v327_reclaim_queue SET state='DONE',completed_at=? WHERE reclaim_id=? AND state='RECLAIMING'")
          .run(catalog.now(), queue.reclaim_id);
      });
      return true;
    }
    const directory = payloadStore.resolve(authorization.directory, { mustExist: false });
    if (fs.existsSync(directory)) {
      admit();
      const names = await fs.promises.readdir(payloadStore.resolve(authorization.directory));
      if (names.some((name) => !authorization.files.includes(name))) fail('BIZOP_RECLAIM_UNKNOWN_FILE');
      for (const name of authorization.files) {
        admit();
        authorize(queue);
        const relative = `${authorization.directory}/${name}`;
        const target = payloadStore.resolve(relative, { mustExist: false });
        try { await fs.promises.unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      admit();
      await fs.promises.rmdir(directory);
    }
    if (fsyncDirectory(path.dirname(directory)).capability !== 'supported') fail('DURABILITY_BARRIER_UNAVAILABLE');
    catalog.transaction(() => {
      authorize(queue);
      if (queue.payload_kind === 'DATASET') {
        db.prepare("UPDATE biz_op_v327_datasets SET state='DELETED' WHERE dataset_id=? AND state='RETIRED'").run(queue.object_id);
      } else if (queue.payload_kind === 'DIAGNOSTIC') {
        db.prepare("UPDATE biz_op_v327_diagnostic_reports SET state='DELETED' WHERE report_ref=? AND state='RETIRED'").run(queue.object_id);
        db.prepare('UPDATE biz_op_v327_diagnostic_lifecycle SET deleted_at=?,updated_at=? WHERE report_ref=?')
          .run(catalog.now(), catalog.now(), queue.object_id);
      }
      db.prepare("UPDATE biz_op_v327_reclaim_queue SET state='DONE',completed_at=? WHERE reclaim_id=? AND state='RECLAIMING'")
        .run(catalog.now(), queue.reclaim_id);
    });
    return true;
  };
}

module.exports = { createBizOpReclaimer };
