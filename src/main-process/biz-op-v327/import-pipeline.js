'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setImmediate: yieldToMessages } = require('node:timers/promises');
const { openSingleSheetRichWorkbook } = require('../../backend/xlsx-rich-reader');
const { createCandidateRouter } = require('./candidate-router');
const { detectHeader, createImportAdapter, cellText, CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { fail } = require('./contracts');

const SST_MEMORY_BUDGET = 32 * 1024 * 1024;
const SST_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const ERROR_SAMPLE_ROWS = 1000;
const ERROR_SAMPLE_BYTES = 8 * 1024 * 1024;

function createSampler(filePath, { maxSamples = ERROR_SAMPLE_ROWS, maxSampleBytes = ERROR_SAMPLE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 0 || maxSamples > ERROR_SAMPLE_ROWS
      || !Number.isSafeInteger(maxSampleBytes) || maxSampleBytes < 1 || maxSampleBytes > ERROR_SAMPLE_BYTES) {
    throw new TypeError('错误采样参数只能在合同上限内收紧');
  }
  const fd = fs.openSync(filePath, 'wx', 0o600);
  let closed = false;
  let collectedSamples = 0;
  let sampleBytes = 0;
  let errorSamplesTruncated = false;
  return Object.freeze({
    sample(value) {
      if (closed) fail('BIZOP_REPORT_CLOSED');
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (collectedSamples >= maxSamples || sampleBytes + bytes.length > maxSampleBytes) { errorSamplesTruncated = true; return; }
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written < 1) fail('BIZOP_REPORT_WRITE_INCOMPLETE');
        offset += written;
      }
      collectedSamples += 1; sampleBytes += bytes.length;
    },
    snapshot: () => ({ collectedSamples, sampleBytes, errorSamplesTruncated }),
    close() {
      if (closed) return;
      closed = true;
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  });
}
function resourceOrCancel(error, cancelToken) {
  return cancelToken.cancelled || /^BIZOP_(CANCELLED|ROUTE_METADATA_LIMIT|ROUTER_STOPPED|REPORT_)/.test(error.code || '')
    || /^CANDIDATE_WRITER_/.test(error.code || '') || ['ENOSPC', 'ENOMEM', 'EMFILE', 'ENFILE', 'EIO'].includes(error.code)
    || error instanceof AggregateError;
}

async function runImportPipeline({ payloadStore, taskRunId, intentDigest, candidateRef, reportRef, files, planDigest = intentDigest,
  cancelToken = { cancelled: false }, options = {} }) {
  const safePoint = () => { if (cancelToken.cancelled) fail('BIZOP_CANCELLED', '业务 OP 导入已取消'); };
  const report = payloadStore.prepareCandidate(taskRunId, reportRef);
  const router = createCandidateRouter({ payloadStore, taskRunId, intentDigest, safePoint,
    partTargetRows: options.partTargetRows, partTargetBytes: options.partTargetBytes, writerOptions: options.writerOptions });
  const sampler = createSampler(path.join(report.directory, 'part-000001.jsonl'), options);
  const counters = { scannedDataRows: 0, acceptedRows: 0, rowErrorCount: 0, fileErrorCount: 0,
    scanComplete: true, errorCountExact: true, batchRejected: false };
  const metrics = { elapsedMs: 0, readerMs: 0, sstPeakMemoryBytes: 0, sstPeakCacheBytes: 0,
    sstCacheHits: 0, sstCacheMisses: 0, sstSpillBytes: 0, peakRss: process.memoryUsage().rss };
  const summaries = [];
  let references = [];
  const started = Date.now();
  const rejectBatch = () => { if (!counters.batchRejected) { counters.batchRejected = true; router.reject(); } };
  try {
    if (!Array.isArray(files) || !files.length) fail('BIZOP_INPUT_SET_EMPTY');
    for (const file of files) {
      safePoint();
      const summary = { artifactId: file.artifactId, order: file.order, scannedDataRows: 0,
        acceptedRows: 0, rowErrorCount: 0, scanComplete: false };
      summaries.push(summary);
      let workbook;
      let adapter;
      let kind;
      let fileFailed = false;
      let abort = false;
      const fileStarted = Date.now();
      try {
        const handle = await fs.promises.open(file.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let sourceIdentity;
        const identity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
        try {
          const before = await handle.stat();
          if (!before.isFile()) fail('BIZOP_ORIGINAL_VERIFY_FAILED');
          sourceIdentity = identity(before);
          const hasher = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false })) { safePoint(); hasher.update(chunk); }
          if (hasher.digest('hex') !== file.sha256 || identity(await handle.stat()) !== sourceIdentity) fail('BIZOP_ORIGINAL_VERIFY_FAILED');
        } finally { await handle.close(); }
        workbook = await openSingleSheetRichWorkbook(file.filePath, {
          sstTempRoot: path.join(payloadStore.prepareCandidate(taskRunId, candidateRef).directory, `sst-${file.order}`),
          memoryBudgetBytes: options.sstMemoryBudgetBytes ?? SST_MEMORY_BUDGET,
          cacheMaxBytes: options.sstCacheMaxBytes ?? SST_CACHE_MAX_BYTES,
          lruMaxEntries: options.sstLruMaxEntries, cancelToken
        });
        await workbook.scan((row) => {
          safePoint();
          if (!adapter) { kind = detectHeader(row); adapter = createImportAdapter(kind); return; }
          const adapted = adapter.adapt(row);
          if (adapted.blank) return;
          counters.scannedDataRows += 1; summary.scannedDataRows += 1;
          if (adapted.errors.length) {
            counters.rowErrorCount += 1; summary.rowErrorCount += 1;
            rejectBatch();
            sampler.sample({ type: 'ROW', artifactId: file.artifactId, fileOrder: file.order,
              sheetName: workbook.sheet.name, rowIndex: row.rowIndex, kind, errors: adapted.errors,
              cells: row.cells.map((cell) => ({ columnIndex: cell.columnIndex, value: cellText(cell), type: cell.cellType })) });
          } else {
            counters.acceptedRows += 1; summary.acceptedRows += 1;
            if (!counters.batchRejected) router.append(adapted, { ...file, sheetName: workbook.sheet.name });
          }
          if (counters.scannedDataRows % 1024 === 0) metrics.peakRss = Math.max(metrics.peakRss, process.memoryUsage().rss);
        });
        if (identity(await fs.promises.stat(file.filePath)) !== sourceIdentity) fail('BIZOP_ORIGINAL_VERIFY_FAILED');
        if (!adapter || !summary.scannedDataRows) fail('BIZOP_INPUT_EMPTY', '输入文件没有可检查的数据行');
        summary.scanComplete = true;
      } catch (error) {
        fileFailed = true;
        abort = resourceOrCancel(error, cancelToken);
        counters.fileErrorCount += 1;
        counters.scanComplete = false;
        rejectBatch();
        sampler.sample({ type: 'FILE', artifactId: file.artifactId, fileOrder: file.order,
          code: error.code || 'BIZOP_WORKBOOK_INVALID', message: error.message });
      } finally {
        if (workbook) {
          const provider = workbook.sharedStrings;
          metrics.sstPeakMemoryBytes = Math.max(metrics.sstPeakMemoryBytes, provider.peakMemoryBytes || 0);
          metrics.sstPeakCacheBytes = Math.max(metrics.sstPeakCacheBytes, provider.peakCacheBytes || 0);
          metrics.sstCacheHits += provider.cacheHits || 0; metrics.sstCacheMisses += provider.cacheMisses || 0;
          metrics.sstSpillBytes += (provider.binOffset || 0) + (provider.mode === 'disk' ? provider.count * 12 : 0);
          try { await workbook.close(); } catch (error) {
            if (!fileFailed) counters.fileErrorCount += 1;
            counters.scanComplete = false; summary.scanComplete = false; abort = true;
            rejectBatch();
            sampler.sample({ type: 'FILE', artifactId: file.artifactId, fileOrder: file.order,
              code: 'BIZOP_READER_CLOSE_PENDING', message: error.message });
          }
        }
        metrics.readerMs += Date.now() - fileStarted;
      }
      if (abort) break;
      await yieldToMessages();
    }
    safePoint();
    if (!counters.batchRejected) references = await router.finish();
    safePoint();
  } catch (error) {
    counters.batchRejected = true; counters.scanComplete = false;
    counters.fileErrorCount += 1;
    sampler.sample({ type: 'BATCH', code: error.code || 'BIZOP_IMPORT_INCOMPLETE', message: error.message });
  } finally {
    try { router.close(); } finally { sampler.close(); }
  }
  counters.scanComplete = counters.scanComplete && summaries.length === files.length && summaries.every((item) => item.scanComplete);
  counters.errorCountExact = counters.scanComplete;
  if (!counters.scanComplete) counters.batchRejected = true;
  metrics.elapsedMs = Date.now() - started;
  metrics.peakRss = Math.max(metrics.peakRss, process.memoryUsage().rss);
  const sampling = sampler.snapshot();
  const result = { schemaVersion: 1, taskRunId, intentDigest, candidateRef, reportRef,
    cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION,
    ...counters, ...sampling, cancelled: Boolean(cancelToken.cancelled), files: summaries, references,
    metrics: { ...metrics, router: router.snapshot(), sstMemoryBudgetBytes: options.sstMemoryBudgetBytes ?? SST_MEMORY_BUDGET,
      sstCacheMaxBytes: options.sstCacheMaxBytes ?? SST_CACHE_MAX_BYTES } };
  // 诊断独立封存。样本只在受控文件中，任务消息始终仅返回 result 文档的不透明引用。
  const reportToken = await payloadStore.sealCandidate({ taskRunId, objectId: reportRef, objectKind: 'DIAGNOSTIC', intentDigest,
    catalog: { scanComplete: counters.scanComplete, errorCountExact: counters.errorCountExact, producerPlanDigest: planDigest, ...sampling },
    parts: [{ name: 'part-000001.jsonl', rowCount: sampling.collectedSamples }] });
  result.reportManifestDigest = reportToken.sha256;
  if (!counters.batchRejected) {
    // 只删除本 worker 已关闭资源后的空工作目录；任何意外内容使整批停下，交给 Main 恢复。
    const temporary = payloadStore.resolve(`staging/${taskRunId}/${candidateRef}`, { mustExist: false });
    if (fs.existsSync(temporary)) await fs.promises.rmdir(temporary);
    await fs.promises.rmdir(payloadStore.resolve(`staging/${taskRunId}`));
  }
  // 报告封存和空目录清理仍有异步等待。保留完整诊断，但最后收到的取消不得交付可提交文档。
  await yieldToMessages();
  result.cancelled = Boolean(cancelToken.cancelled);
  if (result.cancelled) result.batchRejected = true;
  const document = payloadStore.writeDocument(`operations/${taskRunId}/${candidateRef}.json`, result);
  return { contractVersion: 1, candidateRef, rowCount: counters.acceptedRows,
    sha256: document.digest };
}

module.exports = { runImportPipeline, createSampler, SST_MEMORY_BUDGET, SST_CACHE_MAX_BYTES, ERROR_SAMPLE_ROWS, ERROR_SAMPLE_BYTES };
