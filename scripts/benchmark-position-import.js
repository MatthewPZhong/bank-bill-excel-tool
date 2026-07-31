'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  POSITION_IMPORT_COMMANDS
} = require('../src/backend/position-reconciliation-import/constants');
const {
  dispatchPositionImportPreflight
} = require('../src/main-process/position-reconciliation/import-dispatch');

function parseArgs(values) {
  const options = {
    kind: 'source',
    keep: false,
    userDataDir: '',
    files: []
  };
  for (const value of values) {
    if (value === '--keep') options.keep = true;
    else if (value.startsWith('--kind=')) options.kind = value.slice('--kind='.length);
    else if (value.startsWith('--user-data=')) {
      options.userDataDir = path.resolve(value.slice('--user-data='.length));
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
  let mainPeakRssBytes = process.memoryUsage().rss;
  let mainPeakHeapUsedBytes = process.memoryUsage().heapUsed;
  let peakRunDataBytes = 0;
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

  try {
    const job = dispatchPositionImportPreflight({
      engine: 'streaming',
      command: options.kind === 'bank'
        ? POSITION_IMPORT_COMMANDS.BANK_PREPARE
        : POSITION_IMPORT_COMMANDS.SOURCE_PREPARE_AND_APPLY,
      files: options.files,
      userDataDir,
      onProgress(event) {
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
    const evidence = {
      status: 'success',
      generatedAt,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      kind: options.kind,
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
      progressSamples,
      userDataDir: options.keep ? userDataDir : undefined
    };
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
