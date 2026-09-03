'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const { BANK_STATEMENT_FIELDS } = require('../../../src/constants/bank-statement-fields');
const {
  DETAIL_META_HEADERS
} = require('../../../src/backend/position-reconciliation-import/anomaly-report');
const {
  createPositionReconciliationService
} = require('../../../src/main-process/position-reconciliation/service');
const {
  createPositionReconciliationStore,
  serializeJson
} = require('../../../src/main-process/position-reconciliation/store');
const {
  BANK_SHEET_NAME,
  MATCH_TYPES,
  POSITION_BANK_HEADERS,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  writeResultWorkbook
} = require('../../../src/main-process/position-reconciliation/excel-io');
const {
  writeRunFilteredSourcesWorkbook
} = require('../../../src/main-process/position-reconciliation/filtered-source-report');
const {
  hashFileSha256Async
} = require('../../../src/main-process/position-reconciliation/input-staging');
const {
  generateValidateAndPublishPositionExport
} = require('../../../src/main-process/read-only-exports/position/managed-export');
const {
  POSITION_READ_ONLY_ACTION,
  validatePositionReadOnlyExportResult
} = require('../../../src/main-process/read-only-exports/position/policies');
const {
  assertPositionSourceSnapshot,
  freezePositionSourceSnapshot
} = require('../../../src/main-process/read-only-exports/position/query');
const {
  composePositionTerminalSettlement,
  settlePositionPublishedMetadata
} = require('../../../src/main-process/read-only-exports/position/settlement');
const {
  executePositionReadOnlyExport
} = require('../../../src/main-process/read-only-exports/position/writer');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../assets/平盘银行对账单.xlsx');

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'POSITION-E13-B-1',
    BillDate: '2026-08-20',
    Channel: 'DBS',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: 'RID-E13-B-1',
    FundType: 'Charge',
    ...overrides
  };
}

function applyBankImport(service, token) {
  return service.applyBankImport(
    token,
    undefined,
    service.bankImportArchiveIntent(token).map((file) => file.filePath)
  );
}

function createRunFixture(overrides = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-e13-b-'));
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  writeWorkbook(
    bankPath,
    BANK_SHEET_NAME,
    BANK_STATEMENT_FIELDS,
    [bankRow(overrides)]
  );
  let operationIndex = 0;
  const service = createPositionReconciliationService({
    userDataDir,
    templatePath: TEMPLATE_PATH,
    operationTokenProvider: () => `position-e13-b-operation-${++operationIndex}`
  });
  applyBankImport(service, service.prepareBankImport([bankPath]).token);
  const run = service.run({ channels: ['DBS'], months: ['2026-08'] });
  return { run, service, userDataDir };
}

function createGenerationPlan(root, name = 'position.xlsx') {
  return Object.freeze({
    stagingRoot: root,
    stagingResourceId: name,
    generationPath: path.join(root, name),
    outputArtifactKey: `artifact-${name}`
  });
}

function workerInput(fixture, frozen, generationPlan, operationKey = 'position-e13-b-operation') {
  return {
    actionKey: POSITION_READ_ONLY_ACTION,
    operationKey,
    taskRunId: 'position-e13-b-task',
    stableRunEvidence: frozen.evidence,
    dbPathOrManagedSource: {
      kind: 'sqlite',
      sideDatabasePath: fixture.service.store.dbPath,
      templatePath: TEMPLATE_PATH,
      userDataDir: fixture.userDataDir
    },
    generationPlan,
    context: frozen.context
  };
}

async function writeFilteredReport(filePath) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
  const summary = workbook.addWorksheet('异常汇总');
  summary.addRow(['文件名', '来源类型', '过滤行数']).commit();
  summary.addRow(['transfer.xlsx', SOURCE_TYPES.FUND_TRANSFER, 1]).commit();
  summary.commit();
  const headers = [
    ...DETAIL_META_HEADERS,
    ...SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers
  ];
  const detail = workbook.addWorksheet('调拨异常明细');
  detail.addRow(headers).commit();
  const raw = Object.fromEntries(
    SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers.map((header) => [header, ''])
  );
  Object.assign(raw, {
    调拨单号: 'E13-B-FILTERED-1',
    调拨状态: '付款失败',
    渠道流水号: 'RID-E13-B-FILTERED-1',
    交易时间: '2026-08-20',
    付款币种: 'USD',
    收款金额: '95',
    收款币种: 'EUR'
  });
  detail.addRow([
    'position-e13-b-report-row', 'transfer.xlsx', 'Sheet1', 2,
    SOURCE_TYPES.FUND_TRANSFER, raw.调拨单号, raw.渠道流水号,
    'FT_NON_SUCCESS_EVIDENCE_INCOMPLETE', '非成功调拨缺少付款金额',
    '2026-08-20', '2026-08',
    ...SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER].headers.map((header) => raw[header])
  ]).commit();
  detail.commit();
  await workbook.commit();
}

async function createFilteredFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-filtered-e13-b-'));
  const reportPath = path.join(userDataDir, 'report.xlsx');
  await writeFilteredReport(reportPath);
  const reportEvidence = await hashFileSha256Async(reportPath);
  const store = createPositionReconciliationStore(userDataDir, {
    initialCheckpoint: {
      identity: 'position-filtered-e13-b-identity',
      generation: 0,
      token: 'position-filtered-e13-b-token'
    },
    operationTokenProvider: () => 'position-filtered-e13-b-operation'
  });
  const inserted = store.db.prepare(`
    INSERT INTO position_filtered_source_rows(
      report_row_key, source_type, business_key, recon_id,
      event_date, month_key, error_code, error_reason,
      source_file_path, source_file_name, source_sheet, source_row_number,
      row_hash, import_operation_token, archive_operation_key,
      report_key, report_artifact_key, report_file_path, report_file_name,
      report_sha256, report_size_bytes
    ) VALUES (
      'position-e13-b-report-row', ?, 'E13-B-FILTERED-1', 'RID-E13-B-FILTERED-1',
      '2026-08-20', '2026-08', 'FT_FILTER', '测试过滤',
      '/tmp/source.xlsx', 'source.xlsx', 'Sheet1', 2,
      'position-e13-b-row-hash', 'operation', 'archive-operation',
      'position-e13-b-report', 'position-e13-b-artifact', ?, 'report.xlsx', ?, ?
    )
  `).run(
    SOURCE_TYPES.FUND_TRANSFER,
    reportPath,
    reportEvidence.sha256,
    reportEvidence.sizeBytes
  );
  const scope = {
    channels: ['DBS'],
    months: ['2026-08'],
    scopes: ['DBS\u00002026-08']
  };
  const snapshot = store.currentSnapshot({
    scopes: scope.scopes,
    sourceTypes: [SOURCE_TYPES.FUND_TRANSFER],
    includeMapping: true
  });
  const row = Object.fromEntries(BANK_STATEMENT_FIELDS.map((header) => [header, '']));
  Object.assign(row, bankRow({ FundType: 'FundTransfer-in' }));
  store.db.prepare(`
    INSERT INTO position_bank_rows(
      biz_id, channel, month_key, bill_date, status,
      source_file_path, source_file_name, source_sheet, source_row_number,
      import_order, original_fund_type, working_fund_type,
      original_json, working_json
    ) VALUES (?, ?, ?, ?, '未处理', '/tmp/bank.xlsx', 'bank.xlsx',
              '渠道对账单', 2, 0, ?, ?, ?, ?)
  `).run(
    row.BizId,
    row.Channel,
    '2026-08',
    '2026-08-20',
    row.FundType,
    row.FundType,
    serializeJson(row),
    serializeJson(row)
  );
  const summary = {
    inputRows: 1,
    changedRows: 0,
    differenceRows: 1,
    preciseRows: 0,
    fuzzyRows: 0,
    notApplicableRows: 0,
    manualModifiedRows: 0,
    sourceTypes: [SOURCE_TYPES.FUND_TRANSFER],
    filteredRowCount: 1,
    engine: {
      total: 1,
      matched: 0,
      changed: 0,
      differences: 1,
      notApplicable: 0,
      confirmedConsumptionConflicts: 0
    }
  };
  const run = store.createRun({
    runUuid: 'position-filtered-e13-b-run',
    scope,
    snapshot,
    summary,
    rows: [{
      bizId: row.BizId,
      channel: row.Channel,
      monthKey: '2026-08',
      sourceOrder: 0,
      originalFundType: row.FundType,
      resultFundType: row.FundType,
      hitSummary: '',
      hitType: MATCH_TYPES.UNMATCHED,
      matchDetail: '没有可用候选',
      outcome: 'difference',
      changed: false,
      isDifference: true,
      originalRow: row,
      resultRow: { ...row },
      lineage: {
        pairKey: null,
        sourceType: SOURCE_TYPES.FUND_TRANSFER,
        sourceLinkRowId: null,
        sourceBusinessKey: null,
        sourceRecordKey: null,
        sourceLegIndex: null,
        reasonCode: 'no-candidate',
        reasons: ['没有可用候选']
      }
    }],
    filteredSources: [{
      id: Number(inserted.lastInsertRowid),
      reportKey: 'position-e13-b-report',
      reportArtifactKey: 'position-e13-b-artifact',
      archiveOperationKey: 'archive-operation',
      reportSha256: reportEvidence.sha256,
      reportSizeBytes: reportEvidence.sizeBytes,
      sourceRevision: Number(snapshot.sources[SOURCE_TYPES.FUND_TRANSFER])
    }]
  });
  const service = {
    store,
    templatePath: TEMPLATE_PATH,
    userDataDir
  };
  return { reportEvidence, reportPath, run, service, store, userDataDir };
}

test('E13-B Position run worker 与 legacy workbook 语义 golden 等价，真实 Runtime 可执行', async (t) => {
  const fixture = createRunFixture();
  const workerRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'worker-'));
  const runtimeRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'runtime-'));
  const legacyPath = path.join(fixture.userDataDir, 'legacy.xlsx');
  const frozen = await freezePositionSourceSnapshot({
    store: fixture.service.store,
    templatePath: TEMPLATE_PATH,
    variant: 'run',
    runId: fixture.run.runId,
    filters: {},
    reportFiles: []
  });
  await writeResultWorkbook({
    templatePath: TEMPLATE_PATH,
    outputPath: legacyPath,
    rows: fixture.service.store.listRunRows(fixture.run.runId),
    highlightChanged: true
  });
  const directPlan = createGenerationPlan(workerRoot, 'direct.xlsx');
  const direct = await executePositionReadOnlyExport(
    workerInput(fixture, frozen, directPlan),
    null
  );
  assert.equal(validatePositionReadOnlyExportResult(direct), true);
  assert.deepEqual(
    readWorkbookBusinessEvidence(directPlan.generationPath),
    readWorkbookBusinessEvidence(legacyPath)
  );
  assert.equal(direct.summary.rowCount, 1);

  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 4 * 1024 ** 3
  });
  t.after(async () => {
    await runtime.shutdown({ timeoutMs: 5000 });
    fixture.service.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const runtimePlan = createGenerationPlan(runtimeRoot, 'runtime.xlsx');
  const operationKey = 'position-e13-b-runtime-operation';
  const execution = await runtime.execute({
    actionKey: POSITION_READ_ONLY_ACTION,
    operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'position-e13-b-task',
        taskKey: 'position-reconciliation:run:export',
        moduleId: 'position-reconciliation',
        parentRunId: 'position-e13-b-parent',
        operationKey
      }
    },
    input: workerInput(fixture, frozen, runtimePlan, operationKey)
  });
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(execution.result.summary.variant, 'run');
});

test('E13-B Position stale checkpoint fail closed，差异空集不产生 artifact', async (t) => {
  const fixture = createRunFixture();
  const staleRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'stale-'));
  const emptyRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'empty-'));
  t.after(() => {
    fixture.service.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const frozen = await freezePositionSourceSnapshot({
    store: fixture.service.store,
    templatePath: TEMPLATE_PATH,
    variant: 'run',
    runId: fixture.run.runId,
    filters: {},
    reportFiles: []
  });
  fixture.service.store.markRunExported(fixture.run.runId);
  const stalePlan = createGenerationPlan(staleRoot, 'stale.xlsx');
  await assert.rejects(
    () => executePositionReadOnlyExport(workerInput(fixture, frozen, stalePlan), null),
    (error) => error && error.code === 'position-side-db-mismatch'
  );
  assert.equal(fs.existsSync(stalePlan.generationPath), false);

  const differences = await freezePositionSourceSnapshot({
    store: fixture.service.store,
    templatePath: TEMPLATE_PATH,
    variant: 'differences',
    runId: fixture.run.runId,
    filters: {},
    reportFiles: []
  });
  const emptyPlan = createGenerationPlan(emptyRoot, 'empty.xlsx');
  await assert.rejects(
    () => executePositionReadOnlyExport(workerInput(fixture, differences, emptyPlan), null),
    (error) => error && error.code === 'POSITION_EXPORT_DIFFERENCE_EMPTY'
  );
  assert.equal(fs.existsSync(emptyPlan.generationPath), false);
});

test('E13-B Position filtered worker 保留异常报告血缘并与 legacy workbook 等价', async (t) => {
  const fixture = await createFilteredFixture();
  const workerRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'worker-'));
  const legacyPath = path.join(fixture.userDataDir, 'legacy-filtered.xlsx');
  t.after(() => {
    fixture.store.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const reportFiles = [{
    reportKey: 'position-e13-b-report',
    filePath: fixture.reportPath,
    sha256: fixture.reportEvidence.sha256,
    sizeBytes: fixture.reportEvidence.sizeBytes
  }];
  const frozen = await freezePositionSourceSnapshot({
    store: fixture.store,
    templatePath: TEMPLATE_PATH,
    variant: 'filtered',
    runId: fixture.run.id,
    filters: {},
    reportFiles
  });
  await writeRunFilteredSourcesWorkbook({
    outputPath: legacyPath,
    run: fixture.store.getRun(fixture.run.id),
    filteredSources: fixture.store.listRunFilteredSources(fixture.run.id),
    reportFiles
  });
  const plan = createGenerationPlan(workerRoot, 'filtered.xlsx');
  const result = await executePositionReadOnlyExport(
    workerInput(fixture, frozen, plan),
    null
  );
  assert.equal(result.summary.variant, 'filtered');
  assert.equal(result.summary.rowCount, 1);
  assert.deepEqual(
    readWorkbookBusinessEvidence(plan.generationPath),
    readWorkbookBusinessEvidence(legacyPath)
  );
});

test('E13-B Position managed export 先验证后单次 Publisher，发布后元数据失败仅告警', async (t) => {
  const fixture = createRunFixture();
  const root = fs.mkdtempSync(path.join(fixture.userDataDir, 'managed-'));
  t.after(() => {
    fixture.service.close();
    fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
  });
  const frozen = await freezePositionSourceSnapshot({
    store: fixture.service.store,
    templatePath: TEMPLATE_PATH,
    variant: 'run',
    runId: fixture.run.runId,
    filters: {},
    reportFiles: []
  });
  const generationPlan = createGenerationPlan(root, 'managed.xlsx');
  const input = workerInput(fixture, frozen, generationPlan);
  let publisherCalls = 0;
  let sourceChecks = 0;
  const generated = await generateValidateAndPublishPositionExport({
    runtime: {
      async execute(request) {
        return {
          outcome: 'completed',
          terminalSource: 'job:done',
          result: await executePositionReadOnlyExport(request.input, null)
        };
      }
    },
    actionKey: POSITION_READ_ONLY_ACTION,
    operationKey: 'position-e13-b-operation',
    taskRunId: 'position-e13-b-task',
    batchContext: {
      taskRunId: 'position-e13-b-task',
      taskKey: 'position-reconciliation:run:export',
      moduleId: 'position-reconciliation',
      parentRunId: 'position-e13-b-parent',
      operationKey: 'position-e13-b-operation'
    },
    stableRunEvidence: frozen.evidence,
    dbPathOrManagedSource: input.dbPathOrManagedSource,
    generationPlan,
    context: frozen.context,
    production: false,
    async assertSourceFresh() {
      sourceChecks += 1;
      return assertPositionSourceSnapshot(
        await freezePositionSourceSnapshot({
          store: fixture.service.store,
          templatePath: TEMPLATE_PATH,
          variant: 'run',
          runId: fixture.run.runId,
          filters: {},
          reportFiles: []
        }),
        frozen.evidence
      );
    },
    publisher(artifacts) {
      publisherCalls += 1;
      assert.equal(artifacts.length, 1);
      return { taskId: 'position-e13-b-publisher', files: [] };
    }
  });
  assert.equal(generated.summary.rowCount, 1);
  assert.equal(publisherCalls, 1);
  assert.equal(sourceChecks, 3);

  let warnings = 0;
  const metadata = settlePositionPublishedMetadata({
    store: { markRunExported() { throw new Error('injected metadata failure'); } },
    variant: 'run',
    runId: fixture.run.runId,
    onWarning() { warnings += 1; }
  });
  assert.equal(warnings, 1);
  assert.equal(metadata.warnings.length, 1);
  assert.deepEqual(
    settlePositionPublishedMetadata({
      store: { markRunExported() { throw new Error('must not run'); } },
      variant: 'differences',
      runId: fixture.run.runId
    }).warnings,
    []
  );
});

test('E13-B Position 终态先收口 pending，再 ACK managed Publisher receipt', async () => {
  const calls = [];
  const terminal = Object.freeze({ terminalStatus: 'succeeded' });
  const settle = composePositionTerminalSettlement(
    async (value) => {
      assert.equal(value, terminal);
      calls.push('position-pending');
    },
    async (value) => {
      assert.equal(value, terminal);
      calls.push('publisher-receipt');
    }
  );
  await settle(terminal);
  assert.deepEqual(calls, ['position-pending', 'publisher-receipt']);

  const blocked = [];
  const failClosed = composePositionTerminalSettlement(
    async () => {
      blocked.push('position-pending');
      throw new Error('injected pending settlement failure');
    },
    async () => { blocked.push('publisher-receipt'); }
  );
  await assert.rejects(
    () => failClosed(terminal),
    /injected pending settlement failure/
  );
  assert.deepEqual(blocked, ['position-pending']);
});
