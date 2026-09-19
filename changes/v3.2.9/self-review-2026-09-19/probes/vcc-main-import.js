'use strict';
// 独立复审探针：执行快照中实际 Main 注册源码；对话框/窗口/流程跟踪为夹具。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../../../..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const mainRequire = createRequire(path.join(root, 'src/main.js'));
const XLSX = projectRequire('xlsx');
const load = (relative) => projectRequire('./' + relative);
const { ensureVccFinancialOpTablesSupport } = load('src/backend/vcc-financial-op-db/migrations');
const { createArchiveService } = load('src/main-process/archive-center/archive-service');
const { createArchiveCenterController } = load('src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = load('src/main-process/archive-center/outbox-store');
const { createTaskLifecycle } = load('src/main-process/archive-center/task-lifecycle');
const { createTaskPolicyRegistry } = load('src/main-process/archive-center/task-policy-registry');
const { prepareIpcTaskInvocation, createIpcTaskContext } = load('src/main-process/archive-center/ipc-task-contract');
const { createVccFinancialOpService } = load('src/main-process/vcc-financial-op-service');
const { buildVccImportArchiveHandoffFiles, persistVccImportHandoffV2,
  reconcileVccImportArchiveLineage } = load('src/main-process/vcc-financial-op-archive-lineage');
const { SOURCE_TYPES: T, getSourceDefinition } = load('src/backend/vcc-financial-op/definitions');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-main-chain-'));
  const dbPath = path.join(dir, 'main.sqlite'); let db = new DatabaseSync(dbPath), archive, service;
  const result = {};
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY,setting_value TEXT,updated_at TEXT DEFAULT (datetime('now')))");
    ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
    archive = createArchiveService({ database: db, rootDir: path.join(dir, 'archive') });
    assert.equal((await archive.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const controller = createArchiveCenterController({ service: archive,
      outboxStore: createArchiveOutboxStore(path.join(dir, 'outbox')),
      database: { getSetting: () => null, setSetting() {} } });
    service = createVccFinancialOpService({ database: { db, dbPath }, assetsDir: path.join(root, 'assets'),
      archiveRepositoryProvider: () => archive.repository, archiveServiceProvider: () => archive });
    const book = XLSX.utils.book_new();
    const sheets = [
      ['充值', T.RECHARGE, { 订单号: '001', BillDate: '2026-06-09', 业务部门: 'VCC', 对手部门: 'OPS',
        业务子类型: '充值', 出入方向: 'in', 公司主体: '甲', 我方币种: 'USD', 我方到账金额: '10.25' }],
      ...['甲', '乙'].map((subject) => [subject, T.CHANNEL, { 渠道订单号: 'channel-' + subject,
        账单日期: '2026-06-10', 通道名称: 'CITI', 交易金额: '100', 交易币种: 'USD', 借贷方向: 'in' }])
    ];
    for (const [name, type, row] of sheets) {
      const headers = getSourceDefinition(type).headers;
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, headers.map((key) => row[key] ?? '')]), name);
    }
    const filePath = path.join(dir, '混合原件.xlsx'); XLSX.writeFile(book, filePath);
    const handlers = new Map(); let contract;
    const source = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
    const begin = source.indexOf('  const vccImportPlans = new Map();');
    const end = source.indexOf("  ipcMain.handle('vccFinancialOp:task:cancel'", begin);
    assert.ok(begin >= 0 && end > begin);
    const scope = {
      require: mainRequire,
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      trackedIpcHandle: (channel, _module, _title, value) => {
        assert.equal(channel, 'vccFinancialOp:import:apply'); contract = value;
      },
      showImportOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }),
      getVccFinancialOpService: () => service,
      prepareVccImportArchiveHandoff: buildVccImportArchiveHandoffFiles,
      persistVccImportHandoffV2,
      vccImportArchiveRecoveryOptions: () => ({ archiveRepository: archive.repository }),
      archiveCenterService: controller
    };
    Function(...Object.keys(scope), source.slice(begin, end))(...Object.values(scope));
    const sender = new EventEmitter(); sender.id = 1; sender.isDestroyed = () => false;
    const progress = []; sender.send = (channel, data) => progress.push({ channel, ...data });
    const event = { sender };
    const picked = await handlers.get('vccFinancialOp:import:pick-files')(event);
    assert.equal(picked.status, 'success', JSON.stringify(picked));
    assert.equal(picked.plan.sources.length, 3);
    const request = { targetMonth: '2026-06', planId: picked.plan.planId, excludedSheetIds: [],
      subjectBySourceId: Object.fromEntries(picked.plan.sources.filter((s) => s.requiresSubject).map((s) => [s.sourceId, s.sheetName])) };
    const prepared = await prepareIpcTaskInvocation(contract, event, [request]);
    assert.equal(prepared.proceed, true, JSON.stringify(prepared));
    const policy = createTaskPolicyRegistry().require('vccFinancialOp:import:apply');
    const lifecycle = createTaskLifecycle({ archiveService: archive,
      businessOperationRegistry: { begin: () => ({ accepted: true, token: 'probe' }), end() {} },
      flowResolver: { resolve: async () => ({ parentRunId: 'probe-parent', source: 'new', identity: null }),
        bind: async () => [], persistBindIntent: async () => ({ ok: true }) },
      operationTracker: { appendOperationFiles: async () => ({ ok: true }) },
      persistTerminalIntent: (intent) => controller.persistTaskTerminalIntent(intent) });
    let context;
    const imported = await lifecycle.runFileTask({ policy, meta: { channel: policy.channel },
      taskRunId: 'vcc-main-probe', operationKey: 'vcc-main-probe-operation',
      filePlanResolver: () => prepared.filePlan, beforeStart: prepared.beforeStart,
      execute: async (batchContext, controls) => {
        context = batchContext;
        return contract.execute(event, prepared, createIpcTaskContext(batchContext, controls), request);
      } });
    assert.equal(imported.status, 'success', JSON.stringify(imported));
    assert.equal(imported.physicalFileCount, 1); assert.equal(imported.businessSheetCount, 3);
    const artifacts = archive.repository.listArtifacts(context.batchId);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].status, 'ready');
    assert.ok(artifacts[0].metadata.aliasKey && artifacts[0].metadata.sourceSnapshot && artifacts[0].metadata.expectedSha256);
    assert.equal(artifacts[0].metadata.vccSourceMembers.length, 2);
    assert.equal(archive.repository.listArtifactHolds(artifacts[0].id).length, 2);
    assert.deepEqual(db.prepare('SELECT subject,sheet_name FROM vcc_fin_op_effective_rows WHERE source_type=? ORDER BY id').all(T.CHANNEL)
      .map((row) => [row.subject, row.sheet_name]), [['甲', '甲'], ['乙', '乙']]);
    const externalHash = fs.readFileSync(filePath).toString('base64');
    const blocked = await controller.prepareDeleteBatch(context.batchId);
    assert.equal(blocked.code, 'ARCHIVE_BATCH_BUSINESS_HELD');
    assert.equal(fs.readFileSync(filePath).toString('base64'), externalHash);
    result.mainChain = { status: imported.status, physicalFileCount: imported.physicalFileCount,
      businessSheetCount: imported.businessSheetCount, records: imported.records.map((r) => ({ sourceType: r.sourceType, insertedCount: r.insertedCount })),
      artifactCount: artifacts.length, holds: 2, deleteCode: blocked.code,
      phases: [...new Set(progress.map((p) => p.phase))] };
    await service.terminate(); service = null;
    await archive.pauseBackgroundMaterialization();
    db.close(); db = new DatabaseSync(dbPath); ensureVccFinancialOpTablesSupport(db);
    archive = createArchiveService({ database: db, rootDir: path.join(dir, 'archive') });
    assert.equal((await archive.initialize({ deferStartupRecovery: true, startBackgroundMaterialization: false })).ok, true);
    const recovered = reconcileVccImportArchiveLineage({ db, archiveRepository: archive.repository });
    assert.equal(recovered.failed, 0); assert.equal(recovered.bound, 2);
    db.prepare('DELETE FROM vcc_fin_op_effective_rows WHERE source_type=?').run(T.RECHARGE);
    const released = reconcileVccImportArchiveLineage({ db, archiveRepository: archive.repository });
    assert.equal(archive.repository.listArtifactHolds(artifacts[0].id).length, 1);
    result.reopen = { bound: recovered.bound, failed: recovered.failed, released: released.released,
      remainingHolds: 1, metadataMembers: archive.repository.getArtifact(artifacts[0].id).metadata.vccSourceMembers.length };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (service) await service.terminate();
    if (archive) await archive.pauseBackgroundMaterialization();
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
