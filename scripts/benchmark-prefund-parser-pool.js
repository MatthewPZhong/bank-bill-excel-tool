'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const os = require('node:os');
const path = require('node:path');

const {
  createBackgroundExecutionRuntime
} = require('../src/main-process/background-execution/runtime');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  executeManagedPreFundMptImport
} = require('../src/main-process/pre-fund-reconciliation/mpt-import/managed-import');
const runDataStore = require('../src/backend/run-data-store');

const DEFAULT_RUNS = 5;
const DEFAULT_REPRESENTATIVE_ROWS_PER_FILE = 1200;
const DEFAULT_SMALL_ROWS_PER_FILE = 80;
const FILE_COUNT = 8;

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name}必须是正安全整数`);
  return parsed;
}

function parseArgs(argv) {
  const values = {
    runs: DEFAULT_RUNS,
    representativeRowsPerFile: DEFAULT_REPRESENTATIVE_ROWS_PER_FILE,
    smallRowsPerFile: DEFAULT_SMALL_ROWS_PER_FILE,
    outputDir: path.resolve(__dirname, '../changes/background-execution-e05-c-prefund-parser-pool')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--runs') values.runs = parsePositiveInteger(value, 'runs');
    else if (key === '--representative-rows') {
      values.representativeRowsPerFile = parsePositiveInteger(value, 'representative rows');
    } else if (key === '--small-rows') {
      values.smallRowsPerFile = parsePositiveInteger(value, 'small rows');
    } else if (key === '--output-dir') values.outputDir = path.resolve(value);
    else throw new TypeError(`未知参数：${key}`);
    index += 1;
  }
  return Object.freeze(values);
}

function rowValues(overrides) {
  const values = {
    billDate: '2026-07-08', channel: 'CITI', entity: 'PPEU', merchantId: 'M-BENCH',
    business: 'MPT', oppBu: 'SMB', tradeType: 'Inbound-VA', currency: 'USD',
    originAmount: '1.25', fee: '0', amount: '1.25', payerName: 'payer',
    payerAccount: 'account', valueDate: '2026-07-08', bookDate: '2026-07-08',
    created: '2026-07-08 01:02:03', businessDate: '2026-07-08', tradeScope: 'INBOUND',
    realChannel: 'CITI-REAL', clearingNetwork: 'SWIFT', ...overrides
  };
  return INBOUND_FIELDS.map((field) => values[field] || '');
}

function buildFixture(root, label, rowsPerFile) {
  const sourceDir = path.join(root, `sources-${label}`);
  fs.mkdirSync(sourceDir, { recursive: true });
  return Array.from({ length: FILE_COUNT }, (_, fileIndex) => {
    const sequence = String(2000 + fileIndex);
    const sourceBatch = `MPT_INBOUND_20260708_BENCH_${label}_${fileIndex}`;
    const rows = Array.from({ length: rowsPerFile }, (_, rowIndex) => rowValues({
      batchNo: sourceBatch,
      fileId: `FILE-${label}-${fileIndex}-${rowIndex}`,
      txId: `TX-${label}-${fileIndex}-${rowIndex}`,
      orderId: `ORDER-${label}-${fileIndex}-${rowIndex}`,
      reconId: `RECON-${label}-${fileIndex}-${rowIndex}`,
      billReconId: `BILL-${label}-${fileIndex}-${rowIndex}`,
      batchSeq: sequence,
      currency: rowIndex % 2 ? 'EUR' : 'USD',
      amount: `${rowIndex + 1}.25`,
      originAmount: `${rowIndex + 1}.25`
    }));
    const filePath = path.join(sourceDir, `MPT_INBOUND_GATEWAY_20260708_${sequence}.txt`);
    const header = ['20260708', sourceBatch, String(rows.length)];
    fs.writeFileSync(
      filePath,
      `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
      'utf8'
    );
    return filePath;
  });
}

function directoryBytes(root) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_error) { return 0; }
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(entryPath);
    else if (entry.isFile()) {
      try { total += fs.statSync(entryPath).size; } catch (_error) { /* concurrent cleanup */ }
    }
  }
  return total;
}

function digestBusinessRows(userDataDir) {
  const db = runDataStore.openExistingSideDb(runDataStore.sideDbPath(
    userDataDir, runDataStore.MODULE_PRE_FUND_RECONCILIATION, '2026-07'
  ));
  try {
    const rows = db.prepare(`
      SELECT source_batch, source_file_name, source_file_sequence, source_row_number,
        reconciliation_id, gateway_date, currency, amount, fingerprint
      FROM pre_fund_reconciliation_gateway_rows
      ORDER BY source_file_sequence, source_row_number
    `).all();
    const receipts = db.prepare(`
      SELECT file_index, outcome_kind FROM pre_fund_operation_receipts ORDER BY file_index
    `).all();
    return Object.freeze({
      rowCount: rows.length,
      receiptCount: receipts.length,
      sha256: crypto.createHash('sha256').update(JSON.stringify({ rows, receipts })).digest('hex')
    });
  } finally {
    db.close();
  }
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runOnce({ root, filePaths, label, mode, runIndex, orderPosition }) {
  const runRoot = path.join(root, `${label}-${mode}-${runIndex}`);
  const userDataDir = path.join(runRoot, 'user-data');
  const taskStagingDir = path.join(runRoot, 'staging');
  fs.mkdirSync(userDataDir, { recursive: true });
  const parserWorkerCount = mode === 'pool' ? 4 : 1;
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: parserWorkerCount === 4 ? 8 : 2,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    workerDurableCoordinator: {
      async prepareAndAck(input) {
        return { intentId: `bench-intent-${input.unitId}`, fileOperationKey: input.critical.fileOperationKey };
      },
      async observeReceipt(input) {
        return { receiptHint: { receiptKind: 'module-local', receiptIdentity: String(input.receipt.id) } };
      },
      async settleCommitted() {},
      async resolveUncertain() { return { outcome: 'not-committed' }; }
    }
  });
  const rssStartBytes = process.memoryUsage().rss;
  let peakRssBytes = rssStartBytes;
  let peakSpoolBytes = 0;
  let parserActive = 0;
  let maxParserActive = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    peakSpoolBytes = Math.max(peakSpoolBytes, directoryBytes(taskStagingDir));
  }, 10);
  const startedAt = performance.now();
  try {
    const operationKey = `benchmark-${label}-${mode}-${runIndex}`;
    const result = await executeManagedPreFundMptImport({
      actionKey: 'pre-fund:mpt-import',
      runtime,
      service: { beginManagedMptImport() {}, adoptManagedMptImportResults: (_paths, items) => items },
      filePaths,
      userDataDir,
      taskStagingDir,
      getAvailableDiskBytes: () => Number.MAX_SAFE_INTEGER,
      onParserWorkerState(event) {
        if (event.state === 'started') {
          parserActive += 1;
          maxParserActive = Math.max(maxParserActive, parserActive);
        } else parserActive -= 1;
      },
      batchContext: {
        batchId: runIndex + 1,
        batchNumber: `BENCH-${label}-${mode}-${runIndex}`,
        taskRunId: `bench-task-${label}-${mode}-${runIndex}`,
        taskKey: 'pre-fund-reconciliation:import-mpt',
        moduleId: 'pre-fund',
        parentRunId: `bench-parent-${label}-${mode}-${runIndex}`,
        operationKey
      }
    });
    const durationMs = performance.now() - startedAt;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    peakSpoolBytes = Math.max(peakSpoolBytes, directoryBytes(taskStagingDir));
    const business = digestBusinessRows(userDataDir);
    if (result.successCount !== FILE_COUNT || business.receiptCount !== FILE_COUNT) {
      throw Object.assign(new Error('benchmark业务或receipt结果不完整'), {
        code: 'PREFUND_BENCHMARK_RESULT_INCOMPLETE'
      });
    }
    if (parserActive !== 0) {
      throw Object.assign(new Error('benchmark Parser未clean exit'), {
        code: 'PREFUND_BENCHMARK_PARSER_NOT_EXITED'
      });
    }
    return Object.freeze({
      runIndex,
      orderPosition,
      durationMs: Number(durationMs.toFixed(3)),
      rssStartBytes,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - rssStartBytes),
      peakSpoolBytes,
      eventLoopMeanMs: Number((eventLoop.mean / 1e6).toFixed(3)),
      eventLoopP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(3)),
      maxParserActive,
      business
    });
  } finally {
    clearInterval(sampler);
    eventLoop.disable();
    await runtime.shutdown();
  }
}

function summarize(runs) {
  const businessDigests = new Set(runs.map((run) => run.business.sha256));
  return Object.freeze({
    durationMedianMs: median(runs.map((run) => run.durationMs)),
    rssStartMedianBytes: median(runs.map((run) => run.rssStartBytes)),
    peakRssAbsoluteMedianBytes: median(runs.map((run) => run.peakRssBytes)),
    peakRssDeltaMedianBytes: median(runs.map((run) => run.peakRssDeltaBytes)),
    peakSpoolMedianBytes: median(runs.map((run) => run.peakSpoolBytes)),
    eventLoopMeanMedianMs: median(runs.map((run) => run.eventLoopMeanMs)),
    eventLoopP99MedianMs: median(runs.map((run) => run.eventLoopP99Ms)),
    businessParityWithinMode: businessDigests.size === 1,
    businessSha256: runs[0].business.sha256
  });
}

async function runCase(root, label, filePaths, runCount) {
  const single = [];
  const pool = [];
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const modes = runIndex % 2 === 0 ? ['single', 'pool'] : ['pool', 'single'];
    for (let orderIndex = 0; orderIndex < modes.length; orderIndex += 1) {
      const mode = modes[orderIndex];
      const sample = await runOnce({
        root, filePaths, label, mode, runIndex, orderPosition: orderIndex + 1
      });
      if (mode === 'single') single.push(sample);
      else pool.push(sample);
    }
  }
  const singleSummary = summarize(single);
  const poolSummary = summarize(pool);
  return Object.freeze({
    single: Object.freeze(single),
    pool: Object.freeze(pool),
    summary: Object.freeze({
      single: singleSummary,
      pool: poolSummary,
      improvementPercent: Number((
        (singleSummary.durationMedianMs - poolSummary.durationMedianMs) /
        singleSummary.durationMedianMs * 100
      ).toFixed(2)),
      businessParity: singleSummary.businessParityWithinMode &&
        poolSummary.businessParityWithinMode &&
        singleSummary.businessSha256 === poolSummary.businessSha256
    })
  });
}

function markdown(report) {
  const rep = report.cases.representative.summary;
  const small = report.cases.small.summary;
  return `# E05-C PreFund Parser Pool Benchmark\n\n` +
    `- Runs: ${report.config.runs} per mode/case\n` +
    `- Representative: ${FILE_COUNT} files × ${report.config.representativeRowsPerFile} rows\n` +
    `- Small: ${FILE_COUNT} files × ${report.config.smallRowsPerFile} rows\n` +
    `- Scope: real managed import, OS Parser Workers, Single Writer, Side DB receipts\n` +
    `- Run order: alternating single/pool by run index to reduce warm-cache ordering bias\n` +
    `- RSS: same-process absolute peak plus per-sample delta from starting RSS\n\n` +
    `| Case | Single median ms | Pool median ms | Improvement | Single RSS abs/delta | Pool RSS abs/delta | Single/pool spool | Single/pool event-loop p99 | Parity |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n` +
    `| representative | ${rep.single.durationMedianMs} | ${rep.pool.durationMedianMs} | ${rep.improvementPercent}% | ${rep.single.peakRssAbsoluteMedianBytes}/${rep.single.peakRssDeltaMedianBytes} | ${rep.pool.peakRssAbsoluteMedianBytes}/${rep.pool.peakRssDeltaMedianBytes} | ${rep.single.peakSpoolMedianBytes}/${rep.pool.peakSpoolMedianBytes} | ${rep.single.eventLoopP99MedianMs}/${rep.pool.eventLoopP99MedianMs} | ${rep.businessParity} |\n` +
    `| small | ${small.single.durationMedianMs} | ${small.pool.durationMedianMs} | ${small.improvementPercent}% | ${small.single.peakRssAbsoluteMedianBytes}/${small.single.peakRssDeltaMedianBytes} | ${small.pool.peakRssAbsoluteMedianBytes}/${small.pool.peakRssDeltaMedianBytes} | ${small.single.peakSpoolMedianBytes}/${small.pool.peakSpoolMedianBytes} | ${small.single.eventLoopP99MedianMs}/${small.pool.eventLoopP99MedianMs} | ${small.businessParity} |\n\n` +
    `## Gate conclusion\n\n` +
    `**${report.gate.conclusion}**. ${report.gate.reasons.join('；')}。\n\n` +
    `RSS、磁盘与event-loop在本机仅记录，尚无冻结阈值/Windows packaged证据，均为not qualified。` +
    `此报告不会修改 production policy；真实脱敏资金与恢复人工复核仍未完成。\n`;
}

async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (!fs.statSync(config.outputDir).isDirectory()) throw new Error('outputDir必须已存在');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefund-pool-benchmark-'));
  try {
    const representativeFiles = buildFixture(root, 'representative', config.representativeRowsPerFile);
    const smallFiles = buildFixture(root, 'small', config.smallRowsPerFile);
    const representative = await runCase(root, 'representative', representativeFiles, config.runs);
    const small = await runCase(root, 'small', smallFiles, config.runs);
    const smallRegressionPercent = -small.summary.improvementPercent;
    const reasons = [];
    if (!representative.summary.businessParity || !small.summary.businessParity) reasons.push('业务摘要不一致');
    if (representative.summary.improvementPercent < 15) reasons.push('代表集中位数改善未达15%');
    if (smallRegressionPercent > 5) reasons.push('small回退超过5%');
    reasons.push('RSS仅记录，尚未qualified');
    reasons.push('磁盘仅记录，尚未qualified');
    reasons.push('event-loop仅记录，尚未qualified');
    reasons.push('Windows packaged门禁未完成');
    reasons.push('真实资金与恢复人工门禁未完成');
    const report = Object.freeze({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: Object.freeze({
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
        availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : 1,
        totalMemoryBytes: os.totalmem()
      }),
      config: Object.freeze({
        runs: config.runs,
        representativeRowsPerFile: config.representativeRowsPerFile,
        smallRowsPerFile: config.smallRowsPerFile,
        fileCount: FILE_COUNT,
        runOrder: 'alternating-single-pool-by-run-index'
      }),
      cases: Object.freeze({ representative, small }),
      gate: Object.freeze({
        productionEligible: false,
        conclusion: 'DOWNGRADE / KEEP PRODUCTION DISABLED',
        checks: Object.freeze({
          representativePerformance: Object.freeze({
            qualified: representative.summary.improvementPercent >= 15,
            threshold: 'median improvement >= 15%',
            observedPercent: representative.summary.improvementPercent
          }),
          smallRegression: Object.freeze({
            qualified: smallRegressionPercent <= 5,
            threshold: 'median regression <= 5%',
            observedPercent: Number(smallRegressionPercent.toFixed(2))
          }),
          rss: Object.freeze({ qualified: false, status: 'recorded-local-only' }),
          disk: Object.freeze({ qualified: false, status: 'recorded-local-only' }),
          eventLoop: Object.freeze({ qualified: false, status: 'recorded-local-only' }),
          windowsPackaged: Object.freeze({ qualified: false, status: 'not-run' }),
          fundsManualReview: Object.freeze({ qualified: false, status: 'not-run' })
        }),
        reasons: Object.freeze(reasons)
      })
    });
    fs.writeFileSync(path.join(config.outputDir, 'benchmark-evidence.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(config.outputDir, 'benchmark-evidence.md'), markdown(report));
    process.stdout.write(`${JSON.stringify({
      representative: representative.summary,
      small: small.summary,
      gate: report.gate
    })}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`PREFUND_POOL_BENCHMARK_ERROR=${error.code || error.name}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, runCase };
