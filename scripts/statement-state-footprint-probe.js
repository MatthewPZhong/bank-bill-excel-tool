#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  buildMappedRows
} = require('../src/backend/file-service');
const {
  STATEMENT_RESOURCE_CONTRACT,
  createStatementPublicInteractionDto
} = require('../src/main-process/statement-worker/contracts');
const {
  estimateStatementPendingInteractionFootprint,
  estimateStatementServiceStateFootprint
} = require('../src/main-process/statement-worker/state-footprint');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession
} = require('../src/main-process/statement-session');

function positiveArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`--${name} must be a positive safe integer`);
  }
  return value;
}

function forceGc() {
  if (typeof global.gc !== 'function') {
    throw new Error('statement footprint probe requires node --expose-gc');
  }
  for (let index = 0; index < 3; index += 1) global.gc();
}

function writeProbeWorkbook(root) {
  const sourcePath = path.join(root, 'statement-probe-source.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
    ['2026-08-01', 'M000001', 'USD', '100.01', '']
  ]), 'Sheet1');
  XLSX.writeFile(workbook, sourcePath);
  return sourcePath;
}

function mappedProbeSeed(root) {
  return buildMappedRows({
    inputFilePath: writeProbeWorkbook(root),
    orderedTargetFields: [
      'BillDate',
      'MerchantId',
      'Currency',
      'Credit Amount',
      'Debit Amount'
    ],
    mappingByField: {
      BillDate: 'Date',
      MerchantId: 'Account',
      Currency: 'Curr',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit'
    }
  });
}

function expandMappedRows(seed, count, offset) {
  const rows = [seed[0].slice()];
  rows.rowMetas = [];
  rows.issues = [];
  rows.headerBreaks = [];
  for (let index = 0; index < count; index += 1) {
    const ordinal = offset + index;
    const row = seed[1].slice();
    row[0] = `2026-08-${String(ordinal % 28 + 1).padStart(2, '0')}`;
    row[1] = `M${String(ordinal % 5000).padStart(6, '0')}`;
    row[2] = ordinal % 3 === 0 ? 'USD' : ordinal % 3 === 1 ? 'EUR' : 'HKD';
    row[3] = ordinal % 2 === 0 ? `${ordinal + 100}.01` : '';
    row[4] = ordinal % 2 === 0 ? '' : `${ordinal + 50}.02`;
    rows.push(row);
    rows.rowMetas.push({ sourceRowNumber: index + 2 });
  }
  return rows;
}

function createBaselineGraph({ rows: totalRows, batches, tokenCount }, root) {
  const seed = mappedProbeSeed(root);
  forceGc();
  const before = process.memoryUsage();
  const session = createStatementImportSession({
    templateId: 17,
    templateName: 'E09ProbeBank-上海'
  });
  const generatedExports = {
    statementSessionKey: session.key,
    allDetail: null,
    allBalance: null
  };
  let nextEntry = 0;
  let nextBatch = 0;
  let assigned = 0;
  for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
    const remaining = totalRows - assigned;
    const count = batchIndex === batches - 1
      ? remaining
      : Math.floor(totalRows / batches);
    const detailRows = expandMappedRows(seed, count, assigned);
    const fileEntry = buildStatementFileEntry({
      buildEntryId: () => `entry-${++nextEntry}`,
      filePath: path.join(root, `source-${batchIndex + 1}.xlsx`),
      detailRows
    });
    appendStatementSessionImport({
      buildBatchId: () => `batch-${++nextBatch}`,
      lastGeneratedExports: generatedExports,
      session,
      fileEntries: [fileEntry]
    });
    assigned += count;
  }

  const state = {
    serviceGeneration: 1,
    sessionRevision: batches,
    sessions: new Map([[session.key, session]]),
    tokens: new Map(),
    stableSummary: {
      sessionCount: 1,
      batchCount: session.batches.length,
      fileCount: session.fileEntries.length,
      rowCount: totalRows
    },
    activeJobId: null,
    persistentReservation: null,
    pendingInteractionReservations: new Map()
  };

  const currentEntry = session.fileEntries.at(-1);
  const privateContexts = [];
  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
    privateContexts.push({
      purpose: 'big-account',
      serviceGeneration: 1,
      sessionKey: session.key,
      sessionRevision: batches,
      allowedChoices: [
        { merchantId: 'M000001', currencies: ['USD', 'EUR', 'HKD'] }
      ],
      fileEntries: [{
        id: currentEntry.id,
        matchedTemplateId: currentEntry.matchedTemplateId,
        detailRows: cloneRowsWithMetadata(currentEntry.detailRows)
      }]
    });
  }
  forceGc();
  const after = process.memoryUsage();
  return { before, after, privateContexts, state };
}

function main() {
  const inputs = Object.freeze({
    rows: positiveArg('rows', 50000),
    batches: positiveArg('batches', 4),
    tokenCount: positiveArg('tokens', 1)
  });
  if (inputs.tokenCount > STATEMENT_RESOURCE_CONTRACT.tokenMaxOutstanding) {
    throw new Error('probe token count exceeds canonical tokenMaxOutstanding');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-footprint-probe-'));
  try {
    const graph = createBaselineGraph(inputs, root);
    const stateFootprint = estimateStatementServiceStateFootprint(graph.state);
    const pendingFootprints = graph.privateContexts.map((context) => (
      estimateStatementPendingInteractionFootprint(context)
    ));
    const publicDto = createStatementPublicInteractionDto({
      token: {
        tokenId: 'probe-token',
        purpose: 'big-account',
        serviceGeneration: 1,
        sessionKey: '17',
        sessionRevision: inputs.batches,
        expiresAt: Date.UTC(2026, 7, 27, 15, 0, 0),
        allowedChoiceDigest: 'a'.repeat(64),
        reservationId: 'probe-reservation'
      },
      prompt: {
        status: 'select-big-account',
        rowCount: inputs.rows,
        choices: [{ merchantId: 'M000001', currencies: ['USD', 'EUR', 'HKD'] }]
      }
    });
    const result = {
      probeVersion: 1,
      sampleClass: 'generated-production-shape-not-business-representative',
      inputs,
      measured: {
        heapUsedBeforeBytes: graph.before.heapUsed,
        heapUsedAfterBytes: graph.after.heapUsed,
        heapUsedDeltaBytes: Math.max(0, graph.after.heapUsed - graph.before.heapUsed),
        rssBeforeBytes: graph.before.rss,
        rssAfterBytes: graph.after.rss,
        rssDeltaBytes: Math.max(0, graph.after.rss - graph.before.rss)
      },
      stateFootprint,
      pendingFootprints,
      publicDtoBytes: Buffer.byteLength(JSON.stringify(publicDto), 'utf8'),
      productionEnabled: false,
      caveat: 'This fixed generated graph calibrates retained state only; it is not a parser peak, Windows packaged, or real business sample approval.'
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
