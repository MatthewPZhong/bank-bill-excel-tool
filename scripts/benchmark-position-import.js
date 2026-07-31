'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  POSITION_IMPORT_COMMANDS,
  normalizePositionStreamingSourceTypes
} = require('../src/backend/position-reconciliation-import/constants');
const {
  openZipWithEntries,
  SHARED_STRINGS_ENTRY_NAME
} = require('../src/backend/big-table-import/zip-reader');
const {
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration
} = require('../src/main-process/position-reconciliation/import-dispatch');
const {
  createPositionReconciliationStore
} = require('../src/main-process/position-reconciliation/store');
const {
  readPositionDatabaseCheckpoint
} = require('../src/main-process/position-reconciliation/side-db-mutation');

function monotonicNowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function parseArgs(values) {
  const options = {
    kind: 'source',
    keep: false,
    apply: false,
    progress: false,
    evidenceFile: '',
    userDataDir: '',
    streamingSourceTypes: '',
    files: []
  };
  for (const value of values) {
    if (value === '--keep') options.keep = true;
    else if (value === '--apply') options.apply = true;
    else if (value === '--progress') options.progress = true;
    else if (value.startsWith('--kind=')) options.kind = value.slice('--kind='.length);
    else if (value.startsWith('--evidence-file=')) {
      options.evidenceFile = path.resolve(value.slice('--evidence-file='.length));
    } else if (value.startsWith('--user-data=')) {
      options.userDataDir = path.resolve(value.slice('--user-data='.length));
    } else if (value.startsWith('--streaming-source-types=')) {
      options.streamingSourceTypes = value.slice('--streaming-source-types='.length);
    } else options.files.push(path.resolve(value));
  }
  if (!['source', 'bank'].includes(options.kind)) {
    throw new Error('--kind 仅允许 source 或 bank');
  }
  return options;
}

function directorySize(root) {
  let total = 0;
  if (!fs.existsSync(root)) return total;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function writeEvidence(evidenceFile, evidence) {
  if (!evidenceFile) return;
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  const temporaryPath = `${evidenceFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600
  });
  fs.renameSync(temporaryPath, evidenceFile);
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * ratio) - 1)
  );
  return ordered[index];
}

function measureStoreSummaries(userDataDir, checkpoint) {
  const store = createPositionReconciliationStore(userDataDir, {
    expectedCheckpoint: checkpoint
  });
  const targets = {
    status: () => {
      store.getBankManagerSnapshot();
      store.listLinkedSummary();
      store.latestPendingRun();
    },
    dataManager: () => {
      store.getBankManagerSnapshot();
      store.listDifferenceSummary();
    },
    linkedManager: () => {
      store.listLinkedSummary();
      store.listRawSummary();
      store.listSourceMonths();
    }
  };
  const result = {};
  try {
    for (const [name, task] of Object.entries(targets)) {
      const samples = [];
      for (let index = 0; index < 20; index += 1) {
        const startedAt = process.hrtime.bigint();
        task();
        samples.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      }
      result[name] = {
        samples: samples.length,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        maxMs: Math.max(...samples)
      };
    }
  } finally {
    store.close();
  }
  return result;
}

async function fileZipEvidence(filePath) {
  const stat = fs.statSync(filePath);
  const opened = await openZipWithEntries(path.basename(filePath), filePath, {
    rejectDuplicateEntries: true
  });
  try {
    let uncompressedBytes = 0;
    for (const entry of opened.entries.values()) {
      uncompressedBytes += Number(entry.uncompressedSize || 0);
    }
    const sharedStrings = opened.entries.get(SHARED_STRINGS_ENTRY_NAME);
    return {
      fileName: path.basename(filePath),
      sizeBytes: stat.size,
      uncompressedBytes,
      sharedStringsUncompressedBytes: Number(
        sharedStrings && sharedStrings.uncompressedSize || 0
      )
    };
  } finally {
    opened.zip.close();
  }
}

function databaseEvidence(sideDbPath, operationToken, expectedProofs) {
  const db = new DatabaseSync(sideDbPath, { readOnly: true });
  try {
    return {
      bankRows: Number(
        db.prepare('SELECT COUNT(*) AS count FROM position_bank_rows').get().count
      ),
      sourceRows: Number(
        db.prepare('SELECT COUNT(*) AS count FROM position_source_rows').get().count
      ),
      linkRows: Number(
        db.prepare('SELECT COUNT(*) AS count FROM position_link_rows').get().count
      ),
      distinctSourceRecordKeys: Number(db.prepare(`
        SELECT COUNT(DISTINCT row_hash) AS count
        FROM position_source_rows
      `).get().count),
      committedInputProofs: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
        WHERE operation_token = ?
      `).get(operationToken).count),
      expectedProofs,
      checkpoint: readPositionDatabaseCheckpoint(db),
      quickCheck: db.prepare('PRAGMA quick_check').all().map((row) => row.quick_check)
    };
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  if (options.files.length === 0) {
    process.stdout.write(`${JSON.stringify({
      status: 'no-input',
      generatedAt,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    }, null, 2)}\n`);
    return;
  }
  const userDataDir = options.userDataDir ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'position-import-benchmark-'));
  fs.mkdirSync(userDataDir, { recursive: true });
  const startedAt = monotonicNowMs();
  const baselineMemory = process.memoryUsage();
  let sideDbPath = '';
  let initialCheckpoint = null;
  let schemaFingerprint = '';
  let operationToken = '';
  const streamingSourceTypes = [...normalizePositionStreamingSourceTypes(
    options.streamingSourceTypes,
    { engine: 'streaming' }
  )];
  if (options.apply) {
    initialCheckpoint = {
      identity: crypto.randomUUID(),
      generation: 0,
      token: crypto.randomUUID()
    };
    const store = createPositionReconciliationStore(userDataDir, {
      initialCheckpoint
    });
    sideDbPath = store.dbPath;
    store.close();
    const schema = await dispatchPositionLargeImportSchemaMigration({
      engine: 'streaming',
      userDataDir,
      sideDbPath,
      expectedCheckpoint: initialCheckpoint
    }).promise;
    schemaFingerprint = schema.fingerprint;
    operationToken = crypto.randomUUID();
  }

  let mainPeakRssBytes = baselineMemory.rss;
  let mainPeakHeapUsedBytes = baselineMemory.heapUsed;
  let peakRunDataBytes = 0;
  let workerPeakRssBytes = 0;
  let workerPeakHeapUsedBytes = 0;
  let lastProgressAt = startedAt;
  let lastProgressEvent = {
    capturedAt: Date.now(),
    stage: 'benchmark-start'
  };
  let maxProgressGap = {
    durationMs: 0,
    fromStage: 'benchmark-start',
    toStage: 'benchmark-start'
  };
  let lastReportedAt = 0;
  let lastSampledAt = 0;
  let lastSampledStage = '';
  let maxProgressSilenceMs = 0;
  const progressSamples = [];
  const sampler = setInterval(() => {
    const memory = process.memoryUsage();
    mainPeakRssBytes = Math.max(mainPeakRssBytes, memory.rss);
    mainPeakHeapUsedBytes = Math.max(mainPeakHeapUsedBytes, memory.heapUsed);
    peakRunDataBytes = Math.max(
      peakRunDataBytes,
      directorySize(path.join(userDataDir, 'run-data', 'position-reconciliation'))
    );
  }, 250);
  sampler.unref();

  const onProgress = (event) => {
    const now = monotonicNowMs();
    const capturedAt = Date.now();
    const silenceMs = now - lastProgressAt;
    maxProgressSilenceMs = Math.max(maxProgressSilenceMs, silenceMs);
    if (silenceMs > maxProgressGap.durationMs) {
      maxProgressGap = {
        durationMs: silenceMs,
        fromStage: lastProgressEvent.stage || '',
        toStage: event.stage || '',
        fromCapturedAt: lastProgressEvent.capturedAt,
        toCapturedAt: capturedAt
      };
    }
    lastProgressAt = now;
    lastProgressEvent = {
      capturedAt,
      stage: event.stage || ''
    };
    workerPeakRssBytes = Math.max(
      workerPeakRssBytes,
      Number(event.workerRssBytes || 0)
    );
    workerPeakHeapUsedBytes = Math.max(
      workerPeakHeapUsedBytes,
      Number(event.workerHeapUsedBytes || 0)
    );
    if (options.progress && (
      lastReportedAt === 0
      || now - lastReportedAt >= 5000
      || event.stage === 'committed'
    )) {
      lastReportedAt = now;
      process.stderr.write(`${JSON.stringify({
        stage: event.stage,
        currentFile: event.currentFile,
        totalFiles: event.totalFiles,
        fileName: event.fileName,
        scannedRows: event.scannedRows,
        acceptedRows: event.acceptedRows,
        committedRows: event.committedRows,
        workerRssBytes: event.workerRssBytes,
        elapsedMs: now - startedAt
      })}\n`);
    }
    const shouldSample = progressSamples.length === 0
      || event.stage !== lastSampledStage
      || now - lastSampledAt >= 5000
      || event.stage === 'committing'
      || event.stage === 'committed';
    if (shouldSample && progressSamples.length < 500) {
      lastSampledAt = now;
      lastSampledStage = event.stage || '';
      progressSamples.push({
        capturedAt,
        stage: event.stage,
        currentFile: event.currentFile,
        scannedRows: event.scannedRows,
        acceptedRows: event.acceptedRows,
        committedRows: event.committedRows,
        workerRssBytes: event.workerRssBytes,
        elapsedMs: now - startedAt,
        workerElapsedMs: Number(event.elapsedMs || 0)
      });
    }
  };

  try {
    let preflightResult;
    let result;
    if (options.kind === 'bank') {
      const preparedJob = dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.BANK_PREPARE,
        files: options.files,
        userDataDir,
        sideDbPath,
        onProgress
      });
      preflightResult = await preparedJob.promise;
      if (options.apply) {
        result = await dispatchPositionImportPreflight({
          engine: 'streaming',
          command: POSITION_IMPORT_COMMANDS.BANK_APPLY,
          files: [],
          userDataDir,
          sideDbPath,
          expectedCheckpoint: initialCheckpoint,
          operationToken,
          payload: {
            schemaFingerprint,
            preflightReady: preflightResult
          },
          featureFlags: { importApply: true },
          onProgress
        }).promise;
      } else {
        result = preflightResult;
      }
    } else {
      const job = dispatchPositionImportPreflight({
        engine: 'streaming',
        command: POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
        files: options.files,
        userDataDir,
        sideDbPath,
        featureFlags: options.apply
          ? {
              preflightOnly: false,
              streamingSourceTypes
            }
          : undefined,
        authorizeApply: options.apply
          ? (ready) => ({
              operationToken,
              archiveManifestHash: ready.archiveManifestHash,
              schemaFingerprint,
              baseCheckpoint: initialCheckpoint
            })
          : undefined,
        onProgress
      });
      result = await job.promise;
      preflightResult = result.preflightReady || result;
    }

    workerPeakRssBytes = Math.max(
      workerPeakRssBytes,
      Number(result.resourceMetrics && result.resourceMetrics.workerPeakRssBytes || 0),
      Number(
        preflightResult.resourceMetrics
        && preflightResult.resourceMetrics.workerPeakRssBytes
        || 0
      )
    );
    workerPeakHeapUsedBytes = Math.max(
      workerPeakHeapUsedBytes,
      Number(
        result.resourceMetrics
        && result.resourceMetrics.workerPeakHeapUsedBytes
        || 0
      ),
      Number(
        preflightResult.resourceMetrics
        && preflightResult.resourceMetrics.workerPeakHeapUsedBytes
        || 0
      )
    );
    peakRunDataBytes = Math.max(
      peakRunDataBytes,
      directorySize(path.join(userDataDir, 'run-data', 'position-reconciliation'))
    );
    const finalCheckpoint = options.apply
      ? (result.nextCheckpoint || result.checkpoint)
      : null;
    const summaryTimings = options.apply
      ? measureStoreSummaries(userDataDir, finalCheckpoint)
      : null;
    const endMemory = process.memoryUsage();
    mainPeakRssBytes = Math.max(mainPeakRssBytes, endMemory.rss);
    mainPeakHeapUsedBytes = Math.max(
      mainPeakHeapUsedBytes,
      endMemory.heapUsed
    );
    const orderedResults = Array.isArray(preflightResult.orderedFileResults)
      ? preflightResult.orderedFileResults
      : [];
    const inputFiles = [];
    for (const filePath of options.files) {
      inputFiles.push(await fileZipEvidence(filePath));
    }
    const evidence = {
      status: 'success',
      generatedAt,
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpuModel: os.cpus()[0] ? os.cpus()[0].model : '',
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      versions: {
        node: process.version,
        electron: process.versions.electron || null,
        v8: process.versions.v8
      },
      kind: options.kind,
      apply: options.apply,
      elapsedMs: monotonicNowMs() - startedAt,
      files: inputFiles,
      results: orderedResults.map((item) => ({
        fileName: item.fileName,
        status: item.status,
        sourceType: item.sourceType,
        rowCount: item.rowCount,
        collapsedDuplicateCount: item.collapsedDuplicateCount,
        sharedStringsMode: item.sharedStringsMode,
        code: item.code,
        message: item.message,
        detailLines: item.detailLines
      })),
      resourceMetrics: {
        mainBaselineRssBytes: baselineMemory.rss,
        mainPeakRssBytes,
        mainEndRssBytes: endMemory.rss,
        mainRssDeltaBytes: mainPeakRssBytes - baselineMemory.rss,
        mainBaselineHeapUsedBytes: baselineMemory.heapUsed,
        mainPeakHeapUsedBytes,
        mainEndHeapUsedBytes: endMemory.heapUsed,
        workerPeakRssBytes,
        workerPeakHeapUsedBytes,
        peakRunDataBytes,
        ledgerSizeBytes: Number(
          preflightResult.ledgerEvidence
          && preflightResult.ledgerEvidence.ledgerSizeBytes
          || 0
        ),
        maxProgressSilenceMs,
        maxProgressGap
      },
      databaseEvidence: options.apply
        ? databaseEvidence(sideDbPath, operationToken, options.files.length)
        : null,
      summaryTimings,
      progressSamples,
      userDataDir: options.keep ? userDataDir : undefined
    };
    writeEvidence(options.evidenceFile, evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    clearInterval(sampler);
    if (!options.keep && !options.userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: error && error.code,
    message: error && error.message,
    detailLines: error && error.detailLines
  }, null, 2)}\n`);
  process.exitCode = 1;
});
