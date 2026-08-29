'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { fromProtocolError } = require('../background-execution/error-codec');
const {
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_MAX_WRITERS,
  validateVccExportSubjectsResult
} = require('./policies');
const { planVccExportShards } = require('./shard-planner');
const { normalizeWriterInput } = require('./writer-core');

const SHARD_WORKER_ENTRY = path.join(__dirname, 'shard-writer-worker-entry.js');
const SHARD_CANCEL_TIMEOUT_MS = 5000;

function coordinatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function normalizeAdmittedTopology(value) {
  if (!exactKeys(value, ['effectiveChildCount', 'topologyKey']) ||
      value.topologyKey !== 'topology.vcc-financial-op:export-subjects' ||
      !Number.isSafeInteger(value.effectiveChildCount) || value.effectiveChildCount < 1 ||
      value.effectiveChildCount > VCC_EXPORT_SUBJECTS_MAX_WRITERS) {
    throw coordinatorError(
      'VCC_EXPORT_ADMITTED_TOPOLOGY_INVALID',
      'VCC Writer graph 缺少 exact admitted topology authority'
    );
  }
  return Object.freeze({
    topologyKey: value.topologyKey,
    effectiveChildCount: value.effectiveChildCount
  });
}

function shardInput(input, shard) {
  return Object.freeze({
    contractVersion: input.contractVersion,
    databasePath: input.databasePath,
    assetsDir: input.assetsDir,
    authority: input.authority,
    task: input.task,
    generations: shard.generations,
    stagingIdentity: input.stagingIdentity,
    shard: Object.freeze({
      contractVersion: shard.contractVersion,
      shardIndex: shard.shardIndex,
      shardCount: shard.shardCount,
      subjectIndexes: shard.subjectIndexes,
      shardDigest: shard.shardDigest
    })
  });
}

function safeTerminate(worker) {
  if (!worker || typeof worker.terminate !== 'function') return;
  try { Promise.resolve(worker.terminate()).catch(() => undefined); } catch (_error) { /* best effort */ }
}

function runVccExportShardWorker(input, signal, options = {}) {
  const WorkerClass = options.WorkerClass || Worker;
  const cancelTimeoutMs = Number.isSafeInteger(options.cancelTimeoutMs) && options.cancelTimeoutMs >= 0
    ? options.cancelTimeoutMs
    : SHARD_CANCEL_TIMEOUT_MS;
  let worker;
  try {
    worker = new WorkerClass(SHARD_WORKER_ENTRY, { workerData: { input } });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminalMessage = null;
    let transportError = null;
    let cancelTimer = null;
    let cancelSent = false;

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearTimeout(cancelTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    }

    function onAbort() {
      if (settled || cancelSent) return;
      cancelSent = true;
      try { worker.postMessage({ contractVersion: 1, operation: 'cancel' }); } catch (error) {
        transportError ||= error;
      }
      cancelTimer = setTimeout(() => {
        if (!settled) safeTerminate(worker);
      }, cancelTimeoutMs);
      if (cancelTimer.unref) cancelTimer.unref();
    }

    worker.on('message', (message) => {
      if (terminalMessage !== null) {
        transportError ||= coordinatorError(
          'VCC_EXPORT_SHARD_DUPLICATE_TERMINAL',
          'VCC shard Writer 返回重复 terminal message'
        );
        safeTerminate(worker);
        return;
      }
      terminalMessage = message;
    });
    worker.on('messageerror', (error) => {
      transportError ||= error instanceof Error
        ? error
        : coordinatorError('VCC_EXPORT_SHARD_MESSAGE_ERROR', 'VCC shard message 无法反序列化');
      safeTerminate(worker);
    });
    worker.on('error', (error) => { transportError ||= error; });
    worker.once('exit', (code) => {
      if (transportError) return finish(reject, transportError);
      if (signal && signal.aborted) {
        return finish(reject, coordinatorError('VCC_EXPORT_CANCELLED', 'VCC export Writer 已取消'));
      }
      if (code !== 0) {
        return finish(
          reject,
          coordinatorError('VCC_EXPORT_SHARD_TRANSPORT_CRASH', `VCC shard Writer异常退出：${code}`)
        );
      }
      if (!exactKeys(terminalMessage, ['contractVersion', 'error', 'ok', 'result']) ||
          terminalMessage.contractVersion !== 1 || typeof terminalMessage.ok !== 'boolean' ||
          (terminalMessage.ok
            ? terminalMessage.error !== null || !terminalMessage.result
            : terminalMessage.result !== null || !terminalMessage.error)) {
        return finish(
          reject,
          coordinatorError('VCC_EXPORT_SHARD_RESULT_INVALID', 'VCC shard Writer terminal 非法')
        );
      }
      if (!terminalMessage.ok) return finish(reject, fromProtocolError(terminalMessage.error));
      return finish(resolve, terminalMessage.result);
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function validateShardResult(input, shard, result) {
  if (!exactKeys(result, [
    'actionKey', 'archiveStateDigest', 'artifacts', 'authorityDigest', 'contractVersion',
    'inputFingerprint', 'resultRevision', 'runId', 'shard', 'summary', 'targetMonth', 'task'
  ]) || result.contractVersion !== 1 || result.actionKey !== VCC_EXPORT_SUBJECTS_ACTION ||
      result.runId !== input.authority.runId ||
      result.targetMonth !== input.authority.targetMonth ||
      result.resultRevision !== input.authority.resultRevision ||
      result.inputFingerprint !== input.authority.inputFingerprint ||
      result.archiveStateDigest !== input.authority.archiveStateDigest ||
      result.authorityDigest !== input.authority.authorityDigest ||
      canonicalSha256(result.task) !== canonicalSha256(input.task) ||
      canonicalSha256(result.shard) !== canonicalSha256({
        contractVersion: shard.contractVersion,
        shardIndex: shard.shardIndex,
        shardCount: shard.shardCount,
        subjectIndexes: shard.subjectIndexes,
        shardDigest: shard.shardDigest
      }) ||
      !Array.isArray(result.artifacts) || result.artifacts.length !== shard.generations.length ||
      !exactKeys(result.summary, ['artifactCount', 'subjectCount']) ||
      result.summary.artifactCount !== result.artifacts.length ||
      result.summary.subjectCount !== result.artifacts.length) {
    throw coordinatorError('VCC_EXPORT_SHARD_RESULT_INVALID', 'VCC shard manifest authority 非法');
  }
  for (let index = 0; index < result.artifacts.length; index += 1) {
    const artifact = result.artifacts[index];
    const generation = shard.generations[index];
    const subject = input.authority.subjects[generation.subjectIndex];
    if (!exactKeys(artifact, [
      'businessDigest', 'byteSize', 'outputArtifactKey', 'pendingRowCount',
      'resultRowCount', 'sha256', 'subjectDigest', 'subjectIndex'
    ]) || artifact.subjectIndex !== generation.subjectIndex ||
        artifact.outputArtifactKey !== generation.outputArtifactKey ||
        artifact.subjectDigest !== subject.subjectDigest ||
        artifact.businessDigest !== subject.businessDigest ||
        artifact.resultRowCount !== subject.resultRowCount ||
        artifact.pendingRowCount !== subject.pendingRowCount ||
        !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 1 ||
        typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw coordinatorError('VCC_EXPORT_SHARD_RESULT_INVALID', 'VCC shard artifact authority 非法');
    }
  }
  return result;
}

function mergeVccExportShardResults(input, shards, results) {
  if (!Array.isArray(results) || results.length !== shards.length) {
    throw coordinatorError('VCC_EXPORT_SHARD_RESULT_INVALID', 'VCC shard result set 不完整');
  }
  const artifacts = [];
  for (let index = 0; index < shards.length; index += 1) {
    const result = validateShardResult(input, shards[index], results[index]);
    artifacts.push(...result.artifacts);
  }
  artifacts.sort((left, right) => left.subjectIndex - right.subjectIndex);
  if (artifacts.length !== input.generations.length ||
      artifacts.some((artifact, index) => artifact.subjectIndex !== index ||
        artifact.outputArtifactKey !== input.generations[index].outputArtifactKey)) {
    throw coordinatorError(
      'VCC_EXPORT_SHARD_COVERAGE_INVALID',
      'VCC shard merge 存在 subjectIndex 重复或遗漏'
    );
  }
  const merged = Object.freeze({
    contractVersion: 1,
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    runId: input.authority.runId,
    targetMonth: input.authority.targetMonth,
    resultRevision: input.authority.resultRevision,
    inputFingerprint: input.authority.inputFingerprint,
    archiveStateDigest: input.authority.archiveStateDigest,
    authorityDigest: input.authority.authorityDigest,
    task: input.task,
    artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    summary: Object.freeze({ subjectCount: artifacts.length, artifactCount: artifacts.length })
  });
  if (!validateVccExportSubjectsResult(merged)) {
    throw coordinatorError('VCC_EXPORT_SHARD_RESULT_INVALID', 'VCC shard merge 未形成 canonical manifest');
  }
  return merged;
}

async function executeVccExportWriterGraph(rawInput, signal, options = {}) {
  const input = normalizeWriterInput(rawInput, VCC_EXPORT_SUBJECTS_ACTION);
  const topology = normalizeAdmittedTopology(options.admittedTopology);
  const shards = planVccExportShards(input.generations, topology.effectiveChildCount);
  const group = new AbortController();
  const abortFromParent = () => group.abort(signal && signal.reason);
  if (signal) {
    if (signal.aborted) abortFromParent();
    else signal.addEventListener('abort', abortFromParent, { once: true });
  }
  const runShard = options.runShard || runVccExportShardWorker;
  const tasks = shards.map((shard) => Promise.resolve().then(() => (
    runShard(shardInput(input, shard), group.signal, options)
  )).catch((error) => {
    group.abort(error);
    throw error;
  }));
  const settled = await Promise.allSettled(tasks);
  if (signal) signal.removeEventListener('abort', abortFromParent);
  const failures = settled.map((item, shardIndex) => ({ item, shardIndex }))
    .filter(({ item }) => item.status === 'rejected');
  if (failures.length > 0) {
    const nonCancellation = failures.find(({ item }) => (
      !item.reason || item.reason.code !== 'VCC_EXPORT_CANCELLED'
    ));
    throw (nonCancellation || failures[0]).item.reason;
  }
  return mergeVccExportShardResults(
    input,
    shards,
    settled.map((item) => item.value)
  );
}

module.exports = {
  executeVccExportWriterGraph,
  mergeVccExportShardResults,
  normalizeAdmittedTopology,
  runVccExportShardWorker,
  shardInput
};
