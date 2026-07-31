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
  dispatchPositionImportPreflight,
  dispatchPositionLargeImportSchemaMigration
} = require('../src/main-process/position-reconciliation/import-dispatch');
const {
  createPositionReconciliationStore
} = require('../src/main-process/position-reconciliation/store');
const {
  readPositionDatabaseCheckpoint
} = require('../src/main-process/position-reconciliation/side-db-mutation');

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
    }
    else if (value.startsWith('--user-data=')) {
      options.userDataDir = path.resolve(value.slice('--user-data='.length));
    } else if (value.startsWith('--streaming-source-types=')) {
      options.streamingSourceTypes = value.slice('--streaming-source-types='.length);
    } else options.files.push(path.resolve(value));
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
  const startedAt = Date.now();
  let sideDbPath = '';
  let initialCheckpoint = null;
  let schemaFingerprint = '';
  let operationToken = '';
  const streamingSourceTypes = [...normalizePositionStreamingSourceTypes(
    options.streamingSourceTypes,
    { engine: 'streaming' }
  )];
  if (options.apply) {
    if (options.kind !== 'source') {
      throw new Error('--apply 当前只支持普通链接原始表');
    }
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
  let mainPeakRssBytes = process.memoryUsage().rss;
  let mainPeakHeapUsedBytes = process.memoryUsage().heapUsed;
  let peakRunDataBytes = 0;
  const progressSamples = [];
  let lastProgressAt = 0;
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

  try {
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: options.kind === 'bank'
        ? POSITION_IMPORT_COMMANDS.BANK_PREPARE
        : POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
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
      onProgress(event) {
        const now = Date.now();
        if (options.progress
            && (now - lastProgressAt >= 5000 || event.stage === 'committed')) {
          lastProgressAt = now;
          process.stderr.write(`${JSON.stringify({
            stage: event.stage,
            currentFile: event.currentFile,
            totalFiles: event.totalFiles,
            fileName: event.fileName,
            scannedRows: event.scannedRows,
            acceptedRows: event.acceptedRows,
            committedRows: event.committedRows,
            workerRssBytes: event.workerRssBytes,
            elapsedMs: event.elapsedMs
          })}\n`);
        }
        if (progressSamples.length >= 200) return;
        progressSamples.push({
          stage: event.stage,
          currentFile: event.currentFile,
          scannedRows: event.scannedRows,
          acceptedRows: event.acceptedRows,
          workerRssBytes: event.workerRssBytes,
          elapsedMs: event.elapsedMs
        });
      }
    });
    const result = await job.promise;
    peakRunDataBytes = Math.max(
      peakRunDataBytes,
      directorySize(path.join(userDataDir, 'run-data', 'position-reconciliation'))
    );
    let databaseEvidence = null;
    if (options.apply) {
      const db = new DatabaseSync(sideDbPath, { readOnly: true });
      try {
        databaseEvidence = {
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
          checkpoint: readPositionDatabaseCheckpoint(db),
          quickCheck: db.prepare('PRAGMA quick_check').all().map((row) => row.quick_check)
        };
      } finally {
        db.close();
      }
    }
    const evidence = {
      status: 'success',
      generatedAt,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      kind: options.kind,
      apply: options.apply,
      elapsedMs: Date.now() - startedAt,
      files: options.files.map((filePath) => ({
        fileName: path.basename(filePath),
        sizeBytes: fs.statSync(filePath).size
      })),
      results: result.orderedFileResults.map((item) => ({
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
        mainPeakRssBytes,
        mainPeakHeapUsedBytes,
        workerPeakRssBytes: result.resourceMetrics.workerPeakRssBytes,
        workerPeakHeapUsedBytes: result.resourceMetrics.workerPeakHeapUsedBytes,
        peakRunDataBytes,
        ledgerSizeBytes: result.ledgerEvidence.ledgerSizeBytes
      },
      databaseEvidence,
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
