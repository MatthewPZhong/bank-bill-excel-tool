'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createUpgradeHost, seedLegacy } = require('./biz-op-v327-upgrade');
const { writeXlsx, opRow } = require('./biz-op-v327-xlsx');
const { RELEASE_GATES } = require('../../src/main-process/biz-op-v327/release-gates');
const { registerBizOpV327Handlers } = require('../../src/main-process/biz-op-v327/ipc');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { createArchiveOutboxStore } = require('../../src/main-process/archive-center/outbox-store');
const { hash } = require('../../src/main-process/biz-op-v327/contracts');

function rewriteNewPublicationBinding(f, transform) {
  const register = f.module.publication.register.bind(f.module.publication);
  f.module.publication.register = (input) => {
    const value = transform(structuredClone(register(input)));
    const row = f.module.publication.record(input.context.taskRunId);
    // 在首次发布前构造历史/损坏 binding 夹具，同步其原始字节摘要；生产仍禁止改写文档。
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(f.module.payloadStore.resolve(row.binding_rel_path), bytes);
    f.db.prepare('UPDATE biz_op_v327_publications SET binding_digest=? WHERE task_run_id=?')
      .run(createHash('sha256').update(bytes).digest('hex'), input.context.taskRunId);
    return value;
  };
}

function publicationEvidence(f, taskRunId) {
  return { task: f.module.catalog.task(taskRunId), publication: f.module.publication.fact(taskRunId),
    originalHash: hash(fs.readFileSync(path.join(f.root, 'op-input.xlsx')).toString('base64')),
    outputHash: hash(fs.readFileSync(path.join(f.outputRoot, 'op-check.xlsx')).toString('base64')),
    businessHash: hash({ generation: f.module.catalog.control().generation,
      datasets: f.db.prepare('SELECT dataset_id,state,payload_manifest_digest FROM biz_op_v327_datasets ORDER BY dataset_id').all(),
      receipts: f.db.prepare('SELECT task_run_id,action,outcome_json FROM biz_op_v327_receipts ORDER BY task_run_id').all() }) };
}

function emulateLegacyClosedOwner(f, taskRunId) {
  // 修复前 syncCompletion 的两条真实关闭写入；保留原 publication/outbox，模拟既有落地状态。
  f.db.prepare("UPDATE biz_op_v327_prepared_ops SET phase='CLOSED' WHERE task_run_id=?").run(taskRunId);
  f.db.prepare("UPDATE biz_op_v327_settlement_progress SET state='COMPLETE' WHERE task_run_id=?").run(taskRunId);
}

async function createArchiveOwnerHost(t, options = {}) {
  const f = await createUpgradeHost(t, { ...options, archiveRuntimeDelegate: true,
    moduleOptions: { releaseGates: RELEASE_GATES } });
  f.outputRoot = options.outputRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-owner-output-'));
  t.after(() => { if (!options.keep) fs.rmSync(f.outputRoot, { recursive: true, force: true }); });
  f.outboxStore = createArchiveOutboxStore(path.join(f.root, 'run-data', 'archive-center', 'outbox'));
  f.center = createArchiveCenterController({ database: { getSetting: () => null, setSetting() {} },
    service: f.service, outboxStore: f.outboxStore,
    recoverInterruptedTaskOwners: [{ ownerName: 'biz-op-v327', recover: async () => {
      if (f.module.recovery.openObligations()) {
        const recovered = await f.module.recovery.run();
        if (!recovered.ready) throw Object.assign(new Error('BizOP 原 owner 恢复未完成'), { code: recovered.reason });
      }
    } }], getProtectedInterruptedTaskBatchIds: () => f.module.protectedTasks() });
  // Main 使用相同持久回调；原 BizOP 单模块夹具没有此连接，无法检测启动残留。
  f.lifecycle.persistTerminalIntent = (payload) => f.center.persistTaskTerminalIntent(payload);
  if (f.module.catalog.control().mode === 'DISABLED') {
    seedLegacy(f);
    await f.module.activation.run();
    assert.equal((await f.module.recovery.run()).ready, true);
  }
  if (options.expectReady !== false) f.module.assertBusinessEnabled();
  const handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} });
  const window = { webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  let exportScenario = null;
  const runtime = { ...f.runtime, start(request) {
    const control = f.runtime.start(request);
    if (request.actionKey === 'biz-op-v327:export-op-check' && exportScenario) {
      exportScenario.taskRunId = control.carrierIdentity.taskRunId;
      if (exportScenario.uncommitted) {
        // 真实确认后外部目标变化：生产 Publisher 必须拒绝覆盖这份外部文件。
        fs.writeFileSync(path.join(f.outputRoot, 'op-check.xlsx'), 'external replacement after confirmation');
      }
    }
    return control;
  } };
  const registerPublication = f.module.publication.register.bind(f.module.publication);
  f.module.publication.register = (input) => {
    if (exportScenario) exportScenario.taskRunId = input.context.taskRunId;
    return registerPublication(input);
  };
  registerBizOpV327Handlers({ ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    getModule: () => f.module, getTaskLifecycle: () => f.lifecycle, getRuntime: () => runtime,
    getWindow: () => window, businessOperationRegistry: f.lifecycle.businessOperationRegistry,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(f.outputRoot, 'op-check.xlsx') }) } });
  f.exportInput = async ({ uncommitted = false, failTerminalOnce = false, expectedError = null } = {}) => {
    const inputPath = path.join(f.root, 'op-input.xlsx');
    await writeXlsx(inputPath, { kind: 'OP', rowCount: 1, row: () => opRow() });
    const imported = await f.run([inputPath]);
    assert.equal(imported.status, 'ok', JSON.stringify(imported));
    const selected = await handlers.get('bizOpReconV327:export:pick')(event,
      { outputKind: 'OP_CHECK', objectId: imported.receipt.outcome.datasets[0].datasetId });
    assert.equal(selected.status, 'ok', JSON.stringify(selected));
    const persist = f.lifecycle.persistTerminalIntent;
    let failures = 0;
    exportScenario = { uncommitted };
    if (failTerminalOnce) {
      assert.equal(uncommitted || Boolean(expectedError), true);
      f.db.exec(`CREATE TEMP TRIGGER fail_export_terminal BEFORE UPDATE OF status ON archive_task_runs
        WHEN NEW.task_key='bizOpReconV327:export:op-check' AND NEW.status='failed'
        BEGIN SELECT RAISE(ABORT,'首次 failed 终态写入故障'); END`);
      f.lifecycle.persistTerminalIntent = async (payload) => {
        const result = await persist(payload);
        if (payload.owner.batchContext?.taskKey === 'bizOpReconV327:export:op-check') {
          assert.equal(payload.terminalOutcome.metadata._archiveAfterTerminalPending, uncommitted ? true : undefined);
          f.db.exec('DROP TRIGGER fail_export_terminal');
          failures += 1;
        }
        return result;
      };
    }
    try {
      const result = await handlers.get('bizOpReconV327:export:op-check')(event,
        { requestId: 'owner-export', selectionRef: selected.selectionRef });
      assert.equal(result.status, expectedError ? 'failed' : uncommitted ? 'error' : 'ok', JSON.stringify(result));
      if (uncommitted) assert.equal(result.code, 'TOOLBOX_PUBLICATION_TARGET_CHANGED_SINCE_CONFIRMATION');
      if (expectedError) assert.equal(result.code, expectedError);
      if (failTerminalOnce) assert.equal(failures, 1);
      return { ...result, taskRunId: exportScenario.taskRunId };
    } finally {
      f.lifecycle.persistTerminalIntent = persist;
      if (failTerminalOnce) f.db.exec('DROP TRIGGER IF EXISTS fail_export_terminal');
      exportScenario = null;
    }
  };
  f.owner = (taskRunId) => ({ version: 1, kind: 'file-batch',
    batchContext: f.module.publication.binding(taskRunId).batchContext });
  return f;
}

module.exports = { createArchiveOwnerHost, rewriteNewPublicationBinding, publicationEvidence, emulateLegacyClosedOwner };
