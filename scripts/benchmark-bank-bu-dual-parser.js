// BankBU E08-B parser-only benchmark：同样两份role spool，比较1槽串行与2槽并行。
// 用法：node scripts/benchmark-bank-bu-dual-parser.js [rowsPerRole=3000] [rounds=5]

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('xlsx');

const {
  PENDING_GUANLI_HEADERS,
  BANK_HEADERS
} = require('../src/backend/bank-bu-recon-db/columns');
const {
  runBankBuParserWorker
} = require('../src/main-process/bank-bu-worker/dual-parser-dispatch');
const {
  cleanupBankBuSpool,
  cleanupBankBuSpoolParents
} = require('../src/main-process/bank-bu-worker/spool-filesystem');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const rowsPerRole = positiveInteger(process.argv[2], 3000);
const rounds = positiveInteger(process.argv[3], 5);

function row(headers, values) {
  return headers.map((header) => values[header] || '');
}

function writeWorkbook(filePath, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function createSources(root) {
  const pendingPath = path.join(root, 'pending.xlsx');
  const bankPath = path.join(root, 'bank.xlsx');
  const pendingRows = [];
  const bankRows = [];
  for (let index = 0; index < rowsPerRole; index += 1) {
    pendingRows.push(row(PENDING_GUANLI_HEADERS, {
      PendingBizId: `P-${index}`,
      主对账单号: `R-${index}`,
      财务BU: `BU-${index % 17}`,
      大账号: `ACC-${index % 31}`,
      金额: `${index + 0.01}`,
      币种: index % 2 ? 'USD' : 'CNY'
    }));
    bankRows.push(row(BANK_HEADERS, {
      BizId: `B-${index}`,
      ReconciliationId: `R-${index}`,
      'Remark-BU': `bu-${index % 17}`,
      MerchantId: `ACC-${index % 31}`,
      Currency: index % 2 ? 'USD' : 'CNY',
      'Credit Amount': `${index + 0.01}`
    }));
  }
  writeWorkbook(pendingPath, PENDING_GUANLI_HEADERS, pendingRows);
  writeWorkbook(bankPath, BANK_HEADERS, bankRows);
  return { pendingPath, bankPath };
}

function descriptors(root, sources, token) {
  const common = {
    taskStagingDir: path.join(root, `staging-${token}`),
    jobId: `bank-bu-bench-${token}`,
    operationKey: `bank-bu/import/bench-${token}`,
    producerTaskRunId: `task-bank-bu-bench-${token}`,
    yearMonth: '2026-08'
  };
  return [
    { ...common, role: 'pending', source: { filePath: sources.pendingPath } },
    { ...common, role: 'bank', source: { filePath: sources.bankPath } }
  ];
}

function cleanup(spools) {
  for (const spool of spools) {
    cleanupBankBuSpool(spool);
    cleanupBankBuSpoolParents(spool);
  }
}

async function measure(root, sources, mode, ordinal) {
  const spools = descriptors(root, sources, `${mode}-${ordinal}`);
  const start = process.hrtime.bigint();
  let results;
  try {
    if (mode === 'single') {
      results = [];
      for (const spool of spools) results.push(await runBankBuParserWorker(spool));
    } else {
      results = await Promise.all(spools.map((spool) => runBankBuParserWorker(spool)));
    }
  } finally {
    cleanup(spools);
  }
  return {
    elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
    peakRssBytes: Math.max(...results.map((result) => result.rssBytes))
  };
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bu-e08-b-benchmark-'));
  try {
    const sources = createSources(root);
    await measure(root, sources, 'single', 'warmup');
    await measure(root, sources, 'dual', 'warmup');
    const samples = { single: [], dual: [] };
    const rss = [];
    for (let index = 0; index < rounds; index += 1) {
      const order = index % 2 === 0 ? ['single', 'dual'] : ['dual', 'single'];
      for (const mode of order) {
        const sample = await measure(root, sources, mode, index);
        samples[mode].push(sample.elapsedMs);
        rss.push(sample.peakRssBytes);
      }
    }
    const singleMedianMs = median(samples.single);
    const dualMedianMs = median(samples.dual);
    const measuredImprovementRatio = (singleMedianMs - dualMedianMs) / singleMedianMs;
    const peakRssBytes = Math.max(...rss);
    const rssBudgetBytes = 800 * 1024 * 1024;
    const evidence = {
      rowsPerRole,
      rounds,
      singleMedianMs,
      dualMedianMs,
      measuredImprovementRatio,
      peakRssBytes,
      rssBudgetBytes,
      performanceGatePassed: measuredImprovementRatio >= 0.15,
      rssGatePassed: peakRssBytes <= rssBudgetBytes,
      productionEnabled: false,
      effectiveWorkerCount: 0,
      samples
    };
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
