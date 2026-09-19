'use strict';

// 验证专用：worker_threads 共享 PID，rss 是整个宿主进程的驻留集，不能按线程相加。
// 样本仅同步追加到 JSONL；Main 只接收 ready / complete，不积压采样消息。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('node:worker_threads');

const WORKER_KIND = 'vcc-host-process-rss-sampler-v1';
const HANDSHAKE_TIMEOUT_MS = 5000;
const TERMINATE_TIMEOUT_MS = 2000;

function samplerError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
}

function runSamplerWorker() {
  let fd;
  let timer;
  let stopped = false;
  const { outputPath, intervalMs } = workerData;
  const digest = crypto.createHash('sha256');
  let count = 0;
  let periodicCount = 0;
  let firstNs;
  let previousNs;
  let maxGapNs = 0n;
  let baseline = 0;
  let peak = 0;
  let finalRss = 0;

  function sample(periodic) {
    const nowNs = process.hrtime.bigint();
    const rssBytes = process.memoryUsage.rss();
    if (!Number.isSafeInteger(rssBytes) || rssBytes <= 0 || (previousNs !== undefined && nowNs <= previousNs)) {
      throw samplerError('RSS_SAMPLER_INVALID_SAMPLE', 'RSS 或单调时钟无效');
    }
    const record = { seq: count, pid: process.pid, threadId, atNs: nowNs.toString(), at: Date.now(), rssBytes };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw samplerError('RSS_SAMPLER_SHORT_WRITE', '样本未完整写入');
      offset += written;
    }
    digest.update(bytes);
    if (count === 0) {
      firstNs = nowNs;
      baseline = rssBytes;
    } else if (nowNs - previousNs > maxGapNs) maxGapNs = nowNs - previousNs;
    previousNs = nowNs;
    peak = Math.max(peak, rssBytes);
    finalRss = rssBytes;
    count += 1;
    if (periodic) periodicCount += 1;
  }

  function fail(error) {
    stopped = true;
    clearInterval(timer);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* 首个 IO 错误保留；部分 JSONL 不作合格证据。 */ }
      fd = undefined;
    }
    parentPort.close();
    throw error;
  }

  try {
    fd = fs.openSync(outputPath, 'wx', 0o600);
    sample(false);
    timer = setInterval(() => {
      if (stopped) return;
      try { sample(true); } catch (error) { fail(error); }
    }, intervalMs);
    parentPort.on('message', message => {
      if (stopped) return;
      if (!message || message.type !== 'stop') {
        fail(samplerError('RSS_SAMPLER_PROTOCOL_ERROR', '未知采样命令'));
        return;
      }
      stopped = true;
      clearInterval(timer);
      try {
        sample(false);
        fs.closeSync(fd);
        fd = undefined;
        const maxGapMs = Number(maxGapNs) / 1e6;
        const summary = {
          schemaVersion: 1,
          metric: 'host-process-rss-v1',
          status: maxGapMs > intervalMs * 1.5 ? 'NOT_RUN' : 'PASS',
          pid: process.pid,
          samplerThreadId: threadId,
          sampleCount: count,
          periodicSampleCount: periodicCount,
          intervalMs,
          maxAllowedGapMs: intervalMs * 1.5,
          maxGapMs,
          firstSampleAtNs: firstNs.toString(),
          lastSampleAtNs: previousNs.toString(),
          baselineRssBytes: baseline,
          peakRssBytes: peak,
          finalRssBytes: finalRss,
          durationMs: Number(previousNs - firstNs) / 1e6,
          outputPath,
          sha256: digest.digest('hex')
        };
        parentPort.postMessage({ type: 'complete', summary });
        parentPort.close();
      } catch (error) { fail(error); }
    });
    parentPort.postMessage({ type: 'ready', pid: process.pid, threadId });
  } catch (error) { fail(error); }
}

async function startRssSampler({ outputPath, intervalMs = 500 } = {}) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new TypeError('outputPath 必须是非空文件路径');
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2147483647) {
    throw new TypeError('intervalMs 必须是 1..2147483647 的整数毫秒');
  }
  const resolvedPath = path.resolve(outputPath);
  const worker = new Worker(__filename, { workerData: { kind: WORKER_KIND, outputPath: resolvedPath, intervalMs } });
  const samplerThreadId = worker.threadId;
  let resolveReady, rejectReady, resolveFinished, rejectFinished;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  // 后台失败可能先于调用 stop；保留 rejected Promise，避免未处理拒绝但不吞掉 stop 错误。
  finished.catch(() => {});
  let readySeen = false;
  let stopRequested = false;
  let complete;
  let exited = false;
  let failure;
  let stopTimer;
  let startTimer;

  function clearTimers() {
    clearTimeout(startTimer);
    clearTimeout(stopTimer);
  }
  function removeListeners() {
    worker.removeListener('message', onMessage);
    worker.removeListener('exit', onExit);
    worker.removeListener('error', onError);
  }
  function fail(error) {
    if (failure) return;
    failure = error;
    clearTimers();
    void (async () => {
      let terminationTimer;
      try {
        if (!exited) {
          await Promise.race([
            worker.terminate(),
            new Promise((_, reject) => {
              terminationTimer = setTimeout(() => reject(samplerError('RSS_SAMPLER_TERMINATE_TIMEOUT', '停止采样线程超时')), TERMINATE_TIMEOUT_MS);
            })
          ]);
        }
      } catch (terminationError) {
        failure = samplerError('RSS_SAMPLER_CLEANUP_FAILED', `${error.message}; ${terminationError.message}`);
        failure.cause = error;
        worker.unref();
      } finally {
        clearTimeout(terminationTimer);
        removeListeners();
        // terminate 异常时仍可能到达迟到的 error 事件，不让它变成 Main 的未捕获异常。
        if (!exited) worker.on('error', () => {});
        rejectReady(failure);
        rejectFinished(failure);
      }
    })();
  }
  function onError(error) { fail(error); }
  function onMessage(message) {
    if (failure) return;
    if (message && message.type === 'ready' && !readySeen && !stopRequested
      && message.pid === process.pid && message.threadId === samplerThreadId && samplerThreadId > 0) {
      readySeen = true;
      clearTimeout(startTimer);
      resolveReady();
    } else if (message && message.type === 'complete' && readySeen && stopRequested && !complete
      && message.summary && message.summary.pid === process.pid
      && message.summary.samplerThreadId === samplerThreadId && message.summary.outputPath === resolvedPath) {
      complete = message.summary;
    } else {
      fail(samplerError('RSS_SAMPLER_PROTOCOL_ERROR', '采样握手顺序或线程身份不匹配'));
    }
  }
  function onExit(code) {
    exited = true;
    if (failure) return;
    if (code !== 0 || !readySeen || !stopRequested || !complete) {
      fail(samplerError('RSS_SAMPLER_UNEXPECTED_EXIT', `线程提前或异常退出，code=${code}`));
      return;
    }
    clearTimers();
    removeListeners();
    resolveFinished(complete);
  }
  worker.on('message', onMessage);
  worker.on('error', onError);
  worker.on('exit', onExit);
  startTimer = setTimeout(() => fail(samplerError('RSS_SAMPLER_START_TIMEOUT', '首样本握手超时')), HANDSHAKE_TIMEOUT_MS);
  await ready;
  return {
    stop() {
      if (!stopRequested && !failure) {
        stopRequested = true;
        stopTimer = setTimeout(() => fail(samplerError('RSS_SAMPLER_STOP_TIMEOUT', '尾样本或线程退出超时')), HANDSHAKE_TIMEOUT_MS);
        try { worker.postMessage({ type: 'stop' }); } catch (error) { fail(error); }
      }
      return finished;
    }
  };
}

if (!isMainThread && workerData && workerData.kind === WORKER_KIND) runSamplerWorker();
module.exports = { startRssSampler };
