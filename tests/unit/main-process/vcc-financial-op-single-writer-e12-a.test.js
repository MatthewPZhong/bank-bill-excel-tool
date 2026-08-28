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
  pendingSheetProjection
} = require('../../../src/main-process/vcc-financial-op-output/artifact-evidence');
const {
  writeRunWorkbooks
} = require('../../../src/main-process/vcc-financial-op-writer');
const {
  assertXlsxOutputPath
} = require('../../../src/main-process/vcc-financial-op-output-publication');

const ASSETS_DIR = path.resolve(__dirname, '../../../assets');

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

async function rewriteWorksheetXml(filePath, rewrite) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const worksheetEntry = zip.file('xl/worksheets/sheet1.xml');
  assert.ok(worksheetEntry);
  const worksheetXml = await worksheetEntry.async('string');
  const rewritten = rewrite(worksheetXml);
  assert.notEqual(rewritten, worksheetXml);
  zip.file('xl/worksheets/sheet1.xml', rewritten);
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
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

test('E12-A 两 action canonical policy byte-for-byte、production false 且 validator 隔离', () => {
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(VCC_EXPORT_SINGLE_POLICY, fixture[VCC_EXPORT_SINGLE_ACTION]);
  assert.deepEqual(VCC_EXPORT_SUBJECTS_POLICY, fixture[VCC_EXPORT_SUBJECTS_ACTION]);
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
      generations: generation.generations
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

test('raw XLSX XML 自洽篡改语义矩阵样式/行列布局仍由 canonical Result validator 阻断', async (t) => {
  const harness = setup(t, ['PPHK']);
  const tamperCases = [
    ['C1 header style', (filePath) => rewriteCellStyleId(filePath, 'C1')],
    ['A2 subject merge master style', (filePath) => rewriteCellStyleId(filePath, 'A2')],
    ['C3 ordinary classification style', (filePath) => rewriteCellStyleId(filePath, 'C3')],
    ['M3 ordinary blank style', (filePath) => injectBlankCellStyle(filePath, 'M3')],
    ['N3 ordinary blank style', (filePath) => injectBlankCellStyle(filePath, 'N3')],
    ['row 3 hidden', (filePath) => rewriteRowHidden(filePath, 3)],
    ['column C hidden', (filePath) => rewriteColumnHidden(filePath, 3)]
  ];
  for (const [label, tamper] of tamperCases) {
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
      }), /样式|布局|校验失败/);
      assert.equal(publisherCalls, 0);
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
  let generationPath = null;
  let atomicTempPath = null;
  let caught = null;
  try {
    await generateValidateAndPublishVccExport({
      actionKey: VCC_EXPORT_SINGLE_ACTION,
      runtime: {
        async execute(request) {
          generations = request.input.generations;
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
  cleanupGenerationArtifacts(generations, recoveryCleanupError, taskStagingDirectory);
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
  assert.match(caught.detailLines.join('\n'), /VCC_EXPORT_STAGING_ESCAPE/);
  assert.equal(caught.preserveTemporaryFiles, undefined);
  assert.equal(fs.readFileSync(outsideGenerationPath, 'utf8'), 'external-evidence');
  assert.equal(publisherCalls, 0);
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
