'use strict';

// 存档中心「deferred 生成任务」集成测试（新开账户生成余额账单 / 月度余额装配）
//   覆盖：
//   - Main 真实 prepare/execute 经真实 TaskPolicy 解析 deferred 初始 FilePlan 后进入生命周期
//   - 真实 TaskLifecycle.runDeferredFileTask + ArchiveService（临时 SQLite）：结果非空时晋升 File Batch、
//     写出余额账单 xlsx、结算 manifest，Task Run 与 Batch 均成功、受管副本落盘
//   - 输出 xlsx 回读：表头取自 assets/余额账单模版.xlsx，数据行与输入一致
//   - 零输出（月度余额无记录、新开账户校验失败）只终结 Task Run，不预留 File Batch
//
// 两个入口的 prepare 只给空的 deferred FilePlan，真实输出在业务确认非空后经 ensureFileBatch 晋升。
// 单测里 deferred 生命周期用桩 resolver，没覆盖“真实 policy 解析器 + 真实入口 prepare”这一段；
// 本脚本把这段与后续预留、晋升、结算一起跑通。系统对话框、业务准入与流程身份使用夹具，不启动 Electron。
//
// 用法：node scripts/integration/archive-center-deferred-generation.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
const { prepareIpcTaskInvocation, createIpcTaskContext } = require('../../src/main-process/archive-center/ipc-task-contract');
const { artifactManifestFromFilePlan, normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
const { FileValidationError, extractHeaders, writeBalanceWorkbook } = require('../../src/backend/file-service');
const { writeBalanceSeedRecords } = require('../../src/backend/balance-seed-store');
const {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  toBalanceRows
} = require('../../src/main-process/monthly-balance');
const {
  NEW_ACCOUNT_EXPORT_NAME,
  normalizeNewAccountAccounts,
  prepareNewAccountGeneration,
  validateNewAccountAccounts
} = require('../../src/main-process/new-account/generation-core');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

const MAIN_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');
function mainSection(startText, endText) {
  const start = MAIN_SOURCE.indexOf(startText);
  const end = MAIN_SOURCE.indexOf(endText, start);
  if (start < 0 || end <= start) throw new Error(`Main 片段边界缺失：${startText}`);
  return MAIN_SOURCE.slice(start, end);
}
const MAIN_FRAGMENT = [
  mainSection('function sanitizeFileName(', '\n// v2.1.9 N7 (Phase 7 T29)'),
  mainSection('function buildOutputFilePath(', 'function buildStatementOutputFilePath('),
  mainSection("trackedIpcHandle('monthly-balance:assemble'", '// v1.5.3 R1 (T1.4)：月度余额另存为'),
  mainSection("trackedIpcHandle('new-account:generate'", "trackedIpcHandle('new-account:export'")
].join('\n');

function loadMainHandlers({ storageRoot, database }) {
  const contracts = new Map();
  const activity = [];
  const errorResults = [];
  const scope = {
    fs, path, artifactManifestFromFilePlan, normalizeFilePlanV1,
    FileValidationError, extractHeaders, writeBalanceWorkbook,
    ALL_BANKS_TEMPLATE_SCOPE, assembleMonthlyBalance, toBalanceRows,
    NEW_ACCOUNT_EXPORT_NAME, normalizeNewAccountAccounts, prepareNewAccountGeneration, validateNewAccountAccounts,
    trackedIpcHandle: (channel, _moduleKey, _functionKey, contract) => contracts.set(channel, contract),
    lastGeneratedExports: { detail: null, balance: null, newAccount: null, monthlyBalance: null },
    database,
    getStorageRoot: () => storageRoot,
    ensureStorageRoot: () => storageRoot,
    getToday: () => '2026-11-10',
    getBalanceTemplatePath: () => path.resolve(__dirname, '../../assets/余额账单模版.xlsx'),
    getStatementChannelMigrationPendingMessage: () => '',
    clearLastErrorReport: () => {},
    appendActivityLogEntry: (entry) => activity.push(entry),
    appendLog: () => path.join(storageRoot, 'error.log'),
    formatDateLabel: (value) => String(value),
    createErrorResult: (options) => {
      errorResults.push(options);
      return { status: 'error', errorCode: options.errorCode, message: options.message };
    }
  };
  Function(...Object.keys(scope), `${MAIN_FRAGMENT}\nreturn null;`)(...Object.values(scope));
  return { contracts, activity, errorResults };
}

function createLifecycle(service, controller) {
  return createTaskLifecycle({
    archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'deferred-generation' }), end() {} },
    flowResolver: {
      resolve: async () => ({ parentRunId: 'deferred-generation-parent', source: 'new', identity: null }),
      bind: async () => [],
      persistBindIntent: async () => ({ ok: true })
    },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (intent) => controller.persistTaskTerminalIntent(intent)
  });
}

// 与 Main runArchiveAwareOperation 的 deferred 分支同样接线：初始 FilePlan 由真实 policy 解析器从 prepared 取得。
async function runDeferred({ lifecycle, policyRegistry, contracts, channel, payload, taskRunId }) {
  const policy = policyRegistry.require(channel);
  const contract = contracts.get(channel);
  const event = { sender: { id: 1 } };
  const prepared = await prepareIpcTaskInvocation(contract, event, [payload]);
  let batchContext = null;
  let initialPlan = null;
  const result = await lifecycle.runDeferredFileTask({
    policy,
    meta: { channel },
    args: prepared.args,
    prepared,
    taskRunId,
    operationKey: `${channel}:${taskRunId}`,
    flowPlanResolver: () => ({ startsNewFlow: true, flowIdentity: null }),
    filePlanResolver: async ({ taskRun }) => {
      initialPlan = await policy.filePlanResolver({ channel, args: prepared.args, prepared, taskRun });
      return initialPlan;
    },
    execute: async (context, controls) => {
      const tracked = {
        ...controls,
        ensureFileBatch: async (manifest) => {
          batchContext = await controls.ensureFileBatch(manifest);
          return batchContext;
        }
      };
      return contract.execute(event, prepared, createIpcTaskContext(context, tracked), ...prepared.args);
    }
  });
  return { policy, result, batchContext, initialPlan };
}

function readSheetRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

function assertSettledBatch(service, archiveRoot, { label, policy, taskRunId, batchContext, outputPath }) {
  const taskRun = service.repository.getTaskRun(taskRunId);
  assertEq(taskRun && taskRun.status, 'succeeded', `${label}.Task Run 成功终结`);
  assertTrue(Boolean(batchContext && batchContext.batchId), `${label}.结果非空时晋升出 File Batch`);
  if (!batchContext) return;
  const batch = service.repository.getBatch(batchContext.batchId);
  assertEq(batch && batch.moduleId, policy.scopeId, `${label}.Batch 归属模块`);
  assertEq(batch && batch.taskStatus, 'succeeded', `${label}.Batch 成功终结`);
  const artifacts = service.repository.listArtifacts(batchContext.batchId);
  assertEq(artifacts.map((item) => item.status), ['ready'], `${label}.唯一输出 artifact 已结算`);
  const stored = artifacts.flatMap((artifact) => [
    path.join(archiveRoot, artifact.storageRelativePath),
    path.join(archiveRoot, artifact.blob.relativePath)
  ]);
  assertTrue(stored.every((filePath) => fs.existsSync(filePath)), `${label}.受管副本已落盘`);
  assertTrue(fs.existsSync(outputPath), `${label}.导出目录输出文件存在`);
}

function assertNoBatch(service, { label, taskRunId, batchContext, initialPlan }) {
  assertEq(initialPlan && initialPlan.allocation, 'deferred', `${label}.初始 FilePlan 为 deferred`);
  assertEq(batchContext, null, `${label}.未晋升 File Batch`);
  const taskRun = service.repository.getTaskRun(taskRunId);
  assertTrue(Boolean(taskRun) && taskRun.status !== 'running' && taskRun.status !== 'prepared',
    `${label}.Task Run 已终结（${taskRun && taskRun.status}）`);
  assertEq(taskRun && taskRun.batchId ? 'has-batch' : 'no-batch', 'no-batch', `${label}.Task Run 未关联 Batch`);
}

async function run() {
  console.log('==== 存档中心 deferred 生成任务 集成验证 ====');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-deferred-generation-')));
  const archiveRoot = path.join(directory, 'archive');
  const storageRoot = path.join(directory, 'documents');
  fs.mkdirSync(storageRoot, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'archive.sqlite'));
  let service;
  try {
    service = createArchiveService({ database: db, rootDir: archiveRoot });
    const initialized = await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
    assertTrue(initialized.ok === true, 'Setup.存档服务初始化');
    const controller = createArchiveCenterController({
      service,
      outboxStore: createArchiveOutboxStore(path.join(directory, 'outbox')),
      database: { getSetting: () => null, setSetting() {} }
    });
    const lifecycle = createLifecycle(service, controller);
    const policyRegistry = createTaskPolicyRegistry();
    const templates = [{ id: 7, name: '测试银行-上海' }];
    const database = {
      listTemplates: () => templates,
      getTemplateBigAccounts: (templateId) => (templateId === 7
        ? [{ merchantId: '6222000011112222', currency: 'USD' }]
        : [])
    };
    const { contracts, activity, errorResults } = loadMainHandlers({ storageRoot, database });
    const balanceHeaders = extractHeaders(path.resolve(__dirname, '../../assets/余额账单模版.xlsx'));
    const accountColumn = balanceHeaders.indexOf('银行账号');
    const balanceColumn = balanceHeaders.indexOf('期末余额');
    assertTrue(accountColumn >= 0 && balanceColumn >= 0, 'Setup.余额账单模板含银行账号/期末余额列');

    // Step 1：新开账户「生成余额账单」——报错现场的动作
    {
      const label = 'Step1.新开账户生成';
      const opening = new Date();
      opening.setDate(opening.getDate() - 3);
      const openingDate = `${opening.getFullYear()}-${String(opening.getMonth() + 1).padStart(2, '0')}-${String(opening.getDate()).padStart(2, '0')}`;
      const taskRunId = 'deferred-new-account-success';
      const run1 = await runDeferred({
        lifecycle, policyRegistry, contracts, taskRunId,
        channel: 'new-account:generate',
        payload: { accounts: [{
          bankName: '测试银行', location: '上海', bankAccount: '622200009999',
          openingDate, isMultiCurrency: false, currency: 'USD', currencies: []
        }] }
      });
      assertEq(run1.result && run1.result.status, 'success', `${label}.业务结果 success（${run1.result && run1.result.message}）`);
      assertEq(run1.initialPlan && run1.initialPlan.allocation, 'deferred', `${label}.初始 FilePlan 取入口 deferred 字面量`);
      const exportDir = path.join(storageRoot, 'exports', '2026-11-10', 'new-account');
      const exported = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
      assertEq(exported.length, 1, `${label}.导出目录仅一个余额账单`);
      const exportedPath = path.join(exportDir, exported[0] || '');
      assertSettledBatch(service, archiveRoot, { label, policy: run1.policy, taskRunId,
        batchContext: run1.batchContext, outputPath: exportedPath });
      if (exported.length === 1) {
        const rows = readSheetRows(exportedPath);
        assertEq(rows[0], balanceHeaders, `${label}.表头与余额账单模板一致`);
        assertTrue(rows.length >= 2, `${label}.至少一行余额数据`);
        assertTrue(rows.slice(1).every((row) => String(row[accountColumn]) === '622200009999'), `${label}.数据行账号与输入一致`);
      }
    }

    // Step 2：新开账户校验失败——零输出，不预留 Batch
    {
      const label = 'Step2.新开账户校验失败';
      const taskRunId = 'deferred-new-account-invalid';
      const before = errorResults.length;
      const run2 = await runDeferred({
        lifecycle, policyRegistry, contracts, taskRunId,
        channel: 'new-account:generate',
        payload: { accounts: [{ bankName: '测试银行', location: '', bankAccount: '', openingDate: '' }] }
      });
      assertEq(run2.result && run2.result.status, 'error', `${label}.返回校验错误`);
      assertEq(errorResults.length, before + 1, `${label}.走入口错误结果`);
      assertNoBatch(service, { label, taskRunId, batchContext: run2.batchContext, initialPlan: run2.initialPlan });
    }

    // Step 3：月度余额「装配」——同一 deferred 注册，有种子时晋升并写出
    {
      const label = 'Step3.月度余额装配';
      writeBalanceSeedRecords(storageRoot, '测试银行', [
        { merchantId: '6222000011112222', currency: 'USD', billDate: '2026-09-30', endBalance: 1234.56,
          templateName: '测试银行-上海' }
      ]);
      const taskRunId = 'deferred-monthly-success';
      const run3 = await runDeferred({
        lifecycle, policyRegistry, contracts, taskRunId,
        channel: 'monthly-balance:assemble',
        payload: { templateScope: 'single', templateName: '测试银行-上海', year: 2026, month: 9 }
      });
      assertEq(run3.result && run3.result.status, 'ready', `${label}.业务结果 ready（${run3.result && run3.result.message}）`);
      assertEq(run3.result && run3.result.summary && run3.result.summary.count, 1, `${label}.装配 1 条记录`);
      const exportedPath = path.join(storageRoot, 'exports', '2026-11-10', 'balance',
        (run3.result && run3.result.summary && run3.result.summary.fileName) || '');
      assertSettledBatch(service, archiveRoot, { label, policy: run3.policy, taskRunId,
        batchContext: run3.batchContext, outputPath: exportedPath });
      if (fs.existsSync(exportedPath)) {
        const rows = readSheetRows(exportedPath);
        assertEq(rows[0], balanceHeaders, `${label}.表头与余额账单模板一致`);
        assertEq(rows.length, 2, `${label}.一行余额数据`);
        assertEq(String(rows[1] && rows[1][accountColumn]), '6222000011112222', `${label}.账号`);
        assertEq(Number(rows[1] && rows[1][balanceColumn]), 1234.56, `${label}.期末余额`);
      }
    }

    // Step 4：月度余额无记录——零输出，不预留 Batch
    {
      const label = 'Step4.月度余额无记录';
      const taskRunId = 'deferred-monthly-empty';
      const run4 = await runDeferred({
        lifecycle, policyRegistry, contracts, taskRunId,
        channel: 'monthly-balance:assemble',
        payload: { templateScope: 'single', templateName: '测试银行-上海', year: 2026, month: 8 }
      });
      assertEq(run4.result && run4.result.status, 'empty', `${label}.返回 empty`);
      assertNoBatch(service, { label, taskRunId, batchContext: run4.batchContext, initialPlan: run4.initialPlan });
    }

    assertTrue(!activity.some((entry) => entry.level === 'error'), 'Summary.无 error 级活动日志');
  } finally {
    if (service) await service.pauseBackgroundMaterialization();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`));
    process.exit(1);
  }
}

run().catch((error) => { console.error('FATAL', error); process.exit(1); });
