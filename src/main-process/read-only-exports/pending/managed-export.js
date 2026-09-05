'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fromProtocolError } = require('../../background-execution/error-codec');
const {
  freezeWorkerOperationContext
} = require('../../archive-center/worker-operation-context');
const {
  validateTaskOwnedStagingPath
} = require('../../statement-worker/staging-ownership');
const { validatePendingGeneratedArtifact } = require('./business-validator');

function managedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function operationContextFromBatch(batchContext) {
  return freezeWorkerOperationContext({
    taskRunId: batchContext && batchContext.taskRunId,
    taskKey: batchContext && batchContext.taskKey,
    moduleId: batchContext && batchContext.moduleId,
    parentRunId: batchContext && batchContext.parentRunId,
    operationKey: batchContext && batchContext.operationKey
  }, { required: true });
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1) {
      throw managedError('PENDING_EXPORT_SOURCE_WRITE_FAILED', 'Pending error source 写入不完整');
    }
    offset += bytesWritten;
  }
}

async function writePendingManagedErrorSource({ snapshot, stagingRoot }) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.errors)) {
    throw managedError('PENDING_EXPORT_SOURCE_INVALID', 'Pending error snapshot 非法');
  }
  const resolvedStagingRoot = path.resolve(stagingRoot);
  const sourcePath = path.join(resolvedStagingRoot, 'pending-errors.source.json');
  validateTaskOwnedStagingPath({
    stagingRoot: resolvedStagingRoot,
    candidatePath: sourcePath,
    finalState: 'missing'
  });
  const hash = crypto.createHash('sha256');
  let byteSize = 0;
  let handle = null;
  const append = async (text) => {
    const bytes = Buffer.from(text, 'utf8');
    await writeAll(handle, bytes);
    hash.update(bytes);
    byteSize += bytes.length;
  };
  try {
    handle = await fs.promises.open(sourcePath, 'wx', 0o600);
    await append('{');
    let emitted = false;
    for (const key of Object.keys(snapshot)) {
      const prefix = `${emitted ? ',' : ''}${JSON.stringify(key)}:`;
      if (key === 'errors') {
        await append(`${prefix}[`);
        for (let index = 0; index < snapshot.errors.length; index += 1) {
          const encoded = JSON.stringify(snapshot.errors[index]);
          if (typeof encoded !== 'string') {
            throw managedError('PENDING_EXPORT_SOURCE_INVALID', 'Pending error row 无法序列化');
          }
          await append(`${index === 0 ? '' : ','}${encoded}`);
        }
        await append(']');
      } else {
        const encoded = JSON.stringify(snapshot[key]);
        if (typeof encoded === 'undefined') continue;
        await append(`${prefix}${encoded}`);
      }
      emitted = true;
    }
    await append('}');
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch (_closeError) { /* preserve original */ }
    }
    try { await fs.promises.unlink(sourcePath); } catch (_unlinkError) { /* owner cleanup */ }
    throw error;
  }
  const sha256 = hash.digest('hex');
  return Object.freeze({
    source: Object.freeze({
      kind: 'managed-json',
      stagingRoot: resolvedStagingRoot,
      filePath: sourcePath,
      byteSize,
      sha256
    }),
    evidence: Object.freeze({
      contractVersion: 1,
      runIds: Object.freeze([]),
      sourceDigest: sha256
    }),
    context: Object.freeze({
      kind: 'pending-errors',
      errorCount: snapshot.errors.length
    })
  });
}

async function generateValidateAndPublishPendingExport(options = {}) {
  if (!options.runtime || typeof options.runtime.execute !== 'function') {
    throw new TypeError('Pending read-only export runtime 缺失');
  }
  if (typeof options.publisher !== 'function') {
    throw new TypeError('Pending read-only export Publisher 缺失');
  }
  const operationContext = operationContextFromBatch(options.batchContext);
  if (operationContext.operationKey !== options.operationKey ||
      operationContext.taskRunId !== options.taskRunId) {
    throw managedError('PENDING_EXPORT_TASK_AUTHORITY_MISMATCH', 'Pending task authority 不一致');
  }
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const input = {
    actionKey: options.actionKey,
    operationKey: options.operationKey,
    taskRunId: options.taskRunId,
    stableRunEvidence: options.stableRunEvidence,
    generationPlan: options.generationPlan,
    context: options.context,
    ...(options.dbPathOrManagedSource
      ? { dbPathOrManagedSource: options.dbPathOrManagedSource }
      : {})
  };
  const execution = await options.runtime.execute({
    actionKey: options.actionKey,
    operationKey: options.operationKey,
    production: options.production === true,
    context: { kind: 'operation', value: operationContext },
    input
  });
  if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
    if (execution && execution.error) throw fromProtocolError(execution.error);
    throw managedError('PENDING_EXPORT_GENERATION_FAILED', 'Pending read-only export Worker 失败');
  }
  if (execution.result.actionKey !== options.actionKey ||
      execution.result.operationKey !== options.operationKey ||
      execution.result.taskRunId !== options.taskRunId ||
      execution.result.sourceDigest !== options.stableRunEvidence.sourceDigest) {
    throw managedError('PENDING_EXPORT_MANIFEST_IDENTITY_MISMATCH', 'Pending export manifest identity 不一致');
  }
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const artifact = await validatePendingGeneratedArtifact({
    generationPlan: options.generationPlan,
    result: execution.result
  });
  if (typeof options.assertSourceFresh === 'function') await options.assertSourceFresh();
  const publication = await options.publisher(Object.freeze([artifact]), execution.result.summary);
  return Object.freeze({ artifact, summary: execution.result.summary, publication });
}

module.exports = {
  generateValidateAndPublishPendingExport,
  operationContextFromBatch,
  writePendingManagedErrorSource
};
