'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const {
  ensureVccFinancialOpTablesSupport
} = require('../../../src/backend/vcc-financial-op-db/migrations');
const {
  REQUIRED_DATASET_TYPES
} = require('../../../src/backend/vcc-financial-op/calculator');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES
} = require('../../../src/backend/vcc-financial-op/definitions');
const {
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  canonicalSha256
} = require('../../../src/main-process/background-execution/canonical-json-v1');
const {
  readVccExportSnapshot
} = require('../../../src/main-process/vcc-financial-op-output/authority');
const {
  canonicalFilePlan,
  cleanupGenerationArtifacts,
  createGenerationInput,
  generateValidateAndPublishVccExport
} = require('../../../src/main-process/vcc-financial-op-output/dispatch');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_POLICY,
  validateVccExportSingleResult,
  validateVccExportSubjectsResult
} = require('../../../src/main-process/vcc-financial-op-output/policies');
const {
  executeVccExportWriter
} = require('../../../src/main-process/vcc-financial-op-output/writer-core');
const {
  assertTaskStagingIdentity,
  createTaskStagingIdentity
} = require('../../../src/main-process/vcc-financial-op-output/staging-identity');
const {
  toProtocolError
} = require('../../../src/main-process/background-execution/error-codec');
const {
  pendingSheetProjection
} = require('../../../src/main-process/vcc-financial-op-output/artifact-evidence');
const {
  PENDING_SHEET_NAME,
  writeRunWorkbooks
} = require('../../../src/main-process/vcc-financial-op-writer');
const {
  assertXlsxOutputPath
} = require('../../../src/main-process/vcc-financial-op-output-publication');

const ASSETS_DIR = path.resolve(__dirname, '../../../assets');

function identityDigestEvidence(digest) {
  return `sha256:${digest.match(/.{8}/g).join(':')}`;
}

test('staging identity 摘要即使全为数字也保留 finance-safe 审计证据', () => {
  const digitOnlyDigest = '12345678'.repeat(8);
  let caught = null;
  try {
    assertTaskStagingIdentity({
      identity: { identityDigest: digitOnlyDigest },
      generationPaths: [],
      stage: 'fixture-digest-redaction'
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  const protocolError = toProtocolError(caught);
  assert.deepEqual(protocolError.detailLines, [
    `taskRootIdentityDigest=${identityDigestEvidence(digitOnlyDigest)}`,
    'identityCauseCode=UNKNOWN'
  ]);
});

function seedArchivedRun(db, subjects) {
  const targetMonth = '2026-06';
  const archivedAt = '2026-08-01 09:00:00';
  const revisions = Object.fromEntries(REQUIRED_DATASET_TYPES.map((type) => [type, 1]));
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (
      target_month, status, input_revisions_json, input_fingerprint,
      created_at, updated_at, archived_at
    ) VALUES (?, 'archived', ?, ?, '2026-08-01 08:00:00', ?, ?)
  `).run(targetMonth, JSON.stringify(revisions), 'a'.repeat(64), archivedAt, archivedAt).lastInsertRowid);
  const insertRow = db.prepare(`
    INSERT INTO vcc_fin_op_run_rows (
      run_id, subject, row_kind, source_type,
      category_major, category_minor, currency, amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBalance = db.prepare(`
    INSERT INTO vcc_fin_op_run_balances (
      run_id, subject, currency, opening_balance, period_amount,
      calculated_balance, system_balance, difference
    ) VALUES (?, ?, ?, '100', ?, ?, ?, '0')
  `);
  for (const subject of subjects) {
    insertRow.run(
      runId,
      subject,
      'movement',
      SOURCE_TYPES.RECHARGE,
      'VCC_discharge',
      'B2B',
      'USD',
      '10'
    );
    insertRow.run(
      runId,
      subject,
      'pending',
      SOURCE_TYPES.PENDING,
      '当月移除pending',
      '',
      'EUR',
      '3'
    );
    const archivedBalances = {};
    for (const currency of SUPPORTED_CURRENCIES) {
      const periodAmount = currency === 'USD' ? '10' : (currency === 'EUR' ? '3' : '0');
      const calculatedBalance = currency === 'USD' ? '110' : (currency === 'EUR' ? '103' : '100');
      insertBalance.run(
        runId,
        subject,
        currency,
        periodAmount,
        calculatedBalance,
        calculatedBalance
      );
      archivedBalances[currency] = calculatedBalance;
    }
    db.prepare(`
      INSERT INTO vcc_fin_op_pending_summary_rows (
        run_id, subject, channel_name, currency_mismatch,
        flow_currency, pending_currency, recon_type, flow_amount, pending_amount
      ) VALUES (?, ?, 'CITI', 1, 'USD', 'EUR', 'VCC_clearing_credit', '10', '3')
    `).run(runId, subject);
    db.prepare(`
      INSERT INTO vcc_fin_op_pending_currency_totals (run_id, subject, currency, amount)
      VALUES (?, ?, 'EUR', '3')
    `).run(runId, subject);
    db.prepare(`
      INSERT INTO vcc_fin_op_archives (
        target_month, subject, balances_json, run_id, archived_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(targetMonth, subject, JSON.stringify(archivedBalances), runId, archivedAt);
  }
  const insertDataset = db.prepare(`
    INSERT INTO vcc_fin_op_datasets (
      target_month, dataset_type, data_status, archived_run_id,
      revision, generated_at, updated_at
    ) VALUES (?, ?, 'archived', ?, 1, '2026-08-01 08:00:00', ?)
  `);
  for (const datasetType of REQUIRED_DATASET_TYPES) {
    insertDataset.run(targetMonth, datasetType, runId, archivedAt);
  }
  return { runId, targetMonth };
}

function setup(t, subjects = ['PPAU', 'PPHK']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-e12-a-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
  ensureVccFinancialOpTablesSupport(db);
  const run = seedArchivedRun(db, subjects);
  const snapshot = readVccExportSnapshot(db, run);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 8,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    vccFinancialOpDatabasePath: dbPath,
    vccFinancialOpAssetsDir: ASSETS_DIR,
    shutdownTimeoutMs: 10000
  });
  t.after(async () => {
    await runtime.shutdown({ timeoutMs: 10000 });
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath, db, run, snapshot, runtime };
}

function batchContext(suffix) {
  return Object.freeze({
    batchId: suffix === 'single' ? 71 : 72,
    batchNumber: `2026-08-28-${suffix}`,
    taskRunId: `vcc-task-${suffix}`,
    taskKey: 'vccFinancialOp:export:result',
    moduleId: 'vcc-financial-op',
    parentRunId: `vcc-parent-${suffix}`,
    operationKey: `vcc-operation-${suffix}`
  });
}

function filePlan(root, count, suffix) {
  const outputRoot = path.join(root, `targets-${suffix}`);
  fs.mkdirSync(outputRoot);
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: Array.from({ length: count }, (_unused, index) => ({
      filePath: path.join(outputRoot, `${index}.xlsx`),
      role: 'output',
      sourceOperation: 'vccFinancialOp:export:result'
    }))
  });
}

function resultSheetProjection(sheet) {
  const rows = [];
  for (let row = 1; row <= sheet.actualRowCount; row += 1) {
    rows.push({
      height: sheet.getRow(row).height == null ? null : sheet.getRow(row).height,
      cells: Array.from({ length: sheet.actualColumnCount }, (_unused, column) => {
        const cell = sheet.getCell(row, column + 1);
        return { value: cell.value == null ? null : cell.value, style: cell.style };
      })
    });
  }
  return {
    rows,
    columns: Array.from({ length: sheet.actualColumnCount }, (_unused, index) => ({
      width: sheet.getColumn(index + 1).width,
      hidden: Boolean(sheet.getColumn(index + 1).hidden)
    })),
    merges: Object.values(sheet._merges).map((merge) => merge.range).sort(),
    views: sheet.views,
    pageSetup: sheet.pageSetup,
    autoFilter: sheet.autoFilter
  };
}

async function workbookSemanticDigest(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return canonicalSha256(JSON.parse(JSON.stringify({
    result: resultSheetProjection(workbook.worksheets[0]),
    pending: pendingSheetProjection(workbook.worksheets[1]),
    definedNames: workbook.definedNames.model
  })));
}

async function rewriteCellStyleId(filePath, cellReference) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const worksheetEntry = zip.file('xl/worksheets/sheet1.xml');
  const stylesEntry = zip.file('xl/styles.xml');
  assert.ok(worksheetEntry);
  assert.ok(stylesEntry);
  const [worksheetXml, stylesXml] = await Promise.all([
    worksheetEntry.async('string'),
    stylesEntry.async('string')
  ]);
  const cellXfsMatch = /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(stylesXml);
  assert.ok(cellXfsMatch);
  const styleCount = Number(cellXfsMatch[1]);
  assert.ok(styleCount > 1);
  const cellPattern = new RegExp(`(<c\\b[^>]*\\br="${cellReference}"[^>]*\\bs=")(\\d+)(")`);
  const cellMatch = cellPattern.exec(worksheetXml);
  assert.ok(cellMatch);
  const originalStyleId = Number(cellMatch[2]);
  const replacementStyleId = originalStyleId === 0 ? 1 : 0;
  assert.ok(replacementStyleId < styleCount);
  zip.file('xl/worksheets/sheet1.xml', worksheetXml.replace(
    cellPattern,
    `$1${replacementStyleId}$3`
  ));
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
}

async function injectBlankCellStyle(filePath, cellReference) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const worksheetEntry = zip.file('xl/worksheets/sheet1.xml');
  const stylesEntry = zip.file('xl/styles.xml');
  assert.ok(worksheetEntry);
  assert.ok(stylesEntry);
  const [worksheetXml, stylesXml] = await Promise.all([
    worksheetEntry.async('string'),
    stylesEntry.async('string')
  ]);
  assert.doesNotMatch(worksheetXml, new RegExp(`<c\\b[^>]*\\br="${cellReference}"`));
  const cellXfsMatch = /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(stylesXml);
  assert.ok(cellXfsMatch);
  assert.ok(Number(cellXfsMatch[1]) > 1);
  const rowNumber = /\d+$/.exec(cellReference)[0];
  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNumber}"[^>]*>[\\s\\S]*?)(</row>)`);
  const rowMatch = rowPattern.exec(worksheetXml);
  assert.ok(rowMatch);
  zip.file('xl/worksheets/sheet1.xml', worksheetXml.replace(
    rowPattern,
    `$1<c r="${cellReference}" s="1"></c>$2`
  ));
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
}

async function rewriteZipXml(filePath, entryPath, rewrite) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entry = zip.file(entryPath);
  assert.ok(entry);
  const originalXml = await entry.async('string');
  const rewritten = rewrite(originalXml);
  assert.notEqual(rewritten, originalXml);
  zip.file(entryPath, rewritten);
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
}

async function rewriteWorksheetXml(filePath, rewrite, sheetNumber = 1) {
  return rewriteZipXml(filePath, `xl/worksheets/sheet${sheetNumber}.xml`, rewrite);
}

async function zipEntryPayloads(zip) {
  const entries = new Map();
  for (const entryName of Object.keys(zip.files).sort()) {
    const entry = zip.files[entryName];
    if (!entry.dir) entries.set(entryName, await entry.async('nodebuffer'));
  }
  return entries;
}

async function rewriteResultWorksheetXmlOnly(
  filePath,
  rewrite,
  { requireChange = true } = {}
) {
  const beforeZip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const beforeEntries = await zipEntryPayloads(beforeZip);
  const worksheetPath = 'xl/worksheets/sheet1.xml';
  const worksheetContents = beforeEntries.get(worksheetPath);
  assert.ok(worksheetContents);
  const originalXml = worksheetContents.toString('utf8');
  const rewrittenXml = rewrite(originalXml);
  if (requireChange) assert.notEqual(rewrittenXml, originalXml);
  else assert.equal(rewrittenXml, originalXml);
  beforeZip.file(worksheetPath, rewrittenXml);
  fs.writeFileSync(filePath, await beforeZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));

  const afterZip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const afterEntries = await zipEntryPayloads(afterZip);
  assert.deepEqual([...afterEntries.keys()], [...beforeEntries.keys()]);
  for (const [entryName, contents] of beforeEntries) {
    if (entryName === worksheetPath) continue;
    assert.deepEqual(
      afterEntries.get(entryName),
      contents,
      `${entryName} entry payload 必须保持 byte-for-byte 不变`
    );
  }
  assert.equal(
    afterEntries.get(worksheetPath).toString('utf8'),
    rewrittenXml
  );
}

function xmlPatternEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteResultCellRawXml(filePath, cellReference, buildCellXml) {
  return rewriteResultWorksheetXmlOnly(filePath, (worksheetXml) => {
    const escapedReference = xmlPatternEscape(cellReference);
    const cellPattern = new RegExp(
      `<c\\b(?=[^>]*\\br="${escapedReference}"(?:\\s|/?>))[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`
    );
    const match = cellPattern.exec(worksheetXml);
    assert.ok(match, `${cellReference} raw cell 必须存在`);
    const attributesMatch = /^<c\b([^>]*?)(?:\/>|>)/.exec(match[0]);
    assert.ok(attributesMatch);
    const attributes = attributesMatch[1].replace(/\s+t="[^"]*"/g, '');
    return worksheetXml.replace(
      cellPattern,
      buildCellXml(attributes)
    );
  });
}

function rewriteResultFormulaCell(filePath, cellReference, result, { shared = false } = {}) {
  const formula = `="${String(result).replace(/"/g, '""')}"`;
  return rewriteResultCellRawXml(filePath, cellReference, (attributes) => (
    `<c${attributes} t="str"><f${shared
      ? ` t="shared" ref="${cellReference}:${cellReference}" si="0"`
      : ''}>${formula}</f><v>${result}</v></c>`
  ));
}

function rewriteResultRichTextCell(filePath, cellReference) {
  return rewriteResultCellRawXml(filePath, cellReference, (attributes) => (
    `<c${attributes} t="inlineStr"><is><r><t>VCC_</t></r>`
      + '<r><rPr><b/></rPr><t>discharge</t></r></is></c>'
  ));
}

function injectResultInternalHyperlink(filePath, cellReference, display) {
  return rewriteResultWorksheetXmlOnly(filePath, (worksheetXml) => {
    const hyperlinkXml = `<hyperlink ref="${cellReference}" location="${cellReference}" display="${display}"/>`;
    if (/<hyperlinks\b[^>]*>[\s\S]*?<\/hyperlinks>/.test(worksheetXml)) {
      return worksheetXml.replace('</hyperlinks>', `${hyperlinkXml}</hyperlinks>`);
    }
    assert.match(worksheetXml, /<pageMargins\b/);
    return worksheetXml.replace(
      /<pageMargins\b/,
      `<hyperlinks>${hyperlinkXml}</hyperlinks><pageMargins`
    );
  });
}

async function rewriteRowHidden(filePath, rowNumber) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    const pattern = new RegExp(`<row\\b([^>]*\\br="${rowNumber}"[^>]*)>`);
    const match = pattern.exec(worksheetXml);
    assert.ok(match);
    assert.doesNotMatch(match[0], /\bhidden="1"/);
    return worksheetXml.replace(pattern, `<row$1 hidden="1">`);
  });
}

async function rewriteColumnHidden(filePath, columnNumber) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    let replaced = false;
    const rewritten = worksheetXml.replace(/<col\b[^>]*\/>/g, (columnXml) => {
      if (replaced) return columnXml;
      const min = /\bmin="(\d+)"/.exec(columnXml);
      const max = /\bmax="(\d+)"/.exec(columnXml);
      if (!min || !max || Number(min[1]) > columnNumber || Number(max[1]) < columnNumber) {
        return columnXml;
      }
      assert.doesNotMatch(columnXml, /\bhidden="1"/);
      replaced = true;
      return columnXml.replace(/\/>$/, ' hidden="1"/>');
    });
    assert.equal(replaced, true);
    return rewritten;
  });
}

async function rewriteResultPageOrientation(filePath) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    const pattern = /(<pageSetup\b[^>]*\borientation=")landscape(")/;
    assert.match(worksheetXml, pattern);
    return worksheetXml.replace(pattern, '$1portrait$2');
  });
}

async function rewriteResultPageMargin(filePath) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    const pattern = /(<pageMargins\b[^>]*\bleft=")[^"]+(")/;
    assert.match(worksheetXml, pattern);
    return worksheetXml.replace(pattern, (_match, prefix, suffix) => `${prefix}0.75${suffix}`);
  });
}

async function rewriteResultHeaderFooter(filePath) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    if (/<headerFooter\b/.test(worksheetXml)) {
      return worksheetXml.replace(
        /<headerFooter\b[^>]*>[\s\S]*?<\/headerFooter>/,
        '<headerFooter><oddHeader>&amp;Ctampered</oddHeader></headerFooter>'
      );
    }
    return worksheetXml.replace(
      '</worksheet>',
      '<headerFooter><oddHeader>&amp;Ctampered</oddHeader></headerFooter></worksheet>'
    );
  });
}

async function rewriteSheetState(filePath, sheetName) {
  await rewriteZipXml(filePath, 'xl/workbook.xml', (workbookXml) => {
    const pattern = new RegExp(`(<sheet\\b(?=[^>]*\\bname="${sheetName}")[^>]*?)(\\/?>)`);
    const match = pattern.exec(workbookXml);
    assert.ok(match);
    const withoutState = match[1].replace(/\sstate="[^"]*"/g, '');
    return workbookXml.replace(
      pattern,
      (_matched, _attributes, closing) => `${withoutState} state="hidden"${closing}`
    );
  });
}

async function rewriteResultSheetState(filePath) {
  return rewriteSheetState(filePath, '财务OP校验结果表');
}

async function rewritePendingSheetState(filePath) {
  return rewriteSheetState(filePath, PENDING_SHEET_NAME);
}

async function rewritePendingHeaderFooter(filePath) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    if (/<headerFooter\b/.test(worksheetXml)) {
      return worksheetXml.replace(
        /<headerFooter\b[^>]*>[\s\S]*?<\/headerFooter>/,
        '<headerFooter><oddFooter>&amp;Rtampered</oddFooter></headerFooter>'
      );
    }
    return worksheetXml.replace(
      '</worksheet>',
      '<headerFooter><oddFooter>&amp;Rtampered</oddFooter></headerFooter></worksheet>'
    );
  }, 2);
}

async function rewritePendingSheetProperties(filePath) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    if (/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>/.test(worksheetXml)) {
      return worksheetXml.replace(
        /(<sheetPr\b[^>]*>)/,
        '$1<tabColor rgb="FFFF0000"/>'
      );
    }
    if (/<sheetPr\b[^>]*\/>/.test(worksheetXml)) {
      return worksheetXml.replace(
        /<sheetPr\b([^>]*)\/>/,
        '<sheetPr$1><tabColor rgb="FFFF0000"/></sheetPr>'
      );
    }
    return worksheetXml.replace(
      /(<worksheet\b[^>]*>)/,
      '$1<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>'
    );
  }, 2);
}

async function rewritePendingRowLayout(filePath, rowNumber, attribute) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    const pattern = new RegExp(`<row\\b([^>]*\\br="${rowNumber}"[^>]*)>`);
    const match = pattern.exec(worksheetXml);
    assert.ok(match);
    assert.doesNotMatch(match[0], new RegExp(`\\b${attribute}="`));
    return worksheetXml.replace(pattern, `<row$1 ${attribute}="1">`);
  }, 2);
}

async function injectPendingMergeRange(filePath, mergeRange) {
  await rewriteWorksheetXml(filePath, (worksheetXml) => {
    const escapedRange = mergeRange.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(
      worksheetXml,
      new RegExp(`<mergeCell\\b[^>]*\\bref="${escapedRange}"`)
    );
    if (/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/.test(worksheetXml)) {
      return worksheetXml.replace(
        /<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/,
        (_match, attributes, children) => {
          const existingCount = (children.match(/<mergeCell\b/g) || []).length;
          const normalizedAttributes = attributes.replace(/\s*count="\d+"/, '');
          return `<mergeCells${normalizedAttributes} count="${existingCount + 1}">`
            + `${children}<mergeCell ref="${mergeRange}"/></mergeCells>`;
        }
      );
    }
    assert.match(worksheetXml, /<pageMargins\b/);
    return worksheetXml.replace(
      /<pageMargins\b/,
      `<mergeCells count="1"><mergeCell ref="${mergeRange}"/></mergeCells><pageMargins`
    );
  }, 2);
}

function recomputeArtifactIdentity(result, generationPath) {
  const contents = fs.readFileSync(generationPath);
  return {
    ...result,
    artifacts: [{
      ...result.artifacts[0],
      byteSize: contents.length,
      sha256: crypto.createHash('sha256').update(contents).digest('hex')
    }]
  };
}

async function runManaged({ harness, actionKey, selectedSubjectIndexes, suffix }) {
  const selected = actionKey === VCC_EXPORT_SINGLE_ACTION
    ? selectedSubjectIndexes
    : harness.snapshot.authority.subjects.map((_subject, index) => index);
  const plan = filePlan(harness.root, selected.length, suffix);
  const stagingDirectory = path.join(harness.root, `staging-${suffix}`);
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext(suffix);
  const task = Object.freeze({
    action: 'export-result',
    taskGeneration: 7,
    taskRunId: batch.taskRunId
  });
  let publisherCalls = 0;
  let publishedDigests = null;
  const result = await generateValidateAndPublishVccExport({
    actionKey,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => readVccExportSnapshot(harness.db, harness.run),
    readCurrentTaskAuthority: async () => task,
    selectedSubjectIndexes,
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async (payload) => {
      publisherCalls += 1;
      assert.equal(payload.requireValidatedArtifacts, true);
      assert.equal(payload.requireTargetParentIdentity, true);
      assert.deepEqual(
        payload.targets.map((target) => target.expectedTargetParentIdentity),
        plan.outputs.map((output) => output.targetParentIdentity)
      );
      publishedDigests = await Promise.all(
        payload.artifacts.map((artifact) => workbookSemanticDigest(artifact.sourcePath))
      );
      return Object.freeze({
        taskId: payload.taskId,
        committed: true,
        files: payload.targets.map((target) => target.targetPath)
      });
    },
    settleManifestArtifacts: async () => {}
  });
  return { result, publisherCalls, publishedDigests, plan, selected };
}

async function runSingleCreationProbe({
  harness,
  plan,
  stagingDirectory,
  batch,
  runtime,
  publishPublication
}) {
  return generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication
  });
}

test('E12-A 两 action canonical policy + E12-C exact dual topology、production false 且 validator 隔离', () => {
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(VCC_EXPORT_SINGLE_POLICY, fixture[VCC_EXPORT_SINGLE_ACTION]);
  const expectedSubjects = fixture[VCC_EXPORT_SUBJECTS_ACTION];
  assert.deepEqual(VCC_EXPORT_SUBJECTS_POLICY, {
    ...expectedSubjects,
    resources: {
      ...expectedSubjects.resources,
      phase: {
        cpuSlots: 0,
        workerThreadSlots: 0,
        utilityProcessSlots: 0,
        ioHeavySlots: 0,
        memoryBytes: 0
      },
      compound: {
        ...expectedSubjects.resources.compound,
        childrenMax: 2
      }
    },
    workUnits: {
      ...expectedSubjects.workUnits,
      requestedMaxWorkers: 2
    }
  });
  assert.equal(isBackgroundExecutionProductionEnabled(VCC_EXPORT_SINGLE_ACTION), false);
  assert.equal(isBackgroundExecutionProductionEnabled(VCC_EXPORT_SUBJECTS_ACTION), false);
  assert.equal(validateVccExportSingleResult({}), false);
  assert.equal(validateVccExportSubjectsResult({}), false);
});

test('canonical FilePlan 与 legacy writer 仅接受 xlsx extension，csv 在 Worker 前 fail closed', async (t) => {
  const harness = setup(t, ['PPHK']);
  const outputRoot = path.join(harness.root, 'extension-targets');
  fs.mkdirSync(outputRoot);
  const makePlan = (fileName) => normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(outputRoot, fileName),
      role: 'output',
      sourceOperation: 'vccFinancialOp:export:result'
    }]
  });
  const uppercaseXlsx = makePlan('accepted.XLSX');
  assert.equal(canonicalFilePlan(uppercaseXlsx, 1).outputs.length, 1);
  assert.equal(assertXlsxOutputPath(path.join(outputRoot, 'legacy.XLSX')),
    path.join(outputRoot, 'legacy.XLSX'));

  const csvPath = path.join(outputRoot, 'rejected.csv');
  const csvPlan = makePlan('rejected.csv');
  assert.throws(() => canonicalFilePlan(csvPlan, 1), /FilePlan/);
  assert.throws(() => assertXlsxOutputPath(csvPath), /xlsx/);
  const stagingDirectory = path.join(harness.root, 'staging-extension');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let workerCalls = 0;
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: { async execute() { workerCalls += 1; } },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: csvPlan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /FilePlan/);
  assert.equal(workerCalls, 0);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('export-subjects 真单 Writer 按 subjectIndex 输出全集，与 legacy semantic golden 等价且 Publisher=1', async (t) => {
  const harness = setup(t);
  const legacyRoot = path.join(harness.root, 'legacy-subjects');
  fs.mkdirSync(legacyRoot);
  const legacyPaths = harness.snapshot.data.subjects.map((_subject, index) => (
    path.join(legacyRoot, `${index}.xlsx`)
  ));
  await writeRunWorkbooks({
    db: harness.db,
    runId: harness.run.runId,
    outputPaths: legacyPaths,
    assetsDir: ASSETS_DIR
  });
  const legacyDigests = await Promise.all(legacyPaths.map(workbookSemanticDigest));
  const managed = await runManaged({
    harness,
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    suffix: 'subjects'
  });
  assert.equal(managed.publisherCalls, 1);
  assert.deepEqual(managed.publishedDigests, legacyDigests);
  assert.deepEqual(managed.result.artifacts.map((item) => item.subjectIndex), [0, 1]);
  assert.deepEqual(
    managed.result.artifacts.map((item) => item.businessDigest),
    harness.snapshot.authority.subjects.map((item) => item.businessDigest)
  );
});

test('export-single 复用 one-shot core 导出 exact-one 非首主体，与 legacy specialization 等价', async (t) => {
  const harness = setup(t);
  const legacyPath = path.join(harness.root, 'legacy-single.xlsx');
  await writeRunWorkbooks({
    db: harness.db,
    runId: harness.run.runId,
    outputPaths: [legacyPath],
    assetsDir: ASSETS_DIR,
    subjectIndexes: [1]
  });
  const managed = await runManaged({
    harness,
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    selectedSubjectIndexes: [1],
    suffix: 'single'
  });
  assert.equal(managed.publisherCalls, 1);
  assert.deepEqual(managed.publishedDigests, [await workbookSemanticDigest(legacyPath)]);
  assert.equal(managed.result.artifacts.length, 1);
  assert.equal(managed.result.artifacts[0].subjectIndex, 1);
  assert.equal(
    managed.result.artifacts[0].subjectDigest,
    harness.snapshot.authority.subjects[1].subjectDigest
  );
});

test('Pending canonical merge projection 保留完整范围且与插入顺序无关', () => {
  const buildProjection = (mergeRanges) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(PENDING_SHEET_NAME);
    for (const mergeRange of mergeRanges) sheet.mergeCells(mergeRange);
    return pendingSheetProjection(sheet);
  };
  const first = buildProjection(['H2:I2', 'AA10:AC12']);
  const second = buildProjection(['AA10:AC12', 'H2:I2']);
  assert.deepEqual(first.merges, ['AA10:AC12', 'H2:I2']);
  assert.deepEqual(second, first);
});

test('export-subjects topology 固定一个 Writer，result DTO 有界且不含主体/资金原始行', async (t) => {
  const harness = setup(t);
  const plan = filePlan(harness.root, 2, 'topology');
  const stagingDirectory = path.join(harness.root, 'staging-topology');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('subjects');
  const task = Object.freeze({
    action: 'export-result', taskGeneration: 9, taskRunId: batch.taskRunId
  });
  const generation = createGenerationInput({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    authority: harness.snapshot.authority,
    filePlan: plan,
    operationKey: batch.operationKey,
    selectedSubjectIndexes: [0, 1],
    stagingDirectory,
    taskAuthority: task
  });
  const control = harness.runtime.start({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    operationKey: batch.operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: batch.taskRunId,
        taskKey: batch.taskKey,
        moduleId: batch.moduleId,
        parentRunId: batch.parentRunId,
        operationKey: batch.operationKey
      }
    },
    input: {
      contractVersion: generation.contractVersion,
      authority: generation.authority,
      task: generation.task,
      generations: generation.generations,
      stagingIdentity: generation.stagingIdentity
    }
  });
  await control.ready;
  assert.equal(control.snapshot().topology.effectiveChildCount, 1);
  const execution = await control.promise;
  assert.equal(execution.outcome, 'completed');
  const serialized = JSON.stringify(execution.result);
  assert.ok(Buffer.byteLength(serialized) < 8192);
  assert.doesNotMatch(serialized, /PPAU|PPHK|\bUSD\b|\bEUR\b|flow_amount|pending_amount/);
});

test('activeTask/taskGeneration B 变化时 fail closed 且 Publisher=0', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'task-authority');
  const stagingDirectory = path.join(harness.root, 'staging-task-authority');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let taskReads = 0;
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => {
      taskReads += 1;
      return {
        action: 'export-result',
        taskGeneration: taskReads === 1 ? 0 : 1,
        taskRunId: batch.taskRunId
      };
    },
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /authority/);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('run/revision/fingerprint/archive B authority 变化时 fail closed 且 Publisher=0', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'run-authority');
  const stagingDirectory = path.join(harness.root, 'staging-run-authority');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let snapshotReads = 0;
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => {
      snapshotReads += 1;
      if (snapshotReads === 1) return harness.snapshot;
      return {
        ...harness.snapshot,
        authority: {
          ...harness.snapshot.authority,
          archiveStateDigest: 'b'.repeat(64),
          authorityDigest: 'c'.repeat(64)
        }
      };
    },
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /authority/);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('artifact hash/size TOCTOU 被 Main Join 阻断，Publisher=0 且 staging 清空', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'artifact-tamper');
  const stagingDirectory = path.join(harness.root, 'staging-artifact-tamper');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute(request) {
        const result = await executeVccExportWriter({
          ...request.input,
          databasePath: harness.dbPath,
          assetsDir: ASSETS_DIR
        }, null, VCC_EXPORT_SINGLE_ACTION);
        fs.appendFileSync(request.input.generations[0].generationPath, 'tampered');
        return { outcome: 'completed', terminalSource: 'job:done', result };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /artifact|size|identity/i);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('Main Join 后 generation 被替换时 wrapper 绑定 expected identity，Publisher=0', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'after-join-tamper');
  const stagingDirectory = path.join(harness.root, 'staging-after-join-tamper');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let snapshotReads = 0;
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => {
      snapshotReads += 1;
      if (snapshotReads === 3) {
        const [taskDirectoryName] = fs.readdirSync(stagingDirectory);
        const taskDirectory = path.join(stagingDirectory, taskDirectoryName);
        const [generationName] = fs.readdirSync(taskDirectory);
        fs.appendFileSync(path.join(taskDirectory, generationName), 'after-join-tamper');
      }
      return harness.snapshot;
    },
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), (error) => error.code === 'VCC_OUTPUT_GENERATION_CHANGED_AFTER_JOIN');
  assert.equal(snapshotReads, 3);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('自洽伪造 size/hash 的 workbook 业务篡改仍由 Main 深度回读阻断', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'business-tamper');
  const stagingDirectory = path.join(harness.root, 'staging-business-tamper');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute(request) {
        const result = await executeVccExportWriter({
          ...request.input,
          databasePath: harness.dbPath,
          assetsDir: ASSETS_DIR
        }, null, VCC_EXPORT_SINGLE_ACTION);
        const generationPath = request.input.generations[0].generationPath;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(generationPath);
        workbook.worksheets[0].getCell('C2').value = 999;
        await workbook.xlsx.writeFile(generationPath);
        const contents = fs.readFileSync(generationPath);
        const artifact = {
          ...result.artifacts[0],
          byteSize: contents.length,
          sha256: crypto.createHash('sha256').update(contents).digest('hex')
        };
        return {
          outcome: 'completed',
          terminalSource: 'job:done',
          result: { ...result, artifacts: [artifact] }
        };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /金额|业务|不一致|非法|校验失败/);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('Result raw ZIP no-op 仅重打包 sheet1.xml 时保持合法且 Publisher=1', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'raw-xml-no-op');
  const stagingDirectory = path.join(harness.root, 'staging-raw-xml-no-op');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('raw-xml-no-op');
  let publisherCalls = 0;
  let publishedSourcePaths = [];
  const result = await generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute(request) {
        const writerResult = await executeVccExportWriter({
          ...request.input,
          databasePath: harness.dbPath,
          assetsDir: ASSETS_DIR
        }, null, VCC_EXPORT_SINGLE_ACTION);
        const generationPath = request.input.generations[0].generationPath;
        await rewriteResultWorksheetXmlOnly(
          generationPath,
          (worksheetXml) => worksheetXml,
          { requireChange: false }
        );
        return {
          outcome: 'completed',
          terminalSource: 'job:done',
          result: recomputeArtifactIdentity(writerResult, generationPath)
        };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async (payload) => {
      publisherCalls += 1;
      publishedSourcePaths = payload.artifacts.map((artifact) => artifact.sourcePath);
      for (const sourcePath of publishedSourcePaths) {
        assert.ok(fs.statSync(sourcePath).size > 0);
      }
      return Object.freeze({ taskId: payload.taskId, committed: true });
    },
    settleManifestArtifacts: async () => {}
  });
  assert.equal(publisherCalls, 1);
  assert.equal(publishedSourcePaths.length, 1);
  assert.equal(result.publication.committed, true);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('raw XLSX/ExcelJS 自洽篡改 Result 文本类型、样式与完整页面布局仍在 Main Join 阻断', async (t) => {
  const harness = setup(t, ['PPHK']);
  const tamperCases = [
    ['C1 header style', (filePath) => rewriteCellStyleId(filePath, 'C1')],
    ['A2 subject merge master style', (filePath) => rewriteCellStyleId(filePath, 'A2')],
    ['C3 ordinary classification style', (filePath) => rewriteCellStyleId(filePath, 'C3')],
    ['M3 ordinary blank style', (filePath) => injectBlankCellStyle(filePath, 'M3')],
    ['N3 ordinary blank style', (filePath) => injectBlankCellStyle(filePath, 'N3')],
    ['row 3 hidden', (filePath) => rewriteRowHidden(filePath, 3)],
    ['column C hidden', (filePath) => rewriteColumnHidden(filePath, 3)],
    ['result page orientation', rewriteResultPageOrientation],
    ['result page margin', rewriteResultPageMargin],
    ['result header footer', rewriteResultHeaderFooter],
    ['result sheet state', rewriteResultSheetState],
    ['pending row 2 hidden', (filePath) => rewritePendingRowLayout(filePath, 2, 'hidden')],
    ['pending row 2 outline', (filePath) => rewritePendingRowLayout(filePath, 2, 'outlineLevel')],
    ['pending workbook sheet hidden', rewritePendingSheetState],
    ['pending header footer', rewritePendingHeaderFooter],
    ['pending sheet properties', rewritePendingSheetProperties],
    ['pending injected merge H2:I2', (filePath) => injectPendingMergeRange(filePath, 'H2:I2')],
    ['result C1 formula cached text', (filePath) => (
      rewriteResultFormulaCell(filePath, 'C1', '分类')
    ), 'VCC 财务OP导出普通文本校验失败：C1 含 formula'],
    ['result A2 hyperlink text', (filePath) => (
      injectResultInternalHyperlink(filePath, 'A2', 'PPHK')
    ), 'VCC 财务OP导出普通文本校验失败：A2 含 hyperlink'],
    ['result B3 rich text', (filePath) => (
      rewriteResultRichTextCell(filePath, 'B3')
    ), 'VCC 财务OP导出普通文本校验失败：B3 含 richText'],
    ['result C3 shared formula cached text', (filePath) => (
      rewriteResultFormulaCell(filePath, 'C3', 'B2B', { shared: true })
    ), 'VCC 财务OP导出普通文本校验失败：C3 含 sharedFormula']
  ];
  for (const [label, tamper, expectedMessage] of tamperCases) {
    await t.test(label, async () => {
      const suffix = `semantic-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      const plan = filePlan(harness.root, 1, suffix);
      const stagingDirectory = path.join(harness.root, `staging-${suffix}`);
      fs.mkdirSync(stagingDirectory);
      const batch = batchContext(suffix);
      let publisherCalls = 0;
      await assert.rejects(generateValidateAndPublishVccExport({
        actionKey: VCC_EXPORT_SINGLE_ACTION,
        runtime: {
          async execute(request) {
            const result = await executeVccExportWriter({
              ...request.input,
              databasePath: harness.dbPath,
              assetsDir: ASSETS_DIR
            }, null, VCC_EXPORT_SINGLE_ACTION);
            const generationPath = request.input.generations[0].generationPath;
            await tamper(generationPath);
            return {
              outcome: 'completed',
              terminalSource: 'job:done',
              result: recomputeArtifactIdentity(result, generationPath)
            };
          }
        },
        expectedAuthority: harness.snapshot.authority,
        readCurrentSnapshot: async () => harness.snapshot,
        readCurrentTaskAuthority: async () => ({
          action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
        }),
        selectedSubjectIndexes: [0],
        filePlan: plan,
        stagingDirectory,
        assetsDir: ASSETS_DIR,
        batchContext: batch,
        publishPublication: async () => { publisherCalls += 1; }
      }), (error) => {
        if (expectedMessage) {
          assert.equal(error.code, 'vcc-result-export-validation-failed');
          assert.equal(error.message, expectedMessage);
          assert.match(error.message, /普通文本校验失败/);
        } else {
          assert.match(error.message, /样式|布局|校验失败/);
        }
        return true;
      });
      assert.equal(publisherCalls, 0);
      assert.deepEqual(fs.readdirSync(stagingDirectory), []);
    });
  }
});

test('Result merge follower raw cached formula 自洽篡改仍由 Main Join 阻断且 Publisher=0', async (t) => {
  const harness = setup(t, ['PPHK']);
  const cases = [
    {
      label: 'A3 subject follower formula',
      cellReference: 'A3',
      result: 'PPHK',
      shared: false,
      expectedMessage: 'VCC 财务OP导出合并 follower 原始 payload 校验失败：A3 含 formula'
    },
    {
      label: 'C2 major/minor follower shared formula',
      cellReference: 'C2',
      result: '上月财务OP',
      shared: true,
      expectedMessage: 'VCC 财务OP导出合并 follower 原始 payload 校验失败：C2 含 sharedFormula'
    }
  ];
  for (const current of cases) {
    await t.test(current.label, async () => {
      const suffix = `raw-follower-${current.cellReference.toLowerCase()}`;
      const plan = filePlan(harness.root, 1, suffix);
      const stagingDirectory = path.join(harness.root, `staging-${suffix}`);
      fs.mkdirSync(stagingDirectory);
      const batch = batchContext(suffix);
      let publisherCalls = 0;
      const publishedSourcePaths = [];
      await assert.rejects(generateValidateAndPublishVccExport({
        actionKey: VCC_EXPORT_SINGLE_ACTION,
        runtime: {
          async execute(request) {
            const writerResult = await executeVccExportWriter({
              ...request.input,
              databasePath: harness.dbPath,
              assetsDir: ASSETS_DIR
            }, null, VCC_EXPORT_SINGLE_ACTION);
            const generationPath = request.input.generations[0].generationPath;
            await rewriteResultFormulaCell(
              generationPath,
              current.cellReference,
              current.result,
              { shared: current.shared }
            );
            return {
              outcome: 'completed',
              terminalSource: 'job:done',
              result: recomputeArtifactIdentity(writerResult, generationPath)
            };
          }
        },
        expectedAuthority: harness.snapshot.authority,
        readCurrentSnapshot: async () => harness.snapshot,
        readCurrentTaskAuthority: async () => ({
          action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
        }),
        selectedSubjectIndexes: [0],
        filePlan: plan,
        stagingDirectory,
        assetsDir: ASSETS_DIR,
        batchContext: batch,
        publishPublication: async (payload) => {
          publisherCalls += 1;
          publishedSourcePaths.push(...payload.artifacts.map((artifact) => artifact.sourcePath));
        }
      }), (error) => {
        assert.equal(error.code, 'vcc-result-export-validation-failed');
        assert.equal(error.message, current.expectedMessage);
        return true;
      });
      assert.equal(publisherCalls, 0);
      assert.deepEqual(publishedSourcePaths, []);
      assert.equal(fs.existsSync(plan.outputs[0].filePath), false);
      assert.deepEqual(fs.readdirSync(stagingDirectory), []);
    });
  }
});

test('Publisher 失败不重试：调用恰一次，错误透传且 generation artifacts 清理', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'publisher-failure');
  const stagingDirectory = path.join(harness.root, 'staging-publisher-failure');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => {
      publisherCalls += 1;
      throw new Error('fixture publisher failure');
    }
  }), /fixture publisher failure/);
  assert.equal(publisherCalls, 1);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('Publisher 人工恢复 preserve 保留全部 task-private 文件并合并有界 recoveryPaths', async (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'publisher-preserve');
  const stagingDirectory = path.join(harness.root, 'staging-publisher-preserve');
  fs.mkdirSync(stagingDirectory);
  const batch = batchContext('single');
  const journalPath = path.join(harness.root, 'manual-recovery-journal.json');
  let publisherCalls = 0;
  let preservedGenerationPath = null;
  let preservedAtomicPath = null;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: harness.runtime,
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      selectedSubjectIndexes: [0],
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async (payload) => {
        publisherCalls += 1;
        preservedGenerationPath = payload.artifacts[0].sourcePath;
        preservedAtomicPath = `${preservedGenerationPath}.11111111-2222-3333-4444-555555555555.tmp`;
        fs.writeFileSync(preservedAtomicPath, 'atomic-recovery-evidence');
        fs.writeFileSync(path.join(stagingDirectory, 'unrelated.keep'), 'keep');
        const error = new Error('fixture manual recovery');
        error.preserveTemporaryFiles = true;
        error.recoveryPaths = [journalPath, journalPath];
        throw error;
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.match(caught.message, /manual recovery/);
  assert.equal(caught.preserveTemporaryFiles, true);
  assert.equal(publisherCalls, 1);
  assert.equal(fs.existsSync(preservedGenerationPath), true);
  assert.equal(fs.existsSync(preservedAtomicPath), true);
  assert.equal(fs.existsSync(path.join(stagingDirectory, 'unrelated.keep')), true);
  assert.equal(caught.recoveryPaths[0], preservedGenerationPath);
  assert.ok(caught.recoveryPaths.includes(journalPath));
  assert.equal(new Set(caught.recoveryPaths).size, caught.recoveryPaths.length);
  assert.ok(caught.recoveryPaths.length <= 100);
});

test('Publisher committed 后 generation/task-dir cleanup 失败保留成功并返回有界 pending evidence', async (t) => {
  for (const fixture of [
    { label: 'generation rm EBUSY', method: 'rmSync', code: 'EBUSY' },
    { label: 'generation rm EPERM', method: 'rmSync', code: 'EPERM' },
    { label: 'task dir rmdir EPERM', method: 'rmdirSync', code: 'EPERM' }
  ]) {
    await t.test(fixture.label, async (subtest) => {
      const harness = setup(subtest, ['PPHK']);
      const suffix = `committed-cleanup-${fixture.method}-${fixture.code}`;
      const plan = filePlan(harness.root, 1, suffix);
      const stagingDirectory = path.join(harness.root, `staging-${suffix}`);
      fs.mkdirSync(stagingDirectory);
      const batch = batchContext(suffix);
      let capturedInput = null;
      let publisherCalls = 0;
      const original = fs[fixture.method];
      fs[fixture.method] = function patchedCleanup(filePath, options) {
        const candidate = path.resolve(String(filePath));
        const taskRoot = capturedInput && capturedInput.stagingIdentity.resolvedPath;
        const generationPath = capturedInput && capturedInput.generations[0].generationPath;
        const shouldFail = fixture.method === 'rmSync'
          ? candidate === generationPath
          : taskRoot && candidate === taskRoot;
        if (shouldFail) {
          const error = new Error(`fixture ${fixture.code}`);
          error.code = fixture.code;
          throw error;
        }
        return original.call(this, filePath, options);
      };
      let result;
      try {
        result = await generateValidateAndPublishVccExport({
          actionKey: VCC_EXPORT_SINGLE_ACTION,
          runtime: {
            async execute(request) {
              capturedInput = request.input;
              return harness.runtime.execute(request);
            }
          },
          expectedAuthority: harness.snapshot.authority,
          readCurrentSnapshot: async () => harness.snapshot,
          readCurrentTaskAuthority: async () => ({
            action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
          }),
          selectedSubjectIndexes: [0],
          filePlan: plan,
          stagingDirectory,
          assetsDir: ASSETS_DIR,
          batchContext: batch,
          publishPublication: async (payload) => {
            publisherCalls += 1;
            fs.copyFileSync(payload.artifacts[0].sourcePath, payload.targets[0].targetPath);
            return Object.freeze({ taskId: payload.taskId, committed: true });
          },
          settleManifestArtifacts: async () => {}
        });
      } finally {
        fs[fixture.method] = original;
      }
      assert.equal(publisherCalls, 1);
      assert.equal(result.publication.committed, true);
      assert.equal(fs.existsSync(plan.outputs[0].filePath), true);
      fs.unlinkSync(plan.outputs[0].filePath);
      assert.deepEqual(Object.keys(result.publication.generationCleanup).sort(), [
        'contractVersion', 'diagnosticCodes', 'preserveTemporaryFiles', 'recoveryPaths',
        'status', 'taskRootIdentityDigest'
      ]);
      assert.equal(result.publication.generationCleanup.status, 'pending');
      assert.equal(result.publication.generationCleanup.preserveTemporaryFiles, true);
      assert.deepEqual(result.publication.generationCleanup.diagnosticCodes, [fixture.code]);
      assert.equal(
        result.publication.generationCleanup.taskRootIdentityDigest,
        capturedInput.stagingIdentity.identityDigest
      );
      const expectedRecoveryPath = fixture.method === 'rmSync'
        ? capturedInput.generations[0].generationPath
        : capturedInput.stagingIdentity.resolvedPath;
      assert.deepEqual(result.publication.generationCleanup.recoveryPaths, [expectedRecoveryPath]);
      assert.equal(fs.existsSync(expectedRecoveryPath), true);

      let retryWorkerCalls = 0;
      await assert.rejects(generateValidateAndPublishVccExport({
        actionKey: VCC_EXPORT_SINGLE_ACTION,
        runtime: { async execute() { retryWorkerCalls += 1; } },
        expectedAuthority: harness.snapshot.authority,
        readCurrentSnapshot: async () => harness.snapshot,
        readCurrentTaskAuthority: async () => ({
          action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
        }),
        selectedSubjectIndexes: [0],
        filePlan: plan,
        stagingDirectory,
        assetsDir: ASSETS_DIR,
        batchContext: batch,
        publishPublication: async () => { publisherCalls += 1; }
      }), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
      assert.equal(retryWorkerCalls, 0);
      assert.equal(publisherCalls, 1);

      const recoveryError = new Error('existing cleanup owner retry');
      const recovered = cleanupGenerationArtifacts(
        capturedInput.generations,
        recoveryError,
        capturedInput.stagingIdentity.resolvedPath,
        capturedInput.stagingIdentity.realPath,
        capturedInput.stagingIdentity
      );
      assert.equal(recovered.status, 'complete');
      assert.deepEqual(recovered.recoveryPaths, []);
      assert.equal(fs.existsSync(capturedInput.stagingIdentity.resolvedPath), false);
    });
  }
});

test('Worker failure/cancel 及 transport crash 都保持 Publisher=0 并清理 task-private artifacts', async (t) => {
  const harness = setup(t);
  const directStaging = path.join(harness.root, 'direct-cancel');
  fs.mkdirSync(directStaging);
  const generationPath = path.join(directStaging, 'cancel.xlsx');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeVccExportWriter({
    contractVersion: 1,
    databasePath: harness.dbPath,
    assetsDir: ASSETS_DIR,
    authority: harness.snapshot.authority,
    task: { action: 'export-result', taskGeneration: 0, taskRunId: 'cancel-task' },
    stagingIdentity: createTaskStagingIdentity({
      resolvedPath: directStaging,
      realPath: fs.realpathSync(directStaging)
    }),
    generations: [{
      subjectIndex: 0,
      outputArtifactKey: `output-${'d'.repeat(64)}`,
      generationPath
    }]
  }, controller.signal, VCC_EXPORT_SINGLE_ACTION), (error) => error.code === 'VCC_EXPORT_CANCELLED');
  assert.deepEqual(fs.readdirSync(directStaging), []);

  const betweenStaging = path.join(harness.root, 'between-cancel');
  fs.mkdirSync(betweenStaging);
  const betweenController = new AbortController();
  let writeCalls = 0;
  await assert.rejects(writeRunWorkbooks({
    db: harness.db,
    runId: harness.run.runId,
    outputPaths: [
      path.join(betweenStaging, '0.xlsx'),
      path.join(betweenStaging, '1.xlsx')
    ],
    assetsDir: ASSETS_DIR,
    abortSignal: betweenController.signal,
    cleanupOnFailure: true,
    writeSubjectWorkbookFn: async ({ outputPath }) => {
      writeCalls += 1;
      fs.writeFileSync(outputPath, 'partial');
      betweenController.abort();
      return outputPath;
    }
  }), (error) => error.code === 'VCC_EXPORT_CANCELLED');
  assert.equal(writeCalls, 1);
  assert.deepEqual(fs.readdirSync(betweenStaging), []);

  const crashStaging = path.join(harness.root, 'crash-staging');
  fs.mkdirSync(crashStaging);
  const plan = filePlan(harness.root, 1, 'crash');
  const batch = batchContext('single');
  let publisherCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute(request) {
        fs.writeFileSync(request.input.generations[0].generationPath, 'partial');
        return {
          outcome: 'failed',
          terminalSource: 'unexpected-exit',
          error: {
            code: 'UNEXPECTED_EXIT',
            message: 'fixture crash',
            stage: 'execute',
            detailLines: []
          }
        };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory: crashStaging,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /fixture crash/);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(crashStaging), []);
});

test('forced-shutdown 等价失败只清理 exact generation 与同源 UUID tmp，不递归删除未知文件', async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'forced-shutdown-staging');
  fs.mkdirSync(stagingDirectory);
  const plan = filePlan(harness.root, 1, 'forced-shutdown');
  const batch = batchContext('single');
  let publisherCalls = 0;
  let generationPath = null;
  let atomicTempPath = null;
  let lookalikePath = null;
  const unrelatedPath = path.join(stagingDirectory, 'unrelated.keep');
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute(request) {
        generationPath = request.input.generations[0].generationPath;
        atomicTempPath = `${generationPath}.11111111-2222-3333-4444-555555555555.tmp`;
        lookalikePath = `${generationPath}.not-a-uuid.tmp`;
        fs.writeFileSync(generationPath, 'partial-generation');
        fs.writeFileSync(atomicTempPath, 'partial-atomic');
        fs.writeFileSync(lookalikePath, 'do-not-delete');
        fs.writeFileSync(unrelatedPath, 'do-not-delete');
        return {
          outcome: 'failed',
          terminalSource: 'shutdown-timeout',
          error: {
            code: 'BACKGROUND_EXECUTION_SHUTDOWN_TIMEOUT',
            message: 'fixture forced shutdown',
            stage: 'execute',
            detailLines: []
          }
        };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), /forced shutdown/);
  assert.equal(publisherCalls, 0);
  assert.equal(fs.existsSync(generationPath), false);
  assert.equal(fs.existsSync(atomicTempPath), false);
  assert.equal(fs.existsSync(lookalikePath), true);
  assert.equal(fs.existsSync(unrelatedPath), true);
});

test('真实 FS readdir EACCES 仅保留 exact task dir，恢复权限后同 cleanup owner 可清理并无碰撞重试', {
  skip: process.platform === 'win32' ? 'Windows ACL 不提供 chmod 0300 等价权限模型' : false
}, async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'scan-eacces-staging-root');
  fs.mkdirSync(stagingDirectory);
  const sharedRootEvidence = path.join(stagingDirectory, 'shared-root.keep');
  fs.writeFileSync(sharedRootEvidence, 'caller-owned');
  const plan = filePlan(harness.root, 1, 'scan-eacces');
  const batch = batchContext('scan-eacces');
  let publisherCalls = 0;
  let generations = [];
  let taskStagingDirectory = null;
  let taskStagingIdentity = null;
  let generationPath = null;
  let atomicTempPath = null;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: {
        async execute(request) {
          generations = request.input.generations;
          taskStagingIdentity = request.input.stagingIdentity;
          generationPath = generations[0].generationPath;
          taskStagingDirectory = path.dirname(generationPath);
          atomicTempPath = `${generationPath}.11111111-2222-3333-4444-555555555555.tmp`;
          fs.writeFileSync(generationPath, 'known-generation');
          fs.writeFileSync(atomicTempPath, 'atomic-partial');
          fs.chmodSync(taskStagingDirectory, 0o300);
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'VCC_FIXTURE_SCAN_EACCES',
              message: 'fixture first error survives cleanup',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      selectedSubjectIndexes: [0],
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async () => { publisherCalls += 1; }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'VCC_FIXTURE_SCAN_EACCES');
  assert.equal(caught.message, 'fixture first error survives cleanup');
  assert.equal(caught.preserveTemporaryFiles, true);
  assert.deepEqual(caught.recoveryPaths, [taskStagingDirectory]);
  assert.notEqual(taskStagingDirectory, stagingDirectory);
  assert.ok(taskStagingDirectory.startsWith(`${stagingDirectory}${path.sep}vcc-export-`));
  assert.match(caught.detailLines.join('\n'), /EACCES/);
  assert.equal(fs.existsSync(generationPath), false, '已知 generation 在无 read 权限时仍按 exact path 删除');
  assert.equal(fs.existsSync(atomicTempPath), true, '无法扫描时不得猜测 atomic tmp');
  assert.equal(fs.existsSync(sharedRootEvidence), true);
  assert.equal(caught.recoveryPaths.includes(stagingDirectory), false);
  assert.equal(publisherCalls, 0);

  fs.chmodSync(taskStagingDirectory, 0o700);
  const recoveryCleanupError = new Error('recovery cleanup owner');
  cleanupGenerationArtifacts(
    generations,
    recoveryCleanupError,
    taskStagingDirectory,
    taskStagingIdentity.realPath,
    taskStagingIdentity
  );
  assert.equal(fs.existsSync(taskStagingDirectory), false);
  assert.equal(recoveryCleanupError.preserveTemporaryFiles, undefined);
  assert.equal(fs.existsSync(sharedRootEvidence), true);

  let retryWorkerCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: {
      async execute() {
        retryWorkerCalls += 1;
        return {
          outcome: 'failed',
          terminalSource: 'job:error',
          error: {
            code: 'VCC_FIXTURE_RETRY_EXECUTED',
            message: 'fixture retry reached same Writer owner',
            stage: 'execute',
            detailLines: []
          }
        };
      }
    },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), (error) => error.code === 'VCC_FIXTURE_RETRY_EXECUTED');
  assert.equal(retryWorkerCalls, 1);
  assert.equal(publisherCalls, 0);
  assert.deepEqual(fs.readdirSync(stagingDirectory), ['shared-root.keep']);
});

test('task staging 拒绝 shared-root symlink、非规范 escape 与 exact child reparse', (t) => {
  const harness = setup(t, ['PPHK']);
  const plan = filePlan(harness.root, 1, 'staging-containment');
  const batch = batchContext('staging-containment');
  const task = Object.freeze({
    action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
  });
  const realParent = path.join(harness.root, 'real-staging-parent');
  const parentSymlink = path.join(harness.root, 'staging-parent-link');
  fs.mkdirSync(realParent);
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(realParent, parentSymlink, directoryLinkType);
  const create = (stagingDirectory) => createGenerationInput({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    authority: harness.snapshot.authority,
    filePlan: plan,
    operationKey: batch.operationKey,
    selectedSubjectIndexes: [0],
    stagingDirectory,
    taskAuthority: task
  });
  assert.throws(() => create(parentSymlink), (error) => (
    error.code === 'VCC_EXPORT_STAGING_INVALID'
  ));
  const nonCanonicalParent = `${realParent}${path.sep}..${path.sep}${path.basename(realParent)}`;
  assert.throws(() => create(nonCanonicalParent), (error) => (
    error.code === 'VCC_EXPORT_STAGING_INVALID'
  ));

  const generation = create(realParent);
  const taskStagingDirectory = generation.stagingRoot;
  const escapeTarget = path.join(harness.root, 'outside-task-staging');
  fs.mkdirSync(escapeTarget);
  fs.rmdirSync(taskStagingDirectory);
  fs.symlinkSync(escapeTarget, taskStagingDirectory, directoryLinkType);
  assert.throws(() => create(realParent), (error) => (
    error.code === 'VCC_EXPORT_STAGING_ESCAPE'
  ));
});

test('task dir post-create identity/collision 失败统一由既有 cleanup owner 收口', async (t) => {
  await t.test('post-create identity probe 一次失败后清掉精确自建目录且可重试', () => {
    const harness = setup(t, ['PPHK']);
    const stagingDirectory = path.join(harness.root, 'post-create-identity');
    fs.mkdirSync(stagingDirectory);
    const plan = filePlan(harness.root, 1, 'post-create-identity');
    const batch = batchContext('post-create-identity');
    const task = Object.freeze({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    });
    const originalRealpathSync = fs.realpathSync;
    let injected = false;
    fs.realpathSync = function patchedRealpathSync(filePath, options) {
      const candidate = path.resolve(String(filePath));
      if (!injected && path.dirname(candidate) === stagingDirectory &&
          path.basename(candidate).startsWith('vcc-export-') &&
          fs.existsSync(candidate)) {
        injected = true;
        const error = new Error('fixture post-create realpath EIO');
        error.code = 'EIO';
        throw error;
      }
      return originalRealpathSync.call(this, filePath, options);
    };
    try {
      assert.throws(() => createGenerationInput({
        actionKey: VCC_EXPORT_SINGLE_ACTION,
        authority: harness.snapshot.authority,
        filePlan: plan,
        operationKey: batch.operationKey,
        selectedSubjectIndexes: [0],
        stagingDirectory,
        taskAuthority: task
      }), (error) => error.code === 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
    } finally {
      fs.realpathSync = originalRealpathSync;
    }
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
    const retry = createGenerationInput({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      authority: harness.snapshot.authority,
      filePlan: plan,
      operationKey: batch.operationKey,
      selectedSubjectIndexes: [0],
      stagingDirectory,
      taskAuthority: task
    });
    assert.equal(cleanupGenerationArtifacts(
      retry.generations,
      new Error('post-create identity retry cleanup'),
      retry.stagingRoot,
      retry.stagingRootReal,
      retry.stagingIdentity
    ).status, 'complete');
  });

  await t.test('post-mkdir freeze 发生 replacement+EIO 时不从 lexical replacement 重取删除 authority', async () => {
    const harness = setup(t, ['PPHK']);
    const stagingDirectory = path.join(harness.root, 'post-create-replacement-eio');
    fs.mkdirSync(stagingDirectory);
    const plan = filePlan(harness.root, 1, 'post-create-replacement-eio');
    const batch = batchContext('post-create-replacement-eio');
    const originalRealpathSync = fs.realpathSync;
    let taskRoot = null;
    let originalTaskRoot = null;
    let replacementSentinel = null;
    let injected = false;
    let workerCalls = 0;
    let publisherCalls = 0;
    fs.realpathSync = function patchedRealpathSync(filePath, options) {
      const candidate = path.resolve(String(filePath));
      if (!injected && path.dirname(candidate) === stagingDirectory &&
          path.basename(candidate).startsWith('vcc-export-') && fs.existsSync(candidate)) {
        taskRoot = candidate;
        originalTaskRoot = `${candidate}.original`;
        fs.renameSync(taskRoot, originalTaskRoot);
        fs.mkdirSync(taskRoot);
        replacementSentinel = path.join(taskRoot, 'replacement.keep');
        fs.writeFileSync(replacementSentinel, 'must-not-delete');
        injected = true;
        const error = new Error('fixture replacement during first full freeze');
        error.code = 'EIO';
        throw error;
      }
      return originalRealpathSync.call(this, filePath, options);
    };
    let caught;
    try {
      await runSingleCreationProbe({
        harness,
        plan,
        stagingDirectory,
        batch,
        runtime: { async execute() { workerCalls += 1; } },
        publishPublication: async () => { publisherCalls += 1; }
      });
    } catch (error) {
      caught = error;
    } finally {
      fs.realpathSync = originalRealpathSync;
    }
    assert.equal(injected, true);
    assert.ok(caught);
    assert.equal(caught.code, 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
    assert.equal(caught.preserveTemporaryFiles, true);
    assert.deepEqual(caught.recoveryPaths, [taskRoot]);
    assert.match(caught.detailLines.join('\n'), /identityCauseCode=EIO/);
    assert.match(caught.detailLines.join('\n'), /VCC_EXPORT_STAGING_IDENTITY_CHANGED/);
    assert.equal(fs.readFileSync(replacementSentinel, 'utf8'), 'must-not-delete');
    assert.equal(fs.existsSync(originalTaskRoot), true);
    assert.equal(workerCalls, 0);
    assert.equal(publisherCalls, 0);
    await assert.rejects(runSingleCreationProbe({
      harness,
      plan,
      stagingDirectory,
      batch,
      runtime: { async execute() { workerCalls += 1; } },
      publishPublication: async () => { publisherCalls += 1; }
    }), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
    assert.equal(workerCalls, 0);

    // recoveryPaths 要求人工确认 lexical replacement 与原 inode 的去向；这里显式
    // 模拟 operator 恢复原目录，自动 owner 从未重新获取 replacement authority。
    fs.rmSync(taskRoot, { recursive: true, force: true });
    fs.renameSync(originalTaskRoot, taskRoot);
    fs.rmdirSync(taskRoot);
    await assert.rejects(runSingleCreationProbe({
      harness,
      plan,
      stagingDirectory,
      batch,
      runtime: {
        async execute() {
          workerCalls += 1;
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'VCC_FIXTURE_RETRY_EXECUTED',
              message: 'fixture retry reached Writer after manual recovery',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      publishPublication: async () => { publisherCalls += 1; }
    }), (error) => error.code === 'VCC_FIXTURE_RETRY_EXECUTED');
    assert.equal(workerCalls, 1);
    assert.equal(publisherCalls, 0);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  });

  await t.test('post-mkdir full freeze 持续 EACCES 时保留有界人工恢复证据且不静默永久 collision', async () => {
    const harness = setup(t, ['PPHK']);
    const stagingDirectory = path.join(harness.root, 'post-create-persistent-eacces');
    fs.mkdirSync(stagingDirectory);
    const plan = filePlan(harness.root, 1, 'post-create-persistent-eacces');
    const batch = batchContext('post-create-persistent-eacces');
    const originalRealpathSync = fs.realpathSync;
    let taskRoot = null;
    let workerCalls = 0;
    let publisherCalls = 0;
    fs.realpathSync = function patchedRealpathSync(filePath, options) {
      const candidate = path.resolve(String(filePath));
      if (path.dirname(candidate) === stagingDirectory &&
          path.basename(candidate).startsWith('vcc-export-') && fs.existsSync(candidate)) {
        taskRoot = candidate;
        const error = new Error('fixture persistent post-create EACCES');
        error.code = 'EACCES';
        throw error;
      }
      return originalRealpathSync.call(this, filePath, options);
    };
    let caught;
    try {
      await runSingleCreationProbe({
        harness,
        plan,
        stagingDirectory,
        batch,
        runtime: { async execute() { workerCalls += 1; } },
        publishPublication: async () => { publisherCalls += 1; }
      });
    } catch (error) {
      caught = error;
    } finally {
      fs.realpathSync = originalRealpathSync;
    }
    assert.ok(caught);
    assert.equal(caught.code, 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
    assert.equal(caught.preserveTemporaryFiles, true);
    assert.deepEqual(caught.recoveryPaths, [taskRoot]);
    assert.ok(caught.recoveryPaths.length <= 100);
    assert.match(caught.detailLines.join('\n'), /identityCauseCode=EACCES/);
    assert.equal(fs.existsSync(taskRoot), true);
    assert.equal(workerCalls, 0);
    assert.equal(publisherCalls, 0);
    await assert.rejects(runSingleCreationProbe({
      harness,
      plan,
      stagingDirectory,
      batch,
      runtime: { async execute() { workerCalls += 1; } },
      publishPublication: async () => { publisherCalls += 1; }
    }), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
    assert.equal(workerCalls, 0);

    // 自动 owner 没有 deletion authority；operator 按 recoveryPaths 确认空目录后
    // 显式收口。恢复完成后 deterministic retry 不再永久 collision。
    fs.rmdirSync(taskRoot);
    await assert.rejects(runSingleCreationProbe({
      harness,
      plan,
      stagingDirectory,
      batch,
      runtime: {
        async execute() {
          workerCalls += 1;
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'VCC_FIXTURE_RETRY_EXECUTED',
              message: 'fixture retry reached Writer after EACCES recovery',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      publishPublication: async () => { publisherCalls += 1; }
    }), (error) => error.code === 'VCC_FIXTURE_RETRY_EXECUTED');
    assert.equal(workerCalls, 1);
    assert.equal(publisherCalls, 0);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  });

  await t.test('post-create identity failure 的 task-dir rmdir 失败返回有界证据且可恢复', () => {
    const harness = setup(t, ['PPHK']);
    const stagingDirectory = path.join(harness.root, 'post-create-identity-rmdir');
    fs.mkdirSync(stagingDirectory);
    const plan = filePlan(harness.root, 1, 'post-create-identity-rmdir');
    const batch = batchContext('post-create-identity-rmdir');
    const task = Object.freeze({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    });
    const create = () => createGenerationInput({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      authority: harness.snapshot.authority,
      filePlan: plan,
      operationKey: batch.operationKey,
      selectedSubjectIndexes: [0],
      stagingDirectory,
      taskAuthority: task
    });
    const originalRealpathSync = fs.realpathSync;
    const originalRmdirSync = fs.rmdirSync;
    let taskRoot = null;
    let injected = false;
    fs.realpathSync = function patchedRealpathSync(filePath, options) {
      const candidate = path.resolve(String(filePath));
      if (!injected && path.dirname(candidate) === stagingDirectory &&
          path.basename(candidate).startsWith('vcc-export-') && fs.existsSync(candidate)) {
        taskRoot = candidate;
        injected = true;
        const error = new Error('fixture post-create identity probe EIO');
        error.code = 'EIO';
        throw error;
      }
      return originalRealpathSync.call(this, filePath, options);
    };
    fs.rmdirSync = function patchedRmdirSync(directory) {
      if (taskRoot && path.resolve(String(directory)) === taskRoot) {
        const error = new Error('fixture post-create rmdir EPERM');
        error.code = 'EPERM';
        throw error;
      }
      return originalRmdirSync.call(this, directory);
    };
    let caught;
    try {
      create();
    } catch (error) {
      caught = error;
    } finally {
      fs.realpathSync = originalRealpathSync;
      fs.rmdirSync = originalRmdirSync;
    }
    assert.ok(caught);
    assert.equal(caught.code, 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
    assert.equal(caught.preserveTemporaryFiles, true);
    assert.deepEqual(caught.recoveryPaths, [taskRoot]);
    assert.ok(caught.recoveryPaths.length <= 100);
    assert.throws(() => create(), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
    const identity = createTaskStagingIdentity({
      resolvedPath: taskRoot,
      realPath: fs.realpathSync(taskRoot)
    });
    assert.equal(cleanupGenerationArtifacts(
      [],
      new Error('post-create rmdir recovery owner'),
      taskRoot,
      identity.realPath,
      identity
    ).status, 'complete');
    const retry = create();
    assert.equal(cleanupGenerationArtifacts(
      retry.generations,
      new Error('post-create rmdir retry cleanup'),
      retry.stagingRoot,
      retry.stagingRootReal,
      retry.stagingIdentity
    ).status, 'complete');
  });

  for (const failDelete of [false, true]) {
    await t.test(
      failDelete
        ? 'post-create generation collision 删除失败返回有界恢复证据并阻断重试'
        : 'post-create generation collision 删除成功不遗留 task dir',
      () => {
        const harness = setup(t, ['PPHK']);
        const suffix = failDelete ? 'post-create-collision-ebusy' : 'post-create-collision-clean';
        const stagingDirectory = path.join(harness.root, suffix);
        fs.mkdirSync(stagingDirectory);
        const plan = filePlan(harness.root, 1, suffix);
        const batch = batchContext(suffix);
        const task = Object.freeze({
          action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
        });
        const create = () => createGenerationInput({
          actionKey: VCC_EXPORT_SINGLE_ACTION,
          authority: harness.snapshot.authority,
          filePlan: plan,
          operationKey: batch.operationKey,
          selectedSubjectIndexes: [0],
          stagingDirectory,
          taskAuthority: task
        });
        const originalExistsSync = fs.existsSync;
        const originalRmSync = fs.rmSync;
        let injectedPath = null;
        fs.existsSync = function patchedExistsSync(filePath) {
          const candidate = path.resolve(String(filePath));
          if (!injectedPath && candidate.endsWith('.xlsx') &&
              candidate.startsWith(`${stagingDirectory}${path.sep}vcc-export-`) &&
              originalExistsSync.call(this, path.dirname(candidate))) {
            fs.writeFileSync(candidate, 'post-create-collision');
            injectedPath = candidate;
            return true;
          }
          return originalExistsSync.call(this, filePath);
        };
        fs.rmSync = function patchedRmSync(filePath, options) {
          if (failDelete && injectedPath && path.resolve(String(filePath)) === injectedPath) {
            const error = new Error('fixture post-create cleanup EBUSY');
            error.code = 'EBUSY';
            throw error;
          }
          return originalRmSync.call(this, filePath, options);
        };
        let caught;
        try {
          create();
        } catch (error) {
          caught = error;
        } finally {
          fs.existsSync = originalExistsSync;
          fs.rmSync = originalRmSync;
        }
        assert.ok(caught);
        assert.equal(caught.code, 'VCC_EXPORT_STAGING_COLLISION');
        assert.ok(injectedPath);
        if (!failDelete) {
          assert.deepEqual(fs.readdirSync(stagingDirectory), []);
          assert.equal(caught.preserveTemporaryFiles, undefined);
          return;
        }
        assert.equal(caught.preserveTemporaryFiles, true);
        assert.deepEqual(caught.recoveryPaths, [injectedPath]);
        assert.ok(caught.recoveryPaths.length <= 100);
        assert.throws(() => create(), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
        const taskRoot = path.dirname(injectedPath);
        const identity = createTaskStagingIdentity({
          resolvedPath: taskRoot,
          realPath: fs.realpathSync(taskRoot)
        });
        assert.equal(cleanupGenerationArtifacts(
          [{
            subjectIndex: 0,
            outputArtifactKey: `output-${'e'.repeat(64)}`,
            generationPath: injectedPath
          }],
          new Error('post-create collision recovery owner'),
          taskRoot,
          identity.realPath,
          identity
        ).status, 'complete');
        const retry = create();
        assert.equal(cleanupGenerationArtifacts(
          retry.generations,
          new Error('post-create collision retry cleanup'),
          retry.stagingRoot,
          retry.stagingRootReal,
          retry.stagingIdentity
        ).status, 'complete');
      }
    );
  }
});

test('cleanup 在 scan/delete/rmdir 前复核 frozen root/parent dev+ino，同路径 replacement 零触碰', async (t) => {
  const createFixture = (label) => {
    const harness = setup(t, ['PPHK']);
    const parent = path.join(harness.root, `cleanup-identity-${label}`);
    fs.mkdirSync(parent);
    const taskRoot = path.join(parent, `vcc-export-${'a'.repeat(32)}`);
    fs.mkdirSync(taskRoot);
    const generationPath = path.join(taskRoot, '000-fixture.xlsx');
    fs.writeFileSync(generationPath, 'original-generation');
    const identity = createTaskStagingIdentity({
      resolvedPath: taskRoot,
      realPath: fs.realpathSync(taskRoot)
    });
    const generations = [{
      subjectIndex: 0,
      outputArtifactKey: `output-${'f'.repeat(64)}`,
      generationPath
    }];
    return { harness, parent, taskRoot, generationPath, identity, generations };
  };
  const runCleanup = (fixture) => cleanupGenerationArtifacts(
    fixture.generations,
    new Error('replacement cleanup evidence'),
    fixture.taskRoot,
    fixture.identity.realPath,
    fixture.identity
  );
  const assertPendingIdentity = (fixture, evidence) => {
    assert.equal(evidence.status, 'pending');
    assert.equal(evidence.taskRootIdentityDigest, fixture.identity.identityDigest);
    assert.deepEqual(evidence.recoveryPaths, []);
    assert.ok(evidence.diagnosticCodes.includes('VCC_EXPORT_STAGING_IDENTITY_CHANGED'));
  };

  await t.test('scan 后 delete 前替换为同路径真实目录，不删除 replacement generation', () => {
    const fixture = createFixture('before-delete');
    const backup = `${fixture.taskRoot}.original`;
    const originalReaddirSync = fs.readdirSync;
    let replaced = false;
    fs.readdirSync = function patchedReaddirSync(directory, options) {
      const entries = originalReaddirSync.call(this, directory, options);
      if (!replaced && path.resolve(String(directory)) === fixture.taskRoot) {
        fs.renameSync(fixture.taskRoot, backup);
        fs.mkdirSync(fixture.taskRoot);
        fs.writeFileSync(fixture.generationPath, 'replacement-generation');
        replaced = true;
      }
      return entries;
    };
    let evidence;
    try {
      evidence = runCleanup(fixture);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    assert.equal(replaced, true);
    assertPendingIdentity(fixture, evidence);
    assert.equal(fs.readFileSync(fixture.generationPath, 'utf8'), 'replacement-generation');
    fs.rmSync(fixture.taskRoot, { recursive: true, force: true });
    fs.renameSync(backup, fixture.taskRoot);
    assert.equal(runCleanup(fixture).status, 'complete');
  });

  await t.test('scan 后 parent 换 inode但保留原 task inode，不删除 generation', () => {
    const fixture = createFixture('parent-before-delete');
    const parentBackup = `${fixture.parent}.original`;
    const taskName = path.basename(fixture.taskRoot);
    const originalReaddirSync = fs.readdirSync;
    let replaced = false;
    fs.readdirSync = function patchedReaddirSync(directory, options) {
      const entries = originalReaddirSync.call(this, directory, options);
      if (!replaced && path.resolve(String(directory)) === fixture.taskRoot) {
        fs.renameSync(fixture.parent, parentBackup);
        fs.mkdirSync(fixture.parent);
        fs.renameSync(path.join(parentBackup, taskName), fixture.taskRoot);
        replaced = true;
      }
      return entries;
    };
    let evidence;
    try {
      evidence = runCleanup(fixture);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    assert.equal(replaced, true);
    assertPendingIdentity(fixture, evidence);
    assert.equal(fs.readFileSync(fixture.generationPath, 'utf8'), 'original-generation');
    fs.renameSync(fixture.taskRoot, path.join(parentBackup, taskName));
    fs.rmdirSync(fixture.parent);
    fs.renameSync(parentBackup, fixture.parent);
    assert.equal(runCleanup(fixture).status, 'complete');
  });

  await t.test('delete 后 rmdir 前替换为同路径真实目录，不删除 replacement task dir', () => {
    const fixture = createFixture('before-rmdir');
    const backup = `${fixture.taskRoot}.original`;
    const sentinel = path.join(fixture.taskRoot, 'replacement.keep');
    const originalRmSync = fs.rmSync;
    let replaced = false;
    fs.rmSync = function patchedRmSync(filePath, options) {
      const result = originalRmSync.call(this, filePath, options);
      if (!replaced && path.resolve(String(filePath)) === fixture.generationPath) {
        fs.renameSync(fixture.taskRoot, backup);
        fs.mkdirSync(fixture.taskRoot);
        fs.writeFileSync(sentinel, 'replacement-task-root');
        replaced = true;
      }
      return result;
    };
    let evidence;
    try {
      evidence = runCleanup(fixture);
    } finally {
      fs.rmSync = originalRmSync;
    }
    assert.equal(replaced, true);
    assertPendingIdentity(fixture, evidence);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'replacement-task-root');
    fs.rmSync(fixture.taskRoot, { recursive: true, force: true });
    fs.renameSync(backup, fixture.taskRoot);
    assert.equal(runCleanup(fixture).status, 'complete');
  });
});

test('runtime 后 exact task dir 被换成 reparse 时 cleanup fail closed 且不删除外部同名文件', async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'staging-reparse-race');
  const outsideDirectory = path.join(harness.root, 'outside-reparse-race');
  fs.mkdirSync(stagingDirectory);
  fs.mkdirSync(outsideDirectory);
  const plan = filePlan(harness.root, 1, 'staging-reparse-race');
  const batch = batchContext('staging-reparse-race');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  let outsideGenerationPath = null;
  let publisherCalls = 0;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: {
        async execute(request) {
          const generationPath = request.input.generations[0].generationPath;
          const taskDirectory = path.dirname(generationPath);
          outsideGenerationPath = path.join(outsideDirectory, path.basename(generationPath));
          fs.writeFileSync(outsideGenerationPath, 'external-evidence');
          fs.rmdirSync(taskDirectory);
          fs.symlinkSync(outsideDirectory, taskDirectory, directoryLinkType);
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'VCC_FIXTURE_PRIMARY_FAILURE',
              message: 'fixture primary failure before cleanup',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      selectedSubjectIndexes: [0],
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async () => { publisherCalls += 1; }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'VCC_FIXTURE_PRIMARY_FAILURE');
  assert.equal(caught.message, 'fixture primary failure before cleanup');
  assert.match(caught.detailLines.join('\n'), /VCC_EXPORT_STAGING_IDENTITY_CHANGED/);
  assert.equal(caught.preserveTemporaryFiles, undefined);
  assert.equal(fs.readFileSync(outsideGenerationPath, 'utf8'), 'external-evidence');
  assert.equal(publisherCalls, 0);
});

test('Main create 后 Worker 开始前 task-root replacement fail closed、Publisher=0 且不触碰外部文件', async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'identity-before-worker');
  const outsideDirectory = path.join(harness.root, 'identity-before-worker-outside');
  fs.mkdirSync(stagingDirectory);
  fs.mkdirSync(outsideDirectory);
  const plan = filePlan(harness.root, 1, 'identity-before-worker');
  const batch = batchContext('identity-before-worker');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  let capturedInput = null;
  let taskBackup = null;
  let outsideGenerationPath = null;
  let publisherCalls = 0;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: {
        async execute(request) {
          capturedInput = request.input;
          const taskRoot = request.input.stagingIdentity.resolvedPath;
          taskBackup = `${taskRoot}.original`;
          fs.renameSync(taskRoot, taskBackup);
          fs.symlinkSync(outsideDirectory, taskRoot, directoryLinkType);
          outsideGenerationPath = path.join(
            outsideDirectory,
            path.basename(request.input.generations[0].generationPath)
          );
          fs.writeFileSync(outsideGenerationPath, 'outside-must-survive');
          try {
            const result = await executeVccExportWriter({
              ...request.input,
              databasePath: harness.dbPath,
              assetsDir: ASSETS_DIR
            }, null, VCC_EXPORT_SINGLE_ACTION);
            return { outcome: 'completed', terminalSource: 'job:done', result };
          } catch (error) {
            return {
              outcome: 'failed',
              terminalSource: 'job:error',
              error: toProtocolError(error)
            };
          }
        }
      },
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      selectedSubjectIndexes: [0],
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async () => { publisherCalls += 1; }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
  assert.equal(caught.stage, 'worker-entry');
  assert.match(
    caught.detailLines.join('\n'),
    new RegExp(identityDigestEvidence(capturedInput.stagingIdentity.identityDigest))
  );
  assert.equal(fs.readFileSync(outsideGenerationPath, 'utf8'), 'outside-must-survive');
  assert.equal(fs.existsSync(plan.outputs[0].filePath), false);
  assert.equal(publisherCalls, 0);

  fs.unlinkSync(capturedInput.stagingIdentity.resolvedPath);
  fs.renameSync(taskBackup, capturedInput.stagingIdentity.resolvedPath);
  const recovered = cleanupGenerationArtifacts(
    capturedInput.generations,
    new Error('identity recovery owner'),
    capturedInput.stagingIdentity.resolvedPath,
    capturedInput.stagingIdentity.realPath,
    capturedInput.stagingIdentity
  );
  assert.equal(recovered.status, 'complete');
});

test('atomic handoff 前 task-root replacement fail closed、Publisher=0 且不删除外部同名 tmp', async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'identity-before-finalize');
  const outsideDirectory = path.join(harness.root, 'identity-before-finalize-outside');
  fs.mkdirSync(stagingDirectory);
  fs.mkdirSync(outsideDirectory);
  const plan = filePlan(harness.root, 1, 'identity-before-finalize');
  const batch = batchContext('identity-before-finalize');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  let capturedInput = null;
  let taskBackup = null;
  let outsideAtomicPath = null;
  let replaced = false;
  let publisherCalls = 0;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: {
        async execute(request) {
          capturedInput = request.input;
          const taskRoot = request.input.stagingIdentity.resolvedPath;
          const parentRoot = request.input.stagingIdentity.parentResolvedPath;
          const originalRealpathSync = fs.realpathSync;
          fs.realpathSync = function patchedRealpathSync(filePath, options) {
            if (!replaced && path.resolve(String(filePath)) === parentRoot &&
                fs.existsSync(taskRoot) && !fs.lstatSync(taskRoot).isSymbolicLink()) {
              const atomicName = fs.readdirSync(taskRoot).find((name) => (
                /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name)
              ));
              if (atomicName) {
                taskBackup = `${taskRoot}.original`;
                fs.renameSync(taskRoot, taskBackup);
                fs.symlinkSync(outsideDirectory, taskRoot, directoryLinkType);
                outsideAtomicPath = path.join(outsideDirectory, atomicName);
                fs.writeFileSync(outsideAtomicPath, 'outside-atomic-must-survive');
                replaced = true;
              }
            }
            return originalRealpathSync.call(this, filePath, options);
          };
          try {
            const result = await executeVccExportWriter({
              ...request.input,
              databasePath: harness.dbPath,
              assetsDir: ASSETS_DIR
            }, null, VCC_EXPORT_SINGLE_ACTION);
            return { outcome: 'completed', terminalSource: 'job:done', result };
          } catch (error) {
            return {
              outcome: 'failed',
              terminalSource: 'job:error',
              error: toProtocolError(error)
            };
          } finally {
            fs.realpathSync = originalRealpathSync;
          }
        }
      },
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      selectedSubjectIndexes: [0],
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async () => { publisherCalls += 1; }
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(replaced, true);
  assert.ok(caught);
  assert.equal(caught.code, 'VCC_EXPORT_STAGING_IDENTITY_CHANGED');
  assert.match(caught.stage, /before-atomic-handoff$/);
  assert.match(
    caught.detailLines.join('\n'),
    new RegExp(identityDigestEvidence(capturedInput.stagingIdentity.identityDigest))
  );
  assert.equal(fs.readFileSync(outsideAtomicPath, 'utf8'), 'outside-atomic-must-survive');
  assert.equal(
    fs.readdirSync(taskBackup).some((name) => name.endsWith('.tmp')),
    true,
    '原 task root 中的真实 staged evidence 必须保留'
  );
  assert.equal(fs.existsSync(plan.outputs[0].filePath), false);
  assert.equal(publisherCalls, 0);

  fs.unlinkSync(capturedInput.stagingIdentity.resolvedPath);
  fs.renameSync(taskBackup, capturedInput.stagingIdentity.resolvedPath);
  const recovered = cleanupGenerationArtifacts(
    capturedInput.generations,
    new Error('identity recovery owner'),
    capturedInput.stagingIdentity.resolvedPath,
    capturedInput.stagingIdentity.realPath,
    capturedInput.stagingIdentity
  );
  assert.equal(recovered.status, 'complete');
});

test('冻结 task-root identity 支持普通 Windows-compatible Unicode/space 路径且成功零残留', async (t) => {
  const harness = setup(t, ['PPHK']);
  const stagingDirectory = path.join(harness.root, 'Windows compatible 路径 01');
  fs.mkdirSync(stagingDirectory);
  const plan = filePlan(harness.root, 1, 'windows-compatible-identity');
  const batch = batchContext('windows-compatible-identity');
  const result = await generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    runtime: harness.runtime,
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    selectedSubjectIndexes: [0],
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async (payload) => Object.freeze({
      taskId: payload.taskId,
      committed: true
    }),
    settleManifestArtifacts: async () => {}
  });
  assert.equal(result.publication.generationCleanup.status, 'complete');
  assert.equal(result.publication.generationCleanup.preserveTemporaryFiles, false);
  assert.deepEqual(result.publication.generationCleanup.recoveryPaths, []);
  assert.deepEqual(fs.readdirSync(stagingDirectory), []);
});

test('普通 pre-Publisher cleanup 部分失败只上报 exact task-private 已知残留并阻断碰撞重试', async (t) => {
  const harness = setup(t);
  const stagingDirectory = path.join(harness.root, 'ordinary-cleanup-residual');
  fs.mkdirSync(stagingDirectory);
  const plan = filePlan(harness.root, 2, 'ordinary-cleanup-residual');
  const batch = batchContext('subjects');
  const originalRmSync = fs.rmSync;
  let generationPaths = [];
  let taskStagingDirectory = null;
  let publisherCalls = 0;
  let workerCalls = 0;
  let caught = null;
  fs.rmSync = function patchedRmSync(filePath, options) {
    if (generationPaths[1] && path.resolve(filePath) === generationPaths[1]) {
      const error = new Error('fixture busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRmSync.call(this, filePath, options);
  };
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SUBJECTS_ACTION,
      runtime: {
        async execute(request) {
          workerCalls += 1;
          generationPaths = request.input.generations.map((item) => path.resolve(item.generationPath));
          taskStagingDirectory = path.dirname(generationPaths[0]);
          generationPaths.forEach((filePath) => fs.writeFileSync(filePath, 'partial'));
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'VCC_FIXTURE_ORDINARY_FAILURE',
              message: 'fixture ordinary first error',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      expectedAuthority: harness.snapshot.authority,
      readCurrentSnapshot: async () => harness.snapshot,
      readCurrentTaskAuthority: async () => ({
        action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
      }),
      filePlan: plan,
      stagingDirectory,
      assetsDir: ASSETS_DIR,
      batchContext: batch,
      publishPublication: async () => { publisherCalls += 1; }
    });
  } catch (error) {
    caught = error;
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'VCC_FIXTURE_ORDINARY_FAILURE');
  assert.equal(caught.message, 'fixture ordinary first error');
  assert.equal(caught.preserveTemporaryFiles, true);
  assert.deepEqual(caught.recoveryPaths, [generationPaths[1]]);
  assert.equal(path.dirname(caught.recoveryPaths[0]), taskStagingDirectory);
  assert.notEqual(taskStagingDirectory, stagingDirectory);
  assert.equal(new Set(caught.recoveryPaths).size, caught.recoveryPaths.length);
  assert.match(caught.detailLines.join('\n'), /EBUSY/);
  assert.equal(fs.existsSync(generationPaths[0]), false);
  assert.equal(fs.existsSync(generationPaths[1]), true);
  assert.equal(publisherCalls, 0);

  let retryWorkerCalls = 0;
  await assert.rejects(generateValidateAndPublishVccExport({
    actionKey: VCC_EXPORT_SUBJECTS_ACTION,
    runtime: { async execute() { retryWorkerCalls += 1; } },
    expectedAuthority: harness.snapshot.authority,
    readCurrentSnapshot: async () => harness.snapshot,
    readCurrentTaskAuthority: async () => ({
      action: 'export-result', taskGeneration: 0, taskRunId: batch.taskRunId
    }),
    filePlan: plan,
    stagingDirectory,
    assetsDir: ASSETS_DIR,
    batchContext: batch,
    publishPublication: async () => { publisherCalls += 1; }
  }), (error) => error.code === 'VCC_EXPORT_STAGING_COLLISION');
  assert.equal(retryWorkerCalls, 0);
  assert.equal(workerCalls, 1);
  assert.equal(publisherCalls, 0);
});

test('runtime 拒绝 DB/assets caller override，完成后 shutdown 无 transport/lease 残留', async (t) => {
  const harness = setup(t, ['PPHK']);
  const request = {
    actionKey: VCC_EXPORT_SINGLE_ACTION,
    operationKey: 'override-operation',
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'override-task',
        taskKey: 'vccFinancialOp:export:result',
        moduleId: 'vcc-financial-op',
        parentRunId: 'override-parent',
        operationKey: 'override-operation'
      }
    },
    input: { databasePath: '/tmp/forbidden', assetsDir: ASSETS_DIR }
  };
  await assert.rejects(
    harness.runtime.execute(request),
    (error) => error.code === 'VCC_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN'
  );
  const report = await harness.runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
});
