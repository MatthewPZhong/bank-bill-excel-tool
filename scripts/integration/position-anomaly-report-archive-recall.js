'use strict';
// 平盘链接原始表导入的异常报告：暂存回收后从存档中心取回。
// 真实链路：来源导入任务合同 → Position adapter / owner → TaskLifecycle → 存档中心（文件计划、结算、终态）
// → 任务收尾回收暂存 → 业务入口导出异常报告（Main 的取回函数原样执行）。
// 侧库里记的是生成报告时的键，存档条目的键由文件计划另行分配；本脚本覆盖两者之间的查找，
// 不声称 Electron 进程、界面或 Windows 文件锁验收。
// 用法：node scripts/integration/position-anomaly-report-archive-recall.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { createPositionStartupRecoveryHarness } = require('../../tests/helpers/position-startup-recovery-harness');
const { createApplicationRecoveryComposition } = require('../../src/main-process/application-recovery/composition');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTerminalRouteRegistry } = require('../../src/main-process/archive-center/terminal-route-registry');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createBusinessFlowResolver } = require('../../src/main-process/archive-center/business-flow-resolver');
const { createArchiveOperationTracker } = require('../../src/main-process/archive-center/operation-tracker');
const {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('../../src/main-process/archive-center/ipc-task-contract');
const { createBusinessOperationRegistry } = require('../../src/main-process/business-operation-registry');
const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
const { createTaskAdapterRegistry } = require('../../src/main-process/task-adapters/registry');
const { createPreparedResourceScope } = require('../../src/main-process/task-adapters/prepared-resources');
const { createPositionTaskOwner } = require('../../src/main-process/position-reconciliation/task-owner');
const { createPositionTaskAdapter } = require('../../src/main-process/position-reconciliation/task-adapter');
const {
  createPositionSourceImportTaskContract
} = require('../../src/main-process/position-reconciliation/interactive-task-preflight');
const { STAGING_RELATIVE_PATH } = require('../../src/main-process/position-reconciliation/input-staging');
const {
  POSITION_SIDE_DB_PENDING_SETTING,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../src/main-process/position-reconciliation/constants');

const CHANNEL = 'position-reconciliation:source:prepare-import';
const GENERATED_REPORT_KEY = 'source-import-anomaly-report';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'position-anomaly-report-recall-'));
const policies = createTaskPolicyRegistry();
let passed = 0;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeFundTransfer(filePath) {
  const definition = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER];
  const base = {
    调拨单号: 'FT-NORMAL-1', 调拨状态: '付款成功', 渠道流水号: 'FT-RID-1',
    交易时间: new Date(2026, 6, 20, 1, 30), '付款账户（卡号）': 'PAY-1', '收款账户（卡号）': 'REC-1',
    付款金额: 100, 付款币种: 'USD', 收款金额: 95, 收款币种: 'EUR'
  };
  const rows = [base, { ...base, 调拨单号: 'FT-FILTERED-1', 调拨状态: '处理中', 付款金额: '' }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    definition.headers,
    ...rows.map((row) => definition.headers.map((header) => row[header] ?? ''))
  ]), `${definition.sourceName}-数据`);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function boot(directory) {
  const dbPath = path.join(directory, 'main.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS startup_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const diagnostics = [];
  const tracked = [];
  const database = { db, dbPath,
    getSetting: (name) => db.prepare('SELECT value FROM startup_settings WHERE name=?').get(name)?.value || '',
    setSetting(name, value) {
      db.prepare('INSERT INTO startup_settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(name, String(value));
    },
    listTemplates: () => []
  };
  const main = createPositionStartupRecoveryHarness({ database, diagnostics, tracked });
  let controller;
  let lifecycle;
  const owner = createPositionTaskOwner({
    readSetting: database.getSetting, writeSetting: database.setSetting, settingsAvailable: () => true,
    getDatabasePath: () => dbPath, getCurrentService: main.currentService, getService: main.getService,
    getArchiveCenter: () => controller, initializeArchiveCenter: () => controller,
    getTaskLifecycle: () => lifecycle, getTaskPolicy: (key) => policies.require(key),
    supportsArchiveChannel: (key) => policies.require(key).taskKind === 'file'
  });
  const service = createArchiveService({ database: db, rootDir: path.join(directory, 'archive'),
    onSourceReleased: owner.cleanupPositionArchiveSourcePaths });
  const outbox = createArchiveOutboxStore(path.join(directory, 'outbox'));
  const noop = async () => {};
  const application = createApplicationRecoveryComposition({
    platform: { scanAndRecover: async () => ({ sourceCount: 0, activeHoldCount: 0 }), recoverSource: noop },
    recoverPreFundRuns: noop,
    recoverPosition: main.recover,
    recoverToolboxVccPublications: noop, recoverVccImportTerminal: noop, reconcileVccImportLineage: noop
  });
  controller = createArchiveCenterController({ service, database, outboxStore: outbox,
    terminalRouteRegistry: createTerminalRouteRegistry([owner.terminalRegistration]),
    resolveOutboxTerminalIntent: owner.resolvePositionOutboxTerminalIntent,
    recoverInterruptedTaskOwners: application.archiveOwnerHooks(), postOutboxStartupHooks: application.postOutboxHooks(),
    getProtectedInterruptedTaskBatchIds: owner.protectedInterruptedTasks,
    onOutboxFlushed: owner.cleanupPositionArchiveSourcePaths,
    logWarning: (...args) => diagnostics.push(args)
  });
  const bor = createBusinessOperationRegistry();
  lifecycle = createTaskLifecycle({ businessOperationRegistry: bor, archiveService: service,
    flowResolver: createBusinessFlowResolver({ archiveService: service }),
    operationTracker: createArchiveOperationTracker({ sink: controller.sink }),
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload),
    onArchiveWarning: (warning) => diagnostics.push(warning) });
  main.attach(owner, controller);
  return { database, db, service, controller, owner, lifecycle, outbox, main, diagnostics,
    async initialize() {
      await application.platformFacade.scanAndRecover();
      await application.preflight();
      try {
        const result = await controller.initialize();
        application.completeArchiveInitialization(result);
        return result;
      } catch (error) { application.failArchiveInitialization(error); throw error; }
    },
    async close() { await Promise.allSettled(tracked); main.close(); db.close(); }
  };
}

// 与 Main 的 runArchiveAwareOperation 相同的组合：任务合同 prepare → adapter → TaskLifecycle.runFileTask。
async function importThroughLifecycle(host, sourcePath, operationToken) {
  const contract = normalizeIpcTaskHandler(createPositionSourceImportTaskContract({
    pickFiles: async () => ({ canceled: false, filePaths: [sourcePath] }),
    getService: host.main.getService,
    withSourceLock: (task) => task()
  }));
  const policy = policies.require(CHANNEL);
  // 与 Main 相同的 prepare 规范化：文件计划在这里冻结并分配存档条目键。
  const prepared = await prepareIpcTaskInvocation(contract, {}, []);
  assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
  const registry = createTaskAdapterRegistry({
    adapters: [createPositionTaskAdapter({ owner: host.owner, createOperationToken: () => operationToken,
      reportArchiveFailure: (warning) => host.diagnostics.push(warning) })],
    taskBindings: [{ taskKey: policy.taskKey, adapterId: 'position-reconciliation' }]
  });
  const invocation = registry.resolve(policy.taskKey).createInvocation({
    meta: { channel: CHANNEL }, policy, prepared, args: []
  });
  const scope = createPreparedResourceScope(prepared);
  let context;
  const result = await scope.run(() => {
    scope.enterLifecycle();
    return host.lifecycle.runFileTask({
      meta: { channel: CHANNEL }, policy, prepared, args: [], ...invocation.identity,
      ...(policy.startsNewFlow ? {} : { explicitParentRunId: `flow-${operationToken}` }),
      afterTerminalIntent: invocation.afterTerminalIntent, afterTerminal: invocation.afterTerminal,
      filePlanResolver: ({ taskRun }) => policy.filePlanResolver({
        channel: CHANNEL, args: [], prepared, taskRun
      }),
      execute(ownerContext, controls) {
        context = ownerContext;
        const taskContext = createIpcTaskContext(ownerContext, controls);
        return invocation.execute({ taskContext, controls,
          markExecuteStarted: scope.markExecuteStarted,
          executeBusiness: () => executeIpcTaskInvocation(contract, {}, prepared, [], taskContext) });
      }
    });
  });
  return { result, context, operationKey: invocation.identity.operationKey };
}

async function check(name, task) { await task(); passed += 1; process.stdout.write(`PASS ${name}\n`); }

async function main() {
  const directory = path.join(root, 'recall');
  fs.mkdirSync(directory, { recursive: true });
  const sourcePath = writeFundTransfer(path.join(directory, '调拨订单.xlsx'));
  const operationToken = 'position-anomaly-recall';
  const host = boot(directory);
  try {
    await host.initialize();
    const position = host.main.getService();
    let imported;
    let report;
    let stagedReportPath;

    await check('含过滤行的来源文件经真实任务生命周期导入：报告入存档，侧库保留生成键', async () => {
      imported = await importThroughLifecycle(host, sourcePath, operationToken);
      const { result, operationKey } = imported;
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.equal(result.results[0].filteredRowCount, 1);
      assert.equal(result.results[0].rowCount, 1);
      report = position.store.db.prepare(`
        SELECT report_key AS reportKey, report_artifact_key AS reportArtifactKey,
               archive_operation_key AS archiveOperationKey, report_file_path AS reportFilePath,
               report_sha256 AS reportSha256, report_size_bytes AS reportSizeBytes
        FROM position_filtered_source_rows WHERE resolved_at IS NULL
      `).get();
      assert.ok(report, '过滤记录已落库');
      stagedReportPath = report.reportFilePath;
      // 侧库记的是生成报告时的键：存档批次删除保护与运行冻结都按它核对。
      assert.equal(report.reportArtifactKey, GENERATED_REPORT_KEY);
      assert.equal(report.archiveOperationKey, operationKey);
      assert.equal(operationKey, `position:${operationToken}:${CHANNEL}`);

      const batch = host.service.repository.getBatchByOperationKey(
        'position-reconciliation-process', report.archiveOperationKey
      );
      assert.ok(batch, '按侧库记录的 operation key 能找到存档批次');
      const detail = host.service.repository.getBatchDetail(batch.id);
      assert.equal(detail.taskStatus, 'succeeded');
      assert.ok(detail.artifacts.every((artifact) => artifact.status === 'ready'), JSON.stringify(
        detail.artifacts.map((artifact) => [artifact.artifactKey, artifact.status])
      ));
      const archivedReports = detail.artifacts.filter((artifact) => (
        artifact.metadata && artifact.metadata.preGeneratedOutput
        && artifact.metadata.preGeneratedOutput.producerArtifactKey === GENERATED_REPORT_KEY
      ));
      assert.equal(archivedReports.length, 1, '存档条目登记了报告的生成键');
      // 存档条目自己的键由文件计划分配，与生成键不同：直接拿生成键当条目键查不到。
      assert.notEqual(archivedReports[0].artifactKey, GENERATED_REPORT_KEY);
      assert.equal(archivedReports[0].blob.sha256, report.reportSha256);
    });

    await check('任务收尾后暂存已回收：待完成操作已清，暂存目录下不再有本次导入的文件', async () => {
      assert.equal(host.database.getSetting(POSITION_SIDE_DB_PENDING_SETTING), '');
      assert.equal(host.outbox.list().length, 0);
      assert.equal(fs.existsSync(stagedReportPath), false, '异常报告的暂存文件应已随作业目录回收');
      const stagingRoot = path.join(directory, STAGING_RELATIVE_PATH);
      const leftovers = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [];
      assert.deepEqual(leftovers, []);
      assert.equal(fs.existsSync(sourcePath), true, '用户原始文件不得删除');
    });

    await check('暂存回收后从业务入口导出异常报告：内容与导入时冻结的摘要一致', async () => {
      const outputPath = path.join(directory, 'exported-anomaly-report.xlsx');
      const exported = await position.exportAnomalyReport(report.reportKey, outputPath);
      assert.equal(exported.reportKey, report.reportKey);
      assert.equal(exported.rowCount, 1);
      assert.equal(sha256(exported.filePath), report.reportSha256);
      assert.equal(fs.statSync(exported.filePath).size, Number(report.reportSizeBytes));
      const sheet = XLSX.readFile(exported.filePath).Sheets['调拨异常明细'];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
      assert.equal(rows.length, 2);
      assert.equal(rows[1][rows[0].indexOf('调拨单号')], 'FT-FILTERED-1');
    });

    await check('存档里的报告不可用时导出失败关闭，不返回未经核对的文件', async () => {
      const batch = host.service.repository.getBatchByOperationKey(
        'position-reconciliation-process', report.archiveOperationKey
      );
      // 侧库记录指向一个不存在的生成键：既无暂存、存档里也找不到对应条目。
      const original = position.store.findFilteredReport(report.reportKey);
      assert.ok(original && batch);
      position.store.db.prepare(
        'UPDATE position_filtered_source_rows SET report_artifact_key = ? WHERE report_key = ?'
      ).run('unknown-report-key', report.reportKey);
      try {
        await assert.rejects(
          position.exportAnomalyReport(report.reportKey, path.join(directory, 'must-not-exist.xlsx')),
          (error) => error && error.code === 'position-anomaly-report-integrity-invalid'
        );
        assert.equal(fs.existsSync(path.join(directory, 'must-not-exist.xlsx')), false);
      } finally {
        position.store.db.prepare(
          'UPDATE position_filtered_source_rows SET report_artifact_key = ? WHERE report_key = ?'
        ).run(GENERATED_REPORT_KEY, report.reportKey);
      }
    });
  } finally { await host.close(); }
  process.stdout.write(`==== ${passed}/${passed} PASS ====\n`);
}

main().catch((error) => { console.error('FAILURES', error); process.exitCode = 1; })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
