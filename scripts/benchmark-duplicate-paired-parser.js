'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const XLSX = require('xlsx');

const { BANK_STATEMENT_FIELDS } = require('../src/constants/bank-statement-fields');
const { BILL_HEADERS } = require('../src/backend/acquiring-bill-currency-db/columns');
const {
  isPairedParserGateApproved,
  runDuplicateParserWorker
} = require('../src/main-process/duplicate-inbound-match/paired-parser-dispatch');
const {
  DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
  deriveSlotIdentity
} = require('../src/main-process/duplicate-inbound-match/spool-contract');
const {
  cleanupDuplicateSpool,
  cleanupDuplicateSpoolParents
} = require('../src/main-process/duplicate-inbound-match/spool-filesystem');
const { duplicatePolicy } = require('../src/main-process/duplicate-inbound-match/policies');

const ROW_COUNT = Number.parseInt(process.env.DUPLICATE_PAIRED_BENCH_ROWS || '1500', 10);
const ITERATIONS = Number.parseInt(process.env.DUPLICATE_PAIRED_BENCH_ITERATIONS || '5', 10);

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label}必须是正安全整数`);
}

function writeWorkbook(filePath, headers, sheetName, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), sheetName);
  XLSX.writeFile(workbook, filePath);
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function descriptor(root, jobId, filePaths) {
  return Object.freeze({
    contractVersion: DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION,
    spools: Object.freeze(filePaths.map((filePath, slotIndex) => Object.freeze({
      taskStagingDir: path.join(root, 'staging'),
      jobId,
      operationKey: `operation-${jobId}`,
      producerTaskRunId: `task-${jobId}`,
      ...deriveSlotIdentity(slotIndex),
      source: Object.freeze({ filePath })
    })))
  });
}

function cleanup(pair) {
  for (const spool of pair.spools) {
    cleanupDuplicateSpool(spool);
    cleanupDuplicateSpoolParents(spool);
  }
}

async function runOne(root, filePaths, mode, iteration) {
  const pair = descriptor(root, `${mode}-${iteration}-${Date.now()}`, filePaths);
  const startedAt = performance.now();
  try {
    const results = mode === 'paired'
      ? await Promise.all(pair.spools.map((spool) => runDuplicateParserWorker(spool)))
      : await pair.spools.reduce(async (pending, spool) => {
          const accumulated = await pending;
          accumulated.push(await runDuplicateParserWorker(spool));
          return accumulated;
        }, Promise.resolve([]));
    assert.deepEqual(results.map((result) => result.role).sort(), ['bank', 'document']);
    return Object.freeze({
      elapsedMs: performance.now() - startedAt,
      peakRssBytes: Math.max(...results.map((result) => result.rssBytes))
    });
  } finally {
    cleanup(pair);
  }
}

async function main() {
  assertPositiveInteger(ROW_COUNT, 'DUPLICATE_PAIRED_BENCH_ROWS');
  assertPositiveInteger(ITERATIONS, 'DUPLICATE_PAIRED_BENCH_ITERATIONS');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-paired-benchmark-'));
  try {
    const bankPath = path.join(root, 'bank.xlsx');
    const documentPath = path.join(root, 'document.xlsx');
    const bankRows = Array.from({ length: ROW_COUNT }, (_, index) =>
      BANK_STATEMENT_FIELDS.map((field) => {
        if (field === 'BizId') return `BENCH-BIZ-${index}`;
        if (field === 'FundType') return index % 2 === 0 ? 'Inbound' : 'Reversal';
        return '';
      }));
    const documentRows = Array.from({ length: ROW_COUNT }, (_, index) =>
      BILL_HEADERS.map((field) => {
        if (field === '业务订单号') return `BENCH-ORDER-${index}`;
        if (field === '用户编号') return `BENCH-USER-${index}`;
        if (field === '账户号') return `BENCH-ACCOUNT-${index}`;
        return '';
      }));
    writeWorkbook(bankPath, BANK_STATEMENT_FIELDS, '渠道对账单', bankRows);
    writeWorkbook(documentPath, BILL_HEADERS, '单据对账单', documentRows);
    const filePaths = [bankPath, documentPath];

    await runOne(root, filePaths, 'single', 'warmup');
    await runOne(root, filePaths, 'paired', 'warmup');
    const single = [];
    const paired = [];
    for (let index = 0; index < ITERATIONS; index += 1) {
      const order = index % 2 === 0 ? ['single', 'paired'] : ['paired', 'single'];
      for (const mode of order) {
        const result = await runOne(root, filePaths, mode, index);
        (mode === 'paired' ? paired : single).push(result);
      }
    }
    const singleMedianMs = median(single.map((result) => result.elapsedMs));
    const pairedMedianMs = median(paired.map((result) => result.elapsedMs));
    const improvementRatio = (singleMedianMs - pairedMedianMs) / singleMedianMs;
    const policy = duplicatePolicy('duplicate:import');
    const rssBudgetBytes = policy.resources.base.memoryBytes +
      policy.resources.phase.memoryBytes +
      (2 * policy.resources.compound.childResource.memoryBytes);
    const peakRssBytes = Math.max(...paired.map((result) => result.peakRssBytes));
    const gate = Object.freeze({
      enabled: true,
      measuredImprovementRatio: improvementRatio,
      peakRssBytes,
      rssBudgetBytes
    });
    const report = Object.freeze({
      schemaVersion: 1,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      rowCountPerRole: ROW_COUNT,
      iterations: ITERATIONS,
      runOrder: 'alternating-single-paired-by-iteration',
      samples: Object.freeze({
        single: Object.freeze(single.map((sample) => Object.freeze({ ...sample }))),
        paired: Object.freeze(paired.map((sample) => Object.freeze({ ...sample })))
      }),
      singleMedianMs,
      pairedMedianMs,
      improvementRatio,
      peakRssBytes,
      rssBudgetBytes,
      localGatePassed: isPairedParserGateApproved(gate),
      productionEnabled: false,
      manualGates: Object.freeze([
        'Windows native连续十轮/RSS',
        'ResourceGovernor production预算',
        '人工资金与行数守恒复核'
      ]),
      benchmarkScope: 'Parser-only；不替代Service端到端、Windows或人工门禁'
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
