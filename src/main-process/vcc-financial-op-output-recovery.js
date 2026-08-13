'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  publishToolboxPublicationAsync,
  recoverToolboxPublicationsAsync
} = require('./toolbox-output-publication-dispatch');
const {
  recoverToolboxPublicationsIntoArchive
} = require('./toolbox-archive-recovery');
const {
  freezeWorkerBatchContext
} = require('./archive-center/worker-batch-context');

async function hashRegularFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error(`VCC 导出临时产物不是普通文件：${resolved}`);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(resolved);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return {
    filePath: resolved,
    byteSize: Number(stat.size),
    sha256: hash.digest('hex')
  };
}

function normalizedTargetSnapshot(value, index) {
  if (!value || typeof value.exists !== 'boolean') {
    throw new TypeError(`VCC 导出第 ${index + 1} 个目标缺少 prepare 阶段快照`);
  }
  return value;
}

async function publishVccFinancialOpOutputs(options = {}) {
  const batchContext = freezeWorkerBatchContext(options.batchContext, { required: true });
  const generationPaths = Array.isArray(options.generationFilePaths)
    ? options.generationFilePaths.map((filePath) => path.resolve(String(filePath || '')))
    : [];
  const targetPaths = Array.isArray(options.targetFilePaths)
    ? options.targetFilePaths.map((filePath) => path.resolve(String(filePath || '')))
    : [];
  const targetSnapshots = Array.isArray(options.targetSnapshots) ? options.targetSnapshots : [];
  if (generationPaths.length === 0 || generationPaths.length !== targetPaths.length) {
    throw new TypeError('VCC 导出的临时产物与正式目标必须是数量相同的非空数组');
  }
  if (targetSnapshots.length !== targetPaths.length) {
    throw new TypeError('VCC 导出的正式目标与 prepare 阶段快照数量不一致');
  }

  const inspected = await Promise.all(generationPaths.map(hashRegularFile));
  const taskId = `vcc-output-${batchContext.taskRunId}-${crypto.randomUUID()}`;
  const publishPublication = options.publishPublication || publishToolboxPublicationAsync;
  const recoverPublications = options.recoverPublications || recoverToolboxPublicationsAsync;
  const recoverIntoArchive = options.recoverIntoArchive
    || recoverToolboxPublicationsIntoArchive;
  const publication = await publishPublication({
    taskId,
    artifacts: inspected.map((file, index) => ({
      sourcePath: file.filePath,
      outputId: `vcc-output-${index + 1}`,
      fileName: path.basename(targetPaths[index]),
      byteSize: file.byteSize,
      sha256: file.sha256
    })),
    targets: targetPaths.map((targetPath, index) => ({
      targetPath,
      expectedTargetSnapshot: normalizedTargetSnapshot(targetSnapshots[index], index)
    })),
    protectedSourcePaths: [],
    userDataDir: options.userDataDir,
    batchContext,
    archiveInputFiles: [],
    allowEmptyArchiveInputs: true
  });

  // publication worker 已把 generation 内容复制到同目录 staging 并提交；
  // 这些应用临时产物不再是 crash recovery 的权威证据。
  for (const filePath of generationPaths) {
    try { await fs.promises.rm(filePath, { force: true }); } catch (_cleanupError) { /* caller retries dir */ }
  }

  try {
    await recoverIntoArchive({
      userDataDir: options.userDataDir,
      archiveCenter: options.archiveCenter,
      recoverPublications,
      taskIds: [publication.taskId]
    });
    if (typeof options.onDurableHandoff === 'function') {
      await options.onDurableHandoff(publication);
    }
  } catch (error) {
    if (typeof options.onHandoffPending === 'function') {
      try { options.onHandoffPending(error, publication); } catch (_logError) { /* logging only */ }
    }
    // 正式目标已 committed，不能因存档短暂失败把业务重新解释为
    // failed。TaskLifecycle 仍会在本进程按正常路径追加输出；receipt 则
    // 保留到追加+终态真正耐久后，或下次启动 owner 接管。
    return {
      ...publication,
      pendingArchiveHandoff: true,
      warnings: [
        ...(Array.isArray(publication.warnings) ? publication.warnings : []),
        'VCC 正式输出已保存；存档接管尚未完成，已保留 receipt 供启动时重试。'
      ]
    };
  }
  return publication;
}

module.exports = {
  hashRegularFile,
  publishVccFinancialOpOutputs
};
