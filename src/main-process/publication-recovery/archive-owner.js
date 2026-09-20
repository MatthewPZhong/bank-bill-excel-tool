'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const {
  PUBLICATION_ONLY_FILE_TASKS,
  isPublicationOnlyFileTask,
  verifyArchiveHandoff,
  toolboxRecoveryInputFiles,
  toolboxRecoveryOutputFiles
} = require('../toolbox-archive-recovery');

// 任务身份取自实际 producer 的 exact-7；action key 不能代替 taskKey。
const ARCHIVE_PUBLICATION_TASKS = Object.freeze([
  ...PUBLICATION_ONLY_FILE_TASKS.entries(),
  ['recon-id-fix:export', 'recon-fix'],
  ['new-account:export', 'new-account'],
  ['position-reconciliation:run:export', 'position-reconciliation-process'],
  ['position-reconciliation:run:export-filtered', 'position-reconciliation-process']
].map(([taskKey, moduleId]) => Object.freeze({ taskKey, moduleId })));
const COMMITTED = new Set(['committed', 'committed-cleanup-pending', 'finalizing']);

function conflict(record, cause) {
  return Object.assign(new Error(`发布 ${record.taskId} 的 Archive 归属证据冲突`), {
    code: 'PUBLICATION_RECOVERY_OWNER_CONFLICT', cause, preserveTemporaryFiles: true,
    recoveryPaths: [record.journalPath].filter(Boolean)
  });
}

function publicationEvidence(record) {
  const value = record.journal || record.indexEntry;
  return {
    taskId: record.taskId,
    batchContext: value.batchContext,
    inputFiles: value.archiveInputFiles || [],
    files: record.journal
      ? (record.journal.entries || []).map((entry) => ({
        filePath: entry.targetPath,
        fileName: entry.metadata && entry.metadata.fileName,
        byteSize: entry.generated && entry.generated.size,
        sha256: entry.generated && entry.generated.sha256
      }))
      : value.outputFiles || []
  };
}

// manifest 的角色与 sourceOperation 来自原 FilePlan，NewAccount 等不能强改为通用 input/output role。
function verifyManifestHandoff(current, item, manifest) {
  const artifacts = current.detail.artifacts || [];
  const keys = new Set(artifacts.map((artifact) => artifact.artifactKey));
  if (current.detail.taskStatus !== 'succeeded' || current.task?.status !== 'succeeded'
      || !Array.isArray(manifest.artifactKeys) || keys.size !== artifacts.length
      || keys.size !== manifest.artifactKeys.length || manifest.artifactKeys.some((key) => !keys.has(key))) {
    throw new Error('manifest 身份或任务终态不完整');
  }
  const newAccount = current.context.taskKey === 'new-account:export';
  const expected = [
    ...item.inputFiles.map((file) => ({ ...file, direction: 'input', sha256: file.expectedSha256,
      byteSize: file.expectedSizeBytes ?? file.sourceSnapshot?.sizeBytes })),
    ...item.files.map((file) => ({ ...file, direction: 'output' }))
  ];
  if (expected.length !== artifacts.length) throw new Error('manifest 附件数量不完整');
  const remaining = new Set(artifacts);
  for (const file of expected) {
    const role = newAccount
      ? (file.direction === 'input' ? 'new-account-source-artifact' : 'new-account-save-as-output')
      : file.direction;
    const sourceOperation = newAccount ? 'new-account:save-as'
      : (file.sourceOperation || current.context.taskKey);
    const matches = [...remaining].filter((artifact) => artifact.direction === file.direction
      && artifact.role === role && artifact.sourceOperation === sourceOperation
      && path.resolve(artifact.sourcePath) === path.resolve(file.filePath));
    if (matches.length !== 1 || matches[0].status !== 'ready' || !matches[0].blob) {
      throw new Error('manifest 附件尚未 ready 或身份不唯一');
    }
    const artifact = matches[0];
    if ((file.sha256 && String(artifact.blob.sha256).toLowerCase() !== String(file.sha256).toLowerCase())
        || (Number.isSafeInteger(Number(file.byteSize)) && Number(artifact.blob.sizeBytes) !== Number(file.byteSize))) {
      throw new Error('manifest 附件内容证明不一致');
    }
    remaining.delete(artifact);
  }
}

function createArchivePublicationOwner({ getArchiveCenter }) {
  if (typeof getArchiveCenter !== 'function') throw new TypeError('Archive publication owner 缺少只读事实入口');
  function facts(record) {
    const raw = record.journal && record.journal.batchContext
      || record.indexEntry && record.indexEntry.batchContext;
    if (!raw) return null;
    let context;
    try { context = freezeWorkerBatchContext(raw, { required: true }); }
    catch (cause) { throw conflict(record, cause); }
    if (!ARCHIVE_PUBLICATION_TASKS.some((item) => item.taskKey === context.taskKey
      && item.moduleId === context.moduleId)) return null;
    if (record.indexEntry && record.indexEntry.batchContext
        && !isDeepStrictEqual(context, record.indexEntry.batchContext)) throw conflict(record);
    const center = getArchiveCenter();
    if (!center || !center.service || !center.service.repository) return null;
    const repository = center.service.repository;
    const batch = repository.getBatch(context.batchId);
    if (!batch) return null;
    let detail;
    try { detail = center.getTaskBatchDetailForRecovery(context); }
    catch (cause) { throw conflict(record, cause); }
    const task = repository.getTaskRun(context.taskRunId);
    if (!detail || (!task && detail.metadata && detail.metadata._fileManifest)) return null;
    // legacy batch 的 taskStatus/taskRunId 即原持久任务事实；manifest 路径必须有独立 Task Run。
    // getTaskBatchDetailForRecovery 已完整核验 exact-7；task 不能来自另一个操作。
    for (const key of ['taskKey', 'moduleId', 'operationKey', 'parentRunId']) {
      if (task && task[key] !== undefined && String(task[key]) !== String(context[key])) throw conflict(record);
    }
    return { center, repository, context, detail, task };
  }
  function identityFor(record, current) {
    const context = current.context;
    return Object.freeze({
      ownerId: 'archive-publication', publisherTaskId: record.taskId,
      taskRunId: context.taskRunId, batchId: context.batchId, operationKey: context.operationKey,
      proofDigest: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex'),
      legacyProofKind: 'archive-exact-7'
    });
  }
  return Object.freeze({
    id: 'archive-publication',
    async identify(record) {
      const current = facts(record);
      return current ? identityFor(record, current) : 'not-owned';
    },
    async authorize(record, request, identity) {
      const current = facts(record);
      if (!current || !isDeepStrictEqual(identityFor(record, current), identity)) {
        return { disposition: 'reject', identity, permission: null, code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' };
      }
      const committed = COMMITTED.has(record.discoveryState) || COMMITTED.has(record.journalStatus);
      const ack = (request.acknowledgedCommittedTaskIds || []).includes(record.taskId);
      if (!committed) return { disposition: 'allow', identity, permission: 'recover-uncommitted' };
      if (!ack) return { disposition: 'allow', identity, permission: 'observe-committed' };
      if (request.ownerId !== 'archive-publication') throw conflict(record);
      const item = publicationEvidence(record);
      try {
        if (!item.files.length) throw new Error('缺少正式输出血缘');
        const manifest = current.detail.metadata && current.detail.metadata._fileManifest;
        if (manifest) {
          verifyManifestHandoff(current, item, manifest);
          if (isPublicationOnlyFileTask(current.context) && !request.deferCommittedFinalization) {
            const completion = current.repository.getOwnerTerminalCompletion({
              version: 1, kind: 'file-batch', batchContext: current.context
            });
            if (!completion || completion.terminalStatus !== 'succeeded'
                || completion.archiveInstanceId !== current.repository.getArchiveInstanceId()
                || !isDeepStrictEqual(completion.owner, { version: 1, kind: 'file-batch', batchContext: current.context })) {
              throw new Error('owner completion 尚未耐久或身份冲突');
            }
          }
        } else {
          verifyArchiveHandoff(current.center, item, [
            ...toolboxRecoveryInputFiles(item.inputFiles, current.context.taskKey),
            ...toolboxRecoveryOutputFiles(item.files, current.context.taskKey)
          ]);
        }
      } catch (error) {
        return { disposition: 'defer', identity, permission: null,
          code: 'TOOLBOX_ARCHIVE_HANDOFF_INCOMPLETE', detail: error.message };
      }
      return { disposition: 'allow', identity,
        permission: request.deferCommittedFinalization ? 'ack-stage' : 'ack-finalize' };
    },
    async acquireObservation() { return null; }
  });
}

module.exports = { ARCHIVE_PUBLICATION_TASKS, createArchivePublicationOwner };
