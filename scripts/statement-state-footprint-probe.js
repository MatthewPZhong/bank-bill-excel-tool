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
  buildStatementProbeProjection,
  createStatementProbeLegacyGlobals
} = require('../src/main-process/statement-worker/probe-state-builder');

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

function createBaselineGraph({ rows: totalRows, batches, tokenCount }, root) {
  const seed = mappedProbeSeed(root);
  forceGc();
  const before = process.memoryUsage();
  let legacyGlobals = createStatementProbeLegacyGlobals({
    seed,
    rows: totalRows,
    batches,
    root,
    purpose: 'big-account'
  });
  const projection = buildStatementProbeProjection(legacyGlobals, {
    purpose: 'big-account',
    serviceGeneration: 1,
    sessionRevision: batches,
    tokenId: 'probe-token',
    reservationId: 'probe-reservation'
  });
  legacyGlobals = null;
  forceGc();
  const after = process.memoryUsage();
  if (projection.mainTokenHandles.length !== tokenCount) {
    throw new Error('probe projection token count does not match requested canonical sample');
  }
  let overwriteLegacyGlobals = createStatementProbeLegacyGlobals({
    seed,
    rows: 1,
    batches: 1,
    root,
    purpose: 'manual-balance',
    includeBalanceSeedConfirmation: true
  });
  const overwriteProjection = buildStatementProbeProjection(overwriteLegacyGlobals, {
    purpose: 'manual-balance',
    serviceGeneration: 1,
    sessionRevision: 1,
    tokenId: 'probe-overwrite-token',
    reservationId: 'probe-overwrite-reservation'
  });
  overwriteLegacyGlobals = null;
  return { before, after, projection, overwriteProjection };
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
    const stateFootprint = estimateStatementServiceStateFootprint(
      graph.projection.serviceState
    );
    const pendingFootprints = graph.projection.privateContexts.map((context) => (
      estimateStatementPendingInteractionFootprint(context)
    ));
    const balanceSeedOverwriteFootprint = estimateStatementPendingInteractionFootprint(
      graph.overwriteProjection.privateContexts[0]
    );
    const publicDto = createStatementPublicInteractionDto({
      token: graph.projection.mainTokenHandles[0],
      prompt: {
        status: 'select-big-account',
        message: '请选择本次使用的大账号 / 币种',
        selectionMode: 'multi-row',
        templateId: 17,
        rows: [{ index: 0, label: '1.', sourceRowNumber: 2, fileName: 'pending-source.xlsx' }],
        rowsWithEmptyBlocks: [
          { index: 0, label: '1.', sourceRowNumber: 2, fileName: 'pending-source.xlsx' }
        ],
        bigAccounts: [
          { merchantId: 'M000001', currencies: ['USD', 'EUR', 'HKD'], isMultiCurrency: true }
        ],
        expandedBigAccountOptions: [
          { merchantId: 'M000001', currency: 'USD', accountNature: 'client' }
        ],
        fixedAssignments: [{ merchantId: 'M000001', currency: 'USD', rowIndex: 0 }]
      }
    });
    const result = {
      probeVersion: 2,
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
      balanceSeedOverwriteFootprint,
      legacyInventory: graph.projection.legacyInventory,
      ownership: graph.projection.ownership,
      mainTokenHandleBytes: Buffer.byteLength(
        JSON.stringify(graph.projection.mainTokenHandles[0]),
        'utf8'
      ),
      publicDtoBytes: Buffer.byteLength(JSON.stringify(publicDto), 'utf8'),
      balanceSeedOverwritePublicDtoBytes: Buffer.byteLength(
        JSON.stringify(graph.overwriteProjection.balanceSeedOverwriteResult),
        'utf8'
      ),
      productionEnabled: false,
      caveat: 'This fixed generated graph calibrates retained state only; it is not a parser peak, Windows packaged, or real business sample approval.'
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
