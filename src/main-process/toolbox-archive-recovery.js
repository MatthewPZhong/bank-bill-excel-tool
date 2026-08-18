'use strict';

const path = require('node:path');

const {
  recoverPendingToolboxPublications
} = require('./toolbox-output-publication');

function toolboxRecoveryOutputFiles(files, sourceOperation) {
  return (Array.isArray(files) ? files : []).map((file) => ({
    filePath: file.filePath,
    role: 'output',
    sourceOperation,
    originalName: file.fileName || path.basename(file.filePath),
    expectedSha256: file.sha256,
    expectedSizeBytes: file.byteSize
  }));
}

function toolboxRecoveryInputFiles(files, sourceOperation) {
  return (Array.isArray(files) ? files : []).map((file) => ({
    filePath: file.filePath,
    role: 'input',
    sourceOperation: file.sourceOperation || sourceOperation,
    originalName: file.originalName || path.basename(file.filePath),
    sourceSnapshot: file.sourceSnapshot,
    ...(file.expectedSha256 ? { expectedSha256: file.expectedSha256 } : {}),
    ...(file.expectedSizeBytes !== undefined
      ? { expectedSizeBytes: file.expectedSizeBytes }
      : {}),
    ...(file.metadata ? { metadata: file.metadata } : {})
  }));
}

function startupBlockingRecoveryError(message, cause = null, detailLines = []) {
  const error = cause instanceof Error ? cause : new Error(message);
  if (cause instanceof Error && message && cause.message !== message) {
    error.detailLines = [
      ...(Array.isArray(error.detailLines) ? error.detailLines : []),
      message,
      ...detailLines
    ];
  } else if (detailLines.length > 0) {
    error.detailLines = [
      ...(Array.isArray(error.detailLines) ? error.detailLines : []),
      ...detailLines
    ];
  }
  if (!error.code) error.code = 'TOOLBOX_ARCHIVE_HANDOFF_INCOMPLETE';
  error.blocksArchiveStartup = true;
  error.preserveTemporaryFiles = true;
  return error;
}

function expectedArtifactIdentity(file) {
  return [
    file.role === 'output' ? 'output' : 'input',
    String(file.role || ''),
    String(file.sourceOperation || ''),
    path.resolve(String(file.filePath || ''))
  ].join('\u0000');
}

function verifyArchiveHandoff(archiveCenter, item, files) {
  if (typeof archiveCenter.getTaskBatchDetailForRecovery !== 'function') {
    throw new TypeError('ArchiveCenter 缺少任务恢复校验入口');
  }
  const detail = archiveCenter.getTaskBatchDetailForRecovery(item.batchContext);
  if (!detail || detail.taskStatus !== 'succeeded') {
    throw new Error(`工具箱发布 ${item.taskId} 的原任务尚未耐久进入 succeeded`);
  }
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  if (artifacts.length !== files.length) {
    throw new Error(
      `工具箱发布 ${item.taskId} 的归档附件数量不完整：预期 ${files.length}，实际 ${artifacts.length}`
    );
  }
  const remaining = new Map();
  for (const artifact of artifacts) {
    const key = expectedArtifactIdentity({
      filePath: artifact.sourcePath,
      role: artifact.role,
      sourceOperation: artifact.sourceOperation
    });
    if (remaining.has(key)) {
      throw new Error(`工具箱发布 ${item.taskId} 的归档附件身份重复`);
    }
    remaining.set(key, artifact);
  }
  for (const [index, file] of files.entries()) {
    const key = expectedArtifactIdentity(file);
    const artifact = remaining.get(key);
    if (!artifact || artifact.status !== 'ready' || !artifact.blob) {
      throw new Error(`工具箱发布 ${item.taskId} 的第 ${index + 1} 个归档附件尚未 ready`);
    }
    const expectedSha256 = String(file.expectedSha256 || '').trim().toLowerCase();
    const expectedSizeBytes = Number(
      file.expectedSizeBytes !== undefined
        ? file.expectedSizeBytes
        : file.sourceSnapshot && file.sourceSnapshot.sizeBytes
    );
    if (expectedSha256 && String(artifact.blob.sha256 || '').toLowerCase() !== expectedSha256) {
      throw new Error(`工具箱发布 ${item.taskId} 的第 ${index + 1} 个归档附件摘要不一致`);
    }
    if (Number.isSafeInteger(expectedSizeBytes)
        && Number(artifact.blob.sizeBytes) !== expectedSizeBytes) {
      throw new Error(`工具箱发布 ${item.taskId} 的第 ${index + 1} 个归档附件大小不一致`);
    }
    remaining.delete(key);
  }
  if (remaining.size > 0) {
    throw new Error(`工具箱发布 ${item.taskId} 的原批次含未核对附件`);
  }
  return detail;
}

async function recoverToolboxPublicationsIntoArchive(options = {}) {
  try {
    const archiveCenter = options.archiveCenter;
    if (!archiveCenter
        || typeof archiveCenter.persistAppendIntent !== 'function'
        || typeof archiveCenter.flushOutbox !== 'function') {
      throw new TypeError('工具箱恢复需要 ArchiveCenter 持久追加与重放入口');
    }
    const recoverPublications = options.recoverPublications || recoverPendingToolboxPublications;
    const discovered = await recoverPublications({
      userDataDir: options.userDataDir,
      deferCommittedRecovery: true
    });
    const requestedTaskIds = Array.isArray(options.taskIds)
      ? new Set(options.taskIds.map(String))
      : null;
    const allPending = (Array.isArray(discovered && discovered.recovered)
      ? discovered.recovered
      : []).filter((item) => item && item.action === 'commit-handoff-pending');
    const pending = requestedTaskIds
      ? allPending.filter((item) => requestedTaskIds.has(String(item.taskId)))
      : allPending;
    if (requestedTaskIds) {
      const found = new Set(pending.map((item) => String(item.taskId)));
      const missing = [...requestedTaskIds].filter((taskId) => !found.has(taskId));
      if (missing.length > 0) {
        throw new Error(`工具箱发布 receipt 未进入待接管状态：${missing.join('、')}`);
      }
    }
    const manifestPending = [];
    const legacyPending = [];
    for (const item of pending) {
      const batch = archiveCenter.service
        && archiveCenter.service.repository
        && archiveCenter.service.repository.getBatch(item.batchContext.batchId);
      if (batch && batch.metadata && batch.metadata._fileManifest) {
        manifestPending.push(item);
      } else {
        legacyPending.push(item);
      }
    }
    for (const item of legacyPending) {
      const sourceOperation = item.batchContext.taskKey;
      const files = [
        ...toolboxRecoveryInputFiles(item.inputFiles, sourceOperation),
        ...toolboxRecoveryOutputFiles(item.files, sourceOperation)
      ];
      const persisted = archiveCenter.persistAppendIntent({
        batchContext: item.batchContext,
        sourceOperation,
        files,
        terminalOutcome: {
          taskStatus: 'succeeded',
          code: '',
          message: '',
          metadata: {
            recoveredToolboxPublication: true,
            toolboxPublicationTaskId: item.taskId
          }
        }
      });
      if (!persisted || persisted.persisted !== true) {
        throw new Error(`工具箱发布 ${item.taskId} 未形成耐久存档接管意图`);
      }
    }
    if (pending.length === 0) return discovered;

    // 全局 outbox 可同时包含普通文件重试或终态冲突；它们应留在 UI
    // 里诊断/重试，不得冒充本 committed receipt 的失败。先尽力重放全局
    // outbox，随后只用原 exact7 批次的附件与 terminal 耐久后置来决定 ack。
    if (legacyPending.length > 0) await archiveCenter.flushOutbox();
    for (const item of legacyPending) {
      const sourceOperation = item.batchContext.taskKey;
      verifyArchiveHandoff(archiveCenter, item, [
        ...toolboxRecoveryInputFiles(item.inputFiles, sourceOperation),
        ...toolboxRecoveryOutputFiles(item.files, sourceOperation)
      ]);
    }
    for (const item of manifestPending) {
      const context = item.batchContext;
      const existingTaskRun = archiveCenter.service.repository.getTaskRun(context.taskRunId);
      if (!existingTaskRun
          || !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(
            existingTaskRun.status
          )) {
        const rawDetail = archiveCenter.service.repository.getBatchDetail(context.batchId);
        const pendingArtifacts = Array.isArray(rawDetail && rawDetail.artifacts)
          ? rawDetail.artifacts
          : [];
        const settleEvidence = [];
        for (const input of item.inputFiles) {
          const matches = pendingArtifacts.filter((artifact) => (
            artifact.direction === 'input'
            && path.resolve(artifact.sourcePath) === path.resolve(input.filePath)
          ));
          if (matches.length !== 1) {
            throw new Error(`工具箱发布 ${item.taskId} 的 input manifest identity 不唯一`);
          }
          settleEvidence.push({ artifactKey: matches[0].artifactKey });
        }
        for (const output of item.files) {
          const matches = pendingArtifacts.filter((artifact) => (
            artifact.direction === 'output'
            && path.resolve(artifact.sourcePath) === path.resolve(output.filePath)
          ));
          if (matches.length !== 1) {
            throw new Error(`工具箱发布 ${item.taskId} 的 output manifest identity 不唯一`);
          }
          settleEvidence.push({
            artifactKey: matches[0].artifactKey,
            expectedSha256: output.sha256,
            expectedSizeBytes: output.byteSize
          });
        }
        const settled = await archiveCenter.service.settleManifestArtifacts({
          batchContext: context,
          files: settleEvidence
        });
        if (!settled || settled.ok === false) {
          throw new Error(`工具箱发布 ${item.taskId} 的 manifest artifact 尚未全部 durable`);
        }
        const finished = await archiveCenter.service.finishFileTask(
          context.taskRunId,
          context.batchId,
          {
            taskStatus: 'succeeded',
            code: '',
            message: '',
            metadata: {
              recoveredToolboxPublication: true,
              toolboxPublicationTaskId: item.taskId
            }
          }
        );
        const benign = finished
          && finished.ok === false
          && finished.code === 'ARCHIVE_TASK_STATUS_CONFLICT'
          && finished.taskRun
          && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(
            finished.taskRun.status
          );
        if ((!finished || finished.ok === false) && !benign) {
          throw new Error(`工具箱发布 ${item.taskId} 的 File Task 终态收口失败`);
        }
      }
      const detail = archiveCenter.service.repository.getBatchDetail(context.batchId);
      const manifest = detail && detail.metadata && detail.metadata._fileManifest;
      const artifactKeys = new Set((detail && detail.artifacts || []).map(
        (artifact) => artifact.artifactKey
      ));
      if (!manifest
          || manifest.artifactKeys.length !== artifactKeys.size
          || manifest.artifactKeys.some((key) => !artifactKeys.has(key))) {
        throw new Error(`工具箱发布 ${item.taskId} 的 manifest identity 校验失败`);
      }
    }

    const acknowledgedTaskIds = pending.map((item) => item.taskId);
    const finalized = await recoverPublications({
      userDataDir: options.userDataDir,
      deferCommittedRecovery: true,
      acknowledgedCommittedTaskIds: acknowledgedTaskIds
    });
    const finalizedByTask = new Map(
      (Array.isArray(finalized && finalized.recovered) ? finalized.recovered : [])
        .map((item) => [String(item && item.taskId), item])
    );
    for (const taskId of acknowledgedTaskIds) {
      const item = finalizedByTask.get(String(taskId));
      if (!item || item.action !== 'commit-cleanup') {
        throw new Error(`工具箱发布 ${taskId} 的 receipt 未完成确认清理`);
      }
    }
    return {
      recovered: [
        ...(Array.isArray(discovered.recovered)
          ? discovered.recovered.filter((item) => item.action !== 'commit-handoff-pending')
          : []),
        ...(Array.isArray(finalized && finalized.recovered) ? finalized.recovered : [])
      ],
      skippedActive: [
        ...(Array.isArray(discovered.skippedActive) ? discovered.skippedActive : []),
        ...(Array.isArray(finalized && finalized.skippedActive) ? finalized.skippedActive : [])
      ]
    };
  } catch (error) {
    throw startupBlockingRecoveryError(
      '工具箱 publication receipt 尚未由存档中心完整接管，已保留并阻止继续发布',
      error
    );
  }
}

module.exports = {
  recoverToolboxPublicationsIntoArchive,
  toolboxRecoveryInputFiles,
  toolboxRecoveryOutputFiles
};
