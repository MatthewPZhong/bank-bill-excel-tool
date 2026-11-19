'use strict';

// v3.2.20 下线业务OP数据核对、月度Pending数据核对、收单单据币种校验、月度银行对账单BU回填校验后的升级兼容。
//   夹具按 v3.2.19 及更早版本的用户数据形态准备：主库中已下线模块的表与设置、run-data 侧库、Pending 库、
//   BizOP v327 数据目录（run-data/biz-op-v327/{inputs,results,operations}）、已下线模块的存档批次与 Task Run
//   （含异常退出时仍在进行中的现场）、遗留终态 outbox（file-batch 与 operation 两种 owner）、BizOP recovery hold，
//   以及 BizOP v327 导出在发布中途退出留下的共享发布记录；随后以真实 Main + Preload + Renderer 启动。
// 断言：启动完成、回到默认模块、启用列表不含已下线模块；存档中心不展示已下线模块的批次；已下线模块的
//   存档批次 / Task Run / 附件记录、outbox 通知、发布记录与材料、表行、设置、侧库、目录与 recovery hold 逐字不变。
// 不代表 Windows 安装包或真实用户数据验收。用法：node scripts/integration/retired-modules-upgrade-compat.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const PREFIX = 'RETIRED_MODULES_UPGRADE_RESULT=';
const RETIRED_MODULE_IDS = ['pending-reconciliation', 'bank-bu-recon', 'biz-op-recon', 'acquiring-bill-currency'];
const RETIRED_TABLES = {
  acquiring_bill_currency_runs: ['month_key TEXT', 'status TEXT'],
  biz_op_recon_runs: ['data_date TEXT', 'bu_name TEXT'],
  bank_bu_recon_runs: ['year_month TEXT', 'status TEXT'],
  biz_op_v327_datasets: ['dataset_id TEXT', 'kind TEXT']
};
const RETIRED_SETTINGS = {
  current_module: 'biz-op-recon',
  enabled_modules: JSON.stringify(['statement-generator', 'biz-op-recon', 'pending-reconciliation',
    'acquiring-bill-currency', 'bank-bu-recon', 'vcc-op-calc']),
  acquiring_bill_idle_cleanup_minutes: '45',
  acquiring_bill_raw_json_retention_days: '14',
  archive_center_retention_days_by_module: JSON.stringify({ 'pending-reconciliation': 30, 'statement-generator': 60 })
};

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function writeSideDb(filePath, table) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
  db.prepare(`INSERT INTO ${table} (payload) VALUES (?), (?)`).run('历史行-1', '历史行-2');
  db.close();
}

function createLeftoverHold(rawDb) {
  const { canonicalSha256 } = require('../../src/main-process/background-execution/canonical-json-v1');
  const { createRecoveryControlRepository } = require('../../src/main-process/background-execution/critical/recovery-control-repository');
  const { createRecoveryRequestOwnerRepository } = require('../../src/main-process/background-execution/critical/recovery-request-owner-repository');
  const { transitionRequestKey } = require('../../src/main-process/background-execution/recovery-control-contract');
  const safeSummary = { reasonCode: 'INSPECTION_UNKNOWN' };
  const transition = { entityKind: 'recovery-hold', command: 'create-or-get', input: {
    contractVersion: 1, holdId: 'hold:bizop-v327-leftover', sourceKind: 'publisher-journal',
    sourceRef: 'publisher-journal:bizop-v327-leftover', intentId: null, actionKey: 'biz-op-v327:run-candidate',
    operationKey: 'bizop-leftover-operation', taskRunId: 'bizop-leftover-task', conflictScopeKey: 'scope:biz-op-v327:leftover',
    reasonCode: safeSummary.reasonCode, safeSummary, evidenceHash: canonicalSha256(safeSummary)
  } };
  const reserved = createRecoveryRequestOwnerRepository(rawDb).reserveTransitionRequest({
    requestKey: transitionRequestKey(transition), transition, safePayload: safeSummary
  });
  createRecoveryControlRepository(rawDb).runInControlTransaction((tx) => tx.transitionWithRecoveryEvent(reserved));
}

// 旧版异常退出时的存档现场：Pending 导入已写入终态意图但未重放（file-batch outbox 遗留）、Pending 核对的
//   operation 终态通知（pending-run 收尾未完成）、收单续跑批次仍为 reserved、BizOP 导出 Task Run 仍为 prepared。
async function createLeftoverArchiveTask({ rawDb, userData, storageRoot, sourcePath }) {
  const { createArchiveService } = require('../../src/main-process/archive-center/archive-service');
  const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
  const { createTaskLifecycle } = require('../../src/main-process/archive-center/task-lifecycle');
  const { normalizeFilePlanV1 } = require('../../src/main-process/archive-center/file-plan');
  const { createTaskPolicyRegistry } = require('../../src/main-process/execution-descriptors/composition');
  const { createArchiveControllerWithRoutes } = require('../../tests/helpers/archive-terminal-routes');
  const service = createArchiveService({ database: rawDb, rootDir: path.join(storageRoot, '存档中心') });
  await service.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false });
  const outboxStore = createArchiveOutboxStore(path.join(userData, 'run-data', 'archive-center', 'outbox'));
  const controller = createArchiveControllerWithRoutes({ service, outboxStore,
    database: { getSetting: () => null, setSetting() {} }, logWarning() {},
    onTerminalIntentFlushed() { throw new Error('模拟旧版 pending-run 收尾前退出'); } });
  const channel = 'pending:import:start';
  const policy = { ...createTaskPolicyRegistry().require('file:import'), channel, taskKey: channel,
    scopeId: 'pending-reconciliation', moduleCode: 'PENDING', moduleName: '月度Pending数据核对' };
  const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', outputs: [],
    inputs: [{ filePath: sourcePath, role: 'input', sourceOperation: channel }] });
  const lifecycle = createTaskLifecycle({ archiveService: service,
    businessOperationRegistry: { begin: () => ({ accepted: true, token: 'leftover' }), end() {} },
    flowResolver: { resolve: async () => ({ parentRunId: 'pending-parent', source: 'new', identity: null }),
      bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
    operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
    persistTerminalIntent: (payload) => controller.persistTaskTerminalIntent(payload) });
  let batchContext;
  const result = await lifecycle.runFileTask({ policy, taskRunId: 'pending-leftover-task', operationKey: 'pending-leftover-operation',
    filePlanResolver: () => plan,
    afterTerminalIntent: { route: 'pending-run', taskRunId: 'pending-leftover-task' },
    execute: async (context, controls) => {
      batchContext = context;
      const settled = await controls.settleArtifacts({ files: plan.inputs.map((item) => ({ artifactKey: item.artifactKey })) });
      assert.equal(settled.ok, true);
      return { status: 'success' };
    } });
  assert.equal(result.status, 'success');
  try { await controller.flushOutbox(); } catch (_error) { /* 旧版收尾失败：记录留在 outbox */ }
  assert.equal(outboxStore.list().length, 1, '夹具应留下一条未收口的 pending-run 终态意图');
  // 旧版 Pending 流程绑定未完成：留下 Task Run 与批次两类流程绑定意图。
  const flowIdentity = { moduleId: 'pending-reconciliation', identityType: 'business-run-id', parentRunId: 'pending-parent' };
  service.repository.persistTaskFlowBindIntent({ ...flowIdentity, identityValue: 'pending-2026-10', sourceTaskRunId: 'pending-leftover-task' });
  service.repository.persistFlowBindIntent({ ...flowIdentity, identityValue: 'pending-2026-10-batch', sourceBatchId: batchContext.batchId });
  controller.persistTaskTerminalIntent({
    owner: { version: 1, kind: 'operation', operationContext: { taskRunId: 'pending-reconcile-leftover',
      taskKey: 'pending:reconcile:run', moduleId: 'pending-reconciliation', parentRunId: 'pending-parent',
      operationKey: 'pending-reconcile-leftover-operation' } },
    sourceOperation: 'pending:reconcile:run',
    terminalOutcome: { taskStatus: 'succeeded', metadata: {}, afterTerminal: { route: 'pending-run', taskRunId: 'pending-reconcile-leftover' } }
  });
  assert.equal(outboxStore.list().length, 2, '夹具应再留下一条 operation owner 的 pending-run 终态通知');
  const running = await service.reserveTaskBatch({ moduleId: 'acquiring-bill-currency', moduleCode: 'ACQUIRING',
    moduleName: '收单单据币种校验', operationKey: 'acquiring-resume-leftover', taskKey: 'acquiringBillCurrency:run:resume',
    taskRunId: 'acquiring-resume-leftover-run' });
  assert.equal(running.ok, true, JSON.stringify(running));
  const begun = await service.beginTaskRun({ taskRunId: 'bizop-export-leftover-run', taskKey: 'bizOpReconV327:export:op-raw',
    moduleId: 'biz-op-recon', parentRunId: 'bizop-parent', operationKey: 'bizop-export-leftover-operation' });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  // 对照：保留模块的普通批次，升级后必须仍在存档列表中可见（区分"正确隐藏"与"列表读取失败或误隐藏全部"）。
  const retainedSource = path.join(path.dirname(sourcePath), '新开账户余额账单.xlsx');
  fs.writeFileSync(retainedSource, '保留模块的历史输出');
  const retained = await controller.sink.createBatch({ moduleId: 'new-account', moduleCode: 'NEW', moduleName: '新开账户余额账单生成',
    sourceOperation: 'new-account:generate', files: [{ filePath: retainedSource, role: 'output' }] });
  assert.ok(Number.isSafeInteger(retained.batchId) && !retained.archiveFailed, JSON.stringify(retained));
  return { batchId: batchContext.batchId, runningBatchId: running.batchId, retainedBatchId: retained.batchId };
}

// 旧版 BizOP v327 导出在发布中途退出：共享发布恢复索引、journal、staging、备份与目标留在 userData 与输出目录。
function createLeftoverBizOpPublication({ userData, outputDir }) {
  const core = require('../../src/main-process/toolbox-output-publication');
  const { createWorkerAuthority, seal } = require('../../src/main-process/publication-recovery/worker-authority');
  const key = crypto.randomBytes(32).toString('hex');
  const taskRunId = 'bizop-export-leftover-run';
  const taskId = `biz-op-v327-export-${taskRunId}`;
  const generation = path.join(outputDir, 'generation');
  fs.mkdirSync(generation, { recursive: true });
  const source = path.join(generation, 'OP原始数据.xlsx');
  const target = path.join(outputDir, 'OP原始数据.xlsx');
  fs.writeFileSync(source, '升级前新生成的业务OP导出');
  fs.writeFileSync(target, '用户此前保存的同名文件');
  const options = { taskId, userDataDir: userData, artifacts: [{ sourcePath: source }], targets: [target],
    batchContext: { batchId: 9001, batchNumber: 'BIZOP-20261101-001', taskRunId, taskKey: 'bizOpReconV327:export:op-raw',
      moduleId: 'biz-op-recon', parentRunId: 'bizop-parent', operationKey: 'bizop-export-leftover-operation' },
    checkpoint(name) { if (name === 'publish:after-publish-rename-before-journal') throw new core.ToolboxPublicationCrashError(name); } };
  assert.throws(() => {
    const snapshot = core.discoverToolboxPublicationRecovery(options);
    const prepared = core.prepareToolboxPublication({ ...options, workerAuthority: createWorkerAuthority(key),
      preflight: seal(key, 'preflight', { root: path.resolve(userData), taskId, indexDigest: snapshot.indexDigest, nonce: crypto.randomUUID() }) });
    core.publishPreparedToolboxPublication(prepared);
  }, core.ToolboxPublicationCrashError);
  const record = core.discoverToolboxPublicationRecovery({ userDataDir: userData }).records.find((item) => item.taskId === taskId);
  assert.ok(record, '夹具应留下 BizOP v327 发布记录');
  return [path.join(userData, core.JOURNAL_INDEX_NAME), record.journalPath, ...record.indexEntry.stagedAbsolutePaths,
    ...record.indexEntry.backupAbsolutePaths, ...record.indexEntry.targetAbsolutePaths];
}

// 已下线模块的存档记录（批次、Task Run、附件）逐行快照。
function snapshotRetiredArchive(db) {
  const retired = RETIRED_MODULE_IDS.map((id) => `'${id}'`).join(', ');
  const rows = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));
  return {
    batches: rows(`SELECT * FROM archive_batches WHERE module_id IN (${retired}) ORDER BY id`),
    taskRuns: rows(`SELECT * FROM archive_task_runs WHERE module_id IN (${retired}) ORDER BY task_run_id`),
    artifacts: rows(`SELECT a.* FROM archive_artifacts a JOIN archive_batches b ON b.id = a.batch_id
      WHERE b.module_id IN (${retired}) ORDER BY a.id`),
    // 流程绑定意图与锚点、File Task 原收口责任与收口凭证：新版启动不得重放、确认或删除。
    flowIntents: [...rows(`SELECT 'task' AS kind, * FROM archive_task_flow_bind_intents WHERE module_id IN (${retired}) ORDER BY id`),
      ...rows(`SELECT 'batch' AS kind, * FROM archive_flow_bind_intents WHERE module_id IN (${retired}) ORDER BY id`)],
    flowAnchors: rows(`SELECT * FROM archive_flow_anchors WHERE module_id IN (${retired}) ORDER BY 1`),
    ownerRecoveries: rows(`SELECT r.* FROM archive_file_task_owner_recovery r JOIN archive_batches b ON b.id = r.batch_id
      WHERE b.module_id IN (${retired}) ORDER BY r.owner_key`),
    ownerCompletions: rows(`SELECT c.* FROM archive_owner_terminal_completions c JOIN archive_batches b ON b.id = c.batch_id
      WHERE b.module_id IN (${retired}) ORDER BY c.owner_key`)
  };
}

function snapshotMainDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = Object.fromEntries(Object.keys(RETIRED_TABLES).map((table) => [table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }))]));
    const settings = Object.fromEntries(Object.keys(RETIRED_SETTINGS).map((key) => [key,
      db.prepare('SELECT setting_value AS value FROM app_settings WHERE setting_key = ?').get(key)?.value ?? null]));
    const { createRecoveryControlReadRepository } = require('../../src/main-process/background-execution/critical/recovery-control-read-repository');
    const hold = createRecoveryControlReadRepository(db).listActiveRecoveryHolds()
      .find((item) => item.holdId === 'hold:bizop-v327-leftover');
    return { tables, settings, hold: hold ? JSON.parse(JSON.stringify(hold)) : null, archive: snapshotRetiredArchive(db) };
  } finally { db.close(); }
}

async function parent() {
  const { AppDatabase } = require('../../src/backend/database');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-modules-upgrade-'));
  const userData = path.join(temp, 'userData');
  const documents = path.join(temp, 'Documents');
  const storageRoot = path.join(documents, '网银账单生成小助手');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });
  let passed = 0;
  const check = (value, message) => { assert.ok(value, message); passed += 1; };
  try {
    const dbPath = path.join(userData, 'tool-data.sqlite');
    const database = new AppDatabase(dbPath);
    database.init();
    for (const [table, columns] of Object.entries(RETIRED_TABLES)) {
      database.db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, ${columns.join(', ')})`);
      database.db.prepare(`INSERT INTO ${table} VALUES (1, ?, ?), (2, ?, ?)`).run('2026-09', '历史-1', '2026-10', '历史-2');
    }
    for (const [key, value] of Object.entries(RETIRED_SETTINGS)) database.setSetting(key, value);
    createLeftoverHold(database.db);
    const sourcePath = path.join(temp, 'Pending.xlsx');
    fs.writeFileSync(sourcePath, '升级前导入的 Pending 原表');
    const { batchId, runningBatchId, retainedBatchId } = await createLeftoverArchiveTask({ rawDb: database.db, userData, storageRoot, sourcePath });
    database.close();
    const publicationFiles = createLeftoverBizOpPublication({ userData, outputDir: path.join(temp, 'exports') });

    writeSideDb(path.join(userData, 'run-data', 'acquiring-bill-currency', 'month-2026-09.sqlite'), 'acquiring_bill_currency_runs');
    writeSideDb(path.join(userData, 'run-data', 'biz-op-recon', 'month-2026-09.sqlite'), 'biz_op_recon_runs');
    writeSideDb(path.join(userData, 'run-data', 'bank-bu-recon', 'month-2026-09.sqlite'), 'bank_bu_recon_runs');
    writeSideDb(path.join(userData, 'tool-data-pending.sqlite'), 'pending_month_rows');
    // 旧版 BizOP v327 的真实数据根：{userData}/run-data/biz-op-v327/{inputs,results,operations,...}。
    for (const [folder, name, body] of [['inputs', 'dataset-1.json', '{"kind":"FLOW"}'],
      ['results', 'result-1.json', '{"rows":2}'], ['operations', 'operation-1.json', '{"action":"EXPORT"}']]) {
      fs.mkdirSync(path.join(userData, 'run-data', 'biz-op-v327', folder), { recursive: true });
      fs.writeFileSync(path.join(userData, 'run-data', 'biz-op-v327', folder, name), body);
    }

    const retiredFiles = [
      ...listFiles(path.join(userData, 'run-data', 'acquiring-bill-currency')),
      ...listFiles(path.join(userData, 'run-data', 'biz-op-recon')),
      ...listFiles(path.join(userData, 'run-data', 'bank-bu-recon')),
      path.join(userData, 'tool-data-pending.sqlite'),
      ...listFiles(path.join(userData, 'run-data', 'biz-op-v327')),
      ...listFiles(path.join(storageRoot, '存档中心')),
      ...listFiles(path.join(userData, 'run-data', 'archive-center', 'outbox')),
      ...publicationFiles.filter((file) => fs.existsSync(file))
    ];
    check(retiredFiles.length >= 12, '夹具已生成已下线模块的侧库、目录、存档文件、outbox 与发布材料');
    check(publicationFiles.length >= 4, '发布材料路径已登记（索引、journal、staging / 备份 / 目标）');
    const filesBefore = Object.fromEntries(retiredFiles.map((file) => [file, sha256(file)]));
    const dbBefore = snapshotMainDb(dbPath);
    check(dbBefore.hold && dbBefore.hold.actionKey === 'biz-op-v327:run-candidate', '夹具已留下 BizOP recovery hold');
    check(dbBefore.archive.batches.find((row) => row.id === runningBatchId)?.task_status === 'reserved', '夹具已留下进行中的已下线批次');
    check(dbBefore.archive.taskRuns.some((row) => row.status === 'prepared'), '夹具已留下进行中的已下线 Task Run');
    check(dbBefore.archive.flowIntents.length === 2 && dbBefore.archive.flowAnchors.length === 0, '夹具已留下未重放的流程绑定意图');
    const publicationBefore = Object.fromEntries(publicationFiles.map((file) => [file, fs.existsSync(file) ? sha256(file) : null]));

    const child = spawnSync(require('electron'), [__filename], {
      cwd: root, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL',
      env: { ...process.env, RETIRED_MODULES_UPGRADE_CHILD: '1', RETIRED_MODULES_BATCH_IDS: JSON.stringify([batchId, runningBatchId]),
        RETIRED_MODULES_RETAINED_BATCH_ID: String(retainedBatchId),
        APP_USER_DATA_DIR: userData, APP_DOCUMENTS_DIR: documents, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    const line = String(child.stdout || '').split(/\r?\n/).find((item) => item.startsWith(PREFIX));
    const result = line ? JSON.parse(line.slice(PREFIX.length)) : null;
    if (child.error || child.status !== 0 || !result || !result.ok) {
      throw new Error([child.error?.message, `真实应用退出码 ${child.status}，信号 ${child.signal || '无'}`,
        JSON.stringify(result), child.stdout, child.stderr].filter(Boolean).join('\n'));
    }
    check(true, '真实 Main 启动完成、Renderer 初始化完成且无未处理异常');
    check(result.currentModule === 'statement-generator', `启动回到默认模块：${result.currentModule}`);
    check(result.routerModule === 'statement-generator', `Renderer 路由停在默认模块：${result.routerModule}`);
    check(RETIRED_MODULE_IDS.every((id) => !result.enabledModules.includes(id)), '启用列表不含已下线模块');
    check(result.enabledModules.includes('vcc-op-calc'), '保留模块的启用状态不受影响');
    check(result.listStatus === 'success', `存档列表读取成功：${result.listStatus} ${result.listMessage || ''}`);
    check(result.retainedBatchVisible === true, '保留模块的批次在存档列表中照常可见');
    check(result.retiredBatchVisible === false, '存档中心不展示已下线模块的批次');
    check(RETIRED_MODULE_IDS.every((id) => !result.visibleModuleIds.includes(id)), `存档列表不含已下线模块：${result.visibleModuleIds.join(',')}`);

    for (const [file, digest] of Object.entries(publicationBefore)) {
      check((fs.existsSync(file) ? sha256(file) : null) === digest, `遗留 BizOP 发布材料原样保留：${path.relative(temp, file)}`);
    }
    for (const [file, digest] of Object.entries(filesBefore)) {
      check(fs.existsSync(file) && sha256(file) === digest, `已下线模块文件保持原样：${path.relative(temp, file)}`);
    }
    const dbAfter = snapshotMainDb(dbPath);
    assert.deepEqual(dbAfter.tables, dbBefore.tables, '已下线模块的主库表与行保持原样'); passed += 1;
    const { current_module: _current, ...retainedSettingsBefore } = dbBefore.settings;
    const { current_module: currentAfter, ...retainedSettingsAfter } = dbAfter.settings;
    assert.deepEqual(retainedSettingsAfter, retainedSettingsBefore, '已下线模块相关设置保持原样'); passed += 1;
    check([RETIRED_SETTINGS.current_module, 'statement-generator'].includes(currentAfter), `current_module 仅可能被当前模块覆盖：${currentAfter}`);
    assert.deepEqual(dbAfter.hold, dbBefore.hold, 'BizOP recovery hold 只读跳过，未被改写'); passed += 1;
    assert.deepEqual(dbAfter.archive, dbBefore.archive, '已下线模块的存档批次、Task Run、附件、流程绑定意图与收口记录均未被扫尾、重放或改写'); passed += 1;
    console.log(`==== ${passed}/${passed} PASS ====`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function child() {
  const { app } = require('electron');
  const packageInfo = require('../../package.json');
  app.setAppPath(root);
  app.name = packageInfo.productName || packageInfo.name;
  app.setVersion(packageInfo.version);
  const batchIds = JSON.parse(process.env.RETIRED_MODULES_BATCH_IDS || '[]').map(Number);
  const retainedBatchId = Number(process.env.RETIRED_MODULES_RETAINED_BATCH_ID);
  let handled = false;
  const timeout = setTimeout(() => { console.error('真实应用启动验证超时'); app.exit(1); }, 100000);
  app.on('browser-window-created', (_event, window) => {
    if (handled) return;
    handled = true;
    const web = window.webContents;
    const rendererErrors = [];
    web.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
    web.once('did-finish-load', async () => {
      try {
        assert.equal(app.getPath('userData'), process.env.APP_USER_DATA_DIR);
        const state = await web.executeJavaScript(`(async () => {
          const deadline = performance.now() + 60000;
          while (typeof getRendererStartupValue !== 'function'
            || getRendererStartupValue('renderer-init-complete') === undefined) {
            if (performance.now() >= deadline) throw new Error('等待 Renderer 初始化完成超过 60 秒');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const info = await window.desktopApi.app.getInfo();
          const enabledModules = await window.desktopApi.settings.getEnabledModules();
          const listed = await window.desktopApi.archiveCenter.listBatches({});
          const batches = listed && listed.status === 'success' && Array.isArray(listed.batches) ? listed.batches : null;
          const retiredIds = ${JSON.stringify(batchIds)};
          return { currentModule: info.currentModule, routerModule: getModuleRouter().getCurrentModuleId(),
            enabledModules: Array.isArray(enabledModules) ? enabledModules : (enabledModules && enabledModules.enabledModules) || [],
            listStatus: listed && listed.status, listMessage: listed && listed.message,
            retainedBatchVisible: Boolean(batches) && batches.some((batch) => Number(batch.id ?? batch.batchId) === ${retainedBatchId}),
            retiredBatchVisible: !batches || batches.some((batch) => retiredIds.includes(Number(batch.id ?? batch.batchId))),
            visibleModuleIds: (batches || []).map((batch) => String(batch.moduleId || '')) };
        })()`);
        const ok = rendererErrors.length === 0;
        console.log(PREFIX + JSON.stringify({ ok, rendererErrors, ...state }));
      } catch (error) {
        console.log(PREFIX + JSON.stringify({ ok: false, failures: [String(error.stack || error)] }));
      } finally {
        clearTimeout(timeout);
        app.quit();
      }
    });
  });
  require('../../src/main');
}

if (process.env.RETIRED_MODULES_UPGRADE_CHILD === '1') child();
else parent().catch((error) => { console.error('FAILURES', error.stack || error); process.exitCode = 1; });
