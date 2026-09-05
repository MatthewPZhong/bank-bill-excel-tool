'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx-js-style');

const { AppDatabase } = require('../../../src/backend/database');
const runDataStore = require('../../../src/backend/run-data-store');
const runRepo = require('../../../src/backend/acquiring-bill-currency-db/run-repository');
const acquiringRunData = require('../../../src/main-process/acquiring-bill-currency-run-data');
const {
  writeDiffWorkbook
} = require('../../../src/main-process/acquiring-bill-currency-writer');
const {
  executeAcquiringExport
} = require('../../../src/main-process/read-only-exports/acquiring/executor');
const {
  generateValidateAndPublishAcquiringExport
} = require('../../../src/main-process/read-only-exports/acquiring/managed-export');
const {
  ACQUIRING_EXPORT_ACTIONS,
  ACQUIRING_EXPORT_POLICIES,
  validateAcquiringExportResult
} = require('../../../src/main-process/read-only-exports/acquiring/policies');
const {
  assertAcquiringCopySourceFresh,
  assertAcquiringRegenerateSourceFresh,
  freezeAcquiringCopySource,
  freezeAcquiringRegenerateSource
} = require('../../../src/main-process/read-only-exports/acquiring/query');
const {
  readWorkbookBusinessEvidence
} = require('../../../src/main-process/read-only-exports/common/workbook-evidence');
const {
  bindingSnapshot
} = require('../../../src/main-process/background-execution/action-task-binding-registry');
const {
  BACKGROUND_EXECUTION_POLICIES,
  createBackgroundExecutionRuntime
} = require('../../../src/main-process/background-execution/runtime');

function createGenerationPlan(root, name) {
  return Object.freeze({
    stagingRoot: root,
    stagingResourceId: name,
    generationPath: path.join(root, name),
    outputArtifactKey: `artifact-${name}`
  });
}

function workerInput(actionKey, frozen, generationPlan, operationKey = 'acquiring-e13-c-operation') {
  return {
    actionKey,
    operationKey,
    taskRunId: 'acquiring-e13-c-task',
    stableRunEvidence: frozen.stableRunEvidence,
    dbPathOrManagedSource: frozen.dbPathOrManagedSource,
    generationPlan,
    context: frozen.context
  };
}

function normalizedWorkbookSemantic(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const volatileSummaryKeys = new Set([
    '差异表写入耗时 (ms)',
    '差异表路径',
    '生成时间'
  ]);
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: null
    }).filter((row) => name !== '运行结果汇总' || !volatileSummaryKeys.has(row[0]))
  }));
}

function seedFixture() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-e13-c-'));
  const dbPath = path.join(userDataDir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const db = appDb.db;
  const monthKey = '2026-08';
  const sourcePath = path.join(userDataDir, 'existing-diff.xlsx');
  fs.writeFileSync(sourcePath, Buffer.from('stable-existing-diff-e13-c'));
  const runId = runRepo.insertRun(db, {
    monthKey,
    ranAt: '2026-08-30T00:00:00.000Z',
    totalBillRows: 1,
    matchedRows: 1,
    mismatchRows: 1,
    unmatchedRows: 0,
    status: 'success'
  });
  const bill = db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports(
      month_key, source_file, source_row_index, recon_main_id,
      settle_currency, settle_currency_norm, raw_json
    ) VALUES (?, 'bill.xlsx', 2, 'ACQ-E13-C-1', 'EUR', 'eur', ?)
  `).run(monthKey, JSON.stringify({
    账单日期: '2026-08-29',
    对账币种: 'EUR',
    商户订单号: 'ACQ-E13-C-1'
  }));
  db.prepare(`
    INSERT INTO acquiring_bill_currency_flow_imports(
      month_key, source_file, source_row_index, recon_main_id,
      settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json
    ) VALUES (?, 'flow.xlsx', 2, 'ACQ-E13-C-1', '100', '100', 'USD', 'usd', '{}')
  `).run(monthKey);
  db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows(
      run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type
    ) VALUES (?, ?, 'USD', '100', 'currency_mismatch')
  `).run(runId, Number(bill.lastInsertRowid));
  runRepo.updateRunPaths(db, {
    runId,
    diffFilePath: sourcePath,
    reportFilePath: sourcePath
  });
  runRepo.setRunChunkProgress(db, {
    runId,
    lastCompletedChunkIndex: 0,
    totalChunks: 1,
    status: 'complete',
    chunkSize: 1,
    outputIntent: { diffFilePath: sourcePath, reportFilePath: sourcePath }
  });
  return {
    appDb,
    db,
    dbPath,
    monthKey,
    runId,
    sourcePath,
    userDataDir,
    close() {
      try { db.close(); } catch (_error) { /* already closed */ }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

test('E13-C Acquiring action 分类、运行时拓扑和 legacy binding 精确分离', () => {
  const policies = Object.fromEntries(
    ACQUIRING_EXPORT_POLICIES.map((policy) => [policy.actionKey, policy])
  );
  assert.equal(policies[ACQUIRING_EXPORT_ACTIONS.COPY].mode, 'inline-async');
  assert.equal(policies[ACQUIRING_EXPORT_ACTIONS.REGENERATE].mode, 'thread-single');
  assert.equal(policies[ACQUIRING_EXPORT_ACTIONS.COPY].production.enabled, false);
  assert.equal(policies[ACQUIRING_EXPORT_ACTIONS.REGENERATE].production.enabled, false);
  assert.deepEqual(bindingSnapshot()[ACQUIRING_EXPORT_ACTIONS.COPY], [
    'acquiringBillCurrency:export'
  ]);
  assert.deepEqual(bindingSnapshot()[ACQUIRING_EXPORT_ACTIONS.REGENERATE], []);
  assert.equal(
    BACKGROUND_EXECUTION_POLICIES.filter((policy) => (
      [ACQUIRING_EXPORT_ACTIONS.COPY, ACQUIRING_EXPORT_ACTIONS.REGENERATE]
        .includes(policy.actionKey)
    )).length,
    2
  );
});

test('E13-C copy 冻结普通文件并异步复制到 task staging，结果逐字节一致', async (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const frozen = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'copy-staging-'));
  const plan = createGenerationPlan(stagingRoot, 'copy.xlsx');
  const result = await executeAcquiringExport(
    workerInput(ACQUIRING_EXPORT_ACTIONS.COPY, frozen, plan),
    null
  );
  assert.equal(validateAcquiringExportResult(result), true);
  assert.deepEqual(fs.readFileSync(plan.generationPath), fs.readFileSync(fixture.sourcePath));
  assert.equal(result.artifacts[0].sha256, frozen.dbPathOrManagedSource.contentSha256);
  assert.equal(result.artifacts[0].businessDigest, result.artifacts[0].sha256);
  assert.equal(result.artifacts[0].sheetCount, 0);
  await assertAcquiringCopySourceFresh(frozen, {
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db
  });
});

test('E13-C copy 对 source 内容变化、symlink 和取消全部 fail closed', async (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const frozen = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  fs.appendFileSync(fixture.sourcePath, 'tamper');
  await assert.rejects(
    assertAcquiringCopySourceFresh(frozen, {
      userDataDir: fixture.userDataDir,
      mainDb: fixture.db
    }),
    (error) => error && error.code === 'ACQUIRING_EXPORT_SOURCE_STALE'
  );

  const symlinkPath = path.join(fixture.userDataDir, 'symlink.xlsx');
  fs.symlinkSync(fixture.sourcePath, symlinkPath);
  runRepo.updateRunPaths(fixture.db, {
    runId: fixture.runId,
    diffFilePath: symlinkPath,
    reportFilePath: symlinkPath
  });
  await assert.rejects(
    freezeAcquiringCopySource({
      userDataDir: fixture.userDataDir,
      mainDb: fixture.db,
      monthKey: fixture.monthKey
    }),
    (error) => error && error.code === 'ACQUIRING_EXPORT_SOURCE_INVALID'
  );

  runRepo.updateRunPaths(fixture.db, {
    runId: fixture.runId,
    diffFilePath: fixture.sourcePath,
    reportFilePath: fixture.sourcePath
  });
  const refreshed = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'cancel-staging-'));
  const plan = createGenerationPlan(stagingRoot, 'cancelled.xlsx');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    executeAcquiringExport(
      workerInput(ACQUIRING_EXPORT_ACTIONS.COPY, refreshed, plan),
      controller.signal
    ),
    (error) => error && error.code === 'ACQUIRING_EXPORT_CANCELLED'
  );
  assert.equal(fs.existsSync(plan.generationPath), false);
});

test('E13-C regenerate 只接受 complete success run，使用只读 DB 生成并回读 workbook', async (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const before = fs.statSync(fixture.dbPath).mtimeMs;
  const frozen = freezeAcquiringRegenerateSource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    mainDatabasePath: fixture.dbPath,
    monthKey: fixture.monthKey
  });
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'regenerate-staging-'));
  const plan = createGenerationPlan(stagingRoot, 'regenerated.xlsx');
  const result = await executeAcquiringExport(
    workerInput(ACQUIRING_EXPORT_ACTIONS.REGENERATE, frozen, plan),
    null
  );
  const legacyPath = path.join(fixture.userDataDir, 'legacy-regenerated.xlsx');
  await writeDiffWorkbook({
    db: fixture.db,
    runId: fixture.runId,
    monthKey: fixture.monthKey,
    savePath: legacyPath,
    runElapsedMs: null
  });
  assert.equal(validateAcquiringExportResult(result), true);
  assert.deepEqual(readWorkbookBusinessEvidence(plan.generationPath), {
    businessDigest: result.artifacts[0].businessDigest,
    sheetCount: result.artifacts[0].sheetCount,
    dataRowCount: result.artifacts[0].dataRowCount
  });
  assert.deepEqual(
    normalizedWorkbookSemantic(plan.generationPath),
    normalizedWorkbookSemantic(legacyPath),
    '去除时间/路径/耗时后，managed regenerate 与 legacy writer 业务语义必须一致'
  );
  assert.equal(result.artifacts[0].sheetCount, 2);
  assert.equal(fs.statSync(fixture.dbPath).mtimeMs, before, '只读 regenerate 不得改写 DB');
  assertAcquiringRegenerateSourceFresh(frozen, {
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    mainDatabasePath: fixture.dbPath
  });
});

test('E13-C Supervisor 按 action 分别执行 inline copy 与 thread-single regenerate', async (t) => {
  const fixture = seedFixture();
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 4 * 1024 ** 3
  });
  t.after(async () => {
    await runtime.shutdown({ timeoutMs: 5000 });
    fixture.close();
  });
  const copy = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  const regenerate = freezeAcquiringRegenerateSource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    mainDatabasePath: fixture.dbPath,
    monthKey: fixture.monthKey
  });
  for (const [index, [actionKey, frozen]] of [
    [ACQUIRING_EXPORT_ACTIONS.COPY, copy],
    [ACQUIRING_EXPORT_ACTIONS.REGENERATE, regenerate]
  ].entries()) {
    const operationKey = `acquiring-e13-c-runtime-${index + 1}`;
    const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, `runtime-${index + 1}-`));
    const execution = await runtime.execute({
      actionKey,
      operationKey,
      production: false,
      context: {
        kind: 'operation',
        value: {
          taskRunId: 'acquiring-e13-c-task',
          taskKey: 'acquiringBillCurrency:export',
          moduleId: 'acquiring-bill-currency',
          parentRunId: 'acquiring-e13-c-parent',
          operationKey
        }
      },
      input: workerInput(
        actionKey,
        frozen,
        createGenerationPlan(stagingRoot, `${index + 1}.xlsx`),
        operationKey
      )
    });
    assert.equal(execution.outcome, 'completed');
    assert.equal(execution.terminalSource, 'job:done');
    assert.equal(execution.result.actionKey, actionKey);
  }
});

test('E13-C regenerate 精确解析 per-month side DB 镜像并在侧库只读生成', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquiring-e13-c-side-'));
  const appDb = new AppDatabase(path.join(userDataDir, 'tool-data.sqlite'));
  appDb.init();
  const mainDb = appDb.db;
  const monthKey = '2026-09';
  const sourcePath = path.join(userDataDir, 'side-existing.xlsx');
  fs.writeFileSync(sourcePath, 'side-stable-existing');
  const sideDb = runDataStore.openSideDb(
    userDataDir,
    runDataStore.MODULE_ACQUIRING,
    monthKey
  );
  t.after(() => {
    try { sideDb.close(); } catch (_error) { /* already closed */ }
    try { mainDb.close(); } catch (_error) { /* already closed */ }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  const runId = runRepo.insertRun(sideDb, {
    monthKey,
    ranAt: '2026-09-30T00:00:00.000Z',
    totalBillRows: 1,
    matchedRows: 1,
    mismatchRows: 1,
    unmatchedRows: 0,
    status: 'success'
  });
  const bill = sideDb.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports(
      month_key, source_file, source_row_index, recon_main_id,
      settle_currency, settle_currency_norm, raw_json
    ) VALUES (?, 'side-bill.xlsx', 2, 'ACQ-E13-C-SIDE', 'EUR', 'eur', ?)
  `).run(monthKey, JSON.stringify({ 账单日期: '2026-09-29', 对账币种: 'EUR' }));
  sideDb.prepare(`
    INSERT INTO acquiring_bill_currency_flow_imports(
      month_key, source_file, source_row_index, recon_main_id,
      settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json
    ) VALUES (?, 'side-flow.xlsx', 2, 'ACQ-E13-C-SIDE', '100', '100', 'USD', 'usd', '{}')
  `).run(monthKey);
  sideDb.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows(
      run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type
    ) VALUES (?, ?, 'USD', '100', 'currency_mismatch')
  `).run(runId, Number(bill.lastInsertRowid));
  runRepo.updateRunPaths(sideDb, { runId, diffFilePath: sourcePath, reportFilePath: sourcePath });
  runRepo.setRunChunkProgress(sideDb, {
    runId,
    lastCompletedChunkIndex: 0,
    totalChunks: 1,
    status: 'complete',
    chunkSize: 1,
    outputIntent: { diffFilePath: sourcePath, reportFilePath: sourcePath }
  });
  acquiringRunData.upsertMainRunMirror(mainDb, {
    monthKey,
    relPath: runDataStore.sideDbRelPath(runDataStore.MODULE_ACQUIRING, monthKey),
    stats: { totalBillRows: 1, matchedRows: 1, mismatchRows: 1, unmatchedRows: 0 },
    status: 'success',
    diffFilePath: sourcePath,
    reportFilePath: sourcePath,
    ranAt: '2026-09-30T00:00:00.000Z'
  });
  const frozen = freezeAcquiringRegenerateSource({
    userDataDir,
    mainDb,
    mainDatabasePath: appDb.dbPath,
    monthKey
  });
  assert.equal(frozen.dbPathOrManagedSource.sourceKind, 'side');
  assert.equal(frozen.context.runId, runId);
  const stagingRoot = fs.mkdtempSync(path.join(userDataDir, 'side-staging-'));
  const result = await executeAcquiringExport(
    workerInput(
      ACQUIRING_EXPORT_ACTIONS.REGENERATE,
      frozen,
      createGenerationPlan(stagingRoot, 'side-regenerated.xlsx')
    ),
    null
  );
  assert.equal(result.summary.runId, runId);
  assert.equal(result.artifacts[0].sheetCount, 2);
});

test('E13-C regenerate 拒绝 partial、data-complete、progress 缺失和 source 漂移', (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const freeze = () => freezeAcquiringRegenerateSource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    mainDatabasePath: fixture.dbPath,
    monthKey: fixture.monthKey
  });
  for (const status of ['partial', 'data-complete', 'in-progress']) {
    runRepo.setRunChunkProgress(fixture.db, {
      runId: fixture.runId,
      lastCompletedChunkIndex: 0,
      totalChunks: 1,
      status,
      chunkSize: 1
    });
    assert.throws(freeze, (error) => error && error.code === 'ACQUIRING_REGENERATE_RUN_NOT_COMPLETE');
  }
  fixture.db.prepare(`UPDATE acquiring_bill_currency_runs SET chunk_progress = NULL WHERE id = ?`)
    .run(fixture.runId);
  assert.throws(freeze, (error) => error && error.code === 'ACQUIRING_REGENERATE_RUN_NOT_COMPLETE');

  runRepo.setRunChunkProgress(fixture.db, {
    runId: fixture.runId,
    lastCompletedChunkIndex: 0,
    totalChunks: 1,
    status: 'complete',
    chunkSize: 1
  });
  const frozen = freeze();
  fixture.db.prepare(`UPDATE acquiring_bill_currency_diff_rows SET flow_amount_abs = '101' WHERE run_id = ?`)
    .run(fixture.runId);
  assert.throws(
    () => assertAcquiringRegenerateSourceFresh(frozen, {
      userDataDir: fixture.userDataDir,
      mainDb: fixture.db,
      mainDatabasePath: fixture.dbPath
    }),
    (error) => error && error.code === 'ACQUIRING_EXPORT_SOURCE_STALE'
  );
});

test('E13-C managed export 在执行、校验、发布边界三次复核 source 且 Publisher 单次调用', async (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const frozen = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  const stagingRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'managed-staging-'));
  const plan = createGenerationPlan(stagingRoot, 'managed-copy.xlsx');
  let sourceChecks = 0;
  let publisherCalls = 0;
  const generated = await generateValidateAndPublishAcquiringExport({
    runtime: {
      async execute(request) {
        return {
          outcome: 'completed',
          terminalSource: 'job:done',
          result: await executeAcquiringExport(request.input, null)
        };
      }
    },
    actionKey: ACQUIRING_EXPORT_ACTIONS.COPY,
    operationKey: 'acquiring-e13-c-operation',
    taskRunId: 'acquiring-e13-c-task',
    batchContext: {
      taskRunId: 'acquiring-e13-c-task',
      taskKey: 'acquiringBillCurrency:export',
      moduleId: 'acquiring-bill-currency',
      parentRunId: 'acquiring-e13-c-parent',
      operationKey: 'acquiring-e13-c-operation'
    },
    stableRunEvidence: frozen.stableRunEvidence,
    dbPathOrManagedSource: frozen.dbPathOrManagedSource,
    generationPlan: plan,
    context: frozen.context,
    production: false,
    async assertSourceFresh() {
      sourceChecks += 1;
      return assertAcquiringCopySourceFresh(frozen, {
        userDataDir: fixture.userDataDir,
        mainDb: fixture.db
      });
    },
    publisher(artifacts) {
      publisherCalls += 1;
      assert.equal(artifacts.length, 1);
      return { taskId: 'acquiring-e13-c-publication', files: [] };
    }
  });
  assert.equal(generated.summary.kind, 'copy-existing-diff');
  assert.equal(sourceChecks, 3);
  assert.equal(publisherCalls, 1);
});

test('E13-C action/source 交叉输入与 Publisher 失败均不得被兼容或伪造成功', async (t) => {
  const fixture = seedFixture();
  t.after(() => fixture.close());
  const copy = await freezeAcquiringCopySource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    monthKey: fixture.monthKey
  });
  const regenerate = freezeAcquiringRegenerateSource({
    userDataDir: fixture.userDataDir,
    mainDb: fixture.db,
    mainDatabasePath: fixture.dbPath,
    monthKey: fixture.monthKey
  });
  const crossRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'cross-staging-'));
  await assert.rejects(
    executeAcquiringExport({
      ...workerInput(
        ACQUIRING_EXPORT_ACTIONS.COPY,
        copy,
        createGenerationPlan(crossRoot, 'cross.xlsx')
      ),
      dbPathOrManagedSource: regenerate.dbPathOrManagedSource
    }, null),
    (error) => error && error.code === 'READ_ONLY_EXPORT_CONTRACT_INVALID'
  );

  const publishRoot = fs.mkdtempSync(path.join(fixture.userDataDir, 'publish-staging-'));
  const plan = createGenerationPlan(publishRoot, 'publish-failure.xlsx');
  let publisherCalls = 0;
  await assert.rejects(
    generateValidateAndPublishAcquiringExport({
      runtime: {
        async execute(request) {
          return {
            outcome: 'completed',
            terminalSource: 'job:done',
            result: await executeAcquiringExport(request.input, null)
          };
        }
      },
      actionKey: ACQUIRING_EXPORT_ACTIONS.COPY,
      operationKey: 'acquiring-e13-c-operation',
      taskRunId: 'acquiring-e13-c-task',
      batchContext: {
        taskRunId: 'acquiring-e13-c-task',
        taskKey: 'acquiringBillCurrency:export',
        moduleId: 'acquiring-bill-currency',
        parentRunId: 'acquiring-e13-c-parent',
        operationKey: 'acquiring-e13-c-operation'
      },
      stableRunEvidence: copy.stableRunEvidence,
      dbPathOrManagedSource: copy.dbPathOrManagedSource,
      generationPlan: plan,
      context: copy.context,
      production: false,
      publisher() {
        publisherCalls += 1;
        const error = new Error('injected Publisher failure');
        error.code = 'ACQUIRING_E13_C_PUBLISHER_INJECTED';
        throw error;
      }
    }),
    (error) => error && error.code === 'ACQUIRING_E13_C_PUBLISHER_INJECTED'
  );
  assert.equal(publisherCalls, 1);
  assert.equal(fs.existsSync(plan.generationPath), true, '未发布 staging 留给 durable recovery/owner 清理');
});

test('E13-C main 保留 legacy copy 且 managed branch 只绑定 copy action', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  const start = mainSource.indexOf("trackedIpcHandle('acquiringBillCurrency:export'");
  const end = mainSource.indexOf(
    "businessIpcHandle('acquiringBillCurrency:clearMonth'",
    start
  );
  const source = mainSource.slice(start, end);
  assert.match(source, /ACQUIRING_EXPORT_ACTIONS\.COPY/);
  assert.match(source, /freezeAcquiringCopySource/);
  assert.match(source, /executeManagedAcquiringCopyExport/);
  assert.match(source, /fs\.copyFileSync\(exportPlan\.diffFilePath, output\.filePath\)/);
  assert.doesNotMatch(source, /ACQUIRING_EXPORT_ACTIONS\.REGENERATE/);
});
