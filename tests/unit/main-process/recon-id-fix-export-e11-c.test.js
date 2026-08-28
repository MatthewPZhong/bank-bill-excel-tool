'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const XLSXStyle = require('xlsx-js-style');

const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS,
  ORDER_REPAIR_SHEET_NAME,
  RECON_RESULT_FIELDS,
  RECON_RESULT_SHEET_NAME
} = require('../../../src/constants/recon-id-fix-fields');
const {
  CHANNEL_BILL_FIELDS,
  CHANNEL_BILL_SHEET_NAME,
  GATEWAY_BILL_FIELDS,
  GATEWAY_BILL_SHEET_NAME,
  ORDER_REPAIR_FIELDS_GATEWAY,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../../../src/constants/gateway-bill-recon-fields');
const {
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  createBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const {
  createToolboxPublicationDispatcher
} = require('../../../src/main-process/toolbox-output-publication-dispatch');
const {
  createReconFixExportInput,
  generateValidateAndPublishReconFixExport
} = require('../../../src/main-process/recon-id-fix-service/export-operation');
const {
  readReconFixArtifactEvidence
} = require('../../../src/main-process/recon-id-fix-service/artifact-evidence');
const {
  RECON_FIX_EVIDENCE_WRITER_KINDS
} = require('../../../src/main-process/recon-id-fix-service/evidence-settlement-admission');
const {
  RECON_FIX_EXPORT_ACTION,
  RECON_FIX_EXPORT_POLICY,
  RECON_FIX_IMPORT_ACTION,
  RECON_FIX_RUN_READONLY_ACTION,
  validateReconFixExportResult
} = require('../../../src/main-process/recon-id-fix-service/policies');

const CRASH_RECOVER_PUBLISHER = path.join(
  __dirname,
  '__fixtures__',
  'toolbox-publication-stub-crash-recover.js'
);

const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(label = 'recon-export-e11-c-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function appendSheet(workbook, name, fields, rows = []) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    fields.slice(),
    ...rows.map((row) => fields.map((field) => row[field] ?? ''))
  ]), name);
}

function writeStandardWorkbook(filePath, outputSet = 'main+unmatched') {
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, RECON_RESULT_SHEET_NAME, RECON_RESULT_FIELDS);
  const businessRows = [];
  if (outputSet !== 'unmatched-only') {
    businessRows.push({
      OrderId: 'MATCH-1', BillType: 'biz', BillDate: '2026-08-28', Amount: 100,
      Bank: '工行', Currency: 'CNY', reconId: ''
    });
  }
  if (outputSet !== 'main-only') {
    businessRows.push({
      OrderId: 'UNMATCHED-1', BillType: 'biz', BillDate: '2026-08-28', Amount: 200,
      Bank: '工行', Currency: 'CNY', reconId: ''
    });
  }
  appendSheet(workbook, BUSINESS_BILL_SHEET_NAME, BUSINESS_BILL_FIELDS, businessRows);
  appendSheet(
    workbook,
    OPPONENT_BILL_SHEET_NAME,
    OPPONENT_BILL_FIELDS,
    outputSet === 'unmatched-only' ? [] : [{
      OrderId: 'MATCH-1', BillType: 'biz', BillDate: '2026-08-28', Amount: 100,
      Bank: '工行', Currency: 'CNY', reconId: 'RID-MATCH-1'
    }]
  );
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME, ORDER_REPAIR_FIELDS);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function standardScenario() {
  return {
    id: 311,
    category: 'recon-id-fix',
    name: 'E11-C standard',
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
      ],
      reconGroups: [{
        leftTypeSeq: 1,
        rightTypeSeq: 2,
        fieldPairs: [{ leftField: 'Amount', rightField: 'Amount', locked: true }]
      }],
      output: { mode: 'main', subBizType: { mode: 'manualMain', mainValue: 'E11-C' } }
    }
  };
}

function writeGatewayWorkbook(filePath) {
  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, RECON_RESULT_SHEET_NAME_GATEWAY, RECON_RESULT_FIELDS_GATEWAY);
  appendSheet(workbook, GATEWAY_BILL_SHEET_NAME, GATEWAY_BILL_FIELDS, [{
    BillDate: '2026-06-10', Bank: 'BOC', MerchantId: 'M1', OrderId: 'ALC-1',
    DataSource: 'DS', OppBu: 'OB', OriginBillSource: 'OBS', BillType: 'BT',
    Currency: 'USD', Amount: 999, OriginBillBizId: 'OBI', ReconBillBizId: 'RBI'
  }]);
  appendSheet(workbook, CHANNEL_BILL_SHEET_NAME, CHANNEL_BILL_FIELDS, [{
    channelName: 'BOC', reconciliationId: 'RID-A'
  }]);
  appendSheet(workbook, ORDER_REPAIR_SHEET_NAME_GATEWAY, ORDER_REPAIR_FIELDS_GATEWAY);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function createBocDatabase(dbPath, amount = 15000) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE linked_boc_fx_settlement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_no TEXT,
      group_no TEXT,
      allocation_no TEXT,
      recon_link_id TEXT,
      maturity_date TEXT,
      source_row INTEGER,
      orig_group_no TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    )
  `);
  const raw = {
    '交易编号': 'TXN-1', '货币1金额': amount, '货币2金额': '', '到期日': '2026-06-10',
    '分组': '1', '调拨单号': 'ALC-1', '资金对账不平表链接ID': 'RID-A'
  };
  db.prepare(`
    INSERT INTO linked_boc_fx_settlement
      (transaction_no, group_no, allocation_no, recon_link_id, maturity_date,
       source_row, orig_group_no, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('TXN-1', '1', 'ALC-1', 'RID-A', '2026-06-10', 1, '1', JSON.stringify(raw), new Date().toISOString());
  db.close();
  return dbPath;
}

function bocScenario() {
  return {
    id: 312,
    category: 'gateway-recon-id-fix',
    name: 'BOC调拨订单修复 E11-C',
    priority: 0,
    enabled: false,
    config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' }
  };
}

function operationContext(operationKey) {
  return {
    kind: 'operation',
    value: {
      taskRunId: `task-${operationKey}`,
      taskKey: 'recon-id-fix:export',
      moduleId: 'recon-fix',
      parentRunId: 'parent-e11-c',
      operationKey
    }
  };
}

let nextBatchId = 1000;
function batchContext(operationKey) {
  nextBatchId += 1;
  return Object.freeze({
    batchId: nextBatchId,
    batchNumber: `2026-08-28-${nextBatchId}`,
    taskRunId: `task-${operationKey}`,
    taskKey: 'recon-id-fix:export',
    moduleId: 'recon-fix',
    parentRunId: 'parent-e11-c',
    operationKey
  });
}

function request(actionKey, operationKey, input) {
  return { actionKey, operationKey, context: operationContext(operationKey), input };
}

function planFor(root, outputCount) {
  const targetDir = path.join(root, 'targets');
  fs.mkdirSync(targetDir, { recursive: true });
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: Array.from({ length: outputCount }, (_unused, index) => ({
      filePath: path.join(targetDir, index === 0 ? 'result.xlsx' : 'result-未匹配.xlsx'),
      role: 'output',
      sourceOperation: 'recon-id-fix:export'
    }))
  });
}

function currentEvidence(result, patch = {}) {
  return {
    serviceGeneration: result.serviceGeneration,
    revision: result.revision,
    resultHandle: result.resultHandle,
    inputEvidenceHash: result.exportAuthority.inputEvidenceHash,
    scenarioSnapshotHash: result.scenarioSnapshotHash,
    linkedEvidenceHash: result.linkedEvidenceHash,
    ...patch
  };
}

function artifactBindingsFor(filePlan, result) {
  return result.exportAuthority.artifacts.map((artifact, index) => Object.freeze({
    artifactKind: artifact.artifactKind,
    outputArtifactKey: filePlan.outputs[index] && filePlan.outputs[index].artifactKey,
    targetPath: filePlan.outputs[index] && filePlan.outputs[index].filePath
  }));
}

async function setupStandard(options = {}) {
  const outputSet = options.outputSet || 'main+unmatched';
  const root = tempRoot();
  const workbookPath = writeStandardWorkbook(path.join(root, 'standard.xlsx'), outputSet);
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  const imported = await runtime.execute(request(RECON_FIX_IMPORT_ACTION, 'standard-import', {
    expectedRevision: 0,
    filePath: workbookPath,
    subMode: 'business'
  }));
  assert.equal(imported.outcome, 'completed', JSON.stringify(imported));
  const run = await runtime.execute(request(RECON_FIX_RUN_READONLY_ACTION, 'standard-run', {
    bocDatabasePath: null,
    expectedRevision: imported.result.revision,
    scenario: standardScenario()
  }));
  assert.equal(run.outcome, 'completed', JSON.stringify(run));
  assert.equal(run.result.summary.fixedRowCount, outputSet === 'unmatched-only' ? 0 : 1);
  assert.equal(run.result.summary.unmatchedRowCount, outputSet === 'main-only' ? 0 : 1);
  return { root, runtime, run: run.result, workbookPath };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function wrappedRuntime(runtime, mutate) {
  return Object.freeze({
    reconFixEvidenceSettlementAdmission: runtime.reconFixEvidenceSettlementAdmission,
    reserveServiceOperation(authority) {
      const reservation = runtime.reserveServiceOperation(authority);
      return Object.freeze({
        identity: reservation.identity,
        async execute(requestValue) {
          const execution = await reservation.execute(requestValue);
          if (execution.outcome !== 'completed') return execution;
          const cloned = structuredClone(execution);
          await mutate(cloned);
          return cloned;
        },
        release() {
          return reservation.release();
        }
      });
    }
  });
}

function observedRuntime(runtime, onExecute) {
  return Object.freeze({
    reconFixEvidenceSettlementAdmission: runtime.reconFixEvidenceSettlementAdmission,
    reserveServiceOperation(authority) {
      const reservation = runtime.reserveServiceOperation(authority);
      return Object.freeze({
        identity: reservation.identity,
        execute(requestValue) {
          onExecute(requestValue);
          return reservation.execute(requestValue);
        },
        release() {
          return reservation.release();
        }
      });
    }
  });
}

async function refreshArtifactTechnicalEvidence(execution, generationPath, index = 0) {
  const stat = fs.lstatSync(generationPath);
  execution.result.artifacts[index].byteSize = stat.size;
  execution.result.artifacts[index].sha256 = sha256(generationPath);
}

function replaceInlineStringCell(xml, address, value) {
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*)>[\\s\\S]*?<\\/c>`);
  const match = xml.match(cellPattern);
  assert.ok(match, `missing cell ${address}`);
  const attributes = match[1].replace(/\s+t="[^"]*"/g, '');
  return xml.replace(
    cellPattern,
    `<c${attributes} t="inlineStr"><is><t>${value}</t></is></c>`
  );
}

async function mutateFirstWorksheetXml(filePath, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const worksheetEntry = zip.file('xl/worksheets/sheet1.xml');
  assert.ok(worksheetEntry);
  const original = await worksheetEntry.async('string');
  zip.file('xl/worksheets/sheet1.xml', mutate(original));
  fs.writeFileSync(filePath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  }));
}

test('canonical export policy byte-for-byte、strict bounded manifest与production false', () => {
  const fixture = require('../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/policy-registry.v3.2.x.json').actions;
  assert.deepEqual(RECON_FIX_EXPORT_POLICY, fixture[RECON_FIX_EXPORT_ACTION]);
  assert.equal(isBackgroundExecutionProductionEnabled(RECON_FIX_EXPORT_ACTION), false);
  assert.equal(validateReconFixExportResult({}), false);
});

test('standard main+unmatched按FilePlan顺序回读并只调用一次Publisher', async () => {
  const harness = await setupStandard();
  let publisherCalls = 0;
  try {
    const filePlan = planFor(harness.root, 2);
    const stagingDirectory = path.join(harness.root, 'staging-success');
    fs.mkdirSync(stagingDirectory);
    const result = await generateValidateAndPublishReconFixExport({
      runtime: harness.runtime,
      evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
      result: harness.run,
      filePlan,
      artifactBindings: artifactBindingsFor(filePlan, harness.run),
      stagingDirectory,
      operationKey: 'standard-export',
      context: operationContext('standard-export'),
      batchContext: batchContext('standard-export'),
      readCurrentEvidence: async () => currentEvidence(harness.run),
      publishPublication: async (payload) => {
        publisherCalls += 1;
        assert.deepEqual(payload.artifacts.map((artifact) => artifact.outputId), [
          'recon-fix-main', 'recon-fix-unmatched'
        ]);
        assert.equal(payload.artifacts.length, payload.targets.length);
        return { committed: true, files: payload.targets.map((target) => target.targetPath) };
      }
    });
    assert.equal(publisherCalls, 1);
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.artifacts.every((artifact) => fs.lstatSync(artifact.generationPath).isFile()), true);
  } finally {
    await harness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('standard真实数据驱动覆盖main-only/unmatched-only/main+unmatched output-set', async () => {
  const cases = [
    ['main-only', ['main']],
    ['unmatched-only', ['unmatched']],
    ['main+unmatched', ['main', 'unmatched']]
  ];
  for (const [outputSet, expectedKinds] of cases) {
    const harness = await setupStandard({ outputSet });
    let publisherCalls = 0;
    try {
      assert.deepEqual(
        harness.run.exportAuthority.artifacts.map((artifact) => artifact.artifactKind),
        expectedKinds,
        outputSet
      );
      const filePlan = planFor(path.join(harness.root, outputSet), expectedKinds.length);
      const stagingDirectory = path.join(harness.root, `staging-${outputSet}`);
      fs.mkdirSync(stagingDirectory);
      const result = await generateValidateAndPublishReconFixExport({
        runtime: harness.runtime,
        evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
        result: harness.run,
        filePlan,
        artifactBindings: artifactBindingsFor(filePlan, harness.run),
        stagingDirectory,
        operationKey: `output-set-${outputSet}`,
        context: operationContext(`output-set-${outputSet}`),
        batchContext: batchContext(`output-set-${outputSet}`),
        readCurrentEvidence: async () => currentEvidence(harness.run),
        publishPublication: async (payload) => {
          publisherCalls += 1;
          assert.deepEqual(
            payload.artifacts.map((artifact) => artifact.outputId),
            expectedKinds.map((kind) => `recon-fix-${kind}`),
            outputSet
          );
          assert.equal(payload.targets.length, expectedKinds.length, outputSet);
          return { committed: true };
        }
      });
      assert.deepEqual(
        result.artifacts.map((artifact) => artifact.artifactKind),
        expectedKinds,
        outputSet
      );
      assert.equal(publisherCalls, 1, outputSet);
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }
});

test('BOC export成功回读gateway业务；linked evidence变化时Publisher=0新增调用', async () => {
  const root = tempRoot('recon-export-boc-');
  const workbookPath = writeGatewayWorkbook(path.join(root, 'gateway.xlsx'));
  const dbPath = createBocDatabase(path.join(root, 'tool-data.sqlite'));
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  let publisherCalls = 0;
  try {
    const imported = await runtime.execute(request(RECON_FIX_IMPORT_ACTION, 'boc-import', {
      expectedRevision: 0, filePath: workbookPath, subMode: 'gateway'
    }));
    const run = await runtime.execute(request(RECON_FIX_RUN_READONLY_ACTION, 'boc-run', {
      bocDatabasePath: dbPath,
      expectedRevision: imported.result.revision,
      scenario: bocScenario()
    }));
    assert.equal(run.result.summary.runKind, 'boc');
    assert.deepEqual(
      run.result.exportAuthority.artifacts.map((artifact) => artifact.artifactKind),
      ['main']
    );
    const filePlan = planFor(root, run.result.summary.unmatchedRowCount > 0 ? 2 : 1);
    const successfulStaging = path.join(root, 'staging-success');
    fs.mkdirSync(successfulStaging);
    const successful = await generateValidateAndPublishReconFixExport({
      runtime,
      evidenceSettlementAdmission: runtime.reconFixEvidenceSettlementAdmission,
      result: run.result,
      filePlan,
      artifactBindings: artifactBindingsFor(filePlan, run.result),
      stagingDirectory: successfulStaging,
      operationKey: 'boc-export-success',
      context: operationContext('boc-export-success'),
      batchContext: batchContext('boc-export-success'),
      readCurrentEvidence: async () => currentEvidence(run.result),
      publishPublication: async () => {
        publisherCalls += 1;
        return { committed: true };
      }
    });
    assert.equal(successful.summary.fixedRowCount, run.result.summary.fixedRowCount);
    assert.deepEqual(successful.artifacts.map((artifact) => artifact.artifactKind), ['main']);
    assert.equal(publisherCalls, 1);
    const writable = new DatabaseSync(dbPath);
    const row = writable.prepare('SELECT id, raw_json FROM linked_boc_fx_settlement').get();
    const changed = JSON.parse(row.raw_json);
    changed['货币1金额'] = 15001;
    writable.prepare('UPDATE linked_boc_fx_settlement SET raw_json = ? WHERE id = ?')
      .run(JSON.stringify(changed), row.id);
    writable.close();
    const stagingDirectory = path.join(root, 'staging');
    fs.mkdirSync(stagingDirectory);
    await assert.rejects(
      generateValidateAndPublishReconFixExport({
        runtime,
        evidenceSettlementAdmission: runtime.reconFixEvidenceSettlementAdmission,
        result: run.result,
        filePlan,
        artifactBindings: artifactBindingsFor(filePlan, run.result),
        stagingDirectory,
        operationKey: 'boc-export-stale',
        context: operationContext('boc-export-stale'),
        batchContext: batchContext('boc-export-stale'),
        readCurrentEvidence: async () => currentEvidence(run.result),
        publishPublication: async () => { publisherCalls += 1; }
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_LINKED_EVIDENCE_STALE'
    );
    assert.equal(publisherCalls, 1);
  } finally {
    await runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('artifact set/collision/target alias/symlink staging均在Publisher前拒绝', async () => {
  const harness = await setupStandard();
  let publisherCalls = 0;
  try {
    const correctPlan = planFor(harness.root, 2);
    const staging = path.join(harness.root, 'staging-collision');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, '000-main.xlsx'), 'collision');
    await assert.rejects(
      generateValidateAndPublishReconFixExport({
        runtime: harness.runtime,
        evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
        result: harness.run,
        filePlan: correctPlan,
        artifactBindings: artifactBindingsFor(correctPlan, harness.run),
        stagingDirectory: staging,
        operationKey: 'collision',
        context: operationContext('collision'),
        batchContext: batchContext('collision'),
        readCurrentEvidence: async () => currentEvidence(harness.run),
        publishPublication: async () => { publisherCalls += 1; }
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_STAGING_COLLISION'
    );

    const wrongPlan = planFor(path.join(harness.root, 'wrong-count'), 1);
    const emptyStaging = path.join(harness.root, 'staging-wrong-count');
    fs.mkdirSync(emptyStaging, { recursive: true });
    assert.throws(
      () => createReconFixExportInput({
        result: harness.run,
        filePlan: wrongPlan,
        artifactBindings: artifactBindingsFor(wrongPlan, harness.run),
        stagingDirectory: emptyStaging
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_FILE_PLAN_INVALID'
    );

    const aliasStaging = path.join(harness.root, 'staging-alias');
    fs.mkdirSync(aliasStaging);
    const aliasPlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [
        { filePath: path.join(aliasStaging, '000-main.xlsx'), role: 'output', sourceOperation: 'recon-id-fix:export' },
        { filePath: path.join(harness.root, 'alias-unmatched.xlsx'), role: 'output', sourceOperation: 'recon-id-fix:export' }
      ]
    });
    assert.throws(
      () => createReconFixExportInput({
        result: harness.run,
        filePlan: aliasPlan,
        artifactBindings: artifactBindingsFor(aliasPlan, harness.run),
        stagingDirectory: aliasStaging
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_PATH_ALIAS'
    );

    const realStaging = path.join(harness.root, 'staging-real');
    const linkedStaging = path.join(harness.root, 'staging-link');
    fs.mkdirSync(realStaging);
    fs.symlinkSync(realStaging, linkedStaging, 'dir');
    assert.throws(
      () => createReconFixExportInput({
        result: harness.run,
        filePlan: correctPlan,
        artifactBindings: artifactBindingsFor(correctPlan, harness.run),
        stagingDirectory: linkedStaging
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_STAGING_INVALID'
    );

    const forgedOwnershipPlan = structuredClone(correctPlan);
    forgedOwnershipPlan.outputs[0].role = 'forged-output';
    assert.throws(
      () => createReconFixExportInput({
        result: harness.run,
        filePlan: forgedOwnershipPlan,
        artifactBindings: artifactBindingsFor(correctPlan, harness.run),
        stagingDirectory: emptyStaging
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_FILE_PLAN_INVALID'
    );

    const staleTargetRoot = path.join(harness.root, 'stale-target-plan');
    const staleTargetPlan = planFor(staleTargetRoot, 2);
    fs.writeFileSync(staleTargetPlan.outputs[0].filePath, 'target-created-after-plan');
    assert.throws(
      () => createReconFixExportInput({
        result: harness.run,
        filePlan: staleTargetPlan,
        artifactBindings: artifactBindingsFor(staleTargetPlan, harness.run),
        stagingDirectory: emptyStaging
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_FILE_PLAN_INVALID'
    );
    assert.equal(publisherCalls, 0);
  } finally {
    await harness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('batchContext是唯一authority：A runtime context/B journal batch在Worker前拒绝', async () => {
  const harness = await setupStandard();
  let reservationCalls = 0;
  let evidenceReads = 0;
  let publisherCalls = 0;
  try {
    const filePlan = planFor(harness.root, 2);
    const stagingDirectory = path.join(harness.root, 'staging-mixed-batch-authority');
    fs.mkdirSync(stagingDirectory);
    await assert.rejects(
      generateValidateAndPublishReconFixExport({
        runtime: Object.freeze({
          reserveServiceOperation() {
            reservationCalls += 1;
            throw new Error('batch authority 失败后不得到达 reservation');
          }
        }),
        result: harness.run,
        filePlan,
        artifactBindings: artifactBindingsFor(filePlan, harness.run),
        stagingDirectory,
        operationKey: 'execution-a',
        context: operationContext('execution-a'),
        batchContext: batchContext('journal-b'),
        readCurrentEvidence: async () => {
          evidenceReads += 1;
          return currentEvidence(harness.run);
        },
        publishPublication: async () => { publisherCalls += 1; }
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_BATCH_CONTEXT_INVALID'
    );
    assert.equal(reservationCalls, 0);
    assert.equal(evidenceReads, 0);
    assert.equal(publisherCalls, 0);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  } finally {
    await harness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('export必须使用当前runtime owner的唯一evidence admission', async () => {
  const harness = await setupStandard();
  const otherRuntime = createBackgroundExecutionRuntime({
    availableParallelism: 2,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    shutdownTimeoutMs: 10000
  });
  let workerCalls = 0;
  let evidenceReads = 0;
  let publisherCalls = 0;
  try {
    const runtime = observedRuntime(harness.runtime, () => { workerCalls += 1; });
    const filePlan = planFor(harness.root, 2);
    const artifactBindings = artifactBindingsFor(filePlan, harness.run);
    const stagingDirectory = path.join(harness.root, 'staging-evidence-owner');
    fs.mkdirSync(stagingDirectory);
    const attempt = (operationKey, evidenceSettlementAdmission) => (
      generateValidateAndPublishReconFixExport({
        runtime,
        ...(evidenceSettlementAdmission === undefined
          ? {}
          : { evidenceSettlementAdmission }),
        result: harness.run,
        filePlan,
        artifactBindings,
        stagingDirectory,
        operationKey,
        context: operationContext(operationKey),
        batchContext: batchContext(operationKey),
        readCurrentEvidence: async () => {
          evidenceReads += 1;
          return currentEvidence(harness.run);
        },
        publishPublication: async () => { publisherCalls += 1; }
      })
    );
    await assert.rejects(
      () => attempt('missing-evidence-owner'),
      (error) => error.code === 'RECON_FIX_EVIDENCE_SETTLEMENT_ADMISSION_REQUIRED'
    );
    await assert.rejects(
      () => attempt(
        'mismatched-evidence-owner',
        otherRuntime.reconFixEvidenceSettlementAdmission
      ),
      (error) => error.code === 'RECON_FIX_EVIDENCE_SETTLEMENT_OWNER_MISMATCH'
    );
    assert.notEqual(
      harness.runtime.reconFixEvidenceSettlementAdmission,
      otherRuntime.reconFixEvidenceSettlementAdmission
    );

    let finishWriter;
    const activeWriter = harness.runtime.reconFixEvidenceSettlementAdmission.runWriter({
      writerKind: RECON_FIX_EVIDENCE_WRITER_KINDS.SCENARIO,
      operationKey: 'active-scenario-writer'
    }, () => new Promise((resolve) => { finishWriter = resolve; }));
    try {
      await assert.rejects(
        () => attempt(
          'active-writer-blocks-export',
          harness.runtime.reconFixEvidenceSettlementAdmission
        ),
        (error) => error.code === 'RECON_FIX_EVIDENCE_SETTLEMENT_BUSY'
      );
    } finally {
      finishWriter();
    }
    await activeWriter;

    assert.equal(workerCalls, 0);
    assert.equal(evidenceReads, 0);
    assert.equal(publisherCalls, 0);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  } finally {
    await Promise.all([
      harness.runtime.shutdown({ timeoutMs: 10000 }),
      otherRuntime.shutdown({ timeoutMs: 10000 })
    ]);
  }
});

test('Main-owned kind/artifactKey/target binding拒绝反序 targets且Publisher=0', async () => {
  const harness = await setupStandard();
  let workerCalls = 0;
  let publisherCalls = 0;
  try {
    const originalPlan = planFor(harness.root, 2);
    const artifactBindings = artifactBindingsFor(originalPlan, harness.run);
    const reversedPlan = structuredClone(originalPlan);
    reversedPlan.outputs.reverse();
    const stagingDirectory = path.join(harness.root, 'staging-reversed-targets');
    fs.mkdirSync(stagingDirectory);
    await assert.rejects(
      generateValidateAndPublishReconFixExport({
        runtime: observedRuntime(harness.runtime, () => { workerCalls += 1; }),
        evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
        result: harness.run,
        filePlan: reversedPlan,
        artifactBindings,
        stagingDirectory,
        operationKey: 'reversed-targets',
        context: operationContext('reversed-targets'),
        batchContext: batchContext('reversed-targets'),
        readCurrentEvidence: async () => currentEvidence(harness.run),
        publishPublication: async () => { publisherCalls += 1; }
      }),
      (error) => error.code === 'RECON_FIX_EXPORT_ARTIFACT_BINDING_INVALID'
    );
    assert.equal(workerCalls, 0);
    assert.equal(publisherCalls, 0);
    assert.deepEqual(fs.readdirSync(stagingDirectory), []);
  } finally {
    await harness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('tamper、stale identity/revision/scenario/linked、order与lineage全部Publisher=0', async () => {
  const cases = [
    {
      name: 'raw tamper',
      wrap: (runtime, input) => wrappedRuntime(runtime, async () => {
        fs.appendFileSync(input.artifacts[0].generationPath, Buffer.from('tamper'));
      }),
      code: 'RECON_FIX_EXPORT_ARTIFACT_IDENTITY_INVALID'
    },
    {
      name: 'artifact order',
      wrap: (runtime) => wrappedRuntime(runtime, async (execution) => {
        execution.result.artifacts.reverse();
      }),
      code: 'RECON_FIX_EXPORT_MANIFEST_INVALID'
    },
    {
      name: 'rowCounts',
      wrap: (runtime) => wrappedRuntime(runtime, async (execution) => {
        execution.result.artifacts[0].rowCount += 1;
        execution.result.summary.fixedRowCount += 1;
      }),
      code: 'RECON_FIX_EXPORT_AUTHORITY_MISMATCH'
    },
    {
      name: 'lineage',
      wrap: (runtime) => wrappedRuntime(runtime, async (execution) => {
        execution.result.artifacts[0].lineage.inputEvidenceHash = 'f'.repeat(64);
      }),
      code: 'RECON_FIX_EXPORT_BUSINESS_EVIDENCE_MISMATCH'
    }
  ];
  for (const candidate of cases) {
    const harness = await setupStandard();
    let publisherCalls = 0;
    try {
      const filePlan = planFor(harness.root, 2);
      const stagingDirectory = path.join(harness.root, `staging-${candidate.name.replaceAll(' ', '-')}`);
      fs.mkdirSync(stagingDirectory);
      const artifactBindings = artifactBindingsFor(filePlan, harness.run);
      const input = createReconFixExportInput({
        result: harness.run,
        filePlan,
        artifactBindings,
        stagingDirectory
      });
      await assert.rejects(
        generateValidateAndPublishReconFixExport({
          runtime: candidate.wrap(harness.runtime, input),
          evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
          result: harness.run,
          filePlan,
          artifactBindings,
          stagingDirectory,
          operationKey: `fault-${candidate.name}`,
          context: operationContext(`fault-${candidate.name}`),
          batchContext: batchContext(`fault-${candidate.name}`),
          readCurrentEvidence: async () => currentEvidence(harness.run),
          publishPublication: async () => { publisherCalls += 1; }
        }),
        (error) => error.code === candidate.code,
        candidate.name
      );
      assert.equal(publisherCalls, 0, candidate.name);
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }

  const staleCases = [
    ['result', { resultHandle: '0'.repeat(64) }, 'RECON_FIX_EXPORT_RESULT_STALE'],
    ['revision', { revision: 999 }, 'RECON_FIX_EXPORT_RESULT_STALE'],
    ['input', { inputEvidenceHash: '0'.repeat(64) }, 'RECON_FIX_EXPORT_INPUT_EVIDENCE_STALE'],
    ['scenario', { scenarioSnapshotHash: '0'.repeat(64) }, 'RECON_FIX_EXPORT_SCENARIO_STALE'],
    ['linked', { linkedEvidenceHash: '0'.repeat(64) }, 'RECON_FIX_EXPORT_LINKED_EVIDENCE_STALE']
  ];
  for (const [name, patch, code] of staleCases) {
    const harness = await setupStandard();
    let publisherCalls = 0;
    try {
      const filePlan = planFor(harness.root, 2);
      const stagingDirectory = path.join(harness.root, `staging-stale-${name}`);
      fs.mkdirSync(stagingDirectory);
      await assert.rejects(
        generateValidateAndPublishReconFixExport({
          runtime: harness.runtime,
          evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
          result: harness.run,
          filePlan,
          artifactBindings: artifactBindingsFor(filePlan, harness.run),
          stagingDirectory,
          operationKey: `stale-${name}`,
          context: operationContext(`stale-${name}`),
          batchContext: batchContext(`stale-${name}`),
          readCurrentEvidence: async () => currentEvidence(harness.run, patch),
          publishPublication: async () => { publisherCalls += 1; }
        }),
        (error) => error.code === code,
        name
      );
      assert.equal(publisherCalls, 0, name);
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }

  const reservationHarness = await setupStandard();
  let evidenceReads = 0;
  let publisherCalls = 0;
  const writerBodyCalls = new Map(
    Object.values(RECON_FIX_EVIDENCE_WRITER_KINDS).map((writerKind) => [writerKind, 0])
  );
  try {
    const filePlan = planFor(reservationHarness.root, 2);
    const stagingDirectory = path.join(reservationHarness.root, 'staging-reservation-race');
    fs.mkdirSync(stagingDirectory);
    const exported = await generateValidateAndPublishReconFixExport({
      runtime: reservationHarness.runtime,
      evidenceSettlementAdmission: reservationHarness.runtime.reconFixEvidenceSettlementAdmission,
      result: reservationHarness.run,
      filePlan,
      artifactBindings: artifactBindingsFor(filePlan, reservationHarness.run),
      stagingDirectory,
      operationKey: 'reservation-race',
      context: operationContext('reservation-race'),
      batchContext: batchContext('reservation-race'),
      readCurrentEvidence: async () => {
        evidenceReads += 1;
        return currentEvidence(reservationHarness.run);
      },
      publishPublication: async () => {
        publisherCalls += 1;
        assert.throws(
          () => reservationHarness.runtime.execute(request(
            RECON_FIX_IMPORT_ACTION,
            'import-during-publisher',
            {
              expectedRevision: reservationHarness.run.revision,
              filePath: reservationHarness.workbookPath,
              subMode: 'business'
            }
          )),
          (error) => error.code === 'SERVICE_BUSY'
        );
        assert.throws(
          () => reservationHarness.runtime.execute(request(
            RECON_FIX_RUN_READONLY_ACTION,
            'run-during-publisher',
            {
              bocDatabasePath: null,
              expectedRevision: reservationHarness.run.revision,
              scenario: standardScenario()
            }
          )),
          (error) => error.code === 'SERVICE_BUSY'
        );
        for (const writerKind of Object.values(RECON_FIX_EVIDENCE_WRITER_KINDS)) {
          assert.throws(
            () => reservationHarness.runtime.reconFixEvidenceSettlementAdmission.runWriter({
              writerKind,
              operationKey: `${writerKind}-during-publisher`
            }, () => {
              writerBodyCalls.set(writerKind, writerBodyCalls.get(writerKind) + 1);
            }),
            (error) => error.code === 'RECON_FIX_EVIDENCE_SETTLEMENT_BUSY'
          );
        }
        return { committed: true };
      }
    });
    assert.equal(exported.publication.committed, true);
    assert.equal(evidenceReads, 1);
    assert.equal(publisherCalls, 1);
    const importedAfterSettlement = await reservationHarness.runtime.execute(request(
      RECON_FIX_IMPORT_ACTION,
      'import-after-publisher',
      {
        expectedRevision: reservationHarness.run.revision,
        filePath: reservationHarness.workbookPath,
        subMode: 'business'
      }
    ));
    assert.equal(importedAfterSettlement.outcome, 'completed');
    for (const writerKind of Object.values(RECON_FIX_EVIDENCE_WRITER_KINDS)) {
      const writerResult = reservationHarness.runtime.reconFixEvidenceSettlementAdmission.runWriter({
        writerKind,
        operationKey: `${writerKind}-after-publisher`
      }, () => {
        writerBodyCalls.set(writerKind, writerBodyCalls.get(writerKind) + 1);
        return `${writerKind}-written`;
      });
      assert.equal(writerResult, `${writerKind}-written`);
      assert.equal(writerBodyCalls.get(writerKind), 1);
    }
  } finally {
    await reservationHarness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('sheet/headers/records/style业务篡改即使同步伪造size/hash仍Publisher=0', async () => {
  const mutations = [
    ['sheet', (workbook) => { workbook.SheetNames[0] = '伪造Sheet'; workbook.Sheets['伪造Sheet'] = workbook.Sheets[Object.keys(workbook.Sheets)[0]]; delete workbook.Sheets[Object.keys(workbook.Sheets)[0]]; }],
    ['headers', (workbook) => { workbook.Sheets[workbook.SheetNames[0]].A1.v = '伪造列'; }],
    ['records', (workbook) => { workbook.Sheets[workbook.SheetNames[0]].A2.v = '伪造记录'; }],
    ['style', (workbook) => {
      workbook.Sheets[workbook.SheetNames[0]].A1.s = { font: { sz: 11 } };
    }]
  ];
  for (const [name, mutateWorkbook] of mutations) {
    const harness = await setupStandard();
    let publisherCalls = 0;
    try {
      const filePlan = planFor(harness.root, 2);
      const stagingDirectory = path.join(harness.root, `staging-business-${name}`);
      fs.mkdirSync(stagingDirectory);
      const artifactBindings = artifactBindingsFor(filePlan, harness.run);
      const input = createReconFixExportInput({
        result: harness.run,
        filePlan,
        artifactBindings,
        stagingDirectory
      });
      const runtime = wrappedRuntime(harness.runtime, async (execution) => {
        const generationPath = input.artifacts[0].generationPath;
        const workbook = XLSXStyle.readFile(generationPath, { cellStyles: true });
        mutateWorkbook(workbook);
        XLSXStyle.writeFile(workbook, generationPath);
        await refreshArtifactTechnicalEvidence(execution, generationPath);
      });
      await assert.rejects(
        generateValidateAndPublishReconFixExport({
          runtime,
          evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
          result: harness.run,
          filePlan,
          artifactBindings,
          stagingDirectory,
          operationKey: `business-${name}`,
          context: operationContext(`business-${name}`),
          batchContext: batchContext(`business-${name}`),
          readCurrentEvidence: async () => currentEvidence(harness.run),
          publishPublication: async () => { publisherCalls += 1; }
        }),
        (error) => [
          'RECON_FIX_EXPORT_SHEET_MISMATCH',
          'RECON_FIX_EXPORT_HEADERS_MISMATCH',
          'RECON_FIX_EXPORT_STYLE_MISMATCH',
          'RECON_FIX_EXPORT_BUSINESS_EVIDENCE_MISMATCH'
        ].includes(error.code),
        name
      );
      assert.equal(publisherCalls, 0, name);
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }
});

test('业务cell/新增行与自洽Worker manifest/summary仍必须对generation前authority失败', async () => {
  const forgeries = [
    ['business-cell', (xml) => replaceInlineStringCell(
      xml,
      'A2',
      'FORGED-BUSINESS-KEY'
    ), 'RECON_FIX_EXPORT_BUSINESS_EVIDENCE_MISMATCH'],
    ['added-row', (xml) => {
      const rowMatch = xml.match(/<row\b([^>]*\br="2"[^>]*)>[\s\S]*?<\/row>/);
      assert.ok(rowMatch, 'missing source business row');
      let clonedRow = rowMatch[0]
        .replace(/\br="2"/, 'r="3"')
        .replace(/\br="([A-Z]+)2"/g, 'r="$1' + '3"');
      clonedRow = replaceInlineStringCell(clonedRow, 'A3', 'FORGED-ADDED-ROW');
      return xml
        .replace(/(<dimension\b[^>]*\bref="[A-Z]+1:[A-Z]+)2("[^>]*>)/, '$1' + '3$2')
        .replace('</sheetData>', `${clonedRow}</sheetData>`);
    }, 'RECON_FIX_EXPORT_AUTHORITY_MISMATCH']
  ];
  for (const [name, mutateWorkbook, expectedCode] of forgeries) {
    const harness = await setupStandard();
    let publisherCalls = 0;
    try {
      const filePlan = planFor(harness.root, 2);
      const artifactBindings = artifactBindingsFor(filePlan, harness.run);
      const stagingDirectory = path.join(harness.root, `staging-self-consistent-${name}`);
      fs.mkdirSync(stagingDirectory);
      const input = createReconFixExportInput({
        result: harness.run,
        filePlan,
        artifactBindings,
        stagingDirectory
      });
      const runtime = wrappedRuntime(harness.runtime, async (execution) => {
        const generationPath = input.artifacts[0].generationPath;
        await mutateFirstWorksheetXml(generationPath, mutateWorkbook);
        const business = await readReconFixArtifactEvidence(
          generationPath,
          'main',
          harness.run.exportAuthority.subMode
        );
        Object.assign(execution.result.artifacts[0], {
          sheetName: business.sheetName,
          headersDigest: business.headersDigest,
          recordsDigest: business.recordsDigest,
          rowCount: business.rowCount
        });
        execution.result.summary.fixedRowCount = business.rowCount;
        await refreshArtifactTechnicalEvidence(execution, generationPath);
        assert.equal(validateReconFixExportResult(execution.result), true);
      });
      await assert.rejects(
        generateValidateAndPublishReconFixExport({
          runtime,
          evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
          result: harness.run,
          filePlan,
          artifactBindings,
          stagingDirectory,
          operationKey: `self-consistent-${name}`,
          context: operationContext(`self-consistent-${name}`),
          batchContext: batchContext(`self-consistent-${name}`),
          readCurrentEvidence: async () => currentEvidence(harness.run),
          publishPublication: async () => { publisherCalls += 1; }
        }),
        (error) => error.code === expectedCode,
        name
      );
      assert.equal(publisherCalls, 0, name);
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }
});

test('真实 journal Publisher 一次提交 main+unmatched 且保留原批次 recovery receipt', async () => {
  const harness = await setupStandard();
  try {
    const filePlan = planFor(harness.root, 2);
    const stagingDirectory = path.join(harness.root, 'staging-journal-success');
    const userDataDir = path.join(harness.root, 'user-data');
    fs.mkdirSync(stagingDirectory);
    const result = await generateValidateAndPublishReconFixExport({
      runtime: harness.runtime,
      evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
      result: harness.run,
      filePlan,
      artifactBindings: artifactBindingsFor(filePlan, harness.run),
      stagingDirectory,
      userDataDir,
      operationKey: 'journal-success',
      context: operationContext('journal-success'),
      batchContext: batchContext('journal-success'),
      readCurrentEvidence: async () => currentEvidence(harness.run)
    });
    assert.equal(result.publication.committed, true);
    assert.equal(result.publication.pendingArchiveHandoff, true);
    assert.equal(filePlan.outputs.every((output) => fs.lstatSync(output.filePath).isFile()), true);
    assert.deepEqual(
      filePlan.outputs.map((output) => sha256(output.filePath)),
      result.artifacts.map((artifact) => artifact.sha256)
    );
    const journalIndex = JSON.parse(fs.readFileSync(
      path.join(userDataDir, 'toolbox-publish-journal-index.json'),
      'utf8'
    ));
    assert.equal(journalIndex.entries.length, 1);
    assert.equal(journalIndex.entries[0].batchContext.taskRunId, 'task-journal-success');
  } finally {
    await harness.runtime.shutdown({ timeoutMs: 10000 });
  }
});

test('Publisher failure/uncertain只调用一次且不猜成功、不自动重发', async () => {
  for (const code of ['PUBLISH_FAILED', 'PUBLISH_UNCERTAIN']) {
    const harness = await setupStandard();
    let publisherCalls = 0;
    try {
      const filePlan = planFor(harness.root, 2);
      const stagingDirectory = path.join(harness.root, `staging-${code}`);
      fs.mkdirSync(stagingDirectory);
      await assert.rejects(
        generateValidateAndPublishReconFixExport({
          runtime: harness.runtime,
          evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
          result: harness.run,
          filePlan,
          artifactBindings: artifactBindingsFor(filePlan, harness.run),
          stagingDirectory,
          operationKey: code,
          context: operationContext(code),
          batchContext: batchContext(code),
          readCurrentEvidence: async () => currentEvidence(harness.run),
          publishPublication: async () => {
            publisherCalls += 1;
            throw Object.assign(new Error(code), { code });
          }
        }),
        (error) => error.code === code
      );
      assert.equal(publisherCalls, 1);
      assert.equal(filePlan.outputs.every((output) => !fs.existsSync(output.filePath)), true);
      const writerResult = harness.runtime.reconFixEvidenceSettlementAdmission.runWriter({
        writerKind: RECON_FIX_EVIDENCE_WRITER_KINDS.SCENARIO,
        operationKey: `${code}-writer-after-reject`
      }, () => 'writer-released');
      assert.equal(writerResult, 'writer-released');
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }
});

test('双artifact Publisher kill后沿用journal recovery：未提交回滚、已提交按原批次恢复', async () => {
  for (const committedCrash of [false, true]) {
    const harness = await setupStandard();
    try {
      const label = committedCrash ? 'committed-crash-recover' : 'precommit-crash-recover';
      const filePlan = planFor(path.join(harness.root, label), 2);
      const stagingDirectory = path.join(harness.root, `${label}-staging`);
      const userDataDir = path.join(harness.root, `${label}-user-data`);
      const publisherBatchContext = batchContext(label);
      fs.mkdirSync(stagingDirectory, { recursive: true });
      const dispatcher = createToolboxPublicationDispatcher({
        workerScriptPath: CRASH_RECOVER_PUBLISHER
      });
      const execute = () => generateValidateAndPublishReconFixExport({
        runtime: harness.runtime,
        evidenceSettlementAdmission: harness.runtime.reconFixEvidenceSettlementAdmission,
        result: harness.run,
        filePlan,
        artifactBindings: artifactBindingsFor(filePlan, harness.run),
        stagingDirectory,
        userDataDir,
        operationKey: label,
        context: operationContext(label),
        batchContext: publisherBatchContext,
        readCurrentEvidence: async () => currentEvidence(harness.run),
        publishPublication(payload) {
          return dispatcher.publish({
            ...payload,
            taskId: committedCrash ? `committed-crash-recover-${payload.taskId}` : payload.taskId,
            requireArchiveHandoff: true,
            requireValidatedArtifacts: true
          });
        }
      });
      if (committedCrash) {
        const result = await execute();
        assert.equal(result.publication.committed, true);
        assert.equal(result.publication.recoveredAfterWorkerExit, true);
        assert.deepEqual(result.publication.batchContext, publisherBatchContext);
        assert.equal(filePlan.outputs.every((output) => fs.existsSync(output.filePath)), true);
      } else {
        await assert.rejects(execute, (error) => {
          assert.equal(error.code, 'TOOLBOX_PUBLICATION_WORKER_FAILED');
          assert.ok(error.detailLines.some((line) => line.includes('已执行自动恢复')));
          return true;
        });
        assert.equal(filePlan.outputs.every((output) => !fs.existsSync(output.filePath)), true);
      }
      assert.equal(
        fs.readFileSync(path.join(userDataDir, 'recovery-ran.txt'), 'utf8'),
        'recovered'
      );
    } finally {
      await harness.runtime.shutdown({ timeoutMs: 10000 });
    }
  }
});
