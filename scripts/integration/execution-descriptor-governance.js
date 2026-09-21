'use strict';

// G7 execution descriptor 治理集成：实际 composition → runtime → thread/inline/service/adapter。
// 四个场景均使用临时 XLSX/SQLite；adapter 再接 G2 invocation、TaskLifecycle、归档副本和 outbox。
// 不注入替代 worker/runtime；生产关闭的策略仍用 production:false，不改变 feature flag。
// 覆盖有界输入的载体装配/结果/退出释放；不替代 G1 故障恢复、Windows packaged 或 GUI 验收。
// 用法：node scripts/integration/execution-descriptor-governance.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const {
  createBackgroundExecutionRuntime,
  createTaskPolicyRegistry
} = require('../../src/main-process/execution-descriptors/composition');
const { createGenerationInput } = require('../../src/main-process/toolbox-background/generation-validator');
const { validateToolboxGenerationResult } = require('../../src/main-process/toolbox-background/generation-contract');
const { createNewAccountWorkerInput } = require('../../src/main-process/new-account/generation-validator');
const { executeNewAccountGeneration } = require('../../src/main-process/new-account/generation-core');
const { createNewAccountSaveAsInput, validateNewAccountSaveAsResult } = require('../../src/main-process/new-account/artifact-copy');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const { BANK_STATEMENT_SHEET_NAME } = require('../../src/main-process/bank-statement-io');
const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createBusinessFlowResolver } = require('../../src/main-process/archive-center/business-flow-resolver');
const { createArchiveOperationTracker } = require('../../src/main-process/archive-center/operation-tracker');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');
const { createTaskAdapterRegistry } = require('../../src/main-process/task-adapters/registry');
const { createPassthroughTaskAdapter } = require('../../src/main-process/task-adapters/passthrough');
const { createPreparedResourceScope } = require('../../src/main-process/task-adapters/prepared-resources');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-descriptor-governance-'));
let passed = 0;
let cleanupSafe = true;
function directory(name) {
  const value = path.join(root, name);
  fs.mkdirSync(value, { recursive: true });
  return value;
}
function writeWorkbook(filePath, rows, sheetName = 'Data') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}
function workbookRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
}
function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function operation(actionKey, taskKey, moduleId) {
  return { kind: 'operation', value: {
    taskRunId: `task-${actionKey}`, taskKey, moduleId,
    parentRunId: `parent-${actionKey}`, operationKey: `operation-${actionKey}`
  } };
}
function filePlan(sourcePaths, outputPaths, actionKey) {
  return normalizeFilePlanV1({ version: 1, allocation: 'eager',
    inputs: sourcePaths.map((filePath) => ({ filePath, role: 'input', sourceOperation: actionKey })),
    outputs: outputPaths.map((filePath) => ({ filePath, role: 'output', sourceOperation: actionKey }))
  });
}
async function usingRuntime(run) {
  const runtime = createBackgroundExecutionRuntime({
    availableParallelism: 4,
    freeMemoryBytes: 8 * 1024 ** 3,
    totalMemoryBytes: 16 * 1024 ** 3,
    memoryHardCeilingBytes: 8 * 1024 ** 3,
    systemReserveBytes: 0,
    executionTimeoutMs: 20000,
    shutdownTimeoutMs: 10000
  });
  try {
    return await run(runtime);
  } finally {
    // 清理临时文件前必须等真实退出屏障；未释放资源使本场景失败。
    try {
      const report = await runtime.shutdown({ timeoutMs: 10000 });
      assert.deepEqual(report.leakedTransports, []);
      assert.deepEqual(report.errors, []);
      const snapshot = runtime.resourceGovernor.snapshot();
      assert.equal(snapshot.activeLeaseCount, 0);
      assert.equal(snapshot.activeDependencyCount, 0);
      assert.ok(Object.values(snapshot.activeUsage).every((value) => value === 0));
    } catch (error) {
      cleanupSafe = false;
      throw error;
    }
  }
}
function completed(execution) {
  assert.equal(execution.outcome, 'completed', JSON.stringify(execution));
  assert.equal(execution.terminalSource, 'job:done');
  return execution.result;
}
async function check(name, run) {
  await run();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

async function threadScenario() {
  const dir = directory('thread');
  const rows = [['Name', 'LongId'], ['A', '001234567890123456789'], ['B', '000000000000000000002']];
  const first = writeWorkbook(path.join(dir, 'first.xlsx'), rows.slice(0, 2));
  const second = writeWorkbook(path.join(dir, 'second.xlsx'), [rows[0], rows[2]]);
  const output = path.join(dir, 'generated.xlsx');
  const target = path.join(dir, 'final.xlsx');
  const actionKey = 'toolbox:merge';
  const context = operation(actionKey, 'toolbox:merge', 'toolbox');
  const input = createGenerationInput({ actionKey,
    filePlan: filePlan([first, second], [target], actionKey),
    generationPath: output, operationConfig: { sheetBaseName: 'COMMON' } });
  await usingRuntime(async (runtime) => {
    assert.equal(runtime.policyRegistry.get(actionKey).mode, 'thread-single');
    await assert.rejects(runtime.execute({ actionKey, operationKey: context.value.operationKey,
      production: true, context, input }), { code: 'POLICY_PRODUCTION_DISABLED' });
    const result = completed(await runtime.execute({ actionKey, operationKey: context.value.operationKey,
      production: false, context, input }));
    assert.equal(validateToolboxGenerationResult(result, actionKey), true);
    assert.equal(result.summary.outputDataRowCount, 2);
    assert.deepEqual(workbookRows(output), rows);
    assert.equal(fs.existsSync(target), false, '生成载体不能越过 Main publication');
  });
}

async function inlineScenario() {
  const dir = directory('inline');
  const sourceDir = directory('inline/source');
  const stagingRoot = directory('inline/staging');
  const templatePath = path.resolve(__dirname, '../../assets/余额账单模版.xlsx');
  const sourcePath = path.join(sourceDir, 'source.xlsx');
  const generationInput = createNewAccountWorkerInput({
    filePlan: filePlan([templatePath], [path.join(dir, 'generation-target.xlsx')], 'new-account:generate'),
    templatePath,
    payload: { accounts: [{ bankName: '测试银行', location: '上海', bankAccount: '622200001234',
      openingDate: '2026-02-28', isMultiCurrency: false, currency: 'CNY', currencies: [] }] },
    asOfDate: '2026-03-02', stagingRoot: sourceDir,
    stagingResourceId: path.basename(sourcePath), generationPath: sourcePath
  });
  const generated = await executeNewAccountGeneration(generationInput, null, { allowedTemplatePath: templatePath });
  const actionKey = 'new-account:save-as';
  const target = path.join(dir, 'final.xlsx');
  const stagingPath = path.join(stagingRoot, 'copied.xlsx');
  const input = createNewAccountSaveAsInput({
    filePlan: filePlan([sourcePath], [target], actionKey), sourceGenerationResult: generated,
    stagingRoot, stagingResourceId: 'copied.xlsx', stagingPath
  });
  const context = operation(actionKey, 'new-account:export', 'new-account');
  await usingRuntime(async (runtime) => {
    assert.equal(runtime.policyRegistry.get(actionKey).mode, 'inline-async');
    const result = completed(await runtime.execute({ actionKey, operationKey: context.value.operationKey,
      production: false, context, input }));
    assert.equal(validateNewAccountSaveAsResult(result), true);
    assert.equal(sha256(stagingPath), sha256(sourcePath));
    assert.deepEqual(workbookRows(stagingPath), workbookRows(sourcePath));
    assert.equal(fs.existsSync(target), false, 'inline copy 不得自行发布最终文件');
  });
}

async function serviceScenario() {
  const dir = directory('service');
  const source = (name, count) => writeWorkbook(path.join(dir, name), [BANK_STATEMENT_FIELDS,
    ...Array.from({ length: count }, (_, index) => BANK_STATEMENT_FIELDS.map((field) => `${field}-${index + 1}`))],
  BANK_STATEMENT_SHEET_NAME);
  const first = source('one.xlsx', 1);
  const second = source('two.xlsx', 2);
  await usingRuntime(async (runtime) => {
    const actionKey = 'fund-recon:import';
    assert.equal(runtime.policyRegistry.get(actionKey).lifetime, 'service');
    for (const [index, filePath] of [first, second].entries()) {
      const context = operation(`${actionKey}-${index}`, 'bank-statement:import', 'fund-recon');
      const result = completed(await runtime.execute({ actionKey, operationKey: context.value.operationKey,
        production: false, context, input: { sources: [{ kind: 'bank', filePath }] } }));
      assert.equal(result.stateRevision, index + 1);
      assert.equal(result.summary.bankRowCount, index + 1);
      assert.equal(result.summary.sourceFileCount, 1);
      assert.equal(JSON.stringify(result).includes(dir), false);
    }
  });
}

async function adapterScenario() {
  const dir = directory('adapter');
  const dbPath = path.join(dir, 'business.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec('CREATE TABLE imported_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT, k TEXT UNIQUE, amount TEXT)');
  setup.prepare('INSERT INTO imported_rows(d,k,amount) VALUES(?,?,?)').run('2026-08-01', 'OLD', '99');
  setup.close();
  const sourcePath = writeWorkbook(path.join(dir, 'source.xlsx'), [
    ['日期', '主键', '金额'], ['2026-08-02', 'NEW-1', '12.34'], ['2026-08-03', 'NEW-2', '56.78']
  ]);
  const sourceDigest = sha256(sourcePath);
  const db = new DatabaseSync(path.join(dir, 'archive.sqlite'));
  const archiveRoot = path.join(dir, 'archive');
  const service = createArchiveService({ database: db, rootDir: archiveRoot });
  const outbox = createArchiveOutboxStore(path.join(dir, 'outbox'));
  const warnings = [];
  const settings = new Map();
  const controller = createArchiveCenterController({ service, outboxStore: outbox,
    database: { getSetting: (name) => settings.get(name), setSetting: (name, value) => settings.set(name, value), listTemplates: () => [] },
    logWarning: (...args) => warnings.push(args) });
  const bor = createBusinessOperationRegistry();
  const lifecycle = createTaskLifecycle({ businessOperationRegistry: bor, archiveService: service,
    flowResolver: createBusinessFlowResolver({ archiveService: service }),
    operationTracker: createArchiveOperationTracker({ sink: controller.sink }),
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload),
    onArchiveWarning: (warning) => warnings.push(warning) });
  const policy = createTaskPolicyRegistry().require('pending:import:start');
  const adapterRegistry = createTaskAdapterRegistry({ adapters: [createPassthroughTaskAdapter()],
    taskBindings: [{ taskKey: policy.taskKey, adapterId: 'passthrough' }] });
  const prepared = { taskRunId: 'descriptor-pending-task', operationKey: 'descriptor-pending-operation',
    filePlan: filePlan([sourcePath], [], policy.channel),
    onAbandon() { assert.fail('已经执行的业务不得 abandon'); } };
  const invocation = adapterRegistry.resolve(policy.taskKey).createInvocation({ policy, prepared });
  const scope = createPreparedResourceScope(prepared);
  let batchContext;
  try {
    await controller.initialize();
    await usingRuntime(async (runtime) => {
      const actionKey = 'pending:import';
      assert.equal(runtime.policyRegistry.get(actionKey).adapterKind, 'existing-dispatch');
      assert.equal(runtime.policyRegistry.get(actionKey).production.enabled, false);
      const result = await scope.run(() => {
        scope.enterLifecycle();
        return lifecycle.runFileTask({ meta: { channel: policy.channel }, policy, prepared, ...invocation.identity,
          afterTerminalIntent: invocation.afterTerminalIntent, afterTerminal: invocation.afterTerminal,
          filePlanResolver: () => policy.filePlanResolver({ prepared }),
          resultFlowIdentities: (result, context) => policy.resultFlowIdentities(result, context, { prepared }),
          execute(context) {
            batchContext = context;
            return invocation.execute({ markExecuteStarted: scope.markExecuteStarted,
              async executeBusiness() {
                return completed(await runtime.execute({ actionKey, operationKey: context.operationKey,
                  production: false, context: { kind: 'file-batch', value: context }, input: {
                    dbPath, files: [sourcePath],
                    contractModulePath: require.resolve('../../tests/fixtures/execution-descriptors/pending-import-contract'),
                    contractOptions: {}, mode: 'overwrite', monthKey: '2026-08', batchContext: context
                  } }));
              } });
          }
        });
      });
      assert.deepEqual(result, { monthKey: '2026-08', fileCount: 1, totalImported: 2, deletedCount: 1, maxParallel: 1 });
    });
    assert.deepEqual(scope.snapshot(), { owner: 'execution', abandonAttempted: false });
    assert.equal(bor.listActive().length, 0);
    assert.equal(service.repository.getTaskRun(prepared.taskRunId).status, 'succeeded');
    const batch = service.repository.getBatchDetail(batchContext.batchId);
    assert.equal(batch.taskStatus, 'succeeded');
    assert.equal(batch.artifacts.length, 1);
    assert.equal(batch.artifacts[0].status, 'ready');
    assert.equal(sha256(path.join(archiveRoot, batch.artifacts[0].blob.relativePath)), sourceDigest);
    assert.equal(sha256(sourcePath), sourceDigest);
    await controller.flushOutbox();
    assert.equal(outbox.list().length, 0);
    assert.deepEqual(warnings, []);
    const business = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(business.prepare('SELECT d,k,amount FROM imported_rows ORDER BY id').all().map((row) => ({ ...row })), [
        { d: '2026-08-02', k: 'NEW-1', amount: '12.34' },
        { d: '2026-08-03', k: 'NEW-2', amount: '56.78' }
      ]);
    } finally { business.close(); }
  } finally { db.close(); }
}

async function main() {
  await check('thread：真实 Toolbox Worker 生成并回读 XLSX，保留 production gate 和退出释放', threadScenario);
  await check('inline：真实 NewAccount copy 保持源/暂存件 SHA256 与 workbook 内容', inlineScenario);
  await check('service：真实 FundRecon Worker 连续导入保留 stateRevision，shutdown 释放租约', serviceScenario);
  await check('adapter：既有导入引擎写 SQLite，G2/TaskLifecycle 留下成功 TaskRun 与归档输入', adapterScenario);
  process.stdout.write(`==== ${passed}/${passed} PASS ====\n`);
}
main().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; })
  .finally(() => {
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
    else console.error('退出屏障未证实，保留隔离材料：', root);
  });
