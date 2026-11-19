'use strict';

// v3.2.20 下线业务OP数据核对、月度Pending数据核对、收单单据币种校验、月度银行对账单BU回填校验后的升级兼容。
//   夹具按 v3.2.17 用户数据形态准备：主库中已下线模块的表与设置、run-data 侧库、Pending 库、BizOP 目录、
//   已下线模块的存档批次、遗留 pending-run 终态 outbox 与 BizOP recovery hold；随后以真实 Main + Preload + Renderer 启动。
// 断言：启动完成、回到默认模块、启用列表不含已下线模块、历史批次在不筛选模块时可见、遗留 outbox 收口；
//   已下线模块的数据（表行、设置、侧库、目录、存档文件、recovery hold）逐字不变。
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

// 旧版创建的 Pending 导入任务：已登记存档并写入终态意图，但 pending-run 业务收尾未完成（outbox 遗留）。
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
  return { batchId: batchContext.batchId, outboxStore };
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
    return { tables, settings, hold: hold ? JSON.parse(JSON.stringify(hold)) : null };
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
    const { batchId } = await createLeftoverArchiveTask({ rawDb: database.db, userData, storageRoot, sourcePath });
    database.close();

    writeSideDb(path.join(userData, 'run-data', 'acquiring-bill-currency', 'month-2026-09.sqlite'), 'acquiring_bill_currency_runs');
    writeSideDb(path.join(userData, 'run-data', 'biz-op-recon', 'month-2026-09.sqlite'), 'biz_op_recon_runs');
    writeSideDb(path.join(userData, 'run-data', 'bank-bu-recon', 'month-2026-09.sqlite'), 'bank_bu_recon_runs');
    writeSideDb(path.join(userData, 'tool-data-pending.sqlite'), 'pending_month_rows');
    fs.mkdirSync(path.join(userData, 'biz-op-v327', 'payloads'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'biz-op-v327', 'payloads', 'dataset.json'), '{"kind":"FLOW"}');

    const retiredFiles = [
      ...listFiles(path.join(userData, 'run-data', 'acquiring-bill-currency')),
      ...listFiles(path.join(userData, 'run-data', 'biz-op-recon')),
      ...listFiles(path.join(userData, 'run-data', 'bank-bu-recon')),
      path.join(userData, 'tool-data-pending.sqlite'),
      ...listFiles(path.join(userData, 'biz-op-v327')),
      ...listFiles(path.join(storageRoot, '存档中心'))
    ];
    check(retiredFiles.length >= 6, '夹具已生成已下线模块的侧库、目录与存档文件');
    const filesBefore = Object.fromEntries(retiredFiles.map((file) => [file, sha256(file)]));
    const dbBefore = snapshotMainDb(dbPath);
    check(dbBefore.hold && dbBefore.hold.actionKey === 'biz-op-v327:run-candidate', '夹具已留下 BizOP recovery hold');

    const child = spawnSync(require('electron'), [__filename], {
      cwd: root, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL',
      env: { ...process.env, RETIRED_MODULES_UPGRADE_CHILD: '1', RETIRED_MODULES_BATCH_ID: String(batchId),
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
    check(result.retiredBatchVisible, '已下线模块的历史存档批次在不按模块筛选时可见');

    const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
    check(createArchiveOutboxStore(path.join(userData, 'run-data', 'archive-center', 'outbox')).list().length === 0,
      '遗留 pending-run 终态意图在启动时按退役 route 收口');
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
  const batchId = Number(process.env.RETIRED_MODULES_BATCH_ID);
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
          const batches = Array.isArray(listed) ? listed : (listed && listed.batches) || [];
          return { currentModule: info.currentModule, routerModule: getModuleRouter().getCurrentModuleId(),
            enabledModules: Array.isArray(enabledModules) ? enabledModules : (enabledModules && enabledModules.enabledModules) || [],
            retiredBatchVisible: batches.some((batch) => Number(batch.id ?? batch.batchId) === ${batchId}) };
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
